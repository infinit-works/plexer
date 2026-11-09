import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Plexer, buildGraph } from "../src/index.js";
import { blastRadiusIn } from "../src/blast/blast.js";
import { markdownReport, textReport } from "../src/blast/render.js";
import { loadGraphCached } from "../src/graph/load.js";
import { callTool } from "../src/mcp/tools.js";
import { classifyStemConvention } from "../src/health/concerns.js";
import { SUBJECTIVE_DIMENSIONS } from "../src/health/constants.js";
import { emptyHealthConfig, healthDir, mintIssueId } from "../src/health/state.js";
import { classifyZone, hasInlineSuppression, loadIgnoreRules } from "../src/health/zones.js";
import { buildVizHealthPayload } from "../src/viz/serve.js";

describe("plexer health (living plan loop, 20-dim review, Luau/Roblox & parity upgrades)", () => {
    it("runs full scan -> next -> autofix -> move -> resolve -> suppress -> review -> tree/viz/detect -> status loop", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-test-"));
        try {
            mkdirSync(join(tmp, "src", "Server"), { recursive: true });
            mkdirSync(join(tmp, "src", "Client"), { recursive: true });
            mkdirSync(join(tmp, "src", "Shared"), { recursive: true });
            mkdirSync(join(tmp, "Packages", "VendorLib"), { recursive: true });
            mkdirSync(join(tmp, "tests"), { recursive: true });

            // Vendor file (should be classified as vendor zone and excluded from scoring)
            writeFileSync(
                join(tmp, "Packages", "VendorLib", "init.luau"),
                "local Vendor = {}\nwait(1)\nreturn Vendor\n",
                "utf8",
            );

            // Shared module
            writeFileSync(
                join(tmp, "src", "Shared", "Util.luau"),
                [
                    "--!strict",
                    "local Util = {}",
                    "",
                    "function Util.compute(a: number, b: number): number",
                    "    local x = a + b",
                    "    local y = x * 2",
                    "    local z = y - a",
                    "    local w = z + b",
                    "    if w > 10 then",
                    "        return w + 1",
                    "    end",
                    "    return w",
                    "end",
                    "",
                    "function Util.computeCopy(p: number, q: number): number",
                    "    local x = p + q",
                    "    local y = x * 2",
                    "    local z = y - p",
                    "    local w = z + q",
                    "    if w > 10 then",
                    "        return w + 1",
                    "    end",
                    "    return w",
                    "end",
                    "",
                    "local function deadInternalHelper()",
                    "    return 42",
                    "end",
                    "",
                    "return Util",
                ].join("\n"),
                "utf8",
            );

            // Server module with Luau/Roblox traps (legacy wait(), Instance.new 2-arg, GetService in function, unvalidated OnServerEvent, bare pcall, unused require)
            writeFileSync(
                join(tmp, "src", "Server", "CombatService.server.luau"),
                [
                    "local Util = require(script.Parent.Parent.Shared.Util)",
                    "local UnusedDep = require(script.Parent.Parent.Shared.Util)",
                    "local Remote = workspace.RemoteEvent",
                    "",
                    "Remote.OnServerEvent:Connect(function(player, targetId, damage)",
                    "    wait(0.1)",
                    "    local part = Instance.new('Part', workspace)",
                    "    local Players = game:GetService('Players')",
                    "    pcall(function() part:Destroy() end)",
                    "    print('DEBUG hit', player, targetId, damage, Players, Util.compute(1, 2))",
                    "end)",
                ].join("\n"),
                "utf8",
            );

            // Client module with Client -> Server boundary violation
            writeFileSync(
                join(tmp, "src", "Client", "Hud.client.luau"),
                [
                    "local ServerStorage = game:GetService('ServerStorage')",
                    "local Util = require(script.Parent.Parent.Shared.Util)",
                    "print(ServerStorage, Util.compute(3, 4))",
                ].join("\n"),
                "utf8",
            );

            // Python module with mutable default + @lru_cache over mutable global + subprocess without timeout
            writeFileSync(
                join(tmp, "src", "worker.py"),
                [
                    "from functools import lru_cache",
                    "import subprocess",
                    "",
                    "MUTABLE_STATE = {'count': 0}",
                    "",
                    "@lru_cache(maxsize=16)",
                    "def read_cached(key):",
                    "    return MUTABLE_STATE.get(key)",
                    "",
                    "def append_item(item, bucket=[]):",
                    "    subprocess.run(['echo', str(item)])",
                    "    bucket.append(item)",
                    "    return bucket",
                    "",
                    "def syncPayload(user_id):",
                    "    return user_id",
                ].join("\n"),
                "utf8",
            );

            // Signature variance across 3 files for `syncPayload`
            writeFileSync(
                join(tmp, "src", "sync_a.py"),
                "def syncPayload(user_id, force_flag):\n    return (user_id, force_flag)\n",
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "sync_b.py"),
                "def syncPayload(user_id, force_flag, retries, timeout_ms):\n    return (user_id, force_flag, retries, timeout_ms)\n",
                "utf8",
            );

            // Hollow test file (0 assertions)
            writeFileSync(
                join(tmp, "tests", "combat.spec.luau"),
                [
                    "local function runSpec()",
                    "    local a = 1 + 1",
                    "    local b = a * 2",
                    "    local c = b + 3",
                    "    return c",
                    "end",
                    "runSpec()",
                ].join("\n"),
                "utf8",
            );

            const px = new Plexer();
            await px.graph(tmp);

            // Verify all 20 subjective dimensions exist
            assert.equal(Object.keys(SUBJECTIVE_DIMENSIONS).length, 20);

            // 1. Prompt generation
            const promptRes = px.health(tmp, { action: "prompt" });
            assert.ok(promptRes.prompt.includes("THE LOOP: run `plexer health next`"));

            // 2. Scan
            const scan1 = px.health(tmp, { action: "scan" });
            assert.equal(scan1.action, "scan");
            assert.equal(scan1.diff.scan_count, 1);
            assert.ok(scan1.diff.open_count >= 9, `expected >=9 findings, got ${scan1.diff.open_count}`);

            const detectorsHit = new Set(scan1.queue.all_items.map((i) => i.detector));
            assert.ok(detectorsHit.has("duplicates"), "should detect duplicate Luau functions");
            assert.ok(detectorsHit.has("dead_symbols"), "should detect dead local Luau function");
            assert.ok(detectorsHit.has("roblox_security"), "should detect Roblox remote & client->server boundary issues");
            assert.ok(detectorsHit.has("luau_quality"), "should detect wait(), Instance.new 2-arg, GetService in fn");
            assert.ok(detectorsHit.has("language_traps"), "should detect Python mutable default & lru_cache mutable global");
            assert.ok(detectorsHit.has("security_traps"), "should detect Python subprocess without timeout");
            assert.ok(detectorsHit.has("signature_variance"), "should detect signature_variance across 3 files");
            assert.ok(detectorsHit.has("hollow_tests"), "should detect hollow test spec");

            // Stateless single-detector `detect` command
            const detectSig = px.health(tmp, { action: "detect", detector: "signature_variance" });
            assert.equal(detectSig.action, "detect");
            assert.equal(detectSig.count, 1);
            assert.equal(detectSig.items[0].identifier, "syncPayload");

            // Ensure vendor zone was NOT scored
            assert.ok(
                !scan1.queue.all_items.some((i) => i.file.startsWith("Packages/")),
                "Packages/ vendor zone must be excluded from findings",
            );

            // 3. Next queue, Plan Clusters (`create`, `list`, `show`, `update --depends-on`), and Triage
            const nextRes = px.health(tmp, { action: "next", count: 3 });
            assert.equal(nextRes.queue.items.length, 3);
            assert.ok(nextRes.queue.items[0].resolve_command.includes("plexer health resolve"));

            px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "create",
                clusterName: "luau_fixes",
                patterns: ["*CombatService*"],
            });
            px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "create",
                clusterName: "py_fixes",
                patterns: ["*worker.py*"],
                dependsOn: "luau_fixes",
            });
            const clusterList = px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "list",
            });
            assert.ok(clusterList.clusters.some((c) => c.name === "luau_fixes"));
            assert.ok(
                clusterList.clusters.some(
                    (c) => c.name === "py_fixes" && c.depends_on.includes("luau_fixes"),
                ),
            );
            const clusterShow = px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "show",
                clusterName: "luau_fixes",
            });
            assert.ok(clusterShow.cluster.issues.length >= 1);

            const triageObs = px.health(tmp, {
                action: "plan",
                subAction: "triage",
                stage: "observe",
                report: "Observed Luau scheduler and remote validation issues",
            });
            assert.equal(triageObs.stage, "observe");

            const triageDone = px.health(tmp, {
                action: "plan",
                subAction: "triage",
                complete: true,
                strategy: "Fix T1 autofixers first, then remote validation",
            });
            assert.equal(triageDone.triage.completed, true);

            // 4. Expanded Autofixers (`luau-task-scheduler`, `luau-instance-new-parent`, `luau-hoist-getservice`, `debug-logs`, `unused-imports`)
            const fixDry = px.health(tmp, { action: "autofix", fixer: "all", dryRun: true });
            assert.ok(fixDry.total_edits >= 4);
            const fixApply = px.health(tmp, { action: "autofix", fixer: "all", dryRun: false });
            assert.equal(fixApply.files_changed, 1);
            px.health(tmp, { action: "autofix", fixer: "unused-imports", dryRun: false });

            const updatedServer = readFileSync(
                join(tmp, "src", "Server", "CombatService.server.luau"),
                "utf8",
            );
            assert.ok(updatedServer.includes("task.wait(0.1)"), "wait(0.1) should be rewritten to task.wait(0.1)");
            assert.ok(
                updatedServer.includes("local part = Instance.new('Part')") &&
                    updatedServer.includes("part.Parent = workspace"),
                "Instance.new 2-arg should be split into creation + .Parent assignment",
            );
            assert.ok(
                updatedServer.startsWith('local Players = game:GetService("Players")'),
                "game:GetService('Players') should be hoisted to module top",
            );
            assert.ok(!updatedServer.includes("UnusedDep"), "unused local require should be removed");
            assert.ok(!updatedServer.includes("print('DEBUG hit'"), "DEBUG print should be removed");

            // 5. Move file and rewrite Luau `require(script.Parent...)`
            const moveRes = px.health(tmp, {
                action: "move",
                src: "src/Shared/Util.luau",
                dst: "src/Server/Util.luau",
                dryRun: false,
            });
            assert.equal(moveRes.to, "src/Server/Util.luau");
            assert.ok(moveRes.updated_importers.includes("src/Server/CombatService.server.luau"));
            const afterMoveServer = readFileSync(
                join(tmp, "src", "Server", "CombatService.server.luau"),
                "utf8",
            );
            assert.ok(
                afterMoveServer.includes("require(script.Parent.Util)"),
                `expected require(script.Parent.Util), got:\n${afterMoveServer}`,
            );

            // 6. Resolve, Strict Attestation Validation on `skip --permanent`, and `suppress`
            const firstId = nextRes.queue.items[0].id;
            const secondId = nextRes.queue.items[1].id;
            const resOut = px.health(tmp, {
                action: "resolve",
                patterns: [firstId],
                note: "Fixed via autofix",
                confirm: true,
            });
            assert.equal(resOut.status, "resolved");

            // Invalid attestation on permanent skip must fail
            const badSkip = px.health(tmp, {
                action: "plan",
                subAction: "skip",
                patterns: [secondId],
                permanent: true,
                attest: "lazy skip",
            });
            assert.equal(badSkip.status, "attestation_invalid");

            // Valid attestation on permanent skip succeeds
            const skipOut = px.health(tmp, {
                action: "plan",
                subAction: "skip",
                patterns: [secondId],
                permanent: true,
                note: "Accepted legacy pattern",
                attest: "I have reviewed this skip and I am not gaming the score.",
            });
            assert.equal(skipOut.status, "wontfix");

            // `suppress` command with attestation validation
            const badSuppress = px.health(tmp, {
                action: "suppress",
                pattern: "*syncPayload*",
                attest: "missing keywords",
            });
            assert.equal(badSuppress.status, "attestation_invalid");

            const goodSuppress = px.health(tmp, {
                action: "suppress",
                pattern: "signature_variance::*::syncPayload",
                attest: "I have reviewed this intentional overload and I am not gaming the score.",
            });
            assert.equal(goodSuppress.status, "suppressed");
            assert.equal(goodSuppress.suppressed_ids.length, 1);

            // 7. 20-Dimension Blind Subjective Review (--prepare, Holistic Context, 2-phase judgment, strictGuard, and issue-penalized scores)
            const prep = px.health(tmp, { action: "review", prepare: true });
            assert.ok(prep.session_id.startsWith("rev_"));
            assert.equal(prep.batches.length, 5);
            const blindPacket = JSON.parse(readFileSync(prep.blind_packet_path, "utf8"));
            assert.equal(blindPacket.target_strict_score, undefined, "blind packet must not contain target score");
            assert.ok(blindPacket.holistic_context, "blind packet must include holistic_context");
            assert.ok(
                blindPacket.system_prompt.includes("Luau / Roblox review anchors"),
                "blind packet must include Luau/Roblox review overrides",
            );

            // Strict Import Guard: score < 85 without finding or rationale is rejected when strictGuard: true
            const guardBlocked = px.health(tmp, {
                action: "review",
                strictGuard: true,
                importPayload: {
                    session: blindPacket.session,
                    assessments: {
                        high_level_elegance: 72,
                    },
                    findings: [],
                },
            });
            assert.equal(guardBlocked.status, "error");
            assert.ok(guardBlocked.message.includes("Import guard"));

            // Anti-gaming check: all 100s with 0 findings should trigger reset
            const gamedImport = px.health(tmp, {
                action: "review",
                importPayload: {
                    session: blindPacket.session,
                    assessments: {
                        high_elegance: 100,
                        mid_elegance: 100,
                        low_elegance: 100,
                        contracts: 100,
                    },
                    findings: [],
                },
            });
            assert.equal(gamedImport.status, "target_anchored_reset");

            // Valid 2-phase evidence-backed import (using both short alias `contracts` and canonical `authorization_consistency`)
            const validImport = px.health(tmp, {
                action: "review",
                strictGuard: true,
                importPayload: {
                    session: blindPacket.session,
                    assessments: {
                        high_elegance: 88,
                        mid_elegance: 86,
                        low_elegance: 85,
                        contracts: 78,
                        type_safety: 86,
                        authorization_consistency: 75,
                    },
                    dimension_judgment: {
                        authorization_consistency: {
                            dimension_character: "Server remote handlers accept raw client args without validation.",
                            score_rationale: "CombatService OnServerEvent lacks typeof/NaN checks.",
                            strengths: ["Clear server/client folder separation"],
                        },
                    },
                    context_updates: {
                        high_level_elegance: {
                            add: [
                                {
                                    header: "Rojo Server/Client/Shared topology",
                                    description: "Codebase separates Server, Client, and Shared modules cleanly.",
                                    positive: true,
                                    settled: true,
                                },
                            ],
                        },
                    },
                    findings: [
                        {
                            dimension: "contracts",
                            identifier: "remote_contract",
                            summary: "Combat remote lacks schema contract validation",
                            related_files: ["src/Server/CombatService.server.luau"],
                            evidence: ["L4: OnServerEvent accepts raw targetId and damage"],
                            suggestion: "Validate typeof(targetId) == 'number' and damage bounds",
                            confidence: "high",
                        },
                    ],
                },
            });
            assert.equal(validImport.status, "imported");
            assert.equal(validImport.imported_dimensions, 6);
            assert.equal(validImport.imported_findings, 1);
            assert.equal(validImport.scores.has_subjective, true);
            assert.equal(validImport.review_coverage.status, "fresh");
            // Open review finding on `contracts` (`contract_coherence`) should penalize its strict score below its raw 78 assessment
            assert.ok(
                validImport.scores.subjective_dimensions.contract_coherence.score < 78,
                "open review finding must penalize strict dimension score until resolved",
            );
            // Short alias lookup (`subjective_dimensions.contracts`) also works
            assert.equal(
                validImport.scores.subjective_dimensions.contracts.assessment_score,
                78,
            );

            // 8. `tree` and `viz` HTML treemap
            const treeRes = px.health(tmp, { action: "tree", detail: true });
            assert.ok(treeRes.tree_text.includes("plexer health tree"));
            assert.ok(treeRes.tree_text.includes("CombatService.server.luau"));

            const vizRes = px.health(tmp, { action: "viz" });
            assert.ok(existsSync(vizRes.output_path), "treemap.html should be written to disk");
            const htmlText = readFileSync(vizRes.output_path, "utf8");
            assert.ok(htmlText.includes("plexer health treemap"));

            // 9. `plan reset`
            const resetRes = px.health(tmp, { action: "plan", subAction: "reset" });
            assert.equal(resetRes.status, "reset");
            assert.deepEqual(resetRes.plan.clusters, {});

            // 10. MCP tool `plexer_health` (`status`, `tree`, `detect`, `show`, and disallowed `autofix`)
            const mcpRes = await callTool(tmp, "plexer_health", { action: "status" });
            assert.equal(mcpRes.isError, false);
            assert.ok(mcpRes.text.includes("plexer health"));

            const mcpTree = await callTool(tmp, "plexer_health", { action: "tree" });
            assert.equal(mcpTree.isError, false);
            assert.ok(mcpTree.text.includes("plexer health tree"));

            const mcpShow = await callTool(tmp, "plexer_health", { action: "show" });
            assert.equal(mcpShow.isError, false);
            assert.ok(mcpShow.text.trim().length > 0 && mcpShow.text.includes("plexer health show"));

            const mcpBadAction = await callTool(tmp, "plexer_health", { action: "autofix" });
            assert.equal(mcpBadAction.isError, true);
            assert.ok(mcpBadAction.text.includes("invalid health action"));

            assert.throws(
                () => px.health(tmp, { action: "move", src: "src/Server/Util.luau", dst: "../outside", dryRun: true }),
                Error,
            );
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("detects sub-detectors (flat_dirs modes, private_imports, dict_keys, smells, security), marks stale dims/triage, and supports show/zone/exclude/config polish", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-parity-"));
        try {
            // Create a large parent dir (4 files) + thin_wrapper child dir (`utils` with 1 file) + sparse fragmentation child dirs (4 child dirs with 1 file each)
            mkdirSync(join(tmp, "src", "core_pkg", "utils"), { recursive: true });
            mkdirSync(join(tmp, "src", "core_pkg", "sub1"), { recursive: true });
            mkdirSync(join(tmp, "src", "core_pkg", "sub2"), { recursive: true });
            mkdirSync(join(tmp, "src", "core_pkg", "sub3"), { recursive: true });
            mkdirSync(join(tmp, "src", "consumer_pkg"), { recursive: true });

            for (let i = 1; i <= 4; i++) {
                writeFileSync(
                    join(tmp, "src", "core_pkg", `mod${i}.py`),
                    `def _internal_secret_${i}(x):\n    return x + ${i}\n\ndef public_fn_${i}(x):\n    return _internal_secret_${i}(x)\n`,
                    "utf8",
                );
            }
            writeFileSync(
                join(tmp, "src", "core_pkg", "utils", "helper.py"),
                "def _private_util(v):\n    return v * 2\n",
                "utf8",
            );
            writeFileSync(join(tmp, "src", "core_pkg", "sub1", "a.py"), "def f1():\n    return 1\n", "utf8");
            writeFileSync(join(tmp, "src", "core_pkg", "sub2", "b.py"), "def f2():\n    return 2\n", "utf8");
            writeFileSync(join(tmp, "src", "core_pkg", "sub3", "c.py"), "def f3():\n    return 3\n", "utf8");

            // Consumer package importing `_private_util` across packages + dict_keys schema drift + security traps + JS/TS smells + unreachable code
            writeFileSync(
                join(tmp, "src", "consumer_pkg", "client.py"),
                [
                    "import hashlib",
                    "from src.core_pkg.utils.helper import _private_util",
                    "",
                    "def run_client(user_input):",
                    "    digest = hashlib.md5(b'payload').hexdigest()",
                    "    cfg = {}",
                    "    cfg['timeout_ms'] = 500",
                    "    cfg['unused_key'] = 123",
                    "    val = cfg.get('timeot_ms')",
                    "    return _private_util(val or len(digest))",
                ].join("\n"),
                "utf8",
            );

            const fakePrefix = "gh" + "p_";
            const fakeAwsSecret = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY";
            writeFileSync(
                join(tmp, "src", "consumer_pkg", "web.ts"),
                [
                    "async function computeScores(scores: number[]) {",
                    "    const sorted = scores.sort();",
                    `    const apiToken = '${fakePrefix}1234567890abcdefghijklmnopqrstuvwxyzABCD';`,
                    `    const aws_secret_access_key = '${fakeAwsSecret}';`,
                    "    console.log('auth password:', apiToken, aws_secret_access_key);",
                    "    return sorted[0];",
                    "    const deadAfterReturn = 99;",
                    "}",
                ].join("\n"),
                "utf8",
            );

            const px = new Plexer();
            await px.graph(tmp);

            const scan1 = px.health(tmp, { action: "scan" });
            const allItems = scan1.queue.all_items;
            const byDetector = (d) => allItems.filter((i) => i.detector === d);

            // 1. flat_dirs fragmentation + thin_wrapper
            const flatDirFindings = byDetector("flat_dirs");
            assert.ok(
                flatDirFindings.some((i) => i.identifier === "thin_wrapper_dir"),
                "should detect thin_wrapper child directory",
            );
            assert.ok(
                flatDirFindings.some((i) => i.identifier === "fragmented_dir"),
                "should detect sparse child directory fragmentation",
            );

            // 2. private_imports across packages
            const privFindings = byDetector("private_imports");
            assert.ok(
                privFindings.some((i) => i.summary.includes("_private_util")),
                "should detect cross-module _private symbol import/call",
            );

            // 3. dict_keys schema drift & dead write
            const dictFindings = byDetector("dict_keys");
            assert.ok(
                dictFindings.some((i) => i.identifier.startsWith("drift:")),
                "should detect dict key schema drift (timeot_ms vs timeout_ms)",
            );
            assert.ok(
                dictFindings.some((i) => i.identifier.startsWith("dead_write:")),
                "should detect dead dict key write (unused_key)",
            );

            // 4. JS/TS smells (async without await, .sort() on numeric array, unreachable code)
            const trapFindings = byDetector("language_traps");
            assert.ok(
                trapFindings.some((i) => i.id.includes("async_no_await")),
                "should detect async function without await",
            );
            assert.ok(
                trapFindings.some((i) => i.id.includes("sort_no_comparator")),
                "should detect numeric .sort() without comparator",
            );
            assert.ok(
                trapFindings.some((i) => i.id.includes("unreachable_")),
                "should detect unreachable code after return",
            );

            // 5. Security traps (weak crypto hash, hardcoded token, sensitive log)
            const secFindings = byDetector("security_traps");
            assert.ok(
                secFindings.some((i) => i.id.includes("weak_crypto")),
                "should detect weak md5 hash",
            );
            assert.ok(
                secFindings.some((i) => i.id.includes("hardcoded_secret")),
                "should detect hardcoded ghp_ token",
            );
            assert.ok(
                secFindings.some((i) => i.id.includes("secret_var_aws_secret_access_key")),
                "should detect prefixed aws_secret_access_key assignment",
            );
            assert.ok(
                secFindings.some((i) => i.id.includes("sensitive_log")),
                "should detect sensitive credential in console.log",
            );

            // 6. Import subjective review, complete 7-stage triage, then introduce a new mechanical finding to trigger dimension & triage staleness
            const prep = px.health(tmp, { action: "review", prepare: true });
            const blindPacket = JSON.parse(readFileSync(prep.blind_packet_path, "utf8"));
            px.health(tmp, {
                action: "review",
                importPayload: {
                    session: blindPacket.session,
                    assessments: {
                        abstraction_fitness: 90,
                        error_consistency: 88,
                        ai_generated_debt: 92,
                    },
                    findings: [
                        {
                            dimension: "abstraction_fitness",
                            identifier: "wrapper_layer",
                            summary: "Thin utils wrapper adds indirection",
                            related_files: ["src/core_pkg/utils/helper.py"],
                            evidence: ["L1: single-file wrapper directory"],
                            suggestion: "Inline helper.py into src/core_pkg/",
                            confidence: "high",
                        },
                    ],
                },
            });

            // 7-stage triage
            for (const stg of ["strategize", "observe", "reflect", "organize", "enrich", "sense-check", "commit"]) {
                const tr = px.health(tmp, {
                    action: "plan",
                    subAction: "triage",
                    stage: stg,
                    report: `Completed ${stg} stage`,
                });
                assert.equal(tr.stage, stg);
            }
            const planAfterTriage = px.health(tmp, { action: "plan", subAction: "show" });
            assert.equal(planAfterTriage.plan.triage.completed, true);

            // Add a file with an empty catch block (triggers `silent_catches` -> marks `error_consistency` & `ai_generated_debt` stale)
            writeFileSync(
                join(tmp, "src", "consumer_pkg", "extra.py"),
                "def swallow():\n    try:\n        return 1\n    except Exception:\n        pass\n",
                "utf8",
            );
            await px.graph(tmp);
            const scan2 = px.health(tmp, { action: "scan" });
            assert.ok(
                scan2.diff.stale_dimensions.includes("error_consistency"),
                "new silent_catches finding should mark error_consistency stale",
            );
            assert.equal(scan2.review_coverage.status, "stale_dimensions");

            // 7. `show` special views (`show concerns`, `show <dimension>`, `--chronic`, `--code`)
            const showDim = px.health(tmp, { action: "show", patterns: ["abstraction_fitness"] });
            assert.equal(showDim.view, "dimension");
            assert.equal(showDim.dimension.id, "abstraction_fitness");

            const showConcerns = px.health(tmp, { action: "show", patterns: ["concerns"] });
            assert.equal(showConcerns.view, "concerns");
            assert.ok(Array.isArray(showConcerns.concerns));

            const showChronic = px.health(tmp, { action: "show", chronic: true, code: true });
            assert.ok(showChronic.count >= 1, "issues seen across 2 scans should appear in --chronic");
            assert.ok(
                showChronic.items[0].code_excerpt.includes("L"),
                "--code should populate numbered source excerpt",
            );

            // 8. `zone set` + `zone clear` live re-stamping, `config set`/`config unset`, and live `exclude` pruning
            const zoneSet = px.health(tmp, {
                action: "zone",
                subAction: "set",
                target: "src/consumer_pkg/extra.py",
                zone: "test",
            });
            assert.ok(zoneSet.restamped_issues >= 1);
            const zoneClear = px.health(tmp, {
                action: "zone",
                subAction: "clear",
                target: "src/consumer_pkg/extra.py",
            });
            assert.equal(zoneClear.overrides["src/consumer_pkg/extra.py"], undefined);

            px.health(tmp, { action: "config", subAction: "set", key: "custom_flag", value: "true" });
            const cfgUnset = px.health(tmp, { action: "config", subAction: "unset", key: "custom_flag" });
            assert.equal(cfgUnset.config.custom_flag, undefined);

            const exRes = px.health(tmp, { action: "exclude", target: "src/consumer_pkg/web.ts" });
            assert.ok(exRes.removed_count >= 1, "exclude should prune matching issues from live state");

            assert.equal(mintIssueId("det", "src/a.js", "fn"), "det::src/a.js::fn");
            assert.ok(healthDir(join(tmp, "plexer")).endsWith(".health"));
            assert.equal(emptyHealthConfig().target_strict_score, 98);
            assert.equal(classifyZone("Packages/Foo/init.luau"), "vendor");
            assert.equal(classifyZone("test/foo.test.js"), "test");
            assert.equal(classifyStemConvention("graph-checks.js"), "kebab-case");
            assert.equal(hasInlineSuppression(["// plexer-ignore: dead_symbols", "function f() {}"], 2, "dead_symbols"), true);
            const rules = loadIgnoreRules(tmp, ["dead:src/legacy"]);
            assert.equal(rules.isIgnored("src/legacy/a.js", "dead"), true);
            assert.equal(rules.isIgnored("src/legacy/a.js", "security"), false);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports all 6 Desloppify parity & graph-native tracks (suspect guard, history, scorecard+badge SVG, commit-log PR, graph autofixers, batch runner, layer_violation, reactive_smells, viz/blast overlays)", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-tracks-"));
        try {
            mkdirSync(join(tmp, "src", "util"), { recursive: true });
            mkdirSync(join(tmp, "src", "domain"), { recursive: true });
            mkdirSync(join(tmp, "src", "app"), { recursive: true });
            mkdirSync(join(tmp, "src", "Shared"), { recursive: true });
            mkdirSync(join(tmp, "src", "Server"), { recursive: true });

            // 1. Leaf util importing top-level app (layer_violation) + unreferenced export in domain/orphan.ts
            writeFileSync(
                join(tmp, "src", "util", "math.ts"),
                [
                    'import { renderApp, unusedHelper } from "../app/ui.ts";',
                    "",
                    "export function add(a: number, b: number): number {",
                    "    console.log('DEBUG math', renderApp());",
                    "    return a + b;",
                    "}",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "domain", "orphan.ts"),
                [
                    "export function unreferencedExportFn(x: number): number {",
                    "    return x * 10;",
                    "}",
                ].join("\n"),
                "utf8",
            );

            // 2. React hook inside conditional (reactive_smells) + 5 debug_logs to test suspect-drop guard
            writeFileSync(
                join(tmp, "src", "app", "ui.ts"),
                [
                    'import { add } from "../util/math.ts";',
                    "",
                    "export function renderApp(flag = true) {",
                    "    if (flag) { const [val] = useState(0); }",
                    "    console.log('DEBUG 1');",
                    "    console.log('DEBUG 2');",
                    "    console.log('DEBUG 3');",
                    "    console.log('DEBUG 4');",
                    "    console.log('DEBUG 5');",
                    "    return add(1, 2);",
                    "}",
                    "",
                    "export function unusedHelper() {",
                    "    return 0;",
                    "}",
                ].join("\n"),
                "utf8",
            );

            // 3. Roblox Shared importing Server (layer_violation) + Flux computed side effect (reactive_smells)
            writeFileSync(
                join(tmp, "src", "Server", "DataService.luau"),
                "--!strict\nlocal DataService = {}\nfunction DataService.save() return true end\nreturn DataService\n",
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Shared", "ReactiveStore.luau"),
                [
                    "--!strict",
                    "local DataService = require(script.Parent.Parent.Server.DataService)",
                    "local Flux = {}",
                    "local count = { set = function(self, v) end }",
                    "local derived = Flux.computed(function()",
                    "    count:set(10)",
                    "    return DataService.save()",
                    "end)",
                    "return derived",
                ].join("\n"),
                "utf8",
            );

            const px = new Plexer();
            const g1 = await px.graph(tmp);

            // Configure custom layer order as well (`src/util,src/domain,src/app`)
            px.health(tmp, {
                action: "config",
                subAction: "set",
                key: "layers",
                value: "src/util,src/domain,src/app",
            });

            // Scan #1: verify layer_violation, reactive_smells, scorecard.svg + badge.svg, and state.history
            const scan1 = px.health(tmp, { action: "scan" });
            const items1 = scan1.queue.all_items;
            const layerIssues = items1.filter((i) => i.detector === "layer_violation");
            assert.ok(
                layerIssues.some((i) => i.file === "src/util/math.ts"),
                "should detect upward layer violation from src/util/math.ts to src/app/ui.ts",
            );
            assert.ok(
                layerIssues.some((i) => i.file === "src/Shared/ReactiveStore.luau"),
                "should detect Roblox Shared -> Server layer violation",
            );

            const reactiveIssues = items1.filter((i) => i.detector === "reactive_smells");
            assert.ok(
                reactiveIssues.some((i) => i.file === "src/Shared/ReactiveStore.luau"),
                "should detect Flux computed side-effect in Luau",
            );
            assert.ok(
                reactiveIssues.some((i) => i.file === "src/app/ui.ts"),
                "should detect conditional React hook call",
            );

            // Track 2: verify both scorecard.svg (820x350 multi-panel) and badge.svg (210x28 pill) exist
            const hDir = join(tmp, "plexer", ".health");
            const scorecardSvg = readFileSync(join(hDir, "scorecard.svg"), "utf8");
            const badgeSvg = readFileSync(join(hDir, "badge.svg"), "utf8");
            assert.ok(scorecardSvg.includes("MECHANICAL DIMENSIONS (25%)"));
            assert.ok(scorecardSvg.includes("SUBJECTIVE DIMENSIONS (75%)"));
            assert.ok(badgeSvg.includes('width="210" height="28"'));

            // Track 4: Graph-backed autofixers (`unused-imports` named specifier pruning + opt-in `unreferenced-exports` + retro state reconciliation)
            px.health(tmp, { action: "autofix", fixer: "unused-imports", dryRun: false });
            const mathAfterUnused = readFileSync(join(tmp, "src", "util", "math.ts"), "utf8");
            assert.ok(
                mathAfterUnused.includes('import { renderApp } from "../app/ui.ts";'),
                `expected unusedHelper specifier to be pruned while keeping renderApp, got:\n${mathAfterUnused}`,
            );

            const unrefFix = px.health(tmp, {
                action: "autofix",
                fixer: "unreferenced-exports",
                dryRun: false,
            });
            assert.ok(unrefFix.total_edits >= 1, "should strip unreferenced export keyword");
            assert.ok(
                unrefFix.reconciled_issue_ids.some((id) => id.startsWith("unreferenced_exports::")),
                "should retro-reconcile unreferenced_exports issue in state.json",
            );
            const mathAfterUnref = readFileSync(join(tmp, "src", "util", "math.ts"), "utf8");
            const orphanAfterUnref = readFileSync(join(tmp, "src", "domain", "orphan.ts"), "utf8");
            assert.ok(
                orphanAfterUnref.includes("function unreferencedExportFn(") &&
                    !orphanAfterUnref.includes("export function unreferencedExportFn("),
                "export keyword should be stripped from unreferencedExportFn",
            );

            // Track 1: Suspect-disappearance guard (`debug_logs` had 6 findings; removing all 6 at once without autofix triggers suspect hold on scan #2)
            writeFileSync(
                join(tmp, "src", "util", "math.ts"),
                mathAfterUnref.replace("console.log('DEBUG math', renderApp());", "renderApp();"),
                "utf8",
            );
            const uiClean = readFileSync(join(tmp, "src", "app", "ui.ts"), "utf8")
                .split("\n")
                .filter((l) => !l.includes("DEBUG "))
                .join("\n");
            writeFileSync(join(tmp, "src", "app", "ui.ts"), uiClean, "utf8");
            await px.graph(tmp);

            const scan2 = px.health(tmp, { action: "scan" });
            assert.ok(
                scan2.diff.suspect_held_count >= 5,
                `expected >=5 debug_logs findings to be suspect-held when dropping to 0, got ${scan2.diff.suspect_held_count}`,
            );
            assert.ok(scan2.diff.suspect_detectors.includes("debug_logs"));

            // Passing `forceResolve: true` confirms the disappearance and auto-resolves them
            const scan3 = px.health(tmp, { action: "scan", forceResolve: true });
            assert.equal(scan3.diff.suspect_held_count, 0);
            assert.ok(scan3.diff.auto_resolved_count >= 5);

            // Track 3: Commit-log status, record, history, and PR Markdown
            const clStatus = px.health(tmp, {
                action: "plan",
                subAction: "commit-log",
                commitAction: "status",
            });
            assert.equal(clStatus.sub_action, "status");
            assert.ok(clStatus.uncommitted_count >= 1);

            const clRec = px.health(tmp, {
                action: "plan",
                subAction: "commit-log",
                commitAction: "record",
                sha: "abc1234",
                branch: "feat/health-cleanup",
                note: "Prune unused exports and imports",
            });
            assert.equal(clRec.recorded.commit, "abc1234");
            assert.equal(clRec.recorded.branch, "feat/health-cleanup");

            const clHist = px.health(tmp, {
                action: "plan",
                subAction: "commit-log",
                commitAction: "history",
            });
            assert.equal(clHist.total_commits, 1);
            assert.equal(clHist.records[0].sha, "abc1234");

            const clPr = px.health(tmp, {
                action: "plan",
                subAction: "commit-log",
                commitAction: "pr",
            });
            assert.ok(clPr.pr_markdown.includes("## `plexer health` Quality Report"));
            assert.ok(clPr.pr_markdown.includes("`abc1234`"));

            // Track 5: Scoped `review --prepare` (`--dimensions`, `--batches`) + automated `--run-batches` & `triage --run-stages`
            const scopedPrep = px.health(tmp, {
                action: "review",
                prepare: true,
                dimensions: "high_elegance,contracts",
            });
            assert.deepEqual(scopedPrep.selected_dimensions, [
                "high_level_elegance",
                "contract_coherence",
            ]);
            assert.equal(scopedPrep.batches.length, 2);

            const mockRunnerCmd = `node -e 'console.log(JSON.stringify({ assessments: { high_level_elegance: 91 }, findings: [] }))'`;
            const runBatchRes = await px.health(tmp, {
                action: "review",
                runBatches: true,
                batches: "1",
                dimensions: "high_level_elegance",
                runnerCmd: mockRunnerCmd,
            });
            assert.equal(runBatchRes.status, "imported");
            assert.equal(runBatchRes.batches_completed, 1);
            assert.equal(
                runBatchRes.scores.subjective_dimensions.high_level_elegance.score,
                91,
            );

            const mockTriageCmd = `node -e 'console.log(JSON.stringify({ observe: "Obs", reflect: "Ref", organize: "Org", strategy: "Strat" }))'`;
            const runTriageRes = await px.health(tmp, {
                action: "plan",
                subAction: "triage",
                runStages: true,
                runnerCmd: mockTriageCmd,
            });
            assert.equal(runTriageRes.action, "plan_triage_run_stages");
            assert.equal(runTriageRes.triage.completed, true);
            assert.equal(runTriageRes.triage.strategy, "Strat");

            // Verify longitudinal history recorded scan + autofix + review_import events
            const statusAfter = px.health(tmp, { action: "status" });
            assert.ok(statusAfter.history.length >= 4);
            assert.ok(statusAfter.history.some((h) => h.event === "review_import"));

            // Track 6: `plexer viz` `/api/health` payload & `plexer blast` `healthHotspots`
            const vizHealth = buildVizHealthPayload(join(tmp, "plexer"));
            assert.ok(vizHealth && vizHealth.open_count >= 1);
            assert.ok(vizHealth.by_file["src/Shared/ReactiveStore.luau"].count >= 2);

            const blastGraph = loadGraphCached(join(tmp, "plexer"));
            const blastRes = blastRadiusIn(
                blastGraph,
                join(tmp, "plexer"),
                [{ path: "src/util/math.ts", status: "modified", ranges: [{ start: 1, end: 10 }] }],
                "working tree",
                2,
            );
            assert.ok(Array.isArray(blastRes.healthHotspots) && blastRes.healthHotspots.length >= 1);
            const mdBlast = markdownReport(blastRes, { root: tmp });
            const txtBlast = textReport(blastRes);
            assert.ok(mdBlast.includes("Health hotspots on touched/impacted files"));
            assert.ok(txtBlast.includes("health hotspots"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports Pillar 2 & 3 health upgrades: score drag/impact, offline squarified treemap, rich plan/cluster steps, chronic/suspect guards, review personas/similarity/sha256, typeOnly cycles, layer rules, and temporal coupling", async () => {
        const { execFileSync } = await import("node:child_process");
        const { computeScoreSnapshot, computeScoreImpact } = await import("../src/health/scoring.js");
        const { reconcileIssues } = await import("../src/health/state.js");
        const { mergeReviewBatches } = await import("../src/health/review.js");
        const { detectCircularDeps } = await import("../src/health/graph-checks.js");

        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-pillar23-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: tmp });
            execFileSync("git", ["config", "user.name", "Dev"], { cwd: tmp });

            mkdirSync(join(tmp, "src", "client"), { recursive: true });
            mkdirSync(join(tmp, "src", "server"), { recursive: true });

            // Create 4 co-change commits between src/client/ui.ts and src/server/handler.ts without static edges
            for (let i = 1; i <= 4; i++) {
                writeFileSync(
                    join(tmp, "src", "client", "ui.ts"),
                    `export function renderUi(): number {\n  console.log("debug ui ${i}");\n  return ${i};\n}\n`,
                );
                writeFileSync(
                    join(tmp, "src", "server", "handler.ts"),
                    `export function runServer(): number {\n  console.log("debug srv ${i}");\n  return ${i * 10};\n}\n`,
                );
                execFileSync("git", ["add", "."], { cwd: tmp });
                execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `co-change ${i}`], { cwd: tmp });
            }

            // Add a type-only cycle between peerA.ts and peerB.ts (must NOT trigger circular_deps)
            // and a forbidden layer import from client/bridge.ts -> server/handler.ts
            writeFileSync(
                join(tmp, "src", "client", "peerA.ts"),
                'import type { PeerB } from "./peerB";\nexport interface PeerA { b?: PeerB; }\nexport function useA(): number { return 1; }\n',
            );
            writeFileSync(
                join(tmp, "src", "client", "peerB.ts"),
                'import type { PeerA } from "./peerA";\nexport interface PeerB { a?: PeerA; }\nexport function useB(): number { return 2; }\n',
            );
            writeFileSync(
                join(tmp, "src", "client", "bridge.ts"),
                'import { runServer } from "../server/handler";\nexport function callBridge(): number { return runServer(); }\n',
            );

            await buildGraph(tmp);
            const px = new Plexer();

            // Add a policy with inline `forbid:` layer boundary rule
            const polAdd = px.health(tmp, {
                action: "plan",
                subAction: "policy",
                policyAction: "add",
                rule: "forbid: src/client/** -> src/server/**",
            });
            assert.equal(polAdd.ok, true);
            assert.equal(polAdd.policies.length, 1);

            const scanRes = px.health(tmp, { action: "scan" });
            assert.ok(scanRes.queue.total_open >= 2);

            // Verify type-only cycle did NOT trigger circular_deps
            const loadedG = loadGraphCached(join(tmp, "plexer"));
            const cycRes = detectCircularDeps(loadedG, new Map());
            assert.equal(
                cycRes.some((iss) => iss.file.includes("peerA") || iss.file.includes("peerB")),
                false,
                "typeOnly imports must not trigger runtime circular_deps",
            );

            // Verify layer_violation and temporal_coupling fired
            const showAll = px.health(tmp, { action: "show", noBudget: true, max: "all" });
            assert.ok(
                showAll.items.some((iss) => iss.detector === "layer_violation" && iss.file === "src/client/bridge.ts"),
                "inline forbid policy must trigger layer_violation on src/client/bridge.ts",
            );
            assert.ok(
                showAll.items.some((iss) => iss.detector === "temporal_coupling"),
                "4 co-commits without static edge between ui.ts and handler.ts must trigger temporal_coupling",
            );

            // Score drag & computeScoreImpact
            assert.ok(
                typeof scanRes.scores.dimensions.code_quality.overall_drag === "number" &&
                    scanRes.scores.dimensions.code_quality.overall_drag > 0,
                "failing dimension must report positive overall_drag",
            );
            const stateDisk = JSON.parse(readFileSync(join(tmp, "plexer", ".health", "state.json"), "utf8"));
            const impact = computeScoreImpact(stateDisk, "layer_violation");
            assert.ok(impact.deltaStrict >= 0, "computeScoreImpact returns deltaStrict");

            // Next with --explain and --group
            const nextExplain = px.health(tmp, { action: "next", explain: true, count: 5 });
            assert.ok(nextExplain.queue.items.length >= 1);
            assert.ok(
                nextExplain.queue.items[0].explanation && nextExplain.queue.items[0].explanation.includes("Tier"),
                "next --explain attaches ranking rationale",
            );
            const nextGrouped = px.health(tmp, { action: "next", group: "detector", count: 5 });
            assert.equal(nextGrouped.queue.group_mode, "detector");
            assert.ok(Array.isArray(nextGrouped.queue.groups) && nextGrouped.queue.groups.length >= 1);

            // Plan describe, note, promote, backlog, reorder up/down
            const firstId = showAll.items[0].id;
            const descRes = px.health(tmp, {
                action: "plan",
                subAction: "describe",
                patterns: [firstId],
                text: "Custom architectural description",
            });
            assert.equal(descRes.updated_ids.length, 1);

            const noteRes = px.health(tmp, {
                action: "plan",
                subAction: "note",
                patterns: [firstId],
                text: "Track root cause in bridge",
            });
            assert.equal(noteRes.updated_ids.length, 1);

            const promRes = px.health(tmp, {
                action: "plan",
                subAction: "promote",
                patterns: [firstId],
                position: "top",
            });
            assert.ok(promRes.promoted_ids.includes(firstId));

            const backRes = px.health(tmp, {
                action: "plan",
                subAction: "backlog",
                patterns: [firstId],
            });
            assert.ok(backRes.demoted_ids.includes(firstId));

            // Skip with --review-after 1 -> resurfaces on next scan, and reopen twice -> chronic
            px.health(tmp, {
                action: "plan",
                subAction: "skip",
                patterns: [firstId],
                reviewAfter: 1,
                confirm: true,
            });
            // Rescan triggers resurface_after_scan and increments reopen_count
            px.health(tmp, { action: "scan" });
            px.health(tmp, { action: "plan", subAction: "skip", patterns: [firstId], confirm: true });
            px.health(tmp, { action: "plan", subAction: "reopen", patterns: [firstId] });
            const chronicShow = px.health(tmp, { action: "show", chronic: true });
            assert.ok(
                chronicShow.items.some((iss) => iss.id === firstId && iss.reopen_count >= 2),
                "show --chronic surfaces issue reopened >= 2 times",
            );

            // Structured cluster steps, export YAML, import, and merge
            px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "create",
                clusterName: "arch-cleanup",
                patterns: [firstId],
                addStep: "Decouple client bridge",
                detail: "Move RPC call behind typed transport",
                effort: "medium",
            });
            const stepDone = px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "update",
                clusterName: "arch-cleanup",
                doneStep: 1,
            });
            assert.equal(stepDone.cluster.steps[0].done, true);

            const expYaml = px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "export",
                clusterName: "arch-cleanup",
                format: "yaml",
            });
            assert.ok(expYaml.exported.includes("Decouple client bridge"));

            // Suspect detector zero-drop protection in reconcileIssues
            const mockState = {
                scan_count: 5,
                issues: {
                    "detA::f1::r": { id: "detA::f1::r", detector: "detA", status: "open", file: "f1.ts" },
                    "detA::f2::r": { id: "detA::f2::r", detector: "detA", status: "open", file: "f2.ts" },
                    "detA::f3::r": { id: "detA::f3::r", detector: "detA", status: "open", file: "f3.ts" },
                },
                suppressions: [],
            };
            const recGuard = reconcileIssues(mockState, [], null, { isScopedScan: false, forceResolve: false });
            assert.ok(recGuard.suspectDetectors.includes("detA"), "3->0 drop without forceResolve flags suspect detector");
            assert.equal(mockState.issues["detA::f1::r"].status, "open", "suspect detector issues remain open");

            // Repair state from plan
            const repairRes = px.health(tmp, { action: "plan", subAction: "repair-state" });
            assert.equal(repairRes.ok, true);

            // Offline squarified treemap HTML check (zero external HTTP scripts)
            const vizOut = px.health(tmp, { action: "viz" });
            const treemapHtml = readFileSync(vizOut.output_path, "utf8");
            assert.ok(treemapHtml.includes("function squarify"), "treemap embeds offline squarify algorithm");
            assert.ok(treemapHtml.includes('data-mode="churn"'), "treemap includes churn color mode");
            assert.equal(/<script[^>]+src=["']https?:/i.test(treemapHtml), false, "treemap must have zero external CDN scripts");

            // Review personas, retrospective, packet_sha256, and similarity deduplication
            const prepRev = px.health(tmp, { action: "review", prepare: true });
            assert.ok(prepRev.packet_sha256 && prepRev.packet_sha256.length === 64, "query records packet_sha256");
            assert.ok(prepRev.batches[0].persona && prepRev.batches[0].persona.id, "batches rotate reviewer personas");
            const blindJson = JSON.parse(readFileSync(prepRev.blind_packet_path, "utf8"));
            assert.ok(blindJson.retrospective, "blind packet includes retrospective context");

            const batchDir = join(tmp, "batches-merge");
            mkdirSync(batchDir, { recursive: true });
            writeFileSync(
                join(batchDir, "batch-1.raw.txt"),
                JSON.stringify({
                    assessments: { high_level_elegance: 85 },
                    findings: [
                        {
                            dimension: "high_level_elegance",
                            identifier: "f1",
                            summary: "Client bridge directly calls server handler module violating layer boundary",
                            suggestion: "Extract a shared contract interface and invoke via transport adapter",
                            related_files: ["src/client/bridge.ts"],
                        },
                    ],
                }),
            );
            writeFileSync(
                join(batchDir, "batch-2.raw.txt"),
                JSON.stringify({
                    assessments: { high_level_elegance: 83 },
                    findings: [
                        {
                            dimension: "high_level_elegance",
                            identifier: "f2",
                            summary: "Client bridge directly calls server handler module violating layer boundary rules",
                            suggestion: "Extract a shared contract interface and invoke via transport adapter layer",
                            related_files: ["src/client/bridge.ts", "src/server/handler.ts"],
                        },
                    ],
                }),
            );
            const merged = mergeReviewBatches(batchDir, { similarity: 0.7 });
            assert.equal(merged.findings.length, 1, "near-duplicate findings across batches must be merged via similarity");
            assert.equal(merged.findings[0].related_files.length, 2, "merged finding unions related_files");

            // Regression checks: Luau top-level GetService after helper function & security_traps eslint-disable non-suppression
            mkdirSync(join(tmp, "src", "LuauFix"), { recursive: true });
            const luauFixPath = join(tmp, "src", "LuauFix", "ServiceAfterFn.luau");
            const luauOriginal = [
                "local function helper()",
                "    return 1",
                "end",
                "local Players = game:GetService(\"Players\")",
                "return helper",
                "",
            ].join("\n");
            writeFileSync(luauFixPath, luauOriginal, "utf8");
            px.health(tmp, { action: "autofix", fixer: "luau-hoist-getservice", dryRun: false });
            const luauAfter = readFileSync(luauFixPath, "utf8");
            assert.ok(
                luauAfter.includes('local Players = game:GetService("Players")'),
                "runAutofix must not delete top-level game:GetService placed after a local function in .luau",
            );

            assert.equal(
                hasInlineSuppression(["// eslint-disable-next-line", "eval(userInput);"], 2, "security_traps"),
                false,
                "generic eslint-disable-next-line must not suppress security_traps",
            );
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
