/**
 * Constants, scoring dimensions, weights, tiers, and workflow prompts for `plexer health`.
 */
import {
    DIMENSION_ALIASES,
    DIMENSION_BATCHES,
    SUBJECTIVE_DIMENSIONS,
    normalizeDimensionKey,
} from "./dimensions.js";

export { DIMENSION_ALIASES, DIMENSION_BATCHES, SUBJECTIVE_DIMENSIONS, normalizeDimensionKey };

export const HEALTH_DIR = ".health";
export const STATE_FILE = "state.json";
export const PLAN_FILE = "plan.json";
export const CONFIG_FILE = "config.json";
export const QUERY_FILE = "query.json";
export const BLIND_PACKET_FILE = "review_packet_blind.json";
export const SCORECARD_FILE = "scorecard.svg";
export const BADGE_FILE = "badge.svg";

export const DEFAULT_TARGET_STRICT_SCORE = 98.0;
export const SAMPLE_DAMPENING_THRESHOLD = 200;
export const MECHANICAL_POOL_WEIGHT = 0.25;
export const SUBJECTIVE_POOL_WEIGHT = 0.75;
export const SUBJECTIVE_TOTAL_WEIGHT = Object.values(SUBJECTIVE_DIMENSIONS).reduce(
    (sum, d) => sum + (Number(d.weight) || 0),
    0,
);
export const RESOLVE_SCAN_GATE_LIMIT = 10;
export const SCORE_MODEL_VERSION = 2;

export const CONFIDENCE_WEIGHTS = {
    high: 1.0,
    medium: 0.7,
    low: 0.3,
};

/**
 * Mechanical dimensions and their pool weights.
 */
export const MECHANICAL_DIMENSIONS = {
    file_health: {
        id: "file_health",
        name: "File health",
        weight: 2.0,
        fileBased: false,
        detectors: [
            "monster_functions",
            "god_classes",
            "low_cohesion_files",
            "flat_dirs",
            "package_census",
            "naming_inconsistencies",
            "hotspots",
        ],
    },
    code_quality: {
        id: "code_quality",
        name: "Code quality",
        weight: 1.0,
        fileBased: true,
        detectors: [
            "dead_symbols",
            "unused_imports",
            "unreferenced_exports",
            "orphaned_files",
            "single_importer_files",
            "passthrough_wrappers",
            "facade_modules",
            "delegation_heavy_classes",
            "import_affinity_outliers",
            "private_imports",
            "signature_variance",
            "silent_catches",
            "type_bypasses",
            "enum_bypasses",
            "dict_keys",
            "stale_deprecations",
            "ai_slop",
            "debug_logs",
            "language_traps",
            "reactive_smells",
            "luau_quality",
            "temporal_coupling",
            "deceptive_queries",
        ],
    },
    duplication: {
        id: "duplication",
        name: "Duplication",
        weight: 1.0,
        fileBased: false,
        detectors: ["duplicates"],
    },
    test_health: {
        id: "test_health",
        name: "Test health",
        weight: 1.0,
        fileBased: true,
        detectors: ["untested_hubs", "hollow_tests"],
    },
    security: {
        id: "security",
        name: "Security & boundaries",
        weight: 1.0,
        fileBased: true,
        detectors: [
            "file_cycles",
            "directory_cycles",
            "layer_violation",
            "security_traps",
            "roblox_security",
        ],
    },
};

export const ALL_CATEGORIES = [
    "duplicates",
    "dead",
    "coupling",
    "cohesion",
    "tests",
    "catches",
    "types",
    "traps",
    "slop",
    "security",
];

