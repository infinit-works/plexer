/**
 * Deterministic source, AST, type, catch, slop, security, and first-class Luau/Roblox
 * detectors for `plexer health`.
 */
import { extname } from "node:path";
import { WALK_RELATIONS } from "../context/symbol-query.js";
import { spanRange } from "../util/span.js";
import { DETECTOR_CATEGORY } from "./constants.js";
import { mintIssueId } from "./state.js";
import {
    SCORED_ZONES,
    hasInlineSuppression,
    hasWordToken,
    stepLuauBlockDepth,
    stripCodeStringsAndComments,
} from "./zones.js";

const AI_PROSE_RE =
    /^\s*(?:\/\/|#|--)\s*(?:Here we|This function simply|Now we will|Note that we|As requested|TODO:\s*implement later|Step \d+:\s+(?:Initialize|Return|Check|Validate)|Helper function to|Function that)\b/i;

function isLuauFile(relPath) {
    const ext = extname(relPath).toLowerCase();
    return ext === ".luau" || ext === ".lua";
}

function isClientRobloxPath(relPath) {
    const norm = relPath.replace(/\\/g, "/");
    return (
        /(?:^|\/)(?:Client|StarterPlayer|StarterPlayerScripts|StarterCharacterScripts|StarterGui|ReplicatedFirst)\//i.test(
            norm,
        ) || /\.client\.(?:luau|lua)$/i.test(norm)
    );
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 3;
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, idx) => idx);
    for (let j = 1; j <= n; j++) {
        let prev = dp[0];
        dp[0] = j;
        for (let i = 1; i <= m; i++) {
            const temp = dp[i];
            if (a[i - 1] === b[j - 1]) {
                dp[i] = prev;
            } else {
                dp[i] = 1 + Math.min(prev, dp[i], dp[i - 1]);
            }
            prev = temp;
        }
    }
    return dp[m];
}

