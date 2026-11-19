import { existsSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { incomingEdges } from '../../claude/format.js';
import { loadGraphCached } from '../../context/graph-store.js';
import { hasAncestorRepoOrIndex, hasPlexerIndex, isAutoBuildableRepo, isBoundaryDir } from '../../graph/root.js';
import { agyTempDir, emptyAgySession, readAgyLastRepo, readAgySession, writeAgySession } from '../../agy/session.js';
import { buildUniqueRepoLabels, resolveAgyWorkspaceDirs } from '../../agy/multi-workspace.js';
import { tryRealpath } from '../../util/fs.js';
import { unquoteArg } from '../../util/span.js';
import { projectDir } from '../../util/state.js';
import { isIgnoredTouchedPath, normalizePromptKey, parseAgyTranscript } from './agy-transcript.js';

export { normalizePromptKey, unquoteArg };

const DEFAULT_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const HOST_KINDS = {
    claude: {
        id: 'claude', turn0Event: 'UserPromptSubmit', preToolEvent: 'PreToolUse',
        postToolEvent: 'PostToolUse', defaultPostToolName: '', emptyTurn0: '', emptyPostTool: '', emitOrientationOnTurn0: false,
    },
    gemini: {
        id: 'gemini', turn0Event: 'BeforeAgent', preToolEvent: 'BeforeTool',
        postToolEvent: 'AfterTool', defaultPostToolName: '', emptyTurn0: '{}\n', emptyPostTool: '', emitOrientationOnTurn0: true,
    },
    cursor: {
        id: 'cursor', turn0Event: null, preToolEvent: null,
        postToolEvent: null, defaultPostToolName: 'afterFileEdit', emptyTurn0: `${JSON.stringify({ continue: true })}\n`, emptyPostTool: '{}\n', emitOrientationOnTurn0: true,
    },
};

function realPosix(p) {
    return p && typeof p === 'string' ? tryRealpath(p).replace(/\\/g, '/') : null;
}

export function isIsolatedBenchDir(dir, envFlags = {}) {
    if (!dir || typeof dir !== 'string') return false;
    const disableHooks = envFlags?.disableHooks !== undefined ? Boolean(envFlags.disableHooks) : process.env.PLEXER_DISABLE_HOOKS === '1';
    if (disableHooks) return true;
    const enableBench = envFlags?.enableBenchHooks !== undefined ? Boolean(envFlags.enableBenchHooks) : process.env.PLEXER_ENABLE_BENCH_HOOKS === '1';
    if (enableBench) return false;
    const norm = dir.replace(/\\/g, '/');
    return norm.includes('/plexer-ab-') || norm.includes('/plexer-bench-') || norm.includes('/plexer-swebench-') || norm.includes('/plexer-large-');
}

export function resolveHostProjectDir(input, envFlags = {}) {
    const candidates = [
        input?.cwd, input?.projectDir,
        Array.isArray(input?.workspace_roots) ? input.workspace_roots[0] : null,
        Array.isArray(input?.workspacePaths) ? input.workspacePaths[0] : null,
        envFlags?.codexProjectDir, envFlags?.geminiProjectDir, envFlags?.claudeProjectDir,
        envFlags?.cursorProjectDir, envFlags?.antigravityProjectDir,
        process.env.CODEX_PROJECT_DIR, process.env.GEMINI_PROJECT_DIR,
        process.env.CLAUDE_PROJECT_DIR, process.env.CURSOR_PROJECT_DIR, process.env.ANTIGRAVITY_PROJECT_DIR,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return projectDir();
}

export function resolveHostSessionId(input, envFlags = {}) {
    const raw = input?.conversationId ?? input?.conversation_id ?? input?.session_id
        ?? input?.sessionId ?? input?.trace_id ?? envFlags?.sessionId
        ?? envFlags?.antigravityConversationId ?? envFlags?.claudeSessionId
        ?? envFlags?.cursorTraceId ?? process.env.PLEXER_SESSION_ID
        ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? process.env.CLAUDE_SESSION_ID
        ?? process.env.CURSOR_TRACE_ID ?? 'default';
    return String(raw || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function emitHookPayload(payloadStr, opts = {}) {
    if (!opts.captureStdout) {
        const buf = Buffer.from(payloadStr, 'utf8');
        let off = 0;
        while (off < buf.length) {
            try { off += writeSync(1, buf, off, buf.length - off); }
            catch (err) { if (err?.code === 'EAGAIN' || err?.code === 'EINTR') continue; break; }
        }
    }
    return payloadStr;
}

export function findNearestRepoAncestor(startPath) {
    if (!startPath || typeof startPath !== 'string') return null;
    let startDir = resolve(startPath);
    try { if (!statSync(startDir).isDirectory()) startDir = dirname(startDir); } catch { startDir = dirname(startDir); }
    for (const checkIndex of [true, false]) {
        let cur = startDir;
        for (let i = 0; i < 25; i++) {
            if (isBoundaryDir(cur)) break;
            if (checkIndex) {
                const indexed = hasPlexerIndex(cur) || existsSync(join(cur, 'plexer', 'INDEX.md'));
                if (indexed && (existsSync(join(cur, '.git')) || !hasAncestorRepoOrIndex(cur))) return cur;
            } else if (isAutoBuildableRepo(cur)) {
                return cur;
            }
            const parent = dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
    }
    return null;
}

export function resolveAgyRepoDir(input, sessionState, opts = {}) {
    const wsRoot = input?.workspacePaths?.[0] || null;
    const rawTouched = sessionState?.lastTouchedPath;
    const touched = rawTouched && !isIgnoredTouchedPath(rawTouched, wsRoot) ? rawTouched : null;
    const realPlugin = realPosix(opts.pluginRoot || process.env.PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT);
    const realWs = realPosix(wsRoot);
    const rawCallerCwd = opts.callerCwd ?? process.cwd();
    const realCaller = realPosix(rawCallerCwd);
    const insidePlugin = (r) => Boolean(r && realPlugin && (r === realPlugin || r.startsWith(`${realPlugin}/`)));
    const callerCwd = insidePlugin(realCaller) && !insidePlugin(realWs) ? null : rawCallerCwd;
    const candidates = [
        touched, input?.cwd, wsRoot, callerCwd, ...(wsRoot && existsSync(wsRoot) ? [] : [readAgyLastRepo()]),
    ].filter(Boolean);
    for (const c of candidates) {
        const hit = findNearestRepoAncestor(c);
        if (hit) return hit;
    }
    return wsRoot || input?.cwd || callerCwd || process.cwd();
}

export function activeWorkspaceDirs(input, agyState, primaryDir, opts = {}) {
    const dirs = resolveAgyWorkspaceDirs(input, agyState, opts);
    if (primaryDir && !dirs.some((d) => resolve(d) === resolve(primaryDir))) dirs.unshift(resolve(primaryDir));
    return dirs.length > 0 ? dirs : (primaryDir ? [resolve(primaryDir)] : []);
}

export function resolveToolTargetPath(input) {
    const args = input?.toolCall?.args ?? input?.tool_input ?? input?.args ?? {};
    return unquoteArg(args?.Path ?? args?.AbsolutePath ?? args?.TargetFile ?? args?.file_path ?? args?.path ?? args?.Cwd ?? '');
}

export function isEarlyIsolatedBenchCall(input, opts = {}) {
    const ws0 = input?.workspacePaths?.[0] || null;
    const tp = resolveToolTargetPath(input);
    const candidates = [input?.cwd, input?.toolCall?.args?.Cwd, tp, (!tp && !input?.cwd) ? ws0 : null].filter(Boolean);
    return candidates.some((c) => isIsolatedBenchDir(c, opts.envFlags));
}

export function labelPrefixForRepo(workspaceDirs, repoRoot) {
    if (workspaceDirs.length <= 1) return '';
    const labels = buildUniqueRepoLabels(workspaceDirs);
    const idx = workspaceDirs.findIndex((d) => resolve(d) === resolve(repoRoot));
    const lbl = idx >= 0 ? labels[idx] : labels[0];
    return lbl ? `${lbl}/` : '';
}

function pruneStaleAgySessions() {
    try {
        const dir = agyTempDir(), cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        for (const f of readdirSync(dir)) {
            if (f.endsWith('.json')) try { if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f)); } catch {}
        }
    } catch {}
}

export function readEngineSession(sid, opts = {}) {
    if (opts.sessionStore) return opts.sessionStore.get(sid) ?? emptyAgySession();
    const hit = opts.sessionCache?.get(sid);
    if (hit) return hit;
    const loaded = readAgySession(sid);
    opts.sessionCache?.set(sid, loaded);
    return loaded;
}

export function loadAgyContext(input, opts = {}) {
    const sid = resolveHostSessionId(input, opts.envFlags);
    if (!opts.sessionStore && Math.random() < 0.05) pruneStaleAgySessions();
    const agyState = readEngineSession(sid, opts);
    if (input?.transcriptPath) parseAgyTranscript(input.transcriptPath, agyState);
    return { sid, agyState, dir: resolveAgyRepoDir(input, agyState, opts) };
}

export function saveAgyContext(sid, agyState, opts = {}) {
    if (opts.sessionStore) opts.sessionStore.set(sid, agyState);
    else { opts.sessionCache?.set(sid, agyState); writeAgySession(sid, agyState); }
}

export function buildMidLoopHint(repoRoot, ctxDir, relFile, opts = {}) {
    if (!repoRoot || !ctxDir || !relFile || !existsSync(ctxDir)) return null;
    try {
        const graph = typeof opts.getGraph === 'function' ? opts.getGraph(repoRoot) : loadGraphCached(ctxDir);
        if (!graph) return null;
        const byId = graph._byId ?? new Map((graph.nodes ?? []).map((n) => [n.id, n]));
        const edges = incomingEdges(graph, resolve(repoRoot, relFile), repoRoot) ?? [];
        const callers = [...new Set(edges.map((e) => byId.get(e.source)?.name || byId.get(e.source)?.path || '').filter(Boolean))].slice(0, 6);
        const pathNodes = graph._nodesByPath?.get(relFile) ?? (graph.nodes ?? []).filter((n) => n.path === relFile);
        const syms = pathNodes.filter((n) => n.kind !== 'file').slice(0, 5).map((n) => `${n.name}(${n.span || ''})`);
        const parts = [...(callers.length ? [`callers: ${callers.join(', ')}`] : []), ...(syms.length ? [`symbols: ${syms.join(', ')}`] : [])];
        if (!parts.length) return null;
        const msg = `[plexer] graph context for ${relFile}: ${parts.join(' | ')}`;
        return Buffer.byteLength(msg, 'utf8') > 600 ? `${msg.slice(0, 585)}...` : msg;
    } catch { return null; }
}

export function isInteractiveAgyAppInput(input) {
    const marker = String(input?.transcriptPath || input?.artifactDirectoryPath || '');
    return /(?:^|[\\/])antigravity(?:-ide)?[\\/]/.test(marker);
}

export function fitAgyEphemeral(text, maxChars = 12000) {
    if (!text || text.length <= maxChars) return text;
    let out = String(text);
    const dropLast = (re) => {
        const blocks = [...out.matchAll(re)];
        if (!blocks.length) return false;
        const last = blocks[blocks.length - 1];
        out = `${out.slice(0, last.index)}${out.slice(last.index + last[0].length)}`.trim();
        return true;
    };
    while (out.length > maxChars && (
        dropLast(/\n\n\/\/ [^\n]+\n(?:L\d+:[^\n]*\n?)+/g)
        || dropLast(/\n\s*\d+\.\s[^\n]+(?:\n(?!\s*\d+\.\s|likely co-edits \/ tests:)[^\n]*)*/g)
        || dropLast(/\n\n## [^\n]+\n[\s\S]*?(?=\n\n## |$)/g)
    ));
    if (out.length <= maxChars) return out;
    let sliced = out.slice(0, maxChars - 16).replace(/\s+$/, '');
    const fences = (sliced.match(/^```/gm) || []).length;
    if (fences % 2 === 1) {
        const lastOpen = sliced.lastIndexOf('\n```');
        if (lastOpen > maxChars * 0.5) sliced = sliced.slice(0, lastOpen);
        else sliced += '\n```';
    }
    return `${sliced}\n...(truncated)`;
}

export function formatAgyUserMarkdown(
    { retrievalCount = 0, files = [], coEditCount = 0, blastFile = null, midLoopFile = null, oriented = false, weakScore = null } = {},
    { includeSidecarLink = false } = {},
) {
    const parts = [];
    const fl = files.slice(0, 3).map((f) => `\`${basename(f)}\``).join(', ');
    if (retrievalCount > 0) parts.push(`${retrievalCount} span${retrievalCount === 1 ? '' : 's'}${fl ? ` in ${fl}` : ''}`);
    if (coEditCount > 0) parts.push(`${coEditCount} co-edit pointer${coEditCount === 1 ? '' : 's'}`);
    if (blastFile) parts.push(`blast radius for \`${basename(blastFile)}\``);
    if (midLoopFile) parts.push(`graph context for \`${basename(midLoopFile)}\``);
    if (oriented) parts.push('repo orientation');
    if (weakScore !== null && weakScore < 0.25 && retrievalCount === 0) parts.push('low lexical match');
    if (parts.length === 0) return '';
    const link = includeSidecarLink ? ' · [Graph](sidecar://plexer/viz/?tab=context)' : '';
    return `[plexer] ${parts.join(' · ')}${link}`;
}
