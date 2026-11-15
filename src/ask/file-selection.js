/**
 * Project an existing ranking through file-first round-robin selection.
 *
 * The input MUST already be in baseline rank order. Map insertion order makes
 * the first pass exactly the baseline first-occurrence order of groups; later
 * passes expose additional spans only after every group has contributed its
 * leader. Concepts can participate without pretending to be source files by
 * receiving singleton group keys.
 *
 * Values are returned by identity and are never mutated.
 */
export function fileFirstRoundRobin(ranked, limit = Number.POSITIVE_INFINITY) {
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
    if (cap === 0)
        return [];
    const grouped = new Map();
    for (const candidate of ranked) {
        const queue = grouped.get(candidate.group);
        if (queue)
            queue.push(candidate.value);
        else
            grouped.set(candidate.group, [candidate.value]);
    }
    const queues = [...grouped.values()];
    const out = [];
    for (let depth = 0;; depth += 1) {
        let added = false;
        for (const queue of queues) {
            if (depth >= queue.length)
                continue;
            out.push(queue[depth]);
            added = true;
            if (out.length >= cap)
                return out;
        }
        if (!added)
            break;
    }
    return out;
}
function roundRobinUnscoredQueues(nonEmpty, cap) {
    const out = [];
    for (let depth = 0; out.length < cap; depth += 1) {
        let added = false;
        for (const queue of nonEmpty) {
            if (depth >= queue.length)
                continue;
            out.push(queue[depth]);
            added = true;
            if (out.length >= cap)
                break;
        }
        if (!added)
            break;
    }
    return out;
}

function pickBestSecondaryQueue(nonEmpty, cursors, nextLeaderIdx, topScore) {
    let bestSecIdx = -1;
    let bestSecEff = -1;
    const maxSecFiles = Math.min(3, nextLeaderIdx);
    for (let i = 0; i < maxSecFiles; i++) {
        const depth = cursors[i];
        if (depth < 1 || depth > 3 || depth >= nonEmpty[i].length)
            continue;
        const rawScore = nonEmpty[i][depth]?.score ?? 0;
        const discount = depth === 1 ? 0.88 : depth === 2 ? 0.78 : 0.70;
        const eff = rawScore * discount;
        if (eff >= topScore * 0.28 && eff > bestSecEff) {
            bestSecEff = eff;
            bestSecIdx = i;
        }
    }
    return { bestSecIdx, bestSecEff };
}

function drainQueueTailsByDepth(nonEmpty, cursors, out, cap) {
    for (let depth = 1; out.length < cap; depth += 1) {
        let added = false;
        for (let i = 0; i < nonEmpty.length && out.length < cap; i++) {
            if (depth >= nonEmpty[i].length)
                continue;
            if (cursors[i] === depth) {
                out.push(nonEmpty[i][cursors[i]++]);
                added = true;
            }
            else if (cursors[i] > depth) {
                added = true;
            }
        }
        if (!added)
            break;
    }
}

/** Project already-grouped queues directly. Unlike {@link fileFirstRoundRobin}
 * this does not flatten and rebuild a grouping map, so a file-aware ranker can
 * stop as soon as `limit` hits without materializing every tail span twice. */
export function roundRobinQueues(queues, limit = Number.POSITIVE_INFINITY) {
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
    if (cap === 0)
        return [];
    const nonEmpty = queues.filter((q) => q.length > 0);
    if (nonEmpty.length === 0)
        return [];
    const topScore = typeof nonEmpty[0][0]?.score === "number" ? nonEmpty[0][0].score : null;
    if (topScore === null || topScore <= 0)
        return roundRobinUnscoredQueues(nonEmpty, cap);

    const cursors = nonEmpty.map(() => 0);
    const out = [];
    let nextLeaderIdx = 0;
    while (out.length < cap && nextLeaderIdx < nonEmpty.length) {
        if (nextLeaderIdx < 1) {
            out.push(nonEmpty[nextLeaderIdx][cursors[nextLeaderIdx]++]);
            nextLeaderIdx++;
            continue;
        }
        const leaderScore = nonEmpty[nextLeaderIdx][0]?.score ?? 0;
        const { bestSecIdx, bestSecEff } = pickBestSecondaryQueue(nonEmpty, cursors, nextLeaderIdx, topScore);
        if (bestSecIdx >= 0 && bestSecEff >= leaderScore) {
            out.push(nonEmpty[bestSecIdx][cursors[bestSecIdx]++]);
        }
        else {
            out.push(nonEmpty[nextLeaderIdx][cursors[nextLeaderIdx]++]);
            nextLeaderIdx++;
        }
    }
    drainQueueTailsByDepth(nonEmpty, cursors, out, cap);
    return out;
}

