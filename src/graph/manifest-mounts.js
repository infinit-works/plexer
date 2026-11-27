/**
 * Manifest-driven local dependency auto-inclusion (`discoverManifestMounts`).
 *
 * Extracts explicitly referenced local directories and files from project manifests
 * (Rojo `*.project.json`, `.luaurc`, `tsconfig`/`jsconfig`, `package.json`,
 * `pnpm-workspace.yaml`, `Cargo.toml`, `go.mod`, `pyproject.toml`) so `walkDir`
 * indexes mounted dependencies inside `SKIP_DIRS` (e.g. `vendor/flux`, `vendor/z`,
 * `vendor/f3x`) without pulling in unreferenced vendor/build dumps or gitignored trees.
 *
 * Note: Must NOT import `../util/state.js` (which imports this module).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { registerGraphCacheClearer } from "../context/graph-store.js";
import { isWithinRoot } from "../util/fs.js";
import { parseJsonc } from "../util/jsonc.js";
import { isLexicallyWithin, pathUnderPrefix, toPosixPath } from "../util/paths.js";

const MAX_FILES_PER_MOUNT = 500;
const MAX_FILES_PER_ALIAS_MOUNT = 250;
const MAX_TOTAL_AUTO_MOUNT_FILES = 1500;
const MAX_COUNT_DEPTH = 12;
const MAX_MOUNT_CACHE_ENTRIES = 32;

const NEVER_AUTO_INCLUDE_SEGMENTS = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    "venv",
    ".venv",
    "coverage",
    ".cache",
    "plexer",
    ".plexer",
]);

const SKIP_DIR_NAMES = new Set([
    "node_modules",
    "dist",
    "build",
    "_build",
    "out",
    "target",
    "vendor",
    "coverage",
    "__pycache__",
    "venv",
]);

const DEP_DIR_SEGMENTS = new Set([
    "vendor",
    "third_party",
    "third-party",
    "external",
    "submodules",
    "packages",
    "serverpackages",
    "devpackages",
    "robloxpackages",
    "roblox_packages",
    "luau_packages",
    "_index",
]);

const SOURCE_FILE_EXT_RE = /\.(?:luau?|tsx?|jsx?|mts|cts|mjs|cjs|rs|go|pyi?|java|kt|kts|swift|php|rb|c|cc|cpp|cxx|h|hh|hpp|hxx|h\+\+|c\+\+|inl|ipp|tpp|ixx|cs|scala|sc|ex|exs|sol|ml|mli|zig|dart|cljc?|cljs|bb|nix|vue|svelte|astro|sh|bash|zsh|sql|tf|tfvars|hcl|proto|graphql|gql|m|mm|hs|gleam|cu|cuh)$/i;

const mountCache = new Map();
registerGraphCacheClearer(() => mountCache.clear());

export function clearManifestMountCache() {
    mountCache.clear();
}

function readJsonSafe(absPath, useJsonc = false) {
    try {
        const raw = readFileSync(absPath, "utf8");
        return useJsonc ? parseJsonc(raw) : JSON.parse(raw);
    }
    catch {
        return null;
    }
}

function readTextSafe(absPath) {
    try {
        return readFileSync(absPath, "utf8");
    }
    catch {
        return null;
    }
}

function statSafe(absPath) {
    try {
        return statSync(absPath);
    }
    catch {
        return null;
    }
}

function globToRegexBody(glob) {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    out += "(?:.*/)?";
                    i += 2;
                }
                else {
                    out += ".*";
                    i += 1;
                }
            }
            else {
                out += "[^/]*";
            }
        }
        else if (ch === "?") {
            out += "[^/]";
        }
        else if ("\\^$.|+()[]{}".includes(ch)) {
            out += `\\${ch}`;
        }
        else {
            out += ch;
        }
    }
    return out;
}

