/**
 * Safe mechanical auto-fixers (`plexer health autofix`) and import-rewriting file/directory move
 * (`plexer health move <src> <dst> [--dry-run]`) with JS/TS, Python, and Luau/Roblox support.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { toPosixPath as toPosix } from "../util/paths.js";
import { resolveSafeRepoFile, spanRange } from "../util/span.js";
import { remapMovedIssuePaths } from "./queue.js";
import { detectGitContext } from "./state.js";
import {
    hasWordToken,
    SCORED_ZONES,
    stepLuauBlockDepth,
    stripCodeStringsAndComments,
} from "./zones.js";

export const AVAILABLE_FIXERS = [
    "luau-task-scheduler",
    "luau-strict-header",
    "luau-instance-new-parent",
    "luau-hoist-getservice",
    "unused-imports",
    "debug-logs",
    "unreferenced-exports",
];

function countIdentifierUsesOutsideLine(lines, lineIdx, ident, isPy = false, isLuau = false) {
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (i === lineIdx) continue;
        const l = lines[i].trim();
        if (l.startsWith("//") || l.startsWith("--") || (isPy && l.startsWith("#"))) continue;
        const stripped = stripCodeStringsAndComments(lines[i], isLuau, isPy);
        if (wordRe.test(stripped)) count += 1;
    }
    return count;
}

function scanExistingTopLuauServices(lines) {
    const existingTopServices = new Set();
    let scanDepth = 0;
    for (const l of lines) {
        const trimmedScan = l.trim();
        if (!trimmedScan.startsWith("--")) {
            const codeOnly = stripCodeStringsAndComments(trimmedScan, true, false);
            const hasFn = /\bfunction\b/.test(codeOnly);
            if (scanDepth === 0 && !hasFn) {
                const m = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game:GetService\(\s*["']([A-Za-z0-9_]+)["']\s*\)/.exec(
                    trimmedScan,
                );
                if (m) existingTopServices.add(m[2]);
            }
            scanDepth = stepLuauBlockDepth(scanDepth, trimmedScan);
        }
    }
    return existingTopServices;
}

function isEntrypointForAutofix(relPath) {
    const norm = relPath.replace(/\\/g, "/");
    const base = basename(norm);
    return (
        /(?:^|\/)(?:index|main|cli|mod|init|app|server|client)\.[a-z0-9]+$/i.test(norm) ||
        /\.(?:server|client)\.(?:luau|lua)$/i.test(base) ||
        /^bin\//i.test(norm)
    );
}

function hasMultiDeclaratorExport(rawLine) {
    const cleaned = stripCodeStringsAndComments(rawLine, false, false).trim();
    if (!/^export\s+(?:const|let|var)\b/.test(cleaned)) return false;
    let depth = 0;
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) return true;
    }
    return false;
}

function createStrippedFileTextReader(rootDir) {
    const absRoot = rootDir ? resolve(rootDir) : null;
    let realRoot = absRoot;
    if (absRoot) {
        try {
            realRoot = realpathSync(absRoot);
        } catch {
            /* fallback */
        }
    }
    const strippedTextCache = new Map();
    return (relPath) => {
        if (!absRoot || !realRoot) return "";
        if (strippedTextCache.has(relPath)) return strippedTextCache.get(relPath);
        const safe = resolveSafeRepoFile(absRoot, realRoot, relPath, { noSymlinks: true });
        const raw = safe ? readFileSync(safe.realFile, "utf8") : "";
        const ext = extname(relPath).toLowerCase();
        const isLuau = ext === ".luau" || ext === ".lua";
        const isPy = ext === ".py";
        const stripped = raw
            .split(/\r?\n/)
            .map((l) => stripCodeStringsAndComments(l, isLuau, isPy))
            .join("\n");
        strippedTextCache.set(relPath, stripped);
        return stripped;
    };
}

