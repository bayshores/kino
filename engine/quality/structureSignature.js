// The structure of a cut edit (anime footage to a song, a music video): how it is built, not how
// one moment is laid out (layoutSignature.js does that). House memory (backend/house-memory.mjs)
// saves it per render and seen_before (rules/seenBefore.js) warns when two kino edits come out
// shaped alike: the same pace per song section, the same first drop, burst, ending, title and colors.
//
// structureSignature(model, {markers, beats}) answers null for a video with fewer than MIN_SHOTS
// shots (a card or a promo has no cut structure), else:
//   sections [{kind, from, rate}]  each song section (marker cues song-<kind>-<n>, else quarters):
//                                  where it starts (share of the video) and its cuts per second
//   effects [{tag, at, w}]         each loud effect (flash, shake, ...) in time order, at a share,
//                                  w the weight of the beat or onset cue it sits on (null without one)
//   burst {at, n} | null           the first run of BURST_RUN or more shots of BURST_SHOT s or less
//   drop {at, cut, effects, hold}  the first drop (song-drop cue): a cut on it, its effects, and how
//                                  long the shot after it holds; null without a drop cue
//   ending {rate, effects, last, fade}  the last 15%: cuts per second, effects, what the last frame
//                                  shows (black, text, picture) and whether the picture fades out
//   title {at, x, y, size} | null  the first designed text: when (share), center and size (shares)
//   colors [hex]                   the 3 colors kino painted most (quantized), by screen time and area
import { coversFrame, readingTexts, speechTimed, sec } from "./analysis.js";
import { boxAt, hexRgba, isGradient } from "./model.js";
import { techniquesUsed } from "./techniques.js";

export const STRUCTURE_VERSION = 1;
export const MIN_SHOTS = 6;
const BURST_SHOT = 0.25;
const BURST_RUN = 4;
const CLOSING_SHARE = 0.15;
// Loud effects: what a viewer sees as an accent (techniques.js tags, and the accent moves' tags).
const LOUD = new Set(["flash", "shake", "rgb-split", "glitch-hit", "zoom-through", "whip-pan", "beat-kick", "speed-ramp", "freeze-frame", "light-sweep", "impact-frame", "strobe", "dip"]);
// The parts compared, with the words a message names them by.
const PART_WORDS = { pace: "cut rate per section", drop: "first drop", burst: "burst place", effects: "effect order", ending: "ending", title: "title place", colors: "colors" };
export const partWords = (parts) => parts.map((part) => PART_WORDS[part]).join(", ");

const r2 = (value) => Math.round(value * 100) / 100;
const share = (model, time) => r2(time / Math.max(1e-6, model.duration));

// The shots: times the top full-frame clip or picture changes, one frame apart at the least (no
// merging, so a burst of 3-frame shots stays a burst). Flashes and shapes are not shots.
function shotChanges(model) {
  const media = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask && coversFrame(model, item));
  const found = [];
  let previous = null;
  for (let index = 0; index < model.times.length; index += 1) {
    let top = null;
    for (const item of media) if (item.samples.opacity[index] >= 0.9 && (!top || item.z > top.z)) top = item;
    if (top && previous && top.id !== previous.id) found.push(model.times[index]);
    if (top) previous = top;
  }
  return found;
}

function sectionsOf(model, markers) {
  const song = (markers ?? []).filter((cue) => /^song-/.test(cue.name ?? "") && cue.time > 0.05 && cue.time < model.duration - 0.05)
    .sort((a, b) => a.time - b.time);
  const starts = song.length
    ? [{ kind: "start", time: 0 }, ...song.map((cue) => ({ kind: String(cue.name).replace(/^song-|-\d+$/g, ""), time: cue.time }))]
    : [0, 1, 2, 3].map((index) => ({ kind: "quarter", time: (index * model.duration) / 4 }));
  return starts.map((start, index) => ({ kind: start.kind, time: start.time, end: starts[index + 1]?.time ?? model.duration }));
}

const rateIn = (cuts, from, to) => (to - from > 1e-6 ? r2(cuts.filter((time) => time >= from && time < to).length / (to - from)) : 0);

// The last rendered frame: the samples can end at t = duration, where a clip that runs to the end is
// already out.
function lastIndex(model) {
  let index = model.times.length - 1;
  while (index > 0 && model.times[index] >= model.duration - 1e-6) index -= 1;
  return index;
}

