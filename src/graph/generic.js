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
import { cCppExported, genericExported, rustExported } from "./extract/visibility.js";
import { GENERIC_LANGS, genericExtensions, genericLangOf } from "./languages.js";
export { GENERIC_LANGS, genericExtensions, genericLangOf };
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// queries/ ships beside the compiled JS (copied by the build); fall back to src.
const QUERY_DIRS = [join(HERE, "queries"), join(HERE, "..", "..", "src", "graph", "queries")];
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
export async function warmGenericGrammars(langNames = GENERIC_LANGS.map((l) => l.name)) {
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
function collectRubyVisibility(root) {
    const privateRanges = [];
    const privateNames = new Set();
    const walkContainer = (container) => {
        const body = container?.namedChildren?.find((c) => c.type === "body_statement") ?? null;
        if (!body) {
            for (let i = 0; i < (container?.namedChildCount ?? 0); i++) {
                const c = container.namedChild(i);
                if (c?.type === "class" || c?.type === "module" || c?.type === "singleton_class")
                    walkContainer(c);
            }
            return;
        }
        let privStart = null;
        for (let i = 0; i < body.namedChildCount; i++) {
            const stmt = body.namedChild(i);
            if (!stmt)
                continue;
            if (stmt.type === "class" || stmt.type === "module" || stmt.type === "singleton_class") {
                walkContainer(stmt);
                continue;
            }
            if (stmt.type === "identifier") {
                const txt = stmt.text.trim();
                if ((txt === "private" || txt === "protected") && privStart === null)
                    privStart = stmt.endIndex;
                else if (txt === "public" && privStart !== null) {
                    privateRanges.push({ start: privStart, end: stmt.startIndex });
                    privStart = null;
                }
            }
            else if (stmt.type === "call") {
                const m = stmt.childForFieldName?.("method")?.text;
                if (m === "private" || m === "protected") {
                    const args = stmt.childForFieldName?.("arguments");
                    for (let j = 0; j < (args?.namedChildCount ?? 0); j++) {
                        const a = args.namedChild(j);
                        if (a?.type === "simple_symbol")
                            privateNames.add(a.text.replace(/^:/, "").trim());
                        else if (a?.type === "method") {
                            const mn = a.childForFieldName?.("name")?.text;
                            if (mn)
                                privateNames.add(mn);
                        }
                    }
                }
            }
        }
        if (privStart !== null)
            privateRanges.push({ start: privStart, end: body.endIndex });
    };
    walkContainer(root);
    return { privateRanges, privateNames };
}
/** Extract a single generic-tier file. Synchronous; needs the grammar pre-warmed.
 * Uses the grammar's compiled tags.scm when present (symbols + call edges);
 * otherwise falls back to a node-kind tree walker (symbols only) so ANY warmed
 * grammar yields a graph even with no vendored query. */
export function extractGeneric(rel, source, langName = genericLangOf(rel)?.name, opts = null) {
    if (langName === "luau")
        return extractLuau(rel, source, loaded.get("luau"), tsMod);
    if (langName === "lua" && opts?.luauMode && loaded.has("luau")) {
        try {
            const res = extractLuau(rel, source, loaded.get("luau"), tsMod);
            if (res?.nodes?.[0])
                res.nodes[0].luauMode = true;
            return res;
        }
        catch {
            /* fall back to standard lua extractor on non-Luau syntax */
        }
    }
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
        const isHeaderFile = /\.(?:h|hh|hpp|hxx|h\+\+|cuh)$/i.test(rel);
        const visibilityCtx = langName === "ruby" ? collectRubyVisibility(tree.rootNode) : null;
        const rustReturnTypes = langName === "rust" ? collectRustFnReturnMap(tree.rootNode) : null;
        const mkDef = (name, kind, whole, owner = null, extraMeta = null) => {
            if (spanSeen.has(whole.startIndex))
                return;
            spanSeen.add(whole.startIndex);
            const effKind = owner && kind === "function" ? "method" : kind;
            const idName = owner ? `${owner}.${name}` : name;
            const id = mintId(`${rel}#${idName}`, minted);
            const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
            const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
            const rawSlice = source.slice(whole.startIndex, whole.endIndex);
            const exported = genericExported(langName, whole, name, visibilityCtx);
            const retKey = owner ? `${owner}.${name}` : name;
            const returnType = rustReturnTypes ? (rustReturnTypes.get(retKey) ?? null) : null;
            const node = {
                id, name, kind: effKind, path: rel,
                span: `L${startRow + 1}-L${endRow + 1}`,
                signature: sigLine || null, exported, origin: "generic",
                body_hash: contentHash(rawSlice),
                body_text: searchBody(rawSlice),
                summary_state: "pending",
                summary: extractLeadingSummary(lines, startRow, rawSlice, langName),
                crux: null,
            };
            if (owner)
                node.owner = owner;
            if (extraMeta?.declaration)
                node.declaration = true;
            if (returnType)
                node.returnType = returnType;
            nodes.push(node);
            defs.push({ id, startIndex: whole.startIndex, endIndex: whole.endIndex, name, kind: effKind, owner });
        };
        const importAliases = new Map();
        if (langName === "c" || langName === "cpp" || langName === "objc" || langName === "cuda")
            extractIncludes(tree.rootNode, rel, rawEdges);
        else if (langName === "rust")
            extractRustExtras(tree.rootNode, rel, defs, rawEdges);
        else
            extractBreadthImports(langName, tree.rootNode, rel, rawEdges, importAliases);
        if (entry.query) {
            tagsExtract(entry.query, tree.rootNode, rel, mkDef, defs, rawEdges, langName, isHeaderFile, importAliases);
        }
        else {
            walkExtract(tree.rootNode, mkDef); // no tags.scm → symbols only
        }
        extractBreadthExtras(langName, tree.rootNode, rel, defs, mkDef, rawEdges, lines);
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
    if (fn?.type === "field_expression") {
        const base = fn.childForFieldName?.("value");
        const fld = fn.childForFieldName?.("field")?.text;
        const baseType = base?.type === "identifier" ? (base.text === "self" ? owner : null) : null;
        if (baseType && fld)
            return fnReturns.get(`${baseType}.${fld}`) ?? null;
    }
    return fn?.type === "identifier" ? (fnReturns.get(fn.text) ?? null) : null;
}

function collectRustPatternBoundId(pat) {
    if (!pat)
        return null;
    if (pat.type === "identifier")
        return pat.text;
    if (pat.type === "tuple_struct_pattern" || pat.type === "tuple_pattern") {
        const firstId = pat.namedChildren?.find((c) => c.type === "identifier");
        return firstId?.text ?? null;
    }
    return null;
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
    else if (n.type === "let_condition") {
        const pat = n.childForFieldName?.("pattern");
        const val = n.childForFieldName?.("value");
        const bound = collectRustPatternBoundId(pat);
        const typeGuess = val?.type === "call_expression" && val.childForFieldName?.("function")?.type === "identifier"
            ? (fnReturns.get(val.childForFieldName("function").text) ?? null)
            : null;
        if (bound && typeGuess)
            vars.set(bound, typeGuess);
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

function collectRustFnReturnMap(root) {
    const fnReturns = new Map();
    const visit = (n) => {
        if (n.type === "function_item") {
            const name = n.childForFieldName?.("name")?.text;
            const rt = rustTypeName(n.childForFieldName?.("return_type"));
            const owner = rustEnclosingOwner(n, true);
            if (name && rt) {
                const eff = rt === "Self" && owner ? owner : rt;
                if (/^[A-Z]/.test(eff)) {
                    fnReturns.set(owner ? `${owner}.${name}` : name, eff);
                }
            }
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++)
            visit(n.namedChild(i));
    };
    visit(root);
    return fnReturns;
}

function collectRustTopFnReturns(n, fnReturns) {
    for (const [k, v] of collectRustFnReturnMap(n)) {
        fnReturns.set(k, v);
    }
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

function inferRustExprType(expr, nameNode, structFields, fnReturns, fnBindingsCache, depth = 0) {
    if (!expr || depth > 4)
        return null;
    if (expr.type === "self" || (expr.type === "identifier" && expr.text === "self"))
        return rustEnclosingOwner(nameNode);
    if (expr.type === "identifier")
        return resolveRustNodeBindings(nameNode, fnReturns, fnBindingsCache)?.get(expr.text) ?? null;
    if (expr.type === "field_expression") {
        const baseType = inferRustExprType(expr.childForFieldName?.("value"), nameNode, structFields, fnReturns, fnBindingsCache, depth + 1);
        const fld = expr.childForFieldName?.("field")?.text;
        return baseType && fld ? (structFields.get(baseType)?.get(fld) ?? null) : null;
    }
    if (expr.type === "call_expression") {
        const fn = expr.childForFieldName?.("function");
        if (fn?.type === "identifier")
            return fnReturns.get(fn.text) ?? null;
        if (fn?.type === "scoped_identifier") {
            const seg = fn.childForFieldName?.("path")?.text?.split("::").pop();
            const owner = seg === "Self" ? rustEnclosingOwner(nameNode) : seg;
            const m = fn.childForFieldName?.("name")?.text;
            if (owner && m)
                return fnReturns.get(`${owner}.${m}`) ?? (m === "new" && /^[A-Z]/.test(owner) ? owner : null);
        }
        if (fn?.type === "field_expression") {
            const recvType = inferRustExprType(fn.childForFieldName?.("value"), nameNode, structFields, fnReturns, fnBindingsCache, depth + 1);
            const m = fn.childForFieldName?.("field")?.text;
            if (recvType && m)
                return fnReturns.get(`${recvType}.${m}`) ?? null;
        }
    }
    return null;
}

function resolveRustFieldExprReceiver(recv, nameNode, structFields, fnReturns, fnBindingsCache) {
    if (!recv)
        return { viaMember: true };
    const recvType = inferRustExprType(recv, nameNode, structFields, fnReturns, fnBindingsCache, 0);
    return recvType ? { viaMember: true, recvType } : { viaMember: true };
}

/** Build Rust receiver-typing helper closure over a parsed file. */
function createRustCallResolver(root) {
    const structFields = collectRustStructFields(root);
    const fnReturns = collectRustFnReturnMap(root);
    const fnBindingsCache = new WeakMap();
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
const RUST_STD_CRATES = new Set(["std", "core", "alloc", "proc_macro", "test"]);
/** Flatten a Rust `use` subtree into `{ spec, exportedName, localName, isWildcard }` entries. */
function expandRustUseTree(node, prefix, out, aliasAs = null) {
    if (!node)
        return;
    const flattenPath = (p) => {
        if (!p)
            return [];
        if (p.type === "scoped_identifier")
            return [...flattenPath(p.childForFieldName?.("path")), p.childForFieldName?.("name")?.text].filter(Boolean);
        return p.text ? [p.text] : [];
    };
    const emit = (parts, explicitAlias = aliasAs, isWildcard = false) => {
        if (parts.length === 0)
            return;
        if (RUST_STD_CRATES.has(parts[0]))
            return;
        const spec = parts.join("/");
        const itemName = parts[parts.length - 1];
        out.push({
            spec,
            localName: itemName,
            exportedName: explicitAlias || itemName,
            isWildcard: Boolean(isWildcard),
        });
    };
    if (node.type === "scoped_use_list") {
        const nextPrefix = [...prefix, ...flattenPath(node.childForFieldName?.("path"))];
        const list = node.childForFieldName?.("list");
        for (let i = 0; i < (list?.namedChildCount ?? 0); i++)
            expandRustUseTree(list.namedChild(i), nextPrefix, out, null);
        return;
    }
    if (node.type === "use_list") {
        for (let i = 0; i < node.namedChildCount; i++)
            expandRustUseTree(node.namedChild(i), prefix, out, null);
        return;
    }
    if (node.type === "use_as_clause") {
        const aliasNode = node.childForFieldName?.("alias");
        expandRustUseTree(node.childForFieldName?.("path"), prefix, out, aliasNode?.text ?? null);
        return;
    }
    if (node.type === "use_wildcard") {
        const sub = node.namedChildCount > 0 ? flattenPath(node.namedChild(0)) : [];
        emit([...prefix, ...sub], null, true);
        return;
    }
    if (node.type === "self" && prefix.length > 0) {
        emit(prefix, aliasAs, true);
        return;
    }
    if (node.type === "scoped_identifier" || node.type === "identifier" || node.type === "crate" || node.type === "super") {
        emit([...prefix, ...flattenPath(node)], aliasAs, false);
    }
}
function rustAttrPathTarget(modNode) {
    let sib = modNode?.previousNamedSibling;
    for (let k = 0; sib && k < 4 && sib.type === "attribute_item"; k++) {
        const attr = sib.namedChildren?.find((c) => c.type === "attribute");
        const name = attr?.childForFieldName?.("name")?.text ?? attr?.namedChildren?.[0]?.text;
        if (name === "path") {
            const valNode = attr.childForFieldName?.("value") ?? attr.namedChildren?.find((c) => c.type === "string_literal");
            const strContent = firstBreadthDesc(valNode ?? attr, "string_content")?.text ?? valNode?.text?.replace(/^"|"$/g, "");
            if (strContent)
                return strContent.trim();
        }
        sib = sib.previousNamedSibling;
    }
    return null;
}
/** Rust extras: grouped `use` & `pub use` re-export expansion, external/#[path] `mod`, and `impl Trait for Type` heritage. */
function extractRustExtras(root, rel, defs, rawEdges) {
    const defByName = new Map();
    for (const d of defs)
        if (d.kind !== "function" && d.kind !== "method" && !defByName.has(d.name))
            defByName.set(d.name, d.id);
    const specsSeen = new Set();
    const visit = (n) => {
        if (n.type === "use_declaration") {
            const isPub = Boolean(n.namedChildren?.some((c) => c.type === "visibility_modifier" && c.text.trim().startsWith("pub")));
            const entries = [];
            expandRustUseTree(n.childForFieldName?.("argument"), [], entries, null);
            for (const item of entries) {
                if (!specsSeen.has(item.spec)) {
                    specsSeen.add(item.spec);
                    rawEdges.push({ source: rel, relation: "imports", specifier: item.spec, file: rel });
                }
                if (isPub) {
                    rawEdges.push({
                        source: rel,
                        relation: "reexports",
                        specifier: item.spec,
                        exportedName: item.exportedName,
                        localName: item.localName,
                        ...(item.isWildcard ? { star: true } : {}),
                        file: rel,
                    });
                }
            }
        }
        else if (n.type === "mod_item" && !n.childForFieldName?.("body")) {
            const attrPath = rustAttrPathTarget(n);
            if (attrPath) {
                const relSpec = attrPath.startsWith(".") ? attrPath : `./${attrPath}`;
                rawEdges.push({ source: rel, relation: "imports", specifier: relSpec, isRustMod: true, file: rel });
            }
            else {
                const modName = n.childForFieldName?.("name")?.text;
                if (modName)
                    rawEdges.push({ source: rel, relation: "imports", specifier: modName, isRustMod: true, file: rel });
            }
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
function extractElixirAliasArgs(arg, out, aliases, isAliasDirective = false, explicitAs = null) {
    if (!arg)
        return;
    if (arg.type === "alias") {
        const mod = arg.text.trim();
        out.push(mod);
        if (aliases) {
            const shortName = explicitAs || (isAliasDirective ? mod.split(".").pop() : null);
            if (shortName)
                aliases.set(shortName, mod);
        }
    }
    else if (arg.type === "dot") {
        const left = arg.childForFieldName?.("left")?.text?.trim();
        const right = arg.childForFieldName?.("right");
        if (left && right?.type === "tuple") {
            for (let i = 0; i < right.namedChildCount; i++) {
                const sub = right.namedChild(i)?.text?.trim();
                if (sub) {
                    const mod = `${left}.${sub}`;
                    out.push(mod);
                    if (aliases && isAliasDirective)
                        aliases.set(sub.split(".").pop(), mod);
                }
            }
        }
    }
}
function extractElixirKeywordAs(argsNode) {
    for (let i = 1; i < (argsNode?.namedChildCount ?? 0); i++) {
        const arg = argsNode.namedChild(i);
        if (arg?.type !== "keywords")
            continue;
        for (let j = 0; j < arg.namedChildCount; j++) {
            const pair = arg.namedChild(j);
            if (pair?.type !== "pair")
                continue;
            const k = pair.childForFieldName?.("key")?.text?.replace(/[:\s]/g, "");
            if (k === "as") {
                const v = pair.childForFieldName?.("value")?.text?.trim();
                if (v)
                    return v;
            }
        }
    }
    return null;
}
function clojureSymName(node) {
    return node?.type === "sym_lit" ? (node.childForFieldName?.("name")?.text ?? node.text) : null;
}
function collectClojureNsSpec(node, prefix, out, aliases) {
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
        if (item?.type === "kwd_lit" && item.childForFieldName?.("name")?.text === "as") {
            const next = node.namedChild(j + 1);
            const aliasName = clojureSymName(next);
            if (aliasName && aliases)
                aliases.set(aliasName, fullPrefix);
        }
        else if (item?.type === "vec_lit" || item?.type === "list_lit") {
            nested.push(item);
        }
    }
    if (nested.length === 0) {
        out.push(fullPrefix);
        return;
    }
    for (const sub of nested)
        collectClojureNsSpec(sub, fullPrefix, out, aliases);
}
function extractClojureNsForm(nsForm, out, aliases) {
    for (let i = 0; i < nsForm.namedChildCount; i++) {
        const child = nsForm.namedChild(i);
        if (child?.type !== "list_lit")
            continue;
        const first = child.namedChild(0);
        const kwd = first?.type === "kwd_lit" ? first.childForFieldName?.("name")?.text : null;
        if (kwd !== "require" && kwd !== "require-macros" && kwd !== "use" && kwd !== "import")
            continue;
        for (let j = 1; j < child.namedChildCount; j++)
            collectClojureNsSpec(child.namedChild(j), "", out, aliases);
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
function collectBreadthDesc(n, type, out = [], stopAt = null) {
    if (!n)
        return out;
    if (n.type === type)
        out.push(n);
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
        const c = n.namedChild(i);
        if (c && (!stopAt || !stopAt.has(c.type)))
            collectBreadthDesc(c, type, out, stopAt);
    }
    return out;
}
function extractScalaBreadthImports(n, specs, aliases) {
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
        if (sel.type === "arrow_renamed_identifier") {
            const orig = sel.childForFieldName?.("name")?.text;
            const alias = sel.childForFieldName?.("alias")?.text;
            if (orig && prefix)
                specs.push(`${prefix}.${orig}`);
            if (alias && orig && aliases)
                aliases.set(alias, prefix ? `${prefix}.${orig}` : orig);
        }
        else if (sel.type === "identifier") {
            if (prefix)
                specs.push(`${prefix}.${sel.text}`);
        }
        else if (sel.type === "namespace_wildcard" && prefix) {
            specs.push(prefix);
        }
    }
}
function extractOcamlOpenOrInclude(n, specs) {
    if (n.type !== "open_module" && n.type !== "include_module")
        return;
    const mod = n.childForFieldName?.("module")?.text?.trim();
    if (mod)
        specs.push(mod);
}
const BREADTH_IMPORT_HANDLERS = {
    ruby(n, specs) {
        if (n.type !== "call")
            return;
        const m = n.childForFieldName?.("method")?.text;
        if (m !== "require" && m !== "require_relative" && m !== "load" && m !== "autoload")
            return;
        const args = n.childForFieldName?.("arguments");
        const strNodes = collectBreadthDesc(args, "string_content");
        const str = (m === "autoload" ? strNodes[1] : strNodes[0])?.text?.trim();
        if (str)
            specs.push(m === "require_relative" && !str.startsWith(".") ? `./${str}` : str);
    },
    c_sharp(n, specs, aliases) {
        if (n.type !== "using_directive")
            return;
        const ne = firstBreadthDesc(n, "name_equals");
        const aliasId = ne ? firstBreadthDesc(ne, "identifier")?.text?.trim() : null;
        const q = firstBreadthDesc(n, "qualified_name");
        const id = !q && !ne ? firstBreadthDesc(n, "identifier") : null;
        const ns = (q ?? id)?.text?.trim();
        if (ns && !/^System(?:\.|$)|^Microsoft(?:\.|$)/.test(ns)) {
            specs.push(ns);
            if (aliasId && aliases)
                aliases.set(aliasId, ns);
        }
    },
    scala(n, specs, aliases) {
        if (n.type === "import_declaration")
            extractScalaBreadthImports(n, specs, aliases);
    },
    elixir(n, specs, aliases) {
        if (n.type !== "call")
            return;
        const t = n.childForFieldName?.("target")?.text;
        if (t !== "alias" && t !== "import" && t !== "use" && t !== "require")
            return;
        for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c.type === "arguments" && c.namedChildCount > 0) {
                const explicitAs = t === "alias" ? extractElixirKeywordAs(c) : null;
                extractElixirAliasArgs(c.namedChild(0), specs, aliases, t === "alias", explicitAs);
            }
        }
    },
    dart(n, specs, aliases) {
        if (n.type !== "import_or_export" && n.type !== "part_directive")
            return;
        const lit = firstBreadthDesc(n, "string_literal")?.text;
        const uri = lit ? BREADTH_UNQUOTE(lit) : null;
        if (uri && !uri.startsWith("dart:")) {
            specs.push(uri);
            if (aliases && n.type === "import_or_export") {
                for (let i = 0; i < n.namedChildCount; i++) {
                    const ch = n.namedChild(i);
                    if (ch?.type === "identifier") {
                        aliases.set(ch.text.trim(), uri);
                        break;
                    }
                }
            }
        }
    },
    lua(n, specs) {
        if (n.type !== "function_call")
            return;
        const fn = n.childForFieldName?.("name")?.text;
        const args = n.childForFieldName?.("arguments");
        if (fn === "require" || fn === "dofile") {
            const strNode = firstBreadthDesc(args, "string");
            const inner = strNode ? (firstBreadthDesc(strNode, "string_content")?.text ?? BREADTH_UNQUOTE(strNode.text)) : null;
            if (inner)
                specs.push(inner);
            return;
        }
        if ((fn === "pcall" || fn === "xpcall") && args) {
            const firstArg = args.namedChild(0)?.text?.trim();
            if (firstArg === "require" || firstArg === "dofile") {
                const strNodes = collectBreadthDesc(args, "string");
                const strNode = strNodes[0];
                const inner = strNode ? (firstBreadthDesc(strNode, "string_content")?.text ?? BREADTH_UNQUOTE(strNode.text)) : null;
                if (inner)
                    specs.push(inner);
            }
        }
    },
    clojure(n, specs, aliases) {
        if (n.type !== "list_lit")
            return;
        const head = n.namedChild(0);
        const hName = head?.type === "sym_lit" ? head.childForFieldName?.("name")?.text : null;
        if (hName === "ns")
            extractClojureNsForm(n, specs, aliases);
    },
    nix(n, specs) {
        if (n.type !== "apply_expression")
            return;
        const fn = n.childForFieldName?.("function");
        let arg = n.childForFieldName?.("argument");
        const fnName = fn?.type === "variable_expression"
            ? fn.text.trim()
            : fn?.type === "select_expression" ? fn.childForFieldName?.("attrpath")?.text?.split(".").pop()?.trim() : null;
        if (arg?.type === "parenthesized_expression")
            arg = arg.childForFieldName?.("expression") ?? arg.namedChild?.(0);
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
    ocaml(n, specs, aliases) {
        extractOcamlOpenOrInclude(n, specs);
        if (n.type === "module_binding" && aliases) {
            const name = n.childForFieldName?.("name")?.text?.trim() ?? firstBreadthDesc(n, "module_name")?.text?.trim();
            const body = n.childForFieldName?.("body");
            if (name && body?.type === "module_path")
                aliases.set(name, body.text.trim());
        }
    },
    ocaml_interface(n, specs, aliases) {
        extractOcamlOpenOrInclude(n, specs);
        if (n.type === "module_binding" && aliases) {
            const name = firstBreadthDesc(n, "module_name")?.text?.trim();
            const body = n.childForFieldName?.("body");
            if (name && body?.type === "module_path")
                aliases.set(name, body.text.trim());
        }
    },
    zig(n, specs, aliases) {
        if (n.type !== "builtin_function")
            return;
        const bid = firstBreadthDesc(n, "builtin_identifier")?.text?.trim();
        if (bid !== "@import")
            return;
        const args = n.childForFieldName?.("arguments") ?? firstBreadthDesc(n, "arguments");
        const sc = firstBreadthDesc(args, "string_content")?.text?.trim();
        if (!sc || sc === "std" || sc === "builtin" || sc === "root")
            return;
        specs.push(sc);
        if (aliases) {
            let p = n.parent;
            while (p && p.type !== "variable_declaration" && p.type !== "source_file")
                p = p.parent;
            if (p?.type === "variable_declaration") {
                for (let i = 0; i < p.namedChildCount; i++) {
                    const ch = p.namedChild(i);
                    if (ch?.type === "identifier") {
                        aliases.set(ch.text.trim(), sc);
                        break;
                    }
                }
            }
        }
    },
    bash(n, specs) {
        if (n.type !== "command")
            return;
        const cmd = n.childForFieldName?.("name")?.text?.trim();
        if (cmd !== "source" && cmd !== ".")
            return;
        for (let i = 0; i < n.namedChildCount; i++) {
            const ch = n.namedChild(i);
            if (!ch || ch.type === "command_name")
                continue;
            const raw = firstBreadthDesc(ch, "string_content")?.text ?? BREADTH_UNQUOTE(ch.text);
            const cleaned = raw.replace(/^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)\//, "./").trim();
            if (cleaned && !cleaned.startsWith("-")) {
                specs.push(cleaned);
                break;
            }
        }
    },
    hcl(n, specs) {
        if (n.type !== "block")
            return;
        const kindId = n.namedChild(0)?.type === "identifier" ? n.namedChild(0).text.trim() : null;
        if (kindId !== "module")
            return;
        const body = firstBreadthDesc(n, "body");
        if (!body)
            return;
        for (let i = 0; i < body.namedChildCount; i++) {
            const attr = body.namedChild(i);
            if (attr?.type !== "attribute")
                continue;
            const key = attr.namedChild(0)?.text?.trim();
            if (key !== "source")
                continue;
            const tmpl = firstBreadthDesc(attr, "template_literal")?.text ?? firstBreadthDesc(attr, "string_lit")?.text;
            const spec = tmpl ? BREADTH_UNQUOTE(tmpl) : null;
            if (spec)
                specs.push(spec);
            break;
        }
    },
    proto(n, specs) {
        if (n.type !== "import")
            return;
        const pathNode = n.childForFieldName?.("path") ?? firstBreadthDesc(n, "string");
        const p = pathNode ? BREADTH_UNQUOTE(pathNode.text) : null;
        if (p)
            specs.push(p);
    },
    haskell(n, specs, aliases) {
        if (n.type !== "import")
            return;
        const mod = n.childForFieldName?.("module")?.text?.trim();
        if (!mod)
            return;
        specs.push(mod);
        const alias = n.childForFieldName?.("alias")?.text?.trim();
        if (alias && aliases)
            aliases.set(alias, mod);
    },
    gleam(n, specs, aliases) {
        if (n.type !== "import")
            return;
        const mod = n.childForFieldName?.("module")?.text?.trim();
        if (!mod)
            return;
        specs.push(mod);
        if (aliases) {
            const aliasNode = n.childForFieldName?.("alias");
            const aliasName = aliasNode?.text?.trim() || mod.split("/").pop();
            if (aliasName)
                aliases.set(aliasName, mod);
        }
    },
};
function visitBreadthImportNode(handler, n, specs, aliases) {
    if (handler)
        handler(n, specs, aliases);
    for (let i = 0; i < (n.namedChildCount ?? 0); i++)
        visitBreadthImportNode(handler, n.namedChild(i), specs, aliases);
}
/** Breadth-tier `imports` raw edge extraction across all breadth languages. */
function extractBreadthImports(langName, root, rel, rawEdges, importAliases) {
    const specs = [];
    visitBreadthImportNode(BREADTH_IMPORT_HANDLERS[langName] ?? null, root, specs, importAliases);
    const seen = new Set();
    for (const specifier of specs) {
        if (!seen.has(specifier)) {
            seen.add(specifier);
            rawEdges.push({ source: rel, relation: "imports", specifier, file: rel });
        }
    }
}
/** C/C++/ObjC/CUDA `#include "header.h"` / `#import "Header.h"` → a file→file `imports` raw edge.
 * Only LOCAL quoted includes are captured; system includes (`<stdio.h>`) are skipped. */
function extractIncludes(root, rel, rawEdges) {
    const seen = new Set();
    const visitIncludeNode = (n) => {
        if (n.type === "preproc_include") {
            const raw = n.childForFieldName?.("path")?.text ?? "";
            if (raw.startsWith('"')) {
                const spec = raw.replace(/^"|"$/g, "").trim();
                if (spec && !seen.has(spec)) {
                    seen.add(spec);
                    rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
                }
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
function classifyCCppFnNode(node) {
    if (node?.type === "preproc_function_def")
        return "def";
    let cur = node;
    while (cur) {
        if (cur.type === "function_definition")
            return "def";
        if (cur.type === "compound_statement" || cur.type === "parameter_declaration" || cur.type === "type_definition")
            return null;
        if (cur.type === "declaration" || cur.type === "field_declaration")
            return "proto";
        cur = cur.parent;
    }
    return null;
}
const FN_BOUNDARY_NODES = new Set([
    "function_definition", "function_declaration", "method_declaration", "method_definition",
    "method", "singleton_method", "function_signature", "function_body", "lambda_expression",
]);
function cppQualifiedScopeName(defNode) {
    let cur = defNode;
    while (cur) {
        if (cur.type === "qualified_identifier") {
            const sc = cur.childForFieldName?.("scope")?.text?.trim();
            if (sc) {
                const stripped = sc.replace(/<[^>]*>/g, "").trim();
                const parts = stripped.split("::").filter(Boolean);
                return parts[parts.length - 1] ?? null;
            }
        }
        cur = cur.childForFieldName?.("declarator");
    }
    return null;
}
function rubyNodeConstName(node) {
    if (!node)
        return null;
    if (node.type === "scope_resolution")
        return node.childForFieldName?.("name")?.text?.trim() ?? node.text.trim();
    return node.text?.trim() || null;
}
function genericEnclosingOwner(langName, defKind, scopeNode, defNode) {
    if (langName === "rust" && (defKind === "function" || defKind === "method"))
        return rustEnclosingOwner(scopeNode, true);
    if (defKind !== "function" && defKind !== "method" && defKind !== "property" && defKind !== "variable" && defKind !== "constant")
        return null;
    if (langName === "cpp" || langName === "cuda") {
        const outOfLine = cppQualifiedScopeName(defNode);
        if (outOfLine)
            return outOfLine;
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (FN_BOUNDARY_NODES.has(cur.type))
                break;
            if (cur.type === "class_specifier" || cur.type === "struct_specifier")
                return cur.childForFieldName?.("name")?.text?.trim() ?? null;
        }
        return null;
    }
    if (langName === "objc") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type === "class_interface" || cur.type === "class_implementation" || cur.type === "protocol_declaration") {
                for (let i = 0; i < cur.namedChildCount; i++) {
                    const ch = cur.namedChild(i);
                    if (ch?.type === "identifier")
                        return ch.text.trim();
                }
            }
        }
        return null;
    }
    if (langName === "c_sharp") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (FN_BOUNDARY_NODES.has(cur.type))
                break;
            if (cur.type === "class_declaration" || cur.type === "struct_declaration" ||
                cur.type === "record_declaration" || cur.type === "interface_declaration") {
                return cur.childForFieldName?.("name")?.text?.trim() ?? null;
            }
        }
        return null;
    }
    if (langName === "scala") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (FN_BOUNDARY_NODES.has(cur.type))
                break;
            if (cur.type === "class_definition" || cur.type === "object_definition" ||
                cur.type === "trait_definition" || cur.type === "enum_definition") {
                return cur.childForFieldName?.("name")?.text?.trim() ?? null;
            }
        }
        return null;
    }
    if (langName === "dart") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type === "function_body")
                break;
            if (cur.type === "class_definition" || cur.type === "enum_declaration" || cur.type === "extension_declaration")
                return cur.childForFieldName?.("name")?.text?.trim() ?? null;
            if (cur.type === "mixin_declaration") {
                for (let i = 0; i < cur.namedChildCount; i++) {
                    const ch = cur.namedChild(i);
                    if (ch?.type === "identifier")
                        return ch.text.trim();
                }
            }
        }
        return null;
    }
    if (langName === "ruby") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type === "method" || cur.type === "singleton_method")
                break;
            if (cur.type === "class" || cur.type === "module")
                return rubyNodeConstName(cur.childForFieldName?.("name"));
        }
        return null;
    }
    if (langName === "solidity") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (FN_BOUNDARY_NODES.has(cur.type))
                break;
            if (cur.type === "contract_declaration" || cur.type === "interface_declaration" || cur.type === "library_declaration")
                return cur.childForFieldName?.("name")?.text?.trim() ?? null;
        }
        return null;
    }
    if (langName === "zig") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (FN_BOUNDARY_NODES.has(cur.type))
                break;
            if (cur.type === "struct_declaration" || cur.type === "enum_declaration" || cur.type === "union_declaration") {
                const vd = cur.parent;
                if (vd?.type === "variable_declaration") {
                    for (let i = 0; i < vd.namedChildCount; i++) {
                        const ch = vd.namedChild(i);
                        if (ch?.type === "identifier")
                            return ch.text.trim();
                    }
                }
                return null;
            }
        }
        return null;
    }
    if (langName === "elixir") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type !== "call")
                continue;
            const tgt = cur.childForFieldName?.("target")?.text?.trim();
            if (tgt === "defmodule" || tgt === "defprotocol" || tgt === "defimpl") {
                const args = firstBreadthDesc(cur, "arguments");
                return firstBreadthDesc(args, "alias")?.text?.trim() ?? null;
            }
        }
        return null;
    }
    if (langName === "ocaml" || langName === "ocaml_interface") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type === "class_binding" || cur.type === "class_type_binding")
                return firstBreadthDesc(cur, "class_name")?.text?.trim()
                    ?? firstBreadthDesc(cur, "class_type_name")?.text?.trim() ?? null;
        }
        return null;
    }
    if (langName === "proto") {
        for (let cur = defNode?.parent; cur; cur = cur.parent) {
            if (cur.type === "service")
                return firstBreadthDesc(cur, "service_name")?.text?.trim() ?? null;
        }
        return null;
    }
    return null;
}
function extractGenericCallQualifier(langName, nameNode, importAliases) {
    const parent = nameNode?.parent;
    if (!parent)
        return null;
    let rawQual = null;
    if (parent.type === "qualified_identifier") {
        rawQual = parent.childForFieldName?.("scope")?.text?.replace(/<[^>]*>/g, "").trim() ?? null;
    }
    else if (parent.type === "dot" && langName === "elixir") {
        rawQual = parent.childForFieldName?.("left")?.text?.trim() ?? null;
    }
    else if (parent.type === "sym_lit" && langName === "clojure") {
        rawQual = parent.childForFieldName?.("namespace")?.text?.trim() ?? null;
    }
    else if (parent.type === "member_access_expression" && langName === "c_sharp") {
        const expr = parent.childForFieldName?.("expression");
        if (expr?.type === "identifier" && expr.text !== "this" && expr.text !== "base")
            rawQual = expr.text.trim();
    }
    else if ((parent.type === "field_expression" || parent.type === "field_access") && (langName === "zig" || langName === "gleam" || langName === "scala")) {
        const recv = parent.childForFieldName?.("value") ?? parent.childForFieldName?.("record") ?? parent.namedChild?.(0);
        if (recv?.type === "identifier")
            rawQual = recv.text.trim();
    }
    else if (parent.type === "qualified" && langName === "haskell") {
        rawQual = parent.childForFieldName?.("module")?.text?.trim() ?? null;
    }
    else if (parent.type === "value_path" && (langName === "ocaml" || langName === "ocaml_interface")) {
        rawQual = firstBreadthDesc(parent, "module_path")?.text?.trim() ?? null;
    }
    else if (parent.type === "message_expression" && langName === "objc") {
        const recv = parent.childForFieldName?.("receiver");
        if (recv?.type === "identifier" && recv.text !== "self" && recv.text !== "super")
            rawQual = recv.text.trim();
    }
    else if (parent.type === "call" && langName === "ruby") {
        const recv = parent.childForFieldName?.("receiver");
        if (recv?.type === "constant" || recv?.type === "scope_resolution")
            rawQual = rubyNodeConstName(recv);
    }
    else if (parent.type === "member_expression" && langName === "solidity") {
        const obj = parent.childForFieldName?.("object");
        if (obj?.type === "identifier" && obj.text !== "this" && obj.text !== "super")
            rawQual = obj.text.trim();
    }
    if (!rawQual)
        return null;
    const aliased = importAliases?.get?.(rawQual) ?? null;
    const ownerShort = rawQual.includes("::") ? rawQual.split("::").pop() : rawQual;
    return aliased ? { qualifier: ownerShort, viaAlias: aliased } : { qualifier: ownerShort };
}
const BASH_BUILTIN_CMDS = new Set([
    ".", "source", "echo", "printf", "exit", "return", "set", "unset", "cd", "pwd",
    "export", "local", "declare", "readonly", "typeset", "test", "[", "[[", "true", "false",
    "shift", "eval", "exec", "trap", "wait", "read", "command", "builtin", "type", "hash",
]);
/** tags.scm path: @definition.<kind> → nodes, @reference.call/@reference.send →
 * bare-name call edges attributed to the innermost enclosing definition. */
