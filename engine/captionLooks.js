// add_captions {look}: named caption looks with their rules built in.
//
// A look sets the font, size, color, place and entrance of the captions, and how the words are
// grouped: "page" looks keep the subtitle paging of captionLayers.js; "phrase" looks group the
// spoken words into short phrases (1 to 3 words) shown as they are said:
// - a phrase never spans a pause of PHRASE_PAUSE or more, or a sentence or clause end;
// - it is hidden during silences: it leaves HOLD after its last word unless the next phrase
//   starts within SILENCE (then it stays until 2 frames before it);
// - reveal "word" shows each word as it is said; keyword makes the phrase's key word (the
//   longest word that is not a small word, or one named in `keywords`) bigger, in the accent
//   color, popping in; highlight colors the word being said;
// - every phrase stays up long enough to read (characters / 20, at least 20 frames, the
//   reading_time check): one said too fast takes the next phrase in (never across a sentence
//   end), and one still short holds and the next waits; a word revealed as it is said shows
//   early enough to be read before its phrase leaves;
// - a phrase after a silence (and the first) enters a little slower, a new thought;
// - under reduced motion (the operation's or the scene composition's `reduced`) phrases fade;
// - hook puts a big first line over the first seconds (true: the first sentence of the
//   transcript, at most HOOK_WORDS words; or its own text), and the captions start after it.
// Sizes are shares of the frame height (a template headline is about 6.2%), capped by the frame's width so a portrait frame keeps 3 words to 1 or 2 lines.
import { createLayer, uid } from "./model.js";
import { layoutText } from "./textLayout.js";
import { createVisibilityOperation } from "./visibilityOps.js";
import { safeRect } from "./quality/rules/layout.js";
import { charactersOf, typeLimits } from "./quality/analysis.js";
import { round } from "./numbers.js";
import { contrastRatio } from "./paintInterpolation.js";

const SHADOW = { color: "#00000099", x: 0, y: 4, blur: 14 };
export const DEFAULT_ACCENT = "#FFD84D";
// Light letters with a soft shadow suit footage and dark frames. On a light frame with no picture
// the looks without a box take dark letters and a deep accent instead, so they pass the contrast gate.
export const DARK_FILL = "#111111";
export const DEEP_ACCENT = "#C2410C";

/** True when the captions would sit on a light background color with no footage or picture under them. */
export function onLightFrame(scene) {
  if (scene.layers.some((layer) => (layer.type === "video" || layer.type === "image") && layer.visible !== false)) return false;
  return (contrastRatio(scene.background, "#FFFFFF") ?? 21) < 3;
}

/** True for a fill light enough to need the dark shadow (white, cream, yellow). */
export const isLightFill = (fill) => (contrastRatio(fill, "#FFFFFF") ?? 21) < 3;

export const CAPTION_LOOKS = Object.freeze({
  subtitle: { about: "classic subtitle pages on a dark box", unit: "page", fontFamily: "Inter", fontWeight: 600, size: 0.044, box: "#000000B8", position: "bottom", appear: "cut" },
  editorial: { about: "documentary serif pages, no box, soft shadow, fade", unit: "page", fontFamily: "Noto Serif", fontWeight: 400, size: 0.046, box: false, shadow: true, position: "bottom", appear: "fade" },
  clean: { about: "3-word phrases in white with a soft shadow, rising in, hidden in silences", unit: "phrase", words: 3, fontFamily: "Inter", fontWeight: 600, size: 0.05, position: "lower", enter: "rise" },
  pop: { about: "3-word phrases revealed word by word; the key word bigger in the accent color", unit: "phrase", words: 3, reveal: "word", keyword: true, fontFamily: "Montserrat", fontWeight: 700, upper: true, size: 0.062, position: "lower", enter: "pop" },
  word: { about: "one word at a time, big and centered, popping in", unit: "phrase", words: 1, fontFamily: "Montserrat", fontWeight: 700, upper: true, size: 0.075, position: "middle", enter: "pop" },
  highlight: { about: "3-word phrases; the word being said takes the accent color", unit: "phrase", words: 3, highlight: true, fontFamily: "Inter", fontWeight: 700, size: 0.055, position: "lower", enter: "fade" },
  bold: { about: "2-word phrases in dark type on a light card, sliding up, with a hook title", unit: "phrase", words: 2, fontFamily: "Inter", fontWeight: 700, upper: true, size: 0.056, fill: "#111111", box: "#F4F1EA", position: "lower", enter: "slide", hook: true },
});
export const CAPTION_LOOK_NAMES = Object.keys(CAPTION_LOOKS);

