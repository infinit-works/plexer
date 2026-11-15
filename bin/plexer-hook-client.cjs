#!/usr/bin/env node
'use strict';
/**
 * Zero-dependency thin CJS hook client for all Plexer-integrated coding hosts.
 * Connects to hot `plexerd` over a Unix socket / named pipe (auto-spawning only on
 * connect miss) and falls back to `bin/plexer.js _hook <event>` with remaining budget.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const {
    computeCodeStamp,
    resolveSocketPath,
    sendRpc,
    waitForSocketTeardown,
} = require('../src/daemon/ipc.cjs');

const TURN0_EVENTS = new Set([
    'agy-pre-invocation',
    'user-prompt-submit',
    'gemini-before-agent',
    'cursor-before-submit',
]);

function defaultFallbackOut(event) {
    return event === 'agy-pre-tool' || event === 'agy-stop' || event === 'agy-post-cascade-response'
        ? '{"decision":"allow"}\n'
        : '{}\n';
}

function writeAll(str) {
    const buf = Buffer.from(str, 'utf8');
    let off = 0;
    while (off < buf.length) {
        try {
            off += fs.writeSync(1, buf, off, buf.length - off);
        }
        catch (err) {
            if (err && err.code === 'EAGAIN')
                continue;
            break;
        }
    }
}

function isConnectMiss(err) {
    if (!err)
        return false;
    return (
        err.phase === 'connect' ||
        err.code === 'ENOENT' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'CONNECT_TIMEOUT'
    );
}

function readRawStdin() {
    if (process.env.PLEXER_TEST_STDIN !== undefined)
        return process.env.PLEXER_TEST_STDIN;
    try {
        return fs.readFileSync(0, 'utf8');
    }
    catch {
        return '';
    }
}

function runDirectFallback({ event, rawStdin, pkgRoot, fallbackOut, timeoutMs }) {
    if (timeoutMs !== undefined && timeoutMs < 200) {
        writeAll(fallbackOut);
        return;
    }
    try {
        const out = execFileSync(process.execPath, [path.join(__dirname, 'plexer.js'), '_hook', event], {
            input: rawStdin,
            encoding: 'utf8',
            timeout: timeoutMs,
            env: {
                ...process.env,
                PLUGIN_ROOT: process.env.PLUGIN_ROOT || pkgRoot,
            },
        });
        writeAll(out || fallbackOut);
    }
    catch {
        writeAll(fallbackOut);
    }
}

function spawnDaemonProcess(pkgRoot, sockPath) {
    const child = spawn(process.execPath, [path.join(__dirname, 'plexer.js'), '_daemon'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            PLUGIN_ROOT: process.env.PLUGIN_ROOT || pkgRoot,
            PLEXER_DAEMON_SOCK: sockPath,
        },
    });
    child.unref();
}

function buildHookRequest({ event, parsedInput, version, codeStamp, pkgRoot }) {
    return {
        id: 1,
        type: 'hook',
        event,
        version,
        codeStamp,
        input: parsedInput,
        envFlags: {
            disableHooks: process.env.PLEXER_DISABLE_HOOKS === '1' ? true : undefined,
            enableBenchHooks: process.env.PLEXER_ENABLE_BENCH_HOOKS === '1' ? true : undefined,
            enableUserMarkdown: process.env.PLEXER_AGY_USER_MARKDOWN === '1' ? true : undefined,
            pluginRoot: process.env.PLUGIN_ROOT || pkgRoot,
            callerCwd: process.cwd(),
            claudeProjectDir: process.env.CLAUDE_PROJECT_DIR || undefined,
            codexProjectDir: process.env.CODEX_PROJECT_DIR || undefined,
            geminiProjectDir: process.env.GEMINI_PROJECT_DIR || undefined,
            antigravityProjectDir: process.env.ANTIGRAVITY_PROJECT_DIR || undefined,
            cursorProjectDir: process.env.CURSOR_PROJECT_DIR || undefined,
            plexerSessionId: process.env.PLEXER_SESSION_ID || undefined,
            antigravityConversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || undefined,
            claudeSessionId: process.env.CLAUDE_SESSION_ID || undefined,
            cursorTraceId: process.env.CURSOR_TRACE_ID || undefined,
        },
    };
}

function isSocketGoneOrPipe(sockPath) {
    return process.platform === 'win32' || sockPath.startsWith('\\\\.\\pipe\\') || !fs.existsSync(sockPath);
}

function parseStdinJson(rawStdin) {
    try {
        return rawStdin.trim() ? JSON.parse(rawStdin) : {};
    }
    catch {
        return {};
    }
}

async function tryExistingDaemon(ctx) {
    const { sockPath, req, codeStamp, connectTimeoutMs, rpcTimeoutMs, startedAt, totalBudgetMs, fallbackOut, event, rawStdin, pkgRoot } = ctx;
    try {
        const res = await sendRpc(sockPath, req, { connectTimeoutMs, rpcTimeoutMs });
        if (res && !res.restartRequired && res.codeStamp === codeStamp && res.ok) {
            writeAll(res.stdout || fallbackOut);
            return { handled: true, shouldSpawn: false };
        }
        if (res && (res.restartRequired || res.codeStamp !== codeStamp)) {
            if (!res.restartRequired) {
                await sendRpc(sockPath, { id: 99, type: 'shutdown' }, { connectTimeoutMs: 60, rpcTimeoutMs: 200 }).catch(() => null);
            }
            await waitForSocketTeardown(sockPath, 500);
            return { handled: false, shouldSpawn: isSocketGoneOrPipe(sockPath) };
        }
        return { handled: false, shouldSpawn: false };
    }
    catch (err) {
        if (isConnectMiss(err))
            return { handled: false, shouldSpawn: true };
        if (err && err.code === 'RPC_TIMEOUT') {
            // Live daemon is busy (e.g. cold build in progress); do not double-build in fallback.
            writeAll(fallbackOut);
            return { handled: true, shouldSpawn: false };
        }
        const remaining = Math.max(0, totalBudgetMs - (Date.now() - startedAt));
        runDirectFallback({ event, rawStdin, pkgRoot, fallbackOut, timeoutMs: remaining });
        return { handled: true, shouldSpawn: false };
    }
}

async function spawnAndRetryDaemon(ctx) {
    const { pkgRoot, sockPath, req, codeStamp, connectTimeoutMs, rpcTimeoutMs, startedAt, totalBudgetMs, fallbackOut } = ctx;
    spawnDaemonProcess(pkgRoot, sockPath);
    const readyDeadline = Date.now() + 450;
    while (Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 25));
        const remainingRpcMs = Math.max(200, totalBudgetMs - (Date.now() - startedAt));
        try {
            const res = await sendRpc(sockPath, req, {
                connectTimeoutMs,
                rpcTimeoutMs: Math.min(rpcTimeoutMs, remainingRpcMs),
            });
            if (res && !res.restartRequired && res.codeStamp === codeStamp && res.ok) {
                writeAll(res.stdout || fallbackOut);
                return true;
            }
            return false;
        }
        catch (err) {
            if (!isConnectMiss(err)) {
                if (err && err.code === 'RPC_TIMEOUT') {
                    writeAll(fallbackOut);
                    return true;
                }
                return false;
            }
        }
    }
    return false;
}

async function main() {
    const startedAt = Date.now();
    const event = process.argv[2] || 'agy-pre-invocation';
    const fallbackOut = defaultFallbackOut(event);
    if (process.env.PLEXER_DISABLE_HOOKS === '1') {
        writeAll(fallbackOut);
        return;
    }

    const rawStdin = readRawStdin();
    const parsedInput = parseStdinJson(rawStdin);
    const pkgRoot = path.resolve(__dirname, '..');
    const connectTimeoutMs = Math.max(10, Number(process.env.PLEXER_HOOK_CONNECT_TIMEOUT_MS) || 120);
    const defaultRpcMs = TURN0_EVENTS.has(event) ? 12000 : 7500;
    const rpcTimeoutMs = Math.max(50, Number(process.env.PLEXER_HOOK_RPC_TIMEOUT_MS) || defaultRpcMs);
    const totalBudgetMs = Math.max(rpcTimeoutMs + 500, TURN0_EVENTS.has(event) ? 14000 : 8500);
    if (process.env.PLEXER_NO_DAEMON === '1') {
        runDirectFallback({ event, rawStdin, pkgRoot, fallbackOut, timeoutMs: totalBudgetMs });
        return;
    }

    const codeStamp = computeCodeStamp(pkgRoot);
    const ctx = {
        startedAt, event, fallbackOut, rawStdin, pkgRoot, codeStamp,
        sockPath: resolveSocketPath(),
        req: buildHookRequest({ event, parsedInput, version: codeStamp.split(':')[0] || '', codeStamp, pkgRoot }),
        connectTimeoutMs, rpcTimeoutMs, totalBudgetMs,
    };

    const probe = await tryExistingDaemon(ctx);
    if (probe.handled)
        return;
    if (probe.shouldSpawn) {
        try {
            if (await spawnAndRetryDaemon(ctx))
                return;
        }
        catch { /* fall through to bounded direct execution */ }
    }
    const remaining = Math.max(0, totalBudgetMs - (Date.now() - startedAt));
    runDirectFallback({ event, rawStdin, pkgRoot, fallbackOut, timeoutMs: remaining });
}

if (require.main === module) {
    main().then(
        () => process.exit(0),
        () => {
            const event = process.argv[2] || 'agy-pre-invocation';
            writeAll(defaultFallbackOut(event));
            process.exit(0);
        },
    );
}

module.exports = {
    TURN0_EVENTS,
    computeCodeStamp,
    main,
    resolveSocketPath,
    sendRpc,
    waitForSocketTeardown,
};
