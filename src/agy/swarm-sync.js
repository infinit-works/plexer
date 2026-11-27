/**
 * Swarm coordination helpers for Antigravity hooks:
 *  - Inherits `seenSpans` + `orientedDirs` once when a `/swarm` worker forks from an existing member.
 *  - Emits a compact one-shot warning when another active `/swarm` worker already edited the target file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readAgySession } from './session.js';
import { mergeSpan, normalizeRelFile } from './spans.js';
import { discoverConversationSwarm, findAppDataDirs, locateSwarmRoster } from './context-graph.js';

const ROSTER_MISS_TTL_MS = 5000;
const rosterLookupCache = new Map();

function mtimeMsSafe(p) {
    try {
        return Math.round(statSync(p).mtimeMs);
    }
    catch {
        return 0;
    }
}

function locateDirectSwarmRoster(conversationId, appDataDirs) {
    for (const appData of appDataDirs) {
        const directMembers = join(appData, 'brain', conversationId, '.system_generated', 'swarm', 'members.json');
        if (!existsSync(directMembers))
            continue;
        try {
            const roster = JSON.parse(readFileSync(directMembers, 'utf8'));
            if (roster && typeof roster === 'object')
                return { appData, coordinatorId: conversationId, membersPath: directMembers, roster };
        }
        catch { /* ignore unreadable roster */ }
    }
    return null;
}

function resolveSwarmLookup(conversationId, opts = {}) {
    if (!conversationId || conversationId === 'default')
        return null;
    const skipBrainScan = Boolean(opts.skipBrainScan || opts.agyState?.isSwarmMember === false);
    const useCache = !Array.isArray(opts.appDataDirs);
    const now = Date.now();
    const cacheKey = `${conversationId}\0${skipBrainScan ? '1' : '0'}`;
    if (useCache) {
        const cached = rosterLookupCache.get(cacheKey);
        if (cached) {
            if (!cached.found && (now - cached.checkedAt) < ROSTER_MISS_TTL_MS)
                return null;
            if (cached.found && mtimeMsSafe(cached.found.membersPath) === cached.mtimeMs)
                return cached.found;
        }
    }
    const appDataDirs = findAppDataDirs(opts);
    let found = null;
    try {
        found = locateSwarmRoster(conversationId, { appDataDirs, skipBrainScan });
    }
    catch (err) {
        if (!(err instanceof TypeError))
            throw err;
        found = skipBrainScan
            ? locateDirectSwarmRoster(conversationId, appDataDirs)
            : locateSwarmRoster(conversationId, appDataDirs);
    }
    if (useCache) {
        if (rosterLookupCache.size >= 128)
            rosterLookupCache.delete(rosterLookupCache.keys().next().value);
        rosterLookupCache.set(cacheKey, {
            found,
            mtimeMs: found ? mtimeMsSafe(found.membersPath) : 0,
            checkedAt: now,
        });
    }
    return found;
}

function findSwarmMemberEntry(roster, conversationId) {
    const members = roster?.members;
    if (!members || typeof members !== 'object')
        return null;
    for (const [name, member] of Object.entries(members)) {
        if (member?.conversation_id === conversationId)
            return { name, member };
    }
    return null;
}

function resolveForkSourceConversationId(roster, coordinatorId, forkRef) {
    if (!forkRef || typeof forkRef !== 'string')
        return null;
    const ref = forkRef.trim();
    if (!ref)
        return null;
    if (ref.toLowerCase() === 'coordinator')
        return coordinatorId || null;
    const target = roster?.members?.[ref];
    if (target?.conversation_id)
        return target.conversation_id;
    return /^[0-9a-f-]{8,}$/i.test(ref) ? ref : null;
}

/**
 * Inherit `seenSpans` and `orientedDirs` once when a `/swarm` worker starts from `fork`.
 * Fresh subagents and un-forked workers keep empty `seenSpans`.
 */
