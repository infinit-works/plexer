#!/usr/bin/env node
/**
 * `plexer` CLI — structural codebase context graph ($0, offline, WASM tree-sitter + Luau/Roblox).
 * Commands: build, ask, read, callers, callees, impact, skeleton, grep, map, blast, viz, mcp, check, init, setup, retract, version.
 */
import { Command } from "commander";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plexer } from "../src/index.js";
import { formatGraphCheckReport } from "../src/graph/check.js";
import { buildGraphIfMissing, runInit } from "../src/claude/init.js";
import { statuslineWanted } from "../src/claude/settings-merge.js";
import { runHostsInit } from "../src/hosts/init.js";
import { hostIds } from "../src/hosts/registry.js";
import { contextDirFor } from "../src/context/node-file.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "../src/graph/refresh.js";
import { federateSkeleton, isWorkspaceBuildRoot, readWorkspace } from "../src/graph/workspace.js";
import { nearestPlexerRoot } from "../src/graph/root.js";
import { unsupportedExtensions, supportedExtensions } from "../src/graph/source-files.js";
import { discoverWorkspaceChildren } from "../src/graph/scopes.js";
import { parseWalkDepth } from "../src/graph/traverse.js";
import {
    runWorkspaceAsk,
    runWorkspaceBuild,
    runWorkspaceCallers,
    runWorkspaceCheck,
    runWorkspaceGrep,
    runWorkspaceMap,
} from "../src/graph/workspace-cli.js";
import { planInit, selectedWrites } from "../src/hosts/plan.js";
import { planRetract, runRetract, changed } from "../src/hosts/retract.js";
import { globalSetupTargets, runGlobalSetup } from "../src/hosts/setup.js";
import { readCurrentVersion } from "../src/cli-meta.js";
import { patchBuildConfig } from "../src/util/state.js";
import { normalizePathPrefix } from "../src/util/paths.js";

if (process.argv[2] === "_hook") {
    const { main } = await import("../src/claude/hooks.js");
    await main(process.argv[3]);
    process.exit(0);
}

if (
    process.env.PLEXER_ENABLE_BENCH_HOOKS === "0" ||
    process.env.PLEXER_DISABLE_HOOKS === "1" ||
    /\/tmp\/plexer-(?:ab|swebench)-[^/]*-(?:cold|trail)(?:\/|$)/.test(process.cwd())
) {
    process.stderr.write("plexer: command not available in this environment\n");
    process.exit(127);
}

const program = new Command();
const currentVersion = readCurrentVersion(import.meta.url);

program
    .name("plexer")
    .description("Build a repo's structural context graph as linked markdown + graph.json ($0, offline).")
    .version(currentVersion, "-v, --version")
    .option("--dir <path>", "context graph directory (default: <repo>/plexer)");

function cliConfig() {
    const o = program.opts();
    return { contextDir: o.dir };
}
const engineFrom = () => new Plexer(cliConfig());

function warnUnsupportedExtensions(exts) {
    if (!exts?.length) return;
    const bad = unsupportedExtensions(exts);
    if (bad.length === 0) return;
    for (const e of bad) {
        const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
        console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
    }
    console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a plexer/ index)"];

function queryRoot(dir) {
    if (dir !== undefined) return resolve(dir);
    const { root, levels } = nearestPlexerRoot(process.cwd(), program.opts().dir);
    if (levels > 0) console.error(`[plexer] no plexer/ here — answering from ${root}/plexer`);
    return root;
}

async function refreshBefore(dir, opts) {
    const globalDir = program.opts().dir;
    const root = resolve(dir);
    const disabled = opts.refresh === false;
    const ws = readWorkspace(root, globalDir);
    const r = ws
        ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled })
        : await ensureFreshGraph(root, { contextDir: globalDir, disabled });
    const note = refreshNote(r);
    if (note) console.error(note);
}

const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"];
const VIZ_TABS = ["context", "code", "modules", "symbols", "outline"];

function parseTabs(raw) {
    if (raw === undefined) return undefined;
    const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
    const bad = want.filter((t) => !VIZ_TABS.includes(t));
    if (bad.length > 0 || want.length === 0) {
        console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
        process.exit(1);
    }
    return want;
}

program
    .command("version")
    .description("Print the installed plexer version")
    .action(() => {
        console.log(`plexer ${currentVersion}`);
    });

