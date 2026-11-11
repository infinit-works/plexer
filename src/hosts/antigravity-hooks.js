import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { relevantRetrieval } from '../claude/format.js';
import {
    MIN_PROMPT_CHARS,
    LEADING_SLASH_COMMANDS_RE,
    READ_ONLY_SLASH_RE,
    isSyntheticOrMetaPrompt,
    recordFileEdit,
    readOrientation,
    queryPromptContext,
    handleStop,
} from '../claude/hooks.js';
import { ensureFreshGraph } from '../graph/refresh.js';
import { hasAncestorRepoOrIndex, hasPlexerIndex, isAutoBuildableRepo, isBoundaryDir } from '../graph/root.js';
import { contextDirFor } from '../util/paths.js';
import { agyTempDir, agyLastRepoPath, readAgyLastRepo, writeAgyLastRepo, readJson, readStdin, writeJsonAtomic } from '../util/state.js';
export { agyTempDir, agyLastRepoPath, readAgyLastRepo, writeAgyLastRepo };

const STALE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
        emittedBlastFiles: [],
        nudges: 0,
        lastRetrievalText: null,
    };
}

function normalizePromptKey(text) {
    return String(text ?? '')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/gi, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?(?:<\/USER_SETTINGS_CHANGE>|$)/gi, '')
        .trim()
        .replace(LEADING_SLASH_COMMANDS_RE, '')
        .trim();
}

function pruneStaleAgySessions() {
    try {
        const dir = agyTempDir();
        const now = Date.now();
        for (const name of readdirSync(dir)) {
            if (!name.startsWith('plexer-agy-') || !name.endsWith('.json') || name === 'plexer-agy-last-repo.json')
                continue;
            const full = join(dir, name);
            try {
                const st = statSync(full);
                if (now - st.mtimeMs > STALE_SESSION_TTL_MS)
                    unlinkSync(full);
            }
            catch { /* ignore */ }
        }
    }
    catch { /* ignore */ }
}

export function agySessionPath(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(agyTempDir(), `plexer-agy-${safeId}.json`);
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
    const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|$)/i.exec(text);
    return (m ? m[1] : text).trim();
}

