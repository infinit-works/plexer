/**
 * Architecture layer boundary rule parsing (`forbid: <from> -> <to>` and structured `layer_rules`).
 */
export function parsePolicyLayerRule(policyStr) {
    if (typeof policyStr !== "string")
        return null;
    const match = /^forbid\s*:\s*(\S+)\s*->\s*(\S+?)(?:\s*(?:\((.+)\)|—\s*(.+)|#\s*(.+)))?$/i.exec(
        policyStr.trim(),
    );
    if (!match)
        return null;
    return {
        from: match[1].trim(),
        to: match[2].trim(),
        allowTypeOnly: true,
        reason: (match[3] || match[4] || match[5] || policyStr.trim()).trim(),
    };
}

export function parseLayerRuleEntry(entry) {
    if (typeof entry === "string")
        return parsePolicyLayerRule(entry);
    if (!entry || typeof entry !== "object")
        return null;
    const rawFrom = entry.from ?? entry.source;
    const rawTo = entry.to ?? entry.target ?? entry.forbid ?? entry.disallow;
    const from = rawFrom ? String(rawFrom).trim() : "";
    const to = Array.isArray(rawTo)
        ? rawTo.map((t) => String(t ?? "").trim()).filter(Boolean)
        : rawTo
            ? String(rawTo).trim()
            : "";
    if (!from || (Array.isArray(to) ? to.length === 0 : !to))
        return null;
    const rawAllowTypeOnly = entry.allowTypeOnly ?? entry.allow_type_only;
    return {
        from,
        to,
        ...(rawAllowTypeOnly !== undefined ? { allowTypeOnly: Boolean(rawAllowTypeOnly) } : {}),
        reason: entry.reason ?? entry.message ?? null,
    };
}
