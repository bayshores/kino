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
import { MOVES, MOVE_NAMES } from "../../engine/blocks/moves/index.js";
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

// The fields kino builds a sketch from itself (song, font, line, clips, type, together), and the default length.
export const BUILT_FIELDS = ["song", "font", "line", "clips", "type", "together", "move"];
export const SKETCH_SECONDS = 6;
const CLIPS_MOST = 6;
// Song beats that get a cue (beat-1..) for an option's own ops.
const CUE_BEATS = 16;

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
  if (option?.together !== undefined && typeof option.together !== "boolean") throw new Error(`options[${index}].together is true (every clip on for the whole sketch, for a move that shows several at once) or left out.`);
  const move = option?.move;
  const moveName = typeof move === "string" ? move.trim() : move && typeof move === "object" && !Array.isArray(move) ? String(move.name ?? "").trim() : move === undefined ? undefined : "";
  if (moveName !== undefined && moveName !== "none" && !movePlan(moveName))
    throw new Error(`options[${index}].move is one of kino's moves by name (library {topic:"moves"}), one of the sketch's own (${Object.keys(SKETCH_MOVES).join(", ")}), {name, ...its fields}, or "none"${moveName ? `: "${moveName}" is not one` : ""}.`);
  return { song: text("song", 200), font: text("font", 80), line: text("line", 200), type: text("type", 80), ...(option?.together ? { together: true } : {}),
    ...(moveName !== undefined ? { move: typeof move === "string" ? { name: moveName } : { ...move, name: moveName } } : {}), clips: clips?.map((clip) => ({ file: clip.file.trim(), ...(clip.in !== undefined ? { in: Number(clip.in) } : {}) })) };
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

// ---- how the line is set ------------------------------------------------------------------------
// A treatment says its own type in words (treatments.mjs `type`: "<family class>, <size>, <case>,
// <how it appears>"), and a built sketch shows it: kino reads the size, the case, the place and
// how the line appears from those words, so sketches of three type directions do not arrive the
// same way. Of two sizes (or two ways to appear) the words name, the first named wins. What the
// words do not say is shown plainly: big, in the middle, cut on with a beat.

// How a line can appear, in the order the words are tried: the key, what the receipt calls it,
// and the words that name it.
const APPEAR_WORDS = [
  ["typed", "typed on with a caret", /\b(?:typed|typing|types? (?:on|out|itself)|typewriter|cursor|caret|keystrokes?)\b/i],
  ["beat", "one word a beat", /\bone (?:word|numeral|number) (?:per|a|an|each|every|at a|on)\b|\b(?:word|numeral|number)s? (?:per|a|each|every) (?:beat|cut|hit|kick|bar)\b|\bsingle words?\b|\bwords? flash\w*/i],
  ["words", "word by word, cut on", /\b(?:each word|word[- ]by[- ]word|by word|per word|words? (?:cuts?|lands?|hits?|pops?|snaps?))\b/i],
  ["decode", "decoded from random letters", /\b(?:decod\w*|scrambl\w*|cipher\w*|computed)\b/i],
  ["stream", "streamed in word by word", /\bstream\w*\b/i],
  ["assemble", "letters flying together", /\b(?:assembl\w*|scatter\w*|fl(?:y|ies|ying) together)\b/i],
  ["cut", "cut on whole", /\b(?:cuts? (?:in|on)|cut-on|hard[- ]cuts?|whole|static|no animation|(?:snap|pop|slam|stamp)\w*)\b/i],
  ["slide", "slid in", /\b(?:slid\w*|push\w* (?:in|up)|scroll\w*|crawl\w*|ticker)\b/i],
  ["mask", "risen through a mask, word by word", /\b(?:mask\w*|ris(?:e|es|ing)|reveal\w*)\b/i],
  ["blur", "out of a blur", /\b(?:blur\w*|defocus\w*|focus\w*)\b/i],
  ["wipe", "wiped on", /\bwip\w*\b/i],
  ["grow", "grown in", /\b(?:grow\w*|scal\w*|zoom\w*|punch\w*|expand\w*)\b/i],
  ["fade", "faded in", /\b(?:fad\w*|dissolv\w*)\b/i],
];
const SIZE_WORDS = [
  ["giant", /\b(?:giant|huge|massive|enormous|oversized?|full[- ](?:frame|width|screen|bleed)|wall[- ]to[- ]wall|edge[- ]to[- ]edge)\b/i],
  ["small", /\b(?:small|tiny|little|captions?|labels?|subtitles?|fine print|footnotes?)\b/i],
  ["big", /\b(?:big|large|bold|headline|display|heavy)\b/i],
];
const CASE_WORDS = [["upper", /\b(?:caps|capitals?|upper[- ]?case|all[- ]caps)\b/i], ["lower", /\blower[- ]?case\b/i]];
const PLACE_WORDS = [["low", /\b(?:lower[- ]third|low|bottom|captions?|subtitles?)\b/i], ["top", /\b(?:top|upper[- ]third|header)\b/i]];
const ON_BLACK = /\bon (?:a )?black\b|\bblack (?:cards?|frames?|screens?)\b/i;
/** What the receipt calls each way to appear ({typed: "typed on with a caret", ...}). */
export const APPEARS = Object.freeze(Object.fromEntries(APPEAR_WORDS.map(([key, words]) => [key, words])));
// The ways by name, for a receipt whose type words named none.
const APPEAR_NAMES = "typed, one word a beat, word by word, cut, slide, mask, blur, wipe, grow, fade, stream, decode, assemble";
// The entrance preset of the ways that are one (the others are a cut, a text swap or a move).
const APPEAR_PRESET = Object.freeze({ slide: "preset-slide", mask: "preset-mask", blur: "preset-blur", wipe: "preset-wipe", grow: "preset-grow", fade: "preset-fade" });
const APPEAR_MOVE = Object.freeze({ typed: "type-on", decode: "decode", stream: "stream", assemble: "assemble" });

