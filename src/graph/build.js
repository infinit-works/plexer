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
import { basename, dirname, join, resolve } from "node:path";
import { walkDir } from "../ingest/fs.js";
import { contextDirFor, ensureGitignored, ensureSearchable } from "../context/node-file.js";
import { contentHash } from "../util/id.js";
import { relPosix } from "../util/paths.js";
import { patchStats, readWalkConfig } from "../util/state.js";
import { emptyExtractCache, extractSourceFiles, readExtractCache, writeExtractCache } from "./extract-cache.js";
import { readFingerprint, writeFingerprint } from "./fingerprint.js";
import { seedGraph } from "./seed.js";
import { filterByOnlyDirs, listSourceStats } from "./source-files.js";
import { resolveEdges } from "./resolve.js";
import { readGraph, writeGraph, wiringPath } from "./write.js";
import { writeCards, writeIndex } from "./cards.js";
import { readAskIndex, writeAskIndex } from "../ask/index-file.js";
import { discoverScopes, scopeOf } from "./scopes.js";
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
function parseJsonc(raw) {
    const out = [];
    let i = 0;
    let inString = false;
    while (i < raw.length) {
        const ch = raw[i];
        if (inString) {
            out.push(ch);
            if (ch === "\\" && i + 1 < raw.length) {
                out.push(raw[i + 1]);
                i += 2;
                continue;
            }
            if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out.push(ch);
            i++;
            continue;
        }
        if (ch === "/" && raw[i + 1] === "/") {
            i += 2;
            while (i < raw.length && raw[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "/" && raw[i + 1] === "*") {
            i += 2;
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        if (ch === "}" || ch === "]") {
            for (let k = out.length - 1; k >= 0; k--) {
                const prev = out[k];
                if (prev === " " || prev === "\t" || prev === "\r" || prev === "\n" || prev === "")
                    continue;
                if (prev === ",")
                    out[k] = "";
                break;
            }
        }
        out.push(ch);
        i++;
    }
    return JSON.parse(out.join(""));
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
function readTsConfigs(root, repoFiles) {
    const configs = [];
    for (const f of repoFiles) {
        const b = basename(f);
        if (b !== "tsconfig.json" && b !== "jsconfig.json")
            continue;
        const parsed = readTsConfigFile(f);
        if (!parsed || typeof parsed !== "object")
            continue;
        let baseUrl = parsed.compilerOptions?.baseUrl;
        let paths = parsed.compilerOptions?.paths;
        if (typeof parsed.extends === "string" && (baseUrl === undefined || paths === undefined)) {
            const extPath = resolveExtendedTsConfigPath(f, parsed.extends);
            if (extPath) {
                const parentCfg = readTsConfigFile(extPath);
                if (parentCfg?.compilerOptions) {
                    if (baseUrl === undefined && typeof parentCfg.compilerOptions.baseUrl === "string") {
                        const absParentBase = resolve(dirname(extPath), parentCfg.compilerOptions.baseUrl);
                        baseUrl = relPosix(dirname(f), absParentBase) || ".";
                    }
                    if (parentCfg.compilerOptions.paths && typeof parentCfg.compilerOptions.paths === "object") {
                        paths = paths ? { ...parentCfg.compilerOptions.paths, ...paths } : parentCfg.compilerOptions.paths;
                    }
                }
            }
        }
        const dir = relPosix(root, dirname(f));
        configs.push({
            dir,
            baseUrl: typeof baseUrl === "string" ? baseUrl : null,
            paths: paths && typeof paths === "object" ? paths : null,
        });
    }
    configs.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
    return configs;
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
function resolverConfigHash(root, repoFiles, scopes, goModules) {
    const configFiles = [];
    const seen = new Set();
    const candidates = [
        join(root, ".luaurc"),
        ...scopes.filter((s) => s.prefix).map((s) => join(root, s.prefix, ".luaurc")),
        ...repoFiles.filter((f) => {
            const b = basename(f);
            return (b === ".luaurc" ||
                b.endsWith(".project.json") ||
                /^(?:ts|js)config(?:\..+)?\.json$/.test(b) ||
                b === "package.json");
        }),
    ];
    for (const f of candidates) {
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
    return contentHash(JSON.stringify({ scopes, goModules, configFiles }));
}
function isGraphBuildUnchanged(opts, parsed, seed, priorAskIndex, priorExtract, files, entries, prior, configHash, nodes) {
    if (opts.reuse === false ||
        parsed !== 0 ||
        Boolean(seed.from) ||
        priorAskIndex?.version !== 2 ||
        Object.keys(priorExtract.files).length !== files.length ||
        !Object.keys(entries).every((k) => k in priorExtract.files) ||
        prior === null ||
        prior.meta?.config_hash !== configHash ||
        prior.nodes.length !== nodes.length) {
        return false;
    }
    const priorById = new Map(prior.nodes.map((n) => [n.id, n]));
    return nodes.every((n) => {
        const p = priorById.get(n.id);
        return p !== undefined && p.body_hash === n.body_hash;
    });
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
export async function buildGraph(dir, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const walkCfg = readWalkConfig(root, opts.contextDir);
    const walked = walkDir(root, walkCfg.includeDirs, {
        followSubmodules: walkCfg.followSubmodules,
        followNestedRepos: walkCfg.followNestedRepos,
    });
    const onlyDirs = opts.onlyDirs && opts.onlyDirs.length > 0 ? new Set(opts.onlyDirs) : undefined;
    const repoFiles = filterByOnlyDirs(walked, root, onlyDirs);
    const files = listSourceStats(root, outDir, repoFiles, undefined, opts.extensions);
    const discoveredScopes = discoverScopes(root, repoFiles);
    const seed = opts.reuse === false ? { seeded: false } : seedGraph(root, { contextDir: opts.contextDir });
    const priorExtract = opts.reuse === false ? emptyExtractCache() : readExtractCache(outDir);
    const { nodes, rawEdges, langs, errors, entries, parsed, reused, mtimeDirty } = await extractSourceFiles(files, priorExtract, {
        onProgress: opts.onProgress,
    });
    const scopes = applyMinSubstanceGuard(discoveredScopes, nodes);
    const goModules = readGoModules(root, repoFiles);
    const tsConfigs = readTsConfigs(root, repoFiles);
    const packageConfigs = readPackageConfigs(root, repoFiles);
    const configHash = resolverConfigHash(root, repoFiles, scopes, goModules);
    const prior = opts.reuse === false ? null : readGraph(wiringPath(outDir));
    const priorAskIndex = opts.reuse === false ? null : readAskIndex(outDir);
    const noSourceChanges = isGraphBuildUnchanged(opts, parsed, seed, priorAskIndex, priorExtract, files, entries, prior, configHash, nodes);
    const sortedLanguages = [...langs].sort();
    let edges;
    let graph;
    let graphPath;
    if (noSourceChanges) {
        edges = prior.edges;
        graph = prior;
        graphPath = wiringPath(outDir);
        if (mtimeDirty)
            writeExtractCache(outDir, { ...emptyExtractCache(), files: entries });
        if (mtimeDirty || !readFingerprint(outDir)?.dirs)
            writeFingerprint(outDir, entries, opts.onlyDirs, root);
    }
    else {
        edges = resolveEdges(nodes, rawEdges, { goModules, root, scopes, tsConfigs, packageConfigs });
        graph = {
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
        graphPath = writeGraph(graph, outDir);
        try {
            writeAskIndex(outDir, graph, priorAskIndex);
        }
        catch (err) {
            errors.push(`ask-index: ${err instanceof Error ? err.message : String(err)}`);
        }
        writeExtractCache(outDir, { ...emptyExtractCache(), files: entries });
        writeFingerprint(outDir, entries, opts.onlyDirs, root);
    }
    const { cardsWritten, byKind, byRelation } = finalizeGraphBuildOutput(root, outDir, opts, graph, nodes, edges, sortedLanguages);
    return {
        contextDir: outDir,
        graphPath,
        cards: cardsWritten,
        files: files.length,
        parsed,
        reused,
        seededFrom: seed.from,
        nodes: nodes.length,
        edges: edges.length,
        byKind,
        byRelation,
        languages: sortedLanguages,
        errors,
    };
}
