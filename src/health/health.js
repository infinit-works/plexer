/**
 * Core orchestrator and programmatic SDK for `plexer health`.
 */
import { resolve } from "node:path";
import { changedFiles } from "../blast/diff.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { fileReader } from "../util/span.js";
import { moveFileOrDir, runAutofix } from "./autofix.js";
import { generateConcerns } from "./concerns.js";
import {
    ALL_CATEGORIES,
    AVAILABLE_DIRECTIVE_PHASES,
    MECHANICAL_DIMENSIONS,
    SUBJECTIVE_DIMENSIONS,
    buildAgentLoopPrompt,
    normalizeDimensionKey,
} from "./constants.js";
import { detectDuplicates } from "./duplicates.js";
import { runGraphChecks } from "./graph-checks.js";
import { computeHeadline, computeReminders } from "./narrative.js";
import {
    annotatePlanIssues,
    buildExecutionQueue,
    buildTriageStagePrompt,
     compareIssuesByPriority,
    demotePlanItemsToBacklog,
    managePlanCluster,
    managePlanPolicy,
    manageScanGate,
    matchIssueIds,
    promotePlanItems,
    pruneExcludedIssues,
    reopenIssues,
    reorderPlanQueue,
    repairStateFromPlan,
    resetLivingPlan,
    resolveIssues,
    skipIssues,
    suppressIssues,
    unskipIssues,
    updateTriageStage,
} from "./queue.js";
import {
    detectReviewCoverage,
    importReview,
    mergeReviewBatches,
    prepareReview,
    runReviewBatches,
    runTriageStages,
} from "./review.js";
import { computeScoreSnapshot, emitScorecardBadge } from "./scoring.js";
import { runSourceChecks } from "./source-checks.js";
import {
    appendScoreHistory,
    computeIssueFingerprints,
    detectGitContext,
    emptyHealthConfig,
    generateCommitLogPrBody,
    healthDir,
    loadHealthConfig,
    loadHealthState,
    loadLivingPlan,
    mergeScanIntoState,
    recordCommitLog,
    saveHealthConfig,
    saveHealthState,
    saveLivingPlan,
} from "./state.js";
import { generateHealthTreemapHtml, generateHealthTreeText } from "./viz.js";
import { SCORED_ZONES, VALID_ZONES, classifyZone, loadIgnoreRules } from "./zones.js";

function parseCategorySet(onlyOpt, skipOpt) {
    let set = new Set(ALL_CATEGORIES);
    if (onlyOpt) {
        const list = (Array.isArray(onlyOpt) ? onlyOpt : String(onlyOpt).split(","))
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (list.length > 0) set = new Set(list);
    }
    if (skipOpt) {
        const list = (Array.isArray(skipOpt) ? skipOpt : String(skipOpt).split(","))
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        for (const s of list) set.delete(s);
    }
    return set;
}

export function buildZoneMap(graph, config) {
    const map = new Map();
    const overrides = config?.zones || {};
    for (const node of graph.nodes) {
        if (node.kind === "file") {
            map.set(node.path, classifyZone(node.path, overrides));
        }
    }
    return map;
}

function countScoredFiles(graph, zoneMap) {
    let count = 0;
    for (const n of graph.nodes) {
        if (n.kind === "file" && SCORED_ZONES.has(zoneMap.get(n.path) || "production")) {
            count += 1;
        }
    }
    return count;
}

function scaleScopedPotentials(graph, zoneMap, fileFilter, potentials) {
    let totalScoredCount = 0;
    let scopedScoredCount = 0;
    for (const n of graph.nodes) {
        if (n.kind === "file" && SCORED_ZONES.has(zoneMap.get(n.path) || "production")) {
            totalScoredCount += 1;
            if (fileFilter(n.path)) scopedScoredCount += 1;
        }
    }
    if (totalScoredCount > 0) {
        const ratio = scopedScoredCount / totalScoredCount;
        for (const k of Object.keys(potentials)) {
            if (potentials[k] > 0) potentials[k] = Math.max(1, Math.round(potentials[k] * ratio));
        }
    }
}

/**
 * Run all enabled mechanical detectors over `graph` and `rootDir`.
 */
