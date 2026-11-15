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
import { homedir, tmpdir } from "node:os";
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
import { loadGraphCached } from "../src/context/graph-store.js";

const BENCH_REPOS_DIR = process.env.PLEXER_BENCH_REPOS_DIR || join(homedir(), "Projects", "roblox", "libraries");
const FIXTURES_DIR = resolve(import.meta.dirname, "fixtures");

const LOCAL_REPOS = [
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
        dir: join(BENCH_REPOS_DIR, "kohls-admin"),
        query: "how are player command arguments parsed and validated before running",
        grep: "registerCommand",
        sym: "Auth.hasPermission",
        file: "src/Shared/Auth.luau",
    },
    {
        name: "flux",
        dir: join(BENCH_REPOS_DIR, "flux"),
        query: "how do derived reactive computations track dependencies and clean up",
        grep: "spring",
        sym: "Graph.effect",
        file: "src/Graph.luau",
    },
    {
        name: "sert",
        dir: join(BENCH_REPOS_DIR, "sert"),
        query: "how does property testing shrink failing counterexamples",
        grep: "afterEach",
        sym: "prop.check",
        file: "src/prop.luau",
    },
    {
        name: "building-tools",
        dir: join(BENCH_REPOS_DIR, "building-tools"),
        query: "how are undo and redo history entries recorded for part edits",
        grep: "History",
        sym: "History.record",
        file: "src/Client/State/History.luau",
    },
    {
        name: "z",
        dir: join(BENCH_REPOS_DIR, "z"),
        query: "how does the compiler resolve schema type references and wire bitwidths",
        grep: "resolve",
        sym: "resolve_schema",
        file: "compiler/src/resolve.rs",
    },
];

const FIXTURE_REPOS = [
    {
        name: "ts-service",
        fixture: true,
        dir: join(FIXTURES_DIR, "ts-service"),
        query: "how are JSON web token signatures verified with key rotation",
        grep: "TenantRateLimiter",
        sym: "TokenVerifier",
        file: "src/auth/token-verifier.ts",
    },
    {
        name: "py-worker",
        fixture: true,
        dir: join(FIXTURES_DIR, "py-worker"),
        query: "how are scheduled cron tasks ordered and dispatched by a priority heap",
        grep: "CheckpointStore",
        sym: "JobScheduler",
        file: "worker/scheduler.py",
    },
    {
        name: "go-engine",
        fixture: true,
        dir: join(FIXTURES_DIR, "go-engine"),
        query: "how are write ahead log records framed and validated against checksums",
        grep: "SegmentWriter",
        sym: "NewSegmentWriter",
        file: "internal/wal/segment.go",
    },
    {
        name: "luau-reactive",
        fixture: true,
        dir: join(FIXTURES_DIR, "luau-reactive"),
        query: "how do reactive signals derived values and effect listeners propagate updates",
        grep: "SessionLock",
        sym: "Graph.signal",
        file: "src/Graph.luau",
    },
    {
        name: "rust-compiler",
        fixture: true,
        dir: join(FIXTURES_DIR, "rust-compiler"),
        query: "where are schema type references checked for cycles and field bitwidths",
        grep: "SchemaDecl",
        sym: "parse_schema",
        file: "src/resolve.rs",
    },
    {
        name: "docs-polyglot",
        fixture: true,
        dir: join(FIXTURES_DIR, "docs-polyglot"),
        query: "how are dependency cycles detected and threshold health penalties evaluated",
        grep: "PipeCodec",
        sym: "SdkClient",
        file: "cli/health.js",
    },
];

/**
 * 24 natural-language developer intent queries (4 per repository across all 6
 * repositories) without leaked camelCase function names.
 */
