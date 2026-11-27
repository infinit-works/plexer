/**
 * Named-definition pinning for the prompt hook.
 *
 * When a prompt names code it wants changed or explained — `skeleton(repoDir, …)`,
 * `HostHooks`, `history.clear()` — the agent's first move is to open those exact
 * definitions. Ranked retrieval can miss them (a long issue text has many competing
 * terms), so this resolves identifiers the prompt names *as code* (backticks or call
 * syntax) to their unique definitions in the graph and inlines those bodies directly.
 *
 * Resolution is deliberately conservative: exact (case-sensitive) name matches on
 * definition nodes, test files excluded, and a name with more than two definitions is
 * only pinned when the prompt also names its file. Unresolvable names (things the task
 * asks to *create*) are simply skipped.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isGeneratedPath, isTestPath } from '../util/paths.js';
import { GENERIC_MEMBER_NAMES } from '../util/id.js';
import { fmtLine, hasInlinedLine, LINE_PREFIX_RE, spanRange } from '../util/span.js';

const DEF_KINDS = new Set(['function', 'method', 'class', 'type', 'interface', 'struct', 'enum', 'trait', 'impl', 'variable', 'const', 'constant', 'field', 'doc']);
/** Value-ish kinds are only worth pinning when they carry a body (a table/struct literal), not a one-line alias. */
const VALUE_KINDS = new Set(['variable', 'const', 'constant', 'field']);
/** Words that look like identifiers in prose/backticks but never name a definition worth pinning. */
const STOP = new Set([
    'true', 'false', 'nil', 'null', 'none', 'undefined', 'self', 'this', 'super', 'return', 'function', 'local',
    'string', 'number', 'boolean', 'table', 'object', 'array', 'thread', 'any', 'void', 'never', 'unknown',
    'error', 'print', 'require', 'import', 'export', 'async', 'await', 'const', 'type', 'new', 'init', 'main',
    'index', 'value', 'values', 'data', 'name', 'args', 'opts', 'options', 'config', 'result', 'callback',
    'tuple', 'struct', 'union', 'enum', 'class', 'interface', 'trait', 'impl', 'field', 'method', 'file', 'files', 'path', 'plexer', 'repr',
]);

