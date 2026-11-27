import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildGraph, health } from "../src/index.js";
import { startVizServer, getCachedCodeGraphPayload, getCachedTreemapPayload } from "../src/viz/serve.js";
import { exportViz } from "../src/viz/export.js";
import { attachDaemonShutdownHooks, createSidecarHandlers, parseEnvWorkspacePaths } from "../sidecars/viz/main.mjs";
import { buildAgyContextGraph, locateSwarmRoster } from "../src/agy/context-graph.js";
import { extractPatchSymbols } from "../bench/run-swebench-ab.js";
import { parseInjection } from "../bench/needcov.js";
import { RESULT_FILES } from "../bench/cost-model.js";
import { LOG_ROOTS, needsFromTranscript, readsFromBash } from "../bench/replay.js";

const CLEANUP_DIRS = [];
const VIEWER_DIR = new URL("../src/viewer/", import.meta.url).pathname;

function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    CLEANUP_DIRS.push(dir);
    return dir;
}

function initGitCommit(repoDir, msg = "init") {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", msg], { cwd: repoDir });
}

function rawHttpGet(port, path, headers = {}) {
    return new Promise((resolveReq, rejectReq) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                resolveReq({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", rejectReq);
        req.end();
    });
}

after(() => {
    for (const d of CLEANUP_DIRS) {
        rmSync(d, { recursive: true, force: true });
    }
});

describe("Wave 5: Visualizer, Sidecar, Context-Graph & Benchmark Tooling", () => {
    it("rejects portless Host: localhost and caches /api/code-graph + /api/treemap with ETag/304 in serve.js", async () => {
        const repo = makeTempDir("plexer-w5-serve-");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "alpha.js"), "export function alpha() { return 1; }\n", "utf8");
        initGitCommit(repo);
        await buildGraph(repo, { force: true });
        health(repo, { action: "scan" });

        const srv = await startVizServer({
            root: repo,
            contextDir: join(repo, "plexer"),
            viewerDir: VIEWER_DIR,
            port: 0,
        });
        try {
            const portless = await rawHttpGet(srv.port, "/api/code-graph", { Host: "localhost" });
            assert.equal(portless.status, 403, "portless Host: localhost must be rejected with 403");

            const badPort = await rawHttpGet(srv.port, "/api/code-graph", { Host: "127.0.0.1:9999" });
            assert.equal(badPort.status, 403, "mismatched port Host header must be rejected with 403");

            const cg1 = await rawHttpGet(srv.port, "/api/code-graph", { Host: `localhost:${srv.port}` });
            assert.equal(cg1.status, 200);
            assert.ok(cg1.headers.etag, "/api/code-graph must emit an ETag");
            const cg304 = await rawHttpGet(srv.port, "/api/code-graph", {
                Host: `127.0.0.1:${srv.port}`,
                "If-None-Match": cg1.headers.etag,
            });
            assert.equal(cg304.status, 304, "/api/code-graph must return 304 on matching ETag");

            const tm1 = await rawHttpGet(srv.port, "/api/treemap", { Host: `127.0.0.1:${srv.port}` });
            assert.equal(tm1.status, 200);
            assert.ok(tm1.headers.etag, "/api/treemap must emit an ETag");
            const tm304 = await rawHttpGet(srv.port, "/api/treemap", {
                Host: `127.0.0.1:${srv.port}`,
                "If-None-Match": tm1.headers.etag,
            });
            assert.equal(tm304.status, 304, "/api/treemap must return 304 on matching ETag");

            const cacheEntry1 = getCachedCodeGraphPayload(join(repo, "plexer"));
            const cacheEntry2 = getCachedCodeGraphPayload(join(repo, "plexer"));
            assert.strictEqual(cacheEntry1, cacheEntry2, "code-graph cache must return identical cached entry when unchanged");

            const tmCache1 = getCachedTreemapPayload(repo, join(repo, "plexer"));
            const tmCache2 = getCachedTreemapPayload(repo, join(repo, "plexer"));
            assert.strictEqual(tmCache1, tmCache2, "treemap cache must return identical cached entry when unchanged");
        } finally {
            await srv.close();
        }
    });

    it("omits treemap HTML/JSON in exportViz when explicit tabs exclude treemap", async () => {
        const repo = makeTempDir("plexer-w5-export-");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "item.ts"), "export function runItem(): number { return 42; }\n", "utf8");
        initGitCommit(repo);
        await buildGraph(repo, { force: true });
        health(repo, { action: "scan" });

        const outNoTm = makeTempDir("plexer-w5-export-notm-");
        const resNoTm = exportViz({
            contextDir: join(repo, "plexer"),
            viewerDir: VIEWER_DIR,
            outDir: outNoTm,
            repoName: "demo",
            tabs: ["context"],
        });
        const pageNoTm = readFileSync(resNoTm.file, "utf8");
        assert.ok(pageNoTm.includes("treemapHtml: null"), "non-treemap export must not embed treemap HTML");
        assert.equal(pageNoTm.includes('id="tree-data"'), false, "non-treemap export must not duplicate treemap tree-data JSON");
    });

    it("fixes sidecar env root parsing, sub-repo authorization with indexed ancestor, caching, and shutdown hooks", async () => {
        assert.deepEqual(
            parseEnvWorkspacePaths({ ANTIGRAVITY_WORKSPACE_PATHS: "/repo/a:/repo/b" }),
            ["/repo/a", "/repo/b"],
        );
        assert.deepEqual(
            parseEnvWorkspacePaths({ ANTIGRAVITY_WORKSPACE_PATHS: "file:///repo/a,file:///repo/b" }),
            ["file:///repo/a", "file:///repo/b"],
        );

        const parent = makeTempDir("plexer-w5-parent-");
        const subrepo = join(parent, "packages", "subapp");
        mkdirSync(join(parent, "src"), { recursive: true });
        mkdirSync(join(subrepo, "src"), { recursive: true });
        writeFileSync(join(parent, "src", "root.js"), "export function rootFn() { return 1; }\n", "utf8");
        writeFileSync(join(subrepo, "src", "sub.js"), "export function subFn() { return 2; }\n", "utf8");
        initGitCommit(parent);
        await buildGraph(parent, { force: true });
        await buildGraph(subrepo, { force: true });
        health(subrepo, { action: "scan" });

        class MockResponse {
            constructor(body, init = {}) {
                this.body = body;
                this.contentType = init.contentType || "text/plain";
                this.status = init.status ?? 200;
                this.headers = init.headers || {};
            }
        }
        const handlers = createSidecarHandlers({
            ResponseClass: MockResponse,
            allowedRoots: [subrepo],
            strictWs: true,
        });

        const allowed = handlers.apis["/api/rev"]({ ws: join(subrepo, "src", "sub.js") });
        assert.equal(allowed.status, undefined, "valid sub-repo inside allowedRoots must not return 403 even when ancestor has plexer index");
        assert.ok(allowed.rev, "valid sub-repo must return rev");

        const rejectedParent = handlers.apis["/api/rev"]({ ws: parent });
        assert.equal(rejectedParent.status, 403, "ancestor outside allowedRoots must still be rejected with 403");

        const cgResp = handlers.apis["/api/code-graph"]({ ws: subrepo });
        assert.equal(cgResp.status, 200);
        assert.ok(cgResp.headers.etag, "sidecar /api/code-graph must include ETag");

        const tmResp = handlers.apis["/api/treemap"]({ ws: subrepo });
        assert.equal(tmResp.status, 200);
        assert.ok(tmResp.headers.etag, "sidecar /api/treemap must include ETag");

        // Verify attachDaemonShutdownHooks calls close() and removes socket on SIGTERM
        const fakeSockDir = makeTempDir("plexer-w5-sock-");
        const fakeSock = join(fakeSockDir, "daemon.sock");
        writeFileSync(fakeSock, "", "utf8");
        let closed = false;
        let exitCode = null;
        const fakeProc = new EventEmitter();
        fakeProc.exit = (code) => { exitCode = code; };
        const fakeDaemon = {
            socketPath: fakeSock,
            alreadyRunning: false,
            close: async () => { closed = true; },
        };
        attachDaemonShutdownHooks(fakeDaemon, fakeProc);
        fakeProc.emit("SIGTERM", "SIGTERM");
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(closed, true, "SIGTERM shutdown hook must call daemon.close()");
        assert.equal(existsSync(fakeSock), false, "SIGTERM shutdown hook must clean up daemon socket");
        assert.equal(exitCode, 143);
    });

    it("supports skipBrainScan, stale >24h roster pruning, incremental transcript offset, and _outEdges in context-graph.js", async () => {
        const appData = makeTempDir("plexer-w5-cg-app-");
        const coordId = "coord-w5";
        const workerId = "worker-w5";
        const swarmDir = join(appData, "brain", coordId, ".system_generated", "swarm");
        mkdirSync(swarmDir, { recursive: true });
        const membersPath = join(swarmDir, "members.json");
        writeFileSync(membersPath, JSON.stringify({
            title: "W5",
            members: { w1: { conversation_id: workerId, role: "worker", state: "working" } },
        }), "utf8");

        assert.equal(
            locateSwarmRoster(workerId, { appDataDirs: [appData], skipBrainScan: true }),
            null,
            "skipBrainScan: true must skip brain sweep when directMembers is absent",
        );
        const foundFresh = locateSwarmRoster(workerId, [appData]);
        assert.equal(foundFresh?.coordinatorId, coordId, "fresh worker roster must still resolve");

        // Mark members.json stale (> 25 hours old) and verify it is pruned on next brain scan
        const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(membersPath, staleDate, staleDate);
        utimesSync(join(appData, "brain"), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
        assert.equal(
            locateSwarmRoster(workerId, [appData]),
            null,
            "stale (>24h) swarm roster entries must be ignored",
        );

        // Incremental transcript offset + _outEdges file edge generation
        const repo = makeTempDir("plexer-w5-cg-repo-");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "a.js"), 'import { b } from "./b.js";\nexport function a() { return b(); }\n', "utf8");
        writeFileSync(join(repo, "src", "b.js"), "export function b() { return 1; }\n", "utf8");
        initGitCommit(repo);
        await buildGraph(repo, { force: true });

        const txAppData = makeTempDir("plexer-w5-tx-app-");
        const txCoord = "coord-tx";
        const txWorker = "worker-tx";
        mkdirSync(join(txAppData, "brain", txCoord, ".system_generated", "swarm"), { recursive: true });
        writeFileSync(join(txAppData, "brain", txCoord, ".system_generated", "swarm", "members.json"), JSON.stringify({
            title: "Incremental",
            members: { alpha: { conversation_id: txWorker, role: "author", state: "working" } },
        }), "utf8");
        const txLog = join(txAppData, "brain", txWorker, ".system_generated", "logs", "transcript.jsonl");
        mkdirSync(join(txLog, ".."), { recursive: true });
        writeFileSync(txLog, JSON.stringify({ tool_calls: [{ name: "write_file", args: { Path: join(repo, "src", "a.js") } }] }) + "\n", "utf8");

        const cg1 = buildAgyContextGraph({ repoRoot: repo, sid: txCoord, appDataDirs: [txAppData] });
        assert.ok(cg1.nodes.some((n) => n.relFile === "src/a.js" && n.type === "changed"));

        // Append second line + partial incomplete line, then complete it
        writeFileSync(
            txLog,
            readFileSync(txLog, "utf8") +
            JSON.stringify({ tool_calls: [{ name: "read_file", args: { Path: join(repo, "src", "b.js") } }] }) + "\n" +
            '{"tool_calls":[{"name":"read_file"',
            "utf8",
        );
        const cg2 = buildAgyContextGraph({ repoRoot: repo, sid: txCoord, appDataDirs: [txAppData] });
        assert.ok(cg2.nodes.some((n) => n.relFile === "src/a.js"), "incremental cache must preserve earlier touches");
        assert.ok(cg2.nodes.some((n) => n.relFile === "src/b.js"), "incremental delta must parse newly appended line");
        assert.ok(cg2.edges.some((e) => e.source.includes("src/a.js") && e.target.includes("src/b.js")), "_outEdges must link active files");
    });

    it("uses iterative Tarjan SCC in src/viewer/app.js without stack overflow on deep chains", () => {
        const appSrc = readFileSync(new URL("../src/viewer/app.js", import.meta.url), "utf8");
        const match = appSrc.match(/function computeGraphCycles\(\) \{[\s\S]*?\n\}/);
        assert.ok(match, "computeGraphCycles must exist in src/viewer/app.js");
        assert.equal(/function strongConnect\b/.test(match[0]), false, "recursive strongConnect must be replaced with iterative stack");

        const N = 3500;
        const nodes = [];
        const edges = [];
        const adjOut = new Map();
        for (let i = 0; i < N; i++) {
            const id = `n${i}`;
            nodes.push({ id });
            adjOut.set(id, i + 1 < N ? [`n${i + 1}`] : []);
            if (i + 1 < N) edges.push({ source: id, target: `n${i + 1}` });
        }
        // Add a 3-node cycle at the bottom of the 3500-node deep chain
        adjOut.get(`n${N - 1}`).push(`n${N - 3}`);
        edges.push({ source: `n${N - 1}`, target: `n${N - 3}` });

        const state = {
            nodes,
            edges,
            adjOut,
            cycleNodeIds: new Set(),
            cycleEdgeKeys: new Set(),
            highlightCycles: true,
        };
        const ctx = vm.createContext({ state, Map, Set });
        vm.runInContext(`${match[0]}; computeGraphCycles();`, ctx);
        assert.equal(state.cycleNodeIds.size, 3, "iterative Tarjan SCC must find the 3-node cycle at depth 3500");
        assert.ok(state.cycleNodeIds.has(`n${N - 1}`));
        assert.ok(state.cycleNodeIds.has(`n${N - 2}`));
        assert.ok(state.cycleNodeIds.has(`n${N - 3}`));
        assert.equal(state.cycleEdgeKeys.size, 3);

        // Verify viewer polling in-flight guard, EventSource teardown, LRU caps, spatialGrid physics rebuild, and lazy outline
        assert.match(appSrc, /if \(!sidecarState\.active \|\| document\.hidden \|\| sidecarState\.revInFlight\) return;/);
        assert.match(appSrc, /window\.addEventListener\("beforeunload", closeEs\)/);
        assert.match(appSrc, /window\.addEventListener\("pagehide", closeEs\)/);
        assert.match(appSrc, /const MAX_LAYOUT_CACHE = \d+;/);
        assert.match(appSrc, /const MAX_SOURCE_CACHE = \d+;/);
        assert.match(appSrc, /const MAX_LABEL_WIDTH_CACHE = \d+;/);
        assert.match(appSrc, /function stepPhysics\(\) \{[\s\S]*?const maxDist2 = cellSize \* cellSize;\s+populateSpatialGrid\(\);/);
        assert.match(appSrc, /function buildOutlineDirBodyHtml[\s\S]*?if \(!fileCollapsed\) \{\s*html\.push\(buildOutlineFileSymbolsHtml\(syms\)\);/);
    });

    it("fixes extractPatchSymbols, grade.js planReviews, needcov.js, cost-model.js, replay.js, and eval-fast T5 oracle", async () => {
        // 1. extractPatchSymbols excludes stdlib .map/.includes/.isArray and keeps real definitions
        const patch = [
            "diff --git a/src/posts/queue.js b/src/posts/queue.js",
            "--- a/src/posts/queue.js",
            "+++ b/src/posts/queue.js",
            "@@ -10,6 +10,12 @@ Posts.addToQueue = async function (data) {",
            "+const ids = items.map((x) => x.id);",
            "+if (Array.isArray(ids) && ids.includes(1)) {",
            "+export async function mergeQueuePosts(items) {",
            "+    return items;",
            "+}",
        ].join("\n");
        const syms = extractPatchSymbols(patch);
        assert.ok(syms.all.includes("mergeQueuePosts"), "must extract declared function");
        assert.equal(syms.all.includes("map"), false, "must NOT extract .map( stdlib call");
        assert.equal(syms.all.includes("isArray"), false, "must NOT extract Array.isArray( call");
        assert.equal(syms.all.includes("includes"), false, "must NOT extract .includes( call");

        // 2. grade.js deduplicates planReviews on enter_plan_mode + [plan review] banner
        const tmp = makeTempDir("plexer-w5-bench-");
        const fakeHome = join(tmp, "home");
        const sid = "conv-plan-dedup";
        const logDir = join(fakeHome, ".gemini", "antigravity", "brain", sid, ".system_generated", "logs");
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, "transcript_full.jsonl"), [
            JSON.stringify({ type: "USER_INPUT", created_at: "2026-01-01T00:00:00Z", content: "Plan this" }),
            JSON.stringify({
                type: "PLANNER_RESPONSE",
                created_at: "2026-01-01T00:00:01Z",
                tool_calls: [{ name: "enter_plan_mode", args: {} }],
            }),
            JSON.stringify({ type: "SYSTEM_MESSAGE", created_at: "2026-01-01T00:00:02Z", content: "[plan review] please inspect" }),
            JSON.stringify({
                type: "PLANNER_RESPONSE",
                created_at: "2026-01-01T00:00:03Z",
                tool_calls: [{ name: "exit_plan_mode", args: {} }],
            }),
            // Second distinct plan review cycle
            JSON.stringify({
                type: "PLANNER_RESPONSE",
                created_at: "2026-01-01T00:00:04Z",
                tool_calls: [{ name: "enter_plan_mode", args: {} }],
            }),
            JSON.stringify({ type: "SYSTEM_MESSAGE", created_at: "2026-01-01T00:00:05Z", content: "[plan review due]" }),
        ].join("\n") + "\n", "utf8");
        const prevHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            // Re-import grade.js only needed if BRAIN_DIR captured HOME at load time; check direct parseTranscript if HOME matches
            const gradeSrc = readFileSync(new URL("../bench/grade.js", import.meta.url), "utf8");
            assert.match(gradeSrc, /pendingPlanReviewFromTool/, "grade.js must deduplicate planReviews");
        } finally {
            process.env.HOME = prevHome;
        }
        // Test parseTranscript via fresh subprocess so HOME is picked up by BRAIN_DIR
        const gradedJson = execFileSync(
            process.execPath,
            ["-e", `import { parseTranscript } from "./bench/grade.js"; console.log(JSON.stringify(parseTranscript(${JSON.stringify(sid)}, "plexer")));`],
            { env: { ...process.env, HOME: fakeHome }, encoding: "utf8" },
        );
        const graded = JSON.parse(gradedJson);
        assert.equal(graded.planReviews, 2, "each enter_plan_mode + [plan review] transition must count once, not twice");
        assert.equal(graded.planHandoffs, 1);

        // 3. needcov.js allows digits in extensions & resets cur on blank/non-matching headers
        const parsedInj = parseInjection([
            "1. main: src/app.py3:L10-L12",
            "L10: def main():",
            "",
            "2. unknown section without file pointer",
            "L99: should_not_attach_to_py3()",
            "### Another header",
            "L100: also_ignored()",
            "2. helper — src/lib.es6:L5-L7",
            "L5: export const x = 1;",
        ].join("\n"));
        assert.ok(parsedInj.ptrs.has("src/app.py3"), "PTR must match extensions with digits like .py3");
        assert.ok(parsedInj.ptrs.has("src/lib.es6"), "PTR must match extensions with digits like .es6");
        assert.deepEqual([...parsedInj.inl.get("src/app.py3")], [10], "blank/non-matching headers must reset cur");
        assert.deepEqual([...parsedInj.inl.get("src/lib.es6")], [5]);

        // 4. cost-model.js includes large opus/sonnet files
        assert.ok(RESULT_FILES.opus.includes("results-large-opus.json"));
        assert.ok(RESULT_FILES.sonnet.includes("results-large-sonnet.json"));

        // 5. replay.js supports tail and AGY logs
        assert.ok(LOG_ROOTS.some((r) => r.dir === "/tmp/plexer-agy-logs"), "LOG_ROOTS must include /tmp/plexer-agy-logs");
        assert.deepEqual(readsFromBash("tail -n +50 src/a.js | head -n 20", null), [{ file: "src/a.js", a: 50, b: 69 }]);
        assert.deepEqual(readsFromBash("tail -n 15 src/b.js", null), [{ file: "src/b.js", a: null, b: null }]);
        const agyTx = join(tmp, "agy-replay.jsonl");
        writeFileSync(agyTx, [
            JSON.stringify({
                type: "PLANNER_RESPONSE",
                tool_calls: [
                    { name: "read_file", args: { Path: "src/x.js", StartLine: 10, EndLine: 25 } },
                    { name: "run_command", args: { CommandLine: "grep -n foo src/y.js" } },
                ],
            }),
            JSON.stringify({ type: "GENERIC", content: "Created At: t\nCompleted At: t\n14:const foo = 1;\n" }),
        ].join("\n") + "\n", "utf8");
        const agyNeeds = needsFromTranscript(agyTx);
        assert.deepEqual(agyNeeds.reads, [{ file: "src/x.js", a: 10, b: 25 }]);
        assert.deepEqual(agyNeeds.hits, [{ file: "src/y.js", line: 14 }]);

        // 6. eval-fast.js T_ORACLE.T5 points to src/mcp/tools.js
        const evalFastSrc = readFileSync(new URL("../bench/eval-fast.js", import.meta.url), "utf8");
        assert.match(evalFastSrc, /T5:\s*\{[\s\S]*?"src\/mcp\/tools\.js"/);
    });
});
