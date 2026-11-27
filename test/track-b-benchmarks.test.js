import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALL_V2_TASKS, V2_TASKS } from "../bench/v2-tasks.js";
import { TASKS } from "../bench/tasks.js";
import { LARGE_TASKS } from "../bench/large-tasks.js";
import { auditSuiteLeakage, auditTaskLeakage, computePromptSha256 } from "../bench/audit-leakage.js";
import {
    aggregateTrials,
    bootstrapCI,
    bootstrapPairedPctDeltaCI,
    iqr,
    median,
    pairedSignTest,
    summarizePairedSuite,
    wilcoxonSignedRank,
} from "../bench/stats.js";
import { computeApiCostUsd, MODEL_PRICING_USD_PER_M, PRICING_TABLE_VERSION } from "../bench/cost-model.js";
import { checkRunConfigSymmetry, checkWorktreeIsolation, parseTranscript } from "../bench/grade.js";
import { verifyPatchAgainstBase, verifyTaskExecution } from "../bench/verify-exec.js";
import { runHardRetrievalSuite } from "../bench/hard-retrieval.js";
import { runScaleStress } from "../bench/scale-stress.js";
import { renderChart } from "../bench/chart.js";
import { buildV2PreflightSummary } from "../bench/run-v2-ab.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLEANUP_DIRS = [];

function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    CLEANUP_DIRS.push(dir);
    return dir;
}

after(() => {
    for (const d of CLEANUP_DIRS) {
        rmSync(d, { recursive: true, force: true });
    }
});

