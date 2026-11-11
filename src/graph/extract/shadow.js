/**
 * Multi-language & destructuring-aware import-shadowing filter for function/method scopes.
 */

const FUNCTION_BOUNDARY_TYPES = new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
    "function_definition",
    "lambda",
    "class_definition",
    "func_literal",
    "function_item",
    "closure_expression",
]);

/** Compare tree-sitter syntax node identity across weakly-cached wrapper instances. */
export function sameSyntaxNode(a, b) {
    return !!a && !!b && a.tree === b.tree && a.id === b.id;
}

/** True when `node` starts a nested callable/class scope with its own bindings. */
export function isFunctionBoundary(node) {
    return Boolean(node && FUNCTION_BOUNDARY_TYPES.has(node.type));
}

function collectJsBindingPattern(pat, shadowed) {
    if (!pat)
        return;
    switch (pat.type) {
        case "identifier":
        case "shorthand_property_identifier_pattern":
        case "shorthand_property_identifier":
            shadowed.add(pat.text);
            return;
        case "assignment_pattern":
        case "object_assignment_pattern":
            collectJsBindingPattern(pat.childForFieldName("left") ?? pat.namedChildren[0], shadowed);
            return;
        case "pair_pattern":
            collectJsBindingPattern(pat.childForFieldName("value"), shadowed);
            return;
        case "object_pattern":
        case "array_pattern":
        case "rest_pattern":
            for (const child of pat.namedChildren)
                collectJsBindingPattern(child, shadowed);
            return;
        default:
            return;
    }
}

function collectPythonTargetIds(target, shadowed) {
    if (!target)
        return;
    if (target.type === "identifier") {
        shadowed.add(target.text);
        return;
    }
    if (
        target.type === "pattern_list" ||
        target.type === "tuple_pattern" ||
        target.type === "list_pattern" ||
        target.type === "parenthesized_expression" ||
        target.type === "list_splat_pattern" ||
        target.type === "dictionary_splat_pattern"
    ) {
        for (const child of target.namedChildren)
            collectPythonTargetIds(child, shadowed);
    }
}

function collectPythonParameterNode(paramNode, shadowed) {
    if (paramNode.type === "default_parameter" || paramNode.type === "typed_default_parameter") {
        collectPythonTargetIds(paramNode.childForFieldName("name"), shadowed);
        return;
    }
    if (paramNode.type === "typed_parameter") {
        const typeNode = paramNode.childForFieldName("type");
        for (const child of paramNode.namedChildren) {
            if (!sameSyntaxNode(child, typeNode) && child.type !== "type")
                collectPythonTargetIds(child, shadowed);
        }
        return;
    }
    collectPythonTargetIds(paramNode, shadowed);
}

function collectGoDeclIdentifiers(declNode, shadowed) {
    const typeNode = declNode.childForFieldName("type");
    const valueNode = declNode.childForFieldName("value");
    for (const child of declNode.namedChildren) {
        if (sameSyntaxNode(child, typeNode) || sameSyntaxNode(child, valueNode))
            continue;
        if (child.type === "identifier" && child.text !== "_")
            shadowed.add(child.text);
    }
}

function collectGoLhsIdentifiers(lhs, shadowed) {
    if (!lhs)
        return;
    if (lhs.type === "identifier") {
        if (lhs.text !== "_")
            shadowed.add(lhs.text);
        return;
    }
    if (lhs.type === "expression_list") {
        for (const child of lhs.namedChildren) {
            if (child.type === "identifier" && child.text !== "_")
                shadowed.add(child.text);
        }
    }
}

function collectRustPatternIds(pat, shadowed) {
    if (!pat)
        return;
    if (pat.type === "identifier" || pat.type === "shorthand_field_identifier") {
        if (pat.text !== "_")
            shadowed.add(pat.text);
        return;
    }
    if (pat.type === "field_pattern") {
        const subPat = pat.childForFieldName("pattern");
        if (subPat)
            collectRustPatternIds(subPat, shadowed);
        else {
            const shortId = pat.namedChildren.find((c) => c.type === "shorthand_field_identifier");
            if (shortId)
                shadowed.add(shortId.text);
        }
        return;
    }
    const typeNode = pat.childForFieldName?.("type");
    for (const child of pat.namedChildren ?? []) {
        if (sameSyntaxNode(child, typeNode) || child.type === "mutable_specifier")
            continue;
        collectRustPatternIds(child, shadowed);
    }
}

