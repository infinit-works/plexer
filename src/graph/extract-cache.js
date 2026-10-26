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
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { extractFile, languageLabelOf, languageOf, warmDepthGrammars } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";
/** Bump when the on-disk shape below changes. */
const CACHE_VERSION = 1;
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
    return h.digest("hex").slice(0, 16);
}
export function emptyExtractCache() {
    return { version: CACHE_VERSION, extractor: extractorStamp() ?? "", files: {} };
}
/** The cache for `outDir`, or an empty one when it's absent, unparseable, written by
 * a different cache version, or when this plexer has no identity to key on (then
 * every build is cold, which is slow but never wrong). The stamp is in the filename,
 * so the `extractor` field is a second check rather than the only one. */
export function readExtractCache(outDir) {
    const path = extractCachePath(outDir);
    const stamp = extractorStamp();
    if (path === null || stamp === null)
        return emptyExtractCache();
    const c = readJson(path);
    if (!c || c.version !== CACHE_VERSION || c.extractor !== stamp || typeof c.files !== "object") {
        return emptyExtractCache();
    }
    return { version: c.version, extractor: c.extractor, files: c.files ?? {} };
}
/** Best-effort write — a full graph is already on disk by the time this runs, so an
 * unwritable cache dir must never fail the build (it only costs the next build its
 * reuse). Returns false when nothing was written, including the deliberate case of
 * having no extractor identity: a parse we can't attribute must never be replayed. */
export function writeExtractCache(outDir, cache) {
    const path = extractCachePath(outDir);
    if (path === null)
        return false;
    try {
        writeJsonAtomic(path, cache, true);
        pruneSidecars(join(outDir, CACHE_DIR), EXTRACT_CACHE_PREFIX);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Shared 3-tier classification, cache replay, concurrent WASM warming, and
 * extraction used by `buildGraph` and `checkGraph`.
 */
export async function extractSourceFiles(files, prevCache, opts = {}) {
    const nodes = [];
    const rawEdges = [];
    const langs = new Set();
    const errors = [];
    const entries = {};
    let parsed = 0;
    let reused = 0;
    let mtimeDirty = false;
    const trustStat = (opts.trustStat ?? true) && process.env.PLEXER_REFRESH !== "hash";
    const toParse = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const rel = f.rel;
        opts.onProgress?.({ phase: "parse", index: i, total: files.length, file: rel });
        const lang = languageOf(rel);
        const container = lang ? null : containerLangOf(rel);
        const generic = lang || container ? null : genericLangOf(rel);
        const label = languageLabelOf(rel) ?? container?.name ?? generic?.name ?? "unknown";
        const cached = prevCache.files[rel];
        if (
            trustStat &&
            cached &&
            cached.size === f.size &&
            cached.mtimeMs === f.mtimeMs &&
            Boolean(cached.hash) &&
            !cached.error
        ) {
            entries[rel] = cached;
            reused++;
            nodes.push(...cached.nodes);
            rawEdges.push(...cached.rawEdges);
            langs.add(label);
            continue;
        }
        let source;
        try {
            source = readSourceFile(f.abs);
        }
        catch (err) {
            const message = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(message);
            entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [], error: message };
            mtimeDirty = true;
            continue;
        }
        if (source === null) {
            entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: "", nodes: [], rawEdges: [] };
            mtimeDirty = true;
            continue;
        }
        const hash = contentHash(source);
        if (cached && hash === cached.hash) {
            entries[rel] = { ...cached, size: f.size, mtimeMs: f.mtimeMs };
            mtimeDirty = true;
            reused++;
            if (cached.error) {
                errors.push(cached.error);
                continue;
            }
            nodes.push(...cached.nodes);
            rawEdges.push(...cached.rawEdges);
            langs.add(label);
            continue;
        }
        toParse.push({ f, rel, source, hash, lang, container, generic, label });
    }
    if (toParse.length > 0) {
        await Promise.all([
            warmDepthGrammars(new Set(toParse.map((p) => p.lang).filter(Boolean))),
            warmGenericGrammars(new Set(toParse.map((p) => p.generic?.name).filter(Boolean))),
            warmContainerGrammars(new Set(toParse.map((p) => p.container?.name).filter(Boolean))),
        ]);
        for (const { f, rel, source, hash, lang, container, generic, label } of toParse) {
            parsed++;
            try {
                let extracted = null;
                if (lang)
                    extracted = extractFile(rel, source, lang);
                else if (container)
                    extracted = extractContainer(rel, source, container);
                else if (generic)
                    extracted = extractGeneric(rel, source, generic.name);
                if (!extracted)
                    continue;
                const { nodes: fileNodes, rawEdges: fileEdges } = extracted;
                nodes.push(...fileNodes);
                rawEdges.push(...fileEdges);
                langs.add(label);
                entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: fileNodes, rawEdges: fileEdges };
            }
            catch (err) {
                const message = `${rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`;
                errors.push(message);
                entries[rel] = { size: f.size, mtimeMs: f.mtimeMs, hash, nodes: [], rawEdges: [], error: message };
            }
        }
    }
    return { nodes, rawEdges, langs, errors, entries, parsed, reused, mtimeDirty };
}
