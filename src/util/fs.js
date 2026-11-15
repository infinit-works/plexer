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
/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. The single source of truth for
 * "is this dir source" — `skippedPath` and `walkFilesystem` below and the
 * git-child discovery in `graph/scope-discovery.js` share it, so they can never
 * independently drift on what counts as skippable.
 *
 * `includes` is the explicit, per-repo `plexer build --include-dir` override
 * (persisted via `util/state.js`'s `readIncludeDirs`, threaded in by each
 * caller) — a name in it is removed from the effective skip set for THIS
 * repo's walks. Absent/empty ≡ today's default behavior. It lifts only
 * plexer's own skip list: in a Git repo, Git's ignore rules stay authoritative
 * (see {@link walkDir}).
 *
 * KNOWN LIMITATION: a dot-directory is skipped WHOLESALE and is NEVER
 * overridable, even via `includes` — unlike `SKIP_DIRS`, there is no path to
 * un-skip one. A repo that keeps real, hand-written source under a
 * dot-prefixed directory is out of scope.
 */
export function shouldSkipDir(name, includes) {
    if (name.startsWith("."))
        return true;
    if (includes?.has(name))
        return false;
    return SKIP_DIRS.has(name);
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
    const out = new Set();
    for (const [rel, entry] of entries) {
        const abs = resolve(root, rel);
        if (skippedPath(relative(state.topRoot, abs), includes)) continue;
        const followChild = (entry.gitlink && opts.followSubmodules === true) || (entry.nested && opts.followNestedRepos === true);
        if (followChild) {
            if (!existsSync(join(abs, ".git"))) continue;
            const childFiles = gitVisibleFiles(abs, includes, opts, state) ?? walkFilesystem(abs, includes);
            for (const file of childFiles) out.add(file);
        } else if (isIndexableFile(abs)) {
            out.add(abs);
        }
    }
    return [...out].sort();
}

function gitVisibleFiles(dir, includes, opts = {}, traversal) {
    const root = resolve(dir);
    if (opts.followSubmodules !== true && opts.followNestedRepos !== true) {
        return gitVisibleFilesShallow(root, includes);
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
    const files = collectGitStageFiles(entries, root, includes, opts, state);
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
    const stdout = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"]);
    if (stdout === null)
        return null;
    const out = [];
    for (const rel of stdout.split("\0")) {
        if (!rel || skippedPath(rel, includes))
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
function skippedPath(path, includes) {
    const posix = toPosixPath(path);
    if (MINIFIED_BUNDLE_RE.test(posix))
        return true;
    return posix.split("/").some((segment) => shouldSkipDir(segment, includes));
}
function walkFilesystem(dir, includes) {
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
        if (entry.isDirectory()) {
            if (shouldSkipDir(entry.name, includes))
                continue;
            out.push(...walkFilesystem(full, includes));
        }
        else if (entry.isFile()) {
            if (entry.name.startsWith(".") || MINIFIED_BUNDLE_RE.test(entry.name))
                continue; // dot-files and minified vendor bundles are not source either
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
