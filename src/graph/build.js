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
import { registerExternalNodesLookup, registerGraphCacheClearer } from "../context/graph-store.js";
import { contentHash, ensureMapSet, GENERIC_MEMBER_NAMES } from "../util/id.js";
import { isDependencyPath, pathUnderPrefix, relPosix, toPosixPath } from "../util/paths.js";
import { acquireLockIn, patchStats, readJson, readWalkConfig, releaseLockIn, resolveGitExcludePath } from "../util/state.js";
import {
    emptyExtractCache,
    extractSourceFilesIncremental,
    extractorStamp,
    loadExtractCacheFiles,
    syncExtractStatsRevision,
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
import { compareUtf16, edgeOrder, writeGraphStreaming } from "./write.js";
import { writeCards, writeIndex } from "./cards.js";
import { collectMarkdownDocFiles, writeAskIndex } from "../ask/index-file.js";
import { scopeOf } from "../context/scopes.js";
import { discoverScopes } from "./scope-discovery.js";
import { analyzeGitHistory } from "../util/git-history.js";
import {
    checkpointSqliteStore,
    cleanupLegacyCacheFiles,
    createBatchInserter,
    getSqliteMeta,
    openSqliteStore,
    prepareStmt,
    readGraphCountsFromSqlite,
    readGraphEdgesFromSqlite,
    readGraphMetaFromSqlite,
    readGraphNodesFromSqlite,
    setSqliteMeta,
    setSqliteMetaMany,
    updateGraphConeInSqlite,
    withSqliteTransaction,
    writeGraphToSqlite,
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
function parseGoReplaces(text) {
    const replaces = [];
    let inReplace = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/\/\/.*$/, "").trim();
        if (!line)
            continue;
        if (/^replace\s*\($/.test(line)) {
            inReplace = true;
            continue;
        }
        if (inReplace && line === ")") {
            inReplace = false;
            continue;
        }
        const m = (inReplace ? line : line.replace(/^replace\s+/, "")).match(/^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/);
        if ((inReplace || /^replace\s+/.test(line)) && m && (m[2].startsWith(".") || m[2].startsWith("/"))) {
            replaces.push({ old: m[1], local: m[2] });
        }
    }
    return replaces;
}
function readGoModules(root, repoFiles) {
    const mods = [];
    const workReplaces = [];
    for (const f of repoFiles) {
        if (basename(f) !== "go.work")
            continue;
        try {
            workReplaces.push(...parseGoReplaces(readFileSync(f, "utf8")));
        }
        catch {
            /* skip unreadable go.work */
        }
    }
    for (const f of repoFiles) {
        if (basename(f) !== "go.mod")
            continue;
        try {
            const raw = readFileSync(f, "utf8");
            const m = raw.match(/^\s*module\s+(\S+)/m);
            if (!m)
                continue;
            const rel = relPosix(root, dirname(f));
            const replaces = [...parseGoReplaces(raw), ...workReplaces];
            mods.push({ module: m[1], dir: rel === "" ? "." : rel, ...(replaces.length ? { replaces } : {}) });
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
            compareUtf16(a.dir, b.dir) ||
            a._priority - b._priority ||
            compareUtf16(a._name, b._name)
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
                main: typeof parsed.main === "string" ? parsed.main : null,
                module: typeof parsed.module === "string" ? parsed.module : null,
                types: typeof parsed.types === "string" ? parsed.types : (typeof parsed.typings === "string" ? parsed.typings : null),
                exports: parsed.exports ?? null,
                imports: parsed.imports ?? null,
            });
        }
        catch {
            /* ignore invalid/unreadable package.json */
        }
    }
    pkgs.sort((a, b) => b.dir.length - a.dir.length || compareUtf16(a.dir, b.dir));
    return pkgs;
}
function readEcosystemManifests(root, repoFiles) {
    const cargoCrates = new Map();
    const composerPsr4 = [];
    const pythonRoots = [];
    const swiftTargets = new Map();
    const dartPackages = new Map();
    const foundryRemappings = [];
    for (const f of repoFiles) {
        const b = basename(f);
        const dirRel = relPosix(root, dirname(f));
        const dirPrefix = dirRel === "." || dirRel === "" ? "" : dirRel;
        try {
            if (b === "Cargo.toml") {
                const raw = readFileSync(f, "utf8");
                const pkgSec = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(raw)?.[1] ?? "";
                const nameM = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pkgSec);
                if (nameM)
                    cargoCrates.set(nameM[1].replace(/-/g, "_"), dirPrefix ? `${dirPrefix}/src` : "src");
            }
            else if (b === "composer.json") {
                const parsed = JSON.parse(readFileSync(f, "utf8"));
                for (const sec of [parsed?.autoload?.["psr-4"], parsed?.["autoload-dev"]?.["psr-4"]]) {
                    if (!sec || typeof sec !== "object")
                        continue;
                    for (const [ns, relDir] of Object.entries(sec)) {
                        const firstDir = Array.isArray(relDir) ? relDir[0] : relDir;
                        if (typeof firstDir === "string") {
                            const fullDir = dirPrefix ? `${dirPrefix}/${firstDir.replace(/^\.\//, "")}` : firstDir.replace(/^\.\//, "");
                            composerPsr4.push({ prefix: ns, dir: fullDir });
                        }
                    }
                }
            }
            else if (b === "pyproject.toml") {
                const raw = readFileSync(f, "utf8");
                for (const key of ["pythonpath", "where"]) {
                    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(raw);
                    if (m) {
                        for (const s of m[1].matchAll(/["']([^"']+)["']/g)) {
                            const sub = s[1].replace(/^\.\//, "");
                            pythonRoots.push(dirPrefix ? `${dirPrefix}/${sub}` : sub);
                        }
                    }
                }
                for (const fm of raw.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) {
                    const sub = fm[1].replace(/^\.\//, "");
                    pythonRoots.push(dirPrefix ? `${dirPrefix}/${sub}` : sub);
                }
            }
            else if (b === "Package.swift") {
                const raw = readFileSync(f, "utf8");
                for (const tm of raw.matchAll(/\.(?:executableT|t)arget\s*\(\s*name\s*:\s*"([^"]+)"([^)]*)\)/g)) {
                    const name = tm[1];
                    const pathM = /path\s*:\s*"([^"]+)"/.exec(tm[2]);
                    const relT = pathM ? pathM[1] : `Sources/${name}`;
                    swiftTargets.set(name, dirPrefix ? `${dirPrefix}/${relT}` : relT);
                }
            }
            else if (b === "pubspec.yaml") {
                const raw = readFileSync(f, "utf8");
                const m = /^\s*name\s*:\s*([A-Za-z0-9_]+)\s*$/m.exec(raw);
                if (m)
                    dartPackages.set(m[1], dirPrefix || ".");
            }
            else if (b === "remappings.txt") {
                for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
                    const eq = line.indexOf("=");
                    if (eq > 0) {
                        const prefix = line.slice(0, eq).trim();
                        const target = line.slice(eq + 1).trim();
                        if (prefix && target)
                            foundryRemappings.push({ prefix, target: dirPrefix ? `${dirPrefix}/${target}` : target });
                    }
                }
            }
            else if (b === "foundry.toml") {
                const m = /^\s*remappings\s*=\s*\[([^\]]*)\]/m.exec(readFileSync(f, "utf8"));
                if (m) {
                    for (const s of m[1].matchAll(/["']([^"'=]+)=([^"']+)["']/g))
                        foundryRemappings.push({ prefix: s[1].trim(), target: dirPrefix ? `${dirPrefix}/${s[2].trim()}` : s[2].trim() });
                }
            }
        }
        catch {
            /* skip unreadable manifest */
        }
    }
    composerPsr4.sort((a, b) => b.prefix.length - a.prefix.length);
    return { cargoCrates, composerPsr4, pythonRoots: [...new Set(pythonRoots)], swiftTargets, dartPackages, foundryRemappings };
}

