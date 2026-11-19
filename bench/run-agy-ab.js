#!/usr/bin/env node
/**
 * Reproducible A/B runner for Antigravity CLI (`agy`) across all 12 tasks (`T1`–`T12`)
 * in `bench/tasks.js` using Gemini 4 Neon (`neon-low`, `neon-medium`, `neon-high`, `neon-xhigh`),
 * Gemini 4 Carbon (`carbon-low`, `carbon-medium`, `carbon-high`),
 * Gemini 4 Argon (`argon-low`, `argon-medium`, `argon-high`), or Gemini 4 Hydrogen
 * (`hydrogen-low`, `hydrogen-medium`, `hydrogen-high`, `hydrogen-xhigh`).
 *
 * Enforces strict symmetry:
 *  - Clean isolated worktrees (`/tmp/plexer-ab-<modelAlias>-{cold,plexer}/<repo>`)
 *  - Identical custom agent definition (`bench-cold` vs `bench-plexer`) with
 *    `inheritCustomizations: false`, `inheritMcp: false`, and identical tool permissions
 *  - `--disable-slash-commands`, `--dangerously-skip-permissions`, `PLEXER_DISABLE_HOOKS=1`
 *  - Runs read-only tasks (`T1`–`T8`) before code-edit tasks (`T9`–`T12`).
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";
import { gradeManifest, parseTranscript } from "./grade.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { ensureAbBaseRepos } from "./ensure-base.js";
import {
    buildPlexerAgyHooksJson,
    buildTrailAgyHooksJson,
    getTrailEnv,
    getTrailSkillBody,
    prepareTrailWorktreeDir,
} from "./trail-live-helper.js";

const modelAlias = process.argv[2] || "hydrogen-medium"; // "neon-medium" | "carbon-medium" | "argon-medium" | "hydrogen-medium"
const concurrency = Number(process.argv[3] || 4);
const armFilter = process.argv[4] || "both"; // "both" | "all" | "cold" | "plexer" | "trail" | comma-separated
const taskFilterArg = process.argv[5] || "all";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both"
        ? ["cold", "plexer"]
        : armFilter === "all"
          ? ["cold", "plexer", "trail"]
          : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

export const MODEL_MAP = {
    "neon-low": { model: "gemini-4-neon-low", effort: "low" },
    "neon-medium": { model: "gemini-4-neon-medium", effort: "medium" },
    "neon-high": { model: "gemini-4-neon-high", effort: "high" },
    "neon-xhigh": { model: "gemini-4-neon-xhigh", effort: "xhigh" },
    "gemini-4-neon-low": { model: "gemini-4-neon-low", effort: "low" },
    "gemini-4-neon-medium": { model: "gemini-4-neon-medium", effort: "medium" },
    "gemini-4-neon-high": { model: "gemini-4-neon-high", effort: "high" },
    "gemini-4-neon-xhigh": { model: "gemini-4-neon-xhigh", effort: "xhigh" },
    "carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "gemini-4-carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "gemini-4-carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "gemini-4-carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "argon-low": { model: "gemini-4-argon-low", effort: "low" },
    "argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
    "argon-high": { model: "gemini-4-argon-high", effort: "high" },
    "hydrogen-low": { model: "gemini-4-hydrogen-low", effort: "low" },
    "hydrogen-medium": { model: "gemini-4-hydrogen-medium", effort: "medium" },
    "hydrogen-high": { model: "gemini-4-hydrogen-high", effort: "high" },
    "hydrogen-xhigh": { model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
    "gemini-4-hydrogen-low": { model: "gemini-4-hydrogen-low", effort: "low" },
    "gemini-4-hydrogen-medium": { model: "gemini-4-hydrogen-medium", effort: "medium" },
    "gemini-4-hydrogen-high": { model: "gemini-4-hydrogen-high", effort: "high" },
    "gemini-4-hydrogen-xhigh": { model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
    sonnet: { model: "claude-sonnet-5-5-medium", effort: "medium" },
    "sonnet-agy": { model: "claude-sonnet-5-5-medium", effort: "medium" },
    opus: { model: "claude-opus-5-5-medium", effort: "medium" },
    "opus-agy": { model: "claude-opus-5-5-medium", effort: "medium" },
    "gemini-4-argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
};
const modelCfg = MODEL_MAP[modelAlias] || { model: modelAlias, effort: process.argv[6] || "medium" };

const logDir = process.env.PLEXER_BENCH_LOG_DIR
    ? resolve(process.env.PLEXER_BENCH_LOG_DIR)
    : `/tmp/plexer-agy-logs/${modelAlias}`;
const benchDaemonSock = `/tmp/plexer-agy-bench-${process.pid}.sock`;

const basePrompt = [
    "You are an expert software engineer solving a repository diagnosis, refactoring blast-radius, or code-editing task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "Be concise, accurate, and cite exact `file:Lx-Ly` line spans as requested.",
    "When running shell commands with `run_command`, always set `WaitMsBeforeAsync: 10000` so commands complete synchronously.",
].join("\n");

const agyRuleBody = readFileSync(resolve(import.meta.dirname, "../rules/AGENTS.md"), "utf8").trim();
let trailSkillBody = "";

function makeAgentMd(name, desc, body, hooksPath = null) {
    return [
        "---",
        `name: ${name}`,
        `description: ${desc}`,
        "tools:",
        "  - view_file",
        "  - multi_replace_file_content",
        "  - replace_file_content",
        "  - write_to_file",
        "  - run_command",
        "  - manage_task",
        ...(hooksPath ? ["hooks:", `  - ${hooksPath}`] : []),
        "hidden: true",
        "inheritCustomizations: false",
        "inheritMcp: false",
        "---",
        "",
        "# Agent System Instructions",
        "",
        body,
        "",
    ].join("\n");
}

const coldAgentMd = makeAgentMd(
    "bench-cold",
    "Cold baseline software engineering agent for A/B benchmarking (no plexer skill).",
    `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` or \`trail\` commands; use standard repository tools only.`
);

const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const agyHooksJson = buildPlexerAgyHooksJson(plexerHookClient);
const trailAgyHooksJson = buildTrailAgyHooksJson();

function ensureWorktree(repo, arm) {
    const parentDir = `/tmp/plexer-ab-${modelAlias}-${arm}`;
    const cloneDir = join(parentDir, repo);
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    const baseSource = arm === "plexer" ? `/tmp/plexer-ab-base/indexed/${repo}` : baseCleanDir;
    if (!existsSync(cloneDir)) {
        mkdirSync(parentDir, { recursive: true });
        execFileSync("cp", ["-a", baseSource, cloneDir]);
    }
    const excludePath = join(cloneDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes(".agents")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\ngraft/\n.trail/\n`, "utf8");
        }
    }
    const agentsDir = join(cloneDir, ".agents", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const hooksPath = join(cloneDir, ".agents", "hooks.json");
    writeFileSync(join(agentsDir, "bench-cold.md"), coldAgentMd, "utf8");
    writeFileSync(
        join(agentsDir, "bench-plexer.md"),
        makeAgentMd(
            "bench-plexer",
            "Plexer-equipped software engineering agent for A/B benchmarking (with plexer skill).",
            `${basePrompt}\n\nIMPORTANT: Do NOT read external skill files under ~/.gemini/ or ~/.agents/; your plexer instructions are already loaded below.\n\n${agyRuleBody}`,
            hooksPath
        ),
        "utf8"
    );
    if (trailSkillBody) {
        writeFileSync(
            join(agentsDir, "bench-trail.md"),
            makeAgentMd(
                "bench-trail",
                "Trail-equipped software engineering agent for A/B benchmarking (with trail skill).",
                `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` commands.\n\n${trailSkillBody}`,
                hooksPath
            ),
            "utf8"
        );
    }
    if (arm === "plexer") {
        writeFileSync(hooksPath, `${agyHooksJson}\n`, "utf8");
    } else if (arm === "trail") {
        writeFileSync(hooksPath, `${trailAgyHooksJson}\n`, "utf8");
    } else if (existsSync(hooksPath)) {
        rmSync(hooksPath, { force: true });
    }
    return cloneDir;
}

async function resetWorktree(repo, arm) {
    let cloneDir = ensureWorktree(repo, arm);
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    if (existsSync(baseCleanDir)) {
        const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseCleanDir, encoding: "utf8" }).trim();
        try {
            execFileSync("git", ["reset", "--hard", baseSha], { cwd: cloneDir, stdio: "ignore" });
        } catch {
            rmSync(cloneDir, { recursive: true, force: true });
            cloneDir = ensureWorktree(repo, arm);
        }
    }
    execFileSync("git", ["checkout", "--", "."], { cwd: cloneDir, stdio: "ignore" });
    execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents", "-e", "graft", "-e", ".trail"], { cwd: cloneDir, stdio: "ignore" });
    if (arm === "plexer") {
        if (existsSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`)) {
            rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
            execFileSync("cp", ["-a", `/tmp/plexer-ab-base/indexed/${repo}/plexer`, join(cloneDir, "plexer")]);
        } else {
            await ensureFreshGraph(cloneDir);
        }
    } else if (arm === "trail") {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
        prepareTrailWorktreeDir(cloneDir, repo, baseCleanDir);
    } else if (existsSync(join(cloneDir, "plexer"))) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
    }
    return cloneDir;
}

const repoLocks = new Map();
async function withRepoLock(key, fn) {
    const prev = repoLocks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => {
        release = r;
    });
    repoLocks.set(key, prev.then(() => next));
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

async function runOne(task, arm) {
    return withRepoLock(`${task.repo}:${arm}`, async () => {
    const cloneDir = ensureWorktree(task.repo, arm);
    if (task.category === "code-edit") {
        await resetWorktree(task.repo, arm);
    }
    return new Promise((resolveRun, rejectRun) => {
        const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
        const tmpJsonl = `${outJsonl}.tmp`;
        const agentName = arm === "plexer" ? "bench-plexer" : arm === "trail" ? "bench-trail" : "bench-cold";
        const promptText = task.prompt(cloneDir);

        const args = [
            "-p",
            promptText,
            "--agent",
            agentName,
            "--model",
            modelCfg.model,
            "--effort",
            modelCfg.effort,
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "--disable-slash-commands",
        ];

        const outStream = createWriteStream(tmpJsonl, { flags: "w" });
        const env =
            arm === "trail"
                ? getTrailEnv()
                : {
                      ...process.env,
                      PLEXER_DAEMON_SOCK: benchDaemonSock,
                      ...(arm === "plexer"
                          ? {}
                          : { PLEXER_ENABLE_BENCH_HOOKS: "0", PLEXER_DISABLE_HOOKS: "1", PLEXER_BENCH_HIDE_CLI: "1" }),
                      GIT_CONFIG_COUNT: "2",
                      GIT_CONFIG_KEY_0: "commit.gpgsign",
                      GIT_CONFIG_VALUE_0: "false",
                      GIT_CONFIG_KEY_1: "tag.gpgsign",
                      GIT_CONFIG_VALUE_1: "false",
                  };
        if (arm === "plexer") {
            delete env.PLEXER_ENABLE_BENCH_HOOKS;
            delete env.PLEXER_DISABLE_HOOKS;
            delete env.PLEXER_BENCH_HIDE_CLI;
        }
        delete env.PLEXER_DIR;
        const child = spawn("agy", args, {
            cwd: cloneDir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.pipe(outStream);
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d.toString();
        });

        child.on("error", (err) => {
            outStream.end();
            rejectRun(err);
        });
        child.on("close", (code) => {
            outStream.end(() => {
                console.log(`[${modelAlias}] finished ${task.id} (${arm}) exit=${code}`);
                if (code === 0) {
                    renameSync(tmpJsonl, outJsonl);
                } else {
                    console.error(`[${modelAlias}] ${task.id} (${arm}) stderr: ${stderr.slice(0, 300)}`);
                }
                resolveRun({ taskId: task.id, arm, cloneDir, transcriptPath: code === 0 ? outJsonl : tmpJsonl, code });
            });
        });
    });
    });
}

async function runWave(jobs, maxParallel) {
    const results = [];
    let idx = 0;
    const workers = Array.from({ length: Math.min(maxParallel, jobs.length) }, async () => {
        while (idx < jobs.length) {
            const job = jobs[idx++];
            results.push(await job());
        }
    });
    await Promise.all(workers);
    return results;
}

async function shutdownBenchDaemon(sockPath) {
    await new Promise((resolveDone) => {
        if (!existsSync(sockPath)) {
            resolveDone();
            return;
        }
        const sock = createConnection(sockPath);
        const timer = setTimeout(() => {
            sock.destroy();
            resolveDone();
        }, 200);
        sock.on("connect", () => {
            sock.write(`${JSON.stringify({ id: 1, type: "shutdown" })}\n`);
            clearTimeout(timer);
            sock.end();
            resolveDone();
        });
        sock.on("error", () => {
            clearTimeout(timer);
            resolveDone();
        });
    });
    rmSync(sockPath, { force: true });
}

async function main() {
    mkdirSync(logDir, { recursive: true });
    trailSkillBody = armsToRun.includes("trail") ? await getTrailSkillBody() : "";

    const selectedTasks = taskFilterSet ? TASKS.filter((t) => taskFilterSet.has(t.id)) : TASKS;
    const readOnlyTasks = selectedTasks.filter((t) => t.category !== "code-edit");
    const editTasks = selectedTasks.filter((t) => t.category === "code-edit");

    console.log(
        `Starting Antigravity (${modelAlias}: ${modelCfg.model} @ effort=${modelCfg.effort}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
    );

    const allRepos = new Set(selectedTasks.map((t) => t.repo));
    await ensureAbBaseRepos(allRepos);
    for (const repo of allRepos) {
        for (const arm of armsToRun) {
            await resetWorktree(repo, arm);
        }
    }

    const readOnlyJobs = [];
    for (const t of readOnlyTasks) {
        for (const arm of armsToRun) {
            readOnlyJobs.push(() => runOne(t, arm));
        }
    }
    const editJobs = [];
    for (const t of editTasks) {
        for (const arm of armsToRun) {
            editJobs.push(() => runOne(t, arm));
        }
    }

    let allRuns;
    try {
        allRuns = [
            ...(await runWave(readOnlyJobs, concurrency)),
            ...(await runWave(editJobs, concurrency)),
        ];
    } finally {
        await shutdownBenchDaemon(benchDaemonSock);
    }

    const manifestPath = process.env.PLEXER_BENCH_MANIFEST
        ? resolve(process.env.PLEXER_BENCH_MANIFEST)
        : resolve(import.meta.dirname, `manifest-${modelAlias}.json`);
    const resultsPath = process.env.PLEXER_BENCH_OUT
        ? resolve(process.env.PLEXER_BENCH_OUT)
        : resolve(import.meta.dirname, `results-${modelAlias}.json`);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    for (const t of TASKS) {
        manifest[t.id] = manifest[t.id] || {};
    }
    const validRuns = allRuns.filter((r) => {
        try {
            const p = parseTranscript(r.transcriptPath);
            if (r.code !== 0 || p.cumulativeInputTokens === 0) {
                console.error(`[${modelAlias}] SKIPPING failed/empty run ${r.taskId} (${r.arm}) exit=${r.code} cumIn=${p.cumulativeInputTokens}`);
                return false;
            }
            return true;
        } catch (err) {
            console.error(`[${modelAlias}] SKIPPING unreadable run ${r.taskId} (${r.arm}): ${err?.message || err}`);
            return false;
        }
    });
    if (validRuns.length === 0) {
        console.error(`[${modelAlias}] All runs failed or returned 0 tokens; preserving existing ${manifestPath} and ${resultsPath}.`);
        process.exit(1);
    }
    for (const r of validRuns) {
        manifest[r.taskId][r.arm] = {
            conversationId: r.transcriptPath,
            cloneDir: r.cloneDir,
        };
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    gradeManifest(
        manifestPath,
        resultsPath,
        new Set(validRuns.map((r) => `${r.taskId}:${r.arm}`))
    );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
