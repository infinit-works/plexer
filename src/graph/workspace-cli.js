/**
 * CLI print/exit wrappers + per-child build orchestration for workspace
 * federation. Kept out of both `bin/plexer.js` (so routing there stays a one-liner
 * per command) and `workspace.js` (so the core stays free of process/exit and
 * engine dependencies). The federated command bodies live in `workspace.js`;
 * this file only renders them and wires the child builds through the engine.
 */
import { buildGraph } from "./build.js";
import { contextDirFor, ensureGitignored } from "../context/node-file.js";
import { patchBuildConfig } from "../util/state.js";
import { formatAsk } from "../ask/ask.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
import { federateAsk, federateCallers, federateCheck, federateGrep, federateMap, splitWorkspace, } from "./workspace.js";
export async function runWorkspaceBuild(root, opts) {
    const buildWorkspaceChild = async (childDir, childName) => {
        const childConfigPatch = {};
        if (opts.includeDirs && opts.includeDirs.length > 0) {
            childConfigPatch.includeDirs = opts.includeDirs;
        }
        if (opts.followSubmodules !== undefined) {
            childConfigPatch.followSubmodules = opts.followSubmodules;
        }
        if (opts.followNestedRepos !== undefined) {
            childConfigPatch.followNestedRepos = opts.followNestedRepos;
        }
        if (Object.keys(childConfigPatch).length > 0) {
            patchBuildConfig(childDir, childConfigPatch);
        }
        const g = await buildGraph(childDir, { reuse: opts.reuse, extensions: opts.extensions });
        console.log(`✓ ${childName}/: ${g.nodes} nodes, ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
        for (const e of g.errors)
            console.error(`✗ ${childName}/: ${e}`);
    };
    const { children } = await splitWorkspace(root, opts.override, buildWorkspaceChild, ({ children }) => {
        console.error(`building ${children.length} workspace repos: ${children.join(", ")}`);
    });
    // Each child self-ignored during its own build; the parent's federation
    // index (plexer/workspace.json) is written outside buildGraph, so ignore it here too.
    ensureGitignored(root, contextDirFor(root, opts.override));
    console.log(`✓ workspace: ${children.length} repos federated → plexer/workspace.json`);
    console.log(`  plexer/ is git-ignored — each teammate runs \`plexer build\` to regenerate it locally.`);
}
export function runWorkspaceAsk(root, override, query, opts) {
    let r;
    try {
        r = federateAsk(root, override, query, {
            limit: opts.limit,
            source: opts.source,
            full: opts.full,
            in: opts.in,
            graphRank: opts.graphRank,
        });
    }
    catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
    }
    if (opts.json)
        console.log(JSON.stringify(r, null, 2));
    else
        process.stdout.write(formatAsk(r));
}
export function runWorkspaceGrep(root, override, pattern, opts) {
    let result;
    let coverage;
    try {
        ({ result, coverage } = federateGrep(root, override, pattern, {
            ignoreCase: opts.ignoreCase,
            fixed: opts.fixed,
            context: opts.context,
            source: opts.source,
            in: opts.in,
        }));
    }
    catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (result.totalHits === 0) {
        console.error(coverage ? `${zeroHitNote(result)}\n${coverage}` : zeroHitNote(result));
        return;
    }
    process.stdout.write(formatGrepResult(result));
    if (coverage)
        console.log(coverage);
}
export function runWorkspaceMap(root, override, opts = {}) {
    const res = federateMap(root, override, {
        maxDirs: opts.maxDirs,
        json: opts.json,
        churn: opts.churn,
        since: opts.since,
        analyzeGitHistory: opts.analyzeGitHistory,
    });
    if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
    }
    process.stdout.write(res);
}
export async function runWorkspaceCheck(root, override, opts = {}) {
    const { text, ok, repos, missing } = await federateCheck(root, override, { extensions: opts.extensions });
    if (opts.json) {
        console.log(JSON.stringify({ ok, repos, missing }, null, 2));
    }
    else {
        process.stdout.write(text);
    }
    if (!ok)
        process.exit(1);
}
export function runWorkspaceCallers(root, override, symbol, opts) {
    let text;
    let found;
    let matches;
    let coverage;
    try {
        ({ text, found, matches, coverage } = federateCallers(root, override, symbol, opts));
    }
    catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
    }
    if (!found) {
        console.error(`✗ ${text}`);
        process.exit(1);
    }
    if (opts.json) {
        console.log(JSON.stringify({ query: symbol, matches, ...(coverage ? { note: coverage } : {}) }, null, 2));
        return;
    }
    process.stdout.write(text + "\n");
}
