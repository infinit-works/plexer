import {
    closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { unquoteArg } from '../../util/span.js';

let cachedSkillRoots = null;

function skillTargetRoots() {
    if (cachedSkillRoots) return cachedSkillRoots;
    const roots = new Set();
    const home = homedir();
    const homeNorm = home.replace(/\\/g, '/');
    const addRoot = (p) => { if (p && p !== '/' && p !== homeNorm) roots.add(p); };
    for (const base of [join(home, '.gemini', 'skills'), join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
        try { addRoot(realpathSync(base).replace(/\\/g, '/')); } catch { /* ignore */ }
        try {
            for (const name of readdirSync(base)) {
                try {
                    const realTarget = realpathSync(join(base, name)).replace(/\\/g, '/');
                    addRoot(realTarget);
                    addRoot(dirname(realTarget).replace(/\\/g, '/'));
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }
    cachedSkillRoots = [...roots];
    return cachedSkillRoots;
}

export function normalizePromptKey(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function isIgnoredTouchedPath(p, workspaceRoot = null) {
    if (!p || typeof p !== 'string' || !isAbsolute(p)) return true;
    const norm = p.replace(/\\/g, '/');
    if (/\/(?:\.gemini|\.agents|\.claude|\.codex)(?:\/|$)/.test(norm)) return true;
    const wsNorm = typeof workspaceRoot === 'string' ? workspaceRoot.replace(/\\/g, '/') : '';
    for (const root of skillTargetRoots()) {
        if ((norm === root || norm.startsWith(`${root}/`)) && (!wsNorm || !(wsNorm === root || wsNorm.startsWith(`${root}/`)))) {
            return true;
        }
    }
    return false;
}

export function extractPathsFromText(raw, sessionState) {
    if (!raw || typeof raw !== 'string') return;
    let m;
    const mentionRe = /@\[([^\]]+)\]/g;
    while ((m = mentionRe.exec(raw)) !== null) {
        if (m[1] && !isIgnoredTouchedPath(m[1])) sessionState.lastTouchedPath = m[1];
    }
    const absRe = /(?:`|["'\s]|^)(\/(?:home|tmp|var|opt|srv|Users|private\/tmp)\/[A-Za-z0-9._/-]+)/g;
    while ((m = absRe.exec(raw)) !== null) {
        const candidate = m[1].replace(/[.,;:!?)'"`]+$/, '');
        if (!isIgnoredTouchedPath(candidate) && existsSync(candidate)) sessionState.lastTouchedPath = candidate;
    }
}

export function extractPathsFromEntry(obj, sessionState) {
    if (!obj || typeof obj !== 'object') return;
    const calls = [...(obj.tool_calls ?? []), ...(obj.toolCalls ?? [])];
    if (obj.toolCall) calls.push(obj.toolCall);
    if (obj.tool_use) calls.push(obj.tool_use);
    for (const call of calls) {
        const name = String(call?.name ?? call?.tool ?? call?.function?.name ?? '');
        let args = call?.args ?? call?.arguments ?? call?.input ?? call?.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        for (const key of ['Path', 'TargetFile', 'AbsolutePath', 'Cwd', 'SearchPath', 'DirectoryPath']) {
            const p = unquoteArg(args?.[key]);
            if (!p || isIgnoredTouchedPath(p)) continue;
            sessionState.lastTouchedPath = p;
            if ((key === 'Path' || key === 'TargetFile') && /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file)$/i.test(name)) {
                sessionState.lastEditedFile = p;
                sessionState.editedInPrompt = true;
            }
        }
    }
}

function modelTokens(raw) {
    return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function modelDisplayMatchesId(displayLabel, modelId) {
    if (!displayLabel || !modelId) return false;
    const setA = new Set(modelTokens(displayLabel));
    const toksB = modelTokens(modelId);
    return setA.size > 0 && toksB.length > 0 && toksB.every((t) => setA.has(t));
}

export function extractMetadataContext(raw, sessionState) {
    if (!raw || typeof raw !== 'string' || !sessionState || typeof sessionState !== 'object')
        return;
    const metaMatch = /<ADDITIONAL_METADATA>([\s\S]*?)(?:<\/ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|$)/i.exec(raw);
    if (metaMatch?.[1]) {
        extractPathsFromText(metaMatch[1], sessionState);
    }
    const settingsMatch = /<USER_SETTINGS_CHANGE>([\s\S]*?)(?:<\/USER_SETTINGS_CHANGE>|$)/i.exec(raw);
    if (settingsMatch?.[1]) {
        const ms = /`Model Selection`\s+from\s+([^\n]+?)\s+to\s+([^\n.]+)/i.exec(settingsMatch[1]);
        if (ms?.[2]) {
            const fromModel = ms[1].trim();
            const targetModel = ms[2].trim();
            if (/orchestrator/i.test(targetModel)) {
                sessionState.isOrchestratorModel = true;
                sessionState.orchestratorExplicitlyDisabled = false;
                if (!sessionState.orchestratorPhase)
                    sessionState.orchestratorPhase = 'plan';
            }
            else if (/claude|gemini|neon|carbon|hydrogen|flash|gpt/i.test(targetModel)) {
                const isFromNone = /^none$/i.test(fromModel);
                const isFromOrch = /orchestrator/i.test(fromModel);
                const matchesKnownRole = modelDisplayMatchesId(targetModel, sessionState.plannerModel)
                    || modelDisplayMatchesId(targetModel, sessionState.executorModel);
                if (!isFromNone && (isFromOrch || (sessionState.isOrchestratorModel && !matchesKnownRole))) {
                    sessionState.isOrchestratorModel = false;
                    sessionState.orchestratorExplicitlyDisabled = true;
                    sessionState.orchestratorPhase = null;
                    sessionState.plannerModel = null;
                    sessionState.executorModel = null;
                }
            }
        }
    }
}

export function stripUserRequestTags(text) {
    const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|$)/i.exec(text);
    return (m ? m[1] : text).trim();
}

const FULL_HYDRATE_CHUNK_BYTES = 65536;
const FULL_HYDRATE_MAX_SCAN_BYTES = 4 * 1024 * 1024;

function hydrateFromFullTranscriptTail(transcriptPath, neededKeys) {
    if (!neededKeys || neededKeys.size === 0 || basename(transcriptPath) !== 'transcript.jsonl')
        return new Map();
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl');
    if (!existsSync(fullPath))
        return new Map();
    let fd = null;
    try {
        const size = statSync(fullPath).size;
        if (size <= 0) return new Map();
        const found = new Map();
        const remaining = new Set(neededKeys);
        const minPos = Math.max(0, size - FULL_HYDRATE_MAX_SCAN_BYTES);
        fd = openSync(fullPath, 'r');
        let endPos = size;
        let carry = '';
        while (endPos > minPos && remaining.size > 0) {
            const readPos = Math.max(minPos, endPos - FULL_HYDRATE_CHUNK_BYTES);
            const len = endPos - readPos;
            const buf = Buffer.allocUnsafe(len);
            let total = 0;
            while (total < len) {
                const n = readSync(fd, buf, total, len - total, readPos + total);
                if (n <= 0) break;
                total += n;
            }
            if (total <= 0) break;
            const text = buf.subarray(0, total).toString('utf8') + carry;
            const lines = text.split('\n');
            carry = readPos > 0 ? (lines.shift() ?? '') : '';
            for (let i = lines.length - 1; i >= 0 && remaining.size > 0; i--) {
                const raw = lines[i];
                if (!raw || !raw.trim() || !raw.includes('"step_index"')) continue;
                try {
                    const o = JSON.parse(raw);
                    if (o?.step_index !== undefined) {
                        const key = `${o.step_index}:${o.type ?? ''}`;
                        if (remaining.has(key)) {
                            found.set(key, o);
                            remaining.delete(key);
                        }
                    }
                } catch { /* ignore malformed line */ }
            }
            endPos = readPos;
        }
        if (remaining.size > 0 && endPos === 0 && carry.trim() && carry.includes('"step_index"')) {
            try {
                const o = JSON.parse(carry);
                if (o?.step_index !== undefined) {
                    const key = `${o.step_index}:${o.type ?? ''}`;
                    if (remaining.has(key)) found.set(key, o);
                }
            } catch { /* ignore */ }
        }
        return found;
    } catch {
        return new Map();
    } finally {
        if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
    }
}

function readTranscriptSlice(transcriptPath, sessionState) {
    const size = statSync(transcriptPath).size;
    let offset = sessionState.transcriptOffset ?? 0;
    if (size < offset || offset < 0) offset = 0;
    if (size === offset) return null;
    const length = size - offset;
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    try { bytesRead = readSync(fd, buf, 0, length, offset); }
    finally { closeSync(fd); }
    const rawSlice = buf.subarray(0, bytesRead);
    const lastNl = rawSlice.lastIndexOf(0x0a);
    if (lastNl !== -1) return { processable: rawSlice.subarray(0, lastNl + 1).toString('utf8'), offset, consumed: lastNl + 1, size };
    const chunk = rawSlice.toString('utf8');
    JSON.parse(chunk.trim());
    return { processable: chunk, offset, consumed: bytesRead, size };
}

function extractRawTextContent(parsed) {
    const raw = parsed?.content ?? parsed?.text ?? parsed?.user_input ?? parsed?.userPrompt ?? parsed?.message?.content ?? '';
    return Array.isArray(raw)
        ? raw.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
        : (typeof raw === 'string' ? raw : '');
}

function extractSubagentSystemMessage(parsed, sessionState = null) {
    if (sessionState?.hasDirectUserInput) return '';
    const stepType = String(parsed?.type ?? '').toUpperCase();
    const stepSrc = String(parsed?.source ?? '').toUpperCase();
    if (stepSrc !== 'SYSTEM' || stepType !== 'SYSTEM_MESSAGE') return '';
    const text = extractRawTextContent(parsed);
    if (!text || !text.includes('[Message]')) return '';
    const m = /\[Message\]([^\n]*?)\bcontent=([\s\S]*)$/i.exec(text);
    if (!m?.[2]) return '';
    const hdr = m[1] ?? '';
    const senderM = /\bsender=([^\s]+)/i.exec(hdr);
    const sender = senderM?.[1] ?? '';
    if (sender && /\/task-\d+\b|(?:^|\/)(?:schedule|cron|timer)\b/i.test(sender)) return '';
    if (sessionState?.lastUserPrompt) {
        if (!sessionState.subagentSenderId || !sender || sender !== sessionState.subagentSenderId) return '';
    }
    const cleaned = m[2].replace(/\s*<\/SYSTEM_MESSAGE>\s*$/i, '').trim();
    if (!cleaned || /^(?:Task id "|\[plan review(?:\s+due)?\])/i.test(cleaned)) return '';
    if (sessionState && !sessionState.subagentSenderId && sender) sessionState.subagentSenderId = sender;
    return cleaned;
}

export function capturePreCompactionTargets(sessionState) {
    if (!sessionState || typeof sessionState !== 'object') return [];
    const raw = [
        ...(Array.isArray(sessionState.postCompactAnchorFiles) ? sessionState.postCompactAnchorFiles : []),
        ...(Array.isArray(sessionState.planTargetFiles) ? sessionState.planTargetFiles : []),
        ...(Array.isArray(sessionState.editTargetFiles) ? sessionState.editTargetFiles : []),
        sessionState.lastEditedFile,
        sessionState.lastReadRelFile,
    ];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        const p = typeof item === 'string' ? item.trim() : '';
        if (!p || (isAbsolute(p) && isIgnoredTouchedPath(p)) || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        if (out.length >= 3) break;
    }
    sessionState.postCompactAnchorFiles = out;
    return out;
}

function resetTranscriptCompactionState(sessionState) {
    capturePreCompactionTargets(sessionState);
    sessionState.seenSpans = {};
    sessionState.fileSliceCounts = {};
    sessionState.lastFileReadEnd = {};
    sessionState.injectedPointers = [];
    sessionState.orientedDirs = [];
    delete sessionState.orientedRepos;
    sessionState.turn0Matched = false;
    sessionState.midLoopHintEmitted = false;
    sessionState.lastBlockedReadKey = null;
    sessionState.blockedReadKeys = [];
    sessionState.lastBlockedSearchKey = null;
    sessionState.blockedSearchKeys = [];
    sessionState.isEditPrompt = false;
    sessionState.editTargetFiles = [];
    sessionState.planTargetFiles = [];
    sessionState.pendingPlanText = null;
    sessionState.pendingPlanWorkspaceDirs = [];
    sessionState.preEditInvocations = 0;
    sessionState.editedInPrompt = false;
    sessionState.exploreGuardEmitted = false;
    sessionState.exploreGuardStage = 0;
    sessionState.orchestratorPhase = sessionState.isOrchestratorModel ? 'plan' : null;
}

function applyTranscriptEntry(parsed, stepFallback, sessionState) {
    extractPathsFromEntry(parsed, sessionState);
    const stepType = String(parsed?.type ?? '').toUpperCase();
    const stepSrc = String(parsed?.source ?? '').toUpperCase();
    const explicitStep = parsed?.step_index ?? parsed?.step ?? parsed?.index;
    const hasExplicitStep = typeof explicitStep === 'number' && Number.isFinite(explicitStep);
    const stepIdx = hasExplicitStep ? explicitStep : stepFallback;
    if (stepType === 'CHECKPOINT') {
        if (!hasExplicitStep || typeof sessionState.lastCheckpointStep !== 'number' || explicitStep > sessionState.lastCheckpointStep) {
            resetTranscriptCompactionState(sessionState);
            if (hasExplicitStep) sessionState.lastCheckpointStep = explicitStep;
        }
        return;
    }
    if (stepType === 'PLANNER_RESPONSE') {
        const calls = [...(parsed?.tool_calls ?? []), ...(parsed?.toolCalls ?? [])];
        const stepModel = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
        const hasExitPlan = calls.some((c) => c?.name === 'exit_plan_mode' || c?.name === 'ExitPlanMode');
        const hasEnterPlan = calls.some((c) => c?.name === 'enter_plan_mode' || c?.name === 'EnterPlanMode');
        if (hasExitPlan) {
            sessionState.isOrchestratorModel = true;
            sessionState.orchestratorExplicitlyDisabled = false;
            if (stepModel) sessionState.plannerModel = stepModel;
            sessionState.orchestratorPhase = 'execute';
        }
        else if (hasEnterPlan) {
            sessionState.isOrchestratorModel = true;
            sessionState.orchestratorExplicitlyDisabled = false;
            if (stepModel) sessionState.executorModel = stepModel;
            sessionState.orchestratorPhase = 'plan';
        }
        if (stepModel) {
            sessionState.lastObservedModel = stepModel;
            if (sessionState.isOrchestratorModel && sessionState.orchestratorPhase === 'execute'
                && sessionState.plannerModel && stepModel !== sessionState.plannerModel && !hasExitPlan && !hasEnterPlan) {
                sessionState.executorModel = stepModel;
            }
            else if (sessionState.isOrchestratorModel && sessionState.plannerModel && sessionState.executorModel
                && stepModel === sessionState.plannerModel && stepModel !== sessionState.executorModel
                && sessionState.orchestratorPhase === 'execute' && !hasExitPlan) {
                sessionState.orchestratorPhase = 'plan';
            }
        }
        return;
    }
    if (stepSrc === 'SYSTEM_SDK') return;
    if (stepType === 'SYSTEM_MESSAGE' || stepSrc === 'SYSTEM') {
        const rawSysText = extractRawTextContent(parsed);
        if (/\[plan review(?:\s+due)?\]/i.test(rawSysText)) {
            sessionState.isOrchestratorModel = true;
            sessionState.orchestratorExplicitlyDisabled = false;
            sessionState.orchestratorPhase = 'plan';
            return;
        }
    }
    const subagentMsg = extractSubagentSystemMessage(parsed, sessionState);
    if (stepType === 'SYSTEM_MESSAGE' || stepSrc === 'SYSTEM') {
        if (!subagentMsg) return;
    } else {
        const role = parsed?.role ?? parsed?.type ?? parsed?.author ?? parsed?.message?.role;
        if (role !== 'user' && role !== 'human' && role !== 'USER_INPUT' && !parsed?.user_input && !parsed?.userPrompt) return;
    }
    const text = subagentMsg || extractRawTextContent(parsed);
    if (!subagentMsg) {
        sessionState.hasDirectUserInput = true;
        extractMetadataContext(text, sessionState);
    }
    const cleaned = subagentMsg || stripUserRequestTags(text);
    if (!cleaned) return;
    const normCleaned = normalizePromptKey(cleaned);
    const normPrev = normalizePromptKey(sessionState.lastUserPrompt);
    const truncPrefix = Array.isArray(parsed?.truncated_fields)
        && parsed.truncated_fields.includes('content')
        && normPrev.length > normCleaned.length
        && normPrev.startsWith(normCleaned);
    if (!truncPrefix) sessionState.lastUserPrompt = cleaned;
    sessionState.lastUserStep = stepIdx;
    extractPathsFromText(cleaned, sessionState);
}

function entryNeedsFullTranscriptHydration(parsed, sessionState = null) {
    if (!parsed || parsed.step_index === undefined || !Array.isArray(parsed.truncated_fields))
        return false;
    if (!parsed.truncated_fields.includes('content'))
        return false;
    const stepType = String(parsed?.type ?? '').toUpperCase();
    const stepSrc = String(parsed?.source ?? '').toUpperCase();
    if (stepSrc === 'SYSTEM_SDK' || stepType === 'CHECKPOINT')
        return false;
    if (stepType === 'SYSTEM_MESSAGE' || stepSrc === 'SYSTEM') {
        if (sessionState?.hasDirectUserInput) return false;
        const raw = extractRawTextContent(parsed);
        if (stepSrc !== 'SYSTEM' || stepType !== 'SYSTEM_MESSAGE' || !raw.includes('[Message]')) return false;
        const hdr = /\[Message\]([^\n]*)/i.exec(raw)?.[1] ?? '';
        const sender = /\bsender=([^\s]+)/i.exec(hdr)?.[1] ?? '';
        if (sender && /\/task-\d+\b|(?:^|\/)(?:schedule|cron|timer)\b/i.test(sender)) return false;
        if (sessionState?.lastUserPrompt && (!sessionState.subagentSenderId || !sender || sender !== sessionState.subagentSenderId)) return false;
        return true;
    }
    const role = parsed?.role ?? parsed?.type ?? parsed?.author ?? parsed?.message?.role;
    return role === 'user' || role === 'human' || role === 'USER_INPUT' || Boolean(parsed?.user_input || parsed?.userPrompt);
}

export function parseAgyTranscript(transcriptPath, sessionState) {
    if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return sessionState;
    try {
        const slice = readTranscriptSlice(transcriptPath, sessionState);
        if (!slice) return sessionState;
        const nextOffset = slice.offset + slice.consumed;
        if (nextOffset !== sessionState.transcriptOffset) {
            Object.defineProperty(sessionState, '_dirtyTranscriptOffset', {
                value: true,
                configurable: true,
                enumerable: false,
                writable: true,
            });
        }
        sessionState.transcriptOffset = nextOffset;
        sessionState.transcriptSize = slice.size;
        const lines = slice.processable.split('\n').filter((l) => l.trim().length > 0);
        const parsedEntries = [];
        const neededKeys = new Set();
        const hydrationState = {
            hasDirectUserInput: Boolean(sessionState?.hasDirectUserInput),
            lastUserPrompt: sessionState?.lastUserPrompt,
            subagentSenderId: sessionState?.subagentSenderId,
        };
        for (let i = 0; i < lines.length; i++) {
            let parsed = null;
            try { parsed = JSON.parse(lines[i]); } catch { continue; }
            if (entryNeedsFullTranscriptHydration(parsed, hydrationState)) {
                neededKeys.add(`${parsed.step_index}:${parsed.type ?? ''}`);
            }
            const stepRole = parsed?.role ?? parsed?.type ?? parsed?.author ?? parsed?.message?.role;
            if (stepRole === 'user' || stepRole === 'human' || stepRole === 'USER_INPUT' || parsed?.user_input || parsed?.userPrompt) {
                hydrationState.hasDirectUserInput = true;
            }
            parsedEntries.push(parsed);
        }
        const fullMap = neededKeys.size > 0 ? hydrateFromFullTranscriptTail(transcriptPath, neededKeys) : null;
        const baseStep = typeof sessionState.transcriptStepSeq === 'number' ? sessionState.transcriptStepSeq : 0;
        for (let i = 0; i < parsedEntries.length; i++) {
            let parsed = parsedEntries[i];
            if (fullMap && parsed?.step_index !== undefined) {
                parsed = fullMap.get(`${parsed.step_index}:${parsed.type ?? ''}`) ?? parsed;
            }
            applyTranscriptEntry(parsed, baseStep + i, sessionState);
        }
        sessionState.transcriptStepSeq = baseStep + parsedEntries.length;
    } catch { /* ignore read errors */ }
    return sessionState;
}
