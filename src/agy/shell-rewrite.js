/**
 * Safe shell parsing, read/search/log rewriting, duplicate search/diff
 * deduplication, and Turn-6 pre-edit exploration gating shared across
 * Antigravity, Claude Code, Gemini CLI, and Codex PreToolUse hooks.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphCached } from '../context/graph-store.js';
import { hasPlexerIndex, nearestPlexerRoot } from '../graph/root.js';
import { contextDirFor, isLexicallyWithin } from '../util/paths.js';
import { unquoteArg } from '../util/span.js';
import { normalizeRelFile } from './spans.js';

export const PKG_BIN_PLEXER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'plexer.js');
const MAX_READ_STAT_BYTES = 256 * 1024;
const DEFAULT_SHELL_CAT_MAX_LINES = 220;
const SEEN_SEARCH_KEYS_CAP = 64;
const PRE_EDIT_TURN_GAP_MS = 2500;
const EXPLORATION_GATE_TURN_LIMIT = 6;

const BINARY_OR_MEDIA_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.pdf', '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.webm', '.avi',
    '.wasm', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.bin', '.exe',
    '.so', '.dylib', '.dll', '.o', '.a', '.pyc', '.class', '.woff', '.woff2',
    '.ttf', '.otf', '.eot', '.sqlite', '.db',
]);

const PLEXER_BATCHABLE_SUBCOMMANDS = new Set([
    'read', 'ask', 'callers', 'callees', 'impact', 'skeleton', 'grep', 'map', 'blast',
]);

const BROAD_SEARCH_SUBCOMMANDS = new Set(['grep', 'ask', 'map', 'skeleton']);
const DEDUP_SEARCH_SUBCOMMANDS = new Set(['grep', 'callers', 'callees', 'ask', 'map', 'skeleton']);
const EDIT_TOOL_RE = /^(?:edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|Edit|MultiEdit|Write|apply_patch|replace)$/i;
const NATIVE_BROAD_SEARCH_TOOL_RE = /^(?:grep_search|Grep|find_by_name|Glob)$/i;

let cachedPathEnv = null;
let cachedPlexerPathCheck = false;

export function isIgnoredRepoSubpath(relNorm) {
    if (!relNorm || relNorm.startsWith('..') || isAbsolute(relNorm))
        return true;
    const parts = relNorm.split('/');
    if (parts.includes('node_modules') || parts.includes('.git') || parts.includes('.agents'))
        return true;
    if (parts.includes('.system_generated') || parts.includes('.gemini') || parts.includes('plexer'))
        return true;
    return false;
}

export function readTextLinesSafe(absPath, maxStatBytes = MAX_READ_STAT_BYTES) {
    let st;
    try {
        st = statSync(absPath);
    }
    catch {
        return null;
    }
    if (!st.isFile() || st.size === 0 || st.size > maxStatBytes)
        return null;
    if (BINARY_OR_MEDIA_EXTS.has(extname(absPath).toLowerCase()))
        return null;
    let buf;
    try {
        buf = readFileSync(absPath);
    }
    catch {
        return null;
    }
    const probeLen = Math.min(buf.length, 4096);
    for (let i = 0; i < probeLen; i++) {
        if (buf[i] === 0)
            return null;
    }
    const lines = buf.toString('utf8').split(/\r\n|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '')
        lines.pop();
    return { bytes: st.size, lines };
}

export function getSeenIntervalsForFile(seenSpans, relNorm) {
    if (!seenSpans || typeof seenSpans !== 'object' || !relNorm)
        return [];
    const intervals = [];
    for (const [k, list] of Object.entries(seenSpans)) {
        if (!Array.isArray(list))
            continue;
        const normKey = normalizeRelFile(k);
        if (normKey !== relNorm && !normKey.endsWith(`/${relNorm}`))
            continue;
        for (const pair of list) {
            if (!Array.isArray(pair) || pair.length < 2)
                continue;
            const s = Number(pair[0]);
            const e = Number(pair[1]);
            if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s)
                intervals.push([s, e]);
        }
    }
    return intervals;
}

export function stepQuotedCommandChar(state, s, i) {
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

export function stepUnquotedCommandChar(state, s, i) {
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
 * Split a shell command on `&&` / `;` outside quotes, aborting on pipes,
 * redirects, subshells, or background `&`.
 */
