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
        ],
    },
    code_quality: {
        id: "code_quality",
        name: "Code quality",
        weight: 1.0,
        fileBased: true,
        detectors: [
            "dead_symbols",
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
    flat_dirs: ["package_organization"],
    naming_inconsistencies: ["convention_outlier", "naming_quality"],
    import_affinity_outliers: ["cross_module_architecture"],
    private_imports: ["cross_module_architecture"],
    file_cycles: ["cross_module_architecture", "dependency_health"],
    directory_cycles: ["cross_module_architecture", "dependency_health"],
    layer_violation: ["cross_module_architecture", "high_level_elegance"],
    low_cohesion_files: ["design_coherence", "abstraction_fitness"],
    monster_functions: ["design_coherence", "abstraction_fitness", "logic_clarity"],
    god_classes: ["design_coherence", "abstraction_fitness", "logic_clarity"],
    duplicates: ["convention_outlier"],
    dict_keys: ["type_safety"],
    silent_catches: ["error_consistency"],
    language_traps: ["design_coherence", "logic_clarity"],
    reactive_smells: ["design_coherence", "logic_clarity"],
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
    return [
        "## INSTRUCTIONS FOR AGENTS — Workflow Guide",
        "",
        "Work the two loops: **outer** (`scan` → `score` → at target? → `rescan`) and",
        "**inner** (`plan` → `next` → fix → `resolve` → repeat until queue clear).",
        "",
        "1. **Follow `next`**: `plexer health next` — the single source of truth for what to work on now.",
        "   It is the execution queue from the living plan, surfaces auto-clustered batches,",
        "   and tells you the exact file, lines, and resolve command to run.",
        "   Use `plexer health backlog` only to inspect broader open work outside execution.",
        "2. **Fix & resolve**: Fix the issue in code (using `plexer callers` / `plexer read`), then:",
        `   \`plexer health resolve "<id>" --note "<what you did>" --confirm\``,
        `   Or with explicit attestation: \`--attest "${attestExample}"\``,
        "3. **Plan strategically**: `plexer health plan` / `plexer health plan cluster list` — reorder,",
        "   cluster related issues (`plan cluster create`), and inspect the execution queue.",
        "4. **Run auto-fixers**: `plexer health autofix <fixer> --dry-run` to preview, then apply.",
        "   Use `plexer health move <src> <dst> --dry-run` to move files/dirs and auto-rewrite imports/requires.",
        "5. **Explore topology**: `plexer health tree` (annotated directory/file health tree),",
        "   `plexer health viz` (HTML treemap), or `plexer health detect <detector>` (fast single-detector run).",
        "6. **Rescan**: `plexer health scan` — verify improvements and catch cascading effects.",
        "7. **Subjective review**: `plexer health review --prepare` → run blind subagent reviews against",
        "   `plexer/.health/review_packet_blind.json` (20 dimensions + holistic context & concerns) →",
        "   `plexer health review --import <file>`.",
        "8. **Triage**: `plexer health plan triage --stage observe|reflect|organize --report \"...\"`",
        "   then `plexer health plan triage --complete --strategy \"...\"`.",
        "9. **Check progress**: `plexer health status` — dimension scores dashboard.",
        "",
        "### Understanding Scores",
        "- **Overall**: 25% mechanical + 75% subjective. Lenient — wontfix doesn't count against you.",
        "- **Objective**: Mechanical detectors only (no subjective review component).",
        "- **Strict**: Same as overall, but wontfix items and open review defects count against you. **THIS IS YOUR NORTH STAR.**",
        "- **Verified**: Like strict, but only credits fixes the scanner has confirmed on rescan.",
        "- Wontfix is not free — every wontfix (`plexer health plan skip --permanent` or `suppress`) requires attestation and widens the overall↔strict gap.",
    ].join("\n");
}

/**
 * Ready-to-paste Agent Loop Prompt (powered natively by plexer).
 */
export function buildAgentLoopPrompt(targetPath = ".") {
    return [
        "I want you to systematically improve the quality of this codebase using `plexer health`.",
        "Run ALL of the following:",
        "",
        "Before scanning, check for directories that should be excluded (vendor, build output,",
        "generated code, packages, worktrees, etc.) and exclude obvious ones with `plexer health exclude <path>`.",
        "Share any questionable candidates with me before excluding.",
        "",
        `plexer health scan ${targetPath}`,
        "plexer health next",
        "",
        "Your goal is to get the **strict score** as high as possible (target >= 98). The scoring",
        "resists gaming — the only way to improve it is to genuinely make the code better.",
        "",
        "THE LOOP: run `plexer health next`. It is the execution queue from the living plan, not the",
        "whole backlog. It tells you what to fix now, which file and lines, and the exact",
        "`plexer health resolve` command to run when done.",
        "Fix it, resolve it, run `plexer health next` again. Over and over. This is your main job.",
        "",
        "Use `plexer health backlog` only when you need to inspect broader open work that is not",
        "currently driving execution.",
        "",
        "Don't be lazy. Large refactors and small detailed fixes — do both with equal energy. No task",
        "is too big or too small. Fix things properly, not minimally. Use `plexer callers`, `plexer blast`,",
        "and `plexer health move` to verify blast radius and update all callers cleanly.",
        "",
        "Use `plexer health plan` / `plexer health plan cluster create <name>` to reorder priorities or",
        "group related issues. When subjective review is surfaced by `next`, run `plexer health review --prepare`,",
        "evaluate the 20 dimensions blindly against `plexer/.health/review_packet_blind.json`, and import with",
        "`plexer health review --import`. Rescan periodically with `plexer health scan`.",
    ].join("\n");
}
