import { createHash } from "node:crypto";
/** Stable content hash (sha256, hex) used for document dedup. */
export function contentHash(input) {
    return createHash("sha256").update(input).digest("hex");
}

