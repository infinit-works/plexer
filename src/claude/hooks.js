import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, isAbsolute } from 'node:path';
import { ask as runAsk } from '../ask/ask.js';
import { stemToken, tokenize } from '../ask/index-file.js';
import { formatBlastRadius, relevantRetrieval, formatOrientation } from './format.js';
import { loadAskIndexCached, loadGraphCached } from '../graph/load.js';
import {
    patchStats,
    readStats,
    acquireLock,
    readSession,
    writeSession,
    resolveContextDir,
    readStdin,
    projectDir,
} from '../util/state.js';
import { claudeScriptPath } from './paths.js';
import { nearestPlexerRoot } from '../graph/root.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';
import { federateAsk, readWorkspace } from '../graph/workspace.js';

/** Prompts shorter than this never trigger retrieval — they are almost always
 * conversational ("yes go ahead", "thanks") and the coverage gate can't judge
 * them reliably with so few terms. */
export const MIN_PROMPT_CHARS = 12;

export function underPlexer(dir, file) {
    const rel = file.startsWith(dir) ? file.slice(dir.length) : file;
    return rel.replace(/^[/\\]+/, '').replace(/\\/g, '/').startsWith('plexer/');
}

function emit(eventName, additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
}

export function editedFilePath(input, dir) {
    const direct = input?.tool_input?.file_path;
    if (typeof direct === 'string' && direct.trim())
        return direct;
    const cmd = input?.tool_input?.command;
    if (typeof cmd === 'string' && cmd) {
        const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(cmd);
        if (m)
            return isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
    }
    return null;
}

export function recordFileEdit(dir, file) {
    if (!file || underPlexer(dir, file))
        return null;
    const prev = readStats(dir);
    const nextStale = Math.max(1, (prev?.staleCount ?? 0) + 1);
    patchStats(dir, { dirty: true, staleCount: nextStale, lastFile: basename(file) });
    const w = loadGraphCached(resolveContextDir(dir));
    return w ? formatBlastRadius(w, file, 8, dir) : null;
}

export function readOrientation(dir, budgetBytes = 1200) {
    try {
        const idx = readFileSync(join(resolveContextDir(dir), 'INDEX.md'), 'utf8');
        return formatOrientation(idx, budgetBytes);
    }
    catch {
        return null;
    }
}

const PROMPT_BOILERPLATE_NOISE = new Set([
    'working', 'directory', 'concisely', 'exact', 'citations', 'line', 'lines',
    'investigate', 'answer', 'developer', 'notices', 'refactor', 'refactoring',
    'currently', 'implement', 'extend', 'support', 'preserve', 'existing',
    'verify', 'passes', 'pass', 'test', 'tests', 'suite', 'important', 'edit',
    'source', 'files', 'directly', 'inside', 'full', 'package', 'installations',
    'container', 'builds', 'stop', 'soon', 'applied', 'changes',
    'following', 'requirements', 'interface', 'contract', 'locations', 'codebase',
    'ensure', 'behavior', 'properly', 'without', 'when', 'what', 'where', 'which',
    'lx', 'ly', 'if', 'not', 'no', 'yes', 'true', 'false', 'nil', 'null', 'one',
    'two', 'three', 'both', 'each', 'all', 'any', 'some', 'other', 'another',
    'same', 'different', 'first', 'second', 'before', 'after', 'during', 'while',
    'until', 'under', 'over', 'across', 'through', 'also', 'still', 'only',
    'already', 'yet', 'more', 'less', 'most', 'least', 'very', 'such', 'than',
    'then', 'else', 'otherwise', 'instead', 'whether', 'because', 'since',
    'would', 'should', 'could', 'must', 'may', 'might', 'will', 'shall', 'have',
    'has', 'had', 'having', 'been', 'being', 'make', 'makes', 'made', 'take',
    'takes', 'give', 'gives', 'given', 'call', 'called', 'calling', 'return',
    'returns', 'returning', 'returned', 'function', 'functions', 'method',
    'methods', 'module', 'modules', 'file', 'type', 'types', 'value', 'values',
    'object', 'objects', 'table', 'tables', 'list', 'array', 'string', 'number',
    'boolean', 'result', 'results', 'data', 'info', 'item', 'items', 'entry',
    'entries', 'part', 'parts', 'step', 'steps', 'plan', 'system', 'code', 'state',
]);

