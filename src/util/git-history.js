/**
 * Evolutionary git history analysis (`analyzeGitHistory`):
 *   1. Per-file commit churn & recency-decayed hotspot score (`HALF_LIFE_MS = 120d`).
 *   2. Temporal coupling (`coChanges`) — files that frequently co-change in the
 *      same commit (`coCommits >= 3`, `couplingRatio >= 0.5`), skipping bulk
 *      commits (> 30 files) so mass formatting/renames do not create false pairs.
 *
 * Results are cached in `<contextDir>/.cache/git-history.json` keyed by `HEAD`
 * commit SHA so repeated `blast`, `map`, and `health` invocations cost 0ms.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git } from "./git.js";

const HISTORY_CACHE_VERSION = 1;
const HALF_LIFE_MS = 120 * 24 * 60 * 60 * 1000;
const DEFAULT_SINCE = "365.days";
const DEFAULT_MAX_COMMITS = 200;
const MAX_COMMIT_FILES_FOR_COUPLING = 30;
const DEFAULT_MIN_CO_COMMITS = 3;
const DEFAULT_MIN_COUPLING_RATIO = 0.5;

function historyCachePath(contextDir) {
    return contextDir ? join(contextDir, ".cache", "git-history.json") : null;
}

function readHistoryCache(cacheFile, head, maxCommits, minCoCommits, minRatio, since) {
    if (!cacheFile || !head || !existsSync(cacheFile)) return null;
    try {
        const data = JSON.parse(readFileSync(cacheFile, "utf8"));
        if (
            data &&
            data.version === HISTORY_CACHE_VERSION &&
            data.head === head &&
            data.maxCommits === maxCommits &&
            data.minCoCommits === minCoCommits &&
            data.minRatio === minRatio &&
            data.since === since
        ) {
            return data;
        }
    } catch {
        /* ignore corrupt cache */
    }
    return null;
}

function writeHistoryCache(cacheFile, payload) {
    if (!cacheFile) return;
    try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(payload), "utf8");
    } catch {
        /* cache write is best-effort */
    }
}

function recordCommitPairs(touched, timestamp, pairCounts) {
    touched.sort();
    for (let i = 0; i < touched.length; i++) {
        const a = touched[i];
        for (let j = i + 1; j < touched.length; j++) {
            const b = touched[j];
            const key = `${a}\0${b}`;
            const prev = pairCounts.get(key);
            if (!prev) {
                pairCounts.set(key, { a, b, count: 1, lastAt: timestamp });
            } else {
                prev.count += 1;
                if (timestamp > prev.lastAt) prev.lastAt = timestamp;
            }
        }
    }
}

function accumulateCommitBlock(block, now, fileStats, pairCounts) {
    const lines = block.split("\n");
    const [hash, iso] = (lines[0] ?? "").split("\x02");
    if (!hash) return false;
    const at = Date.parse(iso ?? "");
    const timestamp = Number.isFinite(at) ? at : now;
    const weight = Math.pow(0.5, Math.max(0, now - timestamp) / HALF_LIFE_MS);

    const touched = [];
    const seenInCommit = new Set();
    for (let i = 1; i < lines.length; i++) {
        const p = lines[i].trim();
        if (p && !seenInCommit.has(p)) {
            seenInCommit.add(p);
            touched.push(p);
        }
    }
    if (touched.length === 0) return false;

    for (const f of touched) {
        let st = fileStats.get(f);
        if (!st) fileStats.set(f, (st = { commits: 0, churnScore: 0, lastAt: timestamp }));
        st.commits += 1;
        st.churnScore += weight;
        if (timestamp > st.lastAt) st.lastAt = timestamp;
    }
    if (touched.length >= 2 && touched.length <= MAX_COMMIT_FILES_FOR_COUPLING) {
        recordCommitPairs(touched, timestamp, pairCounts);
    }
    return true;
}

function collectCommitStatsFromGitLog(out, now) {
    const fileStats = new Map();
    const pairCounts = new Map();
    let commitsScanned = 0;
    for (const block of out.split("\x01").filter(Boolean)) {
        if (accumulateCommitBlock(block, now, fileStats, pairCounts)) commitsScanned += 1;
    }
    return { fileStats, pairCounts, commitsScanned };
}

