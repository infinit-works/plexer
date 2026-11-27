import { cleanPromptBoilerplate } from './intent.js';

export const HOOK_BUDGETS = {
    qaSingleHitBytes: 2000, qaMultiHitBytes: 2000, qaMergedBytes: 2600, qaMaxInlined: 3,
    editSingleHitBytes: 1800, editMultiHitBytes: 1400, editMergedBytes: 2000, editMaxInlined: 3,
    singleQueryInline: 2, multiQueryInline: 1, pinBytes: 1500, pinMax: 3, editTotalBytes: 2100,
    qaMultiSubsystemMergedBytes: 1800,
};

export const CLAUDE_NARROW_HOOK_BUDGETS = {
    qaSingleHitBytes: 1600, qaMultiHitBytes: 1600, qaMergedBytes: 2200, qaMaxInlined: 2,
    editSingleHitBytes: 1400, editMultiHitBytes: 1200, editMergedBytes: 1600, editMaxInlined: 2,
    singleQueryInline: 2, multiQueryInline: 1, pinBytes: 1300, pinMax: 2, editTotalBytes: 1700,
    qaMultiSubsystemMergedBytes: 1500,
};

export const CLAUDE_MULTI_FILE_EDIT_BUDGETS = { ...HOOK_BUDGETS };

export const GEMINI_NARROW_HOOK_BUDGETS = {
    qaSingleHitBytes: 2200, qaMultiHitBytes: 2000, qaMergedBytes: 3400, qaMaxInlined: 3,
    editSingleHitBytes: 2000, editMultiHitBytes: 1600, editMergedBytes: 2800, editMaxInlined: 2,
    singleQueryInline: 2, multiQueryInline: 1, pinBytes: 2400, pinMax: 2, editTotalBytes: 3000,
    qaMultiSubsystemMergedBytes: 2600,
};

export const FAST_GEMINI_HOOK_BUDGETS = {
    qaSingleHitBytes: 2600, qaMultiHitBytes: 2200, qaMergedBytes: 4200, qaMaxInlined: 3,
    editSingleHitBytes: 2400, editMultiHitBytes: 1800, editMergedBytes: 3400, editMaxInlined: 3,
    singleQueryInline: 2, multiQueryInline: 2, pinBytes: 2800, pinMax: 3, editTotalBytes: 3800,
    qaMultiSubsystemMergedBytes: 3000,
};

export const GEMINI_HOOK_BUDGETS = {
    qaSingleHitBytes: 3400, qaMultiHitBytes: 3000, qaMergedBytes: 5600, qaMaxInlined: 4,
    editSingleHitBytes: 3200, editMultiHitBytes: 2400, editMergedBytes: 4600, editMaxInlined: 3,
    singleQueryInline: 3, multiQueryInline: 2, pinBytes: 4400, pinMax: 3, editTotalBytes: 5000,
    qaMultiSubsystemMergedBytes: 3800,
};

export const XHIGH_GEMINI_HOOK_BUDGETS = {
    qaSingleHitBytes: 3600, qaMultiHitBytes: 3200, qaMergedBytes: 5800, qaMaxInlined: 4,
    editSingleHitBytes: 3400, editMultiHitBytes: 2600, editMergedBytes: 5000, editMaxInlined: 3,
    singleQueryInline: 3, multiQueryInline: 2, pinBytes: 4600, pinMax: 3, editTotalBytes: 5400,
    qaMultiSubsystemMergedBytes: 4000,
};

export function isFastGeminiModelProfile(input) {
    const m = String(input?.modelName ?? input?.model ?? input?.agentModel ?? '').trim().toLowerCase();
    if (!m || /orchestrator|neon|\bpro\b|carbon|claude|sonnet|opus|haiku|gpt-/.test(m)) return false;
    return /(?:hydrogen|flash|-lite\b)/.test(m);
}

