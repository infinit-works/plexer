#!/usr/bin/env node
'use strict';
/**
 * Zero-dependency thin CJS hook client for all Plexer-integrated coding hosts.
 * Connects to hot `plexerd` over a Unix socket / named pipe (auto-spawning only on
 * connect miss) and falls back to `bin/plexer.js _hook <event>` with remaining budget.
 */
const fs = require('node:fs');
const path = require('node:path');

let childProcMod = null;
let ipcMod = null;
const getChildProc = () => (childProcMod ??= require('node:child_process'));
const getIpc = () => (ipcMod ??= require('../src/daemon/ipc.cjs'));

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
        const out = getChildProc().execFileSync(process.execPath, [path.join(__dirname, 'plexer.js'), '_hook', event], {
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

const DAEMON_STRIP_EXACT = new Set([
    'PLEXER_SESSION_ID',
    'ANTIGRAVITY_CONVERSATION_ID',
    'ANTIGRAVITY_SIDECAR_WEB_PORT',
    'ANTIGRAVITY_AGENT',
    'ANTIGRAVITY_PROJECT_DIR',
    'PLEXER_DIR',
    'PLEXER_ENABLE_BENCH_HOOKS',
    'PLEXER_DISABLE_HOOKS',
    'PLEXER_AGY_USER_MARKDOWN',
    'PLEXER_TEST_STDIN',
]);
const DAEMON_STRIP_PREFIXES = ['CLAUDE_', 'CODEX_', 'GEMINI_', 'CURSOR_'];

function buildCleanDaemonEnv(pkgRoot, sockPath) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (DAEMON_STRIP_EXACT.has(k)) continue;
        if (DAEMON_STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
        env[k] = v;
    }
    env.PLUGIN_ROOT = process.env.PLUGIN_ROOT || pkgRoot;
    env.PLEXER_DAEMON_SOCK = sockPath;
    return env;
}

function readPkgVersion(pkgRoot) {
    try {
        return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version || '';
    }
    catch {
        return '';
    }
}

function spawnDaemonProcess(pkgRoot, sockPath) {
    const child = getChildProc().spawn(process.execPath, [path.join(__dirname, 'plexer.js'), '_daemon'], {
        detached: true,
        stdio: 'ignore',
        env: buildCleanDaemonEnv(pkgRoot, sockPath),
    });
    child.unref();
}

function buildHookRequest({ event, parsedInput, version, pkgRoot }) {
    return {
        id: 1,
        type: 'hook',
        event,
        version,
        input: parsedInput,
        envFlags: {
            disableHooks: process.env.PLEXER_DISABLE_HOOKS === '1' ? true : undefined,
            enableBenchHooks: process.env.PLEXER_ENABLE_BENCH_HOOKS === '1'
                ? true
                : (process.env.PLEXER_ENABLE_BENCH_HOOKS === '0' ? false : undefined),
            antigravityAgent: process.env.ANTIGRAVITY_AGENT === '1'
                ? true
                : (process.env.ANTIGRAVITY_AGENT === '0' ? false : undefined),
            enableUserMarkdown: process.env.PLEXER_AGY_USER_MARKDOWN === '1'
                ? true
                : (process.env.PLEXER_AGY_USER_MARKDOWN === '0' ? false : undefined),
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
    const { sockPath, req, version, connectTimeoutMs, rpcTimeoutMs, startedAt, totalBudgetMs, fallbackOut, event, rawStdin, pkgRoot } = ctx;
    const { sendRpc, waitForSocketTeardown } = getIpc();
    try {
        const res = await sendRpc(sockPath, req, { connectTimeoutMs, rpcTimeoutMs });
        const versionOk = !version || !res?.version || res.version === version;
        if (res && !res.restartRequired && versionOk && res.ok) {
            writeAll(res.stdout || fallbackOut);
            return { handled: true, shouldSpawn: false };
        }
        if (res && (res.restartRequired || !versionOk)) {
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
    const { pkgRoot, sockPath, req, version, connectTimeoutMs, rpcTimeoutMs, startedAt, totalBudgetMs, fallbackOut } = ctx;
    const { sendRpc } = getIpc();
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
            const versionOk = !version || !res?.version || res.version === version;
            if (res && !res.restartRequired && versionOk && res.ok) {
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

function canFastBypassPreTool(event, parsedInput) {
    if (
        event !== 'agy-pre-tool'
        && event !== 'pre-tool-use'
        && event !== 'claude-pre-tool'
        && event !== 'codex-pre-tool'
        && event !== 'gemini-before-tool'
    ) {
        return false;
    }
    const toolName = String(
        parsedInput?.toolCall?.name
        ?? parsedInput?.tool_name
        ?? parsedInput?.toolName
        ?? '',
    ).trim();
    if (!toolName)
        return false;
    if (!/^(?:read_file|view_file|Read|read|run_command|Bash|run_shell_command|shell|grep_search|Grep|find_by_name|Glob)$/i.test(toolName))
        return true;
    if (!/^(?:run_command|Bash|run_shell_command|shell)$/i.test(toolName))
        return false;
    const args = parsedInput?.toolCall?.args ?? parsedInput?.tool_input ?? parsedInput?.args ?? {};
    const cmd = String(args?.CommandLine ?? args?.command ?? '');
    return !/(?:^|[\s;/\\"'`])(?:plexer|cat|head|tail|sed|nl|e?grep|fgrep|rg|find)\b|\bgit\s+(?:grep|diff|log)\b/.test(cmd);
}

function hasRepoAgentsHooksJson(startDir) {
    if (!startDir) return false;
    try {
        const homeResolved = path.resolve(require('node:os').homedir());
        let cur = path.resolve(startDir);
        for (let i = 0; i < 25 && cur && cur !== homeResolved; i++) {
            const cfg = path.join(cur, '.agents', 'hooks.json');
            if (fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').includes('plexer')) {
                return true;
            }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
    } catch { /* ignore */ }
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
    const pluginNeedle = `${path.sep}.gemini${path.sep}config${path.sep}plugins${path.sep}`;
    if (event.startsWith('agy-') && process.env.PLEXER_TEST_STDIN === undefined && __dirname.includes(pluginNeedle)) {
        const projectHint = process.env.ANTIGRAVITY_PROJECT_DIR || parsedInput?.workspacePaths?.[0] || process.cwd();
        if (hasRepoAgentsHooksJson(projectHint)) {
            writeAll(fallbackOut);
            return;
        }
    }
    if (canFastBypassPreTool(event, parsedInput)) {
        writeAll(fallbackOut);
        return;
    }
    const pkgRoot = path.resolve(__dirname, '..');
    const connectTimeoutMs = Math.max(10, Number(process.env.PLEXER_HOOK_CONNECT_TIMEOUT_MS) || 120);
    const defaultRpcMs = TURN0_EVENTS.has(event) ? 12000 : 7500;
    const rpcTimeoutMs = Math.max(50, Number(process.env.PLEXER_HOOK_RPC_TIMEOUT_MS) || defaultRpcMs);
    const totalBudgetMs = Math.max(rpcTimeoutMs + 500, TURN0_EVENTS.has(event) ? 14000 : 8500);
    if (process.env.PLEXER_NO_DAEMON === '1') {
        runDirectFallback({ event, rawStdin, pkgRoot, fallbackOut, timeoutMs: totalBudgetMs });
        return;
    }

    const { resolveSocketPath } = getIpc();
    const version = readPkgVersion(pkgRoot);
    const ctx = {
        startedAt, event, fallbackOut, rawStdin, pkgRoot, version,
        sockPath: resolveSocketPath(),
        req: buildHookRequest({ event, parsedInput, version, pkgRoot }),
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
    computeCodeStamp: (...a) => getIpc().computeCodeStamp(...a),
    main,
    resolveSocketPath: (...a) => getIpc().resolveSocketPath(...a),
    sendRpc: (...a) => getIpc().sendRpc(...a),
    waitForSocketTeardown: (...a) => getIpc().waitForSocketTeardown(...a),
};
