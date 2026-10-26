/**
 * Safe mechanical auto-fixers (`plexer health autofix`) and import-rewriting file/directory move
 * (`plexer health move <src> <dst> [--dry-run]`) with JS/TS, Python, and Luau/Roblox support.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path";
import { spanRange } from "../util/span.js";
import { detectGitContext } from "./state.js";
import { SCORED_ZONES } from "./zones.js";

export const AVAILABLE_FIXERS = [
    "luau-task-scheduler",
    "luau-strict-header",
    "luau-instance-new-parent",
    "luau-hoist-getservice",
    "unused-imports",
    "debug-logs",
    "unreferenced-exports",
];

function countIdentifierUsesOutsideLine(lines, lineIdx, ident) {
    const wordRe = new RegExp(`\\b${ident}\\b`);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (i === lineIdx) continue;
        const l = lines[i].trim();
        if (l.startsWith("//") || l.startsWith("#") || l.startsWith("--")) continue;
        if (wordRe.test(l)) count += 1;
    }
    return count;
}

function scanExistingTopLuauServices(lines) {
    const existingTopServices = new Set();
    let scanDepth = 0;
    for (const l of lines) {
        const trimmedScan = l.trim();
        if (!trimmedScan.startsWith("--")) {
            const fOpen = (trimmedScan.match(/\bfunction\b/g) || []).length;
            const bOpen = (trimmedScan.match(/\b(?:then|do|repeat)\b/g) || []).length;
            const ends = (trimmedScan.match(/\b(?:end|until)\b/g) || []).length;
            if (scanDepth === 0 && fOpen === 0) {
                const m = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*game:GetService\(\s*["']([A-Za-z0-9_]+)["']\s*\)/.exec(
                    l,
                );
                if (m) existingTopServices.add(m[2]);
            }
            scanDepth = Math.max(0, scanDepth + fOpen + bOpen - ends);
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

function collectUnreferencedExportLinesByFile(graph) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const incomingCrossFile = new Map();
    for (const edge of graph.edges || []) {
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        if (!src || !tgt || src.path === tgt.path) continue;
        incomingCrossFile.set(tgt.id, (incomingCrossFile.get(tgt.id) || 0) + 1);
    }
    const linesByFile = new Map();
    for (const n of graph.nodes) {
        if (n.kind === "file" || !n.exported || !n.path) continue;
        if (isEntrypointForAutofix(n.path)) continue;
        if ((incomingCrossFile.get(n.id) || 0) > 0) continue;
        const range = spanRange(n.span);
        if (!range) continue;
        let set = linesByFile.get(n.path);
        if (!set) {
            set = new Set();
            linesByFile.set(n.path, set);
        }
        set.add(range.start);
    }
    return linesByFile;
}

function pruneNamedImportLine(line, trimmed, lines, lineIdx) {
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
        if (countIdentifierUsesOutsideLine(lines, lineIdx, localIdent) === 0) {
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

function applyUnusedImportFixOnLine(line, trimmed, lines, lineIdx, lineNum, fileEdits) {
    const luauReq = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\([^)]+\)\s*$/.exec(trimmed);
    const jsImp = /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["'][^"']+["'];?\s*$/.exec(trimmed);
    const pyImp = /^from\s+[A-Za-z0-9_.]+\s+import\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(trimmed);
    const ident = luauReq?.[1] || jsImp?.[1] || pyImp?.[1];
    if (ident && countIdentifierUsesOutsideLine(lines, lineIdx, ident) === 0) {
        fileEdits.push({ line: lineNum, fixer: "unused-imports", before: trimmed, after: "<removed>" });
        return { action: "remove", line };
    }
    const namedRes = pruneNamedImportLine(line, trimmed, lines, lineIdx);
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
        const replaced = line.replace(/(^|[^.\w:])(wait|spawn|delay)(\s*\()/g, "$1task.$2$3");
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
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmed = line.trim();
        const lineNum = i + 1;

        if (isLuau && !trimmed.startsWith("--")) {
            const fnOpens = (line.match(/\bfunction\b/g) || []).length;
            if (fnOpens > 0) inLuauFunctionDepth += fnOpens;
        }

        if (wantDebugLogs && /\b(?:console\.log|print)\s*\(\s*["'`](?:DEBUG|TEMP|FIXME|HERE\b)/i.test(trimmed)) {
            modified = true;
            fileEdits.push({ line: lineNum, fixer: "debug-logs", before: trimmed, after: "<removed>" });
            continue;
        }

        if (wantUnusedImports && !trimmed.startsWith("//") && !trimmed.startsWith("--") && !trimmed.startsWith("#")) {
            const impRes = applyUnusedImportFixOnLine(line, trimmed, lines, i, lineNum, fileEdits);
            if (impRes) {
                modified = true;
                if (impRes.action === "remove") continue;
                line = impRes.line;
            }
        }

        if (wantUnreferencedExports && unrefExportLines.has(lineNum)) {
            const stripped = line.replace(/^(\s*)export\s+((?:async\s+)?function\b|const\b|let\b|var\b|class\b)/, "$1$2");
            if (stripped !== line) {
                modified = true;
                fileEdits.push({ line: lineNum, fixer: "unreferenced-exports", before: trimmed, after: stripped.trim() });
                line = stripped;
            }
        }

        if (isLuau) {
            const prevEditsLen = fileEdits.length;
            const luauRes = applyLuauLineFixers(line, trimmed, lineNum, flags, inLuauFunctionDepth, hoistedServices, fileEdits);
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

    if (hoistedServices.size > 0) {
        const toInsert = [...hoistedServices]
            .filter((s) => !existingTopServices.has(s))
            .map((s) => `local ${s} = game:GetService("${s}")`);
        if (toInsert.length > 0) {
            const insertIdx = nextLines[0] && /^--!/.test(nextLines[0].trim()) ? 1 : 0;
            nextLines = [...nextLines.slice(0, insertIdx), ...toInsert, ...nextLines.slice(insertIdx)];
        }
    }

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

    const unrefByFile = flags.wantUnreferencedExports
        ? collectUnreferencedExportLinesByFile(graph)
        : new Map();

    for (const fNode of fileNodes) {
        const relPath = fNode.path;
        const zone = zoneMap.get(relPath) || "production";
        if (!SCORED_ZONES.has(zone) || ignoreRules.isIgnored(relPath)) continue;

        const absPath = join(rootDir, relPath);
        if (!existsSync(absPath)) continue;

        const rawContent = readFileSync(absPath, "utf8");
        const eol = rawContent.includes("\r\n") ? "\r\n" : "\n";
        const lines = rawContent.split(/\r?\n/);
        const ext = extname(relPath).toLowerCase();
        const isLuau = ext === ".luau" || ext === ".lua";
        const existingTopServices = isLuau ? scanExistingTopLuauServices(lines) : new Set();
        const unrefLines = unrefByFile.get(relPath) || new Set();

        const { modified, nextLines, fileEdits } = autofixSingleFileLines(
            lines,
            isLuau,
            flags,
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

function toPosix(p) {
    return p.replace(/\\/g, "/");
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

function rewriteMovedFileImports(raw, fileRel, effectiveFileRel, ext, movePairs, allFiles) {
    let updated = raw;
    for (const { oldPath, newPath } of movePairs) {
        if (fileRel === oldPath && effectiveFileRel === newPath && movePairs.length === 1) {
            for (const otherRel of allFiles) {
                if (otherRel === oldPath) continue;
                const oldSpecWithExt = computeRelativeSpecifier(oldPath, otherRel, true);
                const oldSpecNoExt = computeRelativeSpecifier(oldPath, otherRel, false);
                const newSpecWithExt = computeRelativeSpecifier(newPath, otherRel, true);
                const newSpecNoExt = computeRelativeSpecifier(newPath, otherRel, false);
                for (const [oSpec, nSpec] of [[oldSpecWithExt, newSpecWithExt], [oldSpecNoExt, newSpecNoExt]]) {
                    if (oSpec !== nSpec && updated.includes(oSpec)) {
                        updated = updated.split(`"${oSpec}"`).join(`"${nSpec}"`).split(`'${oSpec}'`).join(`'${nSpec}'`);
                    }
                }
                if (ext === ".luau" || ext === ".lua") {
                    const oldRbx = computeRobloxScriptRequire(oldPath, otherRel);
                    const newRbx = computeRobloxScriptRequire(newPath, otherRel);
                    if (oldRbx !== newRbx && updated.includes(`require(${oldRbx})`)) {
                        updated = updated.split(`require(${oldRbx})`).join(`require(${newRbx})`);
                    }
                }
            }
            continue;
        }

        const oldSpecWithExt = computeRelativeSpecifier(fileRel, oldPath, true);
        const oldSpecNoExt = computeRelativeSpecifier(fileRel, oldPath, false);
        const newSpecWithExt = computeRelativeSpecifier(effectiveFileRel, newPath, true);
        const newSpecNoExt = computeRelativeSpecifier(effectiveFileRel, newPath, false);

        for (const [oSpec, nSpec] of [[oldSpecWithExt, newSpecWithExt], [oldSpecNoExt, newSpecNoExt]]) {
            if (oSpec !== nSpec && updated.includes(oSpec)) {
                updated = updated.split(`"${oSpec}"`).join(`"${nSpec}"`).split(`'${oSpec}'`).join(`'${nSpec}'`);
            }
        }

        if (ext === ".py" && oldPath.endsWith(".py")) {
            const oldMod = oldPath.replace(/\.py$/i, "").replace(/\//g, ".");
            const newMod = newPath.replace(/\.py$/i, "").replace(/\//g, ".");
            if (oldMod !== newMod && updated.includes(oldMod)) {
                updated = updated
                    .replace(new RegExp(`\\bfrom\\s+${oldMod}\\b`, "g"), `from ${newMod}`)
                    .replace(new RegExp(`\\bimport\\s+${oldMod}\\b`, "g"), `import ${newMod}`);
            }
        }

        if ((ext === ".luau" || ext === ".lua") && /\.(?:luau|lua)$/i.test(oldPath)) {
            const oldRbx = computeRobloxScriptRequire(fileRel, oldPath);
            const newRbx = computeRobloxScriptRequire(effectiveFileRel, newPath);
            if (oldRbx !== newRbx && updated.includes(`require(${oldRbx})`)) {
                updated = updated.split(`require(${oldRbx})`).join(`require(${newRbx})`);
            }
        }
    }
    return updated;
}

/**
 * Move a file or directory (`srcRel` → `dstRel`) and update all import/require statements
 * across the repository (JS/TS, Python, and Luau/Roblox).
 */
