/**
 * 20-Dimension Blind Subjective Review engine:
 * - `--prepare`: builds `review_packet_blind.json` with Holistic Context, synthesized Concerns,
 *   5 thematic batches across 20 dimensions, and per-language review overrides (including Luau/Roblox).
 * - `--merge`: merges `batch-*.raw.txt` subagent outputs into a unified payload.
 * - `--import`: fail-closed validator & importer supporting Two-Phase judgments (`dimension_judgment`),
 *   evolving codebase insights (`context_updates`), `dismissed_concerns`, anti-gaming target-anchor
 *   reset, import guards, and review coverage/staleness tracking (`detectReviewCoverage`).
 */
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeInDegree } from "../context/symbol-query.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { buildHolisticContext, cleanupStaleDismissals, generateConcerns } from "./concerns.js";
import {
    ATTEST_BLIND_REVIEW_EXAMPLE,
    BLIND_PACKET_FILE,
    DEFAULT_TARGET_STRICT_SCORE,
    DIMENSION_BATCHES,
    QUERY_FILE,
    REVIEWER_PERSONAS,
    SUBJECTIVE_DIMENSIONS,
    normalizeDimensionKey,
} from "./constants.js";
import { buildDimensionPromptsForLangs, buildReviewSystemPrompt } from "./dimensions.js";
import { emptyLivingPlan, healthDir, loadLivingPlan, mintIssueId } from "./state.js";
import { SCORED_ZONES } from "./zones.js";

export { REVIEWER_PERSONAS };

export function queryFilePath(contextDir) {
    return join(healthDir(contextDir), QUERY_FILE);
}

export function blindPacketFilePath(contextDir) {
    return join(healthDir(contextDir), BLIND_PACKET_FILE);
}

/**
 * Check whether the holistic subjective review is unassessed, stale (> `maxAgeDays`),
 * or has experienced >20% file-count drift since the last review.
 */
export function detectReviewCoverage(state, totalProdFiles, maxAgeDays = 30) {
    if (totalProdFiles <= 0) {
        return { status: "not_applicable", stale: false, reason: null };
    }
    const holistic = state.review_cache?.holistic;
    const hasSubjective = Object.keys(state.subjective_assessments || {}).length > 0;
    if (!holistic && !hasSubjective) {
        return {
            status: "unreviewed",
            stale: true,
            reason: "No holistic codebase review on record — run `plexer health review --prepare`",
        };
    }

    const staleDimensions = [];
    for (const [k, v] of Object.entries(state.subjective_assessments || {})) {
        if (v && typeof v === "object" && v.stale) {
            const norm = normalizeDimensionKey(k);
            if (norm && !staleDimensions.includes(norm)) staleDimensions.push(norm);
        }
    }
    if (staleDimensions.length > 0) {
        return {
            status: "stale_dimensions",
            stale: true,
            stale_dimensions: staleDimensions,
            reason: `Subjective dimension(s) marked stale by new mechanical findings (${staleDimensions.join(", ")}) — re-review recommended`,
        };
    }

    if (maxAgeDays === 0) {
        return { status: "fresh", stale: false, stale_dimensions: [], reason: null };
    }

    if (holistic?.reviewed_at) {
        const reviewedMs = Date.parse(holistic.reviewed_at);
        if (Number.isFinite(reviewedMs)) {
            const ageDays = Math.floor((Date.now() - reviewedMs) / (1000 * 60 * 60 * 24));
            if (ageDays > maxAgeDays) {
                return {
                    status: "stale_age",
                    stale: true,
                    stale_dimensions: [],
                    age_days: ageDays,
                    reason: `Holistic review is ${ageDays} days old (> ${maxAgeDays}d) — re-review recommended`,
                };
            }
        }
    }

    if (holistic?.total_files && holistic.total_files > 0) {
        const drift = Math.abs(totalProdFiles - holistic.total_files) / holistic.total_files;
        if (drift > 0.2) {
            return {
                status: "stale_drift",
                stale: true,
                stale_dimensions: [],
                drift_ratio: Number(drift.toFixed(2)),
                reason: `Production file count drifted ${Math.round(drift * 100)}% since last review (${holistic.total_files} → ${totalProdFiles}) — re-review recommended`,
            };
        }
    }

    return { status: "fresh", stale: false, stale_dimensions: [], reason: null };
}

function buildRequiredReviewOutputSchema(sessionId, token, selectedDimIds = null) {
    const dimKeys =
        Array.isArray(selectedDimIds) && selectedDimIds.length > 0
            ? selectedDimIds
            : Object.keys(SUBJECTIVE_DIMENSIONS);
    return {
        session: { id: sessionId, token },
        assessments: Object.fromEntries(dimKeys.map((k) => [k, "<0-100 number>"])),
        dimension_judgment: {
            "<dimension_id>": {
                dimension_character: "2-3 sentences characterizing this dimension in the codebase",
                score_rationale: "2-3 sentences weighing observations against the 0-100 anchors",
                strengths: ["concrete positive pattern observed"],
            },
        },
        context_updates: {
            "<dimension_id>": {
                add: [
                    {
                        header: "Short pattern name",
                        description: "Concrete codebase characteristic",
                        positive: true,
                        settled: true,
                    },
                ],
                remove: [],
                settle: [],
            },
        },
        findings: [
            {
                dimension: "<dimension_id>",
                identifier: "short_snake_id",
                summary: "one-line defect summary",
                related_files: ["relative/path/to/file.ext"],
                evidence: ["specific code observation with line numbers"],
                suggestion: "concrete fix recommendation that reduces net complexity",
                confidence: "high|medium|low",
            },
        ],
        dismissed_concerns: [
            {
                fingerprint: "concern_...",
                reasoning: "why this mechanical concern is benign in context",
            },
        ],
    };
}

function resolveScopedBatches(state, dimensionPrompts, holisticContext, opts = {}) {
    let allowedBatches = null;
    if (opts.batches) {
        const rawList = Array.isArray(opts.batches) ? opts.batches.join(",") : String(opts.batches);
        const nums = rawList
            .split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n >= 1);
        if (nums.length > 0) allowedBatches = new Set(nums);
    }

    let allowedDims = null;
    if (opts.dimensions) {
        const rawList = Array.isArray(opts.dimensions)
            ? opts.dimensions.join(",")
            : String(opts.dimensions);
        const dims = rawList
            .split(",")
            .map((s) => normalizeDimensionKey(s))
            .filter((d) => Boolean(SUBJECTIVE_DIMENSIONS[d]));
        if (dims.length > 0) allowedDims = new Set(dims);
    } else if (opts.staleOnly) {
        const subAssess = state.subjective_assessments || {};
        const staleOrUnassessed = Object.keys(SUBJECTIVE_DIMENSIONS).filter((dimId) => {
            const entry = subAssess[dimId] || subAssess[SUBJECTIVE_DIMENSIONS[dimId].short_id];
            if (!entry || typeof entry.score !== "number" || entry.placeholder) return true;
            return Boolean(entry.stale);
        });
        allowedDims = new Set(
            staleOrUnassessed.length > 0 ? staleOrUnassessed : Object.keys(SUBJECTIVE_DIMENSIONS),
        );
    }

    const filteredBatches = [];
    const selectedDimIds = [];
    for (const b of DIMENSION_BATCHES) {
        if (allowedBatches && !allowedBatches.has(b.batch)) continue;
        const dimsInBatch = allowedDims
            ? b.dimensions.filter((d) => allowedDims.has(d))
            : b.dimensions;
        if (dimsInBatch.length === 0) continue;
        for (const d of dimsInBatch) selectedDimIds.push(d);
        const persona = REVIEWER_PERSONAS[(b.batch - 1) % REVIEWER_PERSONAS.length];
        filteredBatches.push({
            batch: b.batch,
            theme: b.theme,
            persona,
            output_file: `batch-${b.batch}.raw.txt`,
            dimensions: dimsInBatch.map((d) => dimensionPrompts[d]),
            concern_signals: dimsInBatch.includes("design_coherence")
                ? holisticContext.concerns
                : [],
        });
    }
    return { filteredBatches, selectedDimIds };
}