const PHRASE_PAUSE = 0.35;
const SILENCE = 0.6;
const HOLD = 0.3;
const HOOK_WORDS = 7;
const HOOK_SECONDS = 2.5;
const READ_RATE = 20;
const MIN_READ = 20 / 30;
const MOST_JOINED = 2;
// A phrase short of its reading time holds and the next waits, up to this far behind the voice;
// further behind, it takes the next phrase in instead (the captions move in engine/blocks/moves/type.js).
const MOST_BEHIND = 0.3;
const SMALL = new Set("a an and are as at be but by for from had has have he her his i in is it its me my of on or our she so that the their them they this to was we were what when which who will with you your i'm it's that's don't we're you're".split(" "));
const OUT = [0.22, 1, 0.36, 1];
const OVERSHOOT = [0.34, 1.45, 0.64, 1];

function fail(message) {
  throw new Error(`add_captions: ${message}`);
}

/** The look's font size on this frame: a share of its height, capped by its width. */
export function lookFontSize(scene, look) {
  return Math.max(12, Math.round(Math.min(scene.height * look.size, scene.width * look.size * 1.55)));
}

/** add_captions fields a look stands for (the operation's own fields win). */
export function lookDefaults(scene, name) {
  const look = CAPTION_LOOKS[name];
  if (!look) fail(`look must be one of ${CAPTION_LOOK_NAMES.join(", ")}.`);
  return {
    fontSize: lookFontSize(scene, look),
    fontFamily: look.fontFamily,
    fontWeight: look.fontWeight,
    ...(look.fill ? { fill: look.fill } : !look.box && onLightFrame(scene) ? { fill: DARK_FILL } : {}),
    box: look.box ?? false,
    position: look.position === "lower" ? "bottom" : look.position,
    ...(look.appear ? { appear: look.appear } : {}),
  };
}

