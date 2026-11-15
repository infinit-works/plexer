/** Variable/field → bare type name, keyed by scope. Scope keys mirror
 * extract.js's own scope stack (`scope.join(".")`, `""` at module level) so a
 * lookup from extract.js's walk finds exactly what was bound in the same
 * lexical position. */
class FileBindings {
    map = new Map();
    factoryMap = new Map();
    nodeReturnTypes = new Map();
    set(scopePath, name, type) {
        const key = `${scopePath}|${name}`;
        this.map.set(key, type);
        this.factoryMap.delete(key);
    }
    setFactory(scopePath, name, factoryInfo, force = false) {
        if (!name)
            return;
        const key = `${scopePath}|${name}`;
        if (force || !this.map.has(key))
            this.factoryMap.set(key, factoryInfo);
    }
    getNodeReturnType(node) {
        return node ? (this.nodeReturnTypes.get(node.startIndex) ?? null) : null;
    }
    /** Innermost-first: for scope ["a","b"] name "x", tries `a.b|x`, `a|x`, `|x`. */
    lookup(scope, name) {
        for (let i = scope.length; i >= 0; i--) {
            const hit = this.map.get(`${scope.slice(0, i).join(".")}|${name}`);
            if (hit)
                return hit;
        }
        return null;
    }
    /** Innermost-first factory call lookup when no concrete type shadowed the name. */
    lookupFactory(scope, name, allowTyped = false) {
        for (let i = scope.length; i >= 0; i--) {
            const key = `${scope.slice(0, i).join(".")}|${name}`;
            const hit = this.factoryMap.get(key);
            if (hit)
                return hit;
            if (!allowTyped && this.map.has(key))
                return null;
        }
        return null;
    }
}
function recordNodeReturnType(bindings, node, typeName) {
    if (node && typeName)
        bindings.nodeReturnTypes.set(node.startIndex, typeName);
}
const FN_VALUE_TYPES = new Set(["arrow_function", "function", "function_expression", "generator_function"]);
const PHP_DEF_TYPES = new Set([
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
    "method_declaration",
    "function_definition",
]);
const PY_DEF_TYPES = new Set(["class_definition", "function_definition"]);
const TS_DEF_TYPES = new Set([
    "class_declaration",
    "abstract_class_declaration",
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
]);
/** Definition-node types that push a new scope segment, mirroring extract.js's
 * `describe()` closely enough to keep the two scope stacks in lockstep — but
 * duplicated here (not imported) to keep bindings.js free of a value import on
 * extract.js. Returns the def's scope segment (bare name, except a Go method
 * which is receiver-qualified — `Receiver.method` — exactly like extract.js's
 * `idName`, so a binding recorded inside a Go method body is stored under the
 * same scope key extract.js's walk will look it up with), or null if `node`
 * isn't a definition. */
function goDefName(node) {
    if (node.type === "method_declaration") {
        const name = node.childForFieldName("name")?.text;
        if (!name)
            return null;
        const recv = goReceiverTypeOf(node);
        return recv ? `${recv}.${name}` : name;
    }
    return (node.type === "function_declaration" || node.type === "type_spec")
        ? (node.childForFieldName("name")?.text ?? null)
        : null;
}
function phpDefName(node) {
    if (PHP_DEF_TYPES.has(node.type))
        return node.childForFieldName("name")?.text ?? null;
    if (node.type === "anonymous_function" || node.type === "arrow_function")
        return phpClosureName(node);
    return node.type === "anonymous_class" ? "{anonymous}" : null;
}
function defName(node, lang) {
    if (lang === "java")
        return JAVA_DEF_TYPES.has(node.type) ? (node.childForFieldName("name")?.text ?? null) : null;
    if (lang === "go")
        return goDefName(node);
    if (lang === "r")
        return rDefName(node);
    if (lang === "swift")
        return swiftDefName(node);
    if (lang === "php")
        return phpDefName(node);
    const defTypes = lang === "python" ? PY_DEF_TYPES : TS_DEF_TYPES;
    if (defTypes.has(node.type))
        return node.childForFieldName("name")?.text ?? null;
    if ((lang === "typescript" || lang === "tsx") && node.type === "variable_declarator") {
        const value = node.childForFieldName("value");
        if (value && FN_VALUE_TYPES.has(value.type))
            return node.childForFieldName("name")?.text ?? null;
    }
    return null;
}
/** The scope segment a Swift definition pushes, mirroring extract.js's
 * `describeSwift` (duplicated, not imported, per this file's
 * no-value-import-of-extract rule): types and extensions push the type's name
 * (an extension is named after the type it extends), functions their own name,
 * and an `init` the enclosing type's name — extract.js names initializers after
 * their type, so the two scope stacks stay in lockstep inside an init body.
 * Typealias and top-level properties DO mint nodes in extract.js but are
 * deliberately absent here: neither has a body a binding could be set in (a
 * property initializer's closure is the one vanishing exception, mis-keying
 * only bindings set inside itself). */
function swiftDefName(node) {
    if (node.type === "class_declaration") {
        if (node.children.some((c) => c.type === "extension")) {
            const ut = node.namedChildren.find((c) => c.type === "user_type");
            const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
            return ids.at(-1)?.text ?? null;
        }
        return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
    }
    if (node.type === "protocol_declaration") {
        return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
    }
    if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
        return node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
    }
    if (node.type === "init_declaration") {
        const owner = node.parent?.parent; // class_body / protocol_body → the declaration
        return owner ? swiftDefName(owner) : null;
    }
    return null;
}
export const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
export const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);
/**
 * The bare name a `binary_operator` (left-assign) or `function_definition`
 * (right-assign) node defines, for R's two plain-function assignment shapes —
 * this file's own `defName` uses it directly.
 * Null if `node` isn't one of these two shapes.
 */
