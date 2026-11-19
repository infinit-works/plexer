/**
 * Hot-RAM local daemon (`plexerd`) keeping repo graphs and session state cached
 * across multi-host hook steps and CLI queries over a user-scoped Unix socket.
 */
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphCached, invalidateGraphCaches } from '../context/graph-store.js';
import { wiringPath } from '../context/node-file.js';
import { ensureFreshGraph } from '../graph/refresh.js';
import { nearestPlexerRoot } from '../graph/root.js';
import { readCurrentVersion } from '../util/cli-meta.js';
import { contextDirFor } from '../util/paths.js';
import { computeCodeStamp, ensureSocketParentDir, resolveDaemonSocketPath } from './socket-path.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const GRAPH_CACHE_MAX_REPOS = 6;
const SESSION_CACHE_MAX_ENTRIES = 64;
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const PKG_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

class CliExitSignal extends Error {
    constructor(code = 0) {
        super(`CLI exit ${code}`);
        this.code = code;
    }
}

function createSessionLru(maxEntries = SESSION_CACHE_MAX_ENTRIES, ttlMs = SESSION_CACHE_TTL_MS) {
    const store = new Map();
    const prune = (now = Date.now()) => {
        for (const [k, entry] of store) {
            if (now - entry.ts > ttlMs)
                store.delete(k);
        }
    };
    return {
        get(key) {
            const entry = store.get(key);
            if (!entry)
                return undefined;
            const now = Date.now();
            if (now - entry.ts > ttlMs) {
                store.delete(key);
                return undefined;
            }
            store.delete(key);
            entry.ts = now;
            store.set(key, entry);
            return entry.value;
        },
        set(key, value) {
            const now = Date.now();
            prune(now);
            if (store.has(key))
                store.delete(key);
            store.set(key, { value, ts: now });
            while (store.size > maxEntries) {
                const oldest = store.keys().next().value;
                store.delete(oldest);
            }
            return this;
        },
        has(key) {
            return this.get(key) !== undefined;
        },
        delete: store.delete.bind(store),
        clear() {
            store.clear();
        },
        get size() {
            prune();
            return store.size;
        },
    };
}

function isSocketAlive(sockPath, timeoutMs = 150) {
    return new Promise((resolveDone) => {
        const sock = createConnection(sockPath);
        const timer = setTimeout(() => {
            sock.destroy();
            resolveDone(false);
        }, timeoutMs);
        sock.on('connect', () => {
            clearTimeout(timer);
            sock.end();
            resolveDone(true);
        });
        sock.on('error', () => {
            clearTimeout(timer);
            resolveDone(false);
        });
    });
}

async function runCliInProcess(argv, cwd, runCliFn, sessionId = null) {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    const writeOut = (chunk, enc) => {
        if (Buffer.isBuffer(chunk))
            stdout += chunk.toString(typeof enc === 'string' ? enc : 'utf8');
        else
            stdout += String(chunk ?? '');
    };
    const writeErr = (chunk, enc) => {
        if (Buffer.isBuffer(chunk))
            stderr += chunk.toString(typeof enc === 'string' ? enc : 'utf8');
        else
            stderr += String(chunk ?? '');
    };

    try {
        await runCliFn(['node', 'plexer', ...argv], {
            isCaptured: true,
            cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
            sessionId: sessionId ? String(sessionId) : null,
            writeOut,
            writeErr,
            exit: (code = 0) => {
                throw new CliExitSignal(Number(code) || 0);
            },
        });
    }
    catch (err) {
        if (err instanceof CliExitSignal) {
            exitCode = err.code;
        }
        else {
            exitCode = 1;
            stderr += `${err instanceof Error ? err.message : String(err)}\n`;
        }
    }

    return { ok: exitCode === 0, exitCode, stdout, stderr };
}

