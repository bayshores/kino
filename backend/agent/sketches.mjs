// Sketch rounds: a try round (tries.mjs) whose options are 2 to 10 s sketches of the treatments
// the person was shown (treatments.mjs), each tied to one treatment by its letter. A sketch is the
// option's ops on a copy of the open document over one stretch (from, to), rendered with its
// sound (the song and lines over that stretch), so the person picks a direction by watching and
// hearing side by side instead of rating a finished edit alone. The pick becomes the treatment
// pick, by them, exactly as their typed pick does.
//
// This file holds the plain parts: reading the sketch fields, the cache key of a sketch, the
// numbers measured on each rendered clip (picture changes, median shot, lettering, loudness,
// colors) and the receipt lines that set the sketches side by side. Nothing here blocks or warns.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateScene } from "../../engine/animation.js";
import { BUSY_SHARE } from "../../engine/quality/rules/polish.js";
import { palette, pixelStats } from "../measure/fingerprint.mjs";
import { ffmpegCommand } from "../media-probe.mjs";
import { KNOWN_LABEL, LABELS } from "./treatments.mjs";

// Seconds a sketch lasts: long enough to hear a phrase of the song, short enough to watch 3 in a row.
export const SKETCH_LEAST = 2;
export const SKETCH_MOST = 10;
// Characters of ops one sketch may carry (a plain try option keeps 4,000). Three real sketches of
// 6 s on a 14 s fan edit took 826 to 1,260 characters (4 to 6 add_layer ops each); the room above
// that is for sketches that also animate, a starting value.
export const SKETCH_OPS_MOST = 12000;
// Frames a second the clip is sampled at for its numbers, and the sampled frame's size.
export const MEASURE_FPS = 10;
const MEASURE_W = 64;
const MEASURE_H = 36;
// Two sampled frames whose 16 × 9 blocks differ this much in mean brightness (0 to 1) count as a
// picture change. A starting value, printed with the numbers: on the 14 s fan edit it found the 8
// shot starts of 6 to 12 s, and movement inside a shot stayed at or under 0.039.
export const CHANGE_AT = 0.05;
// Two colors this close (RGB distance) count as the same color when two sketches are compared.
const SAME_COLOR = 48;
// Sketch clips kept in the cache folder per project (the oldest go first).
const CACHE_KEPT = 24;

const sec = (value) => Math.round(value * 100) / 100;
const median = (values) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};

// The fields kino builds a sketch from itself (song, font, line, clips), and the default length.
export const BUILT_FIELDS = ["song", "font", "line", "clips"];
export const SKETCH_SECONDS = 6;
const CLIPS_MOST = 6;

/** True when a try input asks for sketches: a stretch (from and to), seconds, kino-built fields or an option tied to a treatment. */
export const isSketchInput = (input) => input?.from !== undefined || input?.to !== undefined || input?.seconds !== undefined
  || (Array.isArray(input?.options) && input.options.some((option) => option?.treatment !== undefined || BUILT_FIELDS.some((key) => option?.[key] !== undefined)));

/** True when kino builds the sketches on a fresh copy: an option uses song, font, line or clips, or the open document has no layers. */
export const isBuiltSketch = (input, empty = false) => isSketchInput(input)
  && (empty || input?.seconds !== undefined || input.options?.some?.((option) => BUILT_FIELDS.some((key) => option?.[key] !== undefined)));

// Reads one option's kino-built fields (throws its words when one is wrong).
function readBuilt(option, index) {
  const text = (key, most) => {
    const value = option?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.trim().length > most) throw new Error(`options[${index}].${key} is text, 1 to ${most} characters.`);
    return value.replace(/\s+/g, " ").trim();
  };
  const clips = option?.clips;
  if (clips !== undefined && (!Array.isArray(clips) || !clips.length || clips.length > CLIPS_MOST || clips.some((clip) => typeof clip?.file !== "string" || (clip.in !== undefined && !(Number(clip.in) >= 0)))))
    throw new Error(`options[${index}].clips lists 1 to ${CLIPS_MOST} project files, [{file:"intro.mp4", in:2.5}] (in: seconds into the file).`);
  return { song: text("song", 200), font: text("font", 80), line: text("line", 200), clips: clips?.map((clip) => ({ file: clip.file.trim(), ...(clip.in !== undefined ? { in: Number(clip.in) } : {}) })) };
}

