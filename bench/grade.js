#!/usr/bin/env node
/**
 * Deterministic transcript parser, cohort-symmetry verifier, and rubric/test
 * grader for the 12-task `plexer` A/B benchmark suite (`bench/tasks.js`).
 *
 * Usage:
 *   node bench/grade.js [--manifest bench/manifest.json] [--out bench/results.json]
 *
 * `manifest.json` maps each task ID (`T1`..`T12`) to its paired subagent
 * conversation IDs and isolated clone directories:
 *   {
 *     "T1": {
 *       "cold":   { "conversationId": "...", "cloneDir": "/tmp/plexer-ab-cold/kohls-admin" },
 *       "plexer": { "conversationId": "...", "cloneDir": "/tmp/plexer-ab-plexer/kohls-admin" }
 *     },
 *     ...
 *   }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";

const BRAIN_DIR = join(homedir(), ".gemini", "antigravity", "brain");
const CLI_BRAIN_DIR = join(homedir(), ".gemini", "antigravity-cli", "brain");

/**
 * Parse a subagent's or CLI session's transcript and compute:
 *  - `calls`: total tool calls invoked
 *  - `turns`: number of turns that invoked tools
 *  - `toolOutputTokens`: `Math.round(toolResponseBytes / 4)` across tool output steps
 *  - `uncachedInputTokens`: sum of new `input_tokens` across all turns
 *  - `cachedInputTokens`: sum of `cache_read` + `cache_creation` tokens across all turns
 *  - `cumulativeInputTokens`: `uncachedInputTokens + cachedInputTokens` across all turns
 *  - `finalContextTokens`: prompt context window (`input + cache_read + cache_creation`) on the final turn
 *  - `totalModelOutputTokens`: total model output tokens (including thinking tokens where reported)
 *  - `searchMs`: wall-clock time spent in tool-calling turns (first tool call -> last tool output)
 *  - `totalMs`: total wall-clock time from `USER_INPUT` to final response
 *  - `finalResponse`: text of the final response
 *  - `symmetryViolations`: any detected tool-permission errors or leaked foreign hooks
 */
