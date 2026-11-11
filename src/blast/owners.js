/**
 * Who to tag on a pull request: the people whose fingerprints are on the areas
 * this diff changes or can affect.
 *
 * The blast report already answers "what does this reach"; the author's next
 * question is "who do I ask about it", and git has the answer without a single
 * API call. One `git log` per area over that area's OWN files, scored by recency,
 * ranked, capped.
 *
 * Two rules keep the output honest, and both exist because a wrong name here is
 * worse than no name:
 *
 *  - A handle is only ever printed when git actually carries one (the GitHub
 *    noreply address, which anything merged through the web UI has). With no
 *    handle the display name is printed unlinked — a guessed `@mention` pings a
 *    stranger, and there is no cheap way to verify a guess.
 *  - An owner has to hold {@link MIN_SHARE} of an area's weight to be named. That
 *    drops a drive-by typo fix next to a real owner, and keeps it when the
 *    drive-by is all the history there is.
 *
 * Everything here is best-effort: no git, no repository, a detached tarball
 * checkout or a shallow clone leaves the report exactly as it was and the comment
 * simply says nothing about people.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./diff.js";
/**
 * Recency half-life. A commit from four months ago counts half as much as one
 * from today, so the person who rewrote a module last month outranks the person
 * who created it two years ago and moved on — which is the reviewer an author
 * actually wants.
 */
const HALF_LIFE_MS = 120 * 24 * 60 * 60 * 1000;
/**
 * History window and commit cap, per area.
 *
 * Both are bounds on the walk, not on the answer: at 36 months a commit is worth
 * 0.002 of a fresh one, so nothing outside the window could survive the share
 * floor anyway, and the pair keeps one `git log` off a large repo's full history.
 */
const SINCE = "36.months";
const MAX_COMMITS = 400;
/** Files passed to one `git log`. A very wide area is sampled rather than blowing
 * the argument list; the sample is the area's own sorted file list, so it is
 * stable between runs rather than whichever files git happened to yield. */
const MAX_PATHSPEC = 80;
/** Share of an area's total weight an owner must hold to be named. */
const MIN_SHARE = 0.15;
/** Names listed per area, and in the tag line. */
export const MAX_PER_AREA = 2;
export const MAX_REVIEWERS = 3;
/**
 * Weight of an area a diff only *reaches*, against one it edits.
 *
 * Not zero, because the person whose code your change can break is exactly the
 * reviewer the diff alone would never surface — that is what the blast radius is
 * for. Not one either: the author of the code you edited knows it better.
 */
const AFFECTED_WEIGHT = 0.6;
/**
 * A GitHub handle out of a commit email, or null.
 *
 * Both noreply forms are accepted: the modern `12345+name@` and the legacy bare
 * `name@`. The character class is GitHub's own username rule (alphanumerics and
 * interior hyphens, 39 max) so an address that merely ends in the right domain
 * cannot smuggle something unmentionable into a comment body.
 */
export function githubHandle(email) {
    const m = /^(?:\d+\+)?([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})@users\.noreply\.github\.com$/i.exec(email.trim());
    return m ? m[1] : null;
}
/** Bots write commits and are never reviewers. */
function isBot(name, email) {
    return /\[bot\]/i.test(name) || /\[bot\]@/i.test(email) || /^(github-actions|dependabot|renovate)(\[bot\])?$/i.test(name.trim());
}
const BATCH_PATHSPEC = 200;
const MAX_BATCH_COMMITS = 4000;
const LOCAL_IDENTITY_CACHE = new Map();
const MAX_IDENTITY_CACHE = 128;

function buildExcludedSet(exclude) {
    const excluded = new Set();
    for (const raw of exclude ?? []) {
        const clean = raw.trim().toLowerCase();
        if (!clean)
            continue;
        excluded.add(clean);
        const h = githubHandle(clean);
        if (h)
            excluded.add(h.toLowerCase());
    }
    return excluded;
}

function isExcludedOwner(o, key, excluded) {
    return excluded.has(key.toLowerCase()) ||
        excluded.has(o.name.toLowerCase()) ||
        (o.handle !== undefined && excluded.has(o.handle.toLowerCase())) ||
        [...o.emails].some((e) => excluded.has(e));
}

function parseGitOwnerLog(out, wanted, now, fileCommits, seqStart = 0) {
    let seq = seqStart;
    let commit = null;
    for (const line of out.split("\n")) {
        if (line.startsWith("\x1e")) {
            const [hash, secStr, name = "", email = ""] = line.slice(1).split("\x1f");
            const sec = Number(secStr);
            const at = sec * 1000;
            commit = hash && Number.isFinite(at)
                ? {
                    seq: seq++,
                    hash,
                    at,
                    weight: Math.pow(0.5, (now - at) / HALF_LIFE_MS),
                    name,
                    email,
                    bot: isBot(name, email),
                }
                : null;
            continue;
        }
        // A pathspec'd `git log --name-only` already lists only matching files, but
        // the set is re-checked here so a future flag change cannot silently start
        // crediting whoever touched an unrelated file in the same commit.
        if (commit === null || !line || !wanted.has(line))
            continue;
        let list = fileCommits.get(line);
        if (!list) {
            list = [];
            fileCommits.set(line, list);
        }
        list.push(commit);
    }
    return seq;
}

