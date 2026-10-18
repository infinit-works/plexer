/**
 * De-benchmaxxed 12-task A/B evaluation suite for `plexer`.
 *
 * Design principles:
 *  1. Zero symbol/file leakage in discovery prompts (T1-T8): prompts describe
 *     developer symptoms, edge cases, or refactoring intents in plain technical
 *     prose without naming target file paths or camelCase function identifiers.
 *  2. Zero `plexer`-specific trivia: no tasks ask for "top 3 hub modules" or
 *     graph topology statistics that only `plexer` computes.
 *  3. Real multi-file code edits (T9-T12): 4 concrete feature/refactor tasks
 *     across JS (`plexer`) and Luau (`flux`, `sert`, `building-tools`) verified
 *     by running each repository's automated test suite plus behavioral specs.
 *  4. Holdout repositories (`building-tools`, `z`): unseen during `plexer`
 *     development to test out-of-distribution generalization.
 */
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function hasAll(text, patterns) {
    return patterns.every((p) => p.test(text));
}

function hasAny(text, patterns) {
    return patterns.some((p) => p.test(text));
}

function runLuauInline(cloneDir, code) {
    const tmpFile = join(cloneDir, ".verify-bench.luau");
    try {
        writeFileSync(tmpFile, code, "utf8");
        execFileSync("luau", [".verify-bench.luau"], {
            cwd: cloneDir,
            stdio: "pipe",
        });
    } finally {
        try {
            unlinkSync(tmpFile);
        } catch {
            // ignore
        }
    }
}

