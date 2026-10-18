/**
 * CLI wiring for `plexer callers` and its `--direction` / `--depth` flags.
 */
import { resolve } from "node:path";
import { fileReader, referenceLines, spanRange, wordRe } from "../blast/evidence.js";
import { isTestPath } from "../ask/ask.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "./load.js";
import { resolveSymbol, edgeWalk, parseWalkDepth } from "./traverse.js";

const ARROW = { in: "←", out: "→" };
const DEFAULT_DEPTH = 1;
const MAX_SUBJECT_SOURCE_LINES = 50;
const MAX_SHORT_CALLER_LINES = 30;
const MAX_SOURCE_CALLERS = 12;

export function headerOf(n) {
    if (!n.span)
        return `${n.name} · ${n.kind}`;
    return `${n.name} · ${n.kind} · ${n.path}:${n.span}`;
}

function needlesForName(name) {
    if (!name)
        return [];
    const out = [wordRe(name)];
    const sep = Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), name.lastIndexOf("#"));
    if (sep >= 0 && sep + 1 < name.length) {
        const bare = name.slice(sep + 1);
        if (bare.length >= 2)
            out.push(wordRe(bare));
    }
    return out;
}

export function hitLine(direction, hit, showDepth, quote, opts = {}) {
    const arrow = ARROW[direction];
    const viaName = hit.via && hit.via.kind !== "file" && (hit.depth > 1 || opts.rootIsFile)
        ? hit.via.name
        : null;
    const depthTag = showDepth
        ? ` [depth ${hit.depth}${viaName ? ` via ${viaName}` : ""}]`
        : viaName
            ? ` [via ${viaName}]`
            : "";
    const label = hit.node ? `${hit.node.name} (${hit.node.path}:${hit.node.span})` : `${hit.id} (unresolved import)`;
    const line = `  ${hit.relation} ${arrow} ${label}${depthTag}`;
    if (!quote)
        return line;
    const quotes = Array.isArray(quote) ? quote : [quote];
    if (quotes.length === 0)
        return line;
    const formatted = [];
    for (const q of quotes) {
        if (!q)
            continue;
        if (Array.isArray(q.window) && q.window.length > 0) {
            for (const w of q.window) {
                formatted.push(
                    w.n > 0
                        ? `      L${w.n}: ${w.text.trimEnd()}`
                        : `      ${w.text}`,
                );
            }
        }
        else if (typeof q.n === "number" && typeof q.text === "string") {
            formatted.push(`      ${q.n}: ${q.text.trim()}`);
        }
    }
    return formatted.length > 0 ? `${line}\n${formatted.join("\n")}` : line;
}

