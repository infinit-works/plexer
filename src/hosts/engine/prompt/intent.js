export const MIN_PROMPT_CHARS = 12;

export const LEADING_SLASH_COMMANDS_RE = /^(?:\/(?!tmp\b|app\b|var\b|opt\b|etc\b|usr\b|bin\b|home\b|root\b|srv\b|mnt\b|private\b|Users\b)[a-z][a-z0-9_-]*(?=\s|$)\s*)+/i;
export const PLAN_SLASH_RE = /^(?:\/[a-z][a-z0-9_-]*\s+)*\/(?:plan|grill-me)\b/i;
export const READ_ONLY_SLASH_RE = /^(?:\/[a-z][a-z0-9_-]*\s+)*\/(?:plan|grill-me|review)\b/i;

export function stripLeadingSlashCommands(text) {
    return String(text ?? '').trim().replace(LEADING_SLASH_COMMANDS_RE, '').trim();
}

const CODE_SIGNAL_RE = /`[^`\n]+`|[A-Za-z0-9_/-]+\.(?:py|go|js|ts|tsx|jsx|mjs|cjs|luau|lua|rs|c|cc|cpp|h|hpp|java|rb|php|cs|swift|kt|scala|sh|json|toml|yaml|yml|md)\b|[a-z][A-Z]|[A-Za-z0-9]+_[A-Za-z0-9]+/;
const META_OPERATIONAL_RE = /^(?:(?:tested|done|ok|okay|yes|yep|sure|thanks|thank\s+you|great|nice|awesome|perfect|please|now|good|lgtm|can\s+you|could\s+you|would\s+you|let'?s)[,.\s]+)*(?:commit|push|deploy|stage|merge|ship|run\s+(?:(?:all\s+)?(?:the\s+)?)?(?:unit\s+|integration\s+)?tests?(?:\s+suite)?|go\s+ahead|proceed|looks\s+good|continue)\b/i;
const META_PROJECT_STATUS_RE = /^(?:what(?:'s|\s+is|\s+are)\s+(?:the\s+)?(?:current\s+)?(?:status|progress|state)\s+(?:of|on)\s+(?:the|this|our)\s+(?:project|repo|repository|task|work|plan|sprint)\b|where\s+are\s+we\s+(?:on|with|at)\s+(?:this|the|our)\s+(?:task|project|work|plan|feature|pr|branch)\b|how\s+is\s+(?:the|this|our)\s+(?:project|task|work)\s+(?:going|progressing|coming\s+along)\b)/i;
const META_PHILOSOPHY_RE = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:explain|describe|summarize|tell\s+me(?:\s+about)?|walk\s+me\s+through|what\s+is)\s+(?:the\s+)?(?:high[- ]level\s+|overall\s+|core\s+|general\s+)?(?:philosophy|vision|motivation|purpose|goals?|rationale|design\s+philosophy|guiding\s+principles?)\s+(?:behind|of|for)\s+(?:this|the|our)\s+(?:project|repo|repository|tool|library|system)\b/i;
const META_EVALUATION_RE = /\b(?:why\s+is\s+[a-z0-9_-]+\s+performing\b|performing\s+(?:worse|better|poorly)|tokens?\s+(?:usage\s+)?saved|wall[- ]?time\s+saved|high[- ]leverage\s+changes|benchmark(?:s|ing)?\s+(?:regress(?:ion|ed)?|suite|numbers)|(?:improve|optimi[sz]e)\s+(?:the\s+)?performance\s+of\b[\s\S]{0,60}\bmodels?\b|best\s+token\s+usage\s+and\s+time\s+reduction)\b/i;
const SYNTHETIC_PREFIX_RE = /^(?:<task-notification>|<system-reminder>|<local-command-|<SYSTEM_MESSAGE>\b|The following is a <SYSTEM_MESSAGE>|\[plan review(?:\s+due)?\]|Another Claude session sent a message:|\[Request interrupted by user\]$)/i;
const EDIT_VERB_RE = /\b(implement|add|extend|replace|update|rewrite|centralize|expose|forward|support)\b/i;

/** True when a prompt is a synthetic harness notification, interrupt, or meta-only prompt. */
export function isSyntheticOrMetaPrompt(raw) {
    const t = String(raw ?? '').trim();
    if (!t || SYNTHETIC_PREFIX_RE.test(t) || /<agent-message\b/i.test(t)) return true;
    const unwrapped = t.replace(/^[\s\S]*?<SYSTEM_MESSAGE>\s*/i, '');
    if (unwrapped !== t && /^\[plan review(?:\s+due)?\]/i.test(unwrapped.trim())) return true;
    const stripped = stripLeadingSlashCommands(t);
    if (stripped.length < MIN_PROMPT_CHARS) return true;
    if (CODE_SIGNAL_RE.test(stripped)) return false;
    return META_OPERATIONAL_RE.test(stripped) || META_PROJECT_STATUS_RE.test(stripped)
        || META_PHILOSOPHY_RE.test(stripped) || META_EVALUATION_RE.test(stripped);
}

export function cleanPromptBoilerplate(raw) {
    const body = stripLeadingSlashCommands(String(raw ?? ''))
        .replace(/^Working directory:.*$/gm, '')
        .replace(/^A code repository is available in.*$/gm, '')
        .replace(/^Your task is to implement the changes.*$/gm, '')
        .replace(/^<\/?pr_description>\s*$/gim, '')
        .replace(/\nConstraints:\s*\n[\s\S]*$/im, '')
        .replace(/^Run `.*$/gm, '')
        .replace(/to verify all.*$/gm, '')
        .replace(/Important:[\s\S]*$/gm, '')
        .replace(/`(?:file:)?Lx-Ly`/gi, '')
        .replace(/\blow-level\b/gi, '')
        .replace(/\b0[\s-]byte\b/gi, 'zero_size')
        .replace(/\/tmp\/[A-Za-z0-9._-]+\/(?:(?:clean|indexed)\/)?[A-Za-z0-9._-]+\/(?=[A-Za-z0-9_])/g, '')
        .replace(/`\/(?:tmp|app|workspace|home)\/[A-Za-z0-9._/-]*`/g, '')
        .replace(/\/app\/(?=[A-Za-z0-9_])/g, '');
    return stripLeadingSlashCommands(body);
}

