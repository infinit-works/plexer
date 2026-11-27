/**
 * CLI wiring for `plexer callers` and its `--direction` / `--depth` flags.
 */
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { escapeRegExp, fileReader, fmtLine, needlesForName, referenceLines, spanRange } from "../util/span.js";
import { suggestNearTargets } from "../ask/text-helpers.js";
import { loadAskIndexCached, queryAskPostings } from "../ask/index-file.js";
import { tokenize } from "../ask/tokenize.js";
import { readAgySession, writeAgySession } from "../agy/session.js";
import { isSpanCovered, mergeSpan } from "../agy/spans.js";
import { GENERIC_MEMBER_NAMES } from "../util/id.js";
import { isTestPath } from "../util/paths.js";
import { loadGraphCached } from "../context/graph-store.js";
import { contextDirFor } from "../context/node-file.js";
import { resolveSymbol } from "../context/symbol-query.js";
import { reachable } from "./languages.js";
import { linkTestsForGraph } from "./test-links.js";
import { edgeWalk, parseWalkDepth } from "./traverse.js";

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
                        ? `      ${fmtLine(w.n, w.text.trimEnd())}`
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

function collectQuoteExcludeRanges(hit, opts) {
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
    return excludeRanges;
}

function buildQuoteNeedles(needles, hit, opts) {
    const out = hit.via && hit.via.kind !== "file" && (hit.depth > 1 || opts.rootIsFile)
        ? [...needlesForName(hit.via.name), ...needles]
        : [...needles];
    if (opts.extraNeedles && opts.extraNeedles.length > 0)
        out.push(...opts.extraNeedles);
    return out;
}

function tryShortCallerWindow(hit, read, seenSourceIds, shownTargetSpans = null) {
    const r = spanRange(hit.node.span);
    const lines = read(hit.node.path);
    if (!r || !lines || r.end - r.start + 1 > MAX_SHORT_CALLER_LINES)
        return null;
    const start = Math.max(1, r.start);
    const end = Math.min(lines.length, r.end);
    const window = [];
    for (let ln = start; ln <= end; ln++)
        window.push({ n: ln, text: lines[ln - 1] });
    if (window.length === 0)
        return null;
    seenSourceIds?.add(hit.node.id);
    shownTargetSpans?.push({ file: hit.node.path, start, end });
    return [{ n: r.start, text: lines[r.start - 1] ?? "", window }];
}

export function quoteFor(hit, needles, read, opts = {}) {
    if (!hit.node)
        return undefined;
    const excludeRanges = collectQuoteExcludeRanges(hit, opts);
    const effectiveNeedles = buildQuoteNeedles(needles, hit, opts);
    const alreadyInlined = opts.seenSourceIds?.has(hit.node.id) ?? false;
    const withinBudget = (opts.sourceBudget?.bytes ?? 0) < (opts.sourceBudget?.maxBytes ?? 4400);
    const isFileNode = hit.node.kind === "file";
    const isTest = isTestPath(hit.node.path);
    if (opts.source && isTest && !withinBudget)
        return undefined;
    const allowFullWindow = Boolean(
        opts.source && !alreadyInlined && withinBudget && !isTest && (opts.sourceIndex ?? 0) < MAX_SOURCE_CALLERS,
    );
    if (allowFullWindow && !isFileNode) {
        const shortWindow = tryShortCallerWindow(hit, read, opts.seenSourceIds, opts.shownTargetSpans ?? null);
        if (shortWindow)
            return shortWindow;
    }
    const callerRange = spanRange(hit.node.span);
    const callerSpanLen = callerRange ? callerRange.end - callerRange.start + 1 : 0;
    const isCommandTableItem = /^[a-z0-9_]+\.run$/i.test(hit.node.name ?? "");
    const maxMatches = isTest || !withinBudget ? 1 : isFileNode ? 10 : callerSpanLen > 120 ? 8 : 5;
    const matches = referenceLines(hit.node.path, hit.node.span, effectiveNeedles, read, {
        excludeRanges,
        maxMatches,
        contextLines: allowFullWindow ? (isFileNode ? 1 : 2) : 0,
        includeHeaderContext: withinBudget && (isFileNode || callerSpanLen > 120 || isCommandTableItem),
        allowAboveSpan: isCommandTableItem,
    });
    if (allowFullWindow && matches.length > 0)
        opts.seenSourceIds?.add(hit.node.id);
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
            body.push(fmtLine(ln, lines[ln - 1]));
        return `\`\`\`\n${body.join("\n")}\n\`\`\``;
    }
    const headCount = 24;
    const tailCount = 6;
    const body = [];
    for (let ln = start; ln < start + headCount; ln++)
        body.push(fmtLine(ln, lines[ln - 1]));
    body.push(`  … (lines L${start + headCount}-L${end - tailCount} omitted)`);
    for (let ln = end - tailCount + 1; ln <= end; ln++)
        body.push(fmtLine(ln, lines[ln - 1]));
    return `\`\`\`\n${body.join("\n")}\n\`\`\``;
}

