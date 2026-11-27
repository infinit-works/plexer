/**
 * The cheap "has the working tree moved?" probe that gates the pre-query rebuild.
 *
 * Every plexer retrieval call runs this, so it has to be ~free on the common
 * unchanged path: a walk + one `stat` per source file, no reads, no parsing.
 * Measured at ~3ms for 280 files. Only files whose `(size, mtimeMs)` disagree
 * with the last build's record get read and hashed, which is what keeps a `touch`
 * or a `git checkout` of identical bytes from triggering a pointless rebuild.
 *
 * Git supplies the visible file set (`tracked + untracked - ignored`) when
 * available, but drift is still measured against bytes in the working tree:
 * an uncommitted, staged, or committed edit to an indexed file looks the same.
 *
 * `<outDir>/.cache/fingerprint.json` is a projection of the extraction cache
 * (`extract-cache.js`) minus the parse results, written by the same build. Keeping
 * it separate means the probe reads ~10KB instead of the multi-MB parse cache. The
 * two can only ever disagree by one sidecar going missing, and both directions
 * degrade safely: no fingerprint → "unknown, rebuild"; no parse cache → the
 * rebuild is just cold.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { collectMarkdownDocFiles } from "../ask/index-file.js";
import { loadFileCached, registerGraphCacheClearer, statOf } from "../context/graph-store.js";
import { CACHE_DIR, envTruthy } from "../context/node-file.js";
import { openSqliteStore, prepareStmt } from "../storage/sqlite-store.js";
import { dirVisitMode, shouldSkipDir, walkDir } from "../util/fs.js";
import { discoverManifestMounts } from "./manifest-mounts.js";
import { contentHash } from "../util/id.js";
import { parseJsonc } from "../util/jsonc.js";
import { pathUnderPrefix, relPosix, toPosixPath } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { acquireLockIn, buildConfigPath, readJson, readWalkConfig, releaseLockIn, resolveGitExcludePath, writeJsonAtomic } from "../util/state.js";
import { extractorStamp, pruneSidecars } from "./extractor-stamp.js";
import { containerLangOf, genericLangOf, languageOf } from "./languages.js";
import { listSourceStats } from "./source-files.js";
export const FINGERPRINT_PREFIX = "fingerprint";
const FINGERPRINT_VERSION = 1;
const fingerprintCache = new Map();
registerGraphCacheClearer(() => fingerprintCache.clear());
/** The identity this plexer's prints are filed under. Unlike the extract memo, a
 * missing extractor identity is *not* disqualifying here: freshness is a claim about
 * source bytes, and a build with no memo is merely cold, never wrong. So stamp what
 * we can and fall back to a shared bucket. */
function stamp() {
    return extractorStamp() ?? "nostamp";
}
/** `<outDir>/.cache/fingerprint.<stamp>.json` — keyed by extractor identity for the
 * same reason the memo is (see {@link extractCachePath}): two plexer instances on one repo,
 * typically an `npx` MCP server and a locally installed hook binary, must not keep
 * invalidating each other's prints and forcing a cold rebuild on every call. */
function fingerprintPath(outDir) {
    return join(outDir, CACHE_DIR, `${FINGERPRINT_PREFIX}.${stamp()}.json`);
}
export function readFingerprint(outDir) {
    const fpPath = fingerprintPath(outDir);
    const f = loadFileCached(fingerprintCache, fpPath, () => readJson(fpPath));
    if (!f || f.version !== FINGERPRINT_VERSION || typeof f.files !== "object" || !f.files)
        return null;
    if (f.extractor !== stamp())
        return null; // different extractor — re-extract, don't trust these prints
    return f;
}
const ROOT_DOT_RESOLVER_CONFIGS = [
    ".luaurc",
    ".jsconfig",
    ".gitignore",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "jsconfig.json",
    "package.json",
    "pnpm-workspace.yaml",
    "go.mod",
    "go.work",
    "pyproject.toml",
    "setup.py",
    "Cargo.toml",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Package.swift",
    "pubspec.yaml",
    "foundry.toml",
    "remappings.txt",
    "build.zig",
    "wally.toml",
    "pesde.toml",
    "default.project.json",
];

const SCOPE_MARKER_FILENAMES = new Set([
    "package.json",
    "pnpm-workspace.yaml",
    "go.mod",
    "go.work",
    "pyproject.toml",
    "setup.py",
    "Cargo.toml",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Package.swift",
    "pubspec.yaml",
    "foundry.toml",
    "remappings.txt",
    "build.zig",
]);

export function isResolverConfigFilename(b) {
    return (
        b === ".luaurc" ||
        b === ".jsconfig" ||
        b === ".gitignore" ||
        b.endsWith(".project.json") ||
        /^(?:ts|js)config(?:\..+)?\.json$/i.test(b) ||
        SCOPE_MARKER_FILENAMES.has(b) ||
        b === "wally.toml" ||
        b === "pesde.toml"
    );
}

function resolveExtendedTsConfigTarget(configFile, extRaw) {
    if (typeof extRaw !== "string" || (!extRaw.startsWith(".") && !extRaw.startsWith("/")))
        return null;
    const candidate = resolve(dirname(configFile), extRaw);
    try {
        if (existsSync(candidate) && statSync(candidate).isFile())
            return candidate;
    }
    catch {
        /* ignore */
    }
    if (existsSync(`${candidate}.json`))
        return `${candidate}.json`;
    const nested = join(candidate, "tsconfig.json");
    return existsSync(nested) ? nested : null;
}

