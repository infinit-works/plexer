/**
 * Living execution queue (`next` vs `backlog`), cluster management (`create`, `add`, `remove`,
 * `move`, `update --depends-on`, `delete`, `list`, `show`), reordering, `plan reset`,
 * resolve/skip/reopen with scan-gate protection, attested `suppress`, and 4-stage triage.
 */
import { createHash } from "node:crypto";
import { ATTEST_RESOLVE_EXAMPLE, ATTEST_WONTFIX_EXAMPLE, TRIAGE_STAGES } from "./constants.js";
import { detectReviewCoverage } from "./review.js";
import { buildAutoClusters } from "./scoring.js";
import { emptyLivingPlan, wildcardToRegExp } from "./state.js";

const TIER_ORDER = { T1: 1, T2: 2, T3: 3, T4: 4 };
const SEVERITY_ORDER = { critical: 1, high: 2, medium: 3, low: 4 };

/**
 * Validate an attestation string for `suppress` or `plan skip --permanent`.
 * Requires `"not gaming"` and either `"reviewed"` or `"i have actually"`.
 */
export function validateAttestation(attestation) {
    if (!attestation || typeof attestation !== "string") return false;
    const lower = attestation.toLowerCase();
    const hasNotGaming = lower.includes("not gaming");
    const hasReviewed = lower.includes("reviewed") || lower.includes("i have actually");
    return hasNotGaming && hasReviewed;
}

export function compareIssuesByPriority(a, b, customOrderIndex = new Map()) {
    const idxA = customOrderIndex.has(a.id) ? customOrderIndex.get(a.id) : 999999;
    const idxB = customOrderIndex.has(b.id) ? customOrderIndex.get(b.id) : 999999;
    if (idxA !== idxB) return idxA - idxB;

    const tA = TIER_ORDER[a.tier] || 3;
    const tB = TIER_ORDER[b.tier] || 3;
    if (tA !== tB) return tA - tB;

    const sA = SEVERITY_ORDER[a.severity] || 3;
    const sB = SEVERITY_ORDER[b.severity] || 3;
    if (sA !== sB) return sA - sB;

    return String(a.id).localeCompare(String(b.id));
}

/**
 * Build the prioritized execution queue for `plexer health next` (or `backlog`).
 */
