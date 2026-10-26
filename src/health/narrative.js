/**
 * Narrative engine (`computeHeadline`, `computeReminders`, and phase directives).
 */
import { DEFAULT_TARGET_STRICT_SCORE } from "./constants.js";
import { detectReviewCoverage } from "./review.js";

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
 * Compute context-aware reminders with decay so agents get timely nudges without spam.
 */
export function computeReminders(state, scores, plan, config, command, totalProdFiles = 1) {
    const reminders = [];
    const openIssues = Object.values(state.issues || {}).filter(
        (i) => i.status === "open" && !i.suppressed,
    );

    if (
        command === "resolve" ||
        command === "autofix" ||
        command === "suppress" ||
        config?.needs_rescan ||
        (plan?.resolves_since_last_scan || 0) >= 3
    ) {
        reminders.push({
            type: "rescan_needed",
            message: "Rescan to verify fixes — cascading effects may resolve or surface issues.",
            command: "plexer health scan",
        });
    }

    if (openIssues.some((i) => i.tier === "T1" && i.fixer) && command !== "autofix") {
        reminders.push({
            type: "dry_run_first",
            message: "Auto-fixable T1 issues detected. Always preview with `--dry-run` before applying.",
            command: "plexer health autofix --dry-run",
        });
    }

    if (scores.wontfix_gap >= 3.0) {
        reminders.push({
            type: "wontfix_debt",
            message: `Wontfix debt is widening the lenient↔strict gap (${scores.wontfix_gap}% across ${scores.wontfix_count} items). Challenge past wontfix decisions to raise strict score.`,
            command: "plexer health show --status wontfix",
        });
    }

    const revCov = detectReviewCoverage(state, totalProdFiles);
    if (!scores.has_subjective) {
        reminders.push({
            type: "subjective_review_needed",
            message: "Subjective review dimensions (75% of overall pool) have not been scored yet.",
            command: "plexer health review --prepare",
        });
    } else if (revCov.stale && revCov.reason) {
        reminders.push({
            type: "subjective_review_stale",
            message: revCov.reason,
            command: "plexer health review --prepare",
        });
    }

    if (
        config?.commit_tracking_enabled !== false &&
        Array.isArray(plan?.uncommitted_resolved) &&
        plan.uncommitted_resolved.length >= 3
    ) {
        reminders.push({
            type: "uncommitted_work",
            message: `${plan.uncommitted_resolved.length} resolved findings are uncommitted. Commit your batch and run \`plexer health plan commit-log record\`.`,
            command: "plexer health plan commit-log",
        });
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
            message: `[Directive: ${activePhase}] ${directives[activePhase]}`,
            command: null,
        });
    }
    if (directives.workflow && activePhase !== "workflow") {
        reminders.unshift({
            type: "directive_workflow",
            message: `[Directive: workflow] ${directives.workflow}`,
            command: null,
        });
    }

    return reminders;
}
