/**
 * Multi-workspace resolution, target routing, and RRF federated Turn-0 retrieval
 * for Antigravity 2.0 Projects attaching multiple workspace folders.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fuseScopes, HIGH_FLOOR, STRONG_FLOOR } from '../ask/fuse.js';
import { queryPromptContext } from '../claude/hooks.js';
import { hasAncestorRepoOrIndex, hasPlexerIndex, isAutoBuildableRepo, isBoundaryDir } from '../graph/root.js';
import { tryRealpath } from '../util/fs.js';
import { contextDirFor, fileUriToPath } from '../util/paths.js';

function tryRealpathNorm(p) {
    if (!p || typeof p !== 'string')
        return '';
    const candidate = fileUriToPath(p.trim());
    return candidate ? tryRealpath(candidate).replace(/\\/g, '/') : '';
}

function findNearestRepoForCandidate(rawPath) {
    if (!rawPath || typeof rawPath !== 'string')
        return null;
    const candidate = fileUriToPath(rawPath.trim());
    if (!candidate)
        return null;
    let startDir = resolve(candidate);
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
        if (isAutoBuildableRepo(cur))
            return cur;
        const parent = dirname(cur);
        if (parent === cur)
            break;
        cur = parent;
    }
    return isBoundaryDir(startDir) ? null : startDir;
}

/**
 * Resolve all active repository roots from `input.workspacePaths`, deduplicated
 * by realpath while preserving host ordering.
 */
export function resolveAgyWorkspaceDirs(input, _sessionState = null, opts = {}) {
    const out = [];
    const seen = new Set();
    const rawList = Array.isArray(input?.workspacePaths) ? input.workspacePaths : [];
    for (const raw of rawList) {
        if (!raw || typeof raw !== 'string')
            continue;
        const repoDir = findNearestRepoForCandidate(raw);
        if (!repoDir)
            continue;
        const key = tryRealpathNorm(repoDir);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(repoDir);
    }
    if (out.length === 0 && opts.fallbackDir) {
        out.push(resolve(opts.fallbackDir));
    }
    return out;
}

function matchedPrefixLength(candidates, bases) {
    let bestLen = -1;
    for (const candidate of candidates) {
        for (const base of bases) {
            if (!base)
                continue;
            const matches = candidate === base || candidate.startsWith(`${base}/`);
            if (matches && base.length > bestLen)
                bestLen = base.length;
        }
    }
    return bestLen;
}

/**
 * Pick the workspace root containing `targetPath` (longest matching prefix wins).
 */
export function pickRepoForTargetPath(targetPath, workspaceDirs = [], fallbackDir = null) {
    if (!targetPath || typeof targetPath !== 'string')
        return fallbackDir;
    const dirs = Array.isArray(workspaceDirs) ? workspaceDirs : [];
    const candidates = [
        tryRealpathNorm(targetPath),
        resolve(targetPath).replace(/\\/g, '/'),
    ];

    let bestDir = null;
    let bestLen = -1;
    for (const dir of dirs) {
        if (!dir)
            continue;
        const bases = [
            tryRealpathNorm(dir).replace(/\/+$/, ''),
            resolve(dir).replace(/\\/g, '/').replace(/\/+$/, ''),
        ];
        const matchLen = matchedPrefixLength(candidates, bases);
        if (matchLen > bestLen) {
            bestLen = matchLen;
            bestDir = dir;
        }
    }
    if (bestDir)
        return bestDir;
    if (isAbsolute(targetPath)) {
        const nearest = findNearestRepoForCandidate(targetPath);
        if (nearest && hasPlexerIndex(nearest))
            return nearest;
    }
    return fallbackDir;
}

export function buildUniqueRepoLabels(dirs) {
    const counts = new Map();
    for (const d of dirs) {
        const b = basename(d) || 'repo';
        counts.set(b, (counts.get(b) || 0) + 1);
    }
    return dirs.map((d) => {
        const b = basename(d) || 'repo';
        if ((counts.get(b) || 0) <= 1)
            return b;
        const parent = basename(dirname(d));
        return parent ? `${parent}/${b}` : b;
    });
}

