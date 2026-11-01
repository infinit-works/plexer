/**
 * Persistent state (`state.json`), living plan (`plan.json`), and configuration (`config.json`)
 * under `<contextDir>/.health/`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import {
    CONFIG_FILE,
    DEFAULT_TARGET_STRICT_SCORE,
    DETECTOR_CATEGORY,
    DETECTOR_STALE_DIMENSIONS,
    HEALTH_DIR,
    PLAN_FILE,
    STATE_FILE,
    normalizeDimensionKey,
} from "./constants.js";

export function healthDir(contextDir) {
    return join(contextDir, HEALTH_DIR);
}

export function stateFilePath(contextDir) {
    return join(healthDir(contextDir), STATE_FILE);
}

export function planFilePath(contextDir) {
    return join(healthDir(contextDir), PLAN_FILE);
}

export function configFilePath(contextDir) {
    return join(healthDir(contextDir), CONFIG_FILE);
}

export function emptyHealthConfig() {
    return {
        target_strict_score: DEFAULT_TARGET_STRICT_SCORE,
        issue_noise_budget: 10,
        issue_noise_global_budget: 0,
        commit_tracking_enabled: true,
        commit_pr: null,
        needs_rescan: false,
        layers: [],
        layer_rules: [],
        excludes: [],
        suppressions: {},
        zones: {},
        directives: {},
    };
}

export function loadHealthConfig(contextDir) {
    const raw = readJson(configFilePath(contextDir));
    if (!raw || typeof raw !== "object") return emptyHealthConfig();
    return {
        ...emptyHealthConfig(),
        ...raw,
        issue_noise_budget:
            typeof raw.issue_noise_budget === "number" ? raw.issue_noise_budget : 10,
        issue_noise_global_budget:
            typeof raw.issue_noise_global_budget === "number" ? raw.issue_noise_global_budget : 0,
        layers: Array.isArray(raw.layers)
            ? raw.layers
            : typeof raw.layers === "string"
              ? raw.layers
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
              : [],
        layer_rules: Array.isArray(raw.layer_rules) ? raw.layer_rules : [],
        excludes: Array.isArray(raw.excludes) ? raw.excludes : [],
        suppressions:
            raw.suppressions && typeof raw.suppressions === "object" ? raw.suppressions : {},
        zones: raw.zones && typeof raw.zones === "object" ? raw.zones : {},
        directives: raw.directives && typeof raw.directives === "object" ? raw.directives : {},
    };
}

export function saveHealthConfig(contextDir, config) {
    writeJsonAtomic(configFilePath(contextDir), config, true);
    return config;
}

export function emptyHealthState() {
    return {
        version: 1,
        scan_count: 0,
        last_scan_at: null,
        scan_path: ".",
        potentials: {},
        issues: {},
        subjective_assessments: {},
        dimension_contexts: {},
        concern_dismissals: {},
        review_cache: {},
        review_sessions: {},
        attestation_log: [],
        reminder_history: {},
        history: [],
    };
}

export function loadHealthState(contextDir) {
    const raw = readJson(stateFilePath(contextDir));
    if (!raw || typeof raw !== "object") return emptyHealthState();
    return {
        ...emptyHealthState(),
        ...raw,
        potentials: raw.potentials && typeof raw.potentials === "object" ? raw.potentials : {},
        issues: raw.issues && typeof raw.issues === "object" ? raw.issues : {},
        subjective_assessments:
            raw.subjective_assessments && typeof raw.subjective_assessments === "object"
                ? raw.subjective_assessments
                : {},
        dimension_contexts:
            raw.dimension_contexts && typeof raw.dimension_contexts === "object"
                ? raw.dimension_contexts
                : {},
        concern_dismissals:
            raw.concern_dismissals && typeof raw.concern_dismissals === "object"
                ? raw.concern_dismissals
                : {},
        review_cache:
            raw.review_cache && typeof raw.review_cache === "object" ? raw.review_cache : {},
        review_sessions:
            raw.review_sessions && typeof raw.review_sessions === "object"
                ? raw.review_sessions
                : {},
        attestation_log: Array.isArray(raw.attestation_log) ? raw.attestation_log : [],
        reminder_history:
            raw.reminder_history && typeof raw.reminder_history === "object"
                ? raw.reminder_history
                : {},
        history: Array.isArray(raw.history) ? raw.history : [],
    };
}

export function saveHealthState(contextDir, state) {
    writeJsonAtomic(stateFilePath(contextDir), state, true);
    return state;
}

export function emptyLivingPlan() {
    return {
        version: 1,
        scan_count_at_plan_start: 0,
        scan_count_at_last_resolve: 0,
        resolves_since_last_scan: 0,
        scan_gate_skipped: false,
        promoted_ids: [],
        policies: [],
        queue_order: [],
        clusters: {},
        skipped: {},
        annotations: {},
        focus_cluster: null,
        triage: {
            completed: false,
            strategy: null,
            triaged_review_ids: [],
            last_mechanical_count: 0,
            stages: {
                strategize: null,
                observe: null,
                reflect: null,
                organize: null,
                enrich: null,
                "sense-check": null,
                commit: null,
            },
        },
        uncommitted_resolved: [],
        commit_log: [],
        log: [],
    };
}

export function loadLivingPlan(contextDir) {
    const raw = readJson(planFilePath(contextDir));
    if (!raw || typeof raw !== "object") return emptyLivingPlan();
    const base = emptyLivingPlan();
    return {
        ...base,
        ...raw,
        promoted_ids: Array.isArray(raw.promoted_ids) ? raw.promoted_ids : [],
        policies: Array.isArray(raw.policies) ? raw.policies : [],
        queue_order: Array.isArray(raw.queue_order) ? raw.queue_order : [],
        clusters: raw.clusters && typeof raw.clusters === "object" ? raw.clusters : {},
        skipped: raw.skipped && typeof raw.skipped === "object" ? raw.skipped : {},
        annotations: raw.annotations && typeof raw.annotations === "object" ? raw.annotations : {},
        triage: {
            ...base.triage,
            ...(raw.triage && typeof raw.triage === "object" ? raw.triage : {}),
            stages: {
                ...base.triage.stages,
                ...(raw.triage?.stages && typeof raw.triage.stages === "object"
                    ? raw.triage.stages
                    : {}),
            },
        },
        uncommitted_resolved: Array.isArray(raw.uncommitted_resolved)
            ? raw.uncommitted_resolved
            : [],
        commit_log: Array.isArray(raw.commit_log) ? raw.commit_log : [],
        log: Array.isArray(raw.log) ? raw.log : [],
    };
}

export function saveLivingPlan(contextDir, plan) {
    writeJsonAtomic(planFilePath(contextDir), plan, true);
    return plan;
}

/**
 * Mint a deterministic issue ID (`<detector>::<file>::<identifier>`).
 */
