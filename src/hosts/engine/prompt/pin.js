import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraphCached } from '../../../context/graph-store.js';
import { tokenize } from '../../../ask/index-file.js';
import { nearestPlexerRoot } from '../../../graph/root.js';
import { contextDirFor } from '../../../util/paths.js';
import { countHitSubsystemDirs, resolveHookBudgets } from './budget.js';
import { detectPromptIntent } from './intent.js';
import { computeCoEditPointers, searchPromptContext } from './search.js';

export function isPinCoveredByRankedHits(p, rankedHits, pointerCovers) {
    if (!p.a || !p.b || p.code?.includes('// delegator in ') || p.code?.includes('// caller in ') || p.code?.includes('// constructor in ')) {
        return false;
    }
    const pFile = (p.pointer ?? '').split(':')[0];
    const pBytes = Buffer.byteLength(p.code ?? '', 'utf8');
    const covering = rankedHits.find((h) => h.code
        && ((h.pointer === p.pointer && Buffer.byteLength(h.code, 'utf8') >= pBytes)
            || (!h.code.includes('omitted)') && !h.code.includes('excerpt of')
                && (h.pointer ?? '').split(':')[0] === pFile
                && ((h.code.includes(`L${p.a}:`) && h.code.includes(`L${p.b}:`)) || pointerCovers(h.pointer, p.pointer))))) ?? null;
    if (!covering) return false;
    covering.pinned = true;
    if (covering.title && !covering.title.includes('(named in prompt)')) covering.title = `${covering.title} (named in prompt)`;
    return true;
}

function inlinedLineNumbers(code) {
    const nums = new Set();
    for (const m of String(code ?? '').matchAll(/^L(\d+):/gm)) nums.add(Number(m[1]));
    return nums;
}

export function hasDuplicateInlinedSpan(h, p, pointersOverlap) {
    if (!h.code || !p.code || !pointersOverlap(p.pointer, h.pointer)) return false;
    const hLines = inlinedLineNumbers(h.code);
    const pLines = inlinedLineNumbers(p.code);
    if (!hLines.size || !pLines.size) return false;
    let shared = 0;
    for (const ln of pLines) if (hLines.has(ln)) shared++;
    const minSize = Math.min(hLines.size, pLines.size);
    return shared >= 4 || (minSize > 0 && shared / minSize >= 0.5);
}

export function inheritRankedHitEnrichments(p, rankedHits, pointersOverlap) {
    for (const h of rankedHits) {
        if (!pointersOverlap(p.pointer, h.pointer)) continue;
        if (h.related && !p.related) p.related = h.related;
        if (h.callSites && !p.callSites) { p.callSites = h.callSites; p.wantsCallSites = h.wantsCallSites; }
        if (h.otherSymbols && !p.otherSymbols) p.otherSymbols = h.otherSymbols;
    }
}

function trimOneOverflowHit(h, mp, totalCodeBytes, maxTotalBytes) {
    let partial = !mp?.code && h.code.includes('\n\n// ') ? h.code : null;
    while (partial?.includes('\n\n// ') && totalCodeBytes + Buffer.byteLength(partial, 'utf8') > maxTotalBytes + 450) {
        partial = partial.slice(0, partial.lastIndexOf('\n\n// '));
    }
    const fallback = mp?.code ?? partial ?? (h.code.includes('\n\n// ') ? h.code.slice(0, h.code.indexOf('\n\n// ')) : null);
    const fb = fallback ? Buffer.byteLength(fallback, 'utf8') : Infinity;
    if (fallback && totalCodeBytes + fb <= maxTotalBytes + (partial?.includes('\n\n// ') ? 450 : 0)) {
        h.code = fallback;
        return fb;
    }
    if (mp?.code && h.code.includes('\n\n// ')) {
        const primary = h.code.slice(0, h.code.indexOf('\n\n// '));
        const pb = Buffer.byteLength(primary, 'utf8');
        if (totalCodeBytes + pb <= maxTotalBytes) { h.code = primary; return pb; }
        delete h.code;
        return 0;
    }
    const room = maxTotalBytes + 450 - totalCodeBytes;
    if (room >= 450 && h.code) {
        const kept = [];
        let used = 0;
        for (const l of h.code.split('\n')) {
            const lb = Buffer.byteLength(l, 'utf8') + 1;
            if (used + lb > room) break;
            kept.push(l);
            used += lb;
        }
        if (kept.length >= 6) { h.code = kept.join('\n'); return used; }
    }
    delete h.code;
    return 0;
}

