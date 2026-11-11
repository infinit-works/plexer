/**
 * Shared AST definition scoping, enclosing container lookup, and leading doc-comment extraction.
 */
export const KIND = {
    function: "function",
    method: "method",
    class: "class",
    interface: "interface",
    type: "type",
    struct: "struct",
    enum: "enum",
    module: "module",
    constant: "constant",
    variable: "variable",
    field: "variable",
    object: "class",
    property: "variable",
};

export function extractLeadingSummary(lines, startRow, bodyText = "") {
    if (Array.isArray(lines) && startRow > 0) {
        let r = startRow - 1;
        let skipped = 0;
        while (r >= 0 && skipped < 4) {
            const t = lines[r].trim();
            if (/^(@[A-Za-z_]|#\[|--\[=\[)/.test(t)) {
                r--;
                skipped++;
            }
            else {
                break;
            }
        }
        const commentLines = [];
        if (r >= 0) {
            const last = lines[r].trim();
            if (last.endsWith("*/")) {
                while (r >= 0) {
                    const line = lines[r].trim();
                    commentLines.unshift(line);
                    const hasOpen = line.includes("/*");
                    r--;
                    if (hasOpen || commentLines.length > 30)
                        break;
                }
            }
            else if (last.endsWith("]]") || last.endsWith("]=]")) {
                while (r >= 0) {
                    const line = lines[r].trim();
                    commentLines.unshift(line);
                    const hasOpen = /^--\[=*\[/.test(line);
                    r--;
                    if (hasOpen || commentLines.length > 30)
                        break;
                }
            }
            else {
                while (r >= 0 && commentLines.length < 25) {
                    const line = lines[r].trim();
                    if (/^(\/\/|---?|\*\s|#(?!!|\[))/.test(line)) {
                        commentLines.unshift(line);
                        r--;
                    }
                    else {
                        break;
                    }
                }
            }
        }
        const paraParts = [];
        for (const raw of commentLines) {
            const cleaned = raw
                .replace(/^(\/\*\*+|\/*\*+\/|\*+|\/{2,3}!|--+\[=*\[|\]=*\]|--+|#+'?)\s*/, "")
                .replace(/\*+\/\s*$/, "")
                .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
                .replace(/<[^>]+>/g, "")
                .trim();
            if (!cleaned) {
                if (paraParts.length > 0)
                    break;
                continue;
            }
            if (/^(@\w+|eslint-|prettier-|ts-|nolint|noinspection|luacheck:|selene:|!strict|!nocheck|!native|!optimize|TODO\b|FIXME\b)/i.test(cleaned)) {
                if (paraParts.length > 0)
                    break;
                continue;
            }
            if (/^[-=*_~]{3,}$/.test(cleaned)) {
                if (paraParts.length > 0)
                    break;
                continue;
            }
            paraParts.push(cleaned);
            if (paraParts.join(" ").length >= 220)
                break;
        }
        if (paraParts.length > 0) {
            const joined = paraParts.join(" ");
            return joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
        }
    }
    if (bodyText) {
        const pyMatch = bodyText.match(/^[ \t]*(?:async\s+)?(?:def|class)\s+[^\n]+:\s*\n[ \t]*r?(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
        const doc = pyMatch?.[1] ?? pyMatch?.[2];
        if (doc) {
            for (const raw of doc.split("\n")) {
                const cleaned = raw.trim();
                if (cleaned)
                    return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
            }
        }
    }
    return null;
}

export function enclosingDef(defs, at) {
    let best;
    let bestSpan = Infinity;
    for (const d of defs) {
        if (d.startIndex <= at && at < d.endIndex) {
            const span = d.endIndex - d.startIndex;
            if (span < bestSpan) {
                bestSpan = span;
                best = d;
            }
        }
    }
    return best;
}

const DEF_CONTAINER = /(definition|declaration|specifier|_item)$/;

function nextNamedSibling(n) {
    const tagged = n;
    if ("nextNamedSibling" in tagged)
        return tagged.nextNamedSibling ?? null;
    const p = n.parent;
    if (!p?.namedChild)
        return null;
    const count = p.namedChildCount ?? 0;
    for (let i = 0; i < count - 1; i++) {
        const c = p.namedChild(i);
        if (c && c.startIndex === n.startIndex && c.endIndex === n.endIndex)
            return p.namedChild(i + 1);
    }
    return null;
}

export function defScope(node, langName) {
    let n = node;
    while (n.parent && DEF_CONTAINER.test(n.parent.type))
        n = n.parent;
    if (langName === "dart") {
        const body = nextNamedSibling(n);
        if (body?.type === "function_body") {
            return {
                type: n.type,
                text: n.text,
                startIndex: n.startIndex,
                endIndex: body.endIndex,
                startPosition: n.startPosition,
                endPosition: body.endPosition,
                parent: n.parent,
            };
        }
    }
    return n;
}
