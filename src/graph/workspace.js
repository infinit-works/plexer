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
import { loadGraphCached } from "./load.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { discoverWorkspaceChildren } from "./scopes.js";
import { headerOf, hitJson, hitLine, looseNoteFor, quoteFor, renderMatchBlock, symbolJson } from "./traverse-cli.js";
import { edgeWalk, resolveSymbol } from "./traverse.js";
import { ask, sameHit, skeleton } from "../ask/ask.js";
import { fileFirstRoundRobin, roundRobinQueues, } from "../ask/file-selection.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR } from "../ask/fuse.js";
import { grepGraph } from "../search/grep.js";
import { fileReader, parseSpan, wordRe } from "../blast/evidence.js";
import { normalizePathPrefix } from "../util/paths.js";
import { readBuildConfig, readJson, writeBuildConfig, writeJsonAtomic } from "../util/state.js";
const WORKSPACE_FILE = "workspace.json";
/** Absolute path to the workspace index for a parent root (`<dir>/plexer/workspace.json`). */
export function workspacePath(root, override) {
    return join(contextDirFor(root, override), WORKSPACE_FILE);
}
/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export function readWorkspace(root, override) {
    const parsed = readJson(workspacePath(root, override));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.children))
        return null;
    return { version: 1, children: parsed.children.map(String) };
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
/** The exact child-relative file owning a lexical symbol hit. File nodes use a
 * bare path; definition hits append `:Lx-Ly`. */
