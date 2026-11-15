/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence is a two-tier provenance model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { ensureMapSet, GENERIC_MEMBER_NAMES, isCompoundIdentifierName } from "../util/id.js";
import { isTestPath, pathUnderPrefix, pushMap, toPosixPath } from "../util/paths.js";
import { containerLangOf } from "./container.js";
import { languageOf } from "./extract.js";
import { genericLangOf } from "./generic.js";
import { resolveLuauEdges } from "./luau.js";
const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".vue", ".svelte", ".astro"];
const MAX_BARREL_HOPS = 6;
const MAX_GO_STRUCTURAL_MATCHES = 12;
const MAX_CHA_DISPATCH_TARGETS = 24;
/** C/C++ source + header extensions, for resolving `#include` targets. */
const C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|inl|ipp|c\+\+|h\+\+)$/i;
/** Python source + stub extensions, for the constructor-call fallback below. */
const PY_EXT = /\.pyi?$/i;
/** What a bare Python call falls back to when no function of that name exists:
 * construction. Only `class` — Python enums, dataclasses and NamedTuples are all
 * classes, so no other kind is reachable this way. */
const PY_CTOR_KINDS = ["class"];
/** Swift is Python's case with more nominal kinds: `Animal(legs: 4)` is an ordinary
 * call node with no `new` to mark construction, and struct/enum initializers are as
 * routine as class ones (a struct gets a memberwise init for free). Same fallback
 * shape — types are tried only once functions (and methods, see extract.js's
 * implicit-self widening) have found nothing. */
const SWIFT_EXT = /\.swift$/i;
const SWIFT_CTOR_KINDS = ["class", "struct", "enum"];
/**
 * Languages whose symbols can genuinely reach each other. A call edge may not
 * cross a family boundary.
 *
 * This exists because name resolution is repo-wide and used to be language-blind.
 * A Go file calling the builtin `make(...)` has nothing in the repo to resolve
 * against, so the unique-global fallback below matched a TypeScript helper named
 * `make` in a frontend test file — and then every `make(map[...])` in the backend
 * became an edge into that file. One symbol collected 1040 in-edges across 476
 * files, and any pull request touching that test dragged the entire Go backend
 * into its blast radius. Uniqueness is what made it fire: the rarer the collision,
 * the more confident the old code was that it had found the right target.
 *
 * Only real interop is grouped here. TS/TSX/JS import each other freely; Kotlin,
 * Scala and Clojure compile against Java on one classpath; C and C++ share
 * headers. Everything else stands alone.
 */
const FAMILIES = [
    ["typescript", "tsx"],
    ["java", "kotlin", "scala", "clojure"],
    ["c", "cpp"],
];
const FAMILY_OF = new Map();
for (const group of FAMILIES)
    for (const lang of group)
        FAMILY_OF.set(lang, group[0]);
/**
 * The language family a path belongs to, or null when no tier claims the file.
 * A language of its own is its own family, so the common case needs no entry above.
 */
function familyOf(path) {
    const lang = languageOf(path) ?? containerLangOf(path)?.inner ?? genericLangOf(path)?.name ?? null;
    if (!lang)
        return null;
    return FAMILY_OF.get(lang) ?? lang;
}
/**
 * Could a reference in `file` reach a definition in `candidatePath`?
 *
 * An unknown family never filters: absence of data is not evidence of a mismatch,
 * and refusing edges for every extension plexer cannot name would lose real ones.
 */
export function reachable(file, candidatePath) {
    const from = familyOf(file);
    if (from === null)
        return true;
    const to = familyOf(candidatePath);
    return to === null || from === to;
}
function indexPathSuffixes(map, path) {
    const parts = toPosixPath(path).split("/");
    for (let i = 0; i < parts.length; i++)
        pushMap(map, parts.slice(i).join("/"), path);
}
function addGoPackageFiles(set, filePath, goFilesByDir) {
    if (!filePath?.endsWith(".go"))
        return;
    const pkgFiles = goFilesByDir.get(posix.dirname(toPosixPath(filePath)));
    if (!pkgFiles)
        return;
    for (const pf of pkgFiles) {
        if (!pf.endsWith("_test.go"))
            set.add(pf);
    }
}
function collectDirectImports(rawEdges, resIdx, opts) {
    const { byId, goFilesByDir } = resIdx;
    const directImports = new Map();
    for (const e of rawEdges) {
        if (e.file?.endsWith(".luau"))
            continue;
        if (e.relation !== "imports" || !e.specifier || !e.file)
            continue;
        const set = ensureMapSet(directImports, e.file);
        addGoPackageFiles(set, e.file, goFilesByDir);
        const target = resolveImportTargetForFile(e.specifier, e.file, resIdx, opts, e.isRustMod);
        if (byId.has(target)) {
            set.add(target);
            addGoPackageFiles(set, target, goFilesByDir);
        }
    }
    return directImports;
}
function expandSingleFileImportClosure(directSet, directImports, resIdx, opts) {
    const { byId, goFilesByDir, reexportsByFile } = resIdx;
    const closure = new Set(directSet);
    const queue = [];
    const visitedBarrels = new Set();
    for (const imp of directSet) {
        queue.push({ path: imp, hops: 0 });
        visitedBarrels.add(imp);
        for (const hop of directImports.get(imp) ?? [])
            closure.add(hop);
    }
    let head = 0;
    while (head < queue.length) {
        const { path: cur, hops } = queue[head++];
        if (hops >= MAX_BARREL_HOPS)
            continue;
        for (const r of reexportsByFile.get(cur) ?? []) {
            const next = resolveImportTargetForFile(r.specifier, cur, resIdx, opts);
            if (!byId.has(next))
                continue;
            closure.add(next);
            addGoPackageFiles(closure, next, goFilesByDir);
            if (!visitedBarrels.has(next)) {
                visitedBarrels.add(next);
                queue.push({ path: next, hops: hops + 1 });
            }
        }
    }
    return closure;
}
function buildImportedFilesClosure(rawEdges, resIdx, opts) {
    const directImports = collectDirectImports(rawEdges, resIdx, opts);
    const closureByFile = new Map();
    for (const [file, directSet] of directImports) {
        closureByFile.set(file, expandSingleFileImportClosure(directSet, directImports, resIdx, opts));
    }
    return closureByFile;
}

function addTypeHierarchyEdge(typeHierarchy, childName, parentName) {
    if (!childName || !parentName || childName === parentName)
        return;
    let parents = typeHierarchy.parents.get(childName);
    if (!parents)
        typeHierarchy.parents.set(childName, (parents = new Set()));
    parents.add(parentName);
    let children = typeHierarchy.children.get(parentName);
    if (!children)
        typeHierarchy.children.set(parentName, (children = new Set()));
    children.add(childName);
}

function collectGoTypesAndMethods(nodes) {
    const goInterfaces = new Map();
    const goConcreteMethods = new Map();
    const goConcreteTypes = new Set();
    for (const n of nodes) {
        if (!n.path?.endsWith(".go"))
            continue;
        if (n.kind === "interface") {
            if (!goInterfaces.has(n.name))
                goInterfaces.set(n.name, new Set());
        }
        else if (n.kind === "struct" || n.kind === "type") {
            goConcreteTypes.add(n.name);
        }
        else if (n.kind === "method") {
            const owner = n.owner ?? ownerFromMethodId(n.id);
            if (!owner)
                continue;
            const ifaceMethods = goInterfaces.get(owner);
            if (ifaceMethods) {
                ifaceMethods.add(n.name);
            }
            else {
                let mset = goConcreteMethods.get(owner);
                if (!mset)
                    goConcreteMethods.set(owner, (mset = new Set()));
                mset.add(n.name);
            }
        }
    }
    return { goInterfaces, goConcreteMethods, goConcreteTypes };
}