function collectCommitsByFile(dir, uniquePaths, now, maxCommits) {
    const fileCommits = new Map();
    if (uniquePaths.length === 0)
        return { fileCommits, multiChunk: false };
    let seq = 0;
    let chunks = 0;
    for (let i = 0; i < uniquePaths.length; i += BATCH_PATHSPEC) {
        const slice = uniquePaths.slice(i, i + BATCH_PATHSPEC);
        const out = git(dir, [
            "log",
            "--no-merges",
            "--no-textconv",
            `--since=${SINCE}`,
            "-n",
            String(maxCommits),
            "--format=\x1e%H\x1f%at\x1f%aN\x1f%aE",
            "--name-only",
            "--",
            ...slice,
        ]);
        chunks += 1;
        if (out === null)
            continue;
        seq = parseGitOwnerLog(out, new Set(slice), now, fileCommits, seq);
    }
    return { fileCommits, multiChunk: chunks > 1 };
}

function areaCommitsFromMap(paths, fileCommits, multiChunk = false) {
    const byHash = new Map();
    for (const p of paths) {
        const list = fileCommits.get(p);
        if (!list)
            continue;
        for (const c of list) {
            if (!byHash.has(c.hash))
                byHash.set(c.hash, c);
        }
    }
    if (byHash.size === 0)
        return [];
    const unique = [...byHash.values()].sort((a, b) => (multiChunk ? b.at - a.at || a.seq - b.seq : a.seq - b.seq));
    return unique.length > MAX_COMMITS ? unique.slice(0, MAX_COMMITS) : unique;
}

function rankOwnersFromCommits(commits, excluded) {
    const people = new Map();
    for (const commit of commits) {
        // One commit touching six files in the area is already deduplicated to one entry in `commits`.
        if (commit.bot)
            continue;
        const handle = githubHandle(commit.email) ?? undefined;
        const emailLower = commit.email.toLowerCase();
        const key = (handle ?? commit.email).toLowerCase();
        const prev = people.get(key);
        if (!prev) {
            people.set(key, {
                name: commit.name,
                handle,
                commits: 1,
                score: commit.weight,
                last: commit.at,
                emails: new Set([emailLower]),
            });
            continue;
        }
        prev.emails.add(emailLower);
        prev.commits += 1;
        prev.score += commit.weight;
        prev.last = Math.max(prev.last, commit.at);
    }
    const kept = [...people].filter(([key, o]) => !isExcludedOwner(o, key, excluded)).map(([, o]) => o);
    // The floor is a SHARE of what is left after the author is dropped, not of the
    // whole area. On a repo where one person wrote everything, their own PR would
    // otherwise leave every remaining contributor under the floor and report nobody.
    const total = kept.reduce((n, o) => n + o.score, 0);
    return kept
        .filter((o) => total === 0 || o.score / total >= MIN_SHARE)
        .sort((a, b) => b.score - a.score || b.commits - a.commits || a.name.localeCompare(b.name))
        .slice(0, MAX_PER_AREA)
        .map(({ name, handle, commits, score, last }) => ({ name, handle, commits, score, last }));
}

/**
 * The people behind `files`, best first.
 *
 * `--no-merges` because a merge commit's author is whoever pressed the button,
 * not whoever wrote the code. `%aN`/`%aE` rather than `%an`/`%ae` so git applies
 * the repository's `.mailmap` for us — which is the supported way to give a
 * contributor whose work address has no handle a noreply one, at no new config
 * cost to plexer.
 */
export function ownersFor(root, files, opts = {}) {
    const paths = [...files].sort().slice(0, MAX_PATHSPEC);
    if (paths.length === 0)
        return [];
    const now = opts.now ?? Date.now();
    const { fileCommits, multiChunk } = collectCommitsByFile(resolve(root), paths, now, MAX_COMMITS);
    const commits = areaCommitsFromMap(paths, fileCommits, multiChunk);
    if (commits.length === 0)
        return [];
    return rankOwnersFromCommits(commits, buildExcludedSet(opts.exclude));
}
/**
 * Everyone who authored a commit in `base...HEAD` — the people whose work this
 * pull request IS.
 *
 * This is the exclusion that actually fires in CI. The obvious source for "who
 * opened this" is `pull_request.user.email` from the webhook, but GitHub almost
 * never populates it, so excluding on the login alone leaves anyone whose commits
 * carry a work address being suggested as a reviewer of their own PR. The commits
 * in the range carry exactly the name and email git will match on later.
 *
 * Co-authors count too: a pair-programmed commit has two people on it and neither
 * of them is a reviewer of it.
 */
