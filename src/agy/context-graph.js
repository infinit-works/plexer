import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { incomingEdges } from '../claude/format.js';
import { loadGraphCached } from '../context/graph-store.js';
import { normalizeRelFile, parsePointerSpan } from './spans.js';
import { tryRealpath } from '../util/fs.js';
import { readJson } from '../util/state.js';
import { agyLastRepoPath, agySessionPath, agyTempDir, readAgySession } from './session.js';
import { contextDirFor } from '../util/paths.js';

const IGNORED_ROLES = new Set(['narrator', 'monitor']);
const WRITE_TOOLS = new Set([
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'write_file',
    'edit_file',
    'delete_file',
    'edit',
    'write',
    'multiedit',
]);
const READ_TOOLS = new Set(['view_file', 'read_file', 'read']);

function statMtimeMs(p) {
    try {
        return Math.round(statSync(p).mtimeMs);
    } catch {
        return 0;
    }
}

/**
 * Locate Antigravity appData directories (`brain/`, `.system_generated/swarm`).
 * Mirrors `swarm_board` resolution and falls back to `~/.gemini/antigravity`.
 */
export function findAppDataDirs(opts = {}) {
    if (Array.isArray(opts.appDataDirs)) {
        return [...new Set(opts.appDataDirs.filter(Boolean).map((p) => resolve(p)))];
    }
    const candidates = [];
    const execDir = opts.executableDataDir ?? process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    if (execDir) {
        let cur = resolve(execDir);
        for (let i = 0; i < 6; i++) {
            if (basename(cur) === 'sidecar_data') {
                candidates.push(dirname(cur));
                break;
            }
            const parent = dirname(cur);
            if (parent === cur)
                break;
            cur = parent;
        }
    }
    const homeAppData = join(homedir(), '.gemini', 'antigravity');
    if (existsSync(homeAppData))
        candidates.push(homeAppData);

    const out = [];
    const seen = new Set();
    for (const dir of candidates) {
        if (!dir || !existsSync(dir))
            continue;
        const norm = tryRealpath(dir);
        if (seen.has(norm))
            continue;
        seen.add(norm);
        out.push(dir);
    }
    return out;
}

function extractToolTarget(call) {
    const args = call?.args ?? call?.arguments ?? call?.input ?? {};
    if (!args || typeof args !== 'object')
        return null;
    for (const key of ['TargetFile', 'AbsolutePath', 'Path', 'path', 'file_path', 'target_file', 'filePath']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim())
            return val.trim();
    }
    return null;
}

function matchLongestIndexedSuffix(rawAbsPath, indexedRelSet) {
    if (!indexedRelSet || indexedRelSet.size === 0)
        return null;
    const normAbs = rawAbsPath.replace(/\\/g, '/');
    let best = null;
    for (const candidate of indexedRelSet) {
        if (normAbs.endsWith(`/${candidate}`) && (!best || candidate.length > best.length))
            best = candidate;
    }
    return best;
}

function toRepoRelPath(rawTarget, repoRoot, realRepoRoot, altRoot = null, indexedRelSet = null) {
    if (!rawTarget || typeof rawTarget !== 'string')
        return null;
    const trimmed = rawTarget.trim();
    if (!trimmed)
        return null;
    if (!isAbsolute(trimmed)) {
        const rel = normalizeRelFile(trimmed);
        return !rel || rel.startsWith('..') ? null : rel;
    }

    const tryRoots = [realRepoRoot, resolve(repoRoot)];
    if (altRoot)
        tryRoots.push(tryRealpath(altRoot), resolve(altRoot));
    const realTarget = existsSync(trimmed) ? tryRealpath(trimmed) : resolve(trimmed);
    for (const root of tryRoots) {
        const rel = normalizeRelFile(relative(root, realTarget));
        if (rel && !rel.startsWith('..') && !isAbsolute(rel))
            return rel;
    }
    return matchLongestIndexedSuffix(trimmed, indexedRelSet);
}

const MAX_TRANSCRIPT_CACHE = 64;
const transcriptTouchCache = new Map();