function parseRootGitignore(absRoot) {
    const raw = readTextSafe(join(absRoot, ".gitignore"));
    if (!raw)
        return [];
    const rules = [];
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.replace(/(?<!\\)[ \t]+$/, "");
        if (!line || line.startsWith("#"))
            continue;
        let body = line;
        let negated = false;
        if (body.startsWith("!")) {
            negated = true;
            body = body.slice(1);
        }
        else if (body.startsWith("\\#") || body.startsWith("\\!")) {
            body = body.slice(1);
        }
        body = body.replace(/^\\ /, " ").trim();
        if (!body)
            continue;
        const dirOnly = body.endsWith("/");
        if (dirOnly) {
            body = body.slice(0, -1);
            if (!body)
                continue;
        }
        const anchored = body.startsWith("/");
        if (anchored)
            body = body.slice(1);
        const hasSlash = anchored || body.includes("/");
        try {
            rules.push({ negated, hasSlash, dirOnly, re: new RegExp(`^${globToRegexBody(body)}$`) });
        }
        catch {
            /* skip invalid glob */
        }
    }
    return rules;
}

function isRelPathGitignored(relPosix, rules) {
    if (!rules || rules.length === 0 || !relPosix)
        return false;
    const parts = relPosix.split("/").filter(Boolean);
    let ignored = false;
    for (let i = 0; i < parts.length; i++) {
        const prefix = parts.slice(0, i + 1).join("/");
        const name = parts[i];
        const isLast = i === parts.length - 1;
        for (const r of rules) {
            if (r.dirOnly && isLast) {
                // Prefix directories still match directory rules; final path also matches if it's a dir
                // which is true for directory mounts, and harmless for file checks under ignored dirs.
            }
            const matched = r.hasSlash ? r.re.test(prefix) : r.re.test(name);
            if (matched)
                ignored = !r.negated;
        }
    }
    return ignored;
}

function hasDeniedSegment(relPosix) {
    return relPosix.split("/").some((seg) => NEVER_AUTO_INCLUDE_SEGMENTS.has(seg));
}

function crossesSkippedSegment(relPosix) {
    const segs = relPosix.split("/").filter(Boolean);
    return segs.some((seg) => seg.startsWith(".") || SKIP_DIR_NAMES.has(seg));
}

function hasDependencySegment(relPosix) {
    const segs = relPosix.split("/").filter(Boolean);
    return segs.some((seg) => DEP_DIR_SEGMENTS.has(seg.toLowerCase()));
}

function resolveContainedTarget(absRoot, baseDirAbs, rawTarget) {
    if (typeof rawTarget !== "string")
        return null;
    const cleaned = rawTarget.trim();
    if (!cleaned || cleaned.includes("${") || (/^[a-z]+:\/\//i.test(cleaned) && !cleaned.startsWith("file://")))
        return null;
    const localSpec = cleaned.startsWith("file://") ? cleaned.slice(7) : cleaned;
    const absTarget = resolve(baseDirAbs, localSpec);
    if (!isLexicallyWithin(absRoot, absTarget, { allowEqual: false }))
        return null;
    if (!isWithinRoot(absTarget, absRoot, { allowEqual: false }))
        return null;
    const rel = toPosixPath(relative(absRoot, absTarget)).replace(/\/+$/, "");
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel))
        return null;
    const normRel = posix.normalize(rel).replace(/^\.\//, "");
    if (!normRel || normRel === "." || normRel.startsWith(".."))
        return null;
    if (hasDeniedSegment(normRel))
        return null;
    return { absTarget, relPosix: normRel };
}

function countMountFilesBounded(absTarget, limit) {
    const st = statSafe(absTarget);
    if (!st)
        return 0;
    if (st.isFile())
        return 1;
    if (!st.isDirectory())
        return 0;
    let count = 0;
    const visit = (dir, depth) => {
        if (count > limit || depth > MAX_COUNT_DEPTH)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (count > limit)
                return;
            if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name) || NEVER_AUTO_INCLUDE_SEGMENTS.has(entry.name))
                continue;
            if (entry.isDirectory()) {
                visit(join(dir, entry.name), depth + 1);
            }
            else if (entry.isFile()) {
                count += 1;
            }
        }
    };
    visit(absTarget, 0);
    return count;
}

function recordManifestFile(state, absPath) {
    const res = resolve(absPath);
    if (!existsSync(res))
        return;
    const st = statSafe(res);
    if (!st?.isFile())
        return;
    state.manifestFiles.add(res);
    state.manifestMtimes.set(res, `${st.size}:${st.mtimeMs}`);
}

