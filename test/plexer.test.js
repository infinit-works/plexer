import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
    Plexer,
    buildGraph,
    checkGraph,
    ask,
    skeleton,
    grepGraph,
    resolveSymbol,
    edgeWalk,
    buildRepoMap,
    exportViz,
} from "../src/index.js";
import { extractFile, warmDepthGrammars } from "../src/graph/extract.js";
import { warmGenericGrammars, extractGeneric } from "../src/graph/generic.js";
import { normalizeLuauForParse } from "../src/graph/luau.js";
import { loadGraphCached } from "../src/graph/load.js";
import { callTool } from "../src/mcp/tools.js";

describe("WASM Tree-Sitter Extraction (Depth + Breadth + Luau)", () => {
    it("extracts TypeScript, Python, Go, Rust, C, and Luau symbols via WASM without native addons", async () => {
        await warmDepthGrammars();
        await warmGenericGrammars(["rust", "c", "luau"]);

        const ts = extractFile("src/app.ts", "export function greet(name: string): string { return helper(name); }\n");
        assert.ok(ts);
        assert.ok(ts.nodes.some((n) => n.name === "greet" && n.kind === "function"));
        assert.ok(ts.rawEdges.some((e) => e.name === "helper" && e.relation === "calls"));

        const py = extractFile("pkg/mod.py", "def compute(x: int) -> int:\n    return transform(x)\n");
        assert.ok(py);
        assert.ok(py.nodes.some((n) => n.name === "compute"));
        assert.ok(py.rawEdges.some((e) => e.name === "transform"));

        const go = extractFile("main.go", "package main\nfunc Run() { helper() }\n");
        assert.ok(go);
        assert.ok(go.nodes.some((n) => n.name === "Run"));

        const rs = extractGeneric("src/lib.rs", "pub fn verify(input: &str) -> bool { check_inner(input) }\n");
        assert.ok(rs);
        assert.ok(rs.nodes.some((n) => n.name === "verify"));

        const c = extractGeneric("src/util.c", "int add(int a, int b) { return a + b; }\n");
        assert.ok(c);
        assert.ok(c.nodes.some((n) => n.name === "add"));

        const luau = extractGeneric(
            "src/Module.luau",
            "local Module = {}\nfunction Module.run(x: number): number\n\treturn x + 1\nend\nreturn Module\n",
        );
        assert.ok(luau);
        assert.ok(luau.nodes.some((n) => n.name === "Module.run" || n.name === "run"));
    });

    it("normalizes 2024-2026 Luau syntax while preserving exact line count", async () => {
        await warmGenericGrammars(["luau"]);
        const src = [
            "--!strict",
            "const MAX_ITEMS = 100",
            "export type Option<T> =",
            "\t| { kind: 'some', value: T }",
            "\t| { kind: 'none' }",
            "@[native, checked]",
            "local function compute<T...>(items: { [number]: string, count: number }, ...: T...): number",
            "\tlocal x = (1 + 2) :: number",
            "\treturn x + MAX_ITEMS",
            "end",
            "return { compute = compute }",
        ].join("\n");

        const norm = normalizeLuauForParse(src);
        assert.equal(norm.split("\n").length, src.split("\n").length, "line count must be preserved");
        const ex = extractGeneric("src/Modern.luau", src);
        assert.ok(ex);
        assert.ok(ex.nodes.some((n) => n.name.includes("compute")));
    });
});