export function runMechanicalDetectors(graph, rootDir, config, opts = {}) {
    const enabledCategories = parseCategorySet(opts.only, opts.skip);
    const zoneMap = buildZoneMap(graph, config);
    const ignoreRules = loadIgnoreRules(rootDir, config?.excludes || []);
    const readLines = fileReader(rootDir);

    const inPrefixes = opts.in
        ? (Array.isArray(opts.in) ? opts.in : [opts.in]).map((p) =>
              String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""),
          )
        : null;

    let diffFileSet = null;
    if (opts.diff) {
        const base = typeof opts.diff === "string" ? opts.diff : opts.base;
        const diffRes = changedFiles(rootDir, base);
        if (diffRes && Array.isArray(diffRes.files)) {
            diffFileSet = new Set(diffRes.files.map((d) => d.path));
        }
    }

    const detectorFilter = opts.detector
        ? new Set(
              (Array.isArray(opts.detector) ? opts.detector : String(opts.detector).split(","))
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean),
          )
        : null;

    const fileFilter =
        inPrefixes?.length || diffFileSet
            ? (rel) => {
                  const f = (rel || "").replace(/\\/g, "/");
                  if (inPrefixes?.length && !inPrefixes.some((p) => f === p || f.startsWith(`${p}/`))) return false;
                  if (diffFileSet && !diffFileSet.has(rel)) return false;
                  return true;
              }
            : null;

    const allIssues = [];
    const potentials = {};

    if (enabledCategories.has("duplicates")) {
        const dupRes = detectDuplicates(graph, readLines, zoneMap, ignoreRules);
        allIssues.push(...dupRes.issues);
        potentials.duplicates = dupRes.potential;
    }

    const graphRes = runGraphChecks(graph, readLines, zoneMap, ignoreRules, enabledCategories, config, {
        rootDir,
        contextDir: opts.contextDir || null,
        plan: opts.plan || null,
        fileFilter,
    });
    allIssues.push(...graphRes.issues);
    Object.assign(potentials, graphRes.potentials);

    if (fileFilter) scaleScopedPotentials(graph, zoneMap, fileFilter, potentials);

    const srcRes = runSourceChecks(graph, readLines, zoneMap, ignoreRules, enabledCategories, fileFilter);
    allIssues.push(...srcRes.issues);
    Object.assign(potentials, srcRes.potentials);

    const filteredIssues = allIssues.filter((iss) => {
        if (detectorFilter && detectorFilter.size > 0) {
            if (!detectorFilter.has(iss.detector.toLowerCase()) && !detectorFilter.has((iss.category || "").toLowerCase())) {
                return false;
            }
        }
        if (inPrefixes && inPrefixes.length > 0) {
            const f = (iss.file || "").replace(/\\/g, "/");
            if (!inPrefixes.some((p) => f === p || f.startsWith(`${p}/`))) return false;
        }
        if (diffFileSet && !diffFileSet.has(iss.file)) return false;
        return true;
    });

    return { issues: filteredIssues, potentials, zoneMap, ignoreRules, readLines };
}

/**
 * Main programmatic entry point (`plexer.health(dir, opts)`).
 * Supports both stateful loop actions (`action`: `"scan"`, `"next"`, `"backlog"`, `"status"`,
 * `"show"`, `"resolve"`, `"suppress"`, `"plan"`, `"review"`, `"autofix"`, `"move"`, `"tree"`,
 * `"viz"`, `"detect"`, `"zone"`, `"exclude"`, `"directives"`, `"config"`, `"prompt"`) and
 * one-shot queries (`opts.diff`, `opts.in`, `opts.only`).
 */
