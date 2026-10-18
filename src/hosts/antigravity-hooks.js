import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { relevantRetrieval } from '../claude/format.js';
import {
    MIN_PROMPT_CHARS,
    recordFileEdit,
    readOrientation,
    queryPromptContext,
    handleStop,
} from '../claude/hooks.js';
import { hasPlexerIndex } from '../graph/root.js';
import { resolveContextDir, readJson, writeJsonAtomic } from '../util/state.js';

export function emptyAgySession() {
    return {
        transcriptOffset: 0,
        transcriptSize: 0,
        lastUserPrompt: null,
        lastUserStep: -1,
        lastInjectedStep: -1,
        lastTouchedPath: null,
        lastEditedFile: null,
        orientedDirs: [],
        pendingBlastRadius: null,
        lastQuery: null,
        perAgentQuery: {},
        injectedPointers: [],
        nudges: 0,
        lastRetrievalText: null,
    };
}

function normalizePromptKey(text) {
    return String(text ?? '')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
        .trim();
}

export function agySessionPath(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(tmpdir(), `plexer-agy-${safeId}.json`);
}

export function readAgySession(sessionId) {
    return { ...emptyAgySession(), ...(readJson(agySessionPath(sessionId)) ?? {}) };
}

export function writeAgySession(sessionId, state) {
    try {
        writeJsonAtomic(agySessionPath(sessionId), state);
    }
    catch { /* best-effort */ }
}

function unquoteArg(val) {
    if (typeof val !== 'string')
        return null;
    const trimmed = val.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function stripUserRequestTags(text) {
    const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
    return (m ? m[1] : text).trim();
}

function isIgnoredTouchedPath(p) {
    if (!p || typeof p !== 'string' || !isAbsolute(p))
        return true;
    const norm = p.replace(/\\/g, '/');
    return /\/\.gemini\/antigravity(?:-cli|-ide)?\/brain\//.test(norm);
}

function extractPathsFromText(raw, sessionState) {
    if (!raw || typeof raw !== 'string')
        return;
    const mentionRe = /@\[([^\]]+)\]/g;
    let m;
    while ((m = mentionRe.exec(raw)) !== null) {
        if (m[1] && !isIgnoredTouchedPath(m[1]))
            sessionState.lastTouchedPath = m[1];
    }
    const absPathRe = /(?:`|["'\s]|^)(\/(?:home|tmp|var|opt|srv|Users|private\/tmp)\/[A-Za-z0-9._/-]+)/g;
    while ((m = absPathRe.exec(raw)) !== null) {
        const candidate = m[1].replace(/[.,;:!?)'"`]+$/, '');
        if (!isIgnoredTouchedPath(candidate) && existsSync(candidate)) {
            sessionState.lastTouchedPath = candidate;
        }
    }
}

function extractPathsFromEntry(obj, sessionState) {
    if (!obj || typeof obj !== 'object')
        return;
    const calls = [];
    if (Array.isArray(obj.tool_calls))
        calls.push(...obj.tool_calls);
    if (Array.isArray(obj.toolCalls))
        calls.push(...obj.toolCalls);
    if (obj.toolCall)
        calls.push(obj.toolCall);
    if (obj.tool_use)
        calls.push(obj.tool_use);
    for (const call of calls) {
        const name = String(call?.name ?? call?.tool ?? call?.function?.name ?? '');
        let args = call?.args ?? call?.arguments ?? call?.input ?? call?.function?.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
        }
        for (const key of ['Path', 'TargetFile', 'AbsolutePath', 'Cwd', 'SearchPath', 'DirectoryPath']) {
            const p = unquoteArg(args?.[key]);
            if (p && !isIgnoredTouchedPath(p)) {
                sessionState.lastTouchedPath = p;
                if ((key === 'Path' || key === 'TargetFile') && /edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file/i.test(name)) {
                    sessionState.lastEditedFile = p;
                }
            }
        }
    }
}

