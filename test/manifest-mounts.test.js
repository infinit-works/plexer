import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ask } from "../src/ask/ask.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { probeDrift } from "../src/graph/fingerprint.js";
import { reachable } from "../src/graph/languages.js";
import { discoverManifestMounts } from "../src/graph/manifest-mounts.js";
import { resolveSymbol } from "../src/context/symbol-query.js";
import { health } from "../src/health/health.js";
import { walkDir } from "../src/util/fs.js";
import { readWalkConfig, readWiring } from "../src/util/state.js";

const tempDirs = [];
function makeTmp(prefix = "plexer-manifest-test-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeFiles(root, files) {
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(root, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content, "utf8");
    }
}

function initGitRepo(root) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe("Manifest-Driven Local Dependency Auto-Inclusion & Luau/Lua Wiring", () => {
    it("discovers Rojo nested subprojects and Skips unreferenced vendor dumps, node_modules, and gitignored .sert", () => {
        const root = makeTmp();
        const extraDumpFiles = {};
        for (let i = 0; i < 6; i++) {
            extraDumpFiles[`vendor/huge-dump/junk_${i}.luau`] = `return { n = ${i} }\n`;
        }
        const oversizedAliasFiles = {};
        for (let i = 0; i < 260; i++) {
            oversizedAliasFiles[`out/gen_${i}.luau`] = `return { i = ${i} }\n`;
        }
        writeFiles(root, {
            ".gitignore": ".sert/\n",
            "default.project.json": JSON.stringify({
                name: "demo-game",
                tree: {
                    $path: "src",
                    Flux: { $path: "vendor/flux" },
                    Z: { $path: "vendor/z" },
                    Server: {
                        $path: "src/Server",
                        Tools: {
                            $className: "Folder",
                            "Building Tools": { $path: "vendor/f3x" },
                        },
                    },
                },
            }),
            ".luaurc": JSON.stringify({
                aliases: {
                    sert: "./.sert/sert/src",
                    smalldot: "./.custom-alias/src",
                    toobig: "./out",
                },
            }),
            ".sert/sert/src/init.luau": "return {}\n",
            ".custom-alias/src/helper.luau": "local M = {} function M.ping() return 1 end return M\n",
            "node_modules/badpkg/index.js": "export const x = 1;\n",
            "src/init.luau": "return {}\n",
            "vendor/flux/default.project.json": JSON.stringify({ name: "Flux", tree: { $path: "src" } }),
            "vendor/flux/src/init.luau": "return {}\n",
            "vendor/flux/test/flux.spec.luau": "return {}\n",
            "vendor/z/default.project.json": JSON.stringify({ name: "Z", tree: { $path: "src" } }),
            "vendor/z/src/init.luau": "return {}\n",
            "vendor/f3x/default.project.json": JSON.stringify({
                name: "Building Tools",
                tree: {
                    $className: "Tool",
                    Core: { $path: "Core" },
                    SyncAPI: { SyncModule: { $path: "SyncAPI.lua" } },
                    Vendor: { Roact: { $path: "Vendor/Roact/src" } },
                },
            }),
            "vendor/f3x/Core/init.lua": "return {}\n",
            "vendor/f3x/SyncAPI.lua": "local Sync = {} return Sync\n",
            "vendor/f3x/Vendor/Roact/src/init.lua": "return {}\n",
            "vendor/f3x/Vendor/Roact/tests/roact.spec.lua": "return {}\n",
            ...extraDumpFiles,
            ...oversizedAliasFiles,
        });

        const mounts = discoverManifestMounts(root, { noCache: true });
        assert.ok(mounts.includePrefixes.includes("vendor/flux/src"));
        assert.ok(mounts.includePrefixes.includes("vendor/z/src"));
        assert.ok(mounts.includePrefixes.includes("vendor/f3x/Core"));
        assert.ok(mounts.includePrefixes.includes("vendor/f3x/Vendor/Roact/src"));
        assert.ok(mounts.includePrefixes.includes(".custom-alias/src"));
        assert.ok(mounts.exactFiles.includes("vendor/f3x/SyncAPI.lua"));
        assert.equal(mounts.includePrefixes.some((p) => p.includes("huge-dump")), false);
        assert.equal(mounts.includePrefixes.some((p) => p.includes(".sert")), false);
        assert.equal(mounts.includePrefixes.some((p) => p.includes("node_modules")), false);
        assert.equal(mounts.includePrefixes.some((p) => p === "out"), false);

        const verifyWalk = () => {
            const walkCfg = readWalkConfig(root);
            const rels = walkDir(root, walkCfg.includeDirs).map((f) => f.slice(root.length + 1).replace(/\\/g, "/"));
            assert.ok(rels.includes("src/init.luau"));
            assert.ok(rels.includes("vendor/flux/src/init.luau"));
            assert.ok(rels.includes("vendor/z/src/init.luau"));
            assert.ok(rels.includes("vendor/f3x/Core/init.lua"));
            assert.ok(rels.includes("vendor/f3x/SyncAPI.lua"));
            assert.ok(rels.includes("vendor/f3x/Vendor/Roact/src/init.lua"));
            assert.ok(rels.includes(".custom-alias/src/helper.luau"));
            assert.equal(rels.includes("vendor/flux/test/flux.spec.luau"), false);
            assert.equal(rels.some((r) => r.startsWith("vendor/huge-dump/")), false);
            assert.equal(rels.some((r) => r.startsWith(".sert/")), false);
            assert.equal(rels.some((r) => r.startsWith("node_modules/")), false);
            assert.equal(rels.some((r) => r.startsWith("out/")), false);
        };
        // Non-git filesystem walk
        verifyWalk();
        // Git-tracked repo walk
        initGitRepo(root);
        verifyWalk();
    });

    it("supports multi-ecosystem manifest auto-inclusion (TS/JS, Cargo, Go, pyproject) and manual --include-dir prefix overrides", async () => {
        // 1. TS/JS repo: tsconfig paths/references + package.json workspaces/imports/file:
        const tsRoot = makeTmp();
        writeFiles(tsRoot, {
            "tsconfig.json": JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: { "@vend/*": ["vendor/ts-lib/src/*"] },
                },
                references: [{ path: "./dist/shared-ref" }],
            }),
            "package.json": JSON.stringify({
                name: "app",
                workspaces: ["vendor/ws-pkg"],
                imports: { "#local-util": "./build/gen-util/index.ts" },
                dependencies: { "local-dep": "file:./vendor/file-dep" },
            }),
            "vendor/ts-lib/src/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
            "dist/shared-ref/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
            "dist/shared-ref/index.ts": "export const VERSION = 1;\n",
            "vendor/ws-pkg/index.ts": "export const ws = true;\n",
            "build/gen-util/index.ts": "export function genUtil() { return 42; }\n",
            "vendor/file-dep/index.ts": "export const dep = 1;\n",
            "vendor/ignored-dump/junk.ts": "export const junk = 0;\n",
        });
        const tsMounts = discoverManifestMounts(tsRoot, { noCache: true });
        assert.ok(tsMounts.includePrefixes.includes("vendor/ts-lib/src"));
        assert.ok(tsMounts.includePrefixes.includes("dist/shared-ref"));
        assert.ok(tsMounts.includePrefixes.includes("vendor/ws-pkg"));
        assert.ok(tsMounts.includePrefixes.includes("vendor/file-dep"));
        assert.ok(tsMounts.exactFiles.includes("build/gen-util/index.ts"));
        assert.equal(tsMounts.includePrefixes.some((p) => p.includes("ignored-dump")), false);

        // 2. Cargo, Go, and Python manifests
        const cargoRoot = makeTmp();
        writeFiles(cargoRoot, {
            "Cargo.toml": [
                "[workspace]",
                'members = ["vendor/my-crate"]',
                "[dependencies]",
                'local_rs = { path = "vendor/local-rs" }',
            ].join("\n"),
            "vendor/my-crate/src/lib.rs": "pub fn hi() {}\n",
            "vendor/local-rs/src/lib.rs": "pub fn loc() {}\n",
            "vendor/unused-rs/src/lib.rs": "pub fn nope() {}\n",
        });
        const cargoMounts = discoverManifestMounts(cargoRoot, { noCache: true });
        assert.ok(cargoMounts.includePrefixes.includes("vendor/my-crate"));
        assert.ok(cargoMounts.includePrefixes.includes("vendor/local-rs"));
        assert.equal(cargoMounts.includePrefixes.includes("vendor/unused-rs"), false);

        const goRoot = makeTmp();
        writeFiles(goRoot, {
            "go.mod": [
                "module example.com/app",
                "replace example.com/localgo => ./build/local-go",
            ].join("\n"),
            "build/local-go/go.go": "package localgo\nfunc Ping() {}\n",
            "vendor/modules.txt": "# example.com/vendored v0.0.0\n",
            "vendor/vendored/lib.go": "package vendored\nfunc V() {}\n",
        });
        const goMounts = discoverManifestMounts(goRoot, { noCache: true });
        assert.ok(goMounts.includePrefixes.includes("build/local-go"));
        assert.ok(goMounts.includePrefixes.includes("vendor"));

        const pyRoot = makeTmp();
        writeFiles(pyRoot, {
            "pyproject.toml": [
                "[tool.uv.sources]",
                'mylib = { path = "vendor/py-local" }',
            ].join("\n"),
            "vendor/py-local/mod.py": "def helper():\n    return 1\n",
            "vendor/ignored-py/nope.py": "def nope():\n    return 0\n",
        });
        const pyMounts = discoverManifestMounts(pyRoot, { noCache: true });
        assert.ok(pyMounts.includePrefixes.includes("vendor/py-local"));
        assert.equal(pyMounts.includePrefixes.includes("vendor/ignored-py"), false);

        // Manual relative --include-dir prefix via CLI
        const cliRoot = makeTmp();
        writeFiles(cliRoot, {
            "src/index.ts": "export const x = 1;\n",
            "vendor/manual-only/keep.ts": "export const keep = 1;\n",
            "vendor/other/skip.ts": "export const skip = 2;\n",
        });
        const cliBin = join(process.cwd(), "bin/plexer.js");
        execFileSync(process.execPath, [cliBin, "build", cliRoot, "--include-dir", "vendor/manual-only"], {
            env: { ...process.env, PLEXER_NO_DAEMON: "1" },
            stdio: "pipe",
        });
        const g = readWiring(cliRoot);
        assert.ok(g.nodes.some((n) => n.path === "vendor/manual-only/keep.ts"));
        assert.equal(g.nodes.some((n) => n.path === "vendor/other/skip.ts"), false);
    });

    it("wires Luau+Lua dependencies (table.freeze, setmetatable, __index, getfenv, Rojo instance_ref), ranking, and health isolation", async () => {
        assert.equal(reachable("src/Client/UI/init.luau", "vendor/f3x/Core/init.lua"), true);

        const root = makeTmp();
        writeFiles(root, {
            "default.project.json": JSON.stringify({
                name: "kohls-mini",
                tree: {
                    $path: "src",
                    Flux: { $path: "vendor/flux" },
                    Z: { $path: "vendor/z" },
                    Server: {
                        $path: "src/Server",
                        Tools: {
                            $className: "Folder",
                            "Building Tools": { $path: "vendor/f3x" },
                        },
                    },
                },
            }),
            "vendor/flux/default.project.json": JSON.stringify({ name: "Flux", tree: { $path: "src" } }),
            "vendor/flux/src/Async.luau": [
                "local Async = {}",
                "function Async.new(fn)",
                "  return fn",
                "end",
                "return Async",
            ].join("\n"),
            "vendor/flux/src/Graph.luau": [
                "local Graph = {}",
                "--- Reactive computed signal",
                "function Graph.computed(fn)",
                "  return fn()",
                "end",
                "function Graph.signal(v)",
                "  return v",
                "end",
                "return table.freeze(Graph)",
            ].join("\n"),
            "vendor/flux/src/init.luau": [
                'local Async = require("@self/Async")',
                'local Graph = require("@self/Graph")',
                "local FluxMT = { __call = function(_, v) return Graph.signal(v) end }",
                "local Flux = table.freeze(setmetatable({",
                "  async = Async.new,",
                "  computed = Graph.computed,",
                "  signal = Graph.signal,",
                "}, FluxMT))",
                "return Flux",
            ].join("\n"),
            "vendor/z/default.project.json": JSON.stringify({ name: "Z", tree: { $path: "src" } }),
            "vendor/z/src/init.luau": [
                "local Z = {}",
                "function Z.des(schema, buf)",
                "  return buf",
                "end",
                "return Z",
            ].join("\n"),
            "vendor/f3x/default.project.json": JSON.stringify({
                name: "Building Tools",
                tree: {
                    $className: "Tool",
                    Core: { $path: "Core" },
                    Loader: { $path: "Loader" },
                    Libraries: { $path: "Libraries" },
                },
            }),
            "vendor/f3x/Libraries/Support.lua": [
                "local Support = {}",
                "function Support.Call(fn, arg)",
                "  return fn(arg)",
                "end",
                "return Support",
            ].join("\n"),
            "vendor/f3x/Core/init.lua": [
                "local Core = getfenv(0)",
                "local Tool = script.Parent",
                "Support = require(Tool.Libraries.Support)",
                "function AssignHotkey(key, cb)",
                "  return cb(key)",
                "end",
                "function Core.Helper()",
                "  -- vendored lint bait: wait(1) should NOT pollute scored health",
                "  wait(1)",
                "  return 1",
                "end",
                "return Core",
            ].join("\n"),
            "vendor/f3x/Loader/init.lua": [
                "local Tool = script.Parent",
                "local Core = require(Tool:WaitForChild('Core'))",
                "Core.AssignHotkey('Z', Core.Support.Call)",
                "local SharedApi = require(script.Parent.Parent.Parent.Parent.Shared.ExposedToVendor)",
                "SharedApi.pingFromVendor()",
            ].join("\n"),
            "src/Shared/ExposedToVendor.luau": [
                "local Exposed = {}",
                "function Exposed.pingFromVendor()",
                "  return 1",
                "end",
                "return Exposed",
            ].join("\n"),
            "src/init.luau": [
                "local Server = script:WaitForChild('Server')",
                "local _K = {",
                "  Flux = require(script:WaitForChild('Flux')),",
                "  Z = require(script:WaitForChild('Z')),",
                "  Tools = Server and Server:WaitForChild('Tools', 5),",
                "}",
                "return _K",
            ].join("\n"),
            "src/Client/UI/init.luau": [
                "local Package = script.Parent.Parent",
                "local Flux = require(Package:WaitForChild('Flux'))",
                "local UI = {}",
                "setmetatable(UI, { __index = Flux })",
                "return UI",
            ].join("\n"),
            "src/Client/Widget.luau": [
                "local UI = require(script.Parent.UI)",
                "--- Compute widget badge layout",
                "local function computeBadge()",
                "  return UI.computed(function() return 1 end)",
                "end",
                "return { computeBadge = computeBadge }",
            ].join("\n"),
            "src/Server/Main.luau": [
                "return function(_K)",
                "  local s = _K.Flux.signal(10)",
                "  local d = _K.Z.des({}, s)",
                "  local tool = _K.Tools:WaitForChild('Building Tools', 5)",
                "  return d, tool",
                "end",
            ].join("\n"),
            "vendor/flux/src/SharedHelper.luau": [
                "local M = {}",
                "--- Render reactive badge state",
                "function M.renderBadge()",
                "  return 1",
                "end",
                "return M",
            ].join("\n"),
            "src/Shared/BadgeRenderer.luau": [
                "local M = {}",
                "--- Render reactive badge state",
                "function M.renderBadge()",
                "  return 2",
                "end",
                "return M",
            ].join("\n"),
        });

        await buildGraph(root);
        const graph = readWiring(root);

        // Dependency tags present ONLY on vendor/dependency nodes
        const fluxNodes = graph.nodes.filter((n) => n.path.startsWith("vendor/flux/"));
        const srcNodes = graph.nodes.filter((n) => n.path.startsWith("src/"));
        assert.ok(fluxNodes.length > 0);
        assert.ok(fluxNodes.every((n) => n.dependency === true));
        assert.ok(srcNodes.every((n) => n.dependency === undefined));

        // Symbol resolution & callers across src/ <-> vendor/
        const computedRes = resolveSymbol(graph, "Flux.computed");
        assert.equal(computedRes[0]?.id, "vendor/flux/src/Graph.luau#computed");

        const asyncRes = resolveSymbol(graph, "Flux.async");
        assert.equal(asyncRes[0]?.id, "vendor/flux/src/Async.luau#new");

        const cliBin = join(process.cwd(), "bin/plexer.js");
        const runCallers = (sym) =>
            execFileSync(process.execPath, [cliBin, "callers", sym, root], {
                env: { ...process.env, PLEXER_NO_DAEMON: "1" },
                encoding: "utf8",
            });

        const computedOut = runCallers("Flux.computed");
        assert.ok(
            computedOut.includes("src/Client/Widget.luau"),
            "Widget.luau calling UI.computed via __index delegation must link to vendor/flux/src/Graph.luau#computed",
        );

        const desOut = runCallers("Z.des");
        assert.ok(desOut.includes("src/Server/Main.luau"));

        const hotkeyOut = runCallers("Core.AssignHotkey");
        assert.ok(hotkeyOut.includes("vendor/f3x/Loader/init.lua"));

        assert.ok(
            graph.edges.some(
                (e) =>
                    e.source.startsWith("src/Server/Main.luau") &&
                    e.target.startsWith("vendor/f3x/") &&
                    e.relation === "references",
            ),
            "Rojo WaitForChild('Building Tools') must wire reference edge into vendor/f3x",
        );

        // Ranking: generic tie prefers first-party src/ over vendor/; explicit Flux query surfaces vendor/flux
        const genericAns = await ask(root, "renderBadge");
        const genericPtrs = (genericAns.hits ?? []).map((h) => String(h.pointer || ""));
        const firstSrcIdx = genericPtrs.findIndex((p) => p.startsWith("src/Shared/BadgeRenderer.luau"));
        const firstVenIdx = genericPtrs.findIndex((p) => p.startsWith("vendor/flux/src/SharedHelper.luau"));
        assert.ok(firstSrcIdx !== -1 && (firstVenIdx === -1 || firstSrcIdx < firstVenIdx));

        const explicitFluxAns = await ask(root, "Flux.computed");
        const explicitPtrs = (explicitFluxAns.hits ?? []).map((h) => String(h.pointer || ""));
        assert.ok(explicitPtrs.some((p) => p.startsWith("vendor/flux/src/Graph.luau")));

        // Health isolation: zero vendor issues, while vendor incoming edge keeps ExposedToVendor.pingFromVendor alive
        const scan = health(root, { action: "scan", noBudget: true });
        const allIssues = scan.open_issues ?? scan.issues ?? [];
        assert.equal(
            allIssues.some((i) => String(i.file || "").startsWith("vendor/")),
            false,
            "health scan must not emit findings for vendor/ files",
        );
        assert.equal(
            allIssues.some((i) => i.detector === "unreferenced_exports" && i.file === "src/Shared/ExposedToVendor.luau"),
            false,
            "src export called only by vendor/ file must not be flagged as unreferenced_exports",
        );
    });

    it("detects edits inside manifest-mounted vendor/ subtrees and default.project.json in probeDrift and dirty-cone rebuilds", async () => {
        const root = makeTmp();
        writeFiles(root, {
            "default.project.json": JSON.stringify({
                name: "drift-demo",
                tree: { $path: "src", Flux: { $path: "vendor/flux" } },
            }),
            "vendor/flux/default.project.json": JSON.stringify({ name: "Flux", tree: { $path: "src" } }),
            "vendor/flux/src/init.luau": "local Flux = {} function Flux.ping() return 1 end return Flux\n",
            "src/init.luau": "local Flux = require(script:WaitForChild('Flux'))\nreturn Flux.ping()\n",
        });

        await buildGraph(root);
        const outDir = join(root, "plexer");

        // Clean probe initially
        let drift = probeDrift(root, outDir);
        assert.deepEqual({ c: drift.changed, a: drift.added, r: drift.removed }, { c: [], a: [], r: [] });

        // Edit mounted vendor file
        await new Promise((r) => setTimeout(r, 15));
        writeFileSync(
            join(root, "vendor/flux/src/init.luau"),
            "local Flux = {} function Flux.ping() return 2 end function Flux.pong() return 3 end return Flux\n",
            "utf8",
        );
        drift = probeDrift(root, outDir);
        assert.deepEqual(drift.changed, ["vendor/flux/src/init.luau"]);

        await buildGraph(root);
        const afterEditCheck = await checkGraph(root);
        assert.equal(afterEditCheck.ok, true);
        const updatedGraph = readWiring(root);
        assert.ok(updatedGraph.nodes.some((n) => n.id === "vendor/flux/src/init.luau#pong"));

        // Add new file inside mounted vendor/flux/src
        await new Promise((r) => setTimeout(r, 15));
        writeFileSync(join(root, "vendor/flux/src/NewMod.luau"), "return {}\n", "utf8");
        drift = probeDrift(root, outDir);
        assert.deepEqual(drift.added, ["vendor/flux/src/NewMod.luau"]);
        await buildGraph(root);

        // Modify nested vendor/flux/default.project.json -> detected via fp.configs & config_hash
        await new Promise((r) => setTimeout(r, 15));
        writeFileSync(
            join(root, "vendor/flux/default.project.json"),
            JSON.stringify({ name: "FluxRenamed", tree: { $path: "src" } }),
            "utf8",
        );
        drift = probeDrift(root, outDir);
        assert.ok(drift.changed.includes("vendor/flux/default.project.json"));
        const staleCheck = await checkGraph(root);
        assert.equal(staleCheck.ok, false);
        assert.equal(staleCheck.configStale, true);
    });
});
