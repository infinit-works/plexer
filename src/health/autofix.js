/**
 * Safe mechanical auto-fixers (`plexer health autofix`) and import-rewriting file/directory move
 * (`plexer health move <src> <dst> [--dry-run]`) with JS/TS, Python, and Luau/Roblox support.
 */
import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { invalidateGraphCaches } from "../context/graph-store.js";
import { contextDirFor } from "../context/node-file.js";
import { buildGraph } from "../graph/build.js";
import { languageOf } from "../graph/extract.js";
import { genericLangOf, loadWasmLanguage, parseWasm } from "../graph/generic.js";
import { normalizeLuauForParse } from "../graph/luau.js";
import { toPosixPath as toPosix } from "../util/paths.js";
import { resolveSafeRepoFile, spanRange } from "../util/span.js";
import {
    collectDynamicLoaderDirs,
    isDynamicLoaderChild,
    isEntrypointPath,
    isSymbolReferencedAcrossRepo,
} from "./graph-checks.js";
import { remapMovedIssuePaths } from "./queue.js";
import { findUnusedImportEditOnLine } from "./source-checks.js";
import { detectGitContext } from "./state.js";
import {
    hasWordToken,
    loadPackageEntrypoints,
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

const AUTOFIX_PARSED_LANGS = new Map();

function autofixWasmNameForFile(relPath) {
    const ext = extname(String(relPath || "")).toLowerCase();
    const depthLang = languageOf(relPath);
    if (depthLang) return depthLang;
    const gen = genericLangOf(relPath);
    if (gen?.wasm) return gen.wasm;
    if (ext === ".luau") return "luau";
    if (ext === ".lua") return "lua";
    return null;
}

/**
 * Warm Tree-sitter WASM grammars for autofix syntax validation across `filePaths`.
 */
export async function warmAutofixGrammars(filePaths = []) {
    const wasmNames = new Set();
    for (const f of filePaths) {
        const w = autofixWasmNameForFile(f);
        if (w && !AUTOFIX_PARSED_LANGS.has(w)) wasmNames.add(w);
    }
    if (wasmNames.size === 0) return;
    await Promise.all(
        [...wasmNames].map(async (w) => {
            const lang = await loadWasmLanguage(w);
            if (lang) AUTOFIX_PARSED_LANGS.set(w, lang);
        }),
    );
}

/**
 * Parse `sourceText` in memory via Tree-sitter and return total `ERROR`/`MISSING` node count,
 * or `null` if no warmed grammar covers `relPath`.
 */
function countSyntaxErrorsWithTreeSitter(relPath, sourceText) {
    const wasm = autofixWasmNameForFile(relPath);
    if (!wasm) return null;
    const language = AUTOFIX_PARSED_LANGS.get(wasm);
    if (!language) return null;
    const parseInput = wasm === "luau" ? normalizeLuauForParse(sourceText) : sourceText;
    const root = parseWasm(language, parseInput);
    if (!root) return null;
    try {
        let errorCount = 0;
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (node.type === "ERROR" || node.isError || node.isMissing) {
                errorCount += 1;
                continue;
            }
            const count = node.childCount || 0;
            for (let c = count - 1; c >= 0; c--) {
                stack.push(node.child(c));
            }
        }
        return errorCount;
    } finally {
        root._tree?.delete?.();
    }
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

function collectShadowedLuauSchedulerNames(lines) {
    const shadowed = new Set();
    const names = ["wait", "spawn", "delay"];
    for (const raw of lines) {
        const cleaned = stripCodeStringsAndComments(raw, true, false);
        if (!cleaned) continue;
        for (const name of names) {
            if (
                new RegExp(`\\blocal\\s+function\\s+${name}\\b`).test(cleaned) ||
                new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(cleaned) ||
                new RegExp(`\\blocal\\s+[A-Za-z0-9_,\\s]*\\b${name}\\b\\s*(?:=|,|$)`).test(cleaned)
            ) {
                shadowed.add(name);
            }
        }
        const fnParamMatch = /\bfunction(?:\s+[A-Za-z_][A-Za-z0-9_.:]*)?\s*\(([^)]*)\)/.exec(cleaned);
        if (fnParamMatch) {
            for (const p of fnParamMatch[1].split(",")) {
                const pName = p.split(":")[0].trim();
                if (names.includes(pName)) shadowed.add(pName);
            }
        }
    }
    return shadowed;
}