function readResolverConfigBundle(root, repoFiles, scopes, outDir = null, priorBundle = null) {
    const absRoot = resolve(root);
    const configFiles = collectResolverConfigPaths(absRoot, repoFiles, scopes, outDir);
    const configContents = new Map(priorBundle?.configContents ?? []);
    const configSnapshots = { ...(priorBundle?.configSnapshots ?? {}) };
    const excludeRaw = resolveGitExcludePath(absRoot);
    const excludeAbs = excludeRaw ? resolve(excludeRaw) : null;
    const seen = new Set();
    const hashParts = [];

    for (const f of configFiles) {
        const abs = resolve(f);
        const rel = excludeAbs && abs === excludeAbs ? ".git/info/exclude" : relPosix(absRoot, abs);
        if (!rel || seen.has(rel))
            continue;
        try {
            let raw = configContents.get(abs);
            let snap = configSnapshots[rel];
            if (raw === undefined || !snap) {
                const st = statSync(abs);
                if (!st.isFile())
                    continue;
                raw = readFileSync(abs, "utf8");
                const hash = contentHash(raw);
                configContents.set(abs, raw);
                snap = [st.size, st.mtimeMs, hash];
                if (rel === ".git/info/exclude" || !rel.startsWith("..")) {
                    configSnapshots[rel] = snap;
                }
            }
            hashParts.push(`${rel}:${snap[2]}`);
            seen.add(rel);
        }
        catch {
            /* ignore absent/unreadable config */
        }
    }
    hashParts.sort(compareUtf16);
    return { configFiles, configContents, configSnapshots, hashParts };
}

function readMarkdownDocsBundle(root, includeDocs) {
    const absRoot = resolve(root);
    const mdFiles = collectMarkdownDocFiles(absRoot);
    const docSnapshots = {};
    const markdownDocs = [];
    const hashItems = [];
    for (const { relPath, absPath } of mdFiles) {
        try {
            const st = statSync(absPath);
            if (!st.isFile())
                continue;
            const raw = readFileSync(absPath, "utf8");
            const hash = contentHash(raw);
            docSnapshots[relPath] = [st.size, st.mtimeMs, hash];
            if (includeDocs !== false) {
                hashItems.push([relPath, hash]);
                markdownDocs.push({ relPath, absPath, content: raw, hash });
            }
        }
        catch {
            /* ignore unreadable doc */
        }
    }
    const docsDigest = includeDocs === false
        ? "disabled"
        : hashItems.length === 0
            ? "empty"
            : contentHash(hashItems.map(([rel, hash]) => `${rel}\0${hash}`).join("\n"));
    return { docsDigest, docSnapshots, markdownDocs };
}

export function resolverConfigHash(root, repoFiles, scopes, goModules, opts = {}) {
    const bundle = opts.bundle ?? readResolverConfigBundle(root, repoFiles, scopes, opts.outDir);
    return contentHash(JSON.stringify({ schema: RESOLVER_SCHEMA_VERSION, scopes, goModules, configFiles: bundle.hashParts }));
}

/** Recompute the canonical resolver `config_hash` for `dir` against an extracted node set. */
export function computeRepoConfigHash(dir, nodes, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    let walked = opts.walked;
    if (!Array.isArray(walked)) {
        const walkCfg = readWalkConfig(root, opts.contextDir);
        walked = walkDir(root, walkCfg.includeDirs, {
            followSubmodules: walkCfg.followSubmodules,
            followNestedRepos: walkCfg.followNestedRepos,
        });
    }
    const onlyDirs = opts.onlyDirs && opts.onlyDirs.size > 0 ? opts.onlyDirs : undefined;
    const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
    const discoveredScopes = discoverScopes(root, repoFiles, opts.contextDir);
    const scopes = applyMinSubstanceGuard(discoveredScopes, nodes);
    const goModules = readGoModules(root, walked);
    return resolverConfigHash(root, walked, scopes, goModules, { outDir });
}

const CLASSLIKE_KINDS = new Set(["class", "interface", "trait", "struct"]);
const SUPPORTED_STEM_EXT_RE = /\.(?:d\.(?:ts|mts|cts)|tsx|jsx|mts|cts|ts|mjs|cjs|js|pyi|py|go|java|kt|kts|swift|php|r|rs|c|h|cpp|cc|cxx|hpp|hh|hxx|h\+\+|c\+\+|inl|ipp|tpp|ixx|rb|cs|scala|sc|ex|exs|sol|ml|mli|zig|dart|clj|cljs|cljc|bb|nix|lua|luau|vue|svelte|astro|sh|bash|zsh|sql|tf|tfvars|hcl|proto|graphql|gql|m|mm|hs|gleam|cu|cuh)$/i;

