import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { incomingEdges, relevantRetrieval } from '../../claude/format.js';
import { queryPromptContext, readOrientation, triggerBackgroundSync } from '../../claude/hooks.js';
import { loadGraphCached } from '../../context/graph-store.js';
import { wiringPath } from '../../context/node-file.js';
import { driftCount, isClean, probeDrift } from '../../graph/fingerprint.js';
import { ensureFreshGraph } from '../../graph/refresh.js';
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from '../../graph/root.js';
import { readWorkspaceMeta } from '../../graph/workspace-path.js';
import { sqliteHasGraph } from '../../storage/sqlite-store.js';
import { writeAgyLastRepo } from '../../agy/session.js';
import { buildUniqueRepoLabels, pickRepoForTargetPath, queryMultiWorkspaceContext } from '../../agy/multi-workspace.js';
import { buildPlanExecutionHandoff } from '../../agy/plan-handoff.js';
import { applySeenSpansFilter, detectCompactionReset, invalidateSpanIfModified, mergeSpan, normalizeRelFile, recordEmittedRetrievalTextSpans, stampSeenMtime } from '../../agy/spans.js';
import { seedForkedSwarmSession } from '../../agy/swarm-sync.js';
import { isReadOnlySubagentInput, stripCliNudges, stripSubagentBoilerplate } from '../../agy/subagent.js';
import { contextDirFor } from '../../util/paths.js';
import { readSession, writeSession } from '../../util/state.js';
import { isExtraHighEffortInput, isFastGeminiModelProfile, isGeminiModelProfile, isHighOrExtraHighEffortInput, isNarrowPrompt, isOrchestratorInput } from './prompt/budget.js';
import { PLAN_SLASH_RE, READ_ONLY_SLASH_RE, isLikelyEditSessionPrompt, isSyntheticOrMetaPrompt } from './prompt/intent.js';
import { capturePreCompactionTargets, extractMetadataContext, extractPathsFromText, stripUserRequestTags } from './agy-transcript.js';
import {
    HOST_KINDS, activeWorkspaceDirs, buildMidLoopHint, emitHookPayload, fitAgyEphemeral,
    formatAgyUserMarkdown, isEarlyIsolatedBenchCall, isInteractiveAgyAppInput, isIsolatedBenchDir, loadAgyContext,
    normalizePromptKey, readAgyPlanExecuteFlag, readEngineSession, resolveHostProjectDir, resolveHostSessionId, saveAgyContext,
} from './agy-context.js';

const INLINE_REFRESH_BUDGET_MS = 200;
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
            if (!sqliteHasGraph(outDir) && !existsSync(wiringPath(outDir))) {
                const fresh = await executeLocked();
                if (fresh?.refreshed && typeof opts.onGraphRefreshed === 'function') opts.onGraphRefreshed(wsDir);
                continue;
            }
            if (typeof opts.hasInFlightRefresh === 'function' && opts.hasInFlightRefresh(wsDir)) continue;
            const drift = typeof opts.probeDrift === 'function' ? opts.probeDrift(wsDir, outDir) : probeDrift(wsDir, outDir);
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

