/**
 * `seedGraph` — give a linked git worktree the graph its parent checkout already has.
 *
 * `plexer/` is a local cache, so it is gitignored, so `git worktree add` never checks
 * it out: a worktree starts with `src/` and `.claude/` and no graph at all. Every
 * MCP tool then answers "no graph found — run plexer build first" for the whole
 * session, and the passive surface (`INDEX.md`, the cards) is missing too. The agent
 * that was supposed to be cheapest in a fresh worktree is instead blind in one.
 *
 * What travels is the graph and the sidecars a query reads — never the markdown; see
 * `seedable` for why the cards are the parent's branch and not this one's.
 *
 * The parent checkout has not gone anywhere, though — a worktree's `.git` is a *file*
 * naming it, and the harness that creates these worktrees already reaches back the
 * same way (Claude Code symlinks `node_modules` to the parent's). So: copy the
 * parent's `plexer/` in, then let the ordinary refresh gate repair the difference.
 *
 * Copy, not symlink. `node_modules` is the same for every branch; a graph is a set of
 * `file:line` spans for one specific tree, so a shared one would have the worktree
 * rewriting the parent's graph with its own branch's line numbers. What makes the
 * copy worth doing rather than just rebuilding cold:
 *
 * - **The Tier-2 meaning layer survives.** Summaries and cruxes cost real money;
 *   `buildGraph` folds a prior `wiring.json` in by `body_hash`, so an unchanged
 *   function keeps the summary someone already paid for. A cold build throws them all
 *   away and the worktree silently drops to structural-only answers.
 * - **The repair is small.** `probeDrift` confirms a suspect file by content hash, so
 *   a fresh checkout's brand-new mtimes cost one hashing pass and nothing more; the
 *   drift that survives is exactly the diff between the two checkouts' commits.
 * - **$0 and offline**, like everything else on the query path.
 *
 * Never writes to the parent, never throws, and no-ops unless there is genuinely a
 * built parent checkout on disk — so a fresh clone, CI, or a cloud session whose repo
 * was *cloned* rather than worktree'd behaves exactly as it did before: "run plexer
 * build first".
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, GRAPH_DIR, contextDirFor, envTruthy, wiringPath } from "../context/node-file.js";
import { DatabaseSync, SQLITE_FILE, closeSqliteStores, sqliteHasGraph } from "../storage/sqlite-store.js";
import { FINGERPRINT_PREFIX } from "./fingerprint.js";
/** The one line a linked worktree's `.git` file carries. */
const GITDIR_KEY = "gitdir:";
/**
 * The main checkout of the repo `root` is a linked worktree of, or null when `root`
 * isn't one (which is the common case, and not an error).
 *
 * Filesystem-only on purpose: no `git` subprocess on a path that runs before every
 * query. The shapes it has to tell apart:
 *
 * - `<root>/.git` is a **directory** → this *is* the main checkout. Nothing to seed.
 * - `gitdir: <main>/.git/worktrees/<name>` → a linked worktree. `commondir` inside
 *   that dir points back at the shared `.git` (`../..`), whose parent is the main
 *   checkout.
 * - `gitdir: <super>/.git/modules/<name>` → a **submodule**. Identical file shape,
 *   completely different thing: a submodule is its own repo and its parent's `plexer/`
 *   describes different code entirely. The `worktrees` path segment is what rejects it.
 * - A bare repo or `--separate-git-dir` layout, where the resolved common dir isn't
 *   named `.git` and there may be no working tree at all → null.
 */
