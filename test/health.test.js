import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Plexer, buildGraph } from "../src/index.js";
import { blastRadiusIn } from "../src/blast/blast.js";
import { markdownReport, textReport } from "../src/blast/render.js";
import { loadGraphCached } from "../src/context/graph-store.js";
import { callTool } from "../src/mcp/tools.js";
import { classifyStemConvention } from "../src/health/concerns.js";
import { SUBJECTIVE_DIMENSIONS } from "../src/health/constants.js";
import { computeCognitiveComplexity } from "../src/health/graph-checks.js";
import { computeScoreSnapshot } from "../src/health/scoring.js";
import { managePlanCluster } from "../src/health/queue.js";
import { formatHealthText } from "../src/health/render.js";
import { emptyHealthConfig, healthDir, mintIssueId } from "../src/health/state.js";
import { classifyZone, hasInlineSuppression, loadIgnoreRules, stripCodeStringsAndComments } from "../src/health/zones.js";
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

            // 4. Expanded Autofixers (`luau-task-scheduler`, `luau-instance-new-parent`, `debug-logs`, `unused-imports`, explicit `luau-hoist-getservice`)
            const fixDry = px.health(tmp, { action: "autofix", fixer: "all", dryRun: true });
            assert.ok(fixDry.total_edits >= 3);
            const fixApply = px.health(tmp, { action: "autofix", fixer: "all", dryRun: false });
            assert.equal(fixApply.files_changed, 1);
            px.health(tmp, { action: "autofix", fixer: "unused-imports", dryRun: false });

            const beforeExplicitHoist = readFileSync(
                join(tmp, "src", "Server", "CombatService.server.luau"),
                "utf8",
            );
            assert.ok(
                !beforeExplicitHoist.startsWith('local Players = game:GetService("Players")'),
                "autofix all must not implicitly hoist GetService",
            );

            px.health(tmp, { action: "autofix", fixer: "luau-hoist-getservice", dryRun: false });
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
                "explicit luau-hoist-getservice should hoist game:GetService('Players') to module top",
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

    it("enforces fail-closed anti-gaming, ghost detectors (package_census, enum_bypasses), cognitive complexity, hotspots, deceptive_queries, clone clustering/drift, parallel work lanes, reminder decay, and MCP parity", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-antigaming-"));
        try {
            mkdirSync(join(tmp, "src", "core"), { recursive: true });
            mkdirSync(join(tmp, "src", "consumers"), { recursive: true });
            mkdirSync(join(tmp, "src", "barrel"), { recursive: true });
            mkdirSync(join(tmp, "src", "clones"), { recursive: true });

            // 1. Barrel bloat (`package_census` barrel_bloat: >= 4 re-exports and 0 local functions)
            writeFileSync(
                join(tmp, "src", "barrel", "index.ts"),
                [
                    'export * from "../core/state_a.ts";',
                    'export * from "../core/state_b.ts";',
                    'export * from "../core/state_c.ts";',
                    'export * from "../consumers/runner.ts";',
                ].join("\n"),
                "utf8",
            );

            // 2. Core engine with:
            //    - High cognitive complexity function (< 100 LOC, cognitive >= 25) -> `monster_functions`
            //    - Deceptive query (`getUserAccount` calling `saveAuditRecord` and `localStorage.setItem`) -> `deceptive_queries`
            //    - Unreferenced export alongside a referenced export -> symbol-level `unreferenced_exports`
            //    - Dead symbol `unusedAlpha` where `unusedAlphaBeta` is called -> word-boundary `dead_symbols`
            //    - Multi-line return expression -> must NOT trigger `unreachable_code`
            writeFileSync(
                join(tmp, "src", "core", "engine.ts"),
                [
                    "export function saveAuditRecord(payload: string): void {",
                    "    localStorage.setItem('audit', payload);",
                    "}",
                    "",
                    "export function getUserAccount(id: string): string {",
                    "    saveAuditRecord(id);",
                    "    localStorage.setItem('last_user', id);",
                    "    return id",
                    "        + ':ok';",
                    "}",
                    "",
                    "export function neverImportedSiblingExport(x: number): number {",
                    "    return x * 2;",
                    "}",
                    "",
                    "function unusedAlpha(): number {",
                    "    return 1;",
                    "}",
                    "",
                    "function unusedAlphaBeta(): number {",
                    "    return 2;",
                    "}",
                    "",
                    "export function deeplyNestedBrain(a: number, b: number, c: number, d: number): number {",
                    "    let total = unusedAlphaBeta();",
                    "    if (a > 0 && b > 0 || c > 0) {",
                    "        for (let i = 0; i < a; i++) {",
                    "            if (b > i && c > i) {",
                    "                while (d > 0) {",
                    "                    if (a === b || c === d) {",
                    "                        if (total > 10) {",
                    "                            total += 1;",
                    "                        } else if (total > 5) {",
                    "                            total += 2;",
                    "                        } else {",
                    "                            total += 3;",
                    "                        }",
                    "                    }",
                    "                    d--;",
                    "                }",
                    "            }",
                    "        }",
                    "    }",
                    "    return total;",
                    "}",
                ].join("\n"),
                "utf8",
            );

            // 3. `enum_bypasses`: scattered string-enum comparisons across >= 3 files (`order.status === "..."`)
            writeFileSync(
                join(tmp, "src", "core", "state_a.ts"),
                [
                    'import { getUserAccount, deeplyNestedBrain } from "./engine.ts";',
                    "export function handleStateA(order: { status: string }): number {",
                    '    if (order.status === "PENDING_APPROVAL") return deeplyNestedBrain(1, 2, 3, 4);',
                    '    if (order.status === "REJECTED_FINAL") return 0;',
                    '    return getUserAccount("a").length;',
                    "}",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "core", "state_b.ts"),
                [
                    'import { deeplyNestedBrain } from "./engine.ts";',
                    "export function handleStateB(order: { status: string }): number {",
                    '    if (order.status === "PENDING_APPROVAL") return deeplyNestedBrain(2, 3, 4, 5);',
                    '    if (order.status === "APPROVED_SETTLED") return 1;',
                    "    return 0;",
                    "}",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "core", "state_c.ts"),
                [
                    'import { deeplyNestedBrain } from "./engine.ts";',
                    "export function handleStateC(order: { status: string }): number {",
                    '    if (order.status === "REJECTED_FINAL") return deeplyNestedBrain(3, 4, 5, 6);',
                    '    if (order.status === "APPROVED_SETTLED") return 2;',
                    "    return 0;",
                    "}",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "consumers", "runner.ts"),
                [
                    'import { deeplyNestedBrain } from "../core/engine.ts";',
                    "export function runAll(): number {",
                    "    return deeplyNestedBrain(1, 1, 1, 1);",
                    "}",
                ].join("\n"),
                "utf8",
            );

            // 4. 3 near-duplicate functions across files (`duplicates` connected-component clustering + `clone_drift`)
            const makeCloneSource = (fnName, offset) =>
                [
                    `export function ${fnName}(items: number[]): number {`,
                    "    let acc = 0;",
                    "    for (let i = 0; i < items.length; i++) {",
                    "        const val = items[i] * 3;",
                    "        if (val > 10) {",
                    `            acc += val + ${offset};`,
                    "        } else {",
                    "            acc -= val;",
                    "        }",
                    "    }",
                    "    return acc;",
                    "}",
                ].join("\n");
            writeFileSync(join(tmp, "src", "clones", "clone1.ts"), makeCloneSource("calcAlpha", 1), "utf8");
            writeFileSync(join(tmp, "src", "clones", "clone2.ts"), makeCloneSource("calcBeta", 1), "utf8");
            writeFileSync(join(tmp, "src", "clones", "clone3.ts"), makeCloneSource("calcGamma", 1), "utf8");

            // Initialize git repo and create 4 commits touching `src/core/engine.ts` + co-changing `clone1.ts` & `clone2.ts`
            execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
            execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp, stdio: "pipe" });
            execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp, stdio: "pipe" });
            execFileSync("git", ["add", "."], { cwd: tmp, stdio: "pipe" });
            execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: tmp, stdio: "pipe" });

            for (let c = 1; c <= 3; c++) {
                writeFileSync(
                    join(tmp, "src", "clones", "clone1.ts"),
                    `${makeCloneSource("calcAlpha", c)}\n// rev ${c}\n`,
                    "utf8",
                );
                writeFileSync(
                    join(tmp, "src", "clones", "clone2.ts"),
                    `${makeCloneSource("calcBeta", c)}\n// rev ${c}\n`,
                    "utf8",
                );
                execFileSync("git", ["add", "."], { cwd: tmp, stdio: "pipe" });
                execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", `clone co-change ${c}`], { cwd: tmp, stdio: "pipe" });
            }
            for (let c = 1; c <= 4; c++) {
                const engTxt = readFileSync(join(tmp, "src", "core", "engine.ts"), "utf8");
                writeFileSync(join(tmp, "src", "core", "engine.ts"), `${engTxt}\n// churn ${c}`, "utf8");
                execFileSync("git", ["add", "."], { cwd: tmp, stdio: "pipe" });
                execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", `engine churn ${c}`], { cwd: tmp, stdio: "pipe" });
            }

            const px = new Plexer();
            await px.graph(tmp);

            const scan1 = px.health(tmp, { action: "scan" });
            assert.equal(scan1.diff.noop, false);
            const allItems = scan1.queue.all_items;
            const byDetector = new Set(allItems.map((i) => i.detector));

            // Verify ghost detectors + new graph/evolutionary detectors fired
            assert.ok(byDetector.has("package_census"), "package_census should detect barrel_bloat");
            assert.ok(byDetector.has("enum_bypasses"), "enum_bypasses should detect scattered order.status string comparisons");
            assert.ok(byDetector.has("monster_functions"), "monster_functions should detect cognitive complexity >= 25");
            assert.ok(byDetector.has("hotspots"), "hotspots should detect high-churn high-complexity deeplyNestedBrain");
            assert.ok(byDetector.has("deceptive_queries"), "deceptive_queries should detect getUserAccount calling saveAuditRecord/setItem");

            // Verify symbol-level unreferenced_exports (`neverImportedSiblingExport` flagged even though `getUserAccount` in same file is imported)
            assert.ok(
                allItems.some((i) => i.detector === "unreferenced_exports" && i.identifier === "neverImportedSiblingExport"),
                "symbol-level unreferenced_exports should flag neverImportedSiblingExport",
            );
            // Verify word-boundary dead_symbols (`unusedAlpha` flagged even though `unusedAlphaBeta` is called)
            assert.ok(
                allItems.some((i) => i.detector === "dead_symbols" && i.identifier === "unusedAlpha"),
                "word-boundary dead_symbols should flag unusedAlpha",
            );
            // Verify multi-line return expression in `getUserAccount` did NOT trigger `unreachable_code`
            assert.ok(
                !allItems.some((i) => i.detector === "unreachable_code" && i.file === "src/core/engine.ts"),
                "multi-line return expression must not false-positive as unreachable_code",
            );
            // Verify 3 near-duplicate clones collapsed into 1 connected-component cluster with `clone_drift` escalation
            const nearDupIssues = allItems.filter(
                (i) => i.detector === "duplicates" && i.file.startsWith("src/clones/"),
            );
            assert.equal(nearDupIssues.length, 1, "3 near-duplicate clones should form 1 connected-component cluster issue");
            assert.ok(nearDupIssues[0].clone_drift, "co-changing clones should include clone_drift metadata");
            assert.equal(nearDupIssues[0].tier, "T2", "clone_drift should escalate near-duplicate cluster to T2");

            // Verify JSON payload deduplication (non-enumerable `findings` & `queue.all_items`)
            const serializedScan = JSON.parse(JSON.stringify(scan1));
            assert.equal(serializedScan.findings, undefined, "scan.findings should be non-enumerable in JSON output");
            assert.equal(serializedScan.queue.all_items, undefined, "queue.all_items should be non-enumerable in JSON output");
            assert.ok(Array.isArray(scan1.findings), "scan.findings remains accessible as a JS property");

            // Verify idempotent back-to-back scan (`diff.noop === true`)
            const scanNoop = px.health(tmp, { action: "scan" });
            assert.equal(scanNoop.diff.noop, true, "unchanged back-to-back scan should be a fast no-op");
            assert.equal(scanNoop.diff.scan_count, 1, "noop scan must not increment scan_count");

            // Verify `next --lanes` parallel subagent work lanes & compact text rendering
            const nextLanes = px.health(tmp, { action: "next", count: 5, lanes: true });
            assert.ok(nextLanes.work_lanes, "next --lanes should return work_lanes");
            assert.ok(nextLanes.work_lanes.lane_count >= 2, "disjoint files (barrel/clones vs core) should form >= 2 lanes");
            assert.ok(
                nextLanes.work_lanes.independent_lanes[0].subagent_hint.includes("worker"),
                "lanes should include subagent worker dispatch hint",
            );
            const compactNextText = formatHealthText(nextLanes);
            assert.ok(
                !compactNextText.includes("Mechanical dimensions (25% weight):"),
                "compact next text should omit full dimension tables unless --verbose",
            );
            assert.ok(
                compactNextText.includes("Parallel workstream lanes"),
                "next --lanes text should render parallel workstream lanes",
            );

            // Verify `parallel_lanes_available` is emitted initially and decays after 3 displays
            assert.ok(
                nextLanes.reminders.some((r) => r.type === "parallel_lanes_available"),
                "parallel_lanes_available reminder should be emitted when >= 2 disjoint lanes exist",
            );
            px.health(tmp, { action: "next" });
            px.health(tmp, { action: "next" });
            const nextAfterDecay = px.health(tmp, { action: "next" });
            assert.ok(
                !nextAfterDecay.reminders.some((r) => r.type === "parallel_lanes_available"),
                "medium-priority reminders should decay after 3 displays",
            );

            // Verify fail-closed anti-gaming:
            // (a) Mechanical resolve stays `verified: false` and does NOT inflate `strict` or `verified`
            const strictBeforeResolve = scan1.scores.strict;
            const firstMechIssue = allItems[0];
            const res1 = px.health(tmp, {
                action: "resolve",
                patterns: [firstMechIssue.id],
                confirm: true,
                note: "claimed fix without editing file",
            });
            assert.equal(res1.status, "resolved");
            assert.equal(
                res1.scores.strict,
                strictBeforeResolve,
                "unverified mechanical resolve must NOT increase strict score before rescan",
            );
            assert.equal(
                res1.scores.verified,
                strictBeforeResolve,
                "unverified mechanical resolve must NOT increase verified score before rescan",
            );

            // (b) Pre-loop 10-resolve scan gate blocks wildcard `resolve "*"` when matched count exceeds limit
            const gateBlocked = px.health(tmp, {
                action: "resolve",
                patterns: ["*"],
                confirm: true,
            });
            assert.equal(gateBlocked.status, "scan_gate_blocked", "wildcard resolve exceeding 10 issues must be blocked pre-loop");

            // (c) `false_positive` requires valid `--attest` or `--reason` and is exempt from `strict` penalty
            const fpRejected = px.health(tmp, {
                action: "plan",
                subAction: "skip",
                falsePositive: true,
                patterns: [allItems[1].id],
                confirm: true,
            });
            assert.equal(fpRejected.status, "attestation_invalid", "false_positive without --attest or --reason must be rejected");

            const fpAccepted = px.health(tmp, {
                action: "plan",
                subAction: "skip",
                falsePositive: true,
                patterns: [allItems[1].id],
                confirm: true,
                attest: "I have actually verified this is a false positive and I am not gaming the score.",
            });
            assert.equal(fpAccepted.status, "false_positive");
            assert.equal(fpAccepted.scores.false_positive_count, 1);
            assert.ok(
                fpAccepted.scores.strict > strictBeforeResolve,
                `attested false_positive should be exempt from strict penalty (${fpAccepted.scores.strict} > ${strictBeforeResolve})`,
            );

            // (d) Inline suppression transitions an existing open issue to `wontfix` + `suppressed: true` (not `fixed`)
            //     and populates `scores.ignore_integrity`
            const barrelTxt = readFileSync(join(tmp, "src", "barrel", "index.ts"), "utf8");
            writeFileSync(
                join(tmp, "src", "barrel", "index.ts"),
                `// plexer-ignore-file: package_census\n${barrelTxt}`,
                "utf8",
            );
            await px.graph(tmp);
            const scanAfterIgnore = px.health(tmp, { action: "scan" });
            assert.ok(
                scanAfterIgnore.scores.ignore_integrity.ignored_count >= 1,
                "ignore_integrity should record inline suppression",
            );
            const barrelShow = px.health(tmp, {
                action: "show",
                patterns: ["package_census::src/barrel/index.ts::barrel_bloat"],
                status: "wontfix",
            });
            assert.equal(
                barrelShow.count,
                1,
                "open issue hidden by newly added inline ignore must become wontfix (suppressed), not fixed",
            );
            assert.equal(barrelShow.items[0].suppressed, true);

            // (e) Subjective coverage scaling, single-use session token, and `target_anchored_reset`
            const prep = px.health(tmp, { action: "review", prepare: true });
            const blindPkt = JSON.parse(readFileSync(prep.blind_packet_path, "utf8"));
            const partialImportPath = join(tmp, "partial-review.json");
            writeFileSync(
                partialImportPath,
                JSON.stringify({
                    session: blindPkt.session,
                    assessments: { high_level_elegance: 92 },
                    findings: [],
                }),
                "utf8",
            );
            const impOk = px.health(tmp, {
                action: "review",
                importFile: partialImportPath,
                attestedExternal: true,
                attest: prep.attest_example,
            });
            assert.equal(impOk.status, "imported");
            // Re-using the same session token after a successful import must be rejected
            const impReplay = px.health(tmp, {
                action: "review",
                importFile: partialImportPath,
                attestedExternal: true,
                attest: prep.attest_example,
            });
            assert.equal(impReplay.status, "error", "replaying a consumed blind review session must fail");

            // Prepare a second session and trigger `target_anchored_reset` (all dimensions = 98.0 target)
            const prep2 = px.health(tmp, { action: "review", prepare: true });
            const blindPkt2 = JSON.parse(readFileSync(prep2.blind_packet_path, "utf8"));
            const anchoredPath = join(tmp, "anchored-review.json");
            writeFileSync(
                anchoredPath,
                JSON.stringify({
                    session: blindPkt2.session,
                    assessments: { high_level_elegance: 98, mid_level_elegance: 98 },
                    findings: [],
                }),
                "utf8",
            );
            const impAnchored = px.health(tmp, {
                action: "review",
                importFile: anchoredPath,
                attestedExternal: true,
                attest: prep2.attest_example,
            });
            assert.equal(impAnchored.status, "target_anchored_reset");
            const statusAfterAnchor = px.health(tmp, { action: "status" });
            assert.ok(
                statusAfterAnchor.scores.strict < statusAfterAnchor.scores.objective,
                "target_anchored_reset must zero targeted dimensions rather than reverting strict to 100% objective",
            );

            // (f) `buildVizHealthPayload` ranks T1 more urgent than T4 in `max_tier`
            const vizPayload = buildVizHealthPayload(join(tmp, "plexer"));
            assert.ok(vizPayload && vizPayload.by_file["src/core/engine.ts"]);
            assert.notEqual(vizPayload.by_file["src/core/engine.ts"].max_tier, "T4");

            // (g) MCP `plexer_health` default action ("status"), `next` with `lanes: true`, `skip`, and `reopen`
            const mcpDefault = await callTool(tmp, "plexer_health", {});
            assert.equal(mcpDefault.isError, false);
            assert.ok(mcpDefault.text.includes("scores: strict"), "default MCP plexer_health action should return status");

            const mcpLanes = await callTool(tmp, "plexer_health", { action: "next", lanes: true });
            assert.equal(mcpLanes.isError, false);
            assert.ok(mcpLanes.text.includes("Parallel workstream lanes"));

            const mcpSkip = await callTool(tmp, "plexer_health", {
                action: "skip",
                patterns: [allItems[2].id],
                note: "defer via MCP",
            });
            assert.equal(mcpSkip.isError, false);
            assert.ok(mcpSkip.text.includes("deferred"));

            const mcpReopen = await callTool(tmp, "plexer_health", {
                action: "reopen",
                patterns: [allItems[2].id],
            });
            assert.equal(mcpReopen.isError, false);
            assert.ok(mcpReopen.text.includes("Reopened"));

            // Direct unit check on computeCognitiveComplexity
            assert.ok(
                computeCognitiveComplexity(
                    readFileSync(join(tmp, "src", "core", "engine.ts"), "utf8").split(/\r?\n/).slice(23),
                    ".ts",
                    "deeplyNestedBrain",
                ) >= 25,
            );

            // (h) Scoped `scan --detector` preserves out-of-scope open issues in state.json
            const openBeforeScoped = px.health(tmp, { action: "status" }).scores.open_count;
            px.health(tmp, { action: "scan", detector: "enum_bypasses" });
            const openAfterScoped = px.health(tmp, { action: "status" }).scores.open_count;
            assert.equal(
                openAfterScoped,
                openBeforeScoped,
                "scoped scan --detector must not auto-resolve or wipe out-of-scope detectors in state.json",
            );

            // (i) Scoped `target_anchored_reset` preserves pre-existing valid subjective dimensions,
            //     and `scores.verified` penalizes unverified resolved review findings
            const prep3 = px.health(tmp, { action: "review", prepare: true });
            const blindPkt3 = JSON.parse(readFileSync(prep3.blind_packet_path, "utf8"));
            const validReviewPath = join(tmp, "valid-review.json");
            writeFileSync(
                validReviewPath,
                JSON.stringify({
                    session: blindPkt3.session,
                    assessments: {
                        high_level_elegance: 82,
                        mid_level_elegance: 88,
                    },
                    dimension_judgment: {
                        high_level_elegance: {
                            dimension_character: "Core engine and billing modules have some coupling.",
                            score_rationale: "Scored 82 due to boundary friction in engine.ts.",
                            strengths: ["Clear directory layout"],
                        },
                        mid_level_elegance: {
                            dimension_character: "Handoffs are mostly clean.",
                            score_rationale: "Scored 88 with minor seam glue.",
                            strengths: ["Typed interfaces"],
                        },
                    },
                    findings: [
                        {
                            dimension: "high_level_elegance",
                            identifier: "engine_seam",
                            summary: "Engine mixes billing orchestration with state transitions",
                            related_files: ["src/core/engine.ts"],
                            evidence: ["src/core/engine.ts:L1-L25"],
                            suggestion: "Extract billing seam into a dedicated collaborator",
                            confidence: "high",
                        },
                    ],
                }),
                "utf8",
            );
            const impValid = px.health(tmp, {
                action: "review",
                importFile: validReviewPath,
                attestedExternal: true,
                attest: prep3.attest_example,
            });
            assert.equal(impValid.status, "imported");

            // Resolve the subjective review finding without --force (verified: false)
            const revItems = px.health(tmp, { action: "show", patterns: ["review::*"], status: "open" }).items;
            assert.equal(revItems.length, 1);
            const revResolved = px.health(tmp, {
                action: "resolve",
                patterns: [revItems[0].id],
                confirm: true,
                note: "extracted billing collaborator",
            });
            assert.equal(revResolved.status, "resolved");
            assert.ok(
                revResolved.scores.verified < revResolved.scores.strict,
                "unverified resolved review finding must still penalize scores.verified while crediting scores.strict",
            );

            // Now trigger target_anchored_reset on only `low_level_elegance` and verify `mid_level_elegance` (88) is preserved
            const prep4 = px.health(tmp, { action: "review", prepare: true });
            const blindPkt4 = JSON.parse(readFileSync(prep4.blind_packet_path, "utf8"));
            const scopedAnchoredPath = join(tmp, "scoped-anchored.json");
            writeFileSync(
                scopedAnchoredPath,
                JSON.stringify({
                    session: blindPkt4.session,
                    assessments: { low_level_elegance: 98, logic_clarity: 98 },
                    findings: [],
                }),
                "utf8",
            );
            const impScopedAnchored = px.health(tmp, {
                action: "review",
                importFile: scopedAnchoredPath,
                attestedExternal: true,
                attest: prep4.attest_example,
            });
            assert.equal(impScopedAnchored.status, "target_anchored_reset");
            const stAfterScopedAnchor = px.health(tmp, { action: "status" });
            assert.equal(
                stAfterScopedAnchor.scores.subjective_dimensions.mid_level_elegance.score,
                88,
                "scoped target_anchored_reset must preserve previously valid assessments for other dimensions",
            );
            assert.equal(
                stAfterScopedAnchor.scores.subjective_dimensions.low_level_elegance.score,
                0,
                "scoped target_anchored_reset must zero the anchored dimensions in the payload",
            );

            // (j) `plan backlog` demotes an issue from `next` while keeping it in `backlog`,
            //     and `plan cluster move` supports both `--to` and positional cluster names
            const nextBeforeBacklog = px.health(tmp, { action: "next", max: "all" });
            const targetDemoteId = nextBeforeBacklog.queue.items[0].id;
            px.health(tmp, {
                action: "plan",
                subAction: "backlog",
                patterns: [targetDemoteId],
            });
            const nextAfterBacklog = px.health(tmp, { action: "next", max: "all" });
            assert.ok(
                !nextAfterBacklog.queue.items.some((i) => i.id === targetDemoteId),
                "issue demoted via plan backlog must not appear in active `next` queue",
            );
            const backlogView = px.health(tmp, { action: "backlog", max: "all" });
            assert.ok(
                backlogView.queue.items.some((i) => i.id === targetDemoteId),
                "issue demoted via plan backlog must appear in `backlog` view",
            );

            const moveClusterRes = px.health(tmp, {
                action: "plan",
                subAction: "cluster",
                clusterAction: "move",
                patterns: [targetDemoteId],
                to: "cleanup_wave",
            });
            assert.ok(moveClusterRes.cluster.issue_ids.includes(targetDemoteId));

            // `managePlanCluster` path-jail errors: reject out-of-repo export `--output`, hidden `.dot` output, and out-of-repo `import`
            const fakeState = { issues: {} };
            const fakePlan = { clusters: { cleanup_wave: { name: "cleanup_wave", issue_ids: [targetDemoteId], depends_on: [], steps: [] } } };
            assert.throws(
                () => managePlanCluster(fakeState, fakePlan, "export", "cleanup_wave", [], { rootDir: tmp, output: "../escape.json" }),
                /within repository root/i,
            );
            assert.throws(
                () => managePlanCluster(fakeState, fakePlan, "export", "cleanup_wave", [], { rootDir: tmp, output: ".hidden/escape.json" }),
                /hidden\/dot/i,
            );
            assert.throws(
                () => managePlanCluster(fakeState, fakePlan, "import", "../outside-cluster.json", [], { rootDir: tmp }),
                /within repository root/i,
            );

            // Calibrated `scoring.js`: upper-median file-based potential + strictly monotone multi-issue concave responsiveness + verified:false gating
            const calibIssues = {};
            for (let k = 0; k < 6; k++) {
                const det = k % 2 === 0 ? "unused_imports" : "unreferenced_exports";
                const iid = `${det}::src/mod.ts::sym_${k}`;
                calibIssues[iid] = { id: iid, detector: det, dimension: "code_quality", file: "src/mod.ts", tier: "T3", confidence: "high", status: "open" };
            }
            const calibPotentials = { unused_imports: 20, unreferenced_exports: 30, dead_symbols: 15, orphaned_files: 12, facade_modules: 18 };
            const snapBefore = computeScoreSnapshot({ issues: calibIssues, potentials: calibPotentials });
            assert.equal(snapBefore.dimensions.code_quality.potential, 36, "file-based potential uses upper-median detector surface * 2 (18 * 2 = 36)");
            const calibIssuesFixedOne = {
                ...calibIssues,
                [Object.keys(calibIssues)[0]]: { ...Object.values(calibIssues)[0], status: "fixed", verified: true },
            };
            const snapAfterVerified = computeScoreSnapshot({ issues: calibIssuesFixedOne, potentials: calibPotentials });
            assert.ok(snapAfterVerified.strict > snapBefore.strict, "fixing 1 of 6 issues in same file must strictly lift score");
            const calibIssuesUnverified = {
                ...calibIssues,
                [Object.keys(calibIssues)[0]]: { ...Object.values(calibIssues)[0], status: "fixed", verified: false },
            };
            const snapUnverified = computeScoreSnapshot({ issues: calibIssuesUnverified, potentials: calibPotentials });
            assert.equal(snapUnverified.strict, snapBefore.strict, "unverified mechanical fix must NOT lift strict");
            assert.equal(snapUnverified.verified, snapBefore.verified, "unverified mechanical fix must NOT lift verified");
            assert.ok(snapUnverified.overall > snapBefore.overall, "unverified fix only lifts lenient overall");

            // (k) Luau inline `if ... then ... else` expressions do not inflate cognitive complexity
            const luauInlineIfComplexity = computeCognitiveComplexity(
                [
                    "local function evalFlag(a: boolean, b: boolean, c: boolean): number",
                    "    local x = if a then 1 else 0",
                    "    local y = if b then 2 else 0",
                    "    local z = if c then 3 else 0",
                    "    return x + y + z",
                    "end",
                ],
                ".luau",
                "evalFlag",
            );
            assert.ok(
                luauInlineIfComplexity <= 6,
                `Luau inline if-then-else expressions should not ratchet nesting (got ${luauInlineIfComplexity})`,
            );
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("handles Roblox/Luau patterns without false positives (client_server_boundary, DI barrel calls, alias duplicates, multiline pcall/Connect, factory GetService)", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-roblox-"));
        try {
            mkdirSync(join(tmp, "src", "Client"), { recursive: true });
            mkdirSync(join(tmp, "src", "Shared"), { recursive: true });
            mkdirSync(join(tmp, "src", "Server"), { recursive: true });
            mkdirSync(join(tmp, "test", "fixtures"), { recursive: true });

            // Root barrel `src/init.luau` routing `_K.Client.Notify`
            writeFileSync(
                join(tmp, "src", "init.luau"),
                [
                    "local _K = {}",
                    "_K.Shared = require(script.Shared)",
                    "_K.Client = require(script.Client)",
                    "_K.Notify = _K.Client.Notify",
                    "return _K",
                ].join("\n"),
                "utf8",
            );

            // Test fixture barrel under `test/` that must NOT hijack production `@root` barrel routes
            writeFileSync(
                join(tmp, "test", "fixtures", "init.luau"),
                [
                    "local _K = {}",
                    "_K.Notify = function() return 'fake' end",
                    "return _K",
                ].join("\n"),
                "utf8",
            );

            // Client module with:
            // 1. Dictionary keys `ServerScriptService = 30, ServerStorage = 30` (must NOT trigger roblox_security)
            // 2. Actual server-only `game:GetService("DataStoreService")` and `HttpService:GetAsync(...)` (MUST trigger roblox_security)
            // 3. Multiline `local ok, res =\n pcall(...)` and `table.insert(cleanup,\n sig:Connect(...))` (must NOT trigger silent_catches or untracked_connect)
            writeFileSync(
                join(tmp, "src", "Client", "init.luau"),
                [
                    "--!strict",
                    'local HttpService = game:GetService("HttpService")',
                    'local DataStoreService = game:GetService("DataStoreService")',
                    "local ExplorerOrder = {",
                    "    ServerScriptService = 30,",
                    "    ServerStorage = 30,",
                    "    DataStoreService = 40,",
                    "}",
                    "local Client = { ExplorerOrder = ExplorerOrder }",
                    "function Client.Notify(sig: any): boolean",
                    "    local cleanup = {}",
                    "    table.insert(",
                    "        cleanup,",
                    "        sig:Connect(function() end)",
                    "    )",
                    "    local ok, res =",
                    "        pcall(function()",
                    '            return HttpService:GetAsync("https://example.com")',
                    "        end)",
                    "    return ok and res ~= nil and DataStoreService ~= nil",
                    "end",
                    "return Client",
                ].join("\n"),
                "utf8",
            );

            // Shared module with:
            // 1. `return function(_K)` top-level module factory calling `game:GetService("Players")` at top of factory + inside `pcall`
            // 2. DI call `_K.Notify(...)` (must emit symbol `calls` edge to `Client.Notify` WITHOUT fabricating a `Shared -> Client` `layer_violation` or `directory_cycles`)
            // 3. Same-file `Shared.Method = applyHelper` alias (must NOT trigger `duplicates` or `unreferenced_exports` on `applyHelper`)
            writeFileSync(
                join(tmp, "src", "Shared", "init.luau"),
                [
                    "export type function Merge(base: type, extra: type)",
                    "    return base",
                    "end",
                    "return function(_K: any)",
                    '    local Players = game:GetService("Players")',
                    '    local _, TextService = pcall(function() return game:GetService("TextService") end)',
                    "    local Shared = {}",
                    "    local function applyHelper(a: number, b: number): number",
                    "        local total = 0",
                    "        for i = 1, a do",
                    "            if i % 2 == 0 then",
                    "                total += i * b",
                    "            else",
                    "                total += i + b",
                    "            end",
                    "        end",
                    "        _K.Notify({ Connect = function() return {} end })",
                    "        return total + (if Players and TextService then 1 else 0)",
                    "    end",
                    "    Shared.Method = applyHelper",
                    "    return Shared",
                    "end",
                ].join("\n"),
                "utf8",
            );

            const px = new Plexer();
            await px.graph(tmp);
            const scan = px.health(tmp, { action: "scan" });
            const items = scan.queue.all_items;

            // 1. `roblox_security` flags actual DataStoreService and HttpService:GetAsync on lines 3 and 18, NOT dictionary keys on lines 5-7
            const secItems = items.filter((i) => i.detector === "roblox_security" && i.file === "src/Client/init.luau");
            assert.ok(
                secItems.some((i) => i.line === 3 && i.summary.includes("DataStoreService")),
                "should flag game:GetService('DataStoreService') in Client module",
            );
            assert.ok(
                secItems.some((i) => i.line === 18 && i.summary.includes("HttpService:GetAsync")),
                "should flag HttpService:GetAsync in Client module",
            );
            assert.ok(
                !secItems.some((i) => i.line >= 4 && i.line <= 8),
                "must NOT flag ExplorerOrder dictionary keys (ServerScriptService = 30, ServerStorage = 30)",
            );

            // 2. DI parameter call `_K.Notify(...)` in Shared must NOT fabricate `layer_violation` or `directory_cycles`
            assert.ok(
                !items.some((i) => i.detector === "layer_violation" && i.file === "src/Shared/init.luau"),
                "DI call _K.Notify(...) in Shared must not trigger Shared -> Client layer_violation",
            );
            assert.ok(
                !items.some((i) => i.detector === "directory_cycles"),
                "DI call _K.Notify(...) must not fabricate directory_cycles",
            );
            // Yet the symbol call edge `applyHelper -> Client.Notify` is preserved so `Client.Notify` is NOT flagged as unreferenced
            assert.ok(
                !items.some((i) => i.detector === "unreferenced_exports" && i.identifier.includes("Notify")),
                "DI call _K.Notify(...) must still resolve symbol call edge to Client.Notify",
            );

            // 3. Same-file `Shared.Method = applyHelper` alias and `export type function Merge` must NOT trigger `duplicates`, `dead_symbols`, or `unreferenced_exports`
            assert.ok(
                !items.some((i) => i.detector === "duplicates" && i.file === "src/Shared/init.luau"),
                "same-file table alias Shared.Method = applyHelper must not flag as duplicate of itself",
            );
            assert.ok(
                !items.some((i) => i.detector === "dead_symbols" && i.identifier === "Merge"),
                "Luau 2024+ export type function Merge must be extracted as kind=type and not flagged as dead_symbols",
            );

            // 4. Multiline `pcall` and `:Connect` must NOT trigger `silent_catches` or `untracked_connect`
            assert.ok(
                !items.some((i) => i.detector === "silent_catches" && i.file === "src/Client/init.luau"),
                "multiline local ok, res =\\n pcall(...) must not trigger silent_catches",
            );
            assert.ok(
                !items.some((i) => i.detector === "untracked_connect" && i.file === "src/Client/init.luau"),
                "multiline table.insert(cleanup,\\n sig:Connect(...)) must not trigger untracked_connect",
            );

            // 5. `return function(_K)` module factory and `pcall` GetService must NOT trigger `luau_quality` (`service_in_fn`) or `luau-hoist-getservice`
            assert.ok(
                !items.some((i) => i.detector === "luau_quality" && i.file === "src/Shared/init.luau"),
                "top-of-factory and pcall-guarded game:GetService must not trigger service_in_fn",
            );
            const fixRes = px.health(tmp, { action: "autofix", fixer: "luau-hoist-getservice", dryRun: false });
            assert.equal(
                fixRes.total_edits,
                0,
                "luau-hoist-getservice must not hoist game:GetService out of return function(_K) module factory",
            );

            // 6. Compact vs --verbose health status rendering
            const { formatHealthText } = await import("../src/health/render.js");
            const statusPayload = px.health(tmp, { action: "status" });
            const verbosePayload = px.health(tmp, { action: "status", verbose: true });
            const compactTxt = formatHealthText(statusPayload);
            const verboseTxt = formatHealthText(verbosePayload);
            assert.ok(
                compactTxt.includes("clean dimensions at 100.0% (0 drag — pass --verbose for all)"),
                "compact health status should collapse 100.0% zero-drag dimensions",
            );
            assert.ok(
                !verboseTxt.includes("pass --verbose for all"),
                "verbose health status should expand all dimensions without collapse summary",
            );
            assert.ok(verboseTxt.length > compactTxt.length, "verbose output should be longer than compact output");

            // 7. Python @lru_cache global constant vs mutable global trap precision
            writeFileSync(
                join(tmp, "src", "py_cache.py"),
                [
                    "from functools import lru_cache",
                    "ALLOWED_ROLES = {'admin', 'editor'}",
                    "session_items = {}",
                    "",
                    "@lru_cache(maxsize=64)",
                    "def is_allowed_role(role: str) -> bool:",
                    "    return role in ALLOWED_ROLES",
                    "",
                    "@lru_cache(maxsize=64)",
                    "def get_session_item(key: str):",
                    "    return session_items.get(key)",
                ].join("\n"),
                "utf8",
            );
            await px.graph(tmp);
            const pyTrapRes = px.health(tmp, { action: "detect", detector: "language_traps" });
            assert.ok(
                !pyTrapRes.items.some((i) => i.id.includes("lru_cache_global_is_allowed_role")),
                "UPPERCASE constant ALLOWED_ROLES inside @lru_cache must not trigger false-positive lru_cache_global",
            );
            assert.ok(
                pyTrapRes.items.some((i) => i.id.includes("lru_cache_global_get_session_item")),
                "lowercase mutable global session_items inside @lru_cache must trigger lru_cache_global",
            );
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe("plexer health generated-file and data-module guards", () => {
    it("never suggests inlining data-only modules, @generated files, or CI-written files", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-gen-"));
        try {
            const dir = join(tmp, "src", "Explorer");
            mkdirSync(dir, { recursive: true });
            mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
            writeFileSync(
                join(tmp, ".github", "workflows", "regen.yml"),
                [
                    "jobs:",
                    "  update:",
                    "    steps:",
                    "      - uses: stefanzweifel/git-auto-commit-action@v7",
                    "        with:",
                    '          file_pattern: "src/Explorer/Wf.luau"',
                ].join("\n"),
            );
            const fnModule = (name) => `local function ${name}()\n\treturn 1\nend\nreturn { ${name} = ${name} }\n`;
            writeFileSync(join(dir, "Order.luau"), "--stylua: ignore\nreturn {Accessory=30,Actor=10,Folder=10}\n");
            writeFileSync(join(dir, "Helper.luau"), fnModule("helper"));
            writeFileSync(join(dir, "Hdr.luau"), `-- @generated by tools/gen.py. Do not edit.\n${fnModule("hdr")}`);
            writeFileSync(join(dir, "Wf.luau"), fnModule("wf"));
            writeFileSync(
                join(dir, "init.luau"),
                [
                    'local Order = require(script:WaitForChild("Order"))',
                    'local Helper = require(script:WaitForChild("Helper"))',
                    'local Hdr = require(script:WaitForChild("Hdr"))',
                    'local Wf = require(script:WaitForChild("Wf"))',
                    "return function(name)",
                    "\treturn Order[name], Helper.helper(), Hdr.hdr(), Wf.wf()",
                    "end",
                ].join("\n"),
            );

            assert.equal(classifyZone("src/Explorer/Hdr.luau", {}, tmp), "generated");
            assert.equal(classifyZone("src/Explorer/Wf.luau", {}, tmp), "generated");
            assert.equal(classifyZone("src/Explorer/Helper.luau", {}, tmp), "production");

            const px = new Plexer();
            await px.graph(tmp);
            const res = px.health(tmp, { action: "detect", detector: "single_importer_files" });
            const flagged = res.items.map((i) => i.identifier).sort();
            assert.deepEqual(flagged, ["Helper.luau"], `only the 1-function micro-module should be flagged, got ${flagged}`);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports --false-positive --reason dismissal, abuse warning, safe autofix ordering, and precision checks across detectors", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-health-precision-"));
        try {
            mkdirSync(join(tmp, "src", "Main", "Commands"), { recursive: true });
            mkdirSync(join(tmp, "src", "Client"), { recursive: true });
            mkdirSync(join(tmp, "src", "Web"), { recursive: true });
            mkdirSync(join(tmp, "tests"), { recursive: true });

            // 1. Dynamic loader + Command child (must NOT trigger orphaned_files / unreferenced_exports)
            writeFileSync(
                join(tmp, "src", "Main", "init.luau"),
                [
                    "local Main = {}",
                    "function Main.load()",
                    "    for _, mod in script.Commands:GetChildren() do",
                    "        if mod:IsA('ModuleScript') then",
                    "            require(mod)",
                    "        end",
                    "    end",
                    "end",
                    "return Main",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Main", "Commands", "Kick.luau"),
                [
                    "local Kick = {}",
                    "function Kick.Run(ctx, target)",
                    "    return tostring(target)",
                    "end",
                    "return Kick",
                ].join("\n"),
                "utf8",
            );

            // 2. Autofix target: header comments + guarded GetService + Instance.new 2-arg with prop assignments + JSX React
            writeFileSync(
                join(tmp, "src", "Main", "BuildUi.luau"),
                [
                    "--!strict",
                    "--[=[",
                    "Header block comment",
                    "]=]",
                    "local M = {}",
                    "function M.build(cond: boolean)",
                    "    if cond then",
                    "        local TweenService = game:GetService('TweenService')",
                    "        print(TweenService)",
                    "    end",
                    "    local Players = game:GetService('Players')",
                    "    local frame = Instance.new('Frame', workspace)",
                    "    frame.Name = 'Panel'",
                    "    frame.Visible = false",
                    "    return Players, frame",
                    "end",
                    "return M",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Web", "Widget.jsx"),
                [
                    'import React from "react";',
                    "export function Widget() {",
                    "    try {",
                    "        return <span>ok</span>;",
                    "    } catch {",
                    "        return null;",
                    "    }",
                    "}",
                    "export function brokenFallback() {",
                    "    try {",
                    "        return 1;",
                    "    } catch {",
                    "        return undefined;",
                    "    }",
                    "}",
                ].join("\n"),
                "utf8",
            );

            // 3. Disjoint-API small functions (must NOT trigger duplicates)
            writeFileSync(
                join(tmp, "src", "Main", "DisjointA.luau"),
                [
                    "local A = {}",
                    "function A.compute(items)",
                    "    local out = {}",
                    "    for i, v in ipairs(items) do",
                    "        local norm = Players:GetPlayerByUserId(v)",
                    "        if norm then",
                    "            out[i] = HttpService:JSONEncode(norm)",
                    "        else",
                    "            out[i] = utf8.char(65)",
                    "        end",
                    "    end",
                    "    return ContentProvider:PreloadAsync(out)",
                    "end",
                    "return A",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Main", "DisjointB.luau"),
                [
                    "local B = {}",
                    "function B.format(items)",
                    "    local res = {}",
                    "    for idx, entry in pairs(items) do",
                    "        local val = CollectionService:GetTagged(entry)",
                    "        if val then",
                    "            res[idx] = Workspace:FindFirstChild(val)",
                    "        else",
                    "            res[idx] = TweenService:Create(entry)",
                    "        end",
                    "    end",
                    "    return SoundService:PlayLocalSound(res)",
                    "end",
                    "return B",
                ].join("\n"),
                "utf8",
            );

            // 4. Deceptive queries + Luau precision + Client FindService + Runner vs Spec tests
            writeFileSync(
                join(tmp, "src", "Main", "Queries.luau"),
                [
                    "local Queries = {}",
                    "function Queries.getOrCreateCache(store)",
                    "    store:SetAsync('k', 1)",
                    "    return store",
                    "end",
                    "function Queries.getMeasuredBounds()",
                    "    local temp = Instance.new('Part')",
                    "    local sz = temp.Size",
                    "    temp:Destroy()",
                    "    return sz",
                    "end",
                    "function Queries.getWithExternalDestroy(target)",
                    "    target:Destroy()",
                    "    return true",
                    "end",
                    "return Queries",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Main", "LuauTraps.server.luau"),
                [
                    "local function wait(n)",
                    "    return task.wait(n)",
                    "end",
                    "local Sig = workspace.ChildAdded",
                    "Sig:Connect(function() end)",
                    "local Re = workspace.RemoteEvent",
                    "Re.OnServerEvent:Connect(function(_player, _unused)",
                    "    return",
                    "end)",
                    "local function leakyInFn()",
                    "    wait(0.2)",
                    "    local _ = Sig:Connect(function() end)",
                    "    local _ = pcall(error, 'boom')",
                    "    pcall(function() workspace:ClearAllChildren() end)",
                    "end",
                    "return leakyInFn",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "src", "Client", "Probe.client.luau"),
                [
                    "local s = game:FindService('ServerScriptService')",
                    "print(s)",
                ].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "tests", "runTests.server.luau"),
                ["local runner = require(script.Parent)", "runner.run()"].join("\n"),
                "utf8",
            );
            writeFileSync(
                join(tmp, "tests", "widget.spec.luau"),
                ["return function()", "    local x = 1 + 1", "    local y = x + 2", "    local z = y + 3", "    return z", "end"].join("\n"),
                "utf8",
            );

            // Apostrophe in Luau comment must not break quotes on the same line
            const stripped = stripCodeStringsAndComments('-- don\'t break "keep"', true, false);
            assert.equal(stripped.trim(), "");

            const px = new Plexer();
            await px.graph(tmp);
            const scan = px.health(tmp, { action: "scan" });
            const items = scan.queue.all_items;

            // Dynamic loader children exempt
            assert.ok(
                !items.some((i) => i.file === "src/Main/Commands/Kick.luau" && (i.detector === "orphaned_files" || i.detector === "unreferenced_exports")),
                "dynamic loader child Kick.luau must not be flagged as orphaned or unreferenced_exports",
            );
            // Disjoint small functions not duplicates
            assert.ok(
                !items.some((i) => i.detector === "duplicates" && (i.file.includes("DisjointA") || i.file.includes("DisjointB"))),
                "functions calling disjoint external APIs must not trigger duplicates",
            );
            // getOrCreate & local temp:Destroy() exempt; external target:Destroy() caught
            assert.ok(
                !items.some((i) => i.detector === "deceptive_queries" && (i.identifier.includes("getOrCreateCache") || i.identifier.includes("getMeasuredBounds"))),
                "getOrCreate* and local temp:Destroy() must be exempt from deceptive_queries",
            );
            assert.ok(
                items.some((i) => i.detector === "deceptive_queries" && i.identifier.includes("getWithExternalDestroy")),
                "deceptive_queries must still flag external target:Destroy()",
            );
            // Runner script skipped by hollow_tests while .spec.luau without assertions is flagged
            assert.ok(
                !items.some((i) => i.detector === "hollow_tests" && i.file.includes("runTests.server.luau")),
                "test runner bootstrap should be skipped by hollow_tests",
            );
            assert.ok(
                items.some((i) => i.detector === "hollow_tests" && i.file.includes("widget.spec.luau")),
                "hollow widget.spec.luau should be flagged by hollow_tests",
            );
            // Luau source checks precision
            assert.ok(
                !items.some((i) => i.detector === "luau_quality" && i.file.includes("LuauTraps") && i.identifier.startsWith("wait_")),
                "shadowed local wait() must not trigger legacy wait()",
            );
            assert.ok(
                !items.some((i) => i.detector === "luau_quality" && i.file.includes("LuauTraps") && i.identifier === "Connect_L5"),
                "top-level Sig:Connect must not trigger untracked_connect",
            );
            assert.ok(
                items.some((i) => i.detector === "luau_quality" && i.file.includes("LuauTraps") && i.identifier === "Connect_L12"),
                "function-scoped `local _ = Sig:Connect(...)` must still trigger untracked_connect",
            );
            assert.ok(
                items.some((i) => i.detector === "silent_catches" && i.file.includes("LuauTraps") && i.line === 13),
                "`local _ = pcall(...)` must still trigger silent_catches",
            );
            assert.ok(
                !items.some((i) => i.detector === "silent_catches" && i.file.includes("LuauTraps") && i.line === 14),
                "cleanup pcall(ClearAllChildren) must be exempt from silent_catches",
            );
            assert.ok(
                !items.some((i) => i.detector === "roblox_security" && i.file.includes("Probe.client.luau")),
                "game:FindService probe on client must be exempt from roblox_security",
            );
            assert.ok(
                !items.some((i) => i.detector === "roblox_security" && i.file.includes("LuauTraps") && i.line === 7),
                "remote handler with _unused payload param must be exempt",
            );
            assert.ok(
                !items.some((i) => i.detector === "silent_catches" && i.file.includes("Widget.jsx") && i.line === 5),
                "JS 1-line fallback `catch { return null; }` must be exempt",
            );
            assert.ok(
                items.some((i) => i.detector === "silent_catches" && i.file.includes("Widget.jsx") && i.line === 12),
                "JS `catch { return undefined; }` must still be flagged",
            );

            // Autofix safety checks
            px.health(tmp, { action: "autofix", fixer: "luau-instance-new-parent", dryRun: false });
            px.health(tmp, { action: "autofix", fixer: "luau-hoist-getservice", dryRun: false });
            px.health(tmp, { action: "autofix", fixer: "unused-imports", dryRun: false });

            const fixedBuildUi = readFileSync(join(tmp, "src", "Main", "BuildUi.luau"), "utf8");
            const buildUiLines = fixedBuildUi.split("\n");
            assert.equal(buildUiLines[0], "--!strict", "hoisted service must stay below --!strict");
            assert.ok(
                buildUiLines.indexOf("]=]") < buildUiLines.indexOf('local Players = game:GetService("Players")'),
                "hoisted service must insert below leading block comment",
            );
            assert.ok(
                fixedBuildUi.includes("local TweenService = game:GetService('TweenService')"),
                "guarded GetService inside `if` block must not be hoisted",
            );
            assert.ok(
                fixedBuildUi.indexOf("frame.Visible = false") < fixedBuildUi.indexOf("frame.Parent = workspace"),
                ".Parent assignment must be emitted AFTER contiguous frame.<Prop> = ... assignments",
            );
            const fixedJsx = readFileSync(join(tmp, "src", "Web", "Widget.jsx"), "utf8");
            assert.ok(fixedJsx.includes('import React from "react"'), "classic JSX must preserve React import");

            // --false-positive --reason dismissal & abuse warning (>10% & >=3 FPs)
            const strictStart = scan.scores.strict;
            const openIds = items.filter((i) => i.status === "open").map((i) => i.id);
            assert.ok(openIds.length >= 3, `expected >= 3 open issues for FP test, got ${openIds.length}`);

            const badReason = px.health(tmp, {
                action: "suppress",
                pattern: openIds[0],
                falsePositive: true,
                reason: "false positive",
            });
            assert.equal(badReason.status, "attestation_invalid", "boilerplate --reason must be rejected");

            const fp1 = px.health(tmp, {
                action: "suppress",
                pattern: openIds[0],
                falsePositive: true,
                reason: "Intentional fixture test pattern verified in harness",
            });
            assert.equal(fp1.status, "suppressed");
            assert.equal(fp1.kind, "false_positive");
            assert.ok(fp1.scores.strict > strictStart, "false_positive suppress must lift strict score");

            px.health(tmp, {
                action: "plan",
                subAction: "skip",
                patterns: [openIds[1]],
                falsePositive: true,
                reason: "Dynamic dispatch makes static detection inapplicable here",
            });
            const fp3 = px.health(tmp, {
                action: "suppress",
                pattern: openIds[2],
                falsePositive: true,
                reason: "Intentional second false positive to exercise warning threshold",
            });
            assert.equal(fp3.scores.ignore_integrity.false_positive_abuse_warning, true);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
