import { readFileSync } from "node:fs";

const SKILL_MD_URL = new URL("../../SKILL.md", import.meta.url);
let cachedSkill = null;

export function skillTemplate() {
    if (cachedSkill === null) {
        cachedSkill = readFileSync(SKILL_MD_URL, "utf8");
    }
    return cachedSkill;
}
