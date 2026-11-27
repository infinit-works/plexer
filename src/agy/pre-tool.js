/**
 * Antigravity PreToolUse non-disruptive `overwrite` handler:
 *  - Widens or AST-snaps narrow `read_file`/`view_file` slices so pagination collapses into 1 turn.
 *  - Coalesces `&&`/`;`-chained read-only `plexer` invocations into a single 9 KB-budgeted `plexer _batch` call.
 */
import { existsSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { loadGraphCached } from '../context/graph-store.js';
import { hasPlexerIndex } from '../graph/root.js';
import { contextDirFor } from '../util/paths.js';
import { parseNodeSpan, unquoteArg } from '../util/span.js';
import { isFastGeminiModelProfile, isGeminiModelProfile } from '../hosts/engine/prompt/budget.js';
import { mergeSpan, normalizeRelFile } from './spans.js';
import { checkSwarmEditCollision } from './swarm-sync.js';
import {
    PKG_BIN_PLEXER,
    evaluateSearchAndGatePreTool,
    hasPlexerOnPath,
    isIgnoredRepoSubpath,
    isSyncFastPlexerCommand,
    normalizeSessionId,
    parsePlexerCommandTokens,
    quoteShellToken,
    readTextLinesSafe,
    resolvePlexerFallbackBin,
    rewriteShellExplorationCommand,
    splitSafeChainedCommands,
    tokenizeShellSegment,
    trackPreEditTurn,
    unquoteCommandLine,
} from './shell-rewrite.js';

export { evaluateSearchAndGatePreTool, rewriteShellExplorationCommand };

const ALLOW_RESULT = Object.freeze({ decision: 'allow' });

const FULL_WIDEN_MAX_LINES = 220;
const FULL_WIDEN_MAX_BYTES = 12000;
const FAST_FULL_WIDEN_MAX_LINES = 180;
const FAST_FULL_WIDEN_MAX_BYTES = 9500;
const CLAUDE_FULL_WIDEN_MAX_LINES = 220;
const CLAUDE_FULL_WIDEN_MAX_BYTES = 12000;
const UNCOVERED_WIDEN_MAX_LINES = 300;
const UNCOVERED_WIDEN_MAX_BYTES = 15000;
const FAST_UNCOVERED_WIDEN_MAX_LINES = 240;
const FAST_UNCOVERED_WIDEN_MAX_BYTES = 12000;
const CLAUDE_UNCOVERED_WIDEN_MAX_LINES = 220;
const CLAUDE_UNCOVERED_WIDEN_MAX_BYTES = 12000;
const LARGE_FILE_SLICE_WINDOW_LINES = 260;
const LARGE_FILE_SLICE_MAX_BYTES = 13000;
const FAST_SLICE_WINDOW_LINES = 200;
const FAST_SLICE_MAX_BYTES = 10000;
const CLAUDE_SLICE_WINDOW_LINES = 220;
const CLAUDE_SLICE_MAX_BYTES = 12000;
const AST_SNAP_MAX_LINES = 220;
const AST_SNAP_MAX_BYTES = 11000;
const FAST_AST_SNAP_MAX_LINES = 160;
const FAST_AST_SNAP_MAX_BYTES = 8500;
const CLAUDE_AST_SNAP_MAX_LINES = 320;
const CLAUDE_AST_SNAP_MAX_BYTES = 18000;
const SURGICAL_AST_SNAP_MAX_LINES = 100;
const SURGICAL_AST_SNAP_MAX_BYTES = 5000;
const HEADER_PEEK_MAX_LINES = 50;
const HEADER_PEEK_MIN_FILE_LINES = 120;
const HEADER_SNAP_MAX_LINES = 120;
const MIN_WIDEN_ADD_LINES = 20;
const TOP_PAGE_MIN_LINES = 60;
const TOP_PAGE_MAX_LINES = 220;
const TOP_PAGE_WIDEN_LINES = 240;
const TOP_PAGE_WIDEN_MAX_BYTES = 11000;
const FAST_TOP_PAGE_WIDEN_LINES = 200;
const FAST_TOP_PAGE_WIDEN_MAX_BYTES = 9500;
const CLAUDE_TOP_PAGE_WIDEN_LINES = 360;
const CLAUDE_TOP_PAGE_WIDEN_MAX_BYTES = 16000;
const MIN_EDGE_TRIM_LINES = 25;
const SURGICAL_EDGE_TRIM_MIN_LINES = 35;
const DUPLICATE_BLOCK_MIN_LINES = 90;
const DUPLICATE_BLOCK_MIN_BYTES = 3200;
const BLOCKED_KEYS_CAP = 16;
const MIN_UNBOUNDED_TRIM_LINES = 40;
const AGY_READ_MAX_LINES = 800;
const AGY_READ_MAX_BYTES = 46080;

const BINARY_OR_MEDIA_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.webm', '.avi',
    '.wasm', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.bin', '.exe',
    '.so', '.dylib', '.dll', '.o', '.a', '.pyc', '.class', '.woff', '.woff2',
    '.ttf', '.otf', '.eot', '.sqlite', '.db',
]);

function parsePositiveInt(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1)
        return null;
    return Math.floor(n);
}

function getFileSymbolsFromGraph(graph, relNorm) {
    if (!graph)
        return [];
    const byPath = graph._nodesByPath?.get(relNorm);
    const candidates = byPath ?? (graph.nodes ?? []).filter((n) => normalizeRelFile(n.path) === relNorm);
    const out = [];
    for (const n of candidates) {
        if (n.kind === 'file' || n.kind === 'module')
            continue;
        const sp = parseNodeSpan(n);
        if (sp)
            out.push(sp);
    }
    return out;
}

function byteLengthOfLines(lines, startLine, endLine) {
    let total = 0;
    const s = Math.max(1, startLine) - 1;
    const e = Math.min(lines.length, endLine);
    for (let i = s; i < e; i++)
        total += Buffer.byteLength(lines[i], 'utf8') + 1;
    return total;
}

