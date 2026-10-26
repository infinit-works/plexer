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
import { ensureFreshGraph } from '../graph/refresh.js';
import { isAutoBuildableRepo, nearestPlexerRoot } from '../graph/root.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';
import { federateAsk, readWorkspace } from '../graph/workspace.js';
import { pinnedHits, pointerCovers, pointersOverlap } from './pin.js';

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
    'directory', 'concisely', 'exact', 'citations', 'line', 'lines',
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
    'check', 'checks', 'checking', 'checked', 'evaluate', 'evaluates', 'detect', 'detects',
    'expose', 'exposes', 'them', 'their', 'they', 'defined', 'define', 'defines',
    'invoke', 'invokes', 'invoked',
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
    const compoundSymbols = new Map();
    if (graph) {
        for (const n of graph.nodes) {
            if (n.path) {
                const base = basename(n.path).replace(/\.[a-z0-9]+$/i, '');
                if (base.length >= 6)
                    compoundSymbols.set(base.toLowerCase(), base);
            }
            for (const t of tokenize(n.path ?? '')) {
                if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t))
                    pathTokens.add(t);
            }
            if (n.kind === 'file')
                continue;
            if (n.name) {
                const bare = n.name.split(/[.:#]/).pop() ?? '';
                const bareToks = tokenize(bare);
                if (bare.length >= 6 && (!bare.includes('_') || bareToks.length >= 3 || bareToks.some((t) => t.length >= 7))) {
                    compoundSymbols.set(bare.toLowerCase(), bare);
                    const flat = bare.replace(/^_+/, '').replaceAll('_', '').toLowerCase();
                    if (flat.length >= 6 && !compoundSymbols.has(flat))
                        compoundSymbols.set(flat, bare);
                    const strippedPrefix = bare.replace(/^(?:_?(?:on|handle|is)_|(?:on|handle|is|get)(?=[A-Z]))/, '');
                    const flatStripped = strippedPrefix.replaceAll('_', '').toLowerCase();
                    if (flatStripped.length >= 6 && !compoundSymbols.has(flatStripped))
                        compoundSymbols.set(flatStripped, bare);
                }
                if (
                    n.owner &&
                    !bare.includes('_') &&
                    !/[A-Z]/.test(bare.slice(1)) &&
                    n.owner !== 'Command' &&
                    !/^(?:module|exports|window|global|self|this)$/i.test(n.owner) &&
                    !n.owner.startsWith('Socket')
                ) {
                    const qualKey = `${stemToken(n.owner.toLowerCase())}${stemToken(bare.toLowerCase())}`;
                    if (qualKey.length >= 8 && !compoundSymbols.has(qualKey))
                        compoundSymbols.set(qualKey, `${n.owner}.${bare}`);
                }
            }
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
    return { dfMap, stemDf, nameTokens, nameStems, pathTokens, compoundSymbols, nDocs };
}

function cleanPromptBoilerplate(raw) {
    return String(raw ?? '')
        .replace(/^Working directory:.*$/gm, '')
        .replace(/^A code repository is available in.*$/gm, '')
        .replace(/^Your task is to implement the changes.*$/gm, '')
        .replace(/^<\/?pr_description>\s*$/gim, '')
        .replace(/\nConstraints:\s*\n[\s\S]*$/im, '')
        .replace(/^Run `.*$/gm, '')
        .replace(/to verify all.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '')
        .replace(/`(?:file:)?Lx-Ly`/gi, '')
        .replace(/\blow-level\b/gi, '')
        .replace(/\b0[\s-]byte\b/gi, 'zero_size')
        .replace(/\/tmp\/[A-Za-z0-9._-]+\/(?:(?:clean|indexed)\/)?[A-Za-z0-9._-]+\/(?=[A-Za-z0-9_])/g, '')
        .replace(/`\/(?:tmp|app|workspace|home)\/[A-Za-z0-9._/-]*`/g, '')
        .replace(/\/app\/(?=[A-Za-z0-9_])/g, '')
        .trim();
}

export function detectPromptIntent(prompt) {
    const raw = String(prompt ?? '');
    const wantsCallSites = /\b(callers?|who\s+calls|direct\s+callers|second-hop\s+callers?|blast\s+radius|who\s+uses|used\s+by|where\s+is\b[\s\S]{0,40}\b(?:called|used|invoked)|which\s+(?:functions|modules|cli\s+commands|handlers)\b[\s\S]{0,60}\b(?:call|invoke))\b/i.test(raw);
    const editEnvelope = /\b(implement|add|extend|replace|update|rewrite|centralize|expose|forward|support)\b/i.test(raw) &&
        !/\bAnswer concisely with exact\b/i.test(raw);
    return { wantsCallSites, editEnvelope };
}

function distillSegment(vocab, text, maxWords = 10, maxCompounds = 4) {
    const cleaned = cleanPromptBoilerplate(text);
    if (!vocab)
        return cleaned;
    const { dfMap, stemDf, nameTokens, nameStems, pathTokens, compoundSymbols, nDocs } = vocab;
    const backtickPhrases = [];
    const backticked = new Set();
    if (!PROMPT_BOILERPLATE_NOISE.has('plexer'))
        PROMPT_BOILERPLATE_NOISE.add('plexer');
    for (const m of cleaned.matchAll(/`([^`\n]{2,80})`/g)) {
        const inner = m[1].trim().replace(/^\/app\//, '');
        if (/^(?:\/tmp\/|\/home\/|\/var\/)/i.test(inner))
            continue;
        if (inner.includes('@') && !inner.startsWith('@'))
            continue;
        if (/^(?:src|bin|test|pkg|internal|lib)\/?$/i.test(inner))
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
    for (const m of cleaned.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*|[a-z0-9_]+(?:_[a-z0-9_]+)+|[A-Za-z0-9_/-]+\.(?:py|go|js|ts|tsx|jsx|luau|rs))\b/g)) {
        if (cleaned[(m.index ?? 0) + m[0].length] === '@')
            continue;
        const phrase = m[1].replace(/^\/app\//, '');
        if (/^(?:tmp|plexer_swebench|plexer_ab|pr_description)\b/i.test(phrase))
            continue;
        camelOrCodePhrases.push(phrase);
        for (const t of tokenize(phrase)) {
            if (!PROMPT_BOILERPLATE_NOISE.has(t))
                camelOrCode.add(t);
        }
    }
    if (compoundSymbols && compoundSymbols.size > 0) {
        const wordsSeq = [...cleaned.matchAll(/\b([A-Za-z]{3,})\b/g)].map((m) => m[1].toLowerCase());
        for (let i = 0; i < wordsSeq.length - 1; i++) {
            const w1 = wordsSeq[i];
            const w2 = wordsSeq[i + 1];
            const w3 = i + 2 < wordsSeq.length ? wordsSeq[i + 2] : '';
            if (PROMPT_BOILERPLATE_NOISE.has(w1))
                continue;
            const tri = w3 && !PROMPT_BOILERPLATE_NOISE.has(w3) ? `${w1}${w2}${w3}` : '';
            if (tri && compoundSymbols.has(tri)) {
                const sym = compoundSymbols.get(tri);
                camelOrCodePhrases.push(sym);
                camelOrCode.add(w1);
                camelOrCode.add(w2);
                camelOrCode.add(w3);
                i += 2;
                continue;
            }
            if (PROMPT_BOILERPLATE_NOISE.has(w2))
                continue;
            const bi = `${w1}${w2}`;
            const fwdStem = `${stemToken(w1)}${stemToken(w2)}`;
            const revStem = `${stemToken(w2)}${stemToken(w1)}`;
            const fwdSym = fwdStem.length >= 8 ? compoundSymbols.get(fwdStem) : undefined;
            if (
                (bi.length >= 8 && compoundSymbols.has(bi)) ||
                fwdSym?.includes('.') ||
                (revStem.length >= 7 && compoundSymbols.has(revStem))
            ) {
                const sym = compoundSymbols.get(bi) ?? (fwdSym?.includes('.') ? fwdSym : undefined) ?? compoundSymbols.get(revStem);
                camelOrCodePhrases.push(sym);
                camelOrCode.add(w1);
                camelOrCode.add(w2);
                continue;
            }
            const verbRoots = w2.endsWith('ing') && w2.length > 5
                ? [w2.slice(0, -3), `${w2.slice(0, -3)}e`]
                : /(?:ate|ite|ete|ove|ore|ule|ile|ise|ize)s$/.test(w2)
                    ? [w2.slice(0, -1)]
                    : [];
            for (const v of verbRoots) {
                const rev = `${v}${w1}`;
                if (rev.length >= 8 && compoundSymbols.has(rev)) {
                    camelOrCodePhrases.push(compoundSymbols.get(rev));
                    camelOrCode.add(w1);
                    camelOrCode.add(w2);
                    break;
                }
            }
        }
    }
    const rawCompounds = [...new Set([...backtickPhrases, ...camelOrCodePhrases])];
    const scoredCompounds = rawCompounds.map((c) => {
        const subToks = tokenize(c).filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t));
        const isFile = /\.(?:py|go|js|ts|tsx|jsx|luau|rs)$/i.test(c);
        let cScore = isFile ? 18 : 0;
        for (const st of subToks) {
            const s = stemToken(st);
            const df = dfMap.get(st) ?? stemDf.get(s) ?? 0;
            const idf = df > 0 ? Math.log(1 + nDocs / Math.max(2, df)) : 1.0;
            const inSym = nameTokens.has(st) || nameStems.has(s);
            const inPath = pathTokens.has(st);
            cScore += idf * (inSym && inPath ? 3.5 : inSym ? 2.8 : inPath ? 2.2 : 0.8);
        }
        return { c, score: cScore };
    });
    scoredCompounds.sort((a, b) => b.score - a.score);
    const compounds = [];
    for (const x of scoredCompounds) {
        if (compounds.length >= maxCompounds)
            break;
        if (compounds.some((prev) => prev.endsWith(`.${x.c}`)))
            continue;
        compounds.push(x.c);
    }
    const exactSingleCompounds = new Set(compounds.map((c) => c.toLowerCase()));
    for (const c of compounds) {
        const dotParts = c.toLowerCase().split('.');
        if (dotParts.length >= 3) {
            for (const dp of dotParts)
                exactSingleCompounds.add(dp);
        }
    }
    const rawToks = tokenize(cleaned);
    const allToks = [...new Set(rawToks)].filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t) && t.length >= 3);
    const scored = [];
    for (const t of allToks) {
        if (exactSingleCompounds.has(t))
            continue;
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
    if (scored.length === 0 && compounds.length === 0)
        return cleaned;
    scored.sort((a, b) => b.score - a.score);
    const topWords = scored.slice(0, maxWords).map((x) => x.t);
    return [...compounds, ...topWords].join(' ');
}

