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
// A layer whose volume moves around the place (a fade or a duck ramp there), or where another Volume
// animation would take over from a plain dip, gets a dip that follows its curve (followDip: its own
// volume times the dip, in short straight pieces until its moves there end), so the move keeps its
// shape and every other second keeps its level; when that cannot be built it is left alone, with the
// reason. A song or bed (`bed`) comes down whole (one constant gain, update_layer volume, which scales
// its Volume animations with it) only when the places it is lowered at cover most of its heard time
// (MOST_SHARE); otherwise its dips stay, and the line says the share.
import { animatesVolume, volumeAt } from "./animation.js";
import { enabledAnimations } from "./animationEnabled.js";
import { churnRun, isMusicLayer } from "./quality/rules/sound.js";
import { uid } from "./model.js";
import { mediaPlaybackRange } from "./playback.js";
import { audibleRanges } from "./videoSound.js";
import { round } from "./numbers.js";
import { keepLineStretches } from "./audioDucking.js";

export const PEAK_NAMES = Object.freeze({ down: "Peak down", hold: "Peak hold", up: "Peak up" });
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

// A dip that follows a moving volume reaches at most this far (seconds) past the place's ramp to
// end where the layer's own moves there end (a 6 s fade in fits), and has at most FOLLOW_PIECES pieces.
const FOLLOW_REACH = 10;
const FOLLOW_PIECES = 40;
// The grid (seconds) the followed curve is read at before straight pieces are merged.
const FOLLOW_GRID = STEP;
const volumeMoves = (layer) => enabledAnimations(layer.animations ?? []).filter((animation) =>
  Object.hasOwn(animation?.from ?? {}, "volume") || Object.hasOwn(animation?.to ?? {}, "volume"));

// The gain of one dip over `places` ([{from, to, factor}]) at `time`: down to each place's factor in
// the PEAK_RAMP before it, back up in the PEAK_RAMP after it. Over two or more places it is the
// highest valley under every place's factor (falls, then rises: one turn of the level), so the stretch
// between places holds the lower of its neighbors' levels instead of rising and falling again.
function dipGain(places, time) {
  const down = (place) => time >= place.from ? place.factor : time <= place.from - PEAK_RAMP ? 1 : 1 - (1 - place.factor) * (time - place.from + PEAK_RAMP) / PEAK_RAMP;
  const up = (place) => time <= place.to ? place.factor : time >= place.to + PEAK_RAMP ? 1 : place.factor + (1 - place.factor) * (time - place.to) / PEAK_RAMP;
  return Math.max(Math.min(...places.map(down)), Math.min(...places.map(up)));
}

// A linear Volume piece from or to 0 plays equal power (engine/animation.js isPowerFade): its value
// at `share` (0 to 1) of the way, as volumeAt reads it.
const pieceAt = (a, b, share) => a === b ? a : a === 0 ? b * Math.sin(share * Math.PI / 2) : b === 0 ? a * Math.cos(share * Math.PI / 2) : a + (b - a) * share;

/**
 * A dip on a layer whose volume moves at the place: Volume animations in straight pieces that give
 * its own volume times the dip's gain (dipGain over `places`, one place or several bridged), from
 * the first ramp's start until no Volume animation of its own is in progress, so after the last
 * piece the layer plays exactly as before. Pieces are merged while a piece stays within 2% (0.17 dB)
 * of the curve. Returns the animations (without ids), or null when the curve cannot be followed that
 * way (its moves run past FOLLOW_REACH, more than FOLLOW_PIECES pieces, or the result strays more
 * than 3% from the curve anywhere).
 */