function reconcileGoInterfacesAndConcrete(goInterfaces, goConcreteMethods, goConcreteTypes) {
    for (const [owner, mset] of goConcreteMethods) {
        const ifaceMethods = goInterfaces.get(owner);
        if (ifaceMethods) {
            for (const m of mset)
                ifaceMethods.add(m);
            goConcreteMethods.delete(owner);
        }
        else {
            goConcreteTypes.add(owner);
        }
    }
}

function goConcreteSatisfiesInterface(hasMethods, reqMethods) {
    if (!hasMethods || hasMethods.size < reqMethods.size)
        return false;
    for (const m of reqMethods) {
        if (!hasMethods.has(m))
            return false;
    }
    return true;
}

function buildGoStructuralHierarchy(nodes, typeHierarchy) {
    const { goInterfaces, goConcreteMethods, goConcreteTypes } = collectGoTypesAndMethods(nodes);
    reconcileGoInterfacesAndConcrete(goInterfaces, goConcreteMethods, goConcreteTypes);
    for (const [ifaceName, reqMethods] of goInterfaces) {
        if (reqMethods.size === 0)
            continue;
        const matches = [];
        for (const concreteName of goConcreteTypes) {
            if (goConcreteSatisfiesInterface(goConcreteMethods.get(concreteName), reqMethods))
                matches.push(concreteName);
        }
        if (matches.length >= 1 && matches.length <= MAX_GO_STRUCTURAL_MATCHES) {
            for (const match of matches)
                addTypeHierarchyEdge(typeHierarchy, match, ifaceName);
        }
    }
}
function indexFileResolutionNode(n, resIdx) {
    if (resIdx.hasGoModules && n.path.endsWith(".go")) {
        pushMap(resIdx.goFilesByDir, posix.dirname(toPosixPath(n.path)), n.id);
    }
    if (n.path.endsWith(".java")) indexPathSuffixes(resIdx.javaFilesBySuffix, n.id);
    if (C_EXT.test(n.path)) indexPathSuffixes(resIdx.cFilesBySuffix, n.id);
    if (n.path.endsWith(".php")) indexPathSuffixes(resIdx.phpFilesBySuffix, n.id);
    if (BREADTH_IMPORT_EXT.test(n.path)) indexPathSuffixes(resIdx.breadthFilesBySuffix, n.id);
    const p = toPosixPath(n.path);
    if (p === "lib.rs" || p === "main.rs") resIdx.rustCrateRoots.push("");
    else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs")) resIdx.rustCrateRoots.push(posix.dirname(p));
}

function indexSymbolResolutionNode(n, resIdx) {
    if (n.kind === "interface" || n.kind === "trait") resIdx.interfaceTypes.add(n.name);
    if (n.defaultExport || n.name === "default") pushMap(resIdx.defaultExportsByFile, n.path, n);
    pushMap(resIdx.globalName, n.name, n);
    let fileMap = resIdx.perFileName.get(n.path);
    if (!fileMap) resIdx.perFileName.set(n.path, (fileMap = new Map()));
    pushMap(fileMap, n.name, n);
    if (n.kind === "method") {
        const owner = n.owner ?? ownerFromMethodId(n.id);
        if (owner) pushMap(resIdx.ownerMethod, `${owner}.${n.name}`, n);
    }
    if (n.kind === "method" || n.kind === "function") {
        pushMap(resIdx.callableByName, n.name, n);
        if (n.name.includes(".")) {
            const leaf = n.name.slice(n.name.lastIndexOf(".") + 1);
            if (leaf) pushMap(resIdx.callableByName, leaf, n);
        }
    }
}

function indexHierarchyAndReexports(rawEdges, resIdx) {
    for (const e of rawEdges) {
        if (e.relation === "extends" && e.name) {
            const ownName = resIdx.byId.get(e.source)?.name;
            if (ownName) {
                pushMap(resIdx.classParents, ownName, e.name);
                addTypeHierarchyEdge(resIdx.typeHierarchy, ownName, e.name);
            }
        } else if (e.relation === "implements" && e.name) {
            const ownName = e.ownerName ?? resIdx.byId.get(e.source)?.name;
            if (ownName) {
                addTypeHierarchyEdge(resIdx.typeHierarchy, ownName, e.name);
                if (e.file.endsWith(".php")) pushMap(resIdx.classTraits, ownName, e.name);
            }
        } else if (e.relation === "reexports" && e.specifier) {
            pushMap(resIdx.reexportsByFile, e.source, e);
        }
    }
}

function buildResolutionIndex(nodes, rawEdges, opts) {
    const resIdx = {
        byId: new Map(nodes.map((n) => [n.id, n])),
        globalName: new Map(),
        perFileName: new Map(),
        ownerMethod: new Map(),
        callableByName: new Map(),
        goFilesByDir: new Map(),
        javaFilesBySuffix: new Map(),
        cFilesBySuffix: new Map(),
        rustCrateRoots: [],
        phpFilesBySuffix: new Map(),
        breadthFilesBySuffix: new Map(),
        defaultExportsByFile: new Map(),
        interfaceTypes: new Set(),
        typeHierarchy: { parents: new Map(), children: new Map() },
        classParents: new Map(),
        classTraits: new Map(),
        reexportsByFile: new Map(),
        hasGoModules: !!opts.goModules?.length,
        importedFilesByFile: null,
    };
    for (const n of nodes) {
        if (n.kind === "file") indexFileResolutionNode(n, resIdx);
        else indexSymbolResolutionNode(n, resIdx);
    }
    indexHierarchyAndReexports(rawEdges, resIdx);
    buildGoStructuralHierarchy(nodes, resIdx.typeHierarchy);
    resIdx.importedFilesByFile = buildImportedFilesClosure(rawEdges, resIdx, opts);
    return resIdx;
}
const BREADTH_IMPORT_EXT = /\.(?:rb|cs|scala|sc|ex|exs|dart|lua|clj|cljc|cljs|nix|sol)$/i;
function resolveImportTargetForFile(spec, file, resIdx, opts, isRustMod = false) {
    if (resIdx.hasGoModules && file.endsWith(".go"))
        return resolveGoImport(spec, opts.goModules, resIdx.goFilesByDir);
    if (file.endsWith(".java"))
        return resolveJavaImport(spec, resIdx.javaFilesBySuffix);
    if (C_EXT.test(file))
        return resolveCInclude(spec, file, resIdx.byId, resIdx.cFilesBySuffix);
    if (file.endsWith(".rs")) {
        if (isRustMod) {
            const hit = resolveRustUse(`self::${spec}`, file, resIdx.byId, resIdx.rustCrateRoots);
            return hit === `self::${spec}` ? spec : hit;
        }
        return resolveRustUse(spec, file, resIdx.byId, resIdx.rustCrateRoots);
    }
    if (file.endsWith(".php"))
        return resolvePhpUse(spec, resIdx.phpFilesBySuffix);
    if (BREADTH_IMPORT_EXT.test(file))
        return resolveBreadthImport(spec, file, resIdx.byId, resIdx.breadthFilesBySuffix);
    return resolveImport(spec, file, resIdx.byId, resIdx, opts);
}
function resolveNamedReexports(reexports, targetFile, wantedExportName, kinds, resIdx, opts, nextVisited) {
    for (const r of reexports) {
        if (r.exportedName !== wantedExportName) continue;
        const nextFile = resolveImportTargetForFile(r.specifier, targetFile, resIdx, opts);
        if (!resIdx.byId.has(nextFile)) continue;
        if (r.star && !kinds) {
            const targetFileNode = resIdx.byId.get(nextFile);
            if (targetFileNode) return { node: targetFileNode, typeOnly: Boolean(r.typeOnly) };
        }
        if (r.star) continue;
        const nextIsDefault = Boolean(r.isDefault || r.localName === "default");
        const hit = resolveExportedSymbolInFile(nextFile, r.localName || wantedExportName, kinds, resIdx, opts, nextVisited, nextIsDefault);
        if (hit) return { node: hit.node, typeOnly: Boolean(r.typeOnly || hit.typeOnly) };
    }
    return null;
}

