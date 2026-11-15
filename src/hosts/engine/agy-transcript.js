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
            }
        }
    }
}

export function stripUserRequestTags(text) {
    const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|$)/i.exec(text);
    return (m ? m[1] : text).trim();
}

function loadFullTranscriptMap(transcriptPath) {
    if (basename(transcriptPath) !== 'transcript.jsonl') return null;
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl');
    if (!existsSync(fullPath)) return null;
    try {
        const byKey = new Map();
        for (const raw of readFileSync(fullPath, 'utf8').split('\n')) {
            if (!raw.trim()) continue;
            try { const o = JSON.parse(raw); if (o?.step_index !== undefined) byKey.set(`${o.step_index}:${o.type ?? ''}`, o); } catch {}
        }
        return byKey;
    } catch { return null; }
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

function applyTranscriptEntry(parsed, stepFallback, sessionState) {
    extractPathsFromEntry(parsed, sessionState);
    const stepType = String(parsed?.type ?? '').toUpperCase();
    const stepSrc = String(parsed?.source ?? '').toUpperCase();
    if (stepType === 'SYSTEM_MESSAGE' || stepSrc === 'SYSTEM' || stepSrc === 'SYSTEM_SDK') return;
    const role = parsed?.role ?? parsed?.type ?? parsed?.author ?? parsed?.message?.role;
    if (role !== 'user' && role !== 'human' && role !== 'USER_INPUT' && !parsed?.user_input && !parsed?.userPrompt) return;
    const raw = parsed?.content ?? parsed?.text ?? parsed?.user_input ?? parsed?.userPrompt ?? parsed?.message?.content ?? '';
    const text = Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : (typeof raw === 'string' ? raw : '');
    const cleaned = stripUserRequestTags(text);
    if (!cleaned) return;
    const normCleaned = normalizePromptKey(cleaned);
    const normPrev = normalizePromptKey(sessionState.lastUserPrompt);
    const truncPrefix = Array.isArray(parsed?.truncated_fields)
        && parsed.truncated_fields.includes('content')
        && normPrev.length > normCleaned.length
        && normPrev.startsWith(normCleaned);
    if (!truncPrefix) sessionState.lastUserPrompt = cleaned;
    sessionState.lastUserStep = parsed?.step_index ?? parsed?.step ?? parsed?.index ?? stepFallback;
    extractPathsFromText(cleaned, sessionState);
}

export function parseAgyTranscript(transcriptPath, sessionState) {
    if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) return sessionState;
    try {
        const slice = readTranscriptSlice(transcriptPath, sessionState);
        if (!slice) return sessionState;
        sessionState.transcriptOffset = slice.offset + slice.consumed;
        sessionState.transcriptSize = slice.size;
        const lines = slice.processable.split('\n').filter((l) => l.trim().length > 0);
        let fullMap;
        for (let i = 0; i < lines.length; i++) {
            let parsed = null;
            try { parsed = JSON.parse(lines[i]); } catch { continue; }
            if (Array.isArray(parsed?.truncated_fields) && parsed.truncated_fields.includes('content') && parsed?.step_index !== undefined) {
                parsed = (fullMap ??= loadFullTranscriptMap(transcriptPath))?.get(`${parsed.step_index}:${parsed.type ?? ''}`) ?? parsed;
            }
            applyTranscriptEntry(parsed, slice.offset + i, sessionState);
        }
    } catch { /* ignore read errors */ }
    return sessionState;
}
