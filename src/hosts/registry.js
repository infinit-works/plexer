/**
 * Registry of AI coding hosts Plexer can write instructions for.
 * Adding a host = adding one entry here (plus a renderer if it needs
 * a new file format).
 *
 * kind: 'section' → upsert the fenced block into a shared file the user owns.
 * kind: 'owned'   → plexer owns the whole file; overwrite it each run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from './instructions.js';
import { skillTemplate } from '../claude/shim-template.js';
import { dirExists } from '../util/fs.js';
export const HOSTS = [
    {
        id: 'agents',
        name: 'AGENTS.md hosts (Codex-style CLIs, editors that read AGENTS.md)',
        kind: 'section',
        relPath: 'AGENTS.md',
        content: instructionBody,
        detect: (home) => dirExists(join(home, '.codex')) ||
            dirExists(join(home, '.config', 'agents')),
    },
    {
        id: 'adal',
        name: 'AdaL',
        kind: 'owned',
        relPath: join('.adal', 'skills', 'plexer', 'SKILL.md'),
        content: skillTemplate,
        detect: (home, repo) => dirExists(join(home, '.adal')) || dirExists(join(repo, '.adal')),
    },
    {
        id: 'cursor',
        name: 'Cursor',
        kind: 'owned',
        relPath: join('.cursor', 'rules', 'plexer.mdc'),
        content: cursorRule,
        detect: (home, repo) => dirExists(join(home, '.cursor')) || dirExists(join(repo, '.cursor')),
    },
    {
        id: 'gemini',
        name: 'Gemini CLI',
        kind: 'section',
        relPath: 'GEMINI.md',
        content: instructionBody,
        // Require Gemini CLI-specific files so Google Antigravity's `~/.gemini/`
        // directory does not false-trigger GEMINI.md creation.
        detect: (home, repo) => existsSync(join(home, '.gemini', 'settings.json')) ||
            existsSync(join(home, '.gemini', 'oauth_creds.json')) ||
            existsSync(join(repo, '.gemini', 'settings.json')),
    },
    {
        id: 'grok',
        name: 'Grok (xAI)',
        kind: 'owned',
        relPath: join('.grok', 'skills', 'plexer', 'SKILL.md'),
        content: skillTemplate,
        detect: (home, repo) => dirExists(join(home, '.grok')) || dirExists(join(repo, '.grok')),
    },
    {
        id: 'hermes',
        name: 'Hermes Agent (Nous Research)',
        kind: 'section',
        relPath: 'AGENTS.md',
        content: instructionBody,
        // Hermes is repo-aware: it reads AGENTS.md at the repo root (and the
        // Plexer-for-Hermes plugin keeps the graph fresh on every session start).
        detect: (home, repo) => dirExists(join(home, '.hermes')) ||
            dirExists(join(home, 'AppData', 'Local', 'hermes')) ||
            dirExists(join(repo, '.hermes')),
    },
    {
        id: 'antigravity',
        name: 'Google Antigravity',
        kind: 'section',
        relPath: 'AGENTS.md',
        content: instructionBody,
        // Antigravity-specific markers, NOT the bare `~/.gemini` (which is also Gemini CLI's):
        // its global config dir (`~/.gemini/config/`, where mcp_config.json + hooks.json live)
        // or a workspace `.agents/` dir. Keeps a plain Gemini-CLI user from auto-selecting it.
        detect: (home, repo) => dirExists(join(home, '.gemini', 'config')) ||
            dirExists(join(home, '.gemini', 'antigravity')) ||
            dirExists(join(home, '.gemini', 'antigravity-cli')) ||
            dirExists(join(repo, '.agents')),
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        kind: 'section',
        relPath: 'AGENTS.md',
        content: instructionBody,
        detect: (home, repo) => dirExists(join(home, '.config', 'opencode')) || existsSync(join(repo, 'opencode.json')),
    },
    {
        id: 'copilot',
        name: 'GitHub Copilot',
        kind: 'section',
        relPath: join('.github', 'copilot-instructions.md'),
        content: instructionBody,
        detect: (_home, repo) => existsSync(join(repo, '.github', 'copilot-instructions.md')),
    },
    {
        id: 'kiro',
        name: 'Kiro',
        kind: 'owned',
        relPath: join('.kiro', 'steering', 'plexer.md'),
        content: kiroSteering,
        detect: (home, repo) => dirExists(join(home, '.kiro')) || dirExists(join(repo, '.kiro')),
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        kind: 'owned',
        relPath: join('.windsurf', 'rules', 'plexer.md'),
        content: windsurfRule,
        detect: (home, repo) => dirExists(join(home, '.codeium', 'windsurf')) || dirExists(join(repo, '.windsurf')),
    },
];
export function allHostIds() {
    return [...HOSTS.map((h) => h.id), 'claude'];
}
export function detectClaude(home, repo) {
    return dirExists(join(home, '.claude')) || dirExists(join(repo, '.claude'));
}
export function detectHosts(home, repo) {
    return HOSTS.filter((h) => h.detect(home, repo));
}
