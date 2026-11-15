/**
 * Antigravity PreToolUse non-disruptive `overwrite` handler:
 *  - Widens or AST-snaps narrow `read_file`/`view_file` slices so pagination collapses into 1 turn.
 *  - Coalesces `&&`/`;`-chained read-only `plexer` invocations into a single 9 KB-budgeted `plexer _batch` call.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { loadGraphCached } from '../context/graph-store.js';
import { hasPlexerIndex } from '../graph/root.js';
import { contextDirFor } from '../util/paths.js';
import { parseNodeSpan, unquoteArg } from '../util/span.js';
import { mergeSpan, normalizeRelFile } from './spans.js';

const ALLOW_RESULT = Object.freeze({ decision: 'allow' });

const FULL_WIDEN_MAX_LINES = 350;
const FULL_WIDEN_MAX_BYTES = 22000;
const SECOND_SLICE_MAX_LINES = 750;
const SECOND_SLICE_MAX_BYTES = 42000;
const AST_SNAP_MAX_LINES = 320;
const AST_SNAP_MAX_BYTES = 24000;

const BINARY_OR_MEDIA_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.webm', '.avi',
    '.wasm', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.bin', '.exe',
    '.so', '.dylib', '.dll', '.o', '.a', '.pyc', '.class', '.woff', '.woff2',
    '.ttf', '.otf', '.eot', '.sqlite', '.db',
]);

const PLEXER_BATCHABLE_SUBCOMMANDS = new Set(['read', 'ask', 'callers', 'callees', 'impact', 'skeleton', 'grep', 'map', 'blast']);

const PLEXER_PREFIX_RE = /^((?:npx\s+)?plexer|node\s+(?:"[^"]*plexer\.js"|\S*plexer\.js))\s+([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i;

function isIgnoredRepoSubpath(relNorm) {
    if (!relNorm || relNorm.startsWith('..') || isAbsolute(relNorm))
        return true;
    const parts = relNorm.split('/');
    return parts.some((seg) => seg === '.git' || seg === 'node_modules' || seg === '.system_generated' || seg === 'plexer' || seg === '.agents');
}

function parsePositiveInt(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1)
        return null;
    return Math.floor(n);
}

function readTextLinesSafe(absPath, maxStatBytes = 256 * 1024) {
    let st;
    try {
        st = statSync(absPath);
    }
    catch {
        return null;
    }
    if (!st.isFile() || st.size === 0 || st.size > maxStatBytes)
        return null;
    const buf = readFileSync(absPath);
    // Skip binary files containing NUL bytes.
    const probeLen = Math.min(buf.length, 4096);
    for (let i = 0; i < probeLen; i++) {
        if (buf[i] === 0)
            return null;
    }
    const text = buf.toString('utf8');
    const lines = text.split(/\r\n|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '')
        lines.pop();
    return { bytes: st.size, lines };
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

function computeAstSnapBounds(absRepo, relNorm, lines, reqStart, reqEnd, opts) {
    if (!hasPlexerIndex(absRepo))
        return { start: reqStart, end: reqEnd };
    let graph = null;
    try {
        graph = typeof opts.getGraph === 'function'
            ? opts.getGraph(absRepo)
            : loadGraphCached(contextDirFor(absRepo));
    }
    catch {
        return { start: reqStart, end: reqEnd };
    }
    const symbols = getFileSymbolsFromGraph(graph, relNorm);
    const overlapping = symbols.filter((sym) => sym.end >= reqStart && sym.start <= reqEnd);
    if (overlapping.length === 0)
        return { start: reqStart, end: reqEnd };
    const snapStart = Math.max(1, Math.min(reqStart, ...overlapping.map((sym) => sym.start)));
    const snapEnd = Math.min(lines.length, Math.max(reqEnd, ...overlapping.map((sym) => sym.end)));
    const fitsLines = (snapEnd - snapStart + 1) <= AST_SNAP_MAX_LINES;
    const fitsBytes = byteLengthOfLines(lines, snapStart, snapEnd) <= AST_SNAP_MAX_BYTES;
    if (fitsLines && fitsBytes && (snapStart < reqStart || snapEnd > reqEnd))
        return { start: snapStart, end: snapEnd };
    return { start: reqStart, end: reqEnd };
}

export function computeReadPreToolWidening(toolArgs, repoRoot, agyState, opts = {}) {
    const bounds = extractRequestedReadBounds(toolArgs);
    if (!bounds)
        return null;
    const target = resolveSafeReadTarget(toolArgs, repoRoot);
    if (!target)
        return null;

    const { absRepo, relNorm, bytes: fileBytes, lines } = target;
    const totalLines = lines.length;
    const reqStart = parsePositiveInt(bounds.rawStart) ?? 1;
    const reqEnd = Math.min(totalLines, Math.max(reqStart, parsePositiveInt(bounds.rawEnd) ?? totalLines));

    if (!agyState.fileSliceCounts || typeof agyState.fileSliceCounts !== 'object')
        agyState.fileSliceCounts = {};
    const sliceCount = (agyState.fileSliceCounts[relNorm] ?? 0) + 1;
    agyState.fileSliceCounts[relNorm] = sliceCount;

    const smallFileWiden = totalLines <= FULL_WIDEN_MAX_LINES && fileBytes <= FULL_WIDEN_MAX_BYTES;
    const repeatedSliceWiden = sliceCount >= 2 && totalLines <= SECOND_SLICE_MAX_LINES && fileBytes <= SECOND_SLICE_MAX_BYTES;
    let newStart = reqStart;
    let newEnd = reqEnd;
    if (smallFileWiden || repeatedSliceWiden) {
        newStart = 1;
        newEnd = totalLines;
    }
    else {
        ({ start: newStart, end: newEnd } = computeAstSnapBounds(absRepo, relNorm, lines, reqStart, reqEnd, opts));
    }

    if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object')
        agyState.seenSpans = {};
    mergeSpan(agyState.seenSpans, relNorm, newStart, newEnd);
    agyState.lastReadRelFile = relNorm;

    if (newStart === reqStart && newEnd === reqEnd)
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
    return {
        decision: 'allow',
        overwrite: {
            StartLine: plan.startLine,
            EndLine: plan.endLine,
        },
    };
}

function stepQuotedCommandChar(state, s, i) {
    const ch = s[i];
    const next = s[i + 1];
    if (state.quote === '"' && ch === '\\' && i + 1 < s.length) {
        state.cur += ch + s[i + 1];
        return i + 1;
    }
    if (state.quote === '"' && (ch === '`' || (ch === '$' && next === '('))) {
        state.abort = true;
        return i;
    }
    if (ch === state.quote)
        state.quote = null;
    state.cur += ch;
    return i;
}

function stepUnquotedCommandChar(state, s, i) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '\'' || ch === '"') {
        state.quote = ch;
        state.cur += ch;
        return i;
    }
    if (ch === '\\' && i + 1 < s.length) {
        state.cur += ch + s[i + 1];
        return i + 1;
    }
    if (ch === '|' || ch === '>' || ch === '<' || ch === '`' || (ch === '$' && next === '(')) {
        state.abort = true;
        return i;
    }
    if ((ch === '&' && next === '&') || ch === ';') {
        state.segments.push(state.cur.trim());
        state.cur = '';
        return ch === '&' ? i + 1 : i;
    }
    if (ch === '&') {
        state.abort = true;
        return i;
    }
    state.cur += ch;
    return i;
}

/**
 * Split a shell command on `&&` / `;` only outside quotes.
 * Returns null if unquoted pipes, redirects, subshells, or background `&` are present.
 */
