import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { relevantRetrieval } from '../../claude/format.js';
import { queryPromptContext, readOrientation } from '../../claude/hooks.js';
import { ensureFreshGraph } from '../../graph/refresh.js';
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from '../../graph/root.js';
import { readWorkspace } from '../../graph/workspace.js';
import { writeAgyLastRepo } from '../../agy/session.js';
import { pickRepoForTargetPath, queryMultiWorkspaceContext } from '../../agy/multi-workspace.js';
import { applySeenSpansFilter, detectCompactionReset, mergeSpan, recordRetrievalSpans } from '../../agy/spans.js';
import { isReadOnlySubagentInput, stripCliNudges, stripSubagentBoilerplate } from '../../agy/subagent.js';
import { contextDirFor } from '../../util/paths.js';
import { readSession, writeSession } from '../../util/state.js';
import { READ_ONLY_SLASH_RE, isSyntheticOrMetaPrompt } from './prompt/intent.js';
import { extractPathsFromText, stripUserRequestTags } from './agy-transcript.js';
import {
    HOST_KINDS, activeWorkspaceDirs, buildMidLoopHint, emitHookPayload, fitAgyEphemeral,
    formatAgyUserMarkdown, isEarlyIsolatedBenchCall, isIsolatedBenchDir, loadAgyContext,
    normalizePromptKey, readEngineSession, resolveHostProjectDir, resolveHostSessionId, saveAgyContext,
} from './agy-context.js';

export async function refreshWorkspaceDirs(workspaceDirs, opts = {}) {
    for (const wsDir of workspaceDirs) {
        if (isIsolatedBenchDir(wsDir, opts.envFlags)) continue;
        if (!existsSync(contextDirFor(wsDir)) && !hasPlexerIndex(wsDir) && !isAutoBuildableRepo(wsDir)) continue;
        try {
            const run = () => ensureFreshGraph(wsDir);
            const fresh = await (typeof opts.withRepoLock === 'function' ? opts.withRepoLock(wsDir, run) : run());
            if (fresh?.refreshed && typeof opts.onGraphRefreshed === 'function') opts.onGraphRefreshed(wsDir);
        } catch { /* best-effort drift refresh */ }
    }
}

export function collectPendingMessages(agyState, badgeInfo = null) {
    const messages = [];
    if (agyState.pendingBlastRadius) {
        const firstLine = agyState.pendingBlastRadius.split('\n')[0] || '';
        const m = /blast radius for ([^,]+),/.exec(firstLine);
        if (badgeInfo) badgeInfo.blastFile = m ? m[1].trim() : (agyState.lastTouchedPath || null);
        messages.push(agyState.pendingBlastRadius);
        agyState.pendingBlastRadius = null;
        agyState.lastRetrievalText = null;
    }
    if (agyState.pendingPlanHandoff) {
        messages.push(agyState.pendingPlanHandoff);
        if (Array.isArray(agyState.pendingPlanSpans)) {
            agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
            for (const sp of agyState.pendingPlanSpans) if (sp?.key) mergeSpan(agyState.seenSpans, sp.key, sp.start, sp.end);
        }
        agyState.pendingPlanHandoff = null;
        agyState.pendingPlanSpans = [];
    }
    return messages;
}

export function resetCompactSessionState(dir, sid, agyState) {
    agyState.seenSpans = {};
    agyState.fileSliceCounts = {};
    agyState.lastReadRelFile = null;
    agyState.injectedPointers = [];
    agyState.orientedDirs = [];
    delete agyState.orientedRepos;
    agyState.turn0Matched = false;
    agyState.midLoopHintEmitted = false;
    if (!dir || !sid) return;
    try {
        const cs = readSession(dir, sid);
        cs.injectedPointers = [];
        cs.emittedBlastFiles = [];
        writeSession(dir, sid, cs);
    } catch { /* ignore */ }
}

export function isReadOnlyTurnInput(input, rawPrompt = '') {
    return Boolean(rawPrompt && READ_ONLY_SLASH_RE.test(String(rawPrompt).trim())) || isReadOnlySubagentInput(input, rawPrompt);
}

