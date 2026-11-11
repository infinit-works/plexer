/**
 * $O(N \log N)$ LOC-windowed exact (SHA-256) and near-duplicate (token 4-gram Jaccard >= 0.82)
 * function/method detector powered by `wiring.json` symbol spans.
 */
import { createHash } from "node:crypto";
import { spanRange } from "../util/span.js";
import { mintIssueId } from "./state.js";
import { SCORED_ZONES, UnionFind, hasInlineSuppression } from "./zones.js";

const MIN_DUP_LINES = 8;
const MIN_DUP_TOKENS = 24;
const JACCARD_THRESHOLD = 0.82;

const STOP_KEYWORDS = new Set([
    "function",
    "return",
    "const",
    "let",
    "var",
    "local",
    "def",
    "fn",
    "func",
    "public",
    "private",
    "protected",
    "static",
    "async",
    "await",
    "if",
    "else",
    "elif",
    "elseif",
    "then",
    "end",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "try",
    "catch",
    "finally",
    "throw",
    "raise",
    "except",
    "import",
    "from",
    "export",
    "true",
    "false",
    "null",
    "nil",
    "none",
    "undefined",
    "self",
    "this",
]);

function stripCommentsAndNormalize(lines, relPath = "") {
    const isDashComment = /\.(?:luau|lua|sql)$/i.test(relPath);
    const isHashComment = /\.(?:py|pyi|sh|bash|zsh|rb|pl|r|ya?ml|toml)$/i.test(relPath);
    const isSlashComment = !isDashComment && !isHashComment;
    const cleaned = [];
    for (const raw of lines) {
        let line = raw.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '"$STR"');
        if (isSlashComment) line = line.replace(/\/\/.*$/, "");
        if (isDashComment) line = line.replace(/--.*$/, "");
        if (isHashComment) line = line.replace(/#.*$/, "");
        const trimmed = line.trim();
        if (!trimmed) continue;
        cleaned.push(trimmed);
    }
    return cleaned;
}

