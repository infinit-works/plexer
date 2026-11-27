/**
 * Built-in `node:sqlite` WAL-backed persistence store at `<outDir>/.cache/index.sqlite`.
 *
 * Replaces separate JSON extract-cache and ask-index files with a single atomic SQLite
 * database supporting incremental dirty-cone dependency tracking and multi-channel BM25 postings.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { registerGraphCacheClearer } from "../context/graph-store.js";
import { CACHE_DIR } from "../context/node-file.js";
import { serializeGraph, writeSerializedGraph } from "../graph/write.js";

function loadNodeSqlite() {
    const origEmitWarning = process.emitWarning;
    process.emitWarning = function (warning, ...args) {
        const type = typeof args[0] === "string" ? args[0] : (args[0]?.type ?? warning?.name);
        const msg = typeof warning === "string" ? warning : warning?.message;
        if (type === "ExperimentalWarning" && typeof msg === "string" && msg.includes("SQLite")) {
            return;
        }
        return origEmitWarning.call(this, warning, ...args);
    };
    try {
        return createRequire(import.meta.url)("node:sqlite");
    }
    finally {
        process.emitWarning = origEmitWarning;
    }
}

export const { DatabaseSync } = loadNodeSqlite();

export const SQLITE_FILE = "index.sqlite";
export const SQLITE_SCHEMA_VERSION = 3;
const MAX_OPEN_STORES = 12;
const MAX_CACHED_STMTS = 64;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  raw_edges_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_deps (
  source_path TEXT NOT NULL,
  dep_key TEXT NOT NULL,
  PRIMARY KEY (source_path, dep_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_symbol_deps_dep ON symbol_deps(dep_key);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  span TEXT NOT NULL,
  signature TEXT,
  exported INTEGER NOT NULL,
  origin TEXT,
  owner TEXT,
  body_hash TEXT,
  chars INTEGER,
  summary TEXT,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path);

CREATE TABLE IF NOT EXISTS graph_edges (
  source TEXT NOT NULL,
  source_path TEXT NOT NULL,
  relation TEXT NOT NULL,
  target TEXT NOT NULL,
  target_path TEXT,
  meta_json TEXT,
  PRIMARY KEY (source, relation, target)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_graph_edges_source_path ON graph_edges(source_path);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target);

CREATE TABLE IF NOT EXISTS ask_docs (
  doc_id INTEGER PRIMARY KEY,
  node_id TEXT UNIQUE NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  span TEXT NOT NULL,
  signature TEXT,
  summary TEXT,
  exported INTEGER NOT NULL,
  field_lens_json TEXT NOT NULL DEFAULT '{}',
  len_name INTEGER NOT NULL DEFAULT 0,
  len_path INTEGER NOT NULL DEFAULT 0,
  len_sig INTEGER NOT NULL DEFAULT 0,
  len_summary INTEGER NOT NULL DEFAULT 0,
  len_literals INTEGER NOT NULL DEFAULT 0,
  len_body INTEGER NOT NULL DEFAULT 0,
  len_exact INTEGER NOT NULL DEFAULT 0,
  pagerank REAL NOT NULL DEFAULT 0,
  terms_blob BLOB
);

CREATE INDEX IF NOT EXISTS idx_ask_docs_path ON ask_docs(path);

CREATE TABLE IF NOT EXISTS ask_postings (
  channel TEXT NOT NULL,
  term TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  tf INTEGER NOT NULL,
  PRIMARY KEY (channel, term, doc_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ask_postings_doc ON ask_postings(doc_id);

CREATE TABLE IF NOT EXISTS ask_df (
  channel TEXT NOT NULL,
  term TEXT NOT NULL,
  df INTEGER NOT NULL,
  PRIMARY KEY (channel, term)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ask_vocab (
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  df INTEGER NOT NULL,
  PRIMARY KEY (kind, token)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ask_term_postings (
  channel TEXT NOT NULL,
  term TEXT NOT NULL,
  df INTEGER NOT NULL,
  postings BLOB NOT NULL,
  PRIMARY KEY (channel, term)
) WITHOUT ROWID;
`;

const openStores = new Map();

/** Absolute path to `<outDir>/.cache/index.sqlite`. */
export function sqliteStorePath(outDir) {
    return join(resolve(outDir), CACHE_DIR, SQLITE_FILE);
}

