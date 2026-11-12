// The mix's limiter places turned down where they happen (check {fix:"auto"}). Each place the
// "mix:" line names (backend/audio-levels.mjs limiterPlaces: its span, its xN factor and the layers
// playing there) multiplies those layers' volumes by its factor, so the summed peak lands on the
// limiter's ceiling and the limiter has nothing left to do there:
// - a clip heard only around the place (a hit, a footstep) is turned down whole (update_layer volume);
// - a longer clip gets two Volume animations, "Peak down" in the PEAK_RAMP seconds before the span
//   and "Peak up" in the PEAK_RAMP seconds after it, back to the volume it had. The rest of the
//   clip keeps its level.
// A layer whose volume moves around the place (a fade or a duck ramp there) is left alone, with the
// reason, since a fixed level would flatten that move; so is one where another Volume animation
// would take over from the dip.
import { animatesVolume, volumeAt } from "./animation.js";
import { uid } from "./model.js";
import { mediaPlaybackRange } from "./playback.js";
import { audibleRanges } from "./videoSound.js";
import { round } from "./numbers.js";

export const PEAK_NAMES = Object.freeze({ down: "Peak down", up: "Peak up" });
// The ramps into and out of a dip (seconds): short, so only the peak's span changes, and long
// enough not to click (a guess; duck_audio's quick fade down is 0.15 s).
export const PEAK_RAMP = 0.05;
// A clip heard no further than this (seconds) outside the place's span is turned down whole.
const WHOLE_MARGIN = 0.3;
// The step (seconds) at which a layer's volume is read around a place.
const STEP = 0.01;

// The stretches of scene time in which the layer is heard.
function heardSpans(scene, layer) {
  if (layer.type === "video") return audibleRanges(scene.layers, layer, scene.duration);
  const range = mediaPlaybackRange(layer, scene.duration);
  return range ? [range] : [];
}

// True when the layer's volume stays at `level` (within 0.5%) from `start` to `end`.
function steady(layer, start, end, level) {
  for (let time = start; time <= end + 1e-9; time += STEP)
    if (Math.abs(volumeAt(layer, time) - level) > 0.001 + 0.005 * level) return false;
  return true;
}

/**
 * The changes that clear `places` ([{at, from, to, factor, playing: [{layerId, name}]}], measured
 * on `scene`'s mix) by turning each playing layer down by the place's factor over its span.
 * Returns {ops, layers, fixed, dropped}: agent edit ops, the changed layer copies by id (to measure
 * again without saving), one line per place changed and one per layer left alone.
 */
export function peakTrims(scene, places) {
  const layers = new Map();
  const whole = new Map();
  const added = new Map();
  const fixed = [];
  const dropped = [];
  const copyOf = (layer) => {
    if (!layers.has(layer.id)) layers.set(layer.id, { ...layer, animations: [...(layer.animations ?? [])] });
    return layers.get(layer.id);
  };
  for (const place of places) {
    if (!(place.factor > 0 && place.factor < 1)) continue;
    const ids = [...new Set((place.playing ?? []).map((clip) => clip.layerId).filter(Boolean))];
    const changed = [];
    for (const id of ids) {
      const original = scene.layers.find((layer) => layer.id === id);
      if (!original) continue;
      const layer = copyOf(original);
      const spans = heardSpans(scene, layer);
      // Heard only around this place: the whole clip comes down (no Volume animation to keep in shape).
      if (!animatesVolume(layer) && spans.length && spans.every((span) => span.start >= place.from - WHOLE_MARGIN && span.end <= place.to + WHOLE_MARGIN)) {
        layer.volume = round((layer.volume ?? 1) * place.factor);
        whole.set(id, layer.volume);
        changed.push(`${layer.name ?? id} ${layer.volume}`);
        continue;
      }
      const start = round(Math.max(0, place.from - PEAK_RAMP));
      const end = round(Math.min(scene.duration, place.to + PEAK_RAMP));
      const level = volumeAt(layer, start);
      if (!(level > 0)) continue;
      if (!steady(layer, start, end, level)) { dropped.push(`mix ${place.at} s ${layer.name ?? id}: its volume moves there (a fade or a dip): lower it by hand x${place.factor}`); continue; }
      const low = round(level * place.factor);
      const from = round(level);
      const dip = [{ id: uid(), name: PEAK_NAMES.down, kind: "custom", easing: "smooth", start, duration: Math.max(0.001, round(place.from - start)), from: { volume: from }, to: { volume: low } }];
      if (place.to < scene.duration - 0.001) dip.push({ id: uid(), name: PEAK_NAMES.up, kind: "custom", easing: "smooth", start: round(place.to), duration: Math.max(0.001, round(end - place.to)), from: { volume: low }, to: { volume: from } });
      const before = layer.animations;
      layer.animations = [...before, ...dip];
      // Another Volume animation that would take over inside the dip (or hold a value before it starts) leaves it alone.
      const holds = Math.abs(volumeAt(layer, place.at) - low) <= 0.002 && (end >= scene.duration - 0.001 || Math.abs(volumeAt(layer, end + STEP) - volumeAt({ ...layer, animations: before }, end + STEP)) <= 0.002);
      if (!holds) { layer.animations = before; dropped.push(`mix ${place.at} s ${layer.name ?? id}: another Volume animation takes over there: lower it by hand x${place.factor}`); continue; }
      if (!added.has(id)) added.set(id, []);
      added.get(id).push(...dip);
      changed.push(`${layer.name ?? id} ${from}->${low}`);
    }
    if (changed.length) fixed.push(`mix ${place.at} s (${place.from}-${place.to} s, ${place.overDb} dB over) x${place.factor}: ${changed.join(", ")}`);
  }
  const ops = [];
  for (const [id, volume] of whole) ops.push({ op: "update_layer", sceneId: scene.id, layerId: id, properties: { volume } });
  for (const [id, animations] of added)
    for (const { id: _id, ...animation } of animations) ops.push({ op: "add_animation", sceneId: scene.id, layerId: id, animation });
  for (const id of [...layers.keys()]) if (!whole.has(id) && !added.has(id)) layers.delete(id);
  return { ops, layers, fixed, dropped };
}
