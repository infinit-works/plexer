/**
 * Narrative engine (`computeHeadline`, `computeReminders`, `computeWorkLanes`, `computeFixerLeverage`).
 */
import { dirname } from "node:path";
import { DEFAULT_TARGET_STRICT_SCORE, RESOLVE_SCAN_GATE_LIMIT } from "./constants.js";
import { isTriageStale } from "./queue.js";
import { detectReviewCoverage } from "./review.js";
import { UnionFind } from "./zones.js";

const REMINDER_DECAY_THRESHOLD = 3;

function extractIssueTouchedFiles(iss) {
    const files = new Set();
    const addFile = (f) => {
        if (f && typeof f === "string" && f !== "repo") {
            files.add(f.replace(/\\/g, "/"));
        }
    };
    addFile(iss.file);
    addFile(iss.target_file);
    addFile(iss.partner_file);
    for (const rf of iss.related_files || []) addFile(rf);
    for (const m of iss.members || []) addFile(m?.file);
    for (const v of iss.variants || []) addFile(v?.file);
    for (const l of iss.locations || []) addFile(l?.file);
    for (const c of iss.cycle || []) addFile(c);
    return [...files];
}

/**
 * Compute mechanical autofixer leverage over open findings.
 */
export function computeFixerLeverage(openIssues = []) {
    const byFixer = new Map();
    let autoFixableCount = 0;
    for (const iss of openIssues) {
        const fixer = iss.fixer || (iss.tier === "T1" && iss.detector === "debug_logs" ? "debug-logs" : null);
        if (!fixer) continue;
        autoFixableCount += 1;
        byFixer.set(fixer, (byFixer.get(fixer) || 0) + 1);
    }
    const totalOpen = openIssues.length;
    const ratio = totalOpen > 0 ? Number((autoFixableCount / totalOpen).toFixed(2)) : 0;
    const fixers = [...byFixer.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([fixer, count]) => ({
            fixer,
            count,
            command: `plexer health autofix ${fixer} --dry-run`,
        }));
    return {
        auto_fixable_count: autoFixableCount,
        total_open: totalOpen,
        ratio,
        fixers,
        recommendation:
            autoFixableCount > 0
                ? `Run \`plexer health autofix all --dry-run\` to preview ${autoFixableCount} mechanical fix(es) before manual edits.`
                : null,
    };
}

/**
 * Partition open findings into non-overlapping parallel subagent workstream lanes
 * using `UnionFind` over touched files + 1-hop undirected import/call adjacency.
 */