function extractRequestedReadBounds(toolArgs, zeroBasedOffset = false) {
    if (!toolArgs || typeof toolArgs !== 'object')
        return null;
    if (toolArgs.ByteOffset !== undefined && toolArgs.ByteOffset !== null && toolArgs.ByteOffset !== '')
        return null;
    const explicitStart = toolArgs.StartLine ?? toolArgs.start_line;
    const hasExplicitLineStart = explicitStart !== undefined && explicitStart !== null && explicitStart !== '';
    let rawStart = explicitStart;
    if (!hasExplicitLineStart && toolArgs.offset !== undefined && toolArgs.offset !== null && toolArgs.offset !== '') {
        const offNum = Number(toolArgs.offset);
        if (Number.isFinite(offNum) && offNum >= 0 && (zeroBasedOffset || offNum === 0)) {
            rawStart = Math.floor(offNum) + 1;
        }
        else {
            rawStart = toolArgs.offset;
        }
    }
    const rawLimit = toolArgs.limit;
    let rawEnd = toolArgs.EndLine ?? toolArgs.end_line;
    if (rawEnd === undefined && rawLimit !== undefined) {
        const startNum = parsePositiveInt(rawStart) ?? 1;
        const limitNum = parsePositiveInt(rawLimit);
        if (limitNum)
            rawEnd = startNum + limitNum - 1;
    }
    const hasStart = rawStart !== undefined && rawStart !== null && rawStart !== '';
    const hasEnd = rawEnd !== undefined && rawEnd !== null && rawEnd !== '';
    return hasStart || hasEnd ? { rawStart, rawEnd } : null;
}

function resolveSafeReadTarget(toolArgs, repoRoot) {
    if (!repoRoot)
        return null;
    const rawPath = [toolArgs.Path, toolArgs.AbsolutePath, toolArgs.TargetFile, toolArgs.file_path, toolArgs.path]
        .map((v) => unquoteArg(v, null))
        .find(Boolean);
    if (!rawPath)
        return null;
    const absTarget = isAbsolute(rawPath) ? resolve(rawPath) : resolve(repoRoot, rawPath);
    const absRepo = resolve(repoRoot);
    const relNorm = normalizeRelFile(relative(absRepo, absTarget).replace(/\\/g, '/'));
    if (!relNorm || isIgnoredRepoSubpath(relNorm))
        return null;
    if (BINARY_OR_MEDIA_EXTS.has(extname(absTarget).toLowerCase()) || !existsSync(absTarget))
        return null;
    const loaded = readTextLinesSafe(absTarget);
    if (!loaded || loaded.lines.length === 0)
        return null;
    return { absRepo, relNorm, bytes: loaded.bytes, mtimeMs: loaded.mtimeMs, lines: loaded.lines };
}

function computeUnboundedReadEndLine(lines, startLine = 1) {
    const maxEnd = Math.min(lines.length, startLine + AGY_READ_MAX_LINES - 1);
    let bytes = 0;
    let end = startLine - 1;
    for (let ln = startLine; ln <= maxEnd; ln++) {
        const lb = Buffer.byteLength(lines[ln - 1], 'utf8') + 1;
        if (end >= startLine && bytes + lb > AGY_READ_MAX_BYTES)
            break;
        bytes += lb;
        end = ln;
    }
    return Math.max(startLine, end);
}

function uncoveredWindowAround(totalLines, reqStart, reqEnd, seenIntervals, allowPartialEdgeTrim = false, minEdgeTrimLines = MIN_EDGE_TRIM_LINES) {
    let winStart = 1;
    let winEnd = totalLines;
    let trimmedStart = reqStart;
    let trimmedEnd = reqEnd;
    for (const [s, e] of seenIntervals) {
        const seenLen = e - s + 1;
        const seenPrefixSubstantial = s <= 1 && seenLen >= minEdgeTrimLines;
        const seenSuffixSubstantial = e >= totalLines && seenLen >= minEdgeTrimLines;
        if (s <= 1 && e < reqStart && e + 1 > winStart)
            winStart = e + 1;
        else if (seenPrefixSubstantial && e < trimmedEnd && e >= reqStart) {
            const tailCandidate = (trimmedEnd - e) >= MIN_WIDEN_ADD_LINES ? e + 1 : Math.min(e + 1, reqStart);
            if (tailCandidate > winStart)
                winStart = tailCandidate;
        }
        if (e >= totalLines && s > reqEnd && s - 1 < winEnd)
            winEnd = s - 1;
        else if (seenSuffixSubstantial && s > trimmedStart && s <= reqEnd) {
            const headCandidate = (s - trimmedStart) >= MIN_WIDEN_ADD_LINES ? s - 1 : Math.max(s - 1, reqEnd);
            if (headCandidate < winEnd)
                winEnd = headCandidate;
        }
        if (allowPartialEdgeTrim && s <= trimmedStart && e >= trimmedStart && e < trimmedEnd) {
            if (((e - trimmedStart + 1) >= minEdgeTrimLines || seenPrefixSubstantial) && (trimmedEnd - e) >= MIN_WIDEN_ADD_LINES)
                trimmedStart = e + 1;
        }
        if (allowPartialEdgeTrim && s > trimmedStart && s <= trimmedEnd && e >= trimmedEnd) {
            if (((trimmedEnd - s + 1) >= minEdgeTrimLines || seenSuffixSubstantial) && (s - trimmedStart) >= MIN_WIDEN_ADD_LINES)
                trimmedEnd = s - 1;
        }
    }
    return {
        winStart: Math.min(winStart, trimmedStart),
        winEnd: Math.max(winEnd, trimmedEnd),
        trimmedStart,
        trimmedEnd,
    };
}

