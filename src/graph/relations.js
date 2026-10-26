export const WALK_RELATIONS = new Set([
    "calls",
    "references",
    "imports",
    "implements",
    "extends",
]);
export function computeInDegree(graph) {
    if (graph?._inDegree && graph._inDegreeEdgeLen === graph.edges.length)
        return graph._inDegree;
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    if (graph) {
        Object.defineProperty(graph, "_inDegree", { value: deg, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_inDegreeEdgeLen", { value: graph.edges.length, enumerable: false, configurable: true, writable: true });
    }
    return deg;
}