export function computeWorkLanes(openIssues = [], fileAdjacency = new Map(), opts = {}) {
    const active = openIssues.filter((i) => i.status === "open" && !i.suppressed);
    const fixerLeverage = computeFixerLeverage(active);
    if (active.length === 0) {
        return {
            can_parallelize: false,
            lane_count: 0,
            independent_lanes: [],
            fixer_leverage: fixerLeverage,
            strategy_hint: "Execution queue is empty.",
        };
    }

    const uf = new UnionFind();
    const fileToFirstIssueIdx = new Map();
    const issueFiles = active.map((iss, idx) => {
        uf.makeSet(idx);
        const touched = extractIssueTouchedFiles(iss);
        for (const f of touched) {
            if (fileToFirstIssueIdx.has(f)) {
                uf.union(idx, fileToFirstIssueIdx.get(f));
            } else {
                fileToFirstIssueIdx.set(f, idx);
            }
        }
        return touched;
    });

    // Union issues whose touched files share a 1-hop edge in `fileAdjacency`
    for (let i = 0; i < active.length; i++) {
        for (const f of issueFiles[i]) {
            const neighbors = fileAdjacency?.get(f);
            if (!neighbors) continue;
            for (const nb of neighbors) {
                const peerIdx = fileToFirstIssueIdx.get(nb);
                if (peerIdx !== undefined && peerIdx !== i) {
                    uf.union(i, peerIdx);
                }
            }
        }
    }

    const rawComponents = uf.components();
    const maxLanes = Math.max(1, Number(opts.maxLanes) || 6);

    const lanes = rawComponents.map((indices) => {
        const laneIssues = indices.map((i) => active[i]);
        const files = [...new Set(indices.flatMap((i) => issueFiles[i]))].sort();
        const dirs = [...new Set(files.map((f) => dirname(f)))].sort();
        const detectors = [...new Set(laneIssues.map((iss) => iss.detector))].sort();
        const totalImpact = laneIssues.reduce(
            (sum, iss) => sum + Number(iss.score_impact ?? iss.score_impact_detail?.deltaStrict ?? 0),
            0,
        );
        const primaryDir = dirs[0] && dirs[0] !== "." ? dirs[0] : files[0] || "repo";
        return {
            label: `${primaryDir} (${detectors.slice(0, 2).join(", ")})`,
            files,
            directories: dirs,
            detectors,
            issue_count: laneIssues.length,
            issue_ids: laneIssues.map((iss) => iss.id),
            score_impact: Number(totalImpact.toFixed(1)),
            top_command: `plexer health show "${laneIssues[0].id}" --code`,
            resolve_command: `plexer health resolve "${laneIssues[0].id}" --note "<fix summary>" --confirm`,
            subagent_hint: `Dispatch a scoped worker subagent on ${files.slice(0, 3).join(", ")} (${laneIssues.length} finding(s), +${totalImpact.toFixed(1)}% strict)`,
        };
    });

    lanes.sort((a, b) => b.score_impact - a.score_impact || b.issue_count - a.issue_count);
    const boundedLanes = lanes.slice(0, maxLanes).map((lane, idx) => ({
        lane_id: `lane_${idx + 1}`,
        ...lane,
    }));

    return {
        can_parallelize: boundedLanes.length >= 2,
        lane_count: boundedLanes.length,
        total_components: lanes.length,
        independent_lanes: boundedLanes,
        fixer_leverage: fixerLeverage,
        strategy_hint:
            boundedLanes.length >= 2
                ? `${boundedLanes.length} graph-disjoint workstream lanes available — safe to dispatch up to ${Math.min(4, boundedLanes.length)} parallel worker subagents with zero file or 1-hop import overlap.`
                : "All open findings share a connected file/import subgraph — work sequentially in a single agent.",
    };
}

/**
 * Compute a concise one-line status headline based on current state and scores.
 */
export function computeHeadline(state, scores, plan, config) {
    const allIssues = Object.values(state.issues || {});
    const openIssues = allIssues.filter((i) => i.status === "open" && !i.suppressed);
    const secCount = openIssues.filter((i) => i.dimension === "security").length;
    const target = Number(config?.target_strict_score ?? DEFAULT_TARGET_STRICT_SCORE);

    const securityPrefix =
        secCount > 0
            ? `[SECURITY: ${secCount} open boundary/cycle/security issue${secCount === 1 ? "" : "s"}] `
            : "";

    let mainText = "";
    if (scores.strict >= target && openIssues.length === 0) {
        mainText = `Strict score ${scores.strict}% meets target (${target}%). Queue is clear!`;
    } else if (!scores.has_subjective && openIssues.length <= 5) {
        mainText = `Mechanical score is ${scores.objective}%, but subjective dimensions are unassessed — run \`plexer health review --prepare\`.`;
    } else if (plan?.resolves_since_last_scan >= 3) {
        mainText = `${plan.resolves_since_last_scan} issues resolved since last scan — run \`plexer health scan\` to verify and unlock the scan gate.`;
    } else if (openIssues.length > 0) {
        const t1Count = openIssues.filter((i) => i.tier === "T1").length;
        if (t1Count > 0) {
            mainText = `${openIssues.length} open issues (${t1Count} T1 auto-fixable). Run \`plexer health next\` to execute the top item.`;
        } else {
            mainText = `${openIssues.length} open issues (strict ${scores.strict}% / target ${target}%). Run \`plexer health next\` to work the queue.`;
        }
    } else {
        mainText = `Strict score ${scores.strict}% (target ${target}%).`;
    }

    return `${securityPrefix}${mainText}`.trim();
}

/**
 * Compute context-aware priority-ranked reminders with `state.reminder_history` decay
 * so agents get timely nudges without repetitive noise.
 */