function rDefName(node) {
    if (node.type === "binary_operator") {
        const op = node.childForFieldName("operator")?.text;
        if (!op || !R_ASSIGN_OPS.has(op))
            return null;
        const lhs = node.childForFieldName("lhs");
        const rhs = node.childForFieldName("rhs");
        return lhs?.type === "identifier" && rhs?.type === "function_definition" ? lhs.text : null;
    }
    if (node.type === "function_definition") {
        const body = node.childForFieldName("body");
        if (body?.type !== "binary_operator")
            return null;
        const op = body.childForFieldName("operator")?.text;
        if (!op || !R_RIGHT_ASSIGN_OPS.has(op))
            return null;
        const rhs = body.childForFieldName("rhs");
        return rhs?.type === "identifier" ? rhs.text : null;
    }
    return null;
}
/** The receiver parameter's own variable name for a Go method (`func (w *Worker) …`
 * → `w`). Null if it can't be read. */
export function goReceiverVarOf(node) {
    const recv = node.childForFieldName("receiver");
    const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
    return param?.childForFieldName("name")?.text ?? null;
}
/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (w *Worker) …` → `Worker`). Null if it can't be read. */
export function goReceiverTypeOf(node) {
    const recv = node.childForFieldName("receiver");
    const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
    let type = param?.childForFieldName("type");
    if (type?.type === "pointer_type")
        type = type.namedChildren.at(-1) ?? null;
    return type?.type === "type_identifier" ? type.text : null;
}
/** Resolves a call site's receiver text (from `calleeName`) to a bound type
 * name, given the enclosing walk state. `self`/`cls`/`this`/the Go receiver
 * var resolve directly to the enclosing class; `super` — R6's `super$` and
 * Swift's `super.` alike — resolves to the PARENT class instead
 * (`ctx.rSuperClass`, not `ctx.enclosingClass` — a super call must climb past
 * the current class's own same-named override, not find it); anything else is
 * a bindings-map lookup, normalizing `this.` to `self.` since both are stored
 * the same way. */
export function resolveRecvType(receiver, ctx) {
    if (!receiver)
        return undefined;
    if (receiver === "self" || receiver === "cls" || receiver === "this")
        return ctx.enclosingClass ?? undefined;
    if (receiver === "super")
        return ctx.rSuperClass ?? undefined;
    if (receiver.startsWith("self.") || receiver.startsWith("this.")) {
        return (ctx.bindings.lookup(ctx.scope, receiver) ??
            ctx.bindings.lookup(ctx.scope, receiver.replace(/^this\./, "self.")) ??
            undefined);
    }
    // PHP static call `Foo::bar()`: the scope operand is a class name, so it *is*
    // the receiver type. (Member calls pass a `$var` receiver, filtered by the `$`.)
    if (ctx.lang === "php" && !receiver.startsWith("$"))
        return receiver;
    return ((ctx.lang === "go" && receiver === ctx.goReceiverVar ? ctx.enclosingClass : undefined) ??
        ctx.bindings.lookup(ctx.scope, receiver) ??
        // Swift type-member call `Animal.staticThing()`: an uppercase receiver with no
        // local binding is the type itself (Swift naming: types are UpperCamelCase,
        // values lowerCamelCase — and a shadowing binding was already tried above).
        (ctx.lang === "swift" && /^[A-Z]/.test(receiver) ? receiver : undefined) ??
        undefined);
}

/** Looks up the 1-hop factory call binding that initialized `receiver`, if any. */
export function resolveRecvFactory(receiver, ctx) {
    if (!receiver || !ctx.bindings?.lookupFactory)
        return undefined;
    if (receiver === "self" || receiver === "cls" || receiver === "this" || receiver === "super")
        return undefined;
    const allowTyped = ctx.lang === "go";
    if (receiver.startsWith("self.") || receiver.startsWith("this.")) {
        return (ctx.bindings.lookupFactory(ctx.scope, receiver, allowTyped) ??
            ctx.bindings.lookupFactory(ctx.scope, receiver.replace(/^this\./, "self."), allowTyped) ??
            undefined);
    }
    return ctx.bindings.lookupFactory(ctx.scope, receiver, allowTyped) ?? undefined;
}
function isClassNode(node, lang) {
    if (lang === "python")
        return node.type === "class_definition";
    if (lang === "java")
        return JAVA_TYPE_DECLS.has(node.type);
    if (lang === "typescript" || lang === "tsx") {
        return node.type === "class_declaration" || node.type === "abstract_class_declaration";
    }
    // Swift: class_declaration covers class/struct/enum/actor/extension — all can
    // hold members whose `self.field` bindings live at the type's scope.
    if (lang === "swift") {
        return node.type === "class_declaration" || node.type === "protocol_declaration";
    }
    return false;
}
/** Java declarations that push a scope segment — mirrors extract.js's JAVA_KINDS. */
const JAVA_DEF_TYPES = new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
    "annotation_type_element_declaration",
    "method_declaration",
    "constructor_declaration",
]);
/** The subset of the above that owns `this.field` bindings. */
const JAVA_TYPE_DECLS = new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
]);
/** Pass 1 over a parsed file: collect variable->type bindings. Pure. */
export function collectBindings(root, lang) {
    const bindings = new FileBindings();
    const aliases = new Map();
    const returnTypes = new Map();
    collectAliases(root, lang, aliases);
    collectReturnTypes(root, lang, null, aliases, returnTypes, bindings);
    visit(root, lang, [], "", null, bindings, aliases, returnTypes);
    return bindings;
}
/** Import aliases (`... as F`) can be declared anywhere relative to their use
 * textually, so this scans the whole tree once, ahead of the scope-aware walk. */
function collectAliases(node, lang, aliases) {
    if (lang === "python" && node.type === "aliased_import") {
        const nameNode = node.childForFieldName("name");
        const aliasNode = node.childForFieldName("alias");
        if (nameNode && aliasNode) {
            const orig = nameNode.type === "dotted_name" ? (nameNode.namedChildren.at(-1)?.text ?? nameNode.text) : nameNode.text;
            aliases.set(aliasNode.text, orig);
        }
    }
    else if ((lang === "typescript" || lang === "tsx") && node.type === "import_specifier") {
        const nameNode = node.childForFieldName("name");
        const aliasNode = node.childForFieldName("alias");
        if (nameNode && aliasNode)
            aliases.set(aliasNode.text, nameNode.text);
    }
    for (const child of node.namedChildren)
        collectAliases(child, lang, aliases);
}
function recordReturnTypeEntry(name, retList, ownerNode, classScope, returnTypes, bindings) {
    if (!name || !retList || retList.length === 0)
        return;
    if (retList[0])
        recordNodeReturnType(bindings, ownerNode, retList[0]);
    const key = classScope ? `${classScope}.${name}` : name;
    if (!returnTypes.has(key))
        returnTypes.set(key, retList);
    if (!classScope && !returnTypes.has(name))
        returnTypes.set(name, retList);
}
function collectPyReturnTypes(node, classScope, aliases, returnTypes, bindings) {
    if (node.type === "class_definition")
        return node.childForFieldName("name")?.text ?? classScope;
    if (node.type === "function_definition") {
        const name = node.childForFieldName("name")?.text;
        const ret = pyTypeName(node.childForFieldName("return_type"), aliases);
        if (name && ret)
            recordReturnTypeEntry(name, [ret], node, classScope, returnTypes, bindings);
    }
    return classScope;
}
function collectGoReturnTypes(node, classScope, returnTypes, bindings) {
    if (node.type === "function_declaration") {
        const name = node.childForFieldName("name")?.text;
        const rets = goReturnTypeNames(node.childForFieldName("result"));
        if (name && rets.some(Boolean))
            recordReturnTypeEntry(name, rets, node, classScope, returnTypes, bindings);
    }
    else if (node.type === "method_declaration") {
        const name = node.childForFieldName("name")?.text;
        const recv = goReceiverTypeOf(node);
        const rets = goReturnTypeNames(node.childForFieldName("result"));
        if (name && recv && rets.some(Boolean)) {
            if (rets[0])
                recordNodeReturnType(bindings, node, rets[0]);
            returnTypes.set(`${recv}.${name}`, rets);
        }
    }
}
function collectTsReturnTypes(node, classScope, aliases, returnTypes, bindings) {
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration")
        return node.childForFieldName("name")?.text ?? classScope;
    if (node.type === "function_declaration" || node.type === "generator_function_declaration" || node.type === "method_definition") {
        const name = node.childForFieldName("name")?.text;
        const ret = tsAnnotationTypeName(node.childForFieldName("return_type"), aliases);
        if (name && ret)
            recordReturnTypeEntry(name, [ret], node, classScope, returnTypes, bindings);
    }
    else if (node.type === "variable_declarator") {
        const value = node.childForFieldName("value");
        const name = value && FN_VALUE_TYPES.has(value.type) ? node.childForFieldName("name")?.text : null;
        const ret = name ? tsAnnotationTypeName(value.childForFieldName("return_type"), aliases) : null;
        if (name && ret)
            recordReturnTypeEntry(name, [ret], node, classScope, returnTypes, bindings);
    }
    return classScope;
}
function collectReturnTypes(node, lang, classScope, aliases, returnTypes, bindings) {
    let nextClassScope = classScope;
    if (lang === "python")
        nextClassScope = collectPyReturnTypes(node, classScope, aliases, returnTypes, bindings);
    else if (lang === "go")
        collectGoReturnTypes(node, classScope, returnTypes, bindings);
    else if (lang === "typescript" || lang === "tsx")
        nextClassScope = collectTsReturnTypes(node, classScope, aliases, returnTypes, bindings);
    for (const child of node.namedChildren)
        collectReturnTypes(child, lang, nextClassScope, aliases, returnTypes, bindings);
}

/** `scope`/`classScope` mirror extract.js's walk: `scope` is the enclosing
 * definition-name stack; `classScope` is the nearest enclosing class's scope
 * path (distinct from `scope` once we're inside one of its methods) — that's
 * where `self.attr`/`this.attr` bindings live. */
function visit(node, lang, scope, scopePath, classScope, bindings, aliases, returnTypes) {
    if (lang === "python")
        handlePy(node, scope, scopePath, classScope, bindings, aliases, returnTypes);
    else if (lang === "go")
        handleGo(node, scopePath, bindings, returnTypes);
    // R Phase 1 has no classes, so there's no member/receiver-type binding to
    // collect yet (see extract.js's calleeName R branch) — no handleR needed.
    else if (lang === "r")
        void 0;
    else if (lang === "java")
        handleJava(node, scopePath, classScope, bindings);
    else if (lang === "swift")
        handleSwift(node, scopePath, classScope, bindings);
    else if (lang === "php")
        handlePhp(node, scopePath, bindings);
    else
        handleTs(node, scopePath, classScope, bindings, aliases, returnTypes);
    const name = defName(node, lang);
    let childScope = scope;
    let childScopePath = scopePath;
    let childClassScope = classScope;
    if (name !== null) {
        childScope = [...scope, name];
        childScopePath = scopePath ? `${scopePath}.${name}` : name;
        if (isClassNode(node, lang))
            childClassScope = childScopePath;
    }
    for (const child of node.namedChildren)
        visit(child, lang, childScope, childScopePath, childClassScope, bindings, aliases, returnTypes);
}
/** Resolves a bare type name through `aliases` — every annotation path must
 * consult it, so an aliased import (`import Foo as Bar`) still binds to the
 * original name callers actually search for. See the "aliases already
 * resolved" contract above. */
function resolveAlias(name, aliases) {
    return aliases.get(name) ?? name;
}
function unwrapAwaitExpr(node) {
    let cur = node;
    while (cur && (cur.type === "await_expression" || cur.type === "parenthesized_expression" || cur.type === "as_expression" || cur.type === "satisfies_expression" || cur.type === "type_assertion" || cur.type === "non_null_expression")) {
        cur = cur.childForFieldName("expression") ?? cur.namedChildren[0] ?? null;
    }
    return cur;
}

const CALL_TARGET_SPECS = {
    python: { callType: "call", fnField: "function", memberType: "attribute", objField: "object", memberField: "attribute" },
    go: { callType: "call_expression", fnField: "function", memberType: "selector_expression", objField: "operand", memberField: "field" },
    typescript: { callType: "call_expression", fnField: "function", memberType: "member_expression", objField: "object", memberField: "property" },
    tsx: { callType: "call_expression", fnField: "function", memberType: "member_expression", objField: "object", memberField: "property" },
};

function extractCallTarget(expr, lang) {
    const spec = CALL_TARGET_SPECS[lang];
    const cur = spec ? unwrapAwaitExpr(expr) : null;
    if (!cur || cur.type !== spec.callType)
        return null;
    const fn = cur.childForFieldName(spec.fnField);
    if (fn?.type === "identifier")
        return { callee: fn.text };
    if (fn?.type !== spec.memberType)
        return null;
    const obj = fn.childForFieldName(spec.objField);
    const member = fn.childForFieldName(spec.memberField);
    return obj && member ? { callee: member.text, viaMember: true, receiver: obj.text } : null;
}

function lookupIntraReturnTypes(callTarget, classScope, returnTypes) {
    if (!callTarget || !returnTypes)
        return null;
    if (callTarget.viaMember && callTarget.receiver) {
        if ((callTarget.receiver === "self" || callTarget.receiver === "cls" || callTarget.receiver === "this") && classScope) {
            const clsLeaf = classScope.split(".").pop();
            const hit = returnTypes.get(`${clsLeaf}.${callTarget.callee}`);
            if (hit)
                return hit;
        }
        return returnTypes.get(`${callTarget.receiver}.${callTarget.callee}`) ?? null;
    }
    return !callTarget.viaMember ? (returnTypes.get(callTarget.callee) ?? null) : null;
}

function collectPyUnionParts(n, parts) {
    if (!n)
        return;
    if (n.type === "type") {
        collectPyUnionParts(n.namedChildren[0] ?? null, parts);
        return;
    }
    if (n.type === "binary_operator" || n.type === "union_type") {
        for (const c of n.namedChildren)
            collectPyUnionParts(c, parts);
        return;
    }
    if (n.type !== "none" && n.text !== "None")
        parts.push(n);
}

function pyGenericTypeName(node, aliases) {
    const base = node.namedChildren[0];
    const baseLeaf = base?.type === "attribute" ? base.childForFieldName("attribute")?.text : base?.text;
    const tp = (baseLeaf === "Optional" || baseLeaf === "Union")
        ? node.namedChildren.find((c) => c.type === "type_parameter")
        : null;
    if (!tp)
        return null;
    const nonNone = tp.namedChildren.filter((c) => c.type !== "none" && c.text.trim() !== "None");
    return nonNone.length === 1 ? pyTypeName(nonNone[0], aliases) : null;
}

function pyTypeName(node, aliases) {
    if (!node || node.type === "none" || node.text === "None")
        return null;
    if (node.type === "type")
        return pyTypeName(node.namedChildren[0] ?? null, aliases);
    if (node.type === "identifier")
        return resolveAlias(node.text, aliases);
    if (node.type === "attribute") {
        const attr = node.childForFieldName("attribute") ?? node.namedChildren.at(-1);
        return attr?.type === "identifier" ? resolveAlias(attr.text, aliases) : null;
    }
    if (node.type === "binary_operator" || node.type === "union_type") {
        const parts = [];
        collectPyUnionParts(node, parts);
        return parts.length === 1 ? pyTypeName(parts[0], aliases) : null;
    }
    if (node.type === "generic_type")
        return pyGenericTypeName(node, aliases);
    return null;
}
function callTypeName(node, aliases) {
    const rhs = unwrapAwaitExpr(node);
    if (rhs?.type !== "call")
        return null;
    const fn = rhs.childForFieldName("function");
    if (fn?.type !== "identifier" || !/^[A-Z]/.test(fn.text))
        return null;
    return aliases.get(fn.text) ?? fn.text;
}
/** Swift variable->type bindings from the confident, syntax-local clues:
 * a typed parameter (`func feed(animal: Animal)`, `init(keeper k: Keeper)` —
 * the LAST simple_identifier before the `:` is the local name, the first may be
 * an external argument label), a typed property (`var d: Doctor`), and an
 * initializer-call assignment (`let vet = Vet()` — an initializer call is an
 * ordinary call whose callee is the type's own UpperCamelCase name; Swift's
 * naming convention makes the case split reliable, the same way Go's `NewX`
 * convention is trusted in handleGo). A property directly inside a type body is
 * a field: bound at the type's scope, both bare (`repo.save()`) and
 * `self.`-prefixed (`self.repo.save()`), like Java's fields. */
function handleSwift(node, scopePath, classScope, bindings) {
    if (node.type === "parameter") {
        const ids = node.namedChildren.filter((c) => c.type === "simple_identifier");
        const name = ids.at(-1)?.text;
        const type = swiftTypeName(node.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type"));
        if (name && type)
            bindings.set(scopePath, name, type);
        return;
    }
    if (node.type !== "property_declaration")
        return;
    const name = node.namedChildren
        .find((c) => c.type === "pattern")
        ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name)
        return;
    const annotated = node.namedChildren
        .find((c) => c.type === "type_annotation")
        ?.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type");
    const type = swiftTypeName(annotated) ??
        swiftCtorTypeName(node.namedChildren.find((c) => c.type === "call_expression"));
    if (!type)
        return;
    const isField = node.parent?.type === "class_body" || node.parent?.type === "protocol_body";
    const target = isField ? (classScope ?? scopePath) : scopePath;
    bindings.set(target, name, type);
    if (isField)
        bindings.set(target, `self.${name}`, type);
}
/** A Swift type node's bare name: a `user_type`'s LAST type_identifier (so a
 * module-qualified `Foundation.Date` binds as `Date`, generic arguments live in
 * nested nodes and never leak in), unwrapping one level of optional (`Animal?`).
 * Collections, tuples, and function types bind nothing — no single confident
 * receiver type to name. */
function swiftTypeName(node) {
    if (!node)
        return null;
    if (node.type === "optional_type") {
        return swiftTypeName(node.namedChildren.find((c) => c.type === "user_type"));
    }
    if (node.type !== "user_type")
        return null;
    const ids = node.namedChildren.filter((c) => c.type === "type_identifier");
    return ids.at(-1)?.text ?? null;
}
/** The type constructed by an initializer call (`Vet()` → `Vet`), or null when
 * the callee isn't a bare UpperCamelCase name — a lowercase callee is an
 * ordinary function whose return type a single-file pass cannot know. */
function swiftCtorTypeName(call) {
    if (call?.type !== "call_expression")
        return null;
    const fn = call.namedChildren[0];
    if (fn?.type !== "simple_identifier")
        return null;
    return /^[A-Z]/.test(fn.text) ? fn.text : null;
}
/** PHP variable->type bindings from the two confident, syntax-local clues:
 * a type-hinted parameter (`function f(Foo $x)`) and a `new` assignment
 * (`$x = new Foo()`). Keyed by the `$var` text (with the `$`) so a
 * `$var->method()` call site resolves through resolveRecvType's bindings
 * lookup, exactly like Python's annotated params and Go's receiver. */
function handlePhp(node, scopePath, bindings) {
    if (node.type === "simple_parameter") {
        const type = phpTypeName(node.childForFieldName("type"));
        const name = node.childForFieldName("name");
        if (type && name?.type === "variable_name")
            bindings.set(scopePath, name.text, type);
        return;
    }
    if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "variable_name" && right?.type === "object_creation_expression") {
            const type = phpNewType(right);
            if (type)
                bindings.set(scopePath, left.text, type);
        }
    }
}
/** Closure name, shared with extract.js so the two scope stacks agree on the
 * segment a closure pushes. The right-hand-side check compares node `.id` rather
 * than `===` on wrappers: wrapper identity is not stable across traversals, so
 * `===` can spuriously fall through to `{closure}` and desync this scope segment. */
export function phpClosureName(node) {
    const parent = node.parent;
    if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
        const left = parent.childForFieldName("left");
        if (left?.type === "variable_name")
            return left.text.replace(/^\$/, "");
    }
    return "{closure}";
}
/** A PHP type hint's class name: unwrap `?T` (optional_type) and `named_type`,
 * de-qualify a namespaced name to its trailing segment. Null for primitives,
 * unions, and intersections (no single confident class to bind). */
function phpTypeName(node) {
    if (!node)
        return null;
    if (node.type === "named_type" || node.type === "optional_type") {
        return phpTypeName(node.namedChildren[0] ?? null);
    }
    if (node.type === "name")
        return node.text;
    if (node.type === "qualified_name")
        return node.text.replace(/^.*\\/, "");
    return null;
}
/** The class name of a `new Foo()` / `new App\Foo()`, de-qualified. */
function phpNewType(node) {
    const cls = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    return cls ? cls.text.replace(/^.*\\/, "") : null;
}
const TS_WRAPPER_GENERICS = new Set(["Promise", "Readonly", "Partial", "Required", "Awaited"]);
const TS_NULLABLE_PRIMITIVES = new Set(["null", "undefined", "void", "never"]);

function resolvePyAssignmentRhs(node, right, classScope, aliases, returnTypes) {
    const typeField = node.childForFieldName("type");
    if (typeField) {
        const explicit = pyTypeName(typeField, aliases);
        if (explicit)
            return { typeName: explicit, callTarget: null };
    }
    const callTarget = extractCallTarget(right, "python");
    const retHit = lookupIntraReturnTypes(callTarget, classScope, returnTypes)?.[0] ?? null;
    if (retHit)
        return { typeName: retHit, callTarget: null };
    const ctor = callTypeName(right, aliases);
    return ctor ? { typeName: ctor, callTarget: null } : { typeName: null, callTarget };
}
function handlePyAttrAssignment(node, left, right, scope, scopePath, classScope, bindings, aliases, returnTypes) {
    const obj = left.childForFieldName("object");
    const attr = left.childForFieldName("attribute");
    if (obj?.type !== "identifier" || (obj.text !== "self" && obj.text !== "cls") || !attr)
        return;
    const attrKey = `self.${attr.text}`;
    const targetScope = classScope ?? scopePath;
    const { typeName, callTarget } = resolvePyAssignmentRhs(node, right, classScope, aliases, returnTypes);
    const assignedVarType = !typeName && !callTarget && right?.type === "identifier"
        ? bindings.lookup(scope, right.text)
        : null;
    if (typeName || assignedVarType)
        bindings.set(targetScope, attrKey, typeName ?? assignedVarType);
    else if (callTarget)
        bindings.setFactory(targetScope, attrKey, callTarget);
}
function handlePy(node, scope, scopePath, classScope, bindings, aliases, returnTypes) {
    if (node.type === "typed_parameter" || node.type === "typed_default_parameter") {
        const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "identifier");
        const typeName = pyTypeName(node.childForFieldName("type"), aliases);
        if (nameNode && typeName)
            bindings.set(scopePath, nameNode.text, typeName);
        return;
    }
    if (node.type !== "assignment")
        return;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left)
        return;
    if (left.type === "identifier") {
        const { typeName, callTarget } = resolvePyAssignmentRhs(node, right, classScope, aliases, returnTypes);
        if (typeName)
            bindings.set(scopePath, left.text, typeName);
        else if (callTarget)
            bindings.setFactory(scopePath, left.text, callTarget);
        return;
    }
    if (left.type === "attribute")
        handlePyAttrAssignment(node, left, right, scope, scopePath, classScope, bindings, aliases, returnTypes);
}
function collectTsUnionNonNullParts(n, nonNull) {
    if (!n)
        return;
    if (n.type === "union_type" || n.type === "parenthesized_type") {
        for (const c of n.namedChildren)
            collectTsUnionNonNullParts(c, nonNull);
        return;
    }
    const txt = n.text.trim();
    if (n.type === "literal_type" && (txt === "null" || txt === "undefined"))
        return;
    if ((n.type === "predefined_type" || n.type === "null" || n.type === "undefined") && TS_NULLABLE_PRIMITIVES.has(txt))
        return;
    nonNull.push(n);
}
function tsGenericWrapperTypeName(t, aliases) {
    const base = t.childForFieldName("name");
    const baseName = base?.type === "nested_type_identifier"
        ? base.namedChildren.findLast((c) => c.type === "type_identifier")?.text
        : base?.text;
    if (!baseName || !TS_WRAPPER_GENERICS.has(baseName))
        return null;
    const firstArg = t.childForFieldName("type_arguments")?.namedChildren[0];
    return firstArg ? tsTypeNodeName(firstArg, aliases) : null;
}
function tsTypeNodeName(t, aliases) {
    if (!t)
        return null;
    if (t.type === "type_annotation" || t.type === "parenthesized_type")
        return tsTypeNodeName(t.namedChildren[0] ?? null, aliases);
    if (t.type === "type_identifier")
        return resolveAlias(t.text, aliases);
    if (t.type === "nested_type_identifier") {
        const tail = t.namedChildren.findLast((c) => c.type === "type_identifier");
        return tail ? resolveAlias(tail.text, aliases) : null;
    }
    if (t.type === "union_type") {
        const nonNull = [];
        collectTsUnionNonNullParts(t, nonNull);
        return nonNull.length === 1 ? tsTypeNodeName(nonNull[0], aliases) : null;
    }
    if (t.type === "generic_type")
        return tsGenericWrapperTypeName(t, aliases);
    return null;
}
function tsAnnotationTypeName(typeAnn, aliases) {
    if (!typeAnn || typeAnn.type !== "type_annotation")
        return null;
    return tsTypeNodeName(typeAnn.namedChildren[0] ?? null, aliases);
}
function tsNewTypeName(value, aliases) {
    const rhs = unwrapAwaitExpr(value);
    if (rhs?.type !== "new_expression")
        return null;
    const ctor = rhs.childForFieldName("constructor");
    if (ctor?.type !== "identifier")
        return null;
    return aliases.get(ctor.text) ?? ctor.text;
}
function bindTsValueOrField(targetScope, key, value, typeNode, classScope, bindings, aliases, returnTypes, annFirst) {
    const callTarget = extractCallTarget(value, "typescript");
    const retType = lookupIntraReturnTypes(callTarget, classScope, returnTypes)?.[0] ?? null;
    const newType = tsNewTypeName(value, aliases);
    const annType = tsAnnotationTypeName(typeNode, aliases);
    const typeName = (annFirst ? (annType ?? newType) : (newType ?? annType)) ?? retType;
    if (typeName)
        bindings.set(targetScope, key, typeName);
    else if (callTarget)
        bindings.setFactory(targetScope, key, callTarget);
}
function handleTsParameter(node, scopePath, classScope, bindings, aliases) {
    let pattern = node.childForFieldName("pattern");
    let defaultVal = node.childForFieldName("value");
    if (pattern?.type === "assignment_pattern") {
        defaultVal = defaultVal ?? pattern.childForFieldName("right");
        pattern = pattern.childForFieldName("left");
    }
    if (pattern?.type !== "identifier")
        return;
    const typeName = tsAnnotationTypeName(node.childForFieldName("type"), aliases) ?? tsNewTypeName(defaultVal, aliases);
    if (!typeName)
        return;
    bindings.set(scopePath, pattern.text, typeName);
    // A parameter PROPERTY (`constructor(private readonly svc: Svc){}`) is a parameter
    // AND a class field, so `this.svc` must resolve to its type — the default DI idiom
    // in NestJS/Angular.
    const isParamProperty = node.children.some((c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.type === "override_modifier");
    if (isParamProperty)
        bindings.set(classScope ?? scopePath, `this.${pattern.text}`, typeName);
}
function handleTs(node, scopePath, classScope, bindings, aliases, returnTypes) {
    if (node.type === "variable_declarator") {
        const value = node.childForFieldName("value");
        const name = value && FN_VALUE_TYPES.has(value.type) ? null : node.childForFieldName("name");
        if (name?.type === "identifier")
            bindTsValueOrField(scopePath, name.text, value, node.childForFieldName("type"), classScope, bindings, aliases, returnTypes, false);
        return;
    }
    if (node.type === "public_field_definition") {
        const name = node.childForFieldName("name");
        if (name)
            bindTsValueOrField(classScope ?? scopePath, `this.${name.text}`, node.childForFieldName("value"), node.childForFieldName("type"), classScope, bindings, aliases, returnTypes, true);
        return;
    }
    if (node.type === "required_parameter" || node.type === "optional_parameter")
        handleTsParameter(node, scopePath, classScope, bindings, aliases);
}
/**
 * Java bindings: locals, parameters, and fields.
 *
 * Fields are recorded twice: bare (`repo.save()`) and `self.`-prefixed
 * (`this.repo.save()`), since resolveRecvType normalizes `this.` to `self.`.
 */
function handleJavaSpreadOrCatchParam(node, scopePath, bindings) {
    const name = node.type === "spread_parameter"
        ? node.namedChildren.find((c) => c.type === "variable_declarator")?.childForFieldName("name")
        : node.childForFieldName("name");
    const typeNode = node.type === "spread_parameter"
        ? node.namedChildren.find((c) => c.type !== "variable_declarator")
        : node.namedChildren.find((c) => c.type === "catch_type")?.namedChildren.find((c) => c.type === "type_identifier" || c.type === "scoped_type_identifier" || c.type === "identifier");
    const type = javaTypeName(typeNode);
    if (type && name?.type === "identifier")
        bindings.set(scopePath, name.text, type);
}
function handleJavaDeclBindings(node, scopePath, classScope, bindings) {
    const isField = node.type === "field_declaration";
    const target = isField ? (classScope ?? scopePath) : scopePath;
    for (const d of node.namedChildren) {
        if (d.type !== "variable_declarator")
            continue;
        const name = d.childForFieldName("name");
        if (name?.type !== "identifier")
            continue;
        const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(d.childForFieldName("value"));
        if (!type)
            continue;
        bindings.set(target, name.text, type);
        if (isField)
            bindings.set(target, `self.${name.text}`, type);
    }
}
function handleJava(node, scopePath, classScope, bindings) {
    if (node.type === "formal_parameter" || node.type === "enhanced_for_statement") {
        const type = javaTypeName(node.childForFieldName("type"));
        const name = node.childForFieldName("name");
        if (type && name?.type === "identifier")
            bindings.set(scopePath, name.text, type);
        return;
    }
    if (node.type === "resource") {
        const name = node.childForFieldName("name");
        const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(node.childForFieldName("value"));
        if (type && name?.type === "identifier")
            bindings.set(scopePath, name.text, type);
        return;
    }
    if (node.type === "spread_parameter" || node.type === "catch_formal_parameter") {
        handleJavaSpreadOrCatchParam(node, scopePath, bindings);
        return;
    }
    if (node.type === "local_variable_declaration" || node.type === "field_declaration")
        handleJavaDeclBindings(node, scopePath, classScope, bindings);
}
/** A Java type node's bare name. `var` is the inferred-local keyword and states no
 * type, so it binds nothing. A generic binds to its erasure (`List<Order>` → `List`),
 * a qualified type to its final segment (`java.util.List` → `List`), and an array
 * to its element type (`Foo[]` → `Foo`). */
function javaTypeName(node) {
    if (!node)
        return null;
    if (node.type === "type_identifier")
        return node.text === "var" ? null : node.text;
    if (node.type === "generic_type") {
        const base = node.namedChildren[0];
        return base ? javaTypeName(base) : null;
    }
    if (node.type === "scoped_type_identifier") {
        return node.namedChildren.at(-1)?.text ?? null;
    }
    if (node.type === "array_type") {
        const el = node.childForFieldName("element") ?? node.namedChildren.find((c) => c.type !== "dimensions");
        return el ? javaTypeName(el) : null;
    }
    return null;
}
/** The type constructed by a `new X(...)` expression, or null when the value is
 * not an `object_creation_expression` (or the constructed type isn't a bare
 * `type_identifier`/`scoped_type_identifier`/`generic_type`). Used as the
 * fallback for a `var`-typed or untyped local/field/resource whose initializer
 * is a construction — the one shape a single-file pass can infer with no
 * return-type analysis. */
function javaNewTypeName(value) {
    if (value?.type !== "object_creation_expression")
        return null;
    return javaTypeName(value.childForFieldName("type"));
}
function goTypeName(typeNode) {
    if (!typeNode)
        return null;
    if (typeNode.type === "pointer_type")
        return goTypeName(typeNode.namedChildren.at(-1) ?? null);
    if (typeNode.type === "parenthesized_type")
        return goTypeName(typeNode.namedChildren[0] ?? null);
    if (typeNode.type === "type_identifier")
        return typeNode.text;
    if (typeNode.type === "qualified_type")
        return typeNode.childForFieldName("name")?.text ?? null;
    return null;
}

function goReturnTypeNames(resultNode) {
    if (!resultNode)
        return [];
    if (resultNode.type === "parameter_list") {
        const out = [];
        for (const p of resultNode.namedChildren) {
            if (p.type !== "parameter_declaration")
                continue;
            const nameCount = Math.max(1, p.namedChildren.filter((c) => c.type === "identifier").length);
            const t = goTypeName(p.childForFieldName("type") ?? p.namedChildren.at(-1) ?? null);
            for (let i = 0; i < nameCount; i++)
                out.push(t);
        }
        return out;
    }
    return [goTypeName(resultNode)];
}

function bindGoNamedIds(node, scopePath, typeName, bindings) {
    const nameNodes = node.childrenForFieldName("name");
    const ids = nameNodes.length > 0 ? nameNodes : node.namedChildren.filter((c) => c.type === "identifier");
    for (const id of ids) {
        if (id.type === "identifier")
            bindings.set(scopePath, id.text, typeName);
    }
}
function bindGoMultiReturnCall(names, callExpr, scopePath, bindings, returnTypes) {
    const callTarget = extractCallTarget(callExpr, "go");
    const retList = lookupIntraReturnTypes(callTarget, null, returnTypes);
    for (let i = 0; i < names.length; i++) {
        const nameNode = names[i];
        if (!nameNode || nameNode.type !== "identifier" || nameNode.text === "_")
            continue;
        const retType = retList?.[i];
        if (retType && retType !== "error")
            bindings.set(scopePath, nameNode.text, retType);
        else if (i === 0 && callTarget)
            bindings.setFactory(scopePath, nameNode.text, callTarget);
    }
}
function bindGoShortVarExpr(nameNode, rawExpr, scopePath, bindings, returnTypes) {
    if (!nameNode || nameNode.type !== "identifier" || nameNode.text === "_" || !rawExpr)
        return;
    const expr = rawExpr.type === "unary_expression"
        ? (rawExpr.namedChildren.find((c) => c.type === "composite_literal") ?? rawExpr)
        : rawExpr;
    let typeName = null;
    if (expr.type === "composite_literal") {
        typeName = goTypeName(expr.childForFieldName("type"));
    }
    else if (expr.type === "call_expression") {
        const callTarget = extractCallTarget(expr, "go");
        typeName = lookupIntraReturnTypes(callTarget, null, returnTypes)?.[0] ?? null;
        if (!typeName) {
            const fn = expr.childForFieldName("function");
            // Go convention: NewX(...) binds to X, while recording factoryCall so
            // cross-file NewStore() returning an interface can upgrade X via returnType.
            if (fn?.type === "identifier" && /^New[A-Z]/.test(fn.text))
                typeName = fn.text.slice(3);
            if (callTarget)
                bindings.setFactory(scopePath, nameNode.text, callTarget, true);
        }
    }
    if (typeName)
        bindings.set(scopePath, nameNode.text, typeName);
}
function handleGo(node, scopePath, bindings, returnTypes) {
    if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration") {
        const typeNode = node.childForFieldName("type") ?? node.namedChildren.find((c) => c.type !== "identifier");
        const typeName = goTypeName(typeNode);
        if (typeName)
            bindGoNamedIds(node, scopePath, typeName, bindings);
        return;
    }
    if (node.type === "var_spec") {
        const typeName = goTypeName(node.childForFieldName("type"));
        if (typeName)
            bindGoNamedIds(node, scopePath, typeName, bindings);
        return;
    }
    if (node.type !== "short_var_declaration")
        return;
    const names = node.childForFieldName("left")?.namedChildren;
    const exprs = node.childForFieldName("right")?.namedChildren;
    if (!names || !exprs)
        return;
    if (exprs.length === 1 && names.length > 1 && exprs[0]?.type === "call_expression") {
        bindGoMultiReturnCall(names, exprs[0], scopePath, bindings, returnTypes);
        return;
    }
    for (let i = 0; i < names.length; i++)
        bindGoShortVarExpr(names[i], exprs[i], scopePath, bindings, returnTypes);
}
