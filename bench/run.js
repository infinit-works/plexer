#!/usr/bin/env node
/**
 * Deterministic $0 benchmark suite for `plexer`:
 *  1. Speed & memory/disk footprint across 6 indexed repositories (warm incremental
 *     refresh, content-hash check, ask --source, ask, grep, callers, skeleton, map).
 *  2. Token budget measurement (`ask --source` vs `--full` vs reading the matched
 *     source files directly).
 *  3. Retrieval correctness (Recall@1, Recall@3, Recall@5, MRR) across 24
 *     de-leaked natural-language developer intent queries spanning all 6 repositories
 *     (4 queries per repository, including holdout repos `building-tools` and `z`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
    ask,
    buildGraph,
    buildRepoMap,
    checkGraph,
    edgeWalk,
    formatAsk,
    formatGrepResult,
    formatRepoMap,
    formatSkeleton,
    grepGraph,
    resolveSymbol,
    skeleton,
} from "../src/index.js";
import { loadGraphCached } from "../src/graph/load.js";

const REPOS = [
    {
        name: "plexer",
        dir: resolve(import.meta.dirname, ".."),
        query: "how are working tree file modifications detected before running a query",
        grep: "personalizedPageRank",
        sym: "resolveSymbol",
        file: "src/ask/ask.js",
    },
    {
        name: "kohls-admin",
        dir: "/home/kohl/Projects/roblox/libraries/kohls-admin",
        query: "how are player command arguments parsed and validated before running",
        grep: "registerCommand",
        sym: "Auth.hasPermission",
        file: "src/Shared/Auth.luau",
    },
    {
        name: "flux",
        dir: "/home/kohl/Projects/roblox/libraries/flux",
        query: "how do derived reactive computations track dependencies and clean up",
        grep: "spring",
        sym: "Graph.effect",
        file: "src/Graph.luau",
    },
    {
        name: "sert",
        dir: "/home/kohl/Projects/roblox/libraries/sert",
        query: "how does property testing shrink failing counterexamples",
        grep: "afterEach",
        sym: "prop.check",
        file: "src/prop.luau",
    },
    {
        name: "building-tools",
        dir: "/home/kohl/Projects/roblox/libraries/building-tools",
        query: "how are undo and redo history entries recorded for part edits",
        grep: "History",
        sym: "History.record",
        file: "src/Client/State/History.luau",
    },
    {
        name: "z",
        dir: "/home/kohl/Projects/roblox/libraries/z",
        query: "how does the compiler resolve schema type references and wire bitwidths",
        grep: "resolve",
        sym: "resolve_schema",
        file: "compiler/src/resolve.rs",
    },
];

/**
 * 24 natural-language developer intent queries (4 per repository across all 6
 * repositories) without leaked camelCase function names.
 */
