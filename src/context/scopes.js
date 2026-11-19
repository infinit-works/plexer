/**
 * Scope prefix resolution and `--in` path validation against indexed wiring graphs.
 */
import { pathUnderPrefix } from "../util/paths.js";

const CANONICAL_ROOT_SCOPES = [{ prefix: "", label: "", markers: [] }];

/** Nearest-prefix owner. `scopes` MUST be sorted prefix-length desc; "" matches all. */
export function scopeOf(path, scopes) {
    for (const s of scopes) {
        if (s.prefix === "")
            continue;
        if (path === s.prefix || path.startsWith(`${s.prefix}/`))
            return s;
    }
    return scopes.find((s) => s.prefix === "") ?? { prefix: "", label: "", markers: [] };
}

/** Display form of a scope prefix: "" reads as "(root)", everything else gets a trailing slash. */
export function scopeLabel(prefix) {
    return prefix === "" ? "(root)" : `${prefix}/`;
}

/** " — scopes here: a/ · b/" when `scopes` is genuinely multi-scope (>1 entries), else "". */
export function scopesHereClause(scopes) {
    if (scopes.length <= 1)
        return "";
    return ` — scopes here: ${scopes.map((s) => scopeLabel(s.prefix)).join(" · ")}`;
}

/** Every consumer's entry point to a graph's scopes. */
export function scopesOfGraph(graph) {
    return graph?.meta?.scopes ?? CANONICAL_ROOT_SCOPES;
}

/** Validate a normalized `--in` prefix against the graph before a query runs. */
export function assertPrefixIndexed(graph, prefix) {
    if (Array.isArray(prefix)) {
        if (prefix.length === 0)
            return;
        for (const p of prefix) {
            if (!p || graph.nodes.some((n) => pathUnderPrefix(n.path, p)))
                continue;
            throw new Error(`nothing indexed under "${p}/"${scopesHereClause(scopesOfGraph(graph))} (or any path prefix)`);
        }
        return;
    }
    if (!prefix || graph.nodes.some((n) => pathUnderPrefix(n.path, prefix)))
        return;
    throw new Error(`nothing indexed under "${prefix}/"${scopesHereClause(scopesOfGraph(graph))} (or any path prefix)`);
}
