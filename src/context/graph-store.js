/**
 * In-memory mtime/size-keyed store for `wiring.json` with prebuilt adjacency and path indices.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { stripNodeOrdinals } from "../util/id.js";
import {
    readGraphFromSqlite,
    sameWalRevision,
    sqliteWalRevision,
} from "../storage/sqlite-store.js";
import { readGraph, wiringPath } from "./node-file.js";

const MAX_GRAPH_CACHE = 12;
const graphCache = new Map();
var extraCacheClearers;
let externalNodesLookup = null;

export function registerExternalNodesLookup(fn) {
    externalNodesLookup = typeof fn === "function" ? fn : null;
}

export function statOf(path) {
    let st = null;
    try {
        const s = statSync(path);
        st = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
    }
    catch {
        /* file absent or unreadable */
    }
    return st;
}

export function loadFileCached(cache, path, parse, maxEntries = 0) {
    const st = statOf(path);
    if (!st) {
        cache.delete(path);
        return null;
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.dev === st.dev && cached.ino === st.ino) {
        cache.delete(path);
        cache.set(path, cached);
        return cached.value;
    }
    const value = parse();
    if (maxEntries > 0 && !cache.has(path)) {
        while (cache.size >= maxEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined)
                break;
            cache.delete(oldestKey);
        }
    }
    cache.delete(path);
    cache.set(path, { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
}

export function registerGraphCacheClearer(fn) {
    (extraCacheClearers ??= new Set()).add(fn);
}

function pushBucket(map, key, node) {
    if (!key)
        return;
    let list = map.get(key);
    if (!list) {
        list = [];
        map.set(key, list);
    }
    list.push(node);
}

function buildNameIndices(g) {
    const byName = new Map();
    const byBareName = new Map();
    for (const n of g.nodes) {
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
    Object.defineProperties(g, {
        byName: { value: byName, enumerable: false, configurable: true },
        byBareName: { value: byBareName, enumerable: false, configurable: true },
    });
    return { byName, byBareName };
}

function buildEdgeIndices(g) {
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
        _inEdges: { value: inEdges, enumerable: false, configurable: true },
        _outEdges: { value: outEdges, enumerable: false, configurable: true },
    });
    return { inEdges, outEdges };
}

function attachGraphIndices(g) {
    if (!g || !Array.isArray(g.nodes))
        return g;
    if (g._byId && g._nodesByPath)
        return g;
    const byId = new Map();
    const nodesByPath = new Map();
    for (const n of g.nodes) {
        byId.set(n.id, n);
        if (n.path) {
            pushBucket(nodesByPath, n.path, n);
        }
    }
    Object.defineProperties(g, {
        _byId: { value: byId, enumerable: false, configurable: true },
        _nodesByPath: { value: nodesByPath, enumerable: false, configurable: true },
        _inEdges: {
            configurable: true,
            enumerable: false,
            get() {
                return buildEdgeIndices(g).inEdges;
            },
        },
        _outEdges: {
            configurable: true,
            enumerable: false,
            get() {
                return buildEdgeIndices(g).outEdges;
            },
        },
        byName: {
            configurable: true,
            enumerable: false,
            get() {
                return buildNameIndices(g).byName;
            },
        },
        byBareName: {
            configurable: true,
            enumerable: false,
            get() {
                return buildNameIndices(g).byBareName;
            },
        },
    });
    return g;
}

function lruSetGraph(key, entry) {
    if (!graphCache.has(key)) {
        while (graphCache.size >= MAX_GRAPH_CACHE) {
            const oldestKey = graphCache.keys().next().value;
            if (oldestKey === undefined)
                break;
            graphCache.delete(oldestKey);
        }
    }
    graphCache.delete(key);
    graphCache.set(key, entry);
}

function sqliteCacheKey(absDir) {
    return `sqlite:${absDir}`;
}

export function loadGraphCached(outDir) {
    const absDir = resolve(outDir);
    const rev = sqliteWalRevision(absDir);
    if (rev) {
        const sKey = sqliteCacheKey(absDir);
        const cached = graphCache.get(sKey);
        if (cached && sameWalRevision(cached.rev, rev)) {
            graphCache.delete(sKey);
            graphCache.set(sKey, cached);
            return cached.value;
        }
        const loaded = readGraphFromSqlite(absDir, {
            ifVersionNot: cached?.graphVersion,
            nodesLookup: externalNodesLookup ? (ver) => externalNodesLookup(absDir, ver) : undefined,
        });
        if (loaded?.unchangedVersion && cached) {
            cached.rev = rev;
            graphCache.delete(sKey);
            graphCache.set(sKey, cached);
            return cached.value;
        }
        if (loaded?.graph) {
            const g = attachGraphIndices(loaded.graph);
            lruSetGraph(sKey, { rev, graphVersion: loaded.version, value: g });
            return g;
        }
        graphCache.delete(sKey);
    }
    const path = wiringPath(absDir);
    return loadFileCached(graphCache, path, () => attachGraphIndices(readGraph(path)), MAX_GRAPH_CACHE);
}

export function invalidateGraphCaches(outDir, opts = {}) {
    if (outDir !== undefined && outDir !== null) {
        const absDir = resolve(outDir);
        graphCache.delete(wiringPath(absDir));
        graphCache.delete(sqliteCacheKey(absDir));
    }
    else {
        graphCache.clear();
    }
    if (extraCacheClearers) {
        for (const clear of extraCacheClearers) {
            clear(outDir, opts);
        }
    }
}