function handleHealthConfigAction(action, contextDir, config, state, plan, opts) {
    if (action === "config") {
        const sub = (opts.subAction || "show").toLowerCase();
        if (sub === "set" && opts.key) {
            let val = opts.value;
            if (opts.key === "layers" && typeof val === "string") {
                val = val
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            } else if (val === "true") val = true;
            else if (val === "false") val = false;
            else if (typeof val === "string" && val.trim() !== "" && !Number.isNaN(Number(val))) val = Number(val);
            config[opts.key] = val;
            saveHealthConfig(contextDir, config);
        } else if (sub === "unset" && opts.key) {
            const defaults = emptyHealthConfig();
            if (Object.prototype.hasOwnProperty.call(defaults, opts.key)) {
                config[opts.key] = defaults[opts.key];
            } else {
                delete config[opts.key];
            }
            saveHealthConfig(contextDir, config);
        }
        return { action: "config", sub_action: sub, key: opts.key || null, config };
    }

    if (action === "exclude") {
        const target = String(opts.target || "").trim();
        let pruneRes = { removed_ids: [], purged_plan_count: 0 };
        if (target) {
            if (!config.excludes.includes(target)) config.excludes.push(target);
            config.needs_rescan = true;
            saveHealthConfig(contextDir, config);
            pruneRes = pruneExcludedIssues(state, plan, target);
            if (pruneRes.removed_ids.length > 0) {
                saveHealthState(contextDir, state);
                saveLivingPlan(contextDir, plan);
            }
        }
        return {
            action: "exclude",
            excluded: target,
            excludes: config.excludes,
            removed_count: pruneRes.removed_ids.length,
            removed_ids: pruneRes.removed_ids,
            purged_plan_count: pruneRes.purged_plan_count,
        };
    }

    if (action === "directives") {
        const sub = (opts.subAction || "show").toLowerCase();
        if (sub === "set" && opts.phase && opts.message) {
            config.directives[opts.phase] = opts.message;
            saveHealthConfig(contextDir, config);
        } else if (sub === "unset" && opts.phase) {
            delete config.directives[opts.phase];
            saveHealthConfig(contextDir, config);
        }
        return {
            action: "directives",
            available_phases: AVAILABLE_DIRECTIVE_PHASES,
            directives: config.directives,
        };
    }
    return null;
}

function handleHealthZoneAction(contextDir, graph, config, state, opts) {
    const sub = (opts.subAction || "show").toLowerCase();
    let restampedCount = 0;
    if (sub === "set" && opts.target && opts.zone) {
        if (!VALID_ZONES.has(opts.zone)) {
            throw new Error(`Invalid zone "${opts.zone}" — must be one of: ${[...VALID_ZONES].join(", ")}`);
        }
        const normTarget = opts.target.replace(/\\/g, "/");
        config.zones[normTarget] = opts.zone;
        saveHealthConfig(contextDir, config);
        for (const iss of Object.values(state.issues || {})) {
            if (iss.file === normTarget) {
                iss.zone = opts.zone;
                restampedCount += 1;
            }
        }
        if (restampedCount > 0) saveHealthState(contextDir, state);
    } else if (sub === "clear" && opts.target) {
        const normTarget = opts.target.replace(/\\/g, "/");
        delete config.zones[normTarget];
        saveHealthConfig(contextDir, config);
        const fallbackZone = classifyZone(normTarget, config.zones);
        for (const iss of Object.values(state.issues || {})) {
            if (iss.file === normTarget) {
                iss.zone = fallbackZone;
                restampedCount += 1;
            }
        }
        if (restampedCount > 0) saveHealthState(contextDir, state);
    }
    const updatedZoneMap = buildZoneMap(graph, config);
    const counts = {};
    const filesByZone = {};
    for (const [f, z] of updatedZoneMap.entries()) {
        counts[z] = (counts[z] || 0) + 1;
        if (!filesByZone[z]) filesByZone[z] = [];
        filesByZone[z].push(f);
    }
    return {
        action: "zone",
        sub_action: sub,
        restamped_issues: restampedCount,
        counts,
        overrides: config.zones,
        files_by_zone: filesByZone,
    };
}

function handlePlanCommitLogSubAction(root, contextDir, state, plan, config, opts) {
    const cSub = (opts.commitAction || "status").toLowerCase();
    const scores = computeScoreSnapshot(state);
    if (cSub === "record") {
        const entry = recordCommitLog(root, plan, opts, state, config, scores);
        saveLivingPlan(contextDir, plan);
        return {
            action: "plan_commit_log",
            sub_action: "record",
            recorded: entry,
            uncommitted_resolved: plan.uncommitted_resolved,
        };
    }
    if (cSub === "history") {
        const top = Number(opts.max || opts.count) || 10;
        const logList = Array.isArray(plan.commit_log) ? plan.commit_log : [];
        return {
            action: "plan_commit_log",
            sub_action: "history",
            total_commits: logList.length,
            records: logList.slice(-top).reverse(),
        };
    }
    if (cSub === "pr") {
        return {
            action: "plan_commit_log",
            sub_action: "pr",
            pr_markdown: generateCommitLogPrBody(plan, state, scores),
        };
    }
    const git = detectGitContext(root);
    const committedCount = (plan.commit_log || []).reduce((acc, r) => acc + (r.issue_ids?.length || 0), 0);
    return {
        action: "plan_commit_log",
        sub_action: "status",
        git,
        commit_pr: config.commit_pr || null,
        uncommitted_count: (plan.uncommitted_resolved || []).length,
        committed_count: committedCount,
        uncommitted_resolved: plan.uncommitted_resolved,
        commit_log: plan.commit_log,
    };
}

