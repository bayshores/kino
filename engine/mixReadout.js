// Measured facts about how the mix meets the song's cues and how its sound ends, for check's mix
// line and look {mode:"motion", ref:"sound"}. Facts only: no finding, nothing moved.
//
// The mix readings are the ones check already takes for its mix line (backend/export.mjs
// measureMixPeaks): one window every 0.1 s, each with its momentary loudness `m` (FFmpeg ebur128,
// the 0.4 s that end with the window) and its peak. A cue is read over the 1 s before it and the
// 1 s after it, as the energy mean of the momentary readings whose 0.4 s lies inside that second.
import { volumeAt } from "./animation.js";
import { keepLineStretches } from "./audioDucking.js";
import { energyMean } from "./mixLevels.js";
import { mediaPlaybackRange } from "./playback.js";

/** Seconds read on each side of a cue. */
export const CUE_SIDE = 1;
/** ebur128's momentary window (s); a reading at window t covers t + 0.1 - 0.4 to t + 0.1. */
export const MOMENTARY = 0.4;
/** A kept line that ends within this many seconds before a cue is named with it. */
export const LINE_REACH = 2;
/** A fall of the song's volume this short or shorter (s) is a hard stop, not a fade. */
export const HARD_STOP = 0.1;
/** The quiet share is printed over this share of the song's heard time. */
export const QUIET_SHARE = 0.4;
/** Cues read (the drop first, then the earliest section starts). */
export const CUES_READ = 4;
// The mix is heard in a window whose peak is over this (dBFS).
const HEARD_DBFS = -60;
const WINDOW = 0.1;
const SILENT = 0.02;
const STEP = 0.01;
const FINE = 0.001;
const r1 = (value) => Math.round(value * 10) / 10;
const r2 = (value) => Math.round(value * 100) / 100;
const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;

/**
 * The energy mean (LUFS) of the momentary readings of `windows` ([{t, m}]) whose 0.4 s lies inside
 * `from` to `to` (scene s); a stretch shorter than 0.4 s takes the readings that end inside it.
 * Null when none is above silence (-70).
 */
export function momentaryOver(windows, from, to) {
  const ends = (window) => window.t + WINDOW;
  let inside = windows.filter((window) => Number.isFinite(window.m) && ends(window) - MOMENTARY >= from - 1e-6 && ends(window) <= to + 1e-6);
  if (!inside.length) inside = windows.filter((window) => Number.isFinite(window.m) && ends(window) > from + 1e-6 && ends(window) <= to + WINDOW + 1e-6);
  const mean = energyMean(inside.map((window) => window.m));
  return mean === null ? null : r1(mean);
}

/**
 * How the mix meets a cue at `at`: { at, kind, before, after, rise, line } with before and after
 * the momentary loudness of the second before and after (null: silent), rise in LU, and line the
 * loudest kept line ending within LINE_REACH s before the cue ({name, start, end, lufs, over}:
 * lufs its own reading over its part of those 2 s, over how far the second after sits above it).
 */
export function cueRise(windows, { at, kind }, lines = []) {
  const before = momentaryOver(windows, at - CUE_SIDE, at);
  const after = momentaryOver(windows, at, at + CUE_SIDE);
  const rise = before !== null && after !== null ? r1(after - before) : null;
  const near = lines.filter((line) => line.start < at && line.end > at - LINE_REACH)
    .map((line) => ({ name: line.name, start: line.start, end: Math.min(line.end, at), lufs: momentaryOver(windows, Math.max(line.start, at - LINE_REACH), Math.min(line.end, at)) }))
    .filter((line) => line.lufs !== null);
  const loudest = near.reduce((most, line) => (!most || line.lufs > most.lufs ? line : most), null);
  const line = loudest ? { ...loudest, over: after === null ? null : r1(after - loudest.lufs) } : null;
  return { at, kind, before, after, rise, line };
}

