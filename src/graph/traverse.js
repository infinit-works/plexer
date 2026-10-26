import { matchLuauSymbol } from "./luau.js";
import { WALK_RELATIONS } from "./relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "./scopes.js";
import { normalizePathPrefix, pushMap } from "../util/paths.js";

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

/**
 * Resolve a query string to every matching node in the graph.
 */
export function resolveSymbol(graph, query, opts = {}) {
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const looksLikeFilename = trimmed.includes(".") && !trimmed.includes("#") && !trimmed.includes(":");
    let matches = symbolMatches(graph.nodes, lowerQuery);
    if (matches.length === 0 && trimmed.includes(":") && !trimmed.includes("#")) {
        const colonIdx = lowerQuery.lastIndexOf(":");
        const left = lowerQuery.slice(0, colonIdx).replace(/:$/, "");
        const right = lowerQuery.slice(colonIdx + 1);
        if (left && right) {
            if (left.includes("/") || /\.[a-z0-9]+$/.test(left)) {
                matches = graph.nodes.filter((n) => n.kind !== "file" &&
                    (n.path.toLowerCase() === left || n.path.toLowerCase().endsWith("/" + left)) &&
                    (n.name.toLowerCase() === right || n.id.toLowerCase().endsWith("#" + right) || n.id.toLowerCase().endsWith("." + right)));
            }
            if (matches.length === 0) {
                matches = symbolMatches(graph.nodes, `${left}.${right}`);
            }
        }
    }
    const hasLuau = !graph.meta?.languages || graph.meta.languages.includes("luau");
    if (hasLuau && (matches.length === 0 || lowerQuery.includes(".") || lowerQuery.includes(":"))) {
        const luauMatches = matchLuauSymbol(graph.nodes, lowerQuery, graph.edges);
        if (luauMatches.length > 0 && (matches.length === 0 || luauMatches.some((m) => m.exported)))
            matches = luauMatches;
    }
    if (matches.length === 0 && looksLikeFilename) {
        matches = graph.nodes.filter((n) => n.kind === "file" &&
            (n.name.toLowerCase() === lowerQuery ||
                n.path.toLowerCase() === lowerQuery ||
                n.path.toLowerCase().endsWith("/" + lowerQuery)));
    }
    if (matches.length === 0 && (trimmed.includes(".") || trimmed.includes(":"))) {
        const lastSep = Math.max(trimmed.lastIndexOf("."), trimmed.lastIndexOf(":"));
        const lastSegment = trimmed.slice(lastSep + 1).toLowerCase();
        if (lastSegment) {
            matches = graph.nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === lastSegment);
        }
    }
    if (opts.in) {
        const prefix = normalizePathPrefix(opts.in);
        assertPrefixIndexed(graph, prefix);
        matches = matches.filter((n) => pathUnderPrefix(n.path, prefix));
    }
    if (matches.length > 1) {
        matches = [...matches].sort((a, b) => Number(Boolean(b.exported)) - Number(Boolean(a.exported)));
    }
    return matches;
}

/** Strips mint-time disambiguation ordinals (`~2`, `~3`, ...) from segment ends in a dotted id-tail. */
export function stripOrdinals(idTail) {
    return idTail.replace(/~\d+(?=\.|$)/g, "");
}

/** Lowercase `n.id` with mint-time disambiguation ordinals stripped from the symbol tail. */
export function stripNodeOrdinals(n) {
    if (n._strippedId !== undefined)
        return n._strippedId;
    const lowerId = n.id.toLowerCase();
    const hashIdx = lowerId.indexOf("#");
    const stripped = hashIdx === -1 ? lowerId : lowerId.slice(0, hashIdx + 1) + stripOrdinals(lowerId.slice(hashIdx + 1));
    Object.defineProperty(n, "_strippedId", { value: stripped, enumerable: false, configurable: true, writable: true });
    return stripped;
}

function symbolMatches(nodes, lowerQuery) {
    const suffixHash = "#" + lowerQuery;
    const suffixDot = "." + lowerQuery;
    return nodes.filter((n) => {
        if (n.kind === "file")
            return false;
        const lowerName = n._lowerName ?? (Object.defineProperty(n, "_lowerName", { value: n.name.toLowerCase(), enumerable: false, configurable: true, writable: true }), n._lowerName);
        if (lowerName === lowerQuery)
            return true;
        const candidateId = stripNodeOrdinals(n);
        return candidateId.endsWith(suffixHash) || candidateId.endsWith(suffixDot);
    });
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
