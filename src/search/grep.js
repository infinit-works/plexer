/**
 * `plexer grep` core: regex search over the graph's indexed files, with hits
 * grouped by their innermost enclosing symbol and ranked by incoming-edge
 * count (coupling) — a grep that answers "which of these hits matters",
 * because plain `grep -rn` gives no way to tell a hit inside a
 * heavily-depended-on function from one inside dead code.
 *
 * Pure I/O + regex, no CLI/MCP concerns: `grep-cli.js` formats this into
 * human text and wires the CLI command; `mcp/tools.js` renders the same
 * shape for the `plexer_find_all` tool.
 */
import { join } from "node:path";
import { isTestPath } from "../ask/ask.js";
import { escapeRegExp, spanRange } from "../blast/evidence.js";
import { computeInDegree } from "../graph/relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "../graph/scopes.js";
import { normalizePathPrefix, pushMap } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
const DEFAULT_MAX_HITS = 120;
const DEFAULT_MAX_HITS_PER_SYMBOL = 8;
const MAX_HIT_TEXT = 160;
/** Innermost symbol containing `line`: among spans that contain it, the one
 * with the greatest start line. Symbols are pre-sorted ascending by start,
 * so the last containing match seen wins, and the scan can stop as soon as
 * a span starts after `line` — nothing later in the sort can contain it. */
