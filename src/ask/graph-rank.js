import { WALK_RELATIONS } from "../context/symbol-query.js";
import { pushMap } from "../util/paths.js";

const BASE_RELATION_WEIGHTS = new Map([
    ["calls", 1.0],
    ["reexports", 0.9],
    ["extends", 0.8],
    ["implements", 0.8],
    ["interface_dispatch", 0.65],
    ["references", 0.5],
    ["imports", 0.35],
    ["types", 0.25],
]);
const TYPE_ONLY_SCALE = 0.35;
const REVERSE_EDGE_SCALE = 0.45;

function edgeBaseWeight(edge) {
    let base = BASE_RELATION_WEIGHTS.get(edge.relation);
    if (base === undefined) {
        if (!WALK_RELATIONS.has(edge.relation))
            return 0;
        base = 0.5;
    }
    return edge.typeOnly ? base * TYPE_ONLY_SCALE : base;
}

const emptyTopology = () => ({
    ids: new Set(),
    adjacency: new Map(),
    inDegree: new Map(),
});
function parseLineSpan(span) {
    if (!span)
        return null;
    const m = /^L?(\d+)(?:-L?(\d+))?$/.exec(span);
    if (!m)
        return null;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    return [a, b];
}
function isContainedSymbolEdge(nodeById, srcId, tgtId) {
    const u = nodeById.get(srcId);
    const v = nodeById.get(tgtId);
    if (!u || !v || u.kind === "file" || v.kind === "file" || !u.path || u.path !== v.path)
        return false;
    const su = u._parsedSpan ?? (u._parsedSpan = parseLineSpan(u.span));
    const sv = v._parsedSpan ?? (v._parsedSpan = parseLineSpan(v.span));
    if (!su || !sv)
        return false;
    return (su[0] <= sv[0] && su[1] >= sv[1]) || (sv[0] <= su[0] && sv[1] >= su[1]);
}
function addWeightedWalkEdge(topology, edge, rawWeight) {
    topology.inDegree.set(edge.target, (topology.inDegree.get(edge.target) ?? 0) + 1);
    pushMap(topology.adjacency, edge.source, [edge.target, rawWeight]);
    pushMap(topology.adjacency, edge.target, [edge.source, rawWeight * REVERSE_EDGE_SCALE]);
}
function attachCsr(topology) {
    if (topology._csr)
        return topology._csr;
    const nodeIds = [...topology.ids];
    const n = nodeIds.length;
    const indexOfId = new Map();
    for (let i = 0; i < n; i++)
        indexOfId.set(nodeIds[i], i);
    const offsets = new Int32Array(n + 1);
    let edgeTotal = 0;
    for (let i = 0; i < n; i++) {
        offsets[i] = edgeTotal;
        const nbrs = topology.adjacency.get(nodeIds[i]);
        if (nbrs)
            edgeTotal += nbrs.length;
    }
    offsets[n] = edgeTotal;
    const targets = new Int32Array(edgeTotal);
    const weights = new Float64Array(edgeTotal);
    const outWeightSum = new Float64Array(n);
    const inDegree = topology.inDegree;
    let cursor = 0;
    for (let i = 0; i < n; i++) {
        const nbrs = topology.adjacency.get(nodeIds[i]);
        if (!nbrs)
            continue;
        let sum = 0;
        for (let j = 0; j < nbrs.length; j++) {
            const nbr = nbrs[j];
            const targetId = Array.isArray(nbr) ? nbr[0] : nbr;
            const rawWeight = Array.isArray(nbr) ? nbr[1] : 1;
            const deg = inDegree ? (inDegree.get(targetId) ?? 0) : 0;
            // Inverse-in-degree hub damping curbs utility/logging/type mega-hub dominance.
            const w = rawWeight / Math.sqrt(1 + deg);
            targets[cursor] = indexOfId.get(targetId);
            weights[cursor] = w;
            sum += w;
            cursor++;
        }
        outWeightSum[i] = sum;
    }
    const csr = {
        nodeIds,
        indexOfId,
        offsets,
        targets,
        weights,
        outWeightSum,
        rankBuf: new Float64Array(n),
        nextBuf: new Float64Array(n),
    };
    Object.defineProperty(topology, "_csr", { value: csr, enumerable: false, configurable: true });
    return csr;
}
/** Build independent PageRank topologies in one node pass and one edge pass.
 * Edges crossing partitions are excluded, exactly like applying a nodeFilter
 * for each partition independently. Returning `undefined` omits a node. */
export function preparePageRankPartitions(graph, partitionOfId) {
    const nodeById = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const partitionById = new Map();
    const mutable = new Map();
    for (const node of graph.nodes) {
        const partition = partitionOfId(node.id);
        if (partition === undefined)
            continue;
        partitionById.set(node.id, partition);
        const topology = mutable.get(partition);
        if (topology)
            topology.ids.add(node.id);
        else {
            const empty = emptyTopology();
            empty.ids.add(node.id);
            mutable.set(partition, empty);
        }
    }
    for (const edge of graph.edges) {
        const rawWeight = edgeBaseWeight(edge);
        if (rawWeight <= 0)
            continue;
        const partition = partitionById.get(edge.source);
        if (partition === undefined || partitionById.get(edge.target) !== partition)
            continue;
        if (isContainedSymbolEdge(nodeById, edge.source, edge.target))
            continue;
        addWeightedWalkEdge(mutable.get(partition), edge, rawWeight);
    }
    return new Map(mutable);
}
/** Prepare one optionally filtered topology. Kept public for callers/tests that
 * reuse the same graph across multiple seed sets. */
