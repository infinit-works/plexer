/**
 * Tier-1 extraction: source file → {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.js.
 */
import { basename } from "node:path";
import { contentHash, fileResidual, mintId, searchBody } from "../util/id.js";
import { extractLeadingSummary } from "./extract/ast.js";
import { R_ASSIGN_OPS, R_RIGHT_ASSIGN_OPS, collectBindings, goReceiverTypeOf, goReceiverVarOf, phpClosureName, resolveRecvType } from "./bindings.js";
import { collectShadowedLocals, sameSyntaxNode } from "./extract/shadow.js";
import { cCppExported, isNodeExported, rustExported } from "./extract/visibility.js";
import { genericLangOf, loadWasmLanguage, parseWasm } from "./generic.js";

export { cCppExported, extractLeadingSummary, fileResidual, isNodeExported, mintId, rustExported, searchBody };
/**
 * Extension → the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo — people went looking for why their JavaScript hadn't been indexed
 * when it had, and could not tell a language that was merely unlabelled from one
 * that really was skipped.
 *
 * One table, both readings derived from it, so adding an extension cannot fix
 * extraction and forget the label. Ordered longest-suffix-first: `.tsx` has to be
 * tested before `.ts` would match it.
 */
const EXTENSIONS = [
    { ext: ".tsx", grammar: "tsx", label: "tsx" },
    { ext: ".jsx", grammar: "tsx", label: "jsx" },
    { ext: ".mts", grammar: "typescript", label: "typescript" },
    { ext: ".cts", grammar: "typescript", label: "typescript" },
    { ext: ".ts", grammar: "typescript", label: "typescript" },
    { ext: ".mjs", grammar: "typescript", label: "javascript" },
    { ext: ".cjs", grammar: "typescript", label: "javascript" },
    { ext: ".js", grammar: "typescript", label: "javascript" },
    { ext: ".pyi", grammar: "python", label: "python" },
    { ext: ".py", grammar: "python", label: "python" },
    { ext: ".go", grammar: "go", label: "go" },
    { ext: ".java", grammar: "java", label: "java" },
    { ext: ".kt", grammar: "kotlin", label: "kotlin" },
    { ext: ".kts", grammar: "kotlin", label: "kotlin" },
    { ext: ".swift", grammar: "swift", label: "swift" },
    { ext: ".php", grammar: "php", label: "php" },
    // `entryFor` lower-cases the path before matching, so this one entry covers
    // both `.R` (the conventional case in real R codebases) and `.r`.
    { ext: ".r", grammar: "r", label: "r" },
];
function entryFor(path) {
    const p = path.toLowerCase();
    return EXTENSIONS.find((e) => p.endsWith(e.ext));
}
/** Every file extension a depth-tier (hand-written) extractor claims. */
export function depthExtensions() {
    return EXTENSIONS.map((e) => e.ext);
}
/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path) {
    return entryFor(path)?.grammar ?? null;
}
/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export function languageLabelOf(path) {
    return entryFor(path)?.label ?? (path.toLowerCase().endsWith(".vue") ? "vue" : null) ?? genericLangOf(path)?.name ?? null;
}
const TS_KINDS = {
    class_declaration: "class",
    abstract_class_declaration: "class",
    function_declaration: "function",
    generator_function_declaration: "function",
    method_definition: "method",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
};
const PY_KINDS = {
    class_definition: "class",
    function_definition: "function", // → "method" inside a class (resolved in the walk)
};
// Go: `type_spec` is intentionally absent — its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS = {
    function_declaration: "function",
    method_declaration: "method",
};
// R: `function_definition` carries no name field at all (unlike every other
// supported language) — its identifier always comes from context (an
// assignment's other side), resolved dynamically in describeR(). Empty, like
// Go's own table — never consulted, kept only to satisfy KINDS_BY_LANG's type.
const R_KINDS = {};
// Java: a record is a nominal data carrier, so it takes "struct" — the same role
// Go's struct plays — rather than "class", which would make a service and a DTO
// indistinguishable in a repo where DTOs are most of the type surface.
const JAVA_KINDS = {
    class_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "enum",
    record_declaration: "struct",
    annotation_type_declaration: "interface",
    annotation_type_element_declaration: "method",
    method_declaration: "method",
    constructor_declaration: "method",
};
/** Java type declarations: they set `enclosingClass` for the methods nested in them,
 * which "class"-only logic would miss for a record's or interface's members. */
const JAVA_TYPE_KINDS = new Set(["class", "interface", "enum", "struct"]);
const KOTLIN_KINDS = {
    class_declaration: "class", // → "interface" / "enum" / "interface" (annotation) in describeKotlin
    object_declaration: "class", // a singleton object is class-like (companion objects included)
    function_declaration: "function", // → "method" inside a type (resolved in the walk)
    secondary_constructor: "method", // the class's own secondary constructor
    type_alias: "type",
    property_declaration: "variable", // top-level `val`/`var` only (fields resolved in the walk)
};
/** Kotlin type declarations: they set `enclosingClass` for the members nested in them.
 * "class" also covers object_declaration (it maps to "class"); interface/enum are the
 * same class_declaration node rekinded in describeKotlin, so all three land in the set. */
const KOTLIN_TYPE_KINDS = new Set(["class", "interface", "enum"]);
const SWIFT_KINDS = {
    class_declaration: "class", // → "struct" / "enum" in describeSwift (one node type covers all five keywords)
    protocol_declaration: "interface",
    function_declaration: "function", // → "method" inside a type (resolved in the walk)
    protocol_function_declaration: "method", // a protocol requirement is always a member
    init_declaration: "method", // the type's own initializer (named after it, like a Java constructor)
    typealias_declaration: "type",
    property_declaration: "variable", // top-level `let`/`var` only (fields resolved in the walk)
};
/** Swift type declarations: they set `enclosingClass` for the members nested in them.
 * class/struct/enum are the same class_declaration node rekinded in describeSwift
 * (an actor takes "class"); protocols are "interface". "module" is an extension
 * body — a member-contributing scope named after the extended type, deliberately
 * NOT a type kind in the graph so it can never make the real declaration's name
 * ambiguous (see describeSwift's extension branch) — but its members still
 * promote to methods owned by that type, which is why it belongs in this set. */
const SWIFT_TYPE_KINDS = new Set([
    "class",
    "struct",
    "enum",
    "interface",
    "module",
]);
// PHP: definition node types are all distinct (no py-style function→method
// promotion needed — a class body uses `method_declaration`, not
// `function_definition`). `trait_declaration` maps to the PHP-only `trait` kind.
const PHP_KINDS = {
    function_definition: "function",
    method_declaration: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    trait_declaration: "trait",
    enum_declaration: "enum",
};
const KINDS_BY_LANG = {
    typescript: TS_KINDS,
    tsx: TS_KINDS,
    python: PY_KINDS,
    go: GO_KINDS,
    r: R_KINDS,
    java: JAVA_KINDS,
    kotlin: KOTLIN_KINDS,
    swift: SWIFT_KINDS,
    php: PHP_KINDS,
};
/**
 * The node type(s) that constitute a call site, per language.
 *
 * Java is the reason this is a set rather than a string: `method_invocation` and
 * `object_creation_expression` (`new Foo()`) are separate node types, and a Java
 * codebase's constructor calls are a large share of its real edges. PHP is
 * likewise multi-shape: a call is a function / member / nullsafe-member / scoped
 * call, never a single `call_expression`.
 */
const CALL_TYPES = {
    typescript: new Set(["call_expression"]),
    tsx: new Set(["call_expression"]),
    python: new Set(["call"]),
    go: new Set(["call_expression"]),
    java: new Set(["method_invocation", "object_creation_expression"]),
    kotlin: new Set(["call_expression"]),
    swift: new Set(["call_expression"]),
    php: new Set([
        "function_call_expression",
        "member_call_expression",
        "nullsafe_member_call_expression",
        "scoped_call_expression",
    ]),
    r: new Set(["call"]),
};
const FUNCTION_VALUE_TYPES = new Set([
    "arrow_function",
    "function",
    "function_expression",
    "generator_function",
]);
const EMPTY_SET = new Set();
const DEPTH_GRAMMARS = new Map();
/** Warm the WASM depth-tier grammars needed for the given language names. */
export async function warmDepthGrammars(langs = EXTENSIONS.map((e) => e.grammar)) {
    const need = [...new Set(langs)].filter((lang) => lang && !DEPTH_GRAMMARS.has(lang));
    if (need.length === 0)
        return;
    await Promise.all(need.map(async (lang) => {
        const language = await loadWasmLanguage(lang);
        if (language)
            DEPTH_GRAMMARS.set(lang, language);
    }));
}
export function extractFile(rel, source, lang = languageOf(rel)) {
    const grammar = DEPTH_GRAMMARS.get(lang);
    const root = grammar ? parseWasm(grammar, source) : null;
    if (!root) {
        return {
            nodes: [
                {
                    id: rel,
                    name: basename(rel),
                    kind: "file",
                    path: rel,
                    span: `L1-L${Math.max(1, source.split("\n").length)}`,
                    signature: null,
                    exported: true,
                    origin: "ast",
                    body_hash: contentHash(source),
                    chars: source.length,
                    summary_state: "pending",
                    summary: null,
                    crux: null,
                },
            ],
            rawEdges: [],
        };
    }
    const bindings = collectBindings(root, lang);
    const importedSymbols = collectImportedSymbols(root, lang);
    const rGenerics = lang === "r" ? collectRGenerics(root) : EMPTY_SET;
    const nodes = [
        {
            id: rel,
            name: basename(rel),
            kind: "file",
            path: rel,
            span: `L1-L${root.endPosition.row + 1}`,
            signature: null,
            exported: true,
            origin: "ast",
            body_hash: contentHash(source),
            chars: source.length,
            summary_state: "pending",
            summary: null,
            crux: null,
        },
    ];
    const rawEdges = [];
    const lines = source.split("\n");
    const ctx = {
        rel,
        source,
        lines,
        lang,
        kinds: KINDS_BY_LANG[lang],
        scope: [],
        enclosingKind: null,
        parentId: rel,
        bindings,
        enclosingClass: null,
        goReceiverVar: null,
        importedSymbols,
        shadowedNames: EMPTY_SET,
        nonCallableShadows: EMPTY_SET,
        rR6Access: null,
        rGenerics,
        rSuperClass: null,
    };
    const minted = new Set([rel]);
    try {
        walkNamedChildren(root.namedChildren, ctx, nodes, rawEdges, minted);
    }
    finally {
        root._tree?.delete?.();
    }
    nodes[0].body_text = fileResidual(source, nodes.slice(1));
    return { nodes, rawEdges };
}
/**
 * tree-sitter-php 0.23.x cannot parse a `const` inside an enum body. An
 * array initializer collapses the whole `enum_declaration` into ERROR; the
 * method is recovered as a sibling `function_definition`. 0.24.2 parses this
 * natively but is ABI 15 and cannot load on Plexer's tree-sitter 0.21.1.
 *
 * Bound: only an ERROR that already contains `enum_case` + `name` is treated as
 * a collapsed enum. Only `const_declaration` / `function_definition` /
 * `method_declaration` / ERROR siblings are absorbed, stopping at a `}` ERROR.
 * Unknown ERROR nodes are still walked, never mapped to a type. Clean
 * class/enum trees are `class_declaration` / `enum_declaration` and skip this.
 */
