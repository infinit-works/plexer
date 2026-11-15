/**
 * `buildGraph` — build `plexer/.graph/wiring.json`, `.cache/ask-index.json`, and
 * per-file markdown cards from a code repository ($0, offline, deterministic).
 *
 * File parsing is memoized per file (`extract-cache.js`): a file whose bytes haven't
 * changed replays its last parse instead of re-running tree-sitter, so a rebuild
 * costs only the files that changed while producing output byte-identical to a
 * cold build.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { walkDir } from "../util/fs.js";
import { parseJsonc } from "../util/jsonc.js";
import { CACHE_DIR, contextDirFor, ensureGitignored, ensureSearchable, readGraph, wiringPath } from "../context/node-file.js";
import { contentHash, ensureMapSet, GENERIC_MEMBER_NAMES } from "../util/id.js";
import { relPosix, toPosixPath } from "../util/paths.js";
import { acquireLockIn, patchStats, readWalkConfig, releaseLockIn } from "../util/state.js";
import {
    emptyExtractCache,
    extractSourceFilesIncremental,
    extractorStamp,
    loadExtractCacheFiles,
    writeExtractCache,
    writeExtractCacheIncremental,
} from "./extract-cache.js";
import {
    collectResolverConfigPaths,
    isResolverConfigFilename,
    readFingerprint,
    snapshotDirMtimes,
    writeFingerprint,
} from "./fingerprint.js";
export { collectResolverConfigPaths, isResolverConfigFilename };
import { seedGraph } from "./seed.js";
import { filterByOnlyDirs, listSourceStats } from "./source-files.js";
import { resolveEdges } from "./resolve.js";
import { edgeOrder, writeGraph } from "./write.js";
import { writeCards, writeIndex } from "./cards.js";
import { computeMarkdownDocsDigest, writeAskIndex } from "../ask/index-file.js";
import { scopeOf } from "../context/scopes.js";
import { discoverScopes } from "./scope-discovery.js";
import { analyzeGitHistory } from "../util/git-history.js";
import {
    checkpointSqliteStore,
    cleanupLegacyCacheFiles,
    getSqliteMeta,
    openSqliteStore,
    prepareStmt,
    setSqliteMeta,
    withSqliteTransaction,
} from "../storage/sqlite-store.js";
const RESOLVER_SCHEMA_VERSION = "v2-untyped-member";
/** Minimum non-file node count for a discovered sub-scope to stand on its own.
 * A scope with fewer nodes than this is folded into the root scope. */
const MIN_SCOPE_NODES = 5;
/** Merge scopes with too few non-file nodes into the root scope, then
 * re-apply the canonical single-scope collapse if only root is left. */
function applyMinSubstanceGuard(scopes, nodes) {
    if (scopes.length <= 1)
        return scopes;
    const counts = new Map();
    for (const scope of scopes)
        counts.set(scope.prefix, 0);
    for (const node of nodes) {
        if (node.kind === "file")
            continue;
        const scope = scopeOf(node.path, scopes);
        counts.set(scope.prefix, (counts.get(scope.prefix) ?? 0) + 1);
    }
    const kept = scopes.filter((s) => s.prefix === "" || (counts.get(s.prefix) ?? 0) >= MIN_SCOPE_NODES);
    if (kept.length === 0)
        return [{ prefix: "", label: "", markers: [] }];
    if (kept.length === 1 && kept[0].prefix === "") {
        return [{ prefix: "", label: "", markers: kept[0].markers }];
    }
    return kept;
}
/** Every Go module in the repo: each `go.mod`'s declared `module` path and the repo
 * directory it lives in (posix, `.` for the root). Found anywhere in the tree, so a
 * monorepo whose module is in a subdir (e.g. `backend/go.mod`) resolves too. */
function readGoModules(root, repoFiles) {
    const mods = [];
    for (const f of repoFiles) {
        if (basename(f) !== "go.mod")
            continue;
        try {
            const m = readFileSync(f, "utf8").match(/^\s*module\s+(\S+)/m);
            if (!m)
                continue;
            const rel = relPosix(root, dirname(f));
            mods.push({ module: m[1], dir: rel === "" ? "." : rel });
        }
        catch {
            /* unreadable go.mod — skip this module */
        }
    }
    return mods;
}
function readTsConfigFile(filePath) {
    let parsed = null;
    try {
        parsed = parseJsonc(readFileSync(filePath, "utf8"));
    }
    catch {
        /* ignore invalid/unreadable tsconfig.json */
    }
    return parsed;
}
function resolveExtendedTsConfigPath(configFile, extRaw) {
    if (!extRaw.startsWith(".") && !extRaw.startsWith("/"))
        return null;
    const candidate = resolve(dirname(configFile), extRaw);
    try {
        if (existsSync(candidate) && statSync(candidate).isFile())
            return candidate;
    }
    catch {
        /* ignore stat errors */
    }
    if (existsSync(`${candidate}.json`))
        return `${candidate}.json`;
    const nested = join(candidate, "tsconfig.json");
    return existsSync(nested) ? nested : null;
}

