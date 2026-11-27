import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { editedFilePath, handleStop, recordFileEdit } from '../../claude/edit-hooks.js';
import { formatBlastRadius } from '../../claude/format.js';
import { loadGraphCached } from '../../context/graph-store.js';
import { nearestPlexerRoot } from '../../graph/root.js';
import { pickRepoForTargetPath } from '../../agy/multi-workspace.js';
import { buildPlanExecutionHandoff, resolvePlanTargetFiles } from '../../agy/plan-handoff.js';
import { invalidateEditedSpans, mergeSpan, normalizeRelFile } from '../../agy/spans.js';
import { detectShellSourceEdit, tokenizeShellSegment } from '../../agy/shell-rewrite.js';
import { checkSwarmEditCollision } from '../../agy/swarm-sync.js';
import { contextDirFor } from '../../util/paths.js';
import { spanRange } from '../../util/span.js';
import { readSession, readStats, writeSession } from '../../util/state.js';
import { isExtraHighEffortInput, isGeminiModelProfile, isHighOrExtraHighEffortInput, isOrchestratorInput } from './prompt/budget.js';
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
const READ_CHUNK_SIZE = 65536;
const MAX_OFFSET_SCAN_BYTES = 8 * 1024 * 1024;

function findByteOffsetForLine(fd, targetLine, fileSize) {
    if (targetLine <= 1) return 0;
    const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let pos = 0;
    let line = 1;
    const limit = Math.min(fileSize, MAX_OFFSET_SCAN_BYTES);
    while (pos < limit) {
        const toRead = Math.min(READ_CHUNK_SIZE, limit - pos);
        const bytesRead = readSync(fd, buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 10) {
                line += 1;
                if (line >= targetLine) return pos + i + 1;
            }
        }
        pos += bytesRead;
    }
    return null;
}

function computeEffectiveReadEndLine(absTarget, startLine, maxRequestedEnd = Infinity) {
    const reqCap = Number.isFinite(maxRequestedEnd) && maxRequestedEnd >= startLine
        ? Math.min(maxRequestedEnd, startLine + AGY_READ_MAX_LINES - 1)
        : startLine + AGY_READ_MAX_LINES - 1;
    let fd = null;
    try {
        if (!absTarget || !existsSync(absTarget))
            return reqCap;
        const st = statSync(absTarget);
        if (!st.isFile() || st.size === 0)
            return reqCap;
        fd = openSync(absTarget, 'r');
        const byteStart = findByteOffsetForLine(fd, startLine, st.size);
        if (byteStart === null || byteStart >= st.size)
            return startLine;
        const maxWindow = AGY_READ_MAX_BYTES + 4096;
        const toRead = Math.min(maxWindow, st.size - byteStart);
        const buf = Buffer.allocUnsafe(toRead);
        let totalRead = 0;
        while (totalRead < toRead) {
            const n = readSync(fd, buf, totalRead, toRead - totalRead, byteStart + totalRead);
            if (n <= 0) break;
            totalRead += n;
        }
        if (totalRead === 0) return startLine;
        const raw = buf.subarray(0, totalRead).toString('utf8');
        const lines = raw.split(/\r\n|\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '' && byteStart + totalRead >= st.size)
            lines.pop();
        const maxAvail = Math.min(lines.length, reqCap - startLine + 1);
        let bytes = 0;
        let end = startLine - 1;
        for (let i = 0; i < maxAvail; i++) {
            const lb = Buffer.byteLength(lines[i], 'utf8') + 1;
            if (end >= startLine && bytes + lb > AGY_READ_MAX_BYTES)
                break;
            bytes += lb;
            end = startLine + i;
        }
        return Math.max(startLine, end);
    }
    catch {
        return reqCap;
    }
    finally {
        if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
    }
}

