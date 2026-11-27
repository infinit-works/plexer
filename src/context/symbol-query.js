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
    "reexports",
    "interface_dispatch",
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
    const parts = rel.replace(/\.(?:luau|lua)$/i, "").split("/");
    const last = parts[parts.length - 1] ?? rel;
    if ((last === "init" || last.startsWith("init.")) && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return last.replace(/\.(client|server|spec|d)$/i, "");
}

function buildLuauCandidates(nodes, lowerQuery) {
    const rawNorm = lowerQuery.replace(/:/g, ".");
    const barrelPrefixes = new Set();
    for (const n of nodes) {
        if (n.kind === "file" && n.barrelTable) barrelPrefixes.add(n.barrelTable.toLowerCase());
    }
    const candidates = [rawNorm];
    const firstDot = rawNorm.indexOf(".");
    if (firstDot > 0) {
        const prefix = rawNorm.slice(0, firstDot);
        const rest = rawNorm.slice(firstDot + 1);
        if (rest && (barrelPrefixes.has(prefix) || rest.includes("."))) candidates.push(rest);
    }
    return candidates;
}

function unwrapLuauReexportHits(list, nodes, edges, graph) {
    if ((!edges && !graph?._outEdges) || list.length === 0) return list;
    let byId = graph?._byId ?? null;
    const outEdgesMap = graph?._outEdges ?? null;
    return list.map((h) => {
        const range = spanRange(h.span);
        if (range && range.start === range.end) {
            const sourceEdges = outEdgesMap ? (outEdgesMap.get(h.id) ?? []) : edges.filter((e) => e.source === h.id);
            const outCalls = sourceEdges.filter((e) => e.relation === "calls");
            if (outCalls.length === 1) {
                byId ??= new Map(nodes.map((n) => [n.id, n]));
                const target = byId.get(outCalls[0].target);
                if (target) {
                    if (target.name.toLowerCase() === h.name.toLowerCase())
                        return target;
                    const inEdges = graph?._inEdges?.get(h.id) ?? [];
                    const isSimpleMemberReexport = Boolean(
                        h.signature &&
                        /^\s*[A-Za-z_]\w*\s*=\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\s*,?\s*$/.test(h.signature) &&
                        inEdges.length === 0,
                    );
                    if (isSimpleMemberReexport)
                        return target;
                }
            }
        }
        return h;
    });
}

function filterLuauNodesBySuffixes(nodes, suffixes) {
    return nodes.filter((n) => {
        if (n.kind === "file") return false;
        const cand = stripNodeOrdinals(n);
        return suffixes.some((s) => cand === s || cand.endsWith("/" + s) || (s.startsWith("#") && cand.endsWith(s)));
    });
}

function matchLuauDottedSymbol(nodes, norm, edges, graph) {
    const dot = norm.lastIndexOf(".");
    const modPart = norm.slice(0, dot).replace(/\./g, "/");
    const symPart = norm.slice(dot + 1);
    if (!modPart || !symPart) return [];
    const modSuffixes = [
        `${modPart}.luau#${symPart}`,
        `${modPart}/init.luau#${symPart}`,
        `${modPart}/src/init.luau#${symPart}`,
        `${modPart}/init.client.luau#${symPart}`,
        `${modPart}/init.server.luau#${symPart}`,
        `${modPart}.lua#${symPart}`,
        `${modPart}/init.lua#${symPart}`,
        `${modPart}/src/init.lua#${symPart}`,
        `${modPart}/init.client.lua#${symPart}`,
        `${modPart}/init.server.lua#${symPart}`,
    ];
    const slashIdx = modPart.indexOf("/");
    if (slashIdx > 0) {
        const head = modPart.slice(0, slashIdx);
        const tail = modPart.slice(slashIdx + 1);
        modSuffixes.push(
            `${head}/src/${tail}.luau#${symPart}`,
            `${head}/src/${tail}/init.luau#${symPart}`,
            `${head}/src/${tail}.lua#${symPart}`,
            `${head}/src/${tail}/init.lua#${symPart}`,
        );
    }
    let hits = filterLuauNodesBySuffixes(nodes, modSuffixes);
    if (hits.length === 0) hits = filterLuauNodesBySuffixes(nodes, [`#${norm}`]);
    if (hits.length > 1) {
        const exp = hits.filter((n) => n.exported);
        if (exp.length > 0) hits = exp;
    }
    return hits.length > 0 ? unwrapLuauReexportHits(hits, nodes, edges, graph) : [];
}

function matchSingleLuauCandidate(nodes, norm, edges, graph) {
    if (norm.includes("#")) {
        const hits = unwrapLuauReexportHits(
            nodes.filter((n) => n.kind !== "file" && (stripNodeOrdinals(n) === norm || stripNodeOrdinals(n).endsWith("/" + norm))),
            nodes,
            edges,
            graph,
        );
        return hits.length > 0 ? hits : null;
    }
    if (norm.endsWith(".luau") || norm.endsWith(".lua")) {
        const hits = nodes.filter(
            (n) => n.kind === "file" && (n.name.toLowerCase() === norm || n.path.toLowerCase() === norm || n.path.toLowerCase().endsWith("/" + norm)),
        );
        return hits.length > 0 ? hits : null;
    }
    if (norm.includes(".")) {
        const hits = matchLuauDottedSymbol(nodes, norm, edges, graph);
        if (hits.length > 0) return hits;
    }
    const fileStemHits = nodes.filter((n) => n.kind === "file" && (n.path.endsWith(".luau") || n.path.endsWith(".lua")) && moduleStem(n.path).toLowerCase() === norm);
    if (fileStemHits.length > 0 && !nodes.some((n) => n.kind !== "file" && n.name.toLowerCase() === norm)) return fileStemHits;
    return null;
}

