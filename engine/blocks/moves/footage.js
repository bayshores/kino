// Moves for footage edits: perceive-insert (Be My Eyes: when the product says what it sees, the
// edit cuts to that detail of the footage, then back) and voice-type (a key spoken line set big,
// word by word as it is said, the way trailers set one line). Neither is dealt: an agent names
// them when the idea calls for them.
import { createLayer } from "../../model.js";
import { layoutText, resizeTextLayer, textUnits } from "../../textLayout.js";
import { textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { captionWordsFromSpeech, checkSpeechLayer, speechWords } from "../../speech.js";
import { UPSCALE_GATE } from "../../quality/rules/footage.js";
import { CURVES, effect, hide, motion, round, show } from "./kit.js";

// ---- perceive-insert ----------------------------------------------------------------------
// Be My Eyes (GPT-4o film, 10.2 s and 20.7 s): the voice names a thing (the flag, the ducks) and
// the edit hard-cuts to a tight shot of it, no frame, no label, then hard-cuts back to the person.
// Here the tight shot is a region of the footage, so it is kept short (a crop is softer than a
// real close-up): 1 s by default, 0.6 to 1.4 s. "push" gets there by a fast push from the wide
// shot (0.24 s, fast then soft) instead of a cut, as a phone camera snapping to a detail.
const INSERT_DEFAULT = 1;
const INSERT_RANGE = [0.6, 1.4];
const PUSH_SECONDS = 0.24;
// Past this zoom 1080p footage looks soft; the region grows to keep it.
const MOST_ZOOM = 3.2;
// A subject box is used when it was marked within this many seconds of the insert.
const BOX_NEAR = 4;

/** The insert's box: `box` (the clip on screen) scaled so `region` (% of it) fills the frame. */
export function insertBox(box, region, frame, most = MOST_ZOOM) {
  const [rx, ry, rw, rh] = region;
  const width = (rw / 100) * box.width;
  const height = (rh / 100) * box.height;
  const zoom = Math.min(most, Math.max(frame.width / width, frame.height / height));
  const center = { x: box.x + ((rx + rw / 2) / 100) * box.width, y: box.y + ((ry + rh / 2) / 100) * box.height };
  const out = { width: box.width * zoom, height: box.height * zoom };
  // The region's center goes to the frame's center, kept so the clip still covers the frame.
  let x = frame.width / 2 - (center.x - box.x) * zoom;
  let y = frame.height / 2 - (center.y - box.y) * zoom;
  if (out.width >= frame.width) x = Math.min(0, Math.max(frame.width - out.width, x));
  if (out.height >= frame.height) y = Math.min(0, Math.max(frame.height - out.height, y));
  return { x: round(x, 1), y: round(y, 1), width: round(out.width, 1), height: round(out.height, 1), zoom: round(zoom, 2) };
}

// The file second a clip shows at scene time `time` (speed 1).
const fileSecond = (layer, time) => (layer.mediaOffset ?? 0) + (time - (layer.mediaStart ?? 0)) * (layer.mediaSpeed ?? 1);

function nearestBox(layer, second) {
  const set = layer.subjectBoxes;
  if (!set || set.src !== layer.src || !set.boxes?.length) return null;
  const best = set.boxes.reduce((found, entry) => (Math.abs(entry.at - second) < Math.abs(found.at - second) ? entry : found));
  return Math.abs(best.at - second) <= BOX_NEAR ? best.box : null;
}

export const perceiveInsert = {
  name: "perceive-insert",
  about: "a detail of the footage (a region or the marked subject) fills the frame for about 1 s, hard cut in and back; optional label",
  fits: "a voice or app naming what it sees: cut to the thing it names",
  tags: ["cut", "screen-zoom"],
  length: INSERT_DEFAULT,
  shortest: INSERT_RANGE[0],
  needsAt: true,
  fields: {
    layer: { kind: "layer", required: true, about: "the clip on screen (a video or picture); the insert plays its footage in sync" },
    of: { kind: "layer", about: "another video layer to take the detail from instead (its footage at the same moment, else its first frame)" },
    region: { kind: "box", about: "[x, y, width, height] in % of the clip (look source's grid); default: the subject box marked nearest this moment" },
    entry: { kind: "choice", values: ["cut", "push"], about: "cut (default): a hard cut to the detail; push: a fast 0.24 s push in from the wide shot" },
    label: { kind: "text", max: 40, about: "a thin label on the insert, such as what the app read" },
  },
  example: { layer: "shot-a", at: 0.3, region: [40, 30, 25, 25] },
  setup: "shot-a, a video (or picture) filling the frame",
  build(ctx, input) {
    const dur = ctx.dur ?? INSERT_DEFAULT;
    if (dur > INSERT_RANGE[1]) throw new Error(`perceive-insert lasts ${INSERT_RANGE[0]} to ${INSERT_RANGE[1]} s; give dur in that range (a longer detail is its own shot).`);
    const base = ctx.layer(input.layer, "layer");
    const from = input.of ? ctx.layer(input.of, "of") : base;
    if (![base, from].every((layer) => ["video", "image"].includes(layer.type))) throw new Error("perceive-insert: layer and of must be video (or picture) layers.");
    const video = from.type === "video";
    const start = ctx.start;
    const end = round(start + dur);
    const begins = from.mediaStart ?? 0;
    const playing = !video || start >= begins && (!(from.mediaDuration > 0) || start < begins + from.mediaDuration);
    if (from === base && !playing) throw new Error(`perceive-insert: ${base.id} does not play at ${start} s.`);
    const second = round(playing ? fileSecond(from, start) : (from.mediaOffset ?? 0));
    const region = input.region ?? nearestBox(from, second);
    if (!region) throw new Error(`perceive-insert: give region [x, y, width, height] in % of the clip, or mark its subject first (mark_subject; look {mode:"source"} shows the grid).`);
    const wide = ctx.boxAt(base.id, start);
    const box = from === base ? wide : { x: 0, y: 0, ...fit(from, ctx.frame) };
    // Never past the soft_upscale gate: at most 1.9 screen pixels for each pixel of the file.
    const file = ctx.fileSize(from.src);
    const most = Math.max(1, Math.min(MOST_ZOOM, file ? (UPSCALE_GATE * 0.95 * Math.min(file.width / box.width, file.height / box.height)) : MOST_ZOOM));
    const target = insertBox(box, region, ctx.frame, most);
    // The file's pixels across the frame at the held zoom (the more of them, the fewer codec blocks show).
    const across = file ? Math.round(ctx.frame.width / Math.min(target.width / file.width, target.height / file.height)) : null;
    if (target.zoom >= most - 0.01) ctx.note(`perceive-insert zoom held at ${round(most, 2)}x so the footage stays sharp (the region shows more around it${file ? `; a sharper file allows a tighter detail; ${across} of its ${file.width} px across the ${ctx.frame.width} px frame there` : ""})`);
    // The same footage, muted, from this moment of the file, shown only for the insert.
    const { id, name, animations, subjectBoxes, move, recipe, ...media } = from;
    const shot = ctx.add("shot", createLayer(from.type, {
      ...media, x: target.x, y: target.y, width: target.width, height: target.height, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1,
      // The detail is the clip's subject, so the framing checks read the crop as chosen.
      ...(video ? { mediaStart: start, mediaOffset: second, mediaDuration: round(dur + 0.04), volume: 0, subjectBoxes: { src: from.src, boxes: [{ at: second, box: region, by: "agent" }] } } : {}),
    }), "top");
    const push = input.entry === "push" && !ctx.reduced && from === base;
    if (push) {
      ctx.animate(shot, "push", motion({ name: "Push in", start, duration: PUSH_SECONDS, easing: CURVES.settle, from: { x: wide.x, y: wide.y, width: wide.width, height: wide.height }, to: { x: target.x, y: target.y, width: target.width, height: target.height } }));
      // A zoom blur on the fast part of the push (as zoom-through's), so it does not judder.
      const blurAt = { centerX: round((region[0] + region[2] / 2) / 100), centerY: round((region[1] + region[3] / 2) / 100) };
      ctx.animate(shot, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start, duration: round(PUSH_SECONDS * 0.3), easing: CURVES.accelerate, from: { amount: 0 }, to: { amount: 0.35, ...blurAt } }));
      ctx.animate(shot, "unblur", effect({ name: "Zoom blur ends", effect: "zoom-blur", start: round(start + PUSH_SECONDS * 0.3), duration: round(PUSH_SECONDS * 0.7), easing: CURVES.settle, from: { amount: 0.35 }, to: { amount: 0, ...blurAt } }));
    }
    if (start > 0) ctx.animate(shot, "show", show(start));
    ctx.animate(shot, "hide", hide(end));
    if (input.label) {
      const safe = safeArea(ctx.frame);
      const size = Math.round(Math.min(ctx.frame.height * 0.034, ctx.frame.width * 0.034));
      const text = ctx.add("label", textLayer(ctx, { part: "label", text: input.label, role: "label", step: "body", size, weight: 500, box: { x: safe.x, y: safe.y, width: safe.width * 0.6, height: size * 2 }, maxLines: 1, uppercase: true }));
      text.letterSpacing = round(size * 0.12, 1);
      text.y = Math.round(safe.y + safe.height - text.height);
      // A dark chip keeps the thin label readable on bright footage.
      const pad = Math.round(size * 0.45);
      const chip = ctx.add("chip", createLayer("rectangle", { x: text.x - pad, y: text.y - pad * 0.6, width: text.width + pad * 2, height: text.height + pad * 1.2, fill: "#000000B8", radius: Math.round(size * 0.2), role: "decor", allowOverlap: true }), { below: text.id });
      const labelAt = round(start + (push ? PUSH_SECONDS : 0.08));
      for (const layer of [chip, text]) {
        ctx.animate(layer, "show", show(labelAt));
        ctx.animate(layer, "hide", hide(end));
      }
    }
    return { end };
  },
};