/** True when `<outDir>/.cache/index.sqlite` exists on disk. */
export function sqliteStoreExists(outDir) {
    return existsSync(sqliteStorePath(outDir));
}

function statSignature(path) {
    try {
        const st = statSync(path);
        return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
    }
    catch {
        return null;
    }
}

/**
 * Returns combined mtime/size/inode signature across `index.sqlite` and its `-wal` sidecar
 * so in-memory readers detect out-of-process WAL writes immediately.
 */
export function sqliteWalRevision(outDir) {
    const dbPath = sqliteStorePath(outDir);
    const main = statSignature(dbPath);
    if (!main)
        return null;
    const wal = statSignature(`${dbPath}-wal`);
    return {
        dev: main.dev,
        ino: main.ino,
        mtimeMs: main.mtimeMs,
        size: main.size,
        walMtimeMs: wal?.mtimeMs ?? 0,
        walSize: wal?.size ?? 0,
    };
}

/** True when two `sqliteWalRevision` snapshots represent the exact same file & WAL state. */
export function sameWalRevision(a, b) {
    if (!a || !b)
        return a === b;
    return (
        a.dev === b.dev &&
        a.ino === b.ino &&
        a.mtimeMs === b.mtimeMs &&
        a.size === b.size &&
        a.walMtimeMs === b.walMtimeMs &&
        a.walSize === b.walSize
    );
}

/** Remove legacy JSON caches (`extract.*.json`, `ask-index.json`) once `index.sqlite` is active. */
export function cleanupLegacyCacheFiles(outDir) {
    const cacheDir = join(resolve(outDir), CACHE_DIR);
    let entries;
    try {
        entries = readdirSync(cacheDir);
    }
    catch {
        return;
    }
    for (const f of entries) {
        if (f === "ask-index.json" || f === "extract.json" || (f.startsWith("extract.") && f.endsWith(".json"))) {
            try {
                unlinkSync(join(cacheDir, f));
            }
            catch {
                /* best-effort legacy cache cleanup */
            }
        }
    }
}

function configurePragmas(db, readOnly = false) {
    if (!readOnly) {
        db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA wal_autocheckpoint = 4000;
        `);
    }
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA cache_size = -8000;
        PRAGMA mmap_size = 0;
        PRAGMA temp_store = MEMORY;
    `);
}