/**
 * The stretch of a song a sketch plays: the strongest entry kino measured (song-shape sections:
 * a drop first, then the heaviest section, the earliest on a tie) that leaves `seconds` of song;
 * else the first beat; else 0. `shape` {sections}, `beats` file seconds, `length` the file's seconds.
 */
export function songEntry({ sections = [], beats = [], length = Infinity }, seconds) {
  const fits = (at) => Number.isFinite(at) && at >= 0 && at + seconds <= length + 1e-6;
  const ranked = sections.filter((part) => fits(part.at))
    .sort((a, b) => (b.kind === "drop") - (a.kind === "drop") || (b.weight ?? 0) - (a.weight ?? 0) || a.at - b.at);
  if (ranked[0]) return { from: sec(ranked[0].at), kind: ranked[0].kind };
  const beat = beats.find(fits);
  return beat !== undefined ? { from: sec(beat), kind: "first beat" } : { from: 0, kind: "start" };
}

/** The sketch-time beats of a song stretch: file beats from `from` on, inside `seconds`. */
export const beatsIn = (beats, from, seconds) => beats.map((beat) => beat - from).filter((time) => time > 0.05 && time < seconds - 0.05).map(sec);

/**
 * Where each clip starts in a sketch of `seconds` with `count` clips: 0, then each cut on the song
 * beat nearest an even split (in order, never two on one beat); evenly without beats.
 */
export function cutTimes(count, seconds, beats = []) {
  const times = [0];
  for (let index = 1; index < count; index += 1) {
    const even = (seconds * index) / count;
    const free = beats.filter((beat) => beat > times.at(-1) + 0.3 && beat < seconds - 0.3);
    const near = free.sort((a, b) => Math.abs(a - even) - Math.abs(b - even))[0];
    times.push(sec(near ?? even));
  }
  return times;
}

/** The beat the line enters on: the song beat nearest 0.5 s (0.5 s without beats). */
export const lineEntry = (beats = []) => sec([...beats].sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5))[0] ?? 0.5);

// How long the line's exit lasts, and how long the picture takes to calm and to come back.
export const LINE_EXIT = 0.3;
const CALM_IN = 0.3;
const CALM_OUT = 0.4;

/**
 * The beat the line leaves on (its exit starts there): the song beat nearest 2.5 s after it
 * entered, at least 1.5 s after it and with the exit done 1 s before the sketch ends; without such
 * a beat, 2.5 s after it entered (inside the sketch).
 */
export function lineExit(beats, start, seconds) {
  const last = seconds - 1 - LINE_EXIT;
  const fits = beats.filter((beat) => beat - start >= 1.5 - 1e-6 && beat <= last + 1e-6);
  const near = fits.sort((a, b) => Math.abs(a - start - 2.5) - Math.abs(b - start - 2.5))[0];
  return sec(near ?? Math.max(start + 0.5, Math.min(start + 2.5, last)));
}

/**
 * The edit ops of one kino-built sketch on a fresh scene of `frame` {width, height}: each clip full
 * frame (cropped to fill by coverBox), cut on the beats; the song from its entry with a short fade
 * out; the line large and centered, entering on a beat with the mask entrance and leaving on a beat
 * (lineExit), in `font`. `calm` {blur, dim} (engine/quality/legible.js, a busy picture): while the
 * line is on, the clips are blurred by `blur` px and a black layer dims them by `dim`.
 * clips [{src, type: "video"|"image", width, height, duration, in}], song {src, from, beats} or null.
 */