function phpCollapsedEnumName(node) {
    if (node.type !== "ERROR")
        return null;
    if (!node.namedChildren.some((c) => c.type === "enum_case"))
        return null;
    return node.namedChildren.find((c) => c.type === "name")?.text ?? null;
}
function phpCollapsedEnumHold(node) {
    return (node.type === "const_declaration" ||
        node.type === "function_definition" ||
        node.type === "method_declaration" ||
        node.type === "ERROR");
}
function phpCollapsedEnumClose(node) {
    return node.type === "ERROR" && node.text.trim() === "}";
}
function walkNamedChildren(children, ctx, out, edges, minted) {
    if (ctx.lang !== "php") {
        for (const child of children)
            walk(child, ctx, out, edges, minted);
        return;
    }
    for (let i = 0; i < children.length;) {
        const n = children[i];
        const enumName = phpCollapsedEnumName(n);
        if (enumName) {
            const group = [n];
            let j = i + 1;
            while (j < children.length && phpCollapsedEnumHold(children[j])) {
                const next = children[j];
                group.push(next);
                j++;
                if (phpCollapsedEnumClose(next))
                    break;
            }
            emitPhpCollapsedEnum(enumName, n, group, ctx, out, edges, minted);
            i = j;
            continue;
        }
        walk(n, ctx, out, edges, minted);
        i++;
    }
}
function emitPhpCollapsedEnum(name, errorNode, group, ctx, out, edges, minted) {
    const last = group[group.length - 1];
    const id = mintId(`${ctx.rel}#${[...ctx.scope, name].join(".")}`, minted);
    const body = ctx.source.slice(errorNode.startIndex, last.endIndex);
    out.push({
        id,
        name,
        kind: "enum",
        path: ctx.rel,
        span: `L${errorNode.startPosition.row + 1}-L${last.endPosition.row + 1}`,
        signature: `enum ${name}`,
        exported: true,
        origin: "ast",
        body_hash: contentHash(body),
        body_text: searchBody(body),
        summary_state: "pending",
        summary: extractLeadingSummary(ctx.lines, errorNode.startPosition.row, body),
        crux: null,
    });
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    const childCtx = {
        ...ctx,
        scope: [...ctx.scope, name],
        enclosingKind: "enum",
        parentId: id,
    };
    for (const g of group) {
        if (phpCollapsedEnumClose(g))
            continue;
        if (phpCollapsedEnumName(g)) {
            walkNamedChildren(g.namedChildren, childCtx, out, edges, minted);
            continue;
        }
        walk(g, childCtx, out, edges, minted);
    }
}
function deriveChildShadows(node, desc, ctx) {
    if (desc.kind !== "function" && desc.kind !== "method") {
        return {
            importedSymbols: ctx.importedSymbols,
            shadowedNames: ctx.shadowedNames,
            nonCallableShadows: ctx.nonCallableShadows,
        };
    }
    const { shadowed, nonCallableShadowed } = collectShadowedLocals(node, ctx.lang, isRequireDeclarator);
    const shadowedNames = shadowed.size > 0 ? new Set([...ctx.shadowedNames, ...shadowed]) : ctx.shadowedNames;
    let nonCallableShadows = ctx.nonCallableShadows;
    if (nonCallableShadowed.size > 0 || ctx.nonCallableShadows.has(desc.name)) {
        nonCallableShadows = new Set(ctx.nonCallableShadows);
        nonCallableShadows.delete(desc.name);
        for (const s of nonCallableShadowed)
            nonCallableShadows.add(s);
    }
    const importedSymbols = shadowed.size > 0 && ctx.importedSymbols.size > 0 && [...shadowed].some((s) => ctx.importedSymbols.has(s))
        ? new Map([...ctx.importedSymbols].filter(([local]) => !shadowed.has(local)))
        : ctx.importedSymbols;
    return { importedSymbols, shadowedNames, nonCallableShadows };
}

function emitExtractedDefNode(node, desc, ctx, out, edges, minted) {
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    const owner = desc.kind === "method"
        ? (isGoMethod ? (goReceiverTypeOf(node) ?? undefined) : (desc.owner ?? ctx.enclosingClass ?? undefined))
        : undefined;
    const nodeText = desc.hashNode.text;
    out.push({
        id,
        name: desc.name,
        kind: desc.kind,
        path: ctx.rel,
        span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
        exported: isNodeExported(node, desc.name, ctx),
        origin: "ast",
        body_hash: contentHash(nodeText),
        body_text: searchBody(nodeText),
        summary_state: "pending",
        summary: extractLeadingSummary(ctx.lines, desc.hashNode.startPosition.row, ctx.lang === "python" ? nodeText : ""),
        crux: null,
        ...(owner !== undefined ? { owner } : {}),
        ...(desc.arity !== undefined ? { arity: desc.arity } : {}),
        ...(desc.variadic ? { variadic: true } : {}),
    });
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    const kotlinTypeDecl = ctx.lang === "kotlin" && KOTLIN_TYPE_KINDS.has(desc.kind);
    const swiftTypeDecl = ctx.lang === "swift" && SWIFT_TYPE_KINDS.has(desc.kind);
    if (desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl)
        edges.push(...heritageEdges(node, id, ctx));
    if (ctx.lang === "php")
        edges.push(...phpAttributeReferenceEdges(node, id, ctx));
    if (ctx.lang === "java")
        edges.push(...javaAnnotationReferenceEdges(node, id, ctx));
    const enclosingClass = desc.kind === "class" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl
        ? desc.name
        : isGoMethod
            ? goReceiverTypeOf(node)
            : (desc.owner ?? ctx.enclosingClass);
    const shadowState = deriveChildShadows(node, desc, ctx);
    const childCtx = {
        ...ctx,
        scope: [...ctx.scope, idPart],
        enclosingKind: desc.kind,
        parentId: id,
        enclosingClass,
        goReceiverVar: isGoMethod ? goReceiverVarOf(node) : ctx.goReceiverVar,
        ...shadowState,
        rR6Access: null,
        rSuperClass: desc.kind === "class"
            ? ctx.lang === "r"
                ? rR6ParentClass(node)
                : ctx.lang === "swift"
                    ? swiftSuperClassName(node)
                    : null
            : ctx.rSuperClass,
    };
    walkNamedChildren(node.namedChildren, childCtx, out, edges, minted);
}
function emitExtractedCallEdge(node, ctx, edges) {
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall = consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
    if (!callee)
        return;
    if (!callee.viaMember && ctx.nonCallableShadows?.has(callee.name))
        return;
    const sameFileOnly = !callee.viaMember && Boolean(ctx.shadowedNames?.has(callee.name));
    const imported = !callee.viaMember ? ctx.importedSymbols.get(callee.name) : undefined;
    const recvType = callee.viaMember ? resolveRecvType(callee.receiver, ctx) : undefined;
    let nsImported = callee.viaMember && !recvType && callee.receiver ? ctx.importedSymbols.get(callee.receiver) : undefined;
    let subModule;
    if (!nsImported && callee.viaMember && !recvType && callee.receiver?.includes(".")) {
        const dot = callee.receiver.indexOf(".");
        const root = callee.receiver.slice(0, dot);
        if (root !== "self" && root !== "this") {
            nsImported = ctx.importedSymbols.get(root);
            if (nsImported)
                subModule = callee.receiver.slice(dot + 1);
        }
    }
    let nsSpec = nsImported?.specifier;
    let nsFallbackSpec;
    if (nsImported && ctx.lang === "python" && !nsImported.isNamespace && nsImported.specifier && nsImported.name) {
        nsSpec = /^\.+$/.test(nsImported.specifier)
            ? `${nsImported.specifier}${nsImported.name}`
            : `${nsImported.specifier}.${nsImported.name}`;
        nsFallbackSpec = nsImported.specifier;
    }
    const callEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: imported ? (imported.isDefault ? callee.name : imported.name) : callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
        ...(callee.kinds ? { kinds: callee.kinds } : {}),
        ...(imported?.specifier ? { specifier: imported.specifier } : nsSpec ? { specifier: nsSpec } : {}),
        ...(nsFallbackSpec ? { fallbackSpecifier: nsFallbackSpec } : {}),
        ...(subModule ? { subModule } : {}),
        ...(sameFileOnly ? { sameFileOnly: true } : {}),
        ...(imported?.typeOnly || nsImported?.typeOnly ? { typeOnly: true } : {}),
    };
    const argCount = ctx.lang === "java" ? javaArgCount(node) : ctx.lang === "swift" ? swiftArgCount(node) : undefined;
    if (argCount !== undefined)
        callEdge.argCount = argCount;
    const swiftImplicitSelf = ctx.lang === "swift" &&
        !callee.viaMember &&
        !callee.kinds &&
        ctx.enclosingClass &&
        !/^[A-Z]/.test(callee.name);
    if (swiftImplicitSelf) {
        edges.push({
            ...callEdge,
            viaMember: true,
            recvType: ctx.enclosingClass,
            implicitSelf: true,
        });
    }
    else {
        edges.push(recvType ? { ...callEdge, recvType } : callEdge);
    }
}
function emitJavaAnonymousClass(node, body, ctx, out, edges, minted) {
    const idPart = "{anonymous}";
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const nodeText = node.text;
    out.push({
        id,
        name: "{anonymous}",
        kind: "class",
        path: ctx.rel,
        span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(node.startIndex, body.startIndex)),
        exported: false,
        origin: "ast",
        body_hash: contentHash(nodeText),
        body_text: searchBody(nodeText),
        summary_state: "pending",
        summary: null,
        crux: null,
    });
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    const superName = javaConstructedTypeName(node.childForFieldName("type"));
    if (superName) {
        edges.push({ source: id, relation: "implements", name: superName, file: ctx.rel });
    }
    const anonCtx = {
        ...ctx,
        scope: [...ctx.scope, idPart],
        enclosingKind: "class",
        parentId: id,
        enclosingClass: "{anonymous}",
    };
    for (const child of node.namedChildren) {
        walk(child, child.type === "class_body" ? anonCtx : ctx, out, edges, minted);
    }
}
function tryWalkRR6AccessArgument(node, ctx, out, edges, minted) {
    if (ctx.lang !== "r" || ctx.enclosingKind !== "class" || ctx.rR6Access !== null || node.type !== "argument")
        return false;
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (
        argName?.type !== "identifier" ||
        (argName.text !== "public" && argName.text !== "private" && argName.text !== "active") ||
        value?.type !== "call" ||
        rCalleeName(value) !== "list"
    ) {
        return false;
    }
    const access = argName.text;
    for (const entry of rCallArgs(value))
        walk(entry, { ...ctx, rR6Access: access }, out, edges, minted);
    return true;
}

function emitImportNodeEdges(node, ctx, edges) {
    const spec = importSpecifier(node, ctx.lang);
    if (!spec)
        return;
    const isTsOrTsx = ctx.lang === "typescript" || ctx.lang === "tsx";
    const typeOnly = isTsOrTsx && isTsTypeOnlyImport(node);
    edges.push({
        source: ctx.rel,
        relation: "imports",
        specifier: spec,
        file: ctx.rel,
        ...(typeOnly ? { typeOnly: true } : {}),
    });
    if (
        ctx.lang === "python" &&
        node.type === "import_from_statement" &&
        (ctx.rel === "__init__.py" || ctx.rel.endsWith("/__init__.py"))
    ) {
        emitPythonInitReexports(node, spec, ctx, edges);
    }
}