program
    .command("build")
    .description("Build plexer/ from your code — structural wiring graph + per-file cards ($0, offline)")
    .argument("[dir]", "repository root", ".")
    .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".luau" ".ts" ".py")')
    .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
    .option("--follow-submodules", "include initialized Git submodules recursively; persisted for later builds")
    .option("--no-follow-submodules", "exclude Git submodules (default)")
    .option("--follow-nested-repos", "include nested Git clones as ONE graph; persisted for later builds")
    .option("--no-follow-nested-repos", "exclude untracked nested Git clones (default)")
    .option("--include-dir <name>", "override SKIP_DIRS for this repo's walks — repeatable", (val, prev) => [...prev, val], [])
    .option("--only-dir <path>", "only index files under this repo-relative path — repeatable", (val, prev) => [...prev, val], [])
    .option("--cards", "also write passive per-file markdown cards (plexer/<dir>/<file>.md and INDEX.md)")
    .option("--no-gitignore", "skip writing plexer/ into .gitignore (same as PLEXER_NO_GITIGNORE=1)")
    .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as PLEXER_NO_IGNORE=1)")
    .action(async (dir, opts, command) => {
        if (opts.gitignore === false) process.env.PLEXER_NO_GITIGNORE = "1";
        if (opts.ignore === false) process.env.PLEXER_NO_IGNORE = "1";
        warnUnsupportedExtensions(opts.extensions);

        const buildConfigPatch = {};
        if (opts.includeDir && opts.includeDir.length > 0) {
            for (const name of opts.includeDir) {
                if (name.startsWith(".")) {
                    console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
                    process.exit(1);
                }
                if (name.includes("/") || name.includes("\\")) {
                    console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
                    process.exit(1);
                }
            }
            buildConfigPatch.includeDirs = opts.includeDir;
        }

        let onlyDirs;
        if (opts.onlyDir && opts.onlyDir.length > 0) {
            const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
            if (normalized.length === 0) {
                console.error("✗ --only-dir: expected a non-empty repo-relative path");
                process.exit(1);
            }
            onlyDirs = normalized;
        }

        const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
        if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
            buildConfigPatch.followSubmodules = opts.followSubmodules;
        }
        const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
        if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
            buildConfigPatch.followNestedRepos = opts.followNestedRepos;
        }
        const buildRoot = resolve(dir);
        const buildGlobalDir = program.opts().dir;
        if (Object.keys(buildConfigPatch).length > 0) {
            patchBuildConfig(buildRoot, buildConfigPatch, buildGlobalDir);
        }
        if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
            await runWorkspaceBuild(buildRoot, {
                extensions: opts.extensions,
                reuse: opts.reuse,
                childConfig: cliConfig(),
                override: buildGlobalDir,
                includeDirs: opts.includeDir,
                followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
                followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
            });
            return;
        }

        const engine = engineFrom();
        const fmt = (o) =>
            Object.entries(o)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `${n} ${k}`)
                .join(", ");

        const g = await engine.graph(dir, {
            extensions: opts.extensions,
            reuse: opts.reuse,
            onlyDirs,
            cards: Boolean(opts.cards),
            onProgress: ({ index, total, file }) =>
                process.stderr.write(`\rparsing ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`),
        });
        process.stderr.write("\n");
        console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
        console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
        if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
        console.log(`  → ${g.contextDir}`);
        for (const e of g.errors) console.error(`✗ ${e}`);
        const rel = relative(process.cwd(), g.contextDir) || "plexer";
        if (process.env.PLEXER_NO_GITIGNORE) {
            console.log(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
        } else {
            console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`plexer build\` to get their own.`);
        }
    });