export function diffAuthors(root, base) {
    if (!base || base.startsWith("-"))
        return [];
    const out = git(resolve(root), ["log", "--no-textconv", "--format=%aN%n%aE%n%(trailers:key=Co-authored-by,valueonly)", "--end-of-options", `${base}...HEAD`, "--"]);
    if (out === null)
        return [];
    const names = new Set();
    for (const raw of out.split("\n")) {
        const line = raw.trim();
        if (line === "")
            continue;
        // A co-author trailer is `Name <email>`; both halves are worth excluding.
        const m = /^(.*?)\s*<([^>]+)>$/.exec(line);
        if (m) {
            if (m[1])
                names.add(m[1]);
            names.add(m[2]);
            continue;
        }
        names.add(line);
    }
    return [...names];
}
/**
 * Whoever git would sign a commit as, here and now.
 *
 * The local counterpart of {@link diffAuthors}. `plexer blast` with no `--base`
 * compares the working tree against HEAD, so there is no commit range to read
 * authors from — and without this, the one person guaranteed to have written the
 * change being examined is also the top name in its own "who to tag" list.
 */
export function localIdentity(root) {
    const dir = resolve(root);
    let configMtime = -1;
    try {
        configMtime = statSync(join(dir, ".git", "config")).mtimeMs;
    } catch {
        // Worktree `.git` pointer file or non-repo; fall back to path key
    }
    const cacheKey = `${dir}\0${configMtime}`;
    const cached = LOCAL_IDENTITY_CACHE.get(cacheKey);
    if (cached)
        return [...cached];

    const raw = git(dir, ["config", "--get-regexp", "^user\\.(name|email)$"]);
    let userName = "";
    let userEmail = "";
    if (raw !== null) {
        for (const line of raw.split("\n")) {
            if (line.startsWith("user.name")) {
                userName = line.slice("user.name".length).trim();
            } else if (line.startsWith("user.email")) {
                userEmail = line.slice("user.email".length).trim();
            }
        }
    }
    const res = [userName, userEmail].filter((v) => v !== "");
    if (LOCAL_IDENTITY_CACHE.size >= MAX_IDENTITY_CACHE) {
        LOCAL_IDENTITY_CACHE.clear();
    }
    LOCAL_IDENTITY_CACHE.set(cacheKey, res);
    return [...res];
}
/**
 * Fill in `owners` on every area and module, and rank the report's `reviewers`.
 */
export function attachOwners(root, report, opts = {}) {
    const now = opts.now ?? Date.now();
    const excluded = buildExcludedSet(opts.exclude);
    const areaPaths = report.areas.map((a) => [...a.files].sort().slice(0, MAX_PATHSPEC));
    const modPaths = report.modules.map((m) => [...m.files].sort().slice(0, MAX_PATHSPEC));
    const uniquePaths = [...new Set([...areaPaths.flat(), ...modPaths.flat()])].sort();
    const batchCap = Math.min(MAX_BATCH_COMMITS, Math.max(MAX_COMMITS, (areaPaths.length + modPaths.length) * MAX_COMMITS));
    const { fileCommits, multiChunk } = collectCommitsByFile(resolve(root), uniquePaths, now, batchCap);

    const ranked = new Map();
    const accumulateAreaOwners = (label, paths, weight) => {
        if (paths.length === 0)
            return [];
        const commits = areaCommitsFromMap(paths, fileCommits, multiChunk);
        const owners = commits.length > 0 ? rankOwnersFromCommits(commits, excluded) : [];
        for (const o of owners) {
            const key = (o.handle ?? o.name).toLowerCase();
            const prev = ranked.get(key);
            if (!prev) {
                ranked.set(key, { ...o, areas: [label], weighted: o.score * weight });
                continue;
            }
            prev.areas.push(label);
            prev.commits += o.commits;
            prev.score += o.score;
            prev.weighted += o.score * weight;
            prev.last = Math.max(prev.last, o.last);
            // A handle found on any one area is the handle: a contributor who has some
            // commits from the web UI and some from a laptop should still be taggable.
            if (prev.handle === undefined && o.handle !== undefined)
                prev.handle = o.handle;
        }
        return owners;
    };
    for (let i = 0; i < report.areas.length; i++)
        report.areas[i].owners = accumulateAreaOwners(report.areas[i].label, areaPaths[i], 1);
    for (let i = 0; i < report.modules.length; i++)
        report.modules[i].owners = accumulateAreaOwners(report.modules[i].label, modPaths[i], AFFECTED_WEIGHT);
    report.reviewers = [...ranked.values()]
        .sort((a, b) => b.weighted - a.weighted || b.commits - a.commits || a.name.localeCompare(b.name))
        .slice(0, MAX_REVIEWERS)
        .map(({ weighted: _weighted, ...r }) => r);
}
/** `9d ago`, `3mo ago` — how a comment says when someone was last in here. */
export function sinceLabel(last, now = Date.now()) {
    const days = Math.max(0, Math.round((now - last) / (24 * 60 * 60 * 1000)));
    if (days < 1)
        return "today";
    if (days === 1)
        return "yesterday";
    if (days < 31)
        return `${days}d ago`;
    const months = Math.round(days / 30);
    return months < 24 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}
/** `@handle`, or the bare name when git carries no handle for them. */
export function mention(o) {
    return o.handle !== undefined ? `@${o.handle}` : o.name;
}
/** ISO day, for an exported page that has to stay truthful when opened later. */
export function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
