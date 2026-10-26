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
import { isGeneratedPath, isTestPath } from '../ask/ask.js';

const DEF_KINDS = new Set(['function', 'method', 'class', 'type', 'interface', 'struct', 'enum', 'trait', 'impl', 'variable', 'const', 'constant', 'field']);
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

/** Identifiers the prompt names as code, in order of first appearance, with mention counts. */
export function namedIdentifiers(prompt) {
    const text = String(prompt ?? '')
        .replace(/^Working directory:.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '');
    const found = new Map();
    const add = (name, strength, owner = null) => {
        if (!name || (name.length < 4 && !owner) || STOP.has(name.toLowerCase()) || /^\d/.test(name)) return;
        const key = owner ? `${owner}#${name}` : name;
        const e = found.get(key) ?? { name, owner, strength: 0, order: found.size };
        e.strength += strength;
        found.set(key, e);
    };
    for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`\s+in\s+`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
        add(m[1], 3, m[2]);
    }
    // Backticked code spans: skip paths/URLs/flags, and skip lowercase namespace prefixes (`user.email.fn` -> `fn`).
    for (const m of text.matchAll(/`([^`\n]{1,160})`/g)) {
        const span = m[1].trim();
        if (span.includes('/') || span.includes('@') || /^[\w.-]+\.[a-z]{1,5}$/i.test(span)) continue;
        if (/^--?[\w-]+$/.test(span) || /^plexer\s+/i.test(span)) continue;
        for (const id of span.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
            const idx = id.index ?? 0;
            const after = span.slice(idx + id[0].length);
            if (/^[.:][A-Za-z_]/.test(after) && !/^[A-Z]/.test(id[0])) continue; // lowercase receiver prefix
            add(id[0], /^\s*\(/.test(after) ? 2 : 1);
        }
    }
    // Call syntax in prose without whitespace before `(` (`helper()`, `GetEvaluationRollouts(ctx)`), never English `word (`.
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
        const idx = m.index ?? 0;
        const after = text.slice(idx + m[0].length - 1);
        if (idx > 0 && /[/:]/.test(text[idx - 1])) continue;
        add(m[1], /^\([^)\n]{0,80}\)/.test(after) ? 1 : 0);
    }
    return [...found.values()].filter((x) => x.strength > 0);
}

function parseSpan(span) {
    const m = /^L(\d+)(?:-L(\d+))?$/.exec(span ?? '');
    return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/**
 * Resolve named identifiers to definition nodes.
 * @returns {{node: object, name: string, strength: number, a: number, b: number}[]}
 */
export function resolveNamedDefinitions(graph, prompt, { maxPins = 3, hintFiles = [] } = {}) {
    if (!graph?.nodes?.length) return [];
    const ids = namedIdentifiers(prompt);
    if (!ids.length) return [];
    const byBare = graph._byBareName ?? (graph._byBareName = (() => {
        const m = new Map();
        for (const n of graph.nodes) {
            if (!n.path || !DEF_KINDS.has(n.kind) || isTestPath(n.path) || isGeneratedPath(n.path)) continue;
            const sp = parseSpan(n.span);
            if (!sp || (VALUE_KINDS.has(n.kind) && sp[1] - sp[0] < 2)) continue;
            const bare = String(n.name ?? '').split(/[.:#]/).pop();
            if (!bare) continue;
            (m.get(bare) ?? m.set(bare, []).get(bare)).push(n);
        }
        return m;
    })());
    const promptText = String(prompt);
    const hints = new Set(hintFiles);
    const topHints = new Set(hintFiles.slice(0, 2));
    const cliMentioned = /\bCLI\b/i.test(promptText);
    const fileNamedInPrompt = (p, node) => {
        if (cliMentioned && node?.owner === 'Command') return true;
        const base = basename(p);
        const stem = base.replace(/\.[a-z0-9]+$/i, '');
        return promptText.includes(p) || promptText.includes(base) || (stem.length >= 8 && isCompoundId(stem) && promptText.includes(stem));
    };
    const out = [];
    const seenSpan = new Set();
    for (const id of ids) {
        let defs = byBare.get(id.name) ?? [];
        if (id.owner) defs = defs.filter((n) => n.owner === id.owner);
        if (!defs.length) continue;
        const compound = isCompoundId(id.name) || Boolean(id.owner);
        if (defs.length > 1) {
            // An overloaded name is only pinned where the prompt names its file or ranked
            // retrieval already landed in that file.
            const strongDefs = defs.filter((n) => fileNamedInPrompt(n.path, n) || topHints.has(n.path));
            defs = strongDefs.length > 0 ? strongDefs : defs.filter((n) => compound && defs.length <= 2 && hints.has(n.path));
            if (!defs.length || defs.length > 2) continue;
        } else if (hintFiles.length > 0) {
            const n = defs[0];
            if (!compound && !fileNamedInPrompt(n.path, n) && !topHints.has(n.path)) continue;
            if (compound && !fileNamedInPrompt(n.path, n) && !hints.has(n.path)) continue;
        }
        for (const node of defs) {
            const sp = parseSpan(node.span);
            const maxSpanLines = (node.kind === 'function' || node.kind === 'method') ? 260 : MAX_PIN_LINES;
            if (!sp || sp[1] - sp[0] > maxSpanLines) continue;
            const key = `${node.path}:${sp[0]}`;
            if (seenSpan.has(key)) continue;
            seenSpan.add(key);
            out.push({ node, name: id.name, owner: id.owner, strength: id.strength, order: id.order, a: sp[0], b: sp[1] });
        }
    }
    const droppedOwners = new Set();
    for (const p of out) {
        if (!p.owner) continue;
        const container = out.find((q) => q !== p && q.node.path === p.node.path && q.node.name === p.owner && (q.node.kind === 'struct' || q.node.kind === 'class'));
        if (container) {
            droppedOwners.add(container);
            if (p.a > container.b && p.a - container.b <= 30 && p.b - p.a <= 12) {
                p.a = Math.max(1, container.b - 1);
            } else if (p.a > container.b && p.a - container.b <= 30 && container.b - container.a <= 25) {
                p.a = container.a;
            }
        }
    }
    // Drop definitions nested inside another pinned definition (the outer body covers them).
    const kept = out.filter((p) => !droppedOwners.has(p) && !out.some((q) => q !== p && !droppedOwners.has(q) && q.node.path === p.node.path && q.a <= p.a && p.b <= q.b && q.b - q.a <= MAX_PIN_LINES));
    const inHint = (p) => (hints.has(p.node.path) ? 1 : 0);
    kept.sort((x, y) => y.strength - x.strength || inHint(y) - inHint(x) || x.order - y.order);
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
 * Turn pinned definitions into hook hits with inlined `L<n>:` bodies, within `budgetBytes`.
 * Long bodies are cut at `MAX_PIN_LINES` with an explicit continuation pointer.
 */
export function pinnedHits(root, graph, prompt, { budgetBytes = 4000, maxPins = 3, hintFiles = [] } = {}) {
    const pins = resolveNamedDefinitions(graph, prompt, { maxPins, hintFiles });
    const hits = [];
    let used = 0;
    const fileCache = new Map();
    const byId = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    for (const p of pins) {
        const maxLinesPerPin = p.b - p.a > MAX_PIN_LINES ? 35 : (pins.length >= 2 ? 48 : MAX_PIN_LINES);
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
        let start = p.a;
        const prevSameFile = pins.find((q) => q !== p && q.node.path === p.node.path && q.b < p.a && p.a - q.b <= 6);
        if (prevSameFile) {
            start = prevSameFile.b + 1;
        }
        let end = Math.min(p.b, start + maxLinesPerPin - 1, lines.length);
        if (p.b - end <= 8) end = Math.min(p.b, lines.length);
        let body = lines.slice(start - 1, end).map((l, i) => `L${start + i}: ${l}`);
        if (end < p.b) body.push(`… (+${p.b - end} more lines; open ${p.node.path}:L${end + 1}-L${p.b})`);
        let code = body.join('\n');
        let bytes = Buffer.byteLength(code, 'utf8');
        if (used + bytes > budgetBytes) {
            // Keep as much of the head as fits; a signature-only pin still saves a search.
            const room = budgetBytes - used;
            if (room < 300) break;
            const keep = [];
            let b = 0;
            for (const l of body) {
                const lb = Buffer.byteLength(l, 'utf8') + 1;
                if (b + lb > room - 80) break;
                keep.push(l);
                b += lb;
            }
            const lastLine = p.a + keep.length - 1;
            keep.push(`… (+${p.b - lastLine} more lines; open ${p.node.path}:L${lastLine + 1}-L${p.b})`);
            code = keep.join('\n');
            bytes = Buffer.byteLength(code, 'utf8');
        }
        used += bytes;
        const related = [];
        const seenRel = new Set();
        for (const e of graph?.edges ?? []) {
            if (related.length >= 6) break;
            if (e.source === p.node.id && e.relation === 'calls') {
                const tn = byId.get(e.target);
                if (tn?.path && tn?.span && tn.kind !== 'file') {
                    const lbl = `→ ${tn.name} (${tn.path}:${tn.span})`;
                    if (!seenRel.has(lbl)) { seenRel.add(lbl); related.push(lbl); }
                }
            } else if (e.target === p.node.id && (e.relation === 'calls' || e.relation === 'imports')) {
                const sn = byId.get(e.source);
                if (sn?.path && sn?.span && sn.kind !== 'file') {
                    const lbl = `← ${sn.name} (${sn.path}:${sn.span})`;
                    if (!seenRel.has(lbl)) { seenRel.add(lbl); related.push(lbl); }
                    const dsp = sn.name === p.node.name && sn.path !== p.node.path ? parseSpan(sn.span) : null;
                    if (dsp && dsp[1] - dsp[0] <= 10 && !code.includes(`// delegator in ${sn.path}:`)) {
                        try {
                            let dLines = fileCache.get(sn.path);
                            if (!dLines) {
                                dLines = readFileSync(join(root, sn.path), 'utf8').split('\n');
                                fileCache.set(sn.path, dLines);
                            }
                            const dStart = Math.max(1, dsp[0] - 3);
                            const dEnd = Math.min(dLines.length, dsp[1] + 3);
                            const dBody = dLines.slice(dStart - 1, dEnd).map((l, i) => `L${dStart + i}: ${l}`).join('\n');
                            const dBlock = `\n\n// delegator in ${sn.path}:L${dStart}-L${dEnd}\n${dBody}`;
                            const dBytes = Buffer.byteLength(dBlock, 'utf8');
                            if (used + dBytes <= budgetBytes) {
                                code += dBlock;
                                used += dBytes;
                            }
                        } catch {
                            // ignore
                        }
                    }
                } else if (sn?.path && sn.kind === 'file') {
                    const lbl = `← ${sn.path}`;
                    if (!seenRel.has(lbl)) { seenRel.add(lbl); related.push(lbl); }
                }
            }
        }
        hits.push({
            kind: 'symbol',
            title: `${p.node.name} · ${p.node.kind} (named in prompt)`,
            pointer: `${p.node.path}:L${p.a}-L${p.b}`,
            snippet: p.node.signature ?? '',
            score: 1,
            code,
            pinned: true,
            related: related.length > 0 ? related : undefined,
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