function collectTsConfigExtendsTargets(absSet) {
    const queue = [...absSet].filter((p) => {
        const b = basename(p);
        return b === ".jsconfig" || /^(?:ts|js)config(?:\..+)?\.json$/i.test(b);
    });
    const visited = new Set();
    while (queue.length > 0) {
        const cfgPath = queue.pop();
        const abs = resolve(cfgPath);
        if (visited.has(abs))
            continue;
        visited.add(abs);
        let parsed;
        try {
            parsed = parseJsonc(readFileSync(abs, "utf8"));
        }
        catch {
            continue;
        }
        if (!parsed || typeof parsed !== "object")
            continue;
        const exts = typeof parsed.extends === "string"
            ? [parsed.extends]
            : Array.isArray(parsed.extends)
                ? parsed.extends.filter((x) => typeof x === "string")
                : [];
        for (const extRaw of exts) {
            const target = resolveExtendedTsConfigTarget(abs, extRaw);
            if (!target)
                continue;
            const absTarget = resolve(target);
            if (!absSet.has(absTarget)) {
                absSet.add(absTarget);
                queue.push(absTarget);
            }
        }
    }
}

/** Collect absolute paths to all resolver configs (including root/scope dotfiles & manifests). */
export function collectResolverConfigPaths(root, walkedFiles = [], scopes = [], outDir = null) {
    const absRoot = resolve(root);
    const absSet = new Set();
    for (const name of ROOT_DOT_RESOLVER_CONFIGS) {
        const p = join(absRoot, name);
        if (existsSync(p))
            absSet.add(resolve(p));
    }
    const excludePath = resolveGitExcludePath(absRoot);
    if (excludePath && existsSync(excludePath)) {
        absSet.add(resolve(excludePath));
    }
    const buildCfgCandidates = [join(absRoot, "plexer", CACHE_DIR, "config.json")];
    if (outDir) {
        buildCfgCandidates.push(buildConfigPath(absRoot, outDir));
    }
    for (const cfgP of buildCfgCandidates) {
        if (existsSync(cfgP))
            absSet.add(resolve(cfgP));
    }
    for (const s of scopes) {
        if (!s?.prefix)
            continue;
        for (const name of [".luaurc", ".jsconfig"]) {
            const p = join(absRoot, s.prefix, name);
            if (existsSync(p))
                absSet.add(resolve(p));
        }
    }
    const manifestMounts = discoverManifestMounts(absRoot);
    for (const mf of manifestMounts.manifestFiles) {
        if (existsSync(mf))
            absSet.add(resolve(mf));
    }
    const checkedLuauDirs = new Set();
    for (const f of walkedFiles) {
        if (isResolverConfigFilename(basename(f))) {
            absSet.add(resolve(f));
        }
        if (f.endsWith(".luau") || (manifestMounts.hasRojoProject && f.endsWith(".lua"))) {
            let dir = dirname(resolve(f));
            while (dir && dir.length >= absRoot.length && !checkedLuauDirs.has(dir)) {
                checkedLuauDirs.add(dir);
                const luaurc = join(dir, ".luaurc");
                if (existsSync(luaurc))
                    absSet.add(resolve(luaurc));
                if (dir === absRoot)
                    break;
                const parent = dirname(dir);
                if (parent === dir)
                    break;
                dir = parent;
            }
        }
    }
    collectTsConfigExtendsTargets(absSet);
    return [...absSet].sort();
}

/**
 * Resolve `<gitdir>/index` for both normal checkouts (`.git/` directory) and
 * linked worktrees (`.git` file with `gitdir: ...`), without spawning `git`.
 */
export function resolveGitIndexPath(absRoot) {
    const dotGit = join(absRoot, ".git");
    try {
        const st = lstatSync(dotGit);
        if (st.isDirectory()) {
            const idx = join(dotGit, "index");
            return existsSync(idx) ? idx : null;
        }
        if (st.isFile()) {
            const line = readFileSync(dotGit, "utf8").split(/\r?\n/).find((l) => l.startsWith("gitdir:"));
            if (!line)
                return null;
            const target = line.slice("gitdir:".length).trim();
            if (!target)
                return null;
            const gitdir = isAbsolute(target) ? target : resolve(absRoot, target);
            const idx = join(gitdir, "index");
            return existsSync(idx) ? idx : null;
        }
    }
    catch {
        /* absent or unreadable .git */
    }
    return null;
}

function globToRegexSrc(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    out += "(?:.*/)?";
                    i += 2;
                }
                else {
                    out += ".*";
                    i += 1;
                }
            }
            else {
                out += "[^/]*";
            }
        }
        else if (ch === "?") {
            out += "[^/]";
        }
        else if ("\\^$.|+()[]{}".includes(ch)) {
            out += `\\${ch}`;
        }
        else {
            out += ch;
        }
    }
    return out;
}

function parseGitignoreText(text, baseRel) {
    const rules = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/(?<!\\)[ \t]+$/, "");
        if (!line)
            continue;
        if (line.startsWith("#"))
            continue;
        let body = line;
        let negated = false;
        if (body.startsWith("!")) {
            negated = true;
            body = body.slice(1);
        }
        else if (body.startsWith("\\#") || body.startsWith("\\!")) {
            body = body.slice(1);
        }
        body = body.replace(/^\\ /, " ").trim();
        if (!body)
            continue;
        if (body.endsWith("/")) {
            body = body.slice(0, -1);
            if (!body)
                continue;
        }
        const anchored = body.startsWith("/");
        if (anchored)
            body = body.slice(1);
        const hasSlash = anchored || body.includes("/");
        if (!body)
            continue;
        try {
            const re = new RegExp(`^${globToRegexSrc(body)}$`);
            rules.push({ baseRel, negated, hasSlash, re });
        }
        catch {
            /* skip invalid glob line */
        }
    }
    return rules;
}

