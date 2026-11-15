/**
 * Codebase health scoring engine:
 * - 5 Mechanical dimensions + 20 Subjective dimensions (25% / 75% split once subjective scores exist)
 * - Sample dampening (< 200 checks)
 * - Per-file failure caps (1.0 for 1-2 issues, 1.5 for 3-5, 2.0 for 6+) on file-based dimensions
 * - Issue-penalized subjective dimension scores in `strict`/`verified` modes when open `review` issues exist
 * - 4 Score variants: `strict` (North Star), `overall` (lenient), `objective` (mechanical), `verified`
 * - Scorecard SVG badge generator (`scorecard.svg`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    BADGE_FILE,
    CONFIDENCE_WEIGHTS,
    MECHANICAL_DIMENSIONS,
    MECHANICAL_POOL_WEIGHT,
    SAMPLE_DAMPENING_THRESHOLD,
    SCORECARD_FILE,
    SUBJECTIVE_DIMENSIONS,
    SUBJECTIVE_POOL_WEIGHT,
    SUBJECTIVE_TOTAL_WEIGHT,
    normalizeDimensionKey,
} from "./constants.js";
import { healthDir } from "./state.js";

const MAX_REVIEW_ISSUES_FOR_SPAN = 15;
const REVIEW_ISSUE_PENALTY_SPAN = 40.0;
const TIER_WEIGHTS = {
    T1: 1.5,
    T2: 1.25,
    T3: 1.0,
    T4: 0.5,
};

function round(val, decimals = 2) {
    return Number(Number(val || 0).toFixed(decimals));
}

function issuePenaltyWeight(iss) {
    const confW = CONFIDENCE_WEIGHTS[iss?.confidence] ?? 0.7;
    const tierW = TIER_WEIGHTS[iss?.tier] ?? 1.0;
    return confW * tierW;
}

function fileCappedFailureUnits(weightedCount) {
    if (weightedCount <= 0) return 0;
    // Strictly monotone concave curve in [0, 2.0] so suppressing or fixing any single
    // finding in multi-issue files always improves strict/overall scores.
    if (weightedCount <= 2.0) return weightedCount * 0.5;
    if (weightedCount <= 5.0) return 1.0 + ((weightedCount - 2.0) / 3.0) * 0.5;
    return 1.5 + Math.min(0.5, (weightedCount - 5.0) * 0.05);
}

function effectiveDimensionPotential(dimDef, potentials) {
    const positive = [];
    for (const det of dimDef.detectors) {
        const val = Number(potentials?.[det] || 0);
        if (val > 0) positive.push(val);
    }
    if (positive.length === 0) return 20;

    if (dimDef.fileBased) {
        // File-based dimensions deduplicate and cap failures per file (0..2 units/file),
        // so use the upper-median detector surface * 2 instead of summing N overlapping detectors.
        positive.sort((a, b) => a - b);
        const medianSurface = positive[Math.floor(positive.length * 0.5)];
        return Math.max(20, round(medianSurface * 2.0, 2));
    }

    let sum = 0;
    for (const val of positive) sum += val;
    return Math.max(20, sum);
}

function countsTowardVariant(issue, variant) {
    const st = issue.status || "open";
    const isMechUnverifiedFix =
        st === "fixed" && issue.detector !== "review" && issue.source !== "review" && issue.verified === false;
    if (variant === "lenient") {
        if (issue.suppressed || st === "false_positive") return false;
        // `open`, `deferred`, `triaged_out` count as failures; `wontfix`, `fixed`, `auto_resolved` do not
        return st === "open" || st === "deferred" || st === "triaged_out";
    }
    if (variant === "strict") {
        if (st === "false_positive") return false;
        if (isMechUnverifiedFix) return true;
        // `wontfix` also counts as failure in strict mode; attested `false_positive` does not.
        return st === "open" || st === "deferred" || st === "triaged_out" || st === "wontfix";
    }
    if (variant === "verified") {
        if (st === "false_positive") return false;
        // Like strict, plus unverified `fixed` items (including review issues) count as failure until rescan confirms them!
        if (st === "fixed" && !issue.verified) return true;
        return st === "open" || st === "deferred" || st === "triaged_out" || st === "wontfix";
    }
    if (issue.suppressed || st === "false_positive") return false;
    return st === "open";
}

function computeMechanicalDimensionScore(dimDef, allIssues, potentials, variant) {
    const detSet = new Set(dimDef.detectors);
    const potential = effectiveDimensionPotential(dimDef, potentials);

    const matchingIssues = allIssues.filter(
        (iss) =>
            iss.detector !== "review" &&
            (iss.dimension ? iss.dimension === dimDef.id : detSet.has(iss.detector)) &&
            countsTowardVariant(iss, variant),
    );

    let weightedFailures = 0;
    if (dimDef.fileBased) {
        const byFile = new Map();
        for (const iss of matchingIssues) {
            const w = issuePenaltyWeight(iss);
            const f = iss.file || "repo";
            byFile.set(f, (byFile.get(f) || 0) + w);
        }
        for (const rawFileWeight of byFile.values()) {
            weightedFailures += fileCappedFailureUnits(rawFileWeight);
        }
    } else {
        for (const iss of matchingIssues) {
            const w = issuePenaltyWeight(iss);
            weightedFailures += w;
        }
    }

    const rawScore = Math.max(0, Math.min(100, ((potential - weightedFailures) / potential) * 100));
    const dampening = Math.min(1.0, potential / SAMPLE_DAMPENING_THRESHOLD);
    const sampleFactor = Math.max(0.25, dampening);
    const effectiveWeight = dimDef.weight * sampleFactor;
    const roundedScore = round(rawScore, 2);

    return {
        id: dimDef.id,
        name: dimDef.name,
        pool: "mechanical",
        potential,
        failures: round(weightedFailures, 2),
        open_count: matchingIssues.length,
        score: roundedScore,
        strict: roundedScore,
        weight: dimDef.weight,
        sample_factor: round(sampleFactor, 3),
        effective_weight: round(effectiveWeight, 3),
        pool_share: 0,
        overall_per_point: 0,
        overall_drag: 0,
    };
}

function calcMechanicalPool(allIssues, potentials, variant) {
    const dims = {};
    let weightedSum = 0;
    let totalWeight = 0;
    for (const dimDef of Object.values(MECHANICAL_DIMENSIONS)) {
        const res = computeMechanicalDimensionScore(dimDef, allIssues, potentials, variant);
        dims[dimDef.id] = res;
        weightedSum += res.score * res.effective_weight;
        totalWeight += res.effective_weight;
    }
    for (const d of Object.values(dims)) {
        d.pool_share = totalWeight > 0 ? round(d.effective_weight / totalWeight, 4) : 0;
    }
    const poolScore = totalWeight > 0 ? weightedSum / totalWeight : 100.0;
    return { poolScore: round(poolScore, 2), totalWeight, dims };
}

function reviewIssuesByDim(allIssues, variant) {
    const counts = new Map();
    for (const iss of allIssues) {
        if (iss.detector !== "review") continue;
        if (!countsTowardVariant(iss, variant)) continue;
        const dKey = normalizeDimensionKey(iss.dimension);
        if (!dKey) continue;
        const weight = CONFIDENCE_WEIGHTS[iss.confidence] ?? 0.7;
        counts.set(dKey, (counts.get(dKey) || 0) + weight);
    }
    return counts;
}

function calcReviewPenalty(revWeight, span = REVIEW_ISSUE_PENALTY_SPAN) {
    if (revWeight <= 0) return 0;
    return Math.min(span, (revWeight / MAX_REVIEW_ISSUES_FOR_SPAN) * span);
}

function buildSubjectiveDimEntry(
    sDef,
    entry,
    openRevWeight,
    lenientRevWeight,
    verifiedRevWeight = openRevWeight,
) {
    const isScanReset = entry?.reset_by === "scan_reset_subjective";
    const isTargetReset = entry?.reset_by === "target_anchored_reset";
    const hasScore =
        entry &&
        !isScanReset &&
        (isTargetReset || !entry.placeholder) &&
        typeof entry.score === "number" &&
        Number.isFinite(entry.score);
    if (!hasScore) {
        return {
            hasScore: false,
            dimObj: {
                id: sDef.id,
                short_id: sDef.short_id,
                name: sDef.name,
                pool: "subjective",
                score: null,
                strict: null,
                lenient_score: null,
                assessment_score: null,
                open_review_issues: Math.ceil(openRevWeight),
                weight: sDef.weight,
                sample_factor: 0,
                effective_weight: 0,
                pool_share: 0,
                overall_per_point: 0,
                overall_drag: 0,
                assessed_at: null,
                stale: Boolean(entry?.stale || isScanReset),
                stale_reason: entry?.stale_reason || (isScanReset ? "reset_on_scan" : null),
                reset_by: entry?.reset_by || null,
                judgment: null,
            },
        };
    }

    const rawAssessment = Math.max(0, Math.min(100, Number(entry.score)));
    const strictPenalty = calcReviewPenalty(openRevWeight, REVIEW_ISSUE_PENALTY_SPAN);
    const verifiedPenalty = calcReviewPenalty(verifiedRevWeight, REVIEW_ISSUE_PENALTY_SPAN);
    const lenientPenalty = calcReviewPenalty(lenientRevWeight, REVIEW_ISSUE_PENALTY_SPAN * 0.5);

    const strictDimScore = Math.max(0, round(rawAssessment - strictPenalty, 2));
    const verifiedDimScore = Math.max(0, round(rawAssessment - verifiedPenalty, 2));
    const lenientDimScore = Math.max(0, round(rawAssessment - lenientPenalty, 2));

    return {
        hasScore: true,
        strictDimScore,
        verifiedDimScore,
        lenientDimScore,
        dimObj: {
            id: sDef.id,
            short_id: sDef.short_id,
            name: sDef.name,
            pool: "subjective",
            score: strictDimScore,
            strict: strictDimScore,
            lenient_score: lenientDimScore,
            assessment_score: round(rawAssessment, 1),
            open_review_issues: Math.ceil(openRevWeight),
            weight: sDef.weight,
            sample_factor: 1,
            effective_weight: sDef.weight,
            pool_share: 0,
            overall_per_point: 0,
            overall_drag: 0,
            assessed_at: entry.assessed_at || null,
            stale: Boolean(entry.stale),
            stale_reason: entry.stale_reason || null,
            placeholder: Boolean(entry.placeholder),
            reset_by: entry.reset_by || null,
            judgment: entry.judgment || null,
        },
    };
}

function computeSubjectivePoolBreakdown(
    rawSubjAssessments,
    strictReviewIssues,
    lenientReviewIssues,
    verifiedReviewIssues = strictReviewIssues,
) {
    const subjAssessments = {};
    for (const [k, v] of Object.entries(rawSubjAssessments)) {
        const norm = normalizeDimensionKey(k);
        if (norm) subjAssessments[norm] = v;
    }

    const subjDims = {};
    let subjLenientWeightedSum = 0;
    let subjStrictWeightedSum = 0;
    let subjVerifiedWeightedSum = 0;
    let subjTotalWeight = 0;
    let hasSubjectiveScores = false;

    for (const sDef of Object.values(SUBJECTIVE_DIMENSIONS)) {
        const built = buildSubjectiveDimEntry(
            sDef,
            subjAssessments[sDef.id],
            strictReviewIssues.get(sDef.id) || 0,
            lenientReviewIssues.get(sDef.id) || 0,
            verifiedReviewIssues.get(sDef.id) || 0,
        );
        subjDims[sDef.id] = built.dimObj;
        if (sDef.short_id && sDef.short_id !== sDef.id) {
            Object.defineProperty(subjDims, sDef.short_id, {
                value: built.dimObj,
                enumerable: false,
                configurable: true,
            });
        }
        if (built.hasScore) {
            hasSubjectiveScores = true;
            subjLenientWeightedSum += built.lenientDimScore * sDef.weight;
            subjStrictWeightedSum += built.strictDimScore * sDef.weight;
            subjVerifiedWeightedSum += built.verifiedDimScore * sDef.weight;
            subjTotalWeight += sDef.weight;
        }
    }

    const coverage =
        SUBJECTIVE_TOTAL_WEIGHT > 0 ? Math.min(1.0, subjTotalWeight / SUBJECTIVE_TOTAL_WEIGHT) : 0;
    const effectivePoolWeight = hasSubjectiveScores ? round(SUBJECTIVE_POOL_WEIGHT * coverage, 4) : 0;

    for (const sDef of Object.values(SUBJECTIVE_DIMENSIONS)) {
        const d = subjDims[sDef.id];
        if (d && d.score !== null && subjTotalWeight > 0) {
            d.pool_share = round(d.effective_weight / subjTotalWeight, 4);
            d.overall_per_point = round(d.pool_share * effectivePoolWeight, 4);
            d.overall_drag = round((100 - d.strict) * d.overall_per_point, 2);
        }
    }

    const subjectiveStrictPoolScore =
        hasSubjectiveScores && subjTotalWeight > 0
            ? round(subjStrictWeightedSum / subjTotalWeight, 2)
            : null;
    const subjectiveVerifiedPoolScore =
        hasSubjectiveScores && subjTotalWeight > 0
            ? round(subjVerifiedWeightedSum / subjTotalWeight, 2)
            : null;
    const subjectiveLenientPoolScore =
        hasSubjectiveScores && subjTotalWeight > 0
            ? round(subjLenientWeightedSum / subjTotalWeight, 2)
            : null;

    return {
        subjDims,
        hasSubjectiveScores,
        subjectiveStrictPoolScore,
        subjectiveVerifiedPoolScore,
        subjectiveLenientPoolScore,
        coverage: round(coverage, 4),
        effectivePoolWeight,
    };
}

/**
 * Compute full score snapshot (`strict`, `overall`, `objective`, `verified`) + dimension breakdown.
 */
