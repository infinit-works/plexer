/**
 * Luau depth-equivalent extractor & module-aware edge resolver for plexer.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { moduleStem } from "../context/symbol-query.js";
import { contentHash, fileResidual, GENERIC_MEMBER_NAMES, isCompoundIdentifierName, mintId, searchBody } from "../util/id.js";
import { pushMap } from "../util/paths.js";
import { readJson } from "../util/state.js";
import { KIND, defScope, enclosingDef, extractLeadingSummary } from "./extract/ast.js";

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

/** If `src[bracketIdx]` starts a Lua/Luau long bracket `[=*[`, return the index just after its matching `]=*]`, else -1. */
function scanLuauLongBracketEnd(src, bracketIdx) {
    if (src[bracketIdx] !== "[")
        return -1;
    let j = bracketIdx + 1;
    let eqs = 0;
    while (j < src.length && src[j] === "=") {
        eqs++;
        j++;
    }
    if (src[j] !== "[")
        return -1;
    const close = "]" + "=".repeat(eqs) + "]";
    const hit = src.indexOf(close, j + 1);
    return hit >= 0 ? hit + close.length : src.length;
}

function skipLuauQuotedString(src, i) {
    const quote = src[i];
    i++;
    while (i < src.length && src[i] !== quote && src[i] !== "\n") {
        if (src[i] === "\\")
            i++;
        i++;
    }
    if (i < src.length && src[i] === quote)
        i++;
    return i;
}

function maskLuauProtectedSpans(src) {
    const saved = [];
    let out = "";
    let last = 0;
    let i = 0;
    const stash = (start, end) => {
        const raw = src.slice(start, end);
        const nl = (raw.match(/\n/g) || []).length;
        const idx = saved.length;
        saved.push(raw);
        out += src.slice(last, start) + `\uE8F0${idx}${"\n".repeat(nl)}\uE8F1`;
        last = end;
    };
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === "`") {
            i = skipLuauQuotedString(src, i);
            continue;
        }
        if (ch === "-" && src[i + 1] === "-") {
            const blkEnd = scanLuauLongBracketEnd(src, i + 2);
            if (blkEnd >= 0) {
                stash(i, blkEnd);
                i = blkEnd;
                continue;
            }
            while (i < src.length && src[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "[") {
            const strEnd = scanLuauLongBracketEnd(src, i);
            if (strEnd >= 0) {
                stash(i, strEnd);
                i = strEnd;
                continue;
            }
        }
        i++;
    }
    return { text: out + src.slice(last), saved };
}

