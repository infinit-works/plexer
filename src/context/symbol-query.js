/**
 * Graph edge relations, in-degree caching, and whole-repository symbol resolution.
 */
import { stripNodeOrdinals } from "../util/id.js";
import { normalizePathPrefix, pathUnderPrefix } from "../util/paths.js";
import { spanRange } from "../util/span.js";
import { assertPrefixIndexed } from "./scopes.js";

export const WALK_RELATIONS = new Set([
    "calls",
    "references",
    "imports",
    "implements",
    "extends",
]);

export function computeInDegree(graph) {
    if (!graph?.edges)
        return new Map();
    if (graph._inDegree && graph._inDegreeEdgeLen === graph.edges.length)
        return graph._inDegree;
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    Object.defineProperty(graph, "_inDegree", { value: deg, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(graph, "_inDegreeEdgeLen", { value: graph.edges.length, enumerable: false, configurable: true, writable: true });
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
    const hasHash = lowerQuery.includes("#");
    const suffixHash = "#" + lowerQuery;
    const suffixDot = "." + lowerQuery;
    return nodes.filter((n) => {
        if (n.kind === "file")
            return false;
        const lowerName = n._lowerName ?? (Object.defineProperty(n, "_lowerName", { value: n.name.toLowerCase(), enumerable: false, configurable: true, writable: true }), n._lowerName);
        if (lowerName === lowerQuery)
            return true;
        const candidateId = stripNodeOrdinals(n);
        if (hasHash)
            return candidateId === lowerQuery || candidateId.endsWith("/" + lowerQuery);
        return candidateId.endsWith(suffixHash) || candidateId.endsWith(suffixDot);
    });
}

export function resolveSymbol(graph, query, opts = {}) {
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const looksLikeFilename = trimmed.includes(".") && !trimmed.includes("#") && !trimmed.includes(":");
    let matches = symbolMatches(graph.nodes, lowerQuery);
    if (matches.length === 0 && (trimmed.includes(":") || trimmed.includes("#"))) {
        const sepIdx = Math.max(lowerQuery.lastIndexOf(":"), lowerQuery.lastIndexOf("#"));
        const left = lowerQuery.slice(0, sepIdx).replace(/[:#]$/, "");
        const right = lowerQuery.slice(sepIdx + 1);
        const rightShort = right.includes(".") ? right.slice(right.lastIndexOf(".") + 1) : right;
        if (left && right) {
            if (left.includes("/") || /\.[a-z0-9]+$/.test(left)) {
                matches = graph.nodes.filter((n) => n.kind !== "file" &&
                    (n.path.toLowerCase() === left || n.path.toLowerCase().endsWith("/" + left)) &&
                    (n.name.toLowerCase() === right || n.name.toLowerCase() === rightShort || n.id.toLowerCase().endsWith("#" + right) || n.id.toLowerCase().endsWith("." + right)));
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
        const prefix = trimmed.slice(0, lastSep).toLowerCase();
        const lastSegment = trimmed.slice(lastSep + 1).toLowerCase();
        if (lastSegment) {
            const allSeg = graph.nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === lastSegment);
            const sigFiltered = prefix
                ? allSeg.filter((n) =>
                    n.owner?.toLowerCase() === prefix ||
                    n.signature?.toLowerCase().includes(`${prefix}.${lastSegment}`) ||
                    n.path.toLowerCase().includes(prefix.replace(/\./g, "/"))
                )
                : [];
            matches = sigFiltered.length > 0 ? sigFiltered : allSeg;
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