const plain = (text) => text.toLowerCase().replace(/[^a-z0-9']/g, "");

/** The spoken words grouped into phrases of at most `size` words (see the rules above). */
export function phrasesOf(words, size) {
  const phrases = [];
  let current = [];
  for (const word of words) {
    const last = current.at(-1);
    if (last && (current.length >= size || word.start - last.end >= PHRASE_PAUSE || /[.!?,;:]["')]?$/.test(last.text))) {
      phrases.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) phrases.push(current);
  return phrases;
}

const sentenceEnd = (word) => /[.!?]["')]?$/.test(word.text);
/** Seconds the text needs on screen to be read (the reading_time check). */
export const readSeconds = (text) => Math.max(charactersOf(text) / READ_RATE, MIN_READ);
const textOf = (phrase) => phrase.map((word) => word.text).join(" ");

/**
 * Phrases said too fast to read take the next one in, up to MOST_JOINED × size words (3 for one-word looks), never
 * across a sentence end, so the captions never fall more than MOST_BEHIND behind the voice. `enter(fresh)` is the
 * seconds a phrase takes to enter, `from` the earliest a phrase can show, `gap` the 2 frames
 * between phrases.
 */
export function readablePhrases(phrases, size, { enter = () => 0, from = 0, gap = 0 } = {}) {
  const joined = [];
  let free = from, fresh = true;
  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = [...phrases[index]];
    const start = Math.max(phrase[0].start, free);
    const needs = () => start + enter(fresh) + readSeconds(textOf(phrase));
    while (index + 1 < phrases.length && !sentenceEnd(phrase.at(-1)) && phrase.length + phrases[index + 1].length <= Math.max(3, size * MOST_JOINED)
      && phrases[index + 1][0].start - gap + MOST_BEHIND < needs()) {
      index += 1;
      phrase.push(...phrases[index]);
    }
    const next = phrases[index + 1]?.[0].start ?? Infinity;
    fresh = next - phrase.at(-1).end >= SILENCE;
    free = Math.max(fresh ? Math.min(phrase.at(-1).end + HOLD, next - gap) : next - gap, needs()) + gap;
    joined.push(phrase);
  }
  return joined;
}

/** The index of the phrase's key word: one named in `keywords`, else its longest word that is not a small word (4 letters or more). */
function keywordIndex(phrase, keywords) {
  if (keywords) {
    const index = phrase.findIndex((word) => keywords.has(plain(word.text)));
    return index;
  }
  let best = -1;
  phrase.forEach((word, index) => {
    const bare = plain(word.text);
    if (bare.length >= 4 && !SMALL.has(bare) && (best < 0 || bare.length > plain(phrase[best].text).length)) best = index;
  });
  return best;
}

function wordLayer(text, { fontSize, style, fill, fonts }) {
  const layer = createLayer("text", {
    text, fontFamily: style.fontFamily, fontSize, fontWeight: style.fontWeight, fill,
    lineHeight: 1.15, textAlign: "center", textResize: "width-height", role: "caption",
    textCase: style.upper ? "upper" : "normal",
    ...(style.box === false && isLightFill(fill) ? { shadow: { ...SHADOW, blur: Math.round(fontSize * 0.14), y: Math.round(fontSize * 0.04) } } : {}),
  });
  const { width, height } = layoutText(layer, fonts);
  return { ...layer, width, height };
}

// The words of one phrase laid out in centered lines no wider than `room`: [{layer, x, y}], width, height.
function layoutPhrase(phrase, key, { style, fonts, room, accent, most = 2 }) {
  for (let scale = 1; ; scale *= 0.9) {
    const fontSize = Math.round(style.fontSize * scale);
    const space = fontSize * 0.3;
    const words = phrase.map((word, index) => wordLayer(word.text, { fontSize: index === key ? Math.round(fontSize * 1.18) : fontSize, style, fill: index === key ? accent : style.fill, fonts }));
    const lines = [];
    let line = null;
    for (const [index, layer] of words.entries()) {
      if (line && line.width + space + layer.width <= room) { line.items.push(index); line.width += space + layer.width; }
      else { line = { items: [index], width: layer.width }; lines.push(line); }
    }
    const widest = Math.max(...lines.map((entry) => entry.width));
    if ((lines.length <= most && widest <= room) || scale < 0.5) {
      const width = Math.ceil(widest);
      let y = 0;
      const placed = [];
      for (const entry of lines) {
        const tall = Math.max(...entry.items.map((index) => words[index].height));
        let x = (width - entry.width) / 2;
        for (const index of entry.items) {
          placed[index] = { layer: words[index], x: Math.round(x), y: Math.round(y + tall - words[index].height) };
          x += words[index].width + space;
        }
        y += tall * 0.92;
      }
      return { placed, width, height: Math.ceil(y / 0.92), fontSize };
    }
  }
}

function fadeIn(start, duration, extra = {}) {
  return { id: uid(), name: "Fade in", kind: "in", start: round(start), duration, easing: OUT, unit: "layer", stagger: 0, order: "forward", from: { opacity: 0, ...extra.from }, to: { opacity: 1, ...extra.to } };
}

function colorTo(start, from, to) {
  return { id: uid(), name: "Highlight", kind: "custom", start: round(start), duration: 0.06, easing: OUT, unit: "layer", stagger: 0, order: "forward", from: { fill: from }, to: { fill: to } };
}

function popIn(start, from, duration = 0.24) {
  return { id: uid(), name: "Pop", kind: "custom", start: round(start), duration, easing: OVERSHOOT, unit: "layer", stagger: 0, order: "forward", from: { scaleX: from, scaleY: from }, to: { scaleX: 1, scaleY: 1 } };
}

/** The phrase's entrance on its group (at y), for the look's enter style; reduced motion fades. */
function groupEntrance(enter, start, y, fontSize, reduced, fresh) {
  const slow = fresh ? 1.4 : 1;
  if (reduced || enter === "fade") return [fadeIn(start, round(0.15 * slow))];
  if (enter === "rise") return [fadeIn(start, round(0.2 * slow), { from: { y: y + Math.round(fontSize * 0.25) }, to: { y } })];
  if (enter === "slide") return [fadeIn(start, round(0.22 * slow), { from: { y: y + Math.round(fontSize * 0.45) }, to: { y } })];
  return [fadeIn(start, 0.1), popIn(start, 0.86, round(0.24 * slow))];
}

// The top of a block `height` tall at the look's position, inside the safe area.
function blockTop(scene, position, height) {
  const safe = safeRect(scene);
  if (position === "top") return safe.y0 + scene.height * 0.01;
  if (position === "middle") return (scene.height - height) / 2;
  if (position === "lower") return Math.min(safe.y1 - height, scene.height * 0.72 - height / 2);
  return safe.y1 - scene.height * 0.01 - height;
}

/** The hook title: a big centered first line in the upper third. Returns its layer, or null when it needs more than 3 lines at the headline's smallest size (type_min). */
function hookLayer(text, { scene, style, fonts, name, parentId, start, end, reduced }) {
  const safe = safeRect(scene);
  const room = (safe.x1 - safe.x0) * 0.92;
  const floor = Math.ceil(typeLimits(scene).headline);
  let fontSize = Math.round(Math.min(scene.height * 0.085, scene.width * 0.12));
  let layer;
  for (let fits = false; !fits;) {
    if (layer) fontSize = Math.round(fontSize * 0.9);
    if (fontSize < floor) return null;
    layer = createLayer("text", { name: `${name}-hook`, parentId, text, fontFamily: style.fontFamily, fontSize, fontWeight: style.fontWeight, fill: onLightFrame(scene) ? DARK_FILL : "#FFFFFF",
      lineHeight: 1.05, textAlign: "center", textResize: "height", width: Math.round(room), role: "headline", textCase: style.upper ? "upper" : "normal", letterSpacing: -1,
      ...(onLightFrame(scene) ? {} : { shadow: { ...SHADOW, blur: Math.round(fontSize * 0.16) } }) });
    const laid = layoutText(layer, fonts);
    layer.height = Math.ceil(laid.height);
    fits = laid.lines.length <= 3;
  }
  layer.x = Math.round((scene.width - layer.width) / 2);
  layer.y = Math.round(Math.max(safe.y0, scene.height * 0.3 - layer.height / 2));
  layer.animations = [
    ...(start > 0 ? [createVisibilityOperation("show", start, uid())] : []),
    ...(reduced ? [fadeIn(start, 0.2)] : [fadeIn(start, 0.5, { from: { y: layer.y + Math.round(fontSize * 0.3) }, to: { y: layer.y } })]),
    ...(end < scene.duration ? [createVisibilityOperation("hide", end, uid())] : []),
  ];
  return layer;
}

/**
 * The layers of phrase captions from the spoken words (scene times), for planCaptions:
 * {layers (under parentId), phrases [{start, end, text, words}], report}.
 */
export function phraseCaptions(words, { scene, style, fonts, fps, name, parentId, bounds, operation }) {
  const look = CAPTION_LOOKS[operation.look];
  const accent = operation.accent ?? (style.box === false && !isLightFill(style.fill) ? DEEP_ACCENT : DEFAULT_ACCENT);
  if (typeof accent !== "string" || !/^#[0-9a-f]{6}$/i.test(accent)) fail("accent must be a hex color such as #FFD84D.");
  if (operation.keywords !== undefined && !(Array.isArray(operation.keywords) && operation.keywords.every((word) => typeof word === "string")))
    fail("keywords must be a list of words.");
  const keywords = operation.keywords ? new Set(operation.keywords.map(plain)) : null;
  const hook = operation.hook ?? look.hook ?? false;
  if (hook !== false && hook !== true && !(typeof hook === "string" && hook.trim() && hook.length <= 80)) fail("hook must be true, false or a line of up to 80 characters.");
  const reduced = operation.reduced === true || scene.composition?.reduced === true;
  const gap = 2 / fps;
  const layers = [];
  let rest = words;
  let hookReport = null;
  if (hook !== false) {
    const hookStyle = { ...style, upper: look.upper };
    let text = hook, start = bounds.start, end = Math.min(bounds.end, start + HOOK_SECONDS), layer = null;
    if (hook === true) {
      const first = [];
      for (const word of words) {
        first.push(word);
        if (first.length >= HOOK_WORDS || sentenceEnd(word)) break;
      }
      // A first sentence too long for 3 lines at the headline's smallest size gives up its last words.
      for (; first.length && !layer; first.pop()) {
        text = textOf(first).replace(/[.,;:]$/, "");
        start = first[0].start;
        end = Math.min(bounds.end, Math.max(first.at(-1).end + HOLD, start + 1.2, start + readSeconds(text)));
        layer = hookLayer(text, { scene, style: hookStyle, fonts, name, parentId, start, end, reduced });
        if (layer) rest = words.slice(first.length);
      }
    } else layer = hookLayer(text, { scene, style: hookStyle, fonts, name, parentId, start, end, reduced });
    if (!layer) fail("hook is too long to show in 3 lines at a readable size; shorten it.");
    layers.push(layer);
    hookReport = { text, start: round(start), end: round(end) };
    rest = rest.filter((word) => word.start >= end);
  }
  const safe = safeRect(scene);
  const room = (safe.x1 - safe.x0) * 0.88 - (style.box === false ? 0 : 2 * style.padX);
  // Portrait frames take a third line before a phrase is made smaller.
  const most = scene.height > scene.width ? 3 : 2;
  // Seconds until a phrase is readable: its fade in (the pop's overshoot is readable already) and a frame.
  const enter = (fresh) => groupEntrance(look.enter, 0, 0, 0, reduced, fresh).find((animation) => animation.from.opacity === 0).duration + 1 / fps;
  const phrases = readablePhrases(phrasesOf(rest, look.words), look.words, { enter, from: hookReport ? hookReport.end + gap : bounds.start, gap });
  const shown = [];
  let silences = 0;
  let free = hookReport ? hookReport.end + gap : bounds.start;
  let fresh = true;
  phrases.forEach((phrase, index) => {
    const start = Math.max(phrase[0].start, free);
    const next = phrases[index + 1]?.[0].start ?? bounds.end + gap;
    const spoken = phrase.at(-1).end;
    const silent = next - spoken >= SILENCE;
    let end = silent ? Math.min(spoken + HOLD, next - gap) : next - gap;
    if (silent && index + 1 < phrases.length) silences += 1;
    const key = look.keyword ? keywordIndex(phrase, keywords) : -1;
    const lookStyle = { ...style, upper: look.upper };
    const laid = layoutPhrase(phrase, key, { style: lookStyle, fonts, room, accent, most });
    const padX = style.box === false ? 0 : style.padX, padY = style.box === false ? 0 : style.padY;
    const width = laid.width + 2 * padX, height = laid.height + 2 * padY;
    const y = Math.round(blockTop(scene, look.position, height));
    const group = createLayer("group", {
      name: `${name}-${index + 1}`, parentId, x: Math.round((scene.width - width) / 2), y, width, height,
      fill: style.box === false ? "#000000" : style.box, fillEnabled: style.box !== false, radius: Math.round(style.fontSize * 0.22),
    });
    const entrance = groupEntrance(look.enter, start, y, laid.fontSize, reduced, fresh);
    // Long enough to read once it has entered: a phrase still short holds, and the next one waits (free).
    end = Math.min(bounds.end, Math.max(end, start + enter(fresh) + readSeconds(textOf(phrase))));
    free = end + gap;
    group.animations = [
      ...(start > 0 ? [createVisibilityOperation("show", start, uid())] : []),
      ...entrance,
      ...(end < scene.duration ? [createVisibilityOperation("hide", end, uid())] : []),
    ];
    fresh = silent;
    layers.push(group);
    // Each word shows as it is said, or earlier when it would leave before it can be read.
    const wordIn = (at) => (reduced ? 0 : at === key ? 0.28 : 0.08) + 1 / fps;
    const reveals = phrase.map((word, at) => Math.max(start, Math.min(word.start, end - wordIn(at) - readSeconds(word.text))));
    for (let at = reveals.length - 2; at >= 0; at -= 1) reveals[at] = Math.min(reveals[at], reveals[at + 1]);
    laid.placed.forEach(({ layer, x, y: top }, at) => {
      const word = phrase[at];
      const reveal = reveals[at];
      const child = { ...layer, id: uid(), name: `${name}-${index + 1}-${at + 1}`, parentId: group.id, x: x + padX, y: top + padY, animations: [] };
      if (look.reveal === "word" && reveal > start) {
        child.animations.push(createVisibilityOperation("show", round(reveal), uid()));
        if (!reduced) child.animations.push(fadeIn(reveal, 0.08, { from: { y: child.y + Math.round(laid.fontSize * 0.12) }, to: { y: child.y } }));
      }
      if (at === key && !reduced) child.animations.push(popIn(Math.max(start, reveal), 0.6, 0.28));
      // highlight: the word being said turns the accent color, and back when the next is said.
      if (look.highlight && word.start < end) {
        const on = Math.max(start, word.start);
        const off = Math.min(end, phrase[at + 1]?.start ?? end);
        child.animations.push(colorTo(on, style.fill, accent));
        if (off < end) child.animations.push(colorTo(off, accent, style.fill));
      }
      layers.push(child);
    });
    shown.push({ start: round(start), end: round(end), text: textOf(phrase), words: phrase });
  });
  return {
    layers,
    phrases: shown,
    report: { look: operation.look, phrases: shown.length, ...(silences ? { hiddenInSilences: silences } : {}), ...(hookReport ? { hook: hookReport } : {}) },
  };
}

/** Words with times for a page that has none: its words share its time by their length. */
export function wordsOfPage(page) {
  if (page.words?.length) return page.words;
  const texts = page.text.split(/\s+/).filter(Boolean);
  const total = texts.reduce((sum, text) => sum + text.length + 1, 0);
  let at = page.start;
  return texts.map((text) => {
    const length = ((text.length + 1) / total) * (page.end - page.start);
    const word = { text, start: round(at), end: round(at + length) };
    at += length;
    return word;
  });
}