function collectUnreferencedExportLinesByFile(graph, rootDir = null) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const incomingCrossFile = new Map();
    const importersByPath = new Map();
    for (const edge of graph.edges || []) {
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        if (!src || !tgt || src.path === tgt.path) continue;
        incomingCrossFile.set(tgt.id, (incomingCrossFile.get(tgt.id) || 0) + 1);
        if (edge.relation === "IMPORTS" && src.path && tgt.path) {
            let set = importersByPath.get(tgt.path);
            if (!set) {
                set = new Set();
                importersByPath.set(tgt.path, set);
            }
            set.add(src.path);
        }
    }

    const getStrippedFileText = createStrippedFileTextReader(rootDir);
    const linesByFile = new Map();
    const referencedFileLines = new Set();

    for (const n of graph.nodes) {
        if (n.kind === "file" || !n.exported || !n.path) continue;
        if (isEntrypointForAutofix(n.path)) continue;
        const range = spanRange(n.span);
        if (!range) continue;

        if ((incomingCrossFile.get(n.id) || 0) > 0) {
            referencedFileLines.add(`${n.path}::${range.start}`);
            continue;
        }

        const importers = importersByPath.get(n.path);
        if (importers && importers.size > 0 && rootDir) {
            const shortName = n.name.includes(".") ? n.name.split(".").pop() : n.name;
            let referencedInImporter = false;
            for (const impPath of importers) {
                const impText = getStrippedFileText(impPath);
                if (
                    hasWordToken(impText, shortName) ||
                    /\bimport\s*\*\s*as\b/.test(impText) ||
                    /\bexport\s*\*\s*from\b/.test(impText)
                ) {
                    referencedInImporter = true;
                    break;
                }
            }
            if (referencedInImporter) {
                referencedFileLines.add(`${n.path}::${range.start}`);
                continue;
            }
        }

        let set = linesByFile.get(n.path);
        if (!set) {
            set = new Set();
            linesByFile.set(n.path, set);
        }
        set.add(range.start);
    }

    for (const key of referencedFileLines) {
        const sep = key.lastIndexOf("::");
        const unrefSet = linesByFile.get(key.slice(0, sep));
        if (unrefSet) unrefSet.delete(Number(key.slice(sep + 2)));
    }
    return linesByFile;
}

function pruneNamedImportLine(line, trimmed, lines, lineIdx, isPy = false, isLuau = false) {
    if (/;.*\S/.test(trimmed)) return null;
    const namedMatch = /^(\s*import\s*)\{([^}]+)\}(\s*from\s*["'][^"']+["']\s*;?\s*)$/.exec(line);
    if (!namedMatch) return null;
    const [, prefix, rawSpecs, suffix] = namedMatch;
    const specs = rawSpecs
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (specs.length === 0) return null;

    const kept = [];
    const removedNames = [];
    for (const spec of specs) {
        if (/^type\s+/.test(spec)) {
            kept.push(spec);
            continue;
        }
        const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(spec);
        if (!aliasMatch) {
            kept.push(spec);
            continue;
        }
        const localIdent = aliasMatch[2] || aliasMatch[1];
        if (countIdentifierUsesOutsideLine(lines, lineIdx, localIdent, isPy, isLuau) === 0) {
            removedNames.push(localIdent);
        } else {
            kept.push(spec);
        }
    }

    if (removedNames.length === 0) return null;
    if (kept.length === 0) {
        return { action: "remove", after: "<removed>" };
    }
    const rebuilt = `${prefix}{ ${kept.join(", ")} }${suffix}`;
    return { action: "replace", line: rebuilt, after: rebuilt.trim() };
}