export function collectMissingOrientations(indexedDirs, agyState, badgeInfo = null, { isReadOnly = false, skipEmit = false } = {}) {
    const out = [];
    agyState.orientedDirs = Array.isArray(agyState.orientedDirs) ? agyState.orientedDirs : [];
    for (const wsDir of indexedDirs) {
        const key = resolve(wsDir);
        if (agyState.orientedDirs.includes(key) || agyState.orientedRepos?.[key] || readWorkspace(wsDir, contextDirFor(wsDir))) continue;
        if (skipEmit) { agyState.orientedDirs.push(key); continue; }
        const orient = readOrientation(wsDir, 1200);
        if (!orient) continue;
        out.push(isReadOnly ? '[plexer] This repo is indexed by plexer.' : orient);
        agyState.orientedDirs.push(key);
        if (badgeInfo) badgeInfo.oriented = true;
    }
    return out;
}

export function runSharedTurn0Query({ indexedDirs, rawPrompt, input, agyState, badgeInfo = null }) {
    if (!indexedDirs.length || !rawPrompt || isSyntheticOrMetaPrompt(rawPrompt)) return null;
    const isReadOnly = READ_ONLY_SLASH_RE.test(rawPrompt.trim()) || isReadOnlySubagentInput(input, rawPrompt);
    const distilled = stripSubagentBoilerplate(rawPrompt);
    const askRaw = indexedDirs.length > 1
        ? queryMultiWorkspaceContext(indexedDirs, distilled, { forceReadOnly: isReadOnly })
        : queryPromptContext(indexedDirs[0], distilled, { forceReadOnly: isReadOnly });
    if (!askRaw) return null;
    const ask = applySeenSpansFilter(askRaw, agyState.seenSpans)?.ask ?? askRaw;
    let txt = relevantRetrieval(ask, agyState, 4, { suppressNudge: isReadOnly });
    if (isReadOnly && txt) txt = stripCliNudges(txt);
    if (!txt || txt.startsWith('[plexer] no strong match for this prompt')) {
        if (badgeInfo && typeof ask.coverageStrong === 'number') badgeInfo.weakScore = ask.coverageStrong;
        return txt || null;
    }
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    recordRetrievalSpans(agyState.seenSpans, ask, '');
    agyState.turn0Matched = true;
    agyState.lastRetrievalText = txt;
    if (badgeInfo) {
        const hits = ask.hits ?? [];
        badgeInfo.retrievalCount = hits.length;
        badgeInfo.files = [...new Set(hits.map((h) => String(h.pointer ?? '').split(':')[0]).filter(Boolean))];
        badgeInfo.coEditCount = ask.coEditPointers?.length ?? 0;
    }
    return txt;
}

function applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts) {
    if (agyState.turn0Matched || agyState.midLoopHintEmitted || !agyState.pendingMidLoopFile) return;
    const midLoopRepo = pickRepoForTargetPath(agyState.lastTouchedPath, indexedDirs, indexedDirs[0]);
    const hint = buildMidLoopHint(midLoopRepo, contextDirFor(midLoopRepo), agyState.pendingMidLoopFile, opts);
    const targetFile = agyState.pendingMidLoopFile;
    agyState.midLoopHintEmitted = true;
    agyState.pendingMidLoopFile = null;
    if (!hint) return;
    messages.push(hint);
    if (badgeInfo) badgeInfo.midLoopFile = targetFile;
}

function buildAgyPreInvocationResponse(messages, badgeInfo, opts) {
    if (messages.length === 0) return '{}\n';
    const ephMsg = fitAgyEphemeral(messages.join('\n\n'), 7200);
    const useMd = opts.enableUserMarkdown || opts.envFlags?.enableUserMarkdown || process.env.PLEXER_AGY_USER_MARKDOWN === '1';
    const userMarkdown = useMd ? formatAgyUserMarkdown(badgeInfo) : '';
    const systemMessage = useMd && userMarkdown ? { systemMessage: ephMsg, metadata: { user_markdown: userMarkdown } } : { systemMessage: ephMsg };
    return `${JSON.stringify({ injectSteps: [{ systemMessage }] })}\n`;
}

function applyDirectPromptInput(input, agyState) {
    const directPrompt = typeof input?.prompt === 'string' && input.prompt.trim()
        ? input.prompt : (typeof input?.lastUserInput === 'string' && input.lastUserInput.trim() ? input.lastUserInput : null);
    if (!directPrompt) return;
    const cleaned = stripUserRequestTags(directPrompt);
    if (!cleaned) return;
    if (normalizePromptKey(cleaned) !== agyState.lastProcessedPrompt) agyState.turn0Matched = false;
    agyState.lastUserPrompt = cleaned;
    extractPathsFromText(cleaned, agyState);
}