function skipLuauCommentOrLiteral(src, i) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`")
        return skipLuauQuotedString(src, i);
    if (ch === "-" && src[i + 1] === "-") {
        const blkEnd = scanLuauLongBracketEnd(src, i + 2);
        if (blkEnd >= 0)
            return blkEnd;
        let end = i + 2;
        while (end < src.length && src[end] !== "\n")
            end++;
        return end;
    }
    if (ch === "[")
        return scanLuauLongBracketEnd(src, i);
    return -1;
}
function findMatchingTypeofEnd(src, startIdx) {
    let i = startIdx;
    let depth = 1;
    while (i < src.length && depth > 0) {
        const skipped = skipLuauCommentOrLiteral(src, i);
        if (skipped >= 0) {
            i = skipped;
            continue;
        }
        if (src[i] === "(")
            depth++;
        else if (src[i] === ")")
            depth--;
        i++;
    }
    return depth === 0 ? i : -1;
}
function stripBalancedTypeof(src) {
    const re = /(::|[:|&<,={(]|->)\s*typeof\s*\(/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
        const start = m.index + m[1].length;
        const end = findMatchingTypeofEnd(src, re.lastIndex);
        if (end < 0)
            continue;
        const newlines = (src.slice(start, end).match(/\n/g) || []).join("");
        out += src.slice(last, start) + " any" + newlines;
        last = end;
        re.lastIndex = end;
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

function isRawTypeofTypeContext(rawSource, matchIndex, hasFieldColon) {
    if (hasFieldColon)
        return true;
    const before = rawSource.slice(Math.max(0, matchIndex - 240), matchIndex).trimEnd();
    if (/(?:::|:(?!=)|->|[|&<])\s*$/.test(before))
        return true;
    const stmtTail = before.slice(Math.max(0, before.lastIndexOf("\n") - 80));
    if (/(?:^|[\n;])\s*(?:export\s+)?type\s+[A-Za-z_]\w*[\s\S]*$/.test(stmtTail))
        return true;
    return /:\s*[^=\n]*$/.test(before);
}

/**
 * Extract `require(...)` inside `typeof(...)` before `stripBalancedTypeof` replaces them with `any`.
 */
function extractTypeofRequires(rawSource) {
    const results = [];
    const re = /(?:([A-Za-z_]\w*)\s*:\s*)?typeof\s*\(\s*require\s*\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)\s*\)/g;
    let m;
    while ((m = re.exec(rawSource)) !== null) {
        const rawArg = m[2].trim();
        const strMatch = /^["']([^"'\n]+)["']$/.exec(rawArg);
        const typeOnly = isRawTypeofTypeContext(rawSource, m.index, Boolean(m[1]));
        results.push({
            field: m[1] || null,
            spec: strMatch ? strMatch[1].trim() : null,
            argExpr: strMatch ? null : rawArg,
            typeOnly,
        });
    }
    return results;
}

/**
 * Line-preserving pre-parse normalizer so tree-sitter-luau 1.2.0 (2023) parses
 * 2024-2026 Luau constructs without collapsing files into ERROR nodes.
 * Preserves exact line numbers (`startPosition.row` / `endPosition.row`).
 */
export function normalizeLuauForParse(src) {
    const { text: masked, saved } = maskLuauProtectedSpans(src);
    const normalized = stripBalancedTypeof(masked)
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
    if (saved.length === 0)
        return normalized;
    return normalized.replace(/\uE8F0(\d+)\n*\uE8F1/g, (_, idx) => saved[Number(idx)] ?? "");
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

function evalLuauIdentifierPath(node, instancePaths) {
    if (node.text === "script")
        return { base: "script", parents: 0, parts: [] };
    if (node.text === "game")
        return { base: "root", parents: 0, parts: [] };
    if (instancePaths?.has(node.text)) {
        const b = instancePaths.get(node.text);
        return { base: b.base, parents: b.parents, parts: [...b.parts] };
    }
    return null;
}

function evalLuauDotIndexPath(node, instancePaths, isBarrelTarget) {
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

function evalLuauCallPath(node, instancePaths, isBarrelTarget) {
    const callee = node.childForFieldName("name");
    const args = node.childForFieldName("arguments");
    if (callee?.type !== "method_index_expression")
        return null;
    const tbl = callee.childForFieldName("table");
    const mth = callee.childForFieldName("method")?.text;
    if (mth === "WaitForChild" || mth === "FindFirstChild") {
        const childName = extractStringLiteral(args);
        const basePath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
        return basePath && childName ? applyPathStep(basePath, childName) : null;
    }
    if (mth === "GetService" && tbl?.type === "identifier" && tbl.text === "game") {
        const svc = extractStringLiteral(args);
        return svc ? { base: "root", parents: 0, parts: [svc] } : null;
    }
    return mth === "Clone" ? evalInstancePath(tbl, instancePaths, isBarrelTarget) : null;
}

function evalInstancePath(rawNode, instancePaths, isBarrelTarget) {
    const node = unwrapExpr(rawNode);
    if (!node)
        return null;
    if (node.type === "binary_expression") {
        return evalInstancePath(node.namedChild(1), instancePaths, isBarrelTarget) ?? evalInstancePath(node.namedChild(0), instancePaths, isBarrelTarget);
    }
    if (node.type === "identifier")
        return evalLuauIdentifierPath(node, instancePaths);
    if (node.type === "dot_index_expression")
        return evalLuauDotIndexPath(node, instancePaths, isBarrelTarget);
    if (node.type === "bracket_index_expression") {
        const tbl = node.childForFieldName("table") ?? node.namedChild(0);
        const idx = node.childForFieldName("field") ?? node.namedChild(1);
        const key = extractStringLiteral(idx);
        const basePath = evalInstancePath(tbl, instancePaths, isBarrelTarget);
        return basePath && key ? applyPathStep(basePath, key) : null;
    }
    if (node.type === "function_call")
        return evalLuauCallPath(node, instancePaths, isBarrelTarget);
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

function prescanLuauAssignmentPair(lhs, rawRhs, candidateTables, rootImportedTables, augmentedTables) {
    const rhs = unwrapExpr(rawRhs);
    if (!lhs || !rhs)
        return;
    if (lhs.type === "identifier") {
        if (exprContainsRequire(rhs)) {
            candidateTables.add(lhs.text);
            rootImportedTables.add(lhs.text);
            return;
        }
        if (rhs.type === "dot_index_expression") {
            const rChain = extractAccessChain(rhs);
            if (rChain && rChain.length >= 2 && candidateTables.has(rChain[0]))
                candidateTables.add(lhs.text);
        }
        return;
    }
    const lChain = extractAccessChain(lhs);
    if (lChain && lChain.length >= 2 && candidateTables.has(lChain[0]))
        augmentedTables.add(lChain[0]);
}

function prescanLuauAssignment(n, candidateTables, rootImportedTables, augmentedTables) {
    const vars = n.namedChild(0);
    const exprs = n.namedChild(1);
    if (vars?.type !== "variable_list" || exprs?.type !== "expression_list")
        return;
    const count = Math.min(vars.namedChildCount, exprs.namedChildCount);
    for (let i = 0; i < count; i++) {
        prescanLuauAssignmentPair(vars.namedChild(i), exprs.namedChild(i), candidateTables, rootImportedTables, augmentedTables);
    }
}

function prescanLuauNode(n, candidateTables, rootImportedTables, augmentedTables, paramNames) {
    if (n.type === "parameters") {
        for (const p of extractParamNames(n))
            paramNames.add(p);
    }
    else if (n.type === "assignment_statement" && !isInsideNestedFunction(n)) {
        prescanLuauAssignment(n, candidateTables, rootImportedTables, augmentedTables);
    }
    else if (n.type === "function_declaration") {
        const chain = extractAccessChain(n.childForFieldName("name"));
        if (chain && chain.length >= 2 && candidateTables.has(chain[0]))
            augmentedTables.add(chain[0]);
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
        typeUsedReqVars: new Set(),
        runtimeUsedReqVars: new Set(),
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

function applyLuauChainMemberNaming(chain, inNestedFn, fileNode, isBarrelTarget, isPrimaryTable) {
    if (isBarrelTarget(chain[0]))
        fileNode.isBarrelContributor = true;
    if (isPrimaryTable(chain[0])) {
        return { symName: chain.slice(1).join("."), exported: !inNestedFn };
    }
    return { symName: chain.join("."), exported: false };
}

function resolveLuauMatchedDefMetadata(luauCtx, rawDefNode, defKey, capName, whole) {
    const { fileNode, isBarrelTarget, isPrimaryTable } = luauCtx;
    const inNestedFn = isInsideNestedFunction(whole);
    const inChunkFn = isInsideChunkReturnedFunction(whole);
    let symName = capName.text;
    let exported = !inNestedFn;
    let symKind = KIND[defKey.slice("definition.".length)] ?? "function";
    const origHeader = (luauCtx.lines?.[whole.startPosition.row] || "").trimStart();

    if (/^(?:export\s+)?type\s+function\b/.test(origHeader)) {
        symKind = "type";
        exported = !inNestedFn && origHeader.startsWith("export ");
    }
    else if (rawDefNode.type === "field") {
        const ctx = enclosingTableContext(rawDefNode, isPrimaryTable);
        if (!ctx?.prefix && inNestedFn) return null;
        if (ctx?.prefix) {
            symName = `${ctx.prefix}.${symName}`;
            exported = ctx.exported;
        }
    }
    else if (rawDefNode.type === "function_declaration") {
        const chain = extractAccessChain(rawDefNode.childForFieldName("name"));
        if (chain && chain.length >= 2) {
            ({ symName, exported } = applyLuauChainMemberNaming(chain, inNestedFn, fileNode, isBarrelTarget, isPrimaryTable));
        }
        else if (inNestedFn || inChunkFn || rawDefNode.text.trimStart().startsWith("local ")) {
            exported = false;
        }
    }
    else if (rawDefNode.type === "assignment_statement") {
        const chain = extractAccessChain(rawDefNode.namedChild(0)?.namedChild(0));
        if (chain && chain.length >= 2) {
            ({ symName, exported } = applyLuauChainMemberNaming(chain, inNestedFn, fileNode, isBarrelTarget, isPrimaryTable));
        }
        else {
            exported = false;
        }
    }
    else if (rawDefNode.type === "type_definition") {
        exported = rawDefNode.text.trimStart().startsWith("export ");
    }
    return { symName, symKind, exported };
}

function extractLuauQueryDefs(luauCtx, entry, rootNode) {
    if (!entry.query)
        return;
    for (const m of entry.query.matches(rootNode)) {
        const cap = {};
        for (const c of m.captures)
            cap[c.name] = c.node;
        const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
        if (!defKey || !cap.name)
            continue;
        const rawDefNode = cap[defKey];
        const whole = defScope(rawDefNode);
        const meta = resolveLuauMatchedDefMetadata(luauCtx, rawDefNode, defKey, cap.name, whole);
        if (!meta)
            continue;
        luauCtx.defNameAt.add(cap.name.startIndex);
        appendLuauDef(luauCtx, meta.symName, meta.symKind, whole, meta.exported);
    }
}

function extractLuauWrappedFnDef(n, luauCtx) {
    const { spanSeen, fileNode, isBarrelTarget, isPrimaryTable, defNameAt } = luauCtx;
    if (spanSeen.has(n.startIndex))
        return;
    const vars = n.namedChild(0);
    const exprs = n.namedChild(1);
    if (vars?.type !== "variable_list" || exprs?.type !== "expression_list")
        return;
    const lhs = vars.namedChild(0);
    const fnDef = unwrapFunctionDef(exprs.namedChild(0));
    if (!lhs || !fnDef)
        return;
    const chain = extractAccessChain(lhs);
    if (!chain || chain.length < 1)
        return;
    let symName = chain[0];
    let exported = false;
    if (chain.length >= 2) {
        if (isBarrelTarget(chain[0]))
            fileNode.isBarrelContributor = true;
        if (isPrimaryTable(chain[0])) {
            symName = chain.slice(1).join(".");
            exported = !isInsideNestedFunction(n);
        }
        else {
            symName = chain.join(".");
        }
    }
    defNameAt.add(lhs.startIndex);
    appendLuauDef(luauCtx, symName, "function", n, exported);
}

function scanLuauExtraDefs(n, luauCtx) {
    if (n.type === "assignment_statement")
        extractLuauWrappedFnDef(n, luauCtx);
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauExtraDefs(n.namedChild(i), luauCtx);
}

function resolveLuauIdentModuleTarget(rhs, luauCtx) {
    const { instancePaths, isBarrelTarget, reqBindings } = luauCtx;
    if (rhs.text === "script")
        return { spec: "@self", chain: [] };
    if (reqBindings.has(rhs.text)) {
        const b = reqBindings.get(rhs.text);
        return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? [])] };
    }
    const inst = evalInstancePath(rhs, instancePaths, isBarrelTarget);
    return inst ? { spec: instancePathToSpec(inst), chain: [] } : null;
}

function resolveLuauDotModuleTarget(rhs, luauCtx) {
    const { instancePaths, isBarrelTarget, isPrimaryTable, reqBindings, submodules } = luauCtx;
    const tbl = rhs.childForFieldName("table");
    const fld = rhs.childForFieldName("field");
    if (!tbl || !fld)
        return null;
    const tblSpec = extractRequireSpec(tbl, instancePaths, isBarrelTarget);
    if (tblSpec)
        return { spec: tblSpec, chain: [fld.text] };
    const chain = extractAccessChain(rhs);
    if (!chain || chain.length < 2)
        return null;
    if (reqBindings.has(chain[0])) {
        const b = reqBindings.get(chain[0]);
        return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? []), ...chain.slice(1)] };
    }
    if (isBarrelTarget(chain[0]))
        return { barrel: true, chain: chain.slice(1) };
    if (isPrimaryTable(chain[0]) && submodules[chain[1]]) {
        const sm = submodules[chain[1]];
        return { spec: sm.spec, barrel: sm.barrel, chain: [...(sm.chain ?? []), ...chain.slice(2)] };
    }
    return null;
}

function resolveLuauCallModuleTarget(rhs, reqBindings) {
    const callee = unwrapExpr(rhs.childForFieldName("name"));
    if (callee?.type !== "dot_index_expression" && callee?.type !== "method_index_expression")
        return null;
    const tbl = callee.childForFieldName("table");
    const fld = callee.childForFieldName("field") ?? callee.childForFieldName("method");
    if (tbl?.type !== "identifier" || fld?.text !== "new" || !reqBindings.has(tbl.text))
        return null;
    const b = reqBindings.get(tbl.text);
    return { spec: b.spec, barrel: b.barrel, chain: [...(b.chain ?? [])] };
}

function resolveLuauRhsModuleTarget(rawRhs, luauCtx) {
    const rhs = unwrapExpr(rawRhs);
    if (!rhs)
        return null;
    if (rhs.type === "binary_expression")
        return resolveLuauRhsModuleTarget(rhs.namedChild(1), luauCtx) ?? resolveLuauRhsModuleTarget(rhs.namedChild(0), luauCtx);
    if (rhs.type === "if_expression") {
        for (let i = 1; i < rhs.namedChildCount; i++) {
            const hit = resolveLuauRhsModuleTarget(rhs.namedChild(i), luauCtx);
            if (hit)
                return hit;
        }
        return null;
    }
    const directSpec = extractRequireSpec(rhs, luauCtx.instancePaths, luauCtx.isBarrelTarget);
    if (directSpec)
        return { spec: directSpec, chain: [] };
    if (rhs.type === "identifier")
        return resolveLuauIdentModuleTarget(rhs, luauCtx);
    if (rhs.type === "dot_index_expression")
        return resolveLuauDotModuleTarget(rhs, luauCtx);
    if (rhs.type === "function_call")
        return resolveLuauCallModuleTarget(rhs, luauCtx.reqBindings);
    return null;
}

function collectExportedAliasDefs(defs, fullKey, targetName) {
    const moduleDefIds = new Set();
    let matchedTargetDef = null;
    for (const d of defs) {
        if (d.inNestedFn || (d.name !== targetName && d.name !== fullKey))
            continue;
        if (fullKey === targetName || d.name === fullKey)
            d.exported = true;
        moduleDefIds.add(d.id);
        if (d.name === targetName)
            matchedTargetDef = d;
    }
    return { moduleDefIds, matchedTargetDef };
}

function updateNodesForLuauAlias(nodes, moduleDefIds, fullKey, targetName, fieldSummary) {
    let matchedTargetNode = null;
    let hasFullKeyNode = false;
    for (let j = 1; j < nodes.length; j++) {
        const symNode = nodes[j];
        if (symNode.name === fullKey && moduleDefIds.has(symNode.id))
            hasFullKeyNode = true;
        if (!moduleDefIds.has(symNode.id))
            continue;
        if (fullKey === targetName || symNode.name === fullKey)
            symNode.exported = true;
        if (!symNode.summary && fieldSummary)
            symNode.summary = fieldSummary;
        if (symNode.name === targetName)
            matchedTargetNode = symNode;
    }
    return { matchedTargetNode, hasFullKeyNode };
}

function appendSyntheticLuauAlias(luauCtx, fullKey, targetName, siteNode, fieldSummary, matchedTargetNode, matchedTargetDef) {
    const { rel, minted, nodes, defs, rawEdges } = luauCtx;
    const aliasId = mintId(`${rel}#${fullKey}`, minted);
    nodes.push({
        ...matchedTargetNode, id: aliasId, name: fullKey, exported: true,
        aliasOf: matchedTargetNode.id, summary: fieldSummary ?? matchedTargetNode.summary,
    });
    defs.push({
        id: aliasId, name: fullKey, kind: matchedTargetNode.kind, exported: true,
        aliasOf: matchedTargetNode.id, inNestedFn: false,
        startIndex: matchedTargetDef?.startIndex ?? siteNode.startIndex,
        endIndex: matchedTargetDef?.endIndex ?? siteNode.endIndex,
    });
    rawEdges.push({ source: aliasId, relation: "calls", file: rel, name: targetName, sameFileOnly: true });
}