export function sketchOps({ frame, seconds, clips = [], song = null, line = "", font = null, coverBox, calm = null }) {
  const beats = song?.beats ?? [];
  const starts = cutTimes(clips.length, seconds, beats);
  const ops = clips.map((clip, index) => {
    const start = starts[index];
    const length = sec((starts[index + 1] ?? seconds) - start);
    const box = coverBox({ width: clip.width || frame.width, height: clip.height || frame.height }, frame);
    const offset = clip.type === "video" ? sec(Math.max(0, Math.min(clip.in ?? 0, (clip.duration || Infinity) - length))) : 0;
    return { op: "add_layer", layerType: clip.type, name: `sketch-clip-${index + 1}`,
      properties: { src: clip.src, ...box, mediaStart: start, mediaDuration: length, ...(clip.type === "video" ? { mediaOffset: offset, mediaFreeze: "last", volume: song ? 0 : 1 } : {}) } };
  });
  if (song) ops.push({ op: "add_layer", layerType: "audio", name: "sketch-song", properties: { src: song.src, mediaStart: 0, mediaDuration: seconds, mediaOffset: song.from, volume: 0.8 },
    animations: [{ kind: "custom", name: "Song out", start: sec(seconds - 0.4), duration: 0.4, easing: "quart-out", from: { volume: 0.8 }, to: { volume: 0 } }] });
  if (line) {
    const size = Math.round(Math.min(frame.height * 0.13, (frame.width * 0.84 * 1.6) / Math.max(8, line.length)));
    const start = lineEntry(beats);
    const leave = lineExit(beats, start, seconds);
    if (calm) {
      const ease = (key, on, off) => [{ kind: "in", name: "Calm in", start, duration: CALM_IN, easing: "smooth", from: { [key]: off }, to: { [key]: on } },
        { kind: "custom", name: "Calm out", start: leave, duration: CALM_OUT, easing: "smooth", from: { [key]: on }, to: { [key]: off } }];
      ops.forEach((op) => { if (op.layerType === "video" || op.layerType === "image") op.animations = ease("blur", calm.blur, 0); });
      ops.push({ op: "add_layer", layerType: "rectangle", name: "sketch-dim", properties: { x: 0, y: 0, width: frame.width, height: frame.height, fill: "#000000", opacity: calm.dim },
        animations: ease("opacity", calm.dim, 0) });
    }
    // The exit is the entrance reversed (by word), done in LINE_EXIT.
    const words = line.split(" ").length;
    ops.push({ op: "add_layer", layerType: "text", name: "sketch-line",
      properties: { text: line, x: Math.round(frame.width * 0.08), y: Math.round(frame.height / 2 - size * 0.75), width: Math.round(frame.width * 0.84), height: Math.round(size * 1.5),
        fontSize: size, fill: "#ffffff", textAlign: "center", verticalAlign: "middle" },
      // By word: the text mask's own letter stagger (0.15 s a letter) took 4 s to show a 27-letter line.
      animations: [{ preset: "preset-mask", start, duration: 0.5, unit: "words", stagger: 0.06 },
        { preset: "preset-mask", kind: "out", start: leave, duration: sec(Math.max(0.15, LINE_EXIT - 0.03 * (words - 1))), unit: "words", stagger: 0.03 },
        // Gone after its exit, so the lettering share counts only the time it was on.
        { kind: "custom", name: "Line gone", start: sec(leave + LINE_EXIT), duration: 0.03, from: { opacity: 1 }, to: { opacity: 0 } }] });
    if (font) ops.push({ op: "set_font", layers: ["sketch-line"], family: font });
  }
  return ops;
}

/**
 * The ops that apply a measured legibility fix (engine/quality/legible.js legibleFix) to a built
 * sketch's line: `box` its ink box, `size` its drawn size, `start` when it enters. A scrim is a
 * full-width band, solid behind the line and its busy margin, fading out above and below; a scrim
 * or plate fades in with the line.
 */
