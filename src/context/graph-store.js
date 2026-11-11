/**
 * In-memory mtime/size-keyed store for `wiring.json` with prebuilt adjacency and path indices.
 */
import { statSync } from "node:fs";
import { readGraph, wiringPath } from "./node-file.js";

const graphCache = new Map();
const extraCacheClearers = new Set();

export function statOf(path) {
    let st = null;
    try {
        const s = statSync(path);
        st = { mtimeMs: s.mtimeMs, size: s.size };
    }
    catch {
        /* file absent or unreadable */
    }
    return st;
}

export function loadFileCached(cache, path, parse) {
    const st = statOf(path);
    if (!st) {
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

export function registerGraphCacheClearer(fn) {
    extraCacheClearers.add(fn);
}

export function loadGraphCached(outDir) {
    const path = wiringPath(outDir);
    return loadFileCached(graphCache, path, () => {
        const g = readGraph(path);
        if (g && Array.isArray(g.nodes)) {
            const byId = new Map();
            const nodesByPath = new Map();
            for (const n of g.nodes) {
                byId.set(n.id, n);
                if (n.path) {
                    let list = nodesByPath.get(n.path);
                    if (!list) {
                        list = [];
                        nodesByPath.set(n.path, list);
                    }
                    list.push(n);
                }
            }
            const inEdges = new Map();
            const outEdges = new Map();
            for (const e of g.edges ?? []) {
                let inList = inEdges.get(e.target);
                if (!inList) {
                    inList = [];
                    inEdges.set(e.target, inList);
                }
                inList.push(e);
                let outList = outEdges.get(e.source);
                if (!outList) {
                    outList = [];
                    outEdges.set(e.source, outList);
                }
                outList.push(e);
            }
            Object.defineProperties(g, {
                _byId: { value: byId, enumerable: false, configurable: true },
                _nodesByPath: { value: nodesByPath, enumerable: false, configurable: true },
                _inEdges: { value: inEdges, enumerable: false, configurable: true },
                _outEdges: { value: outEdges, enumerable: false, configurable: true },
            });
        }
        return g;
    });
}

export function invalidateGraphCaches(outDir) {
    graphCache.delete(wiringPath(outDir));
    for (const clear of extraCacheClearers) {
        clear(outDir);
    }
}
