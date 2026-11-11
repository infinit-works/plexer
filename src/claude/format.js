import { basename, relative, resolve } from 'node:path';
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
    if (w._nodesByPath) {
        const exactNodes = w._nodesByPath.get(norm);
        if (exactNodes && exactNodes.length > 0)
            return new Set(exactNodes.map((n) => n.id));
        let bestLen = 0;
        let bestNodes = null;
        for (const [p, list] of w._nodesByPath) {
            if (norm.endsWith(`/${p}`) && p.length > bestLen) {
                bestLen = p.length;
                bestNodes = list;
            }
        }
        return bestNodes ? new Set(bestNodes.map((n) => n.id)) : new Set();
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
    const candidateEdges = [];
    if (w._inEdges) {
        for (const id of ids) {
            const list = w._inEdges.get(id);
            if (list)
                candidateEdges.push(...list);
        }
    }
    else {
        candidateEdges.push(...(w.edges ?? []));
    }
    return candidateEdges.filter((e) => {
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
    const baseCounts = new Map();
    for (const n of w.nodes ?? []) {
        if (n.kind === 'file' && n.path) {
            const b = basename(n.path);
            baseCounts.set(b, (baseCounts.get(b) || 0) + 1);
        }
    }
    const displayFile = (p) => {
        const b = basename(p);
        if ((baseCounts.get(b) || 0) <= 1)
            return b;
        if (dir) {
            const rel = relative(resolve(dir), resolve(dir, p)).replace(/\\/g, '/');
            if (rel && !rel.startsWith('..'))
                return rel;
        }
        return p.replace(/\\/g, '/');
    };
    const allItems = [...new Set(edges.map((e) => {
        const n = byId.get(e.source);
        const label = n ? `${n.name} (${displayFile(n.path)})` : e.source;
        return ` • ${e.relation} ← ${label}`;
    }))];
    const items = allItems.slice(0, cap);
    const more = allItems.length > cap ? `\n • +${allItems.length - cap} more` : '';
    const headerTarget = dir && (baseCounts.get(basename(filePath)) || 0) > 1
        ? (relative(resolve(dir), resolve(filePath)).replace(/\\/g, '/') || basename(filePath))
        : basename(filePath);
    return `[plexer] blast radius for ${headerTarget}, who depends on it:\n${items.join('\n')}${more}`;
}
function selectDiverseCallSites(callSites, maxCs) {
    if (callSites.length <= maxCs)
        return callSites;
    const byFile = new Map();
    for (const cs of callSites) {
        const m = /\(([^():]+):L\d+/.exec(cs);
        const file = m ? m[1] : cs;
        const caller = (m ? cs.slice(0, m.index) : cs).trim();
        let entry = byFile.get(file);
        if (!entry) {
            entry = { seenCallers: new Set(), primary: [], repeats: [] };
            byFile.set(file, entry);
        }
        if (caller && !entry.seenCallers.has(caller)) {
            entry.seenCallers.add(caller);
            entry.primary.push(cs);
        }
        else {
            entry.repeats.push(cs);
        }
    }
    const queues = [...byFile.values()].map((e) => [...e.primary, ...e.repeats]);
    const selected = [];
    while (selected.length < maxCs) {
        let progressed = false;
        for (const q of queues) {
            if (!q.length)
                continue;
            selected.push(q.shift());
            progressed = true;
            if (selected.length >= maxCs)
                break;
        }
        if (!progressed)
            break;
    }
    return selected;
}
function hasExplicitPathHitMatch(ask) {
    const q = String(ask.query ?? '').toLowerCase();
    if (!q)
        return false;
    const refs = q.match(/[a-z0-9_.-]+\/[a-z0-9_./-]+|[a-z0-9_-]+\.(?:py|go|js|ts|tsx|jsx|mjs|cjs|luau|lua|rs|c|cc|cpp|h|hpp|java|rb|php|cs|swift|kt|scala|sh|json|toml|yaml|yml|md)\b/g);
    if (!refs)
        return false;
    const hitFiles = (ask.hits ?? []).map((h) => String(h.pointer ?? '').split(':')[0].replace(/\\/g, '/').toLowerCase()).filter(Boolean);
    return refs.some((ref) => hitFiles.some((f) => f === ref || f.endsWith(`/${ref}`) || f.includes(ref)));
}
function retrievalBody(hits, isEditPrompt = false) {
    let ranked = 0;
    const seenSymbolFiles = new Set();
    const blocks = hits.map((h, n) => {
        // Pinned hits are numbered but don't consume the ranked hits' "top result" slots
        // (which earn the related / call-site lines below).
        const i = h.pinned ? Infinity : ranked++;
        const num = n + 1;
        const ptr = (h.pointer ?? '').split(',')[0].trim();
        const fileKey = ptr.split(':')[0];
        let codeToRender = h.code;
        if (codeToRender && codeToRender.includes('// other symbols in ')) {
            if (fileKey && seenSymbolFiles.has(fileKey)) {
                codeToRender = codeToRender.replace(/\n*\/\/ other symbols in [^\n]+/g, '');
            }
            else if (fileKey) {
                seenSymbolFiles.add(fileKey);
            }
        }
        const snip = (h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        const redundant = isRedundantSnippet(snip, codeToRender);
        let b = ` ${num}. ${h.title}: ${ptr}`;
        if (snip && !redundant && (!isEditPrompt || !codeToRender))
            b += `\n    ${snip}`;
        if (h.related?.length && (codeToRender || i < 2))
            b += `\n    related: ${h.related.slice(0, 6).join(', ')}`;
        if (codeToRender && h.callSites?.length && (h.wantsCallSites || (isEditPrompt && i === 0 && h.callSites.length <= 2))) {
            const maxCs = h.wantsCallSites ? 12 : 2;
            const selected = selectDiverseCallSites(h.callSites, maxCs);
            b += `\n    call sites (${h.callSites.length}):`;
            for (const cs of selected)
                b += `\n      ← ${cs}`;
            if (h.callSites.length > selected.length) {
                const symName = String(h.title ?? '').split(' · ')[0].replace(/\s*\(named in prompt\)\s*$/, '').trim() || '<sym>';
                b += `\n      … +${h.callSites.length - selected.length} more — run \`plexer callers ${symName}\``;
            }
        }
        if (h.otherSymbols && !codeToRender && i < 3 && (!fileKey || !seenSymbolFiles.has(fileKey))) {
            if (fileKey)
                seenSymbolFiles.add(fileKey);
            b += `\n    symbols: ${h.otherSymbols.split(', ').slice(0, 6).join(', ')}`;
        }
        if (codeToRender)
            b += `\n\`\`\`\n${codeToRender}\n\`\`\``;
        return b;
    });
    const header = hits.some((h) => h.code)
        ? (isEditPrompt
            ? '[plexer] edit targets localized (edit inlined `L<n>:` spans directly; batch any missing spans into 1 `plexer read` call or 1 parallel turn; never serialize 1 call/turn or read whole files):'
            : '[plexer] retrieved context (use inlined `L<n>:` spans directly; batch any missing spans into 1 `plexer read` call or 1 parallel turn; never serialize 1 call/turn or read whole files):')
        : '[plexer] starting points (batch any missing spans into 1 `plexer read` or `plexer callers` call or 1 parallel turn; never serialize 1 call/turn or read whole files):';
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
export function relevantRetrieval(ask, s, cap = 4, opts = {}) {
    if (!(ask.hits ?? []).length)
        return null;
    const isFollowUp = Boolean(opts.followUp ?? ((s?.injectedPointers?.length ?? 0) > 0 && opts.followUp !== false));
    const lexical = typeof ask.coverage === 'number' || typeof ask.coverageStrong === 'number';
    const hasPinned = ask.hits.some((h) => h.pinned);
    if (lexical && !hasPinned) {
        const strong = ask.coverageStrong ?? 0;
        const broad = ask.coverage ?? 0;
        const qLen = String(ask.query ?? '').trim().split(/\s+/).filter(Boolean).length;
        const canTrustBroadAlone = strong > 0 || hasExplicitPathHitMatch(ask);
        const hasSubstantialMatch = strong >= STRONG_FLOOR ||
            (strong >= 0.04 && broad >= 0.14) ||
            (canTrustBroadAlone && (broad >= HIGH_FLOOR || (!isFollowUp && qLen >= 6 && broad >= 0.28)));
        if (!hasSubstantialMatch)
            return isFollowUp ? null : weakMatchNudge(s, strong);
    }
    const seen = new Set(s.injectedPointers ?? []);
    if (isFollowUp) {
        const freshPins = ask.hits.filter((h) => h.pinned && !seen.has(h.pointer));
        const rankedHits = ask.hits.filter((h) => !h.pinned);
        const topRanked = rankedHits[0];
        const strong = ask.coverageStrong ?? 0;
        const freshTopRanked = topRanked && !seen.has(topRanked.pointer) && (!lexical || strong >= 0.20)
            ? [topRanked]
            : [];
        const followUpHits = [...freshPins, ...freshTopRanked].slice(0, 2).map((h, idx) => {
            if (!h.code)
                return h;
            if (idx > 0)
                return { ...h, code: undefined };
            if (Buffer.byteLength(h.code, 'utf8') <= 1500)
                return h;
            const lines = h.code.split('\n');
            let acc = [];
            let bytes = 0;
            for (const line of lines) {
                const lb = Buffer.byteLength(line, 'utf8') + 1;
                if (bytes + lb > 1500 && acc.length > 0)
                    break;
                acc.push(line);
                bytes += lb;
            }
            return { ...h, code: acc.join('\n') };
        });
        if (!followUpHits.length)
            return null;
        const txt = formatRetrieval({ ...ask, hits: followUpHits }, 2);
        if (!txt)
            return null;
        s.injectedPointers = [...(s.injectedPointers ?? []), ...followUpHits.map((h) => h.pointer)]
            .slice(-INJECTED_POINTERS_CAP);
        return txt;
    }
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