// The key whose words come first in the text, or null. rows: [key, ..., pattern].
function firstNamed(text, rows) {
  let found = null;
  for (const row of rows) {
    const at = row.at(-1).exec(text)?.index;
    if (at !== undefined && (!found || at < found.at)) found = { key: row[0], at };
  }
  return found?.key ?? null;
}

/**
 * A type direction in words, read: {appear, size, case, place, black}, each null (false for
 * black) when the words do not say it. `appear` is a key of APPEARS, `size` giant, big or small,
 * `case` upper or lower, `place` low or top, `black` true for a line set on black.
 */
export function readType(text) {
  const words = String(text ?? "");
  return { appear: firstNamed(words, APPEAR_WORDS), size: firstNamed(words, SIZE_WORDS), case: firstNamed(words, CASE_WORDS), place: firstNamed(words, PLACE_WORDS), black: ON_BLACK.test(words) };
}

// Where the line sits when the words do not say: a small line low (a caption), unless it is on black.
const placeOf = (read) => read.place ?? (read.size === "small" && !read.black ? "low" : "middle");

/** The receipt's words for how a sketch's line is set: "giant, upper case, cut on whole (from "giant caps, cut in whole")". */
export function typeText(read, said = null) {
  if (!read) return null;
  const parts = [read.size ?? "big", read.case ? `${read.case} case` : null, placeOf(read), read.black ? "on black" : null,
    read.appear ? APPEARS[read.appear] : `${APPEARS.cut} (the words name no way to appear: ${APPEAR_NAMES})`].filter(Boolean);
  return `${parts.join(", ")}${said ? ` (from "${said}")` : ""}`;
}

// The line's share of the frame height, the share of the width it may fill and the fewest
// letters it is fitted for, by size. 1.6 letters per font size of width fits a monospace line.
const SIZES = Object.freeze({ giant: { share: 0.34, width: 0.92, least: 3 }, big: { share: 0.13, width: 0.84, least: 8 }, small: { share: 0.05, width: 0.7, least: 20 } });
const LETTERS_PER_SIZE = 1.6;
// The middle of the line, as a share of the frame height.
const PLACES = Object.freeze({ low: 0.82, top: 0.16, middle: 0.5 });

// The usual seconds between two beats (the median gap), or null without two beats.
const beatGap = (beats) => median(beats.slice(1).map((beat, index) => beat - beats[index]));