function handlePlanQueueMutationSubAction(sub, contextDir, state, plan, opts) {
    if (sub === "reset") {
        const res = resetLivingPlan(state, plan);
        saveLivingPlan(contextDir, plan);
        return { action: "plan_reset", ...res };
    }
    if (sub === "resolve") {
        const res = resolveIssues(state, plan, opts.patterns || [], opts);
        if (res.status === "resolved") {
            const scores = computeScoreSnapshot(state);
            appendScoreHistory(state, scores, "resolve");
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
        }
        return { action: "plan_resolve", ...res };
    }
    if (sub === "skip") {
        const res = skipIssues(state, plan, opts.patterns || [], opts);
        const scores = computeScoreSnapshot(state);
        if (res.skipped_ids && res.skipped_ids.length > 0) {
            appendScoreHistory(state, scores, "skip");
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
        }
        return { action: "plan_skip", ...res, scores };
    }
    if (sub === "reopen") {
        const res = reopenIssues(state, plan, opts.patterns || []);
        saveHealthState(contextDir, state);
        saveLivingPlan(contextDir, plan);
        return { action: "plan_reopen", ...res };
    }
    if (sub === "unskip") {
        const res = unskipIssues(state, plan, opts.patterns || []);
        saveHealthState(contextDir, state);
        saveLivingPlan(contextDir, plan);
        return { action: "plan_unskip", ...res };
    }
    if (sub === "promote") {
        const res = promotePlanItems(
            state,
            plan,
            opts.patterns || [],
            opts.position || "top",
            opts.target || null,
        );
        saveLivingPlan(contextDir, plan);
        return { action: "plan_promote", ...res };
    }
    if (sub === "backlog") {
        const res = demotePlanItemsToBacklog(state, plan, opts.patterns || []);
        saveLivingPlan(contextDir, plan);
        return { action: "plan_backlog", ...res };
    }
    if (sub === "describe" || sub === "note") {
        const payload =
            sub === "describe"
                ? { description: opts.description ?? opts.text ?? opts.note ?? "" }
                : { note: opts.note ?? opts.text ?? opts.description ?? "" };
        const res = annotatePlanIssues(state, plan, opts.patterns || [], payload);
        saveHealthState(contextDir, state);
        saveLivingPlan(contextDir, plan);
        return { action: `plan_${sub}`, ...res };
    }
    if (sub === "reorder") {
        const res = reorderPlanQueue(
            state,
            plan,
            opts.patterns || [],
            opts.position || "top",
            opts.target,
            opts,
        );
        saveLivingPlan(contextDir, plan);
        return { action: "plan_reorder", ...res };
    }
    return null;
}

function handleHealthPlanAction(root, contextDir, state, plan, config, totalProdFiles, opts) {
    const sub = (opts.subAction || "show").toLowerCase();
    const queueMutation = handlePlanQueueMutationSubAction(sub, contextDir, state, plan, opts);
    if (queueMutation) return queueMutation;

    if (sub === "policy") {
        const pSub = opts.policyAction || opts.clusterAction || "list";
        const ruleOrIdx =
            opts.rule ??
            opts.target ??
            (Array.isArray(opts.patterns) && opts.patterns.length > 0
                ? opts.patterns.join(" ")
                : null);
        const res = managePlanPolicy(plan, pSub, ruleOrIdx, config);
        saveLivingPlan(contextDir, plan);
        saveHealthConfig(contextDir, config);
        return { action: "plan_policy", ...res };
    }
    if (sub === "scan-gate") {
        const res = manageScanGate(state, plan, opts);
        if (res.ok) saveLivingPlan(contextDir, plan);
        return { action: "plan_scan_gate", ...res };
    }
    if (sub === "repair-state") {
        const res = repairStateFromPlan(state, plan);
        saveHealthState(contextDir, state);
        return { action: "plan_repair_state", ...res };
    }
    if (sub === "cluster") {
        const cRes = managePlanCluster(
            state,
            plan,
            opts.clusterAction || "list",
            opts.clusterName,
            opts.patterns || [],
            opts,
        );
        saveLivingPlan(contextDir, plan);
        return { action: "plan_cluster", ...cRes };
    }
    if (sub === "focus") {
        plan.focus_cluster = !opts.clusterName || opts.clusterName === "clear" ? null : opts.clusterName;
        saveLivingPlan(contextDir, plan);
        return { action: "plan_focus", focus_cluster: plan.focus_cluster };
    }
    if (sub === "triage") {
        if (opts.stagePrompt) {
            const prompt = buildTriageStagePrompt(opts.stagePrompt, state, plan);
            return {
                action: "plan_triage",
                stage: String(opts.stagePrompt).toLowerCase(),
                stage_prompt: prompt,
                prompt,
                triage: plan.triage,
            };
        }
        if (opts.runStages) {
            return runTriageStages(root, contextDir, state, plan, opts).then((res) => {
                saveLivingPlan(contextDir, plan);
                return res;
            });
        }
        const res = updateTriageStage(plan, opts, state);
        saveLivingPlan(contextDir, plan);
        return { action: "plan_triage", ...res };
    }
    if (sub === "commit-log") {
        return handlePlanCommitLogSubAction(root, contextDir, state, plan, config, opts);
    }
    const queue = buildExecutionQueue(state, plan, { count: opts.count || 15, totalProdFiles });
    return { action: "plan", plan, queue, scores: computeScoreSnapshot(state) };
}

