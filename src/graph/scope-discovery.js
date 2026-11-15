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
import { shouldSkipDir, walkDir } from "../util/fs.js";
import { relPosix, stripTrailingSlashes, toPosixPath } from "../util/paths.js";
import { readJson, readWalkConfig } from "../util/state.js";
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
function parseCargoTomlArray(sectionBody, key) {
    const m = sectionBody.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
    if (!m)
        return [];
    const out = [];
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
        if (q[1])
            out.push(q[1]);
    }
    return out;
}

/** Parse `[workspace].members` and `[workspace].exclude` from `Cargo.toml`. */
function parseCargoWorkspaceGlobs(text) {
    const lines = text.split(/\r?\n/);
    const wsLines = [];
    let inWorkspace = false;
    for (const raw of lines) {
        const clean = raw.replace(/#.*$/, "");
        const hdr = clean.match(/^\s*\[([^\]]+)\]\s*$/);
        if (hdr) {
            inWorkspace = hdr[1].trim() === "workspace";
            continue;
        }
        if (inWorkspace)
            wsLines.push(clean);
    }
    if (wsLines.length === 0)
        return null;
    const body = wsLines.join("\n");
    const members = parseCargoTomlArray(body, "members");
    const excludes = parseCargoTomlArray(body, "exclude").map((e) => (e.startsWith("!") ? e : `!${e}`));
    const globs = [...members, ...excludes];
    return globs.length > 0 ? globs : null;
}

function readJsWorkspaceGlobs(root) {
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

function readCargoWorkspaceGlobs(root) {
    const cargoPath = join(root, "Cargo.toml");
    if (!existsSync(cargoPath))
        return null;
    try {
        return parseCargoWorkspaceGlobs(readFileSync(cargoPath, "utf8"));
    }
    catch {
        return null;
    }
}

/** Resolve one workspace glob against visible directories only. Supports
 * `dir/*`, `dir/**`, literal dirs, and wildcard patterns (e.g. `crates/foo-*`). */
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
        const reBody = norm
            .split("/")
            .map((seg) => (seg === "**" ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
            .join("/");
        const re = new RegExp(`^${reBody}$`);
        return dirs.filter((d) => d !== "" && re.test(d));
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

function applyWorkspaceGlobs(dirs, globs) {
    const matches = new Set();
    const excluded = new Set();
    if (!globs)
        return { matches, excluded };
    for (const raw of globs) {
        const pattern = String(raw).trim();
        if (!pattern)
            continue;
        if (pattern.startsWith("!")) {
            const neg = pattern.slice(1).trim();
            for (const dir of resolveGlob(dirs, neg)) {
                matches.delete(dir);
                excluded.add(dir);
            }
            // If `!dir/**` or `!dir` is given, also strip subdirs under `dir/`
            const cleanNeg = stripTrailingSlashes(toPosixPath(neg)).replace(/\/\*\*?$/, "");
            if (cleanNeg && !cleanNeg.includes("*")) {
                for (const d of dirs) {
                    if (d === cleanNeg || d.startsWith(`${cleanNeg}/`)) {
                        matches.delete(d);
                        excluded.add(d);
                    }
                }
            }
        }
        else {
            for (const dir of resolveGlob(dirs, pattern))
                matches.add(dir);
        }
    }
    return { matches, excluded };
}

function collectScopeCandidates(absRoot, dirs) {
    const markerMap = new Map();
    for (const dir of dirs) {
        const found = MARKERS.filter((m) => existsSync(join(absRoot, dir, m)));
        if (found.length)
            markerMap.set(dir, found);
    }
    const jsGlobs = readJsWorkspaceGlobs(absRoot);
    const cargoGlobs = readCargoWorkspaceGlobs(absRoot);
    const jsWs = applyWorkspaceGlobs(dirs, jsGlobs);
    const cargoWs = applyWorkspaceGlobs(dirs, cargoGlobs);
    const workspaceMatches = new Set([...jsWs.matches, ...cargoWs.matches]);
    const candidates = new Map();
    for (const [dir, rawMarkers] of markerMap) {
        const isWorkspace = workspaceMatches.has(dir);
        let markers = rawMarkers;
        // Rule 2: with JS workspace config present, a non-matched dir's package.json
        // marker doesn't count — the globs are the only JS-family intent honored.
        if (jsGlobs && !jsWs.matches.has(dir) && markers.includes("package.json"))
            markers = markers.filter((m) => m !== "package.json");
        // Negated Cargo workspace patterns (`!crates/foo` or `exclude`) drop Cargo.toml as well.
        if (cargoWs.excluded.has(dir) && markers.includes("Cargo.toml"))
            markers = markers.filter((m) => m !== "Cargo.toml");
        if (markers.length === 0)
            continue;
        // Rule 3: depth guard (workspace matches are exempt).
        const depth = dir === "" ? 0 : dir.split("/").length;
        if (depth > 2 && !isWorkspace)
            continue;
        candidates.set(dir, { markers, isWorkspace });
    }
    // Workspace-matched dirs are candidates even without a marker file of their own.
    for (const dir of workspaceMatches) {
        if (!candidates.has(dir))
            candidates.set(dir, { markers: [], isWorkspace: true });
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
export function discoverScopes(root, repoFiles, contextDir) {
    if (repoFiles && !Array.isArray(repoFiles) && typeof repoFiles === "object") {
        contextDir = repoFiles.contextDir;
        repoFiles = repoFiles.repoFiles;
    }
    const absRoot = resolve(root);
    if (!repoFiles) {
        const walkCfg = readWalkConfig(absRoot, contextDir);
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
export function discoverWorkspaceChildren(root, contextDir) {
    if (contextDir && typeof contextDir === "object") {
        contextDir = contextDir.contextDir;
    }
    const absRoot = resolve(root);
    const { includeDirs: includes } = readWalkConfig(absRoot, contextDir);
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