function extractToolOutputLineRange(input) {
    const rawOut = input?.toolCall?.output ?? input?.tool_response ?? input?.toolOutput ?? input?.output ?? '';
    const text = typeof rawOut === 'string'
        ? rawOut
        : (typeof rawOut?.text === 'string' ? rawOut.text : (typeof rawOut?.content === 'string' ? rawOut.content : ''));
    if (!text) return null;
    const m = /\bShowing lines\s+(\d+)\s*[-–]\s*(\d+)\b/i.exec(text)
        || /\bPartial read\s*\(\s*lines\s+(\d+)\s*[-–]\s*(\d+)\b/i.exec(text);
    if (!m) return null;
    const start = Number.parseInt(m[1], 10);
    const end = Number.parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null;
    return { start, end };
}

function isInsideArtifactDir(targetPath, artifactDir) {
    if (!targetPath || !artifactDir || !targetPath.toLowerCase().endsWith('.md')) return false;
    const rel = relative(resolve(artifactDir), resolve(targetPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isEnterPlanToolCall(toolName) {
    return toolName === 'enter_plan_mode' || toolName === 'EnterPlanMode';
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
        const direct = toolInput?.plan ?? toolInput?.Plan ?? toolInput?.planContent ?? toolInput?.Instructions
            ?? input?.toolCall?.output ?? input?.tool_response ?? '';
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
    const planText = extractPlanText(toolName, toolInput, input, resolvedTarget);
    const planTargetFiles = resolvePlanTargetFiles(workspaceDirs, planText, { getGraph: opts.getGraph });
    if (planTargetFiles.length > 0) {
        agyState.planTargetFiles = [...new Set([...(agyState.planTargetFiles ?? []), ...planTargetFiles])];
        agyState.editTargetFiles = [...new Set([...(agyState.editTargetFiles ?? []), ...planTargetFiles])].slice(0, 6);
    }
    if (isExitPlan) {
        agyState.isOrchestratorModel = true;
        const m = String(input?.modelName ?? input?.model ?? '').trim();
        if (m) agyState.plannerModel = m;
        agyState.orchestratorPhase = 'execute';
        agyState.isEditPrompt = true;
        agyState.editedInPrompt = false;
        agyState.preEditInvocations = 0;
        agyState.preEditToolTurns = 0;
        agyState.lastPreEditToolAtMs = 0;
        agyState.exploreGuardStage = 0;
        agyState.exploreGuardEmitted = false;
        agyState.pendingPlanAwaitApproval = false;
    }
    if (opts.deferHandoffBuild && isExitPlan) {
        agyState.pendingPlanText = planText || null;
        agyState.pendingPlanWorkspaceDirs = Array.isArray(workspaceDirs) ? [...workspaceDirs] : [];
        agyState.pendingPlanHandoff = null;
        agyState.pendingPlanSpans = [];
        return { deferred: true, targetFiles: planTargetFiles };
    }
    const geminiProfile = isGeminiModelProfile(input, opts.hostKind || 'agy');
    const xhighProfile = isExtraHighEffortInput(input);
    const highProfile = isHighOrExtraHighEffortInput(input)
        || isHighOrExtraHighEffortInput({ modelName: agyState?.plannerModel })
        || (isOrchestratorInput(input, agyState) && !/(?:^|[-_\s(])(?:low|medium)(?:$|[)\s_-])/i.test(String(input?.modelName ?? agyState?.plannerModel ?? '')));
    const handoff = buildPlanExecutionHandoff(workspaceDirs, planText, agyState, {
        getGraph: opts.getGraph,
        geminiProfile,
        xhighProfile,
        highProfile,
        includeExecuteDirective: isExitPlan,
    });
    agyState.pendingPlanText = null;
    agyState.pendingPlanWorkspaceDirs = [];
    agyState.pendingPlanHandoff = handoff?.text || null;
    agyState.pendingPlanSpans = handoff?.text ? (handoff.spans ?? []) : [];
    agyState.pendingPlanAwaitApproval = Boolean(!isExitPlan && handoff?.text);
    return handoff;
}

export function recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs, input = null, recordMidLoop = true, hostKind = null }) {
    if (!repoRoot || !targetPath || !existsSync(contextDirFor(repoRoot))) return null;
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(targetPath)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const hasByteOffset = toolArgs?.ByteOffset !== undefined && toolArgs?.ByteOffset !== null && toolArgs?.ByteOffset !== '';
    const outputRange = extractToolOutputLineRange(input);
    if (hasByteOffset && !outputRange) return null;
    const absTarget = resolve(repoRoot, rel);
    const hasExplicitLineStart = toolArgs?.StartLine !== undefined && toolArgs?.StartLine !== null && toolArgs?.StartLine !== ''
        || (toolArgs?.start_line !== undefined && toolArgs?.start_line !== null && toolArgs?.start_line !== '');
    const hasOffset = toolArgs?.offset !== undefined && toolArgs?.offset !== null && toolArgs?.offset !== '';
    let parsedStart = Number(toolArgs?.StartLine ?? toolArgs?.start_line ?? 1);
    if (!hasExplicitLineStart && hasOffset) {
        const offNum = Number(toolArgs.offset);
        parsedStart = (hostKind === 'gemini' || offNum === 0) && Number.isFinite(offNum) && offNum >= 0
            ? Math.floor(offNum) + 1
            : offNum;
    }
    const startLine = outputRange
        ? outputRange.start
        : Math.max(1, Number(parsedStart) || 1);
    const limit = Number(toolArgs?.limit ?? 0);
    const explicitEnd = Number(toolArgs?.EndLine ?? toolArgs?.end_line ?? (limit > 0 ? startLine + limit - 1 : 0));
    const requestedCap = Number.isFinite(explicitEnd) && explicitEnd >= startLine ? explicitEnd : Infinity;
    let endLine = computeEffectiveReadEndLine(absTarget, startLine, requestedCap);
    if (outputRange) {
        endLine = Math.min(endLine, outputRange.end);
    }
    if (endLine < startLine) return null;
    const key = `${labelPrefixForRepo(workspaceDirs, repoRoot)}${rel}`;
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    mergeSpan(agyState.seenSpans, key, startLine, endLine);
    try {
        const st = statSync(absTarget);
        if (st.isFile()) {
            agyState.seenMtimes = agyState.seenMtimes && typeof agyState.seenMtimes === 'object' ? agyState.seenMtimes : {};
            agyState.seenMtimes[key] = st.mtimeMs;
        }
    } catch { /* ignore */ }
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
        oldLines,
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

function invalidateSpansForEditChunks(seenSpans, key, editedFile, chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
        invalidateEditedSpans(seenSpans, key, 1);
        return;
    }
    let diskLines = null;
    const resolvedRanges = [];
    let allSameLineCount = true;
    for (const chunk of chunks) {
        const { oldLines, newLines, prefixLen, changedOld, changedNew } = diffChunkLines(chunk?.oldText, chunk?.newText);
        let baseStart = Number(chunk?.startLine) > 0 ? Number(chunk.startLine) : 0;
        if (!baseStart && chunk?.newText) {
            diskLines ??= readDiskLinesSafe(editedFile);
            baseStart = findChunkStartLineOnDisk(diskLines, newLines);
        }
        if (!(baseStart > 0)) {
            invalidateEditedSpans(seenSpans, key, 1);
            return;
        }
        const chgStart = baseStart + prefixLen;
        if (oldLines.length !== newLines.length) {
            allSameLineCount = false;
        }
        const changedLen = Math.max(1, changedOld.length, changedNew.length);
        resolvedRanges.push({ start: chgStart, end: chgStart + changedLen - 1 });
    }
    if (allSameLineCount) {
        for (const r of resolvedRanges) {
            invalidateEditedSpans(seenSpans, key, r.start, r.end);
        }
        return;
    }
    const minChanged = Math.min(...resolvedRanges.map((r) => r.start));
    invalidateEditedSpans(seenSpans, key, minChanged);
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
    for (const n of graph?._nodesByPath?.get(rel) ?? []) {
        if (n.kind === 'file') continue;
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
    agyState.blockedSearchKeys = [];
}

function clearTurn0SeenKey(agyState, ...paths) {
    if (!Array.isArray(agyState?.turn0SeenKeys) || agyState.turn0SeenKeys.length === 0) return;
    const targets = paths.filter(Boolean).map((p) => normalizeRelFile(p));
    if (targets.length === 0) return;
    agyState.turn0SeenKeys = agyState.turn0SeenKeys.filter((k) => {
        const nk = normalizeRelFile(k);
        return !targets.some((t) => nk === t || nk.endsWith(`/${t}`) || t.endsWith(`/${nk}`));
    });
}

export function recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, opts = {}, toolArgs = null) {
    if (!repoRoot || !targetPath || isIgnoredTouchedPath(targetPath, repoRoot) || !existsSync(contextDirFor(repoRoot))) return;
    markEditMutationOnState(agyState);
    const editedFile = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(editedFile)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    agyState.lastTouchedPath = editedFile;
    recordFileEdit(repoRoot, editedFile, { skipBlast: true });
    const prefix = labelPrefixForRepo(workspaceDirs, repoRoot);
    const key = `${prefix}${rel}`;
    agyState.emittedBlastFiles = Array.isArray(agyState.emittedBlastFiles) ? agyState.emittedBlastFiles : [];
    const alreadyInTurn0 = (agyState.injectedPointers ?? []).some((p) => {
        const pFile = String(p).split(':')[0].replace(/\\/g, '/');
        return pFile === rel || pFile === key || rel.endsWith(`/${pFile}`);
    });
    const chunks = extractEditChunks(toolArgs);
    invalidateSpansForEditChunks(agyState.seenSpans, key, editedFile, chunks);
    clearTurn0SeenKey(agyState, rel, key);
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
    const { sid, agyState, dir } = loadAgyContext(input, { ...opts, skipTranscriptParse: true });
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    const toolName = String(input?.toolCall?.name ?? input?.tool_name ?? '');
    const toolArgs = input?.toolCall?.args ?? input?.tool_input ?? input?.args ?? {};
    const targetPath = resolveToolTargetPath(input);
    const repoRoot = pickRepoForTargetPath(targetPath, workspaceDirs, dir);
    const callOpts = opts.sessionId ? opts : { ...opts, sessionId: sid };
    if (isEnterPlanToolCall(toolName)) {
        agyState.isOrchestratorModel = true;
        const m = String(input?.modelName ?? input?.model ?? '').trim();
        if (m) agyState.executorModel = m;
        agyState.orchestratorPhase = 'plan';
        agyState.pendingPlanHandoff = null;
        agyState.pendingPlanText = null;
        agyState.pendingPlanWorkspaceDirs = [];
        agyState.pendingPlanSpans = [];
        agyState.pendingPlanAwaitApproval = false;
        saveAgyContext(sid, agyState, opts);
        return emitHookPayload('{}\n', opts);
    }
    const staged = stagePlanHandoff({ workspaceDirs, toolName, toolInput: toolArgs, input, targetPath, agyState, opts: { ...callOpts, deferHandoffBuild: true } });
    if (staged) { saveAgyContext(sid, agyState, opts); return emitHookPayload('{}\n', opts); }
    if (!isIsolatedBenchDir(repoRoot, opts.envFlags)) {
        if (READ_TOOLS_RE.test(toolName)) recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs, input });
        else if (EDIT_TOOLS_RE.test(toolName)) {
            const hasEditError = Boolean(
                input?.is_error
                || (typeof input?.error === 'string' && input.error.trim().length > 0)
                || (input?.error && typeof input.error === 'object')
                || input?.tool_response?.is_error,
            );
            if (hasEditError) {
                if (repoRoot && targetPath && !isIgnoredTouchedPath(targetPath, repoRoot)) {
                    const editedFile = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);
                    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(editedFile)));
                    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                        const prefix = labelPrefixForRepo(workspaceDirs, repoRoot);
                        invalidateEditedSpans(agyState.seenSpans, `${prefix}${rel}`, 1);
                        if (prefix) invalidateEditedSpans(agyState.seenSpans, rel, 1);
                        clearTurn0SeenKey(agyState, rel, `${prefix}${rel}`);
                        if (Array.isArray(agyState.blockedReadKeys)) {
                            agyState.blockedReadKeys = agyState.blockedReadKeys.filter((k) => !k.startsWith(`${rel}:`));
                        }
                        if (typeof agyState.lastBlockedReadKey === 'string' && agyState.lastBlockedReadKey.startsWith(`${rel}:`)) {
                            agyState.lastBlockedReadKey = null;
                        }
                    }
                }
            } else {
                agyState.editedInPrompt = true;
                recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, callOpts, toolArgs);
            }
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
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    if (agyState._dirtyTranscriptOffset) saveAgyContext(sid, agyState, opts);
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