export function buildExecutionQueue(state, plan, opts = {}) {
    const isBacklog = Boolean(opts.backlog);
    const customOrderIndex = new Map();
    (plan?.queue_order || []).forEach((id, idx) => customOrderIndex.set(id, idx));

    const allIssues = Object.values(state.issues || {});
    let openIssues = allIssues
        .filter((i) => i.status === "open" && !i.suppressed)
        .sort((a, b) => compareIssuesByPriority(a, b, customOrderIndex));

    const manualClusters = plan?.clusters || {};
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...manualClusters };

    // Filter out issues belonging to clusters whose `depends_on` clusters still have open issues (unless in backlog mode)
    if (!isBacklog) {
        const blockedIssueIds = new Set();
        for (const c of Object.values(allClusters)) {
            const deps = Array.isArray(c.depends_on) ? c.depends_on : [];
            const hasUnresolvedDep = deps.some((depName) => {
                const depCluster = allClusters[depName];
                if (!depCluster) return false;
                return (depCluster.issue_ids || []).some(
                    (id) => state.issues?.[id]?.status === "open" && !state.issues?.[id]?.suppressed,
                );
            });
            if (hasUnresolvedDep) {
                for (const id of c.issue_ids || []) blockedIssueIds.add(id);
            }
        }
        if (blockedIssueIds.size > 0) {
            const unblocked = openIssues.filter((i) => !blockedIssueIds.has(i.id));
            if (unblocked.length > 0) {
                openIssues = unblocked;
            }
        }
    }

    const focusCluster = opts.cluster || (!isBacklog ? plan?.focus_cluster : null);
    if (focusCluster && allClusters[focusCluster]) {
        const memberSet = new Set(allClusters[focusCluster].issue_ids || []);
        openIssues = openIssues.filter((i) => memberSet.has(i.id));
    }

    const items = [];
    for (const iss of openIssues) {
        const resolveCmd = `plexer health resolve "${iss.id}" --note "<what you fixed>" --confirm`;
        const skipCmd = `plexer health plan skip --permanent "${iss.id}" --note "<why intentional>" --attest "${ATTEST_WONTFIX_EXAMPLE}"`;
        items.push({
            ...iss,
            resolve_command: resolveCmd,
            skip_command: skipCmd,
            attest_example: ATTEST_RESOLVE_EXAMPLE,
        });
    }

    // Surface subjective review step when mechanical queue is clear and review is unassessed or stale
    const workflowSteps = [];
    const cov = detectReviewCoverage(state, opts.totalProdFiles || 1);
    if (!isBacklog && items.length === 0 && cov.stale && state.scan_count > 0) {
        workflowSteps.push({
            type: "workflow_review",
            id: `workflow::review::${cov.status}`,
            summary:
                cov.reason ||
                "Run blind subjective review across the 20 architecture & elegance dimensions.",
            primary_command: "plexer health review --prepare",
        });
    }

    // Surface triage step when triage was previously completed and is now stale
    if (!isBacklog && plan?.triage?.completed && isTriageStale(plan, state)) {
        workflowSteps.push({
            type: "workflow_triage",
            id: "workflow::triage::stale",
            summary:
                "Living plan triage is stale (new review findings or >10% mechanical defect growth) — re-triage recommended.",
            primary_command:
                'plexer health plan triage --stage strategize --report "<updated strategy>"',
        });
    }

    const limit = Number(opts.count) > 0 ? Number(opts.count) : isBacklog ? 20 : 5;
    return {
        total_open: items.length,
        focus_cluster: focusCluster || null,
        clusters: Object.values(allClusters).map((c) => ({
            name: c.name,
            auto: Boolean(c.auto),
            depends_on: c.depends_on || [],
            open_count: (c.issue_ids || []).filter(
                (id) => state.issues?.[id]?.status === "open" && !state.issues?.[id]?.suppressed,
            ).length,
            total_count: (c.issue_ids || []).length,
        })),
        workflow_steps: workflowSteps,
        items: items.slice(0, limit),
        all_items: items,
    };
}

/**
 * Match issue IDs in `state.issues` by exact ID, substring, or wildcard pattern.
 */
export function matchIssueIds(state, patterns, allowedStatuses = null) {
    const patList = Array.isArray(patterns) ? patterns : [patterns];
    const matched = new Set();
    const allIds = Object.keys(state.issues || {});

    for (const rawPat of patList) {
        if (!rawPat) continue;
        const pat = String(rawPat).trim();
        if (state.issues[pat]) {
            const st = state.issues[pat].status;
            if (!allowedStatuses || allowedStatuses.has(st)) matched.add(pat);
            continue;
        }
        const re = wildcardToRegExp(pat.includes("*") ? pat : `*${pat}*`);
        for (const id of allIds) {
            const iss = state.issues[id];
            if (allowedStatuses && !allowedStatuses.has(iss.status)) continue;
            if (re.test(id) || re.test(iss.file || "") || re.test(iss.identifier || "")) {
                matched.add(id);
            }
        }
    }
    return [...matched];
}

/**
 * Resolve one or more issues (`plexer health resolve` / `plexer health plan resolve`),
 * enforcing scan-gate protection when `resolves_since_last_scan >= 10` unless `--force` is passed.
 */