export function mintIssueId(detector, file, identifier) {
    const cleanFile = (file || "repo").replace(/\\/g, "/");
    const cleanIdent = String(identifier || "item")
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_./:-]/g, "")
        .slice(0, 80);
    return `${detector}::${cleanFile}::${cleanIdent}`;
}

function markStaleSubjectiveAssessments(nextSubjective, nextIssues, changedIds, scanNum) {
    const newlyStaleDims = new Set();
    for (const id of changedIds) {
        const iss = nextIssues[id];
        if (!iss) continue;
        const linkedDims = DETECTOR_STALE_DIMENSIONS[iss.detector] || [];
        for (const dim of linkedDims) {
            for (const [k, v] of Object.entries(nextSubjective)) {
                if (normalizeDimensionKey(k) === dim && v && typeof v === "object") {
                    nextSubjective[k] = {
                        ...v,
                        stale: true,
                        stale_reason: `new_${iss.detector}_findings`,
                        stale_at_scan: scanNum,
                    };
                    newlyStaleDims.add(dim);
                }
            }
        }
    }
    return newlyStaleDims;
}

export const SUSPECT_DROP_THRESHOLD = 3;

/**
 * Check whether an issue or issue ID matches any configured suppression pattern or fingerprint.
 * Supports `*` wildcards (e.g. `detector::*::rule` matching `detector::path/to/file.js::rule`).
 */