/** The lines keep_line kept in `scene` ([{name, start, end}], scene s, each within its layer's Play range). */
export function keptLinesOf(scene, nameOf = (layer) => layer.name ?? layer.id) {
  return (scene.layers ?? []).filter((layer) => (layer.type === "audio" || layer.type === "video") && layer.src && layer.enabled !== false).flatMap((layer) => {
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!range) return [];
    return keepLineStretches(layer).map((stretch) => ({ name: nameOf(layer), start: Math.max(range.start, stretch.start), end: Math.min(range.end, stretch.end) }))
      .filter((stretch) => stretch.end > stretch.start);
  });
}

/**
 * The last fall of `layer`'s volume before `end` (scene s): { from, to, top, bottom } (the fall
 * runs from `from` at volume top to `to` at volume bottom), or null when the volume at `end` is
 * still over 30% of the loudest it played in the 3 s before.
 */
export function volumeFall(layer, end, start = 0) {
  let top = 0;
  for (let time = Math.max(start, end - 3); time <= end - STEP; time += STEP) top = Math.max(top, volumeAt(layer, time));
  const last = volumeAt(layer, end - 0.001);
  if (!(top > SILENT) || last > top * 0.3) return null;
  // Back over the bottom, then up the fall, each in steps of STEP and then FINE.
  const walk = (time, keep) => {
    for (const step of [STEP, FINE]) while (time - step > start && keep(time - step, time)) time -= step;
    return time;
  };
  const to = walk(end - 0.001, (earlier) => volumeAt(layer, earlier) <= last + 1e-4);
  const from = walk(to, (earlier, time) => volumeAt(layer, earlier) > volumeAt(layer, time) + 1e-6);
  return { from: r2(from), to: r2(to), top: volumeAt(layer, from), bottom: last };
}

/**
 * How the song ends: { kind, at, length?, onset?, nearest?, crosses?, soundEnd, after }.
 * kind "stop" (its volume falls in HARD_STOP s or less, or its clip ends while up), "fade" (a longer
 * fall: length, crosses: the bar and phrase lines inside it, null with no beat grid), "tail" (it
 * plays to its file's own end) or "up" (still up when the picture ends). onset: the song onset
 * within HARD_STOP s before a stop (null when none; nearest: the closest one before it). soundEnd:
 * where the mix's last heard 0.1 s window ends; after: how long the picture runs on past it.
 * `grid` (scene s): { onsets: [s], beats: [s], bars?: [{at, kind}] } from the song's saved beat grid
 * and its shape's measured bar lines (kind "bar" or "phrase"); with no bars, a guess: bars every 4
 * beats and phrases every 16 from the grid's first beat (barsFrom "measured" or "beats").
 * `fileSeconds` is the song file's length.
 */
