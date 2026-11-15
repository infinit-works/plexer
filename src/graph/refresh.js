/**
 * `ensureFreshGraph` — the pre-query gate that keeps retrieval honest.
 *
 * Freshness used to be someone else's job: the Claude Code `Stop` hook spawned a
 * background `plexer build` *after* the turn ended, so every query an agent made
 * between its first edit and the end of the turn answered from a graph that no
 * longer matched the file it had just changed. Worse, an edit made outside the
 * agent (your editor, a branch switch, a stash) set no `dirty` flag at all, so
 * nothing ever triggered a resync.
 *
 * So freshness moves into the query path: every retrieval call probes the working
 * tree (`fingerprint.js`, ~3ms) and, when something moved, rebuilds the structural
 * graph before answering. Properties worth keeping:
 *
 * - **$0 and offline.** Pure local parsing and BM25 — no API keys or network calls.
 * - **Never fatal.** A failed refresh degrades to answering from the graph on
 *   disk. A query that works today must not start failing because a rebuild did.
 * - **Never a stampede.** It takes the same `plexer/.cache/.sync.lock` the
 *   background sync uses, so concurrent MCP calls and the Stop hook can't pile up
 *   rebuilds on top of each other.
 * - **Writes only what a query reads** (`graphOnly`): the graph, the `ask` sidecar,
 *   the freshness record. Not the markdown cards, not `INDEX.md`, not `.gitignore`.
 *   Those belong to an explicit `plexer build` — which the `Stop` hook already runs
 *   at the end of a turn — so retrieval stays cheap and a read stays a read. It
 *   also leaves `stats.json` alone, so that same `Stop` hook still sees `dirty` and
 *   still rebuilds the passive surface.
 *
 * One case is not drift but absence: inside a git worktree there is no graph at all,
 * because `plexer/` is gitignored and so was never checked out. The gate covers that
 * too — it copies the parent checkout's graph in (`./seed.js`) and then treats the
 * difference between the two checkouts as ordinary drift, which is exactly what it is.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { plural } from "../util/span.js";
import { CACHE_DIR, contextDirFor, envTruthy, wiringPath } from "../context/node-file.js";
import { acquireLockIn, releaseLockIn } from "../util/state.js";
import { buildGraph } from "./build.js";
import { driftCount, isClean, probeDrift, readFingerprint } from "./fingerprint.js";
import { invalidateGraphCaches } from "../context/graph-store.js";
import { isAutoBuildableRepo } from "./root.js";
import { canSeedGraph, seedGraph } from "./seed.js";
/** How long to wait for another process's in-flight rebuild before giving up and
 * answering from the current graph. Long enough to ride out a small repo's build,
 * short enough that a tool call never feels hung. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;
const CLEAN = { refreshed: false };
/** Env kill switch, for CI or anyone who wants queries to never write. */
function envDisabled() {
    return envTruthy("PLEXER_NO_REFRESH");
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * Release the lock if this process is asked to die while holding it. Returns the
 * un-hook.
 *
 * Not hypothetical: the Claude Code prompt hook runs `plexer ask` with a timeout, and
 * `execFileSync` enforces it with SIGTERM. Node's default disposition for SIGTERM is
 * to exit without unwinding, so the `finally` below never runs and the lock outlives
 * the process — after which the background sync is blocked and every query waits and
 * then answers stale until the lock ages out. Ctrl-C on a CLI query is the same story
 * with SIGINT.
 *
 * Adding a listener replaces that default disposition, so re-raise it explicitly
 * afterwards: remove ourselves, then `process.kill(process.pid, sig)`, so the exit
 * status still says "terminated by signal" for whoever is waiting on us.
 */
function releaseOnSignal(cache) {
    const signals = ["SIGTERM", "SIGINT"];
    const onSignal = (sig) => {
        releaseLockIn(cache);
        for (const s of signals)
            process.removeListener(s, onSignal);
        process.kill(process.pid, sig);
    };
    for (const s of signals)
        process.once(s, onSignal);
    return () => {
        for (const s of signals)
            process.removeListener(s, onSignal);
    };
}
/** Wait out someone else's rebuild, then take the lock. False when we couldn't. */
async function waitForLock(cache) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        if (acquireLockIn(cache))
            return true;
        if (Date.now() >= deadline)
            return false;
        await sleep(LOCK_POLL_MS);
    }
}
/**
 * Copy a parent checkout's graph in, holding the same lock a rebuild would.
 *
 * Two MCP tool calls in a fresh worktree arrive here at the same moment, and an 8 MB
 * copy is long enough for both to start one. The loser waits, then finds the graph
 * already there and reports nothing — which is why the caller re-checks the file
 * rather than trusting this return value.
 */
async function seedUnderLock(dir, outDir, contextDir) {
    if (!canSeedGraph(dir, { contextDir }))
        return { seeded: false };
    const lockCache = join(outDir, CACHE_DIR);
    // `busy` matters: with no graph on disk there is nothing to fall back to, so a
    // caller that stayed silent here would emit the bare "no matching nodes" this whole
    // mechanism exists to remove. Say what happened instead.
    if (!(await waitForLock(lockCache)))
        return { seeded: false, busy: true };
    const unhook = releaseOnSignal(lockCache);
    try {
        return seedGraph(dir, { contextDir });
    }
    finally {
        unhook();
        releaseLockIn(lockCache);
    }
}
/**
 * Rebuild `root`'s structural graph if the working tree has moved since the last
 * build. Cheap and side-effect-free when nothing changed, which is the usual case.
 *
 * `root` is the repository root (the same value the query itself is given), not
 * the context dir.
 */