/**
 * When a sketch's line is on: {start, leave, step, appear}. It enters on the beat nearest 0.5 s
 * and leaves on a beat about 2.5 s later (lineExit). One word a beat shows each word alone for one
 * `step` (a beat; half beats when the words do not fit) and leaves after the last; word by word
 * adds a word each `step`, all of them on within the first 60% of its time. One word is a cut.
 */
export function lineWindow({ beats = [], seconds, line = "", type = null }) {
  const count = line.split(" ").length;
  const asked = type?.appear ?? "cut";
  const appear = count < 2 && (asked === "beat" || asked === "words") ? "cut" : asked;
  const start = lineEntry(beats);
  const gap = beatGap(beats) ?? 0.5;
  if (appear === "beat") {
    const room = seconds - 0.4 - start;
    let step = gap;
    while (step * count > room && step > 0.2) step /= 2;
    return { start, leave: sec(Math.min(seconds - 0.4, start + step * count)), step: sec(step), appear };
  }
  const leave = lineExit(beats, start, seconds);
  if (appear !== "words") return { start, leave, step: null, appear };
  let step = gap;
  while (step * (count - 1) > (leave - start) * 0.6 && step > 0.06) step /= 2;
  return { start, leave, step: sec(step), appear };
}

// A long giant line is set on two rows: the break that leaves the shorter longest row.
function twoRows(words) {
  let best = null;
  for (let at = 1; at < words.length; at += 1) {
    const rows = [words.slice(0, at).join(" "), words.slice(at).join(" ")];
    const longest = Math.max(rows[0].length, rows[1].length);
    if (!best || longest < best.longest) best = { rows, longest };
  }
  return best;
}

// ---- the sketch's move --------------------------------------------------------------------------
// A treatment names its signature move in words. A built sketch shows it: `move` is one of kino's
// moves (engine/blocks/moves: a transition lands on every cut, split-screen shows the clips at
// once, count-up counts the line's number, ...) or one of the sketch's own below, and kino places
// it on the sketch's layers itself. Without `move`, kino reads one from the treatment's words. An
// earlier form asked the agent for the move's ops: one run wrote real ones, the next filled the
// slot with a second copy of the line.

/** The sketch's own moves, beside kino's move library. */
export const SKETCH_MOVES = Object.freeze({
  push: "the camera pushes in on each clip (scale, point)",
  pull: "the camera pulls out of each clip (scale, point)",
  "fast-cuts": "a cut on every beat through the clips",
  card: "the line alone on a dark card, then a hard cut to the picture",
});
// Plain words for a move, tried after the moves' own names (the first in the words wins).
const MOVE_WORDS = [
  ["push", /\b(?:push(?:es|ing)?(?: in)?|zooms? (?:in(?:to)?|from)|falls? away|dolly in)\b/i],
  ["pull", /\b(?:pulls?[- ]out|pull back|zooms? out|reverse reveal|pulls? away)\b/i],
  ["split-screen", /\b(?:split|side by side|two panes|beside|next to)\b/i],
  ["picture-in-picture", /\b(?:inset|picture in picture|in (?:a|the) corner)\b/i],
  ["count-up", /\b(?:counter|counts?(?: up)?|counting|clock|ticking|tally|timer)\b/i],
  ["fast-cuts", /\b(?:montage|(?:every|each|per) (?:cut|beat)|faster and faster|beat[- ]cuts?|rapid cuts?|quick cuts?)\b/i],
  ["card", /\b(?:(?:type|title|text) cards?|on a card|hard[- ]cuts? to)\b/i],
  ["whip-pan", /\bwhips?\b/i],
  ["freeze-shutter", /\b(?:freeze\w*|freezes?[- ]frame|stops? dead)\b/i],
  ["speed-ramp", /\b(?:speed[- ]ramps?|slow[- ]mo\w*|slows? (?:down|into)|ramps?)\b/i],
  ["beat-repeat", /\b(?:stutters?|repeats? on|replay\w*)\b/i],
  ["masked-type", /\b(?:made of (?:the )?footage|through the letters|footage inside)\b/i],
  ["zoom-through", /\bzooms? through\b/i],
  ["punch-in", /\bpunch(?:es)?[- ]ins?\b/i],
];
const MOVE_PATTERNS = [...MOVE_NAMES, ...Object.keys(SKETCH_MOVES)].map((name) => [name, new RegExp(`\\b${name.replace(/-/g, "[- ]")}\\b`, "i")]);

