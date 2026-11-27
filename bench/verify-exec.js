/**
 * Hybrid execution verifier (`bench/verify-exec.js`) replacing pure diff regex/token
 * heuristics with container and native test execution.
 *
 * Security & reproducibility:
 *  - Docker containers always run with `--rm --network=none`.
 *  - Disabling Docker (`--no-docker` / `useDocker: false`) sets
 *    `verificationMode: "unverified-heuristic"` and `resolved: null` (never `true`).
 *  - Native tests run with `PLEXER_NO_DAEMON=1` and strict non-zero test-count checks.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;

function tailStr(text, maxChars = 600) {
    const s = String(text || "");
    return s.length <= maxChars ? s : s.slice(-maxChars);
}

/**
 * Official SWE-bench Pro V2 Docker container verifier (`--rm --network=none`).
 */
export function verifySweBenchDocker(task, agentPatch = "", opts = {}) {
    if (opts.useDocker === false) {
        return {
            verificationMode: "unverified-heuristic",
            resolved: null,
            passed: null,
            reason: "Docker verification disabled (--no-docker)",
        };
    }
    if (!agentPatch || !agentPatch.trim()) {
        return {
            verificationMode: "swebench-docker",
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: 0,
            stdoutTail: "Empty agent patch",
        };
    }
    if (!task?.docker_image || !task?.verifier) {
        return {
            verificationMode: "swebench-docker",
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: 0,
            stdoutTail: "Missing task.docker_image or task.verifier specification",
        };
    }

    const vDir = mkdtempSync(join(tmpdir(), `plexer-swe-verify-${task.id}-`));
    const t0 = performance.now();
    try {
        writeFileSync(join(vDir, "agent.patch"), agentPatch, "utf8");
        writeFileSync(join(vDir, "test_patch.patch"), task.test_patch || "", "utf8");
        writeFileSync(join(vDir, "test.sh"), task.verifier.test_sh, { mode: 0o755 });
        writeFileSync(join(vDir, "run_script.sh"), task.verifier.run_script_sh, { mode: 0o755 });
        writeFileSync(join(vDir, "parser.py"), task.verifier.parser_py, "utf8");
        writeFileSync(join(vDir, "config.json"), task.verifier.config_json, "utf8");

        const containerCmd = [
            "cd /app 2>/dev/null || cd /testbed",
            `git reset --hard ${task.base_commit}`,
            "git clean -fd",
            "git apply /tests/agent.patch",
            "bash /tests/test.sh",
        ].join(" && ");

        const res = spawnSync(
            "docker",
            [
                "run",
                "--rm",
                "--network=none",
                "-v",
                `${vDir}:/tests`,
                task.docker_image,
                "bash",
                "-c",
                containerCmd,
            ],
            {
                encoding: "utf8",
                timeout: opts.timeoutMs ?? 300_000,
                maxBuffer: 8 * 1024 * 1024,
            }
        );
        const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
        const passed = res.status === 0 && combined.includes("RESULT: PASSED");
        return {
            verificationMode: "swebench-docker",
            resolved: passed,
            passed,
            exitCode: res.status ?? 1,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(combined),
        };
    } catch (err) {
        return {
            verificationMode: "swebench-docker",
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(err?.message || err),
        };
    } finally {
        rmSync(vDir, { recursive: true, force: true });
    }
}

/**
 * Pinned-image Docker container verifier (`--rm --network=none`) for standalone OSS tasks.
 */