function buildRetrospectiveContext(state, plan) {
    const allIssues = Object.values(state?.issues || {});
    const candidates = allIssues.filter(
        (iss) =>
            iss.status === "fixed" ||
            iss.status === "auto_resolved" ||
            iss.status === "wontfix" ||
            (iss.reopen_count || 0) >= 2,
    );
    candidates.sort(
        (a, b) =>
            (b.reopen_count || 0) - (a.reopen_count || 0) ||
            (b.last_seen_scan || 0) - (a.last_seen_scan || 0) ||
            String(a.id).localeCompare(String(b.id)),
    );
    const sanitizedIssues = candidates.slice(0, 25).map((iss) => ({
        id: iss.id,
        detector: iss.detector,
        dimension: iss.dimension || null,
        file: iss.file || "repo",
        identifier: iss.identifier || null,
        status: iss.status,
        reopen_count: iss.reopen_count || 0,
        summary: iss.summary,
        note: iss.note || null,
    }));
    const chronicIssues = sanitizedIssues.filter((i) => i.reopen_count >= 2);
    const policies = Array.isArray(plan?.policies) ? [...plan.policies] : [];

    return {
        issues: sanitizedIssues,
        recent_issues: sanitizedIssues,
        chronic_issues: chronicIssues,
        policies,
    };
}

function normalizePrepareReviewInputs(arg2, arg3, arg4, arg5, arg6) {
    let rawGraph = arg2;
    let state = arg3;
    let zoneMap = arg4;
    let readLines = arg5;
    let opts = arg6 || {};

    if (arg2 && !Array.isArray(arg2.nodes) && !Array.isArray(arg2.files) && arg2.issues) {
        state = arg2;
        const passedPlan = arg3;
        rawGraph = arg4 || { nodes: [], edges: [] };
        opts = { ...(arg5 || {}), plan: passedPlan };
        zoneMap = opts.zoneMap || new Map();
        readLines = opts.readLines || null;
    }

    const graph = Array.isArray(rawGraph?.nodes)
        ? rawGraph
        : {
              ...rawGraph,
              nodes: (rawGraph?.files || []).map((f, i) => ({
                  id: f.id ?? f.path ?? i,
                  kind: "file",
                  path: f.path,
                  lineCount: f.lineCount,
              })),
              edges: rawGraph?.edges || [],
          };
    const safeZoneMap = zoneMap instanceof Map ? zoneMap : new Map(Object.entries(zoneMap || {}));
    const inDeg = computeInDegree(graph);
    const scoredFiles = graph.nodes
        .filter((n) => n.kind === "file" && SCORED_ZONES.has(safeZoneMap.get(n.path) || "production"))
        .map((n) => ({
            path: n.path,
            inDegree: inDeg.get(n.id) || 0,
        }))
        .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));

    const seedFiles = scoredFiles.slice(0, 20).map((f) => f.path);
    const detectedLangs = [...(graph.languages || [])];
    if (
        scoredFiles.some((f) => /\.(luau|lua)$/i.test(f.path)) &&
        !detectedLangs.includes("luau")
    ) {
        detectedLangs.push("luau");
    }
    return { state, graph, safeZoneMap, readLines, opts, seedFiles, detectedLangs };
}

/**
 * Prepare `query.json` and `review_packet_blind.json` (stripped of score targets/history).
 */
export function prepareReview(contextDir, arg2, arg3, arg4 = null, arg5 = null, arg6 = {}) {
    const { state, graph, safeZoneMap, readLines, opts, seedFiles, detectedLangs } =
        normalizePrepareReviewInputs(arg2, arg3, arg4, arg5, arg6);

    const sessionId = `rev_${randomBytes(6).toString("hex")}`;
    const secret = randomBytes(16).toString("hex");
    const token = createHmac("sha256", secret).update(sessionId).digest("hex").slice(0, 24);

    if (!state.review_sessions) state.review_sessions = {};
    state.review_sessions[sessionId] = {
        id: sessionId,
        token,
        created_at: new Date().toISOString(),
    };

    const plan = opts.plan || loadLivingPlan(contextDir);
    const dimensionPrompts = buildDimensionPromptsForLangs(detectedLangs, seedFiles);
    const systemPrompt = buildReviewSystemPrompt(detectedLangs);
    const holisticContext = buildHolisticContext(graph, state, safeZoneMap, readLines);
    const existingContexts = state.dimension_contexts || {};
    const retrospective = buildRetrospectiveContext(state, plan);
    const { filteredBatches, selectedDimIds } = resolveScopedBatches(
        state,
        dimensionPrompts,
        holisticContext,
        opts,
    );

    const blindPacket = {
        session: { id: sessionId, token },
        scan_path: state.scan_path || ".",
        languages: detectedLangs,
        system_prompt: systemPrompt,
        holistic_context: holisticContext,
        retrospective,
        existing_dimension_contexts: existingContexts,
        batches: filteredBatches,
        selected_dimensions: selectedDimIds,
        seed_files: seedFiles,
        required_output_schema: buildRequiredReviewOutputSchema(sessionId, token, selectedDimIds),
    };

    const bPath = blindPacketFilePath(contextDir);
    writeJsonAtomic(bPath, blindPacket, true);
    const serializedPacket = existsSync(bPath)
        ? readFileSync(bPath, "utf8")
        : JSON.stringify(blindPacket, null, 2);
    const packetSha256 = createHash("sha256").update(serializedPacket, "utf8").digest("hex");
    state.review_sessions[sessionId].packet_sha256 = packetSha256;

    const queryPayload = {
        ...blindPacket,
        packet_sha256: packetSha256,
        dimension_prompts: dimensionPrompts,
    };
    writeJsonAtomic(queryFilePath(contextDir), queryPayload, true);

    return {
        session_id: sessionId,
        token,
        packet_sha256: packetSha256,
        languages: detectedLangs,
        blind_packet_path: bPath,
        query_path: queryFilePath(contextDir),
        batches: blindPacket.batches,
        retrospective,
        selected_dimensions: selectedDimIds,
        concerns_count: holisticContext.concerns.length,
        attest_example: ATTEST_BLIND_REVIEW_EXAMPLE,
    };
}

