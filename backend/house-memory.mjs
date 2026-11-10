// House memory: the layout signatures (engine/quality/layoutSignature.js) of what kino rendered,
// one file per project in <data>/house/<projectId>.json, so the seen_before check can tell when
// a new edit repeats a moment kino already made in another project, and the video's structure
// (houseStructure), so it can tell when a whole edit is built like another. Written after a render
// finishes (agent/service.mjs finishRender) and by scripts/house-backfill.mjs.
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { layoutMoments, SIGNATURE_VERSION } from "../engine/quality/layoutSignature.js";
import { STRUCTURE_VERSION, structureSignature } from "../engine/quality/structureSignature.js";

// Moments kept per project (each about 0.5 KB).
export const HOUSE_MAX = 40;
const STAND_IN = "Inter";

/**
 * A project's family: its name in lower case with " [copy]" and a trailing number (" 2", " v3",
 * "-v4") removed, so a copy and the project it was copied from are one family. The store keeps no
 * copy origin; seen_before never compares projects of one family.
 */
export function familyOf(name) {
  const plain = String(name ?? "").toLowerCase().replace(/\s*\[copy\]/g, "").trim();
  return plain.replace(/[\s_-]+v?\d+[a-z]?$/, "").trim() || plain;
}

/**
 * The document with every text layer whose font is not loaded drawn in a stand-in face (the
 * backfill has only the bundled fonts), and `families`: layer id to the family it asks for.
 */
export function withStandInFonts(document, fonts) {
  const families = new Map();
  const scenes = document.scenes.map((scene) => ({ ...scene, layers: scene.layers.map((layer) => {
    if (layer.type !== "text") return layer;
    families.set(layer.id, layer.fontFamily ?? "");
    try { fonts.resolve(layer); return layer; } catch { /* not loaded */ }
    const { fontSource, ...rest } = layer;
    return { ...rest, fontFamily: STAND_IN, fontStyle: "normal" };
  }) }));
  return { document: { ...document, scenes }, families };
}

/** The moments of a document's video scenes (not components): [{scene, t, sig}], at most HOUSE_MAX. */
export function houseMoments(document, { fonts, families = null, max = HOUSE_MAX } = {}) {
  const scenes = document.scenes.filter((scene) => !scene.isComponent);
  const found = [];
  for (const scene of scenes) {
    const model = kinoTimeline(document, scene.id, { fonts });
    for (const moment of layoutMoments(model, { families, max })) found.push({ scene: scene.id, ...moment });
  }
  if (found.length <= max) return found;
  return Array.from({ length: max }, (_, index) => found[Math.round((index * (found.length - 1)) / (max - 1))]);
}

/**
 * The structure of the video's scene (engine/quality/structureSignature.js: cut rate per song
 * section, effects with weights, burst, first drop, ending, title, colors), read with the
 * document's song markers and beat cues; null for a video with too few shots to have one.
 */
export function houseStructure(document, scene, { fonts }) {
  if (!scene) return null;
  const cues = document.cues ?? [];
  const model = kinoTimeline(document, scene.id, { fonts });
  return structureSignature(model, { markers: cues.filter((cue) => cue.kind === "marker"), beats: cues.filter((cue) => cue.kind === "beat" || cue.kind === "onset") });
}

/** The house memory in `directory` (<data>/house). */
export function createHouseMemory(directory) {
  const cache = new Map();
  const fileOf = (projectId) => path.join(directory, `${encodeURIComponent(projectId)}.json`);

  /**
   * Saves a project's moments (replacing what it had): {projectId, name, rev, moments}. `prints`:
   * {sceneId: [{t, print}]} measured for the render, kept beside the nearest moment within 0.5 s.
   * `structure`: the video's structure (houseStructure), saved with its format when there is one.
   */
  async function record({ projectId, name, rev, moments, prints = null, structure = null }) {
    const kept = moments.slice(0, HOUSE_MAX).map((moment) => {
      const near = prints?.[moment.scene]?.reduce((best, entry) => (Math.abs(entry.t - moment.t) <= 0.5 && (!best || Math.abs(entry.t - moment.t) < Math.abs(best.t - moment.t)) ? entry : best), null);
      return near?.print ? { ...moment, print: near.print } : moment;
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = fileOf(projectId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ projectId, name: name ?? projectId, family: familyOf(name ?? projectId), rev, sigVersion: SIGNATURE_VERSION, savedAt: new Date().toISOString(), moments: kept, ...(structure ? { structVersion: STRUCTURE_VERSION, structure } : {}) }), { mode: 0o600 });
    await rename(temporary, target);
  }

  /**
   * Every other project's memory, its family (familyOf `name`) left out: [{projectId, name, rev,
   * moments}], read again when a file changes.
   */
  async function others(projectId, name = null) {
    const family = name == null ? null : familyOf(name);
    let names = [];
    try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); } catch { return []; }
    const found = [];
    for (const name of names) {
      const file = path.join(directory, name);
      let info;
      try { info = await stat(file); } catch { continue; }
      let hit = cache.get(file);
      if (!hit || hit.mtime !== info.mtimeMs) {
        try { hit = { mtime: info.mtimeMs, value: JSON.parse(await readFile(file, "utf8")) }; } catch { continue; }
        cache.set(file, hit);
      }
      if (hit.value?.projectId === projectId || !Array.isArray(hit.value?.moments)) continue;
      if (family !== null && familyOf(hit.value.name ?? hit.value.projectId) === family) continue;
      found.push(hit.value);
    }
    return found;
  }

  return { record, others, directory };
}
