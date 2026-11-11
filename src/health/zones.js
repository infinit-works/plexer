/**
 * Zone classification (`production`, `script`, `test`, `config`, `generated`, `vendor`)
 * and `.plexerignore` / `.reviewignore` / inline suppression parsing for `plexer health`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globToRegExp } from "../util/paths.js";
import { DETECTOR_CATEGORY } from "./constants.js";

export const VALID_ZONES = new Set(["production", "script", "test", "config", "generated", "vendor"]);
export const SCORED_ZONES = new Set(["production", "script"]);

const VENDOR_SEGMENTS = new Set([
    "node_modules", "vendor", "third_party", "third-party", "external",
    "wallypackages", "serverpackages", "devpackages", "robloxpackages", "roblox_packages", "luau_packages", "_index",
]);

function hasRobloxManifest(rootDir) {
    if (!rootDir || typeof rootDir !== "string") return false;
    return (
        existsSync(join(rootDir, "wally.toml")) ||
        existsSync(join(rootDir, "rotriever.toml")) ||
        existsSync(join(rootDir, "aftman.toml")) ||
        existsSync(join(rootDir, "rokit.toml"))
    );
}

const GENERATED_SEGMENTS = new Set([
    "dist", "build", "out", "coverage", ".next", ".nuxt", "generated", "__generated__", "proto_gen",
]);

const TEST_SEGMENTS = new Set([
    "test", "tests", "__tests__", "spec", "specs", "bench", "benchmarks",
    "fixtures", "__fixtures__", "testdata", "mocks", "__mocks__",
]);

const SCRIPT_SEGMENTS = new Set(["scripts", "script", "tools", "dev", "bin", "ci"]);

const CONFIG_BASENAMES = new Set([
    "default.project.json", "sourcemap.json", "wally.toml", "wally.lock", "rokit.toml", "aftman.toml",
    "selene.toml", "stylua.toml", "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json",
    "pyproject.toml", "setup.py", "conftest.py",
]);

/**
 * Classify a repo-relative path into a zone (`production`, `script`, `test`, `config`, `generated`, `vendor`).
 * User overrides in `config.zones` take highest precedence.
 */
export function classifyZone(relPath, zoneOverrides = {}, rootDir = null) {
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (zoneOverrides && typeof zoneOverrides === "object") {
        if (zoneOverrides[norm] && VALID_ZONES.has(zoneOverrides[norm])) {
            return zoneOverrides[norm];
        }
        for (const [prefix, zone] of Object.entries(zoneOverrides)) {
            if (!VALID_ZONES.has(zone)) continue;
            const cleanPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
            if (norm === cleanPrefix || norm.startsWith(`${cleanPrefix}/`)) {
                return zone;
            }
        }
    }

    const parts = norm.split("/");
    const lowerParts = parts.map((p) => p.toLowerCase());
    const base = lowerParts[lowerParts.length - 1] || "";
    const isLuauPath = base.endsWith(".luau") || base.endsWith(".lua");
    const isRobloxRepo = hasRobloxManifest(rootDir);

    for (let i = 0; i < lowerParts.length - 1; i++) {
        const seg = lowerParts[i];
        const rawSeg = parts[i];
        if (VENDOR_SEGMENTS.has(seg)) return "vendor";
        if (seg === "packages" && (rawSeg === "Packages" || isLuauPath || isRobloxRepo)) {
            return "vendor";
        }
        if (GENERATED_SEGMENTS.has(seg)) return "generated";
    }

    if (
        base.endsWith(".min.js") ||
        base.endsWith(".bundle.js") ||
        base.endsWith(".pb.go") ||
        base.endsWith("_pb2.py") ||
        base.endsWith(".g.dart") ||
        base.endsWith(".generated.ts") ||
        base.endsWith(".generated.luau")
    ) {
        return "generated";
    }

    if (
        CONFIG_BASENAMES.has(base) ||
        base.endsWith(".config.js") ||
        base.endsWith(".config.ts") ||
        base.endsWith(".config.mjs") ||
        base.endsWith(".config.cjs") ||
        base.endsWith(".project.json") ||
        base.endsWith(".d.ts") ||
        base.endsWith(".d.luau")
    ) {
        return "config";
    }

    for (const seg of lowerParts.slice(0, -1)) {
        if (TEST_SEGMENTS.has(seg)) return "test";
    }

    if (
        /\.(test|spec)\.[a-z0-9]+$/i.test(base) ||
        /^test_.*\.[a-z0-9]+$/i.test(base) ||
        /_test\.(go|py|rs|luau|lua)$/i.test(base)
    ) {
        return "test";
    }

    if (lowerParts.length > 1 && SCRIPT_SEGMENTS.has(lowerParts[0])) {
        return "script";
    }

    return "production";
}

