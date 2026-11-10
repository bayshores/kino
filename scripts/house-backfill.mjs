// Builds the house memory (backend/house-memory.mjs) for a data folder's saved projects without
// rendering: each project's newest revision, read from <data>/store.json, fonts kino does not
// bundle drawn in a stand-in face. Usage: node scripts/house-backfill.mjs <data folder>
// It writes only <data>/house/<projectId>.json; projects in the trash are left out.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { createHouseMemory, houseMoments, houseStructure, withStandInFonts } from "../backend/house-memory.mjs";
import { videoScene } from "../backend/agent/quality.mjs";
import { defaultFonts } from "../engine/fonts.js";
import { parseDocument } from "../engine/model.js";

const dataRoot = process.argv[2];
if (!dataRoot) {
  console.error("Usage: node scripts/house-backfill.mjs <data folder>");
  process.exit(1);
}
defaultFonts.replace(await loadBundledFonts());
const store = JSON.parse(await readFile(path.join(dataRoot, "store.json"), "utf8"));
const house = createHouseMemory(path.join(dataRoot, "house"));
for (const record of store.projects ?? []) {
  if (record.trashedAt || !record.document) continue;
  const { id, name } = record.document;
  try {
    const { document, families } = withStandInFonts(parseDocument(record.document), defaultFonts);
    const moments = houseMoments(document, { fonts: defaultFonts, families });
    await house.record({ projectId: id, name, rev: record.revision, moments, structure: houseStructure(document, videoScene(document), { fonts: defaultFonts }) });
    console.log(`${id}: ${moments.length} moments`);
  } catch (error) {
    console.log(`${id}: skipped (${error.message})`);
  }
}