function resolveStarReexports(reexports, targetFile, name, kinds, resIdx, opts, nextVisited) {
    const starHits = new Map();
    for (const r of reexports) {
        if (!r.star || r.exportedName) continue;
        const nextFile = resolveImportTargetForFile(r.specifier, targetFile, resIdx, opts);
        if (!resIdx.byId.has(nextFile)) continue;
        const hit = resolveExportedSymbolInFile(nextFile, name, kinds, resIdx, opts, nextVisited, false);
        if (!hit) continue;
        const prev = starHits.get(hit.node.id);
        const combinedTypeOnly = Boolean(r.typeOnly || hit.typeOnly);
        if (!prev || (prev.typeOnly && !combinedTypeOnly)) {
            starHits.set(hit.node.id, { node: hit.node, typeOnly: combinedTypeOnly });
        }
    }
    return starHits.size === 1 ? [...starHits.values()][0] : null;
}

function resolveExportedSymbolInFile(targetFile, name, kinds, resIdx, opts, visited = new Set(), isDefault = false) {
    if (visited.size >= MAX_BARREL_HOPS || visited.has(targetFile) || !resIdx.byId.has(targetFile)) return null;
    const matchDefault = isDefault || name === "default";
    const allInFile = matchDefault
        ? (resIdx.defaultExportsByFile?.get(targetFile) ?? [])
        : (resIdx.perFileName.get(targetFile)?.get(name) ?? []);
    let candidates = kinds ? allInFile.filter((n) => kinds.includes(n.kind)) : allInFile;
    if (candidates.length === 0 && allInFile.length === 1) candidates = allInFile;
    if (candidates.length === 1) return { node: candidates[0], typeOnly: false };
    if (candidates.length > 1) return null;
    const reexports = resIdx.reexportsByFile?.get(targetFile);
    if (!reexports || reexports.length === 0) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(targetFile);
    const namedHit = resolveNamedReexports(reexports, targetFile, matchDefault ? "default" : name, kinds, resIdx, opts, nextVisited);
    if (namedHit || matchDefault) return namedHit;
    return resolveStarReexports(reexports, targetFile, name, kinds, resIdx, opts, nextVisited);
}
function resolveReferenceEdge(e, resIdx, emitResolvedEdge, opts) {
    const { byId, perFileName, globalName } = resIdx;
    if (e.specifier) {
        const targetFile = resolveImportTargetForFile(e.specifier, e.file, resIdx, opts);
        if (!byId.has(targetFile))
            return;
        const found = resolveExportedSymbolInFile(targetFile, e.name, null, resIdx, opts, new Set(), Boolean(e.isDefault));
        if (found)
            emitResolvedEdge(e.source, found.node.id, "references", "extracted", Boolean(e.typeOnly || found.typeOnly));
    }
    else if (e.file.endsWith(".php") && byId.get(e.source)?.origin === "ast") {
        const refKinds = ["class", "interface", "trait", "enum"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source)
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence, Boolean(e.typeOnly));
    }
    else if (e.file.endsWith(".java") && byId.get(e.source)?.origin === "ast") {
        const hit = resolveName(e.name, e.file, ["interface"], perFileName, globalName);
        const anno = hit ? byId.get(hit.id) : undefined;
        if (hit && hit.id !== e.source && anno?.signature?.includes("@interface"))
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence, Boolean(e.typeOnly));
        else
            emitResolvedEdge(e.source, e.name, "references", "inferred", Boolean(e.typeOnly));
    }
    else if (byId.get(e.source)?.origin === "generic") {
        const refKinds = ["class", "interface", "struct", "enum", "type", "module"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source)
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence, Boolean(e.typeOnly));
    }
}
function resolveImportedMemberCall(e, resIdx, emitResolvedEdge, opts) {
    const { byId, perFileName, goFilesByDir } = resIdx;
    let targetFile = resolveImportTargetForFile(e.specifier, e.file, resIdx, opts);
    if (!byId.has(targetFile) && e.fallbackSpecifier) {
        targetFile = resolveImportTargetForFile(e.fallbackSpecifier, e.file, resIdx, opts);
    }
    if (!byId.has(targetFile))
        return false;
    if (e.file.endsWith(".go")) {
        const pkgDir = posix.dirname(toPosixPath(targetFile));
        const pkgFiles = (goFilesByDir.get(pkgDir) ?? [targetFile]).filter((f) => !f.endsWith("_test.go"));
        const matches = [];
        for (const pf of pkgFiles) {
            const inFile = (perFileName.get(pf)?.get(e.name) ?? []).filter((n) => n.kind === "function" || n.kind === "struct" || n.kind === "interface" || n.kind === "type");
            matches.push(...inFile);
        }
        if (matches.length === 1) {
            emitResolvedEdge(e.source, matches[0].id, "calls", "extracted", Boolean(e.typeOnly));
            return true;
        }
        return matches.length > 1;
    }
    let searchFile = targetFile;
    if (e.subModule) {
        const subReexport = (resIdx.reexportsByFile?.get(targetFile) ?? []).find((r) => r.exportedName === e.subModule);
        const nextFile = subReexport
            ? resolveImportTargetForFile(subReexport.specifier, targetFile, resIdx, opts)
            : resolveImportTargetForFile(`./${e.subModule}`, targetFile, resIdx, opts);
        if (byId.has(nextFile))
            searchFile = nextFile;
    }
    const found = resolveExportedSymbolInFile(searchFile, e.name, ["function", "method", "class"], resIdx, opts);
    if (found) {
        emitResolvedEdge(e.source, found.node.id, "calls", "extracted", Boolean(e.typeOnly || found.typeOnly));
        return true;
    }
    return false;
}

const STRICT_NOMINAL_METHOD_EXT = /\.(?:go|java|cs|swift|kt|scala|rs|c|h|cc|cpp|cxx|hpp|hh)$/i;