const NARROW_PROMPT_FILE_RE = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:py|go|js|ts|tsx|jsx|mjs|cjs|luau|lua|rs|c|cc|cpp|h|hpp|java|rb|php|cs|swift|kt|scala|sh|json|toml|yaml|yml|md)\b/g;

export function isNarrowPrompt(prompt) {
    const text = cleanPromptBoilerplate(prompt).trim();
    if (!text) return false;
    if (/\b(?:all|every|across|callers?|who\s+calls|blast|rename|refactor|replace|migrate|propagat)\b/i.test(text)) return false;
    if (text.length <= 280) return true;
    if (text.length > 520) return false;
    if (/(?:^|\n)\s*(?:\d+\.|[-*])\s+[\s\S]*\n\s*(?:\d+\.|[-*])\s+/.test(text)) return false;
    const files = new Set(text.match(NARROW_PROMPT_FILE_RE) ?? []);
    return files.size <= 1;
}

export function isExtraHighEffortInput(input) {
    const m = String(input?.modelName ?? input?.model ?? input?.agentModel ?? '').trim().toLowerCase();
    const eff = String(input?.effort ?? '').trim().toLowerCase();
    return eff === 'xhigh' || eff === 'extra' || /(?:^|[-_\s(])(?:xhigh|extra)(?:$|[)\s_-])/.test(m);
}

export function isHighOrExtraHighEffortInput(input) {
    if (isExtraHighEffortInput(input)) return true;
    const m = String(input?.modelName ?? input?.model ?? input?.agentModel ?? '').trim().toLowerCase();
    const eff = String(input?.effort ?? '').trim().toLowerCase();
    return eff === 'high' || /(?:^|[-_\s(])high(?:$|[)\s_-])/.test(m);
}

export function resolveHookBudgets(opts = {}) {
    if (opts?.geminiProfile) {
        if (opts?.narrowPrompt) return GEMINI_NARROW_HOOK_BUDGETS;
        if (opts?.xhighProfile) return XHIGH_GEMINI_HOOK_BUDGETS;
        if (opts?.fastProfile) return FAST_GEMINI_HOOK_BUDGETS;
        return GEMINI_HOOK_BUDGETS;
    }
    if (opts?.narrowPrompt) return CLAUDE_NARROW_HOOK_BUDGETS;
    return opts?.multiFileEdit ? CLAUDE_MULTI_FILE_EDIT_BUDGETS : HOOK_BUDGETS;
}

export function isGeminiModelProfile(input, hostKind = 'claude') {
    if (hostKind === 'gemini') return true;
    const m = String(input?.modelName ?? input?.model ?? input?.agentModel ?? '').trim().toLowerCase();
    if (/claude|sonnet|opus|haiku|gpt-|o1-|o3-|o4-|codex/.test(m)) return false;
    if (/gemini|orchestrator|neon|hydrogen|carbon|flash|gemma|^pro\b|-pro\b|^auto$/.test(m)) return true;
    return hostKind === 'agy' && !m;
}

export function isOrchestratorInput(input, agyState = null) {
    const m = String(input?.modelName ?? input?.model ?? input?.agentModel ?? '').trim().toLowerCase();
    if (/orchestrator/.test(m)) return true;
    return Boolean(agyState?.isOrchestratorModel);
}