/**
 * Parse a JSON object out of a `.raw.txt` or `.json` file (stripping optional markdown code fences).
 */
export function parseReviewRawText(rawText) {
    const trimmed = String(rawText || "").trim();
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    return JSON.parse(candidate);
}

function tokenizeText(str) {
    return new Set(
        String(str || "")
            .toLowerCase()
            .replace(/[^a-z0-9_]+/g, " ")
            .split(/\s+/)
            .filter((t) => t.length >= 2),
    );
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const tok of setA) {
        if (setB.has(tok)) inter += 1;
    }
    const union = setA.size + setB.size - inter;
    return union > 0 ? inter / union : 0;
}

function findingDetailLength(f) {
    return (
        String(f?.summary || "").length +
        String(f?.suggestion || "").length +
        (Array.isArray(f?.evidence) ? f.evidence.join(" ").length : 0)
    );
}

function deduplicateReviewFindings(rawFindings, similarity = 0.8) {
    const merged = [];
    for (const item of rawFindings) {
        if (!item || typeof item !== "object") continue;
        const normDim = normalizeDimensionKey(item.dimension) || item.dimension || "";
        const itemFiles = Array.isArray(item.related_files) ? item.related_files : [];
        const itemSummaryTokens = tokenizeText(item.summary);
        const itemCombinedTokens = tokenizeText(`${item.summary || ""} ${item.suggestion || ""}`);

        let matchedIdx = -1;
        for (let i = 0; i < merged.length; i++) {
            const ex = merged[i];
            const exDim = normalizeDimensionKey(ex.dimension) || ex.dimension || "";
            if (exDim !== normDim) continue;
            const exFiles = Array.isArray(ex.related_files) ? ex.related_files : [];

            const exactKeyMatch =
                ex.identifier &&
                item.identifier &&
                ex.identifier === item.identifier &&
                (exFiles[0] || "") === (itemFiles[0] || "");

            if (exactKeyMatch) {
                matchedIdx = i;
                break;
            }

            const hasFileOverlap =
                (exFiles.length === 0 && itemFiles.length === 0) ||
                exFiles.some((f) => itemFiles.includes(f));
            if (!hasFileOverlap) continue;

            const exSummaryTokens = tokenizeText(ex.summary);
            const exCombinedTokens = tokenizeText(`${ex.summary || ""} ${ex.suggestion || ""}`);
            const sim = Math.max(
                jaccardSimilarity(exSummaryTokens, itemSummaryTokens),
                jaccardSimilarity(exCombinedTokens, itemCombinedTokens),
            );
            if (sim >= similarity) {
                matchedIdx = i;
                break;
            }
        }

        if (matchedIdx === -1) {
            merged.push({
                ...item,
                dimension: normDim || item.dimension,
                related_files: [...new Set(itemFiles)],
                evidence: Array.isArray(item.evidence) ? [...new Set(item.evidence)] : [],
                merged_count: item.merged_count || 1,
            });
        } else {
            const existing = merged[matchedIdx];
            const combinedFiles = [
                ...new Set([...(existing.related_files || []), ...itemFiles]),
            ];
            const combinedEvidence = [
                ...new Set([
                    ...(Array.isArray(existing.evidence) ? existing.evidence : []),
                    ...(Array.isArray(item.evidence) ? item.evidence : []),
                ]),
            ];
            const base =
                findingDetailLength(item) > findingDetailLength(existing) ? item : existing;
            merged[matchedIdx] = {
                ...base,
                dimension: normDim || base.dimension,
                related_files: combinedFiles,
                evidence: combinedEvidence,
                merged_count: (existing.merged_count || 1) + (item.merged_count || 1),
            };
        }
    }
    return merged;
}

const RESERVED_HEALTH_JSON_FILES = new Set([
    "state.json",
    "plan.json",
    "config.json",
    "query.json",
    "review_packet.json",
    "review_packet_blind.json",
    "merged_review.json",
]);

function resolveBatchEntriesList(filesOrDir) {
    if (Array.isArray(filesOrDir)) return filesOrDir;
    if (typeof filesOrDir !== "string") return [];
    const entries = readdirSync(filesOrDir);
    const batchMatches = entries.filter((f) => /^batch-\d+\.(?:raw\.txt|json)$/i.test(f));
    const selected =
        batchMatches.length > 0
            ? batchMatches
            : entries.filter(
                  (f) => /\.(?:raw\.txt|json)$/i.test(f) && !RESERVED_HEALTH_JSON_FILES.has(f.toLowerCase()),
              );
    return selected.sort().map((f) => join(filesOrDir, f));
}

function mergeBatchJudgmentAndContext(dimensionJudgment, contextUpdates, parsed) {
    if (parsed.dimension_judgment && typeof parsed.dimension_judgment === "object") {
        for (const [rawDim, jVal] of Object.entries(parsed.dimension_judgment)) {
            const dim = normalizeDimensionKey(rawDim);
            if (!dim || !jVal || typeof jVal !== "object") continue;
            const prev = dimensionJudgment[dim];
            if (!prev) {
                dimensionJudgment[dim] = {
                    ...jVal,
                    ...(Array.isArray(jVal.strengths) ? { strengths: [...jVal.strengths] } : {}),
                };
            } else {
                const prevChar = String(prev.dimension_character || "").trim();
                const nextChar = String(jVal.dimension_character || "").trim();
                const prevRat = String(prev.score_rationale || "").trim();
                const nextRat = String(jVal.score_rationale || "").trim();
                const strengths = [
                    ...new Set([
                        ...(Array.isArray(prev.strengths) ? prev.strengths : []),
                        ...(Array.isArray(jVal.strengths) ? jVal.strengths : []),
                    ]),
                ];
                dimensionJudgment[dim] = {
                    ...prev,
                    ...jVal,
                    dimension_character:
                        nextChar.length >= prevChar.length && nextChar
                            ? jVal.dimension_character
                            : prev.dimension_character || jVal.dimension_character,
                    score_rationale:
                        nextRat.length >= prevRat.length && nextRat
                            ? jVal.score_rationale
                            : prev.score_rationale || jVal.score_rationale,
                    strengths,
                };
            }
        }
    }
    if (parsed.context_updates && typeof parsed.context_updates === "object") {
        for (const [rawDim, uVal] of Object.entries(parsed.context_updates)) {
            const dim = normalizeDimensionKey(rawDim);
            if (!dim || !uVal || typeof uVal !== "object") continue;
            const prev = contextUpdates[dim];
            if (!prev) {
                contextUpdates[dim] = {
                    ...uVal,
                    ...(Array.isArray(uVal.add) ? { add: [...uVal.add] } : {}),
                    ...(Array.isArray(uVal.remove) ? { remove: [...uVal.remove] } : {}),
                    ...(Array.isArray(uVal.settle) ? { settle: [...uVal.settle] } : {}),
                    ...(Array.isArray(uVal.unsettle) ? { unsettle: [...uVal.unsettle] } : {}),
                };
            } else {
                for (const key of ["add", "remove", "settle", "unsettle"]) {
                    if (Array.isArray(prev[key]) || Array.isArray(uVal[key])) {
                        prev[key] = [
                            ...(Array.isArray(prev[key]) ? prev[key] : []),
                            ...(Array.isArray(uVal[key]) ? uVal[key] : []),
                        ];
                    }
                }
            }
        }
    }
}

