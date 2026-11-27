// Generates the tiny `.cjs` shims installed into `.claude/helpers/` or `~/.codex/hooks/plexer/`.
// Their job is to locate the installed `plexer` skill's `src/claude/<entry>.js` and call into it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SKILL_MD_URL = new URL("../../SKILL.md", import.meta.url);
let cachedSkill = null;

export function skillTemplate() {
    if (cachedSkill === null) {
        cachedSkill = readFileSync(SKILL_MD_URL, "utf8");
    }
    return cachedSkill;
}

function buildShimDedupBlock() {
    return `const homeResolved = path.resolve(os.homedir());
function hasLocalPlexerHook(startDir, relConfigPath, checkFile) {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 25 && cur && cur !== homeResolved; i++) {
    const cfg = path.join(cur, relConfigPath);
    try {
      if ((!checkFile || fs.existsSync(path.join(cur, checkFile))) && fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').includes('plexer')) {
        return true;
      }
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}
const ev = process.argv[2] || '';
const dedupOut = (ev === 'agy-pre-tool' || ev === 'agy-stop' || ev === 'agy-post-cascade-response')
  ? '{"decision":"allow"}\\n'
  : '{}\\n';
const globalClaudeHelpers = path.join(homeResolved, '.claude', 'helpers') + path.sep;
const globalGeminiHooks = path.join(homeResolved, '.gemini', 'hooks', 'plexer') + path.sep;
const globalGeminiHelpers = path.join(homeResolved, '.gemini', 'config', 'helpers') + path.sep;
const globalCodexHooks = path.join(homeResolved, '.codex', 'hooks', 'plexer') + path.sep;
if (__filename.startsWith(globalClaudeHelpers)) {
  if (hasLocalPlexerHook(process.env.CLAUDE_PROJECT_DIR || process.cwd(), path.join('.claude', 'settings.json'), path.join('.claude', 'helpers', 'plexer-hooks.cjs'))) {
    process.stdout.write(dedupOut);
    process.exit(0);
  }
} else if (__filename.startsWith(globalGeminiHooks)) {
  if (hasLocalPlexerHook(process.env.GEMINI_PROJECT_DIR || process.cwd(), path.join('.gemini', 'settings.json'), path.join('.gemini', 'helpers', 'plexer-hooks.cjs'))) {
    process.stdout.write(dedupOut);
    process.exit(0);
  }
} else if (__filename.startsWith(globalGeminiHelpers)) {
  if (hasLocalPlexerHook(process.env.ANTIGRAVITY_PROJECT_DIR || process.cwd(), path.join('.agents', 'hooks.json'))) {
    process.stdout.write(dedupOut);
    process.exit(0);
  }
} else if (__filename.startsWith(globalCodexHooks)) {
  if (hasLocalPlexerHook(process.env.CODEX_PROJECT_DIR || process.cwd(), path.join('.codex', 'hooks.json'))) {
    process.stdout.write(dedupOut);
    process.exit(0);
  }
}
`;
}

function buildShimInvokeBlock(entryFile, call, preferHookClient) {
    if (!preferHookClient) {
        return `import(pathToFileURL(entry(${JSON.stringify(entryFile)})).href).then((m) => ${call}).catch(() => { /* plexer unavailable — no-op */ });`;
    }
    return `if (BAKED_CLIENT && fs.existsSync(BAKED_CLIENT)) {
  const client = require(BAKED_CLIENT);
  if (client && typeof client.main === 'function') {
    client.main().then(() => process.exit(0), () => process.exit(0));
  }
} else {
  const claudeTarget = entry(${JSON.stringify(entryFile)});
  const clientTarget = path.resolve(path.dirname(claudeTarget), '..', '..', 'bin', 'plexer-hook-client.cjs');
  if (fs.existsSync(clientTarget)) {
    const client = require(clientTarget);
    if (client && typeof client.main === 'function') {
      client.main().then(() => process.exit(0), () => process.exit(0));
    }
  } else {
    import(pathToFileURL(claudeTarget).href).then((m) => ${call}).catch(() => { /* plexer unavailable — no-op */ });
  }
}`;
}

function buildShimEntryBlock() {
    return `function entry(name) {
  if (BAKED) {
    const bakedFile = path.join(BAKED, name);
    if (fs.existsSync(bakedFile)) return bakedFile;
  }
  const home = os.homedir();
  let binClaudeDir = null;
  try {
    const realBin = fs.realpathSync(path.join(home, '.local', 'bin', 'plexer'));
    binClaudeDir = path.resolve(path.dirname(realBin), '..', 'src', 'claude');
  } catch {}
  const skillLinks = [
    path.join(home, '.agents', 'skills', 'plexer'),
    path.join(home, '.claude', 'skills', 'plexer'),
    path.join(home, '.gemini', 'skills', 'plexer'),
  ];
  const realSkillDirs = [];
  for (const s of skillLinks) {
    try { realSkillDirs.push(path.join(fs.realpathSync(s), 'src', 'claude')); } catch {}
  }
  const candidates = [
    BAKED,
    binClaudeDir,
    ...skillLinks.map((s) => path.join(s, 'src', 'claude')),
    ...realSkillDirs,
  ];
  for (const d of candidates) {
    if (d && fs.existsSync(path.join(d, name))) return path.join(d, name);
  }
  return path.join(BAKED, name);
}`;
}

function shim(entryFile, call, bakedDir, dedupGlobalHooks = false, preferHookClient = false) {
    const dedupBlock = dedupGlobalHooks ? buildShimDedupBlock() : '';
    const invokeBlock = buildShimInvokeBlock(entryFile, call, preferHookClient);
    const bakedClient = preferHookClient && bakedDir ? resolve(bakedDir, '..', '..', 'bin', 'plexer-hook-client.cjs') : '';
    return `#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const BAKED = ${JSON.stringify(bakedDir)};
const BAKED_CLIENT = ${JSON.stringify(bakedClient)};
${dedupBlock}
${buildShimEntryBlock()}

${invokeBlock}
`;
}
export function statuslineShim(bakedDir) { return shim('statusline.js', 'm.main()', bakedDir); }
export function hooksShim(bakedDir) { return shim('hooks.js', 'm.main(process.argv[2])', bakedDir, true, true); }