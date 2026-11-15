/**
 * Persistent state (`state.json`), living plan (`plan.json`), and configuration (`config.json`)
 * under `<contextDir>/.health/`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/state.js";
import {
    CONFIG_FILE,
    DEFAULT_TARGET_STRICT_SCORE,
    DETECTOR_CATEGORY,
    DETECTOR_STALE_DIMENSIONS,
    HEALTH_DIR,
    PLAN_FILE,
    SCORE_MODEL_VERSION,
    STATE_FILE,
    SUBJECTIVE_DIMENSIONS,
    normalizeDimensionKey,
} from "./constants.js";
import { cleanupStaleDismissals } from "./concerns.js";

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

function backupCorruptHealthFile(p, label) {
    try {
        copyFileSync(p, `${p}.corrupt`);
        if (process.env.PLEXER_QUIET !== "1") {
            process.stderr.write(`[plexer health] corrupt ${label} backed up to ${p}.corrupt; resetting to defaults\n`);
        }
    } catch (err) {
        if (process.env.PLEXER_QUIET !== "1") {
            process.stderr.write(`[plexer health] corrupt ${label} at ${p} (${err?.code || "backup_failed"}); resetting to defaults\n`);
        }
    }
}

export function loadHealthConfig(contextDir) {
    const p = configFilePath(contextDir);
    if (!existsSync(p)) return emptyHealthConfig();
    const raw = readJson(p);
    if (!raw || typeof raw !== "object") {
        backupCorruptHealthFile(p, "config.json");
        return emptyHealthConfig();
    }
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
        score_model: SCORE_MODEL_VERSION,
        scan_count: 0,
        last_scan_at: null,
        last_scan_fingerprint: null,
        scan_path: ".",
        potentials: {},
        issues: {},
        ignore_integrity: {
            ignored_count: 0,
            suppressed_pct: 0,
            ignored_by_detector: {},
        },
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
    const p = stateFilePath(contextDir);
    if (!existsSync(p)) return emptyHealthState();
    const raw = readJson(p);
    if (!raw || typeof raw !== "object") {
        backupCorruptHealthFile(p, "state.json");
        return emptyHealthState();
    }
    return {
        ...emptyHealthState(),
        ...raw,
        potentials: raw.potentials && typeof raw.potentials === "object" ? raw.potentials : {},
        issues: raw.issues && typeof raw.issues === "object" ? raw.issues : {},
        ignore_integrity:
            raw.ignore_integrity && typeof raw.ignore_integrity === "object"
                ? raw.ignore_integrity
                : { ignored_count: 0, suppressed_pct: 0, ignored_by_detector: {} },
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
    const p = planFilePath(contextDir);
    if (!existsSync(p)) return emptyLivingPlan();
    const raw = readJson(p);
    if (!raw || typeof raw !== "object") {
        backupCorruptHealthFile(p, "plan.json");
        return emptyLivingPlan();
    }
    const base = emptyLivingPlan();
    const clusters = raw.clusters && typeof raw.clusters === "object" ? { ...raw.clusters } : {};
    for (const c of Object.values(clusters)) {
        if (c && typeof c === "object" && "_zeroBasedSteps" in c) {
            delete c._zeroBasedSteps;
        }
    }
    return {
        ...base,
        ...raw,
        promoted_ids: Array.isArray(raw.promoted_ids) ? raw.promoted_ids : [],
        policies: Array.isArray(raw.policies) ? raw.policies : [],
        queue_order: Array.isArray(raw.queue_order) ? raw.queue_order : [],
        clusters,
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
 * Compute both exact and line-normalized 12-char SHA-1 fingerprints for an issue.
 */
export function computeIssueFingerprints(detector, identifier, summary) {
    const det = String(detector || "");
    const idStr = String(identifier || "");
    const sumStr = String(summary || "");
    const exact = createHash("sha1")
        .update(`${det}::${idStr}::${sumStr}`)
        .digest("hex")
        .slice(0, 12);
    const normId = idStr.replace(/(?:\b|_)?L\d+(?:-L?\d+)?\b/g, "");
    const normSum = sumStr.replace(/(?:\b|_)?L\d+(?:-L?\d+)?\b/g, "");
    const norm = createHash("sha1")
        .update(`${det}::${normId}::${normSum}`)
        .digest("hex")
        .slice(0, 12);
    return exact === norm ? [exact] : [exact, norm];
}

