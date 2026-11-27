/**
 * Pure bounded file ranking.
 *
 * Binary IDF coverage supplies a bounded residual to one raw-lexical anchor.
 * Every other real candidate keeps its exact baseline score, and PageRank is
 * never recomputed or amplified by a file-level multiplier.
 */
function finitePositive(value) {
    return Number.isFinite(value) && value > 0;
}
function clamp01(value) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(1, value);
}
function tokenCost(candidate) {
    return Number.isFinite(candidate.emittedTokens) && candidate.emittedTokens >= 0
        ? candidate.emittedTokens
        : Number.POSITIVE_INFINITY;
}
function startOf(candidate) {
    return Number.isFinite(candidate.spanStart) && candidate.spanStart >= 0
        ? candidate.spanStart
        : Number.POSITIVE_INFINITY;
}
function coverage(candidate, queryWeights) {
    let share = 0;
    for (const term of candidate.matchedTerms) {
        const weight = queryWeights.get(term);
        if (finitePositive(weight ?? 0))
            share += weight;
    }
    return clamp01(share);
}
const TIE_EPSILON = 1e-9;

function baselineOrder(a, b) {
    const scoreOrder = b.baselineScore - a.baselineScore;
    if (Math.abs(scoreOrder) > TIE_EPSILON)
        return scoreOrder;
    const depOrder = Number(Boolean(a.dependency)) - Number(Boolean(b.dependency));
    if (depOrder !== 0)
        return depOrder;
    if (scoreOrder !== 0)
        return scoreOrder;
    if (a.baselineTieKey !== undefined && b.baselineTieKey !== undefined)
        return a.baselineTieKey.localeCompare(b.baselineTieKey);
    return (b.rawLexical - a.rawLexical ||
        tokenCost(a) - tokenCost(b) ||
        startOf(a) - startOf(b) ||
        a.id.localeCompare(b.id));
}
function lexicalAnchorOrder(a, b, queryWeights) {
    return (b.rawLexical - a.rawLexical ||
        coverage(b, queryWeights) - coverage(a, queryWeights) ||
        tokenCost(a) - tokenCost(b) ||
        startOf(a) - startOf(b) ||
        a.id.localeCompare(b.id));
}
/**
 * Rank exact files using the bounded anchor formula:
 *
 *   a_F = argmax rawLexical among eligible lexical symbols
 *   A_F = coverage(a_F)
 *   U_F = union coverage of eligible lexical symbols
 *   r_F = A_F (U_F - A_F) / U_F
 *   P_F = d_a [ell_a + (1 - ell_a) r_F + 0.5 p_a]
 *   S_F = max(P_F, max_j baseline_j)
 *
 * The anchor is the only pooled candidate. Graph-only symbols, residual nodes,
 * and all other lexical symbols remain exact baseline competitors.
 */
