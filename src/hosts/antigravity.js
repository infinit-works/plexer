import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { skillTemplate } from './skill-template.js';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { updateJsonConfig, writeOwned } from './config-write.js';

function skillDir(home) {
    return join(home, '.gemini', 'skills', 'plexer');
}
function skillPath(home) {
    return join(skillDir(home), 'SKILL.md');
}
function shimPath(home) {
    return join(home, '.gemini', 'config', 'helpers', 'plexer-hooks.cjs');
}
function hooksJsonPath(home) {
    return join(home, '.gemini', 'config', 'hooks.json');
}

export function antigravitySkillTargets(home) {
    return [
        {
            hostId: 'antigravity', id: 'antigravity-skill',
            path: skillPath(home),
            scope: 'global', kind: 'skill', what: 'plexer skill (shared)',
        },
        {
            hostId: 'antigravity', id: 'antigravity-hook-shim',
            path: shimPath(home),
            scope: 'global', kind: 'hook', what: 'Antigravity hook shim',
        },
        {
            hostId: 'antigravity', id: 'antigravity-hooks',
            path: hooksJsonPath(home),
            scope: 'global', kind: 'hook', what: 'PreInvocation / PostToolUse / Stop (plexer-hooks)',
        },
    ];
}

function desiredPlexerHooksBlock(shim) {
    return {
        PreInvocation: [
            { type: 'command', command: `node "${shim}" agy-pre-invocation`, timeout: 15 },
        ],
        PostToolUse: [
            {
                matcher: 'edit_file|write_file',
                hooks: [
                    { type: 'command', command: `node "${shim}" agy-post-edit`, timeout: 10 },
                ],
            },
        ],
        Stop: [
            { type: 'command', command: `node "${shim}" agy-stop`, timeout: 10 },
        ],
    };
}

function isSkillSymlink(sDir) {
    try {
        return lstatSync(sDir).isSymbolicLink();
    }
    catch {
        return false;
    }
}

export function installAntigravitySkill(home, opts = {}) {
    const out = [];
    if (opts.skills !== false) {
        const sDir = skillDir(home);
        const sPath = skillPath(home);
        const skillWrite = isSkillSymlink(sDir)
            ? { id: 'antigravity-skill', path: sPath, action: 'unchanged' }
            : writeOwned('antigravity-skill', sPath, skillTemplate());
        out.push(skillWrite);
    }
    if (opts.hooks === false) {
        return out;
    }
    const shim = shimPath(home);
    const shimResult = writeOwned('antigravity-hook-shim', shim, hooksShim(claudeDistDir()), 0o755);
    const hooksResult = updateJsonConfig('antigravity-hooks', hooksJsonPath(home), (root) => {
        root['plexer-hooks'] = desiredPlexerHooksBlock(shim);
    });
    out.push(shimResult, hooksResult);
    return out;
}