function exportLuauLocalAlias(luauCtx, fullKey, targetName, siteNode) {
    const { lines, nodes, defs } = luauCtx;
    const { moduleDefIds, matchedTargetDef } = collectExportedAliasDefs(defs, fullKey, targetName);
    const fieldSummary = extractLeadingSummary(lines, siteNode.startPosition.row, siteNode.text);
    const { matchedTargetNode, hasFullKeyNode } = updateNodesForLuauAlias(nodes, moduleDefIds, fullKey, targetName, fieldSummary);
    if (fullKey !== targetName && !hasFullKeyNode && matchedTargetNode)
        appendSyntheticLuauAlias(luauCtx, fullKey, targetName, siteNode, fieldSummary, matchedTargetNode, matchedTargetDef);
}

function recordSingleLuauTableField(f, prefixChain, isBarrel, isPrimaryTarget, tblVarName, luauCtx) {
    const { instancePaths, isBarrelTarget, instanceExports, submodules, barrelExports } = luauCtx;
    const k = f.childForFieldName("name")?.text;
    const v = unwrapExpr(f.childForFieldName("value"));
    if (!k || !v)
        return;
    const fullKey = prefixChain.length > 0 ? `${prefixChain.join(".")}.${k}` : k;
    if (isPrimaryTarget && v.type === "identifier")
        exportLuauLocalAlias(luauCtx, fullKey, v.text, f);
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

function recordLuauTableFields(tblNode, prefixChain, isBarrel, isPrimaryTarget, tblVarName, luauCtx) {
    for (let i = 0; i < tblNode.namedChildCount; i++) {
        const f = tblNode.namedChild(i);
        if (f?.type === "field")
            recordSingleLuauTableField(f, prefixChain, isBarrel, isPrimaryTarget, tblVarName, luauCtx);
    }
}

function scanLuauIdentAssignment(lhs, rhs, luauCtx) {
    const { instancePaths, isBarrelTarget, isPrimaryTable, isRootInit, reqBindings, localTables } = luauCtx;
    const instPath = evalInstancePath(rhs, instancePaths, isBarrelTarget);
    if (instPath)
        instancePaths.set(lhs.text, instPath);
    const modTarget = resolveLuauRhsModuleTarget(rhs, luauCtx);
    if (modTarget)
        reqBindings.set(lhs.text, { ...modTarget, declStartIndex: lhs.startIndex });
    const unwRhs = unwrapExpr(rhs);
    if (unwRhs?.type === "table_constructor") {
        localTables.add(lhs.text);
        recordLuauTableFields(unwRhs, [], isBarrelTarget(lhs.text) || isRootInit, isPrimaryTable(lhs.text), lhs.text, luauCtx);
    }
}

function scanLuauMemberAssignment(lhs, rhs, stmtNode, luauCtx) {
    const { instancePaths, isBarrelTarget, isPrimaryTable, instanceExports, submodules, barrelExports } = luauCtx;
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
        return;
    }
    const unwRhs = unwrapExpr(rhs);
    if (unwRhs?.type === "table_constructor" && (isPrim || isBarrel))
        recordLuauTableFields(unwRhs, subChain, isBarrel, isPrim, lhsChain[0], luauCtx);
    else if (isPrim && unwRhs?.type === "identifier")
        exportLuauLocalAlias(luauCtx, key, unwRhs.text, stmtNode);
}

function scanLuauAssignmentPair(lhs, rhs, stmtNode, luauCtx) {
    if (lhs.type === "identifier")
        scanLuauIdentAssignment(lhs, rhs, luauCtx);
    else
        scanLuauMemberAssignment(lhs, rhs, stmtNode, luauCtx);
}

function isLuauAstTypeContext(node, lines) {
    let p = node;
    while (p) {
        if (p.type === "type_definition" || p.type.endsWith("_type"))
            return true;
        if (p.type === "cast_expression")
            return node.startIndex >= (p.namedChild(1)?.startIndex ?? Infinity);
        if (p.type === "parameter" && p.namedChildCount >= 2)
            return node.startIndex >= (p.namedChild(1)?.startIndex ?? Infinity);
        if (p.type === "function_declaration") {
            const hdr = (lines?.[p.startPosition.row] || "").trimStart();
            if (/^(?:export\s+)?type\s+function\b/.test(hdr))
                return true;
        }
        p = p.parent;
    }
    return false;
}

