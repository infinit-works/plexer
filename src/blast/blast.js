/**
 * Blast radius of a diff: what else in the repo depends on the lines this change
 * touched.
 *
 * The whole command is a join between two things plexer already has — git's changed
 * line ranges (`diff.js`) and the wiring graph's incoming edges (`traverse.js`) —
 * so there is no new graph logic here, only the seeding rule:
 *
 *   changed line → the innermost symbol whose span contains it → seed
 *
 * Seeding by SYMBOL rather than by file is what makes the answer worth reading: a
 * 400-line file with a one-line edit reports the dependents of that one function,
 * not of everything the file happens to define. The file node is seeded too, so
 * importers (whose edge targets the file, not the symbol) are still found.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../context/graph-store.js";
import { containerLangOf, extractContainer } from "../graph/container.js";
import { extractFile, languageLabelOf } from "../graph/extract.js";
import { extractGeneric, genericLangOf } from "../graph/generic.js";
import { linkTestsForGraph } from "../graph/test-links.js";
import { impactOfMany, parseWalkDepth } from "../graph/traverse.js";
import { GENERIC_MEMBER_NAMES } from "../util/id.js";
import { globToRegExp, isTestPath, pushMap, toPosixPath } from "../util/paths.js";
import { parseLayerRuleEntry } from "./layer-rules.js";
import { readJson } from "../util/state.js";
import { changedFiles, readPreImageFile, refExists, resolveBaseRef } from "./diff.js";
import { escapeRegExp, spanRange } from "./evidence.js";
import { analyzeGitHistory, untouchedCoChanges } from "./history.js";
import { dirLabel, moduleIndex, parentDir, shortLabel } from "./modules.js";
/**
 * The innermost symbols whose spans overlap any changed range in `path`.
 *
 * "Innermost" matters for a method: a changed line inside `Cache.get` overlaps both
 * the class span and the method span, and seeding the class would report everyone
 * who touches any part of `Cache`. Nesting is resolved by keeping, for each range,
 * only symbols that contain no other matched symbol.
 */