function parseClaudeTranscript(filePath, arm) {
    const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const steps = [];
    for (const l of lines) {
        try {
            steps.push(JSON.parse(l));
        } catch {
            // ignore non-json lines
        }
    }

    let calls = 0;
    let turns = 0;
    let toolResponseBytes = 0;
    let uncachedInputTokens = 0;
    let cachedInputTokens = 0;
    let cumulativeInputTokens = 0;
    let turn1ContextTokens = 0;
    let turn1UncachedTokens = 0;
    let postTurn1UncachedTokens = 0;
    let cacheMissTurns = 0;
    let prevContextTokens = 0;
    let finalContextTokens = 0;
    let streamModelOutputTokens = 0;
    let resultModelOutputTokens = null;
    let firstToolTurnMs = null;
    let lastToolDoneMs = null;
    let lastPlannerMs = null;
    let resultDurationMs = null;
    let sessionId = filePath;
    const responseParts = [];
    const toolNames = [];
    const symmetryViolations = [];
    const seenUsageMsgIds = new Set();
    const seenToolTurnMsgIds = new Set();
    let didModifyFile = false;

    for (const step of steps) {
        if (step.session_id && sessionId === filePath) {
            sessionId = step.session_id;
        }
        const ts = step.timestamp ? Date.parse(step.timestamp) : null;
        if (step.type === "assistant" && step.message) {
            if (ts !== null)
                lastPlannerMs = ts;
            const msgId = step.message.id || `${ts}:${calls}`;
            if (!seenUsageMsgIds.has(msgId)) {
                seenUsageMsgIds.add(msgId);
                const u = step.message.usage || {};
                const stepUncached = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                const stepCacheRead = u.cache_read_input_tokens || 0;
                const stepCtx = stepUncached + stepCacheRead;
                if (seenUsageMsgIds.size === 1) {
                    turn1ContextTokens = stepCtx;
                    turn1UncachedTokens = stepUncached;
                } else {
                    if (stepCacheRead === 0 && prevContextTokens > 0 && stepUncached > prevContextTokens * 0.8) {
                        cacheMissTurns += 1;
                        postTurn1UncachedTokens += Math.max(0, stepCtx - prevContextTokens);
                    } else {
                        postTurn1UncachedTokens += stepUncached;
                    }
                }
                if (stepCtx > 0) {
                    prevContextTokens = stepCtx;
                }
                const rawInp = u.input_tokens || 0;
                const stepCached = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                uncachedInputTokens += rawInp;
                cachedInputTokens += stepCached;
                cumulativeInputTokens += rawInp + stepCached;
                if (rawInp + stepCached > 0) {
                    finalContextTokens = rawInp + stepCached;
                }
                streamModelOutputTokens += u.output_tokens || 0;
            }
            const content = Array.isArray(step.message.content) ? step.message.content : [];
            const toolUses = content.filter((c) => c.type === "tool_use");
            if (toolUses.length > 0) {
                if (!seenToolTurnMsgIds.has(msgId)) {
                    seenToolTurnMsgIds.add(msgId);
                    turns += 1;
                }
                calls += toolUses.length;
                if (firstToolTurnMs === null && ts !== null)
                    firstToolTurnMs = ts;
                for (const tu of toolUses) {
                    toolNames.push(tu.name);
                    if (tu.name === "Edit" || tu.name === "Write" || tu.name === "MultiEdit") {
                        didModifyFile = true;
                    }
                    const inputStr = JSON.stringify(tu.input || {});
                    if (inputStr.includes("bench/tasks.js")) {
                        symmetryViolations.push("Agent accessed bench/tasks.js");
                    }
                    const cmdStr = tu.name === "Bash" ? String(tu.input?.command || "") : "";
                    if (/\b(python3?|node\s+-e|sed\s+-[A-Za-z0-9]*i|perl\s+-[A-Za-z0-9]*i|tee\s+|cat\s*>|<<)/i.test(cmdStr)) {
                        didModifyFile = true;
                    }
                    if (
                        arm === "cold" &&
                        /(?:^|[;&|]\s*)plexer\s+(ask|callers|callees|impact|grep|skeleton|map|blast|read)\b/.test(cmdStr) &&
                        !cmdStr.includes("--all-matches")
                    ) {
                        symmetryViolations.push("Cold arm invoked plexer CLI");
                    }
                }
            }
            for (const c of content) {
                if (c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0) {
                    responseParts.push(c.text.trim());
                }
            }
        } else if (step.type === "user" && step.message) {
            if (ts !== null)
                lastToolDoneMs = ts;
            const content = Array.isArray(step.message.content) ? step.message.content : [];
            for (const c of content) {
                if (c.type === "tool_result") {
                    const text =
                        typeof c.content === "string"
                            ? c.content
                            : Array.isArray(c.content)
                              ? c.content.map((x) => x.text ?? JSON.stringify(x)).join("\n")
                              : JSON.stringify(c.content ?? "");
                    toolResponseBytes += Buffer.byteLength(text, "utf8");
                }
            }
        } else if (step.type === "result") {
            if (typeof step.duration_ms === "number")
                resultDurationMs = step.duration_ms;
            if (step.usage && typeof step.usage.output_tokens === "number") {
                resultModelOutputTokens = step.usage.output_tokens;
                if (cumulativeInputTokens === 0) {
                    uncachedInputTokens = step.usage.input_tokens || 0;
                    cachedInputTokens =
                        (step.usage.cache_read_input_tokens || 0) +
                        (step.usage.cache_creation_input_tokens || 0);
                    cumulativeInputTokens = uncachedInputTokens + cachedInputTokens;
                }
            }
            if (typeof step.result === "string" && step.result.trim().length > 0) {
                responseParts.push(step.result.trim());
            }
        }
    }

    const totalModelOutputTokens = resultModelOutputTokens ?? streamModelOutputTokens;
    const finalResponse = responseParts.join("\n\n");
    const searchMs =
        firstToolTurnMs !== null && lastToolDoneMs !== null && lastToolDoneMs >= firstToolTurnMs
            ? lastToolDoneMs - firstToolTurnMs
            : calls === 0
              ? 0
              : resultDurationMs ?? 0;
    const totalMs =
        resultDurationMs ??
        (firstToolTurnMs !== null && lastPlannerMs !== null && lastPlannerMs >= firstToolTurnMs
            ? lastPlannerMs - firstToolTurnMs
            : searchMs);

    const netContextGrowthTokens = Math.max(0, finalContextTokens - turn1ContextTokens);

    return {
        conversationId: sessionId,
        calls,
        turns,
        toolOutputTokens: Math.round(toolResponseBytes / 4),
        uncachedInputTokens,
        cachedInputTokens,
        cumulativeInputTokens,
        turn1ContextTokens,
        turn1UncachedTokens,
        postTurn1UncachedTokens,
        netContextGrowthTokens,
        cacheMissTurns,
        finalContextTokens,
        totalModelOutputTokens,
        searchMs,
        totalMs,
        toolNames,
        finalResponse,
        symmetryViolations,
        didModifyFile,
    };
}