/** The move a treatment's words name: one of kino's moves by its own name, else by plain words, or null. */
export function readMove(text) {
  const words = String(text ?? "");
  return firstNamed(words, MOVE_PATTERNS) ?? firstNamed(words, MOVE_WORDS);
}

/**
 * How a move sits in a sketch, or null for an unknown name: {name, kind, clips (the fewest it
 * needs), together (every clip on at once), noLine (the move sets the line's words itself)}.
 * kind: own (the sketch's own), cut (a transition, on every cut), all (several clips at once),
 * inset (clip 2 over clip 1), clip (on the first clip), line (on the line), free (no layer of its own).
 */
export function movePlan(name) {
  if (SKETCH_MOVES[name]) return { name, kind: "own", clips: name === "fast-cuts" ? 2 : 1, ...(name === "fast-cuts" ? { fill: 4 } : {}), together: false, noLine: false };
  const fields = MOVES[name]?.fields;
  if (!fields) return null;
  const needs = (key) => fields[key]?.required === true;
  if (name === "count-up") return { name, kind: "line", clips: 1, together: false, noLine: false };
  if (name === "masked-type") return { name, kind: "clip", clips: 1, together: false, noLine: true };
  if (name === "picture-in-picture") return { name, kind: "inset", clips: 2, together: true, noLine: false };
  if (fields.from?.kind === "layer" && fields.to?.kind === "layer" && (needs("from") || needs("to"))) return { name, kind: "cut", clips: 2, together: false, noLine: false };
  if (needs("layers")) return { name, kind: "all", clips: 2, together: true, noLine: false };
  if (needs("layer")) return { name, kind: /text layer/.test(fields.layer.about ?? "") ? "line" : "clip", clips: 1, together: false, noLine: false };
  return { name, kind: "free", clips: 1, together: false, noLine: false };
}

/**
 * The ops that place a library move on a built sketch (after sketchOps): `given` are the option's
 * own fields for it (they win), `cuts` the cut times, `count` the clips, `start` when the line
 * enters, `line` the words.
 */
export function moveOps(plan, given = {}, { cuts = [], count = 0, start = 0.5, line = "", seconds = SKETCH_SECONDS, beats = [], leave = null } = {}) {
  if (!plan || plan.kind === "own") return [];
  const op = (fields) => ({ op: "move", name: plan.name, ...fields, ...given });
  const clip = (index) => `sketch-clip-${index}`;
  // A move on the first clip lands once the line has left and the picture is sharp again (a ramp
  // or a freeze needs a lead too); without a line, once the clip has played a little.
  const hit = sec(leave === null ? 1.2 : Math.min(Math.max(1.2, seconds - 2), leave + 0.6));
  if (plan.kind === "cut") return cuts.map((at, index) => op({ from: clip(index + 1), to: clip(index + 2), at }));
  // Several clips at once stay for the whole sketch (a move's own length is shorter).
  if (plan.kind === "all") return [op({ layers: Array.from({ length: count }, (_, index) => clip(index + 1)), at: 0, dur: seconds })];
  // The inset's clip goes under the main shot (clip 1), so only its inset shows.
  if (plan.kind === "inset") return [{ op: "move_layers", layers: [clip(2)], position: "bottom" }, op({ layer: clip(2), at: 0.3, dur: sec(seconds - 0.3) })];
  // masked-type holds 14 letters: the whole line when it fits, else its longest word.
  if (plan.name === "masked-type") {
    const text = line.length <= 14 ? line : line.split(/\s+/).filter((word) => word.length <= 14).sort((a, b) => b.length - a.length)[0];
    return [op({ layer: clip(1), ...(text ? { text } : {}), at: start })];
  }
  if (plan.name === "beat-repeat") return [op({ layer: clip(1), count: 3, every: sec(Math.min(1, Math.max(0.2, beatGap(beats) ?? 0.5))), at: hit })];
  if (plan.kind === "clip") return [op({ layer: clip(1), at: hit })];
  // count-up counts the line's own number as the line arrives; other line moves land once it is on.
  if (plan.kind === "line") return [op({ layer: "sketch-line", at: plan.name === "count-up" ? start : sec(start + 0.6) })];
  return [op({ at: start })];
}