/**
 * Find the matching suppression rule entry for an issue or issue ID, or `null` if unmatched.
 * Supports `*` wildcards (e.g. `detector::*::rule` matching `detector::path/to/file.js::rule`).
 */
function parseSuppressionTarget(issueOrId) {
    const isObj = typeof issueOrId === "object";
    const id = isObj
        ? issueOrId.id ||
          mintIssueId(issueOrId.detector, issueOrId.file, issueOrId.identifier || issueOrId.line)
        : String(issueOrId);
    const idParts = id.split("::");
    const detector = isObj ? issueOrId.detector || idParts[0] || "" : idParts[0] || "";
    const file = isObj ? issueOrId.file || idParts[1] || "" : idParts[1] || "";
    const identifier = isObj ? issueOrId.identifier || idParts.slice(2).join("::") : idParts.slice(2).join("::");
    const issueFps =
        isObj && detector && (identifier || issueOrId.summary)
            ? computeIssueFingerprints(detector, identifier, issueOrId.summary)
            : [];
    return { id, file, identifier, issueFps };
}

function normalizeSuppressionEntries(suppressions) {
    if (Array.isArray(suppressions) || suppressions instanceof Set) {
        return [...suppressions].map((p) => (typeof p === "string" ? { pattern: p } : p));
    }
    if (typeof suppressions === "object") {
        return Object.entries(suppressions).map(([k, v]) =>
            typeof v === "object" && v !== null ? { pattern: v.pattern || k, ...v } : { pattern: k },
        );
    }
    return [];
}

function suppressionEntryMatchesTarget(entry, { id, file, identifier, issueFps }) {
    if (!entry) return false;
    const pat = String(entry.pattern || "").trim();
    if (!pat) return false;
    if (pat === id || wildcardToRegExp(pat).test(id)) return true;
    if (!pat.includes("::") || pat.includes("*")) {
        const substrRe = wildcardToRegExp(pat.includes("*") ? pat : `*${pat}*`);
        if (substrRe.test(id)) return true;
        if (!pat.includes("::") && (substrRe.test(file) || substrRe.test(identifier))) return true;
    }
    if (issueFps.length > 0 && Array.isArray(entry.fingerprints) && issueFps.some((fp) => entry.fingerprints.includes(fp))) {
        return true;
    }
    if (Array.isArray(entry.fingerprints) && pat.includes("::")) {
        const normPat = pat.replace(/(?:\b|_)?L\d+(?:-L?\d+)?\b/g, "");
        const normId = id.replace(/(?:\b|_)?L\d+(?:-L?\d+)?\b/g, "");
        return Boolean(normPat && normPat === normId);
    }
    return false;
}

export function findMatchingSuppressionEntry(issueOrId, suppressions) {
    if (!issueOrId || !suppressions) return null;
    const target = parseSuppressionTarget(issueOrId);
    for (const entry of normalizeSuppressionEntries(suppressions)) {
        if (suppressionEntryMatchesTarget(entry, target)) return entry;
    }
    return null;
}

/**
 * Check whether an issue or issue ID matches any configured suppression pattern or fingerprint.
 */
export function isSuppressedByPatterns(issueOrId, suppressions) {
    return Boolean(findMatchingSuppressionEntry(issueOrId, suppressions));
}

function toScopeSet(val) {
    if (!val) return null;
    if (val instanceof Set || Array.isArray(val)) {
        const s = new Set([...val].map((x) => String(x).toLowerCase().replace(/-/g, "_")));
        return s.size > 0 ? s : null;
    }
    return null;
}

