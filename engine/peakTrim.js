// The mix's limiter places turned down where they happen (check {fix:"auto"}). Each place the
// "mix:" line names (backend/audio-levels.mjs limiterPlaces: its span, its xN factor and the layers
// playing there) multiplies those layers' volumes by its factor, so the summed peak lands on the
// limiter's ceiling and the limiter has nothing left to do there:
// - a clip heard only around the place (a hit, a footstep) is turned down whole (update_layer volume);
// - a longer clip gets two Volume animations, "Peak down" in the PEAK_RAMP seconds before the span
//   and "Peak up" in the PEAK_RAMP seconds after it, back to the volume it had. The rest of the
//   clip keeps its level.
// When each layer's own peak at the place was measured alone (playing[].peakDbfs), only the loudest
// layers that can clear it come down, each by its own factor (peakCauses); the others keep their level.
// A layer whose volume moves around the place (a fade or a duck ramp there) is left alone, with the
// reason, since a fixed level would flatten that move; so is one where another Volume animation
// would take over from the dip. A song or bed (`bed`) that cannot dip there (its volume moves, or
// its dips would make its level turn 3 times in 10 s: the volume_churn warning) comes down whole
// instead, by the lowest factor its places need: one constant gain, which neither churns nor
// flattens a fade (update_layer volume scales its Volume animations with it).
import { animatesVolume, volumeAt } from "./animation.js";
import { churnRun, isMusicLayer } from "./quality/rules/sound.js";
import { uid } from "./model.js";
import { mediaPlaybackRange } from "./playback.js";
import { audibleRanges } from "./videoSound.js";
import { round } from "./numbers.js";
import { keepLineStretches } from "./audioDucking.js";

export const PEAK_NAMES = Object.freeze({ down: "Peak down", up: "Peak up" });
// The ramps into and out of a dip (seconds): short, so only the peak's span changes, and long
// enough not to click. Measured on a -6 dB dip with the smooth easing sampled at 1000 Hz: a 1 kHz
// tone spreads energy outside 800-1200 Hz at -31 dB under the tone with a 1 ms step, -51 dB at
// 0.02 s, -70 dB at 0.05 s and -90 dB at 0.1 s; pink noise shows no high-band excess at any of
// them (0.06 dB or less per 2 ms frame).
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

// The lowest factor that turns down only the loudest layers at a place (about -10 dB): a layer that
// would need more than this to clear the place alone shares the cut with the next loudest.
const MIN_CAUSE_FACTOR = 0.3;
const linear = (db) => 10 ** (db / 20);

/**
 * Which layers make a place's peak, from each one's own peak there (playing[].peakDbfs, measured
 * alone): the loudest ones, as few as can clear the place, each by its own factor. The factor is
 * their measured share of the place's peak, (ceiling - rest) / (mix - rest), where rest is the mix
 * without them: measured with them left out (place.restDbfs[count - 1], measureMixPeaks perLayer),
 * or the one layer left, alone. Only without either are the others counted at their own peak, all
 * summed in phase (the worst case: the cut layer comes down more than needed over real music).
 * Returns Map layerId -> factor, or null (no per-layer peaks, or every layer is needed: the place's
 * xN on all of them).
 */
export function peakCauses(place) {
  const own = new Map();
  for (const clip of place.playing ?? []) if (clip.layerId && !own.has(clip.layerId)) own.set(clip.layerId, clip.peakDbfs);
  if (own.size < 2 || [...own.values()].some((peak) => !Number.isFinite(peak)) || !Number.isFinite(place.peakDbtp)) return null;
  const mix = linear(place.peakDbtp);
  const target = mix * place.factor;
  const sorted = [...own].sort((a, b) => b[1] - a[1]);
  for (let count = 1; count < sorted.length; count += 1) {
    const measured = count === sorted.length - 1 ? sorted.at(-1)[1] : place.restDbfs?.[count - 1];
    let factor;
    if (measured === null || Number.isFinite(measured)) {
      // null: the rest is silent there.
      const rest = measured === null ? 0 : linear(measured);
      if (!(mix - rest > 0)) continue;
      factor = (target - rest) / (mix - rest);
    } else {
      const cut = sorted.slice(0, count).reduce((sum, [, peak]) => sum + linear(peak), 0);
      const rest = sorted.slice(count).reduce((sum, [, peak]) => sum + linear(peak), 0);
      factor = (target - rest) / cut;
    }
    factor = Math.floor(100 * factor) / 100;
    if (factor >= MIN_CAUSE_FACTOR) return new Map(sorted.slice(0, count).map(([id]) => [id, Math.min(factor, 1)]));
  }
  return null;
}