/** The receipt's words for a sketch's move: "whip-pan on every cut", "push (the camera pushes in on each clip)". */
export function moveText(plan, said = null, why = null) {
  const from = said ? ` (read from "${said}")` : "";
  if (!plan && why) return `none in the sketch (${why})`;
  if (!plan) return `none in the sketch${said ? ` (no kino move read from "${said}"; name one: move:"<name>", library {topic:"moves"}, or ${Object.keys(SKETCH_MOVES).join(", ")})` : ""}`;
  const where = { own: SKETCH_MOVES[plan.name], cut: "on every cut", all: "every clip at once", inset: "clip 2 over clip 1", clip: "on the first clip", line: "on the line", free: "at the line's entrance" }[plan.kind];
  return `${plan.name} (${where})${from}`;
}

// The shots of a cut on every beat: the clips in turn, each from where the sketch's clock is.
const SHOTS_MOST = 14;
function beatShots(clips, seconds, beats) {
  const times = [0];
  const marks = beats.length ? beats : Array.from({ length: Math.floor(seconds / 0.5) }, (_, index) => (index + 1) * 0.5);
  for (const beat of marks) if (beat - times.at(-1) >= 0.25 && beat < seconds - 0.25 && times.length < SHOTS_MOST) times.push(sec(beat));
  return times.map((at, index) => ({ ...clips[index % clips.length], in: sec((clips[index % clips.length].in ?? 0) + at), at }));
}

/**
 * The edit ops of one kino-built sketch on a fresh scene of `frame` {width, height}: each clip full
 * frame (cropped to fill by coverBox), cut on the beats (`together`: every clip on for the whole
 * sketch, the last on top, for a move that shows several at once; `everyBeat`: a cut on every
 * beat through the clips; `camera` {dir: "push"|"pull", scale, point: [x%, y%]}: each clip grows
 * into or out of that point while it is on); the song from its entry with a
 * short fade out; cues for an option's own ops (cut-2.. at the cuts, beat-1.. at the song's beats,
 * line-in and line-out); the line set and brought on as `type` reads (readType: size, case, place,
 * on black, how it appears; nothing read is big, in the middle, cut on), on a beat and off on a
 * beat (lineWindow), in `font` (`card`: alone on a dark card from the start, then a hard cut to
 * the picture). `calm` {blur, dim} (engine/quality/legible.js, a busy picture):
 * while the line is on, the clips are blurred by `blur` px and a black layer dims them by `dim`.
 * clips [{src, type: "video"|"image", width, height, duration, in}], song {src, from, beats} or null.
 */