// What the last frame shows: a designed text, a picture, or nothing (black).
function lastFrame(model) {
  const index = lastIndex(model);
  if (readingTexts(model).some((item) => item.samples.opacity[index] >= 0.5)) return "text";
  const picture = model.items.some((item) => (item.kind === "video" || item.kind === "image") && !item.isMask && item.samples.opacity[index] >= 0.5);
  return picture ? "picture" : "black";
}

// Whether the picture fades (or cuts) out over the last second: shown a second before the end, gone
// on the last frame. A cut to the next clip is not a fade out.
function fadesOut(model) {
  const last = lastIndex(model);
  const from = Math.max(0, Math.round((model.duration - 1) * model.fps));
  const media = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask);
  const pictureAt = (index) => Math.max(0, ...media.map((item) => item.samples.opacity[index]));
  return pictureAt(from) >= 0.9 && pictureAt(last) <= 0.5;
}

function titleOf(model) {
  const timed = speechTimed(model);
  let first = null;
  for (const item of readingTexts(model)) {
    if (timed.has(item.id) || item.role === "caption") continue;
    const index = item.samples.opacity.findIndex((value) => value >= 0.5);
    if (index >= 0 && (!first || index < first.index)) first = { item, index };
  }
  if (!first) return null;
  const box = boxAt(first.item, first.index);
  return { at: share(model, model.times[first.index]), x: r2((box.x0 + box.x1) / 2 / model.width), y: r2((box.y0 + box.y1) / 2 / model.height), size: r2((box.y1 - box.y0) / model.height) };
}

// A color quantized to 6 levels a channel (so near shades are one color).
const quantize = (rgba) => `#${rgba.slice(0, 3).map((value) => (Math.round(value / 51) * 51).toString(16).padStart(2, "0")).join("")}`;

function colorsOf(model) {
  const weights = new Map();
  const step = Math.max(1, Math.round(model.fps / 2));
  for (const item of model.items) {
    if (item.isMask || item.kind === "video" || item.kind === "image" || item.kind === "group" || !item.fill || isGradient(item.fill)) continue;
    const rgba = hexRgba(item.fill);
    if (!rgba || rgba[3] < 128) continue;
    let weight = 0;
    for (let index = 0; index < model.times.length; index += step) {
      const box = boxAt(item, index);
      weight += item.samples.opacity[index] * Math.max(0, (box.x1 - box.x0) * (box.y1 - box.y0)) / (model.width * model.height);
    }
    const color = quantize(rgba);
    if (weight > 0) weights.set(color, (weights.get(color) ?? 0) + weight);
  }
  return [...weights].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([color]) => color);
}

/** The edit's structure (see the top of this file), or null when it has fewer than MIN_SHOTS shots. */
export function structureSignature(model, { markers = [], beats = [] } = {}) {
  const cuts = shotChanges(model);
  if (cuts.length + 1 < MIN_SHOTS) return null;
  const frame = 1.5 / model.fps;
  const weightAt = (time) => beats.filter((cue) => Number.isFinite(cue.weight) && Math.abs(cue.time - time) <= frame)
    .reduce((best, cue) => (best == null || cue.weight > best ? r2(cue.weight) : best), null);
  const found = techniquesUsed(model);
  // Seconds here: a share rounded to 0.01 is up to 0.005 x duration off (0.3 s in a 60 s edit),
  // wider than the drop's window. Only the saved list is in shares.
  const timed = Object.entries(found).filter(([tag]) => LOUD.has(tag))
    .flatMap(([tag, list]) => list.map((entry) => ({ tag, time: entry.at })))
    .sort((a, b) => a.time - b.time || a.tag.localeCompare(b.tag));
  const effects = timed.map((entry) => ({ tag: entry.tag, at: share(model, entry.time), w: weightAt(entry.time) }));
  const tagsNear = (from, to) => [...new Set(timed.filter((effect) => effect.time >= from && effect.time <= to).map((effect) => effect.tag))].sort();

  const shots = [0, ...cuts, model.duration];
  const lengths = shots.slice(1).map((time, index) => time - shots[index]);
  let burst = null;
  for (let start = 0; start < lengths.length && !burst; start += 1) {
    let n = 0;
    while (start + n < lengths.length && lengths[start + n] <= BURST_SHOT + 1e-6) n += 1;
    if (n >= BURST_RUN) burst = { at: share(model, shots[start]), n };
    else start += n;
  }

  const dropCue = (markers ?? []).filter((cue) => /^song-drop-/.test(cue.name ?? "")).sort((a, b) => a.time - b.time)[0];
  const drop = dropCue ? {
    at: share(model, dropCue.time),
    cut: cuts.some((time) => Math.abs(time - dropCue.time) <= frame),
    effects: tagsNear(dropCue.time - 0.15, dropCue.time + 0.15),
    hold: sec((cuts.find((time) => time > dropCue.time + frame) ?? model.duration) - dropCue.time),
  } : null;

  const closing = model.duration * (1 - CLOSING_SHARE);
  return {
    sections: sectionsOf(model, markers).map((part) => ({ kind: part.kind, from: share(model, part.time), rate: rateIn(cuts, part.time, part.end) })),
    effects,
    burst,
    drop,
    ending: { rate: rateIn(cuts, closing, model.duration), effects: tagsNear(closing, model.duration), last: lastFrame(model), fade: fadesOut(model) },
    title: titleOf(model),
    colors: colorsOf(model),
  };
}