export function quoteFor(hit, needles, read, opts = {}) {
    if (!hit.node)
        return undefined;
    const excludeRanges = [...(opts.excludeRanges ?? [])];
    if (hit.via && hit.via.kind !== "file" && hit.node.path === hit.via.path && hit.node.id !== hit.via.id) {
        const vr = spanRange(hit.via.span);
        if (vr)
            excludeRanges.push(vr);
    }
    if (opts.symbol && opts.symbol.kind !== "file" && hit.node.path === opts.symbol.path && hit.node.id !== opts.symbol.id) {
        const sr = spanRange(opts.symbol.span);
        if (sr)
            excludeRanges.push(sr);
    }
    let effectiveNeedles = needles;
    if (hit.via && hit.via.kind !== "file" && (hit.depth > 1 || opts.rootIsFile)) {
        effectiveNeedles = [...needlesForName(hit.via.name), ...needles];
    }
    if (opts.extraNeedles && opts.extraNeedles.length > 0) {
        effectiveNeedles = [...effectiveNeedles, ...opts.extraNeedles];
    }
    const alreadyInlined = opts.seenSourceIds?.has(hit.node.id) ?? false;
    const withinBudget = (opts.sourceBudget?.bytes ?? 0) < (opts.sourceBudget?.maxBytes ?? 4400);
    const isFileNode = hit.node.kind === "file";
    const isTest = isTestPath(hit.node.path);
    if (opts.source && isTest && !withinBudget)
        return undefined;
    const allowFullWindow = Boolean(
        opts.source &&
        !alreadyInlined &&
        withinBudget &&
        !isTest &&
        (opts.sourceIndex ?? 0) < MAX_SOURCE_CALLERS,
    );
    if (allowFullWindow && !isFileNode) {
        const r = spanRange(hit.node.span);
        const lines = read(hit.node.path);
        if (r && lines && r.end - r.start + 1 <= MAX_SHORT_CALLER_LINES) {
            const end = Math.min(lines.length, r.end);
            const window = [];
            for (let ln = Math.max(1, r.start); ln <= end; ln++) {
                window.push({ n: ln, text: lines[ln - 1] });
            }
            if (window.length > 0) {
                opts.seenSourceIds?.add(hit.node.id);
                return [{ n: r.start, text: lines[r.start - 1] ?? "", window }];
            }
        }
    }
    const callerRange = spanRange(hit.node.span);
    const callerSpanLen = callerRange ? callerRange.end - callerRange.start + 1 : 0;
    const isCommandTableItem = /^[a-z0-9_]+\.run$/i.test(hit.node.name ?? "");
    const matches = referenceLines(hit.node.path, hit.node.span, effectiveNeedles, read, {
        excludeRanges,
        maxMatches: isTest ? 1 : isFileNode ? 10 : callerSpanLen > 120 ? 8 : withinBudget ? 5 : 2,
        contextLines: allowFullWindow ? (isFileNode ? 1 : 2) : 0,
        includeHeaderContext: isFileNode || callerSpanLen > 120 || isCommandTableItem,
        allowAboveSpan: isCommandTableItem,
    });
    if (allowFullWindow && matches.length > 0) {
        opts.seenSourceIds?.add(hit.node.id);
    }
    if (matches.length === 0)
        return undefined;
    return matches.length === 1 && !matches[0].window ? matches[0] : matches;
}

export function formatSymbolSource(symbol, read) {
    if (!symbol || symbol.kind === "file")
        return null;
    const r = spanRange(symbol.span);
    const lines = read(symbol.path);
    if (!r || !lines)
        return null;
    const start = Math.max(1, r.start);
    const end = Math.min(lines.length, r.end);
    const total = end - start + 1;
    if (total <= 0)
        return null;
    if (total <= MAX_SUBJECT_SOURCE_LINES) {
        const body = [];
        for (let ln = start; ln <= end; ln++)
            body.push(`L${ln}: ${lines[ln - 1]}`);
        return `\`\`\`\n${body.join("\n")}\n\`\`\``;
    }
    const headCount = 24;
    const tailCount = 6;
    const body = [];
    for (let ln = start; ln < start + headCount; ln++)
        body.push(`L${ln}: ${lines[ln - 1]}`);
    body.push(`  … (lines L${start + headCount}-L${end - tailCount} omitted)`);
    for (let ln = end - tailCount + 1; ln <= end; ln++)
        body.push(`L${ln}: ${lines[ln - 1]}`);
    return `\`\`\`\n${body.join("\n")}\n\`\`\``;
}