function ensureSchema(db) {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!hasMeta) {
        db.exec(SCHEMA_DDL);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
            String(SQLITE_SCHEMA_VERSION)
        );
        return;
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) {
        db.exec(SCHEMA_DDL);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
            String(SQLITE_SCHEMA_VERSION)
        );
        return;
    }
    if (String(row.value) !== String(SQLITE_SCHEMA_VERSION)) {
        db.exec(`
            DROP TABLE IF EXISTS ask_doc_terms;
            DROP TABLE IF EXISTS ask_term_postings;
            DROP TABLE IF EXISTS ask_vocab;
            DROP TABLE IF EXISTS ask_df;
            DROP TABLE IF EXISTS ask_postings;
            DROP TABLE IF EXISTS ask_docs;
            DROP TABLE IF EXISTS graph_edges;
            DROP TABLE IF EXISTS graph_nodes;
            DROP TABLE IF EXISTS symbol_deps;
            DROP TABLE IF EXISTS files;
            DROP TABLE IF EXISTS meta;
        `);
        db.exec(SCHEMA_DDL);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
            String(SQLITE_SCHEMA_VERSION)
        );
        return;
    }
    const hasPacked = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ask_term_postings'").get();
    if (!hasPacked) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS ask_term_postings (
              channel TEXT NOT NULL,
              term TEXT NOT NULL,
              df INTEGER NOT NULL,
              postings BLOB NOT NULL,
              PRIMARY KEY (channel, term)
            ) WITHOUT ROWID;
        `);
    }
    const hasTermsCol = db.prepare("SELECT 1 FROM pragma_table_info('ask_docs') WHERE name = 'terms_blob'").get();
    if (!hasTermsCol) {
        db.exec("ALTER TABLE ask_docs ADD COLUMN terms_blob BLOB;");
    }
    db.exec("DROP TABLE IF EXISTS ask_doc_terms;");
}

function closeEntry(key, entry, checkpoint = true) {
    if (!entry)
        return;
    entry.closed = true;
    openStores.delete(key);
    entry.stmts.clear();
    try {
        if (checkpoint && !entry.readOnly) {
            entry.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
        }
    }
    catch {
        /* non-fatal if busy or read-only */
    }
    try {
        entry.db.close();
    }
    catch {
        /* ignore close errors on already-closed handle */
    }
}

/**
 * Close and discard cached `DatabaseSync` handles + prepared statements.
 * Passing `outDir` closes that workspace's store; omitting it closes all open stores.
 */
export function closeSqliteStores(outDir) {
    if (outDir !== undefined && outDir !== null) {
        const key = resolve(outDir);
        closeEntry(key, openStores.get(key));
        return;
    }
    for (const [key, entry] of [...openStores.entries()]) {
        closeEntry(key, entry);
    }
}

/**
 * Open (or reuse cached) WAL-mode `DatabaseSync` store at `<outDir>/.cache/index.sqlite`.
 * When `opts.create` is `false`, returns `null` if the database file does not exist yet.
 */
export function openSqliteStore(outDir, opts = {}) {
    const create = opts.create !== false;
    const readOnly = Boolean(opts.readOnly);
    const key = resolve(outDir);
    const dbPath = sqliteStorePath(key);
    const existing = openStores.get(key);
    const diskSig = statSignature(dbPath);

    if (existing) {
        // Reopen if file was deleted/replaced on disk (e.g. seedGraph) or caller needs writable handle.
        const replaced = !diskSig || diskSig.ino !== existing.ino || diskSig.dev !== existing.dev;
        const needWritable = !readOnly && create && existing.readOnly;
        if (!replaced && !needWritable) {
            openStores.delete(key);
            openStores.set(key, existing);
            return existing;
        }
        closeEntry(key, existing, false);
    }

    if (openStores.size >= MAX_OPEN_STORES) {
        for (const [evictKey, evictEntry] of openStores.entries()) {
            if (evictEntry.txDepth === 0) {
                closeEntry(evictKey, evictEntry, true);
                break;
            }
        }
    }

    if (!diskSig && !create) {
        return null;
    }

    if (create) {
        mkdirSync(join(key, CACHE_DIR), { recursive: true });
    }

    let db;
    let isReadOnly = readOnly;
    try {
        db = isReadOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
        configurePragmas(db, isReadOnly);
        if (!isReadOnly) {
            ensureSchema(db);
        }
    }
    catch (err) {
        try {
            db?.close();
        }
        catch {
            /* ignore cleanup */
        }
        // Fallback to read-only open when caller doesn't require writes (e.g. read-only mount).
        if (!create && !isReadOnly && diskSig) {
            db = new DatabaseSync(dbPath, { readOnly: true });
            isReadOnly = true;
            configurePragmas(db, true);
        }
        else {
            throw err;
        }
    }

    const sig = statSignature(dbPath);
    const store = {
        outDir: key,
        dbPath,
        db,
        stmts: new Map(),
        ino: sig?.ino ?? null,
        dev: sig?.dev ?? null,
        readOnly: isReadOnly,
        txDepth: 0,
        closed: false,
    };
    openStores.set(key, store);
    return store;
}

function setBoundedStmt(store, key, stmt) {
    if (store.stmts.size >= MAX_CACHED_STMTS && !store.stmts.has(key)) {
        const oldestKey = store.stmts.keys().next().value;
        if (oldestKey !== undefined) {
            store.stmts.delete(oldestKey);
        }
    }
    store.stmts.delete(key);
    store.stmts.set(key, stmt);
    return stmt;
}

/** Cache and return a compiled prepared statement per open store. */
export function prepareStmt(store, sql) {
    let stmt = store.stmts.get(sql);
    if (stmt !== undefined) {
        store.stmts.delete(sql);
        store.stmts.set(sql, stmt);
        return stmt;
    }
    stmt = store.db.prepare(sql);
    return setBoundedStmt(store, sql, stmt);
}

const ARRAY_STMT_PREFIX = "arr:";

/**
 * Cache and return a prepared statement configured with `setReturnArrays(true)` when supported
 * by `node:sqlite`, or `null` on older Node 22.x runtimes without `setReturnArrays`.
 */
export function prepareArrayStmt(store, sql) {
    const cacheKey = ARRAY_STMT_PREFIX + sql;
    const cached = store.stmts.get(cacheKey);
    if (cached !== undefined) {
        store.stmts.delete(cacheKey);
        store.stmts.set(cacheKey, cached);
        return cached;
    }
    const raw = store.db.prepare(sql);
    if (typeof raw.setReturnArrays === "function") {
        raw.setReturnArrays(true);
        return setBoundedStmt(store, cacheKey, raw);
    }
    return setBoundedStmt(store, cacheKey, null);
}

const BATCH_PLACEHOLDER_CACHE = new Map();

function getBatchValuesPlaceholders(colsPerRow, batchRows) {
    const k = `${colsPerRow}x${batchRows}`;
    let cached = BATCH_PLACEHOLDER_CACHE.get(k);
    if (!cached) {
        const oneRow = `(${new Array(colsPerRow).fill("?").join(", ")})`;
        cached = new Array(batchRows).fill(oneRow).join(", ");
        BATCH_PLACEHOLDER_CACHE.set(k, cached);
    }
    return cached;
}

/**
 * Create a buffered multi-row SQLite `INSERT` helper over cached prepared statements
 * to amortize JS-to-SQLite call crossings on bulk writes.
 */
export function createBatchInserter(store, sqlPrefix, colsPerRow, batchRows = 64) {
    const safeRows = Math.max(1, Math.min(batchRows, Math.floor(720 / colsPerRow)));
    const batchSql = `${sqlPrefix} VALUES ${getBatchValuesPlaceholders(colsPerRow, safeRows)}`;
    const singleSql = `${sqlPrefix} VALUES ${getBatchValuesPlaceholders(colsPerRow, 1)}`;
    let batchStmt = null;
    let singleStmt = null;
    const cap = colsPerRow * safeRows;
    const buf = new Array(cap);
    let idx = 0;
    const flush = () => {
        if (idx === 0)
            return;
        if (idx === cap) {
            batchStmt ??= prepareStmt(store, batchSql);
            batchStmt.run(...buf);
        }
        else {
            singleStmt ??= prepareStmt(store, singleSql);
            for (let off = 0; off < idx; off += colsPerRow) {
                singleStmt.run(...buf.slice(off, off + colsPerRow));
            }
        }
        idx = 0;
    };
    const push = (...vals) => {
        for (let i = 0; i < colsPerRow; i++)
            buf[idx++] = vals[i];
        if (idx >= cap) {
            batchStmt ??= prepareStmt(store, batchSql);
            batchStmt.run(...buf);
            idx = 0;
        }
    };
    return { push, flush };
}

/**
 * Execute `fn(store)` inside a single write transaction (`BEGIN IMMEDIATE ... COMMIT`).
 * Supports safe nesting via SQLite savepoints when already inside an outer transaction.
 */
export function withSqliteTransaction(store, fn) {
    if (store.txDepth === 0) {
        store.db.exec("BEGIN IMMEDIATE");
        store.txDepth = 1;
        try {
            const result = fn(store);
            store.db.exec("COMMIT");
            return result;
        }
        catch (err) {
            try {
                store.db.exec("ROLLBACK");
            }
            catch {
                /* ignore rollback errors if SQLite already auto-rolled back */
            }
            throw err;
        }
        finally {
            store.txDepth = 0;
        }
    }

    const depth = ++store.txDepth;
    const sp = `sp_${depth}`;
    store.db.exec(`SAVEPOINT ${sp}`);
    try {
        const result = fn(store);
        store.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
    }
    catch (err) {
        try {
            store.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`);
        }
        catch {
            /* ignore savepoint rollback error */
        }
        throw err;
    }
    finally {
        store.txDepth = depth - 1;
    }
}

