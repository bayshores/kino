// The song's events (its saved onsets with their weights, its beats and bar lines, in scene
// seconds) used two ways: the hits around the video's end, each with the one call that ends the
// video on it (check's ending line), and moving the picture cuts of a span onto the nearest strong
// events (retime {snap:"song"}). Each moved cut keeps every layer's file time at every scene time,
// so the pictures do not jump: the shot before it plays on (or stops sooner), the shot after it
// starts later (or sooner) from the matching file second.
import { isVisibilityOperation } from "./visibilityOps.js";
import { keptLinesOf } from "./mixReadout.js";

/** An onset this heavy (0 to 1, detect_beats' weight against the song's hardest hits) is strong: a starting guess. */
export const STRONG_WEIGHT = 0.5;
/** The hits named around the end: this many seconds either side of it. */
export const HIT_SPAN = 2;
// An onset this close to a bar line is on it.
const ON_LINE = 0.06;
// fit_music's ring (engine/fitMusic.js): the hit plays at full for RING_HOLD, then decays quart-out
// over RING_MIN to RING_MAX seconds to the end.
export const RING_HOLD = 0.04;
export const RING_MIN = 0.3;
export const RING_MAX = 1.2;
// The shortest shot a moved cut leaves (two frames at 30 fps).
const MIN_SHOT = 0.067;
const EDGE = 0.002;
const r2 = (value) => Math.round(value * 100) / 100;
const r3 = (value) => Math.round(value * 1000) / 1000;

/** The bar or phrase line an onset sits on ("bar line", "phrase line") or null. */
function lineAt(grid, at) {
  const line = (grid?.bars ?? []).find((bar) => Math.abs(bar.at - at) <= ON_LINE);
  return line ? `${line.kind} line` : null;
}

/**
 * The strong onsets within HIT_SPAN s of `end` that the song plays (`playsTo`: the scene second
 * its Play ends), phrase lines first, then bar lines, then by weight: [{at, weight, line, strongest}]
 * (at most `count`). `grid.onsets` are [{at, weight}] in scene seconds.
 */
export function hitsAround(grid, end, { playsTo = Infinity, count = 3 } = {}) {
  const near = (grid?.onsets ?? []).filter((onset) => Number.isFinite(onset.weight) && onset.weight >= STRONG_WEIGHT
    && Math.abs(onset.at - end) <= HIT_SPAN && onset.at < playsTo - RING_MIN);
  if (!near.length) return [];
  const top = Math.max(...near.map((onset) => onset.weight));
  const rank = (hit) => (hit.line === "phrase line" ? 0 : hit.line === "bar line" ? 1 : 2);
  return near.map((onset) => ({ at: r2(onset.at), weight: r2(onset.weight), line: lineAt(grid, onset.at), strongest: onset.weight === top }))
    .sort((a, b) => rank(a) - rank(b) || b.weight - a.weight || Math.abs(a.at - end) - Math.abs(b.at - end)).slice(0, count);
}

/**
 * The one edit that ends the video on `hit`: the song's hit rings to the end (fit_music's ring),
 * the end clamped to RING_MIN to RING_MAX after the hit; Volume animations of the song that start
 * after the hit are removed so the ring is the last move. Returns {end, ops}.
 */
export function endOnHitOps({ scene, song, hit, volume = 1 }) {
  // Already ringing from this hit to the end: nothing to send.
  if ((song.animations ?? []).some((animation) => animation.name === "Ring" && Math.abs(animation.start - hit.at - RING_HOLD) <= 0.01 && Math.abs(animation.start + animation.duration - scene.duration) <= 0.01)) return { end: scene.duration, ops: [], rings: true };
  const end = r2(Math.min(hit.at + RING_MAX, Math.max(hit.at + RING_MIN, scene.duration)));
  const layer = song.name ?? song.id;
  const ops = [];
  if (Math.abs(end - scene.duration) > 0.005) ops.push({ op: "update_scene", sceneId: scene.id, properties: { duration: end } });
  const playsTo = (song.mediaStart ?? 0) + (song.mediaDuration ?? Infinity);
  if (Number.isFinite(playsTo) && playsTo < end - 0.005) ops.push({ op: "update_layer", layer, properties: { mediaDuration: r3(end - (song.mediaStart ?? 0)) } });
  for (const animation of song.animations ?? []) {
    const moves = Object.hasOwn(animation.from ?? {}, "volume") || Object.hasOwn(animation.to ?? {}, "volume");
    if (moves && animation.start + (animation.duration ?? 0) > hit.at + 0.005) ops.push({ op: "delete_animation", layer, animation: animation.id });
  }
  ops.push({ op: "add_animation", layer, animation: { kind: "out", name: "Ring", start: r3(hit.at + RING_HOLD), duration: r3(end - hit.at - RING_HOLD), easing: "quart-out", from: { volume }, to: { volume: 0 } } });
  // end_on_fade reads a song-ring cue as a finished ending (fit_music names its ring so).
  ops.push({ op: "set_cues", cues: [{ name: "song-ring-1", time: r3(hit.at) }] });
  return { end, ops };
}

