/**
 * In-memory mtime/size-keyed store for `wiring.json` with prebuilt adjacency and path indices.
 */
import { statSync } from "node:fs";
import { stripNodeOrdinals } from "../util/id.js";
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
            const byName = new Map();
            const byBareName = new Map();
            const pushBucket = (map, key, node) => {
                if (!key)
                    return;
                let list = map.get(key);
                if (!list) {
                    list = [];
                    map.set(key, list);
                }
                list.push(node);
            };
            for (const n of g.nodes) {
                byId.set(n.id, n);
                if (n.path) {
                    pushBucket(nodesByPath, n.path, n);
                }
                if (n.kind !== "file" && n.name) {
                    const lowerName = n.name.toLowerCase();
                    pushBucket(byName, lowerName, n);
                    const nameBareIdx = Math.max(lowerName.lastIndexOf("."), lowerName.lastIndexOf(":"), lowerName.lastIndexOf("#"));
                    const nameBare = nameBareIdx >= 0 ? lowerName.slice(nameBareIdx + 1) : lowerName;
                    pushBucket(byBareName, nameBare, n);
                    const strippedId = stripNodeOrdinals(n);
                    const idBareIdx = Math.max(strippedId.lastIndexOf("."), strippedId.lastIndexOf("#"));
                    const idBare = idBareIdx >= 0 ? strippedId.slice(idBareIdx + 1) : "";
                    if (idBare && idBare !== nameBare) {
                        pushBucket(byBareName, idBare, n);
                    }
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
                byName: { value: byName, enumerable: false, configurable: true },
                byBareName: { value: byBareName, enumerable: false, configurable: true },
            });
        }
        return g;
    });
}

export function invalidateGraphCaches(outDir) {
    if (outDir !== undefined && outDir !== null) {
        graphCache.delete(wiringPath(outDir));
    }
    else {
        graphCache.clear();
    }
    for (const clear of extraCacheClearers) {
        clear(outDir);
    }
}
