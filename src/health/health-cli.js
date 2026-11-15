/**
 * CLI dispatcher for `plexer health` subcommands (`scan`, `next`, `backlog`, `status`,
 * `show`, `resolve`, `suppress`, `plan`, `review`, `autofix`, `move`, `tree`, `viz`,
 * `detect`, `zone`, `exclude`, `directives`, `config`, `prompt`).
 */
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { nearestPlexerRoot } from "../graph/root.js";
import { health, healthAsync } from "./health.js";
import { formatHealthMarkdown, formatHealthText } from "./render.js";

const KNOWN_ACTIONS = new Set([
    "scan",
    "next",
    "backlog",
    "status",
    "show",
    "resolve",
    "suppress",
    "plan",
    "review",
    "autofix",
    "move",
    "tree",
    "viz",
    "detect",
    "zone",
    "exclude",
    "directives",
    "config",
    "prompt",
]);

function resolveDirArg(candidate, baseDir = process.cwd()) {
    if (!candidate) return null;
    const baseFirst = baseDir && resolve(baseDir) !== process.cwd();
    const candidates = baseFirst
        ? [resolve(baseDir, candidate), resolve(candidate)]
        : [resolve(candidate), resolve(baseDir, candidate)];
    for (const p of candidates) {
        try {
            if (existsSync(p) && statSync(p).isDirectory()) return p;
        } catch {}
    }
    return null;
}

function isDirArg(candidate, baseDir = process.cwd()) {
    return Boolean(resolveDirArg(candidate, baseDir));
}

function applyTargetCandidate(candidate, currentDir, callOpts) {
    const absCand = resolveDirArg(candidate, currentDir);
    if (!absCand) return currentDir;
    const { root } = nearestPlexerRoot(absCand, callOpts.contextDir);
    const repoDir = root || absCand;
    const relSub = relative(repoDir, absCand).replace(/\\/g, "/");
    if (relSub && !relSub.startsWith("..")) {
        callOpts.in = callOpts.in || relSub;
        callOpts.scanPath = relSub;
    }
    return repoDir;
}

function parsePositionTail(rest, allowUpDown = false) {
    if (rest.length >= 2) {
        const prev = rest[rest.length - 2]?.toLowerCase();
        const last = rest[rest.length - 1];
        if (prev === "before" || prev === "after") {
            return { position: prev, target: last, patterns: rest.slice(0, -2) };
        }
        if (allowUpDown && (prev === "up" || prev === "down") && !Number.isNaN(Number(last))) {
            return { position: prev, offset: Number(last), patterns: rest.slice(0, -2) };
        }
    }
    const posCandidate = rest[rest.length - 1]?.toLowerCase();
    const validPos = allowUpDown
        ? ["top", "bottom", "before", "after", "up", "down"]
        : ["top", "bottom", "before", "after"];
    if (validPos.includes(posCandidate)) {
        return { position: posCandidate, patterns: rest.slice(0, -1) };
    }
    return { position: "top", patterns: rest };
}

function assignPositionTailArgs(rest, callOpts, withOffset) {
    const parsed = parsePositionTail(rest, withOffset);
    callOpts.position = parsed.position;
    if (parsed.target) callOpts.target = parsed.target;
    if (withOffset && parsed.offset !== undefined) callOpts.offset = parsed.offset;
    callOpts.patterns = parsed.patterns;
}

function parseClusterPlanSubargs(rest, callOpts) {
    const cAct = (rest[0] || "list").toLowerCase();
    callOpts.clusterAction = cAct;
    if (cAct === "list") {
        callOpts.clusterName = null;
        return;
    }
    if (cAct === "move") {
        if (!callOpts.to && rest.length >= 3) {
            callOpts.clusterName = rest[1];
            callOpts.patterns = rest.slice(2);
        } else {
            callOpts.patterns = rest.slice(1);
        }
        return;
    }
    if (cAct === "merge") {
        callOpts.clusterName = rest[1];
        callOpts.targetCluster = rest[2];
        callOpts.patterns = rest.slice(2);
        return;
    }
    if (cAct === "export") {
        callOpts.clusterName = rest[1];
        if (rest[2]) callOpts.exportFormat = rest[2];
        return;
    }
    if (cAct === "import") {
        callOpts.importFile = rest[1] || callOpts.file || callOpts.import;
        callOpts.clusterName = rest[1];
        return;
    }
    callOpts.clusterName = rest[1];
    callOpts.patterns = rest.slice(2);
}

