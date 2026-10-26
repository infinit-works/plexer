/**
 * Canonical 20 Subjective Review Dimensions, alias normalization, 0-100 anchors,
 * `look_for` / `skip` rubrics, 5 thematic batches, Two-Phase (`OBSERVE` -> `JUDGE`)
 * system prompt, and per-language review overrides (including Luau/Roblox).
 */

export const DIMENSION_ALIASES = {
    high_elegance: "high_level_elegance",
    mid_elegance: "mid_level_elegance",
    low_elegance: "low_level_elegance",
    contracts: "contract_coherence",
    abstraction_fit: "abstraction_fitness",
    structure_nav: "package_organization",
    cross_module_arch: "cross_module_architecture",
    init_coupling: "initialization_coupling",
    convention_drift: "convention_outlier",
    dep_health: "dependency_health",
    api_coherence: "api_surface_coherence",
    auth_consistency: "authorization_consistency",
    stale_migration: "incomplete_migration",
};

/**
 * Normalize a subjective dimension identifier (handling short aliases, spaces, and hyphens).
 */
export function normalizeDimensionKey(rawKey) {
    if (!rawKey || typeof rawKey !== "string") return "";
    const cleaned = rawKey
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    return DIMENSION_ALIASES[cleaned] || cleaned;
}

/**
 * All 20 canonical subjective review dimensions and their weights within the 75% subjective pool.
 */
