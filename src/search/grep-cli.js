/**
 * CLI wiring + human formatter for `plexer grep`.
 *
 * Kept out of bin/plexer.js (argument wiring only) and out of grep.js (pure core,
 * unit-testable against hand-built fixture graphs without touching a real
 * repo root) — same split as traverse.js/traverse-cli.js. `formatGrepResult`
 * is exported so `plexer_find_all` in `src/mcp/tools.js` renders the identical
 * report, rather than re-implementing it.
 */
import { resolve } from "node:path";
import { plural } from "../util/span.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../context/graph-store.js";
import { grepGraph } from "./grep.js";
function groupHeader(g) {
    if (g.symbol)
        return `${g.symbol.name} · ${g.symbol.kind} · ${g.symbol.path}:${g.symbol.span} · ${g.inDegree} in-edges`;
    return `${g.path} (module level) · ${g.inDegree} in-edges`;
}
function formatGroup(g, allowContext = true) {
    const lines = [groupHeader(g)];
    if (allowContext && g.contextBlocks && g.contextBlocks.length > 0) {
        g.contextBlocks.forEach((block, idx) => {
            if (idx > 0)
                lines.push("  …");
            for (const row of block.lines) {
                const text = row.text.length > 140 ? `${row.text.slice(0, 137)}…` : row.text;
                lines.push(`  L${row.line}: ${text}`);
            }
        });
    }
    else {
        for (const h of g.hits) {
            const text = h.text.length > 140 ? `${h.text.slice(0, 137)}…` : h.text;
            lines.push(`  L${h.line}: ${text}`);
        }
    }
    if (g.omittedHits > 0)
        lines.push(`  … (+${g.omittedHits} more in this symbol)`);
    return lines.join("\n");
}
/** `"<pattern>" — N hits in M symbols across K files (searched T indexed files)` */
function formatGrepHeader(result) {
    const filesHit = new Set(result.groups.map((g) => g.path)).size;
    const noteSuffix = result.regexFallbackNote ? `  ${result.regexFallbackNote}` : "";
    return `"${result.pattern}" — ${result.totalHits} hits in ${result.groups.length} symbols across ${filesHit} files (searched ${result.filesSearched} indexed files)${noteSuffix}`;
}
/** Loud truncation note — dropped counts are never silent. */
function truncationNote(result) {
    const { files, hits } = result.truncated;
    if (files === 0 && hits === 0)
        return null;
    const parts = [];
    if (hits > 0)
        parts.push(`${plural(hits, "more hit")} beyond the cap`);
    if (files > 0)
        parts.push(`${plural(files, "indexed file")} unreadable`);
    return `(truncated: ${parts.join(", ")} — narrow with --in or refine the pattern)`;
}
/** Full human report: header, blank line, then one block per group (header +
 * indented hit lines), each block separated by a blank line. */
export function formatGrepResult(result, opts = {}) {
    const explicitCtx = Boolean(opts.explicitContext);
    const totalHits = result.totalHits ?? result.hits ?? 0;
    const defaultMaxBytes = explicitCtx ? 4800 : 3000;
    const maxBytes = opts.maxBytes ?? defaultMaxBytes;
    const contextCapBytes = opts.contextCapBytes ?? Math.min(explicitCtx ? 3600 : 2100, Math.floor(maxBytes * 0.72));
    const note = truncationNote(result);
    const head = note ? `${formatGrepHeader(result)}\n${note}` : formatGrepHeader(result);
    const hasContext = result.groups.some((g) => g.contextBlocks && g.contextBlocks.length > 0);
    const maxContextGroups = explicitCtx
        ? 10
        : (totalHits > 16 ? 0 : (totalHits > 8 || result.groups.length > 5 ? 3 : 10));
    const maxGroups = (!hasContext || maxContextGroups === 0) ? 20 : 12;
    const shown = result.groups.slice(0, maxGroups);
    const blocks = [head, ""];
    let totalBytes = Buffer.byteLength(head, "utf8");
    for (let idx = 0; idx < shown.length; idx++) {
        const g = shown[idx];
        const allowContext = idx < maxContextGroups && totalBytes < contextCapBytes;
        const formatted = formatGroup(g, allowContext) + "\n";
        const fb = Buffer.byteLength(formatted, "utf8");
        if (idx > 0 && totalBytes + fb > maxBytes)
            break;
        totalBytes += fb;
        blocks.push(formatted);
        if (totalBytes >= maxBytes)
            break;
    }
    const renderedGroups = blocks.length - 2;
    if (result.groups.length > renderedGroups) {
        blocks.push(`… (+${result.groups.length - renderedGroups} more symbols — narrow with --in <path>)\n`);
    }
    return blocks.join("\n").replace(/\n+$/, "\n");
}
/** Loud, actionable zero-hit note (never a bare empty result) — printed to
 * stderr; the caller still exits 0, since "no hits in the indexed graph" is
 * not an error, just a reason to fall back to a real grep.
 *
 * Truncation is never silent, even on the zero-hit path: if some indexed
 * files couldn't be read (`truncated.files > 0`), that's called out too —
 * otherwise a zero-hit result on a stale graph or wrong root reads as "no
 * matches" when really some files were never searched at all. */