async function cleanStaleSocketOrDetectLive(socketPath) {
    if (process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\') || !existsSync(socketPath))
        return false;
    if (await isSocketAlive(socketPath))
        return true;
    try {
        unlinkSync(socketPath);
    }
    catch { /* ignore */ }
    return false;
}

function runSerializedForRepo(state, repoRoot, fn) {
    const key = repoRoot ? resolve(repoRoot) : '__default__';
    const prev = state.repoRefreshChains.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tracked = next.finally(() => {
        if (state.repoRefreshChains.get(key) === tracked)
            state.repoRefreshChains.delete(key);
    });
    state.repoRefreshChains.set(key, tracked);
    return next;
}

function readGraphMetaMtime(ctxDir) {
    const metaPath = join(ctxDir, '.graph', 'meta.json');
    const graphPath = join(ctxDir, '.graph', 'wiring.json');
    try {
        return statSync(metaPath).mtimeMs;
    }
    catch {
        try {
            return statSync(graphPath).mtimeMs;
        }
        catch {
            return -1;
        }
    }
}

function getHotGraphForState(state, repoRoot) {
    const ctxDir = contextDirFor(repoRoot);
    const mtimeMs = readGraphMetaMtime(ctxDir);
    if (mtimeMs < 0)
        return null;
    const entry = state.hotGraphs.get(repoRoot);
    if (entry && entry.mtimeMs === mtimeMs && entry.graph) {
        state.hotGraphs.delete(repoRoot);
        state.hotGraphs.set(repoRoot, entry);
        return entry.graph;
    }
    invalidateGraphCaches(ctxDir);
    const graph = loadGraphCached(ctxDir);
    if (graph) {
        state.hotGraphs.delete(repoRoot);
        state.hotGraphs.set(repoRoot, { graph, mtimeMs });
        while (state.hotGraphs.size > GRAPH_CACHE_MAX_REPOS) {
            state.hotGraphs.delete(state.hotGraphs.keys().next().value);
        }
    }
    return graph;
}

function scheduleRefreshForState(state, repoRoot) {
    if (state.closing || state.draining || !repoRoot)
        return;
    const absRoot = resolve(repoRoot);
    const prev = state.pendingRefreshTimers.get(absRoot);
    if (prev)
        clearTimeout(prev);
    const timer = setTimeout(() => {
        state.pendingRefreshTimers.delete(absRoot);
        if (state.closing || state.draining)
            return;
        void runSerializedForRepo(state, absRoot, async () => {
            if (state.closing || state.draining)
                return;
            try {
                await ensureFreshGraph(absRoot);
                invalidateGraphCaches(contextDirFor(absRoot));
                state.hotGraphs.delete(absRoot);
                getHotGraphForState(state, absRoot);
            }
            catch { /* best-effort background warm */ }
        });
    }, 40);
    if (typeof timer.unref === 'function')
        timer.unref();
    state.pendingRefreshTimers.set(absRoot, timer);
}

async function closeDaemonServer(state) {
    if (state.closePromise)
        return state.closePromise;
    state.closePromise = (async () => {
        state.closing = true;
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }
        for (const t of state.pendingRefreshTimers.values())
            clearTimeout(t);
        state.pendingRefreshTimers.clear();
        const closed = new Promise((resolveClose) => {
            try {
                state.server.close(() => resolveClose());
            }
            catch {
                resolveClose();
            }
        });
        if (process.platform !== 'win32' && !state.socketPath.startsWith('\\\\.\\pipe\\')) {
            try { unlinkSync(state.socketPath); } catch { /* ignore */ }
        }
        for (const c of state.activeConns) {
            try { if (!c.destroyed) c.end(); } catch { /* ignore */ }
        }
        await closed;
    })();
    return state.closePromise;
}

function resetDaemonIdleTimer(state) {
    if (!state.idleTimeoutMs || state.closing || state.draining)
        return;
    if (state.idleTimer)
        clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
        if (state.inFlight === 0)
            void closeDaemonServer(state);
    }, state.idleTimeoutMs);
    if (typeof state.idleTimer.unref === 'function')
        state.idleTimer.unref();
}