function coveringTestsFooter(symbol, hits, direction, testLinks) {
    if (direction !== "in" || !testLinks || !symbol?.id || !symbol?.path)
        return null;
    const directTestFiles = new Set();
    for (const h of hits) {
        if (h.depth === 1 && h.node?.path && isTestPath(h.node.path))
            directTestFiles.add(h.node.path);
    }
    const allTests = testLinks.testsForSymbol(symbol.id, symbol.path, true);
    const extra = allTests.filter(
        (t) => (t.kind === "module_import" || t.kind === "stem_companion") && !directTestFiles.has(t.testFile),
    );
    if (extra.length === 0)
        return null;
    return `  covering tests: ${extra.map((t) => `${t.testFile} (${t.kind})`).join(", ")}`;
}

function getGraphSpansCache(graph) {
    if (graph._receiverSpansCache)
        return graph._receiverSpansCache;
    const fileNodes = [];
    const spansByPath = new Map();
    for (const n of graph.nodes) {
        if (!n.path)
            continue;
        if (n.kind === "file") {
            if (!isTestPath(n.path))
                fileNodes.push(n);
            continue;
        }
        const r = spanRange(n.span);
        if (r) {
            let list = spansByPath.get(n.path);
            if (!list) {
                list = [];
                spansByPath.set(n.path, list);
            }
            list.push({ node: n, start: r.start, end: r.end, len: r.end - r.start });
        }
    }
    const cache = { fileNodes, spansByPath };
    Object.defineProperty(graph, "_receiverSpansCache", {
        value: cache,
        enumerable: false,
        configurable: true,
    });
    return cache;
}

