/**
 * Session-level line-span tracking and compaction reset detection for Antigravity hooks.
 */

const MAX_SEEN_FILES = 60;
const MAX_INTERVALS_PER_FILE = 16;

export function normalizeRelFile(p) {
    if (!p || typeof p !== 'string')
        return '';
    return p
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
}

/**
 * Parse a pointer like "src/ask/ask.js:L10-L45" or "src/ask/ask.js:10-45" or "src/ask/ask.js:L10".
 */
export function parsePointerSpan(ptr) {
    if (!ptr || typeof ptr !== 'string')
        return null;
    const head = ptr.split(',')[0].trim();
    const m = /^(.+?):L?(\d+)(?:-L?(\d+))?$/.exec(head);
    if (!m)
        return null;
    const file = normalizeRelFile(m[1]);
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    if (!file || !Number.isFinite(start) || !Number.isFinite(end) || start < 1)
        return null;
    return { file, start, end: Math.max(start, end) };
}

/**
 * Merge a [startLine, endLine] interval into `seenSpans` for `relFile`, keeping intervals
 * sorted, coalesced (adjacent intervals merged), and bounded via LRU eviction.
 */
export function mergeSpan(seenSpans, relFile, startLine, endLine) {
    const file = normalizeRelFile(relFile);
    const s = Math.max(1, Math.floor(Number(startLine) || 0));
    const e = Math.max(s, Math.floor(Number(endLine) || 0));
    if (!file || !Number.isFinite(s) || !Number.isFinite(e) || s < 1 || !seenSpans || typeof seenSpans !== 'object')
        return;

    const existing = Array.isArray(seenSpans[file]) ? [...seenSpans[file]] : [];
    // Refresh insertion order for LRU eviction.
    if (file in seenSpans)
        delete seenSpans[file];

    existing.push([s, e]);
    existing.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const merged = [];
    for (const [cs, ce] of existing) {
        if (merged.length === 0) {
            merged.push([cs, ce]);
            continue;
        }
        const prev = merged[merged.length - 1];
        if (cs <= prev[1] + 1) {
            if (ce > prev[1])
                prev[1] = ce;
        }
        else {
            merged.push([cs, ce]);
        }
    }

    // Cap per-file interval list while preserving widest recent spans.
    while (merged.length > MAX_INTERVALS_PER_FILE)
        merged.shift();

    seenSpans[file] = merged;

    const keys = Object.keys(seenSpans);
    if (keys.length > MAX_SEEN_FILES) {
        for (let i = 0; i < keys.length - MAX_SEEN_FILES; i++) {
            delete seenSpans[keys[i]];
        }
    }
}

/**
 * Return true when >= 85% of [startLine, endLine] in `relFile` is already covered by `seenSpans`.
 */
export function isSpanCovered(seenSpans, relFile, startLine, endLine, threshold = 0.85) {
    const file = normalizeRelFile(relFile);
    const s = Math.max(1, Math.floor(Number(startLine) || 0));
    const e = Math.max(s, Math.floor(Number(endLine) || 0));
    const intervals = seenSpans?.[file];
    if (!Array.isArray(intervals) || intervals.length === 0)
        return false;

    const total = e - s + 1;
    let covered = 0;
    for (const [is, ie] of intervals) {
        if (ie < s)
            continue;
        if (is > e)
            break;
        covered += Math.min(e, ie) - Math.max(s, is) + 1;
    }
    return covered / total >= threshold;
}

function extractInlinedLineRange(code) {
    if (!code || typeof code !== 'string')
        return null;
    let min = Infinity;
    let max = 0;
    const re = /^L(\d+):/gm;
    let m;
    while ((m = re.exec(code)) !== null) {
        const ln = Number(m[1]);
        if (ln < min)
            min = ln;
        if (ln > max)
            max = ln;
    }
    return min <= max ? { start: min, end: max } : null;
}

/**
 * Record line spans for all hits with inlined code in an ask/retrieval result.
 */
export function recordRetrievalSpans(seenSpans, askResult) {
    if (!seenSpans || !askResult || !Array.isArray(askResult.hits))
        return;
    for (const h of askResult.hits) {
        if (!h?.code)
            continue;
        const parsed = parsePointerSpan(h.pointer);
        if (!parsed)
            continue;
        const range = extractInlinedLineRange(h.code);
        mergeSpan(seenSpans, parsed.file, range ? range.start : parsed.start, range ? range.end : parsed.end);
    }
}

/**
 * Replace already-seen inlined hit code with a compact pointer placeholder.
 * Returns { ask, dedupedCount }.
 */
export function applySeenSpansFilter(askResult, seenSpans) {
    if (!askResult || !Array.isArray(askResult.hits) || !seenSpans)
        return { ask: askResult, dedupedCount: 0 };

    let dedupedCount = 0;
    const hits = askResult.hits.map((h) => {
        if (!h?.code)
            return h;
        const parsed = parsePointerSpan(h.pointer);
        if (!parsed)
            return h;
        const range = extractInlinedLineRange(h.code);
        const start = range ? range.start : parsed.start;
        const end = range ? range.end : parsed.end;
        if (!isSpanCovered(seenSpans, parsed.file, start, end))
            return h;
        dedupedCount += 1;
        const ptr = `${parsed.file}:L${start}-L${end}`;
        return {
            ...h,
            code: `// [already in session context: ${ptr}]`,
            alreadySeen: true,
        };
    });

    if (dedupedCount === 0)
        return { ask: askResult, dedupedCount: 0 };
    return { ask: { ...askResult, hits }, dedupedCount };
}

/**
 * Reset trajectory-scoped session caches when Antigravity `/compact` drops `initialNumSteps`.
 */
export function detectCompactionReset(agyState, input) {
    if (!agyState || typeof agyState !== 'object')
        return false;
    const cur = input?.initialNumSteps;
    if (typeof cur !== 'number' || !Number.isFinite(cur))
        return false;
    const prev = agyState.lastInitialNumSteps;
    const compacted = typeof prev === 'number' && Number.isFinite(prev) && cur < prev;
    if (compacted) {
        agyState.seenSpans = {};
        agyState.injectedPointers = [];
        agyState.midLoopHintEmitted = false;
        agyState.pendingMidLoopFile = null;
        agyState.fileSliceCounts = {};
        agyState.nudges = 0;
        agyState.orientedDirs = [];
    }
    agyState.lastInitialNumSteps = cur;
    return compacted;
}
