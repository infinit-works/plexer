/**
 * Deterministic source, AST, type, catch, slop, security, and first-class Luau/Roblox
 * detectors for `plexer health`.
 */
import { extname } from "node:path";
import { WALK_RELATIONS } from "../graph/relations.js";
import { spanRange } from "../util/span.js";
import { mintIssueId } from "./state.js";
import { SCORED_ZONES, hasInlineSuppression } from "./zones.js";

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
                    category: "types",
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
        const isTsBypass = flags.isTs && /\bas\s+any\b|:\s*any\b|@ts-ignore\b/.test(trimmed) && !trimmed.startsWith("//");
        const isLuauBypass = flags.isLuau && /::\s*any\b|^--!nocheck\b/.test(trimmed);
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

function checkSilentCatchesOnLine(relPath, lines, i, lineNum, raw, trimmed, flags, issues) {
    if (!flags.allowCatches) return;
    if (flags.isJsTs && /\bcatch\s*(?:\([^)]*\))?\s*\{/.test(trimmed)) {
        const blockLines = [];
        for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
            const bl = lines[k].trim();
            if (bl.startsWith("}")) break;
            if (bl && !bl.startsWith("//") && !bl.startsWith("/*") && !bl.startsWith("*")) {
                blockLines.push(bl);
            }
        }
        if (
            blockLines.length === 1 &&
            /^console\.(?:error|warn|log)\(/.test(blockLines[0]) &&
            !hasInlineSuppression(lines, lineNum, "silent_catches")
        ) {
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
        } else if (
            blockLines.length === 1 &&
            /^return\s+(?:\[\]|\{\}|null|undefined)\s*;?$/.test(blockLines[0]) &&
            !hasInlineSuppression(lines, lineNum, "silent_catches")
        ) {
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
    } else if (flags.isPy && /^except(?:\s+Exception|\s*:)/.test(trimmed)) {
        const nextLine = (lines[i + 1] || "").trim();
        const afterNext = (lines[i + 2] || "").trim();
        if (
            (nextLine === "pass" ||
                /^return\s+(?:\[\]|\{\}|None)$/.test(nextLine) ||
                /^(?:logger|logging|print)\b/.test(nextLine)) &&
            !/^(?:raise|return)\b/.test(afterNext) &&
            !hasInlineSuppression(lines, lineNum, "silent_catches")
        ) {
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
    } else if (flags.isLuau && /^\s*pcall\s*\(/.test(raw) && !hasInlineSuppression(lines, lineNum, "silent_catches")) {
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
}

function checkLuauSecurityOnLine(relPath, lines, i, lineNum, trimmed, issues) {
    if (
        isClientRobloxPath(relPath) &&
        /\b(?:ServerScriptService|ServerStorage)\b/.test(trimmed) &&
        !trimmed.startsWith("--") &&
        !hasInlineSuppression(lines, lineNum, "roblox_security")
    ) {
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
            summary: `Client script/module \`${relPath}\` references server-only container (\`ServerScriptService\` / \`ServerStorage\`) on L${lineNum}.`,
            suggestion: `Move shared types/constants to \`ReplicatedStorage\` and keep server logic inside \`ServerScriptService\`.`,
        });
    }

    const remoteMatch =
        /\.(?:OnServerEvent:Connect|OnServerInvoke\s*=)\s*\(?\s*function\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*([^)]+)\)/.exec(
            trimmed,
        );
    if (remoteMatch && !hasInlineSuppression(lines, lineNum, "roblox_security")) {
        const bodyWindow = lines.slice(i + 1, Math.min(lines.length, i + 10)).join("\n");
        if (!/\b(?:typeof|type|assert| Validate|check|schema)\b/i.test(bodyWindow)) {
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

function checkLuauSecurityAndTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, issues) {
    if (!flags.isLuau) return;
    if (flags.allowSecurity) {
        checkLuauSecurityOnLine(relPath, lines, i, lineNum, trimmed, issues);
    }

    if (flags.allowTraps && !trimmed.startsWith("--")) {
        const schedMatch = /(?:^|[^.\w:])(wait|spawn|delay)\s*\(/.exec(trimmed);
        if (schedMatch && !hasInlineSuppression(lines, lineNum, "luau_quality")) {
            const fnName = schedMatch[1];
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
        if (/^[A-Za-z0-9_.:[\]]+:Connect\s*\(/.test(trimmed) && !hasInlineSuppression(lines, lineNum, "luau_quality")) {
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

    checkHardcodedSecretsOnLine(relPath, lines, lineNum, trimmed, issues);

    if (
        /\b(?:Math\.random|random\.random|random\.randint|math\.random)\s*\(/.test(trimmed) &&
        /\b(?:token|secret|nonce|password|salt|auth|session_?id|api_?key|csrf)\b/i.test(trimmed) &&
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
            trimmed,
        ) &&
        /\b[A-Za-z0-9_]*(?:password|passwd|secret_?access_?key|secret_?key|client_?secret|api_?key|access_?token|private_?key|bearer_?token)\b/i.test(
            trimmed,
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

function checkLuauAndPySymbolTraps(relPath, lines, fileSymbols, flags, stateTracker, issues) {
    if (flags.isLuau && flags.allowTraps) {
        for (const sym of fileSymbols) {
            if (sym.kind !== "function" && sym.kind !== "method") continue;
            const range = spanRange(sym.span);
            if (!range) continue;
            for (let ln = range.start; ln <= range.end && ln <= lines.length; ln++) {
                const text = lines[ln - 1] || "";
                if (
                    /\bgame:GetService\s*\(/.test(text) &&
                    !text.trim().startsWith("--") &&
                    !hasInlineSuppression(lines, ln, "luau_quality")
                ) {
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
        }
    }

    if (flags.isPy && flags.allowTraps) {
        const mutableGlobals = new Set();
        for (const rawLine of lines) {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\{|\[|dict\(|list\(|set\()/.exec(rawLine);
            if (m) {
                const varName = m[1];
                if (!varName.isupper?.() || /(?:STATE|CACHE|STORE|REGISTRY|MUT|MAP|TABLE)/i.test(varName)) {
                    mutableGlobals.add(varName);
                }
            }
        }
        if (mutableGlobals.size > 0) {
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
    }

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

function checkUnreachableInFunction(relPath, lines, sym, range, fnLines, issues) {
    for (let idx = 1; idx < fnLines.length - 1; idx++) {
        const rawLine = fnLines[idx];
        const tLine = rawLine.trim();
        if (!tLine || tLine.startsWith("//") || tLine.startsWith("#") || tLine.startsWith("--")) {
            continue;
        }
        const isTerminator =
            /^(?:return(?:\s+[^?:]+)?|break|continue|throw\s+.+|raise(?:\s+.+)?|error\s*\(.+\))\s*;?$/.test(tLine) &&
            !/[+,\-*/|&?:({\[]\s*$/.test(tLine) &&
            !/\b(?:if|unless|when)\b/.test(tLine);
        if (!isTerminator) continue;

        const termIndent = rawLine.match(/^\s*/)[0].length;
        let nextIdx = idx + 1;
        while (nextIdx < fnLines.length) {
            const nl = fnLines[nextIdx].trim();
            if (nl && !nl.startsWith("//") && !nl.startsWith("#") && !nl.startsWith("--") && !nl.startsWith("/*") && !nl.startsWith("*")) {
                break;
            }
            nextIdx += 1;
        }
        if (nextIdx >= fnLines.length) break;
        const nextRaw = fnLines[nextIdx];
        const nextTrim = nextRaw.trim();
        const nextIndent = nextRaw.match(/^\s*/)[0].length;
        if (
            nextIndent === termIndent &&
            termIndent > 0 &&
            !/^(?:[})\]]|end\b|else\b|elseif\b|elif\b|except\b|catch\b|finally\b|case\b|default\b|when\b|#\[|@)/.test(nextTrim)
        ) {
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

function collectTrackedDictKeys(range, fnLines) {
    const tracked = new Map();
    const ensureTracked = (vName) => {
        let entry = tracked.get(vName);
        if (!entry) {
            entry = { writes: new Map(), reads: new Map(), initLocal: false };
            tracked.set(vName, entry);
        }
        return entry;
    };

    for (let idx = 0; idx < fnLines.length; idx++) {
        const ln = range.start + idx;
        const t = fnLines[idx].trim();
        if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("--")) continue;

        const initMatch =
            /^(?:(?:local|const|let|var)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\{\s*\}|dict\(\s*\))\s*;?$/.exec(t);
        if (initMatch) ensureTracked(initMatch[1]).initLocal = true;

        const writeRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*["']([A-Za-z0-9_.-]+)["']\s*\]\s*=(?!=)/g;
        let wm;
        while ((wm = writeRe.exec(t)) !== null) {
            const td = ensureTracked(wm[1]);
            if (!td.writes.has(wm[2])) td.writes.set(wm[2], ln);
        }

        const readBracketRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*["']([A-Za-z0-9_.-]+)["']\s*\](?!\s*=(?!=))/g;
        let rm;
        while ((rm = readBracketRe.exec(t)) !== null) {
            const td = ensureTracked(rm[1]);
            if (!td.reads.has(rm[2])) td.reads.set(rm[2], ln);
        }

        const getRe = /\b([A-Za-z_][A-Za-z0-9_]*)\.get\s*\(\s*["']([A-Za-z0-9_.-]+)["']/g;
        let gm;
        while ((gm = getRe.exec(t)) !== null) {
            const td = ensureTracked(gm[1]);
            if (!td.reads.has(gm[2])) td.reads.set(gm[2], ln);
        }
        const inRe = /["']([A-Za-z0-9_.-]+)["']\s+(?:not\s+)?in\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
        let im;
        while ((im = inRe.exec(t)) !== null) {
            const td = ensureTracked(im[2]);
            if (!td.reads.has(im[1])) td.reads.set(im[1], ln);
        }
    }
    return tracked;
}

function checkDictKeysInFunction(relPath, lines, sym, range, fnLines, potentials, issues) {
    potentials.dict_keys += 1;
    const tracked = collectTrackedDictKeys(range, fnLines);
    const fullFnText = fnLines.join("\n");

    for (const [varName, td] of tracked.entries()) {
        if (!td.initLocal || td.writes.size < 2 || td.reads.size < 1) continue;
        const escapedRe = new RegExp(
            `(?:\\breturn\\b[^;\\n]*\\b${varName}\\b|[A-Za-z0-9_.:]+\\s*\\([^)]*\\b${varName}\\b(?![\\s\\S]*\\[)|\\.\\.\\.${varName}\\b|\\bfor\\b[^\\n]*\\b${varName}\\b)`,
        );
        const escapes = escapedRe.test(fullFnText);

        for (const [rKey, rLine] of td.reads.entries()) {
            if (td.writes.has(rKey)) continue;
            const nearMatch = [...td.writes.keys()].find(
                (wKey) =>
                    wKey.length >= 4 &&
                    rKey.length >= 4 &&
                    levenshtein(rKey, wKey) > 0 &&
                    levenshtein(rKey, wKey) <= 2,
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

        if (!escapes) {
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
    }
}

function checkFunctionScopedTrapsAndDictKeys(relPath, lines, fileSymbols, flags, potentials, issues) {
    if (!flags.allowTraps && !flags.allowTypes) return;
    for (const sym of fileSymbols) {
        if (sym.kind !== "function" && sym.kind !== "method") continue;
        const range = spanRange(sym.span);
        if (!range || range.end <= range.start) continue;
        const fnLines = lines.slice(range.start - 1, range.end);

        if (
            flags.allowTraps &&
            flags.isJsTs &&
            !sym.exported &&
            range.end - range.start >= 2 &&
            /\basync\s+(?:function\b|[A-Za-z0-9_$]+\s*\()/.test(fnLines[0] || "")
        ) {
            const bodyJoined = fnLines.slice(1).join("\n");
            if (
                !/\b(?:await|Promise|import\s*\(|throw\s+new\s+Error)\b/.test(bodyJoined) &&
                !hasInlineSuppression(lines, range.start, "language_traps")
            ) {
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
        }

        if (flags.allowTraps) {
            checkUnreachableInFunction(relPath, lines, sym, range, fnLines, issues);
        }

        if (flags.allowTypes && (flags.isPy || flags.isJsTs || flags.isLuau)) {
            checkDictKeysInFunction(relPath, lines, sym, range, fnLines, potentials, issues);
        }
    }
}

function checkReactiveSmellsInFile(relPath, lines, flags, potentials, issues) {
    if (!flags.allowTraps) return;
    if (!flags.isLuau && !flags.isJsTs) return;
    potentials.reactive_smells += 1;

    if (flags.isLuau) {
        let inComputedStart = 0;
        let depth = 0;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith("--")) continue;

            if (inComputedStart === 0 && /\b(?:Flux\.)?computed\s*\(\s*function\b/.test(trimmed)) {
                inComputedStart = lineNum;
                depth = 1;
                continue;
            }
            if (inComputedStart > 0) {
                const opens = (trimmed.match(/\b(?:function|then|do|repeat)\b/g) || []).length;
                const closes = (trimmed.match(/\b(?:end|until)\b/g) || []).length;
                depth += opens - closes;
                if (
                    /\b(?::set\s*\(|Instance\.new\s*\(|:Connect\s*\()/.test(trimmed) &&
                    !hasInlineSuppression(lines, lineNum, "reactive_smells")
                ) {
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
    }

    if (flags.isJsTs) {
        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith("//")) continue;
            if (
                /^(?:if|for|while)\s*\([^)]*\)\s*\{?[^\n]*\buse(?:State|Effect|Memo|Callback|Ref|Context)\s*\(/.test(
                    trimmed,
                ) &&
                !hasInlineSuppression(lines, lineNum, "reactive_smells")
            ) {
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
}

function scanSingleFileSourceChecks(relPath, lines, fileSymbols, incomingByTarget, ignoreRules, enabled, potentials, issues) {
    const ext = extname(relPath).toLowerCase();
    const flags = {
        isLuau: isLuauFile(relPath),
        isPy: ext === ".py",
        isJsTs: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext),
        isTs: [".ts", ".tsx"].includes(ext),
        isReact: [".jsx", ".tsx"].includes(ext),
        isRust: ext === ".rs",
        isGo: ext === ".go",
        wantTraps: enabled.wantTraps,
        wantSecurity: enabled.wantSecurity,
        allowSlop: enabled.wantSlop && !ignoreRules.isIgnored(relPath, "slop"),
        allowTypes: enabled.wantTypes && !ignoreRules.isIgnored(relPath, "types"),
        allowCatches: enabled.wantCatches && !ignoreRules.isIgnored(relPath, "catches"),
        allowTraps: enabled.wantTraps && !ignoreRules.isIgnored(relPath, "traps"),
        allowSecurity: enabled.wantSecurity && !ignoreRules.isIgnored(relPath, "security"),
    };

    if (flags.allowTypes) {
        checkStaleDeprecationsInFile(relPath, lines, fileSymbols, incomingByTarget, potentials, issues);
        if (flags.isTs || flags.isLuau || flags.isPy) potentials.type_bypasses += 1;
    }
    if (flags.allowSlop) {
        potentials.ai_slop += 1;
        potentials.debug_logs += 1;
    }
    if (flags.allowCatches) potentials.silent_catches += 1;
    if (flags.isLuau) {
        if (flags.allowSecurity) potentials.roblox_security += 1;
        if (flags.allowTraps) potentials.luau_quality += 1;
    }
    if ((flags.wantTraps || flags.wantSecurity) && !ignoreRules.isIgnored(relPath, "traps")) {
        potentials.language_traps += 1;
        if (flags.wantSecurity) potentials.security_traps += 1;
    }

    const stateTracker = { booleanStateCount: 0, firstBooleanStateLine: 1 };
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed) continue;

        checkSlopAndTypeBypassesOnLine(relPath, lines, lineNum, trimmed, flags, issues);
        checkSilentCatchesOnLine(relPath, lines, i, lineNum, raw, trimmed, flags, issues);
        checkLuauSecurityAndTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, issues);
        if ((flags.wantTraps || flags.wantSecurity) && !ignoreRules.isIgnored(relPath, "traps")) {
            checkLanguageTrapsOnLine(relPath, lines, i, lineNum, trimmed, flags, stateTracker, issues);
            checkUniversalSecurityRulesOnLine(relPath, lines, lineNum, trimmed, flags, issues);
        }
    }

    checkLuauAndPySymbolTraps(relPath, lines, fileSymbols, flags, stateTracker, issues);
    checkFunctionScopedTrapsAndDictKeys(relPath, lines, fileSymbols, flags, potentials, issues);
    checkReactiveSmellsInFile(relPath, lines, flags, potentials, issues);
}

/**
 * Run all source & AST checks (`catches`, `types`, `traps`, `slop`, `security`).
 */
export function runSourceChecks(graph, readLines, zoneMap, ignoreRules, enabledCategories, fileFilter = null) {
    const issues = [];
    const potentials = {
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
        wantCatches: enabledCategories.has("catches"),
        wantTypes: enabledCategories.has("types"),
        wantTraps: enabledCategories.has("traps"),
        wantSlop: enabledCategories.has("slop"),
        wantSecurity: enabledCategories.has("security"),
    };

    if (
        !enabled.wantCatches &&
        !enabled.wantTypes &&
        !enabled.wantTraps &&
        !enabled.wantSlop &&
        !enabled.wantSecurity
    ) {
        return { issues, potentials };
    }

    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    const symbolsByFile = new Map();
    const incomingByTarget = new Map();

    for (const node of graph.nodes) {
        if (node.kind !== "file") {
            let arr = symbolsByFile.get(node.path);
            if (!arr) {
                arr = [];
                symbolsByFile.set(node.path, arr);
            }
            arr.push(node);
        }
    }

    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation)) continue;
        let s = incomingByTarget.get(edge.target);
        if (!s) {
            s = new Set();
            incomingByTarget.set(edge.target, s);
        }
        s.add(edge.source);
    }

    for (const fNode of fileNodes) {
        const relPath = fNode.path;
        const zone = zoneMap.get(relPath) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (fileFilter && !fileFilter(relPath)) continue;

        const lines = readLines(relPath);
        if (!lines || lines.length === 0) continue;

        const fileSymbols = symbolsByFile.get(relPath) || [];
        scanSingleFileSourceChecks(relPath, lines, fileSymbols, incomingByTarget, ignoreRules, enabled, potentials, issues);
    }

    const scoredFileCount = Math.max(
        1,
        fileNodes.filter(
            (f) =>
                SCORED_ZONES.has(zoneMap.get(f.path) || "production") &&
                (!fileFilter || fileFilter(f.path)),
        ).length,
    );
    for (const k of Object.keys(potentials)) {
        if (potentials[k] === 0) potentials[k] = scoredFileCount;
    }

    return { issues, potentials };
}
