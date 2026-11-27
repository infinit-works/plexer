/**
 * What a PR touched, read from git: changed files plus the *line ranges* inside
 * them, which is what turns a diff into graph seeds (an enclosing-symbol lookup
 * per changed line, see `blast.js`).
 *
 * Git is shelled out to rather than parsed from a library because the CI job
 * this feeds already has git — and `--unified=0` gives exactly the post-image
 * line ranges we need, with no context lines to subtract back out.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { git } from "../util/git.js";
export { git };
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Text kept per hunk, and per file. A regenerated lockfile is one hunk of 40,000
 * lines: the ranges still matter (they seed the graph), the text does not, and it
 * would otherwise ride along in `--format json` and in every exported page. */
const MAX_HUNK_LINES = 24;
const MAX_FILE_LINES = 200;
/** True when `ref` names something git can resolve — checked before diffing so
 * an unknown `--base` fails with a caller-facing message, not a git stack. */
export function refExists(root, ref) {
    if (!ref || ref.startsWith("-"))
        return false;
    return git(resolve(root), ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]) !== null;
}
/**
 * Changed files + post-image line ranges.
 *
 * `<base>...HEAD` (three dots) diffs against the MERGE BASE, not the tip of the
 * base branch — the difference matters on every PR whose base branch moved after
 * it was cut: two-dot would attribute other people's merges to this PR and
 * inflate the blast radius with files the author never touched.
 *
 * With no `base` this reports the working tree against HEAD (the local
 * "what am I about to push" case), falling back to the last commit when the
 * tree is clean — so the command answers something useful when run by hand,
 * and CI passes `--base` for the real PR range.
 */
/** Resolve the merge-base commit (or direct ref) used as pre-image for `git show`. */
export function resolveBaseRef(root, base) {
    if (base === undefined || !base || base.startsWith("-"))
        return null;
    const dir = resolve(root);
    return git(dir, ["merge-base", "--end-of-options", base, "HEAD"])?.trim() || base;
}

/** Read a file's pre-image contents at `baseRef` via `git show <base>:./<path>`, returning null if absent. */
export function readPreImageFile(root, baseRef, filePath) {
    if (!root || !baseRef || baseRef.startsWith("-") || !filePath || filePath.startsWith("-"))
        return null;
    const normPath = filePath.replace(/^\/+/, "");
    if (!normPath || normPath.split("/").includes(".."))
        return null;
    return git(resolve(root), ["show", "--end-of-options", `${baseRef}:./${normPath}`]);
}

/** Batch-read multiple pre-image files at `baseRef` via a single `git cat-file --batch` call. */
export function readPreImageFilesBatch(root, baseRef, filePaths) {
    const out = new Map();
    if (!root || !baseRef || baseRef.startsWith("-") || !Array.isArray(filePaths) || filePaths.length === 0)
        return out;
    const requested = [];
    const seen = new Set();
    for (const filePath of filePaths) {
        if (!filePath || filePath.startsWith("-") || seen.has(filePath))
            continue;
        const normPath = filePath.replace(/^\/+/, "");
        if (!normPath || normPath.split("/").includes("..") || /[\0\r\n]/.test(normPath))
            continue;
        seen.add(filePath);
        requested.push({ filePath, spec: `${baseRef}:./${normPath}` });
    }
    if (requested.length === 0)
        return out;
    const res = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "cat-file", "--batch"], {
        cwd: resolve(root),
        input: `${requested.map((r) => r.spec).join("\n")}\n`,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
    });
    if (res.error || res.status !== 0 || !Buffer.isBuffer(res.stdout))
        return out;
    const buf = res.stdout;
    let pos = 0;
    for (let idx = 0; idx < requested.length && pos < buf.length; idx++) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0)
            break;
        const header = buf.subarray(pos, nl).toString("utf8");
        pos = nl + 1;
        if (header.endsWith(" missing"))
            continue;
        const parts = header.split(" ");
        if (parts.length < 3)
            continue;
        const type = parts[1];
        const size = Number(parts[2]);
        if (!Number.isFinite(size) || size < 0 || pos + size > buf.length)
            break;
        if (type === "blob")
            out.set(requested[idx].filePath, buf.subarray(pos, pos + size).toString("utf8"));
        pos += size + 1;
    }
    return out;
}