export const SUBJECTIVE_DIMENSIONS = {
    high_level_elegance: {
        id: "high_level_elegance",
        short_id: "high_elegance",
        name: "High elegance",
        weight: 22.0,
        reset_on_scan: true,
        description:
            "Clear subsystem decomposition, coherent domain ownership, minimal public surface area, and absence of architectural bandaids.",
        look_for: [
            "Top-level packages/files map to domain capabilities rather than historical accidents",
            "Ownership and change boundaries are predictable — a new engineer can explain why each module exists",
            "Public surface (exports/entry points) is small and consistent with stated responsibility",
            "Subsystem decomposition localizes change without surprising ripple edits",
        ],
        skip: [
            "When dependency direction/cycle/hub failures are the primary issue, report under cross_module_architecture",
            "When handoff mechanics are the primary issue, report under mid_level_elegance",
            "Pure naming/style nits with no impact on role clarity",
        ],
        anchors: {
            100: "Each top-level package has unmistakable domain ownership and minimal public surface.",
            90: "Clear ownership with minor boundary blur that does not cause confusion.",
            80: "Mixed responsibilities or unclear ownership boundaries across modules.",
            60: "Purpose and ownership are muddled; engineers cannot predict where logic lives.",
        },
    },
    mid_level_elegance: {
        id: "mid_level_elegance",
        short_id: "mid_elegance",
        name: "Mid elegance",
        weight: 22.0,
        reset_on_scan: true,
        description:
            "Quality of handoffs and integration seams across modules and layers; minimal boundary translation glue.",
        look_for: [
            "Inputs/outputs across boundaries are explicit, minimal, and unsurprising",
            "Data translation at boundaries happens in one obvious place",
            "Error and lifecycle propagation across boundaries follows predictable patterns",
            "Orchestration reads as composition of collaborators, not tangled back-and-forth calls",
        ],
        skip: [
            "When top-level package decomposition is the primary issue, report under high_level_elegance",
            "When implementation craft inside one function/class is the primary issue, report under low_level_elegance",
        ],
        anchors: {
            100: "Handoffs across module boundaries are explicit, minimal, and unsurprising.",
            90: "Mostly clean seams with minor friction at a few boundaries.",
            80: "Awkward boundary translations, tangled orchestration, or glue-code entropy between modules.",
            60: "Seam design is tangled; cross-module changes require understanding implicit contracts.",
        },
    },
    low_level_elegance: {
        id: "low_level_elegance",
        short_id: "low_elegance",
        name: "Low elegance",
        weight: 12.0,
        reset_on_scan: true,
        description:
            "Direct, precise function and class internals; flat guard-clause control flow and bounded local mutation.",
        look_for: [
            "Control flow is direct and intention-revealing; branches are necessary and distinct",
            "State mutation and side effects are explicit, local, and bounded",
            "Edge-case handling is precise without defensive sprawl",
            "Extraction level is balanced: avoids both monoliths and micro-fragmentation",
        ],
        skip: [
            "When file responsibility/package role is the primary issue, report under high_level_elegance",
            "Provable logic/type/error defects already captured by logic_clarity, type_safety, or error_consistency",
        ],
        anchors: {
            100: "Function and class internals are concise, precise, and proportionate.",
            90: "Mostly clean craft with isolated rough edges.",
            80: "Local complexity — deep nesting, over-extraction, or defensive sprawl.",
            60: "Local implementation quality routinely impedes understanding.",
        },
    },
    contract_coherence: {
        id: "contract_coherence",
        short_id: "contracts",
        name: "Contracts",
        weight: 12.0,
        reset_on_scan: true,
        description:
            "Functions and modules that honor their stated contracts, preconditions, return types, and lifecycle semantics.",
        look_for: [
            "Return type annotation lies: declared type does not match all return paths",
            "Docstring/signature divergence: params described in docs but not in function signature",
            "Functions named getX/isX that mutate state (side effect hidden behind query name)",
            "Error contracts: function claims to throw/error but silently returns nil/null, or vice versa",
            "Lifecycle/cleanup contracts (Connections, scopes, handles) that leak on early return",
        ],
        skip: [
            "Protocol/interface stubs",
            "Test helpers where loose typing is intentional",
        ],
        anchors: {
            100: "Functions reliably do what their signatures, names, and docs promise.",
            90: "Minor local mismatches with low downstream impact.",
            80: "APIs regularly surprise callers with hidden side effects or lying return types.",
            60: "Contracts are contradictory; callers must read implementations to use them safely.",
        },
    },
    type_safety: {
        id: "type_safety",
        short_id: "type_safety",
        name: "Type safety",
        weight: 12.0,
        reset_on_scan: true,
        description:
            "Type annotations that match runtime behavior and prevent illegal states without unsound casts or raw enum strings.",
        look_for: [
            "Return type annotations that do not cover all code paths (e.g., missing nil/null union)",
            "Unsound `any` / `as any` / `:: any` casts or unannotated public APIs",
            "Union types that could be narrowed or discriminated cleanly",
            "Enum types bypassed with raw string or integer literals",
            "Parallel duplicate type definitions that drift apart",
        ],
        skip: [
            "Untyped private helpers in well-typed modules",
            "Test code with loose typing",
        ],
        anchors: {
            100: "Type annotations accurately document and enforce runtime invariants.",
            90: "Generally accurate with a few soft spots.",
            80: "Recurring missing annotations on public APIs, `any` escapes, or unnarrowed unions.",
            60: "Type annotations are unreliable or absent across core paths.",
        },
    },
    design_coherence: {
        id: "design_coherence",
        short_id: "design_coherence",
        name: "Design coherence",
        weight: 10.0,
        reset_on_scan: true,
        description:
            "Sound structural design decisions — focused functions, earned abstractions, and consistent sibling patterns (bridges mechanical concerns).",
        look_for: [
            "Functions doing too many things — multiple distinct responsibilities in one body",
            "Files accumulating issues across many dimensions — mixing unrelated concerns",
            "Deep nesting that could be flattened with early returns or extraction",
            "Repeated structural patterns that should be data-driven",
        ],
        skip: [
            "Functions that are long but have a single coherent responsibility",
            "Do NOT recommend config/context objects or DI wrappers just to reduce parameter count",
        ],
        anchors: {
            100: "Functions are focused, abstractions are earned, and structural patterns are consistent.",
            90: "Mostly focused with minor multi-responsibility functions.",
            80: "Recurring multi-responsibility functions or repeated patterns that should be data-driven.",
            60: "Design decisions routinely obscure intent and mix unrelated concerns.",
        },
    },
    abstraction_fitness: {
        id: "abstraction_fitness",
        short_id: "abstraction_fit",
        name: "Abstraction fit",
        weight: 8.0,
        reset_on_scan: true,
        description:
            "Abstractions that pay for themselves with real leverage (no pass-through wrappers, 1-caller indirection, or wide option bags).",
        look_for: [
            "Pass-through wrappers or interfaces that add no behavior, policy, or translation",
            "Cross-cutting wrapper chains where call depth increases without added value",
            "Interface/protocol families with only one concrete implementation",
            "Wide options/context bag APIs that hide true domain boundaries",
            "Delegation-heavy classes where most methods forward to an inner object",
            "Facade/re-export modules that define no logic of their own",
        ],
        skip: [
            "Adapters that intentionally isolate external API volatility",
            "Thin wrappers that consistently enforce auth, logging, metrics, or caching policy",
        ],
        anchors: {
            100: "Abstractions clearly reduce complexity; every layer of indirection earns its keep.",
            90: "Generally strong with a few layers that feel slightly overbuilt.",
            80: "Regularly navigates indirection that does not pay for itself (wrappers, facades, option bags).",
            60: "Abstraction cost routinely outweighs value.",
        },
    },
    logic_clarity: {
        id: "logic_clarity",
        short_id: "logic_clarity",
        name: "Logic clarity",
        weight: 6.0,
        reset_on_scan: true,
        description:
            "Control flow and boolean logic that provably does what it claims without dead branches or redundant checks.",
        look_for: [
            "Identical if/else or ternary branches",
            "Dead code paths after unconditional return/throw/error/break",
            "Always-true or always-false conditions",
            "Redundant nil/null/undefined checks on values guaranteed non-null",
            "Boolean expressions that simplify directly",
        ],
        skip: [
            "Deliberate no-op branches with explanatory comments",
            "Guard clauses at external untrusted boundaries",
        ],
        anchors: {
            100: "Control flow is direct and necessary; logic traces without surprises.",
            90: "Mostly clear with isolated simplification opportunities.",
            80: "Redundant branches, dead paths, or avoidable boolean complexity.",
            60: "Control flow is frequently opaque or misleading.",
        },
    },
    package_organization: {
        id: "package_organization",
        short_id: "structure_nav",
        name: "Structure nav",
        weight: 5.0,
        reset_on_scan: true,
        description:
            "Directory layout quality and navigability: placement matches ownership, import affinity, and change boundaries.",
        look_for: [
            "Straggler root files with low fan-in (<5 importers) that belong under a focused package",
            "Import-affinity mismatch: file imports/importers are >60% in one sibling domain, but file lives outside it",
            "Flat directory overload: >10-25 files mixing unrelated concerns without subfolder grouping",
            "Ambiguous folder naming that does not reflect contained responsibilities",
        ],
        skip: [
            "Root-level files that are genuinely core (high fan-in >= 5 importers, entrypoints)",
            "Small projects (<20 files) where flat structure is appropriate",
        ],
        anchors: {
            100: "Engineers can predict where to find and put files from directory structure alone.",
            90: "Mostly coherent with minor placement outliers.",
            80: "Files living outside their import-affinity domain or overloaded flat directories.",
            60: "Organization obscures ownership; engineers must search rather than navigate.",
        },
    },
    error_consistency: {
        id: "error_consistency",
        short_id: "error_consistency",
        name: "Error consistency",
        weight: 3.0,
        reset_on_scan: true,
        description:
            "Consistent error strategies, preserved failure context, and absence of silent catch/pcall swallowing.",
        look_for: [
            "Mixed error strategies within the same layer (throw vs return null vs Result/pcall tuple)",
            "Error context lost at boundaries (catch-and-rethrow without original context)",
            "Silent error swallowing: catch/pcall blocks that ignore failure without recovery",
            "Missing error handling on I/O, network, DataStore, or parse boundaries",
        ],
        skip: [
            "Intentional top-level error boundaries",
            "Different strategies across distinct architectural layers (e.g. Result in core, throw in CLI)",
        ],
        anchors: {
            100: "Error propagation and handling are predictable across the codebase.",
            90: "Mostly coherent with occasional minor inconsistencies.",
            80: "Mixed error strategies across sibling functions or swallowed boundary errors.",
            60: "Error behavior is unpredictable and failures are silently lost.",
        },
    },
    naming_quality: {
        id: "naming_quality",
        short_id: "naming_quality",
        name: "Naming quality",
        weight: 2.0,
        reset_on_scan: true,
        description:
            "Function, variable, and file names that communicate domain intent and match behavior.",
        look_for: [
            "Generic verbs that reveal nothing: process, handle, do, run, manage, data, info",
            "Name/behavior mismatch: getX() that mutates state, isX() returning non-boolean",
            "Vocabulary divergence from codebase norms",
        ],
        skip: [
            "Standard framework lifecycle names (render, mount, init, Destroy)",
            "Short-lived loop variables (i, j, k, v)",
        ],
        anchors: {
            100: "Names accurately predict behavior without reading implementations.",
            90: "Names are mostly precise with a few generic identifiers.",
            80: "Recurring generic verbs, vocabulary drift, or name/behavior mismatches.",
            60: "Names are routinely ambiguous or misleading.",
        },
    },
    ai_generated_debt: {
        id: "ai_generated_debt",
        short_id: "ai_generated_debt",
        name: "AI generated debt",
        weight: 1.0,
        reset_on_scan: true,
        description:
            "LLM-hallmark patterns: restating comments, narration banners, defensive overengineering, and copy-pasted boilerplate.",
        look_for: [
            "Restating comments that echo code without adding WHY insight",
            "Noisy debug logging or narration banners (`// --- Step 1 ---`)",
            "Defensive overengineering: null checks on non-nullable values, try/pcall around pure expressions",
            "Docstring bloat on trivial 2-line helpers",
            "Identical boilerplate error handling copied verbatim across files",
        ],
        skip: [
            "Comments explaining WHY (business rules, non-obvious constraints, hardware/engine quirks)",
            "Defensive checks at genuine external/remote boundaries",
        ],
        anchors: {
            100: "Code is purpose-driven with zero ceremony or narration noise.",
            90: "Mostly clean with small pockets of boilerplate.",
            80: "Recurring defensive overengineering, restating comments, or formulaic boilerplate.",
            60: "Generated-style noise is pervasive.",
        },
    },
    cross_module_architecture: {
        id: "cross_module_architecture",
        short_id: "cross_module_architecture",
        name: "Cross-module arch",
        weight: 4.0,
        reset_on_scan: false,
        description:
            "Dependency direction, acyclic module layering, hub blast radius, and boundary integrity.",
        look_for: [
            "Layer/dependency direction violations repeated across modules (e.g. Client importing Server, leaf importing orchestrator)",
            "Cycles or mega-hub modules that create large blast radius for common changes",
            "Cross-module coordination through shared mutable state or import-time side effects",
            "Cross-package duplication that indicates a missing shared boundary",
        ],
        skip: [
            "Intentional public entrypoints/facades",
            "Local readability issues inside a single function (use low_level_elegance)",
        ],
        anchors: {
            100: "Dependency direction and module boundaries are acyclic, layered, and intentional.",
            90: "Mostly coherent with isolated boundary drift.",
            80: "Recurring boundary violations, coupling hotspots, or cycles.",
            60: "Structural boundary debt is widespread; changes ripple unpredictably.",
        },
    },
    initialization_coupling: {
        id: "initialization_coupling",
        short_id: "initialization_coupling",
        name: "Init coupling",
        weight: 3.0,
        reset_on_scan: false,
        description:
            "Boot-order dependencies, import/require-time side effects, and fragile mutable global singletons.",
        look_for: [
            "Module-level code that depends on another module having been imported/initialized first",
            "Import-time side effects: I/O, network calls, Instance creation, or event connections at module scope",
            "Global singletons where creation order matters across modules",
            "Circular init dependencies hidden behind lazy/dynamic requires",
        ],
        skip: [
            "Pure constant/type table declarations at module scope",
            "Top-level entrypoint bootstrap scripts (`cli.js`, `*.server.luau`, `*.client.luau`)",
        ],
        anchors: {
            100: "Any module can be required/imported without boot-order dependencies or side effects.",
            90: "Mostly stable with limited boot-order sensitivity.",
            80: "Import-time side effects or singletons with implicit initialization order.",
            60: "Boot behavior is fragile and order-dependent.",
        },
    },
    convention_outlier: {
        id: "convention_outlier",
        short_id: "convention_outlier",
        name: "Convention drift",
        weight: 3.0,
        reset_on_scan: false,
        description:
            "Naming convention drift, inconsistent file organization, and style islands across sibling modules.",
        look_for: [
            "Naming convention drift: snake_case vs camelCase/PascalCase across sibling files or functions",
            "Mixed export patterns across sibling modules",
            "Style islands where one directory uses a completely different pattern than the rest of the repo",
            "Sibling modules following different lifecycle/behavioral protocols",
        ],
        skip: [
            "Intentional variation for different module types (config vs logic)",
            "Do NOT recommend adding barrel/index files just to standardize",
        ],
        anchors: {
            100: "A pattern seen in one module holds consistently across the codebase.",
            90: "Mostly consistent with minor style islands.",
            80: "Noticeable convention drift across sibling modules or directories.",
            60: "Conventions are fragmented per directory.",
        },
    },
    dependency_health: {
        id: "dependency_health",
        short_id: "dependency_health",
        name: "Dep health",
        weight: 3.0,
        reset_on_scan: false,
        description:
            "Cohesive, minimal external dependencies without duplicate libraries for the same purpose or heavy unused packages.",
        look_for: [
            "Multiple libraries for the same purpose",
            "Heavy dependencies pulled in for trivial 1-function use",
            "Unused dependencies in manifest files (package.json, wally.toml, pyproject.toml, Cargo.toml)",
        ],
        skip: [
            "Dev/test dependencies",
            "Peer dependencies required by the host engine/framework",
        ],
        anchors: {
            100: "Dependency set is minimal, cohesive, and purposeful.",
            90: "Mostly healthy with minor overlap.",
            80: "Duplicate libraries for the same purpose or heavy dependencies for light use.",
            60: "Dependency bloat or conflicts hinder maintenance.",
        },
    },
    test_strategy: {
        id: "test_strategy",
        short_id: "test_strategy",
        name: "Test strategy",
        weight: 4.0,
        reset_on_scan: false,
        description:
            "High-signal behavioral test coverage on critical hubs, invariants, and edge cases without brittle implementation coupling.",
        look_for: [
            "Critical paths and high-fan-in hub modules with zero test coverage",
            "Hollow or smoke-only tests that execute code without asserting invariants",
            "Brittle tests coupled to private implementation details or wall-clock sleep timers",
            "Missing cross-module integration or property/edge-case tests on parsers/codecs/state machines",
        ],
        skip: [
            "Low-value declarative files intentionally untested (types, constants, barrel files)",
        ],
        anchors: {
            100: "Test suite validates critical contracts and edge cases with high confidence.",
            90: "Generally strong coverage with small strategic gaps.",
            80: "Core hub modules lack direct tests or tests are brittle/shallow.",
            60: "Meaningful production risk goes unvalidated.",
        },
    },
    api_surface_coherence: {
        id: "api_surface_coherence",
        short_id: "api_surface_coherence",
        name: "API coherence",
        weight: 4.0,
        reset_on_scan: false,
        description:
            "Consistent public API shapes, predictable parameter ordering, and clear sync/async contracts.",
        look_for: [
            "Inconsistent API shapes: sibling functions with different parameter ordering or return conventions",
            "Mixed sync/async or yielding/non-yielding functions in the same module's public surface without clear naming",
            "Overloaded functions doing unrelated things based on argument types",
            "Public functions with >5 positional parameters",
        ],
        skip: [
            "Internal private helpers where flexibility is acceptable",
        ],
        anchors: {
            100: "Public API shape and behavior are predictable from seeing a single example.",
            90: "Mostly coherent with minor parameter ordering differences.",
            80: "Recurring API irregularities, overloaded signatures, or mixed sync/async conventions.",
            60: "Public APIs are inconsistent and require reading each implementation.",
        },
    },
    authorization_consistency: {
        id: "authorization_consistency",
        short_id: "authorization_consistency",
        name: "Auth consistency",
        weight: 4.0,
        reset_on_scan: false,
        description:
            "Uniform trust-boundary validation, permission checks, and rate/cooldown guards across all external entrypoints and remotes.",
        look_for: [
            "Server route/remote handlers (`OnServerEvent`, `OnServerInvoke`, HTTP/RPC endpoints) missing runtime type/schema validation on client inputs",
            "Sibling endpoints where some enforce auth/permission/ownership checks and others forget",
            "Client-authoritative trust bugs (trusting client-supplied cost, damage, currency, CFrame, or user IDs)",
            "Permission strings or role checks scattered as magic literals instead of shared guards",
        ],
        skip: [
            "Public read-only endpoints explicitly documented as unauthenticated",
            "Pure offline CLI/library code with no network, RPC, or privilege boundary",
        ],
        anchors: {
            100: "Trust boundaries and input/permission checks are uniformly enforced across all entrypoints.",
            90: "Mostly consistent with documented exceptions.",
            80: "Sibling handlers/remotes have inconsistent input validation or auth checks.",
            60: "Trust boundary posture is inconsistent or trusts unvalidated client payloads.",
        },
    },
    incomplete_migration: {
        id: "incomplete_migration",
        short_id: "incomplete_migration",
        name: "Stale migration",
        weight: 3.0,
        reset_on_scan: false,
        description:
            "Absence of half-migrated dual patterns, deprecated-but-called symbols, and obsolete compatibility shims.",
        look_for: [
            "Old and new API patterns coexisting indefinitely (e.g., legacy `wait`/`spawn` alongside `task.*`, dual state stores)",
            "Deprecated symbols still called by active production code",
            "Compatibility shims that no external caller needs anymore",
            "Stale TODO/FIXME comments referencing 'migrate', 'legacy', or 'remove after'",
        ],
        skip: [
            "Documented backward-compatibility shims for published external SDKs",
        ],
        anchors: {
            100: "Migrations are complete; one canonical pattern is used everywhere.",
            90: "Mostly complete with minor bounded legacy residue.",
            80: "Old and new patterns coexist across modules, creating ambiguity.",
            60: "Migration drift and dual-path confusion are pervasive.",
        },
    },
};

