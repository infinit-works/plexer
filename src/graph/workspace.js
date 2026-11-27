/**
 * Workspace federation — a "workspace" is a parent directory that holds two or
 * more immediate git-repo children and has no source graph of its own. Instead
 * of one mega-graph pooling every repo, each child keeps its OWN committable
 * `plexer/` (byte-identical to building that child standalone), and the parent
 * holds a single `plexer/workspace.json` index:
 *
 *   { "version": 1, "children": ["repoA", "repoB"] }
 *
 * Queries run at the parent federate across the children: `ask` fuses every
 * child's ranked hits with `fuseScopes`, reciprocal-rank fusion, so the big
 * repo can't drown the small one. Scopes INSIDE one repo no longer take that
 * path — they share corpus statistics and a normalization denominator, so they
 * are combined by score (see `ask/fuse.js`). Separate child repositories have
 * no such shared scale, which is exactly the case rank fusion is for.
 * `grep`/`map`/`check`/`callers` run per child and merge, always labeled
 * `<child>/`.
 *
 * This module owns the pure/core pieces (the format, its readers/writers, graph
 * loading, and the federated command bodies that return renderable data). The
 * CLI print/exit wrappers and the per-child build orchestration live in
 * `workspace-cli.js`; `mcp/tools.js` calls the federate* functions directly.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { checkGraph } from "./check.js";
import { loadGraphCached } from "../context/graph-store.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { discoverWorkspaceChildren } from "./scope-discovery.js";
import { hitJson, looseNoteFor, renderMatchBlock, symbolJson } from "./traverse-cli.js";
import { resolveSymbol } from "../context/symbol-query.js";
import { edgeWalk } from "./traverse.js";
import { linkTestsForGraph } from "./test-links.js";
import { ask, readSpans, sameHit, skeleton } from "../ask/ask.js";
import { roundRobinQueues } from "../ask/file-selection.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR } from "../ask/fuse.js";
import { grepGraph } from "../search/grep.js";
import { fileReader } from "../util/span.js";
import { normalizePathPrefix } from "../util/paths.js";
import { readBuildConfig, writeBuildConfig, writeJsonAtomic } from "../util/state.js";
import { readWorkspaceMeta, workspacePath } from "./workspace-path.js";

export { workspacePath };

/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export function readWorkspace(root, override) {
    return readWorkspaceMeta(root, override);
}
/** Write the workspace index, sorting children for a stable, minimal git diff. */
export function writeWorkspace(root, ws, override) {
    const path = workspacePath(root, override);
    const sorted = { version: 1, children: [...ws.children].sort() };
    writeJsonAtomic(path, sorted);
    return path;
}
/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it already has a `workspace.json` index. The no-own-`.git`
 * guard keeps a normal repo with git submodules from being mistaken for a workspace. */
export function isWorkspaceBuildRoot(root, override) {
    if (readWorkspace(root, override))
        return true;
    if (existsSync(join(root, ".git")))
        return false;
    return discoverWorkspaceChildren(root).length >= 2;
}
/** Reset the parent's `plexer/` directory so after `writeWorkspace` the parent
 * holds only `workspace.json` (and any persisted `.cache/config.json`). Child
 * graphs live in sibling `<child>/plexer/`, never under this dir. */
export function clearParentPlexer(root, override) {
    const cfg = readBuildConfig(root, override);
    rmSync(contextDirFor(root, override), { recursive: true, force: true });
    if (cfg)
        writeBuildConfig(root, cfg, override);
}
/** Load each child's graph via `loadGraphCached`. Children come from
 * workspace.json when present, otherwise from live git-child discovery (a
 * not-yet-built workspace). A child without a built graph is counted into
 * `missing`, not dropped. */
export function loadWorkspaceGraphs(root, override) {
    const ws = readWorkspace(root, override);
    const children = (ws ? ws.children : discoverWorkspaceChildren(root)).slice().sort();
    const loaded = [];
    const missing = [];
    for (const child of children) {
        const graph = loadGraphCached(contextDirFor(join(root, child)));
        if (graph)
            loaded.push({ child, graph });
        else
            missing.push(child);
    }
    return { loaded, missing };
}
/** "2 of 3 workspace repos have graphs; run plexer build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export function coverageNote(g) {
    if (g.missing.length === 0)
        return "";
    const total = g.loaded.length + g.missing.length;
    return `${g.loaded.length} of ${total} workspace repos have graphs; run plexer build to cover ${g.missing.join(", ")}`;
}
/** Prefix a hit pointer with its child dir so a `path:span` (or concept path
 * list) opens correctly from the parent. Leaves free-text fragments alone. */