export function parseAgyTranscript(transcriptPath, sessionState) {
    if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath))
        return sessionState;
    try {
        const st = statSync(transcriptPath);
        const size = st.size;
        let offset = sessionState.transcriptOffset ?? 0;
        if (size < offset || offset < 0)
            offset = 0;
        if (size === offset)
            return sessionState;
        const length = size - offset;
        const fd = openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(length);
        let bytesRead = 0;
        try {
            bytesRead = readSync(fd, buf, 0, length, offset);
        }
        finally {
            closeSync(fd);
        }
        const chunk = buf.toString('utf8', 0, bytesRead);
        const lastNewline = chunk.lastIndexOf('\n');
        let processable = '';
        if (lastNewline !== -1) {
            processable = chunk.slice(0, lastNewline + 1);
        }
        else {
            try {
                JSON.parse(chunk.trim());
                processable = chunk;
            }
            catch {
                return sessionState;
            }
        }
        const consumedBytes = Buffer.byteLength(processable, 'utf8');
        sessionState.transcriptOffset = offset + consumedBytes;
        sessionState.transcriptSize = size;

        const lines = processable.split('\n').filter((l) => l.trim().length > 0);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let parsed = null;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            extractPathsFromEntry(parsed, sessionState);
            const role = parsed?.role ?? parsed?.type ?? parsed?.author ?? parsed?.message?.role;
            const stepIndex = parsed?.step_index ?? parsed?.step ?? parsed?.index ?? (offset + i);
            if (role === 'user' || role === 'human' || role === 'USER_INPUT' || parsed?.user_input || parsed?.userPrompt) {
                const rawContent = parsed?.content ?? parsed?.text ?? parsed?.user_input ?? parsed?.userPrompt ?? parsed?.message?.content ?? '';
                const text = Array.isArray(rawContent)
                    ? rawContent.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n')
                    : typeof rawContent === 'string'
                        ? rawContent
                        : '';
                const cleaned = stripUserRequestTags(text);
                if (cleaned) {
                    sessionState.lastUserPrompt = cleaned;
                    sessionState.lastUserStep = stepIndex;
                    extractPathsFromText(cleaned, sessionState);
                }
            }
        }
    }
    catch { /* ignore read errors */ }
    return sessionState;
}