function findScopedWorkspaceIndex(labels, prompt) {
    const text = String(prompt ?? '');
    if (!text)
        return -1;
    const matches = [];
    for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        const base = basename(label);
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:/|\\b)`, 'i');
        if (re.test(text))
            matches.push(i);
    }
    return matches.length === 1 ? matches[0] : -1;
}

function prefixPointer(label, pointer) {
    const raw = String(pointer ?? '').trim();
    if (!raw)
        return raw;
    if (raw.startsWith(`${label}/`))
        return raw;
    return `${label}/${raw}`;
}

function collectQualifiedRepoResults(cappedDirs, labels, distilledPrompt, queryOpts) {
    const perRepo = [];
    let bestWeak = null;
    for (let i = 0; i < cappedDirs.length; i++) {
        const dir = cappedDirs[i];
        const res = queryPromptContext(dir, distilledPrompt, queryOpts);
        if (!res)
            continue;
        if (!bestWeak || (res.coverageStrong ?? 0) > (bestWeak.coverageStrong ?? 0))
            bestWeak = res;
        if (!Array.isArray(res.hits) || res.hits.length === 0)
            continue;
        const strong = res.coverageStrong ?? 0;
        const broad = res.coverage ?? 0;
        const hasPinned = res.hits.some((h) => h.pinned);
        if (hasPinned || strong >= STRONG_FLOOR || broad >= HIGH_FLOOR)
            perRepo.push({ dir, label: labels[i], res });
    }
    return { perRepo, bestWeak };
}

function appendPrefixedRepoHits(entry, state) {
    const { label, res } = entry;
    state.maxStrong = Math.max(state.maxStrong, res.coverageStrong ?? 0);
    state.maxBroad = Math.max(state.maxBroad, res.coverage ?? 0);
    if (res.isEditPrompt || res.editEnvelope)
        state.anyEdit = true;

    for (const ptr of res.coEditPointers ?? []) {
        const prefixed = prefixPointer(label, ptr);
        if (!state.seenCoEdits.has(prefixed)) {
            state.seenCoEdits.add(prefixed);
            state.mergedCoEdits.push(prefixed);
        }
    }

    const hits = res.hits ?? [];
    for (let idx = 0; idx < hits.length; idx++) {
        const h = hits[idx];
        const prefixedPtr = prefixPointer(label, h.pointer);
        const prefixedHit = {
            ...h,
            pointer: prefixedPtr,
            title: h.title ? `${h.title}` : prefixedPtr,
            repoLabel: label,
            repoDir: entry.dir,
        };
        if (h.pinned) {
            if (!state.seenPins.has(prefixedPtr)) {
                state.seenPins.add(prefixedPtr);
                state.pinnedHitsOut.push(prefixedHit);
            }
            continue;
        }
        const docId = `${label}::${idx}::${prefixedPtr}`;
        const validScore = typeof h.score === 'number' && Number.isFinite(h.score) && h.score > 0;
        state.hitById.set(docId, prefixedHit);
        state.docs.push({ id: docId, scope: label, score: validScore ? h.score : 1 / (idx + 1) });
    }
}

function mergeFederatedRepoResults(perRepo, distilledPrompt) {
    const state = {
        hitById: new Map(),
        docs: [],
        pinnedHitsOut: [],
        seenPins: new Set(),
        mergedCoEdits: [],
        seenCoEdits: new Set(),
        maxStrong: 0,
        maxBroad: 0,
        anyEdit: false,
    };
    for (const entry of perRepo)
        appendPrefixedRepoHits(entry, state);

    const fused = fuseScopes(state.docs);
    const rankedHits = fused.ranked.map((r) => state.hitById.get(r.id)).filter(Boolean);

    return {
        query: distilledPrompt,
        hits: [...state.pinnedHitsOut, ...rankedHits],
        coEditPointers: state.mergedCoEdits.slice(0, 6),
        coverageStrong: state.maxStrong,
        coverage: state.maxBroad,
        isEditPrompt: state.anyEdit,
        editEnvelope: state.anyEdit,
        multiRoot: true,
        federatedRepos: perRepo.map((p) => p.label),
    };
}

/**
 * Query multiple attached workspace repos and fuse cross-repo ranked results via RRF
 * (`fuseScopes`), prefixing pointers with `<repoLabel>/` only when >=2 repos match.
 */
export function queryMultiWorkspaceContext(workspaceDirs, distilledPrompt, queryOpts = {}) {
    const dirs = (Array.isArray(workspaceDirs) ? workspaceDirs : []).filter((d) => d && existsSync(contextDirFor(d)));
    if (dirs.length === 0)
        return null;
    if (dirs.length === 1)
        return queryPromptContext(dirs[0], distilledPrompt, queryOpts);

    const cappedDirs = dirs.slice(0, 6);
    const labels = buildUniqueRepoLabels(cappedDirs);
    const scopedIdx = findScopedWorkspaceIndex(labels, distilledPrompt);
    if (scopedIdx !== -1) {
        const scopedRes = queryPromptContext(cappedDirs[scopedIdx], distilledPrompt, queryOpts);
        const strongEnough = (scopedRes?.coverageStrong ?? 0) >= 0.1 || scopedRes?.hits?.some((h) => h.pinned);
        if (scopedRes?.hits?.length && strongEnough)
            return { ...scopedRes, repoDir: cappedDirs[scopedIdx], multiRoot: false };
    }

    const { perRepo, bestWeak } = collectQualifiedRepoResults(cappedDirs, labels, distilledPrompt, queryOpts);
    if (perRepo.length === 0)
        return bestWeak;
    if (perRepo.length === 1)
        return { ...perRepo[0].res, repoDir: perRepo[0].dir, multiRoot: false };
    return mergeFederatedRepoResults(perRepo, distilledPrompt);
}