function scanLuauBindings(n, luauCtx) {
    const { rel, rawEdges, instancePaths, isBarrelTarget, isRootInit, stem, lines } = luauCtx;
    if (n.type === "function_call") {
        const spec = extractRequireSpec(n, instancePaths, isBarrelTarget);
        if (spec) {
            const typeOnly = isLuauAstTypeContext(n, lines);
            rawEdges.push({
                source: rel,
                relation: "imports",
                specifier: spec,
                file: rel,
                ...(typeOnly ? { typeOnly: true } : {}),
            });
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

function resolveDirectReqBindingSpec(val, reqBindings) {
    if (val?.type !== "identifier" || !reqBindings.has(val.text))
        return null;
    const b = reqBindings.get(val.text);
    return b.spec && (!b.chain || b.chain.length === 0) ? b.spec : null;
}
function matchLuauDelegateNode(n, reqBindings) {
    if (n.type === "return_statement" && n.parent?.type === "chunk") {
        return resolveDirectReqBindingSpec(unwrapExpr(n.namedChild(0)?.namedChild(0)), reqBindings);
    }
    if (n.type === "field") {
        if (n.childForFieldName("name")?.text !== "__index")
            return null;
        return resolveDirectReqBindingSpec(unwrapExpr(n.childForFieldName("value")), reqBindings);
    }
    if (n.type === "function_call") {
        const callee = unwrapExpr(n.childForFieldName("name"));
        if (callee?.type === "identifier" && callee.text === "setmetatable") {
            const secondArg = unwrapExpr(n.childForFieldName("arguments")?.namedChild(1));
            return resolveDirectReqBindingSpec(secondArg, reqBindings);
        }
    }
    return null;
}
function findLuauDelegateSpec(n, reqBindings) {
    let found = matchLuauDelegateNode(n, reqBindings);
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

const HIGHER_ORDER_CALL_KEYS = new Set([
    "task.spawn",
    "task.defer",
    "task.delay",
    "pcall",
    "xpcall",
    "coroutine.wrap",
    "table.sort",
]);
const HIGHER_ORDER_CALL_LEAVES = new Set(["Connect", "Once", "debounce", "throttle"]);
function inspectLuauCallArguments(args, callee, luauCtx) {
    const { sameFileFnNames, reqBindings } = luauCtx;
    const calleeChain = extractAccessChain(callee);
    const calleeKey = calleeChain ? calleeChain.join(".") : "";
    const calleeLeaf = calleeChain ? calleeChain[calleeChain.length - 1] : "";
    const isHigherOrder = HIGHER_ORDER_CALL_KEYS.has(calleeKey) || HIGHER_ORDER_CALL_LEAVES.has(calleeLeaf);
    for (let i = 0; i < args.namedChildCount; i++) {
        const arg = unwrapExpr(args.namedChild(i));
        if (!arg)
            continue;
        if (arg.type === "identifier" && (sameFileFnNames.has(arg.text) || reqBindings.has(arg.text))) {
            recordLuauChainCall(luauCtx, [arg.text], arg.startIndex, { sameFileOnly: !reqBindings.has(arg.text) });
        }
        else if (isHigherOrder && arg.type === "dot_index_expression") {
            const argChain = extractAccessChain(arg);
            if (argChain && argChain.length >= 2)
                recordLuauChainCall(luauCtx, argChain, arg.startIndex);
        }
    }
}

function inspectLuauGetChildrenCall(n, callee, luauCtx) {
    if (callee.type !== "method_index_expression" || callee.childForFieldName("method")?.text !== "GetChildren")
        return;
    const tbl = callee.childForFieldName("table");
    const dirSpec = instancePathToSpec(evalInstancePath(tbl, luauCtx.instancePaths, luauCtx.isBarrelTarget));
    if (!dirSpec)
        return;
    const enc = enclosingDef(luauCtx.defs, n.startIndex);
    luauCtx.rawEdges.push({
        source: luauCtx.rel,
        callerId: enc ? enc.id : luauCtx.rel,
        relation: "imports_children",
        specifier: dirSpec,
        file: luauCtx.rel,
    });
}
function inspectLuauInlineRequireCallee(callee, luauCtx) {
    if (callee.type === "function_call") {
        const reqSpec = extractRequireSpec(callee, luauCtx.instancePaths, luauCtx.isBarrelTarget);
        if (reqSpec) {
            luauCtx.rawCalls.push({ at: callee.startIndex, name: luauCtx.stem, specifier: reqSpec, chain: [], directModuleCall: true });
        }
        return;
    }
    if (callee.type !== "dot_index_expression" && callee.type !== "method_index_expression")
        return;
    const tbl = callee.childForFieldName("table");
    const fld = callee.childForFieldName("field") ?? callee.childForFieldName("method");
    const reqSpec = extractRequireSpec(tbl, luauCtx.instancePaths, luauCtx.isBarrelTarget);
    if (reqSpec && fld)
        luauCtx.rawCalls.push({ at: fld.startIndex, name: fld.text, specifier: reqSpec, chain: [fld.text] });
}
function inspectLuauFunctionCall(n, luauCtx) {
    const callee = unwrapExpr(n.childForFieldName("name"));
    const args = n.childForFieldName("arguments");
    if (!callee)
        return;
    inspectLuauGetChildrenCall(n, callee, luauCtx);
    inspectLuauInlineRequireCallee(callee, luauCtx);
    const chain = extractAccessChain(callee);
    if (chain) {
        const at = (callee.childForFieldName?.("field") ?? callee.childForFieldName?.("method") ?? callee).startIndex;
        recordLuauChainCall(luauCtx, chain, at);
        const last = chain[chain.length - 1];
        if ((last === "new" || last === "create") && chain.length >= 2 && !LUAU_STDLIB_TABLES.has(chain[0]) && args) {
            const className = extractStringLiteral(args);
            if (className && /^[A-Z][A-Za-z0-9_]*$/.test(className))
                luauCtx.rawCalls.push({ at, name: last, factoryClass: className });
        }
    }
    if (args)
        inspectLuauCallArguments(args, callee, luauCtx);
}

const LUAU_TYPE_PARENT_TYPES = new Set([
    "union_type",
    "intersection_type",
    "optional_type",
    "object_field_type",
    "object_type",
]);
function isBareLuauTypeIdentifier(n, p) {
    if (!p)
        return false;
    const pt = p.type;
    if (LUAU_TYPE_PARENT_TYPES.has(pt))
        return true;
    if (pt === "type_definition" || pt === "function_declaration" || pt === "function_definition")
        return p.childForFieldName("name")?.id !== n.id;
    if (pt === "parameter")
        return p.namedChildCount >= 2 && p.namedChild(1)?.id === n.id;
    if (pt === "generic_type")
        return !(p.parent?.type === "type_definition" && p.parent.childForFieldName("name")?.id === p.id);
    return pt === "cast_expression" && p.namedChild(1)?.id === n.id;
}
function scanLuauFieldTypeRef(n, luauCtx) {
    const mod = n.namedChild(0);
    const tname = n.namedChild(1);
    if (mod?.type !== "identifier" || tname?.type !== "identifier" || luauCtx.defNameAt.has(tname.startIndex))
        return;
    const b = luauCtx.reqBindings.get(mod.text);
    if (b) {
        luauCtx.typeUsedReqVars.add(mod.text);
        luauCtx.rawRefs.push({ at: tname.startIndex, name: tname.text, specifier: b.spec, barrel: b.barrel, chain: [...(b.chain ?? []), tname.text] });
    }
    else {
        luauCtx.rawRefs.push({ at: tname.startIndex, name: tname.text });
    }
}
function scanLuauIdentifierUsage(n, luauCtx) {
    const { defNameAt, reqBindings, rawRefs } = luauCtx;
    if (defNameAt.has(n.startIndex))
        return;
    const p = n.parent;
    const isMemberKey = (p?.type === "dot_index_expression" || p?.type === "method_index_expression") && p.childForFieldName("table")?.id !== n.id;
    const isFieldKey = p?.type === "field" && p.childForFieldName("name")?.id === n.id;
    const reqBound = !(isMemberKey || isFieldKey) ? reqBindings.get(n.text) : undefined;
    if (reqBound && n.startIndex !== reqBound.declStartIndex) {
        if (p?.type === "field_type" || isLuauAstTypeContext(n, luauCtx.lines))
            luauCtx.typeUsedReqVars.add(n.text);
        else
            luauCtx.runtimeUsedReqVars.add(n.text);
    }
    if (isBareLuauTypeIdentifier(n, p)) {
        const b = reqBindings.get(n.text);
        if (b && b.chain && b.chain.length > 0)
            rawRefs.push({ at: n.startIndex, name: b.chain[b.chain.length - 1], specifier: b.spec, barrel: b.barrel, chain: b.chain });
        else
            rawRefs.push({ at: n.startIndex, name: n.text });
    }
}
function scanLuauCallsAndTypes(n, luauCtx) {
    if (n.type === "function_call") {
        inspectLuauFunctionCall(n, luauCtx);
    }
    else if (n.type === "field") {
        const fval = unwrapExpr(n.childForFieldName("value"));
        if (fval?.type === "identifier" && luauCtx.sameFileFnNames.has(fval.text))
            luauCtx.rawCalls.push({ at: fval.startIndex, name: fval.text, sameFileOnly: true });
    }
    else if (n.type === "field_type") {
        scanLuauFieldTypeRef(n, luauCtx);
    }
    else if (n.type === "identifier") {
        scanLuauIdentifierUsage(n, luauCtx);
    }
    for (let i = 0; i < n.namedChildCount; i++)
        scanLuauCallsAndTypes(n.namedChild(i), luauCtx);
}

function finalizeLuauRawEdges(luauCtx) {
    const { rel, defs, rawCalls, rawRefs, rawEdges, reqBindings, typeUsedReqVars, runtimeUsedReqVars } = luauCtx;
    const typeOnlySpecs = new Set();
    const runtimeSpecs = new Set();
    for (const [varName, b] of reqBindings) {
        if (!b.spec)
            continue;
        if (runtimeUsedReqVars.has(varName))
            runtimeSpecs.add(b.spec);
        else if (typeUsedReqVars.has(varName) && (!b.chain || b.chain.length === 0))
            typeOnlySpecs.add(b.spec);
    }
    for (const e of rawEdges) {
        if (e.relation === "imports" && e.specifier && typeOnlySpecs.has(e.specifier) && !runtimeSpecs.has(e.specifier)) {
            e.typeOnly = true;
        }
    }
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
            typeOnly: true,
        });
    }
}

function resolveTypeofRequireSpec(tr, luauCtx, entry, tsMod) {
    if (tr.spec)
        return tr.spec;
    if (!tr.argExpr)
        return null;
    const snippetTree = parseLuauSyntaxTree(`return require(${tr.argExpr})`, entry, tsMod);
    if (!snippetTree)
        return null;
    try {
        const retStmt = snippetTree.rootNode.namedChild(0);
        const callNode = retStmt?.namedChild(0)?.namedChild(0);
        return extractRequireSpec(callNode, luauCtx.instancePaths, luauCtx.isBarrelTarget);
    }
    finally {
        snippetTree.delete?.();
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
        scanLuauBindings(tree.rootNode, luauCtx);
        for (const tr of typeofReqs) {
            const spec = resolveTypeofRequireSpec(tr, luauCtx, entry, tsMod);
            if (!spec)
                continue;
            rawEdges.push({
                source: rel,
                relation: "imports",
                specifier: spec,
                file: rel,
                ...(tr.typeOnly ? { typeOnly: true } : {}),
            });
            if (tr.field) {
                luauCtx.submodules[tr.field] = {
                    spec,
                    chain: [],
                    ...(tr.typeOnly ? { typeOnly: true } : {}),
                };
            }
        }
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

function parseSimpleTomlSections(text) {
    const sections = new Map();
    let curSection = "";
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line)
            continue;
        const sec = line.match(/^\[([^\]]+)\]$/);
        if (sec) {
            curSection = sec[1].trim();
            continue;
        }
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
        if (!kv)
            continue;
        let map = sections.get(curSection);
        if (!map)
            sections.set(curSection, (map = new Map()));
        map.set(kv[1], kv[2].trim());
    }
    return sections;
}

