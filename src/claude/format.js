import { basename, relative, resolve } from 'node:path';
import { isRedundantSnippet } from '../ask/text-helpers.js';
import { HIGH_FLOOR, STRONG_FLOOR } from '../ask/fuse.js';
import { GENERIC_MEMBER_NAMES } from '../util/id.js';
const C = {
    indigo: (s) => `\x1b[38;2;84;111;255m${s}\x1b[0m`,
    amber: (s) => `\x1b[38;2;224;165;68m${s}\x1b[0m`,
    muted: (s) => `\x1b[38;5;244m${s}\x1b[0m`,
    text: (s) => `\x1b[38;5;251m${s}\x1b[0m`,
};
const SEP = C.muted(' · ');
function freshnessSegment(s) {
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
function getGraphBasenameCounts(w) {
    const nodes = w?.nodes ?? [];
    if (w?._basenameCounts && w._basenameCountsLen === nodes.length)
        return w._basenameCounts;
    const baseCounts = new Map();
    for (const n of nodes) {
        if (n.kind === 'file' && n.path) {
            const b = basename(n.path);
            baseCounts.set(b, (baseCounts.get(b) || 0) + 1);
        }
    }
    if (w && typeof w === 'object') {
        Object.defineProperty(w, '_basenameCounts', { value: baseCounts, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(w, '_basenameCountsLen', { value: nodes.length, enumerable: false, configurable: true, writable: true });
    }
    return baseCounts;
}
export function formatBlastRadius(w, filePath, cap = 8, dir, opts = {}) {
    const rawEdges = incomingEdges(w, filePath, dir);
    if (!rawEdges.length)
        return null;
    const byId = w._byId ?? new Map((w.nodes ?? []).map((n) => [n.id, n]));
    const isPathSeen = typeof opts?.isPathSeen === 'function' ? opts.isPathSeen : null;
    const edges = isPathSeen
        ? rawEdges.filter((e) => {
            const p = byId.get(e.source)?.path;
            return !p || !isPathSeen(p);
        })
        : rawEdges;
    if (!edges.length)
        return null;
    const baseCounts = getGraphBasenameCounts(w);
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
    const header = `[plexer] blast radius for ${headerTarget}, who depends on it:`;
    const maxBytes = typeof opts?.maxBytes === 'number' && Number.isFinite(opts.maxBytes) ? opts.maxBytes : Infinity;
    if (!Number.isFinite(maxBytes))
        return `${header}\n${items.join('\n')}${more}`;
    const kept = [];
    for (const item of items) {
        const candidate = `${header}\n${[...kept, item].join('\n')}`;
        if (Buffer.byteLength(candidate, 'utf8') > maxBytes)
            break;
        kept.push(item);
    }
    if (kept.length === 0)
        return null;
    const rem = allItems.length - kept.length;
    const remNote = rem > 0 ? `\n • +${rem} more` : '';
    const withRem = `${header}\n${kept.join('\n')}${remNote}`;
    return Buffer.byteLength(withRem, 'utf8') <= maxBytes ? withRem : `${header}\n${kept.join('\n')}`;
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
const HIGH_CONFIDENCE_SOURCE_CAP_BYTES = 3800;
const EXPLORATORY_MAP_CAP_BYTES = 1300;

function hasExplicitPathHitMatch(ask) {
    const q = String(ask.query ?? '').toLowerCase();
    if (!q)
        return false;
    const refs = q.match(/[a-z0-9_.-]+\/[a-z0-9_./-]+|[a-z0-9_-]+\.(?:bb|c|cc|cjs|clj|cljc|cljs|cpp|cs|cts|cxx|dart|ex|exs|go|h|hh|hpp|java|js|jsx|kt|kts|lua|luau|mjs|ml|mli|mts|nix|php|py|pyi|r|rb|rs|sc|scala|sol|swift|ts|tsx|vue|zig|svelte|astro|md|sh|json|toml|yaml|yml)\b/g);
    if (!refs)
        return false;
    const hitFiles = (ask.hits ?? []).map((h) => String(h.pointer ?? '').split(':')[0].replace(/\\/g, '/').toLowerCase()).filter(Boolean);
    return refs.some((ref) => hitFiles.some((f) => f === ref || f.endsWith(`/${ref}`) || f.includes(ref)));
}

function compactPointerMapEdgeSummary(h) {
    const hasCounts = typeof h.callerCount === 'number' || typeof h.calleeCount === 'number';
    if (hasCounts && ((h.callerCount ?? 0) > 0 || (h.calleeCount ?? 0) > 0)) {
        const callers = (h.related ?? []).filter((r) => r.startsWith('←')).map((r) => r.slice(2).split(' (')[0].trim());
        const callees = (h.related ?? []).filter((r) => r.startsWith('→')).map((r) => r.slice(2).split(' (')[0].trim());
        const inPart = callers[0] ? `←${callers[0]}` : ((h.callerCount ?? 0) > 0 ? `${h.callerCount}←` : '');
        const outPart = callees[0] ? `→${callees[0]}` : ((h.calleeCount ?? 0) > 0 ? `${h.calleeCount}→` : '');
        const combined = [inPart, outPart].filter(Boolean).join(' ');
        if (combined.length <= 36)
            return combined;
        return (inPart && inPart.length <= 36) ? inPart : combined.slice(0, 36);
    }
    if (Array.isArray(h.related) && h.related.length > 0) {
        return h.related
            .slice(0, 2)
            .map((r) => r.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ''))
            .join(' ')
            .slice(0, 36);
    }
    return '';
}

function formatExploratoryPointerMap(candidates, isEditPrompt = false, coEditPointers = undefined) {
    const list = (candidates ?? []).slice(0, 8);
    if (!list.length)
        return null;
    const renderWithSigCap = (maxCands, sigCap) => {
        const sub = list.slice(0, maxCands);
        const lines = sub.map((h, i) => {
            const ptr = String(h.pointer ?? '').split(',')[0].trim();
            const spanM = /:((?:L?\d+)(?:-L?\d+)?)$/.exec(ptr);
            const file = spanM ? ptr.slice(0, spanM.index) : ptr;
            const span = spanM ? (spanM[1].startsWith('L') ? spanM[1] : `L${spanM[1].replace('-', '-L')}`) : '';
            const sym = String(h.title ?? '').split(' · ')[0].replace(/\s*\(named in prompt\)\s*$/, '').trim();
            const isFileHit = sym === file || sym === basename(file) || String(h.title ?? '').endsWith(' · file');
            const target = isFileHit ? (span ? `${file} (${span})` : file) : `${file}:${sym}${span ? ` (${span})` : ''}`;
            const rawSig = String(h.snippet ?? '').replace(/\s+/g, ' ').trim();
            const sig = rawSig ? (rawSig.length > sigCap ? `${rawSig.slice(0, sigCap - 1)}…` : rawSig) : '';
            const edgeNote = compactPointerMapEdgeSummary(h);
            return ` ${i + 1}. ${target}${sig ? ` — ${sig}` : ''}${edgeNote ? ` · ${edgeNote}` : ''}`;
        });
        const topSpans = sub
            .slice(0, 3)
            .map((h) => String(h.pointer ?? '').split(',')[0].trim())
            .filter(Boolean);
        const header = '[plexer] candidate map (broad query — inspect before reading):';
        const coEdit = isEditPrompt && Array.isArray(coEditPointers) && coEditPointers.length > 0
            ? `\nlikely co-edits / tests: ${coEditPointers.slice(0, 3).join(', ')}`
            : '';
        const hint = topSpans.length > 0 ? `\nhint: plexer read ${topSpans.join(' ')}` : '';
        return `${header}\n${lines.join('\n')}${coEdit}${hint}`;
    };
    for (const [maxCands, sigCap] of [[8, 52], [8, 34], [8, 18], [6, 24], [5, 16]]) {
        const rendered = renderWithSigCap(maxCands, sigCap);
        if (Buffer.byteLength(rendered, 'utf8') <= EXPLORATORY_MAP_CAP_BYTES)
            return rendered;
    }
    return renderWithSigCap(4, 16);
}

function fitHitCodeToBudget(h, n, fileKey, seenSymbolFiles, sourceCapBytes, budgetState) {
    if (h.alreadySeen)
        return undefined;
    let codeToRender = h.code;
    if (!codeToRender)
        return codeToRender;
    if (codeToRender.includes('// other symbols in ')) {
        if (fileKey && seenSymbolFiles.has(fileKey))
            codeToRender = codeToRender.replace(/\n*\/\/ other symbols in [^\n]+/g, '');
        else if (fileKey)
            seenSymbolFiles.add(fileKey);
    }
    if (!Number.isFinite(sourceCapBytes)) {
        budgetState.inlinedCodeBytes += Buffer.byteLength(codeToRender, 'utf8');
        budgetState.hasAnyCode = true;
        return codeToRender;
    }
    let cBytes = Buffer.byteLength(codeToRender, 'utf8');
    while ((n > 0 || codeToRender.includes('\n\n// ')) && budgetState.inlinedCodeBytes + cBytes > sourceCapBytes && codeToRender.includes('\n\n// ')) {
        codeToRender = codeToRender.slice(0, codeToRender.lastIndexOf('\n\n// '));
        cBytes = Buffer.byteLength(codeToRender, 'utf8');
    }
    if (n > 0 && budgetState.inlinedCodeBytes + cBytes > sourceCapBytes)
        return undefined;
    budgetState.inlinedCodeBytes += cBytes;
    budgetState.hasAnyCode = true;
    return codeToRender;
}

function packCompactGroupedCallSites(callSites, maxEntries = 26) {
    const byFile = new Map();
    const list = callSites.slice(0, maxEntries);
    for (const cs of list) {
        const m = /^([^(\n]+?)\s*\(([^():]+):(L\d+(?:-L\d+)?)\)(.*)$/.exec(cs);
        if (!m) {
            (byFile.get('_other') ?? byFile.set('_other', []).get('_other')).push(cs);
            continue;
        }
        const [, caller, file, , rest] = m;
        const lineM = /→\s*(L\d+):\s*(.+)$/.exec(rest);
        const entry = lineM ? `${caller.trim()}@${lineM[1]}: ${lineM[2].trim().slice(0, 56)}` : caller.trim();
        (byFile.get(file) ?? byFile.set(file, []).get(file)).push(entry);
    }
    const out = [];
    for (const [file, items] of byFile) {
        out.push(file === '_other' ? items.join(' | ') : `${file}: ${items.join('; ')}`);
    }
    return { lines: out, shownCount: list.length };
}

function formatSingleRetrievalBlock(h, num, i, ptr, fileKey, codeToRender, isEditPrompt, seenSymbolFiles, opts = {}) {
    if (h.alreadySeen) {
        const seenTag = /^\/\/\s*(\[(?:seen:|already in session context:)[^\]]+\])/.exec(String(h.code ?? '').trim())?.[1]
            || '[seen]';
        return ` ${num}. ${h.title}: ${ptr} — ${seenTag}`;
    }
    const snip = (h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const redundant = isRedundantSnippet(snip, codeToRender);
    let b = ` ${num}. ${h.title}: ${ptr}`;
    if (snip && !redundant && (!isEditPrompt || !codeToRender))
        b += `\n    ${snip}`;
    if (h.related?.length && (codeToRender || i < 2))
        b += `\n    related: ${h.related.slice(0, 6).join(', ')}`;
    const geminiProfile = Boolean(opts?.geminiProfile);
    const showCallSites = codeToRender && h.callSites?.length && (
        h.wantsCallSites ||
        (isEditPrompt && (geminiProfile ? (i < 2 && h.callSites.length <= 6) : (i === 0 && h.callSites.length <= 4)))
    );
    if (showCallSites) {
        b += `\n    call sites (${h.callSites.length}):`;
        let shownCount = 0;
        if (h.wantsCallSites && h.callSites.length > 12) {
            const packed = packCompactGroupedCallSites(h.callSites, geminiProfile ? 34 : 18);
            shownCount = packed.shownCount;
            for (const line of packed.lines)
                b += `\n      ← ${line}`;
        }
        else {
            const selected = selectDiverseCallSites(h.callSites, geminiProfile ? (h.wantsCallSites ? 24 : 6) : (h.wantsCallSites ? 12 : 4));
            shownCount = selected.length;
            for (const cs of selected)
                b += `\n      ← ${cs}`;
        }
        if (h.callSites.length > shownCount) {
            const symName = String(h.title ?? '').split(' · ')[0].replace(/\s*\(named in prompt\)\s*$/, '').trim() || '<sym>';
            b += `\n      … +${h.callSites.length - shownCount} more — run \`plexer callers ${symName}\``;
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
}

function collectAllowedCallerFiles(hits, opts, isEditPrompt) {
    const callerHit0 = opts?.geminiProfile && !isEditPrompt && hits[0]?.wantsCallSites && (hits[0]?.callSites?.length ?? 0) >= 6
        ? hits[0]
        : null;
    if (!callerHit0) return null;
    const allowed = new Set();
    const primaryFile = String(callerHit0.pointer ?? '').split(':')[0];
    if (primaryFile) allowed.add(primaryFile);
    for (const cs of callerHit0.callSites ?? []) {
        const m = /\(([^():]+):L?\d+/.exec(String(cs)) ?? /(?:^|\s)([^\s():]+):L?\d+/.exec(String(cs));
        if (m?.[1]) allowed.add(m[1]);
    }
    return allowed;
}

function retrievalBody(hits, isEditPrompt = false, coEditPointers = undefined, sourceCapBytes = Infinity, opts = {}) {
    if (!hits.length || hits.every((h) => h.alreadySeen))
        return null;
    let ranked = 0;
    const budgetState = { inlinedCodeBytes: 0, hasAnyCode: false };
    const seenSymbolFiles = new Set();
    const allowedCallerFiles = collectAllowedCallerFiles(hits, opts, isEditPrompt);
    const promptText = String(opts?.prompt ?? '');
    const blocks = hits.map((h, n) => {
        // Pinned hits are numbered but don't consume the ranked hits' "top result" slots
        // (which earn the related / call-site lines below).
        const i = h.pinned ? Infinity : ranked++;
        const ptr = (h.pointer ?? '').split(',')[0].trim();
        const fileKey = ptr.split(':')[0];
        const isPromptNamed = Boolean(
            h.pinned
            || String(h.title ?? '').includes('(named in prompt)')
            || (promptText && fileKey && (promptText.includes(fileKey) || promptText.includes(basename(fileKey)))),
        );
        const effectiveHit = (allowedCallerFiles && n >= 1 && h.code && (!fileKey || (!allowedCallerFiles.has(fileKey) && !isPromptNamed)))
            ? { ...h, code: undefined }
            : h;
        const codeToRender = fitHitCodeToBudget(effectiveHit, n, fileKey, seenSymbolFiles, sourceCapBytes, budgetState);
        return formatSingleRetrievalBlock(effectiveHit, n + 1, i, ptr, fileKey, codeToRender, isEditPrompt, seenSymbolFiles, opts);
    });
    const header = budgetState.hasAnyCode
        ? (opts?.planMode && isEditPrompt
            ? '[plexer] plan targets localized (plan mode is read-only — verify any unseen files, cite file:Lx-Ly concisely in exit_plan_mode without reprinting full code):'
            : (opts?.suppressNudge
                ? (isEditPrompt
                    ? '[plexer] localized targets (use inlined spans directly):'
                    : '[plexer] retrieved context (use inlined spans directly):')
                : (opts?.geminiProfile
                    ? (isEditPrompt
                        ? '[plexer] localized targets (edit inlined spans directly):'
                        : '[plexer] retrieved context (reply citing `file:Lx-Ly` with 0 calls if spans answer):')
                    : (isEditPrompt
                        ? '[plexer] localized targets:'
                        : '[plexer] retrieved context:'))))
        : '[plexer] starting points:';
    const footer = isEditPrompt && Array.isArray(coEditPointers) && coEditPointers.length > 0
        ? `\nlikely co-edits / tests: ${coEditPointers.join(', ')}`
        : '';
    return `${header}\n${blocks.join('\n')}${footer}`;
}
export function formatRetrieval(ask, cap = 5, opts = {}) {
    const allHits = ask.hits ?? [];
    const hasPinned = allHits.some((h) => h.pinned);
    const isEdit = Boolean(ask.isEditPrompt || ask.editEnvelope);
    const allowExploratoryCode = (ask.coverage ?? 0) >= 0.60 && (ask.coverageStrong ?? 0) >= 0.24;
    if (ask.confidenceTier === 'exploratory' && !hasPinned && !allowExploratoryCode) {
        const candidates = (ask.candidateMap?.length ? ask.candidateMap : allHits).slice(0, 8);
        return formatExploratoryPointerMap(candidates, isEdit, ask.coEditPointers);
    }
    // Pinned (named-in-prompt) definitions ride on top of the ranked cap.
    const pinned = allHits.filter((h) => h.pinned).length;
    const hits = allHits.slice(0, cap + pinned);
    if (!hits.length)
        return null;
    const highCap = opts?.geminiProfile
        ? (opts?.narrowPrompt ? 2800 : (opts?.fastProfile ? 3400 : 4200))
        : HIGH_CONFIDENCE_SOURCE_CAP_BYTES;
    const sourceCapBytes = ask.confidenceTier === 'high' && !hasPinned
        ? highCap
        : Infinity;
    return retrievalBody(hits, isEdit, ask.coEditPointers, sourceCapBytes, opts);
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
function weakMatchNudge(s, strong) {
    const spent = s.nudges ?? 0;
    if (spent >= NUDGE_CAP)
        return null;
    s.nudges = spent + 1;
    return (`[plexer] no strong match for this prompt (name-field match ${strong.toFixed(2)}) — the graph ` +
        `has more than this probe found. Run \`plexer ask "<your task>" --source\` before grepping.`);
}
function trimFollowUpHitCode(h, idx) {
    if (!h.code)
        return h;
    if (idx > 0)
        return { ...h, code: undefined };
    if (Buffer.byteLength(h.code, 'utf8') <= 1500)
        return h;
    const lines = h.code.split('\n');
    const acc = [];
    let bytes = 0;
    for (const line of lines) {
        const lb = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes + lb > 1440 && acc.length > 0)
            break;
        acc.push(line);
        bytes += lb;
    }
    if (acc.length < lines.length && h.pointer)
        acc.push(`… (continued at ${String(h.pointer).split(',')[0].trim()})`);
    return { ...h, code: acc.join('\n') };
}

function recordFreshRetrieval(ask, s, fresh, cap, exploratory = false, opts = {}) {
    if (!fresh.length)
        return null;
    const payload = exploratory ? { ...ask, hits: fresh, candidateMap: fresh } : { ...ask, hits: fresh };
    const txt = formatRetrieval(payload, cap, opts);
    if (!txt)
        return null;
    const recordCap = exploratory ? cap : cap + fresh.filter((h) => h.pinned).length;
    s.injectedPointers = [...(s.injectedPointers ?? []), ...fresh.slice(0, recordCap).map((h) => h.pointer)]
        .slice(-INJECTED_POINTERS_CAP);
    return txt;
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
        const topRawSym = String(ask.hits[0]?.title ?? '').split(' · ')[0] ?? '';
        const topBareSym = (topRawSym.split(/[.:#]/).pop() ?? topRawSym).toLowerCase();
        const rejectGenericCollision =
            Boolean(topBareSym && GENERIC_MEMBER_NAMES.has(topBareSym)) &&
            !hasExplicitPathHitMatch(ask) &&
            strong < 0.25 &&
            broad < 0.35;
        const hasSubstantialMatch =
            !rejectGenericCollision && (
                strong >= 0.15 ||
                (strong >= STRONG_FLOOR && broad >= 0.22) ||
                hasExplicitPathHitMatch(ask) ||
                (strong >= 0.08 && broad >= HIGH_FLOOR)
            );
        if (!hasSubstantialMatch)
            return null;
    }
    const seen = new Set(s.injectedPointers ?? []);
    if (isFollowUp) {
        const freshPins = ask.hits.filter((h) => h.pinned && !seen.has(h.pointer));
        const topRanked = ask.hits.find((h) => !h.pinned);
        const strong = ask.coverageStrong ?? 0;
        const freshTopRanked = topRanked && !seen.has(topRanked.pointer) && (!lexical || strong >= 0.20)
            ? [topRanked]
            : [];
        const followUpHits = [...freshPins, ...freshTopRanked].slice(0, 2).map(trimFollowUpHitCode);
        return recordFreshRetrieval(ask, s, followUpHits, 2, false, opts);
    }
    const allowExploratoryCode = (ask.coverage ?? 0) >= 0.60 && (ask.coverageStrong ?? 0) >= 0.24;
    if (ask.confidenceTier === 'exploratory' && !hasPinned && !allowExploratoryCode) {
        const pool = ask.candidateMap?.length ? ask.candidateMap : ask.hits;
        return recordFreshRetrieval(ask, s, pool.filter((h) => !seen.has(h.pointer)), 8, true, opts);
    }
    const isEdit = Boolean(ask.isEditPrompt || ask.editEnvelope);
    const effectiveCap = (opts?.geminiProfile && isEdit)
        ? Math.min(cap, (opts?.fastProfile || opts?.narrowPrompt) ? 3 : 4)
        : cap;
    return recordFreshRetrieval(ask, s, ask.hits.filter((h) => !seen.has(h.pointer)), effectiveCap, false, opts);
}
export function formatOrientation(indexMd, budgetBytes = 0, staleNote) {
    const banner = staleNote ? `${staleNote}\n\n` : "";
    if (budgetBytes <= 0) {
        return `${banner}[plexer] This repo is indexed by plexer.`;
    }
    return `${banner}[plexer] This repo is indexed by plexer. Commands: \`plexer ask\`, \`callers\`, \`read <file:Lx-Ly|sym>\`, \`skeleton\`, \`grep\` for exact <n>: spans.`;
}
export function renderSubagent(agentName, session) {
    const q = session?.perAgentQuery?.[agentName];
    const tail = q ? SEP + C.muted('plexer: ') + C.text(q) : '';
    return C.muted('◤ ') + C.indigo(agentName) + tail;
}