function extractStepToolTouches(step, touches) {
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
    for (const call of calls) {
        const name = String(call?.name ?? '').trim().toLowerCase();
        if (!name)
            continue;
        const kind = WRITE_TOOLS.has(name) ? 'edited' : READ_TOOLS.has(name) ? 'read' : null;
        const rawTarget = kind ? extractToolTarget(call) : null;
        if (rawTarget)
            touches.push({ kind, rawTarget });
    }
}

function parseTranscriptTouches(transcriptPath) {
    const touches = [];
    try {
        const text = readFileSync(transcriptPath, 'utf8');
        for (const line of text.split('\n')) {
            if (!line.trim())
                continue;
            try {
                extractStepToolTouches(JSON.parse(line), touches);
            } catch {
                continue;
            }
        }
    } catch {
        // Ignore unreadable or partially flushed transcript lines.
    }
    return touches;
}

function readRawTranscriptTouches(transcriptPath) {
    if (!transcriptPath || !existsSync(transcriptPath))
        return null;
    let st;
    try {
        st = statSync(transcriptPath);
    } catch {
        transcriptTouchCache.delete(transcriptPath);
        return null;
    }
    const cached = transcriptTouchCache.get(transcriptPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
        return cached.touches;

    const touches = parseTranscriptTouches(transcriptPath);
    if (transcriptTouchCache.size >= MAX_TRANSCRIPT_CACHE) {
        const oldestKey = transcriptTouchCache.keys().next().value;
        if (oldestKey !== undefined)
            transcriptTouchCache.delete(oldestKey);
    }
    transcriptTouchCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, touches });
    return touches;
}

function readTranscriptTouchSets(transcriptPath, repoRoot, realRepoRoot, altRoot, indexedRelSet) {
    const edited = new Set();
    const read = new Set();
    const touches = readRawTranscriptTouches(transcriptPath);
    if (!touches)
        return { edited, read };
    for (const { kind, rawTarget } of touches) {
        const rel = toRepoRelPath(rawTarget, repoRoot, realRepoRoot, altRoot, indexedRelSet);
        if (!rel)
            continue;
        if (kind === 'edited')
            edited.add(rel);
        else
            read.add(rel);
    }
    return { edited, read };
}

const brainSwarmIndexCache = new Map();

function indexRosterFileMembers(entry, coordinatorId, membersPath) {
    const prevMtime = entry.rosterFiles.get(membersPath);
    const curMtime = statMtimeMs(membersPath);
    if (curMtime === 0 || (prevMtime !== undefined && prevMtime === curMtime))
        return;
    entry.rosterFiles.set(membersPath, curMtime);
    for (const [k, v] of entry.memberToCoord) {
        if (v.coordinatorId === coordinatorId)
            entry.memberToCoord.delete(k);
    }
    const roster = readJson(membersPath);
    const members = roster?.members && typeof roster.members === 'object' ? Object.values(roster.members) : [];
    for (const m of members) {
        if (m?.conversation_id)
            entry.memberToCoord.set(m.conversation_id, { coordinatorId, membersPath });
    }
}

function scanAppDataRosterForWorker(appData, conversationId) {
    const brainDir = join(appData, 'brain');
    if (!existsSync(brainDir))
        return null;
    const dirMtime = statMtimeMs(brainDir);
    let entry = brainSwarmIndexCache.get(brainDir);
    if (!entry) {
        entry = { dirMtime: -1, seenIds: new Set(), rosterFiles: new Map(), memberToCoord: new Map() };
        brainSwarmIndexCache.set(brainDir, entry);
    }
    if (entry.dirMtime !== dirMtime) {
        entry.dirMtime = dirMtime;
        let ids = [];
        try {
            ids = readdirSync(brainDir);
        } catch {
            return null;
        }
        for (const id of ids) {
            const membersPath = join(brainDir, id, '.system_generated', 'swarm', 'members.json');
            if (existsSync(membersPath))
                indexRosterFileMembers(entry, id, membersPath);
        }
    }
    for (const membersPath of entry.rosterFiles.keys()) {
        const coordinatorId = basename(dirname(dirname(dirname(membersPath))));
        indexRosterFileMembers(entry, coordinatorId, membersPath);
    }
    const hit = entry.memberToCoord.get(conversationId);
    if (!hit)
        return null;
    const roster = readJson(hit.membersPath);
    return roster && typeof roster === 'object'
        ? { appData, coordinatorId: hit.coordinatorId, membersPath: hit.membersPath, roster }
        : null;
}