const GOLD_QUERIES = [
    // plexer (JS/ESM)
    {
        repo: "plexer",
        query: "how are working tree file modifications detected via mtime and size stamps",
        goldPath: "src/graph/fingerprint.js",
    },
    {
        repo: "plexer",
        query: "where are per-file markdown wiring cards and the repo index written to disk",
        goldPath: "src/graph/cards.js",
    },
    {
        repo: "plexer",
        query: "how are Luau module require bindings and returned table exports extracted",
        goldPath: "src/graph/luau.js",
    },
    {
        repo: "plexer",
        query: "how are dotted or colon-qualified symbol names matched to graph nodes",
        goldPath: "src/graph/traverse.js",
    },
    // kohls-admin (Luau)
    {
        repo: "kohls-admin",
        query: "where are player admin ranks and command access permissions checked",
        goldPath: "src/Shared/Auth.luau",
    },
    {
        repo: "kohls-admin",
        query: "how are user bans and unbans persisted to the datastore",
        goldPath: "src/Shared/Auth.luau",
    },
    {
        repo: "kohls-admin",
        query: "how are raw chat command strings split into tokens and quoted arguments",
        goldPath: "src/Shared/Process",
    },
    {
        repo: "kohls-admin",
        query: "where are command arguments validated and transformed before command execution",
        goldPath: "src/Shared/Process",
    },
    // flux (Luau)
    {
        repo: "flux",
        query: "how do reactive signals effects and derived computations track dependencies",
        goldPath: "src/Graph.luau",
    },
    {
        repo: "flux",
        query: "where is spring physics velocity and damping step simulation implemented",
        goldPath: "src/Motion.luau",
    },
    {
        repo: "flux",
        query: "how are declarative UI properties attributes and event bindings applied to instances",
        goldPath: "src/Edit.luau",
    },
    {
        repo: "flux",
        query: "how does responsive viewport breakpoint and UI scale tracking work",
        goldPath: "src/Responsive.luau",
    },
    // sert (Luau)
    {
        repo: "sert",
        query: "how does the deterministic simulation scheduler advance virtual clock time",
        goldPath: "src/sim/scheduler.luau",
    },
    {
        repo: "sert",
        query: "how does property based testing shrink failing generator inputs",
        goldPath: "src/prop.luau",
    },
    {
        repo: "sert",
        query: "how does stateful model testing run and replay command sequences",
        goldPath: "src/model.luau",
    },
    {
        repo: "sert",
        query: "where are UI layout overlap clipping and offscreen geometry assertions checked",
        goldPath: "src/roblox/layout.luau",
    },
    // building-tools (Luau — Holdout Repo)
    {
        repo: "building-tools",
        query: "where are undo and redo action history snapshots recorded and restored",
        goldPath: "src/Client/State/History.luau",
    },
    {
        repo: "building-tools",
        query: "how is the selection bounding box and pivot cframe recomputed",
        goldPath: "src/Client/Systems/BoundingBox.luau",
    },
    {
        repo: "building-tools",
        query: "how are incremental part property changes replicated between client and server",
        goldPath: "src/Shared/",
    },
    {
        repo: "building-tools",
        query: "where are keyboard shortcuts and hotkeys bound for building tools",
        goldPath: "src/Client/",
    },
    // z (Rust + Luau — Holdout Repo)
    {
        repo: "z",
        query: "how does the compiler resolve schema type references and bitwidth layouts",
        goldPath: "compiler/src/resolve.rs",
    },
    {
        repo: "z",
        query: "where does the compiler emit Luau buffer pack and unpack serializer code",
        goldPath: "compiler/src/emit.rs",
    },
    {
        repo: "z",
        query: "how does the lexer and parser build the schema AST from source text",
        goldPath: "compiler/src/parser.rs",
    },
    {
        repo: "z",
        query: "how are variable-length integers encoded and decoded in the runtime buffer",
        goldPath: "runtime/core/Varint.luau",
    },
];

const estTokens = (s) => Math.ceil((s || "").length / 4);

function rawFilesTokensForHits(repoDir, hits, topN = 3) {
    const seenFiles = new Set();
    let totalChars = 0;
    for (const h of hits.slice(0, topN)) {
        const relPath = String(h.pointer || "").split(":")[0];
        if (!relPath || seenFiles.has(relPath))
            continue;
        seenFiles.add(relPath);
        try {
            totalChars += readFileSync(join(repoDir, relPath), "utf8").length;
        } catch {
            // ignore unreadable
        }
    }
    return Math.ceil(totalChars / 4);
}

import { tmpdir } from "node:os";

function repoContextDir(r) {
    const inTree = join(r.dir, "plexer");
    if (existsSync(inTree))
        return inTree;
    return join(tmpdir(), "plexer-bench-cache", r.name, "plexer");
}

