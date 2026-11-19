import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { relevantRetrieval } from '../../claude/format.js';
import { queryPromptContext, readOrientation, triggerBackgroundSync } from '../../claude/hooks.js';
import { wiringPath } from '../../context/node-file.js';
import { driftCount, isClean, probeDrift } from '../../graph/fingerprint.js';
import { ensureFreshGraph } from '../../graph/refresh.js';
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from '../../graph/root.js';
import { readWorkspace } from '../../graph/workspace.js';
import { writeAgyLastRepo } from '../../agy/session.js';
import { pickRepoForTargetPath, queryMultiWorkspaceContext } from '../../agy/multi-workspace.js';
import { applySeenSpansFilter, detectCompactionReset, mergeSpan, recordEmittedRetrievalTextSpans } from '../../agy/spans.js';
import { seedForkedSwarmSession } from '../../agy/swarm-sync.js';
import { isReadOnlySubagentInput, stripCliNudges, stripSubagentBoilerplate } from '../../agy/subagent.js';
import { contextDirFor } from '../../util/paths.js';
import { readSession, writeSession } from '../../util/state.js';
import { isGeminiModelProfile, isOrchestratorInput } from './prompt/budget.js';
import { PLAN_SLASH_RE, READ_ONLY_SLASH_RE, isLikelyEditSessionPrompt, isSyntheticOrMetaPrompt } from './prompt/intent.js';
import { extractMetadataContext, extractPathsFromText, stripUserRequestTags } from './agy-transcript.js';
import {
    HOST_KINDS, activeWorkspaceDirs, buildMidLoopHint, emitHookPayload, fitAgyEphemeral,
    formatAgyUserMarkdown, isEarlyIsolatedBenchCall, isInteractiveAgyAppInput, isIsolatedBenchDir, loadAgyContext,
    normalizePromptKey, readEngineSession, resolveHostProjectDir, resolveHostSessionId, saveAgyContext,
} from './agy-context.js';

const INLINE_REFRESH_BUDGET_MS = 400;
const INLINE_REFRESH_MAX_DRIFT_FILES = 3;

export async function refreshWorkspaceDirs(workspaceDirs, opts = {}) {
    const budgetMs = opts.inlineRefreshBudgetMs ?? INLINE_REFRESH_BUDGET_MS;
    const scheduleBg = (wsDir) => {
        if (typeof opts.scheduleRefresh === 'function') opts.scheduleRefresh(wsDir);
        else triggerBackgroundSync(wsDir);
    };
    for (const wsDir of workspaceDirs) {
        if (isIsolatedBenchDir(wsDir, opts.envFlags)) continue;
        const outDir = contextDirFor(wsDir);
        if (!existsSync(outDir) && !hasPlexerIndex(wsDir) && !isAutoBuildableRepo(wsDir)) continue;
        const run = () => ensureFreshGraph(wsDir);
        const executeLocked = () => (typeof opts.withRepoLock === 'function' ? opts.withRepoLock(wsDir, run) : run());
        try {
            if (!existsSync(wiringPath(outDir))) {
                const fresh = await executeLocked();
                if (fresh?.refreshed && typeof opts.onGraphRefreshed === 'function') opts.onGraphRefreshed(wsDir);
                continue;
            }
            if (typeof opts.hasInFlightRefresh === 'function' && opts.hasInFlightRefresh(wsDir)) continue;
            const drift = probeDrift(wsDir, outDir);
            if (drift === null || driftCount(drift) > INLINE_REFRESH_MAX_DRIFT_FILES) {
                scheduleBg(wsDir);
                continue;
            }
            if (isClean(drift)) continue;
            let timedOut = false;
            let timer = null;
            const timeoutPromise = new Promise((resolveTimeout) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    resolveTimeout({ timedOut: true });
                }, budgetMs);
                if (typeof timer.unref === 'function') timer.unref();
            });
            const refreshPromise = Promise.resolve().then(executeLocked);
            refreshPromise.then((fresh) => {
                if (fresh?.refreshed && typeof opts.onGraphRefreshed === 'function') opts.onGraphRefreshed(wsDir);
            }).catch(() => {});
            const winner = await Promise.race([refreshPromise, timeoutPromise]);
            if (timer) clearTimeout(timer);
            if ((winner?.timedOut || timedOut) && typeof opts.scheduleRefresh !== 'function') {
                triggerBackgroundSync(wsDir);
            }
        } catch { /* best-effort drift refresh */ }
    }
}