/**
 * Merge `batch-*.raw.txt` files from a directory or explicit file/object list into a single review payload.
 */
export function mergeReviewBatches(arg1, arg2 = {}, arg3 = null, arg4 = null, arg5 = {}) {
    let filesOrDir = arg1;
    let opts = arg2 || {};
    if (typeof arg4 === "string" || Array.isArray(arg4)) {
        filesOrDir = arg4;
        opts = arg5 || {};
    }
    const similarity = Number(opts.similarity ?? 0.8);
    const entriesList = resolveBatchEntriesList(filesOrDir);

    const scoreBuckets = new Map();
    const rawFindingsAll = [];
    const dimensionJudgment = {};
    const contextUpdates = {};
    const dismissedConcerns = [];
    let session = null;

    for (const entry of entriesList) {
        let parsed;
        if (typeof entry === "object" && entry !== null) {
            parsed = entry;
        } else {
            try {
                parsed = parseReviewRawText(readFileSync(entry, "utf8"));
            } catch (err) {
                throw new Error(`Failed to parse review batch ${entry}: ${err.message}`);
            }
        }
        if (parsed.session && !session) session = parsed.session;
        const rawScores = parsed.assessments || parsed.dimensions;
        if (rawScores && typeof rawScores === "object") {
            for (const [rawDim, val] of Object.entries(rawScores)) {
                const dim = normalizeDimensionKey(rawDim);
                const num = Number(typeof val === "object" && val !== null ? val.score : val);
                if (!Number.isFinite(num)) continue;
                let arr = scoreBuckets.get(dim);
                if (!arr) {
                    arr = [];
                    scoreBuckets.set(dim, arr);
                }
                arr.push(num);
            }
        }
        mergeBatchJudgmentAndContext(dimensionJudgment, contextUpdates, parsed);
        const batchFindings = Array.isArray(parsed.findings)
            ? parsed.findings
            : Array.isArray(parsed.issues)
              ? parsed.issues
              : [];
        rawFindingsAll.push(...batchFindings);
        if (Array.isArray(parsed.dismissed_concerns)) {
            dismissedConcerns.push(...parsed.dismissed_concerns);
        }
    }

    const assessments = {};
    for (const [dim, vals] of scoreBuckets.entries()) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        assessments[dim] = Number(avg.toFixed(1));
    }

    const findings = deduplicateReviewFindings(rawFindingsAll, similarity);

    return {
        ...(session ? { session } : {}),
        assessments,
        dimension_judgment: dimensionJudgment,
        context_updates: contextUpdates,
        findings,
        dismissed_concerns: dismissedConcerns,
    };
}

/**
 * Store per-dimension `context_updates` (`add`, `remove`, `settle`, `unsettle`) into `state.dimension_contexts`.
 */
export function storeContextUpdates(state, contextUpdates, nowIso) {
    if (!contextUpdates || typeof contextUpdates !== "object") return;
    if (!state.dimension_contexts) state.dimension_contexts = {};

    for (const [rawDim, updates] of Object.entries(contextUpdates)) {
        const dimKey = normalizeDimensionKey(rawDim);
        if (!SUBJECTIVE_DIMENSIONS[dimKey] || !updates || typeof updates !== "object") continue;

        const ctx = state.dimension_contexts[dimKey] || {
            created_at: nowIso,
            updated_at: nowIso,
            stable_rounds: 0,
            insights: [],
        };
        const insights = Array.isArray(ctx.insights) ? [...ctx.insights] : [];
        let changed = false;

        // Remove by header
        for (const rmHeader of updates.remove || []) {
            if (typeof rmHeader !== "string") continue;
            const target = rmHeader.trim().toLowerCase();
            const idx = insights.findIndex(
                (ins) => String(ins.header || "").trim().toLowerCase() === target,
            );
            if (idx >= 0) {
                insights.splice(idx, 1);
                changed = true;
            }
        }

        // Add or update by header
        for (const item of updates.add || []) {
            if (!item || typeof item !== "object" || !item.header) continue;
            const header = String(item.header).trim();
            const key = header.toLowerCase();
            const existingIdx = insights.findIndex(
                (ins) => String(ins.header || "").trim().toLowerCase() === key,
            );
            if (existingIdx >= 0) {
                if (item.description) insights[existingIdx].description = String(item.description).trim();
                if (item.positive !== undefined) insights[existingIdx].positive = Boolean(item.positive);
                if (item.settled !== undefined) insights[existingIdx].settled = Boolean(item.settled);
                changed = true;
            } else {
                insights.push({
                    header,
                    description: String(item.description || "").trim(),
                    positive: Boolean(item.positive),
                    settled: Boolean(item.settled),
                    added_at: nowIso,
                });
                changed = true;
            }
        }

        // Settle / unsettle
        for (const sHeader of updates.settle || []) {
            const idx = insights.findIndex(
                (ins) => String(ins.header || "").trim().toLowerCase() === String(sHeader).trim().toLowerCase(),
            );
            if (idx >= 0 && !insights[idx].settled) {
                insights[idx].settled = true;
                changed = true;
            }
        }
        for (const uHeader of updates.unsettle || []) {
            const idx = insights.findIndex(
                (ins) => String(ins.header || "").trim().toLowerCase() === String(uHeader).trim().toLowerCase(),
            );
            if (idx >= 0 && insights[idx].settled) {
                insights[idx].settled = false;
                changed = true;
            }
        }

        ctx.insights = insights;
        if (changed) {
            ctx.updated_at = nowIso;
            ctx.stable_rounds = 0;
        } else {
            ctx.stable_rounds = (ctx.stable_rounds || 0) + 1;
        }
        state.dimension_contexts[dimKey] = ctx;
    }
}