function prefixPointer(child, pointer) {
    return pointer
        .split(",")
        .map((part) => {
        const t = part.trim();
        if (!t || t.includes(" "))
            return part;
        return `${child}/${t}`;
    })
        .join(", ");
}
function qualifyWorkspaceHit(child, hit, score = hit.score, scope = hit.scope ? `${child}/${hit.scope}` : child) {
    return {
        ...hit,
        score,
        scope,
        pointer: prefixPointer(child, hit.pointer),
    };
}
function partitionAskRunsByCoverageGate(runs, onlyChild) {
    const gatedOut = [];
    const survivors = [];
    const baselineSurvivors = [];
    for (const run of runs) {
        const baselineEligible = onlyChild ||
            run.baselineCoverageStrong >= STRONG_FLOOR ||
            run.baselineCoverage >= HIGH_FLOOR;
        const fileEligible = onlyChild ||
            run.coverageStrong >= STRONG_FLOOR ||
            run.coverage >= HIGH_FLOOR;
        if (baselineEligible)
            baselineSurvivors.push(run);
        if (baselineEligible || fileEligible) {
            survivors.push(run);
        }
        else {
            const best = run.ranking?.groups[0]?.hits[0] ?? run.hits[0];
            gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, best.pointer) });
        }
    }
    return { gatedOut, survivors, baselineSurvivors };
}