function hasActionableEditIntent(raw, optsOrForce = false) {
    const forceReadOnly = typeof optsOrForce === 'boolean' ? optsOrForce : Boolean(optsOrForce?.forceReadOnly);
    const planMode = typeof optsOrForce === 'object' && Boolean(optsOrForce?.planMode);
    if (forceReadOnly || (!planMode && READ_ONLY_SLASH_RE.test(raw.trim())) || /\bAnswer concisely with exact\b/i.test(raw)) return false;
    const cleaned = stripLeadingSlashCommands(raw)
        .replace(/\b(?:do\s+not|don't|dont|never|without|not\s+to)\s+(?:[a-z]+\s+){0,2}(?:implement|add|extend|replace|update|rewrite|centralize|expose|forward|support)\b/gi, '')
        .trim();
    if (!EDIT_VERB_RE.test(cleaned)) return false;
    const isInterrogative = /^(?:how|why|what|where|when|which|who|is|are|does|do|can\s+you\s+(?:explain|tell|show|walk))\b/i.test(cleaned);
    if (!isInterrogative && !cleaned.endsWith('?')) return true;
    if (isInterrogative && cleaned.endsWith('?') && !CODE_SIGNAL_RE.test(cleaned)) return false;
    const clauses = cleaned
        .split(/[?;\n]+|,\s*(?=(?:and|or|but|so|if|before|after|then|without|instead)\b)|\b(?:and\s+(?:how|whether|should|could|would|can|might|what)|so\s+(?:we|i|you)\s+(?:can|could)|if\s+(?:we|i|you)\b)/i)
        .map((c) => c.trim()).filter(Boolean);
    if (isInterrogative && clauses.length >= 1 && !EDIT_VERB_RE.test(clauses[0])) {
        return clauses.slice(1).filter((c) => EDIT_VERB_RE.test(c))
            .some((c) => CODE_SIGNAL_RE.test(c) && !/^(?:and\s+|or\s+)?(?:how|whether|should|could|would|might|what\s+would)\b/i.test(c));
    }
    return !(/^(?:how\s+(?:does|do|is|are|did|can\s+we|could\s+we|should\s+we|would\s+we)|does\b|do\b|is\b|are\b|why\b|what\b|where\b|who\b|which\b)/i.test(cleaned) && cleaned.endsWith('?'));
}

export function detectPromptIntent(prompt, opts = {}) {
    const raw = String(prompt ?? '');
    const editEnvelope = hasActionableEditIntent(raw, {
        forceReadOnly: Boolean(opts.forceReadOnly),
        planMode: Boolean(opts.planMode),
    });
    const wantsCallSites = !editEnvelope && /\b(callers?|who\s+calls|direct\s+callers|second-hop\s+callers?|blast\s+radius|who\s+uses|used\s+by|where\s+is\b[\s\S]{0,40}\b(?:called|used|invoked)|which\s+(?:functions|modules|cli\s+commands|handlers)\b[\s\S]{0,60}\b(?:call|invoke))\b/i.test(raw);
    return { wantsCallSites, editEnvelope };
}

/** True when a session prompt represents an actionable fix/PR task (for exploration guarding). */
export function isLikelyEditSessionPrompt(prompt, opts = {}) {
    const raw = String(prompt ?? '').trim();
    if (!raw || opts?.forceReadOnly || (!opts?.planMode && READ_ONLY_SLASH_RE.test(raw)) || /\bAnswer concisely with exact\b/i.test(raw)) {
        return false;
    }
    if (detectPromptIntent(raw, opts).editEnvelope) return true;
    const cleaned = stripLeadingSlashCommands(raw)
        .replace(/^Working directory:[^\n]*\n*/i, '')
        .trim();
    if (!cleaned || cleaned.endsWith('?')) return false;
    if (/^(?:how|why|what|where|when|which|who|is|are|does|do|can\s+you\s+(?:explain|tell|show|walk)|diagnose|explain|describe|trace|list|summarize|audit|review)\b/i.test(cleaned)) {
        return false;
    }
    if (/<pr_description>/i.test(raw)) return true;
    if (/^Working directory:/i.test(raw) && cleaned.length >= 120 && /\n/.test(cleaned)) return true;
    return /\b(?:fix|resolve|patch|repair|prevent|handle)\b/i.test(cleaned) && CODE_SIGNAL_RE.test(cleaned);
}