function resolveUniqueUntypedMember(e, resIdx) {
    if (!e.name || e.name.length < 4 || GENERIC_MEMBER_NAMES.has(e.name.toLowerCase()))
        return null;
    const raw = resIdx.callableByName?.get(e.name);
    if (!raw || raw.length === 0)
        return null;
    const strictMethodsOnly = STRICT_NOMINAL_METHOD_EXT.test(e.file);
    const callerIsTest = isTestPath(e.file);
    const reachableCands = raw.filter((c) => {
        if (c.id === e.source || !reachable(e.file, c.path))
            return false;
        if (!callerIsTest && isTestPath(c.path))
            return false;
        if (strictMethodsOnly && c.kind !== "method")
            return false;
        if (c.path === e.file && c.kind === "function" && !c.owner)
            return false;
        return true;
    });
    if (reachableCands.length === 0)
        return null;
    const impSet = resIdx.importedFilesByFile?.get(e.file);
    let sameGoPkgSet = null;
    if (e.file.endsWith(".go") && resIdx.goFilesByDir) {
        const pkgFiles = resIdx.goFilesByDir.get(posix.dirname(toPosixPath(e.file)));
        if (pkgFiles)
            sameGoPkgSet = new Set(pkgFiles.filter((f) => !f.endsWith("_test.go")));
    }
    const closureCands = narrowByArity(
        reachableCands.filter((c) => c.path === e.file || impSet?.has(c.path) || sameGoPkgSet?.has(c.path)),
        e.argCount,
    );
    if (closureCands.length === 1)
        return { id: closureCands[0].id, confidence: "inferred" };
    if (closureCands.length > 1)
        return null;
    if (!isCompoundIdentifierName(e.name))
        return null;
    const repoCands = narrowByArity(
        reachableCands.filter((c) => c.kind === "method" || Boolean(c.owner) || Boolean(c.exported) || /\.(?:js|cjs|mjs|ts|tsx|jsx)$/i.test(c.path)),
        e.argCount,
    );
    if (repoCands.length === 1)
        return { id: repoCands[0].id, confidence: "inferred" };
    return null;
}

function resolveFactoryReturnType(e, resIdx, opts) {
    if (!e.factoryName)
        return null;
    const kinds = ["function", "method", "class"];
    if (e.factorySpecifier) {
        const targetFile = resolveImportTargetForFile(e.factorySpecifier, e.file, resIdx, opts);
        if (e.file.endsWith(".go") && resIdx.byId.has(targetFile)) {
            const pkgDir = posix.dirname(toPosixPath(targetFile));
            const pkgFiles = (resIdx.goFilesByDir.get(pkgDir) ?? [targetFile]).filter((f) => !f.endsWith("_test.go"));
            const matches = [];
            for (const pf of pkgFiles) {
                matches.push(...(resIdx.perFileName.get(pf)?.get(e.factoryName) ?? []).filter((n) => n.returnType));
            }
            if (matches.length === 1)
                return matches[0].returnType;
        }
        const found = resolveExportedSymbolInFile(targetFile, e.factoryName, kinds, resIdx, opts, new Set(), Boolean(e.factoryIsDefault));
        return found?.node?.returnType ?? null;
    }
    if (e.factoryOwner) {
        const cands = (resIdx.ownerMethod.get(`${e.factoryOwner}.${e.factoryName}`) ?? []).filter((c) => reachable(e.file, c.path) && c.returnType);
        if (cands.length === 1)
            return cands[0].returnType;
    }
    if (e.file.endsWith(".go") && resIdx.goFilesByDir) {
        const pkgFiles = (resIdx.goFilesByDir.get(posix.dirname(toPosixPath(e.file))) ?? []).filter((f) => !f.endsWith("_test.go"));
        const matches = [];
        for (const pf of pkgFiles) {
            matches.push(...(resIdx.perFileName.get(pf)?.get(e.factoryName) ?? []).filter((n) => n.returnType));
        }
        if (matches.length === 1)
            return matches[0].returnType;
    }
    const hit = resolveName(e.factoryName, e.file, kinds, resIdx.perFileName, resIdx.globalName);
    return hit ? (resIdx.byId.get(hit.id)?.returnType ?? null) : null;
}

function collectSubtypeMethodTargets(baseType, methodName, file, resIdx, argCount, excludeId = null) {
    const childrenMap = resIdx.typeHierarchy?.children;
    if (!childrenMap || !childrenMap.has(baseType))
        return [];
    const visited = new Set([baseType]);
    const queue = [baseType];
    const rawTargets = [];
    const seenIds = new Set();
    let head = 0;
    while (head < queue.length && visited.size <= 64) {
        const cur = queue[head++];
        for (const sub of childrenMap.get(cur) ?? []) {
            if (visited.has(sub))
                continue;
            visited.add(sub);
            queue.push(sub);
            const cands = (resIdx.ownerMethod.get(`${sub}.${methodName}`) ?? []).filter((c) => c.id !== excludeId && reachable(file, c.path));
            if (cands.length > 0) {
                for (const c of narrowByArity(cands, argCount)) {
                    if (!seenIds.has(c.id)) {
                        seenIds.add(c.id);
                        rawTargets.push(c);
                    }
                }
            }
        }
    }
    if (rawTargets.length === 0)
        return [];
    const callerIsTest = isTestPath(file);
    const nonTest = callerIsTest ? rawTargets : rawTargets.filter((c) => !isTestPath(c.path));
    const finalTargets = nonTest.length > 0 ? nonTest : rawTargets;
    return finalTargets.slice(0, MAX_CHA_DISPATCH_TARGETS);
}

function resolveViaMemberCall(e, resIdx, emitResolvedEdge, opts) {
    const { ownerMethod, classParents, classTraits } = resIdx;
    let effectiveRecvType = e.recvType;
    if (e.recvIsDefault && e.recvSpecifier) {
        const targetFile = resolveImportTargetForFile(e.recvSpecifier, e.file, resIdx, opts);
        const defCls = resolveExportedSymbolInFile(targetFile, "default", ["class", "interface", "struct"], resIdx, opts, new Set(), true);
        if (defCls?.node?.name)
            effectiveRecvType = defCls.node.name;
    }
    const factoryRet = resolveFactoryReturnType(e, resIdx, opts);
    if (factoryRet)
        effectiveRecvType = factoryRet;
    if (!effectiveRecvType) {
        if (e.specifier && resolveImportedMemberCall(e, resIdx, emitResolvedEdge, opts))
            return true;
        const inferred = resolveUniqueUntypedMember(e, resIdx);
        if (inferred)
            emitResolvedEdge(e.source, inferred.id, "calls", inferred.confidence, Boolean(e.typeOnly));
        return true;
    }
    const hit = resolveTypedMember(effectiveRecvType, e.name, e.file, ownerMethod, classParents, classTraits, e.argCount, resIdx.typeHierarchy?.parents);
    if (hit && hit !== "ambiguous")
        emitResolvedEdge(e.source, hit.id, "calls", hit.confidence, Boolean(e.typeOnly));
    const subtypeTargets = collectSubtypeMethodTargets(
        effectiveRecvType,
        e.name,
        e.file,
        resIdx,
        e.argCount,
        hit && hit !== "ambiguous" ? hit.id : null,
    );
    for (const subTarget of subtypeTargets)
        emitResolvedEdge(e.source, subTarget.id, "calls", "interface_dispatch", Boolean(e.typeOnly));
    return Boolean(hit || subtypeTargets.length > 0 || !e.implicitSelf);
}