function validateReviewPayload(rawAssessments, rawFindings, dimensionJudgment, opts) {
    const errors = [];
    const normalizedAssessments = {};
    for (const [rawDim, rawVal] of Object.entries(rawAssessments)) {
        const dim = normalizeDimensionKey(rawDim);
        if (!SUBJECTIVE_DIMENSIONS[dim]) {
            errors.push(`Unknown subjective dimension "${rawDim}"`);
            continue;
        }
        const num = Number(typeof rawVal === "object" && rawVal !== null ? rawVal.score : rawVal);
        if (!Number.isFinite(num) || num < 0 || num > 100) {
            errors.push(`Dimension "${rawDim}" score must be between 0 and 100, got ${rawVal}`);
            continue;
        }
        normalizedAssessments[dim] = num;
    }

    const validFindings = [];
    const findingsByDim = new Map();
    for (let i = 0; i < rawFindings.length; i++) {
        const f = rawFindings[i];
        const normDim = normalizeDimensionKey(f?.dimension);
        if (
            !f ||
            typeof f !== "object" ||
            !normDim ||
            !SUBJECTIVE_DIMENSIONS[normDim] ||
            !f.identifier ||
            !f.summary ||
            !Array.isArray(f.related_files) ||
            f.related_files.length === 0 ||
            !Array.isArray(f.evidence) ||
            f.evidence.length === 0 ||
            !f.suggestion
        ) {
            errors.push(
                `Finding #${i + 1} is missing required fields (dimension, identifier, summary, related_files, evidence, suggestion)`,
            );
            continue;
        }
        const cleaned = { ...f, dimension: normDim };
        validFindings.push(cleaned);
        findingsByDim.set(normDim, (findingsByDim.get(normDim) || 0) + 1);
    }

    const strictGuard =
        opts.strictGuard !== undefined ? Boolean(opts.strictGuard) : !opts.manualOverride;

    if (strictGuard) {
        for (const [dim, score] of Object.entries(normalizedAssessments)) {
            const hasFinding = (findingsByDim.get(dim) || 0) > 0;
            const hasJudgment = Boolean(
                dimensionJudgment[dim]?.score_rationale ||
                    dimensionJudgment[SUBJECTIVE_DIMENSIONS[dim]?.short_id]?.score_rationale,
            );
            if (score < 85 && !hasFinding && !hasJudgment) {
                errors.push(
                    `Import guard: dimension "${dim}" scored ${score} (< 85) without a defect finding or score_rationale in dimension_judgment`,
                );
            }
        }
    }

    return { errors, normalizedAssessments, validFindings };
}

function storeImportedReviewFindings(state, validFindings, importedDimSet, nowIso) {
    const newFindingIds = new Set();
    let importedFindings = 0;
    for (const f of validFindings) {
        const primaryFile = f.related_files[0] || "repo";
        const id = mintIssueId("review", primaryFile, `${f.dimension}_${f.identifier}`);
        newFindingIds.add(id);
        state.issues[id] = {
            id,
            detector: "review",
            category: "review",
            dimension: f.dimension,
            tier: "T3",
            confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium",
            severity: f.confidence === "high" ? "high" : "medium",
            file: primaryFile,
            line: 1,
            end_line: 1,
            span: "L1-L1",
            identifier: f.identifier,
            summary: `[${SUBJECTIVE_DIMENSIONS[f.dimension]?.name || f.dimension}] ${f.summary}`,
            suggestion: f.suggestion,
            evidence: f.evidence,
            related_files: f.related_files,
            status: "open",
            verified: false,
            first_seen_scan: state.scan_count || 1,
            last_seen_scan: state.scan_count || 1,
        };
        importedFindings += 1;
    }

    for (const [id, iss] of Object.entries(state.issues || {})) {
        if (iss.detector !== "review" || iss.status !== "open") continue;
        const normDim = normalizeDimensionKey(iss.dimension);
        if (importedDimSet.has(normDim) && !newFindingIds.has(id)) {
            iss.status = "auto_resolved";
            iss.verified = true;
            iss.resolved_at = nowIso;
        }
    }
    return importedFindings;
}

function applyImportedSubjectiveAssessments(state, normalizedAssessments, dimensionJudgment, dismissedConcerns, payload, opts, nowIso) {
    if (!state.subjective_assessments) state.subjective_assessments = {};
    let importedDims = 0;

    for (const [dim, num] of Object.entries(normalizedAssessments)) {
        const sDef = SUBJECTIVE_DIMENSIONS[dim];
        const rawJudgment =
            dimensionJudgment[dim] ||
            (sDef?.short_id ? dimensionJudgment[sDef.short_id] : null) ||
            null;
        const cleanedJudgment =
            rawJudgment && typeof rawJudgment === "object"
                ? {
                      dimension_character: String(rawJudgment.dimension_character || "").trim(),
                      score_rationale: String(rawJudgment.score_rationale || "").trim(),
                      strengths: Array.isArray(rawJudgment.strengths)
                          ? rawJudgment.strengths.slice(0, 5).map(String)
                          : [],
                  }
                : null;

        if (sDef?.short_id && state.subjective_assessments[sDef.short_id]) {
            delete state.subjective_assessments[sDef.short_id];
        }
        state.subjective_assessments[dim] = {
            score: Number(num.toFixed(1)),
            source: "holistic",
            assessed_at: nowIso,
            stale: false,
            stale_reason: null,
            attested: Boolean(opts.attestedExternal || opts.manualOverride || payload.session?.id),
            ...(cleanedJudgment ? { judgment: cleanedJudgment } : {}),
        };
        importedDims += 1;
    }

    if (dismissedConcerns.length > 0) {
        if (!state.concern_dismissals) state.concern_dismissals = {};
        const currentConcerns = generateConcerns(state);
        const concernMap = new Map(currentConcerns.map((c) => [c.fingerprint, c]));
        for (const d of dismissedConcerns) {
            if (!d?.fingerprint) continue;
            const matched = concernMap.get(d.fingerprint);
            state.concern_dismissals[d.fingerprint] = {
                dismissed_at: nowIso,
                reasoning: String(d.reasoning || "Dismissed during holistic review"),
                source_issue_ids: matched ? matched.source_issues : [],
            };
        }
    }

    return importedDims;
}

function verifyPacketSha256(bPath, expectedSha, payload) {
    if (!expectedSha) return null;
    if (bPath) {
        if (!existsSync(bPath)) {
            return {
                ok: false,
                status: "error",
                reason: "tampered_packet",
                errors: [
                    "Blind review packet missing: review_packet_blind.json not found for SHA-256 provenance check.",
                ],
                message:
                    "Review import aborted: review_packet_blind.json missing for SHA-256 provenance verification.",
            };
        }
        const actualSha = createHash("sha256")
            .update(readFileSync(bPath, "utf8"), "utf8")
            .digest("hex");
        if (actualSha !== expectedSha) {
            return {
                ok: false,
                status: "error",
                reason: "tampered_packet",
                errors: [
                    `Blind review packet SHA-256 mismatch (expected ${expectedSha}, got ${actualSha}): review_packet_blind.json was modified or tampered with.`,
                ],
                message:
                    "Review import aborted: review_packet_blind.json SHA-256 digest does not match query.packet_sha256.",
            };
        }
    }

    const payloadSha = payload.packet_sha256 || payload.session?.packet_sha256;
    if (payloadSha && payloadSha !== expectedSha) {
        return {
            ok: false,
            status: "error",
            reason: "tampered_packet",
            errors: [`Payload packet_sha256 mismatch (expected ${expectedSha}, got ${payloadSha}).`],
            message:
                "Review import aborted: payload packet_sha256 does not match query.packet_sha256.",
        };
    }
    return null;
}