export function computeScoreSnapshot(state) {
    const allIssues = Object.values(state?.issues || {});
    const potentials = state?.potentials || {};
    const rawSubjAssessments = state?.subjective_assessments || state?.dimension_scores || {};

    const lenientMech = calcMechanicalPool(allIssues, potentials, "lenient");
    const strictMech = calcMechanicalPool(allIssues, potentials, "strict");
    const verifiedMech = calcMechanicalPool(allIssues, potentials, "verified");

    const lenientReviewIssues = reviewIssuesByDim(allIssues, "lenient");
    const strictReviewIssues = reviewIssuesByDim(allIssues, "strict");
    const verifiedReviewIssues = reviewIssuesByDim(allIssues, "verified");

    const {
        subjDims,
        hasSubjectiveScores,
        subjectiveStrictPoolScore,
        subjectiveVerifiedPoolScore,
        subjectiveLenientPoolScore,
        coverage: subjectiveCoverage,
        effectivePoolWeight,
    } = computeSubjectivePoolBreakdown(
        rawSubjAssessments,
        strictReviewIssues,
        lenientReviewIssues,
        verifiedReviewIssues,
    );

    const mechPoolFactor = hasSubjectiveScores ? round(1.0 - effectivePoolWeight, 4) : 1.0;
    for (const d of Object.values(strictMech.dims)) {
        d.lenient_score = lenientMech.dims[d.id]?.score ?? d.score;
        d.overall_per_point = round(d.pool_share * mechPoolFactor, 4);
        d.overall_drag = round((100 - d.strict) * d.overall_per_point, 2);
    }

    const blend = (mechScore, subjScore) =>
        subjScore === null
            ? mechScore
            : round(mechScore * (1.0 - effectivePoolWeight) + subjScore * effectivePoolWeight, 2);

    const overall = blend(lenientMech.poolScore, subjectiveLenientPoolScore);
    const strict = blend(strictMech.poolScore, subjectiveStrictPoolScore);
    const verified = blend(verifiedMech.poolScore, subjectiveVerifiedPoolScore);
    const objective = strictMech.poolScore;
    const wontfixCount = allIssues.filter((i) => i.status === "wontfix").length;
    const falsePositiveCount = allIssues.filter((i) => i.status === "false_positive").length;
    const unverifiedFixedCount = allIssues.filter(
        (i) => i.status === "fixed" && i.verified === false,
    ).length;
    const baseIgnoreIntegrity = state?.ignore_integrity || {
        ignored_count: 0,
        suppressed_pct: 0,
        ignored_by_detector: {},
    };
    const falsePositivePct = allIssues.length > 0 ? round((falsePositiveCount / allIssues.length) * 100, 1) : 0;
    const falsePositiveAbuseWarning =
        falsePositivePct > 10 && (allIssues.length >= 5 || falsePositiveCount >= 3);
    const staleDimensions = Object.values(subjDims)
        .filter((d) => d.stale)
        .map((d) => d.id);

    const allDimensions = { ...strictMech.dims, ...subjDims };
    for (const sDef of Object.values(SUBJECTIVE_DIMENSIONS)) {
        if (sDef.short_id && sDef.short_id !== sDef.id && subjDims[sDef.id]) {
            Object.defineProperty(allDimensions, sDef.short_id, {
                value: subjDims[sDef.id],
                enumerable: false,
                configurable: true,
            });
        }
    }

    return {
        strict,
        overall,
        objective,
        verified,
        wontfix_gap: round(Math.max(0, overall - strict), 2),
        wontfix_count: wontfixCount,
        false_positive_count: falsePositiveCount,
        unverified_fixed_count: unverifiedFixedCount,
        ignore_integrity: {
            ...baseIgnoreIntegrity,
            false_positive_count: falsePositiveCount,
            false_positive_pct: falsePositivePct,
            false_positive_abuse_warning: falsePositiveAbuseWarning,
        },
        has_subjective: hasSubjectiveScores,
        subjective_coverage: subjectiveCoverage,
        effective_pool_weight: effectivePoolWeight,
        subjective_pool_score: subjectiveStrictPoolScore,
        stale_dimensions: staleDimensions,
        dimensions: allDimensions,
        mechanical_dimensions: strictMech.dims,
        subjective_dimensions: subjDims,
    };
}

