/**
 * The `plexer/.cache/` sidecar state: statusline stats snapshot, per-session state,
 * persisted repository walk settings (`config.json`), and the build lock that serializes rebuilds.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname, isAbsolute, relative, resolve } from "node:path";
import { contextDirFor } from "./paths.js";

const LOCK_STALE_MS = 300000;
const SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_FILE = ".sync.lock";
let atomicSeq = 0;

export function emptyStats() {
    return {
        nodeCount: 0,
        edgeCount: 0,
        languages: [],
        totalCount: 0,
        staleCount: 0,
        dirty: false,
        syncing: false,
        syncedAt: null,
        lastFile: null,
    };
}

export function cacheDir(projectDir, override) {
    return join(contextDirFor(projectDir, override), ".cache");
}

function statsPath(d) {
    return join(cacheDir(d), "stats.json");
}

export function readJson(p) {
    let parsed = null;
    try {
        parsed = JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        /* absent or invalid JSON */
    }
    return parsed;
}

/**
 * Write JSON to `p` via a scratch file and atomic rename so concurrent readers
 * never see a truncated prefix. Cleans up its scratch file on failure.
 */
export function writeJsonAtomic(p, value, compact = false) {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${++atomicSeq}.tmp`;
    try {
        writeFileSync(tmp, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
        renameSync(tmp, p);
    }
    catch (e) {
        try {
            rmSync(tmp, { force: true });
        }
        catch { /* nothing more we can do */ }
        throw e;
    }
}

export function readStats(d) {
    return readJson(statsPath(d));
}

function writeStats(d, s) {
    writeJsonAtomic(statsPath(d), s);
}

export function patchStats(d, patch) {
    const next = { ...(readStats(d) ?? emptyStats()), ...patch };
    writeStats(d, next);
    return next;
}

export function readWiring(projectDir) {
    return readJson(join(contextDirFor(projectDir), ".graph", "wiring.json"));
}

export function computeStats(w) {
    const nodes = w.nodes ?? [];
    const edges = w.edges ?? [];
    return {
        nodeCount: w.meta?.nodeCount ?? nodes.length,
        edgeCount: w.meta?.edgeCount ?? edges.length,
        languages: w.meta?.languages ?? [],
        totalCount: nodes.length,
    };
}

function emptySession() {
    return { lastQuery: null, perAgentQuery: {}, injectedPointers: [], emittedBlastFiles: [], nudges: 0 };
}

/** The per-repo session directory holding one `<id>.json` per agent session. */
export function sessionDir(d) {
    return join(cacheDir(d), "session");
}

export function sessionPath(d, id) {
    const safeId = String(id || "default").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
    return join(sessionDir(d), `${safeId}.json`);
}

export function readSession(d, id) {
    return readJson(sessionPath(d, id)) ?? emptySession();
}

export function writeSession(d, id, s) {
    const dir = sessionDir(d);
    try {
        const now = Date.now();
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json"))
                continue;
            const full = join(dir, name);
            try {
                if (now - statSync(full).mtimeMs > SESSION_STALE_MS)
                    rmSync(full, { force: true });
            }
            catch { /* ignore */ }
        }
    }
    catch { /* session dir may not exist yet */ }
    writeJsonAtomic(sessionPath(d, id), s);
}

export function readStdin() {
    const seam = process.env.PLEXER_TEST_STDIN;
    let raw = seam;
    if (raw === undefined) {
        try {
            raw = readFileSync(0, "utf8");
        }
        catch {
            raw = "";
        }
    }
    let parsed = {};
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        /* empty or non-JSON stdin */
    }
    return parsed;
}

export function projectDir(input) {
    return process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

/**
 * Resolve `<gitCommonDir>/info/exclude` for a Git checkout (standard `.git` dir,
 * linked worktree with `commondir`, or submodule `.git` file). Returns `null`
 * when `root` is not a Git repository root.
 */
export function resolveGitExcludePath(root) {
    try {
        const dot = join(root, ".git");
        if (!existsSync(dot) || lstatSync(dot).isSymbolicLink())
            return null;
        const st = statSync(dot);
        if (st.isDirectory())
            return join(dot, "info", "exclude");
        if (!st.isFile())
            return null;
        const line = readFileSync(dot, "utf8").split("\n").find((l) => l.startsWith("gitdir:"));
        if (line === undefined)
            return null;
        const target = line.slice("gitdir:".length).trim();
        if (!target)
            return null;
        const gitdir = isAbsolute(target) ? target : resolve(root, target);
        const realRoot = realpathSync(resolve(root));
        const commondirFile = join(gitdir, "commondir");
        if (existsSync(commondirFile)) {
            const rel = readFileSync(commondirFile, "utf8").trim();
            if (rel) {
                const common = isAbsolute(rel) ? rel : resolve(gitdir, rel);
                if (
                    basename(common) === ".git" &&
                    existsSync(common) &&
                    statSync(common).isDirectory() &&
                    basename(dirname(gitdir)) === "worktrees" &&
                    realpathSync(join(common, "worktrees", basename(gitdir))) === realpathSync(gitdir)
                ) {
                    return join(common, "info", "exclude");
                }
            }
        }
        if (existsSync(gitdir) && statSync(gitdir).isDirectory()) {
            const realGitdir = realpathSync(gitdir);
            const relToRoot = relative(realRoot, realGitdir);
            if (relToRoot && !relToRoot.startsWith("..") && !isAbsolute(relToRoot)) {
                return join(gitdir, "info", "exclude");
            }
        }
        return null;
    }
    catch (err) {
        if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
            return null;
        }
        throw err;
    }
}

function hasIgnoreLine(content, bareDir, entry) {
    return content.split(/\r?\n/).some((line) => {
        const value = line.trim();
        return value === entry || value === `${bareDir}/` || value === bareDir;
    });
}

/**
 * Append an anchored `/<bareDir>/` entry to `<root>`'s `.git/info/exclude` if not
 * already ignored in `.gitignore` or `.git/info/exclude`. Never creates or dirties
 * a tracked `.gitignore`, and skips non-git directories entirely.
 */
export function appendGitignoreEntry(root, bareDir, note) {
    const entry = `/${bareDir}/`;
    try {
        const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
        if (hasIgnoreLine(gitignore, bareDir, entry))
            return;
    }
    catch { /* no .gitignore */ }
    const excludePath = resolveGitExcludePath(root);
    if (!excludePath)
        return;
    let current = "";
    try {
        current = readFileSync(excludePath, "utf8");
    }
    catch { /* no info/exclude yet */ }
    if (hasIgnoreLine(current, bareDir, entry))
        return;
    const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    try {
        mkdirSync(dirname(excludePath), { recursive: true });
        writeFileSync(excludePath, `${current}${gap}# ${note}\n${entry}\n`);
    }
    catch { /* best-effort */ }
}

