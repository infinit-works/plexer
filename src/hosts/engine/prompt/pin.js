import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraphCached } from '../../../context/graph-store.js';
import { nearestPlexerRoot } from '../../../graph/root.js';
import { contextDirFor } from '../../../util/paths.js';
import { fmtLine, hasInlinedLine } from '../../../util/span.js';
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
                && ((hasInlinedLine(h.code, p.a) && hasInlinedLine(h.code, p.b)) || pointerCovers(h.pointer, p.pointer))))) ?? null;
    if (!covering) return false;
    covering.pinned = true;
    if (covering.title && !covering.title.includes('(named in prompt)')) covering.title = `${covering.title} (named in prompt)`;
    return true;
}

function inlinedLineNumbers(code) {
    const nums = new Set();
    for (const m of String(code ?? '').matchAll(/^L?(\d+):/gm)) nums.add(Number(m[1]));
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
    const maxRestInlined = opts?.geminiProfile ? (opts?.narrowPrompt ? 1 : 2) : ((pins.length + pinnedRestCount) >= 2 ? 2 : 3);
    let restInlined = 0;
    const inlinedFiles = new Set([...pins, ...rest.filter((h) => h.pinned)].map((p) => (p.pointer ?? '').split(':')[0]).filter(Boolean));
    const matchPin = (h) => h.code ? rawPins.find((p) => p.a && p.b && (h.pointer ?? '').split(':')[0] === (p.pointer ?? '').split(':')[0] && hasInlinedLine(h.code, p.a) && hasInlinedLine(h.code, p.b)) : null;
    for (const distinctFirst of [true, false]) {
        for (const pass of [true, false]) {
            for (const h of rest) {
                const mp = matchPin(h);
                if (h.pinned || !h.code || Boolean(mp) !== pass) continue;
                const hFile = (h.pointer ?? '').split(':')[0];
                const isNewFile = Boolean(hFile && !inlinedFiles.has(hFile));
                if (distinctFirst !== isNewFile) continue;
                if (restInlined >= maxRestInlined) { delete h.code; continue; }
                const hb = Buffer.byteLength(h.code, 'utf8');
                if (totalCodeBytes + hb <= maxTotalBytes) {
                    totalCodeBytes += hb; restInlined++;
                    if (hFile) inlinedFiles.add(hFile);
                    continue;
                }
                const added = trimOneOverflowHit(h, mp, totalCodeBytes, maxTotalBytes);
                if (added > 0) {
                    totalCodeBytes += added; restInlined++;
                    if (hFile) inlinedFiles.add(hFile);
                }
            }
        }
    }
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

export function backfillCompactPointerHits(root, hits, maxTotalBytes, pointerCovers, opts = {}) {
    const resolvedOpts = opts && typeof opts === 'object' ? opts : {};
    if (resolvedOpts.narrowPrompt || !root || !Array.isArray(hits) || hits.length === 0) return;
    let totalBytes = hits.reduce((a, h) => a + (h?.code ? Buffer.byteLength(h.code, 'utf8') : 0), 0);
    if (totalBytes >= Math.floor(maxTotalBytes * 0.72)) return;
    const fileLinesCache = new Map();
    const candidates = [];
    for (const h of hits.slice(0, 3)) {
        if (!h || h.code || !h.pointer) continue;
        const m = /^([^:,]+):L(\d+)(?:-L(\d+))?/.exec(String(h.pointer).split(',')[0].trim());
        if (!m) continue;
        const file = m[1];
        const a = Number(m[2]);
        const b = m[3] ? Number(m[3]) : a;
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a + 1) > 24) continue;
        const normPtr = `${file}:L${a}-L${b}`;
        const alreadyCovered = hits.some((other) => other?.code
            && (pointerCovers(other.pointer, normPtr)
                || ((other.pointer ?? '').split(':')[0] === file && hasInlinedLine(other.code, a) && hasInlinedLine(other.code, b))));
        if (alreadyCovered) continue;
        candidates.push({ h, file, a, b, spanLen: b - a + 1 });
    }
    for (const c of candidates) {
        if (c.spanLen > 24) continue;
        const lines = loadCachedFileLines(root, c.file, fileLinesCache);
        if (!lines) continue;
        const end = Math.min(lines.length, c.b);
        if (c.a < 1 || c.a > end) continue;
        const snippet = [];
        for (let ln = c.a; ln <= end; ln++) snippet.push(fmtLine(ln, lines[ln - 1]));
        const block = snippet.join('\n');
        const bytes = Buffer.byteLength(block, 'utf8');
        if (bytes > 900 || totalBytes + bytes > maxTotalBytes) continue;
        c.h.code = block;
        totalBytes += bytes;
    }
}