function emitTsDynamicImportEdges(node, ctx, edges) {
    const dynSpec = tsCallImportSpecifier(node);
    if (!dynSpec)
        return;
    edges.push({ source: ctx.rel, relation: "imports", specifier: dynSpec, file: ctx.rel });
    if (ctx.enclosingKind !== "file")
        return;
    const p = node.parent;
    if (p?.type === "call_expression" && p.childForFieldName("function") === node) {
        edges.push({ source: ctx.rel, relation: "reexports", specifier: dynSpec, star: true, file: ctx.rel });
        return;
    }
    if (p?.type === "assignment_expression" && p.childForFieldName("right") === node) {
        const left = p.childForFieldName("left");
        const prop = left?.type === "member_expression" ? left.childForFieldName("property")?.text : null;
        if (!prop)
            return;
        edges.push({
            source: ctx.rel,
            relation: "reexports",
            specifier: dynSpec,
            ...(prop !== "exports" ? { exportedName: prop } : {}),
            star: true,
            file: ctx.rel,
        });
    }
}

function emitPhpTraitUseEdges(node, ctx, edges) {
    for (const t of node.namedChildren) {
        if (t.type === "name" || t.type === "qualified_name") {
            edges.push({ source: ctx.parentId, relation: "implements", name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
        }
    }
}

function emitImportedIdentifierRefEdge(node, callTypes, ctx, edges) {
    if (isDirectCallee(node, callTypes) || isDeclarationName(node))
        return;
    const imported = ctx.importedSymbols.get(node.text);
    if (!imported || imported.isNamespace)
        return;
    edges.push({
        source: ctx.parentId,
        relation: "references",
        name: imported.isDefault ? node.text : imported.name,
        specifier: imported.specifier,
        file: ctx.rel,
        ...(imported.typeOnly ? { typeOnly: true } : {}),
    });
}

function emitStatementOrExprEdges(node, ctx, edges) {
    const callTypes = CALL_TYPES[ctx.lang];
    const isTsOrTsx = ctx.lang === "typescript" || ctx.lang === "tsx";
    if (isTsOrTsx && node.type === "export_statement") {
        emitTsExportEdges(node, ctx, edges);
        return;
    }
    if (callTypes.has(node.type)) {
        if (isTsOrTsx && node.type === "call_expression")
            emitTsDynamicImportEdges(node, ctx, edges);
        emitExtractedCallEdge(node, ctx, edges);
        return;
    }
    if (node.type === "identifier")
        emitImportedIdentifierRefEdge(node, callTypes, ctx, edges);
}

function walk(node, ctx, out, edges, minted) {
    const desc = describe(node, ctx);
    if (desc) {
        emitExtractedDefNode(node, desc, ctx, out, edges, minted);
        return;
    }
    if (tryWalkRR6AccessArgument(node, ctx, out, edges, minted))
        return;
    if (isImport(node, ctx.lang)) {
        emitImportNodeEdges(node, ctx, edges);
        return;
    }
    if (ctx.lang === "php" && node.type === "use_declaration") {
        emitPhpTraitUseEdges(node, ctx, edges);
        return;
    }
    emitStatementOrExprEdges(node, ctx, edges);
    if (ctx.lang === "java" && node.type === "object_creation_expression") {
        const body = node.namedChildren.find((c) => c.type === "class_body");
        if (body) {
            emitJavaAnonymousClass(node, body, ctx, out, edges, minted);
            return;
        }
    }
    for (const child of node.namedChildren)
        walk(child, ctx, out, edges, minted);
}
/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(root, lang) {
    if (lang === "typescript" || lang === "tsx") {
        const out = new Map();
        const visitImportNode = (node) => {
            if (node.type === "import_statement") {
                const specifier = importSpecifier(node, lang);
                if (!specifier)
                    return;
                const stmtTypeOnly = isTsStatementTypeKeyword(node, "import");
                collectTsImportBindings(node, specifier, out, stmtTypeOnly);
                return;
            }
            if (node.type === "variable_declarator") {
                collectTsRequireBindings(node, out);
            }
            for (const child of node.namedChildren)
                visitImportNode(child);
        };
        visitImportNode(root);
        return out;
    }
    if (lang === "python")
        return collectPythonImportedSymbols(root);
    if (lang === "go")
        return collectGoImportedPackages(root);
    if (lang === "php")
        return collectPhpImportedSymbols(root);
    return new Map();
}
function collectGoImportedPackages(root) {
    const out = new Map();
    const visitGoNode = (node) => {
        if (node.type === "import_spec") {
            const specifier = importSpecifier(node, "go");
            if (specifier) {
                const aliasNode = node.childForFieldName("name") ??
                    node.namedChildren.find((c) => c.type === "package_identifier" || c.type === "blank_identifier" || c.type === "dot");
                const rawLocal = aliasNode ? aliasNode.text : specifier.split("/").pop()?.replace(/^v\d+$/, "") || specifier.split("/").slice(-2, -1)[0];
                if (rawLocal && rawLocal !== "_" && rawLocal !== ".") {
                    out.set(rawLocal, { specifier, isNamespace: true });
                }
            }
            return;
        }
        for (const child of node.namedChildren)
            visitGoNode(child);
    };
    visitGoNode(root);
    return out;
}
function collectPythonImportedSymbols(root) {
    const out = new Map();
    const visitPyNode = (node) => {
        if (node.type === "import_statement") {
            for (const child of node.namedChildren) {
                if (child.type === "aliased_import") {
                    const orig = child.childForFieldName("name")?.text ?? child.namedChildren[0]?.text;
                    const alias = child.childForFieldName("alias")?.text ?? child.namedChildren[1]?.text;
                    if (orig && alias)
                        out.set(alias, { specifier: orig, isNamespace: true });
                }
                else if (child.type === "dotted_name" && !child.text.includes(".")) {
                    out.set(child.text, { specifier: child.text, isNamespace: true });
                }
            }
            return;
        }
        if (node.type === "import_from_statement") {
            const specifier = importSpecifier(node, "python");
            if (specifier) {
                for (const item of pythonFromImportItems(node)) {
                    const effectiveSpec = /^\.+$/.test(specifier) ? `${specifier}${item.name}` : specifier;
                    out.set(item.local, { name: item.name, specifier: effectiveSpec });
                }
            }
            return;
        }
        for (const child of node.namedChildren)
            visitPyNode(child);
    };
    visitPyNode(root);
    return out;
}
function pythonFromImportItems(node) {
    const items = [];
    const modNode = node.childForFieldName("module_name") ??
        node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
    for (const child of node.namedChildren) {
        if (sameSyntaxNode(child, modNode) || child.type === "wildcard_import")
            continue;
        if (child.type === "aliased_import") {
            const orig = child.childForFieldName("name")?.text ?? child.namedChildren[0]?.text;
            const alias = child.childForFieldName("alias")?.text ?? child.namedChildren[1]?.text;
            if (orig)
                items.push({ name: orig, local: alias || orig });
        }
        else if (child.type === "dotted_name" || child.type === "identifier") {
            items.push({ name: child.text, local: child.text });
        }
    }
    return items;
}
function emitPythonInitReexports(node, spec, ctx, edges) {
    if (node.namedChildren.some((c) => c.type === "wildcard_import")) {
        edges.push({
            source: ctx.rel,
            relation: "reexports",
            specifier: spec,
            star: true,
            file: ctx.rel,
        });
        return;
    }
    for (const item of pythonFromImportItems(node)) {
        const effectiveSpec = /^\.+$/.test(spec) ? `${spec}${item.name}` : spec;
        edges.push({
            source: ctx.rel,
            relation: "reexports",
            specifier: effectiveSpec,
            exportedName: item.local,
            localName: item.name,
            file: ctx.rel,
        });
    }
}
/** PHP `use` bindings: local alias → { exported name, FQN specifier }. */
function collectPhpImportedSymbols(root) {
    const out = new Map();
    const visitPhpNode = (node) => {
        if (node.type === "namespace_use_declaration") {
            collectPhpUseDeclaration(node, out);
            return;
        }
        for (const child of node.namedChildren)
            visitPhpNode(child);
    };
    visitPhpNode(root);
    return out;
}
function collectPhpUseDeclaration(decl, out) {
    const prefix = decl.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\\$/, "") ?? "";
    const clauses = [];
    for (const child of decl.namedChildren) {
        if (child.type === "namespace_use_clause")
            clauses.push(child);
        if (child.type === "namespace_use_group") {
            for (const c of child.namedChildren) {
                if (c.type === "namespace_use_clause")
                    clauses.push(c);
            }
        }
    }
    for (const clause of clauses) {
        const binding = phpUseClauseBinding(clause, prefix);
        if (binding)
            out.set(binding.local, { name: binding.name, specifier: binding.specifier });
    }
}
function phpUseClauseBinding(clause, prefix) {
    const names = clause.namedChildren.filter((c) => c.type === "name");
    const qualified = clause.namedChildren.find((c) => c.type === "qualified_name");
    let fqn;
    let importedName;
    if (qualified) {
        fqn = qualified.text.replace(/^\\/, "");
        importedName = fqn.replace(/^.*\\/, "");
    }
    else if (names[0]) {
        importedName = names[0].text;
        fqn = prefix ? `${prefix}\\${importedName}` : importedName;
    }
    else {
        return null;
    }
    const alias = qualified && names.length >= 1
        ? names[names.length - 1].text
        : names.length >= 2
            ? names[1].text
            : undefined;
    const local = alias ?? importedName;
    return { local, name: importedName, specifier: fqn };
}
/** PHP 8 attributes on a definition → `references` edges to the attribute class. */
function phpAttributeReferenceEdges(node, sourceId, ctx) {
    const edges = [];
    for (const child of node.namedChildren) {
        if (child.type !== "attribute_list")
            continue;
        for (const group of child.namedChildren) {
            if (group.type !== "attribute_group")
                continue;
            for (const attr of group.namedChildren) {
                if (attr.type !== "attribute")
                    continue;
                const ref = phpAttributeClassRef(attr, ctx);
                if (ref) {
                    edges.push({
                        source: sourceId,
                        relation: "references",
                        name: ref.name,
                        ...(ref.specifier ? { specifier: ref.specifier } : {}),
                        file: ctx.rel,
                    });
                }
            }
        }
    }
    return edges;
}
function phpAttributeClassRef(attr, ctx) {
    const nameNode = attr.childForFieldName("name") ??
        attr.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    if (!nameNode)
        return null;
    if (nameNode.type === "qualified_name") {
        const fqn = nameNode.text.replace(/^\\/, "");
        return { name: fqn.replace(/^.*\\/, ""), specifier: fqn };
    }
    const bare = nameNode.text;
    const imported = ctx.importedSymbols.get(bare);
    if (imported)
        return { name: imported.name, specifier: imported.specifier };
    return { name: bare };
}
/** Java annotations on a definition → `references` edges to the annotation type. */
function javaAnnotationReferenceEdges(node, sourceId, ctx) {
    const edges = [];
    const mods = node.namedChildren.find((c) => c.type === "modifiers");
    if (!mods)
        return edges;
    for (const child of mods.namedChildren) {
        if (child.type !== "marker_annotation" && child.type !== "annotation")
            continue;
        const name = javaAnnotationTypeName(child);
        if (name) {
            edges.push({
                source: sourceId,
                relation: "references",
                name,
                file: ctx.rel,
            });
        }
    }
    return edges;
}
/** The type named by `@Foo` / `@a.b.Foo(...)`. Arguments are ignored.
 * A scoped name is kept whole, matching heritage: a bare last segment would
 * false-match an unrelated in-repo type. */
function javaAnnotationTypeName(anno) {
    const nameNode = anno.childForFieldName("name");
    if (!nameNode)
        return null;
    if (nameNode.type === "identifier" || nameNode.type === "scoped_identifier")
        return nameNode.text;
    return null;
}
function isTsStatementTypeKeyword(node, keyword) {
    const trimmed = node.text.trim();
    const re = keyword === "import" ? /^import\s+type\b/ : /^export\s+type\b/;
    if (re.test(trimmed))
        return true;
    return Boolean(node.children?.some((c) => !c.isNamed && c.type === "type"));
}
function isTsTypeSpecifier(spec) {
    if (spec.children?.some((c) => !c.isNamed && c.type === "type"))
        return true;
    return /^type\s+(?!as\b)/.test(spec.text.trim());
}
function isTsTypeOnlyImport(node) {
    if (isTsStatementTypeKeyword(node, "import"))
        return true;
    const clause = node.namedChildren.find((c) => c.type === "import_clause");
    if (!clause)
        return false;
    if (clause.namedChildren.some((c) => c.type === "identifier" || c.type === "namespace_import"))
        return false;
    const named = clause.namedChildren.find((c) => c.type === "named_imports");
    if (!named)
        return false;
    const specs = named.namedChildren.filter((c) => c.type === "import_specifier");
    return specs.length > 0 && specs.every((s) => isTsTypeSpecifier(s));
}
function collectTsImportBindings(node, specifier, out, stmtTypeOnly = false) {
    if (node.type === "import_clause") {
        const defId = node.namedChildren.find((c) => c.type === "identifier");
        if (defId) {
            out.set(defId.text, {
                name: "default",
                local: defId.text,
                specifier,
                isDefault: true,
                ...(stmtTypeOnly ? { typeOnly: true } : {}),
            });
        }
        const nsImport = node.namedChildren.find((c) => c.type === "namespace_import");
        const nsId = nsImport?.namedChildren.find((c) => c.type === "identifier");
        if (nsId) {
            out.set(nsId.text, {
                local: nsId.text,
                specifier,
                isNamespace: true,
                ...(stmtTypeOnly ? { typeOnly: true } : {}),
            });
        }
    }
    if (node.type === "import_specifier") {
        const name = node.childForFieldName("name")?.text;
        const local = node.childForFieldName("alias")?.text ?? name;
        const typeOnly = stmtTypeOnly || isTsTypeSpecifier(node);
        if (name && local) {
            out.set(local, {
                name,
                specifier,
                ...(typeOnly ? { typeOnly: true } : {}),
            });
        }
        return;
    }
    for (const child of node.namedChildren)
        collectTsImportBindings(child, specifier, out, stmtTypeOnly);
}
function tsCallImportSpecifier(node) {
    const fn = node.childForFieldName("function");
    if (!fn)
        return null;
    const isRequire = fn.type === "identifier" && fn.text === "require";
    const isDynamicImport = fn.type === "import" || fn.text === "import";
    if (!isRequire && !isDynamicImport)
        return null;
    const args = node.childForFieldName("arguments");
    const firstArg = args?.namedChildren[0];
    if (firstArg?.type !== "string")
        return null;
    const frag = firstArg.namedChildren.find((c) => c.type === "string_fragment");
    return frag?.text ?? firstArg.text.replace(/^['"]|['"]$/g, "");
}
function unwrapCallExpression(node) {
    if (!node)
        return null;
    if (node.type === "call_expression")
        return node;
    if (node.type === "await_expression") {
        const inner = node.namedChildren[0];
        if (inner?.type === "call_expression")
            return inner;
    }
    return null;
}
function isRequireDeclarator(node) {
    if (node.type !== "variable_declarator")
        return false;
    const call = unwrapCallExpression(node.childForFieldName("value"));
    return Boolean(call && tsCallImportSpecifier(call));
}
function collectTsRequireBindings(node, out) {
    const call = unwrapCallExpression(node.childForFieldName("value"));
    if (!call)
        return;
    const specifier = tsCallImportSpecifier(call);
    if (!specifier)
        return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode)
        return;
    if (nameNode.type === "identifier") {
        out.set(nameNode.text, {
            name: "default",
            local: nameNode.text,
            specifier,
            isDefault: true,
        });
        return;
    }
    if (nameNode.type === "object_pattern") {
        for (const prop of nameNode.namedChildren) {
            if (prop.type === "shorthand_property_identifier_pattern" || prop.type === "shorthand_property_identifier") {
                out.set(prop.text, { name: prop.text, specifier });
            }
            else if (prop.type === "object_assignment_pattern") {
                const left = prop.childForFieldName("left");
                if (left?.text)
                    out.set(left.text, { name: left.text, specifier });
            }
            else if (prop.type === "pair_pattern") {
                const key = prop.childForFieldName("key")?.text;
                const val = prop.childForFieldName("value");
                const local = (val?.type === "identifier" ? val.text : val?.childForFieldName("left")?.text) ?? key;
                if (key && local)
                    out.set(local, { name: key, specifier });
            }
        }
    }
}
function emitTsExportEdges(node, ctx, edges) {
    const isExportType = isTsStatementTypeKeyword(node, "export");
    const spec = importSpecifier(node, ctx.lang);
    const exportClause = node.namedChildren.find((c) => c.type === "export_clause");
    const specifiers = exportClause ? exportClause.namedChildren.filter((c) => c.type === "export_specifier") : [];
    if (spec) {
        const allSpecsTypeOnly = specifiers.length > 0 && specifiers.every((s) => isTsTypeSpecifier(s));
        const importTypeOnly = isExportType || allSpecsTypeOnly;
        edges.push({
            source: ctx.rel,
            relation: "imports",
            specifier: spec,
            file: ctx.rel,
            ...(importTypeOnly ? { typeOnly: true } : {}),
        });
        if (exportClause) {
            for (const s of specifiers) {
                const orig = s.childForFieldName("name")?.text;
                const alias = s.childForFieldName("alias")?.text;
                const specTypeOnly = isExportType || isTsTypeSpecifier(s);
                if (orig) {
                    edges.push({
                        source: ctx.rel,
                        relation: "reexports",
                        specifier: spec,
                        exportedName: alias || orig,
                        localName: orig,
                        file: ctx.rel,
                        ...(specTypeOnly ? { typeOnly: true } : {}),
                    });
                }
            }
        }
        else if (!node.namedChildren.some((c) => c.type === "namespace_export")) {
            edges.push({
                source: ctx.rel,
                relation: "reexports",
                specifier: spec,
                star: true,
                file: ctx.rel,
                ...(isExportType ? { typeOnly: true } : {}),
            });
        }
        return;
    }
    if (exportClause) {
        for (const s of specifiers) {
            const orig = s.childForFieldName("name")?.text;
            const alias = s.childForFieldName("alias")?.text;
            const imported = orig ? ctx.importedSymbols.get(orig) : undefined;
            if (imported) {
                const specTypeOnly = Boolean(imported.typeOnly || isExportType || isTsTypeSpecifier(s));
                edges.push({
                    source: ctx.rel,
                    relation: "reexports",
                    specifier: imported.specifier,
                    exportedName: alias || orig,
                    localName: imported.isDefault ? orig : imported.name,
                    file: ctx.rel,
                    ...(specTypeOnly ? { typeOnly: true } : {}),
                });
            }
        }
    }
}
/** A direct invocation already emits a stronger `calls` edge. Java names the callee
 * in a `name` field (there is no `function` field on `method_invocation`), so both
 * spellings count. */
function isDirectCallee(node, callTypes) {
    const parent = node.parent;
    if (!parent || !callTypes.has(parent.type))
        return false;
    return (sameSyntaxNode(parent.childForFieldName("function"), node) ||
        sameSyntaxNode(parent.childForFieldName("name"), node));
}
/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node) {
    const parent = node.parent;
    if (parent?.type === "export_specifier" ||
        parent?.type === "import_specifier" ||
        parent?.type === "namespace_export" ||
        parent?.type === "shorthand_property_identifier_pattern")
        return true;
    if (parent?.type === "pair_pattern" && sameSyntaxNode(parent.childForFieldName("value"), node))
        return true;
    if (parent?.type === "object_assignment_pattern" && sameSyntaxNode(parent.childForFieldName("left"), node))
        return true;
    return sameSyntaxNode(parent?.childForFieldName("name"), node);
}
function describeTypeScriptSpecial(node, ctx) {
    // TS: `const foo = (…) => …` / `const foo = function () {}`
    if (node.type === "variable_declarator") {
        const value = node.childForFieldName("value");
        if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
            const name = node.childForFieldName("name")?.text;
            if (!name)
                return null;
            const vbody = value.childForFieldName("body");
            return {
                name,
                kind: "function",
                headerEnd: vbody ? vbody.startIndex : node.endIndex,
                hashNode: node,
            };
        }
    }
    // JS/TS CommonJS / prototype method assignment: `Obj.foo = function () {}` / `exports.foo = () => …`
    if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "member_expression" && right && FUNCTION_VALUE_TYPES.has(right.type)) {
            const prop = left.childForFieldName("property")?.text;
            const objText = left.childForFieldName("object")?.text;
            if (prop && prop !== "exports" && /^[A-Za-z_$][\w$]*$/.test(prop)) {
                const owner = objText && objText !== "exports" && objText !== "module.exports" && objText !== "this"
                    ? objText.replace(/\.prototype$/, "")
                    : undefined;
                const vbody = right.childForFieldName("body");
                return {
                    name: prop,
                    ...(owner && /^[A-Za-z_$][\w$]*$/.test(owner) ? { idName: `${owner}.${prop}`, owner, kind: "method" } : { kind: "function" }),
                    headerEnd: vbody ? vbody.startIndex : node.endIndex,
                    hashNode: node,
                };
            }
        }
    }
    // JS/TS top-level CLI subcommand builder chain: `program.command("skeleton ...")....action((...) => { ... })`
    if (node.type === "call_expression" && node.parent?.type === "expression_statement" && ctx.scope.length === 0) {
        const outerFn = node.childForFieldName("function");
        const outerProp = outerFn?.type === "member_expression" ? outerFn.childForFieldName("property")?.text : null;
        if (outerProp === "action" || outerProp === "handler") {
            const actionCb = node.childForFieldName("arguments")?.namedChildren.find((c) => FUNCTION_VALUE_TYPES.has(c.type));
            let cur = outerFn.childForFieldName("object");
            let cmdName = null;
            while (cur?.type === "call_expression") {
                const m = cur.childForFieldName("function");
                if (m?.type === "member_expression" && m.childForFieldName("property")?.text === "command") {
                    const firstArg = cur.childForFieldName("arguments")?.namedChildren[0];
                    if (firstArg?.type === "string") {
                        const rawCmd = firstArg.text.replace(/^['"`]|['"`]$/g, "").trim();
                        const mCmd = /^([A-Za-z][\w-]*)/.exec(rawCmd);
                        if (mCmd)
                            cmdName = mCmd[1];
                    }
                    break;
                }
                cur = m?.type === "member_expression" ? m.childForFieldName("object") : null;
            }
            if (cmdName && actionCb) {
                const vbody = actionCb.childForFieldName("body");
                return {
                    name: cmdName,
                    idName: `Command.${cmdName}`,
                    owner: "Command",
                    kind: "method",
                    headerEnd: vbody ? vbody.startIndex : node.endIndex,
                    hashNode: node,
                };
            }
        }
    }
    return null;
}
/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node, ctx) {
    if (ctx.lang === "go")
        return describeGo(node, ctx);
    if (ctx.lang === "r")
        return describeR(node, ctx);
    if (ctx.lang === "java")
        return describeJava(node, ctx);
    if (ctx.lang === "kotlin")
        return describeKotlin(node, ctx);
    if (ctx.lang === "swift")
        return describeSwift(node, ctx);
    if (ctx.lang === "php" && (node.type === "anonymous_function" || node.type === "arrow_function")) {
        const body = node.childForFieldName("body");
        return {
            name: phpClosureName(node),
            kind: "function",
            headerEnd: body ? body.startIndex : node.endIndex,
            hashNode: node,
        };
    }
    if (ctx.lang === "php" && node.type === "anonymous_class") {
        const body = node.childForFieldName("body");
        return {
            name: "{anonymous}",
            kind: "class",
            headerEnd: body ? body.startIndex : node.endIndex,
            hashNode: node,
        };
    }
    const mapped = ctx.kinds[node.type];
    if (mapped) {
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        let kind = mapped;
        if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
            kind = "method";
        }
        if (ctx.lang === "php" && mapped === "function" && ctx.enclosingKind === "enum") {
            kind = "method";
        }
        const body = node.childForFieldName("body");
        return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
    }
    if (ctx.lang === "typescript" || ctx.lang === "tsx") {
        return describeTypeScriptSpecial(node, ctx);
    }
    return null;
}
/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node, _ctx) {
    if (node.type === "function_declaration") {
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        const body = node.childForFieldName("body");
        return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
    }
    if (node.type === "method_declaration") {
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        const recv = goReceiverTypeOf(node);
        const body = node.childForFieldName("body");
        // Bare `name` (so `recv.Method()` calls resolve); receiver-qualified `idName`
        // (so the id is `file.go#Receiver.Method` and stays unique per receiver).
        return {
            name,
            idName: recv ? `${recv}.${name}` : name,
            kind: "method",
            headerEnd: body ? body.startIndex : node.endIndex,
            hashNode: node,
        };
    }
    // `type Name <shape>` — one type_spec per name (grouped `type ( … )` yields several).
    if (node.type === "type_spec") {
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        const type = node.childForFieldName("type");
        const kind = type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
        // Header ends where the body opens (`{`) for struct/interface, else the whole node
        // (a one-line alias like `type ID int`).
        const headerEnd = type && (kind === "struct" || kind === "interface") ? type.startIndex : node.endIndex;
        return { name, kind, headerEnd, hashNode: node };
    }
    return null;
}
/**
 * R definition shapes. `function_definition` carries no name field at all, so
 * unlike every other supported language the name always comes from an
 * enclosing assignment, detected here.
 *
 * Phase 1 (flat extraction — every named function is a plain `function` node)
 * plus Phase 2 (S3/S4/R6 class awareness, R's class systems being library
 * *convention* rather than grammar syntax, unlike every other language plexer
 * supports):
 *   - left-assign (`<-`/`<<-`/`=`) / right-assign (`->`/`->>`) function
 *     assignment — Phase 1's shape, see the two `binary_operator`/
 *     `function_definition` branches below. Right-assign's AST shape does NOT
 *     mirror left-assign's the way it looks like it should (confirmed
 *     empirically, not assumed — R's `->` has low enough precedence that it's
 *     absorbed into the function's own `body` field as a `binary_operator`
 *     instead of the function sitting inside an outer wrapper); only an
 *     explicitly parenthesized `(function() {}) -> foo` produces the
 *     "expected" outer-wrapping shape, which isn't specially handled (falls
 *     through as an anonymous function).
 *   - `name.Class <- function() {}` — an S3 method, IF `name` is a known
 *     generic (registered locally via `UseMethod()` in this file, or one of a
 *     curated set of common base-R generics — see `rS3Split`'s doc comment
 *     for the false-positive risk this guards against).
 *   - `Foo <- R6::R6Class("Foo", public = list(...), private = list(...))` —
 *     an R6 class; its `public =`/`private =`/`active =` list entries become
 *     methods, handled by walk()'s own `argument`-node interception (this
 *     function only recognizes the class itself; the "a call defines a
 *     symbol" list-walking lives in walk() since it needs to mint several
 *     nodes, not describe a single one).
 *   - `Foo <- list(public = list(...), private = list(...))` (Phase 5) — a
 *     plain-list "mixin"/"extension" bundle, NOT wrapped in `R6::R6Class(...)`
 *     at all: a real, deliberate convention found dogfooding against a real
 *     R6-heavy corpus (25 files, 11 of them entirely invisible to the graph
 *     without this) for sharing method bundles across classes via splicing
 *     (`public = c(Foo$public, list(...))`) rather than `inherit =`. Only
 *     recognized when the list actually has a `public =`/`private =` entry
 *     (see `rIsMixinContainer`) — an ordinary data/config list never matches.
 *     Reuses kind "class" (nothing better-fitting exists, and everything
 *     downstream — the method-list walking, visibility — only cares that
 *     ctx.enclosingKind is "class", not how the container was spelled); no
 *     heritage edge, since splicing isn't `inherit =`-based inheritance.
 *   - `setClass("Foo", ...)` / `setMethod("generic", "Foo", function() {})`
 *     — S4 class/method calls, recognized as bare top-level `call` nodes
 *     (setClass/setMethod have side effects registering with the S4 system;
 *     they're essentially never assigned to a variable). `setGeneric()` is
 *     NOT specially extracted — it doesn't naturally map to a class or method
 *     kind, and the plan flags it as a case not worth the design risk.
 */