export function locateSwarmRoster(conversationId, appDataDirs) {
    if (!conversationId)
        return null;
    for (const appData of appDataDirs) {
        const directMembers = join(appData, 'brain', conversationId, '.system_generated', 'swarm', 'members.json');
        if (!existsSync(directMembers))
            continue;
        const roster = readJson(directMembers);
        if (roster && typeof roster === 'object')
            return { appData, coordinatorId: conversationId, membersPath: directMembers, roster };
    }
    for (const appData of appDataDirs) {
        const found = scanAppDataRosterForWorker(appData, conversationId);
        if (found)
            return found;
    }
    return null;
}

function buildIndexedRelSet(graph) {
    const out = new Set();
    for (const n of graph?.nodes ?? []) {
        if (n?.kind === 'file' && n.path) {
            const rel = normalizeRelFile(n.path);
            if (rel && !rel.startsWith('..'))
                out.add(rel);
        }
    }
    return out;
}

function buildWorkerSwarmEntry(name, member, found, repoRoot, realRepoRoot, indexedRelSet) {
    const lowerName = String(name).toLowerCase();
    const lowerRole = String(member?.role ?? '').toLowerCase();
    if (IGNORED_ROLES.has(lowerName) || IGNORED_ROLES.has(lowerRole) || !member || member.state === 'killed')
        return null;
    const workerConvId = member.conversation_id || null;
    const transcriptPath = workerConvId
        ? join(found.appData, 'brain', workerConvId, '.system_generated', 'logs', 'transcript.jsonl')
        : null;
    const altRoot = member.workspace_path || member.cwd || null;
    const { edited, read } = readTranscriptTouchSets(
        transcriptPath,
        repoRoot,
        realRepoRoot,
        altRoot,
        indexedRelSet,
    );
    const workerAgy = workerConvId ? readAgySession(workerConvId) : null;
    for (const rel of workerAgy?.emittedBlastFiles ?? []) {
        const norm = normalizeRelFile(rel);
        if (norm && !norm.startsWith('..'))
            edited.add(norm);
    }
    return {
        name,
        role: member.role || name,
        conversationId: workerConvId,
        model: member.model || null,
        state: member.state || 'unknown',
        workspace: member.workspace || 'inherit',
        transcriptPath,
        editedFiles: [...edited].sort(),
        readFiles: [...read].sort(),
    };
}

/**
 * Discover active `/swarm` workers for `conversationId`, excluding `narrator`/`monitor`,
 * along with the edited and read repo-relative paths extracted from each worker's transcript.
 */
export function discoverConversationSwarm(conversationId, repoRoot, opts = {}) {
    const appDataDirs = findAppDataDirs(opts);
    const found = locateSwarmRoster(conversationId, appDataDirs);
    if (!found) {
        return { coordinatorId: conversationId || null, title: null, membersPath: null, workers: [] };
    }
    const realRepoRoot = tryRealpath(repoRoot);
    const ctxDir = contextDirFor(repoRoot);
    const graph = opts.graph ?? (existsSync(ctxDir) ? loadGraphCached(ctxDir) : null);
    const indexedRelSet = buildIndexedRelSet(graph);
    const membersObj = found.roster?.members && typeof found.roster.members === 'object' ? found.roster.members : {};
    const workers = [];
    for (const [name, member] of Object.entries(membersObj)) {
        const entry = buildWorkerSwarmEntry(name, member, found, repoRoot, realRepoRoot, indexedRelSet);
        if (entry)
            workers.push(entry);
    }
    return {
        coordinatorId: found.coordinatorId,
        title: found.roster?.title || null,
        membersPath: found.membersPath,
        workers,
    };
}