function assignTextTailField(rest, callOpts, field) {
    if (!callOpts[field] && rest.length >= 2) {
        callOpts[field] = rest[rest.length - 1];
        callOpts.patterns = rest.slice(0, -1);
    } else {
        callOpts.patterns = rest;
    }
}

const PLAN_PATTERN_SUBCOMMANDS = new Set(["resolve", "skip", "reopen", "unskip", "backlog"]);

function parsePlanCliSubargs(args, callOpts) {
    const sub = (args[0] || "show").toLowerCase();
    callOpts.subAction = sub;
    const rest = args.slice(1);
    if (PLAN_PATTERN_SUBCOMMANDS.has(sub)) { callOpts.patterns = rest; return; }
    if (sub === "promote" || sub === "reorder") { assignPositionTailArgs(rest, callOpts, sub === "reorder"); return; }
    if (sub === "describe" || sub === "note") { assignTextTailField(rest, callOpts, sub === "describe" ? "description" : "note"); return; }
    if (sub === "cluster") { parseClusterPlanSubargs(rest, callOpts); return; }
    if (sub === "policy") {
        callOpts.policyAction = (rest[0] || "list").toLowerCase();
        if (rest.length > 1) callOpts.rule = rest.slice(1).join(" ");
    } else if (sub === "scan-gate" || sub === "scangate") {
        if (rest[0] === "reset" || callOpts.resetGate) callOpts.reset = true;
        if (rest[0] === "skip" || callOpts.skipGate) callOpts.skip = true;
    } else if (sub === "triage") {
        if (rest[0] && !callOpts.stagePrompt && !callOpts["stage-prompt"]) callOpts.stagePrompt = rest[0];
    } else if (sub === "focus") {
        callOpts.clusterName = rest[0] || null;
    } else if (sub === "commit-log") {
        callOpts.commitAction = rest[0] || "status";
    }
}

const ZONE_CLI_SUBACTIONS = new Set(["set", "clear"]);
const CONFIG_CLI_SUBACTIONS = new Set(["set", "unset"]);

function applySubActionCliArgs(callOpts, args, validSub, secondField, thirdField, fallbackSecond = undefined, joinThird = false) {
    callOpts.subAction = validSub.has(args[0]) ? args[0] : "show";
    callOpts[secondField] = fallbackSecond !== undefined ? (args[1] || fallbackSecond) : args[1];
    if (args[0] === "set") {
        callOpts[thirdField] = joinThird ? args.slice(2).join(" ") : args[2];
    }
}

function parseActionSpecificCliArgs(action, args, dir, opts, callOpts) {
    if (["scan", "next", "backlog", "status", "tree", "viz"].includes(action)) {
        return args.length > 0 && isDirArg(args[0], dir) ? applyTargetCandidate(args.shift(), dir, callOpts) : dir;
    }
    if (action === "show" || action === "resolve") { callOpts.patterns = args; }
    else if (action === "suppress") { callOpts.pattern = args[0]; callOpts.patterns = args; }
    else if (action === "detect") {
        callOpts.detector = args[0] || opts.detector || "all";
        if (args[1] && isDirArg(args[1], dir)) return applyTargetCandidate(args[1], dir, callOpts);
    } else if (action === "exclude") { callOpts.target = args[0] || opts.target; }
    else if (action === "autofix") { callOpts.fixer = args[0] || "all"; }
    else if (action === "move") { callOpts.src = args[0]; callOpts.dst = args[1]; }
    else if (action === "zone") {
        applySubActionCliArgs(callOpts, args, ZONE_CLI_SUBACTIONS, "target", "zone", opts.target);
    } else if (action === "config" || action === "directives") {
        const isConfig = action === "config";
        applySubActionCliArgs(callOpts, args, CONFIG_CLI_SUBACTIONS, isConfig ? "key" : "phase", isConfig ? "value" : "message", undefined, true);
    } else if (action === "plan") { parsePlanCliSubargs(args, callOpts); }
    else if (action === "review") {
        if (opts.import) callOpts.importFile = opts.import;
        if (opts.merge && typeof opts.merge === "string") callOpts.mergeDir = opts.merge;
    }
    return dir;
}