function resolveCallEdge(e, resIdx, emitResolvedEdge, opts) {
    const { byId, perFileName, globalName } = resIdx;
    if (e.viaMember && resolveViaMemberCall(e, resIdx, emitResolvedEdge, opts))
        return;
    const srcOrigin = byId.get(e.source)?.origin;
    const callKinds = e.kinds ??
        (srcOrigin === "generic" ? ["function", "method"] : e.file.endsWith(".java") ? ["class", "struct", "enum", "interface"] : ["function"]);
    if (!e.viaMember && e.specifier) {
        const targetFile = resolveImportTargetForFile(e.specifier, e.file, resIdx, opts);
        if (byId.has(targetFile)) {
            let found = resolveExportedSymbolInFile(targetFile, e.name, callKinds, resIdx, opts, new Set(), Boolean(e.isDefault));
            if (!found && PY_EXT.test(e.file))
                found = resolveExportedSymbolInFile(targetFile, e.name, PY_CTOR_KINDS, resIdx, opts);
            if (found)
                emitResolvedEdge(e.source, found.node.id, "calls", "extracted", Boolean(e.typeOnly || found.typeOnly));
            return;
        }
        if (!e.file.endsWith(".php") && !PY_EXT.test(e.file))
            return;
    }
    const lookupFile = !e.viaMember && e.specifier ? "" : e.file;
    const globalPool = e.sameFileOnly ? null : globalName;
    let hit = resolveName(e.name, lookupFile, callKinds, perFileName, globalPool);
    if (!hit && PY_EXT.test(e.file))
        hit = resolveName(e.name, lookupFile, PY_CTOR_KINDS, perFileName, globalPool);
    if (!hit && SWIFT_EXT.test(e.file))
        hit = resolveName(e.name, lookupFile, SWIFT_CTOR_KINDS, perFileName, globalPool);
    if (hit)
        emitResolvedEdge(e.source, hit.id, "calls", hit.confidence, Boolean(e.typeOnly));
}

function recordUniqueResolvedEdge(out, seen, source, target, relation, confidence, typeOnly = false) {
    const key = `${source}\0${relation}\0${target}`;
    const existing = seen.get(key);
    if (existing) {
        if (!typeOnly && existing.typeOnly)
            delete existing.typeOnly;
        return;
    }
    const edge = { source, target, relation, confidence, ...(typeOnly ? { typeOnly: true } : {}) };
    seen.set(key, edge);
    out.push(edge);
}

function resolveNonLuauRawEdge(e, resIdx, emitResolvedEdge, opts) {
    if (e.relation === "contains" && e.targetId) {
        emitResolvedEdge(e.source, e.targetId, "contains", "extracted");
    }
    else if ((e.relation === "imports" || e.relation === "reexports") && e.specifier) {
        emitResolvedEdge(e.source, resolveImportTargetForFile(e.specifier, e.file, resIdx, opts, e.isRustMod), e.relation, "extracted", Boolean(e.typeOnly));
    }
    else if (e.relation === "extends" || e.relation === "implements") {
        const kinds = e.relation === "implements" ? ["interface", "trait"] : ["class", "interface"];
        const hit = resolveName(e.name, e.file, kinds, resIdx.perFileName, resIdx.globalName);
        let sourceId = e.source;
        if (e.ownerName) {
            const ownerHit = resolveName(e.ownerName, e.file, ["struct", "class", "enum", "type"], resIdx.perFileName, resIdx.globalName);
            if (ownerHit)
                sourceId = ownerHit.id;
        }
        emitResolvedEdge(sourceId, hit?.id ?? e.name, e.relation, hit?.confidence ?? "inferred", Boolean(e.typeOnly));
    }
    else if (e.relation === "references" && e.name) {
        resolveReferenceEdge(e, resIdx, emitResolvedEdge, opts);
    }
    else if (e.relation === "calls") {
        resolveCallEdge(e, resIdx, emitResolvedEdge, opts);
    }
}

export function resolveEdges(nodes, rawEdges, opts = {}) {
    const resIdx = buildResolutionIndex(nodes, rawEdges, opts);
    const out = [];
    const seen = new Map();
    const emitResolvedEdge = (source, target, relation, confidence, typeOnly = false) =>
        recordUniqueResolvedEdge(out, seen, source, target, relation, confidence, typeOnly);
    resolveLuauEdges(nodes, rawEdges, emitResolvedEdge, opts);
    for (const e of rawEdges) {
        if (!e.file?.endsWith(".luau"))
            resolveNonLuauRawEdge(e, resIdx, emitResolvedEdge, opts);
    }
    return out;
}
/** Derive a method's owner from its dotted id when extract did not stamp `owner`
 * (PHP trait/interface methods today). `app.php#Loggable.log` → `Loggable`. */
function ownerFromMethodId(id) {
    const post = id.includes("#") ? id.split("#")[1] : id;
    const segs = post.split(".");
    return segs.length >= 2 ? segs[segs.length - 2] : undefined;
}
/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */
function resolveName(name, file, kinds, perFileName, globalName) {
    const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
    // Same-file requires a UNIQUE match, exactly as the cross-file branch below does.
    // Returning `local[0]` meant a file holding two same-named types (`Alpha.Builder` and
    // `Beta.Builder`, `Alpha.Inner` and `Beta.Inner`) silently resolved to whichever came
    // first in document order — and labelled it `extracted`, i.e. certain. That is the
    // guess this module's header says it does not make.
    if (local.length === 1)
        return { id: local[0].id, confidence: "extracted" };
    if (!globalName)
        return null;
    // Cross-file: also require a language that could actually reach this one.
    // Without it a unique name match ANYWHERE in the repo wins, which is how a Go
    // builtin ended up resolving into a TypeScript test — see FAMILIES above.
    const global = (globalName.get(name) ?? []).filter((n) => kinds.includes(n.kind) && reachable(file, n.path));
    if (global.length === 1)
        return { id: global[0].id, confidence: "inferred" };
    return null;
}
/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
/**
 * Narrow an overload set to the candidates a call of `argCount` arguments could
 * reach. Only Java emits `argCount`/`arity`, so for every other language this is
 * the identity function and resolution is byte-for-byte what it was.
 *
 * Deliberately conservative in both directions:
 *   - A variadic candidate (`String... xs`) accepts anything from `arity - 1`
 *     upward, so it is never filtered out by count.
 *   - A candidate with no recorded arity (a graph built before this field) is
 *     kept, since absence of data is not evidence of a mismatch.
 *   - If narrowing leaves nothing, the ORIGINAL set is returned. An empty result
 *     would silently drop a real edge; handing the full set back lets the existing
 *     same-file / "ambiguous" logic make the call exactly as before.
 */