export function buildConfigPath(d, override) {
    return join(cacheDir(d, override), "config.json");
}

export function readBuildConfig(d, override) {
    return readJson(buildConfigPath(d, override));
}

export function writeBuildConfig(d, c, override) {
    writeJsonAtomic(buildConfigPath(d, override), c);
}

export function patchBuildConfig(d, patch, override) {
    writeBuildConfig(d, { ...(readBuildConfig(d, override) ?? {}), ...patch }, override);
}

export function readIncludeDirs(d, cfg = readBuildConfig(d)) {
    const dirs = cfg?.includeDirs;
    return dirs && dirs.length ? new Set(dirs) : undefined;
}

export function readFollowSubmodules(d, cfg = readBuildConfig(d)) {
    if (typeof cfg?.followSubmodules === "boolean")
        return cfg.followSubmodules;
    try {
        return readFileSync(join(d, "default.project.json"), "utf8").includes("submodules/");
    }
    catch {
        return false;
    }
}

export function readFollowNestedRepos(d, cfg = readBuildConfig(d)) {
    return cfg?.followNestedRepos === true;
}

/** Read `plexer/.cache/config.json` once and derive all walk options for `walkDir`. */
export function readWalkConfig(d, override) {
    const cfg = readBuildConfig(d, override);
    return {
        includeDirs: readIncludeDirs(d, cfg),
        followSubmodules: readFollowSubmodules(d, cfg),
        followNestedRepos: readFollowNestedRepos(d, cfg),
    };
}

export function acquireLock(d) {
    return acquireLockIn(cacheDir(d));
}

export function updateLockPid(d, pid = process.pid) {
    updateLockPidIn(cacheDir(d), pid);
}

export function releaseLock(d, expectedPid = process.pid) {
    releaseLockIn(cacheDir(d), expectedPid);
}

function pidAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err?.code === "EPERM";
    }
}

export function acquireLockIn(cache) {
    const p = join(cache, LOCK_FILE);
    mkdirSync(cache, { recursive: true });
    const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    try {
        writeFileSync(p, payload, { flag: "wx" });
        return true;
    }
    catch (e) {
        if (e?.code !== "EEXIST")
            throw e;
        let stale = false;
        try {
            const st = statSync(p);
            const age = Date.now() - st.mtimeMs;
            const holder = readJson(p);
            if (holder && typeof holder.pid === "number") {
                stale = !pidAlive(holder.pid);
            }
            else {
                stale = age >= LOCK_STALE_MS;
            }
        }
        catch {
            stale = true;
        }
        if (!stale)
            return false;
        const tmp = `${p}.${process.pid}.${++atomicSeq}.tmp`;
        try {
            writeFileSync(tmp, payload);
            renameSync(tmp, p);
            return true;
        }
        catch {
            try {
                rmSync(tmp, { force: true });
            }
            catch { /* ignore */ }
            return false;
        }
    }
}

export function updateLockPidIn(cache, pid = process.pid) {
    writeJsonAtomic(join(cache, LOCK_FILE), { pid, at: new Date().toISOString() }, true);
}

export function releaseLockIn(cache, expectedPid = process.pid) {
    try {
        const p = join(cache, LOCK_FILE);
        const holder = readJson(p);
        if (!holder || typeof holder.pid !== "number" || holder.pid === expectedPid) {
            rmSync(p);
        }
    }
    catch { /* already gone */ }
}

export function agyTempDir() {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const dir = join(tmpdir(), `plexer-agy-${uid}`);
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch { /* best-effort */ }
    return dir;
}

export function agyLastRepoPath() {
    return join(agyTempDir(), "plexer-agy-last-repo.json");
}

export function readAgyLastRepo() {
    const data = readJson(agyLastRepoPath());
    return typeof data?.repoDir === "string" && existsSync(data.repoDir) ? data.repoDir : null;
}

export function writeAgyLastRepo(repoDir) {
    if (process.env.PLEXER_TEST_STDIN !== undefined)
        return;
    const norm = String(repoDir ?? "").replace(/\\/g, "/");
    if (norm.includes("/plexer-agy-") || norm.includes("/plexer-test-") || norm.includes("/plexer-ws-") || norm.includes("/plexer-repo-"))
        return;
    try {
        writeJsonAtomic(agyLastRepoPath(), { repoDir, updatedAt: Date.now() }, true);
    }
    catch { /* best-effort */ }
}
