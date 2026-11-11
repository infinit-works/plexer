import { resolve } from "node:path";
import { loadGraphCached } from "./context/graph-store.js";
import { contextDirFor } from "./context/node-file.js";
import { resolveSymbol } from "./context/symbol-query.js";
import { buildGraph } from "./graph/build.js";
import { listSourceFiles } from "./graph/source-files.js";
import { checkGraph, formatGraphCheckReport } from "./graph/check.js";
import { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans } from "./ask/ask.js";
import { isTestPath } from "./util/paths.js";
import { grepGraph } from "./search/grep.js";
import { formatGrepResult, runGrepCommand } from "./search/grep-cli.js";
import { edgeWalk, parseWalkDepth } from "./graph/traverse.js";
import { runCallersCommand } from "./graph/traverse-cli.js";
import { linkTestsForGraph } from "./graph/test-links.js";
import { buildRepoMap, formatRepoMap } from "./graph/map.js";
import { blastRadius, blastRadiusIn } from "./blast/blast.js";
import { analyzeGitHistory } from "./blast/history.js";
import { textReport, markdownReport, mermaidDiagram } from "./blast/render.js";
import { startVizServer } from "./viz/serve.js";
import { exportViz } from "./viz/export.js";
import { startMcpServer } from "./mcp/server.js";
import { health, healthAsync } from "./health/health.js";
import { formatHealthText, formatHealthMarkdown } from "./health/render.js";

const TEST_LINK_CONFIDENCE = {
    symbol_call: "high",
    module_import: "medium",
    stem_companion: "low",
};

function collectMatchTests(symbol, hits, direction, testLinks) {
    const rawLinks = symbol.kind === "file"
        ? testLinks.testsForFile(symbol.path)
        : testLinks.testsForSymbol(symbol.id, symbol.path, true);
    const seen = new Set();
    const out = [];
    for (const t of rawLinks) {
        seen.add(t.testFile);
        out.push({
            path: t.testFile,
            confidence: TEST_LINK_CONFIDENCE[t.kind] ?? "low",
            reason: t.kind,
        });
    }
    if (direction === "in") {
        for (const h of hits) {
            const p = h.node?.path;
            if (p && isTestPath(p) && !seen.has(p)) {
                seen.add(p);
                out.push({
                    path: p,
                    confidence: h.depth === 1 ? "high" : "medium",
                    reason: h.depth === 1 ? "symbol_call" : "transitive_call",
                });
            }
        }
    }
    return out;
}

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
            graphOnly: opts.graphOnly,
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
        if (Number.isNaN(depth))
            throw new RangeError("depth must be a positive integer or 'all'");
        const matches = resolveSymbol(graph, symbol, opts.in ? { in: opts.in } : {});
        const testLinks = opts.includeTests ? linkTestsForGraph(graph) : null;
        return matches.map((m) => {
            const hits = edgeWalk(graph, m, direction, depth);
            if (!testLinks)
                return { symbol: m, hits };
            return { symbol: m, hits, tests: collectMatchTests(m, hits, direction, testLinks) };
        });
    }
    map(dir, opts = {}) {
        const { root, contextDir, graph } = this.#requireGraph(dir);
        const mapOpts = opts.churn && !opts.gitHistory
            ? { ...opts, gitHistory: analyzeGitHistory(root, contextDir, { since: opts.since }) }
            : opts;
        return buildRepoMap(graph, mapOpts);
    }
    health(dir, opts = {}) {
        return health(dir, { ...opts, contextDir: this.cfg.contextDir });
    }
    healthAsync(dir, opts = {}) {
        return healthAsync(dir, { ...opts, contextDir: this.cfg.contextDir });
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
    health,
    healthAsync,
    formatHealthText,
    formatHealthMarkdown,
};