function narrowByArity(candidates, argCount) {
    if (argCount === undefined || candidates.length < 2)
        return candidates;
    const fits = candidates.filter((c) => {
        if (c.arity === undefined)
            return true;
        return c.variadic ? argCount >= c.arity - 1 : c.arity === argCount;
    });
    return fits.length > 0 ? fits : candidates;
}
function pickOwnerMethodCandidate(type, name, file, ownerMethod, argCount) {
    const all = ownerMethod.get(`${type}.${name}`)?.filter((c) => reachable(file, c.path));
    if (!all || all.length === 0)
        return null;
    const candidates = narrowByArity(all, argCount);
    if (candidates.length === 1) {
        const c = candidates[0];
        return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
    }
    if (SWIFT_EXT.test(file))
        return "ambiguous";
    const sameFile = candidates.find((c) => c.path === file);
    return sameFile ? { id: sameFile.id, confidence: "extracted" } : "ambiguous";
}
function advanceTypeHierarchyFrontier(frontier, visited, hierarchyParents, classParents) {
    const next = [];
    for (const type of frontier) {
        const parentNames = hierarchyParents?.get(type) ?? classParents.get(type) ?? [];
        for (const parent of parentNames) {
            if (visited.has(parent))
                continue;
            visited.add(parent);
            next.push(parent);
        }
    }
    return next;
}
function resolveTypedMember(recvType, name, file, ownerMethod, classParents, classTraits, argCount, hierarchyParents = null) {
    const MAX_DEPTH = 3;
    const visited = new Set([recvType]);
    let frontier = [recvType];
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
        for (const type of frontier) {
            const ownerHit = pickOwnerMethodCandidate(type, name, file, ownerMethod, argCount);
            if (ownerHit)
                return ownerHit;
            const traitHit = resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount);
            if (traitHit)
                return traitHit;
        }
        frontier = advanceTypeHierarchyFrontier(frontier, visited, hierarchyParents, classParents);
    }
    return null; // chain exhausted, no candidate anywhere
}
/** Resolve a member call against methods declared on PHP traits used by `type`. */
function resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount) {
    const traits = classTraits.get(type);
    if (!traits?.length)
        return null;
    const matches = [];
    for (const trait of traits) {
        const all = ownerMethod.get(`${trait}.${name}`)?.filter((c) => reachable(file, c.path));
        if (!all?.length)
            continue;
        matches.push(...narrowByArity(all, argCount));
    }
    if (matches.length === 0)
        return null;
    if (matches.length === 1) {
        const c = matches[0];
        return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
    }
    return "ambiguous";
}
/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 */
function probeImportPath(rawBase, byId, isPython = false) {
    const base = posix.normalize(rawBase).replace(/^\.\//, "");
    if (!base || base === ".") {
        if (isPython && byId.has("__init__.py"))
            return "__init__.py";
        return null;
    }
    const noExt = base.replace(/\.(js|jsx|mjs|cjs|mts|cts|ts|tsx|py|pyi)$/, "");
    const candidates = [
        base,
        ...IMPORT_EXTS.map((e) => noExt + e),
        ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
        ...(isPython ? [`${noExt}/__init__.py`, `${noExt}/__init__.pyi`] : [`${noExt}/__init__.py`]),
    ];
    for (const c of candidates) {
        if (byId.has(c))
            return c;
    }
    return null;
}
function extractPackageTargets(entry) {
    if (!entry)
        return [];
    if (typeof entry === "string")
        return [entry];
    if (Array.isArray(entry))
        return entry.flatMap((item) => extractPackageTargets(item));
    if (typeof entry === "object") {
        const order = ["source", "import", "default", "require", "module", "node", "browser", "types"];
        const out = [];
        const seen = new Set();
        for (const k of order) {
            if (k in entry) {
                seen.add(k);
                out.push(...extractPackageTargets(entry[k]));
            }
        }
        for (const [k, v] of Object.entries(entry)) {
            if (!seen.has(k))
                out.push(...extractPackageTargets(v));
        }
        return out;
    }
    return [];
}
function matchExportMap(map, key) {
    if (!map || typeof map !== "object")
        return [];
    if (key in map)
        return extractPackageTargets(map[key]);
    const out = [];
    for (const [pattern, val] of Object.entries(map)) {
        if (!pattern.includes("*"))
            continue;
        const [prefix, suffix] = pattern.split("*");
        if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
            const star = key.slice(prefix.length, key.length - suffix.length);
            for (const t of extractPackageTargets(val)) {
                out.push(t.replace(/\*/g, star));
            }
        }
    }
    return out;
}
function probePackageTarget(pkgDir, target, byId) {
    const joined = pkgDir ? posix.join(pkgDir, target) : target;
    const direct = probeImportPath(joined, byId, false);
    if (direct)
        return direct;
    const srcMapped = target.replace(/^(?:\.\/)?(dist|build|lib|out)\//, "./src/");
    if (srcMapped !== target) {
        const fallback = probeImportPath(pkgDir ? posix.join(pkgDir, srcMapped) : srcMapped, byId, false);
        if (fallback)
            return fallback;
    }
    return null;
}
function resolvePythonImportSpec(spec, posixFile, byId, opts) {
    if (spec.startsWith(".")) {
        const m = /^(\.+)(.*)$/.exec(spec);
        if (m) {
            const dots = m[1].length;
            const rest = m[2];
            const dir = posix.dirname(posixFile);
            const up = dots > 1 ? Array(dots - 1).fill("..").join("/") : "";
            const baseDir = up ? posix.normalize(posix.join(dir, up)) : dir;
            const relSub = rest ? rest.replace(/\./g, "/") : "";
            const targetBase = relSub
                ? (baseDir === "." ? relSub : posix.join(baseDir, relSub))
                : (baseDir === "." ? "" : baseDir);
            const hit = probeImportPath(targetBase, byId, true);
            if (hit)
                return hit;
        }
        return spec;
    }
    const slashSpec = spec.replace(/\./g, "/");
    const fileDir = posix.dirname(posixFile);
    const pyBases = [
        slashSpec,
        `src/${slashSpec}`,
        ...(fileDir !== "." ? [`${fileDir}/${slashSpec}`] : []),
    ];
    if (opts?.scopes?.length) {
        for (const s of opts.scopes) {
            if (s.prefix) {
                pyBases.push(`${s.prefix}/${slashSpec}`, `${s.prefix}/src/${slashSpec}`);
            }
        }
    }
    for (const cand of pyBases) {
        const hit = probeImportPath(cand, byId, true);
        if (hit)
            return hit;
    }
    return spec;
}

function resolveTsConfigWildcardPattern(spec, pattern, targets, baseDir, byId) {
    const [prefix, suffix] = pattern.split("*");
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length)
        return null;
    const star = spec.slice(prefix.length, spec.length - suffix.length);
    for (const t of targets) {
        if (typeof t !== "string")
            continue;
        const mapped = t.replace(/\*/g, star);
        const hit = probeImportPath(baseDir ? posix.join(baseDir, mapped) : mapped, byId, false);
        if (hit)
            return hit;
    }
    return null;
}
function resolveTsConfigExactPattern(targets, baseDir, byId) {
    for (const t of targets) {
        if (typeof t !== "string")
            continue;
        const hit = probeImportPath(baseDir ? posix.join(baseDir, t) : t, byId, false);
        if (hit)
            return hit;
    }
    return null;
}
function resolveTsConfigForEntry(spec, cfg, baseDir, byId) {
    if (cfg.paths && typeof cfg.paths === "object") {
        for (const [pattern, targets] of Object.entries(cfg.paths)) {
            if (!Array.isArray(targets))
                continue;
            const hit = pattern.includes("*")
                ? resolveTsConfigWildcardPattern(spec, pattern, targets, baseDir, byId)
                : pattern === spec
                    ? resolveTsConfigExactPattern(targets, baseDir, byId)
                    : null;
            if (hit)
                return hit;
        }
    }
    if (cfg.baseUrl)
        return probeImportPath(baseDir ? posix.join(baseDir, spec) : spec, byId, false);
    return null;
}
function resolveTsConfigPaths(spec, posixFile, byId, tsConfigs) {
    for (const cfg of tsConfigs) {
        const cfgDir = cfg.dir === "." ? "" : cfg.dir;
        if (cfgDir && !pathUnderPrefix(posixFile, cfgDir))
            continue;
        const rawBase = cfg.baseUrl ? (cfgDir ? posix.join(cfgDir, cfg.baseUrl) : cfg.baseUrl) : cfgDir;
        const baseDir = rawBase === "." ? "" : posix.normalize(rawBase);
        const hit = resolveTsConfigForEntry(spec, cfg, baseDir, byId);
        if (hit)
            return hit;
    }
    return null;
}