const TS_CONFIG_PRIORITY = new Map([
    ["tsconfig.json", 0],
    ["tsconfig.app.json", 1],
    ["jsconfig.json", 2],
    [".jsconfig", 3],
    ["tsconfig.base.json", 4],
]);

function isTsOrJsConfigName(b) {
    return (
        b === ".jsconfig" ||
        /^(?:ts|js)config(?:\.[^/]+)?\.json$/i.test(b)
    );
}

function rebaseTsConfigPathsMap(pathsMap, absFromBase, absToBase) {
    if (!pathsMap || typeof pathsMap !== "object")
        return null;
    if (absFromBase === absToBase)
        return { ...pathsMap };
    const rebased = {};
    for (const [pattern, targets] of Object.entries(pathsMap)) {
        if (!Array.isArray(targets))
            continue;
        rebased[pattern] = targets.map((t) => {
            if (typeof t !== "string" || !t || t.startsWith("/") || t.includes("${"))
                return t;
            const trailingSlash = t.endsWith("/");
            const absTarget = resolve(absFromBase, t);
            let rel = relPosix(absToBase, absTarget) || ".";
            if (trailingSlash && rel !== "." && !rel.endsWith("/"))
                rel += "/";
            return rel;
        });
    }
    return rebased;
}

function resolveTsConfigChain(filePath, parsedCache, resolvedCache, visited = new Set()) {
    const abs = resolve(filePath);
    if (resolvedCache.has(abs))
        return resolvedCache.get(abs);
    if (visited.has(abs))
        return null;
    visited.add(abs);

    let parsed = parsedCache.get(abs);
    if (parsed === undefined) {
        parsed = readTsConfigFile(abs);
        parsedCache.set(abs, parsed);
    }
    if (!parsed || typeof parsed !== "object")
        return null;

    const extEntries = typeof parsed.extends === "string"
        ? [parsed.extends]
        : Array.isArray(parsed.extends)
            ? parsed.extends.filter((x) => typeof x === "string")
            : [];

    let inheritedBaseAbs = null;
    let inheritedPaths = null;
    let inheritedPathsBaseAbs = null;

    for (const extRaw of extEntries) {
        const extPath = resolveExtendedTsConfigPath(abs, extRaw);
        if (!extPath)
            continue;
        const parent = resolveTsConfigChain(extPath, parsedCache, resolvedCache, visited);
        if (!parent)
            continue;
        if (parent.absBaseUrl)
            inheritedBaseAbs = parent.absBaseUrl;
        if (parent.paths && typeof parent.paths === "object") {
            const targetBase = parent.absBaseUrl ?? dirname(resolve(extPath));
            if (!inheritedPaths) {
                inheritedPaths = { ...parent.paths };
                inheritedPathsBaseAbs = targetBase;
            }
            else {
                const targetAnchor = inheritedPathsBaseAbs ?? targetBase;
                const rebasedParent = rebaseTsConfigPathsMap(parent.paths, targetBase, targetAnchor);
                inheritedPaths = { ...inheritedPaths, ...rebasedParent };
            }
        }
    }

    visited.delete(abs);
    const ownBase = parsed.compilerOptions?.baseUrl;
    const absBaseUrl = typeof ownBase === "string"
        ? resolve(dirname(abs), ownBase)
        : inheritedBaseAbs;
    const effectivePathsAnchor = absBaseUrl ?? dirname(abs);

    let mergedPaths = inheritedPaths
        ? rebaseTsConfigPathsMap(inheritedPaths, inheritedPathsBaseAbs ?? dirname(abs), effectivePathsAnchor)
        : null;
    if (parsed.compilerOptions?.paths && typeof parsed.compilerOptions.paths === "object") {
        mergedPaths = mergedPaths
            ? { ...mergedPaths, ...parsed.compilerOptions.paths }
            : { ...parsed.compilerOptions.paths };
    }

    const result = {
        absBaseUrl,
        baseUrl: absBaseUrl ? (relPosix(dirname(abs), absBaseUrl) || ".") : null,
        paths: mergedPaths,
    };
    resolvedCache.set(abs, result);
    return result;
}

