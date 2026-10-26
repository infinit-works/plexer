import { createHash } from "node:crypto";
import { assertPrefixIndexed, normalizePathPrefix, pathUnderPrefix } from "./paths.js";
import { spanRange } from "./span.js";

/** Stable content hash (sha256, hex) used for document dedup. */
export function contentHash(input) {
    return createHash("sha256").update(input).digest("hex");
}

/** Mint-time uniqueness: collision-proof `~2`, `~3`, ... suffixing. */
export function mintId(base, minted) {
    let id = base;
    let k = 2;
    while (minted.has(id))
        id = `${base}~${k++}`;
    minted.add(id);
    return id;
}

/** Strips mint-time disambiguation ordinals (`~2`, `~3`, ...) from segment ends in a dotted id-tail. */
export function stripOrdinals(idTail) {
    return idTail.replace(/~\d+(?=\.|$)/g, "");
}

/** Lowercase `n.id` with mint-time disambiguation ordinals stripped from the symbol tail. */
export function stripNodeOrdinals(n) {
    if (n._strippedId !== undefined)
        return n._strippedId;
    const lowerId = n.id.toLowerCase();
    const hashIdx = lowerId.indexOf("#");
    const stripped = hashIdx === -1 ? lowerId : lowerId.slice(0, hashIdx + 1) + stripOrdinals(lowerId.slice(hashIdx + 1));
    Object.defineProperty(n, "_strippedId", { value: stripped, enumerable: false, configurable: true, writable: true });
    return stripped;
}

const MAX_BODY_CHARS = 5000;
const MAX_FILE_BODY_CHARS = 16000;

export function searchBody(text, max = MAX_BODY_CHARS) {
    const norm = text.replace(/\s+/g, " ").trim();
    return norm.length > max ? norm.slice(0, max) : norm;
}

export function fileResidual(source, symbols) {
    const lines = source.split("\n");
    const covered = new Uint8Array(lines.length + 2);
    for (const s of symbols) {
        const range = spanRange(s.span);
        if (!range)
            continue;
        for (let r = range.start; r <= range.end && r < covered.length; r++)
            covered[r] = 1;
    }
    const kept = [];
    for (let i = 0; i < lines.length; i++)
        if (!covered[i + 1])
            kept.push(lines[i]);
    return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

export function extractLeadingSummary(lines, startRow, bodyText = "") {
    if (Array.isArray(lines) && startRow > 0) {
        let r = startRow - 1;
        let skipped = 0;
        while (r >= 0 && skipped < 4) {
            const t = lines[r].trim();
            if (/^(@[A-Za-z_]|#\[|--\[=\[)/.test(t)) {
                r--;
                skipped++;
            } else {
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

export const KIND = {
    function: "function", method: "method", class: "class", interface: "interface",
    type: "type", struct: "struct", enum: "enum", module: "module",
    constant: "constant", variable: "variable", field: "variable",
    object: "class", property: "variable",
};

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

export const WALK_RELATIONS = new Set([
    "calls",
    "references",
    "imports",
    "implements",
    "extends",
]);

export function computeInDegree(graph) {
    if (graph?._inDegree && graph._inDegreeEdgeLen === graph.edges.length)
        return graph._inDegree;
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    if (graph) {
        Object.defineProperty(graph, "_inDegree", { value: deg, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_inDegreeEdgeLen", { value: graph.edges.length, enumerable: false, configurable: true, writable: true });
    }
    return deg;
}

export function moduleStem(rel) {
    const parts = rel.replace(/\.luau$/i, "").split("/");
    const last = parts[parts.length - 1] ?? rel;
    if ((last === "init" || last.startsWith("init.")) && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return last.replace(/\.(client|server|spec|d)$/i, "");
}

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

function symbolMatches(nodes, lowerQuery) {
    const suffixHash = "#" + lowerQuery;
    const suffixDot = "." + lowerQuery;
    return nodes.filter((n) => {
        if (n.kind === "file")
            return false;
        const lowerName = n._lowerName ?? (Object.defineProperty(n, "_lowerName", { value: n.name.toLowerCase(), enumerable: false, configurable: true, writable: true }), n._lowerName);
        if (lowerName === lowerQuery)
            return true;
        const candidateId = stripNodeOrdinals(n);
        return candidateId.endsWith(suffixHash) || candidateId.endsWith(suffixDot);
    });
}

export function resolveSymbol(graph, query, opts = {}) {
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const looksLikeFilename = trimmed.includes(".") && !trimmed.includes("#") && !trimmed.includes(":");
    let matches = symbolMatches(graph.nodes, lowerQuery);
    if (matches.length === 0 && trimmed.includes(":") && !trimmed.includes("#")) {
        const colonIdx = lowerQuery.lastIndexOf(":");
        const left = lowerQuery.slice(0, colonIdx).replace(/:$/, "");
        const right = lowerQuery.slice(colonIdx + 1);
        if (left && right) {
            if (left.includes("/") || /\.[a-z0-9]+$/.test(left)) {
                matches = graph.nodes.filter((n) => n.kind !== "file" &&
                    (n.path.toLowerCase() === left || n.path.toLowerCase().endsWith("/" + left)) &&
                    (n.name.toLowerCase() === right || n.id.toLowerCase().endsWith("#" + right) || n.id.toLowerCase().endsWith("." + right)));
            }
            if (matches.length === 0) {
                matches = symbolMatches(graph.nodes, `${left}.${right}`);
            }
        }
    }
    const hasLuau = !graph.meta?.languages || graph.meta.languages.includes("luau");
    if (hasLuau && (matches.length === 0 || lowerQuery.includes(".") || lowerQuery.includes(":"))) {
        const luauMatches = matchLuauSymbol(graph.nodes, lowerQuery, graph.edges);
        if (luauMatches.length > 0 && (matches.length === 0 || luauMatches.some((m) => m.exported)))
            matches = luauMatches;
    }
    if (matches.length === 0 && looksLikeFilename) {
        matches = graph.nodes.filter((n) => n.kind === "file" &&
            (n.name.toLowerCase() === lowerQuery ||
                n.path.toLowerCase() === lowerQuery ||
                n.path.toLowerCase().endsWith("/" + lowerQuery)));
    }
    if (matches.length === 0 && (trimmed.includes(".") || trimmed.includes(":"))) {
        const lastSep = Math.max(trimmed.lastIndexOf("."), trimmed.lastIndexOf(":"));
        const lastSegment = trimmed.slice(lastSep + 1).toLowerCase();
        if (lastSegment) {
            matches = graph.nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === lastSegment);
        }
    }
    if (opts.in) {
        const prefix = normalizePathPrefix(opts.in);
        assertPrefixIndexed(graph, prefix);
        matches = matches.filter((n) => pathUnderPrefix(n.path, prefix));
    }
    if (matches.length > 1) {
        matches = [...matches].sort((a, b) => Number(Boolean(b.exported)) - Number(Boolean(a.exported)));
    }
    return matches;
}

