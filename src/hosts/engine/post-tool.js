import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { editedFilePath, handlePostEdit, handleStop, recordFileEdit } from '../../claude/hooks.js';
import { formatBlastRadius } from '../../claude/format.js';
import { loadGraphCached } from '../../context/graph-store.js';
import { nearestPlexerRoot } from '../../graph/root.js';
import { pickRepoForTargetPath } from '../../agy/multi-workspace.js';
import { buildPlanExecutionHandoff } from '../../agy/plan-handoff.js';
import { invalidateEditedSpans, mergeSpan, normalizeRelFile } from '../../agy/spans.js';
import { checkSwarmEditCollision } from '../../agy/swarm-sync.js';
import { contextDirFor } from '../../util/paths.js';
import { spanRange } from '../../util/span.js';
import { readStats } from '../../util/state.js';
import { isGeminiModelProfile } from './prompt/budget.js';
import { isIgnoredTouchedPath } from './agy-transcript.js';
import {
    HOST_KINDS, activeWorkspaceDirs, buildMidLoopHint, emitHookPayload, findNearestRepoAncestor,
    isEarlyIsolatedBenchCall, isIsolatedBenchDir, labelPrefixForRepo, loadAgyContext,
    readEngineSession, resolveHostProjectDir, resolveHostSessionId, resolveToolTargetPath,
    saveAgyContext, unquoteArg,
} from './agy-context.js';

const READ_TOOLS_RE = /^(?:read_file|view_file|Read)$/i;
const EDIT_TOOLS_RE = /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|Edit|Write|MultiEdit|apply_patch|replace)$/i;
const AGY_READ_MAX_LINES = 800;
const AGY_READ_MAX_BYTES = 46080;

function computeEffectiveReadEndLine(absTarget, startLine) {
    try {
        if (!absTarget || !existsSync(absTarget))
            return startLine + AGY_READ_MAX_LINES - 1;
        const st = statSync(absTarget);
        if (!st.isFile() || st.size === 0 || st.size > 512 * 1024)
            return startLine + AGY_READ_MAX_LINES - 1;
        const raw = readFileSync(absTarget, 'utf8');
        const lines = raw.split(/\r\n|\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '')
            lines.pop();
        if (startLine > lines.length)
            return Math.max(startLine, lines.length);
        const maxEnd = Math.min(lines.length, startLine + AGY_READ_MAX_LINES - 1);
        let bytes = 0;
        let end = startLine - 1;
        for (let ln = startLine; ln <= maxEnd; ln++) {
            const lb = Buffer.byteLength(lines[ln - 1], 'utf8') + 1;
            if (end >= startLine && bytes + lb > AGY_READ_MAX_BYTES)
                break;
            bytes += lb;
            end = ln;
        }
        return Math.max(startLine, end);
    }
    catch {
        return startLine + AGY_READ_MAX_LINES - 1;
    }
}