function unquoteTomlScalar(val) {
    const m = val?.match(/^["']([^"']+)["']$/);
    return m ? m[1] : null;
}

function findWallyIndexTarget(rootDir, pkgBase, spec) {
    const baseSpec = spec.split("@")[0].replace(/\//g, "_");
    const prefix = pkgBase ? `${pkgBase}/Packages/_Index` : "Packages/_Index";
    const idxDir = join(rootDir, prefix);
    if (!existsSync(idxDir))
        return null;
    try {
        const entries = readdirSync(idxDir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            if (!e.name.startsWith(`${baseSpec}@`) && e.name !== baseSpec)
                continue;
            const pkgName = spec.split("@")[0].split("/").pop();
            for (const sub of [`${prefix}/${e.name}/${pkgName}/src`, `${prefix}/${e.name}/${pkgName}`, `${prefix}/${e.name}`]) {
                if (existsSync(join(rootDir, sub)))
                    return sub;
            }
        }
    }
    catch {
        /* unreadable Packages/_Index */
    }
    return null;
}

function addNormalizedAlias(aliases, key, relTarget) {
    const norm = posix.normalize(relTarget).replace(/^\.\//, "");
    if (!aliases.has(key))
        aliases.set(key, norm);
}
const WALLY_DEPENDENCY_FOLDERS = [
    ["dependencies", "Packages"],
    ["server-dependencies", "ServerPackages"],
    ["dev-dependencies", "DevPackages"],
];
function applyWallySectionAliases(rootDir, base, pkgFolder, entries, aliases, mounts) {
    const folderRel = base ? `${base}/${pkgFolder}` : pkgFolder;
    if (existsSync(join(rootDir, folderRel)))
        addNormalizedAlias(aliases, pkgFolder, folderRel);
    for (const [depAlias, rawVal] of entries) {
        const spec = unquoteTomlScalar(rawVal);
        if (!spec)
            continue;
        const idxHit = pkgFolder === "Packages" ? findWallyIndexTarget(rootDir, base, spec) : null;
        const direct = `${folderRel}/${depAlias}`;
        const resolvedTarget = idxHit ?? (existsSync(join(rootDir, direct)) ? direct : null);
        if (!resolvedTarget)
            continue;
        addNormalizedAlias(aliases, depAlias, resolvedTarget);
        if (mounts && !mounts.has(direct))
            mounts.set(direct, resolvedTarget);
    }
}
function readWallyAliasesForDir(rootDir, dirRel, aliases, mounts) {
    const manifestPath = dirRel ? join(rootDir, dirRel, "wally.toml") : join(rootDir, "wally.toml");
    if (!existsSync(manifestPath))
        return;
    let secs;
    try {
        secs = parseSimpleTomlSections(readFileSync(manifestPath, "utf8"));
    }
    catch {
        return;
    }
    const base = dirRel && dirRel !== "." ? dirRel : "";
    for (const [secName, pkgFolder] of WALLY_DEPENDENCY_FOLDERS) {
        const entries = secs.get(secName);
        if (entries)
            applyWallySectionAliases(rootDir, base, pkgFolder, entries, aliases, mounts);
    }
}

const PESDE_FOLDER_ROOTS = ["roblox_packages", "luau_packages", "roblox_server_packages", "pesde", "Packages"];
const PESDE_DEP_SECTIONS = ["dependencies", "dev_dependencies", "peer_dependencies"];
function applyPesdeDependencyEntry(rootDir, base, depAlias, rawVal, aliases, mounts) {
    const inlinePath = rawVal.match(/\b(?:path|workspace)\s*=\s*["']([^"']+)["']/)?.[1];
    if (inlinePath) {
        const target = posix.normalize(base ? posix.join(base, inlinePath) : inlinePath).replace(/^\.\//, "");
        if (!aliases.has(depAlias))
            aliases.set(depAlias, target);
        return;
    }
    for (const f of PESDE_FOLDER_ROOTS) {
        const cand = base ? `${base}/${f}/${depAlias}` : `${f}/${depAlias}`;
        if (!existsSync(join(rootDir, cand)) && !existsSync(join(rootDir, `${cand}.luau`)))
            continue;
        if (!aliases.has(depAlias))
            aliases.set(depAlias, cand);
        if (mounts && !mounts.has(cand))
            mounts.set(cand, cand);
        return;
    }
}
function readPesdeAliasesForDir(rootDir, dirRel, aliases, mounts) {
    const manifestPath = dirRel ? join(rootDir, dirRel, "pesde.toml") : join(rootDir, "pesde.toml");
    if (!existsSync(manifestPath))
        return;
    let secs;
    try {
        secs = parseSimpleTomlSections(readFileSync(manifestPath, "utf8"));
    }
    catch {
        return;
    }
    const base = dirRel && dirRel !== "." ? dirRel : "";
    for (const f of PESDE_FOLDER_ROOTS) {
        const rel = base ? `${base}/${f}` : f;
        if (existsSync(join(rootDir, rel)) && !aliases.has(f))
            aliases.set(f, rel);
    }
    for (const secName of PESDE_DEP_SECTIONS) {
        const entries = secs.get(secName);
        if (!entries)
            continue;
        for (const [depAlias, rawVal] of entries)
            applyPesdeDependencyEntry(rootDir, base, depAlias, rawVal, aliases, mounts);
    }
}

function collectProjectDirs(allDirs) {
    const dirs = new Set([""]);
    if (!allDirs)
        return [""];
    for (const d of allDirs) {
        if (!d || d === ".")
            continue;
        if (/(?:^|\/)(?:_Index|node_modules|\.git|\.pesde)(?:\/|$)/.test(d))
            continue;
        const parts = d.split("/");
        for (let i = 1; i <= Math.min(parts.length, 3); i++)
            dirs.add(parts.slice(0, i).join("/"));
    }
    return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function readPackageManagerAliases(extraRoot, allDirs, aliases, mounts) {
    const dirs = collectProjectDirs(allDirs);
    for (const r of candidateRoots(extraRoot)) {
        const rootDir = resolve(r);
        for (const dirRel of dirs) {
            readWallyAliasesForDir(rootDir, dirRel, aliases, mounts);
            readPesdeAliasesForDir(rootDir, dirRel, aliases, mounts);
        }
    }
}

function collectLuaurcCandidateRels(allDirs) {
    const rcRels = new Set([".luaurc"]);
    if (!allDirs)
        return rcRels;
    for (const d of allDirs) {
        if (!d || d === ".")
            continue;
        const top = d.split("/")[0];
        if (top)
            rcRels.add(`${top}/.luaurc`);
        rcRels.add(`${d}/.luaurc`);
    }
    return rcRels;
}
function loadLuaurcFileAliases(rootDir, rcRel, map) {
    const d = readJson(join(rootDir, rcRel));
    if (!d || typeof d !== "object")
        return;
    const rcDir = posix.dirname(rcRel) === "." ? "" : posix.dirname(rcRel);
    for (const [k, v] of Object.entries(d.aliases ?? {}))
        addNormalizedAlias(map, k, rcDir ? posix.join(rcDir, String(v)) : String(v));
}
function readLuaurcAliases(extraRoot, allDirs) {
    const map = new Map();
    const rcRels = collectLuaurcCandidateRels(allDirs);
    for (const r of candidateRoots(extraRoot)) {
        const rootDir = resolve(r);
        for (const rcRel of rcRels)
            loadLuaurcFileAliases(rootDir, rcRel, map);
    }
    return map;
}

function resolveRojoSubprojectPath(rootDir, projDirRel, targetRel) {
    const joined = projDirRel ? posix.join(projDirRel, targetRel) : targetRel;
    const normTarget = posix.normalize(joined).replace(/^\.\//, "");
    const subData = readJson(join(rootDir, normTarget, "default.project.json"));
    const subPath = subData?.tree?.$path;
    if (typeof subPath === "string") {
        return posix.normalize(posix.join(normTarget, subPath)).replace(/^\.\//, "");
    }
    return normTarget;
}

function collectRojoProjectFiles(rootDir, projDirs) {
    const files = [];
    for (const dirRel of projDirs) {
        const absDir = dirRel ? join(rootDir, dirRel) : rootDir;
        let entries;
        try {
            entries = readdirSync(absDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const names = entries
            .filter((e) => e.isFile() && e.name.endsWith(".project.json"))
            .map((e) => e.name)
            .sort((a, b) => (a === "default.project.json" ? -1 : b === "default.project.json" ? 1 : a.localeCompare(b)));
        for (const name of names)
            files.push({ dirRel, fileRel: dirRel ? `${dirRel}/${name}` : name });
    }
    return files;
}

function setFirstMount(mounts, k, v) {
    if (k && v && !mounts.has(k))
        mounts.set(k, v);
}
function walkRojoTreeMounts(obj, parentVirt, rootDir, dirRel, mounts) {
    if (!obj || typeof obj !== "object")
        return;
    let curVirt = parentVirt;
    if (typeof obj.$path === "string") {
        const phys = resolveRojoSubprojectPath(rootDir, dirRel, obj.$path);
        if (parentVirt && parentVirt !== phys)
            setFirstMount(mounts, parentVirt, phys);
        curVirt = phys;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("$") || !v || typeof v !== "object")
            continue;
        const childVirt = curVirt ? `${curVirt}/${k}` : k;
        if (typeof v.$path === "string") {
            const phys = resolveRojoSubprojectPath(rootDir, dirRel, v.$path);
            setFirstMount(mounts, childVirt, phys);
            setFirstMount(mounts, k, phys);
            setFirstMount(mounts, `src/${k}`, phys);
            if (dirRel)
                setFirstMount(mounts, `${dirRel}/${k}`, phys);
        }
        walkRojoTreeMounts(v, childVirt, rootDir, dirRel, mounts);
    }
}
function readRojoMounts(extraRoot, allDirs) {
    const mounts = new Map();
    const projDirs = collectProjectDirs(allDirs);
    for (const r of candidateRoots(extraRoot)) {
        const rootDir = resolve(r);
        let foundAny = false;
        for (const { dirRel, fileRel } of collectRojoProjectFiles(rootDir, projDirs)) {
            const data = readJson(join(rootDir, fileRel));
            if (!data || typeof data !== "object" || !data.tree)
                continue;
            foundAny = true;
            walkRojoTreeMounts(data.tree, "", rootDir, dirRel, mounts);
        }
        if (foundAny)
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

function resolveLuauRootSpecifier(spec, byId, luaurcAliases, rojoMounts, barrelInstancePaths) {
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
function resolveLuauSelfSpecifier(spec, file, baseDir, byId, rojoMounts) {
    if (spec === "@self")
        return checkLuauCandidates(baseDir, byId, rojoMounts) ?? (byId.has(file) ? file : spec);
    const rel = spec.slice(6);
    if (!isInitLuau(file)) {
        const stemDir = posix.join(baseDir, posix.basename(file).replace(/\.luau$/i, ""));
        const childHit = checkLuauCandidates(posix.join(stemDir, rel), byId, rojoMounts);
        if (childHit)
            return childHit;
    }
    return checkLuauCandidates(baseDir && baseDir !== "." ? posix.join(baseDir, rel) : rel, byId, rojoMounts) ?? spec;
}
function resolveLuauAliasSpecifier(spec, byId, luaurcAliases, rojoMounts) {
    const slash = spec.indexOf("/");
    const alias = slash >= 0 ? spec.slice(1, slash) : spec.slice(1);
    const rest = slash >= 0 ? spec.slice(slash + 1) : "";
    const target = luaurcAliases?.get(alias);
    if (target) {
        const hit = checkLuauCandidates(rest ? `${target}/${rest}` : target, byId, rojoMounts);
        if (hit)
            return hit;
    }
    for (const fb of [`${alias}/src/${rest}`, `src/${rest}`, `${alias}/${rest}`]) {
        const hit = checkLuauCandidates(fb, byId, rojoMounts);
        if (hit)
            return hit;
    }
    return spec;
}
function resolveLuauRelativeSpecifier(spec, file, baseDir, byId, rojoMounts) {
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
function resolveLuauSpecifier(spec, file, byId, luaurcAliases, rojoMounts, barrelInstancePaths = null) {
    const baseDir = posix.dirname(file);
    if (spec === "@root" || spec.startsWith("@root/"))
        return resolveLuauRootSpecifier(spec, byId, luaurcAliases, rojoMounts, barrelInstancePaths);
    if (spec === "@self" || spec.startsWith("@self/"))
        return resolveLuauSelfSpecifier(spec, file, baseDir, byId, rojoMounts);
    if (spec.startsWith("@"))
        return resolveLuauAliasSpecifier(spec, byId, luaurcAliases, rojoMounts);
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../"))
        return resolveLuauRelativeSpecifier(spec, file, baseDir, byId, rojoMounts);
    return checkLuauCandidates(spec, byId, rojoMounts) ?? spec;
}

function probeLuauDir(d, allDirs, rojoMounts) {
    const norm = posix.normalize(d).replace(/^\.\//, "").replace(/\/$/, "");
    if (allDirs.has(norm))
        return norm;
    if (!rojoMounts)
        return null;
    for (const [virt, phys] of rojoMounts.entries()) {
        if (norm === virt && allDirs.has(phys))
            return phys;
        if (norm.startsWith(virt + "/")) {
            const mapped = `${phys}/${norm.slice(virt.length + 1)}`;
            if (allDirs.has(mapped))
                return mapped;
        }
    }
    return null;
}
function resolveLuauDirSpecifier(spec, file, allDirs, rojoMounts, barrelInstancePaths = null) {
    const baseDir = posix.dirname(file);
    if (spec === "@root" || spec.startsWith("@root/")) {
        const rel = spec === "@root" ? "" : spec.slice(6);
        const mapped = matchBarrelInstanceRoute(rel, barrelInstancePaths);
        if (mapped) {
            const hit = resolveLuauDirSpecifier(mapped.spec, mapped.fromFile, allDirs, rojoMounts, null);
            if (hit)
                return hit;
        }
        return probeLuauDir(rel ? `src/${rel}` : "src", allDirs, rojoMounts) ?? probeLuauDir(rel, allDirs, rojoMounts);
    }
    if (spec.startsWith("@self/")) {
        const rel = spec.slice(6);
        if (!isInitLuau(file)) {
            const stemDir = posix.join(baseDir, posix.basename(file).replace(/\.luau$/i, ""));
            const hit = probeLuauDir(posix.join(stemDir, rel), allDirs, rojoMounts);
            if (hit)
                return hit;
        }
        return probeLuauDir(baseDir && baseDir !== "." ? posix.join(baseDir, rel) : rel, allDirs, rojoMounts);
    }
    if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
        const effDir = isInitLuau(file) ? posix.dirname(baseDir) : baseDir;
        const hit = probeLuauDir(effDir && effDir !== "." ? posix.join(effDir, spec) : spec, allDirs, rojoMounts);
        if (hit)
            return hit;
        if (effDir !== baseDir)
            return probeLuauDir(baseDir && baseDir !== "." ? posix.join(baseDir, spec) : spec, allDirs, rojoMounts);
        return null;
    }
    return probeLuauDir(spec, allDirs, rojoMounts);
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

function isNonProdLuauPath(relPath) {
    const norm = String(relPath || "").replace(/\\/g, "/");
    return (
        /(?:^|\/)(?:test|tests|spec|specs|__tests__|bench|benchmarks|fixtures|vendor|Packages|RobloxPackages|\.sert)\//i.test(
            norm,
        ) || /\.(?:spec|test)\.(?:luau|lua)$/i.test(norm)
    );
}

function compareLuauFileOrder(a, b) {
    const aRoot = isInitLuau(a.path) && a.path.split("/").length <= 2 ? 0 : 1;
    const bRoot = isInitLuau(b.path) && b.path.split("/").length <= 2 ? 0 : 1;
    if (aRoot !== bRoot)
        return aRoot - bRoot;
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
}
function registerLuauBarrelFile(n, hasProdLuauFiles, state) {
    if (n.path.endsWith(".luau")) {
        state.luauFiles.push(n);
        state.allDirs.add(posix.dirname(n.path));
    }
    if (hasProdLuauFiles && isNonProdLuauPath(n.path))
        return;
    const isRootInit = n.path.endsWith(".luau") && isInitLuau(n.path) && n.path.split("/").length <= 2;
    if (isRootInit || n.isBarrelContributor)
        state.barrelFileSet.add(n.path);
    if (n.barrelTable)
        state.barrelTableNames.add(n.barrelTable);
    if (n.barrelExports) {
        for (const [k, target] of Object.entries(n.barrelExports)) {
            if (!state.barrelRoutes.has(k))
                state.barrelRoutes.set(k, { fromFile: n.path, ...target });
        }
    }
    if (n.instanceExports && (n.isBarrelContributor || isRootInit)) {
        for (const [k, spec] of Object.entries(n.instanceExports)) {
            if (!state.barrelInstancePaths.has(k))
                state.barrelInstancePaths.set(k, { fromFile: n.path, spec });
        }
    }
}
function collectLuauBarrelState(nodes, hasProdLuauFiles) {
    const state = {
        allDirs: new Set(),
        luauFiles: [],
        barrelRoutes: new Map(),
        barrelInstancePaths: new Map(),
        barrelFileSet: new Set(),
        barrelTableNames: new Set(),
    };
    const fileNodesSorted = nodes.filter((n) => n.kind === "file").sort(compareLuauFileOrder);
    for (const n of fileNodesSorted)
        registerLuauBarrelFile(n, hasProdLuauFiles, state);
    return state;
}

function indexLuauSymbols(nodes, hasProdLuauFiles) {
    const perFileName = new Map();
    const globalName = new Map();
    const methodsByLeaf = new Map();
    for (const n of nodes) {
        if (n.kind === "file")
            continue;
        if (!hasProdLuauFiles || !isNonProdLuauPath(n.path)) {
            pushMap(globalName, n.name, n);
            if (n.kind === "method" || (n.kind === "function" && (n.owner || n.name.includes(".")))) {
                const leaf = n.name.includes(".") ? n.name.slice(n.name.lastIndexOf(".") + 1) : n.name;
                if (leaf)
                    pushMap(methodsByLeaf, leaf, n);
            }
        }
        let fm = perFileName.get(n.path);
        if (!fm)
            perFileName.set(n.path, (fm = new Map()));
        pushMap(fm, n.name, n);
        if (n.name.includes("."))
            pushMap(fm, n.name.slice(n.name.lastIndexOf(".") + 1), n);
    }
    return { perFileName, globalName, methodsByLeaf };
}

function collectBarrelSymbolExports(barrelFileSet, perFileName) {
    const barrelSymbols = new Map();
    for (const barrelFile of barrelFileSet) {
        const fm = perFileName.get(barrelFile);
        if (!fm)
            continue;
        for (const [sym, list] of fm.entries()) {
            for (const sNode of list)
                pushMap(barrelSymbols, sym, sNode);
        }
    }
    return barrelSymbols;
}

function buildLuauResolutionIndex(nodes, opts) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hasProdLuauFiles = nodes.some((n) => n.kind === "file" && n.path.endsWith(".luau") && !isNonProdLuauPath(n.path));
    const barrelState = collectLuauBarrelState(nodes, hasProdLuauFiles);
    const { perFileName, globalName, methodsByLeaf } = indexLuauSymbols(nodes, hasProdLuauFiles);
    const aliases = readLuaurcAliases(opts?.root, barrelState.allDirs);
    const rojoMounts = readRojoMounts(opts?.root, barrelState.allDirs);
    readPackageManagerAliases(opts?.root, barrelState.allDirs, aliases, rojoMounts);
    const barrelSymbols = collectBarrelSymbolExports(barrelState.barrelFileSet, perFileName);
    return {
        byId,
        perFileName,
        globalName,
        methodsByLeaf,
        importedByFile: new Map(),
        ...barrelState,
        barrelSymbols,
        aliases,
        rojoMounts,
    };
}

function emitLuauChildrenImports(e, dir, luauIdx, factoryClasses, emitLuauEdge) {
    const { luauFiles, perFileName } = luauIdx;
    for (const n of luauFiles) {
        const pDir = posix.dirname(n.path);
        const isDirectChild = (pDir === dir && !isInitLuau(n.path)) || (posix.dirname(pDir) === dir && isInitLuau(n.path));
        if (!isDirectChild)
            continue;
        emitLuauEdge(e.file, n.path, "imports", "inferred");
        const stem = moduleStem(n.path);
        const fm = perFileName.get(n.path);
        if (fm?.has("new"))
            factoryClasses.set(stem, n.path);
        const initFn = pickUniqueLuauCandidate((fm?.get(stem) ?? []).filter((s) => s.kind === "function"));
        if (initFn)
            emitLuauEdge(e.callerId || e.file, initFn.id, "calls", "extracted");
    }
}

function recordDirectLuauImport(direct, from, to) {
    if (!from || !to || from === to)
        return;
    let s = direct.get(from);
    if (!s) {
        s = new Set();
        direct.set(from, s);
    }
    s.add(to);
}
function resolveSingleLuauImportEdge(e, direct, luauIdx, factoryClasses, emitLuauEdge) {
    const { byId, aliases, rojoMounts, barrelInstancePaths, allDirs } = luauIdx;
    if (e.relation === "imports" && e.specifier) {
        const target = resolveLuauSpecifier(e.specifier, e.file, byId, aliases, rojoMounts, barrelInstancePaths);
        if (byId.has(target)) {
            emitLuauEdge(e.source, target, "imports", "extracted", Boolean(e.typeOnly));
            recordDirectLuauImport(direct, e.file, target);
        }
        return;
    }
    if (e.relation !== "imports_children" || !e.specifier)
        return;
    const dir = resolveLuauDirSpecifier(e.specifier, e.file, allDirs, rojoMounts, barrelInstancePaths);
    if (!dir)
        return;
    emitLuauChildrenImports(e, dir, luauIdx, factoryClasses, (s, t, r, c, ty) => {
        emitLuauEdge(s, t, r, c, ty);
        if (r === "imports")
            recordDirectLuauImport(direct, e.file, t);
    });
}
function resolveLuauImportsPass(luauRaw, luauIdx, factoryClasses, emitLuauEdge) {
    const direct = new Map();
    for (const e of luauRaw)
        resolveSingleLuauImportEdge(e, direct, luauIdx, factoryClasses, emitLuauEdge);
    for (const [f, set] of direct) {
        const closure = new Set(set);
        for (const imp of set) {
            for (const hop of direct.get(imp) ?? [])
                closure.add(hop);
        }
        luauIdx.importedByFile.set(f, closure);
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

function probeLuauCandidatesAtHop(walkFile, curFile, rem, isDirect, kinds, luauIdx) {
    const { perFileName, barrelFileSet, barrelSymbols } = luauIdx;
    const symFull = rem.join(".");
    const symLeaf = rem[rem.length - 1];
    const fm = perFileName.get(walkFile);
    let cands = symFull && fm?.has(symFull) ? fm.get(symFull).filter((n) => kinds.includes(n.kind)) : [];
    if (cands.length === 0 && symLeaf && fm?.has(symLeaf))
        cands = fm.get(symLeaf).filter((n) => kinds.includes(n.kind));
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
    return null;
}
function walkLuauDelegateCandidates(curFile, rem, isDirect, kinds, luauIdx) {
    const { byId, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let walkFile = curFile;
    for (let hop = 0; hop < 4; hop++) {
        const fnode = byId.get(walkFile);
        if (!fnode)
            break;
        const hit = probeLuauCandidatesAtHop(walkFile, curFile, rem, isDirect, kinds, luauIdx);
        if (hit)
            return hit;
        if (!fnode.delegateSpec)
            break;
        walkFile = resolveLuauSpecifier(fnode.delegateSpec, walkFile, byId, aliases, rojoMounts, barrelInstancePaths);
    }
    return { node: null, moduleFile: curFile };
}

function matchLuauBarrelRoute(rem, barrelRoutes) {
    for (let len = rem.length; len >= 1; len--) {
        const prefix = rem.slice(0, len).join(".");
        if (barrelRoutes.has(prefix))
            return { matchedLen: len, route: barrelRoutes.get(prefix) };
    }
    return null;
}
function resolveLuauBarrelChainStart(rawRem, directModuleCall, recvName, kinds, luauIdx) {
    const { byId, barrelTableNames, barrelRoutes, barrelSymbols, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let rem = rawRem;
    let explicitBarrel = !recvName || barrelTableNames.has(recvName);
    if (rem.length >= 2 && barrelTableNames.has(rem[0])) {
        rem = rem.slice(1);
        explicitBarrel = true;
    }
    const routeHit = matchLuauBarrelRoute(rem, barrelRoutes);
    if (routeHit) {
        const { matchedLen, route } = routeHit;
        if (!route.spec)
            return { curFile: null, rem, isDirect: directModuleCall };
        const curFile = resolveLuauSpecifier(route.spec, route.fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
        const nextRem = [...(route.chain ?? []), ...rem.slice(matchedLen)];
        return { curFile, rem: nextRem, isDirect: nextRem.length === 0 ? true : directModuleCall };
    }
    if (!explicitBarrel)
        return { directResult: null };
    const cands = (barrelSymbols.get(rem.join(".")) ?? barrelSymbols.get(rem[rem.length - 1]) ?? []).filter((n) => kinds.includes(n.kind));
    const picked = pickUniqueLuauCandidate(cands);
    return { directResult: picked ? { node: picked, moduleFile: picked.path } : null };
}
function advanceLuauSubmoduleHops(startFile, startRem, startDirect, luauIdx) {
    const { byId, barrelFileSet, barrelRoutes, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let curFile = startFile;
    let rem = startRem;
    let isDirect = startDirect;
    for (let hop = 0; hop < 5 && rem.length >= 1; hop++) {
        let advanced = false;
        for (let len = rem.length; len >= 1; len--) {
            const subKey = rem.slice(0, len).join(".");
            const subTarget = lookupLuauSubmoduleTarget(curFile, subKey, luauIdx) ?? (barrelFileSet.has(curFile) ? barrelRoutes.get(subKey) : null);
            if (!subTarget?.spec)
                continue;
            const nextFile = resolveLuauSpecifier(subTarget.spec, subTarget.fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
            if (!byId.has(nextFile))
                continue;
            curFile = nextFile;
            rem = [...(subTarget.chain ?? []), ...rem.slice(len)];
            if (rem.length === 0)
                isDirect = true;
            advanced = true;
            break;
        }
        if (!advanced)
            break;
    }
    return { curFile, rem, isDirect };
}
function resolveLuauChainTarget(startSpec, startBarrel, fromFile, rawChain, kinds, directModuleCall, recvName, luauIdx) {
    const { byId, aliases, rojoMounts, barrelInstancePaths } = luauIdx;
    let curFile = null;
    let rem = [...(rawChain ?? [])];
    let isDirect = directModuleCall;
    if (startBarrel) {
        const started = resolveLuauBarrelChainStart(rem, isDirect, recvName, kinds, luauIdx);
        if ("directResult" in started)
            return started.directResult;
        ({ curFile, rem, isDirect } = started);
    }
    else if (startSpec) {
        curFile = resolveLuauSpecifier(startSpec, fromFile, byId, aliases, rojoMounts, barrelInstancePaths);
    }
    if (!curFile || !byId.has(curFile))
        return null;
    const walked = advanceLuauSubmoduleHops(curFile, rem, isDirect, luauIdx);
    return walkLuauDelegateCandidates(walked.curFile, walked.rem, walked.isDirect, kinds, luauIdx);
}

function resolveLuauReferenceEdge(e, luauIdx, emitLuauEdge) {
    const refTypeOnly = Boolean(e.typeOnly);
    if (e.specifier || e.barrel) {
        const res = resolveLuauChainTarget(e.specifier, e.barrel, e.file, e.chain ?? [e.name], ["type"], false, null, luauIdx);
        if (res?.moduleFile && e.specifier)
            emitLuauEdge(e.file, res.moduleFile, "imports", "extracted", refTypeOnly);
        if (res?.node)
            emitLuauEdge(e.source, res.node.id, "references", "extracted", refTypeOnly);
        return;
    }
    const local = pickUniqueLuauCandidate((luauIdx.perFileName.get(e.file)?.get(e.name) ?? []).filter((n) => n.kind === "type"));
    if (local)
        emitLuauEdge(e.source, local.id, "references", "extracted", refTypeOnly);
}
function resolveLuauReceiverFallbackEdge(e, luauIdx, callKinds, emitLuauEdge) {
    const leafName = e.fallbackName ?? e.name;
    const isReceiverCall = Boolean(e.recvName || e.fallbackName);
    if (!isReceiverCall || !leafName || leafName.length < 4)
        return;
    if ((e.recvName && LUAU_STDLIB_TABLES.has(e.recvName)) || GENERIC_MEMBER_NAMES.has(leafName.toLowerCase()))
        return;
    const cands = (luauIdx.methodsByLeaf.get(leafName) ?? []).filter(
        (n) => n.id !== e.source && n.path !== e.file && n.path.endsWith(".luau"),
    );
    const impSet = luauIdx.importedByFile.get(e.file);
    const impCands = impSet ? cands.filter((n) => impSet.has(n.path)) : [];
    const pickedImp = pickUniqueLuauCandidate(impCands);
    if (pickedImp) {
        emitLuauEdge(e.source, pickedImp.id, "calls", "inferred");
        return;
    }
    if (impCands.length === 0 && isCompoundIdentifierName(leafName)) {
        const pickedRepo = pickUniqueLuauCandidate(cands);
        if (pickedRepo)
            emitLuauEdge(e.source, pickedRepo.id, "calls", "inferred");
    }
}
function resolveLuauFactoryOrDirectEdge(e, luauIdx, factoryClasses, callKinds, emitLuauEdge) {
    const { perFileName, barrelTableNames } = luauIdx;
    if (e.factoryClass) {
        const classFile = factoryClasses.get(e.factoryClass);
        if (classFile) {
            const newFn = pickUniqueLuauCandidate((perFileName.get(classFile)?.get(e.name) ?? perFileName.get(classFile)?.get("new") ?? []).filter((n) => callKinds.includes(n.kind)));
            if (newFn)
                emitLuauEdge(e.source, newFn.id, "calls", "extracted");
        }
        return true;
    }
    const isBarrelCall = Boolean(e.barrel || (e.recvName && barrelTableNames.has(e.recvName)) || (e.chain?.length >= 2 && barrelTableNames.has(e.chain[0])));
    if (!e.specifier && !isBarrelCall)
        return false;
    const res = resolveLuauChainTarget(e.specifier, isBarrelCall, e.file, e.chain ?? [e.name], callKinds, e.directModuleCall, e.recvName, luauIdx);
    if (res?.moduleFile && e.specifier)
        emitLuauEdge(e.file, res.moduleFile, "imports", "extracted");
    if (res?.node) {
        emitLuauEdge(e.source, res.node.id, "calls", "extracted");
        return true;
    }
    return !e.fallbackSameFile;
}
function resolveLuauCallOrRefEdge(e, luauIdx, factoryClasses, emitLuauEdge) {
    if (e.relation === "references" && e.name) {
        resolveLuauReferenceEdge(e, luauIdx, emitLuauEdge);
        return;
    }
    if (e.relation !== "calls" || !e.name)
        return;
    const callKinds = ["function", "method"];
    if (resolveLuauFactoryOrDirectEdge(e, luauIdx, factoryClasses, callKinds, emitLuauEdge))
        return;
    const fileSyms = luauIdx.perFileName.get(e.file);
    let local = pickUniqueLuauCandidate((fileSyms?.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind)));
    if (!local && e.fallbackName)
        local = pickUniqueLuauCandidate((fileSyms?.get(e.fallbackName) ?? []).filter((n) => callKinds.includes(n.kind)));
    if (local) {
        emitLuauEdge(e.source, local.id, "calls", "extracted");
        return;
    }
    if (e.sameFileOnly || e.fallbackSameFile) {
        resolveLuauReceiverFallbackEdge(e, luauIdx, callKinds, emitLuauEdge);
        return;
    }
    const global = (luauIdx.globalName.get(e.name) ?? []).filter((n) => callKinds.includes(n.kind) && n.path.endsWith(".luau"));
    const pickedGlobal = pickUniqueLuauCandidate(global);
    if (pickedGlobal)
        emitLuauEdge(e.source, pickedGlobal.id, "calls", "inferred");
}

function recordPendingLuauEdge(pendingEdges, source, target, relation, confidence, typeOnly = false) {
    if (!source || !target || source === target)
        return;
    const key = `${source}\0${target}\0${relation}`;
    const existing = pendingEdges.get(key);
    if (existing) {
        if (!typeOnly)
            existing.typeOnly = false;
        if (confidence === "extracted")
            existing.confidence = "extracted";
        return;
    }
    pendingEdges.set(key, { source, target, relation, confidence, typeOnly: Boolean(typeOnly) });
}
export function resolveLuauEdges(nodes, rawEdges, addEdge, opts = {}) {
    const luauRaw = rawEdges.filter((e) => e.file?.endsWith(".luau"));
    if (luauRaw.length === 0)
        return;
    const luauIdx = buildLuauResolutionIndex(nodes, opts);
    const factoryClasses = new Map();
    const pendingEdges = new Map();
    const emitLuauEdge = (source, target, relation, confidence, typeOnly = false) =>
        recordPendingLuauEdge(pendingEdges, source, target, relation, confidence, typeOnly);
    resolveLuauImportsPass(luauRaw, luauIdx, factoryClasses, emitLuauEdge);
    for (const e of luauRaw)
        resolveLuauCallOrRefEdge(e, luauIdx, factoryClasses, emitLuauEdge);
    for (const edge of pendingEdges.values()) {
        if (edge.typeOnly)
            addEdge(edge.source, edge.target, edge.relation, edge.confidence, true);
        else
            addEdge(edge.source, edge.target, edge.relation, edge.confidence);
    }
}