const LOCAL_GOLD_QUERIES = [
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
        goldPath: "src/context/symbol-query.js",
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

const FIXTURE_GOLD_QUERIES = [
    // ts-service (TypeScript + JS + docs)
    {
        repo: "ts-service",
        query: "how are JSON web token signatures verified with key rotation and clock skew tolerance",
        goldPath: "src/auth/token-verifier.ts",
    },
    {
        repo: "ts-service",
        query: "where are webhook delivery failures retried using exponential backoff and jitter",
        goldPath: "src/billing/retry-queue.js",
    },
    {
        repo: "ts-service",
        query: "how is per tenant request throttling enforced using a sliding token bucket",
        goldPath: "src/http/rate-limiter.ts",
    },
    {
        repo: "ts-service",
        query: "where does the runbook explain idempotency keys and circuit breaker fallback behavior",
        goldPath: "docs/architecture.md",
    },
    // py-worker (Python + README)
    {
        repo: "py-worker",
        query: "how are scheduled cron tasks ordered and dispatched by a priority heap",
        goldPath: "worker/scheduler.py",
    },
    {
        repo: "py-worker",
        query: "how are crash recovery checkpoints flushed atomically using temporary file replacement",
        goldPath: "worker/checkpoint.py",
    },
    {
        repo: "py-worker",
        query: "where are duplicate incoming payloads filtered out via hash digests and expiration",
        goldPath: "worker/dedupe.py",
    },
    {
        repo: "py-worker",
        query: "how are percentile latency buckets aggregated across completed tasks",
        goldPath: "worker/metrics.py",
    },
    // go-engine (Go)
    {
        repo: "go-engine",
        query: "how are write ahead log records framed and validated against corruption checksums",
        goldPath: "internal/wal/segment.go",
    },
    {
        repo: "go-engine",
        query: "where are obsolete tombstone entries reclaimed during storage compaction",
        goldPath: "internal/wal/compact.go",
    },
    {
        repo: "go-engine",
        query: "how are randomized leader election timeouts and vote quorums tracked",
        goldPath: "internal/raft/election.go",
    },
    {
        repo: "go-engine",
        query: "how does probabilistic set membership avoid unnecessary disk table lookups",
        goldPath: "internal/index/bloom.go",
    },
    // luau-reactive (Luau)
    {
        repo: "luau-reactive",
        query: "how do reactive signals derived values and effect listeners propagate dependency updates",
        goldPath: "src/Graph.luau",
    },
    {
        repo: "luau-reactive",
        query: "where is harmonic spring velocity and damping step interpolation computed",
        goldPath: "src/Spring.luau",
    },
    {
        repo: "luau-reactive",
        query: "how are reversible canvas edits pushed onto undo and redo history stacks",
        goldPath: "src/History.luau",
    },
    {
        repo: "luau-reactive",
        query: "how are distributed session leases acquired and renewed against datastore conflicts",
        goldPath: "src/SessionLock.luau",
    },
    // rust-compiler (Rust + docs)
    {
        repo: "rust-compiler",
        query: "how are raw source characters scanned into lexical tokens and line spans",
        goldPath: "src/lexer.rs",
    },
    {
        repo: "rust-compiler",
        query: "how does the recursive descent pass assemble struct and union syntax trees",
        goldPath: "src/parser.rs",
    },
    {
        repo: "rust-compiler",
        query: "where are schema type references checked for cycles and field bitwidths computed",
        goldPath: "src/resolve.rs",
    },
    {
        repo: "rust-compiler",
        query: "how does code generation produce binary serialization pack and unpack routines",
        goldPath: "src/emit.rs",
    },
    // docs-polyglot (TS + Python + JS + docs)
    {
        repo: "docs-polyglot",
        query: "how does the client manage persistent connection pooling and structured error mapping",
        goldPath: "sdk/client.ts",
    },
    {
        repo: "docs-polyglot",
        query: "where are length prefixed JSON messages framed and decoded over IPC pipes",
        goldPath: "bridge/codec.py",
    },
    {
        repo: "docs-polyglot",
        query: "how are dependency cycles detected and threshold health penalties evaluated",
        goldPath: "cli/health.js",
    },
    {
        repo: "docs-polyglot",
        query: "what does the troubleshooting playbook advise for pipe EOF errors and stale locks",
        goldPath: "docs/troubleshooting.md",
    },
];

function hasValidLocalCorpus() {
    const repoMap = new Map(LOCAL_REPOS.map((r) => [r.name, r]));
    for (const r of LOCAL_REPOS) {
        if (!existsSync(r.dir) || !existsSync(join(r.dir, r.file)))
            return false;
    }
    for (const q of LOCAL_GOLD_QUERIES) {
        const r = repoMap.get(q.repo);
        if (!r || !existsSync(join(r.dir, q.goldPath)))
            return false;
    }
    return true;
}

const forceFixtures = process.argv.includes("--fixtures") || process.env.PLEXER_BENCH_FIXTURES === "1";
const forceLocal = process.argv.includes("--local") || process.env.PLEXER_BENCH_LOCAL === "1";
const useLocalCorpus = !forceFixtures && (forceLocal || hasValidLocalCorpus());
const corpusKind = useLocalCorpus ? "local" : "fixtures";
const REPOS = useLocalCorpus ? LOCAL_REPOS : FIXTURE_REPOS;
const GOLD_QUERIES = useLocalCorpus ? LOCAL_GOLD_QUERIES : FIXTURE_GOLD_QUERIES;

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

function repoContextDir(r) {
    if (r.fixture)
        return join(tmpdir(), "plexer-bench-cache", "fixtures", r.name, "plexer");
    const inTree = join(r.dir, "plexer");
    if (existsSync(inTree))
        return inTree;
    return join(tmpdir(), "plexer-bench-cache", r.name, "plexer");
}

async function benchRepo(r) {
    if (!existsSync(r.dir))
        return null;
    const outDir = repoContextDir(r);
    await buildGraph(r.dir, { contextDir: outDir, graphOnly: true });

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
    grepGraph(graph, r.dir, r.grep, { fixed: true });
    const warmSyms = resolveSymbol(graph, r.sym);
    if (warmSyms[0])
        edgeWalk(graph, warmSyms[0], "in", 2);
    skeleton(r.dir, r.file, { contextDir: outDir });
    buildRepoMap(graph);
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

async function benchTrailComparison() {
    if (corpusKind !== "local")
        return null;
    const trailDist = "/tmp/trail-eval/node_modules/@trailhq/trail-code/dist";
    if (!existsSync(trailDist))
        return null;
    const tAskMod = await import(`${trailDist}/ask/ask.js`);
    const tGrepMod = await import(`${trailDist}/search/grep.js`);
    const tTravMod = await import(`${trailDist}/graph/traverse.js`);
    const tMapMod = await import(`${trailDist}/graph/map.js`);
    const tLoadMod = await import(`${trailDist}/graph/load.js`);
    const tBuildMod = await import(`${trailDist}/graph/build.js`);
    const tCheckMod = await import(`${trailDist}/graph/check.js`);
    const tSkillMod = await import(`${trailDist}/claude/skill-template.js`);
    const { skillTemplate: plexerSkillTemplate } = await import("../src/claude/shim-template.js");

    const pRaw = typeof plexerSkillTemplate === "function" ? plexerSkillTemplate() : String(plexerSkillTemplate || "");
    const tRaw = typeof tSkillMod.skillTemplate === "function" ? tSkillMod.skillTemplate() : String(tSkillMod.skillTemplate || "");
    const plexerSkillBytes = Buffer.byteLength(pRaw.replace(/^---\n[\s\S]*?\n---\n+/, "").trim(), "utf8");
    const trailSkillBytes = Buffer.byteLength(tRaw.replace(/^---\n[\s\S]*?\n---\n+/, "").trim(), "utf8");

    const sharedRepos = REPOS.filter((r) => existsSync(`/tmp/trail-repos/${r.name}/graft`));
    const trailEngine = [];
    for (const r of sharedRepos) {
        const dir = `/tmp/trail-repos/${r.name}`;
        const outDir = `${dir}/graft`;
        await tBuildMod.buildGraph(dir, { contextDir: outDir, graphOnly: true });
        const tB0 = performance.now();
        await tBuildMod.buildGraph(dir, { contextDir: outDir, graphOnly: true });
        const warmBuildMs = performance.now() - tB0;
        const tC0 = performance.now();
        await tCheckMod.checkGraph(dir, { contextDir: outDir });
        const checkMs = performance.now() - tC0;
        const g = tLoadMod.loadGraphCached(outDir);
        tAskMod.ask(dir, r.query, { contextDir: outDir, source: true });
        tGrepMod.grepGraph(g, dir, r.grep, { fixed: true });
        const wSyms = tTravMod.resolveSymbol(g, r.sym);
        if (wSyms[0])
            tTravMod.edgeWalk(g, wSyms[0], "in", 2);
        tAskMod.skeleton(dir, r.file, { contextDir: outDir });
        tMapMod.buildRepoMap(g);
        const N = 8;
        let tAskSrc = 0;
        let askSrcOut = "";
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            askSrcOut = tAskMod.formatAsk(tAskMod.ask(dir, r.query, { contextDir: outDir, source: true }));
            tAskSrc += performance.now() - t0;
        }
        let tAskNoSrc = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            tAskMod.formatAsk(tAskMod.ask(dir, r.query, { contextDir: outDir, source: false }));
            tAskNoSrc += performance.now() - t0;
        }
        let tGrep = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            tGrepMod.grepGraph(g, dir, r.grep, { fixed: true });
            tGrep += performance.now() - t0;
        }
        let tCallers = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            const syms = tTravMod.resolveSymbol(g, r.sym);
            if (syms[0])
                tTravMod.edgeWalk(g, syms[0], "in", 2);
            tCallers += performance.now() - t0;
        }
        let tSkel = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            tAskMod.formatSkeleton(tAskMod.skeleton(dir, r.file, { contextDir: outDir }));
            tSkel += performance.now() - t0;
        }
        let tMap = 0;
        for (let i = 0; i < N; i++) {
            const t0 = performance.now();
            tMapMod.formatRepoMap(tMapMod.buildRepoMap(g));
            tMap += performance.now() - t0;
        }
        const wiringBytes = statSync(join(outDir, ".graph", "wiring.json")).size;
        trailEngine.push({
            name: r.name,
            nodes: g.nodes.length,
            edges: g.edges.length,
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
        });
    }

    let tHits1 = 0, tHits3 = 0, tHits5 = 0, tRr = 0;
    let tShared1 = 0, tShared3 = 0, tShared5 = 0, tSharedRr = 0, sharedTotal = 0;
    let pShared1 = 0, pShared3 = 0, pShared5 = 0, pSharedRr = 0;
    for (let idx = 0; idx < GOLD_QUERIES.length; idx++) {
        const q = GOLD_QUERIES[idx];
        const pRank = retrieval.details[idx]?.rank ?? 0;
        const dir = `/tmp/trail-repos/${q.repo}`;
        const outDir = `${dir}/graft`;
        const isShared = existsSync(join(outDir, ".graph", "wiring.json"));
        let rank = 0;
        if (isShared) {
            sharedTotal++;
            if (pRank === 1) pShared1++;
            if (pRank > 0 && pRank <= 3) pShared3++;
            if (pRank > 0 && pRank <= 5) pShared5++;
            if (pRank > 0) pSharedRr += 1 / pRank;
            const res = tAskMod.ask(dir, q.query, { contextDir: outDir, limit: 5 });
            for (let i = 0; i < (res.hits || []).length; i++) {
                const h = res.hits[i];
                const ptrLower = String(h.pointer || "").toLowerCase();
                const titleLower = String(h.title || "").toLowerCase();
                const pathOk = q.goldPath ? ptrLower.includes(q.goldPath.toLowerCase()) : true;
                const symOk = q.goldSym ? titleLower.includes(q.goldSym.toLowerCase()) : true;
                if (pathOk && symOk) {
                    rank = i + 1;
                    break;
                }
            }
            if (rank === 1) tShared1++;
            if (rank > 0 && rank <= 3) tShared3++;
            if (rank > 0 && rank <= 5) tShared5++;
            if (rank > 0) tSharedRr += 1 / rank;
        }
        if (rank === 1) tHits1++;
        if (rank > 0 && rank <= 3) tHits3++;
        if (rank > 0 && rank <= 5) tHits5++;
        if (rank > 0) tRr += 1 / rank;
    }

    return {
        skillFootprint: {
            plexerBytes: plexerSkillBytes,
            plexerBpeTok: Math.ceil(plexerSkillBytes / 3.3),
            trailBytes: trailSkillBytes,
            trailBpeTok: Math.ceil(trailSkillBytes / 3.3),
        },
        trailEngine,
        trailRetrievalAll24: {
            total: GOLD_QUERIES.length,
            recallAt1: +(tHits1 / GOLD_QUERIES.length).toFixed(3),
            recallAt3: +(tHits3 / GOLD_QUERIES.length).toFixed(3),
            recallAt5: +(tHits5 / GOLD_QUERIES.length).toFixed(3),
            mrr: +(tRr / GOLD_QUERIES.length).toFixed(3),
        },
        sharedRetrieval8: {
            total: sharedTotal,
            plexer: {
                recallAt1: +(pShared1 / (sharedTotal || 1)).toFixed(3),
                recallAt3: +(pShared3 / (sharedTotal || 1)).toFixed(3),
                recallAt5: +(pShared5 / (sharedTotal || 1)).toFixed(3),
                mrr: +(pSharedRr / (sharedTotal || 1)).toFixed(3),
            },
            trail: {
                recallAt1: +(tShared1 / (sharedTotal || 1)).toFixed(3),
                recallAt3: +(tShared3 / (sharedTotal || 1)).toFixed(3),
                recallAt5: +(tShared5 / (sharedTotal || 1)).toFixed(3),
                mrr: +(tSharedRr / (sharedTotal || 1)).toFixed(3),
            },
        },
    };
}