export function collectPendingMessages(agyState, badgeInfo = null, { isNewPrompt = false } = {}) {
    const messages = [];
    if (agyState.pendingBlastRadius) {
        const firstLine = agyState.pendingBlastRadius.split('\n')[0] || '';
        const m = /blast radius for ([^,]+),/.exec(firstLine);
        if (badgeInfo) badgeInfo.blastFile = m ? m[1].trim() : (agyState.lastTouchedPath || null);
        messages.push(agyState.pendingBlastRadius);
        agyState.pendingBlastRadius = null;
        agyState.lastRetrievalText = null;
    }
    const canEmitPlanHandoff = Boolean(
        agyState.pendingPlanHandoff
        && (!agyState.pendingPlanAwaitApproval || isNewPrompt || agyState.orchestratorPhase === 'execute'),
    );
    if (canEmitPlanHandoff) {
        messages.push(agyState.pendingPlanHandoff);
        if (Array.isArray(agyState.pendingPlanSpans)) {
            agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
            for (const sp of agyState.pendingPlanSpans) if (sp?.key) mergeSpan(agyState.seenSpans, sp.key, sp.start, sp.end);
        }
        agyState.pendingPlanHandoff = null;
        agyState.pendingPlanSpans = [];
        agyState.pendingPlanAwaitApproval = false;
    }
    return messages;
}