export function matchLuauSymbol(nodes, lowerQuery, edges, graph) {
    for (const norm of buildLuauCandidates(nodes, lowerQuery)) {
        const matched = matchSingleLuauCandidate(nodes, norm, edges, graph);
        if (matched) return matched;
    }
    return [];
}

function symbolMatches(nodes, lowerQuery, graph) {
    const hasHash = lowerQuery.includes("#");
    const suffixHash = "#" + lowerQuery;
    const suffixDot = "." + lowerQuery;
    let candidates = nodes;
    if (graph?.byBareName && lowerQuery) {
        const tailIdx = Math.max(lowerQuery.lastIndexOf("."), lowerQuery.lastIndexOf("#"), lowerQuery.lastIndexOf(":"));
        const tail = tailIdx >= 0 ? lowerQuery.slice(tailIdx + 1) : lowerQuery;
        if (tail && !tail.includes("/")) {
            const byNameHits = tailIdx < 0 && graph.byName ? graph.byName.get(lowerQuery) : null;
            const byBareHits = graph.byBareName.get(tail);
            if (!byNameHits && !byBareHits)
                return [];
            if (byNameHits && !byBareHits)
                candidates = byNameHits;
            else if (byBareHits && (!byNameHits || byBareHits === byNameHits))
                candidates = byBareHits;
            else {
                const seen = new Set(byNameHits);
                const merged = [...byNameHits];
                for (const n of byBareHits) {
                    if (!seen.has(n)) {
                        seen.add(n);
                        merged.push(n);
                    }
                }
                candidates = merged;
            }
        }
    }
    return candidates.filter((n) => {
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

function matchColonOrHashSymbol(nodes, lowerQuery, graph) {
    const sepIdx = Math.max(lowerQuery.lastIndexOf(":"), lowerQuery.lastIndexOf("#"));
    const left = lowerQuery.slice(0, sepIdx).replace(/[:#]$/, "");
    const right = lowerQuery.slice(sepIdx + 1);
    const rightShort = right.includes(".") ? right.slice(right.lastIndexOf(".") + 1) : right;
    if (!left || !right)
        return [];
    let matches = [];
    if (left.includes("/") || /\.[a-z0-9]+$/.test(left)) {
        matches = nodes.filter((n) => n.kind !== "file" &&
            (n.path.toLowerCase() === left || n.path.toLowerCase().endsWith("/" + left)) &&
            (n.name.toLowerCase() === right || n.name.toLowerCase() === rightShort || n.id.toLowerCase().endsWith("#" + right) || n.id.toLowerCase().endsWith("." + right)));
    }
    return matches.length > 0 ? matches : symbolMatches(nodes, `${left}.${right}`, graph);
}

function matchFileNodeFallback(graph, trimmed, lowerQuery) {
    const matchFile = (list) => list.filter((n) => n.kind === "file" &&
        (n.name.toLowerCase() === lowerQuery ||
            n.path.toLowerCase() === lowerQuery ||
            n.path.toLowerCase().endsWith("/" + lowerQuery)));
    const fileNodes = graph._nodesByPath?.get(trimmed) ?? graph.nodes;
    const matches = matchFile(fileNodes);
    return matches.length === 0 && fileNodes !== graph.nodes ? matchFile(graph.nodes) : matches;
}

function matchDottedOwnerFallback(graph, trimmed) {
    const lastSep = Math.max(trimmed.lastIndexOf("."), trimmed.lastIndexOf(":"));
    const prefix = trimmed.slice(0, lastSep).toLowerCase();
    const lastSegment = trimmed.slice(lastSep + 1).toLowerCase();
    if (!lastSegment)
        return [];
    const allSeg = graph.byName
        ? (graph.byName.get(lastSegment) ?? [])
        : graph.nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === lastSegment);
    if (!prefix)
        return allSeg;
    return allSeg.filter((n) =>
        n.owner?.toLowerCase() === prefix ||
        n.signature?.toLowerCase().includes(`${prefix}.${lastSegment}`) ||
        n.path.toLowerCase().includes(prefix.replace(/\./g, "/")));
}

export function resolveSymbol(graph, query, opts = {}) {
    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();
    const looksLikeFilename = trimmed.includes(".") && !trimmed.includes("#") && !trimmed.includes(":");
    let matches = symbolMatches(graph.nodes, lowerQuery, graph);
    if (matches.length === 0 && (trimmed.includes(":") || trimmed.includes("#")))
        matches = matchColonOrHashSymbol(graph.nodes, lowerQuery, graph);
    const hasLuau = !graph.meta?.languages || graph.meta.languages.includes("luau") || graph.meta.languages.includes("lua");
    if (hasLuau && (matches.length === 0 || lowerQuery.includes(".") || lowerQuery.includes(":"))) {
        const luauMatches = matchLuauSymbol(graph.nodes, lowerQuery, graph.edges, graph);
        if (luauMatches.length > 0 && (matches.length === 0 || luauMatches.some((m) => m.exported))) {
            if (matches.length === 0) {
                matches = luauMatches;
            }
            else {
                const seenIds = new Set(matches.map((m) => m.id));
                const merged = [...matches];
                for (const m of luauMatches) {
                    if (!seenIds.has(m.id)) {
                        seenIds.add(m.id);
                        merged.push(m);
                    }
                }
                matches = merged;
            }
        }
    }
    if (matches.length === 0 && looksLikeFilename)
        matches = matchFileNodeFallback(graph, trimmed, lowerQuery);
    if (matches.length === 0 && (trimmed.includes(".") || trimmed.includes(":")))
        matches = matchDottedOwnerFallback(graph, trimmed);
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