const MAX_PIN_LINES = 85;
const isCompoundId = (name) => /[a-z][A-Z]|[A-Z][a-z0-9]+[A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(name);

const LITERAL_STOP = new Set(['true', 'false', 'nil', 'null', 'none', 'undefined', 'self', 'this', 'super']);
const FILE_EXT_SPAN_RE = /^[\w.-]+\.(?:[jt]sx?|mjs|cjs|mts|cts|py[iw]?|go|rs|java|kt[sm]?|swift|php|rb|lua[uc]?|c|h|cc|hh|cpp|hpp|cs|r|rmd|sql|sh|bash|zsh|ps1|jsonc?|ya?ml|toml|xml|html?|css|scss|less|md|mdx|txt|csv|tsv|svg|png|jpe?g|gif|webp|ico|lock|cfg|ini|env|conf|log|sqlite|db|wasm|map|sum|mod)$/i;

function isIgnorableBacktickSpan(span) {
    return (span.includes('/') ||
        span.includes('@') ||
        FILE_EXT_SPAN_RE.test(span) ||
        /^--?[\w-]+$/.test(span) ||
        /^plexer\s+/i.test(span));
}

function extractBacktickSpanIdentifiers(span, recordIdentifier) {
    for (const id of span.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const idx = id.index ?? 0;
        const after = span.slice(idx + id[0].length);
        if (/^[.:][A-Za-z_]/.test(after) && !/^[A-Z]/.test(id[0])) continue;
        const before = span.slice(0, idx);
        const qualMatch = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[.:]$/.exec(before);
        const qual = qualMatch?.[1] ?? null;
        recordIdentifier(id[0], /^\s*\(/.test(after) ? 2 : 1, null, qual);
    }
}

/** Identifiers the prompt names as code, in order of first appearance, with mention counts. */
export function namedIdentifiers(prompt) {
    const text = String(prompt ?? '')
        .replace(/^Working directory:.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '');
    const found = new Map();
    const recordIdentifier = (name, strength, owner = null, qual = null) => {
        if (!name || (name.length < (qual ? 3 : 4) && !owner) || LITERAL_STOP.has(name.toLowerCase()) || (!qual && STOP.has(name.toLowerCase())) || /^\d/.test(name)) return null;
        const key = owner ? `${owner}#${name}` : qual ? `${qual}.${name}` : name;
        const e = found.get(key) ?? { name, owner, ...(qual ? { qual } : {}), strength: 0, order: found.size };
        e.strength += strength;
        found.set(key, e);
        return e;
    };
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`\s+in\s+`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        recordIdentifier(m[1], 3, m[2]);
    }
    for (const m of text.matchAll(/`([^`\n]{1,160})`/g)) {
        const span = m[1].trim();
        if (!isIgnorableBacktickSpan(span)) extractBacktickSpanIdentifiers(span, recordIdentifier);
    }
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\b/g)) {
        const full = m[1];
        if (FILE_EXT_SPAN_RE.test(full) || !/[A-Z]/.test(full)) continue;
        const dot = full.lastIndexOf('.');
        const qual = full.slice(0, dot);
        const leaf = full.slice(dot + 1);
        recordIdentifier(leaf, 1, null, qual);
    }
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
        const idx = m.index ?? 0;
        const after = text.slice(idx + m[0].length - 1);
        if (idx > 0 && /[/:]/.test(text[idx - 1])) continue;
        recordIdentifier(m[1], /^\([^)\n]{0,80}\)/.test(after) ? 1 : 0);
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
        if (m[1].length >= 4) recordIdentifier(m[1], 1);
    }
    return [...found.values()].filter((x) => x.strength > 0);
}

function isEligiblePinBareNode(n, bareExact) {
    if (!n?.path || !DEF_KINDS.has(n.kind) || isTestPath(n.path) || isGeneratedPath(n.path))
        return false;
    const sp = spanRange(n.span);
    if (!sp || (VALUE_KINDS.has(n.kind) && sp.end - sp.start < 2 && !(n.kind === 'field' && n.owner)))
        return false;
    return String(n.name ?? '').split(/[.:#]/).pop() === bareExact;
}

function getByBareNameIndex(graph) {
    if (graph?._byBareName)
        return graph._byBareName;
    if (graph?.byBareName) {
        return {
            has(name) {
                if (!name) return false;
                const list = graph.byBareName.get(String(name).toLowerCase());
                return Boolean(list && list.some((n) => isEligiblePinBareNode(n, name)));
            },
            get(name) {
                if (!name) return [];
                const list = graph.byBareName.get(String(name).toLowerCase());
                if (!list || list.length === 0) return [];
                const out = [];
                for (let i = 0; i < list.length; i++) {
                    if (isEligiblePinBareNode(list[i], name))
                        out.push(list[i]);
                }
                return out;
            },
        };
    }
    const m = new Map();
    for (const n of graph.nodes) {
        const bare = String(n.name ?? '').split(/[.:#]/).pop();
        if (!bare || !isEligiblePinBareNode(n, bare)) continue;
        (m.get(bare) ?? m.set(bare, []).get(bare)).push(n);
    }
    graph._byBareName = m;
    return m;
}

function pruneOverlappingPinContainers(out, hints) {
    const droppedOwners = new Set();
    for (const p of out) {
        const ownerName = p.owner ?? p.qual;
        if (!ownerName) continue;
        const container = out.find((q) => q !== p && q.node.path === p.node.path && q.node.name === ownerName && (q.node.kind === 'struct' || q.node.kind === 'class'));
        if (!container) continue;
        if (p.a >= container.a && p.b <= container.b && p.b <= container.a + 43) continue;
        droppedOwners.add(container);
        if (p.a > container.b && p.a - container.b <= 30 && p.b - p.a <= 12) {
            p.a = Math.max(1, container.b - 1);
        } else if (p.a > container.b && p.a - container.b <= 30 && container.b - container.a <= 25) {
            p.a = container.a;
        }
    }
    // Drop definitions nested inside another pinned definition (the outer body covers them).
    const kept = out.filter((p) => !droppedOwners.has(p) && !out.some((q) => q !== p && !droppedOwners.has(q) && q.node.path === p.node.path && q.a <= p.a && p.b <= q.b && q.b - q.a <= MAX_PIN_LINES));
    const inHint = (p) => (hints.has(p.node.path) ? 1 : 0);
    kept.sort((x, y) => y.strength - x.strength || inHint(y) - inHint(x) || x.order - y.order);
    return kept;
}

function countIncomingPinCallers(graph, nodeId) {
    const inList = graph?._inEdges
        ? (graph._inEdges.get(nodeId) ?? [])
        : (graph?.edges ?? []).filter((e) => e.target === nodeId);
    let count = 0;
    for (const e of inList) {
        if (e.relation === 'calls' || e.relation === 'interface_dispatch' || e.relation === 'references' || e.relation === 'implements')
            count++;
    }
    return count;
}

function selectDominantOverloadedHub(graph, defs, hints) {
    const scored = defs.map((n) => {
        const sp = spanRange(n.span);
        const bodyLines = sp ? sp.end - sp.start + 1 : 1;
        const incoming = countIncomingPinCallers(graph, n.id);
        const nonTest = !isTestPath(n.path);
        const score = (nonTest ? 2 : -10) +
            (n.exported ? 4 : 0) +
            Math.min(12, incoming) +
            (bodyLines > 2 ? 2 : 0) +
            (hints.has(n.path) ? 2 : 0);
        return { n, nonTest, incoming, score };
    });
    scored.sort((a, b) =>
        b.score - a.score ||
        Number(Boolean(a.n.dependency)) - Number(Boolean(b.n.dependency)) ||
        b.incoming - a.incoming
    );
    const [top, second] = scored;
    if (top && second && top.nonTest && top.n.exported && top.score >= second.score + 3) {
        return [top.n];
    }
    return [];
}

function disambiguateOverloadedDefs(graph, defs, fileNamedInPrompt, topHints, hints, compound) {
    let strongDefs = defs.filter((n) => fileNamedInPrompt(n.path, n) || topHints.has(n.path));
    if (strongDefs.length > 1) {
        const exportedOrNamed = strongDefs.filter((n) => n.exported || fileNamedInPrompt(n.path, n));
        if (exportedOrNamed.length > 0 && exportedOrNamed.length < strongDefs.length) {
            strongDefs = exportedOrNamed;
        }
    }
    if (strongDefs.length > 0) return strongDefs;
    if (defs.length <= 2) {
        return compound ? defs.filter((n) => hints.has(n.path)) : [];
    }
    if (!compound) return [];
    const dominant = selectDominantOverloadedHub(graph, defs, hints);
    if (dominant.length > 0) return dominant;
    const hinted = compound ? defs.filter((n) => hints.has(n.path)) : [];
    return hinted.length === 1 ? hinted : [];
}

function filterDefsByQualifier(defs, id) {
    const qLower = id.qual.toLowerCase();
    const idTail = `${id.qual}.${id.name}`.toLowerCase();
    const ownerDefs = defs.filter((n) =>
        (n.owner && (n.owner.toLowerCase() === qLower || (!qLower.includes('.') && n.owner.toLowerCase().endsWith(`.${qLower}`)))) ||
        n.id.toLowerCase().endsWith(`#${idTail}`) ||
        (n.signature && (n.signature.includes(`${id.qual}.${id.name}`) || n.signature.includes(`${id.qual}:${id.name}`))),
    );
    const qualDefs = ownerDefs.length > 0
        ? ownerDefs
        : !qLower.includes('.')
            ? defs.filter((n) => basename(n.path).replace(/\.[a-z0-9]+$/i, '').toLowerCase() === qLower)
            : [];
    return {
        defs: qualDefs.length > 0 ? qualDefs : defs,
        matched: qualDefs.length > 0,
    };
}