export function isSuppressedByPatterns(issueOrId, suppressions) {
    if (!issueOrId || !suppressions) return false;
    const isObj = typeof issueOrId === "object";
    const id = isObj
        ? issueOrId.id ||
          mintIssueId(issueOrId.detector, issueOrId.file, issueOrId.identifier || issueOrId.line)
        : String(issueOrId);
    const idParts = id.split("::");
    const detector = isObj ? issueOrId.detector || idParts[0] || "" : idParts[0] || "";
    const file = isObj ? issueOrId.file || idParts[1] || "" : idParts[1] || "";
    const identifier = isObj ? issueOrId.identifier || idParts.slice(2).join("::") : idParts.slice(2).join("::");

    const entries =
        Array.isArray(suppressions) || suppressions instanceof Set
            ? [...suppressions].map((p) => (typeof p === "string" ? { pattern: p } : p))
            : typeof suppressions === "object"
              ? Object.entries(suppressions).map(([k, v]) =>
                    typeof v === "object" && v !== null ? { pattern: v.pattern || k, ...v } : { pattern: k },
                )
              : [];

    let issueFp = null;
    if (isObj && detector && (identifier || issueOrId.summary)) {
        issueFp = createHash("sha1")
            .update(`${detector}::${identifier || ""}::${issueOrId.summary || ""}`)
            .digest("hex")
            .slice(0, 12);
    }

    for (const entry of entries) {
        if (!entry) continue;
        const pat = String(entry.pattern || "").trim();
        if (!pat) continue;
        if (pat === id) return true;
        const exactRe = wildcardToRegExp(pat);
        if (exactRe.test(id)) return true;
        const substrRe = wildcardToRegExp(pat.includes("*") ? pat : `*${pat}*`);
        if (substrRe.test(id)) return true;
        if (!pat.includes("::") && (substrRe.test(file) || substrRe.test(identifier))) return true;
        if (issueFp && Array.isArray(entry.fingerprints) && entry.fingerprints.includes(issueFp)) {
            return true;
        }
    }
    return false;
}

function computeSuspectDetectors(prevIssues, detectedIssues, forceResolve = false, isScopedScan = false) {
    if (forceResolve || isScopedScan) return new Set();
    const prevOpenByDetector = new Map();
    for (const iss of Object.values(prevIssues || {})) {
        if (iss.detector === "review") continue;
        if (iss.status === "open" || iss.status === "deferred") {
            prevOpenByDetector.set(iss.detector, (prevOpenByDetector.get(iss.detector) || 0) + 1);
        }
    }
    const seenByDetector = new Map();
    for (const item of detectedIssues || []) {
        seenByDetector.set(item.detector, (seenByDetector.get(item.detector) || 0) + 1);
    }
    const suspectDetectors = new Set();
    for (const [det, prevCount] of prevOpenByDetector.entries()) {
        const currentCount = seenByDetector.get(det) || 0;
        if (prevCount >= SUSPECT_DROP_THRESHOLD && currentCount === 0) {
            suspectDetectors.add(det);
        }
    }
    return suspectDetectors;
}