function findLatestAgySessionForRepo(repoRoot) {
    const dir = agyTempDir();
    if (!existsSync(dir))
        return { sid: null, state: null };
    const realTarget = tryRealpath(repoRoot);
    const targetPrefix = `${basename(realTarget)}/`;
    let bestSid = null;
    let bestMtime = 0;
    let bestState = null;
    let files = [];
    try {
        files = readdirSync(dir);
    } catch {
        return { sid: null, state: null };
    }
    for (const f of files) {
        if (!f.startsWith('plexer-agy-') || !f.endsWith('.json'))
            continue;
        const sid = f.slice(11, -5);
        if (!sid || sid === 'last-repo')
            continue;
        const full = join(dir, f);
        const mtime = statMtimeMs(full);
        if (mtime <= bestMtime)
            continue;
        const state = readJson(full);
        if (!state || typeof state !== 'object')
            continue;
        const touched = state.lastTouchedPath ? tryRealpath(dirname(state.lastTouchedPath)) : '';
        const matchesRepo =
            (Array.isArray(state.orientedDirs) && state.orientedDirs.some((d) => tryRealpath(d) === realTarget)) ||
            (touched && (touched === realTarget || touched.startsWith(`${realTarget}/`))) ||
            (Array.isArray(state.injectedPointers) && state.injectedPointers.some((p) => String(p).startsWith(targetPrefix)));
        if (matchesRepo) {
            bestSid = sid;
            bestMtime = mtime;
            bestState = state;
        }
    }
    return { sid: bestSid, state: bestState };
}

/**
 * Lightweight mtime-only revision token for sidecar polling (`GET /api/rev`).
 */
export function computeSidecarRev({ repoRoot, sid, appDataDirs } = {}) {
    if (!repoRoot)
        return 'empty';
    const ctxDir = contextDirFor(repoRoot);
    const graphMtime =
        statMtimeMs(join(ctxDir, '.graph', 'wiring.json')) +
        statMtimeMs(join(ctxDir, '.health', 'state.json'));
    const effectiveSid = sid || null;
    const sessMtime = effectiveSid
        ? statMtimeMs(agySessionPath(effectiveSid))
        : statMtimeMs(agyLastRepoPath());
    let swarmMtime = 0;
    if (effectiveSid) {
        const found = locateSwarmRoster(effectiveSid, findAppDataDirs({ appDataDirs }));
        if (found) {
            swarmMtime = statMtimeMs(found.membersPath);
            const members = found.roster?.members && typeof found.roster.members === 'object'
                ? Object.values(found.roster.members)
                : [];
            for (const m of members) {
                if (m?.conversation_id) {
                    swarmMtime += statMtimeMs(
                        join(found.appData, 'brain', m.conversation_id, '.system_generated', 'logs', 'transcript.jsonl'),
                    );
                }
            }
        }
    }
    return `${graphMtime}:${sessMtime}:${swarmMtime}`;
}

function addActor(map, key, actor) {
    if (!map.has(key))
        map.set(key, actor);
}

function ensureFileEntry(activityMap, relFile) {
    if (!activityMap.has(relFile)) {
        activityMap.set(relFile, {
            editors: new Map(),
            readers: new Map(),
            retrieved: false,
            retrievedSpans: [],
        });
    }
    return activityMap.get(relFile);
}

function resolveAgyContextSession(resolvedRoot, sid) {
    let activeSid = sid || null;
    let agyState = activeSid ? readAgySession(activeSid) : null;
    if (!agyState) {
        const latest = findLatestAgySessionForRepo(resolvedRoot);
        if (latest.state) {
            activeSid = latest.sid;
            agyState = latest.state;
        }
    }
    return { activeSid, agyState };
}

function stripRepoNamePrefix(raw, repoName) {
    const str = String(raw);
    return str.startsWith(`${repoName}/`) ? str.slice(repoName.length + 1) : str;
}