function trySnapSymbolSet(symbols, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines, maxBytes = AST_SNAP_MAX_BYTES) {
    if (!symbols.length)
        return null;
    const snapStart = Math.max(minClamp, Math.min(reqStart, ...symbols.map((sym) => sym.start)));
    const snapEnd = Math.min(maxClamp, Math.max(reqEnd, ...symbols.map((sym) => sym.end)));
    const fitsLines = (snapEnd - snapStart + 1) <= maxLines;
    const fitsBytes = byteLengthOfLines(lines, snapStart, snapEnd) <= maxBytes;
    if (fitsLines && fitsBytes && (snapStart < reqStart || snapEnd > reqEnd))
        return { start: snapStart, end: snapEnd, snappedAst: true };
    return null;
}

function computeAstSnapBounds(absRepo, relNorm, lines, reqStart, reqEnd, opts, maxLines = AST_SNAP_MAX_LINES, maxBytes = AST_SNAP_MAX_BYTES) {
    if (!hasPlexerIndex(absRepo))
        return { start: reqStart, end: reqEnd, snappedAst: false };
    let graph = null;
    try {
        graph = typeof opts.getGraph === 'function'
            ? opts.getGraph(absRepo)
            : loadGraphCached(contextDirFor(absRepo));
    }
    catch {
        return { start: reqStart, end: reqEnd, snappedAst: false };
    }
    const symbols = getFileSymbolsFromGraph(graph, relNorm);
    const overlapping = symbols.filter((sym) => sym.end >= reqStart && sym.start <= reqEnd);
    if (overlapping.length === 0)
        return { start: reqStart, end: reqEnd, snappedAst: false };
    const clamp = opts?.clampWindow;
    const minClamp = clamp ? Math.max(1, clamp.winStart) : 1;
    const maxClamp = clamp ? Math.min(lines.length, clamp.winEnd) : lines.length;

    const fullSnap = trySnapSymbolSet(overlapping, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines, maxBytes);
    if (fullSnap)
        return fullSnap;

    // When an enclosing class/module exceeds AST_SNAP_MAX_LINES, snap to overlapping inner methods/functions instead.
    const inner = overlapping.filter((sym) =>
        (sym.end - sym.start + 1) <= maxLines && byteLengthOfLines(lines, sym.start, sym.end) <= maxBytes,
    );
    if (inner.length > 0 && inner.length < overlapping.length) {
        const innerSnap = trySnapSymbolSet(inner, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines, maxBytes);
        if (innerSnap)
            return innerSnap;
    }
    return { start: reqStart, end: reqEnd, snappedAst: false };
}

function hasBlockedReadKey(agyState, blockKey) {
    if (!agyState || !blockKey) return false;
    if (Array.isArray(agyState.blockedReadKeys) && agyState.blockedReadKeys.includes(blockKey)) return true;
    return agyState.lastBlockedReadKey === blockKey;
}

function consumeBlockedReadKey(agyState, blockKey) {
    if (!agyState) return;
    if (Array.isArray(agyState.blockedReadKeys)) {
        agyState.blockedReadKeys = agyState.blockedReadKeys.filter((k) => k !== blockKey);
    }
    if (agyState.lastBlockedReadKey === blockKey) agyState.lastBlockedReadKey = null;
}

function recordBlockedReadKey(agyState, blockKey) {
    if (!agyState || !blockKey) return;
    const list = Array.isArray(agyState.blockedReadKeys)
        ? agyState.blockedReadKeys.filter((k) => k !== blockKey)
        : [];
    list.push(blockKey);
    if (list.length > BLOCKED_KEYS_CAP) list.splice(0, list.length - BLOCKED_KEYS_CAP);
    agyState.blockedReadKeys = list;
    agyState.lastBlockedReadKey = blockKey;
}

function getSeenIntervalsExact(seenSpans, spanKey) {
    if (!seenSpans || typeof seenSpans !== 'object' || !spanKey)
        return [];
    const list = seenSpans[spanKey];
    if (!Array.isArray(list))
        return [];
    const intervals = [];
    for (const pair of list) {
        if (!Array.isArray(pair) || pair.length < 2)
            continue;
        const s = Number(pair[0]);
        const e = Number(pair[1]);
        if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s)
            intervals.push([s, e]);
    }
    return intervals;
}

function recordSeenWithMtime(agyState, spanKey, relNorm, start, end, mtimeMs, lines = null) {
    if (!agyState || typeof agyState !== 'object')
        return;
    if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object')
        agyState.seenSpans = {};
    if (!agyState.lastFileReadEnd || typeof agyState.lastFileReadEnd !== 'object')
        agyState.lastFileReadEnd = {};
    const clampedEnd = Array.isArray(lines) && lines.length > 0
        ? Math.min(end, computeUnboundedReadEndLine(lines, start))
        : end;
    mergeSpan(agyState.seenSpans, spanKey, start, clampedEnd);
    agyState.lastReadRelFile = relNorm;
    agyState.lastFileReadEnd[spanKey] = clampedEnd;
    if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
        if (!agyState.seenMtimes || typeof agyState.seenMtimes !== 'object')
            agyState.seenMtimes = {};
        agyState.seenMtimes[spanKey] = mtimeMs;
    }
}

function isUneditedTurn0File(agyState, spanKey, relNorm) {
    if (!agyState?.turn0Matched || agyState?.editedInPrompt)
        return false;
    const matchKey = (raw) => {
        const nk = normalizeRelFile(String(raw ?? '').split(':')[0]);
        return Boolean(nk && (nk === spanKey || nk === relNorm || nk.endsWith(`/${relNorm}`) || relNorm.endsWith(`/${nk}`)));
    };
    if (Array.isArray(agyState.turn0SeenKeys) && agyState.turn0SeenKeys.some(matchKey))
        return true;
    return Array.isArray(agyState.injectedPointers) && agyState.injectedPointers.some(matchKey);
}