export function lineFixOps(fix, { box, size, start, frame, lineY = 0 }) {
  if (!fix) return [];
  const entrance = [{ preset: "preset-fade", start, duration: 0.4 }];
  const below = (name) => ({ op: "move_layers", layers: [name], position: "below", referenceId: "sketch-line" });
  if (fix.kind === "scrim") {
    const pad = Math.round(size * 0.15), fade = 2 * Math.round(size * 0.6);
    const y = Math.max(0, Math.round(box.y0 - pad - fade));
    const height = Math.min(frame.height, Math.round(box.y1 + pad + fade)) - y;
    const edge = Math.min(0.45, sec(fade / Math.max(1, height)));
    const solid = `#000000${Math.round(fix.alpha * 255).toString(16).padStart(2, "0")}`;
    return [{ op: "add_layer", layerType: "rectangle", name: "sketch-line-scrim", properties: { x: 0, y, width: frame.width, height,
      fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#00000000" }, { offset: edge, color: solid }, { offset: sec(1 - edge), color: solid }, { offset: 1, color: "#00000000" }] } }, animations: entrance }, below("sketch-line-scrim")];
  }
  if (fix.kind === "halo") return [{ op: "update_layer", layer: "sketch-line", properties: { shadow: fix.shadow } }];
  if (fix.kind === "place") return [{ op: "update_layer", layer: "sketch-line", properties: { y: Math.round(lineY + fix.dy) } }];
  if (fix.kind === "size") return [{ op: "update_layer", layer: "sketch-line", properties: { fontSize: fix.fontSize } }];
  const margin = fix.margin;
  return [{ op: "add_layer", layerType: "rectangle", name: "sketch-line-plate", properties: { x: Math.round(box.x0 - margin), y: Math.round(box.y0 - margin),
    width: Math.round(box.x1 - box.x0 + 2 * margin), height: Math.round(box.y1 - box.y0 + 2 * margin), fill: fix.fill }, animations: entrance }, below("sketch-line-plate")];
}

/** The receipt's words for a line fix: "line over busy picture: scrim 50%" (facts, with the measured contrast). */
export function lineFixText(legible) {
  if (!legible?.fix) return null;
  const { fix, before, required } = legible;
  const why = before.busy >= (fix.kind === "picture" ? BUSY_SHARE / 2 : BUSY_SHARE) ? `busy picture (${Math.round(before.busy * 100)}% edge pixels)` : "low contrast picture";
  if (fix.kind === "picture")
    return `line over ${why}: picture blurred ${fix.blur} px and dimmed ${Math.round(fix.dim * 100)}% while the line is on (to ${Math.round(fix.after.busy * 100)}%; contrast ${before.contrast}:1 to ${fix.after.contrast}:1${fix.short ? `; the strongest step, short of under ${Math.round(BUSY_SHARE * 50)}% edge pixels and ${required}:1` : ""})`;
  const what = fix.kind === "scrim" ? `scrim ${Math.round(fix.alpha * 100)}%` : fix.kind === "halo" ? "halo shadow"
    : fix.kind === "place" ? `moved ${Math.abs(fix.dy)} px ${fix.dy < 0 ? "up" : "down"}` : fix.kind === "size" ? `font size ${fix.fontSize}` : `solid plate ${fix.fill}`;
  return `line over ${why}: ${what} (contrast ${before.contrast}:1 to ${fix.after.contrast}:1, ${required}:1 needed; edge pixels ${Math.round(before.busy * 100)}% to ${Math.round(fix.after.busy * 100)}%, under ${Math.round(BUSY_SHARE * 100)}% needed)`;
}

/**
 * A treatment's defaults for a built sketch: the line is the first quoted words of its move or idea
 * ('312 keyframes'), else none; the clips are the project files its source names, each `in` the
 * first seconds number after the name. `files` [{name, ...}] are the project's files.
 */
export function treatmentDefaults(entry, files = []) {
  // A quote opens after a space or the start and closes before a non-letter, so "agent's" is no quote.
  const quoted = /(?:^|[\s(:,])['"‘“]([^'"‘’“”]{2,80})['"’”](?![a-z])/i.exec(`${entry?.move ?? ""} ${entry?.idea ?? ""}`)?.[1]?.trim() ?? null;
  const source = String(entry?.source ?? "");
  const clips = [];
  for (const file of files) {
    const stem = String(file.name ?? "").replace(/\.[a-z0-9]+$/i, "");
    const at = stem.length >= 2 ? source.toLowerCase().indexOf(stem.toLowerCase()) : -1;
    if (at < 0) continue;
    const seconds = /^[^;,]*?(\d+(?:\.\d+)?)\s*s\b/.exec(source.slice(at + stem.length))?.[1];
    clips.push({ at, clip: { file: file.name, ...(seconds !== undefined ? { in: Number(seconds) } : {}) } });
  }
  return { line: quoted, clips: clips.sort((a, b) => a.at - b.at).map((entry) => entry.clip).slice(0, CLIPS_MOST) };
}

/** What a picked sketch carries to later steps: its song (file and stretch), font and line, or null. */
export function sketchCarry(round, option) {
  if (!option?.song && !option?.font && !option?.line) return null;
  const song = option.song?.src ? { song: option.song.src, songTitle: option.song.title, songFrom: option.song.from, songTo: option.song.to } : { song: null, songFrom: null };
  return { round: round.id, letter: option.letter, ...song, font: option.font ?? null, line: option.line ?? null };
}

/**
 * The sketch the person picked, for later steps (the storyboard's music, the style's fonts):
 * { song (media src), songTitle, songFrom, songTo, font, line, round, letter } or null. With a
 * picked treatment it is that pick's sketch (none when they picked by typing); else the last
 * picked round of named sketches.
 */
export function pickedSketch(state) {
  const picked = state?.brief?.treatments?.picked;
  if (picked) return picked.sketch ?? null;
  const round = [...(state?.tries ?? [])].reverse().find((entry) => entry.sketch && entry.status === "picked");
  return round ? sketchCarry(round, round.options.find((option) => option.letter === round.pick)) : null;
}

/** The letters a sketch can name: the 3 shown (A to C), and D when the dropped one is listed. */
function shownLetters(treatments, known) {
  return [...LABELS.slice(0, treatments.shown.length), ...(known ? [KNOWN_LABEL] : [])];
}

/** The treatment entry behind a letter. */
export function treatmentOf(treatments, letter) {
  const index = letter === KNOWN_LABEL ? treatments.dropped : treatments.shown[LABELS.indexOf(letter)];
  return treatments.list[index];
}

/**
 * Reads the sketch part of a try input (throws its words when a field is wrong): {from, to,
 * treatments:[letter per option], names:[default name per option], ideas:[the treatment's idea]}.
 * `treatments` is the saved brief.treatments; `known` true lets D (the dropped one the ask is known
 * for) be named. A stretch whose options name no treatment is a sketch round of named options
 * (sound and numbers, no treatment pick): letters, names and ideas are null.
 */
export function readSketch(input, scene, treatments, known = false, built = false) {
  // A built sketch starts at 0 on its own fresh scene: seconds (or to - from) long.
  const length = built ? Number(input.seconds ?? (input.from !== undefined && input.to !== undefined ? input.to - input.from : SKETCH_SECONDS)) : null;
  if (built && !(length >= SKETCH_LEAST - 1e-6 && length <= SKETCH_MOST + 1e-6)) throw new Error(`seconds is the sketch length, ${SKETCH_LEAST} to ${SKETCH_MOST} (default ${SKETCH_SECONDS}).`);
  const extra = built ? { built: input.options.map(readBuilt) } : {};
  const from = built ? 0 : Number(input.from);
  const to = built ? length : Number(input.to);
  if (built) scene = { ...scene, duration: length };
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > scene.duration + 1e-6 || to - from < SKETCH_LEAST - 1e-6 || to - from > SKETCH_MOST + 1e-6)
    throw new Error(`A sketch is one stretch of the scene: from and to in seconds, ${SKETCH_LEAST} to ${SKETCH_MOST} s long, inside 0 to ${sec(scene.duration)} s.`);
  if (!input.options.some((option) => option?.treatment !== undefined)) {
    input.options.forEach((option, index) => { if (JSON.stringify(option?.ops ?? []).length > SKETCH_OPS_MOST) throw new Error(`options[${index}].ops is over ${SKETCH_OPS_MOST} characters: sketch the stretch with fewer layers.`); });
    const none = input.options.map(() => null);
    return { from: sec(from), to: sec(to), treatments: none, names: none, ideas: none, ...extra };
  }
  if (!treatments?.list) throw new Error('options[].treatment names a saved treatment, and this project has none: leave treatment out and give each sketch a name, or save the 5 first (notes brief fields:{treatments:[...]}).');
  const letters = shownLetters(treatments, known);
  const picked = input.options.map((option, index) => {
    const named = String(option?.treatment ?? "").trim();
    const letter = letters.find((entry) => entry === named.toUpperCase())
      ?? letters.find((entry) => { const item = treatmentOf(treatments, entry); return [item.idea, item.move].some((text) => text?.toLowerCase() === named.toLowerCase()); });
    if (!letter) throw new Error(`options[${index}].treatment is the letter of a shown treatment (${letters.join(", ")}), the one this sketch shows.`);
    if (JSON.stringify(option.ops ?? []).length > SKETCH_OPS_MOST) throw new Error(`options[${index}].ops is over ${SKETCH_OPS_MOST} characters: sketch the stretch with fewer layers.`);
    return letter;
  });
  if (new Set(picked).size !== picked.length) throw new Error("Each sketch shows its own treatment.");
  return { from: sec(from), to: sec(to), treatments: picked, names: picked.map((letter) => treatmentOf(treatments, letter).move),
    ideas: picked.map((letter) => treatmentOf(treatments, letter).idea ?? null), ...extra };
}

/** The cache key of one sketch: the document before its ops, the ops, the scene and the stretch. */
export function sketchKey(document, ops, sceneId, from, to) {
  return createHash("sha256").update(JSON.stringify({ document, ops, sceneId, from, to, sound: true, measure: [MEASURE_FPS, CHANGE_AT] })).digest("hex").slice(0, 32);
}

/** The cache folder's clip and numbers of a key, and a way to keep the newest CACHE_KEPT. */
export function sketchCache(folder) {
  const clip = (key) => path.join(folder, `${key}.mp4`);
  const facts = (key) => path.join(folder, `${key}.json`);
  return {
    /** Copies a cached clip to `outputPath` and answers its saved numbers, or null when not cached. */
    async take(key, outputPath) {
      try {
        const saved = JSON.parse(await readFile(facts(key), "utf8"));
        await copyFile(clip(key), outputPath);
        return saved;
      } catch { return null; }
    },
    async keep(key, outputPath, saved) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await copyFile(outputPath, clip(key));
      await writeFile(facts(key), JSON.stringify(saved));
      const names = (await readdir(folder)).filter((name) => name.endsWith(".mp4"));
      if (names.length <= CACHE_KEPT) return;
      const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(folder, name))).mtimeMs })));
      for (const { name } of dated.sort((a, b) => a.at - b.at).slice(0, names.length - CACHE_KEPT)) {
        await rm(path.join(folder, name), { force: true });
        await rm(path.join(folder, name.replace(/\.mp4$/, ".json")), { force: true });
      }
    },
  };
}