export function parseTranscript(conversationId, arm, streamDurationMs = null) {
    if ((conversationId.endsWith(".jsonl") || conversationId.endsWith(".jsonl.tmp")) && existsSync(conversationId)) {
        const rawLines = readFileSync(conversationId, "utf8").split("\n").filter((l) => l.trim().length > 0);
        const firstLine = rawLines[0];
        if (firstLine) {
            try {
                const firstObj = JSON.parse(firstLine);
                if (firstObj.event === "init" && firstObj.conversation_id) {
                    let durMs = null;
                    for (let i = rawLines.length - 1; i >= 0; i--) {
                        try {
                            const obj = JSON.parse(rawLines[i]);
                            if (obj.event === "result" && typeof obj.result?.duration_seconds === "number") {
                                durMs = Math.round(obj.result.duration_seconds * 1000);
                                break;
                            }
                        } catch {
                            // ignore
                        }
                    }
                    const cliBrainTranscript = join(
                        CLI_BRAIN_DIR,
                        firstObj.conversation_id,
                        ".system_generated",
                        "logs",
                        "transcript_full.jsonl"
                    );
                    const cliBrainCompact = join(
                        CLI_BRAIN_DIR,
                        firstObj.conversation_id,
                        ".system_generated",
                        "logs",
                        "transcript.jsonl"
                    );
                    if (existsSync(cliBrainTranscript) || existsSync(cliBrainCompact)) {
                        return parseTranscript(firstObj.conversation_id, arm, durMs);
                    }
                }
            } catch {
                // fall through
            }
        }
        return parseClaudeTranscript(conversationId, arm);
    }
    const primaryLogDir = join(BRAIN_DIR, conversationId, ".system_generated", "logs");
    const cliLogDir = join(CLI_BRAIN_DIR, conversationId, ".system_generated", "logs");
    const logDir = existsSync(primaryLogDir) ? primaryLogDir : cliLogDir;
    const fullPath = join(logDir, "transcript_full.jsonl");
    const compactPath = join(logDir, "transcript.jsonl");
    const filePath = existsSync(fullPath) ? fullPath : compactPath;
    if (!existsSync(filePath)) {
        throw new Error(`Transcript not found for conversation ${conversationId} at ${filePath}`);
    }

    const lines = readFileSync(filePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const steps = lines.map((l) => JSON.parse(l));

    let calls = 0;
    let turns = 0;
    let toolResponseBytes = 0;
    let uncachedInputTokens = 0;
    let cachedInputTokens = 0;
    let cumulativeInputTokens = 0;
    let turn1ContextTokens = 0;
    let turn1UncachedTokens = 0;
    let postTurn1UncachedTokens = 0;
    let cacheMissTurns = 0;
    let prevContextTokens = 0;
    let plannerStepCount = 0;
    let finalContextTokens = 0;
    let totalModelOutputTokens = 0;
    let firstUserMs = null;
    let firstToolTurnMs = null;
    let lastToolDoneMs = null;
    let lastPlannerMs = null;
    const responseParts = [];
    const toolNames = [];
    const symmetryViolations = [];
    let didModifyFile = false;

    for (const step of steps) {
        const ts = step.created_at ? Date.parse(step.created_at) : null;
        if ((step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE") && firstUserMs === null && ts !== null) {
            firstUserMs = ts;
        }
        if ((step.type === "EPHEMERAL_MESSAGE" || step.type === "SYSTEM_MESSAGE") && typeof step.content === "string") {
            if (arm === "cold" && (step.content.includes("plexer/INDEX.md") || step.content.includes("[plexer]"))) {
                symmetryViolations.push(`${step.type} leaked plexer/INDEX.md hook`);
            }
        }
        if (step.type === "PLANNER_RESPONSE") {
            if (ts !== null)
                lastPlannerMs = ts;
            plannerStepCount += 1;
            const stepUncached = step.input_tokens || 0;
            const stepCached = step.cache_read_tokens || 0;
            const stepCtx = stepUncached + stepCached;
            if (plannerStepCount === 1) {
                turn1ContextTokens = stepCtx;
                turn1UncachedTokens = stepUncached;
            } else {
                if (stepCached === 0 && prevContextTokens > 0 && stepUncached > prevContextTokens * 0.8) {
                    cacheMissTurns += 1;
                    postTurn1UncachedTokens += Math.max(0, stepCtx - prevContextTokens);
                } else {
                    postTurn1UncachedTokens += stepUncached;
                }
            }
            if (stepCtx > 0) {
                prevContextTokens = stepCtx;
            }
            uncachedInputTokens += stepUncached;
            cachedInputTokens += stepCached;
            cumulativeInputTokens += stepUncached + stepCached;
            if (stepUncached + stepCached > 0) {
                finalContextTokens = stepUncached + stepCached;
            }
            totalModelOutputTokens += step.output_tokens || 0;
            const tc = Array.isArray(step.tool_calls) ? step.tool_calls : [];
            const workCalls = [];
            for (const call of tc) {
                if (call.name === "send_message") {
                    const msg = call.args?.Message;
                    if (typeof msg === "string" && msg.trim().length > 0) {
                        responseParts.push(msg.trim());
                    }
                } else {
                    workCalls.push(call);
                }
            }
            if (workCalls.length > 0) {
                turns += 1;
                calls += workCalls.length;
                if (firstToolTurnMs === null && ts !== null) {
                    firstToolTurnMs = ts;
                }
                for (const call of workCalls) {
                    toolNames.push(call.name);
                    if (
                        call.name === "edit_file" ||
                        call.name === "write_file" ||
                        call.name === "write_to_file" ||
                        call.name === "replace_file_content" ||
                        call.name === "multi_replace_file_content" ||
                        call.name === "sed_file"
                    ) {
                        didModifyFile = true;
                    }
                    const argStr = JSON.stringify(call.args || {});
                    if (argStr.includes("bench/tasks.js")) {
                        symmetryViolations.push("Agent accessed bench/tasks.js");
                    }
                    let cmdStr = call.name === "run_command" ? String(call.args?.CommandLine || "") : "";
                    if (cmdStr.startsWith('"') && cmdStr.endsWith('"')) {
                        try {
                            cmdStr = JSON.parse(cmdStr);
                        } catch {
                            cmdStr = cmdStr.slice(1, -1);
                        }
                    }
                    if (/\b(python3?|node\s+-e|sed\s+-[A-Za-z0-9]*i|perl\s+-[A-Za-z0-9]*i|tee\s+|cat\s*>|<<)/i.test(cmdStr)) {
                        didModifyFile = true;
                    }
                    if (
                        arm === "cold" &&
                        /(?:^|[;&|]\s*)plexer\s+(ask|callers|callees|impact|grep|skeleton|map|blast|read)\b/.test(cmdStr) &&
                        !cmdStr.includes("--all-matches")
                    ) {
                        symmetryViolations.push("Cold arm invoked plexer CLI");
                    }
                }
            }
            if (typeof step.content === "string" && step.content.trim().length > 0) {
                responseParts.push(step.content.trim());
            }
        }
        if (step.type === "GENERIC" && typeof step.content === "string") {
            const content = step.content;
            // Strip the 2-line Created At / Completed At header when counting tool output bytes
            const body = content.replace(/^Created At:[^\n]*\nCompleted At:[^\n]*\n/, "");
            if (/^Message sent to "/.test(body.trim())) {
                continue;
            }
            toolResponseBytes += Buffer.byteLength(body, "utf8");

            const completedMatch = content.match(/^Completed At:\s*([^\n]+)/m);
            const completedMs = completedMatch ? Date.parse(completedMatch[1].trim()) : ts;
            if (completedMs && !Number.isNaN(completedMs)) {
                lastToolDoneMs = completedMs;
            } else if (ts !== null) {
                lastToolDoneMs = ts;
            }

            if (/tool is disabled|permission denied to run tool|enable_write_tools/i.test(content)) {
                symmetryViolations.push(`Tool permission error in step ${step.step_index}`);
            }
        }
    }

    const finalResponse = responseParts.join("\n\n");
    const searchMs =
        firstToolTurnMs !== null && lastToolDoneMs !== null && lastToolDoneMs >= firstToolTurnMs
            ? lastToolDoneMs - firstToolTurnMs
            : 0;
    const transcriptTotalMs =
        firstUserMs !== null && lastPlannerMs !== null && lastPlannerMs >= firstUserMs
            ? lastPlannerMs - firstUserMs
            : searchMs;
    const totalMs = streamDurationMs !== null ? Math.max(transcriptTotalMs, streamDurationMs) : transcriptTotalMs;

    const netContextGrowthTokens = Math.max(0, finalContextTokens - turn1ContextTokens);

    return {
        conversationId,
        calls,
        turns,
        toolOutputTokens: Math.round(toolResponseBytes / 4),
        uncachedInputTokens,
        cachedInputTokens,
        cumulativeInputTokens,
        turn1ContextTokens,
        turn1UncachedTokens,
        postTurn1UncachedTokens,
        netContextGrowthTokens,
        cacheMissTurns,
        finalContextTokens,
        totalModelOutputTokens,
        searchMs,
        totalMs,
        toolNames,
        finalResponse,
        symmetryViolations,
        didModifyFile,
    };
}

/**
 * Grade a single arm's result against a task's deterministic rubric / test suite.
 */
export function gradeTaskArm(task, parsed, cloneDir) {
    let score = 0;
    let maxScore = 0;
    const checks = [];
    if (task.category === "code-edit" && !parsed.didModifyFile) {
        parsed.symmetryViolations.push("Code-edit task completed without any file-modifying tool call (dirty worktree)");
    }

    for (const item of task.rubric) {
        maxScore += item.weight;
        let passed = false;
        let detail = "";
        try {
            if (typeof item.verifyEdit === "function") {
                passed = Boolean(parsed.didModifyFile && item.verifyEdit(cloneDir));
            } else if (typeof item.test === "function") {
                passed = Boolean(item.test(parsed.finalResponse));
            }
        } catch (err) {
            passed = false;
            detail = err?.stderr ? String(err.stderr).slice(0, 300) : String(err?.message || err).slice(0, 300);
        }
        if (passed) {
            score += item.weight;
        }
        checks.push({
            id: item.id,
            description: item.description,
            weight: item.weight,
            passed,
            ...(detail ? { detail } : {}),
        });
    }

    return { score, maxScore, checks };
}

function pctDelta(plexerVal, coldVal) {
    if (!coldVal)
        return "0%";
    const d = Math.round(((plexerVal - coldVal) / coldVal) * 100);
    return `${d > 0 ? "+" : ""}${d}%`;
}

function fmtSec(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

export function gradeManifest(manifestPath, outPath, activeTaskIds = null) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const prevResults = outPath && existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
    const prevByTask = new Map((prevResults?.tasks ?? []).map((t) => [t.id, t]));
    const rows = [];
    const allViolations = [];

    for (const task of TASKS) {
        const entry = manifest[task.id] || {};
        const prevTask = prevByTask.get(task.id);
        const hasCold = Boolean(entry.cold?.conversationId || prevTask?.cold);
        const hasPlexer = Boolean(entry.plexer?.conversationId || prevTask?.plexer);
        if (!hasCold || !hasPlexer) {
            continue;
        }

        const coldMetrics =
            (!activeTaskIds || activeTaskIds.has(`${task.id}:cold`)) &&
            entry.cold?.conversationId &&
            existsSync(entry.cold.conversationId)
                ? parseTranscript(entry.cold.conversationId, "cold")
                : prevTask?.cold;
        const plexerMetrics =
            (!activeTaskIds || activeTaskIds.has(`${task.id}:plexer`)) &&
            entry.plexer?.conversationId &&
            existsSync(entry.plexer.conversationId)
                ? parseTranscript(entry.plexer.conversationId, "plexer")
                : prevTask?.plexer;
        if (!coldMetrics || !plexerMetrics) {
            continue;
        }

        const canReuseCold =
            (!activeTaskIds || !activeTaskIds.has(`${task.id}:cold`)) &&
            prevTask?.cold?.score !== undefined;
        const canReusePlexer =
            (!activeTaskIds || !activeTaskIds.has(`${task.id}:plexer`)) &&
            prevTask?.plexer?.score !== undefined;
        const canReuseTrail =
            (!activeTaskIds || !activeTaskIds.has(`${task.id}:trail`)) &&
            prevTask?.trail?.score !== undefined;

        const coldGrade = canReuseCold
            ? { score: prevTask.cold.score, maxScore: prevTask.cold.maxScore, checks: prevTask.cold.checks }
            : gradeTaskArm(task, coldMetrics, entry.cold?.cloneDir || prevTask?.cold?.cloneDir);
        const plexerGrade = canReusePlexer
            ? { score: prevTask.plexer.score, maxScore: prevTask.plexer.maxScore, checks: prevTask.plexer.checks }
            : gradeTaskArm(task, plexerMetrics, entry.plexer?.cloneDir || prevTask?.plexer?.cloneDir);

        let trailCombined = null;
        if (entry.trail?.conversationId || prevTask?.trail) {
            const trailMetrics =
                (!activeTaskIds || activeTaskIds.has(`${task.id}:trail`)) &&
                entry.trail?.conversationId &&
                existsSync(entry.trail.conversationId)
                    ? parseTranscript(entry.trail.conversationId, "trail")
                    : prevTask?.trail;
            if (trailMetrics) {
                const trailGrade = canReuseTrail
                    ? { score: prevTask.trail.score, maxScore: prevTask.trail.maxScore, checks: prevTask.trail.checks }
                    : gradeTaskArm(task, trailMetrics, entry.trail?.cloneDir || prevTask?.trail?.cloneDir);
                for (const v of trailMetrics.symmetryViolations ?? []) {
                    allViolations.push(`${task.id} (trail): ${v}`);
                }
                trailCombined = {
                    ...trailMetrics,
                    ...trailGrade,
                    cloneDir: entry.trail?.cloneDir || prevTask?.trail?.cloneDir,
                };
            }
        }

        for (const v of coldMetrics.symmetryViolations ?? []) {
            allViolations.push(`${task.id} (cold): ${v}`);
        }
        for (const v of plexerMetrics.symmetryViolations ?? []) {
            allViolations.push(`${task.id} (plexer): ${v}`);
        }

        rows.push({
            id: task.id,
            category: task.category,
            repo: task.repo,
            holdout: task.holdout,
            title: task.title,
            cold: { ...coldMetrics, ...coldGrade, cloneDir: entry.cold?.cloneDir || prevTask?.cold?.cloneDir },
            plexer: { ...plexerMetrics, ...plexerGrade, cloneDir: entry.plexer?.cloneDir || prevTask?.plexer?.cloneDir },
            ...(trailCombined ? { trail: trailCombined } : {}),
        });
    }

    const totals = rows.reduce(
        (acc, r) => {
            for (const arm of ["cold", "plexer"]) {
                acc[arm].calls += r[arm].calls;
                acc[arm].turns += r[arm].turns;
                acc[arm].toolOutputTokens += r[arm].toolOutputTokens;
                acc[arm].uncachedInputTokens += r[arm].uncachedInputTokens;
                acc[arm].cachedInputTokens += r[arm].cachedInputTokens;
                acc[arm].cumulativeInputTokens += r[arm].cumulativeInputTokens;
                acc[arm].turn1ContextTokens += r[arm].turn1ContextTokens || 0;
                acc[arm].turn1UncachedTokens += r[arm].turn1UncachedTokens || 0;
                acc[arm].postTurn1UncachedTokens += r[arm].postTurn1UncachedTokens || 0;
                acc[arm].netContextGrowthTokens += r[arm].netContextGrowthTokens || 0;
                acc[arm].cacheMissTurns += r[arm].cacheMissTurns || 0;
                acc[arm].finalContextTokens += r[arm].finalContextTokens;
                acc[arm].totalModelOutputTokens += r[arm].totalModelOutputTokens;
                acc[arm].searchMs += r[arm].searchMs;
                acc[arm].totalMs += r[arm].totalMs;
                acc[arm].score += r[arm].score;
                acc[arm].maxScore += r[arm].maxScore;
            }

            if (r.plexer.toolOutputTokens < r.cold.toolOutputTokens)
                acc.tokenWins += 1;
            else if (r.plexer.toolOutputTokens > r.cold.toolOutputTokens)
                acc.tokenLosses += 1;
            else
                acc.tokenTies += 1;

            if (r.plexer.calls < r.cold.calls)
                acc.callWins += 1;
            else if (r.plexer.calls > r.cold.calls)
                acc.callLosses += 1;
            else
                acc.callTies += 1;

            if (r.plexer.searchMs < r.cold.searchMs)
                acc.speedWins += 1;
            else if (r.plexer.searchMs > r.cold.searchMs)
                acc.speedLosses += 1;
            else
                acc.speedTies += 1;

            return acc;
        },
        {
            cold: {
                calls: 0,
                turns: 0,
                toolOutputTokens: 0,
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cumulativeInputTokens: 0,
                turn1ContextTokens: 0,
                turn1UncachedTokens: 0,
                postTurn1UncachedTokens: 0,
                netContextGrowthTokens: 0,
                cacheMissTurns: 0,
                finalContextTokens: 0,
                totalModelOutputTokens: 0,
                searchMs: 0,
                totalMs: 0,
                score: 0,
                maxScore: 0,
            },
            plexer: {
                calls: 0,
                turns: 0,
                toolOutputTokens: 0,
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cumulativeInputTokens: 0,
                turn1ContextTokens: 0,
                turn1UncachedTokens: 0,
                postTurn1UncachedTokens: 0,
                netContextGrowthTokens: 0,
                cacheMissTurns: 0,
                finalContextTokens: 0,
                totalModelOutputTokens: 0,
                searchMs: 0,
                totalMs: 0,
                score: 0,
                maxScore: 0,
            },
            tokenWins: 0,
            tokenTies: 0,
            tokenLosses: 0,
            callWins: 0,
            callTies: 0,
            callLosses: 0,
            speedWins: 0,
            speedTies: 0,
            speedLosses: 0,
        }
    );

        const trailRows = rows.filter((r) => r.trail);
    let trailComparison = undefined;
    if (trailRows.length > 0) {
        const emptyArm = () => ({
            calls: 0,
            turns: 0,
            toolOutputTokens: 0,
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cumulativeInputTokens: 0,
            turn1ContextTokens: 0,
            turn1UncachedTokens: 0,
            postTurn1UncachedTokens: 0,
            netContextGrowthTokens: 0,
            cacheMissTurns: 0,
            finalContextTokens: 0,
            totalModelOutputTokens: 0,
            searchMs: 0,
            totalMs: 0,
            score: 0,
            maxScore: 0,
        });
        trailComparison = trailRows.reduce(
            (acc, r) => {
                for (const arm of ["cold", "trail", "plexer"]) {
                    acc[arm].calls += r[arm].calls;
                    acc[arm].turns += r[arm].turns;
                    acc[arm].toolOutputTokens += r[arm].toolOutputTokens;
                    acc[arm].uncachedInputTokens += r[arm].uncachedInputTokens;
                    acc[arm].cachedInputTokens += r[arm].cachedInputTokens;
                    acc[arm].cumulativeInputTokens += r[arm].cumulativeInputTokens;
                    acc[arm].turn1ContextTokens += r[arm].turn1ContextTokens || 0;
                    acc[arm].turn1UncachedTokens += r[arm].turn1UncachedTokens || 0;
                    acc[arm].postTurn1UncachedTokens += r[arm].postTurn1UncachedTokens || 0;
                    acc[arm].netContextGrowthTokens += r[arm].netContextGrowthTokens || 0;
                    acc[arm].cacheMissTurns += r[arm].cacheMissTurns || 0;
                    acc[arm].finalContextTokens += r[arm].finalContextTokens;
                    acc[arm].totalModelOutputTokens += r[arm].totalModelOutputTokens;
                    acc[arm].searchMs += r[arm].searchMs;
                    acc[arm].totalMs += r[arm].totalMs;
                    acc[arm].score += r[arm].score;
                    acc[arm].maxScore += r[arm].maxScore;
                }
                return acc;
            },
            { taskIds: trailRows.map((r) => r.id), cold: emptyArm(), trail: emptyArm(), plexer: emptyArm() }
        );
    }

    const serializeArm = (a) => ({
        conversationId: a.conversationId,
        calls: a.calls,
        turns: a.turns,
        toolOutputTokens: a.toolOutputTokens,
        uncachedInputTokens: a.uncachedInputTokens,
        cachedInputTokens: a.cachedInputTokens,
        cumulativeInputTokens: a.cumulativeInputTokens,
        turn1ContextTokens: a.turn1ContextTokens || 0,
        turn1UncachedTokens: a.turn1UncachedTokens || 0,
        postTurn1UncachedTokens: a.postTurn1UncachedTokens || 0,
        netContextGrowthTokens: a.netContextGrowthTokens || 0,
        cacheMissTurns: a.cacheMissTurns || 0,
        finalContextTokens: a.finalContextTokens,
        totalModelOutputTokens: a.totalModelOutputTokens,
        searchMs: a.searchMs,
        totalMs: a.totalMs,
        score: a.score,
        maxScore: a.maxScore,
        checks: a.checks,
    });

    const summary = {
        generatedAt: new Date().toISOString(),
        symmetryCheck: {
            passed: allViolations.length === 0,
            violations: allViolations,
        },
        totals: {
            ...totals,
            ...(trailComparison ? { trailComparison } : {}),
        },
        tasks: rows.map((r) => ({
            id: r.id,
            category: r.category,
            repo: r.repo,
            holdout: r.holdout,
            title: r.title,
            cold: serializeArm(r.cold),
            plexer: serializeArm(r.plexer),
            ...(r.trail ? { trail: serializeArm(r.trail) } : {}),
        })),
    };

    if (outPath) {
        writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }

    console.log("# Live 12-Task Subagent A/B Evaluation Results\n");
    console.log(
        `Symmetry Check: ${summary.symmetryCheck.passed ? "PASSED (0 violations)" : `FAILED (${allViolations.join("; ")})`}\n`
    );
    console.log(
        "| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |"
    );
    console.log(
        "| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |"
    );
    for (const r of rows) {
        const repoLabel = r.holdout ? `\`${r.repo}\` *(holdout)*` : `\`${r.repo}\``;
        console.log(
            `| **${r.id}** ${r.title} | \`${r.category}\` | ${repoLabel} | ${r.cold.calls} (${r.cold.turns}) | **${r.plexer.calls} (${r.plexer.turns})** (${pctDelta(r.plexer.calls, r.cold.calls)}) | ${r.cold.toolOutputTokens.toLocaleString()} | **${r.plexer.toolOutputTokens.toLocaleString()}** (${pctDelta(r.plexer.toolOutputTokens, r.cold.toolOutputTokens)}) | ${fmtSec(r.cold.searchMs)} (${fmtSec(r.cold.totalMs)}) | **${fmtSec(r.plexer.searchMs)}** (${fmtSec(r.plexer.totalMs)}) (${pctDelta(r.plexer.searchMs, r.cold.searchMs)}) | ${r.cold.score}/${r.cold.maxScore} | **${r.plexer.score}/${r.plexer.maxScore}** |`
        );
    }
    console.log(
        `| **Total (T1–T12)** | — | **6 repos** | **${totals.cold.calls} (${totals.cold.turns})** | **${totals.plexer.calls} (${totals.plexer.turns}) (${pctDelta(totals.plexer.calls, totals.cold.calls)})** | **${totals.cold.toolOutputTokens.toLocaleString()}** | **${totals.plexer.toolOutputTokens.toLocaleString()} (${pctDelta(totals.plexer.toolOutputTokens, totals.cold.toolOutputTokens)})** | **${fmtSec(totals.cold.searchMs)} (${fmtSec(totals.cold.totalMs)})** | **${fmtSec(totals.plexer.searchMs)} (${fmtSec(totals.plexer.totalMs)}) (${pctDelta(totals.plexer.searchMs, totals.cold.searchMs)})** | **${totals.cold.score}/${totals.cold.maxScore}** | **${totals.plexer.score}/${totals.plexer.maxScore}** |`
    );
    console.log(
        `\nWin / Tie / Loss (plexer vs cold across 12 tasks):\n` +
            `- Tool Output Tokens: ${totals.tokenWins}W / ${totals.tokenTies}T / ${totals.tokenLosses}L\n` +
            `- Tool Calls:         ${totals.callWins}W / ${totals.callTies}T / ${totals.callLosses}L\n` +
            `- Search Wall Time:   ${totals.speedWins}W / ${totals.speedTies}T / ${totals.speedLosses}L\n`
    );

    return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    let manifestPath = resolve(import.meta.dirname, "manifest.json");
    let outPath = resolve(import.meta.dirname, "results.json");
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--manifest" && args[i + 1]) {
            manifestPath = resolve(args[++i]);
        } else if (args[i] === "--out" && args[i + 1]) {
            outPath = resolve(args[++i]);
        }
    }
    gradeManifest(manifestPath, outPath);
}