function isIndexedSourceFile(repoRoot, rel, opts = {}) {
    if (!rel || /\.(?:md|mdx|txt|rst|adoc|json|ya?ml|toml|lock|ini|cfg|conf|env|csv|svg|png|jpg|gif)$/i.test(rel)) {
        return false;
    }
    try {
        const graph = typeof opts.getGraph === 'function' ? opts.getGraph(repoRoot) : loadGraphCached(contextDirFor(repoRoot));
        const nodes = graph?._nodesByPath?.get(rel);
        return Boolean(Array.isArray(nodes) && nodes.some((n) => n.kind !== 'doc'));
    } catch {
        return false;
    }
}

function handleHostReadPostTool(hostKind, root, targetPath, toolInput, sid, opts, input = null) {
    const targetRepo = nearestPlexerRoot(targetPath || root)?.root ?? root;
    if (isIsolatedBenchDir(targetRepo, opts.envFlags) || !existsSync(contextDirFor(targetRepo))) return emitContextIfAny(hostKind, '', opts);
    const agyState = readEngineSession(sid, opts);
    const rel = recordReadPostTool({ agyState, workspaceDirs: [targetRepo], repoRoot: targetRepo, targetPath, toolArgs: toolInput, input, recordMidLoop: false, hostKind });
    let hint = null;
    if (rel && !agyState.turn0Matched && !agyState.midLoopHintEmitted && isIndexedSourceFile(targetRepo, rel, opts)) {
        hint = buildMidLoopHint(targetRepo, contextDirFor(targetRepo), rel, opts);
        agyState.midLoopHintEmitted = true;
    }
    saveAgyContext(sid, agyState, opts);
    return emitContextIfAny(hostKind, hint, opts);
}

