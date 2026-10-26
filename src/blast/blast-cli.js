/**
 * CLI wiring for `plexer blast` — the command a CI job runs on a pull request.
 *
 * Kept out of bin/plexer.js (argument wiring only) so the diff → seeds → walk → render
 * chain stays unit-testable without shelling out, matching `graph/traverse-cli.js`.
 */
import { basename, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { resolveCliChoice, resolveCliDepth } from "../graph/traverse-cli.js";
import { blastRadiusIn } from "./blast.js";
import { changedFiles, git, refExists } from "./diff.js";
import { markdownReport, mermaidDiagram, textReport } from "./render.js";
const DEFAULT_DEPTH = 2;
const ALLOWED_FORMATS = ["text", "markdown", "mermaid", "json"];
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
    // An unknown base is the most common CI misconfiguration by a distance: an
    // `actions/checkout` without `fetch-depth: 0` leaves the base branch absent, and
    // git's own message ("unknown revision or path not in the working tree") sends
    // people looking for a typo instead of the checkout depth.
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
    const report = blastRadiusIn(graph, contextDir, diff.files, diff.basis, depth);
    if (opts.owners !== false) {
        const { attachOwners, diffAuthors, localIdentity } = await import("./owners.js");
        // Everyone who wrote a commit in this range, plus whatever the caller named.
        // The range is the reliable half: CI knows the author's login but almost never
        // their commit email, and the email is what git history is keyed on.
        //
        // With no --base there is no range — this is the local "what am I about to
        // push" case — so the local git identity stands in for it. Without that, the
        // one person certain to have written the change is the top name in its own
        // list of who to ask about it.
        const authors = opts.base === undefined ? localIdentity(root) : diffAuthors(root, opts.base);
        attachOwners(root, report, { exclude: [...authors, ...(opts.prAuthor ?? [])] });
    }
    if (opts.exportViz)
        await exportRadius(report, contextDir, root, opts.exportViz, opts.title);
    if (format === "json") {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    if (format === "mermaid") {
        const diagram = mermaidDiagram(report);
        // Exit 0 with a comment, not an error: "nothing depends on this diff" is a
        // legitimate answer, and a CI step must not fail on it.
        console.log(diagram ?? "%% no dependents to draw");
        return;
    }
    process.stdout.write(format === "markdown" ? markdownReport(report, { root }) : textReport(report));
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