// A clip's box when it is not on screen: the frame, at the file's shape when the layer has one.
function fit(layer, frame) {
  const aspect = layer.width > 0 && layer.height > 0 ? layer.width / layer.height : frame.width / frame.height;
  const width = Math.max(frame.width, frame.height * aspect);
  return { width, height: width / aspect };
}

// ---- voice-type ---------------------------------------------------------------------------
// A trailer setting its key line (launch films set one spoken line big): each word
// cuts on as it is said, building the line in place (centered, up to 3 lines), the last word
// held and, by default, in the accent color. Timing is the voice's own: the words come from the
// transcript through the same code add_captions {speech} uses (backend/agent/service.mjs).
const VOICE_HOLD = 0.8;
const WORD_IN = 0.12;

/**
 * The words of `line` in `words` ([{text, start, end}], a transcript as captions read it), found
 * without case or punctuation: [{text, at, end}] in scene seconds, or null when it is not said.
 */
export function lineWords(words, line) {
  const plain = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  const wanted = String(line).split(/\s+/).map(plain).filter(Boolean);
  if (!wanted.length) return null;
  for (let index = 0; index + wanted.length <= words.length; index += 1) {
    if (wanted.every((word, offset) => plain(words[index + offset].text) === word))
      return words.slice(index, index + wanted.length).map((word) => ({ text: word.text, at: word.start, end: word.end }));
  }
  return null;
}