function resolvePackageExportsTargets(pkgExports, subpath) {
    if (typeof pkgExports === "string" || Array.isArray(pkgExports))
        return subpath === "." ? extractPackageTargets(pkgExports) : [];
    if (typeof pkgExports !== "object")
        return [];
    const isSubpathMap = Object.keys(pkgExports).some((k) => k.startsWith("."));
    if (isSubpathMap)
        return matchExportMap(pkgExports, subpath);
    return subpath === "." ? extractPackageTargets(pkgExports) : [];
}
function probeSelfPackageEntry(pkg, spec, byId) {
    if (!pkg.name || (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)))
        return null;
    const pkgDir = pkg.dir === "." ? "" : pkg.dir;
    const subpath = spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
    if (pkg.exports) {
        for (const t of resolvePackageExportsTargets(pkg.exports, subpath)) {
            const hit = probePackageTarget(pkgDir, t, byId);
            if (hit)
                return hit;
        }
    }
    const relSub = subpath === "." ? "" : subpath.slice(2);
    const fallbackCands = subpath === "."
        ? [pkgDir ? `${pkgDir}/src/index` : "src/index", pkgDir ? `${pkgDir}/index` : "index"]
        : [pkgDir ? `${pkgDir}/${relSub}` : relSub, pkgDir ? `${pkgDir}/src/${relSub}` : `src/${relSub}`];
    for (const c of fallbackCands) {
        const hit = probeImportPath(c, byId, false);
        if (hit)
            return hit;
    }
    return null;
}

function resolveSelfPackageExport(spec, byId, packageConfigs) {
    for (const pkg of packageConfigs) {
        const hit = probeSelfPackageEntry(pkg, spec, byId);
        if (hit)
            return hit;
    }
    return null;
}

function resolveImport(spec, file, byId, _resIdx = null, opts = {}) {
    const posixFile = toPosixPath(file);
    if (PY_EXT.test(posixFile)) {
        return resolvePythonImportSpec(spec, posixFile, byId, opts);
    }
    if (spec.startsWith(".")) {
        const dir = posix.dirname(posixFile);
        const base = posix.normalize(posix.join(dir, spec));
        const hit = probeImportPath(base, byId, false);
        return hit || spec;
    }
    if (spec.startsWith("#") && opts?.packageConfigs?.length) {
        for (const pkg of opts.packageConfigs) {
            const pkgDir = pkg.dir === "." ? "" : pkg.dir;
            if (pkgDir && !pathUnderPrefix(posixFile, pkgDir))
                continue;
            if (!pkg.imports || typeof pkg.imports !== "object")
                continue;
            for (const t of matchExportMap(pkg.imports, spec)) {
                const hit = probePackageTarget(pkgDir, t, byId);
                if (hit)
                    return hit;
            }
        }
    }
    if (opts?.tsConfigs?.length) {
        const tsHit = resolveTsConfigPaths(spec, posixFile, byId, opts.tsConfigs);
        if (tsHit)
            return tsHit;
    }
    if (opts?.packageConfigs?.length) {
        const pkgHit = resolveSelfPackageExport(spec, byId, opts.packageConfigs);
        if (pkgHit)
            return pkgHit;
    }
    return spec;
}
/**
 * Resolve a Java import's fully-qualified type name to an in-repo file node;
 * otherwise return the raw specifier (JDK or third-party type).
 *
 * Java names a *type*, not a path, and states no source root — `com.acme.Foo` may
 * live under `src/main/java/`, `src/`, or a module dir. Matching on the path SUFFIX
 * (`com/acme/Foo.java`) is therefore root-agnostic and needs no build-file parsing,
 * which is what keeps this deterministic and dependency-free.
 *
 * `import static com.acme.Foo.bar` names a member, so when the full name misses, the
 * last segment is dropped and the enclosing type retried. A wildcard (`com.acme.*`)
 * names a package rather than one file and is deliberately left unresolved: picking a
 * representative would invent an edge the source does not state.
 *
 * A suffix shared by two files (the same FQN under two source roots, e.g. a
 * duplicated test tree) is ambiguous, so it stays unresolved rather than guessing.
 */
function resolveJavaImport(spec, filesBySuffix) {
    const hit = (fqn) => {
        const suffix = `${fqn.split(".").join("/")}.java`;
        const files = filesBySuffix.get(suffix);
        return files && files.length === 1 ? files[0] : null;
    };
    const direct = hit(spec);
    if (direct)
        return direct;
    // `import static a.b.C.member` → retry as `a.b.C`.
    const dot = spec.lastIndexOf(".");
    if (dot > 0) {
        const enclosing = hit(spec.slice(0, dot));
        if (enclosing)
            return enclosing;
    }
    return spec;
}
/**
 * Resolve a C/C++ `#include "path"` to an in-repo file node: relative to the including
 * file first (the common case, and certain), else a UNIQUE path-suffix match — which
 * covers a header reached through an `-I` include directory rather than a relative path.
 * Anything ambiguous or not found stays the raw path (a system or out-of-repo header),
 * never a guessed edge.
 */
