/**
 * Generic "breadth" extractor tier — one language-agnostic extractor over any
 * tree-sitter grammar + its `tags.scm` (the standard tree-sitter tags convention). This is how
 * plexer covers the long tail of languages for ~one registry row each, instead of
 * a hand-written extractor per language (the depth tier in extract.js).
 *
 * Grammars are WASM (`tree-sitter-wasm` bundle) loaded via `web-tree-sitter`, so
 * a new language needs no native node-gyp build. Loading is async (WASM init), so
 * callers MUST `await warmGenericGrammars([...])` once before the synchronous
 * `extractGeneric()` is used in a build/check loop. If a grammar isn't warmed,
 * `extractGeneric` degrades to a file node only (never throws).
 *
 * What it emits (signature-only): a file node + one node per `@definition.<kind>`
 * capture, and bare-name `calls` raw edges from `@reference.call` attributed to
 * the innermost enclosing definition. resolve.js then resolves those calls by
 * name for free (same-file → extracted, unique-global → inferred). Member-call
 * receiver typing (recvType) is NOT produced here — that needs a per-language
 * binding pass; the opt-in LSP tier fills that gap for popular languages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { contentHash, fileResidual, mintId, searchBody } from "../util/id.js";
import { KIND, defScope, enclosingDef, extractLeadingSummary } from "./extract/ast.js";
import { extractLuau } from "./luau.js";
import { cCppExported, rustExported } from "./extract/visibility.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// queries/ ships beside the compiled JS (copied by the build); fall back to src.
const QUERY_DIRS = [join(HERE, "queries"), join(HERE, "..", "..", "src", "graph", "queries")];
/** The breadth registry. Add a row + a queries/<name>.scm to support a language.
 * Extensions here must NOT collide with the depth tier's EXTENSIONS (extract.js). */