async function handleHookMessage(state, msg) {
    if (!state.hookDispatchCached) {
        const mod = await import('../hosts/engine/dispatcher.js');
        state.hookDispatchCached = mod.dispatchHostEvent;
    }
    const stdout = await state.hookDispatchCached(msg.event, msg.input ?? {}, {
        captureStdout: true,
        pluginRoot: msg.envFlags?.pluginRoot,
        callerCwd: msg.envFlags?.callerCwd,
        envFlags: msg.envFlags,
        sessionCache: state.sessionCache,
        getGraph: (repoRoot) => getHotGraphForState(state, repoRoot),
        withRepoLock: (repoRoot, fn) => runSerializedForRepo(state, repoRoot, fn),
        scheduleRefresh: (repoRoot) => scheduleRefreshForState(state, repoRoot),
        hasInFlightRefresh: (repoRoot) => Boolean(repoRoot && state.repoRefreshChains.has(resolve(repoRoot))),
        onFileEdited: (repoRoot) => scheduleRefreshForState(state, repoRoot),
        onGraphRefreshed: (repoRoot) => {
            state.hotGraphs.delete(repoRoot);
            invalidateGraphCaches(contextDirFor(repoRoot));
        },
    });
    return {
        id: msg.id, ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: '',
        version: state.version, codeStamp: state.codeStamp,
    };
}

async function handleCliMessage(state, msg) {
    const baseCwd = msg.cwd && existsSync(msg.cwd) ? resolve(msg.cwd) : null;
    const targetRoot = baseCwd ? (nearestPlexerRoot(baseCwd)?.root ?? baseCwd) : null;
    const pending = targetRoot ? state.repoRefreshChains.get(resolve(targetRoot)) : null;
    if (pending) {
        if (targetRoot && existsSync(wiringPath(contextDirFor(targetRoot)))) {
            await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        }
        else {
            await pending.catch(() => {});
        }
    }
    if (!state.runCliCached) {
        const mod = await import('../cli/cli-main.js');
        state.runCliCached = mod.runCli;
    }
    const argv = Array.isArray(msg.argv) ? msg.argv.map(String) : [];
    const res = await runCliInProcess(argv, msg.cwd, state.runCliCached, msg.sessionId || null);
    const sessFlagIdx = argv.indexOf('--session');
    const explicitSid = sessFlagIdx !== -1 && argv[sessFlagIdx + 1] ? argv[sessFlagIdx + 1] : null;
    if (explicitSid)
        state.sessionCache.delete(explicitSid);
    else if (msg.sessionId)
        state.sessionCache.delete(msg.sessionId);
    else if (argv.some((a) => a.startsWith('--session=')))
        state.sessionCache.clear();
    return { id: msg.id, ...res, version: state.version, codeStamp: state.codeStamp };
}

function beginDaemonDrain(state) {
    state.draining = true;
    try {
        state.server.close();
    }
    catch { /* ignore */ }
}

const DAEMON_MSG_HANDLERS = {
    ping: (state, _msg, meta) => ({ ...meta, ok: true, hotRepos: state.hotGraphs.size, sessions: state.sessionCache.size }),
    shutdown: (state, _msg, meta) => {
        beginDaemonDrain(state);
        return { ...meta, ok: true };
    },
    invalidate: (state, msg, meta) => {
        if (msg.repoRoot) {
            state.hotGraphs.delete(msg.repoRoot);
            invalidateGraphCaches(contextDirFor(msg.repoRoot));
        }
        else {
            state.hotGraphs.clear();
        }
        return { ...meta, ok: true };
    },
    hook: (state, msg) => handleHookMessage(state, msg),
    cli: (state, msg) => handleCliMessage(state, msg),
};

async function processDaemonMessage(state, msg) {
    const meta = { id: msg.id, version: state.version, codeStamp: state.codeStamp };
    const versionMismatch = Boolean(msg.version && msg.version !== state.version);
    const stampMismatch = Boolean(msg.codeStamp && msg.codeStamp !== state.codeStamp);
    if (state.draining || versionMismatch || stampMismatch) {
        if (!state.draining)
            beginDaemonDrain(state);
        return { ...meta, ok: false, restartRequired: true };
    }
    const handler = Object.hasOwn(DAEMON_MSG_HANDLERS, msg.type) ? DAEMON_MSG_HANDLERS[msg.type] : null;
    if (handler)
        return await handler(state, msg, meta);
    return { ...meta, ok: false, exitCode: 1, stdout: '', stderr: `unknown request type: ${msg.type}` };
}