function readTsConfigs(root, repoFiles) {
    const configs = [];
    const seen = new Set();
    const candidates = [...repoFiles];
    for (const dotJsCfg of [join(root, ".jsconfig")]) {
        if (existsSync(dotJsCfg))
            candidates.push(dotJsCfg);
    }
    const parsedCache = new Map();
    const resolvedCache = new Map();

    for (const f of candidates) {
        const b = basename(f);
        if (!isTsOrJsConfigName(b))
            continue;
        const abs = resolve(f);
        if (seen.has(abs))
            continue;
        seen.add(abs);
        const resolvedCfg = resolveTsConfigChain(abs, parsedCache, resolvedCache);
        if (!resolvedCfg)
            continue;
        const dir = relPosix(root, dirname(abs));
        configs.push({
            dir,
            baseUrl: resolvedCfg.baseUrl,
            paths: resolvedCfg.paths,
            _priority: TS_CONFIG_PRIORITY.get(b) ?? 5,
            _name: b,
        });
    }
    configs.sort(
        (a, b) =>
            b.dir.length - a.dir.length ||
            a.dir.localeCompare(b.dir) ||
            a._priority - b._priority ||
            a._name.localeCompare(b._name)
    );
    return configs.map(({ dir, baseUrl, paths }) => ({ dir, baseUrl, paths }));
}
function readPackageConfigs(root, repoFiles) {
    const pkgs = [];
    for (const f of repoFiles) {
        if (basename(f) !== "package.json")
            continue;
        try {
            const parsed = JSON.parse(readFileSync(f, "utf8"));
            if (!parsed || typeof parsed !== "object")
                continue;
            const dir = relPosix(root, dirname(f));
            pkgs.push({
                dir,
                name: typeof parsed.name === "string" ? parsed.name : null,
                exports: parsed.exports ?? null,
                imports: parsed.imports ?? null,
            });
        }
        catch {
            /* ignore invalid/unreadable package.json */
        }
    }
    pkgs.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
    return pkgs;
}

export function resolverConfigHash(root, repoFiles, scopes, goModules) {
    const configFiles = [];
    const seen = new Set();
    for (const f of collectResolverConfigPaths(root, repoFiles, scopes)) {
        const rel = relPosix(root, f);
        if (seen.has(rel))
            continue;
        try {
            configFiles.push(`${rel}:${contentHash(readFileSync(f, "utf8"))}`);
            seen.add(rel);
        }
        catch {
            /* ignore absent/unreadable config */
        }
    }
    configFiles.sort();
    return contentHash(JSON.stringify({ schema: RESOLVER_SCHEMA_VERSION, scopes, goModules, configFiles }));
}

/** Recompute the canonical resolver `config_hash` for `dir` against an extracted node set. */
export function computeRepoConfigHash(dir, nodes, opts = {}) {
    const root = resolve(dir);
    const walkCfg = readWalkConfig(root, opts.contextDir);
    const walked = walkDir(root, walkCfg.includeDirs, {
        followSubmodules: walkCfg.followSubmodules,
        followNestedRepos: walkCfg.followNestedRepos,
    });
    const onlyDirs = opts.onlyDirs && opts.onlyDirs.size > 0 ? opts.onlyDirs : undefined;
    const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
    const discoveredScopes = discoverScopes(root, repoFiles, opts.contextDir);
    const scopes = applyMinSubstanceGuard(discoveredScopes, nodes);
    const goModules = readGoModules(root, walked);
    return resolverConfigHash(root, walked, scopes, goModules);
}

const CLASSLIKE_KINDS = new Set(["class", "interface", "trait", "struct"]);