function tagsExtract(query, root, rel, mkDef, defs, rawEdges, langName, isHeaderFile = false, importAliases = null) {
    const q = query;
    const matches = q.matches(root);
    const defNameAt = new Set();
    const ignoreRanges = [];
    const calls = [];
    const seenCallAt = new Set();
    const refs = [];
    const seenRefAt = new Set();
    for (const m of matches) {
        const cap = {};
        for (const c of m.captures) {
            if (c.name === "ignore" && c.node) {
                ignoreRanges.push({ start: c.node.startIndex, end: c.node.endIndex });
            }
            cap[c.name] = c.node;
        }
        const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
        if (defKey && cap.name) {
            const defKind = KIND[defKey.slice("definition.".length)] ?? "function";
            let isDecl = false;
            if ((langName === "c" || langName === "cpp" || langName === "cuda") && (defKind === "function" || defKind === "method")) {
                const role = classifyCCppFnNode(cap[defKey]);
                if (role === null)
                    continue;
                if (role === "proto") {
                    if (!isHeaderFile)
                        continue;
                    isDecl = true;
                }
            }
            else if (langName === "objc" && cap[defKey]?.type === "method_declaration") {
                isDecl = true;
            }
            defNameAt.add(cap.name.startIndex);
            const scopeNode = defScope(cap[defKey], langName);
            const owner = genericEnclosingOwner(langName, defKind, scopeNode, cap[defKey]);
            mkDef(cap.name.text, defKind, scopeNode, owner, isDecl ? { declaration: true } : null);
        }
        if (("reference.call" in cap || "reference.send" in cap) && cap.name && !seenCallAt.has(cap.name.startIndex)) {
            if (langName === "bash" && BASH_BUILTIN_CMDS.has(cap.name.text))
                continue;
            seenCallAt.add(cap.name.startIndex);
            calls.push({ name: cap.name.text, at: cap.name.startIndex, end: cap.name.endIndex, node: cap.name });
        }
        if (("reference.class" in cap || "reference.interface" in cap ||
            "reference.implementation" in cap || "reference.module" in cap) && cap.name && !seenRefAt.has(cap.name.startIndex)) {
            seenRefAt.add(cap.name.startIndex);
            refs.push({ name: cap.name.text, at: cap.name.startIndex, end: cap.name.endIndex });
        }
    }
    const isIgnoredSpan = (at, end) => ignoreRanges.some((r) => at >= r.start && end <= r.end);
    const resolveRustCall = langName === "rust" ? createRustCallResolver(root) : null;
    for (const c of calls) {
        if (defNameAt.has(c.at) || isIgnoredSpan(c.at, c.end))
            continue;
        const enc = enclosingDef(defs, c.at);
        const meta = resolveRustCall ? resolveRustCall(c.node) : extractGenericCallQualifier(langName, c.node, importAliases);
        rawEdges.push({ source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name, ...(meta ?? {}) });
    }
    for (const r of refs) {
        if (defNameAt.has(r.at) || isIgnoredSpan(r.at, r.end))
            continue;
        const enc = enclosingDef(defs, r.at);
        if (!enc)
            continue; // a reference with no enclosing definition has no sound source
        rawEdges.push({ source: enc.id, relation: "references", file: rel, name: r.name });
    }
}
const CONTAINER_DEF_KINDS = new Set(["class", "struct", "interface", "enum", "module", "object"]);
function enclosingContainerDef(defs, atIndex) {
    let best = null;
    let bestLen = Infinity;
    for (const d of defs) {
        if (CONTAINER_DEF_KINDS.has(d.kind) && d.startIndex <= atIndex && atIndex <= d.endIndex) {
            const len = d.endIndex - d.startIndex;
            if (len < bestLen) {
                bestLen = len;
                best = d;
            }
        }
    }
    return best;
}
function pushHeritageEdge(defs, rawEdges, rel, node, relation, targetName) {
    const name = targetName?.trim();
    if (!name)
        return;
    const owner = enclosingContainerDef(defs, node.startIndex);
    rawEdges.push({ source: owner ? owner.id : rel, relation, file: rel, name });
}
function extractBreadthExtras(langName, root, rel, defs, mkDef, rawEdges) {
    const visit = (n) => {
        if (langName === "hcl" && n.type === "block") {
            const bt = n.namedChild(0)?.type === "identifier" ? n.namedChild(0).text.trim() : null;
            const labels = [];
            for (let i = 1; i < n.namedChildCount; i++) {
                const ch = n.namedChild(i);
                if (ch?.type === "string_lit") {
                    const txt = firstBreadthDesc(ch, "template_literal")?.text ?? BREADTH_UNQUOTE(ch.text);
                    if (txt)
                        labels.push(txt);
                }
            }
            if (bt === "module" && labels[0])
                mkDef(labels[0], "module", n);
            else if (bt === "variable" && labels[0])
                mkDef(labels[0], "variable", n);
            else if (bt === "output" && labels[0])
                mkDef(labels[0], "constant", n);
            else if ((bt === "resource" || bt === "data") && labels.length >= 2)
                mkDef(`${labels[0]}.${labels[1]}`, "struct", n, labels[0]);
            else if (bt === "locals") {
                const body = firstBreadthDesc(n, "body");
                for (let i = 0; i < (body?.namedChildCount ?? 0); i++) {
                    const attr = body.namedChild(i);
                    if (attr?.type === "attribute") {
                        const k = attr.namedChild(0)?.text?.trim();
                        if (k)
                            mkDef(k, "variable", attr);
                    }
                }
            }
        }
        else if (langName === "solidity") {
            if (n.type === "constructor_definition") {
                const owner = enclosingContainerDef(defs, n.startIndex)?.name ?? null;
                mkDef("constructor", "method", n, owner);
            }
            else if (n.type === "inheritance_specifier") {
                const anc = firstBreadthDesc(n.childForFieldName?.("ancestor") ?? n, "identifier")?.text;
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", anc);
            }
        }
        else if (langName === "elixir") {
            if (n.type === "call") {
                const tgt = n.childForFieldName?.("target")?.text?.trim();
                const ownerDef = enclosingContainerDef(defs, n.startIndex);
                if (tgt === "defstruct" || tgt === "defexception") {
                    mkDef(tgt === "defexception" ? "exception" : "struct", "struct", n, ownerDef?.name ?? null);
                }
                else if (tgt === "defimpl") {
                    const args = firstBreadthDesc(n, "arguments");
                    const proto = args?.namedChild(0)?.type === "alias" ? args.namedChild(0).text.trim() : null;
                    if (proto && ownerDef)
                        rawEdges.push({ source: ownerDef.id, relation: "implements", file: rel, name: proto });
                }
                else if ((tgt === "behaviour" || tgt === "impl") && n.parent?.type === "unary_operator") {
                    const mod = firstBreadthDesc(n, "alias")?.text;
                    pushHeritageEdge(defs, rawEdges, rel, n, "implements", mod);
                }
            }
        }
        else if (langName === "ruby") {
            if (n.type === "superclass") {
                const sup = rubyNodeConstName(firstBreadthDesc(n, "scope_resolution") ?? firstBreadthDesc(n, "constant"));
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", sup);
            }
            else if (n.type === "call") {
                const m = n.childForFieldName?.("method")?.text;
                const args = n.childForFieldName?.("arguments");
                if (m === "include" || m === "extend" || m === "prepend") {
                    for (let i = 0; i < (args?.namedChildCount ?? 0); i++) {
                        const ch = args.namedChild(i);
                        if (ch?.type === "constant" || ch?.type === "scope_resolution")
                            pushHeritageEdge(defs, rawEdges, rel, n, "implements", rubyNodeConstName(ch));
                    }
                }
                else if (m === "attr_reader" || m === "attr_writer" || m === "attr_accessor") {
                    const owner = enclosingContainerDef(defs, n.startIndex)?.name ?? null;
                    for (const sym of collectBreadthDesc(args, "simple_symbol")) {
                        const prop = sym.text.replace(/^:/, "").trim();
                        if (prop)
                            mkDef(prop, "property", n, owner);
                    }
                }
            }
        }
        else if (langName === "c_sharp" && n.type === "base_list") {
            for (let i = 0; i < n.namedChildCount; i++) {
                const ch = n.namedChild(i);
                const id = ch?.type === "identifier"
                    ? ch.text
                    : ch?.type === "generic_name"
                        ? firstBreadthDesc(ch, "identifier")?.text
                        : ch?.type === "qualified_name" ? ch.childForFieldName?.("name")?.text : null;
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", id);
            }
        }
        else if ((langName === "cpp" || langName === "cuda") && n.type === "base_class_clause") {
            for (const tid of collectBreadthDesc(n, "type_identifier"))
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", tid.text);
        }
        else if (langName === "objc" && n.type === "class_interface") {
            const sup = n.childForFieldName?.("superclass")?.text;
            if (sup)
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", sup);
            const protos = firstBreadthDesc(n, "parameterized_arguments");
            for (const id of collectBreadthDesc(protos, "identifier"))
                pushHeritageEdge(defs, rawEdges, rel, n, "implements", id.text);
        }
        else if (langName === "scala" && n.type === "extends_clause") {
            for (let i = 0; i < n.namedChildCount; i++) {
                const ch = n.namedChild(i);
                const tid = ch?.type === "type_identifier"
                    ? ch.text
                    : ch?.type === "generic_type" ? firstBreadthDesc(ch, "type_identifier")?.text : null;
                pushHeritageEdge(defs, rawEdges, rel, n, "extends", tid);
            }
        }
        else if (langName === "dart" && (n.type === "superclass" || n.type === "interfaces" || n.type === "mixins")) {
            const relKind = n.type === "superclass" ? "extends" : "implements";
            for (const tid of collectBreadthDesc(n, "type_identifier"))
                pushHeritageEdge(defs, rawEdges, rel, n, relKind, tid.text);
        }
        else if (langName === "graphql" && n.type === "implements_interfaces") {
            for (const nt of collectBreadthDesc(n, "named_type")) {
                const name = firstBreadthDesc(nt, "name")?.text;
                pushHeritageEdge(defs, rawEdges, rel, n, "implements", name);
            }
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild(i);
            if (c)
                visit(c);
        }
    };
    if (langName === "hcl" || langName === "solidity" || langName === "elixir" || langName === "ruby" ||
        langName === "c_sharp" || langName === "cpp" || langName === "cuda" || langName === "objc" ||
        langName === "scala" || langName === "dart" || langName === "graphql") {
        visit(root);
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