export function preparePageRankTopology(graph, nodeFilter) {
    if (!nodeFilter && graph._csrTopology)
        return graph._csrTopology;
    const nodeById = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const ids = new Set(graph.nodes.map((node) => node.id).filter((id) => !nodeFilter || nodeFilter(id)));
    if (ids.size === 0)
        return emptyTopology();
    const topology = { ids, adjacency: new Map(), inDegree: new Map() };
    for (const edge of graph.edges) {
        const rawWeight = edgeBaseWeight(edge);
        if (rawWeight <= 0)
            continue;
        if (!ids.has(edge.source) || !ids.has(edge.target))
            continue;
        if (isContainedSymbolEdge(nodeById, edge.source, edge.target))
            continue;
        addWeightedWalkEdge(topology, edge, rawWeight);
    }
    attachCsr(topology);
    if (!nodeFilter) {
        Object.defineProperty(graph, "_csrTopology", {
            value: topology,
            enumerable: false,
            configurable: true,
        });
    }
    return topology;
}
/**
 * Personalized PageRank over the wiring graph.
 *
 * `seeds` maps node id → restart weight (a node's lexical score; only positive
 * weights matter). Transitions are directed and relation-weighted (`calls`,
 * `reexports`, `extends`, `implements`, `interface_dispatch`, `references`,
 * `imports`, `types`, with `typeOnly` scaled down), lightly reverse-weighted
 * (~0.45) for caller context, and damped by inverse sqrt in-degree so utility
 * or logging hubs do not siphon probability away from domain modules.
 * Returns a score per node normalized so the top node is 1; untouched nodes
 * are absent.
 *
 * Edges whose endpoints aren't both real nodes (e.g. an unresolved import
 * module string) are ignored, so only genuine symbol-to-symbol wiring counts.
 */
export function personalizedPageRank(graph, seeds, opts = {}) {
    return personalizedPageRankPrepared(preparePageRankTopology(graph, opts.nodeFilter), seeds, opts);
}
/** Run PageRank on an already prepared topology. This is numerically identical
 * to {@link personalizedPageRank}; it only removes repeated topology scans. */
function preparePprSeedVectors(seeds, indexOfId) {
    const seedIdx = [];
    const seedWeight = [];
    let seedTotal = 0;
    for (const [id, w] of seeds) {
        if (w <= 0)
            continue;
        const idx = indexOfId.get(id);
        if (idx !== undefined) {
            seedIdx.push(idx);
            seedWeight.push(w);
            seedTotal += w;
        }
    }
    if (seedTotal <= 0)
        return null;
    for (let k = 0; k < seedIdx.length; k++)
        seedWeight[k] /= seedTotal;
    return { seedIdx, seedWeight };
}

function stepPprIteration(csr, rank, next, seedIdx, seedWeight, alpha) {
    const { nodeIds, offsets, targets, weights, outWeightSum } = csr;
    const n = nodeIds.length;
    const oneMinusAlpha = 1 - alpha;
    next.fill(0);
    for (let k = 0; k < seedIdx.length; k++)
        next[seedIdx[k]] = alpha * seedWeight[k];
    let dangling = 0;
    for (let u = 0; u < n; u++) {
        const mass = rank[u];
        if (mass === 0)
            continue;
        const start = offsets[u];
        const end = offsets[u + 1];
        const wSum = outWeightSum[u];
        if (start === end || wSum <= 0) {
            dangling += mass;
            continue;
        }
        const factor = (oneMinusAlpha * mass) / wSum;
        for (let e = start; e < end; e++)
            next[targets[e]] += factor * weights[e];
    }
    if (dangling > 0) {
        const dm = oneMinusAlpha * dangling;
        for (let k = 0; k < seedIdx.length; k++)
            next[seedIdx[k]] += dm * seedWeight[k];
    }
    let l1Delta = 0;
    for (let u = 0; u < n; u++)
        l1Delta += Math.abs(next[u] - rank[u]);
    return l1Delta;
}

function normalizePprRankMap(rank, nodeIds) {
    let max = 0;
    for (let u = 0; u < nodeIds.length; u++) {
        if (rank[u] > max)
            max = rank[u];
    }
    if (max <= 0)
        return new Map();
    const out = new Map();
    for (let u = 0; u < nodeIds.length; u++) {
        if (rank[u] > 0)
            out.set(nodeIds[u], rank[u] / max);
    }
    return out;
}

export function personalizedPageRankPrepared(topology, seeds, opts = {}) {
    const alpha = opts.alpha ?? 0.25;
    const iters = opts.iters ?? 25;
    if (topology.ids.size === 0)
        return new Map();
    const csr = attachCsr(topology);
    const prepared = preparePprSeedVectors(seeds, csr.indexOfId);
    if (!prepared)
        return new Map();
    const { seedIdx, seedWeight } = prepared;
    let rank = csr.rankBuf;
    let next = csr.nextBuf;
    rank.fill(0);
    for (let k = 0; k < seedIdx.length; k++)
        rank[seedIdx[k]] = seedWeight[k];
    for (let iter = 0; iter < iters; iter++) {
        const l1Delta = stepPprIteration(csr, rank, next, seedIdx, seedWeight, alpha);
        const tmp = rank;
        rank = next;
        next = tmp;
        if (l1Delta < 1e-6)
            break;
    }
    return normalizePprRankMap(rank, csr.nodeIds);
}
