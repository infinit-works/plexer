/**
 * Safe user regular-expression compiler (`compileSafeUserRegex`) and git-ignored
 * zero-hit diagnostic helper (`findIgnoredMatchDirs`).
 *
 * Prevents catastrophic backtracking (ReDoS) patterns such as `(a+)+` or
 * `([a-z]*)*` from freezing the CLI or the stdio MCP server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../blast/diff.js";

const MAX_REGEX_PATTERN_LENGTH = 512;

/**
 * Detect whether a regex token at `idx` is a repetition quantifier (`*`, `+`,
 * or `{m,n}` where the upper bound is > 1).
 */
function readQuantifierAt(pattern, idx) {
    const ch = pattern[idx];
    if (ch === "*" || ch === "+") {
        const mod = pattern[idx + 1] === "?" || pattern[idx + 1] === "+";
        return { repeated: true, unbounded: true, nextIdx: idx + (mod ? 2 : 1) };
    }
    if (ch === "?") {
        const mod = pattern[idx + 1] === "?" || pattern[idx + 1] === "+";
        return { repeated: false, unbounded: false, nextIdx: idx + (mod ? 2 : 1) };
    }
    if (ch === "{") {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(idx));
        if (m) {
            const min = Number(m[1]);
            const max = m[2] === undefined ? min : m[2] === "" ? Infinity : Number(m[2]);
            const mod = pattern[idx + m[0].length] === "?" || pattern[idx + m[0].length] === "+";
            return {
                repeated: max > 1,
                unbounded: max === Infinity || max >= 10,
                nextIdx: idx + m[0].length + (mod ? 1 : 0),
            };
        }
    }
    return null;
}

const MAX_CODE_POINT = 0x10ffff;
const DIGIT_RANGES = [[48, 57]];
const WORD_RANGES = [[48, 57], [65, 90], [95, 95], [97, 122]];
const SPACE_RANGES = [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]];
const ALL_RANGES = [[0, MAX_CODE_POINT]];

function mergeRanges(ranges) {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [sorted[0].slice()];
    for (let i = 1; i < sorted.length; i++) {
        const prev = out[out.length - 1];
        const [lo, hi] = sorted[i];
        if (lo <= prev[1] + 1) {
            if (hi > prev[1]) prev[1] = hi;
        } else {
            out.push([lo, hi]);
        }
    }
    return out;
}

function complementRanges(ranges) {
    const merged = mergeRanges(ranges);
    const out = [];
    let cur = 0;
    for (const [lo, hi] of merged) {
        if (cur < lo) out.push([cur, lo - 1]);
        cur = hi + 1;
    }
    if (cur <= MAX_CODE_POINT) out.push([cur, MAX_CODE_POINT]);
    return out;
}

function rangesIntersect(a, b) {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i][1] < b[j][0]) i++;
        else if (b[j][1] < a[i][0]) j++;
        else return true;
    }
    return false;
}

function decodeEscapeRanges(pattern, slashIdx) {
    const esc = pattern[slashIdx + 1];
    if (esc === undefined) return { ranges: null, single: null, nextIdx: slashIdx + 1 };
    const simpleMap = { n: 10, r: 13, t: 9, f: 12, v: 11 };
    if (esc in simpleMap) {
        const cp = simpleMap[esc];
        return { ranges: [[cp, cp]], single: cp, nextIdx: slashIdx + 2 };
    }
    if (esc === "0" && !/[0-7]/.test(pattern[slashIdx + 2] ?? "")) {
        return { ranges: [[0, 0]], single: 0, nextIdx: slashIdx + 2 };
    }
    if (esc === "d") return { ranges: DIGIT_RANGES, single: null, nextIdx: slashIdx + 2 };
    if (esc === "D") return { ranges: complementRanges(DIGIT_RANGES), single: null, nextIdx: slashIdx + 2 };
    if (esc === "w") return { ranges: WORD_RANGES, single: null, nextIdx: slashIdx + 2 };
    if (esc === "W") return { ranges: complementRanges(WORD_RANGES), single: null, nextIdx: slashIdx + 2 };
    if (esc === "s") return { ranges: SPACE_RANGES, single: null, nextIdx: slashIdx + 2 };
    if (esc === "S") return { ranges: complementRanges(SPACE_RANGES), single: null, nextIdx: slashIdx + 2 };
    if (esc === "x" && /^[0-9a-fA-F]{2}/.test(pattern.slice(slashIdx + 2, slashIdx + 4))) {
        const cp = parseInt(pattern.slice(slashIdx + 2, slashIdx + 4), 16);
        return { ranges: [[cp, cp]], single: cp, nextIdx: slashIdx + 4 };
    }
    if (esc === "u" && /^[0-9a-fA-F]{4}/.test(pattern.slice(slashIdx + 2, slashIdx + 6))) {
        const cp = parseInt(pattern.slice(slashIdx + 2, slashIdx + 6), 16);
        return { ranges: [[cp, cp]], single: cp, nextIdx: slashIdx + 6 };
    }
    if (/[pPbBck0-9]/.test(esc) || esc === "u") {
        return { ranges: null, single: null, nextIdx: slashIdx + 2 };
    }
    const cp = esc.codePointAt(0);
    return { ranges: [[cp, cp]], single: cp, nextIdx: slashIdx + 1 + String.fromCodePoint(cp).length };
}

