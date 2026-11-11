/**
 * Stable identifier minting, ordinal stripping, content hashing, and search-body slicing.
 */
import { createHash } from "node:crypto";
import { spanRange } from "./span.js";

/** Stable content hash (sha256, hex) used for document dedup. */
export function contentHash(input) {
    return createHash("sha256").update(input).digest("hex");
}

/** Mint-time uniqueness: collision-proof `~2`, `~3`, ... suffixing. */
export function mintId(base, minted) {
    let id = base;
    let k = 2;
    while (minted.has(id))
        id = `${base}~${k++}`;
    minted.add(id);
    return id;
}

/** Strips mint-time disambiguation ordinals (`~2`, `~3`, ...) from segment ends in a dotted id-tail. */
export function stripOrdinals(idTail) {
    return idTail.replace(/~\d+(?=\.|$)/g, "");
}

/** Lowercase `n.id` with mint-time disambiguation ordinals stripped from the symbol tail. */
export function stripNodeOrdinals(n) {
    if (n._strippedId !== undefined)
        return n._strippedId;
    const lowerId = n.id.toLowerCase();
    const hashIdx = lowerId.indexOf("#");
    const stripped = hashIdx === -1 ? lowerId : lowerId.slice(0, hashIdx + 1) + stripOrdinals(lowerId.slice(hashIdx + 1));
    Object.defineProperty(n, "_strippedId", { value: stripped, enumerable: false, configurable: true, writable: true });
    return stripped;
}

const MAX_BODY_CHARS = 5000;
const MAX_FILE_BODY_CHARS = 16000;

export function searchBody(text, max = MAX_BODY_CHARS) {
    const norm = text.replace(/\s+/g, " ").trim();
    return norm.length > max ? norm.slice(0, max) : norm;
}

export function fileResidual(source, symbols) {
    const lines = source.split("\n");
    const covered = new Uint8Array(lines.length + 2);
    for (const s of symbols) {
        const range = spanRange(s.span);
        if (!range)
            continue;
        for (let r = range.start; r <= range.end && r < covered.length; r++)
            covered[r] = 1;
    }
    const kept = [];
    for (let i = 0; i < lines.length; i++)
        if (!covered[i + 1])
            kept.push(lines[i]);
    return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}
