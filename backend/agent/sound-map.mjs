// look {mode:"sound"}: the video's sound as numbers and one graph, for an agent that cannot hear.
// Agents never play audio; everything here is measured (FFmpeg ebur128 through export.mjs
// soundCurve, the songs' shape from backend/song-shape.mjs, the volume animations).
//
// soundMapText(map) and soundMapImage(map) read one map:
//   duration    the scene's length (s)
//   mix         [{t, m, s}] the whole mix every 0.1 s (LUFS)
//   music       the same for the music alone (null when there is none)
//   rest        the same for everything but the music (null when there is no music or no line)
//   beats       [{from, to, name}] the story beats (spine, else notes intents)
//   lines       [[from, to]] the spoken lines (saved transcripts)
//   sections    [{layer, at, kind}] each song's sections in video time
//   dips        [{layer, from, to, db}] where a song's volume dips (ducking), and how deep
//   cuts        [t] the shot changes (optional): the scene-cut list
//   edges       [t] where a sound clip starts or ends (optional): mixCheck's level jumps
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { volumeAt } from "../../engine/animation.js";
import { mediaPlaybackRange } from "../../engine/playback.js";

const round1 = (value) => Math.round(value * 10) / 10;
// A dip: the volume under this share of the layer's loudest volume.
const DIP_SHARE = 0.7;
// A spoken line wants the voice this many LU over the music (T4: 6 at least, 8 to 10 is good).
export const VOICE_OVER_MUSIC = 6;

/** Power mean of momentary loudness between from and to (momentary lags 0.2 s), or null. */
export function spanLevel(curve, from, to, key = "m") {
  const values = (curve ?? []).filter((point) => point.t > from + 0.2 && point.t <= to + 0.2 && point[key] > -70).map((point) => 10 ** (point[key] / 10));
  return values.length ? round1(10 * Math.log10(values.reduce((sum, value) => sum + value, 0) / values.length)) : null;
}

/**
 * Short-term loudness every `step` seconds: [[t, LUFS]] (the reading nearest each step, -70
 * floor). Its 3 s window has no reading before 3 s, so momentary loudness stands in there.
 */
export function shortTermEvery(curve, duration, step = 0.5) {
  const points = [];
  let index = 0;
  for (let t = step; t <= duration + 1e-6 && curve.length; t += step) {
    while (index + 1 < curve.length && Math.abs(curve[index + 1].t - t) <= Math.abs(curve[index].t - t)) index += 1;
    const point = curve[index];
    points.push([round1(t), Math.max(-70, round1(point.t < 3 && point.s <= -70 ? point.m : point.s))]);
  }
  return points;
}

/** Where a layer's volume dips under 70% of its loudest: [{from, to, db}] in scene seconds. */
export function volumeDips(layer, duration, step = 0.05) {
  const range = mediaPlaybackRange(layer, duration);
  if (!range) return [];
  const samples = [];
  for (let t = range.start; t <= range.end + 1e-6; t += step) samples.push([t, volumeAt(layer, t)]);
  const loudest = Math.max(0, ...samples.map(([, value]) => value));
  if (!(loudest > 0)) return [];
  const dips = [];
  let open = null;
  for (const [t, value] of samples) {
    const low = value < loudest * DIP_SHARE;
    if (low && !open) open = { from: t, low: value };
    else if (low) open.low = Math.min(open.low, value);
    else if (open) { dips.push({ from: round1(open.from), to: round1(t), db: round1(20 * Math.log10(Math.max(1e-4, open.low / loudest))), edge: open.from <= range.start + step }); open = null; }
  }
  // A fade in from the clip's start, or a fade out that never comes back up, is no dip.
  return dips.filter((dip) => !dip.edge).map(({ edge, ...dip }) => dip);
}

/** A song's sections (file seconds) in video time, inside the stretch the layer plays. */
export function sectionsInVideo(layer, sections, duration) {
  const range = mediaPlaybackRange(layer, duration);
  if (!range) return [];
  return sections.map((part) => ({ at: round1(range.start + (part.at - range.offset)), kind: part.kind }))
    .filter((part) => part.at >= range.start - 0.05 && part.at <= range.end + 0.05);
}

/** Each spoken line's level and how far it sits over the music: [{from, to, voice, music, over}]. */
export function lineLevels(map) {
  return map.lines.map(([from, to]) => {
    const voice = spanLevel(map.rest ?? map.mix, from, to);
    const music = map.music ? spanLevel(map.music, from, to) : null;
    return { from: round1(from), to: round1(to), voice, music, over: voice !== null && music !== null ? round1(voice - music) : null };
  });
}

// ---------------------------------------------------------------- mix check