export function mainWorktreeRoot(root) {
    try {
        const dot = join(root, ".git");
        if (lstatSync(dot).isSymbolicLink() || statSync(dot).isDirectory())
            return null;
        // Read the pointer without a regex. `/^gitdir:[ \t]*(.+?)[ \t]*$/m` is the
        // polynomial-ReDoS shape CodeQL flagged on `ensureSearchable` (`js/polynomial-redos`,
        // fixed in 44a191e): `.` also matches space and tab, so the lazy group and the
        // trailing `[ \t]*` overlap and a line of blanks costs O(n²). Same conclusion as
        // that fix — the ambiguity buys nothing, and split/startsWith/trim is linear and
        // plainer. `trim` also absorbs the `\r` of a CRLF checkout.
        const line = readFileSync(dot, "utf8").split("\n").find((l) => l.startsWith(GITDIR_KEY));
        if (line === undefined)
            return null;
        const target = line.slice(GITDIR_KEY.length).trim();
        if (!target)
            return null;
        const gitdir = isAbsolute(target) ? target : resolve(root, target);
        if (basename(dirname(gitdir)) !== "worktrees")
            return null;
        const rel = readFileSync(join(gitdir, "commondir"), "utf8").trim();
        if (!rel)
            return null;
        const common = isAbsolute(rel) ? rel : resolve(gitdir, rel);
        if (basename(common) !== ".git" || !statSync(common).isDirectory())
            return null;
        if (realpathSync(join(common, "worktrees", basename(gitdir))) !== realpathSync(gitdir))
            return null;
        const main = dirname(common);
        if (resolve(main) === resolve(root))
            return null;
        return main;
    }
    catch (err) {
        // No `.git` at all, an unreadable one, a `commondir` that doesn't exist: all of
        // them mean "can't seed from here", which is the same answer as "not a worktree".
        const notWorktree = null;
        void err;
        return notWorktree;
    }
}

function isRemoteGitUrl(rawUrl) {
    return /^(?:https?|ssh|git):\/\//i.test(rawUrl) || /^[^/\\]+@[^:]+:/i.test(rawUrl);
}

function resolveCandidateCheckout(rawPath, baseDir, cloneRoot) {
    if (!rawPath || typeof rawPath !== "string")
        return null;
    const trimmed = rawPath.trim();
    if (!trimmed || isRemoteGitUrl(trimmed))
        return null;
    let candidate = trimmed;
    if (/^file:\/\//i.test(candidate)) {
        try {
            candidate = fileURLToPath(candidate);
        }
        catch {
            return null;
        }
    }
    const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(baseDir, candidate);
    if (!existsSync(resolved))
        return null;
    const checkout = basename(resolved) === ".git" ? dirname(resolved) : resolved;
    const absCheckout = resolve(checkout);
    if (absCheckout === resolve(cloneRoot))
        return null;
    try {
        if (realpathSync(absCheckout) === realpathSync(cloneRoot))
            return null;
    }
    catch {
        return null;
    }
    if (!existsSync(join(absCheckout, ".git")))
        return null;
    const absCtx = contextDirFor(absCheckout);
    if (!sqliteHasGraph(absCtx) && !existsSync(wiringPath(absCtx)))
        return null;
    return absCheckout;
}

function stripGitConfigComment(rawLine) {
    let inQuotes = false;
    let out = "";
    for (let i = 0; i < rawLine.length; i++) {
        const ch = rawLine[i];
        if (ch === "\\" && inQuotes && i + 1 < rawLine.length) {
            out += ch + rawLine[i + 1];
            i++;
            continue;
        }
        if (ch === '"') {
            inQuotes = !inQuotes;
            out += ch;
            continue;
        }
        if (!inQuotes && (ch === "#" || ch === ";")) {
            break;
        }
        out += ch;
    }
    return out.trim();
}

function unquoteGitConfigValue(val) {
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
        return val.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return val;
}

function parseOriginUrlFromGitConfig(configText) {
    let inOrigin = false;
    for (const rawLine of configText.split(/\r?\n/)) {
        const line = stripGitConfigComment(rawLine);
        if (!line)
            continue;
        if (line.startsWith("[")) {
            inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
            continue;
        }
        if (inOrigin) {
            const eq = line.indexOf("=");
            if (eq !== -1 && line.slice(0, eq).trim().toLowerCase() === "url") {
                return unquoteGitConfigValue(line.slice(eq + 1).trim());
            }
        }
    }
    return null;
}