function applyUnusedImportFixOnLine(
    line,
    trimmed,
    lines,
    lineIdx,
    lineNum,
    fileEdits,
    isPy = false,
    isLuau = false,
) {
    if (/;.*\S/.test(trimmed)) return null;
    const luauReq = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\([^)]+\)\s*$/.exec(trimmed);
    const jsImp = /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["'][^"']+["'];?\s*$/.exec(trimmed);
    const pyImp = /^from\s+[A-Za-z0-9_.]+\s+import\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(trimmed);
    const ident = luauReq?.[1] || jsImp?.[1] || pyImp?.[1];
    const effectiveIsPy = isPy || Boolean(pyImp);
    const effectiveIsLuau = isLuau || Boolean(luauReq);
    if (ident && countIdentifierUsesOutsideLine(lines, lineIdx, ident, effectiveIsPy, effectiveIsLuau) === 0) {
        fileEdits.push({ line: lineNum, fixer: "unused-imports", before: trimmed, after: "<removed>" });
        return { action: "remove", line };
    }
    const namedRes = pruneNamedImportLine(line, trimmed, lines, lineIdx, effectiveIsPy, effectiveIsLuau);
    if (namedRes) {
        fileEdits.push({ line: lineNum, fixer: "unused-imports", before: trimmed, after: namedRes.after });
        return { action: namedRes.action, line: namedRes.line };
    }
    return null;
}