export function trimRestHitCodeToBudget(rest, pins, rawPins, { pointerCovers, pointersOverlap }, opts = {}) {
    const budgets = resolveHookBudgets(opts);
    for (const h of rest) {
        if (h.pinned || !h.code) continue;
        const coveredPinBytes = pins.filter((p) => pointerCovers(h.pointer, p.pointer))
            .reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0);
        if (coveredPinBytes >= 1200 || pins.some((p) => hasDuplicateInlinedSpan(h, p, pointersOverlap))) delete h.code;
    }
    const pinnedRestCount = rest.filter((h) => h.pinned).length;
    let totalCodeBytes = pins.reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0)
        + rest.filter((h) => h.pinned && h.code).reduce((a, h) => a + Buffer.byteLength(h.code, 'utf8'), 0);
    const maxTotalBytes = opts?.maxTotalBytesOverride ?? budgets.editTotalBytes ?? 4600;
    const maxRestInlined = opts?.geminiProfile ? 3 : ((pins.length + pinnedRestCount) >= 2 ? 2 : 3);
    let restInlined = 0;
    const matchPin = (h) => h.code ? rawPins.find((p) => p.a && p.b && (h.pointer ?? '').split(':')[0] === (p.pointer ?? '').split(':')[0] && h.code.includes(`L${p.a}:`) && h.code.includes(`L${p.b}:`)) : null;
    for (const pass of [true, false]) {
        for (const h of rest) {
            const mp = matchPin(h);
            if (h.pinned || !h.code || Boolean(mp) !== pass) continue;
            if (restInlined >= maxRestInlined) { delete h.code; continue; }
            const hb = Buffer.byteLength(h.code, 'utf8');
            if (totalCodeBytes + hb <= maxTotalBytes) { totalCodeBytes += hb; restInlined++; continue; }
            const added = trimOneOverflowHit(h, mp, totalCodeBytes, maxTotalBytes);
            if (added > 0) { totalCodeBytes += added; restInlined++; }
        }
    }
}

function extractQueryWindowSnippet(lines, file, a, end, qTokens, maxBytes = 1050) {
    if (end - a + 1 <= 20) {
        const out = [];
        for (let ln = a; ln <= end; ln++) out.push(`L${ln}: ${lines[ln - 1]}`);
        const full = out.join('\n');
        if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
    }
    let bestLine = a;
    let bestScore = -1;
    for (let ln = a; ln <= end; ln++) {
        const lower = lines[ln - 1].toLowerCase();
        let sc = 0;
        for (const t of qTokens) if (lower.includes(t)) sc += 1;
        if (sc > bestScore) {
            bestScore = sc;
            bestLine = ln;
        }
    }
    const wStart = bestScore > 0 ? Math.max(a, bestLine - 4) : a;
    let wEnd = Math.min(end, wStart + 14);
    const build = (stopLn) => {
        const out = [];
        if (wStart > a + 1) {
            out.push(`L${a}: ${lines[a - 1]}`);
            out.push(`  … (${wStart - a - 1} lines omitted)`);
        }
        for (let ln = wStart > a + 1 ? wStart : a; ln <= stopLn; ln++) {
            out.push(`L${ln}: ${lines[ln - 1]}`);
        }
        if (stopLn < end) out.push(`… (+${end - stopLn} more lines; read ${file}:L${stopLn + 1}-L${end})`);
        return out.join('\n');
    };
    let rendered = build(wEnd);
    while (wEnd > Math.max(wStart, bestLine) && Buffer.byteLength(rendered, 'utf8') > maxBytes) {
        wEnd -= 2;
        rendered = build(Math.max(wStart, bestLine, wEnd));
    }
    return rendered;
}