function handleHealthShowAction(graph, state, config, zoneMap, readLines, opts) {
    const firstPat = opts.patterns && opts.patterns.length === 1 ? String(opts.patterns[0]).trim() : "";
    const lowerPat = firstPat.toLowerCase();

    if (lowerPat === "concerns") {
        const concerns = generateConcerns(state, graph, zoneMap);
        return {
            action: "show",
            view: "concerns",
            count: concerns.length,
            concerns,
            dismissed_count: Object.keys(state.concern_dismissals || {}).length,
        };
    }

    const normDimKey = firstPat ? normalizeDimensionKey(firstPat) : "";
    const isMechDim = Boolean(firstPat && MECHANICAL_DIMENSIONS[lowerPat]);
    const isSubjDim = Boolean(normDimKey && SUBJECTIVE_DIMENSIONS[normDimKey]);
    if (isMechDim || isSubjDim) {
        const scores = computeScoreSnapshot(state);
        const dimId = isMechDim ? lowerPat : normDimKey;
        const dimScoreObj = isMechDim ? scores.mechanical_dimensions[dimId] : scores.subjective_dimensions[dimId];
        const detSet = isMechDim ? new Set(MECHANICAL_DIMENSIONS[dimId].detectors) : new Set(["review"]);
        const dimIssues = Object.values(state.issues || {}).filter((iss) => {
            if (opts.status && iss.status !== opts.status.toLowerCase()) return false;
            if (isMechDim) return iss.detector !== "review" && (iss.dimension ? iss.dimension === dimId : detSet.has(iss.detector));
            return iss.detector === "review" && normalizeDimensionKey(iss.dimension) === dimId;
        });
        return {
            action: "show",
            view: "dimension",
            dimension: dimScoreObj,
            context: state.dimension_contexts?.[dimId] || null,
            count: dimIssues.length,
            items: dimIssues,
        };
    }

    const statusFilter = opts.status ? new Set([opts.status.toLowerCase()]) : null;
    const ids =
        opts.patterns && opts.patterns.length > 0
            ? matchIssueIds(state, opts.patterns, statusFilter)
            : Object.keys(state.issues || {}).filter((id) => !statusFilter || statusFilter.has(state.issues[id].status));
    let items = ids.map((id) => state.issues[id]).filter(Boolean);
    if (opts.chronic) {
        const hasAnyReopenCount = Object.values(state.issues || {}).some(
            (i) => (i.reopen_count || 0) > 0,
        );
        items = items.filter((iss) =>
            hasAnyReopenCount
                ? (iss.reopen_count || 0) >= 2
                : (iss.reopen_count || 0) >= 2 ||
                  Number(iss.last_seen_scan || 1) - Number(iss.first_seen_scan || 1) >= 1,
        );
    }

    items.sort((a, b) => compareIssuesByPriority(a, b));
    const totalBeforeBudget = items.length;
    if (!opts.noBudget) {
        const perDetBudget = Number(config?.issue_noise_budget ?? 10);
        const globalBudget = Number(config?.issue_noise_global_budget ?? 0);
        if (perDetBudget > 0) {
            const detCounts = new Map();
            items = items.filter((iss) => {
                const c = detCounts.get(iss.detector) || 0;
                if (c >= perDetBudget) return false;
                detCounts.set(iss.detector, c + 1);
                return true;
            });
        }
        if (globalBudget > 0 && items.length > globalBudget) {
            items = items.slice(0, globalBudget);
        }
    }

    const sliced = opts.max && opts.max !== "all" ? items.slice(0, Number(opts.max)) : items;
    const enriched = opts.code
        ? sliced.map((iss) => {
              const fLines = iss.file ? readLines(iss.file) : null;
              if (!fLines || fLines.length === 0) return iss;
              const sLine = Math.max(1, (iss.line || 1) - 1);
              const eLine = Math.min(fLines.length, (iss.end_line || iss.line || 1) + 2);
              const excerpt = [];
              for (let ln = sLine; ln <= eLine; ln++) excerpt.push(`L${ln}: ${fLines[ln - 1]}`);
              return { ...iss, code_excerpt: excerpt.join("\n") };
          })
        : sliced;

    return {
        action: "show",
        view: "issues",
        chronic: Boolean(opts.chronic),
        no_budget: Boolean(opts.noBudget),
        total_matching: totalBeforeBudget,
        hidden_by_budget: Math.max(0, totalBeforeBudget - items.length),
        count: enriched.length,
        items: enriched,
    };
}

