export const WALK_RELATIONS = new Set([
    "calls",
    "references",
    "imports",
    "implements",
    "extends",
]);
export function computeInDegree(graph) {
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    return deg;
}