function loadCachedFileLines(root, file, fileLinesCache) {
    let lines = fileLinesCache.get(file);
    if (lines === undefined) {
        const abs = join(root, file);
        if (!existsSync(abs)) { fileLinesCache.set(file, null); return null; }
        try {
            lines = readFileSync(abs, 'utf8').split(/\r?\n/);
            fileLinesCache.set(file, lines);
        } catch {
            fileLinesCache.set(file, null);
            return null;
        }
    }
    return lines;
}

export function backfillCompactPointerHits(root, hits, maxTotalBytes, pointerCovers, promptQuery = '') {
    if (!root || !Array.isArray(hits) || hits.length === 0) return;
    let totalBytes = hits.reduce((a, h) => a + (h?.code ? Buffer.byteLength(h.code, 'utf8') : 0), 0);
    if (totalBytes >= maxTotalBytes) return;
    const fileLinesCache = new Map();
    const candidates = [];
    for (const h of hits) {
        if (!h || h.code || !h.pointer) continue;
        const m = /^([^:,]+):L(\d+)(?:-L(\d+))?/.exec(String(h.pointer).split(',')[0].trim());
        if (!m) continue;
        const file = m[1];
        const a = Number(m[2]);
        const b = m[3] ? Number(m[3]) : a;
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a + 1) > 140) continue;
        const normPtr = `${file}:L${a}-L${b}`;
        const alreadyCovered = hits.some((other) => other?.code
            && (pointerCovers(other.pointer, normPtr)
                || ((other.pointer ?? '').split(':')[0] === file && other.code.includes(`L${a}:`) && other.code.includes(`L${b}:`))));
        if (alreadyCovered) continue;
        candidates.push({ h, file, a, b, spanLen: b - a + 1 });
    }
    for (const c of candidates) {
        if (c.spanLen > 28) continue;
        const lines = loadCachedFileLines(root, c.file, fileLinesCache);
        if (!lines) continue;
        const end = Math.min(lines.length, c.b);
        if (c.a < 1 || c.a > end) continue;
        const snippet = [];
        for (let ln = c.a; ln <= end; ln++) snippet.push(`L${ln}: ${lines[ln - 1]}`);
        const block = snippet.join('\n');
        const bytes = Buffer.byteLength(block, 'utf8');
        if (bytes > 1100 || totalBytes + bytes > maxTotalBytes) continue;
        c.h.code = block;
        totalBytes += bytes;
    }
    if (maxTotalBytes - totalBytes < 350) return;
    const qTokens = [...new Set(tokenize(promptQuery).filter((t) => t.length >= 3))];
    for (const c of candidates) {
        if (c.h.code || c.spanLen <= 28) continue;
        if (maxTotalBytes - totalBytes < 350) break;
        const lines = loadCachedFileLines(root, c.file, fileLinesCache);
        if (!lines) continue;
        const end = Math.min(lines.length, c.b);
        if (c.a < 1 || c.a > end) continue;
        const block = extractQueryWindowSnippet(lines, c.file, c.a, end, qTokens, 1050);
        const bytes = Buffer.byteLength(block, 'utf8');
        if (bytes > 1050 || totalBytes + bytes > maxTotalBytes) continue;
        c.h.code = block;
        totalBytes += bytes;
    }
}