function matchesFileFilter(file, fileFilter) {
    if (!fileFilter || !file || file === "repo") return true;
    const norm = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
    if (typeof fileFilter === "function") return Boolean(fileFilter(norm));
    const set =
        fileFilter instanceof Set
            ? fileFilter
            : Array.isArray(fileFilter)
              ? new Set(fileFilter)
              : null;
    if (!set || set.size === 0) return true;
    if (set.has(norm) || set.has(file)) return true;
    for (const entry of set) {
        const clean = String(entry).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        if (clean && (norm === clean || norm.startsWith(`${clean}/`))) return true;
    }
    return false;
}

function isIssueInScanScope(prev, catSet = null, detSet = null, fileFilter = null) {
    const prevDet = String(prev.detector || "").toLowerCase().replace(/-/g, "_");
    const prevCat = String(prev.category || DETECTOR_CATEGORY[prevDet] || "").toLowerCase();
    if (catSet && catSet.size > 0 && !catSet.has(prevCat) && !catSet.has(DETECTOR_CATEGORY[prevDet])) {
        return false;
    }
    if (detSet && detSet.size > 0 && !detSet.has(prevDet) && !detSet.has(prevCat)) {
        return false;
    }
    if (fileFilter && prev.file && prev.file !== "repo" && !matchesFileFilter(prev.file, fileFilter)) {
        return false;
    }
    return true;
}

