/**
 * Per-language symbol export/visibility predicates for Tier-1 and generic AST nodes.
 */

/** TS/JS: a definition is exported if an enclosing statement is `export_statement`. */
function tsExported(node) {
    let cur = node;
    let p = node?.parent;
    while (p) {
        if (p.type === "export_statement")
            return true;
        if (p.type === "assignment_expression" && p.childForFieldName("right")?.id === cur?.id) {
            const left = p.childForFieldName("left");
            if (left?.type === "member_expression") {
                const obj = left.childForFieldName("object")?.text;
                const lt = left.text ?? "";
                if (obj === "exports" || lt === "module.exports" || lt.startsWith("module.exports."))
                    return true;
            }
        }
        if (p.type === "statement_block" && p.parent?.type !== "internal_module" && p.parent?.type !== "module")
            return false;
        cur = p;
        p = p.parent;
    }
    return false;
}

/** TS/JS: true when an enclosing `export_statement` carries the `default` modifier. */
export function tsDefaultExported(node) {
    let p = node?.parent;
    while (p) {
        if (p.type === "export_statement")
            return p.children.some((c) => c.type === "default");
        if (p.type === "statement_block" && p.parent?.type !== "internal_module" && p.parent?.type !== "module")
            return false;
        p = p.parent;
    }
    return false;
}