function resolveMechDimensionId(iss) {
    if (iss.dimension && MECHANICAL_DIMENSIONS[iss.dimension]) return iss.dimension;
    for (const dimDef of Object.values(MECHANICAL_DIMENSIONS)) {
        if (dimDef.detectors.includes(iss.detector)) return dimDef.id;
    }
    return "code_quality";
}

function buildMechDimImpactState(dimDef, issuesList, potentials, mechPoolFactor, lenientMechPoolFactor) {
    const potential = effectiveDimensionPotential(dimDef, potentials);
    const strictByFile = new Map();
    const lenientByFile = new Map();
    let strictRawTotal = 0;
    let lenientRawTotal = 0;

    for (const iss of issuesList) {
        const w = issuePenaltyWeight(iss);
        const f = iss.file || "repo";
        if (countsTowardVariant(iss, "strict")) {
            if (dimDef.fileBased) strictByFile.set(f, (strictByFile.get(f) || 0) + w);
            else strictRawTotal += w;
        }
        if (countsTowardVariant(iss, "lenient")) {
            if (dimDef.fileBased) lenientByFile.set(f, (lenientByFile.get(f) || 0) + w);
            else lenientRawTotal += w;
        }
    }

    let strictFailures = strictRawTotal;
    let lenientFailures = lenientRawTotal;
    if (dimDef.fileBased) {
        strictFailures = 0;
        for (const rw of strictByFile.values()) strictFailures += fileCappedFailureUnits(rw);
        lenientFailures = 0;
        for (const rw of lenientByFile.values()) lenientFailures += fileCappedFailureUnits(rw);
    }

    const dampening = Math.min(1.0, potential / SAMPLE_DAMPENING_THRESHOLD);
    const sampleFactor = Math.max(0.25, dampening);
    return {
        dimDef,
        potential,
        effectiveWeight: dimDef.weight * sampleFactor,
        strictFailures,
        lenientFailures,
        strictByFile,
        lenientByFile,
        strictRaw: Math.max(0, Math.min(100, ((potential - strictFailures) / potential) * 100)),
        lenientRaw: Math.max(0, Math.min(100, ((potential - lenientFailures) / potential) * 100)),
        poolShare: 0,
        mechPoolFactor,
        lenientMechPoolFactor,
    };
}

