/**
 * Filesystem walking used by `init`/`check` to enumerate a repo's source files.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./git.js";
import { isLexicallyWithin, toPosixPath } from "./paths.js";

/** Resolve symlinks with `resolve(p)` fallback when the target does not exist. */
export function tryRealpath(p) {
    if (!p || typeof p !== "string")
        return null;
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
}

/** True when `candidatePath` resides inside (or matches) `allowedRoot` after realpath resolution. */
export function isWithinRoot(candidatePath, allowedRoot, opts = {}) {
    if (!candidatePath || !allowedRoot)
        return false;
    const base = tryRealpath(allowedRoot);
    const target = tryRealpath(candidatePath);
    if (!base || !target)
        return false;
    return isLexicallyWithin(base, target, opts);
}
/** Safe directory-existence check (`false` on absent or non-directory paths). */
export function dirExists(p) {
    let isDir = false;
    try {
        isDir = statSync(p).isDirectory();
    }
    catch {
        /* absent or unreadable */
    }
    return isDir;
}

/** Directories that are dependency/build output, never source. */
export const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    // The underscore spelling that Sphinx, CMake, Jekyll and the OCaml tools all
    // emit. Left out, a materialized build tree lands in the graph as ordinary
    // source: one repo here indexed 4,484 files of vendored WordPress against 121
    // hand-written ones, and queries slowed enough that the prompt hook's budget
    // could no longer fit them. `--include-dir _build` remains the way back in.
    "_build",
    "out",
    "target",
    "vendor",
    "coverage",
    "__pycache__",
    "venv",
]);
/** Files above this size are generated/vendored in practice, not hand-written code. */
export const MAX_FILE_BYTES = 1_000_000;
/** Normalize bare names, relative directory prefixes, and exact files into a shared walk filter. */
export function normalizeWalkIncludes(includes, extraExactFiles = null) {
    if (includes && includes._normalized === true && !extraExactFiles)
        return includes;
    const bareNames = new Set(includes?._normalized ? includes.bareNames : []);
    const pathPrefixes = new Set(includes?._normalized ? includes.pathPrefixes : []);
    const exactFiles = new Set(includes?._normalized ? includes.exactFiles : []);
    const ancestorDirs = new Set(includes?._normalized ? includes.ancestorDirs : []);

    const addEntry = (raw, isExact = false) => {
        if (typeof raw !== "string")
            return;
        const norm = toPosixPath(raw).trim().replace(/^\.\//, "").replace(/\/+$/, "");
        if (!norm || norm === "." || norm.startsWith("..") || isAbsolute(norm))
            return;
        if (isExact) {
            exactFiles.add(norm);
        }
        else if (norm.includes("/")) {
            pathPrefixes.add(norm);
        }
        else {
            bareNames.add(norm);
            return;
        }
        const parts = norm.split("/").filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
            ancestorDirs.add(parts.slice(0, i).join("/"));
        }
    };

    if (includes && !includes._normalized) {
        if (includes instanceof Set || Array.isArray(includes)) {
            for (const entry of includes)
                addEntry(entry, false);
        }
        else if (typeof includes === "object") {
            for (const entry of includes.bareNames ?? [])
                addEntry(entry, false);
            for (const entry of includes.pathPrefixes ?? includes.includePrefixes ?? [])
                addEntry(entry, false);
            for (const entry of includes.exactFiles ?? [])
                addEntry(entry, true);
        }
    }
    for (const f of extraExactFiles ?? [])
        addEntry(f, true);

    const sortedPrefixes = [...pathPrefixes].sort((a, b) => b.length - a.length || a.localeCompare(b));
    return {
        _normalized: true,
        bareNames,
        pathPrefixes: sortedPrefixes,
        exactFiles,
        ancestorDirs,
    };
}

function findMatchingIncludePrefix(relPosixPath, normIncludes) {
    if (!normIncludes || normIncludes.pathPrefixes.length === 0)
        return null;
    for (const prefix of normIncludes.pathPrefixes) {
        if (relPosixPath === prefix || relPosixPath.startsWith(`${prefix}/`))
            return prefix;
    }
    return null;
}

/**
 * Determine how a directory `relDirPosix` should be visited during traversal:
 *   - `"include"`: walk normally (dir itself and non-skipped descendants)
 *   - `"traverse"`: descend only toward deeper mounted children or `exactFiles`
 *   - `"skip"`: prune directory completely
 */