const GIT_MUTATION_RE = /\bgit\s+(?:checkout|restore|reset|apply|am|cherry-pick|revert|merge|rebase|stash\s+(?:pop|apply))\b/;

function handleHostShellPostTool(hostKind, root, toolInput, sid, opts) {
    const cmd = unquoteArg(toolInput?.command ?? toolInput?.CommandLine ?? '');
    if (!cmd) return emitContextIfAny(hostKind, '', opts);
    const isGitMut = GIT_MUTATION_RE.test(cmd);
    const shellEdit = !isGitMut ? detectShellSourceEdit(cmd, root, opts.getGraph) : null;
    if (!isGitMut && !shellEdit) return emitContextIfAny(hostKind, '', opts);
    const agyState = readEngineSession(sid, opts);
    if (!agyState.seenSpans || typeof agyState.seenSpans !== 'object') agyState.seenSpans = {};
    if (shellEdit?.files?.length) {
        for (const rel of shellEdit.files) {
            invalidateEditedSpans(agyState.seenSpans, rel, 1);
            clearTurn0SeenKey(agyState, rel);
            if (agyState.seenMtimes) delete agyState.seenMtimes[rel];
        }
        markEditMutationOnState(agyState);
        agyState.editedInPrompt = true;
    } else if (isGitMut) {
        const toks = tokenizeShellSegment(cmd) ?? [];
        const dashDash = toks.indexOf('--');
        const pathArgs = dashDash >= 0
            ? toks.slice(dashDash + 1).filter((t) => t && t !== '.' && !t.startsWith('-'))
            : [];
        if (pathArgs.length > 0 && /\bgit\s+(?:checkout|restore)\b/.test(cmd)) {
            for (const rawArg of pathArgs) {
                const absP = isAbsolute(rawArg) ? rawArg : join(root, rawArg);
                const rel = normalizeRelFile(relative(resolve(root), resolve(absP)));
                if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                    invalidateEditedSpans(agyState.seenSpans, rel, 1);
                    clearTurn0SeenKey(agyState, rel);
                    if (agyState.seenMtimes) delete agyState.seenMtimes[rel];
                }
            }
        } else {
            agyState.seenSpans = {};
            agyState.seenMtimes = {};
            agyState.turn0SeenKeys = [];
        }
        markEditMutationOnState(agyState);
    }
    saveAgyContext(sid, agyState, opts);
    return emitContextIfAny(hostKind, '', opts);
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
    if (/^(?:Read|read_file|view_file)$/i.test(toolName)) return handleHostReadPostTool(hostKind, root, targetPath, toolInput, sid, opts, input);
    if (/^(?:Bash|run_shell_command|shell)$/i.test(toolName)) return handleHostShellPostTool(hostKind, root, toolInput, sid, opts);
    if (/^(?:ExitPlanMode|exit_plan_mode)$/i.test(toolName)) {
        const agyState = readEngineSession(sid, opts);
        const handoff = stagePlanHandoff({ workspaceDirs: [root], toolName, toolInput, input, targetPath, agyState, opts });
        if (handoff?.text) { agyState.pendingPlanHandoff = null; agyState.pendingPlanSpans = []; }
        saveAgyContext(sid, agyState, opts);
        return emitContextIfAny(hostKind, handoff?.text ?? '', opts);
    }
    const edited = editedFilePath(input, root) || targetPath;
    const hasEditError = Boolean(
        input?.is_error
        || (typeof input?.error === 'string' && input.error.trim().length > 0)
        || (input?.error && typeof input.error === 'object')
        || input?.tool_response?.is_error,
    );
    if (hasEditError) {
        if (edited && !isIgnoredTouchedPath(edited, root)) {
            const agyState = readEngineSession(sid, opts);
            const absEdited = isAbsolute(edited) ? edited : join(root, edited);
            const rel = normalizeRelFile(relative(resolve(root), resolve(absEdited)));
            if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                invalidateEditedSpans(agyState.seenSpans, rel, 1);
                clearTurn0SeenKey(agyState, rel);
            }
            saveAgyContext(sid, agyState, opts);
        }
        return hostKind === 'cursor' ? emitHookPayload('{}\n', opts) : emitContextIfAny(hostKind, '', opts);
    }
    if (hostKind === 'cursor') {
        if (edited && !isIgnoredTouchedPath(edited, root)) {
            const agyState = readEngineSession(sid, opts);
            markEditMutationOnState(agyState);
            const absEdited = isAbsolute(edited) ? edited : join(root, edited);
            const rel = normalizeRelFile(relative(resolve(root), resolve(absEdited)));
            if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                invalidateSpansForEditChunks(agyState.seenSpans, rel, absEdited, extractEditChunks(toolInput));
            }
            saveAgyContext(sid, agyState, opts);
            recordFileEdit(root, edited, { skipBlast: true });
            if (typeof opts.onFileEdited === 'function') opts.onFileEdited(root, absEdited);
        }
        return emitHookPayload('{}\n', opts);
    }
    if (!edited || isIgnoredTouchedPath(edited, root)) return emitContextIfAny(hostKind, '', opts);
    const agyState = readEngineSession(sid, opts);
    markEditMutationOnState(agyState);
    const absEdited = isAbsolute(edited) ? edited : join(root, edited);
    const rel = normalizeRelFile(relative(resolve(root), resolve(absEdited)));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        invalidateSpansForEditChunks(agyState.seenSpans, rel, absEdited, extractEditChunks(toolInput));
        clearTurn0SeenKey(agyState, rel);
    }
    const touched = recordFileEdit(root, edited, { skipBlast: true });
    let gatedBr = null;
    if (touched && rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        const agyOrientedInRoot = Array.isArray(agyState.orientedDirs) && agyState.orientedDirs.includes(resolve(root));
        const agyInTurn0 = agyOrientedInRoot && (agyState.injectedPointers ?? []).some((p) => {
            const pf = String(p).split(':')[0].replace(/\\/g, '/');
            return pf === rel || rel.endsWith(`/${pf}`);
        });
        const targetKnownForClaude = hostKind === 'claude' && Array.isArray(agyState.editTargetFiles)
            && agyState.editTargetFiles.some((tf) => tf === rel || rel.endsWith(`/${tf}`));
        if (!agyInTurn0 && !targetKnownForClaude && editTouchesSignatureOrExport(root, absEdited, rel, toolInput, opts)) {
            const legacySess = readSession(root, sid);
            const legacyEmitted = Array.isArray(legacySess.emittedBlastFiles) ? legacySess.emittedBlastFiles : [];
            const legacyInTurn0 = (legacySess.injectedPointers ?? []).some((p) => {
                const pf = String(p).split(':')[0].replace(/\\/g, '/');
                return pf === rel || rel.endsWith(`/${pf}`);
            });
            if (!legacyEmitted.includes(rel) && !legacyInTurn0) {
                const graph = typeof opts.getGraph === 'function' ? opts.getGraph(root) : loadGraphCached(contextDirFor(root));
                const blastCap = hostKind === 'claude' ? 4 : 8;
                const blastMaxBytes = hostKind === 'claude' ? 350 : 600;
                gatedBr = graph
                    ? formatBlastRadius(graph, absEdited, blastCap, root, {
                        maxBytes: blastMaxBytes,
                        isPathSeen: (callerRel) => hasSeenFileInState(agyState.seenSpans, normalizeRelFile(callerRel), ''),
                    })
                    : null;
                if (gatedBr) {
                    legacySess.emittedBlastFiles = [...legacyEmitted, rel];
                    writeSession(root, sid, legacySess);
                }
            }
        }
    }
    if (typeof opts.onFileEdited === 'function') opts.onFileEdited(root, absEdited);
    saveAgyContext(sid, agyState, opts);
    return emitContextIfAny(hostKind, gatedBr, opts);
}

export function handleHostStopHook(input, opts = {}) {
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (!isIsolatedBenchDir(root, opts.envFlags)) handleStop(input, root);
    return emitHookPayload('', opts);
}