export function mergeMultiQueryHits(results, editEnvelope, opts = {}) {
    const mergedSeen = new Set();
    const mergedSymbolTitles = new Set();
    const mergedFileCounts = new Map();
    const mergedHits = [];
    const minDistinctTarget = 4;
    const pushHit = (h, rank, maxPerFile = 2) => {
        if (!h || mergedSeen.has(h.pointer)) return false;
        const fileKey = (h.pointer || '').split(':')[0];
        const titleKey = `${fileKey}:${h.title ?? ''}`;
        if (rank > 0 && h.title && mergedSymbolTitles.has(titleKey)) return false;
        if (editEnvelope && fileKey && (mergedFileCounts.get(fileKey) ?? 0) >= maxPerFile && mergedHits.length < minDistinctTarget) return false;
        mergedSeen.add(h.pointer);
        if (h.title) mergedSymbolTitles.add(titleKey);
        if (fileKey) mergedFileCounts.set(fileKey, (mergedFileCounts.get(fileKey) ?? 0) + 1);
        mergedHits.push(h);
        return true;
    };
    for (const r of results) if (!pushHit(r?.hits?.[0], 0, 1) && editEnvelope) pushHit(r?.hits?.[1], 1, 1);
    if (editEnvelope) {
        for (let rank = 1; rank < 3; rank++) for (const r of results) pushHit(r?.hits?.[rank], rank, 1);
        for (const r of results) if (r?.hits?.[0]?.code) pushHit(r.hits[0], 0, 2);
    } else {
        for (const r of results) if (r?.hits?.[0]?.code) pushHit(r.hits[0], 0, 2);
        for (let rank = 1; rank < 3; rank++) for (const r of results) pushHit(r?.hits?.[rank], rank, 1);
    }
    if (mergedHits.length < minDistinctTarget) for (let rank = 0; rank < 3; rank++) for (const r of results) pushHit(r?.hits?.[rank], rank, 2);
    if (mergedHits.length < minDistinctTarget) {
        for (let rank = 0; rank < 3; rank++) {
            for (const r of results) {
                const h = r?.hits?.[rank];
                if (h && !mergedSeen.has(h.pointer)) { mergedSeen.add(h.pointer); mergedHits.push(h); }
            }
        }
    }
    return mergedHits;
}

export function dedupPreviousHitHelpers(mergedHits, idx, h) {
    const prevBlocks = new Set();
    for (let pIdx = 0; pIdx < idx; pIdx++) {
        const pc = mergedHits[pIdx]?.code;
        if (!pc) continue;
        for (const seg of pc.split('\n\n// ').slice(1)) {
            const hdr = seg.split('\n')[0];
            if (hdr) prevBlocks.add(hdr);
        }
    }
    if (prevBlocks.size > 0 && h.code.includes('\n\n// ')) {
        const parts = h.code.split('\n\n// ');
        h.code = [parts[0], ...parts.slice(1).filter((seg) => !prevBlocks.has(seg.split('\n')[0])).map((seg) => `// ${seg}`)].join('\n\n');
    }
    if (mergedHits.slice(0, idx).some((oh) => oh.code && oh.pointer?.split(':')[0] === h.pointer?.split(':')[0])) {
        const dupFooterIdx = h.code.indexOf('\n// other symbols in ');
        if (dupFooterIdx > 0) h.code = h.code.slice(0, dupFooterIdx);
    }
}

function trimHelperBlocksToFit(code, baseBytes, maxMergedBytes) {
    let cur = code;
    while (cur.includes('\n\n// ') && baseBytes + Buffer.byteLength(cur, 'utf8') > maxMergedBytes) {
        cur = cur.slice(0, cur.lastIndexOf('\n\n// '));
    }
    return cur;
}

