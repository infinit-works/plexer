/**
 * Large-Repository & Discriminative Benchmark Suite (`L1`–`L8`).
 *
 * Covers Medium (440–730 files) and Large (1,350 files / 14.5k nodes / 35.1k edges)
 * polyglot repositories across 100% 3-arm-compatible languages (Go, TypeScript,
 * Python, JavaScript):
 *  - `pocketbase/pocketbase` (Go, 444 files, 5,924 nodes, 11,290 edges): `L1`, `L5`
 *  - `qutebrowser/qutebrowser` (Python, 463 files, 9,536 nodes, 15,422 edges): `L3`, `L7`
 *  - `flipt-io/flipt` (Go, 474 files, 4,799 nodes, 10,019 edges): `L4`
 *  - `NodeBB/NodeBB` (JavaScript, 727 files, 4,432 nodes, 12,180 edges): `L6`
 *  - `tutao/tutanota` (TypeScript, 1,350 files, 14,493 nodes, 35,084 edges): `L2`, `L8`
 *
 * Design principles:
 *  1. Zero file-path leakage in prompts: prompts describe symptoms, contracts,
 *     or subsystem behaviors without giving away the target file paths.
 *  2. Strict binary `resolved` grading on multi-file edit tasks (`L5`–`L8`):
 *     missing even 1 sibling file or failing any per-file behavioral contract
 *     check marks `resolved = false`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function hasAll(text, patterns) {
    return patterns.every((p) => p.test(text));
}

function readRepoFile(cloneDir, relPath) {
    try {
        return readFileSync(join(cloneDir, relPath), "utf8");
    } catch {
        return "";
    }
}

function getModifiedFiles(cloneDir) {
    try {
        const out = execFileSync("git", ["diff", "--name-only"], {
            cwd: cloneDir,
            encoding: "utf8",
        }).trim();
        return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export const LARGE_TASKS = [
    // =========================================================================
    // Category A: Deep Multi-Hop Cross-Subsystem Architectural & Caller Audits (L1 - L4)
    // =========================================================================
    {
        id: "L1",
        category: "cross-subsystem-trace",
        repo: "pocketbase",
        baseId: "pocketbase",
        language: "Go",
        sizeBucket: "medium",
        repoFiles: 444,
        title: "Trace PocketBase OAuth2 user creation, avatar file fallback, and RecordUpsert validation/dry-submit",
        goldFiles: ["apis/record_auth_with_oauth2.go", "forms/record_upsert.go"],
        oracleTokens: [
            "CollectionNameSuperusers",
            "15*time.Second",
            "NewFileFromURL",
            "sendOAuth2RecordCreateRequest",
            "syncPasswordFields",
            "disablePasswordValidations",
            "SaveNoValidateWithContext",
            "manualRollback",
        ],
        expectedTurns: 2,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace the OAuth2 authentication record-creation pipeline and the \`RecordUpsert\` form validation/submission lifecycle across this PocketBase repository. Answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. When \`recordAuthWithOAuth2\` submits a new OAuth2 sign-up (\`e.Record == nil\`) inside \`oauth2Submit\`, what collection check prevents superuser creation, how is \`e.OAuth2User.AvatarURL\` handled when the mapped field is \`FieldTypeFile\` versus a non-file field (including the exact context timeout used with \`filesystem.NewFileFromURL\`), and how does \`sendOAuth2RecordCreateRequest\` dispatch the internal record creation request?\n` +
            `2. In \`RecordUpsert\` (\`Submit\`, \`validateFormFields\`, \`syncPasswordFields\`, and \`DrySubmit\`), under what two exact conditions does \`syncPasswordFields\` set \`disablePasswordValidations = true\`, and how does \`DrySubmit\` roll back changes when \`app.DB()\` is already inside an existing \`*dbx.Tx\` transaction versus when it is not?`,
        rubric: [
            {
                id: "cites_both_subsystems",
                description: "Cites both apis/record_auth_with_oauth2.go and forms/record_upsert.go with line numbers",
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
                description: "Identifies CollectionNameSuperusers guard, 15*time.Second NewFileFromURL avatar download for FieldTypeFile, and sendOAuth2RecordCreateRequest internal POST",
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
                id: "sync_password_fields_conditions",
                description: "Explains the two conditions in syncPasswordFields that set disablePasswordValidations = true (v.Plain != '' && v.Plain != form.password, or v.Plain == '' && v.Hash != '' && form.record.IsNew())",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /syncPasswordFields/,
                        /disablePasswordValidations/,
                        /Plain/,
                        /Hash/,
                        /IsNew/,
                    ]),
            },
            {
                id: "dry_submit_rollback_branches",
                description: "Explains DrySubmit transaction check (app.DB().(*dbx.Tx)) and manualRollback (DeleteWithContext for new records vs Original().FieldsData() + SaveNoValidateWithContext for existing records)",
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
        id: "L2",
        category: "cross-subsystem-trace",
        repo: "tutanota",
        baseId: "S8",
        language: "TypeScript",
        sizeBucket: "large",
        repoFiles: 1350,
        title: "Audit Tutanota credentials encryption, key provisioning, and key migration pipeline",
        goldFiles: [
            "src/misc/credentials/CredentialsProvider.ts",
            "src/misc/credentials/CredentialsKeyProvider.ts",
            "src/misc/credentials/NativeCredentialsEncryption.ts",
            "src/misc/credentials/CredentialsKeyMigrator.ts",
        ],
        oracleTokens: [
            "setCredentialsEncryptionMode",
            "migrateCredentialsKey",
            "decryptUsingKeychain",
            "encryptUsingKeychain",
            "getCredentialsKey",
            "Encryption mode not set",
            "Trying to encrypt non-persistent credentials",
            "accessToken",
        ],
        expectedTurns: 2,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace the device credentials encryption, key provisioning, and key migration architecture across \`CredentialsProvider\`, \`CredentialsKeyProvider\`, \`NativeCredentialsEncryption\`, and \`CredentialsKeyMigrator\`. Answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. When \`CredentialsProvider.setCredentialsEncryptionMode\` changes the device's encryption mode, what check does it perform first, how does it handle an existing encrypted credentials key in storage, and what two native requests does \`CredentialsKeyMigrator.migrateCredentialsKey\` dispatch (including their argument order)?\n` +
            `2. In \`CredentialsKeyProvider.getCredentialsKey\`, how does key retrieval differ when \`getCredentialsEncryptionKey()\` returns an existing key versus \`null\`, and what exact error does \`_getEncryptionMode()\` throw when no mode is configured?\n` +
            `3. In \`NativeCredentialsEncryption.encrypt\` and \`decrypt\`, what guard check is performed on \`credentials.encryptedPassword\`, what exact error message is thrown if it fails, and which field of \`Credentials\` is encrypted/decrypted with \`DeviceEncryptionFacade\`?`,
        rubric: [
            {
                id: "cites_all_four_credential_files",
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
                id: "mode_migration_and_keychain_requests",
                description: "Explains setCredentialsEncryptionMode early return, migrateCredentialsKey, and decryptUsingKeychain([oldMode, ...]) followed by encryptUsingKeychain([newMode, ...])",
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
                id: "key_provider_generation_and_error",
                description: "Explains getCredentialsKey() generating a new key via _deviceEncryptionFacade.generateKey() when absent and _getEncryptionMode() throwing 'Encryption mode not set'",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /generateKey/,
                        /setCredentialsEncryptionKey/,
                        /Encryption mode not set/i,
                    ]),
            },
            {
                id: "native_encryption_guard_and_access_token",
                description: "Identifies encryptedPassword == null throwing 'Trying to encrypt non-persistent credentials' and encrypting/decrypting credentials.accessToken",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /Trying to encrypt non-persistent credentials/i,
                        /encryptedPassword/,
                        /accessToken/,
                    ]),
            },
        ],
    },
    {
        id: "L3",
        category: "caller-blast-radius",
        repo: "qutebrowser",
        baseId: "S1",
        language: "Python",
        sizeBucket: "medium",
        repoFiles: 463,
        title: "Trace check_overflow and GUIProcess cross-subsystem callers in qutebrowser",
        goldFiles: [
            "qutebrowser/api/cmdutils.py",
            "qutebrowser/browser/commands.py",
            "qutebrowser/misc/guiprocess.py",
            "qutebrowser/misc/editor.py",
            "qutebrowser/commands/userscripts.py",
        ],
        oracleTokens: [
            "check_overflow",
            "CommandError",
            "_cntwidget",
            "GUIProcess",
            "_start_editor",
            "_on_proc_error",
            "_run_process",
            "on_proc_error",
        ],
        expectedTurns: 2,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace two cross-subsystem call chains in qutebrowser and answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. How does \`cmdutils.check_overflow\` (\`qutebrowser/api/cmdutils.py\`) wrap \`qtutils.check_overflow\` and what exception does it raise on \`OverflowError\`? Which method in \`CommandDispatcher\` (\`qutebrowser/browser/commands.py\`) calls \`cmdutils.check_overflow\`, and what exact arguments does it pass when given a 1-based tab \`count\`?\n` +
            `2. In \`GUIProcess\` (\`qutebrowser/misc/guiprocess.py\`), how is the \`error\` signal declared and wired to \`self._proc\` in \`__init__\`? Across the non-test codebase, which two callers connect a handler directly to \`GUIProcess.error\` (name the exact files, enclosing methods, and connected handler callbacks)?`,
        rubric: [
            {
                id: "cmdutils_and_cntwidget_cited",
                description: "Cites qutebrowser/api/cmdutils.py and qutebrowser/browser/commands.py (_cntwidget calling cmdutils.check_overflow(count + 1, 'int'))",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /cmdutils\.py/i,
                        /commands\.py/i,
                        /_cntwidget/,
                        /count\s*\+\s*1/,
                    ]),
            },
            {
                id: "check_overflow_command_error",
                description: "Identifies qtutils.check_overflow(arg, ctype) and raising CommandError on OverflowError",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /qtutils\.check_overflow/,
                        /OverflowError/,
                        /CommandError/,
                    ]),
            },
            {
                id: "guiprocess_signal_wiring",
                description: "Cites qutebrowser/misc/guiprocess.py and explains error = pyqtSignal(QProcess.ProcessError) wired via self._proc.errorOccurred",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /guiprocess\.py/i,
                        /pyqtSignal\s*\(\s*QProcess\.ProcessError\s*\)/,
                        /errorOccurred/,
                        /errorOccurred\.connect|_on_error|self\.error/,
                    ]),
            },
            {
                id: "both_guiprocess_error_callers",
                description: "Identifies both qutebrowser/misc/editor.py (_start_editor -> _on_proc_error) and qutebrowser/commands/userscripts.py (_run_process -> on_proc_error)",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /editor\.py/i,
                        /_start_editor/,
                        /_on_proc_error/,
                        /userscripts\.py/i,
                        /_run_process/,
                        /\bon_proc_error\b/,
                    ]),
            },
        ],
    },
    {
        id: "L4",
        category: "cross-subsystem-trace",
        repo: "flipt",
        baseId: "S3",
        language: "Go",
        sizeBucket: "medium",
        repoFiles: 474,
        title: "Trace Flipt evaluation v2 Variant/Boolean handlers and SQL rule/constraint aggregation",
        goldFiles: [
            "internal/server/evaluation/evaluation.go",
            "internal/storage/sql/common/evaluation.go",
        ],
        oracleTokens: [
            "FlagType_BOOLEAN_FLAG_TYPE",
            "ErrInvalidf",
            "MATCH_EVALUATION_REASON",
            "FLAG_DISABLED_EVALUATION_REASON",
            "GetEvaluationRules",
            "rule_segments",
            "uniqueRules",
            "EvaluationConstraint",
        ],
        expectedTurns: 2,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Trace the v2 flag evaluation handlers and SQL evaluation rule loader in Flipt. Answer concisely with exact \`file:Lx-Ly\` line citations:\n` +
            `1. In the evaluation server (\`Variant\`, \`variant\`, and \`Boolean\` in \`internal/server/evaluation/evaluation.go\`), how does \`variant\` map \`flipt.EvaluationReason\` constants to \`rpcevaluation.EvaluationReason\`, and what validation check does \`Boolean\` perform on \`flag.Type\` before calling \`s.boolean\`?\n` +
            `2. In \`Store.GetEvaluationRules\` (\`internal/storage/sql/common/evaluation.go\`), what two SQL queries are executed against the database, and how does the row scan loop deduplicate rules via \`uniqueRules\` while attaching \`EvaluationSegment\` and \`EvaluationConstraint\` entries?`,
        rubric: [
            {
                id: "cites_eval_server_and_sql_store",
                description: "Cites both internal/server/evaluation/evaluation.go and internal/storage/sql/common/evaluation.go with line numbers",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /internal\/server\/evaluation\/evaluation\.go/i,
                        /internal\/storage\/sql\/common\/evaluation\.go/i,
                        /\bL\d+/,
                    ]),
            },
            {
                id: "variant_reason_mapping_and_boolean_check",
                description: "Identifies MATCH_EVALUATION_REASON, FLAG_DISABLED_EVALUATION_REASON, UNKNOWN_EVALUATION_REASON mapping and FlagType_BOOLEAN_FLAG_TYPE check returning errs.ErrInvalidf",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /MATCH_EVALUATION_REASON/,
                        /FLAG_DISABLED_EVALUATION_REASON/,
                        /UNKNOWN_EVALUATION_REASON/,
                        /FlagType_BOOLEAN_FLAG_TYPE/,
                        /ErrInvalidf/,
                    ]),
            },
            {
                id: "sql_two_queries_and_joins",
                description: "Explains the first query on rules (id, rank, segment_operator) and second query joining rule_segments, segments, and LeftJoin constraints",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /segment_operator/,
                        /rule_segments/,
                        /LeftJoin|LEFT[- ]JOIN(?:ED)?/i,
                        /constraints/,
                    ]),
            },
            {
                id: "unique_rules_segment_constraint_aggregation",
                description: "Explains how uniqueRules deduplicates EvaluationRule by ID, populates Segments[SegmentKey], and appends EvaluationConstraint when optionalConstraint.Id.Valid",
                weight: 2,
                test: (txt) =>
                    hasAll(txt, [
                        /uniqueRules/,
                        /EvaluationSegment/,
                        /EvaluationConstraint|segment\.Constraints/,
                        /optionalConstraint/,
                    ]),
            },
        ],
    },

    // =========================================================================
    // Category B: Multi-File Cross-Subsystem Engineering & Refactor Tasks (L5 - L8)
    // Strict Binary Resolution (`resolved`): 100% of gold sibling files must be
    // modified AND all per-file behavioral contract checks must pass.
    // =========================================================================
    {
        id: "L5",
        category: "code-edit",
        repo: "pocketbase",
        baseId: "pocketbase",
        language: "Go",
        sizeBucket: "medium",
        repoFiles: 444,
        title: "Add WebP thumbnail generation and PNG content-type fallback across PocketBase file API and filesystem",
        goldFiles: ["apis/file.go", "tools/filesystem/filesystem.go"],
        oracleTokens: [
            "imageContentTypes",
            "image/webp",
            "CreateThumb",
            "FormatFromFilename",
            "imaging.PNG",
            "image/png",
        ],
        expectedTurns: 3,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `PocketBase serves \`.webp\` files inline in its filesystem layer (\`inlineServeContentTypes\` includes \`"image/webp"\`), but requesting a thumbnail (\`?thumb=100x100\`) for a \`.webp\` image currently skips thumbnail generation and serves the original file. Implement WebP thumbnail support across both the file download API and the filesystem thumbnail generator:\n` +
            `1. In the file download API (\`apis/\`), add \`"image/webp"\` to \`imageContentTypes\` so \`.webp\` files are eligible for thumbnail generation in \`download\`.\n` +
            `2. In the filesystem package's \`CreateThumb\` method (\`tools/filesystem/\`), \`imaging.FormatFromFilename(thumbKey)\` already falls back to \`imaging.PNG\` when the extension is unrecognized (such as \`.webp\`), which encodes the thumbnail as PNG bytes, but \`opts := &blob.WriterOptions{ContentType: r.ContentType()}\` still stamps the original \`"image/webp"\` content type on the PNG-encoded thumbnail! Move or compute the format detection before creating the blob writer (or update \`opts.ContentType\`) so that when \`format == imaging.PNG\` and \`r.ContentType() == "image/webp"\` (or whenever \`err != nil\` from \`imaging.FormatFromFilename(thumbKey)\`), \`opts.ContentType\` is set to \`"image/png"\`.\n\n` +
            `Do not run slow full-repository \`go test ./...\` suites — make the surgical changes in both files and summarize the updated lines.`,
        verify: (cloneDir) => {
            const modFiles = new Set(getModifiedFiles(cloneDir));
            const fileApi = readRepoFile(cloneDir, "apis/file.go");
            const fsysGo = readRepoFile(cloneDir, "tools/filesystem/filesystem.go");

            const touchedBoth =
                modFiles.has("apis/file.go") && modFiles.has("tools/filesystem/filesystem.go");
            const hasWebpInApi = /imageContentTypes\s*=\s*\[\]string\{[^}]*"image\/webp"/.test(fileApi);
            const hasPngContentTypeInFsys =
                /ContentType[\s\S]{0,250}"image\/png"|"image\/png"[\s\S]{0,250}ContentType/.test(fsysGo) &&
                /FormatFromFilename/.test(fsysGo);

            let score = 0;
            const checks = [];
            const record = (id, ok, weight, detail) => {
                if (ok) score += weight;
                checks.push({ id, passed: ok, weight, detail });
            };
            record(
                "file_recall_both",
                touchedBoth,
                3,
                `Modified gold files: ${[...modFiles].filter((f) => f === "apis/file.go" || f === "tools/filesystem/filesystem.go").join(", ") || "none"}`
            );
            record("api_webp_content_type", hasWebpInApi, 2, "apis/file.go imageContentTypes includes \"image/webp\"");
            record(
                "fsys_png_content_type_fallback",
                hasPngContentTypeInFsys,
                3,
                "tools/filesystem/filesystem.go CreateThumb sets image/png ContentType on PNG fallback"
            );
            const resolved = touchedBoth && hasWebpInApi && hasPngContentTypeInFsys;
            return { score, maxScore: 8, resolved, checks, modifiedFiles: [...modFiles] };
        },
    },
    {
        id: "L6",
        category: "code-edit",
        repo: "NodeBB",
        baseId: "S5",
        language: "JavaScript",
        sizeBucket: "large",
        repoFiles: 727,
        title: "Propagate admin rate-limit bypass and input normalization across NodeBB password reset modules",
        goldFiles: [
            "src/user/reset.js",
            "src/socket.io/user.js",
            "src/socket.io/admin/user.js",
        ],
        oracleTokens: [
            "UserReset.validate",
            "UserReset.send",
            "canGenerate",
            "sendPasswordResetEmail",
            "SocketUser.reset.send",
        ],
        expectedTurns: 3,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Harden the password-reset flow across the user reset module and both its client and admin Socket.IO callers (3 files total):\n` +
            `1. In the user password-reset module (\`UserReset\`), update \`UserReset.validate(code)\` so that if \`!code || typeof code !== 'string'\` it returns \`false\` immediately before querying the database, and update \`UserReset.send(email, options = {})\` so that when \`options && options.bypassRateLimit\` is truthy it skips calling \`await canGenerate(uid)\`.\n` +
            `2. In the admin user Socket.IO handler (\`User.sendPasswordResetEmail\`), pass \`{ bypassRateLimit: true }\` as the second argument when calling \`user.reset.send(userData.email, { bypassRateLimit: true })\` so admins are not blocked by the 1-minute per-UID cooldown.\n` +
            `3. In the client user Socket.IO handler (\`SocketUser.reset.send\`), normalize \`email = String(email || '').trim()\` before the \`if (!email)\` guard so whitespace-only emails are rejected with \`[[error:invalid-data]]\` and trimmed emails are passed to \`user.reset.send(email)\`.\n\n` +
            `Edit all 3 files directly without running the full NodeBB test suite.`,
        verify: (cloneDir) => {
            const modFiles = new Set(getModifiedFiles(cloneDir));
            const resetJs = readRepoFile(cloneDir, "src/user/reset.js");
            const sockUserJs = readRepoFile(cloneDir, "src/socket.io/user.js");
            const sockAdminJs = readRepoFile(cloneDir, "src/socket.io/admin/user.js");

            const gold = ["src/user/reset.js", "src/socket.io/user.js", "src/socket.io/admin/user.js"];
            const matchedGold = gold.filter((f) => modFiles.has(f));
            const allThreeTouched = matchedGold.length === 3;

            const hasValidateGuard =
                /typeof\s+code\s*!==\s*['"]string['"]/.test(resetJs) &&
                /bypassRateLimit/.test(resetJs);
            const hasAdminBypass =
                /user\.reset\.send\s*\(\s*userData\.email\s*,\s*\{\s*bypassRateLimit\s*:\s*true\s*\}\s*\)/.test(
                    sockAdminJs
                );
            const hasClientTrim = /\.trim\(\)/.test(sockUserJs);

            let score = 0;
            const checks = [];
            const record = (id, ok, weight, detail) => {
                if (ok) score += weight;
                checks.push({ id, passed: ok, weight, detail });
            };
            record(
                "file_recall_all_3",
                allThreeTouched,
                2,
                `Modified ${matchedGold.length}/3 gold files (${matchedGold.join(", ")})`
            );
            record(
                "reset_validate_and_bypass",
                hasValidateGuard,
                2,
                "src/user/reset.js checks typeof code !== 'string' and supports options.bypassRateLimit"
            );
            record(
                "admin_socket_passes_bypass",
                hasAdminBypass,
                2,
                "src/socket.io/admin/user.js passes { bypassRateLimit: true } to user.reset.send"
            );
            record(
                "client_socket_trims_email",
                hasClientTrim,
                2,
                "src/socket.io/user.js trims email before validation and user.reset.send"
            );
            const resolved = allThreeTouched && hasValidateGuard && hasAdminBypass && hasClientTrim;
            return { score, maxScore: 8, resolved, checks, modifiedFiles: [...modFiles] };
        },
    },
    {
        id: "L7",
        category: "code-edit",
        repo: "qutebrowser",
        baseId: "S2",
        language: "Python",
        sizeBucket: "medium",
        repoFiles: 463,
        title: "Rename GUIProcess.error signal to error_occurred across GUIProcess and all production callers",
        goldFiles: [
            "qutebrowser/misc/guiprocess.py",
            "qutebrowser/misc/editor.py",
            "qutebrowser/commands/userscripts.py",
        ],
        oracleTokens: [
            "GUIProcess",
            "errorOccurred",
            "_start_editor",
            "_on_proc_error",
            "_run_process",
            "on_proc_error",
        ],
        expectedTurns: 3,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `In \`GUIProcess\`, the underlying \`QProcess\` already connects \`self._proc.errorOccurred\`, but \`GUIProcess\` itself still exposes the legacy signal name \`error = pyqtSignal(QProcess.ProcessError)\`. Rename \`GUIProcess\`'s signal attribute from \`error\` to \`error_occurred\` and update every non-test production caller in the repository that connects to a \`GUIProcess\` instance's \`error\` signal:\n` +
            `1. In \`GUIProcess\`, rename \`error = pyqtSignal(QProcess.ProcessError)\` to \`error_occurred = pyqtSignal(QProcess.ProcessError)\` and update \`self._proc.errorOccurred.connect(self.error)\` in \`__init__\` to \`self._proc.errorOccurred.connect(self.error_occurred)\`.\n` +
            `2. Find all non-test production callers in the codebase that instantiate \`guiprocess.GUIProcess\` and connect a slot to its \`.error\` signal, and update those signal connections to \`.error_occurred.connect(...)\` (do NOT modify unrelated classes whose own \`.error\` signal is not a \`GUIProcess\`).\n\n` +
            `Do not run pytest — apply the surgical edits across \`GUIProcess\` and its production callers.`,
        verify: (cloneDir) => {
            const modFiles = new Set(getModifiedFiles(cloneDir));
            const guiprocPy = readRepoFile(cloneDir, "qutebrowser/misc/guiprocess.py");
            const editorPy = readRepoFile(cloneDir, "qutebrowser/misc/editor.py");
            const userscriptsPy = readRepoFile(cloneDir, "qutebrowser/commands/userscripts.py");

            const gold = [
                "qutebrowser/misc/guiprocess.py",
                "qutebrowser/misc/editor.py",
                "qutebrowser/commands/userscripts.py",
            ];
            const matchedGold = gold.filter((f) => modFiles.has(f));
            const allThreeTouched = matchedGold.length === 3;

            const hasGuiProcRename =
                /error_occurred\s*=\s*pyqtSignal\s*\(\s*QProcess\.ProcessError\s*\)/.test(guiprocPy) &&
                /self\._proc\.errorOccurred\.connect\s*\(\s*self\.error_occurred\s*\)/.test(guiprocPy);
            const hasEditorConnect =
                /self\._proc\.error_occurred\.connect\s*\(\s*self\._on_proc_error\s*\)/.test(editorPy);
            const hasUserscriptsConnect =
                /self\.proc\.error_occurred\.connect\s*\(\s*self\.on_proc_error\s*\)/.test(userscriptsPy);

            let score = 0;
            const checks = [];
            const record = (id, ok, weight, detail) => {
                if (ok) score += weight;
                checks.push({ id, passed: ok, weight, detail });
            };
            record(
                "file_recall_all_3",
                allThreeTouched,
                2,
                `Modified ${matchedGold.length}/3 gold files (${matchedGold.join(", ")})`
            );
            record(
                "guiprocess_signal_renamed",
                hasGuiProcRename,
                2,
                "qutebrowser/misc/guiprocess.py defines error_occurred and connects self._proc.errorOccurred"
            );
            record(
                "editor_caller_updated",
                hasEditorConnect,
                2,
                "qutebrowser/misc/editor.py connects self._proc.error_occurred.connect(self._on_proc_error)"
            );
            record(
                "userscripts_caller_updated",
                hasUserscriptsConnect,
                2,
                "qutebrowser/commands/userscripts.py connects self.proc.error_occurred.connect(self.on_proc_error)"
            );
            const resolved =
                allThreeTouched && hasGuiProcRename && hasEditorConnect && hasUserscriptsConnect;
            return { score, maxScore: 8, resolved, checks, modifiedFiles: [...modFiles] };
        },
    },
    {
        id: "L8",
        category: "code-edit",
        repo: "tutanota",
        baseId: "S8",
        language: "TypeScript",
        sizeBucket: "large",
        repoFiles: 1350,
        title: "Add supported-mode validation, no-op key migration short-circuit, and key reset across 4 Tutanota credential modules",
        goldFiles: [
            "src/misc/credentials/CredentialsProvider.ts",
            "src/misc/credentials/CredentialsKeyProvider.ts",
            "src/misc/credentials/NativeCredentialsEncryption.ts",
            "src/misc/credentials/CredentialsKeyMigrator.ts",
        ],
        oracleTokens: [
            "setCredentialsEncryptionMode",
            "getSupportedEncryptionModes",
            "CredentialsKeyProvider",
            "NativeCredentialsEncryption",
            "CredentialsKeyMigrator",
            "migrateCredentialsKey",
        ],
        expectedTurns: 4,
        prompt: (repoDir) =>
            `Working directory: ${repoDir}\n\n` +
            `Harden the device credentials encryption subsystem across \`CredentialsProvider\`, \`CredentialsKeyProvider\`, \`NativeCredentialsEncryption\`, and \`CredentialsKeyMigrator\` (4 TypeScript files in \`src/misc/credentials/\`):\n` +
            `1. In \`CredentialsProvider.setCredentialsEncryptionMode(encryptionMode: CredentialEncryptionMode)\`, after the early return when \`encryptionMode === this.getCredentialsEncryptionMode()\`, verify that \`await this.getSupportedEncryptionModes()\` includes \`encryptionMode\`, throwing \`new Error(\`Unsupported encryption mode: \${encryptionMode}\`)\` if it is not supported.\n` +
            `2. In \`ICredentialsKeyProvider\` and \`CredentialsKeyProvider\`, add a \`clearCredentialsKey(): void\` method that resets the stored key via \`this._credentialsStorage.setCredentialsEncryptionKey(null)\`.\n` +
            `3. In \`NativeCredentialsEncryption.decrypt(encryptedCredentials: PersistentCredentials)\`, validate at the start of the method that \`encryptedCredentials.accessToken\` is non-empty, throwing \`new Error("Trying to decrypt empty access token")\` if \`!encryptedCredentials.accessToken\`.\n` +
            `4. In \`CredentialsKeyMigrator.migrateCredentialsKey(oldKeyEncrypted, oldMode, newMode)\`, if \`oldMode === newMode\`, return \`oldKeyEncrypted\` immediately without invoking \`decryptUsingKeychain\` or \`encryptUsingKeychain\`.\n\n` +
            `Apply all 4 surgical edits directly without running the full test suite.`,
        verify: (cloneDir) => {
            const modFiles = new Set(getModifiedFiles(cloneDir));
            const providerTs = readRepoFile(cloneDir, "src/misc/credentials/CredentialsProvider.ts");
            const keyProviderTs = readRepoFile(cloneDir, "src/misc/credentials/CredentialsKeyProvider.ts");
            const nativeEncTs = readRepoFile(
                cloneDir,
                "src/misc/credentials/NativeCredentialsEncryption.ts"
            );
            const migratorTs = readRepoFile(cloneDir, "src/misc/credentials/CredentialsKeyMigrator.ts");

            const gold = [
                "src/misc/credentials/CredentialsProvider.ts",
                "src/misc/credentials/CredentialsKeyProvider.ts",
                "src/misc/credentials/NativeCredentialsEncryption.ts",
                "src/misc/credentials/CredentialsKeyMigrator.ts",
            ];
            const matchedGold = gold.filter((f) => modFiles.has(f));
            const allFourTouched = matchedGold.length === 4;

            const hasSupportedCheck =
                /getSupportedEncryptionModes\s*\(\s*\)/.test(providerTs) &&
                /Unsupported encryption mode:/i.test(providerTs);
            const hasClearKeyMethod =
                /clearCredentialsKey\s*\(\s*\)/.test(keyProviderTs) &&
                /setCredentialsEncryptionKey\s*\(\s*null\s*\)/.test(keyProviderTs);
            const hasEmptyTokenGuard =
                /Trying to decrypt empty access token/i.test(nativeEncTs);
            const hasSameModeShortCircuit =
                /oldMode\s*===\s*newMode/.test(migratorTs) &&
                /return\s+oldKeyEncrypted/.test(migratorTs);

            let score = 0;
            const checks = [];
            const record = (id, ok, weight, detail) => {
                if (ok) score += weight;
                checks.push({ id, passed: ok, weight, detail });
            };
            record(
                "file_recall_all_4",
                allFourTouched,
                2,
                `Modified ${matchedGold.length}/4 gold files (${matchedGold.join(", ")})`
            );
            record(
                "provider_supported_mode_validation",
                hasSupportedCheck && hasClearKeyMethod,
                2,
                "CredentialsProvider validates getSupportedEncryptionModes() and CredentialsKeyProvider implements clearCredentialsKey()"
            );
            record(
                "native_decrypt_empty_token_guard",
                hasEmptyTokenGuard,
                2,
                "NativeCredentialsEncryption.decrypt throws 'Trying to decrypt empty access token' when accessToken is empty"
            );
            record(
                "migrator_same_mode_short_circuit",
                hasSameModeShortCircuit,
                2,
                "CredentialsKeyMigrator.migrateCredentialsKey returns oldKeyEncrypted when oldMode === newMode"
            );
            const resolved =
                allFourTouched &&
                hasSupportedCheck &&
                hasClearKeyMethod &&
                hasEmptyTokenGuard &&
                hasSameModeShortCircuit;
            return { score, maxScore: 8, resolved, checks, modifiedFiles: [...modFiles] };
        },
    },
];