function findNearestRepoAncestor(startPath) {
    if (!startPath || typeof startPath !== 'string')
        return null;
    let cur = resolve(startPath);
    try {
        if (!statSync(cur).isDirectory())
            cur = dirname(cur);
    }
    catch {
        cur = dirname(cur);
    }
    for (let i = 0; i < 25; i++) {
        if (
            hasPlexerIndex(cur) ||
            existsSync(join(cur, 'plexer')) ||
            existsSync(join(cur, 'sert.toml')) ||
            existsSync(join(cur, 'default.project.json')) ||
            existsSync(join(cur, '.git'))
        ) {
            return cur;
        }
        const parent = dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    return null;
}

export function resolveAgyRepoDir(input, sessionState) {
    const candidates = [
        sessionState?.lastTouchedPath,
        input?.cwd,
        input?.workspacePaths?.[0],
        process.cwd(),
    ].filter(Boolean);
    for (const c of candidates) {
        const found = findNearestRepoAncestor(c);
        if (found)
            return found;
    }
    return resolve(candidates[0] || process.cwd());
}

function agySessionId(input) {
    return (
        input?.sessionId ||
        input?.session_id ||
        input?.conversationId ||
        input?.trajectoryId ||
        (input?.transcriptPath ? basename(String(input.transcriptPath), '.jsonl') : null) ||
        'default'
    );
}

function loadAgyContext(input) {
    const sid = agySessionId(input);
    const agyState = readAgySession(sid);
    let transcriptPath = input?.transcriptPath || input?.transcript_path;
    if ((!transcriptPath || !existsSync(transcriptPath)) && input?.conversationId) {
        const home = homedir();
        const candidates = [
            join(home, '.gemini', 'antigravity-cli', 'brain', input.conversationId, '.system_generated', 'logs', 'transcript_full.jsonl'),
            join(home, '.gemini', 'antigravity-cli', 'brain', input.conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
            join(home, '.gemini', 'antigravity', 'brain', input.conversationId, '.system_generated', 'logs', 'transcript_full.jsonl'),
            join(home, '.gemini', 'antigravity', 'brain', input.conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
        ];
        transcriptPath = candidates.find((p) => existsSync(p)) ?? transcriptPath;
    }
    if (transcriptPath)
        parseAgyTranscript(transcriptPath, agyState);
    return { sid, agyState };
}

function isIsolatedBenchDir(dir) {
    const norm = String(dir ?? '').replace(/\\/g, '/');
    if (norm.includes('/plexer-agy-lifecycle-'))
        return false;
    if (process.env.PLEXER_DISABLE_HOOKS === '1')
        return true;
    if (process.env.PLEXER_ENABLE_BENCH_HOOKS === '1')
        return false;
    return norm.includes('/plexer-ab-') || norm.includes('/plexer-bench-') || norm.includes('/plexer-swebench-');
}

export function handleAgyPreInvocation(input) {
    const { sid, agyState } = loadAgyContext(input);
    if (typeof input?.prompt === 'string' && input.prompt.trim()) {
        const cleaned = normalizePromptKey(stripUserRequestTags(input.prompt));
        if (cleaned && cleaned !== normalizePromptKey(agyState.lastUserPrompt)) {
            agyState.lastUserPrompt = cleaned;
            agyState.lastUserStep = (agyState.lastUserStep ?? -1) + 1;
        }
        extractPathsFromText(cleaned, agyState);
    }
    const dir = resolveAgyRepoDir(input, agyState);
    if (isIsolatedBenchDir(dir)) {
        writeAgySession(sid, agyState);
        process.stdout.write('{}\n');
        return;
    }
    const messages = [];
    const ctxDir = resolveContextDir(dir);
    if (existsSync(ctxDir)) {
        if (agyState.pendingBlastRadius) {
            messages.push(agyState.pendingBlastRadius);
            agyState.pendingBlastRadius = null;
            agyState.lastRetrievalText = null;
        }
        let injectedPromptContext = false;
        const prompt = normalizePromptKey(agyState.lastUserPrompt);
        const isNewPrompt = prompt.length >= MIN_PROMPT_CHARS &&
            prompt !== normalizePromptKey(agyState.lastQuery);
        if (isNewPrompt) {
            agyState.lastInjectedStep = agyState.lastUserStep;
            agyState.lastQuery = prompt;
            const ask = queryPromptContext(dir, prompt);
            if (ask) {
                const txt = relevantRetrieval(ask, agyState);
                if (txt) {
                    messages.push(txt);
                    injectedPromptContext = !txt.startsWith('[plexer] no strong match');
                    if (injectedPromptContext)
                        agyState.lastRetrievalText = txt;
                }
            }
        }
        else if (!agyState.pendingBlastRadius && agyState.lastRetrievalText) {
            messages.push(agyState.lastRetrievalText);
            agyState.lastRetrievalText = null;
            injectedPromptContext = true;
        }
        if (!Array.isArray(agyState.orientedDirs))
            agyState.orientedDirs = [];
        if (!agyState.orientedDirs.includes(dir)) {
            const orientation = readOrientation(dir, injectedPromptContext ? 0 : 1200);
            if (orientation) {
                messages.unshift(orientation);
                agyState.orientedDirs.push(dir);
            }
        }
    }
    writeAgySession(sid, agyState);
    if (messages.length > 0) {
        process.stdout.write(`${JSON.stringify({ injectSteps: [{ ephemeralMessage: messages.join('\n\n') }] })}\n`);
    }
    else {
        process.stdout.write('{}\n');
    }
}

export function handleAgyPostEdit(input) {
    const { sid, agyState } = loadAgyContext(input);
    const explicitTarget =
        unquoteArg(input?.toolCall?.args?.Path) ??
        unquoteArg(input?.toolCall?.args?.TargetFile) ??
        unquoteArg(input?.tool_input?.Path) ??
        unquoteArg(input?.tool_input?.TargetFile) ??
        unquoteArg(input?.tool_input?.file_path);
    const rawTarget = explicitTarget ?? agyState.lastEditedFile;
    agyState.lastEditedFile = null;
    if (rawTarget && !isIgnoredTouchedPath(rawTarget)) {
        agyState.lastTouchedPath = rawTarget;
        const repoRoot = findNearestRepoAncestor(rawTarget) ?? resolveAgyRepoDir(input, agyState);
        if (!isIsolatedBenchDir(repoRoot)) {
            const editedFile = isAbsolute(rawTarget) ? rawTarget : join(repoRoot, rawTarget);
            if (existsSync(resolveContextDir(repoRoot))) {
                const br = recordFileEdit(repoRoot, editedFile);
                if (br) {
                    if (agyState.pendingBlastRadius && !agyState.pendingBlastRadius.includes(br)) {
                        agyState.pendingBlastRadius = `${agyState.pendingBlastRadius}\n${br}`;
                    }
                    else if (!agyState.pendingBlastRadius) {
                        agyState.pendingBlastRadius = br;
                    }
                }
            }
        }
    }
    writeAgySession(sid, agyState);
    process.stdout.write('{}\n');
}

export function handleAgyStop(input) {
    const { sid, agyState } = loadAgyContext(input);
    const dir = resolveAgyRepoDir(input, agyState);
    if (!isIsolatedBenchDir(dir))
        handleStop(input, dir);
    writeAgySession(sid, agyState);
    process.stdout.write(`${JSON.stringify({ decision: 'allow' })}\n`);
}

