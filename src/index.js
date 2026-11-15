import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tryRealpath } from "./util/fs.js";
import { parseJsonc } from "./util/jsonc.js";
import { loadGraphCached } from "./context/graph-store.js";
import { contextDirFor } from "./context/node-file.js";
import { resolveSymbol } from "./context/symbol-query.js";
import { buildGraph } from "./graph/build.js";
import { listSourceFiles } from "./graph/source-files.js";
import { checkGraph, formatGraphCheckReport } from "./graph/check.js";
import {
    federateAsk,
    federateCallers,
    federateCheck,
    federateGrep,
    federateMap,
    federateRead,
    federateSkeleton,
    loadWorkspaceGraphs,
    readWorkspace,
} from "./graph/workspace.js";
import { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans } from "./ask/ask.js";
import { roundRobinQueues } from "./ask/file-selection.js";
import { fuseScopes, HIGH_FLOOR, STRONG_FLOOR } from "./ask/fuse.js";
import { isTestPath, normalizePathPrefix } from "./util/paths.js";
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

function collectMatchTests(symbol, hits, direction, testLinks, pathPrefix = "") {
    const qualify = (p) => (pathPrefix ? `${pathPrefix}/${p}` : p);
    const rawLinks = symbol.kind === "file"
        ? testLinks.testsForFile(symbol.path)
        : testLinks.testsForSymbol(symbol.id, symbol.path, true);
    const seen = new Set();
    const out = [];
    for (const t of rawLinks) {
        seen.add(t.testFile);
        out.push({
            path: qualify(t.testFile),
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
                    path: qualify(p),
                    confidence: h.depth === 1 ? "high" : "medium",
                    reason: h.depth === 1 ? "symbol_call" : "transitive_call",
                });
            }
        }
    }
    return out;
}

function uniqueRepoLabels(entries) {
    const baseCounts = new Map();
    for (const entry of entries) {
        const label = entry.rawName || basename(entry.dir) || "repo";
        baseCounts.set(label, (baseCounts.get(label) ?? 0) + 1);
    }
    const assigned = [];
    const seen = new Map();
    for (const entry of entries) {
        const base = entry.rawName || basename(entry.dir) || "repo";
        let label = base;
        if ((baseCounts.get(base) ?? 0) > 1) {
            const parent = basename(dirname(entry.dir));
            label = parent ? `${parent}/${base}` : base;
        }
        const n = (seen.get(label) ?? 0) + 1;
        seen.set(label, n);
        assigned.push(n > 1 ? `${label}-${n}` : label);
    }
    return assigned;
}

function parseCodeWorkspaceFile(wsFilePath) {
    let parsed;
    try {
        parsed = parseJsonc(readFileSync(wsFilePath, "utf8"));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.folders))
        return null;
    const baseDir = dirname(wsFilePath);
    const seenDirs = new Set();
    const rawEntries = [];
    for (const folder of parsed.folders) {
        if (!folder || typeof folder.path !== "string" || !folder.path.trim())
            continue;
        const absDir = resolve(baseDir, folder.path);
        if (!existsSync(absDir))
            continue;
        let st;
        try {
            st = statSync(absDir);
        } catch {
            continue;
        }
        if (!st.isDirectory())
            continue;
        const realKey = tryRealpath(absDir);
        if (seenDirs.has(realKey))
            continue;
        seenDirs.add(realKey);
        const rawName = typeof folder.name === "string" ? folder.name.trim().replace(/[\\/]+/g, "-") : "";
        rawEntries.push({ dir: absDir, rawName });
    }
    const labels = uniqueRepoLabels(rawEntries);
    return {
        file: wsFilePath,
        repos: rawEntries.map((entry, idx) => ({ label: labels[idx], dir: entry.dir })),
    };
}

/**
 * Read a VS Code / Antigravity `.code-workspace` file (directly by path, or by
 * discovering a `.code-workspace` file inside a directory) and resolve its
 * existing repository folders with unique labels.
 */
