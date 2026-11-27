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
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { wiringPath } from "../context/node-file.js";
import { contentHash } from "../util/id.js";

let writeSeq = 0;

export function compareUtf16(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeGraph(graph, opts = {}) {
    const alreadySorted = Boolean(opts?.alreadySorted);
    const nodes = (alreadySorted ? graph.nodes : [...graph.nodes].sort((a, b) => compareUtf16(a.id, b.id))).map(stripBodyText);
    const edges = alreadySorted ? graph.edges : [...graph.edges].sort(edgeOrder);
    const json = JSON.stringify({ ...graph, nodes, edges });
    return { json, graphHash: contentHash(json) };
}

/**
 * Stream canonical `{ ...graph, nodes, edges }` directly to `<outDir>/.graph/wiring.json`
 * in small chunks without allocating a monolithic multi-megabyte JSON string in V8 heap,
 * returning the SHA-256 hex digest identical to `serializeGraph(graph, opts).graphHash`.
 */
export function writeGraphStreaming(graph, outDir, opts = {}) {
    const keys = Object.keys(graph);
    if (keys.length !== 3 || keys[0] !== "meta" || keys[1] !== "nodes" || keys[2] !== "edges") {
        const { json, graphHash } = serializeGraph(graph, opts);
        writeSerializedGraph(json, outDir);
        return graphHash;
    }
    const alreadySorted = Boolean(opts?.alreadySorted);
    const nodes = alreadySorted ? graph.nodes : [...graph.nodes].sort((a, b) => compareUtf16(a.id, b.id));
    const edges = alreadySorted ? graph.edges : [...graph.edges].sort(edgeOrder);

    const path = wiringPath(outDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
    const hash = createHash("sha256");
    let fd = null;
    const emit = (chunk) => {
        hash.update(chunk);
        writeSync(fd, chunk);
    };
    const emitArray = (items, mapItem) => {
        emit("[");
        const CHUNK = 256;
        for (let off = 0; off < items.length; off += CHUNK) {
            const end = Math.min(items.length, off + CHUNK);
            const parts = new Array(end - off);
            for (let i = off; i < end; i++) {
                parts[i - off] = JSON.stringify(mapItem ? mapItem(items[i]) : items[i]);
            }
            emit((off === 0 ? "" : ",") + parts.join(","));
        }
        emit("]");
    };
    try {
        fd = openSync(tmp, "w");
        emit(`{"meta":${JSON.stringify(graph.meta)},"nodes":`);
        emitArray(nodes, stripBodyText);
        emit(',"edges":');
        emitArray(edges, null);
        emit("}");
        closeSync(fd);
        fd = null;
        renameSync(tmp, path);
        return hash.digest("hex");
    }
    catch (e) {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* ignore */ }
        }
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw e;
    }
}

export function writeSerializedGraph(json, outDir) {
    const path = wiringPath(outDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++writeSeq}.tmp`;
    try {
        writeFileSync(tmp, json);
        renameSync(tmp, path);
    }
    catch (e) {
        try {
            rmSync(tmp, { force: true });
        }
        catch { /* ignore */ }
        throw e;
    }
    return path;
}

export function writeGraph(graph, outDir, opts = {}) {
    if (typeof opts?.serializedJson === "string") {
        return writeSerializedGraph(opts.serializedJson, outDir);
    }
    const { json } = serializeGraph(graph, opts);
    return writeSerializedGraph(json, outDir);
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
export function edgeOrder(a, b) {
    return (
        compareUtf16(a.source, b.source) ||
        compareUtf16(a.relation, b.relation) ||
        compareUtf16(a.target, b.target)
    );
}
