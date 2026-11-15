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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { collectMarkdownDocFiles } from "../ask/index-file.js";
import { CACHE_DIR } from "../context/node-file.js";
import { openSqliteStore, prepareStmt } from "../storage/sqlite-store.js";
import { shouldSkipDir } from "../util/fs.js";
import { contentHash } from "../util/id.js";
import { relPosix, toPosixPath } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { readJson, readWalkConfig, resolveGitExcludePath, writeJsonAtomic } from "../util/state.js";
import { extractorStamp, pruneSidecars } from "./extract-cache.js";
import { listSourceStats } from "./source-files.js";
export const FINGERPRINT_PREFIX = "fingerprint";
const FINGERPRINT_VERSION = 1;
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
    const f = readJson(fingerprintPath(outDir));
    if (!f || f.version !== FINGERPRINT_VERSION || typeof f.files !== "object" || !f.files)
        return null;
    if (f.extractor !== stamp())
        return null; // different extractor — re-extract, don't trust these prints
    return f;
}
const ROOT_DOT_RESOLVER_CONFIGS = [
    ".luaurc",
    ".jsconfig",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "jsconfig.json",
    "package.json",
    "go.mod",
    "Cargo.toml",
    "wally.toml",
    "pesde.toml",
    "default.project.json",
];

export function isResolverConfigFilename(b) {
    return (
        b === ".luaurc" ||
        b === ".jsconfig" ||
        b.endsWith(".project.json") ||
        /^(?:ts|js)config(?:\..+)?\.json$/i.test(b) ||
        b === "package.json" ||
        b === "go.mod" ||
        b === "Cargo.toml" ||
        b === "wally.toml" ||
        b === "pesde.toml"
    );
}

/** Collect absolute paths to all resolver configs (including root/scope dotfiles & manifests). */
export function collectResolverConfigPaths(root, walkedFiles = [], scopes = []) {
    const absSet = new Set();
    for (const name of ROOT_DOT_RESOLVER_CONFIGS) {
        const p = join(root, name);
        if (existsSync(p))
            absSet.add(resolve(p));
    }
    for (const s of scopes) {
        if (!s?.prefix)
            continue;
        for (const name of [".luaurc", ".jsconfig"]) {
            const p = join(root, s.prefix, name);
            if (existsSync(p))
                absSet.add(resolve(p));
        }
    }
    for (const f of walkedFiles) {
        if (isResolverConfigFilename(basename(f))) {
            absSet.add(resolve(f));
        }
    }
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

    const walk = (absDir, relDir, inheritedRules) => {
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
            if (shouldSkipDir(item.name, includeDirs))
                continue;
            const full = join(absDir, item.name);
            if (absOut && full === absOut)
                continue;
            const rel = relPosix(absRoot, full);
            if (!rel || rel === "." || rel.startsWith(".."))
                continue;
            if (rules.length > 0 && isDirIgnoredByRules(toPosixPath(rel), item.name, rules))
                continue;
            dirSet.add(rel);
            walk(full, toPosixPath(rel), rules);
        }
    };
    walk(absRoot, "", rootRules);
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

function collectResolverConfigSnapshots(absRoot, configPaths) {
    const configs = {};
    for (const absPath of configPaths) {
        const rel = relPosix(absRoot, absPath);
        if (!rel || rel.startsWith(".."))
            continue;
        try {
            const st = statSync(absPath);
            if (!st.isFile())
                continue;
            const raw = readFileSync(absPath, "utf8");
            configs[rel] = [st.size, st.mtimeMs, contentHash(raw)];
        }
        catch {
            /* ignore absent/unreadable config */
        }
    }
    return configs;
}