export async function handleAgyPreInvocation(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload('{}\n', opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    detectCompactionReset(agyState, input);
    applyDirectPromptInput(input, agyState);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    if (isIsolatedBenchDir(dir, opts.envFlags) || workspaceDirs.some((d) => isIsolatedBenchDir(d, opts.envFlags))) return emitHookPayload('{}\n', opts);
    await refreshWorkspaceDirs(workspaceDirs, opts);
    const indexedDirs = workspaceDirs.filter((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)));
    const badgeInfo = { retrievalCount: 0, files: [], coEditCount: 0, blastFile: null, midLoopFile: null, oriented: false, weakScore: null };
    if (dir && indexedDirs.length > 0) writeAgyLastRepo(dir);
    const rawPrompt = String(agyState.lastUserPrompt ?? '').trim();
    const isReadOnly = isReadOnlyTurnInput(input, rawPrompt);
    const messages = collectPendingMessages(agyState, badgeInfo);
    const prompt = normalizePromptKey(rawPrompt);
    const isNewStep = typeof agyState.lastUserStep === 'number' && agyState.lastUserStep !== agyState.lastProcessedStep;
    if (prompt && (prompt !== agyState.lastProcessedPrompt || isNewStep)) {
        agyState.lastProcessedPrompt = prompt;
        agyState.lastProcessedStep = agyState.lastUserStep;
        const txt = runSharedTurn0Query({ indexedDirs, rawPrompt, input, agyState, badgeInfo });
        if (txt) messages.push(txt);
        else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
    } else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
    const orients = collectMissingOrientations(indexedDirs, agyState, badgeInfo, { isReadOnly, skipEmit: Boolean(agyState.turn0Matched) });
    if (orients.length > 0) messages.unshift(...orients);
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload(buildAgyPreInvocationResponse(messages, badgeInfo, opts), opts);
}

function formatHostTurn0Output(hostKind, additionalContext) {
    if (hostKind === 'cursor') {
        return `${JSON.stringify(additionalContext ? { continue: true, additional_context: additionalContext } : { continue: true })}\n`;
    }
    const spec = HOST_KINDS[hostKind] ?? HOST_KINDS.claude;
    if (!additionalContext) return spec.emptyTurn0;
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: spec.turn0Event, additionalContext } })}\n`;
}

export async function handleSessionStartHook(input, opts = {}) {
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (isIsolatedBenchDir(root, opts.envFlags)) return emitHookPayload('', opts);
    const sid = resolveHostSessionId(input, opts.envFlags);
    if (input?.source === 'compact' || input?.reason === 'compact' || input?.trigger === 'compact') {
        const agyState = readEngineSession(sid, opts);
        resetCompactSessionState(root, sid, agyState);
        saveAgyContext(sid, agyState, opts);
    }
    await refreshWorkspaceDirs([root], opts);
    if (!existsSync(contextDirFor(root))) return emitHookPayload('', opts);
    const orientation = readOrientation(root, 1200);
    return orientation
        ? emitHookPayload(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: orientation } })}\n`, opts)
        : emitHookPayload('', opts);
}

export async function handleTurn0Hook(hostKind, input, opts = {}) {
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (isIsolatedBenchDir(root, opts.envFlags)) return emitHookPayload(formatHostTurn0Output(hostKind, ''), opts);
    await refreshWorkspaceDirs([root], opts);
    if (!existsSync(contextDirFor(root))) return emitHookPayload(formatHostTurn0Output(hostKind, ''), opts);
    const rawPrompt = String(input?.prompt ?? input?.userPrompt ?? input?.lastUserInput ?? input?.agentMessage ?? '').trim();
    const sid = resolveHostSessionId(input, opts.envFlags);
    const agyState = readEngineSession(sid, opts);
    const parts = collectPendingMessages(agyState, null);
    const txt = runSharedTurn0Query({ indexedDirs: [root], rawPrompt, input, agyState, badgeInfo: null });
    if (txt) parts.push(txt);
    agyState.orientedDirs = Array.isArray(agyState.orientedDirs) ? agyState.orientedDirs : [];
    const rootKey = resolve(root);
    const spec = HOST_KINDS[hostKind] ?? HOST_KINDS.claude;
    if (!agyState.orientedDirs.includes(rootKey) && !agyState.orientedRepos?.[rootKey]) {
        if (agyState.turn0Matched) agyState.orientedDirs.push(rootKey);
        else if (spec.emitOrientationOnTurn0 && rawPrompt && !isSyntheticOrMetaPrompt(rawPrompt)) {
            const orient = readOrientation(root, 1200);
            if (orient) { parts.unshift(orient); agyState.orientedDirs.push(rootKey); }
        }
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload(formatHostTurn0Output(hostKind, parts.join('\n\n')), opts);
}
