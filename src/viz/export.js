/**
 * `plexer viz --export <dir>`: the interactive canvas viewer as one self-contained HTML file.
 *
 * Inlines CSS, JS, and graph data into a single `index.html` that can be opened
 * directly via `file://`, published to GitHub Pages, or attached to a CI build.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraphCached } from "../context/graph-store.js";
import { buildVizHealthPayload } from "./serve.js";
/**
 * JSON safe to drop inside a `<script>` element.
 */
function inlineJson(value) {
    return JSON.stringify(value ?? null)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}
/** The two tags this exporter rewrites, verbatim from viewer/index.html. */
const LINK_TAG = '<link rel="stylesheet" href="/style.css">';
const SCRIPT_TAG = '<script type="module" src="/app.js"></script>';
export function exportViz(opts) {
    const html = readFileSync(join(opts.viewerDir, "index.html"), "utf8");
    if (!html.includes(LINK_TAG) || !html.includes(SCRIPT_TAG)) {
        throw new Error("viz export: viewer/index.html no longer matches the asset tags this exporter rewrites");
    }
    const css = readFileSync(join(opts.viewerDir, "style.css"), "utf8");
    const js = readFileSync(join(opts.viewerDir, "app.js"), "utf8");
    const tabs = opts.tabs ?? ["context", "code", "outline"];
    const wantContext = Boolean(opts.contextGraph) || tabs.includes("context");
    const context = opts.contextGraph ?? { nodes: [], edges: [], meta: {} };
    const wanted = tabs.includes("code") || tabs.includes("modules") || tabs.includes("symbols") || tabs.includes("outline");
    const code = wanted ? loadGraphCached(opts.contextDir) : null;
    const codeNodes = code?.nodes?.length ?? 0;
    const defaultTab = wantContext && (opts.contextGraph || context.nodes.length > 0 || codeNodes === 0) ? "context" : "code";
    const contextGraph = {
        ...context,
        meta: { ...context.meta, repoName: opts.repoName, subtitle: opts.subtitle, defaultTab, tabs },
    };
    const health = buildVizHealthPayload(opts.contextDir);
    const data = [
        "<script>window.__PLEXER_DATA__ = {",
        `  health: ${inlineJson(health)},`,
        `  contextGraph: ${inlineJson(contextGraph)},`,
        `  codeGraph: ${inlineJson(code)}`,
        "};</script>",
    ].join("\n");
    const safeCss = css.replace(/<\/style/gi, "<\\/style");
    const safeJs = js.replace(/<\/script/gi, "<\\/script");
    const page = html
        .replace(LINK_TAG, () => `<style>\n${safeCss}\n</style>`)
        .replace(SCRIPT_TAG, () => `${data}\n<script type="module">\n${safeJs}\n</script>`);
    mkdirSync(opts.outDir, { recursive: true });
    const file = join(opts.outDir, "index.html");
    writeFileSync(file, page);
    return { file, bytes: Buffer.byteLength(page), contextNodes: contextGraph.nodes.length, codeNodes, defaultTab, tabs };
}
