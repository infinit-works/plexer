import { join } from 'node:path';
import { ask as runAsk } from '../../../ask/ask.js';
import { loadGraphCached } from '../../../context/graph-store.js';
import { scopeOf, scopesOfGraph } from '../../../context/scopes.js';
import { nearestPlexerRoot } from '../../../graph/root.js';
import { linkTestsForGraph } from '../../../graph/test-links.js';
import { federateAsk, readWorkspace } from '../../../graph/workspace.js';
import { contextDirFor, isTestPath } from '../../../util/paths.js';
import { readJson, readStats } from '../../../util/state.js';
import { detectPromptIntent } from './intent.js';
import { distillPromptQueries } from './distill.js';
import { HOOK_BUDGETS, enforceMergedHitsBudget, mergeMultiQueryHits } from './budget.js';

export function lastFileScopeHint(dir, lastFile) {
    if (!lastFile) return null;
    try {
        const w = loadGraphCached(contextDirFor(dir));
        if (!w) return null;
        const scopes = scopesOfGraph(w);
        if (scopes.length <= 1) return null;
        const matches = (w.nodes ?? []).filter((n) => n.kind === 'file' && (n.path === lastFile || n.path.endsWith(`/${lastFile}`)));
        if (matches.length === 0) {
            console.error(`[plexer] prompt hook: lastFile "${lastFile}" not found in the graph — skipping scope hint`);
            return null;
        }
        const prefixes = new Set(matches.map((n) => scopeOf(n.path, scopes).prefix));
        if (prefixes.size > 1) {
            console.error(`[plexer] prompt hook: lastFile "${lastFile}" matches more than one scope — skipping scope hint`);
            return null;
        }
        const [prefix] = prefixes;
        return prefix === '' ? null : prefix;
    } catch { return null; }
}