function resolveGitDirs(root) {
    const dot = join(root, ".git");
    if (lstatSync(dot).isSymbolicLink())
        return null;
    if (statSync(dot).isDirectory()) {
        return { gitdir: dot, commonDir: dot };
    }
    const line = readFileSync(dot, "utf8").split(/\r?\n/).find((l) => l.startsWith(GITDIR_KEY));
    if (!line)
        return null;
    const target = line.slice(GITDIR_KEY.length).trim();
    if (!target)
        return null;
    const gitdir = isAbsolute(target) ? resolve(target) : resolve(root, target);
    let commonDir = gitdir;
    const commondirFile = join(gitdir, "commondir");
    if (existsSync(commondirFile)) {
        const rel = readFileSync(commondirFile, "utf8").trim();
        if (rel) {
            commonDir = isAbsolute(rel) ? resolve(rel) : resolve(gitdir, rel);
        }
    }
    return { gitdir, commonDir };
}

function checkoutFromObjectsDir(objDir, cloneRoot, root) {
    const gitParent = dirname(objDir);
    if (basename(objDir) !== "objects")
        return null;
    if (basename(gitParent) === ".git") {
        return resolveCandidateCheckout(dirname(gitParent), cloneRoot, root);
    }
    if (basename(dirname(gitParent)) === "worktrees" || existsSync(join(gitParent, "commondir"))) {
        const commondirFile = join(gitParent, "commondir");
        if (existsSync(commondirFile)) {
            const rel = readFileSync(commondirFile, "utf8").trim();
            const common = rel ? (isAbsolute(rel) ? resolve(rel) : resolve(gitParent, rel)) : gitParent;
            if (basename(common) === ".git") {
                return resolveCandidateCheckout(dirname(common), cloneRoot, root);
            }
        }
    }
    return null;
}

/**
 * The local parent checkout `root` was cloned from (e.g. `workspace: "branch"`
 * subagent/swarm clones), or null when `root` is a primary checkout or remote clone.
 * Filesystem-only: reads `.git` (directory or linked-worktree pointer), `objects/info/alternates`,
 * and `[remote "origin"].url`.
 */
export function localCloneOriginRoot(root) {
    try {
        const dirs = resolveGitDirs(root);
        if (!dirs)
            return null;
        const altCandidates = [join(dirs.gitdir, "objects", "info", "alternates")];
        const commonAlt = join(dirs.commonDir, "objects", "info", "alternates");
        if (commonAlt !== altCandidates[0])
            altCandidates.push(commonAlt);

        for (const altPath of altCandidates) {
            if (!existsSync(altPath))
                continue;
            const objectsBase = dirname(dirname(altPath));
            const altLines = readFileSync(altPath, "utf8").split(/\r?\n/);
            for (const raw of altLines) {
                const line = raw.trim();
                if (!line || line.startsWith("#"))
                    continue;
                const objDir = isAbsolute(line) ? resolve(line) : resolve(objectsBase, line);
                const hit = checkoutFromObjectsDir(objDir, root, root);
                if (hit)
                    return hit;
            }
        }
        const cfgCandidates = [join(dirs.commonDir, "config"), join(dirs.gitdir, "config")];
        for (const cfgPath of cfgCandidates) {
            if (!existsSync(cfgPath))
                continue;
            const originUrl = parseOriginUrlFromGitConfig(readFileSync(cfgPath, "utf8"));
            if (originUrl) {
                const hit = resolveCandidateCheckout(originUrl, dirname(join(root, ".git")), root);
                if (hit)
                    return hit;
            }
        }
        return null;
    }
    catch {
        return null;
    }
}

