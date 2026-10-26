/**
 * Serialize a {@link GraphV1} to `<contextDir>/.graph/wiring.json`.
 *
 * The wiring graph lives in a hidden `.graph/` subdir because it is machine-only:
 * the agent never greps or reads it — it reaches the wiring data through the
 * per-file markdown cards (grep) and the `ask` tool (edge traversal). Output is
 * sorted (nodes by id, edges by source/relation/target) and carries no
 * timestamps, so rebuilding an unchanged repo produces a byte-identical file and
 * git diffs stay minimal.
 */
import { GRAPH_DIR, GRAPH_FILE, readGraph, wiringPath } from "../context/node-file.js";
import { writeJsonAtomic } from "../util/state.js";
export { GRAPH_DIR, GRAPH_FILE, readGraph, wiringPath };
export function writeGraph(graph, outDir) {
    const sorted = {
        ...graph,
        nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(stripBodyText),
        edges: [...graph.edges].sort(edgeOrder),
    };
    const path = wiringPath(outDir);
    writeJsonAtomic(path, sorted, true);
    return path;
}
/**
 * Drop `body_text` from the SERIALIZED copy of a node — it is ~65% of
 * wiring.json's bytes on a large graph, and every byte of it is already
 * duplicated in the `ask` sidecar (`.cache/ask-index.json`), tokenized, which
 * is the only place anything reads it from. Callers must pass this the
 * in-memory graph BEFORE this stripped copy is produced (see `build.js`:
 * `writeAskIndex` runs on the original `graph` object, never on a re-read of
 * this slimmed file) — this function never mutates the input node.
 */
function stripBodyText(node) {
    if (node.body_text === undefined)
        return node;
    const { body_text: _body_text, ...rest } = node;
    return rest;
}
function edgeOrder(a, b) {
    return (a.source.localeCompare(b.source) ||
        a.relation.localeCompare(b.relation) ||
        a.target.localeCompare(b.target));
}
