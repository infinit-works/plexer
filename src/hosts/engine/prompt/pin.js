import { loadGraphCached } from '../../../context/graph-store.js';
import { nearestPlexerRoot } from '../../../graph/root.js';
import { contextDirFor } from '../../../util/paths.js';
import { HOOK_BUDGETS } from './budget.js';
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

export function trimRestHitCodeToBudget(rest, pins, rawPins, { pointerCovers, pointersOverlap }) {
    for (const h of rest) {
        if (h.pinned || !h.code) continue;
        const coveredPinBytes = pins.filter((p) => pointerCovers(h.pointer, p.pointer))
            .reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0);
        if (coveredPinBytes >= 1200 || pins.some((p) => hasDuplicateInlinedSpan(h, p, pointersOverlap))) delete h.code;
    }
    const pinnedRestCount = rest.filter((h) => h.pinned).length;
    let totalCodeBytes = pins.reduce((a, p) => a + Buffer.byteLength(p.code ?? '', 'utf8'), 0)
        + rest.filter((h) => h.pinned && h.code).reduce((a, h) => a + Buffer.byteLength(h.code, 'utf8'), 0);
    const maxTotalBytes = HOOK_BUDGETS.editTotalBytes ?? 4600;
    const maxRestInlined = (pins.length + pinnedRestCount) >= 2 ? 2 : 3;
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

export function finalizePinnedPromptContext(dir, prompt, opts, pinApi) {
    const { pinnedHits, pointerCovers, pointersOverlap } = pinApi;
    const res = searchPromptContext(dir, prompt, opts);
    const isEdit = !opts.forceReadOnly && (res?.isEditPrompt ?? detectPromptIntent(prompt, opts).editEnvelope);
    let pins = [], rawPins = [], graph = null, ctxDir = null;
    try {
        const root = nearestPlexerRoot(dir)?.root ?? dir;
        ctxDir = contextDirFor(root);
        graph = loadGraphCached(ctxDir);
        const rankedHits = res?.hits ?? [];
        const hintFiles = res?.allFiles ?? [...new Set(rankedHits.map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean))];
        rawPins = (isEdit && HOOK_BUDGETS.pinMax > 0)
            ? pinnedHits(root, graph, prompt, { budgetBytes: HOOK_BUDGETS.pinBytes, maxPins: HOOK_BUDGETS.pinMax, hintFiles })
            : [];
        for (const p of rawPins) {
            if (isPinCoveredByRankedHits(p, rankedHits, pointerCovers)) continue;
            inheritRankedHitEnrichments(p, rankedHits, pointersOverlap);
            pins.push(p);
        }
    } catch { pins = []; }
    if (!pins.length) {
        if (isEdit && res?.hits?.length && graph) {
            const coEditPointers = computeCoEditPointers(ctxDir, graph, res.hits);
            if (coEditPointers.length > 0) res.coEditPointers = coEditPointers;
        }
        return res;
    }
    const rest = (res?.hits ?? []).filter((h) => !pins.some((p) => pointerCovers(p.pointer, h.pointer)));
    trimRestHitCodeToBudget(rest, pins, rawPins, { pointerCovers, pointersOverlap });
    const pinnedRestCount = rest.filter((h) => h.pinned).length;
    const pinnedFiles = new Set([...pins, ...rest.filter((h) => h.pinned)].map((p) => (p.pointer ?? '').split(':')[0]).filter(Boolean));
    const novelRest = rest.filter((h) => h.pinned || !pinnedFiles.has((h.pointer ?? '').split(':')[0]));
    const keptRest = ((pins.length + pinnedRestCount) >= 3 && !rest.some((h) => !h.pinned && h.code))
        ? novelRest.slice(0, 2 + pinnedRestCount)
        : rest;
    const finalHits = [...pins, ...keptRest];
    const coEditPointers = isEdit && graph ? computeCoEditPointers(ctxDir, graph, finalHits) : [];
    return {
        ...(res ?? { query: prompt, mode: 'lexical', isEditPrompt: isEdit }),
        hits: finalHits,
        ...(coEditPointers.length > 0 ? { coEditPointers } : {}),
    };
}