function parseHealthCliArgs(defaultDir, positionalArgs, opts) {
    const args = [...positionalArgs];
    let action = "scan";
    let dir = defaultDir;
    const callOpts = { ...opts, action, scanPath: opts.scanPath || opts.path || "." };

    if (args.length > 0 && KNOWN_ACTIONS.has(args[0].toLowerCase())) {
        action = args.shift().toLowerCase();
        callOpts.action = action;
    } else if (args.length > 0 && isDirArg(args[0], dir)) {
        dir = applyTargetCandidate(args.shift(), dir, callOpts);
    }

    if (opts.path && isDirArg(opts.path, dir)) {
        dir = applyTargetCandidate(opts.path, dir, callOpts);
    }

    if (opts.detailText !== undefined && (callOpts.detail === undefined || action === "plan")) {
        callOpts.detail = opts.detailText;
    }

    dir = parseActionSpecificCliArgs(action, args, dir, opts, callOpts);
    return { action, dir, callOpts };
}

function printHealthShowResult(result) {
    if (result.view === "concerns") {
        console.log(`plexer health show concerns — ${result.count} design concern signal(s):`);
        for (const c of result.concerns) {
            console.log(`  [${c.type} · ${c.fingerprint}] ${c.file} — ${c.summary}`);
            console.log(`    Question: ${c.question}`);
        }
        return result;
    }
    if (result.view === "dimension") {
        const d = result.dimension || {};
        const staleTag = d.stale ? ` [STALE: ${d.stale_reason}]` : "";
        const scoreStr = d.score !== null && d.score !== undefined ? `${d.score}%` : "unassessed";
        console.log(
            `plexer health show ${d.id || d.name} (${d.pool} pool, weight ${d.weight}%, score ${scoreStr}${staleTag}) — ${result.count} matching finding(s):`,
        );
        if (d.judgment?.score_rationale || d.judgment?.dimension_character) {
            console.log(`  Rationale: ${d.judgment.score_rationale || d.judgment.dimension_character}`);
        }
        for (const it of result.items) {
            console.log(`  [${it.status} · ${it.tier} · ${it.severity}] ${it.id} (${it.file}:${it.span}) — ${it.summary}`);
            if (it.code_excerpt) {
                for (const line of it.code_excerpt.split("\n")) console.log(`    ${line}`);
            }
        }
        return result;
    }
    console.log(`plexer health show — ${result.count} matching finding(s):`);
    for (const it of result.items) {
        console.log(`  [${it.status} · ${it.tier} · ${it.severity}] ${it.id} (${it.file}:${it.span}) — ${it.summary}`);
        if (it.code_excerpt) {
            for (const line of it.code_excerpt.split("\n")) console.log(`    ${line}`);
        }
    }
    return result;
}

function printCommitLogResult(result) {
    if (result.sub_action === "pr") {
        console.log(result.pr_markdown);
        return true;
    }
    if (result.sub_action === "history") {
        console.log(`plexer health plan commit-log history (${result.total_commits} commit(s)):`);
        for (const r of result.records || []) {
            const br = r.branch ? ` (${r.branch})` : "";
            console.log(
                `  ${r.commit || r.sha}${br} — ${(r.issue_ids || []).length} issue(s) [${(r.recorded_at || "").slice(0, 16)}]${r.note ? ` · ${r.note}` : ""}`,
            );
        }
        return true;
    }
    if (result.sub_action === "record") {
        const rec = result.recorded || {};
        console.log(
            `✓ Recorded commit ${rec.commit} with ${(rec.issue_ids || []).length} issue(s).` +
                (rec.pr_updated ? ` Updated PR #${rec.commit_pr}.` : ""),
        );
        return true;
    }
    console.log(
        `plexer health plan commit-log — ${result.uncommitted_count} uncommitted, ${result.committed_count} committed across ${(result.commit_log || []).length} commit(s)` +
            (result.git?.branch ? ` [branch: ${result.git.branch}]` : ""),
    );
    return true;
}