function collectTargetNodes(hits, graph, nodesByPath) {
    const out = [];
    const seen = new Set();
    for (const h of hits.slice(0, 4)) {
        const ptr = String(h.pointer ?? '').split(',')[0].trim();
        const colon = ptr.indexOf(':');
        if (colon <= 0) continue;
        const [f, sp] = [ptr.slice(0, colon), ptr.slice(colon + 1)];
        if (isTestPath(f)) continue;
        const list = nodesByPath.get(f) ?? (graph.nodes ?? []).filter((n) => n.path === f);
        for (const n of list) {
            if (n.kind !== 'file' && n.span === sp && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
        }
    }
    return out;
}

function appendLinkedTestPointer(graph, targetNodes, primaryFiles, seenCandFiles, pointers) {
    try {
        const testLinks = linkTestsForGraph(graph);
        let best = null;
        for (const tn of targetNodes) {
            best = testLinks.testsForSymbol(tn.id, tn.path, true).find((t) => !seenCandFiles.has(t.testFile));
            if (best) break;
        }
        if (!best && typeof testLinks.testsForFile === 'function') {
            for (const pf of primaryFiles) {
                best = testLinks.testsForFile(pf)?.find?.((t) => !seenCandFiles.has(t.testFile)) ?? null;
                if (best) break;
            }
        }
        if (best?.testFile) { seenCandFiles.add(best.testFile); pointers.push(`${best.testFile} [test]`); }
    } catch { /* optional test link enrichment */ }
}

function appendCallPeerPointers(graph, targetNodes, byId, seenCandFiles, pointers) {
    const addPeer = (edges, otherKey, arrow, targetName) => {
        for (const e of edges ?? []) {
            if (e.relation !== 'calls' || e.typeOnly) continue;
            const peer = byId.get(e[otherKey]);
            if (!peer?.path || peer.kind === 'file' || isTestPath(peer.path) || seenCandFiles.has(peer.path)) continue;
            seenCandFiles.add(peer.path);
            pointers.push(`${peer.span ? `${peer.path}:${peer.span}` : peer.path} (${arrow} ${targetName})`);
            if (pointers.length >= 2) return true;
        }
        return false;
    };
    for (const tn of targetNodes) {
        const inEdges = graph._inEdges ? graph._inEdges.get(tn.id) : (graph.edges ?? []).filter((e) => e.target === tn.id);
        if (addPeer(inEdges, 'source', '←', tn.name)) break;
    }
    if (pointers.length < 2) {
        for (const tn of targetNodes) {
            const outEdges = graph._outEdges ? graph._outEdges.get(tn.id) : (graph.edges ?? []).filter((e) => e.source === tn.id);
            if (addPeer(outEdges, 'target', '→', tn.name)) break;
        }
    }
}

export function computeCoEditPointers(ctxDir, graph, hits) {
    if (!graph || !Array.isArray(hits) || hits.length === 0) return [];
    const shownFiles = new Set(hits.map((h) => String(h.pointer ?? '').split(':')[0]).filter(Boolean));
    const primaryFiles = [...shownFiles].filter((f) => !isTestPath(f)).slice(0, 3);
    if (primaryFiles.length === 0) return [];
    const byId = graph._byId ?? new Map((graph.nodes ?? []).map((n) => [n.id, n]));
    const targetNodes = collectTargetNodes(hits, graph, graph._nodesByPath ?? new Map());
    const pointers = [];
    const seenCandFiles = new Set(shownFiles);
    appendCallPeerPointers(graph, targetNodes, byId, seenCandFiles, pointers);
    const hist = pointers.length < 3 && ctxDir ? readJson(join(ctxDir, '.cache', 'git-history.json')) : null;
    if (hist?.coChanges && typeof hist.coChanges === 'object') {
        for (const pf of primaryFiles) {
            for (const c of hist.coChanges[pf] ?? []) {
                if (!c?.file || seenCandFiles.has(c.file) || isTestPath(c.file) || (c.coCommits ?? 0) < 3 || (c.couplingRatio ?? 0) < 0.5 || !byId.has(c.file)) continue;
                seenCandFiles.add(c.file);
                pointers.push(`${c.file} (co-changed ${Math.round(c.couplingRatio * 100)}%)`);
                if (pointers.length >= 3) break;
            }
            if (pointers.length >= 3) break;
        }
    }
    if (pointers.length < 4) appendLinkedTestPointer(graph, targetNodes, primaryFiles, seenCandFiles, pointers);
    return pointers.slice(0, 4);
}

function runScopedPromptQueries(root, contextDir, queries, intent, scope) {
    if (readWorkspace(root, contextDir)) {
        return federateAsk(root, contextDir, queries[0], { limit: 3, source: true, in: scope ?? undefined });
    }
    if (queries.length === 1) {
        const single = runAsk(root, queries[0], {
            limit: 3, source: true, maxHitsToInline: HOOK_BUDGETS.singleQueryInline,
            maxSourceBytes: intent.editEnvelope ? HOOK_BUDGETS.editSingleHitBytes : HOOK_BUDGETS.qaSingleHitBytes,
            wantsCallSites: intent.wantsCallSites, editEnvelope: intent.editEnvelope,
            includeRankingMetadata: false, contextDir, in: scope ?? undefined,
        });
        if (single) single.isEditPrompt = intent.editEnvelope;
        return single;
    }
    const seen = new Set();
    const results = queries.map((q, qIdx) => runAsk(root, q, {
        limit: 3, source: true, subQueryIndex: qIdx,
        maxHitsToInline: (qIdx === 0 && !intent.editEnvelope && intent.wantsCallSites) ? 2 : HOOK_BUDGETS.multiQueryInline,
        maxSourceBytes: intent.editEnvelope ? HOOK_BUDGETS.editMultiHitBytes
            : (qIdx === 0 && intent.wantsCallSites ? HOOK_BUDGETS.qaMultiHitBytes + 1100
                : (qIdx > 0 && intent.wantsCallSites ? 2600 : HOOK_BUDGETS.qaMultiHitBytes)),
        wantsCallSites: intent.wantsCallSites, editEnvelope: intent.editEnvelope,
        includeRankingMetadata: false, seenPointers: seen, contextDir, in: scope ?? undefined,
    }));
    const mergedHits = mergeMultiQueryHits(results, intent.editEnvelope);
    enforceMergedHitsBudget(mergedHits, intent, queries.length);
    const topHits = mergedHits.slice(0, queries.length >= 4 ? 5 : 4);
    const fileQueryCount = new Map();
    for (const r of results) {
        for (const f of new Set((r?.hits ?? []).map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean))) {
            fileQueryCount.set(f, (fileQueryCount.get(f) ?? 0) + 1);
        }
    }
    const multiQueryFiles = [...fileQueryCount.entries()].filter(([, c]) => c >= 2).map(([f]) => f);
    return {
        query: queries.join(' ; '), mode: 'lexical', hits: topHits, isEditPrompt: intent.editEnvelope,
        allFiles: [...new Set([...topHits.filter((h) => h.code || !h.title?.includes(' · type')).map((h) => (h.pointer ?? '').split(':')[0]).filter(Boolean), ...multiQueryFiles])],
        coverage: Math.max(...results.map((r) => r?.coverage ?? 0)),
        coverageStrong: Math.max(...results.map((r) => r?.coverageStrong ?? 0)),
    };
}

export function searchPromptContext(dir, prompt, opts = {}) {
    const root = nearestPlexerRoot(dir)?.root ?? dir;
    const scopeHint = lastFileScopeHint(root, readStats(root)?.lastFile);
    const contextDir = process.env.PLEXER_DIR ? contextDirFor(root) : undefined;
    try {
        const intent = detectPromptIntent(prompt, opts);
        const queries = distillPromptQueries(root, contextDir, prompt);
        const scoped = runScopedPromptQueries(root, contextDir, queries, intent, scopeHint);
        if (scopeHint && (!scoped?.hits?.length || (scoped.coverageStrong ?? 0) < 0.25)) {
            const unscoped = runScopedPromptQueries(root, contextDir, queries, intent, null);
            const uS = unscoped?.coverageStrong ?? 0, sS = scoped?.coverageStrong ?? 0;
            if (unscoped?.hits?.length && (!scoped?.hits?.length || uS > sS || (uS === sS && (unscoped.coverage ?? 0) > (scoped.coverage ?? 0)))) return unscoped;
        }
        return scoped;
    } catch (err) {
        if (process.env.PLEXER_DEBUG) console.error(`[plexer] prompt hook: searchPromptContext failed (${err?.message ?? err})`);
        return null;
    }
}