export function resolveIssues(state, plan, patterns, opts = {}) {
    let matchedIds = matchIssueIds(state, patterns, new Set(["open", "deferred"]));
    if (matchedIds.length === 0) {
        matchedIds = matchIssueIds(state, patterns, new Set(["fixed"]));
    }
    if (matchedIds.length === 0) {
        return {
            status: "not_found",
            resolved_ids: [],
            message: `No open issues matched pattern: ${Array.isArray(patterns) ? patterns.join(", ") : patterns}`,
        };
    }

    const resolvesSinceScan = Number(plan.resolves_since_last_scan || 0);
    if (resolvesSinceScan >= 10 && !opts.force && !plan.scan_gate_skipped) {
        return {
            status: "scan_gate_blocked",
            resolved_ids: [],
            message:
                `Scan gate blocked: ${resolvesSinceScan} issues resolved since scan #${state.scan_count}. ` +
                "Run `plexer health scan` to verify your fixes and catch cascading effects before resolving more items.",
        };
    }

    const note = opts.note || "Fixed in code";
    const attestation = opts.attest || (opts.confirm ? ATTEST_RESOLVE_EXAMPLE : null);

    for (const id of matchedIds) {
        const iss = state.issues[id];
        iss.status = "fixed";
        iss.verified = false;
        iss.note = note;
        iss.attestation = attestation;
        iss.resolved_at = new Date().toISOString();
    }

    plan.resolves_since_last_scan = resolvesSinceScan + matchedIds.length;
    plan.scan_count_at_last_resolve = state.scan_count;
    const uncomm = new Set(plan.uncommitted_resolved || []);
    for (const id of matchedIds) uncomm.add(id);
    plan.uncommitted_resolved = [...uncomm];

    plan.log = [
        ...(plan.log || []),
        {
            action: "resolve",
            issue_ids: matchedIds,
            note,
            at: new Date().toISOString(),
        },
    ];

    return {
        status: "resolved",
        resolved_ids: matchedIds,
        suggested_commit: `git commit -m "chore(health): resolve ${matchedIds.length} finding(s) (${matchedIds[0].split("::")[0]})"`,
    };
}

/**
 * Defer (`deferred`) or permanently skip (`wontfix`) issues (`plexer health plan skip`).
 * When `opts.strictAttest` is true on `permanent`, validates that `--attest` contains `"reviewed"` and `"not gaming"`.
 */
export function skipIssues(state, plan, patterns, opts = {}) {
    if (opts.permanent && opts.attest !== undefined && !validateAttestation(opts.attest)) {
        return {
            status: "attestation_invalid",
            skipped_ids: [],
            message: `Permanent skip (--permanent) attestation must include "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`,
        };
    }

    let matchedIds = matchIssueIds(state, patterns, new Set(["open", "deferred"]));
    if (matchedIds.length === 0) {
        matchedIds = matchIssueIds(state, patterns, new Set(["fixed"]));
    }
    if (matchedIds.length === 0) {
        return {
            status: "not_found",
            skipped_ids: [],
            message: `No open issues matched pattern: ${Array.isArray(patterns) ? patterns.join(", ") : patterns}`,
        };
    }

    const newStatus = opts.permanent ? "wontfix" : "deferred";
    const note = opts.note || (opts.permanent ? "Intentional pattern" : "Deferred for later");
    const attestation = opts.attest || (opts.permanent ? ATTEST_WONTFIX_EXAMPLE : null);

    for (const id of matchedIds) {
        const iss = state.issues[id];
        iss.status = newStatus;
        iss.note = note;
        iss.attestation = attestation;
        iss.skipped_at = new Date().toISOString();
    }

    plan.log = [
        ...(plan.log || []),
        {
            action: newStatus,
            issue_ids: matchedIds,
            note,
            at: new Date().toISOString(),
        },
    ];

    return {
        status: newStatus,
        skipped_ids: matchedIds,
    };
}

/**
 * Permanently suppress issues matching a pattern with mandatory attestation (`plexer health suppress <pattern> --attest "..."`).
 */
export function suppressIssues(state, config, plan, pattern, opts = {}) {
    const attestation = opts.attest;
    if (!validateAttestation(attestation)) {
        return {
            status: "attestation_invalid",
            suppressed_ids: [],
            message: `Suppress requires a valid --attest string containing "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`,
        };
    }

    const pat = String(pattern || "").trim();
    if (!pat) {
        return {
            status: "error",
            suppressed_ids: [],
            message: "Suppress requires a non-empty pattern.",
        };
    }

    const matchedIds = matchIssueIds(state, [pat]);
    const fingerprints = [];
    const nowIso = new Date().toISOString();

    for (const id of matchedIds) {
        const iss = state.issues[id];
        const fp = createHash("sha1")
            .update(`${iss.detector}::${iss.identifier || ""}::${iss.summary || ""}`)
            .digest("hex")
            .slice(0, 12);
        fingerprints.push(fp);
        iss.status = "wontfix";
        iss.suppressed = true;
        iss.attestation = attestation;
        iss.note = opts.note || "Permanently suppressed via plexer health suppress";
        iss.suppressed_at = nowIso;
    }

    if (!config.suppressions) config.suppressions = {};
    config.suppressions[pat] = {
        pattern: pat,
        fingerprints,
        note: opts.note || "Path-independent suppression fingerprint",
        attestation,
        added_at: nowIso,
    };
    config.needs_rescan = true;

    if (!Array.isArray(state.attestation_log)) state.attestation_log = [];
    state.attestation_log.push({
        timestamp: nowIso,
        command: "suppress",
        pattern: pat,
        attestation,
        affected: matchedIds.length,
    });

    if (plan) {
        plan.log = [
            ...(plan.log || []),
            {
                action: "suppress",
                pattern: pat,
                issue_ids: matchedIds,
                at: nowIso,
            },
        ];
    }

    return {
        status: "suppressed",
        pattern: pat,
        suppressed_ids: matchedIds,
        fingerprints,
    };
}