export function collectPendingMessages(agyState, badgeInfo = null, { isNewPrompt = false, input = null, workspaceDirs = [], opts = {} } = {}) {
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
        (agyState.pendingPlanHandoff || agyState.pendingPlanText)
        && (!agyState.pendingPlanAwaitApproval || isNewPrompt || agyState.orchestratorPhase === 'execute'),
    );
    if (canEmitPlanHandoff) {
        if (!agyState.pendingPlanHandoff && agyState.pendingPlanText) {
            const dirs = agyState.pendingPlanWorkspaceDirs?.length ? agyState.pendingPlanWorkspaceDirs : workspaceDirs;
            const highProfile = isHighOrExtraHighEffortInput(input)
                || isHighOrExtraHighEffortInput({ modelName: agyState?.plannerModel })
                || (isOrchestratorInput(input, agyState) && !/(?:^|[-_\s(])(?:low|medium)(?:$|[)\s_-])/i.test(String(input?.modelName ?? agyState?.plannerModel ?? '')));
            const handoff = buildPlanExecutionHandoff(dirs, agyState.pendingPlanText, agyState, {
                getGraph: opts?.getGraph,
                geminiProfile: isGeminiModelProfile(input, 'agy'),
                xhighProfile: isExtraHighEffortInput(input),
                highProfile,
                includeExecuteDirective: true,
            });
            if (handoff?.text) {
                agyState.pendingPlanHandoff = handoff.text;
                agyState.pendingPlanSpans = handoff.spans ?? [];
                if (handoff.targetFiles?.length) {
                    agyState.planTargetFiles = [...new Set([...(agyState.planTargetFiles ?? []), ...handoff.targetFiles])];
                }
            }
        }
        if (agyState.pendingPlanHandoff) {
            messages.push(agyState.pendingPlanHandoff);
            if (Array.isArray(agyState.pendingPlanSpans)) {
                agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
                const spanDirs = agyState.pendingPlanWorkspaceDirs?.length ? agyState.pendingPlanWorkspaceDirs : workspaceDirs;
                for (const sp of agyState.pendingPlanSpans) {
                    if (sp?.key) {
                        mergeSpan(agyState.seenSpans, sp.key, sp.start, sp.end);
                        stampSeenMtime(agyState, sp.key, spanDirs);
                    }
                }
            }
        }
        agyState.pendingPlanHandoff = null;
        agyState.pendingPlanText = null;
        agyState.pendingPlanWorkspaceDirs = [];
        agyState.pendingPlanSpans = [];
        agyState.pendingPlanAwaitApproval = false;
    }
    return messages;
}

