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
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { readPackageVersion } from "../util/cli-meta.js";
import { CACHE_DIR } from "../context/node-file.js";
import {
    checkpointSqliteStore,
    getSqliteMeta,
    openSqliteStore,
    prepareStmt,
    setSqliteMeta,
    stripNodeBodyText,
    withSqliteTransaction,
} from "../storage/sqlite-store.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { readJson } from "../util/state.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { extractFile, languageLabelOf, languageOf, warmDepthGrammars } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";
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
/** Keep `.cache/` from growing a file per version forever: after writing, drop all
 * but the newest `keep` files sharing a prefix. Best-effort and never fatal — this
 * is a cache directory, and a failure here costs disk, not correctness. */
export function pruneSidecars(cacheDir, prefix, keep = 2) {
    try {
        const mine = readdirSync(cacheDir)
            .filter((f) => f.startsWith(`${prefix}.`) && f.endsWith(".json"))
            .map((f) => {
            const full = join(cacheDir, f);
            return { full, mtimeMs: statSync(full).mtimeMs };
        })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const f of mine.slice(keep))
            rmSync(f.full, { force: true });
    }
    catch {
        /* nothing here is load-bearing */
    }
}
/** Computed once per process — this can't change under a running process without
 * the module graph itself being swapped, and a long-lived MCP server holding the
 * identity of the code it actually loaded is the correct answer anyway.
 * `undefined` = not computed yet; `null` = computed, and there is no identity. */
let memoizedStamp;
/**
 * Identity of the code that produces the cached parses. Both sidecars key on it,
 * so *anything* that can change extraction output has to change this string.
 *
 * Content-hashed over every sibling module in this directory, plus the package
 * version. Two earlier instincts are deliberately rejected:
 *
 * - **Not a timestamp.** This was `mtime:size` of `extract.js` alone, which is
 *   wrong in both directions. Too loose: the parse of `db.count()` depends on
 *   `bindings.js` deciding that `db` is a `UserRepo` (that answer is stored *in*
 *   the cached entry, as an edge's `recvType`), and fixing a binding bug leaves
 *   `extract.js`'s emitted bytes untouched — so any build that skips rewriting
 *   unchanged output keeps the old stamp and silently replays pre-fix edges. Too
 *   tight: a rebuild that rewrites identical content moves the mtime and throws
 *   away the whole memo for nothing.
 * - **Not a hand-kept list of modules.** A list is correct exactly until someone
 *   moves parse logic into a module nobody added to it, and the failure is silent.
 *
 * Hashing the directory over-invalidates a little — editing any `graph/` module
 * costs one cold rebuild — which is no more often than a version bump already
 * costs, and always in the safe direction. The package version is folded in so a
 * tree-sitter grammar upgrade (which changes parse output without changing any of
 * plexer's own files) invalidates too.
 *
 * Measured at ~0.5ms for 21 files / 556KB, paid once per process.
 *
 * **Null when no identity can be established at all**, and that is deliberately not
 * a string. It used to return `"unknown"` on failure — but `"unknown"` was then
 * *written into the sidecars as a real identity*, and every later run compared equal
 * to it, so any environment where stamping fails (a `pkg`/`bun-compile` single-file
 * build, an asar-style read, a directory that can't be listed) permanently lost the
 * ability to notice an extractor change. A sentinel that doubles as a valid value
 * silently disables the whole mechanism. Null forces callers to decide instead, and
 * {@link extractCachePath} decides not to have a memo.
 */
export function extractorStamp() {
    if (memoizedStamp === undefined)
        memoizedStamp = computeStamp();
    return memoizedStamp;
}
function computeStamp() {
    try {
        const self = fileURLToPath(import.meta.url);
        // `.js` when running from `dist/`, `.ts` under tsx — take the extension from
        // our own filename rather than guessing which layout we're in.
        const dir = dirname(self);
        const v = readPackageVersion(import.meta.url);
        const hashed = stampDir(dir, extname(self), v ?? "");
        if (hashed)
            return hashed;
        // Couldn't read the modules (bundled into one file, say). The version alone is
        // a weaker identity — it can't see a local edit — but it still turns over on
        // every upgrade, which is the case that ships broken parses to users.
        return v ? `v${v}` : null;
    }
    catch (err) {
        const fallback = null;
        void err;
        return fallback;
    }
}
/**
 * Hash every `ext` file in `dir`, plus `version`. Null when the directory holds no
 * such file. Separated from {@link extractorStamp} so a test can prove the property
 * that matters: a change to *any* module in the directory moves the stamp, not just
 * the one the old implementation happened to watch.
 */