program
    .command("ask")
    .description("Query the plexer/ graph — returns ranked nodes + exact file:line with source excerpts ($0, offline)")
    .argument("<queries...>", "one or more plain-word queries (or semicolon-separated sub-queries)")
    .option("-n, --limit <n>", "max results (default: 5 with source, 8 with --no-source)")
    .option("--source", "inline the source at each file:line hit (default: true)")
    .option("--no-source", "return file:line pointers only without inlined source")
    .option("--full", "inline whole definition spans instead of compact crux excerpts")
    .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring")
    .option("--json", "output the result as JSON")
    .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank")
    .option(...NO_REFRESH_FLAG)
    .action(async (queriesArg, opts) => {
        const rawList = Array.isArray(queriesArg) ? [...queriesArg] : [queriesArg];
        let dirArg;
        if (rawList.length >= 2) {
            const { existsSync, statSync } = await import("node:fs");
            const candidateDir = rawList[rawList.length - 1];
            try {
                if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                    dirArg = rawList.pop();
                }
            } catch {
                // treat as query
            }
        }
        const queries = rawList.flatMap((q) => {
            const str = String(q).trim();
            if (!str.includes(";")) return [str];
            const parts = str.split(";").map((s) => s.trim()).filter(Boolean);
            return parts.length >= 2 && parts.every((p) => p.split(/\s+/).length >= 2) ? parts : [str];
        });
        const dir = queryRoot(dirArg);
        await refreshBefore(dir, opts);
        const askGlobalDir = program.opts().dir;
        const limitOpt = opts.limit !== undefined ? Number(opts.limit) : undefined;
        const useSource = opts.full ? true : opts.source !== false;
        if (readWorkspace(dir, askGlobalDir)) {
            try {
                for (const query of queries) {
                    runWorkspaceAsk(dir, askGlobalDir, query, {
                        limit: limitOpt,
                        source: useSource,
                        full: opts.full,
                        in: opts.in,
                        graphRank: opts.graphRank,
                        json: opts.json,
                    });
                }
            } catch (err) {
                console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
            }
            return;
        }
        const engine = engineFrom();
        const results = [];
        try {
            const perQueryLimit = limitOpt !== undefined ? limitOpt : queries.length > 1 ? 3 : undefined;
            const seenPointers = queries.length > 1 ? new Set() : undefined;
            for (let i = 0; i < queries.length; i++) {
                const maxHitsToInline = queries.length > 1 ? 1 : undefined;
                const maxSourceBytes =
                    queries.length > 1
                        ? (opts.full ? 2800 : queries.length >= 3 ? 1700 : 2100)
                        : undefined;
                const r = engine.ask(dir, queries[i], {
                    limit: perQueryLimit,
                    source: useSource,
                    full: opts.full,
                    in: opts.in,
                    graphRank: opts.graphRank,
                    seenPointers,
                    maxSourceBytes,
                    maxHitsToInline,
                });
                results.push(r);
            }
        } catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
            return;
        }
        if (opts.json) {
            console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
        } else {
            const { formatAsk } = await import("../src/ask/ask.js");
            process.stdout.write(results.map((r) => formatAsk(r).trimEnd()).join("\n\n") + "\n");
        }
    });

program
    .command("skeleton")
    .description("Signatures-only view of one or more files from the wiring graph — the cheapest way to see a file's API surface")
    .argument("<files...>", "one or more repo-relative paths (or unique basenames) of files")
    .option("--all-matches", "return skeletons for all matching files when the path is ambiguous")
    .option("--json", "output the result as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (filesArg, opts) => {
        const rawList = Array.isArray(filesArg) ? [...filesArg] : [filesArg];
        let dirArg;
        if (rawList.length >= 2) {
            const { existsSync, statSync } = await import("node:fs");
            const candidateDir = rawList[rawList.length - 1];
            try {
                if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                    const absCand = resolve(candidateDir);
                    if (existsSync(join(absCand, "plexer")) || program.opts().dir) {
                        dirArg = rawList.pop();
                    }
                }
            } catch {
                // treat as file query
            }
        }
        const files = rawList.flatMap((f) => String(f).split(",").map((x) => x.trim()).filter(Boolean));
        const dir = queryRoot(dirArg);
        await refreshBefore(dir, opts);
        const { formatSkeleton } = await import("../src/ask/ask.js");
        const globalDir = program.opts().dir;
        const skelOpts = { allMatches: Boolean(opts.allMatches) };
        const isWs = Boolean(readWorkspace(dir, globalDir));
        const eng = engineFrom();
        if (files.length === 1) {
            const r = isWs
                ? federateSkeleton(dir, globalDir, files[0], skelOpts)
                : eng.skeleton(dir, files[0], skelOpts);
            if (opts.json) console.log(JSON.stringify(r, null, 2));
            else process.stdout.write(formatSkeleton(r));
            if (!r.entries?.length && (r.note || r.error)) process.exit(1);
            return;
        }
        const results = files.map((file) =>
            isWs ? federateSkeleton(dir, globalDir, file, skelOpts) : eng.skeleton(dir, file, skelOpts),
        );
        if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
        } else {
            process.stdout.write(results.map((r) => formatSkeleton(r).trimEnd()).join("\n\n") + "\n");
        }
        if (results.every((r) => !r.entries?.length && (r.note || r.error))) process.exit(1);
    });