export function resetCompactSessionState(dir, sid, agyState) {
    capturePreCompactionTargets(agyState);
    agyState.seenSpans = {};
    agyState.turn0SeenKeys = [];
    agyState.seenMtimes = {};
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
    agyState.preEditInvocations = 0;
    agyState.preEditToolTurns = 0;
    agyState.lastPreEditToolAtMs = 0;
    agyState.planTargetFiles = [];
    agyState.pendingPlanText = null;
    agyState.pendingPlanWorkspaceDirs = [];
    agyState.seenSearchKeys = [];
    agyState.lastBlockedSearchKey = null;
    agyState.blockedSearchKeys = [];
    agyState.lastBlockedReadKey = null;
    agyState.blockedReadKeys = [];
    agyState.orchestratorPhase = agyState.isOrchestratorModel ? 'plan' : null;
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
        if (agyState.orientedDirs.includes(key) || agyState.orientedRepos?.[key] || readWorkspaceMeta(wsDir, contextDirFor(wsDir))) continue;
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
        agyState.turn0SeenKeys = [];
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
    const xhighProfile = isExtraHighEffortInput(input);
    const fastProfile = geminiProfile && isFastGeminiModelProfile(input);
    const likelyEditSession = !isPureReadOnly && !isPlanMode
        && isLikelyEditSessionPrompt(trimmedPrompt, { forceReadOnly: isPureReadOnly, planMode: isPlanMode });
    const distilled = stripSubagentBoilerplate(rawPrompt);
    const narrowPrompt = !isPlanMode && isNarrowPrompt(distilled);
    const queryOpts = { forceReadOnly: isPureReadOnly, geminiProfile, xhighProfile, fastProfile, narrowPrompt, planMode: isPlanMode };
    const askRaw = indexedDirs.length > 1
        ? queryMultiWorkspaceContext(indexedDirs, distilled, queryOpts)
        : queryPromptContext(indexedDirs[0], distilled, queryOpts);
    if (!askRaw) {
        agyState.isEditPrompt = likelyEditSession;
        return null;
    }
    if (agyState?.seenSpans && agyState?.seenMtimes && Object.keys(agyState.seenSpans).length > 0) {
        for (const k of Object.keys(agyState.seenSpans)) {
            invalidateSpanIfModified(agyState, k, indexedDirs);
        }
    }
    const ask = applySeenSpansFilter(askRaw, agyState.seenSpans)?.ask ?? askRaw;
    const isEditTurn = Boolean(ask.isEditPrompt || ask.editEnvelope);
    const targetPool = ask.hits?.length ? ask.hits : (ask.candidateMap ?? []);
    const targetFiles = [...new Set(targetPool.map((h) => String(h.pointer ?? '').split(':')[0]).filter(Boolean))].slice(0, 3);
    let txt = relevantRetrieval(
        ask,
        agyState,
        (fastProfile || narrowPrompt) ? 3 : 4,
        { suppressNudge: isPureReadOnly || !geminiProfile, planMode: isPlanMode, geminiProfile, xhighProfile, fastProfile, narrowPrompt, prompt: distilled },
    );
    if (isReadOnlySub && txt) txt = stripCliNudges(txt);
    if (!txt || txt.startsWith('[plexer] no strong match for this prompt')) {
        if (badgeInfo && typeof ask.coverageStrong === 'number') badgeInfo.weakScore = ask.coverageStrong;
        agyState.isEditPrompt = Boolean(!isPureReadOnly && (isEditTurn || likelyEditSession));
        agyState.editTargetFiles = targetFiles;
        return txt || null;
    }
    txt = fitAgyEphemeral(txt, 12000);
    agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
    if (!deferSeenRecord) {
        const touchedKeys = recordEmittedRetrievalTextSpans(agyState.seenSpans, txt, '');
        for (const k of touchedKeys) stampSeenMtime(agyState, k, indexedDirs);
        agyState.turn0SeenKeys = [...touchedKeys];
    }
    agyState.turn0Matched = true;
    agyState.isEditPrompt = Boolean(!isPureReadOnly && (isEditTurn || likelyEditSession));
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

function consumePostCompactAnchor(agyState, indexedDirs, badgeInfo, input, opts) {
    const rawAnchors = Array.isArray(agyState?.postCompactAnchorFiles) ? agyState.postCompactAnchorFiles.splice(0, 3) : [];
    if (agyState) agyState.postCompactAnchorFiles = [];
    if (rawAnchors.length === 0 || indexedDirs.length === 0 || isReadOnlySubagentInput(input)) return null;

    const seenTurn0 = new Set((badgeInfo?.files ?? []).map((f) => normalizeRelFile(f)));
    const multiRoot = indexedDirs.length >= 2;
    const labels = buildUniqueRepoLabels(indexedDirs);
    const lines = [];
    const seenKeys = new Set();

    for (const rawPath of rawAnchors) {
        if (lines.length >= 3) break;
        for (let i = 0; i < indexedDirs.length; i++) {
            const wsDir = indexedDirs[i];
            const prefix = multiRoot ? `${labels[i]}/` : '';
            let candRel = normalizeRelFile(rawPath);
            if (isAbsolute(rawPath)) {
                const rel = relative(resolve(wsDir), resolve(rawPath)).replace(/\\/g, '/');
                if (!rel || rel.startsWith('..')) continue;
                candRel = normalizeRelFile(rel);
            } else if (multiRoot && candRel.startsWith(prefix)) {
                candRel = candRel.slice(prefix.length);
            }
            if (!candRel) continue;
            let graph = null;
            try {
                graph = typeof opts?.getGraph === 'function' ? opts.getGraph(wsDir) : loadGraphCached(contextDirFor(wsDir));
            } catch { /* ignore */ }
            if (!graph?.nodes?.length) continue;
            const fileNode = graph.nodes.find((n) => n.kind === 'file' && (n.path === candRel || n.path?.endsWith(`/${candRel}`)));
            if (!fileNode?.path) continue;
            const relNorm = normalizeRelFile(fileNode.path);
            const prefixedKey = normalizeRelFile(`${prefix}${relNorm}`);
            if (seenTurn0.has(relNorm) || seenTurn0.has(prefixedKey) || seenKeys.has(prefixedKey)) break;
            seenKeys.add(prefixedKey);

            const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
            const syms = (graph._nodesByPath?.get(fileNode.path) ?? graph.nodes.filter((n) => n.path === fileNode.path))
                .filter((n) => n.kind !== 'file' && n.name)
                .slice(0, 4)
                .map((n) => `${n.name}(${n.span || 'L1'})`);
            const callers = [...new Set(
                (incomingEdges(graph, resolve(wsDir, fileNode.path), wsDir) ?? [])
                    .map((e) => byId.get(e.source)?.name || byId.get(e.source)?.path || '')
                    .filter(Boolean),
            )].slice(0, 3);
            const lc = fileNode.lines ?? fileNode.lineCount;
            const linesTag = lc ? ` (${lc}L)` : '';
            lines.push(
                ` • ${prefixedKey}${linesTag}${syms.length ? `: ${syms.join(', ')}` : ''}${callers.length ? ` | callers: ${callers.join(', ')}` : ''}`,
            );
            break;
        }
    }
    if (lines.length === 0) return null;
    const header = '[plexer] post-compaction working-set anchor (prior active files; read specific Lx-Ly spans if needed):';
    const kept = [header];
    for (const ln of lines) {
        const next = `${kept.join('\n')}\n${ln}`;
        if (Buffer.byteLength(next, 'utf8') > 1800) break;
        kept.push(ln);
    }
    return kept.length > 1 ? kept.join('\n') : null;
}

function buildAgyPreInvocationResponse(messages, badgeInfo, opts, input = null, ephMsgOverride = null) {
    if (messages.length === 0) return '{}\n';
    const ephMsg = ephMsgOverride ?? fitAgyEphemeral(messages.join('\n\n'), 12000);
    const useEnvMd = !opts.envFlags || typeof opts.envFlags !== 'object';
    const disabledMd = opts.enableUserMarkdown === false || opts.envFlags?.enableUserMarkdown === false || (useEnvMd && process.env.PLEXER_AGY_USER_MARKDOWN === '0');
    const explicitMd = opts.enableUserMarkdown === true || opts.envFlags?.enableUserMarkdown === true || (useEnvMd && process.env.PLEXER_AGY_USER_MARKDOWN === '1');
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
        capturePreCompactionTargets(agyState);
        agyState.lastProcessedPrompt = null;
        agyState.lastProcessedStep = null;
        agyState.planTargetFiles = [];
        agyState.pendingPlanText = null;
        agyState.pendingPlanWorkspaceDirs = [];
        agyState.orchestratorPhase = agyState.isOrchestratorModel ? 'plan' : null;
    }
    const forkSeeded = seedForkedSwarmSession(sid, agyState, opts);
    applyDirectPromptInput(input, agyState);
    const curModel = String(input?.modelName ?? '').trim();
    if (curModel) agyState.lastObservedModel = curModel;
    if (/orchestrator/i.test(curModel)) {
        agyState.isOrchestratorModel = true;
        agyState.orchestratorExplicitlyDisabled = false;
    }
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    if (isIsolatedBenchDir(dir, opts.envFlags) || workspaceDirs.some((d) => isIsolatedBenchDir(d, opts.envFlags))) return emitHookPayload('{}\n', opts);
    const rawPrompt = String(agyState.lastUserPrompt ?? '').trim();
    const prompt = normalizePromptKey(rawPrompt);
    const isNewStep = typeof agyState.lastUserStep === 'number' && agyState.lastUserStep !== agyState.lastProcessedStep;
    const isNewPrompt = Boolean(prompt && (prompt !== agyState.lastProcessedPrompt || isNewStep));
    if (isNewPrompt || Number(input?.invocationNum ?? 0) <= 1 || !agyState.planExecuteChecked) {
        const planExecFlag = readAgyPlanExecuteFlag(input);
        if (planExecFlag === true) {
            agyState.isOrchestratorModel = true;
            agyState.orchestratorExplicitlyDisabled = false;
            agyState.planExecuteChecked = true;
            if (!agyState.orchestratorPhase) agyState.orchestratorPhase = 'plan';
            if (curModel && agyState.orchestratorPhase === 'plan') agyState.plannerModel = curModel;
        } else if (planExecFlag === false) {
            agyState.isOrchestratorModel = false;
            agyState.orchestratorExplicitlyDisabled = true;
            agyState.planExecuteChecked = true;
            agyState.orchestratorPhase = null;
            agyState.plannerModel = null;
            agyState.executorModel = null;
        }
    }
    if (agyState.isOrchestratorModel) {
        if (agyState.orchestratorPhase === 'execute' && curModel && agyState.plannerModel && curModel !== agyState.plannerModel && !agyState.executorModel) {
            agyState.executorModel = curModel;
        } else if (agyState.orchestratorPhase === 'execute' && curModel && agyState.plannerModel && agyState.executorModel
            && curModel === agyState.plannerModel && curModel !== agyState.executorModel
            && !agyState.pendingPlanText && !agyState.pendingPlanHandoff) {
            agyState.orchestratorPhase = 'plan';
        }
    }
    const isPlanApproval = Boolean(
        agyState.pendingPlanAwaitApproval
        && /^(?:please\s+)?(?:proceed|go\s+ahead|approve[d]?|lgtm|yes|yep|sure|ok(?:ay)?|looks\s+good|ship\s+it|execute(?:\s+(?:it|the\s+plan))?|apply(?:\s+(?:it|the\s+plan))?|implement(?:\s+(?:it|the\s+plan))?)[.!?\s]*$/i.test(rawPrompt),
    );
    if (isNewPrompt && agyState.hasDirectUserInput && !/\[plan review(?:\s+due)?\]/i.test(rawPrompt)) {
        if (isPlanApproval) {
            agyState.orchestratorPhase = 'execute';
        } else {
            agyState.orchestratorPhase = agyState.isOrchestratorModel ? 'plan' : null;
            agyState.planTargetFiles = [];
        }
    }
    const hasPendingPlanHandoff = Boolean(
        (agyState.pendingPlanHandoff || agyState.pendingPlanText)
        && (!agyState.pendingPlanAwaitApproval || isNewPrompt || agyState.orchestratorPhase === 'execute'),
    );
    const hasPendingWork = Boolean(
        agyState.pendingBlastRadius
        || hasPendingPlanHandoff
        || Boolean(isNewPrompt && agyState.postCompactAnchorFiles?.length > 0)
        || (!agyState.turn0Matched && !agyState.midLoopHintEmitted && agyState.pendingMidLoopFile),
    );
    const isOrientedDir = (d) => {
        const key = resolve(d);
        return Boolean(agyState.orientedDirs?.includes(key) || agyState.orientedRepos?.[key] || readWorkspaceMeta(d, contextDirFor(d)));
    };
    const isInteractiveInterview = /(?:^|\s)\/grill-me\b/i.test(rawPrompt);
    const isReadOnlySub = isReadOnlySubagentInput(input, rawPrompt);
    const curGuardStage = agyState.exploreGuardStage ?? (agyState.exploreGuardEmitted ? 1 : 0);
    const inPlanPhase = agyState.orchestratorPhase === 'plan';
    const inExecutePhase = agyState.orchestratorPhase === 'execute';
    const isQaTurn = !agyState.isEditPrompt && agyState.turn0Matched;
    const maxGuardStage = (inPlanPhase || isQaTurn) ? 1 : 2;
    const maybeExploreGuard = Boolean(
        !isReadOnlySub
        && !isInteractiveInterview
        && !isNewPrompt
        && !hasPendingPlanHandoff
        && (agyState.isEditPrompt || isQaTurn)
        && !agyState.editedInPrompt
        && curGuardStage < maxGuardStage,
    );
    const sessionOrientedInMem = workspaceDirs.every((d) => (
        isIsolatedBenchDir(d, opts.envFlags)
        || Boolean(agyState.orientedDirs?.includes(resolve(d)) || agyState.orientedRepos?.[resolve(d)])
    ));
    if (!isNewPrompt && !hasPendingWork && !maybeExploreGuard && sessionOrientedInMem) {
        if (compacted || forkSeeded || agyState._dirtyTranscriptOffset) saveAgyContext(sid, agyState, opts);
        return emitHookPayload('{}\n', opts);
    }
    const hasIndexedWorkspace = workspaceDirs.some((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)));
    const trackExploreGuard = Boolean(hasIndexedWorkspace && maybeExploreGuard);
    if (trackExploreGuard) agyState.preEditInvocations = (agyState.preEditInvocations ?? 0) + 1;
    const isHighEffortReasoning = isHighOrExtraHighEffortInput(input)
        || isHighOrExtraHighEffortInput({ modelName: agyState?.plannerModel });
    const stage1At = inExecutePhase
        ? 2
        : (isQaTurn
            ? (isHighEffortReasoning ? 5 : 4)
            : (inPlanPhase && isHighEffortReasoning ? 6 : 4));
    const stage2At = inExecutePhase ? 5 : 8;
    const exploreGuardStageDue = trackExploreGuard
        ? (curGuardStage < 1 && agyState.preEditInvocations >= stage1At ? 1 : (!inPlanPhase && !isQaTurn && curGuardStage === 1 && agyState.preEditInvocations >= stage2At ? 2 : 0))
        : 0;
    if (!isNewPrompt && !hasPendingWork && !exploreGuardStageDue && sessionOrientedInMem) {
        if (compacted || forkSeeded || trackExploreGuard || agyState._dirtyTranscriptOffset) saveAgyContext(sid, agyState, opts);
        return emitHookPayload('{}\n', opts);
    }
    const needsColdBuild = workspaceDirs.some((d) => {
        if (isIsolatedBenchDir(d, opts.envFlags)) return false;
        const outDir = contextDirFor(d);
        return !sqliteHasGraph(outDir) && !existsSync(wiringPath(outDir)) && (existsSync(outDir) || hasPlexerIndex(d) || isAutoBuildableRepo(d));
    });
    const hasUnorientedDir = Boolean(
        isNewPrompt
        && workspaceDirs.some((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)) && !isOrientedDir(d)),
    );
    if (!isNewPrompt && !hasPendingWork && !hasUnorientedDir && !needsColdBuild && !exploreGuardStageDue) {
        if (compacted || forkSeeded || trackExploreGuard || agyState._dirtyTranscriptOffset) saveAgyContext(sid, agyState, opts);
        return emitHookPayload('{}\n', opts);
    }
    if (isNewPrompt || needsColdBuild) await refreshWorkspaceDirs(workspaceDirs, opts);
    const indexedDirs = workspaceDirs.filter((d) => !isIsolatedBenchDir(d, opts.envFlags) && existsSync(contextDirFor(d)));
    const badgeInfo = { retrievalCount: 0, files: [], coEditCount: 0, blastFile: null, midLoopFile: null, oriented: false, weakScore: null };
    if (dir && indexedDirs.length > 0) writeAgyLastRepo(dir);
    const isReadOnly = isReadOnlyTurnInput(input, rawPrompt);
    const messages = collectPendingMessages(agyState, badgeInfo, { isNewPrompt, input, workspaceDirs, opts });
    if (isNewPrompt) {
        agyState.lastProcessedPrompt = prompt;
        agyState.lastProcessedStep = agyState.lastUserStep;
        const txt = runSharedTurn0Query({ indexedDirs, rawPrompt, input, agyState, badgeInfo, hostKind: 'agy', deferSeenRecord: true });
        if (txt) messages.push(txt);
        else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
        const anchorMsg = consumePostCompactAnchor(agyState, indexedDirs, badgeInfo, input, opts);
        if (anchorMsg) messages.push(anchorMsg);
    } else applyAgyMidLoop(agyState, indexedDirs, messages, badgeInfo, opts);
    if (exploreGuardStageDue === 1) {
        agyState.exploreGuardEmitted = true;
        agyState.exploreGuardStage = 1;
        const targetPool = agyState.planTargetFiles?.length ? agyState.planTargetFiles : agyState.editTargetFiles;
        const targetList = targetPool?.length ? targetPool.join(', ') : 'localized above';
        if (isQaTurn) {
            messages.push(
                `[plexer] ${stage1At} search turns elapsed — relevant spans and call sites are already in context; synthesize your final answer directly now instead of running more reads or greps.`,
            );
        } else if (inPlanPhase) {
            messages.push(
                `[plexer] ${stage1At} planning turns elapsed (${targetList} in context) — once remaining facts are verified, call \`exit_plan_mode\` with a concise \`file:Lx-Ly\` edit plan (no full code reprints).`,
            );
        } else if (inExecutePhase) {
            messages.push(
                `[plexer] ${stage1At} execution turns elapsed with 0 edits after \`exit_plan_mode\`. Planned targets (${targetList}) are already in context — apply your edits in 1 parallel turn now instead of re-reading.`,
            );
        } else {
            const xhighPlanHint = isHighOrExtraHighEffortInput(input) ? ' (or call `exit_plan_mode` if in plan mode)' : '';
            messages.push(
                `[plexer] 4 exploration turns elapsed with 0 edits. Target files (${targetList}) are localized — apply your edits${xhighPlanHint} now instead of reading unrelated files.`,
            );
        }
    } else if (exploreGuardStageDue === 2) {
        agyState.exploreGuardEmitted = true;
        agyState.exploreGuardStage = 2;
        const targetPool = agyState.planTargetFiles?.length ? agyState.planTargetFiles : agyState.editTargetFiles;
        const targetList = targetPool?.length ? targetPool.join(', ') : 'localized above';
        if (inExecutePhase) {
            messages.push(
                `[plexer] ${stage2At} execution turns elapsed with 0 edits after \`exit_plan_mode\`. Stop running further search/read turns — apply the planned edits to (${targetList}) immediately.`,
            );
        } else {
            const xhighPlanHint = isHighOrExtraHighEffortInput(input) ? ' (or call `exit_plan_mode` if in plan mode)' : '';
            messages.push(
                `[plexer] 8 exploration turns elapsed with 0 edits. Stop running further search/read turns — synthesize the code already in context (${targetList}) and apply your edits${xhighPlanHint} now so long loops do not evict your prompt cache.`,
            );
        }
    }
    const orients = collectMissingOrientations(indexedDirs, agyState, badgeInfo, {
        isReadOnly,
        skipEmit: Boolean(agyState.turn0Matched || !isNewPrompt || (rawPrompt && !agyState.turn0Matched && !agyState.pendingBlastRadius && !hasPendingPlanHandoff)),
    });
    if (orients.length > 0) messages.unshift(...orients);
    const ephMsg = messages.length > 0 ? fitAgyEphemeral(messages.join('\n\n'), 12000) : '';
    if (agyState.turn0Matched && ephMsg) {
        agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
        const touchedKeys = recordEmittedRetrievalTextSpans(agyState.seenSpans, ephMsg, '');
        for (const k of touchedKeys) stampSeenMtime(agyState, k, indexedDirs);
        agyState.turn0SeenKeys = [...touchedKeys];
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
    return emitHookPayload('', opts);
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
        const ranTurn0Query = Boolean(rawPrompt && !isSyntheticOrMetaPrompt(rawPrompt));
        if (agyState.turn0Matched || ranTurn0Query) agyState.orientedDirs.push(rootKey);
        else if (spec.emitOrientationOnTurn0 && !ranTurn0Query && rawPrompt) {
            const orient = readOrientation(root, 1200);
            if (orient) { parts.unshift(orient); agyState.orientedDirs.push(rootKey); }
        }
    }
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload(formatHostTurn0Output(hostKind, parts.join('\n\n')), opts);
}