export function followDip(layer, places, duration) {
  const first = Math.min(...places.map((place) => place.from));
  const last = Math.max(...places.map((place) => place.to));
  const start = round(Math.max(0, first - PEAK_RAMP));
  const rampEnd = Math.min(duration, last + PEAK_RAMP);
  const moves = volumeMoves(layer);
  const busy = (time) => moves.some((animation) => animation.start < time - 1e-6 && animation.start + animation.duration > time + 1e-6);
  let end = rampEnd;
  while (end < duration && busy(end) && end <= rampEnd + FOLLOW_REACH) end = round(end + STEP, 3);
  if (busy(end) && end < duration) return null;
  end = round(end, 3);
  const gain = (time) => time <= start || time >= rampEnd ? 1 : dipGain(places, time);
  const target = (time) => volumeAt(layer, time) * gain(time);
  // The knots: a fine grid plus each place's edges and ramps and every own move's start and end inside.
  const knots = new Set([start, round(rampEnd, 3), end]);
  for (const place of places) for (const time of [place.from - PEAK_RAMP, place.from, place.to, place.to + PEAK_RAMP])
    if (time > start && time < end) knots.add(round(time, 3));
  for (let time = start; time < end; time += FOLLOW_GRID) knots.add(round(time, 3));
  for (const animation of moves) for (const time of [animation.start + animation.duration])
    if (time > start && time < end) knots.add(round(time, 3));
  // A piece starts at each own move that starts inside: a move that started after a piece would take
  // over from it (the one that started last sets the value; on a tie the piece, added later, wins).
  const starts = new Set(moves.map((animation) => animation.start).filter((time) => time > start && time < end));
  for (const time of starts) knots.add(time);
  const times = [...knots].filter((time) => time >= start && time <= end).sort((a, b) => a - b);
  // Merge pieces while the piece from the last kept knot (as it plays, rounded) stays within 2% of the curve.
  const kept = [times[0]];
  for (let index = 1; index < times.length - 1; index += 1) {
    const from = kept.at(-1), next = times[index + 1];
    const a = round(target(from), 3), b = round(target(next), 3);
    const fits = times.slice(times.indexOf(from) + 1, index + 2).every((time) =>
      Math.abs(pieceAt(a, b, (time - from) / (next - from)) - target(time)) <= 0.001 + 0.02 * target(time));
    if (!fits || starts.has(times[index])) kept.push(times[index]);
  }
  kept.push(times.at(-1));
  if (kept.length - 1 > FOLLOW_PIECES) return null;
  const pieces = [];
  for (let index = 1; index < kept.length; index += 1) {
    const from = kept[index - 1], to = kept[index];
    const name = to <= first + 1e-6 ? PEAK_NAMES.down : from >= last - 1e-6 ? PEAK_NAMES.up : PEAK_NAMES.hold;
    pieces.push({ name, kind: "custom", easing: "linear", start: from, duration: Math.max(0.001, round(to - from, 3)),
      from: { volume: round(target(from), 3) }, to: { volume: round(target(to), 3) } });
  }
  // The result read back: within 3% (and 0.003) of the curve from the ramp's start to 0.2 s after the end.
  const result = { ...layer, animations: [...(layer.animations ?? []), ...pieces.map((piece, index) => ({ ...piece, id: `follow-${index}` }))] };
  for (let time = start; time <= Math.min(duration, end + 0.2); time += STEP)
    if (Math.abs(volumeAt(result, time) - target(time)) > 0.003 + 0.03 * target(time)) return null;
  return pieces;
}

/**
 * A song or bed whose dips would make its level churn (volume_churn) where it did not before: the
 * dips nearest each other are bridged into one (dipGain over their places), the shortest gap first,
 * until its level no longer churns. Returns {layer, pieces, groups} (groups: the places of each dip),
 * or null when even one dip over every place churns, or a dip cannot follow its curve.
 */
function bridgeDips(scene, original, entries) {
  let groups = [...entries].sort((a, b) => a.place.from - b.place.from).map((entry) => [entry]);
  for (;;) {
    const layer = { ...original, animations: [...(original.animations ?? [])] };
    const pieces = [];
    for (const group of groups) {
      const made = followDip(layer, group.map(({ place, factor }) => ({ from: place.from, to: place.to, factor })), scene.duration);
      if (!made) return null;
      const dip = made.map((piece) => ({ id: uid(), ...piece }));
      layer.animations.push(...dip);
      pieces.push(...dip);
    }
    if (!churnRun(layer, scene)) return { layer, pieces, groups };
    if (groups.length < 2) return null;
    let join = 0;
    for (let index = 1; index < groups.length - 1; index += 1)
      if (groups[index + 1][0].place.from - groups[index].at(-1).place.to < groups[join + 1][0].place.from - groups[join].at(-1).place.to) join = index;
    groups = [...groups.slice(0, join), [...groups[join], ...groups[join + 1]], ...groups.slice(join + 2)];
  }
}