function splitSafeChainedCommands(cmd) {
    if (typeof cmd !== 'string')
        return null;
    const s = cmd.trim();
    if (!s)
        return null;

    const state = { segments: [], cur: '', quote: null, abort: false };
    for (let i = 0; i < s.length; i++) {
        i = state.quote
            ? stepQuotedCommandChar(state, s, i)
            : stepUnquotedCommandChar(state, s, i);
        if (state.abort)
            return null;
    }
    if (state.quote)
        return null;
    if (state.cur.trim())
        state.segments.push(state.cur.trim());
    return state.segments.filter(Boolean);
}

/**
 * Tokenize a single shell segment respecting single/double quotes and backslash escapes.
 */
function tokenizeShellSegment(seg) {
    const tokens = [];
    let cur = '';
    let hasTok = false;
    let quote = null;
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i];
        if (quote) {
            if (quote === '"' && ch === '\\' && i + 1 < seg.length) {
                cur += seg[++i];
                continue;
            }
            if (ch === quote) {
                quote = null;
                continue;
            }
            cur += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            hasTok = true;
            continue;
        }
        if (ch === '\\' && i + 1 < seg.length) {
            cur += seg[++i];
            hasTok = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasTok) {
                tokens.push(cur);
                cur = '';
                hasTok = false;
            }
            continue;
        }
        cur += ch;
        hasTok = true;
    }
    if (quote)
        return null;
    if (hasTok)
        tokens.push(cur);
    return tokens;
}

