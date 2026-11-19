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

const SECTION_HDR_PAREN_RE = /^\/\/ (?:same-file (?:helper|caller)|cross-file (?:callee|caller)|exported type): .+ \(([^():]+):L?\d+/;
const SECTION_HDR_MOD_RE = /^\/\/ module (?:context|return) \(([^():]+)(?::L?\d+[^)]*)?\):/;
const SECTION_HDR_IN_RE = /^\/\/ (?:caller|delegator|constructor) in ([^:\s]+):L?\d+/;
const RETRIEVAL_HIT_HDR_RE = /^\s*\d+\.\s+.*?:\s*([^\s:]+):L\d+/;

function matchSectionHeaderFile(line) {
    const m = SECTION_HDR_PAREN_RE.exec(line)
        ?? SECTION_HDR_MOD_RE.exec(line)
        ?? SECTION_HDR_IN_RE.exec(line);
    return m?.[1] ? normalizeRelFile(m[1]) : null;
}

/**
 * Extract contiguous per-file line runs from an inlined retrieval `code` block
 * without bridging omitted crux gaps or mixing cross-file callee sections.
 */
export function extractInlinedSpansByFile(code, primaryFile = '') {
    if (!code || typeof code !== 'string')
        return [];
    const defaultFile = normalizeRelFile(primaryFile);
    let currentFile = defaultFile;
    let activeRun = null;
    const runs = [];
    const flushRun = () => {
        if (activeRun && activeRun.file)
            runs.push(activeRun);
        activeRun = null;
    };

    for (const line of code.split(/\r?\n/)) {
        const hdrFile = matchSectionHeaderFile(line);
        if (hdrFile) {
            flushRun();
            currentFile = hdrFile;
            continue;
        }
        const lm = /^L(\d+):/.exec(line);
        if (lm) {
            const ln = Number(lm[1]);
            if (activeRun && activeRun.file === currentFile && ln >= activeRun.start && ln <= activeRun.end + 1) {
                if (ln > activeRun.end)
                    activeRun.end = ln;
            }
            else {
                flushRun();
                if (currentFile)
                    activeRun = { file: currentFile, start: ln, end: ln };
            }
            continue;
        }
        // Never bridge crux gaps (`… (N lines omitted)`) or blank separators into one contiguous span.
        flushRun();
    }
    flushRun();
    return runs;
}

function prefixSpanKey(file, relPrefix = '') {
    if (!relPrefix || file.startsWith(relPrefix))
        return file;
    return `${relPrefix}${file}`;
}

/**
 * Record contiguous per-file line spans for all hits with inlined code in an ask/retrieval result.
 */
export function recordRetrievalSpans(seenSpans, askResult, relPrefix = '') {
    if (!seenSpans || !askResult || !Array.isArray(askResult.hits))
        return;
    for (const h of askResult.hits) {
        if (!h?.code)
            continue;
        const parsed = parsePointerSpan(h.pointer);
        const primaryFile = parsed?.file || '';
        const runs = extractInlinedSpansByFile(h.code, primaryFile);
        if (runs.length > 0) {
            for (const r of runs) {
                mergeSpan(seenSpans, prefixSpanKey(r.file, relPrefix), r.start, r.end);
            }
        }
        else if (parsed) {
            mergeSpan(seenSpans, prefixSpanKey(parsed.file, relPrefix), parsed.start, parsed.end);
        }
    }
}

/**
 * Record contiguous per-file `L<n>:` line spans actually present inside rendered retrieval
 * code blocks so spans dropped by budget fitting never mark files as already seen.
 */
