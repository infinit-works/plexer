/**
 * Terminal (`text`), Markdown (`markdown`), and JSON (`json`) formatters for `plexer health`.
 */
import { buildWorkflowGuide } from "./constants.js";
import { SUSPECT_DROP_THRESHOLD } from "./state.js";

function appendQueueLines(lines, queue) {
    lines.push("");
    if (queue.focus_cluster) {
        lines.push(`Execution queue (focused on cluster "${queue.focus_cluster}"):`);
    } else {
        lines.push(`Execution queue (${queue.total_open} open):`);
    }

    for (const wf of queue.workflow_steps || []) {
        lines.push(`  • [WORKFLOW] ${wf.summary}`);
        lines.push(`    Action: \`${wf.primary_command}\``);
    }

    if (queue.items.length === 0 && (queue.workflow_steps || []).length === 0) {
        lines.push("  ✓ Execution queue is empty!");
    } else {
        let hasResolveCmd = false;
        for (let i = 0; i < queue.items.length; i++) {
            const it = queue.items[i];
            const impactVal = Number(it.score_impact ?? it.score_impact_detail?.deltaStrict ?? 0);
            const impactTag = impactVal > 0 ? ` (+${impactVal.toFixed(1)} pts)` : "";
            const descText = it.custom_description || it.summary;
            const idTag = it.id ? ` [${it.id}]` : "";
            lines.push(
                `  ${i + 1}. [${it.tier} · ${it.severity} · ${it.detector}] ${it.file}:${it.span} — ${descText}${impactTag}${idTag}`,
            );
            if (it.explanation) lines.push(`     Why: ${it.explanation}`);
            if (it.suggestion) lines.push(`     Fix: ${it.suggestion}`);
            if (it.resolve_command) hasResolveCmd = true;
        }
        if (hasResolveCmd) {
            lines.push('  Resolve: `plexer health resolve "<id>" --note "<fix summary>" --confirm`');
        }
    }

    if (queue.clusters && queue.clusters.length > 0) {
        const activeClusters = queue.clusters.filter((c) => c.open_count > 0);
        if (activeClusters.length > 0) {
            lines.push("");
            lines.push(
                `Clusters: ${activeClusters
                    .map((c) => {
                        const cImp = Number(c.score_impact ?? c.score_impact_detail?.deltaStrict ?? 0);
                        return `${c.name} (${c.open_count}${cImp > 0 ? `, +${cImp.toFixed(1)} pts` : ""})`;
                    })
                    .join(", ")}`,
            );
        }
    }

    const lanesObj = queue.lanes;
    if (lanesObj && Array.isArray(lanesObj.independent_lanes) && lanesObj.independent_lanes.length > 0) {
        lines.push("");
        lines.push(
            `Parallel workstream lanes (${lanesObj.independent_lanes.length} graph-disjoint lane(s)):`,
        );
        for (const ln of lanesObj.independent_lanes) {
            lines.push(
                `  • [${ln.lane_id}] ${ln.label} — ${ln.issue_count} finding(s), +${ln.score_impact.toFixed(1)} strict pts (${ln.files.slice(0, 3).join(", ")})`,
            );
        }
        if (lanesObj.strategy_hint) {
            lines.push(`  Strategy: ${lanesObj.strategy_hint}`);
        }
    }
}

function isCleanStatusDimension(dim) {
    const open = Number(dim.open_count ?? dim.open_review_issues ?? dim.open ?? 0);
    const drag = Number(dim.overall_drag ?? dim.drag ?? 0);
    if (open > 0 || Math.abs(drag) >= 0.005) return false;
    if (typeof dim.score !== "number" || !Number.isFinite(dim.score) || dim.score < 99.95) return false;
    if (dim.stale === true) return false;
    return true;
}

function appendMechanicalDimensions(lines, mechDims, compactStatus) {
    lines.push("");
    lines.push("Mechanical dimensions (25% pool):");
    let cleanCount = 0;
    for (const dim of Object.values(mechDims)) {
        if (compactStatus && isCleanStatusDimension(dim)) {
            cleanCount += 1;
            continue;
        }
        const dragTag =
            Number(dim.overall_drag) > 0
                ? `  (drag: -${Number(dim.overall_drag).toFixed(2)} pts)`
                : "";
        lines.push(
            `  ${dim.name.padEnd(22)} ${String(dim.score.toFixed(1) + "%").padStart(6)}  (${dim.open_count} open / ${dim.potential} checks)${dragTag}`,
        );
    }
    if (cleanCount > 0) {
        lines.push(`  +${cleanCount} clean dimensions at 100.0% (0 drag — pass --verbose for all)`);
    }
}

function appendSubjectiveDimensions(lines, scores, compactStatus) {
    lines.push("");
    lines.push(
        `Subjective dimensions (75% pool — pool score ${scores.subjective_pool_score}%):`,
    );
    let cleanCount = 0;
    for (const dim of Object.values(scores.subjective_dimensions)) {
        if (compactStatus && isCleanStatusDimension(dim)) {
            cleanCount += 1;
            continue;
        }
        const label = dim.score === null ? "unassessed" : `${dim.score.toFixed(1)}%`;
        const dragTag =
            Number(dim.overall_drag) > 0
                ? `  (drag: -${Number(dim.overall_drag).toFixed(2)} pts)`
                : "";
        lines.push(`  ${dim.name.padEnd(22)} ${label.padStart(10)}  (weight ${dim.weight})${dragTag}`);
    }
    if (cleanCount > 0) {
        lines.push(`  +${cleanCount} clean dimensions at 100.0% (0 drag — pass --verbose for all)`);
    }
}