function verifyBlindPacketProvenance(contextDir, state, payload, opts) {
    if (opts.manualOverride) return null;
    const qPath = contextDir ? queryFilePath(contextDir) : null;
    const bPath = contextDir ? blindPacketFilePath(contextDir) : null;
    const queryObj = qPath && existsSync(qPath) ? readJson(qPath) : null;
    const explicitSessId = payload.session_id || payload.session?.id || null;
    const querySessId = queryObj?.session_id || queryObj?.session?.id || null;
    const sessId = explicitSessId || querySessId;
    const sessions = state?.review_sessions;
    const hasSessions = Boolean(sessions && Object.keys(sessions).length > 0);

    if (hasSessions && (!sessId || !sessions[sessId])) {
        return {
            ok: false,
            status: "error",
            reason: "invalid_session",
            errors: [
                `Unknown review session "${sessId || ""}" — run \`plexer health review --prepare\` first.`,
            ],
            message: `Review import aborted: unknown review session "${sessId || ""}".`,
        };
    }

    const sessEntry = sessId && sessions?.[sessId] ? sessions[sessId] : null;
    if (sessEntry) {
        if (sessEntry.used_at) {
            return {
                ok: false,
                status: "error",
                reason: "session_already_used",
                errors: [
                    `Review session "${sessId}" was already consumed at ${sessEntry.used_at}. Prepare a fresh session with \`plexer health review --prepare\`.`,
                ],
                message: `Review import aborted: session "${sessId}" has already been used.`,
            };
        }
        const providedToken = payload.session?.token || payload.token;
        if (sessEntry.token && providedToken !== sessEntry.token) {
            return {
                ok: false,
                status: "error",
                reason: "invalid_session_token",
                errors: [`Session token mismatch for review session "${sessId}".`],
                message: `Review import aborted: invalid session token for "${sessId}".`,
            };
        }
    }

    const expectedSha = queryObj?.packet_sha256 || sessEntry?.packet_sha256 || null;
    return verifyPacketSha256(bPath, expectedSha, payload);
}

function normalizeImportReviewCallArgs(arg1, arg2, arg3, arg4, arg5) {
    let state = arg1;
    let config = arg2;
    let payloadOrPath = arg3;
    let opts = arg4 || {};

    if (typeof arg1 === "string" && arg2 && typeof arg2 === "object") {
        state = arg2;
        config = arg3;
        payloadOrPath = arg4;
        opts = { ...(arg5 || {}), contextDir: arg1 };
    }

    let payload = payloadOrPath;
    if (typeof payloadOrPath === "string") {
        const raw = readFileSync(payloadOrPath, "utf8");
        payload = parseReviewRawText(raw);
    }

    if (!payload || typeof payload !== "object") {
        throw new Error("Invalid review import payload: expected JSON object");
    }
    return { state, config, payload, opts };
}

function resetTargetAnchoredAssessments(state, normalizedAssessments) {
    const resetIso = new Date().toISOString();
    if (!state.subjective_assessments || typeof state.subjective_assessments !== "object") {
        state.subjective_assessments = {};
    }
    const dimsToReset = new Set(Object.keys(normalizedAssessments));
    for (const dim of dimsToReset) {
        const sDef = SUBJECTIVE_DIMENSIONS[dim];
        if (sDef?.short_id && state.subjective_assessments[sDef.short_id]) {
            delete state.subjective_assessments[sDef.short_id];
        }
        state.subjective_assessments[dim] = {
            score: 0,
            placeholder: true,
            reset_by: "target_anchored_reset",
            updated_at: resetIso,
        };
    }
    return {
        status: "target_anchored_reset",
        errors: [
            "Anti-gaming trigger: subjective scores anchored at target/>=95 with 0 findings. Targeted dimensions reset to 0.0 placeholder — re-run blind review against review_packet_blind.json.",
        ],
        message:
            "Anti-gaming check triggered: suspicious target-anchored scores detected and reset to 0.0. Score from code evidence only.",
    };
}

function checkTargetAnchoredImport(normalizedAssessments, validFindings, dimensionJudgment, config, opts) {
    if (opts.manualOverride || validFindings.length > 0) return false;
    const targetScore = Number(config?.target_strict_score ?? DEFAULT_TARGET_STRICT_SCORE);
    const scoreValues = Object.values(normalizedAssessments).filter(Number.isFinite);
    if (scoreValues.length === 0) return false;
    const scoreMean = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
    if (scoreValues.length === 1) {
        const singleDim = Object.keys(normalizedAssessments)[0];
        const singleHasRationale = Boolean(
            dimensionJudgment[singleDim]?.score_rationale ||
                dimensionJudgment[SUBJECTIVE_DIMENSIONS[singleDim]?.short_id]?.score_rationale,
        );
        return (
            Math.abs(scoreValues[0] - targetScore) <= 1.0 ||
            (scoreValues[0] >= 95 && !singleHasRationale)
        );
    }
    return (
        scoreValues.every((v) => Math.abs(v - targetScore) <= 1.0 || v >= 95) ||
        (scoreValues.length >= 4 && Math.abs(scoreMean - targetScore) <= 1.0)
    );
}

/**
 * Validate and import a subjective review payload into `state` (fail-closed unless `opts.allowPartial`).
 */
export function importReview(arg1, arg2, arg3, arg4 = {}, arg5 = {}) {
    const { state, config, payload, opts } = normalizeImportReviewCallArgs(arg1, arg2, arg3, arg4, arg5);
    const contextDir = opts.contextDir || null;
    const provenanceErr = verifyBlindPacketProvenance(contextDir, state, payload, opts);
    if (provenanceErr) return provenanceErr;

    const rawAssessments = payload.assessments || payload.dimensions || {};
    const rawFindings = Array.isArray(payload.findings)
        ? payload.findings
        : Array.isArray(payload.issues)
          ? payload.issues
          : [];
    const dimensionJudgment = payload.dimension_judgment || {};
    const contextUpdates = payload.context_updates || {};
    const dismissedConcerns = Array.isArray(payload.dismissed_concerns)
        ? payload.dismissed_concerns
        : [];

    const { errors, normalizedAssessments, validFindings } = validateReviewPayload(
        rawAssessments,
        rawFindings,
        dimensionJudgment,
        opts,
    );

    if (errors.length > 0 && !opts.allowPartial) {
        return {
            status: "error",
            errors,
            message: `Review import aborted (fail-closed): ${errors.join("; ")}`,
        };
    }

    if (checkTargetAnchoredImport(normalizedAssessments, validFindings, dimensionJudgment, config, opts)) {
        return resetTargetAnchoredAssessments(state, normalizedAssessments);
    }

    const nowIso = new Date().toISOString();
    const importedDims = applyImportedSubjectiveAssessments(
        state,
        normalizedAssessments,
        dimensionJudgment,
        dismissedConcerns,
        payload,
        opts,
        nowIso,
    );

    storeContextUpdates(state, contextUpdates, nowIso);

    const importedDimSet = new Set(Object.keys(normalizedAssessments));
    const importedFindings = storeImportedReviewFindings(state, validFindings, importedDimSet, nowIso);

    if (!state.review_cache) state.review_cache = {};
    state.review_cache.holistic = {
        reviewed_at: nowIso,
        dimensions_reviewed: [...importedDimSet],
        total_files: Number(opts.totalProdFiles || state.review_cache?.holistic?.total_files || 0),
    };

    const qPath = contextDir ? queryFilePath(contextDir) : null;
    const queryObj = qPath && existsSync(qPath) ? readJson(qPath) : null;
    const usedSessId =
        payload.session_id ||
        payload.session?.id ||
        queryObj?.session_id ||
        queryObj?.session?.id;
    if (usedSessId && state?.review_sessions?.[usedSessId]) {
        state.review_sessions[usedSessId].used_at = nowIso;
    }

    cleanupStaleDismissals(state);

    return {
        status: "imported",
        imported_dimensions: importedDims,
        imported_findings: importedFindings,
        errors,
    };
}