function narrowPinDefsForId(id, byBare, graph, fileNamedInPrompt, topHints, hints, hasHintFiles) {
    let defs = byBare.get(id.name) ?? [];
    if (defs.length > 1) {
        const codeDefs = defs.filter((n) => n.kind !== 'doc');
        if (codeDefs.length > 0) defs = codeDefs;
    }
    if (id.owner) defs = defs.filter((n) => n.owner === id.owner);
    if (!defs.length) return [];
    let qualMatched = false;
    if (id.qual) {
        const qRes = filterDefsByQualifier(defs, id);
        qualMatched = qRes.matched;
        if (defs.length > 1 && !qualMatched && (!isCompoundId(id.name) || GENERIC_MEMBER_NAMES.has(id.name.toLowerCase()))) return [];
        if (defs.length > 1) defs = qRes.defs;
    }
    if (!qualMatched && !id.owner) {
        defs = defs.filter((n) => {
            if (!VALUE_KINDS.has(n.kind)) return true;
            const sp = spanRange(n.span);
            return Boolean(sp && sp.end - sp.start >= 2);
        });
        if (!defs.length) return [];
    }
    const compound = isCompoundId(id.name) || Boolean(id.owner || qualMatched || defs.length === 1 && id.qual);
    if (defs.length > 1) {
        defs = disambiguateOverloadedDefs(graph, defs, fileNamedInPrompt, topHints, hints, compound);
        return defs.length > 0 && defs.length <= 2 ? defs : [];
    }
    if (hasHintFiles) {
        const n = defs[0];
        const allowedHints = compound ? hints : topHints;
        if (!fileNamedInPrompt(n.path, n) && !allowedHints.has(n.path)) return [];
    }
    return defs;
}

function orderResolvedPins(kept, maxPins) {
    const ordered = [];
    const deferred = [];
    const seenPinFiles = new Set();
    for (const p of kept) {
        if (!seenPinFiles.has(p.node.path) || p.strength >= 2) {
            seenPinFiles.add(p.node.path);
            ordered.push(p);
        } else {
            deferred.push(p);
        }
    }
    return [...ordered, ...deferred].slice(0, maxPins);
}

/**
 * Resolve named identifiers to definition nodes.
 * @returns {{node: object, name: string, strength: number, a: number, b: number}[]}
 */