async function benchRepo(r) {
    if (!existsSync(r.dir))
        return null;
    const outDir = repoContextDir(r);
    if (!existsSync(join(outDir, ".graph", "wiring.json"))) {
        await buildGraph(r.dir, { contextDir: outDir, graphOnly: true });
    }

    // Incremental no-op buildGraph (graphOnly)
    const tBuild0 = performance.now();
    await buildGraph(r.dir, { contextDir: outDir, graphOnly: true });
    const warmBuildMs = performance.now() - tBuild0;

    // Freshness checkGraph
    const tCheck0 = performance.now();
    await checkGraph(r.dir, { contextDir: outDir });
    const checkMs = performance.now() - tCheck0;

    // Warm in-memory caches once after buildGraph
    const graph = loadGraphCached(outDir);
    if (!graph)
        return null;
    const warmAskRes = ask(r.dir, r.query, { contextDir: outDir, source: true });
    const N = 8;

    let tAskSrc = 0;
    let askSrcOut = "";
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        askSrcOut = formatAsk(ask(r.dir, r.query, { contextDir: outDir, source: true }));
        tAskSrc += performance.now() - t0;
    }

    const askFullOut = formatAsk(ask(r.dir, r.query, { contextDir: outDir, source: true, full: true }));
    const rawTopFilesTok = rawFilesTokensForHits(r.dir, warmAskRes.hits, 3);

    let tAskNoSrc = 0;
    let askNoSrcOut = "";
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        askNoSrcOut = formatAsk(ask(r.dir, r.query, { contextDir: outDir, source: false }));
        tAskNoSrc += performance.now() - t0;
    }

    let tGrep = 0;
    let grepOut = "";
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        grepOut = formatGrepResult(grepGraph(graph, r.dir, r.grep, { fixed: true }));
        tGrep += performance.now() - t0;
    }

    let tCallers = 0;
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const syms = resolveSymbol(graph, r.sym);
        if (syms[0])
            edgeWalk(graph, syms[0], "in", 2);
        tCallers += performance.now() - t0;
    }

    let tSkel = 0;
    let skelOut = "";
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        skelOut = formatSkeleton(skeleton(r.dir, r.file, { contextDir: outDir }));
        tSkel += performance.now() - t0;
    }

    let tMap = 0;
    let mapOut = "";
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        mapOut = formatRepoMap(buildRepoMap(graph));
        tMap += performance.now() - t0;
    }

    const wiringBytes = statSync(join(outDir, ".graph", "wiring.json")).size;

    return {
        name: r.name,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        wiringKB: Math.round(wiringBytes / 1024),
        warmBuildMs: +warmBuildMs.toFixed(1),
        checkMs: +checkMs.toFixed(1),
        askSourceMs: +(tAskSrc / N).toFixed(2),
        askNoSourceMs: +(tAskNoSrc / N).toFixed(2),
        grepMs: +(tGrep / N).toFixed(2),
        callersMs: +(tCallers / N).toFixed(2),
        skeletonMs: +(tSkel / N).toFixed(2),
        mapMs: +(tMap / N).toFixed(2),
        askSourceTokens: estTokens(askSrcOut),
        askFullTokens: estTokens(askFullOut),
        rawTopFilesTokens: rawTopFilesTok,
        askNoSourceTokens: estTokens(askNoSrcOut),
        grepTokens: estTokens(grepOut),
        skeletonTokens: estTokens(skelOut),
        mapTokens: estTokens(mapOut),
    };
}

