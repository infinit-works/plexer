/**
 * De-leaked v2 Multi-Scale & Adversarial Benchmark Suite (`bench/v2-tasks.js`).
 *
 * Separates v2 (Clean-room de-leaked scale ladder + negative controls + locked holdouts)
 * cleanly from v1 archives (`bench/tasks.js`, `bench/large-tasks.js`).
 *
 * Tiers (`tier`):
 *  - `small`:  <250 files  (`V1`–`V3`: `plexer`, `pallets/click` [holdout])
 *  - `medium`: 400–800 files (`V4`–`V9`: `pocketbase`, `qutebrowser`, `flipt`, `NodeBB`)
 *  - `large`:  1,000–2,500 files (`V10`–`V12`: `tutanota`, `vitejs/vite` [holdout])
 *  - `mega`:   3,000–10,000+ files (`V13`–`V14`: `microsoft/TypeScript`, `facebook/react` [holdout])
 *
 * Negative controls (`negativeControl: true`):
 *  - `N1`: single-file local typo/wording edit
 *  - `N2`: ambiguous common method name across packages
 *  - `N3`: string-keyed dynamic reflection / plugin hook dispatch
 *  - `N4`: non-indexed root config inspection
 */

function hasAll(text, patterns) {
    return patterns.every((p) => p.test(text));
}

export const V2_SCALE_REPOS = [
    {
        id: "plexer",
        repo: "infinit-works/plexer",
        localBase: "ab:plexer",
        tier: "small",
        language: "JavaScript",
        repoFiles: 130,
        holdout: false,
    },
    {
        id: "click",
        repo: "pallets/click",
        repoUrl: "https://github.com/pallets/click.git",
        baseCommit: "08b803cf32ceb2ae6a772c62d5da42757a897d44",
        tier: "small",
        language: "Python",
        repoFiles: 208,
        holdout: true,
    },
    {
        id: "pocketbase",
        repo: "pocketbase/pocketbase",
        repoUrl: "https://github.com/pocketbase/pocketbase.git",
        baseCommit: "a2b89d73444fe7775812bcb35b5cad3b741e1b29",
        localBase: "swe:pocketbase",
        tier: "medium",
        language: "Go",
        repoFiles: 444,
        holdout: false,
    },
    {
        id: "qutebrowser-s1",
        repo: "qutebrowser/qutebrowser",
        repoUrl: "https://github.com/qutebrowser/qutebrowser.git",
        baseCommit: "def864adc8b19bdbc506919270d8ff1408b4faac",
        localBase: "swe:S1",
        tier: "medium",
        language: "Python",
        repoFiles: 463,
        holdout: false,
    },
    {
        id: "qutebrowser-s2",
        repo: "qutebrowser/qutebrowser",
        repoUrl: "https://github.com/qutebrowser/qutebrowser.git",
        baseCommit: "8e152aaa0ac40a5200658d2b283cdf11b9d7ca0d",
        localBase: "swe:S2",
        tier: "medium",
        language: "Python",
        repoFiles: 463,
        holdout: false,
    },
    {
        id: "flipt",
        repo: "flipt-io/flipt",
        repoUrl: "https://github.com/flipt-io/flipt.git",
        baseCommit: "7620fe8bb64c0d875f419137acc5da24ca8e6031",
        localBase: "swe:S3",
        tier: "medium",
        language: "Go",
        repoFiles: 474,
        holdout: false,
    },
    {
        id: "NodeBB",
        repo: "NodeBB/NodeBB",
        repoUrl: "https://github.com/NodeBB/NodeBB.git",
        baseCommit: "50517020a28f11a8748e4de66a646e82bb3050e7",
        localBase: "swe:S5",
        tier: "medium",
        language: "JavaScript",
        repoFiles: 727,
        holdout: false,
    },
    {
        id: "tutanota",
        repo: "tutao/tutanota",
        repoUrl: "https://github.com/tutao/tutanota.git",
        baseCommit: "de49d486feef842101506adf040a0f00ded59519",
        localBase: "swe:S8",
        tier: "large",
        language: "TypeScript",
        repoFiles: 1350,
        holdout: false,
    },
    {
        id: "vite",
        repo: "vitejs/vite",
        repoUrl: "https://github.com/vitejs/vite.git",
        baseCommit: "adc761d6e123c1fd0917c8b80e0d1050689ccbcd",
        tier: "large",
        language: "TypeScript",
        repoFiles: 1665,
        holdout: true,
    },
    {
        id: "typescript",
        repo: "microsoft/TypeScript",
        repoUrl: "https://github.com/microsoft/TypeScript.git",
        baseCommit: "6327ae16673fe527482c24c37814a5b55162395d",
        tier: "mega",
        language: "Go+TypeScript",
        repoFiles: 4200,
        holdout: false,
    },
    {
        id: "react",
        repo: "facebook/react",
        repoUrl: "https://github.com/facebook/react.git",
        baseCommit: "edae846a9a17442c00429f2b15375afbfa0376c9",
        tier: "mega",
        language: "JavaScript",
        repoFiles: 4450,
        holdout: true,
    },
];