export function resolveNamedDefinitions(graph, prompt, { maxPins = 3, hintFiles = [] } = {}) {
    if (!graph?.nodes?.length) return [];
    const ids = namedIdentifiers(prompt);
    if (!ids.length) return [];
    const byBare = getByBareNameIndex(graph);
    const promptText = String(prompt);
    const hints = new Set(hintFiles);
    const topHints = new Set(hintFiles.slice(0, 2));
    const fileNamedInPrompt = (p) => {
        const base = basename(p);
        const stem = base.replace(/\.[a-z0-9]+$/i, '');
        return promptText.includes(p) || promptText.includes(base) || (stem.length >= 8 && isCompoundId(stem) && promptText.includes(stem));
    };
    const out = [];
    const seenSpan = new Set();
    for (const id of ids) {
        const defs = narrowPinDefsForId(id, byBare, graph, fileNamedInPrompt, topHints, hints, hintFiles.length > 0);
        for (const node of defs) {
            const sp = spanRange(node.span);
            const maxSpanLines = (node.kind === 'function' || node.kind === 'method') ? 260 : MAX_PIN_LINES;
            if (!sp || sp.end - sp.start > maxSpanLines) continue;
            const key = `${node.path}:${sp.start}`;
            if (seenSpan.has(key)) continue;
            seenSpan.add(key);
            out.push({ node, name: id.name, owner: id.owner, qual: id.qual, strength: id.strength, order: id.order, a: sp.start, b: sp.end });
        }
    }
    return orderResolvedPins(pruneOverlappingPinContainers(out, hints), maxPins);
}

function appendCrossFileCallersForPin(root, pinNode, crossFileCallers, fileCache, seenDelegators, pinnedFileSet, code, used, budgetBytes, geminiProfile = false, narrowPrompt = false) {
    if ((geminiProfile && narrowPrompt) || crossFileCallers.length < 1 || (!geminiProfile && crossFileCallers.length > 3) || !pinNode.name || pinNode.name.length < 3) {
        return { code, used };
    }
    if (geminiProfile && crossFileCallers.length > 3 && GENERIC_MEMBER_NAMES.has(pinNode.name.toLowerCase())) {
        return { code, used };
    }
    const MAX_CALLER_INLINE_BYTES = geminiProfile ? 750 : Infinity;
    let addedCallerBytes = 0;
    let addedCallers = 0;
    const escaped = pinNode.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callRe = new RegExp(`\\b${escaped}\\b`);
    for (const sn of crossFileCallers) {
        if (geminiProfile && addedCallers >= 2) break;
        if (pinnedFileSet?.has(sn.path) || seenDelegators.has(sn.path)) continue;
        const dsp = spanRange(sn.span);
        if (!dsp) continue;
        try {
            let dLines = fileCache.get(sn.path);
            if (!dLines) {
                dLines = readFileSync(join(root, sn.path), 'utf8').split('\n');
                fileCache.set(sn.path, dLines);
            }
            let callLine = dsp.start;
            for (let ln = dsp.start; ln <= Math.min(dsp.end, dLines.length); ln++) {
                const txt = (dLines[ln - 1] ?? '').trim();
                if (!txt.startsWith('//') && !txt.startsWith('#') && !txt.startsWith('--') && callRe.test(txt)) {
                    callLine = ln;
                    break;
                }
            }
            const cStart = dsp.end - dsp.start <= 12 ? dsp.start : Math.max(dsp.start, callLine - 4);
            const cEnd = dsp.end - dsp.start <= 12 ? Math.min(dLines.length, dsp.end) : Math.min(dLines.length, dsp.end, callLine + 4);
            const cBody = dLines.slice(cStart - 1, cEnd).map((l, i) => fmtLine(cStart + i, l)).join('\n');
            const cBlock = `\n\n// caller in ${sn.path}:L${cStart}-L${cEnd}\n${cBody}`;
            const cBytes = Buffer.byteLength(cBlock, 'utf8');
            if (used + cBytes <= budgetBytes && addedCallerBytes + cBytes <= MAX_CALLER_INLINE_BYTES) {
                seenDelegators.add(sn.path);
                code += cBlock;
                used += cBytes;
                addedCallerBytes += cBytes;
                addedCallers++;
            }
        } catch {
            // ignore
        }
    }
    return { code, used };
}

const PIN_CONTRACT_OUT_RELS = new Set(['implements', 'extends', 'types']);
const PIN_CALL_OUT_RELS = new Set(['calls', 'interface_dispatch', 'references']);
const PIN_IN_RELS = new Set(['calls', 'interface_dispatch', 'imports', 'implements', 'extends', 'types', 'references']);
const PIN_CTOR_KINDS = new Set(['struct', 'type', 'class', 'interface', 'trait']);

function readCachedPinFileLines(root, relPath, fileCache) {
    let lines = fileCache.get(relPath);
    if (!lines) {
        lines = readFileSync(join(root, relPath), 'utf8').split('\n');
        fileCache.set(relPath, lines);
    }
    return lines;
}

function addUniquePinRelation(related, seenRel, label, maxRel = 6) {
    if (related.length >= maxRel || seenRel.has(label)) return;
    seenRel.add(label);
    related.push(label);
}