export function recordEmittedRetrievalTextSpans(seenSpans, renderedText, relPrefix = '') {
    if (!seenSpans || !renderedText || typeof renderedText !== 'string')
        return;
    let currentHitFile = '';
    let inFence = false;
    let codeBuf = [];
    const flushFence = () => {
        if (!currentHitFile || codeBuf.length === 0) {
            codeBuf = [];
            return;
        }
        const runs = extractInlinedSpansByFile(codeBuf.join('\n'), currentHitFile);
        for (const r of runs) {
            mergeSpan(seenSpans, prefixSpanKey(r.file, relPrefix), r.start, r.end);
        }
        codeBuf = [];
    };
    for (const line of renderedText.split(/\r?\n/)) {
        const hitMatch = !inFence ? RETRIEVAL_HIT_HDR_RE.exec(line) : null;
        if (hitMatch?.[1]) {
            currentHitFile = normalizeRelFile(hitMatch[1]);
            continue;
        }
        if (/^```/.test(line)) {
            if (inFence) {
                flushFence();
                inFence = false;
            }
            else if (currentHitFile) {
                inFence = true;
                codeBuf = [];
            }
            continue;
        }
        if (inFence) {
            codeBuf.push(line);
        }
        else if (!/^\s/.test(line) && line.trim() !== '') {
            currentHitFile = '';
        }
    }
    if (inFence)
        flushFence();
}

function isIntervalsCoveringLineSet(intervals, lineSet) {
    if (!Array.isArray(intervals) || intervals.length === 0 || lineSet.size === 0)
        return false;
    let covered = 0;
    for (const ln of lineSet) {
        for (const [is, ie] of intervals) {
            if (ie < ln)
                continue;
            if (is > ln)
                break;
            covered += 1;
            break;
        }
    }
    return covered / lineSet.size >= 0.85;
}

/**
 * Replace already-seen inlined hit code with a compact pointer placeholder when
 * >= 85% of unique inlined lines for every referenced file are already covered.
 * Returns { ask, dedupedCount }.
 */
export function applySeenSpansFilter(askResult, seenSpans, relPrefix = '') {
    if (!askResult || !Array.isArray(askResult.hits) || !seenSpans)
        return { ask: askResult, dedupedCount: 0 };

    let dedupedCount = 0;
    const hits = askResult.hits.map((h) => {
        if (!h?.code || h.alreadySeen)
            return h;
        const parsed = parsePointerSpan(h.pointer);
        if (!parsed)
            return h;
        const runs = extractInlinedSpansByFile(h.code, parsed.file);
        if (runs.length === 0)
            return h;
        const linesByFile = new Map();
        for (const r of runs) {
            let set = linesByFile.get(r.file);
            if (!set) {
                set = new Set();
                linesByFile.set(r.file, set);
            }
            for (let ln = r.start; ln <= r.end; ln++)
                set.add(ln);
        }
        let allCovered = true;
        for (const [file, lineSet] of linesByFile) {
            const prefixed = prefixSpanKey(file, relPrefix);
            const cov = isIntervalsCoveringLineSet(seenSpans[file], lineSet)
                || (prefixed !== file && isIntervalsCoveringLineSet(seenSpans[prefixed], lineSet));
            if (!cov) {
                allCovered = false;
                break;
            }
        }
        if (!allCovered)
            return h;
        const primaryRuns = runs.filter((r) => r.file === parsed.file);
        const spanStart = primaryRuns.length > 0 ? primaryRuns[0].start : runs[0].start;
        const spanEnd = primaryRuns.length > 0 ? primaryRuns[primaryRuns.length - 1].end : runs[runs.length - 1].end;
        dedupedCount += 1;
        const ptr = `${parsed.file}:L${spanStart}-L${spanEnd}`;
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
 * Invalidate or truncate `seenSpans` entries for `relFile` at or after `firstChangedLine`
 * after an edit so post-edit reads and `[plan review]` handoffs are never marked seen.
 */
export function invalidateEditedSpans(seenSpans, relFile, firstChangedLine = 1) {
    if (!seenSpans || typeof seenSpans !== 'object' || !relFile)
        return false;
    const normTarget = normalizeRelFile(relFile);
    if (!normTarget)
        return false;
    const cutoff = Number.isFinite(Number(firstChangedLine)) ? Math.floor(Number(firstChangedLine)) : 1;
    let changed = false;
    for (const key of Object.keys(seenSpans)) {
        const normKey = normalizeRelFile(key);
        const matches = normKey === normTarget
            || normKey.endsWith(`/${normTarget}`)
            || normTarget.endsWith(`/${normKey}`);
        if (!matches)
            continue;
        changed = true;
        if (cutoff <= 1) {
            delete seenSpans[key];
            continue;
        }
        const prev = Array.isArray(seenSpans[key]) ? seenSpans[key] : [];
        const kept = [];
        for (const pair of prev) {
            if (!Array.isArray(pair) || pair.length < 2)
                continue;
            const s = Number(pair[0]);
            const e = Number(pair[1]);
            if (s < cutoff)
                kept.push([s, Math.min(e, cutoff - 1)]);
        }
        if (kept.length > 0)
            seenSpans[key] = kept;
        else
            delete seenSpans[key];
    }
    return changed;
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