export function dirVisitMode(relDirPosix, dirName, includes, parentMode = "include") {
    const norm = normalizeWalkIncludes(includes);
    const cleanRel = toPosixPath(relDirPosix || "").replace(/^\.\//, "").replace(/\/+$/, "");
    const matchedPrefix = cleanRel ? findMatchingIncludePrefix(cleanRel, norm) : null;
    if (matchedPrefix) {
        if (cleanRel === matchedPrefix)
            return "include";
        const tail = cleanRel.slice(matchedPrefix.length + 1);
        const hasSkippedTail = tail.split("/").some((seg) => shouldSkipDirSegment(seg, norm.bareNames));
        return hasSkippedTail ? "skip" : "include";
    }
    if (cleanRel && norm.ancestorDirs.has(cleanRel))
        return "traverse";
    if (parentMode === "traverse")
        return "skip";
    return shouldSkipDirSegment(dirName, norm.bareNames) ? "skip" : "include";
}

function shouldSkipDirSegment(name, bareNames) {
    if (name.startsWith("."))
        return true;
    if (bareNames?.has(name))
        return false;
    return SKIP_DIRS.has(name);
}

/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. When `relPath` is passed, relative
 * path-prefix includes (e.g. `vendor/flux/src`) are honored alongside bare names.
 */
export function shouldSkipDir(name, includes, relPath = null) {
    const norm = normalizeWalkIncludes(includes);
    if (relPath) {
        return dirVisitMode(relPath, name, norm) === "skip";
    }
    return shouldSkipDirSegment(name, norm.bareNames);
}
/**
 * Directory `walkDir` actually enumerates.
 *
 * `path.resolve` does not follow a symlink, and git discovers the repo from the
 * child cwd. Unwrap a symlink-to-directory once so the walk runs inside the
 * target. Ordinary directories stay as `resolve(dir)` — not `realpath` — so a
 * macOS `/var/folders/…` scratch path is the path the caller handed us.
 *
 * A broken symlink throws instead of the `scandir ENOENT` `readdirSync` would
 * raise after git fails. Internal symlink policy is not decided here.
 */
function canonicalWalkRoot(dir) {
    const abs = resolve(dir);
    let st;
    try {
        st = lstatSync(abs);
    }
    catch {
        return abs;
    }
    if (!st.isSymbolicLink())
        return abs;
    let real;
    try {
        real = realpathSync(abs);
    }
    catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
        if (code === "ELOOP")
            throw new Error(`symbolic link loop: ${abs}`);
        throw new Error(`broken symbolic link: ${abs}`);
    }
    let realSt;
    try {
        realSt = statSync(real);
    }
    catch {
        throw new Error(`broken symbolic link: ${abs}`);
    }
    if (!realSt.isDirectory())
        return abs;
    return real;
}
function escapedCanonical(canonical, abs) {
    const rel = relative(canonical, abs);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
const recentStatCache = new Map();
/** Consume a stat entry captured during the most recent {@link walkDir} pass. */
export function takeCachedStat(abs) {
    const s = recentStatCache.get(abs);
    if (s) {
        recentStatCache.delete(abs);
        return s;
    }
    return null;
}
/** Keep emitted paths on the requested root so relative paths stay stable. */
function remapWalkPaths(requested, canonical, files) {
    if (requested === canonical)
        return files;
    const out = [];
    for (const abs of files) {
        if (escapedCanonical(canonical, abs))
            continue;
        const rel = relative(canonical, abs);
        if (rel === "")
            continue;
        const mapped = join(requested, rel);
        const st = recentStatCache.get(abs);
        if (st) {
            recentStatCache.delete(abs);
            recentStatCache.set(mapped, st);
        }
        out.push(mapped);
    }
    return out;
}
/**
 * Recursively list source files under `dir`. A directory symlink as the *input
 * root* is unwrapped once ({@link canonicalWalkRoot}); emitted paths are remapped
 * onto the caller-facing root so `relPosix` stays `src/foo.ts` rather than a
 * `../` escape through the physical path (macOS `/tmp` → `/private/tmp`).
 * Symlinks *inside* the tree are not followed: git still `lstat`s each listed
 * path, and the filesystem walk still requires `Dirent.isFile` / `isDirectory`.
 */
export function walkDir(dir, includes, opts = {}) {
    recentStatCache.clear();
    const requested = resolve(dir);
    const root = canonicalWalkRoot(requested);
    const files = gitVisibleFiles(root, includes, opts) ?? walkFilesystem(root, includes);
    return remapWalkPaths(requested, root, files);
}
/** Git's canonical working-tree file set, relative to `dir`. Tracked files are
 * deliberately included even when a later ignore rule matches them; `.gitignore`
 * only controls untracked files in Git, and plexer follows the same contract. */
function parseGitStageEntries(stdout) {
    const entries = new Map();
    for (const record of stdout.split("\0")) {
        if (!record || record.length < 2 || record[1] !== " ") continue;
        const tag = record[0];
        const body = record.slice(2);
        let rel;
        let gitlink = false;
        let nested = false;
        if (tag === "?") {
            nested = body.endsWith("/");
            rel = nested ? body.slice(0, -1) : body;
        } else {
            const tab = body.indexOf("\t");
            if (tab === -1) continue;
            gitlink = body.startsWith("160000 ");
            rel = body.slice(tab + 1);
        }
        if (!rel) continue;
        const prior = entries.get(rel);
        entries.set(rel, {
            gitlink: gitlink || prior?.gitlink === true,
            nested: nested || prior?.nested === true,
        });
    }
    return entries;
}

function collectGitStageFiles(entries, root, includes, opts, state) {
    const normIncludes = normalizeWalkIncludes(includes);
    const out = new Set();
    for (const [rel, entry] of entries) {
        const abs = resolve(root, rel);
        const relFromTop = relative(state.topRoot, abs);
        const isDirEntry = Boolean(entry.gitlink || entry.nested);
        if (skippedPath(relFromTop, normIncludes, isDirEntry)) continue;
        const followChild = (entry.gitlink && opts.followSubmodules === true) || (entry.nested && opts.followNestedRepos === true);
        if (followChild) {
            if (!existsSync(join(abs, ".git"))) continue;
            const childFiles = gitVisibleFiles(abs, normIncludes, opts, state) ?? walkFilesystem(abs, normIncludes, state.topRoot, toPosixPath(relFromTop));
            for (const file of childFiles) out.add(file);
        } else if (isIndexableFile(abs)) {
            out.add(abs);
        }
    }
    return [...out].sort();
}

function gitVisibleFiles(dir, includes, opts = {}, traversal) {
    const root = resolve(dir);
    const normIncludes = normalizeWalkIncludes(includes);
    if (opts.followSubmodules !== true && opts.followNestedRepos !== true) {
        return gitVisibleFilesShallow(root, normIncludes);
    }
    const state = traversal ?? { topRoot: root, activeRoots: new Set() };
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
    if (state.activeRoots.has(rootKey)) return [];
    state.activeRoots.add(rootKey);
    const stdout = git(root, ["ls-files", "-t", "--stage", "--cached", "--others", "--exclude-standard", "-z", "--"]);
    if (stdout === null) {
        state.activeRoots.delete(rootKey);
        return null;
    }
    const entries = parseGitStageEntries(stdout);
    const files = collectGitStageFiles(entries, root, normIncludes, opts, state);
    state.activeRoots.delete(rootKey);
    return files;
}
function isIndexableFile(abs) {
    try {
        const stat = lstatSync(abs);
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
            recentStatCache.set(abs, { size: stat.size, mtimeMs: stat.mtimeMs });
            return true;
        }
        return false;
    }
    catch {
        // A tracked file deleted from the working tree is still printed by
        // `--cached`; absence means it is not part of the current source set.
        return false;
    }
}
/** The historical, non-recursive Git path. Kept separate so the default does
 * exactly the same command, filtering, ordering, and duplicate handling as it
 * did before submodule support existed. */