/**
 * 5 Thematic Review Batches covering all 20 dimensions.
 */
export const DIMENSION_BATCHES = [
    {
        batch: 1,
        theme: "Architecture, Layering & Module Seams",
        dimensions: [
            "high_level_elegance",
            "mid_level_elegance",
            "cross_module_architecture",
            "initialization_coupling",
        ],
    },
    {
        batch: 2,
        theme: "Contracts, Type Safety, Errors & Trust Boundaries",
        dimensions: [
            "contract_coherence",
            "type_safety",
            "error_consistency",
            "authorization_consistency",
        ],
    },
    {
        batch: 3,
        theme: "Design Coherence, Abstractions & Internals",
        dimensions: [
            "design_coherence",
            "low_level_elegance",
            "abstraction_fitness",
            "logic_clarity",
        ],
    },
    {
        batch: 4,
        theme: "API Surface, Conventions, Structure & Migrations",
        dimensions: [
            "api_surface_coherence",
            "package_organization",
            "convention_outlier",
            "incomplete_migration",
        ],
    },
    {
        batch: 5,
        theme: "Test Strategy, Dependencies, Naming & AI Debt",
        dimensions: [
            "test_strategy",
            "dependency_health",
            "naming_quality",
            "ai_generated_debt",
        ],
    },
];