let cachedSkillRoots = null;
function skillTargetRoots() {
    if (cachedSkillRoots)
        return cachedSkillRoots;
    const roots = new Set();
    const home = homedir();
    const homeNorm = home.replace(/\\/g, '/');
    for (const base of [join(home, '.gemini', 'skills'), join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
        try {
            const realBase = realpathSync(base).replace(/\\/g, '/');
            if (realBase && realBase !== '/' && realBase !== homeNorm)
                roots.add(realBase);
        }
        catch { /* ignore */ }
        try {
            for (const name of readdirSync(base)) {
                try {
                    const realTarget = realpathSync(join(base, name)).replace(/\\/g, '/');
                    if (realTarget && realTarget !== '/' && realTarget !== homeNorm) {
                        roots.add(realTarget);
                        const parent = dirname(realTarget).replace(/\\/g, '/');
                        if (parent && parent !== '/' && parent !== homeNorm)
                            roots.add(parent);
                    }
                }
                catch { /* ignore */ }
            }
        }
        catch { /* ignore */ }
    }
    cachedSkillRoots = [...roots];
    return cachedSkillRoots;
}

function isIgnoredTouchedPath(p, workspaceRoot = null) {
    if (!p || typeof p !== 'string' || !isAbsolute(p))
        return true;
    const norm = p.replace(/\\/g, '/');
    if (/\/(?:\.gemini|\.agents|\.claude|\.codex)(?:\/|$)/.test(norm))
        return true;
    const wsNorm = typeof workspaceRoot === 'string' ? workspaceRoot.replace(/\\/g, '/') : '';
    for (const root of skillTargetRoots()) {
        if (norm === root || norm.startsWith(`${root}/`)) {
            if (!wsNorm || !(wsNorm === root || wsNorm.startsWith(`${root}/`)))
                return true;
        }
    }
    return false;
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
                if ((key === 'Path' || key === 'TargetFile') && /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file)$/i.test(name)) {
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
        const rawSlice = buf.subarray(0, bytesRead);
        const lastNlByte = rawSlice.lastIndexOf(0x0a);
        let processable = '';
        let consumedBytes = 0;
        if (lastNlByte !== -1) {
            consumedBytes = lastNlByte + 1;
            processable = rawSlice.subarray(0, consumedBytes).toString('utf8');
        }
        else {
            const chunk = rawSlice.toString('utf8');
            try {
                JSON.parse(chunk.trim());
                processable = chunk;
                consumedBytes = bytesRead;
            }
            catch {
                return sessionState;
            }
        }
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
                    const normCleaned = normalizePromptKey(cleaned);
                    const normPrev = normalizePromptKey(sessionState.lastUserPrompt);
                    const isTruncatedPrefix = Array.isArray(parsed?.truncated_fields) &&
                        parsed.truncated_fields.includes('content') &&
                        normPrev.length > normCleaned.length &&
                        normPrev.startsWith(normCleaned);
                    if (!isTruncatedPrefix) {
                        sessionState.lastUserPrompt = cleaned;
                    }
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
    let startDir = resolve(startPath);
    try {
        if (!statSync(startDir).isDirectory())
            startDir = dirname(startDir);
    }
    catch {
        startDir = dirname(startDir);
    }
    let cur = startDir;
    for (let i = 0; i < 25; i++) {
        if (isBoundaryDir(cur))
            break;
        const indexed = hasPlexerIndex(cur) || existsSync(join(cur, 'plexer', 'INDEX.md'));
        if (indexed && (existsSync(join(cur, '.git')) || !hasAncestorRepoOrIndex(cur))) {
            return cur;
        }
        const parent = dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    cur = startDir;
    for (let i = 0; i < 25; i++) {
        if (isBoundaryDir(cur))
            break;
        if (isAutoBuildableRepo(cur)) {
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
    const wsRoot = input?.workspacePaths?.[0] || null;
    const rawTouched = sessionState?.lastTouchedPath;
    const touched = rawTouched && !isIgnoredTouchedPath(rawTouched, wsRoot) ? rawTouched : null;
    const candidates = [
        touched,
        input?.cwd,
        wsRoot,
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
    const isFreshSession = agyState.lastUserStep === -1 && agyState.transcriptOffset === 0;
    if (isFreshSession)
        pruneStaleAgySessions();
    let transcriptPath = input?.transcriptPath || input?.transcript_path;
    if (typeof transcriptPath === 'string' && transcriptPath.endsWith('/transcript.jsonl')) {
        const fullSibling = join(dirname(transcriptPath), 'transcript_full.jsonl');
        if (existsSync(fullSibling))
            transcriptPath = fullSibling;
    }
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
    return norm.includes('/plexer-ab-') || norm.includes('/plexer-bench-') || norm.includes('/plexer-swebench-') || norm.includes('/plexer-large-');
}

function writeStdoutFull(payload) {
    const buf = Buffer.from(payload, 'utf8');
    let off = 0;
    while (off < buf.length) {
        try {
            off += writeSync(1, buf, off, buf.length - off);
        }
        catch (err) {
            if (err?.code === 'EAGAIN')
                continue;
            break;
        }
    }
}

function dropLastHelperBlock(text) {
    const re = /\n\n\/\/ (?:same-file helper|cross-file callee|delegator in|caller in|constructor in|module constant)[^\n]*\n[\s\S]*?(?=\n\n\/\/ |\n```)/g;
    let lastMatch = null;
    let m;
    while ((m = re.exec(text)) !== null)
        lastMatch = m;
    if (!lastMatch)
        return null;
    return text.slice(0, lastMatch.index) + text.slice(lastMatch.index + lastMatch[0].length);
}

function dropLastSecondaryHitCodeOrBlock(text) {
    const codeRe = /(\n [2-9]\d*\. [^\n]+(?:\n    [^\n]+)*)\n```\n[\s\S]*?\n```(?=\n \d+\. |\s*$)/g;
    let lastCode = null;
    let m;
    while ((m = codeRe.exec(text)) !== null)
        lastCode = m;
    if (lastCode)
        return text.slice(0, lastCode.index) + lastCode[1] + text.slice(lastCode.index + lastCode[0].length);
    const blockRe = /\n [2-9]\d*\. [\s\S]*$/;
    const bm = blockRe.exec(text);
    if (!bm)
        return null;
    const subHits = [...bm[0].matchAll(/\n [2-9]\d*\. /g)];
    if (!subHits.length)
        return null;
    const cutOffset = bm.index + (subHits[subHits.length - 1].index ?? 0);
    return text.slice(0, cutOffset);
}

function fitAgyEphemeral(text, maxChars = 7200) {
    if (text.length <= maxChars)
        return text;
    let out = text.replace(/\nL\d+:\s*\/\*\*[\s\S]*?\nL\d+:\s*\*\/(?=\n```)/g, '');
    if (out.length > maxChars) {
        out = out.replace(/(\n [2-9]\. [^\n]+(?:\n    [^\n]+)*\n```\n)([\s\S]*?)(\n\n\/\/ (?:same-file helper|cross-file callee):)/g, (_m, head, body, helperHdr) => {
            const lines = body.split('\n');
            if (lines.length <= 10)
                return _m;
            return `${head}${[...lines.slice(0, 3), '  …', ...lines.slice(-5)].join('\n')}${helperHdr}`;
        });
    }
    if (out.length > maxChars) {
        out = out.replace(/(\nL\d+:\s*\/\/[^\n]*)+/g, '');
    }
    while (out.length > maxChars) {
        const trimmed = dropLastHelperBlock(out);
        if (!trimmed || trimmed.length === out.length)
            break;
        out = trimmed;
    }
    while (out.length > maxChars) {
        const trimmed = dropLastSecondaryHitCodeOrBlock(out);
        if (!trimmed || trimmed.length === out.length)
            break;
        out = trimmed;
    }
    if (out.length <= maxChars)
        return out;
    let sliced = out.slice(0, maxChars);
    const lastHelper = sliced.lastIndexOf('\n\n// ');
    const lastNl = sliced.lastIndexOf('\n');
    if (lastHelper > maxChars * 0.55)
        sliced = sliced.slice(0, lastHelper);
    else if (lastNl > maxChars * 0.7)
        sliced = sliced.slice(0, lastNl);
    const fenceCount = (sliced.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 1)
        sliced += '\n```';
    return sliced;
}

export async function handleAgyPreInvocation(input) {
    const { sid, agyState } = loadAgyContext(input);
    const directPrompt = typeof input?.prompt === 'string' && input.prompt.trim()
        ? input.prompt
        : (typeof input?.lastUserInput === 'string' && input.lastUserInput.trim() ? input.lastUserInput : null);
    if (directPrompt) {
        const cleaned = normalizePromptKey(stripUserRequestTags(directPrompt));
        if (cleaned && cleaned !== normalizePromptKey(agyState.lastUserPrompt)) {
            agyState.lastUserPrompt = cleaned;
            agyState.lastUserStep = (agyState.lastUserStep ?? -1) + 1;
        }
        extractPathsFromText(cleaned, agyState);
    }
    const dir = resolveAgyRepoDir(input, agyState);
    if (isIsolatedBenchDir(dir)) {
        writeAgySession(sid, agyState);
        writeStdoutFull('{}\n');
        return;
    }
    const messages = [];
    const ctxDir = contextDirFor(dir);
    if (!existsSync(ctxDir) && isAutoBuildableRepo(dir)) {
        try {
            await ensureFreshGraph(dir);
        }
        catch { /* best-effort auto-build */ }
    }
    let injectedPromptContext = false;
    if (existsSync(ctxDir)) {
        writeAgyLastRepo(dir);
        if (agyState.pendingBlastRadius) {
            messages.push(agyState.pendingBlastRadius);
            agyState.pendingBlastRadius = null;
            agyState.lastRetrievalText = null;
        }
        const rawPrompt = String(agyState.lastUserPrompt ?? '').trim();
        const prompt = normalizePromptKey(rawPrompt);
        const isNewStep = typeof agyState.lastUserStep === 'number' &&
            agyState.lastUserStep >= 0 &&
            agyState.lastUserStep !== agyState.lastInjectedStep;
        const isNewPrompt = !isSyntheticOrMetaPrompt(rawPrompt) &&
            prompt.length >= MIN_PROMPT_CHARS &&
            (isNewStep || (agyState.lastInjectedStep === -1 && prompt !== normalizePromptKey(agyState.lastQuery)));
        if (isNewPrompt) {
            const isFollowUp = (agyState.injectedPointers?.length ?? 0) > 0;
            agyState.lastInjectedStep = agyState.lastUserStep;
            agyState.lastQuery = prompt;
            const ask = queryPromptContext(dir, prompt, { forceReadOnly: READ_ONLY_SLASH_RE.test(rawPrompt) });
            if (ask) {
                const txt = relevantRetrieval(ask, agyState, 4, { followUp: isFollowUp });
                if (txt) {
                    messages.push(txt);
                    injectedPromptContext = !txt.startsWith('[plexer] no strong match');
                }
            }
        }
        if (!Array.isArray(agyState.orientedDirs))
            agyState.orientedDirs = [];
        if (!agyState.orientedDirs.includes(dir)) {
            if (injectedPromptContext) {
                agyState.orientedDirs.push(dir);
            }
            else {
                const orientation = readOrientation(dir, 1200);
                if (orientation) {
                    messages.unshift(orientation);
                    agyState.orientedDirs.push(dir);
                }
            }
        }
    }
    writeAgySession(sid, agyState);
    const ephMsg = fitAgyEphemeral(messages.join('\n\n'), 7200);
    const stepObj = { systemMessage: { systemMessage: ephMsg } };
    const payload = messages.length > 0
        ? `${JSON.stringify({ injectSteps: [stepObj] })}\n`
        : '{}\n';
    writeStdoutFull(payload);
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
            if (existsSync(contextDirFor(repoRoot))) {
                const br = recordFileEdit(repoRoot, editedFile);
                const relEdited = relative(resolve(repoRoot), resolve(editedFile)).replace(/\\/g, '/');
                if (!Array.isArray(agyState.emittedBlastFiles))
                    agyState.emittedBlastFiles = [];
                const alreadyInTurn0 =
                    Boolean(relEdited) &&
                    (agyState.injectedPointers ?? []).length >= 3 &&
                    (agyState.injectedPointers ?? []).some((p) => {
                        const pFile = String(p).split(':')[0].replace(/\\/g, '/');
                        return pFile === relEdited || relEdited.endsWith(`/${pFile}`);
                    });
                if (br && relEdited && !agyState.emittedBlastFiles.includes(relEdited) && !alreadyInTurn0) {
                    agyState.emittedBlastFiles.push(relEdited);
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
    writeStdoutFull('{}\n');
}

export function handleAgyStop(input) {
    const { sid, agyState } = loadAgyContext(input);
    const dir = resolveAgyRepoDir(input, agyState);
    if (!isIsolatedBenchDir(dir))
        handleStop(input, dir);
    writeAgySession(sid, agyState);
    process.stdout.write(`${JSON.stringify({ decision: 'allow' })}\n`);
}

export async function dispatchAgyEvent(event, input = readStdin()) {
    if (event === 'agy-pre-invocation')
        await handleAgyPreInvocation(input);
    else if (event === 'agy-post-edit')
        handleAgyPostEdit(input);
    else
        handleAgyStop(input);
}

