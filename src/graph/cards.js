/**
 * Per-file markdown wiring cards — the passive surface of the wiring graph.
 *
 * The wiring graph itself lives as machine-only JSON in `plexer/.graph/wiring.json`
 * (nodes + edges). This module projects its nodes into markdown: one small card per
 * source file, mirroring the source tree under `plexer/` (e.g. `plexer/src/ask/ask.md`).
 * Each card lists the file's symbols with their `L<start>-L<end>` spans and a
 * one-line doc summary or signature.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pushMap, relPosix } from "../util/paths.js";
import { CACHE_DIR } from "../context/node-file.js";
import { spanStart } from "../blast/evidence.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { GRAPH_DIR } from "./write.js";
const INDEX_FILE = "INDEX.md";
/** The card path for a source path: mirror the tree, swap the extension for .md. */
function cardPathFor(outDir, sourcePath) {
    const md = sourcePath.replace(/\.[^./]+$/, "") + ".md";
    return join(outDir, md);
}
/** First line of a node's description: doc summary if extracted, else its signature. */
function oneLiner(node) {
    const s = node.summary?.trim();
    if (s)
        return s.split("\n")[0].trim();
    return node.signature?.trim() ?? "";
}
/** Render one file's card. `fileNode` may be absent for parse-only fragments. */
function renderCard(sourcePath, fileNode, symbols) {
    const lines = [`# ${sourcePath}`, ""];
    const fileSummary = fileNode ? oneLiner(fileNode) : "";
    if (fileSummary)
        lines.push(fileSummary, "");
    const sorted = [...symbols].sort((a, b) => spanStart(a.span) - spanStart(b.span) || a.name.localeCompare(b.name));
    for (const n of sorted) {
        const desc = oneLiner(n);
        const tail = desc ? ` — ${desc}` : "";
        lines.push(`- ${n.name} · ${n.kind} · ${n.span}${tail}`);
    }
    if (sorted.length === 0)
        lines.push("_No extracted symbols in this file._");
    return lines.join("\n") + "\n";
}
/** Every existing card file (`.md` inside outDir, excluding INDEX.md). */
function listExistingCards(outDir) {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (dir === outDir && (e.name === CACHE_DIR || e.name === GRAPH_DIR))
                    continue;
                walk(join(dir, e.name));
            }
            else if (e.isFile() && e.name.endsWith(".md")) {
                if (dir === outDir && e.name === INDEX_FILE)
                    continue;
                out.push(join(dir, e.name));
            }
        }
    };
    if (existsSync(outDir))
        walk(outDir);
    return out;
}
/** Remove now-empty directories under outDir (bottom-up), skipping .cache/.graph. */
function pruneEmptyDirs(outDir) {
    const visit = (dir) => {
        let empty = true;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (dir === outDir && (e.name === CACHE_DIR || e.name === GRAPH_DIR)) {
                empty = false;
                continue;
            }
            const child = join(dir, e.name);
            if (e.isDirectory()) {
                if (visit(child))
                    rmSync(child, { recursive: true, force: true });
                else
                    empty = false;
            }
            else {
                empty = false;
            }
        }
        return empty;
    };
    if (existsSync(outDir))
        visit(outDir);
}
/**
 * Write one wiring card per source file into `outDir`, mirroring the source tree,
 * and prune cards whose source no longer exists. Returns what changed.
 */
export function writeCards(graph, outDir) {
    const byPath = new Map();
    for (const n of graph.nodes) {
        pushMap(byPath, n.path, n);
    }
    const written = new Set();
    const files = [];
    for (const [sourcePath, group] of byPath) {
        const fileNode = group.find((n) => n.kind === "file");
        const symbols = group.filter((n) => n.kind !== "file");
        const cardPath = cardPathFor(outDir, sourcePath);
        mkdirSync(dirname(cardPath), { recursive: true });
        writeFileSync(cardPath, renderCard(sourcePath, fileNode, symbols));
        written.add(cardPath);
        files.push({ card: relPosix(outDir, cardPath), path: sourcePath, symbols: symbols.length });
    }
    let pruned = 0;
    for (const existing of listExistingCards(outDir)) {
        if (!written.has(existing)) {
            rmSync(existing);
            pruned++;
        }
    }
    pruneEmptyDirs(outDir);
    files.sort((a, b) => a.card.localeCompare(b.card));
    return { written: written.size, pruned, files };
}
/**
 * Write `plexer/INDEX.md` — the structural repo map (directory clusters, hubs,
 * hotspots) and card summary. Deterministic order; no timestamps.
 */
export function writeIndex(outDir, files, graph) {
    const lines = ["# plexer — repo map", ""];
    if (graph && graph.nodes?.length > 0) {
        const mapText = formatRepoMap(buildRepoMap(graph)).trim();
        if (mapText) {
            lines.push("## Architecture", "", mapText, "");
        }
    }
    if (files.length) {
        const withSymbols = files.filter((f) => f.symbols > 0).length;
        lines.push(`## Files (${files.length} cards, ${withSymbols} with symbols)`, "");
    }
    writeFileSync(join(outDir, INDEX_FILE), lines.join("\n"));
}
