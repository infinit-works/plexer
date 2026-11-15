import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { claudeGlobalTargets, installClaudeGlobal } from '../claude/init.js';
import { packageRootDir } from '../claude/paths.js';
import { BIN_LAUNCH, mergeJsonKey } from '../util/config-write.js';
import { dirExists } from '../util/fs.js';
import { geminiHookTargets, hookTargets, installCodexHooks, installGeminiHooks } from './codex-hooks.js';
import { antigravitySkillTargets, ensureSymlink, installAntigravitySkill } from './antigravity.js';
import { mcpTargets, registerMcpConfigs } from './mcp-config.js';

function geminiCliDetected(home) {
    return existsSync(join(home, '.gemini', 'settings.json')) || existsSync(join(home, '.gemini', 'oauth_creds.json'));
}

function hasGeminiTarget(home, agentSet) {
    return agentSet ? agentSet.has('gemini') : geminiCliDetected(home);
}

function hasAntigravityTarget(home, agentSet) {
    if (agentSet && !agentSet.has('antigravity')) return false;
    return dirExists(join(home, '.gemini', 'config'))
        || dirExists(join(home, '.gemini', 'antigravity'))
        || Boolean(agentSet?.has('antigravity'));
}

export function globalSetupTargets(opts = {}) {
    const home = opts.home ?? homedir();
    const binDir = opts.binDir ?? join(home, '.local', 'bin');
    const pkgRoot = opts.pkgRoot ?? packageRootDir();
    const agentSet = Array.isArray(opts.agents) ? new Set(opts.agents) : null;
    const wantAgent = (id) => !agentSet || agentSet.has(id);
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
        if (wantAgent('agents')) out.push({ hostId: 'agents', id: 'agents-skill', path: join(home, '.agents', 'skills', 'plexer'), scope: 'global', kind: 'skill', what: 'plexer skill symlink' });
        if (wantAgent('claude')) out.push({ hostId: 'claude', id: 'claude-skill', path: join(home, '.claude', 'skills', 'plexer'), scope: 'global', kind: 'skill', what: 'plexer skill symlink' });
        if (hasGeminiTarget(home, agentSet)) out.push({ hostId: 'gemini', id: 'gemini-skill', path: join(home, '.gemini', 'skills', 'plexer'), scope: 'global', kind: 'skill', what: 'plexer skill symlink' });
    }
    if (opts.hooks !== false) {
        if (wantAgent('claude') && dirExists(join(home, '.claude'))) {
            out.push(...claudeGlobalTargets(home).filter((t) => t.kind !== 'mcp'));
        }
        if (wantAgent('agents') && dirExists(join(home, '.codex'))) {
            out.push(...hookTargets(home));
        }
        if (hasGeminiTarget(home, agentSet)) {
            out.push(...geminiHookTargets({ home }));
        }
        if (hasAntigravityTarget(home, agentSet)) {
            out.push(...antigravitySkillTargets(home).filter((t) => t.id === 'antigravity-plugin'));
        }
    }
    if (opts.mcp === true) {
        if (wantAgent('claude') && dirExists(join(home, '.claude'))) {
            out.push(...claudeGlobalTargets(home).filter((t) => t.kind === 'mcp'));
        }
        if (wantAgent('agents') && dirExists(join(home, '.codex'))) {
            out.push(...mcpTargets(pkgRoot, ['agents'], { home }));
        }
        if (hasGeminiTarget(home, agentSet)) {
            out.push({ hostId: 'gemini', id: 'gemini-global-mcp', path: join(home, '.gemini', 'settings.json'), scope: 'global', kind: 'mcp', what: 'mcpServers.plexer' });
        }
        if (hasAntigravityTarget(home, agentSet)) {
            out.push(...mcpTargets(pkgRoot, ['antigravity'], { home }));
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
        try { chmodSync(cliEntry, 0o755); }
        catch { /* best-effort */ }
        results.bin.push(ensureSymlink('plexer-bin', join(binDir, 'plexer'), cliEntry));
    }

    if (opts.skills !== false) {
        if (wantAgent('agents')) results.skills.push(ensureSymlink('agents-skill', join(home, '.agents', 'skills', 'plexer'), pkgRoot));
        if (wantAgent('claude')) results.skills.push(ensureSymlink('claude-skill', join(home, '.claude', 'skills', 'plexer'), pkgRoot));
        if (hasGeminiTarget(home, agentSet)) results.skills.push(ensureSymlink('gemini-skill', join(home, '.gemini', 'skills', 'plexer'), pkgRoot));
    }

    const wantHooks = opts.hooks !== false;
    const wantMcp = opts.mcp === true;

    if (wantAgent('claude') && dirExists(join(home, '.claude')) && (wantHooks || wantMcp)) {
        for (const r of installClaudeGlobal(home, { hooks: wantHooks, mcp: wantMcp })) {
            (r.id === 'claude-global-mcp' ? results.mcp : results.hooks).push(r);
        }
    }

    if (wantAgent('agents') && dirExists(join(home, '.codex'))) {
        if (wantHooks) results.hooks.push(...installCodexHooks(home));
        if (wantMcp) results.mcp.push(...registerMcpConfigs(pkgRoot, ['agents'], { home, global: true }));
    }

    if (hasGeminiTarget(home, agentSet)) {
        if (wantHooks) results.hooks.push(...installGeminiHooks({ home }));
        if (wantMcp) results.mcp.push(mergeJsonKey('gemini-global-mcp', join(home, '.gemini', 'settings.json'), 'mcpServers', BIN_LAUNCH));
    }

    if (hasAntigravityTarget(home, agentSet)) {
        const cfgDir = join(home, '.gemini', 'config');
        if (!dirExists(cfgDir)) mkdirSync(cfgDir, { recursive: true });
        if (wantHooks) results.hooks.push(...installAntigravitySkill(home, { hooks: true, skills: false, pkgRoot }));
        if (wantMcp) results.mcp.push(...registerMcpConfigs(pkgRoot, ['antigravity'], { home, global: true }));
    }

    return results;
}