function buildCoChangeTables(fileStats, pairCounts, minCoCommits, minRatio) {
    const files = {};
    for (const [path, st] of fileStats.entries()) {
        files[path] = {
            commits: st.commits,
            churnScore: Math.round(st.churnScore * 100) / 100,
            lastAt: st.lastAt,
        };
    }

    const coChanges = {};
    const addCoupling = (src, partner, coCommits, totalCommits, lastAt) => {
        const ratio = Math.round((coCommits / totalCommits) * 100) / 100;
        if (coCommits < minCoCommits || ratio < minRatio) return;
        if (!coChanges[src]) coChanges[src] = [];
        coChanges[src].push({
            partner,
            coCommits,
            totalCommits,
            couplingRatio: ratio,
            lastAt,
        });
    };

    for (const pair of pairCounts.values()) {
        if (pair.count < minCoCommits) continue;
        const stA = fileStats.get(pair.a);
        const stB = fileStats.get(pair.b);
        if (stA) addCoupling(pair.a, pair.b, pair.count, stA.commits, pair.lastAt);
        if (stB) addCoupling(pair.b, pair.a, pair.count, stB.commits, pair.lastAt);
    }

    for (const list of Object.values(coChanges)) {
        list.sort(
            (x, y) =>
                y.couplingRatio - x.couplingRatio ||
                y.coCommits - x.coCommits ||
                x.partner.localeCompare(y.partner),
        );
    }
    return { files, coChanges };
}

/**
 * Analyze git commit history for file churn and temporal co-change coupling.
 */
export function analyzeGitHistory(root, contextDir = null, opts = {}) {
    const absRoot = resolve(root);
    const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
    const minCoCommits = opts.minCoCommits ?? DEFAULT_MIN_CO_COMMITS;
    const minRatio = opts.minRatio ?? DEFAULT_MIN_COUPLING_RATIO;
    const since = opts.since ?? DEFAULT_SINCE;
    if (typeof since !== "string" || !since.trim() || since.startsWith("-") || /[\0\r\n]/.test(since)) {
        throw new Error(`Invalid --since value: "${since}"`);
    }
    const now = opts.now ?? Date.now();

    const headRaw = git(absRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const head = headRaw ? headRaw.trim() : null;
    const cacheFile = opts.noCache ? null : historyCachePath(contextDir);

    if (head && opts.now === undefined) {
        const cached = readHistoryCache(cacheFile, head, maxCommits, minCoCommits, minRatio, since);
        if (cached) return cached;
    }

    const out = git(absRoot, [
        "log",
        "--no-merges",
        "--no-textconv",
        `--since=${since}`,
        "-n",
        String(maxCommits),
        "--format=\x01%H\x02%aI",
        "--relative",
        "--name-only",
        "--end-of-options",
        "--",
    ]);

    if (!out) {
        return { version: HISTORY_CACHE_VERSION, head: null, commitsScanned: 0, files: {}, coChanges: {} };
    }

    const { fileStats, pairCounts, commitsScanned } = collectCommitStatsFromGitLog(out, now);
    const { files, coChanges } = buildCoChangeTables(fileStats, pairCounts, minCoCommits, minRatio);

    const result = {
        version: HISTORY_CACHE_VERSION,
        head,
        maxCommits,
        minCoCommits,
        minRatio,
        since,
        commitsScanned,
        files,
        coChanges,
    };

    if (head && opts.now === undefined) {
        writeHistoryCache(cacheFile, result);
    }
    return result;
}

/**
 * Given a set of changed files and a `GraphV1` (optional), return co-change
 * partners that were NOT modified in the diff, annotated with whether a
 * static graph edge exists between the pair.
 */
export function untouchedCoChanges(history, changedPaths, graph = null) {
    if (!history?.coChanges) return [];
    const changedSet = new Set(changedPaths);
    const staticFilePairs = new Set();
    if (graph?.edges && graph?.nodes) {
        const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
        for (const e of graph.edges) {
            if (e.relation === "contains") continue;
            const sf = byId.get(e.source)?.path ?? (byId.has(e.source) ? e.source : null);
            const tf = byId.get(e.target)?.path ?? (byId.has(e.target) ? e.target : null);
            if (sf && tf && sf !== tf) {
                staticFilePairs.add(`${sf}\0${tf}`);
                staticFilePairs.add(`${tf}\0${sf}`);
            }
        }
    }

    const byPartner = new Map();
    for (const src of changedSet) {
        const partners = history.coChanges[src] ?? [];
        for (const entry of partners) {
            if (changedSet.has(entry.partner)) continue;
            const hasStaticEdge = staticFilePairs.has(`${src}\0${entry.partner}`);
            const prev = byPartner.get(entry.partner);
            if (
                !prev ||
                entry.couplingRatio > prev.couplingRatio ||
                (entry.couplingRatio === prev.couplingRatio && entry.coCommits > prev.coCommits)
            ) {
                byPartner.set(entry.partner, {
                    source: src,
                    partner: entry.partner,
                    coCommits: entry.coCommits,
                    totalCommits: entry.totalCommits,
                    couplingRatio: entry.couplingRatio,
                    hasStaticEdge,
                });
            }
        }
    }

    return [...byPartner.values()].sort(
        (a, b) =>
            Number(a.hasStaticEdge) - Number(b.hasStaticEdge) ||
            b.couplingRatio - a.couplingRatio ||
            b.coCommits - a.coCommits ||
            a.partner.localeCompare(b.partner),
    );
}
