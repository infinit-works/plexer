/**
 * Lightweight extractor identity fingerprint & sidecar pruning helper without
 * pulling AST/WASM/SQLite dependencies into `fingerprint.js`.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { readPackageVersion } from "../util/cli-meta.js";
import { SQLITE_SCHEMA_VERSION } from "../storage/sqlite-store.js";

/** Keep `.cache/` from growing a file per version forever. */
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

let memoizedStamp;

export function extractorStamp() {
    if (memoizedStamp === undefined)
        memoizedStamp = computeStamp();
    return memoizedStamp;
}

function computeStamp() {
    try {
        const self = fileURLToPath(import.meta.url);
        const dir = dirname(self);
        const pkgRoot = join(dir, "..", "..");
        const v = readPackageVersion(import.meta.url) ?? "";
        if (!existsSync(join(pkgRoot, ".git"))) {
            const basis = `${v}\0schema:${SQLITE_SCHEMA_VERSION}`;
            return createHash("sha256").update(basis).digest("hex").slice(0, 16);
        }
        const hashed = stampDir(dir, extname(self), v);
        if (hashed)
            return hashed;
        return v ? `v${v}-s${SQLITE_SCHEMA_VERSION}` : null;
    }
    catch (err) {
        const fallback = null;
        void err;
        return fallback;
    }
}

function updateStatEntry(h, relPath, fullPath) {
    const st = statSync(fullPath);
    h.update(`${relPath}\0${st.size}\0${st.mtimeMs}\n`);
}

function stampDir(dir, ext, version = "") {
    const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
    if (!files.length)
        return null;
    const h = createHash("sha256");
    h.update(`${version}\0schema:${SQLITE_SCHEMA_VERSION}\n`);
    for (const f of files) {
        updateStatEntry(h, f, join(dir, f));
    }
    try {
        const queriesDir = join(dir, "queries");
        const scmFiles = readdirSync(queriesDir).filter((f) => f.endsWith(".scm")).sort();
        for (const qf of scmFiles) {
            updateStatEntry(h, `queries/${qf}`, join(queriesDir, qf));
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
            updateStatEntry(h, `extract/${ef}`, join(extractDir, ef));
        }
    }
    catch {
        /* no extract/ subdir */
    }
    try {
        const grammarsDir = join(dir, "..", "..", "grammars");
        const wasmFiles = readdirSync(grammarsDir).filter((f) => f.endsWith(".wasm")).sort();
        for (const wf of wasmFiles) {
            updateStatEntry(h, `grammars/${wf}`, join(grammarsDir, wf));
        }
    }
    catch {
        /* no grammars/ subdir */
    }
    try {
        const idPath = join(dir, "..", "util", ext && ext !== ".js" ? `id${ext}` : "id.js");
        updateStatEntry(h, "util/id.js", idPath);
    }
    catch {
        /* id.js missing in bundled build */
    }
    return h.digest("hex").slice(0, 16);
}