const trailComparison = await benchTrailComparison();
const askGateMs = Number(process.env.PLEXER_BENCH_MAX_ASK_MS || 25);
const maxAskSourceMs = repoMetrics.length > 0 ? Math.max(...repoMetrics.map((m) => m.askSourceMs)) : Infinity;
const gateEnforced = corpusKind === "fixtures" || process.argv.includes("--gate");
const gatePassed =
    repoMetrics.length === REPOS.length &&
    retrieval.total === GOLD_QUERIES.length &&
    retrieval.recallAt1 === 1 &&
    retrieval.mrr === 1 &&
    maxAskSourceMs < askGateMs;
const gate = {
    corpus: corpusKind,
    enforced: gateEnforced,
    passed: gatePassed,
    maxAskSourceMs: +maxAskSourceMs.toFixed(2),
    askGateMs,
    recallAt1: retrieval.recallAt1,
    mrr: retrieval.mrr,
};

if (gateEnforced && !gatePassed) {
    process.exitCode = 1;
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ corpus: corpusKind, repoMetrics, retrieval, gate, trailComparison }, null, 2));
} else {
    console.log(`# Plexer Engine Benchmark (corpus: ${corpusKind})\n`);
    console.log("## 1. Latency & Token Budgets by Repository\n");
    console.log("| Repo | Nodes / Edges | `wiring.json` | Warm Refresh | `check` | `ask --source` | `ask` | `grep` | `callers` | `skeleton` | `map` | `ask --source` Tokens (vs `--full` / vs Raw Files) |");
    console.log("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const m of repoMetrics) {
        const vsFullDiff = m.askFullTokens > 0
            ? Math.round(((m.askSourceTokens - m.askFullTokens) / m.askFullTokens) * 100)
            : 0;
        const vsFullStr = vsFullDiff > 0 ? `+${vsFullDiff}%` : `${vsFullDiff}%`;
        const vsRawDiff = m.rawTopFilesTokens > 0
            ? Math.round(((m.askSourceTokens - m.rawTopFilesTokens) / m.rawTopFilesTokens) * 100)
            : 0;
        const vsRawStr = vsRawDiff > 0 ? `+${vsRawDiff}%` : `${vsRawDiff}%`;
        console.log(
            `| \`${m.name}\` | ${m.nodes.toLocaleString()} / ${m.edges.toLocaleString()} | ${m.wiringKB} KB | ${m.warmBuildMs}ms | ${m.checkMs}ms | **${m.askSourceMs}ms** | ${m.askNoSourceMs}ms | ${m.grepMs}ms | ${m.callersMs}ms | ${m.skeletonMs}ms | ${m.mapMs}ms | **${m.askSourceTokens}** (${vsFullStr} vs ${m.askFullTokens} full, ${vsRawStr} vs ${m.rawTopFilesTokens} raw) |`,
        );
    }
    console.log(`\n## 2. Retrieval Accuracy (${retrieval.total} De-Leaked Intent Queries across ${repoMetrics.length} Repos)\n`);
    console.log(`- **Recall@1**: ${(retrieval.recallAt1 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank === 1).length}/${retrieval.total})`);
    console.log(`- **Recall@3**: ${(retrieval.recallAt3 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank > 0 && d.rank <= 3).length}/${retrieval.total})`);
    console.log(`- **Recall@5**: ${(retrieval.recallAt5 * 100).toFixed(1)}% (${retrieval.details.filter((d) => d.rank > 0 && d.rank <= 5).length}/${retrieval.total})`);
    console.log(`- **MRR**: ${retrieval.mrr.toFixed(3)}`);
    console.log(`- **Gate**: ${gatePassed ? "PASS" : "FAIL"} (corpus=${corpusKind}, max \`ask --source\`=${gate.maxAskSourceMs}ms < ${askGateMs}ms, Recall@1=${(retrieval.recallAt1 * 100).toFixed(1)}%, MRR=${retrieval.mrr.toFixed(3)})`);
    const misses = retrieval.details.filter((d) => d.rank !== 1);
    if (misses.length > 0) {
        console.log("\n### Non-Rank-1 Queries:");
        for (const d of misses) {
            console.log(`- [${d.repo}] "${d.query}" → rank ${d.rank} (top: ${d.topHit})`);
        }
    }
    if (trailComparison) {
        const sf = trailComparison.skillFootprint;
        const sfPct = Math.round((1 - sf.plexerBytes / sf.trailBytes) * 100);
        console.log("\n## 3. Head-to-Head vs `@trailhq/trail-code@0.25.0`\n");
        console.log(`- **Turn-0 Skill Footprint (\`SKILL.md\` body)**: Plexer **${sf.plexerBytes} B (~${sf.plexerBpeTok} tok)** vs Trail **${sf.trailBytes} B (~${sf.trailBpeTok} tok)** (**-${sfPct}%** smaller)`);
        console.log(`- **Retrieval Across All 24 Queries (6 Repos)**: Plexer **Recall@1 ${(retrieval.recallAt1 * 100).toFixed(1)}% / MRR ${retrieval.mrr.toFixed(3)}** vs Trail **Recall@1 ${(trailComparison.trailRetrievalAll24.recallAt1 * 100).toFixed(1)}% / MRR ${trailComparison.trailRetrievalAll24.mrr.toFixed(3)}**`);
        console.log(`- **Retrieval on Shared Repos (\`plexer\` + \`z\`, 8 Queries)**: Plexer **Recall@1 ${(trailComparison.sharedRetrieval8.plexer.recallAt1 * 100).toFixed(1)}% / MRR ${trailComparison.sharedRetrieval8.plexer.mrr.toFixed(3)}** vs Trail **Recall@1 ${(trailComparison.sharedRetrieval8.trail.recallAt1 * 100).toFixed(1)}% / MRR ${trailComparison.sharedRetrieval8.trail.mrr.toFixed(3)}**\n`);
        console.log("| Repo / Engine | Nodes / Edges | Warm Refresh | `check` | `ask --source` | `ask` | `grep` | `callers` | `skeleton` | `map` | `ask --source` Tokens |");
        console.log("| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
        for (const tm of trailComparison.trailEngine) {
            const pm = repoMetrics.find((m) => m.name === tm.name);
            if (pm) {
                console.log(`| \`${pm.name}\` (**plexer**) | **${pm.nodes.toLocaleString()} / ${pm.edges.toLocaleString()}** | **${pm.warmBuildMs}ms** | **${pm.checkMs}ms** | **${pm.askSourceMs}ms** | **${pm.askNoSourceMs}ms** | **${pm.grepMs}ms** | **${pm.callersMs}ms** | **${pm.skeletonMs}ms** | **${pm.mapMs}ms** | **${pm.askSourceTokens}** |`);
            }
            console.log(`| \`${tm.name}\` (trail@0.25.0) | ${tm.nodes.toLocaleString()} / ${tm.edges.toLocaleString()} | ${tm.warmBuildMs}ms | ${tm.checkMs}ms | ${tm.askSourceMs}ms | ${tm.askNoSourceMs}ms | ${tm.grepMs}ms | ${tm.callersMs}ms | ${tm.skeletonMs}ms | ${tm.mapMs}ms | ${tm.askSourceTokens} |`);
        }
    }
}
