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

/**
 * Ubiquitous container, lifecycle, stream, promise, logger, and Roblox Instance
 * member names (lowercased) that must never resolve cross-file without a known
 * receiver type or module specifier.
 */
export const GENERIC_MEMBER_NAMES = new Set([
    "get", "set", "has", "add", "delete", "clear", "run", "start", "stop", "open", "close",
    "read", "write", "send", "emit", "on", "off", "once", "map", "filter", "reduce", "find",
    "some", "every", "includes", "indexof", "push", "pop", "shift", "unshift", "slice", "splice",
    "concat", "join", "split", "trim", "replace", "match", "exec", "test", "tostring", "valueof",
    "clone", "copy", "equals", "hash", "init", "new", "load", "save", "update", "create", "remove",
    "parse", "format", "render", "build", "call", "apply", "bind", "then", "catch", "finally",
    "next", "done", "error", "warn", "info", "debug", "trace", "log", "check", "reset", "flush",
    "dispose", "destroy", "disconnect", "connect", "wait", "cancel", "abort", "keys", "values",
    "entries", "size", "length", "count", "sort", "reverse", "peek", "poll", "put", "patch",
    "post", "head", "options", "fetch", "query", "execute", "commit", "rollback", "lock", "unlock",
    "acquire", "release", "subscribe", "unsubscribe", "notify", "handle", "process", "visit",
    "accept", "encode", "decode", "serialize", "deserialize", "tojson", "fromjson", "validate",
    "verify", "resolve", "reject", "waitforchild", "findfirstchild", "findfirstchildofclass",
    "findfirstchildwhichisa", "findfirstancestor", "getchildren", "getdescendants", "getattribute",
    "setattribute", "getpropertychangedsignal", "isa", "isdescendantof", "fireserver", "fireclient",
    "fireallclients", "invokeserver", "invokeclient",
]);

/** True when `name` is >= 6 chars and splits into >= 2 camelCase, PascalCase, or snake_case subwords. */
export function isCompoundIdentifierName(name) {
    if (typeof name !== "string" || name.length < 6)
        return false;
    return /[a-z0-9][A-Z]/.test(name) || /[A-Z]{2,}[a-z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name);
}

/** Return the `Set` stored under `key` in `map`, creating and inserting an empty one when absent. */
export function ensureMapSet(map, key) {
    let set = map.get(key);
    if (!set) {
        set = new Set();
        map.set(key, set);
    }
    return set;
}