function buildCorpusVocab(outDir) {
    const idx = loadAskIndexCached(outDir);
    const graph = loadGraphCached(outDir);
    if (!idx && !graph)
        return null;
    const dfMap = idx ? new Map(idx.df) : new Map();
    const stemDf = new Map();
    for (const [tok, c] of dfMap) {
        const s = stemToken(tok);
        stemDf.set(s, (stemDf.get(s) ?? 0) + c);
    }
    const nameTokens = new Set();
    const nameStems = new Map();
    const pathTokens = new Set();
    if (graph) {
        for (const n of graph.nodes) {
            for (const t of tokenize(n.path ?? '')) {
                if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t))
                    pathTokens.add(t);
            }
            if (n.kind === 'file')
                continue;
            const seenStems = new Set();
            for (const t of tokenize(n.name ?? '')) {
                if (t.length < 3 || PROMPT_BOILERPLATE_NOISE.has(t))
                    continue;
                nameTokens.add(t);
                const s = stemToken(t);
                if (!seenStems.has(s)) {
                    seenStems.add(s);
                    nameStems.set(s, (nameStems.get(s) ?? 0) + 1);
                }
            }
        }
    }
    const nDocs = idx?.docCount || graph?.nodes?.length || 100;
    return { dfMap, stemDf, nameTokens, nameStems, pathTokens, nDocs };
}

function distillSegment(vocab, text, maxWords = 10, maxCompounds = 4) {
    const cleaned = String(text ?? '')
        .replace(/^Working directory:.*$/gm, '')
        .replace(/^Run `.*$/gm, '')
        .replace(/to verify all.*$/gm, '')
        .replace(/Answer concisely.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '')
        .replace(/`(?:file:)?Lx-Ly`/gi, '')
        .trim();
    if (!vocab)
        return cleaned;
    const { dfMap, stemDf, nameTokens, nameStems, pathTokens, nDocs } = vocab;
    const backtickPhrases = [];
    const backticked = new Set();
    if (!PROMPT_BOILERPLATE_NOISE.has('plexer'))
        PROMPT_BOILERPLATE_NOISE.add('plexer');
    for (const m of cleaned.matchAll(/`([^`\n]{2,80})`/g)) {
        const inner = m[1].trim();
        if (/^(?:src|bin|test|pkg|internal|lib)\/[A-Za-z0-9_/-]*\/?$/i.test(inner))
            continue;
        const fnCall = inner.match(/^([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/);
        if (fnCall) {
            backtickPhrases.push(fnCall[1]);
            for (const t of tokenize(fnCall[1])) {
                if (!PROMPT_BOILERPLATE_NOISE.has(t))
                    backticked.add(t);
            }
            continue;
        }
        const cliCmd = inner.match(/^plexer\s+([a-z][a-z0-9_-]*)\b/i);
        if (cliCmd) {
            backtickPhrases.push(cliCmd[1]);
            for (const t of tokenize(cliCmd[1])) {
                if (!PROMPT_BOILERPLATE_NOISE.has(t))
                    backticked.add(t);
            }
            continue;
        }
        if (inner.includes(' ') && !/^[A-Za-z0-9_.:/-]+\s+[A-Za-z0-9_.:/-]+$/.test(inner))
            continue;
        backtickPhrases.push(inner);
        for (const t of tokenize(inner)) {
            if (!PROMPT_BOILERPLATE_NOISE.has(t))
                backticked.add(t);
        }
    }
    const camelOrCodePhrases = [];
    const camelOrCode = new Set();
    for (const m of cleaned.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*|[a-z0-9_]+(?:_[a-z0-9_]+)+|[A-Za-z0-9_/-]+\.(?:py|go|js|ts|luau|rs))\b/g)) {
        camelOrCodePhrases.push(m[1]);
        for (const t of tokenize(m[1])) {
            if (!PROMPT_BOILERPLATE_NOISE.has(t))
                camelOrCode.add(t);
        }
    }
    const rawToks = tokenize(cleaned);
    const allToks = [...new Set(rawToks)].filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t) && t.length >= 3);
    const scored = [];
    for (const t of allToks) {
        const s = stemToken(t);
        const df = dfMap.get(t) ?? stemDf.get(s) ?? 0;
        if (df === 0 && !backticked.has(t) && !camelOrCode.has(t))
            continue;
        const inSymExact = nameTokens.has(t);
        const inSymStem = nameStems.has(s);
        const inPath = pathTokens.has(t);
        const isBt = backticked.has(t);
        const isCode = camelOrCode.has(t);
        const symDf = nameStems.get(s) ?? df;
        const idf = (inSymExact || inSymStem)
            ? Math.log(1 + nDocs / Math.max(2, symDf))
            : Math.min(3.0, df > 0 ? Math.log(1 + nDocs / Math.max(3, df)) : 0.5);
        let fieldMult = 1.0;
        if (inSymExact && inPath)
            fieldMult = 5.2;
        else if (inSymExact)
            fieldMult = 4.0;
        else if (inSymStem && inPath)
            fieldMult = 4.2;
        else if (inSymStem)
            fieldMult = 3.2;
        else if (inPath)
            fieldMult = 2.2;
        const codeMult = isBt ? 3.0 : isCode ? 2.5 : 1.0;
        scored.push({ t, score: idf * fieldMult * codeMult });
    }
    if (scored.length === 0)
        return cleaned;
    scored.sort((a, b) => b.score - a.score);
    const topWords = scored.slice(0, maxWords).map((x) => x.t);
    const compounds = [...new Set([...backtickPhrases, ...camelOrCodePhrases])].slice(0, maxCompounds);
    return [...compounds, ...topWords].join(' ');
}