/** Checkpoint WAL frames back into the main database file cleanly. */
export function checkpointSqliteStore(outDir, mode = "TRUNCATE") {
    const store = openStores.get(resolve(outDir));
    if (!store || store.readOnly)
        return false;
    const safeMode = mode === "PASSIVE" || mode === "FULL" || mode === "RESTART" ? mode : "TRUNCATE";
    try {
        store.db.exec(`PRAGMA wal_checkpoint(${safeMode});`);
        return true;
    }
    catch {
        return false;
    }
}

/** Return a copy of `node` without `body_text` so SQLite AST blobs never hit V8 JSON limits. */
export function stripNodeBodyText(node) {
    if (!node || typeof node !== "object" || !("body_text" in node))
        return node;
    const { body_text: _ignored, ...rest } = node;
    return rest;
}

/** Read one string key from the `meta` table. */
export function getSqliteMeta(store, key) {
    const row = prepareStmt(store, "SELECT value FROM meta WHERE key = ?").get(String(key));
    return row ? row.value : null;
}

/** Read all key/value pairs from the `meta` table as a null-safe plain object. */
export function getAllSqliteMeta(store) {
    const rows = prepareStmt(store, "SELECT key, value FROM meta").all();
    const out = {};
    for (const r of rows) {
        out[r.key] = r.value;
    }
    return out;
}