export function splitSafeChainedCommands(cmd) {
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
 * Tokenize one shell segment respecting quotes and backslash escapes.
 */
export function tokenizeShellSegment(seg) {
    const tokens = [];
    let cur = '';
    let hasTok = false;
    let quote = null;
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i];
        if (quote) {
            if (quote === '"' && ch === '\\' && i + 1 < seg.length && /[$`"\\]/.test(seg[i + 1])) {
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

export function unwrapEnvCommandTokens(tokens) {
    if (!tokens || tokens[0] !== 'env')
        return { envCwd: null, hasEnvVars: false, rest: tokens };
    let envCwd = null;
    let hasEnvVars = false;
    let i = 1;
    while (i < tokens.length) {
        if (tokens[i] === '-C' && i + 1 < tokens.length) {
            envCwd = tokens[i + 1];
            i += 2;
            continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
            hasEnvVars = true;
            i++;
            continue;
        }
        if (tokens[i].startsWith('-'))
            return null;
        break;
    }
    return { envCwd, hasEnvVars, rest: tokens.slice(i) };
}

export function unquoteCommandLine(val) {
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

export function hasPlexerOnPath() {
    const rawPath = String(process.env.PATH || '');
    if (cachedPathEnv === rawPath)
        return cachedPlexerPathCheck;
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
    let found = false;
    for (const dir of rawPath.split(sep)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            if (existsSync(join(dir, `plexer${ext}`))) {
                found = true;
                break;
            }
        }
        if (found)
            break;
    }
    cachedPathEnv = rawPath;
    cachedPlexerPathCheck = found;
    return found;
}

export function resolvePlexerFallbackBin() {
    return `${quoteShellToken(process.execPath)} ${quoteShellToken(PKG_BIN_PLEXER)}`;
}

export function quoteShellToken(tok) {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(tok))
        return tok;
    return `'${String(tok).replace(/'/g, "'\\''")}'`;
}

export function normalizeSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.trim() && sessionId.trim() !== 'default'
        ? sessionId.trim().replace(/[^A-Za-z0-9_.-]/g, '_')
        : '';
}

export function resolvePlexerBinPart() {
    if (hasPlexerOnPath())
        return 'plexer';
    return existsSync(PKG_BIN_PLEXER) ? resolvePlexerFallbackBin() : 'plexer';
}

export function parsePlexerCommandTokens(tokens, { allowAnySub = false, allowBatch = false } = {}) {
    const unwrapped = unwrapEnvCommandTokens(tokens);
    if (!unwrapped || unwrapped.hasEnvVars)
        return null;
    const cmdTokens = unwrapped.rest;
    if (!cmdTokens || cmdTokens.length < 2)
        return null;
    let prefix = null;
    let restStart = 1;
    if (cmdTokens[0] === 'plexer') {
        prefix = 'plexer';
    }
    else if (cmdTokens[0] === 'npx' && cmdTokens[1] === 'plexer' && cmdTokens.length >= 3) {
        prefix = 'npx plexer';
        restStart = 2;
    }
    else if ((cmdTokens[0] === 'node' || cmdTokens[0].endsWith('/node')) && /plexer\.js$/i.test(cmdTokens[1]) && cmdTokens.length >= 3) {
        const quotedBin = /\s/.test(cmdTokens[1]) ? JSON.stringify(cmdTokens[1]) : cmdTokens[1];
        const quotedNode = /\s/.test(cmdTokens[0]) ? JSON.stringify(cmdTokens[0]) : cmdTokens[0];
        prefix = `${quotedNode} ${quotedBin}`;
        restStart = 2;
    }
    else {
        return null;
    }
    const sub = cmdTokens[restStart];
    if (
        !PLEXER_BATCHABLE_SUBCOMMANDS.has(sub)
        && !(allowBatch && sub === '_batch')
        && !(allowAnySub && /^(?:health|build|check|version)$/i.test(sub))
    ) {
        return null;
    }
    if (!allowAnySub && cmdTokens.includes('--json'))
        return null;
    return { prefix, envCwd: unwrapped.envCwd, argv: cmdTokens.slice(restStart) };
}