/**
 * The share of sampled times (MEASURE_FPS) from `from` to `to` at which a text layer of the scene is
 * shown (visible, not see-through, inside shown groups): lettering on screen, from the document.
 */
export function letteringShare(scene, from, to) {
  if (!scene.layers.some((layer) => layer.type === "text")) return 0;
  const count = Math.max(1, Math.round((to - from) * MEASURE_FPS));
  let shown = 0;
  for (let index = 0; index < count; index += 1) {
    const evaluated = evaluateScene(scene, from + (index + 0.5) / MEASURE_FPS);
    const byId = new Map(evaluated.layers.map((layer) => [layer.id, layer]));
    const seen = (layer, depth = 0) => layer.visible !== false && (layer.opacity ?? 1) > 0.02
      && (!layer.parentId || !byId.has(layer.parentId) || depth > 32 || seen(byId.get(layer.parentId), depth + 1));
    if (evaluated.layers.some((layer) => layer.type === "text" && String(layer.text ?? "").trim() && seen(layer))) shown += 1;
  }
  return shown / count;
}

/** The mean brightness change between two frames' block grids (lumaGrid), 0 to 1. */
export const blockChange = (a, b) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / Math.max(1, a.length);

/**
 * The numbers of one rendered sketch from its sampled frames ([{cells, pixels}], MEASURE_FPS) and
 * its loudness: picture changes (cuts, flashes and hard swaps alike), median shot seconds, the 3
 * biggest colors and the integrated loudness. `lettering` comes from letteringShare.
 */
