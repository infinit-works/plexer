/**
 * Repo-relative paths, always posix, plus canonical context-directory resolution.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Platform separators → `/`. Identity on posix. */
export function toPosixPath(p) {
    return sep === "/" ? p : p.split(sep).join("/");
}

/** `relative(from, to)`, normalized to posix — the canonical form of every stored path. */
export function relPosix(from, to) {
    return toPosixPath(relative(from, to));
}

/** Trailing `/` off a repo-relative path, in linear time. */
export function stripTrailingSlashes(path) {
    let end = path.length;
    while (end > 0 && path[end - 1] === "/")
        end--;
    return path.slice(0, end);
}

/** Normalize a user-supplied path prefix (`--in`) to posix with no leading `./` or trailing `/`. */
export function normalizePathPrefix(p) {
    if (Array.isArray(p)) {
        const list = p.map((x) => normalizePathPrefix(x)).filter(Boolean);
        return list.length === 1 ? list[0] : list;
    }
    let out = toPosixPath(p);
    while (out.startsWith("./"))
        out = out.slice(2);
    return stripTrailingSlashes(out);
}

/** Segment-aware "is `path` at or under `prefix`?". */
export function pathUnderPrefix(path, prefix) {
    if (Array.isArray(prefix)) {
        return prefix.length === 0 || prefix.some((p) => p === "" || path === p || path.startsWith(`${p}/`));
    }
    return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** Absolute path of the `plexer/` directory for a repo root (`PLEXER_DIR` or `override` wins). */
export function contextDirFor(root, override) {
    const chosen = override || process.env.PLEXER_DIR?.trim();
    if (chosen)
        return isAbsolute(chosen) ? chosen : join(root, chosen);
    return join(root, "plexer");
}

/** Append `value` to the array at `map.get(key)`, creating the array on first insert. */
export function pushMap(map, key, value) {
    const list = map.get(key);
    if (list)
        list.push(value);
    else
        map.set(key, [value]);
}

/**
 * Compile a repo-relative glob pattern (`*`, `**`, `?`, or a plain directory prefix)
 * into a RegExp matching posix-normalized paths.
 */
export function globToRegExp(globPat) {
    let pat = String(globPat || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "");
    if (!pat)
        return /^$/;
    if (!pat.includes("*") && !pat.includes("?")) {
        const clean = stripTrailingSlashes(pat);
        if (!clean)
            return /^$/;
        const esc = clean.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${esc}(?:/.*)?$`);
    }
    if (pat.endsWith("/"))
        pat = `${pat}**`;
    let rx = "^";
    let i = 0;
    while (i < pat.length) {
        if (pat.slice(i, i + 4) === "/**/") {
            rx += "(?:/.+/|/)";
            i += 4;
        }
        else if (i === 0 && pat.slice(0, 3) === "**/") {
            rx += "(?:.+/)?";
            i += 3;
        }
        else if (i + 3 === pat.length && pat.slice(i) === "/**") {
            rx += "(?:/.*)?";
            i += 3;
        }
        else if (pat.slice(i, i + 2) === "**") {
            rx += ".*";
            i += 2;
        }
        else if (pat[i] === "*") {
            rx += "[^/]*";
            i += 1;
        }
        else if (pat[i] === "?") {
            rx += "[^/]";
            i += 1;
        }
        else {
            rx += pat[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
            i += 1;
        }
    }
    rx += "$";
    return new RegExp(rx);
}

/** True when `path` resides inside a dependency/vendored tree. */
export function isDependencyPath(path) {
    return /(?:^|\/)(?:vendor|third_party|third-party|external|submodules|Packages|ServerPackages|DevPackages|RobloxPackages|roblox_packages|luau_packages|_Index)\//i.test(path || "");
}

/** True when `path` is a test, spec, benchmark, fixture, or mock file across supported languages. */
export function isTestPath(path) {
    return /(?:^|\/)(?:__tests__|tests?|testdata|specs?|bench|benchmarks?|fixtures?|__mocks__|mocks?)\/|\.(?:test|spec|bench|mock)\.[a-z0-9]+$|_(?:test|spec|bench|mock)\.(?:go|py|rb|rs|luau|lua|ts|js|tsx|jsx|mjs|cjs)$|(?:^|\/)(?:test_[^/]+|mock_[^/]+|conftest)\.(?:py|go|rb|rs|luau|lua|ts|js)$/i.test(path || "");
}

/** True when `path` is a generated, protobuf, or minified bundle artifact. */
export function isGeneratedPath(path) {
    return /\.pb\.(?:go|ts|js|cc|h)$|_pb2(?:_grpc)?\.py$|\.(?:min|bundle)\.(?:js|mjs|cjs|css)$|(?:^|\/|\.)(?:generated|__generated__|gen)\.[a-z0-9]+$|(?:\b|^)(?:generated|__generated__)\//i.test(path || "");
}

/** Convert a `file://` URI (or pass through a filesystem path) into a local path string. */
export function fileUriToPath(uri) {
    if (!uri || typeof uri !== "string")
        return null;
    if (uri.startsWith("file://")) {
        try {
            return fileURLToPath(uri);
        }
        catch {
            try {
                return decodeURIComponent(new URL(uri).pathname);
            }
            catch {
                return uri.slice(7);
            }
        }
    }
    return uri;
}

/** True when `candidateAbs` resolves lexically inside `rootAbs` (or equals it when `allowEqual`). */
export function isLexicallyWithin(rootAbs, candidateAbs, { allowEqual = true } = {}) {
    if (!rootAbs || !candidateAbs)
        return false;
    const rel = relative(resolve(rootAbs), resolve(candidateAbs));
    if (rel === "")
        return allowEqual;
    return !rel.startsWith("..") && !isAbsolute(rel);
}
