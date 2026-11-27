/**
 * CLI wiring for `plexer blast` — the command a CI job runs on a pull request.
 *
 * Kept out of bin/plexer.js (argument wiring only) so the diff → seeds → walk → render
 * chain stays unit-testable without shelling out, matching `graph/traverse-cli.js`.
 */
import { basename, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../context/graph-store.js";
import { containerLangOf, warmContainerGrammars } from "../graph/container.js";
import { languageLabelOf, warmDepthGrammars } from "../graph/extract.js";
import { genericLangOf, warmGenericGrammars } from "../graph/generic.js";
import { resolveCliChoice, resolveCliDepth } from "../graph/traverse-cli.js";
import { blastRadiusIn, importSpecMatchesPath } from "./blast.js";
import { changedFiles, git, refExists } from "./diff.js";
import { markdownReport, mermaidDiagram, textReport } from "./render.js";
const DEFAULT_DEPTH = 2;
const ALLOWED_FORMATS = ["text", "markdown", "mermaid", "json"];
function collectWarmBlastLanguageSets(diff, graph) {
    const depthWarm = new Set();
    const genericWarm = new Set();
    const containerWarm = new Set();
    const addWarmLang = (rel) => {
        if (!rel) return;
        const c = containerLangOf(rel);
        const d = languageLabelOf(rel);
        const g = genericLangOf(rel);
        if (c) containerWarm.add(c.name);
        else if (d) depthWarm.add(d);
        else if (g) genericWarm.add(g.name);
    };
    const changedTargets = new Set();
    const deletedOrRenamed = [];
    for (const f of diff.files) {
        if (f.status === "added") continue;
        const rel = f.oldPath ?? f.path;
        addWarmLang(rel);
        changedTargets.add(f.path);
        if (f.oldPath) changedTargets.add(f.oldPath);
        if (f.status === "deleted" || f.status === "renamed") deletedOrRenamed.push(rel);
    }
    const reexportTargets = new Set(changedTargets);
    if (graph._inEdges && deletedOrRenamed.length === 0) {
        const frontier = [...reexportTargets];
        for (let fi = 0; fi < frontier.length; fi++) {
            const target = frontier[fi];
            for (const e of graph._inEdges.get(target) ?? []) {
                if (e.relation !== "imports" && e.relation !== "reexports")
                    continue;
                addWarmLang(e.source);
                if (e.relation === "reexports" && !reexportTargets.has(e.source)) {
                    reexportTargets.add(e.source);
                    frontier.push(e.source);
                }
            }
        }
        return { containerWarm, depthWarm, genericWarm };
    }
    for (const e of graph.edges ?? []) {
        if (e.relation !== "imports" && e.relation !== "reexports") continue;
        if (!reexportTargets.has(e.target) && !deletedOrRenamed.some((p) => importSpecMatchesPath(e.source, e.target, p))) continue;
        addWarmLang(e.source);
        if (e.relation === "reexports") reexportTargets.add(e.source);
    }
    for (const e of graph.edges ?? []) {
        if ((e.relation === "imports" || e.relation === "reexports") && reexportTargets.has(e.target)) addWarmLang(e.source);
    }
    return { containerWarm, depthWarm, genericWarm };
}

async function warmBlastGrammars(diff, graph) {
    const { containerWarm, depthWarm, genericWarm } = collectWarmBlastLanguageSets(diff, graph);
    if (containerWarm.size > 0) await warmContainerGrammars([...containerWarm]);
    if (depthWarm.size > 0) await warmDepthGrammars([...depthWarm]);
    if (genericWarm.size > 0) await warmGenericGrammars([...genericWarm]);
}

function writeBlastOutput(format, report, root) {
    if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    if (format === "mermaid") {
        // Exit 0 with a comment when nothing depends on the diff.
        console.log(mermaidDiagram(report) ?? "%% no dependents to draw");
        return;
    }
    process.stdout.write(format === "markdown" ? markdownReport(report, { root }) : textReport(report));
}

export async function runBlastCommand(dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const format = resolveCliChoice(opts.format, "--format", ALLOWED_FORMATS, "text");
    const depth = resolveCliDepth(opts.depth, DEFAULT_DEPTH);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error(`✗ no graph found at ${contextDir} — run \`plexer build\` first`);
        process.exit(1);
    }
    // Surface fetch-depth: 0 guidance early when CI checkout lacks the base branch.
    if (opts.base !== undefined && !refExists(root, opts.base)) {
        console.error(`✗ base ref "${opts.base}" is not in this checkout.\n` +
            "  In CI, fetch enough history for the merge base: actions/checkout with `fetch-depth: 0`.");
        process.exit(1);
    }
    const diff = changedFiles(root, opts.base);
    if (!diff) {
        console.error(`✗ could not read a diff in ${root} — is this a git repository?`);
        process.exit(1);
    }
    await warmBlastGrammars(diff, graph);
    const report = blastRadiusIn(graph, contextDir, diff.files, diff.basis, depth, { rootDir: root, baseRef: diff.baseRef });
    if (opts.owners !== false) {
        const { attachOwners, diffAuthors, localIdentity } = await import("./owners.js");
        const authors = opts.base === undefined ? localIdentity(root) : diffAuthors(root, opts.base);
        attachOwners(root, report, { contextDir, headSha: report._headSha ?? null, exclude: [...authors, ...(opts.prAuthor ?? [])] });
    }
    if (opts.exportViz) await exportRadius(report, contextDir, root, opts.exportViz, opts.title);
    writeBlastOutput(format, report, root);
}
/**
 * What to call the repository in the appbar.
 *
 * `basename(root)` is right for someone running this in their own clone, but CI
 * checks a pull request out into a directory named for the job — ours is literally
 * `pr` — which titled the published page "pr". The origin remote is the repository,
 * so it wins when there is one; a detached tarball checkout still falls back.
 */
export function repoLabel(root) {
    const url = git(root, ["remote", "get-url", "origin"])?.trim();
    if (url) {
        const name = url.replace(/\.git$/, "").split(/[/:]/).pop();
        if (name)
            return name;
    }
    return basename(root);
}
/**
 * Write the interactive page for this radius: the same viewer `plexer viz` serves,
 * with the blast graph as its Context tab.
 *
 * Done here rather than in `viz` because the radius is what a reviewer opened the
 * link for, and only `blast` has it — `viz --export` on its own can offer the deep
 * tier's concept map, which a PR build no longer produces.
 */
async function exportRadius(report, contextDir, root, outDir, subtitle) {
    const { fileURLToPath } = await import("node:url");
    const { exportViz } = await import("../viz/export.js");
    const { blastVizGraph } = await import("./viz.js");
    const out = exportViz({
        contextDir,
        viewerDir: fileURLToPath(new URL("../viewer/", import.meta.url)), // prebuilt, ships in dist
        outDir: resolve(outDir),
        repoName: repoLabel(root),
        subtitle,
        contextGraph: blastVizGraph(report, { root }),
        // Context alone: see VizExportOptions.tabs — the other two tabs are about the
        // repository, and this page is about one pull request.
        tabs: ["context"],
    });
    console.error(`• --export-viz: ${out.file} (${Math.round(out.bytes / 1024)} kB, ${out.contextNodes} areas, ${out.codeNodes} code nodes)`);
}