describe("Luau / Roblox Graph Indexing, Querying, Viz & MCP", () => {
    it("indexes a Rojo + .luaurc Luau repository (barrels, DI loaders, :GetChildren() factories) and answers ask, grep, callers, skeleton, map, viz, and MCP", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-luau-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            writeFileSync(
                join(tmp, "default.project.json"),
                JSON.stringify({
                    name: "TestProject",
                    tree: {
                        $path: "src",
                    },
                }),
            );
            writeFileSync(
                join(tmp, ".luaurc"),
                JSON.stringify({
                    aliases: {
                        shared: "src/Shared",
                    },
                }),
            );

            mkdirSync(join(tmp, "src", "Shared", "Util"), { recursive: true });
            mkdirSync(join(tmp, "src", "Commands"), { recursive: true });
            mkdirSync(join(tmp, "src", "Widgets", "Components"), { recursive: true });

            writeFileSync(
                join(tmp, "src", "init.luau"),
                [
                    "local Shared = script:WaitForChild('Shared')",
                    "local App = {",
                    "\tscript = script,",
                    "\tShared = Shared,",
                    "\tUtil = require(Shared:WaitForChild('Util')),",
                    "\tValidate = require(Shared:WaitForChild('Validate')),",
                    "}",
                    "return App",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Widgets", "Components", "Modal.luau"),
                [
                    "local Modal = {}",
                    "function Modal.new(props)",
                    "\treturn props",
                    "end",
                    "return Modal",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Widgets", "init.luau"),
                [
                    "local Widgets = { registry = {} }",
                    "function Widgets.registerAll()",
                    "\tfor _, child in script.Components:GetChildren() do",
                    "\t\tWidgets.registry[child.Name] = require(child)",
                    "\tend",
                    "end",
                    "function Widgets.new(className: string)",
                    "\treturn Widgets.registry[className].new",
                    "end",
                    "return Widgets",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Shared", "Validate.luau"),
                [
                    "local Validate = {}",
                    "export type ValidationResult = { ok: boolean, reason: string? }",
                    "function Validate.check(input: any): ValidationResult",
                    "\tif type(input) ~= 'string' then",
                    "\t\treturn { ok = false, reason = 'expected string' }",
                    "\tend",
                    "\treturn { ok = true }",
                    "end",
                    "return Validate",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Shared", "Util", "Table.luau"),
                [
                    "local Table = {}",
                    "function Table.freezeDeep(t: { [any]: any })",
                    "\treturn table.freeze(t)",
                    "end",
                    "return Table",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Shared", "Util", "init.luau"),
                [
                    "local Table = require(script.Table)",
                    "return {",
                    "\tTable = Table,",
                    "}",
                ].join("\n"),
            );

            writeFileSync(
                join(tmp, "src", "Commands", "Kick.luau"),
                [
                    "local Validate = require('@shared/Validate')",
                    "local Util = require(script.Parent.Parent.Shared.Util)",
                    "local Widgets = require(script.Parent.Parent.Widgets)",
                    "return function(app)",
                    "\tlocal Shared = app.Shared",
                    "\tlocal ExtraValidate = require(Shared.Validate)",
                    "\tfunction app.kickPlayer(ctx, target)",
                    "\t\tlocal res = Validate.check(target)",
                    "\t\tExtraValidate.check(target)",
                    "\t\tapp.Util.Table.freezeDeep(res)",
                    "\t\tctx.Validate.check(target)",
                    "\t\tWidgets.new 'Modal' { title = 'Kicked' }",
                    "\t\treturn res.ok",
                    "\tend",
                    "end",
                ].join("\n"),
            );

            const res = await buildGraph(tmp);
            assert.ok(res.nodes > 0);
            assert.ok(res.edges > 0);
            assert.ok(res.languages.includes("luau"));

            // Check freshness
            const chk = await checkGraph(tmp);
            assert.equal(chk.ok, true);

            // Ask
            const askRes = ask(tmp, "Validate check", { source: true });
            assert.ok(askRes.hits.length > 0);
            assert.ok(askRes.hits.some((h) => h.pointer.includes("Validate.luau")));
            assert.ok(askRes.hits[0].code);

            // Skeleton
            const skel = skeleton(tmp, "Validate.luau");
            assert.equal(skel.file, "src/Shared/Validate.luau");
            assert.ok(skel.entries.some((e) => e.name.includes("check")));

            // Load graph and grep
            const graph = loadGraphCached(join(tmp, "plexer"));
            assert.ok(graph);
            const grepRes = grepGraph(graph, tmp, "freezeDeep", { fixed: true });
            assert.ok(grepRes.groups.length > 0);

            // Callers (Validate.check, barrel-prefixed App.Validate.check, DI-routed Table.freezeDeep, and :GetChildren() factory Modal.new)
            const targets = resolveSymbol(graph, "App.Validate.check");
            assert.ok(targets.length > 0);
            const walk = edgeWalk(graph, targets[0], "in", 2);
            assert.ok(walk.some((s) => s.node.path.includes("Kick.luau")));

            const tableTargets = resolveSymbol(graph, "Table.freezeDeep");
            assert.ok(tableTargets.length > 0);
            const tableWalk = edgeWalk(graph, tableTargets[0], "in", 2);
            assert.ok(tableWalk.some((s) => s.node.id.includes("Kick.luau#kickPlayer")));

            const modalTargets = resolveSymbol(graph, "Modal.new");
            assert.ok(modalTargets.length > 0);
            const modalWalk = edgeWalk(graph, modalTargets[0], "in", 2);
            assert.ok(modalWalk.some((s) => s.node.id.includes("Kick.luau#kickPlayer")));

            // Repo map
            const map = buildRepoMap(graph);
            assert.ok(map.dirs.length > 0);

            // Viz export
            const vizDir = join(tmp, "viz-out");
            const viewerDir = new URL("../src/viewer/", import.meta.url).pathname;
            const exported = exportViz({
                contextDir: join(tmp, "plexer"),
                viewerDir,
                outDir: vizDir,
                repoName: "TestProject",
            });
            assert.ok(existsSync(exported.file));
            const html = readFileSync(exported.file, "utf8");
            assert.ok(html.includes("TestProject"));
            assert.ok(html.includes("graph-canvas"));
            assert.ok(!html.includes("symbol-limit-select"));
            assert.ok(html.includes("insp-source-box"));
            assert.ok(html.includes("insp-hops"));
            const ctxMatch = html.match(/contextGraph:\s*(\{.*?\}),\n\s*codeGraph:\s*(\{.*?\})\n\};<\/script>/);
            assert.ok(ctxMatch, "exported HTML must embed window.__PLEXER_DATA__ JSON");
            const contextGraph = JSON.parse(ctxMatch[1]);
            const codeGraph = JSON.parse(ctxMatch[2]);
            assert.equal(contextGraph.meta.repoName, "TestProject");
            assert.equal(contextGraph.meta.defaultTab, "code");
            assert.ok(Array.isArray(codeGraph?.nodes) && codeGraph.nodes.length > 0);
            assert.deepEqual(contextGraph.nodes, []);

            // Viz live server (/api/source excerpt + L-prefixed span + path-jail guard)
            const { startVizServer } = await import("../src/viz/serve.js");
            const srv = await startVizServer({
                root: tmp,
                contextDir: join(tmp, "plexer"),
                viewerDir,
                port: 4580,
                repoName: "TestProject",
            });
            try {
                const srcRes = await fetch(`${srv.url}/api/source?path=src/Shared/Validate.luau&span=3-8`);
                assert.equal(srcRes.status, 200);
                const srcJson = await srcRes.json();
                assert.equal(srcJson.startLine, 3);
                assert.ok(srcJson.lines.some((l) => l.text.includes("Validate.check")));

                const lSpanRes = await fetch(`${srv.url}/api/source?path=src/Shared/Validate.luau&span=L3-L8`);
                assert.equal(lSpanRes.status, 200);
                const lSpanJson = await lSpanRes.json();
                assert.equal(lSpanJson.startLine, 3);
                assert.equal(lSpanJson.endLine, 8);
                assert.equal(lSpanJson.spanEndLine, 8);

                const forbidden = await fetch(`${srv.url}/api/source?path=../../etc/passwd`);
                assert.equal(forbidden.status, 403);
            } finally {
                await srv.close();
            }

            // MCP tool calls
            const mcpMap = await callTool(tmp, "plexer_repo_map", {});
            assert.ok(!mcpMap.isError);
            assert.ok(mcpMap.text.includes("Validate.luau") || mcpMap.text.includes("src/"));

            const mcpCalls = await callTool(tmp, "plexer_trace_calls", {
                symbol: "Validate.check",
                direction: "in",
            });
            assert.ok(!mcpCalls.isError);
            assert.ok(mcpCalls.text.includes("Kick.luau"));

            // Ensure runRetract never deletes SKILL.md through a symlinked skill directory
            const { symlinkSync } = await import("node:fs");
            const { runRetract } = await import("../src/hosts/retract.js");
            const fakeHome = join(tmp, "fake-home");
            mkdirSync(join(fakeHome, ".gemini", "skills"), { recursive: true });
            const fakePkg = join(tmp, "fake-pkg");
            mkdirSync(fakePkg, { recursive: true });
            writeFileSync(join(fakePkg, "SKILL.md"), "# test skill\n");
            symlinkSync(fakePkg, join(fakeHome, ".gemini", "skills", "plexer"));
            runRetract(tmp, { home: fakeHome, apply: true, global: true, cache: false });
            assert.equal(existsSync(join(fakePkg, "SKILL.md")), true, "SKILL.md inside symlinked skill repo must never be deleted");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe("Tokenization, Stemming, Doc Summaries, Crux Synthesis & Symbol Resolution", () => {
    it("splits acronyms and stems morphological variants deterministically", async () => {
        const { tokenize, stemToken } = await import("../src/ask/index-file.js");
        const toks = tokenize("HTMLParser parseJSONURL camelCase");
        assert.deepEqual(toks, ["html", "parser", "parse", "jsonurl", "camel", "case"]);
        assert.equal(stemToken("validating"), stemToken("validate"));
        assert.equal(stemToken("permissions"), stemToken("permission"));
        assert.equal(stemToken("identifiers"), stemToken("identifier"));
    });

    it("extracts leading doc comments into node.summary across TS, Python, Rust, and Luau", async () => {
        await warmDepthGrammars();
        await warmGenericGrammars(["rust", "luau"]);

        const ts = extractFile(
            "src/doc.ts",
            "/** Computes a bounded residual score for ranking. */\nexport function scoreBounded(x: number): number {\n  return x;\n}\n",
        );
        const tsFn = ts.nodes.find((n) => n.name === "scoreBounded");
        assert.ok(tsFn?.summary?.includes("Computes a bounded residual score"));

        const py = extractFile(
            "pkg/doc.py",
            "def validate_token(raw: str) -> bool:\n    \"\"\"Verify cryptographic signature and expiry.\"\"\"\n    return bool(raw)\n",
        );
        const pyFn = py.nodes.find((n) => n.name === "validate_token");
        assert.ok(pyFn?.summary?.includes("Verify cryptographic signature"));

        const rs = extractGeneric(
            "src/doc.rs",
            "/// Resolves wire layout bitwidths across schema definitions.\npub fn resolve_layout(x: u32) -> u32 {\n    x + 1\n}\n",
        );
        const rsFn = rs.nodes.find((n) => n.name === "resolve_layout");
        assert.ok(rsFn?.summary?.includes("Resolves wire layout bitwidths"));

        const luau = extractGeneric(
            "src/Doc.luau",
            "local Doc = {}\n--- Checks whether the player has admin rank permission.\nfunction Doc:hasPermission(player: any): boolean\n\treturn true\nend\nreturn Doc\n",
        );
        const luauFn = luau.nodes.find((n) => n.name.includes("hasPermission"));
        assert.ok(luauFn?.summary?.includes("Checks whether the player has admin rank permission"));
    });

    it("inlines contiguous source for <=35-line top hits, emits explicit omitted-line markers on >35-line symbols, supports --full, and deduplicates formatSkeleton", async () => {
        const { formatSkeleton } = await import("../src/ask/ask.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-opt-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            mkdirSync(join(tmp, "src"), { recursive: true });
            const shortLines = ["export function verifyShortToken(input: string): string {"];
            for (let i = 1; i <= 12; i++) {
                shortLines.push(`  const part${i} = input.trim();`);
            }
            shortLines.push("  return part12;");
            shortLines.push("}");

            const bodyLines = ["export function processTransaction(input: string): string {"];
            for (let i = 1; i <= 90; i++) {
                if (i === 42)
                    bodyLines.push("  const verifiedSignature = verifyCryptographicHmac(input);");
                else
                    bodyLines.push(`  const step${i} = input.trim();`);
            }
            bodyLines.push("  return verifiedSignature;");
            bodyLines.push("}");
            writeFileSync(join(tmp, "src", "tx.ts"), [...shortLines, "", ...bodyLines].join("\n") + "\n");
            writeFileSync(
                join(tmp, "src", "Auth.luau"),
                "local Auth = {}\nfunction Auth:checkRank(user: any): boolean\n\treturn true\nend\nreturn Auth\n",
            );

            await buildGraph(tmp);

            // 1. Short function (<=35 lines) is inlined 100% contiguously
            const shortAsk = ask(tmp, "verifyShortToken", { source: true });
            assert.ok(shortAsk.hits[0].code.includes("L1: export function verifyShortToken"));
            assert.ok(shortAsk.hits[0].code.includes("L15: }"));
            assert.ok(!shortAsk.hits[0].code.includes("omitted"), "short <=35-line function must not omit interior lines");

            // 2. Long function (>35 lines) emits windowed excerpt with explicit omitted-line markers
            const compact = ask(tmp, "validating cryptographic hmac signature", { source: true });
            assert.ok(compact.hits.length > 0);
            assert.ok(compact.hits[0].code.includes("verifyCryptographicHmac"));
            assert.ok(compact.hits[0].code.includes("omitted)"), "long function excerpt must include explicit omitted-line markers");
            assert.ok(compact.hits[0].code.includes("excerpt of"));

            const full = ask(tmp, "validating cryptographic hmac signature", { source: true, full: true });
            const fullLines = full.hits[0].code.split("\n");
            assert.ok(fullLines.length >= 45, `expected full span >=45 lines, got ${fullLines.length}`);

            // 3. formatSkeleton does not emit duplicate exports (N): header
            const skelText = formatSkeleton(skeleton(tmp, "src/tx.ts"));
            assert.ok(!skelText.includes("exports ("), "formatSkeleton must not duplicate exported names in a top header");
            assert.ok(skelText.includes("processTransaction"));

            // resolveSymbol with path:symbol and Class:method
            const graph = loadGraphCached(join(tmp, "plexer"));
            const byPathSym = resolveSymbol(graph, "src/tx.ts:processTransaction");
            assert.equal(byPathSym.length, 1);
            assert.equal(byPathSym[0].name, "processTransaction");

            const byColonMethod = resolveSymbol(graph, "Auth:checkRank");
            assert.equal(byColonMethod.length, 1);
            assert.ok(byColonMethod[0].name.includes("checkRank"));

            // grepGraph per-symbol hit cap
            const grepCapped = grepGraph(graph, tmp, "step", { fixed: true, maxHitsPerSymbol: 4 });
            assert.equal(grepCapped.groups.length, 1);
            assert.equal(grepCapped.groups[0].hits.length, 4);
            assert.ok(grepCapped.groups[0].omittedHits > 15);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe("Regressions: Cards, Build Config, Diff Parsing, Extensions, Programmatic API & Host Flags", () => {
    it("persists build config inside plexer/.cache/config.json without creating .plexer/ and detects Claude Code via directory presence", async () => {
        const { patchBuildConfig, readBuildConfig, buildConfigPath } = await import("../src/util/state.js");
        const { planInit } = await import("../src/hosts/plan.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-cfg-plan-test-"));
        const fakeHome = mkdtempSync(join(tmpdir(), "plexer-home-test-"));
        try {
            patchBuildConfig(tmp, { includeDirs: ["vendor", "packages"] });
            assert.equal(existsSync(join(tmp, ".plexer")), false, "must not create a separate .plexer directory");
            assert.equal(buildConfigPath(tmp), join(tmp, "plexer", ".cache", "config.json"));
            assert.deepEqual(readBuildConfig(tmp)?.includeDirs, ["vendor", "packages"]);

            const planWithoutClaude = planInit(tmp, { home: fakeHome });
            const claudeAbsent = planWithoutClaude.find((h) => h.id === "claude");
            assert.equal(claudeAbsent?.detected, false, "Claude Code must not be detected when neither ~/.claude nor <repo>/.claude exists");

            mkdirSync(join(fakeHome, ".claude"), { recursive: true });
            const planWithClaude = planInit(tmp, { home: fakeHome });
            const claudePresent = planWithClaude.find((h) => h.id === "claude");
            assert.equal(claudePresent?.detected, true, "Claude Code must be detected when ~/.claude exists");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
            rmSync(fakeHome, { recursive: true, force: true });
        }
    });

    it("parses git diffs with mnemonic prefixes (w/, c/, i/) and ++ body lines without corrupting file paths", async () => {
        const { applyHunks } = await import("../src/blast/diff.js");
        const files = [{ path: "src/foo.js", status: "modified", ranges: [], hunks: [] }];
        const rawDiff = [
            "diff --git i/src/foo.js w/src/foo.js",
            "index 1111111..2222222 100644",
            "--- i/src/foo.js",
            "+++ w/src/foo.js",
            "@@ -10,0 +11,3 @@",
            "+const x = 1;",
            "+++ header lookalike inside hunk",
            "+const y = 2;",
        ].join("\n");
        applyHunks(files, rawDiff);
        assert.equal(files[0].ranges.length, 1);
        assert.deepEqual(files[0].ranges[0], { start: 11, end: 13 });
        assert.equal(files[0].hunks[0].lines.length, 3);
    });

    it("orders card symbols by line number, filters extensions end-to-end, and supports Plexer & blastRadius(dir) contracts", async () => {
        const { blastRadius } = await import("../src/index.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-reg-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
            execFileSync("git", ["config", "user.name", "Test"], { cwd: tmp });
            mkdirSync(join(tmp, "src"), { recursive: true });
            writeFileSync(
                join(tmp, "src", "order.ts"),
                [
                    "export function earlyFn(): number {",
                    "  return 1;",
                    "}",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "export function lateFn(): number {",
                    "  return earlyFn() + 1;",
                    "}",
                ].join("\n") + "\n",
            );
            writeFileSync(join(tmp, "src", "ignored.py"), "def should_ignore():\n    return 42\n");

            const engine = new Plexer();
            const buildRes = await engine.graph(tmp, { extensions: [".ts"], cards: true });
            assert.ok(buildRes.languages.includes("typescript"));
            assert.ok(!buildRes.languages.includes("python"), "extensions filter must exclude .py files");
            assert.equal(buildRes.files, 1);

            // Warm build with extensions filter must reuse cached file without re-parsing
            const warmRes = await engine.graph(tmp, { extensions: [".ts"], cards: true });
            assert.equal(warmRes.parsed, 0);
            assert.equal(warmRes.reused, 1);

            // Check card symbol ordering (earlyFn L1-L3 before lateFn L9-L11)
            const cardText = readFileSync(join(tmp, "plexer", "src", "order.md"), "utf8");
            const earlyIdx = cardText.indexOf("earlyFn");
            const lateIdx = cardText.indexOf("lateFn");
            assert.ok(earlyIdx > 0 && lateIdx > earlyIdx, "earlyFn (L1) must appear before lateFn (L9) in wiring card");

            // Programmatic Plexer methods + blastRadius(dir) overload
            const skel = engine.skeleton(tmp, "order.ts");
            assert.equal(skel.file, "src/order.ts");
            const callers = engine.callers(tmp, "earlyFn");
            assert.ok(callers[0]?.hits.some((c) => c.node.name === "lateFn"));
            const grepRes = engine.grep(tmp, "earlyFn", { fixed: true });
            assert.ok(grepRes.groups.length > 0);
            const mapRes = engine.map(tmp);
            assert.ok(mapRes.dirs.length > 0);

            execFileSync("git", ["add", "."], { cwd: tmp });
            execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
            writeFileSync(
                join(tmp, "src", "order.ts"),
                [
                    "export function earlyFn(): number {",
                    "  return 2;",
                    "}",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "export function lateFn(): number {",
                    "  return earlyFn() + 1;",
                    "}",
                ].join("\n") + "\n",
            );
            const blast1 = blastRadius(tmp, { depth: 2 });
            assert.ok(blast1.seeds.some((s) => s.name === "earlyFn"));
            const blast2 = engine.blast(tmp, { depth: 2 });
            assert.ok(blast2.seeds.some((s) => s.name === "earlyFn"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("honors --no-mcp / --no-hooks in runInit/runHostsInit and retracts host wiring cleanly", async () => {
        const { runInit } = await import("../src/claude/init.js");
        const { runHostsInit } = await import("../src/hosts/init.js");
        const { detectHosts } = await import("../src/hosts/registry.js");
        const { runRetract } = await import("../src/hosts/retract.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-hosts-test-"));
        try {
            const fakeHome = join(tmp, "home");
            mkdirSync(join(fakeHome, ".gemini", "config"), { recursive: true });
            mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
            const detectedIds = detectHosts(fakeHome, tmp).map((h) => h.id);
            assert.equal(detectedIds.includes("antigravity"), true, "Antigravity ~/.gemini/config should detect antigravity");
            assert.equal(detectedIds.includes("gemini"), false, "Antigravity ~/.gemini/config alone must not false-trigger gemini");
            assert.equal(detectedIds.includes("copilot"), false, ".github/workflows alone must not false-trigger copilot");

            mkdirSync(join(tmp, ".claude"), { recursive: true });

            runInit(tmp, { mcp: false, hooks: false, global: false, build: false });
            runHostsInit(tmp, { agents: ["agents", "cursor"], mcp: false, hooks: false, global: false });
            assert.equal(existsSync(join(tmp, ".mcp.json")), false, "--no-mcp must not write .mcp.json");
            assert.equal(existsSync(join(tmp, ".cursor", "mcp.json")), false, "--no-mcp must not write .cursor/mcp.json");
            assert.equal(existsSync(join(tmp, ".claude", "helpers", "plexer-hooks.cjs")), false, "--no-hooks must not write plexer-hooks.cjs");
            const settingsObj = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf8"));
            assert.equal(settingsObj.hooks, undefined, "--no-hooks must not write hooks block into .claude/settings.json");
            assert.equal(existsSync(join(tmp, ".claude", "skills", "plexer", "SKILL.md")), true, "Claude skill should still be written");
            assert.equal(existsSync(join(tmp, "AGENTS.md")), true, "AGENTS.md instructions should still be written");
            assert.equal(existsSync(join(tmp, ".cursor", "rules", "plexer.mdc")), true, "Cursor rules should still be written");

            runRetract(tmp, { apply: true, global: false, cache: true });
            assert.equal(existsSync(join(tmp, "AGENTS.md")), false, "AGENTS.md with only plexer section must be retracted");
            assert.equal(existsSync(join(tmp, ".cursor", "rules", "plexer.mdc")), false, "Cursor rule file must be retracted");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("detects same-size/same-mtime edits in checkGraph, invalidates on .luaurc changes, and handles Luau table alias exports accurately", async () => {
        const { utimesSync, lstatSync } = await import("node:fs");
        const { extractLuau } = await import("../src/graph/luau.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-cache-luau-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            mkdirSync(join(tmp, "src", "lib"), { recursive: true });
            const targetPath = join(tmp, "src", "lib", "val.luau");
            writeFileSync(targetPath, "local M = {}\nfunction M.run()\n\treturn 1\nend\nreturn M\n");
            writeFileSync(
                join(tmp, "src", "main.luau"),
                'local Val = require("@pkg/val")\nlocal M = {}\nfunction M.start()\n\treturn Val.run()\nend\nreturn M\n',
            );
            writeFileSync(join(tmp, ".luaurc"), JSON.stringify({ aliases: { pkg: "src/other" } }));

            await buildGraph(tmp);
            const gBefore = JSON.parse(readFileSync(join(tmp, "plexer", ".graph", "wiring.json"), "utf8"));
            assert.equal(
                gBefore.edges.some((e) => e.source.includes("main.luau") && e.target.includes("val.luau")),
                false,
                "alias points to src/other initially",
            );

            // Update .luaurc alias without touching source files: buildGraph must not skip via noSourceChanges
            writeFileSync(join(tmp, ".luaurc"), JSON.stringify({ aliases: { pkg: "src/lib" } }));
            const rebuildRes = await buildGraph(tmp);
            assert.equal(rebuildRes.skipped, undefined, ".luaurc change must invalidate config_hash");
            const gAfter = JSON.parse(readFileSync(join(tmp, "plexer", ".graph", "wiring.json"), "utf8"));
            assert.equal(
                gAfter.edges.some((e) => e.source.includes("main.luau") && e.target.includes("val.luau")),
                true,
                "updated .luaurc alias must resolve cross-file edge",
            );

            // Same-size + same-mtime edit must still be caught by checkGraph (trustStat: false)
            const st = lstatSync(targetPath);
            writeFileSync(targetPath, "local M = {}\nfunction M.run()\n\treturn 2\nend\nreturn M\n");
            utimesSync(targetPath, st.atime, st.mtime);
            const chk = await checkGraph(tmp);
            assert.equal(chk.ok, false, "checkGraph must hash content and detect same-size/same-mtime edit");

            // Luau table field aliasing vs nested local shadowing
            const luauSrc = [
                "local M = {}",
                "local function internalImpl(x)",
                "\treturn x + 1",
                "end",
                "function M.outer()",
                "\tlocal shadowed = function() return 0 end",
                "\treturn shadowed()",
                "end",
                "M.publicAlias = internalImpl",
                "M.other = shadowed",
                "return M",
            ].join("\n");
            const ext = extractGeneric("src/alias.luau", luauSrc);
            const pubAlias = ext.nodes.find((d) => d.name === "publicAlias");
            assert.ok(pubAlias && pubAlias.exported, "module-scope alias M.publicAlias = internalImpl must mint exported symbol");
            const shadowedDef = ext.nodes.find((d) => d.name === "shadowed");
            assert.equal(shadowedDef?.exported ?? false, false, "nested local function must not be marked exported");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("handles root-level file cards, path-disambiguated blast radius, and sessionPath sanitization", async () => {
        const { sessionPath } = await import("../src/util/state.js");
        const { formatBlastRadius } = await import("../src/claude/format.js");
        const { exportViz } = await import("../src/viz/export.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-rootcard-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            mkdirSync(join(tmp, "src", "sub"), { recursive: true });
            writeFileSync(join(tmp, "index.ts"), "export function rootEntry(): number { return 1; }\n");
            writeFileSync(
                join(tmp, "src", "caller.ts"),
                'import { rootEntry } from "../index";\nexport function callRoot(): number { return rootEntry(); }\n',
            );
            writeFileSync(join(tmp, "src", "sub", "index.ts"), "export function subEntry(): number { return 2; }\n");

            await buildGraph(tmp, { cards: true });
            assert.equal(existsSync(join(tmp, "plexer", "index.md")), true, "root index.ts card exists");

            // Editing src/sub/index.ts must not report callers of root index.ts
            const w = JSON.parse(readFileSync(join(tmp, "plexer", ".graph", "wiring.json"), "utf8"));
            const subBr = formatBlastRadius(w, join(tmp, "src", "sub", "index.ts"), 8, tmp);
            assert.equal(subBr, null, "src/sub/index.ts has no callers and must not match root index.ts");
            const rootBr = formatBlastRadius(w, join(tmp, "index.ts"), 8, tmp);
            assert.ok(rootBr && rootBr.includes("callRoot"), "root index.ts blast radius includes callRoot");

            // Deleting root index.ts and rebuilding must prune plexer/index.md
            rmSync(join(tmp, "index.ts"));
            await buildGraph(tmp, { cards: true });
            assert.equal(existsSync(join(tmp, "plexer", "index.md")), false, "stale root-level file card must be pruned");

            // sessionPath sanitization
            const sp = sessionPath(tmp, "../../etc/passwd");
            assert.ok(sp.startsWith(join(tmp, "plexer", ".cache")), "sessionPath must stay inside .cache");

            // exportViz with tabs: ["code"] omits contextGraph and sets defaultTab: "code"
            const viewerDir = new URL("../src/viewer/", import.meta.url).pathname;
            const vizOut = exportViz({
                contextDir: join(tmp, "plexer"),
                viewerDir,
                outDir: join(tmp, "viz-out"),
                repoName: "test",
                tabs: ["code"],
            });
            assert.equal(vizOut.defaultTab, "code");
            assert.equal(vizOut.contextNodes, 0);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports workspace federation (skeleton, partial --in, missing child check), blast co-extensive spans & base validation, and owner email exclusion", async () => {
        const { federateSkeleton, federateGrep, federateCheck, writeWorkspace } = await import("../src/graph/workspace.js");
        const { ownersFor } = await import("../src/blast/owners.js");
        const { blastRadius } = await import("../src/blast/blast.js");
        const tmp = mkdtempSync(join(tmpdir(), "plexer-ws-blast-test-"));
        try {
            const pkgA = join(tmp, "pkg-a");
            const pkgB = join(tmp, "pkg-b");
            mkdirSync(join(pkgA, "src", "onlyA"), { recursive: true });
            mkdirSync(join(pkgB, "src"), { recursive: true });
            execFileSync("git", ["init", "-q"], { cwd: pkgA });
            execFileSync("git", ["init", "-q"], { cwd: pkgB });
            writeFileSync(join(pkgA, "src", "onlyA", "a.ts"), "export function alpha(x: number): number { return x + 1; }\n");
            writeFileSync(join(pkgB, "src", "b.ts"), "export function beta(): number { return 2; }\n");

            await buildGraph(pkgA);
            await buildGraph(pkgB);
            writeWorkspace(tmp, { version: 1, children: ["pkg-a", "pkg-b"] });

            // Federated skeleton + MCP plexer_file_api
            const skel = federateSkeleton(tmp, undefined, "pkg-a/src/onlyA/a.ts");
            assert.equal(skel.file, "pkg-a/src/onlyA/a.ts");
            assert.equal(skel.entries.length, 1);
            const mcpSkel = await callTool(tmp, "plexer_file_api", { file: "pkg-a/src/onlyA/a.ts" });
            assert.equal(mcpSkel.isError, false);
            assert.ok(mcpSkel.text.includes("alpha"));

            // Federated grep with --in existing only in pkg-a must not throw on pkg-b
            const fg = federateGrep(tmp, undefined, "alpha", { in: "src/onlyA" });
            assert.equal(fg.result.totalHits, 1);

            // Federated check when pkg-b graph is removed reports ok: false
            rmSync(join(pkgB, "plexer"), { recursive: true, force: true });
            const fc = await federateCheck(tmp, undefined);
            assert.equal(fc.ok, false);
            assert.deepEqual(fc.missing, ["pkg-b"]);

            // Co-extensive symbol spans in blastRadius must keep both symbols instead of dropping both
            const fakeGraph = {
                nodes: [
                    { id: "file:a.ts", name: "a.ts", kind: "file", path: "src/onlyA/a.ts", span: "L1-L5" },
                    { id: "sym:1", name: "first", kind: "function", path: "src/onlyA/a.ts", span: "L1-L3" },
                    { id: "sym:2", name: "second", kind: "function", path: "src/onlyA/a.ts", span: "L1-L3" },
                ],
                edges: [],
            };
            const br = blastRadius(fakeGraph, [{ path: "src/onlyA/a.ts", status: "modified", ranges: [{ start: 1, end: 2 }] }], "working tree");
            assert.equal(br.seeds.filter((s) => !s.wholeFile).length, 2, "co-extensive spans must not cancel each other out");

            // Invalid base ref in blastRadius(dir, { base }) must throw
            assert.throws(
                () => blastRadius(pkgA, { base: "nonexistent-ref-xyz" }),
                /base ref "nonexistent-ref-xyz" is not in this checkout/,
            );

            // ownersFor excludes by raw email and by noreply GitHub handle
            execFileSync("git", ["config", "user.name", "Alice Dev"], { cwd: pkgA });
            execFileSync("git", ["config", "user.email", "12345+alicedev@users.noreply.github.com"], { cwd: pkgA });
            execFileSync("git", ["add", "."], { cwd: pkgA });
            execFileSync("git", ["commit", "-q", "-m", "alice commit"], { cwd: pkgA });
            const ownersAll = ownersFor(pkgA, ["src/onlyA/a.ts"]);
            assert.equal(ownersAll.length, 1);
            const ownersExcludedByEmail = ownersFor(pkgA, ["src/onlyA/a.ts"], {
                exclude: ["12345+alicedev@users.noreply.github.com"],
            });
            assert.equal(ownersExcludedByEmail.length, 0, "noreply email in exclude list must match handle-keyed owner");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("enforces disjoint tier extensions, labels breadth/container languages in buildRepoMap, and resolves package version", async () => {
        const { depthExtensions, languageLabelOf } = await import("../src/graph/extract.js");
        const { genericExtensions } = await import("../src/graph/generic.js");
        const { containerExtensions } = await import("../src/graph/container.js");
        const { readCurrentVersion } = await import("../src/cli-meta.js");
        const { isPlexerAllowEntry } = await import("../src/claude/settings-merge.js");

        const depthSet = new Set(depthExtensions());
        for (const ext of genericExtensions()) {
            assert.equal(depthSet.has(ext), false, `generic extension ${ext} must not collide with depth tier`);
        }
        for (const ext of containerExtensions()) {
            assert.equal(depthSet.has(ext), false, `container extension ${ext} must not collide with depth tier`);
        }

        assert.equal(languageLabelOf("src/lib.rs"), "rust");
        assert.equal(languageLabelOf("src/util.c"), "c");
        assert.equal(languageLabelOf("src/App.vue"), "vue");
        assert.equal(languageLabelOf("src/Main.luau"), "luau");

        const map = buildRepoMap({
            nodes: [
                { id: "src/lib.rs", name: "lib.rs", kind: "file", path: "src/lib.rs", span: "L1-L10" },
                { id: "src/App.vue", name: "App.vue", kind: "file", path: "src/App.vue", span: "L1-L20" },
            ],
            edges: [],
        });
        assert.deepEqual(map.totals.languages, ["rust", "vue"]);

        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        assert.equal(readCurrentVersion(), pkg.version);
        assert.equal(isPlexerAllowEntry("Bash(npx @plexer/cli:*)"), true);
    });

    it("supports skeleton multi-match mode (opts.allMatches, formatSkeleton, and CLI --all-matches)", async () => {
        const { formatSkeleton } = await import("../src/ask/ask.js");
        const cliPath = new URL("../bin/plexer.js", import.meta.url).pathname;
        const tmp = mkdtempSync(join(tmpdir(), "plexer-skel-multi-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            mkdirSync(join(tmp, "src", "alpha"), { recursive: true });
            mkdirSync(join(tmp, "src", "beta"), { recursive: true });
            mkdirSync(join(tmp, "src", "unique"), { recursive: true });
            writeFileSync(
                join(tmp, "src", "alpha", "handler.ts"),
                [
                    "export function handleAlphaFirst(): number {",
                    "  return 1;",
                    "}",
                    "",
                    "export function handleAlphaSecond(): number {",
                    "  return 2;",
                    "}",
                ].join("\n") + "\n",
            );
            writeFileSync(
                join(tmp, "src", "beta", "handler.ts"),
                [
                    "export function handleBeta(): string {",
                    "  return 'beta';",
                    "}",
                ].join("\n") + "\n",
            );
            writeFileSync(
                join(tmp, "src", "unique", "solo.ts"),
                "export function soloFn(): void {}\n",
            );

            await buildGraph(tmp);

            // Default (allMatches falsy) returns error when ambiguous
            const ambig = skeleton(tmp, "handler.ts");
            assert.ok(ambig.error?.includes('ambiguous path "handler.ts"'));
            assert.ok(ambig.error?.includes("src/alpha/handler.ts"));
            assert.ok(ambig.error?.includes("src/beta/handler.ts"));

            // allMatches truthy on ambiguous query returns { files, entries }
            const multi = skeleton(tmp, "handler.ts", { allMatches: true });
            assert.deepEqual(multi.files, ["src/alpha/handler.ts", "src/beta/handler.ts"]);
            assert.equal(multi.file, undefined);
            assert.deepEqual(
                multi.entries.map((e) => `${e.file}:${e.name}`),
                [
                    "src/alpha/handler.ts:handleAlphaFirst",
                    "src/alpha/handler.ts:handleAlphaSecond",
                    "src/beta/handler.ts:handleBeta",
                ],
            );

            // Single match with allMatches truthy preserves { file, entries }
            const single = skeleton(tmp, "solo.ts", { allMatches: true });
            assert.equal(single.file, "src/unique/solo.ts");
            assert.equal(single.files, undefined);
            assert.equal(single.entries.length, 1);
            assert.equal(single.entries[0].file, "src/unique/solo.ts");

            // formatSkeleton formats multi-file result with per-file headers separated by blank line
            const formatted = formatSkeleton(multi);
            assert.ok(formatted.includes("src/alpha/handler.ts — skeleton (2 symbols)"));
            assert.ok(formatted.includes("src/beta/handler.ts — skeleton (1 symbols)"));
            assert.ok(formatted.includes("\n\nsrc/beta/handler.ts — skeleton (1 symbols)\n"));

            // CLI --all-matches
            const cliOut = execFileSync(
                process.execPath,
                [cliPath, "skeleton", "handler.ts", tmp, "--all-matches", "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(cliOut.includes("src/alpha/handler.ts — skeleton (2 symbols)"));
            assert.ok(cliOut.includes("src/beta/handler.ts — skeleton (1 symbols)"));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports callers --source, multi-symbol callers, depth-2 via provenance, grep -C, and ask --source helper/constant inlining", async () => {
        const { formatAsk } = await import("../src/ask/ask.js");
        const cliPath = new URL("../bin/plexer.js", import.meta.url).pathname;
        const tmp = mkdtempSync(join(tmpdir(), "plexer-oneshot-test-"));
        try {
            execFileSync("git", ["init", "-q"], { cwd: tmp });
            mkdirSync(join(tmp, "src"), { recursive: true });
            writeFileSync(
                join(tmp, "src", "scheduler.ts"),
                [
                    "const MAX_RERUNS = 100;",
                    "",
                    "function reportRunaway(name: string): void {",
                    "  console.warn('runaway:', name);",
                    "}",
                    "",
                    "function checkGuard(count: number, name: string): boolean {",
                    "  if (count > MAX_RERUNS) {",
                    "    reportRunaway(name);",
                    "    return false;",
                    "  }",
                    "  return true;",
                    "}",
                    "",
                    "export function flushQueue(name: string, count: number): boolean {",
                    "  return checkGuard(count, name);",
                    "}",
                ].join("\n") + "\n",
            );
            writeFileSync(
                join(tmp, "src", "consumer.ts"),
                [
                    "import { flushQueue } from './scheduler';",
                    "",
                    "export function ts(): void {}",
                    "",
                    "export function runTick(): void {",
                    "  flushQueue('a', 1);",
                    "  flushQueue('b', 2);",
                    "}",
                ].join("\n") + "\n",
            );
            writeFileSync(
                join(tmp, "src", "queue.js"),
                [
                    "module.exports = function (Posts) {",
                    "  Posts.shouldQueue = async function (uid, data) {",
                    "    return Boolean(uid && data);",
                    "  };",
                    "};",
                ].join("\n") + "\n",
            );

            await buildGraph(tmp);

            // CommonJS method assignment extraction
            const queueSkel = skeleton(tmp, "src/queue.js");
            assert.ok(queueSkel.entries.some((e) => e.name === "shouldQueue" && e.kind === "method"), "CommonJS Posts.shouldQueue should be extracted as a method");

            // Lexical caller fallback and filename resolution priority over extension symbol
            const lexCallersOut = execFileSync(
                process.execPath,
                [cliPath, "callers", "MAX_RERUNS", "scheduler.ts", tmp, "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(lexCallersOut.includes("references ← checkGuard"), "lexical caller fallback should attribute MAX_RERUNS reference to enclosing checkGuard");
            assert.ok(lexCallersOut.includes("scheduler.ts · file · src/scheduler.ts"), "filename scheduler.ts should resolve to file node rather than symbol named ts");

            // ask --source prepends MAX_RERUNS and appends same-file helpers
            const askRes = ask(tmp, "runaway infinite effect loop guard during flush", { source: true });
            const askText = formatAsk(askRes);
            assert.ok(askText.includes("MAX_RERUNS = 100"), "ask --source should include referenced module-level constant");
            assert.ok(askText.includes("checkGuard"), "ask --source should include checkGuard");
            assert.ok(askText.includes("reportRunaway"), "ask --source should include reportRunaway");

            // callers --depth 2 --source and multi-symbol callers
            const callersOut = execFileSync(
                process.execPath,
                [cliPath, "callers", "reportRunaway", "flushQueue", tmp, "--depth", "2", "--source", "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(callersOut.includes("via checkGuard"), "depth-2 caller should show via checkGuard provenance");
            assert.ok(callersOut.includes("flushQueue('a', 1)"), "caller with multiple call sites should quote first call");
            assert.ok(callersOut.includes("flushQueue('b', 2)"), "caller with multiple call sites should quote second call");
            assert.ok(callersOut.includes("```"), "callers --source should inline source code blocks");

            // grep -C 1 context blocks
            const grepOut = execFileSync(
                process.execPath,
                [cliPath, "grep", "reportRunaway", tmp, "--fixed", "-C", "1", "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(grepOut.includes("if (count > MAX_RERUNS)"), "grep -C 1 should include surrounding context line");

            // CLI ask defaults to --source ON, while --no-source omits inline source blocks
            const cliAskDefault = execFileSync(
                process.execPath,
                [cliPath, "ask", "runaway infinite effect loop guard during flush", tmp, "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(cliAskDefault.includes("```"), "CLI plexer ask should inline source blocks by default");
            const cliAskNoSource = execFileSync(
                process.execPath,
                [cliPath, "ask", "runaway infinite effect loop guard during flush", tmp, "--no-source", "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(!cliAskNoSource.includes("```"), "CLI plexer ask --no-source should omit inline source blocks");

            // Programmatic ask() without opts.source remains source: false by default
            const progAskDefault = ask(tmp, "runaway infinite effect loop guard during flush");
            assert.equal(progAskDefault.hits[0].source, undefined, "programmatic ask() defaults to source: false");

            // Variadic CLI skeleton <f1> <f2>
            const multiSkelOut = execFileSync(
                process.execPath,
                [cliPath, "skeleton", "src/scheduler.ts", "src/consumer.ts", tmp, "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(multiSkelOut.includes("plexer skeleton — src/scheduler.ts"), "variadic skeleton should include first file");
            assert.ok(multiSkelOut.includes("plexer skeleton — src/consumer.ts"), "variadic skeleton should include second file");

            // Variadic and semicolon-separated CLI ask <q1> <q2> with cross-query deduplication
            const multiAskOut = execFileSync(
                process.execPath,
                [cliPath, "ask", "runaway infinite effect loop guard; consumer tick flushQueue", tmp, "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(multiAskOut.includes('plexer ask — "runaway infinite effect loop guard"'), "multi-ask should include first query section");
            assert.ok(multiAskOut.includes('plexer ask — "consumer tick flushQueue"'), "multi-ask should include second query section");
            assert.ok(multiAskOut.includes("runTick"), "multi-ask second query should surface runTick");
            assert.ok(multiAskOut.includes("call sites ("), "ask should fuse quoted call sites onto top hits");

            // CLI read <file:Lx-Ly> and <file:symbol> [...]
            const readOut = execFileSync(
                process.execPath,
                [cliPath, "read", "scheduler.ts:L7-L13", "src/consumer.ts:runTick", tmp, "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(readOut.includes("src/scheduler.ts:L7-L13"), "plexer read should resolve unique basename and span");
            assert.ok(readOut.includes("L8:   if (count > MAX_RERUNS)"), "plexer read should output L<n>: prefixed lines");
            assert.ok(readOut.includes("src/consumer.ts:L5-L8"), "plexer read should resolve file:symbol to exact symbol span");

            // MAX_CLOSURE_NODES cap on impactOfMany with maxDepth=Infinity
            const { impactOfMany, MAX_CLOSURE_NODES } = await import("../src/graph/traverse.js");
            assert.equal(MAX_CLOSURE_NODES, 100, "MAX_CLOSURE_NODES should be 100");
            const bigNodes = Array.from({ length: 151 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, kind: "function", path: "a.ts", span: "L1-L2" }));
            const bigEdges = [];
            for (let i = 0; i < 150; i++) {
                bigEdges.push({ source: `n${i + 1}`, target: `n${i}`, relation: "calls" });
            }
            const closureHits = impactOfMany({ nodes: bigNodes, edges: bigEdges }, [bigNodes[0]], Infinity, "in");
            assert.equal(closureHits.length, MAX_CLOSURE_NODES, "impactOfMany with Infinity depth should cap at MAX_CLOSURE_NODES");

            // formatOrientation never dumps INDEX.md prose
            const { formatOrientation } = await import("../src/claude/format.js");
            const orient = formatOrientation("# Big Index\n" + "x".repeat(2000), 1200);
            assert.ok(!orient.includes("# Big Index"), "formatOrientation should omit INDEX.md prose");
            assert.ok(orient.length < 300, "formatOrientation should remain compact");

            // distillPromptQueries strips Steps to reproduce before splitting numbered lists
            const { distillPromptQueries } = await import("../src/claude/hooks.js");
            const { readSession } = await import("../src/util/state.js");
            const prPrompt = [
                "## Description",
                "Queue flushing needs a guard threshold.",
                "## Steps to Reproduce",
                "1. Open the app",
                "2. Click the button",
                "3. Wait 5 seconds",
                "## Requirements",
                "- Update `checkGuard` in `src/scheduler.ts`",
                "- Update `runTick` in `src/consumer.ts`",
            ].join("\n");
            const prQueries = distillPromptQueries(tmp, undefined, prPrompt);
            assert.ok(prQueries.some((q) => q.includes("checkGuard") || q.includes("scheduler.ts")), "distillPromptQueries should preserve Requirements after Steps to Reproduce");

            // post-edit hook deduplicates per-file blast radius within a session
            const hookPayload = JSON.stringify({
                session_id: "dedup-test-session",
                cwd: tmp,
                tool_input: { file_path: join(tmp, "src", "scheduler.ts") },
            });
            const firstPost = execFileSync(process.execPath, [cliPath, "_hook", "post-edit"], {
                input: hookPayload,
                encoding: "utf8",
            });
            const firstText = JSON.parse(firstPost).hookSpecificOutput.additionalContext;
            assert.ok(firstText.includes("scheduler.ts"), "first edit should emit blast radius");
            const secondPost = execFileSync(process.execPath, [cliPath, "_hook", "post-edit"], {
                input: hookPayload,
                encoding: "utf8",
            });
            assert.equal(secondPost.trim(), "", "second edit to same file in same session should suppress duplicate blast-radius dump");
            const sessState = readSession(tmp, "dedup-test-session");
            assert.ok(sessState.emittedBlastFiles.includes("scheduler.ts"));

            // Variadic CLI grep with default -C 2 context
            const multiGrepOut = execFileSync(
                process.execPath,
                [cliPath, "grep", "reportRunaway", "flushQueue", tmp, "--fixed", "--no-refresh"],
                { encoding: "utf8" },
            );
            assert.ok(multiGrepOut.includes("if (count > MAX_RERUNS)"), "plexer grep should include -C 2 context by default");
            assert.ok(multiGrepOut.includes('"flushQueue" —'), "variadic plexer grep should run second pattern");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});