function parseCharClassRanges(pattern, openIdx) {
    let i = openIdx + 1;
    const negated = pattern[i] === "^";
    if (negated) i++;
    const ranges = [];
    const readAtom = () => {
        if (i >= pattern.length) return null;
        if (pattern[i] === "\\") {
            const dec = decodeEscapeRanges(pattern, i);
            i = dec.nextIdx;
            return dec;
        }
        const ch = String.fromCodePoint(pattern.codePointAt(i));
        const cp = ch.codePointAt(0);
        i += ch.length;
        return { ranges: [[cp, cp]], single: cp };
    };
    while (i < pattern.length) {
        if (pattern[i] === "]" && (ranges.length > 0 || i > openIdx + (negated ? 2 : 1))) {
            const merged = mergeRanges(ranges);
            return { ranges: negated ? complementRanges(merged) : merged, nextIdx: i + 1 };
        }
        const first = readAtom();
        if (!first || !first.ranges) return { ranges: null, nextIdx: pattern.length };
        if (first.single !== null && pattern[i] === "-" && i + 1 < pattern.length && pattern[i + 1] !== "]") {
            i++;
            const second = readAtom();
            if (!second || second.single === null || second.single < first.single) {
                return { ranges: null, nextIdx: pattern.length };
            }
            ranges.push([first.single, second.single]);
        } else {
            ranges.push(...first.ranges);
        }
    }
    return { ranges: null, nextIdx: pattern.length };
}

function unwrapBranchPrefix(raw) {
    let b = raw;
    while (b.startsWith("(")) {
        let stripped = b.replace(/^(?:\(\?:|\()/, "");
        if (stripped === b || /^[?!<=]/.test(stripped)) return null;
        // Do not unwrap a group whose own closing paren has a top-level `|` inside.
        let depth = 1;
        let inClass = false;
        let hasTopPipe = false;
        for (let i = 0; i < stripped.length && depth > 0; i++) {
            const c = stripped[i];
            if (c === "\\") { i++; continue; }
            if (inClass) { if (c === "]") inClass = false; continue; }
            if (c === "[") { inClass = true; continue; }
            if (c === "(") depth++;
            else if (c === ")") depth--;
            else if (c === "|" && depth === 1) hasTopPipe = true;
        }
        if (hasTopPipe) return null;
        b = stripped;
    }
    return b;
}

function leadingFirstSet(raw) {
    const b = unwrapBranchPrefix(raw);
    if (!b) return ALL_RANGES;
    const ch = b[0];
    if (ch === "." || ch === "^" || ch === "$") return ALL_RANGES;
    let ranges = null;
    let nextIdx = 0;
    if (ch === "[") {
        const parsed = parseCharClassRanges(b, 0);
        ranges = parsed.ranges;
        nextIdx = parsed.nextIdx;
    } else if (ch === "\\") {
        const dec = decodeEscapeRanges(b, 0);
        ranges = dec.ranges;
        nextIdx = dec.nextIdx;
    } else {
        const fullCh = String.fromCodePoint(b.codePointAt(0));
        const cp = fullCh.codePointAt(0);
        ranges = [[cp, cp]];
        nextIdx = fullCh.length;
    }
    if (!ranges) return ALL_RANGES;
    const rest = b.slice(nextIdx);
    if (/^(?:\?|\*|\{0(?:,|\}))/.test(rest)) return ALL_RANGES;
    return ranges;
}

function hasOverlappingBranches(branches) {
    if (branches.length < 2) return false;
    if (new Set(branches).size < branches.length) return true;
    let seenRanges = [];
    for (const raw of branches) {
        const first = leadingFirstSet(raw);
        if (rangesIntersect(seenRanges, first)) {
            return true;
        }
        seenRanges = mergeRanges([...seenRanges, ...first]);
    }
    return false;
}

function checkClosedGroupBacktracking(groupStack, pattern, i) {
    const popped = groupStack.pop();
    const q = readQuantifierAt(pattern, i + 1);
    if (popped) {
        popped.branches[popped.branches.length - 1] = pattern.slice(popped.currentBranchStart, i);
        if (q && q.repeated) {
            if (popped.hasInnerRepeat) return { risk: true, nextIdx: 0 };
            const nonEmpty = popped.branches
                .map((b) => b.replace(/^(?:\?:|\?!|\?=|\?<[!=]|\?<[^>]+>)/, "").trim())
                .filter(Boolean);
            if (hasOverlappingBranches(nonEmpty)) return { risk: true, nextIdx: 0 };
            if (groupStack.length > 0) groupStack[groupStack.length - 1].hasInnerRepeat = true;
        } else if (popped.hasInnerRepeat && groupStack.length > 0) {
            groupStack[groupStack.length - 1].hasInnerRepeat = true;
        }
    }
    return { risk: false, nextIdx: q ? q.nextIdx : i + 1 };
}

/**
 * Scan `pattern` for nested repeating quantifiers (e.g. `(a+)+`, `([a-z]*)*`,
 * `(a|b+)+`) or excessive adjacent wildcards that cause exponential NFA states.
 */
function hasCatastrophicBacktrackingRisk(pattern) {
    const groupStack = [];
    let inCharClass = false;
    let i = 0;

    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "\\") {
            i += 2;
        } else if (inCharClass) {
            if (ch === "]") inCharClass = false;
            i += 1;
        } else if (ch === "[") {
            inCharClass = true;
            i += 1;
        } else if (ch === "(") {
            groupStack.push({ hasInnerRepeat: false, branches: [""], currentBranchStart: i + 1 });
            i += 1;
        } else if (ch === "|" && groupStack.length > 0) {
            const top = groupStack[groupStack.length - 1];
            top.branches[top.branches.length - 1] = pattern.slice(top.currentBranchStart, i);
            top.branches.push("");
            top.currentBranchStart = i + 1;
            i += 1;
        } else if (ch === ")") {
            const closed = checkClosedGroupBacktracking(groupStack, pattern, i);
            if (closed.risk) return true;
            i = closed.nextIdx;
        } else {
            const q = readQuantifierAt(pattern, i);
            if (q && q.repeated && groupStack.length > 0) groupStack[groupStack.length - 1].hasInnerRepeat = true;
            i = q ? q.nextIdx : i + 1;
        }
    }

    return /(?:\.\*){3,}|(?:\.\+){3,}/.test(pattern);
}