async function autoBuildMissingGraph(dir, outDir, opts, seed) {
    if (opts.autoBuild !== false && isAutoBuildableRepo(dir)) {
        const lockCache = join(outDir, CACHE_DIR);
        if (await waitForLock(lockCache)) {
            const unhook = releaseOnSignal(lockCache);
            try {
                if (!existsSync(wiringPath(outDir))) {
                    await buildGraph(dir, { contextDir: opts.contextDir, _lockHeld: true });
                }
                invalidateGraphCaches(outDir);
                return { refreshed: true, note: `indexed repo into ${outDir}` };
            }
            finally {
                unhook();
                releaseLockIn(lockCache);
            }
        }
    }
    return seed.busy
        ? { refreshed: false, note: "another process is still copying the graph into this worktree — retry the query in a moment" }
        : CLEAN;
}

async function rebuildExistingGraphUnderLock(dir, outDir, drift, seedNote, opts) {
    const lockCache = join(outDir, CACHE_DIR);
    if (!(await waitForLock(lockCache))) {
        const busy = "a graph rebuild is already in flight — answering from the current graph";
        return {
            refreshed: false,
            drift: drift ?? undefined,
            note: seedNote ? `${seedNote}; ${busy}` : busy,
        };
    }
    const unhook = releaseOnSignal(lockCache);
    try {
        const now = drift ? probeDrift(dir, outDir) : null;
        if (now && isClean(now)) {
            invalidateGraphCaches(outDir);
            return seedNote ? { refreshed: false, note: seedNote } : CLEAN;
        }
        const fp = readFingerprint(outDir);
        await buildGraph(dir, {
            contextDir: opts.contextDir,
            graphOnly: true,
            onlyDirs: fp?.onlyDirs,
            extensions: fp?.extensions,
            _lockHeld: true,
        });
        invalidateGraphCaches(outDir);
        return { refreshed: true, drift: drift ?? undefined, note: seedNote };
    }
    finally {
        unhook();
        releaseLockIn(lockCache);
    }
}

export async function ensureFreshGraph(root, opts = {}) {
    if (opts.disabled || envDisabled())
        return CLEAN;
    try {
        const dir = resolve(root);
        const outDir = contextDirFor(dir, opts.contextDir);
        let seededFrom;
        if (!existsSync(wiringPath(outDir))) {
            const seed = await seedUnderLock(dir, outDir, opts.contextDir);
            seededFrom = seed.from;
            if (seed.seeded) {
                invalidateGraphCaches(outDir);
            }
            if (!existsSync(wiringPath(outDir))) {
                return await autoBuildMissingGraph(dir, outDir, opts, seed);
            }
        }
        const seedNote = seededFrom ? `copied the graph from the main checkout (${seededFrom})` : undefined;
        const drift = probeDrift(dir, outDir);
        if (drift && isClean(drift))
            return seedNote ? { refreshed: false, note: seedNote } : CLEAN;
        return await rebuildExistingGraphUnderLock(dir, outDir, drift, seedNote, opts);
    }
    catch (err) {
        return { refreshed: false, note: `graph refresh skipped: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/**
 * Workspace variant: refresh each child repo's own graph (a workspace parent holds
 * an index, never nodes). Children are independent, but they're refreshed in
 * sequence — a fan-out of concurrent tree-sitter builds would spike CPU on the
 * very path that's supposed to feel free.
 */
export async function ensureFreshChildren(root, children, opts = {}) {
    if (opts.disabled || envDisabled())
        return CLEAN;
    const refreshedIn = [];
    let files = 0;
    for (const child of children) {
        // Deliberately NOT `opts`: `contextDirFor` returns an override verbatim and
        // ignores the root it's handed, so forwarding the parent's `--dir` would point
        // every child at the *parent's* context dir — which holds a workspace index and
        // no wiring.json, so every child would silently be skipped. (And if it did hold
        // one, each child would build into that single shared dir in turn, the last
        // clobbering the rest.) A child's graph always lives in its own `<child>/plexer`,
        // which is exactly how `loadWorkspaceGraphs` reads them back.
        const r = await ensureFreshGraph(resolve(root, child), { autoBuild: opts.autoBuild });
        if (!r.refreshed)
            continue;
        refreshedIn.push(child);
        files += r.drift ? driftCount(r.drift) : 0;
    }
    if (!refreshedIn.length)
        return CLEAN;
    return {
        refreshed: true,
        note: `refreshed ${refreshedIn.join(", ")} (${files ? plural(files, "file") : "? files"} changed) before answering`,
    };
}
/** The one-line note a CLI/MCP surface prints when a refresh actually happened.
 * Null when there's nothing to say (the overwhelmingly common case). */
export function refreshNote(r) {
    if (!r.refreshed)
        return r.note ? `[plexer] ${r.note}` : null;
    const n = r.drift ? driftCount(r.drift) : 0;
    const built = `refreshed the graph (${n ? plural(n, "file") : "? files"} changed) before answering`;
    // Both facts, when a worktree was seeded *and* the copy needed repairing: the
    // count is the interesting half (it's the branch diff), the provenance explains
    // where a graph came from in a directory the user knows they never built.
    return r.note ? `[plexer] ${built} — ${r.note}` : `[plexer] ${built}`;
}