function handleHealthReviewAction(root, contextDir, graph, state, config, plan, zoneMap, readLines, totalProdFiles, opts) {
    if (opts.runBatches) {
        return runReviewBatches(
            root,
            contextDir,
            graph,
            state,
            config,
            zoneMap,
            readLines,
            totalProdFiles,
            { ...opts, plan },
        ).then((res) => {
            const scores = computeScoreSnapshot(state);
            if (res.status === "imported" || res.status === "target_anchored_reset") {
                appendScoreHistory(state, scores, "review_import");
                saveHealthState(contextDir, state);
                if (!opts.noBadge) emitScorecardBadge(contextDir, scores, state);
            }
            return {
                ...res,
                scores,
                review_coverage: detectReviewCoverage(state, totalProdFiles),
            };
        });
    }
    if (opts.prepare) {
        const prep = prepareReview(contextDir, graph, state, zoneMap, readLines, { ...opts, plan });
        saveHealthState(contextDir, state);
        return { action: "review_prepare", ...prep };
    }
    if (opts.merge) {
        const merged = mergeReviewBatches(opts.mergeDir || healthDir(contextDir), {
            similarity: opts.similarity,
        });
        return { action: "review_merge", merged };
    }
    if (opts.importFile || opts.importPayload) {
        const imp = importReview(state, config, opts.importPayload || resolve(root, opts.importFile), {
            contextDir,
            allowPartial: opts.allowPartial,
            manualOverride: opts.manualOverride,
            attestedExternal: opts.attestedExternal,
            strictGuard: opts.strictGuard,
            attest: opts.attest,
            totalProdFiles,
        });
        const scores = computeScoreSnapshot(state);
        if (imp.status === "imported" || imp.status === "target_anchored_reset") {
            appendScoreHistory(state, scores, "review_import");
            saveHealthState(contextDir, state);
            if (!opts.noBadge) emitScorecardBadge(contextDir, scores, state);
        }
        return {
            action: "review_import",
            ...imp,
            scores,
            review_coverage: detectReviewCoverage(state, totalProdFiles),
        };
    }
    const prep = prepareReview(contextDir, graph, state, zoneMap, readLines, { ...opts, plan });
    saveHealthState(contextDir, state);
    return { action: "review_prepare", ...prep };
}

function ensureInitialHealthScan(graph, root, contextDir, config, state, plan, opts, persist = false) {
    if ((state.scan_count || 0) === 0) {
        const det = runMechanicalDetectors(graph, root, config, { ...opts, contextDir, plan });
        const merged = mergeScanIntoState(state, det.issues, det.potentials, plan, {
            ...opts,
            suppressions: config.suppressions,
        });
        Object.assign(state, merged.state);
        if (persist) {
            const scores = computeScoreSnapshot(state);
            appendScoreHistory(state, scores, "scan");
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
        }
    }
}