function collectReceiverScanContext(graph, symbol, hits) {
    const leaf = String(symbol.name ?? "").split(/[.:#]/).pop() ?? "";
    const homonymIds = new Set();
    const { fileNodes, spansByPath } = getGraphSpansCache(graph);
    const candidateFiles = [];
    for (const fn of fileNodes) {
        if (reachable(fn.path, symbol.path))
            candidateFiles.push(fn);
    }
    if (graph.byBareName) {
        for (const n of graph.byBareName.get(leaf.toLowerCase()) ?? []) {
            const nLeaf = String(n.name ?? "").split(/[.:#]/).pop();
            if (nLeaf === leaf && (n.kind === "method" || n.kind === "function"))
                homonymIds.add(n.id);
        }
    }
    else {
        for (const n of graph.nodes) {
            if (!n.path || n.kind === "file")
                continue;
            const nLeaf = String(n.name ?? "").split(/[.:#]/).pop();
            if (nLeaf === leaf && (n.kind === "method" || n.kind === "function"))
                homonymIds.add(n.id);
        }
    }
    const alreadyLinkedCallerIds = new Set([symbol.id, ...hits.map((h) => h.id)]);
    if (graph._inEdges) {
        for (const hid of homonymIds) {
            for (const e of graph._inEdges.get(hid) ?? []) {
                if (e.relation === "calls")
                    alreadyLinkedCallerIds.add(e.source);
            }
        }
    }
    else {
        for (const e of graph.edges ?? []) {
            if (e.relation === "calls" && homonymIds.has(e.target))
                alreadyLinkedCallerIds.add(e.source);
        }
    }
    return { leaf, candidateFiles, byPath: spansByPath, alreadyLinkedCallerIds, homonymIds };
}

function filterScanFilesBySqlitePostings(candidateFiles, leafToks, contextDir) {
    const res = queryAskPostings(contextDir, { sig: leafToks, summary: leafToks, body: leafToks });
    if (!res)
        return null;
    let matchedDocIds = null;
    for (const tok of leafToks) {
        const tokIds = new Set();
        for (const ch of ["sig", "summary", "body"]) {
            for (const [docId] of res.postings?.[ch]?.get(tok) ?? [])
                tokIds.add(docId);
        }
        if (matchedDocIds === null) {
            matchedDocIds = tokIds;
        }
        else {
            for (const id of matchedDocIds) {
                if (!tokIds.has(id))
                    matchedDocIds.delete(id);
            }
        }
        if (matchedDocIds.size === 0)
            return [];
    }
    const allowedPaths = new Set();
    for (const docId of matchedDocIds ?? []) {
        const p = res.docs?.get(docId)?.path;
        if (p)
            allowedPaths.add(p);
    }
    return candidateFiles.filter((f) => allowedPaths.has(f.path));
}

const MAX_ASK_INDEXED_BODY_CHARS = 5000;

function hasLargeSymbolBodyInFile(fn, byPath, read, repoRoot) {
    if (!read)
        return false;
    if (repoRoot) {
        const abs = isAbsolute(fn.path) ? fn.path : join(repoRoot, fn.path);
        try {
            if (statSync(abs).size <= MAX_ASK_INDEXED_BODY_CHARS)
                return false;
        }
        catch {
            return false;
        }
    }
    const lines = read(fn.path);
    if (!lines || lines.length === 0)
        return false;
    const syms = byPath?.get(fn.path);
    if (syms && syms.length > 0) {
        for (const s of syms) {
            let chars = 0;
            const lo = Math.max(1, s.start) - 1;
            const hi = Math.min(lines.length, s.end);
            for (let i = lo; i < hi; i++) {
                chars += (lines[i]?.length ?? 0) + 1;
                if (chars > MAX_ASK_INDEXED_BODY_CHARS)
                    return true;
            }
        }
        return false;
    }
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
        total += (lines[i]?.length ?? 0) + 1;
        if (total > MAX_ASK_INDEXED_BODY_CHARS)
            return true;
    }
    return false;
}

function filterScanFilesByAskIndex(candidateFiles, leaf, graph, contextDir, preloadedAskIdx, byPath, read) {
    if (candidateFiles.length <= 15 || !contextDir)
        return candidateFiles;
    const leafToks = tokenize(leaf);
    if (leafToks.length === 0)
        return candidateFiles;
    const repoRoot = graph?.repoRoot ?? null;
    if (preloadedAskIdx == null) {
        const sqliteMatch = filterScanFilesBySqlitePostings(candidateFiles, leafToks, contextDir);
        if (sqliteMatch !== null) {
            const matchedSet = new Set(sqliteMatch.map((f) => f.path));
            return candidateFiles.filter((f) => matchedSet.has(f.path) || hasLargeSymbolBodyInFile(f, byPath, read, repoRoot));
        }
    }
    const rawIdx = preloadedAskIdx != null ? preloadedAskIdx : loadAskIndexCached(contextDir);
    if (!rawIdx || !Array.isArray(rawIdx.docs))
        return candidateFiles;
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const hydratedById = rawIdx._hydrated?.byId;
    const allowedPaths = new Set();
    for (const doc of rawIdx.docs) {
        const bodyMap = hydratedById?.get(doc.id)?.body;
        const matched = bodyMap
            ? leafToks.every((t) => bodyMap.has(t))
            : (() => {
                const bodyKeys = new Set((doc.body ?? []).map((p) => p[0]));
                return leafToks.every((t) => bodyKeys.has(t));
            })();
        if (matched) {
            const p = byId.get(doc.id)?.path;
            if (p)
                allowedPaths.add(p);
        }
    }
    return candidateFiles.filter((f) => allowedPaths.has(f.path) || hasLargeSymbolBodyInFile(f, byPath, read, repoRoot));
}

function findEnclosingCallNode(symsInFile, ln, fallbackFileNode) {
    let best = null;
    for (const c of symsInFile) {
        if (ln >= c.start && ln <= c.end && (!best || c.len < best.len))
            best = c;
    }
    return best ? best.node : fallbackFileNode;
}

function isCommentOnlyLine(trimmed) {
    return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--") || trimmed.startsWith("*");
}

function stripQuotedStringLiterals(line) {
    return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "$1$1");
}

function scanSingleFileReceiverSites(fn, symsInFile, ctx, state) {
    const lines = ctx.read(fn.path);
    if (!lines)
        return false;
    const isSelfFile = fn.path === ctx.symbol.path && Boolean(ctx.symRange);
    for (let idx = 0; idx < lines.length; idx++) {
        const ln = idx + 1;
        if (isSelfFile && ln >= ctx.symRange.start && ln <= ctx.symRange.end)
            continue;
        const rawLine = lines[idx];
        if (!rawLine.includes(ctx.leaf))
            continue;
        const trimmed = rawLine.trim();
        if (isCommentOnlyLine(trimmed))
            continue;
        const codeLine = stripQuotedStringLiterals(rawLine);
        if (!ctx.callRe.test(codeLine) || ctx.defLineRe.test(codeLine) || ctx.methodDefRe?.test(codeLine))
            continue;
        const encNode = findEnclosingCallNode(symsInFile, ln, fn);
        if (
            encNode.kind !== "file" &&
            ctx.homonymIds?.has(encNode.id) &&
            spanRange(encNode.span)?.start === ln
        )
            continue;
        if (ctx.alreadyLinkedCallerIds.has(encNode.id))
            continue;
        const siteKey = `${encNode.id}:${ln}`;
        if (state.seenEnclosing.has(encNode.id) || state.seenEnclosing.has(siteKey))
            continue;
        state.seenEnclosing.add(encNode.id);
        state.sites.push({
            path: fn.path,
            line: ln,
            enclosing: encNode.kind !== "file" ? encNode.name : null,
            span: encNode.kind !== "file" ? encNode.span : null,
            text: trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed,
        });
        if (state.sites.length > 16)
            return true;
    }
    return false;
}

function scanReceiverCallSitesInFiles(filesToScan, symbol, leaf, byPath, alreadyLinkedCallerIds, read, scannedFiles = null, homonymIds = null) {
    const esc = escapeRegExp(leaf);
    const isGeneric = GENERIC_MEMBER_NAMES.has(leaf.toLowerCase());
    const callParts = [
        `(?:\\.|::|:|->)\\s*${esc}\\s*\\(`,
        `(?:\\.|::)\\s*${esc}\\b(?!\\s*[=(:])`,
    ];
    if (!isGeneric && leaf.length >= 4)
        callParts.push(`(?<![A-Za-z0-9_$.])\\b${esc}\\s*\\(`);
    const ctx = {
        symbol,
        symRange: spanRange(symbol.span),
        leaf,
        callRe: new RegExp(callParts.join("|")),
        defLineRe: new RegExp(`\\b(?:function|def|fn|func)\\b[^(\\n]*\\b${esc}\\s*\\(`),
        methodDefRe: new RegExp(`^\\s*(?:(?:public|private|protected|static|async|export|override)\\s+)*${esc}\\s*\\([^)\\n]*\\)\\s*(?::[^={;\\n]+)?(?:\\{|;)`),
        alreadyLinkedCallerIds,
        homonymIds,
        read,
    };
    const state = { sites: [], seenEnclosing: new Set() };
    let truncated = false;
    for (const fn of filesToScan) {
        if (scanSingleFileReceiverSites(fn, byPath.get(fn.path) ?? [], ctx, state)) {
            truncated = true;
            break;
        }
    }
    if (isGeneric && truncated)
        return { sites: [], truncated: false, scannedFiles };
    return { sites: state.sites.slice(0, 16), truncated, scannedFiles };
}

function collectUnlinkedReceiverCallSites(graph, symbol, hits, direction, read, contextDir = null, preloadedAskIdx = undefined) {
    if (direction !== "in" || !graph || !Array.isArray(graph.nodes) || !symbol || symbol.kind === "file")
        return { sites: [], truncated: false };
    const rawName = String(symbol.name ?? "");
    const leaf = rawName.split(/[.:#]/).pop() ?? "";
    const eligibleKind =
        symbol.kind === "method" ||
        (symbol.kind === "function" && (Boolean(symbol.owner) || rawName.includes(".") || Boolean(symbol.exported)));
    if (!eligibleKind || leaf.length < 3 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(leaf))
        return { sites: [], truncated: false };
    const ctx = collectReceiverScanContext(graph, symbol, hits);
    const filesToScan = filterScanFilesByAskIndex(ctx.candidateFiles, ctx.leaf, graph, contextDir, preloadedAskIdx, ctx.byPath, read);
    return scanReceiverCallSitesInFiles(filesToScan, symbol, ctx.leaf, ctx.byPath, ctx.alreadyLinkedCallerIds, read, ctx.candidateFiles.length, ctx.homonymIds);
}

function formatUnlinkedReceiverFooter(symbol, unlinked, hitsCount = 0) {
    const leaf = String(symbol.name ?? "").split(/[.:#]/).pop() ?? symbol.name;
    const isGeneric = GENERIC_MEMBER_NAMES.has(String(leaf ?? "").toLowerCase());
    if (!unlinked?.sites?.length) {
        if (hitsCount === 0 && !isGeneric && typeof unlinked?.scannedFiles === "number") {
            return `  unlinked scan: 0 unlinked references across ${unlinked.scannedFiles} reachable files`;
        }
        return null;
    }
    const scanNote = typeof unlinked.scannedFiles === "number"
        ? `, scanned ${unlinked.scannedFiles} reachable files`
        : "";
    const lines = [`  unlinked .${leaf}() call sites (${unlinked.sites.length}${unlinked.truncated ? "+" : ""}${scanNote}):`];
    for (const s of unlinked.sites) {
        const label = s.enclosing ? `${s.enclosing} (${s.path}:${s.span})` : s.path;
        lines.push(`    ? ${label} → ${fmtLine(s.line, s.text)}`);
    }
    if (unlinked.truncated) {
        lines.push(`    … more unlinked sites — run plexer grep ".${leaf}(" --fixed`);
    }
    return lines.join("\n");
}

function indexNamedCallerSpans(hits) {
    const namedSpansByPath = new Map();
    const namedNeedlesByPath = new Map();
    for (const h of hits) {
        if (!h.node || h.node.kind === "file")
            continue;
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
    return { namedSpansByPath, namedNeedlesByPath };
}

function computeHitExcludesAndNeedles(h, namedSpansByPath, namedNeedlesByPath) {
    if (h.node?.kind === "file") {
        return {
            extraExcludes: namedSpansByPath.get(h.node.path) ?? [],
            extraNeedles: namedNeedlesByPath.get(h.node.path) ?? [],
        };
    }
    const hRange = h.node ? spanRange(h.node.span) : null;
    if (!hRange)
        return { extraExcludes: [], extraNeedles: [] };
    const hLen = hRange.end - hRange.start;
    const extraExcludes = (namedSpansByPath.get(h.node.path) ?? []).filter(
        (r) => r.start >= hRange.start && r.end <= hRange.end && r.end - r.start < hLen,
    );
    return { extraExcludes, extraNeedles: [] };
}

function appendTrailingMatchFooters(lines, symbol, hits, direction, unlinked, testLinks) {
    const unlinkedFooter = formatUnlinkedReceiverFooter(symbol, unlinked, hits.length);
    if (unlinkedFooter)
        lines.push(unlinkedFooter);
    const footer = coveringTestsFooter(symbol, hits, direction, testLinks);
    if (footer)
        lines.push(footer);
}

export function renderMatchBlock(symbol, hits, direction, showDepth, candidateCount, read, opts = {}) {
    const testLinks = opts.testLinks ?? (opts.graph ? linkTestsForGraph(opts.graph) : null);
    const unlinked = opts.unlinked ?? (opts.graph ? collectUnlinkedReceiverCallSites(opts.graph, symbol, hits, direction, read, opts.contextDir, opts.askIndex) : null);
    const seenSourceIds = opts.seenSourceIds ?? new Set();
    const sourceBudget = opts.sourceBudget ?? { bytes: 0, maxBytes: 5400 };
    const head = headerOf(symbol);
    const lines = [head];
    sourceBudget.bytes += Buffer.byteLength(head, "utf8") + 1;
    if (opts.source && !seenSourceIds.has(symbol.id) && sourceBudget.bytes < sourceBudget.maxBytes) {
        const sr = symbol.kind !== "file" ? spanRange(symbol.span) : null;
        const symLines = sr ? sr.end - sr.start + 1 : 0;
        if (!opts.full && opts.seenSpans && sr && symLines >= 15 && isSpanCovered(opts.seenSpans, symbol.path, sr.start, sr.end)) {
            seenSourceIds.add(symbol.id);
            const marker = `// [seen: ${symbol.path}:${symbol.span}; --full]`;
            lines.push(marker);
            sourceBudget.bytes += Buffer.byteLength(marker, "utf8") + 1;
        }
        else {
            const src = formatSymbolSource(symbol, read);
            if (src) {
                seenSourceIds.add(symbol.id);
                lines.push(src);
                sourceBudget.bytes += Buffer.byteLength(src, "utf8") + 1;
                if (opts.shownTargetSpans && sr) {
                    if (symLines <= MAX_SUBJECT_SOURCE_LINES) {
                        opts.shownTargetSpans.push({ file: symbol.path, start: sr.start, end: sr.end });
                    }
                    else {
                        opts.shownTargetSpans.push({ file: symbol.path, start: sr.start, end: sr.start + 23 });
                        opts.shownTargetSpans.push({ file: symbol.path, start: Math.max(sr.start, sr.end - 5), end: sr.end });
                    }
                }
            }
        }
    }
    if (hits.length === 0) {
        lines.push(looseNoteFor(direction, symbol.name, candidateCount));
        appendTrailingMatchFooters(lines, symbol, hits, direction, unlinked, testLinks);
        return lines.join("\n");
    }
    const needles = needlesForName(symbol.name);
    const rootIsFile = symbol.kind === "file";
    // When a file-level caller appears alongside named callers in the same file,
    // exclude the named callers' spans from the file-level caller's quote search.
    const { namedSpansByPath, namedNeedlesByPath } = indexNamedCallerSpans(hits);
    let sourceIndex = 0;
    const hardMaxBytes = opts.hardMaxBytes ?? Infinity;
    for (let hIdx = 0; hIdx < hits.length; hIdx++) {
        if (sourceBudget.bytes >= hardMaxBytes) {
            const label = direction === "out" ? "callees" : "callers";
            lines.push(`  … (+${hits.length - hIdx} more ${label} — narrow symbols or --depth)`);
            break;
        }
        const h = hits[hIdx];
        const { extraExcludes, extraNeedles } = computeHitExcludesAndNeedles(h, namedSpansByPath, namedNeedlesByPath);
        const allowQuote = !opts.omitQuotes && sourceBudget.bytes < sourceBudget.maxBytes;
        const quote = allowQuote
            ? quoteFor(h, needles, read, {
                symbol,
                rootIsFile,
                excludeRanges: extraExcludes,
                extraNeedles,
                source: Boolean(opts.source),
                sourceIndex,
                seenSourceIds,
                shownTargetSpans: opts.shownTargetSpans ?? null,
                sourceBudget,
            })
            : undefined;
        if (opts.source && h.node && !isTestPath(h.node.path))
            sourceIndex++;
        const rendered = hitLine(direction, h, showDepth, quote, { rootIsFile, source: Boolean(opts.source) });
        sourceBudget.bytes += Buffer.byteLength(rendered, "utf8") + 1;
        lines.push(rendered);
    }
    if (opts.sharedTransitiveNote)
        lines.push(opts.sharedTransitiveNote);
    appendTrailingMatchFooters(lines, symbol, hits, direction, unlinked, testLinks);
    return lines.join("\n");
}

export function looseNoteFor(direction, name, candidateCount) {
    const label = direction === "out" ? "callees" : "callers";
    const dir = direction === "out" ? "outgoing" : "incoming";
    const ambiguity = candidateCount > 1 ? ` (${candidateCount} ambiguous "${name}" defs)` : "";
    return `  no indexed ${label} (${dir} edges absent)${ambiguity} — try \`plexer grep "${name}"\` (bare name or Type.method).`;
}

function partitionLexicalFallbackNodes(graph) {
    const byPath = new Map();
    const fileNodes = [];
    for (const n of graph.nodes) {
        if (!n.path)
            continue;
        if (n.kind === "file") {
            fileNodes.push(n);
            continue;
        }
        const r = spanRange(n.span);
        if (!r)
            continue;
        const list = byPath.get(n.path) ?? [];
        list.push({ node: n, start: r.start, end: r.end, len: r.end - r.start });
        byPath.set(n.path, list);
    }
    return { byPath, fileNodes };
}

function findSmallestNonSelfCandidate(candidates, lineNum, symbolId) {
    let best = null;
    for (const c of candidates) {
        if (c.node.id !== symbolId && lineNum >= c.start && lineNum <= c.end && (!best || c.len < best.len))
            best = c;
    }
    return best;
}

function appendFileLexicalHits(fn, symbol, symRange, needles, candidates, read, seenNodeIds, hits) {
    const excludeRanges = fn.path === symbol.path && symRange ? [symRange] : [];
    const matches = referenceLines(fn.path, fn.span || "L1-L999999", needles, read, {
        excludeRanges,
        maxMatches: 4,
        contextLines: 0,
    });
    for (const m of matches) {
        const best = findSmallestNonSelfCandidate(candidates, m.n, symbol.id);
        const targetNode = best ? best.node : fn;
        if (seenNodeIds.has(targetNode.id))
            continue;
        seenNodeIds.add(targetNode.id);
        hits.push({ id: targetNode.id, relation: "references", depth: 1, node: targetNode });
        if (hits.length >= 10)
            return true;
    }
    return false;
}

function lexicalFallbackHits(graph, symbol, read) {
    if (!graph || !Array.isArray(graph.nodes) || !symbol?.name || symbol.name.length < 3)
        return [];
    const needles = needlesForName(symbol.name);
    if (needles.length === 0)
        return [];
    const symRange = spanRange(symbol.span);
    const { byPath, fileNodes } = partitionLexicalFallbackNodes(graph);
    const hits = [];
    const seenNodeIds = new Set([symbol.id]);
    for (const fn of fileNodes) {
        if (isTestPath(fn.path) && hits.length >= 6)
            continue;
        const full = appendFileLexicalHits(fn, symbol, symRange, needles, byPath.get(fn.path) ?? [], read, seenNodeIds, hits);
        if (full)
            return hits;
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

export function resolveCliChoice(raw, flagLabel, allowed, defaultValue) {
    if (raw === undefined)
        return defaultValue;
    if (allowed.includes(raw))
        return raw;
    const listStr = allowed.length === 2
        ? `"${allowed[0]}" or "${allowed[1]}"`
        : `${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`;
    console.error(`✗ ${flagLabel} must be ${listStr}, got "${raw}"`);
    process.exit(1);
}

export function resolveDirection(raw) {
    return resolveCliChoice(raw, "--direction", ["in", "out"], "in");
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

function missingSymbolMessage(graph, q, inPrefix) {
    const suggestions = suggestNearTargets(graph, q, inPrefix, 3);
    const tail = suggestions.length
        ? `did you mean: ${suggestions.join(", ")}?`
        : "check spelling or run plexer build";
    return `no symbol "${q}" in the graph — ${tail}`;
}

function resolveSingleQueryMatches(graph, q, opts) {
    try {
        return resolveSymbol(graph, q, opts.in ? { in: opts.in } : {});
    }
    catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return null;
    }
}

function handleEmptyQueryMatches(graph, read, q, queryCount, direction, opts, allResults) {
    if (!opts.json && direction === "in") {
        const pseudo = { id: `__query__:${q}`, name: q, kind: "reference", path: "", span: "" };
        const lexHits = lexicalFallbackHits(graph, pseudo, read);
        if (lexHits.length > 0) {
            allResults.push({ query: q, symbol: pseudo, candidateCount: 1, hits: lexHits });
            return;
        }
    }
    if (queryCount === 1) {
        console.error(`✗ ${missingSymbolMessage(graph, q, opts.in)}`);
        process.exit(1);
    }
    const suggestions = suggestNearTargets(graph, q, opts.in, 3);
    const skipTail = suggestions.length ? `did you mean: ${suggestions.join(", ")}? (skipping)` : "skipping";
    console.error(`⚠ no symbol "${q}" in the graph — ${skipTail}`);
}

function collectCallerMatchesForQueries(graph, read, queries, direction, depth, opts) {
    const allResults = [];
    const seenSymbolIds = new Set();
    for (const q of queries) {
        const matches = resolveSingleQueryMatches(graph, q, opts);
        if (!matches)
            return null;
        if (matches.length === 0) {
            handleEmptyQueryMatches(graph, read, q, queries.length, direction, opts, allResults);
            continue;
        }
        for (const symbol of matches) {
            if (seenSymbolIds.has(symbol.id))
                continue;
            seenSymbolIds.add(symbol.id);
            let hits = edgeWalk(graph, symbol, direction, depth);
            const usesReceiverFooter =
                symbol.kind === "method" ||
                (symbol.kind === "function" && (Boolean(symbol.owner) || String(symbol.name ?? "").includes(".")));
            if (hits.length === 0 && direction === "in" && !usesReceiverFooter)
                hits = lexicalFallbackHits(graph, symbol, read);
            allResults.push({ query: q, symbol, candidateCount: matches.length, hits });
        }
    }
    return allResults;
}

function formatCallersJsonPayload(queries, allResults, graph, direction, read, contextDir, askIndex) {
    return {
        query: queries.length === 1 ? queries[0] : queries,
        matches: allResults.map((r) => {
            const m = { symbol: symbolJson(r.symbol), hits: r.hits.map(hitJson) };
            if (r.hits.truncated)
                m.truncated = true;
            const unlinked = collectUnlinkedReceiverCallSites(graph, r.symbol, r.hits, direction, read, contextDir, askIndex);
            if (unlinked.sites.length > 0)
                m.unlinkedCallSites = unlinked.sites;
            if (r.hits.length === 0)
                m.note = looseNoteFor(direction, r.symbol.name, r.candidateCount);
            return m;
        }),
    };
}

function dedupeCrossQueryCallerHits(hits, symbol, candidateCount, idx, totalResults, seenHomonymKeys, seenDepth, direction = "in") {
    let dedupedHits = candidateCount > 1 && idx > 0
        ? hits.filter((h) => !seenHomonymKeys.has(`${symbol.name}:${h.id}:${h.relation}:${h.depth}`))
        : hits;
    let sharedTransitiveNote = null;
    if (totalResults > 1 && idx > 0 && dedupedHits.length > 0) {
        const skippedVia = new Set();
        let skippedCount = 0;
        dedupedHits = dedupedHits.filter((h) => {
            if (h.depth <= 1)
                return true;
            const prev = seenDepth.get(h.id);
            if (prev && prev.depth <= h.depth) {
                skippedCount++;
                skippedVia.add(prev.sym);
                return false;
            }
            return true;
        });
        if (skippedCount > 0) {
            const label = direction === "out" ? "callees" : "callers";
            sharedTransitiveNote = `  (+${skippedCount} transitive ${label} already listed above under ${[...skippedVia].slice(0, 3).join(", ")})`;
        }
    }
    for (const h of dedupedHits) {
        seenHomonymKeys.add(`${symbol.name}:${h.id}:${h.relation}:${h.depth}`);
        const prev = seenDepth.get(h.id);
        if (!prev || h.depth < prev.depth)
            seenDepth.set(h.id, { depth: h.depth, sym: symbol.name });
    }
    return { dedupedHits, sharedTransitiveNote };
}

function renderCallersTextBlocks(allResults, graph, direction, showDepth, read, opts, contextDir, askIndex) {
    const blocks = [];
    const seenSourceIds = new Set();
    const seenHomonymKeys = new Set();
    const seenDepth = new Map();
    const testLinks = direction === "in" ? linkTestsForGraph(graph) : null;
    const label = direction === "out" ? "callees" : "callers";
    const totalHardCap = opts.full ? 8600 : 7200;
    const quotePoolCap = opts.full
        ? (allResults.length > 1 ? 5600 : 7200)
        : (allResults.length > 1 ? 4600 : 5800);
    const maxBytesPerSymbol = allResults.length > 1 ? Math.max(900, Math.floor(quotePoolCap / allResults.length)) : quotePoolCap;
    let totalBytes = 0;
    for (let idx = 0; idx < allResults.length; idx++) {
        if (totalBytes >= totalHardCap) {
            blocks.push(`… (+${allResults.length - idx} more symbols omitted to fit 9 KB budget — query remaining symbols separately)`);
            break;
        }
        const { symbol, candidateCount, hits } = allResults[idx];
        const remainingQuote = Math.max(0, quotePoolCap - totalBytes);
        const remainingHard = Math.max(400, totalHardCap - totalBytes);
        const { dedupedHits, sharedTransitiveNote } = dedupeCrossQueryCallerHits(
            hits, symbol, candidateCount, idx, allResults.length, seenHomonymKeys, seenDepth, direction,
        );
        if (idx > 0 && candidateCount > 1 && dedupedHits.length === 0 && hits.length > 0) {
            blocks.push(`${headerOf(symbol)}\n  (shared/transitive ${label} shown above)`);
            continue;
        }
        const sourceBudget = { bytes: 0, maxBytes: Math.min(maxBytesPerSymbol, remainingQuote) };
        const renderedBlock = renderMatchBlock(symbol, dedupedHits, direction, showDepth, candidateCount, read, {
            source: opts.source && remainingQuote > 0,
            full: Boolean(opts.full),
            omitQuotes: remainingQuote <= 0,
            hardMaxBytes: remainingHard,
            sharedTransitiveNote,
            seenSourceIds,
            sourceBudget,
            seenSpans: opts.seenSpans ?? null,
            shownTargetSpans: opts.shownTargetSpans ?? null,
            graph,
            contextDir,
            askIndex,
            testLinks,
        });
        const truncNote = hits.truncated ? `\n  … (closure truncated at ${hits.length} ${label})` : "";
        const finalBlock = renderedBlock + truncNote;
        blocks.push(finalBlock);
        totalBytes += Buffer.byteLength(finalBlock, "utf8") + 2;
    }
    return blocks;
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
    const read = fileReader(root);
    const allResults = collectCallerMatchesForQueries(graph, read, queries, direction, depth, opts);
    if (!allResults)
        return;
    if (allResults.length === 0) {
        console.error(`✗ ${missingSymbolMessage(graph, queries.join(", "), opts.in)}`);
        process.exit(1);
    }
    const askIndex = null;
    if (opts.json) {
        console.log(JSON.stringify(formatCallersJsonPayload(queries, allResults, graph, direction, read, contextDir, askIndex), null, 2));
        return;
    }
    const sessionState = !opts.full && opts.sessionId ? readAgySession(opts.sessionId) : null;
    const shownTargetSpans = sessionState ? [] : null;
    const blocks = renderCallersTextBlocks(allResults, graph, direction, depth > 1, read, {
        ...opts,
        seenSpans: sessionState?.seenSpans ?? null,
        shownTargetSpans,
    }, contextDir, askIndex);
    const outText = `${blocks.join("\n\n")}\n`;
    if (sessionState && shownTargetSpans.length > 0 && Buffer.byteLength(outText, "utf8") <= 9500) {
        sessionState.seenSpans = sessionState.seenSpans && typeof sessionState.seenSpans === "object"
            ? sessionState.seenSpans
            : {};
        for (const sp of shownTargetSpans) {
            mergeSpan(sessionState.seenSpans, sp.file, sp.start, sp.end);
        }
        writeAgySession(opts.sessionId, sessionState);
    }
    process.stdout.write(outText);
}