// The kino skill's files (skills/kino: SKILL.md and references/*.md), for the tests that run
// their examples. A section is found by its `## ` heading in whichever file has it, so a note
// can move between SKILL.md and a reference without breaking the test that runs its example.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SKILL_ROOT = fileURLToPath(new URL("../skills/kino/", import.meta.url));

/** { "SKILL.md": text, "references/edits.md": text, … } */
export function skillFiles() {
  const files = { "SKILL.md": readFileSync(`${SKILL_ROOT}SKILL.md`, "utf8") };
  for (const name of readdirSync(`${SKILL_ROOT}references`).filter((file) => file.endsWith(".md")).sort())
    files[`references/${name}`] = readFileSync(`${SKILL_ROOT}references/${name}`, "utf8");
  return files;
}

/** The text under `## <heading>` (up to the next # or ## heading), from whichever skill file has it. */
export function skillSection(heading) {
  for (const text of Object.values(skillFiles())) {
    const lines = text.split("\n");
    const start = lines.indexOf(`## ${heading}`);
    if (start < 0) continue;
    const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
  }
  throw new Error(`No skill file has a "## ${heading}" section.`);
}

/** Each ```json block of a text, as the list of objects on its lines. */
export function jsonBlocks(text) {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1].trim().split("\n").map((line) => JSON.parse(line)));
}
