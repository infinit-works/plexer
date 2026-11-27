import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Plexer } from "../src/index.js";
import { buildGraph } from "../src/graph/build.js";
import { moveFileOrDir, runAutofix } from "../src/health/autofix.js";
import { detectDuplicates } from "../src/health/duplicates.js";
import { detectDirectoryCycles, runGraphChecks } from "../src/health/graph-checks.js";
import { runHealthCommand } from "../src/health/health-cli.js";
import { managePlanCluster, managePlanPolicy, pruneExcludedIssues } from "../src/health/queue.js";
import { importReview, parseReviewRawText, runTriageStages } from "../src/health/review.js";
import { runSourceChecks } from "../src/health/source-checks.js";
import {
    emptyHealthState,
    emptyLivingPlan,
    loadHealthConfig,
    mergeScanIntoState,
} from "../src/health/state.js";
import {
    createSuppressionLedger,
    hasInlineSuppression,
    loadIgnoreRules,
    loadPackageEntrypoints,
    stripCodeLines,
} from "../src/health/zones.js";

function makeTmp(prefix = "plexer-w4-") {
    return mkdtempSync(join(tmpdir(), prefix));
}

function initGitRepo(dir) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

describe("Wave 4: Health Engine, ID Stability, Strict Autofix & Transactional Move", () => {
    it("1. never persists config.gitHistory, preserves scoped potentials, and creates nested viz output dirs", async () => {
        const tmp = makeTmp("plexer-w4-state-");
        try {
            mkdirSync(join(tmp, "src", "a"), { recursive: true });
            mkdirSync(join(tmp, "src", "b"), { recursive: true });
            writeFileSync(
                join(tmp, "src", "a", "alpha.js"),
                'export function alpha() {\n    console.log("DEBUG a");\n    return 1;\n}\n',
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "b", "beta.js"),
                'export function beta() {\n    console.log("DEBUG b");\n    return 2;\n}\n',
                "utf8",
            );
            initGitRepo(tmp);
            await buildGraph(tmp, { force: true });

            const healthDir = join(tmp, "plexer", ".health");
            mkdirSync(healthDir, { recursive: true });
            writeFileSync(
                join(healthDir, "config.json"),
                JSON.stringify({ target_strict_score: 98, gitHistory: { stale: true, files: {} } }, null, 2),
                "utf8",
            );

            const loadedCfg = loadHealthConfig(join(tmp, "plexer"));
            assert.equal("gitHistory" in loadedCfg, false, "loadHealthConfig must strip legacy gitHistory");

            const px = new Plexer();
            const fullScan = px.health(tmp, { action: "scan" });
            px.health(tmp, { action: "config", subAction: "set", key: "target_strict_score", value: "95" });
            const cfgDisk = JSON.parse(readFileSync(join(healthDir, "config.json"), "utf8"));
            assert.equal("gitHistory" in cfgDisk, false, "config.json must never persist gitHistory");

            const stateBeforeScoped = JSON.parse(readFileSync(join(healthDir, "state.json"), "utf8"));
            const globalDebugPotential = stateBeforeScoped.potentials.debug_logs;
            assert.ok(globalDebugPotential >= 2, `expected global debug_logs potential >= 2, got ${globalDebugPotential}`);

            px.health(tmp, { action: "scan", in: "src/a" });
            const stateAfterScoped = JSON.parse(readFileSync(join(healthDir, "state.json"), "utf8"));
            assert.equal(
                stateAfterScoped.potentials.debug_logs,
                globalDebugPotential,
                "scoped --in scan must preserve global potentials",
            );
            assert.ok(fullScan.scores.strict <= 100);

            const nestedOut = join(tmp, "reports", "nested", "treemap.html");
            const vizRes = px.health(tmp, { action: "viz", output: nestedOut });
            assert.equal(existsSync(vizRes.output_path), true, "viz must mkdirSync parent dirs");
            const html = readFileSync(vizRes.output_path, "utf8");
            assert.ok(html.includes('window.location.origin !== "null"'), "treemap postMessage must guard opaque sandbox origin");
            assert.ok(html.includes("targetOrigin"), "treemap postMessage must compute safe targetOrigin");
            assert.equal(html.includes('"plexer-treemap-select", path: n.path }, "*"'), false);
            assert.ok(html.includes('<option value="script">script</option>'), "zone-filter must include script");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("2. anchors issue IDs against line shifts, uses full paths in graph IDs, and carries over legacy triaged issues", async () => {
        const tmp = makeTmp("plexer-w4-ids-");
        try {
            mkdirSync(join(tmp, "src", "pkg1", "shared"), { recursive: true });
            mkdirSync(join(tmp, "src", "pkg2", "shared"), { recursive: true });
            writeFileSync(
                join(tmp, "src", "pkg1", "shared", "a.js"),
                'import { b } from "../../pkg2/shared/b.js";\nexport function runA() {\n    console.log("DEBUG one");\n    return b();\n}\n',
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "pkg2", "shared", "b.js"),
                'import { runA } from "../../pkg1/shared/a.js";\nexport function b() {\n    return typeof runA;\n}\n',
                "utf8",
            );
            await buildGraph(tmp, { force: true });

            const px = new Plexer();
            const scan1 = px.health(tmp, { action: "scan" });
            const dbg1 = scan1.queue.all_items.find((i) => i.detector === "debug_logs");
            assert.ok(dbg1, "expected debug_logs finding");
            assert.equal(/_L\d+$/.test(dbg1.id), false, `anchored ID must not end with _L<line>: ${dbg1.id}`);

            // Shift lines down by 10 lines -> ID must remain identical!
            const shifted = "\n".repeat(10) + readFileSync(join(tmp, "src", "pkg1", "shared", "a.js"), "utf8");
            writeFileSync(join(tmp, "src", "pkg1", "shared", "a.js"), shifted, "utf8");
            await buildGraph(tmp, { force: true });
            const scan2 = px.health(tmp, { action: "scan" });
            const dbg2 = scan2.queue.all_items.find((i) => i.detector === "debug_logs");
            assert.ok(dbg2);
            assert.equal(dbg2.id, dbg1.id, "shifting lines must preserve anchored issue ID");
            assert.equal(dbg2.line, dbg1.line + 10);

            // Carry-over migration from legacy line-baked ID onto new stable ID
            const legacyId = "debug_logs::src/pkg1/shared/a.js::L13";
            const legacyState = emptyHealthState();
            legacyState.scan_count = 1;
            legacyState.issues[legacyId] = {
                id: legacyId,
                detector: "debug_logs",
                category: "slop",
                file: "src/pkg1/shared/a.js",
                line: 13,
                end_line: 13,
                span: "L13-L13",
                identifier: "L13",
                status: "wontfix",
                suppressed: true,
                note: "Keep diagnostic trace for QA",
                attestation: "Intentional trace in QA staging path",
                first_seen_scan: 1,
                last_seen_scan: 1,
            };
            const legacyPlan = emptyLivingPlan();
            legacyPlan.queue_order = [legacyId];
            legacyPlan.deferred_ids = [legacyId];
            legacyPlan.annotations = { [legacyId]: { note: "Keep trace" } };
            legacyPlan.clusters = {
                qa_cluster: { name: "qa_cluster", issue_ids: [legacyId], steps: [{ index: 1, title: "Check", issue_refs: [legacyId] }] },
            };

            const merged = mergeScanIntoState(legacyState, [dbg2], { debug_logs: 2 }, legacyPlan, {});
            assert.equal(merged.state.issues[legacyId], undefined, "old legacy ID must be retired after carry-over");
            assert.ok(merged.state.issues[dbg2.id], "new stable ID must exist");
            assert.equal(merged.state.issues[dbg2.id].status, "wontfix", "triage status must carry over");
            assert.equal(merged.state.issues[dbg2.id].suppressed, true, "suppressed flag must carry over");
            assert.equal(merged.state.issues[dbg2.id].note, "Keep diagnostic trace for QA");
            assert.equal(merged.state.issues[dbg2.id].attestation, "Intentional trace in QA staging path");
            assert.ok(legacyPlan.queue_order.includes(dbg2.id) && !legacyPlan.queue_order.includes(legacyId));
            assert.ok(legacyPlan.deferred_ids.includes(dbg2.id) && !legacyPlan.deferred_ids.includes(legacyId));
            assert.ok(legacyPlan.annotations[dbg2.id] && !legacyPlan.annotations[legacyId]);
            assert.ok(legacyPlan.clusters.qa_cluster.issue_ids.includes(dbg2.id));
            assert.ok(legacyPlan.clusters.qa_cluster.steps[0].issue_refs.includes(dbg2.id));

            // Full relative paths in directory_cycles IDs
            const dirCycles = detectDirectoryCycles({
                nodes: [
                    { id: "f1", kind: "file", path: "src/pkg1/shared/a.js" },
                    { id: "f2", kind: "file", path: "src/pkg2/shared/b.js" },
                ],
                edges: [
                    { source: "f1", target: "f2", relation: "imports" },
                    { source: "f2", target: "f1", relation: "imports" },
                ],
            });
            assert.equal(dirCycles.length, 1);
            assert.ok(
                dirCycles[0].id.includes("src/pkg2/shared"),
                `directory_cycles ID must use full relative path, got: ${dirCycles[0].id}`,
            );
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("3. fixes review parsing, triage preservation, failing runner guard, and plan policy/purge/YAML bugs", async () => {
        // parseReviewRawText with braces in surrounding prose
        const parsed = parseReviewRawText(
            'Here is my summary {not json}\n```json\n{"observe": "ok", "assessments": {"naming_quality": 92}, "findings": []}\n```\nDone {bye}.',
        );
        assert.equal(parsed.observe, "ok");
        assert.throws(() => parseReviewRawText("[1, 2, 3]"), /valid JSON object/);

        // storeImportedReviewFindings preserves existing false_positive / wontfix triage
        const tmp = makeTmp("plexer-w4-rev-");
        try {
            mkdirSync(join(tmp, "plexer", ".health"), { recursive: true });
            const state = emptyHealthState();
            const existingId = "review::src/a.js::naming_quality_bad_name";
            state.issues[existingId] = {
                id: existingId,
                detector: "review",
                category: "review",
                dimension: "naming_quality",
                file: "src/a.js",
                identifier: "bad_name",
                status: "false_positive",
                suppressed: true,
                reason: "Legacy protocol wire field",
                note: "Confirmed intentional",
                first_seen_scan: 1,
                last_seen_scan: 1,
            };
            const payload = {
                assessments: { naming_quality: 90 },
                findings: [
                    {
                        dimension: "naming_quality",
                        identifier: "bad_name",
                        summary: "Ambiguous legacy field name",
                        suggestion: "Rename field",
                        related_files: ["src/a.js"],
                        evidence: ["src/a.js:L1"],
                        confidence: "medium",
                    },
                ],
            };
            const impRes = importReview(state, {}, payload, {
                contextDir: join(tmp, "plexer"),
                allowPartial: true,
                manualOverride: true,
                attest: "External manual review import verified in test harness",
                totalProdFiles: 1,
            });
            assert.equal(impRes.status, "imported");
            assert.equal(state.issues[existingId].status, "false_positive", "must preserve false_positive status");
            assert.equal(state.issues[existingId].suppressed, true);
            assert.equal(state.issues[existingId].reason, "Legacy protocol wire field");

            // runTriageStages must NOT mark completed=true when runner errors
            const plan = emptyLivingPlan();
            const triageErr = await runTriageStages(tmp, join(tmp, "plexer"), state, plan, {
                runnerCmd: 'node -e "process.exit(1)"',
            });
            assert.equal(triageErr.ok, false);
            assert.equal(plan.triage.completed, false, "errored triage runner must not set completed=true");

            // managePlanPolicy 1-based removal & config.layer_rules cleanup
            const cfg = { layer_rules: [] };
            managePlanPolicy(plan, "add", "forbid: src/a/** -> src/b/**", cfg);
            managePlanPolicy(plan, "add", "forbid: src/c/** -> src/d/**", cfg);
            assert.equal(plan.policies.length, 2);
            assert.equal(cfg.layer_rules.length, 2);

            managePlanPolicy(plan, "remove", "1", cfg);
            assert.deepEqual(plan.policies, ["forbid: src/c/** -> src/d/**"], "1-based index 1 must remove first policy");
            assert.equal(cfg.layer_rules.length, 1);
            assert.equal(cfg.layer_rules[0].from, "src/c/**");

            // purgeIdsFromPlan cleans deferred_ids, promoted_ids, skipped, annotations, and step issue_refs
            state.issues["dead_symbols::src/dead.js::fn"] = { id: "dead_symbols::src/dead.js::fn", file: "src/dead.js" };
            plan.queue_order = ["dead_symbols::src/dead.js::fn", "keep::src/ok.js::x"];
            plan.deferred_ids = ["dead_symbols::src/dead.js::fn"];
            plan.promoted_ids = ["dead_symbols::src/dead.js::fn"];
            plan.skipped = { "dead_symbols::src/dead.js::fn": { status: "deferred" } };
            plan.annotations = { "dead_symbols::src/dead.js::fn": { note: "old" } };
            plan.clusters = {
                c1: {
                    name: "c1",
                    issue_ids: ["dead_symbols::src/dead.js::fn"],
                    steps: [{ index: 1, title: "S1", issue_refs: ["dead_symbols::src/dead.js::fn"] }],
                },
            };
            pruneExcludedIssues(state, plan, "src/dead.js");
            assert.equal(plan.deferred_ids.length, 0);
            assert.equal(plan.promoted_ids.length, 0);
            assert.equal(Object.keys(plan.skipped).length, 0);
            assert.equal(Object.keys(plan.annotations).length, 0);
            assert.equal(plan.clusters.c1.steps[0].issue_refs.length, 0);

            // YAML export/import round-trip preserves issue_refs & escapes
            plan.clusters.exp_c = {
                name: "exp_c",
                auto: false,
                depends_on: [],
                issue_ids: ["keep::src/ok.js::x"],
                steps: [
                    {
                        index: 1,
                        title: 'Fix "quoted" handler',
                        detail: "Line 1\\nLine 2",
                        effort: "small",
                        issue_refs: ["keep::src/ok.js::x"],
                        done: false,
                    },
                ],
            };
            const exportedYaml = managePlanCluster(state, plan, "export", "exp_c", [], { exportFormat: "yaml" }).exported;
            delete plan.clusters.exp_c;
            const imported = managePlanCluster(state, plan, "import", null, [], { content: exportedYaml });
            assert.equal(imported.ok, true);
            assert.equal(plan.clusters.exp_c.steps[0].title, 'Fix "quoted" handler');
            assert.deepEqual(plan.clusters.exp_c.steps[0].issue_refs, ["keep::src/ok.js::x"]);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("4. runs stateful multi-line stripper, wildcard exports, security decoupling, 3-node dir cycles, Go defer, and non-bridging duplicates", () => {
        // Stateful stripper: multi-line /* */, nested JS template ${...}, JS regex before //, Rust lifetimes
        const jsStripped = stripCodeLines(
            [
                "/* multi",
                "   comment */ const re = /https?:\\/\\//g; // real comment",
                "const msg = `hi ${a + `nested ${b}`} // still template`;",
            ],
            { relPath: "src/app.js" },
        );
        assert.equal(jsStripped[0].trim(), "");
        assert.ok(jsStripped[1].includes('const re = "";'), `got: ${jsStripped[1]}`);
        assert.ok(!jsStripped[1].includes("real comment"));
        assert.ok(jsStripped[2].includes("a +") && jsStripped[2].includes("b"), `template expr lost: ${jsStripped[2]}`);

        const rsStripped = stripCodeLines(["fn borrow<'a, 'b>(x: &'a str, ch: char) -> &'b str { 'z'; x }"], { relPath: "src/lib.rs" });
        assert.ok(rsStripped[0].includes("'a") && rsStripped[0].includes("'b"), `Rust lifetimes corrupted: ${rsStripped[0]}`);

        // hasInlineSuppression: ignore inside strings, support : reason, reject partial-word match
        assert.equal(hasInlineSuppression(['const s = "// plexer-ignore: all"; eval(x);'], 1, "security_traps"), false);
        assert.equal(hasInlineSuppression(["// plexer-ignore: security_traps: intentional eval", "eval(x);"], 2, "security_traps"), true);
        assert.equal(hasInlineSuppression(["// plexer-ignore: quality", "wait(1)"], 2, "luau_quality"), false);

        const tmp = makeTmp("plexer-w4-det-");
        try {
            mkdirSync(join(tmp, "src", "features"), { recursive: true });
            writeFileSync(
                join(tmp, "package.json"),
                JSON.stringify({ name: "demo", exports: { "./*": "./src/features/*.js" } }),
                "utf8",
            );
            const entrypoints = loadPackageEntrypoints(tmp);
            assert.equal(entrypoints.has("src/features/widget.js"), true, "wildcard package.json exports must match");

            // Security decoupling: .plexerignore `traps:src/sec.py` must NOT disable security_traps
            writeFileSync(join(tmp, ".plexerignore"), "traps:src/sec.py\n", "utf8");
            const ledger = createSuppressionLedger();
            const ignoreRules = loadIgnoreRules(tmp, [], ledger);

            const files = {
                "src/sec.py": [
                    "import subprocess",
                    'passwordLabel = "Enter your account password"',
                    'REAL_API_KEY = "sk_live_1234567890abcdef12345678"',
                    "def run(cmd):",
                    "    return subprocess.run(cmd)",
                    "",
                ],
                "src/catch_hoist.js": [
                    "export function handle() {",
                    "    try { work(); } catch (e) { console.error(e); }",
                    "    return helper();",
                    "    function helper() { return 1; }",
                    "}",
                    "",
                ],
                "src/loop_defer.go": [
                    "package main",
                    "func okAndBad() {",
                    "    for i := 0; i < 3; i++ {",
                    "        f := open(i)",
                    "        defer f.Close()",
                    "        func() { defer f.Close() }()",
                    "    }",
                    "    g := open(9)",
                    "    defer g.Close()",
                    "}",
                    "",
                ],
                "src/dict_escape.js": [
                    "function send(v) { return v; }",
                    "function format(v) { return v; }",
                    "export function run() {",
                    "    const cfg = {};",
                    '    cfg["a"] = 1;',
                    '    cfg["unused_but_escaped"] = 2;',
                    '    const x = cfg["a"];',
                    "    return send(format(cfg)) + x;",
                    "}",
                    "",
                ],
                "src/multi_unused.ts": [
                    "import {",
                    "    usedFn,",
                    "    unusedFn,",
                    '} from "./dep";',
                    "export const out = usedFn();",
                    "",
                ],
                "src/py_facade_not.py": [
                    "from typing import Any",
                    "from pathlib import Path",
                    "DEFAULT_DIR = Path('.')",
                    "META: Any = {'v': 1}",
                    "",
                ],
                "src/wrap.ts": [
                    "function target(a: number, b = 10) { return a + b; }",
                    "function withDefault(a: number, b = 5) { return target(a, b); }",
                    "function dropArg(a: number, _b: number) { return target(a); }",
                    "export const res = withDefault(1) + dropArg(1, 2);",
                    "",
                ],
                "src/dupe_a.js": [
                    "export function procA(items) {",
                    "    let sum = 0;",
                    "    for (const it of items) {",
                    "        if (it.active) {",
                    "            sum += it.score * 2;",
                    "            alphaOne(it.id);",
                    "            alphaTwo(it.name);",
                    "            alphaThree(sum);",
                    "            alphaFour(it);",
                    "        }",
                    "    }",
                    "    return sum;",
                    "}",
                    "",
                ],
                "src/dupe_b.js": [
                    "export function procB(items) {",
                    "    let total = 0;",
                    "    for (const el of items) {",
                    "        if (el.active) {",
                    "            total += el.score * 2;",
                    "            alphaOne(el.id);",
                    "            alphaTwo(el.name);",
                    "            betaThree(total);",
                    "            betaFour(el);",
                    "        }",
                    "    }",
                    "    return total;",
                    "}",
                    "",
                ],
                "src/dupe_c.js": [
                    "export function procC(items) {",
                    "    let acc = 0;",
                    "    for (const row of items) {",
                    "        if (row.active) {",
                    "            acc += row.score * 2;",
                    "            gammaOne(row.id);",
                    "            gammaTwo(row.name);",
                    "            betaThree(acc);",
                    "            betaFour(row);",
                    "        }",
                    "    }",
                    "    return acc;",
                    "}",
                    "",
                ],
            };

            const mockGraph = {
                nodes: [
                    ...Object.keys(files).map((p) => ({ id: p, kind: "file", path: p, lineCount: files[p].length })),
                    { id: "sym_handle", kind: "function", path: "src/catch_hoist.js", name: "handle", span: "L1-L5", exported: true },
                    { id: "sym_run", kind: "function", path: "src/dict_escape.js", name: "run", span: "L3-L9", exported: true },
                    { id: "sym_wd", kind: "function", path: "src/wrap.ts", name: "withDefault", span: "L2-L2", exported: false },
                    { id: "sym_da", kind: "function", path: "src/wrap.ts", name: "dropArg", span: "L3-L3", exported: false },
                    { id: "sym_pa", kind: "function", path: "src/dupe_a.js", name: "procA", span: "L1-L13", exported: true },
                    { id: "sym_pb", kind: "function", path: "src/dupe_b.js", name: "procB", span: "L1-L13", exported: true },
                    { id: "sym_pc", kind: "function", path: "src/dupe_c.js", name: "procC", span: "L1-L13", exported: true },
                ],
                edges: [],
            };
            const readLines = (p) => files[p] || null;
            const zoneMap = new Map(Object.keys(files).map((p) => [p, "production"]));

            const secOnly = runSourceChecks(mockGraph, readLines, zoneMap, ignoreRules, new Set(["security"]));
            assert.ok(
                secOnly.issues.some((i) => i.file === "src/sec.py" && i.detector === "security_traps" && i.summary.includes("subprocess")),
                "traps:src/sec.py must NOT silence security_traps",
            );
            assert.ok(
                !secOnly.issues.some((i) => i.file === "src/sec.py" && i.summary.includes("passwordLabel")),
                "UI label string must be filtered from secretVarMatch",
            );
            assert.ok(secOnly.issues.every((i) => i.category === "security"));

            const allSrc = runSourceChecks(
                mockGraph,
                readLines,
                zoneMap,
                ignoreRules,
                new Set(["dead", "catches", "types", "traps", "slop", "security"]),
            );
            assert.ok(
                allSrc.issues.some((i) => i.file === "src/catch_hoist.js" && i.detector === "silent_catches"),
                "single-line catch (e) { console.error(e); } must be caught",
            );
            assert.equal(
                allSrc.issues.some((i) => i.file === "src/catch_hoist.js" && i.detector === "language_traps"),
                false,
                "hoisted JS function declaration after return must not be flagged unreachable",
            );
            const deferIssues = allSrc.issues.filter((i) => i.file === "src/loop_defer.go" && i.detector === "language_traps");
            assert.equal(deferIssues.length, 1, `expected exactly 1 go_defer_loop issue (not inside inner func or outside loop), got ${deferIssues.length}`);
            assert.equal(deferIssues[0].line, 5);
            assert.equal(
                allSrc.issues.some((i) => i.file === "src/dict_escape.js" && i.detector === "dict_keys"),
                false,
                "nested call send(format(cfg)) must count as dict escape",
            );
            assert.ok(
                allSrc.issues.some((i) => i.file === "src/multi_unused.ts" && i.detector === "unused_imports" && i.detail.removed_names.includes("unusedFn")),
                "multi-line JS/TS unused_imports must be detected",
            );

            const gRes = runGraphChecks(mockGraph, readLines, zoneMap, ignoreRules, new Set(["dead"]));
            assert.equal(
                gRes.issues.some((i) => i.file === "src/py_facade_not.py" && i.detector === "facade_modules"),
                false,
                "Python module with `from X import Y` and constants must not false-positive as facade",
            );
            assert.equal(
                gRes.issues.some((i) => i.file === "src/wrap.ts" && i.detector === "passthrough_wrappers"),
                false,
                "wrapper with default param or dropped trailing arg must not be flagged as passthrough",
            );

            // 3-node directory cycle
            const dir3 = detectDirectoryCycles({
                nodes: [
                    { id: "a", kind: "file", path: "src/d1/a.js" },
                    { id: "b", kind: "file", path: "src/d2/b.js" },
                    { id: "c", kind: "file", path: "src/d3/c.js" },
                ],
                edges: [
                    { source: "a", target: "b", relation: "imports" },
                    { source: "b", target: "c", relation: "imports" },
                    { source: "c", target: "a", relation: "imports" },
                ],
            });
            assert.equal(dir3.length, 1);
            assert.equal(dir3[0].cycle.length, 3);

            // Duplicates: prevent transitive bridging A ~ B ~ C when A !~ C
            const dupRes = detectDuplicates(mockGraph, readLines, zoneMap, ignoreRules);
            for (const iss of dupRes.issues) {
                const names = new Set((iss.members || []).map((m) => m.name));
                assert.equal(
                    names.has("procA") && names.has("procC"),
                    false,
                    "UnionFind must not transitively bridge procA and procC via procB",
                );
            }
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("5. enforces strict autofix guards and transactional moveFileOrDir across barrels, Python relative imports, and symlinks", async () => {
        const tmp = makeTmp("plexer-w4-fix-");
        try {
            mkdirSync(join(tmp, "src", "luau"), { recursive: true });
            mkdirSync(join(tmp, "src", "py"), { recursive: true });
            mkdirSync(join(tmp, "src", "js"), { recursive: true });

            // Luau edge cases
            const luauSafe = [
                'local s = "contains [[ long bracket inside string"',
                "local function runSafe()",
                "    wait(0.2)",
                "    spawn(function() end)",
                "    delay(1, function() end)",
                "    for i = 1, 2",
                "    do",
                "        local x = i",
                "    end",
                "    local Players = game:GetService('Players')",
                "    return Players, s",
                "end",
                "return runSafe",
                "",
            ].join("\n");
            writeFileSync(join(tmp, "src", "luau", "Safe.luau"), luauSafe, "utf8");

            const luauUnsafeHoistAndParent = [
                "local Players = { mock = true }",
                "local function init()",
                "    if not game:GetService('RunService'):IsServer() then return end",
                "    local ServerStorage = game:GetService('ServerStorage')",
                "    local Players = game:GetService('Players')",
                "    local part = Instance.new('Part', part)",
                "    local p2 = Instance.new('Frame', workspace)",
                "    local parentRef = p2.Parent",
                "    return ServerStorage, Players, part, parentRef",
                "end",
                "return init",
                "",
            ].join("\n");
            writeFileSync(join(tmp, "src", "luau", "Guarded.luau"), luauUnsafeHoistAndParent, "utf8");

            // Python sole-body debug log + JS nested-call debug log
            writeFileSync(
                join(tmp, "src", "py", "sole.py"),
                'def f(flag):\n    if flag:\n        print("DEBUG sole body")\n    return flag\n',
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "js", "side.js"),
                'export function g(fn) {\n    console.log("DEBUG side effect", fn());\n    return 1;\n}\n',
                "utf8",
            );

            const mockGraph = {
                nodes: [
                    { id: "src/luau/Safe.luau", kind: "file", path: "src/luau/Safe.luau" },
                    { id: "src/luau/Guarded.luau", kind: "file", path: "src/luau/Guarded.luau" },
                    { id: "src/py/sole.py", kind: "file", path: "src/py/sole.py" },
                    { id: "src/js/side.js", kind: "file", path: "src/js/side.js" },
                ],
                edges: [],
            };
            const zoneMap = new Map(mockGraph.nodes.map((n) => [n.path, "production"]));
            const ignoreRules = loadIgnoreRules(tmp);

            const state = emptyHealthState();
            state.issues = {
                "luau_quality::src/luau/Safe.luau::wait_1": {
                    id: "luau_quality::src/luau/Safe.luau::wait_1",
                    detector: "luau_quality",
                    identifier: "wait_L3",
                    file: "src/luau/Safe.luau",
                    line: 3,
                    end_line: 3,
                    status: "open",
                },
                "type_bypasses::src/luau/Safe.luau::any_1": {
                    id: "type_bypasses::src/luau/Safe.luau::any_1",
                    detector: "type_bypasses",
                    identifier: "any",
                    file: "src/luau/Safe.luau",
                    line: 2,
                    end_line: 2,
                    summary: "Unsound type bypass :: any",
                    status: "open",
                },
            };

            runAutofix(tmp, mockGraph, zoneMap, ignoreRules, "all", { state });
            runAutofix(tmp, mockGraph, zoneMap, ignoreRules, "luau-hoist-getservice", { state });
            runAutofix(tmp, mockGraph, zoneMap, ignoreRules, "luau-strict-header", { state });

            const safeAfter = readFileSync(join(tmp, "src", "luau", "Safe.luau"), "utf8");
            assert.ok(safeAfter.includes("task.wait(0.2)"), "wait -> task.wait even after [[ in string");
            assert.ok(safeAfter.includes("task.defer(function() end)"), "spawn -> task.defer");
            assert.ok(safeAfter.includes("delay(1, function() end)"), "delay must remain flag-only (unrewritten)");
            assert.ok(
                safeAfter.startsWith('--!strict\nlocal Players = game:GetService("Players")'),
                "GetService after multiline for..do inside runSafe must hoist cleanly to top",
            );
            assert.equal(safeAfter.includes("game:GetService('Players')"), false, "inline GetService line must be removed when hoisted");

            // Guarded.luau must NOT rewrite shadowed/guarded GetService or shadowed/read Instance.new
            const guardedAfter = readFileSync(join(tmp, "src", "luau", "Guarded.luau"), "utf8");
            assert.ok(guardedAfter.includes("Instance.new('Part', part)"), "self-shadowed Instance.new must not split");
            assert.ok(guardedAfter.includes("Instance.new('Frame', workspace)"), "Instance.new with .Parent read must not split");
            assert.equal(guardedAfter.startsWith("local ServerStorage"), false, "must not hoist across IsServer()+return guard");
            assert.ok(guardedAfter.startsWith("--!strict\nlocal Players = { mock = true }"), "must not hoist shadowing Players");

            // luau-strict-header must NOT mark unrelated type_bypasses :: any fixed!
            assert.equal(state.issues["type_bypasses::src/luau/Safe.luau::any_1"].status, "open");
            assert.equal(state.issues["luau_quality::src/luau/Safe.luau::wait_1"].status, "fixed");

            // debug-logs guards
            assert.ok(readFileSync(join(tmp, "src", "py", "sole.py"), "utf8").includes("DEBUG sole body"));
            assert.ok(readFileSync(join(tmp, "src", "js", "side.js"), "utf8").includes("DEBUG side effect"));

            // Transactional moveFileOrDir: barrel + comments/strings safety + Python relative + symlink dir
            mkdirSync(join(tmp, "src", "oldbarrel"), { recursive: true });
            writeFileSync(join(tmp, "src", "oldbarrel", "index.ts"), "export const val = 42;\n", "utf8");
            writeFileSync(
                join(tmp, "src", "consumer.ts"),
                '// import { val } from "./oldbarrel";\nconst note = "from ./oldbarrel";\nimport { val } from "./oldbarrel";\nexport const out = val;\n',
                "utf8",
            );
            mkdirSync(join(tmp, "src", "pypkg"), { recursive: true });
            writeFileSync(join(tmp, "src", "pypkg", "__init__.py"), "", "utf8");
            writeFileSync(join(tmp, "src", "pypkg", "helper.py"), "def h(): return 1\n", "utf8");
            writeFileSync(join(tmp, "src", "pypkg", "caller.py"), "from .helper import h\n", "utf8");

            const mvGraph = {
                nodes: [
                    { id: "src/oldbarrel/index.ts", kind: "file", path: "src/oldbarrel/index.ts" },
                    { id: "src/consumer.ts", kind: "file", path: "src/consumer.ts" },
                    { id: "src/pypkg/__init__.py", kind: "file", path: "src/pypkg/__init__.py" },
                    { id: "src/pypkg/helper.py", kind: "file", path: "src/pypkg/helper.py" },
                    { id: "src/pypkg/caller.py", kind: "file", path: "src/pypkg/caller.py" },
                ],
                edges: [
                    { source: "src/consumer.ts", target: "src/oldbarrel/index.ts", relation: "imports" },
                    { source: "src/pypkg/caller.py", target: "src/pypkg/helper.py", relation: "imports" },
                ],
            };

            moveFileOrDir(tmp, mvGraph, "src/oldbarrel/index.ts", "src/newbarrel/index.ts", { rebuildGraph: false });
            const consumerAfter = readFileSync(join(tmp, "src", "consumer.ts"), "utf8");
            assert.ok(consumerAfter.includes('// import { val } from "./oldbarrel";'), "comment import must stay untouched");
            assert.ok(consumerAfter.includes('const note = "from ./oldbarrel";'), "string literal must stay untouched");
            assert.ok(consumerAfter.includes('import { val } from "./newbarrel";'), "real barrel import must rewrite");

            moveFileOrDir(tmp, mvGraph, "src/pypkg/helper.py", "src/shared/helper.py", { rebuildGraph: false });
            const pyCallerAfter = readFileSync(join(tmp, "src", "pypkg", "caller.py"), "utf8");
            assert.ok(pyCallerAfter.includes("from ..shared.helper import h"), `Python relative import failed: ${pyCallerAfter}`);

            // Directory move preserves symlinks via lstatSync/readlinkSync
            mkdirSync(join(tmp, "src", "linkdir"), { recursive: true });
            writeFileSync(join(tmp, "src", "linkdir", "real.js"), "export const x = 1;\n", "utf8");
            symlinkSync("./real.js", join(tmp, "src", "linkdir", "alias.js"));
            moveFileOrDir(tmp, mvGraph, "src/linkdir", "src/movedlinkdir", { rebuildGraph: false });
            assert.equal(lstatSync(join(tmp, "src", "movedlinkdir", "alias.js")).isSymbolicLink(), true, "moved dir symlink must stay symlink");
            assert.equal(readlinkSync(join(tmp, "src", "movedlinkdir", "alias.js")), "./real.js");

            // CLI status smoke check
            await buildGraph(tmp, { force: true });
            const resCli = await runHealthCommand(tmp, ["status"], { json: true });
            assert.ok(resCli.scores);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
