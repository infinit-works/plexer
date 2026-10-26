/**
 * Scope discovery — finds sub-project boundaries inside a repo so ranking can
 * stay per-scope instead of pooling a monorepo's biggest sub-project against
 * everything else. A "scope" is rooted at a directory that carries a
 * project-marker file (`package.json`, `go.mod`, `pyproject.toml`, `setup.py`,
 * `Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts`).
 *
 * Discovery rules (see task brief for the numbered spec):
 *  1. Any directory with >=1 marker file is a scope candidate.
 *  2. Workspace-config-as-intent: `pnpm-workspace.yaml` or root `package.json`
 *     `workspaces` glob(s) are resolved and become the ONLY JS-family
 *     sub-scopes considered — other `package.json` dirs are ignored.
 *  3. Depth guard: candidates deeper than 2 path segments below root are
 *     ignored unless matched by a workspace glob.
 *  4. Nesting collapse: a candidate nested inside another is dropped (keep
 *     the shallower one) — except a workspace-glob match wins over its parent.
 *  5. Minimum-substance guard (< 5 non-file nodes merged into root) runs in
 *     `build.js`, since node counts aren't known at walk time.
 *  6. If exactly the root scope survives (or nothing does), the canonical
 *     single-scope form `[{ prefix: "", label: "", markers: [...] }]` is emitted.
 *  7. `label` = `prefix` (both "" for root); ordering is prefix-length desc,
 *     then lexicographic.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shouldSkipDir, walkDir } from "../ingest/fs.js";
import {
    assertPrefixIndexed,
    pathUnderPrefix,
    relPosix,
    scopeLabel,
    scopeOf,
    scopesHereClause,
    scopesOfGraph,
    stripTrailingSlashes,
    toPosixPath,
} from "../util/paths.js";
import { readJson, readWalkConfig } from "../util/state.js";
export {
    assertPrefixIndexed,
    pathUnderPrefix,
    scopeLabel,
    scopeOf,
    scopesHereClause,
    scopesOfGraph,
};
/** Project-marker files, checked in this order (also the order `markers` is built in). */
const MARKERS = ["package.json", "go.mod", "pyproject.toml", "setup.py", "Cargo.toml", "composer.json", "pom.xml", "build.gradle", "build.gradle.kts"];
const CANONICAL_ROOT = [{ prefix: "", label: "", markers: [] }];
/** Collect directories represented by the canonical visible file set. Building
 * this from `walkDir` keeps scope discovery aligned with extraction: an ignored
 * generated tree cannot become a marker or workspace scope. */
function collectDirs(root, repoFiles) {
    const out = new Set([""]);
    for (const abs of repoFiles) {
        const parts = relPosix(root, abs).split("/");
        parts.pop();
        for (let i = 1; i <= parts.length; i++)
            out.add(parts.slice(0, i).join("/"));
    }
    return [...out];
}
/** Minimal `packages:` list parser for `pnpm-workspace.yaml` — no YAML dependency,
 * handles the `packages:\n  - 'glob'\n  - "glob"` form pnpm actually generates. */
function parsePnpmPackagesList(text) {
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^packages\s*:/.test(l.trim()));
    if (idx === -1)
        return null;
    const globs = [];
    for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "")
            continue;
        if (!/^\s*-\s*/.test(line))
            break; // dedented — list ended
        const val = line.replace(/^\s*-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
        if (val)
            globs.push(val);
    }
    return globs.length ? globs : null;
}
/** Rule 2: resolve workspace-config-as-intent globs. Returns null when the repo has
 * no workspace config (pnpm-workspace.yaml wins over `package.json#workspaces` when
 * both exist). */
function readWorkspaceGlobs(root) {
    const pnpmPath = join(root, "pnpm-workspace.yaml");
    if (existsSync(pnpmPath)) {
        try {
            const globs = parsePnpmPackagesList(readFileSync(pnpmPath, "utf8"));
            if (globs)
                return globs;
        }
        catch {
            /* malformed pnpm-workspace.yaml — fall through to package.json */
        }
    }
    const pkg = readJson(join(root, "package.json"));
    const ws = pkg?.workspaces;
    if (Array.isArray(ws))
        return ws;
    if (ws && Array.isArray(ws.packages))
        return ws.packages;
    return null;
}
/** Resolve one workspace glob against visible directories only. Supports
 * `dir/*` (immediate subdirs), `dir/**` (any nested depth), and literal dirs. */
