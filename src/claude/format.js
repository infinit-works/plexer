import { basename } from 'node:path';
import { isRedundantSnippet } from '../ask/ask.js';
import { HIGH_FLOOR, STRONG_FLOOR } from '../ask/fuse.js';
const C = {
    indigo: (s) => `\x1b[38;2;84;111;255m${s}\x1b[0m`,
    amber: (s) => `\x1b[38;2;224;165;68m${s}\x1b[0m`,
    muted: (s) => `\x1b[38;5;244m${s}\x1b[0m`,
    text: (s) => `\x1b[38;5;251m${s}\x1b[0m`,
};
const SEP = C.muted(' · ');
export function freshnessSegment(s) {
    if (s.syncing)
        return C.amber('syncing…');
    if (s.dirty && s.staleCount > 0)
        return C.amber(`⚠ ${s.staleCount} stale`);
    if (s.dirty)
        return C.amber('⚠ stale');
    return C.indigo('✓ synced');
}
export function renderStatusline(stats, ctx = {}) {
    if (!stats) {
        return [C.muted('◤ plexer · not built · run ') + C.text('plexer build')];
    }
    const top = [C.muted('◤ ') + C.indigo('plexer'), C.text(`${stats.nodeCount} nodes / ${stats.edgeCount} edges`), freshnessSegment(stats)];
    const bottom = [];
    const usedPct = ctx.usedPct ?? ctx.ctxPct;
    if (typeof usedPct === 'number')
        bottom.push(C.text(`ctx ${usedPct}%`));
    if (stats.lastFile)
        bottom.push(C.muted('last: ') + C.text(basename(stats.lastFile)));
    const lines = [top.join(SEP)];
    if (bottom.length)
        lines.push(C.muted('▸ ') + bottom.join(SEP));
    return lines;
}
function nodeIdsInFile(w, filePath, dir) {
    const nodes = w.nodes ?? [];
    let norm = String(filePath ?? '').replace(/\\/g, '/');
    if (dir) {
        const normDir = String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
        if (norm.startsWith(`${normDir}/`)) {
            norm = norm.slice(normDir.length + 1);
        }
    }
    const exact = nodes.filter((n) => n.path && n.path === norm);
    if (exact.length > 0)
        return new Set(exact.map((n) => n.id));
    let bestLen = 0;
    let bestPath = null;
    for (const n of nodes) {
        if (!n.path)
            continue;
        if (norm.endsWith(`/${n.path}`) && n.path.length > bestLen) {
            bestLen = n.path.length;
            bestPath = n.path;
        }
    }
    if (!bestPath)
        return new Set();
    return new Set(nodes.filter((n) => n.path === bestPath).map((n) => n.id));
}
export function incomingEdges(w, filePath, dir) {
    const ids = nodeIdsInFile(w, filePath, dir);
    if (!ids.size)
        return [];
    const byId = w._byId ?? new Map((w.nodes ?? []).map((n) => [n.id, n]));
    const isTestTarget = /(?:^|\/)(?:tests?|specs?|__tests__|fixtures?)\b|(?:\.|_)(?:test|spec)\.[a-z0-9]+$/i.test(filePath);
    return (w.edges ?? []).filter((e) => {
        if (!ids.has(e.target) || ids.has(e.source))
            return false;
        if (!isTestTarget) {
            const sn = byId.get(e.source);
            const sp = sn?.path ?? '';
            if (/(?:^|\/)(?:tests?|specs?|__tests__|fixtures?)\b|(?:\.|_)(?:test|spec)\.[a-z0-9]+$/i.test(sp))
                return false;
        }
        return true;
    });
}
export function formatBlastRadius(w, filePath, cap = 8, dir) {
    const edges = incomingEdges(w, filePath, dir);
    if (!edges.length)
        return null;
    const byId = w._byId ?? new Map((w.nodes ?? []).map((n) => [n.id, n]));
    const allItems = [...new Set(edges.map((e) => {
        const n = byId.get(e.source);
        const label = n ? `${n.name} (${basename(n.path)})` : e.source;
        return ` • ${e.relation} ← ${label}`;
    }))];
    const items = allItems.slice(0, cap);
    const more = allItems.length > cap ? `\n • +${allItems.length - cap} more` : '';
    return `[plexer] blast radius for ${basename(filePath)}, who depends on it:\n${items.join('\n')}${more}`;
}
function retrievalBody(hits, isEditPrompt = false) {
    let ranked = 0;
    const blocks = hits.map((h, n) => {
        // Pinned hits are numbered but don't consume the ranked hits' "top result" slots
        // (which earn the related / call-site lines below).
        const i = h.pinned ? Infinity : ranked++;
        const num = n + 1;
        const ptr = (h.pointer ?? '').split(',')[0].trim();
        const snip = (h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const redundant = isRedundantSnippet(snip, h.code);
        let b = ` ${num}. ${h.title}: ${ptr}`;
        if (snip && !redundant && (!isEditPrompt || !h.code))
            b += `\n    ${snip}`;
        if (h.related?.length && (isEditPrompt ? Boolean(h.code) || i < 2 : (h.code || i < 2)))
            b += `\n    related: ${h.related.slice(0, 6).join(', ')}`;
        if (h.callSites?.length && (i === 0 || h.wantsCallSites)) {
            const maxCs = h.wantsCallSites ? 26 : (isEditPrompt ? 3 : 5);
            b += `\n    call sites (${h.callSites.length}):`;
            for (const cs of h.callSites.slice(0, maxCs))
                b += `\n      ← ${cs}`;
        }
        if (h.otherSymbols && !h.code && i < 3)
            b += `\n    symbols: ${h.otherSymbols.split(', ').slice(0, 6).join(', ')}`;
        if (h.code)
            b += `\n\`\`\`\n${h.code}\n\`\`\``;
        return b;
    });
    const header = hits.some((h) => h.code)
        ? (isEditPrompt
            ? '[plexer] edit targets localized (skip repo-wide grep/find; batch remaining reads in 1 turn, then apply all edits in 1 turn):'
            : '[plexer] retrieved context, read these spans; do not re-open the files:')
        : '[plexer] starting points for this task: pull the code inline with `plexer ask "<what you need>" --source`, trace impact with `plexer callers <symbol>`, or search with `plexer grep "<literal>"`:';
    return `${header}\n${blocks.join('\n')}`;
}
export function formatRetrieval(ask, cap = 5) {
    // Pinned (named-in-prompt) definitions ride on top of the ranked cap.
    const pinned = (ask.hits ?? []).filter((h) => h.pinned).length;
    const hits = (ask.hits ?? []).slice(0, cap + pinned);
    if (!hits.length)
        return null;
    return retrievalBody(hits, Boolean(ask.isEditPrompt || ask.editEnvelope));
}
/** How many recently-injected pointers the novelty gate remembers per session. */
const INJECTED_POINTERS_CAP = 40;
/** How many weak-match nudges one session may spend. A line that shows up every
 * turn stops being read; two is enough to land the habit without becoming
 * wallpaper. */
export const NUDGE_CAP = 2;
/** The line injected instead of a weak pack: names the command, says why, once.
 * Deliberately not an imperative about plexer in general — it's a fact about this
 * prompt's match quality plus the command that fixes it. */
export function weakMatchNudge(s, strong) {
    const spent = s.nudges ?? 0;
    if (spent >= NUDGE_CAP)
        return null;
    s.nudges = spent + 1;
    return (`[plexer] no strong match for this prompt (name-field match ${strong.toFixed(2)}) — the graph ` +
        `has more than this probe found. Run \`plexer ask "<your task>" --source\` before grepping.`);
}
export function relevantRetrieval(ask, s, cap = 4) {
    if (!(ask.hits ?? []).length)
        return null;
    const lexical = typeof ask.coverage === 'number' || typeof ask.coverageStrong === 'number';
    if (lexical && !ask.hits.some((h) => h.pinned)) {
        const strong = ask.coverageStrong ?? 0;
        const broad = ask.coverage ?? 0;
        const hasSubstantialMatch = strong >= STRONG_FLOOR || broad >= HIGH_FLOOR || (strong >= 0.04 && broad >= 0.14) || broad >= 0.28;
        if (!hasSubstantialMatch)
            return weakMatchNudge(s, strong);
    }
    const seen = new Set(s.injectedPointers ?? []);
    const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
    if (!fresh.length)
        return null;
    const txt = formatRetrieval({ ...ask, hits: fresh }, cap);
    if (!txt)
        return null;
    s.injectedPointers = [...(s.injectedPointers ?? []), ...fresh.slice(0, cap + fresh.filter((h) => h.pinned).length).map((h) => h.pointer)]
        .slice(-INJECTED_POINTERS_CAP);
    return txt;
}
export function formatOrientation(indexMd, budgetBytes = 0, staleNote) {
    const banner = staleNote ? `${staleNote}\n\n` : "";
    if (budgetBytes <= 0) {
        return `${banner}[plexer] This repo is indexed by plexer.`;
    }
    return `${banner}[plexer] This repo is indexed by plexer. Use \`plexer ask "<task>"\`, \`plexer callers <sym> [--depth 2|all]\`, \`plexer read <file:Lx-Ly|file:sym>\`, \`plexer skeleton <file>\`, or \`plexer grep "<pat>"\` to get exact spans and L<n>: source without redundant file reads.`;
}
export function renderSubagent(agentName, session) {
    const q = session?.perAgentQuery?.[agentName];
    const tail = q ? SEP + C.muted('plexer: ') + C.text(q) : '';
    return C.muted('◤ ') + C.indigo(agentName) + tail;
}