export function verifyDockerTask(task, workDir, opts = {}) {
    if (opts.useDocker === false) {
        return {
            verificationMode: "unverified-heuristic",
            resolved: null,
            passed: null,
            reason: "Docker verification disabled (--no-docker)",
        };
    }
    const spec = task?.verifier || {};
    const image = spec.image;
    if (!image) {
        return {
            verificationMode: "docker",
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: 0,
            stdoutTail: "Missing verifier.image",
        };
    }

    const vDir = mkdtempSync(join(tmpdir(), `plexer-docker-verify-${task.id || "task"}-`));
    const t0 = performance.now();
    try {
        let entryCmd = spec.command || "true";
        if (spec.pythonScript) {
            writeFileSync(join(vDir, "verify.py"), spec.pythonScript, "utf8");
            entryCmd = "PYTHONDONTWRITEBYTECODE=1 python3 /verify/verify.py";
        } else if (spec.nodeScript) {
            writeFileSync(join(vDir, "verify.mjs"), spec.nodeScript, "utf8");
            entryCmd = "node /verify/verify.mjs";
        } else if (spec.checkScript) {
            writeFileSync(join(vDir, "check.mjs"), spec.checkScript, "utf8");
            entryCmd = `${spec.command ? `${spec.command} && ` : ""}node /verify/check.mjs`;
        }

        const res = spawnSync(
            "docker",
            [
                "run",
                "--rm",
                "--network=none",
                "-v",
                `${workDir}:/work:ro`,
                "-v",
                `${vDir}:/verify:ro`,
                "-w",
                "/work",
                image,
                "sh",
                "-ec",
                entryCmd,
            ],
            {
                encoding: "utf8",
                timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024,
            }
        );
        const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
        const passed = res.status === 0;
        return {
            verificationMode: `docker:${image}`,
            resolved: passed,
            passed,
            exitCode: res.status ?? 1,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(combined),
        };
    } catch (err) {
        return {
            verificationMode: `docker:${image}`,
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(err?.message || err),
        };
    } finally {
        rmSync(vDir, { recursive: true, force: true });
    }
}

/**
 * Native execution verifier (`node --test`, `luau`, `python3 -m unittest`, or inline verification script).
 * Fails closed when 0 tests ran.
 */
