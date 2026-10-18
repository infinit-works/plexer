import { resolve } from "node:path";
import { contextDirFor } from "./context/node-file.js";
import { buildGraph } from "./graph/build.js";
import { listSourceFiles } from "./graph/source-files.js";
import { checkGraph, formatGraphCheckReport } from "./graph/check.js";
import { loadGraphCached } from "./graph/load.js";
import { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans } from "./ask/ask.js";
import { grepGraph } from "./search/grep.js";
import { formatGrepResult, runGrepCommand } from "./search/grep-cli.js";
import { resolveSymbol, edgeWalk, parseWalkDepth } from "./graph/traverse.js";
import { runCallersCommand } from "./graph/traverse-cli.js";
import { buildRepoMap, formatRepoMap } from "./graph/map.js";
import { blastRadius, blastRadiusIn } from "./blast/blast.js";
import { textReport, markdownReport, mermaidDiagram } from "./blast/render.js";
import { startVizServer } from "./viz/serve.js";
import { exportViz } from "./viz/export.js";
import { startMcpServer } from "./mcp/server.js";

export class Plexer {
    cfg;
    constructor(config = {}) {
        this.cfg = { contextDir: config.contextDir };
    }
    #requireGraph(dir) {
        const root = resolve(dir);
        const contextDir = contextDirFor(root, this.cfg.contextDir);
        const graph = loadGraphCached(contextDir);
        if (!graph)
            throw new Error(`no graph found at ${contextDir} — run \`plexer build\` first`);
        return { root, contextDir, graph };
    }
    check(dir, opts = {}) {
        return this.checkGraph(dir, opts);
    }
    checkGraph(dir, opts = {}) {
        return checkGraph(dir, { ...opts, contextDir: this.cfg.contextDir });
    }
    graph(dir, opts = {}) {
        return buildGraph(dir, {
            contextDir: this.cfg.contextDir,
            extensions: opts.extensions,
            reuse: opts.reuse,
            onlyDirs: opts.onlyDirs,
            cards: opts.cards,
            onProgress: opts.onProgress,
        });
    }
    ask(dir, query, opts = {}) {
        return ask(dir, query, {
            ...opts,
            contextDir: this.cfg.contextDir,
        });
    }
    skeleton(dir, file, opts = {}) {
        return skeleton(dir, file, { ...opts, contextDir: this.cfg.contextDir });
    }
    read(dir, spans, opts = {}) {
        return readSpans(dir, spans, { ...opts, contextDir: this.cfg.contextDir });
    }
    blast(dir, opts = {}) {
        return blastRadius(dir, { ...opts, contextDir: this.cfg.contextDir });
    }
    grep(dir, pattern, opts = {}) {
        const { root, graph } = this.#requireGraph(dir);
        return grepGraph(graph, root, pattern, opts);
    }
    callers(dir, symbol, opts = {}) {
        const { graph } = this.#requireGraph(dir);
        const direction = opts.direction === "out" ? "out" : "in";
        const depth = parseWalkDepth(opts.depth, 1);
        const matches = resolveSymbol(graph, symbol, opts.in ? { in: opts.in } : {});
        return matches.map((m) => ({ symbol: m, hits: edgeWalk(graph, m, direction, depth) }));
    }
    map(dir, opts = {}) {
        const { graph } = this.#requireGraph(dir);
        return buildRepoMap(graph, opts);
    }
}

export {
    buildGraph,
    listSourceFiles,
    checkGraph,
    formatGraphCheckReport,
    ask,
    formatAsk,
    skeleton,
    formatSkeleton,
    readSpans,
    formatReadSpans,
    grepGraph,
    formatGrepResult,
    runGrepCommand,
    resolveSymbol,
    edgeWalk,
    runCallersCommand,
    buildRepoMap,
    formatRepoMap,
    blastRadius,
    blastRadiusIn,
    textReport,
    markdownReport,
    mermaidDiagram,
    startVizServer,
    exportViz,
    startMcpServer,
};