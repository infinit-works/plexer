#!/usr/bin/env node
/**
 * Automated prompt-leakage & holdout-integrity linter (`bench/audit-leakage.js`).
 *
 * Usage:
 *   node bench/audit-leakage.js [--suite v2|v1|all] [--strict-v1] [--json]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Compute deterministic SHA-256 over a task's placeholder prompt (`prompt("<REPO>")`).
 */
export function computePromptSha256(task) {
    const text = typeof task.prompt === "function" ? task.prompt("<REPO>") : String(task.prompt || "");
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeToken(text, tok) {
    if (!tok) return false;
    const esc = escapeRegExp(tok);
    const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`);
    return re.test(text);
}

/**
 * Audit a single benchmark task for file-path hints and internal symbol leakage.
 */
export function auditTaskLeakage(task) {
    const promptText =
        typeof task.prompt === "function" ? task.prompt("<REPO>") : String(task.prompt || "");
    const allowTerms = new Set(task.allowPublicApiTerms || []);
    const violations = [];

    const isIntentionalSpecControl =
        Boolean(task.negativeControl) &&
        (task.category === "local-typo" || task.category === "non-indexed-config");
    const isSymptomOrDiscovery =
        task.category !== "code-edit" || task.promptStyle === "symptom" || Boolean(task.deLeaked);

    // 1. Check file path / filename-with-ext leakage
    if (!isIntentionalSpecControl) {
        const goldFiles = task.goldFiles || task.gold_files || [];
        for (const rel of goldFiles) {
            if (!rel) continue;
            if (promptText.includes(rel)) {
                violations.push({
                    kind: "file_path",
                    token: rel,
                    reason: `Prompt mentions target file path "${rel}"`,
                });
                continue;
            }
            const base = basename(rel);
            if (base.includes(".") && containsWholeToken(promptText, base)) {
                violations.push({
                    kind: "file_basename",
                    token: base,
                    reason: `Prompt mentions target file basename "${base}"`,
                });
                continue;
            }
            const parts = rel.split("/").filter(Boolean);
            if (parts.length >= 2) {
                const dirHint = `${parts.slice(0, -1).join("/")}/`;
                if (promptText.includes(dirHint)) {
                    violations.push({
                        kind: "dir_hint",
                        token: dirHint,
                        reason: `Prompt mentions target directory "${dirHint}"`,
                    });
                }
            }
        }
    }

    // 2. Check internal/gold symbol leakage
    if (isSymptomOrDiscovery && !isIntentionalSpecControl) {
        const goldSyms = task.goldSymbols || task.oracleTokens || [];
        const leakedSyms = [];
        for (const sym of goldSyms) {
            if (!sym || allowTerms.has(sym)) continue;
            if (containsWholeToken(promptText, sym)) {
                leakedSyms.push(sym);
                const isPrivateOrDotted = sym.startsWith("_") || /\.[A-Za-z_]/.test(sym);
                if (isPrivateOrDotted) {
                    violations.push({
                        kind: "internal_symbol",
                        token: sym,
                        reason: `Prompt leaks internal/private symbol "${sym}"`,
                    });
                }
            }
        }
        if (leakedSyms.length > 1) {
            violations.push({
                kind: "multi_symbol_leak",
                token: leakedSyms.join(", "),
                reason: `Discovery/symptom prompt contains ${leakedSyms.length} gold symbols verbatim (>1): ${leakedSyms.join(", ")}`,
            });
        }
    }

    return {
        id: task.id,
        passed: violations.length === 0,
        violations,
    };
}

/**
 * Audit a suite of tasks and validate the locked holdout manifest if supplied.
 */
export function auditSuiteLeakage(tasks, opts = {}) {
    const taskResults = tasks.map((t) => auditTaskLeakage(t));
    const manifestViolations = [];

    if (opts.holdoutManifest) {
        const manifest = opts.holdoutManifest;
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const trainRepos = new Set(
            tasks.filter((t) => !t.holdout && !t.negativeControl).map((t) => t.repo)
        );
        const holdoutRepos = new Set(tasks.filter((t) => t.holdout).map((t) => t.repo));
        for (const hr of holdoutRepos) {
            if (trainRepos.has(hr)) {
                manifestViolations.push({
                    id: "HOLDOUT",
                    kind: "repo_overlap",
                    token: hr,
                    reason: `Holdout repo "${hr}" also appears in train tasks`,
                });
            }
        }
        for (const hid of manifest.v2HoldoutTaskIds || []) {
            const task = byId.get(hid);
            if (!task) {
                manifestViolations.push({
                    id: hid,
                    kind: "missing_holdout_task",
                    token: hid,
                    reason: `Holdout manifest lists missing task "${hid}"`,
                });
                continue;
            }
            if (!task.holdout) {
                manifestViolations.push({
                    id: hid,
                    kind: "holdout_flag_mismatch",
                    token: hid,
                    reason: `Holdout task "${hid}" must have holdout: true`,
                });
            }
            const expectedSha = manifest.promptSha256?.[hid];
            if (expectedSha) {
                const actualSha = computePromptSha256(task);
                if (actualSha !== expectedSha) {
                    manifestViolations.push({
                        id: hid,
                        kind: "prompt_sha_mismatch",
                        token: actualSha,
                        reason: `Holdout prompt SHA mismatch for ${hid} (expected ${expectedSha.slice(0, 12)}, got ${actualSha.slice(0, 12)})`,
                    });
                }
            }
        }
    }

    const totalViolations =
        taskResults.reduce((a, r) => a + r.violations.length, 0) + manifestViolations.length;
    return {
        passed: totalViolations === 0,
        totalTasks: tasks.length,
        cleanTasks: taskResults.filter((r) => r.passed).length,
        totalViolations,
        taskResults,
        manifestViolations,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const args = process.argv.slice(2);
    const suiteIdx = args.indexOf("--suite");
    const suiteArg = suiteIdx >= 0 && args[suiteIdx + 1] ? args[suiteIdx + 1] : "v2";
    const strictV1 = args.includes("--strict-v1");
    const asJson = args.includes("--json");

    const { ALL_V2_TASKS } = await import("./v2-tasks.js");
    const holdoutPath = resolve(import.meta.dirname, "v2-holdout.json");
    const holdoutManifest = existsSync(holdoutPath)
        ? JSON.parse(readFileSync(holdoutPath, "utf8"))
        : null;

    const v2Audit = auditSuiteLeakage(ALL_V2_TASKS, { holdoutManifest });
    let v1Audit = null;
    if (suiteArg === "v1" || suiteArg === "all") {
        const { TASKS } = await import("./tasks.js");
        const { LARGE_TASKS } = await import("./large-tasks.js");
        v1Audit = auditSuiteLeakage([...TASKS, ...LARGE_TASKS], {});
    }

    const gatePassed =
        (suiteArg === "v1" ? true : v2Audit.passed) &&
        (!strictV1 || !v1Audit || v1Audit.passed);

    if (asJson) {
        console.log(JSON.stringify({ gatePassed, v2: v2Audit, v1: v1Audit }, null, 2));
    } else {
        console.log(`=== Benchmark Leakage Audit (suite=${suiteArg}) ===`);
        if (suiteArg !== "v1") {
            console.log(
                `v2 suite: ${v2Audit.passed ? "PASS" : "FAIL"} (${v2Audit.cleanTasks}/${v2Audit.totalTasks} clean, ${v2Audit.totalViolations} violations)`
            );
            for (const r of v2Audit.taskResults.filter((x) => !x.passed)) {
                for (const v of r.violations) {
                    console.log(`  [FAIL] ${r.id} (${v.kind}): ${v.reason}`);
                }
            }
            for (const mv of v2Audit.manifestViolations) {
                console.log(`  [FAIL] ${mv.id} (${mv.kind}): ${mv.reason}`);
            }
        }
        if (v1Audit) {
            console.log(
                `v1 archive diagnostic: ${v1Audit.cleanTasks}/${v1Audit.totalTasks} clean, ${v1Audit.totalViolations} historical leaks`
            );
            for (const r of v1Audit.taskResults.filter((x) => !x.passed)) {
                console.log(
                    `  [v1-hist] ${r.id}: ${r.violations.map((v) => `${v.kind}:${v.token}`).join(" | ")}`
                );
            }
        }
    }

    if (!gatePassed) process.exit(1);
}
