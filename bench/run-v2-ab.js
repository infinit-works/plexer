#!/usr/bin/env node
/**
 * Unified v2 Multi-Scale & Adversarial A/B Benchmark Runner (`bench/run-v2-ab.js`).
 *
 * Usage:
 *   node bench/run-v2-ab.js --model opus --trials 3 --tier all
 *   node bench/run-v2-ab.js --dry-run
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ALL_V2_TASKS } from "./v2-tasks.js";
import { auditSuiteLeakage } from "./audit-leakage.js";
import { verifyTaskExecution } from "./verify-exec.js";
import { computeApiCostUsd, MODEL_PRICING_USD_PER_M, PRICING_TABLE_VERSION } from "./cost-model.js";
import { aggregateTrials, summarizePairedSuite } from "./stats.js";
import { ensureV2BaseRepos } from "./ensure-base.js";
import { checkRunConfigSymmetry, checkWorktreeIsolation, gradeTaskArm, parseTranscript } from "./grade.js";
import {
    attachProcessTimeout,
    buildAgyCliArgs,
    buildPlexerAgyHooksJson,
    buildPlexerClaudeSettingsJson,
    configureAgyWorktreeArm,
    createSterileBenchHome,
    isAgyModelAlias,
    normalizeAgyModelAlias,
    pickOrchResultMeta,
    resolveAgyModelConfig,
    shutdownBenchDaemon,
} from "./agy-bench-helper.js";

const CORE_MODELS = [
    "opus",
    "sonnet",
    "orch-neon-high-hydrogen-high",
    "neon-medium",
    "hydrogen-medium",
];

const CLAUDE_MODELS = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};

function parseCliArgs(argv) {
    const getVal = (flag, dflt = null) => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--") ? argv[idx + 1] : dflt;
    };
    const model = getVal("--model", "sonnet");
    const trialsRaw = Number(getVal("--trials", "3"));
    const trials = Number.isFinite(trialsRaw) && trialsRaw >= 1 ? Math.floor(trialsRaw) : 3;
    const tier = getVal("--tier", "all");
    const split = getVal("--split", "all");
    const tasksRaw = getVal("--tasks", "all");
    const armArg = getVal("--arm", "both");
    const concurrency = Number(getVal("--concurrency", "4"));
    const outArg = getVal("--out", null);
    return {
        model,
        trials,
        tier,
        split,
        tasks: tasksRaw === "all" ? null : new Set(tasksRaw.split(",").map((s) => s.trim())),
        arms: armArg === "both" || armArg === "all" ? ["cold", "plexer"] : armArg.split(",").map((s) => s.trim()),
        concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 4,
        useDocker: !argv.includes("--no-docker"),
        dryRun: argv.includes("--dry-run"),
        reindex: argv.includes("--reindex"),
        outArg,
    };
}

function filterV2Tasks(opts) {
    return ALL_V2_TASKS.filter((t) => {
        if (opts.tier !== "all" && t.tier !== opts.tier) return false;
        if (opts.split === "train" && (t.holdout || t.negativeControl)) return false;
        if (opts.split === "holdout" && !t.holdout) return false;
        if (opts.split === "negative" && !t.negativeControl) return false;
        if (opts.tasks && !opts.tasks.has(t.id)) return false;
        return true;
    });
}

function purgeSessionFiles(workDir) {
    const cacheDir = join(workDir, "plexer", ".cache");
    if (!existsSync(cacheDir)) return;
    for (const f of readdirSync(cacheDir)) {
        if (f.startsWith("session-")) rmSync(join(cacheDir, f), { force: true });
    }
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

function gradeV2TaskArm(task, workDir, parsed, useDocker) {
    if (task.category === "code-edit") {
        const modOut = execFileSync("git", ["diff", "--name-only"], { cwd: workDir, encoding: "utf8" }).trim();
        const modFiles = modOut ? modOut.split("\n").filter(Boolean) : [];
        const modSet = new Set(modFiles);
        const gold = task.goldFiles || [];
        const matched = gold.filter((f) => modSet.has(f));
        const fileRecall = gold.length > 0 ? Number((matched.length / gold.length).toFixed(3)) : 1;
        const execRes = verifyTaskExecution(task, workDir, { useDocker });
        const hasEdits = Boolean(parsed.didModifyFile || modSet.size > 0);
        const score = execRes.resolved === true && hasEdits ? 8 : matched.length > 0 && hasEdits ? Math.round(fileRecall * 4) : 0;
        return {
            score,
            maxScore: 8,
            resolved: execRes.resolved === null ? null : Boolean(hasEdits && execRes.resolved),
            verificationMode: execRes.verificationMode,
            execDurationMs: execRes.durationMs ?? 0,
            fileRecall,
            modifiedFiles: modFiles,
            goldSourceFiles: gold,
            checks: [{ id: "execution_verifier", passed: execRes.resolved, detail: execRes.stdoutTail || execRes.reason || "" }],
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

export function buildV2PreflightSummary(opts = {}) {
    const holdoutPath = resolve(import.meta.dirname, "v2-holdout.json");
    const holdoutManifest = existsSync(holdoutPath)
        ? JSON.parse(readFileSync(holdoutPath, "utf8"))
        : null;
    const leakageAudit = auditSuiteLeakage(ALL_V2_TASKS, { holdoutManifest });
    const selectedTasks = filterV2Tasks({
        tier: opts.tier || "all",
        split: opts.split || "all",
        tasks: opts.tasks || null,
    });
    const tierCounts = {};
    for (const t of selectedTasks) {
        tierCounts[t.tier] = (tierCounts[t.tier] || 0) + 1;
    }
    return {
        pricingVersion: PRICING_TABLE_VERSION,
        coreModels: CORE_MODELS,
        modelPricingKeys: Object.keys(MODEL_PRICING_USD_PER_M),
        trials: opts.trials ?? 3,
        unreplicated: (opts.trials ?? 3) < 2,
        useDocker: opts.useDocker !== false,
        leakageAudit: {
            passed: leakageAudit.passed,
            cleanTasks: leakageAudit.cleanTasks,
            totalTasks: leakageAudit.totalTasks,
            totalViolations: leakageAudit.totalViolations,
        },
        selectedTaskCount: selectedTasks.length,
        trainCount: selectedTasks.filter((t) => !t.holdout && !t.negativeControl).length,
        holdoutCount: selectedTasks.filter((t) => t.holdout).length,
        negativeControlCount: selectedTasks.filter((t) => t.negativeControl).length,
        tierCounts,
        tasks: selectedTasks.map((t) => ({
            id: t.id,
            tier: t.tier,
            repo: t.repo,
            holdout: Boolean(t.holdout),
            negativeControl: Boolean(t.negativeControl),
            verifierKind: t.verifier?.kind || "rubric",
        })),
    };
}

async function main() {
    const opts = parseCliArgs(process.argv.slice(2));
    const preflight = buildV2PreflightSummary(opts);

    if (!preflight.leakageAudit.passed) {
        console.error(
            `[v2-bench] FAIL: Leakage/holdout audit failed (${preflight.leakageAudit.totalViolations} violations). Fix before running.`
        );
        process.exit(1);
    }

    if (opts.dryRun) {
        console.log(JSON.stringify(preflight, null, 2));
        process.exit(0);
    }

    const modelCfg = resolveAgyModelConfig(opts.model, "medium");
    const modelAlias = modelCfg.isOrchestrator ? modelCfg.canonicalAlias : normalizeAgyModelAlias(opts.model);
    const isAgy = isAgyModelAlias(opts.model);
    const resolvedClaudeModel = CLAUDE_MODELS[opts.model] || opts.model;
    const pricingModel = isAgy ? modelCfg.model : resolvedClaudeModel;

    const selectedTasks = filterV2Tasks(opts);
    if (selectedTasks.length === 0) {
        console.error("[v2-bench] No tasks matched filter.");
        process.exit(1);
    }

    const logDir = `/tmp/plexer-v2-logs/${modelAlias}`;
    mkdirSync(logDir, { recursive: true });
    const benchDaemonSock = `/tmp/plexer-v2-bench-${process.pid}.sock`;

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
    writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
    writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");
    writeFileSync(plexerHooksSettingsFile, buildPlexerClaudeSettingsJson(plexerHookClient), "utf8");
    const agyHooksJson = buildPlexerAgyHooksJson(plexerHookClient);

    const preparedBases = await ensureV2BaseRepos(new Set(selectedTasks.map((t) => t.id)), {
        reindex: opts.reindex,
    });
    const sterileHome = isAgy && modelCfg.isOrchestrator ? createSterileBenchHome(`v2-${modelAlias}`) : null;

    async function runOneTrial(task, arm, trialIdx) {
        const base = preparedBases.get(task.id);
        const workDir = `/tmp/plexer-v2-${modelAlias}-${arm}-t${trialIdx}/${task.id}`;
        rmSync(workDir, { recursive: true, force: true });
        mkdirSync(join(workDir, ".."), { recursive: true });
        execFileSync("cp", ["-a", arm === "plexer" ? base.indexedDir : base.cleanDir, workDir]);
        purgeSessionFiles(workDir);

        if (isAgy) {
            configureAgyWorktreeArm({
                workDir,
                arm,
                modelCfg,
                basePrompt,
                agyRuleBody,
                agyHooksJson,
                suiteDesc: "v2 Multi-Scale A/B benchmarking",
                includeWaitHint: true,
            });
        }
        const isolationViolations = checkWorktreeIsolation(workDir, arm);
        const promptText = task.prompt(workDir);
        const promptSha256 = createHash("sha256").update(task.prompt("<REPO>"), "utf8").digest("hex");
        const outJsonl = join(logDir, `${task.id}-${arm}-t${trialIdx}.jsonl`);

        return new Promise((resolveRun, rejectRun) => {
            const cmd = isAgy ? "agy" : "claude";
            const args = isAgy
                ? buildAgyCliArgs({ promptText, arm, modelCfg })
                : [
                      "--setting-sources",
                      "",
                      ...(arm === "plexer" ? ["--settings", plexerHooksSettingsFile] : []),
                      "--disable-slash-commands",
                      "--strict-mcp-config",
                      "--dangerously-skip-permissions",
                      "--tools",
                      "Bash,Read,Edit,Write,Grep,Glob",
                      "--append-system-prompt-file",
                      arm === "plexer" ? plexerSysFile : coldSysFile,
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
            const tmpJsonl = `${outJsonl}.tmp`;
            const outStream = createWriteStream(tmpJsonl, { flags: "w" });
            const env = {
                ...process.env,
                ...(isAgy && modelCfg.isOrchestrator ? (sterileHome?.envOverlay ?? {}) : {}),
                ...(arm === "plexer" ? { PLEXER_DAEMON_SOCK: benchDaemonSock } : {}),
                ...(arm === "plexer"
                    ? isAgy
                        ? {}
                        : { PLEXER_ENABLE_BENCH_HOOKS: "1" }
                    : { PLEXER_ENABLE_BENCH_HOOKS: "0", PLEXER_DISABLE_HOOKS: "1", PLEXER_BENCH_HIDE_CLI: "1" }),
            };
            const child = spawn(cmd, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.pipe(outStream);
            let timedOut = false;
            const clearTimeoutHandle = attachProcessTimeout(child, {
                label: `[v2:${modelAlias}] ${task.id} (${arm}#${trialIdx})`,
                onTimeout: () => {
                    timedOut = true;
                },
            });
            child.on("error", (err) => {
                clearTimeoutHandle();
                outStream.end();
                rejectRun(err);
            });
            child.on("close", (code) => {
                clearTimeoutHandle();
                const exitCode = timedOut ? 124 : code ?? 1;
                outStream.end(() => {
                    if (exitCode === 0) renameSync(tmpJsonl, outJsonl);
                    const parsed = parseTranscript(exitCode === 0 ? outJsonl : tmpJsonl, arm);
                    const grade = gradeV2TaskArm(task, workDir, parsed, opts.useDocker);
                    const apiCost = computeApiCostUsd(parsed, pricingModel);
                    resolveRun({
                        taskId: task.id,
                        arm,
                        trial: trialIdx,
                        code: exitCode,
                        configMeta: { model: modelAlias, effort: "medium", tools: "Bash,Read,Edit,Write,Grep,Glob", promptSha256 },
                        metrics: {
                            ...parsed,
                            ...grade,
                            ...pickOrchResultMeta(parsed),
                            apiCostUsd: apiCost.totalUsd,
                            apiCost,
                            symmetryViolations: [...(parsed.symmetryViolations || []), ...isolationViolations],
                        },
                    });
                });
            });
        });
    }

    const jobs = [];
    for (let trial = 1; trial <= opts.trials; trial++) {
        for (const t of selectedTasks) {
            for (const arm of opts.arms) {
                jobs.push(() => runOneTrial(t, arm, trial));
            }
        }
    }

    let rawRuns;
    try {
        rawRuns = await runWave(jobs, opts.concurrency);
    } finally {
        await shutdownBenchDaemon(benchDaemonSock);
        sterileHome?.cleanup();
    }

    const taskRows = [];
    const symmetryViolations = [];
    for (const t of selectedTasks) {
        const byArm = { cold: [], plexer: [] };
        for (const r of rawRuns.filter((x) => x.taskId === t.id && x.code === 0 && x.metrics.cumulativeInputTokens > 0)) {
            byArm[r.arm].push(r);
        }
        if (byArm.cold.length === 0 || byArm.plexer.length === 0) continue;
        for (let i = 0; i < Math.min(byArm.cold.length, byArm.plexer.length); i++) {
            symmetryViolations.push(...checkRunConfigSymmetry(byArm.cold[i].configMeta, byArm.plexer[i].configMeta));
        }
        const coldAgg = aggregateTrials(byArm.cold.map((r) => r.metrics));
        const plexerAgg = aggregateTrials(byArm.plexer.map((r) => r.metrics));
        taskRows.push({
            id: t.id,
            tier: t.tier,
            category: t.category,
            repo: t.repo,
            language: t.language,
            fileCount: t.repoFiles,
            holdout: Boolean(t.holdout),
            negativeControl: Boolean(t.negativeControl),
            title: t.title,
            cold: coldAgg,
            plexer: plexerAgg,
        });
    }

    const stats = summarizePairedSuite(taskRows);
    const outPath = opts.outArg
        ? resolve(opts.outArg)
        : resolve(import.meta.dirname, `results-v2-${modelAlias}.json`);
    const payload = {
        generatedAt: new Date().toISOString(),
        suite: "v2",
        model: modelAlias,
        trials: opts.trials,
        unreplicated: opts.trials < 2,
        useDocker: opts.useDocker,
        pricingVersion: PRICING_TABLE_VERSION,
        symmetryCheck: { passed: symmetryViolations.length === 0, violations: symmetryViolations },
        stats,
        tasks: taskRows,
    };
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Saved v2 results (${taskRows.length} tasks × ${opts.trials} trials) to ${outPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