export function formatHealthText(result) {
    const lines = [];
    const { action, scores, headline, diff, reminders, queue, lanes, showWorkflowGuide, verbose } = result;
    const isCompactQueue = (action === "next" || action === "backlog") && !verbose;
    const isCompactStatus = action === "status" && !verbose;

    if (headline) {
        lines.push(`plexer health — ${headline}`);
    } else if (!scores) {
        lines.push("plexer health");
    }

    if (scores) {
        lines.push(
            `scores: strict ${scores.strict}% · overall ${scores.overall}% · objective ${scores.objective}% · verified ${scores.verified}%` +
                (scores.wontfix_count > 0
                    ? ` · wontfix debt: ${scores.wontfix_gap}% (${scores.wontfix_count} items)`
                    : ""),
        );
    }

    if (diff) {
        const suspectPart =
            diff.suspect_held_count > 0
                ? `, ${diff.suspect_held_count} suspect-held [${(diff.suspect_detectors || []).join(", ")}]`
                : "";
        lines.push(
            `scan #${diff.scan_count}: ${diff.open_count} open (${diff.new_count} new, ${diff.auto_resolved_count} auto-resolved, ${diff.verified_fixed_count} verified fixed, ${diff.reopened_count} reopened${suspectPart})`,
        );
        if (diff.suspect_held_count > 0) {
            lines.push(
                `  ⚠ Suspect drop guard held ${diff.suspect_held_count} disappearance(s) because detector(s) [${(diff.suspect_detectors || []).join(", ")}] dropped from >=${SUSPECT_DROP_THRESHOLD} findings to 0. Pass --force-resolve to confirm.`,
            );
        }
    }

    if (!isCompactQueue && scores?.mechanical_dimensions) {
        appendMechanicalDimensions(lines, scores.mechanical_dimensions, isCompactStatus);
    }

    if (!isCompactQueue && scores?.subjective_dimensions && scores.has_subjective) {
        appendSubjectiveDimensions(lines, scores, isCompactStatus);
    }

    if (queue) {
        appendQueueLines(lines, lanes && !queue.lanes ? { ...queue, lanes } : queue);
    }

    if (Array.isArray(reminders) && reminders.length > 0) {
        lines.push("");
        lines.push("Reminders:");
        for (const r of reminders) {
            lines.push(`  • ${r.message}${r.command ? ` → \`${r.command}\`` : ""}`);
        }
    }

    if (showWorkflowGuide) {
        lines.push("");
        lines.push(buildWorkflowGuide());
    }

    return lines.join("\n");
}

export function formatHealthMarkdown(result) {
    const lines = [];
    const { scores, headline, diff, queue, reminders } = result;

    lines.push("## `plexer health` Report");
    if (headline) {
        lines.push("", `> ${headline}`);
    }

    if (scores) {
        lines.push(
            "",
            "| Score Variant | Value | Notes |",
            "| :--- | :---: | :--- |",
            `| **Strict (North Star)** | **${scores.strict}%** | Wontfix & unverified items count as open |`,
            `| **Overall (Lenient)** | ${scores.overall}% | Excludes wontfix items (gap: ${scores.wontfix_gap}%) |`,
            `| **Objective (Mechanical)** | ${scores.objective}% | Automated graph & AST detectors only |`,
            `| **Verified** | ${scores.verified}% | Only scanner-confirmed fixes credited |`,
        );

        lines.push(
            "",
            "### Mechanical Dimensions",
            "| Dimension | Score | Open Findings | Checks | Drag |",
            "| :--- | :---: | :---: | :---: | :---: |",
        );
        for (const dim of Object.values(scores.mechanical_dimensions || {})) {
            const dragCell = Number(dim.overall_drag) > 0 ? `drag: -${Number(dim.overall_drag).toFixed(2)} pts` : "0 pts";
            lines.push(
                `| **${dim.name}** | ${dim.score.toFixed(1)}% | ${dim.open_count} | ${dim.potential} | ${dragCell} |`,
            );
        }
    }

    if (diff) {
        lines.push(
            "",
            `**Scan #${diff.scan_count}:** ${diff.open_count} open (${diff.new_count} new, ${diff.auto_resolved_count} auto-resolved, ${diff.verified_fixed_count} verified fixed, ${diff.reopened_count} reopened).`,
        );
    }

    if (queue && queue.items.length > 0) {
        lines.push("", "### Prioritized Execution Queue (`plexer health next`)");
        let hasResolveCmd = false;
        for (const it of queue.items) {
            const impactVal = Number(it.score_impact ?? it.score_impact_detail?.deltaStrict ?? 0);
            const impactTag = impactVal > 0 ? ` (+${impactVal.toFixed(1)} pts)` : "";
            const idTag = it.id ? ` (\`${it.id}\`)` : "";
            lines.push(
                `- **\`[${it.tier} · ${it.severity} · ${it.detector}]\` \`${it.file}:${it.span}\`** — ${it.custom_description || it.summary}${impactTag}${idTag}`,
            );
            if (it.explanation) lines.push(`  - *Why:* ${it.explanation}`);
            if (it.suggestion) lines.push(`  - *Fix:* ${it.suggestion}`);
            if (it.resolve_command) hasResolveCmd = true;
        }
        if (hasResolveCmd) {
            lines.push('- *Resolve:* `plexer health resolve "<id>" --note "<fix summary>" --confirm`');
        }
    }

    if (Array.isArray(reminders) && reminders.length > 0) {
        lines.push("", "### Reminders");
        for (const r of reminders) {
            lines.push(`- ${r.message}${r.command ? ` (\`${r.command}\`)` : ""}`);
        }
    }

    return lines.join("\n");
}