const SECRET_TOKEN_PATTERNS = [
    { label: "Anthropic API secret key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
    { label: "OpenAI/API secret key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { label: "GitHub personal access token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
    { label: "AWS access key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { label: "Stripe live secret key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
    { label: "Slack access token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
    { label: "PEM private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const PLACEHOLDER_SECRET_RE =
    /^(?:xxx+|test\w*|dummy\w*|example\w*|sample\w*|placeholder\w*|your_?\w*|change_?me\w*|none|null|todo\w*|<[^>]+>|\$\{[^}]+\})$/i;

function checkStaleDeprecationsInFile(relPath, lines, fileSymbols, incomingByTarget, potentials, issues) {
    for (const sym of fileSymbols) {
        potentials.stale_deprecations += 1;
        const range = spanRange(sym.span);
        if (!range) continue;
        const lookbackStart = Math.max(0, range.start - 5);
        const headerWindow = lines.slice(lookbackStart, range.start + 1).join("\n");
        if (/@deprecated\b|#\[deprecated/i.test(headerWindow)) {
            const callers = [...(incomingByTarget.get(sym.id) || [])].filter((cid) => cid !== sym.id);
            if (callers.length > 0 && !hasInlineSuppression(lines, range.start, "stale_deprecations")) {
                issues.push({
                    id: mintIssueId("stale_deprecations", relPath, sym.name),
                    detector: "stale_deprecations",
                    category: DETECTOR_CATEGORY.stale_deprecations || "slop",
                    dimension: "code_quality",
                    tier: "T3",
                    confidence: "high",
                    severity: "medium",
                    file: relPath,
                    line: range.start,
                    end_line: range.end,
                    span: sym.span,
                    identifier: sym.name,
                    summary: `Deprecated ${sym.kind} \`${sym.name}\` still has ${callers.length} active caller(s) in the graph.`,
                    suggestion: `Migrate the ${callers.length} caller(s) of \`${sym.name}\` (check with \`plexer callers ${sym.name}\`) and remove the deprecated shim.`,
                });
            }
        }
    }
}

function checkSlopAndTypeBypassesOnLine(relPath, lines, lineNum, trimmed, flags, issues) {
    if (flags.allowSlop) {
        if (AI_PROSE_RE.test(trimmed) && !hasInlineSuppression(lines, lineNum, "ai_slop")) {
            issues.push({
                id: mintIssueId("ai_slop", relPath, `L${lineNum}`),
                detector: "ai_slop",
                category: "slop",
                dimension: "code_quality",
                tier: "T1",
                confidence: "medium",
                severity: "low",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `L${lineNum}`,
                summary: `AI filler / restatement comment on L${lineNum}: \`${trimmed.slice(0, 70)}\``,
                suggestion: `Delete the restatement comment on L${lineNum} unless it documents a non-obvious invariant.`,
            });
        }
        if (
            /\b(?:console\.log|print)\s*\(\s*["'`](?:DEBUG|TEMP|FIXME|HERE\b|TODO)/i.test(trimmed) &&
            !hasInlineSuppression(lines, lineNum, "debug_logs")
        ) {
            issues.push({
                id: mintIssueId("debug_logs", relPath, `L${lineNum}`),
                detector: "debug_logs",
                category: "slop",
                dimension: "code_quality",
                tier: "T1",
                confidence: "high",
                severity: "low",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `L${lineNum}`,
                fixer: "debug-logs",
                summary: `Stray debug log statement on L${lineNum}: \`${trimmed.slice(0, 70)}\``,
                suggestion: `Remove the debug print on L${lineNum} (or run \`plexer health autofix debug-logs\`).`,
            });
        }
    }

    if (flags.allowTypes && (flags.isTs || flags.isLuau || flags.isPy)) {
        const raw = lines[lineNum - 1] || trimmed;
        const codeOnly = stripCodeStringsAndComments(raw, flags.isLuau, flags.isPy);
        const isTsBypass = flags.isTs && (/\bas\s+any\b|:\s*any\b/.test(codeOnly) || /@ts-ignore\b/.test(trimmed));
        const isLuauBypass = flags.isLuau && (/::\s*any\b/.test(codeOnly) || /^--!nocheck\b/.test(trimmed));
        const isPyBypass = flags.isPy && /#\s*type:\s*ignore\s*$/.test(trimmed);
        if ((isTsBypass || isLuauBypass || isPyBypass) && !hasInlineSuppression(lines, lineNum, "type_bypasses")) {
            issues.push({
                id: mintIssueId("type_bypasses", relPath, `L${lineNum}`),
                detector: "type_bypasses",
                category: "types",
                dimension: "code_quality",
                tier: "T2",
                confidence: "high",
                severity: "low",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `L${lineNum}`,
                summary: `Unsound type bypass on L${lineNum}: \`${trimmed.slice(0, 70)}\``,
                suggestion: `Replace the \`any\` / unguarded type suppression with a concrete type or narrowed union.`,
            });
        }
    }
}

function checkJsTsSilentCatchOnLine(relPath, lines, i, lineNum, issues) {
    const blockLines = [];
    for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
        const bl = lines[k].trim();
        if (bl.startsWith("}")) break;
        if (bl && !bl.startsWith("//") && !bl.startsWith("/*") && !bl.startsWith("*")) {
            blockLines.push(bl);
        }
    }
    if (blockLines.length !== 1 || hasInlineSuppression(lines, lineNum, "silent_catches")) return;
    if (/^console\.(?:error|warn|log)\(/.test(blockLines[0])) {
        issues.push({
            id: mintIssueId("silent_catches", relPath, `log_only_L${lineNum}`),
            detector: "silent_catches",
            category: "catches",
            dimension: "code_quality",
            tier: "T3",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum + 2,
            span: `L${lineNum}-L${lineNum + 2}`,
            identifier: `log_only_catch_L${lineNum}`,
            summary: `Log-only \`catch\` block at L${lineNum} logs the error and continues execution without rethrowing or returning a fallback.`,
            suggestion: `Propagate the error, return an explicit error result, or document why continuing after failure is safe.`,
        });
    } else if (/^return\s+undefined\s*;?$/.test(blockLines[0])) {
        issues.push({
            id: mintIssueId("silent_catches", relPath, `empty_return_L${lineNum}`),
            detector: "silent_catches",
            category: "catches",
            dimension: "code_quality",
            tier: "T3",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum + 2,
            span: `L${lineNum}-L${lineNum + 2}`,
            identifier: `catch_return_empty_L${lineNum}`,
            summary: `Broad \`catch\` block at L${lineNum} masks exceptions as \`${blockLines[0]}\`.`,
            suggestion: `Narrow the caught error type or surface the failure explicitly to callers.`,
        });
    }
}

function checkPySilentExceptOnLine(relPath, lines, i, lineNum, trimmed, issues) {
    const nextLine = (lines[i + 1] || "").trim();
    const afterNext = (lines[i + 2] || "").trim();
    const isSwallowedNext = nextLine === "pass" || /^return\s+(?:\[\]|\{\}|None)$/.test(nextLine) || /^(?:logger|logging|print)\b/.test(nextLine);
    if (!isSwallowedNext || /^(?:raise|return)\b/.test(afterNext) || hasInlineSuppression(lines, lineNum, "silent_catches"))
        return;
    issues.push({
        id: mintIssueId("silent_catches", relPath, `py_except_L${lineNum}`),
        detector: "silent_catches",
        category: "catches",
        dimension: "code_quality",
        tier: "T3",
        confidence: "high",
        severity: "medium",
        file: relPath,
        line: lineNum,
        end_line: lineNum + 1,
        span: `L${lineNum}-L${lineNum + 1}`,
        identifier: `except_L${lineNum}`,
        summary: `Broad \`${trimmed}\` block at L${lineNum} swallows or masks errors via \`${nextLine}\`.`,
        suggestion: `Catch only specific expected exception types or re-raise unexpected errors.`,
    });
}
function extractPcallWindowText(lines, startIdx) {
    let pcallDepth = 0;
    let sawPcallOpen = false;
    const callLines = [];
    for (let k = startIdx; k < Math.min(lines.length, startIdx + 8); k++) {
        const cLine = stripCodeStringsAndComments(lines[k] || "", true, false);
        callLines.push(cLine);
        for (let p = 0; p < cLine.length; p++) {
            if (cLine[p] === "(") {
                pcallDepth += 1;
                sawPcallOpen = true;
            } else if (cLine[p] === ")") {
                pcallDepth = Math.max(0, pcallDepth - 1);
            }
        }
        if (sawPcallOpen && pcallDepth === 0) break;
    }
    return callLines.join("\n");
}
function checkLuauSilentPcallOnLine(relPath, lines, i, lineNum, raw, issues) {
    if (!/^\s*(?:local\s+_(?:\s*,\s*_)*\s*=\s*)?pcall\s*\(/.test(raw) || isLuauContinuationLine(lines, i))
        return;
    if (hasInlineSuppression(lines, lineNum, "silent_catches"))
        return;
    const pcallWindow = extractPcallWindowText(lines, i);
    const isBestEffortCleanup = /(?::|\.)(?:Destroy|Disconnect|ClearAllChildren|SetCore|SetCoreGuiEnabled)\b|\btask\.cancel\b|\bcancel\s*\(/.test(pcallWindow);
    if (isBestEffortCleanup)
        return;
    issues.push({
        id: mintIssueId("silent_catches", relPath, `luau_pcall_L${lineNum}`),
        detector: "silent_catches",
        category: "catches",
        dimension: "code_quality",
        tier: "T2",
        confidence: "high",
        severity: "medium",
        file: relPath,
        line: lineNum,
        end_line: lineNum,
        span: `L${lineNum}-L${lineNum}`,
        identifier: `pcall_L${lineNum}`,
        summary: `Unchecked \`pcall(...)\` at L${lineNum} discards \`(ok, err)\` and silently ignores runtime failures.`,
        suggestion: `Capture \`local ok, err = pcall(...)\` and handle or warn on \`not ok\`.`,
    });
}
function checkSilentCatchesOnLine(relPath, lines, i, lineNum, raw, trimmed, flags, issues) {
    if (!flags.allowCatches) return;
    if (flags.isJsTs && /\bcatch\s*(?:\([^)]*\))?\s*\{/.test(trimmed))
        checkJsTsSilentCatchOnLine(relPath, lines, i, lineNum, issues);
    else if (flags.isPy && /^except(?:\s+Exception|\s*:)/.test(trimmed))
        checkPySilentExceptOnLine(relPath, lines, i, lineNum, trimmed, issues);
    else if (flags.isLuau)
        checkLuauSilentPcallOnLine(relPath, lines, i, lineNum, raw, issues);
}

const CLIENT_SERVER_SERVICE_ACCESS_RE =
    /\bgame\s*(?::\s*GetService\s*\(\s*["'](ServerScriptService|ServerStorage|DataStoreService|MemoryStoreService|MessagingService)["']\s*\)|\.\s*(ServerScriptService|ServerStorage|DataStoreService|MemoryStoreService|MessagingService)\b(?!\s*=))/;

const CLIENT_SERVER_API_ACCESS_RE =
    /\b(?:(HttpService\s*:\s*(?:GetAsync|PostAsync|RequestAsync))|(TeleportService\s*:\s*ReserveServer)|(InsertService\s*:\s*LoadAsset)|(BadgeService\s*:\s*AwardBadge))\s*\(|\b(MarketplaceService\.ProcessReceipt)\s*=/;

function isLuauContinuationLine(lines, idx) {
    for (let k = idx - 1; k >= 0 && k >= idx - 4; k--) {
        const prevCode = stripCodeStringsAndComments(lines[k] || "", true, false).trim();
        if (!prevCode) continue;
        return /(?:[=,{(\[+\-*/%^#]|(?:\.\.)|\b(?:return|and|or|not|in)\b)\s*$/.test(prevCode);
    }
    return false;
}

function checkLuauSecurityOnLine(relPath, lines, i, lineNum, trimmed, issues) {
    if (
        isClientRobloxPath(relPath) &&
        !trimmed.startsWith("--") &&
        !hasInlineSuppression(lines, lineNum, "roblox_security")
    ) {
        const rawLine = lines[i] || trimmed;
        const noComment = rawLine.replace(/--.*$/, "");
        const codeOnly = stripCodeStringsAndComments(rawLine, true, false);
        const svcMatch = /\bgame\b/.test(codeOnly) ? CLIENT_SERVER_SERVICE_ACCESS_RE.exec(noComment) : null;
        const apiMatch = !svcMatch ? CLIENT_SERVER_API_ACCESS_RE.exec(codeOnly) : null;
        if (svcMatch || apiMatch) {
            const targetLabel = svcMatch
                ? svcMatch[1] || svcMatch[2]
                : (apiMatch[1] || apiMatch[2] || apiMatch[3] || apiMatch[4] || apiMatch[5] || "server API").replace(
                      /\s+/g,
                      "",
                  );
            issues.push({
                id: mintIssueId("roblox_security", relPath, `client_server_L${lineNum}`),
                detector: "roblox_security",
                category: "security",
                dimension: "security",
                tier: "T2",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `client_server_boundary_L${lineNum}`,
                summary: `Client script/module \`${relPath}\` accesses server-only Roblox service/API (\`${targetLabel}\`) on L${lineNum}.`,
                suggestion: `Keep \`${targetLabel}\` logic inside \`ServerScriptService\` and communicate from the client via validated \`RemoteEvent\` / \`RemoteFunction\` calls.`,
            });
        }
    }

    const remoteMatch =
        /\.(?:OnServerEvent:Connect|OnServerInvoke\s*=)\s*\(?\s*function\s*\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^,)]+)?\s*,\s*([^)]+)\)/.exec(
            trimmed,
        );
    if (remoteMatch && !hasInlineSuppression(lines, lineNum, "roblox_security")) {
        const payloadParams = remoteMatch[1]
            .split(",")
            .map((p) => p.split(":")[0].trim())
            .filter(Boolean);
        const allIgnoredParams = payloadParams.length > 0 && payloadParams.every((p) => /^_[A-Za-z0-9_]*$/.test(p));
        const bodyWindow = lines
            .slice(i + 1, Math.min(lines.length, i + 23))
            .map((l) => stripCodeStringsAndComments(l, true, false))
            .join("\n");
        if (
            !allIgnoredParams &&
            !/\b(?:typeof|type|tonumber|tostring|assert|validate|check|schema|sanitize)\b|\bt\.[A-Za-z_]/i.test(bodyWindow)
        ) {
            issues.push({
                id: mintIssueId("roblox_security", relPath, `unvalidated_remote_L${lineNum}`),
                detector: "roblox_security",
                category: "security",
                dimension: "security",
                tier: "T2",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: Math.min(lines.length, lineNum + 5),
                span: `L${lineNum}-L${Math.min(lines.length, lineNum + 5)}`,
                identifier: `remote_handler_L${lineNum}`,
                summary: `Server remote handler on L${lineNum} accepts client payload \`(${remoteMatch[1].trim()})\` without \`typeof\`/\`type\` validation in the entry guard.`,
                suggestion: `Validate every client argument with \`typeof(arg)\`, bounds/NaN checks (\`n == n\`), and server-side authority guards before acting on it.`,
            });
        }
    }
}

const LUAU_SCHEDULER_NAMES = new Set(["wait", "spawn", "delay"]);

function skipQuotedLiteralOnLine(line, startIdx, quoteCh) {
    let i = startIdx + 1;
    while (i < line.length) {
        if (line[i] === "\\") {
            i += 2;
            continue;
        }
        if (line[i] === quoteCh) return i + 1;
        i += 1;
    }
    return i;
}

function tryOpenLuauLongBracket(line, i) {
    const ch = line[i];
    if (ch === "-" && line[i + 1] === "-") {
        const lb = /^--\[(=*)\[/.exec(line.slice(i));
        return lb ? { comment: true, len: lb[0].length, close: `]${lb[1]}]` } : { comment: true };
    }
    if (ch === "[") {
        const lb = /^\[(=*)\[/.exec(line.slice(i));
        return lb ? { len: lb[0].length, close: `]${lb[1]}]` } : null;
    }
    return null;
}

function stripLuauLongBracketsOnLine(line, state) {
    let out = "";
    let i = 0;
    while (i < line.length) {
        if (state.longClose) {
            const idx = line.indexOf(state.longClose, i);
            if (idx === -1) return out;
            i = idx + state.longClose.length;
            state.longClose = null;
            out += " ";
            continue;
        }
        const bracket = tryOpenLuauLongBracket(line, i);
        if (bracket) {
            if (!bracket.close) break;
            state.longClose = bracket.close;
            i += bracket.len;
            if (!bracket.comment) out += '""';
            continue;
        }
        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === "`") {
            i = skipQuotedLiteralOnLine(line, i, ch);
            out += '""';
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

function collectShadowedLuauSchedulerNames(lines) {
    const shadowed = new Set();
    const longState = { longClose: null };
    for (const raw of lines) {
        const code = stripLuauLongBracketsOnLine(raw || "", longState);
        if (!code.trim()) continue;

        for (const m of code.matchAll(/\blocal\s+function\s+(wait|spawn|delay)\b/g)) {
            shadowed.add(m[1]);
        }
        const localStmt = /^\s*local\s+(.+?)(?:=|$)/.exec(code);
        if (localStmt && !/^function\b/.test(localStmt[1].trim())) {
            for (const part of localStmt[1].split(",")) {
                const ident = part.split(":")[0].trim();
                if (LUAU_SCHEDULER_NAMES.has(ident)) shadowed.add(ident);
            }
        }
        for (const m of code.matchAll(/\bfunction(?:\s+[A-Za-z0-9_.:]+)?\s*\(([^)]*)\)/g)) {
            for (const part of m[1].split(",")) {
                const ident = part.split(":")[0].trim();
                if (LUAU_SCHEDULER_NAMES.has(ident)) shadowed.add(ident);
            }
        }
    }
    return shadowed;
}

function stepLuauFnBlockStack(stack, code) {
    const re = /(?:^|[;])\s*\b(if)\b|\b(function|do|repeat|until|end)\b/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const tok = m[1] || m[2];
        if (tok === "function") stack.push("fn");
        else if (tok === "if" || tok === "do") stack.push("block");
        else if (tok === "repeat") stack.push("repeat");
        else if (tok === "until") {
            for (let idx = stack.length - 1; idx >= 0; idx--) {
                if (stack[idx] === "repeat") {
                    stack.splice(idx, 1);
                    break;
                }
            }
        } else if (tok === "end") {
            if (stack.length > 0) stack.pop();
        }
    }
}

function checkLuauSecurityAndTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, stateTracker, issues) {
    if (!flags.isLuau) return;
    const codeOnly = (stateTracker?.luauLineCode ?? stripCodeStringsAndComments(lines[i] || trimmed, true, false)).trim();
    if (!codeOnly) return;

    if (flags.allowSecurity) {
        checkLuauSecurityOnLine(relPath, lines, i, lineNum, trimmed, issues);
    }

    if (flags.allowTraps && !trimmed.startsWith("--")) {
        const schedMatch = /(?:^|[^.\w:])(wait|spawn|delay)\s*\(/.exec(codeOnly);
        if (schedMatch && !hasInlineSuppression(lines, lineNum, "luau_quality")) {
            const fnName = schedMatch[1];
            const isShadowed =
                stateTracker?.shadowedLuauSchedulers?.has(fnName) ||
                new RegExp(`\\bfunction\\s+(?:[A-Za-z0-9_.]+[.:])?${fnName}\\s*\\(`).test(codeOnly);
            if (!isShadowed) {
                issues.push({
                    id: mintIssueId("luau_quality", relPath, `legacy_${fnName}_L${lineNum}`),
                    detector: "luau_quality",
                    category: "traps",
                    dimension: "code_quality",
                    tier: "T1",
                    confidence: "high",
                    severity: "medium",
                    file: relPath,
                    line: lineNum,
                    end_line: lineNum,
                    span: `L${lineNum}-L${lineNum}`,
                    identifier: `${fnName}_L${lineNum}`,
                    fixer: "luau-task-scheduler",
                    summary: `Legacy Roblox scheduler global \`${fnName}(...)\` on L${lineNum} throttles at 30Hz; use \`task.${fnName}(...)\`.`,
                    suggestion: `Replace \`${fnName}(...)\` with \`task.${fnName}(...)\` (or run \`plexer health autofix luau-task-scheduler\`).`,
                });
            }
        }
        if (
            /\bInstance\.new\s*\(\s*["'][^"']+["']\s*,/.test(trimmed) &&
            !hasInlineSuppression(lines, lineNum, "luau_quality")
        ) {
            issues.push({
                id: mintIssueId("luau_quality", relPath, `instance_new_parent_L${lineNum}`),
                detector: "luau_quality",
                category: "traps",
                dimension: "code_quality",
                tier: "T2",
                confidence: "high",
                severity: "medium",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `Instance.new_L${lineNum}`,
                summary: `\`Instance.new(className, parent)\` 2-argument call on L${lineNum} parents the instance before properties are assigned, causing extra replication/layout passes.`,
                suggestion: `Call \`Instance.new(className)\` with 1 argument, assign all properties first, and set \`.Parent\` last.`,
            });
        }
        const fnDepthBeforeLine = stateTracker?.luauFnDepthBeforeLine ?? 0;
        if (
            fnDepthBeforeLine > 0 &&
            /^(?:local\s+_(?:\s*,\s*_)*\s*=\s*)?[A-Za-z0-9_.:[\]()\"']+:Connect\s*\(/.test(codeOnly) &&
            !isLuauContinuationLine(lines, i) &&
            !hasInlineSuppression(lines, lineNum, "luau_quality")
        ) {
            issues.push({
                id: mintIssueId("luau_quality", relPath, `untracked_connect_L${lineNum}`),
                detector: "luau_quality",
                category: "traps",
                dimension: "code_quality",
                tier: "T2",
                confidence: "medium",
                severity: "medium",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `Connect_L${lineNum}`,
                summary: `Bare \`:Connect(...)\` statement on L${lineNum} discards the returned \`RBXScriptConnection\`, risking a connection/memory leak.`,
                suggestion: `Store the connection in a cleanup scope/trove/table and disconnect it on teardown.`,
            });
        }
    }
}

function checkJsTsTrapsOnLine(relPath, lines, lineNum, trimmed, flags, stateTracker, issues) {
    if (!flags.isJsTs || trimmed.startsWith("//")) return;
    const codeLine = trimmed.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    if (/\.forEach\s*\(\s*async\b/.test(codeLine) && !hasInlineSuppression(lines, lineNum, "language_traps")) {
        issues.push({
            id: mintIssueId("language_traps", relPath, `foreach_async_L${lineNum}`),
            detector: "language_traps",
            category: "traps",
            dimension: "code_quality",
            tier: "T2",
            confidence: "high",
            severity: "high",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `forEach_async_L${lineNum}`,
            summary: `\`.forEach(async ...)\` on L${lineNum} does not await returned promises and swallows unhandled rejections.`,
            suggestion: `Use \`for (const item of items) { await ... }\` or \`await Promise.all(items.map(async ...))\`.`,
        });
    }
    if (flags.isReact && /\buseState\s*\(\s*(?:true|false)\s*\)/.test(trimmed)) {
        if (stateTracker.booleanStateCount === 0) stateTracker.firstBooleanStateLine = lineNum;
        stateTracker.booleanStateCount += 1;
    }
    if (
        flags.wantTraps &&
        /(?:\b(?:numbers|nums|scores|counts|values|ranks|weights|ages|prices|amounts|timestamps|totals)\b|\.\s*map\s*\(\s*(?:Number|parseInt|parseFloat)\s*\))\s*\.sort\s*\(\s*\)/.test(
            trimmed,
        ) &&
        !hasInlineSuppression(lines, lineNum, "language_traps")
    ) {
        issues.push({
            id: mintIssueId("language_traps", relPath, `sort_no_comparator_L${lineNum}`),
            detector: "language_traps",
            category: "traps",
            dimension: "code_quality",
            tier: "T2",
            confidence: "high",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `sort_L${lineNum}`,
            summary: `JS/TS \`.sort()\` without a comparator on L${lineNum} coerces elements to strings and sorts lexicographically (\`10 < 2\`).`,
            suggestion: `Pass an explicit numeric comparator \`.sort((a, b) => a - b)\`.`,
        });
    }
}

function checkLanguageTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, stateTracker, issues) {
    if (flags.isPy && !trimmed.startsWith("#")) {
        if (
            /\bdef\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*=\s*(?:\[\]|\{\}|set\(\))/.test(trimmed) &&
            !hasInlineSuppression(lines, lineNum, "language_traps")
        ) {
            issues.push({
                id: mintIssueId("language_traps", relPath, `py_mutable_default_L${lineNum}`),
                detector: "language_traps",
                category: "traps",
                dimension: "code_quality",
                tier: "T2",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `mutable_default_L${lineNum}`,
                summary: `Python mutable default argument (\`=[]\` / \`={}\`) on L${lineNum} is shared across all calls.`,
                suggestion: `Default the parameter to \`None\` and initialize a fresh container inside the function body.`,
            });
        }
        if (flags.wantSecurity && /\bsubprocess\.(?:run|call|check_call|check_output)\s*\(/.test(trimmed)) {
            const callWindow = lines.slice(i, Math.min(lines.length, i + 6)).join(" ");
            if (!/\btimeout\s*=/.test(callWindow) && !hasInlineSuppression(lines, lineNum, "security_traps")) {
                issues.push({
                    id: mintIssueId("security_traps", relPath, `subprocess_timeout_L${lineNum}`),
                    detector: "security_traps",
                    category: "security",
                    dimension: "security",
                    tier: "T2",
                    confidence: "high",
                    severity: "medium",
                    file: relPath,
                    line: lineNum,
                    end_line: lineNum,
                    span: `L${lineNum}-L${lineNum}`,
                    identifier: `subprocess_L${lineNum}`,
                    summary: `\`subprocess\` call at L${lineNum} has no \`timeout=\` guard and can hang indefinitely.`,
                    suggestion: `Pass an explicit \`timeout=<seconds>\` argument to the \`subprocess\` call.`,
                });
            }
        }
    }

    checkJsTsTrapsOnLine(relPath, lines, lineNum, trimmed, flags, stateTracker, issues);

    if (flags.isRust && flags.wantSecurity && /\bunsafe\s*\{/.test(trimmed)) {
        const prevWindow = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (!/\/\/\s*SAFETY:/i.test(prevWindow) && !hasInlineSuppression(lines, lineNum, "security_traps")) {
            issues.push({
                id: mintIssueId("security_traps", relPath, `rust_unsafe_L${lineNum}`),
                detector: "security_traps",
                category: "security",
                dimension: "security",
                tier: "T2",
                confidence: "high",
                severity: "medium",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `unsafe_L${lineNum}`,
                summary: `Rust \`unsafe\` block at L${lineNum} lacks a preceding \`// SAFETY:\` invariant comment.`,
                suggestion: `Document the safety invariants above L${lineNum} with a \`// SAFETY:\` comment.`,
            });
        }
    }

    if (flags.isGo && /\bdefer\s+/.test(trimmed)) {
        const prevWindow = lines.slice(Math.max(0, i - 6), i).join("\n");
        if (/\bfor\s+[^{]+\{/.test(prevWindow) && !hasInlineSuppression(lines, lineNum, "language_traps")) {
            issues.push({
                id: mintIssueId("language_traps", relPath, `go_defer_loop_L${lineNum}`),
                detector: "language_traps",
                category: "traps",
                dimension: "code_quality",
                tier: "T2",
                confidence: "medium",
                severity: "medium",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `defer_loop_L${lineNum}`,
                summary: `Go \`defer\` inside a \`for\` loop at L${lineNum} delays cleanup until the enclosing function exits.`,
                suggestion: `Extract the loop body into a helper function or close the resource explicitly at the end of each iteration.`,
            });
        }
    }
}

function checkHardcodedSecretsOnLine(relPath, lines, lineNum, trimmed, issues) {
    for (const pat of SECRET_TOKEN_PATTERNS) {
        if (
            pat.re.test(trimmed) &&
            !/\bre\s*:\s*\//.test(trimmed) &&
            !trimmed.includes("RegExp") &&
            !hasInlineSuppression(lines, lineNum, "security_traps")
        ) {
            issues.push({
                id: mintIssueId("security_traps", relPath, `hardcoded_secret_L${lineNum}`),
                detector: "security_traps",
                category: "security",
                dimension: "security",
                tier: "T2",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `secret_L${lineNum}`,
                summary: `Hardcoded ${pat.label} detected on L${lineNum}.`,
                suggestion: `Move the secret to an environment variable or secret store and rotate the exposed credential.`,
            });
            break;
        }
    }

    const secretVarMatch =
        /\b([A-Za-z0-9_]*(?:api_?key|secret_?access_?key|secret_?key|client_?secret|access_?token|private_?key|password|passwd|auth_?token))\s*[:=]\s*["']([^"']{8,})["']/i.exec(
            trimmed,
        );
    if (
        secretVarMatch &&
        !/\b(?:os\.environ|os\.getenv|process\.env|env\.|GetSecret)/i.test(trimmed) &&
        !PLACEHOLDER_SECRET_RE.test(secretVarMatch[2].trim()) &&
        !hasInlineSuppression(lines, lineNum, "security_traps")
    ) {
        issues.push({
            id: mintIssueId("security_traps", relPath, `secret_var_${secretVarMatch[1]}_L${lineNum}`),
            detector: "security_traps",
            category: "security",
            dimension: "security",
            tier: "T2",
            confidence: "high",
            severity: "high",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `${secretVarMatch[1]}_L${lineNum}`,
            summary: `Hardcoded secret assigned to \`${secretVarMatch[1]}\` on L${lineNum}.`,
            suggestion: `Load \`${secretVarMatch[1]}\` from environment configuration or a secrets manager.`,
        });
    }
}

function checkUniversalSecurityRulesOnLine(relPath, lines, lineNum, trimmed, flags, issues) {
    if (
        !flags.allowSecurity ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("--")
    ) {
        return;
    }

    const raw = lines[lineNum - 1] || trimmed;
    const codeOnly = stripCodeStringsAndComments(raw, flags.isLuau, flags.isPy);

    checkHardcodedSecretsOnLine(relPath, lines, lineNum, trimmed, issues);

    if (
        /\b(?:Math\.random|random\.random|random\.randint|math\.random)\s*\(/.test(codeOnly) &&
        /\b(?:token|secret|nonce|password|salt|auth|session_?id|api_?key|csrf|[A-Za-z0-9_]*(?:token|secret|nonce|password|salt|csrf))\b/i.test(
            codeOnly,
        ) &&
        !hasInlineSuppression(lines, lineNum, "security_traps")
    ) {
        issues.push({
            id: mintIssueId("security_traps", relPath, `insecure_random_L${lineNum}`),
            detector: "security_traps",
            category: "security",
            dimension: "security",
            tier: "T2",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `insecure_random_L${lineNum}`,
            summary: `Non-cryptographic RNG used in a security/token context on L${lineNum}.`,
            suggestion: `Use \`crypto.randomBytes\` / \`crypto.randomUUID\` (Node/JS) or \`secrets.token_hex\` (Python).`,
        });
    }

    if (
        /\b(?:hashlib\.(?:md5|sha1)\s*\(|crypto\.createHash\s*\(\s*["'](?:md5|sha1)["']\s*\))/.test(trimmed) &&
        !/\b(?:usedforsecurity\s*=\s*False|fingerprint|etag|checksum|cache)/i.test(trimmed) &&
        !hasInlineSuppression(lines, lineNum, "security_traps")
    ) {
        issues.push({
            id: mintIssueId("security_traps", relPath, `weak_crypto_L${lineNum}`),
            detector: "security_traps",
            category: "security",
            dimension: "security",
            tier: "T2",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `weak_crypto_L${lineNum}`,
            summary: `Weak cryptographic digest (\`md5\` / \`sha1\`) used on L${lineNum}.`,
            suggestion: `Use \`sha256\` (or \`scrypt\`/\`argon2\` for passwords) for security-sensitive hashing.`,
        });
    }

    if (
        /\b(?:console\.(?:log|info|debug|warn|error)|logger\.(?:info|debug|warning|error)|logging\.(?:info|debug|warning|error)|print)\s*\(/.test(
            codeOnly,
        ) &&
        /\b[A-Za-z0-9_]*(?:password|passwd|secret_?access_?key|secret_?key|client_?secret|api_?key|access_?token|auth_?token|private_?key|bearer_?token|secret|bearer)\b/i.test(
            codeOnly,
        ) &&
        !trimmed.includes("REDACTED") &&
        !trimmed.includes("***") &&
        !hasInlineSuppression(lines, lineNum, "security_traps")
    ) {
        issues.push({
            id: mintIssueId("security_traps", relPath, `sensitive_log_L${lineNum}`),
            detector: "security_traps",
            category: "security",
            dimension: "security",
            tier: "T2",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: `sensitive_log_L${lineNum}`,
            summary: `Log statement on L${lineNum} may expose sensitive credential/token data.`,
            suggestion: `Redact or omit secrets, passwords, and tokens before logging.`,
        });
    }
}

function checkPyMutableLruCacheTraps(relPath, lines, fileSymbols, issues) {
    const mutableGlobals = new Set();
    for (const rawLine of lines) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\{|\[|dict\(|list\(|set\()/.exec(rawLine);
        if (m) {
            const varName = m[1];
            if (!/^[A-Z0-9_]+$/.test(varName) || /(?:STATE|CACHE|STORE|REGISTRY|MUT|MAP|TABLE)/i.test(varName)) {
                mutableGlobals.add(varName);
            }
        }
    }
    if (mutableGlobals.size === 0) return;
    for (const sym of fileSymbols) {
        if (sym.kind !== "function") continue;
        const range = spanRange(sym.span);
        if (!range) continue;
        const decoWindow = lines.slice(Math.max(0, range.start - 4), range.start + 1).join("\n");
        if (!/@(?:functools\.)?(?:lru_cache|cache)\b/.test(decoWindow)) continue;
        const bodyText = lines.slice(range.start, range.end).join("\n");
        for (const gName of mutableGlobals) {
            if (new RegExp(`\\b${gName}\\b`).test(bodyText)) {
                issues.push({
                    id: mintIssueId("language_traps", relPath, `lru_cache_global_${sym.name}`),
                    detector: "language_traps",
                    category: "traps",
                    dimension: "code_quality",
                    tier: "T3",
                    confidence: "high",
                    severity: "high",
                    file: relPath,
                    line: range.start,
                    end_line: range.end,
                    span: sym.span,
                    identifier: sym.name,
                    summary: `\`@lru_cache\` function \`${sym.name}\` reads mutable module-level container \`${gName}\`, serving stale cached outputs when \`${gName}\` mutates.`,
                    suggestion: `Pass state explicitly into \`${sym.name}\`, invalidate the cache on mutation, or remove \`@lru_cache\`.`,
                });
                break;
            }
        }
    }
}

function checkLuauSymbolGetServiceTraps(relPath, lines, sym, seenGetServiceLines, issues) {
    if (sym.aliasOf || (sym.kind !== "function" && sym.kind !== "method"))
        return;
    const range = spanRange(sym.span);
    if (!range)
        return;
    const startLineTrim = (lines[range.start - 1] || "").trim();
    if (/^return\s+function\b/.test(startLineTrim))
        return;
    for (let ln = range.start; ln <= range.end && ln <= lines.length; ln++) {
        if (seenGetServiceLines.has(ln))
            continue;
        const codeText = stripCodeStringsAndComments(lines[ln - 1] || "", true, false);
        if (!/\bgame:GetService\s*\(/.test(codeText) || hasInlineSuppression(lines, ln, "luau_quality"))
            continue;
        const guardWindow = lines
            .slice(Math.max(range.start - 1, ln - 6), ln)
            .map((l) => stripCodeStringsAndComments(l, true, false))
            .join("\n");
        if (/\bpcall\s*\(|\bRunService\s*:\s*Is[A-Z]\w*\s*\(|\bIS_(?:SERVER|CLIENT|STUDIO)\b/.test(guardWindow))
            continue;
        seenGetServiceLines.add(ln);
        issues.push({
            id: mintIssueId("luau_quality", relPath, `service_in_fn_${sym.name}_L${ln}`),
            detector: "luau_quality",
            category: "traps",
            dimension: "code_quality",
            tier: "T2",
            confidence: "high",
            severity: "low",
            file: relPath,
            line: ln,
            end_line: ln,
            span: `L${ln}-L${ln}`,
            identifier: `GetService_L${ln}`,
            summary: `\`game:GetService(...)\` called inside ${sym.kind} \`${sym.name}\` on L${ln} instead of hoisted at module top-level.`,
            suggestion: `Hoist \`local Service = game:GetService(...)\` to the top of \`${relPath}\`.`,
        });
    }
}
function checkLuauAndPySymbolTraps(relPath, lines, fileSymbols, flags, stateTracker, issues) {
    if (flags.isLuau && flags.allowTraps) {
        const seenGetServiceLines = new Set();
        for (const sym of fileSymbols)
            checkLuauSymbolGetServiceTraps(relPath, lines, sym, seenGetServiceLines, issues);
    }
    if (flags.isPy && flags.allowTraps)
        checkPyMutableLruCacheTraps(relPath, lines, fileSymbols, issues);
    if (flags.isReact && stateTracker.booleanStateCount >= 5 && flags.wantTraps) {
        const ln = stateTracker.firstBooleanStateLine;
        issues.push({
            id: mintIssueId("language_traps", relPath, "react_boolean_state"),
            detector: "language_traps",
            category: "traps",
            dimension: "code_quality",
            tier: "T3",
            confidence: "medium",
            severity: "medium",
            file: relPath,
            line: ln,
            end_line: ln,
            span: `L${ln}-L${ln}`,
            identifier: "boolean_state_explosion",
            summary: `Component in \`${relPath}\` declares ${stateTracker.booleanStateCount} separate boolean \`useState\` flags, creating impossible state combinations.`,
            suggestion: `Consolidate the ${stateTracker.booleanStateCount} boolean flags into a single discriminated status union or \`useReducer\`.`,
        });
    }
}

function countNetBracketDelta(line) {
    const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
    let delta = 0;
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === "(" || c === "[" || c === "{") delta += 1;
        else if (c === ")" || c === "]" || c === "}") delta -= 1;
    }
    return delta;
}

function isUnreachableTerminatorLine(tLine) {
    return (
        /^(?:return(?:\s+[^?:]+)?|break|continue|throw\s+.+|raise(?:\s+.+)?|error\s*\(.+\))\s*;?$/.test(tLine) &&
        !/[+,\-*/|&?:({\[]\s*$/.test(tLine) &&
        !/\b(?:if|unless|when)\b/.test(tLine)
    );
}
function findNextNonContinuationLineIdx(fnLines, startIdx, initTrim) {
    let bracketDepth = Math.max(0, countNetBracketDelta(initTrim));
    let prevTrim = initTrim;
    let nextIdx = startIdx;
    while (nextIdx < fnLines.length) {
        const nl = fnLines[nextIdx].trim();
        if (!nl || nl.startsWith("//") || nl.startsWith("#") || nl.startsWith("--") || nl.startsWith("/*") || nl.startsWith("*")) {
            nextIdx += 1;
            continue;
        }
        const prevContinues = bracketDepth > 0 || /[+,\-*/|&?:=({\[\\]$|\.\.$|\b(?:and|or)\s*$/.test(prevTrim);
        const curContinues = /^(?:\.|\?|:|&&|\|\|)/.test(nl) || (bracketDepth > 0 && /^[)\]}]/.test(nl));
        if (!prevContinues && !curContinues)
            break;
        bracketDepth = Math.max(0, bracketDepth + countNetBracketDelta(nl));
        prevTrim = nl;
        nextIdx += 1;
    }
    return nextIdx;
}
function checkUnreachableInFunction(relPath, lines, sym, range, fnLines, issues) {
    for (let idx = 1; idx < fnLines.length - 1; idx++) {
        const rawLine = fnLines[idx];
        const tLine = rawLine.trim();
        if (!tLine || tLine.startsWith("//") || tLine.startsWith("#") || tLine.startsWith("--"))
            continue;
        if (!isUnreachableTerminatorLine(tLine))
            continue;
        const nextIdx = findNextNonContinuationLineIdx(fnLines, idx + 1, tLine);
        if (nextIdx >= fnLines.length)
            break;
        const termIndent = rawLine.match(/^\s*/)[0].length;
        const nextRaw = fnLines[nextIdx];
        const nextTrim = nextRaw.trim();
        const nextIndent = nextRaw.match(/^\s*/)[0].length;
        const closesBlock = /^(?:[})\]]|end\b|else\b|elseif\b|elif\b|except\b|catch\b|finally\b|case\b|default\b|when\b|#\[|@)/.test(nextTrim);
        if (nextIndent === termIndent && termIndent > 0 && !closesBlock) {
            const absLine = range.start + nextIdx;
            if (!hasInlineSuppression(lines, absLine, "language_traps")) {
                issues.push({
                    id: mintIssueId("language_traps", relPath, `unreachable_${sym.name}_L${absLine}`),
                    detector: "language_traps",
                    category: "traps",
                    dimension: "code_quality",
                    tier: "T2",
                    confidence: "high",
                    severity: "medium",
                    file: relPath,
                    line: absLine,
                    end_line: absLine,
                    span: `L${absLine}-L${absLine}`,
                    identifier: `unreachable_L${absLine}`,
                    summary: `Unreachable statement on L${absLine} in \`${sym.name}\` after unconditional \`${tLine.split(/\s+/)[0]}\`.`,
                    suggestion: `Remove the dead code on L${absLine} or fix the preceding control-flow guard.`,
                });
            }
            break;
        }
    }
}

function ensureTrackedDictEntry(tracked, vName) {
    let entry = tracked.get(vName);
    if (!entry) {
        entry = { writes: new Map(), reads: new Map(), initLocal: false };
        tracked.set(vName, entry);
    }
    return entry;
}
function recordDictRegexMatches(tracked, t, ln, re, bucket, swapGroups = false, requireExistingVar = false) {
    let m;
    while ((m = re.exec(t)) !== null) {
        const varName = swapGroups ? m[2] : m[1];
        const keyName = swapGroups ? m[1] : m[2];
        if (requireExistingVar && !tracked.has(varName))
            continue;
        const map = ensureTrackedDictEntry(tracked, varName)[bucket];
        if (!map.has(keyName))
            map.set(keyName, ln);
    }
}
function collectTrackedDictKeys(range, fnLines) {
    const tracked = new Map();
    for (let idx = 0; idx < fnLines.length; idx++) {
        const ln = range.start + idx;
        const t = fnLines[idx].trim();
        if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("--"))
            continue;
        const initMatch = /^(?:(?:local|const|let|var)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\{\s*\}|dict\(\s*\))\s*;?$/.exec(t);
        if (initMatch)
            ensureTrackedDictEntry(tracked, initMatch[1]).initLocal = true;
        recordDictRegexMatches(tracked, t, ln, /\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*["']([A-Za-z0-9_.-]+)["']\s*\]\s*=(?!=)/g, "writes");
        recordDictRegexMatches(tracked, t, ln, /\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*["']([A-Za-z0-9_.-]+)["']\s*\](?!\s*=(?!=))/g, "reads");
        recordDictRegexMatches(tracked, t, ln, /\b([A-Za-z_][A-Za-z0-9_]*)\.get\s*\(\s*["']([A-Za-z0-9_.-]+)["']/g, "reads");
        recordDictRegexMatches(tracked, t, ln, /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*(?:=[^=]|\())/g, "reads", false, true);
        const destructMatch = /^(?:const|let|var|local)\s*\{([^}]+)\}\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(t);
        if (destructMatch && tracked.has(destructMatch[2])) {
            const td = ensureTrackedDictEntry(tracked, destructMatch[2]);
            for (const rawKey of destructMatch[1].split(",")) {
                const key = rawKey.split(":")[0].split("=")[0].trim();
                if (key && !td.reads.has(key))
                    td.reads.set(key, ln);
            }
        }
        recordDictRegexMatches(tracked, t, ln, /["']([A-Za-z0-9_.-]+)["']\s+(?:not\s+)?in\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, "reads", true);
    }
    return tracked;
}

function reportDictKeyIssuesForVar(relPath, lines, sym, varName, td, escapes, issues) {
    for (const [rKey, rLine] of td.reads.entries()) {
        if (td.writes.has(rKey))
            continue;
        const nearMatch = [...td.writes.keys()].find(
            (wKey) => wKey.length >= 4 && rKey.length >= 4 && levenshtein(rKey, wKey) > 0 && levenshtein(rKey, wKey) <= 2,
        );
        if (nearMatch && !hasInlineSuppression(lines, rLine, "dict_keys")) {
            issues.push({
                id: mintIssueId("dict_keys", relPath, `drift_${varName}_${rKey}_L${rLine}`),
                detector: "dict_keys",
                category: "types",
                dimension: "code_quality",
                tier: "T3",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: rLine,
                end_line: rLine,
                span: `L${rLine}-L${rLine}`,
                identifier: `drift:${varName}.${rKey}`,
                summary: `Dict/table key schema drift in \`${sym.name}\`: reads \`${varName}["${rKey}"]\` on L${rLine}, which was never written (did you mean \`"${nearMatch}"\`?).`,
                suggestion: `Align the key name on L${rLine} with \`"${nearMatch}"\` or define a typed struct/interface.`,
            });
        }
    }
    if (escapes)
        return;
    for (const [wKey, wLine] of td.writes.entries()) {
        if (!td.reads.has(wKey) && !hasInlineSuppression(lines, wLine, "dict_keys")) {
            issues.push({
                id: mintIssueId("dict_keys", relPath, `dead_write_${varName}_${wKey}_L${wLine}`),
                detector: "dict_keys",
                category: "types",
                dimension: "code_quality",
                tier: "T3",
                confidence: "medium",
                severity: "medium",
                file: relPath,
                line: wLine,
                end_line: wLine,
                span: `L${wLine}-L${wLine}`,
                identifier: `dead_write:${varName}.${wKey}`,
                summary: `Dead dict/table write in \`${sym.name}\`: \`${varName}["${wKey}"]\` is written on L${wLine} but never read before \`${varName}\` goes out of scope.`,
                suggestion: `Remove the unused \`${varName}["${wKey}"]\` write or read the key where intended.`,
            });
        }
    }
}
function checkDictKeysInFunction(relPath, lines, sym, range, fnLines, potentials, issues) {
    potentials.dict_keys += 1;
    const tracked = collectTrackedDictKeys(range, fnLines);
    const fullFnText = fnLines.join("\n");
    for (const [varName, td] of tracked.entries()) {
        if (!td.initLocal || td.writes.size < 2 || td.reads.size < 1)
            continue;
        const escapedRe = new RegExp(
            `(?:\\breturn\\b[^;\\n]*\\b${varName}\\b(?!\\s*[\\[.])|\\breturn\\s*\\([^()]{0,400}?\\b${varName}\\b(?!\\s*[\\[.])|[A-Za-z0-9_.:]+\\s*\\([^()]{0,400}?\\b${varName}\\b(?!\\s*[\\[.])|\\.\\.\\.${varName}\\b|\\bfor\\b[^\\n]*\\b${varName}\\b|[=:,\\[]\\s*\\b${varName}\\b(?!\\s*[\\[.])|[{,]\\s*\\b${varName}\\b\\s*[,}])`,
        );
        reportDictKeyIssuesForVar(relPath, lines, sym, varName, td, escapedRe.test(fullFnText), issues);
    }
}

function checkAsyncFunctionMissingAwait(relPath, lines, sym, range, fnLines, issues) {
    if (sym.exported || range.end - range.start < 2)
        return;
    if (!/\basync\s+(?:function\b|[A-Za-z0-9_$]+\s*\()/.test(fnLines[0] || ""))
        return;
    const bodyJoined = fnLines.slice(1).join("\n");
    if (/\b(?:await|Promise|import\s*\(|throw\s+new\s+Error)\b/.test(bodyJoined))
        return;
    if (hasInlineSuppression(lines, range.start, "language_traps"))
        return;
    issues.push({
        id: mintIssueId("language_traps", relPath, `async_no_await_${sym.name}`),
        detector: "language_traps",
        category: "traps",
        dimension: "code_quality",
        tier: "T2",
        confidence: "medium",
        severity: "low",
        file: relPath,
        line: range.start,
        end_line: range.end,
        span: sym.span,
        identifier: sym.name,
        summary: `\`async\` ${sym.kind} \`${sym.name}\` contains no \`await\` expression and wraps its return value in an unnecessary Promise.`,
        suggestion: `Remove the \`async\` keyword from \`${sym.name}\` or \`await\` the intended asynchronous operation.`,
    });
}
function checkFunctionScopedTrapsAndDictKeys(relPath, lines, fileSymbols, flags, potentials, issues) {
    if (!flags.allowTraps && !flags.allowTypes)
        return;
    for (const sym of fileSymbols) {
        if (sym.kind !== "function" && sym.kind !== "method")
            continue;
        const range = spanRange(sym.span);
        if (!range || range.end <= range.start)
            continue;
        const fnLines = lines.slice(range.start - 1, range.end);
        if (flags.allowTraps && flags.isJsTs)
            checkAsyncFunctionMissingAwait(relPath, lines, sym, range, fnLines, issues);
        if (flags.allowTraps)
            checkUnreachableInFunction(relPath, lines, sym, range, fnLines, issues);
        if (flags.allowTypes && (flags.isPy || flags.isJsTs || flags.isLuau))
            checkDictKeysInFunction(relPath, lines, sym, range, fnLines, potentials, issues);
    }
}

function checkLuauReactiveSmells(relPath, lines, issues) {
    let inComputedStart = 0;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("--"))
            continue;
        if (inComputedStart === 0 && /\b(?:Flux\.)?computed\s*\(\s*function\b/.test(trimmed)) {
            inComputedStart = lineNum;
            depth = stepLuauBlockDepth(0, trimmed) || 1;
            continue;
        }
        if (inComputedStart === 0)
            continue;
        depth = stepLuauBlockDepth(depth, trimmed);
        if (/\b(?::set\s*\(|Instance\.new\s*\(|:Connect\s*\()/.test(trimmed) && !hasInlineSuppression(lines, lineNum, "reactive_smells")) {
            issues.push({
                id: mintIssueId("reactive_smells", relPath, `computed_side_effect_L${lineNum}`),
                detector: "reactive_smells",
                category: "traps",
                dimension: "code_quality",
                tier: "T3",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `computed_side_effect_L${lineNum}`,
                summary: `Reactive side effect inside \`computed\` callback on L${lineNum} (\`${trimmed.slice(0, 60)}\`).`,
                suggestion: `Keep \`computed\` callbacks pure; move signal writes (\`:set()\`), \`Instance.new\`, or event connections into \`effect\` / \`scope\`.`,
            });
        }
        if (depth <= 0) {
            inComputedStart = 0;
            depth = 0;
        }
    }
}
function checkReactHookSmells(relPath, lines, issues) {
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("//"))
            continue;
        if (/^(?:if|for|while)\s*\([^)]*\)\s*\{?[^\n]*\buse(?:State|Effect|Memo|Callback|Ref|Context)\s*\(/.test(trimmed) &&
            !hasInlineSuppression(lines, lineNum, "reactive_smells")) {
            issues.push({
                id: mintIssueId("reactive_smells", relPath, `conditional_hook_L${lineNum}`),
                detector: "reactive_smells",
                category: "traps",
                dimension: "code_quality",
                tier: "T3",
                confidence: "high",
                severity: "high",
                file: relPath,
                line: lineNum,
                end_line: lineNum,
                span: `L${lineNum}-L${lineNum}`,
                identifier: `conditional_hook_L${lineNum}`,
                summary: `React hook invoked conditionally or inside a loop on L${lineNum}.`,
                suggestion: `Call React hooks unconditionally at the top level of your component or custom hook.`,
            });
        }
    }
}
function checkReactiveSmellsInFile(relPath, lines, flags, potentials, issues) {
    if (!flags.allowTraps || (!flags.isLuau && !flags.isJsTs))
        return;
    potentials.reactive_smells += 1;
    if (flags.isLuau)
        checkLuauReactiveSmells(relPath, lines, issues);
    if (flags.isJsTs)
        checkReactHookSmells(relPath, lines, issues);
}

/**
 * Count non-comment token references to `ident` in `lines` excluding `lineIdx`.
 * Shared between `unused_imports` detection and `autofix unused-imports`.
 */
export function countIdentifierUsesOutsideLine(lines, lineIdx, ident, isPy = false, isLuau = false) {
    const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (i === lineIdx) continue;
        const l = lines[i].trim();
        if (l.startsWith("//") || l.startsWith("--") || (isPy && l.startsWith("#"))) continue;
        const stripped = stripCodeStringsAndComments(lines[i], isLuau, isPy);
        if (wordRe.test(stripped)) count += 1;
    }
    return count;
}

function pruneNamedImportSpecifiers(line, trimmed, lines, lineIdx, isPy = false, isLuau = false) {
    if (/;.*\S/.test(trimmed)) return null;
    const namedMatch = /^(\s*import\s*)\{([^}]+)\}(\s*from\s*["'][^"']+["']\s*;?\s*)$/.exec(line);
    if (!namedMatch) return null;
    const [, prefix, rawSpecs, suffix] = namedMatch;
    const specs = rawSpecs.split(",").map((s) => s.trim()).filter(Boolean);
    if (specs.length === 0) return null;

    const kept = [];
    const removedNames = [];
    for (const spec of specs) {
        if (/^type\s+/.test(spec)) {
            kept.push(spec);
            continue;
        }
        const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(spec);
        if (!aliasMatch) {
            kept.push(spec);
            continue;
        }
        const localIdent = aliasMatch[2] || aliasMatch[1];
        if (countIdentifierUsesOutsideLine(lines, lineIdx, localIdent, isPy, isLuau) === 0) {
            removedNames.push(localIdent);
        } else {
            kept.push(spec);
        }
    }

    if (removedNames.length === 0) return null;
    if (kept.length === 0) {
        return {
            action: "remove",
            after: "<removed>",
            removedNames,
            identifier: removedNames[0],
        };
    }
    const rebuilt = `${prefix}{ ${kept.join(", ")} }${suffix}`;
    return {
        action: "replace",
        line: rebuilt,
        after: rebuilt.trim(),
        removedNames,
        identifier: removedNames.join(","),
    };
}

/**
 * Determine whether `line` at `lineIdx` imports unused identifiers.
 * Returns a shared edit descriptor consumed by both `unused_imports` scanning and `autofix`.
 */
export function findUnusedImportEditOnLine(line, trimmed, lines, lineIdx, isPy = false, isLuau = false) {
    if (/;.*\S/.test(trimmed)) return null;
    const luauReq = /^local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\([^)]+\)\s*$/.exec(trimmed);
    const jsImp = /^import\s+(?:\*\s+as\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["'][^"']+["'];?\s*$/.exec(trimmed);
    const pyImp = /^from\s+[A-Za-z0-9_.]+\s+import\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(trimmed);
    const ident = luauReq?.[1] || jsImp?.[1] || pyImp?.[1];
    const effectiveIsPy = isPy || Boolean(pyImp);
    const effectiveIsLuau = isLuau || Boolean(luauReq);
    const usesClassicJsxReact =
        ident === "React" &&
        lines.some(
            (l, idx) =>
                idx !== lineIdx &&
                /(?:^|[=(?:\s,])<(?:[A-Za-z][A-Za-z0-9_.]*(?:>|\s*\/>|\s+[A-Za-z_][^>\n]*>)|>)/.test(
                    stripCodeStringsAndComments(l, false, false),
                ),
        );
    if (
        ident &&
        !usesClassicJsxReact &&
        countIdentifierUsesOutsideLine(lines, lineIdx, ident, effectiveIsPy, effectiveIsLuau) === 0
    ) {
        return {
            action: "remove",
            line,
            after: "<removed>",
            removedNames: [ident],
            identifier: ident,
        };
    }
    return pruneNamedImportSpecifiers(line, trimmed, lines, lineIdx, effectiveIsPy, effectiveIsLuau);
}

function advanceLuauLongClose(raw, luauLongClose) {
    if (luauLongClose)
        return raw.includes(luauLongClose) ? null : luauLongClose;
    const lb = /(?:--)?\[(=*)\[/.exec(raw);
    if (lb && !raw.slice(lb.index + lb[0].length).includes(`]${lb[1]}]`))
        return `]${lb[1]}]`;
    return null;
}
function checkUnusedImportsInFile(relPath, lines, flags, potentials, issues) {
    potentials.unused_imports += 1;
    let luauLongClose = null;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        const lineNum = i + 1;
        const wasInLongBracket = Boolean(luauLongClose);
        if (flags.isLuau)
            luauLongClose = advanceLuauLongClose(raw, luauLongClose);
        if (wasInLongBracket || !trimmed)
            continue;
        if (trimmed.startsWith("//") || trimmed.startsWith("--") || (flags.isPy && trimmed.startsWith("#")))
            continue;
        const res = findUnusedImportEditOnLine(raw, trimmed, lines, i, flags.isPy, flags.isLuau);
        if (!res || hasInlineSuppression(lines, lineNum, "unused_imports"))
            continue;
        const label = res.removedNames.join(", ");
        const plural = res.removedNames.length > 1 ? "s" : "";
        issues.push({
            id: mintIssueId("unused_imports", relPath, `${res.identifier}_L${lineNum}`),
            detector: "unused_imports",
            category: "dead",
            dimension: "code_quality",
            tier: "T3",
            confidence: "high",
            severity: "low",
            file: relPath,
            line: lineNum,
            end_line: lineNum,
            span: `L${lineNum}-L${lineNum}`,
            identifier: res.identifier,
            detail: { removed_names: res.removedNames, action: res.action },
            summary: `Unused import binding${plural} \`${label}\` at ${relPath}:L${lineNum}.`,
            suggestion: `Remove unused import${plural} \`${label}\` or run \`plexer health autofix unused-imports\`.`,
        });
    }
}

const JSTS_SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const TS_SOURCE_EXTS = new Set([".ts", ".tsx"]);
const REACT_SOURCE_EXTS = new Set([".jsx", ".tsx"]);
function buildSourceCheckFlags(relPath, ignoreRules, enabled) {
    const ext = extname(relPath).toLowerCase();
    return {
        isLuau: isLuauFile(relPath),
        isPy: ext === ".py",
        isJsTs: JSTS_SOURCE_EXTS.has(ext),
        isTs: TS_SOURCE_EXTS.has(ext),
        isReact: REACT_SOURCE_EXTS.has(ext),
        isRust: ext === ".rs",
        isGo: ext === ".go",
        wantTraps: enabled.wantTraps,
        wantSecurity: enabled.wantSecurity,
        allowDead: enabled.wantDead && !ignoreRules.isIgnored(relPath, "dead"),
        allowSlop: enabled.wantSlop && !ignoreRules.isIgnored(relPath, "slop"),
        allowTypes: enabled.wantTypes && !ignoreRules.isIgnored(relPath, "types"),
        allowCatches: enabled.wantCatches && !ignoreRules.isIgnored(relPath, "catches"),
        allowTraps: enabled.wantTraps && !ignoreRules.isIgnored(relPath, "traps"),
        allowSecurity: enabled.wantSecurity && !ignoreRules.isIgnored(relPath, "security"),
    };
}
function recordSourceCheckPotentials(relPath, flags, ignoreRules, potentials) {
    if (flags.allowTypes && (flags.isTs || flags.isLuau || flags.isPy))
        potentials.type_bypasses += 1;
    if (flags.allowSlop) {
        potentials.ai_slop += 1;
        potentials.debug_logs += 1;
    }
    if (flags.allowCatches)
        potentials.silent_catches += 1;
    if (flags.isLuau) {
        if (flags.allowSecurity)
            potentials.roblox_security += 1;
        if (flags.allowTraps)
            potentials.luau_quality += 1;
    }
    if (flags.allowTraps)
        potentials.language_traps += 1;
    if (flags.allowSecurity && !ignoreRules.isIgnored(relPath, "traps"))
        potentials.security_traps += 1;
}
function scanSingleFileSourceChecks(relPath, lines, fileSymbols, incomingByTarget, ignoreRules, enabled, potentials, issues) {
    const flags = buildSourceCheckFlags(relPath, ignoreRules, enabled);
    if (flags.allowDead && !ignoreRules.isIgnored(relPath, "unused_imports"))
        checkUnusedImportsInFile(relPath, lines, flags, potentials, issues);
    if (flags.allowSlop && !ignoreRules.isIgnored(relPath, "stale_deprecations"))
        checkStaleDeprecationsInFile(relPath, lines, fileSymbols, incomingByTarget, potentials, issues);
    recordSourceCheckPotentials(relPath, flags, ignoreRules, potentials);
    const stateTracker = {
        booleanStateCount: 0,
        firstBooleanStateLine: 1,
        shadowedLuauSchedulers: flags.isLuau ? collectShadowedLuauSchedulerNames(lines) : new Set(),
        luauBlockStack: [],
        luauLongState: { longClose: null },
        luauFnDepthBeforeLine: 0,
        luauLineCode: "",
    };
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        if (flags.isLuau) {
            stateTracker.luauLineCode = stripLuauLongBracketsOnLine(raw, stateTracker.luauLongState);
            stateTracker.luauFnDepthBeforeLine = stateTracker.luauBlockStack.filter((b) => b === "fn").length;
            stepLuauFnBlockStack(stateTracker.luauBlockStack, stateTracker.luauLineCode);
        }
        checkSlopAndTypeBypassesOnLine(relPath, lines, lineNum, trimmed, flags, issues);
        checkSilentCatchesOnLine(relPath, lines, i, lineNum, raw, trimmed, flags, issues);
        checkLuauSecurityAndTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, stateTracker, issues);
        if ((flags.wantTraps || flags.wantSecurity) && !ignoreRules.isIgnored(relPath, "traps")) {
            checkLanguageTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, stateTracker, issues);
            checkUniversalSecurityRulesOnLine(relPath, lines, lineNum, trimmed, flags, issues);
        }
    }
    checkLuauAndPySymbolTraps(relPath, lines, fileSymbols, flags, stateTracker, issues);
    checkFunctionScopedTrapsAndDictKeys(relPath, lines, fileSymbols, flags, potentials, issues);
    checkReactiveSmellsInFile(relPath, lines, flags, potentials, issues);
}

// Universal language/runtime type tags and HTTP methods rather than project-specific values.
const ENUM_BYPASS_EXCLUDED_LITERALS = new Set([
    "string",
    "number",
    "boolean",
    "object",
    "function",
    "undefined",
    "symbol",
    "bigint",
    "table",
    "thread",
    "userdata",
    "nil",
    "none",
    "null",
    "true",
    "false",
    "nan",
    "infinity",
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
]);

function isArgvOrSwitchDispatch(lines, lineIdx, rawLhs, propName, lit) {
    if (!propName || propName.length < 3) return true;
    if (lit.startsWith("-") || /^E[A-Z0-9]{3,14}$/.test(lit)) return true;
    if (ENUM_BYPASS_EXCLUDED_LITERALS.has(lit) || ENUM_BYPASS_EXCLUDED_LITERALS.has(lit.toLowerCase())) {
        return true;
    }
    if (/^(?:argv|args|arg|cliArgs|positional|rawArgs?)$/i.test(propName)) return true;
    if (/(?:^|\.)(?:argv|args|flags?|options?)\[/.test(rawLhs)) return true;

    const winStart = Math.max(0, lineIdx - 4);
    const winEnd = Math.min(lines.length, lineIdx + 3);
    const windowText = lines.slice(winStart, winEnd).join("\n");
    if (/\b(?:process\.argv|Deno\.args|sys\.argv|parseArgs)\b/.test(windowText)) return true;
    if (/\.startsWith\(\s*["']-/.test(windowText)) return true;

    const switchStart = Math.max(0, lineIdx - 12);
    const escapedProp = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const switchRe = new RegExp(`\\bswitch\\s*\\([^)]*\\b${escapedProp}\\b`);
    for (let k = lineIdx - 1; k >= switchStart; k--) {
        if (switchRe.test(lines[k])) return true;
    }
    return false;
}

function matchesSourceFileFilter(fileFilter, relPath) {
    if (!fileFilter) return true;
    if (typeof fileFilter === "function") return Boolean(fileFilter(relPath));
    if (fileFilter instanceof Set) return fileFilter.has(relPath);
    if (Array.isArray(fileFilter)) return fileFilter.includes(relPath);
    return true;
}

function recordEnumBypassHit(varLiteralMap, propName, lit, relPath, lineNum) {
    let entry = varLiteralMap.get(propName);
    if (!entry) {
        entry = { files: new Set(), literals: new Set(), literalFiles: new Map(), sites: [] };
        varLiteralMap.set(propName, entry);
    }
    entry.files.add(relPath);
    entry.literals.add(lit);
    let lf = entry.literalFiles.get(lit);
    if (!lf) {
        lf = new Set();
        entry.literalFiles.set(lit, lf);
    }
    lf.add(relPath);
    if (entry.sites.length < 8)
        entry.sites.push({ file: relPath, line: lineNum, literal: lit });
}
function scanEnumBypassFile(relPath, lines, varLiteralMap) {
    const ext = extname(relPath).toLowerCase();
    const isLuau = ext === ".luau" || ext === ".lua";
    const isPy = ext === ".py";
    const cmpRe = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:===|!==|==|~=|!=)\s*["']([A-Za-z][A-Za-z0-9_-]{2,28})["']/g;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--"))
            continue;
        if (/^(?:type|export\s+type|interface|enum)\b/.test(trimmed) || /\b(?:typeof|type)\s*\(/.test(trimmed))
            continue;
        if (hasInlineSuppression(lines, i + 1, "enum_bypasses"))
            continue;
        const uncommented = isLuau ? trimmed.replace(/--.*$/, "") : isPy ? trimmed.replace(/#.*$/, "") : trimmed.replace(/\/\/.*$/, "");
        const codeOnly = stripCodeStringsAndComments(raw, isLuau, isPy);
        if (!/(?:===|!==|==|~=|!=)\s*(?:""|'')/.test(codeOnly))
            continue;
        cmpRe.lastIndex = 0;
        let m;
        while ((m = cmpRe.exec(uncommented)) !== null) {
            const propName = m[1].includes(".") ? m[1].split(".").pop() : m[1];
            if (isArgvOrSwitchDispatch(lines, i, m[1], propName, m[2]) || !hasWordToken(codeOnly, propName))
                continue;
            recordEnumBypassHit(varLiteralMap, propName, m[2], relPath, i + 1);
        }
    }
}
function buildConsolidatedEnumBypassIssue(propName, entry, readLines) {
    if (entry.files.size < 3 || entry.literals.size < 2)
        return null;
    let sharedLiteralCount = 0;
    for (const lf of entry.literalFiles.values()) {
        if (lf.size >= 2) sharedLiteralCount += 1;
    }
    if (sharedLiteralCount < 2)
        return null;
    const primary = entry.sites[0];
    if (hasInlineSuppression(readLines(primary.file) || [], primary.line, "enum_bypasses"))
        return null;
    const litPreview = [...entry.literals].slice(0, 5).map((l) => `"${l}"`).join(", ");
    const filePreview = [...entry.files].slice(0, 4).join(", ");
    return {
        id: mintIssueId("enum_bypasses", primary.file, `${propName}_string_enum`),
        detector: "enum_bypasses",
        category: "types",
        dimension: "code_quality",
        tier: "T3",
        confidence: "medium",
        severity: entry.files.size >= 5 ? "medium" : "low",
        file: primary.file,
        line: primary.line,
        end_line: primary.line,
        span: `L${primary.line}-L${primary.line}`,
        identifier: propName,
        detail: { discriminator: propName, literals: [...entry.literals], files: [...entry.files] },
        summary: `Unconsolidated string-enum comparisons on \`${propName}\` (${litPreview}) scattered across ${entry.files.size} files (${filePreview}).`,
        suggestion: `Define a shared constant/enum object or narrow helper for \`${propName}\` values (${litPreview}) instead of repeating raw string literals across files.`,
    };
}
/**
 * Two-pass detector for scattered magic string-enum comparisons (`enum_bypasses`).
 * Flags discriminator variables compared against >= 2 distinct string literals across >= 3 files
 * without a centralized enum/constant table.
 */
function checkEnumBypassIssues(scoredFiles, readLines, ignoreRules, potentials, issues) {
    potentials.enum_bypasses = Math.max(1, scoredFiles.length);
    const varLiteralMap = new Map();
    for (const relPath of scoredFiles) {
        if (ignoreRules.isIgnored(relPath, "types") || ignoreRules.isIgnored(relPath, "enum_bypasses"))
            continue;
        scanEnumBypassFile(relPath, readLines(relPath) || [], varLiteralMap);
    }
    for (const [propName, entry] of varLiteralMap.entries()) {
        const issue = buildConsolidatedEnumBypassIssue(propName, entry, readLines);
        if (issue)
            issues.push(issue);
    }
}

function buildSourceCheckGraphIndices(graph) {
    const symbolsByFile = new Map();
    const incomingByTarget = new Map();
    for (const node of graph.nodes) {
        if (node.kind === "file")
            continue;
        if (!symbolsByFile.has(node.path))
            symbolsByFile.set(node.path, []);
        symbolsByFile.get(node.path).push(node);
    }
    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation))
            continue;
        if (!incomingByTarget.has(edge.target))
            incomingByTarget.set(edge.target, new Set());
        incomingByTarget.get(edge.target).add(edge.source);
    }
    return { symbolsByFile, incomingByTarget };
}
function fillZeroSourcePotentials(potentials, enabledCategories, scoredFileCount, luauFileCount) {
    for (const k of Object.keys(potentials)) {
        const cat = DETECTOR_CATEGORY[k];
        if (cat && !enabledCategories.has(cat))
            continue;
        if (k === "luau_quality" || k === "roblox_security") {
            if (potentials[k] === 0 && luauFileCount > 0) potentials[k] = luauFileCount;
            continue;
        }
        if (potentials[k] === 0) potentials[k] = scoredFileCount;
    }
}
/**
 * Run all source & AST checks (`catches`, `types`, `traps`, `slop`, `security`).
 */
export function runSourceChecks(graph, readLines, zoneMap, ignoreRules, enabledCategories, fileFilter = null) {
    const issues = [];
    const potentials = {
        unused_imports: 0,
        silent_catches: 0,
        type_bypasses: 0,
        enum_bypasses: 0,
        dict_keys: 0,
        stale_deprecations: 0,
        ai_slop: 0,
        debug_logs: 0,
        language_traps: 0,
        reactive_smells: 0,
        luau_quality: 0,
        security_traps: 0,
        roblox_security: 0,
    };
    const enabled = {
        wantDead: enabledCategories.has("dead"),
        wantCatches: enabledCategories.has("catches"),
        wantTypes: enabledCategories.has("types"),
        wantTraps: enabledCategories.has("traps"),
        wantSlop: enabledCategories.has("slop"),
        wantSecurity: enabledCategories.has("security"),
    };
    if (!Object.values(enabled).some(Boolean))
        return { issues, potentials };
    const { symbolsByFile, incomingByTarget } = buildSourceCheckGraphIndices(graph);
    const scoredFiles = [];
    let luauFileCount = 0;
    for (const fNode of graph.nodes) {
        if (fNode.kind !== "file")
            continue;
        const relPath = fNode.path;
        const zone = zoneMap.get(relPath) || "production";
        if (!SCORED_ZONES.has(zone) || !matchesSourceFileFilter(fileFilter, relPath))
            continue;
        const lines = readLines(relPath);
        if (!lines || lines.length === 0)
            continue;
        scoredFiles.push(relPath);
        if (isLuauFile(relPath))
            luauFileCount += 1;
        scanSingleFileSourceChecks(relPath, lines, symbolsByFile.get(relPath) || [], incomingByTarget, ignoreRules, enabled, potentials, issues);
    }
    if (enabled.wantTypes && scoredFiles.length > 0)
        checkEnumBypassIssues(scoredFiles, readLines, ignoreRules, potentials, issues);
    fillZeroSourcePotentials(potentials, enabledCategories, Math.max(1, scoredFiles.length), luauFileCount);
    return { issues, potentials };
}
