/**
 * Living execution queue (`next` vs `backlog`), cluster management (`create`, `add`, `remove`,
 * `move`, `update --depends-on`, `delete`, `list`, `show`), reordering, `plan reset`,
 * resolve/skip/reopen with scan-gate protection, attested `suppress`, and 4-stage triage.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parsePolicyLayerRule } from "../blast/layer-rules.js";
import { resolveSafeRepoFile } from "../util/span.js";
import {
    ATTEST_RESOLVE_EXAMPLE,
    ATTEST_WONTFIX_EXAMPLE,
    DETECTOR_CATEGORY,
    MECHANICAL_DIMENSIONS,
    RESOLVE_SCAN_GATE_LIMIT,
    TRIAGE_STAGES,
} from "./constants.js";
import { detectReviewCoverage } from "./review.js";
import {
    buildAutoClusters,
    computeScoreSnapshot,
    createFastScoreImpactEstimator,
} from "./scoring.js";
import { emptyLivingPlan, wildcardToRegExp } from "./state.js";

function resolveClusterRepoRoots(rootDir) {
    const absRoot = resolve(rootDir || process.cwd());
    let realRoot = absRoot;
    try {
        realRoot = realpathSync(absRoot);
    } catch {
        /* fallback */
    }
    return { absRoot, realRoot };
}

function readSafeClusterRepoInput(rawOrInline, rootDir, label, inlineHints = []) {
    const raw = String(rawOrInline || "");
    const trimmed = raw.trim();
    const isLikelyInline =
        raw.includes("\n") ||
        trimmed.startsWith("{") ||
        inlineHints.some((fn) => fn(trimmed));
    if (isLikelyInline) return raw;

    const { absRoot, realRoot } = resolveClusterRepoRoots(rootDir);
    const safe = resolveSafeRepoFile(absRoot, realRoot, raw, { noSymlinks: true });
    if (safe) return readFileSync(safe.realFile, "utf8");

    const looksLikeExternalOrFile =
        isAbsolute(raw) ||
        raw.includes("..") ||
        existsSync(raw) ||
        existsSync(resolve(absRoot, raw)) ||
        /[\\/]|\.(?:md|markdown|txt|json|ya?ml)$/i.test(trimmed);
    if (looksLikeExternalOrFile) {
        throw new Error(`${label} path must stay within repository root: ${raw}`);
    }
    return raw;
}

