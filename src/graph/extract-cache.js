/**
 * Per-file memo for Tier-1 extraction — `<outDir>/.cache/extract.json`.
 *
 * `extractFile` is pure and file-local (`rel`, `source`, `lang` → `{nodes,
 * rawEdges}`), which is the whole trick: an unchanged file's parse result can be
 * replayed from disk instead of re-running tree-sitter. That turns
 * {@link buildGraph} from "always re-parse the repo" (~4.6ms/file) into "re-parse
 * only what moved", which is what makes a rebuild cheap enough to run *before*
 * every query (see `graph/refresh.js`).
 *
 * Everything downstream of extraction (edge resolution, enrichment, the graph
 * write, the ask sidecar, cards) still runs over the whole merged node set, so no
 * other invariant changes — an incremental build must produce a byte-identical
 * `wiring.json` to a cold one.
 *
 * Crucially the cached nodes keep `body_text`: `writeGraph` strips it before
 * serializing, so `wiring.json` can never be the reuse source — the ask sidecar
 * needs a body for every node, including the ones we didn't re-parse.
 *
 * Lives under `.cache/` (gitignored, regenerate-anytime) next to `ask-index.json`
 * and `summaries.json`. Two things invalidate the whole file: a bump of
 * {@link CACHE_VERSION} for a change of on-disk shape, and a change to the
 * extraction code itself, caught by content-hashing it — see
 * {@link extractorStamp}. Neither asks anyone to remember to bump anything.
 */