function seedSourceRoot(root) {
    return mainWorktreeRoot(root) ?? localCloneOriginRoot(root);
}
const NOT_SEEDED = { seeded: false };
/**
 * An allowlist, not a skip list: is this repo-relative path (posix) one of the few
 * files a seed may bring across?
 *
 * The gate that calls this promises "writes only what a query reads — the graph, the
 * `ask` sidecar, the freshness record" (see the header of ./refresh.js). A copy that
 * wrote anything else would turn a read into a write of the repo, so the copy honours
 * the same list. The extraction memo is on it because the refresh immediately after
 * rewrites that file anyway, and replaying it is what keeps the repair cheap.
 *
 * **Deliberately absent: the cards and `INDEX.md`.** They would land as this
 * checkout's documentation while describing the *parent's* branch, and nothing on the
 * query path rewrites them (`writeCards`/`writeIndex` sit behind `!graphOnly`), so they
 * would stay wrong indefinitely. An explicit `plexer build` regenerates them from this
 * checkout's own graph — and prunes the ones that no longer apply — which is both
 * correct and nearly free once the graph is here.
 *
 * Also absent, because it belongs to the checkout that produced it: `.cache/session/`
 * (another session's transcripts), `.sync.lock` (another process's lock), and
 * `stats.json` (this checkout earns its own savings and dirty flag).
 */
function seedable(rel) {
    // The dirs themselves, or copyTree would never look inside them.
    if (rel === "" || rel === GRAPH_DIR || rel === CACHE_DIR)
        return true;
    if (!rel.startsWith(`${CACHE_DIR}/`))
        return false; // incl. the graph: `installGraph` places it
    const name = rel.slice(CACHE_DIR.length + 1);
    return (
        name === "config.json" ||
        name === "git-history.json" ||
        name === `${FINGERPRINT_PREFIX}.json` ||
        name.startsWith(`${FINGERPRINT_PREFIX}.`) ||
        name === SQLITE_FILE
    );
}

/**
 * Copy `<srcDir>/.cache/index.sqlite` into `<outDir>/.cache/index.sqlite` without ever
 * mutating the parent directory. When parent has uncheckpointed WAL frames, snapshot via
 * read-only `VACUUM INTO` so destination starts cleanly self-contained without `-wal`.
 */
function copySqliteFileSafe(srcSqlite, destSqlite) {
    const tmp = `${destSqlite}.seed.${process.pid}`;
    const walPath = `${srcSqlite}-wal`;
    let hasWal = false;
    try {
        hasWal = existsSync(walPath) && statSync(walPath).size > 0;
    }
    catch {
        hasWal = false;
    }
    try {
        rmSync(tmp, { force: true });
        if (hasWal) {
            let copied = false;
            let srcDb = null;
            try {
                srcDb = new DatabaseSync(srcSqlite, { readOnly: true });
                srcDb.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
                copied = true;
            }
            catch {
                rmSync(tmp, { force: true });
            }
            finally {
                try {
                    srcDb?.close();
                }
                catch { /* ignore close */ }
            }
            if (!copied) {
                copyFileSync(srcSqlite, tmp);
                if (existsSync(walPath))
                    copyFileSync(walPath, `${tmp}-wal`);
                const shmPath = `${srcSqlite}-shm`;
                if (existsSync(shmPath))
                    copyFileSync(shmPath, `${tmp}-shm`);
                let tmpDb = null;
                try {
                    tmpDb = new DatabaseSync(tmp);
                    tmpDb.exec("PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);");
                }
                finally {
                    try {
                        tmpDb?.close();
                    }
                    catch { /* ignore close */ }
                    rmSync(`${tmp}-wal`, { force: true });
                    rmSync(`${tmp}-shm`, { force: true });
                }
            }
        }
        else {
            copyFileSync(srcSqlite, tmp);
        }
        let checkDb = null;
        try {
            checkDb = new DatabaseSync(tmp, { readOnly: true });
            const row = checkDb.prepare("PRAGMA quick_check").get();
            const status = row ? Object.values(row)[0] : null;
            if (status !== "ok") {
                throw new Error(`sqlite quick_check failed: ${String(status)}`);
            }
        }
        finally {
            try {
                checkDb?.close();
            }
            catch { /* ignore close */ }
        }
        renameSync(tmp, destSqlite);
    }
    catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}

