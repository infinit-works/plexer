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
export const SQLITE_SCHEMA_VERSION = 1;

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
  field_lens_json TEXT NOT NULL,
  pagerank REAL NOT NULL DEFAULT 0
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
        `);
    }
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
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
            DROP TABLE IF EXISTS ask_df;
            DROP TABLE IF EXISTS ask_postings;
            DROP TABLE IF EXISTS ask_docs;
            DROP TABLE IF EXISTS symbol_deps;
            DROP TABLE IF EXISTS files;
            DROP TABLE IF EXISTS meta;
        `);
        db.exec(SCHEMA_DDL);
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
            String(SQLITE_SCHEMA_VERSION)
        );
    }
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
            return existing;
        }
        closeEntry(key, existing, false);
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

/** Cache and return a compiled prepared statement per open store. */
export function prepareStmt(store, sql) {
    let stmt = store.stmts.get(sql);
    if (!stmt) {
        stmt = store.db.prepare(sql);
        store.stmts.set(sql, stmt);
    }
    return stmt;
}

const ARRAY_STMT_PREFIX = "arr:";

/**
 * Cache and return a prepared statement configured with `setReturnArrays(true)` when supported
 * by `node:sqlite`, or `null` on older Node 22.x runtimes without `setReturnArrays`.
 */
export function prepareArrayStmt(store, sql) {
    const cacheKey = ARRAY_STMT_PREFIX + sql;
    const cached = store.stmts.get(cacheKey);
    if (cached !== undefined)
        return cached;
    const raw = store.db.prepare(sql);
    if (typeof raw.setReturnArrays === "function") {
        raw.setReturnArrays(true);
        store.stmts.set(cacheKey, raw);
        return raw;
    }
    store.stmts.set(cacheKey, null);
    return null;
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

registerGraphCacheClearer((outDir) => {
    closeSqliteStores(outDir);
});