export const TASKS = [
    // =========================================================================
    // Category 1: Symptom-Based Bug Diagnosis & Edge-Case Auditing (T1 - T4)
    // =========================================================================
    {
        id: "T1",
        category: "diagnosis",
        repo: "kohls-admin",
        holdout: false,
        title: "Diagnose command target validation & group-role fail-closed behavior",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Investigate two authorization edge cases in this admin system and answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. When a player runs a command that targets another player (with lower-rank enforcement enabled and command requests not bypassed), what exact check happens if the target player is currently in the server but their roles have not finished loading yet, and how is the command's effective rank chosen when comparing against the target's rank?\n` +
            `2. When checking whether a role is handed out publicly via a Roblox group rule, what happens on the very first check before the group's lowest member rank has been fetched from \`GroupService\`, and how long does the cache wait before retrying if \`GetGroupInfoAsync\` fails to yield an entry rank?`,
        rubric: [
            {
                id: "auth_file_cited",
                description: "Cites src/Shared/Auth.luau with line numbers around targetUserArgument and getGroupEntryRank/isPublicRole",
                weight: 2,
                test: (txt) => /src\/Shared\/Auth\.luau:L?\d+/i.test(txt),
            },
            {
                id: "roles_loaded_attribute",
                description: "Identifies the _KRolesLoaded attribute check returning 'Can\\'t target loading user'",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /_KRolesLoaded/,
                        /Can't target loading user|loading user/i,
                    ]),
            },
            {
                id: "rank_comparison_fallback",
                description: "Explains that when arg.command.rank == 0 it compares against arg.command.fromRank (otherwise arg.command.rank)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /fromRank/,
                        /command\.rank\s*==\s*0|rank\s*==\s*0|command\.rank[\s\S]{0,40}\b(?:equals|is)\s+`?0`?/i,
                    ]),
            },
            {
                id: "group_fail_closed_and_retry",
                description: "Explains that groupEntryRanks sets false while fetching, isPublicRole fails closed (returns true) when entry is nil/false, and retries after 60 seconds via task.delay(60, ...)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /groupEntryRanks|isPublicRole/,
                        /60/,
                        /fails?[- ]closed|(?:returns?|returning)\s+`?true`?/i,
                    ]),
            },
        ],
    },
    {
        id: "T2",
        category: "diagnosis",
        repo: "flux",
        holdout: false,
        title: "Diagnose runaway reactive effect loop detection and disposal",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `A developer notices that a reactive effect that mutates state during a flush eventually logs a warning and stops running permanently. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. How does the reactive graph distinguish between (a) a single effect that directly writes to a signal it reads during its own execution and (b) a multi-effect ping-pong cycle across flush passes?\n` +
            `2. What are the exact numeric thresholds (pass count and per-effect rerun limits) before each guard triggers, and what happens to the offending effect node when the limit is exceeded?`,
        rubric: [
            {
                id: "graph_file_cited",
                description: "Cites src/Graph.luau with line numbers",
                weight: 2,
                test: (txt) =>
                    /src\/Graph\.luau:L?\d+/i.test(txt) ||
                    hasAll(txt, [/src\/Graph\.luau/i, /\bL\d+-L\d+\b/]),
            },
            {
                id: "self_write_requeue",
                description: "Identifies selfWritten == e / requeue(e) tracking direct self-writes in reruns[e]",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /selfWritten/,
                        /requeue|reruns/,
                    ]),
            },
            {
                id: "guard_passes_and_limit",
                description: "Identifies GUARD_PASSES = 32 and RERUN_LIMIT = 100 (or > 32 passes and > 100 reruns/cycles)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /\b32\b/,
                        /\b100\b/,
                    ]),
            },
            {
                id: "runaway_dispose",
                description: "Explains that runaway() warns and calls disposeOne(e) to permanently dispose the effect",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /runaway/,
                        /disposeOne|disposed/i,
                    ]),
            },
        ],
    },
    {
        id: "T3",
        category: "diagnosis",
        repo: "sert",
        holdout: false,
        title: "Diagnose stateful model test command-redraw shrinking stability",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In stateful model testing (\`sert.model\`), when \`redraw = true\` is enabled and a drawn command's precondition (\`pre\`) refuses the current model state, the runner redraws from the remaining commands. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. If shrinking later deletes an earlier step in the command sequence, why would a naive tape replay cause the refused command draws in a subsequent step to shift into a different command?\n` +
            `2. What exact tape mechanism does \`sert.model\` use when a command is accepted after one or more refusals so that shrinking treats the step as if it drew the accepted command on the first try?`,
        rubric: [
            {
                id: "model_and_prop_cited",
                description: "Cites src/model.luau (and optionally src/prop.luau) with line spans",
                weight: 2,
                test: (txt) => /src\/model\.luau:L?\d+/i.test(txt),
            },
            {
                id: "precondition_state_shift",
                description: "Explains that earlier refused draws depended on the prior model state, so deleting an earlier step changes state and could make an earlier tried command pass or consume different draws",
                weight: 2,
                test: (txt) =>
                    hasAny(txt, [
                        /depended on.*state|earlier.*state|precondition|refus/i,
                    ]),
            },
            {
                id: "prop_mark_and_hint",
                description: "Identifies prop.mark(g) (first / pick) and prop.hint(g, first, pick, { drawn[command] })",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /prop\.mark/,
                        /prop\.hint/,
                        /drawn\[command\]/,
                    ]),
            },
            {
                id: "single_draw_replacement",
                description: "Explains that [first, pick] is replaced/hinted with the single draw offset { drawn[command] } when pick > first",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /pick\s*>\s*first/,
                        /first.*pick|span|single draw|offset/i,
                    ]),
            },
        ],
    },
    {
        id: "T4",
        category: "diagnosis",
        repo: "z",
        holdout: true,
        title: "Diagnose zero-byte element validation in count-prefixed arrays (Holdout)",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In the schema compiler, variable-length (count-prefixed) arrays whose elements encode to 0 bytes in the wire buffer can allow a malicious payload to specify an unbounded element count without consuming buffer bytes. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. How does the semantic analyzer detect whether a count-prefixed array has a 0-byte maximum wire size?\n` +
            `2. Under what exact exception is a 0-byte wire-size element type still allowed inside a count-prefixed array, and how does that exception evaluate \`tuple\`, fixed-length \`T[N]\` arrays, \`struct\`, and \`union\` element types?`,
        rubric: [
            {
                id: "resolve_rs_cited",
                description: "Cites compiler/src/resolve.rs with line numbers around check_zero_size_arrays / zero_size_array / consumes_instance",
                weight: 2,
                test: (txt) => /compiler\/src\/resolve\.rs:L?\d+/i.test(txt),
            },
            {
                id: "zero_size_detection",
                description: "Identifies bounds.prefixed() and Layout::compact(schema).size(elem).max == 0",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /prefixed\(\)/,
                        /Layout::compact|size\(elem\)\.max\s*==\s*0/,
                    ]),
            },
            {
                id: "consumes_instance_exception",
                description: "Identifies consumes_instance(schema, elem) as the exception (taking an Instance from remote arguments)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /consumes_instance/,
                        /Instance/,
                    ]),
            },
            {
                id: "composite_type_rules",
                description: "Explains that Tuple/Struct require ANY element/field to consume an Instance, fixed array T[N] requires N > 0 and element consumes_instance, and Union requires non-empty variants where ALL variants consume an Instance",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /any/i,
                        /all/i,
                        /Fixed|n\s*>\s*0/i,
                    ]),
            },
        ],
    },

    // =========================================================================
    // Category 2: Cross-File Refactor & Blast-Radius Analysis (T5 - T8)
    // =========================================================================
    {
        id: "T5",
        category: "blast-radius",
        repo: "plexer",
        holdout: false,
        title: "Blast radius of changing working-tree freshness checking",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `We plan to refactor the working-tree freshness fingerprint check so it returns a structured status object instead of a boolean, and propagate that through the index-freshness check API. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. Where is the low-level working-tree freshness check defined, and which functions across \`src/\` and \`bin/\` call it directly?\n` +
            `2. Which CLI commands in \`bin/\` and MCP server handlers in \`src/mcp/\` invoke the index-freshness or auto-rebuild guard before serving a request?`,
        rubric: [
            {
                id: "fingerprint_def",
                description: "Cites probeDrift and/or isClean in src/graph/fingerprint.js",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/graph\/fingerprint\.js:L?\d+/i,
                        /probeDrift|isClean/,
                    ]),
            },
            {
                id: "direct_callers",
                description: "Identifies ensureFreshGraph in src/graph/refresh.js as the direct caller of probeDrift and isClean",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/graph\/refresh\.js:L?\d+/i,
                        /ensureFreshGraph/,
                    ]),
            },
            {
                id: "cli_commands_using_ensure",
                description: "Identifies refreshBefore in bin/plexer.js and the CLI commands calling it (ask, skeleton, callers, callees, impact, blast, grep, map)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /bin\/plexer\.js:L?\d+/i,
                        /refreshBefore/,
                        /\bask\b/,
                        /\bskeleton\b/,
                        /\bgrep\b/,
                        /\bmap\b/,
                    ]),
            },
            {
                id: "mcp_freshness",
                description: "Identifies callTool / ensureFreshGraph in src/mcp/tools.js",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/mcp\/tools\.js:L?\d+/i,
                        /callTool|ensureFreshGraph/,
                    ]),
            },
        ],
    },
    {
        id: "T6",
        category: "blast-radius",
        repo: "kohls-admin",
        holdout: false,
        title: "Blast radius of refactoring user permission flag checks",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `We are refactoring the authorization helper that checks whether a user ID holds a specific named capability or administrative permission (such as general admin access, asynchronous ban authority, targeting other players, modifying server settings, or viewing server logs). Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. Where is this permission-checking function defined, and how does it evaluate creator status, universal/default permissions, member roles, and free-admin roles?\n` +
            `2. List all direct callers of this function across \`src/Shared/\`, \`src/Server/\`, \`src/Client/\`, and \`src/init.luau\`, grouped by subsystem and noting which permission string each caller checks.`,
        rubric: [
            {
                id: "has_permission_def",
                description: "Cites Auth.hasPermission in src/Shared/Auth.luau:L541-L567",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/Shared\/Auth\.luau:L?\d+/i,
                        /hasPermission/,
                    ]),
            },
            {
                id: "shared_and_auth_callers",
                description: "Identifies callers in src/Shared/Auth.luau (banUsers/L82-84, unbanUsers/L148-150, targetUserArgument/L645-648) and src/Shared/Data/init.luau",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/Shared\/Data\/init\.luau/i,
                    ]) &&
                    (hasAll(txt, [/banUsers/, /unbanUsers/, /targetUserArgument/]) ||
                        hasAll(txt, [/\bL?8[2-4]\b/i, /\bL?(?:14[89]|150)\b/i, /\bL?64[5-8]\b/i])),
            },
            {
                id: "default_commands_and_types_callers",
                description: "Identifies callers in DefaultCommands (Administration.luau, Moderation.luau, Utility.luau) and DefaultTypes/Ban.luau",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /Administration\.luau/i,
                        /Moderation\.luau/i,
                        /Utility\.luau/i,
                        /Ban\.luau/i,
                    ]),
            },
            {
                id: "client_and_server_callers",
                description: "Identifies callers in src/Client/ (Bans.luau, Members.luau, Settings.luau), src/Server/init.luau, and src/init.luau",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /(?:src\/)?Client\b/i,
                        /Bans\.luau/i,
                        /Members\.luau/i,
                        /Settings\.luau/i,
                        /(?:src\/)?Server\/init\.luau/i,
                    ]),
            },
        ],
    },
    {
        id: "T7",
        category: "blast-radius",
        repo: "flux",
        holdout: false,
        title: "Blast radius of refactoring manual/engine frame step wiring",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `We are auditing how per-frame motion updates and reactive graph flushes are wired between the root module, the clock module, and the motion engine. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. How does the root module wire per-frame execution both on the live Roblox \`RunService\` loop and on the manual clock's internal frame callback?\n` +
            `2. In the clock module, in what exact order do due timers, pre-render/render-stepped subscribers, the internal frame callback, heartbeat subscribers, and deferred queue flushes execute during a single manual frame step?\n` +
            `3. Which internal registration/scheduling helpers does the clock module expose on its private internal table, and which modules in \`src/\` call each of them?`,
        rubric: [
            {
                id: "init_and_clock_cited",
                description: "Cites src/init.luau and src/Clock.luau (plus src/Compat.luau) with line spans",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/init\.luau:L?\d+/i,
                        /src\/Clock\.luau:L?\d+/i,
                    ]),
            },
            {
                id: "init_frame_wiring",
                description: "Explains RunService.PreRender (client) / Heartbeat (server) guarded by not Clock.isManual(), and Clock._internal.setFrame calling Motion.step(dt) + Graph.flush()",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /PreRender/,
                        /Heartbeat/,
                        /setFrame/,
                        /Motion\.step/,
                        /Graph\.flush/,
                    ]),
            },
            {
                id: "run_frame_order",
                description: "Lists the 5-step order in runFrame(dt) with Clock.drain() called after each phase (timers -> drain -> render -> drain -> frameHook -> drain -> heartbeat -> drain)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /runFrame/,
                        /render/i,
                        /frameHook/,
                        /heartbeat/i,
                        /drain/,
                    ]),
            },
            {
                id: "clock_internal_callers",
                description: "Identifies Clock._internal.{setFrame, setReport, spawn} and notes src/Compat.luau calling setReport and spawn",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /setFrame/,
                        /setReport/,
                        /src\/Compat\.luau/i,
                    ]),
            },
        ],
    },
    {
        id: "T8",
        category: "blast-radius",
        repo: "building-tools",
        holdout: true,
        title: "Blast radius of refactoring chunked transport invocation (Holdout)",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In the client architecture, large part-editing batch requests are split into bounded request chunks before being sent over the network transport to the server. Answer concisely with exact \`file:Lx-Ly\` citations:\n` +
            `1. Where is the core chunked-invocation function defined, what are its parameters and return values, and how does it behave when one chunk in the middle of a batch fails?\n` +
            `2. Trace every direct and second-hop caller of this function across \`src/Client/\` (including shared tool helpers, specific tools, and client actions), and explain how each caller records the resulting steps into undo history.`,
        rubric: [
            {
                id: "history_invoke_chunked_def",
                description: "Cites History.invokeChunked in src/Client/State/History.luau:L74-L93",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/Client\/State\/History\.luau(?::L?|#L?)\d+/i,
                        /invokeChunked/,
                    ]),
            },
            {
                id: "partial_failure_behavior",
                description: "Explains that invokeChunked continues through all chunks, collects successful steps into steps, and sets complete = false if any chunk reply fails",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /complete\s*=\s*false|`complete`\s+is\s+(?:set\s+to\s+)?`?false`?/i,
                        /reply\.ok|reply\s+(?:has|with)\s+`?ok|ok\s*=\s*false|failed\s+(?:chunk|reply)|chunk[^.\n]{0,25}fails|later\s+chunks|skip(?:s|\s+the)\s+(?:that|the)\s+(?:chunk|failed)/i,
                    ]),
            },
            {
                id: "actions_callers",
                description: "Identifies setProperties in src/Client/Systems/Actions.luau and its callers rename and setLocked",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /src\/Client\/Systems\/Actions\.luau(?::L?|#L?)\d+/i,
                        /setProperties/,
                        /rename/,
                        /setLocked/,
                    ]),
            },
            {
                id: "properties_and_tools_callers",
                description: "Identifies Properties.invokeChunked / Properties.apply in src/Client/Tools/Shared/Properties.luau and Weld tool callers (breakWelds / weldToLast in src/Client/Tools/Weld/init.luau)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /(?:src\/Client\/Tools\/Shared\/)?Properties\.luau(?::L?|#L?)\d+/i,
                        /(?:src\/Client\/Tools\/)?Weld\/init\.luau/i,
                        /weldToLast/,
                        /breakWelds/,
                    ]),
            },
        ],
    },

    // =========================================================================
    // Category 3: Concrete Multi-File Code Edits Verified by Tests (T9 - T12)
    // =========================================================================
    {
        id: "T9",
        category: "code-edit",
        repo: "plexer",
        holdout: false,
        title: "Implement multi-file `--all-matches` mode for `plexer skeleton`",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Currently, the file-API \`skeleton(repoDir, fileQuery, opts)\` function returns an \`{ error: 'ambiguous path "..." — matches: ...' }\` object whenever \`fileQuery\` matches multiple indexed files and none is an exact path match.\n\n` +
            `Implement an opt-in multi-match mode across the skeleton API, formatter, and CLI in this repository:\n` +
            `1. When \`skeleton(repoDir, fileQuery, opts)\` is called with \`opts.allMatches\` truthy and \`fileQuery\` matches multiple indexed files (with no single exact match), instead of returning \`{ error }\`, return \`{ files, entries }\` where \`files\` is the sorted array of matched file paths and \`entries\` is the combined array of skeleton entries across all matched files in that sorted file order (preserving each entry's \`file\` property and sorting each file's entries by start line). Preserve the existing single-file return shape \`{ file, entries }\` when only 1 file matches, and preserve the \`{ error }\` return when \`opts.allMatches\` is falsy.\n` +
            `2. In \`formatSkeleton(skel)\`, when \`Array.isArray(skel.files)\` is present, format each file's section (\`<file> — skeleton (<N> symbols)\` followed by its entries) separated by a blank line.\n` +
            `3. In the CLI entrypoint, support \`--all-matches\` on \`plexer skeleton <file> [--all-matches]\` and pass \`allMatches\` to \`skeleton(...)\`.\n\n` +
            `Run \`npm test\` to verify all tests pass.`,
        rubric: [
            {
                id: "unit_and_behavioral_tests",
                description: "All existing npm tests pass AND skeleton/formatSkeleton/CLI pass automated verification for --all-matches",
                weight: 8,
                verifyEdit: (cloneDir) => {
                    execFileSync("npm", ["test"], { cwd: cloneDir, stdio: "pipe" });
                    const checkScript = `
                        import { buildGraph } from "./src/graph/build.js";
                        import { skeleton, formatSkeleton } from "./src/ask/ask.js";
                        import { execFileSync } from "node:child_process";

                        await buildGraph(".");

                        const ambig = skeleton(".", "init.js");
                        const ambigMsg = ambig.error || ambig.note || "";
                        if (!ambigMsg.includes("ambiguous")) {
                            throw new Error("Expected default ambiguous error/note, got: " + JSON.stringify(ambig));
                        }

                        const multi = skeleton(".", "init.js", { allMatches: true });
                        if (!Array.isArray(multi.files) || multi.files.length < 2) {
                            throw new Error("Expected multi.files array >= 2, got: " + JSON.stringify(multi));
                        }
                        if (!multi.files.includes("src/claude/init.js") || !multi.files.includes("src/hosts/init.js")) {
                            throw new Error("Missing expected files in multi.files: " + JSON.stringify(multi.files));
                        }
                        const filesInEntries = new Set(multi.entries.map((e) => e.file));
                        if (!filesInEntries.has("src/claude/init.js") || !filesInEntries.has("src/hosts/init.js")) {
                            throw new Error("Entries missing matched files: " + JSON.stringify([...filesInEntries]));
                        }

                        const formatted = formatSkeleton(multi);
                        if (!formatted.includes("src/claude/init.js") || !formatted.includes("src/hosts/init.js")) {
                            throw new Error("formatSkeleton missing per-file headers:\\n" + formatted);
                        }

                        const cliOut = execFileSync("node", ["bin/plexer.js", "skeleton", "init.js", "--all-matches"], { encoding: "utf8" });
                        if (!cliOut.includes("src/claude/init.js") || !cliOut.includes("src/hosts/init.js")) {
                            throw new Error("CLI --all-matches output missing headers:\\n" + cliOut);
                        }
                    `;
                    execFileSync("node", ["--input-type=module", "-e", checkScript], {
                        cwd: cloneDir,
                        stdio: "pipe",
                    });
                    return true;
                },
            },
        ],
    },
    {
        id: "T10",
        category: "code-edit",
        repo: "flux",
        holdout: false,
        title: "Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear`",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Deep reactive stores (\`Flux.store\` / \`Flux.Store\`) provide mutation helpers (\`insert\`, \`remove\`, \`move\`, \`reconcile\`, \`unwrap\`, \`Destroy\`), but lack a \`clear(proxy)\` helper to empty a store table in a single tracked step.\n\n` +
            `Implement \`clear(proxy)\` on the store module and re-export it on \`Flux.Store.clear\`:\n` +
            `1. If \`proxy\` is a plain table rather than a store proxy, fall back to \`table.clear(proxy)\` and return.\n` +
            `2. If the store proxy's underlying raw table is already empty, return immediately without firing structural/iteration observers.\n` +
            `3. Otherwise, tear down any nested child store proxies, set existing per-key reactive signals to \`nil\` so key observers see \`nil\`, clear the underlying raw table, and fire the store's structural/iteration tracker once.\n` +
            `4. Expose \`clear\` on the public \`Flux.Store\` table.\n\n` +
            `Run \`luau test/spec.client.luau -a store\` to verify all store tests pass.`,
        rubric: [
            {
                id: "luau_store_clear_verified",
                description: "Existing store unit tests pass AND Flux.Store.clear passes behavioral verification in Luau",
                weight: 8,
                verifyEdit: (cloneDir) => {
                    execFileSync("luau", ["test/spec.client.luau", "-a", "store"], {
                        cwd: cloneDir,
                        stdio: "pipe",
                    });
                    const luauCheck = `
                        local Flux = require("./src")
                        local Store = Flux.Store
                        assert(type(Store.clear) == "function", "Flux.Store.clear must be a function")

                        local s = Flux.store({ a = 1, b = 2, nested = { x = 10 } })
                        local childProxy = s.nested
                        local aVal = nil
                        local aRuns = 0
                        Flux.effect(function()
                            aRuns += 1
                            aVal = s.a
                        end)
                        local countRuns = 0
                        local keyCount = 0
                        Flux.effect(function()
                            countRuns += 1
                            local n = 0
                            for _ in s do
                                n += 1
                            end
                            keyCount = n
                        end)
                        Flux.flush()
                        assert(aRuns == 1 and aVal == 1, "initial key read")
                        assert(countRuns == 1 and keyCount == 3, "initial iter count")

                        Store.clear(s)
                        Flux.flush()
                        assert(next(Store.unwrap(s)) == nil, "raw table must be empty after clear")
                        assert(aVal == nil and aRuns == 2, "key observer must see nil after clear")
                        assert(keyCount == 0 and countRuns == 2, "iteration observer must re-run once and see 0 keys")

                        -- Clearing an already-empty store must not fire tracker again
                        Store.clear(s)
                        Flux.flush()
                        assert(countRuns == 2, "clearing an already-empty store must be a no-op")

                        -- Plain table fallback
                        local plain = { 1, 2, 3 }
                        Store.clear(plain)
                        assert(#plain == 0, "plain table fallback must clear table")
                    `;
                    runLuauInline(cloneDir, luauCheck);
                    return true;
                },
            },
        ],
    },
    {
        id: "T11",
        category: "code-edit",
        repo: "sert",
        holdout: false,
        title: "Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host`",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In the deterministic simulation kernel, per-owner host hook tables (\`s:host(owner)\` / \`HostHooks\`) currently bind \`clock\`, \`wait\`, \`spawn\`, \`defer\`, and \`resume\`, and forward those 5 hooks onto simulated \`server.host\` and remote \`client.host\` tables.\n\n` +
            `Extend the host hooks across the simulator kernel to also provide \`delay\` and \`cancel\`:\n` +
            `1. Add \`delay: (seconds: number, fn: any, ...any) -> thread\` (scheduling \`fn(...)\` after \`seconds\` owned by \`owner\`) and \`cancel: (thread: thread) -> ()\` (cancelling pending wake-ups and closing the thread) to \`HostHooks\` and \`s:host(owner)\`.\n` +
            `2. Also provide \`delay\` and \`cancel\` on the synchronous instant-wait host hooks so both modes expose the same hook shape.\n` +
            `3. Forward \`delay = hooks.delay\` and \`cancel = hooks.cancel\` onto both \`server.host\` (when creating a simulated server) and \`client.host\` (when creating a simulated remote client).\n\n` +
            `Run \`luau test/sim/run.luau\` to verify all simulation specs pass.`,
        rubric: [
            {
                id: "luau_sert_host_hooks_verified",
                description: "Simulation suite passes AND delay/cancel work on s:host(owner), server.host, and client.host",
                weight: 8,
                verifyEdit: (cloneDir) => {
                    execFileSync("luau", ["test/sim/run.luau"], {
                        cwd: cloneDir,
                        stdio: "pipe",
                    });
                    const luauCheck = `
                        local Sim = require("./src/sim")
                        local w = Sim.World.new()
                        local srv = w:server()
                        local cli = srv:client(101)

                        assert(type(srv.host.delay) == "function", "server.host.delay must be a function")
                        assert(type(srv.host.cancel) == "function", "server.host.cancel must be a function")
                        assert(type(cli.host.delay) == "function", "client.host.delay must be a function")
                        assert(type(cli.host.cancel) == "function", "client.host.cancel must be a function")

                        local fired = {}
                        srv.host.delay(0.2, function(a, b)
                            table.insert(fired, { peer = "srv", a = a, b = b, owner = w.scheduler.current })
                        end, "x", 42)

                        local cancelledThread = srv.host.delay(0.1, function()
                            table.insert(fired, { peer = "cancelled" })
                        end)
                        srv.host.cancel(cancelledThread)

                        cli.host.delay(0.2, function(v)
                            table.insert(fired, { peer = "cli", v = v, owner = w.scheduler.current })
                        end, "ok")

                        w:run(0.3)
                        assert(#fired == 2, "expected 2 delayed threads to fire, got " .. tostring(#fired))
                        assert(fired[1].peer == "srv" and fired[1].a == "x" and fired[1].b == 42 and fired[1].owner == srv, "srv delay owner/args mismatch")
                        assert(fired[2].peer == "cli" and fired[2].v == "ok" and fired[2].owner == cli, "cli delay owner/args mismatch")
                    `;
                    runLuauInline(cloneDir, luauCheck);
                    return true;
                },
            },
        ],
    },
    {
        id: "T12",
        category: "code-edit",
        repo: "building-tools",
        holdout: true,
        title: "Implement `History.clear` and `Actions.clearHistory` (Holdout)",
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In the client undo/redo state store and client action controller, \`undo\`, \`redo\`, \`record\`, \`recordSelection\`, \`atTail\`, and \`destroy\` are supported, but there is no non-destructive \`clear\` operation to empty the undo/redo stack while keeping the reactive signals alive.\n\n` +
            `Implement \`clear\` on the history store and \`clearHistory\` on the client actions controller:\n` +
            `1. Add \`clear: () -> ()\` to the history \`Store\` type and implementation: if an undo/redo operation is currently in progress (\`busy\`), return early without mutating state; otherwise clear the record stack and reset \`index\` and \`count\` to \`0\` (so \`canUndo()\` and \`canRedo()\` become \`false\` and \`atTail()\` is \`true\`), while keeping all signals alive for future \`record\` calls.\n` +
            `2. Add \`clearHistory: () -> ()\` to the client \`Actions\` type and implementation that delegates to \`history.clear()\`.\n\n` +
            `Run \`luau test/spec.client.luau -a History\` to verify the unit test suite passes.`,
        rubric: [
            {
                id: "luau_btools_history_clear_verified",
                description: "Existing History unit tests pass AND History.clear + Actions.clearHistory pass behavioral verification in Luau",
                weight: 8,
                verifyEdit: (cloneDir) => {
                    execFileSync("luau", ["test/spec.client.luau", "-a", "History"], {
                        cwd: cloneDir,
                        stdio: "pipe",
                    });
                    const luauCheck = `
                        local History = require("./src/Client/State/History")
                        local h = History.new({
                            transport = {
                                invoke = function(_op, _payload)
                                    return { ok = true, result = { before = { { Anchored = false } } } }
                                end,
                            },
                            selection = {
                                replace = function(_items) end,
                            },
                        })
                        assert(type(h.clear) == "function", "history.clear must be a function")
                        local part = { Anchored = false }
                        h.record({ { op = "SetProperties", payload = { changes = { { target = part, props = { Anchored = true } } } }, result = { before = { { Anchored = false } } } } })
                        assert(h.index() == 1 and h.count() == 1 and h.canUndo() == true, "recorded 1 entry")
                        h.clear()
                        assert(#h.stack == 0 and h.index() == 0 and h.count() == 0, "stack/index/count reset after clear")
                        assert(h.canUndo() == false and h.canRedo() == false and h.atTail() == true, "signals updated after clear")
                        -- Recording after clear still works
                        h.record({ { op = "SetProperties", payload = { changes = { { target = part, props = { Anchored = false } } } }, result = { before = { { Anchored = true } } } } })
                        assert(h.index() == 1 and h.count() == 1 and h.canUndo() == true, "record after clear works")
                    `;
                    runLuauInline(cloneDir, luauCheck);
                    return true;
                },
            },
        ],
    },
];