export function changedFiles(root, base) {
    const dir = resolve(root);
    if (base !== undefined) {
        if (!base || base.startsWith("-"))
            return null;
        const basis = `${base}...HEAD`;
        const baseRef = resolveBaseRef(dir, base);
        const args = [basis];
        const files = diffFiles(dir, args);
        return files === null ? null : { basis, baseRef, files };
    }
    const working = diffFiles(dir, ["HEAD"]);
    if (working === null)
        return null;
    if (working.length > 0)
        return { basis: "working tree vs HEAD", baseRef: "HEAD", files: working };
    const last = diffFiles(dir, ["HEAD~1...HEAD"]);
    if (last === null)
        return { basis: "working tree vs HEAD", baseRef: "HEAD", files: [] };
    return { basis: "HEAD~1...HEAD", baseRef: "HEAD~1", files: last };
}
/** Both git passes for one range: name-status (statuses, renames) then hunks. */
function diffFiles(dir, range) {
    const status = git(dir, ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", "-z", "--end-of-options", ...range, "--"]);
    if (status === null)
        return null;
    const files = parseNameStatus(status);
    if (files.length === 0)
        return files;
    const patch = git(dir, [
        "diff",
        "--relative",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--find-renames",
        "--end-of-options",
        ...range,
        "--",
    ]);
    if (patch !== null)
        applyHunks(files, patch);
    return files;
}
/**
 * `--name-status -z` output: NUL-separated fields, where a rename spends THREE
 * fields (`R096`, old, new) and everything else spends two. Splitting on NUL and
 * walking with a cursor is the only way to read it — a line-oriented parse
 * silently pairs a rename's old path with the next file's status.
 */
function parseNameStatus(out) {
    const fields = out.split("\0").filter((f) => f !== "");
    const files = [];
    for (let i = 0; i < fields.length;) {
        const code = fields[i++];
        if (code.startsWith("R") || code.startsWith("C")) {
            const oldPath = fields[i++];
            const path = fields[i++];
            if (path === undefined)
                break;
            files.push({ path, status: "renamed", oldPath, ranges: [], oldRanges: [], hunks: [] });
            continue;
        }
        const path = fields[i++];
        if (path === undefined)
            break;
        if (code.startsWith("A"))
            files.push({ path, status: "added", ranges: [], oldRanges: [], hunks: [] });
        else if (code.startsWith("D"))
            files.push({ path, status: "deleted", ranges: [], oldRanges: [], hunks: [] });
        else
            files.push({ path, status: "modified", ranges: [], oldRanges: [], hunks: [] });
    }
    return files;
}
function openDiffHunk(line, current) {
    if (!current) return null;
    const m = HUNK_RE.exec(line);
    if (!m) return null;
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const start = Number(m[3]);
    // Pure deletions (+N,0) anchor at clamped >= 1 and carry non-enumerable `pureDeletion: true`
    // so `seedsForFile` only matches strictly interior symbols.
    const count = m[4] === undefined ? 1 : Number(m[4]);
    const range = count === 0
        ? { start: Math.max(1, start), end: Math.max(1, start) }
        : { start, end: start + count - 1 };
    if (count === 0) {
        Object.defineProperty(range, "pureDeletion", { value: true, enumerable: false, configurable: true });
        Object.defineProperty(range, "rawStart", { value: start, enumerable: false, configurable: true });
    }
    if (oldCount > 0) {
        current.oldRanges ??= [];
        current.oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
    }
    const hunk = { ...range, lines: [], dropped: 0 };
    if (current.status !== "deleted") current.ranges.push(range);
    current.hunks.push(hunk);
    return { hunk, next: start };
}

/** Attach each hunk's post-image & pre-image ranges — and its text — to its file. */
export function applyHunks(files, patch) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const byOldPath = new Map(files.map((f) => [f.oldPath ?? f.path, f]));
    let current;
    let prevMinusPath;
    let hunk;
    let next = 0;
    let kept = 0;
    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            current = undefined;
            prevMinusPath = undefined;
            hunk = undefined;
        } else if (!hunk && line.startsWith("--- ")) {
            const raw = line.slice(4);
            prevMinusPath = raw === "/dev/null" ? undefined : stripPrefix(raw);
        } else if (!hunk && line.startsWith("+++ ")) {
            const raw = line.slice(4);
            current = raw === "/dev/null" ? (prevMinusPath ? byOldPath.get(prevMinusPath) : undefined) : byPath.get(stripPrefix(raw));
            hunk = undefined;
            kept = 0;
        } else if (line.startsWith("@@")) {
            const opened = openDiffHunk(line, current);
            hunk = opened?.hunk;
            if (opened) next = opened.next;
        } else if (hunk && line.startsWith("+")) {
            if (pushLine(hunk, { n: next++, sign: "+", text: line.slice(1) }, kept < MAX_FILE_LINES))
                kept++;
        } else if (hunk && line.startsWith("-")) {
            if (pushLine(hunk, { n: null, sign: "-", text: line.slice(1) }, kept < MAX_FILE_LINES))
                kept++;
        }
    }
}
function pushLine(hunk, line, withinFile) {
    if (!withinFile || hunk.lines.length >= MAX_HUNK_LINES) {
        hunk.dropped += 1;
        return false;
    }
    hunk.lines.push(line);
    return true;
}
/** `b/src/x.ts` → `src/x.ts`, minus any trailing tab-separated timestamp. */
function stripPrefix(raw) {
    const untabbed = raw.split("\t")[0].replace(/^"(.*)"$/, "$1");
    return untabbed.replace(/^[abciwo]\//, "");
}
