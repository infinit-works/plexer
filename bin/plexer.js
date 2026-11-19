#!/usr/bin/env node
/**
 * `plexer` CLI bootstrapper — zero static imports so `_hook` and `version` start in ~15ms.
 */
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
    const type = typeof args[0] === "string" ? args[0] : (args[0]?.type ?? warning?.name);
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && typeof msg === "string" && msg.includes("SQLite")) {
        return;
    }
    return origEmitWarning.call(this, warning, ...args);
};

const sub = process.argv[2];

function hookFallbackOutput(event) {
    return event === "agy-pre-tool" || event === "agy-stop" || event === "agy-post-cascade-response"
        ? '{"decision":"allow"}\n'
        : "{}\n";
}

function resolveEnvSessionId(env = process.env) {
    return (
        env.PLEXER_SESSION_ID ||
        env.ANTIGRAVITY_CONVERSATION_ID ||
        env.CLAUDE_SESSION_ID ||
        env.CURSOR_TRACE_ID ||
        null
    );
}

if (sub === "_hook") {
    const event = process.argv[3];
    if (process.env.PLEXER_DISABLE_HOOKS === "1") {
        process.stdout.write(hookFallbackOutput(event));
        process.exit(0);
    }
    try {
        const { dispatchHostEvent } = await import("../src/hosts/engine/dispatcher.js");
        await dispatchHostEvent(event);
    }
    catch {
        if (event?.startsWith("agy-")) {
            process.stdout.write(hookFallbackOutput(event));
        }
        else {
            const { main } = await import("../src/claude/hooks.js");
            await main(event);
        }
    }
    process.exit(0);
}
if (sub === "_daemon") {
    const { startDaemon } = await import("../src/daemon/plexerd.js");
    await startDaemon();
    // Keep event loop alive until server closes on idle timeout or shutdown RPC.
}
else {
    if (
        process.env.PLEXER_ENABLE_BENCH_HOOKS === "0" ||
        process.env.PLEXER_BENCH_HIDE_CLI === "1" ||
        /\/tmp\/plexer-(?:ab|swebench|large)-[^/]*-(?:cold|trail)(?:\/|$)/.test(process.cwd())
    ) {
        process.stderr.write("plexer: command not available in this environment\n");
        process.exit(127);
    }
    if (sub === "version" || (process.argv.length === 3 && (sub === "-v" || sub === "-V" || sub === "--version"))) {
        const { readCurrentVersion } = await import("../src/util/cli-meta.js");
        const ver = readCurrentVersion(import.meta.url);
        console.log(sub === "version" ? `plexer ${ver}` : ver);
        process.exit(0);
    }

    const READ_FAST_SUBCOMMANDS = new Set(["read", "ask", "callers", "callees", "impact", "skeleton", "grep", "map", "blast", "_batch"]);
    const canTryDaemon =
        READ_FAST_SUBCOMMANDS.has(sub) &&
        process.env.PLEXER_NO_DAEMON !== "1" &&
        !process.env.PLEXER_DIR &&
        !process.argv.includes("--dir") &&
        !process.argv.includes("--no-daemon") &&
        !process.argv.includes("--help") &&
        !process.argv.includes("-h");

    let handledByDaemon = false;
    if (canTryDaemon) {
        try {
            const [
                { existsSync },
                { spawn },
                { dirname, resolve },
                { fileURLToPath },
                { computeCodeStamp, resolveDaemonSocketPath, sendDaemonRpc, waitForSocketTeardown },
                { readCurrentVersion },
            ] = await Promise.all([
                import("node:fs"),
                import("node:child_process"),
                import("node:path"),
                import("node:url"),
                import("../src/daemon/socket-path.js"),
                import("../src/util/cli-meta.js"),
            ]);
            const sockPath = resolveDaemonSocketPath();
            const isPipe = process.platform === "win32" || sockPath.startsWith("\\\\.\\pipe\\");
            if (!isPipe && !existsSync(sockPath)) {
                try {
                    const cliPath = fileURLToPath(import.meta.url);
                    const child = spawn(process.execPath, [cliPath, "_daemon"], {
                        detached: true,
                        stdio: "ignore",
                        env: { ...process.env, PLEXER_DAEMON_SOCK: sockPath },
                    });
                    child.unref();
                } catch { /* fall back to local CLI */ }
            }
            if (isPipe || existsSync(sockPath)) {
                const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
                const version = readCurrentVersion(import.meta.url);
                const codeStamp = computeCodeStamp(pkgRoot);
                const req = {
                    id: 1,
                    type: "cli",
                    version,
                    codeStamp,
                    argv: process.argv.slice(2),
                    cwd: process.cwd(),
                    sessionId: resolveEnvSessionId(),
                };
                let res = await sendDaemonRpc(sockPath, req, { connectTimeoutMs: 120, rpcTimeoutMs: 5000 }).catch(() => null);
                if (res && (res.restartRequired || res.codeStamp !== codeStamp)) {
                    if (!res.restartRequired) {
                        await sendDaemonRpc(sockPath, { id: 99, type: "shutdown" }, { connectTimeoutMs: 60, rpcTimeoutMs: 200 }).catch(() => null);
                    }
                    await waitForSocketTeardown(sockPath, 500);
                    res = null;
                    const isPipe = process.platform === "win32" || sockPath.startsWith("\\\\.\\pipe\\");
                    if (isPipe || !existsSync(sockPath)) {
                        const cliPath = fileURLToPath(import.meta.url);
                        const child = spawn(process.execPath, [cliPath, "_daemon"], {
                            detached: true,
                            stdio: "ignore",
                            env: { ...process.env, PLEXER_DAEMON_SOCK: sockPath },
                        });
                        child.unref();
                        const deadline = Date.now() + 450;
                        while (Date.now() < deadline) {
                            await new Promise((r) => setTimeout(r, 25));
                            const nextRes = await sendDaemonRpc(sockPath, req, { connectTimeoutMs: 120, rpcTimeoutMs: 5000 }).catch(() => null);
                            if (nextRes && !nextRes.restartRequired && nextRes.codeStamp === codeStamp) {
                                res = nextRes;
                                break;
                            }
                        }
                    }
                }
                if (res && !res.restartRequired && res.codeStamp === codeStamp && typeof res.exitCode === "number") {
                    if (res.stdout)
                        process.stdout.write(res.stdout);
                    if (res.stderr)
                        process.stderr.write(res.stderr);
                    handledByDaemon = true;
                    process.exit(res.exitCode);
                }
            }
        }
        catch { /* fall back to local CLI */ }
    }

    if (!handledByDaemon) {
        const { runCli } = await import("../src/cli/cli-main.js");
        await runCli(process.argv);
    }
}
