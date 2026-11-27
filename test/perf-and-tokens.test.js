import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { contextDirFor } from "../src/context/node-file.js";
import { loadGraphCached } from "../src/context/graph-store.js";
import { probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { loadAskVocabCached } from "../src/ask/index-file.js";
import { personalizedPageRank, preparePageRankTopology } from "../src/ask/graph-rank.js";
import { TOOLS } from "../src/mcp/tools.js";
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from "../src/agy/session.js";
import { mergeSpan } from "../src/agy/spans.js";
import { dispatchHostEvent } from "../src/hosts/engine/dispatcher.js";
import { rewriteShellExplorationCommand } from "../src/agy/shell-rewrite.js";
import { rewriteSingleNpxPlexerCommand } from "../src/agy/pre-tool.js";
import { runCli } from "../src/cli/cli-main.js";

function makeTempRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, "src"), { recursive: true });
    return dir;
}

describe("Performance, Caching, & Token Reduction Contracts", () => {
    it("heals clean fingerprint dir/file mtimes on slow probeDrift while detecting subsequent edits immediately", async () => {
        const repo = makeTempRepo("plexer-drift-heal-");
        try {
            const modPath = join(repo, "src", "alpha.js");
            writeFileSync(modPath, "export function alphaFn() { return 1; }\n", "utf8");
            await buildGraph(repo, { force: true });
            const outDir = contextDirFor(repo);

            // Bump dir mtime + source mtime without changing indexed content so probeFastDirsClean misses once.
            const future = new Date(Date.now() + 5000);
            utimesSync(repo, future, future);
            utimesSync(modPath, future, future);

            const cleanDrift = probeDrift(repo, outDir);
            assert.deepEqual(cleanDrift, { changed: [], added: [], removed: [] });

            const healedFp = readFingerprint(outDir);
            assert.ok(healedFp, "healed fingerprint remains readable");
            assert.equal(healedFp.dirs["."], statSync(repo).mtimeMs, "clean slow probe heals directory mtime");
            assert.equal(healedFp.files["src/alpha.js"][1], statSync(modPath).mtimeMs, "clean slow probe heals matching-hash file mtime");

            // Touch a non-source noise file in repo root? No: real edit to src/alpha.js must still be caught immediately.
            writeFileSync(modPath, "export function alphaFn() { return 42 + 100; }\n", "utf8");
            const afterEdit = probeDrift(repo, outDir);
            assert.ok(afterEdit.changed.includes("src/alpha.js"), "real edit after healing must be detected immediately");
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("caches loadAskVocabCached by SQLite WAL revision and invalidates on rebuild", async () => {
        const repo = makeTempRepo("plexer-vocab-cache-");
        try {
            const aPath = join(repo, "src", "svc.js");
            writeFileSync(aPath, "export function alphaToken() { return 1; }\n", "utf8");
            await buildGraph(repo, { force: true });
            const outDir = contextDirFor(repo);

            const v1 = loadAskVocabCached(outDir);
            const v2 = loadAskVocabCached(outDir);
            assert.ok(v1, "vocab loaded from sqlite");
            assert.equal(v1, v2, "consecutive loadAskVocabCached calls must return the same cached reference");
            assert.equal(v1.nameTokens.has("alpha"), true);

            writeFileSync(aPath, "export function zebraSignalToken() { return 2; }\n", "utf8");
            await buildGraph(repo, { force: true });
            const v3 = loadAskVocabCached(outDir);
            assert.notEqual(v3, v1, "vocab cache must invalidate after graph rebuild");
            assert.equal(v3.nameTokens.has("zebra"), true);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("pre-normalizes attachCsr edge weights and preserves PageRank topology ordering", () => {
        const graph = {
            nodes: [
                { id: "src/a.js#seedFn", name: "seedFn", kind: "function", path: "src/a.js", span: "L1-L3" },
                { id: "src/b.js#leafCaller", name: "leafCaller", kind: "function", path: "src/b.js", span: "L1-L3" },
                { id: "src/c.js#coldNode", name: "coldNode", kind: "function", path: "src/c.js", span: "L1-L3" },
            ],
            edges: [
                { source: "src/b.js#leafCaller", target: "src/a.js#seedFn", relation: "calls" },
                { source: "src/c.js#coldNode", target: "src/b.js#leafCaller", relation: "calls" },
            ],
        };
        const topo = preparePageRankTopology(graph);
        const csr = topo._csr;
        assert.ok(csr, "preparePageRankTopology attaches CSR");
        for (let u = 0; u < csr.nodeIds.length; u++) {
            const start = csr.offsets[u];
            const end = csr.offsets[u + 1];
            if (start < end && csr.outWeightSum[u] > 0) {
                assert.equal(csr.outWeightSum[u], 1);
                let rowSum = 0;
                for (let e = start; e < end; e++) rowSum += csr.weights[e];
                assert.ok(Math.abs(rowSum - 1) < 1e-12, `expected pre-normalized row sum ~1, got ${rowSum}`);
            }
        }
        const ranks = personalizedPageRank(graph, new Map([["src/a.js#seedFn", 1]]));
        const rSeed = ranks.get("src/a.js#seedFn") ?? 0;
        const rCaller = ranks.get("src/b.js#leafCaller") ?? 0;
        const rCold = ranks.get("src/c.js#coldNode") ?? 0;
        assert.ok(rSeed === 1 && rCaller > rCold && rCold > 0, "PPR propagates rank monotonically along call hops");
    });

    it("keeps compressed MCP TOOLS schema under 5.2 KB with all 9 tools and required fields intact", () => {
        assert.equal(TOOLS.length, 9);
        const bytes = Buffer.byteLength(JSON.stringify(TOOLS), "utf8");
        assert.ok(bytes <= 5200, `expected MCP TOOLS <= 5200B, got ${bytes}B`);
        const byName = new Map(TOOLS.map((t) => [t.name, t]));
        for (const name of [
            "plexer_find_code", "plexer_read", "plexer_file_api", "plexer_check_freshness",
            "plexer_trace_calls", "plexer_find_all", "plexer_repo_map", "plexer_blast", "plexer_health",
        ]) {
            const tool = byName.get(name);
            assert.ok(tool, `missing tool ${name}`);
            assert.equal(tool.annotations?.readOnlyHint, name !== "plexer_health");
        }
        assert.deepEqual(byName.get("plexer_find_code").inputSchema.required, ["query"]);
        assert.deepEqual(byName.get("plexer_read").inputSchema.required, ["spans"]);
        assert.deepEqual(byName.get("plexer_file_api").inputSchema.required, ["file"]);
        assert.deepEqual(byName.get("plexer_trace_calls").inputSchema.required, ["symbol"]);
        assert.deepEqual(byName.get("plexer_find_all").inputSchema.required, ["pattern"]);
    });

    it("gates Claude & Gemini post-tool edit blast radius, caps at 600B, filters seen callers, and isolates per-repo dedup", async () => {
        const repo1 = makeTempRepo("plexer-host-post-1-");
        const repo2 = makeTempRepo("plexer-host-post-2-");
        const sid = `host-post-${process.pid}-${Date.now()}`;
        try {
            const core1 = join(repo1, "src", "core.js");
            const callerSeen = join(repo1, "src", "caller_seen.js");
            const callerUnseen = join(repo1, "src", "caller_unseen.js");
            writeFileSync(core1, [
                "export function keepTop() { return 1; }",
                "export function computeTotal(a, b) {",
                "    const s = a + b;",
                "    return s;",
                "}",
                "",
            ].join("\n"), "utf8");
            writeFileSync(callerSeen, "import { computeTotal } from './core.js';\nexport function useSeen() { return computeTotal(1, 2); }\n", "utf8");
            writeFileSync(callerUnseen, "import { computeTotal } from './core.js';\nexport function useUnseen() { return computeTotal(3, 4); }\n", "utf8");
            await buildGraph(repo1, { force: true });

            writeFileSync(join(repo2, "src", "core.js"), "export function computeTotal(a) { return a; }\n", "utf8");
            writeFileSync(join(repo2, "src", "other.js"), "import { computeTotal } from './core.js';\nexport function runOther() { return computeTotal(9); }\n", "utf8");
            await buildGraph(repo2, { force: true });

            const sess = emptyAgySession();
            mergeSpan(sess.seenSpans, "src/core.js", 1, 5);
            mergeSpan(sess.seenSpans, "src/caller_seen.js", 1, 2);
            writeAgySession(sid, sess);

            // Body-only edit below line 1: suppresses blast radius AND preserves line 1 in seenSpans.
            writeFileSync(core1, [
                "export function keepTop() { return 1; }",
                "export function computeTotal(a, b) {",
                "    const s = a + b;",
                "    return s + 10;",
                "}",
                "",
            ].join("\n"), "utf8");
            const bodyRes = dispatchHostEvent("gemini-after-tool", {
                session_id: sid,
                cwd: repo1,
                tool_name: "replace",
                tool_input: { file_path: core1, old_string: "    return s;", new_string: "    return s + 10;" },
            }, { captureStdout: true });
            assert.equal(bodyRes.trim(), "", "body-only Gemini edit must suppress blast radius");
            const afterBody = readAgySession(sid);
            assert.deepEqual(afterBody.seenSpans["src/core.js"], [[1, 3], [5, 5]], "resolveMinChangedLine preserves unedited lines above and below same-length edit");

            // Signature edit: emits <=600B blast radius, omits seen caller, includes unseen caller.
            writeFileSync(core1, [
                "export function keepTop() { return 1; }",
                "export function computeTotal(a, b, c = 0) {",
                "    const s = a + b + c;",
                "    return s + 10;",
                "}",
                "",
            ].join("\n"), "utf8");
            const sigOut = dispatchHostEvent("post-tool-use", {
                session_id: sid,
                cwd: repo1,
                tool_name: "Edit",
                tool_input: { file_path: core1, old_string: "export function computeTotal(a, b) {", new_string: "export function computeTotal(a, b, c = 0) {" },
            }, { captureStdout: true });
            const parsedSig = JSON.parse(sigOut);
            const sigCtx = parsedSig.hookSpecificOutput?.additionalContext || "";
            assert.match(sigCtx, /blast radius for core\.js/);
            assert.ok(Buffer.byteLength(sigCtx, "utf8") <= 600, `blast radius should stay <=600B, got ${Buffer.byteLength(sigCtx, "utf8")}B`);
            assert.match(sigCtx, /useUnseen/);
            assert.doesNotMatch(sigCtx, /useSeen/, "seen caller should be excluded from post-edit blast radius");

            // Duplicate signature edit in same repo & session suppresses duplicate blast emission.
            const dupOut = dispatchHostEvent("post-tool-use", {
                session_id: sid,
                cwd: repo1,
                tool_name: "Edit",
                tool_input: { file_path: core1, old_string: "export function computeTotal(a, b, c = 0) {", new_string: "export function computeTotal(a, b, c = 1) {" },
            }, { captureStdout: true });
            assert.equal(dupOut.trim(), "");

            // Same session_id in a different repo must NOT leak emittedBlastFiles across repos.
            const repo2Out = dispatchHostEvent("gemini-after-tool", {
                session_id: sid,
                cwd: repo2,
                tool_name: "replace",
                tool_input: { file_path: join(repo2, "src", "core.js"), old_string: "export function computeTotal(a) {", new_string: "export function computeTotal(a, b) {" },
            }, { captureStdout: true });
            assert.match(JSON.parse(repo2Out).hookSpecificOutput?.additionalContext || "", /runOther/);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo1, { recursive: true, force: true });
            rmSync(repo2, { recursive: true, force: true });
        }
    });

    it("dedups seen >=15L symbol bodies in callers --session and grep --session while preserving --full / -C", async () => {
        const repo = makeTempRepo("plexer-cli-sess-");
        const sid = `cli-sess-${process.pid}-${Date.now()}`;
        try {
            const bodyLines = Array.from({ length: 16 }, (_, i) => `    const step${i} = x + ${i};`).join("\n");
            writeFileSync(join(repo, "src", "big.js"), [
                "export function bigPipeline(x) {",
                bodyLines,
                "    return step0;",
                "}",
                "",
            ].join("\n"), "utf8");
            writeFileSync(join(repo, "src", "driver.js"), [
                "import { bigPipeline } from './big.js';",
                "export function runDriver() {",
                "    const a = 1;",
                "    return bigPipeline(a);",
                "}",
                "",
            ].join("\n"), "utf8");
            await buildGraph(repo, { force: true });

            const sess = emptyAgySession();
            mergeSpan(sess.seenSpans, "src/big.js", 1, 19);
            writeAgySession(sid, sess);

            let callersDedupOut = "";
            await runCli(["node", "plexer", "--session", sid, "callers", "bigPipeline", repo, "--no-refresh"], {
                isCaptured: true, cwd: repo, writeOut: (s) => { callersDedupOut += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(callersDedupOut, /\[seen: src\/big\.js:L1-L19/);
            assert.match(callersDedupOut, /runDriver/);

            let callersFullOut = "";
            await runCli(["node", "plexer", "--session", sid, "callers", "bigPipeline", repo, "--full", "--no-refresh"], {
                isCaptured: true, cwd: repo, writeOut: (s) => { callersFullOut += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.doesNotMatch(callersFullOut, /\[seen:/);
            assert.match(callersFullOut, /2:\s+const step0 = x \+ 0;/);

            let grepDedupOut = "";
            await runCli(["node", "plexer", "--session", sid, "grep", "step5", repo, "--fixed", "--no-refresh"], {
                isCaptured: true, cwd: repo, writeOut: (s) => { grepDedupOut += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(grepDedupOut, /7:\s+const step5 = x \+ 5;/);
            assert.doesNotMatch(grepDedupOut, /(?:^|\n)\s*6:\s+const step4/);

            let grepExplicitCtxOut = "";
            await runCli(["node", "plexer", "--session", sid, "grep", "step5", repo, "--fixed", "-C", "1", "--no-refresh"], {
                isCaptured: true, cwd: repo, writeOut: (s) => { grepExplicitCtxOut += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(grepExplicitCtxOut, /6:\s+const step4/);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("rewrites multi-file cat, nl, unbounded git log, and extends --session on single plexer commands", async () => {
        const repo = makeTempRepo("plexer-shell-ext-");
        try {
            writeFileSync(join(repo, "src", "one.js"), "export const a = 1;\nexport const b = 2;\n", "utf8");
            writeFileSync(join(repo, "src", "two.js"), "export const c = 3;\nexport const d = 4;\n", "utf8");
            await buildGraph(repo, { force: true });
            const sid = "shell-ext-sid";

            const catMulti = rewriteShellExplorationCommand("cat src/one.js src/two.js", { repoRoot: repo, sessionId: sid });
            assert.match(String(catMulti || ""), /read\s+src\/one\.js:L1-L2\s+src\/two\.js:L1-L2\s+--session shell-ext-sid/);

            const nlCmd = rewriteShellExplorationCommand("nl -ba src/one.js", { repoRoot: repo, sessionId: sid });
            assert.match(String(nlCmd || ""), /read\s+src\/one\.js:L1-L2\s+--session shell-ext-sid/);

            assert.equal(
                rewriteShellExplorationCommand("git log src/one.js", { repoRoot: repo }),
                "git log src/one.js --oneline -n 15",
            );
            assert.equal(
                rewriteShellExplorationCommand("git log --stat", { repoRoot: repo }),
                "git log --stat -n 15",
            );
            assert.equal(rewriteShellExplorationCommand("git log -n 5 --oneline", { repoRoot: repo }), null);
            assert.equal(rewriteShellExplorationCommand("git log -p src/one.js", { repoRoot: repo }), "git log -p src/one.js -n 3");

            assert.match(
                String(rewriteSingleNpxPlexerCommand("plexer callers computeAlpha", sid) || ""),
                /callers computeAlpha --session shell-ext-sid$/,
            );
            assert.match(
                String(rewriteSingleNpxPlexerCommand("plexer grep computeAlpha src", sid) || ""),
                /grep computeAlpha src --session shell-ext-sid$/,
            );
            assert.equal(
                String(rewriteSingleNpxPlexerCommand("plexer callers computeAlpha --json", sid) || "").includes("--session"),
                false,
            );
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("supports selective CLI command registration while keeping --help, --version, and unknown command handling intact", async () => {
        const capCli = async (argv) => {
            let stdout = "";
            let stderr = "";
            let exitCode = 0;
            try {
                await runCli(["node", "plexer", ...argv], {
                    isCaptured: true,
                    writeOut: (s) => { stdout += String(s ?? ""); },
                    writeErr: (s) => { stderr += String(s ?? ""); },
                    exit: (c) => {
                        exitCode = Number(c) || 0;
                        throw Object.assign(new Error(`exit ${exitCode}`), { isTestExit: true, exitCode });
                    },
                });
            } catch (err) {
                if (!err?.isTestExit) throw err;
            }
            return { stdout, stderr, exitCode };
        };

        const help = await capCli(["--help"]);
        assert.equal(help.exitCode, 0);
        assert.match(help.stdout, /\bask\b/);
        assert.match(help.stdout, /\bread\b/);
        assert.match(help.stdout, /\bhealth\b/);
        assert.match(help.stdout, /\bcallers\b/);

        const ver = await capCli(["--version"]);
        assert.equal(ver.exitCode, 0);
        assert.match(ver.stdout, /^\d+\.\d+\.\d+/);

        const unknown = await capCli(["not-a-real-cmd"]);
        assert.notEqual(unknown.exitCode, 0);
        assert.match(unknown.stderr, /unknown command/i);
    });
});