// The mix check, the "listen" before done, measured from the previewed mix, never played:
//   voice    a spoken line under 6 LU over the music (lineLevels)
//   clip     the mix's true peak over this (dBTP) before the master limiter
//   jump     momentary loudness this many LU apart 0.5 s either side of a clip edge
//   gap      silence (momentary under -50 LUFS) this long inside the video
//   range    loudness range over this many LU: phone speakers flatten quiet parts away
export const MIX = Object.freeze({ clipDbtp: 0, jumpLu: 10, silentLufs: -50, gapSeconds: 1, phoneLra: 8 });

/** EBU R128 loudness range (LU) from the short-term readings: 10th to 95th percentile after its gates, or null. */
export function loudnessRange(curve) {
  const short = (curve ?? []).map((point) => point.s).filter((value) => value > -70);
  if (short.length < 30) return null;
  const mean = 10 * Math.log10(short.reduce((sum, value) => sum + 10 ** (value / 10), 0) / short.length);
  const kept = short.filter((value) => value >= mean - 20).sort((a, b) => a - b);
  const at = (share) => kept[Math.min(kept.length - 1, Math.max(0, Math.round(share * (kept.length - 1))))];
  return kept.length ? round1(at(0.95) - at(0.1)) : null;
}

/** What the mix check found: [{kind, at, text}], in time order. */
export function mixCheck(map) {
  const found = [];
  for (const line of lineLevels(map)) if (line.over !== null && line.over < VOICE_OVER_MUSIC) found.push({ kind: "voice", at: line.from, text: `voice ${line.from}-${line.to} s only ${line.over} LU over the music (6+): duck_audio the music` });
  const peak = (map.mix ?? []).reduce((best, point) => (Number.isFinite(point.tp) && point.tp > best.tp ? point : best), { tp: -Infinity });
  if (peak.tp > MIX.clipDbtp) found.push({ kind: "clip", at: round1(peak.t), text: `clips: true peak +${round1(peak.tp)} dBTP by ${round1(peak.t)} s before the limiter: lower what plays there` });
  for (const edge of map.edges ?? []) {
    const before = spanLevel(map.mix, edge - 0.5, edge), after = spanLevel(map.mix, edge, edge + 0.5);
    if (before === null || after === null || before < MIX.silentLufs || after < MIX.silentLufs) continue;
    if (Math.abs(after - before) >= MIX.jumpLu) found.push({ kind: "jump", at: round1(edge), text: `level jump ${before} to ${after} LUFS at ${round1(edge)} s: match the clips' volumes or fade across` });
  }
  let quiet = null;
  const gaps = [];
  for (const point of map.mix ?? []) {
    if (point.t > 0.4 && point.m < MIX.silentLufs && point.t < map.duration - 0.3) quiet ??= point.t;
    else if (quiet !== null) { if (point.t - quiet >= MIX.gapSeconds) gaps.push([quiet, point.t]); quiet = null; }
  }
  for (const [from, to] of gaps.slice(0, 3)) found.push({ kind: "gap", at: round1(from), text: `silent ${round1(from)}-${round1(to)} s: fill it (room tone, music) or cut it out` });
  const range = loudnessRange(map.mix);
  if (range !== null && range > MIX.phoneLra) found.push({ kind: "range", at: 0, text: `loudness range ${range} LU (phone speakers: ${MIX.phoneLra} or less): quiet parts get lost, raise them or lower the loud ones` });
  return found.sort((a, b) => a.at - b.at);
}

/** The short reply: a few lines. */
export function soundMapText(map, { scene = "the scene" } = {}) {
  const st = shortTermEvery(map.mix, map.duration);
  const loudest = st.reduce((best, point) => (point[1] > best[1] ? point : best), [0, -70]);
  const lines = [`sound ${scene} ${round1(map.duration)} s: short-term loudness every 0.5 s, loudest ${loudest[1]} LUFS at ${loudest[0]} s${map.mix.length ? "" : " (nothing is heard)"}`];
  if (map.beats.length) lines.push(`beats: ${map.beats.map((beat) => `${beat.name} ${round1(beat.from)}-${round1(beat.to)} ${spanLevel(map.mix, beat.from, beat.to) ?? "silent"}`).join(" · ")}`);
  const levels = lineLevels(map);
  if (levels.length) lines.push(`lines over music: ${levels.slice(0, 12).map((line) => `${line.from}-${line.to} ${line.over === null ? `${line.voice ?? "silent"} LUFS` : `${line.over > 0 ? "+" : ""}${line.over} LU${line.over < VOICE_OVER_MUSIC ? " (under 6)" : ""}`}`).join(" · ")}${levels.length > 12 ? ` · and ${levels.length - 12} more` : ""}`);
  if (map.sections.length) lines.push(`song sections: ${map.sections.map((part) => `${part.kind} ${part.at}s`).join(", ")}`);
  if (map.dips.length) lines.push(`dips: ${map.dips.map((dip) => `${dip.layer} ${dip.from}-${dip.to} ${dip.db} dB`).join(" · ")}`);
  if (map.cuts) lines.push(`cuts (${map.cuts.length}): ${map.cuts.slice(0, 40).map((at) => round1(at)).join(" ")}${map.cuts.length > 40 ? " ..." : ""}`);
  const mix = mixCheck(map);
  lines.push(mix.length ? `mix check: ${mix.slice(0, 8).map((entry) => entry.text).join(" · ")}${mix.length > 8 ? ` · and ${mix.length - 8} more` : ""}` : "mix check: passed (voice over music, no clipping, no level jumps at clip edges, no silent gaps, range fits a phone)");
  lines.push(`st: ${st.map((point) => (point[1] <= -70 ? "-" : Math.round(point[1]))).join(" ")}`);
  return lines.join("\n");
}

const labelFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/fonts/Inter-600.ttf");
let fontReady = false;
const INK = { mix: "#ffffff", music: "#2ec4b6", rest: "#ff7a59", line: "#ffd23f", dip: "rgba(127,183,255,0.25)", section: "#7fb7ff", grid: "#2a2d35", text: "#b8bcc4", beat: ["#16181d", "#1d2027"] };

/** One graph: short-term loudness (-50 to -5 LUFS) over the beats, lines, sections and dips. A PNG buffer. */
export function soundMapImage(map, { width = 1200 } = {}) {
  if (!fontReady) { try { GlobalFonts.registerFromPath(labelFont, "kino-label"); } catch { /* default font */ } fontReady = true; }
  const left = 44, right = 12, top = 52, plot = 260, axis = 34;
  const canvas = createCanvas(width, top + plot + axis);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101114";
  context.fillRect(0, 0, width, top + plot + axis);
  const end = Math.max(0.5, map.duration);
  const x = (time) => left + (Math.max(0, Math.min(end, time)) / end) * (width - left - right);
  const y = (lufs) => top + plot - ((Math.max(-50, Math.min(-5, lufs)) + 50) / 45) * plot;
  context.font = "13px kino-label, sans-serif";
  // Beats as alternating bands with their names.
  const beats = map.beats.length ? map.beats : [{ from: 0, to: end, name: "" }];
  beats.forEach((beat, index) => {
    context.fillStyle = INK.beat[index % 2];
    context.fillRect(x(beat.from), top, x(beat.to) - x(beat.from), plot);
    context.fillStyle = INK.text;
    if (beat.name) context.fillText(beat.name, x(beat.from) + 4, top + 14);
  });
  for (const dip of map.dips) { context.fillStyle = INK.dip; context.fillRect(x(dip.from), top, x(dip.to) - x(dip.from), plot); }
  // Grid every 10 LU.
  context.fillStyle = INK.text;
  for (let lufs = -50; lufs <= -10; lufs += 10) {
    context.fillStyle = INK.grid;
    context.fillRect(left, y(lufs), width - left - right, 1);
    context.fillStyle = INK.text;
    context.fillText(String(lufs), 6, y(lufs) + 4);
  }
  const stroke = (curve, color, key, widthPx) => {
    if (!curve?.length) return;
    context.strokeStyle = color;
    context.lineWidth = widthPx;
    context.beginPath();
    curve.forEach((point, index) => { const level = point.t < 3 && point[key] <= -70 ? point.m : point[key]; if (index === 0) context.moveTo(x(point.t), y(level)); else context.lineTo(x(point.t), y(level)); });
    context.stroke();
  };
  stroke(map.music, INK.music, "s", 1.5);
  stroke(map.rest, INK.rest, "s", 1.5);
  stroke(map.mix, INK.mix, "s", 2);
  // Each line as a bar at its level, labeled with its LU over the music.
  for (const line of lineLevels(map)) {
    if (line.voice === null) continue;
    context.fillStyle = INK.line;
    context.fillRect(x(line.from), y(line.voice) - 2, Math.max(3, x(line.to) - x(line.from)), 4);
    if (line.over !== null) context.fillText(`${line.over > 0 ? "+" : ""}${line.over}`, x(line.from), y(line.voice) - 6);
  }
  for (const part of map.sections) {
    context.strokeStyle = INK.section;
    context.setLineDash([3, 3]);
    context.beginPath(); context.moveTo(x(part.at), top); context.lineTo(x(part.at), top + plot); context.stroke();
    context.setLineDash([]);
    context.fillStyle = INK.section;
    context.fillText(part.kind, x(part.at) + 3, top + plot - 6);
  }
  const tick = [0.5, 1, 2, 5, 10, 20, 30].find((value) => (end / value) * 100 <= width) ?? 60;
  context.fillStyle = INK.text;
  for (let time = 0; time <= end + 1e-6; time += tick) {
    context.fillRect(x(time), top + plot + 4, 1, 5);
    context.fillText(`${Number(time.toFixed(1))}s`, x(time) + 3, top + plot + 22);
  }
  context.fillText("short-term LUFS · white: mix · teal: music · orange: the rest · yellow: lines (LU over music) · blue: song sections, dips", left, 22);
  return canvas.toBuffer("image/png");
}
