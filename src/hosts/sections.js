/**
 * Marker-fenced section upsert. Plexer owns exactly the region between the
 * markers; everything else in the file belongs to the user and is preserved.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
export const PLEXER_START = '<!-- plexer:start -->';
export const PLEXER_END = '<!-- plexer:end -->';
export const PLEXER_MARKERS = { start: PLEXER_START, end: PLEXER_END };
export function hasSection(text) {
    return text.includes(PLEXER_START);
}
export function fencedBlock(body, eol = '\n') {
    // Normalize any pre-existing '\r' out of the body first so callers passing
    // a CRLF (or stray-CR) body never get doubled '\r' when eol is '\r\n'.
    const normalizedBody = body.replace(/\r/g, '');
    const block = `${PLEXER_START}\n${normalizedBody.replace(/\s+$/, '')}\n${PLEXER_END}`;
    return eol === '\n' ? block : block.replace(/\n/g, '\r\n');
}
/** The file's dominant line ending: CRLF if any '\r\n' is present, else LF. */
function detectEol(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
/** Index of a marker that sits alone on its own line, or -1. */
function markerLineIndex(lines, marker, from = 0) {
    for (let i = from; i < lines.length; i++) {
        if (lines[i].trim() === marker)
            return i;
    }
    return -1;
}
export function upsertSection(filePath, body) {
    if (!existsSync(filePath)) {
        const block = fencedBlock(body, '\n');
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `${block}\n`);
        return { action: 'created' };
    }
    const text = readFileSync(filePath, 'utf8');
    const eol = detectEol(text);
    const lines = text.split(/\r\n|\n/);
    const s = markerLineIndex(lines, PLEXER_START);
    const e = s === -1 ? -1 : markerLineIndex(lines, PLEXER_END, s + 1);
    if (s !== -1 && e !== -1) {
        const current = lines.slice(s, e + 1).join('\n');
        if (current === fencedBlock(body, '\n'))
            return { action: 'unchanged' };
        const block = fencedBlock(body, eol);
        const next = [...lines.slice(0, s), ...block.split(eol), ...lines.slice(e + 1)];
        writeFileSync(filePath, next.join(eol));
        return { action: 'replaced' };
    }
    if (s !== -1 && e === -1) {
        const block = fencedBlock(body, eol);
        const next = [...lines.slice(0, s), ...block.split(eol), ...lines.slice(s + 1)];
        writeFileSync(filePath, next.join(eol));
        return { action: 'replaced' };
    }
    const block = fencedBlock(body, eol);
    const doubleEol = eol + eol;
    const sep = text.endsWith(doubleEol) ? '' : text.endsWith(eol) ? eol : doubleEol;
    writeFileSync(filePath, `${text}${sep}${block}${eol}`);
    return { action: 'appended' };
}