function isInsideArtifactDir(targetPath, artifactDir) {
    if (!targetPath || !artifactDir || !targetPath.toLowerCase().endsWith('.md')) return false;
    const rel = relative(resolve(artifactDir), resolve(targetPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isPlanToolCall(toolName, toolInput, input, targetPath = '') {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return true;
    if (!/^(?:write_file|edit_file|write_to_file|replace_file_content)$/i.test(toolName)) return false;
    if (!targetPath || basename(targetPath).toLowerCase() !== 'implementation_plan.md') return false;
    if (toolInput?.ArtifactMetadata?.RequestFeedback === false) return false;
    return toolInput?.ArtifactMetadata?.RequestFeedback === true
        || isInsideArtifactDir(targetPath, input?.artifactDirectoryPath ?? '');
}

function extractPlanText(toolName, toolInput, input, targetPath) {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') {
        const direct = toolInput?.plan ?? input?.toolCall?.output ?? input?.tool_response ?? '';
        return typeof direct === 'string' ? direct : '';
    }
    const inline = toolInput?.CodeContent ?? toolInput?.Content ?? toolInput?.content
        ?? toolInput?.ReplacementContent ?? toolInput?.new_string ?? '';
    let diskText = '';
    if (targetPath && existsSync(targetPath)) {
        try {
            const raw = readFileSync(targetPath, 'utf8');
            if (raw.length <= 65536) diskText = raw;
        } catch { /* ignore unreadable artifact */ }
    }
    return diskText && diskText.length >= String(inline).length ? diskText : String(inline || diskText);
}

export function stagePlanHandoff({ workspaceDirs, toolName, toolInput, input, targetPath, agyState, opts = {} }) {
    const resolvedTarget = targetPath || unquoteArg(toolInput?.Path ?? toolInput?.TargetFile ?? toolInput?.AbsolutePath ?? toolInput?.file_path ?? '');
    if (!isPlanToolCall(toolName, toolInput, input, resolvedTarget)) return null;
    const isExitPlan = toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode';
    if (isExitPlan) {
        agyState.orchestratorPhase = 'execute';
        agyState.pendingPlanAwaitApproval = false;
    }
    const planText = extractPlanText(toolName, toolInput, input, resolvedTarget);
    const geminiProfile = isGeminiModelProfile(input, opts.hostKind || 'agy');
    const handoff = buildPlanExecutionHandoff(workspaceDirs, planText, agyState, { getGraph: opts.getGraph, geminiProfile });
    agyState.pendingPlanHandoff = handoff?.text || null;
    agyState.pendingPlanSpans = handoff?.text ? (handoff.spans ?? []) : [];
    agyState.pendingPlanAwaitApproval = Boolean(!isExitPlan && handoff?.text);
    return handoff;
}

export function recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs, recordMidLoop = true }) {
    if (!targetPath || !existsSync(contextDirFor(repoRoot))) return null;
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(targetPath)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const startLine = Math.max(1, Number(toolArgs?.StartLine ?? toolArgs?.start_line ?? toolArgs?.offset ?? 1) || 1);
    const limit = Number(toolArgs?.limit ?? 0);
    const explicitEnd = Number(toolArgs?.EndLine ?? toolArgs?.end_line ?? (limit > 0 ? startLine + limit - 1 : 0));
    const endLine = Number.isFinite(explicitEnd) && explicitEnd >= startLine
        ? explicitEnd
        : computeEffectiveReadEndLine(resolve(repoRoot, rel), startLine);
    const key = `${labelPrefixForRepo(workspaceDirs, repoRoot)}${rel}`;
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    mergeSpan(agyState.seenSpans, key, startLine, endLine);
    agyState.lastReadRelFile = rel;
    if (recordMidLoop && !agyState.turn0Matched && !agyState.midLoopHintEmitted && !agyState.pendingMidLoopFile) {
        agyState.pendingMidLoopFile = rel;
    }
    return rel;
}

