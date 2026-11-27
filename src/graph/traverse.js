import { WALK_RELATIONS } from "../context/symbol-query.js";
import { stripNodeOrdinals, stripOrdinals } from "../util/id.js";
import { pushMap } from "../util/paths.js";

export { stripNodeOrdinals, stripOrdinals };

/**
 * Parse a walk depth (`number | "all" | "full" | "max" | undefined`) into a positive
 * integer or `Infinity` (returns `NaN` when invalid).
 */
export function parseWalkDepth(raw, defaultDepth = 1) {
    if (raw === undefined || raw === null)
        return defaultDepth;
    if (raw === Number.POSITIVE_INFINITY)
        return Number.POSITIVE_INFINITY;
    if (typeof raw === "string" && /^(all|full|max)$/i.test(raw.trim()))
        return Number.POSITIVE_INFINITY;
    const d = Number(raw);
    return Number.isFinite(d) && d >= 1 ? Math.floor(d) : Number.NaN;
}

function directWalkEdgesFor(graph, symbolId, direction) {
    const edgeMap = direction === "in" ? graph?._inEdges : graph?._outEdges;
    if (edgeMap)
        return edgeMap.get(symbolId) ?? [];
    const adj = walkAdjacency(graph, direction);
    return adj.get(symbolId) ?? [];
}

function walkAdjacency(graph, direction) {
    const prop = direction === "in" ? "_walkAdjIn" : "_walkAdjOut";
    if (graph[prop])
        return graph[prop];
    const adj = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        const key = direction === "in" ? e.target : e.source;
        const other = direction === "in" ? e.source : e.target;
        pushMap(adj, key, { other, relation: e.relation });
    }
    Object.defineProperty(graph, prop, { value: adj, enumerable: false, configurable: true });
    return adj;
}

const RELATION_PRIORITY = {
    calls: 0,
    interface_dispatch: 1,
    reexports: 2,
    extends: 3,
    implements: 4,
    references: 5,
    imports: 6,
    types: 7,
};

function relationRank(rel) {
    return RELATION_PRIORITY[rel] ?? 8;
}

/** Depth-1: walk-relation edges incoming (`in`) or outgoing (`out`) from `symbol`. */
function directWalk(graph, symbol, direction) {
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const useEdgeMap = Boolean(direction === "in" ? graph?._inEdges : graph?._outEdges);
    const list = directWalkEdgesFor(graph, symbol.id, direction);
    const bestByOther = new Map();
    for (const entry of list) {
        const relation = entry.relation;
        if (useEdgeMap && !WALK_RELATIONS.has(relation))
            continue;
        const other = useEdgeMap ? (direction === "in" ? entry.source : entry.target) : entry.other;
        if (other === symbol.id)
            continue;
        const prev = bestByOther.get(other);
        if (!prev || relationRank(relation) < relationRank(prev.relation)) {
            bestByOther.set(other, { node: byId.get(other) ?? null, id: other, via: symbol, relation, depth: 1 });
        }
    }
    return [...bestByOther.values()];
}

export const MAX_CLOSURE_NODES = 100;

export function impactOfMany(graph, seeds, maxDepth = 2, direction = "in") {
    if (seeds.length === 0)
        return [];
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const edgeMap = direction === "in" ? graph?._inEdges : graph?._outEdges;
    const adj = edgeMap ? null : walkAdjacency(graph, direction);
    const visited = new Set(seeds.map((s) => s.id));
    const hits = [];
    const cap = maxDepth === Number.POSITIVE_INFINITY ? MAX_CLOSURE_NODES : Number.POSITIVE_INFINITY;
    let truncated = false;
    let frontier = [...visited];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
        const next = [];
        const addedAtDepth = new Map();
        for (const current of frontier) {
            const viaNode = byId.get(current) ?? null;
            const list = edgeMap ? (edgeMap.get(current) ?? []) : (adj.get(current) ?? []);
            for (const entry of list) {
                const relation = entry.relation;
                if (edgeMap && !WALK_RELATIONS.has(relation))
                    continue;
                const other = edgeMap ? (direction === "in" ? entry.source : entry.target) : entry.other;
                if (visited.has(other)) {
                    const idx = addedAtDepth.get(other);
                    if (idx !== undefined && relationRank(relation) < relationRank(hits[idx].relation)) {
                        hits[idx].relation = relation;
                        if (viaNode)
                            hits[idx].via = viaNode;
                    }
                    continue;
                }
                if (hits.length >= cap) {
                    truncated = true;
                    break;
                }
                visited.add(other);
                addedAtDepth.set(other, hits.length);
                hits.push({
                    node: byId.get(other) ?? null,
                    id: other,
                    ...(viaNode ? { via: viaNode } : {}),
                    relation,
                    depth,
                });
                next.push(other);
            }
            if (truncated)
                break;
        }
        frontier = next;
    }
    if (truncated)
        Object.defineProperty(hits, "truncated", { value: true, enumerable: false, configurable: true });
    return hits;
}

export function edgeWalk(graph, node, direction, depth) {
    if (depth <= 1 && node.kind !== "file")
        return directWalk(graph, node, direction);
    if (node.kind === "file") {
        const pathNodes = graph._nodesByPath?.get(node.path) ?? graph.nodes.filter((n) => n.path === node.path);
        const seeds = [node, ...pathNodes.filter((n) => n.kind !== "file")];
        return impactOfMany(graph, seeds, Math.max(1, depth), direction);
    }
    return impactOfMany(graph, [node], depth, direction);
}