function addCandidate(state, absRoot, baseDirAbs, rawTarget, opts = {}) {
    const contained = resolveContainedTarget(absRoot, baseDirAbs, rawTarget);
    if (!contained)
        return null;
    const st = statSafe(contained.absTarget);
    if (!st)
        return null;
    const isFile = st.isFile();
    if (!isFile && !st.isDirectory())
        return null;
    if (isFile && opts.requireSourceExt && !SOURCE_FILE_EXT_RE.test(contained.relPosix))
        return null;
    if (opts.checkGitignore && isRelPathGitignored(contained.relPosix, state.gitignoreRules))
        return null;

    if (opts.isRojo) {
        state.rojoMountTargets.add(contained.relPosix);
    }
    const crossedSkip = crossesSkippedSegment(contained.relPosix);
    const isDep = Boolean(opts.isDep || hasDependencySegment(contained.relPosix));
    if (isDep) {
        state.dependencyTargets.add(contained.relPosix);
    }
    if (crossedSkip) {
        state.candidates.set(contained.relPosix, {
            relPosix: contained.relPosix,
            absTarget: contained.absTarget,
            isFile,
            limit: opts.limit ?? MAX_FILES_PER_MOUNT,
            priority: opts.priority ?? 10,
        });
    }
    return contained;
}

function walkRojoJsonTree(treeNode, projDirAbs, absRoot, state, depth = 0) {
    if (!treeNode || typeof treeNode !== "object" || depth > 16)
        return;
    if (typeof treeNode.$path === "string") {
        const contained = resolveContainedTarget(absRoot, projDirAbs, treeNode.$path);
        if (contained) {
            const st = statSafe(contained.absTarget);
            if (st?.isDirectory()) {
                const subProj = join(contained.absTarget, "default.project.json");
                const visitedKey = resolve(subProj);
                if (existsSync(subProj) && !state.visitedRojoProjects.has(visitedKey)) {
                    state.visitedRojoProjects.add(visitedKey);
                    recordManifestFile(state, subProj);
                    const subData = readJsonSafe(subProj, false);
                    const beforeCount = state.rojoMountTargets.size + state.candidates.size;
                    if (subData?.tree && typeof subData.tree === "object") {
                        walkRojoJsonTree(subData.tree, contained.absTarget, absRoot, state, depth + 1);
                    }
                    const afterCount = state.rojoMountTargets.size + state.candidates.size;
                    if (afterCount === beforeCount) {
                        addCandidate(state, absRoot, projDirAbs, treeNode.$path, {
                            isRojo: true,
                            isDep: hasDependencySegment(contained.relPosix),
                            requireSourceExt: true,
                            priority: 1,
                        });
                    }
                }
                else {
                    addCandidate(state, absRoot, projDirAbs, treeNode.$path, {
                        isRojo: true,
                        isDep: hasDependencySegment(contained.relPosix),
                        requireSourceExt: true,
                        priority: 1,
                    });
                }
            }
            else if (st?.isFile()) {
                addCandidate(state, absRoot, projDirAbs, treeNode.$path, {
                    isRojo: true,
                    isDep: hasDependencySegment(contained.relPosix),
                    requireSourceExt: true,
                    priority: 1,
                });
            }
        }
    }
    for (const [k, v] of Object.entries(treeNode)) {
        if (k.startsWith("$") || !v || typeof v !== "object")
            continue;
        walkRojoJsonTree(v, projDirAbs, absRoot, state, depth + 1);
    }
}

function extractRojoProjectMounts(absRoot, state) {
    let entries;
    try {
        entries = readdirSync(absRoot, { withFileTypes: true });
    }
    catch {
        return;
    }
    const projectFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".project.json"))
        .map((e) => e.name)
        .sort((a, b) => (a === "default.project.json" ? -1 : b === "default.project.json" ? 1 : a.localeCompare(b)));
    if (projectFiles.length === 0)
        return;
    state.hasRojoProject = true;
    for (const name of projectFiles) {
        const absProj = join(absRoot, name);
        state.visitedRojoProjects.add(resolve(absProj));
        recordManifestFile(state, absProj);
        const parsed = readJsonSafe(absProj, false);
        if (parsed?.tree && typeof parsed.tree === "object") {
            walkRojoJsonTree(parsed.tree, absRoot, absRoot, state, 0);
        }
    }
}