export function isSyncFastPlexerCommand(cmd) {
    if (typeof cmd !== 'string' || !/\bplexer(?:\.js)?\b/.test(cmd))
        return false;
    const segments = splitSafeChainedCommands(cmd);
    if (!segments || segments.length !== 1)
        return false;
    const tokens = tokenizeShellSegment(segments[0]);
    const parsed = parsePlexerCommandTokens(tokens, { allowBatch: true });
    return Boolean(parsed?.argv?.[0] && (parsed.argv[0] === '_batch' || PLEXER_BATCHABLE_SUBCOMMANDS.has(parsed.argv[0])));
}

function resolveLeadingCdAndExecTokens(cmd, repoRoot) {
    const segments = splitSafeChainedCommands(cmd);
    if (!segments || segments.length === 0 || segments.length > 2)
        return null;
    let execRepo = repoRoot ? resolve(repoRoot) : null;
    let mainSeg = segments[0];
    if (segments.length === 2) {
        const cdTokens = tokenizeShellSegment(segments[0]);
        if (!cdTokens || cdTokens[0] !== 'cd' || cdTokens.length !== 2)
            return null;
        if (!execRepo)
            return null;
        const absCd = resolve(execRepo, unquoteArg(cdTokens[1]));
        const cdNearest = nearestPlexerRoot(absCd)?.root;
        if (!isLexicallyWithin(execRepo, absCd) && !cdNearest)
            return null;
        execRepo = absCd;
        mainSeg = segments[1];
    }
    const rawTokens = tokenizeShellSegment(mainSeg);
    if (!rawTokens || rawTokens.length === 0)
        return null;
    const unwrapped = unwrapEnvCommandTokens(rawTokens);
    if (!unwrapped || unwrapped.hasEnvVars || !unwrapped.rest?.length)
        return null;
    if (unwrapped.envCwd) {
        if (!execRepo)
            return null;
        execRepo = resolve(execRepo, unquoteArg(unwrapped.envCwd));
    }
    const graphRepo = execRepo ? (nearestPlexerRoot(execRepo)?.root ?? execRepo) : null;
    return { execRepo, graphRepo, tokens: unwrapped.rest };
}

function resolveSafeTargetInGraphRepo(rawPath, execRepo, graphRepo) {
    if (!execRepo || !graphRepo || !rawPath || /[*?[\]]/.test(rawPath))
        return null;
    const clean = unquoteArg(rawPath);
    if (!clean || clean === '-')
        return null;
    const absFile = resolve(execRepo, clean);
    const absGraph = resolve(graphRepo);
    const rel = normalizeRelFile(relative(absGraph, absFile));
    if (isIgnoredRepoSubpath(rel))
        return null;
    const loaded = readTextLinesSafe(absFile);
    if (!loaded || loaded.lines.length === 0)
        return null;
    return { absFile, rel, totalLines: loaded.lines.length };
}

function buildPlexerReadShellCmd(graphRepo, rel, startLine, endLine, cleanSid) {
    const bin = resolvePlexerBinPart();
    const sessPart = cleanSid ? ` --session ${quoteShellToken(cleanSid)}` : '';
    const span = `${rel}:L${startLine}-L${endLine}`;
    return `env -C ${quoteShellToken(graphRepo)} ${bin} read ${quoteShellToken(span)}${sessPart}`;
}