export function songEnding({ layer, duration, windows = [], grid = null, fileSeconds = null }) {
  const range = mediaPlaybackRange(layer, duration);
  if (!range || range.remapped) return null;
  const heard = windows.filter((window) => window.peak > HEARD_DBFS);
  const soundEnd = heard.length ? r2(Math.min(duration, heard.at(-1).t + WINDOW)) : null;
  const facts = { soundEnd, after: soundEnd === null ? null : r2(Math.max(0, duration - soundEnd)) };
  const onsets = grid?.onsets ?? [];
  const onsetFacts = (at) => {
    const onset = onsets.filter((time) => time <= at + 1e-6 && at - time <= HARD_STOP + 1e-6).at(-1);
    if (Number.isFinite(onset)) return { onset: r2(onset) };
    const nearest = onsets.filter((time) => time <= at + 1e-6).at(-1);
    return { onset: null, ...(Number.isFinite(nearest) ? { nearest: r2(nearest) } : {}) };
  };
  const fileEnd = range.offset + range.duration;
  const up = volumeAt(layer, range.end - 0.001) > SILENT;
  if (up && Number.isFinite(fileSeconds) && fileSeconds - fileEnd <= 0.05) return { kind: "tail", at: r2(range.end), ...facts };
  if (up && range.end < duration - 0.05) return { kind: "stop", at: r2(range.end), length: 0, ...onsetFacts(range.end), ...facts };
  const fall = volumeFall(layer, range.end, range.start);
  if (!fall) return { kind: "up", at: r2(range.end), ...facts };
  const length = r2(fall.to - fall.from);
  if (length <= HARD_STOP + 1e-6) return { kind: "stop", at: fall.from, length, ...onsetFacts(fall.from), ...facts };
  const inside = (time) => time > fall.from + 1e-6 && time < fall.to - 1e-6;
  // The song's measured bar lines first (its shape's bars, phrases every 4 bars from its first
  // drop); else a guess from the beat grid: every 4 beats from its first tracked beat.
  const bars = grid?.bars ?? [];
  if (bars.length) return { kind: "fade", at: fall.from, to: fall.to, length, crosses: bars.filter((bar) => inside(bar.at)).map((bar) => ({ at: r2(bar.at), kind: bar.kind })), barsFrom: "measured", ...facts };
  const beats = grid?.beats ?? [];
  const crosses = beats.length ? beats.map((time, index) => ({ time, index })).filter(({ time, index }) => index % 4 === 0 && inside(time))
    .map(({ time, index }) => ({ at: r2(time), kind: index % 16 === 0 ? "phrase" : "bar" })) : null;
  return { kind: "fade", at: fall.from, to: fall.to, length, crosses, ...(crosses ? { barsFrom: "beats" } : {}), ...facts };
}

/**
 * The share of `layer`'s heard time (volume over 0.02) it plays under half its own volume
 * (layer.volume): { heard, quiet, share } in s and 0 to 1, or null when it is never heard.
 */
export function quietShare(layer, duration) {
  const range = mediaPlaybackRange(layer, duration);
  if (!range) return null;
  const half = (layer.volume ?? 1) / 2;
  let heard = 0, quiet = 0;
  const count = Math.round((range.end - range.start) / STEP);
  for (let index = 0; index < count; index += 1) {
    const volume = volumeAt(layer, range.start + index * STEP);
    if (volume <= SILENT) continue;
    heard += 1;
    if (volume < half) quiet += 1;
  }
  return heard > 0 ? { heard: r1(heard * STEP), quiet: r1(quiet * STEP), share: quiet / heard } : null;
}

/**
 * Over the whole runtime (`duration`), how long `layer` (the song) is out (volume 0.02 or less, or
 * not playing) and how long it is heard under half its own volume: { runtime, out, quiet, outShare,
 * quietShare, others } in s and 0 to 1; others: the names of the other sound layers (volume over
 * 0.02, in their Play range) heard while the song is out or under half, loudest time first.
 */
export function songPresence(layer, scene, nameOf = (entry) => entry.name ?? entry.id) {
  const duration = scene.duration;
  const range = mediaPlaybackRange(layer, duration);
  const half = (layer.volume ?? 1) / 2;
  const sounds = (scene.layers ?? []).filter((entry) => entry !== layer && (entry.type === "audio" || entry.type === "video") && entry.src && entry.enabled !== false)
    .map((entry) => ({ entry, range: mediaPlaybackRange(entry, duration) })).filter((entry) => entry.range);
  const time = new Map();
  let out = 0, quiet = 0;
  const count = Math.round(duration / STEP);
  for (let index = 0; index < count; index += 1) {
    const at = index * STEP;
    const volume = range && at >= range.start && at < range.end ? volumeAt(layer, at) : 0;
    const isOut = volume <= SILENT;
    if (!isOut && !(volume < half)) continue;
    if (isOut) out += 1; else quiet += 1;
    for (const { entry, range: plays } of sounds) {
      if (at < plays.start || at >= plays.end || !(volumeAt(entry, at) > SILENT)) continue;
      time.set(nameOf(entry), (time.get(nameOf(entry)) ?? 0) + 1);
    }
  }
  const others = [...time].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return { runtime: r1(duration), out: r1(out * STEP), quiet: r1(quiet * STEP), outShare: count ? out / count : 0, quietShare: count ? quiet / count : 0, others };
}