/**
 * Reopen fixed/wontfix/deferred issues (`plexer health plan reopen`).
 */
export function reopenIssues(state, plan, patterns) {
    const matchedIds = matchIssueIds(
        state,
        patterns,
        new Set(["fixed", "wontfix", "deferred", "false_positive", "auto_resolved"]),
    );
    for (const id of matchedIds) {
        state.issues[id].status = "open";
        state.issues[id].verified = false;
        state.issues[id].suppressed = false;
    }
    plan.log = [
        ...(plan.log || []),
        {
            action: "reopen",
            issue_ids: matchedIds,
            at: new Date().toISOString(),
        },
    ];
    return { reopened_ids: matchedIds };
}

function parseDependsOnList(dependsOn, fallback = []) {
    if (!dependsOn) return fallback;
    return (Array.isArray(dependsOn) ? dependsOn : String(dependsOn).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Manage living plan clusters (`create`, `add`, `remove`, `move`, `update`, `delete`, `list`, `show`).
 */
export function managePlanCluster(state, plan, subAction = "list", clusterName = null, patterns = [], opts = {}) {
    if (!plan.clusters) plan.clusters = {};
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...plan.clusters };
    const sub = String(subAction || "list").toLowerCase();

    if (sub === "list") {
        return {
            sub_action: "list",
            clusters: Object.values(allClusters).map((c) => ({
                name: c.name,
                auto: Boolean(c.auto),
                depends_on: c.depends_on || [],
                issue_ids: c.issue_ids || [],
                open_count: (c.issue_ids || []).filter((id) => state.issues?.[id]?.status === "open").length,
            })),
        };
    }

    if (sub === "show") {
        const target = allClusters[clusterName];
        if (!target) {
            return { sub_action: "show", status: "not_found", message: `Cluster "${clusterName}" not found` };
        }
        return {
            sub_action: "show",
            cluster: { ...target, issues: (target.issue_ids || []).map((id) => state.issues?.[id]).filter(Boolean) },
        };
    }

    if (sub === "delete" && clusterName) {
        delete plan.clusters[clusterName];
        if (plan.focus_cluster === clusterName) plan.focus_cluster = null;
        return { sub_action: "delete", deleted: clusterName, clusters: plan.clusters };
    }

    if (sub === "update" && clusterName) {
        const existing = plan.clusters[clusterName] || allClusters[clusterName];
        if (!existing) {
            return { sub_action: "update", status: "not_found", message: `Cluster "${clusterName}" not found` };
        }
        plan.clusters[clusterName] = {
            ...existing,
            name: clusterName,
            auto: false,
            depends_on: parseDependsOnList(opts.dependsOn, existing.depends_on || []),
        };
        return { sub_action: "update", cluster: plan.clusters[clusterName], clusters: plan.clusters };
    }

    if (sub === "move") {
        const toCluster = opts.to || clusterName;
        const matched = matchIssueIds(state, patterns);
        for (const c of Object.values(plan.clusters)) {
            c.issue_ids = (c.issue_ids || []).filter((id) => !matched.includes(id));
        }
        const existing = plan.clusters[toCluster] || { name: toCluster, auto: false, issue_ids: [], depends_on: [] };
        existing.issue_ids = [...new Set([...(existing.issue_ids || []), ...matched])];
        plan.clusters[toCluster] = existing;
        return { sub_action: "move", cluster: existing, moved_ids: matched, clusters: plan.clusters };
    }

    if (sub === "add" && clusterName) {
        const matched = matchIssueIds(state, patterns);
        const existing = plan.clusters[clusterName] || { name: clusterName, auto: false, issue_ids: [], depends_on: [] };
        existing.issue_ids = [...new Set([...(existing.issue_ids || []), ...matched])];
        plan.clusters[clusterName] = existing;
        return { sub_action: "add", cluster: existing, clusters: plan.clusters };
    }

    if (sub === "remove" && clusterName) {
        const matched = new Set(matchIssueIds(state, patterns));
        const existing = plan.clusters[clusterName];
        if (existing) existing.issue_ids = (existing.issue_ids || []).filter((id) => !matched.has(id));
        return { sub_action: "remove", cluster: existing || null, clusters: plan.clusters };
    }

    if (clusterName) {
        plan.clusters[clusterName] = {
            name: clusterName,
            auto: false,
            issue_ids: matchIssueIds(state, patterns),
            depends_on: parseDependsOnList(opts.dependsOn, []),
        };
    }
    return { sub_action: "create", clusters: plan.clusters };
}

/**
 * Reset the living plan (`plexer health plan reset`) while keeping `state.json`.
 */
export function resetLivingPlan(state, plan) {
    const fresh = emptyLivingPlan();
    fresh.scan_count_at_plan_start = state.scan_count || 0;
    for (const k of Object.keys(plan)) delete plan[k];
    Object.assign(plan, fresh);
    return { status: "reset", plan };
}

/**
 * Reorder items or clusters in `plan.queue_order` (`top`, `bottom`, `before`, `after`).
 */
export function reorderPlanQueue(state, plan, patterns, position = "top", targetPattern = null) {
    const currentOrder =
        plan.queue_order && plan.queue_order.length > 0
            ? [...plan.queue_order]
            : Object.values(state.issues || {})
                  .filter((i) => i.status === "open")
                  .sort((a, b) => compareIssuesByPriority(a, b))
                  .map((i) => i.id);

    const movingIds = [];
    const patList = Array.isArray(patterns) ? patterns : [patterns];
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...(plan.clusters || {}) };

    for (const p of patList) {
        if (allClusters[p]) {
            movingIds.push(...(allClusters[p].issue_ids || []));
        } else {
            movingIds.push(...matchIssueIds(state, [p]));
        }
    }

    const movingSet = new Set(movingIds);
    const rest = currentOrder.filter((id) => !movingSet.has(id));

    if (position === "bottom") {
        plan.queue_order = [...rest, ...movingSet];
    } else if ((position === "before" || position === "after") && targetPattern) {
        const targetIds = matchIssueIds(state, [targetPattern]);
        const anchor = targetIds[0];
        const idx = rest.indexOf(anchor);
        if (idx === -1) {
            plan.queue_order = [...movingSet, ...rest];
        } else {
            const insertAt = position === "after" ? idx + 1 : idx;
            rest.splice(insertAt, 0, ...movingSet);
            plan.queue_order = rest;
        }
    } else {
        plan.queue_order = [...movingSet, ...rest];
    }

    return {
        moved_count: movingSet.size,
        position,
        queue_order: plan.queue_order,
    };
}

