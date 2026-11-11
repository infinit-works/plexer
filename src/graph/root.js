/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ANCESTOR holding a plexer index:
 * either a repo's own wiring graph (`plexer/.graph/wiring.json`) or a workspace
 * parent's children index (`plexer/workspace.json`). Nothing indexed anywhere
 * above → the start dir itself, so `plexer build` in a fresh repo still means
 * "here" and no command silently retargets a sibling tree.
 *
 * Only the IMPLICIT case walks. An explicit `[dir]` argument is taken at face
 * value, and a `--dir` override short-circuits entirely: `contextDirFor` returns
 * an override verbatim and ignores the root it is handed, so every ancestor
 * would report the same context dir and the walk would answer "level 0" for a
 * dir that isn't the repo.
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { contextDirFor, wiringPath } from "../context/node-file.js";
import { workspacePath } from "./workspace.js";

const REPO_ROOT_MARKERS = [
    ".git",
    "sert.toml",
    "default.project.json",
    "rokit.toml",
    "wally.toml",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "requirements.txt",
];

/** True when `dir` is a plexer root of either shape — a built repo or a workspace parent. */
export function hasPlexerIndex(dir) {
    return existsSync(wiringPath(contextDirFor(dir))) || existsSync(workspacePath(dir));
}

export function isBoundaryDir(resolved) {
    const norm = resolved.replace(/\\/g, "/");
    return (
        resolved === "/" ||
        resolved === resolve(homedir()) ||
        resolved === resolve(tmpdir()) ||
        /\/(?:\.gemini|\.agents|\.claude|\.codex)(?:\/|$)/.test(norm)
    );
}

/**
 * True when a strict ancestor of `dir` has a `.git` checkout or an existing
 * plexer index. Prevents subdirectories with secondary markers (e.g.
 * `test/default.project.json` or `packages/foo/package.json`) from hijacking
 * their enclosing repository root.
 */
export function hasAncestorRepoOrIndex(dir) {
    let cur = dirname(resolve(dir));
    let prev = resolve(dir);
    while (cur !== prev && !isBoundaryDir(cur)) {
        if (existsSync(join(cur, ".git")) || hasPlexerIndex(cur))
            return true;
        prev = cur;
        cur = dirname(cur);
    }
    return false;
}

/** True when `dir` is a project/repository root suitable for automatic initial indexing. */
export function isAutoBuildableRepo(dir) {
    if (!dir || typeof dir !== "string")
        return false;
    const resolved = resolve(dir);
    if (isBoundaryDir(resolved))
        return false;
    if (existsSync(join(resolved, ".git")))
        return true;
    if (hasAncestorRepoOrIndex(resolved))
        return false;
    return REPO_ROOT_MARKERS.some((m) => existsSync(join(resolved, m)));
}

/** The nearest ancestor of `start` (inclusive) that holds a plexer index (or project root), else `start`. */
export function nearestPlexerRoot(start, override) {
    const from = resolve(start);
    if (override)
        return { root: from, levels: 0 };
    let dir = from;
    for (let levels = 0;; levels++) {
        if (hasPlexerIndex(dir) && (existsSync(join(dir, ".git")) || !hasAncestorRepoOrIndex(dir)))
            return { root: dir, levels };
        const up = dirname(dir);
        if (up === dir)
            break;
        dir = up;
    }
    dir = from;
    for (let levels = 0;; levels++) {
        if (isAutoBuildableRepo(dir))
            return { root: dir, levels };
        const up = dirname(dir);
        if (up === dir)
            return { root: from, levels: 0 }; // hit the filesystem root, nothing indexed
        dir = up;
    }
}