function describeR(node, ctx) {
    if (node.type === "binary_operator") {
        const op = node.childForFieldName("operator")?.text;
        if (!op || !R_ASSIGN_OPS.has(op))
            return null;
        const lhs = node.childForFieldName("lhs");
        const rhs = node.childForFieldName("rhs");
        if (lhs?.type !== "identifier")
            return null;
        if (rhs?.type === "function_definition") {
            return rFunctionDescriptor(lhs.text, rhs, rhs.childForFieldName("body"), ctx);
        }
        if (rhs?.type === "call" && rCalleeName(rhs) === "R6Class") {
            // The class node itself; its public=/private=/active= method lists are
            // handled by walk()'s own `argument`-node interception, not here.
            return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
        }
        if (rhs?.type === "call" && rCalleeName(rhs) === "list" && rIsMixinContainer(rhs)) {
            // Phase 5: a plain-list mixin/extension bundle — same treatment as R6Class.
            return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
        }
        return null;
    }
    if (node.type === "function_definition") {
        // Right-assign (`function() {} -> foo`): see this function's own doc
        // comment for why this doesn't mirror the binary_operator branch above.
        const body = node.childForFieldName("body");
        if (body?.type !== "binary_operator")
            return null;
        const op = body.childForFieldName("operator")?.text;
        if (!op || !R_RIGHT_ASSIGN_OPS.has(op))
            return null;
        const rhs = body.childForFieldName("rhs");
        if (rhs?.type !== "identifier")
            return null;
        return rFunctionDescriptor(rhs.text, node, body.childForFieldName("lhs"), ctx);
    }
    if (node.type === "call") {
        return describeRTopLevelCall(node);
    }
    // R6 (Phase 2): reached via walk()'s own `argument`-node interception for a
    // `public =`/`private =`/`active =` list entry — see the special case there
    // for why this can't just be a flat kind-table/node-type check like every
    // other definition shape.
    if (node.type === "argument" && ctx.rR6Access !== null) {
        const argName = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (argName?.type !== "identifier" || value?.type !== "function_definition")
            return null;
        const body = value.childForFieldName("body");
        return {
            name: argName.text,
            kind: "method",
            headerEnd: body ? body.startIndex : value.endIndex,
            hashNode: value,
            // owner deliberately unset — R6 methods DO lexically nest inside the
            // class-defining call, so ctx.enclosingClass already has it.
        };
    }
    return null;
}
/** A plain function assignment (left- or right-assign), OR — if `name` matches
 * a known S3 generic's `generic.Class` pattern — an S3 method instead. `body`
 * is the function's REAL content node (already resolved by the caller for
 * either assignment direction), used only for `headerEnd`; `hashNode` is
 * always the `function_definition` itself. */