function rebalanceFirstTwoHitHelpers(mergedHits, h, inlinedBytes, maxMergedBytes) {
    let prevCode = mergedHits[0].code;
    const firstPrevIdx = prevCode.indexOf('\n\n// ');
    const secondPrevIdx = firstPrevIdx > 0 ? prevCode.indexOf('\n\n// ', firstPrevIdx + 6) : -1;
    const hFirstIdx = h.code.indexOf('\n\n// ');
    const hSecondIdx = hFirstIdx > 0 ? h.code.indexOf('\n\n// ', hFirstIdx + 6) : -1;
    const thirdIdx = hSecondIdx > 0 ? h.code.indexOf('\n\n// ', hSecondIdx + 6) : -1;
    let cand = thirdIdx > 0 ? h.code.slice(0, thirdIdx) : h.code;
    const prevOrigLen = Buffer.byteLength(mergedHits[0].code, 'utf8');
    const fitsWithPrev = (p, c) => inlinedBytes - prevOrigLen + Buffer.byteLength(p, 'utf8') + Buffer.byteLength(c, 'utf8') <= maxMergedBytes;
    while (prevCode.includes('\n\n// ') && prevCode.lastIndexOf('\n\n// ') > firstPrevIdx && !fitsWithPrev(prevCode, cand)) {
        prevCode = prevCode.slice(0, prevCode.lastIndexOf('\n\n// '));
    }
    cand = trimHelperBlocksToFit(cand, inlinedBytes - prevOrigLen + Buffer.byteLength(prevCode, 'utf8'), maxMergedBytes);
    const losingHelpers = (cand.split('\n\n// ').length - 1) < (h.code.split('\n\n// ').length - 1)
        || ((h.code.split('\n\n// ').length - 1) >= 3 && (cand.split('\n\n// ').length - 1) === 2);
    if (losingHelpers && secondPrevIdx === -1 && firstPrevIdx > 0
        && mergedHits[0].pointer?.split(':')[0] === h.pointer?.split(':')[0]
        && Buffer.byteLength(prevCode.slice(0, firstPrevIdx), 'utf8') >= 1550) {
        const prevNoHelper = prevCode.slice(0, firstPrevIdx);
        const fullCand = trimHelperBlocksToFit(h.code, inlinedBytes - prevOrigLen + Buffer.byteLength(prevNoHelper, 'utf8'), maxMergedBytes);
        if ((fullCand.split('\n\n// ').length - 1) >= (cand.split('\n\n// ').length - 1)
            && Buffer.byteLength(fullCand, 'utf8') > Buffer.byteLength(cand, 'utf8')) {
            prevCode = prevNoHelper; cand = fullCand;
        }
    }
    const newTotal = inlinedBytes - prevOrigLen + Buffer.byteLength(prevCode, 'utf8') + Buffer.byteLength(cand, 'utf8');
    if (newTotal <= maxMergedBytes && cand.includes('\n\n// ')) {
        mergedHits[0].code = prevCode; h.code = cand; return newTotal;
    }
    return null;
}

function reclaimPrevHitHelpersForCandidate(mergedHits, idx, h, inlinedBytes, maxMergedBytes) {
    let candidateCode = h.code;
    if (candidateCode.includes('\n\n// ') && inlinedBytes + Buffer.byteLength(candidateCode, 'utf8') > maxMergedBytes) {
        candidateCode = candidateCode.slice(0, candidateCode.indexOf('\n\n// '));
    }
    for (let pIdx = idx - 1; pIdx >= 0; pIdx--) {
        const prev = mergedHits[pIdx];
        if (!prev?.code?.includes('\n\n// ')) continue;
        const origLen = Buffer.byteLength(prev.code, 'utf8');
        const prevCode = trimHelperBlocksToFit(prev.code, inlinedBytes - origLen + Buffer.byteLength(candidateCode, 'utf8'), maxMergedBytes);
        const delta = origLen - Buffer.byteLength(prevCode, 'utf8');
        if (delta > 0) { prev.code = prevCode; inlinedBytes -= delta; }
        if (inlinedBytes + Buffer.byteLength(candidateCode, 'utf8') <= maxMergedBytes) break;
    }
    const cb = Buffer.byteLength(candidateCode, 'utf8');
    if (inlinedBytes + cb <= maxMergedBytes) { h.code = candidateCode; return inlinedBytes + cb; }
    return null;
}

