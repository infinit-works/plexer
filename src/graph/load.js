/**
 * mtime-keyed in-process cache over the two readers `ask()` calls on every
 * query: the wiring graph (`readGraph`) and the ask sidecar (`readAskIndex`).
 * `plexer ask` re-parses these from disk on every invocation; in a long-lived
 * process — the MCP server, or `plexer ask` invoked repeatedly in one process —
 * that means re-parsing the same ~tens-of-MB JSON on every tool call.
 *
 * Keyed by `(path, mtimeMs, size)` from `statSync`, so a rebuild (`plexer
 * build`) is picked up on the very next call with no polling and no TTL: the
 * stat is cheap relative to the parse it guards, and a changed mtime or size
 * invalidates the entry. A missing file returns null and is never cached — the
 * next call re-stats, so a file created after a prior miss is picked up
 * immediately (no negative caching).
 *
 * **Cache invalidation assumption:** This strategy assumes filesystem mtime
 * resolution is finer than build cadence. This is safe because `plexer build`
 * rewrites the entire output file atomically, so same-size rewrites within a
 * single mtime tick (which would serve stale data) are infeasible in practice.
 * On APFS (macOS) mtime is nanosecond-granular and a build takes milliseconds,
 * so invalidation is immediate and reliable.
 *
 * Dependency-free by design: this module imports only `node:fs`, `./write.js`,
 * and `../ask/index-file.js`, so it can be imported from both `ask.js` and
 * `mcp/tools.js` without creating an import cycle.
 */
import { statSync } from "node:fs";
import { readGraph, wiringPath } from "./write.js";
import { readAskIndex, askIndexPath, bagLen, stemCounts } from "../ask/index-file.js";
const graphCache = new Map();
const askIndexCache = new Map();
function statOf(path) {
    try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs, size: s.size };
    }
    catch {
        return null;
    }
}
function loadCached(cache, path, parse) {
    const st = statOf(path);
    if (!st) {
        // Missing file: don't negatively cache, and drop any stale entry so a
        // subsequently-created file at the same path is re-parsed, not served
        // from a cache keyed to the old (mtime, size).
        cache.delete(path);
        return null;
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.value;
    }
    const value = parse();
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
}
function hydrateAskIndex(raw) {
    if (!raw)
        return null;
    const dfMap = new Map(raw.df);
    const stemDfMap = new Map();
    const byId = new Map();
    for (const d of raw.docs) {
        const name = new Map(d.name);
        const path = new Map(d.path);
        const body = new Map(d.body);
        const nameStems = stemCounts(name);
        const pathStems = stemCounts(path);
        const bodyStems = stemCounts(body);
        const docStems = new Set([...nameStems.keys(), ...pathStems.keys(), ...bodyStems.keys()]);
        for (const st of docStems) {
            stemDfMap.set(st, (stemDfMap.get(st) ?? 0) + 1);
        }
        byId.set(d.id, {
            id: d.id,
            name,
            path,
            body,
            nameStems,
            pathStems,
            bodyStems,
            bodyLen: bagLen(d.body),
        });
    }
    Object.defineProperty(raw, "_hydrated", {
        value: { dfMap, stemDfMap, byId },
        enumerable: false,
        configurable: true,
    });
    return raw;
}
/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's `(mtimeMs, size)` changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export function loadGraphCached(outDir) {
    const path = wiringPath(outDir);
    return loadCached(graphCache, path, () => {
        const g = readGraph(path);
        if (g && Array.isArray(g.nodes)) {
            Object.defineProperty(g, "_byId", {
                value: new Map(g.nodes.map((n) => [n.id, n])),
                enumerable: false,
                configurable: true,
            });
        }
        return g;
    });
}
/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export function loadAskIndexCached(outDir) {
    const path = askIndexPath(outDir);
    return loadCached(askIndexCache, path, () => hydrateAskIndex(readAskIndex(outDir)));
}
/**
 * Drop the cached graph + sidecar for `outDir`, forcing the next load to re-read.
 *
 * The `(mtimeMs, size)` key above is a good invalidator for a build that happened
 * in *another* process, but not for one this process just performed: the
 * pre-query auto-refresh (`refresh.js`) rewrites the graph and then immediately
 * queries it, and on a filesystem with coarse mtime resolution a same-tick rewrite
 * of the same size would be served from the stale entry. Callers that rebuild must
 * therefore invalidate explicitly rather than trust the clock.
 */
export function invalidateGraphCaches(outDir) {
    graphCache.delete(wiringPath(outDir));
    askIndexCache.delete(askIndexPath(outDir));
}