/**
 * Copy `srcDir` into `outDir`, keeping only what {@link seedable} allows.
 *
 * Walked by hand rather than through `cpSync`'s `filter`, which did not hold on
 * Windows: the graph arrived — it is placed directly, by {@link installGraph} — while
 * every allowlisted sidecar next to it was dropped. A seeded worktree therefore had no
 * fingerprint, `probeDrift` read that as "never built", and the query right behind the
 * seed rebuilt the whole repo instead of the diff against the parent: precisely the
 * cost seeding exists to avoid, and silent, because a full rebuild still answers
 * correctly. It only surfaced as a `(? files changed)` note on the CI leg.
 *
 * Composing `rel` from the segments this walk joined itself is what fixes it — the
 * allowlist no longer depends on the form `cpSync` chooses to hand its callback, and
 * `rel` is posix by construction rather than by conversion. Also narrower than the old
 * copy in one way worth keeping: only real files and directories travel, never a
 * symlink, and nothing in the allowlist is one.
 */
function copyTree(srcDir, outDir) {
    closeSqliteStores(outDir);
    const copyRelDir = (rel) => {
        const from = rel ? join(srcDir, rel) : srcDir;
        mkdirSync(rel ? join(outDir, rel) : outDir, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (!seedable(childRel))
                continue;
            if (entry.isDirectory()) {
                copyRelDir(childRel);
            }
            else if (entry.isFile()) {
                const srcFile = join(from, entry.name);
                const destFile = join(outDir, childRel);
                if (childRel === `${CACHE_DIR}/${SQLITE_FILE}`) {
                    copySqliteFileSafe(srcFile, destFile);
                }
                else {
                    copyFileSync(srcFile, destFile);
                }
            }
        }
    };
    copyRelDir("");
}
/**
 * Put `wiring.json` in place last, via a temp file and a rename.
 *
 * Its presence is the flag every caller reads to mean "this repo has a graph"
 * (`refresh.js`, `workspace.js`, every MCP tool). So it must appear only once the
 * rest of the copy has landed and must never appear half-written: a seed killed
 * midway then leaves no graph, and the next call simply seeds again.
 */
function installGraph(srcGraph, destGraph) {
    mkdirSync(dirname(destGraph), { recursive: true });
    const tmp = `${destGraph}.seed.${process.pid}`;
    try {
        copyFileSync(srcGraph, tmp);
        renameSync(tmp, destGraph);
    }
    catch (err) {
        try {
            rmSync(tmp, { force: true });
        }
        catch { /* nothing to clean up */ }
        throw err;
    }
}
/** True when `root` is a linked git worktree or local clone with no local graph whose parent checkout has one. */
export function canSeedGraph(root, opts = {}) {
    if (opts.contextDir || envTruthy("PLEXER_NO_SEED"))
        return false;
    try {
        const dir = resolve(root);
        const outDir = contextDirFor(dir);
        if (sqliteHasGraph(outDir) || existsSync(wiringPath(outDir)))
            return false;
        const main = seedSourceRoot(dir);
        if (!main)
            return false;
        const mainCtx = contextDirFor(main);
        return sqliteHasGraph(mainCtx) || existsSync(wiringPath(mainCtx));
    }
    catch {
        return false;
    }
}
/**
 * Copy the parent checkout's graph into `root`'s own `plexer/`, if all of this holds:
 * `root` is a linked worktree or local clone, it has no graph yet, the parent has one,
 * and no `--dir` override is in play.
 */
export function seedGraph(root, opts = {}) {
    if (!canSeedGraph(root, opts))
        return NOT_SEEDED;
    try {
        const dir = resolve(root);
        const outDir = contextDirFor(dir);
        const main = seedSourceRoot(dir);
        if (!main)
            return NOT_SEEDED;
        const srcDir = contextDirFor(main);
        const srcGraph = wiringPath(srcDir);
        const hasSql = sqliteHasGraph(srcDir);
        if (!hasSql && !existsSync(srcGraph))
            return NOT_SEEDED; // parent never built either
        copyTree(srcDir, outDir);
        if (existsSync(srcGraph))
            installGraph(srcGraph, wiringPath(outDir));
        return { seeded: true, from: main };
    }
    catch {
        return NOT_SEEDED;
    }
}