function readGitignoreRulesForDir(absDir, baseRel) {
    try {
        const p = join(absDir, ".gitignore");
        if (!existsSync(p))
            return [];
        return parseGitignoreText(readFileSync(p, "utf8"), baseRel);
    }
    catch {
        return [];
    }
}

function isDirIgnoredByRules(relPosixPath, name, rules) {
    let ignored = false;
    for (const r of rules) {
        let localRel = relPosixPath;
        if (r.baseRel) {
            const prefix = `${r.baseRel}/`;
            if (!relPosixPath.startsWith(prefix))
                continue;
            localRel = relPosixPath.slice(prefix.length);
        }
        const matched = r.hasSlash ? r.re.test(localRel) : r.re.test(name);
        if (matched)
            ignored = !r.negated;
    }
    return ignored;
}

export function collectWalkedDirs(rootDir, outDir) {
    const absRoot = resolve(rootDir);
    const absOut = outDir ? resolve(outDir) : null;
    const includeDirs = readWalkConfig(absRoot, outDir).includeDirs;
    const dirSet = new Set(["."]);

    const rootRules = [];
    const excludePath = resolveGitExcludePath(absRoot);
    if (excludePath) {
        try {
            rootRules.push(...parseGitignoreText(readFileSync(excludePath, "utf8"), ""));
        }
        catch {
            /* ignore unreadable exclude */
        }
    }

    const walk = (absDir, relDir, inheritedRules, parentMode = "include") => {
        const localRules = readGitignoreRulesForDir(absDir, relDir);
        const rules = localRules.length > 0 ? [...inheritedRules, ...localRules] : inheritedRules;
        let items;
        try {
            items = readdirSync(absDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const item of items) {
            if (!item.isDirectory())
                continue;
            const full = join(absDir, item.name);
            if (absOut && full === absOut)
                continue;
            const rel = relPosix(absRoot, full);
            if (!rel || rel === "." || rel.startsWith(".."))
                continue;
            const relPosixStr = toPosixPath(rel);
            const mode = dirVisitMode(relPosixStr, item.name, includeDirs, parentMode);
            if (mode === "skip")
                continue;
            if (rules.length > 0 && isDirIgnoredByRules(relPosixStr, item.name, rules))
                continue;
            dirSet.add(rel);
            walk(full, relPosixStr, rules, mode);
        }
    };
    walk(absRoot, "", rootRules, "include");
    return dirSet;
}
export function snapshotDirMtimes(rootDir, outDir) {
    const absRoot = resolve(rootDir);
    const dirs = {};
    for (const relDir of collectWalkedDirs(absRoot, outDir)) {
        try {
            dirs[relDir] = statSync(relDir === "." ? absRoot : join(absRoot, relDir)).mtimeMs;
        }
        catch {
            /* ignore unreadable dir */
        }
    }
    const gitIdx = resolveGitIndexPath(absRoot);
    if (gitIdx) {
        try {
            dirs[".git/index"] = statSync(gitIdx).mtimeMs;
        }
        catch {
            /* ignore */
        }
    }
    return dirs;
}

function collectResolverConfigSnapshots(absRoot, configPaths, preReadMap = null) {
    const configs = {};
    const excludeRaw = resolveGitExcludePath(absRoot);
    const excludeAbs = excludeRaw ? resolve(excludeRaw) : null;
    for (const absPath of configPaths) {
        const resolvedAbs = resolve(absPath);
        const rel = excludeAbs && resolvedAbs === excludeAbs ? ".git/info/exclude" : relPosix(absRoot, resolvedAbs);
        if (!rel || (rel !== ".git/info/exclude" && rel.startsWith("..")))
            continue;
        try {
            const st = statSync(resolvedAbs);
            if (!st.isFile())
                continue;
            const raw = preReadMap?.get(resolvedAbs) ?? readFileSync(resolvedAbs, "utf8");
            configs[rel] = [st.size, st.mtimeMs, contentHash(raw)];
        }
        catch {
            /* ignore absent/unreadable config */
        }
    }
    return configs;
}

function findResolverConfigsInDirs(absRoot, walkedDirs, outDir = null) {
    const absPaths = new Set(collectResolverConfigPaths(absRoot, [], [], outDir));
    for (const relDir of walkedDirs) {
        if (relDir === ".git/index")
            continue;
        const absDir = relDir === "." ? absRoot : join(absRoot, relDir);
        let items;
        try {
            items = readdirSync(absDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const item of items) {
            if (!item.isFile())
                continue;
            if (isResolverConfigFilename(item.name)) {
                absPaths.add(resolve(absDir, item.name));
            }
        }
    }
    collectTsConfigExtendsTargets(absPaths);
    return [...absPaths].sort();
}

function loadEntriesFromSqlite(outDir) {
    const store = openSqliteStore(outDir, { create: false, readOnly: true });
    if (!store)
        return {};
    const out = {};
    try {
        const rows = prepareStmt(store, "SELECT path, size, mtime_ms, content_hash FROM files").all();
        for (const r of rows) {
            out[r.path] = {
                size: Number(r.size),
                mtimeMs: Number(r.mtime_ms),
                hash: String(r.content_hash),
            };
        }
    }
    catch {
        return {};
    }
    return out;
}

/** Project the extraction cache's entries into the probe sidecar. Best-effort:
 * the graph is already on disk when this runs, so a failed write costs the next
 * probe its fast path and nothing more. */
function collectFingerprintDirMtimes(dirSet, rootDir, outDir, preWalkDirMtimes) {
    if (!preWalkDirMtimes && !rootDir) return {};
    if (preWalkDirMtimes && typeof preWalkDirMtimes === "object") {
        const dirs = { ...preWalkDirMtimes };
        if (rootDir) {
            const absRoot = resolve(rootDir);
            for (const relDir of dirSet) {
                if (relDir in dirs) continue;
                try { dirs[relDir] = statSync(relDir === "." ? absRoot : join(absRoot, relDir)).mtimeMs; } catch {}
            }
        }
        return dirs;
    }
    const dirs = {};
    const absRoot = resolve(rootDir);
    for (const relDir of collectWalkedDirs(absRoot, outDir)) dirSet.add(relDir);
    for (const relDir of dirSet) {
        try { dirs[relDir] = statSync(relDir === "." ? absRoot : join(absRoot, relDir)).mtimeMs; } catch {}
    }
    const gitIdx = resolveGitIndexPath(absRoot);
    if (gitIdx) {
        try { dirs[".git/index"] = statSync(gitIdx).mtimeMs; } catch {}
    }
    return dirs;
}

export function writeFingerprint(outDir, entries, onlyDirs, rootDir, extensions, preWalkDirMtimes, configOpts) {
    const sourceEntries = entries && typeof entries === "object" ? entries : loadEntriesFromSqlite(outDir);
    const files = {};
    const dirSet = new Set(["."]);
    for (const [rel, e] of Object.entries(sourceEntries)) {
        files[rel] = Array.isArray(e) ? e : [e.size, e.mtimeMs, e.hash];
        let d = dirname(rel);
        while (d && d !== "." && !dirSet.has(d)) {
            dirSet.add(d);
            d = dirname(d);
        }
    }
    const dirs = collectFingerprintDirMtimes(dirSet, rootDir, outDir, preWalkDirMtimes);
    let configs = {};
    let docs;
    let gitIndexPath = null;
    if (rootDir) {
        const absRoot = resolve(rootDir);
        gitIndexPath = resolveGitIndexPath(absRoot);
        if (configOpts?.configSnapshots && typeof configOpts.configSnapshots === "object") {
            configs = configOpts.configSnapshots;
        }
        else {
            const cfgPaths = Array.isArray(configOpts?.configFiles)
                ? configOpts.configFiles
                : findResolverConfigsInDirs(absRoot, Object.keys(dirs).length ? Object.keys(dirs) : dirSet, outDir);
            configs = collectResolverConfigSnapshots(absRoot, cfgPaths, configOpts?.configContents);
        }
        if (configOpts?.docSnapshots && typeof configOpts.docSnapshots === "object") {
            docs = configOpts.docSnapshots;
        }
        else {
            docs = collectResolverConfigSnapshots(absRoot, collectMarkdownDocFiles(absRoot).map((d) => d.absPath));
        }
    }
    try {
        const record = { version: FINGERPRINT_VERSION, extractor: stamp(), files };
        if (Object.keys(dirs).length > 0) record.dirs = dirs;
        if (gitIndexPath) record.gitIndexPath = gitIndexPath;
        if (onlyDirs?.length > 0) record.onlyDirs = onlyDirs;
        if (extensions?.length > 0) record.extensions = extensions;
        if (Object.keys(configs).length > 0) record.configs = configs;
        if (docs !== undefined) record.docs = docs;
        if (configOpts?.configHash) record.configHash = configOpts.configHash;
        writeJsonAtomic(fingerprintPath(outDir), record, true);
        pruneSidecars(join(outDir, CACHE_DIR), FINGERPRINT_PREFIX);
        return true;
    } catch {
        return false;
    }
}
/** `PLEXER_REFRESH=hash` — never trust a stat, confirm every file by its bytes. */
function alwaysHash() {
    return process.env.PLEXER_REFRESH === "hash";
}
/**
 * May a recorded `(size, mtimeMs, hash)` be trusted for the file `f` as it is on
 * disk now, without reading it?
 *
 * **The probe's rule only.** `buildGraph` deliberately does not use this: it reads
 * and hashes every file, every time. A stat may decide whether a query bothers
 * rebuilding; it may not decide what the rebuild itself looks at — otherwise
 * `plexer check` (which always re-hashes) can report drift that the `plexer build` it
 * recommends then refuses to repair. `PLEXER_REFRESH=hash` is the escape hatch for
 * the probe's blind spot: a same-length edit inside one mtime tick.
 *
 * An empty `hash` means the last build never got the bytes — always re-read.
 * A *parse* failure keeps its real hash, so it stays on the fast path: re-reading
 * bytes that failed to parse yesterday just fails to parse again.
 */
function statUnchanged(rec, f) {
    if (alwaysHash())
        return false;
    if (!rec.hash)
        return false;
    return rec.size === f.size && rec.mtimeMs === f.mtimeMs;
}
export function isClean(d) {
    return d.changed.length === 0 && d.added.length === 0 && d.removed.length === 0;
}
export function driftCount(d) {
    return d.changed.length + d.added.length + d.removed.length;
}
/**
 * Diff the working tree against the last build's fingerprint. Returns null when
 * there is no fingerprint to compare against (never built, or built by a version
 * that didn't write one) — callers should treat that as "unknown", not "clean".
 *
 * `PLEXER_REFRESH=hash` skips the stat fast path and hashes every file, for the
 * rare tooling that rewrites content while preserving size and mtime.
 */
function checkConfigSnapshots(absRoot, fpConfigs, drift, seenDrift, healedSnapshots = null) {
    if (!fpConfigs || typeof fpConfigs !== "object")
        return true;
    let allClean = true;
    for (const [rel, print] of Object.entries(fpConfigs)) {
        const [size, mtimeMs, hash] = print;
        const abs = rel === ".git/info/exclude" ? (resolveGitExcludePath(absRoot) ?? join(absRoot, rel)) : join(absRoot, rel);
        try {
            const st = statSync(abs);
            if (!alwaysHash() && st.size === size && st.mtimeMs === mtimeMs)
                continue;
            const now = contentHash(readFileSync(abs, "utf8"));
            if (now === hash) {
                if (healedSnapshots)
                    healedSnapshots[rel] = [st.size, st.mtimeMs, hash];
                continue;
            }
            allClean = false;
            if (drift && !seenDrift.has(`c:${rel}`)) {
                seenDrift.add(`c:${rel}`);
                drift.changed.push(rel);
            }
        }
        catch {
            allClean = false;
            if (drift && !seenDrift.has(`r:${rel}`)) {
                seenDrift.add(`r:${rel}`);
                drift.removed.push(rel);
            }
        }
    }
    return allClean;
}

function probeFastDirsClean(absRoot, dirs, cachedGitIndexPath = null) {
    for (const [relDir, expectedMtime] of Object.entries(dirs)) {
        try {
            const target = relDir === "."
                ? absRoot
                : relDir === ".git/index"
                    ? (cachedGitIndexPath ?? resolveGitIndexPath(absRoot))
                    : join(absRoot, relDir);
            if (!target || statSync(target).mtimeMs !== expectedMtime) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function probeFastFilesClean(absRoot, files) {
    for (const [rel, [size, mtimeMs, hash]] of Object.entries(files)) {
        if (!hash) return false;
        try {
            const st = statSync(join(absRoot, rel));
            if (st.size !== size || st.mtimeMs !== mtimeMs) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function recordEntryDrift(f, fp, drift, seenDrift, healedFiles = null) {
    const print = fp.files[f.rel];
    if (!print) {
        seenDrift.add(`a:${f.rel}`);
        drift.added.push(f.rel);
        return;
    }
    const [size, mtimeMs, hash] = print;
    if (statUnchanged({ size, mtimeMs, hash }, f)) return;
    // Confirm suspected changes by bytes so touch/checkout restores stay free.
    let now;
    try {
        const source = readSourceFile(f.abs);
        if (source === null) {
            if (hash) {
                seenDrift.add(`c:${f.rel}`);
                drift.changed.push(f.rel);
            }
            return;
        }
        now = contentHash(source);
    } catch {
        return;
    }
    if (now !== hash) {
        seenDrift.add(`c:${f.rel}`);
        drift.changed.push(f.rel);
    } else if (healedFiles) {
        healedFiles[f.rel] = [f.size, f.mtimeMs, hash];
    }
}

function appendUntrackedConfigAndDocDrift(absRoot, outDir, fp, drift, seen, seenDrift, healedConfigs = null, healedDocs = null, walked = null) {
    if (fp.configs && typeof fp.configs === "object") {
        checkConfigSnapshots(absRoot, fp.configs, drift, seenDrift, healedConfigs);
        const cfgPaths = Array.isArray(walked)
            ? collectResolverConfigPaths(absRoot, walked, [], outDir)
            : findResolverConfigsInDirs(absRoot, collectWalkedDirs(absRoot, outDir), outDir);
        const excludeRaw = resolveGitExcludePath(absRoot);
        const excludeAbs = excludeRaw ? resolve(excludeRaw) : null;
        for (const absCfg of cfgPaths) {
            const resolvedAbs = resolve(absCfg);
            const relCfg = excludeAbs && resolvedAbs === excludeAbs ? ".git/info/exclude" : relPosix(absRoot, resolvedAbs);
            if (!relCfg || (relCfg !== ".git/info/exclude" && relCfg.startsWith("..")) || relCfg in fp.configs) continue;
            if (!seen.has(relCfg) && !seenDrift.has(`a:${relCfg}`)) {
                seenDrift.add(`a:${relCfg}`);
                drift.added.push(relCfg);
            }
        }
    }
    if (fp.docs && typeof fp.docs === "object") {
        checkConfigSnapshots(absRoot, fp.docs, drift, seenDrift, healedDocs);
        for (const { relPath } of collectMarkdownDocFiles(absRoot)) {
            if (relPath in fp.docs) continue;
            if (!seen.has(relPath) && !seenDrift.has(`a:${relPath}`)) {
                seenDrift.add(`a:${relPath}`);
                drift.added.push(relPath);
            }
        }
    }
}

function isIndexedSourceName(fileName, extSet) {
    if (extSet && !extSet.has(extname(fileName).toLowerCase()))
        return false;
    return languageOf(fileName) !== null || genericLangOf(fileName) !== null || containerLangOf(fileName) !== null;
}

const FAST_POSIX_SEP = process.platform === "win32" ? null : "/";

function tryFastDeltaProbe(absRoot, outDir, fp, canHeal) {
    if (alwaysHash() || !fp.dirs || typeof fp.dirs !== "object" || !fp.files || envTruthy("PLEXER_NO_DELTA_PROBE"))
        return null;
    const onlyDirs = fp.onlyDirs && fp.onlyDirs.length > 0 ? fp.onlyDirs : null;
    const rawExts = Array.isArray(fp.extensions) && fp.extensions.length > 0 ? fp.extensions : null;
    const extSet = rawExts
        ? new Set(rawExts.map((e) => {
            const t = String(e).trim().toLowerCase();
            return t.startsWith(".") ? t : `.${t}`;
        }))
        : null;

    const changedDirs = [];
    let gitIndexChanged = false;
    const nextDirs = { ...fp.dirs };

    for (const [relDir, expectedMtime] of Object.entries(fp.dirs)) {
        try {
            if (relDir === ".git/index") {
                const target = fp.gitIndexPath ?? resolveGitIndexPath(absRoot);
                if (!target) {
                    gitIndexChanged = true;
                    break;
                }
                const st = statSync(target);
                if (st.mtimeMs !== expectedMtime) {
                    gitIndexChanged = true;
                    break;
                }
                continue;
            }
            const target = relDir === "." ? absRoot : join(absRoot, relDir);
            const st = statSync(target);
            if (!st.isDirectory())
                return null;
            if (st.mtimeMs !== expectedMtime) {
                changedDirs.push({ relDir, absDir: target, mtimeMs: st.mtimeMs });
                nextDirs[relDir] = st.mtimeMs;
                if (changedDirs.length > 16)
                    return null;
            }
        }
        catch {
            return null;
        }
    }
    if (gitIndexChanged)
        return null;

    const absOut = resolve(outDir);
    const changedDirNames = new Set();
    const scannedByDir = new Map();
    let docsDirTouched = false;

    for (const cd of changedDirs) {
        changedDirNames.add(cd.relDir);
        if (cd.relDir === "." || cd.relDir === "docs" || cd.relDir.startsWith("docs/"))
            docsDirTouched = true;
        let entries;
        try {
            entries = readdirSync(cd.absDir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        const filesInDir = new Map();
        for (const item of entries) {
            if (item.isDirectory()) {
                const subRel = cd.relDir === "." ? item.name : `${cd.relDir}/${item.name}`;
                if (!(subRel in fp.dirs)) {
                    if (join(cd.absDir, item.name) === absOut)
                        continue;
                    if (shouldSkipDir(item.name))
                        continue;
                    return null;
                }
                continue;
            }
            if (!item.isFile())
                continue;
            if (item.name === ".gitignore" || isResolverConfigFilename(item.name))
                return null;
            if (!isIndexedSourceName(item.name, extSet))
                continue;
            const relPath = cd.relDir === "." ? item.name : `${cd.relDir}/${item.name}`;
            if (onlyDirs && !onlyDirs.some((d) => pathUnderPrefix(relPath, d)))
                continue;
            filesInDir.set(relPath, join(cd.absDir, item.name));
        }
        scannedByDir.set(cd.relDir, filesInDir);
    }

    const drift = { changed: [], added: [], removed: [] };
    const rootPrefix = FAST_POSIX_SEP ? (absRoot.endsWith(FAST_POSIX_SEP) ? absRoot : `${absRoot}${FAST_POSIX_SEP}`) : null;
    const hasChangedDirs = changedDirNames.size > 0;
    const fpEntries = Object.entries(fp.files);

    // Zero-allocation clean scan until the first modified/removed/added entry appears.
    if (!hasChangedDirs) {
        let firstDirtyIdx = -1;
        for (let i = 0; i < fpEntries.length; i++) {
            const [rel, print] = fpEntries[i];
            const [size, mtimeMs, hash] = print;
            if (!hash) {
                firstDirtyIdx = i;
                break;
            }
            const abs = rootPrefix ? `${rootPrefix}${rel}` : join(absRoot, rel);
            try {
                const st = statSync(abs);
                if (st.size !== size || st.mtimeMs !== mtimeMs) {
                    firstDirtyIdx = i;
                    break;
                }
            }
            catch {
                firstDirtyIdx = i;
                break;
            }
        }
        if (firstDirtyIdx === -1) {
            const cfgClean = !fp.configs || typeof fp.configs !== "object" || checkConfigSnapshots(absRoot, fp.configs, null, null);
            const docsClean = !fp.docs || typeof fp.docs !== "object" || checkConfigSnapshots(absRoot, fp.docs, null, null);
            if (cfgClean && docsClean) {
                return { clean: true, drift };
            }
            firstDirtyIdx = fpEntries.length;
        }
        // Replay clean prefix [0 .. firstDirtyIdx) without re-stating any file.
        const healedFiles = canHeal ? {} : null;
        const healedConfigs = canHeal && fp.configs && typeof fp.configs === "object" ? {} : null;
        const healedDocs = canHeal && fp.docs && typeof fp.docs === "object" ? {} : null;
        const sourceStats = new Array(firstDirtyIdx);
        const walkedSet = new Set();
        const seen = new Set();
        const seenDrift = new Set();
        for (let i = 0; i < firstDirtyIdx; i++) {
            const [rel, print] = fpEntries[i];
            const abs = rootPrefix ? `${rootPrefix}${rel}` : join(absRoot, rel);
            seen.add(rel);
            walkedSet.add(abs);
            sourceStats[i] = { abs, rel, size: print[0], mtimeMs: print[1] };
        }
        for (let i = firstDirtyIdx; i < fpEntries.length; i++) {
            const [rel, print] = fpEntries[i];
            const [size, mtimeMs, hash] = print;
            const abs = rootPrefix ? `${rootPrefix}${rel}` : join(absRoot, rel);
            let st;
            try {
                st = statSync(abs);
            }
            catch {
                seenDrift.add(`r:${rel}`);
                drift.removed.push(rel);
                continue;
            }
            seen.add(rel);
            walkedSet.add(abs);
            sourceStats.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
            if (hash && st.size === size && st.mtimeMs === mtimeMs)
                continue;
            const source = readSourceFile(abs);
            if (source === null) {
                if (hash) {
                    seenDrift.add(`c:${rel}`);
                    drift.changed.push(rel);
                }
                continue;
            }
            const now = contentHash(source);
            if (now !== hash) {
                seenDrift.add(`c:${rel}`);
                drift.changed.push(rel);
            }
            else if (healedFiles) {
                healedFiles[rel] = [st.size, st.mtimeMs, hash];
            }
        }
        let configsUnchanged = true;
        if (fp.configs && typeof fp.configs === "object") {
            configsUnchanged = checkConfigSnapshots(absRoot, fp.configs, drift, seenDrift, healedConfigs);
            for (const relCfg of Object.keys(fp.configs)) {
                if (relCfg !== ".git/info/exclude" && !relCfg.startsWith(".."))
                    walkedSet.add(join(absRoot, relCfg));
            }
        }
        let docsUnchanged = true;
        if (fp.docs && typeof fp.docs === "object") {
            docsUnchanged = checkConfigSnapshots(absRoot, fp.docs, drift, seenDrift, healedDocs);
        }
        drift.changed.sort();
        const walked = [...walkedSet];
        Object.defineProperties(drift, {
            _walked: { value: walked, enumerable: false, configurable: true },
            _dirMtimes: { value: nextDirs, enumerable: false, configurable: true },
            _sourceStats: { value: sourceStats, enumerable: false, configurable: true },
            _configsUnchanged: { value: configsUnchanged, enumerable: false, configurable: true },
            _docsUnchanged: { value: docsUnchanged, enumerable: false, configurable: true },
            _noFileAddRemove: { value: drift.removed.length === 0, enumerable: false, configurable: true },
        });
        return { drift, dirMtimes: nextDirs, healedFiles, healedConfigs, healedDocs };
    }

    const seen = new Set();
    const seenDrift = new Set();
    const healedFiles = canHeal ? {} : null;
    const healedConfigs = canHeal && fp.configs && typeof fp.configs === "object" ? {} : null;
    const healedDocs = canHeal && fp.docs && typeof fp.docs === "object" ? {} : null;
    const sourceStats = [];
    const walkedSet = new Set();

    for (let i = 0; i < fpEntries.length; i++) {
        const [rel, print] = fpEntries[i];
        const [size, mtimeMs, hash] = print;
        const slash = rel.lastIndexOf("/");
        const parentRel = slash < 0 ? "." : rel.slice(0, slash);
        if (changedDirNames.has(parentRel) && !scannedByDir.get(parentRel)?.has(rel)) {
            seenDrift.add(`r:${rel}`);
            drift.removed.push(rel);
            continue;
        }
        const abs = rootPrefix ? `${rootPrefix}${rel}` : join(absRoot, rel);
        let st;
        try {
            st = statSync(abs);
        }
        catch {
            seenDrift.add(`r:${rel}`);
            drift.removed.push(rel);
            continue;
        }
        seen.add(rel);
        walkedSet.add(abs);
        sourceStats.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs });
        if (hash && st.size === size && st.mtimeMs === mtimeMs)
            continue;
        const source = readSourceFile(abs);
        if (source === null) {
            if (hash) {
                seenDrift.add(`c:${rel}`);
                drift.changed.push(rel);
            }
            continue;
        }
        const now = contentHash(source);
        if (now !== hash) {
            seenDrift.add(`c:${rel}`);
            drift.changed.push(rel);
        }
        else if (healedFiles) {
            healedFiles[rel] = [st.size, st.mtimeMs, hash];
        }
    }

    for (const filesInDir of scannedByDir.values()) {
        for (const [relPath, absPath] of filesInDir) {
            if (seen.has(relPath))
                continue;
            try {
                const st = statSync(absPath);
                seen.add(relPath);
                walkedSet.add(absPath);
                sourceStats.push({ abs: absPath, rel: relPath, size: st.size, mtimeMs: st.mtimeMs });
                seenDrift.add(`a:${relPath}`);
                drift.added.push(relPath);
            }
            catch {
                /* ignore vanished file */
            }
        }
    }

    let configsUnchanged = true;
    if (fp.configs && typeof fp.configs === "object") {
        configsUnchanged = checkConfigSnapshots(absRoot, fp.configs, drift, seenDrift, healedConfigs);
        for (const relCfg of Object.keys(fp.configs)) {
            if (relCfg !== ".git/info/exclude" && !relCfg.startsWith(".."))
                walkedSet.add(join(absRoot, relCfg));
        }
    }
    let docsUnchanged = true;
    if (fp.docs && typeof fp.docs === "object") {
        docsUnchanged = checkConfigSnapshots(absRoot, fp.docs, drift, seenDrift, healedDocs);
        if (docsDirTouched) {
            for (const { relPath } of collectMarkdownDocFiles(absRoot)) {
                if (!(relPath in fp.docs) && !seen.has(relPath) && !seenDrift.has(`a:${relPath}`)) {
                    docsUnchanged = false;
                    seenDrift.add(`a:${relPath}`);
                    drift.added.push(relPath);
                }
            }
        }
    }

    drift.changed.sort();
    drift.added.sort();
    drift.removed.sort();
    const walked = [...walkedSet];
    Object.defineProperties(drift, {
        _walked: { value: walked, enumerable: false, configurable: true },
        _dirMtimes: { value: nextDirs, enumerable: false, configurable: true },
        _sourceStats: { value: sourceStats, enumerable: false, configurable: true },
        _configsUnchanged: { value: configsUnchanged, enumerable: false, configurable: true },
        _docsUnchanged: { value: docsUnchanged, enumerable: false, configurable: true },
        _noFileAddRemove: { value: drift.added.length === 0 && drift.removed.length === 0, enumerable: false, configurable: true },
    });
    return { drift, dirMtimes: nextDirs, healedFiles, healedConfigs, healedDocs };
}

export function probeDrift(root, outDir) {
    const fp = readFingerprint(outDir);
    if (!fp) return null;
    const absRoot = resolve(root);
    const fpPath = fingerprintPath(outDir);
    const fpStatBefore = statOf(fpPath);
    const canHeal = !alwaysHash() && !envTruthy("PLEXER_NO_REFRESH");
    const deltaAttempt = tryFastDeltaProbe(absRoot, outDir, fp, canHeal);
    if (deltaAttempt?.clean)
        return deltaAttempt.drift;
    let drift;
    let dirMtimes;
    let healedFiles;
    let healedConfigs;
    let healedDocs;

    if (deltaAttempt) {
        drift = deltaAttempt.drift;
        dirMtimes = deltaAttempt.dirMtimes;
        healedFiles = deltaAttempt.healedFiles;
        healedConfigs = deltaAttempt.healedConfigs;
        healedDocs = deltaAttempt.healedDocs;
    }
    else {
        drift = { changed: [], added: [], removed: [] };
        const seen = new Set();
        const seenDrift = new Set();
        healedFiles = canHeal ? {} : null;
        healedConfigs = canHeal && fp.configs && typeof fp.configs === "object" ? {} : null;
        healedDocs = canHeal && fp.docs && typeof fp.docs === "object" ? {} : null;
        const onlyDirs = fp.onlyDirs && fp.onlyDirs.length > 0 ? new Set(fp.onlyDirs) : undefined;
        const extensions = Array.isArray(fp.extensions) && fp.extensions.length > 0 ? fp.extensions : undefined;
        const walkCfg = readWalkConfig(absRoot, outDir);
        const walked = walkDir(absRoot, walkCfg.includeDirs, {
            followSubmodules: walkCfg.followSubmodules,
            followNestedRepos: walkCfg.followNestedRepos,
        });
        dirMtimes = snapshotDirMtimes(absRoot, outDir);
        const sourceStats = listSourceStats(root, outDir, walked, onlyDirs, extensions);
        for (const f of sourceStats) {
            seen.add(f.rel);
            recordEntryDrift(f, fp, drift, seenDrift, healedFiles);
        }
        for (const rel of Object.keys(fp.files)) {
            if (!seen.has(rel)) {
                seenDrift.add(`r:${rel}`);
                drift.removed.push(rel);
            }
        }
        appendUntrackedConfigAndDocDrift(absRoot, outDir, fp, drift, seen, seenDrift, healedConfigs, healedDocs, walked);
        drift.changed.sort();
        drift.added.sort();
        drift.removed.sort();
        Object.defineProperties(drift, {
            _walked: { value: walked, enumerable: false, configurable: true },
            _dirMtimes: { value: dirMtimes, enumerable: false, configurable: true },
            _sourceStats: { value: sourceStats, enumerable: false, configurable: true },
        });
    }
    if (canHeal && isClean(drift)) {
        const lockCache = join(outDir, CACHE_DIR);
        try {
            if (acquireLockIn(lockCache)) {
                try {
                    const fpStatNow = statOf(fpPath);
                    const unchangedFp = Boolean(
                        fpStatBefore &&
                        fpStatNow &&
                        fpStatBefore.dev === fpStatNow.dev &&
                        fpStatBefore.ino === fpStatNow.ino &&
                        fpStatBefore.mtimeMs === fpStatNow.mtimeMs
                    );
                    if (unchangedFp) {
                        const nextFiles = healedFiles && Object.keys(healedFiles).length > 0 ? { ...fp.files, ...healedFiles } : fp.files;
                        const nextConfigs = healedConfigs && Object.keys(healedConfigs).length > 0 ? { ...fp.configs, ...healedConfigs } : fp.configs;
                        const nextDocs = healedDocs && Object.keys(healedDocs).length > 0 ? { ...fp.docs, ...healedDocs } : fp.docs;
                        const healedFp = {
                            ...fp,
                            dirs: dirMtimes,
                            ...(fp.gitIndexPath ? { gitIndexPath: fp.gitIndexPath } : {}),
                            files: nextFiles,
                            ...(nextConfigs ? { configs: nextConfigs } : {}),
                            ...(nextDocs ? { docs: nextDocs } : {}),
                        };
                        writeJsonAtomic(fpPath, healedFp, true);
                        fingerprintCache.delete(fpPath);
                    }
                }
                finally {
                    releaseLockIn(lockCache);
                }
            }
        }
        catch {
            /* best-effort heal when cache dir is read-only */
        }
    }
    return drift;
}