function tryRewriteFileSliceCommand(tokens, execRepo, graphRepo, cleanSid) {
    const prog = tokens[0];
    let fileArg = null;
    let range = null;

    if (prog === 'cat') {
        const files = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '--number' || t === '--number-nonblank') continue;
            if (t.startsWith('-') && /^-[nbu]+$/.test(t)) continue;
            if (t.startsWith('-')) return null;
            files.push(t);
        }
        if (files.length !== 1) return null;
        fileArg = files[0];
        range = (total) => [1, Math.min(total, DEFAULT_SHELL_CAT_MAX_LINES)];
    }
    else if (prog === 'head' || prog === 'tail') {
        let nVal = 10;
        let plusStart = null;
        const files = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '-n' && i + 1 < tokens.length) {
                const raw = tokens[++i];
                if (prog === 'tail' && /^\+(\d+)$/.test(raw)) plusStart = Number(raw.slice(1));
                else if (/^\d+$/.test(raw)) nVal = Number(raw);
                else return null;
            }
            else if (/^--lines=(\+?\d+)$/.test(t)) {
                const raw = t.slice('--lines='.length);
                if (prog === 'tail' && raw.startsWith('+')) plusStart = Number(raw.slice(1));
                else nVal = Number(raw);
            }
            else if (/^-(\d+)$/.test(t)) {
                nVal = Number(t.slice(1));
            }
            else if (t.startsWith('-')) {
                return null;
            }
            else {
                files.push(t);
            }
        }
        if (files.length !== 1 || nVal <= 0) return null;
        fileArg = files[0];
        range = (total) => {
            if (prog === 'head') return [1, Math.min(total, nVal)];
            if (plusStart !== null) {
                const s = Math.min(total, Math.max(1, plusStart));
                return [s, Math.min(total, s + DEFAULT_SHELL_CAT_MAX_LINES - 1)];
            }
            return [Math.max(1, total - nVal + 1), total];
        };
    }
    else if (prog === 'sed') {
        let quiet = false;
        let script = null;
        const files = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '-n' || t === '--quiet' || t === '--silent') quiet = true;
            else if (t === '-e' && i + 1 < tokens.length && script === null) script = tokens[++i];
            else if (t.startsWith('-')) return null;
            else if (script === null) script = t;
            else files.push(t);
        }
        if (!quiet || !script || files.length !== 1) return null;
        const m = /^(\d+)\s*(?:,\s*(\d+|\$))?\s*p$/.exec(script.trim());
        if (!m) return null;
        const reqA = Math.max(1, Number(m[1]));
        const reqB = m[2] === '$' ? Infinity : (m[2] ? Number(m[2]) : reqA);
        if (reqB < reqA) return null;
        fileArg = files[0];
        range = (total) => {
            const s = Math.min(total, reqA);
            const e = Number.isFinite(reqB) ? Math.min(total, reqB) : Math.min(total, s + DEFAULT_SHELL_CAT_MAX_LINES);
            return [s, Math.max(s, e)];
        };
    }
    else {
        return null;
    }

    const target = resolveSafeTargetInGraphRepo(fileArg, execRepo, graphRepo);
    if (!target)
        return null;
    const [s, e] = range(target.totalLines);
    return buildPlexerReadShellCmd(graphRepo, target.rel, s, e, cleanSid);
}

const UNSAFE_GREP_FLAGS = new Set([
    'v', 'l', 'L', 'c', 'o', 'q', 'w', 'x', 'A', 'B', 'm', 'f', 'g', 't', 'P',
]);
const ALLOWED_SHORT_GREP_FLAGS = new Set(['r', 'R', 'n', 'H', 'h', 'I', 'i', 'F', 'E']);

function parseGrepLikeArgs(tokens) {
    let isGitGrep = false;
    let startIdx = 1;
    let fixed = tokens[0] === 'fgrep';
    let ignoreCase = false;
    let extended = tokens[0] === 'egrep' || tokens[0] === 'rg' || (tokens[0] === 'git' && tokens[1] === 'grep');
    let ctxLines = null;
    if (tokens[0] === 'git' && tokens[1] === 'grep') {
        isGitGrep = true;
        startIdx = 2;
    }
    else if (tokens[0] !== 'grep' && tokens[0] !== 'egrep' && tokens[0] !== 'fgrep' && tokens[0] !== 'rg') {
        return null;
    }

    const patterns = [];
    const positionals = [];
    for (let i = startIdx; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '--') {
            for (let j = i + 1; j < tokens.length; j++) positionals.push(tokens[j]);
            break;
        }
        if (t === '-i' || t === '--ignore-case') { ignoreCase = true; continue; }
        if (t === '-F' || t === '--fixed-strings') { fixed = true; continue; }
        if (t === '-E' || t === '--extended-regexp') { extended = true; continue; }
        if ((t === '-e' || t === '--regexp') && i + 1 < tokens.length) { patterns.push(tokens[++i]); continue; }
        if (t === '-C' && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) { ctxLines = Number(tokens[++i]); continue; }
        if (/^--context=(\d+)$/.test(t)) { ctxLines = Number(t.split('=')[1]); continue; }
        if (t === '--recursive' || t === '--line-number' || t === '--with-filename' || t === '--no-filename' || t === '--no-heading') continue;
        if (t.startsWith('--')) return null;
        if (t.startsWith('-') && t.length > 1) {
            for (const ch of t.slice(1)) {
                if (UNSAFE_GREP_FLAGS.has(ch) || !ALLOWED_SHORT_GREP_FLAGS.has(ch)) return null;
                if (ch === 'i') ignoreCase = true;
                if (ch === 'F') fixed = true;
                if (ch === 'E') extended = true;
            }
            continue;
        }
        positionals.push(t);
    }

    const pat = patterns.length > 0 ? patterns : (positionals.length > 0 ? [positionals.shift()] : []);
    if (pat.length !== 1 || !pat[0])
        return null;
    // POSIX BRE (plain grep / git grep without -E/-F) uses different escaping for | ( ) + ? { }.
    if (!fixed && !extended && /[\\()|?+{}]/.test(pat[0]))
        return null;
    return { pattern: pat[0], paths: positionals, fixed, ignoreCase, ctxLines };
}