function collectOutgoingPinRelations(outList, byId, related, seenRel) {
    const ordered = [
        ...outList.filter((e) => PIN_CONTRACT_OUT_RELS.has(e.relation)),
        ...outList.filter((e) => PIN_CALL_OUT_RELS.has(e.relation)),
    ];
    for (const e of ordered) {
        if (related.length >= 6) break;
        const tn = byId.get(e.target);
        if (tn?.path && tn?.span && tn.kind !== 'file') {
            addUniquePinRelation(related, seenRel, `→ ${tn.name} (${tn.path}:${tn.span})`);
        }
    }
}

function tryInlinePinDelegator(root, pinNode, sn, fileCache, seenDelegators, code, used, budgetBytes) {
    if (sn.name !== pinNode.name || sn.path === pinNode.path || seenDelegators.has(sn.path)) {
        return { code, used };
    }
    const dsp = spanRange(sn.span);
    if (!dsp || dsp.end - dsp.start > 10 || code.includes(`// delegator in ${sn.path}:`)) {
        return { code, used };
    }
    try {
        const dLines = readCachedPinFileLines(root, sn.path, fileCache);
        const dStart = Math.max(1, dsp.start - 3);
        const dEnd = Math.min(dLines.length, dsp.end + 4);
        const dBody = dLines.slice(dStart - 1, dEnd).map((l, i) => fmtLine(dStart + i, l)).join('\n');
        const dBlock = `\n\n// delegator in ${sn.path}:L${dStart}-L${dEnd}\n${dBody}`;
        const dBytes = Buffer.byteLength(dBlock, 'utf8');
        if (used + dBytes <= budgetBytes) {
            seenDelegators.add(sn.path);
            return { code: code + dBlock, used: used + dBytes };
        }
    } catch {
        // ignore unreadable delegator file
    }
    return { code, used };
}

function collectIncomingPinRelations(root, pinNode, inList, byId, fileCache, seenDelegators, related, seenRel, code, used, budgetBytes) {
    const crossFileCallers = [];
    for (const e of inList) {
        if (!PIN_IN_RELS.has(e.relation)) continue;
        const sn = byId.get(e.source);
        if (!sn?.path) continue;
        if (sn.kind === 'file') {
            addUniquePinRelation(related, seenRel, `← ${sn.path}`);
            continue;
        }
        if (!sn.span) continue;
        addUniquePinRelation(related, seenRel, `← ${sn.name} (${sn.path}:${sn.span})`);
        if ((e.relation === 'calls' || e.relation === 'interface_dispatch' || (e.relation === 'references' && pinNode.kind === 'field')) && sn.path !== pinNode.path && !isTestPath(sn.path)) {
            crossFileCallers.push(sn);
        }
        const delRes = tryInlinePinDelegator(root, pinNode, sn, fileCache, seenDelegators, code, used, budgetBytes);
        code = delRes.code;
        used = delRes.used;
    }
    return { crossFileCallers, code, used };
}

function appendCompactCalleesForPin(root, pinNode, pBounds, outList, byId, fileCache, pinnedFileSet, seenDelegators, code, used, budgetBytes, { fastProfile = false, narrowPrompt = false } = {}) {
    if (fastProfile || narrowPrompt) return { code, used };
    const MAX_CALLEE_INLINE_BYTES = 650;
    let addedBytes = 0;
    let addedCount = 0;
    const seenIds = new Set();
    for (const e of outList) {
        if (addedCount >= 1 || addedBytes >= MAX_CALLEE_INLINE_BYTES) break;
        if (e.relation !== 'calls' && e.relation !== 'interface_dispatch') continue;
        const tn = byId.get(e.target);
        if (!tn?.path || !tn?.span || tn.kind === 'file' || seenIds.has(tn.id) || isTestPath(tn.path)) continue;
        seenIds.add(tn.id);
        const sp = spanRange(tn.span);
        if (!sp) continue;
        const spanLines = sp.end - sp.start + 1;
        if (spanLines <= 3) continue;
        const isSameFile = tn.path === pinNode.path;
        if (isSameFile) {
            if (sp.start <= pBounds.b && pBounds.a <= sp.end) continue;
            if (spanLines > 35 || hasInlinedLine(code, sp.start)) continue;
        } else {
            if (pinnedFileSet?.has(tn.path) || seenDelegators.has(tn.path)) continue;
            if (spanLines > 36 || code.includes(`// cross-file callee:`) && code.includes(`(${tn.path}:L${sp.start}`)) continue;
        }
        try {
            const cLines = readCachedPinFileLines(root, tn.path, fileCache);
            const cEnd = Math.min(cLines.length, sp.end);
            if (sp.start > cEnd) continue;
            const label = isSameFile ? 'same-file helper' : 'cross-file callee';
            const body = cLines.slice(sp.start - 1, cEnd).map((l, i) => fmtLine(sp.start + i, l)).join('\n');
            const cBlock = `\n\n// ${label}: ${tn.name} (${tn.path}:L${sp.start}-L${cEnd})\n${body}`;
            const bLen = Buffer.byteLength(cBlock, 'utf8');
            if (addedBytes + bLen <= MAX_CALLEE_INLINE_BYTES && used + bLen <= budgetBytes) {
                code += cBlock;
                used += bLen;
                addedBytes += bLen;
                addedCount++;
                if (!isSameFile) seenDelegators.add(tn.path);
            }
        } catch {
            // ignore unreadable callee
        }
    }
    return { code, used };
}

