import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    DatabaseSync,
    SQLITE_SCHEMA_VERSION,
    closeSqliteStores,
    flushWiringJsonIfDirty,
    getSqliteMeta,
    isSqliteWiringDirty,
    openSqliteStore,
    sqliteHasGraph,
    sqliteStorePath,
} from "../src/storage/sqlite-store.js";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { loadGraphCached, invalidateGraphCaches } from "../src/context/graph-store.js";
import { wiringPath } from "../src/context/node-file.js";
import { contextDirFor } from "../src/util/paths.js";
import { serializeGraph, writeGraphStreaming } from "../src/graph/write.js";
import { ask } from "../src/ask/ask.js";
import { loadAskVocabCached, queryAskPostingsFast } from "../src/ask/index-file.js";
import { personalizedPageRank, preparePageRankTopology } from "../src/ask/graph-rank.js";
import { startDaemon } from "../src/daemon/plexerd.js";
import { sendDaemonRpc } from "../src/daemon/socket-path.js";
import { runCli } from "../src/cli/cli-main.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function sha256File(filePath) {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function makeTempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

function writeSyntheticRepo(root, fileCount = 72) {
    for (let i = 0; i < fileCount; i++) {
        const sub = join(root, `pkg_${String(i % 6).padStart(2, "0")}`);
        mkdirSync(sub, { recursive: true });
        const nextIdx = (i + 1) % fileCount;
        const nextPkg = `pkg_${String(nextIdx % 6).padStart(2, "0")}`;
        const ext = i % 4 === 0 ? "ts" : i % 4 === 1 ? "js" : i % 4 === 2 ? "py" : "go";
        if (ext === "ts" || ext === "js") {
            const importLine = (nextIdx % 4 < 2)
                ? `import { sharedHelper_${nextIdx} } from "../${nextPkg}/mod_${String(nextIdx).padStart(3, "0")}.js";\n`
                : "";
            const callExpr = importLine ? `sharedHelper_${nextIdx}(x)` : `x + 1`;
            writeFileSync(
                join(sub, `mod_${String(i).padStart(3, "0")}.${ext}`),
                `${importLine}export function computeQuota_${i}(x${ext === "ts" ? ": number" : ""}) {\n` +
                `    // commonSharedToken verifyLimit\n` +
                `    return ${callExpr} + internalStep_${i}(x);\n}\n` +
                `export function sharedHelper_${i}(v${ext === "ts" ? ": number" : ""}) { return v * 2; }\n` +
                `function internalStep_${i}(n${ext === "ts" ? ": number" : ""}) { return n + ${i}; }\n`,
                "utf8",
            );
        }
        else if (ext === "py") {
            writeFileSync(
                join(sub, `mod_${String(i).padStart(3, "0")}.py`),
                `def compute_quota_${i}(x):\n    # commonSharedToken pythonLimit\n    return shared_py_${i}(x) + 1\n\ndef shared_py_${i}(v):\n    return v * 3\n`,
                "utf8",
            );
        }
        else {
            writeFileSync(
                join(sub, `mod_${String(i).padStart(3, "0")}.go`),
                `package pkg_${String(i % 6).padStart(2, "0")}\n\nfunc ComputeQuota_${i}(x int) int {\n\t// commonSharedToken goLimit\n\treturn sharedGo_${i}(x)\n}\n\nfunc sharedGo_${i}(v int) int {\n\treturn v + 7\n}\n`,
                "utf8",
            );
        }
    }
}