const PLAN_STATUS_PRINTERS = {
    plan_resolve: (r) => {
        if (r.status === "scan_gate_blocked" || r.status === "not_found") return r.message;
        console.log(`✓ Resolved ${r.resolved_ids.length} finding(s): ${r.resolved_ids.join(", ")}`);
        if (r.suggested_commit) console.log(`  Suggested commit: ${r.suggested_commit}`);
        return null;
    },
    plan_skip: (r) => {
        if (r.status === "attestation_invalid" || r.status === "not_found" || r.status === "confirm_required") {
            return r.message || r.error;
        }
        console.log(`✓ Marked ${r.skipped_ids.length} finding(s) as ${r.status}: ${r.skipped_ids.join(", ")}`);
        return null;
    },
    plan_unskip: (r) => {
        if (r.status === "not_found") return r.message;
        console.log(`✓ Unskipped ${r.unskipped_ids.length} finding(s): ${r.unskipped_ids.join(", ")}`);
        return null;
    },
    plan_reopen: (r) => {
        if (r.status === "not_found") return r.message;
        console.log(`✓ Reopened ${(r.reopened_ids || []).length} finding(s): ${(r.reopened_ids || []).join(", ")}`);
        return null;
    },
    plan_reset: () => { console.log("✓ Living plan reset."); return null; },
    plan_promote: (r) => { console.log(`✓ Promoted ${(r.promoted_ids || []).length} finding(s) into active queue.`); return null; },
    plan_backlog: (r) => { console.log(`✓ Demoted ${(r.demoted_ids || []).length} finding(s) to backlog.`); return null; },
    plan_describe: (r) => {
        if (!r.ok) return r.error || r.message;
        console.log(`✓ Annotated ${(r.updated_ids || []).length} finding(s).`);
        return null;
    },
    plan_note: (r) => PLAN_STATUS_PRINTERS.plan_describe(r),
    plan_policy: (r) => {
        if (!r.ok) return r.error;
        console.log(`✓ Policy (${r.sub_action}): ${(r.policies || []).length} active policy rule(s).`);
        return null;
    },
    plan_scan_gate: (r) => {
        if (!r.ok) return r.error;
        console.log(`✓ Scan gate status: ${r.status}`);
        return null;
    },
    plan_repair_state: (r) => {
        console.log(`✓ Repaired state from plan (${(r.repaired_ids || []).length} issue(s) synced).`);
        return null;
    },
};

function printPlanSubcommandResult(action, result) {
    const key = action === "resolve" ? "plan_resolve" : result.action;
    const printer = PLAN_STATUS_PRINTERS[key];
    if (printer) {
        const errMsg = printer(result);
        if (errMsg) {
            console.error(`✗ ${errMsg}`);
            process.exitCode = 1;
        }
        return true;
    }
    if (result.action === "plan_triage" && result.prompt) {
        console.log(result.prompt);
        return true;
    }
    if (result.action === "plan_cluster" && result.exported) {
        console.log(result.exported);
        return true;
    }
    if (result.action === "plan_commit_log") return printCommitLogResult(result);
    return false;
}