program
    .command("read")
    .description("Read one or more exact file:Lx-Ly line spans or file:symbol spans (or unique basenames) with L<n>: line numbers ($0, offline)")
    .argument("<spans...>", "one or more file:Lx-Ly, file:Lx, file:symbol, or file spans")
    .option("--json", "output the result as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (spansArg, opts) => {
        const rawList = Array.isArray(spansArg) ? [...spansArg] : [spansArg];
        let dirArg;
        if (rawList.length >= 2) {
            const { existsSync, statSync } = await import("node:fs");
            const candidateDir = rawList[rawList.length - 1];
            try {
                if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                    const absCand = resolve(candidateDir);
                    if (existsSync(join(absCand, "plexer")) || program.opts().dir) {
                        dirArg = rawList.pop();
                    }
                }
            } catch {
                // treat as span
            }
        }
        const dir = queryRoot(dirArg);
        await refreshBefore(dir, opts);
        const { formatReadSpans } = await import("../src/ask/ask.js");
        const eng = engineFrom();
        const r = eng.read(dir, rawList);
        if (opts.json) {
            console.log(JSON.stringify(r, null, 2));
        } else {
            process.stdout.write(formatReadSpans(r));
        }
        if (r.blocks.every((b) => b.error)) process.exit(1);
    });

program
    .command("check")
    .description("Fail if plexer/ is stale relative to the code (for CI)")
    .argument(...DIR_ARG)
    .option("-e, --extensions <exts...>", "code extensions to include")
    .option("--json", "output the drift as JSON")
    .action(async (dirArg, opts) => {
        warnUnsupportedExtensions(opts.extensions);
        const dir = queryRoot(dirArg);
        const checkGlobalDir = program.opts().dir;
        if (readWorkspace(dir, checkGlobalDir)) {
            await runWorkspaceCheck(dir, checkGlobalDir, { json: opts.json, extensions: opts.extensions });
            return;
        }
        const engine = engineFrom();
        const g = await engine.checkGraph(dir, { extensions: opts.extensions });
        if (opts.json) {
            console.log(JSON.stringify({ graph: g.missing ? null : g }, null, 2));
        } else if (g.missing) {
            console.log("plexer check: NO GRAPH\n\nNo plexer/ graph found. Run `plexer build` first.");
        } else {
            console.log(formatGraphCheckReport(g));
        }
        if (g.missing || !g.ok) process.exit(1);
    });