function recordAgyStateTouches(activity, agyState, coordActor, ctx) {
    if (!agyState)
        return;
    const { resolvedRoot, realRepoRoot, repoName, indexedRelSet } = ctx;
    for (const rawRel of agyState.emittedBlastFiles ?? []) {
        const rel = normalizeRelFile(stripRepoNamePrefix(rawRel, repoName));
        if (rel && !rel.startsWith('..'))
            addActor(ensureFileEntry(activity, rel).editors, 'coordinator', { ...coordActor, action: 'edited' });
    }
    if (agyState.lastEditedFile) {
        const rel = toRepoRelPath(agyState.lastEditedFile, resolvedRoot, realRepoRoot, null, indexedRelSet);
        if (rel)
            addActor(ensureFileEntry(activity, rel).editors, 'coordinator', { ...coordActor, action: 'edited' });
    }
    for (const ptr of agyState.injectedPointers ?? []) {
        const stripped = stripRepoNamePrefix(ptr, repoName);
        const parsed = parsePointerSpan(stripped);
        if (!parsed?.file || parsed.file.startsWith('..'))
            continue;
        const entry = ensureFileEntry(activity, parsed.file);
        entry.retrieved = true;
        entry.retrievedSpans.push(stripped);
    }
    for (const rawKey of Object.keys(agyState.seenSpans ?? {})) {
        const rel = normalizeRelFile(stripRepoNamePrefix(rawKey, repoName));
        if (rel && !rel.startsWith('..'))
            ensureFileEntry(activity, rel).retrieved = true;
    }
}

function recordCoordinatorTranscriptTouches(activity, coordActor, ctx) {
    const { resolvedRoot, realRepoRoot, indexedRelSet, activeSid, appDataDirs } = ctx;
    if (!activeSid)
        return;
    for (const appData of findAppDataDirs({ appDataDirs })) {
        const tx = join(appData, 'brain', activeSid, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tx))
            continue;
        const { edited, read } = readTranscriptTouchSets(tx, resolvedRoot, realRepoRoot, null, indexedRelSet);
        for (const rel of edited)
            addActor(ensureFileEntry(activity, rel).editors, 'coordinator', { ...coordActor, action: 'edited' });
        for (const rel of read)
            addActor(ensureFileEntry(activity, rel).readers, 'coordinator', { ...coordActor, action: 'read' });
        break;
    }
}

function recordSessionTouches(activity, agyState, swarm, ctx) {
    const coordActor = {
        name: 'coordinator',
        role: 'coordinator',
        conversationId: swarm.coordinatorId || ctx.activeSid || null,
        model: null,
        state: 'active',
        isSwarmWorker: false,
    };
    recordAgyStateTouches(activity, agyState, coordActor, ctx);
    recordCoordinatorTranscriptTouches(activity, coordActor, ctx);
    for (const w of swarm.workers) {
        const workerActor = {
            name: w.name, role: w.role, conversationId: w.conversationId,
            model: w.model, state: w.state, workspace: w.workspace, isSwarmWorker: true,
        };
        for (const rel of w.editedFiles)
            addActor(ensureFileEntry(activity, rel).editors, `worker:${w.name}`, { ...workerActor, action: 'edited' });
        for (const rel of w.readFiles)
            addActor(ensureFileEntry(activity, rel).readers, `worker:${w.name}`, { ...workerActor, action: 'read' });
    }
}

function appendEditedAndCollisionNodes(sortedEntries, nodes, nodeByRel) {
    const editedOrCollisionRels = [];
    let collisionCount = 0;
    for (const [relFile, entry] of sortedEntries) {
        if (entry.editors.size === 0)
            continue;
        const isCollision = entry.editors.size >= 2;
        const type = isCollision ? 'collision' : 'changed';
        if (isCollision)
            collisionCount++;
        const editorList = [...entry.editors.values()];
        const readerList = [...entry.readers.values()].filter((r) => !entry.editors.has(r.isSwarmWorker ? `worker:${r.name}` : r.name));
        const workers = [...editorList, ...readerList].filter((a) => a.conversationId);
        const who = editorList.map((e) => (e.isSwarmWorker ? `@${e.name}` : 'coordinator'));
        const summary = isCollision
            ? `Concurrent edit collision: ${who.join(' and ')} both edited ${relFile}.`
            : `Edited in this session${who.length ? ` by ${who.join(', ')}` : ''}.`;
        const node = {
            id: `${type}:${relFile}`, name: relFile, type, relFile, file: relFile, summary,
            sources: entry.retrievedSpans.length > 0 ? entry.retrievedSpans.slice(0, 6) : [relFile], workers,
        };
        nodes.push(node);
        nodeByRel.set(relFile, node);
        editedOrCollisionRels.push(relFile);
    }
    return { editedOrCollisionRels, collisionCount };
}

