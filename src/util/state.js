/**
 * The `plexer/.cache/` sidecar state: statusline stats snapshot, per-session state,
 * persisted repository walk settings (`config.json`), and the build lock that serializes rebuilds.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

const LOCK_STALE_MS = 300000;
const LOCK_FILE = ".sync.lock";

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

/**
 * Resolve the context graph directory when no explicit `--dir` CLI option is threaded
 * (e.g. Claude Code hooks, `sync-run`, statusline). `PLEXER_DIR` wins over `<projectDir>/plexer`.
 */
export function resolveContextDir(projectDir, override) {
    const chosen = override || process.env.PLEXER_DIR?.trim();
    if (!chosen)
        return join(projectDir, "plexer");
    return isAbsolute(chosen) ? chosen : join(projectDir, chosen);
}

export function cacheDir(projectDir, override) {
    return join(resolveContextDir(projectDir, override), ".cache");
}

function statsPath(d) {
    return join(cacheDir(d), "stats.json");
}

export function readJson(p) {
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    }
    catch {
        return null;
    }
}

/**
 * Write JSON to `p` via a scratch file and atomic rename so concurrent readers
 * never see a truncated prefix. Cleans up its scratch file on failure.
 */
export function writeJsonAtomic(p, value, compact = false) {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
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
    return readJson(join(resolveContextDir(projectDir), ".graph", "wiring.json"));
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
    return { lastQuery: null, perAgentQuery: {}, injectedPointers: [], nudges: 0 };
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
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}

export function projectDir(input) {
    return process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

/** Append an anchored `/<bareDir>/` entry to `<root>/.gitignore` if not already present. */
export function appendGitignoreEntry(root, bareDir, note) {
    const entry = `/${bareDir}/`;
    const path = join(root, ".gitignore");
    let current = "";
    try {
        current = readFileSync(path, "utf8");
    }
    catch { /* no .gitignore yet */ }
    const present = current.split(/\r?\n/).some((line) => {
        const value = line.trim();
        return value === entry || value === `${bareDir}/` || value === bareDir;
    });
    if (present)
        return;
    const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    try {
        writeFileSync(path, `${current}${gap}# ${note}\n${entry}\n`);
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

export function releaseLock(d) {
    releaseLockIn(cacheDir(d));
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
        let stale;
        try {
            const st = statSync(p);
            const age = Date.now() - st.mtimeMs;
            const holder = readJson(p);
            stale = age >= LOCK_STALE_MS || (holder && typeof holder.pid === "number" && !pidAlive(holder.pid));
        }
        catch {
            stale = true;
        }
        if (!stale)
            return false;
        try {
            rmSync(p);
        }
        catch { /* another process reclaimed it */ }
        try {
            writeFileSync(p, payload, { flag: "wx" });
            return true;
        }
        catch (e2) {
            if (e2?.code === "EEXIST")
                return false;
            throw e2;
        }
    }
}

export function releaseLockIn(cache) {
    try {
        rmSync(join(cache, LOCK_FILE));
    }
    catch { /* already gone */ }
}