export function finalizePinnedPromptContext(dir, prompt, opts = {}, pinApi) {
    opts = opts ?? {};
    const { pinnedHits, pointerCovers, pointersOverlap } = pinApi;
    const geminiProfile = Boolean(opts?.geminiProfile);
    const fastProfile = Boolean(opts?.fastProfile);
    const narrowPrompt = Boolean(opts?.narrowPrompt);
    const res = searchPromptContext(dir, prompt, opts);
    const isEdit = !opts.forceReadOnly && (res?.isEditPrompt ?? detectPromptIntent(prompt, opts).editEnvelope);
    const rankedHits = res?.hits ?? [];
    const distinctRankedFiles = new Set(rankedHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean)).size;
    const multiFileEdit = Boolean(isEdit && !opts?.narrowPrompt && (res?.multiQuery || distinctRankedFiles >= 3));
    const budgets = resolveHookBudgets({ ...opts, multiFileEdit });
    let pins = [], rawPins = [], graph = null, ctxDir = null, root = dir;
    try {
        root = nearestPlexerRoot(dir)?.root ?? dir;
        ctxDir = contextDirFor(root);
        graph = loadGraphCached(ctxDir);
        const hintFiles = res?.allFiles ?? [...new Set(rankedHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean))];
        if (isEdit && budgets.pinMax > 0) {
            rawPins = pinnedHits(root, graph, prompt, { budgetBytes: budgets.pinBytes, maxPins: budgets.pinMax, hintFiles, geminiProfile, fastProfile, narrowPrompt, contiguous: true });
        } else if (geminiProfile && !isEdit && !opts.forceReadOnly && budgets.pinMax > 0) {
            const topRankedFile = (rankedHits[0]?.pointer ?? '').split(':')[0];
            const promptFileMatch = /([A-Za-z0-9_.-]+\.(?:py|go|js|ts|tsx|jsx|mjs|cjs|luau|lua|rs|c|cc|cpp|h|hpp|java|rb|php|cs|swift|kt|scala))/.exec(String(prompt ?? ''))?.[1];
            const topCoversTarget = Boolean(rankedHits[0]?.code && (!promptFileMatch || topRankedFile.includes(promptFileMatch)));
            if (!(narrowPrompt && topCoversTarget)) {
                const qaCandidates = pinnedHits(root, graph, prompt, { budgetBytes: Math.min(budgets.pinBytes ?? 4800, budgets.qaMergedBytes), maxPins: budgets.pinMax, hintFiles, geminiProfile: true, fastProfile, narrowPrompt });
                if (qaCandidates.length >= 2) rawPins = qaCandidates;
            }
        }
        for (const p of rawPins) {
            if (isPinCoveredByRankedHits(p, rankedHits, pointerCovers)) continue;
            inheritRankedHitEnrichments(p, rankedHits, pointersOverlap);
            pins.push(p);
        }
    } catch { pins = []; }
    const maxTotalBytes = isEdit ? budgets.editTotalBytes : budgets.qaMergedBytes;
    if (!pins.length) {
        if (geminiProfile && res?.hits?.length) backfillCompactPointerHits(root, res.hits, maxTotalBytes, pointerCovers, { narrowPrompt });
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
    const baseKeepCap = geminiProfile ? (!fastProfile && !narrowPrompt ? 2 : 1) : 2;
    const keepCap = baseKeepCap + pinnedRestCount;
    const keptRest = ((pins.length + pinnedRestCount) >= (geminiProfile ? 4 : 3) && !rest.some((h) => !h.pinned && h.code))
        ? novelRest.slice(0, keepCap)
        : rest;
    const finalHits = [...pins, ...keptRest];
    if (geminiProfile) backfillCompactPointerHits(root, finalHits, maxTotalBytes, pointerCovers, { narrowPrompt });
    const coEditPointers = isEdit && graph ? computeCoEditPointers(ctxDir, graph, finalHits) : [];
    return {
        ...(res ?? { query: prompt, mode: 'lexical', isEditPrompt: isEdit }),
        hits: finalHits,
        ...(coEditPointers.length > 0 ? { coEditPointers } : {}),
    };
}