function findResolverConfigsInDirs(absRoot, walkedDirs) {
    const absPaths = new Set(collectResolverConfigPaths(absRoot));
    for (const relDir of walkedDirs) {
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
    return [...absPaths].sort();
}

function loadEntriesFromSqlite(outDir) {
    const store = openSqliteStore(outDir, { create: false });
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
        files[rel] = [e.size, e.mtimeMs, e.hash];
        let d = dirname(rel);
        while (d && d !== "." && !dirSet.has(d)) {
            dirSet.add(d);
            d = dirname(d);
        }
    }
    const dirs = collectFingerprintDirMtimes(dirSet, rootDir, outDir, preWalkDirMtimes);
    let configs = {};
    let docs;
    if (rootDir) {
        const absRoot = resolve(rootDir);
        const cfgPaths = Array.isArray(configOpts?.configFiles)
            ? configOpts.configFiles
            : findResolverConfigsInDirs(absRoot, Object.keys(dirs).length ? Object.keys(dirs) : dirSet);
        configs = collectResolverConfigSnapshots(absRoot, cfgPaths);
        docs = collectResolverConfigSnapshots(absRoot, collectMarkdownDocFiles(absRoot).map((d) => d.absPath));
    }
    try {
        const record = { version: FINGERPRINT_VERSION, extractor: stamp(), files };
        if (Object.keys(dirs).length > 0) record.dirs = dirs;
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
function checkConfigSnapshots(absRoot, fpConfigs, drift, seenDrift) {
    if (!fpConfigs || typeof fpConfigs !== "object")
        return true;
    let allClean = true;
    for (const [rel, print] of Object.entries(fpConfigs)) {
        const [size, mtimeMs, hash] = print;
        const abs = join(absRoot, rel);
        try {
            const st = statSync(abs);
            if (!alwaysHash() && st.size === size && st.mtimeMs === mtimeMs)
                continue;
            const now = contentHash(readFileSync(abs, "utf8"));
            if (now === hash)
                continue;
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

function probeFastDirsClean(absRoot, dirs) {
    for (const [relDir, expectedMtime] of Object.entries(dirs)) {
        try {
            const target = relDir === "." ? absRoot : relDir === ".git/index" ? resolveGitIndexPath(absRoot) : join(absRoot, relDir);
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

function recordEntryDrift(f, fp, drift, seenDrift) {
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
    }
}

function appendUntrackedConfigAndDocDrift(absRoot, outDir, fp, drift, seen, seenDrift) {
    if (fp.configs && typeof fp.configs === "object") {
        checkConfigSnapshots(absRoot, fp.configs, drift, seenDrift);
        const walkedDirs = collectWalkedDirs(absRoot, outDir);
        for (const absCfg of findResolverConfigsInDirs(absRoot, walkedDirs)) {
            const relCfg = relPosix(absRoot, absCfg);
            if (!relCfg || relCfg.startsWith("..") || relCfg in fp.configs) continue;
            if (!seen.has(relCfg) && !seenDrift.has(`a:${relCfg}`)) {
                seenDrift.add(`a:${relCfg}`);
                drift.added.push(relCfg);
            }
        }
    }
    if (fp.docs && typeof fp.docs === "object") {
        checkConfigSnapshots(absRoot, fp.docs, drift, seenDrift);
        for (const { relPath } of collectMarkdownDocFiles(absRoot)) {
            if (relPath in fp.docs) continue;
            if (!seen.has(relPath) && !seenDrift.has(`a:${relPath}`)) {
                seenDrift.add(`a:${relPath}`);
                drift.added.push(relPath);
            }
        }
    }
}

export function probeDrift(root, outDir) {
    const fp = readFingerprint(outDir);
    if (!fp) return null;
    const absRoot = resolve(root);
    const fastClean =
        !alwaysHash() &&
        fp.dirs &&
        typeof fp.dirs === "object" &&
        probeFastDirsClean(absRoot, fp.dirs) &&
        probeFastFilesClean(absRoot, fp.files) &&
        checkConfigSnapshots(absRoot, fp.configs, null, null) &&
        checkConfigSnapshots(absRoot, fp.docs, null, null);
    if (fastClean) return { changed: [], added: [], removed: [] };

    const drift = { changed: [], added: [], removed: [] };
    const seen = new Set();
    const seenDrift = new Set();
    const onlyDirs = fp.onlyDirs && fp.onlyDirs.length > 0 ? new Set(fp.onlyDirs) : undefined;
    const extensions = Array.isArray(fp.extensions) && fp.extensions.length > 0 ? fp.extensions : undefined;
    for (const f of listSourceStats(root, outDir, undefined, onlyDirs, extensions)) {
        seen.add(f.rel);
        recordEntryDrift(f, fp, drift, seenDrift);
    }
    for (const rel of Object.keys(fp.files)) {
        if (!seen.has(rel)) {
            seenDrift.add(`r:${rel}`);
            drift.removed.push(rel);
        }
    }
    appendUntrackedConfigAndDocDrift(absRoot, outDir, fp, drift, seen, seenDrift);
    drift.changed.sort();
    drift.added.sort();
    drift.removed.sort();
    return drift;
}
