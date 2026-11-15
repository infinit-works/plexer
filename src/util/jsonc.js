/**
 * Lightweight single-pass JSONC (// comments, /* block comments * /, trailing commas) parser.
 */

function stripTrailingCommaBeforeClose(out) {
    for (let k = out.length - 1; k >= 0; k--) {
        const prev = out[k];
        if (prev === " " || prev === "\t" || prev === "\r" || prev === "\n" || prev === "")
            continue;
        if (prev === ",")
            out[k] = "";
        break;
    }
}

function advanceJsoncStringChar(raw, i, out) {
    const ch = raw[i];
    out.push(ch);
    if (ch === "\\" && i + 1 < raw.length) {
        out.push(raw[i + 1]);
        return { nextIdx: i + 2, stillInString: true };
    }
    return { nextIdx: i + 1, stillInString: ch !== '"' };
}

function skipJsoncComment(raw, i) {
    if (raw[i] === "/" && raw[i + 1] === "/") {
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\n")
            j++;
        return j;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
        let j = i + 2;
        while (j < raw.length && !(raw[j] === "*" && raw[j + 1] === "/"))
            j++;
        return j + 2;
    }
    return -1;
}

/** Strip line/block comments and trailing commas from a JSONC string. */
export function stripJsonc(raw) {
    const out = [];
    let i = 0;
    let inString = false;
    while (i < raw.length) {
        if (inString) {
            const step = advanceJsoncStringChar(raw, i, out);
            i = step.nextIdx;
            inString = step.stillInString;
            continue;
        }
        const commentEnd = skipJsoncComment(raw, i);
        if (commentEnd !== -1) {
            i = commentEnd;
            continue;
        }
        const ch = raw[i];
        if (ch === '"')
            inString = true;
        else if (ch === "}" || ch === "]")
            stripTrailingCommaBeforeClose(out);
        out.push(ch);
        i++;
    }
    return out.join("");
}

/** Parse standard JSON first, falling back to comment/trailing-comma stripping for JSONC. */
export function parseJsonc(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return JSON.parse(stripJsonc(raw));
    }
}