function computeSuspectDetectors(
    prevIssues,
    detectedIssues,
    forceResolve = false,
    isScopedScan = false,
    catSet = null,
    detSet = null,
    fileFilter = null,
) {
    if (forceResolve || isScopedScan) return new Set();
    const prevOpenByDetector = new Map();
    for (const iss of Object.values(prevIssues || {})) {
        if (iss.detector === "review") continue;
        if (!isIssueInScanScope(iss, catSet, detSet, fileFilter)) continue;
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

const UNSEEN_ACTIVE_STATUSES = new Set(["open", "deferred", "triaged_out", "wontfix"]);

function resurfaceExpiredDeferredIssue(prev, scanNum) {
    const resurfaced = {
        ...prev,
        status: "open",
        suspect_hold: false,
        reopen_count: (prev.reopen_count || 0) + 1,
        reopened_at_scan: scanNum,
    };
    delete resurfaced.resurface_after_scan;
    return resurfaced;
}

function resolveMissingSeenIssueTransition(id, prev, scanNum, suspectDetectors, suppressionLedger, out) {
    if (
        prev.status === "deferred" &&
        prev.resurface_after_scan !== undefined &&
        prev.resurface_after_scan !== null &&
        scanNum >= Number(prev.resurface_after_scan)
    ) {
        out.nextIssues[id] = resurfaceExpiredDeferredIssue(prev, scanNum);
        out.resurfacedIds.push(id);
        out.reopenedIds.push(id);
        return;
    }
    const suppressedByKind = suppressionLedger?.matchIssue?.(prev) || null;
    if (suppressedByKind && UNSEEN_ACTIVE_STATUSES.has(prev.status)) {
        out.nextIssues[id] = {
            ...prev,
            status: "wontfix",
            suppressed: true,
            suppressed_by: suppressedByKind,
            suspect_hold: false,
            verified: false,
            suppressed_at_scan: scanNum,
        };
        out.suppressedIds.push(id);
        return;
    }
    if (prev.status === "fixed") {
        out.nextIssues[id] = {
            ...prev,
            suspect_hold: false,
            verified: true,
            verified_at_scan: prev.verified ? prev.verified_at_scan : scanNum,
        };
        if (!prev.verified) out.verifiedFixedIds.push(id);
        return;
    }
    if (!UNSEEN_ACTIVE_STATUSES.has(prev.status)) {
        out.nextIssues[id] = prev;
        return;
    }
    if (suspectDetectors.has(prev.detector)) {
        out.nextIssues[id] = {
            ...prev,
            suspect_hold: true,
            suspect_since_scan: prev.suspect_since_scan || scanNum,
        };
        out.suspectHeldIds.push(id);
        return;
    }
    out.nextIssues[id] = {
        ...prev,
        status: "auto_resolved",
        suppressed: false,
        suspect_hold: false,
        verified: true,
        verified_at_scan: scanNum,
    };
    out.autoResolvedIds.push(id);
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
    suppressionLedger = null,
    suppressedIds = [],
    scannedDetectors = null,
    fileFilter = null,
) {
    const catSet = toScopeSet(scannedCategories);
    const detSet = toScopeSet(scannedDetectors);
    const out = { nextIssues, verifiedFixedIds, autoResolvedIds, suspectHeldIds, resurfacedIds, reopenedIds, suppressedIds };

    for (const [id, prev] of Object.entries(prevIssues)) {
        if (seenIds.has(id)) continue;
        if (prev.detector === "review" || !isIssueInScanScope(prev, catSet, detSet, fileFilter)) {
            nextIssues[id] = prev;
            continue;
        }
        resolveMissingSeenIssueTransition(id, prev, scanNum, suspectDetectors, suppressionLedger, out);
    }
}

/**
 * Append a longitudinal score entry to `state.history` (capped at 100 entries).
 */
export function appendScoreHistory(state, scores, event = "scan") {
    if (!Array.isArray(state.history)) state.history = [];
    const all = Object.values(state.issues || {});
    const openCount = all.filter((i) => i.status === "open" && !i.suppressed).length;
    const wontfixCount = all.filter(
        (i) => i.status === "wontfix" || (i.suppressed && i.status !== "false_positive"),
    ).length;
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

function buildNewScanIssue(item, id, scanNum, matchedEntry) {
    const matchedSuppressed = Boolean(matchedEntry);
    const suppressedStatus = matchedEntry?.kind === "false_positive" ? "false_positive" : "wontfix";
    return {
        ...item,
        id,
        status: matchedSuppressed ? suppressedStatus : "open",
        suppressed: matchedSuppressed,
        suspect_hold: false,
        verified: false,
        reopen_count: 0,
        first_seen_scan: scanNum,
        last_seen_scan: scanNum,
        note: matchedSuppressed ? matchedEntry?.note || null : null,
        attestation: matchedSuppressed ? matchedEntry?.attestation || null : null,
        ...(matchedSuppressed && matchedEntry?.reason ? { reason: matchedEntry.reason } : {}),
    };
}

function buildReopenedScanIssue(item, id, prev, scanNum) {
    return {
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
}

function upsertDetectedScanIssue(item, id, prev, scanNum, nextIssues, newIds, reopenedIds, resurfacedIds = [], suppressions = null) {
    const matchedEntry = suppressions ? findMatchingSuppressionEntry({ ...item, id }, suppressions) : null;
    if (!prev) {
        nextIssues[id] = buildNewScanIssue(item, id, scanNum, matchedEntry);
        if (!matchedEntry) newIds.push(id);
        return;
    }
    if (matchedEntry) {
        nextIssues[id] = {
            ...prev,
            ...item,
            id,
            status: prev.status === "false_positive" || matchedEntry.kind === "false_positive" ? "false_positive" : "wontfix",
            suspect_hold: false,
            suppressed: true,
            last_seen_scan: scanNum,
            ...(matchedEntry.reason && !prev.reason ? { reason: matchedEntry.reason } : {}),
        };
        return;
    }
    if (prev.status === "fixed" || prev.status === "auto_resolved") {
        nextIssues[id] = buildReopenedScanIssue(item, id, prev, scanNum);
        reopenedIds.push(id);
        return;
    }
    const shouldResurface = prev.status === "deferred" && prev.resurface_after_scan !== undefined && prev.resurface_after_scan !== null && scanNum >= Number(prev.resurface_after_scan);
    if (shouldResurface) {
        const resurfaced = buildReopenedScanIssue(item, id, prev, scanNum);
        delete resurfaced.resurface_after_scan;
        nextIssues[id] = resurfaced;
        reopenedIds.push(id);
        resurfacedIds.push(id);
        return;
    }
    const isSupp = Boolean(prev.suppressed);
    nextIssues[id] = {
        ...prev,
        ...item,
        id,
        status: isSupp ? (prev.status === "false_positive" ? "false_positive" : "wontfix") : prev.status,
        suspect_hold: false,
        suppressed: isSupp,
        last_seen_scan: scanNum,
    };
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
    const suppressedIds = [];
    const seenIds = new Set();

    const scanNum = Number(opts.scanNum ?? state.scan_count ?? 1);
    const suppressions = opts.suppressions || state.suppressions || null;
    const suppressionLedger = opts.suppressionLedger || null;
    const activeCategories = scannedCategories || opts.scannedCategories || null;
    const activeDetectors = opts.scannedDetectors || null;
    const fileFilter = opts.fileFilter || null;

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
        Boolean(opts.isScopedScan || fileFilter),
        toScopeSet(activeCategories),
        toScopeSet(activeDetectors),
        fileFilter,
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
        activeCategories,
        suppressionLedger,
        suppressedIds,
        activeDetectors,
        fileFilter,
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
        suppressedIds,
        suppressedCount: suppressedIds.length,
    };
}

function mergeScanPotentials(prevPotentials = {}, newPotentials = {}, opts = {}) {
    const base = { ...(prevPotentials || {}) };
    const incoming = newPotentials || {};
    if (opts.isEphemeral || opts.isScopedScan) {
        return { ...base, ...incoming };
    }
    const catSet = toScopeSet(opts.scannedCategories);
    const detSet = toScopeSet(opts.scannedDetectors);
    const hasFileFilter = Boolean(opts.fileFilter);
    if (!catSet && !detSet && !hasFileFilter) {
        return { ...base, ...incoming };
    }
    for (const [k, val] of Object.entries(incoming)) {
        const detKey = String(k || "").toLowerCase().replace(/-/g, "_");
        const detCat = String(DETECTOR_CATEGORY[detKey] || "").toLowerCase();
        if (catSet && !catSet.has(detCat) && !catSet.has(detKey)) continue;
        if (detSet && !detSet.has(detKey) && !detSet.has(detCat)) continue;
        const numVal = Number(val || 0);
        base[k] = hasFileFilter ? Math.max(Number(base[k] || 0), numVal) : numVal;
    }
    return base;
}

function computeScanFingerprint(detectedIssues, potentials, ignoreSummary, opts = {}) {
    const keys = (detectedIssues || [])
        .map((d) => `${d.id || `${d.detector}::${d.file}::${d.identifier || d.line}`}@${d.span || ""}`)
        .sort();
    const payload = JSON.stringify({
        gitHead: opts.gitHead || opts.head_sha || null,
        dirty: opts.dirty ?? null,
        keys,
        potentials: potentials || {},
        ignored: ignoreSummary?.ignored_count || 0,
        ignoredByDetector: ignoreSummary?.ignored_by_detector || {},
        suppressions: opts.suppressions || [],
    });
    return createHash("sha1").update(payload, "utf8").digest("hex");
}

function buildNoopScanResult(state, prevScanCount, nowIso, ignoreSummary) {
    const openCount = Object.values(state.issues || {}).filter(
        (i) => i.status === "open" && !i.suppressed,
    ).length;
    return {
        state: {
            ...state,
            last_scan_at: nowIso,
            ignore_integrity: ignoreSummary,
        },
        diff: {
            noop: true,
            scan_count: prevScanCount,
            new_count: 0,
            auto_resolved_count: 0,
            verified_fixed_count: 0,
            reopened_count: 0,
            resurfaced_count: 0,
            suppressed_count: 0,
            suspect_held_count: 0,
            open_count: openCount,
            new_ids: [],
            auto_resolved_ids: [],
            verified_fixed_ids: [],
            reopened_ids: [],
            resurfaced_ids: [],
            suppressed_ids: [],
            suspect_held_ids: [],
            suspect_detectors: [],
            stale_dimensions: [],
        },
    };
}

function buildActiveScanDiff(scanNum, nextIssues, rec, newlyStaleDims) {
    const openCount = Object.values(nextIssues).filter((i) => i.status === "open" && !i.suppressed).length;
    return {
        noop: false,
        scan_count: scanNum,
        new_count: rec.newIds.length,
        auto_resolved_count: rec.autoResolvedIds.length,
        verified_fixed_count: rec.verifiedFixedIds.length,
        reopened_count: rec.reopenedIds.length,
        resurfaced_count: rec.resurfacedIds.length,
        suppressed_count: rec.suppressedIds.length,
        suspect_held_count: rec.suspectHeldIds.length,
        open_count: openCount,
        new_ids: rec.newIds,
        auto_resolved_ids: rec.autoResolvedIds,
        verified_fixed_ids: rec.verifiedFixedIds,
        reopened_ids: rec.reopenedIds,
        resurfaced_ids: rec.resurfacedIds,
        suppressed_ids: rec.suppressedIds,
        suspect_held_ids: rec.suspectHeldIds,
        suspect_detectors: rec.suspectDetectors,
        stale_dimensions: [...newlyStaleDims],
    };
}

/**
 * Merge newly detected mechanical issues into persistent `state`, computing the scan diff
 * (`newIssues`, `autoResolved`, `reopened`, `remainingOpen`, `suspectHeld`) and updating scan counters.
 */
export function mergeScanIntoState(state, detectedIssues, potentials, plan, opts = {}) {
    const prevScanCount = state.scan_count || 0;
    const scanNum = prevScanCount + 1;
    const nowIso = new Date().toISOString();
    const ignoreSummary = opts.suppressionLedger
        ? opts.suppressionLedger.summary((detectedIssues || []).length)
        : state.ignore_integrity || { ignored_count: 0, suppressed_pct: 0, ignored_by_detector: {} };
    const fingerprint = computeScanFingerprint(detectedIssues, potentials, ignoreSummary, opts);

    const rec = reconcileIssues({ ...state, scan_count: scanNum }, detectedIssues, opts.scannedCategories || null, {
        ...opts,
        scanNum,
    });
    const nextIssues = rec.issues;
    const transitions =
        rec.newIds.length +
        rec.autoResolvedIds.length +
        rec.reopenedIds.length +
        rec.verifiedFixedIds.length +
        rec.suspectHeldIds.length +
        rec.resurfacedIds.length +
        rec.suppressedIds.length;
    const hasPendingDeferredResurface = Object.values(state.issues || {}).some(
        (i) => i.status === "deferred" && i.resurface_after_scan !== undefined && i.resurface_after_scan !== null,
    );

    if (
        !opts.force &&
        !opts.forceResolve &&
        !opts.resetSubjective &&
        prevScanCount > 0 &&
        state.last_scan_fingerprint &&
        state.last_scan_fingerprint === fingerprint &&
        transitions === 0 &&
        !hasPendingDeferredResurface
    ) {
        if (plan) {
            plan.resolves_since_last_scan = 0;
            if (!plan.scan_count_at_plan_start) plan.scan_count_at_plan_start = prevScanCount;
        }
        return buildNoopScanResult(state, prevScanCount, nowIso, ignoreSummary);
    }

    const nextSubjective = { ...(state.subjective_assessments || {}) };
    if (opts.resetSubjective) {
        for (const sDef of Object.values(SUBJECTIVE_DIMENSIONS)) {
            if (sDef.reset_on_scan !== false && nextSubjective[sDef.id]) {
                nextSubjective[sDef.id] = {
                    score: 0,
                    placeholder: true,
                    reset_by: "scan_reset_subjective",
                    updated_at: nowIso,
                };
            }
        }
    }
    const newlyStaleDims =
        !opts.resetSubjective && (rec.newIds.length > 0 || rec.reopenedIds.length > 0)
            ? markStaleSubjectiveAssessments(nextSubjective, nextIssues, [...rec.newIds, ...rec.reopenedIds], scanNum)
            : new Set();

    const nextState = {
        ...state,
        score_model: SCORE_MODEL_VERSION,
        scan_count: scanNum,
        last_scan_at: nowIso,
        last_scan_fingerprint: fingerprint,
        scan_path: opts.scanPath || state.scan_path || ".",
        potentials: mergeScanPotentials(state.potentials, potentials, opts),
        issues: nextIssues,
        ignore_integrity: ignoreSummary,
        subjective_assessments: nextSubjective,
    };

    cleanupStaleDismissals(nextState);
    if (plan) {
        plan.resolves_since_last_scan = 0;
        if (!plan.scan_count_at_plan_start) plan.scan_count_at_plan_start = scanNum;
    }

    return {
        state: nextState,
        diff: buildActiveScanDiff(scanNum, nextIssues, rec, newlyStaleDims),
    };
}

/**
 * Inspect git context (`available`, `branch`, `head_sha`, `head_subject`, `has_uncommitted`).
 */
export function detectGitContext(rootDir) {
    try {
        const statusOut = execFileSync(
            "git",
            ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"],
            { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        let branch = "";
        let branchOid = "";
        let hasUncommitted = false;
        for (const line of statusOut.split("\n")) {
            if (!line) continue;
            if (line.startsWith("# ")) {
                if (line.startsWith("# branch.head ")) {
                    const rawHead = line.slice("# branch.head ".length).trim();
                    if (rawHead && rawHead !== "(detached)" && rawHead !== "HEAD") {
                        branch = rawHead;
                    }
                } else if (line.startsWith("# branch.oid ")) {
                    branchOid = line.slice("# branch.oid ".length).trim();
                }
            } else {
                hasUncommitted = true;
            }
        }
        if (branchOid === "(initial)") {
            return { available: false, branch: null, head_sha: "HEAD", head_subject: "", has_uncommitted: false };
        }
        const logOut = execFileSync(
            "git",
            ["-c", "core.fsmonitor=false", "log", "-1", "--no-textconv", "--format=%h%x00%s"],
            { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const nulIdx = logOut.indexOf("\0");
        const headSha = (nulIdx >= 0 ? logOut.slice(0, nulIdx) : logOut).trim();
        const headSubject = nulIdx >= 0 ? logOut.slice(nulIdx + 1).trim() : "";
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
function appendCommitLogScoreSection(lines, scores, history) {
    if (!scores) return;
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

function appendCommitLogResolvedSection(lines, allTrackedIds, committedCount, uncommittedCount, issues) {
    lines.push(
        `### Resolved Findings (${allTrackedIds.length} total: ${committedCount} committed, ${uncommittedCount} uncommitted)`,
    );
    lines.push("");
    if (allTrackedIds.length === 0) {
        lines.push("_No resolved findings recorded yet._", "");
        return;
    }
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
        if (list.length > 10) lines.push(`  - _...and ${list.length - 10} more_`);
    }
    lines.push("");
}

function appendCommitLogHistorySection(lines, commitLog) {
    if (commitLog.length === 0) return;
    lines.push("### Commit Log", "", "| Commit | Branch | Issues | Note |", "| :--- | :--- | :---: | :--- |");
    for (const rec of commitLog) {
        const sha = rec.commit || rec.sha || "?";
        const branch = rec.branch || "—";
        const count = Array.isArray(rec.issue_ids) ? rec.issue_ids.length : 0;
        const note = rec.note || rec.subject || "—";
        lines.push(`| \`${sha}\` | \`${branch}\` | ${count} | ${note} |`);
    }
    lines.push("");
}

export function generateCommitLogPrBody(plan, state, scores = null) {
    const commitLog = Array.isArray(plan?.commit_log) ? plan.commit_log : [];
    const uncommitted = Array.isArray(plan?.uncommitted_resolved) ? plan.uncommitted_resolved : [];
    const issues = state?.issues || {};
    const history = Array.isArray(state?.history) ? state.history : [];

    const lines = ["## `plexer health` Quality Report", ""];
    appendCommitLogScoreSection(lines, scores, history);
    const committedIds = commitLog.flatMap((r) => r.issue_ids || []);
    const allTrackedIds = [...new Set([...committedIds, ...uncommitted])];
    appendCommitLogResolvedSection(lines, allTrackedIds, committedIds.length, uncommitted.length, issues);
    appendCommitLogHistorySection(lines, commitLog);
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
    const prStr = prNumber !== undefined && prNumber !== null ? String(prNumber).trim() : "";
    if (/^[1-9]\d*$/.test(prStr) && config?.commit_tracking_enabled !== false && recorded.length > 0) {
        try {
            const prBody = generateCommitLogPrBody(plan, state, scores);
            execFileSync("gh", ["pr", "edit", prStr, "--body", prBody], {
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