function tryRewriteSearchCommand(tokens, execRepo, graphRepo, cleanSid, getGraph) {
    const parsed = parseGrepLikeArgs(tokens);
    if (!parsed)
        return null;
    const absGraph = resolve(graphRepo);
    const graph = typeof getGraph === 'function' ? getGraph(graphRepo) : loadGraphCached(contextDirFor(graphRepo));
    if (!graph?.nodes?.length)
        return null;

    const scopes = [];
    for (const rawPath of parsed.paths) {
        if (/[*?[\]]/.test(rawPath))
            return null;
        const absP = resolve(execRepo, unquoteArg(rawPath));
        const rel = normalizeRelFile(relative(absGraph, absP));
        if (rel === '.' || rel === '') continue;
        if (isIgnoredRepoSubpath(rel)) return null;
        if (!existsSync(absP)) return null;
        const hasIndexed = graph.nodes.some((n) => n.path === rel || n.path.startsWith(`${rel}/`));
        if (!hasIndexed)
            return null;
        scopes.push(rel);
    }

    const bin = resolvePlexerBinPart();
    const parts = [`env -C ${quoteShellToken(graphRepo)} ${bin} grep ${quoteShellToken(parsed.pattern)}`];
    if (parsed.fixed) parts.push('--fixed');
    if (parsed.ignoreCase) parts.push('-i');
    if (parsed.ctxLines !== null) parts.push(`-C ${parsed.ctxLines}`);
    for (const s of [...new Set(scopes)]) parts.push(`--in ${quoteShellToken(s)}`);
    if (cleanSid) parts.push(`--session ${quoteShellToken(cleanSid)}`);
    return parts.join(' ');
}

function tryRewriteGitLogCommand(tokens) {
    if (tokens[0] !== 'git' || tokens[1] !== 'log')
        return null;
    const hasPatch = tokens.includes('-p') || tokens.includes('--patch');
    if (!hasPatch)
        return null;
    const hasBound = tokens.some((t, idx) =>
        /^-\d+$/.test(t) || t === '-n' || t.startsWith('--max-count')
        || (idx > 1 && tokens[idx - 1] === '-n' && /^\d+$/.test(t)),
    );
    if (hasBound)
        return null;
    const mapped = tokens.map((t) => (t === '-p' || t === '--patch' ? '--stat' : t));
    mapped.push('-n', '5');
    return mapped.map(quoteShellToken).join(' ');
}

/**
 * Rewrite standalone shell file-reads (`cat`/`head`/`tail`/`sed -n`),
 * repo grep searches (`grep`/`rg`/`git grep`), and unbounded `git log -p`
 * into compact, `seenSpans`-aware `plexer` invocations when safe.
 */