function rFunctionDescriptor(name, hashNode, body, ctx) {
    const headerEnd = body ? body.startIndex : hashNode.endIndex;
    const s3 = rS3Split(name, ctx.rGenerics);
    if (s3) {
        return {
            name: s3.generic,
            idName: `${s3.className}.${s3.generic}`,
            kind: "method",
            headerEnd,
            hashNode,
            owner: s3.className,
        };
    }
    return { name, kind: "function", headerEnd, hashNode };
}
/**
 * S3 dispatch detection: does `name` split as `generic.Class` for some KNOWN
 * generic? Tries the longest possible generic prefix first (so a dotted
 * generic itself, like `as.character`, is found before a shorter false match)
 * and only ever matches a generic that's either registered locally via
 * `UseMethod()` in this file (see `collectRGenerics`) or in the small curated
 * `R_BASE_GENERICS` set below.
 *
 * This is the genuinely ambiguous part of R support the plan calls out:
 * `read.csv`, `data.frame`, and `as.character` used as an ordinary helper
 * name are NOT S3 dispatch, and nothing in the grammar distinguishes them
 * from `print.MyClass`. Erring toward the curated set staying small — a
 * missed S3 method (false negative, falls back to an ordinary `function`
 * node) is a much smaller problem than a false positive misfiling an
 * unrelated dotted-name function as some other class's method.
 */
function rS3Split(name, generics) {
    const parts = name.split(".");
    if (parts.length < 2)
        return null;
    for (let i = parts.length - 1; i >= 1; i--) {
        const generic = parts.slice(0, i).join(".");
        if (generics.has(generic) || R_BASE_GENERICS.has(generic)) {
            return { generic, className: parts.slice(i).join(".") };
        }
    }
    return null;
}
/** Common base-R S3 generics worth assuming even without local evidence —
 * print.Foo/format.Foo etc. are the single most common real-world S3
 * pattern, and a local `UseMethod()` call will never exist for them (they
 * ship in base/methods/stats, not the user's own repo). Deliberately small
 * and unsurprising rather than exhaustive — see `rS3Split`'s doc comment. */