/**
 * Distinguish non-unit-test support files inside test/bench directories (`bench/`, `fixtures/`, `mocks/`, `helpers`)
 * so hollow-test checks do not false-positive on benchmarks or test fixtures.
 */
export function isSupportOrBenchFile(relPath) {
    const norm = relPath.replace(/\\/g, "/").toLowerCase();
    const parts = norm.split("/");
    const base = basename(norm);
    for (const seg of parts.slice(0, -1)) {
        if (
            seg === "bench" ||
            seg === "benchmarks" ||
            seg === "fixtures" ||
            seg === "__fixtures__" ||
            seg === "testdata" ||
            seg === "mocks" ||
            seg === "__mocks__" ||
            seg === "helpers" ||
            seg === "test-helpers"
        ) {
            return true;
        }
    }
    return (
        base === "conftest.py" ||
        /^setup\.[a-z0-9]+$/.test(base) ||
        /^helpers?\.[a-z0-9]+$/.test(base) ||
        /\.bench\.[a-z0-9]+$/.test(base)
    );
}

function isPathIgnoredByRules(rules, relPath, detectorOrCategory = null, ledger = null) {
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const cat = detectorOrCategory ? String(detectorOrCategory).toLowerCase().replace(/-/g, "_") : null;
    for (const r of rules) {
        if (r.category && cat && r.category !== cat && DETECTOR_CATEGORY[cat] !== r.category) {
            continue;
        }
        if (r.category && !cat) continue;
        if (
            norm === r.pattern ||
            norm.startsWith(`${r.pattern}/`) ||
            norm.includes(`/${r.pattern}/`) ||
            (r.regex && r.regex.test(norm))
        ) {
            if (ledger && !r.fromConfigExclude && cat) {
                ledger.record(r.category || "all", norm, null, "plexerignore");
            }
            return true;
        }
    }
    return false;
}

export function createSuppressionLedger() {
    const entries = new Map();
    const lineKeys = new Map();
    const fileKeys = new Map();

    return {
        record(detector, file = null, line = null, kind = "inline", isFile = false) {
            const det = String(detector || "all").toLowerCase();
            const normFile = file ? String(file).replace(/\\/g, "/").replace(/^\.\//, "") : "";
            const key = `${det}::${normFile}::${line ?? "*"}::${kind}`;
            if (!entries.has(key)) {
                entries.set(key, { detector: det, file: normFile, line, kind });
            }
            if (normFile) {
                if (line !== null && line !== undefined) {
                    lineKeys.set(`${det}::${normFile}::${line}`, kind);
                }
                if (isFile || line === null || line === undefined) {
                    fileKeys.set(`${det}::${normFile}`, kind);
                }
            }
        },
        matchIssue(issue) {
            if (!issue) return null;
            const det = String(issue.detector || "").toLowerCase();
            const cat = String(issue.category || "").toLowerCase();
            const file = issue.file ? String(issue.file).replace(/\\/g, "/").replace(/^\.\//, "") : "";
            const line = issue.line;
            if (file && line !== null && line !== undefined) {
                for (const d of [det, cat, "all", "*"]) {
                    if (!d) continue;
                    for (const ln of [line, line - 1, line + 1]) {
                        const hit = lineKeys.get(`${d}::${file}::${ln}`);
                        if (hit) return hit;
                    }
                }
            }
            if (file) {
                for (const d of [det, cat, "all", "*"]) {
                    if (!d) continue;
                    const hit = fileKeys.get(`${d}::${file}`);
                    if (hit) return hit;
                }
            }
            return null;
        },
        summary(totalDetectedCount = 0) {
            const ignoredByDetector = {};
            for (const e of entries.values()) {
                ignoredByDetector[e.detector] = (ignoredByDetector[e.detector] || 0) + 1;
            }
            const ignoredCount = entries.size;
            const denom = ignoredCount + Math.max(0, Number(totalDetectedCount) || 0);
            const suppressedPct = denom > 0 ? Math.round((ignoredCount / denom) * 1000) / 10 : 0;
            return {
                ignored_count: ignoredCount,
                suppressed_pct: suppressedPct,
                ignored_by_detector: ignoredByDetector,
            };
        },
    };
}

/**
 * Load ignore rules from `.plexerignore`, `.reviewignore`, and `config.excludes`.
 * Supports `<glob>` or `<category>:<glob>`.
 */
export function loadIgnoreRules(rootDir, configExcludes = [], ledger = null) {
    const rules = [];
    const addRawLine = (raw, fromConfigExclude = false) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;
        let category = null;
        let pattern = line;
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0 && !line.slice(0, colonIdx).includes("/")) {
            category = line.slice(0, colonIdx).trim().toLowerCase();
            pattern = line.slice(colonIdx + 1).trim();
        }
        const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        if (!normPat) return;
        const regex = normPat.includes("*") || normPat.includes("?") ? globToRegExp(normPat) : null;
        rules.push({ category, pattern: normPat, regex, fromConfigExclude });
    };

    for (const fname of [".plexerignore", ".reviewignore"]) {
        const p = join(rootDir, fname);
        if (existsSync(p)) {
            try {
                const content = readFileSync(p, "utf8");
                for (const line of content.split(/\r?\n/)) addRawLine(line, false);
            } catch {
                // Ignore unreadable files
            }
        }
    }

    for (const ex of configExcludes || []) {
        if (typeof ex === "string") addRawLine(ex, true);
    }

    return {
        rules,
        ledger,
        isIgnored: (relPath, detectorOrCategory = null) =>
            isPathIgnoredByRules(rules, relPath, detectorOrCategory, ledger),
    };
}