/**
 * Build an `O(1)` per-issue analytical score impact estimator over one pre-indexed pass of `state`.
 */
function bucketImpactIssuesByDim(issuesMap) {
    const mechByDim = new Map();
    const revByDim = new Map();
    for (const iss of Object.values(issuesMap)) {
        if (iss.detector === "review") {
            const dKey = normalizeDimensionKey(iss.dimension);
            if (!dKey) continue;
            let list = revByDim.get(dKey);
            if (!list) revByDim.set(dKey, (list = []));
            list.push(iss);
        } else {
            const dimId = resolveMechDimensionId(iss);
            let list = mechByDim.get(dimId);
            if (!list) mechByDim.set(dimId, (list = []));
            list.push(iss);
        }
    }
    return { mechByDim, revByDim };
}

function buildMechDimImpactMap(baseScores, mechByDim, potentials) {
    const effWeightFactor = baseScores.has_subjective ? 1.0 - (baseScores.effective_pool_weight || 0) : 1.0;
    const mechDims = new Map();
    let totalMechEffWeight = 0;
    for (const dimDef of Object.values(MECHANICAL_DIMENSIONS)) {
        const entry = buildMechDimImpactState(dimDef, mechByDim.get(dimDef.id) || [], potentials, effWeightFactor, effWeightFactor);
        mechDims.set(dimDef.id, entry);
        totalMechEffWeight += entry.effectiveWeight;
    }
    for (const entry of mechDims.values()) {
        entry.poolShare = totalMechEffWeight > 0 ? entry.effectiveWeight / totalMechEffWeight : 0;
    }
    return mechDims;
}

