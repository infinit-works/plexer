#!/usr/bin/env node
/**
 * Reproducible A/B runner for Antigravity CLI (`agy`) across all 12 tasks (`T1`–`T12`)
 * in `bench/tasks.js` using Gemini 4 Neon (`neon-low`, `neon-medium`, `neon-high`, `neon-xhigh`),
 * Gemini 4 Carbon (`carbon-low`, `carbon-medium`, `carbon-high`),
 * or Gemini 4 Hydrogen
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
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";
import { checkWorktreeIsolation, gradeManifest, parseTranscript } from "./grade.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { ensureAbBaseRepos } from "./ensure-base.js";
import { aggregateTrials, summarizePairedSuite } from "./stats.js";
import {
    attachProcessTimeout,
    BASE_AGY_MODELS,
    buildAgyCliArgs,
    buildPlexerAgyHooksJson,
    configureAgyWorktreeArm,
    createSterileBenchHome,
    normalizeAgyModelAlias,
    resolveAgyModelConfig,
    shutdownBenchDaemon,
} from "./agy-bench-helper.js";

const rawArgs = process.argv.slice(2);
const trialsIdx = rawArgs.indexOf("--trials");
const TRIALS = trialsIdx >= 0 && Number(rawArgs[trialsIdx + 1]) > 0 ? Math.floor(Number(rawArgs[trialsIdx + 1])) : 1;
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--trials") {
        i++;
        continue;
    }
    if (!rawArgs[i].startsWith("--")) positionals.push(rawArgs[i]);
}
const rawModelArg = positionals[0] || "hydrogen-medium"; // "neon-medium" | "carbon-medium" | "hydrogen-medium" | "orch-neon-high-hydrogen-high" | "orch-neon-xhigh-hydrogen-xhigh"
const modelAlias = normalizeAgyModelAlias(rawModelArg);
const concurrency = Number(positionals[1] || 4);
const armFilter = positionals[2] || "both"; // "both" | "all" | "cold" | "plexer" | comma-separated
const taskFilterArg = positionals[3] || "all";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both" || armFilter === "all"
        ? ["cold", "plexer"]
        : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

export const MODEL_MAP = BASE_AGY_MODELS;
const modelCfg = resolveAgyModelConfig(rawModelArg, positionals[4] || "medium");
let sterileHome = null;

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

const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const agyHooksJson = buildPlexerAgyHooksJson(plexerHookClient);

function purgeStaleSessionFiles(workDir) {
    const cacheDir = join(workDir, "plexer", ".cache");
    if (!existsSync(cacheDir)) return;
    for (const f of readdirSync(cacheDir)) {
        if (f.startsWith("session-")) rmSync(join(cacheDir, f), { force: true });
    }
}

function ensureWorktree(repo, arm) {
    const parentDir = `/tmp/plexer-ab-${modelAlias}-${arm}`;
    const cloneDir = join(parentDir, repo);
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    const baseIdxPlexer = `/tmp/plexer-ab-base/indexed/${repo}/plexer`;
    const baseSource = arm === "plexer" ? `/tmp/plexer-ab-base/indexed/${repo}` : baseCleanDir;
    if (!existsSync(cloneDir)) {
        mkdirSync(parentDir, { recursive: true });
        execFileSync("cp", ["-a", baseSource, cloneDir]);
    } else if (arm === "plexer" && existsSync(baseIdxPlexer)) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
        execFileSync("cp", ["-a", baseIdxPlexer, join(cloneDir, "plexer")]);
    } else if (arm === "cold" && existsSync(join(cloneDir, "plexer"))) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
    }
    purgeStaleSessionFiles(cloneDir);
    configureAgyWorktreeArm({
        workDir: cloneDir,
        arm,
        modelCfg,
        basePrompt,
        agyRuleBody,
        agyHooksJson,
        suiteDesc: "A/B benchmarking",
        includeWaitHint: false,
    });
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
    execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents"], { cwd: cloneDir, stdio: "ignore" });
    if (arm === "plexer") {
        if (existsSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`)) {
            rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
            execFileSync("cp", ["-a", `/tmp/plexer-ab-base/indexed/${repo}/plexer`, join(cloneDir, "plexer")]);
        } else {
            await ensureFreshGraph(cloneDir);
        }
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
        const promptText = task.prompt(cloneDir);

        const args = buildAgyCliArgs({ promptText, arm, modelCfg });

        const outStream = createWriteStream(tmpJsonl, { flags: "w" });
        const sterileOverlay = sterileHome?.envOverlay ?? {};
        const env = {
            ...process.env,
            ...sterileOverlay,
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
        let timedOut = false;
        const clearRunTimeout = attachProcessTimeout(child, {
            label: `[${modelAlias}] ${task.id} (${arm})`,
            onTimeout: () => {
                timedOut = true;
            },
        });

        child.on("error", (err) => {
            clearRunTimeout();
            outStream.end();
            rejectRun(err);
        });
        child.on("close", (code) => {
            clearRunTimeout();
            const exitCode = timedOut ? 124 : (code ?? 1);
            outStream.end(() => {
                console.log(`[${modelAlias}] finished ${task.id} (${arm}) exit=${exitCode}${timedOut ? " (timeout)" : ""}`);
                if (exitCode === 0) {
                    renameSync(tmpJsonl, outJsonl);
                } else {
                    console.error(`[${modelAlias}] ${task.id} (${arm}) stderr: ${stderr.slice(0, 300)}`);
                }
                resolveRun({ taskId: task.id, arm, cloneDir, transcriptPath: exitCode === 0 ? outJsonl : tmpJsonl, code: exitCode });
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

async function main() {
    mkdirSync(logDir, { recursive: true });

    const selectedTasks = taskFilterSet ? TASKS.filter((t) => taskFilterSet.has(t.id)) : TASKS;
    const readOnlyTasks = selectedTasks.filter((t) => t.category !== "code-edit");
    const editTasks = selectedTasks.filter((t) => t.category === "code-edit");

    const descCfg = modelCfg.isOrchestrator
        ? `${modelCfg.model} planner=${modelCfg.orchestrator?.planner} executor=${modelCfg.orchestrator?.executor}`
        : `${modelCfg.model} @ effort=${modelCfg.effort}`;
    console.log(
        `Starting Antigravity (${modelAlias}: ${descCfg}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
    );
    if (modelCfg.isOrchestrator) {
        sterileHome = createSterileBenchHome(`ab-${modelAlias}`);
    }

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
        sterileHome?.cleanup();
        sterileHome = null;
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
    const summary = gradeManifest(
        manifestPath,
        resultsPath,
        new Set(validRuns.map((r) => `${r.taskId}:${r.arm}`)),
        { modelName: modelCfg.model }
    );
    summary.trials = TRIALS;
    summary.unreplicated = TRIALS < 2;
    summary.stats = summarizePairedSuite(summary.tasks || []);
    writeFileSync(resultsPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