export function clipFacts(frames, { seconds, lufs = null, lettering = null }) {
  const changes = [];
  let last = -2;
  for (let index = 1; index < frames.length; index += 1) {
    if (blockChange(frames[index - 1].cells, frames[index].cells) < CHANGE_AT) continue;
    // Two changed samples in a row are one change (a two-frame dissolve or a flash in and out).
    if (index - last > 1) changes.push(index / MEASURE_FPS);
    last = index;
  }
  const edges = [0, ...changes, seconds];
  const shots = edges.slice(1).map((time, index) => time - edges[index]).filter((length) => length > 0);
  const colors = palette(frames.flatMap((frame) => frame.pixels), 4).slice(0, 3);
  return { changes: changes.length, shot: sec(median(shots) ?? seconds), lettering: lettering === null ? null : Math.round(lettering * 100) / 100,
    lufs: Number.isFinite(lufs) ? Math.round(lufs * 10) / 10 : null, colors };
}

const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const near = (a, b) => Math.hypot(...rgb(a).map((value, index) => value - rgb(b)[index])) <= SAME_COLOR;

/**
 * The share of the picture two sketches color alike (0 to 1): each of a's colors counts the smaller
 * of its share and the share of b's near colors, so a frame 97% black and one 70% dark overlap 70%,
 * not "3 of 3 shared".
 */