function checkDuplicateCoveredRead(agyState, spanKey, relNorm, lines, seenIntervals, effStart, effEnd, keyTag, _geminiProfile = true) {
    if (!seenIntervals.some(([s, e]) => s <= effStart && e >= effEnd))
        return { covered: false, blocked: false, retryAllowed: false };
    const spanLines = effEnd - effStart + 1;
    const spanBytes = byteLengthOfLines(lines, effStart, effEnd);
    const isPostPlanExecute = agyState?.orchestratorPhase === 'execute' && !agyState?.editedInPrompt;
    const isUneditedTurn0 = isUneditedTurn0File(agyState, spanKey, relNorm);
    const minBlockLines = isPostPlanExecute ? 30 : (isUneditedTurn0 ? 35 : DUPLICATE_BLOCK_MIN_LINES);
    const minBlockBytes = isPostPlanExecute ? 1200 : (isUneditedTurn0 ? 1400 : DUPLICATE_BLOCK_MIN_BYTES);
    const blockKey = `${spanKey}:${keyTag}`;
    if (spanLines < minBlockLines && spanBytes < minBlockBytes) {
        consumeBlockedReadKey(agyState, blockKey);
        return { covered: true, blocked: false, retryAllowed: false };
    }
    if (hasBlockedReadKey(agyState, blockKey)) {
        consumeBlockedReadKey(agyState, blockKey);
        return { covered: true, blocked: false, retryAllowed: true };
    }
    recordBlockedReadKey(agyState, blockKey);
    return {
        covered: true,
        blocked: true,
        retryAllowed: false,
        relNorm,
        startLine: effStart,
        endLine: effEnd,
        reason: `[plexer] ${relNorm}:L${effStart}-L${effEnd} is already in your context window (unedited); reuse those lines directly or retry once to force re-reading.`,
    };
}

function computeUnboundedGapTrim(seenIntervals, totalLines, effEnd) {
    if (seenIntervals.length === 0 || totalLines <= DUPLICATE_BLOCK_MIN_LINES)
        return null;
    let uStart = 1;
    let uEnd = effEnd;
    for (const [s, e] of seenIntervals) {
        if (s <= uStart && e >= uStart && e < uEnd && (e - uStart + 1) >= MIN_UNBOUNDED_TRIM_LINES) {
            uStart = e + 1;
        }
    }
    for (const [s, e] of seenIntervals) {
        if (s > uStart && s <= uEnd && e >= uEnd && (uEnd - s + 1) >= MIN_UNBOUNDED_TRIM_LINES) {
            uEnd = s - 1;
        }
    }
    if ((uStart === 1 && uEnd === effEnd) || (uEnd - uStart + 1) < MIN_WIDEN_ADD_LINES)
        return null;
    if (seenIntervals.some(([s, e]) => s > uStart && e < uEnd && (e - s + 1) >= MIN_UNBOUNDED_TRIM_LINES))
        return null;
    return { startLine: uStart, endLine: uEnd };
}

function computeLargeFileSliceWindow(absRepo, relNorm, lines, baseStart, baseEnd, winStart, winEnd, opts, sliceWindowLines = LARGE_FILE_SLICE_WINDOW_LINES, sliceMaxBytes = LARGE_FILE_SLICE_MAX_BYTES) {
    const snapAnchor = (baseStart - winStart) <= 80 ? winStart : Math.max(winStart, baseStart - 40);
    const bStart = Math.min(baseStart, snapAnchor);
    let bEnd = Math.min(winEnd, Math.max(baseEnd, bStart + sliceWindowLines - 1));
    while (bEnd > baseEnd && byteLengthOfLines(lines, bStart, bEnd) > sliceMaxBytes) {
        bEnd = Math.max(baseEnd, bEnd - 10);
    }
    const astBounds = computeAstSnapBounds(absRepo, relNorm, lines, bStart, bEnd, { ...opts, clampWindow: { winStart, winEnd } }, sliceWindowLines, sliceMaxBytes);
    if (astBounds.end > bEnd && astBounds.end <= winEnd && (astBounds.end - bEnd) <= 30 && byteLengthOfLines(lines, bStart, astBounds.end) <= sliceMaxBytes) {
        bEnd = astBounds.end;
    }
    return { start: bStart, end: bEnd };
}