function enclosingSymbol(symbols, line) {
    let found = null;
    for (const s of symbols) {
        if (s.start > line)
            break;
        if (line <= s.end)
            found = s.node;
    }
    return found;
}
function toSymbolRef(n) {
    const hash = n.id.indexOf("#");
    return { id: n.id, name: hash >= 0 ? n.id.slice(hash + 1) : n.name, kind: n.kind, path: n.path, span: n.span };
}
export function grepGraph(graph, repoRoot, pattern, opts = {}) {
    const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
    const maxHitsPerSymbol = opts.maxHitsPerSymbol ?? DEFAULT_MAX_HITS_PER_SYMBOL;
    const explicitContext = opts.context !== undefined && opts.context !== null;
    const baseContextLines = Math.max(0, Number(opts.context ?? (opts.source ? 2 : 0)) || 0);
    const source = opts.fixed
        ? pattern.includes("\\|") || /^[A-Za-z0-9_.:#\s-]+(?:\|[A-Za-z0-9_.:#\s-]+)+$/.test(pattern)
            ? pattern.split(/\\?\||\|/).map(escapeRegExp).join("|")
            : escapeRegExp(pattern)
        : pattern.replace(/\\\|/g, "|");
    const regex = new RegExp(source, opts.ignoreCase ? "i" : "");
    const inDegree = computeInDegree(graph);
    const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
    if (inPrefix)
        assertPrefixIndexed(graph, inPrefix);
    const fileNodes = [];
    const symbolsByPath = new Map();
    for (const n of graph.nodes) {
        if (inPrefix !== undefined && !pathUnderPrefix(n.path, inPrefix))
            continue;
        if (n.kind === "file") {
            fileNodes.push(n);
            continue;
        }
        const b = spanRange(n.span);
        if (!b)
            continue;
        pushMap(symbolsByPath, n.path, { node: n, start: b.start, end: b.end });
    }
    const groups = new Map();
    const linesByPath = (baseContextLines > 0 || opts.source) ? new Map() : null;
    let totalMatchedLines = 0;
    let truncatedFiles = 0;
    for (const file of fileNodes) {
        let text;
        try {
            const decoded = readSourceFile(join(repoRoot, file.path));
            if (decoded === null) {
                truncatedFiles++;
                continue;
            }
            text = decoded;
        }
        catch {
            truncatedFiles++;
            continue;
        }
        let symbols;
        const lines = text.split("\n");
        let fileHasHit = false;
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (!regex.test(raw))
                continue;
            fileHasHit = true;
            totalMatchedLines++;
            const lineNo = i + 1;
            if (!symbols) {
                symbols = symbolsByPath.get(file.path) ?? [];
                symbols.sort((a, b) => a.start - b.start);
            }
            const sym = enclosingSymbol(symbols, lineNo);
            const key = sym ? sym.id : `file:${file.path}`;
            let group = groups.get(key);
            if (!group) {
                group = {
                    symbol: sym ? toSymbolRef(sym) : null,
                    path: file.path,
                    inDegree: sym ? (inDegree.get(sym.id) ?? 0) : 0,
                    hits: [],
                    omittedHits: 0,
                };
                groups.set(key, group);
            }
            if (group.hits.length >= maxHitsPerSymbol) {
                group.omittedHits = (group.omittedHits ?? 0) + 1;
                continue;
            }
            const trimmed = raw.trim();
            group.hits.push({ line: lineNo, text: trimmed.length > MAX_HIT_TEXT ? trimmed.slice(0, MAX_HIT_TEXT) : trimmed });
        }
        if (fileHasHit && linesByPath)
            linesByPath.set(file.path, lines);
    }
    const candTerms = pattern
        .split(/\\?\||\|/)
        .map((t) =>
            t
                .replace(/^(?:\\b|\\\.|[.:#^$\s])+|(?:\\b|\\\.|[.:#$()\s])+$/g, "")
                .toLowerCase(),
        )
        .filter((t) => t.length >= 2);
    const symNameMatchRank = (g) => {
        if (!g.symbol?.name || candTerms.length === 0)
            return 2;
        const nameLower = g.symbol.name.toLowerCase();
        const sep = Math.max(nameLower.lastIndexOf("."), nameLower.lastIndexOf(":"), nameLower.lastIndexOf("#"));
        const bare = sep >= 0 ? nameLower.slice(sep + 1) : nameLower;
        let best = 2;
        for (const normPat of candTerms) {
            if (nameLower === normPat || bare === normPat)
                return 0;
            if (bare.includes(normPat))
                best = 1;
        }
        return best;
    };
    const allSortedGroups = [...groups.values()].sort(
        (a, b) =>
            Number(isTestPath(a.path)) - Number(isTestPath(b.path)) ||
            symNameMatchRank(a) - symNameMatchRank(b) ||
            b.inDegree - a.inDegree ||
            a.path.localeCompare(b.path),
    );
    const nonTestGroupCount = allSortedGroups.filter((g) => !isTestPath(g.path)).length || allSortedGroups.length;
    const contextLines = explicitContext
        ? baseContextLines
        : !opts.source && baseContextLines === 0
            ? 0
            : nonTestGroupCount <= 4
                ? 2
                : nonTestGroupCount <= 8
                    ? 1
                    : 0;
    const keptGroups = [];
    let collected = 0;
    let truncatedHits = 0;
    for (const g of allSortedGroups) {
        if (collected >= maxHits) {
            truncatedHits += g.hits.length + (g.omittedHits ?? 0);
            continue;
        }
        const remaining = maxHits - collected;
        if (g.hits.length > remaining) {
            const droppedInGroup = g.hits.length - remaining;
            g.hits = g.hits.slice(0, remaining);
            g.omittedHits = (g.omittedHits ?? 0) + droppedInGroup;
            truncatedHits += droppedInGroup;
        }
        collected += g.hits.length;
        if (linesByPath && g.hits.length > 0) {
            const fileLines = linesByPath.get(g.path);
            if (fileLines) {
                const symSpan = g.symbol ? spanRange(g.symbol.span) : null;
                const minLine = symSpan ? Math.max(1, symSpan.start) : 1;
                const maxLine = symSpan ? Math.min(fileLines.length, symSpan.end) : fileLines.length;
                const symSpanLen = symSpan ? maxLine - minLine + 1 : Infinity;
                const fullShortSym = symSpanLen <= (symNameMatchRank(g) === 0 ? 22 : Math.max(12, contextLines * 3));
                const matchSet = new Set(g.hits.map((h) => h.line));
                const windows = [];
                for (const h of g.hits) {
                    const hitRaw = (fileLines[h.line - 1] ?? "").trim();
                    const extraAfter = hitRaw.endsWith("{") ? Math.max(contextLines, 6) : contextLines;
                    const wStart = fullShortSym ? minLine : Math.max(minLine, h.line - contextLines);
                    const wEnd = fullShortSym ? maxLine : Math.min(maxLine, h.line + extraAfter);
                    const last = windows[windows.length - 1];
                    if (last && wStart <= last.end + 1)
                        last.end = Math.max(last.end, wEnd);
                    else
                        windows.push({ start: wStart, end: wEnd });
                }
                g.contextBlocks = windows.map((w) => {
                    const blockLines = [];
                    for (let ln = w.start; ln <= w.end; ln++) {
                        const raw = fileLines[ln - 1] ?? "";
                        blockLines.push({
                            line: ln,
                            text: raw.length > MAX_HIT_TEXT ? raw.slice(0, MAX_HIT_TEXT) : raw,
                            isMatch: matchSet.has(ln),
                        });
                    }
                    return { start: w.start, end: w.end, lines: blockLines };
                });
            }
        }
        keptGroups.push(g);
    }
    return {
        pattern,
        filesSearched: fileNodes.length,
        totalHits: totalMatchedLines,
        groups: keptGroups,
        truncated: { files: truncatedFiles, hits: truncatedHits },
    };
}