function buildSubjDimImpactMap(baseScores, revByDim) {
    const subjDims = new Map();
    for (const [dKey, sObj] of Object.entries(baseScores.subjective_dimensions || {})) {
        if (!sObj || sObj.assessment_score === null || sObj.assessment_score === undefined) continue;
        let strictW = 0;
        let lenientW = 0;
        for (const iss of revByDim.get(dKey) || []) {
            const w = CONFIDENCE_WEIGHTS[iss.confidence] ?? 0.7;
            if (countsTowardVariant(iss, "strict")) strictW += w;
            if (countsTowardVariant(iss, "lenient")) lenientW += w;
        }
        const rawAssessment = Number(sObj.assessment_score);
        subjDims.set(dKey, {
            rawAssessment,
            strictW,
            lenientW,
            strictDimScore: Math.max(0, rawAssessment - calcReviewPenalty(strictW, REVIEW_ISSUE_PENALTY_SPAN)),
            lenientDimScore: Math.max(0, rawAssessment - calcReviewPenalty(lenientW, REVIEW_ISSUE_PENALTY_SPAN * 0.5)),
            overallPerPoint: sObj.overall_per_point || 0,
        });
    }
    return subjDims;
}

function accumulateSingleIssueDelta(iss, seenIds, mechDeltas, revDeltas, mechDims, subjDims) {
    if (!iss || seenIds.has(iss.id) || iss.status === "fixed" || iss.status === "auto_resolved") return;
    seenIds.add(iss.id);
    if (iss.detector === "review") {
        const dKey = normalizeDimensionKey(iss.dimension);
        if (!dKey || !subjDims.has(dKey)) return;
        const w = CONFIDENCE_WEIGHTS[iss.confidence] ?? 0.7;
        const prev = revDeltas.get(dKey) || { strictW: 0, lenientW: 0 };
        if (countsTowardVariant(iss, "strict")) prev.strictW += w;
        if (countsTowardVariant(iss, "lenient")) prev.lenientW += w;
        revDeltas.set(dKey, prev);
        return;
    }
    const dimId = resolveMechDimensionId(iss);
    const mState = mechDims.get(dimId);
    if (!mState) return;
    const w = issuePenaltyWeight(iss);
    let dAcc = mechDeltas.get(dimId);
    if (!dAcc) mechDeltas.set(dimId, (dAcc = { strictByFile: new Map(), lenientByFile: new Map(), strictFlat: 0, lenientFlat: 0 }));
    const f = iss.file || "repo";
    if (countsTowardVariant(iss, "strict")) {
        if (mState.dimDef.fileBased) dAcc.strictByFile.set(f, (dAcc.strictByFile.get(f) || 0) + w);
        else dAcc.strictFlat += w;
    }
    if (countsTowardVariant(iss, "lenient")) {
        if (mState.dimDef.fileBased) dAcc.lenientByFile.set(f, (dAcc.lenientByFile.get(f) || 0) + w);
        else dAcc.lenientFlat += w;
    }
}

function sumFileCappedRemoval(byFileDeltas, baseByFile) {
    let removed = 0;
    for (const [f, rw] of byFileDeltas.entries()) {
        const baseW = baseByFile.get(f) || 0;
        removed += fileCappedFailureUnits(baseW) - fileCappedFailureUnits(Math.max(0, baseW - rw));
    }
    return removed;
}