// The layers playing at `place` whose line keep_line leveled (voiceLevel) and kept there: Map id -> "a-b".
function keptLinesAt(scene, place) {
  const spared = new Map();
  for (const id of new Set((place.playing ?? []).map((clip) => clip.layerId).filter(Boolean))) {
    const layer = scene.layers.find((item) => item.id === id);
    if (!layer || !Number.isFinite(layer.voiceLevel)) continue;
    const line = keepLineStretches(layer).find((stretch) => stretch.start < place.to && stretch.end > place.from);
    if (line) spared.set(id, `${round(line.start, 2)}-${round(Math.min(line.end, scene.duration), 2)}`);
  }
  return spared;
}

/**
 * The trim at `place` taken from the layers other than `spared` (keep_line's leveled lines): songs
 * and beds first, then the loudest. With each layer's own peak measured alone, as few as clear the
 * place; the spared line alone over the ceiling, or no peaks measured, leaves them all at the place's xN.
 * The factor is their share of the measured peak, (ceiling - rest) / (mix - rest), as peakCauses
 * takes it, the rest the layers left playing summed in phase (exact for one layer).
 * Returns Map layerId -> factor (empty when only spared layers play there).
 */
function sparedCauses(scene, place, spared, bed) {
  const peaks = new Map();
  for (const clip of place.playing ?? []) if (clip.layerId && !peaks.has(clip.layerId)) peaks.set(clip.layerId, clip.peakDbfs);
  const isBed = (id) => { const layer = scene.layers.find((item) => item.id === id); return layer ? bed(layer) : false; };
  const others = [...peaks.keys()].filter((id) => !spared.has(id))
    .sort((a, b) => Number(isBed(b)) - Number(isBed(a)) || (peaks.get(b) ?? -Infinity) - (peaks.get(a) ?? -Infinity));
  if (!others.length) return new Map();
  const all = (factor) => new Map(others.map((id) => [id, factor]));
  if (![...peaks.values()].every(Number.isFinite) || !Number.isFinite(place.peakDbtp)) return all(place.factor);
  const mix = linear(place.peakDbtp);
  const target = mix * place.factor;
  const sum = (ids) => ids.reduce((total, id) => total + linear(peaks.get(id)), 0);
  for (let count = 1; count <= others.length; count += 1) {
    const cut = others.slice(0, count);
    const rest = sum([...peaks.keys()].filter((id) => !cut.includes(id)));
    if (!(mix - rest > 0)) continue;
    const factor = Math.floor(100 * (target - rest) / (mix - rest)) / 100;
    if (factor >= MIN_CAUSE_FACTOR || (count === others.length && factor > 0)) return new Map(cut.map((id) => [id, Math.min(factor, 1)]));
  }
  return all(place.factor);
}

/**
 * The changes that clear `places` ([{at, from, to, factor, playing: [{layerId, name}]}], measured
 * on `scene`'s mix) by turning each playing layer down by the place's factor over its span.
 * Returns {ops, layers, fixed, dropped}: agent edit ops, the changed layer copies by id (to measure
 * again without saving), one line per place changed and one per layer left alone. `bed(layer)`
 * says whether a layer is a song or bed (volume_churn reads those); by default isMusicLayer.
 */