function collectPinRelationsAndDelegators(root, pinNode, pBounds, graph, byId, fileCache, seenDelegators, pinnedFileSet, code, used, budgetBytes, geminiProfile = false, { fastProfile = false, narrowPrompt = false } = {}) {
    const related = [];
    const seenRel = new Set();
    const outList = graph?._outEdges ? (graph._outEdges.get(pinNode.id) ?? []) : (graph?.edges ?? []).filter((e) => e.source === pinNode.id);
    const inList = graph?._inEdges ? (graph._inEdges.get(pinNode.id) ?? []) : (graph?.edges ?? []).filter((e) => e.target === pinNode.id);
    collectOutgoingPinRelations(outList, byId, related, seenRel);
    const inRes = collectIncomingPinRelations(root, pinNode, inList, byId, fileCache, seenDelegators, related, seenRel, code, used, budgetBytes);
    const callerRes = appendCrossFileCallersForPin(root, pinNode, inRes.crossFileCallers, fileCache, seenDelegators, pinnedFileSet, inRes.code, inRes.used, budgetBytes, geminiProfile, narrowPrompt);
    const calleeRes = geminiProfile
        ? appendCompactCalleesForPin(root, pinNode, pBounds, outList, byId, fileCache, pinnedFileSet, seenDelegators, callerRes.code, callerRes.used, budgetBytes, { fastProfile, narrowPrompt })
        : callerRes;
    return { related, code: calleeRes.code, used: calleeRes.used };
}

function findConstructorSiteBounds(lines, idx) {
    const lineNo = idx + 1;
    let sStart = lineNo;
    for (let b = idx - 1; b >= Math.max(0, idx - 4); b--) {
        if (/^\s*(?:export\s+|local\s+|pub\s+)?(?:async\s+)?(?:func|def|function|fn)\b/.test(lines[b] ?? '')) {
            sStart = b + 1;
            break;
        }
    }
    const cur = lines[idx] ?? '';
    const unclosedBrace = cur.includes('{') && !cur.includes('}');
    const unclosedParen = !unclosedBrace && cur.includes('(') && !cur.includes(')');
    let sEnd = Math.min(lines.length, lineNo + (unclosedBrace || unclosedParen ? 5 : 2));
    if (unclosedBrace || unclosedParen) {
        const closeRe = unclosedBrace ? /^\s*\}/ : /\)|^\s*end\b/;
        for (let f = idx + 1; f < Math.min(lines.length, idx + 10); f++) {
            if (closeRe.test(lines[f] ?? '')) {
                sEnd = f + 1;
                if (f + 1 < lines.length && /^\s*(?:\}|end)\s*$/.test(lines[f + 1] ?? ''))
                    sEnd = f + 2;
                break;
            }
        }
    }
    return { sStart, sEnd };
}

function appendPinStructLiteralSites(p, lines, code, used, budgetBytes) {
    const spanLines = p.b - p.a + 1;
    const maxKindLines = p.node.kind === 'class' || p.node.kind === 'interface' ? 25 : 15;
    if (!PIN_CTOR_KINDS.has(p.node.kind) || spanLines > maxKindLines || !p.node.name || p.node.name.length < 3)
        return { code, used };
    const escaped = p.node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const litRe = new RegExp(`\\b${escaped}\\s*\\{|\\bnew\\s+${escaped}\\s*\\(|\\b${escaped}\\.new\\s*\\(`);
    const declRe = /^\s*(?:export\s+|pub\s+|abstract\s+)?(?:class|interface|struct|type|enum|trait)\s+/;
    const blocks = [];
    let lastEnd = 0;
    for (let idx = 0; idx < lines.length && blocks.length < 6; idx++) {
        const lineNo = idx + 1;
        const rawLine = lines[idx] ?? '';
        if ((lineNo >= p.a && lineNo <= p.b) || lineNo <= lastEnd || declRe.test(rawLine) || !litRe.test(rawLine))
            continue;
        const { sStart, sEnd } = findConstructorSiteBounds(lines, idx);
        lastEnd = sEnd;
        const slice = lines.slice(sStart - 1, sEnd).map((l, i) => fmtLine(sStart + i, l)).join('\n');
        blocks.push(`// constructor in ${p.node.path}:L${sStart}-L${sEnd}\n${slice}`);
    }
    for (const blk of blocks) {
        const fullBlk = `\n\n${blk}`;
        const bLen = Buffer.byteLength(fullBlk, 'utf8');
        if (used + bLen > budgetBytes)
            break;
        code += fullBlk;
        used += bLen;
    }
    return { code, used };
}

