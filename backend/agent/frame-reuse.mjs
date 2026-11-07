// Reuses the check's rendered frames across checks of a changed scene. check {fix:"auto"}
// checks the scene again after each round of fixes (pixels included), and every round used to
// render all its frames again: minutes for a long video with footage. A frame is reused when
// the scene around the layers that changed is the same, and every changed layer is not drawn
// at that time, before or after the change. Anything unsure (a mask, a layer in a group, a
// layer that names a changed one) is rendered again, so a reused frame is the same picture a
// new render would give.
import { evaluateLayer } from "../../engine/animation.js";
import { enabledAnimations } from "../../engine/animationEnabled.js";
import { textAnimationMode } from "../../engine/textAnimation.js";
import { hasTextChanges } from "../../engine/textChange.js";
import { sceneNeedsChromium } from "../raster-policy.mjs";

// How many rendered scenes are kept, and the most frame bytes kept over all of them. A check
// draws one scene many ways (each clip alone for the footage rules: 30 or more on a minute of
// footage), so a few checks' worth are kept; the bytes bound them (a 48 px frame is 5 kB).
const MAX_ENTRIES = 160;
const MAX_BYTES = 384 * 1024 * 1024;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The loaded faces: a new face (set_font downloads one) can change how unchanged text draws.
function fontsKey(fonts) {
  return (fonts?.faces ?? []).map((face) => `${face.family}/${face.weight}/${face.style}`).join(",");
}

function frameBytes(frame) {
  let bytes = 0;
  for (const value of Object.values(frame ?? {})) if (ArrayBuffer.isView(value)) bytes += value.byteLength;
  return bytes;
}

// True when the renderer draws nothing of a top-level `layer` at `time` (render.js renderLayer).
function notDrawn(layer, time, fonts) {
  if (layer.visible === false || layer.type === "audio") return true;
  let state;
  try {
    const evaluated = evaluateLayer(layer, time, { fonts });
    state = evaluated?.values ?? evaluated?.properties ?? evaluated ?? {};
  } catch { return false; }
  if (state.visible === false) return true;
  // A text drawn by letters, words or lines (or a Change text) gives each unit its own opacity.
  if (layer.type === "text" && (hasTextChanges(layer) || textAnimationMode(layer) !== "layer" || enabledAnimations(layer.animations).some((animation) => animation.textClip))) return false;
  const opacity = Number.isFinite(state.opacity) ? state.opacity : Number.isFinite(layer.opacity) ? layer.opacity : 1;
  return opacity <= 0;
}

// The way a scene is drawn: its width and the layers left out (hidden). Frames are reused only
// from the same way (a clip drawn alone is never another clip drawn alone), so each check looks
// through a few kept scenes, not all of them.
const laneOf = (scene, width) => `${width}|${scene.layers.filter((layer) => layer.visible === false).map((layer) => layer.id).sort().join(",")}`;

export function createFrameReuse({ maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  // Newest last: { lane, rest, width, fonts, layers: Map(id → {layer, json}), order, frames: Map(time → frame) }.
  const entries = [];

  // The layers that differ between two entries, or null when no frame of `old` can be reused.
  function changedBetween(old, now) {
    if (old.rest !== now.rest || old.width !== now.width || old.fonts !== now.fonts) return null;
    const changed = new Set();
    for (const [id, { json }] of now.layers) if (old.layers.get(id)?.json !== json) changed.add(id);
    for (const id of old.layers.keys()) if (!now.layers.has(id)) changed.add(id);
    // A layer that names a changed one (a mask target, a path, a parent) may change with it.
    for (let grew = true; grew;) {
      grew = false;
      const pattern = changed.size ? new RegExp(`"(?:[^"]*/)?(?:${[...changed].map(escape).join("|")})(?:/[^"]*)?"`) : null;
      for (const entry of [old, now]) for (const [id, { json }] of entry.layers) {
        if (changed.has(id) || !pattern?.test(json)) continue;
        changed.add(id);
        grew = true;
      }
    }
    // The other layers keep their order, so the changed ones only add or take away paint.
    const order = (entry) => entry.order.filter((id) => !changed.has(id)).join("\n");
    if (order(old) !== order(now)) return null;
    for (const entry of [old, now]) for (const id of changed) {
      const layer = entry.layers.get(id)?.layer;
      if (layer && (layer.parentId || layer.isMask || layer.type === "group")) return null;
    }
    return changed;
  }

  /**
   * The frames of `scene` at `times`, as render(scene, times) would give them: the ones a kept
   * render can give are reused, and only the rest are rendered (by `render`, in one call).
   */
  async function framesFor(scene, times, { width, fonts, render }) {
    const now = {
      lane: laneOf(scene, width),
      rest: JSON.stringify({ ...scene, layers: undefined, chromium: sceneNeedsChromium(scene) }),
      width, fonts: fontsKey(fonts),
      layers: new Map(scene.layers.map((layer) => [layer.id, { layer, json: JSON.stringify(layer) }])),
      order: scene.layers.map((layer) => layer.id),
      frames: new Map(),
    };
    const wanted = [...new Set(times)];
    // A scene with masks at the top level: a mask paints the next layer, so nothing is reused.
    const masked = scene.layers.some((layer) => layer.isMask);
    // The same scene drawn the same way again (a rule asking for more times): its kept entry
    // takes the new frames, so one scene is one entry however many calls draw it.
    let twin = null;
    for (let index = entries.length - 1; index >= 0 && !masked && (now.frames.size < wanted.length || !twin); index -= 1) {
      const old = entries[index];
      if (old.lane !== now.lane) continue;
      const changed = changedBetween(old, now);
      if (!changed) continue;
      if (!changed.size) twin ??= old;
      for (const time of wanted) {
        if (now.frames.has(time) || !old.frames.has(time)) continue;
        const same = [...changed].every((id) => [old, now].every((entry) => {
          const layer = entry.layers.get(id)?.layer;
          return !layer || notDrawn(layer, time, fonts);
        }));
        if (same) now.frames.set(time, old.frames.get(time));
      }
    }
    const missing = wanted.filter((time) => !now.frames.has(time));
    if (missing.length) {
      const rendered = await render(scene, missing);
      missing.forEach((time, position) => { if (rendered[position]) now.frames.set(time, rendered[position]); });
    }
    if (twin) {
      for (const [time, frame] of now.frames) twin.frames.set(time, frame);
      // Another call may have dropped the twin while this one rendered: then nothing is taken out.
      const at = entries.indexOf(twin);
      if (at >= 0) entries.splice(at, 1);
      keep(twin);
    } else keep(now);
    return { frames: times.map((time) => now.frames.get(time)), reused: wanted.length - missing.length, rendered: missing.length };
  }

  // Keeps the newest entries within the count and the bytes (a frame shared by two counts once).
  function keep(entry) {
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
    for (;;) {
      const seen = new Set();
      let bytes = 0;
      for (const kept of entries) for (const frame of kept.frames.values()) if (!seen.has(frame)) { seen.add(frame); bytes += frameBytes(frame); }
      if (bytes <= maxBytes || entries.length <= 1) break;
      entries.shift();
    }
  }

  return { framesFor };
}