describe("SQLite v3 Packing, Streaming, Worker Determinism & Daemon Perf", () => {
    it("upgrades legacy v3 schema DBs to include ask_term_postings and ask_docs.terms_blob", () => {
        const tmp = makeTempDir("plexer-v3-mig-");
        try {
            const outDir = join(tmp, ".plexer");
            mkdirSync(join(outDir, ".cache"), { recursive: true });
            const dbFile = sqliteStorePath(outDir);
            const raw = new DatabaseSync(dbFile);
            raw.exec(`
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                INSERT INTO meta(key, value) VALUES ('schema_version', '${SQLITE_SCHEMA_VERSION}');
                CREATE TABLE ask_docs (
                    doc_id INTEGER PRIMARY KEY,
                    node_id TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    span TEXT NOT NULL,
                    signature TEXT,
                    summary TEXT,
                    exported INTEGER NOT NULL DEFAULT 0,
                    len_name INTEGER NOT NULL DEFAULT 0,
                    len_path INTEGER NOT NULL DEFAULT 0,
                    len_sig INTEGER NOT NULL DEFAULT 0,
                    len_summary INTEGER NOT NULL DEFAULT 0,
                    len_literals INTEGER NOT NULL DEFAULT 0,
                    len_body INTEGER NOT NULL DEFAULT 0,
                    len_exact INTEGER NOT NULL DEFAULT 0,
                    pagerank REAL NOT NULL DEFAULT 0
                );
            `);
            raw.close();

            const store = openSqliteStore(outDir, { create: false });
            assert.ok(store);
            const cols = store.db.prepare("PRAGMA table_info(ask_docs)").all().map((c) => c.name);
            assert.ok(cols.includes("terms_blob"), "ask_docs should gain terms_blob column on schema upgrade");
            const tbl = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ask_term_postings'").get();
            assert.equal(tbl?.name, "ask_term_postings");
            assert.equal(getSqliteMeta(store, "schema_version"), String(SQLITE_SCHEMA_VERSION));
            closeSqliteStores(outDir);
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("supports lazy wiring.json flush, loadGraphCached from SQLite, and exact writeGraphStreaming SHA-256 parity", async () => {
        const tmp = makeTempDir("plexer-v3-stream-");
        try {
            writeSyntheticRepo(tmp, 24);
            const outDir = contextDirFor(tmp);
            await buildGraph(tmp, { contextDir: outDir, graphOnly: true, force: true });

            assert.equal(existsSync(wiringPath(outDir)), false, "graphOnly build skips eager wiring.json write");
            assert.equal(sqliteHasGraph(outDir), true);
            assert.equal(isSqliteWiringDirty(outDir), true);

            const fromSql = loadGraphCached(outDir);
            assert.ok(fromSql && fromSql.nodes.length > 0 && fromSql.edges.length > 0);

            const { json: expectedJson, graphHash: expectedHash } = serializeGraph(fromSql, { alreadySorted: true });
            const streamDir = join(tmp, "stream-check");
            const streamedHash = writeGraphStreaming(fromSql, streamDir, { alreadySorted: true });
            assert.equal(streamedHash, expectedHash);
            assert.equal(readFileSync(wiringPath(streamDir), "utf8"), expectedJson);
            assert.equal(sha256File(wiringPath(streamDir)), expectedHash);

            assert.equal(flushWiringJsonIfDirty(outDir), true);
            assert.equal(isSqliteWiringDirty(outDir), false);
            const store = openSqliteStore(outDir, { create: false, readOnly: true });
            const flushedMetaHash = getSqliteMeta(store, "graph_hash");
            closeSqliteStores(outDir);
            assert.equal(sha256File(wiringPath(outDir)), flushedMetaHash);
            const reparsed = JSON.parse(readFileSync(wiringPath(outDir), "utf8"));
            assert.equal(reparsed.nodes.length, fromSql.nodes.length);
            assert.equal(reparsed.edges.length, fromSql.edges.length);
        }
        finally {
            closeSqliteStores(join(tmp, ".plexer"));
            invalidateGraphCaches();
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("produces identical nodes, edges, and wiring hashes between >=64-file fork workers and PLEXER_NO_WORKERS=1", () => {
        const tmp = makeTempDir("plexer-v3-fork-");
        try {
            const repoA = join(tmp, "repo-workers");
            const repoB = join(tmp, "repo-single");
            const repoC = join(tmp, "repo-fallback");
            writeSyntheticRepo(repoA, 72);
            writeSyntheticRepo(repoB, 72);
            writeSyntheticRepo(repoC, 72);

            const childScript = `
                import { buildGraph } from ${JSON.stringify(join(REPO_ROOT, "src/graph/build.js"))};
                const repo = process.argv[1];
                const out = await buildGraph(repo, { force: true });
                console.log(JSON.stringify({ nodes: out.nodes, edges: out.edges }));
            `;
            const baseEnv = { ...process.env };
            delete baseEnv.NODE_TEST_CONTEXT;
            delete baseEnv.PLEXER_NO_WORKERS;
            delete baseEnv.PLEXER_WORKERS;
            delete baseEnv.PLEXER_NO_DAEMON;

            const workerOut = execFileSync(process.execPath, ["--input-type=module", "-e", childScript, repoA], {
                env: { ...baseEnv, PLEXER_WORKERS: "2", PLEXER_NO_DAEMON: "1" },
                encoding: "utf8",
            });
            const singleOut = execFileSync(process.execPath, ["--input-type=module", "-e", childScript, repoB], {
                env: { ...baseEnv, PLEXER_NO_WORKERS: "1", PLEXER_NO_DAEMON: "1" },
                encoding: "utf8",
            });
            const fallbackOut = execFileSync(process.execPath, ["--input-type=module", "-e", childScript, repoC], {
                env: { ...baseEnv, PLEXER_WORKERS: "1", PLEXER_NO_DAEMON: "1" },
                encoding: "utf8",
            });

            const resA = JSON.parse(workerOut.trim().split("\n").pop());
            const resB = JSON.parse(singleOut.trim().split("\n").pop());
            const resC = JSON.parse(fallbackOut.trim().split("\n").pop());
            assert.equal(resA.nodes, resB.nodes);
            assert.equal(resA.edges, resB.edges);
            assert.equal(resC.nodes, resB.nodes);
            assert.equal(resC.edges, resB.edges);
            const expectedWiringHash = sha256File(wiringPath(contextDirFor(repoB)));
            assert.equal(
                sha256File(wiringPath(contextDirFor(repoA))),
                expectedWiringHash,
                "fork worker extraction must be byte-for-byte deterministic with single-thread extraction",
            );
            assert.equal(
                sha256File(wiringPath(contextDirFor(repoC))),
                expectedWiringHash,
                "single-worker fallback extraction must match single-thread extraction",
            );
        }
        finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("keeps incremental packed dirty1 refresh, binary-search postings merge, ask_vocab deltas, and sparse PPR equivalent", async () => {
        const tmp = makeTempDir("plexer-v3-inc-");
        try {
            const repoInc = join(tmp, "repo-inc");
            const repoFull = join(tmp, "repo-full");
            const outInc = contextDirFor(repoInc);
            const outFull = contextDirFor(repoFull);
            writeSyntheticRepo(repoInc, 48);
            await buildGraph(repoInc, { force: true });

            // Verify packed storage is active
            const storeInc = openSqliteStore(outInc, { create: false, readOnly: true });
            assert.equal(getSqliteMeta(storeInc, "postings_packed"), "1");
            const legacyPostingsCnt = storeInc.db.prepare("SELECT COUNT(*) AS c FROM ask_postings").get().c;
            assert.equal(legacyPostingsCnt, 0);
            const commonBlobRow = storeInc.db
                .prepare("SELECT df, postings FROM ask_term_postings WHERE channel='body' AND term='common'")
                .get();
            assert.ok(commonBlobRow && commonBlobRow.df >= 48 && commonBlobRow.postings.byteLength === commonBlobRow.df * 8);
            const exactBlobRow = storeInc.db
                .prepare("SELECT df, postings FROM ask_term_postings WHERE channel='name' AND term='quota'")
                .get();
            assert.ok(exactBlobRow && exactBlobRow.df >= 48 && exactBlobRow.postings.byteLength === exactBlobRow.df * 8);
            closeSqliteStores(outInc);

            // Mutate 2 files (updating shared commonSharedToken + adding new symbol + removing old step) across both clones
            const f1Rel = "pkg_00/mod_000.ts";
            const f2Rel = "pkg_02/mod_002.py";
            const nextTs = `export function computeQuota_0(x: number) {\n    // commonSharedToken brandNewAlphaSignal\n    return x * 11;\n}\nexport function uniqueBrandNewTarget(z: number) { return computeQuota_0(z); }\n`;
            const nextPy = `def compute_quota_2(x):\n    # pythonLimit\n    return x + 99\n`;
            writeFileSync(join(repoInc, f1Rel), nextTs, "utf8");
            writeFileSync(join(repoInc, f2Rel), nextPy, "utf8");

            await ensureFreshGraph(repoInc);
            writeSyntheticRepo(repoFull, 48);
            writeFileSync(join(repoFull, f1Rel), nextTs, "utf8");
            writeFileSync(join(repoFull, f2Rel), nextPy, "utf8");
            await buildGraph(repoFull, { force: true });

            const askInc = ask(repoInc, "uniqueBrandNewTarget", { source: true });
            const askFull = ask(repoFull, "uniqueBrandNewTarget", { source: true });
            assert.ok(askInc.hits[0]?.title.startsWith("uniqueBrandNewTarget"));
            assert.ok(askFull.hits[0]?.title.startsWith("uniqueBrandNewTarget"));
            assert.ok(Math.abs(askInc.hits[0].score - askFull.hits[0].score) < 1e-6);

            const vocabInc = loadAskVocabCached(outInc);
            const vocabFull = loadAskVocabCached(outFull);
            assert.equal(vocabInc.nameTokens.has("unique"), vocabFull.nameTokens.has("unique"));
            assert.equal(vocabInc.nameTokens.has("internal"), vocabFull.nameTokens.has("internal"));
            assert.equal(vocabInc.dfMap.get("common"), vocabFull.dfMap.get("common"));
            assert.equal(vocabInc.stemDf.get("common"), vocabFull.stemDf.get("common"));

            const fastCommon = queryAskPostingsFast(outInc, { body: ["common", "alpha"], name: ["quota"] });
            const fullCommon = queryAskPostingsFast(outFull, { body: ["common", "alpha"], name: ["quota"] });
            assert.equal(fastCommon.packedPostings.body.get("common").length >>> 1, fullCommon.packedPostings.body.get("common").length >>> 1);
            assert.equal(fastCommon.packedPostings.name.get("quota").length >>> 1, fullCommon.packedPostings.name.get("quota").length >>> 1);
            assert.equal(fastCommon.packedPostings.body.get("alpha").length >>> 1, 1);

            const g = loadGraphCached(outInc);
            const topo = preparePageRankTopology(g);
            const seedNode = g.nodes.find((n) => n.name === "uniqueBrandNewTarget");
            const pprSparse = personalizedPageRank(g, new Map([[seedNode.id, 1]]), { maxActive: 16 });
            const pprTopo = personalizedPageRank({ nodes: g.nodes, edges: g.edges }, new Map([[seedNode.id, 1]]), { maxActive: 0 });
            assert.ok(topo.ids.has(seedNode.id));
            assert.equal(pprSparse.get(seedNode.id), 1);
            assert.equal(pprTopo.get(seedNode.id), 1);
            const callerNode = g.nodes.find((n) => n.name === "computeQuota_0");
            assert.ok((pprSparse.get(callerNode.id) ?? 0) > 0);
        }
        finally {
            closeSqliteStores(contextDirFor(join(tmp, "repo-inc")));
            closeSqliteStores(contextDirFor(join(tmp, "repo-full")));
            invalidateGraphCaches();
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("starts daemon socket-first quickly and routes CLI fast read subcommands cleanly", async () => {
        const tmp = makeTempDir("plexer-v3-daemon-");
        const sockPath = join(tmp, "daemon.sock");
        let daemon = null;
        try {
            writeSyntheticRepo(tmp, 12);
            await buildGraph(tmp, { graphOnly: true, force: true });

            const t0 = performance.now();
            daemon = await startDaemon({ socketPath: sockPath, idleTimeoutMs: 15_000 });
            const readyMs = performance.now() - t0;
            assert.ok(readyMs < 2500, `expected fast daemon socket startup (<2500ms), got ${readyMs.toFixed(1)}ms`);
            assert.ok(daemon.version && daemon.codeStamp);

            const ping = await sendDaemonRpc(sockPath, { id: 1, type: "ping", version: daemon.version, codeStamp: daemon.codeStamp });
            assert.equal(ping.ok, true);

            const rpcAsk = await sendDaemonRpc(sockPath, {
                id: 2,
                type: "cli",
                version: daemon.version,
                codeStamp: daemon.codeStamp,
                argv: ["ask", "computeQuota_1", "--json", "--no-refresh"],
                cwd: tmp,
            });
            assert.equal(rpcAsk.ok, true);
            const parsedAsk = JSON.parse(rpcAsk.stdout);
            assert.ok(parsedAsk.hits.some((h) => h.title?.startsWith("computeQuota_1")));

            let fastOut = "";
            await runCli(["node", "plexer", "callers", "sharedHelper_1", "--json", "--no-refresh"], {
                isCaptured: true,
                cwd: tmp,
                writeOut: (s) => { fastOut += String(s); },
                writeErr: () => {},
                exit: (code = 0) => {
                    const err = new Error(`exit ${code}`);
                    err.code = code;
                    throw err;
                },
            });
            const parsedCallers = JSON.parse(fastOut);
            assert.equal(parsedCallers.query, "sharedHelper_1");
            assert.ok(Array.isArray(parsedCallers.matches) && parsedCallers.matches.length >= 1);
            assert.ok(parsedCallers.matches[0].hits.length >= 1);
        }
        finally {
            if (daemon)
                await daemon.close();
            closeSqliteStores(contextDirFor(tmp));
            invalidateGraphCaches();
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
