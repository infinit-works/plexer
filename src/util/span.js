import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readSourceFile } from "./source.js";

export const MAX_SOURCE_READ_BYTES = 10 * 1024 * 1024;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `L12-L34` → `{ start: 12, end: 34 }`. */
export function spanRange(span) {
    if (!span)
        return null;
    const m = /^L(\d+)(?:-L(\d+))?$/.exec(span);
    if (!m)
        return null;
    const start = Number(m[1]);
    return { start, end: m[2] === undefined ? start : Number(m[2]) };
}

/** Fast start-line extraction for `L<start>-L<end>` spans (returns `fallback` on miss). */
export function spanStart(span, fallback = 0) {
    if (!span || span[0] !== "L")
        return fallback;
    const n = parseInt(span.slice(1), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse `<path>:L<start>-L<end>` pointer into `{ path, start, end }`. */
export function parseSpan(pointer) {
    const m = /^(.*):L(\d+)-L(\d+)$/.exec(pointer);
    if (!m)
        return null;
    return { path: m[1], start: Number(m[2]), end: Number(m[3]) };
}

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A symbol name, matched as a whole word — `export` must not hit `exportViz`. */
export const wordRe = (name) => new RegExp(`\\b${escapeRegExp(name)}\\b`);

/** Build word-boundary regex needles for a symbol name and its bare suffix (`Class.method` -> `method`). */
export function needlesForName(name) {
    if (!name)
        return [];
    const out = [wordRe(name)];
    const sep = Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), name.lastIndexOf("#"));
    if (sep >= 0 && sep + 1 < name.length) {
        const bare = name.slice(sep + 1);
        if (bare.length >= 2)
            out.push(wordRe(bare));
    }
    return out;
}

/**
 * The first line inside a span that mentions one of `needles`, with its 1-based line number.
 */
export function referenceLine(path, span, needles, read) {
    const range = spanRange(span);
    const lines = read(path);
    if (!range || !lines)
        return null;
    const end = Math.min(lines.length, range.end);
    for (let idx = Math.max(0, range.start - 1); idx < end; idx++) {
        const text = lines[idx];
        if (needles.some((re) => re.test(text)))
            return { n: idx + 1, text };
    }
    return null;
}

