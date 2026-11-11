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

function parsePlanCliSubargs(args, callOpts) {
    const sub = (args[0] || "show").toLowerCase();
    callOpts.subAction = sub;
    const rest = args.slice(1);
    if (sub === "resolve" || sub === "skip" || sub === "reopen" || sub === "unskip" || sub === "backlog") {
        callOpts.patterns = rest;
    } else if (sub === "promote") {
        const parsed = parsePositionTail(rest, false);
        callOpts.position = parsed.position;
        if (parsed.target) callOpts.target = parsed.target;
        callOpts.patterns = parsed.patterns;
    } else if (sub === "reorder") {
        const parsed = parsePositionTail(rest, true);
        callOpts.position = parsed.position;
        if (parsed.target) callOpts.target = parsed.target;
        if (parsed.offset !== undefined) callOpts.offset = parsed.offset;
        callOpts.patterns = parsed.patterns;
    } else if (sub === "describe") {
        if (!callOpts.description && rest.length >= 2) {
            callOpts.description = rest[rest.length - 1];
            callOpts.patterns = rest.slice(0, -1);
        } else {
            callOpts.patterns = rest;
        }
    } else if (sub === "note") {
        if (!callOpts.note && rest.length >= 2) {
            callOpts.note = rest[rest.length - 1];
            callOpts.patterns = rest.slice(0, -1);
        } else {
            callOpts.patterns = rest;
        }
    } else if (sub === "cluster") {
        const cAct = (rest[0] || "list").toLowerCase();
        callOpts.clusterAction = cAct;
        if (cAct === "list") {
            callOpts.clusterName = null;
        } else if (cAct === "move") {
            if (!callOpts.to && rest.length >= 3) {
                callOpts.clusterName = rest[1];
                callOpts.patterns = rest.slice(2);
            } else {
                callOpts.patterns = rest.slice(1);
            }
        } else if (cAct === "merge") {
            callOpts.clusterName = rest[1];
            callOpts.targetCluster = rest[2];
            callOpts.patterns = rest.slice(2);
        } else if (cAct === "export") {
            callOpts.clusterName = rest[1];
            if (rest[2]) callOpts.exportFormat = rest[2];
        } else if (cAct === "import") {
            callOpts.importFile = rest[1] || callOpts.file || callOpts.import;
            callOpts.clusterName = rest[1];
        } else {
            callOpts.clusterName = rest[1];
            callOpts.patterns = rest.slice(2);
        }
    } else if (sub === "policy") {
        callOpts.policyAction = (rest[0] || "list").toLowerCase();
        if (rest.length > 1) callOpts.rule = rest.slice(1).join(" ");
    } else if (sub === "scan-gate" || sub === "scangate") {
        if (rest[0] === "reset" || callOpts.resetGate) callOpts.reset = true;
        if (rest[0] === "skip" || callOpts.skipGate) callOpts.skip = true;
    } else if (sub === "triage") {
        if (rest[0] && !callOpts.stagePrompt && !callOpts["stage-prompt"]) {
            callOpts.stagePrompt = rest[0];
        }
    } else if (sub === "focus") {
        callOpts.clusterName = rest[0] || null;
    } else if (sub === "commit-log") {
        callOpts.commitAction = rest[0] || "status";
    }
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

    if (opts.detailText !== undefined && callOpts.detail === undefined) {
        callOpts.detail = opts.detailText;
    } else if (opts.detailText !== undefined && action === "plan") {
        callOpts.detail = opts.detailText;
    }

    if (["scan", "next", "backlog", "status", "tree", "viz"].includes(action)) {
        if (args.length > 0 && isDirArg(args[0], dir)) {
            dir = applyTargetCandidate(args.shift(), dir, callOpts);
        }
    } else if (action === "show" || action === "resolve") {
        callOpts.patterns = args;
    } else if (action === "suppress") {
        callOpts.pattern = args[0];
        callOpts.patterns = args;
    } else if (action === "detect") {
        callOpts.detector = args[0] || opts.detector || "all";
        if (args[1] && isDirArg(args[1], dir)) {
            dir = applyTargetCandidate(args[1], dir, callOpts);
        }
    } else if (action === "exclude") {
        callOpts.target = args[0] || opts.target;
    } else if (action === "autofix") {
        callOpts.fixer = args[0] || "all";
    } else if (action === "move") {
        callOpts.src = args[0];
        callOpts.dst = args[1];
    } else if (action === "zone") {
        callOpts.subAction = args[0] === "set" || args[0] === "clear" ? args[0] : "show";
        callOpts.target = args[1] || opts.target;
        if (args[0] === "set") callOpts.zone = args[2];
    } else if (action === "config") {
        callOpts.subAction = args[0] === "set" || args[0] === "unset" ? args[0] : "show";
        callOpts.key = args[1];
        if (args[0] === "set") callOpts.value = args.slice(2).join(" ");
    } else if (action === "directives") {
        callOpts.subAction = args[0] === "set" || args[0] === "unset" ? args[0] : "show";
        callOpts.phase = args[1];
        if (args[0] === "set") callOpts.message = args.slice(2).join(" ");
    } else if (action === "plan") {
        parsePlanCliSubargs(args, callOpts);
    } else if (action === "review") {
        if (opts.import) callOpts.importFile = opts.import;
        if (opts.merge && typeof opts.merge === "string") callOpts.mergeDir = opts.merge;
    }

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

function printPlanSubcommandResult(action, result) {
    if (action === "resolve" || result.action === "plan_resolve") {
        if (result.status === "scan_gate_blocked" || result.status === "not_found") {
            console.error(`✗ ${result.message}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Resolved ${result.resolved_ids.length} finding(s): ${result.resolved_ids.join(", ")}`);
        if (result.suggested_commit) console.log(`  Suggested commit: ${result.suggested_commit}`);
        return true;
    }
    if (result.action === "plan_skip") {
        if (result.status === "attestation_invalid" || result.status === "not_found" || result.status === "confirm_required") {
            console.error(`✗ ${result.message || result.error}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Marked ${result.skipped_ids.length} finding(s) as ${result.status}: ${result.skipped_ids.join(", ")}`);
        return true;
    }
    if (result.action === "plan_unskip") {
        if (result.status === "not_found") {
            console.error(`✗ ${result.message}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Unskipped ${result.unskipped_ids.length} finding(s): ${result.unskipped_ids.join(", ")}`);
        return true;
    }
    if (result.action === "plan_reopen") {
        if (result.status === "not_found") {
            console.error(`✗ ${result.message}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Reopened ${(result.reopened_ids || []).length} finding(s): ${(result.reopened_ids || []).join(", ")}`);
        return true;
    }
    if (result.action === "plan_reset") {
        console.log("✓ Living plan reset.");
        return true;
    }
    if (result.action === "plan_promote") {
        console.log(`✓ Promoted ${(result.promoted_ids || []).length} finding(s) into active queue.`);
        return true;
    }
    if (result.action === "plan_backlog") {
        console.log(`✓ Demoted ${(result.demoted_ids || []).length} finding(s) to backlog.`);
        return true;
    }
    if (result.action === "plan_describe" || result.action === "plan_note") {
        if (!result.ok) {
            console.error(`✗ ${result.error || result.message}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Annotated ${(result.updated_ids || []).length} finding(s).`);
        return true;
    }
    if (result.action === "plan_policy") {
        if (!result.ok) {
            console.error(`✗ ${result.error}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Policy (${result.sub_action}): ${(result.policies || []).length} active policy rule(s).`);
        return true;
    }
    if (result.action === "plan_scan_gate") {
        if (!result.ok) {
            console.error(`✗ ${result.error}`);
            process.exitCode = 1;
            return true;
        }
        console.log(`✓ Scan gate status: ${result.status}`);
        return true;
    }
    if (result.action === "plan_repair_state") {
        console.log(`✓ Repaired state from plan (${(result.repaired_ids || []).length} issue(s) synced).`);
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
        callOpts.runStages || callOpts.runBatches
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
            `✓ Suppressed pattern "${result.pattern}" (${result.suppressed_ids.length} issue(s) marked wontfix/suppressed). Strict score: ${result.scores.strict}%`,
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