function writeSafeClusterRepoOutput(rawOutputPath, content, rootDir) {
    if (!rawOutputPath || typeof rawOutputPath !== "string" || rawOutputPath.includes("\0")) {
        throw new Error("Cluster export --output path must be a valid repo-relative path.");
    }
    const { absRoot, realRoot } = resolveClusterRepoRoots(rootDir);
    const absOut = resolve(absRoot, rawOutputPath);
    const rel = relative(absRoot, absOut);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Cluster export --output path must stay within repository root: ${rawOutputPath}`);
    }
    if (existsSync(absOut)) {
        const safe = resolveSafeRepoFile(absRoot, realRoot, rawOutputPath, { noSymlinks: true });
        if (!safe) {
            throw new Error(`Cluster export --output path must stay within repository root: ${rawOutputPath}`);
        }
        writeFileSync(safe.realFile, content, "utf8");
        return safe.realFile;
    }

    const segs = rel.split(/[\\/]/).filter(Boolean);
    if (segs.some((s) => s.startsWith("."))) {
        throw new Error(`Cluster export --output path must not target hidden/dot directories: ${rawOutputPath}`);
    }
    let cur = dirname(absOut);
    while (cur && cur.startsWith(absRoot) && cur !== absRoot) {
        if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
            throw new Error(`Cluster export --output refuses symlink ancestor: ${rawOutputPath}`);
        }
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    let existingAncestor = dirname(absOut);
    while (!existsSync(existingAncestor)) {
        const p = dirname(existingAncestor);
        if (p === existingAncestor) break;
        existingAncestor = p;
    }
    const realAncestor = realpathSync(existingAncestor);
    const relAnc = relative(realRoot, realAncestor);
    if (relAnc.startsWith("..") || isAbsolute(relAnc)) {
        throw new Error(`Cluster export --output path must stay within repository root: ${rawOutputPath}`);
    }

    mkdirSync(dirname(absOut), { recursive: true });
    const safeTarget = join(realpathSync(dirname(absOut)), basename(absOut));
    writeFileSync(safeTarget, content, "utf8");
    const verified = resolveSafeRepoFile(absRoot, realRoot, rawOutputPath, { noSymlinks: true });
    if (!verified) {
        try { unlinkSync(safeTarget); } catch { /* ignore */ }
        throw new Error(`Cluster export --output failed repository containment verification: ${rawOutputPath}`);
    }
    return verified.realFile;
}

export { parsePolicyLayerRule };

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

const FP_BOILERPLATE_RE =
    /^(?:false positive|not an issue|intentional(?: pattern)?|not a bug|ignore(?: this)?|works as intended|no issue|n\/a|none|test)$/i;

/**
 * Validate a detailed `--reason` explanation for `false_positive` dismissals.
 * Requires >= 15 characters, >= 3 words, and non-boilerplate content.
 */
export function validateFalsePositiveReason(reason) {
    if (!reason || typeof reason !== "string") return false;
    const trimmed = reason.trim();
    if (trimmed.length < 15) return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    if (FP_BOILERPLATE_RE.test(trimmed)) return false;
    return true;
}

export function compareIssuesByPriority(a, b, customOrderIndex = new Map(), promotedSet = new Set()) {
    const idxA = customOrderIndex.has(a.id) ? customOrderIndex.get(a.id) : 999999;
    const idxB = customOrderIndex.has(b.id) ? customOrderIndex.get(b.id) : 999999;
    if (idxA !== idxB) return idxA - idxB;

    const pA = promotedSet.has(a.id) ? 0 : 1;
    const pB = promotedSet.has(b.id) ? 0 : 1;
    if (pA !== pB) return pA - pB;

    const tA = TIER_ORDER[a.tier] || 3;
    const tB = TIER_ORDER[b.tier] || 3;
    if (tA !== tB) return tA - tB;

    const sA = SEVERITY_ORDER[a.severity] || 3;
    const sB = SEVERITY_ORDER[b.severity] || 3;
    if (sA !== sB) return sA - sB;

    return String(a.id).localeCompare(String(b.id));
}

function buildCustomOrderIndex(rawOrder, allClusters) {
    const customOrderIndex = new Map();
    let orderPos = 0;
    for (const token of rawOrder || []) {
        if (typeof token === "string" && token.startsWith("cluster:")) {
            const cl = allClusters[token.slice("cluster:".length)];
            for (const cid of cl?.issue_ids || []) {
                if (!customOrderIndex.has(cid)) customOrderIndex.set(cid, orderPos++);
            }
        } else if (!customOrderIndex.has(token)) {
            customOrderIndex.set(token, orderPos++);
        }
    }
    return customOrderIndex;
}

function buildPromotedIssueSet(promotedIds, allClusters) {
    const promotedSet = new Set();
    for (const p of promotedIds || []) {
        if (typeof p === "string" && p.startsWith("cluster:")) {
            for (const cid of allClusters[p.slice("cluster:".length)]?.issue_ids || []) promotedSet.add(cid);
        } else {
            promotedSet.add(p);
        }
    }
    return promotedSet;
}

function partitionBlockedClusterIssues(openIssues, allClusters, stateIssues) {
    const blockedIssueIds = new Set();
    for (const c of Object.values(allClusters)) {
        const deps = Array.isArray(c.depends_on) ? c.depends_on : [];
        const hasUnresolvedDep = deps.some((depName) => {
            const depCluster = allClusters[depName];
            return Boolean(depCluster) && (depCluster.issue_ids || []).some(
                (id) => stateIssues?.[id]?.status === "open" && !stateIssues?.[id]?.suppressed,
            );
        });
        if (!hasUnresolvedDep) continue;
        for (const id of c.issue_ids || []) blockedIssueIds.add(id);
    }
    if (blockedIssueIds.size === 0) return openIssues;
    const unblocked = openIssues.filter((i) => !blockedIssueIds.has(i.id));
    const blocked = openIssues.filter((i) => blockedIssueIds.has(i.id));
    return unblocked.length > 0 ? [...unblocked, ...blocked] : openIssues;
}

function collectPrioritizedOpenIssues(state, plan, allClusters, isBacklog, includeSkipped, focusCluster) {
    const customOrderIndex = buildCustomOrderIndex(plan?.queue_order, allClusters);
    const promotedSet = buildPromotedIssueSet(plan?.promoted_ids, allClusters);
    const deferredSet = new Set(plan?.deferred_ids || []);
    let openIssues = Object.values(state.issues || {})
        .filter((i) => {
            if (!isBacklog && !includeSkipped && deferredSet.has(i.id)) return false;
            return includeSkipped
                ? i.status === "open" || i.status === "deferred" || i.status === "wontfix"
                : i.status === "open" && !i.suppressed;
        })
        .sort((a, b) => compareIssuesByPriority(a, b, customOrderIndex, promotedSet));

    if (!isBacklog) {
        openIssues = partitionBlockedClusterIssues(openIssues, allClusters, state.issues);
    }
    if (focusCluster && allClusters[focusCluster]) {
        const memberSet = new Set(allClusters[focusCluster].issue_ids || []);
        openIssues = openIssues.filter((i) => memberSet.has(i.id));
    }
    return openIssues;
}

function buildGroupedExecutionQueueItems(items, groupMode, explain, impactEstimator) {
    if (groupMode !== "file" && groupMode !== "detector") return null;
    const buckets = new Map();
    for (const it of items) {
        const gKey = groupMode === "file" ? it.file || "repo" : it.detector || "unknown";
        let arr = buckets.get(gKey);
        if (!arr) {
            arr = [];
            buckets.set(gKey, arr);
        }
        arr.push(it);
    }
    const groupedItems = [];
    for (const [gKey, gList] of buckets.entries()) {
        const gImpact = impactEstimator.estimateForIds(gList.map((i) => i.id));
        const first = gList[0];
        const gDim = first?.dimension || "code_quality";
        groupedItems.push({
            id: `group::${groupMode}::${gKey}`,
            group_type: groupMode,
            key: gKey,
            file: groupMode === "file" ? gKey : "repo",
            detector: groupMode === "detector" ? gKey : first?.detector || "multiple",
            dimension: gDim,
            tier: first?.tier || "T3",
            severity: first?.severity || "medium",
            span: groupMode === "file" ? `${gList.length} finding(s)` : "-",
            count: gList.length,
            open_count: gList.length,
            score_impact: gImpact.deltaStrict,
            score_impact_detail: gImpact,
            summary: `${gKey} (${gList.length} open finding(s))`,
            issue_ids: gList.map((i) => i.id),
            items: gList,
            resolve_command:
                groupMode === "detector"
                    ? `plexer health resolve "${gKey}::*" --note "<what you fixed>" --confirm`
                    : `plexer health resolve "*::${gKey}::*" --note "<what you fixed>" --confirm`,
            ...(explain
                ? {
                      explanation: `Tier ${first?.tier || "T3"}, ${first?.severity || "medium"} severity, ${gDim} drag, estimated +${gImpact.deltaStrict.toFixed(1)} strict pts`,
                      why: `Tier ${first?.tier || "T3"}, ${first?.severity || "medium"} severity, ${gDim} drag, estimated +${gImpact.deltaStrict.toFixed(1)} strict pts`,
                  }
                : {}),
        });
    }
    groupedItems.sort((a, b) => b.score_impact - a.score_impact || b.count - a.count);
    return groupedItems;
}

function buildQueueWorkflowSteps(state, plan, items, isBacklog, totalProdFiles) {
    const workflowSteps = [];
    const cov = detectReviewCoverage(state, totalProdFiles || 1);
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
    return workflowSteps;
}

/**
 * Build the prioritized execution queue for `plexer health next` (or `backlog`).
 */
export function buildExecutionQueue(state, plan, opts = {}) {
    const isBacklog = Boolean(opts.backlog);
    const includeSkipped = Boolean(opts.includeSkipped);
    const explain = Boolean(opts.explain);
    const groupMode = opts.group ? String(opts.group).toLowerCase() : "item";

    const manualClusters = plan?.clusters || {};
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...manualClusters };
    const focusCluster = opts.cluster || (!isBacklog ? plan?.focus_cluster : null);

    const openIssues = collectPrioritizedOpenIssues(
        state,
        plan,
        allClusters,
        isBacklog,
        includeSkipped,
        focusCluster,
    );

    const scores = opts.scores || computeScoreSnapshot(state);
    const impactEstimator = createFastScoreImpactEstimator(state, scores);
    const items = [];
    for (const iss of openIssues) {
        const resolveCmd = `plexer health resolve "${iss.id}" --note "<what you fixed>" --confirm`;
        const skipCmd = `plexer health plan skip --permanent "${iss.id}" --note "<why intentional>" --attest "${ATTEST_WONTFIX_EXAMPLE}"`;
        const impact = impactEstimator.estimateForIds([iss.id]);
        const scoreImpact = impact.deltaStrict;
        const dimId = iss.dimension || "code_quality";
        const dimObj = scores.mechanical_dimensions?.[dimId] || scores.subjective_dimensions?.[dimId];
        const dimDrag = dimObj?.overall_drag ?? 0;
        const explanation = explain
            ? `Tier ${iss.tier || "T3"}, ${iss.severity || "medium"} severity, ${dimId} drag (${dimDrag} pts), estimated +${scoreImpact.toFixed(1)} strict pts`
            : undefined;

        items.push({
            ...iss,
            score_impact: scoreImpact,
            score_impact_detail: impact,
            ...(explain ? { explanation, why: explanation } : {}),
            resolve_command: resolveCmd,
            skip_command: skipCmd,
            attest_example: ATTEST_RESOLVE_EXAMPLE,
        });
    }

    const workflowSteps = buildQueueWorkflowSteps(state, plan, items, isBacklog, opts.totalProdFiles);
    const limit = Number(opts.count) > 0 ? Number(opts.count) : isBacklog ? 20 : 5;
    const groupedItems = buildGroupedExecutionQueueItems(items, groupMode, explain, impactEstimator);

    const clustersOut = Object.values(allClusters).map((c) => {
        const cImpact = impactEstimator.estimateForIds(c.issue_ids || []);
        return {
            name: c.name,
            auto: Boolean(c.auto),
            depends_on: c.depends_on || [],
            steps: c.steps || [],
            score_impact: cImpact.deltaStrict,
            score_impact_detail: cImpact,
            open_count: (c.issue_ids || []).filter(
                (id) => state.issues?.[id]?.status === "open" && !state.issues?.[id]?.suppressed,
            ).length,
            total_count: (c.issue_ids || []).length,
        };
    });

    const activeItems = groupedItems ? groupedItems.slice(0, limit) : items.slice(0, limit);
    const queueResult = {
        total_open: items.length,
        group: groupMode,
        group_mode: groupMode,
        focus_cluster: focusCluster || null,
        clusters: clustersOut,
        workflow_steps: workflowSteps,
        ...(groupedItems ? { groups: groupedItems } : {}),
        items: activeItems,
    };
    Object.defineProperties(queueResult, {
        next_items: { value: activeItems, enumerable: false, configurable: true, writable: true },
        all_items: { value: items, enumerable: false, configurable: true, writable: true },
    });
    return queueResult;
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

    const resolvesSinceScan = Number(plan?.resolves_since_last_scan || 0);
    if (
        !opts.force &&
        !opts.forceResolve &&
        !plan?.scan_gate_skipped &&
        resolvesSinceScan + matchedIds.length > RESOLVE_SCAN_GATE_LIMIT
    ) {
        const remaining = Math.max(0, RESOLVE_SCAN_GATE_LIMIT - resolvesSinceScan);
        return {
            ok: false,
            status: "scan_gate_blocked",
            resolved_ids: [],
            matched_count: matchedIds.length,
            remaining,
            message:
                `Scan gate blocked: resolving ${matchedIds.length} item(s) would exceed the ${RESOLVE_SCAN_GATE_LIMIT}-resolve limit since scan #${state.scan_count} (${resolvesSinceScan}/${RESOLVE_SCAN_GATE_LIMIT} used, ${remaining} remaining). ` +
                "Run `plexer health scan` to verify your fixes and catch cascading effects before resolving more items.",
        };
    }

    const note = opts.note || "Fixed in code";
    const attestation = opts.attest || (opts.confirm ? ATTEST_RESOLVE_EXAMPLE : null);

    for (const id of matchedIds) {
        const iss = state.issues[id];
        iss.status = "fixed";
        iss.suspect_hold = false;
        iss.verified = iss.detector === "review" ? Boolean(opts.force || opts.forceResolve) : false;
        iss.note = note;
        iss.attestation = attestation;
        iss.resolved_at = new Date().toISOString();
    }

    if (plan) {
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
    }

    return {
        ok: true,
        status: "resolved",
        resolved_ids: matchedIds,
        suggested_commit: `git commit -m "chore(health): resolve ${matchedIds.length} finding(s) (${matchedIds[0].split("::")[0]})"`,
    };
}

/**
 * Defer (`deferred`) or permanently skip (`wontfix`) issues (`plexer health plan skip`).
 * When `opts.strictAttest` is true on `permanent`, validates that `--attest` contains `"reviewed"` and `"not gaming"`.
 */