export function peakTrims(scene, places, { bed = (layer) => isMusicLayer(layer, scene) } = {}) {
  const layers = new Map();
  const whole = new Map();
  const added = new Map();
  // Per place, [layerId, text] for each layer changed there; the lines are written at the end.
  const changes = [];
  const fixed = [];
  const dropped = [];
  // Songs and beds that come down whole instead of dipping: id -> {places: [{place, factor}], why: [text]}.
  const wholeNeeds = new Map();
  const wholeFixed = [];
  const needWhole = (id, place, factor, why) => {
    if (!wholeNeeds.has(id)) wholeNeeds.set(id, { places: [], why: [] });
    const need = wholeNeeds.get(id);
    if (place) need.places.push({ place, factor });
    if (!need.why.includes(why)) need.why.push(why);
  };
  const copyOf = (layer) => {
    if (!layers.has(layer.id)) layers.set(layer.id, { ...layer, animations: [...(layer.animations ?? [])] });
    return layers.get(layer.id);
  };
  for (const place of places) {
    if (!(place.factor > 0 && place.factor < 1)) continue;
    // A line keep_line leveled here keeps that level: the trim comes from the others (sparedCauses).
    const spared = keptLinesAt(scene, place);
    // Measured alone, the layers that make the peak come down by their own factor; the rest keep their level.
    const causes = spared.size ? sparedCauses(scene, place, spared, bed) : peakCauses(place);
    const ids = causes ? [...causes.keys()] : [...new Set((place.playing ?? []).map((clip) => clip.layerId).filter(Boolean))];
    const ownPeak = (id) => place.playing.find((clip) => clip.layerId === id)?.peakDbfs;
    const kept = causes ? [...new Set(place.playing.map((clip) => clip.layerId))].filter((id) => !causes.has(id))
      .map((id) => `${scene.layers.find((layer) => layer.id === id)?.name ?? id} ${spared.has(id) ? `at the level keep_line set (line ${spared.get(id)} s)` : `(alone ${ownPeak(id)} dBFS)`}`) : [];
    if (spared.size && !ids.length) dropped.push(`mix ${place.at} s: only the line keep_line leveled plays there; lower it by hand x${place.factor}`);
    const changed = [];
    for (const id of ids) {
      const original = scene.layers.find((layer) => layer.id === id);
      if (!original) continue;
      const factor = causes?.get(id) ?? place.factor;
      if (!(factor < 1)) continue;
      const tag = causes ? ` x${factor}` : "";
      const alone = causes && Number.isFinite(ownPeak(id)) ? ` (alone ${ownPeak(id)} dBFS)` : "";
      const layer = copyOf(original);
      const spans = heardSpans(scene, layer);
      // Heard only around this place: the whole clip comes down (no Volume animation to keep in shape).
      if (!animatesVolume(layer) && spans.length && spans.every((span) => span.start >= place.from - WHOLE_MARGIN && span.end <= place.to + WHOLE_MARGIN)) {
        const from = layer.volume ?? 1;
        layer.volume = round(from * factor);
        whole.set(id, layer.volume);
        changed.push([id, causes ? `${layer.name ?? id}${tag} ${round(from)}->${layer.volume}${alone}` : `${layer.name ?? id} ${layer.volume}`, factor]);
        continue;
      }
      const start = round(Math.max(0, place.from - PEAK_RAMP));
      const end = round(Math.min(scene.duration, place.to + PEAK_RAMP));
      const level = volumeAt(layer, start);
      if (!(level > 0)) continue;
      if (!steady(layer, start, end, level)) {
        // A song or bed comes down whole instead (below): a constant gain keeps the fade's shape.
        if (bed(original)) needWhole(id, place, factor, `its volume moves at ${place.at} s`);
        else dropped.push(`mix ${place.at} s ${layer.name ?? id}: its volume moves there (a fade or a dip): lower it by hand x${factor}`);
        continue;
      }
      const low = round(level * factor);
      const from = round(level);
      const dip = [{ id: uid(), name: PEAK_NAMES.down, kind: "custom", easing: "smooth", start, duration: Math.max(0.001, round(place.from - start)), from: { volume: from }, to: { volume: low } }];
      if (place.to < scene.duration - 0.001) dip.push({ id: uid(), name: PEAK_NAMES.up, kind: "custom", easing: "smooth", start: round(place.to), duration: Math.max(0.001, round(end - place.to)), from: { volume: low }, to: { volume: from } });
      const before = layer.animations;
      layer.animations = [...before, ...dip];
      // Another Volume animation that would take over inside the dip (or hold a value before it starts) leaves it alone.
      const holds = Math.abs(volumeAt(layer, place.at) - low) <= 0.002 && (end >= scene.duration - 0.001 || Math.abs(volumeAt(layer, end + STEP) - volumeAt({ ...layer, animations: before }, end + STEP)) <= 0.002);
      if (!holds) {
        layer.animations = before;
        if (bed(original)) needWhole(id, place, factor, `another Volume animation takes over at ${place.at} s`);
        else dropped.push(`mix ${place.at} s ${layer.name ?? id}: another Volume animation takes over there: lower it by hand x${factor}`);
        continue;
      }
      if (!added.has(id)) added.set(id, []);
      added.get(id).push(...dip);
      changed.push([id, `${layer.name ?? id}${tag} ${from}->${low}${alone}`, factor]);
    }
    changes.push({ place, changed, kept, causes });
  }
  // A song or bed that did not churn before but would with its dips does not dip either.
  for (const id of [...added.keys()]) {
    const original = scene.layers.find((layer) => layer.id === id);
    if (!bed(original) || churnRun(original, scene)) continue;
    const turns = churnRun(layers.get(id), scene);
    if (!turns) continue;
    const dips = changes.filter(({ changed }) => changed.some(([layerId]) => layerId === id)).length;
    needWhole(id, null, null, `${dips} dips would turn its level ${turns.length} times in ${round(turns.at(-1).time - turns[0].time)} s (volume_churn)`);
  }
  // Each song or bed that cannot dip place by place comes down whole: one constant gain (no churn,
  // and its fades and ducks keep their shape), the lowest factor any of its places needs, so every
  // place it plays in clears as far as it can. Its dips at the other places are taken back.
  for (const [id, need] of wholeNeeds) {
    const original = scene.layers.find((layer) => layer.id === id);
    const name = original.name ?? id;
    const dipped = changes.flatMap(({ place, changed }) => changed.filter(([layerId]) => layerId === id).map(([, , factor]) => ({ place, factor })));
    const all = [...dipped, ...need.places];
    const worst = all.reduce((low, entry) => (!low || entry.factor < low.factor ? entry : low), null);
    const from = original.volume ?? 1;
    // A constant gain through update_layer volume scales its Volume animations only when one goes
    // to or from its volume (engine/operations.js carryVolume); otherwise it is lowered by hand.
    const scales = !animatesVolume(original) || (original.animations ?? []).some((animation) =>
      ["from", "to"].some((side) => typeof animation?.[side]?.volume === "number" && Math.abs(animation[side].volume - from) < 1e-3));
    const at = all.map(({ place, factor }) => `${place.at} s x${factor}`).join(", ");
    if (!scales) {
      added.delete(id);
      for (const entry of changes) entry.changed = entry.changed.filter(([layerId]) => layerId !== id);
      dropped.push(`mix ${at} ${name}: ${need.why.join("; ")}, and its Volume animations do not start or end at its volume ${round(from)}: lower it by hand x${worst.factor}`);
      continue;
    }
    added.delete(id);
    const layer = copyOf(original);
    layer.volume = round(from * worst.factor);
    layer.animations = (original.animations ?? []).map((animation) => {
      const copy = { ...animation };
      for (const side of ["from", "to"]) if (typeof animation?.[side]?.volume === "number") copy[side] = { ...animation[side], volume: round(animation[side].volume * worst.factor) };
      return copy;
    });
    whole.set(id, layer.volume);
    const text = `${name} x${worst.factor} whole ${round(from)}->${layer.volume}`;
    for (const entry of changes) entry.changed = entry.changed.filter(([layerId]) => layerId !== id);
    for (const { place } of all) {
      let entry = changes.find((item) => item.place === place);
      if (!entry) changes.push(entry = { place, changed: [], kept: [], causes: null });
      entry.changed.push([id, text, worst.factor, true]);
    }
    const peak = Number.isFinite(worst.place.peakDbtp) ? `, ${worst.place.peakDbtp >= 0 ? "+" : ""}${worst.place.peakDbtp} dBTP` : "";
    wholeFixed.push(`mix ${name} x${worst.factor} whole ${round(from)}->${layer.volume}: one constant gain, sized from the ${worst.place.at} s place (the lowest factor of ${all.length}${peak}); place by place, ${need.why.join("; ")}`);
  }
  changes.sort((a, b) => a.place.at - b.place.at);
  // Per place changed: its span, peak and the layers turned down with their factor (describeMixFix).
  const trimmed = [];
  fixed.push(...wholeFixed);
  for (const { place, changed, kept, causes } of changes) {
    if (!changed.length) continue;
    const head = `mix ${place.at} s (${place.from}-${place.to} s, ${place.overDb} dB over)`;
    fixed.push(causes ? `${head}: ${changed.map(([, text]) => text).join(", ")}${kept.length ? `; kept ${kept.join(", ")}` : ""}`
      // The place's xN only when a layer took it (a whole song names its own factor).
      : `${head}${changed.some(([, , , isWhole]) => !isWhole) ? ` x${place.factor}` : ""}: ${changed.map(([, text]) => text).join(", ")}`);
    trimmed.push({ at: place.at, from: place.from, to: place.to, peakDbtp: place.peakDbtp,
      layers: changed.map(([id, , factor, isWhole]) => ({ name: scene.layers.find((layer) => layer.id === id)?.name ?? id, factor, ...(isWhole ? { whole: true } : {}) })) });
  }
  const ops = [];
  for (const [id, volume] of whole) ops.push({ op: "update_layer", sceneId: scene.id, layerId: id, properties: { volume } });
  for (const [id, animations] of added)
    for (const { id: _id, ...animation } of animations) ops.push({ op: "add_animation", sceneId: scene.id, layerId: id, animation });
  for (const id of [...layers.keys()]) if (!whole.has(id) && !added.has(id)) layers.delete(id);
  return { ops, layers, fixed, dropped, trimmed };
}