export function rewriteShellExplorationCommand(cmd, { repoRoot, sessionId = null, getGraph = null } = {}) {
    if (typeof cmd !== 'string' || !cmd.trim() || cmd.includes('\n'))
        return null;
    const resolved = resolveLeadingCdAndExecTokens(cmd, repoRoot);
    if (!resolved || !resolved.execRepo || !resolved.graphRepo || !existsSync(contextDirFor(resolved.graphRepo)))
        return null;
    const cleanSid = normalizeSessionId(sessionId);
    const { execRepo, graphRepo, tokens } = resolved;
    return (
        tryRewriteFileSliceCommand(tokens, execRepo, graphRepo, cleanSid)
        ?? tryRewriteSearchCommand(tokens, execRepo, graphRepo, cleanSid, getGraph)
        ?? tryRewriteGitLogCommand(tokens)
    );
}

function stripPlexerSessionAndDir(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = String(argv[i]);
        if (a === '--session' || a === '--dir') { i++; continue; }
        if (a.startsWith('--session=') || a.startsWith('--dir=') || a === '--no-refresh') continue;
        out.push(a);
    }
    return out;
}

function classifyCommandSearch(cmd, repoRoot) {
    if (typeof cmd !== 'string' || !cmd.trim())
        return { isBroadSearch: false, searchKey: null, diffKey: null };
    const resolved = resolveLeadingCdAndExecTokens(cmd, repoRoot);
    if (!resolved)
        return { isBroadSearch: false, searchKey: null, diffKey: null };
    const { graphRepo, tokens } = resolved;
    const repoKey = normalizeRelFile(resolve(graphRepo || repoRoot || ''));

    const pParsed = parsePlexerCommandTokens(tokens, { allowAnySub: true });
    if (pParsed) {
        const cleanArgv = stripPlexerSessionAndDir(pParsed.argv);
        const sub = cleanArgv[0];
        return {
            isBroadSearch: BROAD_SEARCH_SUBCOMMANDS.has(sub),
            searchKey: DEDUP_SEARCH_SUBCOMMANDS.has(sub) ? `cmd:${repoKey}:${cleanArgv.join('\0')}` : null,
            diffKey: null,
        };
    }

    const prog = tokens[0];
    if (prog === 'git' && tokens[1] === 'diff') {
        const norm = tokens.slice(2).filter((t) => t !== '--no-pager').join('\0');
        return { isBroadSearch: false, searchKey: null, diffKey: `git-diff:${repoKey}:${norm}` };
    }
    if (prog === 'git' && (tokens[1] === 'grep' || tokens[1] === 'log')) {
        return {
            isBroadSearch: true,
            searchKey: tokens[1] === 'grep' ? `git-grep:${repoKey}:${tokens.slice(2).join('\0')}` : null,
            diffKey: null,
        };
    }
    if (/^(?:e?grep|fgrep|rg|find)$/.test(prog)) {
        return {
            isBroadSearch: true,
            searchKey: prog === 'find' ? null : `raw-grep:${repoKey}:${tokens.join('\0')}`,
            diffKey: null,
        };
    }
    return { isBroadSearch: false, searchKey: null, diffKey: null };
}

function classifyNativeSearch(toolName, toolArgs, repoRoot) {
    if (!NATIVE_BROAD_SEARCH_TOOL_RE.test(toolName))
        return { isBroadSearch: false, searchKey: null };
    const repoKey = normalizeRelFile(resolve(repoRoot || ''));
    const rawTarget = unquoteArg(toolArgs?.SearchDirectory ?? toolArgs?.SearchPath ?? toolArgs?.path ?? '');
    const pat = String(toolArgs?.Query ?? toolArgs?.Pattern ?? toolArgs?.pattern ?? '');
    const fixed = Boolean(toolArgs?.MatchPerLine === false ? false : toolArgs?.IsRegex === false || toolArgs?.fixed);
    return {
        isBroadSearch: true,
        searchKey: `native:${toolName.toLowerCase()}:${repoKey}:${rawTarget}:${pat}:${fixed}`,
    };
}

function areEditTargetsSeen(agyState, relPrefix = '') {
    const targets = Array.isArray(agyState?.editTargetFiles) ? agyState.editTargetFiles.filter(Boolean) : [];
    if (targets.length === 0 || !agyState?.seenSpans)
        return false;
    return targets.every((t) => {
        const rel = normalizeRelFile(t);
        return getSeenIntervalsForFile(agyState.seenSpans, rel).length > 0
            || (relPrefix && getSeenIntervalsForFile(agyState.seenSpans, `${relPrefix}${rel}`).length > 0);
    });
}

