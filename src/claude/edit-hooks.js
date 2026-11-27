import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, dirname, isAbsolute, resolve, relative } from 'node:path';
import { formatBlastRadius, formatOrientation } from './format.js';
import { loadGraphCached } from '../context/graph-store.js';
import { flushWiringJsonIfDirty, isSqliteWiringDirty } from '../storage/sqlite-store.js';
import { isWithinRoot } from '../util/fs.js';
import { contextDirFor, isLexicallyWithin } from '../util/paths.js';
import { acquireLock, updateLockPid, releaseLock, readStats, patchStats, readSession, writeSession } from '../util/state.js';
import { claudeScriptPath } from './paths.js';

export function underPlexer(dir, file) {
    const absDir = resolve(dir), absFile = resolve(absDir, file);
    return isLexicallyWithin(contextDirFor(absDir), absFile) || isLexicallyWithin(join(absDir, 'plexer'), absFile);
}

export function editedFilePath(input, dir) {
    const direct = input?.tool_input?.file_path ?? input?.file_path;
    if (typeof direct === 'string' && direct.trim()) return direct;
    const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(String(input?.tool_input?.command ?? ''));
    return m ? (isAbsolute(m[1]) ? m[1] : join(dir, m[1])) : null;
}

function insideRepo(dir, file) {
    const absDir = resolve(dir), absFile = resolve(absDir, file);
    if (isLexicallyWithin(absDir, absFile, { allowEqual: false })) return true;
    return isWithinRoot(dirname(absFile), absDir);
}

export function recordFileEdit(dir, file, opts = {}) {
    if (!file || underPlexer(dir, file) || !insideRepo(dir, file)) return null;
    const prev = readStats(dir);
    patchStats(dir, { dirty: true, staleCount: Math.max(1, (prev?.staleCount ?? 0) + 1), lastFile: basename(file) });
    if (opts?.skipBlast) return true;
    const w = loadGraphCached(contextDirFor(dir));
    return w ? formatBlastRadius(w, file, 8, dir) : null;
}

export function readOrientation(dir, budgetBytes = 1200) {
    try { return formatOrientation(readFileSync(join(contextDirFor(dir), 'INDEX.md'), 'utf8'), budgetBytes); }
    catch { return null; }
}

export function handlePostEdit(input, dir, opts = {}) {
    const editedFile = editedFilePath(input, dir);
    const br = recordFileEdit(dir, editedFile);
    if (!br) return '';
    const id = input?.session_id || 'default';
    const s = readSession(dir, id);
    const absEdited = editedFile ? (isAbsolute(editedFile) ? editedFile : join(dir, editedFile)) : '';
    const relEdited = absEdited ? (relative(resolve(dir), resolve(absEdited)).replace(/\\/g, '/') || basename(absEdited)) : '';
    s.emittedBlastFiles = Array.isArray(s.emittedBlastFiles) ? s.emittedBlastFiles : [];
    const inTurn0 = Boolean(relEdited) && (s.injectedPointers ?? []).some((p) => {
        const f = String(p).split(':')[0].replace(/\\/g, '/');
        return f === relEdited || relEdited.endsWith(`/${f}`);
    });
    if (relEdited && (s.emittedBlastFiles.includes(relEdited) || inTurn0)) return '';
    if (relEdited) { s.emittedBlastFiles.push(relEdited); writeSession(dir, id, s); }
    const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: br } });
    if (!opts.captureStdout) process.stdout.write(payload);
    return payload;
}

export function triggerBackgroundSync(dir) {
    const ctxDir = contextDirFor(dir);
    if (!existsSync(dir) || !existsSync(ctxDir) || !acquireLock(dir)) return false;
    patchStats(dir, { syncing: true });
    try {
        const child = spawn(process.execPath, [claudeScriptPath('sync-run.js'), dir], { detached: true, stdio: 'ignore' });
        if (child.pid) updateLockPid(dir, child.pid);
        child.unref();
        return true;
    } catch {
        patchStats(dir, { syncing: false });
        releaseLock(dir);
        return false;
    }
}

export function handleStop(_input, dir) {
    const ctxDir = contextDirFor(dir);
    if (!existsSync(dir) || !existsSync(ctxDir)) return;
    if (readStats(dir)?.dirty) {
        triggerBackgroundSync(dir);
        return;
    }
    if (isSqliteWiringDirty(ctxDir)) {
        try {
            flushWiringJsonIfDirty(ctxDir);
        }
        catch {
            /* best-effort lazy wiring flush */
        }
    }
}