export function distillPromptQueries(root, contextDir, prompt) {
    const cleaned = cleanPromptBoilerplate(prompt);
    const rawToks = tokenize(cleaned);
    if (rawToks.length <= 16)
        return [cleaned || prompt];
    const outDir = contextDir ?? resolveContextDir(root);
    const vocab = buildCorpusVocab(outDir);
    if (!vocab)
        return [cleaned];
    // Structured PR / issue descriptions with ## Requirements or ## New Interfaces
    if (/(?:^|\n)##+\s+(?:Requirements|New Interfaces|Problem|Description)\b/i.test(cleaned)) {
        const strippedRepro = cleaned.replace(
            /(?:^|\n)(?:##+\s*|\*\*)Steps\s+to\s+Reproduce([\s\S]*?)(?=\n(?:##+\s+|\*\*[A-Z]))/i,
            (_m, body) => {
                const bt = [...String(body).matchAll(/`([^`\n]{3,60})`/g)].map((x) => `\`${x[1]}\``).join(' ');
                return bt ? `\n${bt}\n` : '\n';
            },
        );
        const reproBt = [...cleaned.matchAll(/`([A-Za-z_][A-Za-z0-9_]{4,})`/g)]
            .map((x) => x[1])
            .filter((s) => /[a-z][A-Z]|_/.test(s))
            .map((s) => `\`${s}\``)
            .slice(0, 6)
            .join(' ');
        const reqMatch = /(?:^|\n)##+\s+Requirements\b([\s\S]*?)(?=\n##+\s+|$)/i.exec(strippedRepro);
        const ifaceMatch = /(?:^|\n)##+\s+New Interfaces\b([\s\S]*?)(?=\n##+\s+|$)/i.exec(strippedRepro);
        const headSection = strippedRepro.split(/\n##+\s+Requirements\b/i)[0] ?? strippedRepro;
        const reqText = reqMatch ? reqMatch[1].trim() : '';
        const ifaceText = ifaceMatch && !/no new interfaces/i.test(ifaceMatch[1]) ? ifaceMatch[1].trim() : '';
        const ifaceTypeNames = new Set([
            ...[...ifaceText.matchAll(/\b(?:New\s+(?:error\s+)?(?:class|type|interface|struct)\s+)([A-Za-z_][A-Za-z0-9_]*)/gi)]
                .map((m) => m[1]),
            ...[...ifaceText.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`\s+added\s+to\s+`([A-Za-z_][A-Za-z0-9_]*)`/gi)]
                .flatMap((m) => [m[1], m[2]]),
            ...[...ifaceText.matchAll(/(?:^|\n)\s*[-*]\s*Name:\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/gi)]
                .map((m) => m[1]),
        ]);
        const queries = [];
        if (reqText) {
            const bullets = reqText.split(/\n(?=\s*[-*]\s+)/).map((b) => b.trim()).filter(Boolean);
            const fileMentions = [...strippedRepro.matchAll(/\b([A-Za-z0-9_/-]+\.(?:py|go|js|ts|tsx|jsx|luau|rs))\b/g)]
                .map((m) => m[1].replace(/^\/app\//, ''));
            const uniqueFiles = [...new Set(fileMentions)];
            if (uniqueFiles.length >= 2) {
                const graph = loadGraphCached(outDir);
                const targetFiles = uniqueFiles.slice(0, 4).map((f) =>
                    f.replace(/^\/tmp\/[A-Za-z0-9._-]+\/(?:(?:clean|indexed)\/)?[A-Za-z0-9._-]+\//, '')
                );
                let clauseSource = cleaned.replace(/\n##+\s+New Interfaces[\s\S]*$/i, '');
                for (const tn of ifaceTypeNames)
                    clauseSource = clauseSource.replaceAll(tn, '');
                const clauses = clauseSource
                    .split(/\n+/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 15 && !s.startsWith('#') && !s.startsWith('<') && s.length < 220);
                const pairs = [];
                for (const fRel of targetFiles) {
                    const base = basename(fRel);
                    const stem = base.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
                    const symToks = new Set();
                    for (const n of graph?.nodes ?? []) {
                        if (!n.path || n.kind === 'file')
                            continue;
                        if (n.path === fRel || n.path.endsWith(`/${base}`)) {
                            for (const t of tokenize(n.name ?? '')) {
                                if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t)) {
                                    symToks.add(t);
                                    symToks.add(stemToken(t));
                                }
                            }
                        }
                    }
                    for (let idx = 0; idx < clauses.length; idx++) {
                        const c = clauses[idx];
                        if (targetFiles.some((of) => of !== fRel && c.includes(basename(of))))
                            continue;
                        let score = c.includes(base) ? 16 : 0;
                        const cToks = [...new Set(tokenize(c))].filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t));
                        for (let i = 0; i < cToks.length - 1; i++) {
                            if (`${cToks[i]}${cToks[i + 1]}` === stem)
                                score += 12;
                        }
                        for (const t of cToks) {
                            if (t.length < 3)
                                continue;
                            const st = stemToken(t);
                            if (symToks.has(t) || symToks.has(st))
                                score += 3;
                            else if (t.length >= 4 && [...symToks].some((s) => s.length >= 6 && (s.startsWith(t) || s.endsWith(t))))
                                score += 2;
                        }
                        if (score > 0)
                            pairs.push({ fRel, idx, c, score });
                    }
                }
                pairs.sort((a, b) => b.score - a.score);
                const assigned = new Map();
                const usedIdx = new Set();
                for (const p of pairs) {
                    if (assigned.has(p.fRel) || usedIdx.has(p.idx))
                        continue;
                    assigned.set(p.fRel, p.c);
                    usedIdx.add(p.idx);
                }
                for (const fRel of targetFiles) {
                    const matchedClause = assigned.get(fRel) ?? '';
                    const sourceText = `\`${fRel}\` ${matchedClause}`;
                    const sub = distillSegment(vocab, sourceText, 5, 2);
                    if (sub && !queries.includes(sub))
                        queries.push(sub);
                }
                return queries.slice(0, 4);
            }
            if (bullets.length >= 3) {
                const stripNewTypes = (text) => {
                    let out = text;
                    for (const tn of ifaceTypeNames) {
                        const esc = tn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        out = out.replace(new RegExp(`[A-Za-z0-9_.]*${esc}\\b`, 'g'), '');
                    }
                    return out;
                };
                const usedCompounds = new Set();
                const stripUsedCompounds = (text) => {
                    let out = stripNewTypes(text).replace(/`([^`\n]+)`/g, (m, inner) => {
                        const base = inner.replace(/\(\)$/, '');
                        for (const c of usedCompounds) {
                            if (base === c || base.startsWith(`${c}.`) || c.startsWith(`${base}.`))
                                return '';
                        }
                        return m;
                    });
                    for (const c of usedCompounds) {
                        const toks = tokenize(c).filter((t) => !/^(?:get|set|is|on|handle)$/.test(t));
                        if (toks.length === 2) {
                            out = out
                                .replace(new RegExp(`\\b${toks[0]}\\w*\\s+${toks[1]}\\w*\\b`, 'gi'), '')
                                .replace(new RegExp(`\\b${toks[1]}\\w*\\s+${toks[0]}\\w*\\b`, 'gi'), '');
                        }
                    }
                    return out;
                };
                const recordCompounds = (qStr) => {
                    for (const w of (qStr || '').split(/\s+/).slice(0, 3)) {
                        if (w)
                            usedCompounds.add(w.replace(/\(\)$/, ''));
                    }
                };
                if (ifaceTypeNames.size >= 2 && bullets.length >= 5 && uniqueFiles.length === 1) {
                    const ifaceFile = uniqueFiles[0].replace(/^\/tmp\/[A-Za-z0-9._-]+\/(?:(?:clean|indexed)\/)?[A-Za-z0-9._-]+\//, '');
                    const ifaceStem = basename(ifaceFile).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
                    const ifaceBullets = bullets.filter((b) => [...ifaceTypeNames].some((tn) => b.includes(tn)));
                    const otherBullets = bullets.filter((b) => ![...ifaceTypeNames].some((tn) => b.includes(tn)));
                    if (ifaceBullets.length >= 2 && otherBullets.length >= 2) {
                        const g1 = distillSegment(vocab, stripNewTypes(`${ifaceText}\n${ifaceBullets.join('\n')}`), 8, 4);
                        if (g1) {
                            queries.push(g1);
                            recordCompounds(g1);
                        }
                        for (const ob of otherBullets) {
                            let cleanedOb = ob;
                            const andIdx = ob.search(/\band\s+[a-z]+-[a-z]+/i);
                            if (andIdx > 0 && ob.slice(0, andIdx).toLowerCase().includes(ifaceStem)) {
                                cleanedOb = ob
                                    .slice(andIdx + 4)
                                    .replace(new RegExp(`\\b${ifaceStem}\\s+validation\\b`, 'gi'), '')
                                    .replace(/\bvalidation\s+helpers\b/gi, '')
                                    .replace(/\bvalidation\b/gi, '');
                            }
                            const sub = distillSegment(vocab, stripUsedCompounds(cleanedOb), 7, 3);
                            const lead = (sub || '').split(/\s+/)[0] ?? '';
                            if (sub && (/[a-z][A-Z]|\./.test(lead) || cleanedOb !== ob) && !queries.includes(sub)) {
                                queries.push(sub);
                                recordCompounds(sub);
                            }
                        }
                        const headSub = distillSegment(
                            vocab,
                            stripUsedCompounds(headSection.replace(new RegExp(`\\b${ifaceStem}\\b`, 'gi'), '')),
                            5,
                            2
                        );
                        const headLead = (headSub || '').split(/\s+/)[0] ?? '';
                        if (headSub && /[a-z][A-Z]/.test(headLead) && !usedCompounds.has(headLead) && !queries.includes(headSub)) {
                            queries.push(headSub);
                        }
                        return queries.slice(0, 4);
                    }
                }
                const third = Math.ceil(bullets.length / 3);
                const twoThirds = Math.ceil((bullets.length * 2) / 3);
                const g1 = distillSegment(vocab, stripNewTypes(`${headSection.slice(0, 350)}\n${ifaceText}\n${bullets.slice(0, third).join('\n')}`), 8, 4);
                recordCompounds(g1);
                const g2 = distillSegment(vocab, stripUsedCompounds(bullets.slice(third, twoThirds).join('\n')), 8, 4);
                recordCompounds(g2);
                const g3 = distillSegment(vocab, stripUsedCompounds(bullets.slice(twoThirds).join('\n')), 8, 4);
                for (const g of [g1, g2, g3]) {
                    if (g && !queries.includes(g))
                        queries.push(g);
                }
                return queries.slice(0, 3);
            }
            if (bullets.length === 2) {
                let b1Text = bullets[0];
                let b2Text = bullets[1];
                for (const tn of ifaceTypeNames) {
                    b1Text = b1Text.replaceAll(tn, '');
                    b2Text = b2Text.replaceAll(tn, '');
                }
                const g1 = distillSegment(vocab, `${ifaceText}\n${b1Text}`, 8, 4);
                const g2 = distillSegment(vocab, b2Text, 8, 4);
                for (const g of [g1, g2]) {
                    if (g && !queries.includes(g))
                        queries.push(g);
                }
                for (const bText of [b1Text, b2Text]) {
                    const sub = distillSegment(vocab, bText.replace(/`[^`\n]+`/g, ''), 6, 2);
                    const lead = (sub || '').split(/\s+/)[0];
                    if (lead && lead.length >= 12 && /[a-z][A-Z]/.test(lead) && !queries.some((q) => q.startsWith(lead))) {
                        queries.push(sub);
                        break;
                    }
                }
                return queries.slice(0, 3);
            }
        }
        const q1 = distillSegment(vocab, `${headSection}\n${ifaceText}\n${reqText}`, 10, 5);
        if (q1)
            queries.push(q1);
        return queries.slice(0, 3);
    }
    const parts = cleaned.split(/\n(?=\s*\d+\.\s+)/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const hasNumberedHeader = /^\d+\.\s/.test(parts[0]);
        const leadWords = hasNumberedHeader ? '' : distillSegment(vocab, parts[0], 2, 1);
        const subItems = (hasNumberedHeader ? parts : parts.slice(1)).slice(0, 3);
        return subItems.map((item, idx) => {
            const sub = distillSegment(vocab, item, 7, 3);
            if (!leadWords || (idx > 0 && /`[A-Za-z0-9_]+\/[A-Za-z0-9_/-]*`/.test(item)))
                return sub;
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

/**
 * Turn-0 inline budgets (bytes of `L<n>:` source). Q&A prompts get room for whole
 * function bodies: one avoided follow-up turn re-bills the entire context (~12-16k
 * cumulative input tokens and ~4s on Opus, per `bench/cost-model.js`), which outweighs
 * a few hundred extra Turn-0 tokens. Edit prompts stay tighter — the agent re-reads edit
 * targets before patching anyway. Values were chosen with `bench/eval-fast.js --set …`
 * sweeps (NeedCov / EstWall / EstCum, holdout tasks checked); mutable for that reason.
 */
export const HOOK_BUDGETS = {
    qaSingleHitBytes: 3600,
    qaMultiHitBytes: 3800,
    qaMergedBytes: 9000,
    qaMaxInlined: 5,
    editSingleHitBytes: 1450,
    editMultiHitBytes: 1150,
    editMergedBytes: 3800,
    editMaxInlined: 3,
    singleQueryInline: 3,
    multiQueryInline: 1,
    pinBytes: 5350,
    pinMax: 3,
    editTotalBytes: 5500,
};
/**
 * Turn-0 retrieval for a prompt: definitions the prompt names as code are pinned first
 * (see `pin.js`), then ranked retrieval fills in the rest, minus anything a pin covers.
 */
export function queryPromptContext(dir, prompt) {
    const res = searchPromptContext(dir, prompt);
    const isEdit = res?.isEditPrompt ?? detectPromptIntent(prompt).editEnvelope;
    let pins = [];
    let rawPins = [];
    try {
        const root = nearestPlexerRoot(dir)?.root ?? dir;
        const graph = loadGraphCached(resolveContextDir(root));
        const rankedHits = res?.hits ?? [];
        const hintFiles = res?.allFiles ?? [...new Set(rankedHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean))];
        rawPins = (isEdit && HOOK_BUDGETS.pinMax > 0) ? pinnedHits(root, graph, prompt, {
            budgetBytes: HOOK_BUDGETS.pinBytes,
            maxPins: HOOK_BUDGETS.pinMax,
            hintFiles,
        }) : [];
        for (const p of rawPins) {
            const pFile = (p.pointer ?? '').split(':')[0];
            // Skip if an already-inlined ranked hit literally contains this pin's full contiguous body.
            if (p.a && p.b && !p.code?.includes('// delegator in ') && rankedHits.some((h) => h.code && !h.code.includes('omitted)') && !h.code.includes('excerpt of') && (h.pointer ?? '').split(':')[0] === pFile && h.code.includes(`L${p.a}:`) && h.code.includes(`L${p.b}:`)))
                continue;
            // Inherit structural enrichments (`related`, `callSites`, `otherSymbols`) from any overlapping ranked hit.
            for (const h of rankedHits) {
                if (!pointersOverlap(p.pointer, h.pointer))
                    continue;
                if (h.related && !p.related)
                    p.related = h.related;
                if (h.callSites && !p.callSites) {
                    p.callSites = h.callSites;
                    p.wantsCallSites = h.wantsCallSites;
                }
                if (h.otherSymbols && !p.otherSymbols)
                    p.otherSymbols = h.otherSymbols;
            }
            pins.push(p);
        }
    }
    catch {
        pins = [];
    }
    if (!pins.length)
        return res;
    const rest = (res?.hits ?? []).filter((h) => !pins.some((p) => pointerCovers(p.pointer, h.pointer)));
    for (const h of rest) {
        if (h.code && pins.filter((p) => pointerCovers(h.pointer, p.pointer)).reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0) >= 1200) {
            delete h.code;
        }
    }
    let totalCodeBytes = pins.reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0);
    const maxTotalBytes = HOOK_BUDGETS.editTotalBytes ?? 4600;
    const matchingPin = (h) => h.code ? rawPins.find((p) => p.a && p.b && (h.pointer ?? '').split(':')[0] === (p.pointer ?? '').split(':')[0] && h.code.includes(`L${p.a}:`) && h.code.includes(`L${p.b}:`)) : null;
    for (const pass of [true, false]) {
        for (const h of rest) {
            const mp = matchingPin(h);
            if (!h.code || Boolean(mp) !== pass)
                continue;
            const hb = Buffer.byteLength(h.code, 'utf8');
            if (totalCodeBytes + hb > maxTotalBytes) {
                if (mp?.code) {
                    const mb = Buffer.byteLength(mp.code, 'utf8');
                    if (totalCodeBytes + mb <= maxTotalBytes) {
                        h.code = mp.code;
                        totalCodeBytes += mb;
                        continue;
                    }
                }
                if (h.code.includes('\n\n// ')) {
                    const primary = h.code.slice(0, h.code.indexOf('\n\n// '));
                    const pb = Buffer.byteLength(primary, 'utf8');
                    if (totalCodeBytes + pb <= maxTotalBytes) {
                        h.code = primary;
                        totalCodeBytes += pb;
                        continue;
                    }
                }
                delete h.code;
                continue;
            }
            totalCodeBytes += hb;
        }
    }
    const keptRest = (pins.length >= 3 && !rest.some((h) => h.code)) ? [] : rest;
    return {
        ...(res ?? { query: prompt, mode: 'lexical', isEditPrompt: isEdit }),
        hits: [...pins, ...keptRest],
    };
}
function searchPromptContext(dir, prompt) {
    const root = nearestPlexerRoot(dir)?.root ?? dir;
    const scopeHint = lastFileScopeHint(root, readStats(root)?.lastFile);
    const contextDir = process.env.PLEXER_DIR ? resolveContextDir(root) : undefined;
    try {
        const intent = detectPromptIntent(prompt);
        const queries = distillPromptQueries(root, contextDir, prompt);
        if (readWorkspace(root, contextDir)) {
            return federateAsk(root, contextDir, queries[0], {
                limit: 3,
                source: true,
                in: scopeHint ?? undefined,
            });
        }
        if (queries.length === 1) {
            const singleRes = runAsk(root, queries[0], {
                limit: 3,
                source: true,
                maxHitsToInline: HOOK_BUDGETS.singleQueryInline,
                maxSourceBytes: intent.editEnvelope ? HOOK_BUDGETS.editSingleHitBytes : HOOK_BUDGETS.qaSingleHitBytes,
                wantsCallSites: intent.wantsCallSites,
                editEnvelope: intent.editEnvelope,
                includeRankingMetadata: false,
                contextDir,
                in: scopeHint ?? undefined,
            });
            if (singleRes)
                singleRes.isEditPrompt = intent.editEnvelope;
            return singleRes;
        }
        const seen = new Set();
        const results = [];
        for (let qIdx = 0; qIdx < queries.length; qIdx++) {
            const q = queries[qIdx];
            results.push(
                runAsk(root, q, {
                    limit: 3,
                    source: true,
                    maxHitsToInline: (qIdx === 0 && !intent.editEnvelope && intent.wantsCallSites) ? 2 : HOOK_BUDGETS.multiQueryInline,
                    maxSourceBytes: intent.editEnvelope
                        ? HOOK_BUDGETS.editMultiHitBytes
                        : (qIdx > 0 && intent.wantsCallSites ? 2800 : HOOK_BUDGETS.qaMultiHitBytes),
                    wantsCallSites: intent.wantsCallSites,
                    editEnvelope: intent.editEnvelope,
                    includeRankingMetadata: false,
                    seenPointers: seen,
                    contextDir,
                    in: scopeHint ?? undefined,
                })
            );
        }
        const mergedSeen = new Set();
        const mergedSymbolTitles = new Set();
        const mergedFileCounts = new Map();
        const mergedHits = [];
        const pushMergedHit = (h, rank, maxPerFile = 2) => {
            if (!h || mergedSeen.has(h.pointer))
                return false;
            if (rank > 0 && h.title && mergedSymbolTitles.has(h.title))
                return false;
            const fileKey = (h.pointer || '').split(':')[0];
            if (intent.editEnvelope && fileKey && (mergedFileCounts.get(fileKey) ?? 0) >= maxPerFile && mergedHits.length < 4)
                return false;
            mergedSeen.add(h.pointer);
            if (h.title)
                mergedSymbolTitles.add(h.title);
            if (fileKey)
                mergedFileCounts.set(fileKey, (mergedFileCounts.get(fileKey) ?? 0) + 1);
            mergedHits.push(h);
            return true;
        };
        for (const r of results) {
            pushMergedHit(r?.hits?.[0], 0, 1);
        }
        for (const r of results) {
            const h0 = r?.hits?.[0];
            if (h0?.code) pushMergedHit(h0, 0, 2);
        }
        for (let rank = 1; rank < 3; rank++) {
            for (const r of results) {
                pushMergedHit(r?.hits?.[rank], rank, 1);
            }
        }
        if (mergedHits.length < 4) {
            for (let rank = 0; rank < 3; rank++) {
                for (const r of results) {
                    pushMergedHit(r?.hits?.[rank], rank, 2);
                }
            }
        }
        if (mergedHits.length < 4) {
            for (let rank = 0; rank < 3; rank++) {
                for (const r of results) {
                    const h = r?.hits?.[rank];
                    if (h && !mergedSeen.has(h.pointer)) {
                        mergedSeen.add(h.pointer);
                        mergedHits.push(h);
                    }
                }
            }
        }
        const maxMergedBytes = intent.editEnvelope
            ? (queries.length >= 4 ? Math.max(HOOK_BUDGETS.editMergedBytes, 3800) : HOOK_BUDGETS.editMergedBytes)
            : HOOK_BUDGETS.qaMergedBytes;
        let inlinedBytes = 0;
        let inlinedCount = 0;
        for (let idx = 0; idx < mergedHits.length; idx++) {
            const h = mergedHits[idx];
            if (idx > 0 && h.wantsCallSites && (h.callSites?.length ?? 0) > 10) {
                h.wantsCallSites = false;
            }
            if (h.code) {
                if (idx > 0) {
                    const prevBlocks = new Set();
                    for (let pIdx = 0; pIdx < idx; pIdx++) {
                        const pc = mergedHits[pIdx]?.code;
                        if (!pc)
                            continue;
                        for (const seg of pc.split('\n\n// ').slice(1)) {
                            const hdr = seg.split('\n')[0];
                            if (hdr)
                                prevBlocks.add(hdr);
                        }
                    }
                    if (prevBlocks.size > 0 && h.code.includes('\n\n// ')) {
                        const parts = h.code.split('\n\n// ');
                        h.code = [parts[0], ...parts.slice(1).filter((seg) => !prevBlocks.has(seg.split('\n')[0])).map((seg) => `// ${seg}`)].join('\n\n');
                    }
                    if (mergedHits.slice(0, idx).some((oh) => oh.code && oh.pointer?.split(':')[0] === h.pointer?.split(':')[0])) {
                        const dupFooterIdx = h.code.indexOf('\n// other symbols in ');
                        if (dupFooterIdx > 0)
                            h.code = h.code.slice(0, dupFooterIdx);
                    }
                }
                if (idx === 0 && Buffer.byteLength(h.code, 'utf8') < 3800 && mergedHits.some((oh, oIdx) => oIdx > 0 && oh.code)) {
                    const nextCodeHit = mergedHits.find((oh, oIdx) => oIdx > 0 && oh.code);
                    if (nextCodeHit) {
                        const nextPrimaryLen = nextCodeHit.code.indexOf('\n\n// ') > 0
                            ? Buffer.byteLength(nextCodeHit.code.slice(0, nextCodeHit.code.indexOf('\n\n// ')), 'utf8')
                            : Buffer.byteLength(nextCodeHit.code, 'utf8');
                        const sameFileAsNext = h.pointer?.split(':')[0] === nextCodeHit.pointer?.split(':')[0];
                        if (
                            h.code.includes('\n\n// ') &&
                            (Buffer.byteLength(h.code, 'utf8') + nextPrimaryLen > maxMergedBytes ||
                                ((h.code.split('\n\n// ').length - 1 >= 2 || (sameFileAsNext && nextCodeHit.code.split('\n\n// ').length - 1 >= 2)) &&
                                    Buffer.byteLength(h.code, 'utf8') + Buffer.byteLength(nextCodeHit.code, 'utf8') > maxMergedBytes))
                        ) {
                            const otherSymsIdx = h.code.indexOf('\n// other symbols in ');
                            const trailingFooter = otherSymsIdx > 0 ? h.code.slice(otherSymsIdx) : '';
                            if (otherSymsIdx > 0)
                                h.code = h.code.slice(0, otherSymsIdx);
                            const firstHelperSplit = h.code.indexOf('\n\n// ');
                            if (firstHelperSplit > 0) {
                                const countRealHelpers = (str) => str.split('\n\n// ').slice(1).filter((s) => !s.startsWith('module return ')).length;
                                const hadThreeHelpers = countRealHelpers(h.code) >= 3;
                                while (
                                    h.code.includes('\n\n// ') &&
                                    h.code.lastIndexOf('\n\n// ') > firstHelperSplit &&
                                    Buffer.byteLength(h.code, 'utf8') + Buffer.byteLength(nextCodeHit.code, 'utf8') > maxMergedBytes
                                ) {
                                    h.code = h.code.slice(0, h.code.lastIndexOf('\n\n// '));
                                }
                                if (
                                    (Buffer.byteLength(h.code, 'utf8') + nextPrimaryLen > maxMergedBytes ||
                                        (!hadThreeHelpers && Buffer.byteLength(h.code, 'utf8') + Buffer.byteLength(nextCodeHit.code, 'utf8') > maxMergedBytes)) &&
                                    Buffer.byteLength(h.code, 'utf8') < 3200
                                ) {
                                    h.code = h.code.slice(0, firstHelperSplit);
                                }
                            }
                            if (trailingFooter && !h.code.includes('\n// other symbols in '))
                                h.code += trailingFooter;
                        }
                    }
                }
                let b = Buffer.byteLength(h.code, 'utf8');
                const maxInlinedHits = intent.editEnvelope
                    ? Math.max(HOOK_BUDGETS.editMaxInlined, queries.length >= 4 ? 4 : 0)
                    : HOOK_BUDGETS.qaMaxInlined;
                if (inlinedCount >= maxInlinedHits || (inlinedCount > 0 && inlinedBytes + b > maxMergedBytes)) {
                    if (inlinedCount < maxInlinedHits && h.code.includes('\n\n// ')) {
                        if (idx === 1 && mergedHits[0]?.code?.includes('\n\n// ')) {
                            let prevCode = mergedHits[0].code;
                            const firstPrevHelperIdx = prevCode.indexOf('\n\n// ');
                            const secondPrevHelperIdx = firstPrevHelperIdx > 0 ? prevCode.indexOf('\n\n// ', firstPrevHelperIdx + 6) : -1;
                            const hFirstIdx = h.code.indexOf('\n\n// ');
                            const hSecondIdx = hFirstIdx > 0 ? h.code.indexOf('\n\n// ', hFirstIdx + 6) : -1;
                            const thirdHelperIdx = hSecondIdx > 0 ? h.code.indexOf('\n\n// ', hSecondIdx + 6) : -1;
                            let candWithHelpers = thirdHelperIdx > 0 ? h.code.slice(0, thirdHelperIdx) : h.code;
                            while (
                                prevCode.includes('\n\n// ') &&
                                prevCode.lastIndexOf('\n\n// ') > firstPrevHelperIdx &&
                                inlinedBytes - Buffer.byteLength(mergedHits[0].code, 'utf8') + Buffer.byteLength(prevCode, 'utf8') + Buffer.byteLength(candWithHelpers, 'utf8') > maxMergedBytes
                            ) {
                                prevCode = prevCode.slice(0, prevCode.lastIndexOf('\n\n// '));
                            }
                            while (
                                candWithHelpers.includes('\n\n// ') &&
                                inlinedBytes - Buffer.byteLength(mergedHits[0].code, 'utf8') + Buffer.byteLength(prevCode, 'utf8') + Buffer.byteLength(candWithHelpers, 'utf8') > maxMergedBytes
                            ) {
                                candWithHelpers = candWithHelpers.slice(0, candWithHelpers.lastIndexOf('\n\n// '));
                            }
                            if (
                                ((candWithHelpers.split('\n\n// ').length - 1) < (h.code.split('\n\n// ').length - 1) ||
                                    ((h.code.split('\n\n// ').length - 1) >= 3 && (candWithHelpers.split('\n\n// ').length - 1) === 2)) &&
                                secondPrevHelperIdx === -1 &&
                                firstPrevHelperIdx > 0 &&
                                mergedHits[0].pointer?.split(':')[0] === h.pointer?.split(':')[0] &&
                                Buffer.byteLength(prevCode.slice(0, firstPrevHelperIdx), 'utf8') >= 1550
                            ) {
                                const prevNoHelper = prevCode.slice(0, firstPrevHelperIdx);
                                let fullCand = h.code;
                                while (
                                    fullCand.includes('\n\n// ') &&
                                    inlinedBytes - Buffer.byteLength(mergedHits[0].code, 'utf8') + Buffer.byteLength(prevNoHelper, 'utf8') + Buffer.byteLength(fullCand, 'utf8') > maxMergedBytes
                                ) {
                                    fullCand = fullCand.slice(0, fullCand.lastIndexOf('\n\n// '));
                                }
                                if ((fullCand.split('\n\n// ').length - 1) >= (candWithHelpers.split('\n\n// ').length - 1) && Buffer.byteLength(fullCand, 'utf8') > Buffer.byteLength(candWithHelpers, 'utf8')) {
                                    prevCode = prevNoHelper;
                                    candWithHelpers = fullCand;
                                }
                            }
                            const newTotal = inlinedBytes - Buffer.byteLength(mergedHits[0].code, 'utf8') + Buffer.byteLength(prevCode, 'utf8') + Buffer.byteLength(candWithHelpers, 'utf8');
                            if (newTotal <= maxMergedBytes && candWithHelpers.includes('\n\n// ')) {
                                mergedHits[0].code = prevCode;
                                h.code = candWithHelpers;
                                inlinedBytes = newTotal;
                                inlinedCount++;
                                continue;
                            }
                        }
                        let trimmed = h.code;
                        while (trimmed.includes('\n\n// ') && inlinedBytes + Buffer.byteLength(trimmed, 'utf8') > maxMergedBytes) {
                            trimmed = trimmed.slice(0, trimmed.lastIndexOf('\n\n// '));
                        }
                        const tb = Buffer.byteLength(trimmed, 'utf8');
                        if (inlinedBytes + tb <= maxMergedBytes) {
                            h.code = trimmed;
                            inlinedBytes += tb;
                            inlinedCount++;
                            continue;
                        }
                    }
                    if (inlinedCount < maxInlinedHits && idx > 0 && h.kind !== 'file' && !h.title?.endsWith(' · file') && !mergedHits.slice(0, idx).some((oh) => oh.code && oh.pointer?.split(':')[0] === h.pointer?.split(':')[0])) {
                        let candidateCode = h.code;
                        if (candidateCode.includes('\n\n// ') && inlinedBytes + Buffer.byteLength(candidateCode, 'utf8') > maxMergedBytes) {
                            candidateCode = candidateCode.slice(0, candidateCode.indexOf('\n\n// '));
                        }
                        for (let pIdx = idx - 1; pIdx >= 0; pIdx--) {
                            const prev = mergedHits[pIdx];
                            if (!prev?.code || !prev.code.includes('\n\n// '))
                                continue;
                            let prevCode = prev.code;
                            while (
                                prevCode.includes('\n\n// ') &&
                                inlinedBytes - Buffer.byteLength(prev.code, 'utf8') + Buffer.byteLength(prevCode, 'utf8') + Buffer.byteLength(candidateCode, 'utf8') > maxMergedBytes
                            ) {
                                prevCode = prevCode.slice(0, prevCode.lastIndexOf('\n\n// '));
                            }
                            const delta = Buffer.byteLength(prev.code, 'utf8') - Buffer.byteLength(prevCode, 'utf8');
                            if (delta > 0) {
                                prev.code = prevCode;
                                inlinedBytes -= delta;
                            }
                            if (inlinedBytes + Buffer.byteLength(candidateCode, 'utf8') <= maxMergedBytes)
                                break;
                        }
                        const cb = Buffer.byteLength(candidateCode, 'utf8');
                        if (inlinedBytes + cb <= maxMergedBytes) {
                            h.code = candidateCode;
                            inlinedBytes += cb;
                            inlinedCount++;
                            continue;
                        }
                    }
                    const oldFooterMatch = h.code.match(/\n\/\/ other symbols in [^\n]+:\s*(.+)$/);
                    if (oldFooterMatch && !h.otherSymbols)
                        h.otherSymbols = oldFooterMatch[1];
                    delete h.code;
                }
                else {
                    inlinedBytes += b;
                    inlinedCount++;
                }
            }
        }
        const topHits = mergedHits.slice(0, 4);
        const fileQueryCount = new Map();
        for (const r of results) {
            const seenInQ = new Set();
            for (const h of r?.hits ?? []) {
                const f = (h.pointer ?? '').split(':')[0];
                if (f && !seenInQ.has(f)) {
                    seenInQ.add(f);
                    fileQueryCount.set(f, (fileQueryCount.get(f) ?? 0) + 1);
                }
            }
        }
        const multiQueryFiles = [...fileQueryCount.entries()].filter(([, c]) => c >= 2).map(([f]) => f);
        return {
            query: queries.join(' ; '),
            mode: 'lexical',
            hits: topHits,
            allFiles: [...new Set([...topHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean), ...multiQueryFiles])],
            isEditPrompt: intent.editEnvelope,
            coverage: Math.max(...results.map((r) => r?.coverage ?? 0)),
            coverageStrong: Math.max(...results.map((r) => r?.coverageStrong ?? 0)),
        };
    }
    catch {
        return null;
    }
}