program
    .command("viz")
    .description("Serve an interactive 60fps HTML5 canvas visualization of the codebase graph")
    .argument(...DIR_ARG)
    .option("-p, --port <port>", "port to serve on", "4400")
    .option("--no-open", "don't open the browser")
    .option("--export <dir>", "write one self-contained index.html instead of serving")
    .option("--title <text>", "subtitle shown beside the repo name in an exported page")
    .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,modules,symbols,outline")
    .action(async (dirArg, opts) => {
        const tabs = parseTabs(opts.tabs);
        const dir = queryRoot(dirArg);
        const { existsSync } = await import("node:fs");
        const { spawn } = await import("node:child_process");
        const { startVizServer } = await import("../src/viz/serve.js");
        const root = resolve(dir);
        const globalOpts = program.opts();
        const contextDir = contextDirFor(root, globalOpts.dir);
        if (!existsSync(contextDir)) {
            console.error(`✗ no context graph at ${contextDir} — run \`plexer build\` first`);
            process.exit(1);
        }
        const viewerDir = fileURLToPath(new URL("../src/viewer/", import.meta.url));
        if (opts.export) {
            const { exportViz } = await import("../src/viz/export.js");
            const out = exportViz({
                contextDir,
                viewerDir,
                outDir: resolve(opts.export),
                repoName: basename(root),
                subtitle: opts.title,
                tabs,
            });
            const kb = Math.round(out.bytes / 1024);
            const counts = out.contextNodes > 0 ? `${out.contextNodes} areas, ${out.codeNodes} code nodes` : `${out.codeNodes} code nodes`;
            console.log(`plexer viz → ${out.file} (${kb} kB, ${counts})`);
            return;
        }
        const srv = await startVizServer({
            root,
            contextDir,
            viewerDir,
            port: Number(opts.port),
            repoName: basename(root),
        });
        console.log(`plexer viz → ${srv.url}  (ctrl-c to stop)`);
        if (opts.open) {
            const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            spawn(opener, [srv.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
        }
    });

program
    .command("mcp")
    .description("Serve the graph over MCP (stdio) — exposes plexer_find_code, plexer_trace_calls, plexer_find_all, plexer_file_api, plexer_repo_map and plexer_check_freshness")
    .argument(...DIR_ARG)
    .action(async (dirArg) => {
        const dir = queryRoot(dirArg);
        const { startMcpServer } = await import("../src/mcp/server.js");
        const globalOpts = program.opts();
        startMcpServer(dir, globalOpts.dir, currentVersion);
    });

async function runCallersAction(symbolsArg, opts, forcedDirection) {
    const rawList = Array.isArray(symbolsArg) ? [...symbolsArg] : [symbolsArg];
    let dirArg;
    if (rawList.length >= 2) {
        const { existsSync, statSync } = await import("node:fs");
        const candidateDir = rawList[rawList.length - 1];
        try {
            if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                const absCand = resolve(candidateDir);
                if (existsSync(join(absCand, "plexer")) || program.opts().dir) {
                    dirArg = rawList.pop();
                }
            }
        } catch {
            // treat as symbol
        }
    }
    const symbols = rawList.flatMap((s) => String(s).split(",").map((x) => x.trim()).filter(Boolean));
    const symbolOrList = symbols.length === 1 ? symbols[0] : symbols;
    const dir = queryRoot(dirArg);
    await refreshBefore(dir, opts);
    const globalOpts = program.opts();
    const { runCallersCommand, resolveDirection, resolveCliDepth } = await import("../src/graph/traverse-cli.js");
    const direction = resolveDirection(forcedDirection ?? opts.direction);
    const depth = resolveCliDepth(opts.depth);
    const useSource = opts.full ? true : opts.source !== false;
    if (readWorkspace(dir, globalOpts.dir)) {
        runWorkspaceCallers(dir, globalOpts.dir, symbolOrList, {
            direction,
            depth,
            in: opts.in,
            source: useSource,
            full: opts.full,
            json: opts.json,
        });
        return;
    }
    runCallersCommand(symbolOrList, dir, {
        direction,
        depth: opts.depth,
        in: opts.in,
        source: useSource,
        full: opts.full,
        json: opts.json,
        globalDir: globalOpts.dir,
    });
}

program
    .command("callers")
    .description("Who calls/references a symbol ($0, offline). --direction out gives callees; --depth N (or all) walks transitively")
    .argument("<symbols...>", "one or more symbol names: bare, qualified (Class.method), or file path")
    .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
    .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
    .option("--source", "inline definition and call-site source excerpts for the target and top callers (default: true)")
    .option("--no-source", "return symbol headers and 1-line call quotes only without full source blocks")
    .option("--full", "inline extended source excerpts")
    .option("--in <path>", "narrow matches to nodes at or under this path prefix")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action((symbols, opts) => runCallersAction(symbols, opts));

program
    .command("callees")
    .description("What a symbol calls/references ($0, offline) — alias for `plexer callers <symbol> --direction out`")
    .argument("<symbols...>", "one or more symbol names: bare, qualified (Class.method), or file path")
    .option("-d, --depth <n>", 'walk transitively up to N hops, or "all" for the full connected closure (default 1)')
    .option("--source", "inline definition and call-site source excerpts (default: true)")
    .option("--no-source", "return symbol headers and 1-line call quotes only")
    .option("--full", "inline extended source excerpts")
    .option("--in <path>", "narrow matches to nodes at or under this path prefix")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action((symbols, opts) => runCallersAction(symbols, opts, "out"));

program
    .command("impact")
    .description("Transitive callers of a symbol ($0, offline) — alias for `plexer callers <symbol> --depth 2`")
    .argument("<symbols...>", "one or more symbol names: bare, qualified (Class.method), or file path")
    .option("-d, --depth <n>", 'walk transitively up to N hops, or "all" for the full connected closure (default 2)', "2")
    .option("--source", "inline definition and call-site source excerpts (default: true)")
    .option("--no-source", "return symbol headers and 1-line call quotes only")
    .option("--full", "inline extended source excerpts")
    .option("--in <path>", "narrow matches to nodes at or under this path prefix")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action((symbols, opts) => runCallersAction(symbols, opts, "in"));

program
    .command("blast")
    .description("Blast radius of a diff: what depends on the lines this change touched ($0, offline)")
    .argument(...DIR_ARG)
    .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: working tree vs HEAD")
    .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
    .option("--format <fmt>", "text (default) | markdown | mermaid | json")
    .option("--markdown", "output as PR-ready Markdown (shorthand for --format markdown)")
    .option("--mermaid", "output as a Mermaid diagram (shorthand for --format mermaid)")
    .option("--json", "output as JSON (shorthand for --format json)")
    .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html)")
    .option("--title <text>", "subtitle beside the repo name on the exported page")
    .option("--no-owners", "do not suggest who to tag from git history")
    .option("--pr-author <who...>", "GitHub login, git name or email of the PR author to exclude from owner suggestions")
    .option(...NO_REFRESH_FLAG)
    .action(async (dirArg, opts) => {
        const dir = queryRoot(dirArg);
        await refreshBefore(dir, opts);
        const format = opts.format ?? (opts.json ? "json" : opts.markdown ? "markdown" : opts.mermaid ? "mermaid" : undefined);
        const { runBlastCommand } = await import("../src/blast/blast-cli.js");
        await runBlastCommand(dir, {
            base: opts.base,
            depth: opts.depth,
            format,
            exportViz: opts.exportViz,
            title: opts.title,
            owners: opts.owners,
            prAuthor: opts.prAuthor,
            globalDir: program.opts().dir,
        });
    });

