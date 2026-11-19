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
import { mergeSpan, normalizeRelFile } from './spans.js';
import {
    PKG_BIN_PLEXER,
    evaluateSearchAndGatePreTool,
    getSeenIntervalsForFile,
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

const FULL_WIDEN_MAX_LINES = 260;
const FULL_WIDEN_MAX_BYTES = 16000;
const UNCOVERED_WIDEN_MAX_LINES = 520;
const UNCOVERED_WIDEN_MAX_BYTES = 26000;
const LARGE_FILE_SLICE_WINDOW_LINES = 400;
const LARGE_FILE_SLICE_MAX_BYTES = 20000;
const AST_SNAP_MAX_LINES = 320;
const AST_SNAP_MAX_BYTES = 18000;
const HEADER_PEEK_MAX_LINES = 50;
const HEADER_PEEK_MIN_FILE_LINES = 120;
const HEADER_SNAP_MAX_LINES = 120;
const MIN_WIDEN_ADD_LINES = 20;
const TOP_PAGE_MIN_LINES = 60;
const TOP_PAGE_MAX_LINES = 220;
const TOP_PAGE_WIDEN_LINES = 360;
const TOP_PAGE_WIDEN_MAX_BYTES = 16000;
const MIN_EDGE_TRIM_LINES = 25;
const SURGICAL_MICRO_READ_MAX_LINES = 59;
const SURGICAL_EDGE_TRIM_MIN_LINES = 35;
const DUPLICATE_BLOCK_MIN_LINES = 90;
const DUPLICATE_BLOCK_MIN_BYTES = 3200;
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

function extractRequestedReadBounds(toolArgs) {
    if (!toolArgs || typeof toolArgs !== 'object')
        return null;
    if (toolArgs.ByteOffset !== undefined && toolArgs.ByteOffset !== null && toolArgs.ByteOffset !== '')
        return null;
    const rawStart = toolArgs.StartLine ?? toolArgs.start_line ?? toolArgs.offset;
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
    return { absRepo, relNorm, bytes: loaded.bytes, lines: loaded.lines };
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

function trySnapSymbolSet(symbols, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines) {
    if (!symbols.length)
        return null;
    const snapStart = Math.max(minClamp, Math.min(reqStart, ...symbols.map((sym) => sym.start)));
    const snapEnd = Math.min(maxClamp, Math.max(reqEnd, ...symbols.map((sym) => sym.end)));
    const fitsLines = (snapEnd - snapStart + 1) <= maxLines;
    const fitsBytes = byteLengthOfLines(lines, snapStart, snapEnd) <= AST_SNAP_MAX_BYTES;
    if (fitsLines && fitsBytes && (snapStart < reqStart || snapEnd > reqEnd))
        return { start: snapStart, end: snapEnd, snappedAst: true };
    return null;
}

function computeAstSnapBounds(absRepo, relNorm, lines, reqStart, reqEnd, opts, maxLines = AST_SNAP_MAX_LINES) {
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

    const fullSnap = trySnapSymbolSet(overlapping, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines);
    if (fullSnap)
        return fullSnap;

    // When an enclosing class/module exceeds AST_SNAP_MAX_LINES, snap to overlapping inner methods/functions instead.
    const inner = overlapping.filter((sym) =>
        (sym.end - sym.start + 1) <= maxLines && byteLengthOfLines(lines, sym.start, sym.end) <= AST_SNAP_MAX_BYTES,
    );
    if (inner.length > 0 && inner.length < overlapping.length) {
        const innerSnap = trySnapSymbolSet(inner, lines, reqStart, reqEnd, minClamp, maxClamp, maxLines);
        if (innerSnap)
            return innerSnap;
    }
    return { start: reqStart, end: reqEnd, snappedAst: false };
}

function checkDuplicateCoveredRead(agyState, relNorm, lines, seenIntervals, effStart, effEnd, keyTag) {
    if (!seenIntervals.some(([s, e]) => s <= effStart && e >= effEnd))
        return { covered: false, blocked: false, retryAllowed: false };
    const spanLines = effEnd - effStart + 1;
    const spanBytes = byteLengthOfLines(lines, effStart, effEnd);
    if (spanLines < DUPLICATE_BLOCK_MIN_LINES && spanBytes < DUPLICATE_BLOCK_MIN_BYTES) {
        if (agyState) agyState.lastBlockedReadKey = null;
        return { covered: true, blocked: false, retryAllowed: false };
    }
    const blockKey = `${relNorm}:${keyTag}`;
    if (agyState?.lastBlockedReadKey === blockKey) {
        agyState.lastBlockedReadKey = null;
        return { covered: true, blocked: false, retryAllowed: true };
    }
    if (agyState)
        agyState.lastBlockedReadKey = blockKey;
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

function computeLargeFileSliceWindow(absRepo, relNorm, lines, baseStart, baseEnd, winStart, winEnd, opts) {
    const snapAnchor = (baseStart - winStart) <= 80 ? winStart : Math.max(winStart, baseStart - 40);
    const bStart = Math.min(baseStart, snapAnchor);
    let bEnd = Math.min(winEnd, Math.max(baseEnd, bStart + LARGE_FILE_SLICE_WINDOW_LINES - 1));
    while (bEnd > baseEnd && byteLengthOfLines(lines, bStart, bEnd) > LARGE_FILE_SLICE_MAX_BYTES) {
        bEnd = Math.max(baseEnd, bEnd - 10);
    }
    const astBounds = computeAstSnapBounds(absRepo, relNorm, lines, bStart, bEnd, { ...opts, clampWindow: { winStart, winEnd } }, LARGE_FILE_SLICE_WINDOW_LINES);
    if (astBounds.end > bEnd && astBounds.end <= winEnd && (astBounds.end - bEnd) <= 30 && byteLengthOfLines(lines, bStart, astBounds.end) <= LARGE_FILE_SLICE_MAX_BYTES) {
        bEnd = astBounds.end;
    }
    return { start: bStart, end: bEnd };
}

export function computeReadPreToolWidening(toolArgs, repoRoot, agyState, opts = {}) {
    const hasByteOffset = toolArgs?.ByteOffset !== undefined && toolArgs?.ByteOffset !== null && toolArgs?.ByteOffset !== '';
    const bounds = extractRequestedReadBounds(toolArgs);
    const target = resolveSafeReadTarget(toolArgs, repoRoot);
    if (!target)
        return null;

    const { absRepo, relNorm, bytes: fileBytes, lines } = target;
    const totalLines = lines.length;
    const spanKey = opts.relPrefix ? `${opts.relPrefix}${relNorm}` : relNorm;
    const seenIntervals = getSeenIntervalsForFile(agyState?.seenSpans, relNorm);

    if (!bounds) {
        if (hasByteOffset)
            return null;
        const effEnd = computeUnboundedReadEndLine(lines, 1);
        const dup = checkDuplicateCoveredRead(agyState, relNorm, lines, seenIntervals, 1, effEnd, 'unbounded');
        if (dup.blocked)
            return dup;
        if (!dup.retryAllowed && agyState)
            agyState.lastBlockedReadKey = null;
        if (!agyState)
            return null;
        if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object')
            agyState.seenSpans = {};
        if (!agyState.lastFileReadEnd || typeof agyState.lastFileReadEnd !== 'object')
            agyState.lastFileReadEnd = {};
        const trimmed = dup.retryAllowed ? null : computeUnboundedGapTrim(seenIntervals, totalLines, effEnd);
        mergeSpan(agyState.seenSpans, spanKey, 1, effEnd);
        agyState.lastReadRelFile = relNorm;
        agyState.lastFileReadEnd[relNorm] = trimmed ? Number(trimmed.endLine) : effEnd;
        if (!trimmed)
            return null;
        return {
            relNorm,
            startLine: Number(trimmed.startLine),
            endLine: Number(trimmed.endLine),
            limit: Number(trimmed.endLine - trimmed.startLine + 1),
        };
    }

    const reqStart = parsePositiveInt(bounds.rawStart) ?? 1;
    const reqEnd = Math.min(totalLines, Math.max(reqStart, parsePositiveInt(bounds.rawEnd) ?? totalLines));

    const dup = checkDuplicateCoveredRead(agyState, relNorm, lines, seenIntervals, reqStart, reqEnd, `${reqStart}-${reqEnd}`);
    if (dup.blocked)
        return dup;
    if (dup.covered)
        return null;
    if (agyState)
        agyState.lastBlockedReadKey = null;

    if (!agyState.lastFileReadEnd || typeof agyState.lastFileReadEnd !== 'object')
        agyState.lastFileReadEnd = {};
    const reqLines = reqEnd - reqStart + 1;
    const prevEnd = agyState.lastFileReadEnd[relNorm];
    const isSequentialPage = reqStart === 1
        || (typeof prevEnd === 'number' && reqStart >= prevEnd - 5 && reqStart <= prevEnd + 20);
    const isSurgicalMidFileRead = !isSequentialPage && reqLines > SURGICAL_MICRO_READ_MAX_LINES;
    if (isSurgicalMidFileRead) {
        const { trimmedStart, trimmedEnd } = uncoveredWindowAround(
            totalLines,
            reqStart,
            reqEnd,
            seenIntervals,
            true,
            SURGICAL_EDGE_TRIM_MIN_LINES,
        );
        const trimmed = trimmedStart > reqStart || trimmedEnd < reqEnd;
        const effStart = trimmed ? trimmedStart : reqStart;
        const effEnd = trimmed ? trimmedEnd : reqEnd;
        if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object')
            agyState.seenSpans = {};
        mergeSpan(agyState.seenSpans, spanKey, effStart, effEnd);
        agyState.lastReadRelFile = relNorm;
        agyState.lastFileReadEnd[relNorm] = effEnd;
        if (!trimmed)
            return null;
        return {
            relNorm,
            startLine: Number(effStart),
            endLine: Number(effEnd),
            limit: Number(effEnd - effStart + 1),
        };
    }

    if (!agyState.fileSliceCounts || typeof agyState.fileSliceCounts !== 'object')
        agyState.fileSliceCounts = {};
    const sliceCount = (agyState.fileSliceCounts[relNorm] ?? 0) + 1;
    agyState.fileSliceCounts[relNorm] = sliceCount;

    const hasSubstantialSeenInterval = seenIntervals.some(([s, e]) => (e - s + 1) >= MIN_EDGE_TRIM_LINES);
    const allowEdgeTrim = totalLines > FULL_WIDEN_MAX_LINES || hasSubstantialSeenInterval;
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
        const smallFileWiden = totalLines <= FULL_WIDEN_MAX_LINES && fileBytes <= FULL_WIDEN_MAX_BYTES;
        const repeatedSliceWiden = sliceCount >= 2 && winLines <= UNCOVERED_WIDEN_MAX_LINES && winBytes <= UNCOVERED_WIDEN_MAX_BYTES;
        if (smallFileWiden || repeatedSliceWiden) {
            newStart = winStart;
            newEnd = winEnd;
        }
        else if (sliceCount >= 2 && winLines > UNCOVERED_WIDEN_MAX_LINES) {
            ({ start: newStart, end: newEnd } = computeLargeFileSliceWindow(absRepo, relNorm, lines, baseStart, baseEnd, winStart, winEnd, opts));
        }
        else {
            ({ start: newStart, end: newEnd, snappedAst } = computeAstSnapBounds(absRepo, relNorm, lines, baseStart, baseEnd, snapOpts));
            if (
                !snappedAst
                && sliceCount === 1
                && reqStart === 1
                && reqEnd >= TOP_PAGE_MIN_LINES
                && reqEnd <= TOP_PAGE_MAX_LINES
                && totalLines > FULL_WIDEN_MAX_LINES
            ) {
                let pageEnd = Math.min(winEnd, Math.max(baseEnd, TOP_PAGE_WIDEN_LINES));
                while (pageEnd > baseEnd && byteLengthOfLines(lines, 1, pageEnd) > TOP_PAGE_WIDEN_MAX_BYTES) {
                    pageEnd = Math.max(baseEnd, pageEnd - 10);
                }
                if (pageEnd > baseEnd) {
                    const pageSnap = computeAstSnapBounds(absRepo, relNorm, lines, 1, pageEnd, snapOpts, TOP_PAGE_WIDEN_LINES);
                    newStart = 1;
                    newEnd = Math.max(pageEnd, pageSnap.end);
                    snappedAst = pageSnap.snappedAst;
                }
            }
        }
    }

    if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object')
        agyState.seenSpans = {};
    mergeSpan(agyState.seenSpans, spanKey, newStart, newEnd);
    agyState.lastReadRelFile = relNorm;
    agyState.lastFileReadEnd[relNorm] = newEnd;

    if (newStart === reqStart && newEnd === reqEnd)
        return null;
    if (newStart > reqStart || newEnd < reqEnd) {
        return edgeTrimmed
            ? { relNorm, startLine: Number(newStart), endLine: Number(newEnd), limit: Number(newEnd - newStart + 1) }
            : null;
    }
    const addedLines = (reqStart - newStart) + (newEnd - reqEnd);
    if (addedLines < MIN_WIDEN_ADD_LINES && !snappedAst)
        return null;
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
    return {
        decision: 'allow',
        overwrite: {
            StartLine: plan.startLine,
            EndLine: plan.endLine,
        },
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
    const envPart = sharedEnvCwd ? `env -C ${/\s/.test(sharedEnvCwd) ? JSON.stringify(sharedEnvCwd) : sharedEnvCwd} ` : '';
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
    const appendSession = Boolean(cleanSid && finalArgv[0] === 'read' && !finalArgv.includes('--full') && !hasSession);
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

function handleRunCommandPreTool(toolArgs, sid = null, ctx = {}) {
    const cmd = unquoteCommandLine(toolArgs?.CommandLine ?? toolArgs?.command);
    const rewritten = rewriteChainedPlexerCommand(cmd, sid)
        ?? rewriteSingleNpxPlexerCommand(cmd, sid)
        ?? rewriteShellExplorationCommand(cmd, { repoRoot: ctx.repoRoot, sessionId: sid, getGraph: ctx.getGraph });
    const effectiveCmd = rewritten ?? cmd;
    const gated = evaluateSearchAndGatePreTool({
        toolName: 'run_command',
        toolArgs,
        effectiveCmd,
        repoRoot: ctx.repoRoot ?? '',
        relPrefix: ctx.relPrefix ?? '',
        agyState: ctx.agyState ?? null,
    });
    if (gated)
        return gated;
    const rawWait = toolArgs?.WaitMsBeforeAsync;
    const waitNum = rawWait !== undefined && rawWait !== null && rawWait !== '' ? Number(rawWait) : NaN;
    const bumpWait = Number.isFinite(waitNum) && waitNum > 0 && waitNum < 5000 && isSyncFastPlexerCommand(effectiveCmd)
        ? 5000
        : null;
    if (!rewritten && !bumpWait)
        return ALLOW_RESULT;
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
            return handleReadPreTool(args, ctx.repoRoot, ctx.agyState, ctx);
        }
        if (name === 'run_command' || name === 'Bash' || name === 'run_shell_command') {
            return handleRunCommandPreTool(args, sid, ctx);
        }
        if (/^(?:grep_search|Grep|find_by_name|Glob)$/i.test(name)) {
            return evaluateSearchAndGatePreTool({
                toolName: name,
                toolArgs: args,
                repoRoot: ctx.repoRoot ?? '',
                relPrefix: ctx.relPrefix ?? '',
                agyState: ctx.agyState ?? null,
            }) ?? ALLOW_RESULT;
        }
        return ALLOW_RESULT;
    }
    catch {
        return ALLOW_RESULT;
    }
}
