/**
 * Lightweight `plexer read` span slicer isolated from BM25F/PageRank/SQLite indexing.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isSpanCovered, normalizeRelFile } from "../agy/spans.js";
import { loadGraphCached } from "../context/graph-store.js";
import { contextDirFor } from "../context/node-file.js";
import { fileReader, fmtLine, isSensitiveOrDotPath, spanRange } from "../util/span.js";
import { suggestClosestFiles, suggestClosestSymbols } from "./text-helpers.js";

const DEFAULT_READ_BUDGET_BYTES = 9000;
const MAX_SINGLE_SPAN_LINES = 320;
const MIN_READ_SEEN_EDGE_TRIM_LINES = 20;

function parseReadSpanSpec(spec) {
    const trimmed = String(spec ?? "").trim();
    const mRange = /^(.*?):L?(\d+)(?:-L?(\d+))?$/.exec(trimmed);
    if (mRange && mRange[1]) {
        const rawPath = mRange[1].replace(/\\/g, "/").replace(/^\/+/, "");
        const rawStart = Math.max(1, Number(mRange[2]));
        const rawEnd = mRange[3] !== undefined ? Math.max(1, Number(mRange[3])) : rawStart + 30;
        const start = Math.min(rawStart, rawEnd);
        const end = Math.max(rawStart, rawEnd);
        return { raw: trimmed, file: rawPath, start, end, hasExplicitRange: true, symbol: null };
    }
    const mSym = /^(.*?):([A-Za-z_][A-Za-z0-9_.:#]*)$/.exec(trimmed);
    if (mSym && mSym[1] && mSym[2]) {
        const rawPath = mSym[1].replace(/\\/g, "/").replace(/^\/+/, "");
        return { raw: trimmed, file: rawPath, start: 1, end: 120, hasExplicitRange: false, symbol: mSym[2] };
    }
    if (!trimmed)
        return null;
    const rawPath = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    return { raw: trimmed, file: rawPath, start: 1, end: 120, hasExplicitRange: false, symbol: null };
}

function matchesQualifiedTarget(n, target, lower) {
    if (n.name === target)
        return true;
    if (n.owner && (`${n.owner}.${n.name}` === target || `${n.owner}:${n.name}` === target || `${n.owner}#${n.name}` === target))
        return true;
    if (n.id.endsWith(`#${target}`) || n.id.endsWith(`.${target}`) || n.id.endsWith(`:${target}`))
        return true;
    if (lower) {
        const nameLow = n.name.toLowerCase();
        if (nameLow === lower)
            return true;
        if (n.owner) {
            const ownerLow = n.owner.toLowerCase();
            if (`${ownerLow}.${nameLow}` === lower || `${ownerLow}:${nameLow}` === lower || `${ownerLow}#${nameLow}` === lower)
                return true;
        }
        const idLow = n.id.toLowerCase();
        if (idLow.endsWith(`#${lower}`) || idLow.endsWith(`.${lower}`) || idLow.endsWith(`:${lower}`))
            return true;
    }
    return false;
}

function lookupSpanTarget(fileNodes, targetName) {
    const isQualified = /[.:#]/.test(targetName);
    const symLower = targetName.toLowerCase();
    if (isQualified) {
        const qualExact = fileNodes.find((n) => matchesQualifiedTarget(n, targetName, null));
        if (qualExact)
            return qualExact;
        const qualCi = fileNodes.find((n) => matchesQualifiedTarget(n, targetName, symLower));
        if (qualCi)
            return qualCi;
    }
    const rawBare = targetName.split(/[.:#]/).pop() || targetName;
    const exact = fileNodes.find((n) => n.name === targetName) ??
        fileNodes.find((n) => n.name === rawBare || n.name.endsWith(`.${rawBare}`) || n.name.endsWith(`:${rawBare}`)) ??
        fileNodes.find((n) => n.id.endsWith(`#${targetName}`) || n.id.endsWith(`.${rawBare}`));
    if (exact)
        return exact;
    const symBare = rawBare.toLowerCase();
    return (fileNodes.find((n) => n.name.toLowerCase() === symLower) ??
        fileNodes.find((n) => n.name.toLowerCase() === symBare || n.name.toLowerCase().endsWith(`.${symBare}`) || n.name.toLowerCase().endsWith(`:${symBare}`)) ??
        fileNodes.find((n) => n.id.toLowerCase().endsWith(`#${symLower}`) || n.id.toLowerCase().endsWith(`.${symBare}`)));
}

function formatMissingReadFileError(resolvedFile, rawFile, indexedPaths) {
    if (resolvedFile.startsWith(".."))
        return `cannot read "${resolvedFile}"`;
    const suggestions = suggestClosestFiles(rawFile, indexedPaths, 3);
    return suggestions.length
        ? `cannot read "${resolvedFile}" — did you mean: ${suggestions.join(", ")}?`
        : `cannot read "${resolvedFile}"`;
}

function missingReadTargetError(targetName, resolvedFile, fileNodes) {
    const suggestions = suggestClosestSymbols(targetName, fileNodes, { max: 3, withSpan: true });
    return suggestions.length
        ? `no symbol "${targetName}" in "${resolvedFile}" — did you mean: ${suggestions.join(", ")}?`
        : `no symbol "${targetName}" in "${resolvedFile}"`;
}

function resolveIndexedReadPath(fileQuery, indexedPaths, rootPrefix, read) {
    const normalizedQuery = fileQuery.startsWith(rootPrefix)
        ? fileQuery.slice(rootPrefix.length)
        : fileQuery;
    const suffix = `/${normalizedQuery}`;
    const matches = indexedPaths.filter((p) => p === normalizedQuery || p.endsWith(suffix));
    if (matches.length === 1)
        return { path: matches[0], warning: null };
    const lower = normalizedQuery.toLowerCase();
    const lowerSuffix = suffix.toLowerCase();
    const ciMatches = indexedPaths.filter((p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(lowerSuffix));
    if (ciMatches.length === 1)
        return { path: ciMatches[0], warning: null };
    if (read(normalizedQuery))
        return { path: normalizedQuery, warning: null };
    const ambig = matches.length > 1 ? matches : (ciMatches.length > 1 ? ciMatches : null);
    const chosen = matches[0] ?? ciMatches[0] ?? normalizedQuery;
    const warning = ambig
        ? `ambiguous path "${normalizedQuery}" — showing ${chosen} (also matches: ${ambig.slice(1, 4).join(", ")}${ambig.length > 4 ? ", …" : ""})`
        : null;
    return { path: chosen, warning };
}

export function canFastSliceExplicitSpans(dir, rawSpecs) {
    const specs = (Array.isArray(rawSpecs) ? rawSpecs : [rawSpecs])
        .flatMap((s) => String(s ?? "").split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    if (specs.length === 0)
        return false;
    const root = resolve(dir);
    const rootPrefix = `${root.replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    for (const rawSpec of specs) {
        const parsed = parseReadSpanSpec(rawSpec);
        if (!parsed || !parsed.hasExplicitRange || parsed.symbol)
            return false;
        const normFile = parsed.file.startsWith(rootPrefix) ? parsed.file.slice(rootPrefix.length) : parsed.file;
        if (!normFile || isSensitiveOrDotPath(normFile))
            return false;
        const abs = resolve(root, normFile);
        const rel = relative(root, abs).replace(/\\/g, "/");
        if (!rel || rel.startsWith("..") || isAbsolute(rel))
            return false;
        try {
            if (!existsSync(abs) || !statSync(abs).isFile())
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}

function getSeenIntervalsForRead(seenSpans, relFile) {
    if (!seenSpans || typeof seenSpans !== "object")
        return null;
    const norm = normalizeRelFile(relFile);
    if (Array.isArray(seenSpans[norm]))
        return { key: norm, intervals: seenSpans[norm] };
    for (const [k, intervals] of Object.entries(seenSpans)) {
        if (!Array.isArray(intervals))
            continue;
        const nk = normalizeRelFile(k);
        if (nk === norm || nk.endsWith(`/${norm}`) || norm.endsWith(`/${nk}`))
            return { key: nk, intervals };
    }
    return null;
}

function applySeenSpansToReadItem(item, seenSpans) {
    if (!seenSpans || item.error)
        return;
    const matched = getSeenIntervalsForRead(seenSpans, item.file);
    if (!matched || matched.intervals.length === 0)
        return;
    const spanLines = item.unpooledEnd - item.start + 1;
    const spanBytes = item.lines
        .slice(item.start - 1, item.unpooledEnd)
        .reduce((sum, line) => sum + Buffer.byteLength(line ?? "", "utf8") + 1, 0);
    if ((spanLines >= 15 || spanBytes >= 600) && isSpanCovered(seenSpans, matched.key, item.start, item.unpooledEnd, 0.85)) {
        item.alreadySeen = true;
        return;
    }
    const origStart = item.start;
    const origUnpooledEnd = item.unpooledEnd;
    for (const [s, e] of matched.intervals) {
        if (s <= item.start && e >= item.start + MIN_READ_SEEN_EDGE_TRIM_LINES - 1 && e < item.unpooledEnd && (item.unpooledEnd - e) >= 10) {
            item.start = e + 1;
        }
        if (s > item.start + 9 && s <= item.unpooledEnd && e >= item.unpooledEnd && (item.unpooledEnd - s + 1) >= MIN_READ_SEEN_EDGE_TRIM_LINES) {
            item.unpooledEnd = s - 1;
            item.targetEnd = Math.min(item.targetEnd, item.unpooledEnd);
        }
    }
    if (item.start > origStart)
        item.trimmedHead = [origStart, item.start - 1];
    if (item.unpooledEnd < origUnpooledEnd)
        item.trimmedTail = [item.unpooledEnd + 1, origUnpooledEnd];
}

function resolveSpanBlockRequest(rawSpec, resolvePath, read, graph, indexedPaths, opts = {}) {
    const parsed = parseReadSpanSpec(rawSpec);
    if (!parsed)
        return { spec: rawSpec, error: `invalid span "${rawSpec}"` };
    const resolved = resolvePath(parsed.file);
    const resolvedFile = typeof resolved === "string" ? resolved : resolved.path;
    const warning = typeof resolved === "string" ? null : resolved.warning;
    if (!resolvedFile.startsWith("..") && isSensitiveOrDotPath(resolvedFile))
        return { spec: rawSpec, file: resolvedFile, error: `cannot read sensitive or hidden path "${resolvedFile}"` };
    const lines = read(resolvedFile);
    if (!lines)
        return { spec: rawSpec, file: resolvedFile, error: formatMissingReadFileError(resolvedFile, parsed.file, indexedPaths) };
    let spanStartLine = parsed.start;
    let spanEndLine = parsed.end;
    let hasExplicit = parsed.hasExplicitRange;
    if (parsed.symbol) {
        if (!graph)
            return { spec: rawSpec, file: resolvedFile, error: `cannot resolve symbol "${parsed.symbol}" in "${resolvedFile}" — no wiring graph (run \`plexer build\` first)` };
        const pathNodes = graph._nodesByPath?.get(resolvedFile) ?? graph.nodes.filter((n) => n.path === resolvedFile);
        const fileNodes = pathNodes.filter((n) => n.kind !== "file" && n.span);
        const matchNode = lookupSpanTarget(fileNodes, parsed.symbol);
        if (!matchNode)
            return { spec: rawSpec, file: resolvedFile, error: missingReadTargetError(parsed.symbol, resolvedFile, fileNodes) };
        const sr = spanRange(matchNode.span);
        if (sr) {
            spanStartLine = sr.start;
            spanEndLine = sr.end;
            hasExplicit = true;
        }
    }
    if (hasExplicit && spanStartLine > lines.length) {
        return { spec: rawSpec, file: resolvedFile, error: `line ${spanStartLine} out of range for "${resolvedFile}" (${lines.length} lines)` };
    }
    const start = Math.max(1, Math.min(spanStartLine, lines.length));
    const defaultBareLines = opts.full ? 400 : 160;
    const rawTargetEnd = Math.max(start, Math.min(hasExplicit ? spanEndLine : Math.min(lines.length, defaultBareLines), lines.length));
    const unpooledMaxEnd = opts.full ? rawTargetEnd : Math.min(rawTargetEnd, start + MAX_SINGLE_SPAN_LINES - 1);
    return {
        spec: rawSpec,
        file: resolvedFile,
        warning,
        start,
        targetEnd: rawTargetEnd,
        unpooledEnd: unpooledMaxEnd,
        totalLines: lines.length,
        lines,
    };
}

function coalesceResolvedSpanRequests(items) {
    const out = [];
    const byFile = new Map();
    for (const item of items) {
        if (item.error) {
            out.push({ kind: "error", item });
            continue;
        }
        let list = byFile.get(item.file);
        if (!list) {
            list = [];
            byFile.set(item.file, list);
            out.push({ kind: "file", file: item.file });
        }
        list.push({ ...item });
    }
    const mergedByFile = new Map();
    for (const [file, list] of byFile) {
        list.sort((a, b) => a.start - b.start || a.targetEnd - b.targetEnd);
        const merged = [];
        for (const cur of list) {
            const prev = merged[merged.length - 1];
            if (prev && cur.start <= prev.targetEnd + 3) {
                prev.targetEnd = Math.max(prev.targetEnd, cur.targetEnd);
                prev.unpooledEnd = Math.max(prev.unpooledEnd, cur.unpooledEnd);
                if (prev.spec !== cur.spec)
                    prev.spec = `${prev.spec}, ${cur.spec}`;
                prev.warning ??= cur.warning;
            }
            else {
                merged.push(cur);
            }
        }
        mergedByFile.set(file, merged);
    }
    const flat = [];
    for (const entry of out) {
        if (entry.kind === "error")
            flat.push(entry.item);
        else
            flat.push(...(mergedByFile.get(entry.file) ?? []));
    }
    return flat;
}

function materializeSpanBlock(item, end) {
    if (item.alreadySeen) {
        const span = `L${item.start}-L${item.targetEnd}`;
        const code = `// [seen: ${item.file}:${span}; --full]`;
        return {
            block: {
                spec: item.spec,
                file: item.file,
                span,
                startLine: item.start,
                endLine: item.targetEnd,
                totalLines: item.totalLines,
                truncated: false,
                alreadySeen: true,
                code,
            },
            bytes: Buffer.byteLength(`${code}\n\n`, "utf8"),
        };
    }
    const slice = [];
    if (item.trimmedHead)
        slice.push(`// [seen: ${item.file}:L${item.trimmedHead[0]}-L${item.trimmedHead[1]}]`);
    for (let ln = item.start; ln <= end; ln++) {
        slice.push(fmtLine(ln, item.lines[ln - 1]));
    }
    if (item.trimmedTail && end >= item.unpooledEnd)
        slice.push(`// [seen: ${item.file}:L${item.trimmedTail[0]}-L${item.trimmedTail[1]}]`);
    if (end < item.targetEnd) {
        slice.push(`… (+${item.targetEnd - end} more lines — run \`plexer read ${item.file}:L${end + 1}-L${item.targetEnd}\` or use read_file)`);
    }
    const span = `L${item.start}-L${end}`;
    const code = slice.join("\n");
    const warnPrefix = item.warning ? `⚠ ${item.warning}\n` : "";
    const formatted = `${warnPrefix}${item.file}:${span} (of ${item.totalLines} lines)\n\`\`\`\n${code}\n\`\`\`\n\n`;
    return {
        block: {
            spec: item.spec,
            file: item.file,
            ...(item.warning ? { warning: item.warning } : {}),
            span,
            startLine: item.start,
            endLine: end,
            totalLines: item.totalLines,
            truncated: end < item.targetEnd,
            code,
        },
        bytes: Buffer.byteLength(formatted, "utf8"),
    };
}

function fitItemToByteShare(item, byteBudget, minLinesFloor) {
    const maxEnd = item.unpooledEnd;
    const minEnd = Math.min(maxEnd, item.start + minLinesFloor - 1);
    const frameOverhead = Buffer.byteLength(
        `${item.file}:L${item.start}-L${maxEnd} (of ${item.totalLines} lines)\n\`\`\`\n\n\`\`\`\n\n`,
        "utf8",
    ) + 96;
    let used = frameOverhead;
    let chosenEnd = item.start;
    for (let ln = item.start; ln <= maxEnd; ln++) {
        const lineBytes = Buffer.byteLength(`${fmtLine(ln, item.lines[ln - 1])}\n`, "utf8");
        if (ln > minEnd && used + lineBytes > byteBudget)
            break;
        used += lineBytes;
        chosenEnd = ln;
    }
    return materializeSpanBlock(item, chosenEnd);
}

function defaultReadBudgetForSpanCount(spanCount) {
    if (spanCount <= 1)
        return 8800;
    if (spanCount === 2)
        return 9100;
    return 9200;
}

function collectCallersForReadBlock(graph, block, byId, inEdges) {
    if (!graph || !block || block.error || block.alreadySeen || !block.file || !block.startLine)
        return [];
    const fileNodes = graph._nodesByPath?.get(block.file) ?? (graph.nodes ?? []).filter((n) => n.path === block.file);
    const matchingSyms = fileNodes.filter((n) => {
        if (!n || n.kind === "file") return false;
        const sr = spanRange(n.span);
        return sr ? (sr.start <= block.endLine && sr.end >= block.startLine) : false;
    });
    if (matchingSyms.length === 0)
        return [];
    const seen = new Set();
    const out = [];
    for (const sym of matchingSyms) {
        const edges = inEdges.get(sym.id) ?? [];
        for (const e of edges) {
            if (!e || e.source === sym.id) continue;
            const src = byId.get(e.source);
            if (!src || src.kind === "file" || !src.path || src.path === block.file) continue;
            const key = `${src.name}@${src.path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const loc = e.line ? `${src.path}:L${e.line}` : `${src.path}:${src.span || "L1"}`;
            out.push(`${src.name} (${loc})`);
            if (out.length >= 4) return out;
        }
    }
    return out;
}

function attachCallersToBlocks(blocks, graph) {
    if (!graph?.nodes?.length || !Array.isArray(blocks) || blocks.length === 0)
        return;
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    let inEdges = graph._inEdges;
    if (!inEdges) {
        inEdges = new Map();
        for (const e of graph.edges ?? []) {
            if (!e?.target) continue;
            let list = inEdges.get(e.target);
            if (!list) {
                list = [];
                inEdges.set(e.target, list);
            }
            list.push(e);
        }
    }
    for (const blk of blocks) {
        const callers = collectCallersForReadBlock(graph, blk, byId, inEdges);
        if (callers.length > 0) blk.callers = callers;
    }
}

/** Read one or more `<file>[:L<start>[-L<end>] | :<symbol>]` spans with `L<n>:` line prefixes. */
export function readSpans(dir, spanSpecs, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const read = fileReader(root);
    const specs = (Array.isArray(spanSpecs) ? spanSpecs : [spanSpecs])
        .flatMap((s) => String(s ?? "").split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    const fastExplicit = !opts.callers && canFastSliceExplicitSpans(root, specs);
    const graph = fastExplicit ? null : loadGraphCached(outDir);
    const indexedPaths = graph
        ? (graph._nodesByPath
            ? [...graph._nodesByPath.keys()].sort()
            : [...new Set(graph.nodes.map((n) => n.path).filter(Boolean))].sort())
        : [];
    const rootPrefix = `${root.replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    const resolvePath = (fileQuery) => resolveIndexedReadPath(fileQuery, indexedPaths, rootPrefix, read);
    const rawResolved = specs.map((rawSpec) => resolveSpanBlockRequest(rawSpec, resolvePath, read, graph, indexedPaths, opts));
    const items = coalesceResolvedSpanRequests(rawResolved);
    if (!opts.full && opts.seenSpans) {
        for (const it of items) applySeenSpansToReadItem(it, opts.seenSpans);
    }
    const fullResults = items.map((it) =>
        it.error
            ? { block: it, bytes: Buffer.byteLength(`✗ ${it.error}\n\n`, "utf8"), item: it }
            : { ...materializeSpanBlock(it, it.unpooledEnd), item: it },
    );
    const activeIndices = fullResults
        .map((r, idx) => (!r.item.error && !r.item.alreadySeen ? idx : -1))
        .filter((idx) => idx >= 0);
    const agyMultiFullCap = Boolean(
        opts.full &&
        activeIndices.length >= 2 &&
        opts.antigravityPipeCap === true,
    );
    const maxBytes = opts.full
        ? (agyMultiFullCap ? 9100 : Infinity)
        : (opts.maxBytes ?? defaultReadBudgetForSpanCount(activeIndices.length));
    const totalBytes = fullResults.reduce((acc, r) => acc + r.bytes, 0);
    if (totalBytes <= maxBytes) {
        const blocks = fullResults.map((r) => r.block);
        if (opts.callers && graph) attachCallersToBlocks(blocks, graph);
        return { blocks };
    }
    const fixedOverhead = fullResults
        .filter((r) => r.item.error || r.item.alreadySeen)
        .reduce((a, r) => a + r.bytes, 0);
    const minLinesFloor = 5;
    const totalPool = Math.max(1200, maxBytes - fixedOverhead);
    const finalBlocks = fullResults.map((r) => r.block);
    const sortedEntries = activeIndices
        .map((idx) => ({ idx, bytes: fullResults[idx].bytes }))
        .sort((a, b) => a.bytes - b.bytes);
    let remainingPool = totalPool;
    let waterCap = totalPool;
    for (let i = 0; i < sortedEntries.length; i++) {
        const leftCount = sortedEntries.length - i;
        const share = Math.floor(remainingPool / leftCount);
        if (sortedEntries[i].bytes <= share) {
            remainingPool -= sortedEntries[i].bytes;
        }
        else {
            waterCap = share;
            break;
        }
    }
    const orderedForFit = activeIndices
        .map((idx, pos) => ({ idx, pos, bytes: fullResults[idx].bytes }))
        .sort((a, b) => a.bytes - b.bytes || a.pos - b.pos);
    let budgetLeft = totalPool;
    for (let i = 0; i < orderedForFit.length; i++) {
        const { idx, bytes } = orderedForFit[i];
        const leftCount = orderedForFit.length - i;
        const target = Math.max(400, Math.max(waterCap, Math.floor(budgetLeft / leftCount)));
        if (bytes <= target) {
            finalBlocks[idx] = fullResults[idx].block;
            budgetLeft = Math.max(0, budgetLeft - bytes);
            continue;
        }
        const fitted = fitItemToByteShare(fullResults[idx].item, Math.min(budgetLeft, target), minLinesFloor);
        finalBlocks[idx] = fitted.block;
        budgetLeft = Math.max(0, budgetLeft - fitted.bytes);
    }
    if (opts.callers && graph) attachCallersToBlocks(finalBlocks, graph);
    return { blocks: finalBlocks };
}

export function formatReadSpans(result) {
    const out = [];
    for (const b of result.blocks ?? []) {
        if (b.error) {
            out.push(`✗ ${b.error}`);
            continue;
        }
        if (b.alreadySeen) {
            out.push(b.code);
            continue;
        }
        const warnPrefix = b.warning ? `⚠ ${b.warning}\n` : "";
        const callersLine = Array.isArray(b.callers) && b.callers.length ? `\ncallers: ${b.callers.join(", ")}` : "";
        out.push(`${warnPrefix}${b.file}:${b.span} (of ${b.totalLines} lines)${callersLine}\n\`\`\`\n${b.code}\n\`\`\``);
    }
    return `${out.join("\n\n")}\n`;
}
