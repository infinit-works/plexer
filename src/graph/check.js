/**
 * `checkGraph` — is the committed `graph.json` still in sync with the code?
 *
 * Deterministic and fast (tree-sitter only, no LLM, no network): it re-runs
 * Tier-1 extraction and diffs the fresh node set against the committed graph by
 * `id` and `body_hash`. Meant for CI — exit non-zero when a PR changed code but
 * didn't rebuild the graph.
 *
 * Drift categories:
 *   added    a definition exists in code but not in graph.json (run `plexer build`)
 *   removed  a node in graph.json no longer exists in code       (run `plexer build`)
 *   changed  a node's body_hash differs from the committed one   (run `plexer build`)
 */
import { resolve } from "node:path";
import { contextDirFor, readGraph, wiringPath } from "../context/node-file.js";
import { listSourceStats } from "./source-files.js";
import { extractSourceFiles, readExtractCache } from "./extract-cache.js";
import { readFingerprint } from "./fingerprint.js";
export async function checkGraph(dir, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const result = {
        ok: false,
        missing: false,
        added: [],
        removed: [],
        changed: [],
        stale: [],
        pending: 0,
        pendingIds: [],
        nodes: 0,
    };
    const committed = readGraph(wiringPath(outDir));
    if (!committed) {
        result.missing = true;
        return result;
    }
    const fpOnlyDirs = readFingerprint(outDir)?.onlyDirs;
    const onlyDirs = fpOnlyDirs && fpOnlyDirs.length > 0 ? new Set(fpOnlyDirs) : undefined;
    const sourceStats = listSourceStats(root, outDir, undefined, onlyDirs, opts.extensions);
    const { nodes: extractedNodes } = await extractSourceFiles(sourceStats, readExtractCache(outDir), {
        trustStat: false,
    });
    const current = new Map(extractedNodes.map((n) => [n.id, n.body_hash]));
    const committedById = new Map(committed.nodes.map((n) => [n.id, n]));
    result.nodes = committedById.size;
    for (const [id, node] of committedById) {
        const now = current.get(id);
        if (now === undefined)
            result.removed.push(id);
        else if (now !== node.body_hash)
            result.changed.push(id);
    }
    for (const id of current.keys()) {
        if (!committedById.has(id))
            result.added.push(id);
    }
    for (const arr of [result.added, result.removed, result.changed]) {
        arr.sort();
    }
    result.ok =
        result.added.length === 0 &&
            result.removed.length === 0 &&
            result.changed.length === 0;
    return result;
}
/** Render a graph-check result as a human-readable report. */
export function formatGraphCheckReport(r) {
    if (r.missing) {
        return "graph check: NO GRAPH\n\nNo plexer/.graph/wiring.json found. Run `plexer build` first.";
    }
    if (r.ok) {
        return `graph check: OK — the wiring graph is in sync with the code (${r.nodes} nodes).`;
    }
    const lines = ["graph check: STALE", ""];
    if (r.changed.length) {
        lines.push(`changed (${r.changed.length}):`);
        for (const id of r.changed)
            lines.push(`  ~ ${id}`);
    }
    if (r.added.length) {
        lines.push(`added (${r.added.length}):`);
        for (const id of r.added)
            lines.push(`  + ${id}`);
    }
    if (r.removed.length) {
        lines.push(`removed (${r.removed.length}):`);
        for (const id of r.removed)
            lines.push(`  - ${id}`);
    }
    lines.push("", "Run `plexer build` to rebuild the structure.");
    return lines.join("\n");
}