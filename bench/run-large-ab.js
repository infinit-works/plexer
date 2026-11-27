#!/usr/bin/env node
/**
 * Large-Repo & Discriminative Suite (`L1`–`L8`) 2-arm A/B benchmark runner.
 *
 * Evaluates `cold` vs `plexer` across 8 tasks (`L1`–`L8`) spanning 4
 * real-world repositories (`pocketbase/pocketbase`, `tutao/tutanota`,
 * `qutebrowser/qutebrowser`, `flipt-io/flipt`, `NodeBB/NodeBB`):
 *  - `L1`–`L4`: Deep cross-subsystem & multi-hop caller blast-radius traces
 *  - `L5`–`L8`: Multi-file (`2–4` sibling files) code-edit tasks with strict binary
 *               resolution (`resolved` requires 100% of gold sibling files modified +
 *               per-file contract checks) and `0..8` rubric scoring.
 *
 * Usage:
 *   node bench/run-large-ab.js <model> [concurrency=4] [arm=both] [taskFilter=all] [--regrade]
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFingerprint } from "../src/graph/fingerprint.js";
import { LARGE_TASKS } from "./large-tasks.js";
import { ALL_V2_TASKS } from "./v2-tasks.js";
import { ensureSwebenchBaseRepos } from "./ensure-base.js";
import { checkWorktreeIsolation, gradeTaskArm, parseTranscript } from "./grade.js";
import { verifyTaskExecution } from "./verify-exec.js";
import { computeApiCostUsd } from "./cost-model.js";
import { summarizePairedSuite } from "./stats.js";
import {
    attachProcessTimeout,
    BASE_AGY_MODELS,
    buildAgyCliArgs,
    buildPlexerAgyHooksJson,
    buildPlexerClaudeSettingsJson,
    configureAgyWorktreeArm,
    createSterileBenchHome,
    isAgyModelAlias,
    mergeModelBreakdownTotals,
    normalizeAgyModelAlias,
    pickOrchResultMeta,
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
const rawModelArg = positionals[0] || "sonnet"; // "neon-medium" | "carbon-medium" | "hydrogen-medium" | "orch-neon-high-hydrogen-high" | "orch-neon-xhigh-hydrogen-xhigh" | "sonnet" | "opus"
export const CLAUDE_MODELS = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};
export function normalizeModelArg(raw = "sonnet") {
    return normalizeAgyModelAlias(raw);
}
const modelCfg = resolveAgyModelConfig(rawModelArg, "medium");
const modelArg = modelCfg.isOrchestrator ? modelCfg.canonicalAlias : normalizeModelArg(rawModelArg);
const resolvedClaudeModel = CLAUDE_MODELS[rawModelArg] || rawModelArg;
const concurrency = Number(positionals[1] || 4);
const armFilter = positionals[2] || "both";
const taskFilterArg = positionals[3] || "all";
const REINDEX = process.argv.includes("--reindex");
const taskFilterSet =
    taskFilterArg === "all"
        ? null
        : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both" || armFilter === "all"
        ? ["cold", "plexer"]
        : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

export function resolveIsAgy(mArg, env = process.env) {
    return isAgyModelAlias(mArg, env);
}
const isAgy = resolveIsAgy(rawModelArg);
export const AGY_MODELS = BASE_AGY_MODELS;
let sterileHome = null;

const BASE_CACHE_DIR = "/tmp/plexer-swebench-base";
const logDir = process.env.PLEXER_BENCH_LOG_DIR
    ? resolve(process.env.PLEXER_BENCH_LOG_DIR)
    : `/tmp/plexer-large-logs/${modelArg}`;
const benchDaemonSock = `/tmp/plexer-large-bench-${process.pid}.sock`;

const basePrompt = [
    "You are an expert software engineer solving a repository engineering task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "For question/diagnosis/blast-radius tasks, answer concisely with exact file paths, line numbers, and symbol names.",
    "For code-edit tasks, apply the requested changes directly to all required files in the repository.",
    "Do NOT run slow full-repository test suites, Docker builds, or package installs — focus on accurate code localization and surgical edits.",
].join("\n");

const skillMdRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillMdRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
const agyRuleBody = readFileSync(resolve(import.meta.dirname, "../rules/AGENTS.md"), "utf8").trim();

const coldSysFile = join(logDir, "cold-system.txt");
const plexerSysFile = join(logDir, "plexer-system.txt");

const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const plexerHooksSettingsFile = join(logDir, "plexer-hooks-settings.json");
function initRuntimeFiles() {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
    writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");
    writeFileSync(plexerHooksSettingsFile, buildPlexerClaudeSettingsJson(plexerHookClient), "utf8");
}

const agyHooksJson = buildPlexerAgyHooksJson(plexerHookClient);

const reindexedBaseIds = new Set();

async function ensureBaseLargeRepo(task, forceReindex = false) {
    const cleanDir = join(BASE_CACHE_DIR, "clean", task.baseId);
    const indexedDir = join(BASE_CACHE_DIR, "indexed", task.baseId);
    const missingGraph = !existsSync(join(indexedDir, "plexer", ".graph", "wiring.json")) || !readFingerprint(join(indexedDir, "plexer"));
    const shouldReindex = (forceReindex || missingGraph) && !reindexedBaseIds.has(task.baseId);

    if (shouldReindex || !existsSync(cleanDir) || missingGraph) {
        await ensureSwebenchBaseRepos(new Set([task.baseId]), { reindex: shouldReindex });
        reindexedBaseIds.add(task.baseId);
    }

    return { cleanDir, indexedDir };
}

export async function prepareWorktree(task, arm) {
    const { cleanDir, indexedDir } = await ensureBaseLargeRepo(task);
    const workDir = `/tmp/plexer-large-${modelArg}-${arm}/${task.id}`;
    const srcDir = arm === "plexer" ? indexedDir : cleanDir;
    if (!existsSync(workDir)) {
        mkdirSync(`/tmp/plexer-large-${modelArg}-${arm}`, { recursive: true });
        execFileSync("cp", ["-a", srcDir, workDir]);
    } else {
        const baseSha = existsSync(cleanDir)
            ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: cleanDir, encoding: "utf8" }).trim()
            : "HEAD";
        try {
            execFileSync("git", ["reset", "--hard", baseSha], { cwd: workDir, stdio: "ignore" });
        } catch {
            rmSync(workDir, { recursive: true, force: true });
            execFileSync("cp", ["-a", srcDir, workDir]);
        }
        execFileSync("git", ["checkout", "--", "."], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents"], {
            cwd: workDir,
            stdio: "ignore",
        });
        if (arm === "plexer") {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
            execFileSync("cp", ["-a", join(indexedDir, "plexer"), join(workDir, "plexer")]);
        } else if (existsSync(join(workDir, "plexer"))) {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        }
    }
    const cacheDir = join(workDir, "plexer", ".cache");
    if (existsSync(cacheDir)) {
        for (const f of readdirSync(cacheDir)) {
            if (f.startsWith("session-")) rmSync(join(cacheDir, f), { force: true });
        }
    }

    const excludePath = join(workDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes("plexer/")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\nplexer/\n`, "utf8");
        }
    }

    if (isAgy) {
        configureAgyWorktreeArm({
            workDir,
            arm,
            modelCfg,
            basePrompt,
            agyRuleBody,
            agyHooksJson,
            suiteDesc: "Large-Repo A/B benchmarking",
            includeWaitHint: true,
        });
    }

    return workDir;
}

const LARGE_TO_V2_VERIFIER_MAP = { L5: "V5", L6: "V9", L7: "V7", L8: "V11" };

export function gradeLargeTask(task, workDir, parsed, opts = {}) {
    const useDocker = opts.useDocker !== undefined ? Boolean(opts.useDocker) : !process.argv.includes("--no-docker");
    if (task.category === "code-edit" && typeof task.verify === "function") {
        const v = task.verify(workDir);
        const modSet = new Set(v.modifiedFiles || []);
        const gold = task.goldFiles || [];
        const matchedGold = gold.filter((f) => modSet.has(f));
        const fileRecall = gold.length > 0 ? Number((matchedGold.length / gold.length).toFixed(3)) : 1;
        const hasEdits = Boolean(parsed.didModifyFile || modSet.size > 0);
        const heuristicResolved = Boolean(hasEdits && v.resolved);

        const mappedId = LARGE_TO_V2_VERIFIER_MAP[task.id];
        const v2VerifierTask = mappedId ? ALL_V2_TASKS.find((t) => t.id === mappedId) : null;
        let verificationMode = useDocker ? "docker" : "unverified-heuristic";
        let execPassed = null;
        let resolved = null;
        if (v2VerifierTask?.verifier?.kind === "docker") {
            const execRes = verifyTaskExecution(v2VerifierTask, workDir, { useDocker });
            verificationMode = execRes.verificationMode;
            execPassed = execRes.passed;
            resolved = useDocker ? Boolean(heuristicResolved && execRes.resolved === true) : null;
        } else {
            verificationMode = "heuristic";
            resolved = heuristicResolved;
        }
        return {
            score: hasEdits ? v.score : 0,
            maxScore: v.maxScore || 8,
            resolved,
            heuristicResolved,
            execPassed,
            verificationMode,
            fileRecall,
            modifiedFiles: v.modifiedFiles || [],
            goldSourceFiles: gold,
            checks: v.checks || [],
        };
    }
    const g = gradeTaskArm(task, parsed, workDir);
    const resolved = g.score >= 7;
    return {
        score: g.score,
        maxScore: g.maxScore || 8,
        resolved,
        verificationMode: "rubric",
        fileRecall: Number((g.score / (g.maxScore || 8)).toFixed(3)),
        goldSourceFiles: task.goldFiles || [],
        checks: g.checks || [],
    };
}

async function runOne(task, arm) {
    const workDir = await prepareWorktree(task, arm);
    const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
    const promptText = task.prompt(workDir);

    return new Promise((resolveRun, rejectRun) => {
        let cmd;
        let args;
        if (isAgy) {
            cmd = "agy";
            args = buildAgyCliArgs({ promptText, arm, modelCfg });
        } else {
            cmd = "claude";
            const settingsFile = arm === "plexer" ? plexerHooksSettingsFile : null;
            const sysFile = arm === "plexer" ? plexerSysFile : coldSysFile;
            args = [
                "--setting-sources",
                "",
                ...(settingsFile ? ["--settings", settingsFile] : []),
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--dangerously-skip-permissions",
                "--tools",
                "Bash,Read,Edit,Write,Grep,Glob",
                "--append-system-prompt-file",
                sysFile,
                "-p",
                promptText,
                "--model",
                resolvedClaudeModel,
                "--effort",
                "medium",
                "--output-format",
                "stream-json",
                "--verbose",
            ];
        }

        const tmpJsonl = `${outJsonl}.tmp`;
        const outStream = createWriteStream(tmpJsonl, { flags: "w" });
        const sterileOverlay = isAgy && modelCfg.isOrchestrator ? (sterileHome?.envOverlay ?? {}) : {};
        const env = {
            ...process.env,
            ...sterileOverlay,
            ...(arm === "plexer" ? { PLEXER_DAEMON_SOCK: benchDaemonSock } : {}),
            ...(arm === "plexer"
                ? (isAgy ? {} : { PLEXER_ENABLE_BENCH_HOOKS: "1" })
                : { PLEXER_ENABLE_BENCH_HOOKS: "0", PLEXER_DISABLE_HOOKS: "1", PLEXER_BENCH_HIDE_CLI: "1" }),
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "commit.gpgsign",
            GIT_CONFIG_VALUE_0: "false",
            GIT_CONFIG_KEY_1: "tag.gpgsign",
            GIT_CONFIG_VALUE_1: "false",
        };
        if (arm === "plexer") {
            if (isAgy)
                delete env.PLEXER_ENABLE_BENCH_HOOKS;
            delete env.PLEXER_DISABLE_HOOKS;
            delete env.PLEXER_BENCH_HIDE_CLI;
        }
        delete env.PLEXER_DIR;
        const child = spawn(cmd, args, {
            cwd: workDir,
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
            label: `[${modelArg}] ${task.id} (${arm})`,
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
                if (exitCode === 0) {
                    renameSync(tmpJsonl, outJsonl);
                }
                const targetJsonl = exitCode === 0 ? outJsonl : tmpJsonl;
                const parsed = parseTranscript(targetJsonl, arm);
                const grade = gradeLargeTask(task, workDir, parsed);
                console.log(
                    `[${modelArg}] ${task.id} (${arm}) exit=${exitCode}${timedOut ? " (timeout)" : ""} calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 resolved=${grade.resolved}`
                );
                resolveRun({
                    taskId: task.id,
                    arm,
                    workDir,
                    transcriptPath: targetJsonl,
                    parsed,
                    grade,
                    code: exitCode,
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
    initRuntimeFiles();

    const selectedTasks = taskFilterSet ? LARGE_TASKS.filter((t) => taskFilterSet.has(t.id)) : LARGE_TASKS;
    const regradeOnly = process.argv.includes("--regrade");
    console.log(
        `${regradeOnly ? "Regrading" : "Starting"} Large-Repo Suite L1–L8 (${modelArg}) benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
    );

    let runs = [];
    if (regradeOnly) {
        for (const t of selectedTasks) {
            for (const arm of armsToRun) {
                const workDir = `/tmp/plexer-large-${modelArg}-${arm}/${t.id}`;
                const outJsonl = join(logDir, `${t.id}-${arm}.jsonl`);
                if (!existsSync(outJsonl) || !existsSync(workDir)) continue;
                const parsed = parseTranscript(outJsonl, arm);
                const grade = gradeLargeTask(t, workDir, parsed);
                console.log(
                    `[${modelArg}] ${t.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 resolved=${grade.resolved}`
                );
                runs.push({ taskId: t.id, arm, workDir, transcriptPath: outJsonl, parsed, grade, code: 0 });
            }
        }
    } else {
        for (const t of selectedTasks) {
            await ensureBaseLargeRepo(t, REINDEX);
        }
        if (isAgy && modelCfg.isOrchestrator) {
            sterileHome = createSterileBenchHome(`large-${modelArg}`);
        }

        const jobs = [];
        for (const t of selectedTasks) {
            for (const arm of armsToRun) {
                jobs.push(() => runOne(t, arm));
            }
        }

        try {
            runs = (await runWave(jobs, concurrency)).filter((r) => {
                if (r.code !== 0 || r.parsed.cumulativeInputTokens === 0) {
                    console.error(`[${modelArg}] SKIPPING failed/empty run ${r.taskId} (${r.arm}) exit=${r.code} cumIn=${r.parsed.cumulativeInputTokens}`);
                    return false;
                }
                return true;
            });
        } finally {
            await shutdownBenchDaemon(benchDaemonSock);
            sterileHome?.cleanup();
            sterileHome = null;
        }
        if (runs.length === 0) {
            console.error(`[${modelArg}] All runs failed or returned 0 tokens; preserving existing results.`);
            process.exit(1);
        }
    }

    const resultsPath = process.env.PLEXER_BENCH_OUT
        ? resolve(process.env.PLEXER_BENCH_OUT)
        : resolve(import.meta.dirname, `results-large-${modelArg}.json`);
    const prev = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { tasks: [] };
    const byId = new Map((prev.tasks || []).map((t) => [t.id, t]));

    for (const t of LARGE_TASKS) {
        const existing = byId.get(t.id) || {
            id: t.id,
            title: t.title,
            category: t.category,
            repo: t.repo,
            language: t.language,
            sizeBucket: t.sizeBucket,
            fileCount: t.repoFiles,
            gold_files: t.goldFiles,
        };
        for (const r of runs.filter((x) => x.taskId === t.id)) {
            const pricingModel = isAgy ? modelCfg.model : resolvedClaudeModel;
            existing[r.arm] = {
                conversationId: r.parsed.conversationId,
                calls: r.parsed.calls,
                turns: r.parsed.turns,
                toolNames: r.parsed.toolNames,
                toolOutputTokens: r.parsed.toolOutputTokens,
                uncachedInputTokens: r.parsed.uncachedInputTokens,
                cacheWriteTokens: r.parsed.cacheWriteTokens ?? 0,
                cacheReadTokens: r.parsed.cacheReadTokens ?? (r.parsed.cachedInputTokens || 0),
                cachedInputTokens: r.parsed.cachedInputTokens,
                cumulativeInputTokens: r.parsed.cumulativeInputTokens,
                turn1ContextTokens: r.parsed.turn1ContextTokens || 0,
                turn1UncachedTokens: r.parsed.turn1UncachedTokens || 0,
                postTurn1UncachedTokens: r.parsed.postTurn1UncachedTokens || 0,
                netContextGrowthTokens: r.parsed.netContextGrowthTokens || 0,
                cacheMissTurns: r.parsed.cacheMissTurns || 0,
                finalContextTokens: r.parsed.finalContextTokens,
                totalModelOutputTokens: r.parsed.totalModelOutputTokens,
                apiCostUsd: computeApiCostUsd(r.parsed, pricingModel).totalUsd,
                searchMs: r.parsed.searchMs,
                totalMs: r.parsed.totalMs,
                ...pickOrchResultMeta(r.parsed),
                ...r.grade,
            };
        }
        if (existing.cold || existing.plexer) {
            byId.set(t.id, existing);
        }
    }

    const taskRows = [...byId.values()].filter((r) => r.cold && r.plexer);
    const emptyArmTotals = () => ({
        calls: 0,
        turns: 0,
        toolOutputTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cumulativeInputTokens: 0,
        turn1ContextTokens: 0,
        turn1UncachedTokens: 0,
        postTurn1UncachedTokens: 0,
        netContextGrowthTokens: 0,
        cacheMissTurns: 0,
        finalContextTokens: 0,
        totalModelOutputTokens: 0,
        searchMs: 0,
        totalMs: 0,
        score: 0,
        maxScore: 0,
        resolvedCount: 0,
        taskCount: 0,
    });
    const totals = taskRows.reduce(
        (acc, r) => {
            for (const arm of ["cold", "plexer"]) {
                acc[arm].calls += r[arm].calls;
                acc[arm].turns += r[arm].turns;
                acc[arm].toolOutputTokens += r[arm].toolOutputTokens;
                acc[arm].uncachedInputTokens += r[arm].uncachedInputTokens;
                acc[arm].cachedInputTokens += r[arm].cachedInputTokens;
                acc[arm].cumulativeInputTokens += r[arm].cumulativeInputTokens;
                acc[arm].turn1ContextTokens += r[arm].turn1ContextTokens || 0;
                acc[arm].turn1UncachedTokens += r[arm].turn1UncachedTokens || 0;
                acc[arm].postTurn1UncachedTokens += r[arm].postTurn1UncachedTokens || 0;
                acc[arm].netContextGrowthTokens += r[arm].netContextGrowthTokens || 0;
                acc[arm].cacheMissTurns += r[arm].cacheMissTurns || 0;
                acc[arm].finalContextTokens += r[arm].finalContextTokens;
                acc[arm].totalModelOutputTokens += r[arm].totalModelOutputTokens;
                acc[arm].searchMs += r[arm].searchMs;
                acc[arm].totalMs += r[arm].totalMs;
                acc[arm].score += r[arm].score;
                acc[arm].maxScore += r[arm].maxScore;
                acc[arm].resolvedCount += r[arm].resolved ? 1 : 0;
                acc[arm].taskCount += 1;
                mergeModelBreakdownTotals(acc[arm], r[arm]);
            }
            return acc;
        },
        {
            cold: emptyArmTotals(),
            plexer: emptyArmTotals(),
        }
    );

    const stats = summarizePairedSuite(taskRows);
    writeFileSync(
        resultsPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), model: modelArg, trials: TRIALS, unreplicated: TRIALS < 2, useDocker: !process.argv.includes("--no-docker"), totals, stats, tasks: taskRows }, null, 2)}\n`,
        "utf8"
    );
    console.log(`Saved Large-Repo Suite L1–L8 results to ${resultsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