/**
 * voice-type {speech, line}: the line's words as `scene` plays the voice `layer` (after any
 * cut_speech), from its `transcript`, read as add_captions {speech} reads it (fillers left out).
 * Returns [{text, at, end}] or throws naming what is wrong.
 */
export function spokenLine(scene, layer, transcript, line) {
  const pieces = checkSpeechLayer(scene, layer, "voice-type");
  const found = lineWords(captionWordsFromSpeech(speechWords(scene, pieces, transcript)).words, line);
  if (!found) throw new Error(`voice-type: "${line}" is not said in ${pieces[0].name} in this scene; inspect speech:${pieces[0].name} shows its words.`);
  if (found.length > 14) throw new Error(`voice-type: the line has ${found.length} words; set 14 or fewer (one key line).`);
  return found;
}

export const voiceType = {
  name: "voice-type",
  about: "one spoken line set big, each word cutting on as it is said; the last word holds",
  fits: "the key spoken line, set once like a trailer line",
  tags: ["type-words", "type-giant"],
  length: 2,
  lasts: "not needed: it lasts until the last word ends, plus hold",
  fields: {
    words: { kind: "timed", ends: true, most: 14, max: 30, about: "[{text, at, end?}]: each word and when it is said, in scene seconds" },
    speech: { kind: "layer", about: "the voice (an audio or video layer); with line, the words and times come from its transcript" },
    line: { kind: "text", max: 120, about: "with speech: the words to set, as said (found in the transcript)" },
    over: { kind: "choice", values: ["footage", "plate"], about: "footage (default): over the picture, a soft shade behind the line; plate: cut to the look's background color" },
    hold: { kind: "number", low: 0.3, high: 3, about: "seconds the whole line stays after the last word ends (default 0.8)" },
    accent: { kind: "choice", values: [true, false], about: "true sets the last word in the accent color (default: on a plate only; over footage an accent can fail contrast)" },
    layer: { kind: "layer", about: "your own text layer holding the line: its words cut on as said, in its own font, size, color and place (with speech, line defaults to its text)" },
  },
  anyOf: [["words", "speech"]],
  example: { words: [{ text: "I", at: 0.3 }, { text: "can", at: 0.45 }, { text: "see", at: 0.7 }, { text: "again.", at: 1, end: 1.6 }] },
  setup: "none",
  build(ctx, input) {
    const words = input.words;
    if (!words) throw new Error("voice-type: speech and line go through edit, which reads the voice's transcript; give speech and line together.");
    for (let index = 1; index < words.length; index += 1)
      if (words[index].at < words[index - 1].at) throw new Error("voice-type: words must be in time order.");
    const last = words.at(-1);
    const end = round((last.end ?? last.at + 0.5) + (input.hold ?? VOICE_HOLD));
    if (end > ctx.sceneDuration + 1e-6) throw new Error(`voice-type: the line ends at ${end} s, after the scene ends (${ctx.sceneDuration} s).`);
    if (input.layer) return voiceOn(ctx, input, words, end);
    const safe = safeArea(ctx.frame);
    const room = { x: safe.x + safe.width * 0.06, width: safe.width * 0.88 };
    // Big: capitals about 11% of a wide frame's height; smaller until the line takes 3 lines or fewer.
    let size = Math.round(Math.min(ctx.frame.height * 0.14, ctx.frame.width * 0.12));
    let laid;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      laid = layWords(ctx, words, size, room);
      if (laid.lines.length <= 3 && laid.lines.every((line) => line.width <= room.width)) break;
      size = Math.round(size * 0.9);
    }
    const lineHeight = Math.round(size * 1.05);
    const top = Math.round(safe.y + (safe.height - lineHeight * laid.lines.length) / 2);
    const first = words[0].at;
    // Behind the words. Over footage: a soft dark shade that hugs the line (as caption-words'
    // does), fading up over the 0.3 s before the first word; a full-frame dim moved the
    // picture's brightness past the luma_jump gate on real footage. On a plate: the look's
    // background, cut on with the first word (a trailer's card).
    const plate = input.over === "plate";
    const widest = Math.max(...laid.lines.map((line) => line.width));
    const pad = { x: Math.round(size * 0.5), y: Math.round(size * 0.3) };
    const area = plate ? { x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height }
      : { x: Math.round(room.x + (room.width - widest) / 2 - pad.x), y: top - pad.y, width: Math.round(widest + pad.x * 2), height: lineHeight * laid.lines.length + pad.y * 2 };
    const back = ctx.add("back", createLayer("rectangle", { ...area, fill: plate ? ctx.style.colors.bg : "#000000A6", ...(plate ? {} : { radius: Math.round(size * 0.4), blur: Math.round(size * 0.26) }), role: "decor", allowOverlap: true }), "top");
    const dimAt = plate ? first : round(Math.max(0, first - 0.3));
    if (dimAt > 0) ctx.animate(back, "show", show(dimAt));
    if (!plate && !ctx.reduced) ctx.animate(back, "in", motion({ name: "Shade in", kind: "in", start: dimAt, duration: 0.3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(back, "hide", hide(end));
    laid.lines.forEach((line, row) => {
      let x = room.x + (room.width - line.width) / 2;
      for (const item of line.items) {
        const index = item.index;
        const final = index === words.length - 1;
        const word = ctx.add(`w${index + 1}`, { ...item.layer, x: Math.round(x), y: top + row * lineHeight, fill: final && (input.accent ?? plate) ? ctx.style.colors.accent : ctx.style.colors.text });
        x += item.layer.width + item.space;
        const at = words[index].at;
        if (at > 0) ctx.animate(word, "show", show(at));
        // A small settle so a word lands rather than blinks (none with reduced motion).
        if (!ctx.reduced) ctx.animate(word, "in", motion({ name: "Land", kind: "in", start: at, duration: WORD_IN, easing: CURVES.arrive, from: { y: word.y + Math.round(size * 0.08), opacity: 0.4 }, to: { y: word.y, opacity: 1 } }));
        ctx.animate(word, "hide", hide(end));
      }
    });
    ctx.note(`voice-type: ${words.length} words on ${laid.lines.length} line${laid.lines.length === 1 ? "" : "s"} at ${size}px, ${round(first)} to ${end} s`);
    return { start: first, end };
  },
};

// voice-type on your text layer: each of its words shows as it is said (one animation with a
// delay per word), the shade or plate goes under it, and it hides with them at the end.
function voiceOn(ctx, input, words, end) {
  const own = ctx.layer(input.layer, "layer");
  if (own.type !== "text") throw new Error(`voice-type layer: ${own.id} is a ${own.type}; give a text layer.`);
  const layer = resizeTextLayer(own, ctx.fonts);
  const count = textUnits(layoutText(layer, ctx.fonts), "words").length;
  if (count !== words.length) throw new Error(`voice-type layer: ${layer.id} has ${count} words and the line has ${words.length}; they must match one for one.`);
  if (input.accent === true) ctx.note("accent left out: your layer keeps its own colors (color its last word yourself)");
  const first = words[0].at;
  const size = layer.fontSize ?? 40;
  const plate = input.over === "plate";
  const pad = { x: Math.round(size * 0.5), y: Math.round(size * 0.3) };
  const area = plate ? { x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height }
    : { x: Math.round(layer.x - pad.x), y: Math.round(layer.y - pad.y), width: Math.round(layer.width + pad.x * 2), height: Math.round(layer.height + pad.y * 2) };
  const back = ctx.add("back", createLayer("rectangle", { ...area, fill: plate ? ctx.style.colors.bg : "#000000A6", ...(plate ? {} : { radius: Math.round(size * 0.4), blur: Math.round(size * 0.26) }), role: "decor", allowOverlap: true }), { below: layer.id });
  const dimAt = plate ? first : round(Math.max(0, first - 0.3));
  if (dimAt > 0) ctx.animate(back, "show", show(dimAt));
  if (!plate && !ctx.reduced) ctx.animate(back, "in", motion({ name: "Shade in", kind: "in", start: dimAt, duration: 0.3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
  ctx.animate(back, "hide", hide(end));
  const full = layer.opacity ?? 1;
  const delays = words.map((word) => round(word.at - first));
  const land = ctx.reduced ? { from: { opacity: 0 }, to: { opacity: full } } : { from: { y: layer.y + Math.round(size * 0.08), opacity: round(0.4 * full, 3) }, to: { y: layer.y, opacity: full } };
  ctx.animate(layer.id, "in", { ...motion({ name: "Land", kind: "in", start: first, duration: ctx.reduced ? 0.001 : WORD_IN, easing: CURVES.arrive, ...land }), unit: "words", delays }, "layer");
  ctx.animate(layer.id, "hide", hide(end), "layer");
  ctx.note(`voice-type: ${words.length} words of ${layer.id}, ${round(first)} to ${end} s`);
  return { start: first, end };
}

// Each word as its own text layer at `size`, flowed into centered lines that fit room's width.
function layWords(ctx, words, size, room) {
  const lines = [];
  let line = { items: [], width: 0 };
  words.forEach((entry, index) => {
    const layer = textLayer(ctx, { part: `w${index + 1}`, text: entry.text, role: "headline", step: "display", size, weight: 700, box: { x: 0, y: 0, width: ctx.frame.width * 2, height: size * 2 }, maxLines: 1, lineHeight: 1.05, name: entry.text });
    delete layer.lines;
    const width = Math.ceil(Math.max(...layoutText(layer, ctx.fonts).lines.map((item) => item.width ?? 0)));
    const sized = { ...layer, width: width + Math.ceil(size * 0.06) };
    const space = Math.round(size * 0.26);
    if (line.items.length && line.width + space + sized.width > room.width) {
      lines.push(line);
      line = { items: [], width: 0 };
    }
    if (line.items.length) line.items.at(-1).space = space;
    line.width += (line.items.length ? space : 0) + sized.width;
    line.items.push({ index, layer: sized, space: 0 });
  });
  lines.push(line);
  return { lines };
}