describe("Track B: De-leaked v2 Benchmarks, Verifiers, Stats, and Scale Stress", () => {
    it("passes leakage audit on ALL_V2_TASKS + v2-holdout.json and catches path/symbol leaks", () => {
        const holdoutManifest = JSON.parse(
            readFileSync(join(REPO_ROOT, "bench", "v2-holdout.json"), "utf8")
        );
        const v2Audit = auditSuiteLeakage(ALL_V2_TASKS, { holdoutManifest });
        assert.equal(v2Audit.passed, true, `v2 suite must have 0 leakage violations: ${JSON.stringify(v2Audit.taskResults.filter((r) => !r.passed))}`);
        assert.equal(v2Audit.manifestViolations.length, 0);

        // Synthetic file-path leak triggers violation
        const leakyPathTask = {
            id: "FAKE1",
            category: "diagnosis",
            promptStyle: "symptom",
            goldFiles: ["src/internal/secret_widget.ts"],
            goldSymbols: ["refreshSecretWidget", "computeTokenHash"],
            prompt: () => "Inspect src/internal/secret_widget.ts to diagnose the token failure.",
        };
        const pathRes = auditTaskLeakage(leakyPathTask);
        assert.equal(pathRes.passed, false);
        assert.ok(pathRes.violations.some((v) => v.kind === "file_path"));

        // Synthetic >1 gold symbol leak triggers violation
        const leakySymTask = {
            id: "FAKE2",
            category: "diagnosis",
            promptStyle: "symptom",
            goldFiles: ["src/worker/jobs.js"],
            goldSymbols: ["enqueueRetryJob", "drainDeadLetterQueue"],
            prompt: () => "Explain how enqueueRetryJob hands off items to drainDeadLetterQueue.",
        };
        const symRes = auditTaskLeakage(leakySymTask);
        assert.equal(symRes.passed, false);
        assert.ok(symRes.violations.some((v) => v.kind === "multi_symbol_leak"));

        // Holdout SHA mismatch caught
        const tamperedManifest = {
            ...holdoutManifest,
            promptSha256: { ...holdoutManifest.promptSha256, V3: "0".repeat(64) },
        };
        const shaAudit = auditSuiteLeakage(ALL_V2_TASKS, { holdoutManifest: tamperedManifest });
        assert.equal(shaAudit.passed, false);
        assert.ok(shaAudit.manifestViolations.some((m) => m.kind === "prompt_sha_mismatch"));

        // Verify v1 archive diagnostic finds historical leaks as expected (keeps v1 files untouched)
        const v1Audit = auditSuiteLeakage([...TASKS, ...LARGE_TASKS], {});
        assert.ok(v1Audit.totalViolations > 0, "historical v1 archive should retain known pre-v2 diagnostic leaks untouched");
        assert.equal(typeof computePromptSha256(V2_TASKS[0]), "string");
    });

    it("computes deterministic statistics, 95% bootstrap CIs, exact Wilcoxon/sign tests, and multi-trial summaries", () => {
        assert.equal(median([10, 2, 6]), 6);
        assert.equal(median([10, 2, 6, 4]), 5);
        const iq = iqr([1, 2, 3, 4, 5, 6, 7]);
        assert.equal(iq.median, 4);
        assert.ok(iq.iqr > 0);

        const ci1 = bootstrapCI([10, 12, 14, 16, 18], { iterations: 1000, seed: 1234 });
        const ci2 = bootstrapCI([10, 12, 14, 16, 18], { iterations: 1000, seed: 1234 });
        assert.deepEqual(ci1, ci2, "seeded bootstrapCI must be deterministic");
        assert.ok(ci1.ciLow <= ci1.estimate && ci1.estimate <= ci1.ciHigh);

        const cold = [100, 120, 140, 160, 180, 200];
        const plexer = [50, 60, 70, 80, 90, 100];
        const pci = bootstrapPairedPctDeltaCI(cold, plexer, { iterations: 1000, seed: 99 });
        assert.equal(Math.round(pci.estimate), -50);
        assert.equal(Math.round(pci.ciLow), -50);
        assert.equal(Math.round(pci.ciHigh), -50);

        const w = wilcoxonSignedRank(cold, plexer);
        assert.equal(w.nonZeroN, 6);
        assert.equal(w.Wminus, 0);
        assert.equal(w.significant05, true);
        assert.equal(w.pValue, 0.03125); // 2 * (1 / 2^6) = 0.03125 exact two-sided

        // Ties in Wilcoxon signed-rank must still compute finite exact p-value
        const wt = wilcoxonSignedRank([10, 10, 10, 20], [5, 5, 10, 10]);
        assert.equal(wt.nonZeroN, 3);
        assert.ok(wt.pValue > 0 && wt.pValue <= 1);

        const s = pairedSignTest(cold, plexer);
        assert.equal(s.wins, 6);
        assert.equal(s.losses, 0);
        assert.equal(s.pValue, 0.03125);

        const n1Agg = aggregateTrials([{ calls: 4, totalMs: 1000, apiCostUsd: 0.02, resolved: true }]);
        assert.equal(n1Agg.trials, 1);
        assert.equal(n1Agg.unreplicated, true);

        const n3Agg = aggregateTrials([
            { calls: 4, totalMs: 1000, apiCostUsd: 0.02, resolved: true },
            { calls: 8, totalMs: 3000, apiCostUsd: 0.04, resolved: true },
            { calls: 6, totalMs: 2000, apiCostUsd: 0.03, resolved: false },
        ]);
        assert.equal(n3Agg.trials, 3);
        assert.equal(n3Agg.unreplicated, false);
        assert.equal(n3Agg.calls, 6);
        assert.equal(n3Agg.totalMs, 2000);
        assert.equal(n3Agg.resolvedCount, 2);
        assert.equal(n3Agg.resolved, true);

        const suite = summarizePairedSuite([
            { id: "V1", tier: "small", holdout: false, negativeControl: false, cold: { calls: 6, totalMs: 2000, apiCostUsd: 0.04, cumulativeInputTokens: 10000, toolOutputTokens: 2000, resolved: true }, plexer: { calls: 2, totalMs: 1000, apiCostUsd: 0.02, cumulativeInputTokens: 5000, toolOutputTokens: 600, resolved: true } },
            { id: "V3", tier: "small", holdout: true, negativeControl: false, cold: { calls: 8, totalMs: 4000, apiCostUsd: 0.08, cumulativeInputTokens: 20000, toolOutputTokens: 4000, resolved: true }, plexer: { calls: 3, totalMs: 2000, apiCostUsd: 0.03, cumulativeInputTokens: 8000, toolOutputTokens: 1200, resolved: true } },
            { id: "N1", tier: "small", holdout: false, negativeControl: true, cold: { calls: 1, totalMs: 500, apiCostUsd: 0.01, cumulativeInputTokens: 2000, toolOutputTokens: 200, resolved: true }, plexer: { calls: 1, totalMs: 500, apiCostUsd: 0.01, cumulativeInputTokens: 2100, toolOutputTokens: 200, resolved: true } },
        ]);
        assert.equal(suite.overall.tasks, 3);
        assert.equal(suite.train.tasks, 1);
        assert.equal(suite.holdout.tasks, 1);
        assert.equal(suite.negativeControl.tasks, 1);
        assert.ok(suite.byTier.small.metrics.apiCostUsd.pctDelta < 0);
    });

    it("computes published cache-aware API USD costs across Claude, Gemini, and Orchestrator breakdowns", () => {
        assert.equal(PRICING_TABLE_VERSION, "2026-11");
        assert.ok(MODEL_PRICING_USD_PER_M["claude-opus-5-5"].cacheWrite > MODEL_PRICING_USD_PER_M["claude-opus-5-5"].uncachedInput);

        const opusCost = computeApiCostUsd(
            {
                uncachedInputTokens: 100_000,
                cacheWriteTokens: 100_000,
                cacheReadTokens: 1_000_000,
                totalModelOutputTokens: 10_000,
            },
            "claude-opus-5-5"
        );
        // 1.50 + 1.875 + 1.50 + 0.75 = 5.625
        assert.equal(opusCost.totalUsd, 5.625);
        assert.equal(opusCost.legacyCacheSplit, false);

        const orchCost = computeApiCostUsd(
            {
                modelBreakdown: {
                    "gemini-4-neon-high": { uncachedInputTokens: 200_000, cacheWriteTokens: 0, cacheReadTokens: 400_000, totalModelOutputTokens: 20_000 },
                    "gemini-4-hydrogen-high": { uncachedInputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 200_000, totalModelOutputTokens: 10_000 },
                },
            },
            "orch-neon-high-hydrogen-high"
        );
        // Neon: 0.50 + 0.10 + 0.30 = 0.90; Hydrogen: 0.05 + 0.01 + 0.03 = 0.09 -> 0.99
        assert.equal(orchCost.totalUsd, 0.99);
        assert.equal(Object.keys(orchCost.byModel).length, 2);
    });

    it("parses separated cacheWriteTokens/cacheReadTokens and enforces anti-leakage symmetry in grade.js", () => {
        const tmp = makeTempDir("plexer-tb-grade-");
        const txPath = join(tmp, "claude-tx.jsonl");
        writeFileSync(
            txPath,
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-11-26T00:00:00Z",
                    message: {
                        id: "m1",
                        usage: {
                            input_tokens: 10,
                            cache_creation_input_tokens: 2000,
                            cache_read_input_tokens: 4000,
                            output_tokens: 150,
                        },
                        content: [
                            { type: "tool_use", name: "Read", input: { file_path: "bench/v2-tasks.js" } },
                            { type: "tool_use", name: "Bash", input: { command: "git log -n 5 && plexer ask foo" } },
                        ],
                    },
                }),
                JSON.stringify({
                    type: "result",
                    duration_ms: 1200,
                    usage: { output_tokens: 150 },
                }),
            ].join("\n") + "\n",
            "utf8"
        );

        const parsed = parseTranscript(txPath, "cold");
        assert.equal(parsed.cacheWriteTokens, 2000);
        assert.equal(parsed.cacheReadTokens, 4000);
        assert.equal(parsed.cachedInputTokens, 6000);
        assert.ok(parsed.symmetryViolations.some((v) => v.includes("answer key")));
        assert.ok(parsed.symmetryViolations.some((v) => v.includes("history")));
        assert.ok(parsed.symmetryViolations.some((v) => v.includes("Cold arm invoked plexer CLI")));

        // Worktree isolation & run config symmetry checks
        const coldWt = join(tmp, "cold-wt");
        mkdirSync(join(coldWt, "plexer"), { recursive: true });
        writeFileSync(join(coldWt, "CLAUDE.md"), "use plexer always", "utf8");
        const isoViol = checkWorktreeIsolation(coldWt, "cold");
        assert.ok(isoViol.some((v) => v.includes("plexer/")));
        assert.ok(isoViol.some((v) => v.includes("CLAUDE.md")));

        const cfgViol = checkRunConfigSymmetry(
            { model: "opus", effort: "medium", promptSha256: "abc" },
            { model: "opus", effort: "high", promptSha256: "def" }
        );
        assert.equal(cfgViol.length, 2);
    });

    it("fails closed on --no-docker (resolved: null) and distinguishes passing vs broken native patches", () => {
        const tmp = makeTempDir("plexer-tb-verify-");
        const repoDir = join(tmp, "repo");
        mkdirSync(repoDir, { recursive: true });
        writeFileSync(
            join(repoDir, "calc.js"),
            "export function add(a, b) {\n    return a - b;\n}\n",
            "utf8"
        );
        writeFileSync(
            join(repoDir, "calc.test.js"),
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.js";\ntest("add", () => { assert.equal(add(2, 3), 5); });\n',
            "utf8"
        );
        execFileSync("git", ["init", "-q"], { cwd: repoDir });
        execFileSync("git", ["config", "user.email", "t@local"], { cwd: repoDir });
        execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
        execFileSync("git", ["add", "."], { cwd: repoDir });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init", "--no-verify"], { cwd: repoDir });

        const noDockerRes = verifyTaskExecution(
            { id: "S1", docker_image: "img", verifier: { kind: "swebench-docker" } },
            "diff --git a/x b/x\n",
            { useDocker: false }
        );
        assert.equal(noDockerRes.verificationMode, "unverified-heuristic");
        assert.equal(noDockerRes.resolved, null);

        const nativeTask = {
            id: "NAT1",
            verifier: { kind: "native", command: "node --test calc.test.js" },
        };
        const brokenRes = verifyPatchAgainstBase(nativeTask, repoDir, "");
        assert.equal(brokenRes.resolved, false);

        const goldPatch = [
            "diff --git a/calc.js b/calc.js",
            "--- a/calc.js",
            "+++ b/calc.js",
            "@@ -1,3 +1,3 @@",
            " export function add(a, b) {",
            "-    return a - b;",
            "+    return a + b;",
            " }",
            "",
        ].join("\n");
        const goldRes = verifyPatchAgainstBase(nativeTask, repoDir, goldPatch);
        assert.equal(goldRes.resolved, true);
    });

    it("passes synthetic scale-stress smoke, hard-retrieval 116Q suite, v2 preflight, and chart SVG rendering", async () => {
        const preflight = buildV2PreflightSummary();
        assert.equal(preflight.leakageAudit.passed, true);
        assert.equal(preflight.selectedTaskCount, 18);

        const scaleRes = await runScaleStress({ targetNodes: 300, gate: false, json: true });
        assert.ok(scaleRes.nodes >= 250);
        assert.ok(scaleRes.edges > 0);
        for (const k of ["coldBuildMs", "dirtyCone1FileMs", "askSourceP50Ms", "callersD2P50Ms", "turn0HookMs", "daemonRpcMs", "peakRssMb"]) {
            assert.ok(Number.isFinite(scaleRes[k]) && scaleRes[k] >= 0, `expected finite non-negative ${k}, got ${scaleRes[k]}`);
        }
        assert.equal(scaleRes.gate.enforced, false);
        assert.equal(typeof scaleRes.gate.passed, "boolean");
        assert.ok(Array.isArray(scaleRes.gate.failures));

        const hardRes = await runHardRetrievalSuite({ gate: true });
        assert.equal(hardRes.totalQueries, 116);
        assert.equal(Object.keys(hardRes.categories).length, 5);
        assert.equal(hardRes.negativeQueries, 20);
        assert.equal(hardRes.gate.passed, true);

        // Chart rendering with real results dir + synthetic v2 fixture dir
        const smallSvg = renderChart(false, join(REPO_ROOT, "bench"));
        const fullSvg = renderChart(true, join(REPO_ROOT, "bench"));
        assert.ok(smallSvg.includes("<svg") && smallSvg.includes("$") && smallSvg.includes("wall time"));
        assert.ok(fullSvg.includes("N=1 (unreplicated)"));

        const fakeBench = makeTempDir("plexer-tb-chart-v2-");
        writeFileSync(
            join(fakeBench, "results-v2-opus.json"),
            JSON.stringify({
                model: "opus",
                trials: 3,
                useDocker: true,
                tasks: [
                    {
                        id: "V1",
                        tier: "small",
                        holdout: false,
                        negativeControl: false,
                        cold: { toolOutputTokens: 3000, calls: 4, cumulativeInputTokens: 20000, totalMs: 6000, apiCostUsd: 0.12, resolved: true },
                        plexer: { toolOutputTokens: 800, calls: 1, cumulativeInputTokens: 12000, totalMs: 3000, apiCostUsd: 0.07, resolved: true },
                    },
                    {
                        id: "V3",
                        tier: "small",
                        holdout: true,
                        negativeControl: false,
                        cold: { toolOutputTokens: 5000, calls: 6, cumulativeInputTokens: 35000, totalMs: 9000, apiCostUsd: 0.21, resolved: true },
                        plexer: { toolOutputTokens: 1400, calls: 2, cumulativeInputTokens: 19000, totalMs: 4500, apiCostUsd: 0.11, resolved: true },
                    },
                ],
            }),
            "utf8"
        );
        const v2Chart = renderChart(false, fakeBench);
        assert.ok(v2Chart.includes("v2 Scale Ladder") && v2Chart.includes("N=3") && v2Chart.includes("exec-verified"));
    });
});