export const V2_TASKS = [
    // =========================================================================
    // Small Tier (<250 files): V1 - V3
    // =========================================================================
    {
        id: "V1",
        tier: "small",
        category: "diagnosis",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "plexer",
        baseId: "ab:plexer",
        language: "JavaScript",
        repoFiles: 130,
        title: "Diagnose incremental dirty-cone refresh and multi-hop barrel invalidation",
        goldFiles: ["src/graph/refresh.js", "src/graph/build.js"],
        goldSymbols: ["ensureFreshGraph", "computeDirtyConeAndContext", "expandBarrelConeHops"],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `When an indexed source file changes on disk before a query runs, how does this codebase verify freshness, determine the transitive set of affected callers and barrel re-exporters without rebuilding unchanged files, and bound multi-hop propagation across intermediate re-export barrels? Answer concisely with exact \`file:Lx-Ly\` citations and the exact hop caps for barrel expansion vs resolver context expansion.`,
        rubric: [
            {
                id: "cites_refresh_and_build",
                description: "Cites src/graph/refresh.js and src/graph/build.js with line numbers",
                weight: 3,
                test: (txt) =>
                    hasAll(txt, [/refresh\.js/i, /build\.js/i, /\bL\d+/]),
            },
            {
                id: "dirty_cone_and_hops",
                description: "Explains ensureFreshGraph lock/drift probe, 3-hop expandBarrelConeHops, and 4-hop resolver context expansion",
                weight: 5,
                test: (txt) =>
                    hasAll(txt, [
                        /ensureFreshGraph|probeDrift/,
                        /expandBarrelConeHops|computeDirtyConeAndContext/,
                        /\b3\b/,
                        /\b4\b/,
                    ]),
            },
        ],
    },
    {
        id: "V2",
        tier: "small",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "plexer",
        baseId: "ab:plexer",
        language: "JavaScript",
        repoFiles: 130,
        title: "Support multi-file --all-matches output on plexer skeleton CLI",
        goldFiles: ["src/ask/ask.js", "bin/plexer.js", "src/index.js"],
        goldSymbols: ["skeleton", "formatSkeleton"],
        allowPublicApiTerms: ["--all-matches", "skeleton"],
        verifier: {
            kind: "native",
            command: "PLEXER_NO_DAEMON=1 node --test",
            verifyScript: `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildGraph } from "./src/graph/build.js";
import { skeleton, formatSkeleton } from "./src/ask/ask.js";

await buildGraph(".", { force: true });
const ambig = skeleton(".", "init.js");
const msg = ambig.error || ambig.note || "";
assert.ok(msg.includes("ambiguous"), "default ambiguity check must still refuse ambiguous suffix");

const multi = skeleton(".", "init.js", { allMatches: true });
assert.ok(Array.isArray(multi.files) && multi.files.length >= 2, "must return sorted files array");
assert.ok(multi.files.includes("src/claude/init.js") && multi.files.includes("src/hosts/init.js"));
const formatted = formatSkeleton(multi);
assert.ok(formatted.includes("src/claude/init.js") && formatted.includes("src/hosts/init.js"));
const cliOut = execFileSync(process.execPath, ["bin/plexer.js", "skeleton", "init.js", "--all-matches", "--no-refresh"], { encoding: "utf8" });
assert.ok(cliOut.includes("src/claude/init.js") && cliOut.includes("src/hosts/init.js"));
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Currently, running \`plexer skeleton init.js\` refuses with an ambiguity message because multiple files share that suffix. Add an opt-in \`--all-matches\` CLI option to \`skeleton\` (and matching programmatic support) so callers can inspect all matched files sorted together in one pass while keeping default single-file ambiguity behavior intact.\n\n` +
            `Verify your changes with the repository test suite.`,
        rubric: [
            {
                id: "all_matches_behavior",
                description: "Implements --all-matches in skeleton API, formatter, wrapper, and CLI",
                weight: 8,
            },
        ],
    },
    {
        id: "V3",
        tier: "small",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: true,
        negativeControl: false,
        repo: "click",
        baseId: "click",
        repoUrl: "https://github.com/pallets/click.git",
        baseCommit: "08b803cf32ceb2ae6a772c62d5da42757a897d44",
        language: "Python",
        repoFiles: 208,
        title: "Validate inverted and unsatisfiable open-equal bounds in Click numeric range types",
        goldFiles: ["src/click/types.py"],
        goldSymbols: ["_NumberRangeBase", "IntRange", "FloatRange"],
        allowPublicApiTerms: [],
        verifier: {
            kind: "docker",
            image: "python:3.12-slim",
            language: "python",
            pythonScript: `
import sys, unittest
sys.path.insert(0, "src")
import click

class RangeBoundsValidationTests(unittest.TestCase):
    def test_inverted_bounds_raise(self):
        with self.assertRaises(ValueError):
            click.IntRange(10, 5)
        with self.assertRaises(ValueError):
            click.FloatRange(2.5, 1.0)

    def test_equal_open_bounds_raise(self):
        with self.assertRaises(ValueError):
            click.IntRange(5, 5, min_open=True)
        with self.assertRaises(ValueError):
            click.FloatRange(1.0, 1.0, max_open=True)

    def test_valid_ranges_preserved(self):
        self.assertEqual(click.IntRange(5, 5).convert("5", None, None), 5)
        self.assertEqual(click.IntRange(0, 5).convert("3", None, None), 3)
        self.assertEqual(click.FloatRange(0.5, 1.5, min_open=True).convert("1.0", None, None), 1.0)
        self.assertEqual(click.IntRange(max=5, clamp=True).convert("6", None, None), 5)

res = unittest.main(exit=False, verbosity=2).result
if not res.wasSuccessful() or res.testsRun < 3:
    sys.exit(1)
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Constructing an integer or floating-point bounded range parameter type with inverted endpoints (lower bound strictly greater than upper bound) or with identical lower and upper endpoints where at least one endpoint is marked open/exclusive currently succeeds silently instead of failing fast, leaving an unsatisfiable constraint until value conversion or clamping time.\n\n` +
            `Validate range endpoints at initialization so inverted bounds or equal bounds with an open endpoint raise \`ValueError\` immediately, while preserving equal closed bounds (for instance matching a single exact value) and open-ended single-side ranges.`,
        rubric: [
            {
                id: "range_validation_in_types_py",
                description: "Modifies src/click/types.py and rejects inverted or open-equal bounds with ValueError",
                weight: 8,
            },
        ],
    },

    // =========================================================================
    // Medium Tier (400-800 files): V4 - V9 (de-leaked rewrites of L1, L3, L4, L5, L6, L7)
    // =========================================================================
    {
        id: "V4",
        tier: "medium",
        category: "cross-subsystem-trace",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "pocketbase",
        baseId: "pocketbase",
        language: "Go",
        repoFiles: 444,
        title: "Trace OAuth2 sign-up superuser guard, avatar download fallback, and form dry-run rollback",
        goldFiles: ["apis/record_auth_with_oauth2.go", "forms/record_upsert.go"],
        goldSymbols: [
            "CollectionNameSuperusers",
            "NewFileFromURL",
            "sendOAuth2RecordCreateRequest",
            "syncPasswordFields",
            "disablePasswordValidations",
            "SaveNoValidateWithContext",
            "manualRollback",
            "RecordUpsert",
            "DrySubmit",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace two related record persistence pipelines across this Go codebase and answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. During OAuth2 sign-up for a brand-new user record, what collection check blocks privileged superuser accounts from being created, how is an external avatar URL handled differently when the target collection field holds uploaded files versus plain strings (including the exact download timeout), and how does the handler dispatch the internal record creation request?\n` +
            `2. In the record upsert form layer, what two password-state conditions bypass password validation during form sync, and how does dry-run submission roll back inserted or modified records differently depending on whether the database handle is already inside an active transaction?`,
        rubric: [
            {
                id: "cites_both_subsystems",
                description: "Cites apis/record_auth_with_oauth2.go and forms/record_upsert.go with line ranges",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /record_auth_with_oauth2\.go/i,
                        /record_upsert\.go/i,
                        /\bL?\d{2,3}\s*[-–]\s*L?\d{2,3}\b/,
                    ]),
            },
            {
                id: "oauth2_superuser_and_avatar",
                description: "Identifies CollectionNameSuperusers, 15s NewFileFromURL for FieldTypeFile, and sendOAuth2RecordCreateRequest",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /CollectionNameSuperusers|_superusers/i,
                        /15\s*\*\s*time\.Second|15\s*s(?:ec|econds)?/i,
                        /NewFileFromURL/,
                        /sendOAuth2RecordCreateRequest|processInternalRequest/,
                    ]),
            },
            {
                id: "sync_password_conditions",
                description: "Identifies both disablePasswordValidations conditions in syncPasswordFields",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/syncPasswordFields/, /disablePasswordValidations/, /Plain/, /Hash/, /IsNew/]),
            },
            {
                id: "dry_submit_rollback",
                description: "Identifies dbx.Tx check and manualRollback with SaveNoValidateWithContext / DeleteWithContext",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /dbx\.Tx|isTransactional/,
                        /SaveNoValidateWithContext/,
                        /DeleteWithContext|manualRollback/,
                    ]),
            },
        ],
    },
    {
        id: "V5",
        tier: "medium",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "pocketbase",
        baseId: "pocketbase",
        language: "Go",
        repoFiles: 444,
        title: "Support WebP thumbnails and PNG fallback Content-Type in PocketBase",
        goldFiles: ["apis/file.go", "tools/filesystem/filesystem.go"],
        goldSymbols: ["imageContentTypes", "CreateThumb", "FormatFromFilename"],
        allowPublicApiTerms: [],
        verifier: {
            kind: "docker",
            image: "golang:1.23-alpine",
            language: "go",
            checkScript: `
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const api = readFileSync("apis/file.go", "utf8");
const fsys = readFileSync("tools/filesystem/filesystem.go", "utf8");
assert.match(api, /imageContentTypes\\s*=\\s*\\[\\]string\\{[^}]*"image\\/webp"/, "apis/file.go missing image/webp");
assert.ok(/FormatFromFilename/.test(fsys) && /"image\\/png"/.test(fsys), "filesystem.go missing image/png fallback");
`,
            command: "go build ./apis ./tools/filesystem",
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `PocketBase serves \`.webp\` files inline on download requests, yet requesting a resized thumbnail (e.g., \`?thumb=100x100\`) for a \`.webp\` upload skips thumbnail creation and returns the full original asset instead. Furthermore, when the filesystem thumbnail generator falls back to PNG encoding for an unrecognized destination format such as \`.webp\`, the metadata options for the stored blob still label the output with the source file's \`"image/webp"\` content type instead of \`"image/png"\`.\n\n` +
            `Fix both halves of the pipeline so \`.webp\` uploads are eligible for thumbnail generation on download and generated thumbnails re-encoded via the PNG fallback stamp \`"image/png"\` as their content type.`,
        rubric: [
            {
                id: "webp_thumb_both_files",
                description: "Updates apis/file.go and tools/filesystem/filesystem.go for WebP thumbnails and PNG content type fallback",
                weight: 8,
            },
        ],
    },
    {
        id: "V6",
        tier: "medium",
        category: "caller-blast-radius",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "qutebrowser",
        baseId: "swe:S1",
        language: "Python",
        repoFiles: 463,
        title: "Trace tab count integer overflow wrapping and GUI child-process error signal consumers",
        goldFiles: [
            "qutebrowser/api/cmdutils.py",
            "qutebrowser/browser/commands.py",
            "qutebrowser/misc/guiprocess.py",
            "qutebrowser/misc/editor.py",
            "qutebrowser/commands/userscripts.py",
        ],
        goldSymbols: [
            "check_overflow",
            "CommandError",
            "_cntwidget",
            "GUIProcess",
            "_start_editor",
            "_on_proc_error",
            "_run_process",
            "on_proc_error",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Investigate two cross-module interactions in this browser codebase and cite exact \`file:Lx-Ly\` line ranges:\n` +
            `1. When dispatching commands against a numeric 1-based tab offset, which command helper wraps Qt 32-bit integer range checking, what user-facing command exception does it raise on overflow, and how does the browser tab widget lookup method convert a 1-based tab count before passing it into that helper?\n` +
            `2. How does the GUI child-process wrapper class declare its process-error Qt signal and bridge errors emitted by the underlying \`QProcess\`? Across non-test production code, which two callers connect callbacks directly to that wrapper's error signal (name each file, enclosing method, and connected handler)?`,
        rubric: [
            {
                id: "cmdutils_and_cntwidget",
                description: "Cites cmdutils.py and commands.py (_cntwidget passing count + 1)",
                weight: 2,
                test: (txt) => hasAll(txt, [/cmdutils\.py/i, /commands\.py/i, /_cntwidget/, /count\s*\+\s*1/]),
            },
            {
                id: "command_error_wrap",
                description: "Identifies qtutils.check_overflow raising CommandError on OverflowError",
                weight: 2,
                test: (txt) => hasAll(txt, [/check_overflow/, /OverflowError/, /CommandError/]),
            },
            {
                id: "guiprocess_bridge",
                description: "Identifies guiprocess.py pyqtSignal(QProcess.ProcessError) wired from errorOccurred",
                weight: 2,
                test: (txt) => hasAll(txt, [/guiprocess\.py/i, /pyqtSignal\s*\(\s*QProcess\.ProcessError\s*\)/, /errorOccurred/]),
            },
            {
                id: "both_error_consumers",
                description: "Identifies editor.py (_start_editor -> _on_proc_error) and userscripts.py (_run_process -> on_proc_error)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/editor\.py/i, /_start_editor/, /_on_proc_error/, /userscripts\.py/i, /_run_process/, /\bon_proc_error\b/]),
            },
        ],
    },
    {
        id: "V7",
        tier: "medium",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "qutebrowser",
        baseId: "swe:S2",
        language: "Python",
        repoFiles: 463,
        title: "Rename GUI child-process Qt error signal to error_occurred across wrapper and callers",
        goldFiles: [
            "qutebrowser/misc/guiprocess.py",
            "qutebrowser/misc/editor.py",
            "qutebrowser/commands/userscripts.py",
        ],
        goldSymbols: [
            "GUIProcess",
            "_start_editor",
            "_on_proc_error",
            "_run_process",
            "on_proc_error",
        ],
        allowPublicApiTerms: ["error_occurred"],
        verifier: {
            kind: "docker",
            image: "python:3.12-slim",
            language: "python",
            pythonScript: `
import ast, pathlib, sys

guiproc = pathlib.Path("qutebrowser/misc/guiprocess.py").read_text()
editor = pathlib.Path("qutebrowser/misc/editor.py").read_text()
userscripts = pathlib.Path("qutebrowser/commands/userscripts.py").read_text()

for name, src in [("guiprocess.py", guiproc), ("editor.py", editor), ("userscripts.py", userscripts)]:
    ast.parse(src, filename=name)

if "error_occurred = pyqtSignal(QProcess.ProcessError)" not in guiproc:
    print("FAIL: missing error_occurred pyqtSignal definition")
    sys.exit(1)
if "self._proc.errorOccurred.connect(self.error_occurred)" not in guiproc:
    print("FAIL: guiprocess __init__ does not bridge to self.error_occurred")
    sys.exit(1)
if "self._proc.error_occurred.connect(self._on_proc_error)" not in editor:
    print("FAIL: editor.py still uses legacy .error.connect")
    sys.exit(1)
if "self.proc.error_occurred.connect(self.on_proc_error)" not in userscripts:
    print("FAIL: userscripts.py still uses legacy .error.connect")
    sys.exit(1)
print("OK: Python AST parsed and all 3 GUIProcess signal sites verified")
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `The GUI child-process wrapper already listens to \`errorOccurred\` on its underlying Qt process, yet still exposes its own custom signal under the deprecated name \`error\` (which triggers Qt naming conflicts with method lookups). Rename that wrapper class's custom signal from \`error\` to \`error_occurred\`, update its internal signal forwarding connection, and update every non-test production caller in the repository that connects a callback to an instance of that child-process wrapper without touching unrelated classes that define their own \`error\` signals.`,
        rubric: [
            {
                id: "guiprocess_error_occurred_all_3",
                description: "Renames signal to error_occurred and updates editor and userscript callers",
                weight: 8,
            },
        ],
    },
    {
        id: "V8",
        tier: "medium",
        category: "cross-subsystem-trace",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "flipt",
        baseId: "swe:S3",
        language: "Go",
        repoFiles: 474,
        title: "Trace v2 evaluation RPC reason mapping, boolean validation, and SQL rule aggregation",
        goldFiles: [
            "internal/server/evaluation/evaluation.go",
            "internal/storage/sql/common/evaluation.go",
        ],
        goldSymbols: [
            "FlagType_BOOLEAN_FLAG_TYPE",
            "ErrInvalidf",
            "MATCH_EVALUATION_REASON",
            "FLAG_DISABLED_EVALUATION_REASON",
            "GetEvaluationRules",
            "rule_segments",
            "uniqueRules",
            "EvaluationConstraint",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace the v2 flag evaluation server handler path down into the shared SQL rule loader in this feature-flag service, citing exact \`file:Lx-Ly\` line ranges:\n` +
            `1. How does the variant RPC endpoint translate internal engine evaluation reason constants into v2 RPC enum values, and what flag-type check does the sibling boolean RPC handler enforce before delegating evaluation (including the exact error helper returned on mismatch)?\n` +
            `2. In the common SQL storage method that fetches ordered evaluation rules for a flag, what two SQL queries execute, and how does row scanning deduplicate rules while assembling per-rule segment and constraint entries?`,
        rubric: [
            {
                id: "cites_eval_server_and_sql",
                description: "Cites internal/server/evaluation/evaluation.go and internal/storage/sql/common/evaluation.go",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/server\/evaluation\/evaluation\.go/i, /storage\/sql\/common\/evaluation\.go/i, /\bL\d+/]),
            },
            {
                id: "variant_and_boolean_validation",
                description: "Explains reason enum mapping and FlagType_BOOLEAN_FLAG_TYPE / ErrInvalidf check",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /MATCH_EVALUATION_REASON/,
                        /FLAG_DISABLED_EVALUATION_REASON/,
                        /FlagType_BOOLEAN_FLAG_TYPE/,
                        /ErrInvalidf/,
                    ]),
            },
            {
                id: "sql_rule_segment_constraint_queries",
                description: "Explains rules query + joined rule_segments/segments/constraints query",
                weight: 2,
                test: (txt) => hasAll(txt, [/segment_operator/, /rule_segments/, /LeftJoin|LEFT[- ]JOIN/i, /constraints/]),
            },
            {
                id: "unique_rules_dedup",
                description: "Explains uniqueRules map deduplication and EvaluationConstraint appending",
                weight: 2,
                test: (txt) => hasAll(txt, [/uniqueRules/, /EvaluationSegment/, /EvaluationConstraint|Constraints/]),
            },
        ],
    },
    {
        id: "V9",
        tier: "medium",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "NodeBB",
        baseId: "swe:S5",
        language: "JavaScript",
        repoFiles: 727,
        title: "Harden password reset code type check, admin rate-limit bypass, and socket email trimming",
        goldFiles: [
            "src/user/reset.js",
            "src/socket.io/user.js",
            "src/socket.io/admin/user.js",
        ],
        goldSymbols: [
            "UserReset.validate",
            "UserReset.send",
            "canGenerate",
            "sendPasswordResetEmail",
            "SocketUser.reset.send",
        ],
        allowPublicApiTerms: ["bypassRateLimit"],
        verifier: {
            kind: "docker",
            image: "node:24-slim",
            language: "javascript",
            nodeScript: `
import assert from "node:assert/strict";
import Module from "node:module";
import { pathToFileURL } from "node:url";

let sentEmails = [];
const stubDb = {
    getObjectField: async () => { throw new Error("DB must not be queried on non-string code"); },
    sortedSetScore: async () => Date.now(), // triggers rate limit unless bypassRateLimit is passed
    sortedSetAdd: async () => {},
};
const stubUser = {
    getUidByEmail: async (email) => (email === "alice@example.com" ? 42 : 0),
    getUserFields: async () => ({ email: "alice@example.com", username: "alice" }),
    reset: null,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "../database" || request === "../../database") return stubDb;
    if (request === "./index" || request === "../user" || request === "../../user") return stubUser;
    if (request === "nconf") return { get: () => "https://forum.test" };
    if (request === "winston") return { error: () => {}, warn: () => {} };
    if (request === "async") return { eachLimit: async () => {} };
    if (request === "../groups" || request === "../../groups") return {};
    if (request === "../utils") return { generateUUID: () => "reset-code-123" };
    if (request === "../batch") return {};
    if (request === "../meta") return { config: {} };
    if (request === "../emailer") return { send: async (tpl, uid, p) => { sentEmails.push(p); } };
    if (request === "../password") return {};
    if (request === "../api" || request === "../../api") return {};
    if (request === "../topics" || request === "../messaging" || request === "../plugins") return {};
    if (request === "../controllers/user" || request === "../privileges") return {};
    if (request === "../events" || request === "../../events") return { log: async () => {} };
    if (request === "../../translator") return {};
    if (request === "." || request === "..") return { warnDeprecated: () => {} };
    if (request.startsWith("./user/") || request === "../promisify") return () => {};
    return origLoad.apply(this, arguments);
};

const req = Module.createRequire(pathToFileURL(process.cwd() + "/package.json").href);
const UserReset = req("./src/user/reset.js");
stubUser.reset = UserReset;
UserReset.generate = async () => "reset-code-123";

assert.equal(await UserReset.validate(null), false, "non-string null code must return false before DB");
assert.equal(await UserReset.validate(12345), false, "non-string numeric code must return false before DB");

const adminSockUser = req("./src/socket.io/admin/user.js");
await adminSockUser.sendPasswordResetEmail({ uid: 1 }, [42]);
assert.equal(sentEmails.length, 1, "admin password reset must bypass cooldown");

const clientSockUser = req("./src/socket.io/user.js");
let threwInvalid = false;
try {
    await clientSockUser.reset.send({ ip: "127.0.0.1", uid: 42 }, "   ");
} catch (err) {
    threwInvalid = String(err.message).includes("invalid-data");
}
assert.equal(threwInvalid, true, "whitespace-only email must be rejected as invalid-data");
await clientSockUser.reset.send({ ip: "127.0.0.1", uid: 42 }, "  alice@example.com  ").catch(() => {});
console.log("OK: all NodeBB password-reset behavioral assertions passed");
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Harden NodeBB's password-reset flow across the core reset handler and its client/admin Socket.IO endpoints to fix three issues:\n` +
            `1. Validating a reset token currently queries the database even when the caller passes a non-string value (such as \`null\`, \`undefined\`, or a number); return \`false\` immediately before touching the database whenever the token is missing or not a string.\n` +
            `2. Admin-triggered password reset emails currently hit the 1-minute per-user generation cooldown meant only for user self-service requests. Extend the reset-email sender with an optional second parameter supporting \`options.bypassRateLimit\` (truthy skips the cooldown check) and have the admin Socket.IO password-reset handler pass \`{ bypassRateLimit: true }\`.\n` +
            `3. In the client Socket.IO handler for sending a password reset, normalize the email input by coercing/trimming surrounding whitespace before checking for an empty email so whitespace-only strings are rejected with the invalid-data error and trimmed addresses reach the sender.`,
        rubric: [
            {
                id: "nodebb_reset_all_3",
                description: "Updates reset module, admin socket caller, and client socket caller cleanly",
                weight: 8,
            },
        ],
    },

    // =========================================================================
    // Large Tier (1,000-2,500 files): V10 - V12
    // =========================================================================
    {
        id: "V10",
        tier: "large",
        category: "cross-subsystem-trace",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "tutanota",
        baseId: "swe:S8",
        language: "TypeScript",
        repoFiles: 1350,
        title: "Trace device credential encryption mode switching, keychain key provisioning, and key guardrails",
        goldFiles: [
            "src/misc/credentials/CredentialsProvider.ts",
            "src/misc/credentials/CredentialsKeyProvider.ts",
            "src/misc/credentials/NativeCredentialsEncryption.ts",
            "src/misc/credentials/CredentialsKeyMigrator.ts",
        ],
        goldSymbols: [
            "setCredentialsEncryptionMode",
            "migrateCredentialsKey",
            "decryptUsingKeychain",
            "encryptUsingKeychain",
            "getCredentialsKey",
            "Trying to encrypt non-persistent credentials",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace Tutanota's on-device credentials encryption lifecycle across its provider, key provisioning, keychain migrator, and native encryption adapter, citing exact \`file:Lx-Ly\` lines:\n` +
            `1. When changing the device's credential encryption mode, what no-op guard runs first, how is an existing encrypted intermediate key migrated between modes, and in what order (and with what arguments) do the native keychain requests execute?\n` +
            `2. How does intermediate key lookup branch when storage already holds a key versus when it returns \`null\`, and what exact error string is raised if no encryption mode has been configured yet?\n` +
            `3. When encrypting credentials via the native adapter, what guard check triggers an error on non-persistent credentials (exact message), and which credential token property is encrypted/decrypted with the device encryption facade?`,
        rubric: [
            {
                id: "cites_all_four_files",
                description: "Cites CredentialsProvider.ts, CredentialsKeyProvider.ts, NativeCredentialsEncryption.ts, and CredentialsKeyMigrator.ts",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /CredentialsProvider\.ts/i,
                        /CredentialsKeyProvider\.ts/i,
                        /NativeCredentialsEncryption\.ts/i,
                        /CredentialsKeyMigrator\.ts/i,
                        /\bL\d+/,
                    ]),
            },
            {
                id: "mode_switch_migration_order",
                description: "Explains early return, migrateCredentialsKey, decryptUsingKeychain then encryptUsingKeychain",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /setCredentialsEncryptionMode/,
                        /migrateCredentialsKey/,
                        /decryptUsingKeychain/,
                        /encryptUsingKeychain/,
                    ]),
            },
            {
                id: "key_generation_and_mode_error",
                description: "Explains generateKey when absent and 'Encryption mode not set'",
                weight: 2,
                test: (txt) => hasAll(txt, [/generateKey/, /setCredentialsEncryptionKey/, /Encryption mode not set/i]),
            },
            {
                id: "non_persistent_guard_and_access_token",
                description: "Identifies encryptedPassword == null guard and accessToken encryption",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/Trying to encrypt non-persistent credentials/i, /encryptedPassword/, /accessToken/]),
            },
        ],
    },
    {
        id: "V11",
        tier: "large",
        category: "code-edit",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "tutanota",
        baseId: "swe:S8",
        language: "TypeScript",
        repoFiles: 1350,
        title: "Add supported-mode check, clearCredentialsKey, decrypt guard, and same-mode migration short-circuit",
        goldFiles: [
            "src/misc/credentials/CredentialsProvider.ts",
            "src/misc/credentials/CredentialsKeyProvider.ts",
            "src/misc/credentials/NativeCredentialsEncryption.ts",
            "src/misc/credentials/CredentialsKeyMigrator.ts",
        ],
        goldSymbols: [
            "setCredentialsEncryptionMode",
            "getSupportedEncryptionModes",
            "CredentialsKeyProvider",
            "NativeCredentialsEncryption",
            "CredentialsKeyMigrator",
            "migrateCredentialsKey",
        ],
        allowPublicApiTerms: ["clearCredentialsKey"],
        verifier: {
            kind: "docker",
            image: "node:24-slim",
            language: "typescript",
            nodeScript: `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const provider = readFileSync("src/misc/credentials/CredentialsProvider.ts", "utf8");
const keyProvider = readFileSync("src/misc/credentials/CredentialsKeyProvider.ts", "utf8");
const nativeEnc = readFileSync("src/misc/credentials/NativeCredentialsEncryption.ts", "utf8");
const migrator = readFileSync("src/misc/credentials/CredentialsKeyMigrator.ts", "utf8");

assert.match(provider, /getSupportedEncryptionModes\\s*\\(\\s*\\)/);
assert.match(provider, /Unsupported encryption mode:/i);
assert.match(keyProvider, /clearCredentialsKey\\s*\\(\\s*\\)/);
assert.match(keyProvider, /setCredentialsEncryptionKey\\s*\\(\\s*null\\s*\\)/);
assert.match(nativeEnc, /Trying to decrypt empty access token/i);
assert.match(migrator, /oldMode\\s*===\\s*newMode/);
assert.match(migrator, /return\\s+oldKeyEncrypted/);
console.log("OK: all 4 Tutanota credentials hardening checks passed");
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Harden Tutanota's device credentials encryption subsystem across its 4 coordinated modules:\n` +
            `1. Switching the encryption mode currently persists an arbitrary mode without verifying device support; after checking whether the requested mode equals the current mode, check whether the list of supported modes includes the requested mode and throw \`new Error(\\\`Unsupported encryption mode: \${encryptionMode}\\\`)\` if unsupported.\n` +
            `2. On the credentials key provider interface and implementation, expose a \`clearCredentialsKey(): void\` method that clears the stored encrypted key to \`null\`.\n` +
            `3. In the native credentials decryption path, fail fast at entry with \`new Error("Trying to decrypt empty access token")\` when the persistent credentials object has an empty \`accessToken\`.\n` +
            `4. In keychain key migration, short-circuit immediately and return the existing encrypted key without invoking native decrypt/encrypt keychain calls when the source and destination modes are equal.`,
        rubric: [
            {
                id: "tutanota_creds_all_4",
                description: "Updates all 4 credential TypeScript files accurately",
                weight: 8,
            },
        ],
    },
    {
        id: "V12",
        tier: "large",
        category: "cross-subsystem-trace",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: true,
        negativeControl: false,
        repo: "vite",
        baseId: "vite",
        repoUrl: "https://github.com/vitejs/vite.git",
        baseCommit: "adc761d6e123c1fd0917c8b80e0d1050689ccbcd",
        language: "TypeScript",
        repoFiles: 1665,
        title: "Trace Vite HMR update propagation boundaries and soft-vs-hard module invalidation",
        goldFiles: [
            "packages/vite/src/node/server/hmr.ts",
            "packages/vite/src/node/server/moduleGraph.ts",
        ],
        goldSymbols: [
            "propagateUpdate",
            "invalidateModule",
            "EnvironmentModuleNode",
            "acceptedHmrExports",
            "acceptedHmrDeps",
            "isSelfAccepting",
            "HARD_INVALIDATED",
            "invalidationState",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace how Vite's development server propagates hot-module-replacement updates across the environment module graph and invalidates cached transforms, citing exact \`file:Lx-Ly\` lines:\n` +
            `1. When traversing importers during an update walk, how does propagation handle unanalyzed modules (whose self-acceptance flag is still \`undefined\`), fully self-accepting modules, partial export-accepting modules, circular invalidations, and dead-end modules with no importers?\n` +
            `2. In the environment module graph's invalidation logic, how does soft invalidation preserve reusable transform output versus hard invalidation forcing full re-transformation, and why must traversal dedupe check both visited membership and prior invalidation state?`,
        rubric: [
            {
                id: "cites_vite_hmr_and_mg",
                description: "Cites hmr.ts and moduleGraph.ts with line ranges",
                weight: 3,
                test: (txt) => hasAll(txt, [/hmr\.ts/i, /moduleGraph\.ts/i, /\bL\d+/]),
            },
            {
                id: "vite_propagation_cases",
                description: "Explains unanalyzed undefined stop, isSelfAccepting boundary, acceptedHmrExports, and dead-end true",
                weight: 3,
                test: (txt) =>
                    hasAll(txt, [/propagateUpdate/, /isSelfAccepting/, /acceptedHmrExports|acceptedHmrDeps/]),
            },
            {
                id: "vite_soft_hard_invalidation",
                description: "Explains softInvalidate vs HARD_INVALIDATED on invalidationState / transformResult",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/invalidateModule/, /invalidationState/, /HARD_INVALIDATED|transformResult/]),
            },
        ],
    },

    // =========================================================================
    // Mega / Monorepo Tier (3,000-10,000+ files): V13 - V14
    // =========================================================================
    {
        id: "V13",
        tier: "mega",
        category: "cross-subsystem-trace",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: false,
        repo: "typescript",
        baseId: "typescript",
        repoUrl: "https://github.com/microsoft/TypeScript.git",
        baseCommit: "6327ae16673fe527482c24c37814a5b55162395d",
        language: "Go+TypeScript",
        repoFiles: 4200,
        title: "Trace TypeScript native compiler module resolution and IPC callback resolver bridging",
        goldFiles: [
            "tsc/internal/module/resolver.go",
            "tsc/internal/api/module_resolution.go",
        ],
        goldSymbols: [
            "DefaultResolver",
            "ResolveModuleName",
            "moduleResolverFactory",
            "callbackModuleResolver",
            "fallbackResolver",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace module specifier resolution across the native Go compiler core and its API session callback layer in this monorepo, citing exact \`file:Lx-Ly\` lines:\n` +
            `1. How does the API module resolver factory configure a default module resolver, wrap static precomputed resolution maps when no custom callback is registered, and delegate through a callback wrapper over IPC when a host resolution callback is active?\n` +
            `2. In the core module resolver implementation, what entry methods resolve module names for a containing file versus directory, and what internal candidate structure tracks resolved extensions and package identifiers?`,
        rubric: [
            {
                id: "cites_ts_resolver_and_api",
                description: "Cites tsc/internal/module/resolver.go and tsc/internal/api/module_resolution.go",
                weight: 4,
                test: (txt) =>
                    hasAll(txt, [/module\/resolver\.go/i, /api\/module_resolution\.go/i, /\bL\d+/]),
            },
            {
                id: "ts_factory_and_core_methods",
                description: "Identifies moduleResolverFactory / callbackModuleResolver and DefaultResolver.ResolveModuleName",
                weight: 4,
                test: (txt) =>
                    hasAll(txt, [
                        /moduleResolverFactory|callbackModuleResolver/,
                        /NewStaticResolver|fallbackResolver/,
                        /ResolveModuleName/,
                    ]),
            },
        ],
    },
    {
        id: "V14",
        tier: "mega",
        category: "caller-blast-radius",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: true,
        negativeControl: false,
        repo: "react",
        baseId: "react",
        repoUrl: "https://github.com/facebook/react.git",
        baseCommit: "edae846a9a17442c00429f2b15375afbfa0376c9",
        language: "JavaScript",
        repoFiles: 4450,
        title: "Trace React reconciler fiber update scheduling and concurrent hook callers",
        goldFiles: [
            "packages/react-reconciler/src/ReactFiberWorkLoop.js",
            "packages/react-reconciler/src/ReactFiberHooks.js",
            "packages/react-reconciler/src/ReactFiberConcurrentUpdates.js",
        ],
        goldSymbols: [
            "scheduleUpdateOnFiber",
            "ensureRootIsScheduled",
            "markRootUpdated",
            "prepareFreshStack",
            "enqueueConcurrentHookUpdate",
            "getRootForUpdatedFiber",
        ],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace React's reconciler fiber scheduling and concurrent state-hook dispatch path across this monorepo, citing exact \`file:Lx-Ly\` lines:\n` +
            `1. Inside the core work-loop function that schedules an update lane on a fiber root, how does execution diverge between an update dispatched during an active render phase versus a normal external event, when does an incoming update reset a suspended stack, and what root scheduling function terminates the normal path?\n` +
            `2. How do concurrent hook updates walk/resolve the target root for a fiber before reaching the work-loop scheduler, and where in the hooks module are state/reducer dispatches routed into fiber scheduling?`,
        rubric: [
            {
                id: "cites_react_reconciler_files",
                description: "Cites ReactFiberWorkLoop.js, ReactFiberHooks.js, and ReactFiberConcurrentUpdates.js",
                weight: 3,
                test: (txt) =>
                    hasAll(txt, [
                        /ReactFiberWorkLoop\.js/i,
                        /ReactFiber(?:Hooks|ConcurrentUpdates)\.js/i,
                        /\bL\d+/,
                    ]),
            },
            {
                id: "react_workloop_branches",
                description: "Explains scheduleUpdateOnFiber render-phase branch, markRootUpdated, suspended reset, and ensureRootIsScheduled",
                weight: 3,
                test: (txt) =>
                    hasAll(txt, [
                        /scheduleUpdateOnFiber/,
                        /markRootUpdated/,
                        /ensureRootIsScheduled/,
                    ]),
            },
            {
                id: "react_concurrent_hook_callers",
                description: "Identifies enqueueConcurrentHookUpdate / getRootForUpdatedFiber and hook callers",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [/enqueueConcurrentHookUpdate|getRootForUpdatedFiber/, /ReactFiberHooks\.js/i]),
            },
        ],
    },
];