export function handlePostEdit(input, dir) {
    const editedFile = editedFilePath(input, dir);
    const br = recordFileEdit(dir, editedFile);
    if (!br)
        return;
    const id = input?.session_id || 'default';
    const s = readSession(dir, id);
    const base = basename(editedFile || '');
    if (!Array.isArray(s.emittedBlastFiles))
        s.emittedBlastFiles = [];
    const alreadyInTurn0 = (s.injectedPointers ?? []).some((p) =>
        String(p).split(':')[0] === base || String(p).split(':')[0].endsWith(`/${base}`),
    );
    if (base && (s.emittedBlastFiles.includes(base) || alreadyInTurn0)) {
        return;
    }
    if (base) {
        s.emittedBlastFiles.push(base);
        writeSession(dir, id, s);
    }
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
            await handleAgyPreInvocation(input);
        else if (event === 'agy-post-edit')
            handleAgyPostEdit(input);
        else
            handleAgyStop(input);
        return;
    }

    const rawDir = projectDir(input);
    const dir = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (process.env.PLEXER_DISABLE_HOOKS === '1') {
        return;
    }
    if (!existsSync(resolveContextDir(dir)) && (event === 'session-start' || event === 'prompt') && isAutoBuildableRepo(dir)) {
        try {
            await ensureFreshGraph(dir);
        }
        catch { /* best-effort auto-build */ }
    }
    if (!existsSync(resolveContextDir(dir))) {
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