function evaluateRetrieval() {
    const repoByName = new Map(REPOS.map((r) => [r.name, r]));
    let hitsAt1 = 0;
    let hitsAt3 = 0;
    let hitsAt5 = 0;
    let rrSum = 0;
    let total = 0;
    const details = [];

    for (const q of GOLD_QUERIES) {
        const repo = repoByName.get(q.repo);
        if (!repo || !existsSync(repo.dir))
            continue;
        const outDir = repoContextDir(repo);
        if (!existsSync(join(outDir, ".graph", "wiring.json")))
            continue;
        total++;
        const res = ask(repo.dir, q.query, { contextDir: outDir, limit: 5 });
        let rank = 0;
        for (let i = 0; i < res.hits.length; i++) {
            const h = res.hits[i];
            const ptrLower = h.pointer.toLowerCase();
            const titleLower = h.title.toLowerCase();
            const pathOk = q.goldPath ? ptrLower.includes(q.goldPath.toLowerCase()) : true;
            const symOk = q.goldSym ? titleLower.includes(q.goldSym.toLowerCase()) : true;
            if (pathOk && symOk) {
                rank = i + 1;
                break;
            }
        }
        if (rank === 1)
            hitsAt1++;
        if (rank > 0 && rank <= 3)
            hitsAt3++;
        if (rank > 0 && rank <= 5)
            hitsAt5++;
        if (rank > 0)
            rrSum += 1 / rank;
        details.push({
            repo: q.repo,
            query: q.query,
            rank,
            topHit: res.hits[0] ? `${res.hits[0].title} (${res.hits[0].pointer})` : "none",
        });
    }

    return {
        total,
        recallAt1: +(hitsAt1 / (total || 1)).toFixed(3),
        recallAt3: +(hitsAt3 / (total || 1)).toFixed(3),
        recallAt5: +(hitsAt5 / (total || 1)).toFixed(3),
        mrr: +(rrSum / (total || 1)).toFixed(3),
        details,
    };
}

const repoMetrics = [];
for (const r of REPOS) {
    const m = await benchRepo(r);
    if (m)
        repoMetrics.push(m);
}
const retrieval = evaluateRetrieval();

if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ repoMetrics, retrieval }, null, 2));
} else {
    console.log("# Plexer Engine Benchmark\n");
    console.log("## 1. Latency & Token Budgets by Repository\n");
    console.log("| Repo | Nodes / Edges | `wiring.json` | Warm Refresh | `check` | `ask --source` | `ask` | `grep` | `callers` | `skeleton` | `map` | `ask --source` Tokens (vs `--full` / vs Raw Files) |");
    console.log("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const m of repoMetrics) {
        const vsFull = m.askFullTokens > 0
            ? Math.round((1 - m.askSourceTokens / m.askFullTokens) * 100)
            : 0;
        const vsRaw = m.rawTopFilesTokens > 0
            ? Math.round((1 - m.askSourceTokens / m.rawTopFilesTokens) * 100)
            : 0;
        console.log(
            `| \`${m.name}\` | ${m.nodes.toLocaleString()} / ${m.edges.toLocaleString()} | ${m.wiringKB} KB | ${m.warmBuildMs}ms | ${m.checkMs}ms | **${m.askSourceMs}ms** | ${m.askNoSourceMs}ms | ${m.grepMs}ms | ${m.callersMs}ms | ${m.skeletonMs}ms | ${m.mapMs}ms | **${m.askSourceTokens}** (-${vsFull}% vs ${m.askFullTokens} full, -${vsRaw}% vs ${m.rawTopFilesTokens} raw) |`,
        );
    }
    console.log("\n## 2. Retrieval Accuracy (24 De-Leaked Intent Queries across 6 Repos)\n");
    console.log(`- **Recall@1**: ${(retrieval.recallAt1 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank === 1).length}/${retrieval.total})`);
    console.log(`- **Recall@3**: ${(retrieval.recallAt3 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank > 0 && d.rank <= 3).length}/${retrieval.total})`);
    console.log(`- **Recall@5**: ${(retrieval.recallAt5 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank > 0 && d.rank <= 5).length}/${retrieval.total})`);
    console.log(`- **MRR**: ${retrieval.mrr.toFixed(3)}`);
    const misses = retrieval.details.filter((d) => d.rank !== 1);
    if (misses.length > 0) {
        console.log("\n### Non-Rank-1 Queries:");
        for (const d of misses) {
            console.log(`- [${d.repo}] "${d.query}" → rank ${d.rank} (top: ${d.topHit})`);
        }
    }
}