function collectHighPriorityReminders(state, scores, plan, config, command, suspectHeldCount, candidates) {
    if (suspectHeldCount > 0) {
        candidates.push({
            type: "suspect_held",
            priority: 1,
            severity: "high",
            no_decay: true,
            message: `${suspectHeldCount} finding(s) are held by the suspect-disappearance guard (detector dropped to 0). Verify and run \`plexer health scan --force-resolve\` if intentional.`,
            command: "plexer health scan --force-resolve",
        });
    }

    const resolvesSinceScan = Number(plan?.resolves_since_last_scan || 0);
    if (
        command === "resolve" ||
        command === "autofix" ||
        command === "suppress" ||
        config?.needs_rescan ||
        resolvesSinceScan >= 3
    ) {
        const remaining = Math.max(0, RESOLVE_SCAN_GATE_LIMIT - resolvesSinceScan);
        candidates.push({
            type: "rescan_needed",
            priority: 1,
            severity: "high",
            no_decay: true,
            message:
                resolvesSinceScan >= 3
                    ? `Rescan to verify fixes (${resolvesSinceScan}/${RESOLVE_SCAN_GATE_LIMIT} resolves used before scan gate blocks; ${remaining} remaining).`
                    : "Rescan to verify fixes — cascading effects may resolve or surface issues.",
            command: "plexer health scan",
        });
    }

    if ((scores?.unverified_fixed_count || 0) > 0 && command !== "resolve" && command !== "scan") {
        candidates.push({
            type: "unverified_fixes",
            priority: 1,
            severity: "high",
            no_decay: true,
            message: `${scores.unverified_fixed_count} mechanical fix(es) are unverified and still penalize strict/verified scores until confirmed by \`plexer health scan\`.`,
            command: "plexer health scan",
        });
    }

    const ignoredCount = Number(scores?.ignore_integrity?.ignored_count || state?.ignore_integrity?.ignored_count || 0);
    const suppressedPct = Number(scores?.ignore_integrity?.suppressed_pct || state?.ignore_integrity?.suppressed_pct || 0);
    if (ignoredCount >= 3 || suppressedPct >= 5) {
        candidates.push({
            type: "ignore_suppression_high",
            priority: 1,
            severity: "high",
            no_decay: true,
            message: `Inline/file ignore rules suppressed ${ignoredCount} finding(s) (${suppressedPct}% of checks). Audit suppressions instead of hiding defects.`,
            command: "plexer health show --status wontfix",
        });
    }
}

function collectMediumAndLowReminders(state, scores, plan, config, command, openIssues, totalProdFiles, candidates) {
    if (openIssues.some((i) => i.tier === "T1" && i.fixer) && command !== "autofix") {
        candidates.push({
            type: "dry_run_first",
            priority: 2,
            severity: "medium",
            message: "Auto-fixable T1 issues detected. Always preview with `--dry-run` before applying.",
            command: "plexer health autofix --dry-run",
        });
    }

    if (scores.wontfix_gap >= 3.0) {
        candidates.push({
            type: "wontfix_debt",
            priority: 2,
            severity: "medium",
            message: `Wontfix/false-positive debt is widening the lenient↔strict gap (${scores.wontfix_gap}% across ${scores.wontfix_count + (scores.false_positive_count || 0)} items). Challenge past skips to raise strict score.`,
            command: "plexer health show --status wontfix",
        });
    }

    const revCov = detectReviewCoverage(state, totalProdFiles);
    if (!scores.has_subjective) {
        candidates.push({
            type: "subjective_review_needed",
            priority: 2,
            severity: "medium",
            message: "Subjective review dimensions (75% of overall pool) have not been scored yet.",
            command: "plexer health review --prepare",
        });
    } else if (revCov.stale && revCov.reason) {
        candidates.push({
            type: "subjective_review_stale",
            priority: 2,
            severity: "medium",
            message: revCov.reason,
            command: "plexer health review --prepare",
        });
    }

    if (plan?.triage?.completed && isTriageStale(plan, state)) {
        candidates.push({
            type: "triage_stale",
            priority: 2,
            severity: "medium",
            message: "Living triage plan is stale due to new findings — re-triage recommended.",
            command: 'plexer health plan triage --stage strategize --report "<updated strategy>"',
        });
    }

    if (
        config?.commit_tracking_enabled !== false &&
        Array.isArray(plan?.uncommitted_resolved) &&
        plan.uncommitted_resolved.length >= 3
    ) {
        candidates.push({
            type: "uncommitted_work",
            priority: 2,
            severity: "medium",
            message: `${plan.uncommitted_resolved.length} resolved findings are uncommitted. Commit your batch and run \`plexer health plan commit-log record\`.`,
            command: "plexer health plan commit-log",
        });
    }

    if ((state.scan_count || 0) <= 1 && command === "scan") {
        candidates.push({
            type: "zone_classification",
            priority: 3,
            severity: "low",
            message: "Verify file zone classifications (`production`, `test`, `vendor`, `generated`) so non-production files do not skew scores.",
            command: "plexer health zone show",
        });
    }

    const hist = Array.isArray(state.history) ? state.history.filter((h) => h.event === "scan") : [];
    if (hist.length >= 3 && openIssues.length > 0) {
        const last3 = hist.slice(-3);
        if (last3.every((h) => Number(h.strict) === Number(last3[0].strict))) {
            candidates.push({
                type: "stagnant_dimensions",
                priority: 3,
                severity: "low",
                message: `Strict score has plateaued at ${last3[0].strict}% across the last 3 scans. Inspect top score-drag dimensions with \`plexer health next --explain\`.`,
                command: "plexer health next --explain",
            });
        }
    }
}