function reconcileUnseenScanIssues(
    prevIssues,
    seenIds,
    scanNum,
    nextIssues,
    verifiedFixedIds,
    autoResolvedIds,
    suspectDetectors = new Set(),
    suspectHeldIds = [],
    resurfacedIds = [],
    reopenedIds = [],
    scannedCategories = null,
) {
    const catSet =
        scannedCategories instanceof Set
            ? scannedCategories
            : Array.isArray(scannedCategories)
              ? new Set(scannedCategories)
              : null;

    for (const [id, prev] of Object.entries(prevIssues)) {
        if (seenIds.has(id)) continue;
        if (prev.detector === "review") {
            nextIssues[id] = prev;
            continue;
        }
        const prevCat = prev.category || DETECTOR_CATEGORY[prev.detector] || null;
        if (catSet && prevCat && !catSet.has(prevCat)) {
            nextIssues[id] = prev;
            continue;
        }
        if (
            prev.status === "deferred" &&
            prev.resurface_after_scan !== undefined &&
            prev.resurface_after_scan !== null &&
            scanNum >= Number(prev.resurface_after_scan)
        ) {
            const nextReopenCount = (prev.reopen_count || 0) + 1;
            const resurfaced = {
                ...prev,
                status: "open",
                suspect_hold: false,
                reopen_count: nextReopenCount,
                reopened_at_scan: scanNum,
            };
            delete resurfaced.resurface_after_scan;
            nextIssues[id] = resurfaced;
            resurfacedIds.push(id);
            reopenedIds.push(id);
            continue;
        }
        if (prev.status === "fixed") {
            nextIssues[id] = {
                ...prev,
                suspect_hold: false,
                verified: true,
                verified_at_scan: prev.verified ? prev.verified_at_scan : scanNum,
            };
            if (!prev.verified) verifiedFixedIds.push(id);
        } else if (
            prev.status === "open" ||
            prev.status === "deferred" ||
            prev.status === "triaged_out" ||
            (prev.status === "wontfix" && !prev.suppressed)
        ) {
            if (suspectDetectors.has(prev.detector)) {
                nextIssues[id] = {
                    ...prev,
                    suspect_hold: true,
                    suspect_since_scan: prev.suspect_since_scan || scanNum,
                };
                suspectHeldIds.push(id);
            } else {
                nextIssues[id] = {
                    ...prev,
                    status: "auto_resolved",
                    suspect_hold: false,
                    verified: true,
                    verified_at_scan: scanNum,
                };
                autoResolvedIds.push(id);
            }
        } else {
            nextIssues[id] = prev;
        }
    }
}

/**
 * Append a longitudinal score entry to `state.history` (capped at 100 entries).
 */
export function appendScoreHistory(state, scores, event = "scan") {
    if (!Array.isArray(state.history)) state.history = [];
    const all = Object.values(state.issues || {});
    const openCount = all.filter((i) => i.status === "open" && !i.suppressed).length;
    const wontfixCount = all.filter((i) => i.status === "wontfix" || i.suppressed).length;
    state.history.push({
        scan_count: state.scan_count || 0,
        event,
        timestamp: new Date().toISOString(),
        strict: scores.strict,
        overall: scores.overall,
        objective: scores.objective,
        verified: scores.verified,
        open_count: openCount,
        wontfix_count: wontfixCount,
    });
    if (state.history.length > 100) {
        state.history = state.history.slice(-100);
    }
}

function upsertDetectedScanIssue(item, id, prev, scanNum, nextIssues, newIds, reopenedIds, resurfacedIds = [], suppressions = null) {
    const matchedSuppressed = suppressions ? isSuppressedByPatterns({ ...item, id }, suppressions) : false;
    if (!prev) {
        nextIssues[id] = {
            ...item,
            id,
            status: matchedSuppressed ? "wontfix" : "open",
            suppressed: matchedSuppressed,
            suspect_hold: false,
            verified: false,
            reopen_count: 0,
            first_seen_scan: scanNum,
            last_seen_scan: scanNum,
            note: null,
            attestation: null,
        };
        if (!matchedSuppressed) newIds.push(id);
    } else if (prev.status === "fixed" || prev.status === "auto_resolved") {
        nextIssues[id] = {
            ...prev,
            ...item,
            id,
            status: "open",
            suspect_hold: false,
            verified: false,
            reopen_count: (prev.reopen_count || 0) + 1,
            last_seen_scan: scanNum,
            reopened_at_scan: scanNum,
        };
        reopenedIds.push(id);
    } else if (
        prev.status === "deferred" &&
        prev.resurface_after_scan !== undefined &&
        prev.resurface_after_scan !== null &&
        scanNum >= Number(prev.resurface_after_scan)
    ) {
        const resurfaced = {
            ...prev,
            ...item,
            id,
            status: "open",
            suspect_hold: false,
            verified: false,
            reopen_count: (prev.reopen_count || 0) + 1,
            last_seen_scan: scanNum,
            reopened_at_scan: scanNum,
        };
        delete resurfaced.resurface_after_scan;
        nextIssues[id] = resurfaced;
        reopenedIds.push(id);
        resurfacedIds.push(id);
    } else {
        const isSupp = Boolean(prev.suppressed || matchedSuppressed);
        nextIssues[id] = {
            ...prev,
            ...item,
            id,
            status: isSupp ? "wontfix" : prev.status,
            suspect_hold: false,
            suppressed: isSupp,
            last_seen_scan: scanNum,
        };
    }
}

