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
import { pushMap, toPosixPath } from "../util/paths.js";
import { containerLangOf } from "./container.js";
import { languageOf } from "./extract.js";
import { genericLangOf } from "./generic.js";
import { resolveLuauEdges } from "./luau.js";
import { pathUnderPrefix } from "./scopes.js";
const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
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
function reachable(file, candidatePath) {
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
function buildResolutionIndex(nodes, rawEdges, opts) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const globalName = new Map();
    const perFileName = new Map();
    const ownerMethod = new Map();
    const goFilesByDir = new Map();
    const javaFilesBySuffix = new Map();
    const cFilesBySuffix = new Map();
    const rustCrateRoots = [];
    const phpFilesBySuffix = new Map();
    const hasGoModules = !!opts.goModules?.length;
    for (const n of nodes) {
        if (n.kind === "file") {
            if (hasGoModules && n.path.endsWith(".go")) {
                const dir = posix.dirname(toPosixPath(n.path));
                pushMap(goFilesByDir, dir, n.id);
            }
            if (n.path.endsWith(".java"))
                indexPathSuffixes(javaFilesBySuffix, n.id);
            if (C_EXT.test(n.path))
                indexPathSuffixes(cFilesBySuffix, n.id);
            if (n.path.endsWith(".php"))
                indexPathSuffixes(phpFilesBySuffix, n.id);
            const p = toPosixPath(n.path);
            if (p === "lib.rs" || p === "main.rs")
                rustCrateRoots.push("");
            else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs"))
                rustCrateRoots.push(posix.dirname(p));
            continue;
        }
        pushMap(globalName, n.name, n);
        let fileMap = perFileName.get(n.path);
        if (!fileMap)
            perFileName.set(n.path, (fileMap = new Map()));
        pushMap(fileMap, n.name, n);
        if (n.kind === "method") {
            const owner = n.owner ?? ownerFromMethodId(n.id);
            if (owner)
                pushMap(ownerMethod, `${owner}.${n.name}`, n);
        }
    }
    const classParents = new Map();
    const classTraits = new Map();
    for (const e of rawEdges) {
        if (e.relation === "extends" && e.name) {
            const ownName = byId.get(e.source)?.name;
            if (ownName)
                pushMap(classParents, ownName, e.name);
        }
        else if (e.relation === "implements" && e.name && e.file.endsWith(".php")) {
            const ownName = byId.get(e.source)?.name;
            if (ownName)
                pushMap(classTraits, ownName, e.name);
        }
    }
    return {
        byId,
        globalName,
        perFileName,
        ownerMethod,
        goFilesByDir,
        javaFilesBySuffix,
        cFilesBySuffix,
        rustCrateRoots,
        phpFilesBySuffix,
        classParents,
        classTraits,
        hasGoModules,
    };
}
function resolveImportTargetForFile(spec, file, resIdx, opts) {
    if (resIdx.hasGoModules && file.endsWith(".go"))
        return resolveGoImport(spec, opts.goModules, resIdx.goFilesByDir);
    if (file.endsWith(".java"))
        return resolveJavaImport(spec, resIdx.javaFilesBySuffix);
    if (C_EXT.test(file))
        return resolveCInclude(spec, file, resIdx.byId, resIdx.cFilesBySuffix);
    if (file.endsWith(".rs"))
        return resolveRustUse(spec, file, resIdx.byId, resIdx.rustCrateRoots);
    if (file.endsWith(".php"))
        return resolvePhpUse(spec, resIdx.phpFilesBySuffix);
    return resolveImport(spec, file, resIdx.byId);
}
function resolveReferenceEdge(e, resIdx, emitResolvedEdge) {
    const { byId, perFileName, globalName, phpFilesBySuffix } = resIdx;
    if (e.specifier) {
        const targetFile = e.file.endsWith(".php")
            ? resolvePhpUse(e.specifier, phpFilesBySuffix)
            : resolveImport(e.specifier, e.file, byId);
        if (!byId.has(targetFile))
            return;
        const candidates = perFileName.get(targetFile)?.get(e.name) ?? [];
        if (candidates.length === 1)
            emitResolvedEdge(e.source, candidates[0].id, "references", "extracted");
    }
    else if (e.file.endsWith(".php") && byId.get(e.source)?.origin === "ast") {
        const refKinds = ["class", "interface", "trait", "enum"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source)
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence);
    }
    else if (e.file.endsWith(".java") && byId.get(e.source)?.origin === "ast") {
        const hit = resolveName(e.name, e.file, ["interface"], perFileName, globalName);
        const anno = hit ? byId.get(hit.id) : undefined;
        if (hit && hit.id !== e.source && anno?.signature?.includes("@interface"))
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence);
        else
            emitResolvedEdge(e.source, e.name, "references", "inferred");
    }
    else if (byId.get(e.source)?.origin === "generic") {
        const refKinds = ["class", "interface", "struct", "enum", "type", "module"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source)
            emitResolvedEdge(e.source, hit.id, "references", hit.confidence);
    }
}
function resolveCallEdge(e, resIdx, emitResolvedEdge) {
    const { byId, perFileName, globalName, ownerMethod, classParents, classTraits } = resIdx;
    if (e.viaMember) {
        if (!e.recvType)
            return;
        const hit = resolveTypedMember(e.recvType, e.name, e.file, ownerMethod, classParents, classTraits, e.argCount);
        if (hit === "ambiguous")
            return;
        if (hit) {
            emitResolvedEdge(e.source, hit.id, "calls", hit.confidence);
            return;
        }
        if (!e.implicitSelf)
            return;
    }
    const srcOrigin = byId.get(e.source)?.origin;
    const callKinds = e.kinds ??
        (srcOrigin === "generic"
            ? ["function", "method"]
            : e.file.endsWith(".java")
                ? ["class", "struct", "enum", "interface"]
                : ["function"]);
    let hit = resolveName(e.name, e.file, callKinds, perFileName, globalName);
    if (!hit && PY_EXT.test(e.file))
        hit = resolveName(e.name, e.file, PY_CTOR_KINDS, perFileName, globalName);
    if (!hit && SWIFT_EXT.test(e.file))
        hit = resolveName(e.name, e.file, SWIFT_CTOR_KINDS, perFileName, globalName);
    if (hit)
        emitResolvedEdge(e.source, hit.id, "calls", hit.confidence);
}
export function resolveEdges(nodes, rawEdges, opts = {}) {
    const resIdx = buildResolutionIndex(nodes, rawEdges, opts);
    const out = [];
    const seen = new Set();
    const emitResolvedEdge = (source, target, relation, confidence) => {
        const key = `${source}\0${relation}\0${target}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({ source, target, relation, confidence });
    };
    resolveLuauEdges(nodes, rawEdges, emitResolvedEdge, opts);
    for (const e of rawEdges) {
        if (e.file?.endsWith(".luau"))
            continue;
        if (e.relation === "contains" && e.targetId) {
            emitResolvedEdge(e.source, e.targetId, "contains", "extracted");
        }
        else if (e.relation === "imports" && e.specifier) {
            emitResolvedEdge(e.source, resolveImportTargetForFile(e.specifier, e.file, resIdx, opts), "imports", "extracted");
        }
        else if (e.relation === "extends" || e.relation === "implements") {
            const kinds = e.relation === "implements" ? ["interface", "trait"] : ["class", "interface"];
            const hit = resolveName(e.name, e.file, kinds, resIdx.perFileName, resIdx.globalName);
            emitResolvedEdge(e.source, hit?.id ?? e.name, e.relation, hit?.confidence ?? "inferred");
        }
        else if (e.relation === "references" && e.name) {
            resolveReferenceEdge(e, resIdx, emitResolvedEdge);
        }
        else if (e.relation === "calls") {
            resolveCallEdge(e, resIdx, emitResolvedEdge);
        }
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
function resolveTypedMember(recvType, name, file, ownerMethod, classParents, classTraits, argCount) {
    const MAX_DEPTH = 3;
    const visited = new Set([recvType]);
    let frontier = [recvType];
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
        for (const type of frontier) {
            const all = ownerMethod.get(`${type}.${name}`)?.filter((c) => reachable(file, c.path));
            if (all && all.length > 0) {
                const candidates = narrowByArity(all, argCount);
                if (candidates.length === 1) {
                    const c = candidates[0];
                    return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
                }
                // Swift: several candidates surviving arity narrowing are a genuine
                // overload set distinguished only by parameter TYPES (`save(Int)` vs
                // `save(String)`), which this pass cannot read — the same-file tiebreak
                // below would pick whichever overload appears first in the file and
                // stamp it `extracted`, a confidently wrong edge. Drop instead.
                if (SWIFT_EXT.test(file))
                    return "ambiguous";
                const sameFile = candidates.find((c) => c.path === file);
                if (sameFile)
                    return { id: sameFile.id, confidence: "extracted" };
                return "ambiguous"; // several, none same-file — drop and stop
            }
            const traitHit = resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount);
            if (traitHit === "ambiguous")
                return "ambiguous";
            if (traitHit)
                return traitHit;
        }
        const next = [];
        for (const type of frontier) {
            for (const parent of classParents.get(type) ?? []) {
                if (visited.has(parent))
                    continue;
                visited.add(parent);
                next.push(parent);
            }
        }
        frontier = next;
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
function resolveImport(spec, file, byId) {
    if (!spec.startsWith("."))
        return spec;
    // Belt-and-braces: `node.path` is posix by construction (`../util/paths.js`),
    // but this also accepts a hand-written or hand-edited graph.
    const dir = posix.dirname(toPosixPath(file));
    const base = posix.normalize(posix.join(dir, spec));
    const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
    const candidates = [
        base,
        ...IMPORT_EXTS.map((e) => noExt + e),
        ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
    ];
    for (const c of candidates)
        if (byId.has(c))
            return c;
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
/**
 * Resolve a Rust `crate`-relative module path (`crate/a/b`, from `use crate::a::b::Item`)
 * to the in-repo module file — `<crate root>/a/b.rs` or `<crate root>/a/b/mod.rs`, where
 * the crate root is the `lib.rs`/`main.rs` directory the importing file lives under. The
 * per-file crate root keeps a multi-crate workspace unambiguous. Not found or ambiguous
 * (two roots, both `a/b.rs` and `a/b/mod.rs`) stays a `crate::…` string — never a guess.
 */
function resolveRustUse(spec, file, byId, crateRoots) {
    const full = spec.replace(/^crate\/?/, ""); // "crate/a/b/Item" → "a/b/Item"; "crate" → ""
    const fpath = toPosixPath(file);
    // the crate this file belongs to: the longest root that contains it (workspace-safe)
    const owning = crateRoots
        .filter((r) => pathUnderPrefix(fpath, r))
        .sort((a, b) => b.length - a.length);
    // No owning crate root (e.g. an integration test under `tests/`, whose `crate::` is the
    // TEST binary's own root, not a lib) → do NOT search every crate in a workspace: that
    // resolves `crate::util` to some unrelated crate's util.rs. Keep it a string instead.
    if (owning.length === 0)
        return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
    const roots = [owning[0]];
    const segs = full === "" ? [] : full.split("/");
    const hitsFor = (rels) => {
        const hits = new Set();
        for (const r of roots)
            for (const rel of rels) {
                const cand = r === "" ? rel : `${r}/${rel}`;
                if (byId.has(cand))
                    hits.add(cand);
            }
        return hits;
    };
    // Try the longest module prefix first, shrinking toward — but NOT past — the first
    // segment. `crate::a::b::C` resolves as module `a/b` (C is the item); `crate::net` as
    // module `net`. The first prefix naming exactly one in-repo file wins; two matches at a
    // level are ambiguous → drop rather than guess.
    for (let k = segs.length; k >= 1; k--) {
        const modPath = segs.slice(0, k).join("/");
        const hits = hitsFor([`${modPath}.rs`, `${modPath}/mod.rs`]);
        if (hits.size === 1)
            return [...hits][0];
        if (hits.size > 1)
            break;
    }
    // The crate root (`lib.rs`/`main.rs`) is a target ONLY for `use crate::Item` or
    // `use crate::{…}` — a deeper path whose module chain didn't resolve is genuinely
    // unknown (a re-export, an inline `mod`, or out-of-tree), so keep it as a string.
    if (segs.length <= 1) {
        const hits = hitsFor(["lib.rs", "main.rs"]);
        if (hits.size === 1)
            return [...hits][0];
    }
    return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
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
