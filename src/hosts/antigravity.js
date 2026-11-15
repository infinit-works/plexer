import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    rmdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { skillTemplate } from '../claude/shim-template.js';
import { packageRootDir } from '../claude/paths.js';
import { readJsonObject, writeOwned } from '../util/config-write.js';

function skillDir(home) {
    return join(home, '.gemini', 'skills', 'plexer');
}
function skillPath(home) {
    return join(skillDir(home), 'SKILL.md');
}
function legacyConfigSkillDir(home) {
    return join(home, '.gemini', 'config', 'skills', 'plexer');
}
function pluginDir(home) {
    return join(home, '.gemini', 'config', 'plugins', 'plexer');
}
function shimPath(home) {
    return join(home, '.gemini', 'config', 'helpers', 'plexer-hooks.cjs');
}
function hooksJsonPath(home) {
    return join(home, '.gemini', 'config', 'hooks.json');
}

export function ensureSymlink(id, linkPath, targetPath) {
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

export function antigravitySkillTargets(home) {
    return [
        {
            hostId: 'antigravity', id: 'antigravity-plugin',
            path: pluginDir(home),
            scope: 'global', kind: 'plugin', what: 'Antigravity plexer plugin',
        },
        {
            hostId: 'antigravity', id: 'antigravity-skill',
            path: skillPath(home),
            scope: 'global', kind: 'skill', what: 'plexer skill (shared)',
        },
        {
            hostId: 'antigravity', id: 'antigravity-hook-shim',
            path: shimPath(home),
            scope: 'global', kind: 'hook', what: 'legacy Antigravity hook shim',
        },
        {
            hostId: 'antigravity', id: 'antigravity-hooks',
            path: hooksJsonPath(home),
            scope: 'global', kind: 'hook', what: 'legacy plexer-hooks entry in ~/.gemini/config/hooks.json',
        },
    ];
}

function isSkillSymlink(sDir) {
    try {
        if (lstatSync(dirname(sDir)).isSymbolicLink())
            return true;
    }
    catch { /* parent dir absent */ }
    try {
        if (lstatSync(sDir).isSymbolicLink())
            return true;
    }
    catch { /* sDir absent */ }
    return existsSync(join(sDir, 'package.json')) || existsSync(join(sDir, '.git'));
}

function stripLegacyPlexerHooks(path) {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable' || !loaded.existed)
        return { id: 'antigravity-hooks-cleanup', path, action: 'unchanged' };
    if (!('plexer-hooks' in loaded.root))
        return { id: 'antigravity-hooks-cleanup', path, action: 'unchanged' };
    delete loaded.root['plexer-hooks'];
    if (Object.keys(loaded.root).length === 0) {
        rmSync(path, { force: true });
        return { id: 'antigravity-hooks-cleanup', path, action: 'deleted' };
    }
    writeFileSync(path, `${JSON.stringify(loaded.root, null, 2)}\n`);
    return { id: 'antigravity-hooks-cleanup', path, action: 'updated' };
}

function removeIfExists(id, path) {
    try {
        lstatSync(path);
        rmSync(path, { force: true });
        try {
            rmdirSync(dirname(path));
        }
        catch { /* non-empty parent */ }
        return { id, path, action: 'deleted' };
    }
    catch {
        return { id, path, action: 'unchanged' };
    }
}

function hasGeminiCli(home) {
    return existsSync(join(home, '.gemini', 'settings.json')) || existsSync(join(home, '.gemini', 'oauth_creds.json'));
}

export function installAntigravitySkill(home, opts = {}) {
    const out = [];
    const pkgRoot = opts.pkgRoot ?? packageRootDir();
    // Skip duplicate ~/.gemini/skills/plexer/SKILL.md when the AGY plugin bundle installs,
    // unless opts.skills === true explicitly or Gemini CLI is present.
    const wantSharedSkill = opts.skills === true || (opts.skills !== false && (hasGeminiCli(home) || opts.hooks === false));
    if (wantSharedSkill) {
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

    // Create ~/.gemini/config when ~/.gemini/antigravity exists so plugin installs cleanly.
    const agyAppDir = join(home, '.gemini', 'antigravity');
    const cfgDir = join(home, '.gemini', 'config');
    if (existsSync(agyAppDir) && !existsSync(cfgDir)) {
        mkdirSync(cfgDir, { recursive: true });
    }

    // Install native Antigravity plugin bundle (`plugin.json` + `rules/` + `skills/` + `hooks.json` + `sidecars/`).
    const pDir = pluginDir(home);
    if (existsSync(join(pkgRoot, 'plugin.json'))) {
        out.push(ensureSymlink('antigravity-plugin', pDir, pkgRoot));
    }

    // Migrate away from legacy loose hooks and duplicate config/antigravity skill entries,
    // never unlinking shared `~/.gemini/skills/plexer` through a symlinked `config/skills`.
    const configSkillsParent = join(home, '.gemini', 'config', 'skills');
    const dupSkill = legacyConfigSkillDir(home);
    try {
        if (!lstatSync(configSkillsParent).isSymbolicLink() && lstatSync(dupSkill).isSymbolicLink())
            out.push(removeIfExists('antigravity-dup-skill-cleanup', dupSkill));
    }
    catch { /* absent */ }

    const agySkillsParent = join(agyAppDir, 'skills');
    const staleAgySkill = join(agySkillsParent, 'plexer');
    try {
        if (!lstatSync(agySkillsParent).isSymbolicLink()) {
            const st = lstatSync(staleAgySkill);
            if (st.isSymbolicLink() || st.isFile()) {
                out.push(removeIfExists('antigravity-stale-skill-cleanup', staleAgySkill));
            }
            else if (st.isDirectory()) {
                rmSync(staleAgySkill, { recursive: true, force: true });
                out.push({ id: 'antigravity-stale-skill-cleanup', path: staleAgySkill, action: 'deleted' });
            }
        }
    }
    catch { /* absent */ }

    const legacyShim = removeIfExists('antigravity-hook-shim-cleanup', shimPath(home));
    if (legacyShim.action !== 'unchanged')
        out.push(legacyShim);

    const legacyHooks = stripLegacyPlexerHooks(hooksJsonPath(home));
    if (legacyHooks.action !== 'unchanged')
        out.push(legacyHooks);

    return out;
}