/**
 * Reconcile newly detected issues against `state.issues`, applying suspect detector protection,
 * chronic reopener tracking (`reopen_count`), `--review-after <N>` auto-resurface, and wildcard suppressions.
 */
export function reconcileIssues(state, detectedIssues = [], scannedCategories = null, opts = {}) {
    if (
        scannedCategories &&
        typeof scannedCategories === "object" &&
        !Array.isArray(scannedCategories) &&
        !(scannedCategories instanceof Set)
    ) {
        opts = scannedCategories;
        scannedCategories = null;
    }

    const prevIssues = state.issues || {};
    const nextIssues = {};
    const newIds = [];
    const autoResolvedIds = [];
    const reopenedIds = [];
    const verifiedFixedIds = [];
    const suspectHeldIds = [];
    const resurfacedIds = [];
    const seenIds = new Set();

    const scanNum = Number(opts.scanNum ?? state.scan_count ?? 1);
    const suppressions = opts.suppressions || state.suppressions || null;

    for (const item of detectedIssues || []) {
        const id = item.id || mintIssueId(item.detector, item.file, item.identifier || item.line);
        seenIds.add(id);
        upsertDetectedScanIssue(
            item,
            id,
            prevIssues[id],
            scanNum,
            nextIssues,
            newIds,
            reopenedIds,
            resurfacedIds,
            suppressions,
        );
    }

    const suspectDetectors = computeSuspectDetectors(
        prevIssues,
        detectedIssues,
        Boolean(opts.forceResolve),
        Boolean(opts.isScopedScan),
    );
    reconcileUnseenScanIssues(
        prevIssues,
        seenIds,
        scanNum,
        nextIssues,
        verifiedFixedIds,
        autoResolvedIds,
        suspectDetectors,
        suspectHeldIds,
        resurfacedIds,
        reopenedIds,
        scannedCategories,
    );

    state.issues = nextIssues;
    return {
        issues: nextIssues,
        suspectDetectors: [...suspectDetectors],
        suspect_detectors: [...suspectDetectors],
        suspectSkipped: suspectDetectors.size > 0,
        newIds,
        newCount: newIds.length,
        autoResolvedIds,
        autoResolvedCount: autoResolvedIds.length,
        verifiedFixedIds,
        reopenedIds,
        reopenedCount: reopenedIds.length,
        suspectHeldIds,
        resurfacedIds,
        resurfacedCount: resurfacedIds.length,
    };
}

/**
 * Merge newly detected mechanical issues into persistent `state`, computing the scan diff
 * (`newIssues`, `autoResolved`, `reopened`, `remainingOpen`, `suspectHeld`) and updating scan counters.
 */
