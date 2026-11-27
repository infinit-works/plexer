/**
 * Safe shell parsing, read/search/log rewriting, duplicate search/diff
 * deduplication, and Turn-6 pre-edit exploration gating shared across
 * Antigravity, Claude Code, Gemini CLI, and Codex PreToolUse hooks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphCached } from '../context/graph-store.js';
import { hasPlexerIndex, nearestPlexerRoot } from '../graph/root.js';
import { contextDirFor, isLexicallyWithin } from '../util/paths.js';
import { unquoteArg } from '../util/span.js';
import { normalizeRelFile, invalidateSpanIfModified } from './spans.js';

export const PKG_BIN_PLEXER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'plexer.js');
const MAX_READ_STAT_BYTES = 256 * 1024;
const DEFAULT_SHELL_CAT_MAX_LINES = 220;
const SEEN_SEARCH_KEYS_CAP = 64;
const BLOCKED_KEYS_CAP = 16;
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
const SHELL_EDIT_TOOL_HINT_RE = /\b(?:sed|perl|python3?|node)\b/;
const PY_INLINE_WRITE_RE = /(?:open\s*\([^)]*,\s*['"][wa+]|Path\s*\([^)]*\)\s*\.\s*write_(?:text|bytes)|\.write_(?:text|bytes)\s*\(|shutil\.(?:copy|move)|os\.replace\s*\()/;
const NODE_INLINE_WRITE_RE = /(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync)\s*\(/;

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
    return { bytes: st.size, mtimeMs: st.mtimeMs, lines };
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
    if (state.quote === '"' && (ch === '`' || ch === '$')) {
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
    if (
        ch === '|' || ch === '>' || ch === '<' || ch === '`'
        || ch === '\n' || ch === '\r' || ch === '$'
        || ch === '(' || ch === ')' || ch === '{' || ch === '}'
        || ch === '~' || ch === '#'
    ) {
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
        const quotedBin = quoteShellToken(cmdTokens[1]);
        const quotedNode = quoteShellToken(cmdTokens[0]);
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
    let files = [];
    let range = null;

    if (prog === 'cat') {
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '--number' || t === '--number-nonblank') continue;
            if (t.startsWith('-') && /^-[nbu]+$/.test(t)) continue;
            if (t.startsWith('-')) return null;
            files.push(t);
        }
        if (files.length === 0 || files.length > 5) return null;
        const capPerFile = files.length === 1 ? DEFAULT_SHELL_CAT_MAX_LINES : 120;
        range = (total) => [1, Math.min(total, capPerFile)];
    }
    else if (prog === 'nl') {
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if ((t === '-b' || t === '-n' || t === '-v' || t === '-w') && i + 1 < tokens.length) {
                const val = tokens[++i];
                if (t === '-b' && !/^[atn]$/.test(val)) return null;
                if (t === '-n' && !/^(?:ln|rn|rz)$/.test(val)) return null;
                if ((t === '-v' || t === '-w') && !/^\d+$/.test(val)) return null;
                continue;
            }
            if (/^-(?:ba|bt|bn|nln|nrn|nrz)$/.test(t)) continue;
            if (t.startsWith('--body-numbering=') || t.startsWith('--number-format=')) continue;
            if (t.startsWith('-')) return null;
            files.push(t);
        }
        if (files.length !== 1) return null;
        range = (total) => [1, Math.min(total, DEFAULT_SHELL_CAT_MAX_LINES)];
    }
    else if (prog === 'head' || prog === 'tail') {
        let nVal = 10;
        let plusStart = null;
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
        range = (total) => {
            if (prog === 'head') return [1, Math.min(total, nVal)];
            if (plusStart !== null) {
                if (plusStart > total) return null;
                const s = Math.max(1, plusStart);
                return [s, Math.min(total, s + DEFAULT_SHELL_CAT_MAX_LINES - 1)];
            }
            return [Math.max(1, total - nVal + 1), total];
        };
    }
    else if (prog === 'sed') {
        let quiet = false;
        let script = null;
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
        range = (total) => {
            if (reqA > total) return null;
            const s = reqA;
            const e = Number.isFinite(reqB) ? Math.min(total, reqB) : Math.min(total, s + DEFAULT_SHELL_CAT_MAX_LINES);
            return [s, Math.max(s, e)];
        };
    }
    else {
        return null;
    }

    if (files.length === 1) {
        const target = resolveSafeTargetInGraphRepo(files[0], execRepo, graphRepo);
        if (!target) return null;
        const bounds = range(target.totalLines);
        if (!bounds) return null;
        return buildPlexerReadShellCmd(graphRepo, target.rel, bounds[0], bounds[1], cleanSid);
    }
    const spanArgs = [];
    for (const f of files) {
        const target = resolveSafeTargetInGraphRepo(f, execRepo, graphRepo);
        if (!target) return null;
        const bounds = range(target.totalLines);
        if (!bounds) return null;
        spanArgs.push(quoteShellToken(`${target.rel}:L${bounds[0]}-L${bounds[1]}`));
    }
    const bin = resolvePlexerBinPart();
    const sessPart = cleanSid ? ` --session ${quoteShellToken(cleanSid)}` : '';
    return `env -C ${quoteShellToken(graphRepo)} ${bin} read ${spanArgs.join(' ')}${sessPart}`;
}

const UNSAFE_GREP_FLAGS = new Set([
    'v', 'l', 'L', 'c', 'o', 'q', 'w', 'x', 'A', 'B', 'm', 'f', 'g', 't', 'P',
]);
const ALLOWED_SHORT_GREP_FLAGS = new Set(['r', 'R', 'n', 'H', 'h', 'I', 'i', 'F', 'E']);

const UNINDEXED_SEARCH_EXTS = new Set([
    '.json', '.jsonc', '.sh', '.bash', '.zsh', '.md', '.mdx', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf', '.txt', '.csv', '.tsv', '.lock', '.xml',
    '.svg', '.html', '.htm', '.css', '.scss', '.less', '.sql', '.env', '.pbtxt',
    '.proto', '.dockerfile',
]);

function pathHasIndexedMatches(graph, rel) {
    if (graph._nodesByPath) {
        if (graph._nodesByPath.has(rel)) return true;
        const prefix = `${rel}/`;
        for (const p of graph._nodesByPath.keys()) {
            if (p.startsWith(prefix)) return true;
        }
        return false;
    }
    return graph.nodes.some((n) => n.path === rel || n.path.startsWith(`${rel}/`));
}

const SKIP_UNINDEXED_SCAN_DIRS = new Set([
    '.git', 'node_modules', 'plexer', '.plexer', 'dist', 'build', 'coverage',
    '__pycache__', '.next', '.cache', '.venv', 'venv', 'target',
]);

function hasUnindexedEntriesInTarget(absP, graph) {
    try {
        const st = statSync(absP);
        if (st.isFile()) {
            return UNINDEXED_SEARCH_EXTS.has(extname(absP).toLowerCase());
        }
        if (st.isDirectory()) {
            const stack = [absP];
            let visited = 0;
            while (stack.length > 0 && visited < 500) {
                const dir = stack.pop();
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    visited += 1;
                    if (entry.isDirectory()) {
                        if (!SKIP_UNINDEXED_SCAN_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                            stack.push(join(dir, entry.name));
                        }
                    } else if (entry.isFile() && UNINDEXED_SEARCH_EXTS.has(extname(entry.name).toLowerCase())) {
                        return true;
                    }
                    if (visited >= 500) break;
                }
            }
        }
    } catch { /* ignore */ }
    return !graph;
}