function resolveGlob(dirs, pattern) {
    const norm = stripTrailingSlashes(toPosixPath(pattern));
    let base;
    let recursive;
    if (norm === "**") {
        base = "";
        recursive = true;
    }
    else if (norm === "*") {
        base = "";
        recursive = false;
    }
    else if (norm.endsWith("/**")) {
        base = norm.slice(0, -3);
        recursive = true;
    }
    else if (norm.endsWith("/*")) {
        base = norm.slice(0, -2);
        recursive = false;
    }
    else if (!norm.includes("*")) {
        return dirs.includes(norm) ? [norm] : [];
    }
    else {
        return []; // unsupported glob form
    }
    return dirs.filter((dir) => {
        if (dir === "")
            return false;
        if (recursive)
            return base === "" || dir.startsWith(`${base}/`);
        const slash = dir.lastIndexOf("/");
        const parent = slash === -1 ? "" : dir.slice(0, slash);
        return parent === base;
    });
}
function collectScopeCandidates(absRoot, dirs) {
    const markerMap = new Map();
    for (const dir of dirs) {
        const found = MARKERS.filter((m) => existsSync(join(absRoot, dir, m)));
        if (found.length)
            markerMap.set(dir, found);
    }
    const workspaceGlobs = readWorkspaceGlobs(absRoot);
    const workspaceMatches = new Set();
    if (workspaceGlobs) {
        for (const glob of workspaceGlobs) {
            for (const dir of resolveGlob(dirs, glob))
                workspaceMatches.add(dir);
        }
    }
    const candidates = new Map();
    for (const [dir, rawMarkers] of markerMap) {
        const isWorkspace = workspaceMatches.has(dir);
        let markers = rawMarkers;
        // Rule 2: with workspace config present, a non-matched dir's package.json
        // marker doesn't count — the globs are the only JS-family intent honored.
        if (workspaceGlobs && !isWorkspace && markers.includes("package.json")) {
            markers = markers.filter((m) => m !== "package.json");
            if (markers.length === 0)
                continue;
        }
        // Rule 3: depth guard (workspace matches are exempt).
        const depth = dir === "" ? 0 : dir.split("/").length;
        if (depth > 2 && !isWorkspace)
            continue;
        candidates.set(dir, { markers, isWorkspace });
    }
    // Workspace-matched dirs are candidates even without a marker file of their own.
    for (const dir of workspaceMatches) {
        const existing = candidates.get(dir);
        if (existing)
            existing.isWorkspace = true;
        else
            candidates.set(dir, { markers: markerMap.get(dir) ?? [], isWorkspace: true });
    }
    return candidates;
}
function findNearestAncestorScopeCandidate(prefix, set) {
    const segs = prefix.split("/");
    for (let i = segs.length - 1; i >= 1; i--) {
        const ancestor = segs.slice(0, i).join("/");
        if (set.has(ancestor))
            return ancestor;
    }
    return null;
}
/**
 * Rule 4: nesting collapse — evaluated in two ordered passes against FROZEN
 * snapshots (deletions are marked first, then applied), never against the
 * live `candidates` map mid-iteration.
 *   Pass A — workspace override (uses the ORIGINAL frozen candidate set).
 *   Pass B — plain nesting collapse (uses the POST-A set).
 */
function collapseNestedScopeCandidates(candidates) {
    const frozen = new Map(candidates);
    const passADeletes = new Set();
    for (const [prefix, entry] of frozen) {
        if (!entry.isWorkspace)
            continue;
        const ancestor = findNearestAncestorScopeCandidate(prefix, frozen);
        if (ancestor && !frozen.get(ancestor).isWorkspace)
            passADeletes.add(ancestor);
    }
    for (const prefix of passADeletes)
        candidates.delete(prefix);
    const postA = new Map(candidates);
    const passBDeletes = new Set();
    for (const [prefix, entry] of postA) {
        if (prefix === "")
            continue;
        const ancestor = findNearestAncestorScopeCandidate(prefix, postA);
        if (!ancestor)
            continue;
        const ancestorEntry = postA.get(ancestor);
        if (!entry.isWorkspace || ancestorEntry.isWorkspace)
            passBDeletes.add(prefix);
    }
    for (const prefix of passBDeletes)
        candidates.delete(prefix);
}
/** Walk the tree (reusing `walkDir`'s persisted directory and submodule
 * choices) and find project-marker dirs. */
export function discoverScopes(root, repoFiles) {
    const absRoot = resolve(root);
    if (!repoFiles) {
        const walkCfg = readWalkConfig(absRoot);
        repoFiles = walkDir(root, walkCfg.includeDirs, {
            followSubmodules: walkCfg.followSubmodules,
            followNestedRepos: walkCfg.followNestedRepos,
        });
    }
    const dirs = collectDirs(absRoot, repoFiles);
    const candidates = collectScopeCandidates(absRoot, dirs);
    collapseNestedScopeCandidates(candidates);
    const survivors = [...candidates.entries()].map(([prefix, c]) => ({ prefix, ...c }));
    // Rule 6: canonical single-scope form when only root survives, or nothing does.
    if (survivors.length === 0)
        return CANONICAL_ROOT;
    if (survivors.length === 1 && survivors[0].prefix === "") {
        return [{ prefix: "", label: "", markers: survivors[0].markers }];
    }
    const scopes = survivors.map((s) => ({
        prefix: s.prefix,
        label: s.prefix,
        markers: s.markers,
    }));
    // Rule 7: deterministic ordering — prefix-length desc, then lexicographic.
    scopes.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
    return scopes;
}
/** Immediate subdirs of `root` that are themselves git repos (have `.git`).
 * Used by workspace federation (Task 5). */
export function discoverWorkspaceChildren(root) {
    const absRoot = resolve(root);
    const { includeDirs: includes } = readWalkConfig(absRoot);
    let entries = [];
    try {
        entries = readdirSync(absRoot, { withFileTypes: true });
    }
    catch {
        /* unreadable root */
    }
    return entries
        .filter((e) => e.isDirectory() && !shouldSkipDir(e.name, includes) && existsSync(join(absRoot, e.name, ".git")))
        .map((e) => e.name);
}