const R_BASE_GENERICS = new Set([
    "print",
    "format",
    "summary",
    "plot",
    "str",
    "toString",
    "as.character",
    "as.list",
    "as.data.frame",
    "as.vector",
    "as.numeric",
    "as.matrix",
    "length",
    "dim",
    "names",
    "rev",
    "sort",
    "unique",
    "predict",
    "coef",
    "residuals",
    "fitted",
    "update",
    "merge",
    "all.equal",
    "anova",
    "confint",
    "vcov",
    "logLik",
]);
/** Every S3 generic THIS file registers via a local `UseMethod()` call, so
 * `rS3Split` can recognize `generic.Class` methods for a repo's own generics,
 * not just the base-R ones. Runs once per file, ahead of the main walk (same
 * pre-pass shape as `collectImportedSymbols`). Cross-file generics — a
 * generic defined in one file, dispatched on in another — aren't found this
 * way; that would need a whole-repo pass extractFile has no visibility into,
 * the same limitation Go/C++'s per-file bindings already accept. */
function collectRGenerics(root) {
    const generics = new Set();
    const visitRNode = (node) => {
        let fnDef = null;
        let ownName = null;
        if (node.type === "binary_operator") {
            const op = node.childForFieldName("operator")?.text;
            const lhs = node.childForFieldName("lhs");
            const rhs = node.childForFieldName("rhs");
            if (op && R_ASSIGN_OPS.has(op) && lhs?.type === "identifier" && rhs?.type === "function_definition") {
                fnDef = rhs;
                ownName = lhs.text;
            }
        }
        else if (node.type === "function_definition") {
            const body = node.childForFieldName("body");
            if (body?.type === "binary_operator") {
                const op = body.childForFieldName("operator")?.text;
                const rhs = body.childForFieldName("rhs");
                if (op && R_RIGHT_ASSIGN_OPS.has(op) && rhs?.type === "identifier") {
                    fnDef = node;
                    ownName = rhs.text;
                }
            }
        }
        if (fnDef && ownName) {
            const arg = findUseMethodArg(fnDef.childForFieldName("body"));
            if (arg !== undefined)
                generics.add(arg || ownName); // "" means UseMethod() with no args
        }
        for (const child of node.namedChildren)
            visitRNode(child);
    };
    visitRNode(root);
    return generics;
}
/** Searches a function body for a `UseMethod(...)` call and returns its
 * string-literal generic-name argument, `""` if called with no arguments
 * (defaults to the enclosing function's own name), or `undefined` if no
 * `UseMethod` call is found at all. */
function findUseMethodArg(node) {
    if (!node)
        return undefined;
    if (node.type === "call" && rCalleeName(node) === "UseMethod") {
        const first = rCallArgs(node)[0]?.childForFieldName("value");
        return first?.type === "string" ? (rStringContent(first) ?? "") : "";
    }
    for (const child of node.namedChildren) {
        const found = findUseMethodArg(child);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
/** S4: `setClass("Foo", ...)` → a class; `setMethod("generic", "Foo",
 * function() {})` → a method owned by "Foo". Both are ordinary top-level
 * `call` nodes — S4's registration functions have side effects and are
 * essentially never assigned to a variable, unlike R6Class. */
function describeRTopLevelCall(node) {
    const callee = rCalleeName(node);
    if (callee === "setClass") {
        const first = rCallArgs(node)[0]?.childForFieldName("value");
        const name = first?.type === "string" ? rStringContent(first) : null;
        if (!name)
            return null;
        return { name, kind: "class", headerEnd: node.endIndex, hashNode: node };
    }
    if (callee === "setMethod") {
        const args = rCallArgs(node);
        const generic = args[0] ? rStringContent(args[0].childForFieldName("value") ?? null) : null;
        const className = args[1] ? rStringContent(args[1].childForFieldName("value") ?? null) : null;
        const defArg = args.find((a) => a.childForFieldName("name")?.text === "definition") ?? args[2];
        const fnDef = defArg?.childForFieldName("value");
        if (!generic || !className || fnDef?.type !== "function_definition")
            return null;
        const body = fnDef.childForFieldName("body");
        return {
            name: generic,
            idName: `${className}.${generic}`,
            kind: "method",
            headerEnd: body ? body.startIndex : fnDef.endIndex,
            hashNode: fnDef,
            owner: className,
        };
    }
    return null;
}
/** A call's callee name, whether bare (`R6Class(...)`) or namespace-qualified
 * (`R6::R6Class(...)`). Null if the callee isn't a simple name (e.g. itself a
 * call, or a `$`-based access). */
function rCalleeName(node) {
    const fn = node.childForFieldName("function");
    if (fn?.type === "identifier")
        return fn.text;
    if (fn?.type === "namespace_operator") {
        const rhs = fn.childForFieldName("rhs");
        return rhs?.type === "identifier" ? rhs.text : null;
    }
    return null;
}
/** A call's positional/named `argument` children (skipping the `,`/`(`/`)`
 * punctuation tokens that share the `arguments` node's child list). */
function rCallArgs(node) {
    return node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
}
/** An R `string` node's unquoted text, or null if `node` isn't a string. */
function rStringContent(node) {
    if (node?.type !== "string")
        return null;
    const content = node.namedChildren.find((c) => c.type === "string_content");
    return content?.text ?? null;
}
/** The value of a call's named argument (`setClass("Foo", contains = "Base")`
 * → the `contains` argument), or null if absent. */
function rNamedArg(node, argName) {
    const arg = rCallArgs(node).find((a) => a.childForFieldName("name")?.text === argName);
    return arg?.childForFieldName("value") ?? null;
}
/** An R6 class-defining node's `inherit =` parent class name (a bare
 * identifier — the parent's own generator variable, not a string), for
 * `super$` call resolution (Phase 3). `node` is whatever describeR matched: a
 * binary_operator for R6 (`Foo <- R6::R6Class(...)`) or, for any other kind of
 * class (S4's setClass, which has no `super`), the call itself — always null
 * there since `rCalleeName(call) !== "R6Class"`. */
function rR6ParentClass(node) {
    const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
    if (call?.type !== "call" || rCalleeName(call) !== "R6Class")
        return null;
    const value = rNamedArg(call, "inherit");
    return value?.type === "identifier" ? value.text : null;
}
/** Does this `list(...)` call look like a Phase-5 mixin/extension bundle —
 * i.e. does it have a `public =` or `private =` entry whose own value is
 * itself a `list(...)` call? This is the one check standing between "class-
 * like container" and an ordinary data/config list (`list(a = 1, b = 2)`,
 * or even one that happens to have a field named "public" holding something
 * else) — real code never coincidentally shapes plain data this way, so it's
 * a safe, precise signal without needing a naming-convention heuristic. */
function rIsMixinContainer(node) {
    return rCallArgs(node).some((a) => {
        const name = a.childForFieldName("name")?.text;
        if (name !== "public" && name !== "private")
            return false;
        const value = a.childForFieldName("value");
        return value?.type === "call" && rCalleeName(value) === "list";
    });
}
/** A base-class name list from either a bare string (`contains = "Base"`) or
 * a `c(...)` call of strings (`contains = c("Base1", "Base2")`) — S4's
 * multiple-inheritance form. */
function rStringOrCVector(value) {
    if (!value)
        return [];
    const single = rStringContent(value);
    if (single)
        return [single];
    if (value.type === "call" && rCalleeName(value) === "c") {
        return rCallArgs(value)
            .map((a) => rStringContent(a.childForFieldName("value")))
            .filter((s) => !!s);
    }
    return [];
}
/** Java definition shapes. Uniform in a way Go's are not: every declaration carries
 * a `name` field and (for types and most members) a `body`, so one mapped lookup
 * covers classes, interfaces, enums, records, methods, and constructors. Methods are
 * lexically nested in their type, so — unlike Go — they need no receiver qualification. */
function describeJava(node, ctx) {
    const mapped = ctx.kinds[node.type];
    if (!mapped)
        return null;
    const name = node.childForFieldName("name")?.text;
    if (!name)
        return null;
    const body = node.childForFieldName("body");
    const desc = {
        name,
        kind: mapped,
        headerEnd: body ? body.startIndex : node.endIndex,
        hashNode: node,
    };
    // Only callables carry arity. A record declaration also has a `parameters` node,
    // but its components are not an overload set and must never be filtered against.
    if (node.type === "method_declaration" || node.type === "constructor_declaration") {
        const params = node.childForFieldName("parameters");
        if (params) {
            const declared = params.namedChildren.filter((c) => c.type === "formal_parameter" || c.type === "spread_parameter");
            desc.arity = declared.length;
            if (declared.some((c) => c.type === "spread_parameter"))
                desc.variadic = true;
        }
    }
    return desc;
}
function childTypeName(node) {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
}
function childFuncName(node) {
    return node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
}
function childHeadEnd(node, ...types) {
    const body = node.namedChildren.find((c) => types.includes(c.type));
    return body ? body.startIndex : node.endIndex;
}
/** Kotlin definition shapes. Unlike Java's, tree-sitter-kotlin exposes no `name`
 * or `body` fields: a definition's name is an unnamed `simple_identifier` (functions)
 * or `type_identifier` (types) child, and its body is a `class_body` / `function_body`
 * / `statements` child. `class_declaration` also folds classes, interfaces, and enum
 * classes into one node type — the kind is read off the declaration's own keywords. */
function describeKotlin(node, ctx) {
    if (node.type === "class_declaration") {
        const name = childTypeName(node);
        if (!name)
            return null;
        let kind = "class";
        if (node.namedChildren.some((c) => c.type === "enum_class_body"))
            kind = "enum";
        else if (node.children.some((c) => c.type === "interface"))
            kind = "interface";
        else {
            const mods = node.namedChildren.find((c) => c.type === "modifiers");
            // `annotation class` → the interface role Java's annotation_type_declaration plays.
            if (mods?.namedChildren.some((c) => c.type === "class_modifier" && c.text === "annotation"))
                kind = "interface";
        }
        return { name, kind, headerEnd: childHeadEnd(node, "class_body", "enum_class_body"), hashNode: node };
    }
    if (node.type === "object_declaration") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return { name, kind: "class", headerEnd: childHeadEnd(node, "class_body"), hashNode: node };
    }
    if (node.type === "function_declaration") {
        const name = childFuncName(node);
        if (!name)
            return null;
        const kind = KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function";
        return { name, kind, headerEnd: childHeadEnd(node, "function_body"), hashNode: node };
    }
    if (node.type === "secondary_constructor") {
        // Constructors carry no name of their own — they are the class's own, so scope the
        // node under the enclosing class the same way Java's constructor_declaration does.
        if (!ctx.enclosingClass)
            return null;
        return {
            name: ctx.enclosingClass,
            kind: "method",
            headerEnd: childHeadEnd(node, "statements"),
            hashNode: node,
        };
    }
    if (node.type === "type_alias") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
    }
    if (node.type === "property_declaration") {
        // Top-level `val`/`var` only — a class property is a field, not a definition node
        // (no depth tier emits fields), so it must not become one.
        if (ctx.enclosingKind !== null)
            return null;
        const decl = node.namedChildren.find((c) => c.type === "variable_declaration");
        const name = decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        if (!name)
            return null;
        return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
    }
    return null;
}
/** Swift definition shapes. Like Kotlin's, tree-sitter-swift exposes no `name` or
 * `body` fields: a definition's name is a direct `type_identifier` (types) or
 * `simple_identifier` (functions) child, and its body is a `class_body` /
 * `enum_class_body` / `protocol_body` / `function_body` child. One
 * `class_declaration` node type covers `class`, `struct`, `enum`, `actor` AND
 * `extension` — the declaration's own keyword token tells them apart. */