program
    .command("grep")
    .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, offline)")
    .argument("<patterns...>", "one or more regex patterns (or literal strings with --fixed)")
    .option("-i, --ignore-case", "case-insensitive match")
    .option("--fixed", "treat pattern as a literal string, not a regex")
    .option("-C, --context <lines>", "lines of surrounding context to show around each hit (default: 2)")
    .option("--source", "show surrounding source context around each hit (default: true)")
    .option("--no-source", "show 1-line matches only without surrounding context")
    .option("--full", "show extended surrounding source context around each hit")
    .option("--in <path>", "narrow to files at or under this path prefix")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (patternsArg, opts) => {
        const rawList = Array.isArray(patternsArg) ? [...patternsArg] : [patternsArg];
        let dirArg;
        if (rawList.length >= 2) {
            const { existsSync, statSync } = await import("node:fs");
            const candidateDir = rawList[rawList.length - 1];
            try {
                if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                    const absCand = resolve(candidateDir);
                    if (existsSync(join(absCand, "plexer")) || program.opts().dir) {
                        dirArg = rawList.pop();
                    }
                }
            } catch {
                // treat as pattern
            }
        }
        const patterns = rawList.map((p) => String(p)).filter(Boolean);
        const patternOrList = patterns.length === 1 ? patterns[0] : patterns;
        const dir = queryRoot(dirArg);
        await refreshBefore(dir, opts);
        const globalOpts = program.opts();
        const contextLines =
            opts.context !== undefined
                ? Number(opts.context)
                : opts.source === false
                    ? 0
                    : opts.full
                        ? 4
                        : undefined;
        const sourceEnabled = opts.source !== false && (contextLines === undefined || contextLines > 0);
        if (readWorkspace(dir, globalOpts.dir)) {
            try {
                for (const pat of patterns) {
                    runWorkspaceGrep(dir, globalOpts.dir, pat, {
                        ignoreCase: opts.ignoreCase,
                        fixed: opts.fixed,
                        context: contextLines,
                        source: sourceEnabled,
                        in: opts.in,
                        json: opts.json,
                    });
                }
            } catch (err) {
                console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
                process.exit(1);
            }
            return;
        }
        const { runGrepCommand } = await import("../src/search/grep-cli.js");
        runGrepCommand(patternOrList, dir, {
            ignoreCase: opts.ignoreCase,
            fixed: opts.fixed,
            context: contextLines,
            source: sourceEnabled,
            in: opts.in,
            json: opts.json,
            globalDir: globalOpts.dir,
        });
    });

