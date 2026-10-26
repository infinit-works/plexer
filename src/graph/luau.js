/**
 * Luau depth-equivalent extractor & module-aware edge resolver for plexer.
 */
import { join, posix, resolve } from "node:path";
import { spanRange } from "../util/span.js";
import {
    KIND,
    contentHash,
    defScope,
    enclosingDef,
    extractLeadingSummary,
    fileResidual,
    matchLuauSymbol,
    mintId,
    moduleStem,
    searchBody,
    stripNodeOrdinals,
} from "../util/id.js";
import { pushMap } from "../util/paths.js";
import { readJson } from "../util/state.js";

export { matchLuauSymbol, moduleStem };

const PARSE_CHUNK = 16384;
const LUAU_PARSERS = new WeakMap();

const LUAU_STDLIB_TABLES = new Set([
    "table", "string", "math", "bit32", "buffer", "task", "coroutine", "utf8", "os", "debug",
    "Instance", "Vector2", "Vector3", "Vector2int16", "Vector3int16", "CFrame", "Color3", "BrickColor",
    "UDim", "UDim2", "Rect", "Region3", "Region3int16", "Ray", "NumberRange", "NumberSequence",
    "NumberSequenceKeypoint", "ColorSequence", "ColorSequenceKeypoint", "PhysicalProperties",
    "OverlapParams", "RaycastParams", "TweenInfo", "DateTime", "Random", "Axes", "Faces",
    "Font", "SharedTable", "CatalogSearchParams", "DockWidgetPluginGuiInfo", "PathWaypoint",
    "Enum", "game", "workspace", "script", "plugin",
]);

const LUAU_GLOBAL_BUILTINS = new Set([
    "assert", "error", "getfenv", "getmetatable", "ipairs", "loadstring", "newproxy", "next",
    "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select",
    "setfenv", "setmetatable", "tonumber", "tostring", "type", "typeof", "unpack", "warn", "xpcall",
    "gcinfo", "collectgarbage", "delay", "elapsedTime", "spawn", "tick", "time", "version", "wait",
]);

const HIGHER_ORDER_DEF_WRAPPERS = new Set(["debounce", "throttle", "compute", "memoize", "wrap"]);