export const DETECTOR_CATEGORY = {
    duplicates: "duplicates",
    dead_symbols: "dead",
    unused_imports: "dead",
    unreferenced_exports: "dead",
    orphaned_files: "dead",
    single_importer_files: "dead",
    passthrough_wrappers: "dead",
    facade_modules: "dead",
    delegation_heavy_classes: "cohesion",
    file_cycles: "coupling",
    directory_cycles: "coupling",
    layer_violation: "coupling",
    temporal_coupling: "coupling",
    import_affinity_outliers: "coupling",
    private_imports: "coupling",
    flat_dirs: "coupling",
    package_census: "coupling",
    naming_inconsistencies: "coupling",
    signature_variance: "cohesion",
    low_cohesion_files: "cohesion",
    monster_functions: "cohesion",
    god_classes: "cohesion",
    hotspots: "cohesion",
    deceptive_queries: "traps",
    untested_hubs: "tests",
    hollow_tests: "tests",
    silent_catches: "catches",
    type_bypasses: "types",
    enum_bypasses: "types",
    dict_keys: "types",
    stale_deprecations: "slop",
    ai_slop: "slop",
    debug_logs: "slop",
    language_traps: "traps",
    reactive_smells: "traps",
    luau_quality: "traps",
    security_traps: "security",
    roblox_security: "security",
};

export const REVIEWER_PERSONAS = [
    {
        name: "Pragmatist",
        id: "pragmatist",
        bias: "Simplicity, directness, and deleting unnecessary indirection or speculative abstractions.",
        question:
            "Can this layer, wrapper, or abstraction be deleted or inlined without losing real domain capability?",
    },
    {
        name: "Architect",
        id: "architect",
        bias: "Module boundaries, dependency direction, contract coherence, and long-term structural seams.",
        question:
            "Where do module boundaries leak internal state, invert layer dependencies, or blur domain responsibilities?",
    },
    {
        name: "Bug Hunter",
        id: "bug_hunter",
        bias: "Edge-case failures, silent error swallowing, race conditions, trust boundaries, and incomplete state transitions.",
        question:
            "What inputs, failure modes, or ordering assumptions will silently corrupt state or fail in production?",
    },
    {
        name: "Migrator",
        id: "migrator",
        bias: "Incomplete migrations, parallel legacy/modern paths, convention drift, and compatibility shims that outlived their rollout.",
        question:
            "Where are two competing patterns or half-finished migrations forcing readers to hold duplicate mental models?",
    },
];

export const ATTEST_RESOLVE_EXAMPLE =
    "I have reviewed this fix in code, verified callers/tests remain intact, and I am not gaming the score.";
export const ATTEST_WONTFIX_EXAMPLE =
    "I have reviewed this skip against the code and I am not gaming the score by suppressing a real defect.";
export const ATTEST_BLIND_REVIEW_EXAMPLE =
    "I have reviewed this codebase from code evidence against review_packet_blind.json and I am not gaming or anchoring the score.";

export const TRIAGE_STAGES = [
    "strategize",
    "observe",
    "reflect",
    "organize",
    "enrich",
    "sense-check",
    "commit",
    "complete",
];

/**
 * Mechanical detectors whose new/reopened findings mark linked subjective dimensions stale
 * (`marks_dims_stale` in upstream desloppify).
 */