function validateSkipAuthority(opts) {
    const isFalsePositive = Boolean(opts.falsePositive || opts.kind === "false_positive");
    const isPermanent = Boolean(opts.permanent || opts.kind === "wontfix");
    const fpReason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
    const hasValidAttest = validateAttestation(opts.attest);
    const hasValidFpReason = isFalsePositive && validateFalsePositiveReason(fpReason);

    if (isFalsePositive && !hasValidAttest && !hasValidFpReason) {
        return {
            ok: false,
            failure: {
                ok: false,
                status: "attestation_invalid",
                skipped_ids: [],
                message: `False-positive (--false-positive) requires either --reason "<detailed explanation >= 15 chars, >= 3 words>" or a valid --attest string containing "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`,
            },
        };
    }
    if (!isFalsePositive && isPermanent && !hasValidAttest) {
        return {
            ok: false,
            failure: {
                ok: false,
                status: "attestation_invalid",
                skipped_ids: [],
                message: `Permanent skip (--permanent) requires a valid --attest string containing "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`,
            },
        };
    }
    const newStatus = isFalsePositive ? "false_positive" : isPermanent ? "wontfix" : "deferred";
    const note = opts.note || fpReason || (isPermanent || isFalsePositive ? "Intentional pattern" : "Deferred for later");
    const reviewAfter =
        opts.reviewAfter !== undefined && opts.reviewAfter !== null && Number(opts.reviewAfter) > 0
            ? Number(opts.reviewAfter)
            : null;
    return {
        ok: true,
        newStatus,
        note,
        fpReason,
        attestation: opts.attest || null,
        reviewAfter,
    };
}

function recordSkippedIssuesInStateAndPlan(state, plan, matchedIds, meta) {
    const nowIso = new Date().toISOString();
    if (plan && (!plan.skipped || typeof plan.skipped !== "object")) {
        plan.skipped = {};
    }
    for (const id of matchedIds) {
        const iss = state.issues[id];
        iss.status = meta.newStatus;
        iss.note = meta.note;
        iss.attestation = meta.attestation;
        if (meta.fpReason) iss.reason = meta.fpReason;
        iss.skipped_at = nowIso;
        if (meta.reviewAfter !== null) {
            iss.resurface_after_scan = (state.scan_count || 0) + meta.reviewAfter;
        }
        if (plan?.skipped) {
            plan.skipped[id] = {
                id,
                status: meta.newStatus,
                note: meta.note,
                ...(meta.fpReason ? { reason: meta.fpReason } : {}),
                attestation: meta.attestation,
                resurface_after_scan: iss.resurface_after_scan ?? null,
                skipped_at: nowIso,
            };
        }
    }
    if (plan) {
        plan.log = [
            ...(plan.log || []),
            {
                action: meta.newStatus,
                issue_ids: matchedIds,
                note: meta.note,
                ...(meta.fpReason ? { reason: meta.fpReason } : {}),
                at: nowIso,
            },
        ];
    }
}

/**
 * Defer (`deferred`) or permanently skip (`wontfix`) issues (`plexer health plan skip`).
 * When `opts.strictAttest` is true on `permanent`, validates that `--attest` contains `"reviewed"` and `"not gaming"`.
 */
export function skipIssues(state, plan, patterns, opts = {}) {
    const auth = validateSkipAuthority(opts);
    if (!auth.ok) return auth.failure;

    let matchedIds = matchIssueIds(state, patterns, new Set(["open", "deferred"]));
    if (matchedIds.length === 0) {
        matchedIds = matchIssueIds(state, patterns, new Set(["fixed"]));
    }
    if (matchedIds.length === 0) {
        return {
            ok: false,
            status: "not_found",
            skipped_ids: [],
            message: `No open issues matched pattern: ${Array.isArray(patterns) ? patterns.join(", ") : patterns}`,
        };
    }
    if (matchedIds.length > 5 && !opts.confirm) {
        return {
            ok: false,
            status: "confirm_required",
            skipped_ids: [],
            error: "Skipping more than 5 issues requires --confirm.",
            message: "Skipping more than 5 issues requires --confirm.",
        };
    }

    recordSkippedIssuesInStateAndPlan(state, plan, matchedIds, auth);
    return {
        ok: true,
        status: auth.newStatus,
        skipped_ids: matchedIds,
    };
}

/**
 * Restore `deferred` or `wontfix` issues back to `open` (`plexer health plan unskip`).
 */
export function unskipIssues(state, plan, patterns) {
    const matchedIds = matchIssueIds(state, patterns, new Set(["deferred", "wontfix", "false_positive"]));
    for (const id of matchedIds) {
        const iss = state.issues[id];
        iss.status = "open";
        iss.suppressed = false;
        iss.reopen_count = (iss.reopen_count || 0) + 1;
        delete iss.resurface_after_scan;
        if (plan?.skipped && typeof plan.skipped === "object") {
            delete plan.skipped[id];
        }
    }
    if (plan) {
        plan.log = [
            ...(plan.log || []),
            {
                action: "unskip",
                issue_ids: matchedIds,
                at: new Date().toISOString(),
            },
        ];
    }
    return {
        ok: true,
        status: "unskipped",
        unskipped_ids: matchedIds,
        reopened_ids: matchedIds,
    };
}

/**
 * Permanently suppress issues matching a pattern with mandatory attestation (`plexer health suppress <pattern> --attest "..."`).
 */
