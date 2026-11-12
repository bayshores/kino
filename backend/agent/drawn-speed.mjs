// The receipt line for a footage layer an edit slowed over drawn footage (a file whose record says
// it holds each drawing 2 frames or more: holds, backend/shot-detection.mjs). A fact only: the
// interpolation the layer plays with, why, and how long each drawing is held in the file and on
// screen, so the agent sees the choice where it makes it.
import { constantSpeed, mediaInterpolationOf } from "../../engine/mediaTime.js";
import { speedAnimations } from "../../engine/animation.js";
import { sec } from "./describe.mjs";

const SHOWN = 4;
const TIMING = ["src", "mediaSpeed", "mediaInterpolation"];
const timing = (layer) => JSON.stringify(TIMING.map((key) => layer[key] ?? null));
const WHY = {
  nearest: "each drawing shows whole, held longer",
  blend: "cross-fades two drawings where one changes to the next",
  flow: "FFmpeg draws new in-between frames on export",
};

/**
 * One line: `L3 slows drawn footage to 0.33x: interpolation nearest (kino's default: each drawing
 * shows whole, held longer); the file holds each drawing 4 frames (0.133 s), 0.4 s on screen`.
 * `holds` is the file's hold pattern ({frames, fps}); "set on the layer" when the layer names its
 * own mediaInterpolation.
 */
export function drawnSpeedLine(name, layer, holds) {
  const speed = constantSpeed(layer);
  const mode = mediaInterpolationOf(layer);
  const how = layer.mediaInterpolation === mode ? "set on the layer" : "kino's default";
  const held = holds.fps > 0 ? holds.frames / holds.fps : null;
  const length = held ? ` (${sec(held)} s), ${sec(held / speed)} s on screen` : "";
  return `${name} slows drawn footage to ${sec(speed)}x: interpolation ${mode} (${how}: ${WHY[mode]}); the file holds each drawing ${holds.frames} frames${length}`;
}

/**
 * The receipt notes: for each video layer in `ids` (created or changed) that is new or whose speed
 * or interpolation changed, plays slower than 1 with a constant speed, and whose file is drawn
 * (`holdsOf(src)` resolves to the record's holds with frames 2 or more), one line. At most SHOWN.
 */
export async function drawnSpeedNotes({ before, after, ids, holdsOf, nameOf }) {
  const touched = new Set(ids);
  const was = new Map((before?.scenes ?? []).flatMap((scene) => (scene.layers ?? []).map((layer) => [layer.id, layer])));
  const notes = [];
  const known = new Map();
  for (const scene of after?.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (layer.type !== "video" || !layer.src || !touched.has(layer.id)) continue;
      if (!(constantSpeed(layer) < 1) || speedAnimations(layer).length) continue;
      const old = was.get(layer.id);
      if (old && timing(old) === timing(layer)) continue;
      if (!known.has(layer.src)) known.set(layer.src, await holdsOf(layer.src).catch(() => null));
      const holds = known.get(layer.src);
      if (holds?.frames >= 2) notes.push(drawnSpeedLine(nameOf(layer.id), layer, holds));
    }
  }
  return notes.length > SHOWN ? [...notes.slice(0, SHOWN), `${notes.length - SHOWN} more layers slow drawn footage`] : notes;
}