/** Upsert one key/value pair into the `meta` table. */
export function setSqliteMeta(store, key, value) {
    prepareStmt(store, "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
        String(key),
        String(value)
    );
}

/** Upsert multiple `[key, value]` or `{ key: value }` pairs inside `meta`. */
export function setSqliteMetaMany(store, entries) {
    const stmt = prepareStmt(store, "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
    for (const [k, v] of pairs) {
        if (v === undefined || v === null)
            continue;
        stmt.run(String(k), typeof v === "string" ? v : JSON.stringify(v));
    }
}

const NODE_BASE_KEYS = new Set([
    "id",
    "path",
    "kind",
    "name",
    "span",
    "signature",
    "exported",
    "origin",
    "owner",
    "body_hash",
    "chars",
    "summary",
    "body_text",
]);

function encodeNodeExtraJson(node) {
    let extra = null;
    for (const k of Object.keys(node)) {
        if (NODE_BASE_KEYS.has(k) || node[k] === undefined)
            continue;
        extra ??= {};
        extra[k] = node[k];
    }
    return extra ? JSON.stringify(extra) : null;
}

function decodeNodeRow(id, path, kind, name, span, signature, exported, origin, owner, body_hash, chars, summary, extra_json) {
    const node = {
        id,
        path,
        kind,
        name,
        span,
        ...(signature != null ? { signature } : {}),
        exported: Boolean(exported),
        ...(origin != null ? { origin } : {}),
        ...(owner != null ? { owner } : {}),
        ...(body_hash != null ? { body_hash } : {}),
        ...(chars != null ? { chars: Number(chars) } : {}),
        ...(summary != null ? { summary } : {}),
    };
    if (extra_json) {
        try {
            const extra = JSON.parse(extra_json);
            if (extra && typeof extra === "object")
                Object.assign(node, extra);
        }
        catch {
            /* ignore malformed extra_json */
        }
    }
    return node;
}

function encodeEdgeMetaJson(edge) {
    let extra = null;
    for (const k of Object.keys(edge)) {
        if (k === "source" || k === "relation" || k === "target" || edge[k] === undefined)
            continue;
        extra ??= {};
        extra[k] = edge[k];
    }
    return extra ? JSON.stringify(extra) : null;
}

function decodeEdgeRow(source, relation, target, meta_json) {
    const edge = { source, target, relation };
    if (meta_json) {
        try {
            const meta = JSON.parse(meta_json);
            if (meta && typeof meta === "object")
                Object.assign(edge, meta);
        }
        catch {
            /* ignore malformed meta_json */
        }
    }
    return edge;
}

function insertGraphNodeRow(stmt, n) {
    stmt.run(
        n.id,
        n.path ?? "",
        n.kind ?? "symbol",
        n.name ?? "",
        n.span ?? "",
        n.signature ?? null,
        n.exported ? 1 : 0,
        n.origin ?? null,
        n.owner ?? null,
        n.body_hash ?? null,
        n.chars ?? null,
        n.summary ?? null,
        encodeNodeExtraJson(n)
    );
}

function insertGraphEdgeRow(stmt, e, pathById) {
    const srcPath = pathById.get(e.source) ?? "";
    const tgtPath = pathById.get(e.target) ?? null;
    stmt.run(e.source, srcPath, e.relation, e.target, tgtPath, encodeEdgeMetaJson(e));
}

function readSchemaVersionSafe(store) {
    try {
        return getSqliteMeta(store, "schema_version");
    }
    catch {
        return null;
    }
}

/** True when `<outDir>/.cache/index.sqlite` holds a schema v3 canonical graph. */
export function sqliteHasGraph(outDir) {
    if (!sqliteStoreExists(outDir))
        return false;
    try {
        const store = openSqliteStore(outDir, { create: false, readOnly: true });
        if (!store)
            return false;
        if (readSchemaVersionSafe(store) !== String(SQLITE_SCHEMA_VERSION))
            return false;
        return Boolean(getSqliteMeta(store, "graph_meta_json"));
    }
    catch {
        return false;
    }
}

/** True when SQLite v3 graph metadata exists and `wiring_dirty === '1'`. */
export function isSqliteWiringDirty(outDir) {
    if (!sqliteStoreExists(outDir))
        return false;
    try {
        const store = openSqliteStore(outDir, { create: false, readOnly: true });
        if (!store || readSchemaVersionSafe(store) !== String(SQLITE_SCHEMA_VERSION))
            return false;
        return getSqliteMeta(store, "wiring_dirty") === "1" && Boolean(getSqliteMeta(store, "graph_meta_json"));
    }
    catch {
        return false;
    }
}

/** Read parsed `graph.meta` JSON from an open schema v3 SQLite store, or `null`. */
export function readGraphMetaFromSqlite(store) {
    if (!store || readSchemaVersionSafe(store) !== String(SQLITE_SCHEMA_VERSION))
        return null;
    const raw = getSqliteMeta(store, "graph_meta_json");
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}

const SELECT_GRAPH_NODES_SQL =
    "SELECT id, path, kind, name, span, signature, exported, origin, owner, body_hash, chars, summary, extra_json FROM graph_nodes ORDER BY id";
const SELECT_GRAPH_EDGES_SQL =
    "SELECT source, relation, target, meta_json FROM graph_edges ORDER BY source, relation, target";

/** Read all canonical `GraphV1` node records from an open schema v3 SQLite store. */
export function readGraphNodesFromSqlite(store) {
    const arrStmt = prepareArrayStmt(store, SELECT_GRAPH_NODES_SQL);
    if (arrStmt) {
        const rows = arrStmt.all();
        const nodes = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            nodes[i] = decodeNodeRow(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]);
        }
        return nodes;
    }
    const rows = prepareStmt(store, SELECT_GRAPH_NODES_SQL).all();
    return rows.map((r) =>
        decodeNodeRow(r.id, r.path, r.kind, r.name, r.span, r.signature, r.exported, r.origin, r.owner, r.body_hash, r.chars, r.summary, r.extra_json)
    );
}