export function suppressIssues(state, config, plan, pattern, opts = {}) {
    const isFalsePositive = Boolean(opts.falsePositive || opts.kind === "false_positive");
    const targetStatus = isFalsePositive ? "false_positive" : "wontfix";
    const attestation = opts.attest || null;
    const reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
    const hasValidAttest = validateAttestation(attestation);
    const hasValidReason = isFalsePositive && validateFalsePositiveReason(reason);

    if (isFalsePositive ? !hasValidAttest && !hasValidReason : !hasValidAttest) {
        return {
            status: "attestation_invalid",
            suppressed_ids: [],
            message: isFalsePositive
                ? `Suppress --false-positive requires either --reason "<detailed explanation >= 15 chars, >= 3 words>" or a valid --attest string containing "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`
                : `Suppress requires a valid --attest string containing "reviewed" and "not gaming". Example: --attest "${ATTEST_WONTFIX_EXAMPLE}"`,
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
    const defaultNote = isFalsePositive
        ? "Attested false positive via plexer health suppress"
        : "Permanently suppressed via plexer health suppress";

    for (const id of matchedIds) {
        const iss = state.issues[id];
        const fp = createHash("sha1")
            .update(`${iss.detector}::${iss.identifier || ""}::${iss.summary || ""}`)
            .digest("hex")
            .slice(0, 12);
        fingerprints.push(fp);
        iss.status = targetStatus;
        iss.suppressed = true;
        iss.attestation = attestation;
        if (reason) iss.reason = reason;
        iss.note = opts.note || reason || defaultNote;
        iss.suppressed_at = nowIso;
    }

    if (!config.suppressions) config.suppressions = {};
    config.suppressions[pat] = {
        pattern: pat,
        kind: targetStatus,
        fingerprints,
        note: opts.note || reason || "Path-independent suppression fingerprint",
        ...(reason ? { reason } : {}),
        attestation,
        added_at: nowIso,
    };
    config.needs_rescan = true;

    if (!Array.isArray(state.attestation_log)) state.attestation_log = [];
    state.attestation_log.push({
        timestamp: nowIso,
        command: "suppress",
        kind: targetStatus,
        pattern: pat,
        ...(reason ? { reason } : {}),
        attestation,
        affected: matchedIds.length,
    });

    if (plan) {
        plan.log = [
            ...(plan.log || []),
            {
                action: "suppress",
                kind: targetStatus,
                pattern: pat,
                issue_ids: matchedIds,
                ...(reason ? { reason } : {}),
                at: nowIso,
            },
        ];
    }

    return {
        status: "suppressed",
        kind: targetStatus,
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
        const iss = state.issues[id];
        if (["fixed", "wontfix", "deferred", "auto_resolved"].includes(iss.status)) {
            iss.reopen_count = (iss.reopen_count || 0) + 1;
        }
        iss.status = "open";
        iss.verified = false;
        iss.suppressed = false;
        delete iss.resurface_after_scan;
        if (plan?.skipped && typeof plan.skipped === "object") {
            delete plan.skipped[id];
        }
    }
    if (plan) {
        plan.log = [
            ...(plan.log || []),
            {
                action: "reopen",
                issue_ids: matchedIds,
                at: new Date().toISOString(),
            },
        ];
    }
    return { ok: true, reopened_ids: matchedIds };
}

function parseDependsOnList(dependsOn, fallback = []) {
    if (!dependsOn) return fallback;
    return (Array.isArray(dependsOn) ? dependsOn : String(dependsOn).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseStepsMarkdownText(rawText) {
    const lines = String(rawText || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const steps = [];
    for (const line of lines) {
        if (line.startsWith("#")) continue;
        const bulletMatch = /^(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
        const done = bulletMatch ? String(bulletMatch[1] || "").toLowerCase() === "x" : false;
        const title = (bulletMatch ? bulletMatch[2] : line).trim();
        if (!title) continue;
        steps.push({
            index: steps.length + 1,
            title,
            detail: "",
            effort: "medium",
            issue_refs: [],
            done,
            status: done ? "done" : "pending",
        });
    }
    return steps;
}

function normalizeOneBasedIndex(rawIdx, length) {
    const n = Number(rawIdx);
    if (!Number.isInteger(n) || n < 1 || n > length) return -1;
    return n - 1;
}

function resolveClusterStepIndex(cluster, rawIdx) {
    const steps = Array.isArray(cluster.steps) ? cluster.steps : [];
    return normalizeOneBasedIndex(rawIdx, steps.length);
}

function appendClusterStepsFromFile(cluster, stepsFile, rootDir) {
    const raw = readSafeClusterRepoInput(
        stepsFile,
        rootDir,
        "Cluster --steps-file",
        [(t) => /^-\s*\[[ xX ]?\]/.test(t) || /^\d+\.\s/.test(t)],
    );
    for (const st of parseStepsMarkdownText(raw)) {
        cluster.steps.push({ ...st, index: cluster.steps.length + 1 });
    }
}

function appendNewClusterStep(cluster, opts) {
    const effortCandidate = String(opts.effort || "medium").toLowerCase();
    const effort = ["trivial", "small", "medium", "large"].includes(effortCandidate) ? effortCandidate : "medium";
    cluster.steps.push({
        index: cluster.steps.length + 1,
        title: String(opts.addStep).trim(),
        detail: opts.detail ? String(opts.detail) : "",
        effort,
        issue_refs: parseDependsOnList(opts.issueRefs, []),
        done: false,
        status: "pending",
    });
}

function applyExistingClusterStepUpdate(cluster, opts) {
    const idx = resolveClusterStepIndex(cluster, opts.updateStep);
    const st = idx >= 0 ? cluster.steps[idx] : null;
    if (!st) return false;
    if (opts.title || opts.addStep) st.title = String(opts.title || opts.addStep).trim();
    if (opts.detail !== undefined) st.detail = String(opts.detail);
    if (opts.effort !== undefined) st.effort = String(opts.effort).toLowerCase();
    if (opts.issueRefs !== undefined) st.issue_refs = parseDependsOnList(opts.issueRefs, st.issue_refs || []);
    return true;
}

function toggleClusterStepCompletion(cluster, stepRef, done) {
    if (stepRef === undefined || stepRef === null) return false;
    const idx = resolveClusterStepIndex(cluster, stepRef);
    if (idx < 0 || !cluster.steps[idx]) return false;
    cluster.steps[idx].done = done;
    cluster.steps[idx].status = done ? "done" : "pending";
    return true;
}

function applyClusterStepMutations(cluster, opts = {}) {
    if (!Array.isArray(cluster.steps)) cluster.steps = [];
    let mutated = false;
    if (opts.stepsFile) {
        appendClusterStepsFromFile(cluster, opts.stepsFile, opts.rootDir);
        mutated = true;
    }
    if (opts.addStep && opts.updateStep === undefined) {
        appendNewClusterStep(cluster, opts);
        mutated = true;
    }
    if (opts.updateStep !== undefined && opts.updateStep !== null && applyExistingClusterStepUpdate(cluster, opts)) {
        mutated = true;
    }
    if (toggleClusterStepCompletion(cluster, opts.doneStep, true)) mutated = true;
    if (toggleClusterStepCompletion(cluster, opts.undoneStep, false)) mutated = true;
    return mutated;
}

function serializeClusterExport(cluster, format = "json") {
    const fmt = String(format || "json").toLowerCase();
    const clean = {
        name: cluster.name,
        auto: Boolean(cluster.auto),
        depends_on: cluster.depends_on || [],
        issue_ids: cluster.issue_ids || [],
        steps: (cluster.steps || []).map((s, i) => ({
            index: s.index ?? i + 1,
            title: s.title,
            detail: s.detail || "",
            effort: s.effort || "medium",
            issue_refs: s.issue_refs || [],
            done: Boolean(s.done),
            status: s.done ? "done" : "pending",
        })),
    };
    if (fmt === "yaml" || fmt === "yml") {
        const lines = [
            `name: ${JSON.stringify(clean.name)}`,
            `auto: ${clean.auto}`,
            `depends_on: ${JSON.stringify(clean.depends_on)}`,
            `issue_ids: ${JSON.stringify(clean.issue_ids)}`,
            "steps:",
        ];
        if (clean.steps.length === 0) {
            lines[lines.length - 1] = "steps: []";
        } else {
            for (const s of clean.steps) {
                lines.push(`  - index: ${s.index}`);
                lines.push(`    title: ${JSON.stringify(s.title)}`);
                lines.push(`    detail: ${JSON.stringify(s.detail)}`);
                lines.push(`    effort: ${JSON.stringify(s.effort)}`);
                lines.push(`    issue_refs: ${JSON.stringify(s.issue_refs)}`);
                lines.push(`    done: ${s.done}`);
            }
        }
        return lines.join("\n") + "\n";
    }
    if (fmt === "text" || fmt === "markdown" || fmt === "md") {
        const lines = [
            `# Cluster: ${clean.name}`,
            `Depends on: ${clean.depends_on.join(", ") || "none"}`,
            `Issues (${clean.issue_ids.length}): ${clean.issue_ids.join(", ")}`,
            "",
            "## Steps",
        ];
        for (const s of clean.steps) {
            lines.push(
                `- [${s.done ? "x" : " "}] ${s.title} (${s.effort})${s.detail ? ` — ${s.detail}` : ""}`,
            );
        }
        return lines.join("\n") + "\n";
    }
    return JSON.stringify(clean, null, 2);
}

function parseClusterImportPayload(rawInput, rootDir = null) {
    if (rawInput && typeof rawInput === "object") return rawInput;
    const text = readSafeClusterRepoInput(
        rawInput,
        rootDir,
        "Cluster import",
        [(t) => t.startsWith("# Cluster:") || t.startsWith("name:")],
    );
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        return JSON.parse(trimmed);
    }
    // Parse YAML or Markdown export format
    const nameMatch = /^(?:name:\s*(.+)|#\s*Cluster:\s*(.+))$/m.exec(trimmed);
    const rawName = (nameMatch?.[1] || nameMatch?.[2] || "imported_cluster").trim();
    const name = rawName.replace(/^["']|["']$/g, "");

    let dependsOn = [];
    const depMatch = /^depends_on:\s*(\[.*\])$/m.exec(trimmed);
    if (depMatch) {
        try {
            dependsOn = JSON.parse(depMatch[1]);
        } catch {
            dependsOn = [];
        }
    }

    let issueIds = [];
    const issMatch = /^issue_ids:\s*(\[.*\])$/m.exec(trimmed);
    if (issMatch) {
        try {
            issueIds = JSON.parse(issMatch[1]);
        } catch {
            issueIds = [];
        }
    }

    const decodeYamlScalar = (rawVal) => {
        const s = String(rawVal || "").trim();
        if (s.startsWith('"')) {
            try {
                return String(JSON.parse(s));
            } catch {
                return s.replace(/^"|"$/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            }
        }
        return s.replace(/^'|'$/g, "");
    };

    const steps = [];
    const yamlStepBlocks = trimmed.split(/\n\s*-\s+index:\s*/);
    if (yamlStepBlocks.length > 1) {
        for (let i = 1; i < yamlStepBlocks.length; i++) {
            const blk = yamlStepBlocks[i];
            const tMatch = /title:\s*(.+)/m.exec(blk);
            const dMatch = /detail:\s*(.+)/m.exec(blk);
            const eMatch = /effort:\s*(.+)/m.exec(blk);
            const refsMatch = /issue_refs:\s*(\[[^\n]*\])/m.exec(blk);
            const doneMatch = /done:\s*(true|false)/m.exec(blk);
            let issueRefs = [];
            if (refsMatch) {
                try {
                    const parsedRefs = JSON.parse(refsMatch[1]);
                    if (Array.isArray(parsedRefs)) issueRefs = parsedRefs;
                } catch {
                    issueRefs = [];
                }
            }
            const isDone = doneMatch ? doneMatch[1] === "true" : false;
            steps.push({
                index: i,
                title: decodeYamlScalar(tMatch?.[1] || `Step ${i}`),
                detail: decodeYamlScalar(dMatch?.[1] || ""),
                effort: decodeYamlScalar(eMatch?.[1] || "medium"),
                issue_refs: issueRefs,
                done: isDone,
                status: isDone ? "done" : "pending",
            });
        }
    } else {
        steps.push(...parseStepsMarkdownText(trimmed));
    }

    return { name, auto: false, depends_on: dependsOn, issue_ids: issueIds, steps };
}

function mergePlanClusters(plan, allClusters, clusterName, patterns, opts) {
    const srcName = clusterName || opts.src;
    const tgtName = opts.target || opts.to || (Array.isArray(patterns) ? patterns[0] : patterns);
    const srcCluster = plan.clusters[srcName] || allClusters[srcName];
    if (!srcCluster || !tgtName) {
        return {
            ok: false,
            sub_action: "merge",
            status: "not_found",
            message: `Cannot merge "${srcName}" into "${tgtName}"`,
        };
    }
    const tgtCluster = plan.clusters[tgtName] ||
        allClusters[tgtName] || {
            name: tgtName,
            auto: false,
            issue_ids: [],
            depends_on: [],
            steps: [],
        };
    const mergedSteps = [...(tgtCluster.steps || []), ...(srcCluster.steps || [])].map((s, idx) => ({
        ...s,
        index: idx + 1,
    }));
    plan.clusters[tgtName] = {
        ...tgtCluster,
        name: tgtName,
        auto: false,
        issue_ids: [...new Set([...(tgtCluster.issue_ids || []), ...(srcCluster.issue_ids || [])])],
        depends_on: [...new Set([...(tgtCluster.depends_on || []), ...(srcCluster.depends_on || [])])].filter(
            (d) => d !== tgtName && d !== srcName,
        ),
        steps: mergedSteps,
    };
    delete plan.clusters[srcName];
    for (const c of Object.values(plan.clusters)) {
        if (Array.isArray(c.depends_on)) {
            c.depends_on = [...new Set(c.depends_on.map((d) => (d === srcName ? tgtName : d)).filter((d) => d !== c.name))];
        }
    }
    if (plan.focus_cluster === srcName) plan.focus_cluster = tgtName;
    return {
        ok: true,
        sub_action: "merge",
        merged_from: srcName,
        merged_into: tgtName,
        cluster: plan.clusters[tgtName],
        clusters: plan.clusters,
    };
}

function mutatePlanClusterUpdate(plan, allClusters, clusterName, opts) {
    const existing = plan.clusters[clusterName] || allClusters[clusterName];
    if (!existing)
        return { ok: false, sub_action: "update", status: "not_found", message: `Cluster "${clusterName}" not found` };
    const updated = {
        ...existing,
        name: clusterName,
        auto: false,
        depends_on: parseDependsOnList(opts.dependsOn, existing.depends_on || []),
        steps: Array.isArray(existing.steps) ? [...existing.steps] : [],
    };
    applyClusterStepMutations(updated, opts);
    plan.clusters[clusterName] = updated;
    return { ok: true, sub_action: "update", cluster: plan.clusters[clusterName], clusters: plan.clusters };
}
function mutatePlanClusterMove(state, plan, clusterName, patterns, opts) {
    const movePatterns = opts.to && clusterName && clusterName !== opts.to ? [clusterName, ...(patterns || [])] : patterns || [];
    const toCluster = opts.to || clusterName;
    if (!toCluster)
        throw new Error("cluster move requires a destination cluster name (e.g. `plexer health plan cluster move <pattern> --to <cluster>`)");
    const matched = matchIssueIds(state, movePatterns);
    for (const c of Object.values(plan.clusters))
        c.issue_ids = (c.issue_ids || []).filter((id) => !matched.includes(id));
    const existing = plan.clusters[toCluster] || { name: toCluster, auto: false, issue_ids: [], depends_on: [], steps: [] };
    existing.issue_ids = [...new Set([...(existing.issue_ids || []), ...matched])];
    plan.clusters[toCluster] = existing;
    return { ok: true, sub_action: "move", cluster: existing, moved_ids: matched, clusters: plan.clusters };
}
function mutatePlanClusterMembers(state, plan, allClusters, sub, clusterName, patterns, opts) {
    if (sub === "update" && clusterName)
        return mutatePlanClusterUpdate(plan, allClusters, clusterName, opts);
    if (sub === "move")
        return mutatePlanClusterMove(state, plan, clusterName, patterns, opts);
    if (sub === "add" && clusterName) {
        const matched = matchIssueIds(state, patterns);
        const existing = plan.clusters[clusterName] || { name: clusterName, auto: false, issue_ids: [], depends_on: [], steps: [] };
        existing.issue_ids = [...new Set([...(existing.issue_ids || []), ...matched])];
        applyClusterStepMutations(existing, opts);
        plan.clusters[clusterName] = existing;
        return { ok: true, sub_action: "add", cluster: existing, clusters: plan.clusters };
    }
    if (sub === "remove" && clusterName) {
        const matched = new Set(matchIssueIds(state, patterns));
        const existing = plan.clusters[clusterName];
        if (existing) existing.issue_ids = (existing.issue_ids || []).filter((id) => !matched.has(id));
        return { ok: true, sub_action: "remove", cluster: existing || null, clusters: plan.clusters };
    }
    if (clusterName) {
        const existing = plan.clusters[clusterName] || {};
        const created = {
            ...existing,
            name: clusterName,
            auto: false,
            issue_ids: patterns && patterns.length > 0 ? matchIssueIds(state, patterns) : existing.issue_ids || [],
            depends_on: parseDependsOnList(opts.dependsOn, existing.depends_on || []),
            steps: Array.isArray(existing.steps) ? [...existing.steps] : [],
        };
        applyClusterStepMutations(created, opts);
        plan.clusters[clusterName] = created;
    }
    return { ok: true, sub_action: "create", cluster: clusterName ? plan.clusters[clusterName] : null, clusters: plan.clusters };
}

function listPlanClustersResult(allClusters, state) {
    return {
        ok: true,
        sub_action: "list",
        clusters: Object.values(allClusters).map((c) => ({
            name: c.name,
            auto: Boolean(c.auto),
            depends_on: c.depends_on || [],
            steps: c.steps || [],
            issue_ids: c.issue_ids || [],
            open_count: (c.issue_ids || []).filter((id) => state.issues?.[id]?.status === "open").length,
        })),
    };
}
function exportPlanClusterResult(allClusters, clusterName, opts) {
    const target = allClusters[clusterName];
    if (!target)
        return { ok: false, sub_action: "export", status: "not_found", message: `Cluster "${clusterName}" not found` };
    const fmt = String(opts.exportFormat || opts.format || "json").toLowerCase();
    const content = serializeClusterExport(target, fmt);
    if (opts.output)
        writeSafeClusterRepoOutput(opts.output, content, opts.rootDir);
    return { ok: true, sub_action: "export", format: fmt, cluster: target, content, exported: content };
}
/**
 * Manage living plan clusters (`create`, `add`, `remove`, `move`, `merge`, `export`, `import`, `update`, `delete`, `list`, `show`).
 */
export function managePlanCluster(state, plan, subAction = "list", clusterName = null, patterns = [], opts = {}) {
    if (!plan.clusters) plan.clusters = {};
    const allClusters = { ...buildAutoClusters(state.issues), ...plan.clusters };
    const sub = String(subAction || "list").toLowerCase();
    if (sub === "list")
        return listPlanClustersResult(allClusters, state);
    if (sub === "show") {
        const target = allClusters[clusterName];
        if (!target)
            return { ok: false, sub_action: "show", status: "not_found", message: `Cluster "${clusterName}" not found` };
        return { ok: true, sub_action: "show", cluster: { ...target, steps: target.steps || [], issues: (target.issue_ids || []).map((id) => state.issues?.[id]).filter(Boolean) } };
    }
    if (sub === "delete" && clusterName) {
        delete plan.clusters[clusterName];
        if (plan.focus_cluster === clusterName) plan.focus_cluster = null;
        return { ok: true, sub_action: "delete", deleted: clusterName, clusters: plan.clusters };
    }
    if (sub === "merge")
        return mergePlanClusters(plan, allClusters, clusterName, patterns, opts);
    if (sub === "export")
        return exportPlanClusterResult(allClusters, clusterName, opts);
    if (sub === "import") {
        const src = opts.file || opts.content || clusterName || (Array.isArray(patterns) ? patterns[0] : patterns);
        const imported = parseClusterImportPayload(src, opts.rootDir);
        const cName = imported.name || "imported_cluster";
        plan.clusters[cName] = {
            name: cName,
            auto: false,
            issue_ids: Array.isArray(imported.issue_ids) ? imported.issue_ids : [],
            depends_on: Array.isArray(imported.depends_on) ? imported.depends_on : [],
            steps: Array.isArray(imported.steps) ? imported.steps : [],
        };
        return { ok: true, sub_action: "import", cluster: plan.clusters[cName], clusters: plan.clusters };
    }
    return mutatePlanClusterMembers(state, plan, allClusters, sub, clusterName, patterns, opts);
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

function normalizeReorderQueueArgs(arg1, arg2, arg3, arg4, arg5, arg6) {
    let state = arg1;
    let plan = arg2;
    let patterns = arg3;
    let position = arg4 || "top";
    let targetPattern = arg5;
    let opts = arg6 || {};

    if (arg1 && !arg1.issues && (Array.isArray(arg1.queue_order) || Array.isArray(arg2) || typeof arg2 === "string")) {
        state = { issues: {} };
        plan = arg1;
        patterns = arg2;
        position = typeof arg3 === "string" ? arg3 : "top";
        if (arg4 && typeof arg4 === "object" && !Array.isArray(arg4)) {
            targetPattern = null;
            opts = arg4;
        } else {
            targetPattern = arg4;
            opts = arg5 || {};
        }
    }
    return { state, plan, patterns, position, targetPattern, opts };
}

function resolveMovingQueueIds(state, plan, patterns, currentOrder) {
    const movingIds = [];
    const patList = Array.isArray(patterns) ? patterns : [patterns];
    const autoClusters = buildAutoClusters(state?.issues || {});
    const allClusters = { ...autoClusters, ...(plan.clusters || {}) };

    for (const p of patList) {
        if (!p) continue;
        const cleanCluster = String(p).startsWith("cluster:") ? String(p).slice("cluster:".length) : p;
        if (allClusters[cleanCluster]) {
            movingIds.push(...(allClusters[cleanCluster].issue_ids || []));
        } else {
            const matched = matchIssueIds(state, [p]);
            if (matched.length > 0) {
                movingIds.push(...matched);
            } else if (currentOrder.includes(p)) {
                movingIds.push(p);
            }
        }
    }
    return movingIds;
}

/**
 * Reorder items or clusters in `plan.queue_order` (`top`, `bottom`, `before`, `after`, `up`, `down`).
 */
export function reorderPlanQueue(arg1, arg2, arg3 = "top", arg4 = null, arg5 = null, arg6 = {}) {
    const { state, plan, patterns, position, targetPattern, opts } = normalizeReorderQueueArgs(
        arg1,
        arg2,
        arg3,
        arg4,
        arg5,
        arg6,
    );

    const currentOrder =
        plan.queue_order && plan.queue_order.length > 0
            ? [...plan.queue_order]
            : Object.values(state?.issues || {})
                  .filter((i) => i.status === "open")
                  .sort((a, b) => compareIssuesByPriority(a, b))
                  .map((i) => i.id);

    const movingIds = resolveMovingQueueIds(state, plan, patterns, currentOrder);
    const movingSet = new Set(movingIds);
    const firstIdx = currentOrder.findIndex((id) => movingSet.has(id));
    const rest = currentOrder.filter((id) => !movingSet.has(id));
    const pos = String(position || "top").toLowerCase();

    if (pos === "bottom") {
        plan.queue_order = [...rest, ...movingSet];
    } else if (pos === "up" || pos === "down") {
        const rawOffset =
            opts?.offset ??
            (typeof targetPattern === "number" ||
            (typeof targetPattern === "string" && /^\d+$/.test(targetPattern))
                ? Number(targetPattern)
                : 1);
        const offset = Math.max(1, Number(rawOffset) || 1);
        if (firstIdx === -1) {
            plan.queue_order = pos === "up" ? [...movingSet, ...rest] : [...rest, ...movingSet];
        } else {
            const nonMovingBefore = currentOrder
                .slice(0, firstIdx)
                .filter((id) => !movingSet.has(id)).length;
            const insertAt =
                pos === "up"
                    ? Math.max(0, nonMovingBefore - offset)
                    : Math.min(rest.length, nonMovingBefore + offset);
            rest.splice(insertAt, 0, ...movingSet);
            plan.queue_order = rest;
        }
    } else if ((pos === "before" || pos === "after") && targetPattern) {
        const targetIds = matchIssueIds(state, [targetPattern]);
        const anchor = targetIds[0] || targetPattern;
        const idx = rest.indexOf(anchor);
        if (idx === -1) {
            plan.queue_order = [...movingSet, ...rest];
        } else {
            const insertAt = pos === "after" ? idx + 1 : idx;
            rest.splice(insertAt, 0, ...movingSet);
            plan.queue_order = rest;
        }
    } else {
        plan.queue_order = [...movingSet, ...rest];
    }

    return {
        ok: true,
        moved_count: movingSet.size,
        position: pos,
        queue_order: plan.queue_order,
    };
}

/**
 * Promote matched issue IDs or `cluster:<name>` into `plan.promoted_ids` and position them in `plan.queue_order`.
 */
export function promotePlanItems(state, plan, patterns, position = "top", targetPattern = null) {
    if (!Array.isArray(plan.promoted_ids)) plan.promoted_ids = [];
    const patList = Array.isArray(patterns) ? patterns : [patterns];
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...(plan.clusters || {}) };
    const addedPromotions = [];

    for (const rawPat of patList) {
        if (!rawPat) continue;
        const p = String(rawPat).trim();
        if (p.startsWith("cluster:")) {
            addedPromotions.push(p);
        } else if (allClusters[p]) {
            addedPromotions.push(`cluster:${p}`);
            addedPromotions.push(...(allClusters[p].issue_ids || []));
        } else {
            addedPromotions.push(...matchIssueIds(state, [p]));
        }
    }

    plan.promoted_ids = [...new Set([...plan.promoted_ids, ...addedPromotions])];
    if (Array.isArray(plan.deferred_ids)) {
        const promoSet = new Set(addedPromotions);
        plan.deferred_ids = plan.deferred_ids.filter((id) => !promoSet.has(id));
    }
    const reordered = reorderPlanQueue(state, plan, patList, position, targetPattern);
    return {
        ok: true,
        promoted_ids: plan.promoted_ids,
        added_ids: addedPromotions,
        ...reordered,
    };
}

/**
 * Demote matched items or `cluster:<name>` from `plan.promoted_ids` and `plan.queue_order` (`plexer health plan backlog`).
 */
export function demotePlanItemsToBacklog(state, plan, patterns) {
    if (!Array.isArray(plan.promoted_ids)) plan.promoted_ids = [];
    if (!Array.isArray(plan.queue_order)) plan.queue_order = [];
    if (!Array.isArray(plan.deferred_ids)) plan.deferred_ids = [];
    const patList = Array.isArray(patterns) ? patterns : [patterns];
    const autoClusters = buildAutoClusters(state.issues);
    const allClusters = { ...autoClusters, ...(plan.clusters || {}) };
    const toRemove = new Set();

    for (const rawPat of patList) {
        if (!rawPat) continue;
        const p = String(rawPat).trim();
        if (p.startsWith("cluster:")) {
            toRemove.add(p);
            const cName = p.slice("cluster:".length);
            for (const cid of allClusters[cName]?.issue_ids || []) toRemove.add(cid);
        } else if (allClusters[p]) {
            toRemove.add(`cluster:${p}`);
            for (const cid of allClusters[p].issue_ids || []) toRemove.add(cid);
        } else {
            for (const id of matchIssueIds(state, [p])) toRemove.add(id);
        }
    }

    plan.promoted_ids = plan.promoted_ids.filter((id) => !toRemove.has(id));
    plan.queue_order = plan.queue_order.filter((id) => !toRemove.has(id));
    plan.deferred_ids = [...new Set([...plan.deferred_ids, ...toRemove])];
    return {
        ok: true,
        demoted_ids: [...toRemove],
        deferred_ids: plan.deferred_ids,
        promoted_ids: plan.promoted_ids,
        queue_order: plan.queue_order,
    };
}

/**
 * Annotate issues with custom description (`plan describe`) or note (`plan note`).
 */
export function annotatePlanIssues(state, plan, patterns, { description, note } = {}) {
    const matchedIds = matchIssueIds(state, patterns);
    if (plan && (!plan.annotations || typeof plan.annotations !== "object")) {
        plan.annotations = {};
    }
    const nowIso = new Date().toISOString();

    for (const id of matchedIds) {
        const iss = state.issues[id];
        if (!iss) continue;
        if (description !== undefined && description !== null) {
            iss.custom_description = String(description);
            iss.description = iss.custom_description;
        }
        if (note !== undefined && note !== null) {
            const noteStr = String(note);
            iss.note = iss.note && iss.note !== "Fixed in code" ? `${iss.note}\n${noteStr}` : noteStr;
        }
        if (plan?.annotations) {
            plan.annotations[id] = {
                ...(plan.annotations[id] || {}),
                ...(description !== undefined && description !== null
                    ? {
                          description: iss.custom_description,
                          custom_description: iss.custom_description,
                      }
                    : {}),
                ...(note !== undefined && note !== null ? { note: iss.note } : {}),
                updated_at: nowIso,
            };
        }
    }

    return {
        ok: true,
        updated_ids: matchedIds,
        annotations: plan?.annotations || {},
    };
}

/**
 * Manage architectural policies in `plan.policies` (`plan policy [list|add|remove]`).
 */
export function managePlanPolicy(plan, subAction = "list", ruleOrIdx = null, config = null) {
    if (!Array.isArray(plan.policies)) plan.policies = [];
    const sub = String(subAction || "list").toLowerCase();

    if (sub === "add" && ruleOrIdx) {
        const text = String(ruleOrIdx).trim();
        if (text && !plan.policies.includes(text)) {
            plan.policies.push(text);
        }
        const parsedRule = parsePolicyLayerRule(text);
        if (parsedRule && config) {
            if (!Array.isArray(config.layer_rules)) config.layer_rules = [];
            const exists = config.layer_rules.some(
                (r) => r.from === parsedRule.from && r.to === parsedRule.to,
            );
            if (!exists) config.layer_rules.push(parsedRule);
        }
    } else if (sub === "remove" && ruleOrIdx !== null && ruleOrIdx !== undefined) {
        const raw = String(ruleOrIdx).trim();
        const removedPolicies = [];
        if (/^\d+$/.test(raw)) {
            const idx = normalizeOneBasedIndex(Number(raw), plan.policies.length);
            if (idx >= 0) {
                removedPolicies.push(...plan.policies.splice(idx, 1));
            }
        } else {
            plan.policies = plan.policies.filter((p) => {
                if (p === raw) {
                    removedPolicies.push(p);
                    return false;
                }
                return true;
            });
        }
        if (config && Array.isArray(config.layer_rules) && removedPolicies.length > 0) {
            const removedSpecs = removedPolicies.map(parsePolicyLayerRule).filter(Boolean);
            const directRule = parsePolicyLayerRule(raw);
            if (directRule) removedSpecs.push(directRule);
            if (removedSpecs.length > 0) {
                config.layer_rules = config.layer_rules.filter(
                    (r) => !removedSpecs.some((rm) => rm.from === r.from && rm.to === r.to),
                );
            }
        }
    }

    const layerRules = plan.policies.map(parsePolicyLayerRule).filter(Boolean);
    return {
        ok: true,
        sub_action: sub,
        policies: plan.policies,
        layer_rules: layerRules,
    };
}

/**
 * Manage scan-gate (`plan scan-gate [--skip --note "<min 50 chars>" | --reset]`).
 */
export function manageScanGate(state, plan, opts = {}) {
    if (opts.reset || opts.subAction === "reset") {
        plan.scan_gate_skipped = false;
        delete plan.scan_gate_note;
        plan.resolves_since_last_scan = 0;
        return {
            ok: true,
            status: "reset",
            scan_gate_skipped: false,
            resolves_since_last_scan: 0,
        };
    }
    if (opts.skip || opts.subAction === "skip") {
        const note = String(opts.note || "").trim();
        if (note.length < 50) {
            return {
                ok: false,
                status: "note_too_short",
                error: "Skipping scan-gate requires a --note of at least 50 characters.",
                message: "Skipping scan-gate requires a --note of at least 50 characters.",
            };
        }
        plan.scan_gate_skipped = true;
        plan.scan_gate_note = note;
        return {
            ok: true,
            status: "skipped",
            scan_gate_skipped: true,
            note,
        };
    }
    return {
        ok: true,
        status: "status",
        scan_gate_skipped: Boolean(plan.scan_gate_skipped),
        resolves_since_last_scan: Number(plan.resolves_since_last_scan || 0),
        note: plan.scan_gate_note || null,
    };
}

function collectNonClusterPlanIds(list, referencedIds) {
    for (const id of list || []) {
        if (typeof id === "string" && !id.startsWith("cluster:")) referencedIds.add(id);
    }
}

function collectSkippedPlanEntries(skipped, referencedIds) {
    const skippedMap = new Map();
    if (Array.isArray(skipped)) {
        for (const item of skipped) {
            if (typeof item === "string") {
                referencedIds.add(item);
                skippedMap.set(item, { status: "deferred" });
            } else if (item && typeof item === "object" && item.id) {
                referencedIds.add(item.id);
                skippedMap.set(item.id, item);
            }
        }
        return skippedMap;
    }
    if (skipped && typeof skipped === "object") {
        for (const [id, meta] of Object.entries(skipped)) {
            referencedIds.add(id);
            skippedMap.set(id, typeof meta === "object" && meta !== null ? meta : { status: "deferred" });
        }
    }
    return skippedMap;
}

function collectPlanReferencedIssueMetadata(plan) {
    const referencedIds = new Set();
    for (const c of Object.values(plan?.clusters || {})) {
        collectNonClusterPlanIds(c?.issue_ids, referencedIds);
    }
    collectNonClusterPlanIds(plan?.queue_order, referencedIds);
    collectNonClusterPlanIds(plan?.promoted_ids, referencedIds);
    for (const id of plan?.uncommitted_resolved || []) {
        if (typeof id === "string") referencedIds.add(id);
    }
    const skippedMap = collectSkippedPlanEntries(plan?.skipped, referencedIds);
    const annotationsObj =
        plan?.annotations && typeof plan.annotations === "object" ? plan.annotations : {};
    for (const id of Object.keys(annotationsObj)) {
        referencedIds.add(id);
    }
    return { referencedIds, skippedMap, annotationsObj };
}

/**
 * Reconstruct missing or corrupted entries in `state.issues` from `plan.clusters`,
 * `plan.queue_order`, `plan.skipped`, and `plan.annotations` (`plexer health plan repair-state`).
 */
function reconstructCorruptIssueRecord(id, existing) {
    const parts = String(id).split("::");
    const detector = parts[0] || "unknown";
    const file = parts[1] || "repo";
    const identifier = parts.slice(2).join("::") || "item";
    const resolvedDim =
        Object.values(MECHANICAL_DIMENSIONS).find((d) => d.detectors.includes(detector))?.id || "code_quality";
    return {
        id,
        detector,
        category: DETECTOR_CATEGORY[detector] || "code_quality",
        dimension: resolvedDim,
        tier: "T3",
        confidence: "medium",
        severity: "medium",
        file,
        line: 1,
        end_line: 1,
        span: "L1-L1",
        identifier,
        summary: `Reconstructed ${detector} finding (${identifier})`,
        status: "open",
        verified: false,
        reconstructed: true,
        ...(existing && typeof existing === "object" ? existing : {}),
    };
}

function applyPlanMetaToRepairedIssue(iss, id, skippedMap, annotationsObj) {
    if (skippedMap.has(id)) {
        const sk = skippedMap.get(id);
        iss.status = sk.status || "deferred";
        if (sk.note) iss.note = sk.note;
        if (sk.resurface_after_scan != null) iss.resurface_after_scan = sk.resurface_after_scan;
    }
    const ann = annotationsObj[id];
    if (!ann) return;
    if (ann.custom_description || ann.description) {
        iss.custom_description = ann.custom_description || ann.description;
    }
    if (ann.note) iss.note = ann.note;
}

export function repairStateFromPlan(state, plan) {
    if (!state.issues || typeof state.issues !== "object") state.issues = {};
    const { referencedIds, skippedMap, annotationsObj } = collectPlanReferencedIssueMetadata(plan);
    const repairedIds = [];

    for (const id of referencedIds) {
        const existing = state.issues[id];
        if (!existing || typeof existing !== "object" || !existing.id || !existing.detector) {
            state.issues[id] = reconstructCorruptIssueRecord(id, existing);
            repairedIds.push(id);
        }
        applyPlanMetaToRepairedIssue(state.issues[id], id, skippedMap, annotationsObj);
    }

    return {
        ok: true,
        status: "repaired",
        repaired_count: repairedIds.length,
        repaired_ids: repairedIds,
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

const STAGE_GUIDANCE = {
    strategize:
        "Assess overall score drag across mechanical and subjective dimensions, identify high-leverage architectural root causes, and define the overarching remediation strategy.",
    observe:
        "Inspect open mechanical and subjective review findings, hotspot files, and recurring patterns across directories before proposing local edits.",
    reflect:
        "Trace cross-module dependencies and root causes behind finding clusters to distinguish symptoms from structural seams.",
    organize:
        "Group related findings into execution clusters (`plexer health plan cluster create`), set `depends_on` ordering, and promote top-priority items.",
    enrich:
        "Add structured cluster steps (`--add-step`), custom descriptions (`plan describe`), and engineering notes (`plan note`) to guide execution.",
    "sense-check":
        "Verify the execution queue order against score drag, blast radius, and architectural policies (`plan policy`).",
    commit:
        "Finalize and commit the living triage plan (`plexer health plan triage --stage commit --report \"...\"`).",
};

/**
 * Build a tailored prompt for a specific triage stage (`plexer health plan triage --stage-prompt <stage>`).
 */
export function buildTriageStagePrompt(stage, state = null, plan = null) {
    const stg = String(stage || "observe").toLowerCase();
    if (!TRIAGE_STAGES.includes(stg)) {
        throw new Error(
            `Invalid triage stage "${stg}" — must be one of: ${TRIAGE_STAGES.join(", ")}`,
        );
    }
    const openIssues = Object.values(state?.issues || {}).filter(
        (i) => i.status === "open" && !i.suppressed,
    );
    const activeClusters = Object.keys(plan?.clusters || {});
    const policies = plan?.policies || [];

    return [
        `# Living Plan Triage — Stage: ${stg}`,
        "",
        `## Objective`,
        STAGE_GUIDANCE[stg] || "Analyze findings and update the living triage plan.",
        "",
        `## Current Context`,
        `- Open findings: ${openIssues.length}`,
        `- Active clusters: ${activeClusters.length > 0 ? activeClusters.join(", ") : "none"}`,
        `- Active policies: ${policies.length > 0 ? policies.join("; ") : "none"}`,
        "",
        `## Next Command`,
        `\`plexer health plan triage --stage ${stg} --report "<your ${stg} synthesis>"\``,
    ].join("\n");
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

    if (opts.stagePrompt) {
        const prompt = buildTriageStagePrompt(opts.stagePrompt, state, plan);
        return {
            ok: true,
            stage: String(opts.stagePrompt).toLowerCase(),
            stage_prompt: prompt,
            prompt,
            triage: plan.triage,
            stale: state ? isTriageStale(plan, state) : false,
        };
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

    if (opts.confirmExisting) {
        const nowIso = new Date().toISOString();
        plan.triage.completed = true;
        plan.triage.confirmed_at = nowIso;
        if (!plan.triage.strategy) {
            plan.triage.strategy = opts.strategy || opts.report || "Confirmed existing triage plan";
        }
        snapshotStateCounts();
        return {
            ok: true,
            stage: "confirm-existing",
            confirmed: true,
            triage: plan.triage,
            stale: false,
        };
    }

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
            ok: true,
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
        ok: true,
        stage,
        triage: plan.triage,
        stale: state ? isTriageStale(plan, state) : false,
    };
}

/**
 * Immediately prune issues matching an exclusion path/pattern from `state.issues`
 * and purge their IDs from `plan` (`queue_order`, `uncommitted_resolved`, `clusters`).
 */
function excludedFileMatchesPattern(filePath, pat, wildcardRe) {
    const f = String(filePath || "").replace(/\\/g, "/");
    if (!f) return false;
    if (wildcardRe) return wildcardRe.test(f);
    return f === pat || f.startsWith(`${pat}/`) || f.includes(`/${pat}/`) || f.endsWith(`/${pat}`);
}

function purgeIdsFromPlan(plan, rmSet) {
    let purgedPlanCount = 0;
    const filterList = (list) => {
        if (!Array.isArray(list)) return list;
        const before = list.length;
        const filtered = list.filter((id) => !rmSet.has(id));
        purgedPlanCount += before - filtered.length;
        return filtered;
    };
    plan.queue_order = filterList(plan.queue_order);
    plan.deferred_ids = filterList(plan.deferred_ids);
    plan.promoted_ids = filterList(plan.promoted_ids);
    if (Array.isArray(plan.uncommitted_resolved)) {
        plan.uncommitted_resolved = plan.uncommitted_resolved.filter((id) => !rmSet.has(id));
    }
    if (Array.isArray(plan.skipped)) {
        const before = plan.skipped.length;
        plan.skipped = plan.skipped.filter((entry) => {
            const id = typeof entry === "string" ? entry : entry?.id;
            return !id || !rmSet.has(id);
        });
        purgedPlanCount += before - plan.skipped.length;
    } else if (plan.skipped && typeof plan.skipped === "object") {
        for (const id of rmSet) {
            if (Object.prototype.hasOwnProperty.call(plan.skipped, id)) {
                delete plan.skipped[id];
                purgedPlanCount += 1;
            }
        }
    }
    if (plan.annotations && typeof plan.annotations === "object") {
        for (const id of rmSet) {
            if (Object.prototype.hasOwnProperty.call(plan.annotations, id)) {
                delete plan.annotations[id];
                purgedPlanCount += 1;
            }
        }
    }
    if (plan.triage && Array.isArray(plan.triage.triaged_review_ids)) {
        plan.triage.triaged_review_ids = plan.triage.triaged_review_ids.filter((id) => !rmSet.has(id));
    }
    if (plan.clusters && typeof plan.clusters === "object") {
        for (const c of Object.values(plan.clusters)) {
            if (Array.isArray(c?.issue_ids)) {
                c.issue_ids = filterList(c.issue_ids);
            }
            for (const s of c?.steps || []) {
                if (s && Array.isArray(s.issue_refs)) {
                    s.issue_refs = s.issue_refs.filter((id) => !rmSet.has(id));
                }
            }
        }
    }
    return purgedPlanCount;
}

export function pruneExcludedIssues(state, plan, rawPattern) {
    const pat = String(rawPattern || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
    if (!pat) return { removed_ids: [], purged_plan_count: 0 };

    const wildcardRe = pat.includes("*") ? wildcardToRegExp(pat) : null;
    const removedIds = [];
    for (const [id, iss] of Object.entries(state.issues || {})) {
        if (excludedFileMatchesPattern(iss.file, pat, wildcardRe)) {
            removedIds.push(id);
            delete state.issues[id];
        }
    }

    const purgedPlanCount = removedIds.length > 0 && plan
        ? purgeIdsFromPlan(plan, new Set(removedIds))
        : 0;

    return {
        removed_ids: removedIds,
        purged_plan_count: purgedPlanCount,
    };
}

function remapSingleIssuePaths(oldId, iss, moveMap) {
    let mutated = false;
    const oldFile = iss.file;
    const newFile = moveMap.get(oldFile);
    let newId = oldId;
    if (newFile && newFile !== oldFile) {
        const parts = String(oldId).split("::");
        newId =
            parts.length >= 2 && parts[1] === oldFile
                ? [parts[0], newFile, ...parts.slice(2)].join("::")
                : oldId;
        iss.file = newFile;
        iss.id = newId;
        mutated = true;
    }
    if (iss.target_file && moveMap.has(iss.target_file)) {
        iss.target_file = moveMap.get(iss.target_file);
        mutated = true;
    }
    if (iss.partner_file && moveMap.has(iss.partner_file)) {
        iss.partner_file = moveMap.get(iss.partner_file);
        mutated = true;
    }
    if (Array.isArray(iss.related_files)) {
        iss.related_files = iss.related_files.map((rf) => {
            if (moveMap.has(rf)) {
                mutated = true;
                return moveMap.get(rf);
            }
            return rf;
        });
    }
    if (Array.isArray(iss.members)) {
        for (const m of iss.members) {
            if (m && typeof m === "object" && m.file && moveMap.has(m.file)) {
                m.file = moveMap.get(m.file);
                mutated = true;
            }
        }
    }
    if (Array.isArray(iss.cycle)) {
        iss.cycle = iss.cycle.map((cf) => {
            if (moveMap.has(cf)) {
                mutated = true;
                return moveMap.get(cf);
            }
            return cf;
        });
    }
    return { mutated, newId };
}

function remapStateIssueKeys(state, moveMap) {
    const idMap = new Map();
    let mutatedCount = 0;
    if (!state?.issues || typeof state.issues !== "object") return { idMap, mutatedCount };
    for (const [oldId, iss] of Object.entries(state.issues)) {
        if (!iss || typeof iss !== "object") continue;
        const { mutated, newId } = remapSingleIssuePaths(oldId, iss, moveMap);
        if (newId !== oldId) {
            idMap.set(oldId, newId);
            state.issues[newId] = iss;
            delete state.issues[oldId];
        }
        if (mutated) mutatedCount += 1;
    }
    return { idMap, mutatedCount };
}

function remapPlanIssueReferences(plan, idMap) {
    const remapArr = (arr) => (Array.isArray(arr) ? arr.map((id) => idMap.get(id) || id) : arr);
    plan.queue_order = remapArr(plan.queue_order);
    plan.promoted_ids = remapArr(plan.promoted_ids);
    plan.uncommitted_resolved = remapArr(plan.uncommitted_resolved);
    plan.deferred_ids = remapArr(plan.deferred_ids);
    if (plan.triage && Array.isArray(plan.triage.triaged_review_ids)) {
        plan.triage.triaged_review_ids = remapArr(plan.triage.triaged_review_ids);
    }
    for (const c of Object.values(plan.clusters || {})) {
        if (Array.isArray(c.issue_ids)) c.issue_ids = remapArr(c.issue_ids);
        for (const s of c.steps || []) {
            if (s && Array.isArray(s.issue_refs)) s.issue_refs = remapArr(s.issue_refs);
        }
    }
    if (plan.skipped && typeof plan.skipped === "object" && !Array.isArray(plan.skipped)) {
        for (const [oldId, newId] of idMap.entries()) {
            if (plan.skipped[oldId]) {
                plan.skipped[newId] = { ...plan.skipped[oldId], id: newId };
                delete plan.skipped[oldId];
            }
        }
    }
    if (plan.annotations && typeof plan.annotations === "object") {
        for (const [oldId, newId] of idMap.entries()) {
            if (plan.annotations[oldId]) {
                plan.annotations[newId] = plan.annotations[oldId];
                delete plan.annotations[oldId];
            }
        }
    }
}

/**
 * Remap issue IDs and file paths in `state.issues` and `plan` after `plexer health move`.
 * @param {object} state
 * @param {object} plan
 * @param {Map<string, string>} moveMap - oldRelPath -> newRelPath
 */
export function remapMovedIssuePaths(state, plan, moveMap) {
    if (!moveMap || moveMap.size === 0) return { remapped_count: 0, id_map: {} };
    const { idMap, mutatedCount } = remapStateIssueKeys(state, moveMap);
    if (idMap.size > 0 && plan && typeof plan === "object") {
        remapPlanIssueReferences(plan, idMap);
    }
    return {
        remapped_count: Math.max(mutatedCount, idMap.size),
        id_map: Object.fromEntries(idMap),
    };
}