const SIG_OR_EXPORT_RE = /^\s*(?:export\b|module\.exports\b|exports\.|__all__\b|pub(?:\([^)]*\))?\s+(?:async\s+|unsafe\s+|const\s+)*(?:fn|struct|enum|trait|type|mod|const|static|use)\b|(?:async\s+)?function\*?\b|class\b|interface\b|enum\b|type\s+[A-Za-z_$][\w$]*\s*[=<{]|(?:async\s+)?def\s+|func\s+|(?:local\s+)?function\s+|(?:public|private|protected|internal|static|virtual|override|abstract)\s+[^;=]*\()/;
const HEADER_BODY_OPEN_RE = /(?:[{;]\s*(?:\/\/.*)?$|:\s*(?:#.*)?$|\bthen\s*(?:--.*)?$|\bdo\s*(?:--.*)?$)/;

function extractEditChunks(toolArgs) {
    if (!toolArgs || typeof toolArgs !== 'object') return null;
    if (Array.isArray(toolArgs.ReplacementChunks) && toolArgs.ReplacementChunks.length > 0) {
        return toolArgs.ReplacementChunks.map((c) => ({
            oldText: String(c?.TargetContent ?? ''),
            newText: String(c?.ReplacementContent ?? ''),
            startLine: Number(c?.StartLine) || 0,
        }));
    }
    if (Array.isArray(toolArgs.edits) && toolArgs.edits.length > 0) {
        return toolArgs.edits.map((e) => ({
            oldText: String(e?.old_string ?? e?.Target ?? ''),
            newText: String(e?.new_string ?? e?.Replacement ?? ''),
            startLine: Number(e?.StartLine) || 0,
        }));
    }
    const directOld = toolArgs.Target ?? toolArgs.TargetContent ?? toolArgs.old_string ?? toolArgs.oldText;
    const directNew = toolArgs.Replacement ?? toolArgs.ReplacementContent ?? toolArgs.new_string ?? toolArgs.newText;
    if (typeof directOld === 'string' || typeof directNew === 'string') {
        return [{
            oldText: String(directOld ?? ''),
            newText: String(directNew ?? ''),
            startLine: Number(toolArgs.StartLine ?? toolArgs.start_line) || 0,
        }];
    }
    if (typeof toolArgs.patch === 'string' && toolArgs.patch.trim()) {
        const removed = [];
        const added = [];
        for (const line of toolArgs.patch.split(/\r?\n/)) {
            if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
            if (line.startsWith('-')) removed.push(line.slice(1));
            else if (line.startsWith('+')) added.push(line.slice(1));
        }
        return [{ oldText: removed.join('\n'), newText: added.join('\n'), startLine: 0 }];
    }
    return null;
}

function readDiskLinesSafe(editedFile) {
    try {
        if (!editedFile || !existsSync(editedFile)) return null;
        return readFileSync(editedFile, 'utf8').split(/\r?\n/);
    } catch { return null; }
}

function diffChunkLines(oldText, newText) {
    const oldLines = String(oldText ?? '').split(/\r?\n/);
    const newLines = String(newText ?? '').split(/\r?\n/);
    const minLen = Math.min(oldLines.length, newLines.length);
    let prefixLen = 0;
    while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) prefixLen++;
    let suffixLen = 0;
    while (suffixLen < minLen - prefixLen && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) suffixLen++;
    return {
        newLines,
        prefixLen,
        changedOld: oldLines.slice(prefixLen, oldLines.length - suffixLen),
        changedNew: newLines.slice(prefixLen, newLines.length - suffixLen),
    };
}

function findChunkStartLineOnDisk(diskLines, needleLines) {
    if (!diskLines?.length || !needleLines?.length) return 0;
    const needle = needleLines.length > 1 && needleLines[needleLines.length - 1] === ''
        ? needleLines.slice(0, -1)
        : needleLines;
    if (needle.length === 0 || needle.length > diskLines.length) return 0;
    const first = needle[0];
    const maxI = diskLines.length - needle.length;
    for (let i = 0; i <= maxI; i++) {
        if (diskLines[i] !== first) continue;
        let ok = true;
        for (let j = 1; j < needle.length; j++) {
            if (diskLines[i + j] !== needle[j]) { ok = false; break; }
        }
        if (ok) return i + 1;
    }
    return 0;
}

function resolveMinChangedLine(editedFile, chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return 1;
    let diskLines = null;
    let minChanged = Infinity;
    for (const chunk of chunks) {
        const { newLines, prefixLen } = diffChunkLines(chunk?.oldText, chunk?.newText);
        let baseStart = Number(chunk?.startLine) > 0 ? Number(chunk.startLine) : 0;
        if (!baseStart && chunk?.newText) {
            diskLines ??= readDiskLinesSafe(editedFile);
            baseStart = findChunkStartLineOnDisk(diskLines, newLines);
        }
        if (baseStart > 0 && (baseStart + prefixLen) < minChanged) {
            minChanged = baseStart + prefixLen;
        }
    }
    return Number.isFinite(minChanged) ? minChanged : 1;
}

function hasSeenFileInState(seenSpans, relNorm, prefix = '') {
    if (!seenSpans || typeof seenSpans !== 'object' || !relNorm) return false;
    for (const key of [relNorm, prefix ? `${prefix}${relNorm}` : '']) {
        if (key && Array.isArray(seenSpans[key]) && seenSpans[key].length > 0) return true;
    }
    for (const [k, ranges] of Object.entries(seenSpans)) {
        if (!Array.isArray(ranges) || ranges.length === 0) continue;
        const nk = normalizeRelFile(k);
        if (nk === relNorm || nk.endsWith(`/${relNorm}`)) return true;
    }
    return false;
}

export function editTouchesSignatureOrExport(repoRoot, editedFile, rel, toolArgs, opts = {}) {
    const chunks = extractEditChunks(toolArgs);
    if (!chunks || chunks.length === 0) {
        const graph = typeof opts.getGraph === 'function' ? opts.getGraph(repoRoot) : loadGraphCached(contextDirFor(repoRoot));
        return Boolean(graph?._nodesByPath?.has(rel) || (graph?.nodes ?? []).some((n) => n.path === rel));
    }
    const graph = typeof opts.getGraph === 'function' ? opts.getGraph(repoRoot) : loadGraphCached(contextDirFor(repoRoot));
    const nodeStarts = [];
    for (const n of graph?.nodes ?? []) {
        if (n.kind === 'file' || n.path !== rel) continue;
        const r = spanRange(n.span);
        if (r?.start) nodeStarts.push(r.start);
    }
    let diskLines = null;
    for (const chunk of chunks) {
        const { prefixLen, changedOld, changedNew } = diffChunkLines(chunk.oldText, chunk.newText);
        if (changedOld.length === 0 && changedNew.length === 0) continue;
        const oldHasCode = changedOld.some((line) => line.trim() !== '' && !/^\s*(?:\/\/|#|--|\/\*|\*)/.test(line));
        const sigChanged = changedOld.some((line) => SIG_OR_EXPORT_RE.test(line))
            || (oldHasCode && changedNew.some((line) => SIG_OR_EXPORT_RE.test(line)));
        if (sigChanged) return true;
        if (chunk.startLine > 0 && nodeStarts.length > 0 && oldHasCode) {
            const chgStart = chunk.startLine + prefixLen;
            const spanLen = Math.max(changedOld.length, changedNew.length, 1);
            const chgEnd = chgStart + spanLen - 1;
            if (nodeStarts.some((ns) => ns >= chgStart && ns <= chgEnd)) return true;
            for (const ns of nodeStarts) {
                if (ns < chgStart && chgStart <= ns + 3) {
                    if (!diskLines) diskLines = readDiskLinesSafe(editedFile);
                    const headerSlice = diskLines ? diskLines.slice(ns - 1, chgStart - 1) : [];
                    if (headerSlice.length > 0 && !headerSlice.some((l) => HEADER_BODY_OPEN_RE.test(l))) return true;
                }
            }
        }
    }
    return false;
}

export function markEditMutationOnState(agyState) {
    if (!agyState || typeof agyState !== 'object') return;
    agyState.editedInPrompt = true;
    agyState.editSeq = (Number(agyState.editSeq) || 0) + 1;
    agyState.seenSearchKeys = [];
    agyState.lastBlockedSearchKey = null;
}

export function recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, opts = {}, toolArgs = null) {
    if (!targetPath || isIgnoredTouchedPath(targetPath, repoRoot) || !existsSync(contextDirFor(repoRoot))) return;
    markEditMutationOnState(agyState);
    const editedFile = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(editedFile)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    agyState.lastTouchedPath = editedFile;
    recordFileEdit(repoRoot, editedFile);
    const prefix = labelPrefixForRepo(workspaceDirs, repoRoot);
    const key = `${prefix}${rel}`;
    agyState.emittedBlastFiles = Array.isArray(agyState.emittedBlastFiles) ? agyState.emittedBlastFiles : [];
    const alreadyInTurn0 = (agyState.injectedPointers ?? []).some((p) => {
        const pFile = String(p).split(':')[0].replace(/\\/g, '/');
        return pFile === rel || pFile === key || rel.endsWith(`/${pFile}`);
    });
    const chunks = extractEditChunks(toolArgs);
    const minChangedLine = resolveMinChangedLine(editedFile, chunks);
    invalidateEditedSpans(agyState.seenSpans, key, minChangedLine);
    if (agyState.fileSliceCounts && typeof agyState.fileSliceCounts === 'object') {
        delete agyState.fileSliceCounts[rel];
        delete agyState.fileSliceCounts[key];
    }
    if (agyState.lastFileReadEnd && typeof agyState.lastFileReadEnd === 'object') {
        delete agyState.lastFileReadEnd[rel];
        delete agyState.lastFileReadEnd[key];
    }
    if (!agyState.emittedBlastFiles.includes(key) && !alreadyInTurn0 && editTouchesSignatureOrExport(repoRoot, editedFile, rel, toolArgs, opts)) {
        const graph = typeof opts.getGraph === 'function' ? opts.getGraph(repoRoot) : loadGraphCached(contextDirFor(repoRoot));
        const br = graph
            ? formatBlastRadius(graph, editedFile, 8, repoRoot, {
                maxBytes: 600,
                isPathSeen: (callerRel) => hasSeenFileInState(agyState.seenSpans, normalizeRelFile(callerRel), prefix),
            })
            : null;
        if (br) {
            agyState.emittedBlastFiles.push(key);
            agyState.pendingBlastRadius = agyState.pendingBlastRadius && !agyState.pendingBlastRadius.includes(br)
                ? `${agyState.pendingBlastRadius}\n${br}` : (agyState.pendingBlastRadius || br);
        }
    }
    const sid = opts.sessionId || opts.sid || null;
    if (sid) checkSwarmEditCollision(sid, repoRoot, editedFile, agyState, opts);
    if (typeof opts.onFileEdited === 'function') opts.onFileEdited(repoRoot, editedFile);
}

export function handleAgyPostTool(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload('{}\n', opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    const toolName = String(input?.toolCall?.name ?? input?.tool_name ?? '');
    const toolArgs = input?.toolCall?.args ?? input?.tool_input ?? input?.args ?? {};
    const targetPath = resolveToolTargetPath(input);
    const repoRoot = pickRepoForTargetPath(targetPath, workspaceDirs, dir);
    const callOpts = opts.sessionId ? opts : { ...opts, sessionId: sid };
    const staged = stagePlanHandoff({ workspaceDirs, toolName, toolInput: toolArgs, input, targetPath, agyState, opts: callOpts });
    if (staged) { saveAgyContext(sid, agyState, opts); return emitHookPayload('{}\n', opts); }
    if (!isIsolatedBenchDir(repoRoot, opts.envFlags)) {
        if (READ_TOOLS_RE.test(toolName)) recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs });
        else if (EDIT_TOOLS_RE.test(toolName)) {
            agyState.editedInPrompt = true;
            recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, callOpts, toolArgs);
        }
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload('{}\n', opts);
}

export function handleAgyPostEdit(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload('{}\n', opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    const rawTarget = resolveToolTargetPath(input) || agyState.lastEditedFile;
    const toolArgs = input?.toolCall?.args ?? input?.tool_input ?? input?.args ?? null;
    const callOpts = opts.sessionId ? opts : { ...opts, sessionId: sid };
    agyState.lastEditedFile = null;
    agyState.editedInPrompt = true;
    if (rawTarget) {
        const repoRoot = pickRepoForTargetPath(rawTarget, workspaceDirs, findNearestRepoAncestor(rawTarget) ?? dir);
        if (!isIsolatedBenchDir(repoRoot, opts.envFlags)) recordEditBlastForAgy(workspaceDirs, repoRoot, rawTarget, agyState, callOpts, toolArgs);
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload('{}\n', opts);
}

export function handleAgyStop(input, opts = {}) {
    const allow = `${JSON.stringify({ decision: 'allow' })}\n`;
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload(allow, opts);
    const { agyState, dir } = loadAgyContext(input, opts);
    for (const wsDir of activeWorkspaceDirs(input, agyState, dir, opts)) {
        if (!isIsolatedBenchDir(wsDir, opts.envFlags)) {
            if (typeof opts.scheduleRefresh === 'function') {
                if (existsSync(contextDirFor(wsDir)) && readStats(wsDir)?.dirty) opts.scheduleRefresh(wsDir);
            } else {
                handleStop(input, wsDir);
            }
        }
    }
    return emitHookPayload(allow, opts);
}

function emitContextIfAny(hostKind, additionalContext, opts) {
    const spec = HOST_KINDS[hostKind] ?? HOST_KINDS.claude;
    if (!additionalContext) return emitHookPayload(spec.emptyPostTool, opts);
    return emitHookPayload(`${JSON.stringify({ hookSpecificOutput: { hookEventName: spec.postToolEvent, additionalContext } })}\n`, opts);
}

function handleHostReadPostTool(hostKind, root, targetPath, toolInput, sid, opts) {
    const targetRepo = nearestPlexerRoot(targetPath || root)?.root ?? root;
    if (isIsolatedBenchDir(targetRepo, opts.envFlags) || !existsSync(contextDirFor(targetRepo))) return emitContextIfAny(hostKind, '', opts);
    const agyState = readEngineSession(sid, opts);
    const rel = recordReadPostTool({ agyState, workspaceDirs: [targetRepo], repoRoot: targetRepo, targetPath, toolArgs: toolInput, recordMidLoop: false });
    let hint = null;
    if (rel && !agyState.turn0Matched && !agyState.midLoopHintEmitted) {
        hint = buildMidLoopHint(targetRepo, contextDirFor(targetRepo), rel, opts);
        agyState.midLoopHintEmitted = true;
    }
    saveAgyContext(sid, agyState, opts);
    return emitContextIfAny(hostKind, hint, opts);
}

export function handleHostPostTool(hostKind, input, opts = {}) {
    const spec = HOST_KINDS[hostKind] ?? HOST_KINDS.claude;
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (isIsolatedBenchDir(root, opts.envFlags)) return emitHookPayload(spec.emptyPostTool, opts);
    const toolName = String(input?.tool_name ?? input?.toolName ?? input?.toolCall?.name ?? spec.defaultPostToolName);
    const toolInput = input?.tool_input ?? input?.toolCall?.args ?? input?.args ?? {};
    const targetPath = unquoteArg(toolInput?.file_path ?? toolInput?.path ?? toolInput?.Path ?? input?.file_path ?? '');
    const sid = resolveHostSessionId(input, opts.envFlags);
    if (/^(?:Read|read_file|view_file)$/i.test(toolName)) return handleHostReadPostTool(hostKind, root, targetPath, toolInput, sid, opts);
    if (/^(?:ExitPlanMode|exit_plan_mode)$/i.test(toolName)) {
        const agyState = readEngineSession(sid, opts);
        const handoff = stagePlanHandoff({ workspaceDirs: [root], toolName, toolInput, input, targetPath, agyState, opts });
        if (handoff?.text) { agyState.pendingPlanHandoff = null; agyState.pendingPlanSpans = []; }
        saveAgyContext(sid, agyState, opts);
        return emitContextIfAny(hostKind, handoff?.text ?? '', opts);
    }
    const edited = editedFilePath(input, root) || targetPath;
    if (edited && !isIgnoredTouchedPath(edited, root)) {
        const agyState = readEngineSession(sid, opts);
        markEditMutationOnState(agyState);
        const rel = normalizeRelFile(relative(resolve(root), resolve(root, edited)));
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) invalidateEditedSpans(agyState.seenSpans, rel, 1);
        saveAgyContext(sid, agyState, opts);
    }
    if (hostKind === 'cursor') {
        if (edited) recordFileEdit(root, edited);
        return emitHookPayload('{}\n', opts);
    }
    if (hostKind === 'gemini') return emitContextIfAny('gemini', edited ? recordFileEdit(root, edited) : null, opts);
    return handlePostEdit({ ...input, session_id: sid, tool_input: { ...(input?.tool_input ?? {}), ...(edited ? { file_path: edited } : {}) } }, root, opts);
}

export function handleHostStopHook(input, opts = {}) {
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (!isIsolatedBenchDir(root, opts.envFlags)) handleStop(input, root);
    return emitHookPayload('', opts);
}