export function computeReadPreToolWidening(toolArgs, repoRoot, agyState, opts = {}) {
    const hasByteOffset = toolArgs?.ByteOffset !== undefined && toolArgs?.ByteOffset !== null && toolArgs?.ByteOffset !== '';
    const bounds = extractRequestedReadBounds(toolArgs, opts?.hostKind === 'gemini');
    const target = resolveSafeReadTarget(toolArgs, repoRoot);
    if (!target)
        return null;

    const geminiProfile = opts.geminiProfile ?? true;
    const fastProfile = Boolean(geminiProfile && opts.fastProfile);
    const fullMaxLines = !geminiProfile ? CLAUDE_FULL_WIDEN_MAX_LINES : (fastProfile ? FAST_FULL_WIDEN_MAX_LINES : FULL_WIDEN_MAX_LINES);
    const fullMaxBytes = !geminiProfile ? CLAUDE_FULL_WIDEN_MAX_BYTES : (fastProfile ? FAST_FULL_WIDEN_MAX_BYTES : FULL_WIDEN_MAX_BYTES);
    const uncoveredMaxLines = !geminiProfile ? CLAUDE_UNCOVERED_WIDEN_MAX_LINES : (fastProfile ? FAST_UNCOVERED_WIDEN_MAX_LINES : UNCOVERED_WIDEN_MAX_LINES);
    const uncoveredMaxBytes = !geminiProfile ? CLAUDE_UNCOVERED_WIDEN_MAX_BYTES : (fastProfile ? FAST_UNCOVERED_WIDEN_MAX_BYTES : UNCOVERED_WIDEN_MAX_BYTES);
    const sliceWindowLines = !geminiProfile ? CLAUDE_SLICE_WINDOW_LINES : (fastProfile ? FAST_SLICE_WINDOW_LINES : LARGE_FILE_SLICE_WINDOW_LINES);
    const sliceMaxBytes = !geminiProfile ? CLAUDE_SLICE_MAX_BYTES : (fastProfile ? FAST_SLICE_MAX_BYTES : LARGE_FILE_SLICE_MAX_BYTES);
    const astSnapMaxLines = !geminiProfile ? CLAUDE_AST_SNAP_MAX_LINES : (fastProfile ? FAST_AST_SNAP_MAX_LINES : AST_SNAP_MAX_LINES);
    const astSnapMaxBytes = !geminiProfile ? CLAUDE_AST_SNAP_MAX_BYTES : (fastProfile ? FAST_AST_SNAP_MAX_BYTES : AST_SNAP_MAX_BYTES);
    const topPageWidenLines = !geminiProfile ? CLAUDE_TOP_PAGE_WIDEN_LINES : (fastProfile ? FAST_TOP_PAGE_WIDEN_LINES : TOP_PAGE_WIDEN_LINES);
    const topPageWidenMaxBytes = !geminiProfile ? CLAUDE_TOP_PAGE_WIDEN_MAX_BYTES : (fastProfile ? FAST_TOP_PAGE_WIDEN_MAX_BYTES : TOP_PAGE_WIDEN_MAX_BYTES);

    const { absRepo, relNorm, bytes: fileBytes, mtimeMs, lines } = target;
    const totalLines = lines.length;
    const spanKey = opts.relPrefix ? `${opts.relPrefix}${relNorm}` : relNorm;
    if (
        agyState?.seenMtimes
        && typeof agyState.seenMtimes[spanKey] === 'number'
        && typeof mtimeMs === 'number'
        && Math.abs(agyState.seenMtimes[spanKey] - mtimeMs) > 1
    ) {
        if (agyState.seenSpans) delete agyState.seenSpans[spanKey];
        if (agyState.fileSliceCounts) delete agyState.fileSliceCounts[spanKey];
        if (agyState.lastFileReadEnd) delete agyState.lastFileReadEnd[spanKey];
        delete agyState.seenMtimes[spanKey];
    }
    const seenIntervals = getSeenIntervalsExact(agyState?.seenSpans, spanKey);

    if (!bounds) {
        if (hasByteOffset)
            return null;
        const effEnd = computeUnboundedReadEndLine(lines, 1);
        const dup = checkDuplicateCoveredRead(agyState, spanKey, relNorm, lines, seenIntervals, 1, effEnd, 'unbounded', geminiProfile);
        if (dup.blocked)
            return dup;
        if (!dup.retryAllowed && agyState)
            consumeBlockedReadKey(agyState, `${spanKey}:unbounded`);
        if (!agyState)
            return null;
        const trimmed = dup.retryAllowed ? null : computeUnboundedGapTrim(seenIntervals, totalLines, effEnd);
        recordSeenWithMtime(agyState, spanKey, relNorm, 1, effEnd, mtimeMs, lines);
        agyState.lastFileReadEnd[spanKey] = trimmed ? Number(trimmed.endLine) : effEnd;
        if (!trimmed) {
            return dup.softHint ? { noOverwrite: true, additionalContext: dup.softHint } : null;
        }
        return {
            relNorm,
            startLine: Number(trimmed.startLine),
            endLine: Number(trimmed.endLine),
            limit: Number(trimmed.endLine - trimmed.startLine + 1),
            ...(dup.softHint ? { additionalContext: dup.softHint } : {}),
        };
    }

    const reqStart = parsePositiveInt(bounds.rawStart) ?? 1;
    const reqEnd = Math.min(totalLines, Math.max(reqStart, parsePositiveInt(bounds.rawEnd) ?? totalLines));

    const dup = checkDuplicateCoveredRead(agyState, spanKey, relNorm, lines, seenIntervals, reqStart, reqEnd, `${reqStart}-${reqEnd}`, geminiProfile);
    if (dup.blocked)
        return dup;
    if (dup.covered)
        return dup.softHint ? { noOverwrite: true, additionalContext: dup.softHint } : null;
    if (agyState)
        consumeBlockedReadKey(agyState, `${spanKey}:${reqStart}-${reqEnd}`);

    if (!agyState.lastFileReadEnd || typeof agyState.lastFileReadEnd !== 'object')
        agyState.lastFileReadEnd = {};
    const reqLines = reqEnd - reqStart + 1;
    const prevEnd = agyState.lastFileReadEnd[spanKey];
    const isSequentialPage = reqStart === 1
        || (typeof prevEnd === 'number' && reqStart >= prevEnd - 5 && reqStart <= prevEnd + 20)
        || seenIntervals.some(([s, e]) => s <= 1 && (e - s + 1) >= 100 && reqStart >= e - 5 && reqStart <= e + 20);
    const isSmallFile = totalLines <= fullMaxLines && fileBytes <= fullMaxBytes;
    const isTopOrMajorityRead = reqStart <= 10 || reqLines >= Math.ceil(totalLines * 0.6) || totalLines <= 90;
    const isSurgicalMidFileRead = !isSequentialPage && (!isSmallFile || !isTopOrMajorityRead);
    if (isSurgicalMidFileRead) {
        if (!agyState.fileSliceCounts || typeof agyState.fileSliceCounts !== 'object')
            agyState.fileSliceCounts = {};
        agyState.fileSliceCounts[spanKey] = (agyState.fileSliceCounts[spanKey] ?? 0) + 1;
        const { winStart, winEnd, trimmedStart, trimmedEnd } = uncoveredWindowAround(
            totalLines,
            reqStart,
            reqEnd,
            seenIntervals,
            true,
            SURGICAL_EDGE_TRIM_MIN_LINES,
        );
        const trimmed = trimmedStart > reqStart || trimmedEnd < reqEnd;
        const baseStart = trimmed ? trimmedStart : reqStart;
        const baseEnd = trimmed ? trimmedEnd : reqEnd;
        const ast = reqLines < 60
            ? computeAstSnapBounds(
                absRepo,
                relNorm,
                lines,
                baseStart,
                baseEnd,
                { ...opts, clampWindow: { winStart, winEnd } },
                SURGICAL_AST_SNAP_MAX_LINES,
                SURGICAL_AST_SNAP_MAX_BYTES,
            )
            : { start: baseStart, end: baseEnd, snappedAst: false };
        const effStart = ast.snappedAst ? ast.start : baseStart;
        const effEnd = ast.snappedAst ? ast.end : baseEnd;
        if (effStart === reqStart && effEnd === reqEnd) {
            recordSeenWithMtime(agyState, spanKey, relNorm, reqStart, reqEnd, mtimeMs, lines);
            return null;
        }
        recordSeenWithMtime(agyState, spanKey, relNorm, effStart, effEnd, mtimeMs, lines);
        return {
            relNorm,
            startLine: Number(effStart),
            endLine: Number(effEnd),
            limit: Number(effEnd - effStart + 1),
        };
    }

    if (!agyState.fileSliceCounts || typeof agyState.fileSliceCounts !== 'object')
        agyState.fileSliceCounts = {};
    const sliceCount = (agyState.fileSliceCounts[spanKey] ?? 0) + 1;
    agyState.fileSliceCounts[spanKey] = sliceCount;

    const hasSubstantialSeenInterval = seenIntervals.some(([s, e]) => (e - s + 1) >= MIN_EDGE_TRIM_LINES);
    const allowEdgeTrim = totalLines > fullMaxLines || hasSubstantialSeenInterval;
    const { winStart, winEnd, trimmedStart, trimmedEnd } = uncoveredWindowAround(totalLines, reqStart, reqEnd, seenIntervals, allowEdgeTrim);
    const edgeTrimmed = trimmedStart > reqStart || trimmedEnd < reqEnd;
    const baseStart = edgeTrimmed ? trimmedStart : reqStart;
    const baseEnd = edgeTrimmed ? trimmedEnd : reqEnd;
    const snapOpts = { ...opts, clampWindow: { winStart, winEnd } };
    const isHeaderPeek = reqStart === 1 && reqEnd <= HEADER_PEEK_MAX_LINES && totalLines > HEADER_PEEK_MIN_FILE_LINES;
    let newStart = baseStart;
    let newEnd = baseEnd;
    let snappedAst = false;
    if (isHeaderPeek) {
        ({ start: newStart, end: newEnd, snappedAst } = computeAstSnapBounds(absRepo, relNorm, lines, baseStart, baseEnd, snapOpts, HEADER_SNAP_MAX_LINES));
    }
    else {
        const winLines = winEnd - winStart + 1;
        const winBytes = (winStart === 1 && winEnd === totalLines)
            ? fileBytes
            : byteLengthOfLines(lines, winStart, winEnd);
        const smallFileWiden = totalLines <= fullMaxLines && fileBytes <= fullMaxBytes;
        const repeatedSliceWiden = sliceCount >= 2 && winLines <= uncoveredMaxLines && winBytes <= uncoveredMaxBytes;
        if (smallFileWiden || repeatedSliceWiden) {
            newStart = winStart;
            newEnd = winEnd;
        }
        else if (sliceCount >= 2 && winLines > uncoveredMaxLines) {
            ({ start: newStart, end: newEnd } = computeLargeFileSliceWindow(absRepo, relNorm, lines, baseStart, baseEnd, winStart, winEnd, opts, sliceWindowLines, sliceMaxBytes));
        }
        else {
            ({ start: newStart, end: newEnd, snappedAst } = computeAstSnapBounds(absRepo, relNorm, lines, baseStart, baseEnd, snapOpts, astSnapMaxLines, astSnapMaxBytes));
            if (
                !snappedAst
                && Boolean(agyState?.isEditPrompt)
                && sliceCount === 1
                && reqStart === 1
                && reqEnd >= TOP_PAGE_MIN_LINES
                && reqEnd <= TOP_PAGE_MAX_LINES
                && totalLines > fullMaxLines
            ) {
                let pageEnd = Math.min(winEnd, Math.max(baseEnd, topPageWidenLines));
                while (pageEnd > baseEnd && byteLengthOfLines(lines, baseStart, pageEnd) > topPageWidenMaxBytes) {
                    pageEnd = Math.max(baseEnd, pageEnd - 10);
                }
                if (pageEnd > baseEnd) {
                    const pageSnap = computeAstSnapBounds(absRepo, relNorm, lines, baseStart, pageEnd, snapOpts, topPageWidenLines, topPageWidenMaxBytes);
                    newStart = baseStart;
                    newEnd = Math.max(pageEnd, pageSnap.end);
                    snappedAst = pageSnap.snappedAst;
                }
            }
        }
    }

    const addedLines = (reqStart - newStart) + (newEnd - reqEnd);
    const shouldReturnOverwrite = !(newStart === reqStart && newEnd === reqEnd)
        && ((newStart > reqStart || newEnd < reqEnd)
            ? edgeTrimmed
            : (addedLines >= MIN_WIDEN_ADD_LINES || snappedAst));

    if (!shouldReturnOverwrite) {
        recordSeenWithMtime(agyState, spanKey, relNorm, reqStart, reqEnd, mtimeMs, lines);
        return null;
    }

    recordSeenWithMtime(agyState, spanKey, relNorm, newStart, newEnd, mtimeMs, lines);
    return {
        relNorm,
        startLine: Number(newStart),
        endLine: Number(newEnd),
        limit: Number(newEnd - newStart + 1),
    };
}