// A song or bed comes down whole only when its places cover more than this share of its heard time.
const MOST_SHARE = 0.5;
// The share of the layer's heard time that `places` (with their PEAK_RAMP each side) cover, 0 to 1.
function placeShare(scene, layer, places) {
  const spans = heardSpans(scene, layer);
  const heard = spans.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
  if (!(heard > 0)) return 0;
  const cover = places.map((place) => [place.from - PEAK_RAMP, place.to + PEAK_RAMP]).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const span of spans) {
    let reach = span.start;
    for (const [from, to] of cover) {
      const low = Math.max(from, reach), high = Math.min(to, span.end);
      if (high > low) { covered += high - low; reach = high; }
    }
  }
  return Math.min(1, covered / heard);
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
 * The trim at `place` taken from the layers other than `spared` (keep_line's leveled lines): the
 * loudest first (within 1 dB, a placed sound or a clip before a song or bed). With each layer's own peak measured alone, as few as clear the
 * place; no peaks measured leaves them all at the place's xN.
 * The factor is their share of the measured peak, (ceiling - rest) / (mix - rest), as peakCauses
 * takes it, the rest the layers left playing summed in phase (exact for one layer). No layer goes
 * under MIN_CAUSE_FACTOR: when the kept line alone holds the peak over the ceiling even then, the
 * others stop there and `left` gives the dB still over (in phase) and `line`, the factor on the kept
 * line that would clear it (a song cut to x0.14, or whole when its volume moved there, was the price).
 * Returns {causes: Map layerId -> factor (empty when only spared layers play there), left?, line?}.
 */
function sparedCauses(scene, place, spared, bed) {
  const peaks = new Map();
  for (const clip of place.playing ?? []) if (clip.layerId && !peaks.has(clip.layerId)) peaks.set(clip.layerId, clip.peakDbfs);
  const isBed = (id) => { const layer = scene.layers.find((item) => item.id === id); return layer ? bed(layer) : false; };
  // The loudest cause first; within 1 dB, a placed sound or a clip before a song or bed.
  const others = [...peaks.keys()].filter((id) => !spared.has(id)).sort((a, b) => {
    const gap = (peaks.get(b) ?? -Infinity) - (peaks.get(a) ?? -Infinity);
    return Math.abs(gap) <= 1 ? Number(isBed(a)) - Number(isBed(b)) || gap : gap;
  });
  if (!others.length) return { causes: new Map() };
  const all = (factor) => new Map(others.map((id) => [id, factor]));
  if (![...peaks.values()].every(Number.isFinite) || !Number.isFinite(place.peakDbtp)) return { causes: all(place.factor) };
  const mix = linear(place.peakDbtp);
  const target = mix * place.factor;
  const sum = (ids) => ids.reduce((total, id) => total + linear(peaks.get(id)), 0);
  for (let count = 1; count <= others.length; count += 1) {
    const cut = others.slice(0, count);
    const rest = sum([...peaks.keys()].filter((id) => !cut.includes(id)));
    if (!(mix - rest > 0)) continue;
    const factor = Math.floor(100 * (target - rest) / (mix - rest)) / 100;
    if (factor >= MIN_CAUSE_FACTOR) return { causes: new Map(cut.map((id) => [id, Math.min(factor, 1)])) };
  }
  // Every other layer at MIN_CAUSE_FACTOR, the kept line as it is: what stays over the ceiling.
  const kept = sum([...spared.keys()].filter((id) => peaks.has(id)));
  const lowered = Math.max(0, mix - kept) * MIN_CAUSE_FACTOR;
  const left = round(20 * Math.log10(Math.max(1e-9, kept + lowered) / target), 1);
  if (!(left > 0)) return { causes: all(MIN_CAUSE_FACTOR) };
  // Only songs or beds besides the kept line, and even at x0.3 the place stays over: they keep their
  // level (a cut that does not clear it, and that would size a whole-song cut), and `line` is the
  // kept line's factor that clears it with them as they are (in phase).
  if (others.every(isBed)) {
    const line = kept > 0 ? Math.floor(100 * (target - sum(others)) / kept) / 100 : 0;
    return { causes: new Map(), left, keep: true, ...(line > 0 && line < 1 ? { line } : {}) };
  }
  const line = kept > 0 ? Math.floor(100 * (target - lowered) / kept) / 100 : 0;
  return { causes: all(MIN_CAUSE_FACTOR), left, ...(line > 0 && line < 1 ? { line } : {}) };
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
    const sparing = spared.size ? sparedCauses(scene, place, spared, bed) : null;
    const causes = sparing ? sparing.causes : peakCauses(place);
    if (sparing?.left) {
      const lines = [...spared.keys()].map((id) => scene.layers.find((layer) => layer.id === id)?.name ?? id).join(", ");
      dropped.push(sparing.keep
        ? `mix ${place.at} s: with ${lines} at the level keep_line set, ${[...new Set(place.playing.map((clip) => clip.layerId))].filter((id) => !spared.has(id)).map((id) => scene.layers.find((layer) => layer.id === id)?.name ?? id).join(", ")} even at x${MIN_CAUSE_FACTOR} would leave about ${sparing.left} dB over for the limiter (each layer's peak alone, summed in phase), so it keeps its level` +
          (sparing.line ? `; volume x${sparing.line} on ${lines} there clears it` : "")
        : `mix ${place.at} s: the others come down to x${MIN_CAUSE_FACTOR} at most, so with ${lines} at the level keep_line set about ${sparing.left} dB stays over for the limiter (each layer's peak alone, summed in phase)` +
          (sparing.line ? `; volume x${sparing.line} on ${lines} clears it` : ""));
    }
    const ids = causes ? [...causes.keys()] : [...new Set((place.playing ?? []).map((clip) => clip.layerId).filter(Boolean))];
    const ownPeak = (id) => place.playing.find((clip) => clip.layerId === id)?.peakDbfs;
    const kept = causes ? [...new Set(place.playing.map((clip) => clip.layerId))].filter((id) => !causes.has(id))
      .map((id) => `${scene.layers.find((layer) => layer.id === id)?.name ?? id} ${spared.has(id) ? `at the level keep_line set (line ${spared.get(id)} s)` : `(alone ${ownPeak(id)} dBFS)`}`) : [];
    if (spared.size && !ids.length && !sparing?.left) dropped.push(`mix ${place.at} s: only the line keep_line leveled plays there; lower it by hand x${place.factor}`);
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
      // Its volume moves there, or another Volume animation would take over from a plain dip: a dip
      // that follows its curve; when none can be built, a song or bed may come down whole (below).
      const follow = (why, text) => {
        const pieces = followDip(layer, [{ from: place.from, to: place.to, factor }], scene.duration);
        if (!pieces) {
          if (bed(original)) needWhole(id, place, factor, why);
          else dropped.push(`mix ${place.at} s ${layer.name ?? id}: ${text}: lower it by hand x${factor}`);
          return;
        }
        const dip = pieces.map((piece) => ({ id: uid(), ...piece }));
        layer.animations = [...layer.animations, ...dip];
        if (!added.has(id)) added.set(id, []);
        added.get(id).push(...dip);
        const last = dip.at(-1);
        changed.push([id, `${layer.name ?? id}${tag || ` x${factor}`} ${round(volumeAt(original, place.at))}->${round(volumeAt(layer, place.at))} following its moving volume (${dip.length} pieces ${start}-${round(last.start + last.duration)} s)${alone}`, factor]);
      };
      if (!(level > 0) && !(volumeAt(layer, place.at) > 0)) continue;
      if (!(level > 0) || !steady(layer, start, end, level)) {
        follow(`its volume moves at ${place.at} s`, "its volume moves there (a fade or a dip)");
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
        follow(`another Volume animation takes over at ${place.at} s`, "another Volume animation takes over there");
        continue;
      }
      if (!added.has(id)) added.set(id, []);
      added.get(id).push(...dip);
      changed.push([id, `${layer.name ?? id}${tag} ${from}->${low}${alone}`, factor]);
    }
    changes.push({ place, changed, kept, causes });
  }
  // A song or bed that did not churn before but would with its dips: the nearest dips are bridged
  // into one until it does not (bridgeDips); when even that churns, it comes down whole (below).
  const bridged = [];
  for (const id of [...added.keys()]) {
    const original = scene.layers.find((layer) => layer.id === id);
    if (!bed(original) || churnRun(original, scene)) continue;
    const turns = churnRun(layers.get(id), scene);
    if (!turns) continue;
    const entries = changes.flatMap(({ place, changed }) => changed.filter(([layerId]) => layerId === id).map(([, , factor]) => ({ place, factor })));
    const why = `${entries.length} dips would turn its level ${turns.length} times in ${round(turns.at(-1).time - turns[0].time)} s (volume_churn)`;
    const share = placeShare(scene, original, entries.map(({ place }) => place));
    let bridge = share > MOST_SHARE ? null : bridgeDips(scene, original, entries);
    // Under the share, a song whose dips churn even as one keeps its level outside the places it can
    // dip without churning: the places most over first, each kept when the dips still do not churn;
    // the others are named under "not applied" with its factor there (never whole).
    if (!bridge && share <= MOST_SHARE) {
      let chosen = [];
      for (const entry of [...entries].sort((a, b) => b.place.overDb - a.place.overDb)) {
        const tried = bridgeDips(scene, original, [...chosen, entry]);
        if (tried) { chosen = [...chosen, entry]; bridge = tried; }
      }
      const left = entries.filter((entry) => !chosen.includes(entry));
      for (const entry of changes) entry.changed = entry.changed.filter((change) => change[0] !== id || chosen.some((item) => item.place === entry.place));
      for (const { place, factor } of left) dropped.push(`mix ${place.at} s ${original.name ?? id}: a dip here too would turn its level often enough to churn (volume_churn), and its places cover ${Math.round(100 * share)}% of its heard time, so it keeps its level here (not whole): lower it x${factor} there by hand, or let the limiter take it`);
      if (!bridge) { added.delete(id); layers.delete(id); continue; }
      entries.splice(0, entries.length, ...chosen);
    }
    if (!bridge) { needWhole(id, null, null, share > MOST_SHARE ? why : `${why}, and so would one dip over them all`); continue; }
    layers.get(id).animations = bridge.layer.animations;
    added.set(id, bridge.pieces);
    const name = original.name ?? id;
    for (const group of bridge.groups) {
      const span = `${round(Math.max(0, group[0].place.from - PEAK_RAMP))}-${round(Math.min(scene.duration, group.at(-1).place.to + PEAK_RAMP))} s`;
      for (const { place, factor } of group) {
        const entry = changes.find((item) => item.place === place);
        const own = place.playing?.find((clip) => clip.layerId === id)?.peakDbfs;
        entry.changed = entry.changed.map((change) => change[0] !== id ? change : [id,
          `${name} x${factor} ${round(volumeAt(original, place.at))}->${round(volumeAt(bridge.layer, place.at))} in one dip ${span}${group.length > 1 ? ` over ${group.length} places` : ""}${entry.causes && Number.isFinite(own) ? ` (alone ${own} dBFS)` : ""}`, factor]);
      }
    }
    bridged.push(`mix ${name}: ${entries.length} places in ${bridge.groups.length} ${bridge.groups.length === 1 ? "dip" : "dips"}, not whole: ${why}, so the nearest are one dip and its level does not churn; its places cover ${Math.round(100 * share)}% of its heard time (whole past ${100 * MOST_SHARE}%)`);
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
    // Whole only when its places cover most of its heard time; else its dips stay and the rest is named.
    const share = placeShare(scene, original, all.map(({ place }) => place));
    const shareText = `${Math.round(100 * share)}% of its heard time`;
    // Dips that would churn even as one come down whole whatever the share (no volume_churn left behind).
    if (share <= MOST_SHARE && !need.why.some((why) => why.includes("volume_churn"))) {
      if (dipped.length) fixed.push(`mix ${name}: dips at ${dipped.length} ${dipped.length === 1 ? "place" : "places"} only, not whole: its places cover ${shareText} (whole past ${100 * MOST_SHARE}%)` +
        (need.places.length ? "" : `; ${need.why.join("; ")}`));
      for (const { place, factor } of need.places)
        dropped.push(`mix ${place.at} s ${name}: ${need.why.filter((why) => !why.includes("volume_churn")).join("; ")}, and no dip follows it there; its places cover ${shareText}, so it is not lowered whole: lower it by hand x${factor} there`);
      continue;
    }
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
    wholeFixed.push(`mix ${name} x${worst.factor} whole ${round(from)}->${layer.volume}: one constant gain, sized from the ${worst.place.at} s place (the lowest factor of ${all.length}${peak}); its places cover ${shareText}; place by place, ${need.why.join("; ")}`);
  }
  changes.sort((a, b) => a.place.at - b.place.at);
  // Per place changed: its span, peak and the layers turned down with their factor (describeMixFix).
  const trimmed = [];
  fixed.push(...bridged, ...wholeFixed);
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