import { fork } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerGraphCacheClearer } from "../context/graph-store.js";
import { CACHE_DIR } from "../context/node-file.js";
import {
    checkpointSqliteStore,
    getSqliteMeta,
    openSqliteStore,
    prepareStmt,
    sameWalRevision,
    setSqliteMeta,
    sqliteWalRevision,
    stripNodeBodyText,
    withSqliteTransaction,
} from "../storage/sqlite-store.js";
import { contentHash } from "../util/id.js";
import { pathUnderPrefix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { readJson } from "../util/state.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { extractFile, languageLabelOf, languageOf, warmDepthGrammars } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";
import { extractorStamp, pruneSidecars } from "./extractor-stamp.js";
export { extractorStamp, pruneSidecars };
/** Bump when the on-disk shape below changes. */
const CACHE_VERSION = 2;
export const EXTRACT_CACHE_PREFIX = "extract";
/**
 * Where this plexer's memo lives: `<outDir>/.cache/extract.<stamp>.json`.
 *
 * The stamp is in the *filename*, not just inside the file, so two plexer instances working
 * on one repo keep separate memos instead of evicting each other if an MCP server
 * and a CLI/hook invocation ever run from different checkout revisions.
 *
 * Null stamp → null path → no memo at all. See {@link extractorStamp}.
 */
function extractCachePath(outDir) {
    const stamp = extractorStamp();
    return stamp === null ? null : join(outDir, CACHE_DIR, `${EXTRACT_CACHE_PREFIX}.${stamp}.json`);
}
/** `pruneSidecars` and `extractorStamp` moved to `./extractor-stamp.js` (re-exported above). */
export function emptyExtractCache() {
    return { version: CACHE_VERSION, extractor: extractorStamp() ?? "", files: {} };
}

function unlinkLegacyExtractFiles(outDir) {
    const cacheDir = join(outDir, CACHE_DIR);
    try {
        for (const f of readdirSync(cacheDir)) {
            if (f === "extract.json" || (f.startsWith(`${EXTRACT_CACHE_PREFIX}.`) && f.endsWith(".json"))) {
                rmSync(join(cacheDir, f), { force: true });
            }
        }
    }
    catch {
        /* ignore if cacheDir absent */
    }
}

const MAX_EXTRACT_STATS_CACHE = 2;
const extractStatsCache = new Map();

function setCachedExtractStats(absOut, stamp, rev, stats) {
    if (!extractStatsCache.has(absOut) && extractStatsCache.size >= MAX_EXTRACT_STATS_CACHE) {
        const oldest = extractStatsCache.keys().next().value;
        if (oldest !== undefined)
            extractStatsCache.delete(oldest);
    }
    extractStatsCache.delete(absOut);
    extractStatsCache.set(absOut, { stamp, rev, stats });
}

export function syncExtractStatsRevision(outDir) {
    if (!outDir)
        return;
    const absOut = resolve(outDir);
    const cached = extractStatsCache.get(absOut);
    if (!cached)
        return;
    const rev = sqliteWalRevision(absOut);
    if (rev)
        cached.rev = rev;
    else
        extractStatsCache.delete(absOut);
}

registerGraphCacheClearer((outDir, opts) => {
    if (opts?.keepPriorNodes)
        return;
    if (outDir !== undefined && outDir !== null)
        extractStatsCache.delete(resolve(outDir));
    else
        extractStatsCache.clear();
});

/**
 * Lightweight SQLite stat/hash index reader (`files` metadata only, zero `nodes_json` parsing).
 * Falls back to legacy `.cache/extract.<stamp>.json` when `index.sqlite` isn't populated yet.
 */
export function readExtractCacheStats(outDir) {
    const stamp = extractorStamp();
    if (stamp === null) {
        return { source: "none", extractor: "", stats: new Map(), cache: emptyExtractCache() };
    }
    const absOut = resolve(outDir);
    const rev = sqliteWalRevision(absOut);
    const cached = extractStatsCache.get(absOut);
    if (cached && cached.stamp === stamp && rev && sameWalRevision(cached.rev, rev)) {
        return { source: "sqlite", extractor: stamp, stats: cached.stats, cache: null };
    }
    const store = openSqliteStore(outDir, { create: false });
    if (store) {
        try {
            const dbStamp = getSqliteMeta(store, "extractor_stamp");
            if (dbStamp === stamp) {
                const rows = prepareStmt(
                    store,
                    "SELECT path, mtime_ms, size, content_hash FROM files"
                ).all();
                const stats = new Map();
                for (const r of rows) {
                    stats.set(r.path, {
                        mtimeMs: Number(r.mtime_ms),
                        size: Number(r.size),
                        hash: String(r.content_hash),
                    });
                }
                if (stats.size > 0 || extractCachePath(outDir) === null || !readdirLegacyExtractExists(outDir)) {
                    setCachedExtractStats(absOut, stamp, rev ?? sqliteWalRevision(absOut), stats);
                    return { source: "sqlite", extractor: stamp, stats, cache: null };
                }
            }
        }
        catch {
            /* fall back to legacy cache */
        }
    }
    const legacy = readLegacyExtractCache(outDir, stamp);
    if (legacy) {
        return { source: "legacy", extractor: stamp, stats: null, cache: legacy };
    }
    return { source: "none", extractor: stamp, stats: new Map(), cache: emptyExtractCache() };
}

function readdirLegacyExtractExists(outDir) {
    const p = extractCachePath(outDir);
    if (!p)
        return false;
    try {
        statSync(p);
        return true;
    }
    catch {
        return false;
    }
}

function readLegacyExtractCache(outDir, stamp) {
    const path = extractCachePath(outDir);
    if (path === null || stamp === null)
        return null;
    const c = readJson(path);
    if (!c || c.version !== CACHE_VERSION || c.extractor !== stamp || typeof c.files !== "object") {
        return null;
    }
    return { version: c.version, extractor: c.extractor, files: c.files ?? {} };
}

/**
 * Load parsed `nodes` and `rawEdges` from SQLite `files` for only the requested relative paths.
 */
export function loadExtractCacheFiles(outDir, paths) {
    const out = new Map();
    const list = Array.isArray(paths) ? paths : [...paths];
    if (list.length === 0)
        return out;
    const store = openSqliteStore(outDir, { create: false });
    if (!store)
        return out;
    const CHUNK = 250;
    for (let off = 0; off < list.length; off += CHUNK) {
        const slice = list.slice(off, off + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const rows = store.db
            .prepare(
                `SELECT path, mtime_ms, size, content_hash, nodes_json, raw_edges_json
                 FROM files WHERE path IN (${placeholders})`
            )
            .all(...slice);
        for (const r of rows) {
            try {
                out.set(r.path, {
                    size: Number(r.size),
                    mtimeMs: Number(r.mtime_ms),
                    hash: String(r.content_hash),
                    nodes: JSON.parse(r.nodes_json),
                    rawEdges: JSON.parse(r.raw_edges_json),
                });
            }
            catch {
                /* skip corrupt row */
            }
        }
    }
    return out;
}

/**
 * The cache for `outDir`, backed by `<outDir>/.cache/index.sqlite` (or an empty one
 * when absent, written by a different extractor stamp, or lacking an identity).
 */
export function readExtractCache(outDir) {
    const stamp = extractorStamp();
    if (stamp === null)
        return emptyExtractCache();
    const store = openSqliteStore(outDir, { create: false });
    if (store) {
        try {
            const dbStamp = getSqliteMeta(store, "extractor_stamp");
            if (dbStamp === stamp) {
                const rows = prepareStmt(
                    store,
                    "SELECT path, mtime_ms, size, content_hash, nodes_json, raw_edges_json FROM files"
                ).all();
                const files = {};
                for (const r of rows) {
                    try {
                        files[r.path] = {
                            size: Number(r.size),
                            mtimeMs: Number(r.mtime_ms),
                            hash: String(r.content_hash),
                            nodes: JSON.parse(r.nodes_json),
                            rawEdges: JSON.parse(r.raw_edges_json),
                        };
                    }
                    catch {
                        /* skip corrupt row */
                    }
                }
                if (rows.length > 0 || !readdirLegacyExtractExists(outDir)) {
                    return { version: CACHE_VERSION, extractor: stamp, files };
                }
            }
        }
        catch {
            /* fall back to legacy JSON */
        }
    }
    return readLegacyExtractCache(outDir, stamp) ?? emptyExtractCache();
}

/**
 * Apply incremental `files` table mutations (`upsertEntries`, `updateStats`, `deletePaths`)
 * inside SQLite in one atomic transaction (stripping `body_text` from persisted nodes).
 */
export function writeExtractCacheIncremental(outDir, delta = {}) {
    const stamp = extractorStamp();
    if (stamp === null)
        return false;
    const store = openSqliteStore(outDir, { create: true });
    withSqliteTransaction(store, () => {
        setSqliteMeta(store, "extractor_stamp", stamp);
        const delStmt = prepareStmt(store, "DELETE FROM files WHERE path = ?");
        for (const rel of delta.deletePaths ?? []) {
            delStmt.run(rel);
        }
        const statStmt = prepareStmt(
            store,
            "UPDATE files SET mtime_ms = ?, size = ?, content_hash = ? WHERE path = ?"
        );
        for (const u of delta.updateStats ?? []) {
            statStmt.run(u.mtimeMs ?? 0, u.size ?? 0, u.hash ?? "", u.rel);
        }
        const upsertStmt = prepareStmt(
            store,
            `INSERT OR REPLACE INTO files(
                path, mtime_ms, size, content_hash, nodes_json, raw_edges_json
            ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        const entries = delta.upsertEntries ?? {};
        for (const [rel, entry] of Object.entries(entries)) {
            if (!entry)
                continue;
            const compactNodes = (entry.nodes ?? []).map(stripNodeBodyText);
            upsertStmt.run(
                rel,
                entry.mtimeMs ?? 0,
                entry.size ?? 0,
                entry.hash ?? "",
                JSON.stringify(compactNodes),
                JSON.stringify(entry.rawEdges ?? [])
            );
        }
    });
    if (store.txDepth === 0) {
        checkpointSqliteStore(outDir, "PASSIVE");
    }
    const absOut = resolve(outDir);
    const cached = extractStatsCache.get(absOut);
    if (cached && cached.stamp === stamp) {
        for (const rel of delta.deletePaths ?? [])
            cached.stats.delete(rel);
        for (const u of delta.updateStats ?? [])
            cached.stats.set(u.rel, { mtimeMs: u.mtimeMs ?? 0, size: u.size ?? 0, hash: u.hash ?? "" });
        for (const [rel, entry] of Object.entries(delta.upsertEntries ?? {})) {
            if (entry)
                cached.stats.set(rel, { mtimeMs: entry.mtimeMs ?? 0, size: entry.size ?? 0, hash: entry.hash ?? "" });
        }
        if (store.txDepth === 0)
            cached.rev = sqliteWalRevision(absOut);
    }
    unlinkLegacyExtractFiles(outDir);
    return true;
}

/**
 * Persist extracted file caches into `<outDir>/.cache/index.sqlite` (stripping `body_text`
 * from `nodes_json` to keep disk storage compact and below V8's 512MB JSON limit) and
 * unlink any legacy `.cache/extract.*.json` files.
 */
export function writeExtractCache(outDir, cache) {
    const stamp = extractorStamp();
    if (stamp === null)
        return false;
    const store = openSqliteStore(outDir, { create: true });
    const entries = cache?.files ?? {};
    const nextStats = new Map();
    withSqliteTransaction(store, () => {
        setSqliteMeta(store, "extractor_stamp", stamp);
        store.db.exec("DELETE FROM files");
        const upsertStmt = prepareStmt(
            store,
            `INSERT INTO files(
                path, mtime_ms, size, content_hash, nodes_json, raw_edges_json
            ) VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const [rel, entry] of Object.entries(entries)) {
            if (!entry)
                continue;
            const compactNodes = (entry.nodes ?? []).map(stripNodeBodyText);
            const mtimeMs = entry.mtimeMs ?? 0;
            const size = entry.size ?? 0;
            const hash = entry.hash ?? "";
            nextStats.set(rel, { mtimeMs, size, hash });
            upsertStmt.run(
                rel,
                mtimeMs,
                size,
                hash,
                JSON.stringify(compactNodes),
                JSON.stringify(entry.rawEdges ?? [])
            );
        }
    });
    if (store.txDepth === 0) {
        checkpointSqliteStore(outDir, "PASSIVE");
    }
    const absOut = resolve(outDir);
    setCachedExtractStats(absOut, stamp, sqliteWalRevision(absOut), nextStats);
    unlinkLegacyExtractFiles(outDir);
    return true;
}
function isRojoLuauFile(rel, opts) {
    if (!rel || !rel.endsWith(".lua"))
        return false;
    if (opts?.hasRojoProject)
        return true;
    return Boolean(opts?.rojoMountPrefixes?.some((p) => pathUnderPrefix(rel, p)));
}

function classifySourceFile(rel, opts = null) {
    const lang = languageOf(rel);
    const container = lang ? null : containerLangOf(rel);
    const generic = lang || container ? null : genericLangOf(rel);
    const label = languageLabelOf(rel) ?? container?.name ?? generic?.name ?? "unknown";
    const luauMode = generic?.name === "lua" && isRojoLuauFile(rel, opts);
    return { lang, container, generic, label, luauMode };
}

function isValidCachedNodes(cached, rel, classified = null) {
    if (!cached || !Array.isArray(cached.nodes) || !cached.nodes.every((n) => n && n.path === rel))
        return false;
    if (classified?.generic?.name === "lua") {
        const cachedLuau = Boolean(cached.nodes[0]?.luauMode);
        if (cachedLuau !== Boolean(classified.luauMode))
            return false;
    }
    return true;
}

function canReuseByStat(cached, f, rel, trustStat, classified = null) {
    return Boolean(
        trustStat &&
            cached?.hash &&
            !cached.error &&
            cached.size === f.size &&
            cached.mtimeMs === f.mtimeMs &&
            isValidCachedNodes(cached, rel, classified),
    );
}

function appendCachedResult(cached, label, state) {
    state.nodes.push(...cached.nodes);
    state.rawEdges.push(...cached.rawEdges);
    state.langs.add(label);
}

function compareUtf16Local(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

const EXTRACT_WORKER_PATH = fileURLToPath(new URL("./extract-worker.js", import.meta.url));
const WORKER_PARALLEL_THRESHOLD = 64;

function buildCleanWorkerEnv() {
    if (!("NODE_TEST_CONTEXT" in process.env))
        return process.env;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return env;
}

async function parseQueuedWithWorkers(toParse, state) {
    const sorted = [...toParse].sort((a, b) => compareUtf16Local(a.label, b.label) || compareUtf16Local(a.rel, b.rel));
    const envWorkers = Number.parseInt(process.env.PLEXER_WORKERS ?? "", 10);
    const maxWorkers = Number.isInteger(envWorkers) && envWorkers >= 1
        ? Math.min(4, envWorkers)
        : Math.min(4, Math.max(1, availableParallelism() - 1));
    const workerCount = Math.min(maxWorkers, Math.floor(sorted.length / 32));
    if (workerCount <= 1)
        return false;

    const chunkSize = Math.ceil(sorted.length / workerCount);
    const workerEnv = buildCleanWorkerEnv();
    const children = [];
    const promises = [];
    try {
        for (let off = 0; off < sorted.length; off += chunkSize) {
            const slice = sorted.slice(off, off + chunkSize).map((it) => ({
                abs: it.f.abs,
                rel: it.rel,
                size: it.f.size,
                mtimeMs: it.f.mtimeMs,
                lang: it.lang ?? null,
                genericName: it.generic?.name ?? null,
                containerName: it.container?.name ?? null,
                label: it.label,
                luauMode: Boolean(it.luauMode),
            }));
            promises.push(new Promise((resolveDone, rejectDone) => {
                const child = fork(EXTRACT_WORKER_PATH, [], {
                    execArgv: [],
                    serialization: "advanced",
                    stdio: ["ignore", "ignore", "pipe", "ipc"],
                    env: workerEnv,
                });
                children.push(child);
                let stderrText = "";
                child.stderr?.on("data", (d) => {
                    stderrText += String(d);
                });
                let settled = false;
                child.once("message", (msg) => {
                    if (settled)
                        return;
                    settled = true;
                    if (msg?.fatal) {
                        rejectDone(new Error(msg.fatal));
                        return;
                    }
                    resolveDone(Array.isArray(msg?.results) ? msg.results : []);
                });
                child.once("error", (err) => {
                    if (settled)
                        return;
                    settled = true;
                    rejectDone(err);
                });
                child.once("exit", (code) => {
                    if (!settled) {
                        settled = true;
                        rejectDone(new Error(`extract-worker exited with code ${code}${stderrText ? `: ${stderrText.trim()}` : ""}`));
                    }
                });
                child.send({ items: slice });
            }));
        }

        const batchLists = await Promise.all(promises);
        const merged = [];
        for (const list of batchLists) {
            for (const r of list)
                merged.push(r);
        }
        merged.sort((a, b) => compareUtf16Local(a.rel, b.rel));
        for (const r of merged) {
            if (!r.hash && r.error) {
                state.errors.push(r.error);
                state.entries[r.rel] = { size: r.size, mtimeMs: r.mtimeMs, hash: "", nodes: [], rawEdges: [], error: r.error };
                state.mtimeDirty = true;
                continue;
            }
            if (!r.hash) {
                state.entries[r.rel] = { size: r.size, mtimeMs: r.mtimeMs, hash: "", nodes: [], rawEdges: [] };
                state.mtimeDirty = true;
                continue;
            }
            state.parsed++;
            if (r.error) {
                state.errors.push(r.error);
                state.entries[r.rel] = { size: r.size, mtimeMs: r.mtimeMs, hash: r.hash, nodes: [], rawEdges: [], error: r.error };
                continue;
            }
            state.nodes.push(...r.nodes);
            state.rawEdges.push(...r.rawEdges);
            state.langs.add(r.label);
            state.entries[r.rel] = { size: r.size, mtimeMs: r.mtimeMs, hash: r.hash, nodes: r.nodes, rawEdges: r.rawEdges };
        }
        return true;
    }
    finally {
        for (const child of children) {
            if (child.exitCode === null && !child.killed) {
                try { child.kill(); } catch { /* ignore */ }
            }
        }
    }
}

function inspectOrQueueSourceFile(f, prevCache, trustStat, state, opts = null, deferColdRead = false) {
    const rel = f.rel;
    const classified = classifySourceFile(rel, opts);
    const cached = prevCache.files[rel];
    if (canReuseByStat(cached, f, rel, trustStat, classified)) {
        state.entries[rel] = cached;
        state.reused++;
        appendCachedResult(cached, classified.label, state);
        return;
    }
    if (deferColdRead && !cached?.hash) {
        state.toParse.push({ f, rel, source: null, hash: null, ...classified });
        return;
    }
    let source;
    try {
        source = readSourceFile(f.abs);
    }
    catch (err) {
        const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
        state.errors.push(message);
        state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message };
        state.mtimeDirty = true;
        return;
    }
    if (source === null) {
        state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
        state.mtimeDirty = true;
        return;
    }
    const hash = contentHash(source);
    if (hash === cached?.hash && isValidCachedNodes(cached, rel, classified)) {
        state.entries[rel] = { ...cached, size: f.size, mtimeMs: f.mtimeMs };
        state.mtimeDirty = true;
        state.reused++;
        if (cached.error)
            state.errors.push(cached.error);
        else
            appendCachedResult(cached, classified.label, state);
        return;
    }
    state.toParse.push({ f, rel, source, hash, ...classified });
}

function runSingleFileExtractor(item, source) {
    if (item.lang)
        return extractFile(item.rel, source, item.lang);
    if (item.container)
        return extractContainer(item.rel, source, item.container);
    if (item.generic)
        return extractGeneric(item.rel, source, item.generic.name, item.luauMode ? { luauMode: true } : null);
    return null;
}

async function parseQueuedSourceFiles(state) {
    const { toParse } = state;
    if (toParse.length === 0)
        return;
    if (toParse.length >= WORKER_PARALLEL_THRESHOLD && process.env.PLEXER_NO_WORKERS !== "1") {
        const handled = await parseQueuedWithWorkers(toParse, state);
        if (handled) {
            toParse.length = 0;
            return;
        }
    }
    const genericLangs = new Set(toParse.map((p) => p.generic?.name).filter(Boolean));
    if (toParse.some((p) => p.luauMode))
        genericLangs.add("luau");
    await Promise.all([
        warmDepthGrammars(new Set(toParse.map((p) => p.lang).filter(Boolean))),
        warmGenericGrammars(genericLangs),
        warmContainerGrammars(new Set(toParse.map((p) => p.container?.name).filter(Boolean))),
    ]);
    for (const item of toParse) {
        const { f, rel, label } = item;
        let source = item.source;
        let hash = item.hash;
        item.source = null;
        if (source === null) {
            try {
                source = readSourceFile(f.abs);
            }
            catch (err) {
                const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
                state.errors.push(message);
                state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message };
                state.mtimeDirty = true;
                continue;
            }
            if (source === null) {
                state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
                state.mtimeDirty = true;
                continue;
            }
            hash = contentHash(source);
        }
        state.parsed++;
        try {
            const extracted = runSingleFileExtractor(item, source);
            if (!extracted)
                continue;
            appendCachedResult(extracted, label, state);
            state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: extracted.nodes, rawEdges: extracted.rawEdges };
        }
        catch (err) {
            const message = `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`;
            state.errors.push(message);
            state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: [], rawEdges: [], error: message };
        }
    }
    toParse.length = 0;
}