function extractLuaurcMounts(absRoot, state) {
    const rcPath = join(absRoot, ".luaurc");
    if (!existsSync(rcPath))
        return;
    recordManifestFile(state, rcPath);
    const parsed = readJsonSafe(rcPath, true);
    if (!parsed?.aliases || typeof parsed.aliases !== "object")
        return;
    for (const target of Object.values(parsed.aliases)) {
        if (typeof target !== "string")
            continue;
        addCandidate(state, absRoot, absRoot, target, {
            limit: MAX_FILES_PER_ALIAS_MOUNT,
            checkGitignore: true,
            isDep: hasDependencySegment(target),
            priority: 4,
        });
    }
}

function stripTrailingGlobWildcard(raw) {
    return String(raw || "")
        .replace(/\/\*\*?\/?$/, "")
        .replace(/\/\*[^/]*$/, "")
        .replace(/\*.*$/, "")
        .replace(/\/+$/, "");
}

function extractTsConfigMounts(absRoot, state) {
    const names = ["tsconfig.json", "tsconfig.base.json", "tsconfig.app.json", "jsconfig.json", ".jsconfig"];
    const queue = names.map((n) => join(absRoot, n)).filter((p) => existsSync(p));
    const visited = new Set();
    let depth = 0;
    while (queue.length > 0 && depth < 16) {
        const cfgPath = resolve(queue.shift());
        if (visited.has(cfgPath))
            continue;
        visited.add(cfgPath);
        depth += 1;
        recordManifestFile(state, cfgPath);
        const parsed = readJsonSafe(cfgPath, true);
        if (!parsed || typeof parsed !== "object")
            continue;
        const cfgDir = dirname(cfgPath);
        const baseUrl = typeof parsed.compilerOptions?.baseUrl === "string"
            ? resolve(cfgDir, parsed.compilerOptions.baseUrl)
            : cfgDir;
        const pathsObj = parsed.compilerOptions?.paths;
        if (pathsObj && typeof pathsObj === "object") {
            for (const targets of Object.values(pathsObj)) {
                if (!Array.isArray(targets))
                    continue;
                for (const t of targets) {
                    const clean = stripTrailingGlobWildcard(t);
                    if (!clean || clean === ".")
                        continue;
                    addCandidate(state, absRoot, baseUrl, clean, {
                        checkGitignore: true,
                        requireSourceExt: true,
                        priority: 3,
                    });
                }
            }
        }
        if (Array.isArray(parsed.references)) {
            for (const ref of parsed.references) {
                if (typeof ref?.path !== "string")
                    continue;
                addCandidate(state, absRoot, cfgDir, ref.path, {
                    checkGitignore: true,
                    priority: 3,
                });
                const refAbs = resolve(cfgDir, ref.path);
                const refCfg = statSafe(refAbs)?.isFile() ? refAbs : join(refAbs, "tsconfig.json");
                if (existsSync(refCfg) && isLexicallyWithin(absRoot, refCfg, { allowEqual: false })) {
                    queue.push(refCfg);
                }
            }
        }
        const exts = typeof parsed.extends === "string"
            ? [parsed.extends]
            : Array.isArray(parsed.extends)
                ? parsed.extends.filter((x) => typeof x === "string")
                : [];
        for (const ext of exts) {
            if (!ext.startsWith(".") && !ext.startsWith("/"))
                continue;
            const cand = resolve(cfgDir, ext);
            for (const c of [cand, `${cand}.json`, join(cand, "tsconfig.json")]) {
                if (existsSync(c) && statSafe(c)?.isFile() && isLexicallyWithin(absRoot, c, { allowEqual: false })) {
                    queue.push(c);
                    break;
                }
            }
        }
    }
}