export function sketchOps({ frame, seconds, clips: given = [], song = null, line = "", font = null, coverBox, calm = null, type = null, together = false, everyBeat = false, camera = null, card = false }) {
  const beats = song?.beats ?? [];
  const clips = everyBeat && given.length ? beatShots(given, seconds, beats) : given;
  const starts = together ? clips.map(() => 0) : everyBeat ? clips.map((clip) => clip.at) : cutTimes(clips.length, seconds, beats);
  const ops = clips.map((clip, index) => {
    const start = starts[index];
    const length = together ? seconds : sec((starts[index + 1] ?? seconds) - start);
    const box = coverBox({ width: clip.width || frame.width, height: clip.height || frame.height }, frame);
    const offset = clip.type === "video" ? sec(Math.max(0, Math.min(clip.in ?? 0, (clip.duration || Infinity) - length))) : 0;
    // The camera: the clip's box grown about a point of the frame, reached (push) or left (pull) while the clip is on.
    const scale = camera ? Math.max(1.05, Math.min(4, Number(camera.scale) || 1.5)) : 1;
    const [px, py] = [frame.width * ((camera?.point?.[0] ?? 50) / 100), frame.height * ((camera?.point?.[1] ?? 50) / 100)];
    const near = { x: Math.round(px - (px - box.x) * scale), y: Math.round(py - (py - box.y) * scale), width: Math.round(box.width * scale), height: Math.round(box.height * scale) };
    const [from, to] = camera?.dir === "pull" ? [near, box] : [box, near];
    return { op: "add_layer", layerType: clip.type, name: `sketch-clip-${index + 1}`,
      properties: { src: clip.src, ...(camera ? from : box), mediaStart: start, mediaDuration: length, ...(clip.type === "video" ? { mediaOffset: offset, mediaFreeze: "last", volume: song ? 0 : 1 } : {}) },
      ...(camera ? { animations: [{ kind: "custom", name: camera.dir === "pull" ? "Pull out" : "Push in", start, duration: length, easing: "smooth", from, to }] } : {}) };
  });
  if (song) ops.push({ op: "add_layer", layerType: "audio", name: "sketch-song", properties: { src: song.src, mediaStart: 0, mediaDuration: seconds, mediaOffset: song.from, volume: 0.8 },
    animations: [{ kind: "custom", name: "Song out", start: sec(seconds - 0.4), duration: 0.4, easing: "quart-out", from: { volume: 0.8 }, to: { volume: 0 } }] });
  const cues = [...(together ? [] : starts.slice(1).map((at, index) => ({ op: "set_cue", name: `cut-${index + 2}`, at }))), ...beats.slice(0, CUE_BEATS).map((at, index) => ({ op: "set_cue", name: `beat-${index + 1}`, at }))];
  if (!line) return [...ops, ...cues];
  const read = type ?? {};
  const cased = read.case === "upper" ? line.toUpperCase() : read.case === "lower" ? line.toLowerCase() : line;
  const words = cased.split(" ");
  const { start, leave, step, appear } = lineWindow({ beats, seconds, line: cased, type });
  const set = SIZES[read.size ?? "big"];
  const rows = read.size === "giant" && appear !== "beat" && words.length > 1 && cased.length > 10 ? twoRows(words) : null;
  const longest = appear === "beat" ? Math.max(...words.map((word) => word.length)) : rows?.longest ?? cased.length;
  // Two giant rows together stay within about two thirds of the frame's height.
  const size = Math.round(Math.min(frame.height * (rows ? 0.26 : set.share), (frame.width * set.width * LETTERS_PER_SIZE) / Math.max(set.least, longest)));
  const height = Math.round(size * (rows ? 2.7 : 1.5));
  const middle = frame.height * PLACES[placeOf(read)];
  const y = Math.round(Math.max(frame.height * 0.03, Math.min(frame.height * 0.97 - height, middle - height / 2)));
  const quiet = card ? null : read.black ? { blur: 0, dim: 1 } : calm;
  if (quiet) {
    const ease = (key, on, off) => [{ kind: "in", name: "Calm in", start, duration: CALM_IN, easing: "smooth", from: { [key]: off }, to: { [key]: on } },
      { kind: "custom", name: "Calm out", start: leave, duration: CALM_OUT, easing: "smooth", from: { [key]: on }, to: { [key]: off } }];
    if (quiet.blur) ops.forEach((op) => { if (op.layerType === "video" || op.layerType === "image") op.animations = [...(op.animations ?? []), ...ease("blur", quiet.blur, 0)]; });
    ops.push({ op: "add_layer", layerType: "rectangle", name: "sketch-dim", properties: { x: 0, y: 0, width: frame.width, height: frame.height, fill: "#000000", opacity: quiet.dim },
      animations: ease("opacity", quiet.dim, 0) });
  }
  // A card: dark from the first frame, cut off as the line leaves.
  if (card) ops.push({ op: "add_layer", layerType: "rectangle", name: "sketch-card", properties: { x: 0, y: 0, width: frame.width, height: frame.height, fill: "#0b0c0e" },
    animations: [{ kind: "custom", name: "Card off", start: leave, duration: 0.03, from: { opacity: 1 }, to: { opacity: 0 } }] });
  // Off at `at`, so the lettering share counts only the time it was on.
  const gone = (at) => ({ kind: "custom", name: "Line gone", start: sec(at), duration: 0.03, from: { opacity: 1 }, to: { opacity: 0 } });
  const cutOn = { kind: "in", name: "Line on", start, duration: 0.03, from: { opacity: 0 }, to: { opacity: 1 } };
  const preset = APPEAR_PRESET[appear];
  const animations = preset ? [
    // By word: the text mask's own letter stagger (0.15 s a letter) took 4 s to show a 27-letter line.
    { preset, start, duration: 0.5, ...(appear === "mask" ? { unit: "words", stagger: 0.06 } : {}) },
    // The exit is the entrance reversed, done in LINE_EXIT.
    { preset, kind: "out", start: leave, duration: appear === "mask" ? sec(Math.max(0.15, LINE_EXIT - 0.03 * (words.length - 1))) : LINE_EXIT, ...(appear === "mask" ? { unit: "words", stagger: 0.03 } : {}) },
    gone(leave + LINE_EXIT)]
    : appear === "words" ? [{ preset: "preset-fade", start, duration: 0.03, unit: "words", stagger: step }, gone(leave)]
    // One word a beat: the layer holds the first word and swaps to the next at each step.
    : appear === "beat" ? [cutOn, ...words.slice(1).map((word, index) => ({ kind: "change-text", start: sec(start + step * (index + 1)), text: word, out: null, in: null })), gone(leave)]
    : APPEAR_MOVE[appear] ? [gone(leave)] : [cutOn, gone(leave)];
  ops.push({ op: "add_layer", layerType: "text", name: "sketch-line",
    properties: { text: appear === "beat" ? words[0] : rows ? rows.rows.join("\n") : cased, x: Math.round((frame.width * (1 - set.width)) / 2), y, width: Math.round(frame.width * set.width), height,
      fontSize: size, fill: "#ffffff", textAlign: "center", verticalAlign: "middle" }, animations });
  if (font) ops.push({ op: "set_font", layers: ["sketch-line"], family: font });
  // A move brings the letters on: typed within 1.6 s or 60% of the line's time, whichever is less.
  if (appear === "typed") ops.push({ op: "move", name: "type-on", id: "sketch-typed", layer: "sketch-line", at: start, wait: 0, until: leave, cps: Math.max(10, Math.ceil(cased.length / Math.min(1.6, (leave - start) * 0.6))) });
  else if (APPEAR_MOVE[appear]) ops.push({ op: "move", name: APPEAR_MOVE[appear], id: `sketch-${appear}`, layer: "sketch-line", at: start });
  return [...ops, ...cues, { op: "set_cue", name: "line-in", at: start }, { op: "set_cue", name: "line-out", at: leave }];
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
 * ('312 keyframes'), else none; the type is its own type words; the clips are the project files its source names, each `in` the
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
  return { line: quoted, type: entry?.type ?? null, move: readMove(entry?.move), moveSaid: entry?.move ?? null, clips: clips.sort((a, b) => a.at - b.at).map((entry) => entry.clip).slice(0, CLIPS_MOST) };
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
  const type = option.line && option.type ? `; type ${option.type}` : "";
  const own = option.moveOps ? `${option.moveOps} op${option.moveOps === 1 ? "" : "s"} of yours` : null;
  const move = option.move || own ? `; move: ${[option.move, own].filter(Boolean).join(", and ")}` : "";
  return `; ${song}; font ${option.font ?? "the default"}; ${line}${type}; ${option.cuts ?? 0} cut${option.cuts === 1 ? "" : "s"}${option.cuts && option.song?.src ? " on the song's beats" : ""}${move}${option.lineFix ? `; ${option.lineFix}` : ""}`;
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
  // Two sketches on one song, one font, one type setting (size, place, how the line appears) or one move: said once, as a fact.
  for (const [key, label] of [["song", "song"], ["font", "font"], ["set", "type setting"], ["move", "move"]]) {
    const named = round.options.filter((option) => option.built).map((option) => [option.letter, key === "song" ? option.song?.src ?? null : key === "font" ? option.font : key === "move" ? option.moveName ?? null : option.line ? option.typeSet ?? null : null]).filter(([, value]) => value);
    const same = named.filter(([, value], index) => named.some(([, other], at) => at !== index && other === value));
    if (same.length) lines.push(`${same.map(([letter]) => letter).join(" and ")} use the same ${label}${key === "song" ? "" : ` (${same[0][1]})`}.`);
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