/** "nearest hits: 12.75 (bar line, 0.84, strongest in 2 s), 14.89 (bar line, 0.73)". */
export function hitsText(hits) {
  return `nearest hits (onsets of weight ${STRONG_WEIGHT}+, a starting guess, within ${HIT_SPAN} s): ${hits.map((hit) => `${hit.at} (${[hit.line, hit.weight, hit.strongest ? `strongest in ${HIT_SPAN} s` : null].filter(Boolean).join(", ")})`).join(", ")}`;
}

// A layer's Show and Hide times, and a video's Play start and end.
function edgesOf(layer) {
  const ops = (layer.animations ?? []).filter((animation) => isVisibilityOperation(animation) && Number.isFinite(animation.start));
  const starts = ops.filter((animation) => animation.kind === "show").map((animation) => animation.start);
  const ends = ops.filter((animation) => animation.kind === "hide").map((animation) => animation.start);
  if ((layer.type === "video" || layer.type === "image") && Number.isFinite(layer.mediaStart) && layer.mediaDuration > 0) {
    starts.push(layer.mediaStart);
    ends.push(layer.mediaStart + layer.mediaDuration);
  }
  return { starts, ends };
}
const near = (list, at) => list.some((time) => Math.abs(time - at) <= EDGE);
const speedOf = (layer) => (layer.mediaSpeed > 0 ? layer.mediaSpeed : 1);
const hasSpeedAnimation = (layer) => (layer.animations ?? []).some((animation) => Object.hasOwn(animation.from ?? {}, "speed") || Object.hasOwn(animation.to ?? {}, "speed"));

/**
 * The picture cuts from `from` to `to` (scene s, both ends counted): times where one video or image
 * layer ends and another starts. Sorted.
 */
export function cutsIn(scene, from, to) {
  const pictures = (scene.layers ?? []).filter((layer) => (layer.type === "video" || layer.type === "image") && layer.enabled !== false);
  const times = [];
  for (const layer of pictures) for (const at of edgesOf(layer).starts) {
    if (at < from - EDGE || at > to + EDGE || times.some((time) => Math.abs(time - at) <= EDGE)) continue;
    if (pictures.some((other) => other !== layer && near(edgesOf(other).ends, at))) times.push(r3(at));
  }
  return times.sort((a, b) => a - b);
}

/**
 * The song events a cut can take, in order of preference: strong onsets, then beats. [{at, kind, weight?}].
 */
function eventsOf(grid) {
  const onsets = (grid?.onsets ?? []).filter((onset) => onset.weight >= STRONG_WEIGHT).map((onset) => ({ at: onset.at, kind: lineAt(grid, onset.at) ? `onset on the ${lineAt(grid, onset.at)}` : "onset", weight: r2(onset.weight) }));
  const beats = (grid?.beats ?? []).map((at) => ({ at, kind: lineAt(grid, at) ? lineAt(grid, at) : "beat" }));
  return { onsets, beats };
}

/** The default reach: half the median shot between the span's cuts (null with under two cuts). */
export function defaultReach(cuts) {
  if (cuts.length < 2) return null;
  const shots = cuts.slice(1).map((at, index) => at - cuts[index]).sort((a, b) => a - b);
  const middle = shots.length % 2 ? shots[(shots.length - 1) / 2] : (shots[shots.length / 2 - 1] + shots[shots.length / 2]) / 2;
  return { reach: r3(middle / 2), median: r3(middle) };
}

/**
 * Moves each picture cut from `from` to `to` in `scene` onto the nearest strong song onset within
 * `reach` s (else the nearest beat), changing `scene` in place. Every layer keeps its file time at
 * every scene time: the layers that end on the cut end at the new time (a video plays on in its
 * file, or stops sooner), those that start on it start at the new time from the matching file
 * second (mediaOffset by the move times its speed); their Show, Hide and the animations that start
 * (or end) on the cut move with it. A cut stays, with the reason, when the move would cut into a
 * kept line, run a clip past its file's end or before its start, pass a neighbor cut, or when no
 * event is in reach. Returns { reach, reachFrom, moved: [{from, to, event, layers}], stayed: [{at, why}] }.
 */