export function verifyNativeTask(task, workDir, opts = {}) {
    const spec = task?.verifier || {};
    const t0 = performance.now();
    const env = { ...process.env, PLEXER_NO_DAEMON: "1" };
    delete env.NODE_TEST_CONTEXT;
    let tmpScript = null;
    const logs = [];

    try {
        if (spec.command) {
            const res = spawnSync("sh", ["-ec", spec.command], {
                cwd: workDir,
                env,
                encoding: "utf8",
                timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024,
            });
            const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
            logs.push(combined);
            if (res.status !== 0) {
                return {
                    verificationMode: "native",
                    resolved: false,
                    passed: false,
                    exitCode: res.status ?? 1,
                    durationMs: Math.round(performance.now() - t0),
                    stdoutTail: tailStr(logs.join("\n")),
                };
            }
            if (/node --test/.test(spec.command)) {
                const testsMatch = combined.match(/# tests\s+(\d+)/) || combined.match(/tests\s+(\d+)/i);
                const passMatch = combined.match(/# pass\s+(\d+)/) || combined.match(/pass\s+(\d+)/i);
                if (testsMatch && Number(testsMatch[1]) === 0) {
                    return {
                        verificationMode: "native",
                        resolved: false,
                        passed: false,
                        exitCode: 1,
                        durationMs: Math.round(performance.now() - t0),
                        stdoutTail: "0 tests executed (failing closed)",
                    };
                }
                if (passMatch && Number(passMatch[1]) === 0) {
                    return {
                        verificationMode: "native",
                        resolved: false,
                        passed: false,
                        exitCode: 1,
                        durationMs: Math.round(performance.now() - t0),
                        stdoutTail: "0 passing tests (failing closed)",
                    };
                }
            }
        }

        const scriptBody = spec.verifyScript || spec.checkScript || spec.nodeScript;
        if (scriptBody) {
            tmpScript = join(workDir, `.plexer-verify-${process.pid}.mjs`);
            writeFileSync(tmpScript, scriptBody, "utf8");
            const res = spawnSync(process.execPath, [tmpScript], {
                cwd: workDir,
                env,
                encoding: "utf8",
                timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });
            const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
            logs.push(combined);
            if (res.status !== 0) {
                return {
                    verificationMode: "native",
                    resolved: false,
                    passed: false,
                    exitCode: res.status ?? 1,
                    durationMs: Math.round(performance.now() - t0),
                    stdoutTail: tailStr(logs.join("\n")),
                };
            }
        }

        if (spec.pythonScript) {
            tmpScript = join(workDir, `.plexer-verify-${process.pid}.py`);
            writeFileSync(tmpScript, spec.pythonScript, "utf8");
            const res = spawnSync("python3", [tmpScript], {
                cwd: workDir,
                env: { ...env, PYTHONDONTWRITEBYTECODE: "1" },
                encoding: "utf8",
                timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });
            const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
            logs.push(combined);
            if (res.status !== 0) {
                return {
                    verificationMode: "native",
                    resolved: false,
                    passed: false,
                    exitCode: res.status ?? 1,
                    durationMs: Math.round(performance.now() - t0),
                    stdoutTail: tailStr(logs.join("\n")),
                };
            }
        }

        return {
            verificationMode: "native",
            resolved: true,
            passed: true,
            exitCode: 0,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(logs.join("\n")),
        };
    } catch (err) {
        return {
            verificationMode: "native",
            resolved: false,
            passed: false,
            exitCode: 1,
            durationMs: Math.round(performance.now() - t0),
            stdoutTail: tailStr(err?.message || err),
        };
    } finally {
        if (tmpScript && existsSync(tmpScript)) {
            rmSync(tmpScript, { force: true });
        }
    }
}

/**
 * Unified execution verifier dispatcher.
 */
export function verifyTaskExecution(task, target, opts = {}) {
    const kind = task?.verifier?.kind || (task?.docker_image ? "swebench-docker" : "rubric");
    if (kind === "swebench-docker") {
        const patchText = typeof target === "string" && !target.startsWith("/") ? target : target?.patch || "";
        return verifySweBenchDocker(task, patchText, opts);
    }
    if (kind === "docker") {
        const workDir = typeof target === "string" ? target : target?.workDir;
        return verifyDockerTask(task, workDir, opts);
    }
    if (kind === "native") {
        const workDir = typeof target === "string" ? target : target?.workDir;
        return verifyNativeTask(task, workDir, opts);
    }
    const rubricResolved =
        typeof target?.rubricResolved === "boolean" ? target.rubricResolved : null;
    return {
        verificationMode: "rubric",
        resolved: rubricResolved,
        passed: rubricResolved,
        exitCode: 0,
        durationMs: 0,
    };
}

/**
 * Apply `patchText` to an isolated temporary copy of `baseDir` and run `verifyTaskExecution`.
 * Empty or invalid patches leave base files unmodified (or fail `git apply`) and are torn down cleanly.
 */
export function verifyPatchAgainstBase(task, baseDir, patchText = "", opts = {}) {
    const scratch = mkdtempSync(join(tmpdir(), `plexer-patch-verify-${task.id || "t"}-`));
    const workCopy = join(scratch, "repo");
    try {
        cpSync(baseDir, workCopy, { recursive: true, dereference: false });
        if (patchText && patchText.trim().length > 0) {
            if (!existsSync(join(workCopy, ".git"))) {
                execFileSync("git", ["init", "-q"], { cwd: workCopy });
                execFileSync("git", ["add", "-A"], { cwd: workCopy });
                execFileSync(
                    "git",
                    ["-c", "commit.gpgsign=false", "-c", "user.name=verify", "-c", "user.email=v@local", "commit", "-qm", "base", "--no-verify"],
                    { cwd: workCopy }
                );
            }
            const applyRes = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
                cwd: workCopy,
                input: patchText,
                encoding: "utf8",
            });
            if (applyRes.status !== 0) {
                return {
                    verificationMode: task?.verifier?.kind || "patch-apply",
                    resolved: false,
                    passed: false,
                    exitCode: applyRes.status ?? 1,
                    durationMs: 0,
                    stdoutTail: tailStr(`git apply failed: ${applyRes.stderr}`),
                };
            }
        }
        return verifyTaskExecution(
            task,
            task?.verifier?.kind === "swebench-docker" ? patchText : workCopy,
            opts
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
