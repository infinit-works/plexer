// Generates the tiny `.cjs` shims installed into `.claude/helpers/` or `~/.codex/hooks/plexer/`.
// Their job is to locate the installed `plexer` skill's `src/claude/<entry>.js` and call into it.
import { readFileSync } from "node:fs";

const SKILL_MD_URL = new URL("../../SKILL.md", import.meta.url);
let cachedSkill = null;

export function skillTemplate() {
    if (cachedSkill === null) {
        cachedSkill = readFileSync(SKILL_MD_URL, "utf8");
    }
    return cachedSkill;
}

function shim(entryFile, call, bakedDir) {
    return `#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const BAKED = ${JSON.stringify(bakedDir)};

function entry(name) {
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
}

import(pathToFileURL(entry(${JSON.stringify(entryFile)})).href).then((m) => ${call}).catch(() => { /* plexer unavailable — no-op */ });
`;
}
export function statuslineShim(bakedDir) { return shim('statusline.js', 'm.main()', bakedDir); }
export function hooksShim(bakedDir) { return shim('hooks.js', 'm.main(process.argv[2])', bakedDir); }