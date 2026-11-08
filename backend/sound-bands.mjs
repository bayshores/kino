// The audio behavior's band levels (engine/audioLevels.js) of a sound file: decoded like the beat
// analysis (decodeMono, one decode at a time), measured once and kept beside the file as
// <file>.bands. soundLevelsFor gives applyOperations its soundLevels context.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { AUDIO_LEVELS_VERSION, measureAudioLevels } from "../engine/audioLevels.js";
import { mediaIdFromSource } from "../engine/replaceMedia.js";
import { decodeMono } from "./audio-analysis.mjs";

export async function measureSoundBands(filename) {
  const { samples, sampleRate } = await decodeMono(filename);
  return measureAudioLevels(samples, sampleRate);
}

/** {get(file)}: the band levels, measured once and kept as <file>.bands. */
export function createSoundBandsCache({ measure = measureSoundBands } = {}) {
  const pending = new Map();
  async function readOrMeasure(file) {
    const sidecar = `${file}.bands`;
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (saved?.version === AUDIO_LEVELS_VERSION && Array.isArray(saved.all)) return saved;
    } catch { /* missing or old: measured again */ }
    const result = await measure(file);
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* the result still counts when the folder cannot be written */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return result;
  }
  function get(file) {
    if (!pending.has(file)) pending.set(file, readOrMeasure(file).finally(() => pending.delete(file)));
    return pending.get(file);
  }
  return { get };
}

// The layer names or IDs that audio behaviors in `value` (operations) read.
function audioRefs(value, refs = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return refs;
  if (typeof value.behavior?.audio?.layer === "string") refs.add(value.behavior.audio.layer);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) audioRefs(entry, refs, depth + 1);
  return refs;
}

/**
 * src -> band levels for each sound an audio behavior in `operations` names (a layer of
 * `document`, or one an operation adds with that name), or undefined when none does. A sound
 * that can't be measured is left out, so the engine refuses the edit with its own message.
 */
export async function soundLevelsFor(document, operations, { mediaRoot, cache }) {
  const refs = audioRefs(operations);
  if (!refs.size || !mediaRoot) return undefined;
  const sources = new Set();
  for (const layer of (document?.scenes ?? []).flatMap((scene) => scene.layers ?? []))
    if ((refs.has(layer.id) || refs.has(layer.name)) && typeof layer.src === "string") sources.add(layer.src);
  for (const operation of operations ?? []) {
    const properties = operation?.properties ?? operation?.layer;
    if (properties && refs.has(properties.name) && typeof properties.src === "string") sources.add(properties.src);
  }
  const levels = new Map();
  for (const src of sources) {
    const id = mediaIdFromSource(src);
    const file = id ? path.join(mediaRoot, id) : null;
    if (!file || !existsSync(file)) continue;
    try { levels.set(src, await cache.get(file)); } catch { /* left out: refused by the engine */ }
  }
  return levels;
}
