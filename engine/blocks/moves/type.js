// Moves made of type: caption-words, push-through-type (an app trailer's opening) and
// status-line (an app icon with a line that changes its words).
import { createLayer } from "../../model.js";
import { layoutText, textUnits } from "../../textLayout.js";
import { readSeconds, textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { haloAlwaysPasses } from "../../quality/pixels.js";
import { CURVES, changeText, effect, frameShare, hide, inkPoint, luminance, mix, motion, round, scaledAbout } from "./kit.js";

// The checker's shortest reading time: 20 frames at 30 fps.
const SHORTEST_READ = 20 / 30;
// A soft dark drop shadow under light text over footage (offset, so it reads as shade, not glow),
// 80% black: with no box behind them, white words keep about 5.7:1 even over white sky.
const SHADE = "#000000CC";
const shadowFor = (ctx) => ({ color: SHADE, x: 0, y: Math.round(4 * ctx.scale), blur: Math.round(10 * ctx.scale) });
const readTime = (text) => Math.max(readSeconds(text), SHORTEST_READ);
// Whether a move puts a dark box behind its words: when asked (scrim true or false), else only
// when the words with their shadow could fail the contrast gate over some picture (dark ink,
// small or dimmed type). Light words in a halo shadow need no box (launch films use no subtitle box).
const needsScrim = (ctx, asked, { fills, shadow, size, weight }) => asked ?? !fills.every((fill) => haloAlwaysPasses({ fill, shadow, size, weight: weight ?? 400, frame: ctx.frame }));

// ---- caption-words ----------------------------------------------------------------------
// Words are shown a phrase at a time, each group replacing the last the moment the next one is
// said (a hard swap). How many words a group holds follows the energy of the
// speech: 2 to 3 words when it is fast and loud, 3 to 5 when conversational,
// 4 to 6 when calm. A group breaks at a sentence's end, at a breath (a pause of 0.15 s or more),
// or at its word limit; a group on screen under 0.35 s, or too short to read (the reading_time
// gate), takes the next words. The last group stays at least 2 s when the scene allows.
const CAPTION_IN = 0.28;
// The first part of the entrance, before the words are sharp and opaque enough to read.
const CAPTION_READY = 0.1;
const CAPTION_LAST_OUT = 0.24;
// caption-words' plain entrance: each caption fades on and off this fast (a soft cut).
const CAPTION_CUT = 0.08;
const SPEAKING_PACE = 2.6; // words a second when only a text is given
// caption-words size: a share of the big default.
const CAPTION_SIZES = Object.freeze({ small: 0.55, medium: 0.75, big: 1 });
// entrance "pop": each word scales up from 92% over 0.12 s as it is said (no overshoot); words
// not said yet wait in place at 70%, so the caption keeps its centered layout.
const WORD_POP = 0.12;
const POP_FROM = 0.92;
// highlight "active": the color switches this fast at each word's time; the rest sit at 70%.
const WORD_SWITCH = 0.05;
const dimmed = (color) => `${String(color).slice(0, 7)}B3`;

/**
 * One group's word timing as per-word animation keys (unit words, textAnchor words): `say`
 * delays each word to when it is said, `said` to when the next word is (the last word keeps its
 * look until the group ends). A timed entry of several words ("we gave") times each of them.
 */
export function wordKeys(group) {
  const after = (time) => round(Math.min(60, Math.max(0, time - group.at)));
  const say = [];
  const said = [];
  group.words.forEach((word, index) => {
    const next = group.words[index + 1]?.at ?? group.end;
    for (let count = wordCount(word.text); count > 0; count -= 1) {
      say.push(after(word.at));
      said.push(after(next));
    }
  });
  const keys = (delays) => ({ unit: "words", textAnchor: "words", delays });
  return { say: keys(say), said: keys(said) };
}

// Words per group by energy: [fewest, most].
export const CAPTION_ENERGY = Object.freeze({ high: [2, 3], talk: [3, 5], calm: [4, 6] });
// A word that ends a sentence ("sure.", "to go?"): a caption never runs on past it into the next.
const SENTENCE_END = /[.!?…]["')\]]*$/;
// Small words a caption never ends on ("this is lowkey the"): they move to the next caption.
const LEADING_WORDS = new Set(["a", "an", "the", "in", "on", "of", "to", "at", "for", "with", "by", "from", "and", "or", "but", "my", "your", "our", "their", "his", "her", "its"]);
const leads = (word) => LEADING_WORDS.has(word.text.toLowerCase().replace(/[^a-z']/g, ""));
// The next word said this soon after the last one ends belongs to the same breath.
const BREATH = 0.15;
// A word said this long after the one before it starts a new caption.
const SLOW_WORD = 0.8;
// No caption flashes by quicker than this; a shorter one takes the next words.
const SHORTEST_SHOW = 0.35;
// The last caption stays this long when the scene allows.
const LAST_HOLD = 2;
const CAPTION_CHARACTERS = 28;
// A sentence's end is held up to this much longer to be read (the next group waits for it).
const SAME_PHRASE = 0.3;

const wordCount = (text) => String(text).split(/\s+/).filter(Boolean).length;

/**
 * True when there is a breath between `word` and `next`: 0.15 s or more from the end of the word
 * to the next one. With no end given, a gap half again as long as the usual one between words
 * (`usual`, the median) and 0.15 s longer than it. A word said over 0.8 s after the last starts anew.
 */
function breathBetween(word, next, usual) {
  const gap = next.at - word.at;
  // Words said slowly, one by one, each get their own caption: none shows long before it is said.
  if (gap > SLOW_WORD) return true;
  if (word.end !== undefined) return next.at - word.end >= BREATH;
  return gap >= usual * 1.5 && gap - usual >= BREATH;
}

/**
 * The energy of timed words: "high" over 3.2 words a second, "calm" under 2, else "talk". Music
 * (bpm) moves conversational speech up (128 or faster) or down (under 90).
 */
export function captionEnergy(words, lastEnd, bpm = null) {
  const count = words.reduce((sum, word) => sum + wordCount(word.text), 0);
  const pace = count / Math.max(0.5, lastEnd - words[0].at);
  const energy = pace > 3.2 ? "high" : pace < 2 ? "calm" : "talk";
  if (energy === "talk" && bpm) return bpm >= 128 ? "high" : bpm < 90 ? "calm" : "talk";
  return energy;
}

/**
 * Groups timed words into captions. Each group: {words, at (when it shows), end, text}.
 * `energy` is "high", "talk" or "calm" (captionEnergy picks it when left out); `until` is the
 * latest the last group may stay (the scene's end), for its 2 s hold. `group` caps the words a
 * caption holds (1: one at a time); a word too quick to read still takes the next.
 */
export function captionGroups(words, lastEnd, { energy = null, until = lastEnd, group = null } = {}) {
  // group sets the most words a caption holds (1: one word at a time); else the energy does.
  const most = group ?? CAPTION_ENERGY[energy ?? captionEnergy(words, lastEnd)][1];
  const cap = group;
  const needs = (text, last) => Math.max(SHORTEST_SHOW, readTime(text) + CAPTION_READY + 0.03 + (last ? CAPTION_LAST_OUT : 0));
  const ends = (group) => SENTENCE_END.test(group.words.at(-1).text);
  const textOf = (list) => list.map((word) => word.text).join(" ");
  // 1. Phrases: break at a sentence's end, a breath, or the word (and length) limit.
  const gaps = words.slice(1).map((word, index) => word.at - words[index].at).sort((a, b) => a - b);
  const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const phrases = [];
  for (const word of words) {
    const current = phrases.at(-1);
    const count = current ? current.words.reduce((sum, entry) => sum + wordCount(entry.text), 0) : 0;
    const before = current?.words.at(-1);
    const fits = current && !ends(current) && !breathBetween(before, word, usual)
      && count + wordCount(word.text) <= most && `${textOf(current.words)} ${word.text}`.length <= CAPTION_CHARACTERS + 8;
    if (fits) current.words.push(word);
    else {
      const carry = current && !ends(current) && current.words.length > 1 && leads(current.words.at(-1)) ? [current.words.pop()] : [];
      phrases.push({ words: [...carry, word] });
    }
  }
  // 2. Timing: each shows when its first word is said and stays until the next one shows. One
  // too short to read takes the next phrase, unless it ends a sentence and is nearly long
  // enough: then it is held up to 0.3 s and the next waits.
  const groups = [];
  let free = 0;
  for (let index = 0; index < phrases.length; index += 1) {
    const group = { words: [...phrases[index].words], at: round(Math.max(phrases[index].words[0].at, free)) };
    let next = index + 1;
    let hold = 0;
    while (next < phrases.length) {
      const short = needs(textOf(group.words), false) - (phrases[next].words[0].at - group.at);
      if (short <= 0) break;
      // A sentence's end, or (with group) any caption a little short, holds up to 0.3 s and the
      // next waits: one word at a time stays one word unless a word is truly too short to read,
      // and the captions never run more than 0.3 s behind the words.
      if ((ends(group) || cap) && short <= SAME_PHRASE) { hold = short; break; }
      // With group, joining stops at twice its words, or when the next phrase would leave the
      // caption shorter of its reading time: the caption holds 0.3 s instead (fast speech never
      // becomes one long line), unless that is still under the shortest show.
      if (cap && phrases[next].words[0].at - group.at + SAME_PHRASE >= SHORTEST_SHOW) {
        const joined = [...group.words, ...phrases[next].words];
        const after = next + 1 < phrases.length ? phrases[next + 1].words[0].at : lastEnd;
        const gains = needs(textOf(joined), false) - (after - group.at) < short;
        if (wordCount(textOf(joined)) > 2 * cap || !gains) { hold = SAME_PHRASE; break; }
      }
      group.words.push(...phrases[next].words);
      next += 1;
    }
    index = next - 1;
    group.text = textOf(group.words);
    group.end = round(Math.min(lastEnd, (next < phrases.length ? phrases[next].words[0].at : lastEnd) + hold));
    free = group.end;
    groups.push(group);
  }
  // 3. A last group too short to read shows a little early (up to 0.4 s, when the one before has
  // had its reading time) or, failing that, joins the one before it if that does not end a sentence.
  const last = groups.at(-1);
  if (groups.length > 1 && last.end - last.at < needs(last.text, true)) {
    const before = groups.at(-2);
    const early = round(Math.max(last.end - needs(last.text, true), before.at + needs(before.text, false)));
    if (early >= last.at - 0.4 && early < last.at) {
      last.at = early;
      before.end = early;
    } else if (!SENTENCE_END.test(before.words.at(-1).text) || last.at - before.at < needs(before.text, false)) {
      groups.splice(-2, 2, { words: [...before.words, ...last.words], at: before.at, end: last.end, text: `${before.text} ${last.text}` });
    } else {
      // Ending a sentence and readable: the last group keeps its own words and shows early as it can.
      last.at = round(Math.max(last.at - 0.4, before.at + needs(before.text, false)));
      before.end = last.at;
    }
  }
  // 4. The last line ends a section: it stays at least 2 s when the scene has room.
  const final = groups.at(-1);
  final.end = round(Math.max(final.end, Math.min(until, final.at + LAST_HOLD)));
  return groups;
}

// Where captions sit when no layer is in the way: a centered box 70% of the safe width.
const CAPTION_SHARE = 0.7;

/**
 * Picks where the captions go and the box they are laid out in. They keep clear of the layers
 * in `avoid` (or, without avoid, of pictures, videos and groups that cover part of the frame,
 * such as a phone or a card) for as long as the captions play: first at the asked position
 * (bottom by default), then the other of top and bottom; centered when that is clear, else in
 * the widest clear stretch beside the layers. Returns {position, box}.
 */
function captionSpot(ctx, input, groups, { safe, size, floor, fits }) {
  const preferred = input.position ?? "bottom";
  const full = Math.round(safe.width * (ctx.portrait ? 1 : CAPTION_SHARE));
  const boxFor = (position, x, width) => (position === "bottom"
    ? { x: Math.round(x), y: safe.y, width: Math.round(width), height: floor - safe.y }
    : { x: Math.round(x), y: safe.y, width: Math.round(width), height: safe.height });
  const from = groups[0].at;
  const until = groups.at(-1).end;
  const times = [];
  for (let time = from; time < until; time += 0.2) times.push(time);
  times.push(until - 0.01);
  const given = input.avoid ?? null;
  if (given) for (const id of given) ctx.layer(id, "avoid");
  const covering = (layer) => times.some((time) => {
    if (!ctx.shownAt(layer.id, time)) return false;
    const share = frameShare(ctx.boxAt(layer.id, time), ctx.frame);
    return share > 0.03 && share < 0.75;
  });
  // A status line on screen is always kept clear of (captions over its pill collide).
  const status = ctx.topLayers().filter((layer) => layer.move?.name === "status-line" && times.some((time) => ctx.shownAt(layer.id, time))).map((layer) => layer.id);
  const ids = [...(given ?? ctx.topLayers().filter((layer) => ["image", "video", "group"].includes(layer.type) && !layer.move && covering(layer)).map((layer) => layer.id)), ...status];
  const boxes = ids.flatMap((id) => times.filter((time) => ctx.shownAt(id, time)).map((time) => ctx.boxAt(id, time)));
  // The shade goes under the lowest layer kept clear of (a phone, a card or a status line), so it
  // darkens the footage but never what sits on top of it.
  const shown = ids.filter((id) => times.some((time) => ctx.shownAt(id, time)));
  const under = shown.length ? shown.reduce((low, id) => (ctx.order(id) < ctx.order(low) ? id : low)) : null;
  const centered = (position) => ({ position, under, box: boxFor(position, safe.x + (safe.width - full) / 2, full) });
  if (!boxes.length) return centered(preferred);
  const margin = Math.round(size * 0.4);
  const bandOf = (position) => {
    const tall = Math.round(size * 2.7);
    const y = position === "top" ? safe.y : position === "middle" ? safe.y + (safe.height - tall) / 2 : floor - tall;
    return { y, height: tall };
  };
  const order = [preferred, ...["bottom", "top"].filter((position) => position !== preferred)];
  const least = Math.round(ctx.frame.width * (ctx.portrait ? 0.6 : 0.28));
  for (const position of order) {
    const band = bandOf(position);
    const blocked = boxes.filter((box) => box.y < band.y + band.height + margin && box.y + box.height > band.y - margin)
      .map((box) => [box.x - margin, box.x + box.width + margin]);
    const clear = (a, b) => blocked.every(([left, right]) => right <= a || left >= b);
    const middle = safe.x + (safe.width - full) / 2;
    if (clear(middle, middle + full)) return { position, under, box: boxFor(position, middle, full) };
    // The clear stretches between the blocked ones, inside the safe area.
    const edges = [safe.x, ...blocked.flat().filter((x) => x > safe.x && x < safe.x + safe.width), safe.x + safe.width].sort((a, b) => a - b);
    let best = null;
    for (let index = 0; index + 1 < edges.length; index += 1) {
      const [a, b] = [edges[index], edges[index + 1]];
      if (b - a > (best ? best[1] - best[0] : 0) && clear(a + 1, b - 1)) best = [a, b];
    }
    const width = best ? Math.min(full, best[1] - best[0]) : 0;
    // Beside them only when the stretch is wide enough for every caption on two lines at 70% of the full size or more.
    if (best && width >= least && fits(width)) {
      ctx.note(`captions ${position}, ${best[0] + (best[1] - best[0]) / 2 < ctx.frame.width / 2 ? "left" : "right"} of ${ids.join(", ")} (kept clear${given ? "" : "; avoid:[...] names other layers"})`);
      return { position, under, box: boxFor(position, best[0] + (best[1] - best[0] - width) / 2, width) };
    }
  }
  ctx.note(`captions could not keep clear of ${ids.join(", ")}: no stretch at the top or bottom wide enough for the captions; they sit ${preferred} (give position, or move those layers)`);
  // No clear spot: the captions sit over the layers, so the shade must stay on top of them.
  return { ...centered(preferred), under: null };
}

/**
 * A caption on one line when it fits the box's width at its size, else on two lines of about the
 * same length (never one long line and a lone word under it). Keeps the layer centered in box.
 */
function balancedLines(ctx, layer, box) {
  const lay = (width) => layoutText({ ...layer, width }, ctx.fonts);
  const room = box.width;
  const pad = Math.ceil(layer.fontSize * 0.2);
  let width = room;
  if (lay(room).lines.length === 2) {
    // The narrowest width that still takes two lines splits the words most evenly.
    let low = Math.ceil(room / 2);
    let high = room;
    if (lay(low).lines.length > 2) {
      for (let step = 0; step < 14; step += 1) {
        const middle = Math.round((low + high) / 2);
        if (lay(middle).lines.length > 2) low = middle; else high = middle;
      }
    } else high = low;
    width = Math.min(room, high + pad);
  } else width = Math.min(room, Math.ceil(Math.max(...lay(room).lines.map((line) => line.width ?? 0)) + pad));
  const layout = lay(width);
  return { ...layer, width, x: Math.round(box.x + (box.width - width) / 2), height: Math.ceil(layout.height), lines: layout.lines.length };
}

export const captionWords = {
  name: "caption-words",
  about: "captions a phrase at a time (never across a sentence's end), as written, each cutting on as it is said and replacing the last, on one line or two balanced, low and clear of a phone, a card or a status line",
  fits: "spoken words, a voice or an app talking; a quiet line over footage",
  tags: ["type-words", "type-cut"],
  length: 2,
  lasts: "not needed: it lasts until the last word ends",
  fields: {
    words: { kind: "timed", ends: true, most: 300, max: 40, about: "[{text, at, end?}]: each word (or short phrase) and when it is said, in scene seconds" },
    text: { kind: "text", max: 400, about: "the words as one text, said from at (with times, or at a speaking pace)" },
    times: { kind: "times", most: 300, about: "with text: when each word is said, one time per word" },
    position: { kind: "choice", values: ["bottom", "middle", "top"], aliases: { center: "middle" }, about: "where the captions sit (default bottom; center is middle)" },
    keepCase: { kind: "choice", values: [true, false], about: "false lowercases the captions (default true: the case as written)" },
    entrance: { kind: "choice", values: ["cut", "rise", "pop"], about: "cut (default): an 80 ms fade on and off; rise: slides up out of a blur; pop: words wait at 70% color and 92% size, each going full as it is said" },
    highlight: { kind: "choice", values: ["none", "active"], about: "active: the word being said takes the look's accent color and the others sit at 70% (karaoke); none (default)" },
    scrim: { kind: "choice", values: [true, false], about: "true: a soft dark backing behind each caption; false: none (default: only when the shadowed words could fail contrast, as dark or dimmed words can)" },
    avoid: { kind: "layers", most: 8, about: "layers the captions keep clear of (default: pictures, videos and groups that cover part of the frame, such as a phone)" },
    energy: { kind: "choice", values: ["high", "talk", "calm"], about: "words a caption: high 2 to 3, talk 3 to 5, calm 4 to 6 (default from the pace of the words and the music)" },
    group: { kind: "number", low: 1, high: 6, about: "most words a caption (over energy); 1: one word at a time" },
    size: { kind: "choice", values: ["small", "medium", "big"], about: "big (default, capitals 6% of the height), medium (75%) or small (55%, a quiet line)" },
  },
  oneOf: [["words", "text"]],
  example: { words: [{ text: "so", at: 0.4 }, { text: "we gave", at: 1.2 }, { text: "it eyes.", at: 2.2, end: 3.4 }] },
  setup: "none",
  build(ctx, input) {
    let words = input.words;
    if (!words) {
      const list = input.text.split(/\s+/).filter(Boolean);
      if (input.times && input.times.length !== list.length) throw new Error(`caption-words: text has ${list.length} words but times has ${input.times.length}.`);
      words = list.map((text, index) => ({ text, at: round(input.times ? input.times[index] : ctx.start + index / SPEAKING_PACE) }));
    }
    for (let index = 1; index < words.length; index += 1)
      if (words[index].at < words[index - 1].at) throw new Error("caption-words: words must be in time order.");
    const last = words.at(-1);
    const lastEnd = round(last.end ?? last.at + Math.max(1, readTime(last.text) + CAPTION_READY + CAPTION_LAST_OUT + 0.3));
    if (lastEnd > ctx.sceneDuration + 1e-6) throw new Error(`caption-words: the last word ends at ${lastEnd} s, after the scene ends (${ctx.sceneDuration} s).`);
    // How many words a caption holds: the energy field, else the pace of the words (and the music).
    const energy = input.energy ?? captionEnergy(words, lastEnd, ctx.bpm);
    const groups = captionGroups(words, lastEnd, { energy, until: ctx.sceneDuration, group: input.group ? Math.round(input.group) : null });
    // The last caption may stay past the last word (2 s on screen when the scene has room).
    const shownUntil = groups.at(-1).end;
    const safe = safeArea(ctx.frame);
    // Big words: capitals about 6% of the frame's height in a wide frame (smaller on a narrow one).
    // size small or medium scales that down (a quiet line, not a subtitle bar).
    const size = Math.round(Math.min(ctx.frame.height * 0.085, ctx.frame.width * 0.075) * CAPTION_SIZES[input.size ?? "big"]);
    const lift = Math.round(size * 0.35);
    const blur = Math.round(size * 0.2);
    // Low in the frame, but inside the safe area (phone apps cover the bottom of a tall frame).
    const floor = Math.min(safe.y + safe.height, Math.round(ctx.frame.height * 0.86));
    // Where the captions go: the asked position (bottom by default), or the other one, in the
    // widest stretch of the frame that no layer to avoid covers while they play (see captionSpot).
    // The brand's or the project's font at its own weight; the look's font at 600.
    const weight = ctx.brandFonts ? undefined : 600;
    const texts = groups.map((group) => (input.keepCase === false ? group.text.toLowerCase() : group.text));
    // A stretch fits when every caption takes at most two lines in it at 70% of the full size.
    const fits = (width) => texts.every((text) => {
      const probe = textLayer(ctx, { part: "probe", text, role: "caption", step: "body", size, weight, box: { x: 0, y: 0, width: ctx.frame.width * 4, height: ctx.frame.height }, align: "center", face: "body", maxLines: 1 });
      return layoutText({ ...probe, fontSize: Math.round(size * 0.7), width }, ctx.fonts).lines.length <= 2;
    });
    const spot = captionSpot(ctx, input, groups, { safe, size, floor, fits });
    const box = spot.box;
    const position = spot.position;
    // Each group's text layer, laid out first so the shade below can be shaped around them.
    const layers = groups.map((group, index) => {
      const text = texts[index];
      const layer = balancedLines(ctx, textLayer(ctx, { part: `w${index + 1}`, text, role: "caption", step: "body", size, weight, box, align: "center", face: "body", maxLines: 2, name: `Caption: ${text}` }), box);
      layer.y = position === "top" ? box.y : position === "middle" ? Math.round(box.y + (box.height - layer.height) / 2) : box.y + box.height - layer.height;
      return layer;
    });
    // A soft dark backing that hugs the caption (a rounded box padded about 0.6 of the type size,
    // its edge feathered by a blur), as TV and streaming subtitles are backed: only behind the
    // words, never a gradient over the frame. One shade follows the captions, resizing to each as
    // it is said, so it never blinks between them. 72% black: white words pass the contrast gate
    // (3:1 for large type) even on white footage. Left out when the words' halo shadow already
    // passes over any picture (needsScrim), unless scrim is true.
    const ink = ctx.style.colors.text;
    // Every color a word takes: the ink, the dimmed 70% (karaoke, pop) and the accent (karaoke).
    const fills = input.highlight === "active" ? [ink, dimmed(ink), ctx.style.colors.accent] : input.entrance === "pop" ? [ink, dimmed(ink)] : [ink];
    if (needsScrim(ctx, input.scrim, { fills, shadow: shadowFor(ctx), size: layers[0].fontSize, weight: layers[0].fontWeight })) {
      const padX = Math.round(size * 0.7);
      const padY = Math.round(size * 0.35);
      const fit = (layer) => ({ x: layer.x - padX, y: layer.y - padY, width: layer.width + padX * 2, height: layer.height + padY * 2 });
      const first = fit(layers[0]);
      const scrim = ctx.add("scrim", createLayer("rectangle", {
        name: "Caption shade", ...first, radius: Math.round(size * 0.5), blur: Math.round(size * 0.26), role: "decor", allowOverlap: true, fill: "#000000B8",
      }), spot.under ? { below: spot.under } : "top");
      const shadeFade = input.entrance === "rise" && !ctx.reduced ? 0.3 : CAPTION_CUT;
      ctx.animate(scrim, "in", motion({ name: "Fade in", kind: "in", start: groups[0].at, duration: shadeFade, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      let was = first;
      layers.forEach((layer, index) => {
        const now = fit(layer);
        if (index === 0 || ["x", "y", "width", "height"].every((key) => Math.abs(now[key] - was[key]) < 1)) return;
        ctx.animate(scrim, `fit${index + 1}`, motion({ name: "Fit caption", start: groups[index].at, duration: 0.22, easing: CURVES.arrive, from: was, to: now }));
        was = now;
      });
      ctx.animate(scrim, "out", motion({ name: "Fade out", kind: "out", start: shownUntil - Math.min(shadeFade, CAPTION_LAST_OUT), duration: Math.min(shadeFade, CAPTION_LAST_OUT), easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(scrim, "hide", hide(shownUntil));
    }
    const rise = input.entrance === "rise" && !ctx.reduced;
    const pop = input.entrance === "pop" && !ctx.reduced;
    const active = input.highlight === "active";
    groups.forEach((group, index) => {
      const final = index === groups.length - 1;
      // Karaoke and pop start every word at 70% (fill alpha, so the caption's own fade is untouched).
      const made = ctx.add(`w${index + 1}`, { ...layers[index], shadow: shadowFor(ctx), fill: active || pop ? dimmed(ink) : ink });
      const keys = wordKeys(group);
      if (active) {
        // Karaoke: the word being said takes the accent; the rest sit at 70%.
        const accent = ctx.style.colors.accent;
        ctx.animate(made, "say", { ...motion({ name: "Say word", start: group.at, duration: WORD_SWITCH, easing: CURVES.fade, from: { fill: dimmed(ink) }, to: { fill: accent } }), ...keys.say });
        ctx.animate(made, "said", { ...motion({ name: "Word said", start: group.at, duration: WORD_SWITCH, easing: CURVES.fade, from: { fill: accent }, to: { fill: dimmed(ink) } }), ...keys.said });
      } else if (pop) ctx.animate(made, "say", { ...motion({ name: "Say word", start: group.at, duration: WORD_SWITCH, easing: CURVES.fade, from: { fill: dimmed(ink) }, to: { fill: ink } }), ...keys.say });
      // Pop: the group cuts on whole (words not said yet already in place at 70% and 92%, so the
      // line stays centered on its shade) and each word scales up to 100% as it is said, no overshoot.
      if (pop) ctx.animate(made, "pop", { ...motion({ name: "Pop words", kind: "in", start: group.at, duration: WORD_POP, easing: CURVES.arrive,
        from: { scaleX: POP_FROM, scaleY: POP_FROM }, to: { scaleX: 1, scaleY: 1 } }), ...keys.say });
      // Small, seeded differences so a run of captions never moves as one machine.
      const enter = round(CAPTION_IN + [0, 0.04, -0.02, 0.02, 0.06][(index * 3 + ctx.rng.pick([0, 1, 2])) % 5]);
      const easing = index % 2 ? CURVES.arrive : [0.18, 0.95, 0.3, 1];
      if (rise) ctx.animate(made, "in", motion({ name: "Blur up", kind: "in", start: group.at, duration: enter, easing,
        from: { opacity: 0, y: made.y + lift, blur }, to: { opacity: 1, y: made.y, blur: 0 } }));
      else ctx.animate(made, "in", motion({ name: "Fade in", kind: "in", start: group.at, duration: CAPTION_CUT, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      const out = rise ? CAPTION_LAST_OUT : CAPTION_CUT;
      if (final) ctx.animate(made, "out", motion({ name: "Fade out", kind: "out", start: group.end - out, duration: out, easing: rise ? CURVES.leave : CURVES.fade,
        from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(made, "hide", hide(group.end));
    });
    // With group, say which captions took more words, and why (a word said too quickly to read).
    const cap = input.group ? Math.round(input.group) : null;
    const joined = cap ? groups.filter((group) => wordCount(group.text) > cap).map((group) => `"${group.text}"`) : [];
    ctx.note(`${groups.length} caption group${groups.length === 1 ? "" : "s"} from ${words.length} word${words.length === 1 ? "" : "s"} (${cap ? `at most ${cap}` : `${energy} energy: ${CAPTION_ENERGY[energy].join(" to ")}`} words a caption)${joined.length ? `; ${joined.slice(0, 4).join(", ")} joined: each word was said under the 0.67 s a caption needs to be read` : ""}`);
    return { end: shownUntil, start: words[0].at };
  },
};

// ---- push-through-type ------------------------------------------------------------------
const TYPE_IN = 0.55;
// The share of the move spent on the fast part of the push, after the word has been read.
const PUSH = 0.9;
// How much wider the letters are spaced at the start of the entrance (they close up to 1).
const OPEN_SPACING = 2.2;
// Glossy type: the text color with a soft cooler band, like light on chrome. The band sits at
// `at` (0 top, 1 bottom); the hold slides it down the word, so the title has motion while it is read.
const CHROME = (text, at) => ({ type: "linear", angle: 90, stops: [
  { offset: 0, color: text }, { offset: round(Math.max(0.01, at - 0.2)), color: text },
  { offset: round(at), color: mix(text, "#8E95A3", 0.5) }, { offset: round(Math.min(0.99, at + 0.2)), color: text }, { offset: 1, color: text },
] });

export const pushThroughType = {
  name: "push-through-type",
  about: "a big glossy word (the brand's or the project's font; a serif when there is none) sharpens in and drifts closer while a sheen slides down it, then the camera pushes into one of its letters, slowly at first and faster all the time, the colors splitting as it starts, until the next shot, seen inside the letter, fills the frame",
  fits: "an opening title or a name reveal that leads straight into the first shot",
  tags: ["type-giant", "zoom-through", "rgb-split"],
  length: 2.6,
  shortest: 1.8,
  fields: {
    text: { kind: "text", required: true, max: 24, about: "the word (a name or one short line)" },
    next: { kind: "layer", about: "the shot seen inside the letter and then revealed (it is put just above the word)" },
    letter: { kind: "number", low: 1, high: 24, whole: true, about: "which letter to push into, counting from 1 (default the one that fills the frame soonest)" },
  },
  example: { text: "acme.", next: "shot-a", at: 0.2 },
  setup: "shot-a, a full-frame picture or video",
  build(ctx, input) {
    const next = input.next ? ctx.layer(input.next, "next") : null;
    // The brand's or the project's display font (ctx.brandFonts); without one, the bundled serif
    // at a weight it ships (700), so it never falls back to another face.
    const serif = !ctx.brandFonts ? { fontFamily: "Noto Serif", fontSource: "", fontWeight: 700, fontStyle: "normal" } : null;
    const safe = safeArea(ctx.frame);
    // Big type: the word is about half of a wide frame (most of a tall one).
    const target = ctx.frame.width * (ctx.portrait ? 0.7 : 0.5);
    const probe = textLayer(ctx, { part: "word", text: input.text, role: "headline", step: "display", size: 100, box: { ...safe, width: ctx.frame.width * 4 }, align: "center", maxLines: 1, name: input.text });
    const measure = (layer) => {
      const layout = layoutText({ ...layer, width: ctx.frame.width * 8 }, ctx.fonts);
      return { width: Math.max(...layout.lines.map((line) => line.width ?? 0)), height: layout.height };
    };
    const spacing = (size) => round(size * 0.06);
    const at100 = measure({ ...probe, ...(serif ?? {}), fontSize: 100, letterSpacing: spacing(100) });
    const fontSize = Math.round(Math.min(100 * target / at100.width, (ctx.frame.height * 0.42 * 100) / at100.height));
    const word = ctx.add("word", { ...probe, ...(serif ?? {}), fontSize, letterSpacing: spacing(fontSize), fill: CHROME(ctx.style.colors.text, 0.2) }, next ? { below: next.id } : "top");
    // The box is as wide as the word with its letters spaced open (the entrance), plus room, so
    // the word stays on one line the whole time (a narrower box wraps its last letter).
    const size = measure(word);
    const open = measure({ ...word, letterSpacing: spacing(fontSize) * OPEN_SPACING });
    word.width = Math.ceil(Math.max(size.width, open.width) + fontSize * 0.6);
    word.height = Math.ceil(size.height);
    word.x = Math.round((ctx.frame.width - word.width) / 2);
    word.y = Math.round((ctx.frame.height - word.height) / 2);
    const lines = layoutText(word, ctx.fonts).lines.length;
    if (lines !== 1) throw new Error(`push-through-type: "${input.text}" does not fit on one line; shorten it.`);
    // The letter to push into, and the point inside its ink where the frame fills soonest.
    const units = textUnits(layoutText(word, ctx.fonts), "letters").filter((unit) => unit.text.trim());
    const inks = units.map((unit) => unit.glyphs.map((glyph) => inkPoint(glyph, ctx.frame)).filter(Boolean).sort((a, b) => a.need - b.need)[0] ?? null);
    const chosen = input.letter !== undefined ? Math.min(units.length, input.letter) - 1
      : inks.reduce((best, ink, index) => (ink && (best < 0 || ink.need < inks[best].need) ? index : best), -1);
    const ink = inks[chosen];
    if (!ink) throw new Error(`push-through-type: letter ${chosen + 1} of "${input.text}" has no ink wide enough to push into; choose another letter.`);
    const hold = Math.max(readTime(input.text) + 0.15, 0.8);
    const needs = round(TYPE_IN + hold + 0.5);
    if (ctx.duration + 1e-6 < needs) throw new Error(`push-through-type needs dur of at least ${needs} s to show "${input.text}" long enough to read.`);
    const cut = ctx.end;
    // With music, the push lasts whole beats, so a cut on a beat starts the push on one too.
    const period = ctx.bpm ? 60 / ctx.bpm : null;
    const push = period ? Math.max(1, Math.round(PUSH / period)) * period : PUSH;
    const pushAt = round(Math.max(ctx.start + TYPE_IN + hold, cut - push));
    // 1. The word sharpens out of a blur while its letters close up; a sheen slides down it while
    // it is read (it never sits still).
    const sheen = motion({ name: "Sheen", start: ctx.start, duration: round(pushAt - ctx.start), easing: CURVES.drift, from: { fill: CHROME(ctx.style.colors.text, 0.2) }, to: { fill: CHROME(ctx.style.colors.text, 0.8) } });
    if (ctx.reduced) {
      ctx.animate(word, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: TYPE_IN, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      ctx.animate(word, "sheen", sheen);
      ctx.animate(word, "out", motion({ name: "Fade out", kind: "out", start: pushAt, duration: 0.4, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(word, "hide", hide(pushAt + 0.4));
      if (next) ctx.animate(next.id, "in", motion({ name: "Fade in", kind: "in", start: pushAt + 0.2, duration: 0.4, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "next");
      return { end: round(Math.max(ctx.end, pushAt + 0.6)) };
    }
    // One push from the first frame to the cut, in two parts that meet at the same speed: a slow
    // drift closer while the word is read (30%), then faster and faster into the letter's ink,
    // which ends centered at twice the scale where the letter first covers the frame, so it covers
    // the frame a few frames before the cut and the mask goes without a pop.
    const box = { x: word.x, y: word.y, width: word.width, height: word.height };
    const point = { x: word.x + ink.x, y: word.y + ink.y };
    const creep = 1.3;
    const final = round(Math.min(400, ink.need * 2.2), 2);
    const landed = { x: round(ctx.frame.width / 2 - word.width / 2 - (ink.x - word.width / 2) * final, 1), y: round(ctx.frame.height / 2 - word.height / 2 - (ink.y - word.height / 2) * final, 1) };
    // The word moves along one straight line as it grows (its place a fixed share of the way to
    // where it lands for each step of scale), so the creep and the push meet at the same speed.
    const along = (scale) => ({ x: round(word.x + (landed.x - word.x) * (scale - 1) / (final - 1), 1), y: round(word.y + (landed.y - word.y) * (scale - 1) / (final - 1), 1) });
    const crept = Number.isFinite(final) && final > creep ? along(creep) : scaledAbout(box, point, creep);
    const creepTime = pushAt - ctx.start;
    const pushTime = cut - pushAt;
    // The creep ends moving at (creep - 1) / creepTime a second; the push starts at that speed.
    const startSlope = Math.max(0.0005, ((creep - 1) / creepTime) * (pushTime / (final - creep)));
    const pushEase = [0.5, round(0.5 * startSlope, 5), 0.9, 0.22];
    const moves = (layer) => {
      ctx.animate(layer, "creep", motion({ name: "Creep in", start: ctx.start, duration: creepTime, easing: [0.2, 0.1, 0.7, 0.7],
        from: { x: word.x, y: word.y, scaleX: 1, scaleY: 1 }, to: { x: crept.x, y: crept.y, scaleX: creep, scaleY: creep } }));
      ctx.animate(layer, "push", motion({ name: "Push into the letter", start: pushAt, duration: pushTime, easing: pushEase,
        from: { x: crept.x, y: crept.y, scaleX: creep, scaleY: creep }, to: { x: landed.x, y: landed.y, scaleX: final, scaleY: final } }));
    };
    ctx.animate(word, "in", motion({ name: "Sharpen", kind: "in", start: ctx.start, duration: TYPE_IN, easing: CURVES.settle,
      from: { opacity: 0, blur: Math.round(14 * ctx.scale), letterSpacing: spacing(fontSize) * OPEN_SPACING }, to: { opacity: 1, blur: 0, letterSpacing: spacing(fontSize) } }));
    ctx.animate(word, "sheen", sheen);
    moves(word);
    // 2. The colors split as the push sets off and close again before the next shot shows in the
    // letter. The split's size is a share of the word's own box, so it is kept to about 10 px on
    // screen at the scale the word has then (a split at the push's full scale is a slab of color).
    const showAt = round(pushAt + pushTime * 0.15);
    const splitPeak = round(pushAt - Math.min(0.25, creepTime * 0.3));
    const splitAmount = round(Math.min(0.4, (10 * ctx.scale) / (0.1 * Math.min(word.width, word.height) * creep)), 3);
    ctx.animate(word, "split", effect({ name: "RGB split", effect: "rgb-shift", start: splitPeak - 0.2, duration: 0.2, easing: CURVES.accelerate,
      from: { amount: 0 }, to: { amount: splitAmount, direction: 0 }, keepStill: "off" }));
    ctx.animate(word, "unsplit", effect({ name: "RGB split closes", effect: "rgb-shift", start: splitPeak, duration: round(showAt - splitPeak), easing: CURVES.settle,
      from: { amount: splitAmount }, to: { amount: 0, direction: 0 }, keepStill: "off" }));
    if (!next) {
      ctx.animate(word, "out", motion({ name: "Fade out", kind: "out", start: cut - pushTime * 0.4, duration: pushTime * 0.4, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(word, "hide", hide(cut));
      return { end: cut };
    }
    // 3. The next shot shows inside the letters (a copy of the word masks it) and comes forward
    // as the push passes into the letter, while the glossy word fades away under it (its edges
    // would ring the letter). The mask goes at the cut, when the letter covers the whole frame.
    const window = ctx.add("window", { ...word, fill: "#FFFFFF", isMask: true, role: "decor", animations: [] }, { below: next.id });
    ctx.animate(window, "in", motion({ name: "Sharpen", kind: "in", start: ctx.start, duration: TYPE_IN, easing: CURVES.settle,
      from: { letterSpacing: spacing(fontSize) * OPEN_SPACING }, to: { letterSpacing: spacing(fontSize) } }));
    moves(window);
    const showFor = round(pushTime * 0.35);
    ctx.animate(next.id, "in", motion({ name: "Show in the letter", kind: "in", start: showAt, duration: showFor, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "next");
    ctx.animate(word, "out", motion({ name: "Fade out", kind: "out", start: showAt, duration: showFor, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
    // No zoom blur on the word: it smeared the glossy word's edges and stayed on
    // after the move ended. The word fades out during the push instead.
    const settle = 0.5;
    ctx.animate(next.id, "settle", motion({ name: "Come forward", start: showAt, duration: round(cut + settle - showAt), easing: CURVES.settle,
      from: { scaleX: 1.3 * (next.scaleX ?? 1), scaleY: 1.3 * (next.scaleY ?? 1) }, to: { scaleX: next.scaleX ?? 1, scaleY: next.scaleY ?? 1 } }), "next");
    ctx.animate(word, "hide", hide(round(showAt + showFor)));
    ctx.animate(window, "hide", hide(cut));
    return { end: round(cut + settle) };
  },
};

// ---- status-line --------------------------------------------------------------------------
/**
 * The top of the status block (tile, then the line): centered top to bottom when no other text
 * is on screen there while it plays, else at the top, else at the bottom of the safe area.
 * Throws when text covers all three (a caption and the status line would collide).
 */
function statusTop(ctx, { lines, end, column, width, blockHeight, tops }) {
  const margin = Math.round(12 * ctx.scale);
  const texts = ctx.topLayers().filter((layer) => layer.type === "text");
  const times = [];
  for (let time = lines[0].at; time < end; time += 0.2) times.push(time);
  const hits = (top) => {
    const box = { x: column - width / 2 - margin, y: top - margin, width: width + 2 * margin, height: blockHeight + 2 * margin };
    const found = new Set();
    for (const layer of texts) {
      for (const time of times) {
        if (!ctx.shownAt(layer.id, time)) continue;
        const other = ctx.boxAt(layer.id, time);
        if (other.x < box.x + box.width && other.x + other.width > box.x && other.y < box.y + box.height && other.y + other.height > box.y) { found.add(`${layer.id} (${round(time, 1)} s)`); break; }
      }
    }
    return [...found];
  };
  const first = hits(tops[0]);
  if (!first.length) return tops[0];
  for (const top of tops.slice(1)) {
    if (!hits(top).length) {
      ctx.note(`status line moved ${top === tops[1] ? "up" : "down"}, clear of ${first.join(", ")}`);
      return top;
    }
  }
  throw new Error(`status-line would cover text on screen at the same time: ${first.join(", ")}. Move or shorten that text, give the status line other times (at, dur, lines), or make the captions after it (caption-words keeps clear of a status line).`);
}

/**
 * When the scene's quiet end starts, or null: a dark plain shape over the whole frame (a dip to
 * black) or a logo that stays to the end, coming on in the scene's last 30%. Only layers already
 * in the scene count, so the dip goes in before the status line (or give dur).
 */
function quietEndOf(ctx) {
  const last = ctx.sceneDuration - 0.01;
  const dark = (layer) => ["rectangle", "ellipse"].includes(layer.type) && layer.fillEnabled !== false
    && /^#[0-9a-f]{6}/i.test(layer.fill ?? "") && luminance(layer.fill.slice(0, 7)) < 0.02;
  const covers = (layer) => { const box = ctx.boxAt(layer.id, last); return box.x <= 1 && box.y <= 1 && box.x + box.width >= ctx.frame.width - 1 && box.y + box.height >= ctx.frame.height - 1; };
  let quiet = null;
  for (const layer of ctx.topLayers()) {
    if (layer.move?.name === "status-line" || (!(dark(layer) && covers(layer)) && layer.role !== "logo")) continue;
    if (!ctx.shownAt(layer.id, last)) continue;
    let from = last;
    while (from - 0.05 > 0 && ctx.shownAt(layer.id, from - 0.05)) from -= 0.05;
    // To the hundredth: halve the step between hidden and shown.
    for (let [hidden, step] = [from - 0.05, 0.05]; step > 0.002; step /= 2) {
      const middle = hidden + step / 2;
      if (ctx.shownAt(layer.id, middle)) from = middle; else hidden = middle;
    }
    if (from >= ctx.sceneDuration * 0.7 && (quiet === null || from < quiet)) quiet = round(from, 2);
  }
  return quiet;
}

export const statusLine = {
  name: "status-line",
  untilEnd: true,
  lasts: "default: to the end of the scene, or until a quiet end already in the scene (a dip to black or a logo alone in the last 30%) starts",
  about: "a big app icon tile (the icon picture itself, rounded) sits in the left (or right) third with a large status line under it that changes its words (\"is listening…\", \"is speaking…\"), each change blurring out and sliding up",
  fits: "what an app or agent is doing over footage of it; a narrator that is the product",
  tags: ["status-line", "type-swap"],
  length: 4,
  fields: {
    lines: { kind: "timed", required: true, most: 12, max: 32, about: "[{text, at}]: each status and when it starts (scene seconds); the first one shows from at" },
    icon: { kind: "picture", about: "an uploaded picture for the icon (default the brand's logo)" },
    label: { kind: "text", max: 16, about: "the app's name, written in a white tile under the icon (default: none when icon is given)" },
    side: { kind: "choice", values: ["left", "right"], about: "which third of a wide frame it sits in (default left); pick the side away from the person on screen" },
    scrim: { kind: "choice", values: [true, false], about: "true puts a dark pill behind the status line, false never (default: only when the shadowed words could fail contrast)" },
    place: { kind: "choice", values: ["middle", "bottom-left", "bottom-right"], about: "middle (default): the big tile in the side's third; bottom-left or bottom-right: a small badge low in that corner with the line under it, aligned to its edge (like an app's 'is listening…' badge)" },
    size: { kind: "choice", values: ["small", "big"], about: "big: tile 20% of the frame's height; small: 11% (default: small in a bottom corner, big in the middle)" },
    swap: { kind: "choice", values: ["blur", "cut"], about: "how the words change: blur (blur out, slide up) or cut (a plain switch) (default: cut in a bottom corner, blur in the middle)" },
  },
  example: { at: 0.3, label: "acme", lines: [{ text: "is listening…", at: 0.6 }, { text: "is speaking…", at: 2.4 }] },
  setup: "none (label names the app; give icon, or set_brand with a logo picture, for its icon)",
  build(ctx, input) {
    const picture = input.icon ? ctx.picture(input.icon) : ctx.logo?.media ?? null;
    if (!picture && !ctx.logo?.text && !input.label) throw new Error("status-line needs icon (an uploaded picture), label, or a brand with a logo.");
    const lines = input.lines;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].at <= lines[index - 1].at) throw new Error("status-line: lines must be in time order.");
      const room = lines[index].at - lines[index - 1].at;
      const needs = round(readTime(lines[index - 1].text) + 0.45);
      if (room + 1e-6 < needs) throw new Error(`status-line: "${lines[index - 1].text}" needs ${needs} s before the next line, but has ${round(room)} s.`);
    }
    if (lines[0].at < ctx.start) throw new Error(`status-line: the first line starts at ${lines[0].at} s, before the move (${ctx.start} s).`);
    let end = round(Math.max(ctx.end, lines.at(-1).at + readTime(lines.at(-1).text) + 0.6));
    // A quiet end (a dip to black, the logo alone): the badge goes as it starts, not over the black.
    const quiet = quietEndOf(ctx);
    if (quiet !== null && quiet < end && quiet >= lines.at(-1).at + readTime(lines.at(-1).text) + 0.3) {
      end = quiet;
      ctx.note(`status line leaves at ${quiet} s, as the quiet end (a dip to black or the logo alone) starts`);
    }
    const safe = safeArea(ctx.frame);
    // A picture icon usually carries the app's name already (a wordmark), so the brand's name is
    // written in the tile only when there is no picture or the agent asks for it with label.
    const label = input.label ?? (picture ? null : ctx.logo?.text ?? null);
    // A squarish picture with no label is the tile itself (an app icon with its own background),
    // not a small icon on a white plate, which framed it in a white border.
    const iconIsTile = Boolean(picture && !label && Math.abs(Math.log(picture.width / picture.height)) < 0.25);
    // A big app tile (20% of the frame's height) with the status line large and centered under
    // it, in the left third of a wide frame (the middle of a tall one), centered top to bottom.
    // A bottom corner (place) is a badge: a small tile low in the corner with the line under
    // it, aligned to the tile's outer edge, and the words switching with a cut.
    const corner = input.place && input.place !== "middle" ? input.place.slice(7) : null;
    const small = (input.size ?? (corner ? "small" : "big")) === "small";
    const tile = Math.round(Math.min(ctx.frame.height * 0.2, ctx.frame.width * 0.3) * (small ? 0.55 : 1));
    const leftColumn = Math.max(safe.x + safe.width * 0.2, ctx.frame.width * 0.26);
    const longest = lines.reduce((best, line) => (line.text.length > best.length ? line.text : best), "");
    // In a corner the line may run 40% of the safe width from the tile's outer edge.
    const cornerWidth = Math.round(safe.width * 0.4);
    const edge = corner === "right" ? safe.x + safe.width : safe.x;
    const column = Math.round(corner ? (corner === "right" ? edge - cornerWidth / 2 : edge + cornerWidth / 2)
      : ctx.portrait ? ctx.frame.width / 2 : input.side === "right" ? ctx.frame.width - leftColumn : leftColumn);
    const textWidth = corner ? cornerWidth : Math.round(ctx.portrait ? safe.width : Math.min(safe.width * 0.5, 2 * Math.min(column - safe.x, safe.x + safe.width - column)));
    const sizing = textLayer(ctx, { part: "status", text: longest, role: "caption", step: "body", size: Math.round(tile * (small ? 0.36 : 0.42)),
      box: { x: column - Math.round(textWidth / 2), y: 0, width: textWidth, height: ctx.frame.height }, align: corner ?? "center", face: "body", weight: ctx.brandFonts ? undefined : 600, maxLines: 1 });
    if (corner === "left") sizing.x = edge;
    if (corner === "right") sizing.x = edge - sizing.width;
    const gap = Math.round(tile * 0.16);
    const blockHeight = tile + gap + sizing.height;
    const middle = ctx.portrait ? safe.y + safe.height * 0.55 : ctx.frame.height / 2;
    const fitTop = (y) => Math.round(Math.min(safe.y + safe.height - blockHeight, Math.max(safe.y, y)));
    // A corner badge keeps clear by its own width (tile or line), so it sits beside a centered caption in its corner.
    const blockWidth = corner ? Math.max(tile, sizing.width) : Math.max(tile, sizing.width + Math.round(sizing.fontSize * 0.7));
    const top = statusTop(ctx, { lines, end, column: corner === "left" ? edge + blockWidth / 2 : corner === "right" ? edge - blockWidth / 2 : column, tile, blockHeight, width: blockWidth,
      tops: (corner ? [safe.y + safe.height - blockHeight, safe.y] : [middle - blockHeight / 2, safe.y, safe.y + safe.height - blockHeight]).map(fitTop) });
    // A tight soft shadow on the words: offset 2 px, blurred about 10 px, black at 80%. The
    // contrast gate counts it as a halo, so light words read on bright footage with no box.
    const shadow = { color: SHADE, x: 0, y: Math.round(2 * ctx.scale), blur: Math.round(10 * ctx.scale) };
    // A small dark rounded pill tight behind the words only when they could still fail contrast
    // (dark ink, or scrim true).
    let shade = null;
    if (needsScrim(ctx, input.scrim, { fills: [ctx.style.colors.text], shadow, size: sizing.fontSize, weight: sizing.fontWeight })) {
      const padX = Math.round(sizing.fontSize * 0.34);
      const padY = Math.round(sizing.fontSize * 0.1);
      const pillHeight = sizing.height + 2 * padY;
      shade = ctx.add("pill", createLayer("rectangle", {
        name: "Status pill", x: sizing.x - padX, y: top + tile + gap - padY, width: sizing.width + 2 * padX, height: pillHeight,
        radius: Math.round(pillHeight / 2), fill: "#000000BF", role: "decor", allowOverlap: true,
      }));
      ctx.animate(shade, "in", motion({ name: "Fade in", kind: "in", start: lines[0].at, duration: 0.3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    }
    const status = ctx.add("status", { ...sizing, y: top + tile + gap, text: lines[0].text, name: "Status line", fill: ctx.style.colors.text, textResize: "height", shadow });
    const left = corner === "left" ? edge : corner === "right" ? edge - tile : column - Math.round(tile / 2);
    const tileShadow = { color: "#00000059", x: 0, y: Math.round(4 * ctx.scale), blur: Math.round(18 * ctx.scale) };
    const plate = iconIsTile
      ? ctx.add("icon", createLayer("image", { name: "Icon", src: picture.src, x: left, y: top, width: tile, height: tile, radius: Math.round(tile * 0.24), role: "logo", shadow: tileShadow }))
      : ctx.add("tile", createLayer("rectangle", { name: "Icon tile", x: left, y: top, width: tile, height: tile, radius: Math.round(tile * 0.24), fill: ctx.style.colors.text, role: "decor", shadow: tileShadow }));
    const parts = [plate];
    let nameLayer = null;
    if (label) {
      const nameBox = { x: left + Math.round(tile * 0.06), y: top, width: Math.round(tile * 0.88), height: tile };
      nameLayer = textLayer(ctx, { part: "name", text: label, role: "logo", step: "label", size: Math.round(tile * 0.2), box: nameBox, align: "center", face: "body", maxLines: 1 });
      nameLayer.y = top + tile - nameLayer.height - Math.round(tile * 0.08);
    }
    if (picture && !iconIsTile) {
      const room = label ? Math.round(tile * 0.5) : Math.round(tile * 0.64);
      const fit = Math.min(room / picture.width, room / picture.height);
      const width = Math.round(picture.width * fit);
      const height = Math.round(picture.height * fit);
      const iconTop = label ? top + Math.round((nameLayer.y - top - height) / 2) + Math.round(tile * 0.03) : top + Math.round((tile - height) / 2);
      parts.push(ctx.add("icon", createLayer("image", { name: "Icon", src: picture.src, x: left + Math.round((tile - width) / 2), y: iconTop, width, height, role: "logo" })));
    }
    if (nameLayer) parts.push(ctx.add("name", { ...nameLayer, fill: ctx.style.colors.bg, name: "App name" }));
    // The tile pops in from a little smaller; the parts inside arrive with it.
    parts.forEach((layer, index) => {
      const delay = index ? 0.06 : 0;
      if (ctx.reduced) ctx.animate(layer, "in", motion({ name: "Fade in", kind: "in", start: ctx.start + delay, duration: 0.4, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      else {
        const grow = 0.72;
        const pivot = { x: plate.x + tile / 2, y: plate.y + tile };
        const small = scaledAbout(layer, pivot, grow);
        ctx.animate(layer, "in", motion({ name: "Pop in", kind: "in", start: ctx.start + delay, duration: 0.5 + delay, easing: CURVES.settle,
          from: { opacity: 0, x: small.x, y: small.y, scaleX: grow, scaleY: grow }, to: { opacity: 1, x: layer.x, y: layer.y, scaleX: 1, scaleY: 1 } }));
      }
    });
    const first = lines[0].at;
    if (ctx.reduced) ctx.animate(status, "in", motion({ name: "Fade in", kind: "in", start: first, duration: 0.35, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    else ctx.animate(status, "in", motion({ name: "Blur up", kind: "in", start: first, duration: 0.36, easing: CURVES.arrive,
      from: { opacity: 0, y: status.y + Math.round(12 * ctx.scale), blur: Math.round(8 * ctx.scale) }, to: { opacity: 1, y: status.y, blur: 0 } }));
    lines.slice(1).forEach((line, index) => {
      const change = changeText({ start: line.at, text: line.text, distance: Math.round(status.fontSize * 0.4) });
      if ((input.swap ?? (corner ? "cut" : "blur")) === "cut") {
        // A plain switch: a frame of fade each way, no slide.
        change.out = { ...change.out, preset: "fade-out", duration: 0.04, easing: [...CURVES.fade] };
        change.in = { preset: "fade-in", duration: 0.04, easing: [...CURVES.fade], unit: "layer", stagger: 0, order: "forward" };
      } else if (ctx.reduced) {
        change.out = { ...change.out, preset: "fade-out" };
        change.in = { preset: "fade-in", duration: change.in.duration, easing: [...CURVES.fade], unit: "layer", stagger: 0, order: "forward" };
      }
      ctx.animate(status, `swap${index + 1}`, change);
    });
    // It leaves with the move's end unless that is the scene's end.
    if (end < ctx.sceneDuration - 0.05) {
      for (const layer of [shade, ...parts, status].filter(Boolean)) {
        ctx.animate(layer, "out", motion({ name: "Fade out", kind: "out", start: end - 0.3, duration: 0.3, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
        ctx.animate(layer, "hide", hide(end));
      }
    }
    return { end };
  },
};