const INLINE_SUPPRESS_RE = /(?:\/\/|--|#|\/\*)\s*(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore|selene:\s*allow)/i;

/**
 * Check if `lineNum` (1-based), its preceding line, or a file-header `plexer-ignore-file` directive
 * in the first 5 lines has an inline suppression directive.
 */
export function hasInlineSuppression(lines, lineNum, detectorName = "", ledger = null, relPath = null) {
    if (!Array.isArray(lines) || lineNum < 1) return false;
    const candidates = [
        { line: lines[lineNum - 1], lineNo: lineNum, isPreceding: false, fileOnly: false },
        lineNum >= 2
            ? { line: lines[lineNum - 2], lineNo: lineNum - 1, isPreceding: true, fileOnly: false }
            : null,
    ];
    const headerLimit = Math.min(5, lines.length);
    for (let k = 0; k < headerLimit; k++) {
        if (k === lineNum - 1 || k === lineNum - 2) continue;
        if (typeof lines[k] === "string" && /plexer-ignore-file/i.test(lines[k])) {
            candidates.push({ line: lines[k], lineNo: k + 1, isPreceding: false, fileOnly: true });
        }
    }
    const detLower = String(detectorName || "").toLowerCase();
    const detNorm = detLower.replace(/-/g, "_");
    const detCat = DETECTOR_CATEGORY[detNorm] || DETECTOR_CATEGORY[detLower] || null;
    const activeLedger = ledger || lines._suppressionLedger || null;
    const activeFile = relPath || lines._relPath || null;

    for (const cand of candidates) {
        if (!cand || typeof cand.line !== "string") continue;
        const line = cand.line;
        if (cand.isPreceding && !/^\s*(?:\/\/|--|#|\/\*)/.test(line)) continue;
        if (!INLINE_SUPPRESS_RE.test(line)) continue;
        if (
            /--\s*selene:\s*allow/i.test(line) &&
            !/(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore)/i.test(line) &&
            detNorm &&
            detNorm !== "luau_quality" &&
            detNorm !== "language_traps"
        ) continue;

        const bracketMatch = /(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore)(?:-file)?\s*\[([^\]]+)\]/i.exec(line);
        const colonMatch = !bracketMatch
            ? /(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore)(?:-file)?\s*:\s*([A-Za-z0-9_,\s*-]+)/i.exec(line)
            : null;
        const rawSpec = bracketMatch ? bracketMatch[1] : colonMatch ? colonMatch[1] : null;

        if (rawSpec !== null && detNorm) {
            const cleanedSpec = rawSpec.replace(/(?:--|\/\/|#).*$/, "").trim();
            const tokens = cleanedSpec
                .split(/[\s,]+/)
                .map((s) => s.trim().toLowerCase().replace(/-/g, "_"))
                .filter(Boolean);
            const detParts = detNorm.split("_");
            if (
                tokens.length > 0 &&
                !tokens.some(
                    (t) =>
                        t === "all" ||
                        t === "*" ||
                        t === detNorm ||
                        t === detLower ||
                        (detCat && t === detCat) ||
                        detParts.includes(t),
                )
            ) {
                continue;
            }
        }
        if (activeLedger) {
            const isFileDirective = /plexer-ignore-file/i.test(line);
            const recordedLine = isFileDirective ? cand.lineNo : lineNum;
            activeLedger.record(detNorm || "all", activeFile, recordedLine, "inline", isFileDirective);
        }
        return true;
    }
    return false;
}

export function stripCodeStringsAndComments(rawLine, isLuauOrLua = false, isPython = false) {
    if (typeof rawLine !== "string" || !rawLine) return "";
    let s = rawLine;
    if (!isLuauOrLua && !isPython && s.includes("`")) {
        // Strip non-interpolated template text segments first while keeping ${...} expressions intact
        s = s
            .replace(/`(?:\\.|[^`$\\]|\$(?!\{))*`/g, "``")
            .replace(/`(?:\\.|[^`$\\]|\$(?!\{))*\$\{/g, "${")
            .replace(/\}(?:\\.|[^`$\\]|\$(?!\{))*\$\{/g, "} ${")
            .replace(/\}(?:\\.|[^`$\\]|\$(?!\{))*`/g, "}");
    }
    if (isLuauOrLua) {
        s = s
            .replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, " ")
            .replace(/\[(=*)\[[\s\S]*?\]\1\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
            .replace(/--.*$/, "");
    } else if (isPython) {
        s = s
            .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
            .replace(/#.*$/, "");
    } else {
        s = s
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
            .replace(/\/\/.*$/, "")
            .replace(/(?<=[=(,:!&|?[{;]\s*|^)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n])*\/[dgimsuvy]*/g, '""');
    }
    return s;
}

const WORD_TOKEN_RE_CACHE = new Map();
const MAX_WORD_TOKEN_CACHE = 8192;

export function hasWordToken(line, token) {
    if (!line || !token) return false;
    const str = typeof line === "string" ? line : String(line);
    const tok = typeof token === "string" ? token : String(token);
    if (!str.includes(tok)) return false;
    let re = WORD_TOKEN_RE_CACHE.get(tok);
    if (!re) {
        if (WORD_TOKEN_RE_CACHE.size >= MAX_WORD_TOKEN_CACHE) {
            WORD_TOKEN_RE_CACHE.clear();
        }
        const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        re = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
        WORD_TOKEN_RE_CACHE.set(tok, re);
    }
    return re.test(str);
}

/**
 * Compute updated Luau block nesting depth for `rawLine`, ignoring strings, comments,
 * and inline `if <cond> then <a> else <b>` conditional expressions (which have no `end`).
 */
export function stepLuauBlockDepth(depthOrLine, lineOrDepth = 0) {
    const depth = typeof depthOrLine === "number" ? depthOrLine : Number(lineOrDepth) || 0;
    const rawLine = typeof depthOrLine === "string" ? depthOrLine : String(lineOrDepth || "");
    const cleaned = stripCodeStringsAndComments(rawLine, true, false).trim();
    if (!cleaned) return depth;
    const withoutInlineIf = cleaned.replace(
        /([=(,{[\-+*/%^<>~]|==|~=|<=|>=|\.\.|\b(?:return|and|or|not)\b)\s*if\b(?:(?!\b(?:end|return|local)\b).)*?\bthen\b(?:(?!\b(?:end|return|local)\b).)*?\belse\b/g,
        "$1 ",
    );
    const opens = (withoutInlineIf.match(/\b(?:function|then|do|repeat)\b/g) || []).length;
    const elseifs = (withoutInlineIf.match(/\belseif\b/g) || []).length;
    const closes = (withoutInlineIf.match(/\b(?:end|until)\b/g) || []).length;
    return Math.max(0, depth + Math.max(0, opens - elseifs) - closes);
}

export class UnionFind {
    constructor(size = 0) {
        this.parent = new Map();
        this.rank = new Map();
        for (let i = 0; i < size; i++) {
            this.parent.set(i, i);
            this.rank.set(i, 0);
        }
    }
    makeSet(x) {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
            this.rank.set(x, 0);
        }
    }
    find(x) {
        if (!this.parent.has(x)) {
            this.makeSet(x);
            return x;
        }
        let cur = x;
        while (this.parent.get(cur) !== cur) {
            const p = this.parent.get(cur);
            const gp = this.parent.get(p);
            this.parent.set(cur, gp);
            cur = gp;
        }
        return cur;
    }
    union(a, b) {
        let ra = this.find(a);
        let rb = this.find(b);
        if (ra === rb) return false;
        const rankA = this.rank.get(ra) || 0;
        const rankB = this.rank.get(rb) || 0;
        if (rankA < rankB) {
            const tmp = ra;
            ra = rb;
            rb = tmp;
        }
        this.parent.set(rb, ra);
        if (rankA === rankB) this.rank.set(ra, rankA + 1);
        return true;
    }
    components() {
        const byRoot = new Map();
        for (const x of this.parent.keys()) {
            const r = this.find(x);
            let list = byRoot.get(r);
            if (!list) {
                list = [];
                byRoot.set(r, list);
            }
            list.push(x);
        }
        return [...byRoot.values()];
    }
    groups() {
        return this.components();
    }
}