function describeSwift(node, ctx) {
    if (node.type === "class_declaration") {
        const kw = node.children.find((c) => c.type === "class" ||
            c.type === "struct" ||
            c.type === "enum" ||
            c.type === "actor" ||
            c.type === "extension")?.type;
        let name;
        if (kw === "extension") {
            const ut = node.namedChildren.find((c) => c.type === "user_type");
            const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
            name = ids.length ? ids[ids.length - 1].text : null;
        }
        else {
            name = childTypeName(node);
        }
        if (!name)
            return null;
        // An actor is class-like (reference semantics, methods) and there is no
        // dedicated actor kind, so it takes "class".
        const kind = kw === "extension" ? "module" : kw === "struct" ? "struct" : kw === "enum" ? "enum" : "class";
        return { name, kind, headerEnd: childHeadEnd(node, "class_body", "enum_class_body"), hashNode: node };
    }
    if (node.type === "protocol_declaration") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return { name, kind: "interface", headerEnd: childHeadEnd(node, "protocol_body"), hashNode: node };
    }
    // A protocol requirement (`protocol_function_declaration`) has no body and is
    // always a member; an ordinary `function_declaration` is a method exactly when
    // it is nested in a type (or an extension of one).
    if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
        const name = childFuncName(node);
        if (!name)
            return null;
        const kind = node.type === "protocol_function_declaration" ||
            SWIFT_TYPE_KINDS.has(ctx.enclosingKind ?? "file")
            ? "method"
            : "function";
        return {
            name,
            kind,
            headerEnd: childHeadEnd(node, "function_body"),
            hashNode: node,
            ...swiftArity(node),
        };
    }
    if (node.type === "init_declaration") {
        if (!ctx.enclosingClass)
            return null;
        return {
            name: ctx.enclosingClass,
            kind: "method",
            headerEnd: childHeadEnd(node, "function_body"),
            hashNode: node,
            ...swiftArity(node),
        };
    }
    if (node.type === "typealias_declaration") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
    }
    if (node.type === "property_declaration") {
        if (ctx.enclosingKind !== null)
            return null;
        const name = node.namedChildren
            .find((c) => c.type === "pattern")
            ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        if (!name)
            return null;
        return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
    }
    return null;
}
/** Declared parameter count for a Swift callable, for overload disambiguation
 * (the same role Java's `arity`/`argCount` pair plays). `parameter` nodes are
 * direct children of the declaration; a default value's `=` sits as a SIBLING
 * token after its parameter, and a variadic `...` sits inside its parameter.
 * `arity` is the REQUIRED minimum (parameters minus defaults) and `variadic`
 * marks any default or variadic parameter, so `narrowByArity`'s at-least
 * semantics keeps every overload a call of that shape could reach. */
function swiftArity(node) {
    const params = node.children.filter((c) => c.type === "parameter");
    const defaults = node.children.filter((c) => c.type === "=").length;
    const hasVariadic = params.some((p) => p.children.some((c) => c.type === "..."));
    const arity = Math.max(0, params.length - defaults);
    return hasVariadic || defaults > 0 ? { arity, variadic: true } : { arity };
}
/** Argument count at a Swift call site: the `value_argument`s plus one for a
 * trailing closure (`run(x) { … }` calls a two-parameter function). */
function swiftArgCount(node) {
    const suffix = node.namedChildren.find((c) => c.type === "call_suffix");
    if (!suffix)
        return undefined;
    const args = suffix.namedChildren
        .find((c) => c.type === "value_arguments")
        ?.namedChildren.filter((c) => c.type === "value_argument").length ?? 0;
    const trailing = suffix.namedChildren.some((c) => c.type === "lambda_literal") ? 1 : 0;
    return args + trailing;
}
/** The superclass a Swift class declaration names: its FIRST inheritance
 * specifier — Swift's grammar requires the superclass to precede any protocol
 * in the `:` list, so when a superclass exists it is always this entry. */