function stepLuauBlockStack(stack, rawLine) {
    const cleaned = stripCodeStringsAndComments(rawLine, true, false).trim();
    if (!cleaned) return;
    const withoutInlineIf = cleaned.replace(
        /([=(,{[\-+*/%^<>~]|==|~=|<=|>=|\.\.|\b(?:return|and|or|not)\b)\s*if\b(?:(?!\b(?:end|return|local)\b).)*?\bthen\b(?:(?!\b(?:end|return|local)\b).)*?\belse\b/g,
        "$1 ",
    );
    const tokenRe = /\b(?:xpcall|pcall)\s*\(\s*function\b|\b(?:function|if|for|while|do|repeat|end|until)\b/g;
    let pendingLoopDo = false;
    let m;
    while ((m = tokenRe.exec(withoutInlineIf)) !== null) {
        const tok = m[0];
        if (tok.startsWith("pcall") || tok.startsWith("xpcall")) {
            stack.push("pcall");
            pendingLoopDo = false;
        } else if (tok === "function") {
            stack.push("function");
            pendingLoopDo = false;
        } else if (tok === "for" || tok === "while") {
            stack.push("conditional");
            pendingLoopDo = true;
        } else if (tok === "do") {
            if (pendingLoopDo) {
                pendingLoopDo = false;
            } else {
                stack.push("conditional");
            }
        } else if (tok === "if" || tok === "repeat") {
            stack.push("conditional");
            pendingLoopDo = false;
        } else if (tok === "end" || tok === "until") {
            if (stack.length > 0) stack.pop();
            pendingLoopDo = false;
        }
    }
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

function createLineArrayReader(rootDir) {
    const absRoot = rootDir ? resolve(rootDir) : null;
    let realRoot = absRoot;
    if (absRoot) {
        try {
            realRoot = realpathSync(absRoot);
        } catch {
            /* fallback */
        }
    }
    const cache = new Map();
    return (relPath) => {
        if (!absRoot || !realRoot) return [];
        if (cache.has(relPath)) return cache.get(relPath);
        const safe = resolveSafeRepoFile(absRoot, realRoot, relPath, { noSymlinks: true });
        const lines = safe ? readFileSync(safe.realFile, "utf8").split(/\r?\n/) : [];
        cache.set(relPath, lines);
        return lines;
    };
}

function buildExportScanMaps(graph) {
    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    const symbolsByFile = new Map();
    for (const n of graph.nodes) {
        if (n.kind === "file" || !n.path) continue;
        let list = symbolsByFile.get(n.path);
        if (!list) {
            list = [];
            symbolsByFile.set(n.path, list);
        }
        list.push(n);
    }
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const incomingCrossFile = new Map();
    const importersByPath = new Map();
    for (const edge of graph.edges || []) {
        const src = nodeById.get(edge.source);
        const tgt = nodeById.get(edge.target);
        if (!src || !tgt || src.path === tgt.path) continue;
        incomingCrossFile.set(tgt.id, (incomingCrossFile.get(tgt.id) || 0) + 1);
        if (String(edge.relation || "").toUpperCase() === "IMPORTS" && src.path && tgt.path) {
            let set = importersByPath.get(tgt.path);
            if (!set) {
                set = new Set();
                importersByPath.set(tgt.path, set);
            }
            set.add(src.path);
        }
    }
    return { fileNodes, symbolsByFile, incomingCrossFile, importersByPath };
}

function shortExportSymbolName(name) {
    if (name.includes(".")) return name.split(".").pop();
    if (name.includes(":")) return name.split(":").pop();
    return name;
}

function collectUnreferencedExportLinesByFile(graph, rootDir = null) {
    const packageEntrypoints = rootDir ? loadPackageEntrypoints(rootDir) : new Set();
    const readLines = createLineArrayReader(rootDir);
    const { fileNodes, symbolsByFile, incomingCrossFile, importersByPath } = buildExportScanMaps(graph);
    const dynamicLoaderInfo = collectDynamicLoaderDirs(fileNodes, readLines);
    const repoState = { allFileNodes: fileNodes, readLines, tokenIndex: null };
    const linesByFile = new Map();
    const referencedFileLines = new Set();

    for (const n of graph.nodes) {
        if (n.kind === "file" || !n.exported || !n.path) continue;
        const fileSymbols = symbolsByFile.get(n.path) || [];
        if (isEntrypointPath(n.path, fileSymbols, packageEntrypoints) || isDynamicLoaderChild(n.path, dynamicLoaderInfo)) {
            continue;
        }
        const range = spanRange(n.span);
        if (!range) continue;
        if ((incomingCrossFile.get(n.id) || 0) > 0 ||
            (rootDir && isSymbolReferencedAcrossRepo(shortExportSymbolName(n.name), importersByPath.get(n.path), repoState, n.path))) {
            referencedFileLines.add(`${n.path}::${range.start}`);
            continue;
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
        linesByFile.get(key.slice(0, sep))?.delete(Number(key.slice(sep + 2)));
    }
    return linesByFile;
}

function applyUnusedImportFixOnLine(line, trimmed, lines, lineIdx, lineNum, fileEdits, isPy = false, isLuau = false) {
    const res = findUnusedImportEditOnLine(line, trimmed, lines, lineIdx, isPy, isLuau);
    if (!res) return null;
    fileEdits.push({ line: lineNum, fixer: "unused-imports", before: trimmed, after: res.after });
    return { action: res.action, line: res.line };
}

function applyLuauLineFixers(
    line,
    trimmed,
    lineNum,
    flags,
    canHoistHere,
    hoistedServices,
    fileEdits,
    shadowedSchedulerNames = null,
) {
    const { wantScheduler, wantInstanceNewParent, wantHoistGetService } = flags;
    if (trimmed.startsWith("--")) return { action: "keep", line };

    if (wantScheduler) {
        const replaced = line.replace(
            /--\[(=*)\[[\s\S]*?\]\1\]|\[(=*)\[[\s\S]*?\]\2\]|(["'`])(?:\\.|(?!\3)[^\\])*\3|--.*$|(^|[^.\w:"'])(?<!\bfunction\s+)\b(wait|spawn|delay)(\s*\()/g,
            (match, _cEq, _sEq, _quote, pre, fn, paren) =>
                fn && !shadowedSchedulerNames?.has(fn) ? `${pre}task.${fn}${paren}` : match,
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
            return { action: "split", lines: [line1, line2], varName };
        }
    }

    if (wantHoistGetService && canHoistHere) {
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

function insertHoistedLuauServices(mappedLines, hoistedServices, existingTopServices) {
    if (hoistedServices.size === 0) return mappedLines;
    const toInsert = [...hoistedServices]
        .filter((s) => !existingTopServices.has(s))
        .map((s) => ({ text: `local ${s} = game:GetService("${s}")`, origLine: null }));
    if (toInsert.length === 0) return mappedLines;
    let insertIdx = 0;
    let longClose = null;
    for (let k = 0; k < mappedLines.length; k++) {
        const t = mappedLines[k].text.trim();
        if (longClose) {
            insertIdx = k + 1;
            if (t.includes(longClose)) longClose = null;
            continue;
        }
        if (!t) {
            insertIdx = k + 1;
            continue;
        }
        if (t.startsWith("--")) {
            insertIdx = k + 1;
            const m = /^--\[(=*)\[/.exec(t);
            if (m && !t.slice(m[0].length).includes(`]${m[1]}]`)) {
                longClose = `]${m[1]}]`;
            }
            continue;
        }
        break;
    }
    return [...mappedLines.slice(0, insertIdx), ...toInsert, ...mappedLines.slice(insertIdx)];
}

function buildLineRemapper(mappedLines, origLineCount) {
    const origToNew = new Map();
    for (let idx = 0; idx < mappedLines.length; idx++) {
        const ol = mappedLines[idx].origLine;
        if (ol !== null && ol !== undefined && !origToNew.has(ol)) {
            origToNew.set(ol, idx + 1);
        }
    }
    const maxOut = Math.max(1, mappedLines.length);
    return (origLine, isEnd = false) => {
        if (!Number.isFinite(origLine) || origLine < 1) return 1;
        if (origToNew.has(origLine)) return origToNew.get(origLine);
        for (let k = origLine + 1; k <= origLineCount; k++) {
            if (origToNew.has(k)) {
                return isEnd ? Math.max(1, origToNew.get(k) - 1) : Math.min(maxOut, origToNew.get(k));
            }
        }
        return maxOut;
    };
}

function flushPendingParentsInto(mappedLines, pendingParents, currentLine = null) {
    if (pendingParents.length === 0) return;
    const kept = [];
    for (const p of pendingParents) {
        const matchesPropAssign =
            currentLine !== null &&
            new RegExp(`^\\s*${p.varName}\\.(?!Parent\\b)[A-Za-z_][A-Za-z0-9_]*\\s*=`).test(currentLine);
        if (matchesPropAssign) {
            kept.push(p);
        } else {
            mappedLines.push({ text: p.parentLine, origLine: null });
        }
    }
    pendingParents.length = 0;
    pendingParents.push(...kept);
}

function stepLuauFixLineState(isLuau, line, trimmed, state) {
    const wasInLongBracket = Boolean(state.luauLongClose);
    if (isLuau) {
        if (state.luauLongClose) {
            if (line.includes(state.luauLongClose)) state.luauLongClose = null;
        } else {
            const lb = /(?:--)?\[(=*)\[/.exec(line);
            if (lb && !line.slice(lb.index + lb[0].length).includes(`]${lb[1]}]`)) {
                state.luauLongClose = `]${lb[1]}]`;
            }
        }
    }
    const depthBefore = state.inLuauFunctionDepth;
    const hasGuardBlockBeforeLine = state.luauBlockStack.some((b) => b === "conditional" || b === "pcall");
    if (isLuau && !wasInLongBracket) {
        if (depthBefore === 0 && /^return\s+function\b/.test(trimmed)) {
            state.chunkFactoryDepth = 1;
        }
        state.inLuauFunctionDepth = stepLuauBlockDepth(state.inLuauFunctionDepth, trimmed);
        stepLuauBlockStack(state.luauBlockStack, trimmed);
        if (state.inLuauFunctionDepth === 0) state.chunkFactoryDepth = 0;
    }
    const effectiveDepth = Math.max(0, depthBefore - state.chunkFactoryDepth);
    return {
        wasInLongBracket,
        canHoistHere: effectiveDepth > 0 && !hasGuardBlockBeforeLine && !wasInLongBracket,
    };
}

function processSingleFixLine(
    rawLine,
    trimmed,
    lines,
    i,
    lineNum,
    isLuau,
    wasInLongBracket,
    canHoistHere,
    flags,
    hoistedServices,
    shadowedSchedulerNames,
    unrefExportLines,
    pendingParents,
    mappedLines,
    fileEdits,
) {
    let line = rawLine;
    let modified = false;

    if (
        flags.wantDebugLogs &&
        !wasInLongBracket &&
        /^(?:console\.(?:log|debug|warn)|print)\s*\(\s*["'`](?:DEBUG|TEMP|FIXME|HERE\b).*\)\s*;?\s*$/i.test(trimmed) &&
        !/\)\s*;\s*\S/.test(trimmed)
    ) {
        fileEdits.push({ line: lineNum, fixer: "debug-logs", before: trimmed, after: "<removed>" });
        return { modified: true };
    }

    if (
        flags.wantUnusedImports &&
        !wasInLongBracket &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("--") &&
        !(flags.isPy && trimmed.startsWith("#"))
    ) {
        const impRes = applyUnusedImportFixOnLine(line, trimmed, lines, i, lineNum, fileEdits, Boolean(flags.isPy), isLuau);
        if (impRes) {
            modified = true;
            if (impRes.action === "remove") return { modified: true };
            line = impRes.line;
        }
    }

    if (flags.wantUnreferencedExports && unrefExportLines.has(lineNum) && !hasMultiDeclaratorExport(line)) {
        const stripped = line.replace(/^(\s*)export\s+((?:async\s+)?function\b|const\b|let\b|var\b|class\b)/, "$1$2");
        if (stripped !== line) {
            modified = true;
            fileEdits.push({ line: lineNum, fixer: "unreferenced-exports", before: trimmed, after: stripped.trim() });
            line = stripped;
        }
    }

    if (isLuau && !wasInLongBracket) {
        const prevLen = fileEdits.length;
        const luauRes = applyLuauLineFixers(
            line,
            trimmed,
            lineNum,
            flags,
            canHoistHere,
            hoistedServices,
            fileEdits,
            shadowedSchedulerNames,
        );
        if (fileEdits.length > prevLen) modified = true;
        if (luauRes.action === "remove") return { modified };
        if (luauRes.action === "split") {
            mappedLines.push({ text: luauRes.lines[0], origLine: lineNum });
            pendingParents.push({ varName: luauRes.varName, parentLine: luauRes.lines[1] });
            return { modified };
        }
        line = luauRes.line;
    }

    mappedLines.push({ text: line, origLine: lineNum });
    return { modified };
}

function autofixSingleFileLines(lines, isLuau, flags, existingTopServices, unrefExportLines = new Set()) {
    let modified = false;
    const fileEdits = [];
    let mappedLines = [];
    const hoistedServices = new Set();
    const shadowedSchedulerNames = isLuau && flags.wantScheduler ? collectShadowedLuauSchedulerNames(lines) : new Set();

    if (isLuau && flags.wantStrictHeader) {
        const firstNonEmpty = lines.find((l) => l.trim().length > 0) || "";
        if (!/^--!(?:strict|nonstrict|nocheck)\b/.test(firstNonEmpty.trim())) {
            mappedLines.push({ text: "--!strict", origLine: null });
            modified = true;
            fileEdits.push({ line: 1, fixer: "luau-strict-header", before: firstNonEmpty, after: "--!strict" });
        }
    }

    const luauState = { inLuauFunctionDepth: 0, chunkFactoryDepth: 0, luauBlockStack: [], luauLongClose: null };
    const pendingParents = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const lineNum = i + 1;
        const { wasInLongBracket, canHoistHere } = stepLuauFixLineState(isLuau, line, trimmed, luauState);
        flushPendingParentsInto(mappedLines, pendingParents, line);

        const stepRes = processSingleFixLine(
            line,
            trimmed,
            lines,
            i,
            lineNum,
            isLuau,
            wasInLongBracket,
            canHoistHere,
            flags,
            hoistedServices,
            shadowedSchedulerNames,
            unrefExportLines,
            pendingParents,
            mappedLines,
            fileEdits,
        );
        if (stepRes.modified) modified = true;
    }

    flushPendingParentsInto(mappedLines, pendingParents, null);
    mappedLines = insertHoistedLuauServices(mappedLines, hoistedServices, existingTopServices);
    const nextLines = mappedLines.map((m) => m.text);
    const lineMapper = modified ? buildLineRemapper(mappedLines, lines.length) : null;
    return { modified, nextLines, fileEdits, lineMapper };
}

const FIXER_TO_DETECTORS = {
    "debug-logs": new Set(["debug_logs"]),
    "unused-imports": new Set(["unused_imports", "dead_symbols", "language_traps", "luau_quality"]),
    "unreferenced-exports": new Set(["unreferenced_exports"]),
    "luau-task-scheduler": new Set(["luau_quality", "language_traps"]),
    "luau-strict-header": new Set(["luau_quality", "type_bypasses"]),
    "luau-instance-new-parent": new Set(["luau_quality"]),
    "luau-hoist-getservice": new Set(["luau_quality"]),
};

function shiftRemainingOpenIssuesInFile(state, relPath, lineMapper, justFixedIds) {
    if (!lineMapper || !state?.issues) return;
    for (const [id, iss] of Object.entries(state.issues)) {
        if (justFixedIds.has(id) || iss.file !== relPath) continue;
        if (iss.status !== "open" && iss.status !== "deferred") continue;
        if (!Number.isFinite(iss.line) || iss.line < 1) continue;
        const oldEnd = Number.isFinite(iss.end_line) && iss.end_line >= iss.line ? iss.end_line : iss.line;
        const newStart = lineMapper(iss.line, false);
        const newEnd = Math.max(newStart, lineMapper(oldEnd, true));
        if (newStart !== iss.line || newEnd !== oldEnd) {
            iss.line = newStart;
            iss.end_line = newEnd;
            iss.span = `L${newStart}-L${newEnd}`;
        }
    }
}

function issueMatchesAutofixEdit(iss, relPath, edit, detSet) {
    if (iss.status !== "open" || iss.file !== relPath || !detSet.has(iss.detector))
        return false;
    return (
        edit.fixer === "luau-strict-header" ||
        iss.line === edit.line ||
        Boolean(iss.end_line && edit.line >= iss.line && edit.line <= iss.end_line)
    );
}

function markAutofixIssueFixed(iss, id, fixer, nowIso, resolvedIds, justFixedSet, plan) {
    iss.status = "fixed";
    iss.verified = false;
    iss.resolved_at = nowIso;
    iss.resolved_by = `autofix:${fixer}`;
    iss.note = `Auto-fixed by ${fixer}`;
    resolvedIds.push(id);
    justFixedSet.add(id);
    if (!plan) return;
    if (!Array.isArray(plan.uncommitted_resolved)) plan.uncommitted_resolved = [];
    if (!plan.uncommitted_resolved.includes(id)) plan.uncommitted_resolved.push(id);
}

function reconcileAutofixWithState(changes, state, plan) {
    if (!state || !state.issues) return [];
    const resolvedIds = [];
    const justFixedSet = new Set();
    const nowIso = new Date().toISOString();

    for (const fileChange of changes) {
        const relPath = fileChange.file;
        for (const edit of fileChange.edits) {
            const detSet = FIXER_TO_DETECTORS[edit.fixer] || new Set();
            for (const [id, iss] of Object.entries(state.issues)) {
                if (issueMatchesAutofixEdit(iss, relPath, edit, detSet)) {
                    markAutofixIssueFixed(iss, id, edit.fixer, nowIso, resolvedIds, justFixedSet, plan);
                }
            }
        }
        shiftRemainingOpenIssuesInFile(state, relPath, fileChange.lineMapper, justFixedSet);
    }
    return resolvedIds;
}

function buildAutofixFlags(fixerName) {
    return {
        wantScheduler: fixerName === "all" || fixerName === "luau-task-scheduler" || fixerName === "luau",
        wantStrictHeader: fixerName === "luau-strict-header",
        wantInstanceNewParent: fixerName === "all" || fixerName === "luau-instance-new-parent" || fixerName === "luau",
        wantHoistGetService: fixerName === "luau-hoist-getservice",
        wantUnusedImports: fixerName === "unused-imports",
        wantDebugLogs: fixerName === "all" || fixerName === "debug-logs",
        wantUnreferencedExports: fixerName === "unreferenced-exports",
    };
}

function autofixRepoFileNode(relPath, absPath, flags, unrefByFile, dryRun, abortedFiles, changes) {
    const rawContent = readFileSync(absPath, "utf8");
    const eol = rawContent.includes("\r\n") ? "\r\n" : "\n";
    const lines = rawContent.split(/\r?\n/);
    const ext = extname(relPath).toLowerCase();
    const isLuau = ext === ".luau" || ext === ".lua";
    const existingTopServices = isLuau ? scanExistingTopLuauServices(lines) : new Set();
    const unrefLines = unrefByFile.get(relPath) || new Set();

    const { modified, nextLines, fileEdits, lineMapper } = autofixSingleFileLines(
        lines,
        isLuau,
        { ...flags, isPy: ext === ".py" },
        existingTopServices,
        unrefLines,
    );
    if (!modified) return;

    const candidateText = nextLines.join(eol);
    const beforeErrors = countSyntaxErrorsWithTreeSitter(relPath, rawContent);
    const afterErrors = countSyntaxErrorsWithTreeSitter(relPath, candidateText);
    if (beforeErrors !== null && afterErrors !== null && afterErrors > beforeErrors) {
        abortedFiles.push({ file: relPath, reason: "syntax_error_increase", before_errors: beforeErrors, after_errors: afterErrors });
        return;
    }

    if (!dryRun) writeFileSync(absPath, candidateText, "utf8");
    const changeEntry = { file: relPath, edits: fileEdits };
    Object.defineProperty(changeEntry, "lineMapper", { value: lineMapper, enumerable: false });
    changes.push(changeEntry);
}

/**
 * Run a mechanical auto-fixer (`--dry-run` previews changes without writing).
 */
export function runAutofix(rootDir, graph, zoneMap, ignoreRules, fixerName = "all", opts = {}) {
    if (fixerName !== "all" && fixerName !== "luau" && !AVAILABLE_FIXERS.includes(fixerName)) {
        throw new Error(`Unknown autofix fixer "${fixerName}". Available: all, luau, ${AVAILABLE_FIXERS.join(", ")}`);
    }
    const dryRun = Boolean(opts.dryRun);
    const gitCtx = detectGitContext(rootDir);
    const changes = [];
    const abortedFiles = [];
    const flags = buildAutofixFlags(fixerName);

    const absRoot = resolve(rootDir);
    let realRoot = absRoot;
    try {
        realRoot = realpathSync(absRoot);
    } catch { /* fallback */ }
    const unrefByFile = flags.wantUnreferencedExports ? collectUnreferencedExportLinesByFile(graph, rootDir) : new Map();

    for (const fNode of graph.nodes) {
        if (fNode.kind !== "file") continue;
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone) || ignoreRules.isIgnored(fNode.path)) continue;
        const safeFile = resolveSafeRepoFile(absRoot, realRoot, fNode.path, { noSymlinks: true });
        if (safeFile) autofixRepoFileNode(fNode.path, safeFile.realFile, flags, unrefByFile, dryRun, abortedFiles, changes);
    }

    const reconciledIds = !dryRun ? reconcileAutofixWithState(changes, opts.state, opts.plan) : [];
    return {
        fixer: fixerName,
        dry_run: dryRun,
        git_dirty_warning: gitCtx.has_uncommitted ? "Working tree has uncommitted changes before autofix." : null,
        files_changed: changes.length,
        total_edits: changes.reduce((acc, c) => acc + c.edits.length, 0),
        reconciled_issue_ids: reconciledIds,
        aborted_files: abortedFiles,
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

function registerSelfRelocatedImportMaps(fileRel, effectiveFileRel, ext, allFiles, movedOldSet, specMap, rbxMap) {
    if (fileRel === effectiveFileRel) return;
    for (const otherRel of allFiles) {
        if (movedOldSet.has(otherRel)) continue;
        registerRelativeSpecifierPairs(specMap, fileRel, otherRel, effectiveFileRel, otherRel);
        if (ext === ".luau" || ext === ".lua") {
            const oldRbx = computeRobloxScriptRequire(fileRel, otherRel);
            const newRbx = computeRobloxScriptRequire(effectiveFileRel, otherRel);
            if (oldRbx !== newRbx && !rbxMap.has(oldRbx)) rbxMap.set(oldRbx, newRbx);
        }
    }
}

function registerPartnerMovedImportMaps(fileRel, effectiveFileRel, ext, movePairs, specMap, rbxMap, pyModMap) {
    for (const { oldPath, newPath } of movePairs) {
        if (fileRel === oldPath && effectiveFileRel === newPath) continue;
        registerRelativeSpecifierPairs(specMap, fileRel, oldPath, effectiveFileRel, newPath);
        if (ext === ".py" && oldPath.endsWith(".py")) {
            const oldMod = oldPath.replace(/\.py$/i, "").replace(/\//g, ".");
            const newMod = newPath.replace(/\.py$/i, "").replace(/\//g, ".");
            if (oldMod !== newMod && !pyModMap.has(oldMod)) pyModMap.set(oldMod, newMod);
        }
        if ((ext === ".luau" || ext === ".lua") && /\.(?:luau|lua)$/i.test(oldPath)) {
            const oldRbx = computeRobloxScriptRequire(fileRel, oldPath);
            const newRbx = computeRobloxScriptRequire(effectiveFileRel, newPath);
            if (oldRbx !== newRbx && !rbxMap.has(oldRbx)) rbxMap.set(oldRbx, newRbx);
        }
    }
}

function applyMovedImportMapRewrites(raw, specMap, rbxMap, pyModMap) {
    let updated = raw;
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

function rewriteMovedFileImports(raw, fileRel, effectiveFileRel, ext, movePairs, allFiles, movedOldSet) {
    const specMap = new Map();
    const rbxMap = new Map();
    const pyModMap = new Map();
    registerSelfRelocatedImportMaps(fileRel, effectiveFileRel, ext, allFiles, movedOldSet, specMap, rbxMap);
    registerPartnerMovedImportMaps(fileRel, effectiveFileRel, ext, movePairs, specMap, rbxMap, pyModMap);
    return applyMovedImportMapRewrites(raw, specMap, rbxMap, pyModMap);
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

function isInsideGitWorktree(absRoot) {
    try {
        const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: absRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out === "true";
    } catch {
        return false;
    }
}

function copyDirRecursive(srcDir, dstDir) {
    mkdirSync(dstDir, { recursive: true });
    for (const ent of readdirSync(srcDir, { withFileTypes: true })) {
        const s = join(srcDir, ent.name);
        const d = join(dstDir, ent.name);
        if (ent.isDirectory()) {
            copyDirRecursive(s, d);
        } else {
            copyFileSync(s, d);
        }
    }
}

function moveFilesystemPath(absSrc, absDst, relSrc, relDst, absRoot, inGitWorktree) {
    mkdirSync(dirname(absDst), { recursive: true });
    if (inGitWorktree) {
        try {
            execFileSync("git", ["mv", relSrc, relDst], {
                cwd: absRoot,
                stdio: ["ignore", "pipe", "pipe"],
            });
            return "git_mv";
        } catch {
            // Untracked or partial git tree; fall through to fs rename.
        }
    }
    try {
        renameSync(absSrc, absDst);
        return "rename";
    } catch (err) {
        if (!err || err.code !== "EXDEV") throw err;
        if (statSync(absSrc).isDirectory()) {
            copyDirRecursive(absSrc, absDst);
            rmSync(absSrc, { recursive: true, force: true });
        } else {
            copyFileSync(absSrc, absDst);
            unlinkSync(absSrc);
        }
        return "copy_unlink";
    }
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
    } catch { /* fallback */ }

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
    let moveMethod = dryRun ? "dry_run" : null;
    let rebuildPromise = null;
    if (!dryRun) {
        moveMethod = moveFilesystemPath(absSrc, absDst, relSrc, relDst, absRoot, isInsideGitWorktree(absRoot));
        for (const u of importerUpdates) {
            writeFileSync(join(absRoot, u.effective_file), u.content, "utf8");
        }
        if (opts.state || opts.plan) {
            const remapped = remapMovedIssuePaths(opts.state, opts.plan, moveMap);
            remappedIssues = remapped.remapped_count;
        }
        const ctxDir = opts.contextDir || contextDirFor(absRoot);
        invalidateGraphCaches(ctxDir);
        if (opts.rebuildGraph !== false) {
            rebuildPromise = buildGraph(absRoot, { contextDir: ctxDir }).catch(() => null);
        }
    }

    const result = {
        dry_run: dryRun,
        from: relSrc,
        to: relDst,
        move_method: moveMethod,
        files_moved: movePairs.length,
        updated_importers: importerUpdates.map((u) => u.effective_file || u.file),
        remapped_issues: remappedIssues,
    };
    if (rebuildPromise) {
        Object.defineProperty(result, "_rebuildPromise", { value: rebuildPromise, enumerable: false });
    }
    return result;
}