program
    .command("map")
    .description("Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, offline)")
    .argument(...DIR_ARG)
    .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
    .option("--json", "output as JSON")
    .option(...NO_REFRESH_FLAG)
    .action(async (dirArg, opts) => {
        const dir = queryRoot(dirArg);
        const root = resolve(dir);
        const globalOpts = program.opts();
        let maxDirsW;
        if (opts.maxDirs !== undefined) {
            const n = parseInt(opts.maxDirs, 10);
            if (!Number.isFinite(n) || n <= 0) {
                console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
                process.exit(1);
                return;
            }
            maxDirsW = n;
        }
        await refreshBefore(dir, opts);
        if (readWorkspace(root, globalOpts.dir)) {
            runWorkspaceMap(root, globalOpts.dir, { maxDirs: maxDirsW, json: opts.json });
            return;
        }
        const { formatRepoMap } = await import("../src/graph/map.js");
        let map;
        try {
            map = engineFrom().map(root, { maxDirs: maxDirsW });
        } catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
            return;
        }
        if (opts.json) {
            console.log(JSON.stringify(map, null, 2));
            return;
        }
        process.stdout.write(formatRepoMap(map));
    });

function runGlobalOnlyInit(home, opts) {
    const globalAgents = Array.isArray(opts.agents) ? opts.agents : opts.agents === false ? ["claude"] : undefined;
    if (opts.dryRun) {
        for (const w of globalSetupTargets({ home, agents: globalAgents, bin: opts.bin, skills: opts.skills })) {
            console.log(`${w.hostId}: ${w.path} (${w.what})`);
        }
        return;
    }
    const res = runGlobalSetup({
        home,
        agents: globalAgents,
        bin: opts.bin,
        skills: opts.skills,
        hooks: opts.hooks,
        mcp: opts.mcp,
    });
    for (const group of [res.bin, res.skills, res.hooks, res.mcp]) {
        for (const item of group) {
            console.log(`${item.action}: ${item.path}`);
        }
    }
    console.error("✓ global plexer binary, skill links, hooks, and MCP wired");
}