function addSpecifierStemDepKeys(keys, specifier, prefix = "spec_stem:") {
    if (!specifier || typeof specifier !== "string")
        return;
    const clean = specifier.split(/[?#]/)[0].replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean)
        return;
    const noExt = clean.replace(/\.(?:js|cjs|mjs|ts|tsx|jsx|d\.ts|py|pyi|luau|lua|go|rs|java|cs|rb|php|kt|swift)$/i, "");
    const parts = noExt.split(/[/.]/).filter(Boolean);
    if (parts.length === 0)
        return;
    const last = parts[parts.length - 1].toLowerCase();
    if ((last === "index" || last === "init" || last === "mod") && parts.length >= 2) {
        const parent = parts[parts.length - 2].toLowerCase();
        keys.add(`${prefix}${parent}/${last}`);
        keys.add(`${prefix}${parent}`);
    }
    else {
        keys.add(`${prefix}${last}`);
    }
}

function addFilePathStemDepKeys(keys, filePath) {
    if (!filePath)
        return;
    const posixPath = toPosixPath(filePath);
    const noExt = posixPath.replace(/\.[^./]+$/, "");
    const parts = noExt.split("/").filter(Boolean);
    if (parts.length === 0)
        return;
    const last = parts[parts.length - 1].toLowerCase();
    if ((last === "index" || last === "init" || last === "mod") && parts.length >= 2) {
        const parent = parts[parts.length - 2].toLowerCase();
        keys.add(`spec_stem:${parent}/${last}`);
        keys.add(`spec_stem:${parent}`);
    }
    else {
        keys.add(`spec_stem:${last}`);
    }
}

function recordNodeSymbolDeps(n, depsByPath) {
    const s = ensureMapSet(depsByPath, n.path);
    if (n.path.endsWith(".go"))
        s.add(`dir:${posix.dirname(toPosixPath(n.path))}`);
    if (n.path.endsWith(".luau")) {
        s.add("lang:luau");
        const b = basename(n.path).toLowerCase();
        if (b === "init.luau" || b === "index.luau")
            s.add("luau_barrel");
    }
    if (CLASSLIKE_KINDS.has(n.kind) && n.name)
        s.add(`class:${n.name.toLowerCase()}`);
}

function recordRawEdgeSymbolDeps(e, depsByPath) {
    const p = e.file;
    const s = ensureMapSet(depsByPath, p);
    if (e.relation === "imports" || e.relation === "reexports") {
        if (e.relation === "reexports") {
            s.add(`barrel:${p}`);
            if (p.endsWith(".luau"))
                s.add("luau_barrel");
        }
        if (e.specifier)
            addSpecifierStemDepKeys(s, e.specifier);
        if (e.fallbackSpecifier)
            addSpecifierStemDepKeys(s, e.fallbackSpecifier);
    }
    if (!e.name)
        return;
    const lower = e.name.toLowerCase();
    if (e.relation === "extends" || e.relation === "implements") {
        s.add(`sym:${lower}`);
        s.add(`impl_of:${lower}`);
    }
    else if (e.recvType) {
        const rt = e.recvType.toLowerCase();
        s.add(`type_user:${rt}`);
        s.add(`sym:${rt}`);
        if (!GENERIC_MEMBER_NAMES.has(lower))
            s.add(`sym:${lower}`);
    }
    else if (!e.viaMember || (lower.length >= 4 && !GENERIC_MEMBER_NAMES.has(lower))) {
        s.add(`sym:${lower}`);
    }
}

function buildSymbolDepsByPath(nodes, rawEdges, resolvedEdges, targetPaths = null) {
    const nodeById = new Map();
    const depsByPath = new Map();
    for (const n of nodes) {
        nodeById.set(n.id, n);
        if (!targetPaths || targetPaths.has(n.path))
            recordNodeSymbolDeps(n, depsByPath);
    }
    for (const e of rawEdges) {
        if (e.file && (!targetPaths || targetPaths.has(e.file)))
            recordRawEdgeSymbolDeps(e, depsByPath);
    }
    for (const e of resolvedEdges) {
        const src = nodeById.get(e.source);
        const tgt = nodeById.get(e.target);
        if (!src?.path || !tgt?.path || src.path === tgt.path)
            continue;
        if (targetPaths && !targetPaths.has(src.path))
            continue;
        ensureMapSet(depsByPath, src.path).add(`file:${tgt.path}`);
    }
    return depsByPath;
}

function querySymbolDepSources(store, depKeys) {
    const out = new Set();
    const list = [...depKeys];
    const CHUNK = 250;
    for (let off = 0; off < list.length; off += CHUNK) {
        const slice = list.slice(off, off + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const rows = store.db
            .prepare(`SELECT DISTINCT source_path FROM symbol_deps WHERE dep_key IN (${placeholders})`)
            .all(...slice);
        for (const r of rows) {
            out.add(r.source_path);
        }
    }
    return out;
}

function querySymbolDepKeysForSources(store, sourcePaths) {
    const bySource = new Map();
    const list = [...sourcePaths];
    const CHUNK = 250;
    for (let off = 0; off < list.length; off += CHUNK) {
        const slice = list.slice(off, off + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const rows = store.db
            .prepare(`SELECT source_path, dep_key FROM symbol_deps WHERE source_path IN (${placeholders})`)
            .all(...slice);
        for (const r of rows) {
            let s = bySource.get(r.source_path);
            if (!s) {
                s = new Set();
                bySource.set(r.source_path, s);
            }
            s.add(r.dep_key);
        }
    }
    return bySource;
}

function recordNodeSeedKeys(n, seedKeys) {
    if (!n)
        return false;
    const isLuau = Boolean(n.path?.endsWith(".luau"));
    if (n.kind === "file" || !n.name)
        return isLuau;
    const lower = n.name.toLowerCase();
    seedKeys.add(`sym:${lower}`);
    const sepIdx = Math.max(lower.lastIndexOf("."), lower.lastIndexOf(":"), lower.lastIndexOf("#"));
    if (sepIdx >= 0)
        seedKeys.add(`sym:${lower.slice(sepIdx + 1)}`);
    if (n.owner)
        seedKeys.add(`type_user:${n.owner.toLowerCase()}`);
    if (CLASSLIKE_KINDS.has(n.kind)) {
        seedKeys.add(`type_user:${lower}`);
        seedKeys.add(`impl_of:${lower}`);
    }
    return isLuau;
}

function collectInitialDirtySeedKeys(dirtyOrDeleted, priorNodes, dirtyNodes, dirtyEntries, seedKeys) {
    let touchesLuau = false;
    for (const p of dirtyOrDeleted) {
        seedKeys.add(`file:${p}`);
        if (p.endsWith(".go"))
            seedKeys.add(`dir:${posix.dirname(toPosixPath(p))}`);
        if (p.endsWith(".luau"))
            touchesLuau = true;
        addFilePathStemDepKeys(seedKeys, p);
    }
    for (const n of priorNodes) {
        if (dirtyOrDeleted.has(n.path) && recordNodeSeedKeys(n, seedKeys))
            touchesLuau = true;
    }
    for (const n of dirtyNodes) {
        if (recordNodeSeedKeys(n, seedKeys))
            touchesLuau = true;
    }
    for (const entry of Object.values(dirtyEntries)) {
        for (const e of entry?.rawEdges ?? []) {
            if ((e.relation === "extends" || e.relation === "implements") && e.name)
                seedKeys.add(`type_user:${e.name.toLowerCase()}`);
        }
    }
    return touchesLuau;
}

function expandBarrelConeHops(store, initialFrontier, dirtyOrDeleted, currentPathSet, conePaths) {
    let frontier = initialFrontier;
    const visitedBarrels = new Set(dirtyOrDeleted);
    for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
        const depMap = querySymbolDepKeysForSources(store, frontier);
        const nextKeys = new Set();
        for (const [src, keys] of depMap) {
            if (visitedBarrels.has(src))
                continue;
            if (keys.has(`barrel:${src}`) || keys.has("luau_barrel")) {
                visitedBarrels.add(src);
                nextKeys.add(`file:${src}`);
            }
        }
        if (nextKeys.size === 0)
            break;
        const nextFrontier = [];
        for (const depSrc of querySymbolDepSources(store, nextKeys)) {
            if (currentPathSet.has(depSrc) && !conePaths.has(depSrc)) {
                conePaths.add(depSrc);
                nextFrontier.push(depSrc);
            }
        }
        frontier = nextFrontier;
    }
}

function addContextPathCandidate(target, currentPathSet, expandedCtx, contextPaths, nextFrontier) {
    if (currentPathSet.has(target) && !expandedCtx.has(target)) {
        expandedCtx.add(target);
        contextPaths.add(target);
        nextFrontier.add(target);
    }
}

function stepContextFrontierHop(store, ctxFrontier, currentPathSet, expandedCtx, contextPaths) {
    const depMap = querySymbolDepKeysForSources(store, ctxFrontier);
    const classLookupKeys = new Set();
    const nextFrontier = new Set();
    let foundLuau = false;
    for (const [src, keys] of depMap) {
        if (src.endsWith(".luau"))
            foundLuau = true;
        for (const k of keys) {
            if (k.startsWith("file:")) {
                addContextPathCandidate(k.slice(5), currentPathSet, expandedCtx, contextPaths, nextFrontier);
            }
            else if (k.startsWith("impl_of:") || k.startsWith("type_user:")) {
                const cls = k.slice(k.indexOf(":") + 1);
                classLookupKeys.add(`class:${cls}`);
                classLookupKeys.add(`impl_of:${cls}`);
            }
        }
    }
    if (classLookupKeys.size > 0) {
        for (const clsPath of querySymbolDepSources(store, classLookupKeys))
            addContextPathCandidate(clsPath, currentPathSet, expandedCtx, contextPaths, nextFrontier);
    }
    return { nextFrontier, foundLuau };
}

function computeDirtyConeAndContext(store, dirtyPaths, deletedPaths, priorNodes, dirtyNodes, dirtyEntries, currentPathSet) {
    const dirtyOrDeleted = new Set([...dirtyPaths, ...deletedPaths]);
    const conePaths = new Set(dirtyPaths);
    const seedKeys = new Set();
    let touchesLuau = collectInitialDirtySeedKeys(dirtyOrDeleted, priorNodes, dirtyNodes, dirtyEntries, seedKeys);

    // 1-hop dependents (+ propagate through re-export barrels up to 3 hops so barrel chains stay sound)
    const barrelFrontier = [];
    for (const src of querySymbolDepSources(store, seedKeys)) {
        if (!currentPathSet.has(src))
            continue;
        conePaths.add(src);
        barrelFrontier.push(src);
    }
    if (barrelFrontier.length > 0)
        expandBarrelConeHops(store, barrelFrontier, dirtyOrDeleted, currentPathSet, conePaths);

    // Expand contextPaths for buildResolutionIndex (transitive imports/reexports + class ancestors + luau)
    const contextPaths = new Set(conePaths);
    let ctxFrontier = new Set(conePaths);
    const expandedCtx = new Set(conePaths);
    for (let hop = 0; hop < 4 && ctxFrontier.size > 0; hop++) {
        const step = stepContextFrontierHop(store, ctxFrontier, currentPathSet, expandedCtx, contextPaths);
        if (step.foundLuau)
            touchesLuau = true;
        ctxFrontier = step.nextFrontier;
    }

    if (touchesLuau) {
        for (const luauFile of querySymbolDepSources(store, ["lang:luau"])) {
            if (currentPathSet.has(luauFile))
                contextPaths.add(luauFile);
        }
    }
    return { conePaths, contextPaths };
}

function updateSymbolDepsInTx(store, depsByPath, replaceAll, deletePaths = []) {
    if (replaceAll) {
        store.db.exec("DELETE FROM symbol_deps");
    }
    else {
        const delStmt = prepareStmt(store, "DELETE FROM symbol_deps WHERE source_path = ?");
        for (const p of deletePaths)
            delStmt.run(p);
        for (const p of depsByPath.keys())
            delStmt.run(p);
    }
    const insStmt = prepareStmt(store, "INSERT OR IGNORE INTO symbol_deps(source_path, dep_key) VALUES (?, ?)");
    for (const [src, keys] of depsByPath) {
        for (const k of keys)
            insStmt.run(src, k);
    }
    setSqliteMeta(store, "symbol_deps_ready", "1");
}
function finalizeGraphBuildOutput(root, outDir, opts, graph, nodes, edges, sortedLanguages) {
    let cardStats = { written: 0, pruned: 0, files: [] };
    if (!opts.graphOnly) {
        ensureGitignored(root, outDir);
        if (opts.cards === true) {
            ensureSearchable(root, outDir);
            cardStats = writeCards(graph, outDir);
            writeIndex(outDir, cardStats.files, graph);
        }
        else {
            const filePaths = [...new Set(nodes.map((n) => n.path).filter(Boolean))].sort();
            writeIndex(outDir, filePaths, graph);
        }
        if (!opts.contextDir) {
            patchStats(root, {
                dirty: false,
                staleCount: 0,
                syncing: false,
                syncedAt: new Date().toISOString(),
                nodeCount: nodes.length,
                edgeCount: edges.length,
                languages: sortedLanguages,
                totalCount: nodes.length,
            });
            if (existsSync(join(root, ".git")) && !existsSync(join(outDir, CACHE_DIR, "git-history.json"))) {
                try {
                    analyzeGitHistory(root, outDir);
                }
                catch {
                    /* best-effort co-change cache warm */
                }
            }
        }
    }
    const byKind = {};
    for (const n of nodes)
        byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const byRelation = {};
    for (const e of edges)
        byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;
    return { cardsWritten: cardStats.written, byKind, byRelation };
}
function readBuildDbMeta(sqliteStore) {
    try {
        return {
            vocabReady: Boolean(getSqliteMeta(sqliteStore, "vocab_json")),
            depsReady: getSqliteMeta(sqliteStore, "symbol_deps_ready") === "1",
            stampMatch: getSqliteMeta(sqliteStore, "extractor_stamp") === (extractorStamp() ?? ""),
            docsHash: getSqliteMeta(sqliteStore, "docs_hash"),
        };
    }
    catch {
        return { vocabReady: false, depsReady: false, stampMatch: false, docsHash: null };
    }
}

function runUnchangedSqliteBuild(ctx) {
    const { prior, outDir, root, docsDirty, mtimeDirty, mtimeUpdates, configHash, configFilesForFp, onlyDirs, extensions, preWalkDirMtimes, errors } = ctx;
    if (docsDirty) {
        try {
            writeAskIndex(outDir, prior, { dirtyPaths: [], deletedPaths: [], root });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (mtimeDirty && mtimeUpdates.length > 0)
        writeExtractCacheIncremental(outDir, { updateStats: mtimeUpdates });
    const existingFp = readFingerprint(outDir);
    const fpStale =
        mtimeDirty ||
        docsDirty ||
        !existingFp?.dirs ||
        !existingFp?.docs ||
        existingFp?.configHash !== configHash ||
        JSON.stringify(existingFp?.extensions ?? []) !== JSON.stringify(extensions ?? []);
    if (fpStale) {
        writeFingerprint(outDir, null, onlyDirs, root, extensions, preWalkDirMtimes, {
            configFiles: configFilesForFp,
            configHash,
        });
    }
    return { nodes: prior.nodes, edges: prior.edges, graph: prior, graphPath: wiringPath(outDir) };
}

function buildConeResolvedGraph(ctx, conePaths, contextPaths, dirtyPlusDeleted) {
    const { outDir, prior, extractRes, dirtyPaths, deletedPaths, goModules, root, scopes, tsConfigs, packageConfigs, sortedLanguages, configHash } = ctx;
    const contextToLoad = [];
    for (const p of contextPaths) {
        if (!dirtyPaths.has(p))
            contextToLoad.push(p);
    }
    const loadedContext = loadExtractCacheFiles(outDir, contextToLoad);
    const subsetRawEdges = [...extractRes.rawEdges];
    for (const entry of loadedContext.values())
        subsetRawEdges.push(...(entry.rawEdges ?? []));

    const nodes = [...prior.nodes.filter((n) => !dirtyPlusDeleted.has(n.path)), ...extractRes.nodes];
    const resolvedSubset = resolveEdges(nodes, subsetRawEdges, { goModules, root, scopes, tsConfigs, packageConfigs });
    const coneNodeIds = new Set(nodes.filter((n) => conePaths.has(n.path)).map((n) => n.id));
    const deletedSet = new Set(deletedPaths);
    const deletedNodeIds = new Set(prior.nodes.filter((n) => deletedSet.has(n.path)).map((n) => n.id));
    const newConeEdges = resolvedSubset.filter((e) => coneNodeIds.has(e.source));
    const edges = [
        ...prior.edges.filter((e) => !coneNodeIds.has(e.source) && !deletedNodeIds.has(e.source) && !deletedNodeIds.has(e.target)),
        ...newConeEdges,
    ].sort(edgeOrder);

    const graph = {
        meta: {
            version: 1,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            languages: sortedLanguages,
            scopes,
            config_hash: configHash,
        },
        nodes,
        edges,
    };
    return { nodes, edges, graph, subsetRawEdges, newConeEdges };
}

function tryBuildDirtyConePath(ctx) {
    const { sqliteStore, dirtyPaths, deletedPaths, prior, extractRes, currentPathSet, files, outDir, mtimeUpdates, configHash, root, onlyDirs, extensions, preWalkDirMtimes, configFilesForFp, errors } = ctx;
    const dirtyPlusDeleted = new Set([...dirtyPaths, ...deletedPaths]);
    const canDirtyCone =
        ctx.reuse !== false &&
        !ctx.seedFrom &&
        extractRes.mode === "sqlite" &&
        prior !== null &&
        prior.meta?.config_hash === configHash &&
        ctx.dbMeta.depsReady &&
        ctx.dbMeta.stampMatch &&
        dirtyPlusDeleted.size > 0 &&
        dirtyPlusDeleted.size <= Math.max(4, Math.floor(files.length * 0.75));
    if (!canDirtyCone)
        return null;

    const { conePaths, contextPaths } = computeDirtyConeAndContext(
        sqliteStore, dirtyPaths, deletedPaths, prior.nodes, extractRes.nodes, extractRes.entries, currentPathSet,
    );
    if (conePaths.size > Math.max(8, Math.floor(files.length * 0.75)))
        return null;

    const { nodes, edges, graph, subsetRawEdges, newConeEdges } = buildConeResolvedGraph(ctx, conePaths, contextPaths, dirtyPlusDeleted);
    const graphPath = writeGraph(graph, outDir);
    const coneDeps = buildSymbolDepsByPath(nodes, subsetRawEdges, newConeEdges, conePaths);
    withSqliteTransaction(sqliteStore, () => {
        writeExtractCacheIncremental(outDir, { upsertEntries: extractRes.entries, updateStats: mtimeUpdates, deletePaths: deletedPaths });
        updateSymbolDepsInTx(sqliteStore, coneDeps, false, deletedPaths);
        setSqliteMeta(sqliteStore, "config_hash", configHash);
        try {
            writeAskIndex(outDir, graph, { dirtyPaths, deletedPaths, root });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    checkpointSqliteStore(outDir, "PASSIVE");
    cleanupLegacyCacheFiles(outDir);
    writeFingerprint(outDir, null, onlyDirs, root, extensions, preWalkDirMtimes, { configFiles: configFilesForFp, configHash });
    return { nodes, edges, graph, graphPath };
}

function collectFullBuildInputs(outDir, extractRes, cleanPaths) {
    if (extractRes.mode !== "sqlite")
        return { nodes: extractRes.nodes, fullRawEdges: extractRes.rawEdges, fullEntries: extractRes.entries };
    const cleanMap = loadExtractCacheFiles(outDir, [...cleanPaths]);
    const nodes = [...extractRes.nodes];
    const fullRawEdges = [...extractRes.rawEdges];
    const fullEntries = { ...extractRes.entries };
    for (const [rel, entry] of cleanMap) {
        nodes.push(...(entry.nodes ?? []));
        fullRawEdges.push(...(entry.rawEdges ?? []));
        fullEntries[rel] = entry;
    }
    return { nodes, fullRawEdges, fullEntries };
}

function runFullResolutionBuildPath(ctx) {
    const { outDir, extractRes, cleanPaths, discoveredScopes, root, walked, goModules, tsConfigs, packageConfigs, sortedLanguages, sqliteStore, dbMeta, dirtyPaths, deletedPaths, onlyDirs, extensions, preWalkDirMtimes, errors } = ctx;
    const { nodes, fullRawEdges, fullEntries } = collectFullBuildInputs(outDir, extractRes, cleanPaths);
    const finalScopes = applyMinSubstanceGuard(discoveredScopes, nodes);
    const finalConfigHash = resolverConfigHash(root, walked, finalScopes, goModules);
    const edges = resolveEdges(nodes, fullRawEdges, { goModules, root, scopes: finalScopes, tsConfigs, packageConfigs });
    const graph = {
        meta: {
            version: 1,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            languages: sortedLanguages,
            scopes: finalScopes,
            config_hash: finalConfigHash,
        },
        nodes,
        edges,
    };
    const graphPath = writeGraph(graph, outDir);
    const allDeps = buildSymbolDepsByPath(nodes, fullRawEdges, edges);
    withSqliteTransaction(sqliteStore, () => {
        writeExtractCache(outDir, { ...emptyExtractCache(), files: fullEntries });
        updateSymbolDepsInTx(sqliteStore, allDeps, true);
        setSqliteMeta(sqliteStore, "config_hash", finalConfigHash);
        try {
            writeAskIndex(outDir, graph, {
                dirtyPaths: extractRes.mode === "sqlite" && dbMeta.vocabReady ? dirtyPaths : undefined,
                deletedPaths: extractRes.mode === "sqlite" && dbMeta.vocabReady ? deletedPaths : undefined,
                root,
            });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    checkpointSqliteStore(outDir, "PASSIVE");
    cleanupLegacyCacheFiles(outDir);
    writeFingerprint(outDir, fullEntries, onlyDirs, root, extensions, preWalkDirMtimes, {
        configFiles: collectResolverConfigPaths(root, walked, finalScopes),
        configHash: finalConfigHash,
    });
    return { nodes, edges, graph, graphPath };
}

export async function buildGraph(dir, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const lockCache = join(outDir, CACHE_DIR);
    const acquiredLock = opts._lockHeld ? false : acquireLockIn(lockCache);
    try {
        const preWalkDirMtimes = snapshotDirMtimes(root, outDir);
        const walkCfg = readWalkConfig(root, opts.contextDir);
        const walked = walkDir(root, walkCfg.includeDirs, {
            followSubmodules: walkCfg.followSubmodules,
            followNestedRepos: walkCfg.followNestedRepos,
        });
        const onlyDirs = opts.onlyDirs && opts.onlyDirs.length > 0 ? new Set(opts.onlyDirs) : undefined;
        const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
        const files = listSourceStats(root, outDir, repoFiles, undefined, opts.extensions);
        const currentPathSet = new Set(files.map((f) => f.rel));
        const discoveredScopes = discoverScopes(root, repoFiles, opts.contextDir);
        const seed = opts.reuse === false ? { seeded: false } : seedGraph(root, { contextDir: opts.contextDir });

        const extractRes = await extractSourceFilesIncremental(files, outDir, {
            reuse: opts.reuse,
            onProgress: opts.onProgress,
        });
        const { langs, errors, parsed, reused, mtimeDirty, dirtyPaths, deletedPaths, cleanPaths, mtimeUpdates } = extractRes;
        const sortedLanguages = [...langs].sort();
        const prior = (opts.reuse === false || Boolean(seed.from)) ? null : readGraph(wiringPath(outDir));

        const sqliteStore = openSqliteStore(outDir, { create: true });
        const dbMeta = readBuildDbMeta(sqliteStore);
        const docsDirty = dbMeta.docsHash !== computeMarkdownDocsDigest(root);
        const scopeNodes = extractRes.mode === "sqlite"
            ? [...(prior?.nodes ?? []).filter((n) => !dirtyPaths.has(n.path) && !deletedPaths.includes(n.path)), ...extractRes.nodes]
            : extractRes.nodes;
        const scopes = applyMinSubstanceGuard(discoveredScopes, scopeNodes);
        const goModules = readGoModules(root, walked);
        const tsConfigs = readTsConfigs(root, walked);
        const packageConfigs = readPackageConfigs(root, walked);
        const configFilesForFp = collectResolverConfigPaths(root, walked, scopes);
        const configHash = resolverConfigHash(root, walked, scopes, goModules);

        const isSqliteUnchanged =
            opts.reuse !== false &&
            !seed.from &&
            extractRes.mode === "sqlite" &&
            parsed === 0 &&
            deletedPaths.length === 0 &&
            dbMeta.vocabReady &&
            dbMeta.depsReady &&
            prior !== null &&
            prior.meta?.config_hash === configHash;

        const buildCtx = {
            root, outDir, walked, files, currentPathSet, discoveredScopes, scopes,
            goModules, tsConfigs, packageConfigs, configFilesForFp, configHash,
            preWalkDirMtimes, extractRes, sortedLanguages, prior, sqliteStore, dbMeta,
            docsDirty, mtimeDirty, dirtyPaths, deletedPaths, cleanPaths, mtimeUpdates,
            reuse: opts.reuse, seedFrom: seed.from, onlyDirs: opts.onlyDirs, extensions: opts.extensions, errors,
        };

        const built = isSqliteUnchanged
            ? runUnchangedSqliteBuild(buildCtx)
            : (tryBuildDirtyConePath(buildCtx) ?? runFullResolutionBuildPath(buildCtx));

        const { cardsWritten, byKind, byRelation } = finalizeGraphBuildOutput(
            root, outDir, opts, built.graph, built.nodes, built.edges, sortedLanguages,
        );
        return {
            contextDir: outDir,
            graphPath: built.graphPath,
            cards: cardsWritten,
            files: files.length,
            parsed,
            reused,
            seededFrom: seed.from,
            nodes: built.nodes.length,
            edges: built.edges.length,
            byKind,
            byRelation,
            languages: sortedLanguages,
            errors,
        };
    }
    finally {
        if (acquiredLock)
            releaseLockIn(lockCache);
    }
}