function expandOneLevelGlobTargets(absRoot, patternRaw) {
    const norm = toPosixPath(String(patternRaw || "").trim()).replace(/^\.\//, "").replace(/\/+$/, "");
    if (!norm || norm.startsWith("!") || norm.startsWith(".."))
        return [];
    if (!norm.includes("*"))
        return [norm];
    const m = /^([^?*]+)\/\*\*?$/.exec(norm);
    if (!m)
        return [];
    const baseRel = m[1];
    if (!crossesSkippedSegment(baseRel) || hasDeniedSegment(baseRel))
        return [];
    const baseAbs = resolve(absRoot, baseRel);
    if (!isLexicallyWithin(absRoot, baseAbs, { allowEqual: false }))
        return [];
    let entries;
    try {
        entries = readdirSync(baseAbs, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NEVER_AUTO_INCLUDE_SEGMENTS.has(e.name))
        .map((e) => `${baseRel}/${e.name}`);
}

function collectLeafStrings(val, out) {
    if (typeof val === "string") {
        out.push(val);
        return;
    }
    if (!val || typeof val !== "object")
        return;
    const list = Array.isArray(val) ? val : Object.values(val);
    for (const item of list)
        collectLeafStrings(item, out);
}

function extractJsPackageMounts(absRoot, state) {
    const pkgPath = join(absRoot, "package.json");
    if (existsSync(pkgPath)) {
        recordManifestFile(state, pkgPath);
        const pkg = readJsonSafe(pkgPath, false);
        if (pkg && typeof pkg === "object") {
            const wsList = Array.isArray(pkg.workspaces)
                ? pkg.workspaces
                : Array.isArray(pkg.workspaces?.packages)
                    ? pkg.workspaces.packages
                    : [];
            for (const wsPat of wsList) {
                for (const target of expandOneLevelGlobTargets(absRoot, wsPat)) {
                    addCandidate(state, absRoot, absRoot, target, { checkGitignore: true, priority: 2 });
                }
            }
            if (pkg.imports && typeof pkg.imports === "object") {
                const impLeaves = [];
                collectLeafStrings(pkg.imports, impLeaves);
                for (const leaf of impLeaves) {
                    const clean = stripTrailingGlobWildcard(leaf);
                    if (clean && clean !== ".") {
                        addCandidate(state, absRoot, absRoot, clean, {
                            checkGitignore: true,
                            requireSourceExt: true,
                            priority: 3,
                        });
                    }
                }
            }
            for (const secName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
                const sec = pkg[secName];
                if (!sec || typeof sec !== "object")
                    continue;
                for (const ver of Object.values(sec)) {
                    if (typeof ver !== "string")
                        continue;
                    const localM = /^(?:file|link|portal):(.+)$/.exec(ver.trim());
                    if (localM) {
                        addCandidate(state, absRoot, absRoot, localM[1], {
                            checkGitignore: true,
                            isDep: true,
                            priority: 2,
                        });
                    }
                }
            }
        }
    }
    const pnpmPath = join(absRoot, "pnpm-workspace.yaml");
    if (existsSync(pnpmPath)) {
        recordManifestFile(state, pnpmPath);
        const raw = readTextSafe(pnpmPath);
        if (raw) {
            const lines = raw.split(/\r?\n/);
            const idx = lines.findIndex((l) => /^packages\s*:/.test(l.trim()));
            if (idx !== -1) {
                for (let i = idx + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.trim() === "")
                        continue;
                    if (!/^\s*-\s*/.test(line))
                        break;
                    const val = line.replace(/^\s*-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
                    for (const target of expandOneLevelGlobTargets(absRoot, val)) {
                        addCandidate(state, absRoot, absRoot, target, { checkGitignore: true, priority: 2 });
                    }
                }
            }
        }
    }
}

function parseTomlArrayFromSection(rawText, sectionName, key) {
    const lines = rawText.split(/\r?\n/);
    const secLines = [];
    let inSection = false;
    for (const line of lines) {
        const clean = line.replace(/#.*$/, "");
        const hdr = /^\s*\[([^\]]+)\]\s*$/.exec(clean);
        if (hdr) {
            inSection = hdr[1].trim() === sectionName;
            continue;
        }
        if (inSection)
            secLines.push(clean);
    }
    if (secLines.length === 0)
        return [];
    const secBody = secLines.join("\n");
    const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(secBody);
    if (!m)
        return [];
    const out = [];
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
        if (q[1])
            out.push(q[1]);
    }
    return out;
}

function extractCargoMounts(absRoot, state) {
    const cargoPath = join(absRoot, "Cargo.toml");
    if (!existsSync(cargoPath))
        return;
    recordManifestFile(state, cargoPath);
    const raw = readTextSafe(cargoPath);
    if (!raw)
        return;
    for (const memberPat of parseTomlArrayFromSection(raw, "workspace", "members")) {
        for (const target of expandOneLevelGlobTargets(absRoot, memberPat)) {
            addCandidate(state, absRoot, absRoot, target, { checkGitignore: true, priority: 2 });
        }
    }
    const clean = raw.replace(/#.*$/gm, "");
    for (const m of clean.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)) {
        addCandidate(state, absRoot, absRoot, m[1], {
            checkGitignore: true,
            isDep: true,
            priority: 2,
        });
    }
}

function extractGoModMounts(absRoot, state) {
    const goModPath = join(absRoot, "go.mod");
    if (!existsSync(goModPath))
        return;
    recordManifestFile(state, goModPath);
    const raw = readTextSafe(goModPath);
    if (!raw)
        return;
    for (const m of raw.matchAll(/=>\s*(\.{1,2}\/[^\s/][^\s]*|\.{1,2})(?:\s|$)/gm)) {
        addCandidate(state, absRoot, absRoot, m[1], {
            checkGitignore: true,
            isDep: true,
            priority: 2,
        });
    }
    const modulesTxt = join(absRoot, "vendor", "modules.txt");
    if (existsSync(modulesTxt) && !isRelPathGitignored("vendor", state.gitignoreRules)) {
        const vendorCount = countMountFilesBounded(join(absRoot, "vendor"), MAX_FILES_PER_MOUNT);
        if (vendorCount > 0 && vendorCount <= MAX_FILES_PER_MOUNT) {
            addCandidate(state, absRoot, absRoot, "vendor", {
                isDep: true,
                priority: 2,
            });
        }
        else if (vendorCount > MAX_FILES_PER_MOUNT) {
            const directReqs = [];
            let inRequireBlock = false;
            for (const line of raw.split(/\r?\n/)) {
                const t = line.trim();
                if (!t || t.startsWith("//"))
                    continue;
                if (/^require\s*\($/.test(t)) {
                    inRequireBlock = true;
                    continue;
                }
                if (inRequireBlock && t === ")") {
                    inRequireBlock = false;
                    continue;
                }
                if (inRequireBlock) {
                    if (!t.includes("// indirect")) {
                        const mod = t.split(/\s+/)[0];
                        if (mod)
                            directReqs.push(mod);
                    }
                }
                else {
                    const single = /^require\s+(\S+)\s+\S+(.*)$/.exec(t);
                    if (single && !single[2].includes("// indirect")) {
                        directReqs.push(single[1]);
                    }
                }
            }
            for (const modPath of directReqs) {
                addCandidate(state, absRoot, absRoot, `vendor/${modPath}`, {
                    checkGitignore: true,
                    isDep: true,
                    priority: 3,
                });
            }
        }
    }
}

function extractPyprojectMounts(absRoot, state) {
    const pyPath = join(absRoot, "pyproject.toml");
    if (!existsSync(pyPath))
        return;
    recordManifestFile(state, pyPath);
    const raw = readTextSafe(pyPath);
    if (!raw)
        return;
    const clean = raw.replace(/#.*$/gm, "");
    for (const m of clean.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)) {
        addCandidate(state, absRoot, absRoot, m[1], {
            checkGitignore: true,
            isDep: true,
            priority: 2,
        });
    }
    for (const m of clean.matchAll(/@\s*file:\/\/([^\s"']+)/g)) {
        addCandidate(state, absRoot, absRoot, m[1], {
            checkGitignore: true,
            isDep: true,
            priority: 2,
        });
    }
    for (const key of ["packages", "where", "mypy_path", "extraPaths"]) {
        const re = new RegExp(`^\\s*${key}\\s*=\\s*(\\[[\\s\\S]*?\\]|["'][^"']+["'])`, "gm");
        for (const m of clean.matchAll(re)) {
            for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
                addCandidate(state, absRoot, absRoot, q[1], {
                    checkGitignore: true,
                    priority: 3,
                });
            }
        }
    }
}

function finalizeDiscoveredMounts(state) {
    const ordered = [...state.candidates.values()].sort(
        (a, b) => a.priority - b.priority || (a.relPosix < b.relPosix ? -1 : a.relPosix > b.relPosix ? 1 : 0),
    );
    const includePrefixes = [];
    const exactFiles = [];
    let totalBudgetUsed = 0;

    for (const cand of ordered) {
        if (!cand.isFile && includePrefixes.some((p) => pathUnderPrefix(cand.relPosix, p))) {
            continue;
        }
        const remaining = MAX_TOTAL_AUTO_MOUNT_FILES - totalBudgetUsed;
        if (remaining <= 0)
            break;
        const cap = Math.min(cand.limit, remaining);
        const count = countMountFilesBounded(cand.absTarget, cap);
        if (count === 0 || count > cap)
            continue;
        totalBudgetUsed += count;
        if (cand.isFile)
            exactFiles.push(cand.relPosix);
        else
            includePrefixes.push(cand.relPosix);
    }

    includePrefixes.sort();
    exactFiles.sort();
    const dependencyPrefixes = [...state.dependencyTargets].sort();
    const rojoMountPrefixes = [...state.rojoMountTargets].sort();
    const manifestFiles = [...state.manifestFiles].sort();
    return {
        includePrefixes,
        exactFiles,
        dependencyPrefixes,
        rojoMountPrefixes,
        manifestFiles,
        hasRojoProject: state.hasRojoProject,
    };
}

function isMountCacheFresh(entry) {
    if (!entry)
        return false;
    for (const [absPath, stamp] of entry.mtimes) {
        const st = statSafe(absPath);
        const cur = st?.isFile() ? `${st.size}:${st.mtimeMs}` : "missing";
        if (cur !== stamp)
            return false;
    }
    return true;
}

const WATCHED_ROOT_MANIFESTS = [
    ".gitignore",
    ".luaurc",
    "default.project.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "jsconfig.json",
    ".jsconfig",
    "package.json",
    "pnpm-workspace.yaml",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
];

/**
 * Discover explicitly mounted local dependencies and source paths referenced in repo manifests.
 */
export function discoverManifestMounts(rootDir, opts = {}) {
    if (!rootDir || typeof rootDir !== "string") {
        return {
            includePrefixes: [],
            exactFiles: [],
            dependencyPrefixes: [],
            rojoMountPrefixes: [],
            manifestFiles: [],
            hasRojoProject: false,
        };
    }
    const absRoot = resolve(rootDir);
    if (!opts.noCache) {
        const cached = mountCache.get(absRoot);
        if (isMountCacheFresh(cached)) {
            mountCache.delete(absRoot);
            mountCache.set(absRoot, cached);
            return cached.result;
        }
    }

    const gitignoreRules = parseRootGitignore(absRoot);
    const state = {
        gitignoreRules,
        candidates: new Map(),
        dependencyTargets: new Set(),
        rojoMountTargets: new Set(),
        manifestFiles: new Set(),
        manifestMtimes: new Map(),
        visitedRojoProjects: new Set(),
        hasRojoProject: false,
    };
    for (const rootName of WATCHED_ROOT_MANIFESTS) {
        const p = resolve(join(absRoot, rootName));
        const st = statSafe(p);
        state.manifestMtimes.set(p, st?.isFile() ? `${st.size}:${st.mtimeMs}` : "missing");
    }

    extractRojoProjectMounts(absRoot, state);
    extractLuaurcMounts(absRoot, state);
    extractTsConfigMounts(absRoot, state);
    extractJsPackageMounts(absRoot, state);
    extractCargoMounts(absRoot, state);
    extractGoModMounts(absRoot, state);
    extractPyprojectMounts(absRoot, state);

    const result = finalizeDiscoveredMounts(state);
    if (!opts.noCache) {
        if (mountCache.size >= MAX_MOUNT_CACHE_ENTRIES) {
            const oldest = mountCache.keys().next().value;
            if (oldest !== undefined)
                mountCache.delete(oldest);
        }
        mountCache.set(absRoot, { result, mtimes: state.manifestMtimes });
    }
    return result;
}