export function colorOverlap(a, b) {
  let total = 0;
  for (const color of a.colors) total += Math.min(color.share, b.colors.filter((other) => near(color.hex, other.hex)).reduce((sum, other) => sum + other.share, 0));
  return Math.min(1, total);
}

// How far apart two sketches are, as one number for finding the closest pair: each fact's gap over
// its usual range, added up (a plain sum; the receipt prints the facts themselves).
function gap(a, b) {
  const part = (x, y, range) => (x === null || y === null ? 0 : Math.min(1, Math.abs(x - y) / range));
  return part(a.changes, b.changes, 6) + part(a.shot, b.shot, 2) + part(a.lettering, b.lettering, 0.5) + part(a.lufs, b.lufs, 6)
    + (1 - colorOverlap(a, b));
}

const factText = (facts) => [
  `${facts.changes} picture change${facts.changes === 1 ? "" : "s"}`, `median shot ${facts.shot} s`,
  facts.lettering === null ? null : `lettering ${Math.round(facts.lettering * 100)}% of frames`,
  facts.lufs === null ? "no sound" : `${facts.lufs} LUFS`,
  facts.colors.length ? `colors ${facts.colors.map((color) => `${color.hex} ${Math.round(color.share * 100)}%`).join(", ")}` : null,
].filter(Boolean).join(", ");

// A built sketch's song (title, the stretch of the song) and font, and the line's source.
const builtText = (option) => {
  if (!option.built) return "";
  const song = option.song?.src ? `song "${option.song.title}" ${option.song.from}-${option.song.to} s of the song (${option.song.kind})`
    : option.song?.error ? `silent: the song "${option.song.asked}" could not be fetched (${option.song.error})` : "no song (silent)";
  const line = option.line ? `line "${option.line}" (${option.lineFrom}${option.lineAt ? `, on ${option.lineAt[0]} to ${option.lineAt[1]} s` : ""})` : "no line";
  return `; ${song}; font ${option.font ?? "the default"}; ${line}; ${option.cuts ?? 0} cut${option.cuts === 1 ? "" : "s"}${option.cuts && option.song?.src ? " on the song's beats" : ""}${option.lineFix ? `; ${option.lineFix}` : ""}`;
};

/**
 * The receipt lines of a rendered sketch round: one per sketch (render seconds per sketch second,
 * measured, or cached) and the closest pair side by side. `options` [{letter, name, treatment,
 * renderSeconds, cached, facts, error}].
 */
