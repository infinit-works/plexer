/**
 * Dual-model `plan_execute_protocol` handoff:
 * On `exit_plan_mode`, stage a compact (<=1,800 B Gemini / <=2,200 B High+XHigh) block of unseen plan targets,
 * callers, and linked test files for the Execution model's opening turn — returning
 * null (0 B) whenever all plan targets were already read during planning.
 */
import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { loadGraphCached } from '../context/graph-store.js';
import { incomingEdges } from '../claude/format.js';
import { linkTestsForGraph } from '../graph/test-links.js';
import { GENERIC_MEMBER_NAMES } from '../util/id.js';
import { contextDirFor } from '../util/paths.js';
import { fileReader, fmtLine, parseNodeSpan } from '../util/span.js';
import { buildUniqueRepoLabels } from './multi-workspace.js';
import { extractInlinedSpansByFile, invalidateSpanIfModified, isSpanCovered, normalizeRelFile, parsePointerSpan } from './spans.js';

const MAX_HANDOFF_BYTES = 1600;
const GEMINI_HANDOFF_BYTES = 1800;
const XHIGH_GEMINI_HANDOFF_BYTES = 2200;
const INLINE_SPAN_MAX_LINES = 45;
const GEMINI_INLINE_SPAN_MAX_LINES = 50;
const XHIGH_GEMINI_INLINE_SPAN_MAX_LINES = 65;
const XHIGH_MAX_TARGET_BLOCKS = 4;

const TOOL_SYMBOL_NAMES = new Set([
    'edit_file', 'read_file', 'write_file', 'run_command', 'view_file',
    'replace_file_content', 'multi_replace_file_content', 'write_to_file',
    'grep_search', 'find_by_name', 'exit_plan_mode', 'enter_plan_mode',
    'update_steps', 'update_focus',
]);

const HANDOFF_STOP_SYMBOLS = new Set([
    ...TOOL_SYMBOL_NAMES,
    '__init__', '__str__', '__repr__', '__new__',
    'main', 'test', 'setup', 'teardown', 'init', 'run', 'get', 'set', 'new',
    'close', 'open', 'start', 'stop', 'error', 'data', 'value', 'result',
    'config', 'options', 'args', 'params', 'kwargs', 'self', 'this',
]);

function isFileOrSpanSeen(agyState, label, relPath, startLine = 1, endLine = 1) {
    const norm = normalizeRelFile(relPath);
    const seen = agyState?.seenSpans ?? {};
    const keys = [norm, `${label}/${norm}`];
    if (isSpanCovered(seen, norm, startLine, endLine, 0.85))
        return true;
    if (isSpanCovered(seen, `${label}/${norm}`, startLine, endLine, 0.85))
        return true;
    for (const ptr of agyState?.injectedPointers ?? []) {
        const parsed = parsePointerSpan(ptr);
        if (!parsed)
            continue;
        if (!keys.includes(parsed.file))
            continue;
        const total = Math.max(1, endLine - startLine + 1);
        const overlap = Math.max(0, Math.min(endLine, parsed.end) - Math.max(startLine, parsed.start) + 1);
        if (overlap / total >= 0.85)
            return true;
    }
    return false;
}

function hasAnySeenSpanInFile(agyState, label, relPath) {
    const norm = normalizeRelFile(relPath);
    const seen = agyState?.seenSpans ?? {};
    if ((Array.isArray(seen[norm]) && seen[norm].length > 0) || (Array.isArray(seen[`${label}/${norm}`]) && seen[`${label}/${norm}`].length > 0)) {
        return true;
    }
    const keys = [norm, `${label}/${norm}`];
    for (const ptr of agyState?.injectedPointers ?? []) {
        const parsed = parsePointerSpan(ptr);
        if (parsed && keys.includes(parsed.file)) return true;
    }
    return false;
}

function isWholeFileSeen(agyState, label, relPath, totalLines = 0) {
    const norm = normalizeRelFile(relPath);
    const seen = agyState?.seenSpans ?? {};
    if (totalLines > 0) {
        return isSpanCovered(seen, norm, 1, totalLines, 0.85)
            || isSpanCovered(seen, `${label}/${norm}`, 1, totalLines, 0.85);
    }
    return Boolean(
        (Array.isArray(seen[norm]) && seen[norm].length > 0) ||
        (Array.isArray(seen[`${label}/${norm}`]) && seen[`${label}/${norm}`].length > 0),
    );
}

