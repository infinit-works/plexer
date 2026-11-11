import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { packageRootDir } from '../claude/paths.js';
import { dirExists } from '../util/fs.js';
import { installClaudeGlobal } from '../claude/init.js';
import { installCodexHooks } from './codex-hooks.js';
import { installAntigravitySkill } from './antigravity.js';
import { registerMcpConfigs } from './mcp-config.js';

function ensureSymlink(id, linkPath, targetPath) {
    try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) {
            try {
                if (realpathSync(linkPath) === realpathSync(targetPath)) {
                    return { id, path: linkPath, action: 'unchanged' };
                }
            }
            catch { /* broken symlink or unresolvable target */ }
            const currentTarget = readlinkSync(linkPath);
            if (resolve(dirname(linkPath), currentTarget) === resolve(targetPath)) {
                return { id, path: linkPath, action: 'unchanged' };
            }
            rmSync(linkPath, { force: true });
        }
        else if (st.isDirectory()) {
            const entries = readdirSync(linkPath);
            if (entries.length === 0 || (entries.length === 1 && entries[0] === 'SKILL.md')) {
                rmSync(linkPath, { recursive: true, force: true });
            }
            else {
                return { id, path: linkPath, action: 'skipped-nonempty-dir' };
            }
        }
        else {
            rmSync(linkPath, { force: true });
        }
    }
    catch { /* does not exist */ }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(targetPath, linkPath);
    return { id, path: linkPath, action: 'linked' };
}

export function globalSetupTargets(opts = {}) {
    const home = opts.home ?? homedir();
    const binDir = opts.binDir ?? join(home, '.local', 'bin');
    const agentSet = Array.isArray(opts.agents) ? new Set(opts.agents) : null;
    const out = [];
    if (opts.bin !== false) {
        out.push({
            hostId: 'global',
            id: 'plexer-bin',
            path: join(binDir, 'plexer'),
            scope: 'global',
            kind: 'bin',
            what: 'plexer CLI symlink',
        });
    }
    if (opts.skills !== false) {
        const skillTargets = [
            { hostId: 'agents', id: 'agents-skill', path: join(home, '.agents', 'skills', 'plexer'), what: 'plexer skill symlink' },
            { hostId: 'claude', id: 'claude-skill', path: join(home, '.claude', 'skills', 'plexer'), what: 'plexer skill symlink' },
            { hostId: 'antigravity', id: 'gemini-skill', path: join(home, '.gemini', 'skills', 'plexer'), what: 'plexer skill symlink' },
        ];
        for (const t of skillTargets) {
            if (!agentSet || agentSet.has(t.hostId)) {
                out.push({ ...t, scope: 'global', kind: 'skill' });
            }
        }
    }
    return out;
}

export function runGlobalSetup(opts = {}) {
    const home = opts.home ?? homedir();
    const binDir = opts.binDir ?? join(home, '.local', 'bin');
    const pkgRoot = opts.pkgRoot ?? packageRootDir();
    const cliEntry = join(pkgRoot, 'bin', 'plexer.js');
    const agentSet = Array.isArray(opts.agents) ? new Set(opts.agents) : null;
    const wantAgent = (id) => !agentSet || agentSet.has(id);
    const results = { bin: [], skills: [], hooks: [], mcp: [] };

    if (opts.bin !== false) {
        try {
            chmodSync(cliEntry, 0o755);
        }
        catch { /* best-effort */ }
        results.bin.push(ensureSymlink('plexer-bin', join(binDir, 'plexer'), cliEntry));
    }

    if (opts.skills !== false) {
        const skillTargets = [
            { hostId: 'agents', id: 'agents-skill', path: join(home, '.agents', 'skills', 'plexer') },
            { hostId: 'claude', id: 'claude-skill', path: join(home, '.claude', 'skills', 'plexer') },
            { hostId: 'antigravity', id: 'gemini-skill', path: join(home, '.gemini', 'skills', 'plexer') },
        ];
        for (const t of skillTargets) {
            if (wantAgent(t.hostId)) {
                results.skills.push(ensureSymlink(t.id, t.path, pkgRoot));
            }
        }
    }

    const wantHooks = opts.hooks !== false;
    const wantMcp = opts.mcp === true;

    if (wantAgent('claude') && dirExists(join(home, '.claude'))) {
        if (wantHooks || wantMcp) {
            const claudeRes = installClaudeGlobal(home, { hooks: wantHooks, mcp: wantMcp });
            for (const r of claudeRes) {
                if (r.id === 'claude-global-mcp') {
                    results.mcp.push(r);
                }
                else {
                    results.hooks.push(r);
                }
            }
        }
    }

    if (wantAgent('agents') && dirExists(join(home, '.codex'))) {
        if (wantHooks) {
            results.hooks.push(...installCodexHooks(home));
        }
        if (wantMcp) {
            results.mcp.push(...registerMcpConfigs(pkgRoot, ['agents'], { home, global: true }));
        }
    }

    if (wantAgent('antigravity') && dirExists(join(home, '.gemini', 'config'))) {
        if (wantHooks) {
            results.hooks.push(...installAntigravitySkill(home, { hooks: true, skills: opts.skills }));
        }
        if (wantMcp) {
            results.mcp.push(...registerMcpConfigs(pkgRoot, ['antigravity'], { home, global: true }));
        }
    }

    return results;
}