/**
 * Shared 3-tier classification, cache replay, concurrent WASM warming, and
 * extraction used by `buildGraph` and `checkGraph`.
 */
export async function extractSourceFiles(files, prevCache, opts = {}) {
    const trustStat = (opts.trustStat ?? true) && process.env.PLEXER_REFRESH !== "hash";
    const deferColdRead = files.length >= WORKER_PARALLEL_THRESHOLD && process.env.PLEXER_NO_WORKERS !== "1";
    const state = {
        nodes: [],
        rawEdges: [],
        langs: new Set(),
        errors: [],
        entries: {},
        toParse: [],
        parsed: 0,
        reused: 0,
        mtimeDirty: false,
    };
    for (let i = 0; i < files.length; i++) {
        opts.onProgress?.({ phase: "parse", index: i, total: files.length, file: files[i].rel });
        inspectOrQueueSourceFile(files[i], prevCache, trustStat, state, opts, deferColdRead);
    }
    await parseQueuedSourceFiles(state);
    const { nodes, rawEdges, langs, errors, entries, parsed, reused, mtimeDirty } = state;
    return { nodes, rawEdges, langs, errors, entries, parsed, reused, mtimeDirty };
}

/**
 * Metadata-first incremental extractor backed by SQLite `files`.
 * Only reads & parses modified/added files (`dirtyPaths`), deferring AST deserialization of
 * unchanged files unless downstream callers request specific `loadExtractCacheFiles` paths.
 */