/** Read all canonical `GraphV1` edge records from an open schema v3 SQLite store. */
export function readGraphEdgesFromSqlite(store) {
    const arrStmt = prepareArrayStmt(store, SELECT_GRAPH_EDGES_SQL);
    if (arrStmt) {
        const rows = arrStmt.all();
        const edges = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            edges[i] = decodeEdgeRow(r[0], r[1], r[2], r[3]);
        }
        return edges;
    }
    const rows = prepareStmt(store, SELECT_GRAPH_EDGES_SQL).all();
    return rows.map((r) => decodeEdgeRow(r.source, r.relation, r.target, r.meta_json));
}

/** Aggregate node/edge counts by kind/relation directly inside SQLite without loading all edges. */
export function readGraphCountsFromSqlite(store) {
    const kindRows = prepareStmt(store, "SELECT kind, COUNT(*) AS cnt FROM graph_nodes GROUP BY kind").all();
    const byKind = {};
    let nodeCount = 0;
    for (const r of kindRows) {
        const cnt = Number(r.cnt ?? 0);
        byKind[r.kind] = cnt;
        nodeCount += cnt;
    }
    const relRows = prepareStmt(store, "SELECT relation, COUNT(*) AS cnt FROM graph_edges GROUP BY relation").all();
    const byRelation = {};
    let edgeCount = 0;
    for (const r of relRows) {
        const cnt = Number(r.cnt ?? 0);
        byRelation[r.relation] = cnt;
        edgeCount += cnt;
    }
    return { nodeCount, edgeCount, byKind, byRelation };
}