function matchModuleConstantLine(raw) {
    const decl = /^\s*(?:export\s+)?(?:local\s+|pub(?:\([^)]*\))?\s+)?(?:const|let|var|static|final)\s+([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*|[A-Z][A-Z0-9_]{2,})\b[^=]*=/.exec(raw);
    if (decl) return decl[1];
    const bareUpper = /^\s*([A-Z][A-Z0-9_]{2,})\s*(?::\s*[^=]+)?=[^=]/.exec(raw);
    return bareUpper ? bareUpper[1] : null;
}

function collectPinnedModuleConstants(lines, start, end, graph, promptIds) {
    if (start <= 1) return [];
    const promptSet = new Set(promptIds);
    const bodyText = lines.slice(start - 1, Math.min(end, lines.length)).join('\n');
    const byBare = getByBareNameIndex(graph);
    const direct = [];
    const referenced = [];
    for (let ln = 1; ln < start; ln++) {
        const raw = lines[ln - 1] ?? '';
        const constName = matchModuleConstantLine(raw);
        if (!constName || byBare.has(constName)) continue;
        if (promptSet.has(constName)) {
            direct.push(fmtLine(ln, raw));
        } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(constName) && bodyText.includes(constName)) {
            referenced.push(fmtLine(ln, raw));
        }
    }
    return [...direct, ...referenced].slice(0, 3);
}

function tryAppendPinTailWindow(p, lines, promptIds, start, end, maxLinesPerPin, body) {
    const spanLines = p.b - p.a + 1;
    if (end >= p.b || spanLines < 55 || spanLines > 260 || promptIds.length === 0) return false;
    const matchLines = [];
    for (let ln = end + 1; ln <= Math.min(p.b, lines.length); ln++) {
        const raw = lines[ln - 1] ?? '';
        if (promptIds.some((id) => id !== p.name && raw.includes(id))) matchLines.push(ln);
    }
    if (!matchLines.length) return false;
    const firstM = matchLines[0];
    const lastM = matchLines[matchLines.length - 1];
    const tStart = Math.max(start + 12, firstM - 6);
    const tEnd = Math.min(p.b, lines.length, Math.max(lastM + 8, tStart + 20), tStart + 25);
    const hEnd = Math.max(start + 11, Math.min(tStart - 1, start + maxLinesPerPin - (tEnd - tStart + 1) - 1));
    if (hEnd >= tStart) return false;
    for (let ln = start; ln <= hEnd; ln++) body.push(fmtLine(ln, lines[ln - 1]));
    if (tStart > hEnd + 1) body.push(`  … (lines L${hEnd + 1}-L${tStart - 1} omitted)`);
    for (let ln = tStart; ln <= tEnd; ln++) body.push(fmtLine(ln, lines[ln - 1]));
    if (tEnd < p.b) body.push(`… (+${p.b - tEnd} more lines; open ${p.node.path}:L${tEnd + 1}-L${p.b})`);
    return true;
}

function buildPinnedBodyLines(p, lines, graph, promptIds, start, end, maxLinesPerPin, contiguous = false) {
    const consts = collectPinnedModuleConstants(lines, start, end, graph, promptIds);
    const body = consts.length > 0 ? [`// constants in ${p.node.path}:`, ...consts] : [];
    const spanLines = p.b - p.a + 1;
    if ((contiguous && spanLines <= 85) || !tryAppendPinTailWindow(p, lines, promptIds, start, end, maxLinesPerPin, body)) {
        for (let ln = start; ln <= end; ln++) body.push(fmtLine(ln, lines[ln - 1]));
        if (end < p.b) body.push(`… (+${p.b - end} more lines; open ${p.node.path}:L${end + 1}-L${p.b})`);
    }
    return body;
}

/**
 * Turn pinned definitions into hook hits with inlined `L<n>:` bodies, within `budgetBytes`.
 * Long bodies are cut at `MAX_PIN_LINES` with an explicit continuation pointer.
 */