function recordIncomingCallerEdge(callerRel, src, targetNode, relFile, affectedMap, ctx) {
    const existing = ctx.nodeByRel.get(callerRel);
    const symLabel = src?.name || callerRel;
    if (existing) {
        const key = `${existing.id}->${targetNode.id}`;
        if (!ctx.edgeSeen.has(key)) {
            ctx.edgeSeen.add(key);
            ctx.edges.push({
                source: existing.id,
                target: targetNode.id,
                relation: 'depends_on',
                description: `${symLabel} calls edited code in ${relFile}`,
            });
        }
        return;
    }
    if (!affectedMap.has(callerRel))
        affectedMap.set(callerRel, { callers: [], targets: new Set(), descriptions: new Map() });
    const slot = affectedMap.get(callerRel);
    slot.targets.add(targetNode.id);
    slot.callers.push({ symbol: symLabel, span: src?.span || '' });
    slot.descriptions.set(targetNode.id, `${symLabel} calls edited code in ${relFile}`);
}

function appendAffectedCallerNodes(graph, resolvedRoot, editedOrCollisionRels, activity, ctx) {
    if (!graph || editedOrCollisionRels.length === 0)
        return;
    const { nodes, edges, edgeSeen, nodeByRel } = ctx;
    const byId = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const affectedMap = new Map();
    for (const relFile of editedOrCollisionRels) {
        const targetNode = nodeByRel.get(relFile);
        let callers = [];
        try { callers = incomingEdges(graph, join(resolvedRoot, relFile), resolvedRoot) || []; }
        catch { callers = []; }
        for (const edge of callers.slice(0, 12)) {
            const src = byId.get(edge.source);
            const callerRel = normalizeRelFile(src?.path);
            if (callerRel && callerRel !== relFile)
                recordIncomingCallerEdge(callerRel, src, targetNode, relFile, affectedMap, ctx);
        }
    }
    for (const [callerRel, info] of affectedMap.entries()) {
        const id = `affected:${callerRel}`;
        const act = activity.get(callerRel);
        const node = {
            id, name: callerRel, type: 'affected', relFile: callerRel, file: callerRel,
            summary: `Not edited directly. ${info.callers.length} reference${info.callers.length === 1 ? '' : 's'} reach edited code.`,
            sources: info.callers.slice(0, 6).map((c) => c.span ? `${callerRel}:${c.span}` : callerRel),
            workers: act ? [...act.readers.values()].filter((a) => a.conversationId) : [],
        };
        nodes.push(node);
        nodeByRel.set(callerRel, node);
        for (const targetId of info.targets) {
            const key = `${id}->${targetId}`;
            if (!edgeSeen.has(key)) {
                edgeSeen.add(key);
                edges.push({ source: id, target: targetId, relation: 'depends_on', description: info.descriptions.get(targetId) || 'calls or imports edited file' });
            }
        }
    }
}

function appendRetrievedNodes(sortedEntries, nodes, nodeByRel) {
    let retrievedAdded = 0;
    for (const [relFile, entry] of sortedEntries) {
        if (nodeByRel.has(relFile) || (!entry.retrieved && entry.readers.size === 0))
            continue;
        if (retrievedAdded >= 16)
            break;
        retrievedAdded++;
        const readerList = [...entry.readers.values()];
        const byWho = readerList.filter((a) => a.isSwarmWorker).map((a) => `@${a.name}`);
        const summary = entry.retrieved
            ? `Retrieved in session context${byWho.length ? ` (also read by ${byWho.join(', ')})` : ''}.`
            : `Read by ${byWho.join(', ') || 'session'} without edits.`;
        const node = {
            id: `retrieved:${relFile}`, name: relFile, type: 'retrieved', relFile, file: relFile, summary,
            sources: entry.retrievedSpans.length > 0 ? entry.retrievedSpans.slice(0, 6) : [relFile],
            workers: readerList.filter((a) => a.conversationId),
        };
        nodes.push(node);
        nodeByRel.set(relFile, node);
    }
}