export function buildBatchPromptMarkdown(prep, batchObj) {
    const dimIds = batchObj.dimensions.map((d) => d.id);
    const persona =
        batchObj.persona ||
        REVIEWER_PERSONAS[((batchObj.batch || 1) - 1) % REVIEWER_PERSONAS.length];
    const schemaSubset = {
        session: { id: prep.session_id, token: prep.token },
        assessments: Object.fromEntries(dimIds.map((d) => [d, 85])),
        dimension_judgment: Object.fromEntries(
            dimIds.map((d) => [
                d,
                {
                    dimension_character: "2-3 sentences characterizing this dimension in the codebase",
                    score_rationale: "2-3 sentences weighing observations against the 0-100 anchors",
                    strengths: ["concrete positive pattern observed"],
                },
            ]),
        ),
        findings: [
            {
                dimension: dimIds[0] || "high_level_elegance",
                identifier: "short_snake_id",
                summary: "one-line defect summary",
                related_files: ["relative/path/to/file.ext"],
                evidence: ["specific code observation with line numbers"],
                suggestion: "concrete fix recommendation",
                confidence: "high",
            },
        ],
    };

    return [
        `# Blind Codebase Review — Batch ${batchObj.batch}: ${batchObj.theme}`,
        "",
        "Score ONLY from code evidence against the rubrics and anchors below. Do NOT anchor to target thresholds.",
        "Output ONLY valid JSON matching the schema at the end of this prompt.",
        "",
        persona
            ? [
                  `## Reviewer Persona: ${persona.name}`,
                  `- **Bias**: ${persona.bias}`,
                  `- **Guiding Question**: ${persona.question}`,
                  "",
              ].join("\n")
            : "",
        prep.retrospective &&
        (prep.retrospective.recent_issues?.length > 0 || prep.retrospective.policies?.length > 0)
            ? `## Retrospective & Active Policies\n${JSON.stringify(prep.retrospective, null, 2)}\n`
            : "",
        "## Dimensions to Assess",
        JSON.stringify(batchObj.dimensions, null, 2),
        "",
        batchObj.concern_signals?.length > 0
            ? `## Synthesized Concern Signals\n${JSON.stringify(batchObj.concern_signals, null, 2)}\n`
            : "",
        "## Required JSON Output Format",
        "```json",
        JSON.stringify(schemaSubset, null, 2),
        "```",
    ]
        .filter(Boolean)
        .join("\n");
}

function spawnReviewRunnerProcess(rootDir, runner, runnerCmd, promptFilePath, promptText) {
    if (runnerCmd) {
        return spawn(runnerCmd, {
            cwd: rootDir,
            shell: true,
            env: {
                ...process.env,
                PLEXER_PROMPT_FILE: promptFilePath || "",
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    const norm = (runner || "claude").toLowerCase();
    let bin = "claude";
    let args = ["-p", promptText];
    if (norm === "codex") {
        bin = "codex";
        args = ["exec", promptText];
    } else if (norm === "gemini") {
        bin = "gemini";
        args = ["-p", promptText];
    }
    return spawn(bin, args, {
        cwd: rootDir,
        stdio: ["pipe", "pipe", "pipe"],
    });
}

function flushRunnerPromptStdin(child, runnerCmd, promptText) {
    if (runnerCmd && child.stdin) {
        try {
            child.stdin.write(promptText || "");
            child.stdin.end();
        } catch {
            // Ignore broken pipe if fast-exiting command doesn't read stdin
        }
    } else if (child.stdin) {
        try {
            child.stdin.end();
        } catch {
            // Ignore
        }
    }
}

export function invokeRunnerSubprocess(
    rootDir,
    runner,
    runnerCmd,
    promptFilePath,
    promptText,
    opts = {},
) {
    const stallKillSeconds = Number(opts.stallKillSeconds ?? 120);
    const stallMs = Math.max(50, stallKillSeconds * 1000);

    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawnReviewRunnerProcess(rootDir, runner, runnerCmd, promptFilePath, promptText);
        let stdout = "";
        let stderr = "";
        let settled = false;
        let stallTimer = null;
        let killEscalationTimer = null;

        const clearTimers = () => {
            if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
            }
            if (killEscalationTimer) {
                clearTimeout(killEscalationTimer);
                killEscalationTimer = null;
            }
        };

        const armStallWatchdog = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try {
                    child.kill("SIGTERM");
                } catch {
                    // Ignore
                }
                killEscalationTimer = setTimeout(() => {
                    try {
                        child.kill("SIGKILL");
                    } catch {
                        // Ignore
                    }
                }, 200);
                if (typeof killEscalationTimer.unref === "function") {
                    killEscalationTimer.unref();
                }
                rejectPromise(
                    new Error(`Runner stalled (silent for ${stallKillSeconds}s) and was killed`),
                );
            }, stallMs);
            if (typeof stallTimer.unref === "function") {
                stallTimer.unref();
            }
        };

        armStallWatchdog();

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            armStallWatchdog();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            armStallWatchdog();
        });
        child.on("error", (err) => {
            clearTimers();
            if (!settled) {
                settled = true;
                rejectPromise(err);
            }
        });
        child.on("close", (code) => {
            clearTimers();
            if (settled) return;
            settled = true;
            if (code !== 0) {
                rejectPromise(new Error(`Runner exited with code ${code}: ${stderr.trim()}`));
            } else {
                resolvePromise(stdout);
            }
        });

        flushRunnerPromptStdin(child, runnerCmd, promptText);
    });
}

