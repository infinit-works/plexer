import { WALK_RELATIONS } from "../util/id.js";
import { pushMap } from "../util/paths.js";
const emptyTopology = () => ({
    ids: new Set(),
    adjacency: new Map(),
});
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
    let cursor = 0;
    for (let i = 0; i < n; i++) {
        const nbrs = topology.adjacency.get(nodeIds[i]);
        if (!nbrs)
            continue;
        for (let j = 0; j < nbrs.length; j++) {
            targets[cursor++] = indexOfId.get(nbrs[j]);
        }
    }
    const csr = {
        nodeIds,
        indexOfId,
        offsets,
        targets,
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
        else
            mutable.set(partition, { ids: new Set([node.id]), adjacency: new Map() });
    }
    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation))
            continue;
        const partition = partitionById.get(edge.source);
        if (partition === undefined || partitionById.get(edge.target) !== partition)
            continue;
        const topology = mutable.get(partition);
        pushMap(topology.adjacency, edge.source, edge.target);
        pushMap(topology.adjacency, edge.target, edge.source);
    }
    return new Map(mutable);
}
/** Prepare one optionally filtered topology. Kept public for callers/tests that
 * reuse the same graph across multiple seed sets. */
export function preparePageRankTopology(graph, nodeFilter) {
    if (!nodeFilter && graph._csrTopology)
        return graph._csrTopology;
    const ids = new Set(graph.nodes.map((node) => node.id).filter((id) => !nodeFilter || nodeFilter(id)));
    if (ids.size === 0)
        return emptyTopology();
    const adjacency = new Map();
    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation))
            continue;
        if (!ids.has(edge.source) || !ids.has(edge.target))
            continue;
        pushMap(adjacency, edge.source, edge.target);
        pushMap(adjacency, edge.target, edge.source);
    }
    const topology = { ids, adjacency };
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
 * weights matter). The graph is treated as UNDIRECTED — for "understand this
 * area" a callee is as relevant as a caller. Returns a score per node
 * normalized so the top node is 1; nodes untouched by the walk are absent.
 *
 * Edges whose endpoints aren't both real nodes (e.g. an unresolved import
 * module string) are ignored, so only genuine symbol-to-symbol wiring counts.
 */
export function personalizedPageRank(graph, seeds, opts = {}) {
    return personalizedPageRankPrepared(preparePageRankTopology(graph, opts.nodeFilter), seeds, opts);
}
/** Run PageRank on an already prepared topology. This is numerically identical
 * to {@link personalizedPageRank}; it only removes repeated topology scans. */
export function personalizedPageRankPrepared(topology, seeds, opts = {}) {
    const alpha = opts.alpha ?? 0.25;
    const iters = opts.iters ?? 25;
    if (topology.ids.size === 0)
        return new Map();
    const csr = attachCsr(topology);
    const { nodeIds, indexOfId, offsets, targets } = csr;
    const n = nodeIds.length;
    const seedIdx = [];
    const seedWeight = [];
    let seedTotal = 0;
    for (const [id, w] of seeds) {
        if (w > 0) {
            const idx = indexOfId.get(id);
            if (idx !== undefined) {
                seedIdx.push(idx);
                seedWeight.push(w);
                seedTotal += w;
            }
        }
    }
    if (seedTotal <= 0)
        return new Map();
    const sLen = seedIdx.length;
    for (let k = 0; k < sLen; k++)
        seedWeight[k] /= seedTotal;
    let rank = csr.rankBuf;
    let next = csr.nextBuf;
    rank.fill(0);
    for (let k = 0; k < sLen; k++)
        rank[seedIdx[k]] = seedWeight[k];
    const oneMinusAlpha = 1 - alpha;
    for (let iter = 0; iter < iters; iter++) {
        next.fill(0);
        for (let k = 0; k < sLen; k++)
            next[seedIdx[k]] = alpha * seedWeight[k];
        let dangling = 0;
        for (let u = 0; u < n; u++) {
            const mass = rank[u];
            if (mass === 0)
                continue;
            const start = offsets[u];
            const end = offsets[u + 1];
            const deg = end - start;
            if (deg === 0) {
                dangling += mass;
                continue;
            }
            const share = (oneMinusAlpha * mass) / deg;
            for (let e = start; e < end; e++)
                next[targets[e]] += share;
        }
        if (dangling > 0) {
            const dm = oneMinusAlpha * dangling;
            for (let k = 0; k < sLen; k++)
                next[seedIdx[k]] += dm * seedWeight[k];
        }
        const tmp = rank;
        rank = next;
        next = tmp;
    }
    let max = 0;
    for (let u = 0; u < n; u++) {
        if (rank[u] > max)
            max = rank[u];
    }
    if (max <= 0)
        return new Map();
    const out = new Map();
    for (let u = 0; u < n; u++) {
        const v = rank[u];
        if (v > 0)
            out.set(nodeIds[u], v / max);
    }
    return out;
}