function runHealthScanAction(root, contextDir, graph, config, state, plan, totalProdFiles, opts) {
    const det = runMechanicalDetectors(graph, root, config, { ...opts, contextDir, plan });
    const isScopedQuery = Boolean(opts.diff || opts.in || opts.only || opts.skip || opts.stateless);

    let activeState = state;
    let diff = null;

    if (isScopedQuery) {
        const ephemeral = mergeScanIntoState(
            { ...state, issues: {} },
            det.issues,
            det.potentials,
            null,
            { ...opts, isScopedScan: true, forceResolve: true, suppressions: config.suppressions },
        );
        activeState = ephemeral.state;
        diff = ephemeral.diff;
    } else {
        const merged = mergeScanIntoState(state, det.issues, det.potentials, plan, {
            scanPath: opts.scanPath || ".",
            resetSubjective: opts.resetSubjective,
            forceResolve: opts.forceResolve,
            suppressions: config.suppressions,
        });
        activeState = merged.state;
        diff = merged.diff;
        if (config.needs_rescan) {
            config.needs_rescan = false;
            saveHealthConfig(contextDir, config);
        }
    }

    const scores = computeScoreSnapshot(activeState);
    if (!isScopedQuery) {
        appendScoreHistory(activeState, scores, "scan");
        saveHealthState(contextDir, activeState);
        saveLivingPlan(contextDir, plan);
        if (!opts.noBadge) emitScorecardBadge(contextDir, scores, activeState);
    }

    const maxItems = opts.max === "all" ? 9999 : Number(opts.max) || 10;
    const queue = buildExecutionQueue(activeState, plan, {
        count: maxItems,
        group: opts.group,
        explain: opts.explain,
        includeSkipped: opts.includeSkipped,
        totalProdFiles,
    });
    const headline = computeHeadline(activeState, scores, plan, config);
    const reminders = computeReminders(activeState, scores, plan, config, "scan", totalProdFiles);

    return {
        action: "scan",
        scoped: isScopedQuery,
        scores,
        diff,
        headline,
        queue,
        reminders,
        review_coverage: detectReviewCoverage(activeState, totalProdFiles),
        findings: queue.all_items.slice(0, maxItems),
        showWorkflowGuide: !isScopedQuery && opts.profile !== "ci",
    };
}

function handleHealthQueueOrStatusAction(action, graph, root, contextDir, config, state, plan, totalProdFiles, opts) {
    ensureInitialHealthScan(graph, root, contextDir, config, state, plan, opts, true);
    const isBacklog = action === "backlog";
    const scores = computeScoreSnapshot(state);
    const queue = buildExecutionQueue(state, plan, {
        backlog: isBacklog,
        count: opts.count || (isBacklog ? 20 : 5),
        cluster: opts.cluster,
        group: opts.group,
        explain: opts.explain,
        includeSkipped: opts.includeSkipped,
        totalProdFiles,
    });
    const base = {
        action,
        scores,
        headline: computeHeadline(state, scores, plan, config),
        queue,
        reminders: computeReminders(state, scores, plan, config, action, totalProdFiles),
    };
    if (action === "status") {
        base.review_coverage = detectReviewCoverage(state, totalProdFiles);
        base.scan_count = state.scan_count;
        base.last_scan_at = state.last_scan_at;
        base.history = state.history || [];
    }
    return base;
}

function enrichSuppressionFingerprints(state, config, res) {
    if (res.status !== "suppressed") return;
    const fpSet = new Set(res.fingerprints || []);
    for (const id of res.suppressed_ids || []) {
        const iss = state.issues?.[id];
        if (iss) {
            for (const fp of computeIssueFingerprints(iss.detector, iss.identifier, iss.summary)) fpSet.add(fp);
        }
    }
    const allFps = [...fpSet];
    res.fingerprints = allFps;
    if (config.suppressions?.[res.pattern]) config.suppressions[res.pattern].fingerprints = allFps;
}

