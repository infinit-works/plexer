import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { editedFilePath, handlePostEdit, handleStop, recordFileEdit } from '../../claude/hooks.js';
import { nearestPlexerRoot } from '../../graph/root.js';
import { pickRepoForTargetPath } from '../../agy/multi-workspace.js';
import { buildPlanExecutionHandoff } from '../../agy/plan-handoff.js';
import { mergeSpan, normalizeRelFile } from '../../agy/spans.js';
import { contextDirFor } from '../../util/paths.js';
import { isIgnoredTouchedPath } from './agy-transcript.js';
import {
    HOST_KINDS, activeWorkspaceDirs, buildMidLoopHint, emitHookPayload, findNearestRepoAncestor,
    isEarlyIsolatedBenchCall, isIsolatedBenchDir, labelPrefixForRepo, loadAgyContext,
    readEngineSession, resolveHostProjectDir, resolveHostSessionId, resolveToolTargetPath,
    saveAgyContext, unquoteArg,
} from './agy-context.js';

const READ_TOOLS_RE = /^(?:read_file|view_file|Read)$/i;
const EDIT_TOOLS_RE = /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|Edit|Write|MultiEdit|apply_patch|replace)$/i;

function isInsideArtifactDir(targetPath, artifactDir) {
    if (!targetPath || !artifactDir || !targetPath.toLowerCase().endsWith('.md')) return false;
    const rel = relative(resolve(artifactDir), resolve(targetPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isPlanToolCall(toolName, toolInput, input, targetPath = '') {
    if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return true;
    if (!/^(?:write_file|edit_file|write_to_file|replace_file_content)$/i.test(toolName)) return false;
    if (toolInput?.ArtifactMetadata?.RequestFeedback === true) return true;
    return isInsideArtifactDir(targetPath, input?.artifactDirectoryPath ?? '');
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
    const planText = extractPlanText(toolName, toolInput, input, resolvedTarget);
    const handoff = buildPlanExecutionHandoff(workspaceDirs, planText, agyState, { getGraph: opts.getGraph });
    agyState.pendingPlanHandoff = handoff?.text || null;
    agyState.pendingPlanSpans = handoff?.text ? (handoff.spans ?? []) : [];
    return handoff;
}

export function recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs, recordMidLoop = true }) {
    if (!targetPath || !existsSync(contextDirFor(repoRoot))) return null;
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(targetPath)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const startLine = Math.max(1, Number(toolArgs?.StartLine ?? toolArgs?.start_line ?? toolArgs?.offset ?? 1) || 1);
    const limit = Number(toolArgs?.limit ?? 0);
    const rawEnd = Number(toolArgs?.EndLine ?? toolArgs?.end_line ?? (limit > 0 ? startLine + limit - 1 : 999999));
    const endLine = Number.isFinite(rawEnd) && rawEnd >= startLine ? rawEnd : startLine;
    const key = `${labelPrefixForRepo(workspaceDirs, repoRoot)}${rel}`;
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    mergeSpan(agyState.seenSpans, key, startLine, endLine);
    agyState.lastReadRelFile = rel;
    if (recordMidLoop && !agyState.turn0Matched && !agyState.midLoopHintEmitted && !agyState.pendingMidLoopFile) {
        agyState.pendingMidLoopFile = rel;
    }
    return rel;
}

export function recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, opts = {}) {
    if (!targetPath || isIgnoredTouchedPath(targetPath, repoRoot) || !existsSync(contextDirFor(repoRoot))) return;
    const editedFile = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);
    const rel = normalizeRelFile(relative(resolve(repoRoot), resolve(editedFile)));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    agyState.lastTouchedPath = editedFile;
    const br = recordFileEdit(repoRoot, editedFile);
    const key = `${labelPrefixForRepo(workspaceDirs, repoRoot)}${rel}`;
    agyState.emittedBlastFiles = Array.isArray(agyState.emittedBlastFiles) ? agyState.emittedBlastFiles : [];
    const alreadyInTurn0 = (agyState.injectedPointers ?? []).length >= 3
        && (agyState.injectedPointers ?? []).some((p) => {
            const pFile = String(p).split(':')[0].replace(/\\/g, '/');
            return pFile === rel || pFile === key || rel.endsWith(`/${pFile}`);
        });
    if (br && !agyState.emittedBlastFiles.includes(key) && !alreadyInTurn0) {
        agyState.emittedBlastFiles.push(key);
        agyState.pendingBlastRadius = agyState.pendingBlastRadius && !agyState.pendingBlastRadius.includes(br)
            ? `${agyState.pendingBlastRadius}\n${br}` : (agyState.pendingBlastRadius || br);
    }
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
    const staged = stagePlanHandoff({ workspaceDirs, toolName, toolInput: toolArgs, input, targetPath, agyState, opts });
    if (staged) { saveAgyContext(sid, agyState, opts); return emitHookPayload('{}\n', opts); }
    if (!isIsolatedBenchDir(repoRoot, opts.envFlags)) {
        if (READ_TOOLS_RE.test(toolName)) recordReadPostTool({ agyState, workspaceDirs, repoRoot, targetPath, toolArgs });
        else if (EDIT_TOOLS_RE.test(toolName)) recordEditBlastForAgy(workspaceDirs, repoRoot, targetPath, agyState, opts);
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload('{}\n', opts);
}

export function handleAgyPostEdit(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload('{}\n', opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    const rawTarget = resolveToolTargetPath(input) || agyState.lastEditedFile;
    agyState.lastEditedFile = null;
    if (rawTarget) {
        const repoRoot = pickRepoForTargetPath(rawTarget, workspaceDirs, findNearestRepoAncestor(rawTarget) ?? dir);
        if (!isIsolatedBenchDir(repoRoot, opts.envFlags)) recordEditBlastForAgy(workspaceDirs, repoRoot, rawTarget, agyState, opts);
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload('{}\n', opts);
}

export function handleAgyStop(input, opts = {}) {
    const allow = `${JSON.stringify({ decision: 'allow' })}\n`;
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload(allow, opts);
    const { agyState, dir } = loadAgyContext(input, opts);
    for (const wsDir of activeWorkspaceDirs(input, agyState, dir, opts)) {
        if (!isIsolatedBenchDir(wsDir, opts.envFlags)) handleStop(input, wsDir);
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