export function trimFirstHitHelpersForNext(h, mergedHits, maxMergedBytes) {
    const nextCodeHit = mergedHits.find((oh, oIdx) => oIdx > 0 && oh.code);
    if (!nextCodeHit || !h.code.includes('\n\n// ')) return;
    const nextHelperIdx = nextCodeHit.code.indexOf('\n\n// ');
    const nextPrimaryLen = nextHelperIdx > 0 ? Buffer.byteLength(nextCodeHit.code.slice(0, nextHelperIdx), 'utf8') : Buffer.byteLength(nextCodeHit.code, 'utf8');
    const sameFileAsNext = h.pointer?.split(':')[0] === nextCodeHit.pointer?.split(':')[0];
    if (Buffer.byteLength(h.code, 'utf8') + nextPrimaryLen <= maxMergedBytes
        && !((h.code.split('\n\n// ').length - 1 >= 2 || (sameFileAsNext && nextCodeHit.code.split('\n\n// ').length - 1 >= 2))
            && Buffer.byteLength(h.code, 'utf8') + Buffer.byteLength(nextCodeHit.code, 'utf8') > maxMergedBytes)) return;
    const otherSymsIdx = h.code.indexOf('\n// other symbols in ');
    const trailingFooter = otherSymsIdx > 0 ? h.code.slice(otherSymsIdx) : '';
    if (otherSymsIdx > 0) h.code = h.code.slice(0, otherSymsIdx);
    const firstSplit = h.code.indexOf('\n\n// ');
    if (firstSplit > 0) {
        const hadThree = h.code.split('\n\n// ').slice(1).filter((s) => !s.startsWith('module return ')).length >= 3;
        const nextLen = Buffer.byteLength(nextCodeHit.code, 'utf8');
        while (h.code.includes('\n\n// ') && h.code.lastIndexOf('\n\n// ') > firstSplit && Buffer.byteLength(h.code, 'utf8') + nextLen > maxMergedBytes) {
            h.code = h.code.slice(0, h.code.lastIndexOf('\n\n// '));
        }
        if ((Buffer.byteLength(h.code, 'utf8') + nextPrimaryLen > maxMergedBytes
            || (!hadThree && Buffer.byteLength(h.code, 'utf8') + nextLen > maxMergedBytes))
            && Buffer.byteLength(h.code, 'utf8') < 3200) h.code = h.code.slice(0, firstSplit);
    }
    if (trailingFooter && !h.code.includes('\n// other symbols in ')) h.code += trailingFooter;
}

function tryInlineTrimmedOrReclaimedHit(mergedHits, idx, h, inlinedBytes, maxMergedBytes) {
    if (h.code.includes('\n\n// ')) {
        if (idx === 1 && mergedHits[0]?.code?.includes('\n\n// ')) {
            const rebalanced = rebalanceFirstTwoHitHelpers(mergedHits, h, inlinedBytes, maxMergedBytes);
            if (rebalanced !== null) return rebalanced;
        }
        const trimmed = trimHelperBlocksToFit(h.code, inlinedBytes, maxMergedBytes);
        const tb = Buffer.byteLength(trimmed, 'utf8');
        if (inlinedBytes + tb <= maxMergedBytes) { h.code = trimmed; return inlinedBytes + tb; }
    }
    if (idx > 0 && h.kind !== 'file' && !h.title?.endsWith(' · file')
        && !mergedHits.slice(0, idx).some((oh) => oh.code && oh.pointer?.split(':')[0] === h.pointer?.split(':')[0])) {
        return reclaimPrevHitHelpersForCandidate(mergedHits, idx, h, inlinedBytes, maxMergedBytes);
    }
    return null;
}

export function countHitSubsystemDirs(hits, limit = 5) {
    const dirs = new Set();
    for (const h of (hits ?? []).slice(0, limit)) {
        const file = String(h?.pointer ?? '').split(':')[0].replace(/\\/g, '/');
        if (!file) continue;
        const slash = file.lastIndexOf('/');
        dirs.add(slash > 0 ? file.slice(0, slash) : '.');
    }
    return dirs.size;
}