function hitFile(pointer) {
    return parseSpan(pointer)?.path ?? pointer;
}
// STRONG_FLOOR / HIGH_FLOOR (a child federates if its top hit matched a
// query term in a NAME/PATH field ≥ STRONG_FLOOR, OR its overall name+path+
// body coverage is broad enough to be real even body-only, ≥ HIGH_FLOOR) are
// defined ONCE in `../ask/fuse.js` and imported here. This is now their only
// caller: a share-of-the-query threshold is the best available signal when the
// candidates carry no common score scale, which is the situation across child
// repositories. `rankScopesAndFuse` used to gate on them for the same reason
// and no longer needs to — within one repo the scores are comparable, so a
// weak scope is held back by scoring low rather than by a strength floor.
/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export function federateAsk(root, override, query, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const limit = opts.limit ?? 8;
    const fileTopLock = opts.fileTopLock ?? true;
    // `--in` scopes to a single child (and, past the first segment, a sub-scope
    // within it). A prefix naming no known child at all is a caller mistake.
    const { onlyChild, childIn } = resolveWorkspaceIn(wg, opts.in, true);
    // Pass 1: run each child's ask; keep its hits + RAW top-hit coverage.
    const runs = [];
    for (const { child } of wg.loaded) {
        if (onlyChild && child !== onlyChild)
            continue;
        let r;
        try {
            // Over-fetch per child so cross-child fusion has enough candidates to
            // rank before the final `limit` slice.
            r = ask(join(root, child), query, {
                limit: Math.max(limit * 4, 20),
                source: opts.source,
                full: opts.full,
                graphRank: opts.graphRank,
                in: childIn,
                // The parent owns the final cross-repo ranking. Selecting inside each
                // child would be undone by fusion and could truncate a hybrid list.
                fileFirst: false,
                fileComplement: fileTopLock,
                includeRankingMetadata: fileTopLock,
            });
        }
        catch {
            continue; // corrupt child, or a sub-scope --in matching nothing here
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
    // Cross-child participation gate on match STRENGTH, not a lenient ratio.
    // Per-child hit scores are each per-child-normalized (top ~1.0 everywhere),
    // so feeding them to fuseScopes makes its gate vacuous across repos — a junk
    // body-token collision would federate beside another repo's genuine hits.
    // Gate: a child federates iff its top hit matched a query term in a NAME/PATH
    // field (coverageStrong ≥ STRONG_FLOOR — not just an incidental body token)
    // OR its overall coverage is broad enough to be real (≥ HIGH_FLOOR). A
    // body-only collision has coverageStrong 0 and coverage ~0.3 → gated to
    // alsoMatched. Both floors are absolute + scale-invariant (see their docs).
    // The gate is a cross-child FAIRNESS mechanism: it stops a weak body-token
    // collision in one repo from federating beside another repo's genuine hits.
    // An explicit `--in <child>` removes all cross-child competition — the caller
    // has already chosen the scope — so the gate must NOT apply there, or the
    // `also matched: <child> — narrow with --in <child>` hint would lead to an
    // empty result for exactly the weak child it points at. With `onlyChild` set,
    // every run (there is at most one) survives, matching a standalone child ask.
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
        // Distributed file evidence may admit a child, but the exact baseline
        // top lock must never resurrect a child that the final stream calls gated
        // out. The production survivor set is therefore the union of both gates;
        // baselineSurvivors remains the strict baseline subset used only to choose the
        // locked pointer.
        if (baselineEligible || fileEligible)
            survivors.push(run);
        else {
            const best = run.ranking?.groups[0]?.hits[0] ?? run.hits[0];
            gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, best.pointer) });
        }
    }
    if (fileTopLock) {
        const qualifyHit = (child, hit, score = hit.score, scope = hit.scope ? `${child}/${hit.scope}` : child) => ({
            ...hit,
            score,
            scope,
            pointer: prefixPointer(child, hit.pointer),
        });
        // Baseline workspace stream: reproduce the all-span RRF exactly so the
        // final lock owns the same concrete pointer and fused score as the baseline.
        const baselineDocs = [];
        const baselineBack = new Map();
        for (const run of baselineSurvivors) {
            const entries = run.ranking?.baseline ?? run.hits.map((hit, index) => ({
                group: `singleton:${index}`,
                hit,
            }));
            entries.forEach((entry, index) => {
                // Deterministic `<child> <index>` id so equal-score baseline ties remain exact.
                const id = `${run.child} ${index}`;
                const scope = entry.hit.scope
                    ? `${run.child}/${entry.hit.scope}`
                    : run.child;
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
        const baselineTopBack = baselineTopRanked
            ? baselineBack.get(baselineTopRanked.id)
            : undefined;
        const baselineTop = baselineTopRanked && baselineTopBack
            ? qualifyHit(baselineTopBack.child, baselineTopBack.hit, baselineTopRanked.score, baselineTopRanked.scope)
            : undefined;
        // File-aware workspace stream: exactly one leader per child/file (concepts stay
        // singleton groups) participates in RRF. Span queues remain in a side map
        // and cannot consume reciprocal-rank positions.
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
                    // These spans are projections of one cross-child file document. Keep
                    // their public score on that same RRF scale; child-local tail scores are
                    // not comparable after workspace fusion and downstream re-sorting would
                    // otherwise silently undo the file ordering.
                    hits: group.hits.map((hit) => qualifyHit(group.child, hit, ranked.score, hit.scope ? `${group.child}/${hit.scope}` : group.child)),
                    baselineHits: group.baselineHits.map((hit) => qualifyHit(group.child, hit)),
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
        const result = {
            query,
            mode: hits.length ? "lexical" : "empty",
            hits,
        };
        if (hits.length) {
            const lockedScope = baselineTop?.scope;
            const federated = [
                ...new Set([
                    ...(lockedScope ? [lockedScope] : []),
                    ...fileFused.federated,
                ]),
            ];
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
    // Fuse the survivors' scope lists (within-child fusion is left untouched —
    // each child already ran its own per-scope RRF).
    const docs = [];
    const back = new Map();
    for (const { child, hits } of survivors) {
        hits.forEach((hit, i) => {
            const scope = hit.scope ? `${child}/${hit.scope}` : child;
            const id = `${child} ${i}`;
            docs.push({ id, scope, score: hit.score });
            back.set(id, { child, hit });
        });
    }
    const fused = fuseScopes(docs);
    const rankedHits = fused.ranked.map((rd) => {
        const { child, hit } = back.get(rd.id);
        const value = {
            ...hit,
            score: rd.score,
            scope: rd.scope,
            pointer: prefixPointer(child, hit.pointer),
        };
        return {
            // Lexical symbols share a file queue. Concepts and structural neighbours
            // remain singleton partitions, so this lexical selection layer cannot
            // reorder `who calls` / `dependencies of` answers.
            group: hit.kind === "symbol"
                ? `file:${child}/${hitFile(hit.pointer)}`
                : `singleton:${child}:${rd.id}`,
            value,
        };
    });
    const hits = fileFirstRoundRobin(rankedHits, limit);
    const alsoMatched = [...fused.alsoMatched, ...gatedOut];
    const note = coverageNote(wg);
    const result = { query, mode: hits.length ? "lexical" : "empty", hits };
    if (hits.length) {
        const federated = fused.federated.length ? fused.federated : [...new Set(hits.map((h) => h.scope))];
        result.scopes = { federated, alsoMatched };
    }
    else {
        result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`plexer build\` at a child`;
    }
    if (note)
        result.note = result.note ? `${result.note}\n${note}` : note;
    return result;
}
function resolveWorkspaceIn(wg, rawIn, strict = false) {
    if (!rawIn)
        return { onlyChild: undefined, childIn: undefined };
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
        const map = buildRepoMap(graph, perChild !== undefined ? { maxDirs: perChild } : {});
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
export function federateCallers(root, override, symbol, opts = {}) {
    const wg = loadWorkspaceGraphs(root, override);
    const { onlyChild, childIn } = resolveWorkspaceIn(wg, opts.in);
    const direction = opts.direction ?? "in";
    const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
    const showDepth = depth > 1;
    const queries = (Array.isArray(symbol) ? symbol : [symbol])
        .flatMap((q) => String(q).split(",").map((s) => s.trim()).filter(Boolean));
    const blocks = [];
    const jsonMatches = [];
    let found = false;
    let matchedAnyPrefix = !childIn || Boolean(onlyChild);
    let lastPrefixErr = null;
    for (const { child, graph } of wg.loaded) {
        if (onlyChild && child !== onlyChild)
            continue;
        let matches = [];
        const seenIds = new Set();
        try {
            for (const q of queries) {
                const resolved = resolveSymbol(graph, q, childIn ? { in: childIn } : {});
                for (const m of resolved) {
                    if (!seenIds.has(m.id)) {
                        seenIds.add(m.id);
                        matches.push(m);
                    }
                }
            }
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
        found = true;
        const results = matches.map((m) => ({ symbol: m, hits: edgeWalk(graph, m, direction, depth) }));
        const read = fileReader(join(root, child));
        const lines = [`## ${child}/`];
        for (const { symbol: sym, hits } of results) {
            lines.push(renderMatchBlock(sym, hits, direction, showDepth, matches.length, read, graph, Boolean(opts.source)));
            const entry = {
                repo: child,
                symbol: symbolJson({ ...sym, path: `${child}/${sym.path}` }),
                hits: hits.map((h) => hitJson(h.node ? { ...h, node: { ...h.node, path: `${child}/${h.node.path}` } } : h)),
            };
            if (hits.length === 0)
                entry.note = looseNoteFor(direction, sym.name, matches.length);
            jsonMatches.push(entry);
        }
        blocks.push(lines.join("\n"));
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    const cov = coverageNote(wg);
    if (!found) {
        const label = Array.isArray(symbol) ? symbol.join(", ") : symbol;
        const base = `no symbol "${label}" in any of the ${wg.loaded.length} workspace repo(s) — check spelling or run plexer build`;
        return { text: cov ? `${base}\n${cov}` : base, found: false, matches: [], coverage: cov };
    }
    let text = blocks.join("\n\n");
    if (cov)
        text += `\n\n${cov}`;
    return { text, found: true, matches: jsonMatches, coverage: cov };
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

