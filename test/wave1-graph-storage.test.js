import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    chmodSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildGraph, checkGraph, Plexer, resolveSymbol } from "../src/index.js";
import { loadGraphCached, invalidateGraphCaches, statOf } from "../src/context/graph-store.js";
import {
    closeSqliteStores,
    DatabaseSync,
    openSqliteStore,
    prepareArrayStmt,
    prepareStmt,
    SQLITE_SCHEMA_VERSION,
    sqliteStorePath,
} from "../src/storage/sqlite-store.js";
import {
    acquireLockIn,
    releaseLockIn,
    sessionPath,
    writeSession,
} from "../src/util/state.js";
import { analyzeGitHistory } from "../src/util/git-history.js";
import { extractFile, warmDepthGrammars } from "../src/graph/extract.js";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { extractLuau, normalizeLuauForParse } from "../src/graph/luau.js";
import { enclosingDef, extractLeadingSummary } from "../src/graph/extract/ast.js";
import { collectResolverConfigPaths, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { readExtractCacheStats, writeExtractCache } from "../src/graph/extract-cache.js";
import { extractorStamp } from "../src/graph/extractor-stamp.js";
import { seedGraph } from "../src/graph/seed.js";
import { writeWorkspace } from "../src/graph/workspace.js";
import { edgeOrder } from "../src/graph/write.js";
import { createTempTracker, initGitCommit } from "./helpers/git-fixture.js";

const { makeTempDir, cleanup } = createTempTracker("plexer-wave1-");

after(() => {
    closeSqliteStores();
    invalidateGraphCaches();
    cleanup();
});

describe("Wave 1: Storage, State, Context Caches, Dirty-Cone, Refresh, Extractors & Workspace Dispatch", () => {
    it("bumps SQLITE_SCHEMA_VERSION=3, rebuilds v1 DBs cleanly, and enforces LRU caps on openStores (12) and store.stmts (64)", () => {
        assert.equal(SQLITE_SCHEMA_VERSION, 3);
        const dirs = [];
        const stores = [];
        for (let i = 0; i < 15; i++) {
            const outDir = makeTempDir(`sqlite-lru-${i}-`);
            dirs.push(outDir);
            const store = openSqliteStore(outDir, { create: true });
            assert.equal(store.closed, false);
            stores.push(store);
        }

        // Opening 15 stores should have evicted and closed the earliest 3 (openStores capped at 12)
        assert.equal(stores[0].closed, true);
        assert.equal(stores[1].closed, true);
        assert.equal(stores[2].closed, true);
        assert.equal(stores[14].closed, false);

        // Verify v1 schema gets dropped and recreated cleanly as v3 on open
        const upgradeDir = makeTempDir("sqlite-v1-upgrade-");
        mkdirSync(join(upgradeDir, ".cache"), { recursive: true });
        const v1Path = sqliteStorePath(upgradeDir);
        const rawDb = new DatabaseSync(v1Path);
        rawDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1'), ('stale_key', 'old');");
        rawDb.close();

        const upgraded = openSqliteStore(upgradeDir, { create: true });
        const verRow = prepareStmt(upgraded, "SELECT value FROM meta WHERE key = 'schema_version'").get();
        const staleRow = prepareStmt(upgraded, "SELECT value FROM meta WHERE key = 'stale_key'").get();
        assert.equal(verRow?.value, "3");
        assert.equal(staleRow, undefined);

        // Verify store.stmts LRU cap at 64
        for (let i = 0; i < 80; i++) {
            prepareStmt(upgraded, `SELECT ${i} AS n`);
            if (i < 10)
                prepareArrayStmt(upgraded, `SELECT ${i} AS a`);
        }
        assert.ok(upgraded.stmts.size <= 64, `expected stmts.size <= 64, got ${upgraded.stmts.size}`);
    });

    it("fixes acquireLockIn stale-lock race, throttles writeSession pruning, and writes git-history atomically", () => {
        const cache = makeTempDir("lock-state-");
        // Dead PID lock is safely removed only after (dev, ino) check and re-acquired via wx
        const deadLockPath = join(cache, ".sync.lock");
        writeFileSync(deadLockPath, JSON.stringify({ pid: 999999999, at: "2020-01-01T00:00:00Z" }));
        const deadIno = statSync(deadLockPath).ino;
        // Keep the stale file's inode pinned across unlink+wx so Linux/tmpfs cannot recycle deadIno
        const deadFd = process.platform !== "win32" ? openSync(deadLockPath, "r") : null;
        try {
            assert.equal(acquireLockIn(cache), true, "dead PID lock should be taken over");
            if (deadFd !== null) {
                const newStat = statSync(deadLockPath);
                assert.notEqual(newStat.ino, deadIno, "stale takeover must unlink and recreate with a new inode via wx");
                assert.equal(JSON.parse(readFileSync(deadFd, "utf8")).pid, 999999999, "original fd must still point at unlinked stale lock");
            }
            assert.equal(JSON.parse(readFileSync(deadLockPath, "utf8")).pid, process.pid);
        }
        finally {
            if (deadFd !== null)
                closeSync(deadFd);
        }
        assert.equal(acquireLockIn(cache), false, "live PID lock must not be stolen");
        releaseLockIn(cache);
        assert.equal(existsSync(deadLockPath), false);

        // writeSession throttles stale-file pruning to once/60s per dir
        const sessRepo = makeTempDir("sess-throttle-");
        writeSession(sessRepo, "s1", { ok: 1 });
        const staleFile = sessionPath(sessRepo, "old-session");
        writeFileSync(staleFile, JSON.stringify({ ok: 0 }));
        const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        utimesSync(staleFile, oldTime, oldTime);
        // Second writeSession within 60s should skip readdir/prune
        writeSession(sessRepo, "s2", { ok: 2 });
        assert.equal(existsSync(staleFile), true, "writeSession pruning must be throttled within 60s");

        // analyzeGitHistory uses writeJsonAtomic cleanly
        const gitRepo = makeTempDir("git-hist-");
        writeFileSync(join(gitRepo, "a.js"), "export const a = 1;\n");
        initGitCommit(gitRepo);
        const hist = analyzeGitHistory(gitRepo, join(gitRepo, "plexer"));
        assert.ok(hist && existsSync(join(gitRepo, "plexer", ".cache", "git-history.json")));
    });

    it("lazy-initializes graph-store indices, normalizes outDir, caps graphCache, and merges Luau + non-Luau resolveSymbol matches", () => {
        const dir = makeTempDir("graph-store-");
        const outDir = join(dir, "plexer");
        mkdirSync(join(outDir, ".graph"), { recursive: true });
        const sampleGraph = {
            meta: { version: 1, languages: ["typescript", "luau"] },
            nodes: [
                { id: "src/a.ts", name: "a.ts", kind: "file", path: "src/a.ts", span: "L1-L5", exported: true },
                { id: "src/a.ts#Widget.render", name: "render", kind: "method", path: "src/a.ts", span: "L2-L4", exported: true },
                { id: "src/Widget.luau", name: "Widget.luau", kind: "file", path: "src/Widget.luau", span: "L1-L6", exported: true },
                { id: "src/Impl.luau#renderImpl", name: "renderImpl", kind: "function", path: "src/Impl.luau", span: "L1-L5", exported: true },
                { id: "src/Widget.luau#render", name: "render", kind: "function", path: "src/Widget.luau", span: "L3-L3", exported: true },
            ],
            edges: [
                { source: "src/Widget.luau#render", target: "src/Impl.luau#renderImpl", relation: "calls", confidence: "extracted" },
            ],
        };
        const wPath = join(outDir, ".graph", "wiring.json");
        writeFileSync(wPath, JSON.stringify(sampleGraph));

        const st = statOf(wPath);
        assert.ok(typeof st?.dev === "number" && typeof st?.ino === "number");

        const g = loadGraphCached(join(outDir, "."));
        assert.ok(g);
        assert.equal(typeof Object.getOwnPropertyDescriptor(g, "byName")?.get, "function", "byName must be a lazy getter initially");
        assert.equal(typeof Object.getOwnPropertyDescriptor(g, "_outEdges")?.get, "function", "_outEdges must be a lazy getter initially");
        // Accessing _outEdges materializes it
        assert.equal(g._outEdges.get("src/Widget.luau#render")?.length, 1);
        assert.equal(Object.getOwnPropertyDescriptor(g, "_outEdges")?.get, undefined, "lazy getter should memoize to value property");

        // resolveSymbol merges & deduplicates instead of overwriting non-Luau matches
        const resolved = resolveSymbol(g, "Widget.render");
        assert.ok(resolved.some((n) => n.id === "src/a.ts#Widget.render"), "must keep TS Widget.render");
        assert.ok(resolved.some((n) => n.id === "src/Widget.luau#render"), "must merge Luau Widget.render");
        assert.equal(new Set(resolved.map((n) => n.id)).size, resolved.length, "must deduplicate by id");

        // Invalidate with unnormalized path works via resolve()
        invalidateGraphCaches(join(outDir, "."));
    });

    it("fixes dirty-cone zombie edges, dotted/ext/__init__ symbol_deps, multi-level CHA, INDEX.md count, and build lock enforcement", async () => {
        const incRepo = makeTempDir("cone-zombie-inc-");
        const coldRepo = makeTempDir("cone-zombie-cold-");
        const initial = {
            "src/user.service.ts": "export function loadUser() { return 1; }\nexport function obsoleteFn() { return 2; }\n",
            "src/consumer.ts": 'import { loadUser, obsoleteFn } from "./user.service";\nexport function runAll() { return loadUser() + obsoleteFn(); }\n',
            "src/iface.ts": "export interface Driver { drive(): void; }\n",
            "src/mid.ts": 'import { Driver } from "./iface";\nexport class MidDriver implements Driver { drive() {} }\n',
            "src/sub.ts": 'import { MidDriver } from "./mid";\nexport class SubDriver extends MidDriver { drive() {} }\n',
            "src/caller.ts": 'import { Driver } from "./iface";\nexport function useDriver(d: Driver) { d.drive(); }\n',
            "src/extra1.ts": "export const x1 = 1;\n",
            "src/extra2.ts": "export const x2 = 2;\n",
        };
        for (const repo of [incRepo, coldRepo]) {
            for (const [rel, txt] of Object.entries(initial)) {
                mkdirSync(join(repo, rel, ".."), { recursive: true });
                writeFileSync(join(repo, rel), txt, "utf8");
            }
            initGitCommit(repo);
        }

        const buildRes = await buildGraph(incRepo);
        assert.ok(buildRes.nodes > 0);
        // INDEX.md without --cards must report actual symbol file count, not 0
        const indexMd = readFileSync(join(incRepo, "plexer", "INDEX.md"), "utf8");
        assert.match(indexMd, /## Files \(\d+ cards, [1-9]\d* with symbols\)/);

        // Lock enforcement: self-PID lock (edit-hooks -> sync-run handoff) succeeds without releasing,
        // while a different live PID holding .sync.lock rejects buildGraph after timeout
        const lockCache = join(incRepo, "plexer", ".cache");
        assert.equal(acquireLockIn(lockCache), true);
        await buildGraph(incRepo);
        assert.equal(existsSync(join(lockCache, ".sync.lock")), true, "self-held lock must stay held for caller to release");
        releaseLockIn(lockCache);

        const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
        try {
            writeFileSync(join(lockCache, ".sync.lock"), JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
            await assert.rejects(
                () => buildGraph(incRepo, { lockTimeoutMs: 60 }),
                /timed out waiting for graph build lock/,
            );
        } finally {
            rmSync(join(lockCache, ".sync.lock"), { force: true });
            holder.kill();
        }

        // Remove obsoleteFn from user.service.ts and stop calling it in consumer.ts + remove SubDriver in sub.ts
        const updated = {
            "src/user.service.ts": "export function loadUser() { return 10; }\n",
            "src/consumer.ts": 'import { loadUser } from "./user.service";\nexport function runAll() { return loadUser(); }\n',
            "src/sub.ts": "export const subDisabled = true;\n",
        };
        for (const repo of [incRepo, coldRepo]) {
            for (const [rel, txt] of Object.entries(updated)) {
                writeFileSync(join(repo, rel), txt, "utf8");
            }
        }
        await buildGraph(incRepo);
        await buildGraph(coldRepo, { force: true, reuse: false });

        const norm = (g) => ({
            nodes: g.nodes.map((n) => n.id).sort(),
            edges: g.edges.map((e) => `${e.source}|${e.relation}|${e.target}`).sort(),
        });
        const incG = JSON.parse(readFileSync(join(incRepo, "plexer", ".graph", "wiring.json"), "utf8"));
        const coldG = JSON.parse(readFileSync(join(coldRepo, "plexer", ".graph", "wiring.json"), "utf8"));
        assert.deepEqual(norm(incG), norm(coldG), "dirty-cone rebuild must match cold build with zero zombie edges");
        assert.equal(incG.edges.some((e) => e.target.includes("obsoleteFn") || e.source.includes("SubDriver")), false);

        // Crash-window atomicity: if writeGraph fails after SQLite tx commits, the next buildGraph must recover and not trust stale wiring.json
        const graphDir = join(incRepo, "plexer", ".graph");
        writeFileSync(join(incRepo, "src", "addedLater.ts"), "export function addedLaterFn() { return 42; }\n");
        chmodSync(graphDir, 0o555);
        try {
            await assert.rejects(() => buildGraph(incRepo));
        } finally {
            chmodSync(graphDir, 0o755);
        }
        await buildGraph(incRepo);
        const recoveredG = JSON.parse(readFileSync(join(graphDir, "wiring.json"), "utf8"));
        assert.equal(recoveredG.nodes.some((n) => n.path === "src/addedLater.ts"), true, "post-crash rebuild must recover addedLater.ts into wiring.json");

        // Empty-dir fingerprint heal soundness + read-only cache resilience in probeDrift
        const fpRepo = makeTempDir("fp-emptydir-");
        writeFileSync(join(fpRepo, "src.ts"), "export const v = 1;\n");
        await buildGraph(fpRepo);
        mkdirSync(join(fpRepo, "emptyd"), { recursive: true });
        // Touch src.ts with same bytes to trigger slow-path probeDrift heal
        const srcFile = join(fpRepo, "src.ts");
        const future = new Date(Date.now() + 5000);
        utimesSync(srcFile, future, future);
        const healDrift = probeDrift(fpRepo, join(fpRepo, "plexer"));
        assert.equal(healDrift.added.length + healDrift.changed.length + healDrift.removed.length, 0);
        writeFileSync(join(fpRepo, "emptyd", "c.ts"), "export const c = 3;\n");
        const afterEmptyWrite = probeDrift(fpRepo, join(fpRepo, "plexer"));
        assert.deepEqual(afterEmptyWrite.added, ["emptyd/c.ts"], "empty dir must stay in healed fp.dirs so new files inside it are detected");

        // Read-only .cache dir must not make probeDrift throw EACCES
        const fpCacheDir = join(fpRepo, "plexer", ".cache");
        chmodSync(fpCacheDir, 0o555);
        try {
            const roDrift = probeDrift(fpRepo, join(fpRepo, "plexer"));
            assert.deepEqual(roDrift.added, ["emptyd/c.ts"]);
        } finally {
            chmodSync(fpCacheDir, 0o755);
        }

        // UTF-16 code-unit order check
        const e1 = { source: "a", relation: "calls", target: "Z" };
        const e2 = { source: "a", relation: "calls", target: "a" };
        assert.ok(edgeOrder(e1, e2) < 0, "UTF-16 order sorts 'Z' before 'a'");
    });

    it("tracks extended config files, caches gitIndexPath, verifies checkGraph --strict vs fast path, and quick_checks seeded SQLite", async () => {
        const origin = makeTempDir("fp-seed-");
        mkdirSync(join(origin, "src", "game"), { recursive: true });
        writeFileSync(join(origin, "pnpm-workspace.yaml"), "packages:\n  - 'src/*'\n");
        writeFileSync(join(origin, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }));
        writeFileSync(join(origin, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
        writeFileSync(join(origin, "src", "game", ".luaurc"), JSON.stringify({ aliases: { g: "." } }));
        writeFileSync(join(origin, "src", "game", "mod.luau"), "local M = {}\nfunction M.ping() return 1 end\nreturn M\n");
        const appFile = join(origin, "src", "app.ts");
        const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 2000);
        writeFileSync(appFile, "export function app() { return 1; }\n");
        utimesSync(appFile, fixedTime, fixedTime);
        initGitCommit(origin);

        await buildGraph(origin);
        const fp = readFingerprint(join(origin, "plexer"));
        assert.ok(fp?.gitIndexPath, "fingerprint should cache gitIndexPath");
        assert.ok(fp?.configs?.["pnpm-workspace.yaml"], "fingerprint should track pnpm-workspace.yaml");
        assert.ok(fp?.configs?.["tsconfig.base.json"], "fingerprint should track tsconfig extends targets");
        assert.ok(fp?.configs?.["src/game/.luaurc"], "fingerprint should track nested .luaurc");
        assert.ok(fp?.configs?.[".git/info/exclude"], "fingerprint should track .git/info/exclude");

        const statsInfo = readExtractCacheStats(join(origin, "plexer"));
        assert.equal(statsInfo.source, "sqlite");
        assert.ok(statsInfo.stats.has("src/app.ts"));
        assert.ok(extractorStamp()?.length === 16);

        // Same-size/same-mtime edit is skipped on fast checkGraph() and caught on checkGraph({ strict: true })
        writeFileSync(appFile, "export function app() { return 2; }\n");
        utimesSync(appFile, fixedTime, fixedTime);
        const fastChk = await checkGraph(origin);
        assert.equal(fastChk.ok, true);
        const strictChk = await checkGraph(origin, { strict: true });
        assert.equal(strictChk.ok, false);

        // PLEXER_NO_REFRESH=true disables probeDrift fingerprint healing
        const prevNoRefresh = process.env.PLEXER_NO_REFRESH;
        process.env.PLEXER_NO_REFRESH = "true";
        try {
            const drift = probeDrift(origin, join(origin, "plexer"));
            assert.ok(drift);
        } finally {
            if (prevNoRefresh === undefined) delete process.env.PLEXER_NO_REFRESH;
            else process.env.PLEXER_NO_REFRESH = prevNoRefresh;
        }

        // Corrupt parent SQLite causes copySqliteFileSafe quick_check to abort seeding cleanly
        const wtPath = makeTempDir("seed-corrupt-wt-");
        rmSync(wtPath, { recursive: true, force: true });
        execFileSync("git", ["worktree", "add", "-q", "-b", "seed-check-br", wtPath], { cwd: origin });
        try {
            closeSqliteStores();
            const parentSqlite = sqliteStorePath(join(origin, "plexer"));
            writeFileSync(parentSqlite, "not-a-valid-sqlite-database");
            const res = seedGraph(wtPath);
            assert.equal(res.seeded, false, "corrupt SQLite must fail PRAGMA quick_check and abort seeding");
        } finally {
            try {
                execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: origin });
            } catch {
                rmSync(wtPath, { recursive: true, force: true });
            }
        }
    });

    it("fixes TS reexports/CJS/arrow-methods/signatures, C/C++ headers/preproc, Python/PHP isolation, Go generics, Luau rules, Elixir @ignore, and Nix dedup", async () => {
        await warmDepthGrammars(["typescript", "tsx", "python", "go", "php", "java", "kotlin", "swift", "r"]);
        await warmGenericGrammars(["c", "cpp", "elixir", "nix", "luau"]);

        // 1. TS export { x } from "./y" must NOT emit star: true; CJS module.exports = fn/ident; class arrow field
        const tsExt = extractFile("src/mod.ts", [
            'export { alpha } from "./dep";',
            'export * from "./starMod";',
            'export * as nsMod from "./nsTarget";',
            "export type BigAlias = {",
            "  a: string;",
            "  b: number;",
            "};",
            "@Injectable()",
            "export class Service {",
            "  handleEvent = (id: string) => { return id; };",
            "}",
            `export function veryLongSignature(${Array.from({ length: 30 }, (_, i) => `param${i}: string`).join(", ")}) { return 1; }`,
        ].join("\n"), "typescript");
        const reexports = tsExt.rawEdges.filter((e) => e.relation === "reexports");
        assert.equal(reexports.some((e) => e.specifier === "./dep" && e.star), false, "export { alpha } must not emit star: true");
        assert.equal(reexports.some((e) => e.specifier === "./starMod" && e.star && !e.exportedName), true);
        assert.equal(reexports.some((e) => e.specifier === "./nsTarget" && e.star && e.exportedName === "nsMod"), true);

        const arrowMethod = tsExt.nodes.find((n) => n.name === "handleEvent");
        assert.equal(arrowMethod?.kind, "method", "TS class arrow field must extract as method");

        const aliasNode = tsExt.nodes.find((n) => n.name === "BigAlias");
        assert.ok(aliasNode?.signature && !aliasNode.signature.includes("b: number"), `type alias signature must stop at =: ${aliasNode?.signature}`);

        const svcNode = tsExt.nodes.find((n) => n.name === "Service");
        assert.ok(svcNode?.signature && !svcNode.signature.includes("@Injectable"), `leading decorator must be stripped from signature: ${svcNode?.signature}`);

        const longFn = tsExt.nodes.find((n) => n.name === "veryLongSignature");
        assert.ok(longFn?.signature && longFn.signature.length <= 240 && longFn.signature.endsWith("…"));

        const cjsExt = extractFile("src/cjs.js", [
            "function helper() { return 1; }",
            "module.exports = helper;",
        ].join("\n"), "typescript");
        assert.equal(cjsExt.nodes.find((n) => n.name === "helper")?.defaultExport, true);

        const cjsAnon = extractFile("src/cjs2.js", "module.exports = class Widget {};\n", "typescript");
        assert.equal(cjsAnon.nodes.find((n) => n.name === "Widget")?.defaultExport, true);

        // 1b. One-line Java/Kotlin/Swift annotations keep the rest of the signature
        const javaAnnoExt = extractFile("src/Marker.java", "@Retention(RetentionPolicy.RUNTIME) public @interface Marker {}\nclass Use { @Override public String toString() { return \"\"; } }\n", "java");
        assert.ok(javaAnnoExt.nodes.find((n) => n.name === "Marker")?.signature?.includes("@interface Marker"));
        assert.ok(javaAnnoExt.nodes.find((n) => n.name === "toString")?.signature?.includes("public String toString()"));

        const ktAnnoExt = extractFile("src/Screen.kt", "@JvmStatic fun foo() {}\n@Composable fun Screen() {}\n", "kotlin");
        assert.ok(ktAnnoExt.nodes.find((n) => n.name === "foo")?.signature?.includes("fun foo()"));
        assert.ok(ktAnnoExt.nodes.find((n) => n.name === "Screen")?.signature?.includes("fun Screen()"));

        const swiftAnnoExt = extractFile("src/Store.swift", "@MainActor final class Store {\n  @objc func tap() {}\n}\n", "swift");
        assert.ok(swiftAnnoExt.nodes.find((n) => n.name === "Store")?.signature?.includes("final class Store"));
        assert.ok(swiftAnnoExt.nodes.find((n) => n.name === "tap")?.signature?.includes("func tap()"));

        // 2. PHP grouped use
        const phpExt = extractFile("src/app.php", [
            "<?php",
            "use App\\Models\\{User, Order as OrderModel};",
            "function run() { return new User(); }",
        ].join("\n"), "php");
        assert.ok(phpExt.rawEdges.some((e) => e.relation === "imports" && e.specifier === "App\\Models\\User"));
        assert.ok(phpExt.rawEdges.some((e) => e.relation === "imports" && e.specifier === "App\\Models\\Order"));

        // 3. C/C++: preprocessor directives gated to C-family (never breaking Python # comments),
        // header declarations don't shadow definitions, pointer/reference/qualified C/C++ defs preserved
        const cLines = ["#include <stdio.h>", "#define MAGIC 42", "int *make_ptr(int x) {", "  return 0;", "}"];
        assert.equal(extractLeadingSummary(cLines, 2, "", "c"), null, "#define/#include must not be extracted as summary in C");
        const pyLines = ["# Retry helper.", "# warning: not thread safe", "def retry():", "    pass"];
        assert.ok(extractLeadingSummary(pyLines, 2, "", "python")?.includes("warning: not thread safe"), "Python # comments must NOT be treated as C preprocessor directives");

        const hExt = extractGeneric("include/foo.h", "int compute_val(int x);\n");
        assert.equal(hExt.nodes.filter((n) => n.kind === "function" && !n.declaration).length, 0, "pure .h declaration should not shadow .c definition");
        assert.equal(hExt.nodes.find((n) => n.name === "compute_val")?.declaration, true, "pure .h declaration should be tagged declaration: true");
        const cExt = extractGeneric("src/foo.c", "int *compute_val(int x) {\n  return 0;\n}\nchar **split(char *s) {\n  return 0;\n}\nint (*getfn(void))(int) {\n  return 0;\n}\n");
        assert.equal(cExt.nodes.find((n) => n.name === "compute_val")?.span, "L1-L3");
        assert.ok(cExt.nodes.find((n) => n.name === "split"), "C nested pointer char **split() must be extracted");
        assert.ok(cExt.nodes.find((n) => n.name === "getfn"), "C function-pointer-returning int (*getfn(void))(int) must be extracted");

        const cppExt = extractGeneric("src/foo.cpp", [
            "class Node {",
            "  Node* child() { return 0; }",
            "  Node& ref() { return *this; }",
            "};",
            "Node* Foo2::make() { return 0; }",
            "std::string& Bar::name() { static std::string s; return s; }",
            "const Node& get_ref(const Node& n) { return n; }",
        ].join("\n"));
        for (const fnName of ["child", "ref", "make", "name", "get_ref"]) {
            assert.ok(cppExt.nodes.some((n) => n.name === fnName), `C++ function ${fnName} must be extracted`);
        }

        // 4. Luau normalizer + --[=[ block comment + real Luau build with string/comment masking & nearest .luaurc
        const luauLines = ["--[=[", "Doc line", "]=]", "local function demo() end"];
        assert.equal(extractLeadingSummary(luauLines, 3, "", "luau"), "Doc line");
        const luauNorm = normalizeLuauForParse([
            'type Props = MyComp<"Frame", "TextLabel">',
            'type Config = { type: string, thread: thread }',
            'local s = string:format("%d", 1)',
            '-- typeof(require("./commented"))',
        ].join("\n"));
        assert.ok(luauNorm.includes("MyComp<string, string>"), `Rule 9 must loop to fixed point: ${luauNorm}`);
        assert.ok(luauNorm.includes("type_: string"), `Rule 14 must rename type: in type context: ${luauNorm}`);
        assert.ok(luauNorm.includes('string:format("%d", 1)'), `Rule 14 must NOT touch string:format: ${luauNorm}`);

        const luauRepo = makeTempDir("luau-mask-rc-");
        mkdirSync(join(luauRepo, "client", "ui"), { recursive: true });
        mkdirSync(join(luauRepo, "server", "db"), { recursive: true });
        writeFileSync(join(luauRepo, "client", ".luaurc"), JSON.stringify({ aliases: { shared: "ui" } }));
        writeFileSync(join(luauRepo, "server", ".luaurc"), JSON.stringify({ aliases: { shared: "db" } }));
        writeFileSync(join(luauRepo, "client", "ui", "Comp.luau"), "local M = {}\nfunction M.render() return 1 end\nreturn M\n");
        writeFileSync(join(luauRepo, "server", "db", "Comp.luau"), "local M = {}\nfunction M.query() return 1 end\nreturn M\n");
        writeFileSync(join(luauRepo, "client", "dead.luau"), "return {}\n");
        writeFileSync(join(luauRepo, "client", "live.luau"), "export type LiveT = { ok: boolean }\nreturn {}\n");
        writeFileSync(join(luauRepo, "client", "main.luau"), [
            'local _ignored1 = "typeof(require(\'./dead\'))"',
            "-- local _ignored2: typeof(require('./dead'))",
            "local _s = 'a--b'",
            'local _kept: typeof(require("./live")) = nil',
            'local Comp = require("@shared/Comp")',
            "return Comp.render()",
        ].join("\n"));
        await buildGraph(luauRepo);
        const luauG = JSON.parse(readFileSync(join(luauRepo, "plexer", ".graph", "wiring.json"), "utf8"));
        assert.equal(luauG.edges.some((e) => e.source === "client/main.luau" && e.target === "client/dead.luau"), false, "string/comment typeof(require) must be ignored");
        assert.equal(luauG.edges.some((e) => e.source === "client/main.luau" && e.target === "client/live.luau"), true, "typeof(require) after 'a--b' must be kept");
        assert.equal(luauG.edges.some((e) => e.source === "client/main.luau" && e.target === "client/ui/Comp.luau"), true, "nearest client/.luaurc @shared must resolve to client/ui/Comp.luau");

        // 5. Python/PHP cross-language isolation, Java annotations, Go generic receiver + _test.go pref, C .h-vs-.c resolution, closure-scoped generic member names
        const isoRepo = makeTempDir("resolve-iso-");
        mkdirSync(join(isoRepo, "include"), { recursive: true });
        mkdirSync(join(isoRepo, "src"), { recursive: true });
        mkdirSync(join(isoRepo, "pkg"), { recursive: true });
        writeFileSync(join(isoRepo, "src.py"), "from missing_pkg import uniqueHelper\ndef uniqueHelper():\n    return 0\ndef run():\n    return uniqueHelper()\n");
        writeFileSync(join(isoRepo, "index.php"), "<?php\nuse Missing\\Ns\\uniqueHelper;\nfunction uniqueHelper() { return 0; }\nfunction phpRun() { return uniqueHelper(); }\n");
        writeFileSync(join(isoRepo, "helper.ts"), "export function uniqueHelper() { return 1; }\nfunction privateHelper() { return 2; }\n");
        writeFileSync(join(isoRepo, "doc.ts"), "export class Doc { text() { return 'ok'; } stringify() { return '{}'; } }\n");
        writeFileSync(join(isoRepo, "caller.ts"), 'import { Doc } from "./doc";\nexport function go(x: any, d: Doc) { x.startsWith("a"); x.privateHelper(); d.text(); d.stringify(); }\n');
        writeFileSync(join(isoRepo, "unimp.ts"), "export function stray(u: any) { return u.text(); }\n");
        writeFileSync(join(isoRepo, "Marker.java"), "import java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME) public @interface Marker {}\n");
        writeFileSync(join(isoRepo, "Anno.java"), "@Marker public class Anno { @Override public String toString() { return \"\"; } }\n");
        writeFileSync(join(isoRepo, "go.mod"), "module example.com/app\n");
        writeFileSync(join(isoRepo, "pkg", "a_test.go"), "package pkg\nfunc TestOnly() {}\n");
        writeFileSync(join(isoRepo, "pkg", "impl.go"), "package pkg\nfunc ImplFn() {}\n");
        writeFileSync(join(isoRepo, "box.go"), 'package main\nimport "example.com/app/pkg"\ntype Box[T any] struct{}\nfunc (b *Box[T]) Open() {}\nfunc useBox() { var x Box[int]; x.Open(); pkg.ImplFn() }\n');
        writeFileSync(join(isoRepo, "include", "calc.h"), "int calc_sum(int a, int b);\n");
        writeFileSync(join(isoRepo, "src", "calc.c"), "int calc_sum(int a, int b) { return a + b; }\n");
        writeFileSync(join(isoRepo, "src", "main.c"), '#include "calc.h"\nint main() { return calc_sum(1, 2); }\n');
        await buildGraph(isoRepo);
        const isoG = JSON.parse(readFileSync(join(isoRepo, "plexer", ".graph", "wiring.json"), "utf8"));
        assert.equal(isoG.edges.some((e) => e.source.startsWith("src.py") && e.relation === "calls" && e.target.endsWith("#uniqueHelper")), false, "Python unresolved import must neither hit same-file nor cross into TS");
        assert.equal(isoG.edges.some((e) => e.source.startsWith("index.php") && e.relation === "calls" && e.target.endsWith("#uniqueHelper")), false, "PHP unresolved import must neither hit same-file nor cross into TS");
        assert.equal(isoG.edges.some((e) => e.source.startsWith("caller.ts") && e.target.includes("privateHelper")), false, "unexported TS standalone fn must not resolve repo-wide via member call");
        assert.equal(isoG.edges.some((e) => e.source === "caller.ts#go" && e.target === "doc.ts#Doc.text"), true, "closure-scoped d.text() must still resolve to imported Doc.text");
        assert.equal(isoG.edges.some((e) => e.source === "unimp.ts#stray" && e.target === "doc.ts#Doc.text"), false, "unimported repo-wide u.text() must be blocked by extra generic member names");
        assert.equal(isoG.edges.some((e) => e.source.startsWith("Anno.java") && e.target === "Override"), false, "JDK @Override annotation must be skipped");
        assert.equal(isoG.edges.some((e) => e.source === "Anno.java#Anno" && e.target === "Marker.java#Marker"), true, "@Retention(...) public @interface Marker must keep @interface in signature so refs resolve");
        assert.equal(isoG.edges.some((e) => e.source === "box.go#useBox" && e.target === "box.go#Box.Open"), true, "Go generic receiver + var type must resolve");
        assert.equal(isoG.edges.some((e) => e.source === "box.go" && e.relation === "imports" && e.target === "pkg/impl.go"), true, "resolveGoImport must prefer non-_test.go file");
        assert.equal(isoG.edges.some((e) => e.source === "src/main.c#main" && e.target === "src/calc.c#calc_sum"), true, ".h declaration must not shadow .c definition in main.c -> calc.c call resolution");

        // 6. enclosingDef O(log D) matches linear scan
        const defs = Array.from({ length: 30 }, (_, i) => ({
            id: `fn${i}`,
            startIndex: i * 20,
            endIndex: i * 20 + 18,
        }));
        defs.push({ id: "outer", startIndex: 0, endIndex: 600 });
        assert.equal(enclosingDef(defs, 45)?.id, "fn2");
        assert.equal(enclosingDef(defs, 59)?.id, "outer");

        // 7. Elixir @ignore and Nix apply_expression dedup
        const exExt = extractGeneric("lib/app.ex", "defmodule App do\n  def run(x) do\n    if x do\n      work(x)\n    end\n  end\nend\n");
        assert.equal(exExt.rawEdges.some((e) => e.relation === "calls" && (e.name === "if" || e.name === "def")), false, "Elixir @ignore must suppress keyword false calls");
        assert.equal(exExt.rawEdges.some((e) => e.relation === "calls" && e.name === "work"), true);

        const nixExt = extractGeneric("default.nix", "{ pkgs }: let res = helper a b; in res\n");
        const nixCalls = nixExt.rawEdges.filter((e) => e.relation === "calls" && e.name === "helper");
        assert.equal(nixCalls.length, 1, "Nix nested apply_expression must emit 1 call edge per call");
    });

    it("dispatches Plexer.map/check via #resolveTarget, allows --in subdir across repos, ignores absolute contextDir in .code-workspace, and picks confidenceTier from hits[0]", async () => {
        const wsRoot = makeTempDir("cw-ws-");
        const repoA = join(wsRoot, "repo-a");
        const repoB = join(wsRoot, "repo-b");
        mkdirSync(join(repoA, "src", "auth"), { recursive: true });
        mkdirSync(join(repoB, "src", "billing"), { recursive: true });
        writeFileSync(join(repoA, "src", "auth", "login.ts"), "export function authenticateUserToken(t: string) { return t.length > 0; }\n");
        writeFileSync(join(repoB, "src", "billing", "invoice.ts"), "export function generateInvoicePdf() { return 'pdf'; }\n");
        initGitCommit(repoA);
        initGitCommit(repoB);

        await buildGraph(repoA);
        await buildGraph(repoB);

        const cwFile = join(wsRoot, "multi.code-workspace");
        writeFileSync(cwFile, JSON.stringify({ folders: [{ path: "repo-a" }, { path: "repo-b" }] }));

        // Absolute contextDir must NOT be forwarded into .code-workspace child repos
        const absCtx = makeTempDir("abs-ctx-override-");
        const plexer = new Plexer({ contextDir: absCtx });

        const checkRes = await plexer.check(cwFile);
        assert.equal(checkRes.ok, true);
        assert.ok(checkRes.repos["repo-a"]?.ok);

        const mapRes = plexer.map(cwFile, { json: true });
        assert.equal(mapRes.repos.length, 2);

        // --in src/auth must search across repos without throwing `no workspace repo "src"`
        const askRes = plexer.ask(cwFile, "authenticateUserToken", { in: "src/auth" });
        assert.ok(askRes.hits.length > 0);
        assert.ok(askRes.hits[0].pointer.startsWith("repo-a/"));
        assert.ok(askRes.confidenceTier, "confidenceTier must be populated from hits[0] repo");

        // Also test workspace.json federation for map/check/ask --in
        const dirWs = makeTempDir("dir-ws-");
        mkdirSync(join(dirWs, "svc-a", "src", "auth"), { recursive: true });
        writeFileSync(join(dirWs, "svc-a", "src", "auth", "check.ts"), "export function verifyAuthHeader() { return true; }\n");
        initGitCommit(join(dirWs, "svc-a"));
        await buildGraph(join(dirWs, "svc-a"));
        writeWorkspace(dirWs, { version: 1, children: ["svc-a"] });

        const dirPlexer = new Plexer();
        const wsCheck = await dirPlexer.checkGraph(dirWs);
        assert.equal(wsCheck.ok, true);
        const wsMap = dirPlexer.map(dirWs, { json: true });
        assert.equal(wsMap.repos.length, 1);
        const wsAsk = dirPlexer.ask(dirWs, "verifyAuthHeader", { in: "src/auth" });
        assert.ok(wsAsk.hits.some((h) => h.pointer.startsWith("svc-a/")));
    });
});