function handleHealthToolAction(
    action,
    root,
    contextDir,
    graph,
    config,
    state,
    plan,
    zoneMap,
    readLines,
    totalProdFiles,
    opts,
) {
    if (action === "autofix") {
        const ignoreRules = loadIgnoreRules(root, config.excludes);
        const afRes = runAutofix(root, graph, zoneMap, ignoreRules, opts.fixer || "all", {
            dryRun: opts.dryRun,
            state,
            plan,
        });
        const scores = computeScoreSnapshot(state);
        if (!opts.dryRun && afRes.reconciled_issue_ids?.length > 0) {
            appendScoreHistory(state, scores, "autofix");
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
            if (!opts.noBadge) emitScorecardBadge(contextDir, scores, state);
        }
        return { action: "autofix", ...afRes, scores };
    }
    if (action === "move") {
        return { action: "move", ...moveFileOrDir(root, graph, opts.src, opts.dst, { dryRun: opts.dryRun }) };
    }
    if (action === "detect") {
        const detName = opts.detector || (opts.patterns && opts.patterns[0]) || "all";
        const detRes = runMechanicalDetectors(graph, root, config, {
            ...opts,
            contextDir,
            plan,
            detector: detName === "all" ? null : detName,
        });
        return {
            action: "detect",
            detector: detName,
            count: detRes.issues.length,
            potentials: detRes.potentials,
            items: detRes.issues,
        };
    }
    if (action === "tree") {
        ensureInitialHealthScan(graph, root, contextDir, config, state, plan, opts, false);
        return { action: "tree", tree_text: generateHealthTreeText(graph, state, zoneMap, readLines, opts) };
    }
    if (action === "viz") {
        ensureInitialHealthScan(graph, root, contextDir, config, state, plan, opts, false);
        return {
            action: "viz",
            ...generateHealthTreemapHtml(contextDir, graph, state, zoneMap, readLines, { ...opts, rootDir: root }),
        };
    }
    if (action === "suppress") {
        const pattern = opts.pattern || (opts.patterns && opts.patterns[0]) || "";
        const res = suppressIssues(state, config, plan, pattern, opts);
        enrichSuppressionFingerprints(state, config, res);
        const scores = computeScoreSnapshot(state);
        if (res.status === "suppressed") {
            appendScoreHistory(state, scores, "suppress");
            saveHealthConfig(contextDir, config);
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
        }
        return {
            action: "suppress",
            ...res,
            scores,
            reminders: computeReminders(state, scores, plan, config, "suppress", totalProdFiles),
        };
    }
    if (action === "resolve") {
        const res = resolveIssues(state, plan, opts.patterns || [], opts);
        const scores = computeScoreSnapshot(state);
        if (res.status === "resolved") {
            appendScoreHistory(state, scores, "resolve");
            saveHealthState(contextDir, state);
            saveLivingPlan(contextDir, plan);
        }
        return {
            action: "resolve",
            ...res,
            scores,
            reminders: computeReminders(state, scores, plan, config, "resolve", totalProdFiles),
        };
    }
    return null;
}

export function health(dir, opts = {}) {
    const root = resolve(dir || ".");
    const contextDir = contextDirFor(root, opts.contextDir);
    const action = (opts.action || "scan").toLowerCase();

    if (action === "prompt") {
        return { action: "prompt", prompt: buildAgentLoopPrompt(opts.scanPath || ".") };
    }

    const config = loadHealthConfig(contextDir);
    const state = loadHealthState(contextDir);
    const plan = loadLivingPlan(contextDir);

    const cfgRes = handleHealthConfigAction(action, contextDir, config, state, plan, opts);
    if (cfgRes) return cfgRes;

    const graph = loadGraphCached(contextDir);
    if (!graph) {
        throw new Error(`no graph found at ${contextDir} — run \`plexer build\` first`);
    }

    const zoneMap = buildZoneMap(graph, config);
    const totalProdFiles = countScoredFiles(graph, zoneMap);
    const readLines = fileReader(root);

    if (action === "zone") return handleHealthZoneAction(contextDir, graph, config, state, opts);
    const toolRes = handleHealthToolAction(
        action,
        root,
        contextDir,
        graph,
        config,
        state,
        plan,
        zoneMap,
        readLines,
        totalProdFiles,
        opts,
    );
    if (toolRes) return toolRes;
    if (action === "review") {
        return handleHealthReviewAction(
            root,
            contextDir,
            graph,
            state,
            config,
            plan,
            zoneMap,
            readLines,
            totalProdFiles,
            opts,
        );
    }
    if (action === "plan") return handleHealthPlanAction(root, contextDir, state, plan, config, totalProdFiles, opts);
    if (action === "show") return handleHealthShowAction(graph, state, config, zoneMap, readLines, opts);
    if (action === "next" || action === "backlog" || action === "status") {
        return handleHealthQueueOrStatusAction(action, graph, root, contextDir, config, state, plan, totalProdFiles, opts);
    }

    return runHealthScanAction(root, contextDir, graph, config, state, plan, totalProdFiles, opts);
}

export async function healthAsync(dir, opts = {}) {
    return await health(dir, { ...opts, _allowAsync: true });
}