function stripBalancedTypeof(src) {
    const re = /(::|[:|&<,={(]|->)\s*typeof\s*\(/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
        const start = m.index + m[1].length;
        let i = re.lastIndex;
        let depth = 1;
        while (i < src.length && depth > 0) {
            const ch = src[i];
            if (ch === '"' || ch === "'" || ch === "`") {
                const quote = ch;
                i++;
                while (i < src.length && src[i] !== quote && src[i] !== "\n") {
                    if (src[i] === "\\")
                        i++;
                    i++;
                }
                if (i < src.length && src[i] === quote)
                    i++;
                continue;
            }
            if (ch === "-" && src[i + 1] === "-") {
                i += 2;
                while (i < src.length && src[i] !== "\n")
                    i++;
                continue;
            }
            if (ch === "(")
                depth++;
            else if (ch === ")")
                depth--;
            i++;
        }
        if (depth === 0) {
            const inner = src.slice(start, i);
            const newlines = (inner.match(/\n/g) || []).join("");
            out += src.slice(last, start) + " any" + newlines;
            last = i;
            re.lastIndex = i;
        }
    }
    return out + src.slice(last);
}

function stripTypeParamDefaults(inner) {
    let out = "";
    let i = 0;
    while (i < inner.length) {
        if (inner[i] === "=") {
            i++;
            let depth = 0;
            while (i < inner.length) {
                const ch = inner[i];
                if (ch === "{" || ch === "(" || ch === "<")
                    depth++;
                else if (ch === "}" || ch === ")" || ch === ">") {
                    if (depth === 0)
                        break;
                    depth--;
                }
                else if (ch === "," && depth === 0) {
                    break;
                }
                i++;
            }
        }
        else {
            out += inner[i++];
        }
    }
    return out;
}

/**
 * Extract `require("...")` and `fieldName: typeof(require("..."))` inside `typeof(...)`
 * type annotations before `stripBalancedTypeof` replaces them with `any`.
 */
function extractTypeofRequires(rawSource) {
    const results = [];
    const re = /(?:([A-Za-z_]\w*)\s*:\s*)?typeof\s*\(\s*require\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
    let m;
    while ((m = re.exec(rawSource)) !== null) {
        results.push({ field: m[1] || null, spec: m[2].trim() });
    }
    return results;
}

/**
 * Line-preserving pre-parse normalizer so tree-sitter-luau 1.2.0 (2023) parses
 * 2024-2026 Luau constructs without collapsing files into ERROR nodes.
 * Preserves exact line numbers (`startPosition.row` / `endPosition.row`).
 */
export function normalizeLuauForParse(src) {
    return stripBalancedTypeof(src)
        // 1. Luau 2024+ `export type function` / `type function` -> `local function`
        .replace(/^(\s*)(?:export\s+)?type\s+function\b/gm, "$1local function")
        // 2. Ambient `.d.luau` `declare function` / `declare x:`
        .replace(/^(\s*)declare\s+function\s+([A-Za-z_]\w*)\s*(\([^)\n]*\))(?:\s*:\s*[^\n]+)?/gm, "$1local function $2$3 end")
        .replace(/^(\s*)declare\s+([A-Za-z_]\w*)\s*:\s*([^\n]+)/gm, "$1local $2: $3")
        // 3. Luau `@native` / `@checked` / `@deprecated` attributes (including same-line `@native function`)
        .replace(/^(\s*)@[A-Za-z_]\w*(?:\s*\([^)\n]*\))?[ \t]*/gm, "$1")
        // 4. Luau `read` / `write` table property modifier (start of line or after `{`, `;`, `,`, `|`)
        .replace(/(^\s*|[{;,|]\s*)(?:read|write)\s+(?=[A-Za-z_\[])/gm, "$1")
        // 5. Generic type parameter defaults on `type Foo<T = ...> =` header lines
        .replace(/^(\s*(?:export\s+)?type\s+[A-Za-z_]\w*\s*<)([^\n]+)(>\s*=)/gm, (_, pre, inner, post) =>
            pre + stripTypeParamDefaults(inner) + post
        )
        // 6. Generic function type on a table field, type alias, or parenthesized union (`foo: <T>(...) -> ...`)
        .replace(/([:=|&(]\s*)<[^>\n]+>(?=\s*\()/g, "$1")
        // 7. Anonymous generic function expression (`function<T>(...)` -> `function(...)`)
        .replace(/\bfunction\s*<[^>\n]+>(?=\s*\()/g, "function")
        // 8. Explicit generic call instantiation (`foo<<string>>(` or `foo<<A, B<C>>>(` -> `foo(`)
        .replace(/<<[^\r\n>]+(?:>[^\r\n>]+)*>>(?=\s*[\(\{"'`])/g, "")
        // 9. String literal singleton types inside generic type arguments (`Props<"Frame", ...>` -> `Props<string, ...>`)
        .replace(/(\b[A-Za-z_]\w*<[A-Za-z0-9_.,\s]*)"[^"\n]*"/g, "$1string")
        // 10. Generic type packs `<A..., R...>` or `<T...>` on functions/types
        .replace(/<([^>\n]*\.\.\.[^>\n]*)>/g, "")
        // 11. Variadic type pack return/param `(A...) -> R...`, `): R...`, `-> ...any`
        .replace(/\(\s*[A-Za-z_]\w*\.\.\.\s*\)/g, "(...any)")
        .replace(/(->|\)\s*:)\s*(?:[A-Za-z_]\w*\.\.\.|\.\.\.\s*[A-Za-z_]\w*)/g, "$1 any")
        .replace(/\.\.\.\s*:\s*[A-Za-z_]\w*\.\.\./g, "...: any")
        // 12. Mixed unnamed/named parameter in function type `(T, T: any) -> boolean`
        .replace(/\(\s*([A-Za-z_]\w*)\s*,\s*\1\s*:\s*any\s*\)/g, "($1, $1)")
        // 13. Trailing comma in `for _, in expr do`
        .replace(/\bfor\s+([A-Za-z_]\w*)\s*,\s+in\b/g, "for $1 in")
        // 14. Builtin/reserved type keywords used as field/param names (`thread:`, `type:`, etc.)
        .replace(/\b(thread|number|string|boolean|type|export|typeof)(\s*:\s*(?![=]))/g, "$1_$2")
        // 15. Nested generic closing `>>` -> `> >` (repeat twice for `>>>`)
        .replace(/>>(?![=>])/g, "> >")
        .replace(/>>(?![=>])/g, "> >");
}

function isChunkReturnedFunction(fnNode) {
    if (!fnNode || fnNode.type !== "function_definition")
        return false;
    const p1 = fnNode.parent;
    const p2 = p1?.parent;
    const p3 = p2?.parent;
    return p1?.type === "expression_list" && p2?.type === "return_statement" && p3?.type === "chunk";
}

function isInsideNestedFunction(node) {
    let p = node.parent;
    while (p) {
        if (p.type === "function_declaration")
            return true;
        if (p.type === "function_definition" && !isChunkReturnedFunction(p))
            return true;
        p = p.parent;
    }
    return false;
}

function isInsideChunkReturnedFunction(node) {
    let p = node.parent;
    while (p) {
        if (isChunkReturnedFunction(p))
            return true;
        p = p.parent;
    }
    return false;
}

function unwrapExpr(node) {
    let cur = node;
    while (cur && (cur.type === "parenthesized_expression" || cur.type === "cast_expression")) {
        cur = cur.namedChild(0);
    }
    return cur;
}

function extractStringLiteral(node) {
    const n = unwrapExpr(node);
    if (!n)
        return null;
    if (n.type === "string") {
        const content = n.namedChildren?.find((c) => c.type === "string_content") ?? n.child?.(1);
        return content?.text?.trim() || null;
    }
    if (n.type === "arguments") {
        return extractStringLiteral(n.namedChild(0));
    }
    return null;
}

function extractAccessChain(node) {
    const cur0 = unwrapExpr(node);
    if (!cur0)
        return null;
    const parts = [];
    let cur = cur0;
    while (cur) {
        cur = unwrapExpr(cur);
        if (!cur)
            return null;
        if (cur.type === "identifier") {
            parts.push(cur.text);
            return parts.reverse();
        }
        if (cur.type === "dot_index_expression") {
            const f = cur.childForFieldName("field");
            if (!f)
                return null;
            parts.push(f.text);
            cur = cur.childForFieldName("table");
            continue;
        }
        if (cur.type === "method_index_expression") {
            const m = cur.childForFieldName("method");
            if (!m)
                return null;
            parts.push(m.text);
            cur = cur.childForFieldName("table");
            continue;
        }
        return null;
    }
    return null;
}

function applyPathStep(basePath, step) {
    if (!basePath || !step)
        return null;
    const parts = [...basePath.parts];
    let parents = basePath.parents;
    for (const seg of step.split("/").filter(Boolean)) {
        if (seg === "Parent" || seg === "..") {
            if (parts.length > 0)
                parts.pop();
            else
                parents++;
        }
        else if (seg !== ".") {
            parts.push(seg);
        }
    }
    return { base: basePath.base, parents, parts };
}

function evalInstancePath(rawNode, instancePaths, isBarrelTarget) {
    const node = unwrapExpr(rawNode);
    if (!node)
        return null;
    if (node.type === "binary_expression") {
        return evalInstancePath(node.namedChild(1), instancePaths, isBarrelTarget) ?? evalInstancePath(node.namedChild(0), instancePaths, isBarrelTarget);
    }
    if (node.type === "identifier") {
        if (node.text === "script")
            return { base: "script", parents: 0, parts: [] };
        if (instancePaths?.has(node.text)) {
            const b = instancePaths.get(node.text);
            return { base: b.base, parents: b.parents, parts: [...b.parts] };
        }
        return null;
    }
    if (node.type === "dot_index_expression") {
        const fullChain = extractAccessChain(node);
        if (fullChain && instancePaths?.has(fullChain.join("."))) {
            const b = instancePaths.get(fullChain.join("."));
            return { base: b.base, parents: b.parents, parts: [...b.parts] };
        }
        const tbl = node.childForFieldName("table");
        const fld = node.childForFieldName("field");
        if (!tbl || !fld)
            return null;
        const tblChain = extractAccessChain(tbl);
        if (tblChain && isBarrelTarget && (isBarrelTarget(tblChain[tblChain.length - 1]) || isBarrelTarget(tblChain[0]))) {
            if (fld.text === "script")
                return { base: "root", parents: 0, parts: [] };
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(fld.text))
                return { base: "root", parents: 0, parts: [fld.text] };
        }
        const basePath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
        return basePath ? applyPathStep(basePath, fld.text) : null;
    }
    if (node.type === "bracket_index_expression") {
        const tbl = node.childForFieldName("table") ?? node.namedChild(0);
        const idx = node.childForFieldName("field") ?? node.namedChild(1);
        const key = extractStringLiteral(idx);
        const basePath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
        return basePath && key ? applyPathStep(basePath, key) : null;
    }
    if (node.type === "function_call") {
        const callee = node.childForFieldName("name");
        const args = node.childForFieldName("arguments");
        if (callee?.type === "method_index_expression") {
            const tbl = callee.childForFieldName("table");
            const mth = callee.childForFieldName("method")?.text;
            if (mth === "WaitForChild" || mth === "FindFirstChild") {
                const childName = extractStringLiteral(args);
                const basePath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
                return basePath && childName ? applyPathStep(basePath, childName) : null;
            }
            if (mth === "Clone") {
                return evalInstancePath(tbl, instancePaths, isBarrelTarget);
            }
        }
    }
    return null;
}

function instancePathToSpec(p) {
    if (!p)
        return null;
    if (p.base === "root") {
        return p.parts.length > 0 ? `@root/${p.parts.join("/")}` : "@root";
    }
    if (p.parents === 0) {
        return p.parts.length > 0 ? `@self/${p.parts.join("/")}` : "@self";
    }
    if (p.parents === 1) {
        return p.parts.length > 0 ? `./${p.parts.join("/")}` : ".";
    }
    const up = "../".repeat(p.parents - 1);
    return p.parts.length > 0 ? `${up}${p.parts.join("/")}` : up.replace(/\/$/, "");
}

function parseRequireSpec(argNode, instancePaths, isBarrelTarget) {
    const n = unwrapExpr(argNode);
    if (!n)
        return null;
    const str = extractStringLiteral(n);
    if (str)
        return str;
    const instPath = evalInstancePath(n, instancePaths, isBarrelTarget);
    if (instPath)
        return instancePathToSpec(instPath);
    return null;
}

function extractRequireSpec(rawNode, instancePaths, isBarrelTarget) {
    const node = unwrapExpr(rawNode);
    if (!node || node.type !== "function_call")
        return null;
    const fn = unwrapExpr(node.childForFieldName("name"));
    if (!fn || fn.type !== "identifier" || fn.text !== "require")
        return null;
    const args = node.childForFieldName("arguments");
    if (!args)
        return null;
    return parseRequireSpec(args.namedChild(0), instancePaths, isBarrelTarget);
}

function tableSiblingName(fieldNode) {
    const tbl = fieldNode.parent;
    if (!tbl || tbl.type !== "table_constructor")
        return null;
    for (let i = 0; i < tbl.namedChildCount; i++) {
        const f = tbl.namedChild(i);
        if (f?.type !== "field")
            continue;
        const k = f.childForFieldName("name");
        const v = f.childForFieldName("value");
        if ((k?.text === "name" || k?.text === "Name" || k?.text === "id" || k?.text === "Id") && v?.type === "string") {
            const txt = extractStringLiteral(v);
            if (txt && /^[A-Za-z_][\w-]*$/.test(txt))
                return { prefix: txt, exported: !isInsideNestedFunction(fieldNode) };
        }
    }
    return null;
}

function enclosingTableContext(fieldNode, isPrimaryTable) {
    const sib = tableSiblingName(fieldNode);
    if (sib) {
        return { prefix: sib.prefix, exported: sib.exported };
    }
    const tbl = fieldNode.parent;
    if (!tbl || tbl.type !== "table_constructor")
        return null;
    const p1 = tbl.parent;
    const p2 = p1?.parent;
    if (p1?.type === "arguments" && p2?.type === "function_call") {
        const firstStr = extractStringLiteral(p1.namedChild(0));
        if (firstStr && /^[A-Za-z_][\w-]*$/.test(firstStr)) {
            return { prefix: firstStr, exported: true };
        }
    }
    if (p1?.type === "expression_list" && p2?.type === "assignment_statement") {
        const vars = p2.namedChild(0);
        const idx = p1.namedChildren.findIndex((c) => c.id === tbl.id);
        const lhs = vars?.namedChild(idx >= 0 ? idx : 0);
        const chain = extractAccessChain(lhs);
        if (chain && chain.length >= 1) {
            const varName = chain[chain.length - 1];
            if (chain.length === 1 && isPrimaryTable(varName)) {
                return { prefix: null, exported: true };
            }
            const prefix = chain.length > 1 && isPrimaryTable(chain[0])
                ? chain.slice(1).join(".")
                : chain.join(".");
            return { prefix, exported: !isInsideNestedFunction(p2) };
        }
    }
    return null;
}

function unwrapFunctionDef(rawNode) {
    const n = unwrapExpr(rawNode);
    if (!n)
        return null;
    if (n.type === "function_definition")
        return n;
    if (n.type === "function_call") {
        const chain = extractAccessChain(n.childForFieldName("name"));
        const last = chain ? chain[chain.length - 1] : null;
        if (last && HIGHER_ORDER_DEF_WRAPPERS.has(last)) {
            const args = n.childForFieldName("arguments");
            if (args && args.namedChildCount > 0) {
                const lastArg = unwrapExpr(args.namedChild(args.namedChildCount - 1));
                if (lastArg?.type === "function_definition")
                    return lastArg;
            }
        }
    }
    return null;
}

function findReturnedTableName(rootNode) {
    for (let i = rootNode.namedChildCount - 1; i >= 0; i--) {
        const child = rootNode.namedChild(i);
        if (child?.type === "return_statement") {
            let expr = unwrapExpr(child.namedChild(0)?.namedChild(0));
            if (expr?.type === "identifier")
                return expr.text;
            if (expr?.type === "function_call") {
                const args = expr.childForFieldName("arguments");
                const firstArg = unwrapExpr(args?.namedChild(0));
                if (firstArg?.type === "identifier")
                    return firstArg.text;
            }
        }
    }
    return null;
}

function extractParamNames(paramsNode) {
    const out = [];
    if (!paramsNode)
        return out;
    for (let i = 0; i < paramsNode.namedChildCount; i++) {
        const p = paramsNode.namedChild(i);
        if (!p)
            continue;
        if (p.type === "identifier") {
            out.push(p.text);
        }
        else if (p.type === "parameter") {
            const nameNode = p.childForFieldName("name") ?? p.namedChildren?.find((c) => c.type === "identifier");
            if (nameNode?.text)
                out.push(nameNode.text);
        }
    }
    return out;
}

function findChunkReturnedFunctionParam(rootNode) {
    for (let i = rootNode.namedChildCount - 1; i >= 0; i--) {
        const child = rootNode.namedChild(i);
        if (child?.type === "return_statement") {
            const expr = unwrapExpr(child.namedChild(0)?.namedChild(0));
            if (expr?.type === "function_definition") {
                const params = expr.childForFieldName("parameters") ?? expr.namedChildren?.find((c) => c.type === "parameters");
                return extractParamNames(params)[0] ?? null;
            }
        }
    }
    return null;
}

function exprContainsRequire(rawNode) {
    const n = unwrapExpr(rawNode);
    if (!n)
        return false;
    if (n.type === "function_call") {
        const fn = unwrapExpr(n.childForFieldName("name"));
        if (fn?.type === "identifier" && fn.text === "require")
            return true;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
        if (exprContainsRequire(n.namedChild(i)))
            return true;
    }
    return false;
}

function parseLuauSyntaxTree(normSource, entry, tsMod) {
    try {
        let parser = LUAU_PARSERS.get(entry.language);
        if (!parser) {
            parser = new tsMod.Parser();
            parser.setLanguage(entry.language);
            LUAU_PARSERS.set(entry.language, parser);
        }
        return parser.parse((i) => normSource.slice(i, i + PARSE_CHUNK));
    }
    catch (err) {
        throw new Error(`luau grammar threw: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function prescanLuauNode(n, candidateTables, rootImportedTables, augmentedTables, paramNames) {
    if (n.type === "parameters") {
        for (const p of extractParamNames(n))
            paramNames.add(p);
    }
    if (n.type === "assignment_statement" && !isInsideNestedFunction(n)) {
        const vars = n.namedChild(0);
        const exprs = n.namedChild(1);
        if (vars?.type === "variable_list" && exprs?.type === "expression_list") {
            const count = Math.min(vars.namedChildCount, exprs.namedChildCount);
            for (let i = 0; i < count; i++) {
                const lhs = vars.namedChild(i);
                const rhs = unwrapExpr(exprs.namedChild(i));
                if (!lhs || !rhs)
                    continue;
                if (lhs.type === "identifier") {
                    if (exprContainsRequire(rhs)) {
                        candidateTables.add(lhs.text);
                        rootImportedTables.add(lhs.text);
                    }
                    else if (rhs.type === "dot_index_expression") {
                        const rChain = extractAccessChain(rhs);
                        if (rChain && rChain.length >= 2 && candidateTables.has(rChain[0])) {
                            candidateTables.add(lhs.text);
                        }
                    }
                }
                else {
                    const lChain = extractAccessChain(lhs);
                    if (lChain && lChain.length >= 2 && candidateTables.has(lChain[0])) {
                        augmentedTables.add(lChain[0]);
                    }
                }
            }
        }
    }
    if (n.type === "function_declaration") {
        const chain = extractAccessChain(n.childForFieldName("name"));
        if (chain && chain.length >= 2 && candidateTables.has(chain[0])) {
            augmentedTables.add(chain[0]);
        }
    }
    for (let i = 0; i < n.namedChildCount; i++)
        prescanLuauNode(n.namedChild(i), candidateTables, rootImportedTables, augmentedTables, paramNames);
}

function buildLuauExtractContext(rel, lines, fileNode, nodes, rawEdges, rootNode) {
    const stem = moduleStem(rel);
    const isRootInit = isInitLuau(rel) && rel.split("/").length <= 2;
    const returnedTable = findReturnedTableName(rootNode);
    const chunkParam = findChunkReturnedFunctionParam(rootNode);
    const candidateTables = new Set([returnedTable, chunkParam].filter(Boolean));
    const rootImportedTables = new Set([chunkParam, isRootInit ? returnedTable : null].filter(Boolean));
    const augmentedTables = new Set();
    const paramNames = new Set();
    prescanLuauNode(rootNode, candidateTables, rootImportedTables, augmentedTables, paramNames);

    if (isRootInit || chunkParam) {
        fileNode.barrelTable = returnedTable || chunkParam || stem;
    }
    const isBarrelTarget = (tname) =>
        Boolean(tname) &&
        (tname === chunkParam ||
            (isRootInit && tname === returnedTable) ||
            (augmentedTables.has(tname) && rootImportedTables.has(tname)));
    const isPrimaryTable = (tname) =>
        tname === returnedTable ||
        tname === chunkParam ||
        tname === stem ||
        tname === "M" ||
        tname === "module" ||
        augmentedTables.has(tname);
    if (isRootInit || [...augmentedTables].some((t) => isBarrelTarget(t))) {
        fileNode.isBarrelContributor = true;
    }
    return {
        rel,
        lines,
        fileNode,
        nodes,
        rawEdges,
        stem,
        isRootInit,
        paramNames,
        isBarrelTarget,
        isPrimaryTable,
        minted: new Set([rel]),
        spanSeen: new Set(),
        defs: [],
        defNameAt: new Set(),
        instancePaths: new Map(),
        reqBindings: new Map(),
        localTables: new Set(),
        submodules: {},
        barrelExports: {},
        instanceExports: {},
        rawCalls: [],
        rawRefs: [],
        sameFileFnNames: new Set(),
    };
}

function appendLuauDef(luauCtx, name, kind, whole, exported = true) {
    const { rel, lines, minted, spanSeen, nodes, defs } = luauCtx;
    if (spanSeen.has(whole.startIndex))
        return null;
    spanSeen.add(whole.startIndex);
    const id = mintId(`${rel}#${name}`, minted);
    const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
    const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
    const rawSlice = lines.slice(startRow, endRow + 1).join("\n");
    const nodeObj = {
        id,
        name,
        kind,
        path: rel,
        span: `L${startRow + 1}-L${endRow + 1}`,
        signature: sigLine || null,
        exported,
        origin: "generic",
        body_hash: contentHash(rawSlice),
        body_text: searchBody(rawSlice),
        summary_state: "pending",
        summary: extractLeadingSummary(lines, startRow, rawSlice),
        crux: null,
    };
    nodes.push(nodeObj);
    defs.push({
        id,
        name,
        kind,
        exported,
        inNestedFn: isInsideNestedFunction(whole),
        startIndex: whole.startIndex,
        endIndex: whole.endIndex,
    });
    return nodeObj;
}

function extractLuauQueryDefs(luauCtx, entry, rootNode) {
    if (!entry.query)
        return;
    const { fileNode, isBarrelTarget, isPrimaryTable, defNameAt } = luauCtx;
    for (const m of entry.query.matches(rootNode)) {
        const cap = {};
        for (const c of m.captures)
            cap[c.name] = c.node;
        const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
        if (!defKey || !cap.name)
            continue;
        const rawDefNode = cap[defKey];
        const whole = defScope(rawDefNode);
        const inNestedFn = isInsideNestedFunction(whole);
        const inChunkFn = isInsideChunkReturnedFunction(whole);
        let symName = cap.name.text;
        let exported = !inNestedFn;

        if (rawDefNode.type === "field") {
            const ctx = enclosingTableContext(rawDefNode, isPrimaryTable);
            if (ctx?.prefix) {
                symName = `${ctx.prefix}.${symName}`;
                exported = ctx.exported;
            }
            else if (inNestedFn) {
                continue;
            }
        }
        else if (rawDefNode.type === "function_declaration") {
            const fnNameNode = rawDefNode.childForFieldName("name");
            const chain = extractAccessChain(fnNameNode);
            if (chain && chain.length >= 2) {
                if (isBarrelTarget(chain[0]))
                    fileNode.isBarrelContributor = true;
                if (isPrimaryTable(chain[0])) {
                    symName = chain.slice(1).join(".");
                    exported = !inNestedFn;
                }
                else {
                    symName = chain.join(".");
                    exported = false;
                }
            }
            else if (inNestedFn || inChunkFn || rawDefNode.text.trimStart().startsWith("local ")) {
                exported = false;
            }
        }
        else if (rawDefNode.type === "assignment_statement") {
            const lhs = rawDefNode.namedChild(0)?.namedChild(0);
            const chain = extractAccessChain(lhs);
            if (chain && chain.length >= 2) {
                if (isBarrelTarget(chain[0]))
                    fileNode.isBarrelContributor = true;
                if (isPrimaryTable(chain[0])) {
                    symName = chain.slice(1).join(".");
                    exported = !inNestedFn;
                }
                else {
                    symName = chain.join(".");
                    exported = false;
                }
            }
            else {
                exported = false;
            }
        }
        else if (rawDefNode.type === "type_definition") {
            exported = rawDefNode.text.trimStart().startsWith("export ");
        }

        defNameAt.add(cap.name.startIndex);
        appendLuauDef(luauCtx, symName, KIND[defKey.slice("definition.".length)] ?? "function", whole, exported);
    }
}

function scanLuauExtraDefs(n, luauCtx) {
    const { spanSeen, fileNode, isBarrelTarget, isPrimaryTable, defNameAt } = luauCtx;
    if (n.type === "assignment_statement" && !spanSeen.has(n.startIndex)) {
        const vars = n.namedChild(0);
        const exprs = n.namedChild(1);
        if (vars?.type === "variable_list" && exprs?.type === "expression_list") {
            const lhs = vars.namedChild(0);
            const rhs = exprs.namedChild(0);
            const fnDef = unwrapFunctionDef(rhs);
            if (lhs && fnDef) {
                const chain = extractAccessChain(lhs);
                if (chain && chain.length >= 1) {
                    const inNestedFn = isInsideNestedFunction(n);
                    let symName = chain[0];
                    let exported = false;
                    if (chain.length >= 2) {
                        if (isBarrelTarget(chain[0]))
                            fileNode.isBarrelContributor = true;
                        if (isPrimaryTable(chain[0])) {
                            symName = chain.slice(1).join(".");
                            exported = !inNestedFn;
                        }
                        else {
                            symName = chain.join(".");
                        }
                    }
                    defNameAt.add(lhs.startIndex);
                    appendLuauDef(luauCtx, symName, "function", n, exported);
                }
            }
        }
    }
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauExtraDefs(n.namedChild(i), luauCtx);
}

function resolveLuauRhsModuleTarget(rawRhs, luauCtx) {
    const { instancePaths, isBarrelTarget, isPrimaryTable, reqBindings, submodules } = luauCtx;
    const rhs = unwrapExpr(rawRhs);
    if (!rhs)
        return null;
    if (rhs.type === "binary_expression") {
        return resolveLuauRhsModuleTarget(rhs.namedChild(1), luauCtx) ?? resolveLuauRhsModuleTarget(rhs.namedChild(0), luauCtx);
    }
    if (rhs.type === "if_expression") {
        for (let i = 1; i < rhs.namedChildCount; i++) {
            const hit = resolveLuauRhsModuleTarget(rhs.namedChild(i), luauCtx);
            if (hit)
                return hit;
        }
        return null;
    }
    const directSpec = extractRequireSpec(rhs, instancePaths, isBarrelTarget);
    if (directSpec)
        return { spec: directSpec, chain: [] };
    if (rhs.type === "identifier") {
        if (rhs.text === "script")
            return { spec: "@self", chain: [] };
        if (reqBindings.has(rhs.text)) {
            const b = reqBindings.get(rhs.text);
            return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? [])] };
        }
        const inst = evalInstancePath(rhs, instancePaths, isBarrelTarget);
        if (inst)
            return { spec: instancePathToSpec(inst), chain: [] };
    }
    if (rhs.type === "dot_index_expression") {
        const tbl = rhs.childForFieldName("table");
        const fld = rhs.childForFieldName("field");
        if (tbl && fld) {
            const tblSpec = extractRequireSpec(tbl, instancePaths, isBarrelTarget);
            if (tblSpec)
                return { spec: tblSpec, chain: [fld.text] };
            const chain = extractAccessChain(rhs);
            if (chain && chain.length >= 2) {
                if (reqBindings.has(chain[0])) {
                    const b = reqBindings.get(chain[0]);
                    return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? []), ...chain.slice(1)] };
                }
                if (isBarrelTarget(chain[0])) {
                    return { barrel: true, chain: chain.slice(1) };
                }
                if (isPrimaryTable(chain[0]) && submodules[chain[1]]) {
                    const sm = submodules[chain[1]];
                    return { spec: sm.spec, barrel: sm.barrel, chain: [...(sm.chain ?? []), ...chain.slice(2)] };
                }
            }
        }
    }
    if (rhs.type === "function_call") {
        const callee = unwrapExpr(rhs.childForFieldName("name"));
        if (callee?.type === "dot_index_expression" || callee?.type === "method_index_expression") {
            const tbl = callee.childForFieldName("table");
            const fld = callee.childForFieldName("field") ?? callee.childForFieldName("method");
            if (tbl?.type === "identifier" && fld?.text === "new" && reqBindings.has(tbl.text)) {
                const b = reqBindings.get(tbl.text);
                return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? [])] };
            }
        }
    }
    return null;
}

function exportLuauLocalAlias(luauCtx, fullKey, targetName, siteNode) {
    const { rel, lines, minted, nodes, defs } = luauCtx;
    const moduleDefIds = new Set();
    let matchedTargetDef = null;
    for (const d of defs) {
        if (!d.inNestedFn && (d.name === targetName || d.name === fullKey)) {
            d.exported = true;
            moduleDefIds.add(d.id);
            if (d.name === targetName)
                matchedTargetDef = d;
        }
    }
    const fieldSummary = extractLeadingSummary(lines, siteNode.startPosition.row, siteNode.text);
    let matchedTargetNode = null;
    let hasFullKeyNode = false;
    for (let j = 1; j < nodes.length; j++) {
        const symNode = nodes[j];
        if (symNode.name === fullKey && moduleDefIds.has(symNode.id))
            hasFullKeyNode = true;
        if (moduleDefIds.has(symNode.id)) {
            symNode.exported = true;
            if (!symNode.summary && fieldSummary) {
                symNode.summary = fieldSummary;
            }
            if (symNode.name === targetName)
                matchedTargetNode = symNode;
        }
    }
    if (fullKey !== targetName && !hasFullKeyNode && matchedTargetNode) {
        const aliasId = mintId(`${rel}#${fullKey}`, minted);
        const aliasNode = {
            ...matchedTargetNode,
            id: aliasId,
            name: fullKey,
            exported: true,
            summary: fieldSummary ?? matchedTargetNode.summary,
        };
        nodes.push(aliasNode);
        defs.push({
            id: aliasId,
            name: fullKey,
            kind: matchedTargetNode.kind,
            exported: true,
            inNestedFn: false,
            startIndex: matchedTargetDef?.startIndex ?? siteNode.startIndex,
            endIndex: matchedTargetDef?.endIndex ?? siteNode.endIndex,
        });
    }
}

function recordLuauTableFields(tblNode, prefixChain, isBarrel, isPrimaryTarget, tblVarName, luauCtx) {
    const { instancePaths, isBarrelTarget, instanceExports, submodules, barrelExports } = luauCtx;
    for (let i = 0; i < tblNode.namedChildCount; i++) {
        const f = tblNode.namedChild(i);
        if (f?.type !== "field")
            continue;
        const k = f.childForFieldName("name")?.text;
        const v = unwrapExpr(f.childForFieldName("value"));
        if (!k || !v)
            continue;
        const fullKey = prefixChain.length > 0 ? `${prefixChain.join(".")}.${k}` : k;
        if (isPrimaryTarget && v.type === "identifier") {
            exportLuauLocalAlias(luauCtx, fullKey, v.text, f);
        }
        const instPath = evalInstancePath(v, instancePaths, isBarrelTarget);
        if (instPath) {
            if (tblVarName)
                instancePaths.set(`${tblVarName}.${fullKey}`, instPath);
            const instSpec = instancePathToSpec(instPath);
            if (instSpec && (isPrimaryTarget || isBarrel))
                instanceExports[fullKey] = instSpec;
        }
        const modTarget = resolveLuauRhsModuleTarget(v, luauCtx);
        if (modTarget) {
            if (isPrimaryTarget)
                submodules[fullKey] = modTarget;
            if (isBarrel)
                barrelExports[fullKey] = modTarget;
        }
        else if (v.type === "table_constructor") {
            recordLuauTableFields(v, [...prefixChain, k], isBarrel, isPrimaryTarget, tblVarName, luauCtx);
        }
    }
}

function scanLuauAssignmentPair(lhs, rhs, stmtNode, luauCtx) {
    const { instancePaths, isBarrelTarget, isPrimaryTable, isRootInit, reqBindings, localTables, instanceExports, submodules, barrelExports } = luauCtx;
    if (lhs.type === "identifier") {
        const instPath = evalInstancePath(rhs, instancePaths, isBarrelTarget);
        if (instPath)
            instancePaths.set(lhs.text, instPath);
        const modTarget = resolveLuauRhsModuleTarget(rhs, luauCtx);
        if (modTarget)
            reqBindings.set(lhs.text, modTarget);
        const unwRhs = unwrapExpr(rhs);
        if (unwRhs?.type === "table_constructor") {
            localTables.add(lhs.text);
            const isPrim = isPrimaryTable(lhs.text);
            const isBarrel = isBarrelTarget(lhs.text) || isRootInit;
            recordLuauTableFields(unwRhs, [], isBarrel, isPrim, lhs.text, luauCtx);
        }
        return;
    }
    const lhsChain = extractAccessChain(lhs);
    if (!lhsChain || lhsChain.length < 2)
        return;
    const isBarrel = isBarrelTarget(lhsChain[0]);
    const isPrim = isPrimaryTable(lhsChain[0]);
    const subChain = lhsChain.slice(1);
    if (subChain.length === 0)
        return;
    const key = subChain.join(".");
    const instPath = evalInstancePath(rhs, instancePaths, isBarrelTarget);
    if (instPath) {
        instancePaths.set(lhsChain.join("."), instPath);
        const instSpec = instancePathToSpec(instPath);
        if (instSpec && (isPrim || isBarrel))
            instanceExports[key] = instSpec;
    }
    const modTarget = resolveLuauRhsModuleTarget(rhs, luauCtx);
    if (modTarget) {
        if (isPrim)
            submodules[key] = modTarget;
        if (isBarrel)
            barrelExports[key] = modTarget;
    }
    else {
        const unwRhs = unwrapExpr(rhs);
        if (unwRhs?.type === "table_constructor" && (isPrim || isBarrel)) {
            recordLuauTableFields(unwRhs, subChain, isBarrel, isPrim, lhsChain[0], luauCtx);
        }
        else if (isPrim && unwRhs?.type === "identifier") {
            exportLuauLocalAlias(luauCtx, key, unwRhs.text, stmtNode);
        }
    }
}

function scanLuauBindings(n, luauCtx) {
    const { rel, rawEdges, instancePaths, isBarrelTarget, isRootInit, stem } = luauCtx;
    if (n.type === "function_call") {
        const spec = extractRequireSpec(n, instancePaths, isBarrelTarget);
        if (spec) {
            rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
        }
    }
    if (n.type === "assignment_statement") {
        const vars = n.namedChild(0);
        const exprs = n.namedChild(1);
        if (vars?.type === "variable_list" && exprs?.type === "expression_list") {
            const count = Math.min(vars.namedChildCount, exprs.namedChildCount);
            for (let i = 0; i < count; i++) {
                const lhs = vars.namedChild(i);
                const rhs = exprs.namedChild(i);
                if (lhs && rhs)
                    scanLuauAssignmentPair(lhs, rhs, n, luauCtx);
            }
        }
    }
    if (n.type === "return_statement" && n.parent?.type === "chunk") {
        const exprList = n.namedChild(0);
        const val = unwrapExpr(exprList?.namedChild(0));
        if (val?.type === "function_definition") {
            appendLuauDef(luauCtx, stem, "function", val, true);
        }
        else if (val?.type === "table_constructor") {
            recordLuauTableFields(val, [], isRootInit, true, null, luauCtx);
        }
        else if (val?.type === "function_call") {
            const firstArg = unwrapExpr(val.childForFieldName("arguments")?.namedChild(0));
            if (firstArg?.type === "table_constructor") {
                recordLuauTableFields(firstArg, [], isRootInit, true, null, luauCtx);
            }
        }
    }
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauBindings(n.namedChild(i), luauCtx);
}

function findLuauDelegateSpec(n, reqBindings) {
    let found = null;
    if (n.type === "return_statement" && n.parent?.type === "chunk") {
        const val = unwrapExpr(n.namedChild(0)?.namedChild(0));
        if (val?.type === "identifier" && reqBindings.has(val.text)) {
            const b = reqBindings.get(val.text);
            if (b.spec && (!b.chain || b.chain.length === 0))
                found = b.spec;
        }
    }
    if (n.type === "field") {
        const fn = n.childForFieldName("name");
        const fv = unwrapExpr(n.childForFieldName("value"));
        if (fn?.text === "__index" && fv?.type === "identifier" && reqBindings.has(fv.text)) {
            const b = reqBindings.get(fv.text);
            if (b.spec && (!b.chain || b.chain.length === 0))
                found = b.spec;
        }
    }
    if (n.type === "function_call") {
        const callee = unwrapExpr(n.childForFieldName("name"));
        if (callee?.type === "identifier" && callee.text === "setmetatable") {
            const args = n.childForFieldName("arguments");
            const secondArg = unwrapExpr(args?.namedChild(1));
            if (secondArg?.type === "identifier" && reqBindings.has(secondArg.text)) {
                const b = reqBindings.get(secondArg.text);
                if (b.spec && (!b.chain || b.chain.length === 0))
                    found = b.spec;
            }
        }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
        const childSpec = findLuauDelegateSpec(n.namedChild(i), reqBindings);
        if (childSpec)
            found = childSpec;
    }
    return found;
}

function scanLuauReexports(n, luauCtx) {
    const { rel, reqBindings, defNameAt, rawEdges } = luauCtx;
    if (n.type === "field" && !isInsideNestedFunction(n)) {
        const fname = n.childForFieldName("name");
        const fval = unwrapExpr(n.childForFieldName("value"));
        if (fname?.type === "identifier" && fval?.type === "dot_index_expression") {
            const chain = extractAccessChain(fval);
            if (chain && chain.length >= 2 && reqBindings.has(chain[0])) {
                const b = reqBindings.get(chain[0]);
                if (b.spec && (!b.chain || b.chain.length === 0) && chain.length === 2) {
                    defNameAt.add(fname.startIndex);
                    const d = appendLuauDef(luauCtx, fname.text, "function", n, true);
                    if (d) {
                        rawEdges.push({
                            source: d.id,
                            relation: "calls",
                            file: rel,
                            specifier: b.spec,
                            chain: [chain[1]],
                            name: chain[1],
                        });
                    }
                }
            }
        }
    }
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauReexports(n.namedChild(i), luauCtx);
}

function recordLuauChainCall(luauCtx, chain, at, extra = {}) {
    const { defNameAt, reqBindings, rawCalls, isBarrelTarget, isPrimaryTable, submodules, paramNames, localTables } = luauCtx;
    if (!chain || chain.length === 0)
        return;
    if (chain.length === 1) {
        const name = chain[0];
        if (defNameAt.has(at))
            return;
        const b = reqBindings.get(name);
        if (b) {
            const leaf = b.chain?.length ? b.chain[b.chain.length - 1] : name;
            rawCalls.push({
                at,
                name: leaf,
                specifier: b.spec,
                barrel: b.barrel,
                chain: b.chain ?? [],
                directModuleCall: !b.chain || b.chain.length === 0,
                ...extra,
            });
        }
        else if (!LUAU_GLOBAL_BUILTINS.has(name)) {
            rawCalls.push({ at, name, ...extra });
        }
        return;
    }
    const t0 = chain[0];
    const leaf = chain[chain.length - 1];
    if (LUAU_STDLIB_TABLES.has(t0))
        return;

    if (isBarrelTarget(t0)) {
        rawCalls.push({ at, name: leaf, barrel: true, chain: chain.slice(1), ...extra });
        return;
    }
    if (reqBindings.has(t0)) {
        const b = reqBindings.get(t0);
        const fullChain = [...(b.chain ?? []), ...chain.slice(1)];
        rawCalls.push({
            at,
            name: leaf,
            specifier: b.spec,
            barrel: b.barrel,
            chain: fullChain,
            ...extra,
        });
        return;
    }
    if (isPrimaryTable(t0) && chain.length >= 2 && submodules[chain[1]]) {
        const sm = submodules[chain[1]];
        const fullChain = [...(sm.chain ?? []), ...chain.slice(2)];
        rawCalls.push({
            at,
            name: leaf,
            specifier: sm.spec,
            barrel: sm.barrel,
            chain: fullChain,
            directModuleCall: fullChain.length === 0,
            ...extra,
        });
        return;
    }
    if (paramNames.has(t0) && chain.length >= 2) {
        rawCalls.push({
            at,
            name: leaf,
            barrel: true,
            recvName: t0,
            chain: chain.slice(1),
            fallbackSameFile: true,
            ...extra,
        });
        return;
    }
    if (t0 === "self" || isPrimaryTable(t0)) {
        const joined = chain.slice(1).join(".");
        rawCalls.push({ at, name: joined, fallbackName: leaf, sameFileOnly: true, ...extra });
        return;
    }
    if (localTables.has(t0)) {
        const joined = chain.join(".");
        rawCalls.push({ at, name: joined, fallbackName: leaf, sameFileOnly: true, ...extra });
        return;
    }
    rawCalls.push({ at, name: leaf, recvName: t0, chain: chain.slice(1), sameFileOnly: true, ...extra });
}

function inspectLuauCallArguments(args, callee, luauCtx) {
    const { rel, instancePaths, isBarrelTarget, rawEdges, sameFileFnNames, reqBindings } = luauCtx;
    const calleeChain = extractAccessChain(callee);
    const calleeKey = calleeChain ? calleeChain.join(".") : "";
    const calleeLeaf = calleeChain ? calleeChain[calleeChain.length - 1] : "";
    const isRequireCall = callee.type === "identifier" && callee.text === "require";
    const isHigherOrder =
        calleeKey === "task.spawn" ||
        calleeKey === "task.defer" ||
        calleeKey === "task.delay" ||
        calleeKey === "pcall" ||
        calleeKey === "xpcall" ||
        calleeKey === "coroutine.wrap" ||
        calleeKey === "table.sort" ||
        calleeLeaf === "Connect" ||
        calleeLeaf === "Once" ||
        calleeLeaf === "debounce" ||
        calleeLeaf === "throttle";

    for (let i = 0; i < args.namedChildCount; i++) {
        const arg = unwrapExpr(args.namedChild(i));
        if (!arg)
            continue;
        if (!isRequireCall && (arg.type !== "identifier" || instancePaths.has(arg.text))) {
            const modPath = evalInstancePath(arg, instancePaths, isBarrelTarget);
            if (modPath && (modPath.parts.length > 0 || modPath.parents > 0)) {
                const modSpec = instancePathToSpec(modPath);
                if (modSpec) {
                    rawEdges.push({ source: rel, relation: "imports", specifier: modSpec, file: rel });
                }
            }
        }
        if (arg.type === "identifier") {
            if (sameFileFnNames.has(arg.text) || reqBindings.has(arg.text)) {
                recordLuauChainCall(luauCtx, [arg.text], arg.startIndex, { sameFileOnly: !reqBindings.has(arg.text) });
            }
        }
        else if (isHigherOrder && arg.type === "dot_index_expression") {
            const argChain = extractAccessChain(arg);
            if (argChain && argChain.length >= 2) {
                recordLuauChainCall(luauCtx, argChain, arg.startIndex);
            }
        }
    }
}

function inspectLuauFunctionCall(n, luauCtx) {
    const { rel, stem, defs, instancePaths, isBarrelTarget, rawEdges, rawCalls } = luauCtx;
    const callee = unwrapExpr(n.childForFieldName("name"));
    const args = n.childForFieldName("arguments");
    if (!callee)
        return;

    if (callee.type === "method_index_expression") {
        const mth = callee.childForFieldName("method")?.text;
        const tbl = callee.childForFieldName("table");
        if (mth === "GetChildren") {
            const dirPath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
            const dirSpec = instancePathToSpec(dirPath);
            if (dirSpec) {
                const enc = enclosingDef(defs, n.startIndex);
                rawEdges.push({
                    source: rel,
                    callerId: enc ? enc.id : rel,
                    relation: "imports_children",
                    specifier: dirSpec,
                    file: rel,
                });
            }
        }
    }
    if (callee.type === "function_call") {
        const reqSpec = extractRequireSpec(callee, instancePaths, isBarrelTarget);
        if (reqSpec) {
            rawCalls.push({ at: callee.startIndex, name: stem, specifier: reqSpec, chain: [], directModuleCall: true });
        }
    }
    if (callee.type === "dot_index_expression" || callee.type === "method_index_expression") {
        const tbl = callee.childForFieldName("table");
        const fld = callee.childForFieldName("field") ?? callee.childForFieldName("method");
        const reqSpec = extractRequireSpec(tbl, instancePaths, isBarrelTarget);
        if (reqSpec && fld) {
            rawCalls.push({ at: fld.startIndex, name: fld.text, specifier: reqSpec, chain: [fld.text] });
        }
    }
    const chain = extractAccessChain(callee);
    if (chain) {
        const at = (callee.childForFieldName?.("field") ?? callee.childForFieldName?.("method") ?? callee).startIndex;
        recordLuauChainCall(luauCtx, chain, at);
        const last = chain[chain.length - 1];
        if ((last === "new" || last === "create") && chain.length >= 2 && !LUAU_STDLIB_TABLES.has(chain[0]) && args) {
            const className = extractStringLiteral(args);
            if (className && /^[A-Z][A-Za-z0-9_]*$/.test(className)) {
                rawCalls.push({ at, name: last, factoryClass: className });
            }
        }
    }
    if (args) {
        inspectLuauCallArguments(args, callee, luauCtx);
    }
}

function scanLuauCallsAndTypes(n, luauCtx) {
    const { sameFileFnNames, rawCalls, defNameAt, reqBindings, rawRefs } = luauCtx;
    if (n.type === "function_call") {
        inspectLuauFunctionCall(n, luauCtx);
    }
    else if (n.type === "field") {
        const fval = unwrapExpr(n.childForFieldName("value"));
        if (fval?.type === "identifier" && sameFileFnNames.has(fval.text)) {
            rawCalls.push({ at: fval.startIndex, name: fval.text, sameFileOnly: true });
        }
    }
    else if (n.type === "field_type") {
        const mod = n.namedChild(0);
        const tname = n.namedChild(1);
        if (mod?.type === "identifier" && tname?.type === "identifier" && !defNameAt.has(tname.startIndex)) {
            const b = reqBindings.get(mod.text);
            if (b) {
                rawRefs.push({ at: tname.startIndex, name: tname.text, specifier: b.spec, barrel: b.barrel, chain: [...(b.chain ?? []), tname.text] });
            }
            else {
                rawRefs.push({ at: tname.startIndex, name: tname.text });
            }
        }
    }
    else if (n.type === "identifier" && !defNameAt.has(n.startIndex)) {
        const p = n.parent;
        if (p) {
            const pt = p.type;
            const isBareType =
                (pt === "type_definition" && p.childForFieldName("name")?.id !== n.id) ||
                (pt === "parameter" && p.namedChildCount >= 2 && p.namedChild(1)?.id === n.id) ||
                ((pt === "function_declaration" || pt === "function_definition") && p.childForFieldName("name")?.id !== n.id) ||
                (pt === "generic_type" && !(p.parent?.type === "type_definition" && p.parent.childForFieldName("name")?.id === p.id)) ||
                pt === "union_type" ||
                pt === "intersection_type" ||
                pt === "optional_type" ||
                pt === "object_field_type" ||
                pt === "object_type" ||
                (pt === "cast_expression" && p.namedChild(1)?.id === n.id);
            if (isBareType) {
                const b = reqBindings.get(n.text);
                if (b && b.chain && b.chain.length > 0) {
                    rawRefs.push({ at: n.startIndex, name: b.chain[b.chain.length - 1], specifier: b.spec, barrel: b.barrel, chain: b.chain });
                }
                else {
                    rawRefs.push({ at: n.startIndex, name: n.text });
                }
            }
        }
    }
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauCallsAndTypes(n.namedChild(i), luauCtx);
}

function finalizeLuauRawEdges(luauCtx) {
    const { rel, defs, rawCalls, rawRefs, rawEdges } = luauCtx;
    for (const c of rawCalls) {
        const enc = enclosingDef(defs, c.at);
        rawEdges.push({
            source: enc ? enc.id : rel,
            relation: "calls",
            file: rel,
            name: c.name,
            fallbackName: c.fallbackName,
            specifier: c.specifier,
            barrel: c.barrel,
            recvName: c.recvName,
            chain: c.chain,
            factoryClass: c.factoryClass,
            sameFileOnly: c.sameFileOnly,
            fallbackSameFile: c.fallbackSameFile,
            directModuleCall: c.directModuleCall,
        });
    }
    for (const r of rawRefs) {
        const enc = enclosingDef(defs, r.at);
        rawEdges.push({
            source: enc ? enc.id : rel,
            relation: "references",
            file: rel,
            name: r.name,
            specifier: r.specifier,
            barrel: r.barrel,
            chain: r.chain,
        });
    }
}

export function extractLuau(rel, rawSource, entry, tsMod) {
    const lines = rawSource.split("\n");
    const fileNode = {
        id: rel,
        name: rel.split("/").pop() ?? rel,
        kind: "file",
        path: rel,
        span: `L1-L${Math.max(1, lines.length)}`,
        signature: null,
        exported: true,
        origin: "generic",
        body_hash: contentHash(rawSource),
        chars: Buffer.byteLength(rawSource),
        summary_state: "pending",
        summary: null,
        crux: null,
    };
    const nodes = [fileNode];
    const rawEdges = [];
    if (!entry || !tsMod)
        return { nodes, rawEdges };

    const typeofReqs = extractTypeofRequires(rawSource);
    const normSource = normalizeLuauForParse(rawSource);
    const tree = parseLuauSyntaxTree(normSource, entry, tsMod);
    if (!tree)
        return { nodes, rawEdges };

    try {
        const luauCtx = buildLuauExtractContext(rel, lines, fileNode, nodes, rawEdges, tree.rootNode);
        extractLuauQueryDefs(luauCtx, entry, tree.rootNode);
        scanLuauExtraDefs(tree.rootNode, luauCtx);
        for (const tr of typeofReqs) {
            rawEdges.push({ source: rel, relation: "imports", specifier: tr.spec, file: rel });
            if (tr.field) {
                luauCtx.submodules[tr.field] = { spec: tr.spec, chain: [] };
            }
        }
        scanLuauBindings(tree.rootNode, luauCtx);
        if (Object.keys(luauCtx.submodules).length > 0)
            fileNode.submodules = luauCtx.submodules;
        if (Object.keys(luauCtx.barrelExports).length > 0)
            fileNode.barrelExports = luauCtx.barrelExports;
        if (Object.keys(luauCtx.instanceExports).length > 0)
            fileNode.instanceExports = luauCtx.instanceExports;

        const delegateSpec = findLuauDelegateSpec(tree.rootNode, luauCtx.reqBindings);
        if (delegateSpec)
            fileNode.delegateSpec = delegateSpec;

        scanLuauReexports(tree.rootNode, luauCtx);
        for (const d of luauCtx.defs) {
            if (d.kind === "function" || d.kind === "method")
                luauCtx.sameFileFnNames.add(d.name);
        }
        scanLuauCallsAndTypes(tree.rootNode, luauCtx);
        finalizeLuauRawEdges(luauCtx);
    }
    finally {
        tree.delete?.();
    }
    fileNode.body_text = fileResidual(rawSource, nodes.slice(1));
    return { nodes, rawEdges };
}

function isInitLuau(rel) {
    const b = posix.basename(rel);
    return b === "init.luau" || b.startsWith("init.");
}

function candidateRoots(extraRoot) {
    if (extraRoot)
        return [extraRoot];
    let roots = [];
    try {
        roots = [process.cwd()];
    }
    catch {
        /* cwd unavailable */
    }
    return roots;
}

function readLuaurcAliases(extraRoot, allDirs) {
    const map = new Map();
    const rcRels = new Set([".luaurc"]);
    if (allDirs) {
        for (const d of allDirs) {
            if (!d || d === ".")
                continue;
            const top = d.split("/")[0];
            if (top)
                rcRels.add(`${top}/.luaurc`);
            rcRels.add(`${d}/.luaurc`);
        }
    }
    for (const r of candidateRoots(extraRoot)) {
        const rootDir = resolve(r);
        for (const rcRel of rcRels) {
            const d = readJson(join(rootDir, rcRel));
            if (!d || typeof d !== "object")
                continue;
            const rcDir = posix.dirname(rcRel) === "." ? "" : posix.dirname(rcRel);
            for (const [k, v] of Object.entries(d.aliases ?? {})) {
                const norm = posix.normalize(rcDir ? posix.join(rcDir, String(v)) : String(v)).replace(/^\.\//, "");
                if (!map.has(k))
                    map.set(k, norm);
            }
        }
    }
    return map;
}

function resolveRojoSubprojectPath(rootDir, targetRel) {
    const normTarget = posix.normalize(targetRel).replace(/^\.\//, "");
    const subData = readJson(join(rootDir, normTarget, "default.project.json"));
    const subPath = subData?.tree?.$path;
    if (typeof subPath === "string") {
        return posix.normalize(posix.join(normTarget, subPath)).replace(/^\.\//, "");
    }
    return normTarget;
}

function readRojoMounts(extraRoot) {
    const mounts = new Map();
    for (const r of candidateRoots(extraRoot)) {
        const rootDir = resolve(r);
        const data = readJson(join(rootDir, "default.project.json"));
        if (!data || typeof data !== "object")
            continue;
        const walkTree = (obj, parentVirt) => {
            if (!obj || typeof obj !== "object")
                return;
            let curVirt = parentVirt;
            if (typeof obj.$path === "string") {
                const phys = resolveRojoSubprojectPath(rootDir, obj.$path);
                if (parentVirt && parentVirt !== phys) {
                    mounts.set(parentVirt, phys);
                }
                curVirt = phys;
            }
            for (const [k, v] of Object.entries(obj)) {
                if (k.startsWith("$") || !v || typeof v !== "object")
                    continue;
                const childVirt = curVirt ? `${curVirt}/${k}` : k;
                if (typeof v.$path === "string") {
                    const phys = resolveRojoSubprojectPath(rootDir, v.$path);
                    mounts.set(childVirt, phys);
                    if (!mounts.has(k))
                        mounts.set(k, phys);
                    if (!mounts.has(`src/${k}`))
                        mounts.set(`src/${k}`, phys);
                }
                walkTree(v, childVirt);
            }
        };
        walkTree(data.tree, "");
        if (mounts.size > 0)
            break;
    }
    return mounts;
}

function checkDirectLuauCandidates(joined, byId) {
    const norm = posix.normalize(joined).replace(/^\.\//, "");
    const noExt = norm.replace(/\.luau$/i, "");
    for (const c of [norm, `${noExt}.luau`, `${noExt}/init.luau`, `${noExt}/init.client.luau`, `${noExt}/init.server.luau`]) {
        if (byId.has(c))
            return c;
    }
    return null;
}

function checkLuauCandidates(joined, byId, rojoMounts) {
    const direct = checkDirectLuauCandidates(joined, byId);
    if (direct)
        return direct;
    if (rojoMounts && rojoMounts.size > 0) {
        const norm = posix.normalize(joined).replace(/^\.\//, "");
        for (const [virt, phys] of rojoMounts.entries()) {
            if (norm === virt) {
                const hit = checkDirectLuauCandidates(phys, byId);
                if (hit)
                    return hit;
            }
            else if (norm.startsWith(virt + "/")) {
                const tail = norm.slice(virt.length + 1);
                const hit = checkDirectLuauCandidates(`${phys}/${tail}`, byId);
                if (hit)
                    return hit;
            }
        }
    }
    return null;
}

function matchBarrelInstanceRoute(rel, barrelInstancePaths) {
    if (!rel || !barrelInstancePaths || barrelInstancePaths.size === 0)
        return null;
    const parts = rel.split("/");
    for (let len = parts.length; len >= 1; len--) {
        const key = parts.slice(0, len).join(".");
        if (barrelInstancePaths.has(key)) {
            const entry = barrelInstancePaths.get(key);
            const rest = parts.slice(len).join("/");
            const combined = rest ? `${entry.spec.replace(/\/$/, "")}/${rest}` : entry.spec;
            return { spec: combined, fromFile: entry.fromFile };
        }
    }
    return null;
}

export function resolveLuauSpecifier(spec, file, byId, luaurcAliases, rojoMounts, barrelInstancePaths = null) {
    const baseDir = posix.dirname(file);
    if (spec === "@root" || spec.startsWith("@root/")) {
        const rel = spec === "@root" ? "" : spec.slice(6);
        const mapped = matchBarrelInstanceRoute(rel, barrelInstancePaths);
        if (mapped) {
            const hit = resolveLuauSpecifier(mapped.spec, mapped.fromFile, byId, luaurcAliases, rojoMounts, null);
            if (byId.has(hit))
                return hit;
        }
        for (const cand of [rel ? `src/${rel}` : "src", rel || "init.luau"]) {
            const hit = checkLuauCandidates(cand, byId, rojoMounts);
            if (hit)
                return hit;
        }
        return spec;
    }
    if (spec.startsWith("@self/")) {
        const rel = spec.slice(6);
        if (!isInitLuau(file)) {
            const stemDir = posix.join(baseDir, posix.basename(file).replace(/\.luau$/i, ""));
            const childHit = checkLuauCandidates(posix.join(stemDir, rel), byId, rojoMounts);
            if (childHit)
                return childHit;
        }
        return checkLuauCandidates(baseDir && baseDir !== "." ? posix.join(baseDir, rel) : rel, byId, rojoMounts) ?? spec;
    }
    if (spec === "@self") {
        return checkLuauCandidates(baseDir, byId, rojoMounts) ?? (byId.has(file) ? file : spec);
    }
    if (spec.startsWith("@")) {
        const slash = spec.indexOf("/");
        const alias = slash >= 0 ? spec.slice(1, slash) : spec.slice(1);
        const rest = slash >= 0 ? spec.slice(slash + 1) : "";
        const target = luaurcAliases?.get(alias);
        if (target) {
            const hit = checkLuauCandidates(rest ? `${target}/${rest}` : target, byId, rojoMounts);
            if (hit)
                return hit;
        }
        const fallbacks = [`${alias}/src/${rest}`, `src/${rest}`, `${alias}/${rest}`];
        for (const fb of fallbacks) {
            const hit = checkLuauCandidates(fb, byId, rojoMounts);
            if (hit)
                return hit;
        }
        return spec;
    }
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
        const effDir = isInitLuau(file) ? posix.dirname(baseDir) : baseDir;
        const joined = effDir && effDir !== "." ? posix.join(effDir, spec) : spec;
        const hit = checkLuauCandidates(joined, byId, rojoMounts);
        if (hit)
            return hit;
        if (effDir !== baseDir) {
            const altJoined = baseDir && baseDir !== "." ? posix.join(baseDir, spec) : spec;
            const altHit = checkLuauCandidates(altJoined, byId, rojoMounts);
            if (altHit)
                return altHit;
        }
        return spec;
    }
    return checkLuauCandidates(spec, byId, rojoMounts) ?? spec;
}

function resolveLuauDirSpecifier(spec, file, allDirs, rojoMounts, barrelInstancePaths = null) {
    const baseDir = posix.dirname(file);
    const tryDir = (d) => {
        const norm = posix.normalize(d).replace(/^\.\//, "").replace(/\/$/, "");
        if (allDirs.has(norm))
            return norm;
        if (rojoMounts) {
            for (const [virt, phys] of rojoMounts.entries()) {
                if (norm === virt && allDirs.has(phys))
                    return phys;
                if (norm.startsWith(virt + "/")) {
                    const mapped = `${phys}/${norm.slice(virt.length + 1)}`;
                    if (allDirs.has(mapped))
                        return mapped;
                }
            }
        }
        return null;
    };
    if (spec === "@root" || spec.startsWith("@root/")) {
        const rel = spec === "@root" ? "" : spec.slice(6);
        const mapped = matchBarrelInstanceRoute(rel, barrelInstancePaths);
        if (mapped) {
            const hit = resolveLuauDirSpecifier(mapped.spec, mapped.fromFile, allDirs, rojoMounts, null);
            if (hit)
                return hit;
        }
        return tryDir(rel ? `src/${rel}` : "src") ?? tryDir(rel);
    }
    if (spec.startsWith("@self/")) {
        const rel = spec.slice(6);
        if (!isInitLuau(file)) {
            const stemDir = posix.join(baseDir, posix.basename(file).replace(/\.luau$/i, ""));
            const hit = tryDir(posix.join(stemDir, rel));
            if (hit)
                return hit;
        }
        return tryDir(baseDir && baseDir !== "." ? posix.join(baseDir, rel) : rel);
    }
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
        const effDir = isInitLuau(file) ? posix.dirname(baseDir) : baseDir;
        const hit = tryDir(effDir && effDir !== "." ? posix.join(effDir, spec) : spec);
        if (hit)
            return hit;
        if (effDir !== baseDir)
            return tryDir(baseDir && baseDir !== "." ? posix.join(baseDir, spec) : spec);
        return null;
    }
    return tryDir(spec);
}

function pickUniqueLuauCandidate(cands) {
    if (cands.length === 1)
        return cands[0];
    if (cands.length > 1) {
        const exp = cands.filter((n) => n.exported);
        if (exp.length === 1)
            return exp[0];
    }
    return null;
}

function buildLuauResolutionIndex(nodes, opts) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const perFileName = new Map();
    const globalName = new Map();
    const allDirs = new Set();
    const luauFiles = [];
    const barrelRoutes = new Map();
    const barrelInstancePaths = new Map();
    const barrelSymbols = new Map();
    const barrelFileSet = new Set();
    const barrelTableNames = new Set();

    for (const n of nodes) {
        if (n.kind === "file") {
            if (n.path.endsWith(".luau")) {
                luauFiles.push(n);
                allDirs.add(posix.dirname(n.path));
                if (isInitLuau(n.path) && n.path.split("/").length <= 2) {
                    barrelFileSet.add(n.path);
                }
            }
            if (n.barrelTable)
                barrelTableNames.add(n.barrelTable);
            if (n.isBarrelContributor)
                barrelFileSet.add(n.path);
            if (n.barrelExports) {
                for (const [k, target] of Object.entries(n.barrelExports)) {
                    if (!barrelRoutes.has(k)) {
                        barrelRoutes.set(k, { fromFile: n.path, ...target });
                    }
                }
            }
            if (n.instanceExports && (n.isBarrelContributor || (isInitLuau(n.path) && n.path.split("/").length <= 2))) {
                for (const [k, spec] of Object.entries(n.instanceExports)) {
                    if (!barrelInstancePaths.has(k)) {
                        barrelInstancePaths.set(k, { fromFile: n.path, spec });
                    }
                }
            }
            continue;
        }
        pushMap(globalName, n.name, n);
        let fm = perFileName.get(n.path);
        if (!fm)
            perFileName.set(n.path, (fm = new Map()));
        pushMap(fm, n.name, n);
        if (n.name.includes(".")) {
            const leaf = n.name.slice(n.name.lastIndexOf(".") + 1);
            pushMap(fm, leaf, n);
        }
    }

    const aliases = readLuaurcAliases(opts?.root, allDirs);
    const rojoMounts = readRojoMounts(opts?.root);

    for (const barrelFile of barrelFileSet) {
        const fm = perFileName.get(barrelFile);
        if (!fm)
            continue;
        for (const [sym, list] of fm.entries()) {
            for (const sNode of list)
                pushMap(barrelSymbols, sym, sNode);
        }
    }
    return {
        byId,
        perFileName,
        globalName,
        allDirs,
        luauFiles,
        barrelRoutes,
        barrelInstancePaths,
        barrelSymbols,
        barrelFileSet,
        barrelTableNames,
        aliases,
        rojoMounts,
    };
}

function resolveLuauImportsPass(luauRaw, luauIdx, factoryClasses, emitLuauEdge) {
    const { byId, aliases, rojoMounts, barrelInstancePaths, allDirs, luauFiles, perFileName } = luauIdx;
    for (const e of luauRaw) {
        if (e.relation === "imports" && e.specifier) {
            const target = resolveLuauSpecifier(e.specifier, e.file, byId, aliases, rojoMounts, barrelInstancePaths);
            if (byId.has(target))
                emitLuauEdge(e.source, target, "imports", "extracted");
        }
        else if (e.relation === "imports_children" && e.specifier) {
            const dir = resolveLuauDirSpecifier(e.specifier, e.file, allDirs, rojoMounts, barrelInstancePaths);
            if (!dir)
                continue;
            for (const n of luauFiles) {
                const pDir = posix.dirname(n.path);
                const isDirectChild = (pDir === dir && !isInitLuau(n.path)) || (posix.dirname(pDir) === dir && isInitLuau(n.path));
                if (!isDirectChild)
                    continue;
                emitLuauEdge(e.file, n.path, "imports", "extracted");
                const stem = moduleStem(n.path);
                const fm = perFileName.get(n.path);
                if (fm?.has("new"))
                    factoryClasses.set(stem, n.path);
                const initFn = pickUniqueLuauCandidate((fm?.get(stem) ?? []).filter((s) => s.kind === "function"));
                if (initFn)
                    emitLuauEdge(e.callerId || e.file, initFn.id, "calls", "extracted");
            }
        }
    }
}

function lookupLuauSubmoduleTarget(fileId, key, luauIdx) {
    const { byId, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let cur = fileId;
    for (let d = 0; d < 3; d++) {
        const fn = byId.get(cur);
        if (!fn)
            break;
        if (fn.submodules && fn.submodules[key]) {
            return { fromFile: cur, ...fn.submodules[key] };
        }
        if (!fn.delegateSpec)
            break;
        cur = resolveLuauSpecifier(fn.delegateSpec, cur, byId, aliases, rojoMounts, barrelInstancePaths);
    }
    return null;
}

function walkLuauDelegateCandidates(curFile, rem, isDirect, kinds, luauIdx) {
    const { byId, perFileName, barrelFileSet, barrelSymbols, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    const symFull = rem.join(".");
    const symLeaf = rem[rem.length - 1];
    let walkFile = curFile;
    for (let hop = 0; hop < 4; hop++) {
        const fnode = byId.get(walkFile);
        if (!fnode)
            break;
        const fm = perFileName.get(walkFile);
        let cands = [];
        if (symFull && fm?.has(symFull)) {
            cands = fm.get(symFull).filter((n) => kinds.includes(n.kind));
        }
        if (cands.length === 0 && symLeaf && fm?.has(symLeaf)) {
            cands = fm.get(symLeaf).filter((n) => kinds.includes(n.kind));
        }
        if (cands.length === 0 && barrelFileSet.has(walkFile)) {
            cands = (barrelSymbols.get(symFull) ?? barrelSymbols.get(symLeaf) ?? []).filter((n) => kinds.includes(n.kind));
            const pickedBarrel = pickUniqueLuauCandidate(cands);
            if (pickedBarrel)
                return { node: pickedBarrel, moduleFile: pickedBarrel.path };
        }
        if (cands.length === 0 && (isDirect || rem.length === 0)) {
            const stem = moduleStem(walkFile);
            cands = (fm?.get(stem) ?? fm?.get("new") ?? []).filter((n) => kinds.includes(n.kind));
        }
        const picked = pickUniqueLuauCandidate(cands);
        if (picked)
            return { node: picked, moduleFile: curFile };
        if (cands.length > 1)
            return { node: null, moduleFile: curFile };
        if (!fnode.delegateSpec)
            break;
        walkFile = resolveLuauSpecifier(fnode.delegateSpec, walkFile, byId, aliases, rojoMounts, barrelInstancePaths);
    }
    return { node: null, moduleFile: curFile };
}

function resolveLuauChainTarget(startSpec, startBarrel, fromFile, rawChain, kinds, directModuleCall, recvName, luauIdx) {
    const { byId, barrelTableNames, barrelRoutes, barrelSymbols, barrelFileSet, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let curFile = null;
    let rem = [...(rawChain ?? [])];
    let isDirect = directModuleCall;

    if (startBarrel) {
        let explicitBarrel = !recvName || barrelTableNames.has(recvName);
        if (rem.length >= 2 && barrelTableNames.has(rem[0])) {
            rem = rem.slice(1);
            explicitBarrel = true;
        }
        let matchedLen = 0;
        let matchedRoute = null;
        for (let len = rem.length; len >= 1; len--) {
            const prefix = rem.slice(0, len).join(".");
            if (barrelRoutes.has(prefix)) {
                matchedLen = len;
                matchedRoute = barrelRoutes.get(prefix);
                break;
            }
        }
        if (matchedRoute) {
            if (matchedRoute.spec) {
                curFile = resolveLuauSpecifier(matchedRoute.spec, matchedRoute.fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
                rem = [...(matchedRoute.chain ?? []), ...rem.slice(matchedLen)];
                if (rem.length === 0)
                    isDirect = true;
            }
        }
        else if (explicitBarrel) {
            const fullSym = rem.join(".");
            const leafSym = rem[rem.length - 1];
            const cands = (barrelSymbols.get(fullSym) ?? barrelSymbols.get(leafSym) ?? []).filter((n) => kinds.includes(n.kind));
            const picked = pickUniqueLuauCandidate(cands);
            if (picked)
                return { node: picked, moduleFile: picked.path };
            return null;
        }
        else {
            return null;
        }
    }
    else if (startSpec) {
        curFile = resolveLuauSpecifier(startSpec, fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
    }

    if (!curFile || !byId.has(curFile))
        return null;

    for (let hop = 0; hop < 5 && rem.length >= 1; hop++) {
        let advanced = false;
        for (let len = rem.length; len >= 1; len--) {
            const subKey = rem.slice(0, len).join(".");
            const subTarget = lookupLuauSubmoduleTarget(curFile, subKey, luauIdx) ?? (barrelFileSet.has(curFile) ? barrelRoutes.get(subKey) : null);
            if (subTarget && subTarget.spec) {
                const nextFile = resolveLuauSpecifier(subTarget.spec, subTarget.fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
                if (byId.has(nextFile)) {
                    curFile = nextFile;
                    rem = [...(subTarget.chain ?? []), ...rem.slice(len)];
                    if (rem.length === 0)
                        isDirect = true;
                    advanced = true;
                    break;
                }
            }
        }
        if (!advanced)
            break;
    }

    return walkLuauDelegateCandidates(curFile, rem, isDirect, kinds, luauIdx);
}

function resolveLuauCallOrRefEdge(e, luauIdx, factoryClasses, emitLuauEdge) {
    const { perFileName, globalName, barrelTableNames } = luauIdx;
    if (e.relation === "references" && e.name) {
        if (e.specifier || e.barrel) {
            const res = resolveLuauChainTarget(e.specifier, e.barrel, e.file, e.chain ?? [e.name], ["type"], false, null, luauIdx);
            if (res?.moduleFile)
                emitLuauEdge(e.file, res.moduleFile, "imports", "extracted");
            if (res?.node)
                emitLuauEdge(e.source, res.node.id, "references", "extracted");
        }
        else {
            const local = pickUniqueLuauCandidate((perFileName.get(e.file)?.get(e.name) ?? []).filter((n) => n.kind === "type"));
            if (local)
                emitLuauEdge(e.source, local.id, "references", "extracted");
        }
        return;
    }
    if (e.relation !== "calls" || !e.name)
        return;
    const callKinds = ["function", "method"];
    if (e.factoryClass) {
        const classFile = factoryClasses.get(e.factoryClass);
        if (classFile) {
            emitLuauEdge(e.file, classFile, "imports", "extracted");
            const newFn = pickUniqueLuauCandidate((perFileName.get(classFile)?.get(e.name) ?? perFileName.get(classFile)?.get("new") ?? []).filter((n) => callKinds.includes(n.kind)));
            if (newFn)
                emitLuauEdge(e.source, newFn.id, "calls", "extracted");
        }
        return;
    }
    const isBarrelCall = Boolean(e.barrel || (e.recvName && barrelTableNames.has(e.recvName)) || (e.chain?.length >= 2 && barrelTableNames.has(e.chain[0])));
    if (e.specifier || isBarrelCall) {
        const res = resolveLuauChainTarget(e.specifier, isBarrelCall, e.file, e.chain ?? [e.name], callKinds, e.directModuleCall, e.recvName, luauIdx);
        if (res?.moduleFile)
            emitLuauEdge(e.file, res.moduleFile, "imports", "extracted");
        if (res?.node) {
            emitLuauEdge(e.source, res.node.id, "calls", "extracted");
            return;
        }
        if (!e.fallbackSameFile)
            return;
    }
    let local = pickUniqueLuauCandidate((perFileName.get(e.file)?.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind)));
    if (!local && e.fallbackName) {
        local = pickUniqueLuauCandidate((perFileName.get(e.file)?.get(e.fallbackName) ?? []).filter((n) => callKinds.includes(n.kind)));
    }
    if (local) {
        emitLuauEdge(e.source, local.id, "calls", "extracted");
        return;
    }
    if (e.sameFileOnly || e.fallbackSameFile)
        return;
    const global = (globalName.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind) && n.path.endsWith(".luau"));
    const pickedGlobal = pickUniqueLuauCandidate(global);
    if (pickedGlobal) {
        emitLuauEdge(e.source, pickedGlobal.id, "calls", "inferred");
    }
}

export function resolveLuauEdges(nodes, rawEdges, addEdge, opts = {}) {
    const luauRaw = rawEdges.filter((e) => e.file?.endsWith(".luau"));
    if (luauRaw.length === 0)
        return;

    const luauIdx = buildLuauResolutionIndex(nodes, opts);
    const factoryClasses = new Map();
    const seenEdges = new Set();
    const emitLuauEdge = (source, target, relation, confidence) => {
        if (!source || !target || source === target)
            return;
        const key = `${source}\0${target}\0${relation}`;
        if (seenEdges.has(key))
            return;
        seenEdges.add(key);
        addEdge(source, target, relation, confidence);
    };

    resolveLuauImportsPass(luauRaw, luauIdx, factoryClasses, emitLuauEdge);
    for (const e of luauRaw) {
        resolveLuauCallOrRefEdge(e, luauIdx, factoryClasses, emitLuauEdge);
    }
}