function normalizeStructuralTokens(lines) {
    const text = lines
        .join("\n")
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "$STR")
        .replace(/\b\d+(?:\.\d+)?\b/g, "$NUM");
    const rawTokens = text.match(/\$STR|\$NUM|[A-Za-z_][A-Za-z0-9_]*|[{}()[\].,:;+\-/*%=<>!&|?~]+/g) || [];
    const idMap = new Map();
    let idSeq = 0;
    return rawTokens.map((tok) => {
        if (tok === "$STR" || tok === "$NUM") return tok;
        if (/^[A-Za-z_]/.test(tok)) {
            if (STOP_KEYWORDS.has(tok)) return tok;
            let mapped = idMap.get(tok);
            if (!mapped) {
                idSeq += 1;
                mapped = `$ID${idSeq}`;
                idMap.set(tok, mapped);
            }
            return mapped;
        }
        return tok;
    });
}

function buildShingles(tokens, k = 4) {
    const set = new Set();
    if (tokens.length < k) {
        set.add(tokens.join(" "));
        return set;
    }
    for (let i = 0; i <= tokens.length - k; i++) {
        const gram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]} ${tokens[i + 3]}`;
        const h = createHash("md5").update(gram).digest("hex").slice(0, 8);
        set.add(h);
    }
    return set;
}

function jaccard(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    const minRatio = Math.min(setA.size, setB.size) / Math.max(setA.size, setB.size);
    if (minRatio < JACCARD_THRESHOLD) return 0;
    let intersection = 0;
    const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    for (const item of smaller) {
        if (larger.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

function sliceFunctionBodyAfterSignature(bodyLines) {
    if (bodyLines.length <= 2) return bodyLines;
    let parenBalance = 0;
    let sawOpenParen = false;
    const maxHeaderLines = Math.min(10, bodyLines.length - 1);
    for (let i = 0; i < maxHeaderLines; i++) {
        const line = bodyLines[i];
        for (let c = 0; c < line.length; c++) {
            if (line[c] === "(") {
                parenBalance += 1;
                sawOpenParen = true;
            } else if (line[c] === ")") {
                parenBalance = Math.max(0, parenBalance - 1);
            }
        }
        if (!sawOpenParen || parenBalance === 0) {
            let nextIdx = i + 1;
            if (nextIdx < bodyLines.length - 1 && bodyLines[nextIdx].trim() === "{") {
                nextIdx += 1;
            }
            return bodyLines.slice(nextIdx);
        }
    }
    return bodyLines.slice(1);
}

function collectDuplicateCandidates(graph, readLines, zoneMap, ignoreRules) {
    const candidates = [];
    const seenFileSpan = new Set();
    for (const node of graph.nodes) {
        if (node.aliasOf) continue;
        if (node.kind !== "function" && node.kind !== "method") continue;
        const zone = zoneMap.get(node.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(node.path, "duplicates")) continue;

        const range = spanRange(node.span);
        if (!range) continue;
        const spanKey = `${node.path}::${range.start}-${range.end}`;
        if (seenFileSpan.has(spanKey)) continue;
        seenFileSpan.add(spanKey);
        const loc = range.end - range.start + 1;
        if (loc < MIN_DUP_LINES) continue;

        const fileLines = readLines(node.path);
        if (!fileLines) continue;
        if (hasInlineSuppression(fileLines, range.start, "duplicates")) continue;

        const bodyLines = fileLines.slice(range.start - 1, range.end);
        const innerLines = stripCommentsAndNormalize(
            sliceFunctionBodyAfterSignature(bodyLines),
            node.path,
        );
        if (innerLines.length < MIN_DUP_LINES - 2) continue;

        const tokens = normalizeStructuralTokens(innerLines);
        if (tokens.length < MIN_DUP_TOKENS) continue;

        const exactHash = createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
        const shingles = buildShingles(tokens, 4);

        candidates.push({
            node,
            path: node.path,
            name: node.name,
            span: node.span,
            start: range.start,
            end: range.end,
            loc,
            exactHash,
            shingles,
        });
    }
    return candidates;
}

function sortCloneMembers(members) {
    return [...members].sort(
        (a, b) =>
            String(a.path).localeCompare(String(b.path)) ||
            (a.start || 0) - (b.start || 0) ||
            String(a.name).localeCompare(String(b.name)),
    );
}

function findCloneDrift(members, gitHistory) {
    const coChanges = gitHistory?.coChanges;
    if (!coChanges || typeof coChanges !== "object") return null;
    const files = [...new Set(members.map((m) => String(m.path || "").replace(/\\/g, "/")).filter(Boolean))];
    if (files.length < 2) return null;

    let best = null;
    for (let i = 0; i < files.length; i++) {
        const fA = files[i];
        const partners = coChanges[fA] || [];
        for (let j = i + 1; j < files.length; j++) {
            const fB = files[j];
            const entry =
                partners.find((p) => String(p.partner || "").replace(/\\/g, "/") === fB) ||
                (coChanges[fB] || []).find((p) => String(p.partner || "").replace(/\\/g, "/") === fA);
            if (!entry) continue;
            const coCommits = Number(entry.coCommits || 0);
            const couplingRatio = Number(entry.couplingRatio || 0);
            if (coCommits >= 3 || couplingRatio >= 0.3) {
                if (!best || coCommits > best.co_commits) {
                    best = {
                        file_a: fA,
                        file_b: fB,
                        co_commits: coCommits,
                        coupling_ratio: couplingRatio,
                    };
                }
            }
        }
    }
    return best;
}

function collectNearDuplicateIssues(candidates, clusteredIndices, issues, gitHistory = null) {
    const remaining = candidates
        .map((c, idx) => ({ c, idx }))
        .filter((x) => !clusteredIndices.has(x.idx))
        .sort((a, b) => a.c.loc - b.c.loc);

    const uf = new UnionFind();
    const maxSimByIdx = new Map();

    for (let i = 0; i < remaining.length; i++) {
        const base = remaining[i].c;
        const maxLoc = Math.ceil(base.loc / 0.7);

        for (let j = i + 1; j < remaining.length; j++) {
            const other = remaining[j].c;
            if (other.loc > maxLoc) break;
            if (other.path === base.path && other.name === base.name && other.start === base.start) continue;
            const sim = jaccard(base.shingles, other.shingles);
            if (sim >= JACCARD_THRESHOLD) {
                uf.union(i, j);
                maxSimByIdx.set(i, Math.max(maxSimByIdx.get(i) || 0, sim));
                maxSimByIdx.set(j, Math.max(maxSimByIdx.get(j) || 0, sim));
            }
        }
    }

    for (const compIndices of uf.components()) {
        if (compIndices.length < 2) continue;
        const cluster = sortCloneMembers(compIndices.map((idx) => remaining[idx].c));
        let bestSim = JACCARD_THRESHOLD;
        for (const idx of compIndices) {
            bestSim = Math.max(bestSim, maxSimByIdx.get(idx) || 0);
        }

        const primary = cluster[0];
        const peerList = cluster
            .slice(1)
            .map((m) => `${m.path}:${m.span} (${m.name})`)
            .join(", ");
        const pct = Math.round(bestSim * 100);
        const cloneDrift = findCloneDrift(cluster, gitHistory);
        const driftSuffix = cloneDrift
            ? ` [clone_drift: ${cloneDrift.file_a} <-> ${cloneDrift.file_b} co-changed in ${cloneDrift.co_commits} commits]`
            : "";

        issues.push({
            id: mintIssueId("duplicates", primary.path, `near_${primary.name}_L${primary.start}`),
            detector: "duplicates",
            category: "duplicates",
            dimension: "duplication",
            tier: cloneDrift ? "T2" : "T3",
            confidence: bestSim >= 0.9 ? "high" : "medium",
            severity: cloneDrift || cluster.length >= 3 || primary.loc >= 30 ? "high" : "medium",
            file: primary.path,
            line: primary.start,
            end_line: primary.end,
            span: primary.span,
            identifier: primary.name,
            similarity: Number(bestSim.toFixed(2)),
            kind: "near_duplicate",
            ...(cloneDrift ? { clone_drift: cloneDrift } : {}),
            detail: {
                cluster_size: cluster.length,
                ...(cloneDrift ? { clone_drift: cloneDrift } : {}),
            },
            members: cluster.map((m) => ({
                file: m.path,
                name: m.name,
                span: m.span,
                loc: m.loc,
            })),
            summary: `Near-duplicate function cluster (${pct}% token similarity across ${cluster.length} functions): ${primary.name} and ${peerList}${driftSuffix}`,
            suggestion: `Consolidate the shared control flow between ${primary.name} and ${peerList} into a parameterized helper.`,
        });
    }
}

/**
 * Detect exact and near-duplicate functions/methods across scored files in `graph`.
 */
export function detectDuplicates(graph, readLines, zoneMap, ignoreRules, gitHistory = null) {
    const candidates = collectDuplicateCandidates(graph, readLines, zoneMap, ignoreRules);
    const issues = [];
    const clusteredIndices = new Set();

    const byHash = new Map();
    candidates.forEach((c, idx) => {
        let group = byHash.get(c.exactHash);
        if (!group) {
            group = [];
            byHash.set(c.exactHash, group);
        }
        group.push(idx);
    });

    for (const [hash, indices] of byHash.entries()) {
        if (indices.length < 2) continue;
        for (const i of indices) clusteredIndices.add(i);
        const members = sortCloneMembers(indices.map((i) => candidates[i]));
        const primary = members[0];
        const peerList = members
            .slice(1)
            .map((m) => `${m.path}:${m.span} (${m.name})`)
            .join(", ");
        const cloneDrift = findCloneDrift(members, gitHistory);
        const driftSuffix = cloneDrift
            ? ` [clone_drift: ${cloneDrift.file_a} <-> ${cloneDrift.file_b} co-changed in ${cloneDrift.co_commits} commits]`
            : "";

        issues.push({
            id: mintIssueId("duplicates", primary.path, `${primary.name}_${hash.slice(0, 8)}`),
            detector: "duplicates",
            category: "duplicates",
            dimension: "duplication",
            tier: cloneDrift ? "T2" : "T3",
            confidence: "high",
            severity: cloneDrift || members.length >= 3 || primary.loc >= 25 ? "high" : "medium",
            file: primary.path,
            line: primary.start,
            end_line: primary.end,
            span: primary.span,
            identifier: primary.name,
            similarity: 1.0,
            kind: "exact_duplicate",
            ...(cloneDrift ? { clone_drift: cloneDrift } : {}),
            detail: {
                cluster_size: members.length,
                ...(cloneDrift ? { clone_drift: cloneDrift } : {}),
            },
            members: members.map((m) => ({
                file: m.path,
                name: m.name,
                span: m.span,
                loc: m.loc,
            })),
            summary: `Exact structural duplicate across ${members.length} functions (${primary.loc} LOC each): ${primary.name} mirrors ${peerList}${driftSuffix}`,
            suggestion: `Extract a shared helper for ${primary.name} and its ${members.length - 1} duplicate(s) (${peerList}) and call it from each site.`,
        });
    }

    collectNearDuplicateIssues(candidates, clusteredIndices, issues, gitHistory);

    return {
        issues,
        potential: Math.max(1, candidates.length),
    };
}