async function executeSingleReviewBatchWithRetry(
    rootDir,
    hDir,
    prep,
    batchObj,
    runner,
    runnerCmd,
    maxRetries,
    retryBackoffMs,
    opts,
) {
    const promptMd = buildBatchPromptMarkdown(prep, batchObj);
    const promptPath = join(hDir, `batch-${batchObj.batch}.prompt.md`);
    const outPath = join(hDir, batchObj.output_file || `batch-${batchObj.batch}.raw.txt`);
    writeFileSync(promptPath, promptMd, "utf8");
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const rawOut = await invokeRunnerSubprocess(
                rootDir,
                runner,
                runnerCmd,
                promptPath,
                promptMd,
                opts,
            );
            writeFileSync(outPath, rawOut, "utf8");
            return {
                ok: true,
                result: {
                    batch: batchObj.batch,
                    persona: batchObj.persona?.name || null,
                    attempts: attempt + 1,
                    output_file: outPath,
                    status: "completed",
                },
            };
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, retryBackoffMs * (attempt + 1)));
            }
        }
    }
    return {
        ok: false,
        error: {
            batch: batchObj.batch,
            error: lastErr?.message || "Batch failed",
        },
    };
}

/**
 * Run subjective review batches in bounded waves (`plexer health review --run-batches`),
 * write `batch-<N>.raw.txt`, merge, and import into `state`.
 */
export async function runReviewBatches(
    rootDir,
    contextDir,
    graph,
    state,
    config,
    zoneMap,
    readLines,
    totalProdFiles,
    opts = {},
) {
    const prep = prepareReview(contextDir, graph, state, zoneMap, readLines, opts);
    const hDir = healthDir(contextDir);
    mkdirSync(hDir, { recursive: true });

    const batches = prep.batches || [];
    const maxConcurrency =
        opts.parallel === false
            ? 1
            : Math.max(1, Math.min(5, Number(opts.concurrency) || 3));
    const runner = opts.runner || "claude";
    const runnerCmd = opts.runnerCmd || null;
    const maxRetries = Math.max(0, Number(opts.maxRetries ?? 1));
    const retryBackoffMs = Math.max(10, Number(opts.retryBackoffMs ?? 500));

    const batchResults = [];
    const batchErrors = [];

    for (let i = 0; i < batches.length; i += maxConcurrency) {
        const wave = batches.slice(i, i + maxConcurrency);
        const waveOutcomes = await Promise.all(
            wave.map((b) =>
                executeSingleReviewBatchWithRetry(
                    rootDir,
                    hDir,
                    prep,
                    b,
                    runner,
                    runnerCmd,
                    maxRetries,
                    retryBackoffMs,
                    opts,
                ),
            ),
        );
        for (const out of waveOutcomes) {
            if (out.ok) {
                batchResults.push(out.result);
            } else {
                batchErrors.push(out.error);
            }
        }
    }

    if (batchResults.length === 0) {
        return {
            action: "review_run_batches",
            status: "failed",
            runner: runnerCmd || runner,
            batches_attempted: batches.length,
            batches_completed: 0,
            errors: batchErrors,
        };
    }

    const completedFiles = batchResults.map((r) => r.output_file);
    const merged = mergeReviewBatches(completedFiles, { similarity: opts.similarity });
    merged.session = { id: prep.session_id, token: prep.token };
    const mergedPath = join(hDir, "merged_review.json");
    writeJsonAtomic(mergedPath, merged, true);

    const imp = importReview(state, config, merged, {
        contextDir,
        allowPartial: opts.allowPartial || batchErrors.length > 0,
        manualOverride: opts.manualOverride,
        attestedExternal: true,
        strictGuard: opts.strictGuard,
        attest: opts.attest || ATTEST_BLIND_REVIEW_EXAMPLE,
        totalProdFiles,
    });

    return {
        action: "review_run_batches",
        runner: runnerCmd || runner,
        concurrency: maxConcurrency,
        batches_attempted: batches.length,
        batches_completed: batchResults.length,
        batch_errors: batchErrors,
        merged_path: mergedPath,
        ...imp,
    };
}

/**
 * Automate living plan triage stages (`observe`, `reflect`, `organize`, `complete`)
 * via the configured CLI runner (`plexer health plan triage --run-stages`).
 */
export async function runTriageStages(rootDir, contextDir, state, plan, opts = {}) {
    const runner = opts.runner || "claude";
    const runnerCmd = opts.runnerCmd || null;
    const hDir = healthDir(contextDir);
    mkdirSync(hDir, { recursive: true });

    const openIssues = Object.values(state.issues || {})
        .filter((i) => i.status === "open" && !i.suppressed)
        .slice(0, 40)
        .map((i) => ({ id: i.id, detector: i.detector, tier: i.tier, file: i.file, summary: i.summary }));

    const promptText = [
        "# Codebase Health Triage",
        "Analyze the open findings below and return a JSON object with keys:",
        '`{ "observe": "...", "reflect": "...", "organize": "...", "strategy": "..." }`',
        "",
        JSON.stringify(openIssues, null, 2),
    ].join("\n");

    const promptPath = join(hDir, "triage.prompt.md");
    writeFileSync(promptPath, promptText, "utf8");

    let parsed = null;
    try {
        const rawOut = await invokeRunnerSubprocess(
            rootDir,
            runner,
            runnerCmd,
            promptPath,
            promptText,
        );
        parsed = parseReviewRawText(rawOut);
    } catch {
        // Fallback deterministic synthesis if runner fails or returns non-JSON
    }

    const byDet = new Map();
    for (const iss of openIssues) {
        byDet.set(iss.detector, (byDet.get(iss.detector) || 0) + 1);
    }
    const topDets = [...byDet.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([d, c]) => `${d} (${c})`)
        .join(", ");

    const observeReport =
        parsed?.observe || `Observed ${openIssues.length} open findings across: ${topDets || "none"}.`;
    const reflectReport =
        parsed?.reflect || "Reviewed root causes and cross-module dependencies across open findings.";
    const organizeReport =
        parsed?.organize || "Prioritized high-tier architectural and boundary issues before local cleanup.";
    const strategyReport =
        parsed?.strategy || "Execute top-ranked clusters in order, verifying callers and tests after each batch.";

    const nowIso = new Date().toISOString();
    if (!plan.triage) plan.triage = emptyLivingPlan().triage;
    if (!plan.triage.stages) plan.triage.stages = {};
    plan.triage.stages.observe = { report: observeReport, updated_at: nowIso };
    plan.triage.stages.reflect = { report: reflectReport, updated_at: nowIso };
    plan.triage.stages.organize = { report: organizeReport, updated_at: nowIso };
    plan.triage.completed = true;
    plan.triage.strategy = strategyReport;
    plan.triage.completed_at = nowIso;
    if (state?.issues) {
        const allIssues = Object.values(state.issues);
        plan.triage.triaged_review_ids = allIssues
            .filter((i) => i.status === "open" && !i.suppressed && i.detector === "review")
            .map((i) => i.id);
        plan.triage.last_mechanical_count = allIssues.filter(
            (i) => i.status === "open" && !i.suppressed && i.detector !== "review",
        ).length;
    }

    return {
        action: "plan_triage_run_stages",
        runner: runnerCmd || runner,
        stage: "complete",
        triage: plan.triage,
        stale: false,
    };
}