/**
 * Read canonical `GraphV1` + numeric `graph_version` from `<outDir>/.cache/index.sqlite`.
 * Returns `null` when schema v3 graph tables are unpopulated, or `{ unchangedVersion: true, version }`
 * when `opts.ifVersionNot` matches the current `graph_version`.
 */
export function readGraphFromSqlite(outDir, opts = {}) {
    if (!sqliteStoreExists(outDir))
        return null;
    try {
        const store = opts.store ?? openSqliteStore(outDir, { create: false, readOnly: true });
        if (!store || readSchemaVersionSafe(store) !== String(SQLITE_SCHEMA_VERSION))
            return null;
        const metaRaw = getSqliteMeta(store, "graph_meta_json");
        if (!metaRaw)
            return null;
        const version = Number(getSqliteMeta(store, "graph_version") ?? 0);
        if (opts.ifVersionNot !== undefined && opts.ifVersionNot !== null && version === opts.ifVersionNot) {
            return { unchangedVersion: true, version };
        }
        const meta = JSON.parse(metaRaw);
        const nodes = opts.nodesLookup?.(version) ?? readGraphNodesFromSqlite(store);
        const edges = readGraphEdgesFromSqlite(store);
        return { graph: { meta, nodes, edges }, version };
    }
    catch {
        return null;
    }
}

function inferPathFromNodeId(id) {
    if (!id)
        return null;
    const hashIdx = id.indexOf("#");
    return hashIdx > 0 ? id.slice(0, hashIdx) : id;
}

