/**
 * Dual-model `plan_execute_protocol` handoff:
 * On `exit_plan_mode`, stage a compact (<=1,800 B) block of unseen plan targets,
 * callers, and linked test files for the Execution model's opening turn — returning
 * null (0 B) whenever all plan targets were already read during planning.
 */
import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { loadGraphCached } from '../context/graph-store.js';
import { incomingEdges } from '../claude/format.js';
import { linkTestsForGraph } from '../graph/test-links.js';
import { contextDirFor } from '../util/paths.js';
import { fileReader, parseNodeSpan } from '../util/span.js';
import { buildUniqueRepoLabels } from './multi-workspace.js';
import { isSpanCovered, normalizeRelFile, parsePointerSpan } from './spans.js';

const MAX_HANDOFF_BYTES = 1800;
const INLINE_SPAN_MAX_LINES = 45;

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

function isWholeFileSeen(agyState, label, relPath) {
    const norm = normalizeRelFile(relPath);
    const seen = agyState?.seenSpans ?? {};
    return Boolean(
        (Array.isArray(seen[norm]) && seen[norm].length > 0) ||
        (Array.isArray(seen[`${label}/${norm}`]) && seen[`${label}/${norm}`].length > 0),
    );
}

function extractPlanReferences(planText, workspaceDirs) {
    const fileCandidates = new Set();
    const symbolCandidates = new Set();

    // `[label](file:///abs/path#Lx-Ly)` or `file:///abs/path`
    for (const m of planText.matchAll(/file:\/\/([^\s)#`"'<>]+)(?:#[^\s)`"'<>]+)?/g)) {
        let p = m[1];
        try { p = decodeURIComponent(p); } catch { /* ignore */ }
        for (const ws of workspaceDirs) {
            const rel = relative(resolve(ws), resolve(p)).replace(/\\/g, '/');
            if (rel && !rel.startsWith('..'))
                fileCandidates.add(rel);
        }
        fileCandidates.add(p.replace(/\\/g, '/'));
    }

    // Backticked `path:sym`, `path`, or `sym`
    for (const m of planText.matchAll(/`([^`\n]{2,120})`/g)) {
        const raw = m[1].trim();
        const colon = raw.indexOf(':');
        if (colon > 0 && /[./]/.test(raw.slice(0, colon))) {
            fileCandidates.add(normalizeRelFile(raw.slice(0, colon)));
            const rest = raw.slice(colon + 1).trim();
            if (rest && !/^L?\d+(?:-L?\d+)?$/.test(rest))
                symbolCandidates.add(rest);
            continue;
        }
        if (/\.[A-Za-z0-9]{1,8}$/.test(raw) && !raw.includes(' ')) {
            fileCandidates.add(normalizeRelFile(raw.replace(/^\.\//, '')));
        }
        else if (/^[A-Za-z_][A-Za-z0-9_.]{2,80}$/.test(raw)) {
            symbolCandidates.add(raw);
        }
    }

    // Bare relative file paths with extensions in prose
    for (const m of planText.matchAll(/(?:^|[\s([{"'])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|luau|lua|java|rb|c|cpp|h|hpp))\b/g)) {
        fileCandidates.add(normalizeRelFile(m[1]));
    }

    return { fileCandidates: [...fileCandidates], symbolCandidates: [...symbolCandidates] };
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
    for (const symName of symbolCandidates) {
        const shortName = symName.split('.').pop();
        for (const n of graph.nodes) {
            if (n.kind === 'file' || !n.name)
                continue;
            if (n.name !== symName && n.name !== shortName)
                continue;
            if (matchedFiles.size === 0 || matchedFiles.has(n.path)) {
                matchedSymbols.push(n);
                matchedFiles.add(n.path);
            }
        }
    }
    return { matchedFiles, matchedSymbols };
}

function appendMatchedSymbolBlock(sym, label, multiRoot, agyState, readLines, state) {
    const sp = parseNodeSpan(sym);
    const start = sp?.start ?? 1;
    const end = sp?.end ?? start;
    if (isFileOrSpanSeen(agyState, label, sym.path, start, end))
        return false;
    const ptrPrefix = multiRoot ? `${label}/` : '';
    if (sp && (end - start + 1) <= INLINE_SPAN_MAX_LINES) {
        const lines = readLines(sym.path) || [];
        const snippet = [];
        for (let ln = start; ln <= Math.min(lines.length, end); ln++)
            snippet.push(`L${ln}: ${lines[ln - 1]}`);
        if (snippet.length > 0) {
            state.targetBlocks.push(
                ` • ${sym.name} (${ptrPrefix}${sym.path}:L${start}-L${end})\n\`\`\`\n${snippet.join('\n')}\n\`\`\``,
            );
            state.spansToRecord.push({ key: `${ptrPrefix}${sym.path}`, start, end });
            return true;
        }
    }
    const sig = sym.signature ? ` — ${sym.signature}` : '';
    state.targetBlocks.push(` • ${sym.name} (${ptrPrefix}${sym.path}:${sym.span || `L${start}`})${sig}`);
    return true;
}