function appendIndexedFileEdges(graph, nodeByRel, edges, edgeSeen) {
    if (!graph?.edges || nodeByRel.size <= 1)
        return;
    const nodeBySymbolId = new Map();
    for (const sym of graph.nodes ?? []) {
        const rel = normalizeRelFile(sym.path);
        if (rel && nodeByRel.has(rel))
            nodeBySymbolId.set(sym.id, nodeByRel.get(rel));
    }
    for (const e of graph.edges) {
        const srcNode = nodeBySymbolId.get(e.source);
        const dstNode = nodeBySymbolId.get(e.target);
        if (!srcNode || !dstNode || srcNode.id === dstNode.id)
            continue;
        const key = `${srcNode.id}->${dstNode.id}`;
        if (edgeSeen.has(key))
            continue;
        edgeSeen.add(key);
        edges.push({
            source: srcNode.id, target: dstNode.id, relation: e.relation || 'references',
            description: `${srcNode.relFile} references ${dstNode.relFile}`,
        });
        if (edges.length >= 160)
            break;
    }
}

/**
 * Build the live Session & `/swarm` Blast Graph for `sidecars/viz` and `/api/context-graph`.
 */
export function buildAgyContextGraph({ repoRoot, sid = null, appDataDirs } = {}) {
    const resolvedRoot = resolve(repoRoot || process.cwd());
    const realRepoRoot = tryRealpath(resolvedRoot);
    const repoName = basename(realRepoRoot) || basename(resolvedRoot);
    const ctxDir = contextDirFor(resolvedRoot);
    const graph = existsSync(ctxDir) ? loadGraphCached(ctxDir) : null;
    const indexedRelSet = buildIndexedRelSet(graph);

    const { activeSid, agyState } = resolveAgyContextSession(resolvedRoot, sid);
    const swarm = activeSid
        ? discoverConversationSwarm(activeSid, resolvedRoot, { appDataDirs, graph })
        : { coordinatorId: null, title: null, membersPath: null, workers: [] };

    const activity = new Map();
    recordSessionTouches(activity, agyState, swarm, {
        resolvedRoot, realRepoRoot, repoName, indexedRelSet, activeSid, appDataDirs,
    });

    const sortedEntries = [...activity.entries()].sort((a, b) => {
        const score = (e) => (e.editors.size >= 2 ? 0 : e.editors.size === 1 ? 1 : e.retrieved ? 2 : 3);
        return score(a[1]) - score(b[1]) || a[0].localeCompare(b[0]);
    });

    const nodes = [];
    const edges = [];
    const edgeSeen = new Set();
    const nodeByRel = new Map();
    const { editedOrCollisionRels, collisionCount } = appendEditedAndCollisionNodes(sortedEntries, nodes, nodeByRel);
    appendAffectedCallerNodes(graph, resolvedRoot, editedOrCollisionRels, activity, { nodes, edges, edgeSeen, nodeByRel });
    appendRetrievedNodes(sortedEntries, nodes, nodeByRel);
    appendIndexedFileEdges(graph, nodeByRel, edges, edgeSeen);

    return {
        meta: {
            repoName,
            repoRoot: resolvedRoot,
            repoUri: pathToFileURL(resolvedRoot).href,
            sid: activeSid,
            swarmTitle: swarm.title,
            workers: swarm.workers.map((w) => ({
                name: w.name, role: w.role, conversationId: w.conversationId, model: w.model, state: w.state,
            })),
            collisionCount,
            nodeCount: nodes.length,
            edgeCount: edges.length,
            emptyNote: nodes.length === 0 ? 'No edited, affected, or retrieved files recorded for this session yet.' : undefined,
        },
        nodes,
        edges,
    };
}