function handleReadPreTool(toolArgs, repoRoot, agyState, opts) {
    const plan = computeReadPreToolWidening(toolArgs, repoRoot, agyState, opts);
    if (!plan)
        return ALLOW_RESULT;
    if (plan.blocked) {
        return {
            decision: 'deny',
            reason: plan.reason,
        };
    }
    if (plan.noOverwrite) {
        return {
            decision: 'allow',
            ...(plan.additionalContext ? { additionalContext: plan.additionalContext } : {}),
        };
    }
    return {
        decision: 'allow',
        overwrite: {
            StartLine: plan.startLine,
            EndLine: plan.endLine,
        },
        ...(plan.additionalContext ? { additionalContext: plan.additionalContext } : {}),
    };
}

function isHarmlessDividerSegment(tokens) {
    return Boolean(tokens && tokens.length >= 1 && (tokens[0] === 'echo' || tokens[0] === 'printf'));
}

function countReadSpanArgs(argv) {
    let count = 0;
    for (let i = 1; i < argv.length; i++) {
        const tok = String(argv[i]);
        if (tok === '--dir' || tok === '--session') {
            i++;
            continue;
        }
        if (tok.startsWith('-'))
            continue;
        count += tok.split(',').map((s) => s.trim()).filter(Boolean).length;
    }
    return count;
}