export function readCodeWorkspace(dirOrFile) {
    const abs = resolve(dirOrFile);
    if (!existsSync(abs))
        return null;
    let st;
    try {
        st = statSync(abs);
    } catch {
        return null;
    }
    if (st.isFile() && abs.toLowerCase().endsWith(".code-workspace")) {
        return parseCodeWorkspaceFile(abs);
    }
    if (!st.isDirectory())
        return null;
    const candidates = readdirSync(abs)
        .filter((name) => name.toLowerCase().endsWith(".code-workspace"))
        .sort();
    if (candidates.length === 0)
        return null;
    const preferred = `${basename(abs)}.code-workspace`;
    const chosen = candidates.find((c) => c === preferred) ?? candidates[0];
    return parseCodeWorkspaceFile(join(abs, chosen));
}

function prefixRepoPointer(label, pointer) {
    if (!pointer)
        return pointer;
    if (pointer.startsWith(`${label}/`))
        return pointer;
    return `${label}/${pointer}`;
}

function matchRepoLabelPrefix(norm, labels) {
    const sorted = [...labels].sort((a, b) => b.length - a.length);
    for (const label of sorted) {
        if (norm === label)
            return { label, rest: "" };
        if (norm.startsWith(`${label}/`))
            return { label, rest: norm.slice(label.length + 1) };
    }
    return null;
}

function resolveRepoFilter(loadedLabels, missingLabels, rawIn, strict = false) {
    if (!rawIn)
        return { onlyRepo: undefined, childIn: undefined };
    const prefix = normalizePathPrefix(rawIn);
    if (!prefix)
        return { onlyRepo: undefined, childIn: undefined };
    const missingMatch = matchRepoLabelPrefix(prefix, missingLabels);
    if (missingMatch) {
        throw new Error(`workspace repo "${missingMatch.label}" is not built — run \`plexer build\` in ${missingMatch.label}/`);
    }
    const loadedMatch = matchRepoLabelPrefix(prefix, loadedLabels);
    if (loadedMatch) {
        return { onlyRepo: loadedMatch.label, childIn: loadedMatch.rest || undefined };
    }
    if (strict) {
        const all = [...loadedLabels, ...missingLabels].sort();
        const head = prefix.split("/")[0];
        throw new Error(`no workspace repo "${head}" - repos: ${all.join(", ")}`);
    }
    return { onlyRepo: undefined, childIn: prefix };
}

function dedupeAskSeenPointers(result, seenPointers, trackSeen) {
    if (!seenPointers || !result?.hits)
        return result;
    for (const hit of result.hits) {
        if (!hit?.pointer)
            continue;
        if (seenPointers.has(hit.pointer)) {
            if (trackSeen && hit.code) {
                delete hit.code;
                hit.alreadySeen = true;
            }
        } else {
            seenPointers.add(hit.pointer);
        }
    }
    return result;
}

function callersInGraph(graph, queries, direction, depth, inPrefix, includeTests, repoLabel) {
    const matches = [];
    const seenIds = new Set();
    const filterOpts = inPrefix ? { in: inPrefix } : {};
    for (const q of queries) {
        for (const m of resolveSymbol(graph, q, filterOpts)) {
            if (!seenIds.has(m.id)) {
                seenIds.add(m.id);
                matches.push(m);
            }
        }
    }
    if (matches.length === 0)
        return [];
    const testLinks = includeTests ? linkTestsForGraph(graph) : null;
    const prefixPath = (p) => (repoLabel && p && !p.startsWith(`${repoLabel}/`) ? `${repoLabel}/${p}` : p);
    return matches.map((m) => {
        const rawHits = edgeWalk(graph, m, direction, depth);
        const symbol = repoLabel ? { ...m, path: prefixPath(m.path) } : m;
        const hits = repoLabel
            ? rawHits.map((h) => (h.node ? { ...h, node: { ...h.node, path: prefixPath(h.node.path) } } : h))
            : rawHits;
        const entry = repoLabel ? { repo: repoLabel, symbol, hits } : { symbol, hits };
        if (testLinks) {
            entry.tests = collectMatchTests(m, rawHits, direction, testLinks, repoLabel ?? "");
        }
        return entry;
    });
}