/**
 * Check whether a completed triage in `plan` has become stale due to new open review findings
 * or >10% growth in open mechanical defects (`is_triage_stale` in upstream desloppify).
 */
export function isTriageStale(plan, state, mechanicalGrowthThreshold = 0.1) {
    if (!plan?.triage?.completed) return false;
    const allIssues = Object.values(state?.issues || {});
    const openReviewIds = allIssues
        .filter((i) => i.status === "open" && !i.suppressed && i.detector === "review")
        .map((i) => i.id);
    const knownReviewIds = new Set(plan.triage.triaged_review_ids || []);
    if (openReviewIds.some((id) => !knownReviewIds.has(id))) {
        return true;
    }

    const lastMech = Number(plan.triage.last_mechanical_count || 0);
    const currentMech = allIssues.filter(
        (i) => i.status === "open" && !i.suppressed && i.detector !== "review",
    ).length;
    if (lastMech > 0) {
        const growth = (currentMech - lastMech) / lastMech;
        if (growth > mechanicalGrowthThreshold) return true;
    } else if (currentMech > 0 && knownReviewIds.size === 0) {
        return true;
    }
    return false;
}

/**
 * Update a triage stage (`strategize`, `observe`, `reflect`, `organize`, `enrich`,
 * `sense-check`, `commit`, or `complete`).
 */