function extractPlanReferences(planText, workspaceDirs) {
    const fileCandidates = new Set();
    const symbolCandidates = new Set();
    const rangeCandidates = [];
    const seenRanges = new Set();
    const addRange = (fileRel, rawStart, rawEnd) => {
        const start = Number.parseInt(rawStart, 10);
        const end = rawEnd ? Number.parseInt(rawEnd, 10) : start;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return;
        const normFile = normalizeRelFile(fileRel);
        if (!normFile) return;
        const rk = `${normFile}:${start}-${end}`;
        if (seenRanges.has(rk)) return;
        seenRanges.add(rk);
        rangeCandidates.push({ file: normFile, start, end });
    };

    // `[label](file:///abs/path#Lx-Ly)` or `file:///abs/path`
    for (const m of planText.matchAll(/file:\/\/([^\s)#`"'<>]+)(?:#([^\s)`"'<>]+))?/g)) {
        let p = m[1];
        try { p = decodeURIComponent(p); } catch { /* ignore */ }
        let matchedRel = null;
        for (const ws of workspaceDirs) {
            const rel = relative(resolve(ws), resolve(p)).replace(/\\/g, '/');
            if (rel && !rel.startsWith('..')) {
                fileCandidates.add(rel);
                if (!matchedRel) matchedRel = rel;
            }
        }
        const normP = p.replace(/\\/g, '/');
        fileCandidates.add(normP);
        if (m[2]) {
            const rm = /^L?(\d+)(?:-L?(\d+))?$/i.exec(m[2].trim());
            if (rm) addRange(matchedRel || normP, rm[1], rm[2]);
        }
    }

    // Backticked `path:sym`, `path`, or `sym` (skipping analogy/comparison prose for symbols)
    const symbolProse = planText.replace(
        /\b(?:matching|mirroring|like|similar to|unlike|versus|vs\.?|already exists(?:\s+in)?)\s+(?:`[^`\n]{2,120}`(?:\s*(?:,|and|or|\/)\s*`[^`\n]{2,120}`)*)/gi,
        ' ',
    );
    for (const m of planText.matchAll(/`([^`\n]{2,120})`/g)) {
        const raw = m[1].trim();
        const colon = raw.indexOf(':');
        if (colon > 0 && /[./]/.test(raw.slice(0, colon))) {
            const filePart = normalizeRelFile(raw.slice(0, colon));
            fileCandidates.add(filePart);
            const rest = raw.slice(colon + 1).trim();
            const rm = /^L?(\d+)(?:-L?(\d+))?$/i.exec(rest);
            if (rm) addRange(filePart, rm[1], rm[2]);
            continue;
        }
        if (/\.[A-Za-z0-9]{1,8}$/.test(raw) && !raw.includes(' ')) {
            fileCandidates.add(normalizeRelFile(raw.replace(/^\.\//, '')));
        }
    }
    for (const m of symbolProse.matchAll(/`([^`\n]{2,120})`/g)) {
        const raw = m[1].trim();
        const colon = raw.indexOf(':');
        if (colon > 0 && /[./]/.test(raw.slice(0, colon))) {
            const rest = raw.slice(colon + 1).trim();
            if (rest && !/^L?\d+(?:-L?\d+)?$/.test(rest) && !TOOL_SYMBOL_NAMES.has(rest.toLowerCase()))
                symbolCandidates.add(rest);
            continue;
        }
        if (!(/\.[A-Za-z0-9]{1,8}$/.test(raw) && !raw.includes(' ')) && /^[A-Za-z_][A-Za-z0-9_.]{2,80}$/.test(raw)) {
            const dot = raw.indexOf('.');
            if (dot > 0) {
                const owner = raw.slice(0, dot).toLowerCase();
                const member = raw.slice(dot + 1).toLowerCase();
                if (!TOOL_SYMBOL_NAMES.has(member) && !HANDOFF_STOP_SYMBOLS.has(owner) && !GENERIC_MEMBER_NAMES.has(owner))
                    symbolCandidates.add(raw);
            }
            else {
                const lower = raw.toLowerCase();
                if (!HANDOFF_STOP_SYMBOLS.has(lower) && !GENERIC_MEMBER_NAMES.has(lower))
                    symbolCandidates.add(raw);
            }
        }
    }

    // Bare relative file paths with extensions in prose
    for (const m of planText.matchAll(/(?:^|[\s([{"'])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|luau|lua|java|rb|c|cpp|h|hpp))\b/g)) {
        fileCandidates.add(normalizeRelFile(m[1]));
    }

    return { fileCandidates: [...fileCandidates], symbolCandidates: [...symbolCandidates], rangeCandidates };
}

function resolveGraphFile(graph, cand) {
    if (!graph?.nodes?.length || !cand)
        return null;
    const norm = normalizeRelFile(cand);
    const byPath = graph._nodesByPath ?? null;
    if (byPath?.has(norm))
        return norm;
    let best = null;
    let bestLen = Infinity;
    for (const n of graph.nodes) {
        if (n.kind !== 'file' || !n.path)
            continue;
        if (n.path === norm)
            return n.path;
        if (n.path.endsWith(`/${norm}`) || norm.endsWith(`/${n.path}`)) {
            if (n.path.length < bestLen) {
                best = n.path;
                bestLen = n.path.length;
            }
        }
    }
    return best;
}

function fitToBytes(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    const lines = text.split('\n');
    const kept = [];
    for (const line of lines) {
        const candidate = kept.length ? `${kept.join('\n')}\n${line}` : line;
        if (Buffer.byteLength(candidate, 'utf8') + 12 > maxBytes)
            break;
        kept.push(line);
    }
    let out = kept.join('\n');
    const fences = (out.match(/^```/gm) || []).length;
    if (fences % 2 === 1)
        out += '\n```';
    return out;
}

function matchPlanRepoTargets(graph, fileCandidates, symbolCandidates) {
    const matchedFiles = new Set();
    for (const cand of fileCandidates) {
        const rel = resolveGraphFile(graph, cand);
        if (rel)
            matchedFiles.add(rel);
    }

    const matchedSymbols = [];
    const seenNodeKeys = new Set();
    if (matchedFiles.size > 0) {
        for (const symName of symbolCandidates) {
            const shortName = symName.split('.').pop();
            for (const n of graph.nodes) {
                if (n.kind === 'file' || !n.name)
                    continue;
                if (n.name !== symName && n.name !== shortName)
                    continue;
                if (matchedFiles.has(n.path)) {
                    const nodeKey = n.id ?? `${n.path}:${n.span || n.name}`;
                    if (seenNodeKeys.has(nodeKey))
                        continue;
                    seenNodeKeys.add(nodeKey);
                    matchedSymbols.push(n);
                }
            }
        }
    }
    else {
        for (const symName of symbolCandidates) {
            const shortName = symName.split('.').pop();
            const cands = graph.nodes.filter((n) => n.kind !== 'file' && n.name && (n.name === symName || n.name === shortName));
            if (cands.length === 1) {
                const n = cands[0];
                const nodeKey = n.id ?? `${n.path}:${n.span || n.name}`;
                if (!seenNodeKeys.has(nodeKey)) {
                    seenNodeKeys.add(nodeKey);
                    matchedSymbols.push(n);
                    if (n.path)
                        matchedFiles.add(n.path);
                }
            }
        }
    }
    return { matchedFiles, matchedSymbols };
}

function selectPlanMatchedWindow(lines, start, end, matchTokens = [], maxWindowLines = 55) {
    const boundEnd = Math.min(lines.length, end);
    if (boundEnd < start) return null;
    if ((boundEnd - start + 1) <= maxWindowLines) return { winStart: start, winEnd: boundEnd };
    let anchor = -1;
    if (matchTokens.length > 0) {
        let bestLine = -1;
        let bestScore = 0;
        for (let ln = start; ln <= boundEnd; ln++) {
            const txt = lines[ln - 1] ?? '';
            let hits = 0;
            for (const tok of matchTokens) if (txt.includes(tok)) hits++;
            if (hits > bestScore) { bestScore = hits; bestLine = ln; }
        }
        if (bestLine >= start) anchor = bestLine;
    }
    const winStart = anchor > start
        ? Math.max(start, Math.min(boundEnd - maxWindowLines + 1, anchor - 12))
        : start;
    const winEnd = Math.min(boundEnd, winStart + maxWindowLines - 1);
    return { winStart, winEnd };
}

function appendMatchedSymbolBlock(sym, label, multiRoot, agyState, readLines, state, inlineMaxLines = INLINE_SPAN_MAX_LINES) {
    const sp = parseNodeSpan(sym);
    const start = sp?.start ?? 1;
    const end = sp?.end ?? start;
    if (isFileOrSpanSeen(agyState, label, sym.path, start, end))
        return false;
    const ptrPrefix = multiRoot ? `${label}/` : '';
    const blockKey = `${ptrPrefix}${sym.path}:${start}-${end}`;
    if (state.seenBlockKeys?.has(blockKey))
        return false;
    state.seenBlockKeys?.add(blockKey);
    const spanLen = end - start + 1;
    if (sp && (spanLen <= inlineMaxLines || spanLen > 90)) {
        const lines = readLines(sym.path) || [];
        const win = spanLen <= inlineMaxLines
            ? { winStart: start, winEnd: Math.min(lines.length, end) }
            : selectPlanMatchedWindow(lines, start, end, state.matchTokens, 55);
        if (win && win.winEnd >= win.winStart) {
            const snippet = [];
            for (let ln = win.winStart; ln <= win.winEnd; ln++)
                snippet.push(fmtLine(ln, lines[ln - 1]));
            if (snippet.length > 0) {
                if (win.winEnd < end) snippet.push(`… (+${end - win.winEnd} more lines; open ${ptrPrefix}${sym.path}:L${win.winEnd + 1}-L${end})`);
                state.targetBlocks.push(
                    ` • ${sym.name} (${ptrPrefix}${sym.path}:L${win.winStart}-L${win.winEnd})\n\`\`\`\n${snippet.join('\n')}\n\`\`\``,
                );
                state.spansToRecord.push({ key: `${ptrPrefix}${sym.path}`, start: win.winStart, end: win.winEnd });
                return true;
            }
        }
    }
    const sig = sym.signature ? ` — ${sym.signature}` : '';
    state.targetBlocks.push(` • ${sym.name} (${ptrPrefix}${sym.path}:${sym.span || `L${start}`})${sig}`);
    return true;
}

function appendMatchedRangeBlock(rel, reqStart, reqEnd, label, multiRoot, agyState, readLines, state, inlineMaxLines = INLINE_SPAN_MAX_LINES) {
    const lines = readLines(rel) || [];
    if (lines.length === 0)
        return false;
    const start = Math.max(1, Math.min(lines.length, reqStart));
    const end = Math.max(start, Math.min(lines.length, reqEnd));
    if (isFileOrSpanSeen(agyState, label, rel, start, end))
        return false;
    if ((end - start + 1) > inlineMaxLines)
        return false;
    const ptrPrefix = multiRoot ? `${label}/` : '';
    const blockKey = `${ptrPrefix}${rel}:${start}-${end}`;
    if (state.seenBlockKeys?.has(blockKey))
        return false;
    state.seenBlockKeys?.add(blockKey);
    const snippet = [];
    for (let ln = start; ln <= end; ln++)
        snippet.push(fmtLine(ln, lines[ln - 1]));
    if (snippet.length === 0)
        return false;
    state.targetBlocks.push(` • ${ptrPrefix}${rel}:L${start}-L${end}\n\`\`\`\n${snippet.join('\n')}\n\`\`\``);
    state.spansToRecord.push({ key: `${ptrPrefix}${rel}`, start, end });
    return true;
}

function appendMatchedFileBlock(rel, label, multiRoot, graph, readLines, state, inlineMaxLines = INLINE_SPAN_MAX_LINES) {
    const ptrPrefix = multiRoot ? `${label}/` : '';
    const syms = (graph.nodes ?? [])
        .filter((n) => n.path === rel && n.kind !== 'file' && n.name)
        .slice(0, 4)
        .map((n) => `${n.name} (${n.span || 'L1'})`);
    const lines = readLines(rel) || [];
    if (lines.length > 0 && lines.length <= inlineMaxLines) {
        const snippet = lines.map((text, idx) => fmtLine(idx + 1, text)).join('\n');
        state.targetBlocks.push(` • ${ptrPrefix}${rel}:L1-L${lines.length}\n\`\`\`\n${snippet}\n\`\`\``);
        state.spansToRecord.push({ key: `${ptrPrefix}${rel}`, start: 1, end: lines.length });
        return;
    }
    state.targetBlocks.push(
        ` • ${ptrPrefix}${rel} (${lines.length || '?'}L)${syms.length ? `: ${syms.join(', ')}` : ''}`,
    );
}

function fileLineCountForPath(graph, readLines, relPath) {
    const norm = normalizeRelFile(relPath);
    const fnNode = (graph?._nodesByPath?.get(norm) ?? graph?.nodes ?? []).find((n) => n.kind === 'file' && normalizeRelFile(n.path) === norm);
    const fromGraph = Number(fnNode?.lines ?? fnNode?.lineCount ?? 0);
    if (fromGraph > 0) return fromGraph;
    const lines = typeof readLines === 'function' ? readLines(relPath) : null;
    return Array.isArray(lines) ? lines.length : 0;
}

function collectCallersAndTestsForFile(rel, dir, label, multiRoot, graph, byId, testLinks, agyState, state, readLines) {
    const absFile = resolve(dir, rel);
    for (const e of incomingEdges(graph, absFile, dir)) {
        if (state.callerItems.length >= 4)
            break;
        const src = byId.get(e.source);
        if (!src?.path || !src?.name)
            continue;
        const key = `${src.name}@${src.path}`;
        if (state.seenCallers.has(key) || isWholeFileSeen(agyState, label, src.path, fileLineCountForPath(graph, readLines, src.path)))
            continue;
        state.seenCallers.add(key);
        state.callerItems.push(`${src.name} (${multiRoot ? `${label}/` : ''}${basename(src.path)})`);
    }
    for (const t of testLinks.testsForFile(rel)) {
        if (state.testItems.length >= 3)
            break;
        const tf = t.testFile;
        if (!tf || state.seenTests.has(tf) || isWholeFileSeen(agyState, label, tf, fileLineCountForPath(graph, readLines, tf)))
            continue;
        state.seenTests.add(tf);
        state.testItems.push(`${multiRoot ? `${label}/` : ''}${tf}`);
    }
}

function extractSurvivingHandoffSpans(fitText) {
    const spans = [];
    const lines = String(fitText ?? '').split('\n');
    let curFile = '';
    let inFence = false;
    let codeBuf = [];
    const flush = () => {
        if (curFile && codeBuf.length > 0) {
            for (const r of extractInlinedSpansByFile(codeBuf.join('\n'), curFile)) {
                spans.push({ key: r.file, start: r.start, end: r.end });
            }
        }
        codeBuf = [];
    };
    for (const ln of lines) {
        if (!inFence) {
            const m = /^\s*•\s+(?:[^\s(]+\s+\(([^():]+):L\d+|([^():]+):L\d+)/.exec(ln);
            if (m) {
                curFile = normalizeRelFile(m[1] || m[2]);
                continue;
            }
        }
        if (/^```/.test(ln)) {
            if (inFence) {
                flush();
                inFence = false;
                curFile = '';
            }
            else if (curFile) {
                inFence = true;
                codeBuf = [];
            }
            continue;
        }
        if (inFence)
            codeBuf.push(ln);
    }
    if (inFence)
        flush();
    return spans;
}

function collectRepoHandoffItems(dir, label, multiRoot, fileCandidates, symbolCandidates, rangeCandidates, agyState, opts, state) {
    const ctxDir = contextDirFor(dir);
    if (!existsSync(ctxDir))
        return;
    const graph = typeof opts.getGraph === 'function' ? opts.getGraph(dir) : loadGraphCached(ctxDir);
    if (!graph?.nodes?.length)
        return;

    const readLines = fileReader(dir);
    const testLinks = linkTestsForGraph(graph);
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const { matchedFiles, matchedSymbols } = matchPlanRepoTargets(graph, fileCandidates, symbolCandidates);
    const matchedRanges = [];
    for (const rc of rangeCandidates ?? []) {
        const rel = resolveGraphFile(graph, rc.file);
        if (!rel) continue;
        matchedFiles.add(rel);
        matchedRanges.push({ rel, start: rc.start, end: rc.end });
    }
    const ptrPrefix = multiRoot ? `${label}/` : '';
    for (const rel of matchedFiles) {
        state.matchedFiles.add(`${ptrPrefix}${rel}`);
        const absTarget = resolve(dir, rel);
        if (ptrPrefix) invalidateSpanIfModified(agyState, `${ptrPrefix}${rel}`, absTarget);
        invalidateSpanIfModified(agyState, rel, absTarget);
    }

    const isExpandedGemini = Boolean(opts.geminiProfile && (opts.xhighProfile || opts.highProfile));
    const maxTargetBlocks = opts.maxTargetBlocks ?? (isExpandedGemini ? XHIGH_MAX_TARGET_BLOCKS : 4);
    const inlineMaxLines = opts.inlineMaxLines ?? (isExpandedGemini ? XHIGH_GEMINI_INLINE_SPAN_MAX_LINES : (opts.geminiProfile ? GEMINI_INLINE_SPAN_MAX_LINES : INLINE_SPAN_MAX_LINES));
    const sortedMatchedFiles = [...matchedFiles].sort();
    const sortedMatchedSymbols = [...matchedSymbols].sort((a, b) =>
        (a.path ?? '').localeCompare(b.path ?? '')
        || (parseNodeSpan(a)?.start ?? 0) - (parseNodeSpan(b)?.start ?? 0)
        || String(a.name ?? '').localeCompare(String(b.name ?? '')));
    const handledFiles = new Set();
    for (const mr of matchedRanges) {
        if (state.targetBlocks.length >= maxTargetBlocks)
            break;
        if (appendMatchedRangeBlock(mr.rel, mr.start, mr.end, label, multiRoot, agyState, readLines, state, inlineMaxLines)
            || hasAnySeenSpanInFile(agyState, label, mr.rel)) {
            handledFiles.add(mr.rel);
        }
    }
    for (const sym of sortedMatchedSymbols) {
        if (state.targetBlocks.length >= maxTargetBlocks)
            break;
        if (appendMatchedSymbolBlock(sym, label, multiRoot, agyState, readLines, state, inlineMaxLines)
            || hasAnySeenSpanInFile(agyState, label, sym.path)) {
            handledFiles.add(sym.path);
        }
    }
    for (const rel of sortedMatchedFiles) {
        if (state.targetBlocks.length >= maxTargetBlocks)
            break;
        if (handledFiles.has(rel))
            continue;
        const totalFileLines = fileLineCountForPath(graph, readLines, rel);
        if ((opts.geminiProfile || totalFileLines > inlineMaxLines) && hasAnySeenSpanInFile(agyState, label, rel))
            continue;
        if (!isWholeFileSeen(agyState, label, rel, totalFileLines))
            appendMatchedFileBlock(rel, label, multiRoot, graph, readLines, state, inlineMaxLines);
    }
    for (const rel of sortedMatchedFiles)
        collectCallersAndTestsForFile(rel, dir, label, multiRoot, graph, byId, testLinks, agyState, state, readLines);
}

/**
 * Resolve normalized repository-relative target file paths referenced in `planText`.
 */
export function resolvePlanTargetFiles(workspaceDirs, planText, opts = {}) {
    if (!planText || typeof planText !== 'string' || !planText.trim())
        return [];
    const dirs = (Array.isArray(workspaceDirs) ? workspaceDirs : [workspaceDirs]).filter(Boolean);
    if (dirs.length === 0)
        return [];
    const { fileCandidates, symbolCandidates } = extractPlanReferences(planText, dirs);
    if (fileCandidates.length === 0 && symbolCandidates.length === 0)
        return [];
    const multiRoot = dirs.length >= 2;
    const labels = buildUniqueRepoLabels(dirs);
    const out = new Set();
    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        const ctxDir = contextDirFor(dir);
        if (!existsSync(ctxDir))
            continue;
        const graph = typeof opts.getGraph === 'function' ? opts.getGraph(dir) : loadGraphCached(ctxDir);
        if (!graph?.nodes?.length)
            continue;
        const { matchedFiles } = matchPlanRepoTargets(graph, fileCandidates, symbolCandidates);
        const prefix = multiRoot ? `${labels[i]}/` : '';
        for (const rel of matchedFiles)
            out.add(`${prefix}${rel}`);
    }
    return [...out];
}

/**
 * Build an execution-model handoff (`<=1,600 B` default, `<=1,800 B` for Gemini, `<=2,200 B` for High/XHigh Gemini Orchestrator) for unread targets named in an approved plan.
 * Returns null (0 B) when every named target & test peer is already in session context unless `opts.includeExecuteDirective` is true.
 */
export function buildPlanExecutionHandoff(workspaceDirs, planText, agyState, opts = {}) {
    if (!planText || typeof planText !== 'string' || !planText.trim())
        return null;
    const dirs = (Array.isArray(workspaceDirs) ? workspaceDirs : [workspaceDirs]).filter(Boolean);
    if (dirs.length === 0)
        return null;

    const { fileCandidates, symbolCandidates, rangeCandidates } = extractPlanReferences(planText, dirs);
    if (fileCandidates.length === 0 && symbolCandidates.length === 0 && rangeCandidates.length === 0)
        return null;

    const matchTokens = [...new Set([
        ...symbolCandidates,
        ...[...planText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,40})\b/g)].map((m) => m[1]),
    ])].slice(0, 24);
    const state = {
        targetBlocks: [],
        callerItems: [],
        testItems: [],
        spansToRecord: [],
        seenCallers: new Set(),
        seenTests: new Set(),
        seenBlockKeys: new Set(),
        matchedFiles: new Set(),
        matchTokens,
    };
    const multiRoot = dirs.length >= 2;
    const labels = buildUniqueRepoLabels(dirs);

    for (let dirIdx = 0; dirIdx < dirs.length; dirIdx++) {
        collectRepoHandoffItems(dirs[dirIdx], labels[dirIdx], multiRoot, fileCandidates, symbolCandidates, rangeCandidates, agyState, opts, state);
    }

    const targetFiles = [...state.matchedFiles];
    if (state.targetBlocks.length === 0 && (opts.includeExecuteDirective || (state.callerItems.length === 0 && state.testItems.length === 0))) {
        if (!opts.includeExecuteDirective)
            return null;
        const targetSummary = targetFiles.length > 0 ? targetFiles.slice(0, 4).join(', ') : 'planned files';
        return {
            text: `[plexer] execution handoff: planned targets (${targetSummary}) are already in context — apply planned edits directly in 1 parallel turn without re-reading; run one narrow verification check and finish.`,
            spans: [],
            targetFiles,
        };
    }

    const header = opts.includeExecuteDirective
        ? '[plexer] execution handoff (unseen plan targets below; already-read files are in context — edit directly in 1 parallel turn without re-reading):'
        : '[plexer] execution handoff (unseen plan targets & callers):';
    const sections = [header];
    if (state.targetBlocks.length > 0)
        sections.push(state.targetBlocks.join('\n'));
    if (state.callerItems.length > 0)
        sections.push(`unseen callers: ${state.callerItems.join(', ')}`);
    if (state.testItems.length > 0)
        sections.push(`unseen tests: ${state.testItems.join(', ')}`);

    const isExpandedGemini = Boolean(opts.geminiProfile && (opts.xhighProfile || opts.highProfile));
    const maxBytes = opts.maxBytes ?? (isExpandedGemini ? XHIGH_GEMINI_HANDOFF_BYTES : (opts.geminiProfile ? GEMINI_HANDOFF_BYTES : MAX_HANDOFF_BYTES));
    const text = fitToBytes(sections.join('\n'), maxBytes);
    return {
        text,
        spans: extractSurvivingHandoffSpans(text),
        targetFiles,
    };
}
