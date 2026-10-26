/**
 * Repo-relative paths, always posix.
 *
 * Every path plexer stores — node ids, `node.path`, extract-cache keys, the
 * freshness fingerprint, the card manifest — is repo-relative and separated by
 * `/` on every platform. That is not cosmetic: the query layer parses these
 * strings with `/` as the separator, and does it by hand rather than through
 * `node:path`. `pathUnderPrefix` (`--in` scoping) tests
 * `startsWith(`${prefix}/`)`, `map`'s `dirKey` splits on `/` to cluster by
 * directory, `resolveSymbol` matches a filename query with
 * `endsWith("/" + query)`. Hand any of them a `src\gate.ts` and none of them
 * error — they match nothing, silently. On Windows that made every `--in`
 * report "nothing indexed under …" and made `map` emit one single-file
 * "directory" per file.
 *
 * So normalize once, here, where a path is *created*, instead of defensively at
 * each consumer — a consumer that forgets is a silent wrong answer, and there
 * are more consumers than producers.
 *
 * {@link toPosixPath} splits on the platform `sep`, never a literal `\`: a
 * posix filename may legitimately contain a backslash, and splitting on `"\\"`
 * would corrupt it. That also makes this module provably the identity function
 * on posix, which is what guarantees an existing Mac/Linux graph is byte-identical
 * across this change.
 */
import { relative, sep } from "node:path";
/** Platform separators → `/`. Identity on posix. */
export function toPosixPath(p) {
    return sep === "/" ? p : p.split(sep).join("/");
}
/**
 * `relative(from, to)`, normalized to posix — the canonical form of every path
 * plexer stores. Use this rather than bare `relative` for anything that lands in
 * the graph, a cache key, or a manifest. Bare `relative` is still right for
 * text shown in the terminal, where a native separator is what the platform's
 * users expect.
 */
export function relPosix(from, to) {
    return toPosixPath(relative(from, to));
}
/**
 * Trailing `/` off a repo-relative path, in linear time.
 *
 * The obvious `replace(/\/+$/, "")` is a polynomial-ReDoS shape — `\/+$` can begin
 * matching at any point inside a run of slashes, so a path ending in many slashes
 * and then anything else costs O(n²). CodeQL flags it (`js/polynomial-redos`), and
 * rightly: these inputs are a `--dir` or `--in` value rather than anything
 * attacker-controlled, but the ambiguity buys nothing and a loop is both faster
 * and plainer.
 */
export function stripTrailingSlashes(path) {
    let end = path.length;
    while (end > 0 && path[end - 1] === "/")
        end--;
    return path.slice(0, end);
}
/**
 * Normalize a user-supplied path prefix (`--in`) so it can be compared against
 * a stored `node.path`: posix separators, no leading `./`, no trailing
 * separator. Windows users type — and their shell's tab-completion produces —
 * `--in server\src\gpu`, so both separators have to reduce to the same prefix.
 */
export function normalizePathPrefix(p) {
    let out = toPosixPath(p);
    while (out.startsWith("./"))
        out = out.slice(2);
    // Trailing separators only; a bare "/" normalizes to "" (match everything),
    // which is exactly how `pathUnderPrefix` reads an empty prefix.
    return stripTrailingSlashes(out);
}
/** Append `value` to the array at `map.get(key)`, creating the array on first insert. */
export function pushMap(map, key, value) {
    const list = map.get(key);
    if (list)
        list.push(value);
    else
        map.set(key, [value]);
}

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

/** Segment-aware "is `path` at or under `prefix`?". */
export function pathUnderPrefix(path, prefix) {
    return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** Every consumer's entry point to a graph's scopes. */
export function scopesOfGraph(graph) {
    return graph?.meta?.scopes ?? CANONICAL_ROOT_SCOPES;
}

/** Validate a normalized `--in` prefix against the graph before a query runs. */
export function assertPrefixIndexed(graph, prefix) {
    if (!prefix || graph.nodes.some((n) => pathUnderPrefix(n.path, prefix)))
        return;
    throw new Error(`nothing indexed under "${prefix}/"${scopesHereClause(scopesOfGraph(graph))} (or any path prefix)`);
}