function printHealthMutationResult(action, result) {
    if (printPlanSubcommandResult(action, result)) return true;
    if (action === "autofix") {
        if (result.git_dirty_warning) console.log(`  ⚠ ${result.git_dirty_warning}`);
        console.log(
            `plexer health autofix (${result.fixer}${result.dry_run ? ", dry-run" : ""}) — ${result.total_edits} edit(s) across ${result.files_changed} file(s)` +
                (result.reconciled_issue_ids?.length > 0 ? ` (${result.reconciled_issue_ids.length} state issue(s) marked fixed)` : ""),
        );
        for (const c of result.changes) {
            for (const e of c.edits) console.log(`  ${c.file}:L${e.line} [${e.fixer}] ${e.before} → ${e.after}`);
        }
        return true;
    }
    if (result.action === "review_run_batches") {
        if (result.status === "failed" || result.status === "error") {
            console.error(`✗ review --run-batches failed (${result.batches_completed}/${result.batches_attempted} completed)`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Completed ${result.batches_completed}/${result.batches_attempted} review batch(es) via ${result.runner}. Strict score: ${result.scores?.strict}%`);
        return true;
    }
    if (action === "move") {
        console.log(`plexer health move${result.dry_run ? " (dry-run)" : ""}: ${result.from} → ${result.to} (${result.updated_importers.length} file(s) updated)`);
        for (const f of result.updated_importers) console.log(`  updated imports in ${f}`);
        return true;
    }
    if (result.action === "review_prepare") {
        console.log(`✓ Prepared blind review packet: ${result.blind_packet_path}`);
        console.log(`  Session ID: ${result.session_id} (${result.concerns_count || 0} concern signals included)`);
        console.log(`  Batches (${result.batches.length}):`);
        for (const b of result.batches) {
            console.log(`    Batch ${b.batch} (${b.theme}) → ${b.output_file}: ${b.dimensions.map((d) => d.id).join(", ")}`);
        }
        console.log(`  Import when done: plexer health review --import <merged.json> --attested-external --attest "${result.attest_example}"`);
        return true;
    }
    if (result.action === "review_import") {
        if (result.status === "error" || result.status === "target_anchored_reset") {
            console.error(`✗ ${result.message}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Imported ${result.imported_dimensions} dimension score(s) and ${result.imported_findings} review finding(s). Strict score: ${result.scores.strict}%`);
        return true;
    }
    return false;
}

export async function runHealthCommand(defaultDir, positionalArgs = [], opts = {}) {
    const { action, dir, callOpts } = parseHealthCliArgs(defaultDir, positionalArgs, opts);
    const result =
        callOpts.runStages || callOpts.runBatches || action === "autofix" || action === "move"
            ? await healthAsync(dir, callOpts)
            : await health(dir, callOpts);
    const format = opts.format || (opts.json ? "json" : opts.markdown ? "markdown" : "text");

    if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return result;
    }
    if (action === "prompt") {
        console.log(result.prompt);
        return result;
    }
    if (action === "tree") {
        console.log(result.tree_text);
        return result;
    }
    if (action === "viz") {
        console.log(
            `✓ Health treemap written to ${result.output_path} (${result.total_files} files, ${result.total_loc} LOC, ${result.open_issues} open issues)`,
        );
        return result;
    }
    if (action === "detect") {
        console.log(`plexer health detect (${result.detector}) — ${result.count} finding(s):`);
        for (const it of result.items) {
            console.log(`  [${it.tier} · ${it.severity} · ${it.detector}] ${it.file}:${it.span} — ${it.summary}`);
        }
        return result;
    }
    if (action === "suppress") {
        if (result.status !== "suppressed") {
            console.error(`✗ ${result.message}`);
            process.exitCode = 1;
            return result;
        }
        console.log(
            `✓ Suppressed pattern "${result.pattern}" (${result.suppressed_ids.length} issue(s) marked ${result.kind || "wontfix"}/suppressed). Strict score: ${result.scores.strict}%`,
        );
        return result;
    }
    if (format === "markdown" && (action === "scan" || action === "status" || action === "next")) {
        console.log(formatHealthMarkdown(result));
        return result;
    }
    if (action === "scan" || action === "next" || action === "backlog" || action === "status") {
        console.log(formatHealthText(result));
        return result;
    }
    if (action === "show") {
        return printHealthShowResult(result);
    }
    if (printHealthMutationResult(action, result)) {
        return result;
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
}