function stampDir(dir, ext, version = "") {
    const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
    if (!files.length)
        return null;
    const h = createHash("sha256");
    h.update(version);
    for (const f of files) {
        h.update(f); // a rename is a change, even at identical content
        h.update(readFileSync(join(dir, f)));
    }
    try {
        const queriesDir = join(dir, "queries");
        const scmFiles = readdirSync(queriesDir).filter((f) => f.endsWith(".scm")).sort();
        for (const qf of scmFiles) {
            h.update(`queries/${qf}`);
            h.update(readFileSync(join(queriesDir, qf)));
        }
    }
    catch {
        /* no queries/ subdir */
    }
    try {
        const extractDir = join(dir, "extract");
        const extractFiles = readdirSync(extractDir)
            .filter((f) => f.endsWith(".js") || (ext && f.endsWith(ext)))
            .sort();
        for (const ef of extractFiles) {
            h.update(`extract/${ef}`);
            h.update(readFileSync(join(extractDir, ef)));
        }
    }
    catch {
        /* no extract/ subdir */
    }
    try {
        const grammarsDir = join(dir, "..", "..", "grammars");
        const wasmFiles = readdirSync(grammarsDir).filter((f) => f.endsWith(".wasm")).sort();
        for (const wf of wasmFiles) {
            h.update(`grammars/${wf}`);
            h.update(readFileSync(join(grammarsDir, wf)));
        }
    }
    catch {
        /* no grammars/ subdir */
    }
    try {
        const idPath = join(dir, "..", "util", ext && ext !== ".js" ? `id${ext}` : "id.js");
        h.update("util/id.js");
        h.update(readFileSync(idPath));
    }
    catch {
        /* id.js missing in bundled build */
    }
    return h.digest("hex").slice(0, 16);
}
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

/**
 * Lightweight SQLite stat/hash index reader (`files` metadata only, zero `nodes_json` parsing).
 * Falls back to legacy `.cache/extract.<stamp>.json` when `index.sqlite` isn't populated yet.
 */
export function readExtractCacheStats(outDir) {
    const stamp = extractorStamp();
    if (stamp === null) {
        return { source: "none", extractor: "", stats: new Map(), cache: emptyExtractCache() };
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
    try {
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
        unlinkLegacyExtractFiles(outDir);
        return true;
    }
    catch {
        return false;
    }
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
    try {
        const store = openSqliteStore(outDir, { create: true });
        const entries = cache?.files ?? {};
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
        unlinkLegacyExtractFiles(outDir);
        return true;
    }
    catch {
        return false;
    }
}
function classifySourceFile(rel) {
    const lang = languageOf(rel);
    const container = lang ? null : containerLangOf(rel);
    const generic = lang || container ? null : genericLangOf(rel);
    const label = languageLabelOf(rel) ?? container?.name ?? generic?.name ?? "unknown";
    return { lang, container, generic, label };
}

function isValidCachedNodes(cached, rel) {
    return Boolean(cached && Array.isArray(cached.nodes) && cached.nodes.every((n) => n && n.path === rel));
}

function canReuseByStat(cached, f, rel, trustStat) {
    return Boolean(
        trustStat &&
            cached?.hash &&
            !cached.error &&
            cached.size === f.size &&
            cached.mtimeMs === f.mtimeMs &&
            isValidCachedNodes(cached, rel),
    );
}

function appendCachedResult(cached, label, state) {
    state.nodes.push(...cached.nodes);
    state.rawEdges.push(...cached.rawEdges);
    state.langs.add(label);
}

function inspectOrQueueSourceFile(f, prevCache, trustStat, state) {
    const rel = f.rel;
    const classified = classifySourceFile(rel);
    const cached = prevCache.files[rel];
    if (canReuseByStat(cached, f, rel, trustStat)) {
        state.entries[rel] = cached;
        state.reused++;
        appendCachedResult(cached, classified.label, state);
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
    if (hash === cached?.hash && isValidCachedNodes(cached, rel)) {
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

function runSingleFileExtractor(item) {
    if (item.lang)
        return extractFile(item.rel, item.source, item.lang);
    if (item.container)
        return extractContainer(item.rel, item.source, item.container);
    if (item.generic)
        return extractGeneric(item.rel, item.source, item.generic.name);
    return null;
}

async function parseQueuedSourceFiles(state) {
    const { toParse } = state;
    if (toParse.length === 0)
        return;
    await Promise.all([
        warmDepthGrammars(new Set(toParse.map((p) => p.lang).filter(Boolean))),
        warmGenericGrammars(new Set(toParse.map((p) => p.generic?.name).filter(Boolean))),
        warmContainerGrammars(new Set(toParse.map((p) => p.container?.name).filter(Boolean))),
    ]);
    for (const item of toParse) {
        const { f, rel, hash, label } = item;
        state.parsed++;
        try {
            const extracted = runSingleFileExtractor(item);
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
}

/**
 * Shared 3-tier classification, cache replay, concurrent WASM warming, and
 * extraction used by `buildGraph` and `checkGraph`.
 */
export async function extractSourceFiles(files, prevCache, opts = {}) {
    const trustStat = (opts.trustStat ?? true) && process.env.PLEXER_REFRESH !== "hash";
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
        inspectOrQueueSourceFile(files[i], prevCache, trustStat, state);
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

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rel = f.rel;
        seenPaths.add(rel);
        opts.onProgress?.({ phase: "parse", index: i, total: files.length, file: rel });
        const classified = classifySourceFile(rel);
        const st = statsMap.get(rel);

        if (trustStat && st && st.hash && st.size === f.size && st.mtimeMs === f.mtimeMs) {
            state.reused++;
            cleanPaths.add(rel);
            state.langs.add(classified.label);
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
        if (st && st.hash && hash === st.hash) {
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