function collectChildAskRuns(root, wg, query, opts, limit, onlyChild, childIn) {
    const runs = [];
    let matchedAnyPrefix = !childIn || Boolean(onlyChild);
    let lastPrefixErr = null;
    for (const { child } of wg.loaded) {
        if (onlyChild && child !== onlyChild)
            continue;
        let r;
        try {
            r = ask(join(root, child), query, {
                limit: Math.max(limit * 4, 20),
                source: opts.source,
                full: opts.full,
                graphRank: opts.graphRank,
                in: childIn,
                fileFirst: false,
                fileComplement: true,
                includeRankingMetadata: true,
            });
            matchedAnyPrefix = true;
        }
        catch (err) {
            if (!onlyChild && childIn) {
                lastPrefixErr = err;
                continue;
            }
            throw err;
        }
        if (r.hits.length === 0)
            continue;
        const topGroup = r.ranking?.groups[0];
        runs.push({
            child,
            hits: r.hits,
            coverage: topGroup?.coverage ?? r.coverage ?? 0,
            coverageStrong: topGroup?.coverageStrong ?? r.coverageStrong ?? 0,
            baselineCoverage: r.ranking?.baselineCoverage ?? r.coverage ?? 0,
            baselineCoverageStrong: r.ranking?.baselineCoverageStrong ?? r.coverageStrong ?? 0,
            ranking: r.ranking,
        });
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    return partitionAskRunsByCoverageGate(runs, onlyChild);
}
function computeWorkspaceBaselineTop(baselineSurvivors) {
    const baselineDocs = [];
    const baselineBack = new Map();
    for (const run of baselineSurvivors) {
        const entries = run.ranking?.baseline ?? run.hits.map((hit, index) => ({
            group: `singleton:${index}`,
            hit,
        }));
        entries.forEach((entry, index) => {
            const id = `${run.child} ${index}`;
            const scope = entry.hit.scope ? `${run.child}/${entry.hit.scope}` : run.child;
            baselineDocs.push({ id, scope, score: entry.hit.score });
            baselineBack.set(id, {
                child: run.child,
                group: `${run.child}\0${entry.group}`,
                hit: entry.hit,
            });
        });
    }
    const baselineFused = fuseScopes(baselineDocs);
    const baselineTopRanked = baselineFused.ranked[0];
    const baselineTopBack = baselineTopRanked ? baselineBack.get(baselineTopRanked.id) : undefined;
    const baselineTop = baselineTopRanked && baselineTopBack
        ? qualifyWorkspaceHit(baselineTopBack.child, baselineTopBack.hit, baselineTopRanked.score, baselineTopRanked.scope)
        : undefined;
    return { baselineTop, baselineTopBack };
}
function federateAskWithFileTopLock(query, wg, limit, survivors, baselineSurvivors, gatedOut) {
    const { baselineTop, baselineTopBack } = computeWorkspaceBaselineTop(baselineSurvivors);
    const fileDocs = [];
    const fileBack = new Map();
    for (const run of survivors) {
        const groups = run.ranking?.groups ?? run.hits.map((hit, index) => ({
            key: `singleton:${index}`,
            hits: [hit],
            baselineHits: [hit],
            coverage: 0,
            coverageStrong: 0,
        }));
        groups.forEach((group, index) => {
            const leader = group.hits[0];
            if (!leader)
                return;
            const id = `${run.child} file ${String(index).padStart(8, "0")}`;
            const scope = leader.scope ? `${run.child}/${leader.scope}` : run.child;
            const key = `${run.child}\0${group.key}`;
            fileDocs.push({ id, scope, score: leader.score });
            fileBack.set(id, {
                key,
                child: run.child,
                hits: group.hits,
                baselineHits: group.baselineHits ?? [leader],
            });
        });
    }
    const fileFused = fuseScopes(fileDocs);
    const rankedGroups = fileFused.ranked.flatMap((ranked) => {
        const group = fileBack.get(ranked.id);
        if (!group)
            return [];
        return [{
                ...group,
                hits: group.hits.map((hit) => qualifyWorkspaceHit(group.child, hit, ranked.score, hit.scope ? `${group.child}/${hit.scope}` : group.child)),
                baselineHits: group.baselineHits.map((hit) => qualifyWorkspaceHit(group.child, hit)),
            }];
    });
    let projectedGroups = rankedGroups;
    if (baselineTop && baselineTopBack) {
        const key = baselineTopBack.group;
        const existing = rankedGroups.find((group) => group.key === key);
        const baselineQueue = existing?.baselineHits ?? [baselineTop];
        const projectedScore = existing?.hits[0]?.score ?? baselineTop.score;
        const locked = existing
            ? {
                ...existing,
                hits: [
                    baselineTop,
                    ...baselineQueue
                        .filter((hit) => !sameHit(hit, baselineTop))
                        .map((hit) => ({ ...hit, score: projectedScore })),
                ],
            }
            : {
                key,
                child: baselineTopBack.child,
                hits: [baselineTop],
                baselineHits: [baselineTop],
            };
        projectedGroups = [
            locked,
            ...rankedGroups.filter((group) => group.key !== key),
        ];
    }
    const hits = roundRobinQueues(projectedGroups.map((group) => group.hits), limit);
    const unmatched = [...fileFused.alsoMatched, ...gatedOut];
    const note = coverageNote(wg);
    const result = { query, mode: hits.length ? "lexical" : "empty", hits };
    if (hits.length) {
        const lockedScope = baselineTop?.scope;
        const federated = [...new Set([...(lockedScope ? [lockedScope] : []), ...fileFused.federated])];
        const federatedSet = new Set(federated);
        result.scopes = {
            federated,
            alsoMatched: unmatched.filter((match) => !federatedSet.has(match.scope)),
        };
    }
    else {
        result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`plexer build\` at a child`;
    }
    if (note)
        result.note = result.note ? `${result.note}\n${note}` : note;
    return result;
}
export function federateAsk(root, override, query, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const limit = opts.limit ?? 8;
    const { onlyChild, childIn } = resolveWorkspaceIn(wg, opts.in, false);
    const { gatedOut, survivors, baselineSurvivors } = collectChildAskRuns(root, wg, query, opts, limit, onlyChild, childIn);
    return federateAskWithFileTopLock(query, wg, limit, survivors, baselineSurvivors, gatedOut);
}
function resolveWorkspaceIn(wg, rawIn, strict = false) {
    if (!rawIn)
        return { onlyChild: undefined, childIn: undefined };
    if (Array.isArray(rawIn)) {
        const list = rawIn.map((x) => normalizePathPrefix(x)).filter(Boolean);
        if (list.length === 0)
            return { onlyChild: undefined, childIn: undefined };
        if (list.length === 1)
            return resolveWorkspaceIn(wg, list[0], strict);
        return { onlyChild: undefined, childIn: list };
    }
    const prefix = normalizePathPrefix(rawIn);
    if (!prefix)
        return { onlyChild: undefined, childIn: undefined };
    const [name, ...rest] = prefix.split("/");
    const allChildren = [...wg.loaded.map((l) => l.child), ...wg.missing].sort();
    if (wg.missing.includes(name)) {
        throw new Error(`workspace repo "${name}" is not built — run \`plexer build\` in ${name}/`);
    }
    if (allChildren.includes(name)) {
        return { onlyChild: name, childIn: rest.length ? rest.join("/") : undefined };
    }
    if (strict) {
        throw new Error(`no workspace repo "${name}" - repos: ${allChildren.join(", ")}`);
    }
    return { onlyChild: undefined, childIn: prefix };
}
/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree stays each child's own — it comes from that child's graph. */
export function federateGrep(root, override, pattern, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const { onlyChild, childIn } = resolveWorkspaceIn(wg, opts.in);
    const groups = [];
    let filesSearched = 0;
    let totalHits = 0;
    const truncated = { files: 0, hits: 0 };
    let matchedAnyPrefix = !childIn || Boolean(onlyChild);
    let lastPrefixErr = null;
    for (const { child, graph } of wg.loaded) {
        if (onlyChild && child !== onlyChild)
            continue;
        let r;
        try {
            r = grepGraph(graph, join(root, child), pattern, {
                ignoreCase: opts.ignoreCase,
                fixed: opts.fixed,
                context: opts.context,
                source: opts.source,
                in: childIn,
            });
            matchedAnyPrefix = true;
        }
        catch (err) {
            if (!onlyChild && childIn) {
                lastPrefixErr = err;
                continue;
            }
            throw err;
        }
        filesSearched += r.filesSearched;
        totalHits += r.totalHits;
        truncated.files += r.truncated.files;
        truncated.hits += r.truncated.hits;
        for (const g of r.groups) {
            groups.push({
                ...g,
                path: `${child}/${g.path}`,
                symbol: g.symbol ? { ...g.symbol, path: `${child}/${g.symbol.path}` } : null,
            });
        }
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    groups.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    const result = { pattern, filesSearched, totalHits, groups, truncated };
    return { result, coverage: coverageNote(wg) };
}
export function federateMap(root, override, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const perChild = opts.maxDirs !== undefined && wg.loaded.length > 0
        ? Math.max(1, Math.floor(opts.maxDirs / wg.loaded.length))
        : undefined;
    const repos = [];
    const sections = wg.loaded.map(({ child, graph }) => {
        const childRoot = join(root, child);
        const gitHistory = opts.churn && typeof opts.analyzeGitHistory === "function"
            ? opts.analyzeGitHistory(childRoot, contextDirFor(childRoot), opts.since ? { since: opts.since } : undefined)
            : undefined;
        const map = buildRepoMap(graph, {
            ...(perChild !== undefined ? { maxDirs: perChild } : {}),
            ...(gitHistory ? { gitHistory } : {}),
        });
        repos.push({ repo: child, ...map });
        return `## ${child}/\n${formatRepoMap(map).trimEnd()}`;
    });
    const cov = coverageNote(wg);
    if (opts.json) {
        return { repos, missing: wg.missing, ...(cov ? { note: cov } : {}) };
    }
    const head = `workspace map — ${wg.loaded.length} repo(s)`;
    const parts = [head, "", sections.join("\n\n")];
    if (cov)
        parts.push("", cov);
    return parts.join("\n") + "\n";
}
export async function federateCheck(root, override, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const lines = [`workspace check — ${wg.loaded.length + wg.missing.length} repo(s)`, ""];
    let ok = wg.missing.length === 0;
    const repos = {};
    for (const { child } of wg.loaded) {
        const g = await checkGraph(join(root, child), { extensions: opts.extensions });
        repos[child] = g;
        if (g.ok) {
            lines.push(`${child}/: OK`);
        }
        else {
            ok = false;
            const bits = [];
            if (g.added.length)
                bits.push(`${g.added.length} added`);
            if (g.removed.length)
                bits.push(`${g.removed.length} removed`);
            if (g.changed.length)
                bits.push(`${g.changed.length} changed`);
            if (g.stale.length)
                bits.push(`${g.stale.length} stale`);
            lines.push(`${child}/: STALE (${bits.join(", ")})`);
        }
    }
    for (const child of wg.missing) {
        repos[child] = null;
        lines.push(`${child}/: not built (run plexer build)`);
    }
    const cov = coverageNote(wg);
    if (cov)
        lines.push("", cov);
    return { text: lines.join("\n") + "\n", ok, repos, missing: wg.missing };
}
export function federateSkeleton(root, override, file, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    if (wg.loaded.length === 0) {
        return { file, entries: [], note: "no wiring graph — run `plexer build` first" };
    }
    const norm = String(file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const [firstSeg, ...rest] = norm.split("/");
    if (wg.missing.includes(firstSeg) && rest.length > 0) {
        return { file, entries: [], note: `workspace repo "${firstSeg}" is not built — run \`plexer build\` in ${firstSeg}/` };
    }
    const loadedChild = wg.loaded.find((l) => l.child === firstSeg);
    if (loadedChild && rest.length > 0) {
        const subFile = rest.join("/");
        const r = skeleton(join(root, loadedChild.child), subFile, opts);
        if (Array.isArray(r.files)) {
            return {
                files: r.files.map((f) => `${loadedChild.child}/${f}`),
                entries: r.entries.map((e) => ({ ...e, file: `${loadedChild.child}/${e.file}` })),
            };
        }
        return {
            ...r,
            file: r.entries.length > 0 ? `${loadedChild.child}/${r.file}` : file,
            entries: r.entries.map((e) => (e.file ? { ...e, file: `${loadedChild.child}/${e.file}` } : e)),
        };
    }
    const matches = [];
    const ambiguousNotes = [];
    for (const { child } of wg.loaded) {
        const r = skeleton(join(root, child), norm, opts);
        if (Array.isArray(r.files)) {
            for (const f of r.files) {
                matches.push({
                    child,
                    r: {
                        file: f,
                        entries: r.entries.filter((e) => e.file === f),
                    },
                });
            }
        }
        else if (r.entries.length > 0) {
            matches.push({ child, r });
        }
        else if (r.note?.startsWith("ambiguous — matches:")) {
            const subMatches = r.note
                .slice("ambiguous — matches:".length)
                .split(",")
                .map((s) => `${child}/${s.trim()}`);
            ambiguousNotes.push(...subMatches);
        }
    }
    if (matches.length === 1 && ambiguousNotes.length === 0) {
        const { child, r } = matches[0];
        return {
            ...r,
            file: `${child}/${r.file}`,
            entries: r.entries.map((e) => (e.file ? { ...e, file: `${child}/${e.file}` } : e)),
        };
    }
    if (matches.length > 1 || ambiguousNotes.length > 0) {
        if (opts.allMatches && ambiguousNotes.length === 0) {
            const sortedMatches = [...matches].sort((a, b) =>
                `${a.child}/${a.r.file}`.localeCompare(`${b.child}/${b.r.file}`),
            );
            return {
                files: sortedMatches.map(({ child, r }) => `${child}/${r.file}`),
                entries: sortedMatches.flatMap(({ child, r }) =>
                    r.entries.map((e) => ({ ...e, file: `${child}/${e.file ?? r.file}` })),
                ),
            };
        }
        const allPaths = [
            ...matches.map(({ child, r }) => `${child}/${r.file}`),
            ...ambiguousNotes,
        ].sort();
        return {
            file,
            entries: [],
            note: `ambiguous — matches: ${allPaths.join(", ")}`,
            error: `ambiguous path "${file}" — matches: ${allPaths.join(", ")}`,
        };
    }
    return { file, entries: [], note: "no definitions indexed for this file" };
}
export function federateRead(root, override, spanSpecs, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const specs = (Array.isArray(spanSpecs) ? spanSpecs : [spanSpecs])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    if (wg.loaded.length === 0) {
        return { blocks: specs.map((spec) => ({ spec, error: "no wiring graph — run `plexer build` first" })) };
    }
    const blocks = [];
    for (const rawSpec of specs) {
        const norm = rawSpec.replace(/\\/g, "/").replace(/^\/+/, "");
        const [firstSeg, ...rest] = norm.split("/");
        if (wg.missing.includes(firstSeg) && rest.length > 0) {
            blocks.push({
                spec: rawSpec,
                error: `workspace repo "${firstSeg}" is not built — run \`plexer build\` in ${firstSeg}/`,
            });
            continue;
        }
        const loadedChild = wg.loaded.find((l) => l.child === firstSeg);
        if (loadedChild && rest.length > 0) {
            const subSpec = rest.join("/");
            const r = readSpans(join(root, loadedChild.child), [subSpec], opts);
            for (const b of r.blocks) {
                blocks.push(
                    b.error
                        ? { ...b, spec: rawSpec }
                        : { ...b, spec: rawSpec, file: `${loadedChild.child}/${b.file}` },
                );
            }
            continue;
        }
        const childHits = [];
        for (const { child } of wg.loaded) {
            const r = readSpans(join(root, child), [norm], opts);
            const b = r.blocks[0];
            if (b && !b.error) {
                childHits.push({ child, b });
            }
        }
        if (childHits.length === 1) {
            const { child, b } = childHits[0];
            blocks.push({ ...b, spec: rawSpec, file: `${child}/${b.file}` });
        }
        else if (childHits.length > 1) {
            const allPaths = childHits.map(({ child, b }) => `${child}/${b.file}`).sort();
            blocks.push({
                spec: rawSpec,
                error: `ambiguous span "${rawSpec}" — matches: ${allPaths.join(", ")}`,
            });
        }
        else {
            blocks.push({
                spec: rawSpec,
                error: `cannot read "${rawSpec}" in any workspace repo`,
            });
        }
    }
    return { blocks };
}
function resolveUniqueCallersMatches(graph, queries, childIn) {
    const matches = [];
    const seenIds = new Set();
    for (const q of queries) {
        const resolved = resolveSymbol(graph, q, childIn ? { in: childIn } : {});
        for (const m of resolved) {
            if (!seenIds.has(m.id)) {
                seenIds.add(m.id);
                matches.push(m);
            }
        }
    }
    return matches;
}

function renderFederatedCallersChild(root, child, graph, matches, direction, depth, opts) {
    const showDepth = depth > 1;
    const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(graph, m, direction, depth) }));
    const read = fileReader(join(root, child));
    const testLinks = linkTestsForGraph(graph);
    const lines = [`## ${child}/`];
    const entries = [];
    const childSpans = !opts.full && opts.shownTargetSpans ? [] : null;
    for (const { symbol: sym, hits } of results) {
        lines.push(renderMatchBlock(sym, hits, direction, showDepth, matches.length, read, {
            source: Boolean(opts.source),
            full: Boolean(opts.full),
            seenSpans: !opts.full ? (opts.seenSpans ?? null) : null,
            shownTargetSpans: childSpans,
            graph,
            testLinks,
        }));
        const entry = {
            repo: child,
            symbol: symbolJson({ ...sym, path: `${child}/${sym.path}` }),
            hits: hits.map((h) => hitJson(h.node ? { ...h, node: { ...h.node, path: `${child}/${h.node.path}` } } : h)),
        };
        if (hits.length === 0)
            entry.note = looseNoteFor(direction, sym.name, matches.length);
        entries.push(entry);
    }
    if (childSpans && opts.shownTargetSpans) {
        for (const sp of childSpans) {
            opts.shownTargetSpans.push({ ...sp, file: `${child}/${sp.file}` });
        }
    }
    return { block: lines.join("\n"), entries };
}

