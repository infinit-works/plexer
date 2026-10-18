/**
 * Luau depth-equivalent extractor & module-aware edge resolver for plexer (v4).
 * Installed by `scripts/plexer_luau.py`.
 */
import { join, posix, resolve } from "node:path";
import { spanRange } from "../blast/evidence.js";
import { contentHash } from "../util/id.js";
import { pushMap } from "../util/paths.js";
import { readJson } from "../util/state.js";
import { extractLeadingSummary, fileResidual, mintId, searchBody } from "./extract.js";
import { KIND, defScope, enclosingDef } from "./generic.js";
import { stripNodeOrdinals } from "./traverse.js";

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

export function moduleStem(rel) {
    const parts = rel.replace(/\.luau$/i, "").split("/");
    const last = parts[parts.length - 1] ?? rel;
    if ((last === "init" || last.startsWith("init.")) && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return last.replace(/\.(client|server|spec|d)$/i, "");
}

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

function evalInstancePath(rawNode, instancePaths, isRootContainerTable) {
    const node = unwrapExpr(rawNode);
    if (!node)
        return null;
    if (node.type === "binary_expression") {
        return evalInstancePath(node.namedChild(1), instancePaths, isRootContainerTable) ?? evalInstancePath(node.namedChild(0), instancePaths, isRootContainerTable);
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
        const tbl = node.childForFieldName("table");
        const fld = node.childForFieldName("field");
        if (!tbl || !fld)
            return null;
        const tblChain = extractAccessChain(tbl);
        if (tblChain && isRootContainerTable && (isRootContainerTable(tblChain[tblChain.length - 1]) || isRootContainerTable(tblChain[0]))) {
            if (fld.text === "script")
                return { base: "root", parents: 0, parts: [] };
            if (/^[A-Z][A-Za-z0-9_]*$/.test(fld.text))
                return { base: "root", parents: 0, parts: [fld.text] };
        }
        const basePath = evalInstancePath(tbl, instancePaths, isRootContainerTable);
        return basePath ? applyPathStep(basePath, fld.text) : null;
    }
    if (node.type === "bracket_index_expression") {
        const tbl = node.childForFieldName("table") ?? node.namedChild(0);
        const idx = node.childForFieldName("field") ?? node.namedChild(1);
        const key = extractStringLiteral(idx);
        const basePath = evalInstancePath(tbl, instancePaths, isRootContainerTable);
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
                const basePath = evalInstancePath(tbl, instancePaths, isRootContainerTable);
                return basePath && childName ? applyPathStep(basePath, childName) : null;
            }
            if (mth === "Clone") {
                return evalInstancePath(tbl, instancePaths, isRootContainerTable);
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

function parseRequireSpec(argNode, instancePaths, isRootContainerTable) {
    const n = unwrapExpr(argNode);
    if (!n)
        return null;
    const str = extractStringLiteral(n);
    if (str)
        return str;
    const instPath = evalInstancePath(n, instancePaths, isRootContainerTable);
    if (instPath)
        return instancePathToSpec(instPath);
    return null;
}

function extractRequireSpec(rawNode, instancePaths, isRootContainerTable) {
    const node = unwrapExpr(rawNode);
    if (!node || node.type !== "function_call")
        return null;
    const fn = unwrapExpr(node.childForFieldName("name"));
    if (!fn || fn.type !== "identifier" || fn.text !== "require")
        return null;
    const args = node.childForFieldName("arguments");
    if (!args)
        return null;
    return parseRequireSpec(args.namedChild(0), instancePaths, isRootContainerTable);
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
        if ((k?.text === "name" || k?.text === "Name") && v?.type === "string") {
            const txt = extractStringLiteral(v);
            if (txt && /^[A-Za-z_][\w-]*$/.test(txt))
                return { prefix: txt, isExplicitName: k.text === "name" };
        }
    }
    return null;
}

function enclosingTableContext(fieldNode, isPrimaryTable, inChunkFn, fieldDefCounts) {
    const sib = tableSiblingName(fieldNode);
    if (sib) {
        return { prefix: sib.prefix, exported: sib.isExplicitName };
    }
    const tbl = fieldNode.parent;
    if (!tbl || tbl.type !== "table_constructor")
        return null;
    const fname = fieldNode.childForFieldName("name")?.text ?? "";
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
            const dupCount = fieldDefCounts.get(fname) ?? 0;
            if (chain.length > 1 || inChunkFn || dupCount > 1 || /^(?:[A-Z_]{2,}|type[A-Z])/.test(varName)) {
                const prefix = chain.length > 1 && isPrimaryTable(chain[0])
                    ? chain.slice(1).join(".")
                    : chain.join(".");
                return { prefix, exported: !isInsideNestedFunction(p2) };
            }
            return { prefix: null, exported: !isInsideNestedFunction(p2) };
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
    let tree;
    try {
        let parser = LUAU_PARSERS.get(entry.language);
        if (!parser) {
            parser = new tsMod.Parser();
            parser.setLanguage(entry.language);
            LUAU_PARSERS.set(entry.language, parser);
        }
        tree = parser.parse((i) => normSource.slice(i, i + PARSE_CHUNK));
    }
    catch (err) {
        throw new Error(`luau grammar threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!tree)
        return { nodes, rawEdges };

    try {
    const stem = moduleStem(rel);
    const isRootInit = rel === "src/init.luau" || rel === "init.luau";
    const returnedTable = findReturnedTableName(tree.rootNode);
    const chunkParam = findChunkReturnedFunctionParam(tree.rootNode);
    const candidateTables = new Set([returnedTable, chunkParam].filter(Boolean));
    const rootImportedTables = new Set([chunkParam, isRootInit ? returnedTable : null].filter(Boolean));
    const augmentedTables = new Set();
    const paramNames = new Set();

    const prescanAst = (n) => {
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
            prescanAst(n.namedChild(i));
    };
    prescanAst(tree.rootNode);

    if (isRootInit || chunkParam) {
        fileNode.barrelTable = returnedTable || chunkParam || stem;
    }
    const isBarrelTarget = (tname) =>
        Boolean(tname) &&
        (tname === chunkParam ||
            (isRootInit && tname === returnedTable) ||
            (augmentedTables.has(tname) && rootImportedTables.has(tname)));
    const isRootContainerTable = (tname) => isBarrelTarget(tname);
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

    const minted = new Set([rel]);
    const spanSeen = new Set();
    const defs = [];
    const defNameAt = new Set();

    const mkDef = (name, kind, whole, exported = true) => {
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
    };

    // Count duplicate table field function names across the file for disambiguation
    const fieldDefCounts = new Map();
    const countFields = (n) => {
        if (n.type === "field") {
            const k = n.childForFieldName("name");
            const v = unwrapFunctionDef(n.childForFieldName("value"));
            if (k && v) {
                fieldDefCounts.set(k.text, (fieldDefCounts.get(k.text) ?? 0) + 1);
            }
        }
        for (let i = 0; i < n.namedChildCount; i++)
            countFields(n.namedChild(i));
    };
    countFields(tree.rootNode);

    if (entry.query) {
        for (const m of entry.query.matches(tree.rootNode)) {
            const cap = {};
            for (const c of m.captures)
                cap[c.name] = c.node;
            const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
            if (defKey && cap.name) {
                const rawDefNode = cap[defKey];
                const whole = defScope(rawDefNode);
                const inNestedFn = isInsideNestedFunction(whole);
                const inChunkFn = isInsideChunkReturnedFunction(whole);
                let symName = cap.name.text;
                let exported = !inNestedFn;

                if (rawDefNode.type === "field") {
                    const ctx = enclosingTableContext(rawDefNode, isPrimaryTable, inChunkFn, fieldDefCounts);
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
                mkDef(symName, KIND[defKey.slice("definition.".length)] ?? "function", whole, exported);
            }
        }
    }

    // Second pass for cast-wrapped / debounce-wrapped / multi-hop function assignments missed by tags.scm
    const visitExtraDefs = (n) => {
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
                        mkDef(symName, "function", n, exported);
                    }
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++)
            visitExtraDefs(n.namedChild(i));
    };
    visitExtraDefs(tree.rootNode);

    const instancePaths = new Map();
    const reqBindings = new Map();
    const localTables = new Set();
    const submodules = {};
    const barrelExports = {};
    const rawCalls = [];
    const rawRefs = [];

    for (const tr of typeofReqs) {
        rawEdges.push({ source: rel, relation: "imports", specifier: tr.spec, file: rel });
        if (tr.field) {
            submodules[tr.field] = { spec: tr.spec, chain: [] };
        }
    }

    const resolveRhsModuleTarget = (rawRhs) => {
        const rhs = unwrapExpr(rawRhs);
        if (!rhs)
            return null;
        if (rhs.type === "binary_expression") {
            return resolveRhsModuleTarget(rhs.namedChild(1)) ?? resolveRhsModuleTarget(rhs.namedChild(0));
        }
        if (rhs.type === "if_expression") {
            for (let i = 1; i < rhs.namedChildCount; i++) {
                const hit = resolveRhsModuleTarget(rhs.namedChild(i));
                if (hit)
                    return hit;
            }
            return null;
        }
        const directSpec = extractRequireSpec(rhs, instancePaths, isRootContainerTable);
        if (directSpec)
            return { spec: directSpec, chain: [] };
        if (rhs.type === "identifier") {
            if (rhs.text === "script")
                return { spec: "@self", chain: [] };
            if (reqBindings.has(rhs.text)) {
                const b = reqBindings.get(rhs.text);
                return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? [])] };
            }
            const inst = evalInstancePath(rhs, instancePaths, isRootContainerTable);
            if (inst)
                return { spec: instancePathToSpec(inst), chain: [] };
        }
        if (rhs.type === "dot_index_expression") {
            const tbl = rhs.childForFieldName("table");
            const fld = rhs.childForFieldName("field");
            if (tbl && fld) {
                const tblSpec = extractRequireSpec(tbl, instancePaths, isRootContainerTable);
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
    };

    const exportLocalAlias = (fullKey, targetName, siteNode) => {
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
    };

    const recordTableFields = (tblNode, prefixChain, isBarrel, isPrimaryTarget) => {
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
                exportLocalAlias(fullKey, v.text, f);
            }
            const modTarget = resolveRhsModuleTarget(v);
            if (modTarget) {
                if (isPrimaryTarget)
                    submodules[fullKey] = modTarget;
                if (isBarrel)
                    barrelExports[fullKey] = modTarget;
            }
            else if (v.type === "table_constructor") {
                recordTableFields(v, [...prefixChain, k], isBarrel, isPrimaryTarget);
            }
        }
    };

    const visitBindings = (n) => {
        if (n.type === "function_call") {
            const spec = extractRequireSpec(n, instancePaths, isRootContainerTable);
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
                    if (!lhs || !rhs)
                        continue;
                    if (lhs.type === "identifier") {
                        const instPath = evalInstancePath(rhs, instancePaths, isRootContainerTable);
                        if (instPath) {
                            instancePaths.set(lhs.text, instPath);
                        }
                        const modTarget = resolveRhsModuleTarget(rhs);
                        if (modTarget) {
                            reqBindings.set(lhs.text, modTarget);
                        }
                        const unwRhs = unwrapExpr(rhs);
                        if (unwRhs?.type === "table_constructor") {
                            localTables.add(lhs.text);
                            const isPrim = isPrimaryTable(lhs.text);
                            const isBarrel = isBarrelTarget(lhs.text) || isRootInit;
                            if (isPrim || isBarrel) {
                                recordTableFields(unwRhs, [], isBarrel, isPrim);
                            }
                        }
                    }
                    else {
                        const lhsChain = extractAccessChain(lhs);
                        if (lhsChain && lhsChain.length >= 2) {
                            const isBarrel = isBarrelTarget(lhsChain[0]);
                            const isPrim = isPrimaryTable(lhsChain[0]);
                            const subChain = lhsChain.slice(1);
                            if (subChain.length > 0) {
                                const modTarget = resolveRhsModuleTarget(rhs);
                                if (modTarget) {
                                    const key = subChain.join(".");
                                    if (isPrim)
                                        submodules[key] = modTarget;
                                    if (isBarrel)
                                        barrelExports[key] = modTarget;
                                }
                                else {
                                    const unwRhs = unwrapExpr(rhs);
                                    if (unwRhs?.type === "table_constructor" && (isPrim || isBarrel)) {
                                        recordTableFields(unwRhs, subChain, isBarrel, isPrim);
                                    }
                                    else if (isPrim && unwRhs?.type === "identifier") {
                                        exportLocalAlias(subChain.join("."), unwRhs.text, n);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (n.type === "return_statement" && n.parent?.type === "chunk") {
            const exprList = n.namedChild(0);
            const val = unwrapExpr(exprList?.namedChild(0));
            if (val?.type === "function_definition") {
                mkDef(stem, "function", val, true);
            }
            else if (val?.type === "table_constructor") {
                recordTableFields(val, [], isRootInit, true);
            }
            else if (val?.type === "function_call") {
                const firstArg = unwrapExpr(val.childForFieldName("arguments")?.namedChild(0));
                if (firstArg?.type === "table_constructor") {
                    recordTableFields(firstArg, [], isRootInit, true);
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++)
            visitBindings(n.namedChild(i));
    };
    visitBindings(tree.rootNode);

    if (Object.keys(submodules).length > 0) {
        fileNode.submodules = submodules;
    }
    if (Object.keys(barrelExports).length > 0) {
        fileNode.barrelExports = barrelExports;
    }

    let delegateSpec = null;
    const findDelegate = (n) => {
        if (n.type === "return_statement" && n.parent?.type === "chunk") {
            const val = unwrapExpr(n.namedChild(0)?.namedChild(0));
            if (val?.type === "identifier" && reqBindings.has(val.text)) {
                const b = reqBindings.get(val.text);
                if (b.spec && (!b.chain || b.chain.length === 0))
                    delegateSpec = b.spec;
            }
        }
        if (n.type === "field") {
            const fn = n.childForFieldName("name");
            const fv = unwrapExpr(n.childForFieldName("value"));
            if (fn?.text === "__index" && fv?.type === "identifier" && reqBindings.has(fv.text)) {
                const b = reqBindings.get(fv.text);
                if (b.spec && (!b.chain || b.chain.length === 0))
                    delegateSpec = b.spec;
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
                        delegateSpec = b.spec;
                }
            }
        }
        for (let i = 0; i < n.namedChildCount; i++)
            findDelegate(n.namedChild(i));
    };
    findDelegate(tree.rootNode);
    if (delegateSpec) {
        fileNode.delegateSpec = delegateSpec;
    }

    const visitReexports = (n) => {
        if (n.type === "field" && !isInsideNestedFunction(n)) {
            const fname = n.childForFieldName("name");
            const fval = unwrapExpr(n.childForFieldName("value"));
            if (fname?.type === "identifier" && fval?.type === "dot_index_expression") {
                const chain = extractAccessChain(fval);
                if (chain && chain.length >= 2 && reqBindings.has(chain[0])) {
                    const b = reqBindings.get(chain[0]);
                    if (b.spec && (!b.chain || b.chain.length === 0) && chain.length === 2) {
                        defNameAt.add(fname.startIndex);
                        const d = mkDef(fname.text, "function", n, true);
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
            visitReexports(n.namedChild(i));
    };
    visitReexports(tree.rootNode);

    const enclosing = (at) => enclosingDef(defs, at);

    const sameFileFnNames = new Set(defs.filter((d) => d.kind === "function" || d.kind === "method").map((d) => d.name));

    const recordChainCall = (chain, at, extra = {}) => {
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
    };

    const visitCallsAndTypes = (n) => {
        if (n.type === "function_call") {
            const rawCallee = n.childForFieldName("name");
            const callee = unwrapExpr(rawCallee);
            const args = n.childForFieldName("arguments");

            if (callee) {
                // 1. Dynamic `:GetChildren()` loader (`for _, child in Shared.DefaultTypes:GetChildren()`)
                if (callee.type === "method_index_expression") {
                    const mth = callee.childForFieldName("method")?.text;
                    const tbl = callee.childForFieldName("table");
                    if (mth === "GetChildren") {
                        const dirPath = evalInstancePath(tbl, instancePaths, isRootContainerTable);
                        const dirSpec = instancePathToSpec(dirPath);
                        if (dirSpec) {
                            const enc = enclosing(n.startIndex);
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

                // 2. Direct call on `require(...)` (`require(Server)(app)`, `require(script.DefaultProperties)(UI)`)
                if (callee.type === "function_call") {
                    const reqSpec = extractRequireSpec(callee, instancePaths, isRootContainerTable);
                    if (reqSpec) {
                        rawCalls.push({ at: callee.startIndex, name: stem, specifier: reqSpec, chain: [], directModuleCall: true });
                    }
                }

                // 3. Inline `require(...).fn(...)`
                if (callee.type === "dot_index_expression" || callee.type === "method_index_expression") {
                    const tbl = callee.childForFieldName("table");
                    const fld = callee.childForFieldName("field") ?? callee.childForFieldName("method");
                    const reqSpec = extractRequireSpec(tbl, instancePaths, isRootContainerTable);
                    if (reqSpec && fld) {
                        rawCalls.push({ at: fld.startIndex, name: fld.text, specifier: reqSpec, chain: [fld.text] });
                    }
                }

                // 4. Dotted/method/identifier call chain
                const chain = extractAccessChain(callee);
                if (chain) {
                    const at = (callee.childForFieldName?.("field") ?? callee.childForFieldName?.("method") ?? callee).startIndex;
                    recordChainCall(chain, at);

                    // 4a. String-keyed class/component factory call (`Mod.new "ClassName"` or `Mod.new("ClassName")`)
                    const last = chain[chain.length - 1];
                    if ((last === "new" || last === "create") && chain.length >= 2 && !LUAU_STDLIB_TABLES.has(chain[0]) && args) {
                        const className = extractStringLiteral(args);
                        if (className && /^[A-Z][A-Za-z0-9_]*$/.test(className)) {
                            rawCalls.push({ at, name: last, factoryClass: className });
                        }
                    }
                }

                // 5. Higher-order function, callback & ModuleScript instance-path arguments
                if (args) {
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
                            const modPath = evalInstancePath(arg, instancePaths, isRootContainerTable);
                            if (modPath && (modPath.parts.length > 0 || modPath.parents > 0)) {
                                const modSpec = instancePathToSpec(modPath);
                                if (modSpec) {
                                    rawEdges.push({ source: rel, relation: "imports", specifier: modSpec, file: rel });
                                }
                            }
                        }
                        if (arg.type === "identifier") {
                            if (sameFileFnNames.has(arg.text) || reqBindings.has(arg.text)) {
                                recordChainCall([arg.text], arg.startIndex, { sameFileOnly: !reqBindings.has(arg.text) });
                            }
                        }
                        else if (isHigherOrder && arg.type === "dot_index_expression") {
                            const argChain = extractAccessChain(arg);
                            if (argChain && argChain.length >= 2) {
                                recordChainCall(argChain, arg.startIndex);
                            }
                        }
                    }
                }
            }
        }
        else if (n.type === "field") {
            // Table field referencing a local function identifier (`validate = parseBan`)
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
            visitCallsAndTypes(n.namedChild(i));
    };
    visitCallsAndTypes(tree.rootNode);

    for (const c of rawCalls) {
        const enc = enclosing(c.at);
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
        const enc = enclosing(r.at);
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
    try {
        return [process.cwd()];
    }
    catch {
        return [];
    }
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

export function resolveLuauSpecifier(spec, file, byId, luaurcAliases, rojoMounts) {
    const baseDir = posix.dirname(file);
    if (spec === "@root" || spec.startsWith("@root/")) {
        const rel = spec === "@root" ? "" : spec.slice(6);
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
        return checkLuauCandidates(baseDir ? posix.join(baseDir, rel) : rel, byId, rojoMounts) ?? spec;
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

function resolveLuauDirSpecifier(spec, file, allDirs, rojoMounts) {
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
        return tryDir(baseDir ? posix.join(baseDir, rel) : rel);
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

export function resolveLuauEdges(nodes, rawEdges, addEdge, opts = {}) {
    const luauRaw = rawEdges.filter((e) => e.file?.endsWith(".luau"));
    if (luauRaw.length === 0)
        return;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const perFileName = new Map();
    const globalName = new Map();
    const allDirs = new Set();
    const factoryClasses = new Map();
    const luauFiles = [];
    const barrelRoutes = new Map();
    const barrelSymbols = new Map();
    const barrelFileSet = new Set();
    const barrelTableNames = new Set();

    for (const n of nodes) {
        if (n.kind === "file") {
            if (n.path.endsWith(".luau")) {
                luauFiles.push(n);
                allDirs.add(posix.dirname(n.path));
                if (n.path === "src/init.luau" || n.path === "init.luau") {
                    barrelFileSet.add(n.path);
                }
            }
            if (n.barrelTable) {
                barrelTableNames.add(n.barrelTable);
            }
            if (n.isBarrelContributor) {
                barrelFileSet.add(n.path);
            }
            if (n.barrelExports) {
                for (const [k, target] of Object.entries(n.barrelExports)) {
                    if (!barrelRoutes.has(k)) {
                        barrelRoutes.set(k, { fromFile: n.path, ...target });
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
            for (const sNode of list) {
                pushMap(barrelSymbols, sym, sNode);
            }
        }
    }

    const pickUnique = (cands) => {
        if (cands.length === 1)
            return cands[0];
        if (cands.length > 1) {
            const exp = cands.filter((n) => n.exported);
            if (exp.length === 1)
                return exp[0];
        }
        return null;
    };

    const seenEdges = new Set();
    const add = (source, target, relation, confidence) => {
        if (!source || !target || source === target)
            return;
        const key = `${source}\0${target}\0${relation}`;
        if (seenEdges.has(key))
            return;
        seenEdges.add(key);
        addEdge(source, target, relation, confidence);
    };

    // Pass 1: resolve module imports and `:GetChildren()` dynamic child loaders (populating `factoryClasses`)
    for (const e of luauRaw) {
        if (e.relation === "imports" && e.specifier) {
            const target = resolveLuauSpecifier(e.specifier, e.file, byId, aliases, rojoMounts);
            if (byId.has(target))
                add(e.source, target, "imports", "extracted");
        }
        else if (e.relation === "imports_children" && e.specifier) {
            const dir = resolveLuauDirSpecifier(e.specifier, e.file, allDirs, rojoMounts);
            if (dir) {
                for (const n of luauFiles) {
                    const pDir = posix.dirname(n.path);
                    const isDirectChild = (pDir === dir && !isInitLuau(n.path)) || (posix.dirname(pDir) === dir && isInitLuau(n.path));
                    if (isDirectChild) {
                        add(e.file, n.path, "imports", "extracted");
                        const stem = moduleStem(n.path);
                        const fm = perFileName.get(n.path);
                        if (fm?.has("new")) {
                            factoryClasses.set(stem, n.path);
                        }
                        const initFn = pickUnique((fm?.get(stem) ?? []).filter((s) => s.kind === "function"));
                        if (initFn) {
                            add(e.callerId || e.file, initFn.id, "calls", "extracted");
                        }
                    }
                }
            }
        }
    }

    const getSubmoduleTarget = (fileId, key) => {
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
            cur = resolveLuauSpecifier(fn.delegateSpec, cur, byId, aliases, rojoMounts);
        }
        return null;
    };

    const resolveChainTarget = (startSpec, startBarrel, fromFile, rawChain, kinds, directModuleCall = false, recvName = null) => {
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
                    curFile = resolveLuauSpecifier(matchedRoute.spec, matchedRoute.fromFile, byId, aliases, rojoMounts);
                    rem = [...(matchedRoute.chain ?? []), ...rem.slice(matchedLen)];
                    if (rem.length === 0)
                        isDirect = true;
                }
            }
            else if (explicitBarrel) {
                const fullSym = rem.join(".");
                const leafSym = rem[rem.length - 1];
                const cands = (barrelSymbols.get(fullSym) ?? barrelSymbols.get(leafSym) ?? []).filter((n) => kinds.includes(n.kind));
                const picked = pickUnique(cands);
                if (picked)
                    return { node: picked, moduleFile: picked.path };
                return null;
            }
            else {
                return null;
            }
        }
        else if (startSpec) {
            curFile = resolveLuauSpecifier(startSpec, fromFile, byId, aliases, rojoMounts);
        }

        if (!curFile || !byId.has(curFile))
            return null;

        // Hop through nested submodule barrel tables (`Util.Table.merge`, `Data.Store.load`, etc.)
        for (let hop = 0; hop < 5 && rem.length >= 1; hop++) {
            let advanced = false;
            for (let len = rem.length; len >= 1; len--) {
                const subKey = rem.slice(0, len).join(".");
                const subTarget = getSubmoduleTarget(curFile, subKey) ?? (barrelFileSet.has(curFile) ? barrelRoutes.get(subKey) : null);
                if (subTarget && subTarget.spec) {
                    const nextFile = resolveLuauSpecifier(subTarget.spec, subTarget.fromFile, byId, aliases, rojoMounts);
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
                const pickedBarrel = pickUnique(cands);
                if (pickedBarrel)
                    return { node: pickedBarrel, moduleFile: pickedBarrel.path };
            }
            if (cands.length === 0 && (isDirect || rem.length === 0)) {
                const stem = moduleStem(walkFile);
                cands = (fm?.get(stem) ?? fm?.get("new") ?? []).filter((n) => kinds.includes(n.kind));
            }
            const picked = pickUnique(cands);
            if (picked)
                return { node: picked, moduleFile: curFile };
            if (cands.length > 1)
                return { node: null, moduleFile: curFile };
            if (!fnode.delegateSpec)
                break;
            walkFile = resolveLuauSpecifier(fnode.delegateSpec, walkFile, byId, aliases, rojoMounts);
        }
        return { node: null, moduleFile: curFile };
    };

    for (const e of luauRaw) {
        if (e.relation === "references" && e.name) {
            if (e.specifier || e.barrel) {
                const res = resolveChainTarget(e.specifier, e.barrel, e.file, e.chain ?? [e.name], ["type"]);
                if (res?.moduleFile)
                    add(e.file, res.moduleFile, "imports", "extracted");
                if (res?.node)
                    add(e.source, res.node.id, "references", "extracted");
            }
            else {
                const local = pickUnique((perFileName.get(e.file)?.get(e.name) ?? []).filter((n) => n.kind === "type"));
                if (local)
                    add(e.source, local.id, "references", "extracted");
            }
        }
        else if (e.relation === "calls" && e.name) {
            const callKinds = ["function", "method"];
            if (e.factoryClass) {
                const classFile = factoryClasses.get(e.factoryClass);
                if (classFile) {
                    add(e.file, classFile, "imports", "extracted");
                    const newFn = pickUnique((perFileName.get(classFile)?.get(e.name) ?? perFileName.get(classFile)?.get("new") ?? []).filter((n) => callKinds.includes(n.kind)));
                    if (newFn)
                        add(e.source, newFn.id, "calls", "extracted");
                }
                continue;
            }
            const isBarrelCall = Boolean(e.barrel || (e.recvName && barrelTableNames.has(e.recvName)) || (e.chain?.length >= 2 && barrelTableNames.has(e.chain[0])));
            if (e.specifier || isBarrelCall) {
                const res = resolveChainTarget(e.specifier, isBarrelCall, e.file, e.chain ?? [e.name], callKinds, e.directModuleCall, e.recvName);
                if (res?.moduleFile)
                    add(e.file, res.moduleFile, "imports", "extracted");
                if (res?.node) {
                    add(e.source, res.node.id, "calls", "extracted");
                    continue;
                }
                if (!e.fallbackSameFile)
                    continue;
            }
            let local = pickUnique((perFileName.get(e.file)?.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind)));
            if (!local && e.fallbackName) {
                local = pickUnique((perFileName.get(e.file)?.get(e.fallbackName) ?? []).filter((n) => callKinds.includes(n.kind)));
            }
            if (local) {
                add(e.source, local.id, "calls", "extracted");
                continue;
            }
            if (e.sameFileOnly || e.fallbackSameFile)
                continue;
            const global = (globalName.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind) && n.path.endsWith(".luau"));
            const pickedGlobal = pickUnique(global);
            if (pickedGlobal) {
                add(e.source, pickedGlobal.id, "calls", "inferred");
            }
        }
    }
}

/**
 * Resolve Luau symbol/file queries for `plexer callers`:
 *   - `src/Shared/Validate.luau#check` or `Validate.luau#check`
 *   - `Validate.luau` (file node match before `.luau` is split as a method name)
 *   - `Validate.check` or `Core:Destroy` or `CommandBar.mount` (module stem + member name)
 */
export function matchLuauSymbol(nodes, lowerQuery, edges) {
    const rawNorm = lowerQuery.replace(/:/g, ".");
    const barrelPrefixes = new Set();
    for (const n of nodes) {
        if (n.kind === "file" && n.barrelTable) {
            barrelPrefixes.add(n.barrelTable.toLowerCase());
        }
    }
    const candidates = [rawNorm];
    const firstDot = rawNorm.indexOf(".");
    if (firstDot > 0) {
        const prefix = rawNorm.slice(0, firstDot);
        const rest = rawNorm.slice(firstDot + 1);
        if (rest && (barrelPrefixes.has(prefix) || rest.includes("."))) {
            candidates.push(rest);
        }
    }
    const unwrapReexports = (list) => {
        if (!edges || list.length === 0)
            return list;
        let byId = null;
        return list.map((h) => {
            const range = spanRange(h.span);
            if (range && range.start === range.end) {
                const outCalls = edges.filter((e) => e.source === h.id && e.relation === "calls");
                if (outCalls.length === 1) {
                    byId ??= new Map(nodes.map((n) => [n.id, n]));
                    const target = byId.get(outCalls[0].target);
                    if (target && target.name.toLowerCase() === h.name.toLowerCase())
                        return target;
                }
            }
            return h;
        });
    };
    for (const norm of candidates) {
        if (norm.includes("#")) {
            const hits = unwrapReexports(nodes.filter((n) => {
                if (n.kind === "file")
                    return false;
                const cand = stripNodeOrdinals(n);
                return cand === norm || cand.endsWith("/" + norm);
            }));
            if (hits.length > 0)
                return hits;
            continue;
        }
        if (norm.endsWith(".luau")) {
            const hits = nodes.filter((n) =>
                n.kind === "file" &&
                (n.name.toLowerCase() === norm || n.path.toLowerCase() === norm || n.path.toLowerCase().endsWith("/" + norm))
            );
            if (hits.length > 0)
                return hits;
            continue;
        }
        if (norm.includes(".")) {
            const dot = norm.lastIndexOf(".");
            const modPart = norm.slice(0, dot).replace(/\./g, "/");
            const symPart = norm.slice(dot + 1);
            if (modPart && symPart) {
                const modSuffixes = [
                    `${modPart}.luau#${symPart}`,
                    `${modPart}/init.luau#${symPart}`,
                    `${modPart}/init.client.luau#${symPart}`,
                    `${modPart}/init.server.luau#${symPart}`,
                ];
                const filterBySuffixes = (sufs) => nodes.filter((n) => {
                    if (n.kind === "file")
                        return false;
                    const cand = stripNodeOrdinals(n);
                    return sufs.some((s) => cand === s || cand.endsWith("/" + s) || (s.startsWith("#") && cand.endsWith(s)));
                });
                let hits = filterBySuffixes(modSuffixes);
                if (hits.length === 0)
                    hits = filterBySuffixes([`#${norm}`]);
                if (hits.length > 1) {
                    const exp = hits.filter((n) => n.exported);
                    if (exp.length > 0)
                        hits = exp;
                }
                if (hits.length > 0)
                    return unwrapReexports(hits);
            }
        }
        const fileStemHits = nodes.filter((n) =>
            n.kind === "file" &&
            n.path.endsWith(".luau") &&
            moduleStem(n.path).toLowerCase() === norm
        );
        if (fileStemHits.length > 0 && !nodes.some((n) => n.kind !== "file" && n.name.toLowerCase() === norm))
            return fileStemHits;
    }
    return [];
}