/**
 * Compile a user-supplied regex safely, rejecting overlong or ReDoS-vulnerable
 * patterns before they can stall the process.
 */
export function compileSafeUserRegex(pattern, flags = "") {
    if (typeof pattern !== "string") {
        throw new SyntaxError("regular expression pattern must be a string");
    }
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
        throw new SyntaxError(
            `regular expression pattern exceeds maximum length (${pattern.length} > ${MAX_REGEX_PATTERN_LENGTH} chars)`,
        );
    }
    if (hasCatastrophicBacktrackingRisk(pattern)) {
        throw new SyntaxError(
            `unsafe regular expression "${pattern}" (nested repeating quantifier risks catastrophic backtracking) — simplify the pattern or use --fixed`,
        );
    }
    return new RegExp(pattern, flags);
}

const IGNORED_TEXT_EXT = /\.(?:[cm]?[jt]sx?|pyi?|luau?|go|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|cs|dart|gd|ex|exs|erl|gleam|sql|sh|md|json|ya?ml|toml)$/i;

/**
 * Check whether a zero-hit grep pattern matches files inside git-ignored
 * directories (e.g. `dist/`, `build/`, `vendor/`), returning the matching
 * top-level directory prefixes.
 */
export function findIgnoredMatchDirs(root, matcher, maxFiles = 60) {
    if (!root || typeof matcher !== "function") return [];
    const out = git(root, ["ls-files", "-o", "-i", "--exclude-standard"]);
    if (!out) return [];
    const rawFiles = out
        .split("\n")
        .map((s) => s.trim())
        .filter((f) => f && !f.startsWith("plexer/") && !f.startsWith(".git/") && !f.startsWith("node_modules/") && IGNORED_TEXT_EXT.test(f));

    const hitDirs = new Set();
    const checkedPerDir = new Map();
    let totalChecked = 0;

    for (const rel of rawFiles) {
        if (totalChecked >= maxFiles || hitDirs.size >= 5) break;
        const slash = rel.indexOf("/");
        const dirKey = slash >= 0 ? `${rel.slice(0, slash + 1)}` : rel;
        if (hitDirs.has(dirKey)) continue;
        const dirCount = checkedPerDir.get(dirKey) || 0;
        if (dirCount >= 8) continue;
        checkedPerDir.set(dirKey, dirCount + 1);
        totalChecked += 1;
        try {
            const text = readFileSync(join(root, rel), "utf8");
            if (text.length > 512_000 || text.includes("\0")) continue;
            if (matcher(text)) {
                hitDirs.add(dirKey);
            }
        } catch {
            /* unreadable or binary ignored file */
        }
    }
    return [...hitDirs].sort();
}