function parsePlexerCommandTokens(tokens) {
    if (!tokens || tokens.length < 2)
        return null;
    let prefix = null;
    let restStart = 1;
    if (tokens[0] === 'plexer') {
        prefix = 'plexer';
    }
    else if (tokens[0] === 'npx' && tokens[1] === 'plexer' && tokens.length >= 3) {
        prefix = 'npx plexer';
        restStart = 2;
    }
    else if ((tokens[0] === 'node' || tokens[0].endsWith('/node')) && /plexer\.js$/i.test(tokens[1]) && tokens.length >= 3) {
        const quotedBin = /\s/.test(tokens[1]) ? JSON.stringify(tokens[1]) : tokens[1];
        const quotedNode = /\s/.test(tokens[0]) ? JSON.stringify(tokens[0]) : tokens[0];
        prefix = `${quotedNode} ${quotedBin}`;
        restStart = 2;
    }
    else {
        return null;
    }
    const sub = tokens[restStart];
    if (!PLEXER_BATCHABLE_SUBCOMMANDS.has(sub))
        return null;
    if (tokens.includes('--json'))
        return null;
    return { prefix, argv: tokens.slice(restStart) };
}

export function rewriteChainedPlexerCommand(cmd, sessionId = null) {
    if (typeof cmd !== 'string' || (!cmd.includes('&&') && !cmd.includes(';')))
        return null;
    if (!PLEXER_PREFIX_RE.test(cmd.trim()) && !/\bplexer\b/.test(cmd))
        return null;
    const segments = splitSafeChainedCommands(cmd);
    if (!segments || segments.length < 2)
        return null;

    const cleanSid = typeof sessionId === 'string' && sessionId.trim() && sessionId.trim() !== 'default'
        ? sessionId.trim().replace(/[^A-Za-z0-9_.-]/g, '_')
        : '';
    const batchItems = [];
    let prefix = null;
    for (const seg of segments) {
        const tokens = tokenizeShellSegment(seg);
        const parsed = parsePlexerCommandTokens(tokens);
        if (!parsed)
            return null;
        if (!prefix)
            prefix = parsed.prefix;
        const hasSession = parsed.argv.some((a) => a === '--session' || a.startsWith('--session='));
        const subArgv = cleanSid && !hasSession ? [...parsed.argv, '--session', cleanSid] : parsed.argv;
        batchItems.push(subArgv);
    }
    const encoded = Buffer.from(JSON.stringify(batchItems), 'utf8').toString('base64url');
    return `${prefix} _batch ${encoded}`;
}

function unquoteCommandLine(val) {
    if (typeof val !== 'string')
        return null;
    const trimmed = val.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string')
                return parsed;
        }
        catch {
            return trimmed;
        }
    }
    return trimmed;
}

function handleRunCommandPreTool(toolArgs, sessionId = null) {
    const cmd = unquoteCommandLine(toolArgs?.CommandLine ?? toolArgs?.command);
    const rewritten = rewriteChainedPlexerCommand(cmd, sessionId);
    if (!rewritten)
        return ALLOW_RESULT;
    return {
        decision: 'allow',
        overwrite: {
            CommandLine: rewritten,
        },
    };
}

/**
 * Process an Antigravity `PreToolUse` event and return a decision payload (`{ decision: "allow", overwrite? }`).
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
            return handleReadPreTool(args, ctx.repoRoot, ctx.agyState, ctx);
        }
        if (name === 'run_command' || name === 'Bash' || name === 'run_shell_command') {
            return handleRunCommandPreTool(args, sid);
        }
        return ALLOW_RESULT;
    }
    catch {
        return ALLOW_RESULT;
    }
}