export function seedForkedSwarmSession(conversationId, agyState, opts = {}) {
    if (!conversationId || !agyState || typeof agyState !== 'object' || agyState.swarmForkChecked)
        return false;
    agyState.swarmForkChecked = true;
    const skipBrainScan = Boolean(
        opts.skipBrainScan
        || agyState.isSwarmMember === false
        || (!Array.isArray(opts.appDataDirs) && agyState.hasDirectUserInput && !agyState.subagentSenderId),
    );
    const found = resolveSwarmLookup(conversationId, { ...opts, agyState, skipBrainScan });
    if (!found) {
        agyState.isSwarmMember = false;
        return false;
    }
    agyState.isSwarmMember = true;
    if (found.coordinatorId === conversationId)
        return false;

    const entry = findSwarmMemberEntry(found.roster, conversationId);
    if (!entry)
        return false;
    const forkRef = entry.member?.fork ?? entry.member?.forked_from ?? entry.member?.forkedFrom;
    const srcConvId = resolveForkSourceConversationId(found.roster, found.coordinatorId, forkRef);
    if (!srcConvId || srcConvId === conversationId)
        return false;

    const srcState = typeof opts.readSessionFn === 'function'
        ? opts.readSessionFn(srcConvId)
        : readAgySession(srcConvId);
    if (!srcState || typeof srcState !== 'object')
        return false;

    if (Object.keys(agyState.seenSpans ?? {}).length === 0 && srcState.seenSpans && typeof srcState.seenSpans === 'object') {
        agyState.seenSpans = agyState.seenSpans && typeof agyState.seenSpans === 'object' ? agyState.seenSpans : {};
        for (const [k, ranges] of Object.entries(srcState.seenSpans)) {
            if (!Array.isArray(ranges))
                continue;
            for (const pair of ranges) {
                if (Array.isArray(pair) && pair.length >= 2)
                    mergeSpan(agyState.seenSpans, k, pair[0], pair[1]);
            }
        }
    }
    if ((!Array.isArray(agyState.orientedDirs) || agyState.orientedDirs.length === 0) && Array.isArray(srcState.orientedDirs)) {
        agyState.orientedDirs = [...srcState.orientedDirs];
    }
    return true;
}

/**
 * Append a one-shot warning to `agyState.pendingBlastRadius` if another active `/swarm`
 * member has already edited `targetPath`.
 */
export function checkSwarmEditCollision(conversationId, repoRoot, targetPath, agyState, opts = {}) {
    if (!conversationId || !repoRoot || !targetPath || !agyState)
        return null;
    const skipBrainScan = Boolean(opts.skipBrainScan || agyState.isSwarmMember === false);
    const found = resolveSwarmLookup(conversationId, { ...opts, agyState, skipBrainScan });
    if (!found)
        return null;
    agyState.isSwarmMember = true;

    const relTarget = normalizeRelFile(relative(resolve(repoRoot), resolve(repoRoot, targetPath)));
    if (!relTarget || relTarget.startsWith('..'))
        return null;
    agyState.emittedSwarmCollisions = Array.isArray(agyState.emittedSwarmCollisions) ? agyState.emittedSwarmCollisions : [];
    if (agyState.emittedSwarmCollisions.includes(relTarget))
        return null;

    const matchesRel = (ef) => {
        const norm = normalizeRelFile(ef);
        return norm === relTarget || norm.endsWith(`/${relTarget}`) || relTarget.endsWith(`/${norm}`);
    };
    const swarm = discoverConversationSwarm(conversationId, repoRoot, { appDataDirs: opts.appDataDirs });
    let hitLabel = null;
    const collidesWith = (swarm.workers ?? []).find((w) => {
        if (!w || w.state === 'killed' || w.conversationId === conversationId)
            return false;
        return Array.isArray(w.editedFiles) && w.editedFiles.some(matchesRel);
    });
    if (collidesWith) {
        hitLabel = `@${collidesWith.name}`;
    }
    else if (found.coordinatorId && found.coordinatorId !== conversationId) {
        const coordState = typeof opts.readSessionFn === 'function'
            ? opts.readSessionFn(found.coordinatorId)
            : readAgySession(found.coordinatorId);
        if ((coordState?.emittedBlastFiles ?? []).some(matchesRel))
            hitLabel = 'coordinator';
    }
    if (!hitLabel)
        return null;

    agyState.emittedSwarmCollisions.push(relTarget);
    const msg = `[plexer] swarm collision warning: ${hitLabel} also edited ${relTarget} in this swarm — inspect recent changes before overwriting.`;
    if (!opts.preTool) {
        agyState.pendingBlastRadius = agyState.pendingBlastRadius
            ? (agyState.pendingBlastRadius.includes(msg) ? agyState.pendingBlastRadius : `${agyState.pendingBlastRadius}\n${msg}`)
            : msg;
    }
    return msg;
}