export function distillPromptQueries(root, contextDir, prompt) {
    const cleaned = String(prompt ?? '')
        .replace(/^Working directory:.*$/gm, '')
        .replace(/^Run `.*$/gm, '')
        .replace(/to verify all.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '')
        .trim();
    const rawToks = tokenize(cleaned);
    if (rawToks.length <= 16)
        return [cleaned || prompt];
    const outDir = contextDir ?? resolveContextDir(root);
    const vocab = buildCorpusVocab(outDir);
    if (!vocab)
        return [cleaned];
    const parts = cleaned.split(/\n(?=\s*\d+\.\s+)/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const leadWords = distillSegment(vocab, parts[0], 2, 1);
        const subItems = parts.slice(1, 4);
        return subItems.map((item) => {
            const sub = distillSegment(vocab, item, 7, 3);
            const subToks = new Set(sub.split(/\s+/).filter(Boolean));
            const leadExtra = leadWords
                .split(/\s+/)
                .filter((w) => w && !subToks.has(w))
                .join(' ');
            return leadExtra ? `${sub} ${leadExtra}`.trim() : sub;
        });
    }
    return [distillSegment(vocab, cleaned, 12, 5)];
}

export function distillPromptQuery(root, contextDir, prompt) {
    return distillPromptQueries(root, contextDir, prompt)[0];
}

export function queryPromptContext(dir, prompt) {
    const root = nearestPlexerRoot(dir)?.root ?? dir;
    const scopeHint = lastFileScopeHint(root, readStats(root)?.lastFile);
    const contextDir = process.env.PLEXER_DIR ? resolveContextDir(root) : undefined;
    try {
        const queries = distillPromptQueries(root, contextDir, prompt);
        if (readWorkspace(root, contextDir)) {
            return federateAsk(root, contextDir, queries[0], {
                limit: 3,
                source: true,
                in: scopeHint ?? undefined,
            });
        }
        if (queries.length === 1) {
            return runAsk(root, queries[0], {
                limit: 3,
                source: true,
                maxHitsToInline: 2,
                maxSourceBytes: 3400,
                contextDir,
                in: scopeHint ?? undefined,
            });
        }
        const seen = new Set();
        const results = [];
        for (const q of queries) {
            results.push(
                runAsk(root, q, {
                    limit: 3,
                    source: true,
                    maxHitsToInline: 1,
                    maxSourceBytes: 3800,
                    seenPointers: seen,
                    contextDir,
                    in: scopeHint ?? undefined,
                })
            );
        }
        const mergedSeen = new Set();
        const mergedHits = [];
        for (let rank = 0; rank < 3; rank++) {
            for (const r of results) {
                const h = r?.hits?.[rank];
                if (h && !mergedSeen.has(h.pointer)) {
                    mergedSeen.add(h.pointer);
                    mergedHits.push(h);
                }
            }
        }
        let inlinedBytes = 0;
        let inlinedCount = 0;
        for (let idx = 0; idx < mergedHits.length; idx++) {
            const h = mergedHits[idx];
            if (h.code) {
                if (idx === 0 && Buffer.byteLength(h.code, 'utf8') < 3800 && mergedHits.some((oh, oIdx) => oIdx > 0 && oh.code)) {
                    const nextCodeHit = mergedHits.find((oh, oIdx) => oIdx > 0 && oh.code);
                    if (nextCodeHit) {
                        const nextPrimaryLen = nextCodeHit.code.indexOf('\n\n// ') > 0
                            ? Buffer.byteLength(nextCodeHit.code.slice(0, nextCodeHit.code.indexOf('\n\n// ')), 'utf8')
                            : Buffer.byteLength(nextCodeHit.code, 'utf8');
                        const hHelperCount = h.code.split('\n\n// ').length - 1;
                        if (Buffer.byteLength(h.code, 'utf8') + nextPrimaryLen > 4400 || (hHelperCount >= 2 && Buffer.byteLength(h.code, 'utf8') + Buffer.byteLength(nextCodeHit.code, 'utf8') > 4400)) {
                            const firstHelperSplit = h.code.indexOf('\n\n// ');
                            if (firstHelperSplit > 0 && Buffer.byteLength(h.code, 'utf8') < 3200) {
                                h.code = h.code.slice(0, firstHelperSplit);
                            }
                        }
                    }
                }
                let b = Buffer.byteLength(h.code, 'utf8');
                if (inlinedCount >= 3 || (inlinedCount > 0 && inlinedBytes + b > 4400)) {
                    const helperSplit = h.code.indexOf('\n\n// ');
                    if (inlinedCount < 3 && helperSplit > 0) {
                        const trimmed = h.code.slice(0, helperSplit);
                        const tb = Buffer.byteLength(trimmed, 'utf8');
                        if (inlinedBytes + tb <= 4400) {
                            h.code = trimmed;
                            inlinedBytes += tb;
                            inlinedCount++;
                            continue;
                        }
                    }
                    delete h.code;
                }
                else {
                    inlinedBytes += b;
                    inlinedCount++;
                }
            }
        }
        return {
            query: queries.join(' ; '),
            mode: 'lexical',
            hits: mergedHits.slice(0, 4),
            coverage: Math.max(...results.map((r) => r?.coverage ?? 0)),
            coverageStrong: Math.max(...results.map((r) => r?.coverageStrong ?? 0)),
        };
    }
    catch {
        return null;
    }
}

function handlePostEdit(input, dir) {
    const br = recordFileEdit(dir, editedFilePath(input, dir));
    if (br)
        emit('PostToolUse', br);
}

export function lastFileScopeHint(dir, lastFile) {
    if (!lastFile)
        return null;
    try {
        const w = loadGraphCached(resolveContextDir(dir));
        if (!w)
            return null;
        const scopes = scopesOfGraph(w);
        if (scopes.length <= 1)
            return null;
        const matches = (w.nodes ?? []).filter((n) => n.kind === 'file' && (n.path === lastFile || n.path.endsWith(`/${lastFile}`)));
        if (matches.length === 0) {
            console.error(`[plexer] prompt hook: lastFile "${lastFile}" not found in the graph — skipping scope hint`);
            return null;
        }
        const prefixes = new Set(matches.map((n) => scopeOf(n.path, scopes).prefix));
        if (prefixes.size > 1) {
            console.error(`[plexer] prompt hook: lastFile "${lastFile}" matches more than one scope — skipping scope hint`);
            return null;
        }
        const [prefix] = prefixes;
        return prefix === '' ? null : prefix;
    }
    catch (e) {
        console.error(`[plexer] prompt hook: scope hint lookup failed (${e?.message ?? e}) — skipping`);
        return null;
    }
}

export function handleStop(_input, dir) {
    const syncRun = process.env.PLEXER_TEST_SYNC_RUN ?? claudeScriptPath('sync-run.js');
    if (!existsSync(syncRun))
        return;
    const stats = readStats(dir);
    if (stats?.dirty && acquireLock(dir)) {
        patchStats(dir, { syncing: true });
        const child = spawn(process.execPath, [syncRun, dir], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
    }
}

export async function main(event) {
    const input = readStdin();
    if (event === 'agy-pre-invocation' || event === 'agy-post-edit' || event === 'agy-stop') {
        const { handleAgyPreInvocation, handleAgyPostEdit, handleAgyStop } = await import('../hosts/antigravity-hooks.js');
        if (event === 'agy-pre-invocation')
            handleAgyPreInvocation(input);
        else if (event === 'agy-post-edit')
            handleAgyPostEdit(input);
        else
            handleAgyStop(input);
        return;
    }

    const rawDir = projectDir(input);
    const dir = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (process.env.PLEXER_DISABLE_HOOKS === '1' || !existsSync(resolveContextDir(dir))) {
        return;
    }
    if (event === 'session-start') {
        const orientation = readOrientation(dir);
        if (orientation)
            emit('SessionStart', orientation);
        return;
    }
    if (event === 'post-edit') {
        handlePostEdit(input, dir);
        return;
    }
    if (event === 'stop') {
        handleStop(input, dir);
        return;
    }
    if (event === 'post-edit-sync') {
        handlePostEdit(input, dir);
        handleStop(input, dir);
        return;
    }
    if (event === 'prompt') {
        const prompt = String(input?.prompt ?? '').trim();
        if (prompt.length < MIN_PROMPT_CHARS)
            return;
        const ask = queryPromptContext(dir, prompt);
        if (!ask)
            return;
        const id = input.session_id || 'default';
        const s = readSession(dir, id);
        s.lastQuery = prompt;
        const agent = input?.agent?.name;
        if (agent)
            s.perAgentQuery[agent] = prompt;
        const txt = relevantRetrieval(ask, s);
        if (txt)
            emit('UserPromptSubmit', txt);
        writeSession(dir, id, s);
    }
}