program
    .command("init")
    .description("Wire Plexer globally (PATH binary, skills, hooks, MCP) and into a target repository")
    .argument("[dir]", "target repo directory", ".")
    .option("-g, --global", "install global binary symlink, skill symlinks, hooks, and MCP only (skip repo wiring)")
    .option("--no-global", "skip writes outside this repo (~/.local/bin, ~/.agents, ~/.claude, ~/.codex, ~/.gemini)")
    .option("--no-bin", "skip linking ~/.local/bin/plexer")
    .option("--no-skills", "skip linking ~/.agents/skills/plexer, ~/.claude/skills/plexer, ~/.gemini/skills/plexer")
    .option("--no-build", "skip building the graph (wire files only)")
    .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
    .option("--all-agents", "write instruction files for every known agent, detected or not")
    .option("--no-agents", "Claude Code wiring only; skip other agents")
    .option("--list-agents", "list known agent ids and exit")
    .option("--no-mcp", "skip MCP server registration")
    .option("--no-hooks", "skip hook installation")
    .option("--no-statusline", "skip writing Claude Code statusLine")
    .option("--dry-run", "print every file init would touch, then exit without writing")
    .option("-y, --yes", "accept defaults without prompting (non-interactive compatibility)")
    .action(async (dir, opts, command) => {
        if (opts.listAgents) {
            for (const id of [...hostIds(), "claude"]) console.log(id);
            return;
        }
        const globalOnly = command.getOptionValueSource("global") === "cli" && opts.global === true;
        const allowGlobal = opts.global !== false;
        const home = homedir();

        if (globalOnly) {
            runGlobalOnlyInit(home, opts);
            return;
        }

        const repo = resolve(dir);
        const plan = planInit(repo, { home });
        const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
        let ids;
        if (Array.isArray(opts.agents)) ids = opts.agents;
        else if (opts.allAgents) ids = plan.map((p) => p.id);
        else if (opts.agents === false) ids = ["claude"];
        else ids = detectedIds;

        if (opts.dryRun) {
            const seen = new Set();
            if (allowGlobal && ids.length > 0) {
                for (const w of globalSetupTargets({ home, agents: ids, bin: opts.bin, skills: opts.skills })) {
                    seen.add(w.path);
                    console.log(`${w.hostId}: ${w.path} (${w.what})`);
                }
            }
            for (const w of selectedWrites(plan, ids, { global: allowGlobal, mcp: opts.mcp, hooks: opts.hooks, skills: opts.skills })) {
                if (seen.has(w.path)) continue;
                seen.add(w.path);
                console.log(`${w.hostId}: ${w.path} (${w.what})`);
            }
            return;
        }

        if (ids.length === 0) {
            console.error("· no agents selected — nothing written");
            return;
        }

        if (allowGlobal) {
            runGlobalSetup({
                home,
                agents: ids,
                bin: opts.bin,
                skills: opts.skills,
                hooks: opts.hooks,
                mcp: opts.mcp,
            });
        }

        const cliPath = fileURLToPath(import.meta.url);
        const children = isWorkspaceBuildRoot(repo, program.opts().dir) ? discoverWorkspaceChildren(repo) : [];
        const targets = [repo, ...children.map((c) => join(repo, c))];
        const wantClaude = ids.includes("claude");
        const wantStatusline = statuslineWanted({ statusline: opts.statusline });

        for (const target of targets) {
            runRetract(target, { home, apply: true, global: false, cache: false, exclude: ids });
            if (wantClaude) {
                runInit(target, {
                    build: opts.build,
                    cliPath,
                    statusline: wantStatusline,
                    mcp: opts.mcp,
                    hooks: opts.hooks,
                    global: false,
                    home,
                });
            }
            const others = ids.filter((id) => id !== "claude");
            if (others.length > 0) {
                runHostsInit(target, {
                    agents: others,
                    home,
                    mcp: opts.mcp,
                    hooks: opts.hooks,
                    skills: opts.skills,
                    global: false,
                });
            }
            if (!wantClaude) {
                buildGraphIfMissing(target, { build: opts.build, cliPath });
            }
        }
        console.error(`✓ wired ${ids.join(", ")} in ${repo}`);
    });

program
    .command("setup")
    .description("Install global plexer binary symlink, skill links, hooks, and MCP — alias for `plexer init --global`")
    .option("--agents <ids...>", `only these agents (${hostIds().join(", ")}, claude)`)
    .option("--no-bin", "skip linking ~/.local/bin/plexer")
    .option("--no-skills", "skip linking ~/.agents/skills/plexer, ~/.claude/skills/plexer, ~/.gemini/skills/plexer")
    .option("--no-mcp", "skip MCP server registration")
    .option("--no-hooks", "skip hook installation")
    .option("--dry-run", "print every file setup would touch, then exit without writing")
    .action((opts) => runGlobalOnlyInit(homedir(), opts));

program
    .command("uninstall")
    .alias("retract")
    .description("Remove every file and config entry plexer has written to this repo")
    .argument("[dir]", "target repo directory", ".")
    .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
    .option("--dry-run", "print every file uninstall would remove, then exit")
    .option("--keep-cache", "keep plexer/ and the .gitignore entries — wiring only")
    .option("--no-global", "leave out-of-repo files alone (~/.local/bin, ~/.agents, ~/.claude, ~/.codex, ~/.gemini)")
    .option("--json", "output removed/planned entries as JSON")
    .action((dir, opts) => {
        const repo = resolve(dir);
        const home = homedir();
        const common = { home, global: opts.global, cache: !opts.keepCache };
        if (!opts.yes || opts.dryRun) {
            const rs = changed(planRetract(repo, common));
            if (opts.json) {
                console.log(JSON.stringify({ dryRun: true, entries: rs }, null, 2));
                return;
            }
            for (const r of rs) console.error(`would remove: ${r.path} (${r.what})`);
            console.error("\nDry run — nothing was touched. Re-run with -y to remove.");
            return;
        }
        const done = changed(runRetract(repo, { ...common, apply: true }));
        if (opts.json) {
            console.log(JSON.stringify({ dryRun: false, entries: done }, null, 2));
            return;
        }
        for (const r of done) console.error(`removed: ${r.path} (${r.what})`);
        console.error("\n✓ plexer wiring removed.");
    });

program.parse();