export function mergeScanIntoState(state, detectedIssues, potentials, plan, opts = {}) {
    const scanNum = (state.scan_count || 0) + 1;
    const nowIso = new Date().toISOString();

    const rec = reconcileIssues({ ...state, scan_count: scanNum }, detectedIssues, opts.scannedCategories || null, {
        ...opts,
        scanNum,
    });
    const nextIssues = rec.issues;
    const { newIds, autoResolvedIds, reopenedIds, verifiedFixedIds, suspectHeldIds, suspectDetectors, resurfacedIds } = rec;

    const nextSubjective = opts.resetSubjective
        ? {}
        : { ...(state.subjective_assessments || {}) };
    const newlyStaleDims =
        !opts.resetSubjective && (newIds.length > 0 || reopenedIds.length > 0)
            ? markStaleSubjectiveAssessments(nextSubjective, nextIssues, [...newIds, ...reopenedIds], scanNum)
            : new Set();

    const nextState = {
        ...state,
        scan_count: scanNum,
        last_scan_at: nowIso,
        scan_path: opts.scanPath || state.scan_path || ".",
        potentials: { ...(state.potentials || {}), ...potentials },
        issues: nextIssues,
        subjective_assessments: nextSubjective,
    };

    if (plan) {
        plan.resolves_since_last_scan = 0;
        if (!plan.scan_count_at_plan_start) plan.scan_count_at_plan_start = scanNum;
    }

    const openCount = Object.values(nextIssues).filter((i) => i.status === "open" && !i.suppressed).length;
    return {
        state: nextState,
        diff: {
            scan_count: scanNum,
            new_count: newIds.length,
            auto_resolved_count: autoResolvedIds.length,
            verified_fixed_count: verifiedFixedIds.length,
            reopened_count: reopenedIds.length,
            resurfaced_count: resurfacedIds.length,
            suspect_held_count: suspectHeldIds.length,
            open_count: openCount,
            new_ids: newIds,
            auto_resolved_ids: autoResolvedIds,
            verified_fixed_ids: verifiedFixedIds,
            reopened_ids: reopenedIds,
            resurfaced_ids: resurfacedIds,
            suspect_held_ids: suspectHeldIds,
            suspect_detectors: suspectDetectors,
            stale_dimensions: [...newlyStaleDims],
        },
    };
}

/**
 * Inspect git context (`available`, `branch`, `head_sha`, `head_subject`, `has_uncommitted`).
 */