function gitVisibleFilesShallow(root, includes) {
    const normIncludes = normalizeWalkIncludes(includes);
    const stdout = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"]);
    if (stdout === null)
        return null;
    const out = [];
    for (const rel of stdout.split("\0")) {
        if (!rel || skippedPath(rel, normIncludes, false))
            continue;
        const abs = resolve(root, rel);
        if (isIndexableFile(abs))
            out.push(abs);
    }
    return out;
}
/** A path (git-relative, either separator) is skipped when any of its
 * segments is a skippable directory name — the final segment doubles as the
 * dot-FILE check (`.eslintrc.js` and friends are not source either). */
const MINIFIED_BUNDLE_RE = /\.(?:min|bundle)\.(?:js|mjs|cjs|css)$/i;
function skippedPath(path, includes, isDir = false) {
    const posix = toPosixPath(path).replace(/^\.\//, "");
    if (!posix)
        return false;
    if (MINIFIED_BUNDLE_RE.test(posix))
        return true;
    const norm = normalizeWalkIncludes(includes);
    const segments = posix.split("/").filter(Boolean);
    const lastSeg = segments[segments.length - 1] || "";
    if (!isDir && lastSeg.startsWith("."))
        return true;
    if (!isDir && norm.exactFiles.has(posix))
        return false;
    const matchedPrefix = findMatchingIncludePrefix(posix, norm);
    if (matchedPrefix) {
        if (posix === matchedPrefix)
            return false;
        const tail = posix.slice(matchedPrefix.length + 1);
        const tailSegs = tail.split("/").filter(Boolean);
        return tailSegs.some((seg) => shouldSkipDirSegment(seg, norm.bareNames));
    }
    if (isDir && norm.ancestorDirs.has(posix))
        return false;
    return segments.some((segment) => shouldSkipDirSegment(segment, norm.bareNames));
}
function walkFilesystem(dir, includes, rootDir = dir, relDir = "", parentMode = "include") {
    const normIncludes = normalizeWalkIncludes(includes);
    const out = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            const mode = dirVisitMode(childRel, entry.name, normIncludes, parentMode);
            if (mode === "skip")
                continue;
            out.push(...walkFilesystem(full, normIncludes, rootDir, childRel, mode));
        }
        else if (entry.isFile()) {
            if (entry.name.startsWith(".") || MINIFIED_BUNDLE_RE.test(entry.name))
                continue; // dot-files and minified vendor bundles are not source either
            if (parentMode === "traverse" && !normIncludes.exactFiles.has(childRel))
                continue;
            try {
                const st = statSync(full);
                if (st.size > MAX_FILE_BYTES)
                    continue;
                recentStatCache.set(full, { size: st.size, mtimeMs: st.mtimeMs });
            }
            catch {
                continue;
            }
            out.push(full);
        }
    }
    return out;
}