export const GENERIC_LANGS = [
    { name: "rust", exts: [".rs"], wasm: "rust" },
    { name: "c", exts: [".c", ".h"], wasm: "c" },
    { name: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"], wasm: "cpp" },
    { name: "ruby", exts: [".rb"], wasm: "ruby" },
    { name: "c_sharp", exts: [".cs"], wasm: "c_sharp" },
    // All breadth languages below ship a queries/<name>.scm (calls + symbols + imports).
    { name: "scala", exts: [".scala", ".sc"], wasm: "scala" },
    { name: "elixir", exts: [".ex", ".exs"], wasm: "elixir" },
    { name: "solidity", exts: [".sol"], wasm: "solidity" },
    { name: "ocaml", exts: [".ml", ".mli"], wasm: "ocaml" },
    { name: "zig", exts: [".zig"], wasm: "zig" },
    { name: "dart", exts: [".dart"], wasm: "dart" }, // surfaced by PR #38 (@muneebshere)
    { name: "clojure", exts: [".clj", ".cljs", ".cljc", ".bb"], wasm: "clojure" },
    { name: "nix", exts: [".nix"], wasm: "nix" },
    { name: "lua", exts: [".lua"], wasm: "lua" }, { name: "luau", exts: [".luau"], wasm: "luau" },
];
const byExt = new Map();
for (const l of GENERIC_LANGS)
    for (const e of l.exts)
        byExt.set(e, l);
/** The generic language for a path, or null if no breadth grammar claims it. */
export function genericLangOf(path) {
    const lower = path.toLowerCase();
    for (const [ext, l] of byExt)
        if (lower.endsWith(ext))
            return l;
    return null;
}
/** Every file extension a breadth-tier (generic tree-sitter) grammar claims. */
export function genericExtensions() {
    return GENERIC_LANGS.flatMap((l) => l.exts);
}
const loaded = new Map();
let tsMod = null;
let initPromise = null;
async function ensureWasmInit() {
    if (!tsMod) {
        tsMod = await import("web-tree-sitter");
        initPromise = initPromise ?? tsMod.Parser.init();
    }
    await initPromise;
}
function requireWasm(wasm) {
    const localWasm = join(HERE, "..", "..", "grammars", `tree-sitter-${wasm}.wasm`);
    try {
        return readFileSync(localWasm);
    }
    catch {
        /* fall through to tree-sitter-wasm package */
    }
    // Resolve the grammar wasm from the tree-sitter-wasm bundle (its package.json
    // `exports` maps the bare "<lang>/…" subpath to the actual "out/<lang>/…" file).
    let resolvedWasm = null;
    try {
        const p = require.resolve(`tree-sitter-wasm/${wasm}/tree-sitter-${wasm}.wasm`);
        resolvedWasm = readFileSync(p);
    }
    catch {
        /* grammar not bundled in tree-sitter-wasm */
    }
    return resolvedWasm;
}
function loadQuery(name) {
    for (const dir of QUERY_DIRS) {
        try {
            const raw = readFileSync(join(dir, `${name}.scm`), "utf8");
            // Sanitize editor-specific query predicates the tree-sitter Query compiler rejects.
            return raw.replace(/\(#(?:strip!|set!|set-adjacent!|select-adjacent!|make-range!|offset!|gsub!)[^()]*\)/g, "");
        }
        catch {
            /* try next dir */
        }
    }
    return null;
}
/** Warm the WASM grammars for the given plexer lang names. Idempotent; must be
 * awaited once before extractGeneric is used in a sync loop. Unknown/unavailable
 * grammars are silently skipped (their files then extract as file-only). */
export async function warmGenericGrammars(langNames) {
    const want = new Set(langNames);
    const need = [...want].filter((n) => !loaded.has(n) && GENERIC_LANGS.some((l) => l.name === n));
    if (need.length === 0)
        return;
    await ensureWasmInit();
    const { Query } = tsMod;
    await Promise.all(need.map(async (name) => {
        const row = GENERIC_LANGS.find((l) => l.name === name);
        const language = await loadWasmLanguage(row.wasm);
        if (!language)
            return;
        const scm = loadQuery(name);
        let query = null;
        if (scm) {
            try {
                query = new Query(language, scm);
            }
            catch {
                query = null;
            }
        }
        loaded.set(name, { language, query });
    }));
}
/** Load one grammar from the tree-sitter-wasm bundle, initialising
 * web-tree-sitter on first call. Null when the wasm is missing or won't
 * instantiate — never throws, so a caller degrades instead of failing the build.
 *
 * Shared with the container tier (container.js), which needs a grammar to find
 * where an embedded language starts but none of the tags.scm machinery above.
 * Kept here so web-tree-sitter is initialised exactly once per process. */
export async function loadWasmLanguage(wasm) {
    await ensureWasmInit();
    const bytes = requireWasm(wasm);
    if (!bytes)
        return null;
    let lang = null;
    try {
        lang = await tsMod.Language.load(bytes);
    }
    catch {
        /* invalid or unsupported WASM binary */
    }
    return lang;
}
const PARSE_CHUNK = 16384; // <32KB slices — same tree-sitter limit workaround as extract.ts
const PARSERS = new WeakMap();
function getParser(language) {
    let parser = PARSERS.get(language);
    if (!parser) {
        parser = new tsMod.Parser();
        parser.setLanguage(language);
        PARSERS.set(language, parser);
    }
    return parser;
}
/** Parse with an already-loaded grammar. Returns the root node, or null if the
 * grammar was never warmed or the parse blew up. Companion to
 * `loadWasmLanguage` for callers outside this module. */
export function parseWasm(language, source) {
    if (!tsMod)
        return null;
    let parsedRoot = null;
    try {
        const parser = getParser(language);
        const tree = parser.parse((i) => source.slice(i, i + PARSE_CHUNK));
        if (tree) {
            parsedRoot = tree.rootNode;
            parsedRoot._tree = tree;
        }
    }
    catch {
        /* parser failure degrades to null root */
    }
    return parsedRoot;
}
function fileNode(rel, source) {
    return {
        id: rel, name: rel.split("/").pop() ?? rel, kind: "file", path: rel,
        span: `L1-L${Math.max(1, source.split("\n").length)}`, signature: null,
        exported: true, origin: "generic", body_hash: contentHash(source),
        chars: Buffer.byteLength(source), summary_state: "pending", summary: null, crux: null,
    };
}
/** Extract a single generic-tier file. Synchronous; needs the grammar pre-warmed.
 * Uses the grammar's compiled tags.scm when present (symbols + call edges);
 * otherwise falls back to a node-kind tree walker (symbols only) so ANY warmed
 * grammar yields a graph even with no vendored query. */
export function extractGeneric(rel, source, langName = genericLangOf(rel)?.name) {
    if (langName === "luau") return extractLuau(rel, source, loaded.get("luau"), tsMod);
    const nodes = [fileNode(rel, source)];
    const rawEdges = [];
    const entry = loaded.get(langName);
    if (!entry || !tsMod)
        return { nodes, rawEdges };
    let tree;
    try {
        const parser = getParser(entry.language);
        tree = parser.parse((i) => source.slice(i, i + PARSE_CHUNK));
    }
    catch (err) {
        throw new Error(`${langName} grammar threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!tree)
        return { nodes, rawEdges };
    try {
        const minted = new Set([rel]);
        const lines = source.split("\n");
        const defs = [];
        const spanSeen = new Set();
        const mkDef = (name, kind, whole, owner = null) => {
            if (spanSeen.has(whole.startIndex))
                return;
            spanSeen.add(whole.startIndex);
            const effKind = owner && kind === "function" ? "method" : kind;
            const idName = owner ? `${owner}.${name}` : name;
            const id = mintId(`${rel}#${idName}`, minted);
            const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
            const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
            const rawSlice = source.slice(whole.startIndex, whole.endIndex);
            const exported = langName === "rust"
                ? rustExported(whole)
                : langName === "c" || langName === "cpp"
                    ? cCppExported(whole)
                    : true;
            const node = {
                id, name, kind: effKind, path: rel,
                span: `L${startRow + 1}-L${endRow + 1}`,
                signature: sigLine || null, exported, origin: "generic",
                body_hash: contentHash(rawSlice),
                body_text: searchBody(rawSlice),
                summary_state: "pending",
                summary: extractLeadingSummary(lines, startRow, rawSlice),
                crux: null,
            };
            if (owner)
                node.owner = owner;
            nodes.push(node);
            defs.push({ id, startIndex: whole.startIndex, endIndex: whole.endIndex, name, kind: effKind, owner });
        };
        if (entry.query) {
            tagsExtract(entry.query, tree.rootNode, rel, mkDef, defs, rawEdges, langName);
        }
        else {
            walkExtract(tree.rootNode, mkDef); // no tags.scm → symbols only
        }
        if (langName === "c" || langName === "cpp")
            extractIncludes(tree.rootNode, rel, rawEdges);
        else if (langName === "rust")
            extractRustExtras(tree.rootNode, rel, defs, rawEdges);
        else
            extractBreadthImports(langName, tree.rootNode, rel, rawEdges);
    }
    finally {
        tree.delete?.();
    }
    nodes[0].body_text = fileResidual(source, nodes.slice(1));
    return { nodes, rawEdges };
}
const RUST_TYPE_WRAPPERS = new Set(["Box", "Arc", "Rc", "Cell", "RefCell", "Mutex", "RwLock", "Option", "Result", "Pin"]);
/** Base type identifier for a Rust type AST node, unwrapping references, generics, paths, and dyn Trait. */
function rustTypeName(node) {
    let cur = node;
    for (let depth = 0; cur && depth < 12; depth++) {
        if (cur.type === "type_identifier" || cur.type === "identifier")
            return cur.text;
        if (cur.type === "reference_type" || cur.type === "pointer_type" || cur.type === "parenthesized_type") {
            cur = cur.childForFieldName?.("type") ?? cur.namedChild?.(0);
            continue;
        }
        if (cur.type === "dynamic_type" || cur.type === "abstract_type") {
            cur = cur.childForFieldName?.("trait") ?? cur.namedChild?.(0);
            continue;
        }
        if (cur.type === "scoped_type_identifier" || cur.type === "scoped_identifier") {
            return cur.childForFieldName?.("name")?.text ?? null;
        }
        if (cur.type === "generic_type") {
            const outer = rustTypeName(cur.childForFieldName?.("type"));
            if (outer && RUST_TYPE_WRAPPERS.has(outer)) {
                const args = cur.childForFieldName?.("type_arguments");
                if (args && args.namedChildCount > 0) {
                    cur = args.namedChild(0);
                    continue;
                }
            }
            return outer;
        }
        if (cur.type === "bounded_type") {
            cur = cur.namedChild?.(0);
            continue;
        }
        return null;
    }
    return null;
}
/** Enclosing impl/trait owner type for a Rust method/fn definition or call node. */
function rustEnclosingOwner(node, stopAtFn = false) {
    for (let p = node?.parent; p; p = p.parent) {
        if (stopAtFn && (p.type === "function_item" || p.type === "function_signature_item"))
            return null;
        if (p.type === "impl_item")
            return rustTypeName(p.childForFieldName?.("type"));
        if (p.type === "trait_item")
            return p.childForFieldName?.("name")?.text ?? null;
    }
    return null;
}
/** Collect `structName -> Map<fieldName, fieldType>` across all Rust structs in the file. */
function collectRustStructFields(root) {
    const out = new Map();
    const visit = (n) => {
        if (n.type === "struct_item") {
            const name = n.childForFieldName?.("name")?.text;
            const body = n.childForFieldName?.("body");
            if (name && body) {
                const fields = new Map();
                for (let i = 0; i < (body.namedChildCount ?? 0); i++) {
                    const f = body.namedChild(i);
                    if (f?.type !== "field_declaration")
                        continue;
                    const fn = f.childForFieldName?.("name")?.text;
                    const ft = rustTypeName(f.childForFieldName?.("type"));
                    if (fn && ft)
                        fields.set(fn, ft);
                }
                out.set(name, fields);
            }
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++)
            visit(n.namedChild(i));
    };
    visit(root);
    return out;
}
function inferRustLetBindingType(n, owner, fnReturns) {
    const ann = rustTypeName(n.childForFieldName?.("type"));
    if (ann)
        return ann;
    const val = n.childForFieldName?.("value");
    if (val?.type === "struct_expression")
        return rustTypeName(val.childForFieldName?.("name"));
    if (val?.type !== "call_expression")
        return null;
    const fn = val.childForFieldName?.("function");
    if (fn?.type === "scoped_identifier") {
        const seg = fn.childForFieldName?.("path")?.text?.split("::").pop();
        return seg === "Self" ? owner : (seg && /^[A-Z]/.test(seg) ? seg : null);
    }
    return fn?.type === "identifier" ? (fnReturns.get(fn.text) ?? null) : null;
}

function collectRustLetBindingsRecursive(n, fnNode, owner, fnReturns, vars) {
    if (n.type === "function_item" && n !== fnNode)
        return;
    if (n.type === "let_declaration") {
        const pat = n.childForFieldName?.("pattern");
        if (pat?.type === "identifier") {
            const resolved = inferRustLetBindingType(n, owner, fnReturns);
            if (resolved)
                vars.set(pat.text, resolved);
        }
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++)
        collectRustLetBindingsRecursive(n.namedChild(i), fnNode, owner, fnReturns, vars);
}

/** Collect parameter & `let` bindings inside a Rust function_item for receiver typing. */
function collectRustFnBindings(fnNode, owner, fnReturns) {
    const vars = new Map();
    if (owner)
        vars.set("self", owner);
    const params = fnNode?.childForFieldName?.("parameters");
    if (params) {
        for (let i = 0; i < params.namedChildCount; i++) {
            const p = params.namedChild(i);
            if (p?.type !== "parameter")
                continue;
            const pat = p.childForFieldName?.("pattern");
            const tn = rustTypeName(p.childForFieldName?.("type"));
            if (pat?.type === "identifier" && tn)
                vars.set(pat.text, tn);
        }
    }
    const body = fnNode?.childForFieldName?.("body");
    if (body)
        collectRustLetBindingsRecursive(body, fnNode, owner, fnReturns, vars);
    return vars;
}

function collectRustTopFnReturns(n, fnReturns) {
    if (n.type === "function_item" && !rustEnclosingOwner(n, true)) {
        const name = n.childForFieldName?.("name")?.text;
        const rt = rustTypeName(n.childForFieldName?.("return_type"));
        if (name && rt && /^[A-Z]/.test(rt))
            fnReturns.set(name, rt);
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++)
        collectRustTopFnReturns(n.namedChild(i), fnReturns);
}

function resolveRustNodeBindings(node, fnReturns, fnBindingsCache) {
    let fn = node?.parent;
    while (fn && fn.type !== "function_item")
        fn = fn.parent;
    if (!fn)
        return null;
    if (fnBindingsCache.has(fn))
        return fnBindingsCache.get(fn);
    const map = collectRustFnBindings(fn, rustEnclosingOwner(fn, true), fnReturns);
    fnBindingsCache.set(fn, map);
    return map;
}

function resolveRustFieldExprReceiver(recv, nameNode, structFields, fnReturns, fnBindingsCache) {
    if (!recv)
        return { viaMember: true };
    if (recv.type === "self" || (recv.type === "identifier" && recv.text === "self")) {
        const owner = rustEnclosingOwner(nameNode);
        return owner ? { viaMember: true, recvType: owner } : { viaMember: true };
    }
    if (recv.type === "identifier") {
        const recvType = resolveRustNodeBindings(nameNode, fnReturns, fnBindingsCache)?.get(recv.text) ?? null;
        return recvType ? { viaMember: true, recvType } : { viaMember: true };
    }
    if (recv.type === "field_expression") {
        const base = recv.childForFieldName?.("value");
        const fld = recv.childForFieldName?.("field")?.text;
        if ((base?.type === "self" || (base?.type === "identifier" && base.text === "self")) && fld) {
            const owner = rustEnclosingOwner(nameNode);
            const ft = owner ? structFields.get(owner)?.get(fld) : null;
            if (ft)
                return { viaMember: true, recvType: ft };
        }
    }
    return { viaMember: true };
}

/** Build Rust receiver-typing helper closure over a parsed file. */
function createRustCallResolver(root) {
    const structFields = collectRustStructFields(root);
    const fnReturns = new Map();
    const fnBindingsCache = new WeakMap();
    collectRustTopFnReturns(root, fnReturns);
    return (nameNode) => {
        const parent = nameNode.parent;
        if (!parent)
            return null;
        if (parent.type === "scoped_identifier") {
            const seg = (parent.childForFieldName?.("path")?.text ?? "").split("::").pop() ?? "";
            const owner = seg === "Self" ? rustEnclosingOwner(nameNode) : seg;
            return owner && /^[A-Z]/.test(owner) ? { viaMember: true, recvType: owner } : null;
        }
        if (parent.type === "field_expression") {
            return resolveRustFieldExprReceiver(parent.childForFieldName?.("value"), nameNode, structFields, fnReturns, fnBindingsCache);
        }
        return null;
    };
}
/** Flatten a Rust `use` subtree into normalized `crate/...` / `self/...` / `super/...` module paths. */
function expandRustUseTree(node, prefix, out) {
    if (!node)
        return;
    const flattenPath = (p) => {
        if (!p)
            return [];
        if (p.type === "scoped_identifier")
            return [...flattenPath(p.childForFieldName?.("path")), p.childForFieldName?.("name")?.text].filter(Boolean);
        return p.text ? [p.text] : [];
    };
    const emit = (parts) => {
        if (parts.length > 0 && (parts[0] === "crate" || parts[0] === "self" || parts[0] === "super"))
            out.push(parts.join("/"));
    };
    if (node.type === "scoped_use_list") {
        const nextPrefix = [...prefix, ...flattenPath(node.childForFieldName?.("path"))];
        const list = node.childForFieldName?.("list");
        for (let i = 0; i < (list?.namedChildCount ?? 0); i++)
            expandRustUseTree(list.namedChild(i), nextPrefix, out);
        return;
    }
    if (node.type === "use_list") {
        for (let i = 0; i < node.namedChildCount; i++)
            expandRustUseTree(node.namedChild(i), prefix, out);
        return;
    }
    if (node.type === "use_as_clause") {
        expandRustUseTree(node.childForFieldName?.("path"), prefix, out);
        return;
    }
    if (node.type === "use_wildcard") {
        const sub = node.namedChildCount > 0 ? flattenPath(node.namedChild(0)) : [];
        emit([...prefix, ...sub]);
        return;
    }
    if (node.type === "self" && prefix.length > 0) {
        emit(prefix);
        return;
    }
    if (node.type === "scoped_identifier" || node.type === "identifier" || node.type === "crate" || node.type === "super") {
        emit([...prefix, ...flattenPath(node)]);
    }
}
/** Rust extras: grouped `use` expansion, external `mod foo;`, and `impl Trait for Type` heritage. */
function extractRustExtras(root, rel, defs, rawEdges) {
    const defByName = new Map();
    for (const d of defs)
        if (d.kind !== "function" && d.kind !== "method" && !defByName.has(d.name))
            defByName.set(d.name, d.id);
    const specsSeen = new Set();
    const visit = (n) => {
        if (n.type === "use_declaration") {
            const specs = [];
            expandRustUseTree(n.childForFieldName?.("argument"), [], specs);
            for (const spec of specs) {
                if (!specsSeen.has(spec)) {
                    specsSeen.add(spec);
                    rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
                }
            }
        }
        else if (n.type === "mod_item" && !n.childForFieldName?.("body")) {
            const modName = n.childForFieldName?.("name")?.text;
            if (modName)
                rawEdges.push({ source: rel, relation: "imports", specifier: modName, isRustMod: true, file: rel });
        }
        else if (n.type === "impl_item") {
            const traitNode = n.childForFieldName?.("trait");
            const typeNode = n.childForFieldName?.("type");
            if (traitNode && typeNode) {
                const traitName = rustTypeName(traitNode);
                const typeName = rustTypeName(typeNode);
                if (traitName && typeName) {
                    const sourceId = defByName.get(typeName) ?? rel;
                    rawEdges.push({ source: sourceId, ownerName: typeName, relation: "implements", name: traitName, file: rel });
                }
            }
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild(i);
            if (c)
                visit(c);
        }
    };
    visit(root);
}
const BREADTH_UNQUOTE = (raw) => raw.replace(/^["'`]|["'`]$/g, "").trim();
function extractElixirAliasArgs(arg, out) {
    if (!arg)
        return;
    if (arg.type === "alias") {
        out.push(arg.text.trim());
    }
    else if (arg.type === "dot") {
        const left = arg.childForFieldName?.("left")?.text?.trim();
        const right = arg.childForFieldName?.("right");
        if (left && right?.type === "tuple") {
            for (let i = 0; i < right.namedChildCount; i++) {
                const sub = right.namedChild(i)?.text?.trim();
                if (sub)
                    out.push(`${left}.${sub}`);
            }
        }
    }
}
function clojureSymName(node) {
    return node?.type === "sym_lit" ? (node.childForFieldName?.("name")?.text ?? node.text) : null;
}
function collectClojureNsSpec(node, prefix, out) {
    if (!node)
        return;
    if (node.type === "sym_lit") {
        const sym = clojureSymName(node);
        if (sym)
            out.push(prefix ? `${prefix}.${sym}` : sym);
        return;
    }
    if (node.type !== "vec_lit" && node.type !== "list_lit")
        return;
    const headName = clojureSymName(node.namedChild(0));
    if (!headName)
        return;
    const fullPrefix = prefix ? `${prefix}.${headName}` : headName;
    const nested = [];
    for (let j = 1; j < node.namedChildCount; j++) {
        const item = node.namedChild(j);
        if (item?.type === "vec_lit" || item?.type === "list_lit")
            nested.push(item);
    }
    if (nested.length === 0) {
        out.push(fullPrefix);
        return;
    }
    for (const sub of nested)
        collectClojureNsSpec(sub, fullPrefix, out);
}
function extractClojureNsForm(nsForm, out) {
    for (let i = 0; i < nsForm.namedChildCount; i++) {
        const child = nsForm.namedChild(i);
        if (child?.type !== "list_lit")
            continue;
        const first = child.namedChild(0);
        const kwd = first?.type === "kwd_lit" ? first.childForFieldName?.("name")?.text : null;
        if (kwd !== "require" && kwd !== "require-macros" && kwd !== "use" && kwd !== "import")
            continue;
        for (let j = 1; j < child.namedChildCount; j++)
            collectClojureNsSpec(child.namedChild(j), "", out);
    }
}
function firstBreadthDesc(n, type) {
    if (!n)
        return null;
    if (n.type === type)
        return n;
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
        const hit = firstBreadthDesc(n.namedChild(i), type);
        if (hit)
            return hit;
    }
    return null;
}
function extractScalaBreadthImports(n, specs) {
    const parts = [];
    let selectors = null;
    for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c.type === "identifier" || c.type === "stable_identifier")
            parts.push(c.text);
        else if (c.type === "namespace_selectors")
            selectors = c;
    }
    const prefix = parts.join(".");
    if (!selectors) {
        if (prefix)
            specs.push(prefix);
        return;
    }
    for (let i = 0; i < selectors.namedChildCount; i++) {
        const sel = selectors.namedChild(i);
        const name = sel.type === "arrow_renamed_identifier"
            ? sel.childForFieldName?.("name")?.text
            : sel.type === "identifier" ? sel.text : null;
        if (name && prefix)
            specs.push(`${prefix}.${name}`);
        else if (sel.type === "namespace_wildcard" && prefix)
            specs.push(prefix);
    }
}
const BREADTH_IMPORT_HANDLERS = {
    ruby(n, specs) {
        if (n.type !== "call")
            return;
        const m = n.childForFieldName?.("method")?.text;
        if (m !== "require" && m !== "require_relative" && m !== "load")
            return;
        const str = firstBreadthDesc(n.childForFieldName?.("arguments"), "string_content")?.text?.trim();
        if (str)
            specs.push(m === "require_relative" && !str.startsWith(".") ? `./${str}` : str);
    },
    c_sharp(n, specs) {
        if (n.type !== "using_directive")
            return;
        const q = firstBreadthDesc(n, "qualified_name");
        const id = !q ? firstBreadthDesc(n, "identifier") : null;
        const ns = (q ?? id)?.text?.trim();
        if (ns && !/^System(?:\.|$)|^Microsoft(?:\.|$)/.test(ns))
            specs.push(ns);
    },
    scala(n, specs) {
        if (n.type === "import_declaration")
            extractScalaBreadthImports(n, specs);
    },
    elixir(n, specs) {
        if (n.type !== "call")
            return;
        const t = n.childForFieldName?.("target")?.text;
        if (t !== "alias" && t !== "import" && t !== "use" && t !== "require")
            return;
        for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c.type === "arguments" && c.namedChildCount > 0)
                extractElixirAliasArgs(c.namedChild(0), specs);
        }
    },
    dart(n, specs) {
        if (n.type !== "import_or_export" && n.type !== "part_directive")
            return;
        const lit = firstBreadthDesc(n, "string_literal")?.text;
        const uri = lit ? BREADTH_UNQUOTE(lit) : null;
        if (uri && !uri.startsWith("dart:"))
            specs.push(uri);
    },
    lua(n, specs) {
        if (n.type !== "function_call")
            return;
        const fn = n.childForFieldName?.("name")?.text;
        if (fn !== "require" && fn !== "dofile")
            return;
        const strNode = firstBreadthDesc(n.childForFieldName?.("arguments"), "string");
        const inner = strNode ? (firstBreadthDesc(strNode, "string_content")?.text ?? BREADTH_UNQUOTE(strNode.text)) : null;
        if (inner)
            specs.push(inner);
    },
    clojure(n, specs) {
        if (n.type !== "list_lit")
            return;
        const head = n.namedChild(0);
        const hName = head?.type === "sym_lit" ? head.childForFieldName?.("name")?.text : null;
        if (hName === "ns")
            extractClojureNsForm(n, specs);
    },
    nix(n, specs) {
        if (n.type !== "apply_expression")
            return;
        const fn = n.childForFieldName?.("function");
        const arg = n.childForFieldName?.("argument");
        const fnName = fn?.type === "variable_expression"
            ? fn.text.trim()
            : fn?.type === "select_expression" ? fn.childForFieldName?.("attrpath")?.text?.split(".").pop()?.trim() : null;
        if ((fnName === "import" || fnName === "callPackage") && arg?.type === "path_expression") {
            const p = arg.text.trim();
            if (p)
                specs.push(p);
        }
    },
    solidity(n, specs) {
        if (n.type !== "import_directive")
            return;
        const src = n.childForFieldName?.("source")?.text;
        const p = src ? BREADTH_UNQUOTE(src) : null;
        if (p)
            specs.push(p);
    },
};
function visitBreadthImportNode(handler, n, specs) {
    if (handler)
        handler(n, specs);
    for (let i = 0; i < (n.namedChildCount ?? 0); i++)
        visitBreadthImportNode(handler, n.namedChild(i), specs);
}
/** Breadth-tier `imports` raw edge extraction across Ruby, C#, Scala, Elixir, Dart, Lua, Clojure, Nix, and Solidity. */
function extractBreadthImports(langName, root, rel, rawEdges) {
    const specs = [];
    visitBreadthImportNode(BREADTH_IMPORT_HANDLERS[langName] ?? null, root, specs);
    const seen = new Set();
    for (const specifier of specs) {
        if (!seen.has(specifier)) {
            seen.add(specifier);
            rawEdges.push({ source: rel, relation: "imports", specifier, file: rel });
        }
    }
}
/** C/C++ `#include "header.h"` → a file→file `imports` raw edge. Only LOCAL includes
 * (quoted) are captured; system includes (`<stdio.h>`) are skipped — high volume, and
 * there is no in-repo target to navigate to. resolve.js settles the quoted path to an
 * in-repo header (relative to the including file, else a unique path-suffix match), and
 * keeps it as an external string when it cannot — never a guessed edge. */