function applyLuauLineFixers(line, trimmed, lineNum, flags, inLuauFunctionDepth, hoistedServices, fileEdits) {
    const { wantScheduler, wantInstanceNewParent, wantHoistGetService } = flags;
    if (trimmed.startsWith("--")) return { action: "keep", line };

    if (wantScheduler) {
        const replaced = line.replace(
            /(["'])(?:\\.|(?!\1)[^\\])*\1|--.*$|(^|[^.\w:"'])(?<!\bfunction\s+)\b(wait|spawn|delay)(\s*\()/g,
            (match, _quote, pre, fn, paren) => (fn ? `${pre}task.${fn}${paren}` : match),
        );
        if (replaced !== line) {
            fileEdits.push({ line: lineNum, fixer: "luau-task-scheduler", before: trimmed, after: replaced.trim() });
            line = replaced;
        }
    }

    if (wantInstanceNewParent) {
        const instMatch = /^(\s*)(local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Instance\.new\(\s*["'][A-Za-z0-9_]+["'])\s*,\s*([^)]+)\)\s*$/.exec(line);
        if (instMatch) {
            const [, indent, prefix, varName, parentExpr] = instMatch;
            const line1 = `${indent}${prefix})`;
            const line2 = `${indent}${varName}.Parent = ${parentExpr.trim()}`;
            fileEdits.push({ line: lineNum, fixer: "luau-instance-new-parent", before: trimmed, after: `${line1.trim()}; ${line2.trim()}` });
            return { action: "split", lines: [line1, line2] };
        }
    }

    if (wantHoistGetService && inLuauFunctionDepth > 0) {
        const svcMatch = /^(\s*)local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game:GetService\(\s*["']([A-Za-z0-9_]+)["']\s*\)\s*$/.exec(line);
        if (svcMatch && svcMatch[2] === svcMatch[3]) {
            const svcName = svcMatch[3];
            hoistedServices.add(svcName);
            fileEdits.push({ line: lineNum, fixer: "luau-hoist-getservice", before: trimmed, after: `<hoisted local ${svcName} = game:GetService("${svcName}") to top>` });
            return { action: "remove", line };
        }
    }

    return { action: "keep", line };
}

function insertHoistedLuauServices(nextLines, hoistedServices, existingTopServices) {
    if (hoistedServices.size === 0) return nextLines;
    const toInsert = [...hoistedServices]
        .filter((s) => !existingTopServices.has(s))
        .map((s) => `local ${s} = game:GetService("${s}")`);
    if (toInsert.length === 0) return nextLines;
    let insertIdx = 0;
    for (let k = 0; k < nextLines.length; k++) {
        const t = nextLines[k].trim();
        if (!t || t.startsWith("--")) {
            if (/^--!(?:strict|nonstrict|nocheck|native|optimize)\b/.test(t)) {
                insertIdx = k + 1;
            }
            continue;
        }
        break;
    }
    return [...nextLines.slice(0, insertIdx), ...toInsert, ...nextLines.slice(insertIdx)];
}

function autofixSingleFileLines(lines, isLuau, flags, existingTopServices, unrefExportLines = new Set()) {
    const { wantStrictHeader, wantUnusedImports, wantDebugLogs, wantUnreferencedExports } = flags;
    let modified = false;
    const fileEdits = [];
    let nextLines = [];
    const hoistedServices = new Set();

    if (isLuau && wantStrictHeader) {
        const firstNonEmpty = lines.find((l) => l.trim().length > 0) || "";
        if (!/^--!(?:strict|nonstrict|nocheck)\b/.test(firstNonEmpty.trim())) {
            nextLines.push("--!strict");
            modified = true;
            fileEdits.push({ line: 1, fixer: "luau-strict-header", before: firstNonEmpty, after: "--!strict" });
        }
    }

    let inLuauFunctionDepth = 0;
    let chunkFactoryDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmed = line.trim();
        const lineNum = i + 1;
        const depthBeforeLine = inLuauFunctionDepth;
        if (isLuau) {
            if (depthBeforeLine === 0 && /^return\s+function\b/.test(trimmed)) {
                chunkFactoryDepth = 1;
            }
            inLuauFunctionDepth = stepLuauBlockDepth(inLuauFunctionDepth, trimmed);
            if (inLuauFunctionDepth === 0) chunkFactoryDepth = 0;
        }
        const effectiveLuauFnDepth = Math.max(0, depthBeforeLine - chunkFactoryDepth);

        if (
            wantDebugLogs &&
            /^(?:console\.(?:log|debug|warn)|print)\s*\(\s*["'`](?:DEBUG|TEMP|FIXME|HERE\b).*\)\s*;?\s*$/i.test(
                trimmed,
            ) &&
            !/\)\s*;\s*\S/.test(trimmed)
        ) {
            modified = true;
            fileEdits.push({ line: lineNum, fixer: "debug-logs", before: trimmed, after: "<removed>" });
            continue;
        }

        if (
            wantUnusedImports &&
            !trimmed.startsWith("//") &&
            !trimmed.startsWith("--") &&
            !(flags.isPy && trimmed.startsWith("#"))
        ) {
            const impRes = applyUnusedImportFixOnLine(
                line,
                trimmed,
                lines,
                i,
                lineNum,
                fileEdits,
                Boolean(flags.isPy),
                isLuau,
            );
            if (impRes) {
                modified = true;
                if (impRes.action === "remove") continue;
                line = impRes.line;
            }
        }

        if (wantUnreferencedExports && unrefExportLines.has(lineNum) && !hasMultiDeclaratorExport(line)) {
            const stripped = line.replace(/^(\s*)export\s+((?:async\s+)?function\b|const\b|let\b|var\b|class\b)/, "$1$2");
            if (stripped !== line) {
                modified = true;
                fileEdits.push({ line: lineNum, fixer: "unreferenced-exports", before: trimmed, after: stripped.trim() });
                line = stripped;
            }
        }

        if (isLuau) {
            const prevEditsLen = fileEdits.length;
            const luauRes = applyLuauLineFixers(line, trimmed, lineNum, flags, effectiveLuauFnDepth, hoistedServices, fileEdits);
            if (fileEdits.length > prevEditsLen) modified = true;
            if (luauRes.action === "remove") continue;
            if (luauRes.action === "split") {
                nextLines.push(...luauRes.lines);
                continue;
            }
            line = luauRes.line;
        }

        nextLines.push(line);
    }

    nextLines = insertHoistedLuauServices(nextLines, hoistedServices, existingTopServices);
    return { modified, nextLines, fileEdits };
}

const FIXER_TO_DETECTORS = {
    "debug-logs": new Set(["debug_logs"]),
    "unused-imports": new Set(["dead_symbols", "language_traps", "luau_quality"]),
    "unreferenced-exports": new Set(["unreferenced_exports"]),
    "luau-task-scheduler": new Set(["luau_quality", "language_traps"]),
    "luau-strict-header": new Set(["luau_quality", "type_bypasses"]),
    "luau-instance-new-parent": new Set(["luau_quality"]),
    "luau-hoist-getservice": new Set(["luau_quality"]),
};

function reconcileAutofixWithState(changes, state, plan) {
    if (!state || !state.issues) return [];
    const resolvedIds = [];
    const nowIso = new Date().toISOString();

    for (const fileChange of changes) {
        const relPath = fileChange.file;
        for (const edit of fileChange.edits) {
            const detSet = FIXER_TO_DETECTORS[edit.fixer] || new Set();
            for (const [id, iss] of Object.entries(state.issues)) {
                if (iss.status !== "open" || iss.file !== relPath) continue;
                if (!detSet.has(iss.detector)) continue;
                const lineMatches =
                    edit.fixer === "luau-strict-header" ||
                    iss.line === edit.line ||
                    (iss.end_line && edit.line >= iss.line && edit.line <= iss.end_line);
                if (lineMatches) {
                    iss.status = "fixed";
                    iss.resolved_at = nowIso;
                    iss.resolved_by = `autofix:${edit.fixer}`;
                    iss.note = `Auto-fixed by ${edit.fixer}`;
                    resolvedIds.push(id);
                    if (plan) {
                        if (!Array.isArray(plan.uncommitted_resolved)) plan.uncommitted_resolved = [];
                        if (!plan.uncommitted_resolved.includes(id)) plan.uncommitted_resolved.push(id);
                    }
                }
            }
        }
    }
    return resolvedIds;
}

/**
 * Run a mechanical auto-fixer (`--dry-run` previews changes without writing).
 */
export function runAutofix(rootDir, graph, zoneMap, ignoreRules, fixerName = "all", opts = {}) {
    if (fixerName !== "all" && fixerName !== "luau" && !AVAILABLE_FIXERS.includes(fixerName)) {
        throw new Error(
            `Unknown autofix fixer "${fixerName}". Available: all, luau, ${AVAILABLE_FIXERS.join(", ")}`,
        );
    }
    const dryRun = Boolean(opts.dryRun);
    const gitCtx = detectGitContext(rootDir);
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    const changes = [];

    const flags = {
        wantScheduler: fixerName === "all" || fixerName === "luau-task-scheduler" || fixerName === "luau",
        wantStrictHeader: fixerName === "luau-strict-header",
        wantInstanceNewParent: fixerName === "all" || fixerName === "luau-instance-new-parent" || fixerName === "luau",
        wantHoistGetService: fixerName === "all" || fixerName === "luau-hoist-getservice" || fixerName === "luau",
        wantUnusedImports: fixerName === "unused-imports",
        wantDebugLogs: fixerName === "all" || fixerName === "debug-logs",
        wantUnreferencedExports: fixerName === "unreferenced-exports",
    };

    const absRoot = resolve(rootDir);
    let realRoot = absRoot;
    try {
        realRoot = realpathSync(absRoot);
    }
    catch { /* fallback */ }
    const unrefByFile = flags.wantUnreferencedExports
        ? collectUnreferencedExportLinesByFile(graph, rootDir)
        : new Map();

    for (const fNode of fileNodes) {
        const relPath = fNode.path;
        const zone = zoneMap.get(relPath) || "production";
        if (!SCORED_ZONES.has(zone) || ignoreRules.isIgnored(relPath)) continue;

        const safeFile = resolveSafeRepoFile(absRoot, realRoot, relPath, { noSymlinks: true });
        if (!safeFile) continue;
        const absPath = safeFile.realFile;

        const rawContent = readFileSync(absPath, "utf8");
        const eol = rawContent.includes("\r\n") ? "\r\n" : "\n";
        const lines = rawContent.split(/\r?\n/);
        const ext = extname(relPath).toLowerCase();
        const isLuau = ext === ".luau" || ext === ".lua";
        const isPy = ext === ".py";
        const existingTopServices = isLuau ? scanExistingTopLuauServices(lines) : new Set();
        const unrefLines = unrefByFile.get(relPath) || new Set();

        const { modified, nextLines, fileEdits } = autofixSingleFileLines(
            lines,
            isLuau,
            { ...flags, isPy },
            existingTopServices,
            unrefLines,
        );
        if (modified) {
            if (!dryRun) writeFileSync(absPath, nextLines.join(eol), "utf8");
            changes.push({ file: relPath, edits: fileEdits });
        }
    }

    const reconciledIds = !dryRun ? reconcileAutofixWithState(changes, opts.state, opts.plan) : [];

    return {
        fixer: fixerName,
        dry_run: dryRun,
        git_dirty_warning: gitCtx.has_uncommitted
            ? "Working tree has uncommitted changes before autofix."
            : null,
        files_changed: changes.length,
        total_edits: changes.reduce((acc, c) => acc + c.edits.length, 0),
        reconciled_issue_ids: reconciledIds,
        changes,
    };
}

function computeRelativeSpecifier(fromFileRel, toFileRel, keepExt = true) {
    const fromDir = posix.dirname(toPosix(fromFileRel));
    const target = toPosix(toFileRel);
    let rel = posix.relative(fromDir, target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (!keepExt) {
        rel = rel.replace(/\.(?:ts|tsx|js|jsx|luau|lua|py)$/i, "");
    }
    return rel;
}

/**
 * Compute a Roblox `script.Parent...` expression from `fromFileRel` to `toFileRel`.
 */
function computeRobloxScriptRequire(fromFileRel, toFileRel) {
    const fromParts = toPosix(fromFileRel).split("/");
    const toParts = toPosix(toFileRel).split("/");
    toParts[toParts.length - 1] = toParts[toParts.length - 1].replace(/\.(?:luau|lua)$/i, "");
    const isFromInit = /^init\.(?:luau|lua)$/i.test(fromParts[fromParts.length - 1]);
    if (toParts[toParts.length - 1] === "init" && toParts.length > 1) {
        toParts.pop();
    }

    const fromDirParts = fromParts.slice(0, -1);
    let common = 0;
    while (
        common < fromDirParts.length &&
        common < toParts.length &&
        fromDirParts[common] === toParts[common]
    ) {
        common++;
    }

    const upSteps = fromDirParts.length - common + (isFromInit ? 0 : 1);
    let expr = "script";
    for (let i = 0; i < upSteps; i++) {
        expr += ".Parent";
    }
    for (let i = common; i < toParts.length; i++) {
        const seg = toParts[i];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) {
            expr += `.${seg}`;
        } else {
            expr += `["${seg}"]`;
        }
    }
    return expr;
}

function registerRelativeSpecifierPairs(specMap, fromOld, toOld, fromNew, toNew) {
    const oldSpecWithExt = computeRelativeSpecifier(fromOld, toOld, true);
    const oldSpecNoExt = computeRelativeSpecifier(fromOld, toOld, false);
    const newSpecWithExt = computeRelativeSpecifier(fromNew, toNew, true);
    const newSpecNoExt = computeRelativeSpecifier(fromNew, toNew, false);
    const pairs = [
        [oldSpecWithExt, newSpecWithExt],
        [oldSpecNoExt, newSpecNoExt],
    ];
    if (/\.(?:ts|tsx)$/i.test(toOld) && /\.(?:ts|tsx)$/i.test(toNew)) {
        pairs.push([
            oldSpecWithExt.replace(/\.ts(x)?$/i, ".js$1"),
            newSpecWithExt.replace(/\.ts(x)?$/i, ".js$1"),
        ]);
    }
    for (const [oSpec, nSpec] of pairs) {
        if (oSpec !== nSpec && !specMap.has(oSpec)) {
            specMap.set(oSpec, nSpec);
        }
    }
}

function rewriteMovedFileImports(raw, fileRel, effectiveFileRel, ext, movePairs, allFiles, movedOldSet) {
    let updated = raw;
    const specMap = new Map();
    const rbxMap = new Map();
    const pyModMap = new Map();

    if (fileRel !== effectiveFileRel) {
        for (const otherRel of allFiles) {
            if (movedOldSet.has(otherRel)) continue;
            registerRelativeSpecifierPairs(specMap, fileRel, otherRel, effectiveFileRel, otherRel);
            if (ext === ".luau" || ext === ".lua") {
                const oldRbx = computeRobloxScriptRequire(fileRel, otherRel);
                const newRbx = computeRobloxScriptRequire(effectiveFileRel, otherRel);
                if (oldRbx !== newRbx && !rbxMap.has(oldRbx)) {
                    rbxMap.set(oldRbx, newRbx);
                }
            }
        }
    }

    for (const { oldPath, newPath } of movePairs) {
        if (fileRel === oldPath && effectiveFileRel === newPath) continue;
        registerRelativeSpecifierPairs(specMap, fileRel, oldPath, effectiveFileRel, newPath);

        if (ext === ".py" && oldPath.endsWith(".py")) {
            const oldMod = oldPath.replace(/\.py$/i, "").replace(/\//g, ".");
            const newMod = newPath.replace(/\.py$/i, "").replace(/\//g, ".");
            if (oldMod !== newMod && !pyModMap.has(oldMod)) {
                pyModMap.set(oldMod, newMod);
            }
        }

        if ((ext === ".luau" || ext === ".lua") && /\.(?:luau|lua)$/i.test(oldPath)) {
            const oldRbx = computeRobloxScriptRequire(fileRel, oldPath);
            const newRbx = computeRobloxScriptRequire(effectiveFileRel, newPath);
            if (oldRbx !== newRbx && !rbxMap.has(oldRbx)) {
                rbxMap.set(oldRbx, newRbx);
            }
        }
    }

    if (specMap.size > 0) {
        updated = updated.replace(
            /(\b(?:import|export)\s+(?:type\s+)?(?!function\b|async\b|class\b|const\b|let\b|var\b|default\b|interface\b|enum\b)[^;()="'`]*?\bfrom\s+|\bimport\s+|\b(?:import|require)\s*\(\s*)(["'])([^"'\r\n]+)\2/g,
            (m, pre, q, spec) => (specMap.has(spec) ? `${pre}${q}${specMap.get(spec)}${q}` : m),
        );
    }

    if (rbxMap.size > 0) {
        updated = updated.replace(
            /\brequire\((script(?:\.[A-Za-z_][A-Za-z0-9_]*|\["[^"]+"\])*)\)/g,
            (m, expr) => (rbxMap.has(expr) ? `require(${rbxMap.get(expr)})` : m),
        );
    }

    if (pyModMap.size > 0) {
        const escapedKeys = [...pyModMap.keys()]
            .sort((a, b) => b.length - a.length)
            .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const pyRe = new RegExp(`\\b(from|import)\\s+(${escapedKeys.join("|")})\\b`, "g");
        updated = updated.replace(pyRe, (m, kw, mod) =>
            pyModMap.has(mod) ? `${kw} ${pyModMap.get(mod)}` : m,
        );
    }

    return updated;
}

function assertRealPathInsideRoot(realRoot, targetReal) {
    const rel = toPosix(relative(realRoot, targetReal));
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("moveFileOrDir paths must stay within repository root");
    }
}

function validateAndResolveMovePaths(rootDir, srcArg, dstArg) {
    const absSrc = resolve(rootDir, srcArg);
    let absDst = resolve(rootDir, dstArg);

    if (!existsSync(absSrc)) {
        throw new Error(`Source path does not exist: ${srcArg}`);
    }

    const srcStat = statSync(absSrc);
    if (existsSync(absDst) && statSync(absDst).isDirectory() && absDst !== absSrc) {
        absDst = join(absDst, basename(absSrc));
    }
    if (existsSync(absDst) && absDst !== absSrc) {
        throw new Error(`Destination path already exists: ${toPosix(relative(rootDir, absDst))}`);
    }

    const relSrc = toPosix(relative(rootDir, absSrc));
    const relDst = toPosix(relative(rootDir, absDst));
    if (
        !relSrc ||
        relSrc === "." ||
        relSrc.startsWith("..") ||
        isAbsolute(relSrc) ||
        !relDst ||
        relDst === "." ||
        relDst.startsWith("..") ||
        isAbsolute(relDst)
    ) {
        throw new Error("moveFileOrDir paths must stay within repository root");
    }

    const realRoot = realpathSync(rootDir);
    if (lstatSync(absSrc).isSymbolicLink()) {
        throw new Error("moveFileOrDir refuses to move symlinks");
    }
    assertRealPathInsideRoot(realRoot, realpathSync(dirname(absSrc)));
    assertRealPathInsideRoot(realRoot, realpathSync(absSrc));
    let dstAncestor = existsSync(absDst) ? absDst : dirname(absDst);
    while (!existsSync(dstAncestor)) {
        const parent = dirname(dstAncestor);
        if (parent === dstAncestor) break;
        dstAncestor = parent;
    }
    assertRealPathInsideRoot(realRoot, realpathSync(dstAncestor));
    return { absSrc, absDst, srcStat, relSrc, relDst };
}

/**
 * Move a file or directory (`srcRel` → `dstRel`) and update all import/require statements
 * across the repository (JS/TS, Python, and Luau/Roblox).
 */
export function moveFileOrDir(rootDir, graph, srcArg, dstArg, opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const { absSrc, absDst, srcStat, relSrc, relDst } = validateAndResolveMovePaths(rootDir, srcArg, dstArg);

    const movePairs = [];
    if (srcStat.isDirectory()) {
        for (const n of graph.nodes) {
            if (n.kind === "file" && (n.path === relSrc || n.path.startsWith(`${relSrc}/`))) {
                const suffix = n.path.slice(relSrc.length);
                movePairs.push({ oldPath: n.path, newPath: `${relDst}${suffix}` });
            }
        }
    } else {
        movePairs.push({ oldPath: relSrc, newPath: relDst });
    }

    const moveMap = new Map(movePairs.map((p) => [p.oldPath, p.newPath]));
    const movedOldSet = new Set(moveMap.keys());
    const allFiles = graph.nodes.filter((n) => n.kind === "file").map((n) => n.path);
    const importerUpdates = [];

    const absRoot = resolve(rootDir);
    let realRoot = absRoot;
    try {
        realRoot = realpathSync(absRoot);
    }
    catch { /* fallback */ }

    for (const fileRel of allFiles) {
        const safeFile = resolveSafeRepoFile(absRoot, realRoot, fileRel, { noSymlinks: true });
        if (!safeFile) continue;
        const absFile = safeFile.realFile;
        const effectiveFileRel = moveMap.get(fileRel) || fileRel;
        const raw = readFileSync(absFile, "utf8");
        const ext = extname(fileRel).toLowerCase();
        const updated = rewriteMovedFileImports(
            raw,
            fileRel,
            effectiveFileRel,
            ext,
            movePairs,
            allFiles,
            movedOldSet,
        );
        if (updated !== raw) {
            importerUpdates.push({ file: fileRel, effective_file: effectiveFileRel, content: updated });
        }
    }

    let remappedIssues = 0;
    if (!dryRun) {
        mkdirSync(dirname(absDst), { recursive: true });
        renameSync(absSrc, absDst);
        for (const u of importerUpdates) {
            writeFileSync(join(rootDir, u.effective_file), u.content, "utf8");
        }
        if (opts.state || opts.plan) {
            const remapped = remapMovedIssuePaths(opts.state, opts.plan, moveMap);
            remappedIssues = remapped.remapped_count;
        }
    }

    return {
        dry_run: dryRun,
        from: relSrc,
        to: relDst,
        files_moved: movePairs.length,
        updated_importers: importerUpdates.map((u) => u.file),
        remapped_issues: remappedIssues,
    };
}
