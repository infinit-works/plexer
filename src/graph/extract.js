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
import { R_ASSIGN_OPS, R_RIGHT_ASSIGN_OPS, collectBindings, goReceiverTypeOf, goReceiverVarOf, phpClosureName, resolveRecvFactory, resolveRecvType } from "./bindings.js";
import { collectShadowedLocals, sameSyntaxNode } from "./extract/shadow.js";
import { cCppExported, isNodeExported, rustExported, tsDefaultExported } from "./extract/visibility.js";
import { DEPTH_EXTENSIONS as EXTENSIONS, depthExtensions, genericLangOf, languageLabelOf, languageOf } from "./languages.js";
import { loadWasmLanguage, parseWasm } from "./generic.js";

export { cCppExported, depthExtensions, extractLeadingSummary, fileResidual, isNodeExported, languageLabelOf, languageOf, mintId, rustExported, searchBody };
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
// Depth extension tables moved to ./languages.js (re-exported above for compatibility).
const TS_KINDS = {
    class_declaration: "class",
    abstract_class_declaration: "class",
    function_declaration: "function",
    generator_function_declaration: "function",
    function_signature: "function",
    method_definition: "method",
    method_signature: "method",
    abstract_method_signature: "method",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    internal_module: "module",
    module_declaration: "module",
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
    typescript: new Set(["call_expression", "new_expression"]),
    tsx: new Set(["call_expression", "new_expression"]),
    python: new Set(["call"]),
    go: new Set(["call_expression"]),
    java: new Set(["method_invocation", "object_creation_expression", "method_reference", "explicit_constructor_invocation"]),
    kotlin: new Set(["call_expression"]),
    swift: new Set(["call_expression"]),
    php: new Set([
        "function_call_expression",
        "member_call_expression",
        "nullsafe_member_call_expression",
        "scoped_call_expression",
        "object_creation_expression",
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
export function extractFile(rel, source, lang = languageOf(rel), opts = null) {
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
    if (opts?.includeImportedSymbols instanceof Map) {
        for (const [k, v] of importedSymbols)
            opts.includeImportedSymbols.set(k, v);
    }
    const rGenerics = lang === "r" ? collectRGenerics(root) : EMPTY_SET;
    const pyAllExports = lang === "python" ? collectPythonAllExports(root) : EMPTY_SET;
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
        pyAllExports,
        shadowedNames: EMPTY_SET,
        nonCallableShadows: EMPTY_SET,
        defaultExportNames: new Set(),
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
    if (ctx.defaultExportNames.size > 0) {
        for (const n of nodes) {
            if (n.kind === "file")
                continue;
            const localPart = n.id.slice(rel.length + 1);
            if (!localPart.includes(".") && ctx.defaultExportNames.has(n.name)) {
                n.exported = true;
                n.defaultExport = true;
            }
        }
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

function firstClassSuperName(node, lang) {
    if (lang === "r")
        return rR6ParentClass(node);
    if (lang === "swift")
        return swiftSuperClassName(node);
    if (lang === "python") {
        const sc = node.childForFieldName("superclasses")?.namedChildren.find((c) => c.type === "identifier" || c.type === "attribute" || c.type === "subscript");
        if (sc?.type === "subscript") {
            const v = sc.childForFieldName("value");
            return v?.type === "attribute" ? (v.childForFieldName("attribute")?.text ?? null) : (v?.text ?? null);
        }
        return sc?.type === "attribute" ? (sc.childForFieldName("attribute")?.text ?? null) : (sc?.text ?? null);
    }
    if (lang === "typescript" || lang === "tsx") {
        const ext = node.namedChildren.find((c) => c.type === "class_heritage")?.namedChildren.find((c) => c.type === "extends_clause");
        const first = ext?.namedChildren[0];
        const base = first?.type === "generic_type" ? first.childForFieldName("name") : first;
        return base?.type === "member_expression" ? (base.childForFieldName("property")?.text ?? null) : (base?.text ?? null);
    }
    if (lang === "java") {
        const sup = node.namedChildren.find((c) => c.type === "superclass");
        const first = sup?.namedChildren[0];
        return first ? javaSupertypeName(first) : null;
    }
    if (lang === "kotlin") {
        const ds = node.namedChildren.find((c) => c.type === "delegation_specifier");
        const ci = ds?.namedChildren.find((c) => c.type === "constructor_invocation");
        const ut = (ci ?? ds)?.namedChildren.find((c) => c.type === "user_type");
        return ut?.namedChildren.filter((c) => c.type === "type_identifier").at(-1)?.text ?? null;
    }
    if (lang === "php") {
        const bc = node.namedChildren.find((c) => c.type === "base_clause")?.namedChildren[0];
        return bc ? bc.text.replace(/^.*\\/, "") : null;
    }
    return null;
}
function tsDecoratorReferenceEdges(node, sourceId, ctx) {
    const edges = [];
    const decorators = [];
    for (const c of node.namedChildren) {
        if (c.type === "decorator")
            decorators.push(c);
    }
    if (node.parent?.type === "export_statement") {
        for (const c of node.parent.namedChildren) {
            if (c.type === "decorator")
                decorators.push(c);
        }
    }
    for (let prev = node.previousNamedSibling; prev?.type === "decorator"; prev = prev.previousNamedSibling)
        decorators.push(prev);
    for (const c of decorators) {
        const expr = c.namedChildren[0];
        const fn = expr?.type === "call_expression" ? expr.childForFieldName("function") : expr;
        const name = fn?.type === "identifier"
            ? fn.text
            : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
        if (name) {
            const imp = ctx.importedSymbols.get(name);
            edges.push({
                source: sourceId,
                relation: "references",
                name: imp ? (imp.isDefault ? name : imp.name) : name,
                ...(imp?.specifier ? { specifier: imp.specifier } : {}),
                file: ctx.rel,
            });
        }
    }
    return edges;
}
function emitExtractedDefNode(node, desc, ctx, out, edges, minted) {
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    const owner = (desc.kind === "method" || desc.kind === "field")
        ? (isGoMethod ? (goReceiverTypeOf(node) ?? undefined) : (desc.owner ?? ctx.enclosingClass ?? undefined))
        : undefined;
    const nodeText = desc.hashNode.text;
    const isTsOrTsx = ctx.lang === "typescript" || ctx.lang === "tsx";
    const isDefaultExp = Boolean(desc.isDefaultExport) || (isTsOrTsx && tsDefaultExported(node));
    const returnType = ctx.bindings.getNodeReturnType?.(node);
    const exported = typeof desc.exported === "boolean" ? desc.exported : (isDefaultExp || isNodeExported(node, desc.name, ctx));
    out.push({
        id,
        name: desc.name,
        kind: desc.kind,
        path: ctx.rel,
        span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
        exported,
        origin: "ast",
        body_hash: contentHash(nodeText),
        body_text: searchBody(nodeText),
        summary_state: "pending",
        summary: extractLeadingSummary(ctx.lines, desc.hashNode.startPosition.row, ctx.lang === "python" ? nodeText : "", ctx.lang),
        crux: null,
        ...(owner !== undefined ? { owner } : {}),
        ...(desc.arity !== undefined ? { arity: desc.arity } : {}),
        ...(desc.variadic ? { variadic: true } : {}),
        ...(isDefaultExp ? { defaultExport: true } : {}),
        ...(returnType ? { returnType } : {}),
    });
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    const kotlinTypeDecl = ctx.lang === "kotlin" && KOTLIN_TYPE_KINDS.has(desc.kind);
    const swiftTypeDecl = ctx.lang === "swift" && SWIFT_TYPE_KINDS.has(desc.kind);
    if (desc.kind === "class" || desc.kind === "interface" || desc.kind === "struct" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl)
        edges.push(...heritageEdges(node, id, ctx));
    if (isTsOrTsx)
        edges.push(...tsDecoratorReferenceEdges(node, id, ctx));
    if (ctx.lang === "php")
        edges.push(...phpAttributeReferenceEdges(node, id, ctx));
    if (ctx.lang === "java")
        edges.push(...javaAnnotationReferenceEdges(node, id, ctx));
    const enclosingClass = desc.kind === "class" || desc.kind === "interface" || desc.kind === "struct" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl
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
        rSuperClass: (desc.kind === "class" || desc.kind === "struct")
            ? firstClassSuperName(node, ctx.lang)
            : ctx.rSuperClass,
    };
    walkNamedChildren(node.namedChildren, childCtx, out, edges, minted);
    if (ctx.lang === "kotlin" && (desc.kind === "class" || desc.kind === "struct")) {
        const pc = node.namedChildren.find((c) => c.type === "primary_constructor");
        if (pc) {
            for (const cp of pc.namedChildren) {
                if (cp.type !== "class_parameter")
                    continue;
                if (!cp.children?.some((k) => k.type === "val" || k.type === "var" || k.text === "val" || k.text === "var"))
                    continue;
                const pName = cp.namedChildren.find((c) => c.type === "simple_identifier")?.text;
                if (pName) {
                    const pId = mintId(`${ctx.rel}#${[...childCtx.scope, pName].join(".")}`, minted);
                    out.push({
                        id: pId,
                        name: pName,
                        kind: "field",
                        path: ctx.rel,
                        span: `L${cp.startPosition.row + 1}-L${cp.endPosition.row + 1}`,
                        signature: clean(cp.text),
                        exported: true,
                        origin: "ast",
                        body_hash: contentHash(cp.text),
                        body_text: searchBody(cp.text),
                        summary_state: "pending",
                        summary: null,
                        crux: null,
                        owner: desc.name,
                    });
                    edges.push({ source: id, relation: "contains", targetId: pId, file: ctx.rel });
                }
            }
        }
    }
}
function resolveCallFactoryMeta(recvFactory, ctx) {
    if (!recvFactory)
        return {};
    if (!recvFactory.viaMember) {
        const fImp = ctx.importedSymbols.get(recvFactory.callee);
        return {
            factoryName: fImp ? (fImp.isDefault ? recvFactory.callee : fImp.name) : recvFactory.callee,
            factorySpec: fImp?.specifier,
            factoryIsDefault: Boolean(fImp?.isDefault),
        };
    }
    const fNs = recvFactory.receiver ? ctx.importedSymbols.get(recvFactory.receiver) : undefined;
    return {
        factoryName: recvFactory.callee,
        factorySpec: fNs?.specifier,
        factoryOwner: !fNs && recvFactory.receiver ? recvFactory.receiver : undefined,
    };
}
function resolveCallNamespaceMeta(callee, recvType, ctx) {
    if (!callee.viaMember || recvType || !callee.receiver)
        return {};
    let nsImported = ctx.importedSymbols.get(callee.receiver);
    let subModule;
    if (!nsImported && callee.receiver.includes(".")) {
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
    return { nsImported, nsSpec, nsFallbackSpec, subModule };
}
function buildExtractedCallEdge(node, callee, recvType, ctx) {
    const sameFileOnly = !callee.viaMember && Boolean(ctx.shadowedNames?.has(callee.name));
    const imported = !callee.viaMember ? ctx.importedSymbols.get(callee.name) : undefined;
    const recvDefaultImp = recvType ? ctx.importedSymbols.get(recvType) : undefined;
    const recvFactory = callee.viaMember ? resolveRecvFactory(callee.receiver, ctx) : undefined;
    const { factoryName, factorySpec, factoryOwner, factoryIsDefault } = resolveCallFactoryMeta(recvFactory, ctx);
    const { nsImported, nsSpec, nsFallbackSpec, subModule } = resolveCallNamespaceMeta(callee, recvType, ctx);
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
        ...(imported?.isDefault ? { isDefault: true } : {}),
        ...(recvDefaultImp?.isDefault ? { recvSpecifier: recvDefaultImp.specifier, recvIsDefault: true } : {}),
        ...(factoryName ? { factoryName } : {}),
        ...(factorySpec ? { factorySpecifier: factorySpec } : {}),
        ...(factoryOwner ? { factoryOwner } : {}),
        ...(factoryIsDefault ? { factoryIsDefault: true } : {}),
        ...(imported?.typeOnly || nsImported?.typeOnly ? { typeOnly: true } : {}),
    };
    const argCount = ctx.lang === "java" ? javaArgCount(node) : ctx.lang === "swift" ? swiftArgCount(node) : undefined;
    if (argCount !== undefined)
        callEdge.argCount = argCount;
    return callEdge;
}
function emitExtractedCallEdge(node, ctx, edges) {
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall = consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    let callee = isConsumedRClassCall ? null : calleeName(node, ctx.lang);
    if (!callee || (!callee.viaMember && ctx.nonCallableShadows?.has(callee.name)))
        return;
    let recvType = callee.viaMember ? resolveRecvType(callee.receiver, ctx) : undefined;
    if (ctx.lang === "r" && callee.rBoundRecv && !recvType) {
        callee = { ...callee, viaMember: false, receiver: undefined };
    }
    const callEdge = buildExtractedCallEdge(node, callee, recvType, ctx);
    const swiftImplicitSelf = ctx.lang === "swift" && !callee.viaMember && !callee.kinds && ctx.enclosingClass && !/^[A-Z]/.test(callee.name);
    if (swiftImplicitSelf) {
        edges.push({ ...callEdge, viaMember: true, recvType: ctx.enclosingClass, implicitSelf: true });
        return;
    }
    edges.push(recvType ? { ...callEdge, recvType } : callEdge);
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
    if (ctx.lang === "python" && node.type === "import_from_statement") {
        const isInitPy = ctx.rel === "__init__.py" || ctx.rel.endsWith("/__init__.py");
        if (isInitPy || (ctx.pyAllExports && ctx.pyAllExports.size > 0)) {
            emitPythonInitReexports(node, spec, ctx, edges, !isInitPy);
        }
        else if (/^\.+$/.test(spec)) {
            for (const item of pythonFromImportItems(node)) {
                edges.push({ source: ctx.rel, relation: "imports", specifier: `${spec}${item.name}`, file: ctx.rel });
            }
        }
    }
}

function emitTsDynamicImportEdges(node, ctx, edges) {
    const dynSpec = tsCallImportSpecifier(node);
    if (!dynSpec)
        return;
    edges.push({ source: ctx.rel, relation: "imports", specifier: dynSpec, file: ctx.rel });
    if (ctx.enclosingKind !== null)
        return;
    const p = node.parent;
    if (p?.type === "call_expression" && p.childForFieldName("function")?.id === node.id) {
        edges.push({ source: ctx.rel, relation: "reexports", specifier: dynSpec, star: true, file: ctx.rel });
        return;
    }
    if (p?.type === "assignment_expression" && p.childForFieldName("right")?.id === node.id) {
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
        ...(imported.isDefault ? { isDefault: true } : {}),
        ...(imported.typeOnly ? { typeOnly: true } : {}),
    });
}

function emitMemberReferenceEdge(node, ctx, edges) {
    const isPyAttr = ctx.lang === "python" && node.type === "attribute";
    const isTsMember = (ctx.lang === "typescript" || ctx.lang === "tsx") && node.type === "member_expression";
    if (!isPyAttr && !isTsMember)
        return;
    const parent = node.parent;
    if (isPyAttr && parent?.type === "call" && parent.childForFieldName("function")?.id === node.id)
        return;
    if (isPyAttr && parent?.type === "assignment" && parent.childForFieldName("left")?.id === node.id)
        return;
    if (isTsMember && parent?.type === "call_expression" && parent.childForFieldName("function")?.id === node.id)
        return;
    if (isTsMember && parent?.type === "assignment_expression" && parent.childForFieldName("left")?.id === node.id)
        return;
    const propNode = isPyAttr
        ? (node.childForFieldName("attribute") ?? node.namedChildren.at(-1))
        : node.childForFieldName("property");
    const name = propNode?.type === (isPyAttr ? "identifier" : "property_identifier") ? propNode.text : null;
    if (!name || (isPyAttr && name.startsWith("__") && name.endsWith("__")))
        return;
    const receiver = isPyAttr
        ? memberCallReceiver(node, "attribute", "attribute", "self", false)
        : memberCallReceiver(node, "member_expression", "property", "this", true);
    if (!receiver)
        return;
    const recvType = resolveRecvType(receiver, ctx);
    const recvDefaultImp = recvType ? ctx.importedSymbols.get(recvType) : undefined;
    const recvFactory = !recvType ? resolveRecvFactory(receiver, ctx) : undefined;
    const { factoryName, factorySpec, factoryOwner, factoryIsDefault } = resolveCallFactoryMeta(recvFactory, ctx);
    const { nsImported, nsSpec, nsFallbackSpec, subModule } = resolveCallNamespaceMeta({ viaMember: true, receiver }, recvType, ctx);
    if (!recvType && !factoryName && !nsSpec)
        return;
    edges.push({
        source: ctx.parentId,
        relation: "references",
        name,
        viaMember: true,
        file: ctx.rel,
        ...(recvType ? { recvType } : {}),
        ...(recvDefaultImp?.isDefault ? { recvSpecifier: recvDefaultImp.specifier, recvIsDefault: true } : {}),
        ...(nsSpec ? { specifier: nsSpec } : {}),
        ...(nsFallbackSpec ? { fallbackSpecifier: nsFallbackSpec } : {}),
        ...(subModule ? { subModule } : {}),
        ...(factoryName ? { factoryName } : {}),
        ...(factorySpec ? { factorySpecifier: factorySpec } : {}),
        ...(factoryOwner ? { factoryOwner } : {}),
        ...(factoryIsDefault ? { factoryIsDefault: true } : {}),
        ...(nsImported?.typeOnly ? { typeOnly: true } : {}),
    });
}

function emitJsxAndDecoratorRefs(node, ctx, edges) {
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
        const nameNode = node.childForFieldName("name");
        if (nameNode?.type === "identifier" && /^[A-Z]/.test(nameNode.text)) {
            const imp = ctx.importedSymbols.get(nameNode.text);
            edges.push({
                source: ctx.parentId,
                relation: "references",
                name: imp ? (imp.isDefault ? nameNode.text : imp.name) : nameNode.text,
                ...(imp?.specifier ? { specifier: imp.specifier } : {}),
                ...(imp?.isDefault ? { isDefault: true } : {}),
                file: ctx.rel,
            });
        }
        else if (nameNode?.type === "member_expression") {
            const obj = nameNode.childForFieldName("object");
            const prop = nameNode.childForFieldName("property");
            if (obj?.type === "identifier" && prop) {
                const imp = ctx.importedSymbols.get(obj.text);
                edges.push({
                    source: ctx.parentId,
                    relation: "references",
                    name: prop.text,
                    ...(imp?.specifier ? { specifier: imp.specifier } : {}),
                    file: ctx.rel,
                });
            }
        }
        return true;
    }
    if (node.type === "type_arguments") {
        const walkTypes = (t) => {
            if (t.type === "type_identifier" && (t.text.length > 1 || ctx.importedSymbols.has(t.text))) {
                const imp = ctx.importedSymbols.get(t.text);
                edges.push({
                    source: ctx.parentId,
                    relation: "references",
                    name: imp ? (imp.isDefault ? t.text : imp.name) : t.text,
                    ...(imp?.specifier ? { specifier: imp.specifier } : {}),
                    ...(imp?.isDefault ? { isDefault: true } : {}),
                    file: ctx.rel,
                });
            }
            for (const c of t.namedChildren)
                walkTypes(c);
        };
        walkTypes(node);
        return true;
    }
    return false;
}

function emitStatementOrExprEdges(node, ctx, edges) {
    const callTypes = CALL_TYPES[ctx.lang];
    const isTsOrTsx = ctx.lang === "typescript" || ctx.lang === "tsx";
    if (isTsOrTsx && node.type === "export_statement") {
        emitTsExportEdges(node, ctx, edges);
        return;
    }
    if (isTsOrTsx && node.type === "assignment_expression" && ctx.enclosingKind === null) {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "member_expression" && left.text === "module.exports") {
            if (right?.type === "identifier") {
                ctx.defaultExportNames.add(right.text);
                const imp = ctx.importedSymbols.get(right.text);
                if (imp?.specifier) {
                    edges.push({
                        source: ctx.rel,
                        relation: "reexports",
                        specifier: imp.specifier,
                        exportedName: "default",
                        localName: imp.isDefault ? right.text : imp.name,
                        ...(imp.isDefault ? { isDefault: true } : {}),
                        file: ctx.rel,
                    });
                }
            }
            else if (right?.type === "object") {
                for (const p of right.namedChildren) {
                    let expName = null;
                    let localId = null;
                    if (p.type === "shorthand_property_identifier") {
                        expName = p.text;
                        localId = p.text;
                    }
                    else if (p.type === "pair") {
                        expName = p.childForFieldName("key")?.text?.replace(/^['"]|['"]$/g, "") ?? null;
                        const val = p.childForFieldName("value");
                        if (val?.type === "identifier")
                            localId = val.text;
                    }
                    if (!localId)
                        continue;
                    ctx.defaultExportNames.add(localId);
                    const imp = ctx.importedSymbols.get(localId);
                    if (imp?.specifier) {
                        edges.push({
                            source: ctx.rel,
                            relation: "reexports",
                            specifier: imp.specifier,
                            exportedName: expName ?? localId,
                            localName: imp.isDefault ? localId : imp.name,
                            ...(imp.isDefault ? { isDefault: true } : {}),
                            file: ctx.rel,
                        });
                    }
                }
            }
        }
    }
    if (isTsOrTsx && emitJsxAndDecoratorRefs(node, ctx, edges))
        return;
    if (callTypes.has(node.type)) {
        if (isTsOrTsx && node.type === "call_expression")
            emitTsDynamicImportEdges(node, ctx, edges);
        if (ctx.lang === "php" && (node.type === "include_expression" || node.type === "include_once_expression" ||
            node.type === "require_expression" || node.type === "require_once_expression")) {
            emitImportNodeEdges(node, ctx, edges);
            return;
        }
        emitExtractedCallEdge(node, ctx, edges);
        return;
    }
    if (ctx.lang === "php" && (node.type === "include_expression" || node.type === "include_once_expression" ||
        node.type === "require_expression" || node.type === "require_once_expression")) {
        emitImportNodeEdges(node, ctx, edges);
        return;
    }
    if (node.type === "identifier")
        emitImportedIdentifierRefEdge(node, callTypes, ctx, edges);
    else
        emitMemberReferenceEdge(node, ctx, edges);
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
function collectJavaImportedSymbols(root) {
    const out = new Map();
    const visitJavaNode = (node) => {
        if (node.type === "import_declaration") {
            const id = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
            const hasStar = node.children?.some((c) => c.type === "asterisk" || c.type === "*");
            if (id && !hasStar) {
                const name = id.split(".").pop();
                if (name)
                    out.set(name, { name, specifier: id });
            }
            return;
        }
        for (const child of node.namedChildren)
            visitJavaNode(child);
    };
    visitJavaNode(root);
    return out;
}
function collectKotlinImportedSymbols(root) {
    const out = new Map();
    const visitKotlinNode = (node) => {
        if (node.type === "import_header") {
            const id = node.namedChildren.find((c) => c.type === "identifier")?.text;
            const hasStar = node.children?.some((c) => c.type === "*");
            const alias = node.namedChildren.find((c) => c.type === "import_alias")
                ?.namedChildren.find((c) => c.type === "type_identifier")?.text;
            if (id && !hasStar) {
                const orig = id.split(".").pop();
                if (orig)
                    out.set(alias || orig, { name: orig, specifier: id });
            }
            return;
        }
        for (const child of node.namedChildren)
            visitKotlinNode(child);
    };
    visitKotlinNode(root);
    return out;
}
function collectPythonAllExports(root) {
    const names = new Set();
    for (const stmt of root.namedChildren) {
        const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : stmt;
        if (assign?.type !== "assignment")
            continue;
        if (assign.childForFieldName("left")?.text !== "__all__")
            continue;
        const rhs = assign.childForFieldName("right");
        if (rhs?.type !== "list" && rhs?.type !== "tuple")
            continue;
        for (const el of rhs.namedChildren) {
            if (el.type === "string") {
                const sc = el.namedChildren.find((c) => c.type === "string_content")?.text ?? el.text.replace(/^['"]|['"]$/g, "");
                if (sc)
                    names.add(sc);
            }
        }
    }
    return names;
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
            if (node.type === "import_alias") {
                const alias = node.namedChildren[0]?.type === "identifier" ? node.namedChildren[0].text : null;
                const reqClause = node.namedChildren.find((c) => c.type === "import_require_clause");
                const str = reqClause?.namedChildren.find((c) => c.type === "string");
                const spec = str ? (str.namedChildren.find((c) => c.type === "string_fragment")?.text ?? str.text.replace(/^['"]|['"]$/g, "")) : null;
                if (alias && spec)
                    out.set(alias, { name: "default", local: alias, specifier: spec, isDefault: true });
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
    if (lang === "java")
        return collectJavaImportedSymbols(root);
    if (lang === "kotlin")
        return collectKotlinImportedSymbols(root);
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
                else if (child.type === "dotted_name") {
                    const rootPkg = child.text.split(".")[0];
                    out.set(child.text, { specifier: child.text, isNamespace: true });
                    if (rootPkg && !out.has(rootPkg))
                        out.set(rootPkg, { specifier: child.text, isNamespace: true });
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
function emitPythonInitReexports(node, spec, ctx, edges, filterByAll = false) {
    if (!filterByAll && node.namedChildren.some((c) => c.type === "wildcard_import")) {
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
        if (filterByAll && !ctx.pyAllExports?.has(item.local))
            continue;
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
function collectTsObjectRequireProps(nameNode, specifier, out) {
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
function collectTsRequireBindings(node, out) {
    let value = node.childForFieldName("value");
    let memberProp = null;
    if (value?.type === "member_expression") {
        memberProp = value.childForFieldName("property")?.text ?? null;
        value = value.childForFieldName("object");
    }
    const call = unwrapCallExpression(value);
    const specifier = call ? tsCallImportSpecifier(call) : null;
    const nameNode = specifier ? node.childForFieldName("name") : null;
    if (!nameNode)
        return;
    if (nameNode.type === "identifier") {
        if (memberProp)
            out.set(nameNode.text, { name: memberProp, local: nameNode.text, specifier });
        else
            out.set(nameNode.text, { name: "default", local: nameNode.text, specifier, isDefault: true });
        return;
    }
    if (nameNode.type === "object_pattern" && !memberProp)
        collectTsObjectRequireProps(nameNode, specifier, out);
}
function emitTsExternalExportEdges(node, spec, exportClause, specifiers, isExportType, ctx, edges) {
    const allSpecsTypeOnly = specifiers.length > 0 && specifiers.every((s) => isTsTypeSpecifier(s));
    const importTypeOnly = isExportType || allSpecsTypeOnly;
    edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel, ...(importTypeOnly ? { typeOnly: true } : {}) });
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
        return;
    }
    const nsExport = node.namedChildren.find((c) => c.type === "namespace_export");
    const hasStar = Boolean(nsExport) || node.children.some((c) => c.type === "*");
    if (!hasStar)
        return;
    const nsName = nsExport
        ? (nsExport.namedChildren.find((c) => c.type === "identifier")?.text ?? nsExport.text.replace(/^\*\s+as\s+/, "").trim())
        : null;
    if (nsExport && !nsName)
        return;
    edges.push({
        source: ctx.rel,
        relation: "reexports",
        specifier: spec,
        ...(nsName ? { exportedName: nsName } : {}),
        star: true,
        file: ctx.rel,
        ...(isExportType ? { typeOnly: true } : {}),
    });
}
function emitTsLocalReexportClauseEdges(specifiers, isExportType, ctx, edges) {
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
                ...(imported.isDefault ? { isDefault: true } : {}),
                file: ctx.rel,
                ...(specTypeOnly ? { typeOnly: true } : {}),
            });
        }
        else if (orig && alias === "default") {
            ctx.defaultExportNames.add(orig);
        }
    }
}
function emitTsDefaultReexportEdge(node, isExportType, ctx, edges) {
    const val = node.childForFieldName("value");
    if (val?.type !== "identifier")
        return;
    ctx.defaultExportNames.add(val.text);
    const imported = ctx.importedSymbols.get(val.text);
    if (!imported)
        return;
    edges.push({
        source: ctx.rel,
        relation: "reexports",
        specifier: imported.specifier,
        exportedName: "default",
        localName: imported.isDefault ? val.text : imported.name,
        ...(imported.isDefault ? { isDefault: true } : {}),
        file: ctx.rel,
        ...(imported.typeOnly || isExportType ? { typeOnly: true } : {}),
    });
}
function emitTsExportEdges(node, ctx, edges) {
    const isExportType = isTsStatementTypeKeyword(node, "export");
    const spec = importSpecifier(node, ctx.lang);
    const exportClause = node.namedChildren.find((c) => c.type === "export_clause");
    const specifiers = exportClause ? exportClause.namedChildren.filter((c) => c.type === "export_specifier") : [];
    if (spec) {
        emitTsExternalExportEdges(node, spec, exportClause, specifiers, isExportType, ctx, edges);
        return;
    }
    if (exportClause) {
        emitTsLocalReexportClauseEdges(specifiers, isExportType, ctx, edges);
        return;
    }
    if (node.children.some((c) => c.type === "default"))
        emitTsDefaultReexportEdge(node, isExportType, ctx, edges);
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
    if (parent?.type === "jsx_opening_element" ||
        parent?.type === "jsx_self_closing_element" ||
        parent?.type === "jsx_closing_element")
        return false;
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
function describeTsDefaultExport(node) {
    const isFnOrClass = FUNCTION_VALUE_TYPES.has(node.type) ||
        node.type === "function_declaration" ||
        node.type === "generator_function_declaration" ||
        node.type === "class_declaration" ||
        node.type === "abstract_class_declaration";
    if (!isFnOrClass || node.childForFieldName("name") || node.parent?.type !== "export_statement")
        return null;
    if (!node.parent.children.some((c) => c.type === "default"))
        return null;
    const isClass = node.type === "class_declaration" || node.type === "abstract_class_declaration";
    const body = node.childForFieldName("body");
    return { name: "default", kind: isClass ? "class" : "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
}
function unwrapTsReactHocFn(value) {
    if (!value)
        return null;
    if (FUNCTION_VALUE_TYPES.has(value.type))
        return value;
    if (value.type !== "call_expression")
        return null;
    const fn = value.childForFieldName("function");
    const fnName = fn?.type === "identifier"
        ? fn.text
        : fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : null;
    if (fnName !== "memo" && fnName !== "forwardRef")
        return null;
    const firstArg = value.childForFieldName("arguments")?.namedChildren[0];
    return firstArg && FUNCTION_VALUE_TYPES.has(firstArg.type) ? firstArg : unwrapTsReactHocFn(firstArg);
}
function describeTsAssignedFn(node, ctx) {
    if (node.type === "variable_declarator") {
        const value = node.childForFieldName("value");
        const fnVal = unwrapTsReactHocFn(value);
        const name = fnVal ? node.childForFieldName("name")?.text : null;
        if (name && fnVal) {
            const vbody = fnVal.childForFieldName("body");
            return { name, kind: "function", headerEnd: vbody ? vbody.startIndex : node.endIndex, hashNode: node };
        }
        const declName = node.childForFieldName("name")?.text;
        const expStmt = node.parent?.parent;
        const reqCall = value ? unwrapCallExpression(value) : null;
        if (declName && expStmt?.type === "export_statement" && (!reqCall || !tsCallImportSpecifier(reqCall))) {
            return {
                name: declName,
                kind: /^[A-Z][A-Z0-9_]*$/.test(declName) ? "constant" : "variable",
                headerEnd: value ? value.startIndex : node.endIndex,
                hashNode: node,
                exported: true,
            };
        }
        return null;
    }
    if (node.type === "public_field_definition") {
        const value = node.childForFieldName("value");
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
            const vbody = value.childForFieldName("body");
            return { name, kind: "method", headerEnd: vbody ? vbody.startIndex : node.endIndex, hashNode: node };
        }
        if (ctx.enclosingClass && (value || node.childForFieldName("type"))) {
            return { name, kind: "field", headerEnd: value ? value.startIndex : node.endIndex, hashNode: node, owner: ctx.enclosingClass };
        }
        return null;
    }
    if (node.type !== "assignment_expression")
        return null;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type !== "member_expression" || !right)
        return null;
    if (left.text === "module.exports") {
        const isFnOrClass = FUNCTION_VALUE_TYPES.has(right.type) ||
            right.type === "class" ||
            right.type === "class_declaration" ||
            right.type === "function_declaration" ||
            right.type === "generator_function_declaration";
        if (!isFnOrClass)
            return null;
        const isClass = right.type === "class" || right.type === "class_declaration";
        const rName = right.childForFieldName("name")?.text;
        const vbody = right.childForFieldName("body");
        return {
            name: rName || "default",
            kind: isClass ? "class" : "function",
            headerEnd: vbody ? vbody.startIndex : node.endIndex,
            hashNode: node,
            isDefaultExport: true,
        };
    }
    const prop = left.childForFieldName("property")?.text;
    if (!prop || prop === "exports" || !/^[A-Za-z_$][\w$]*$/.test(prop))
        return null;
    const objText = left.childForFieldName("object")?.text;
    const isDirectExportAssign = objText === "exports" || objText === "module.exports";
    if (!FUNCTION_VALUE_TYPES.has(right.type)) {
        if (isDirectExportAssign && ctx.enclosingKind === null && right.type !== "call_expression") {
            return {
                name: prop,
                kind: /^[A-Z][A-Z0-9_]*$/.test(prop) ? "constant" : "variable",
                headerEnd: right.startIndex,
                hashNode: node,
                exported: true,
            };
        }
        return null;
    }
    const rawOwner = objText && objText !== "exports" && objText !== "module.exports" && objText !== "this"
        ? objText.replace(/^(?:module\.)?exports\./, "").replace(/\.prototype$/, "")
        : undefined;
    const owner = rawOwner && rawOwner !== "exports" && rawOwner !== "module" ? rawOwner : undefined;
    const vbody = right.childForFieldName("body");
    return {
        name: prop,
        ...(owner && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(owner) ? { idName: `${owner}.${prop}`, owner, kind: "method" } : { kind: "function" }),
        headerEnd: vbody ? vbody.startIndex : node.endIndex,
        hashNode: node,
    };
}
function describeTsCliCommandAction(node, ctx) {
    if (node.type !== "call_expression" || node.parent?.type !== "expression_statement" || ctx.scope.length !== 0)
        return null;
    const outerFn = node.childForFieldName("function");
    const outerProp = outerFn?.type === "member_expression" ? outerFn.childForFieldName("property")?.text : null;
    if (outerProp !== "action" && outerProp !== "handler")
        return null;
    const actionCb = node.childForFieldName("arguments")?.namedChildren.find((c) => FUNCTION_VALUE_TYPES.has(c.type));
    if (!actionCb)
        return null;
    let cur = outerFn.childForFieldName("object");
    let cmdName = null;
    while (cur?.type === "call_expression") {
        const m = cur.childForFieldName("function");
        if (m?.type === "member_expression" && m.childForFieldName("property")?.text === "command") {
            const firstArg = cur.childForFieldName("arguments")?.namedChildren[0];
            if (firstArg?.type === "string") {
                const rawCmd = firstArg.text.replace(/^['"`]|['"`]$/g, "").trim();
                cmdName = /^([A-Za-z][\w-]*)/.exec(rawCmd)?.[1] ?? null;
            }
            break;
        }
        cur = m?.type === "member_expression" ? m.childForFieldName("object") : null;
    }
    if (!cmdName)
        return null;
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
function describeTypeScriptSpecial(node, ctx) {
    return describeTsDefaultExport(node) ?? describeTsAssignedFn(node, ctx) ?? describeTsCliCommandAction(node, ctx);
}
function describeLangSpecial(node, ctx) {
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
        return { name: phpClosureName(node), kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
    }
    if (ctx.lang === "php" && node.type === "anonymous_class") {
        const body = node.childForFieldName("body");
        return { name: "{anonymous}", kind: "class", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
    }
    return undefined;
}
function describePyModuleOrClassAttr(node, ctx) {
    if (ctx.lang !== "python")
        return null;
    if (node.type === "type_alias_statement") {
        const name = node.childForFieldName("name")?.text ?? node.namedChildren[0]?.text;
        return name ? { name, kind: "type", headerEnd: node.endIndex, hashNode: node } : null;
    }
    if (node.type !== "expression_statement")
        return null;
    const inClass = ctx.enclosingKind === "class" && node.parent?.type === "block" && node.parent?.parent?.type === "class_definition";
    const atTopLevel = ctx.enclosingKind === null && node.parent?.type === "module";
    if (!inClass && !atTopLevel)
        return null;
    const expr = node.namedChildren.length === 1 ? node.namedChildren[0] : null;
    if (expr?.type !== "assignment")
        return null;
    const left = expr.childForFieldName("left");
    if (left?.type !== "identifier")
        return null;
    const name = left.text;
    if (!name || name === "__all__" || (name.startsWith("__") && name.endsWith("__")))
        return null;
    const hasType = Boolean(expr.childForFieldName("type"));
    const isCall = expr.childForFieldName("right")?.type === "call";
    const isUpperConst = /^[A-Z][A-Z0-9_]*$/.test(name);
    if (inClass) {
        if (!hasType && !isCall && !isUpperConst)
            return null;
        return { name, kind: "field", headerEnd: expr.endIndex, hashNode: node };
    }
    if (!hasType && !isUpperConst)
        return null;
    return { name, kind: isUpperConst ? "constant" : "variable", headerEnd: expr.endIndex, hashNode: node };
}
/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node, ctx) {
    const special = describeLangSpecial(node, ctx);
    if (special !== undefined)
        return special;
    if (ctx.lang === "python") {
        const pyAttr = describePyModuleOrClassAttr(node, ctx);
        if (pyAttr)
            return pyAttr;
    }
    if (ctx.lang === "typescript" || ctx.lang === "tsx") {
        const tsSpecial = describeTypeScriptSpecial(node, ctx);
        if (tsSpecial)
            return tsSpecial;
        if (node.type === "function_signature") {
            const inAmbient = ctx.rel.endsWith(".d.ts") || node.parent?.type === "ambient_declaration" || ctx.enclosingKind === "module";
            if (!inAmbient)
                return null;
        }
    }
    const mapped = ctx.kinds[node.type];
    const name = mapped ? node.childForFieldName("name")?.text : null;
    if (!name)
        return null;
    let kind = mapped;
    if ((ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") ||
        (ctx.lang === "php" && mapped === "function" && ctx.enclosingKind === "enum")) {
        kind = "method";
    }
    const body = node.childForFieldName("body") ?? (node.type === "type_alias_declaration" ? node.childForFieldName("value") : null);
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
}
/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node, ctx) {
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
    if (node.type === "method_elem") {
        const name = node.namedChildren.find((c) => c.type === "field_identifier")?.text;
        if (!name)
            return null;
        return { name, kind: "method", headerEnd: node.endIndex, hashNode: node };
    }
    if (node.type === "field_declaration" && ctx.enclosingKind === "struct") {
        const fName = node.childForFieldName("name")?.text;
        return fName ? { name: fName, kind: "field", headerEnd: node.endIndex, hashNode: node, owner: ctx.enclosingClass } : null;
    }
    if ((node.type === "const_spec" || node.type === "var_spec") && ctx.enclosingKind === null) {
        const name = node.childForFieldName("name")?.text;
        if (name && name !== "_")
            return { name, kind: node.type === "const_spec" ? "constant" : "variable", headerEnd: node.endIndex, hashNode: node };
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
function firstParenLineEnd(source, node) {
    const paren = source.indexOf("(", node.startIndex);
    if (paren < 0 || paren >= node.endIndex)
        return node.endIndex;
    const nl = source.indexOf("\n", paren);
    return nl >= 0 && nl < node.endIndex ? nl : node.endIndex;
}

function headerEndBeforeAssignOrBrace(node) {
    for (const c of node.children ?? []) {
        if (
            c.type === "=" ||
            c.type === "{" ||
            c.type === "type_initializer" ||
            c.type === "computed_getter" ||
            c.type === "willset_didset_block" ||
            c.type === "property_delegate" ||
            c.type === "getter" ||
            c.type === "setter"
        ) {
            return c.startIndex;
        }
    }
    return node.endIndex;
}

function describeRBinaryOp(node, ctx) {
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
        return { name: lhs.text, kind: "class", headerEnd: firstParenLineEnd(ctx.source, rhs), hashNode: rhs };
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "list" && rIsMixinContainer(rhs)) {
        // Phase 5: a plain-list mixin/extension bundle — same treatment as R6Class.
        return { name: lhs.text, kind: "class", headerEnd: firstParenLineEnd(ctx.source, rhs), hashNode: rhs };
    }
    return null;
}

function describeRRightAssignFn(node, ctx) {
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

function describeR6MethodArg(node) {
    // R6 (Phase 2): reached via walk()'s own `argument`-node interception for a
    // `public =`/`private =`/`active =` list entry — see the special case there
    // for why this can't just be a flat kind-table/node-type check like every
    // other definition shape.
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

function describeR(node, ctx) {
    if (node.type === "binary_operator")
        return describeRBinaryOp(node, ctx);
    if (node.type === "function_definition")
        return describeRRightAssignFn(node, ctx);
    if (node.type === "call")
        return describeRTopLevelCall(node, ctx);
    if (node.type === "argument" && ctx.rR6Access !== null)
        return describeR6MethodArg(node);
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
function describeRTopLevelCall(node, ctx) {
    const callee = rCalleeName(node);
    if (callee === "setClass") {
        const first = rCallArgs(node)[0]?.childForFieldName("value");
        const name = first?.type === "string" ? rStringContent(first) : null;
        if (!name)
            return null;
        return { name, kind: "class", headerEnd: firstParenLineEnd(ctx.source, node), hashNode: node };
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
    if (node.type === "variable_declarator" && node.parent?.type === "field_declaration" && ctx.enclosingClass) {
        const name = node.childForFieldName("name")?.text;
        return name ? { name, kind: "field", headerEnd: node.parent.endIndex, hashNode: node.parent, owner: ctx.enclosingClass } : null;
    }
    if (node.type === "enum_constant" && ctx.enclosingClass) {
        const name = node.childForFieldName("name")?.text;
        return name ? { name, kind: "field", headerEnd: node.endIndex, hashNode: node, owner: ctx.enclosingClass } : null;
    }
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
function describeKotlinClass(node) {
    const name = childTypeName(node);
    if (!name)
        return null;
    let kind = "class";
    if (node.namedChildren.some((c) => c.type === "enum_class_body"))
        kind = "enum";
    else if (node.children.some((c) => c.type === "interface"))
        kind = "interface";
    else if (node.namedChildren.find((c) => c.type === "modifiers")?.namedChildren.some((c) => c.type === "class_modifier" && c.text === "annotation"))
        kind = "interface";
    return { name, kind, headerEnd: childHeadEnd(node, "class_body", "enum_class_body"), hashNode: node };
}
/** Kotlin definition shapes. Unlike Java's, tree-sitter-kotlin exposes no `name`
 * or `body` fields. */
function describeKotlin(node, ctx) {
    if (node.type === "class_declaration")
        return describeKotlinClass(node);
    if (node.type === "companion_object") {
        const name = childTypeName(node) ?? "Companion";
        return { name, kind: "class", headerEnd: childHeadEnd(node, "class_body"), hashNode: node };
    }
    if (node.type === "object_declaration" || node.type === "type_alias") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return node.type === "object_declaration"
            ? { name, kind: "class", headerEnd: childHeadEnd(node, "class_body"), hashNode: node }
            : { name, kind: "type", headerEnd: headerEndBeforeAssignOrBrace(node), hashNode: node };
    }
    if (node.type === "function_declaration") {
        const name = childFuncName(node);
        if (!name)
            return null;
        const headerEnd = childHeadEnd(node, "function_body");
        const fnIdx = node.namedChildren.findIndex((c) => c.type === "simple_identifier");
        const recvNode = fnIdx > 0 ? node.namedChildren.slice(0, fnIdx).find((c) => c.type === "user_type" || c.type === "nullable_type") : null;
        const recvType = recvNode?.namedChildren.filter((c) => c.type === "type_identifier").at(-1)?.text ??
            recvNode?.namedChildren.find((c) => c.type === "user_type")?.namedChildren.filter((c) => c.type === "type_identifier").at(-1)?.text ?? null;
        if (recvType)
            return { name, idName: `${recvType}.${name}`, owner: recvType, kind: "method", headerEnd, hashNode: node };
        return { name, kind: KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function", headerEnd, hashNode: node };
    }
    if (node.type === "secondary_constructor") {
        return ctx.enclosingClass ? { name: ctx.enclosingClass, kind: "method", headerEnd: childHeadEnd(node, "statements"), hashNode: node } : null;
    }
    if (node.type === "property_declaration") {
        const name = node.namedChildren.find((c) => c.type === "variable_declaration")?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        if (!name)
            return null;
        if (KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file"))
            return { name, kind: "field", headerEnd: headerEndBeforeAssignOrBrace(node), hashNode: node, owner: ctx.enclosingClass };
        return { name, kind: "variable", headerEnd: headerEndBeforeAssignOrBrace(node), hashNode: node };
    }
    return null;
}
function describeSwiftClass(node) {
    const kw = node.children.find((c) => c.type === "class" || c.type === "struct" || c.type === "enum" || c.type === "actor" || c.type === "extension")?.type;
    const name = kw === "extension"
        ? (node.namedChildren.find((c) => c.type === "user_type")?.namedChildren.filter((c) => c.type === "type_identifier").at(-1)?.text ?? null)
        : childTypeName(node);
    if (!name)
        return null;
    const kind = kw === "extension" ? "module" : kw === "struct" ? "struct" : kw === "enum" ? "enum" : "class";
    return { name, kind, headerEnd: childHeadEnd(node, "class_body", "enum_class_body"), hashNode: node };
}
/** Swift definition shapes. */
function describeSwift(node, ctx) {
    if (node.type === "class_declaration")
        return describeSwiftClass(node);
    if (node.type === "protocol_declaration" || node.type === "typealias_declaration") {
        const name = childTypeName(node);
        if (!name)
            return null;
        return node.type === "protocol_declaration"
            ? { name, kind: "interface", headerEnd: childHeadEnd(node, "protocol_body"), hashNode: node }
            : { name, kind: "type", headerEnd: headerEndBeforeAssignOrBrace(node), hashNode: node };
    }
    if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
        const name = childFuncName(node);
        if (!name)
            return null;
        const kind = node.type === "protocol_function_declaration" || SWIFT_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function";
        return { name, kind, headerEnd: childHeadEnd(node, "function_body"), hashNode: node, ...swiftArity(node) };
    }
    if (node.type === "init_declaration") {
        return ctx.enclosingClass
            ? { name: ctx.enclosingClass, kind: "method", headerEnd: childHeadEnd(node, "function_body"), hashNode: node, ...swiftArity(node) }
            : null;
    }
    if (node.type === "property_declaration" && ctx.enclosingKind === null) {
        const name = node.namedChildren.find((c) => c.type === "pattern")?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        return name ? { name, kind: "variable", headerEnd: headerEndBeforeAssignOrBrace(node), hashNode: node } : null;
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
    if (!node.children?.some((c) => c.type === "class"))
        return null;
    const spec = node.namedChildren.find((c) => c.type === "inheritance_specifier");
    const ids = spec?.namedChildren
        .find((c) => c.type === "user_type")
        ?.namedChildren.filter((c) => c.type === "type_identifier");
    return ids?.length ? ids[ids.length - 1].text : null;
}
function javaHeritageEdges(node, classId, ctx) {
    const edges = [];
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
            if (name && !typeParams.has(name))
                edges.push({ source: classId, relation, name, file: ctx.rel });
        }
    }
    return edges;
}
function jvmSwiftHeritageEdges(node, classId, ctx) {
    if (ctx.lang === "java")
        return javaHeritageEdges(node, classId, ctx);
    const edges = [];
    let specIdx = 0;
    const isSwiftClass = ctx.lang === "swift" && node.children?.some((c) => c.type === "class");
    for (const child of node.namedChildren) {
        if (ctx.lang === "kotlin" && child.type === "delegation_specifier") {
            const ci = child.namedChildren.find((c) => c.type === "constructor_invocation");
            const ut = (ci ?? child).namedChildren.find((c) => c.type === "user_type");
            const t = ut?.namedChildren.filter((c) => c.type === "type_identifier").at(-1);
            if (t)
                edges.push({ source: classId, relation: ci ? "extends" : "implements", name: t.text, file: ctx.rel });
        }
        else if (ctx.lang === "swift" && child.type === "inheritance_specifier") {
            const ids = child.namedChildren.find((c) => c.type === "user_type")?.namedChildren.filter((c) => c.type === "type_identifier");
            const t = ids?.at(-1);
            if (t) {
                const relKind = isSwiftClass && specIdx === 0 ? "extends" : "implements";
                edges.push({ source: classId, relation: relKind, name: t.text, file: ctx.rel });
                specIdx++;
            }
        }
    }
    return edges;
}
function extractRHeritageEdges(node, classId, ctx) {
    const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
    const callee = call?.type === "call" ? rCalleeName(call) : null;
    const edges = [];
    if (callee === "R6Class") {
        const value = rNamedArg(call, "inherit");
        if (value?.type === "identifier")
            edges.push({ source: classId, relation: "extends", name: value.text, file: ctx.rel });
    }
    else if (callee === "setClass") {
        for (const name of rStringOrCVector(rNamedArg(call, "contains")))
            edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
    }
    return edges;
}
function extractPhpHeritageEdges(node, classId, ctx) {
    const edges = [];
    for (const clause of node.namedChildren) {
        const relation = clause.type === "base_clause" ? "extends" : clause.type === "class_interface_clause" ? "implements" : null;
        if (!relation) continue;
        for (const t of clause.namedChildren) {
            if (t.type === "name" || t.type === "qualified_name") {
                const bare = t.text.replace(/^.*\\/, "");
                const imp = t.type === "name" ? ctx.importedSymbols.get(bare) : null;
                edges.push({
                    source: classId,
                    relation,
                    name: imp ? imp.name : bare,
                    ...(imp?.specifier ? { specifier: imp.specifier } : t.type === "qualified_name" ? { specifier: t.text.replace(/^\\/, "") } : {}),
                    file: ctx.rel,
                });
            }
        }
    }
    return edges;
}
function extractGoHeritageEdges(node, classId, ctx) {
    const edges = [];
    const ifaceNode = node.childForFieldName("type");
    if (ifaceNode?.type === "interface_type") {
        for (const elem of ifaceNode.namedChildren) {
            if (elem.type !== "type_elem")
                continue;
            for (const t of elem.namedChildren) {
                const name = t.type === "type_identifier" ? t.text : t.type === "qualified_type" ? t.childForFieldName("name")?.text : null;
                if (name)
                    edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
            }
        }
        return edges;
    }
    if (ifaceNode?.type === "struct_type") {
        const list = ifaceNode.namedChildren.find((c) => c.type === "field_declaration_list");
        for (const fd of list?.namedChildren ?? []) {
            if (fd.type !== "field_declaration" || fd.childForFieldName("name"))
                continue;
            let t = fd.childForFieldName("type") ?? fd.namedChildren[0];
            if (t?.type === "pointer_type")
                t = t.namedChildren.at(-1);
            const name = t?.type === "type_identifier" ? t.text : t?.type === "qualified_type" ? t.childForFieldName("name")?.text : null;
            if (name)
                edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
        }
    }
    return edges;
}
function extractPhpGoHeritageEdges(node, classId, ctx) {
    return ctx.lang === "php"
        ? extractPhpHeritageEdges(node, classId, ctx)
        : extractGoHeritageEdges(node, classId, ctx);
}
function extractTsHeritageEdges(node, classId, ctx) {
    const edges = [];
    const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
    const directExtends = node.namedChildren.find((c) => c.type === "extends_type_clause");
    const clauses = [...(heritage?.namedChildren ?? []), ...(directExtends ? [directExtends] : [])];
    for (const clause of clauses) {
        const relation = clause.type === "implements_clause" ? "implements" : (clause.type === "extends_clause" || clause.type === "extends_type_clause") ? "extends" : null;
        if (!relation) continue;
        for (const t of clause.namedChildren) {
            const nameNode = t.type === "generic_type" ? t.childForFieldName("name") : t;
            if (nameNode?.type === "identifier" || nameNode?.type === "type_identifier")
                edges.push({ source: classId, relation, name: nameNode.text, file: ctx.rel });
            else if (nameNode?.type === "member_expression") {
                const prop = nameNode.childForFieldName("property")?.text;
                if (prop)
                    edges.push({ source: classId, relation, name: prop, file: ctx.rel });
            }
            else if (nameNode?.type === "nested_type_identifier") {
                const tail = nameNode.namedChildren.findLast((c) => c.type === "type_identifier")?.text;
                if (tail)
                    edges.push({ source: classId, relation, name: tail, file: ctx.rel });
            }
        }
    }
    return edges;
}
function heritageEdges(node, classId, ctx) {
    if (ctx.lang === "java" || ctx.lang === "kotlin" || ctx.lang === "swift")
        return jvmSwiftHeritageEdges(node, classId, ctx);
    if (ctx.lang === "python") {
        const edges = [];
        for (const c of node.childForFieldName("superclasses")?.namedChildren ?? []) {
            if (c.type === "identifier") {
                edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
            }
            else if (c.type === "attribute") {
                const attr = c.childForFieldName("attribute") ?? c.namedChildren.at(-1);
                if (attr?.type === "identifier")
                    edges.push({ source: classId, relation: "extends", name: attr.text, file: ctx.rel });
            }
            else if (c.type === "subscript") {
                const val = c.childForFieldName("value");
                const b = val?.type === "identifier" ? val.text : val?.type === "attribute" ? val.childForFieldName("attribute")?.text : null;
                if (b && b !== "Generic" && b !== "Protocol")
                    edges.push({ source: classId, relation: "extends", name: b, file: ctx.rel });
            }
        }
        return edges;
    }
    if (ctx.lang === "r")
        return extractRHeritageEdges(node, classId, ctx);
    if (ctx.lang === "php" || ctx.lang === "go")
        return extractPhpGoHeritageEdges(node, classId, ctx);
    return extractTsHeritageEdges(node, classId, ctx);
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
function javaCalleeName(node) {
    if (node.type === "object_creation_expression") {
        const name = javaConstructedTypeName(node.childForFieldName("type"));
        return name ? { name, viaMember: false } : null;
    }
    if (node.type === "method_reference") {
        const ids = node.namedChildren.filter((c) => c.type === "identifier");
        const m = ids.at(-1)?.text;
        const recvNode = node.namedChildren[0];
        const recv = recvNode && recvNode.type !== "super"
            ? (recvNode.type === "this" ? "this" : recvNode.type === "type_identifier" || recvNode.type === "identifier" ? recvNode.text : undefined)
            : "super";
        return m ? { name: m, viaMember: Boolean(recv), ...(recv ? { receiver: recv } : {}) } : null;
    }
    if (node.type === "explicit_constructor_invocation") {
        const ctor = node.namedChildren[0]?.type;
        if (ctor === "super" || node.children?.some((c) => c.type === "super"))
            return { name: "constructor", viaMember: true, receiver: "super" };
        if (ctor === "this" || node.children?.some((c) => c.type === "this"))
            return { name: "constructor", viaMember: true, receiver: "this" };
        return null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode)
        return null;
    const obj = node.childForFieldName("object");
    return { name: nameNode.text, viaMember: true, receiver: obj ? javaReceiver(obj) : "this" };
}
function kotlinNavigationChain(nav, depth = 0) {
    if (!nav || depth > 4)
        return undefined;
    if (nav.type === "simple_identifier")
        return nav.text;
    if (nav.type === "this_expression")
        return "this";
    if (nav.type === "super_expression")
        return "super";
    if (nav.type === "navigation_expression") {
        const head = kotlinNavigationChain(nav.namedChildren[0], depth + 1);
        const suf = nav.namedChildren.find((c) => c.type === "navigation_suffix")?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        return head && suf ? `${head}.${suf}` : (suf ?? head);
    }
    return undefined;
}
function kotlinCalleeName(node) {
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier")
        return { name: target.text, viaMember: false };
    if (target?.type !== "navigation_expression")
        return null;
    const name = target.namedChildren.find((c) => c.type === "navigation_suffix")?.namedChildren.find((c) => c.type === "simple_identifier");
    const receiver = kotlinNavigationChain(target.namedChildren[0]);
    if (!name)
        return null;
    return receiver ? { name: name.text, viaMember: true, receiver } : null;
}
function swiftNavigationChain(nav, depth = 0) {
    if (!nav || depth > 4)
        return undefined;
    if (nav.type === "simple_identifier")
        return nav.text;
    if (nav.type === "self_expression")
        return "self";
    if (nav.type === "super_expression")
        return "super";
    if (nav.type === "navigation_expression") {
        const head = swiftNavigationChain(nav.namedChildren[0], depth + 1);
        const suf = nav.namedChildren.find((c) => c.type === "navigation_suffix")?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        return head && suf ? `${head}.${suf}` : (suf ?? head);
    }
    return undefined;
}
function swiftCalleeName(node) {
    let target = node.namedChildren[0];
    while (target && (target.type === "try_expression" || target.type === "await_expression"))
        target = target.namedChildren[0];
    if (target?.type === "simple_identifier")
        return { name: target.text, viaMember: false };
    if (target?.type !== "navigation_expression")
        return null;
    const name = target.namedChildren.find((c) => c.type === "navigation_suffix")?.namedChildren.find((c) => c.type === "simple_identifier");
    if (!name)
        return null;
    const receiver = swiftNavigationChain(target.namedChildren[0]);
    return receiver ? { name: name.text, viaMember: true, receiver } : { name: name.text, viaMember: true };
}
function jvmSwiftCalleeName(node, lang) {
    if (lang === "java")
        return javaCalleeName(node);
    if (lang === "kotlin")
        return kotlinCalleeName(node);
    return swiftCalleeName(node);
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
        if (lhs?.type === "identifier") {
            return { name: rhs.text, viaMember: true, receiver: lhs.text, rBoundRecv: true, kinds: ["function", "method"] };
        }
        return { name: rhs.text, viaMember: false, kinds: ["function", "method"] };
    }
    return { name: rhs.text, viaMember: false };
}
function goMemberChain(operand, depth = 0) {
    if (!operand || depth > 4)
        return undefined;
    if (operand.type === "identifier")
        return operand.text;
    if (operand.type === "selector_expression") {
        const inner = goMemberChain(operand.childForFieldName("operand"), depth + 1);
        const field = (operand.childForFieldName("field") ?? operand.namedChildren.at(-1))?.text;
        return inner && field ? `${inner}.${field}` : (field ?? inner);
    }
    return undefined;
}
function calleeName(node, lang) {
    if (lang === "java" || lang === "kotlin" || lang === "swift")
        return jvmSwiftCalleeName(node, lang);
    if (lang === "php")
        return phpCallee(node);
    if (lang === "typescript" || lang === "tsx") {
        if (node.type === "new_expression") {
            const ctor = node.childForFieldName("constructor");
            if (ctor?.type === "identifier")
                return { name: ctor.text, viaMember: false };
            if (ctor?.type === "member_expression") {
                const prop = ctor.childForFieldName("property")?.text;
                return prop ? { name: prop, viaMember: true, receiver: memberCallReceiver(ctor, "member_expression", "property", "this", true) } : null;
            }
            return null;
        }
    }
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
        const receiver = goMemberChain(operand);
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
    if (node.type === "scoped_type_identifier") {
        const parts = node.text.split(".");
        if (parts.length === 2 && /^[A-Z]/.test(parts[0]) && /^[A-Z]/.test(parts[1]))
            return node.text;
        return null;
    }
    return node.type === "type_identifier" ? node.text : null;
}
/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * chained field access (`this.repo.client.save()`). */
function javaReceiver(obj, depth = 0) {
    if (!obj || depth > 4)
        return undefined;
    if (obj.type === "identifier")
        return obj.text;
    if (obj.type === "this")
        return "this";
    if (obj.type === "super")
        return "super";
    if (obj.type === "field_access") {
        const inner = javaReceiver(obj.childForFieldName("object"), depth + 1);
        const field = obj.childForFieldName("field");
        if (inner && field)
            return `${inner}.${field.text}`;
    }
    return undefined;
}
/** Shared member-call receiver extractor for Python (`attribute`) and TS/JS (`member_expression`), supporting multi-hop chains & `super().m()`. */
function memberCallReceiver(fn, memberNodeType, propField, selfWord, allowBareSelf = false) {
    const step = (cur, depth) => {
        if (!cur || depth > 4)
            return undefined;
        if (allowBareSelf && cur.type === selfWord)
            return selfWord;
        if (cur.type === "super")
            return "super";
        if (cur.type === "call" && cur.childForFieldName("function")?.text === "super")
            return "super";
        if (cur.type === "identifier")
            return cur.text;
        if (cur.type === memberNodeType) {
            const inner = step(cur.childForFieldName("object"), depth + 1);
            const prop = cur.childForFieldName(propField);
            return inner && prop ? `${inner}.${prop.text}` : undefined;
        }
        return undefined;
    };
    return step(fn.childForFieldName("object"), 0);
}
function phpCallee(node) {
    if (node.type === "object_creation_expression") {
        const cls = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
        const bare = cls ? cls.text.replace(/^.*\\/, "") : null;
        return bare ? { name: bare, viaMember: false } : null;
    }
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
/** `$obj->m()` receiver: `$this` normalizes to `this`; chained `$this->repo->m()` unwinds cleanly. */
function phpObjReceiver(obj, depth = 0) {
    if (!obj || depth > 4)
        return undefined;
    if (obj.type === "variable_name")
        return obj.text === "$this" ? "this" : obj.text;
    if (obj.type === "member_access_expression") {
        const inner = phpObjReceiver(obj.childForFieldName("object"), depth + 1);
        const prop = obj.childForFieldName("name")?.text;
        return inner && prop ? `${inner}.${prop}` : undefined;
    }
    return undefined;
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
        return node.type === "namespace_use_clause" ||
            node.type === "include_expression" ||
            node.type === "include_once_expression" ||
            node.type === "require_expression" ||
            node.type === "require_once_expression";
    if (lang === "typescript" || lang === "tsx")
        return node.type === "import_statement" || node.type === "import_alias";
    return node.type === "import_statement" || node.type === "import_from_statement";
}
function importSpecifier(node, lang) {
    if ((lang === "typescript" || lang === "tsx") && node.type === "import_alias") {
        const str = node.namedChildren.find((c) => c.type === "import_require_clause")?.namedChildren.find((c) => c.type === "string");
        if (!str)
            return null;
        return str.namedChildren.find((c) => c.type === "string_fragment")?.text ?? str.text.replace(/^['"]|['"]$/g, "");
    }
    if (lang === "php") {
        if (node.type === "include_expression" || node.type === "include_once_expression" ||
            node.type === "require_expression" || node.type === "require_once_expression") {
            const stack = [node];
            for (let i = 0; i < stack.length; i++) {
                const cur = stack[i];
                if (cur.type === "string" || cur.type === "encapsed_string") {
                    const txt = cur.text.replace(/^['"]|['"]$/g, "").trim();
                    if (txt)
                        return txt.startsWith("/") ? `.${txt}` : txt;
                }
                for (const c of cur.namedChildren ?? [])
                    stack.push(c);
            }
            return null;
        }
        // namespace_use_clause → its `qualified_name`/`name`, e.g. `App\Models\Animal`.
        // For grouped `use App\Models\{User, Order};`, prepend parent's `namespace_name`.
        const q = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
        if (!q)
            return null;
        const itemName = q.text.replace(/^\\/, "");
        if (node.parent?.type === "namespace_use_group" && node.parent.parent?.type === "namespace_use_declaration") {
            const prefix = node.parent.parent.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/^\\|\\$/g, "") ?? "";
            if (prefix)
                return `${prefix}\\${itemName}`;
        }
        return itemName;
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
function skipParenGroup(src, startIdx) {
    let i = startIdx + 1;
    let depth = 1;
    let quote = null;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (quote) {
            if (ch === "\\" && i + 1 < src.length) {
                i += 2;
                continue;
            }
            if (ch === quote)
                quote = null;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            i++;
            continue;
        }
        if (ch === "(")
            depth++;
        else if (ch === ")")
            depth--;
        i++;
    }
    return depth === 0 ? i : src.length;
}

function stripLeadingDecorators(raw) {
    let i = 0;
    const n = raw.length;
    while (i < n) {
        while (i < n && /\s/.test(raw[i]))
            i++;
        if (i >= n || raw[i] !== "@")
            break;
        if (/^@interface\b/.test(raw.slice(i)))
            break;
        const m = /^@[A-Za-z_][\w.]*/.exec(raw.slice(i));
        if (!m)
            break;
        i += m[0].length;
        let ws = i;
        while (ws < n && (raw[ws] === " " || raw[ws] === "\t"))
            ws++;
        if (ws < n && raw[ws] === "(") {
            i = skipParenGroup(raw, ws);
        }
    }
    return raw.slice(i);
}

/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw) {
    const sig = stripLeadingDecorators(raw)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/(=>|[{:=])\s*$/, "")
        .trim();
    if (!sig)
        return null;
    return sig.length > 240 ? `${sig.slice(0, 239)}…` : sig;
}