/** Write full canonical `graph_nodes`, `graph_edges`, and `graph_meta_json` inside an active tx. */
export function writeGraphToSqlite(store, graph) {
    store.db.exec(`
        DROP INDEX IF EXISTS idx_graph_edges_source_path;
        DROP INDEX IF EXISTS idx_graph_edges_target;
        DROP INDEX IF EXISTS idx_graph_nodes_path;
        DELETE FROM graph_edges;
        DELETE FROM graph_nodes;
    `);
    const nodeBatch = createBatchInserter(
        store,
        "INSERT INTO graph_nodes(id, path, kind, name, span, signature, exported, origin, owner, body_hash, chars, summary, extra_json)",
        13,
        32
    );
    const pathById = new Map();
    for (const n of graph.nodes) {
        const p = n.path ?? "";
        pathById.set(n.id, p);
        nodeBatch.push(
            n.id,
            p,
            n.kind ?? "symbol",
            n.name ?? "",
            n.span ?? "",
            n.signature ?? null,
            n.exported ? 1 : 0,
            n.origin ?? null,
            n.owner ?? null,
            n.body_hash ?? null,
            n.chars ?? null,
            n.summary ?? null,
            encodeNodeExtraJson(n)
        );
    }
    nodeBatch.flush();
    const edgeBatch = createBatchInserter(
        store,
        "INSERT INTO graph_edges(source, source_path, relation, target, target_path, meta_json)",
        6,
        64
    );
    for (const e of graph.edges) {
        const srcPath = pathById.get(e.source) ?? "";
        const tgtPath = pathById.get(e.target) ?? null;
        edgeBatch.push(e.source, srcPath, e.relation, e.target, tgtPath, encodeEdgeMetaJson(e));
    }
    edgeBatch.flush();
    store.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_source_path ON graph_edges(source_path);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target);
    `);
    const nextVersion = Number(getSqliteMeta(store, "graph_version") ?? 0) + 1;
    setSqliteMetaMany(store, {
        graph_meta_json: JSON.stringify(graph.meta),
        graph_version: String(nextVersion),
    });
    return nextVersion;
}

/** Incrementally update ONLY cone/dirty/deleted rows in SQLite `graph_nodes` and `graph_edges`. */
export function updateGraphConeInSqlite(store, { meta, allNodes, dirtyNodes, nodePathById, dirtyPaths, deletedPaths, conePaths, newConeEdges, removedNodeIds, trackEdgeDelta }) {
    const nodeStmtDelete = prepareStmt(store, "DELETE FROM graph_nodes WHERE path = ?");
    for (const p of dirtyPaths)
        nodeStmtDelete.run(p);
    for (const p of deletedPaths)
        nodeStmtDelete.run(p);

    const insNode = prepareStmt(
        store,
        "INSERT INTO graph_nodes(id, path, kind, name, span, signature, exported, origin, owner, body_hash, chars, summary, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    if (Array.isArray(dirtyNodes)) {
        for (const n of dirtyNodes) {
            if (dirtyPaths.has(n.path))
                insertGraphNodeRow(insNode, n);
        }
    }
    else {
        for (const n of allNodes) {
            if (dirtyPaths.has(n.path))
                insertGraphNodeRow(insNode, n);
        }
    }

    const edgeDelBySrc = prepareStmt(store, "DELETE FROM graph_edges WHERE source_path = ?");
    let deletedEdgeCount = 0;
    for (const p of conePaths)
        deletedEdgeCount += Number(edgeDelBySrc.run(p)?.changes ?? 0);
    for (const p of deletedPaths) {
        if (!conePaths.has(p))
            deletedEdgeCount += Number(edgeDelBySrc.run(p)?.changes ?? 0);
    }
    if (removedNodeIds && removedNodeIds.size > 0) {
        const edgeDelByTgt = prepareStmt(store, "DELETE FROM graph_edges WHERE target = ?");
        for (const id of removedNodeIds)
            deletedEdgeCount += Number(edgeDelByTgt.run(id)?.changes ?? 0);
    }

    let localPathById = nodePathById ?? null;
    if (!localPathById && Array.isArray(allNodes) && allNodes.length > 0 && newConeEdges.length > 64) {
        localPathById = new Map();
        for (const n of allNodes)
            localPathById.set(n.id, n.path ?? "");
    }

    const insEdge = prepareStmt(
        store,
        "INSERT OR REPLACE INTO graph_edges(source, source_path, relation, target, target_path, meta_json) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const e of newConeEdges) {
        const srcPath = localPathById?.get(e.source) ?? inferPathFromNodeId(e.source) ?? "";
        const tgtPath = localPathById ? (localPathById.get(e.target) ?? null) : null;
        insEdge.run(e.source, srcPath, e.relation, e.target, tgtPath, encodeEdgeMetaJson(e));
    }

    const nextMeta = trackEdgeDelta
        ? { ...meta, edgeCount: Math.max(0, Number(meta?.edgeCount ?? 0) - deletedEdgeCount + newConeEdges.length) }
        : meta;
    if (trackEdgeDelta && meta)
        meta.edgeCount = nextMeta.edgeCount;
    const nextVersion = Number(getSqliteMeta(store, "graph_version") ?? 0) + 1;
    setSqliteMetaMany(store, {
        graph_meta_json: JSON.stringify(nextMeta),
        graph_version: String(nextVersion),
    });
    return nextVersion;
}

/** Flush `.graph/wiring.json` from canonical SQLite v3 graph when `wiring_dirty === '1'`. */
export function flushWiringJsonIfDirty(outDir) {
    if (!sqliteStoreExists(outDir))
        return false;
    const store = openSqliteStore(outDir, { create: false, readOnly: false });
    if (!store || store.readOnly || readSchemaVersionSafe(store) !== String(SQLITE_SCHEMA_VERSION))
        return false;
    if (getSqliteMeta(store, "wiring_dirty") !== "1")
        return false;
    const loaded = readGraphFromSqlite(outDir, { store });
    if (!loaded?.graph)
        return false;
    const { json, graphHash } = serializeGraph(loaded.graph, { alreadySorted: true });
    writeSerializedGraph(json, outDir);
    withSqliteTransaction(store, () => {
        setSqliteMetaMany(store, {
            wiring_dirty: "0",
            graph_hash: graphHash,
        });
    });
    checkpointSqliteStore(outDir, "PASSIVE");
    return true;
}

registerGraphCacheClearer((outDir, opts) => {
    if (!opts?.keepSqlite)
        closeSqliteStores(outDir);
});