export function enforceMergedHitsBudget(mergedHits, intent, queryCount, budgets = HOOK_BUDGETS) {
    const activeBudgets = budgets ?? HOOK_BUDGETS;
    const isGemini = activeBudgets === GEMINI_HOOK_BUDGETS
        || activeBudgets === XHIGH_GEMINI_HOOK_BUDGETS
        || activeBudgets === FAST_GEMINI_HOOK_BUDGETS
        || activeBudgets === GEMINI_NARROW_HOOK_BUDGETS;
    const isMultiSubsystemQa = !intent.editEnvelope && countHitSubsystemDirs(mergedHits) >= 3;
    const geminiCallSiteCap = activeBudgets === FAST_GEMINI_HOOK_BUDGETS
        ? 4200
        : (activeBudgets === GEMINI_NARROW_HOOK_BUDGETS ? 3400 : 5200);
    const maxMergedBytes = intent.editEnvelope
        ? (isGemini ? activeBudgets.editMergedBytes : (queryCount >= 3 ? Math.min(activeBudgets.editMergedBytes, 2400) : activeBudgets.editMergedBytes))
        : (isMultiSubsystemQa
            ? Math.min(activeBudgets.qaMergedBytes, activeBudgets.qaMultiSubsystemMergedBytes ?? 2200)
            : (intent.wantsCallSites ? Math.min(activeBudgets.qaMergedBytes, isGemini ? geminiCallSiteCap : 3600) : activeBudgets.qaMergedBytes));
    const maxInlinedHits = intent.editEnvelope ? activeBudgets.editMaxInlined : activeBudgets.qaMaxInlined;
    let inlinedBytes = 0, inlinedCount = 0;
    const inlinedFiles = new Set();
    for (let idx = 0; idx < mergedHits.length; idx++) {
        const h = mergedHits[idx];
        if (idx > 0 && h.wantsCallSites && (h.callSites?.length ?? 0) > 10) h.wantsCallSites = false;
        if (!h.code) continue;
        if (idx > 0) dedupPreviousHitHelpers(mergedHits, idx, h);
        if (idx === 0 && Buffer.byteLength(h.code, 'utf8') < 3800 && mergedHits.some((oh, oIdx) => oIdx > 0 && oh.code)) {
            trimFirstHitHelpersForNext(h, mergedHits, maxMergedBytes);
        }
        const fileKey = String(h.pointer ?? '').split(':')[0];
        const hasUnseenLaterFile = Boolean(
            !isGemini
            && intent.editEnvelope
            && fileKey
            && inlinedFiles.has(fileKey)
            && mergedHits.slice(idx + 1).some((oh) => {
                const of = String(oh?.pointer ?? '').split(':')[0];
                return oh?.code && of && !inlinedFiles.has(of);
            }),
        );
        const effMergedCap = hasUnseenLaterFile ? Math.max(0, maxMergedBytes - Math.min(900, Math.floor(maxMergedBytes * 0.45))) : maxMergedBytes;
        const b = Buffer.byteLength(h.code, 'utf8');
        if (inlinedCount < maxInlinedHits && (inlinedCount === 0 || inlinedBytes + b <= effMergedCap)) {
            inlinedBytes += b; inlinedCount++;
            if (fileKey) inlinedFiles.add(fileKey);
            continue;
        }
        const nextTotal = inlinedCount < maxInlinedHits
            ? tryInlineTrimmedOrReclaimedHit(mergedHits, idx, h, inlinedBytes, effMergedCap) : null;
        if (nextTotal !== null) {
            inlinedBytes = nextTotal; inlinedCount++;
            if (fileKey) inlinedFiles.add(fileKey);
            continue;
        }
        const oldFooter = h.code.match(/\n\/\/ other symbols in [^\n]+:\s*(.+)$/);
        if (oldFooter && !h.otherSymbols) h.otherSymbols = oldFooter[1];
        delete h.code;
    }
}