function enqueueDaemonRequest(state, conn, msg) {
    resetDaemonIdleTimer(state);
    state.inFlight += 1;
    Promise.resolve()
        .then(() => processDaemonMessage(state, msg))
        .then((res) => {
            if (!conn.destroyed)
                conn.write(`${JSON.stringify(res)}\n`);
        })
        .catch((err) => {
            if (!conn.destroyed) {
                const errMsg = err instanceof Error ? err.message : String(err);
                conn.write(`${JSON.stringify({ id: msg?.id ?? null, ok: false, exitCode: 1, stdout: '', stderr: errMsg })}\n`);
            }
        })
        .finally(() => {
            state.inFlight -= 1;
            if (state.draining && state.inFlight === 0) {
                if (!conn.destroyed)
                    conn.end();
                void closeDaemonServer(state);
            }
            else {
                resetDaemonIdleTimer(state);
            }
        });
}

function handleDaemonRawLine(state, conn, rawLine) {
    if (state.draining || state.closing) {
        try {
            const parsed = JSON.parse(rawLine);
            const payload = {
                id: parsed?.id ?? null, ok: false, restartRequired: true,
                version: state.version, codeStamp: state.codeStamp,
            };
            conn.end(`${JSON.stringify(payload)}\n`);
        }
        catch {
            try { conn.end(); } catch { /* ignore */ }
        }
        return;
    }
    let msg;
    try {
        msg = JSON.parse(rawLine);
    }
    catch {
        try { conn.write(`${JSON.stringify({ id: null, ok: false, stderr: 'invalid json' })}\n`); } catch { /* ignore */ }
        return;
    }
    enqueueDaemonRequest(state, conn, msg);
}

function endOversizedConnection(conn) {
    try {
        conn.end(`${JSON.stringify({ id: null, ok: false, stderr: 'request exceeds 2MB line limit' })}\n`);
    }
    catch { /* ignore */ }
}

function attachDaemonConnection(state, conn) {
    state.activeConns.add(conn);
    conn.on('error', () => { /* ignore client EPIPE/ECONNRESET */ });
    conn.on('close', () => state.activeConns.delete(conn));
    let buf = '';
    let tooBig = false;
    conn.on('data', (chunk) => {
        if (tooBig || state.closing)
            return;
        buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const rawLine = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (Buffer.byteLength(rawLine, 'utf8') > MAX_LINE_BYTES) {
                tooBig = true;
                buf = '';
                endOversizedConnection(conn);
                return;
            }
            if (rawLine.trim())
                handleDaemonRawLine(state, conn, rawLine.trim());
        }
        if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
            tooBig = true;
            buf = '';
            endOversizedConnection(conn);
        }
    });
}

function listenDaemonSocket(server, socketPath) {
    return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(socketPath, () => {
            server.off('error', rejectListen);
            if (process.platform !== 'win32' && !socketPath.startsWith('\\\\.\\pipe\\')) {
                try { chmodSync(socketPath, 0o600); } catch { /* ignore */ }
            }
            resolveListen();
        });
    });
}

export async function startDaemon(opts = {}) {
    const socketPath = opts.socketPath || resolveDaemonSocketPath();
    const version = opts.version || readCurrentVersion(import.meta.url);
    const codeStamp = opts.codeStamp || computeCodeStamp(opts.pkgRoot || PKG_ROOT);
    const persistent = Boolean(opts.persistent || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
    const idleTimeoutMs = persistent
        ? 0
        : (Number(opts.idleTimeoutMs ?? process.env.PLEXER_DAEMON_IDLE_MS) || DEFAULT_IDLE_TIMEOUT_MS);

    ensureSocketParentDir(socketPath);
    if (await cleanStaleSocketOrDetectLive(socketPath))
        return { socketPath, alreadyRunning: true, close: async () => {} };

    const state = {
        socketPath,
        version,
        codeStamp,
        idleTimeoutMs,
        sessionCache: createSessionLru(SESSION_CACHE_MAX_ENTRIES, SESSION_CACHE_TTL_MS),
        hotGraphs: new Map(),
        pendingRefreshTimers: new Map(),
        repoRefreshChains: new Map(),
        activeConns: new Set(),
        runCliCached: null,
        hookDispatchCached: null,
        idleTimer: null,
        closing: false,
        draining: false,
        closePromise: null,
        inFlight: 0,
        server: null,
    };
    state.server = createServer((conn) => attachDaemonConnection(state, conn));
    await listenDaemonSocket(state.server, socketPath);
    resetDaemonIdleTimer(state);

    return {
        socketPath,
        version,
        codeStamp,
        alreadyRunning: false,
        close: () => closeDaemonServer(state),
    };
}