function stripMultiSpanReadFullArgv(argv) {
    if (!Array.isArray(argv) || argv[0] !== 'read' || !argv.includes('--full'))
        return null;
    if (countReadSpanArgs(argv) < 2)
        return null;
    return argv.filter((tok) => tok !== '--full');
}

export function rewriteChainedPlexerCommand(cmd, sessionId = null) {
    if (typeof cmd !== 'string' || (!cmd.includes('&&') && !cmd.includes(';')))
        return null;
    if (!/\bplexer\b/.test(cmd))
        return null;
    const segments = splitSafeChainedCommands(cmd);
    if (!segments || segments.length < 2)
        return null;

    const cleanSid = normalizeSessionId(sessionId);
    const batchItems = [];
    let prefix = null;
    let sharedEnvCwd;
    let seenPlexer = false;
    for (const seg of segments) {
        const tokens = tokenizeShellSegment(seg);
        if (isHarmlessDividerSegment(tokens))
            continue;
        const parsed = parsePlexerCommandTokens(tokens);
        if (!parsed)
            return null;
        if (!seenPlexer) {
            seenPlexer = true;
            const offPathBare = (parsed.prefix === 'plexer' || parsed.prefix === 'npx plexer') && !hasPlexerOnPath();
            prefix = offPathBare ? resolvePlexerFallbackBin() : parsed.prefix;
            sharedEnvCwd = parsed.envCwd ?? null;
        }
        else if ((parsed.envCwd ?? null) !== sharedEnvCwd) {
            return null;
        }
        const strippedArgv = stripMultiSpanReadFullArgv(parsed.argv) ?? parsed.argv;
        const hasSession = strippedArgv.some((a) => a === '--session' || a.startsWith('--session='));
        const subArgv = cleanSid && !hasSession ? [...strippedArgv, '--session', cleanSid] : strippedArgv;
        batchItems.push(subArgv);
    }
    if (batchItems.length < 2 || !prefix)
        return null;
    const encoded = Buffer.from(JSON.stringify(batchItems), 'utf8').toString('base64url');
    const envPart = sharedEnvCwd ? `env -C ${quoteShellToken(sharedEnvCwd)} ` : '';
    return `${envPart}${prefix} _batch ${encoded}`;
}

export function rewriteSingleNpxPlexerCommand(cmd, sessionId = null) {
    if (typeof cmd !== 'string' || !/\bplexer(?:\.js)?\b/.test(cmd))
        return null;
    const segments = splitSafeChainedCommands(cmd);
    if (!segments || segments.length !== 1)
        return null;
    const tokens = tokenizeShellSegment(segments[0]);
    const parsed = parsePlexerCommandTokens(tokens, { allowAnySub: true });
    if (!parsed)
        return null;
    const strippedArgv = stripMultiSpanReadFullArgv(parsed.argv);
    let finalArgv = strippedArgv ?? parsed.argv;
    const cleanSid = normalizeSessionId(sessionId);
    const hasSession = finalArgv.some((a) => a === '--session' || a.startsWith('--session='));
    const sessionEligible = finalArgv[0] === 'read' || finalArgv[0] === 'ask' || finalArgv[0] === 'callers' || finalArgv[0] === 'callees' || finalArgv[0] === 'impact' || finalArgv[0] === 'grep';
    const appendSession = Boolean(cleanSid && sessionEligible && !finalArgv.includes('--full') && !finalArgv.includes('--json') && !hasSession);
    if (appendSession)
        finalArgv = [...finalArgv, '--session', cleanSid];

    const onPath = hasPlexerOnPath();
    const hasFallbackBin = existsSync(PKG_BIN_PLEXER);
    if (parsed.prefix !== 'npx plexer' && parsed.prefix !== 'plexer') {
        if (!strippedArgv && !appendSession)
            return null;
        const envPart = parsed.envCwd ? `env -C ${quoteShellToken(parsed.envCwd)} ` : '';
        return `${envPart}${parsed.prefix} ${finalArgv.map(quoteShellToken).join(' ')}`;
    }
    if (parsed.prefix === 'plexer' && onPath && !strippedArgv && !appendSession)
        return null;
    if (!onPath && !hasFallbackBin && (!strippedArgv && !appendSession || parsed.prefix !== 'plexer'))
        return null;
    const binPart = onPath
        ? 'plexer'
        : (hasFallbackBin ? resolvePlexerFallbackBin() : (parsed.prefix === 'npx plexer' ? 'npx plexer' : 'plexer'));
    const envPart = parsed.envCwd ? `env -C ${quoteShellToken(parsed.envCwd)} ` : '';
    return `${envPart}${binPart} ${finalArgv.map(quoteShellToken).join(' ')}`;
}