function appendMatchedFileBlock(rel, label, multiRoot, graph, readLines, state) {
    const ptrPrefix = multiRoot ? `${label}/` : '';
    const syms = (graph.nodes ?? [])
        .filter((n) => n.path === rel && n.kind !== 'file' && n.name)
        .slice(0, 4)
        .map((n) => `${n.name} (${n.span || 'L1'})`);
    const lines = readLines(rel) || [];
    if (lines.length > 0 && lines.length <= INLINE_SPAN_MAX_LINES) {
        const snippet = lines.map((text, idx) => `L${idx + 1}: ${text}`).join('\n');
        state.targetBlocks.push(` • ${ptrPrefix}${rel}:L1-L${lines.length}\n\`\`\`\n${snippet}\n\`\`\``);
        state.spansToRecord.push({ key: `${ptrPrefix}${rel}`, start: 1, end: lines.length });
        return;
    }
    state.targetBlocks.push(
        ` • ${ptrPrefix}${rel} (${lines.length || '?'}L)${syms.length ? `: ${syms.join(', ')}` : ''}`,
    );
}

function collectCallersAndTestsForFile(rel, dir, label, multiRoot, graph, byId, testLinks, agyState, state) {
    const absFile = resolve(dir, rel);
    for (const e of incomingEdges(graph, absFile, dir)) {
        if (state.callerItems.length >= 4)
            break;
        const src = byId.get(e.source);
        if (!src?.path || !src?.name)
            continue;
        const key = `${src.name}@${src.path}`;
        if (state.seenCallers.has(key) || isWholeFileSeen(agyState, label, src.path))
            continue;
        state.seenCallers.add(key);
        state.callerItems.push(`${src.name} (${multiRoot ? `${label}/` : ''}${basename(src.path)})`);
    }
    for (const t of testLinks.testsForFile(rel)) {
        if (state.testItems.length >= 3)
            break;
        const tf = t.testFile;
        if (!tf || state.seenTests.has(tf) || isWholeFileSeen(agyState, label, tf))
            continue;
        state.seenTests.add(tf);
        state.testItems.push(`${multiRoot ? `${label}/` : ''}${tf}`);
    }
}

function collectRepoHandoffItems(dir, label, multiRoot, fileCandidates, symbolCandidates, agyState, opts, state) {
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

    const handledFiles = new Set();
    for (const sym of matchedSymbols) {
        if (state.targetBlocks.length >= 4)
            break;
        if (appendMatchedSymbolBlock(sym, label, multiRoot, agyState, readLines, state))
            handledFiles.add(sym.path);
    }
    for (const rel of matchedFiles) {
        if (state.targetBlocks.length >= 4)
            break;
        if (!handledFiles.has(rel) && !isWholeFileSeen(agyState, label, rel))
            appendMatchedFileBlock(rel, label, multiRoot, graph, readLines, state);
    }
    for (const rel of matchedFiles)
        collectCallersAndTestsForFile(rel, dir, label, multiRoot, graph, byId, testLinks, agyState, state);
}

/**
 * Build a <=1,800 B execution-model handoff for unread targets named in an approved plan.
 * Returns null (0 B) when every named target & test peer is already in session context.
 */
export function buildPlanExecutionHandoff(workspaceDirs, planText, agyState, opts = {}) {
    if (!planText || typeof planText !== 'string' || !planText.trim())
        return null;
    const dirs = (Array.isArray(workspaceDirs) ? workspaceDirs : [workspaceDirs]).filter(Boolean);
    if (dirs.length === 0)
        return null;

    const { fileCandidates, symbolCandidates } = extractPlanReferences(planText, dirs);
    if (fileCandidates.length === 0 && symbolCandidates.length === 0)
        return null;

    const state = {
        targetBlocks: [],
        callerItems: [],
        testItems: [],
        spansToRecord: [],
        seenCallers: new Set(),
        seenTests: new Set(),
    };
    const multiRoot = dirs.length >= 2;
    const labels = buildUniqueRepoLabels(dirs);

    for (let dirIdx = 0; dirIdx < dirs.length; dirIdx++) {
        collectRepoHandoffItems(dirs[dirIdx], labels[dirIdx], multiRoot, fileCandidates, symbolCandidates, agyState, opts, state);
    }

    if (state.targetBlocks.length === 0 && state.callerItems.length === 0 && state.testItems.length === 0)
        return null;

    const sections = ['[plexer] execution handoff (unseen plan targets & callers):'];
    if (state.targetBlocks.length > 0)
        sections.push(state.targetBlocks.join('\n'));
    if (state.callerItems.length > 0)
        sections.push(`unseen callers: ${state.callerItems.join(', ')}`);
    if (state.testItems.length > 0)
        sections.push(`unseen tests: ${state.testItems.join(', ')}`);

    return {
        text: fitToBytes(sections.join('\n'), MAX_HANDOFF_BYTES),
        spans: state.spansToRecord,
    };
}