function swiftSuperClassName(node) {
    const spec = node.namedChildren.find((c) => c.type === "inheritance_specifier");
    const ids = spec?.namedChildren
        .find((c) => c.type === "user_type")
        ?.namedChildren.filter((c) => c.type === "type_identifier");
    return ids?.length ? ids[ids.length - 1].text : null;
}
function jvmSwiftHeritageEdges(node, classId, ctx) {
    const edges = [];
    if (ctx.lang === "java") {
        const typeParams = javaTypeParameterNames(node);
        for (const child of node.namedChildren) {
            const relation = child.type === "superclass"
                ? "extends"
                : child.type === "super_interfaces" || child.type === "extends_interfaces"
                    ? "implements"
                    : null;
            if (!relation)
                continue;
            for (const entry of javaSupertypeEntries(child)) {
                const name = javaSupertypeName(entry);
                if (!name || typeParams.has(name))
                    continue;
                edges.push({ source: classId, relation, name, file: ctx.rel });
            }
        }
        return edges;
    }
    if (ctx.lang === "kotlin") {
        for (const child of node.namedChildren) {
            if (child.type !== "delegation_specifier")
                continue;
            const t = child.namedChildren.find((c) => c.type === "user_type")?.namedChildren.find((c) => c.type === "type_identifier");
            if (t)
                edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
        }
        return edges;
    }
    for (const child of node.namedChildren) {
        if (child.type !== "inheritance_specifier")
            continue;
        const ids = child.namedChildren
            .find((c) => c.type === "user_type")
            ?.namedChildren.filter((c) => c.type === "type_identifier");
        const t = ids?.length ? ids[ids.length - 1] : undefined;
        if (t)
            edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
}
function heritageEdges(node, classId, ctx) {
    if (ctx.lang === "java" || ctx.lang === "kotlin" || ctx.lang === "swift") {
        return jvmSwiftHeritageEdges(node, classId, ctx);
    }
    const edges = [];
    if (ctx.lang === "python") {
        const supers = node.childForFieldName("superclasses");
        for (const c of supers?.namedChildren ?? []) {
            if (c.type === "identifier") {
                edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
            }
        }
        return edges;
    }
    if (ctx.lang === "r") {
        const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
        if (call?.type !== "call")
            return edges;
        const callee = rCalleeName(call);
        if (callee === "R6Class") {
            const value = rNamedArg(call, "inherit");
            if (value?.type === "identifier") {
                edges.push({ source: classId, relation: "extends", name: value.text, file: ctx.rel });
            }
        }
        else if (callee === "setClass") {
            for (const name of rStringOrCVector(rNamedArg(call, "contains"))) {
                edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
            }
        }
        return edges;
    }
    if (ctx.lang === "php") {
        for (const clause of node.namedChildren) {
            const relation = clause.type === "base_clause" ? "extends" : clause.type === "class_interface_clause" ? "implements" : null;
            if (!relation)
                continue;
            for (const t of clause.namedChildren) {
                if (t.type === "name" || t.type === "qualified_name") {
                    edges.push({ source: classId, relation, name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
                }
            }
        }
        return edges;
    }
    const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
    for (const clause of heritage?.namedChildren ?? []) {
        const relation = clause.type === "implements_clause"
            ? "implements"
            : clause.type === "extends_clause"
                ? "extends"
                : null;
        if (!relation)
            continue;
        for (const t of clause.namedChildren) {
            if (t.type === "identifier" || t.type === "type_identifier") {
                edges.push({ source: classId, relation, name: t.text, file: ctx.rel });
            }
        }
    }
    return edges;
}
/**
 * The supertypes a heritage clause names, one node each — NOT every `type_identifier`
 * beneath it.
 *
 * `superclass` wraps a single type; `super_interfaces`/`extends_interfaces` wrap a
 * `type_list` of them. Descending blindly instead walked into `type_arguments`, so
 * `implements Comparable<Item>` reported `Item` as a supertype too.
 */
function javaSupertypeEntries(clause) {
    const list = clause.namedChildren.find((c) => c.type === "type_list");
    return list ? [...list.namedChildren] : [...clause.namedChildren];
}
/**
 * What a supertype entry is CALLED, or null when this pass cannot say.
 *
 * Type arguments are erased, because they are not part of the supertype's identity:
 *
 *     Base           |  Base<Item>          -> Base
 *
 * A qualified name is kept WHOLE rather than reduced to its final segment:
 *
 *     Outer.Inner    |  Outer.Inner<K>      -> Outer.Inner
 *
 * Heritage keeps an unresolved base as the edge target by design ("usually an
 * external/imported type — keep the name"), so the full string is both truthful and
 * unable to false-match a node id, where a bare `Inner` could collide with an
 * unrelated in-repo type. That differs from construction, which drops a
 * qualified name instead — construction has no keep-the-name contract to fall back on.
 */
function javaSupertypeName(node) {
    if (!node)
        return null;
    if (node.type === "generic_type")
        return javaSupertypeName(node.namedChildren[0]);
    if (node.type === "scoped_type_identifier")
        return node.text;
    return node.type === "type_identifier" ? node.text : null;
}
/** The names a declaration binds as its own type parameters (`class C<T, U>` → T, U),
 * so they can never be mistaken for supertypes. */
function javaTypeParameterNames(decl) {
    const params = decl.childForFieldName("type_parameters");
    if (!params)
        return new Set();
    const out = new Set();
    const visitTypeParam = (n) => {
        if (n.type === "type_identifier")
            out.add(n.text);
        for (const c of n.namedChildren)
            visitTypeParam(c);
    };
    visitTypeParam(params);
    return out;
}
function jvmSwiftCalleeName(node, lang) {
    if (lang === "java") {
        if (node.type === "object_creation_expression") {
            const name = javaConstructedTypeName(node.childForFieldName("type"));
            return name ? { name, viaMember: false } : null;
        }
        const nameNode = node.childForFieldName("name");
        if (!nameNode)
            return null;
        const obj = node.childForFieldName("object");
        if (!obj)
            return { name: nameNode.text, viaMember: true, receiver: "this" };
        return { name: nameNode.text, viaMember: true, receiver: javaReceiver(obj) };
    }
    if (lang === "kotlin") {
        const target = node.namedChildren[0];
        if (target?.type === "simple_identifier")
            return { name: target.text, viaMember: false };
        if (target?.type === "navigation_expression") {
            const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
            const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
            const receiver = target.namedChildren[0];
            if (!name)
                return null;
            if (receiver?.type === "simple_identifier")
                return { name: name.text, viaMember: true, receiver: receiver.text };
            if (receiver?.type === "this_expression" || receiver?.type === "super_expression")
                return { name: name.text, viaMember: true, receiver: receiver.type === "this_expression" ? "this" : "super" };
        }
        return null;
    }
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier")
        return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
        const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
        const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
        const receiver = target.namedChildren[0];
        if (!name)
            return null;
        if (receiver?.type === "simple_identifier")
            return { name: name.text, viaMember: true, receiver: receiver.text };
        if (receiver?.type === "self_expression" || receiver?.type === "super_expression")
            return {
                name: name.text,
                viaMember: true,
                receiver: receiver.type === "self_expression" ? "self" : "super",
            };
        if (receiver?.type === "navigation_expression") {
            const head = receiver.namedChildren[0];
            const field = receiver.namedChildren
                .find((c) => c.type === "navigation_suffix")
                ?.namedChildren.find((c) => c.type === "simple_identifier");
            if (head?.type === "self_expression" && field)
                return { name: name.text, viaMember: true, receiver: `self.${field.text}` };
        }
        return { name: name.text, viaMember: true };
    }
    return null;
}
function rOperatorCalleeName(fn) {
    const rhs = fn.childForFieldName("rhs");
    if (rhs?.type !== "identifier")
        return null;
    if (fn.type === "extract_operator") {
        const lhs = fn.childForFieldName("lhs");
        if (lhs?.type === "identifier" && (lhs.text === "self" || lhs.text === "private")) {
            return { name: rhs.text, viaMember: true, receiver: "self" };
        }
        if (lhs?.type === "identifier" && lhs.text === "super") {
            return { name: rhs.text, viaMember: true, receiver: "super" };
        }
        return { name: rhs.text, viaMember: false, kinds: ["function", "method"] };
    }
    return { name: rhs.text, viaMember: false };
}
function calleeName(node, lang) {
    if (lang === "java" || lang === "kotlin" || lang === "swift")
        return jvmSwiftCalleeName(node, lang);
    if (lang === "php")
        return phpCallee(node);
    const fn = node.childForFieldName("function");
    if (!fn)
        return null;
    if (fn.type === "identifier")
        return { name: fn.text, viaMember: false };
    if (lang === "python" && fn.type === "attribute") {
        const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
        return a ? { name: a.text, viaMember: true, receiver: memberCallReceiver(fn, "attribute", "attribute", "self", false) } : null;
    }
    if (lang === "go" && fn.type === "selector_expression") {
        const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
        const operand = fn.childForFieldName("operand");
        const receiver = operand?.type === "identifier" ? operand.text : undefined;
        return p ? { name: p.text, viaMember: true, receiver } : null;
    }
    if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
        const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
        return p ? { name: p.text, viaMember: true, receiver: memberCallReceiver(fn, "member_expression", "property", "this", true) } : null;
    }
    if (lang === "r" && (fn.type === "extract_operator" || fn.type === "namespace_operator")) {
        return rOperatorCalleeName(fn);
    }
    return null;
}
/** The number of arguments at a Java call site (`method_invocation` or
 * `object_creation_expression`), read off the `arguments` list. Undefined when the
 * list is absent, which keeps resolution at its previous name-only behavior rather
 * than filtering on a count we never established. */
function javaArgCount(node) {
    const args = node.childForFieldName("arguments");
    return args ? args.namedChildren.length : undefined;
}
/**
 * The name a `new` CONSTRUCTS, as the graph names it — or null when this pass cannot
 * say, in which case the construction resolves to nothing.
 *
 * Erasing type arguments is the only transformation here, because it is the only one
 * that provably does not change which type is being named:
 *
 *     Box            -> Box
 *     Box<String>    -> Box     (the node is `Box`; the arguments are not part of it)
 *     Box<>          -> Box
 *
 * A QUALIFIED name is deliberately dropped rather than reduced to its final segment:
 *
 *     java.io.File   -> null    (not the repo's own `File`)
 *     Beta.Builder   -> null    (not `Alpha.Builder` in the same file)
 *
 * Collapsing those was the first attempt at this fix, and it traded lost edges for
 * WRONG ones — `new java.io.File(…)` resolved to an unrelated in-repo `File`, and a
 * nested `Beta.Builder` bound to a sibling `Alpha.Builder` at `extracted` confidence,
 * because the same-file tiebreak takes the first candidate. Dropping keeps this pass
 * on the resolver's own rule: resolve precisely, or not at all.
 *
 * Deliberately NOT shared with bindings.js's `javaTypeName`. That one answers "what
 * type does this variable HOLD", where reducing `java.util.List` to `List` is a local
 * heuristic with different stakes; this one answers "what type is being constructed",
 * and the two questions do not have the same safe answer. Supporting qualified
 * construction properly needs an import-aware type index, not a longer helper.
 */
function javaConstructedTypeName(node) {
    if (!node)
        return null;
    if (node.type === "generic_type")
        return javaConstructedTypeName(node.namedChildren[0]);
    return node.type === "type_identifier" ? node.text : null;
}
/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * `this.x` for a field access (`this.repo.save()`). A chained call or a qualified
 * static reference yields none — there is no confident local clue to bind. */
function javaReceiver(obj) {
    if (!obj)
        return undefined;
    if (obj.type === "identifier")
        return obj.text;
    if (obj.type === "this")
        return "this";
    if (obj.type === "field_access") {
        const inner = obj.childForFieldName("object");
        const field = obj.childForFieldName("field");
        if (inner?.type === "this" && field)
            return `this.${field.text}`;
    }
    return undefined;
}
/** Shared member-call receiver extractor for Python (`attribute`) and TS/JS (`member_expression`). */
function memberCallReceiver(fn, memberNodeType, propField, selfWord, allowBareSelf = false) {
    const obj = fn.childForFieldName("object");
    if (allowBareSelf && obj?.type === selfWord)
        return selfWord;
    if (obj?.type === "identifier")
        return obj.text;
    if (obj?.type === memberNodeType) {
        const innerObj = obj.childForFieldName("object");
        const innerProp = obj.childForFieldName(propField);
        const isSelf = allowBareSelf
            ? innerObj?.type === selfWord
            : innerObj?.type === "identifier" && innerObj.text === selfWord;
        if (isSelf && innerProp)
            return `${selfWord}.${innerProp.text}`;
        if (innerObj?.type === "identifier" && innerProp)
            return `${innerObj.text}.${innerProp.text}`;
    }
    return undefined;
}
/**
 * PHP call shapes: `foo()` (function_call_expression), `$obj->m()` /
 * `$obj?->m()` (member/nullsafe_member_call_expression), and `Cls::m()`
 * (scoped_call_expression). The called name is the trailing `name`; the
 * receiver, when locally knowable (`$this`, `self`/`static`/`parent`), feeds
 * receiver-typed resolution the same way Python's `self` and Go's receiver do.
 */
function phpCallee(node) {
    if (node.type === "function_call_expression") {
        const fn = node.childForFieldName("function");
        const name = fn ? phpName(fn) : null;
        return name ? { name, viaMember: false } : null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode)
        return null;
    if (node.type === "scoped_call_expression") {
        return { name: nameNode.text, viaMember: true, receiver: phpScopeReceiver(node.childForFieldName("scope")) };
    }
    // member_call_expression / nullsafe_member_call_expression
    return { name: nameNode.text, viaMember: true, receiver: phpObjReceiver(node.childForFieldName("object")) };
}
/** A PHP callee identifier: bare `name`, or the trailing segment of a
 * `qualified_name` (`\App\helpers\slug` → `slug`). Dynamic calls (`$fn()`) → null. */
function phpName(node) {
    if (node.type === "name")
        return node.text;
    if (node.type === "qualified_name")
        return node.text.replace(/^.*\\/, "") || null;
    return null;
}
/** `$obj->m()` receiver: `$this` normalizes to `this` (→ enclosing class); any
 * other variable is returned verbatim for a bindings lookup. */
function phpObjReceiver(obj) {
    if (obj?.type !== "variable_name")
        return undefined;
    return obj.text === "$this" ? "this" : obj.text;
}
/** `Cls::m()` receiver: `self`/`static`/`parent` normalize to `self` (→ enclosing
 * class); an explicit class name is the trailing segment of its qualified path. */
function phpScopeReceiver(scope) {
    if (!scope)
        return undefined;
    const text = scope.text;
    if (scope.type === "relative_scope" || text === "self" || text === "static" || text === "parent")
        return "self";
    if (scope.type === "name")
        return text;
    if (scope.type === "qualified_name")
        return text.replace(/^.*\\/, "");
    return undefined;
}
/** R has no import statement at the grammar level — `library(x)`, `require(x)`,
 * and `source("f.R")` are ordinary `call` nodes, indistinguishable from any other
 * call except by their callee name. This is call-SITE pattern matching, a first
 * for this function's normal node-type switch — every other language's import
 * shape is a dedicated grammar construct. */
const R_IMPORT_CALLS = new Set(["library", "require", "source"]);
function isImport(node, lang) {
    // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
    // (`import ( … )`) forms each yield one edge as the walk recurses into the list.
    if (lang === "go")
        return node.type === "import_spec";
    if (lang === "r") {
        if (node.type !== "call")
            return false;
        const fn = node.childForFieldName("function");
        return fn?.type === "identifier" && R_IMPORT_CALLS.has(fn.text);
    }
    if (lang === "java")
        return node.type === "import_declaration";
    if (lang === "kotlin")
        return node.type === "import_header";
    if (lang === "swift")
        return node.type === "import_declaration";
    // PHP: one edge per imported symbol — the clause leaf inside a (possibly
    // grouped) `use A\B, C\D;` / `use A\{B, C};` declaration.
    if (lang === "php")
        return node.type === "namespace_use_clause";
    return node.type === "import_statement" || node.type === "import_from_statement";
}
function importSpecifier(node, lang) {
    if (lang === "php") {
        // namespace_use_clause → its `qualified_name`/`name`, e.g. `App\Models\Animal`.
        const q = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
        return q ? q.text.replace(/^\\/, "") : null;
    }
    if (lang === "python") {
        const m = node.childForFieldName("module_name") ??
            node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
        return m?.text ?? null;
    }
    if (lang === "go") {
        // import_spec's `path` is an interpreted_string_literal, e.g. `"mymod/pkg/util"`.
        const path = node.childForFieldName("path") ?? node.namedChildren.at(-1);
        return path ? path.text.replace(/^["`]|["`]$/g, "") : null;
    }
    if (lang === "r") {
        // library(pkg) / library("pkg") / require(pkg) / source("f.R") — the target is
        // always the first (and normally only) positional argument, bare symbol or string.
        const value = rCallArgs(node)[0]?.childForFieldName("value") ?? null;
        if (value?.type === "identifier")
            return value.text;
        return rStringContent(value);
    }
    if (lang === "java") {
        // `import a.b.C;` / `import static a.b.C.d;` / `import a.b.*;` — the fully
        // qualified name is the scoped_identifier; a wildcard `*` is a separate token
        // and is dropped, leaving the package as the import target.
        const id = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
        return id?.text ?? null;
    }
    if (lang === "kotlin") {
        // `import com.example.Foo` — the dotted path is the `identifier` child. A
        // wildcard (`import a.b.*`) and an `as` alias are separate children, so the
        // identifier text is already the module path (wildcards dropped, like Java).
        return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
    }
    if (lang === "swift") {
        // `import UIKit` / `import struct Foundation.Date` — the dotted path is the
        // `identifier` child (an import-kind keyword like `struct` is a separate
        // token). Swift imports name MODULES, not files, so the specifier resolves
        // to a repo file only when a same-named module target exists; external
        // frameworks stay as unresolved (but truthful) import intents.
        return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
    }
    const str = node.namedChildren.find((c) => c.type === "string");
    if (!str)
        return null;
    const frag = str.namedChildren.find((c) => c.type === "string_fragment");
    return frag?.text ?? str.text.replace(/^['"]|['"]$/g, "");
}
/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw) {
    const sig = raw
        .replace(/\s+/g, " ")
        .trim()
        .replace(/(=>|[{:=])\s*$/, "")
        .trim();
    return sig || null;
}
