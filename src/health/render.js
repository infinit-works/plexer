/**
 * Terminal (`text`), Markdown (`markdown`), and JSON (`json`) formatters for `plexer health`.
 */
import { buildWorkflowGuide } from "./constants.js";

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
        for (let i = 0; i < queue.items.length; i++) {
            const it = queue.items[i];
            lines.push(
                `  ${i + 1}. [${it.tier} · ${it.severity} · ${it.detector}] ${it.file}:${it.span} — ${it.summary}`,
            );
            if (it.suggestion) lines.push(`     Fix: ${it.suggestion}`);
            if (it.resolve_command) lines.push(`     Resolve: \`${it.resolve_command}\``);
        }
    }

    if (queue.clusters && queue.clusters.length > 0) {
        const activeClusters = queue.clusters.filter((c) => c.open_count > 0);
        if (activeClusters.length > 0) {
            lines.push("");
            lines.push(
                `Clusters: ${activeClusters.map((c) => `${c.name} (${c.open_count})`).join(", ")}`,
            );
        }
    }
}

export function formatHealthText(result) {
    const lines = [];
    const { scores, headline, diff, reminders, queue, showWorkflowGuide } = result;

    if (headline) {
        lines.push(`plexer health — ${headline}`);
    } else if (scores) {
        lines.push(
            `plexer health — strict ${scores.strict}% (north star) · overall ${scores.overall}% · objective ${scores.objective}% · verified ${scores.verified}%`,
        );
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
                `  ⚠ Suspect drop guard held ${diff.suspect_held_count} disappearance(s) because detector(s) [${(diff.suspect_detectors || []).join(", ")}] dropped from >=5 findings to 0. Pass --force-resolve to confirm.`,
            );
        }
    }

    if (scores?.mechanical_dimensions) {
        lines.push("");
        lines.push("Mechanical dimensions (25% pool):");
        for (const dim of Object.values(scores.mechanical_dimensions)) {
            lines.push(
                `  ${dim.name.padEnd(22)} ${String(dim.score.toFixed(1) + "%").padStart(6)}  (${dim.open_count} open / ${dim.potential} checks)`,
            );
        }
    }

    if (scores?.subjective_dimensions && scores.has_subjective) {
        lines.push("");
        lines.push(
            `Subjective dimensions (75% pool — pool score ${scores.subjective_pool_score}%):`,
        );
        for (const dim of Object.values(scores.subjective_dimensions)) {
            const label = dim.score === null ? "unassessed" : `${dim.score.toFixed(1)}%`;
            lines.push(`  ${dim.name.padEnd(22)} ${label.padStart(10)}  (weight ${dim.weight})`);
        }
    }

    if (queue) appendQueueLines(lines, queue);

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
            "| Dimension | Score | Open Findings | Checks |",
            "| :--- | :---: | :---: | :---: |",
        );
        for (const dim of Object.values(scores.mechanical_dimensions || {})) {
            lines.push(
                `| **${dim.name}** | ${dim.score.toFixed(1)}% | ${dim.open_count} | ${dim.potential} |`,
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
        for (const it of queue.items) {
            lines.push(
                `- **\`[${it.tier} · ${it.severity} · ${it.detector}]\` \`${it.file}:${it.span}\`** — ${it.summary}`,
            );
            if (it.suggestion) lines.push(`  - *Fix:* ${it.suggestion}`);
            if (it.resolve_command) lines.push(`  - *Resolve:* \`${it.resolve_command}\``);
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