export function zeroHitNote(result) {
    const base = `no hits for "${result.pattern}" in ${result.filesSearched} indexed files. The pattern may be too specific — retry plexer grep with a bare symbol name or short substring (drop the receiver, full signature, and regex anchors). All indexed code was searched; use raw grep -rn only for genuinely unindexed files (docs, configs, brand-new files)`;
    const notes = [];
    const { files } = result.truncated ?? { files: 0 };
    if (files > 0)
        notes.push(`${plural(files, "indexed file")} could not be read (stale graph? run plexer build)`);
    if (result.ignoredDirs?.length > 0)
        notes.push(`matches exist inside git-ignored paths (${result.ignoredDirs.join(", ")})`);
    if (notes.length === 0)
        return base;
    return `${base} — note: ${notes.join("; ")}`;
}
export function runGrepWithRegexFallback(grepFn, pattern, opts) {
    try {
        return grepFn(pattern, opts);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isSafeSyntaxErr = !opts.fixed && err instanceof SyntaxError && !/catastrophic backtracking|exceeds max length/i.test(msg);
        if (!isSafeSyntaxErr)
            throw err;
        const literalPattern = String(pattern).replace(/\\([().+?^${}[\]|])/g, "$1");
        const res = grepFn(literalPattern, { ...opts, fixed: true });
        if (res && typeof res === "object") {
            const target = res.result && typeof res.result === "object" ? res.result : res;
            target.regexFallbackNote = `(invalid regex; matched literal "${literalPattern}")`;
        }
        return res;
    }
}

/**
 * Resolve the graph at `dir` (respecting `--dir`), run `grepGraph`, and print
 * either the human report or `--json`. Exits the process (code 1) when
 * there's no graph at all or the pattern fails ReDoS validation.
 * Unescaped regex syntax errors automatically fall back to literal search.
 */
export function runGrepCommand(patternInput, dir, opts) {
    const root = resolve(dir);
    const contextDir = contextDirFor(root, opts.globalDir);
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        console.error("✗ no graph — run plexer build first");
        process.exit(1);
    }
    const patterns = (Array.isArray(patternInput) ? patternInput : [patternInput]).filter(Boolean);
    const results = [];
    for (const pattern of patterns) {
        try {
            const r = runGrepWithRegexFallback(
                (pat, gOpts) => grepGraph(graph, root, pat, {
                    ignoreCase: gOpts.ignoreCase,
                    fixed: gOpts.fixed,
                    in: gOpts.in,
                    context: gOpts.context !== undefined ? Number(gOpts.context) : undefined,
                    source: gOpts.source,
                }),
                pattern,
                opts,
            );
            results.push(r);
        }
        catch (err) {
            // ReDoS or unindexed `--in` prefix errors still exit 1 loudly.
            const message = err instanceof Error ? err.message : String(err);
            console.error(err instanceof SyntaxError ? `✗ invalid pattern "${pattern}": ${message}` : `✗ ${message}`);
            process.exit(1);
            return;
        }
    }
    if (opts.json) {
        console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
        return;
    }
    const hitResults = results.filter((r) => r.totalHits > 0);
    const missResults = results.filter((r) => r.totalHits === 0);
    if (missResults.length > 0) {
        if (patterns.length >= 2 && hitResults.length > 0) {
            const labels = missResults.map((r) => `"${r.pattern}"`).join(", ");
            console.error(`no hits in ${missResults[0].filesSearched} indexed files for: ${labels}`);
        }
        else {
            for (const r of missResults)
                console.error(zeroHitNote(r));
        }
    }
    if (hitResults.length > 0) {
        const singleBudget = opts.explicitContext ? 4800 : 3000;
        const perPatternBudget = hitResults.length >= 2 ? Math.max(850, Math.floor(7200 / hitResults.length)) : singleBudget;
        const outBlocks = hitResults.map((r) => formatGrepResult(r, { maxBytes: perPatternBudget, explicitContext: Boolean(opts.explicitContext) }).trimEnd());
        process.stdout.write(`${outBlocks.join("\n\n")}\n`);
    }
}