/**
 * Language-specific review overrides (`luau`, `typescript`, `python`, `rust`, `go`).
 */
export const LANGUAGE_REVIEW_OVERRIDES = {
    luau: {
        system_prompt_append:
            "Luau / Roblox review anchors: enforce `--!strict` typing without `:: any` escapes; verify every `RemoteEvent.OnServerEvent` and `RemoteFunction.OnServerInvoke` validates client argument `typeof(...)`, `math.isnan` (`x == x`), ownership, and cooldowns on the server; check that `RBXScriptConnection` handles and Flux reactive scopes (`Flux.scope`) are cleaned up on teardown/Destroy; prefer `task.wait`/`task.spawn`/`task.delay` over legacy globals; hoist `game:GetService(...)` to module top; never pass the 2nd parent argument to `Instance.new(class, parent)`.",
        dimension_prompts: {
            authorization_consistency: {
                look_for_append: [
                    "Roblox `OnServerEvent` / `OnServerInvoke` callbacks trusting client-supplied damage, currency, CFrame, or asset IDs without `typeof()` + NaN (`x == x`) + server-authoritative state checks",
                    "Client modules (`*.client.luau` / `StarterPlayerScripts`) requiring `ServerStorage` or `ServerScriptService` modules",
                ],
            },
            contract_coherence: {
                look_for_append: [
                    "Event connections (`:Connect(...)`), threads (`task.spawn`/`task.delay`), or Flux scopes created in component/class lifecycle methods without a matching `:Disconnect()` / `scope:destroy()` on teardown",
                    "Yielding functions (`task.wait`, `:WaitForChild`, `DataStore:GetAsync`) called inside non-yielding contracts or Flux computed/effect blocks without `Flux.async`",
                ],
            },
            type_safety: {
                look_for_append: [
                    "Luau modules missing `--!strict` header or using `:: any` to silence type mismatches",
                    "Using raw string literals instead of `Enum.<EnumType>.<Item>`",
                ],
            },
        },
    },
    typescript: {
        system_prompt_append:
            "TypeScript review anchors: watch for prop-drilling pass-through wrappers, single-implementation interfaces, wide option bags passed across layers, `as any` / `@ts-ignore` escapes, and floating promises.",
    },
    python: {
        system_prompt_append:
            "Python review anchors: watch for pass-through `*args`/`**kwargs` wrappers, single-implementation `Protocol` classes, implicit `dict[str, Any]` parameter bags instead of `TypedDict`/`dataclass`, and bare `except Exception:` blocks.",
    },
    rust: {
        system_prompt_append:
            "Rust review anchors: watch for `.unwrap()` / `.expect()` in fallible library paths, unnecessary `.clone()` allocations on hot paths, `unsafe` blocks without `// SAFETY:` invariants, and overly broad `pub` visibility.",
    },
    go: {
        system_prompt_append:
            "Go review anchors: watch for ignored `err` returns (`_ = ...`), unbuffered channel goroutine leaks without `context.Context` cancellation, and premature single-implementation interfaces.",
    },
};