function parseGrepLikeArgs(tokens) {
    let startIdx = 1;
    let fixed = tokens[0] === 'fgrep';
    let ignoreCase = false;
    let extended = tokens[0] === 'egrep' || tokens[0] === 'rg';
    let ctxLines = null;
    if (tokens[0] === 'git' && tokens[1] === 'grep') {
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

function hasAlreadyRanPlexerGrep(agyState, absGraph, pattern) {
    const seen = agyState?.seenSearchKeys;
    if (!Array.isArray(seen) || seen.length === 0) return false;
    const repoKey = normalizeRelFile(resolve(absGraph));
    const prefix = `cmd:${repoKey}:grep\0`;
    for (const key of seen) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const parts = key.slice(prefix.length).split('\0');
        if (parts.includes(pattern)) return true;
    }
    return false;
}

function tryRewriteSearchCommand(tokens, execRepo, graphRepo, cleanSid, getGraph, agyState = null) {
    const parsed = parseGrepLikeArgs(tokens);
    if (!parsed)
        return null;
    const absGraph = resolve(graphRepo);
    if (hasAlreadyRanPlexerGrep(agyState, absGraph, parsed.pattern))
        return null;
    const graph = typeof getGraph === 'function' ? getGraph(graphRepo) : loadGraphCached(contextDirFor(graphRepo));
    if (!graph?.nodes?.length)
        return null;

    const scopes = [];
    if (parsed.paths.length === 0) {
        const absExec = resolve(execRepo);
        const relExec = normalizeRelFile(relative(absGraph, absExec));
        if (relExec && relExec !== '.' && !relExec.startsWith('..')) {
            if (isIgnoredRepoSubpath(relExec) || hasUnindexedEntriesInTarget(absExec, graph) || !pathHasIndexedMatches(graph, relExec))
                return null;
            scopes.push(relExec);
        } else if (hasUnindexedEntriesInTarget(absGraph, graph)) {
            return null;
        }
    }
    for (const rawPath of parsed.paths) {
        if (/[*?[\]]/.test(rawPath))
            return null;
        const absP = resolve(execRepo, unquoteArg(rawPath));
        const rel = normalizeRelFile(relative(absGraph, absP));
        if (rel === '.' || rel === '') {
            if (hasUnindexedEntriesInTarget(absP, graph)) return null;
            continue;
        }
        if (isIgnoredRepoSubpath(rel)) return null;
        if (!existsSync(absP)) return null;
        if (hasUnindexedEntriesInTarget(absP, graph)) return null;
        if (!pathHasIndexedMatches(graph, rel))
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

function tryRewriteGitLogCommand(tokens, execRepo = null, repoRoot = null) {
    if (tokens[0] !== 'git' || tokens[1] !== 'log')
        return null;
    const hasBound = tokens.some((t, idx) =>
        /^-\d+$/.test(t) || t === '-n' || t.startsWith('--max-count')
        || (idx > 1 && tokens[idx - 1] === '-n' && /^\d+$/.test(t)),
    );
    if (hasBound)
        return null;
    const envPrefix = execRepo && repoRoot && resolve(execRepo) !== resolve(repoRoot)
        ? `env -C ${quoteShellToken(execRepo)} `
        : '';
    const hasPatch = tokens.includes('-p') || tokens.includes('--patch');
    if (hasPatch) {
        const dashDash = tokens.indexOf('--');
        const out = dashDash >= 0
            ? [...tokens.slice(0, dashDash), '-n', '3', ...tokens.slice(dashDash)]
            : [...tokens, '-n', '3'];
        return `${envPrefix}${out.map(quoteShellToken).join(' ')}`;
    }
    const skipUnbounded = tokens.some((t) =>
        t === '-S' || t === '-G' || t.startsWith('-S') || t.startsWith('-G')
        || t === '--grep' || t.startsWith('--grep=')
        || t === '--since' || t.startsWith('--since=')
        || t === '--after' || t.startsWith('--after=')
        || t === '--all' || t === '--graph',
    );
    if (skipUnbounded)
        return null;
    const hasFmt = tokens.some((t) =>
        t === '--oneline' || t === '--stat' || t === '--shortstat' || t === '--numstat'
        || t === '--name-only' || t === '--name-status'
        || t.startsWith('--format') || t.startsWith('--pretty'),
    );
    const extra = hasFmt ? ['-n', '15'] : ['--oneline', '-n', '15'];
    const dashDash = tokens.indexOf('--');
    const out = dashDash >= 0
        ? [...tokens.slice(0, dashDash), ...extra, ...tokens.slice(dashDash)]
        : [...tokens, ...extra];
    return `${envPrefix}${out.map(quoteShellToken).join(' ')}`;
}

/**
 * Rewrite standalone shell file-reads (`cat`/`head`/`tail`/`sed -n`),
 * repo grep searches (`grep`/`rg`/`git grep`), and unbounded `git log -p`
 * into compact, `seenSpans`-aware `plexer` invocations when safe.
 */
export function rewriteShellExplorationCommand(cmd, { repoRoot, sessionId = null, getGraph = null, agyState = null } = {}) {
    if (typeof cmd !== 'string' || !cmd.trim() || cmd.includes('\n'))
        return null;
    const resolved = resolveLeadingCdAndExecTokens(cmd, repoRoot);
    if (!resolved || !resolved.execRepo || !resolved.graphRepo || !existsSync(contextDirFor(resolved.graphRepo)))
        return null;
    const cleanSid = normalizeSessionId(sessionId);
    const { execRepo, graphRepo, tokens } = resolved;
    return (
        tryRewriteFileSliceCommand(tokens, execRepo, graphRepo, cleanSid)
        ?? tryRewriteSearchCommand(tokens, execRepo, graphRepo, cleanSid, getGraph, agyState)
        ?? tryRewriteGitLogCommand(tokens, execRepo, repoRoot)
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

function countCoveredLines(intervals) {
    if (!intervals.length) return 0;
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curS, curE] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        const [s, e] = sorted[i];
        if (s <= curE + 1) curE = Math.max(curE, e);
        else { total += curE - curS + 1; curS = s; curE = e; }
    }
    return total + (curE - curS + 1);
}

function getExactOrPrefixedIntervals(seenSpans, rel, relPrefix = '') {
    if (!seenSpans || typeof seenSpans !== 'object' || !rel) return [];
    const key = relPrefix ? `${relPrefix}${rel}` : rel;
    const direct = seenSpans[key] ?? seenSpans[rel];
    if (Array.isArray(direct) && direct.length > 0) {
        return direct.filter((p) => Array.isArray(p) && p.length >= 2 && Number(p[1]) >= Number(p[0]) && Number(p[0]) >= 1)
            .map((p) => [Number(p[0]), Number(p[1])]);
    }
    return [];
}

function areEditTargetsSeen(agyState, relPrefix = '', repoRoot = '') {
    const rawTargets = Array.isArray(agyState?.planTargetFiles) && agyState.planTargetFiles.length > 0
        ? agyState.planTargetFiles
        : (Array.isArray(agyState?.editTargetFiles) ? agyState.editTargetFiles : []);
    const targets = rawTargets.filter(Boolean);
    if (targets.length === 0 || !agyState?.seenSpans)
        return false;
    return targets.every((t) => {
        const rel = normalizeRelFile(t);
        if (repoRoot) {
            const absTarget = resolve(repoRoot, rel);
            if (relPrefix) invalidateSpanIfModified(agyState, `${relPrefix}${rel}`, absTarget);
            invalidateSpanIfModified(agyState, rel, absTarget);
        }
        const intervals = getExactOrPrefixedIntervals(agyState.seenSpans, rel, relPrefix);
        const covered = countCoveredLines(intervals);
        if (covered >= 15) return true;
        if (covered > 0 && repoRoot) {
            const loaded = readTextLinesSafe(resolve(repoRoot, rel));
            if (loaded && loaded.lines.length > 0 && covered >= loaded.lines.length) return true;
        }
        return false;
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

function hasBlockedSearchKey(agyState, key) {
    if (!agyState || !key) return false;
    if (Array.isArray(agyState.blockedSearchKeys) && agyState.blockedSearchKeys.includes(key)) return true;
    return agyState.lastBlockedSearchKey === key;
}

function consumeBlockedSearchKey(agyState, key) {
    if (!agyState) return;
    if (Array.isArray(agyState.blockedSearchKeys)) {
        agyState.blockedSearchKeys = agyState.blockedSearchKeys.filter((k) => k !== key);
    }
    if (agyState.lastBlockedSearchKey === key) agyState.lastBlockedSearchKey = null;
}

function recordBlockedSearchKey(agyState, key) {
    if (!agyState || !key) return;
    const list = Array.isArray(agyState.blockedSearchKeys)
        ? agyState.blockedSearchKeys.filter((k) => k !== key)
        : [];
    list.push(key);
    if (list.length > BLOCKED_KEYS_CAP) list.splice(0, list.length - BLOCKED_KEYS_CAP);
    agyState.blockedSearchKeys = list;
    agyState.lastBlockedSearchKey = key;
}

function checkDuplicateKey(agyState, key, reason) {
    if (!key || !agyState)
        return null;
    const seen = Array.isArray(agyState.seenSearchKeys) ? agyState.seenSearchKeys : [];
    if (seen.includes(key)) {
        if (hasBlockedSearchKey(agyState, key)) {
            consumeBlockedSearchKey(agyState, key);
            return null;
        }
        recordBlockedSearchKey(agyState, key);
        return { decision: 'deny', reason };
    }
    seen.push(key);
    if (seen.length > SEEN_SEARCH_KEYS_CAP)
        seen.splice(0, seen.length - SEEN_SEARCH_KEYS_CAP);
    agyState.seenSearchKeys = seen;
    consumeBlockedSearchKey(agyState, key);
    return null;
}

function collectIndexedFileSet(graph) {
    const out = new Set();
    if (!graph) return out;
    if (graph._nodesByPath) {
        for (const p of graph._nodesByPath.keys()) {
            const norm = normalizeRelFile(p);
            if (norm) out.add(norm);
        }
        return out;
    }
    for (const n of graph.nodes ?? []) {
        if (n?.path) {
            const norm = normalizeRelFile(n.path);
            if (norm) out.add(norm);
        }
    }
    return out;
}

function resolveIndexedTargetArg(rawArg, execRepo, graphRepo, indexedSet) {
    if (!rawArg || !execRepo || !graphRepo) return null;
    const clean = unquoteArg(rawArg).trim();
    if (!clean || clean === '-' || clean.startsWith('-') || /[*?[\]]/.test(clean)) return null;
    if (/^(?:\/tmp\/|\\tmp\\)/.test(clean)) return null;
    const absTarget = resolve(execRepo, clean);
    const rel = normalizeRelFile(relative(resolve(graphRepo), absTarget));
    if (!rel || rel.startsWith('..') || isIgnoredRepoSubpath(rel)) return null;
    return indexedSet.has(rel) ? rel : null;
}

function extractInlineStringsAndPaths(code, extraArgs, execRepo, graphRepo, indexedSet) {
    const found = new Set();
    const candidates = [...extraArgs];
    const strRe = /(['"])((?:\\.|(?!\1).){1,240})\1/g;
    for (const m of code.matchAll(strRe)) {
        candidates.push(m[2]);
    }
    for (const c of candidates) {
        const hit = resolveIndexedTargetArg(c, execRepo, graphRepo, indexedSet);
        if (hit) found.add(hit);
    }
    return [...found];
}

function splitLooseShellSegments(cmd) {
    const safe = splitSafeChainedCommands(cmd);
    if (safe) return safe;
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        const next = cmd[i + 1];
        if (quote) {
            if (quote === '"' && ch === '\\' && i + 1 < cmd.length) {
                cur += ch + cmd[++i];
                continue;
            }
            if (ch === quote) quote = null;
            cur += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            cur += ch;
            continue;
        }
        if ((ch === '&' && next === '&') || ch === ';' || ch === '|' || ch === '\n') {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            if (ch === '&' || next === '|') i++;
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function detectShellSourceEditInSegment(tokens, execRepo, graphRepo, indexedSet) {
    if (!tokens?.length) return [];
    const prog = tokens[0];
    if (prog === 'sed') {
        let inPlace = false;
        let sawScript = false;
        const posArgs = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '--') {
                posArgs.push(...tokens.slice(i + 1));
                break;
            }
            if (t === '-n' || t === '--quiet' || t === '--silent') return [];
            if (t === '--in-place' || t.startsWith('--in-place=') || t === '-i' || /^-(?:[A-Za-z]*i[A-Za-z]*|i.*)$/.test(t)) {
                inPlace = true;
                continue;
            }
            if ((t === '-e' || t === '-f') && i + 1 < tokens.length) {
                sawScript = true;
                i++;
                continue;
            }
            if (t.startsWith('-')) continue;
            if (!sawScript) {
                sawScript = true;
                continue;
            }
            posArgs.push(t);
        }
        if (!inPlace) return [];
        return posArgs.map((a) => resolveIndexedTargetArg(a, execRepo, graphRepo, indexedSet)).filter(Boolean);
    }
    if (prog === 'perl') {
        let inPlace = false;
        let sawScript = false;
        const posArgs = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (t === '--') {
                posArgs.push(...tokens.slice(i + 1));
                break;
            }
            if (t === '--in-place' || t.startsWith('--in-place=') || /^-[^-]*i/.test(t)) {
                inPlace = true;
                if (t.includes('e')) sawScript = true;
                continue;
            }
            if ((t === '-e' || t === '-E') && i + 1 < tokens.length) {
                sawScript = true;
                i++;
                continue;
            }
            if (t.startsWith('-')) continue;
            if (!sawScript) {
                sawScript = true;
                continue;
            }
            posArgs.push(t);
        }
        if (!inPlace) return [];
        return posArgs.map((a) => resolveIndexedTargetArg(a, execRepo, graphRepo, indexedSet)).filter(Boolean);
    }
    if (prog === 'python' || prog === 'python3' || /\/python3?$/.test(prog)) {
        let code = null;
        const extraArgs = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (code !== null) {
                extraArgs.push(t);
                continue;
            }
            if (t === '-m') return [];
            if (t === '-c' && i + 1 < tokens.length) {
                code = tokens[++i];
                continue;
            }
            if (t.startsWith('-c') && t.length > 2) {
                code = t.slice(2);
                continue;
            }
            if (!t.startsWith('-')) return [];
        }
        if (!code || !PY_INLINE_WRITE_RE.test(code)) return [];
        return extractInlineStringsAndPaths(code, extraArgs, execRepo, graphRepo, indexedSet);
    }
    if (prog === 'node' || /\/node$/.test(prog)) {
        let code = null;
        const extraArgs = [];
        for (let i = 1; i < tokens.length; i++) {
            const t = tokens[i];
            if (code !== null) {
                extraArgs.push(t);
                continue;
            }
            if (t === '--test' || t === '--check' || t === '-c') return [];
            if ((t === '-e' || t === '--eval') && i + 1 < tokens.length) {
                code = tokens[++i];
                continue;
            }
            if (t.startsWith('--eval=')) {
                code = t.slice('--eval='.length);
                continue;
            }
            if (!t.startsWith('-')) return [];
        }
        if (!code || !NODE_INLINE_WRITE_RE.test(code)) return [];
        return extractInlineStringsAndPaths(code, extraArgs, execRepo, graphRepo, indexedSet);
    }
    return [];
}

/**
 * Detect shell-based source edits (`sed -i`, `perl -i`, inline `python -c` /
 * `node -e` file writes) targeting files indexed in the plexer graph.
 */
export function detectShellSourceEdit(cmd, repoRoot, getGraph = null) {
    if (typeof cmd !== 'string' || !SHELL_EDIT_TOOL_HINT_RE.test(cmd) || !repoRoot)
        return null;
    const baseRoot = resolve(repoRoot);
    const segments = splitLooseShellSegments(cmd);
    if (!segments.length) return null;
    const hits = new Set();
    let curExec = baseRoot;
    let activeGraphRepo = nearestPlexerRoot(curExec)?.root ?? curExec;
    const graphCache = new Map();
    const getIndexed = (gRepo) => {
        const key = resolve(gRepo);
        if (graphCache.has(key)) return graphCache.get(key);
        if (!existsSync(contextDirFor(gRepo))) {
            graphCache.set(key, null);
            return null;
        }
        const graph = typeof getGraph === 'function' ? getGraph(gRepo) : loadGraphCached(contextDirFor(gRepo));
        const set = graph ? collectIndexedFileSet(graph) : null;
        graphCache.set(key, set);
        return set;
    };

    for (const seg of segments) {
        const rawTokens = tokenizeShellSegment(seg);
        if (!rawTokens?.length) continue;
        if (rawTokens[0] === 'cd' && rawTokens.length === 2) {
            curExec = resolve(curExec, unquoteArg(rawTokens[1]));
            activeGraphRepo = nearestPlexerRoot(curExec)?.root ?? curExec;
            continue;
        }
        const unwrapped = unwrapEnvCommandTokens(rawTokens);
        if (!unwrapped || !unwrapped.rest?.length) continue;
        const segExec = unwrapped.envCwd ? resolve(curExec, unquoteArg(unwrapped.envCwd)) : curExec;
        const segGraphRepo = unwrapped.envCwd ? (nearestPlexerRoot(segExec)?.root ?? segExec) : activeGraphRepo;
        const indexedSet = getIndexed(segGraphRepo);
        if (!indexedSet || indexedSet.size === 0) continue;
        for (const rel of detectShellSourceEditInSegment(unwrapped.rest, segExec, segGraphRepo, indexedSet)) {
            hits.add(rel);
        }
    }
    if (hits.size === 0) return null;
    const files = [...hits].sort();
    return { repoKey: normalizeRelFile(resolve(activeGraphRepo)), files };
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
    geminiProfile = true,
    getGraph = null,
    nowMs = Date.now(),
}) {
    if (agyState)
        trackPreEditTurn(agyState, toolName, nowMs);

    const isShell = /^(?:run_command|Bash|run_shell_command|shell)$/i.test(toolName);
    const rawCmd = isShell ? (effectiveCmd ?? unquoteCommandLine(toolArgs?.CommandLine ?? toolArgs?.command)) : null;
    if (geminiProfile && isShell && rawCmd) {
        const shellEdit = detectShellSourceEdit(rawCmd, repoRoot, getGraph);
        if (shellEdit) {
            const targetList = shellEdit.files.join(', ');
            const shellEditKey = `shell-edit:${shellEdit.repoKey}:${targetList}`;
            if (agyState) {
                if (hasBlockedSearchKey(agyState, shellEditKey)) {
                    consumeBlockedSearchKey(agyState, shellEditKey);
                }
                else {
                    recordBlockedSearchKey(agyState, shellEditKey);
                    return {
                        decision: 'deny',
                        reason: `[plexer] Edit ${targetList} with your native edit tool instead of shell scripts (or retry once if intentional batch/codegen edit).`,
                    };
                }
            }
        }
    }
    const searchInfo = isShell
        ? classifyCommandSearch(rawCmd, repoRoot)
        : classifyNativeSearch(toolName, toolArgs, repoRoot);

    const turnLimit = agyState?.orchestratorPhase === 'execute' ? 3 : EXPLORATION_GATE_TURN_LIMIT;
    if (
        searchInfo.isBroadSearch
        && agyState?.isEditPrompt
        && !agyState?.editedInPrompt
        && agyState?.orchestratorPhase !== 'plan'
        && (Number(agyState.preEditToolTurns) || 0) >= turnLimit
        && areEditTargetsSeen(agyState, relPrefix, repoRoot)
    ) {
        const targetPool = agyState.planTargetFiles?.length ? agyState.planTargetFiles : agyState.editTargetFiles;
        const targets = targetPool.join(', ');
        const isUnconfirmedHighOrXhigh = /(?:^|[-_\s(])(?:xhigh|extra|high)(?:$|[)\s_-])/i.test(String(agyState?.lastObservedModel ?? ''))
            && agyState?.orchestratorPhase !== 'execute';
        const nextAction = isUnconfirmedHighOrXhigh
            ? 'Apply your edits (or call `exit_plan_mode` if in plan mode) now'
            : 'Apply your edits now';
        const reason = `[plexer] Exploration budget reached (${agyState.preEditToolTurns} pre-edit turns, 0 edits) and localized target files (${targets}) are already in context. ${nextAction}; targeted file reads on a specific unseen file/symbol and build/test commands remain allowed.`;
        if (!geminiProfile || isUnconfirmedHighOrXhigh) {
            return { decision: 'allow', additionalContext: reason };
        }
        return { decision: 'deny', reason };
    }

    if (searchInfo.diffKey && agyState) {
        const curEditSeq = Number(agyState.editSeq) || 0;
        if (agyState.lastGitDiffKey === searchInfo.diffKey && Number(agyState.lastGitDiffEditSeq) === curEditSeq) {
            if (hasBlockedSearchKey(agyState, searchInfo.diffKey)) {
                consumeBlockedSearchKey(agyState, searchInfo.diffKey);
                return null;
            }
            recordBlockedSearchKey(agyState, searchInfo.diffKey);
            return {
                decision: 'deny',
                reason: '[plexer] No files have been modified since your previous git diff — reuse the diff already in context (or retry once to force re-running).',
            };
        }
        agyState.lastGitDiffKey = searchInfo.diffKey;
        agyState.lastGitDiffEditSeq = curEditSeq;
        consumeBlockedSearchKey(agyState, searchInfo.diffKey);
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