export function pinnedHits(root, graph, prompt, { budgetBytes = 4000, maxPins = 3, hintFiles = [], geminiProfile = false, fastProfile = false, narrowPrompt = false, contiguous = false } = {}) {
    const pins = resolveNamedDefinitions(graph, prompt, { maxPins, hintFiles });
    const upperConstants = [...String(prompt ?? '').matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((m) => m[0]);
    const promptIds = [...new Set([...namedIdentifiers(prompt).map((x) => x.name).filter((n) => n.length >= 4), ...upperConstants])];
    const hits = [];
    let used = 0;
    const fileCache = new Map();
    const seenDelegators = new Set();
    const pinnedFileSet = new Set(pins.map((p) => p.node.path));
    const byId = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const inlinedPinFiles = new Set();
    for (let idx = 0; idx < pins.length; idx++) {
        const p = pins[idx];
        const spanLines = p.b - p.a + 1;
        let lines = fileCache.get(p.node.path);
        if (!lines) {
            try {
                lines = readFileSync(join(root, p.node.path), 'utf8').split('\n');
            }
            catch {
                continue;
            }
            fileCache.set(p.node.path, lines);
        }
        const isWholeShortFile = p.a > 1 && p.a <= 25 && lines.length <= 66 && p.b >= lines.length - 2;
        const maxLinesPerPin = isWholeShortFile ? 66 : spanLines > MAX_PIN_LINES ? 35 : (spanLines > 60 ? 44 : (pins.length >= 2 ? 54 : MAX_PIN_LINES));
        let start = p.a;
        const prevSameFile = pins.find((q) => q !== p && q.node.path === p.node.path && q.b < p.a && p.a - q.b <= 6);
        if (prevSameFile) {
            start = prevSameFile.b + 1;
        }
        else if (
            (isWholeShortFile || (p.a > 1 && p.a <= 25 && p.b <= 54)) &&
            lines.slice(0, p.a - 1).some((l) => /^\s*(?:import|from|package|use|const\s+.*=\s*require|#include)\b/.test(l))
        ) {
            start = 1;
        }
        let end = Math.min(p.b, start + maxLinesPerPin - 1, lines.length);
        if (p.b - end <= 8) end = Math.min(p.b, lines.length);
        const body = buildPinnedBodyLines(p, lines, graph, promptIds, start, end, maxLinesPerPin, contiguous);
        const remainingDistinct = new Set(pins.slice(idx).map((q) => q.node.path).filter((f) => !inlinedPinFiles.has(f))).size;
        const rawRoom = budgetBytes - used;
        const pinCap = remainingDistinct > 1 ? Math.min(rawRoom, Math.max(950, Math.floor(rawRoom / remainingDistinct))) : rawRoom;
        let code = body.join('\n');
        let bytes = Buffer.byteLength(code, 'utf8');
        let skipCode = false;
        if (bytes > pinCap) {
            if (pinCap < 280) {
                skipCode = true;
                code = undefined;
                bytes = 0;
            } else {
                const keep = [];
                let b = 0;
                for (const l of body) {
                    const lb = Buffer.byteLength(l, 'utf8') + 1;
                    if (b + lb > pinCap - 80) break;
                    keep.push(l);
                    b += lb;
                }
                if (keep.length < Math.min(4, body.length) || (body.length > 35 && keep.length < Math.min(10, Math.ceil(body.length * 0.20)))) {
                    skipCode = true;
                    code = undefined;
                    bytes = 0;
                } else {
                    const lastMatch = keep.findLast((l) => LINE_PREFIX_RE.test(l));
                    const lastLine = lastMatch ? Number(LINE_PREFIX_RE.exec(lastMatch)[1]) : start + keep.length - 1;
                    if (lastLine < p.b) keep.push(`… (+${p.b - lastLine} more lines; open ${p.node.path}:L${lastLine + 1}-L${p.b})`);
                    code = keep.join('\n');
                    bytes = Buffer.byteLength(code, 'utf8');
                }
            }
        }
        used += bytes;
        inlinedPinFiles.add(p.node.path);
        const relRes = !skipCode && code
            ? collectPinRelationsAndDelegators(root, p.node, p, graph, byId, fileCache, seenDelegators, pinnedFileSet, code, used, budgetBytes, geminiProfile, { fastProfile, narrowPrompt })
            : { code, used, related: [] };
        code = relRes.code;
        used = relRes.used;
        if (!skipCode && code) {
            const litRes = appendPinStructLiteralSites(p, lines, code, used, budgetBytes);
            code = litRes.code;
            used = litRes.used;
        }
        hits.push({
            kind: 'symbol',
            title: `${p.node.name} · ${p.node.kind} (named in prompt)`,
            pointer: `${p.node.path}:L${p.a}-L${p.b}`,
            snippet: p.node.signature ?? '',
            score: 1,
            ...(code ? { code } : {}),
            pinned: true,
            related: relRes.related.length > 0 ? relRes.related : undefined,
            a: p.a,
            b: p.b,
        });
    }
    return hits;
}

/** True when pointer `p`'s span fully contains pointer `q`'s (same file). */
export function pointerCovers(p, q) {
    const pm = /^(.*):L(\d+)(?:-L(\d+))?/.exec(p ?? '');
    const qm = /^(.*):L(\d+)(?:-L(\d+))?/.exec(q ?? '');
    if (!pm || !qm || pm[1] !== qm[1]) return false;
    return Number(pm[2]) <= Number(qm[2]) && Number(qm[3] ?? qm[2]) <= Number(pm[3] ?? pm[2]);
}
/** True when two `file:La-Lb` pointers overlap. */
export function pointersOverlap(p, q) {
    const pm = /^(.*):L(\d+)(?:-L(\d+))?/.exec(p ?? '');
    const qm = /^(.*):L(\d+)(?:-L(\d+))?/.exec(q ?? '');
    if (!pm || !qm || pm[1] !== qm[1]) return false;
    const [pa, pb] = [Number(pm[2]), Number(pm[3] ?? pm[2])];
    const [qa, qb] = [Number(qm[2]), Number(qm[3] ?? qm[2])];
    return pa <= qb && qa <= pb;
}