export function resetCompactSessionState(dir, sid, agyState) {
    agyState.seenSpans = {};
    agyState.fileSliceCounts = {};
    agyState.lastFileReadEnd = {};
    agyState.lastReadRelFile = null;
    agyState.injectedPointers = [];
    agyState.orientedDirs = [];
    delete agyState.orientedRepos;
    agyState.turn0Matched = false;
    agyState.midLoopHintEmitted = false;
    agyState.exploreGuardStage = 0;
    agyState.exploreGuardEmitted = false;
    agyState.preEditToolTurns = 0;
    agyState.lastPreEditToolAtMs = 0;
    agyState.seenSearchKeys = [];
    agyState.lastBlockedSearchKey = null;
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

export function runSharedTurn0Query({ indexedDirs, rawPrompt, input, agyState, badgeInfo = null, hostKind = 'agy', deferSeenRecord = false }) {
    if (!indexedDirs.length || !rawPrompt || isSyntheticOrMetaPrompt(rawPrompt)) return null;
    if (agyState && typeof agyState === 'object') {
        agyState.isEditPrompt = false;
        agyState.editTargetFiles = [];
        agyState.preEditInvocations = 0;
        agyState.editedInPrompt = false;
        agyState.exploreGuardEmitted = false;
        agyState.exploreGuardStage = 0;
        agyState.preEditToolTurns = 0;
        agyState.lastPreEditToolAtMs = 0;
    }
    const trimmedPrompt = rawPrompt.trim();
    const isPlanSlash = PLAN_SLASH_RE.test(trimmedPrompt);
    const isReadOnlySub = isReadOnlySubagentInput(input, rawPrompt);
    const isPlanMode = Boolean(
        !isReadOnlySub
        && (isPlanSlash
            || input?.mode === 'plan'
            || input?.planMode === true
            || (isOrchestratorInput(input, agyState) && agyState.orchestratorPhase !== 'execute')),
    );
    if (isPlanMode && !agyState.orchestratorPhase) {
        agyState.orchestratorPhase = 'plan';
    }
    const isPureReadOnly = Boolean((READ_ONLY_SLASH_RE.test(trimmedPrompt) && !isPlanSlash) || isReadOnlySub);
    const geminiProfile = isGeminiModelProfile(input, hostKind);
    const likelyEditSession = !isPureReadOnly && !isPlanMode
        && isLikelyEditSessionPrompt(trimmedPrompt, { forceReadOnly: isPureReadOnly, planMode: isPlanMode });
    const distilled = stripSubagentBoilerplate(rawPrompt);
    const queryOpts = { forceReadOnly: isPureReadOnly, geminiProfile, planMode: isPlanMode };
    const askRaw = indexedDirs.length > 1
        ? queryMultiWorkspaceContext(indexedDirs, distilled, queryOpts)
        : queryPromptContext(indexedDirs[0], distilled, queryOpts);
    if (!askRaw) {
        agyState.isEditPrompt = likelyEditSession;
        return null;
    }
    const ask = applySeenSpansFilter(askRaw, agyState.seenSpans)?.ask ?? askRaw;
    const isEditTurn = Boolean(ask.isEditPrompt || ask.editEnvelope);
    const targetPool = ask.hits?.length ? ask.hits : (ask.candidateMap ?? []);
    const targetFiles = [...new Set(targetPool.map((h) => String(h.pointer ?? '').split(':')[0]).filter(Boolean))].slice(0, 3);
    let txt = relevantRetrieval(
        ask,
        agyState,
        (geminiProfile && isEditTurn) ? 5 : 4,
        { suppressNudge: isPureReadOnly, planMode: isPlanMode, geminiProfile },
    );
    if (isReadOnlySub && txt) txt = stripCliNudges(txt);
    if (!txt || txt.startsWith('[plexer] no strong match for this prompt')) {
        if (badgeInfo && typeof ask.coverageStrong === 'number') badgeInfo.weakScore = ask.coverageStrong;
        agyState.isEditPrompt = Boolean(!isPureReadOnly && !isPlanMode && (isEditTurn || likelyEditSession));
        agyState.editTargetFiles = targetFiles;
        return txt || null;
    }
    txt = fitAgyEphemeral(txt, 12000);
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    if (!deferSeenRecord) recordEmittedRetrievalTextSpans(agyState.seenSpans, txt, '');
    agyState.turn0Matched = true;
    agyState.isEditPrompt = Boolean(!isPureReadOnly && !isPlanMode && (isEditTurn || likelyEditSession));
    agyState.editTargetFiles = targetFiles;
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

function buildAgyPreInvocationResponse(messages, badgeInfo, opts, input = null, ephMsgOverride = null) {
    if (messages.length === 0) return '{}\n';
    const ephMsg = ephMsgOverride ?? fitAgyEphemeral(messages.join('\n\n'), 12000);
    const disabledMd = opts.enableUserMarkdown === false || opts.envFlags?.enableUserMarkdown === false || process.env.PLEXER_AGY_USER_MARKDOWN === '0';
    const explicitMd = opts.enableUserMarkdown === true || opts.envFlags?.enableUserMarkdown === true || process.env.PLEXER_AGY_USER_MARKDOWN === '1';
    const useMd = !disabledMd && (explicitMd || isInteractiveAgyAppInput(input));
    const userMarkdown = useMd ? formatAgyUserMarkdown(badgeInfo, { includeSidecarLink: true }) : '';
    const systemMessage = useMd && userMarkdown ? { systemMessage: ephMsg, metadata: { user_markdown: userMarkdown } } : { systemMessage: ephMsg };
    return `${JSON.stringify({ injectSteps: [{ systemMessage }] })}\n`;
}

function applyDirectPromptInput(input, agyState) {
    const directPrompt = typeof input?.prompt === 'string' && input.prompt.trim()
        ? input.prompt : (typeof input?.lastUserInput === 'string' && input.lastUserInput.trim() ? input.lastUserInput : null);
    if (!directPrompt) return;
    if (typeof input?.prompt === 'string' && input.prompt.trim() && !/\[Message\]/i.test(directPrompt)) {
        agyState.hasDirectUserInput = true;
    }
    extractMetadataContext(directPrompt, agyState);
    if (/\[plan review(?:\s+due)?\]/i.test(directPrompt)) {
        agyState.orchestratorPhase = 'plan';
    }
    const cleaned = stripUserRequestTags(directPrompt);
    if (!cleaned) return;
    if (normalizePromptKey(cleaned) !== agyState.lastProcessedPrompt) agyState.turn0Matched = false;
    agyState.lastUserPrompt = cleaned;
    extractPathsFromText(cleaned, agyState);
}

export async function handleAgyPreInvocation(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload('{}\n', opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    const compacted = detectCompactionReset(agyState, input);
    if (compacted) {
        agyState.lastProcessedPrompt = null;
        agyState.lastProcessedStep = null;
        agyState.orchestratorPhase = null;
    }
    const forkSeeded = seedForkedSwarmSession(sid, agyState, opts);
    applyDirectPromptInput(input, agyState);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    if (isIsolatedBenchDir(dir, opts.envFlags) || workspaceDirs.some((d) => isIsolatedBenchDir(d, opts.envFlags))) return emitHookPayload('{}\n', opts);
    const rawPrompt = String(agyState.lastUserPrompt ?? '').trim();
    const prompt = normalizePromptKey(rawPrompt);
    const isNewStep = typeof agyState.lastUserStep === 'number' && agyState.lastUserStep !== agyState.lastProcessedStep;
    const isNewPrompt = Boolean(prompt && (prompt !== agyState.lastProcessedPrompt || isNewStep));
    if (isNewPrompt && agyState.hasDirectUserInput && !/\[plan review(?:\s+due)?\]/i.test(rawPrompt)) {
        agyState.orchestratorPhase = null;
    }
    const hasPendingPlanHandoff = Boolean(
        agyState.pendingPlanHandoff
        && (!agyState.pendingPlanAwaitApproval || isNewPrompt || agyState.orchestratorPhase === 'execute'),
    );
    const hasPendingWork = Boolean(
        agyState.pendingBlastRadius
        || hasPendingPlanHandoff
        || (!agyState.turn0Matched && !agyState.midLoopHintEmitted && agyState.pendingMidLoopFile),
    );
    const needsColdBuild = workspaceDirs.some((d) => {
        if (isIsolatedBenchDir(d, opts.envFlags)) return false;
        const outDir = contextDirFor(d);
        return !existsSync(wiringPath(outDir)) && (existsSync(outDir) || hasPlexerIndex(d) || isAutoBuildableRepo(d));
    });
    const isOrientedDir = (d) => {
        const key = resolve(d);
        return Boolean(agyState.orientedDirs?.includes(key) || agyState.orientedRepos?.[key] || readWorkspace(d, contextDirFor(d)));
    };
    const hasUnorientedDir = Boolean(
        isNewPrompt
        && workspaceDirs.some((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)) && !isOrientedDir(d)),
    );
    const curGuardStage = agyState.exploreGuardStage ?? (agyState.exploreGuardEmitted ? 1 : 0);
    const trackExploreGuard = Boolean(
        !isNewPrompt
        && agyState.isEditPrompt
        && !agyState.editedInPrompt
        && curGuardStage < 2
        && agyState.orchestratorPhase !== 'plan',
    );
    if (trackExploreGuard) agyState.preEditInvocations = (agyState.preEditInvocations ?? 0) + 1;
    const exploreGuardStageDue = trackExploreGuard
        ? (curGuardStage < 1 && agyState.preEditInvocations >= 4 ? 1 : (curGuardStage === 1 && agyState.preEditInvocations >= 8 ? 2 : 0))
        : 0;
    if (!isNewPrompt && !hasPendingWork && !hasUnorientedDir && !needsColdBuild && !exploreGuardStageDue) {
        if (compacted || forkSeeded || trackExploreGuard) saveAgyContext(sid, agyState, opts);
        return emitHookPayload('{}\n', opts);
    }
    if (isNewPrompt || needsColdBuild) await refreshWorkspaceDirs(workspaceDirs, opts);
    const indexedDirs = workspaceDirs.filter((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)));
    const badgeInfo = { retrievalCount: 0, files: [], coEditCount: 0, blastFile: null, midLoopFile: null, oriented: false, weakScore: null };
    if (dir && indexedDirs.length > 0) writeAgyLastRepo(dir);
    const isReadOnly = isReadOnlyTurnInput(input, rawPrompt);
    const messages = collectPendingMessages(agyState, badgeInfo, { isNewPrompt });
    if (isNewPrompt) {
        agyState.lastProcessedPrompt = prompt;
        agyState.lastProcessedStep = agyState.lastUserStep;
        const txt = runSharedTurn0Query({ indexedDirs, rawPrompt, input, agyState, badgeInfo, hostKind: 'agy', deferSeenRecord: true });
        if (txt) messages.push(txt);
        else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
    } else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
    if (exploreGuardStageDue === 1) {
        agyState.exploreGuardEmitted = true;
        agyState.exploreGuardStage = 1;
        const targetList = agyState.editTargetFiles?.length
            ? agyState.editTargetFiles.join(', ')
            : 'localized above';
        messages.push(
            `[plexer] 4 exploration turns elapsed with 0 edits. Target files (${targetList}) are localized — apply your edits now instead of reading unrelated files.`,
        );
    } else if (exploreGuardStageDue === 2) {
        agyState.exploreGuardEmitted = true;
        agyState.exploreGuardStage = 2;
        const targetList = agyState.editTargetFiles?.length
            ? agyState.editTargetFiles.join(', ')
            : 'localized above';
        messages.push(
            `[plexer] 8 exploration turns elapsed with 0 edits. Stop running further search/read turns — synthesize the code already in context (${targetList}) and apply your edits now so long loops do not evict your prompt cache.`,
        );
    }
    const orients = collectMissingOrientations(indexedDirs, agyState, badgeInfo, {
        isReadOnly,
        skipEmit: Boolean(agyState.turn0Matched || !isNewPrompt),
    });
    if (orients.length > 0) messages.unshift(...orients);
    const ephMsg = messages.length > 0 ? fitAgyEphemeral(messages.join('\n\n'), 12000) : '';
    if (agyState.turn0Matched && ephMsg) {
        agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
        recordEmittedRetrievalTextSpans(agyState.seenSpans, ephMsg, '');
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload(buildAgyPreInvocationResponse(messages, badgeInfo, opts, input, ephMsg), opts);
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
    const txt = runSharedTurn0Query({ indexedDirs: [root], rawPrompt, input, agyState, badgeInfo: null, hostKind });
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