export async function extractSourceFilesIncremental(files, outDir, opts = {}) {
    const useCache = opts.reuse !== false;
    const statsInfo = useCache ? readExtractCacheStats(outDir) : { source: "none", stats: new Map(), cache: emptyExtractCache() };
    let priorRojoMode = null;
    if (statsInfo.source === "sqlite") {
        const store = openSqliteStore(outDir, { create: false });
        if (store) {
            try {
                priorRojoMode = getSqliteMeta(store, "rojo_lua_mode") === "1";
            }
            catch {
                priorRojoMode = null;
            }
        }
    }
    const wantRojoMode = Boolean(opts.hasRojoProject);
    const luaModeMismatch = priorRojoMode !== null && priorRojoMode !== wantRojoMode;
    if (statsInfo.source !== "sqlite") {
        const prevCache = statsInfo.source === "legacy" ? statsInfo.cache : emptyExtractCache();
        const full = await extractSourceFiles(files, prevCache, opts);
        return {
            mode: "full",
            ...full,
            dirtyPaths: new Set(files.map((f) => f.rel)),
            deletedPaths: [],
            cleanPaths: new Set(),
            mtimeUpdates: [],
        };
    }

    const trustStat = (opts.trustStat ?? true) && process.env.PLEXER_REFRESH !== "hash";
    const statsMap = statsInfo.stats;
    const seenPaths = new Set();
    const cleanPaths = new Set();
    const dirtyPaths = new Set();
    const mtimeUpdates = [];

    const state = {
        nodes: [],
        rawEdges: [],
        langs: new Set(),
        errors: [],
        entries: {},
        toParse: [],
        parsed: 0,
        reused: 0,
        mtimeDirty: false,
    };

    const deferColdRead = files.length >= WORKER_PARALLEL_THRESHOLD && process.env.PLEXER_NO_WORKERS !== "1";
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rel = f.rel;
        seenPaths.add(rel);
        opts.onProgress?.({ phase: "parse", index: i, total: files.length, file: rel });
        const classified = classifySourceFile(rel, opts);
        const st = statsMap.get(rel);
        const canTrustFileStat = trustStat && !(luaModeMismatch && rel.endsWith(".lua"));

        if (canTrustFileStat && st && st.hash && st.size === f.size && st.mtimeMs === f.mtimeMs) {
            state.reused++;
            cleanPaths.add(rel);
            state.langs.add(classified.label);
            continue;
        }
        if (deferColdRead && (!st?.hash || (luaModeMismatch && rel.endsWith(".lua")))) {
            dirtyPaths.add(rel);
            state.toParse.push({ f, rel, source: null, hash: null, ...classified });
            continue;
        }

        let source;
        try {
            source = readSourceFile(f.abs);
        }
        catch (err) {
            const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
            state.errors.push(message);
            state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message };
            dirtyPaths.add(rel);
            state.mtimeDirty = true;
            continue;
        }
        if (source === null) {
            state.entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
            dirtyPaths.add(rel);
            state.mtimeDirty = true;
            continue;
        }

        const hash = contentHash(source);
        if (st && st.hash && hash === st.hash && !(luaModeMismatch && rel.endsWith(".lua"))) {
            mtimeUpdates.push({ rel, size: f.size, mtimeMs: f.mtimeMs, hash });
            state.mtimeDirty = true;
            state.reused++;
            cleanPaths.add(rel);
            state.langs.add(classified.label);
            continue;
        }

        dirtyPaths.add(rel);
        state.toParse.push({ f, rel, source, hash, ...classified });
    }

    const deletedPaths = [];
    for (const oldPath of statsMap.keys()) {
        if (!seenPaths.has(oldPath)) {
            deletedPaths.push(oldPath);
        }
    }

    await parseQueuedSourceFiles(state);

    return {
        mode: "sqlite",
        nodes: state.nodes,
        rawEdges: state.rawEdges,
        langs: state.langs,
        errors: state.errors,
        entries: state.entries,
        parsed: state.parsed,
        reused: state.reused,
        mtimeDirty: state.mtimeDirty,
        dirtyPaths,
        deletedPaths,
        cleanPaths,
        mtimeUpdates,
    };
}