export const V2_NEGATIVE_CONTROLS = [
    {
        id: "N1",
        tier: "small",
        category: "local-typo",
        promptStyle: "local",
        deLeaked: true,
        holdout: false,
        negativeControl: true,
        repo: "plexer",
        baseId: "ab:plexer",
        language: "JavaScript",
        repoFiles: 130,
        title: "Negative control: single-file comment wording fix (zero graph exploration needed)",
        goldFiles: ["bin/plexer.js"],
        goldSymbols: [],
        allowPublicApiTerms: [],
        verifier: {
            kind: "native",
            command: "node --check bin/plexer.js",
            checkScript: `
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const s = readFileSync("bin/plexer.js", "utf8");
assert.ok(s.includes("CLI bootstrapper"), "bin/plexer.js header must remain intact");
assert.ok(s.toLowerCase().includes("startup"), "updated comment must clarify fast startup");
`,
        },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In \`bin/plexer.js\`, line 2's top-of-file header comment reads \`plexer\` CLI bootstrapper. Update only that comment line so it explicitly mentions \`fast startup (~15ms)\` without changing any executable code, and stop immediately.`,
        rubric: [
            {
                id: "n1_local_comment_edit",
                description: "Edits only bin/plexer.js header comment cleanly",
                weight: 8,
            },
        ],
    },
    {
        id: "N2",
        tier: "medium",
        category: "ambiguous-symbol",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: true,
        repo: "pocketbase",
        baseId: "pocketbase",
        language: "Go",
        repoFiles: 444,
        title: "Negative control: disambiguate common Validate method for OAuth2 provider config only",
        goldFiles: ["core/collection_model_auth_options.go"],
        goldSymbols: ["OAuth2Config", "OAuth2ProviderConfig", "Validate"],
        allowPublicApiTerms: ["Validate"],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Dozens of configuration types across this repository define a \`Validate\` method. Locate ONLY the \`Validate\` implementation enforcing OAuth2 authentication collection configuration constraints (duplicate provider names, client credentials, and mapped fields), cite its exact \`file:Lx-Ly\` range, and state what rules it checks without listing unrelated collection or settings validators.`,
        rubric: [
            {
                id: "n2_oauth2_validator_only",
                description: "Cites core/collection_model_auth_options.go OAuth2 Validate logic accurately",
                weight: 8,
                test: (txt) =>
                    hasAll(txt, [/collection_model_auth_options\.go/i, /OAuth2/, /\bL\d+/]),
            },
        ],
    },
    {
        id: "N3",
        tier: "medium",
        category: "dynamic-reflection",
        promptStyle: "symptom",
        deLeaked: true,
        holdout: false,
        negativeControl: true,
        repo: "NodeBB",
        baseId: "swe:S5",
        language: "JavaScript",
        repoFiles: 727,
        title: "Negative control: runtime string-keyed plugin hook resolution & dispatch",
        goldFiles: ["src/plugins/hooks.js"],
        goldSymbols: ["register", "fire", "deprecatedHooks", "fireFilterHook"],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Explain how NodeBB resolves and fires plugin event hooks dynamically at runtime when handlers are configured by hook string names and dotted library method path strings (for example mapping \`"filter:..."\` prefixes cleanly and logging deprecation replacements), citing exact \`file:Lx-Ly\` spans.`,
        rubric: [
            {
                id: "n3_plugin_hooks_dynamic",
                description: "Cites src/plugins/hooks.js dynamic lookup and hookType dispatch",
                weight: 8,
                test: (txt) =>
                    hasAll(txt, [
                        /plugins\/hooks\.js/i,
                        /deprecatedHooks|loadedHooks/,
                        /filter|action|static|response/i,
                        /\bL\d+/,
                    ]),
            },
        ],
    },
    {
        id: "N4",
        tier: "small",
        category: "non-indexed-config",
        promptStyle: "local",
        deLeaked: true,
        holdout: false,
        negativeControl: true,
        repo: "plexer",
        baseId: "ab:plexer",
        language: "JSON",
        repoFiles: 130,
        title: "Negative control: non-indexed package.json metadata check",
        goldFiles: ["package.json"],
        goldSymbols: [],
        allowPublicApiTerms: [],
        verifier: { kind: "rubric" },
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Inspect \`package.json\` in the root directory and state concisely: the package name, module type, minimum required Node.js engine version, and runtime dependency package names.`,
        rubric: [
            {
                id: "n4_package_json_facts",
                description: "Reports @plexer/cli, module, >=22.13.0, and commander/tree-sitter deps",
                weight: 8,
                test: (txt) =>
                    hasAll(txt, [/@plexer\/cli/, /module/, /22\.13\.0/, /commander/, /web-tree-sitter/]),
            },
        ],
    },
];

export const ALL_V2_TASKS = [...V2_TASKS, ...V2_NEGATIVE_CONTROLS];
