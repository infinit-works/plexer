/**
 * Batched read-only CLI query runner (`plexer _batch`) with a shared ~9 KB
 * water-fill stdout cap so chained agent shell calls never spill to disk.
 */

export const BATCH_MAX_BYTES = 9000;
export const BATCHABLE_SUBCOMMANDS = new Set([
    'read',
    'ask',
    'callers',
    'callees',
    'impact',
    'skeleton',
    'grep',
    'map',
    'blast',
]);

/**
 * Quote-preserving shell-like tokenization for batched CLI arguments.
 * Preserves spaces inside '...' and "..." as well as backslash escapes outside single quotes.
 */
function tokenizeBatchSegment(segment) {
    const src = String(segment ?? '');
    const tokens = [];
    let current = '';
    let inToken = false;
    let quote = null;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            else
                current += ch;
            inToken = true;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') {
                quote = null;
            }
            else if (ch === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) {
                i += 1;
                current += src[i];
            }
            else {
                current += ch;
            }
            inToken = true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inToken = true;
            continue;
        }
        if (ch === '\\' && i + 1 < src.length) {
            i += 1;
            current += src[i];
            inToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (inToken) {
                tokens.push(current);
                current = '';
                inToken = false;
            }
            continue;
        }
        current += ch;
        inToken = true;
    }
    if (inToken)
        tokens.push(current);
    return tokens;
}

function splitBatchSegments(joined) {
    const segments = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < joined.length; i++) {
        const ch = joined[i];
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            cur += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '\\' && i + 1 < joined.length) {
                cur += ch + joined[i + 1];
                i += 1;
                continue;
            }
            if (ch === '"')
                quote = null;
            cur += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === '\\' && i + 1 < joined.length) {
            cur += ch + joined[i + 1];
            i += 1;
            continue;
        }
        if (ch === ';' && joined[i + 1] === ';') {
            segments.push(cur);
            cur = '';
            i += 1;
            continue;
        }
        cur += ch;
    }
    if (cur.trim())
        segments.push(cur);
    return segments;
}

function normalizeDecodedList(parsed) {
    return parsed
        .map((item) => (Array.isArray(item) ? item.map(String) : tokenizeBatchSegment(item)))
        .filter((argv) => argv.length > 0 && BATCHABLE_SUBCOMMANDS.has(argv[0]));
}

export function decodeBatchPayload(rawArgs) {
    const joined = Array.isArray(rawArgs) ? rawArgs.join(' ').trim() : String(rawArgs ?? '').trim();
    if (!joined)
        return [];

    if (!joined.includes(' ')) {
        try {
            const decoded = Buffer.from(joined, 'base64url').toString('utf8');
            const parsed = JSON.parse(decoded);
            if (Array.isArray(parsed))
                return normalizeDecodedList(parsed);
        }
        catch { /* fall through to text parsing */ }
    }

    if (joined.startsWith('[')) {
        try {
            const parsed = JSON.parse(joined);
            if (Array.isArray(parsed))
                return normalizeDecodedList(parsed);
        }
        catch { /* ignore */ }
    }

    return splitBatchSegments(joined)
        .map((seg) => tokenizeBatchSegment(seg))
        .filter((argv) => argv.length > 0 && BATCHABLE_SUBCOMMANDS.has(argv[0]));
}

function trimBlockToBytes(block, maxBytes) {
    const trimmed = block.trimEnd();
    if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes)
        return trimmed;

    const lines = trimmed.split('\n');
    const kept = [];
    let bytes = 0;
    const footer = '  … [truncated in batch — re-run standalone with --full if needed]';
    const budget = Math.max(120, maxBytes - Buffer.byteLength(footer, 'utf8') - 8);
    let inFence = false;

    for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes + lineBytes > budget && kept.length >= 2)
            break;
        kept.push(line);
        bytes += lineBytes;
        if (line.trimStart().startsWith('```'))
            inFence = !inFence;
    }
    if (inFence)
        kept.push('```');
    kept.push(footer);
    return kept.join('\n');
}

/**
 * Water-fill pool an array of rendered stdout blocks under `maxBytes`.
 */
export function poolBatchOutputs(blocks, maxBytes = BATCH_MAX_BYTES) {
    const clean = blocks.map((b) => String(b ?? '').trim()).filter(Boolean);
    if (clean.length === 0)
        return '';

    const full = clean.join('\n\n') + '\n';
    if (Buffer.byteLength(full, 'utf8') <= maxBytes)
        return full;

    const sepBytes = 2 * Math.max(0, clean.length - 1) + 1;
    const available = Math.max(512, maxBytes - sepBytes);
    const lengths = clean.map((b) => Buffer.byteLength(b, 'utf8'));

    // Water-fill fair per-item cap so small queries keep 100% of their output while large ones share leftover budget.
    const sorted = [...lengths].sort((a, b) => a - b);
    let remaining = available;
    let waterCap = available;
    for (let i = 0; i < sorted.length; i++) {
        const leftCount = sorted.length - i;
        const share = Math.floor(remaining / leftCount);
        if (sorted[i] <= share) {
            remaining -= sorted[i];
        }
        else {
            waterCap = share;
            break;
        }
    }

    const pooled = clean.map((b, idx) => (lengths[idx] <= waterCap ? b : trimBlockToBytes(b, waterCap)));
    return pooled.join('\n\n') + '\n';
}