export function sketchLines(round) {
  const length = Math.max(0.01, round.to - round.from);
  const lines = round.options.map((option) => {
    const head = option.treatment ? `${option.letter} (treatment ${option.treatment}, ${option.name})` : `${option.letter} (${option.name})`;
    if (option.error) return `${head}: could not be made: ${option.error}`;
    if (!option.facts) return `${head}: still rendering`;
    const made = option.cached ? "cached, not rendered again" : `rendered in ${sec(option.renderSeconds)} s, ${sec(option.renderSeconds / length)} s per sketch second (measured on this machine)`;
    return `${head}: ${made}; ${factText(option.facts)}${builtText(option)}`;
  });
  // Two sketches on one song or one font: said once, as a fact.
  for (const [key, label] of [["song", "song"], ["font", "font"]]) {
    const named = round.options.filter((option) => option.built).map((option) => [option.letter, key === "song" ? option.song?.src ?? null : option.font]).filter(([, value]) => value);
    const same = named.filter(([, value], index) => named.some(([, other], at) => at !== index && other === value));
    if (same.length) lines.push(`${same.map(([letter]) => letter).join(" and ")} use the same ${label}${key === "font" ? ` (${same[0][1]})` : ""}.`);
  }
  const done = round.options.filter((option) => option.facts);
  let closest = null;
  for (let i = 0; i < done.length; i += 1)
    for (let j = i + 1; j < done.length; j += 1) {
      const distance = gap(done[i].facts, done[j].facts);
      if (!closest || distance < closest.distance) closest = { a: done[i], b: done[j], distance };
    }
  if (closest) {
    const { a, b } = closest;
    const pair = (key, unit = "") => `${a.facts[key] ?? "none"}${unit} vs ${b.facts[key] ?? "none"}${unit}`;
    lines.push(`closest pair: ${a.letter} and ${b.letter}: picture changes ${pair("changes")}, median shot ${pair("shot", " s")}, lettering ${a.facts.lettering === null ? "?" : Math.round(a.facts.lettering * 100)}% vs ${b.facts.lettering === null ? "?" : Math.round(b.facts.lettering * 100)}%, loudness ${pair("lufs", " LUFS")}, colors overlap ${Math.round(colorOverlap(a.facts, b.facts) * 100)}% of the picture`);
  }
  lines.push(`(a picture change: ${MEASURE_FPS} samples a second, mean block brightness moved ${CHANGE_AT} or more from the sample before, a starting value)`);
  return lines;
}

// ---- measuring a clip file ----------------------------------------------------------------------

function run(args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-20000); });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve({ out: binary ? Buffer.concat(out) : Buffer.concat(out).toString("utf8"), err }) : reject(new Error(err.trim().split("\n").at(-1) || `ffmpeg exited ${code}`))));
  });
}

/** The numbers of the sketch rendered to `file` from `document` (scene `sceneId`, `from` to `to`). */
export async function measureSketch(document, sceneId, from, to, file) {
  const scene = document.scenes.find((entry) => entry.id === sceneId);
  const { frames, lufs } = await measureClipFile(file);
  let lettering = null;
  try { lettering = scene ? letteringShare(scene, from, to) : null; } catch { lettering = null; }
  return clipFacts(frames, { seconds: to - from, lufs, lettering });
}

/** The mean brightness (0 to 1) of each 4 × 4 pixel block of a MEASURE_W × MEASURE_H RGBA frame. */
export function lumaGrid(bytes) {
  const cols = MEASURE_W / 4, rows = MEASURE_H / 4;
  const grid = new Array(cols * rows).fill(0);
  for (let y = 0; y < MEASURE_H; y += 1)
    for (let x = 0; x < MEASURE_W; x += 1) {
      const at = (y * MEASURE_W + x) * 4;
      grid[Math.floor(y / 4) * cols + Math.floor(x / 4)] += (0.2126 * bytes[at] + 0.7152 * bytes[at + 1] + 0.0722 * bytes[at + 2]) / 255 / 16;
    }
  return grid;
}

/** The sampled frames ([{hist, pixels, cells}]) and integrated loudness (LUFS, null without sound) of a clip file. */
export async function measureClipFile(file) {
  const { out } = await run(["-v", "error", "-nostdin", "-i", file, "-vf", `fps=${MEASURE_FPS},scale=${MEASURE_W}:${MEASURE_H}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { binary: true });
  const size = MEASURE_W * MEASURE_H * 4;
  const frames = [];
  for (let at = 0; at + size <= out.length; at += size) {
    const stats = pixelStats(out.subarray(at, at + size), MEASURE_W, MEASURE_H, { order: "rgba", palettePixels: 36 });
    frames.push({ pixels: stats.pixels, cells: lumaGrid(out.subarray(at, at + size)) });
  }
  let lufs = null;
  try {
    const { err } = await run(["-hide_banner", "-nostats", "-nostdin", "-i", file, "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    const found = [...err.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].at(-1)?.[1];
    lufs = found && found !== "-inf" ? Number(found) : null;
  } catch { lufs = null; }
  return { frames, lufs };
}