/** "song: out 7.6 s (54%), heard under half its own volume 1.2 s (9%) of the 14 s runtime; own sound then: board-S3, board-S7". */
export function presenceText(name, presence) {
  const pct = (share) => `${Math.round(share * 100)}%`;
  const others = presence.others.length ? `; own sound then: ${presence.others.slice(0, 6).join(", ")}${presence.others.length > 6 ? ` +${presence.others.length - 6}` : ""}` : "";
  return `${name}: out ${presence.out} s (${pct(presence.outShare)}), heard under half its own volume ${presence.quiet} s (${pct(presence.quietShare)}) of the ${presence.runtime} s runtime${others}`;
}

const level = (value) => (value === null ? "silent" : `${value} LUFS`);

/** One line per read cue: "drop at 7.5 s: the mix -12.1 LUFS in the 1 s before, -9.0 in the 1 s after (+3.1 LU); ...". */
export function cueRiseText(rise) {
  const line = rise.line ? `; loudest kept line in the 2 s before: ${rise.line.name} ${r2(rise.line.start)}-${r2(rise.line.end)} s at ${rise.line.lufs} LUFS, the 1 s after sits ${rise.line.over === null ? "silent" : `${signed(rise.line.over)} LU`} over it` : "";
  return `${rise.kind} at ${r2(rise.at)} s: the mix ${level(rise.before)} in the 1 s before, ${level(rise.after)} in the 1 s after${rise.rise === null ? "" : ` (${signed(rise.rise)} LU)`}${line}`;
}

/** The ending in words: "ending: song stops hard at 14.72 s (0.03 s), 0.02 s after its onset at 14.7 s; sound ends 14.75 s, picture runs 0.22 s past it". */
export function endingText(name, ending) {
  const picture = ending.soundEnd === null ? "" : `; the mix's sound ends at ${ending.soundEnd} s, the picture runs ${ending.after} s past it`;
  if (ending.kind === "tail") return `ending: ${name} plays to its file's own end at ${ending.at} s (a tail)${picture}`;
  if (ending.kind === "up") return `ending: ${name} is still up when the picture ends at ${ending.at} s${picture}`;
  if (ending.kind === "stop") {
    const onset = ending.onset !== null && ending.onset !== undefined ? `, ${r2(ending.at - ending.onset)} s after its onset at ${ending.onset} s` : `, not on an onset${Number.isFinite(ending.nearest) ? ` (the last before it at ${ending.nearest} s)` : ""}`;
    return `ending: ${name} stops hard at ${ending.at} s (${ending.length} s)${onset}${picture}`;
  }
  const source = ending.barsFrom === "measured" ? " (the song's measured bar lines)" : ending.barsFrom === "beats" ? " (a guess: every 4 beats from the first tracked beat; the song has no measured bars)" : "";
  const lines = ending.crosses === null ? " (no beat grid saved)" : `${ending.crosses.length ? `, crossing the ${ending.crosses.map((line) => `${line.kind} line at ${line.at} s`).join(", ")}` : ", inside one bar"}${source}`;
  return `ending: ${name} fades ${ending.length} s from ${ending.at} to ${ending.to} s${lines}${picture}`;
}

/** The quiet share in words when over QUIET_SHARE, else "". `call` shows the ways (keep_line's dry run). */
export function quietText(name, quiet, call) {
  if (!quiet || !(quiet.share > QUIET_SHARE)) return "";
  return `${name} plays under half its own volume for ${quiet.quiet} of its ${quiet.heard} s heard (${Math.round(quiet.share * 100)}%)${call ? `; ${call} prints the ways to keep it up under a line` : ""}`;
}
