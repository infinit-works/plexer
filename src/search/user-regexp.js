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

function hasOverlappingBranches(branches) {
    if (branches.length < 2) return false;
    if (new Set(branches).size < branches.length) return true;
    const leadingLiterals = new Set();
    for (const raw of branches) {
        const b = raw.replace(/^(?:\(\?:|\(\?!|\(\?=|\(\?<[!=]|\(\?<[^>]+>|\()+/, "");
        if (!b) return true;
        if (b[0] === "." || b[0] === "[") return true;
        if (b[0] === "\\") {
            const esc = b[1] ?? "";
            if (/[dDwWsSpP]/.test(esc)) return true;
            if (leadingLiterals.has(esc)) return true;
            leadingLiterals.add(esc);
            continue;
        }
        const ch = b[0];
        if (leadingLiterals.has(ch)) return true;
        leadingLiterals.add(ch);
    }
    return false;
}

/**
 * Scan `pattern` for nested repeating quantifiers (e.g. `(a+)+`, `([a-z]*)*`,
 * `(a|b+)+`) or excessive adjacent wildcards that cause exponential NFA states.
 */
export function hasCatastrophicBacktrackingRisk(pattern) {
    const groupStack = [];
    let inCharClass = false;
    let i = 0;

    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "\\") {
            i += 2;
            continue;
        }
        if (inCharClass) {
            if (ch === "]") inCharClass = false;
            i += 1;
            continue;
        }
        if (ch === "[") {
            inCharClass = true;
            i += 1;
            continue;
        }
        if (ch === "(") {
            groupStack.push({ hasInnerRepeat: false, branches: [""], currentBranchStart: i + 1 });
            i += 1;
            continue;
        }
        if (ch === "|" && groupStack.length > 0) {
            const top = groupStack[groupStack.length - 1];
            top.branches[top.branches.length - 1] = pattern.slice(top.currentBranchStart, i);
            top.branches.push("");
            top.currentBranchStart = i + 1;
            i += 1;
            continue;
        }
        if (ch === ")") {
            const popped = groupStack.pop();
            const q = readQuantifierAt(pattern, i + 1);
            if (popped) {
                popped.branches[popped.branches.length - 1] = pattern.slice(popped.currentBranchStart, i);
                if (q && q.repeated) {
                    if (popped.hasInnerRepeat) return true;
                    const nonEmpty = popped.branches
                        .map((b) => b.replace(/^(?:\?:|\?!|\?=|\?<[!=]|\?<[^>]+>)/, "").trim())
                        .filter(Boolean);
                    if (hasOverlappingBranches(nonEmpty)) {
                        return true;
                    }
                    if (groupStack.length > 0) {
                        groupStack[groupStack.length - 1].hasInnerRepeat = true;
                    }
                } else if (popped.hasInnerRepeat && groupStack.length > 0) {
                    groupStack[groupStack.length - 1].hasInnerRepeat = true;
                }
            }
            i = q ? q.nextIdx : i + 1;
            continue;
        }

        const q = readQuantifierAt(pattern, i);
        if (q) {
            if (q.repeated && groupStack.length > 0) {
                groupStack[groupStack.length - 1].hasInnerRepeat = true;
            }
            i = q.nextIdx;
            continue;
        }
        i += 1;
    }

    if (/(?:\.\*){3,}|(?:\.\+){3,}/.test(pattern)) {
        return true;
    }
    return false;
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