function extractIncludes(root, rel, rawEdges) {
    const visitIncludeNode = (n) => {
        if (n.type === "preproc_include") {
            const raw = n.childForFieldName?.("path")?.text ?? "";
            if (raw.startsWith('"')) {
                const spec = raw.replace(/^"|"$/g, "").trim();
                if (spec)
                    rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
            }
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild?.(i);
            if (c)
                visitIncludeNode(c);
        }
    };
    visitIncludeNode(root);
}
/** tags.scm path: @definition.<kind> → nodes, @reference.call/@reference.send →
 * bare-name call edges attributed to the innermost enclosing definition. */
function tagsExtract(query, root, rel, mkDef, defs, rawEdges, langName) {
    const q = query;
    const matches = q.matches(root);
    // Some grammars' tags.scm capture a definition's own NAME token as a
    // @reference.call too (Ruby tags `def foo`'s `foo` as both @name and a call),
    // producing bogus self-loops (foo→foo). Skip any call at a definition's name token.
    const defNameAt = new Set();
    const calls = [];
    const refs = [];
    for (const m of matches) {
        const cap = {};
        for (const c of m.captures)
            cap[c.name] = c.node;
        const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
        if (defKey && cap.name) {
            defNameAt.add(cap.name.startIndex);
            const scopeNode = defScope(cap[defKey], langName);
            const defKind = KIND[defKey.slice("definition.".length)] ?? "function";
            const owner = langName === "rust" && (defKind === "function" || defKind === "method")
                ? rustEnclosingOwner(scopeNode, true)
                : null;
            mkDef(cap.name.text, defKind, scopeNode, owner);
        }
        if (("reference.call" in cap || "reference.send" in cap) && cap.name)
            calls.push({ name: cap.name.text, at: cap.name.startIndex, node: cap.name });
        // Structural references the grammar already marks: a supertype (extends), an
        // implemented interface, an object creation (`new Foo`), a module alias. Grammars
        // label these @reference.class/.interface/.implementation/.module — heterogeneous
        // syntactically but all "names this symbol without calling it". They become
        // `references` edges the same precision-first resolver settles to a type-like def
        // (same-file certain, unique cross-file inferred, ambiguous dropped), so a data
        // class that's only ever extended or instantiated stops being an orphan.
        if (("reference.class" in cap || "reference.interface" in cap ||
            "reference.implementation" in cap || "reference.module" in cap) && cap.name)
            refs.push({ name: cap.name.text, at: cap.name.startIndex });
    }
    const resolveRustCall = langName === "rust" ? createRustCallResolver(root) : null;
    for (const c of calls) {
        if (defNameAt.has(c.at))
            continue;
        const enc = enclosingDef(defs, c.at);
        const meta = resolveRustCall ? resolveRustCall(c.node) : null;
        rawEdges.push({ source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name, ...(meta ?? {}) });
    }
    for (const r of refs) {
        if (defNameAt.has(r.at))
            continue;
        const enc = enclosingDef(defs, r.at);
        if (!enc)
            continue; // a reference with no enclosing definition has no sound source
        rawEdges.push({ source: enc.id, relation: "references", file: rel, name: r.name });
    }
}
// Node-type → Kind for the walker fallback. A node is a definition when its type
// ends with a declaration-ish suffix AND names a construct — matched most-specific
// first (method before function). Covers the common tree-sitter grammar vocab
// without any per-language query.
const DEF_SUFFIX = /(declaration|definition|_item|_specifier|_decl|_def|_binding)$/;
const KIND_BY_NODE_TYPE = new Map();
function classifyKind(type) {
    if (KIND_BY_NODE_TYPE.has(type))
        return KIND_BY_NODE_TYPE.get(type);
    const t = type.toLowerCase();
    let kind = null;
    if (DEF_SUFFIX.test(t) || /^(class|struct|enum|interface|trait|module|namespace)/.test(t)) {
        if (/method|constructor/.test(t))
            kind = "method";
        else if (/func|function|def\b|subroutine|procedure/.test(t))
            kind = "function";
        else if (/class/.test(t))
            kind = "class";
        else if (/struct|record/.test(t))
            kind = "struct";
        else if (/interface|trait|protocol/.test(t))
            kind = "interface";
        else if (/enum/.test(t))
            kind = "enum";
        else if (/module|namespace|package|mod_/.test(t))
            kind = "module";
        else if (/const/.test(t))
            kind = "constant";
        else if (/type|alias/.test(t))
            kind = "type";
        else if (/(^|_)(val|var|let|field|property)/.test(t))
            kind = "variable";
    }
    KIND_BY_NODE_TYPE.set(type, kind);
    return kind;
}
/** The declared name of a node: its `name` field, else the first identifier-ish
 * descendant within a couple of levels. */
function nodeName(node) {
    const byField = node.childForFieldName?.("name");
    if (byField?.text)
        return byField.text;
    const stack = [{ n: node, d: 0 }];
    let visited = 0;
    for (let qi = 0; qi < stack.length && visited < 12; qi++, visited++) {
        const cur = stack[qi];
        const { n, d } = cur;
        if (d > 0 && /identifier|name/.test(n.type) && n.text && !n.text.includes("\n"))
            return n.text;
        if (d < 3)
            for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
                const c = n.namedChild?.(i);
                if (c)
                    stack.push({ n: c, d: d + 1 });
            }
    }
    return null;
}
/** Walker fallback: DFS every named node, emit a def for each classified one
 * (symbols only — no call resolution without a query). */
function walkExtract(root, mkDef) {
    const visit = (n) => {
        const kind = classifyKind(n.type);
        if (kind) {
            const name = nodeName(n);
            if (name)
                mkDef(name, kind, n);
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild?.(i);
            if (c)
                visit(c);
        }
    };
    visit(root);
}