function resolveCInclude(spec, file, byId, bySuffix) {
    const dir = posix.dirname(toPosixPath(file));
    const relJoin = posix.normalize(posix.join(dir, spec));
    if (byId.has(relJoin))
        return relJoin; // relative to the including file — certain
    const hits = bySuffix.get(spec.replace(/^\.?\//, ""));
    if (hits && hits.length === 1)
        return hits[0]; // unique suffix — an -I-reached header
    return spec; // system/out-of-repo/ambiguous — keep the string, do not guess
}
/**
 * Resolve a PHP `use` fully-qualified name (`App\Models\User`) to the in-repo class file.
 * PSR-4 maps the namespace to a directory under some (unknown) source root and the class
 * to a `<Class>.php` file, so we match the longest namespace-tail suffix that names exactly
 * one file: `App/Models/User.php`, then `Models/User.php`, then `User.php`. The longest
 * unique match wins; an ambiguous tail or a vendor/out-of-repo class stays the raw name.
 */
const BREADTH_REL_EXT_MAP = {
    ".rb": [".rb"],
    ".lua": [".lua", "/init.lua"],
    ".nix": [".nix", "/default.nix"],
    ".dart": [".dart"],
    ".sol": [".sol"],
};
const CLJ_EXTS = new Set([".clj", ".cljc", ".cljs"]);
function resolveBreadthRelativeImport(cleanSpec, dir, ext, byId) {
    const relJoin = posix.normalize(posix.join(dir, cleanSpec));
    if (byId.has(relJoin))
        return relJoin;
    if (!posix.extname(relJoin) && BREADTH_REL_EXT_MAP[ext]) {
        for (const sfx of BREADTH_REL_EXT_MAP[ext]) {
            const cand = `${relJoin}${sfx}`;
            if (byId.has(cand))
                return cand;
        }
    }
    return null;
}
function resolveDartPackageSpec(cleanSpec, bySuffix) {
    const rest = cleanSpec.slice("package:".length);
    const slash = rest.indexOf("/");
    if (slash <= 0)
        return null;
    const sub = rest.slice(slash + 1);
    const uniq = [...new Set([...(bySuffix.get(`lib/${sub}`) ?? []), ...(bySuffix.get(sub) ?? [])])];
    return uniq.length === 1 ? uniq[0] : null;
}
function resolveLuaPackageSpec(cleanSpec, byId, bySuffix) {
    const slash = cleanSpec.replace(/\./g, "/");
    for (const suf of [`${slash}.lua`, `${slash}/init.lua`]) {
        if (byId.has(suf))
            return suf;
        const hits = bySuffix.get(suf);
        if (hits?.length === 1)
            return hits[0];
    }
    return null;
}
function resolveBreadthPackageOrSuffix(cleanSpec, ext, byId, bySuffix) {
    if (ext === ".dart" && cleanSpec.startsWith("package:"))
        return resolveDartPackageSpec(cleanSpec, bySuffix);
    if (ext === ".lua")
        return resolveLuaPackageSpec(cleanSpec, byId, bySuffix);
    if (ext === ".rb") {
        const hits = bySuffix.get(cleanSpec.endsWith(".rb") ? cleanSpec : `${cleanSpec}.rb`);
        return hits?.length === 1 ? hits[0] : null;
    }
    if (CLJ_EXTS.has(ext)) {
        const slash = cleanSpec.replace(/\./g, "/").replace(/-/g, "_");
        for (const e of CLJ_EXTS) {
            const hits = bySuffix.get(`${slash}${e}`);
            if (hits?.length === 1)
                return hits[0];
        }
    }
    return null;
}
function resolveBreadthImport(spec, file, byId, bySuffix) {
    const dir = posix.dirname(toPosixPath(file));
    const ext = posix.extname(file).toLowerCase();
    const cleanSpec = spec.trim();
    if (cleanSpec.startsWith(".")) {
        const relHit = resolveBreadthRelativeImport(cleanSpec, dir, ext, byId);
        if (relHit)
            return relHit;
    }
    return resolveBreadthPackageOrSuffix(cleanSpec, ext, byId, bySuffix) ?? cleanSpec;
}
function resolvePhpUse(fqn, bySuffix) {
    const parts = fqn.split("\\").filter(Boolean);
    if (parts.length === 0)
        return fqn;
    for (let i = 0; i < parts.length; i++) {
        const suffix = `${parts.slice(i).join("/")}.php`;
        const hits = bySuffix.get(suffix);
        if (hits && hits.length === 1)
            return hits[0];
        if (hits && hits.length > 1)
            break; // ambiguous at the most specific level — do not guess
    }
    return fqn;
}
function rustModuleDirForFile(fpath) {
    const dir = posix.dirname(fpath) === "." ? "" : posix.dirname(fpath);
    const base = posix.basename(fpath);
    if (base === "mod.rs" || base === "lib.rs" || base === "main.rs")
        return dir;
    const stem = base.replace(/\.rs$/i, "");
    return dir ? `${dir}/${stem}` : stem;
}

function resolveRustModuleCandidates(baseDir, segs, rootFallbackRels, byId) {
    const candFor = (rel) => (baseDir === "" ? rel : `${baseDir}/${rel}`);
    for (let k = segs.length; k >= 1; k--) {
        const modPath = segs.slice(0, k).join("/");
        const hits = [`${modPath}.rs`, `${modPath}/mod.rs`].map(candFor).filter((c) => byId.has(c));
        if (hits.length === 1)
            return hits[0];
        if (hits.length > 1)
            return null;
    }
    if (segs.length <= 1 && rootFallbackRels.length > 0) {
        const hits = rootFallbackRels.filter((c) => byId.has(c));
        if (hits.length === 1)
            return hits[0];
    }
    return null;
}

function resolveRustRelativeUse(normSpec, fpath, byId, owningRoot) {
    const parts = normSpec.split("/").filter(Boolean);
    const fallback = parts.join("::");
    let curModDir = rustModuleDirForFile(fpath);
    let idx = 0;
    while (idx < parts.length && (parts[idx] === "self" || parts[idx] === "super")) {
        if (parts[idx] === "super") {
            if (curModDir === "" || (owningRoot !== null && curModDir === owningRoot))
                return fallback;
            const slash = curModDir.lastIndexOf("/");
            curModDir = slash >= 0 ? curModDir.slice(0, slash) : "";
            if (owningRoot !== null && curModDir !== owningRoot && !pathUnderPrefix(curModDir, owningRoot))
                return fallback;
        }
        idx++;
    }
    const remSegs = parts.slice(idx);
    const fallbackRels = owningRoot !== null && curModDir === owningRoot
        ? [curModDir ? `${curModDir}/lib.rs` : "lib.rs", curModDir ? `${curModDir}/main.rs` : "main.rs"]
        : curModDir
            ? [`${curModDir}.rs`, `${curModDir}/mod.rs`]
            : ["lib.rs", "main.rs", "mod.rs"];
    return resolveRustModuleCandidates(curModDir, remSegs, fallbackRels, byId) ?? fallback;
}

function inferCrateRootsFromById(byId) {
    const roots = [];
    if (!byId || typeof byId.keys !== "function")
        return roots;
    for (const rawKey of byId.keys()) {
        if (typeof rawKey !== "string" || rawKey.includes("#"))
            continue;
        const p = toPosixPath(rawKey);
        if (p === "lib.rs" || p === "main.rs")
            roots.push("");
        else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs"))
            roots.push(posix.dirname(p));
    }
    return roots;
}

/**
 * Resolve a Rust `crate::` / `self::` / `super::` module path to an in-repo `.rs` file.
 * Ambiguous or out-of-crate paths remain `crate::…` / `super::…` / `self::…` strings.
 */
export function resolveRustUse(spec, file, byId, crateRoots) {
    const effectiveCrateRoots = crateRoots ?? inferCrateRootsFromById(byId);
    const normSpec = spec.trim().replace(/::/g, "/").replace(/\/+$/, "");
    const fpath = toPosixPath(file);
    const owning = effectiveCrateRoots
        .filter((r) => pathUnderPrefix(fpath, r))
        .sort((a, b) => b.length - a.length);
    const owningRoot = owning.length > 0 ? owning[0] : null;
    if (normSpec === "self" || normSpec.startsWith("self/") || normSpec === "super" || normSpec.startsWith("super/")) {
        return resolveRustRelativeUse(normSpec, fpath, byId, owningRoot);
    }
    const full = normSpec.replace(/^crate\/?/, "");
    const fallback = full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
    if (owningRoot === null)
        return fallback;
    const segs = full === "" ? [] : full.split("/");
    const crateRootFiles = [owningRoot ? `${owningRoot}/lib.rs` : "lib.rs", owningRoot ? `${owningRoot}/main.rs` : "main.rs"];
    return resolveRustModuleCandidates(owningRoot, segs, crateRootFiles, byId) ?? fallback;
}
/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec, modules, filesByDir) {
    let best = null;
    for (const mod of modules) {
        let subpath = null;
        if (spec === mod.module)
            subpath = "";
        else if (spec.startsWith(mod.module + "/"))
            subpath = spec.slice(mod.module.length + 1);
        if (subpath === null)
            continue;
        if (!best || mod.module.length > best.mod.module.length)
            best = { mod, subpath };
    }
    if (!best)
        return spec; // stdlib / third-party — keep the package path
    const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
    const files = filesByDir.get(dir);
    if (!files || files.length === 0)
        return spec;
    return [...files].sort()[0];
}