export function detectGitContext(rootDir) {
    try {
        const headSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        let branch = "";
        try {
            branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                cwd: rootDir,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (branch === "HEAD") branch = "";
        } catch {
            // Detached HEAD
        }
        let headSubject = "";
        try {
            headSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
                cwd: rootDir,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
        } catch {
            // Ignore
        }
        let hasUncommitted = false;
        try {
            const porcelain = execFileSync("git", ["status", "--porcelain"], {
                cwd: rootDir,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            hasUncommitted = porcelain.length > 0;
        } catch {
            // Ignore
        }
        return {
            available: true,
            branch: branch || null,
            head_sha: headSha || "HEAD",
            head_subject: headSubject || "",
            has_uncommitted: hasUncommitted,
        };
    } catch {
        return {
            available: false,
            branch: null,
            head_sha: "HEAD",
            head_subject: "",
            has_uncommitted: false,
        };
    }
}

/**
 * Generate a Markdown PR body summarizing commit-tracked resolutions and score progression.
 */
export function generateCommitLogPrBody(plan, state, scores = null) {
    const commitLog = Array.isArray(plan?.commit_log) ? plan.commit_log : [];
    const uncommitted = Array.isArray(plan?.uncommitted_resolved) ? plan.uncommitted_resolved : [];
    const issues = state?.issues || {};
    const history = Array.isArray(state?.history) ? state.history : [];

    const lines = ["## `plexer health` Quality Report", ""];

    if (scores) {
        const firstEntry = history.length > 0 ? history[0] : null;
        const deltaStr =
            firstEntry && typeof firstEntry.strict === "number"
                ? ` (${scores.strict - firstEntry.strict >= 0 ? "+" : ""}${(scores.strict - firstEntry.strict).toFixed(1)} vs baseline ${firstEntry.strict.toFixed(1)}%)`
                : "";
        lines.push("| Metric | Score |");
        lines.push("| :--- | :--- |");
        lines.push(`| **Strict Score (North Star)** | **${scores.strict.toFixed(1)}%**${deltaStr} |`);
        lines.push(`| Overall (Lenient) | ${scores.overall.toFixed(1)}% |`);
        lines.push(`| Objective (Mechanical) | ${scores.objective.toFixed(1)}% |`);
        lines.push(`| Verified | ${scores.verified.toFixed(1)}% |`);
        lines.push("");
    }

    const committedIds = commitLog.flatMap((r) => r.issue_ids || []);
    const allTrackedIds = [...new Set([...committedIds, ...uncommitted])];

    lines.push(
        `### Resolved Findings (${allTrackedIds.length} total: ${committedIds.length} committed, ${uncommitted.length} uncommitted)`,
    );
    lines.push("");

    if (allTrackedIds.length === 0) {
        lines.push("_No resolved findings recorded yet._");
        lines.push("");
    } else {
        const byDetector = new Map();
        for (const id of allTrackedIds) {
            const iss = issues[id];
            const det = iss?.detector || id.split("::")[0] || "other";
            if (!byDetector.has(det)) byDetector.set(det, []);
            byDetector.get(det).push({ id, iss });
        }
        for (const [det, list] of byDetector.entries()) {
            lines.push(`- **\`${det}\`** (${list.length}):`);
            for (const { id, iss } of list.slice(0, 10)) {
                const desc = iss ? `${iss.file}:${iss.span || "L1"} — ${iss.summary}` : id;
                lines.push(`  - \`${id}\`: ${desc}`);
            }
            if (list.length > 10) {
                lines.push(`  - _...and ${list.length - 10} more_`);
            }
        }
        lines.push("");
    }

    if (commitLog.length > 0) {
        lines.push("### Commit Log");
        lines.push("");
        lines.push("| Commit | Branch | Issues | Note |");
        lines.push("| :--- | :--- | :---: | :--- |");
        for (const rec of commitLog) {
            const sha = rec.commit || rec.sha || "?";
            const branch = rec.branch || "—";
            const count = Array.isArray(rec.issue_ids) ? rec.issue_ids.length : 0;
            const note = rec.note || rec.subject || "—";
            lines.push(`| \`${sha}\` | \`${branch}\` | ${count} | ${note} |`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * Record a git commit against `plan.uncommitted_resolved` (`plexer health plan commit-log record`).
 */
export function recordCommitLog(rootDir, plan, opts = {}, state = null, config = null, scores = null) {
    const git = detectGitContext(rootDir);
    const headSha = opts.sha || git.head_sha || "HEAD";
    const branch = opts.branch || git.branch || null;
    const headSubject = git.head_subject || "";

    const uncommitted = Array.isArray(plan.uncommitted_resolved) ? plan.uncommitted_resolved : [];
    const onlyFilter = opts.only ? wildcardToRegExp(opts.only) : null;
    const recorded = [];
    const remaining = [];
    for (const id of uncommitted) {
        if (!onlyFilter || onlyFilter.test(id)) {
            recorded.push(id);
        } else {
            remaining.push(id);
        }
    }

    const nowIso = new Date().toISOString();
    const entry = {
        commit: headSha,
        sha: headSha,
        branch,
        subject: headSubject,
        note: opts.note || null,
        issue_ids: recorded,
        recorded_at: nowIso,
    };
    plan.uncommitted_resolved = remaining;
    plan.commit_log = [...(plan.commit_log || []), entry];
    if (!Array.isArray(plan.log)) plan.log = [];
    plan.log.push({
        action: "commit_record",
        timestamp: nowIso,
        issue_ids: recorded,
        note: opts.note || null,
        detail: { sha: headSha, branch },
    });

    let prUpdated = false;
    const prNumber = config?.commit_pr;
    if (prNumber && config?.commit_tracking_enabled !== false && recorded.length > 0) {
        try {
            const prBody = generateCommitLogPrBody(plan, state, scores);
            execFileSync("gh", ["pr", "edit", String(prNumber), "--body", prBody], {
                cwd: rootDir,
                stdio: ["ignore", "pipe", "ignore"],
            });
            prUpdated = true;
        } catch {
            // Best-effort if gh is not installed or unauthenticated
        }
    }

    return { ...entry, pr_updated: prUpdated, commit_pr: prNumber || null };
}

export function wildcardToRegExp(pattern) {
    const escaped = String(pattern)
        .replace(/\*+/g, "*")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}
