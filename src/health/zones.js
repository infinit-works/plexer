/**
 * Zone classification (`production`, `script`, `test`, `config`, `generated`, `vendor`)
 * and `.plexerignore` / `.reviewignore` / inline suppression parsing for `plexer health`.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globToRegExp } from "../util/paths.js";

export const VALID_ZONES = new Set(["production", "script", "test", "config", "generated", "vendor"]);
export const SCORED_ZONES = new Set(["production", "script"]);

const VENDOR_SEGMENTS = new Set([
    "node_modules", "vendor", "third_party", "third-party", "external", "packages",
    "wallypackages", "serverpackages", "devpackages", "robloxpackages", "roblox_packages", "luau_packages", "_index",
]);

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
export function classifyZone(relPath, zoneOverrides = {}) {
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

    for (const seg of lowerParts.slice(0, -1)) {
        if (VENDOR_SEGMENTS.has(seg)) return "vendor";
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

function isPathIgnoredByRules(rules, relPath, detectorOrCategory = null) {
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const cat = detectorOrCategory ? String(detectorOrCategory).toLowerCase() : null;
    for (const r of rules) {
        if (r.category && cat && r.category !== cat && !cat.includes(r.category)) {
            continue;
        }
        if (r.category && !cat) continue;
        if (
            norm === r.pattern ||
            norm.startsWith(`${r.pattern}/`) ||
            norm.includes(`/${r.pattern}/`) ||
            (r.regex && r.regex.test(norm))
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Load ignore rules from `.plexerignore`, `.reviewignore`, and `config.excludes`.
 * Supports `<glob>` or `<category>:<glob>`.
 */
export function loadIgnoreRules(rootDir, configExcludes = []) {
    const rules = [];
    const addRawLine = (raw) => {
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
        rules.push({ category, pattern: normPat, regex });
    };

    for (const fname of [".plexerignore", ".reviewignore"]) {
        const p = join(rootDir, fname);
        if (existsSync(p)) {
            try {
                const content = readFileSync(p, "utf8");
                for (const line of content.split(/\r?\n/)) addRawLine(line);
            } catch {
                // Ignore unreadable files
            }
        }
    }

    for (const ex of configExcludes || []) {
        if (typeof ex === "string") addRawLine(ex);
    }

    return {
        rules,
        isIgnored: (relPath, detectorOrCategory = null) =>
            isPathIgnoredByRules(rules, relPath, detectorOrCategory),
    };
}

const INLINE_SUPPRESS_RE = /(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore|--\s*selene:\s*allow)/i;

/**
 * Check if `lineNum` (1-based) or its preceding line has an inline suppression directive.
 */
export function hasInlineSuppression(lines, lineNum, detectorName = "") {
    if (!Array.isArray(lines) || lineNum < 1) return false;
    const candidates = [lines[lineNum - 1], lineNum >= 2 ? lines[lineNum - 2] : null];
    const detLower = String(detectorName || "").toLowerCase();
    for (let candIdx = 0; candIdx < candidates.length; candIdx++) {
        const line = candidates[candIdx];
        if (typeof line !== "string") continue;
        if (candIdx === 1 && !/^\s*(?:\/\/|--|#|\/\*)/.test(line)) continue;
        if (!INLINE_SUPPRESS_RE.test(line)) continue;
        if (
            /--\s*selene:\s*allow/i.test(line) &&
            !/(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore)/i.test(line) &&
            detLower &&
            detLower !== "luau_quality" &&
            detLower !== "language_traps"
        ) continue;
        const specificMatch = /(?:plexer-ignore|plexer:\s*ignore|review:\s*ignore)\s*\[([^\]]+)\]/i.exec(line);
        if (specificMatch && detLower) {
            const tokens = specificMatch[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
            const detParts = detLower.split("_");
            if (tokens.length > 0 && !tokens.some((t) => t === "all" || t === detLower || detParts.includes(t))) continue;
        }
        return true;
    }
    return false;
}