export function renderMatchBlock(symbol, hits, direction, showDepth, candidateCount, read, opts = {}) {
    const seenSourceIds = opts.seenSourceIds ?? new Set();
    const sourceBudget = opts.sourceBudget ?? { bytes: 0, maxBytes: 5400 };
    const head = headerOf(symbol);
    const lines = [head];
    sourceBudget.bytes += Buffer.byteLength(head, "utf8") + 1;
    if (opts.source && !seenSourceIds.has(symbol.id) && sourceBudget.bytes < sourceBudget.maxBytes) {
        const src = formatSymbolSource(symbol, read);
        if (src) {
            seenSourceIds.add(symbol.id);
            lines.push(src);
            sourceBudget.bytes += Buffer.byteLength(src, "utf8") + 1;
        }
    }
    if (hits.length === 0) {
        lines.push(looseNoteFor(direction, symbol.name, candidateCount));
        return lines.join("\n");
    }
    const needles = needlesForName(symbol.name);
    const rootIsFile = symbol.kind === "file";
    // When a file-level caller appears alongside named callers in the same file,
    // exclude the named callers' spans from the file-level caller's quote search.
    const namedSpansByPath = new Map();
    const namedNeedlesByPath = new Map();
    for (const h of hits) {
        if (h.node && h.node.kind !== "file") {
            const sr = spanRange(h.node.span);
            if (sr) {
                const list = namedSpansByPath.get(h.node.path) ?? [];
                list.push(sr);
                namedSpansByPath.set(h.node.path, list);
            }
            const nList = namedNeedlesByPath.get(h.node.path) ?? [];
            nList.push(...needlesForName(h.node.name));
            namedNeedlesByPath.set(h.node.path, nList);
        }
    }
    let sourceIndex = 0;
    for (const h of hits) {
        const hRange = h.node && h.node.kind !== "file" ? spanRange(h.node.span) : null;
        const hLen = hRange ? hRange.end - hRange.start : 0;
        const extraExcludes = h.node?.kind === "file"
            ? (namedSpansByPath.get(h.node.path) ?? [])
            : hRange
                ? (namedSpansByPath.get(h.node.path) ?? []).filter(
                    (r) => r.start >= hRange.start && r.end <= hRange.end && r.end - r.start < hLen,
                )
                : [];
        const extraNeedles = h.node?.kind === "file" ? (namedNeedlesByPath.get(h.node.path) ?? []) : [];
        const quote = quoteFor(h, needles, read, {
            symbol,
            rootIsFile,
            excludeRanges: extraExcludes,
            extraNeedles,
            source: Boolean(opts.source),
            sourceIndex,
            seenSourceIds,
            sourceBudget,
        });
        if (opts.source && h.node && !isTestPath(h.node.path))
            sourceIndex++;
        const rendered = hitLine(direction, h, showDepth, quote, { rootIsFile, source: Boolean(opts.source) });
        sourceBudget.bytes += Buffer.byteLength(rendered, "utf8") + 1;
        lines.push(rendered);
    }
    return lines.join("\n");
}

export function looseNoteFor(direction, name, candidateCount) {
    const label = direction === "out" ? "callees" : "callers";
    const dir = direction === "out" ? "outgoing" : "incoming";
    const ambiguity = candidateCount > 1
        ? ` ${candidateCount} definitions share the name "${name}"; a cross-file caller of an ambiguous name is dropped rather than guessed, so this may undercount.`
        : "";
    return `  no indexed ${label} — the graph has no ${dir} call/reference edges for this symbol as written.${ambiguity} Check the name (try the bare symbol, or "Type.method"), or find its uses with plexer grep "${name}". Fall back to raw grep -rn only for unindexed files`;
}

function lexicalFallbackHits(graph, symbol, read) {
    if (!graph || !Array.isArray(graph.nodes) || !symbol?.name || symbol.name.length < 3)
        return [];
    const needles = needlesForName(symbol.name);
    if (needles.length === 0)
        return [];
    const symRange = spanRange(symbol.span);
    const byPath = new Map();
    const fileNodes = [];
    for (const n of graph.nodes) {
        if (!n.path)
            continue;
        if (n.kind === "file") {
            fileNodes.push(n);
        }
        else {
            const r = spanRange(n.span);
            if (r) {
                const list = byPath.get(n.path) ?? [];
                list.push({ node: n, start: r.start, end: r.end, len: r.end - r.start });
                byPath.set(n.path, list);
            }
        }
    }
    const hits = [];
    const seenNodeIds = new Set([symbol.id]);
    for (const fn of fileNodes) {
        if (isTestPath(fn.path) && hits.length >= 6)
            continue;
        const excludeRanges = fn.path === symbol.path && symRange ? [symRange] : [];
        const matches = referenceLines(fn.path, fn.span || "L1-L999999", needles, read, {
            excludeRanges,
            maxMatches: 4,
            contextLines: 0,
        });
        if (matches.length === 0)
            continue;
        const candidates = byPath.get(fn.path) ?? [];
        for (const m of matches) {
            let best = null;
            for (const c of candidates) {
                if (c.node.id === symbol.id)
                    continue;
                if (m.n >= c.start && m.n <= c.end) {
                    if (!best || c.len < best.len)
                        best = c;
                }
            }
            const targetNode = best ? best.node : fn;
            if (seenNodeIds.has(targetNode.id))
                continue;
            seenNodeIds.add(targetNode.id);
            hits.push({
                id: targetNode.id,
                relation: "references",
                depth: 1,
                node: targetNode,
            });
            if (hits.length >= 10)
                return hits;
        }
    }
    return hits;
}

