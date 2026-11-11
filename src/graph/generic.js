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
    // These ship a tags.scm (calls + symbols); ocaml/zig have none and use the
    // node-kind walker fallback (symbols only) — still one row, zero query.
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
        const mkDef = (name, kind, whole) => {
            if (spanSeen.has(whole.startIndex))
                return;
            spanSeen.add(whole.startIndex);
            const id = mintId(`${rel}#${name}`, minted);
            const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
            const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
            const rawSlice = source.slice(whole.startIndex, whole.endIndex);
            const exported = langName === "rust"
                ? rustExported(whole)
                : langName === "c" || langName === "cpp"
                    ? cCppExported(whole)
                    : true;
            nodes.push({
                id, name, kind, path: rel,
                span: `L${startRow + 1}-L${endRow + 1}`,
                signature: sigLine || null, exported, origin: "generic",
                body_hash: contentHash(rawSlice),
                body_text: searchBody(rawSlice),
                summary_state: "pending",
                summary: extractLeadingSummary(lines, startRow, rawSlice),
                crux: null,
            });
            defs.push({ id, startIndex: whole.startIndex, endIndex: whole.endIndex });
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
            extractUses(tree.rootNode, rel, rawEdges);
    }
    finally {
        tree.delete?.();
    }
    nodes[0].body_text = fileResidual(source, nodes.slice(1));
    return { nodes, rawEdges };
}
/** Rust `use crate::…` / `use self::…` / `use super::…` → a file→module `imports` raw edge.
 * External crates, `std::`, and globs are skipped; resolve.js settles in-crate and relative
 * module paths against the file's crate root / module directory. */
function extractUses(root, rel, rawEdges) {
    const visitUseNode = (n) => {
        if (n.type === "use_declaration") {
            const spec = rustUseModule(n.text);
            if (spec !== null)
                rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild?.(i);
            if (c)
                visitUseNode(c);
        }
    };
    visitUseNode(root);
}
/** The normalized path a Rust `use crate::…` / `self::…` / `super::…` names (`::`→`/`), or null
 * when it is an external crate or glob import. */
function rustUseModule(text) {
    let s = text.replace(/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+/, "").replace(/;\s*$/, "").trim();
    const brace = s.indexOf("{");
    if (brace >= 0)
        s = s.slice(0, brace).replace(/::\s*$/, "");
    else
        s = s.replace(/\s+as\s+\w+$/, "");
    s = s.trim();
    if (!/^(?:crate|self|super)(?:$|::)/.test(s))
        return null;
    if (s.includes("*"))
        return null;
    return s.replace(/\s+/g, "").replace(/::/g, "/");
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
            mkDef(cap.name.text, KIND[defKey.slice("definition.".length)] ?? "function", defScope(cap[defKey], langName));
        }
        if (("reference.call" in cap || "reference.send" in cap) && cap.name)
            calls.push({ name: cap.name.text, at: cap.name.startIndex });
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
    for (const c of calls) {
        if (defNameAt.has(c.at))
            continue;
        const enc = enclosingDef(defs, c.at);
        rawEdges.push({ source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name });
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