/**
 * Build the Two-Phase (`PHASE 1 — OBSERVE` -> `PHASE 2 — JUDGE`) system prompt for blind reviews.
 */
export function buildReviewSystemPrompt(detectedLangs = []) {
    const base = [
        "You are a senior adversarial code quality reviewer. Evaluate the codebase across the requested subjective dimensions using `plexer` and file tools.",
        "",
        "SCORING PHILOSOPHY & INDEPENDENCE:",
        "- Score each dimension 0-100 (one decimal place) from direct code evidence only.",
        "- Treat `holistic_context` and `concerns` in `review_packet_blind.json` as navigation aids (starting points to inspect), NOT pre-confirmed defects.",
        "- Do NOT anchor to 95, 98, or 100. When evidence is mixed, score conservatively.",
        "",
        "TWO-PHASE REVIEW PROCESS:",
        "1. PHASE 1 — OBSERVE (before assigning any score):",
        "   - Read each dimension's `description`, `look_for`, `skip`, and `anchors`.",
        "   - Inspect `seed_files`, `concerns`, and cross-module callers (`plexer callers`, `plexer read`).",
        "   - Record codebase characteristics in `context_updates[dimension].add` (`{ header, description, positive: true|false, settled: true }`).",
        "   - Record concrete defects in `findings[]` (every finding MUST be an actionable defect with `related_files`, `evidence` with line numbers, and `suggestion` — never put positive observations in `findings[]`).",
        "2. PHASE 2 — JUDGE:",
        "   - For each dimension, write `dimension_judgment[dimension]`: `{ dimension_character: '2-3 sentences', score_rationale: '2-3 sentences weighing evidence against anchors', strengths: ['...'] }`.",
        "   - Assign `assessments[dimension]` (0-100) LAST so it matches `score_rationale`.",
        "",
        "IMPORT GUARD RULES:",
        "- Every finding must reduce net complexity (Simplicity Principle: prefer direct over indirect, inline over 1-caller wrappers).",
        "- Any dimension scored < 85 MUST include at least one concrete defect in `findings[]` for that dimension (or explicit rationale in `dimension_judgment`).",
    ];

    for (const lang of detectedLangs) {
        const key = String(lang).toLowerCase();
        const normKey = key === "lua" || key === "roblox" ? "luau" : key === "javascript" ? "typescript" : key;
        const override = LANGUAGE_REVIEW_OVERRIDES[normKey];
        if (override?.system_prompt_append) {
            base.push("", override.system_prompt_append);
        }
    }

    return base.join("\n");
}

/**
 * Build the enriched prompt dictionary for all 20 dimensions with language overrides applied.
 */
export function buildDimensionPromptsForLangs(detectedLangs = [], seedFiles = []) {
    const normLangs = new Set(
        detectedLangs.map((l) => {
            const k = String(l).toLowerCase();
            if (k === "lua" || k === "roblox") return "luau";
            if (k === "javascript") return "typescript";
            return k;
        }),
    );

    const out = {};
    for (const [id, def] of Object.entries(SUBJECTIVE_DIMENSIONS)) {
        const lookFor = [...(def.look_for || [])];
        const skip = [...(def.skip || [])];
        for (const lang of normLangs) {
            const ov = LANGUAGE_REVIEW_OVERRIDES[lang]?.dimension_prompts?.[id];
            if (ov?.look_for_append) lookFor.push(...ov.look_for_append);
            if (ov?.skip_append) skip.push(...ov.skip_append);
        }
        out[id] = {
            id,
            short_id: def.short_id,
            name: def.name,
            weight: def.weight,
            description: def.description,
            look_for: lookFor,
            skip,
            anchors: def.anchors,
            seed_files: seedFiles.slice(0, 10),
        };
    }
    return out;
}