function groupRankableCandidatesByFile(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
        if (!candidate.file || !finitePositive(candidate.baselineScore))
            continue;
        const list = groups.get(candidate.file);
        if (list)
            list.push(candidate);
        else
            groups.set(candidate.file, [candidate]);
    }
    return groups;
}
function computeFileGroupCoverage(donors, allLexicalMembers, lexicalAnchor, queryWeights) {
    let unionCoverage = 0;
    let unionStrongCoverage = 0;
    let anchorCoverage = 0;
    let boundedResidual = 0;
    let pooledLexical = lexicalAnchor ? clamp01(lexicalAnchor.lexical) : 0;
    if (lexicalAnchor) {
        const unionTerms = new Set();
        for (const donor of allLexicalMembers)
            for (const term of donor.matchedTerms)
                unionTerms.add(term);
        for (const term of unionTerms) {
            const weight = queryWeights.get(term);
            if (finitePositive(weight ?? 0))
                unionCoverage += weight;
        }
        unionCoverage = clamp01(unionCoverage);
        const unionStrongTerms = new Set();
        for (const donor of donors)
            for (const term of donor.matchedStrongTerms ?? [])
                unionStrongTerms.add(term);
        for (const term of unionStrongTerms) {
            const weight = queryWeights.get(term);
            if (finitePositive(weight ?? 0))
                unionStrongCoverage += weight;
        }
        unionStrongCoverage = clamp01(unionStrongCoverage);
        anchorCoverage = coverage(lexicalAnchor, queryWeights);
        boundedResidual = unionCoverage > 0
            ? clamp01(anchorCoverage * Math.max(0, unionCoverage - anchorCoverage) /
                unionCoverage)
            : 0;
        pooledLexical = clamp01(lexicalAnchor.lexical +
            (1 - clamp01(lexicalAnchor.lexical)) * boundedResidual);
    }
    const lexicalDelta = lexicalAnchor
        ? Math.max(0, pooledLexical - clamp01(lexicalAnchor.lexical))
        : 0;
    return {
        unionCoverage,
        unionStrongCoverage,
        anchorCoverage,
        boundedResidual,
        pooledLexical,
        lexicalDelta,
    };
}
function scoreBoundedFileGroup(file, members, queryWeights) {
    const donors = members.filter((candidate) => candidate.kind === "symbol" &&
        candidate.eligible &&
        finitePositive(candidate.rawLexical) &&
        finitePositive(candidate.lexical));
    const allLexicalMembers = members.filter((candidate) =>
        finitePositive(candidate.rawLexical) &&
        finitePositive(candidate.lexical));
    donors.sort((a, b) => lexicalAnchorOrder(a, b, queryWeights));
    allLexicalMembers.sort((a, b) => lexicalAnchorOrder(a, b, queryWeights));
    const lexicalAnchor = donors[0] ?? allLexicalMembers[0];
    const cov = computeFileGroupCoverage(donors, allLexicalMembers, lexicalAnchor, queryWeights);
    const ordered = [...members].sort(baselineOrder);
    const baselineRepresentative = ordered[0];
    const coverageBonus = cov.unionCoverage > 0.5
        ? 0.22 * (cov.unionCoverage - 0.5) * (0.6 + 0.4 * cov.unionStrongCoverage)
        : 0;
    const graphScale = 0.5 * (0.35 + 0.65 * Math.max(cov.unionCoverage, cov.unionStrongCoverage));
    const pooledAnchorScore = lexicalAnchor
        ? clamp01(lexicalAnchor.rankFactor) *
            (cov.pooledLexical + graphScale * clamp01(lexicalAnchor.graph) + coverageBonus)
        : 0;
    const repCoverage = baselineRepresentative ? coverage(baselineRepresentative, queryWeights) : 0;
    const repResidual = cov.unionCoverage > 0 && repCoverage > 0
        ? clamp01(repCoverage * Math.max(0, cov.unionCoverage - repCoverage) / cov.unionCoverage)
        : 0;
    const pooledRepLexical = baselineRepresentative
        ? clamp01(baselineRepresentative.lexical + (1 - clamp01(baselineRepresentative.lexical)) * repResidual)
        : 0;
    const repGraph = baselineRepresentative
        ? (baselineRepresentative.kind === "file"
            ? Math.max(clamp01(baselineRepresentative.graph), clamp01(lexicalAnchor?.graph ?? 0))
            : clamp01(baselineRepresentative.graph))
        : 0;
    const pooledRepScore = baselineRepresentative
        ? clamp01(baselineRepresentative.rankFactor) *
            (pooledRepLexical + graphScale * repGraph + coverageBonus)
        : 0;
    const baselineFloor = baselineRepresentative?.baselineScore ?? 0;
    const effectiveRepScore = Math.max(pooledRepScore, baselineFloor);
    const pooledWins = Boolean(lexicalAnchor && pooledAnchorScore > effectiveRepScore);
    const representative = pooledWins ? lexicalAnchor : baselineRepresentative;
    const score = pooledWins ? pooledAnchorScore : effectiveRepScore;
    const representativeReason = pooledWins
        ? "pooled-anchor"
        : representative.kind === "file"
            ? "baseline-residual"
            : "baseline-symbol";
    const queue = [
        representative,
        ...ordered.filter((candidate) => candidate.id !== representative.id),
    ];
    return {
        file,
        representative,
        representativeReason,
        lexicalAnchor,
        queue,
        ...cov,
        score,
    };
}
export function rankFilesBounded(candidates, queryWeights) {
    const groups = groupRankableCandidatesByFile(candidates);
    const ranked = [];
    for (const [file, members] of groups) {
        ranked.push(scoreBoundedFileGroup(file, members, queryWeights));
    }
    ranked.sort((a, b) => {
        const diff = b.score - a.score;
        if (Math.abs(diff) > TIE_EPSILON)
            return diff;
        const depOrder = Number(Boolean(a.representative?.dependency)) - Number(Boolean(b.representative?.dependency));
        if (depOrder !== 0)
            return depOrder;
        return diff || baselineOrder(a.representative, b.representative) || a.file.localeCompare(b.file);
    });
    return ranked;
}
