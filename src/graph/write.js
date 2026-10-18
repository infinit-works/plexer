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
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export const GRAPH_DIR = ".graph";
export const GRAPH_FILE = "wiring.json";
/** Absolute path to the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export function wiringPath(outDir) {
    return join(outDir, GRAPH_DIR, GRAPH_FILE);
}
/**
 * Read an existing wiring graph for use as the Tier-2 cache. Returns null when the
 * file is absent or unparseable (a fresh build, or a corrupt file we'll replace).
 */
export function readGraph(path) {
    const g = readJson(path);
    return g && g.meta?.version === 1 && Array.isArray(g.nodes) ? g : null;
}
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