export function finalizePinnedPromptContext(dir, prompt, opts = {}, pinApi) {
    opts = opts ?? {};
    const { pinnedHits, pointerCovers, pointersOverlap } = pinApi;
    const geminiProfile = Boolean(opts?.geminiProfile);
    const budgets = resolveHookBudgets(opts);
    const res = searchPromptContext(dir, prompt, opts);
    const isEdit = !opts.forceReadOnly && (res?.isEditPrompt ?? detectPromptIntent(prompt, opts).editEnvelope);
    let pins = [], rawPins = [], graph = null, ctxDir = null, root = dir;
    try {
        root = nearestPlexerRoot(dir)?.root ?? dir;
        ctxDir = contextDirFor(root);
        graph = loadGraphCached(ctxDir);
        const rankedHits = res?.hits ?? [];
        const hintFiles = res?.allFiles ?? [...new Set(rankedHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean))];
        if (isEdit && budgets.pinMax > 0) {
            rawPins = pinnedHits(root, graph, prompt, { budgetBytes: budgets.pinBytes, maxPins: budgets.pinMax, hintFiles, geminiProfile });
        } else if (geminiProfile && !isEdit && !opts.forceReadOnly && budgets.pinMax > 0) {
            const qaCandidates = pinnedHits(root, graph, prompt, { budgetBytes: Math.min(4800, budgets.qaMergedBytes), maxPins: budgets.pinMax, hintFiles, geminiProfile: true });
            if (qaCandidates.length >= 2) rawPins = qaCandidates;
        }
        for (const p of rawPins) {
            if (isPinCoveredByRankedHits(p, rankedHits, pointerCovers)) continue;
            inheritRankedHitEnrichments(p, rankedHits, pointersOverlap);
            pins.push(p);
        }
    } catch { pins = []; }
    const geminiMaxTotalBytes = isEdit ? budgets.editTotalBytes : budgets.qaMergedBytes;
    if (!pins.length) {
        if (geminiProfile && res?.hits?.length) backfillCompactPointerHits(root, res.hits, geminiMaxTotalBytes, pointerCovers, prompt);
        if (isEdit && res?.hits?.length && graph) {
            const coEditPointers = computeCoEditPointers(ctxDir, graph, res.hits);
            if (coEditPointers.length > 0) res.coEditPointers = coEditPointers;
        }
        return res;
    }
    const rest = (res?.hits ?? []).filter((h) => !pins.some((p) => pointerCovers(p.pointer, h.pointer)));
    const isMultiSubsystemQa = !geminiProfile && !isEdit && countHitSubsystemDirs(res?.hits) >= 3;
    const qaCap = isMultiSubsystemQa
        ? Math.min(budgets.qaMergedBytes, budgets.qaMultiSubsystemMergedBytes ?? 4600)
        : budgets.qaMergedBytes;
    trimRestHitCodeToBudget(rest, pins, rawPins, { pointerCovers, pointersOverlap }, !isEdit ? { ...opts, maxTotalBytesOverride: qaCap } : opts);
    const pinnedRestCount = rest.filter((h) => h.pinned).length;
    const pinnedFiles = new Set([...pins, ...rest.filter((h) => h.pinned)].map((p) => (p.pointer ?? '').split(':')[0]).filter(Boolean));
    const novelRest = rest.filter((h) => h.pinned || !pinnedFiles.has((h.pointer ?? '').split(':')[0]));
    const keepCap = (geminiProfile ? 3 : 2) + pinnedRestCount;
    const keptRest = ((pins.length + pinnedRestCount) >= (geminiProfile ? 4 : 3) && !rest.some((h) => !h.pinned && h.code))
        ? novelRest.slice(0, keepCap)
        : rest;
    const finalHits = [...pins, ...keptRest];
    if (geminiProfile) backfillCompactPointerHits(root, finalHits, geminiMaxTotalBytes, pointerCovers, prompt);
    const coEditPointers = isEdit && graph ? computeCoEditPointers(ctxDir, graph, finalHits) : [];
    return {
        ...(res ?? { query: prompt, mode: 'lexical', isEditPrompt: isEdit }),
        hits: finalHits,
        ...(coEditPointers.length > 0 ? { coEditPointers } : {}),
    };
}