function addSpecifierStemDepKeys(keys, specifier, prefix = "spec_stem:", sourceFile = null) {
    if (!specifier || typeof specifier !== "string")
        return;
    let clean = specifier.split(/[?#]/)[0].replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean)
        return;
    const isRelPath = clean === "." || clean === ".." || clean.startsWith("./") || clean.startsWith("../");
    if (isRelPath && sourceFile) {
        const baseDir = posix.dirname(toPosixPath(sourceFile));
        const joined = baseDir === "." ? clean : `${baseDir}/${clean}`;
        clean = posix.normalize(joined).replace(/\/+$/, "");
        if (!clean || clean === "." || clean === "..") {
            for (const barrel of ["index", "__init__", "init", "mod"]) {
                keys.add(`spec_rel:${barrel}`);
            }
            return;
        }
        const relNoExt = clean.replace(SUPPORTED_STEM_EXT_RE, "").replace(/^\.\//, "").toLowerCase();
        if (!relNoExt)
            return;
        keys.add(`spec_rel:${relNoExt}`);
        const slash = relNoExt.lastIndexOf("/");
        const leaf = slash >= 0 ? relNoExt.slice(slash + 1) : relNoExt;
        if (slash > 0 && (leaf === "index" || leaf === "__init__" || leaf === "init" || leaf === "mod")) {
            keys.add(`spec_rel:${relNoExt.slice(0, slash)}`);
        }
        return;
    }
    const noExt = clean.replace(SUPPORTED_STEM_EXT_RE, "");
    const parts = noExt.split("/").filter(Boolean);
    if (parts.length === 0)
        return;
    const last = parts[parts.length - 1].toLowerCase();
    if ((last === "index" || last === "__init__" || last === "init" || last === "mod") && parts.length >= 2) {
        const parent = parts[parts.length - 2].toLowerCase();
        keys.add(`${prefix}${parent}/${last}`);
        keys.add(`${prefix}${parent}`);
    }
    else {
        keys.add(`${prefix}${last}`);
    }
    if (!clean.includes("/") && !isRelPath && noExt.includes(".")) {
        const dotTail = noExt.replace(/^\.+/, "").split(".").filter(Boolean).pop()?.toLowerCase();
        if (dotTail && dotTail !== last) {
            keys.add(`${prefix}${dotTail}`);
        }
    }
}

function addFilePathStemDepKeys(keys, filePath) {
    if (!filePath)
        return;
    const posixPath = toPosixPath(filePath);
    const noExt = posixPath.replace(SUPPORTED_STEM_EXT_RE, "").replace(/\.[^./]+$/, "");
    const relNoExt = noExt.replace(/^\.\//, "").toLowerCase();
    if (relNoExt)
        keys.add(`spec_rel:${relNoExt}`);
    const parts = noExt.split("/").filter(Boolean);
    if (parts.length === 0)
        return;
    const last = parts[parts.length - 1].toLowerCase();
    if ((last === "index" || last === "__init__" || last === "init" || last === "mod") && parts.length >= 2) {
        const parent = parts[parts.length - 2].toLowerCase();
        keys.add(`spec_rel:${parts.slice(0, -1).join("/").toLowerCase()}`);
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
    if (n.path.endsWith(".luau") || n.luauMode) {
        s.add("lang:luau");
        const b = basename(n.path).toLowerCase();
        if (b === "init.luau" || b === "index.luau" || b === "init.lua")
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
            if (p.endsWith(".luau") || p.endsWith(".lua"))
                s.add("luau_barrel");
        }
        if (e.specifier)
            addSpecifierStemDepKeys(s, e.specifier, "spec_stem:", p);
        if (e.fallbackSpecifier)
            addSpecifierStemDepKeys(s, e.fallbackSpecifier, "spec_stem:", p);
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

function buildSymbolDepsByPath(nodes, rawEdges, resolvedEdges, targetPaths = null, nodePathById = null) {
    const pathById = nodePathById ?? new Map();
    const depsByPath = new Map();
    for (const n of nodes) {
        if (!nodePathById)
            pathById.set(n.id, n.path ?? "");
        if (!targetPaths || targetPaths.has(n.path))
            recordNodeSymbolDeps(n, depsByPath);
    }
    for (const e of rawEdges) {
        if (e.file && (!targetPaths || targetPaths.has(e.file)))
            recordRawEdgeSymbolDeps(e, depsByPath);
    }
    for (const e of resolvedEdges) {
        const srcPath = pathById.get(e.source);
        const tgtPath = pathById.get(e.target);
        if (!srcPath || !tgtPath || srcPath === tgtPath)
            continue;
        if (targetPaths && !targetPaths.has(srcPath))
            continue;
        ensureMapSet(depsByPath, srcPath).add(`file:${tgtPath}`);
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
    const isLuau = Boolean(n.path?.endsWith(".luau") || n.luauMode);
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

function collectInitialDirtySeedKeys(store, dirtyOrDeleted, priorNodes, dirtyNodes, dirtyEntries, seedKeys) {
    let touchesLuau = false;
    for (const p of dirtyOrDeleted) {
        seedKeys.add(`file:${p}`);
        if (p.endsWith(".go"))
            seedKeys.add(`dir:${posix.dirname(toPosixPath(p))}`);
        if (p.endsWith(".luau") || p.endsWith(".lua"))
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
    if (dirtyOrDeleted.size > 0) {
        for (const keys of querySymbolDepKeysForSources(store, dirtyOrDeleted).values()) {
            for (const k of keys) {
                if (k.startsWith("impl_of:")) {
                    seedKeys.add(`type_user:${k.slice("impl_of:".length)}`);
                }
            }
        }
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
    for (let hop = 0; hop < 6 && frontier.length > 0; hop++) {
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
        if (src.endsWith(".luau") || keys.has("lang:luau"))
            foundLuau = true;
        for (const k of keys) {
            if (k.startsWith("file:")) {
                addContextPathCandidate(k.slice(5), currentPathSet, expandedCtx, contextPaths, nextFrontier);
            }
            else if (k.startsWith("impl_of:") || k.startsWith("type_user:") || k.startsWith("class:")) {
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
    let touchesLuau = collectInitialDirtySeedKeys(store, dirtyOrDeleted, priorNodes, dirtyNodes, dirtyEntries, seedKeys);

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
    for (let hop = 0; hop < 6 && ctxFrontier.size > 0; hop++) {
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
        store.db.exec("DROP INDEX IF EXISTS idx_symbol_deps_dep; DELETE FROM symbol_deps;");
    }
    else {
        const delStmt = prepareStmt(store, "DELETE FROM symbol_deps WHERE source_path = ?");
        for (const p of deletePaths)
            delStmt.run(p);
        for (const p of depsByPath.keys())
            delStmt.run(p);
    }
    const batch = createBatchInserter(store, "INSERT OR IGNORE INTO symbol_deps(source_path, dep_key)", 2, 128);
    for (const [src, keys] of depsByPath) {
        for (const k of keys)
            batch.push(src, k);
    }
    batch.flush();
    if (replaceAll) {
        store.db.exec("CREATE INDEX IF NOT EXISTS idx_symbol_deps_dep ON symbol_deps(dep_key);");
    }
    setSqliteMeta(store, "symbol_deps_ready", "1");
}
function finalizeGraphBuildOutput(root, outDir, opts, built, sortedLanguages) {
    const { graph, nodes, edges } = built;
    let cardStats = { written: 0, pruned: 0, files: [] };
    if (!opts.graphOnly) {
        if (opts.cards === true) {
            ensureSearchable(root, outDir);
            cardStats = writeCards(graph, outDir);
            writeIndex(outDir, cardStats.files, graph);
        }
        else {
            const countsByPath = new Map();
            for (const n of nodes) {
                if (!n?.path)
                    continue;
                if (!countsByPath.has(n.path))
                    countsByPath.set(n.path, 0);
                if (n.kind !== "file")
                    countsByPath.set(n.path, countsByPath.get(n.path) + 1);
            }
            const fileStats = [...countsByPath.entries()]
                .sort((a, b) => compareUtf16(a[0], b[0]))
                .map(([path, symbols]) => ({ path, symbols }));
            writeIndex(outDir, fileStats, graph);
        }
        if (!opts.contextDir) {
            patchStats(root, {
                dirty: false,
                staleCount: 0,
                syncing: false,
                syncedAt: new Date().toISOString(),
                nodeCount: built.nodeCount ?? nodes.length,
                edgeCount: built.edgeCount ?? (edges?.length ?? 0),
                languages: sortedLanguages,
                totalCount: built.nodeCount ?? nodes.length,
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
    if (built.byKind && built.byRelation) {
        return { cardsWritten: cardStats.written, byKind: built.byKind, byRelation: built.byRelation };
    }
    const byKind = {};
    for (const n of nodes)
        byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    const byRelation = {};
    for (const e of edges ?? [])
        byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1;
    return { cardsWritten: cardStats.written, byKind, byRelation };
}
const MAX_PRIOR_NODES_CACHE = 1;
const priorNodesCache = new Map();
const MAX_RESOLVED_ENV_CACHE = 2;
const resolvedEnvCache = new Map();
registerGraphCacheClearer((outDir, opts) => {
    if (opts?.keepPriorNodes)
        return;
    if (outDir !== undefined && outDir !== null) {
        const k = resolve(outDir);
        priorNodesCache.delete(k);
        resolvedEnvCache.delete(k);
    }
    else {
        priorNodesCache.clear();
        resolvedEnvCache.clear();
    }
});

function buildNodePathMap(nodes) {
    const m = new Map();
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        m.set(n.id, n.path ?? "");
    }
    return m;
}

function setCachedPriorNodes(outDir, graphVersion, nodes, nodePathById = null) {
    const key = resolve(outDir);
    if (!priorNodesCache.has(key) && priorNodesCache.size >= MAX_PRIOR_NODES_CACHE) {
        const oldest = priorNodesCache.keys().next().value;
        if (oldest !== undefined)
            priorNodesCache.delete(oldest);
    }
    priorNodesCache.delete(key);
    priorNodesCache.set(key, { graphVersion, nodes, nodePathById: nodePathById ?? buildNodePathMap(nodes) });
}

function getCachedPriorNodes(outDir, sqliteStore, graphVersion) {
    const key = resolve(outDir);
    const cached = priorNodesCache.get(key);
    if (cached && cached.graphVersion === graphVersion) {
        priorNodesCache.delete(key);
        priorNodesCache.set(key, cached);
        return { nodes: cached.nodes, nodePathById: cached.nodePathById };
    }
    const nodes = readGraphNodesFromSqlite(sqliteStore);
    const nodePathById = buildNodePathMap(nodes);
    setCachedPriorNodes(key, graphVersion, nodes, nodePathById);
    return { nodes, nodePathById };
}

registerExternalNodesLookup((absDir, graphVersion) => {
    const cached = priorNodesCache.get(absDir);
    return cached && cached.graphVersion === graphVersion ? cached.nodes : null;
});

function setCachedResolvedEnv(outDir, env) {
    const key = resolve(outDir);
    if (!resolvedEnvCache.has(key) && resolvedEnvCache.size >= MAX_RESOLVED_ENV_CACHE) {
        const oldest = resolvedEnvCache.keys().next().value;
        if (oldest !== undefined)
            resolvedEnvCache.delete(oldest);
    }
    resolvedEnvCache.delete(key);
    resolvedEnvCache.set(key, env);
}

function readBuildDbMeta(sqliteStore) {
    try {
        return {
            vocabReady: getSqliteMeta(sqliteStore, "vocab_ready") === "1" || Boolean(getSqliteMeta(sqliteStore, "vocab_json")),
            depsReady: getSqliteMeta(sqliteStore, "symbol_deps_ready") === "1",
            stampMatch: getSqliteMeta(sqliteStore, "extractor_stamp") === (extractorStamp() ?? ""),
            docsHash: getSqliteMeta(sqliteStore, "docs_hash"),
            graphHash: getSqliteMeta(sqliteStore, "graph_hash"),
            graphVersion: Number(getSqliteMeta(sqliteStore, "graph_version") ?? 0),
            wiringDirty: getSqliteMeta(sqliteStore, "wiring_dirty") === "1",
            legacyCleaned: getSqliteMeta(sqliteStore, "legacy_cleaned") === "1",
        };
    }
    catch {
        return {
            vocabReady: false,
            depsReady: false,
            stampMatch: false,
            docsHash: null,
            graphHash: null,
            graphVersion: 0,
            wiringDirty: false,
            legacyCleaned: false,
        };
    }
}

function wiringDiskMatchesHash(outDir, dbGraphHash) {
    if (!dbGraphHash)
        return false;
    try {
        return contentHash(readFileSync(wiringPath(outDir), "utf8")) === dbGraphHash;
    }
    catch {
        return false;
    }
}

function buildInMemoryFingerprintEntries(existingFp, upserts, mtimeUpdates, deletedPaths) {
    if (!existingFp?.files || typeof existingFp.files !== "object")
        return null;
    const out = { ...existingFp.files };
    for (const del of deletedPaths ?? []) {
        delete out[del];
    }
    for (const u of mtimeUpdates ?? []) {
        if (u?.rel)
            out[u.rel] = [u.size ?? 0, u.mtimeMs ?? 0, u.hash ?? ""];
    }
    for (const [rel, entry] of Object.entries(upserts ?? {})) {
        if (entry)
            out[rel] = [entry.size ?? 0, entry.mtimeMs ?? 0, entry.hash ?? ""];
    }
    return out;
}

function runUnchangedSqliteBuild(ctx) {
    const { prior, sqliteStore, dbMeta, graphOnly, outDir, root, docsDirty, mtimeDirty, mtimeUpdates, configHash, configBundle, docsBundle, onlyDirs, extensions, preWalkDirMtimes, errors } = ctx;
    if (!graphOnly && prior.edges === null) {
        prior.edges = readGraphEdgesFromSqlite(sqliteStore) ?? [];
    }
    if (docsDirty) {
        if (prior.edges === null)
            prior.edges = [];
        try {
            writeAskIndex(outDir, prior, {
                dirtyPaths: [],
                deletedPaths: [],
                root,
                alreadySorted: true,
                docsDigest: docsBundle.docsDigest,
                markdownDocs: docsBundle.markdownDocs,
            });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (mtimeDirty && mtimeUpdates.length > 0)
        writeExtractCacheIncremental(outDir, { updateStats: mtimeUpdates });
    if (!graphOnly && (dbMeta.wiringDirty || !wiringDiskMatchesHash(outDir, dbMeta.graphHash))) {
        const graphHash = writeGraphStreaming(prior, outDir, { alreadySorted: true });
        withSqliteTransaction(sqliteStore, () => {
            setSqliteMetaMany(sqliteStore, { wiring_dirty: "0", graph_hash: graphHash });
        });
        checkpointSqliteStore(outDir, "PASSIVE");
    }
    const existingFp = readFingerprint(outDir);
    const fpStale =
        mtimeDirty ||
        docsDirty ||
        !existingFp?.dirs ||
        !existingFp?.docs ||
        existingFp?.configHash !== configHash ||
        JSON.stringify(existingFp?.extensions ?? []) !== JSON.stringify(extensions ?? []);
    if (fpStale) {
        const fpEntries = buildInMemoryFingerprintEntries(existingFp, null, mtimeUpdates, null);
        writeFingerprint(outDir, fpEntries, onlyDirs, root, extensions, preWalkDirMtimes, {
            configFiles: configBundle.configFiles,
            configContents: configBundle.configContents,
            configSnapshots: configBundle.configSnapshots,
            docSnapshots: docsBundle.docSnapshots,
            configHash,
        });
    }
    if (prior.edges === null) {
        const counts = readGraphCountsFromSqlite(sqliteStore);
        return {
            nodes: prior.nodes,
            edges: null,
            nodeCount: counts.nodeCount,
            edgeCount: counts.edgeCount,
            byKind: counts.byKind,
            byRelation: counts.byRelation,
            graph: prior,
            graphPath: wiringPath(outDir),
        };
    }
    return { nodes: prior.nodes, edges: prior.edges, graph: prior, graphPath: wiringPath(outDir) };
}

function isDependencyNodePath(relPath, depPrefixes) {
    if (!relPath)
        return false;
    if (isDependencyPath(relPath))
        return true;
    return Boolean(depPrefixes?.some((p) => pathUnderPrefix(relPath, p)));
}

function stampDependencyNodes(nodes, manifestMounts) {
    const depPrefixes = manifestMounts?.dependencyPrefixes;
    for (const n of nodes) {
        if (isDependencyNodePath(n.path, depPrefixes)) {
            n.dependency = true;
        }
        else if (n.dependency !== undefined) {
            delete n.dependency;
        }
    }
}

function buildManifestMountsMeta(manifestMounts) {
    const combined = [
        ...(manifestMounts?.includePrefixes ?? []),
        ...(manifestMounts?.exactFiles ?? []),
    ];
    if (combined.length === 0)
        return undefined;
    return [...new Set(combined)].sort(compareUtf16);
}

function mergeSortedNodes(priorNodes, dirtyPlusDeleted, sortedDirtyNodes) {
    const nDirty = sortedDirtyNodes.length;
    const out = [];
    let j = 0;
    for (let i = 0; i < priorNodes.length; i++) {
        const pn = priorNodes[i];
        if (dirtyPlusDeleted.has(pn.path))
            continue;
        while (j < nDirty && compareUtf16(sortedDirtyNodes[j].id, pn.id) <= 0) {
            out.push(sortedDirtyNodes[j++]);
        }
        out.push(pn);
    }
    while (j < nDirty)
        out.push(sortedDirtyNodes[j++]);
    return out;
}

function sameStringArray(a, b) {
    if (a === b)
        return true;
    const la = a?.length ?? 0;
    const lb = b?.length ?? 0;
    if (la !== lb)
        return false;
    for (let i = 0; i < la; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}

function buildConeResolvedGraph(ctx, conePaths, contextPaths, dirtyPlusDeleted, includeFullEdges = true) {
    const { sqliteStore, outDir, prior, extractRes, dirtyPaths, deletedPaths, goModules, root, scopes, tsConfigs, packageConfigs, ecoManifests, configBundle, sortedLanguages, configHash, manifestMounts } = ctx;
    const contextToLoad = [];
    for (const p of contextPaths) {
        if (!dirtyPaths.has(p))
            contextToLoad.push(p);
    }
    const loadedContext = loadExtractCacheFiles(outDir, contextToLoad);
    const subsetRawEdges = [...extractRes.rawEdges];
    for (const entry of loadedContext.values())
        subsetRawEdges.push(...(entry.rawEdges ?? []));

    const mountsMeta = buildManifestMountsMeta(manifestMounts);
    const sortedDirty = [...extractRes.nodes].sort((a, b) => compareUtf16(a.id, b.id));
    let nodes;
    if (sameStringArray(mountsMeta, prior.meta?.manifestMounts)) {
        stampDependencyNodes(sortedDirty, manifestMounts);
        nodes = mergeSortedNodes(prior.nodes, dirtyPlusDeleted, sortedDirty);
    }
    else {
        nodes = mergeSortedNodes(prior.nodes, dirtyPlusDeleted, sortedDirty);
        stampDependencyNodes(nodes, manifestMounts);
    }
    const skipLuau = !sortedLanguages.some((l) => /lua/i.test(l)) && !sortedDirty.some((n) => n.path?.endsWith(".luau") || n.path?.endsWith(".lua") || n.luauMode);
    const resolvedSubset = resolveEdges(nodes, subsetRawEdges, {
        goModules, root, scopes, tsConfigs, packageConfigs, configFiles: configBundle?.configFiles,
        dependencyPrefixes: manifestMounts?.dependencyPrefixes,
        coneOnly: true,
        contextPaths,
        skipLuau,
        ...ecoManifests,
    });
    const deletedSet = new Set(deletedPaths);
    const priorConeNodeIds = new Set();
    const removedNodeIds = new Set();
    const prevTouchedNodes = [];
    const dirtyNewIdSet = new Set(sortedDirty.map((n) => n.id));
    for (let i = 0; i < prior.nodes.length; i++) {
        const n = prior.nodes[i];
        const inCone = conePaths.has(n.path);
        const isDel = deletedSet.has(n.path);
        const isDirtyPath = dirtyPaths.has(n.path);
        if (inCone || isDel)
            priorConeNodeIds.add(n.id);
        if (isDel || isDirtyPath) {
            prevTouchedNodes.push(n);
            if (!dirtyNewIdSet.has(n.id))
                removedNodeIds.add(n.id);
        }
    }
    const coneNodeIds = new Set();
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (conePaths.has(n.path))
            coneNodeIds.add(n.id);
    }
    const newConeEdges = resolvedSubset.filter((e) => coneNodeIds.has(e.source));
    let edges = null;
    if (includeFullEdges) {
        if (prior.edges === null)
            prior.edges = readGraphEdgesFromSqlite(sqliteStore) ?? [];
        edges = [
            ...prior.edges.filter((e) => !priorConeNodeIds.has(e.source) && !removedNodeIds.has(e.target)),
            ...newConeEdges,
        ].sort(edgeOrder);
    }

    const graph = {
        meta: {
            version: 1,
            nodeCount: nodes.length,
            edgeCount: edges ? edges.length : (prior.meta?.edgeCount ?? 0),
            languages: sortedLanguages,
            scopes,
            config_hash: configHash,
            ...(mountsMeta ? { manifestMounts: mountsMeta } : {}),
        },
        nodes,
        edges: edges ?? [],
    };
    return { nodes, edges, graph, subsetRawEdges, newConeEdges, removedNodeIds, sortedDirty, prevTouchedNodes };
}

function tryBuildDirtyConePath(ctx) {
    const { sqliteStore, graphOnly, skipAggregateCounts, dirtyPaths, deletedPaths, prior, extractRes, currentPathSet, files, outDir, mtimeUpdates, configHash, root, onlyDirs, extensions, preWalkDirMtimes, configBundle, docsBundle, errors } = ctx;
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

    const sqlOnlyFast = Boolean(graphOnly && dirtyPaths.size <= 32 && ctx.dbMeta.vocabReady);
    const { nodes, edges, graph, subsetRawEdges, newConeEdges, removedNodeIds, sortedDirty, prevTouchedNodes } = buildConeResolvedGraph(
        ctx,
        conePaths,
        contextPaths,
        dirtyPlusDeleted,
        !sqlOnlyFast,
    );
    const nextNodePathById = prior.nodePathById ?? buildNodePathMap(nodes);
    if (prior.nodePathById) {
        for (const id of removedNodeIds)
            nextNodePathById.delete(id);
        for (const n of sortedDirty)
            nextNodePathById.set(n.id, n.path ?? "");
    }
    const coneDeps = buildSymbolDepsByPath(nodes, subsetRawEdges, newConeEdges, conePaths, nextNodePathById);
    let fastCounts = null;
    let nextGraphVersion = ctx.dbMeta.graphVersion;
    withSqliteTransaction(sqliteStore, () => {
        writeExtractCacheIncremental(outDir, { upsertEntries: extractRes.entries, updateStats: mtimeUpdates, deletePaths: deletedPaths });
        updateSymbolDepsInTx(sqliteStore, coneDeps, false, deletedPaths);
        nextGraphVersion = updateGraphConeInSqlite(sqliteStore, {
            meta: graph.meta,
            allNodes: nodes,
            dirtyNodes: sortedDirty,
            nodePathById: nextNodePathById,
            dirtyPaths,
            deletedPaths,
            conePaths,
            newConeEdges,
            removedNodeIds,
            trackEdgeDelta: sqlOnlyFast && Boolean(skipAggregateCounts),
        });
        if (sqlOnlyFast && !skipAggregateCounts) {
            fastCounts = readGraphCountsFromSqlite(sqliteStore);
            graph.meta.edgeCount = fastCounts.edgeCount;
            setSqliteMeta(sqliteStore, "graph_meta_json", JSON.stringify(graph.meta));
        }
        setSqliteMetaMany(sqliteStore, {
            config_hash: configHash,
            wiring_dirty: "1",
            graph_hash: "",
            rojo_lua_mode: ctx.manifestMounts?.hasRojoProject ? "1" : "0",
        });
        try {
            writeAskIndex(outDir, graph, {
                dirtyPaths,
                deletedPaths,
                dirtyNodes: sortedDirty,
                prevTouchedNodes,
                root,
                alreadySorted: true,
                docsDigest: docsBundle.docsDigest,
                markdownDocs: docsBundle.markdownDocs,
            });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    if (!graphOnly) {
        const graphHash = writeGraphStreaming(graph, outDir, { alreadySorted: true });
        withSqliteTransaction(sqliteStore, () => {
            setSqliteMetaMany(sqliteStore, { wiring_dirty: "0", graph_hash: graphHash });
        });
    }
    checkpointSqliteStore(outDir, "PASSIVE");
    if (!ctx.dbMeta.legacyCleaned) {
        cleanupLegacyCacheFiles(outDir);
        withSqliteTransaction(sqliteStore, () => setSqliteMeta(sqliteStore, "legacy_cleaned", "1"));
    }
    syncExtractStatsRevision(outDir);
    const existingFp = readFingerprint(outDir);
    const fpEntries = buildInMemoryFingerprintEntries(existingFp, extractRes.entries, mtimeUpdates, deletedPaths);
    writeFingerprint(outDir, fpEntries, onlyDirs, root, extensions, preWalkDirMtimes, {
        configFiles: configBundle.configFiles,
        configContents: configBundle.configContents,
        configSnapshots: configBundle.configSnapshots,
        docSnapshots: docsBundle.docSnapshots,
        configHash,
    });
    const graphPath = wiringPath(outDir);
    setCachedPriorNodes(outDir, nextGraphVersion, nodes, nextNodePathById);
    setCachedResolvedEnv(outDir, {
        graphVersion: nextGraphVersion,
        discoveredScopes: ctx.discoveredScopes,
        scopes: ctx.scopes,
        goModules: ctx.goModules,
        tsConfigs: ctx.tsConfigs,
        packageConfigs: ctx.packageConfigs,
        ecoManifests: ctx.ecoManifests,
        configBundle: ctx.configBundle,
        docsBundle: ctx.docsBundle,
        configHash,
    });
    if (sqlOnlyFast) {
        return {
            nodes,
            edges: null,
            nodeCount: fastCounts?.nodeCount ?? nodes.length,
            edgeCount: fastCounts?.edgeCount ?? graph.meta.edgeCount,
            byKind: fastCounts?.byKind ?? {},
            byRelation: fastCounts?.byRelation ?? {},
            graph,
            graphPath,
        };
    }
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
    const { outDir, graphOnly, extractRes, cleanPaths, discoveredScopes, root, walked, goModules, tsConfigs, packageConfigs, ecoManifests, configBundle, docsBundle, sortedLanguages, sqliteStore, dbMeta, dirtyPaths, deletedPaths, onlyDirs, extensions, preWalkDirMtimes, manifestMounts, errors } = ctx;
    const { nodes: rawNodes, fullRawEdges, fullEntries } = collectFullBuildInputs(outDir, extractRes, cleanPaths);
    const nodes = [...rawNodes].sort((a, b) => compareUtf16(a.id, b.id));
    stampDependencyNodes(nodes, manifestMounts);
    const finalScopes = applyMinSubstanceGuard(discoveredScopes, nodes);
    const finalBundle = readResolverConfigBundle(root, walked, finalScopes, outDir, configBundle);
    const finalConfigHash = resolverConfigHash(root, walked, finalScopes, goModules, { bundle: finalBundle, outDir });
    const edges = resolveEdges(nodes, fullRawEdges, {
        goModules, root, scopes: finalScopes, tsConfigs, packageConfigs, configFiles: finalBundle.configFiles,
        dependencyPrefixes: manifestMounts?.dependencyPrefixes,
        ...ecoManifests,
    }).sort(edgeOrder);
    const mountsMeta = buildManifestMountsMeta(manifestMounts);
    const graph = {
        meta: {
            version: 1,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            languages: sortedLanguages,
            scopes: finalScopes,
            config_hash: finalConfigHash,
            ...(mountsMeta ? { manifestMounts: mountsMeta } : {}),
        },
        nodes,
        edges,
    };
    const allDeps = buildSymbolDepsByPath(nodes, fullRawEdges, edges);
    fullRawEdges.length = 0;
    const compactFpEntries = {};
    for (const [rel, entry] of Object.entries(fullEntries)) {
        if (entry)
            compactFpEntries[rel] = [entry.size ?? 0, entry.mtimeMs ?? 0, entry.hash ?? ""];
    }
    let nextGraphVersion = dbMeta.graphVersion;
    withSqliteTransaction(sqliteStore, () => {
        updateSymbolDepsInTx(sqliteStore, allDeps, true);
        allDeps.clear();
        try {
            writeAskIndex(outDir, graph, {
                dirtyPaths: extractRes.mode === "sqlite" && dbMeta.vocabReady ? dirtyPaths : undefined,
                deletedPaths: extractRes.mode === "sqlite" && dbMeta.vocabReady ? deletedPaths : undefined,
                root,
                alreadySorted: true,
                docsDigest: docsBundle.docsDigest,
                markdownDocs: docsBundle.markdownDocs,
            });
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
        writeExtractCache(outDir, { ...emptyExtractCache(), files: fullEntries });
        fullRawEdges.length = 0;
        for (const k of Object.keys(fullEntries))
            delete fullEntries[k];
        nextGraphVersion = writeGraphToSqlite(sqliteStore, graph);
        setSqliteMetaMany(sqliteStore, {
            config_hash: finalConfigHash,
            wiring_dirty: "1",
            graph_hash: "",
            rojo_lua_mode: manifestMounts?.hasRojoProject ? "1" : "0",
        });
    });
    const graphPath = wiringPath(outDir);
    setCachedPriorNodes(outDir, nextGraphVersion, nodes);
    setCachedResolvedEnv(outDir, {
        graphVersion: nextGraphVersion,
        discoveredScopes,
        scopes: finalScopes,
        goModules,
        tsConfigs,
        packageConfigs,
        ecoManifests,
        configBundle: finalBundle,
        docsBundle,
        configHash: finalConfigHash,
    });
    if (!graphOnly) {
        const graphHash = writeGraphStreaming(graph, outDir, { alreadySorted: true });
        withSqliteTransaction(sqliteStore, () => {
            setSqliteMetaMany(sqliteStore, { wiring_dirty: "0", graph_hash: graphHash });
        });
    }
    checkpointSqliteStore(outDir, "PASSIVE");
    if (!dbMeta.legacyCleaned) {
        cleanupLegacyCacheFiles(outDir);
        withSqliteTransaction(sqliteStore, () => setSqliteMeta(sqliteStore, "legacy_cleaned", "1"));
    }
    syncExtractStatsRevision(outDir);
    writeFingerprint(outDir, compactFpEntries, onlyDirs, root, extensions, preWalkDirMtimes, {
        configFiles: finalBundle.configFiles,
        configContents: finalBundle.configContents,
        configSnapshots: finalBundle.configSnapshots,
        docSnapshots: docsBundle.docSnapshots,
        configHash: finalConfigHash,
    });
    return { nodes, edges, graph, graphPath };
}

async function waitForBuildLock(cache, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (acquireLockIn(cache))
            return true;
        if (Date.now() >= deadline)
            return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}

export async function buildGraph(dir, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const lockCache = join(outDir, CACHE_DIR);
    const lockHolderPid = readJson(join(lockCache, ".sync.lock"))?.pid;
    const heldBySelf = Boolean(opts._lockHeld) || lockHolderPid === process.pid;
    const acquiredLock = heldBySelf ? false : await waitForBuildLock(lockCache, opts.lockTimeoutMs ?? 5000);
    if (!heldBySelf && !acquiredLock) {
        throw new Error(`timed out waiting for graph build lock: ${lockCache}`);
    }
    try {
        const preWalkDirMtimes = opts.dirMtimes && typeof opts.dirMtimes === "object"
            ? opts.dirMtimes
            : snapshotDirMtimes(root, outDir);
        const walkCfg = readWalkConfig(root, opts.contextDir);
        const walked = Array.isArray(opts.walked)
            ? opts.walked
            : walkDir(root, walkCfg.includeDirs, {
                followSubmodules: walkCfg.followSubmodules,
                followNestedRepos: walkCfg.followNestedRepos,
            });
        const onlyDirs = opts.onlyDirs && opts.onlyDirs.length > 0 ? new Set(opts.onlyDirs) : undefined;
        const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
        const files = Array.isArray(opts.sourceStats)
            ? opts.sourceStats
            : listSourceStats(root, outDir, repoFiles, undefined, opts.extensions);
        const currentPathSet = new Set(files.map((f) => f.rel));
        const seed = opts.reuse === false ? { seeded: false } : seedGraph(root, { contextDir: opts.contextDir });
        if (!opts.graphOnly) {
            ensureGitignored(root, outDir);
        }

        const extractRes = await extractSourceFilesIncremental(files, outDir, {
            reuse: opts.reuse,
            onProgress: opts.onProgress,
            hasRojoProject: walkCfg.manifestMounts?.hasRojoProject,
            rojoMountPrefixes: walkCfg.manifestMounts?.rojoMountPrefixes,
        });
        const { langs, errors, parsed, reused, mtimeDirty, dirtyPaths, deletedPaths, cleanPaths, mtimeUpdates } = extractRes;
        const sortedLanguages = [...langs].sort(compareUtf16);
        const sqliteStore = openSqliteStore(outDir, { create: true });
        const dbMeta = readBuildDbMeta(sqliteStore);
        let prior = null;
        if (opts.reuse !== false && !seed.from) {
            const sqlMeta = readGraphMetaFromSqlite(sqliteStore);
            if (sqlMeta) {
                const cachedPrior = getCachedPriorNodes(outDir, sqliteStore, dbMeta.graphVersion);
                prior = { meta: sqlMeta, nodes: cachedPrior.nodes, nodePathById: cachedPrior.nodePathById, edges: null };
            }
        }
        const cachedEnv = resolvedEnvCache.get(resolve(outDir));
        const canReuseResolvedEnv = Boolean(
            opts.configsUnchanged &&
            opts.docsUnchanged &&
            opts.noFileAddRemove &&
            opts.includeDocs !== false &&
            prior &&
            cachedEnv &&
            cachedEnv.graphVersion === dbMeta.graphVersion &&
            prior.meta?.config_hash === cachedEnv.configHash
        );
        let discoveredScopes;
        let docsBundle;
        let scopes;
        let goModules;
        let tsConfigs;
        let packageConfigs;
        let ecoManifests;
        let configBundle;
        let configHash;
        if (canReuseResolvedEnv) {
            discoveredScopes = cachedEnv.discoveredScopes;
            docsBundle = cachedEnv.docsBundle;
            scopes = cachedEnv.scopes;
            goModules = cachedEnv.goModules;
            tsConfigs = cachedEnv.tsConfigs;
            packageConfigs = cachedEnv.packageConfigs;
            ecoManifests = cachedEnv.ecoManifests;
            configBundle = cachedEnv.configBundle;
            configHash = cachedEnv.configHash;
        }
        else {
            discoveredScopes = discoverScopes(root, repoFiles, opts.contextDir);
            docsBundle = readMarkdownDocsBundle(root, opts.includeDocs);
            const scopeNodes = extractRes.mode === "sqlite"
                ? [...(prior?.nodes ?? []).filter((n) => !dirtyPaths.has(n.path) && !deletedPaths.includes(n.path)), ...extractRes.nodes]
                : extractRes.nodes;
            scopes = applyMinSubstanceGuard(discoveredScopes, scopeNodes);
            goModules = readGoModules(root, walked);
            tsConfigs = readTsConfigs(root, walked);
            packageConfigs = readPackageConfigs(root, walked);
            ecoManifests = readEcosystemManifests(root, walked);
            configBundle = readResolverConfigBundle(root, walked, scopes, outDir);
            configHash = resolverConfigHash(root, walked, scopes, goModules, { bundle: configBundle, outDir });
        }
        const docsDirty = dbMeta.docsHash !== docsBundle.docsDigest;

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
            goModules, tsConfigs, packageConfigs, ecoManifests, configBundle, docsBundle, configHash,
            preWalkDirMtimes, extractRes, sortedLanguages, prior, sqliteStore, dbMeta,
            docsDirty, mtimeDirty, dirtyPaths, deletedPaths, cleanPaths, mtimeUpdates,
            graphOnly: Boolean(opts.graphOnly),
            skipAggregateCounts: Boolean(opts.skipAggregateCounts),
            manifestMounts: walkCfg.manifestMounts,
            reuse: opts.reuse, seedFrom: seed.from, onlyDirs: opts.onlyDirs, extensions: opts.extensions, errors,
        };

        const built = isSqliteUnchanged
            ? runUnchangedSqliteBuild(buildCtx)
            : (tryBuildDirtyConePath(buildCtx) ?? runFullResolutionBuildPath(buildCtx));

        const { cardsWritten, byKind, byRelation } = finalizeGraphBuildOutput(
            root, outDir, opts, built, sortedLanguages,
        );
        return {
            contextDir: outDir,
            graphPath: built.graphPath,
            cards: cardsWritten,
            files: files.length,
            parsed,
            reused,
            seededFrom: seed.from,
            nodes: built.nodeCount ?? built.nodes.length,
            edges: built.edgeCount ?? (built.edges?.length ?? 0),
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