export function symbolJson(n) {
    return { id: n.id, name: n.name, kind: n.kind, path: n.path, span: n.span };
}

export function hitJson(hit) {
    const out = { id: hit.id, relation: hit.relation, depth: hit.depth };
    if (hit.via && hit.via.kind !== "file") {
        out.via = hit.via.name;
    }
    if (hit.node) {
        out.name = hit.node.name;
        out.kind = hit.node.kind;
        out.path = hit.node.path;
        out.span = hit.node.span;
    }
    return out;
}

export function resolveDirection(raw) {
    if (raw === undefined)
        return "in";
    if (raw === "in" || raw === "out")
        return raw;
    console.error(`✗ --direction must be "in" or "out", got "${raw}"`);
    process.exit(1);
}

export function resolveCliDepth(raw, defaultDepth = DEFAULT_DEPTH) {
    if (raw === undefined)
        return defaultDepth;
    const d = parseWalkDepth(raw, defaultDepth);
    if (Number.isNaN(d)) {
        console.error(`✗ --depth must be a positive number or "all", got "${raw}"`);
        process.exit(1);
    }
    return d;
}

export function runCallersCommand(queryInput, dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error(`✗ no graph found at ${contextDir} — run \`plexer build\` first`);
        process.exit(1);
    }
    const queries = (Array.isArray(queryInput) ? queryInput : [queryInput]).filter(Boolean);
    const direction = resolveDirection(opts.direction);
    const depth = resolveCliDepth(opts.depth, DEFAULT_DEPTH);
    const showDepth = depth > 1;
    const allResults = [];
    const seenSymbolIds = new Set();
    for (const q of queries) {
        let matches;
        try {
            matches = resolveSymbol(graph, q, opts.in ? { in: opts.in } : {});
        }
        catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
            return;
        }
        if (matches.length === 0) {
            if (!opts.json && direction === "in") {
                const pseudo = { id: `__query__:${q}`, name: q, kind: "reference", path: "", span: "" };
                const lexHits = lexicalFallbackHits(graph, pseudo, fileReader(root));
                if (lexHits.length > 0) {
                    allResults.push({ query: q, symbol: pseudo, candidateCount: 1, hits: lexHits });
                    continue;
                }
            }
            if (queries.length === 1) {
                console.error(`✗ no symbol "${q}" in the graph — check spelling or run plexer build`);
                process.exit(1);
            }
            console.error(`⚠ no symbol "${q}" in the graph — skipping`);
            continue;
        }
        for (const symbol of matches) {
            if (seenSymbolIds.has(symbol.id))
                continue;
            seenSymbolIds.add(symbol.id);
            let hits = edgeWalk(graph, symbol, direction, depth);
            if (hits.length === 0 && direction === "in") {
                hits = lexicalFallbackHits(graph, symbol, fileReader(root));
            }
            allResults.push({ query: q, symbol, candidateCount: matches.length, hits });
        }
    }
    if (allResults.length === 0) {
        console.error(`✗ no symbol "${queries.join(", ")}" in the graph — check spelling or run plexer build`);
        process.exit(1);
    }
    if (opts.json) {
        const payload = {
            query: queries.length === 1 ? queries[0] : queries,
            matches: allResults.map((r) => {
                const m = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
                if (r.hits.length === 0) {
                    m.note = looseNoteFor(direction, r.symbol.name, r.candidateCount);
                }
                return m;
            }),
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    const blocks = [];
    const read = fileReader(root);
    const seenSourceIds = new Set();
    const maxBytesPerSymbol = queries.length > 1 ? 4600 : 5400;
    for (const { symbol, candidateCount, hits } of allResults) {
        const sourceBudget = { bytes: 0, maxBytes: maxBytesPerSymbol };
        blocks.push(
            renderMatchBlock(symbol, hits, direction, showDepth, candidateCount, read, {
                source: opts.source,
                seenSourceIds,
                sourceBudget,
            }),
        );
    }
    process.stdout.write(`${blocks.join("\n\n")}\n`);
}