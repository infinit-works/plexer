/**
 * Lightweight `plexer skeleton` implementation isolated from full `ask.js`.
 */
import { resolve } from "node:path";
import { loadGraphCached } from "../context/graph-store.js";
import { contextDirFor } from "../context/node-file.js";
import { isTestPath } from "../util/paths.js";
import { spanStart } from "../util/span.js";
import { suggestClosestFiles } from "./text-helpers.js";

function toSkeletonEntry(n) {
    return {
        file: n.path,
        name: n.name,
        kind: n.kind,
        span: n.span,
        exported: Boolean(n.exported),
        signature: n.signature,
        summary: n.summary?.split("\n")[0].trim() || undefined,
    };
}

function ensureSkeletonByPathIndex(graph) {
    if (graph._skeletonByPath && graph._skeletonNodeLen === graph.nodes.length)
        return graph._skeletonByPath;
    const byPath = new Map();
    for (const n of graph.nodes) {
        if (!n.path)
            continue;
        let list = byPath.get(n.path);
        if (!list) {
            list = [];
            byPath.set(n.path, list);
        }
        if (n.kind !== "file")
            list.push(n);
    }
    for (const list of byPath.values()) {
        list.sort((a, b) => spanStart(a.span, 0) - spanStart(b.span, 0));
    }
    Object.defineProperty(graph, "_skeletonByPath", { value: byPath, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(graph, "_skeletonNodeLen", { value: graph.nodes.length, enumerable: false, configurable: true, writable: true });
    return byPath;
}

function collectSkeletonSuffixDefs(byPath, file, normFile, suffix, caseInsensitive) {
    const exactByPath = new Map();
    const bySuffix = new Map();
    const lowerNorm = caseInsensitive ? normFile.toLowerCase() : "";
    const lowerSuffix = caseInsensitive ? suffix.toLowerCase() : "";
    for (const [p, defs] of byPath) {
        const matchedExact = caseInsensitive
            ? p.toLowerCase() === lowerNorm
            : (p === file || p === normFile);
        const matchedSuffix = !matchedExact && (caseInsensitive
            ? p.toLowerCase().endsWith(lowerSuffix)
            : p.endsWith(suffix));
        if (matchedExact) {
            exactByPath.set(p, defs);
            bySuffix.set(p, defs);
        }
        else if (matchedSuffix) {
            bySuffix.set(p, defs);
        }
    }
    return { exactByPath, bySuffix };
}

function resolveMultipleSkeletonSuffixMatches(file, bySuffix, allMatches) {
    const files = [...bySuffix.keys()].sort();
    if (allMatches) {
        const entries = [];
        for (const f of files) {
            const fileDefs = [...(bySuffix.get(f) ?? [])].sort(
                (a, b) => spanStart(a.span, 0) - spanStart(b.span, 0),
            );
            for (const n of fileDefs) {
                entries.push(toSkeletonEntry(n));
            }
        }
        return { files, entries };
    }
    return {
        file,
        entries: [],
        note: `ambiguous — matches: ${files.join(", ")}`,
        error: `ambiguous path "${file}" — matches: ${files.join(", ")}`,
    };
}

function stripFileExtension(p) {
    return String(p ?? "").replace(/\.[a-z0-9]+$/i, "");
}

function filterPathsByStem(paths, normStem, caseInsensitive) {
    const target = caseInsensitive ? normStem.toLowerCase() : normStem;
    const suffix = `/${target}`;
    return paths.filter((p) => {
        const stem = stripFileExtension(p);
        const cmp = caseInsensitive ? stem.toLowerCase() : stem;
        return cmp === target || cmp.endsWith(suffix);
    });
}

function resolveSkeletonDirectoryPrefix(file, normFile, byPath) {
    const normDir = normFile.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (!normDir)
        return null;
    const allPaths = [...byPath.keys()].sort();
    const dirPrefix = `${normDir}/`;
    let dirPaths = allPaths.filter((p) => p.startsWith(dirPrefix));
    if (!dirPaths.length) {
        const lowerPrefix = dirPrefix.toLowerCase();
        dirPaths = allPaths.filter((p) => p.toLowerCase().startsWith(lowerPrefix));
    }
    if (!dirPaths.length)
        return null;
    const nonTest = dirPaths.filter((p) => !isTestPath(p));
    const eligible = nonTest.length > 0 ? nonTest : dirPaths;
    const chosen = eligible.slice(0, 12);
    const dirMap = new Map(chosen.map((p) => [p, byPath.get(p) ?? []]));
    const res = resolveMultipleSkeletonSuffixMatches(file, dirMap, true);
    if (eligible.length > 12) {
        res.omittedFiles = eligible.length - 12;
        res.note = `showing 12 of ${eligible.length} files (${res.omittedFiles} omitted — narrow directory path)`;
    }
    return res;
}

function resolveSkeletonStemFallback(file, normFile, byPath, allMatches) {
    if (String(file ?? "").endsWith("/") || normFile.endsWith("/")) {
        const dirHit = resolveSkeletonDirectoryPrefix(file, normFile, byPath);
        if (dirHit)
            return dirHit;
    }
    const allPaths = [...byPath.keys()].sort();
    const normStem = stripFileExtension(normFile.replace(/^\.?\/+/, "").replace(/\/+$/, ""));
    if (normStem) {
        const exactStem = allPaths.filter((p) => stripFileExtension(p) === normStem || stripFileExtension(p).toLowerCase() === normStem.toLowerCase());
        if (exactStem.length === 1) {
            const onlyDefs = byPath.get(exactStem[0]) ?? [];
            if (!onlyDefs.length)
                return { file: exactStem[0], entries: [], note: "no definitions indexed for this file" };
            return { file: exactStem[0], entries: onlyDefs.map(toSkeletonEntry) };
        }
        const dirBeforeSuffix = resolveSkeletonDirectoryPrefix(file, normFile, byPath);
        if (dirBeforeSuffix)
            return dirBeforeSuffix;

        let stemPaths = filterPathsByStem(allPaths, normStem, false);
        if (!stemPaths.length)
            stemPaths = filterPathsByStem(allPaths, normStem, true);
        if (stemPaths.length === 1) {
            const onlyDefs = byPath.get(stemPaths[0]) ?? [];
            if (!onlyDefs.length)
                return { file: stemPaths[0], entries: [], note: "no definitions indexed for this file" };
            return { file: stemPaths[0], entries: onlyDefs.map(toSkeletonEntry) };
        }
        if (stemPaths.length > 1) {
            const stemMap = new Map(stemPaths.map((p) => [p, byPath.get(p) ?? []]));
            const multi = resolveMultipleSkeletonSuffixMatches(file, stemMap, allMatches);
            if (allMatches)
                return multi;
            return {
                file,
                entries: [],
                note: `ambiguous — matches: ${stemPaths.join(", ")}`,
                error: `ambiguous path "${file}" — did you mean: ${stemPaths.join(", ")}?`,
            };
        }
    }
    const dirFallback = resolveSkeletonDirectoryPrefix(file, normFile, byPath);
    if (dirFallback)
        return dirFallback;
    const suggestions = suggestClosestFiles(normFile || file, allPaths, 3);
    if (suggestions.length > 0) {
        const hint = `did you mean: ${suggestions.join(", ")}?`;
        return { file, entries: [], note: `no definitions indexed for "${file}" — ${hint}`, error: `no file "${file}" in the graph — ${hint}` };
    }
    return { file, entries: [], note: "no definitions indexed for this file" };
}

/** Signatures-only view of one file, straight from the wiring graph. */
export function skeleton(dir, file, opts = {}) {
    const outDir = contextDirFor(resolve(dir), opts.contextDir);
    const graph = loadGraphCached(outDir);
    if (!graph)
        return { file, entries: [], note: "no wiring graph — run `plexer build` first" };
    const byPath = ensureSkeletonByPathIndex(graph);
    const rootPrefix = `${resolve(dir).replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    const rawNormFile = String(file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const normFile = rawNormFile.startsWith(rootPrefix) ? rawNormFile.slice(rootPrefix.length) : rawNormFile;
    const exactMatch = byPath.get(file) ?? byPath.get(normFile);
    if (exactMatch) {
        if (!exactMatch.length)
            return { file: normFile, entries: [], note: "no definitions indexed for this file" };
        return {
            file: exactMatch[0].path,
            entries: exactMatch.map(toSkeletonEntry),
        };
    }
    const suffix = `/${normFile}`;
    let { exactByPath, bySuffix } = collectSkeletonSuffixDefs(byPath, file, normFile, suffix, false);
    if (exactByPath.size === 0 && bySuffix.size === 0) {
        ({ exactByPath, bySuffix } = collectSkeletonSuffixDefs(byPath, file, normFile, suffix, true));
    }
    let defs = null;
    if (exactByPath.size === 1) {
        const [only] = exactByPath.values();
        defs = [...only];
    }
    else if (exactByPath.size > 1) {
        return resolveMultipleSkeletonSuffixMatches(file, exactByPath, opts.allMatches);
    }
    else if (bySuffix.size > 1) {
        return resolveMultipleSkeletonSuffixMatches(file, bySuffix, opts.allMatches);
    }
    else if (bySuffix.size === 1) {
        const [only] = bySuffix.values();
        defs = [...only];
    }
    if (!defs || !defs.length)
        return resolveSkeletonStemFallback(file, normFile, byPath, opts.allMatches);
    defs.sort((a, b) => spanStart(a.span, 0) - spanStart(b.span, 0));
    return {
        file: defs[0].path,
        entries: defs.map(toSkeletonEntry),
    };
}

function renderMultiFileSkeletonSections(r, compactMode, renderLines) {
    const sections = r.files.map((file) => {
        const fileEntries = (r.entries ?? []).filter((e) => e.file === file);
        const secHead = `${file} — skeleton (${fileEntries.length} symbols)`;
        const lines = compactMode
            ? renderLines(fileEntries, 72, 0, true)
            : fileEntries.length > 30
                ? renderLines(fileEntries, 90, 60, true)
                : renderLines(fileEntries, 110, 90, false);
        return { file, secHead, lines };
    });
    const footer = r.omittedFiles > 0 ? `… (${r.note})` : "";
    const text = sections.map((s) => [s.secHead, ...s.lines].join("\n")).join("\n\n") + (footer ? `\n\n${footer}` : "") + "\n";
    return { sections, footer, text };
}

/** Render a {@link SkeletonResult} as compact markdown. */
export function formatSkeleton(r, opts = {}) {
    const renderLines = (entries, maxSigLen, maxSumLen, exportedSumOnly) =>
        entries.map((e) => {
            const showSum = maxSumLen > 0 && e.summary && (!exportedSumOnly || e.exported);
            const sum = showSum
                ? ` — ${e.summary.length > maxSumLen ? `${e.summary.slice(0, maxSumLen - 1)}…` : e.summary}`
                : "";
            const rawSig = e.signature
                ? (e.signature.length > maxSigLen ? `${e.signature.slice(0, maxSigLen - 1)}…` : e.signature)
                : "";
            const expPrefix = e.exported && !/^(?:export|pub)\b/.test(rawSig) ? "export " : "";
            if (!e.name.includes("#") && rawSig && rawSig.includes(e.name)) {
                const selfDescribing = /^(?:export\s+|local\s+|async\s+|pub\s+)*(?:function|type|class|interface|enum|struct|def|fn)\b/.test(rawSig);
                const kindTag = selfDescribing ? "" : `[${e.kind}] `;
                return `- ${e.span}  ${expPrefix}${kindTag}${rawSig}${sum}`;
            }
            const sig = rawSig ? `  ${rawSig}` : "";
            return `- ${e.span}  ${expPrefix}${e.kind} ${e.name}${sig}${sum}`;
        });
    if (Array.isArray(r.files)) {
        let rendered = renderMultiFileSkeletonSections(r, Boolean(opts.compact), renderLines);
        if (Buffer.byteLength(rendered.text, "utf8") > 6000 && !opts.compact) {
            rendered = renderMultiFileSkeletonSections(r, true, renderLines);
        }
        if (Buffer.byteLength(rendered.text, "utf8") <= 8800)
            return rendered.text;
        const keptSections = [];
        let bytes = 0;
        let truncated = false;
        let droppedFiles = r.omittedFiles ?? 0;
        let droppedSymbols = 0;
        for (let si = 0; si < rendered.sections.length; si++) {
            const sec = rendered.sections[si];
            const sepBytes = keptSections.length > 0 ? 2 : 0;
            const headBytes = Buffer.byteLength(`${sec.secHead}\n`, "utf8");
            if (keptSections.length > 0 && bytes + sepBytes + headBytes > 8550) {
                truncated = true;
                droppedFiles += rendered.sections.length - si;
                break;
            }
            const keptLines = [];
            let secBytes = sepBytes + headBytes;
            for (let li = 0; li < sec.lines.length; li++) {
                const lb = Buffer.byteLength(`${sec.lines[li]}\n`, "utf8");
                if ((keptSections.length > 0 || keptLines.length > 0) && bytes + secBytes + lb > 8550) {
                    truncated = true;
                    droppedSymbols += sec.lines.length - li;
                    break;
                }
                keptLines.push(sec.lines[li]);
                secBytes += lb;
            }
            keptSections.push([sec.secHead, ...keptLines].join("\n"));
            bytes += secBytes;
            if (truncated) {
                droppedFiles += rendered.sections.length - si - 1;
                break;
            }
        }
        const notices = [];
        if (droppedSymbols > 0)
            notices.push(`+${droppedSymbols} more symbols`);
        if (droppedFiles > 0)
            notices.push(`+${droppedFiles} more files`);
        const suffix = notices.length > 0 ? `\n\n… (truncated: ${notices.join(", ")} — narrow path or run \`plexer skeleton <file>\`)` : "";
        return `${keptSections.join("\n\n")}${suffix}\n`;
    }
    const head = `plexer skeleton — ${r.file}`;
    if (!r.entries?.length)
        return `${head}\n\n${r.note ?? r.error ?? "no definitions."}\n`;
    if (opts.summaryOnly) {
        const preview = r.entries.slice(0, 8).map((e) => `${e.name}(${e.span})`).join(", ");
        const more = r.entries.length > 8 ? `, +${r.entries.length - 8} more` : "";
        return `${head} (${r.entries.length} symbols: ${preview}${more} — run \`plexer skeleton ${r.file}\` for full signatures)\n`;
    }
    const lines = opts.compact
        ? renderLines(r.entries, 72, 0, true)
        : r.entries.length > 30
            ? renderLines(r.entries, 90, 60, true)
            : renderLines(r.entries, 110, 90, false);
    let out = `${head}\n${lines.join("\n")}\n`;
    if (out.length > 6000 && !opts.compact) {
        out = `${head}\n${renderLines(r.entries, 72, 0, true).join("\n")}\n`;
    }
    if (Buffer.byteLength(out, "utf8") > 8800) {
        const compactLines = renderLines(r.entries, 72, 0, true);
        const kept = [];
        let bytes = Buffer.byteLength(`${head}\n`, "utf8");
        for (const ln of compactLines) {
            const lb = Buffer.byteLength(ln, "utf8") + 1;
            if (kept.length > 0 && bytes + lb > 8650)
                break;
            kept.push(ln);
            bytes += lb;
        }
        const omitted = compactLines.length - kept.length;
        if (omitted > 0)
            kept.push(`- … (+${omitted} more symbols — run \`plexer read ${r.file}:Lx-Ly\`)`);
        out = `${head}\n${kept.join("\n")}\n`;
    }
    return out;
}