export function moveFileOrDir(rootDir, graph, srcArg, dstArg, opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const absSrc = resolve(rootDir, srcArg);
    let absDst = resolve(rootDir, dstArg);

    if (!existsSync(absSrc)) {
        throw new Error(`Source path does not exist: ${srcArg}`);
    }

    const srcStat = statSync(absSrc);
    if (existsSync(absDst) && statSync(absDst).isDirectory() && !srcStat.isDirectory()) {
        absDst = join(absDst, basename(absSrc));
    }

    const relSrc = toPosix(relative(rootDir, absSrc));
    const relDst = toPosix(relative(rootDir, absDst));

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
    const allFiles = graph.nodes.filter((n) => n.kind === "file").map((n) => n.path);
    const importerUpdates = [];

    for (const fileRel of allFiles) {
        const absFile = join(rootDir, fileRel);
        if (!existsSync(absFile)) continue;
        const effectiveFileRel = moveMap.get(fileRel) || fileRel;
        const raw = readFileSync(absFile, "utf8");
        const ext = extname(fileRel).toLowerCase();
        const updated = rewriteMovedFileImports(raw, fileRel, effectiveFileRel, ext, movePairs, allFiles);
        if (updated !== raw) {
            importerUpdates.push({ file: fileRel, effective_file: effectiveFileRel, content: updated });
        }
    }

    if (!dryRun) {
        for (const u of importerUpdates) {
            writeFileSync(join(rootDir, u.file), u.content, "utf8");
        }
        mkdirSync(dirname(absDst), { recursive: true });
        renameSync(absSrc, absDst);
    }

    return {
        dry_run: dryRun,
        from: relSrc,
        to: relDst,
        files_moved: movePairs.length,
        updated_importers: importerUpdates.map((u) => u.file),
    };
}