function collectTargetImpactIssues(targetIssueIdsOrDetector, issuesMap, onIssue) {
    if (typeof targetIssueIdsOrDetector === "string") {
        const key = targetIssueIdsOrDetector.trim();
        if (issuesMap[key]) {
            onIssue(issuesMap[key]);
        } else {
            for (const iss of Object.values(issuesMap)) {
                if (iss.detector === key) onIssue(iss);
            }
        }
    } else if (Array.isArray(targetIssueIdsOrDetector) || targetIssueIdsOrDetector instanceof Set) {
        for (const item of targetIssueIdsOrDetector) {
            if (typeof item === "string") onIssue(issuesMap[item]);
            else if (item && typeof item === "object" && item.id) onIssue(issuesMap[item.id] || item);
        }
    }
}

function accumulateMechDeltaTotals(mechDeltas, mechDims, totals) {
    for (const [dimId, dAcc] of mechDeltas.entries()) {
        const m = mechDims.get(dimId);
        const strictRemoved = m.dimDef.fileBased ? sumFileCappedRemoval(dAcc.strictByFile, m.strictByFile) : dAcc.strictFlat;
        const lenientRemoved = m.dimDef.fileBased ? sumFileCappedRemoval(dAcc.lenientByFile, m.lenientByFile) : dAcc.lenientFlat;
        const newStrict = Math.max(0, Math.min(100, ((m.potential - Math.max(0, m.strictFailures - strictRemoved)) / m.potential) * 100));
        const newLenient = Math.max(0, Math.min(100, ((m.potential - Math.max(0, m.lenientFailures - lenientRemoved)) / m.potential) * 100));
        const dS = newStrict - m.strictRaw;
        const dL = newLenient - m.lenientRaw;
        totals.deltaObjective += dS * m.poolShare;
        totals.deltaStrict += dS * m.poolShare * m.mechPoolFactor;
        totals.deltaOverall += dL * m.poolShare * m.lenientMechPoolFactor;
    }
}

function accumulateSubjDeltaTotals(revDeltas, subjDims, totals) {
    for (const [dKey, rAcc] of revDeltas.entries()) {
        const s = subjDims.get(dKey);
        if (!s) continue;
        const newStrict = Math.max(0, s.rawAssessment - calcReviewPenalty(Math.max(0, s.strictW - rAcc.strictW), REVIEW_ISSUE_PENALTY_SPAN));
        const newLenient = Math.max(0, s.rawAssessment - calcReviewPenalty(Math.max(0, s.lenientW - rAcc.lenientW), REVIEW_ISSUE_PENALTY_SPAN * 0.5));
        totals.deltaStrict += (newStrict - s.strictDimScore) * s.overallPerPoint;
        totals.deltaOverall += (newLenient - s.lenientDimScore) * s.overallPerPoint;
    }
}

export function createFastScoreImpactEstimator(state, baselineScores = null) {
    if (!state || !state.issues) {
        return { estimateForIds: () => ({ deltaStrict: 0, deltaOverall: 0, deltaObjective: 0 }) };
    }
    const baseScores = baselineScores || computeScoreSnapshot(state);
    const issuesMap = state.issues;
    const { mechByDim, revByDim } = bucketImpactIssuesByDim(issuesMap);
    const mechDims = buildMechDimImpactMap(baseScores, mechByDim, state.potentials || {});
    const subjDims = buildSubjDimImpactMap(baseScores, revByDim);

    const estimateForIds = (targetIssueIdsOrDetector) => {
        const seenIds = new Set();
        const mechDeltas = new Map();
        const revDeltas = new Map();
        collectTargetImpactIssues(targetIssueIdsOrDetector, issuesMap, (iss) =>
            accumulateSingleIssueDelta(iss, seenIds, mechDeltas, revDeltas, mechDims, subjDims),
        );
        if (seenIds.size === 0) return { deltaStrict: 0, deltaOverall: 0, deltaObjective: 0 };
        const totals = { deltaStrict: 0, deltaOverall: 0, deltaObjective: 0 };
        accumulateMechDeltaTotals(mechDeltas, mechDims, totals);
        accumulateSubjDeltaTotals(revDeltas, subjDims, totals);
        return {
            deltaStrict: round(totals.deltaStrict, 2),
            deltaOverall: round(totals.deltaOverall, 2),
            deltaObjective: round(totals.deltaObjective, 2),
        };
    };

    return { estimateForIds };
}

/**
 * Simulate marking the given open issue IDs (Array/Set) or detector name as `fixed`
 * and compute `{ deltaStrict, deltaOverall, deltaObjective }`.
 */
export function computeScoreImpact(state, targetIssueIdsOrDetector, baselineScores = null) {
    return createFastScoreImpactEstimator(state, baselineScores).estimateForIds(targetIssueIdsOrDetector);
}

/**
 * Auto-cluster open issues by `<detector>:<top-dir>` when >= 3 issues share the same pattern.
 */
export function buildAutoClusters(issues) {
    const openIssues = Object.values(issues || {}).filter(
        (i) => i.status === "open" && !i.suppressed,
    );
    const groups = new Map();
    for (const iss of openIssues) {
        const topDir = (iss.file || "repo").split("/")[0] || "repo";
        const key = `auto:${iss.detector}:${topDir}`;
        let list = groups.get(key);
        if (!list) {
            list = [];
            groups.set(key, list);
        }
        list.push(iss.id);
    }
    const autoClusters = {};
    for (const [name, ids] of groups.entries()) {
        if (ids.length >= 3) {
            autoClusters[name] = {
                name,
                auto: true,
                issue_ids: ids,
                depends_on: [],
            };
        }
    }
    return autoClusters;
}