export const DETECTOR_STALE_DIMENSIONS = {
    orphaned_files: ["design_coherence"],
    dead_symbols: ["design_coherence"],
    unused_imports: ["design_coherence"],
    flat_dirs: ["package_organization"],
    naming_inconsistencies: ["convention_outlier", "naming_quality"],
    import_affinity_outliers: ["cross_module_architecture"],
    private_imports: ["cross_module_architecture"],
    file_cycles: ["cross_module_architecture", "dependency_health"],
    directory_cycles: ["cross_module_architecture", "dependency_health"],
    layer_violation: ["cross_module_architecture", "high_level_elegance"],
    temporal_coupling: ["cross_module_architecture", "dependency_health"],
    low_cohesion_files: ["design_coherence", "abstraction_fitness"],
    monster_functions: ["design_coherence", "abstraction_fitness", "logic_clarity"],
    god_classes: ["design_coherence", "abstraction_fitness", "logic_clarity"],
    hotspots: ["design_coherence", "logic_clarity"],
    package_census: ["package_organization", "cross_module_architecture", "abstraction_fitness"],
    enum_bypasses: ["type_safety", "convention_outlier"],
    deceptive_queries: ["naming_quality", "contract_coherence", "logic_clarity"],
    duplicates: ["convention_outlier"],
    dict_keys: ["type_safety"],
    silent_catches: ["error_consistency"],
    language_traps: ["design_coherence", "logic_clarity"],
    reactive_smells: ["design_coherence", "logic_clarity"],
    untested_hubs: ["test_strategy"],
    hollow_tests: ["test_strategy"],
    type_bypasses: ["type_safety"],
    ai_slop: ["ai_generated_debt"],
    debug_logs: ["ai_generated_debt"],
    stale_deprecations: ["incomplete_migration"],
    passthrough_wrappers: ["abstraction_fitness"],
    facade_modules: ["abstraction_fitness"],
    delegation_heavy_classes: ["abstraction_fitness"],
    single_importer_files: ["abstraction_fitness", "package_organization"],
    unreferenced_exports: ["api_surface_coherence", "high_level_elegance"],
    signature_variance: ["api_surface_coherence", "contract_coherence"],
    luau_quality: ["logic_clarity", "contract_coherence"],
    security_traps: ["authorization_consistency", "error_consistency"],
    roblox_security: ["authorization_consistency", "contract_coherence"],
};

export const AVAILABLE_DIRECTIVE_PHASES = [
    "execute",
    "postflight",
    "review",
    "triage",
    "workflow",
    "scan",
];

/**
 * Build the scan workflow guide.
 */
export function buildWorkflowGuide(attestExample = ATTEST_RESOLVE_EXAMPLE) {
    return `## Workflow Guide

1. \`plexer health next\` — execution queue (use \`backlog\` for broader open work).
2. Fix with \`plexer callers\` / \`plexer read\`, then \`plexer health resolve "<id>" --note "<what you did>" --confirm\` (or \`--attest "${attestExample}"\`).
3. \`plexer health autofix <fixer> --dry-run\` · \`plexer health move <src> <dst> --dry-run\`.
4. \`plexer health plan\` / \`plan cluster create\` · \`plexer health review --prepare\` → \`--import <file>\` · \`plexer health scan\` to verify.

Scores: **strict** (north star; counts \`wontfix\` & open review) · **overall** (25% mech / 75% subj) · **objective** (mech only) · **verified** (rescan-confirmed).
Dismiss false positives cleanly via \`plexer health suppress "<id>" --false-positive --reason "<15+ chars>"\`.
Guardrails: never delete \`@generated\`/CI files (use \`zone set <path> generated\` or \`exclude\`), collapse data tables, strip public/dynamic entrypoints or wire keys, or add dummy \`local _ = ...\` bindings.`;
}

/**
 * Ready-to-paste Agent Loop Prompt (powered natively by plexer).
 */
export function buildAgentLoopPrompt(targetPath = ".") {
    return `Improve codebase quality systematically with \`plexer health\`:

1. Exclude vendor/build/generated paths first (\`plexer health exclude <path>\` or \`plexer health zone set <path> generated\`).
2. Run \`plexer health scan ${targetPath}\` then \`plexer health next\`.
3. Target **strict >= 98**. THE LOOP: run \`plexer health next\`, fix real defects (verify blast radius with \`plexer callers\` / \`plexer blast\` / \`plexer health move\`), dismiss genuine detector mistakes with \`plexer health suppress <id> --false-positive --reason "<why>"\`, \`plexer health resolve\`, and repeat.
4. Use \`plexer health backlog\` for non-queue items, \`plexer health plan\` / \`plan cluster create\` to group work, \`plexer health review --prepare\` → \`--import\` for subjective review, and \`plexer health scan\` periodically to verify.
5. Do no harm: never delete generated/CI files, inline cohesive data tables, strip public/dynamic entrypoints or wire payload keys, or silence warnings with dummy \`local _ = ...\` bindings.`;
}