/**
 * Compute context-aware priority-ranked reminders with `state.reminder_history` decay
 * so agents get timely nudges without repetitive noise.
 */
export function computeReminders(state, scores, plan, config = {}, command = "scan", totalProdFiles = 1, opts = {}) {
    const candidates = [];
    const allIssues = Object.values(state.issues || {});
    const openIssues = allIssues.filter((i) => i.status === "open" && !i.suppressed);
    const suspectHeldCount = allIssues.filter((i) => i.suspect_hold).length;

    collectHighPriorityReminders(state, scores, plan, config, command, suspectHeldCount, candidates);
    collectMediumAndLowReminders(state, scores, plan, config, command, openIssues, totalProdFiles, candidates);

    if (command === "next" || command === "scan") {
        const rawLaneCount = opts.laneCount ?? opts.lanes?.lane_count;
        const laneCount =
            rawLaneCount !== undefined
                ? Number(rawLaneCount)
                : openIssues.length >= 2
                  ? computeWorkLanes(openIssues, opts.fileAdjacency).lane_count
                  : 0;
        if (laneCount >= 2) {
            candidates.push({
                type: "parallel_lanes_available",
                priority: 2,
                severity: "medium",
                message: `${laneCount} graph-disjoint workstream lanes are available for parallel subagent execution.`,
                command: "plexer health next --lanes",
            });
        }
    }

    if (!state.reminder_history || typeof state.reminder_history !== "object") {
        state.reminder_history = {};
    }

    const shouldPersist =
        opts.persistReminders !== undefined
            ? Boolean(opts.persistReminders)
            : command !== "status" && command !== "backlog" && command !== "show";

    const reminders = [];
    candidates.sort((a, b) => (a.priority || 2) - (b.priority || 2));
    for (const r of candidates) {
        const prevCount = Number(state.reminder_history[r.type] || 0);
        if (!opts.noDecay && !r.no_decay && r.severity !== "high" && prevCount >= REMINDER_DECAY_THRESHOLD) {
            continue;
        }
        if (shouldPersist) {
            state.reminder_history[r.type] = prevCount + 1;
        }
        reminders.push(r);
    }

    const directives = config?.directives || {};
    const phaseMap = {
        scan: "scan",
        next: "execute",
        resolve: "execute",
        suppress: "execute",
        plan: "triage",
        review: "review",
    };
    const activePhase = phaseMap[command] || "workflow";
    if (directives[activePhase]) {
        reminders.unshift({
            type: `directive_${activePhase}`,
            priority: 0,
            severity: "high",
            message: `[Directive: ${activePhase}] ${directives[activePhase]}`,
            command: null,
        });
    }
    if (directives.workflow && activePhase !== "workflow") {
        reminders.unshift({
            type: "directive_workflow",
            priority: 0,
            severity: "high",
            message: `[Directive: workflow] ${directives.workflow}`,
            command: null,
        });
    }

    return reminders;
}
