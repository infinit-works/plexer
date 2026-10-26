import { WALK_RELATIONS, resolveSymbol, stripNodeOrdinals, stripOrdinals } from "../util/id.js";
import { pushMap } from "../util/paths.js";

export { resolveSymbol, stripNodeOrdinals, stripOrdinals };

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

/** Depth-1: walk-relation edges incoming (`in`) or outgoing (`out`) from `symbol`. */
function directWalk(graph, symbol, direction) {
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const adj = walkAdjacency(graph, direction);
    const hits = [];
    for (const { other, relation } of adj.get(symbol.id) ?? []) {
        hits.push({ node: byId.get(other) ?? null, id: other, via: symbol, relation, depth: 1 });
    }
    return hits;
}

export const MAX_CLOSURE_NODES = 100;

export function impactOfMany(graph, seeds, maxDepth = 2, direction = "in") {
    if (seeds.length === 0)
        return [];
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const adj = walkAdjacency(graph, direction);
    const visited = new Set(seeds.map((s) => s.id));
    const hits = [];
    const cap = maxDepth === Number.POSITIVE_INFINITY ? MAX_CLOSURE_NODES : Number.POSITIVE_INFINITY;
    let frontier = [...visited];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && hits.length < cap; depth++) {
        const next = [];
        for (const current of frontier) {
            if (hits.length >= cap)
                break;
            const viaNode = byId.get(current) ?? null;
            for (const { other, relation } of adj.get(current) ?? []) {
                if (visited.has(other))
                    continue;
                visited.add(other);
                hits.push({
                    node: byId.get(other) ?? null,
                    id: other,
                    ...(viaNode ? { via: viaNode } : {}),
                    relation,
                    depth,
                });
                next.push(other);
                if (hits.length >= cap)
                    break;
            }
        }
        frontier = next;
    }
    return hits;
}

export function edgeWalk(graph, node, direction, depth) {
    if (depth <= 1 && node.kind !== "file")
        return directWalk(graph, node, direction);
    if (node.kind === "file") {
        const seeds = [node, ...graph.nodes.filter((n) => n.kind !== "file" && n.path === node.path)];
        return impactOfMany(graph, seeds, Math.max(1, depth), direction);
    }
    return impactOfMany(graph, [node], depth, direction);
}
