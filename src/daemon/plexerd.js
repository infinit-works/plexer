/**
 * Hot-RAM local daemon (`plexerd`) keeping repo graphs and session state cached
 * across multi-host hook steps and CLI queries over a user-scoped Unix socket.
 */
import { chmodSync, closeSync, constants, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { readCurrentVersion } from '../util/cli-meta.js';
import { contextDirFor } from '../util/paths.js';
import { computeCodeStamp, ensureSocketParentDir, resolveDaemonSocketPath } from './socket-path.js';

let runtimeMods = null;
let runtimeModsPromise = null;

async function loadRuntimeMods() {
    if (runtimeMods)
        return runtimeMods;
    if (!runtimeModsPromise) {
        runtimeModsPromise = Promise.all([
            import('../agy/session.js'),
            import('../agy/spans.js'),
            import('../context/graph-store.js'),
            import('../context/node-file.js'),
            import('../graph/fingerprint.js'),
            import('../graph/refresh.js'),
            import('../graph/root.js'),
            import('../hosts/engine/agy-context.js'),
            import('../storage/sqlite-store.js'),
        ]).then(([agySess, agySpans, graphStore, nodeFile, fp, refresh, root, agyCtx, sqliteStore]) => {
            runtimeMods = {
                readAgySession: agySess.readAgySession,
                writeAgySession: agySess.writeAgySession,
                mergeSpan: agySpans.mergeSpan,
                loadGraphCached: graphStore.loadGraphCached,
                invalidateGraphCaches: graphStore.invalidateGraphCaches,
                wiringPath: nodeFile.wiringPath,
                probeDrift: fp.probeDrift,
                ensureFreshGraph: refresh.ensureFreshGraph,
                nearestPlexerRoot: root.nearestPlexerRoot,
                resolveHostSessionId: agyCtx.resolveHostSessionId,
                sqliteHasGraph: sqliteStore.sqliteHasGraph,
            };
            return runtimeMods;
        });
    }
    return runtimeModsPromise;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_CACHE_MAX_ENTRIES = 64;
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const CODE_STAMP_THROTTLE_MS = 3000;
const DRIFT_COALESCE_TTL_MS = 300;
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

async function runCliInProcess(argv, cwd, runCliFn, sessionId = null, sessionCache = null, probeDriftFn = null) {
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
            sessionCache,
            probeDrift: probeDriftFn,
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

function runSerializedForSession(state, sid, fn) {
    const key = sid ? String(sid) : null;
    if (!key || key === 'default')
        return Promise.resolve().then(fn);
    const prev = state.sessionChains.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tracked = next.finally(() => {
        if (state.sessionChains.get(key) === tracked)
            state.sessionChains.delete(key);
    });
    state.sessionChains.set(key, tracked);
    return next;
}

function getHotGraphForState(state, repoRoot) {
    if (!repoRoot || !runtimeMods)
        return null;
    const ctxDir = contextDirFor(resolve(repoRoot));
    if (!existsSync(ctxDir))
        return null;
    return runtimeMods.loadGraphCached(ctxDir);
}

function probeDriftCached(state, repoRoot, outDir) {
    if (!runtimeMods)
        return null;
    const absRoot = resolve(repoRoot);
    const key = `${absRoot}::${outDir || ''}`;
    const now = Date.now();
    const cached = state.driftCache.get(key);
    if (cached && now - cached.ts < DRIFT_COALESCE_TTL_MS)
        return cached.drift;
    const drift = runtimeMods.probeDrift(absRoot, outDir);
    if (state.driftCache.size >= 64)
        state.driftCache.delete(state.driftCache.keys().next().value);
    state.driftCache.set(key, { drift, ts: now });
    return drift;
}

function invalidateDriftCache(state, repoRoot) {
    if (!repoRoot)
        return;
    const prefix = `${resolve(repoRoot)}::`;
    for (const k of state.driftCache.keys()) {
        if (k.startsWith(prefix))
            state.driftCache.delete(k);
    }
}

function scheduleRefreshForState(state, repoRoot) {
    if (state.closing || state.draining || !repoRoot)
        return;
    const absRoot = resolve(repoRoot);
    invalidateDriftCache(state, absRoot);
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
                const rt = await loadRuntimeMods();
                await rt.ensureFreshGraph(absRoot);
                invalidateDriftCache(state, absRoot);
                rt.invalidateGraphCaches(contextDirFor(absRoot));
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
    const [rt] = await Promise.all([
        loadRuntimeMods(),
        state.hookDispatchCached
            ? Promise.resolve(state.hookDispatchCached)
            : import('../hosts/engine/dispatcher.js').then((mod) => {
                state.hookDispatchCached = mod.dispatchHostEvent;
                return state.hookDispatchCached;
            }),
    ]);
    const sid = rt.resolveHostSessionId(msg.input ?? {}, msg.envFlags ?? {});
    const stdout = await runSerializedForSession(state, sid, () => state.hookDispatchCached(msg.event, msg.input ?? {}, {
        captureStdout: true,
        pluginRoot: msg.envFlags?.pluginRoot,
        callerCwd: msg.envFlags?.callerCwd,
        envFlags: msg.envFlags,
        sessionCache: state.sessionCache,
        getGraph: (repoRoot) => getHotGraphForState(state, repoRoot),
        probeDrift: (repoRoot, outDir) => probeDriftCached(state, repoRoot, outDir),
        withRepoLock: (repoRoot, fn) => runSerializedForRepo(state, repoRoot, fn),
        scheduleRefresh: (repoRoot) => scheduleRefreshForState(state, repoRoot),
        hasInFlightRefresh: (repoRoot) => Boolean(repoRoot && state.repoRefreshChains.has(resolve(repoRoot))),
        onFileEdited: (repoRoot) => {
            invalidateDriftCache(state, repoRoot);
            scheduleRefreshForState(state, repoRoot);
        },
        onGraphRefreshed: (repoRoot) => {
            invalidateDriftCache(state, repoRoot);
            rt.invalidateGraphCaches(contextDirFor(resolve(repoRoot)));
        },
    }));
    return {
        id: msg.id, ok: true, exitCode: 0, stdout: String(stdout ?? ''), stderr: '',
        version: state.version, codeStamp: state.codeStamp,
    };
}

function extractCliSessionId(argv, msgSessionId) {
    const idx = argv.indexOf('--session');
    if (idx !== -1 && argv[idx + 1])
        return String(argv[idx + 1]);
    const eq = argv.find((a) => a.startsWith('--session='));
    if (eq)
        return eq.slice('--session='.length) || null;
    return msgSessionId ? String(msgSessionId) : null;
}

const READ_ONLY_CLI_SUBS = new Set([
    'read', 'ask', 'callers', 'callees', 'impact', 'skeleton', 'grep', 'map', 'blast', '_batch',
]);
const SPAN_WRITING_CLI_SUBS = new Set(['read', 'callers', 'callees', 'impact', 'grep', '_batch']);

function snapshotSessionForCli(cached) {
    if (!cached || typeof cached !== 'object') return null;
    const seen = {};
    if (cached.seenSpans && typeof cached.seenSpans === 'object') {
        for (const [k, intervals] of Object.entries(cached.seenSpans)) {
            if (Array.isArray(intervals)) seen[k] = intervals.map((p) => (Array.isArray(p) ? [...p] : p));
        }
    }
    return { ...cached, seenSpans: seen };
}

function mergeSeenSpansFromSnapshot(rt, state, sid, postState) {
    if (!sid || !postState?.seenSpans) return;
    const live = state.sessionCache.get(sid) ?? rt.readAgySession(sid);
    if (!live.seenSpans || typeof live.seenSpans !== 'object') live.seenSpans = {};
    let mergedAny = false;
    for (const [k, intervals] of Object.entries(postState.seenSpans)) {
        if (!Array.isArray(intervals)) continue;
        for (const pair of intervals) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const s = Number(pair[0]);
            const e = Number(pair[1]);
            if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s) {
                if (rt.mergeSpan(live.seenSpans, k, s, e)) mergedAny = true;
            }
        }
    }
    state.sessionCache.set(sid, live);
    if (mergedAny) {
        try { rt.writeAgySession(sid, live); } catch { /* best-effort persist */ }
    }
}

async function handleCliMessage(state, msg) {
    const [rt] = await Promise.all([
        loadRuntimeMods(),
        state.runCliCached
            ? Promise.resolve(state.runCliCached)
            : import('../cli/cli-main.js').then((mod) => {
                state.runCliCached = mod.runCli;
                return state.runCliCached;
            }),
    ]);
    const baseCwd = msg.cwd && existsSync(msg.cwd) ? resolve(msg.cwd) : null;
    const targetRoot = baseCwd ? (rt.nearestPlexerRoot(baseCwd)?.root ?? baseCwd) : null;
    const pending = targetRoot ? state.repoRefreshChains.get(resolve(targetRoot)) : null;
    if (pending) {
        const targetCtxDir = contextDirFor(targetRoot);
        if (targetRoot && (rt.sqliteHasGraph(targetCtxDir) || existsSync(rt.wiringPath(targetCtxDir)))) {
            await Promise.race([pending.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        }
        else {
            await pending.catch(() => {});
        }
    }
    const argv = Array.isArray(msg.argv) ? msg.argv.map(String) : [];
    const sid = extractCliSessionId(argv, msg.sessionId);
    const sub = argv.find((a) => !a.startsWith('-')) || argv[0];
    const isReadOnlyCli = READ_ONLY_CLI_SUBS.has(sub);
    if (isReadOnlyCli) {
        const snap = sid ? snapshotSessionForCli(state.sessionCache.get(sid)) : null;
        const reqSessionCache = sid ? new Map(snap ? [[sid, snap]] : []) : null;
        const res = await runCliInProcess(
            argv,
            msg.cwd,
            state.runCliCached,
            msg.sessionId || null,
            reqSessionCache,
            (repoRoot, outDir) => probeDriftCached(state, repoRoot, outDir),
        );
        if (sid && SPAN_WRITING_CLI_SUBS.has(sub)) {
            await runSerializedForSession(state, sid, () => {
                try {
                    const postState = reqSessionCache?.get(sid) ?? rt.readAgySession(sid);
                    mergeSeenSpansFromSnapshot(rt, state, sid, postState);
                }
                catch { /* ignore */ }
            });
        }
        return { id: msg.id, ...res, version: state.version, codeStamp: state.codeStamp };
    }
    const res = await runSerializedForSession(state, sid, () => runCliInProcess(
        argv,
        msg.cwd,
        state.runCliCached,
        msg.sessionId || null,
        state.sessionCache,
        (repoRoot, outDir) => probeDriftCached(state, repoRoot, outDir),
    ));
    if (sid && SPAN_WRITING_CLI_SUBS.has(sub)) {
        try {
            state.sessionCache.set(sid, rt.readAgySession(sid));
        }
        catch { /* ignore */ }
    }
    return { id: msg.id, ...res, version: state.version, codeStamp: state.codeStamp };
}

function beginDaemonDrain(state) {
    state.draining = true;
    if (process.platform !== 'win32' && state.socketPath && !state.socketPath.startsWith('\\\\.\\pipe\\')) {
        try { unlinkSync(state.socketPath); } catch { /* ignore */ }
    }
    try {
        state.server.close();
    }
    catch { /* ignore */ }
}

const DAEMON_MSG_HANDLERS = {
    ping: (state, _msg, meta) => ({ ...meta, ok: true, sessions: state.sessionCache.size }),
    shutdown: (state, _msg, meta) => {
        beginDaemonDrain(state);
        return { ...meta, ok: true };
    },
    invalidate: async (state, msg, meta) => {
        const rt = await loadRuntimeMods();
        if (msg.repoRoot) {
            invalidateDriftCache(state, msg.repoRoot);
            rt.invalidateGraphCaches(contextDirFor(resolve(msg.repoRoot)));
        }
        else {
            state.driftCache.clear();
            rt.invalidateGraphCaches();
        }
        return { ...meta, ok: true };
    },
    hook: (state, msg) => handleHookMessage(state, msg),
    cli: (state, msg) => handleCliMessage(state, msg),
};

async function processDaemonMessage(state, msg) {
    if (!state.fixedCodeStamp && !state.draining) {
        if (!state.codeStamp) {
            state.codeStamp = computeCodeStamp(state.pkgRoot);
            state.lastCodeStampCheckMs = Date.now();
        }
        else {
            const now = Date.now();
            if (now - state.lastCodeStampCheckMs >= CODE_STAMP_THROTTLE_MS) {
                state.lastCodeStampCheckMs = now;
                const freshStamp = computeCodeStamp(state.pkgRoot);
                if (freshStamp !== state.codeStamp) {
                    state.codeStamp = freshStamp;
                    beginDaemonDrain(state);
                    return { id: msg.id, version: state.version, codeStamp: state.codeStamp, ok: false, restartRequired: true };
                }
            }
        }
    }
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
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let tooBig = false;
    conn.on('data', (chunk) => {
        if (tooBig || state.closing)
            return;
        buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
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

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err?.code === 'EPERM';
    }
}

async function acquireDaemonBindLock(socketPath, timeoutMs = 2000) {
    if (process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\')) {
        return { acquired: true, alreadyRunning: false, release: () => {} };
    }
    const lockPath = `${socketPath}.lock`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            let dev = null;
            let ino = null;
            try {
                writeSync(fd, `${process.pid}\n`);
                const st = statSync(lockPath);
                dev = st.dev;
                ino = st.ino;
            }
            catch { /* ignore */ }
            try { closeSync(fd); } catch { /* ignore */ }
            return {
                acquired: true,
                alreadyRunning: false,
                release: () => {
                    try {
                        if (dev !== null && ino !== null) {
                            const cur = statSync(lockPath);
                            if (cur.dev !== dev || cur.ino !== ino)
                                return;
                        }
                        unlinkSync(lockPath);
                    }
                    catch { /* ignore */ }
                },
            };
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                throw err;
            try {
                const st = statSync(lockPath);
                const rawPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
                const ageMs = Date.now() - st.mtimeMs;
                const stale = ageMs > 5000 || (Number.isInteger(rawPid) && rawPid > 0 && !isPidAlive(rawPid));
                if (stale) {
                    const cur = statSync(lockPath);
                    if (cur.dev === st.dev && cur.ino === st.ino) {
                        unlinkSync(lockPath);
                        continue;
                    }
                }
            }
            catch { /* lock vanished or unreadable */ }
            if (await isSocketAlive(socketPath, 40)) {
                return { acquired: false, alreadyRunning: true, release: () => {} };
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }
    return { acquired: false, alreadyRunning: await isSocketAlive(socketPath, 40), release: () => {} };
}

export async function startDaemon(opts = {}) {
    const socketPath = opts.socketPath || resolveDaemonSocketPath();
    const pkgRoot = opts.pkgRoot || PKG_ROOT;
    const version = opts.version || readCurrentVersion(import.meta.url);
    const persistent = Boolean(opts.persistent || process.argv.includes('--persistent') || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
    const idleTimeoutMs = persistent
        ? 0
        : (Number(opts.idleTimeoutMs ?? process.env.PLEXER_DAEMON_IDLE_MS) || DEFAULT_IDLE_TIMEOUT_MS);

    ensureSocketParentDir(socketPath);
    if (await isSocketAlive(socketPath))
        return { socketPath, alreadyRunning: true, close: async () => {} };

    const bindLock = await acquireDaemonBindLock(socketPath);
    if (!bindLock.acquired) {
        if (bindLock.alreadyRunning || await isSocketAlive(socketPath))
            return { socketPath, alreadyRunning: true, close: async () => {} };
        throw new Error(`timed out waiting for daemon lock: ${socketPath}.lock`);
    }

    try {
        if (await cleanStaleSocketOrDetectLive(socketPath))
            return { socketPath, alreadyRunning: true, close: async () => {} };

        const state = {
            socketPath,
            pkgRoot,
            version,
            codeStamp: opts.codeStamp || '',
            fixedCodeStamp: Boolean(opts.codeStamp),
            lastCodeStampCheckMs: opts.codeStamp ? Date.now() : 0,
            idleTimeoutMs,
            sessionCache: createSessionLru(SESSION_CACHE_MAX_ENTRIES, SESSION_CACHE_TTL_MS),
            sessionChains: new Map(),
            driftCache: new Map(),
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
        if (!state.codeStamp) {
            state.codeStamp = computeCodeStamp(pkgRoot);
            state.lastCodeStampCheckMs = Date.now();
        }

        return {
            socketPath,
            version,
            codeStamp: state.codeStamp,
            alreadyRunning: false,
            close: () => closeDaemonServer(state),
        };
    }
    finally {
        bindLock.release();
    }
}