function collectPythonOrGoShadowed(node, lang, shadowed) {
    if (lang === "python") {
        if (node.type === "parameters") {
            for (const p of node.namedChildren)
                collectPythonParameterNode(p, shadowed);
        }
        else if (node.type === "assignment" || node.type === "for_statement") {
            collectPythonTargetIds(node.childForFieldName("left"), shadowed);
        }
        return;
    }
    if (node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration" || node.type === "var_spec") {
        collectGoDeclIdentifiers(node, shadowed);
    }
    else if (node.type === "short_var_declaration" || node.type === "range_clause") {
        collectGoLhsIdentifiers(node.childForFieldName("left"), shadowed);
    }
}

const CALLABLE_INIT_TYPES = new Set([
    "arrow_function",
    "function_expression",
    "function",
    "generator_function",
]);

function collectJsOrRustShadowed(node, lang, shadowed, nonCallableShadowed, isRequireDeclarator) {
    if (lang === "rust") {
        if (node.type === "parameter" || node.type === "let_declaration" || node.type === "for_expression") {
            const pat = node.childForFieldName("pattern");
            collectRustPatternIds(pat, shadowed);
            collectRustPatternIds(pat, nonCallableShadowed);
        }
        return;
    }
    if (node.type === "variable_declarator" && (!isRequireDeclarator || !isRequireDeclarator(node))) {
        const namePat = node.childForFieldName("name");
        const valType = node.childForFieldName("value")?.type;
        collectJsBindingPattern(namePat, shadowed);
        if (!CALLABLE_INIT_TYPES.has(valType))
            collectJsBindingPattern(namePat, nonCallableShadowed);
    }
    else if (node.type === "required_parameter" || node.type === "optional_parameter" || node.type === "rest_parameter") {
        const pat = node.childForFieldName("pattern") ?? node.namedChildren[0];
        collectJsBindingPattern(pat, shadowed);
        collectJsBindingPattern(pat, nonCallableShadowed);
    }
    else if (node.parent?.type === "formal_parameters") {
        collectJsBindingPattern(node, shadowed);
        collectJsBindingPattern(node, nonCallableShadowed);
    }
    else if (node.type === "arrow_function") {
        const singleParam = node.childForFieldName("parameter");
        if (singleParam?.type === "identifier") {
            shadowed.add(singleParam.text);
            nonCallableShadowed.add(singleParam.text);
        }
    }
}

function inferShadowLanguage(definition) {
    const t = definition?.type;
    if (t === "function_definition")
        return "python";
    if (t === "method_declaration")
        return "go";
    if (t === "function_item")
        return "rust";
    return "typescript";
}

/** Collect all shadowed names and non-callable parameter/variable bindings in `definition`. */
export function collectShadowedLocals(definition, langOrIsRequire, maybeIsRequire) {
    const shadowed = new Set();
    const nonCallableShadowed = new Set();
    if (!definition)
        return { shadowed, nonCallableShadowed };
    const lang = typeof langOrIsRequire === "string" ? langOrIsRequire : inferShadowLanguage(definition);
    const isRequireDeclarator = typeof langOrIsRequire === "function" ? langOrIsRequire : maybeIsRequire;
    const definitionValue = definition.childForFieldName("value") ?? definition.childForFieldName("right");

    const visitShadowed = (node) => {
        if (!sameSyntaxNode(node, definition) && !sameSyntaxNode(node, definitionValue) && isFunctionBoundary(node)) {
            const name = node.childForFieldName("name");
            if (name?.type === "identifier")
                shadowed.add(name.text);
            return;
        }
        if (lang === "python" || lang === "go") {
            collectPythonOrGoShadowed(node, lang, shadowed);
            collectPythonOrGoShadowed(node, lang, nonCallableShadowed);
        }
        else {
            collectJsOrRustShadowed(node, lang, shadowed, nonCallableShadowed, isRequireDeclarator);
        }

        for (const child of node.namedChildren)
            visitShadowed(child);
    };

    visitShadowed(definition);
    return { shadowed, nonCallableShadowed };
}