function scoreColorHex(val) {
    if (val === null || val === undefined || !Number.isFinite(val)) return "#64748b";
    if (val >= 95) return "#10b981";
    if (val >= 85) return "#3b82f6";
    if (val >= 70) return "#f59e0b";
    return "#ef4444";
}

function escapeXml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderScorecardBarRow(label, score, y, xOffset, barWidth = 175) {
    const hasScore = score !== null && score !== undefined && Number.isFinite(score);
    const pct = hasScore ? Math.max(0, Math.min(100, Number(score))) : 0;
    const fillW = Math.round((pct / 100) * barWidth);
    const col = scoreColorHex(hasScore ? pct : null);
    const valText = hasScore ? `${pct.toFixed(1)}%` : "unassessed";
    return [
        `  <text x="${xOffset}" y="${y + 10}" fill="#cbd5e1" font-family="monospace,sans-serif" font-size="11">${escapeXml(label)}</text>`,
        `  <rect x="${xOffset + 140}" y="${y}" width="${barWidth}" height="12" rx="3" fill="#1e293b"/>`,
        fillW > 0
            ? `  <rect x="${xOffset + 140}" y="${y}" width="${fillW}" height="12" rx="3" fill="${col}"/>`
            : "",
        `  <text x="${xOffset + 140 + barWidth + 8}" y="${y + 10}" fill="${hasScore ? "#f8fafc" : "#64748b"}" font-family="monospace,sans-serif" font-size="11" font-weight="bold">${valText}</text>`,
    ]
        .filter(Boolean)
        .join("\n");
}

function renderSparklineSvg(history, x, y, width, height) {
    const entries = Array.isArray(history)
        ? history.filter((h) => typeof h?.strict === "number" && Number.isFinite(h.strict))
        : [];
    if (entries.length < 2) {
        return `  <text x="${x}" y="${y + 14}" fill="#64748b" font-family="monospace,sans-serif" font-size="10">Trajectory: ${entries.length === 1 ? `baseline ${entries[0].strict.toFixed(1)}% (1 scan)` : "run scans over time to plot strict score trajectory"}</text>`;
    }
    const pts = entries.slice(-25);
    const minVal = Math.min(50, ...pts.map((p) => p.strict));
    const maxVal = 100;
    const span = Math.max(1, maxVal - minVal);
    const coords = pts.map((p, idx) => {
        const px = x + Math.round((idx / (pts.length - 1)) * width);
        const py = y + height - Math.round(((p.strict - minVal) / span) * height);
        return `${px},${py}`;
    });
    const first = pts[0].strict;
    const last = pts[pts.length - 1].strict;
    const delta = last - first;
    const deltaSign = delta >= 0 ? "+" : "";
    const stroke = delta >= 0 ? "#10b981" : "#f59e0b";
    return [
        `  <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="3" fill="#0f172a" stroke="#1e293b"/>`,
        `  <polyline fill="none" stroke="${stroke}" stroke-width="2" points="${coords.join(" ")}"/>`,
        `  <text x="${x + width + 10}" y="${y + 15}" fill="${stroke}" font-family="monospace,sans-serif" font-size="11" font-weight="bold">${deltaSign}${delta.toFixed(1)}% (${pts.length} pts)</text>`,
    ].join("\n");
}

/**
 * Emit both the full multi-dimension README scorecard (`plexer/.health/scorecard.svg`)
 * and the compact shield pill (`plexer/.health/badge.svg`).
 */