export function moveCutsToEvents(scene, { from, to, reach = null, grid }) {
  const cuts = cutsIn(scene, from, to);
  const measured = defaultReach(cuts);
  const given = Number.isFinite(reach) && reach > 0;
  const span = given ? reach : measured?.reach ?? 0.25;
  const reachFrom = given ? "given" : measured ? `half the median shot (${measured.median} s) between the ${cuts.length} cuts of ${r2(from)}-${r2(to)} s` : "a starting guess (under two cuts in the span)";
  const kept = keptLinesOf(scene, (layer) => layer.id);
  const { onsets, beats } = eventsOf(grid);
  const used = new Set();
  const moved = [], stayed = [];
  const pick = (list, at) => list.filter((event) => !used.has(event.at) && Math.abs(event.at - at) <= span + 1e-6)
    .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0] ?? null;
  let floor = -Infinity;
  for (let index = 0; index < cuts.length; index += 1) {
    const at = cuts[index];
    const next = cuts[index + 1] ?? Infinity;
    const event = pick(onsets, at) ?? pick(beats, at);
    if (!event) { stayed.push({ at, why: `no strong onset or beat within ${span} s` }); floor = at; continue; }
    const target = r3(event.at);
    if (target <= floor + MIN_SHOT || target >= next - MIN_SHOT) { stayed.push({ at, why: `${target} s would pass the next or last cut` }); floor = at; continue; }
    const by = target - at;
    if (Math.abs(by) < EDGE) { used.add(event.at); stayed.push({ at, why: `already on the ${event.kind} at ${r2(target)} s` }); floor = at; continue; }
    const ending = scene.layers.filter((layer) => near(edgesOf(layer).ends, at) && !near(edgesOf(layer).starts, at));
    const starting = scene.layers.filter((layer) => near(edgesOf(layer).starts, at) && !near(edgesOf(layer).ends, at));
    const why = blocked({ ending, starting, at, target, by, kept });
    if (why) { stayed.push({ at, why }); floor = at; continue; }
    for (const layer of ending) moveEnd(layer, at, by);
    for (const layer of starting) moveStart(layer, at, by);
    used.add(event.at);
    moved.push({ from: at, to: target, event: `${event.kind}${event.weight !== undefined ? ` ${event.weight}` : ""}`, layers: [...ending, ...starting].filter((layer) => layer.type === "video" || layer.type === "image").map((layer) => layer.name ?? layer.id) });
    floor = target;
  }
  return { reach: span, reachFrom, moved, stayed };
}

// Why a cut cannot move from `at` to `target`, or null.
function blocked({ ending, starting, at, target, by, kept }) {
  for (const layer of ending) {
    const line = kept.find((entry) => entry.name === layer.id && entry.end > target + EDGE && entry.start < at);
    if (line && by < 0) return `it would cut the kept line on ${layer.name ?? layer.id} (${r2(line.start)}-${r2(line.end)} s)`;
    if (layer.type === "video" && by > 0 && !hasSpeedAnimation(layer)) {
      const fileEnd = layer.mediaSourceDuration > 0 ? layer.mediaSourceDuration : Infinity;
      const needs = (layer.mediaOffset ?? 0) + (layer.mediaDuration + by) * speedOf(layer);
      if (needs > fileEnd + 0.034) return `${layer.name ?? layer.id} would play past its file's end (${r2(fileEnd)} s)`;
    }
  }
  for (const layer of starting) {
    const line = kept.find((entry) => entry.name === layer.id && entry.start < target - EDGE && entry.end > at);
    if (line && by > 0) return `it would cut the kept line on ${layer.name ?? layer.id} (${r2(line.start)}-${r2(line.end)} s)`;
    if (layer.type === "video" && !hasSpeedAnimation(layer)) {
      if ((layer.mediaOffset ?? 0) + by * speedOf(layer) < -0.001) return `${layer.name ?? layer.id} would start before its file's start`;
    }
  }
  return null;
}

// The layer that ends on the cut: only its end moves (its other animations keep their times, so
// nothing it draws jumps; past a shorter end they are cut, before a longer one they hold).
function moveEnd(layer, at, by) {
  if ((layer.type === "video" || layer.type === "image") && Math.abs(layer.mediaStart + layer.mediaDuration - at) <= EDGE) layer.mediaDuration = r3(layer.mediaDuration + by);
  for (const animation of layer.animations ?? []) if (animation.kind === "hide" && Math.abs(animation.start - at) <= EDGE) animation.start = r3(at + by);
}

// The layer that starts on the cut starts at the new time from the matching file second; one with a
// Speed animation (a made move riding on the shot) moves whole: its start, its file mapping and every
// animation from the cut on shift together, so its own motion keeps its shape.
function moveStart(layer, at, by) {
  const whole = hasSpeedAnimation(layer);
  if ((layer.type === "video" || layer.type === "image") && Math.abs(layer.mediaStart - at) <= EDGE) {
    layer.mediaStart = r3(at + by);
    layer.mediaDuration = r3(layer.mediaDuration - by);
    if (layer.type === "video" && !whole) layer.mediaOffset = r3((layer.mediaOffset ?? 0) + by * speedOf(layer));
  }
  for (const animation of layer.animations ?? []) {
    if (Math.abs(animation.start - at) <= EDGE || (whole && animation.start > at && !(animation.kind === "hide"))) animation.start = r3(animation.start + by);
  }
}

/** The receipt line: each cut's old and new time and the event it took, then the cuts that stayed. */
export function snapText({ reach, reachFrom, moved, stayed }) {
  const moves = moved.length ? moved.map((entry) => `${r2(entry.from)}→${r2(entry.to)} (${entry.event})`).join(", ") : "none";
  return `snap to song: ${moved.length} cut${moved.length === 1 ? "" : "s"} moved, reach ${reach} s (${reachFrom}), each layer keeps its file time: ${moves}${stayed.length ? ` · stayed: ${stayed.map((entry) => `${r2(entry.at)} s (${entry.why})`).join(", ")}` : ""}`;
}