const HEADER_CONTEXT_RE = /\.(?:command|on|connect|handle)\s*\(|:(?:Connect|Once)\s*\(|^\s*(?:export\s+|local\s+|async\s+|pub\s+)*(?:function|fn|def)\b|^\s*[A-Za-z_$][\w$.]*\s*=\s*(?:async\s+)?function\b|^\s*name\s*=\s*["'][^"']+["']/;

/**
 * Up to `maxMatches` lines inside `span` mentioning one of `needles`, skipping
 * any line ranges in `excludeRanges` (e.g. a target symbol's own definition span
 * or nested named caller spans when quoting a file-level caller).
 */
export function referenceLines(path, span, needles, read, opts = {}) {
    const range = spanRange(span);
    const lines = read(path);
    if (!range || !lines || !needles?.length)
        return [];
    const maxMatches = opts.maxMatches ?? 6;
    const excludeRanges = opts.excludeRanges ?? [];
    const contextRadius = opts.contextLines ?? 0;
    const isExcluded = (lineNo) => excludeRanges.some((r) => lineNo >= r.start && lineNo <= r.end);
    const end = Math.min(lines.length, range.end);
    const start = Math.max(1, range.start);
    const matched = [];
    const importMatches = [];
    for (let lineNo = start; lineNo <= end; lineNo++) {
        if (isExcluded(lineNo))
            continue;
        const text = lines[lineNo - 1];
        if (needles.some((re) => re.test(text))) {
            if (/^\s*import\b.*\bfrom\b/.test(text)) {
                importMatches.push({ n: lineNo, text });
                continue;
            }
            matched.push({ n: lineNo, text });
            if (matched.length >= maxMatches)
                break;
        }
    }
    if (matched.length === 0 && importMatches.length > 0) {
        matched.push(...importMatches.slice(0, maxMatches));
    }
    if ((contextRadius <= 0 && !opts.includeHeaderContext) || matched.length === 0)
        return matched;
    return matched.map((m) => {
        const winStart = Math.max(start, m.n - Math.max(0, contextRadius));
        const winEnd = Math.min(end, m.n + Math.max(0, contextRadius));
        const windowLines = [];
        let headerLine = null;
        // Look up to 110 lines above winStart for an enclosing command/event builder header
        const searchTop = opts.allowAboveSpan ? Math.max(1, m.n - 110) : Math.max(start, m.n - 75);
        const startIndent = (lines[start - 1] ?? "").match(/^\s*/)?.[0]?.length ?? 0;
        for (let k = winStart - 1; k >= searchTop; k--) {
            if (isExcluded(k))
                break;
            const candidate = lines[k - 1];
            if (k < start) {
                const candIndent = candidate.match(/^\s*/)?.[0]?.length ?? 0;
                if (candIndent <= startIndent && /^\s*name\s*=\s*["'][^"']+["']/.test(candidate)) {
                    headerLine = { n: k, text: candidate };
                    windowLines.push(headerLine);
                    if (k + 1 < winStart)
                        windowLines.push({ n: 0, text: `… (lines L${k + 1}-L${winStart - 1} omitted)` });
                    break;
                }
                continue;
            }
            if (k === start && /^\s*run\s*=\s*function\b/.test(candidate))
                continue;
            if (HEADER_CONTEXT_RE.test(candidate)) {
                headerLine = { n: k, text: candidate };
                windowLines.push(headerLine);
                if (k + 1 < winStart)
                    windowLines.push({ n: 0, text: `… (lines L${k + 1}-L${winStart - 1} omitted)` });
                break;
            }
        }
        if (contextRadius > 0 || windowLines.length > 0) {
            for (let k = winStart; k <= winEnd; k++) {
                if (k !== m.n && isExcluded(k))
                    continue;
                windowLines.push({ n: k, text: lines[k - 1] });
            }
            return { ...m, ...(headerLine ? { header: headerLine } : {}), window: windowLines };
        }
        return headerLine ? { ...m, header: headerLine } : m;
    });
}

const SENSITIVE_BASENAME_RE = /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$|\.(?:pem|key|p12|pfx)$/i;

/** True when a repo-relative path contains a dot-prefixed segment (`.git`, `.env`, `.aws`) or private key file. */
export function isSensitiveOrDotPath(relPath) {
    const raw = String(relPath ?? "").replace(/^\.\//, "");
    if (!raw || raw.startsWith("."))
        return true;
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0)
        return true;
    if (parts.some((seg) => seg.startsWith(".")))
        return true;
    return SENSITIVE_BASENAME_RE.test(parts[parts.length - 1]);
}

/**
 * Resolve and validate a repo-relative path against `absRoot` and `realRoot`,
 * rejecting path traversal, symlink escapes, sensitive/dot paths, non-regular files,
 * and files exceeding `maxBytes`.
 */
export function resolveSafeRepoFile(absRoot, realRoot, relPath, opts = {}) {
    if (!absRoot || !realRoot || typeof relPath !== "string" || !relPath)
        return null;
    try {
        const absFile = resolve(absRoot, relPath);
        const rel = relative(absRoot, absFile);
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || (!opts.allowDot && isSensitiveOrDotPath(rel)))
            return null;
        if (opts.noSymlinks && lstatSync(absFile).isSymbolicLink())
            return null;
        const realFile = realpathSync(absFile);
        const realRel = relative(realRoot, realFile);
        if (!realRel || realRel.startsWith("..") || isAbsolute(realRel) || (!opts.allowDot && isSensitiveOrDotPath(realRel)))
            return null;
        const st = statSync(realFile);
        const maxBytes = opts.maxBytes ?? MAX_SOURCE_READ_BYTES;
        if (!st.isFile() || (maxBytes > 0 && st.size > maxBytes))
            return null;
        return { absFile, realFile, rel, realRel, stat: st };
    }
    catch (err) {
        if (err && typeof err === "object" && "code" in err && /^(?:ENOENT|EISDIR|ENOTDIR|EACCES|EPERM|EINVAL|ELOOP|ENAMETOOLONG)$/.test(String(err.code)))
            return null;
        throw err;
    }
}

/** Read each file once via `readSourceFile` (UTF-8 / UTF-16LE aware), returning split lines or null. */
export function fileReader(root) {
    const cache = new Map();
    const absRoot = root !== undefined ? resolve(root) : null;
    let realRoot = absRoot;
    if (absRoot) {
        try {
            realRoot = realpathSync(absRoot);
        }
        catch {
            /* keep absRoot fallback */
        }
    }
    return (path) => {
        if (!absRoot || !realRoot || typeof path !== "string" || !path)
            return null;
        const hit = cache.get(path);
        if (hit !== undefined)
            return hit;
        let lines = null;
        try {
            const safe = resolveSafeRepoFile(absRoot, realRoot, path);
            if (!safe) {
                cache.set(path, null);
                return null;
            }
            const raw = readSourceFile(safe.realFile);
            lines = raw !== null ? raw.split(/\r?\n/) : null;
        }
        catch {
            lines = null;
        }
        cache.set(path, lines);
        return lines;
    };
}