export function emitScorecardBadge(contextDir, scores, state = null) {
    const strict = scores.strict.toFixed(1);
    const color = scoreColorHex(scores.strict);
    const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="210" height="28" role="img" aria-label="plexer health: ${strict}">
  <rect width="125" height="28" rx="4" fill="#1e293b"/>
  <rect x="125" width="85" height="28" rx="4" fill="${color}"/>
  <text x="62" y="18" fill="#f8fafc" font-family="monospace,sans-serif" font-size="12" text-anchor="middle">plexer health</text>
  <text x="167" y="18" fill="#ffffff" font-family="monospace,sans-serif" font-size="12" font-weight="bold" text-anchor="middle">${strict} / 100</text>
</svg>\n`;

    const mechOrder = ["file_health", "code_quality", "duplication", "test_health", "security"];
    const mechRows = mechOrder.map((id, idx) => {
        const d = scores.mechanical_dimensions?.[id];
        return renderScorecardBarRow(d?.name || id, d?.score ?? 100, 128 + idx * 24, 24, 165);
    });

    const subjDims = scores.subjective_dimensions || {};
    const hiEl = subjDims.high_level_elegance?.score;
    const midEl = subjDims.mid_level_elegance?.score;
    const lowEl = subjDims.low_level_elegance?.score;
    const elScores = [hiEl, midEl, lowEl].filter((v) => typeof v === "number" && Number.isFinite(v));
    const combinedElegance =
        elScores.length > 0
            ? Number((elScores.reduce((a, b) => a + b, 0) / elScores.length).toFixed(1))
            : null;

    const rightItems = [
        { label: "Elegance (combined)", score: combinedElegance },
        { label: "Contracts", score: subjDims.contract_coherence?.score ?? null },
        { label: "Type safety", score: subjDims.type_safety?.score ?? null },
        { label: "Design coherence", score: subjDims.design_coherence?.score ?? null },
        { label: "Abstraction fit", score: subjDims.abstraction_fitness?.score ?? null },
        { label: "Cross-module arch", score: subjDims.cross_module_architecture?.score ?? null },
        { label: "Test strategy", score: subjDims.test_strategy?.score ?? null },
    ];
    const subjRows = rightItems.map((it, idx) =>
        renderScorecardBarRow(it.label, it.score, 128 + idx * 22, 420, 165),
    );

    const allIssues = Object.values(state?.issues || {});
    const openCount = allIssues.filter((i) => i.status === "open" && !i.suppressed).length;
    const fixedCount = allIssues.filter((i) => i.status === "fixed" || i.status === "auto_resolved").length;
    const wontfixCount = scores.wontfix_count || 0;

    const scorecardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="350" viewBox="0 0 820 350" role="img" aria-label="plexer health scorecard: strict ${strict}/100">
  <rect width="820" height="350" rx="10" fill="#0b0f19" stroke="#1e293b" stroke-width="2"/>
  <text x="24" y="34" fill="#f8fafc" font-family="monospace,sans-serif" font-size="16" font-weight="bold">plexer health scorecard</text>
  <text x="24" y="52" fill="#94a3b8" font-family="monospace,sans-serif" font-size="11">25% Mechanical AST/Graph · 75% Blind Subjective Review · Anti-Gaming North Star</text>

  <!-- Headline Gauges -->
  <rect x="24" y="64" width="182" height="40" rx="6" fill="#111827" stroke="${color}" stroke-width="1.5"/>
  <text x="36" y="81" fill="#94a3b8" font-family="monospace,sans-serif" font-size="10">STRICT (NORTH STAR)</text>
  <text x="36" y="97" fill="${color}" font-family="monospace,sans-serif" font-size="15" font-weight="bold">${strict} / 100</text>

  <rect x="218" y="64" width="182" height="40" rx="6" fill="#111827" stroke="#1e293b"/>
  <text x="230" y="81" fill="#94a3b8" font-family="monospace,sans-serif" font-size="10">OVERALL (LENIENT)</text>
  <text x="230" y="97" fill="${scoreColorHex(scores.overall)}" font-family="monospace,sans-serif" font-size="15" font-weight="bold">${scores.overall.toFixed(1)}%</text>

  <rect x="412" y="64" width="182" height="40" rx="6" fill="#111827" stroke="#1e293b"/>
  <text x="424" y="81" fill="#94a3b8" font-family="monospace,sans-serif" font-size="10">OBJECTIVE (MECHANICAL)</text>
  <text x="424" y="97" fill="${scoreColorHex(scores.objective)}" font-family="monospace,sans-serif" font-size="15" font-weight="bold">${scores.objective.toFixed(1)}%</text>

  <rect x="606" y="64" width="190" height="40" rx="6" fill="#111827" stroke="#1e293b"/>
  <text x="618" y="81" fill="#94a3b8" font-family="monospace,sans-serif" font-size="10">VERIFIED / WONTFIX GAP</text>
  <text x="618" y="97" fill="#e2e8f0" font-family="monospace,sans-serif" font-size="13" font-weight="bold">${scores.verified.toFixed(1)}% · gap ${scores.wontfix_gap.toFixed(1)}%</text>

  <!-- Dimension Columns -->
  <text x="24" y="120" fill="#94a3b8" font-family="monospace,sans-serif" font-size="11" font-weight="bold">MECHANICAL DIMENSIONS (25%)</text>
${mechRows.join("\n")}

  <text x="420" y="120" fill="#94a3b8" font-family="monospace,sans-serif" font-size="11" font-weight="bold">SUBJECTIVE DIMENSIONS (75%)</text>
${subjRows.join("\n")}

  <!-- Footer & Trajectory -->
  <line x1="24" y1="296" x2="796" y2="296" stroke="#1e293b" stroke-width="1"/>
  <text x="24" y="324" fill="#94a3b8" font-family="monospace,sans-serif" font-size="11">Issues: ${openCount} open · ${fixedCount} resolved · ${wontfixCount} wontfix</text>
${renderSparklineSvg(state?.history, 420, 308, 220, 24)}
</svg>\n`;

    const hDir = healthDir(contextDir);
    const scorecardPath = join(hDir, SCORECARD_FILE);
    const badgePath = join(hDir, BADGE_FILE);
    try {
        mkdirSync(hDir, { recursive: true });
        writeFileSync(scorecardPath, scorecardSvg, "utf8");
        writeFileSync(badgePath, badgeSvg, "utf8");
    } catch {
        // Ignore if directory is read-only
    }
    return scorecardPath;
}