const PRETOOL_EDIT_RE = /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|Edit|Write|MultiEdit|apply_patch|replace)$/i;

function maybePreToolSwarmWarning(sid, repoRoot, toolArgs, agyState) {
    if (!sid || !repoRoot || !agyState || agyState.isSwarmMember === false)
        return null;
    const rawTarget = unquoteArg(
        toolArgs?.TargetFile ?? toolArgs?.AbsolutePath ?? toolArgs?.file_path ?? toolArgs?.path ?? toolArgs?.Path ?? '',
    );
    if (!rawTarget)
        return null;
    return checkSwarmEditCollision(sid, repoRoot, rawTarget, agyState, { preTool: true });
}

function handleRunCommandPreTool(toolArgs, sid = null, ctx = {}) {
    const cmd = unquoteCommandLine(toolArgs?.CommandLine ?? toolArgs?.command);
    const rewritten = rewriteChainedPlexerCommand(cmd, sid)
        ?? rewriteSingleNpxPlexerCommand(cmd, sid)
        ?? rewriteShellExplorationCommand(cmd, { repoRoot: ctx.repoRoot, sessionId: sid, getGraph: ctx.getGraph, agyState: ctx.agyState });
    const effectiveCmd = rewritten ?? cmd;
    const gated = evaluateSearchAndGatePreTool({
        toolName: 'run_command',
        toolArgs,
        effectiveCmd,
        repoRoot: ctx.repoRoot ?? '',
        relPrefix: ctx.relPrefix ?? '',
        agyState: ctx.agyState ?? null,
        geminiProfile: ctx.geminiProfile ?? true,
        getGraph: ctx.getGraph ?? null,
    });
    if (gated?.decision === 'deny')
        return gated;
    const rawWait = toolArgs?.WaitMsBeforeAsync;
    const waitNum = rawWait !== undefined && rawWait !== null && rawWait !== '' ? Number(rawWait) : NaN;
    const bumpWait = Number.isFinite(waitNum) && waitNum > 0 && waitNum < 5000 && isSyncFastPlexerCommand(effectiveCmd)
        ? 5000
        : null;
    if (!rewritten && !bumpWait) {
        return gated?.additionalContext
            ? { decision: 'allow', additionalContext: gated.additionalContext }
            : ALLOW_RESULT;
    }
    const overwrite = {};
    if (rewritten) {
        const key = toolArgs?.CommandLine !== undefined || toolArgs?.command === undefined ? 'CommandLine' : 'command';
        overwrite[key] = rewritten;
    }
    if (bumpWait)
        overwrite.WaitMsBeforeAsync = bumpWait;
    return {
        decision: 'allow',
        overwrite,
        ...(gated?.additionalContext ? { additionalContext: gated.additionalContext } : {}),
    };
}

/**
 * Process an Antigravity `PreToolUse` event and return a decision payload (`{ decision: "allow" | "deny", overwrite?, reason? }`).
 */
export function evaluateAgyPreTool(input, ctx = {}) {
    try {
        if (ctx.isolated)
            return ALLOW_RESULT;
        const name = String(input?.toolCall?.name ?? input?.tool_name ?? '').trim();
        const args = input?.toolCall?.args ?? input?.tool_input ?? {};
        const geminiProfile = ctx.geminiProfile ?? isGeminiModelProfile(input, ctx.hostKind || 'agy');
        const fastProfile = ctx.fastProfile ?? (geminiProfile && isFastGeminiModelProfile(input));
        const nextCtx = (ctx.geminiProfile === geminiProfile && ctx.fastProfile === fastProfile)
            ? ctx
            : { ...ctx, geminiProfile, fastProfile };
        const sid =
            ctx.sessionId ||
            input?.conversationId ||
            input?.sessionId ||
            input?.session_id ||
            ctx?.envFlags?.plexerSessionId ||
            ctx?.envFlags?.antigravityConversationId ||
            null;
        if (name === 'read_file' || name === 'view_file' || name === 'Read' || name === 'read') {
            trackPreEditTurn(ctx.agyState, name, Date.now());
            const readRes = handleReadPreTool(args, ctx.repoRoot, ctx.agyState, nextCtx);
            if (readRes?.decision !== 'deny') {
                const swarmWarn = maybePreToolSwarmWarning(sid, ctx.repoRoot, args, ctx.agyState);
                if (swarmWarn) {
                    const combined = readRes.additionalContext ? `${readRes.additionalContext}\n${swarmWarn}` : swarmWarn;
                    return { ...readRes, additionalContext: combined };
                }
            }
            return readRes;
        }
        if (name === 'run_command' || name === 'Bash' || name === 'run_shell_command' || name === 'shell') {
            return handleRunCommandPreTool(args, sid, nextCtx);
        }
        if (/^(?:grep_search|Grep|find_by_name|Glob)$/i.test(name)) {
            return evaluateSearchAndGatePreTool({
                toolName: name,
                toolArgs: args,
                repoRoot: ctx.repoRoot ?? '',
                relPrefix: ctx.relPrefix ?? '',
                agyState: ctx.agyState ?? null,
                geminiProfile,
            }) ?? ALLOW_RESULT;
        }
        if (PRETOOL_EDIT_RE.test(name)) {
            const swarmWarn = maybePreToolSwarmWarning(sid, ctx.repoRoot, args, ctx.agyState);
            return swarmWarn ? { decision: 'allow', additionalContext: swarmWarn } : ALLOW_RESULT;
        }
        return ALLOW_RESULT;
    }
    catch {
        return ALLOW_RESULT;
    }
}