function callersAcrossRepos(repos, missingLabels, queries, direction, depth, opts) {
    const loadedLabels = repos.map((r) => r.label);
    const { onlyRepo, childIn } = resolveRepoFilter(loadedLabels, missingLabels, opts.in);
    const out = [];
    let matchedAnyPrefix = !childIn || Boolean(onlyRepo);
    let lastPrefixErr = null;
    for (const { label, graph } of repos) {
        if (onlyRepo && label !== onlyRepo)
            continue;
        let repoMatches;
        try {
            repoMatches = callersInGraph(graph, queries, direction, depth, childIn, opts.includeTests, label);
            matchedAnyPrefix = true;
        } catch (err) {
            if (!onlyRepo && childIn) {
                lastPrefixErr = err;
                continue;
            }
            throw err;
        }
        out.push(...repoMatches);
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    return out;
}

function collectAcrossRepoRuns(repos, query, opts, contextDir, onlyRepo, childIn, limit) {
    const runs = [];
    let matchedAnyPrefix = !childIn || Boolean(onlyRepo);
    let lastPrefixErr = null;
    for (const { label, dir } of repos) {
        if (onlyRepo && label !== onlyRepo) continue;
        let r;
        try {
            r = ask(dir, query, {
                ...opts,
                seenPointers: undefined,
                contextDir,
                limit: Math.max(limit * 4, 20),
                in: childIn,
                fileFirst: false,
                fileComplement: true,
                includeRankingMetadata: true,
            });
            matchedAnyPrefix = true;
        } catch (err) {
            if (!onlyRepo && childIn) {
                lastPrefixErr = err;
                continue;
            }
            throw err;
        }
        if (r.hits.length === 0) continue;
        const topGroup = r.ranking?.groups?.[0];
        runs.push({
            label,
            dir,
            res: r,
            coverage: topGroup?.coverage ?? r.coverage ?? 0,
            coverageStrong: topGroup?.coverageStrong ?? r.coverageStrong ?? 0,
        });
    }
    if (!matchedAnyPrefix && lastPrefixErr) throw lastPrefixErr;
    return runs;
}

function splitEligibleRepoRuns(runs, onlyRepo) {
    const gatedOut = [];
    const survivors = [];
    for (const run of runs) {
        if (onlyRepo || run.coverageStrong >= STRONG_FLOOR || run.coverage >= HIGH_FLOOR) {
            survivors.push(run);
        } else {
            gatedOut.push({ scope: run.label, bestId: prefixRepoPointer(run.label, run.res.hits[0].pointer) });
        }
    }
    return { survivors, gatedOut };
}

function fuseAcrossRepoHits(survivors, multiRoot, limit) {
    const qualifyHit = (run, hit, score, scope) => ({
        ...hit,
        ...(score !== undefined ? { score } : {}),
        ...(scope !== undefined ? { scope } : {}),
        pointer: multiRoot ? prefixRepoPointer(run.label, hit.pointer) : hit.pointer,
        repoLabel: run.label,
        repoDir: run.dir,
    });
    const docs = [];
    const back = new Map();
    for (const run of survivors) {
        const groups = run.res.ranking?.groups ?? run.res.hits.map((hit, idx) => ({
            key: `singleton:${idx}`,
            hits: [hit],
        }));
        groups.forEach((group, idx) => {
            const leader = group.hits[0];
            if (!leader) return;
            const id = `${run.label} file ${String(idx).padStart(8, "0")}`;
            const scope = leader.scope ? `${run.label}/${leader.scope}` : run.label;
            docs.push({ id, scope, score: leader.score ?? 0 });
            back.set(id, { run, hits: group.hits });
        });
    }
    const fused = fuseScopes(docs);
    const queues = fused.ranked.flatMap((ranked) => {
        const group = back.get(ranked.id);
        if (!group) return [];
        return [group.hits.map((h) => qualifyHit(group.run, h, ranked.score, h.scope ? `${group.run.label}/${h.scope}` : group.run.label))];
    });
    return { fused, hits: roundRobinQueues(queues, limit) };
}

function buildAcrossRepoResult(query, repos, missingLabels, survivors, gatedOut, fused, hits, multiRoot, federatedRepos) {
    const result = {
        query,
        mode: hits.length ? "lexical" : "empty",
        hits,
        multiRoot,
        federatedRepos,
    };
    if (survivors.length === 1) {
        result.confidenceTier = survivors[0].res.confidenceTier;
        result.coverage = survivors[0].res.coverage;
        result.coverageStrong = survivors[0].res.coverageStrong;
    } else if (hits.length > 0) {
        result.confidenceTier = survivors[0]?.res?.confidenceTier;
    } else {
        result.confidenceTier = "exploratory";
    }
    if (hits.length > 0) {
        const federatedSet = new Set(fused.federated);
        result.scopes = {
            federated: fused.federated,
            alsoMatched: [...fused.alsoMatched, ...gatedOut].filter((m) => !federatedSet.has(m.scope)),
        };
    } else {
        result.note = `no matching nodes across ${repos.length} workspace repo(s)`;
    }
    if (missingLabels.length > 0) {
        const total = repos.length + missingLabels.length;
        const cov = `${repos.length} of ${total} workspace repos have graphs; run plexer build to cover ${missingLabels.join(", ")}`;
        result.note = result.note ? `${result.note}\n${cov}` : cov;
    }
    return result;
}

function askAcrossRepos(repos, missingLabels, query, opts, contextDir) {
    const limit = opts.limit ?? 8;
    const multiRoot = repos.length + missingLabels.length > 1;
    const federatedRepos = repos.map((r) => r.label);
    if (repos.length === 0) {
        return {
            query,
            mode: "empty",
            hits: [],
            multiRoot,
            federatedRepos,
            note: "no built graphs found for workspace — run `plexer build` in its folders",
        };
    }
    const { onlyRepo, childIn } = resolveRepoFilter(federatedRepos, missingLabels, opts.in, true);
    const runs = collectAcrossRepoRuns(repos, query, opts, contextDir, onlyRepo, childIn, limit);
    const { survivors, gatedOut } = splitEligibleRepoRuns(runs, onlyRepo);
    const { fused, hits } = fuseAcrossRepoHits(survivors, multiRoot, limit);
    return buildAcrossRepoResult(query, repos, missingLabels, survivors, gatedOut, fused, hits, multiRoot, federatedRepos);
}

function skeletonAcrossRepos(repos, missingLabels, file, opts, contextDir) {
    if (repos.length === 0)
        return { file, entries: [], note: "no wiring graph — run `plexer build` first" };
    const norm = String(file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const missingMatch = matchRepoLabelPrefix(norm, missingLabels);
    if (missingMatch && missingMatch.rest) {
        return { file, entries: [], note: `workspace repo "${missingMatch.label}" is not built — run \`plexer build\` in ${missingMatch.label}/` };
    }
    const directMatch = matchRepoLabelPrefix(norm, repos.map((r) => r.label));
    const directRepo = directMatch && directMatch.rest ? repos.find((r) => r.label === directMatch.label) : null;
    if (directRepo) {
        const r = skeleton(directRepo.dir, directMatch.rest, { ...opts, contextDir });
        if (Array.isArray(r.files)) {
            return {
                files: r.files.map((f) => `${directRepo.label}/${f}`),
                entries: r.entries.map((e) => ({ ...e, file: `${directRepo.label}/${e.file}` })),
            };
        }
        return {
            ...r,
            file: r.entries.length > 0 ? `${directRepo.label}/${r.file}` : file,
            entries: r.entries.map((e) => (e.file ? { ...e, file: `${directRepo.label}/${e.file}` } : e)),
        };
    }
    const matches = [];
    const ambiguousNotes = [];
    for (const { label, dir } of repos) {
        const r = skeleton(dir, norm, { ...opts, contextDir });
        if (Array.isArray(r.files)) {
            for (const f of r.files) {
                matches.push({ label, r: { file: f, entries: r.entries.filter((e) => e.file === f) } });
            }
        } else if (r.entries.length > 0) {
            matches.push({ label, r });
        } else if (r.note?.startsWith("ambiguous — matches:")) {
            const subs = r.note.slice("ambiguous — matches:".length).split(",").map((s) => `${label}/${s.trim()}`);
            ambiguousNotes.push(...subs);
        }
    }
    if (matches.length === 1 && ambiguousNotes.length === 0) {
        const { label, r } = matches[0];
        return {
            ...r,
            file: `${label}/${r.file}`,
            entries: r.entries.map((e) => (e.file ? { ...e, file: `${label}/${e.file}` } : e)),
        };
    }
    if (matches.length > 1 || ambiguousNotes.length > 0) {
        if (opts.allMatches && ambiguousNotes.length === 0) {
            const sorted = [...matches].sort((a, b) => `${a.label}/${a.r.file}`.localeCompare(`${b.label}/${b.r.file}`));
            return {
                files: sorted.map(({ label, r }) => `${label}/${r.file}`),
                entries: sorted.flatMap(({ label, r }) => r.entries.map((e) => ({ ...e, file: `${label}/${e.file ?? r.file}` }))),
            };
        }
        const allPaths = [...matches.map(({ label, r }) => `${label}/${r.file}`), ...ambiguousNotes].sort();
        return {
            file,
            entries: [],
            note: `ambiguous — matches: ${allPaths.join(", ")}`,
            error: `ambiguous path "${file}" — matches: ${allPaths.join(", ")}`,
        };
    }
    return { file, entries: [], note: "no definitions indexed for this file" };
}

function grepAcrossRepos(repos, missingLabels, pattern, opts) {
    const loadedLabels = repos.map((r) => r.label);
    const { onlyRepo, childIn } = resolveRepoFilter(loadedLabels, missingLabels, opts.in);
    const groups = [];
    let filesSearched = 0;
    let totalHits = 0;
    const truncated = { files: 0, hits: 0 };
    let matchedAnyPrefix = !childIn || Boolean(onlyRepo);
    let lastPrefixErr = null;
    for (const { label, dir, graph } of repos) {
        if (onlyRepo && label !== onlyRepo)
            continue;
        let r;
        try {
            r = grepGraph(graph, dir, pattern, { ...opts, in: childIn });
            matchedAnyPrefix = true;
        } catch (err) {
            if (!onlyRepo && childIn) {
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
                path: `${label}/${g.path}`,
                symbol: g.symbol ? { ...g.symbol, path: `${label}/${g.symbol.path}` } : null,
            });
        }
    }
    if (!matchedAnyPrefix && lastPrefixErr)
        throw lastPrefixErr;
    groups.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
    return { pattern, filesSearched, totalHits, groups, truncated };
}

function readAcrossRepos(repos, missingLabels, spanSpecs, opts, contextDir) {
    const specs = (Array.isArray(spanSpecs) ? spanSpecs : [spanSpecs])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    if (repos.length === 0) {
        return { blocks: specs.map((spec) => ({ spec, error: "no wiring graph — run `plexer build` first" })) };
    }
    const blocks = [];
    const loadedLabels = repos.map((r) => r.label);
    for (const rawSpec of specs) {
        const norm = rawSpec.replace(/\\/g, "/").replace(/^\/+/, "");
        const missingMatch = matchRepoLabelPrefix(norm, missingLabels);
        if (missingMatch && missingMatch.rest) {
            blocks.push({ spec: rawSpec, error: `workspace repo "${missingMatch.label}" is not built — run \`plexer build\` in ${missingMatch.label}/` });
            continue;
        }
        const directMatch = matchRepoLabelPrefix(norm, loadedLabels);
        const directRepo = directMatch && directMatch.rest ? repos.find((r) => r.label === directMatch.label) : null;
        if (directRepo) {
            const r = readSpans(directRepo.dir, [directMatch.rest], { ...opts, contextDir });
            for (const b of r.blocks) {
                blocks.push(b.error ? { ...b, spec: rawSpec } : { ...b, spec: rawSpec, file: `${directRepo.label}/${b.file}` });
            }
            continue;
        }
        const hits = [];
        for (const { label, dir } of repos) {
            const r = readSpans(dir, [norm], { ...opts, contextDir });
            const b = r.blocks[0];
            if (b && !b.error)
                hits.push({ label, b });
        }
        if (hits.length === 1) {
            blocks.push({ ...hits[0].b, spec: rawSpec, file: `${hits[0].label}/${hits[0].b.file}` });
        } else if (hits.length > 1) {
            const allPaths = hits.map(({ label, b }) => `${label}/${b.file}`).sort();
            blocks.push({ spec: rawSpec, error: `ambiguous span "${rawSpec}" — matches: ${allPaths.join(", ")}` });
        } else {
            blocks.push({ spec: rawSpec, error: `cannot read "${rawSpec}" in any workspace repo` });
        }
    }
    return { blocks };
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
    #resolveTarget(dir) {
        const abs = resolve(dir);
        let st = null;
        if (existsSync(abs)) {
            try {
                st = statSync(abs);
            } catch {
                st = null;
            }
        }
        if (st?.isFile() && abs.toLowerCase().endsWith(".code-workspace")) {
            const cw = parseCodeWorkspaceFile(abs);
            if (!cw)
                throw new Error(`invalid .code-workspace file: ${abs}`);
            return { kind: "code-workspace", ...cw };
        }
        if (readWorkspace(abs, this.cfg.contextDir)) {
            return { kind: "workspace", root: abs };
        }
        const directGraph = loadGraphCached(contextDirFor(abs, this.cfg.contextDir));
        if (!directGraph && st?.isDirectory()) {
            const cw = readCodeWorkspace(abs);
            if (cw)
                return { kind: "code-workspace", ...cw };
        }
        return { kind: "single", root: abs };
    }
    #loadCodeWorkspaceRepos(target, requireBuilt = false) {
        const loaded = [];
        const missing = [];
        for (const repo of target.repos) {
            const graph = loadGraphCached(contextDirFor(repo.dir, this.cfg.contextDir));
            if (graph)
                loaded.push({ label: repo.label, dir: repo.dir, graph });
            else
                missing.push(repo.label);
        }
        if (requireBuilt && loaded.length === 0) {
            throw new Error(`no wiring graph found for workspace ${target.file} — run \`plexer build\` in its folders`);
        }
        return { loaded, missing };
    }
    #loadWorkspaceDirRepos(root, requireBuilt = false) {
        const wg = loadWorkspaceGraphs(root, this.cfg.contextDir);
        if (requireBuilt && wg.loaded.length === 0) {
            throw new Error(`no wiring graph found in workspace ${root} — run \`plexer build\` first`);
        }
        return {
            loaded: wg.loaded.map(({ child, graph }) => ({ label: child, dir: join(root, child), graph })),
            missing: wg.missing,
        };
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
    #askOne(target, query, opts) {
        if (target.kind === "single") {
            return ask(target.root, query, { ...opts, contextDir: this.cfg.contextDir });
        }
        if (target.kind === "workspace") {
            const res = federateAsk(target.root, this.cfg.contextDir, query, opts);
            return dedupeAskSeenPointers(res, opts.seenPointers, Boolean(opts.source));
        }
        const { loaded, missing } = this.#loadCodeWorkspaceRepos(target, false);
        const res = askAcrossRepos(loaded, missing, query, opts, this.cfg.contextDir);
        return dedupeAskSeenPointers(res, opts.seenPointers, Boolean(opts.source));
    }
    ask(dir, query, opts = {}) {
        const target = this.#resolveTarget(dir);
        if (Array.isArray(query)) {
            const seenPointers = opts.seenPointers ?? (opts.source ? new Set() : undefined);
            const batchOpts = seenPointers ? { ...opts, seenPointers } : opts;
            return query.map((q) => this.#askOne(target, String(q), batchOpts));
        }
        return this.#askOne(target, String(query), opts);
    }
    #skeletonOne(target, file, opts) {
        if (target.kind === "single") {
            return skeleton(target.root, file, { ...opts, contextDir: this.cfg.contextDir });
        }
        if (target.kind === "workspace") {
            return federateSkeleton(target.root, this.cfg.contextDir, file, opts);
        }
        const { loaded, missing } = this.#loadCodeWorkspaceRepos(target, false);
        return skeletonAcrossRepos(loaded, missing, file, opts, this.cfg.contextDir);
    }
    skeleton(dir, file, opts = {}) {
        const target = this.#resolveTarget(dir);
        if (Array.isArray(file)) {
            return file.map((f) => this.#skeletonOne(target, String(f), opts));
        }
        return this.#skeletonOne(target, String(file), opts);
    }
    read(dir, spans, opts = {}) {
        const target = this.#resolveTarget(dir);
        if (target.kind === "single") {
            return readSpans(target.root, spans, { ...opts, contextDir: this.cfg.contextDir });
        }
        if (target.kind === "workspace") {
            return federateRead(target.root, this.cfg.contextDir, spans, opts);
        }
        const { loaded, missing } = this.#loadCodeWorkspaceRepos(target, false);
        return readAcrossRepos(loaded, missing, spans, opts, this.cfg.contextDir);
    }
    blast(dir, opts = {}) {
        return blastRadius(dir, { ...opts, contextDir: this.cfg.contextDir });
    }
    #grepOne(target, pattern, opts) {
        if (target.kind === "single") {
            const { root, graph } = this.#requireGraph(target.root);
            return grepGraph(graph, root, pattern, opts);
        }
        if (target.kind === "workspace") {
            this.#loadWorkspaceDirRepos(target.root, true);
            return federateGrep(target.root, this.cfg.contextDir, pattern, opts).result;
        }
        const { loaded, missing } = this.#loadCodeWorkspaceRepos(target, true);
        return grepAcrossRepos(loaded, missing, pattern, opts);
    }
    grep(dir, pattern, opts = {}) {
        const target = this.#resolveTarget(dir);
        if (Array.isArray(pattern)) {
            return pattern.map((p) => this.#grepOne(target, String(p), opts));
        }
        return this.#grepOne(target, String(pattern), opts);
    }
    callers(dir, symbol, opts = {}) {
        const direction = opts.direction === "out" ? "out" : "in";
        const depth = parseWalkDepth(opts.depth, 1);
        if (Number.isNaN(depth))
            throw new RangeError("depth must be a positive integer or 'all'");
        const queries = Array.isArray(symbol)
            ? symbol.map((s) => String(s).trim()).filter(Boolean)
            : [symbol];
        if (queries.length === 0)
            return [];
        const target = this.#resolveTarget(dir);
        if (target.kind === "single") {
            const { graph } = this.#requireGraph(target.root);
            return callersInGraph(graph, queries, direction, depth, opts.in, opts.includeTests, null);
        }
        const { loaded, missing } = target.kind === "workspace"
            ? this.#loadWorkspaceDirRepos(target.root, true)
            : this.#loadCodeWorkspaceRepos(target, true);
        return callersAcrossRepos(loaded, missing, queries, direction, depth, opts);
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
export { buildGraph } from "./graph/build.js";
export { listSourceFiles } from "./graph/source-files.js";
export { checkGraph, formatGraphCheckReport } from "./graph/check.js";
export {
    readWorkspace,
    loadWorkspaceGraphs,
    federateAsk,
    federateSkeleton,
    federateGrep,
    federateCallers,
    federateRead,
    federateMap,
    federateCheck,
} from "./graph/workspace.js";
export { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans } from "./ask/ask.js";
export { grepGraph } from "./search/grep.js";
export { formatGrepResult, runGrepCommand } from "./search/grep-cli.js";
export { resolveSymbol } from "./context/symbol-query.js";
export { edgeWalk } from "./graph/traverse.js";
export { runCallersCommand } from "./graph/traverse-cli.js";
export { buildRepoMap, formatRepoMap } from "./graph/map.js";
export { blastRadius, blastRadiusIn } from "./blast/blast.js";
export { textReport, markdownReport, mermaidDiagram } from "./blast/render.js";
export { startVizServer } from "./viz/serve.js";
export { exportViz } from "./viz/export.js";
export { startMcpServer } from "./mcp/server.js";
export { health, healthAsync } from "./health/health.js";
export { formatHealthText, formatHealthMarkdown } from "./health/render.js";