export function trackPreEditTurn(agyState, toolName, nowMs) {
    if (!agyState || typeof agyState !== 'object')
        return;
    if (EDIT_TOOL_RE.test(toolName)) {
        agyState.editedInPrompt = true;
        return;
    }
    if (!agyState.isEditPrompt || agyState.editedInPrompt || agyState.orchestratorPhase === 'plan')
        return;
    const prev = Number(agyState.lastPreEditToolAtMs) || 0;
    if (!prev || Math.abs(nowMs - prev) > PRE_EDIT_TURN_GAP_MS) {
        agyState.preEditToolTurns = (Number(agyState.preEditToolTurns) || 0) + 1;
    }
    agyState.lastPreEditToolAtMs = nowMs;
}

function checkDuplicateKey(agyState, key, reason) {
    if (!key || !agyState)
        return null;
    const seen = Array.isArray(agyState.seenSearchKeys) ? agyState.seenSearchKeys : [];
    if (seen.includes(key)) {
        if (agyState.lastBlockedSearchKey === key) {
            agyState.lastBlockedSearchKey = null;
            return null;
        }
        agyState.lastBlockedSearchKey = key;
        return { decision: 'deny', reason };
    }
    seen.push(key);
    if (seen.length > SEEN_SEARCH_KEYS_CAP)
        seen.splice(0, seen.length - SEEN_SEARCH_KEYS_CAP);
    agyState.seenSearchKeys = seen;
    agyState.lastBlockedSearchKey = null;
    return null;
}

/**
 * Apply Turn-6 pre-edit exploration gating and duplicate search/diff
 * deduplication across both native search tools and shell commands.
 */
export function evaluateSearchAndGatePreTool({
    toolName,
    toolArgs,
    effectiveCmd = null,
    repoRoot = '',
    relPrefix = '',
    agyState = null,
    nowMs = Date.now(),
}) {
    if (agyState)
        trackPreEditTurn(agyState, toolName, nowMs);

    const isShell = /^(?:run_command|Bash|run_shell_command)$/i.test(toolName);
    const searchInfo = isShell
        ? classifyCommandSearch(effectiveCmd ?? unquoteCommandLine(toolArgs?.CommandLine ?? toolArgs?.command), repoRoot)
        : classifyNativeSearch(toolName, toolArgs, repoRoot);

    if (
        searchInfo.isBroadSearch
        && agyState?.isEditPrompt
        && !agyState?.editedInPrompt
        && agyState?.orchestratorPhase !== 'plan'
        && (Number(agyState.preEditToolTurns) || 0) >= EXPLORATION_GATE_TURN_LIMIT
        && areEditTargetsSeen(agyState, relPrefix)
    ) {
        const targets = agyState.editTargetFiles.join(', ');
        return {
            decision: 'deny',
            reason: `[plexer] Exploration budget reached (${agyState.preEditToolTurns} pre-edit turns, 0 edits) and localized target files (${targets}) are already in context. Apply your edits now; targeted file reads on a specific unseen file/symbol and build/test commands remain allowed.`,
        };
    }

    if (searchInfo.diffKey && agyState) {
        const curEditSeq = Number(agyState.editSeq) || 0;
        if (agyState.lastGitDiffKey === searchInfo.diffKey && Number(agyState.lastGitDiffEditSeq) === curEditSeq) {
            if (agyState.lastBlockedSearchKey === searchInfo.diffKey) {
                agyState.lastBlockedSearchKey = null;
                return null;
            }
            agyState.lastBlockedSearchKey = searchInfo.diffKey;
            return {
                decision: 'deny',
                reason: '[plexer] No files have been modified since your previous git diff — reuse the diff already in context (or retry once to force re-running).',
            };
        }
        agyState.lastGitDiffKey = searchInfo.diffKey;
        agyState.lastGitDiffEditSeq = curEditSeq;
        agyState.lastBlockedSearchKey = null;
    }

    if (searchInfo.searchKey && agyState) {
        return checkDuplicateKey(
            agyState,
            searchInfo.searchKey,
            '[plexer] Identical search already ran earlier in this session with no intervening file edits — reuse those results directly (or retry once to force re-running).',
        );
    }

    return null;
}