export function federateCallers(root, override, symbol, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const { onlyChild, childIn } = resolveWorkspaceIn(wg, opts.in);
    const direction = opts.direction ?? "in";
    const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
    const queries = (Array.isArray(symbol) ? symbol : [symbol])
        .flatMap((q) => String(q).split(",").map((s) => s.trim()).filter(Boolean));
    const blocks = [];
    const jsonMatches = [];
    let matchedAnyPrefix = !childIn || Boolean(onlyChild);
    let lastPrefixErr = null;
    for (const { child, graph } of wg.loaded) {
        if (onlyChild && child !== onlyChild)
            continue;
        let matches;
        try {
            matches = resolveUniqueCallersMatches(graph, queries, childIn);
            matchedAnyPrefix = true;
        }
        catch (err) {
            if (!onlyChild && childIn) {
                lastPrefixErr = err;
                continue;
            }
            throw err;
        }
        if (matches.length === 0)
            continue;
        const rendered = renderFederatedCallersChild(root, child, graph, matches, direction, depth, opts);
        blocks.push(rendered.block);
        jsonMatches.push(...rendered.entries);
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    const cov = coverageNote(wg);
    if (blocks.length === 0) {
        const label = Array.isArray(symbol) ? symbol.join(", ") : symbol;
        const base = `no symbol "${label}" in any of the ${wg.loaded.length} workspace repo(s) — check spelling or run plexer build`;
        return { text: cov ? `${base}\n${cov}` : base, found: false, matches: [], coverage: cov };
    }
    return { text: cov ? `${blocks.join("\n\n")}\n\n${cov}` : blocks.join("\n\n"), found: true, matches: jsonMatches, coverage: cov };
}
/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine dependency),
 * then replace the parent's `plexer/` with `workspace.json`. `onStart`
 * fires once — before any child is built — with the discovered child list.
 *
 * The child build writes into `<child>/plexer/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export async function splitWorkspace(root, override, buildChild, onStart) {
    const children = discoverWorkspaceChildren(root).slice().sort();
    onStart?.({ children });
    for (const child of children)
        await buildChild(join(root, child), child);
    clearParentPlexer(root, override);
    writeWorkspace(root, { version: 1, children }, override);
    return { children };
}