export function updateTriageStage(plan, opts = {}, state = null) {
    if (!plan.triage) {
        plan.triage = emptyLivingPlan().triage;
    }
    if (!plan.triage.stages) {
        plan.triage.stages = {};
    }

    const snapshotStateCounts = () => {
        if (!state?.issues) return;
        const allIssues = Object.values(state.issues);
        plan.triage.triaged_review_ids = allIssues
            .filter((i) => i.status === "open" && !i.suppressed && i.detector === "review")
            .map((i) => i.id);
        plan.triage.last_mechanical_count = allIssues.filter(
            (i) => i.status === "open" && !i.suppressed && i.detector !== "review",
        ).length;
    };

    const rawStage = opts.stage ? String(opts.stage).toLowerCase() : null;
    if (opts.complete || rawStage === "complete" || rawStage === "commit") {
        const nowIso = new Date().toISOString();
        if (rawStage === "commit") {
            plan.triage.stages.commit = {
                report: opts.report || opts.strategy || "Committed triage plan",
                updated_at: nowIso,
            };
        }
        plan.triage.completed = true;
        plan.triage.strategy = opts.strategy || opts.report || "Completed triage strategy";
        plan.triage.completed_at = nowIso;
        snapshotStateCounts();
        return {
            stage: rawStage === "commit" ? "commit" : "complete",
            triage: plan.triage,
            stale: false,
        };
    }

    const stage = rawStage || "observe";
    if (!TRIAGE_STAGES.includes(stage)) {
        throw new Error(
            `Invalid triage stage "${stage}" — must be one of: ${TRIAGE_STAGES.join(", ")}`,
        );
    }
    plan.triage.stages[stage] = {
        report: opts.report || "Completed stage",
        updated_at: new Date().toISOString(),
    };
    return {
        stage,
        triage: plan.triage,
        stale: state ? isTriageStale(plan, state) : false,
    };
}

/**
 * Immediately prune issues matching an exclusion path/pattern from `state.issues`
 * and purge their IDs from `plan` (`queue_order`, `uncommitted_resolved`, `clusters`).
 */
export function pruneExcludedIssues(state, plan, rawPattern) {
    const pat = String(rawPattern || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
    if (!pat) return { removed_ids: [], purged_plan_count: 0 };

    const re = pat.includes("*") ? wildcardToRegExp(pat) : null;
    const matchesFile = (filePath) => {
        const f = String(filePath || "").replace(/\\/g, "/");
        if (!f) return false;
        if (re) return re.test(f);
        return f === pat || f.startsWith(`${pat}/`) || f.includes(`/${pat}/`) || f.endsWith(`/${pat}`);
    };

    const removedIds = [];
    for (const [id, iss] of Object.entries(state.issues || {})) {
        if (matchesFile(iss.file)) {
            removedIds.push(id);
            delete state.issues[id];
        }
    }

    let purgedPlanCount = 0;
    if (removedIds.length > 0 && plan) {
        const rmSet = new Set(removedIds);
        if (Array.isArray(plan.queue_order)) {
            const before = plan.queue_order.length;
            plan.queue_order = plan.queue_order.filter((id) => !rmSet.has(id));
            purgedPlanCount += before - plan.queue_order.length;
        }
        if (Array.isArray(plan.uncommitted_resolved)) {
            plan.uncommitted_resolved = plan.uncommitted_resolved.filter((id) => !rmSet.has(id));
        }
        if (plan.clusters && typeof plan.clusters === "object") {
            for (const c of Object.values(plan.clusters)) {
                if (Array.isArray(c.issue_ids)) {
                    const b = c.issue_ids.length;
                    c.issue_ids = c.issue_ids.filter((id) => !rmSet.has(id));
                    purgedPlanCount += b - c.issue_ids.length;
                }
            }
        }
    }

    return {
        removed_ids: removedIds,
        purged_plan_count: purgedPlanCount,
    };
}