/** Go: exported iff the unqualified identifier starts with an uppercase letter. */
function goExported(name) {
    const own = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    const first = own[0] ?? "";
    return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** Roxygen `#' @export` check: true if tagged, false if roxygen block lacks `@export`, null if undocumented. */
function rRoxygenExported(node) {
    let sib = node?.previousNamedSibling;
    let sawRoxygen = false;
    let exported = false;
    while (sib?.type === "comment") {
        const text = sib.text.trim();
        if (!text.startsWith("#'"))
            break;
        sawRoxygen = true;
        if (/^#'\s*@export\b/.test(text))
            exported = true;
        sib = sib.previousNamedSibling;
    }
    return sawRoxygen ? exported : null;
}

/** R: R6 section access first, then roxygen `@export`, then leading-dot convention. */
function rExported(name, ctx, node) {
    if (ctx && ctx.rR6Access !== undefined && ctx.rR6Access !== null)
        return ctx.rR6Access !== "private";
    const roxygen = rRoxygenExported(node);
    if (roxygen !== null)
        return roxygen;
    return !name.startsWith(".");
}

/** Java: `public` or `protected` in `modifiers`. */
function javaExported(node) {
    const mods = node?.namedChildren?.find((c) => c.type === "modifiers");
    if (!mods)
        return false;
    return mods.children.some((c) => c.type === "public" || c.type === "protected");
}

/** Kotlin: public by default unless `visibility_modifier` is non-`public`. */
function kotlinExported(node) {
    const mods = node?.namedChildren?.find((c) => c.type === "modifiers");
    if (!mods)
        return true;
    const vis = mods.namedChildren.find((c) => c.type === "visibility_modifier");
    return !vis || vis.text === "public";
}

/** Swift: internal-by-default is module-visible; only `private` and `fileprivate` hide symbols. */
function swiftExported(node) {
    const mods = node?.namedChildren?.find((c) => c.type === "modifiers");
    const vis = mods?.namedChildren?.find((c) => c.type === "visibility_modifier");
    return !vis || (vis.text !== "private" && vis.text !== "fileprivate");
}

/** PHP: visible unless explicitly `private` or `protected`. */
function phpExported(node) {
    const vis = node?.namedChildren?.find((c) => c.type === "visibility_modifier");
    return vis ? vis.text === "public" : true;
}

function rustHasPubModifier(node) {
    const vis = node?.namedChildren?.find((c) => c.type === "visibility_modifier");
    return Boolean(vis && vis.text.trim().startsWith("pub"));
}

/** Rust: `pub`/`pub(...)` items, `#[macro_export]` macros, trait `impl` items, or items in `pub trait`. */
export function rustExported(node) {
    if (!node)
        return false;
    if (rustHasPubModifier(node))
        return true;
    if (node.type === "macro_definition") {
        const prev = node.previousNamedSibling;
        if (prev?.type === "attribute_item" && /\bmacro_export\b/.test(prev.text))
            return true;
    }
    let p = node.parent;
    while (p) {
        if (p.type === "impl_item")
            return Boolean(p.childForFieldName?.("trait"));
        if (p.type === "trait_item")
            return rustHasPubModifier(p);
        if (p.type === "function_item" || p.type === "mod_item")
            return false;
        p = p.parent;
    }
    return false;
}

const C_DECLARATOR_WRAPPER = /_declarator$/;

function cCppOwningDecl(node) {
    let cur = node;
    while (cur?.parent && C_DECLARATOR_WRAPPER.test(cur.type))
        cur = cur.parent;
    return cur;
}

function cCppHasStaticStorage(decl) {
    const target = decl.type === "template_declaration"
        ? (decl.namedChildren?.find((c) => c.type !== "template_parameter_list") ?? decl)
        : decl;
    if (target.namedChildren?.some((c) => c.type === "storage_class_specifier" && c.text.trim() === "static"))
        return true;
    return Boolean(
        decl.parent?.type === "template_declaration" &&
            decl.parent.namedChildren?.some((c) => c.type === "storage_class_specifier" && c.text.trim() === "static"),
    );
}

function cCppIsAnonymousNamespace(nsNode) {
    if (nsNode.childForFieldName?.("name"))
        return false;
    return !nsNode.namedChildren?.some(
        (c) => c.type === "namespace_identifier" || c.type === "nested_namespace_specifier",
    );
}

function cCppMemberAccessExported(memberDecl, fieldList) {
    let sib = memberDecl.previousNamedSibling;
    while (sib) {
        if (sib.type === "access_specifier")
            return sib.text.replace(/:$/, "").trim() !== "private";
        sib = sib.previousNamedSibling;
    }
    return fieldList.parent?.type !== "class_specifier";
}

/** C/C++: top-level or named-namespace definitions without `static` linkage (plus non-private class/struct members). */
export function cCppExported(node, _ctx) {
    if (!node)
        return false;
    const decl = cCppOwningDecl(node);
    let p = decl.parent;
    while (p) {
        if (p.type === "compound_statement")
            return false;
        if (p.type === "field_declaration_list")
            return cCppMemberAccessExported(decl, p) && cCppExported(p.parent, _ctx);
        if (p.type === "namespace_definition" && cCppIsAnonymousNamespace(p))
            return false;
        p = p.parent;
    }
    return !cCppHasStaticStorage(decl);
}

const KNOWN_LANGS = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "r", "java", "kotlin", "swift", "php", "rust", "c", "cpp"]);

/** Dispatch symbol visibility rules for `ctx.lang` (or a language name string). */
export function isNodeExported(node, name, ctx) {
    if (ctx === undefined && (typeof name === "object" || KNOWN_LANGS.has(name))) {
        ctx = name;
        name = node?.childForFieldName?.("name")?.text ?? "";
    }
    const lang = typeof ctx === "string" ? ctx : ctx?.lang;
    const symName = typeof name === "string" ? name : "";
    switch (lang) {
        case "python":
            return !symName.startsWith("_");
        case "go":
            return goExported(symName);
        case "r":
            return rExported(symName, typeof ctx === "object" && ctx ? ctx : null, node);
        case "java":
            return javaExported(node);
        case "kotlin":
            return kotlinExported(node);
        case "swift":
            return swiftExported(node);
        case "php":
            return phpExported(node);
        case "rust":
            return rustExported(node);
        case "c":
        case "cpp":
            return cCppExported(node, ctx);
        default:
            return tsExported(node);
    }
}