// The cut rate at a share of the video (the section it falls in).
const rateAt = (sections, at) => (sections.filter((part) => part.from <= at + 1e-6).at(-1) ?? sections[0])?.rate ?? 0;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b), 0.2);
const sameSet = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// The longest common run of tags in order, over the longer list.
function orderShare(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
  }
  return table[a.length][b.length] / Math.max(a.length, b.length, 1);
}

// The cut rate at 12 points of the video.
const POINTS = Array.from({ length: 12 }, (_, index) => (index + 0.5) / 12);
const ratesOf = (sections) => POINTS.map((at) => rateAt(sections, at));
// Flat: one steady cut rate the whole way (every point within 25% of the others).
const flat = (sections) => { const rates = ratesOf(sections); return near(Math.max(...rates), Math.min(...rates), 0.25); };
// A designed ending: an effect, a fade or a last frame other than the picture (a plain cut to the end
// of the song is the default, not a choice).
const designedEnding = (ending) => ending.effects.length > 0 || ending.fade || ending.last !== "picture";

/**
 * Which parts of two structures are alike: {compared: [part], alike: [part]}. A part either one
 * lacks (no drop, no burst, no title, under 3 effects, under 2 colors) is not compared, and so is a
 * part that only follows the song: a steady pace in both, a plain cut on both drops (no effect on
 * either), a plain ending in both. Those are the default, not a house habit.
 */
export function structureAlike(a, b) {
  const compared = [];
  const alike = [];
  const part = (name, test) => { if (test === null) return; compared.push(name); if (test) alike.push(name); };
  // Pace: the cut rate sampled at 12 points of the video, alike within 25% at 10 of them.
  const [ratesA, ratesB] = [ratesOf(a.sections), ratesOf(b.sections)];
  part("pace", flat(a.sections) && flat(b.sections) ? null : ratesA.filter((rate, index) => near(rate, ratesB[index], 0.25)).length >= 10);
  const dropDesigned = a.drop && b.drop && (a.drop.effects.length > 0 || b.drop.effects.length > 0);
  part("drop", dropDesigned ? a.drop.cut === b.drop.cut && sameSet(a.drop.effects, b.drop.effects) && near(a.drop.hold, b.drop.hold, 0.3) : null);
  part("burst", a.burst && b.burst ? Math.abs(a.burst.at - b.burst.at) <= 0.06 : null);
  part("effects", a.effects.length >= 3 && b.effects.length >= 3 ? orderShare(a.effects.map((e) => e.tag), b.effects.map((e) => e.tag)) >= 0.7 : null);
  part("ending", designedEnding(a.ending) || designedEnding(b.ending)
    ? a.ending.last === b.ending.last && a.ending.fade === b.ending.fade && sameSet(a.ending.effects, b.ending.effects) && near(a.ending.rate, b.ending.rate, 0.3)
    : null);
  part("title", a.title && b.title ? Math.abs(a.title.at - b.title.at) <= 0.05 && Math.hypot(a.title.x - b.title.x, a.title.y - b.title.y) <= 0.12 && near(a.title.size, b.title.size, 0.35) : null);
  part("colors", a.colors.length >= 2 && b.colors.length >= 2 ? a.colors.filter((color) => b.colors.includes(color)).length >= 2 : null);
  return { compared, alike };
}

/**
 * True when two edits read as one structure: 75% or more of 4+ compared parts alike, the pace among
 * them unless both cut at one steady rate (then pace is not compared).
 */
export function sameStructure({ compared, alike }) {
  const paceOk = alike.includes("pace") || !compared.includes("pace");
  return paceOk && compared.length >= 4 && alike.length / compared.length >= 0.75;
}