function seedsForFile(symbols, ranges) {
    if (!symbols || symbols.length === 0)
        return [];
    const hit = new Map();
    for (const r of ranges) {
        const overlapping = symbols.filter((s) => s.start <= r.end && s.end >= r.start);
        // Drop any symbol that strictly contains another overlapping one (the class
        // around a changed method), keeping the tightest description of the edit.
        for (const s of overlapping) {
            const containsAnother = overlapping.some((o) => o !== s && o.start >= s.start && o.end <= s.end && (o.start > s.start || o.end < s.end));
            if (!containsAnother)
                hit.set(s.node.id, s.node);
        }
    }
    return [...hit.values()];
}
function blastRadiusFromDir(dir, rawOpts) {
    const root = resolve(dir);
    const dirOpts = rawOpts && typeof rawOpts === "object" && !Array.isArray(rawOpts) ? rawOpts : {};
    const contextDir = contextDirFor(root, dirOpts.contextDir);
    const loaded = loadGraphCached(contextDir);
    if (!loaded)
        throw new Error(`no graph found at ${contextDir} — run \`plexer build\` first`);
    if (dirOpts.base !== undefined && !refExists(root, dirOpts.base))
        throw new Error(`base ref "${dirOpts.base}" is not in this checkout`);
    const diff = changedFiles(root, dirOpts.base);
    if (!diff)
        throw new Error(`could not read a diff in ${root} — is this a git repository?`);
    const parsedDepth = parseWalkDepth(dirOpts.depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    return blastRadiusIn(loaded, contextDir, diff.files, diff.basis, parsedDepth, {
        rootDir: root,
        baseRef: diff.baseRef,
        layerRules: dirOpts.layerRules ?? dirOpts.layer_rules,
        gitHistory: dirOpts.gitHistory,
        includeHistory: dirOpts.includeHistory,
        since: dirOpts.since,
    });
}
function indexBlastGraphNodes(graph) {
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const fileNodes = new Map();
    const goFilesByDir = new Map();
    const symbolsByFile = new Map();
    const edgesBySource = new Map();
    const importersByTarget = new Map();
    const incomingTargets = new Set();
    const unresolvedImports = [];
    for (const n of graph.nodes) {
        if (n.kind === "file") {
            fileNodes.set(n.path, n);
            if (n.path.endsWith(".go") && !n.path.endsWith("_test.go"))
                pushMap(goFilesByDir, posix.dirname(toPosixPath(n.path)), n.path);
            continue;
        }
        const b = spanRange(n.span);
        if (!b)
            continue;
        pushMap(symbolsByFile, n.path, { node: n, ...b });
    }
    for (const e of graph.edges) {
        if (e.relation === "contains")
            continue;
        pushMap(edgesBySource, e.source, e);
        incomingTargets.add(e.target);
        if (e.relation === "imports" || e.relation === "reexports")
            pushMap(importersByTarget, e.target, e);
        if (e.relation === "imports" && !byId.has(e.target))
            unresolvedImports.push(e);
    }
    return { byId, fileNodes, goFilesByDir, symbolsByFile, edgesBySource, importersByTarget, incomingTargets, unresolvedImports };
}
function baseRefFromBasis(rootDir, basis, explicitBaseRef) {
    if (explicitBaseRef)
        return explicitBaseRef;
    if (!rootDir || typeof basis !== "string")
        return null;
    if (basis === "working tree vs HEAD" || basis === "working tree" || basis === "working-tree")
        return "HEAD";
    if (basis === "HEAD~1...HEAD")
        return "HEAD~1";
    const m = basis.match(/^(.+)\.\.\.HEAD$/);
    if (m?.[1])
        return resolveBaseRef(rootDir, m[1]) ?? m[1];
    return null;
}
function stripImportExtAndIndex(p) {
    const noExt = toPosixPath(p).replace(/\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|rb|lua|luau|sol|ex|exs|dart|scala|sc|cs|ml|mli|zig|clj[cs]?|bb|nix|vue|svelte|astro)$/i, "");
    return noExt.replace(/\/(?:index|__init__|mod|init(?:\.(?:client|server))?)$/i, "");
}
function matchRelativeImportSpec(sourceFile, normSpec, normTarget, targetNoExt) {
    if (!normSpec.startsWith("./") && !normSpec.startsWith("../") && normSpec !== "." && normSpec !== "..") {
        const dotMatch = normSpec.match(/^(\.+)(.*)$/);
        if (dotMatch) {
            let baseDir = posix.dirname(toPosixPath(sourceFile));
            for (let up = 1; up < dotMatch[1].length; up++)
                baseDir = posix.dirname(baseDir);
            const rest = dotMatch[2].replace(/\./g, "/");
            const pyJoined = rest ? posix.normalize(posix.join(baseDir, rest)) : posix.normalize(baseDir);
            const cleanPy = pyJoined.replace(/^\.\//, "");
            return cleanPy === normTarget || stripImportExtAndIndex(cleanPy) === targetNoExt;
        }
    }
    const joined = posix.normalize(posix.join(posix.dirname(toPosixPath(sourceFile)), normSpec)).replace(/^\.\//, "");
    return joined === normTarget || stripImportExtAndIndex(joined) === targetNoExt;
}

export function importSpecMatchesPath(sourceFile, spec, targetPath) {
    if (!spec || !targetPath)
        return false;
    const normTarget = toPosixPath(targetPath);
    const targetNoExt = stripImportExtAndIndex(normTarget);
    const normSpec = toPosixPath(spec).replace(/::/g, "/");
    if (normSpec === normTarget || normSpec === targetNoExt)
        return true;
    if (normSpec.startsWith(".")) {
        return matchRelativeImportSpec(sourceFile, normSpec, normTarget, targetNoExt);
    }
    const dotSlash = normSpec.includes("/") ? normSpec : normSpec.replace(/\./g, "/");
    const cleanSpec = stripImportExtAndIndex(dotSlash.replace(/^@[^/]+\//, ""));
    if (!cleanSpec || cleanSpec === "index")
        return false;
    return targetNoExt === cleanSpec || targetNoExt.endsWith(`/${cleanSpec}`) || (cleanSpec.includes("/") && targetNoExt.endsWith(cleanSpec));
}
function unresolvedImportTargetsForPath(unresolvedImports, targetPath) {
    const seen = new Set();
    const out = [];
    for (const e of unresolvedImports) {
        if (!seen.has(e.target) && importSpecMatchesPath(e.source, e.target, targetPath)) {
            seen.add(e.target);
            out.push({ id: e.target, name: basename(e.target), kind: "file", path: targetPath, span: "L1-L1", wholeFile: true });
        }
    }
    return out;
}
function findPythonBlockEndLine(lines, startIdx) {
    const baseIndent = lines[startIdx].match(/^\s*/)[0].length;
    let last = startIdx;
    for (let i = startIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        if (lines[i].match(/^\s*/)[0].length <= baseIndent)
            break;
        last = i;
    }
    return last + 1;
}

function findBraceBlockEndLine(lines, startIdx) {
    let depth = 0;
    let opened = false;
    const limit = Math.min(lines.length, startIdx + 300);
    for (let i = startIdx; i < limit; i++) {
        for (const ch of lines[i]) {
            if (ch === "{") {
                depth++;
                opened = true;
            }
            else if (ch === "}") {
                depth--;
                if (opened && depth <= 0)
                    return i + 1;
            }
        }
        if (i === startIdx && !opened)
            return startIdx + 1;
    }
    return startIdx + 1;
}

function findBlockEndLine(lines, startIdx, isPython) {
    return isPython
        ? findPythonBlockEndLine(lines, startIdx)
        : findBraceBlockEndLine(lines, startIdx);
}
function extractFallbackPreImageNodes(relPath, source) {
    const lines = source.split("\n");
    const isPy = /\.pyi?$/i.test(relPath);
    const out = [{ id: relPath, name: basename(relPath), kind: "file", path: relPath, span: `L1-L${lines.length}` }];
    const declRe = isPy
        ? /^\s*(?:async\s+)?(?:(def)|(class))\s+([A-Za-z_]\w*)/
        : /^\s*(?:export\s+(?:default\s+)?)?(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?(?:(function\*?|def|fn)|(class|struct|interface|trait|enum|type))\s+([A-Za-z_$]\w*)/;
    const arrowRe = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let name = null;
        let kind = "function";
        const am = arrowRe.exec(line);
        if (am) {
            name = am[1];
        }
        else {
            const gm = line.match(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/);
            if (gm) {
                name = gm[1];
            }
            else {
                const dm = declRe.exec(line);
                if (dm && dm[3]) {
                    name = dm[3];
                    kind = dm[2] && !isPy ? (dm[2] === "interface" || dm[2] === "trait" ? "interface" : "class") : (dm[2] === "class" ? "class" : "function");
                }
            }
        }
        if (!name)
            continue;
        const endLine = findBlockEndLine(lines, i, isPy);
        out.push({ id: `${relPath}#${name}`, name, kind, path: relPath, span: `L${i + 1}-L${endLine}`, signature: line.trim() });
    }
    return out;
}
function extractPreImageNodes(relPath, source) {
    if (!source)
        return [];
    let nodes = [];
    if (containerLangOf(relPath))
        nodes = extractContainer(relPath, source).nodes;
    else if (languageLabelOf(relPath))
        nodes = extractFile(relPath, source).nodes;
    else if (genericLangOf(relPath))
        nodes = extractGeneric(relPath, source).nodes;
    if (nodes.length > 1)
        return nodes;
    return extractFallbackPreImageNodes(relPath, source);
}
function collectPreImageSeeds(file, prePath, preRanges, idx, rootDir, baseRef) {
    const preSource = rootDir && baseRef ? readPreImageFile(rootDir, baseRef, prePath) : null;
    if (!preSource)
        return [];
    const preNodes = extractPreImageNodes(prePath, preSource);
    const symEntries = [];
    for (const n of preNodes) {
        if (n.kind === "file")
            continue;
        const b = spanRange(n.span);
        if (b)
            symEntries.push({ node: n, ...b });
    }
    const matched = preRanges === null ? symEntries.map((s) => s.node) : seedsForFile(symEntries, preRanges);
    return matched;
}
const BARREL_FILE_RE = /^(?:index|init(?:\.(?:client|server))?|mod|__init__)\.[a-z0-9]+$/i;
const TS_JS_PY_EXT = /\.(?:[cm]?[jt]sx?|pyi?|vue|svelte|astro)$/i;
const TS_TYPE_FILE_EXT = /\.(?:[cm]?tsx?|vue|svelte|astro)$/i;
const MAX_DEP_BARREL_HOPS = 6;

function resolveDeletedWalkSeeds(prePath, isIndexed, unresolvedSpecs, file, idx, rootDir, baseRef) {
    const staleFileNode = idx.fileNodes.get(prePath);
    const staleSyms = (idx.symbolsByFile.get(prePath) ?? []).map((s) => s.node);
    const preSyms = (isIndexed || unresolvedSpecs.length > 0)
        ? collectPreImageSeeds(file, prePath, null, idx, rootDir, baseRef)
        : [];
    if (!staleFileNode && staleSyms.length === 0 && preSyms.length === 0 && unresolvedSpecs.length === 0)
        return null;
    const symMap = new Map();
    for (const s of [...staleSyms, ...preSyms])
        if (!symMap.has(s.id)) symMap.set(s.id, s);
    const allDeletedSyms = [...symMap.values()];
    const fallbackNode = staleFileNode ?? { id: prePath, name: basename(prePath), kind: "file", path: prePath, span: "L1-L1", wholeFile: true };
    return {
        displaySeeds: symMap.size > 0 ? allDeletedSyms : [fallbackNode],
        walkList: [...allDeletedSyms, staleFileNode ?? { id: prePath, name: basename(prePath), kind: "file", path: prePath, span: "L1-L1" }, ...unresolvedSpecs],
        seedPath: prePath,
        prePath,
        fileNode: staleFileNode ?? null,
        unresolvedSpecs,
        missingPreSyms: allDeletedSyms.filter((s) => !idx.byId.has(s.id)),
    };
}
function collectPreImageSeedsForFile(file, prePath, unresolvedSpecs, idx, rootDir, baseRef) {
    const preRanges = file.oldRanges?.length ? file.oldRanges : (file.ranges?.length ? file.ranges : []);
    if ((file.status === "modified" || file.status === "renamed") && preRanges.length > 0)
        return collectPreImageSeeds(file, prePath, preRanges, idx, rootDir, baseRef);
    if (file.status === "renamed" && unresolvedSpecs.length > 0)
        return collectPreImageSeeds(file, prePath, null, idx, rootDir, baseRef);
    return [];
}
function resolveFileWalkSeeds(file, idx, rootDir, baseRef) {
    const prePath = file.status === "renamed" ? (file.oldPath ?? file.path) : file.path;
    const hasSamePkgSiblings = prePath.endsWith(".go") && idx.goFilesByDir.has(posix.dirname(toPosixPath(prePath)));
    const isIndexed = idx.fileNodes.has(file.path) || idx.fileNodes.has(prePath) || idx.incomingTargets.has(prePath) || hasSamePkgSiblings;
    const unresolvedSpecs = file.status === "deleted" || file.status === "renamed"
        ? unresolvedImportTargetsForPath(idx.unresolvedImports, prePath)
        : [];
    if (file.status === "deleted")
        return resolveDeletedWalkSeeds(prePath, isIndexed, unresolvedSpecs, file, idx, rootDir, baseRef);
    const fileNode = idx.fileNodes.get(file.path) ?? idx.fileNodes.get(prePath);
    if (!fileNode && unresolvedSpecs.length === 0)
        return "unindexed";
    const postSyms = fileNode && file.ranges.length > 0 ? seedsForFile(idx.symbolsByFile.get(fileNode.path), file.ranges) : [];
    const postIds = new Set(postSyms.map((s) => s.id));
    const preSyms = collectPreImageSeedsForFile(file, prePath, unresolvedSpecs, idx, rootDir, baseRef);
    const extraPreSyms = preSyms.filter((p) => !postIds.has(p.id) && (idx.byId.has(p.id) || idx.incomingTargets.has(p.id) || file.ranges.length > 0 || (file.oldRanges?.length ?? 0) > 0));
    const allSyms = [...postSyms, ...extraPreSyms];
    const displaySeeds = allSyms.length > 0 ? allSyms : (fileNode ? [{ ...fileNode, wholeFile: true }] : unresolvedSpecs);
    const walkMap = new Map();
    for (const s of allSyms) walkMap.set(s.id, s);
    if (fileNode) walkMap.set(fileNode.id, fileNode);
    if (prePath !== fileNode?.path && idx.incomingTargets.has(prePath))
        walkMap.set(prePath, { id: prePath, name: basename(prePath), kind: "file", path: prePath, span: "L1-L1" });
    for (const u of unresolvedSpecs) if (!walkMap.has(u.id)) walkMap.set(u.id, u);
    return { displaySeeds, walkList: [...walkMap.values()], seedPath: fileNode?.path ?? prePath, prePath, fileNode: fileNode ?? null, unresolvedSpecs, missingPreSyms: preSyms.filter((p) => !idx.byId.has(p.id)) };
}
function symbolOwnerName(sym) {
    if (sym.owner)
        return sym.owner;
    const hash = sym.id?.indexOf("#") ?? -1;
    if (hash === -1)
        return null;
    const tail = sym.id.slice(hash + 1);
    const dot = tail.lastIndexOf(".");
    return dot > 0 ? tail.slice(0, dot) : null;
}
function expandCandidateBarrelQueue(queue, visitedTargets, depFiles, barrelFiles, prePath, filePath, idx) {
    let head = 0;
    while (head < queue.length) {
        const { target, hops } = queue[head++];
        for (const edge of idx.importersByTarget.get(target) ?? []) {
            const src = edge.source;
            if (!src || src === prePath || src === filePath)
                continue;
            depFiles.add(src);
            if (hops < MAX_DEP_BARREL_HOPS && (edge.relation === "reexports" || BARREL_FILE_RE.test(basename(src)))) {
                barrelFiles.add(src);
                if (!visitedTargets.has(src)) {
                    visitedTargets.add(src);
                    queue.push({ target: src, hops: hops + 1 });
                }
            }
        }
    }
}
function collectCandidateDepFiles(targetIds, prePath, filePath, idx) {
    const depFiles = new Set();
    const barrelFiles = new Set();
    const visitedTargets = new Set();
    const queue = [];
    for (const tid of targetIds) {
        if (tid && !visitedTargets.has(tid)) {
            visitedTargets.add(tid);
            queue.push({ target: tid, hops: 0 });
        }
    }
    expandCandidateBarrelQueue(queue, visitedTargets, depFiles, barrelFiles, prePath, filePath, idx);
    if (prePath.endsWith(".go")) {
        for (const sibling of idx.goFilesByDir.get(posix.dirname(toPosixPath(prePath))) ?? []) {
            if (sibling !== prePath && sibling !== filePath)
                depFiles.add(sibling);
        }
    }
    return { depFiles: [...depFiles], barrelFiles };
}
function extractDepRaw(depFile, rootDir, depCache) {
    if (depCache.has(depFile))
        return depCache.get(depFile);
    const fullPath = join(rootDir, depFile);
    if (!existsSync(fullPath)) {
        depCache.set(depFile, null);
        return null;
    }
    let depSource = null;
    try {
        depSource = readFileSync(fullPath, "utf8");
    }
    catch {
        depCache.set(depFile, null);
        return null;
    }
    let extracted = null;
    if (containerLangOf(depFile))
        extracted = extractContainer(depFile, depSource);
    else if (languageLabelOf(depFile))
        extracted = extractFile(depFile, depSource);
    else if (genericLangOf(depFile))
        extracted = extractGeneric(depFile, depSource);
    const nodes = extracted?.nodes ?? [];
    const rawEdges = extracted?.rawEdges ?? [];
    const localNames = new Set();
    for (const n of nodes) {
        if (n.kind !== "file" && n.name)
            localNames.add(n.name);
    }
    const entry = { depSource, nodes, rawEdges, localNames };
    depCache.set(depFile, entry);
    return entry;
}
function buildMissingSymbolMeta(missingPreSyms) {
    const missingNames = new Set();
    const missingQuals = new Set();
    const missingMethodOwners = new Map();
    const missingTypeNames = new Set();
    let hasDefaultMissing = false;
    for (const p of missingPreSyms) {
        if (!p.name)
            continue;
        missingNames.add(p.name);
        if (p.defaultExport)
            hasDefaultMissing = true;
        if (p.kind === "interface" || p.kind === "type" || p.kind === "class" || p.kind === "struct" || p.kind === "enum")
            missingTypeNames.add(p.name);
        const owner = symbolOwnerName(p);
        if (owner) {
            missingQuals.add(`${owner}.${p.name}`);
            pushMap(missingMethodOwners, p.name, owner);
        }
    }
    return { missingNames, missingQuals, missingMethodOwners, missingTypeNames, hasDefaultMissing };
}
function matchesMissingRawEdge(e, depFile, depSource, depLocalNames, meta, targetPaths, barrelFiles, isSameGoPkg) {
    const leafName = e.name ? e.name.split(/[.:]/).pop() : "";
    const recvHint = e.recvType ?? e.receiver ?? null;
    const isMember = Boolean(e.viaMember || recvHint);
    const nameHit = Boolean(
        e.name &&
            (meta.missingNames.has(e.name) ||
                (leafName && meta.missingNames.has(leafName)) ||
                meta.missingQuals.has(e.name) ||
                (recvHint && meta.missingQuals.has(`${recvHint}.${e.name}`))),
    );
    if (e.specifier) {
        const specMatches =
            targetPaths.some((p) => importSpecMatchesPath(depFile, e.specifier, p)) ||
            [...barrelFiles].some((b) => importSpecMatchesPath(depFile, e.specifier, b));
        if (!specMatches)
            return false;
        return (Boolean(e.isDefault) && meta.hasDefaultMissing) || nameHit;
    }
    if (!nameHit)
        return false;
    if (!isMember && !isSameGoPkg && depLocalNames.has(e.name))
        return false;
    const isHeritage = e.relation === "extends" || e.relation === "implements";
    if (GENERIC_MEMBER_NAMES.has(leafName.toLowerCase()) && !isHeritage) {
        const owners = meta.missingMethodOwners.get(leafName) ?? [];
        const ownerMatched = e.recvType
            ? owners.includes(e.recvType)
            : owners.some((own) => e.receiver === own || new RegExp(`\\b${escapeRegExp(own)}\\b`).test(depSource));
        if (!ownerMatched)
            return false;
    }
    if (TS_JS_PY_EXT.test(depFile) && !isMember && !isHeritage && !/\bimport\s+\*/.test(depSource))
        return false;
    return true;
}
function enclosingSymbolAtLine(symEntries, fileNode, lineNo) {
    let best = null;
    for (const s of symEntries ?? []) {
        if (s.start <= lineNo && lineNo <= s.end) {
            if (!best || (s.end - s.start) < (best.end - best.start))
                best = s;
        }
    }
    return best?.node ?? fileNode ?? null;
}
function parseNamedImportAliases(depFile, depSource, targetPaths, barrelFiles) {
    const aliases = [];
    const importFromRe = /\bimport\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    for (const m of depSource.matchAll(importFromRe)) {
        const spec = m[2];
        const ok = targetPaths.some((p) => importSpecMatchesPath(depFile, spec, p)) || [...barrelFiles].some((b) => importSpecMatchesPath(depFile, spec, b));
        if (!ok)
            continue;
        for (const item of m[1].split(",")) {
            const parts = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
            if (parts.length === 2 && parts[0] && parts[1])
                aliases.push({ orig: parts[0].trim(), local: parts[1].trim() });
        }
    }
    return aliases;
}
function scanDepLinesForMissing(depFile, depSource, names, idx, targetPaths, barrelFiles, relation = "references", allowImportLines = false) {
    if (!names || names.size === 0)
        return [];
    const terms = new Set(names);
    for (const { orig, local } of parseNamedImportAliases(depFile, depSource, targetPaths, barrelFiles)) {
        if (names.has(orig))
            terms.add(local);
    }
    const nameList = [...terms].filter((n) => !GENERIC_MEMBER_NAMES.has(n.toLowerCase()));
    if (nameList.length === 0)
        return [];
    const wordMatcher = new RegExp(`\\b(?:${nameList.map(escapeRegExp).join("|")})\\b`);
    const lines = depSource.split("\n");
    const symEntries = idx.symbolsByFile.get(depFile) ?? [];
    const fileNode = idx.fileNodes.get(depFile) ?? null;
    const out = new Map();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || /^(?:\/\/|#|\/\*|\*|--|;)/.test(trimmed))
            continue;
        if (!allowImportLines && /^(?:import\b|export\s+(?:\*|\{)|from\s+\S+\s+import\b|use\s+)/.test(trimmed))
            continue;
        if (!wordMatcher.test(line))
            continue;
        const hitNode = enclosingSymbolAtLine(symEntries, fileNode, i + 1);
        if (hitNode && !out.has(hitNode.id)) {
            const callHit = new RegExp(`\\b(?:${nameList.map(escapeRegExp).join("|")})\\s*\\(`).test(line);
            out.set(hitNode.id, { node: hitNode, relation: callHit ? "calls" : relation, typeOnly: false });
        }
    }
    return [...out.values()];
}
function collectMatchedAstEdges(depEntry, depFile, meta, targetPaths, barrelFiles, idx, isSameGoPkg) {
    const matched = new Map();
    for (const e of depEntry.rawEdges) {
        if (e.relation !== "calls" && e.relation !== "references" && e.relation !== "extends" && e.relation !== "implements")
            continue;
        if (!matchesMissingRawEdge(e, depFile, depEntry.depSource, depEntry.localNames, meta, targetPaths, barrelFiles, isSameGoPkg))
            continue;
        const hitNode = idx.byId.get(e.source) ?? idx.fileNodes.get(depFile);
        if (!hitNode)
            continue;
        const prev = matched.get(hitNode.id);
        const typeOnly = Boolean(e.typeOnly);
        if (!prev || (prev.typeOnly && !typeOnly) || (e.relation === "calls" && prev.relation !== "calls" && (!typeOnly || prev.typeOnly)))
            matched.set(hitNode.id, { node: hitNode, relation: e.relation, typeOnly });
    }
    return matched;
}
function findRecoveredDepMatches(depFile, rootDir, depCache, missingPreSyms, targetPaths, barrelFiles, idx, isSameGoPkg) {
    const depEntry = extractDepRaw(depFile, rootDir, depCache);
    if (!depEntry)
        return [];
    const meta = buildMissingSymbolMeta(missingPreSyms);
    if (depEntry.nodes.length <= 1 && depEntry.rawEdges.length === 0)
        return scanDepLinesForMissing(depFile, depEntry.depSource, meta.missingNames, idx, targetPaths, barrelFiles, "calls", false);
    const matched = collectMatchedAstEdges(depEntry, depFile, meta, targetPaths, barrelFiles, idx, isSameGoPkg);
    if (TS_TYPE_FILE_EXT.test(depFile) && meta.missingTypeNames.size > 0) {
        for (const m of scanDepLinesForMissing(depFile, depEntry.depSource, meta.missingTypeNames, idx, targetPaths, barrelFiles, "references", false)) {
            if (!matched.has(m.node.id) && m.node.kind !== "file")
                matched.set(m.node.id, m);
        }
    }
    return [...matched.values()];
}
function mergeBlastHit(merged, hit, filePath) {
    const prev = merged.get(hit.id);
    if (!prev) {
        merged.set(hit.id, { hit, from: new Set([filePath]) });
        return;
    }
    prev.from.add(filePath);
    const combinedTypeOnly = Boolean(prev.hit.typeOnly && hit.typeOnly);
    if (hit.depth < prev.hit.depth || (hit.depth === prev.hit.depth && hit.relation === "calls" && prev.hit.relation !== "calls" && (!hit.typeOnly || combinedTypeOnly)))
        prev.hit = combinedTypeOnly ? hit : { ...hit, typeOnly: undefined };
    else if (prev.hit.typeOnly && !combinedTypeOnly)
        delete prev.hit.typeOnly;
    if (!prev.hit.typeOnly)
        delete prev.hit.typeOnly;
}
function propagateRecoveredMatchTransitive(graph, idx, match, depth, filePath, merged) {
    const subHits = impactOfMany(graph, [match.node], depth - 1, "in");
    const subSeeds = new Set([match.node.id]);
    const subTypeOnly = new Map();
    for (const sh of subHits) {
        if (!hasNode(sh) || sh.node.id === match.node.id)
            continue;
        const tOnly = Boolean(match.typeOnly || isHitTypeOnly(sh, subSeeds, idx.edgesBySource, subTypeOnly));
        subTypeOnly.set(sh.node.id, tOnly);
        mergeBlastHit(merged, toImpacted({ ...sh, depth: sh.depth + 1 }, tOnly), filePath);
    }
}
function mergeRecoveredPreImageHits(graph, idx, file, resolved, depth, rootDir, depCache, merged) {
    if (!rootDir || resolved.missingPreSyms.length === 0)
        return;
    const targetIds = [resolved.fileNode?.id, file.path, resolved.prePath, ...resolved.unresolvedSpecs.map((u) => u.id)];
    const { depFiles, barrelFiles } = collectCandidateDepFiles(targetIds, resolved.prePath, file.path, idx);
    if (depFiles.length === 0)
        return;
    const targetPaths = [...new Set([resolved.prePath, file.path].filter(Boolean))];
    const preDir = posix.dirname(toPosixPath(resolved.prePath));
    for (const depFile of depFiles) {
        const isSameGoPkg = resolved.prePath.endsWith(".go") && depFile.endsWith(".go") && posix.dirname(toPosixPath(depFile)) === preDir;
        const hits = findRecoveredDepMatches(depFile, rootDir, depCache, resolved.missingPreSyms, targetPaths, barrelFiles, idx, isSameGoPkg);
        for (const match of hits) {
            mergeBlastHit(merged, toImpacted({ node: match.node, relation: match.relation, depth: 1, typeOnly: match.typeOnly }, match.typeOnly), file.path);
            if (depth > 1)
                propagateRecoveredMatchTransitive(graph, idx, match, depth, file.path, merged);
        }
    }
}
function isHitTypeOnly(h, seedIds, edgesBySource, typeOnlyByNodeId) {
    if (h.typeOnly === true)
        return true;
    const srcEdges = edgesBySource.get(h.node.id) ?? [];
    const targetMatches = srcEdges.filter((e) =>
        h.depth === 1 ? seedIds.has(e.target) || (h.via && e.target === h.via.id) : h.via ? e.target === h.via.id : seedIds.has(e.target),
    );
    if (targetMatches.length > 0 && targetMatches.every((e) => Boolean(e.typeOnly)))
        return true;
    if (h.depth > 1 && h.via && typeOnlyByNodeId.get(h.via.id) === true)
        return true;
    return false;
}
function collectBlastSeedsAndImpacts(graph, changed, depth, opts = {}, basis = "") {
    const idx = indexBlastGraphNodes(graph);
    const rootDir = opts.rootDir ?? null;
    const baseRef = baseRefFromBasis(rootDir, basis, opts.baseRef);
    const seeds = [];
    const unindexed = [];
    const deleted = [];
    const depCache = new Map();
    /** Seed nodes per changed file, kept for the area grouping and the test signal. */
    const seedNodes = new Map();
    /** Merged dependents, keyed by node id, at the shallowest depth any file reached
     * them — plus which changed files did the reaching. */
    const merged = new Map();
    for (const file of changed) {
        if (file.status === "deleted")
            deleted.push(file.path);
        const resolved = resolveFileWalkSeeds(file, idx, rootDir, baseRef);
        if (resolved === "unindexed") {
            unindexed.push(file.path);
            continue;
        }
        if (!resolved)
            continue;
        const { displaySeeds, walkList, seedPath } = resolved;
        for (const node of displaySeeds) {
            seeds.push({
                id: node.id, name: node.name, kind: node.kind, path: node.path, span: node.span,
                wholeFile: Boolean(node.wholeFile) || node.kind === "file",
            });
        }
        // One walk PER CHANGED FILE: seed `fileNode` alongside `symbolSeeds` (plus pre-image & unresolved targets).
        const seedIds = new Set(walkList.map((s) => s.id));
        seedNodes.set(seedPath, walkList);
        const hits = impactOfMany(graph, walkList, depth, "in");
        const typeOnlyByNodeId = new Map();
        for (const h of hits) {
            if (!hasNode(h))
                continue;
            const typeOnly = isHitTypeOnly(h, seedIds, idx.edgesBySource, typeOnlyByNodeId);
            typeOnlyByNodeId.set(h.node.id, typeOnly);
            mergeBlastHit(merged, toImpacted(h, typeOnly), file.path);
        }
        mergeRecoveredPreImageHits(graph, idx, file, resolved, depth, rootDir, depCache, merged);
    }
    return { seeds, unindexed, deleted, seedNodes, merged };
}
/** Compute the blast radius of `changed` against `graph`, or from a repo `dir` and `opts`. */
export function blastRadius(graph, changed, basis = "working tree", opts = { depth: 2 }) {
    if (typeof graph === "string")
        return blastRadiusFromDir(graph, changed);
    const parsedDepth = parseWalkDepth(opts?.depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    const { seeds, unindexed, deleted, seedNodes, merged } = collectBlastSeedsAndImpacts(graph, changed, parsedDepth, opts, basis);
    const impacted = [...merged.values()].map((m) => m.hit);
    const origins = new Map([...merged].map(([id, m]) => [id, m.from]));
    const index = opts.modules ?? emptyIndex();
    const grouped = groupByModule(impacted, changed, origins, index);
    const res = {
        basis,
        depth: parsedDepth,
        changed,
        unindexed,
        deleted,
        seeds,
        impacted,
        modules: grouped.modules,
        testModules: grouped.testModules,
        areas: changedAreas(graph, changed, seedNodes, index, grouped.modules),
    };
    if (opts?.gitHistory) {
        const coChanges = untouchedCoChanges(opts.gitHistory, changed.map((c) => c.path), graph);
        if (coChanges.length > 0)
            res.coChanges = coChanges;
    }
    const directLayerRules = opts?.layerRules ?? opts?.layer_rules;
    if (Array.isArray(directLayerRules) && directLayerRules.length > 0) {
        const violations = collectLayerViolations(graph, changed, directLayerRules);
        if (violations.length > 0)
            res.layerViolations = violations;
    }
    return res;
}
function collectBlastTestIncoming(graph) {
    const nodeById = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    /** How many edges point AT each node — how central it is in the graph. */
    const inDegree = new Map();
    /** Incoming edge sources per node id, resolved to the source's file path. */
    const incoming = new Map();
    for (const e of graph.edges) {
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        const path = nodeById.get(e.source)?.path;
        if (!path || !isTestPath(path))
            continue;
        const at = incoming.get(e.target) ?? new Set();
        at.add(path);
        incoming.set(e.target, at);
    }
    const testLinks = linkTestsForGraph(graph);
    return { inDegree, incoming, testLinks };
}
function pushUniqueAreaTestFile(area, changedTests, testFile, isCompanion = false) {
    if (!area.testFiles.includes(testFile))
        area.testFiles.push(testFile);
    if (changedTests.has(testFile) && !area.changedTestFiles.includes(testFile))
        area.changedTestFiles.push(testFile);
    if (isCompanion && !area.companionTestFiles.includes(testFile))
        area.companionTestFiles.push(testFile);
}
function recordChangedAreaNode(node, path, incoming, changedTests, inDegree, testLinks, area, areaCandidates) {
    const behavioural = node.kind === "function" || node.kind === "method" || node.kind === "class";
    const from = incoming.get(node.id) ?? new Set();
    for (const t of from)
        pushUniqueAreaTestFile(area, changedTests, t);
    if (testLinks) {
        for (const { testFile, kind } of testLinks.testsForSymbol(node.id, path, true))
            pushUniqueAreaTestFile(area, changedTests, testFile, kind === "module_import" || kind === "stem_companion");
    }
    areaCandidates.push({ name: node.name, behavioural, degree: inDegree.get(node.id) ?? 0 });
    if (!behavioural)
        return;
    area.behavioural++;
    if (from.size > 0)
        area.reached++;
    else
        area.unreached.push(node.name);
}
function buildChangedArea(dir, paths, seedNodes, incoming, changedTests, inDegree, testLinks) {
    const area = {
        label: dir, labelSource: "symbol", key: dir,
        files: [], seeds: 0, tests: "none", testFiles: [], changedTestFiles: [],
        companionTestFiles: [],
        reached: 0, behavioural: 0, unreached: [], seedNames: [],
    };
    const areaCandidates = [];
    for (const path of paths) {
        const nodes = seedNodes.get(path) ?? [];
        area.files.push(path);
        area.seeds += nodes.length;
        for (const node of nodes)
            recordChangedAreaNode(node, path, incoming, changedTests, inDegree, testLinks, area, areaCandidates);
    }
    area.seedNames = areaCandidates
        .sort((a, b) => Number(b.behavioural) - Number(a.behavioural) || b.degree - a.degree || a.name.localeCompare(b.name))
        .map((c) => c.name);
    return area;
}
/**
 * Group the changed files into areas, and work out whether each one's tests moved.
 */
function changedAreas(graph, changed, seedNodes, index, modules) {
    const changedTests = new Set(changed.filter((c) => isTestPath(c.path)).map((c) => c.path));
    const { inDegree, incoming, testLinks } = collectBlastTestIncoming(graph);
    const groups = new Map();
    for (const path of seedNodes.keys()) {
        if (isTestPath(path))
            continue;
        const dir = dirLabel(path);
        pushMap(groups, dir, path);
    }
    coarsen(groups, MAX_AREAS);
    const byKey = new Map();
    const reachByArea = new Map();
    for (const [dir, paths] of groups) {
        const area = buildChangedArea(dir, paths, seedNodes, incoming, changedTests, inDegree, testLinks);
        byKey.set(dir, area);
        const concept = sharedConcept(area.files, index);
        area.label = concept ?? hubLabel(area.seedNames, area.key);
        area.labelSource = concept ? "concept" : "symbol";
        area.files.sort();
        area.testFiles.sort();
        area.changedTestFiles.sort();
        area.companionTestFiles.sort();
        area.tests =
            area.behavioural === 0 ? "na"
                : area.changedTestFiles.length > 0 ? "changed"
                    : area.testFiles.length > 0 ? "stale"
                        : "none";
        const fileSet = new Set(area.files);
        reachByArea.set(area, modules.filter((m) => m.from.some((f) => fileSet.has(f))).length);
    }
    return [...byKey.values()].sort((a, b) => (reachByArea.get(b) ?? 0) - (reachByArea.get(a) ?? 0) || b.files.length - a.files.length || a.label.localeCompare(b.label));
}
function collectBlastHealthHotspots(contextDir, changed, impacted) {
    const stateFile = contextDir ? join(contextDir, ".health", "state.json") : "";
    if (!stateFile || !existsSync(stateFile)) return [];
    const state = readJson(stateFile);
    if (!state || typeof state !== "object") return [];
    const changedSet = new Set(changed.map((c) => c.path));
    const impactedSet = new Set(
        impacted.filter((i) => i.depth === 1 && !changedSet.has(i.path)).map((i) => i.path),
    );
    const byFile = new Map();
    for (const iss of Object.values(state.issues || {})) {
        if (iss.status !== "open" || iss.suppressed || !iss.file) continue;
        const role = changedSet.has(iss.file)
            ? "changed"
            : impactedSet.has(iss.file)
              ? "impacted"
              : null;
        if (!role) continue;
        let entry = byFile.get(iss.file);
        if (!entry) {
            entry = { file: iss.file, role, count: 0, max_tier: "T1", issues: [] };
            byFile.set(iss.file, entry);
        }
        entry.count += 1;
        if (String(iss.tier || "T1") > String(entry.max_tier || "T1")) {
            entry.max_tier = iss.tier || "T2";
        }
        if (entry.issues.length < 5) {
            entry.issues.push({
                id: iss.id,
                detector: iss.detector,
                tier: iss.tier,
                severity: iss.severity,
                span: iss.span,
                summary: iss.summary,
            });
        }
    }
    return [...byFile.values()].sort(
        (a, b) =>
            (a.role === "changed" ? 0 : 1) - (b.role === "changed" ? 0 : 1) ||
            b.count - a.count ||
            a.file.localeCompare(b.file),
    );
}

function loadLayerRules(contextDir, opts = {}) {
    if (Array.isArray(opts.layerRules))
        return opts.layerRules.map(parseLayerRuleEntry).filter(Boolean);
    if (Array.isArray(opts.layer_rules))
        return opts.layer_rules.map(parseLayerRuleEntry).filter(Boolean);
    if (!contextDir)
        return [];
    const cfgFile = join(contextDir, ".health", "config.json");
    const planFile = join(contextDir, ".health", "plan.json");
    const parsedCfg = existsSync(cfgFile) ? readJson(cfgFile) : null;
    const parsedPlan = existsSync(planFile) ? readJson(planFile) : null;
    const rawEntries = [
        ...(Array.isArray(parsedCfg?.layer_rules) ? parsedCfg.layer_rules : []),
        ...(Array.isArray(parsedCfg?.layerRules) ? parsedCfg.layerRules : []),
        ...(Array.isArray(parsedPlan?.policies) ? parsedPlan.policies : []),
        ...(Array.isArray(parsedCfg?.policies) ? parsedCfg.policies : []),
    ];
    return rawEntries.map(parseLayerRuleEntry).filter(Boolean);
}

function compileBlastLayerRules(rules) {
    const compiledRules = [];
    for (const rawRule of rules) {
        const rule = parseLayerRuleEntry(rawRule);
        const toList = rule ? (Array.isArray(rule.to) ? rule.to : rule.to ? [rule.to] : []) : [];
        if (!rule?.from || toList.length === 0)
            continue;
        compiledRules.push({
            ruleFrom: rule.from,
            fromRe: globToRegExp(rule.from),
            toRes: toList.map((t) => ({ ruleTo: t, re: globToRegExp(t) })),
            allowTypeOnly: Boolean(rule.allowTypeOnly),
            reason: rule.reason,
        });
    }
    return compiledRules;
}

function recordEdgeLayerViolations(e, sourceFile, targetFile, compiledRules, seen, violations) {
    const normSource = toPosixPath(sourceFile).replace(/^\.\//, "");
    const normTarget = toPosixPath(targetFile).replace(/^\.\//, "");
    for (const rule of compiledRules) {
        if ((rule.allowTypeOnly && e.typeOnly) || !rule.fromRe.test(normSource))
            continue;
        for (const { ruleTo, re } of rule.toRes) {
            if (!re.test(normTarget))
                continue;
            const key = `${sourceFile}\0${targetFile}\0${rule.ruleFrom}\0${ruleTo}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            violations.push({
                sourceFile,
                targetFile,
                relation: e.relation,
                ruleFrom: rule.ruleFrom,
                ruleTo,
                reason: rule.reason ?? `${rule.ruleFrom} cannot depend on ${ruleTo}`,
            });
        }
    }
}

function collectLayerViolations(graph, changed, rules) {
    if (!Array.isArray(rules) || rules.length === 0 || !graph?.edges || !graph?.nodes)
        return [];
    const changedSet = new Set(changed.filter((c) => c.status !== "deleted").map((c) => c.path));
    const compiledRules = changedSet.size > 0 ? compileBlastLayerRules(rules) : [];
    if (compiledRules.length === 0)
        return [];
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const violations = [];
    const seen = new Set();
    for (const e of graph.edges) {
        if (e.relation === "contains")
            continue;
        const sourceFile = byId.get(e.source)?.path ?? (byId.has(e.source) ? e.source : null);
        const targetFile = byId.get(e.target)?.path ?? (byId.has(e.target) ? e.target : null);
        if (sourceFile && targetFile && sourceFile !== targetFile && changedSet.has(sourceFile))
            recordEdgeLayerViolations(e, sourceFile, targetFile, compiledRules, seen, violations);
    }
    return violations.sort(
        (a, b) =>
            a.sourceFile.localeCompare(b.sourceFile) ||
            a.targetFile.localeCompare(b.targetFile) ||
            a.ruleFrom.localeCompare(b.ruleFrom) ||
            a.ruleTo.localeCompare(b.ruleTo),
    );
}

/** Convenience wrapper: build the module index from a context dir. */
export function blastRadiusIn(graph, contextDir, changed, basisOrOpts, depthArg, optsArg = {}) {
    const bagMode = basisOrOpts !== null && typeof basisOrOpts === "object";
    const opts = bagMode ? basisOrOpts : optsArg;
    const basis = bagMode ? (opts.basis ?? "working-tree") : basisOrOpts;
    const depth = bagMode ? opts.depth : depthArg;
    const parsedDepth = parseWalkDepth(depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    const rootDir = opts.rootDir ?? (contextDir ? dirname(resolve(contextDir)) : null);
    const res = blastRadius(graph, changed, basis, { depth: parsedDepth, modules: moduleIndex(contextDir), rootDir, baseRef: opts.baseRef });
    const hotspots = collectBlastHealthHotspots(contextDir, changed, res.impacted);
    if (hotspots.length > 0) {
        res.healthHotspots = hotspots;
    }
    const history = opts.includeHistory === false
        ? null
        : (opts.gitHistory ??
            (rootDir && existsSync(rootDir)
                ? analyzeGitHistory(rootDir, contextDir, opts.since ? { since: opts.since } : undefined)
                : null));
    if (history) {
        const coChanges = untouchedCoChanges(history, changed.map((c) => c.path), graph);
        if (coChanges.length > 0) {
            res.coChanges = coChanges;
        }
    }
    const rules = loadLayerRules(contextDir, opts);
    if (rules.length > 0) {
        const violations = collectLayerViolations(graph, changed, rules);
        if (violations.length > 0) {
            res.layerViolations = violations;
        }
    }
    return res;
}
function hasNode(h) {
    // Unresolved endpoints (an import module string no node exists for) carry no
    // location, so they can neither be grouped nor opened — dropped rather than
    // rendered as a box with no file behind it.
    return h.node !== null;
}
function toImpacted(h, typeOnly = false) {
    const isTypeOnly = Boolean(h.typeOnly || typeOnly);
    return {
        id: h.node.id, name: h.node.name, kind: h.node.kind,
        path: h.node.path, span: h.node.span, relation: h.relation, depth: h.depth,
        ...(isTypeOnly ? { typeOnly: true } : {}),
    };
}
function emptyIndex() {
    return { hasConcepts: false, labelOf: (p) => p, conceptOf: () => null };
}
/**
 * The concept claiming EVERY file in a cluster, or null when they disagree.
 *
 * Unanimity is the point: a concept that covers three of five files describes
 * something narrower than the cluster, and stamping its name on the whole thing is
 * how a diagram starts lying about what it drew.
 */
function sharedConcept(paths, index) {
    const concepts = new Set(paths.map((p) => index.conceptOf(p)));
    const [only] = concepts;
    return concepts.size === 1 && only ? shortLabel(only) : null;
}
/**
 * The deterministic backstop label: the cluster's most significant symbol.
 *
 * Reached with no concept, no cache and no API key, so this is what guarantees a
 * circle never carries a bare directory. It is a fact rather than a guess — the
 * reviewer can grep the name — which is why it beats borrowing a neighbouring
 * concept: on plexer's own graph that borrowing labelled the freshness gate
 * "Graph Extraction and Loading", which misleads worse than any path.
 */
function hubLabel(names, fallback) {
    const [head] = names.filter(Boolean);
    // The hub alone, with no "+8" tail: how many symbols came with it is already the
    // circle's second line and the table's own column, and repeating it in the label
    // turned "writeGraph" into "writeGraph +8", which reads as a version number.
    return head ? shortLabel(head) : fallback;
}
/**
 * Group dependents into modules. `origins` carries, per dependent, the changed
 * files whose walk actually reached it — so a module's `from` is the real arrow
 * set, not every changed file in the PR.
 */
function groupByModule(impacted, changed, origins, modules) {
    const changedPaths = new Set(changed.map((c) => c.path));
    const byKey = new Map();
    for (const hit of impacted) {
        // A dependent inside a file the PR already changes is not "reach" — it is the
        // diff. Reviewers see it in the diff itself; repeating it as blast radius is
        // what makes these comments feel like noise.
        if (changedPaths.has(hit.path))
            continue;
        // Cluster by concept where one exists, else by directory. Clustering and
        // LABELLING are separate steps now: the key only has to be stable, while the
        // label goes through the ladder below and may end up naming a symbol.
        const key = modules.conceptOf(hit.path) ?? dirLabel(hit.path);
        let mod = byKey.get(key);
        if (!mod) {
            mod = { label: key, labelSource: "symbol", key, files: [], symbols: [], from: [] };
            byKey.set(key, mod);
        }
        mod.symbols.push(hit);
        if (!mod.files.includes(hit.path))
            mod.files.push(hit.path);
    }
    for (const mod of byKey.values()) {
        const from = new Set();
        for (const s of mod.symbols)
            for (const p of origins.get(s.id) ?? [])
                from.add(p);
        mod.from = [...from].sort();
        mod.files.sort();
        mod.symbols.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
        // Shallowest symbol first after that sort, so it is the cluster's hub: the
        // thing one hop from the diff rather than an arbitrary member.
        const concept = sharedConcept(mod.files, modules);
        mod.label = concept ?? hubLabel(mod.symbols.map((s) => s.name), mod.key);
        mod.labelSource = concept ? "concept" : "symbol";
    }
    // Test-only modules are separated, not just sorted last. On a repo with a test
    // per module they are the majority of the graph's dependents — plexer's own 24-file
    // PR produced 31 modules, 24 of them a single test file — so leaving them in the
    // same list means they crowd out every module a reviewer needs whatever the caps
    // are. "Your tests reference the thing you changed" is one line, not 24 sections.
    const bySize = (a, b) => b.symbols.length - a.symbols.length || a.label.localeCompare(b.label);
    const all = [...byKey.values()];
    return {
        modules: all.filter((m) => !isTestOnly(m)).sort(bySize),
        testModules: all.filter(isTestOnly).sort(bySize),
    };
}
/**
 * Directory groups the diff is folded down to before anything is drawn.
 *
 * Kept here rather than in the renderer because it is a statement about the diff,
 * not about the picture: five areas is roughly what a reviewer holds in their head,
 * and the renderer then draws all of them.
 */
const MAX_AREAS = 5;
/**
 * Fold directory groups into their parents until there are at most `max`.
 *
 * The deepest group goes first, and only into a parent that already exists, so
 * `src/ai/llm/` joins `src/ai/` rather than everything collapsing towards the repo
 * root. When no group has an existing parent, one is created — but never at the top
 * level, since a single `(root)` area is no grouping at all.
 */
function coarsen(groups, max) {
    const depth = (dir) => dir.split("/").length;
    while (groups.size > max) {
        const keys = [...groups.keys()].sort((a, b) => depth(b) - depth(a) || (groups.get(a).length - groups.get(b).length));
        const pick = keys.find((k) => groups.has(parentDir(k)) && parentDir(k) !== "") ??
            keys.find((k) => parentDir(k) !== "");
        if (!pick)
            return;
        const parent = parentDir(pick);
        groups.set(parent, [...(groups.get(parent) ?? []), ...groups.get(pick)]);
        groups.delete(pick);
    }
}
/** True when every file in the module is a test file. */
function isTestOnly(mod) {
    return mod.files.length > 0 && mod.files.every((f) => isTestPath(f));
}
