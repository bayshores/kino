// Measurements several rules share: what is readable when, sections and cuts, and motions.
import { area, boxAt, chainOf, insideShare, intersection, isDecor, isText, itemById, runs, tweensOf, visibleBoxAt } from "./model.js";

/** Sizes in the rules are for 1080 px on the short side; this scales them to the frame. */
export const scaleOf = (model) => Math.min(model.width, model.height) / 1080;
/** 9:16 and taller frames use the vertical (in-feed) limits. */
export const isPortrait = (model) => model.height / model.width >= 1.5;
export const sec = (value) => Math.round(value * 100) / 100;

// Planned stills (scene.rests) count for at most this long in all, per scene: a held end mark
// or a beat of black, not a way to excuse a whole frozen scene (chained rests included).
export const REST_MOST = 4;
/** The scene's rests in time order, cut so their total stays within REST_MOST seconds. */
function restSpans(model) {
  return memo(model, "rests", () => {
    let left = REST_MOST;
    const spans = [];
    for (const rest of [...(model.rests ?? [])].sort((a, b) => a.at - b.at)) {
      if (left <= 1e-6) break;
      const until = Math.min(rest.until, rest.at + left);
      spans.push({ at: rest.at, until });
      left -= until - rest.at;
    }
    return spans;
  });
}
/** True when `time` is inside one of the scene's planned stills (scene.rests, REST_MOST s in all). */
export const inRest = (model, time) => restSpans(model).some((rest) => time >= rest.at - 1e-6 && time <= rest.until + 1e-6);

const memo = (model, key, make) => {
  model._memo ??= new Map();
  if (!model._memo.has(key)) model._memo.set(key, make());
  return model._memo.get(key);
};

/** The share (0–1) of the item's box that is inside the frame and inside every group that clips it. */
export function shownShare(model, item, index) {
  let box = boxAt(item, index);
  const whole = area(box);
  if (!whole) return 0;
  box = intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height });
  for (const clipId of item.clipIds ?? []) {
    const clip = itemById(model, clipId);
    if (clip) box = intersection(box, boxAt(clip, index));
  }
  return area(box) / whole;
}

/** How fast the item's center moves at a sample, in frame widths a second. */
export function speedAt(model, item, index) {
  const { x0, y0, x1, y1 } = item.samples;
  const last = model.times.length - 1;
  const a = Math.max(0, index - 1);
  const b = Math.min(last, index + 1);
  if (a === b) return 0;
  const dx = (x0[b] + x1[b] - x0[a] - x1[a]) / 2;
  const dy = (y0[b] + y1[b] - y0[a] - y1[a]) / 2;
  return (Math.hypot(dx, dy) * model.fps) / (b - a) / model.width;
}

export function maxScale(item) {
  return memoItem(item, "maxScale", () => heldMax(item.samples.scale, item.samples.opacity));
}

// The largest scale held (3 shown samples in a row within 1%), so a pop that overshoots to 112%
// and settles at 100% counts as 100%. Else the largest scale shown.
function heldMax(scale, opacity) {
  let held = 0;
  let peak = 0;
  for (let index = 0; index < scale.length; index += 1) {
    if (opacity[index] <= 0.05) continue;
    peak = Math.max(peak, scale[index]);
    if (index < 2 || opacity[index - 1] <= 0.05 || opacity[index - 2] <= 0.05) continue;
    const steady = Math.abs(scale[index] - scale[index - 1]) <= 0.01 * scale[index] && Math.abs(scale[index - 1] - scale[index - 2]) <= 0.01 * scale[index];
    if (steady) held = Math.max(held, scale[index]);
  }
  return held || peak || 1;
}

/** The smallest sizes, in frame pixels: body text and the headline. */
export function typeLimits(model) {
  const scale = scaleOf(model);
  return isPortrait(model) ? { body: 32 * scale, headline: 90 * scale, frame: "9:16" } : { body: 36 * scale, headline: 64 * scale, frame: "16:9" };
}

// The item's own scale at each sample, without its parent group's: a camera pull-back scales the
// group, a shrink of the text itself scales the text.
function ownScales(model, item) {
  return memoItem(item, "ownScales", () => {
    const parent = itemById(model, item.parentId);
    return Array.from(item.samples.scale, (value, index) => (parent?.samples.scale[index] > 0 ? value / parent.samples.scale[index] : value));
  });
}

function memoItem(item, key, make) {
  item._memo ??= {};
  if (!(key in item._memo)) item._memo[key] = make();
  return item._memo[key];
}

/**
 * True when the item is at (nearly) its full opacity: 90% of the most it ever reaches. Text set
 * to 70% opacity on purpose is "fully shown" at 70%; the contrast check judges whether it is dim.
 */
export function atFullOpacity(item, index) {
  return item.samples.opacity[index] >= Math.max(0.3, 0.9 * maxOpacity(item));
}

/**
 * True when a text's smaller size can be read: its size holds still (it changes less than 5% a
 * second) and it is drawn at least at the body size, or, when only its groups made it smaller (a
 * camera tour that pulls back and holds), at least at half the body size. A text that shrinks
 * itself to a speck and holds there is not read.
 */
export function steadyScaleAt(model, item, index) {
  const { scale } = item.samples;
  const a = Math.max(0, index - 1);
  const b = Math.min(model.times.length - 1, index + 1);
  if (!(scale[index] > 0) || !item.fontSize) return false;
  if (a !== b && (Math.abs(scale[b] - scale[a]) * model.fps) / (b - a) > 0.05 * scale[index]) return false;
  const drawn = item.fontSize * scale[index];
  const { body } = typeLimits(model);
  if (drawn >= body) return true;
  const own = ownScales(model, item);
  return drawn >= body / 2 && own[index] >= 0.9 * memoItem(item, "maxOwnScale", () => heldMax(own, item.samples.opacity));
}

/**
 * True when the item can be read at this sample: at its full opacity, 90% inside the frame and
 * its clipping groups, at least 90% of its largest size or at a steady size it can be read at
 * (steadyScaleAt), not blurred more than 2 px, and not moving faster than 15% of the frame
 * width a second.
 */
export function readableAt(model, item, index) {
  const { blur, scale } = item.samples;
  return atFullOpacity(item, index) && blur[index] <= 2 && (scale[index] >= 0.9 * maxScale(item) || steadyScaleAt(model, item, index))
    && speedAt(model, item, index) <= 0.15 && shownShare(model, item, index) >= 0.9;
}

/** The runs of samples where the item is readable (and showing string `textIndex`, if given). */
export function readableRuns(model, item, textIndex = null) {
  return memoItem(item, `readable:${textIndex}`, () => runs(model.times.length, (index) =>
    (textIndex === null || item.samples.textIndex?.[index] === textIndex) && readableAt(model, item, index)));
}

/** Text layers people are meant to read (not decor or background), not masks. */
export function readingTexts(model) {
  return memo(model, "readingTexts", () => model.items.filter((item) => isText(item) && !isDecor(item) && !item.isMask && maxOpacity(item) >= 0.3));
}

export function maxOpacity(item) {
  return memoItem(item, "maxOpacity", () => item.samples.opacity.reduce((best, value) => Math.max(best, value), 0));
}

/** The size the text is drawn at when it is read (font size times its scale), in frame pixels. */
export function drawnSize(model, item) {
  return memoItem(item, "drawnSize", () => {
    const readable = readableRuns(model, item);
    let scale = 0;
    for (const run of readable) for (let index = run.from; index <= run.to; index += 1) scale = Math.max(scale, item.samples.scale[index]);
    return (item.fontSize ?? 0) * (scale || maxScale(item));
  });
}

// A web address or handle alone ("acme.dev", "github.com/acme/app", "@acme"): an end card's
// label under the logo, never the headline.
const LINK = /^\s*(https?:\/\/\S+|(www\.)?[\w-]+(\.[\w-]+)*\.(com|dev|ai|io|app|co|org|net|so|sh|gg|xyz|me|tv|fm|link|site|tech|studio|us|uk|ca|de|fr|jp)(\/\S*)?|@[\w.]+)\s*$/i;
export const isLinkText = (item) => LINK.test(String(item.text ?? ""));

/** The main headline: the text marked role headline, or else the largest text (not a web address or handle). */
export function headlines(model) {
  return memo(model, "headlines", () => {
    const texts = readingTexts(model);
    const marked = texts.filter((item) => item.role === "headline");
    if (marked.length) return marked;
    const candidates = texts.filter((item) => !["logo", "caption", "cta", "body", "subhead", "label", "ui"].includes(item.role) && !item.counter && !isLinkText(item));
    if (!candidates.length) return [];
    const largest = candidates.reduce((best, item) => (drawnSize(model, item) > drawnSize(model, best) ? item : best));
    return [largest];
  });
}

/** Items that carry the content: readable text, media, and logo, hero and CTA layers. */
export function primaryItems(model) {
  return memo(model, "primary", () => model.items.filter((item) => !item.isMask && !isDecor(item) && !item.perpetual
    && (isText(item) || ["logo", "hero", "cta"].includes(item.role) || item.kind === "image" || item.kind === "video")
    && maxOpacity(item) >= 0.3 && !coversFrame(model, item)));
}

/** True for an item that fills (nearly) the whole frame, such as a background image (by what is seen: a masked video in a tile does not). */
export function coversFrame(model, item) {
  return memoItem(item, "covers", () => {
    let best = 0;
    for (let index = 0; index < model.times.length; index += 1) {
      if (item.samples.opacity[index] <= 0.05) continue;
      const box = visibleBoxAt(model, item, index);
      best = Math.max(best, insideShare(model, box) * area(box) / (model.width * model.height));
    }
    return best >= 0.95;
  });
}

/**
 * Captions (add_captions) are timed to the voice: a word's highlight lasts as long as the word,
 * and a phrase shows when it is said. Returns the ids of their text and the groups around it
 * (add_captions draws a caption group, a group per page or phrase, the caption text inside).
 * A new phrase is the voice going on, not a cut or a new slide: cuts, sections and the slide and
 * timing rules leave these alone.
 */
export function speechTimed(model) {
  return memo(model, "speechTimed", () => {
    const ids = new Set();
    const roots = new Set();
    for (const item of model.items) {
      const page = itemById(model, item.parentId);
      if (item.role !== "caption" || page?.kind !== "group" || itemById(model, page.parentId)?.kind !== "group") continue;
      roots.add(page.parentId);
      for (let current = item; current && !ids.has(current.id); current = itemById(model, current.parentId)) ids.add(current.id);
    }
    // The hook line a look sets bigger (add_captions hook) sits in the caption group itself.
    for (const item of model.items) if (item.kind === "text" && roots.has(item.parentId)) ids.add(item.id);
    return ids;
  });
}

/** Reading texts but the voice's captions: the text a video is designed around (slides, hooks, copy). */
export function designedTexts(model) {
  return memo(model, "designedTexts", () => {
    const timed = speechTimed(model);
    return readingTexts(model).filter((item) => !timed.has(item.id));
  });
}

// What is on screen at a sample, for cuts and sections: the voice's captions left out.
const shownSet = (model, index, threshold = 0.5) => {
  const timed = speechTimed(model);
  return new Set(primaryItems(model).filter((item) => item.samples.opacity[index] >= threshold && !timed.has(item.id)).map((item) => item.id));
};

/**
 * Hard cuts: samples where most of what was on screen (60% or more) is gone from one sample to
 * the next. The start of the video counts as a cut.
 */
export function cuts(model) {
  return memo(model, "cuts", () => {
    const found = [0];
    let previous = shownSet(model, 0);
    for (let index = 1; index < model.times.length; index += 1) {
      const current = shownSet(model, index);
      if (previous.size) {
        const kept = [...previous].filter((id) => current.has(id)).length;
        const gone = [...previous].filter((id) => !current.has(id)).length;
        // Gone in one step: it was well shown the sample before and is (nearly) hidden now.
        const sudden = [...previous].filter((id) => !current.has(id) && itemById(model, id).samples.opacity[index] < 0.05).length;
        if (gone / previous.size >= 0.6 && sudden / previous.size >= 0.6 && kept / previous.size <= 0.4 && model.times[index] - model.times[found.at(-1)] >= 0.5) found.push(index);
      }
      previous = current;
    }
    return found.map((index) => model.times[index]);
  });
}

/**
 * Sections: stretches with the same content. A new section starts when nothing that was shown
 * half a second earlier is still shown (a cut or a full change of content), at least 1 s apart.
 * Returns [{start, end}] in seconds.
 */
export function sections(model) {
  return memo(model, "sections", () => {
    const step = Math.max(1, Math.round(0.5 * model.fps));
    const starts = [0];
    for (let index = step; index < model.times.length; index += 1) {
      const now = shownSet(model, index);
      const before = shownSet(model, index - step);
      if (!now.size || !before.size) continue;
      if ([...now].some((id) => before.has(id))) continue;
      // The section starts when its first new item appears (the cut, or a crossfade's start).
      let first = index;
      for (let back = index - step + 1; back < index; back += 1) {
        const shown = shownSet(model, back);
        if ([...now].some((id) => shown.has(id))) { first = back; break; }
      }
      const time = model.times[first];
      if (time - starts.at(-1) >= 1) starts.push(time);
    }
    return starts.map((start, position) => ({ start, end: starts[position + 1] ?? model.duration }));
  });
}

const MOVE_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation", "width", "height"]);
export const FADE_KEYS = new Set(["opacity", "fill", "stroke", "background", "color", "reveal"]);
export const isMoveTween = (tween) => tween.keys.some((key) => MOVE_KEYS.has(key));

/**
 * True when the item is never drawn: hidden (visible:false, or in a hidden group) or at opacity 0
 * at every sample. Its animations show nothing, so the motion and timing rules leave them alone.
 * A mask is not drawn either (its opacity samples are 0), but its motion shows in what it masks.
 */
export const neverShown = (item) => !item.isMask && maxOpacity(item) < 0.01;

/** True when the item or one of its groups is marked perpetual or has a looping animation (behavior.js). */
export const isPerpetual = (model, item) => chainOf(model, item).some((entry) => entry.perpetual || entry.loops);

/**
 * Motions: the tweens of one item that start together (within one sample) count as one motion,
 * such as a fade and a slide of the same entrance. Each motion has the timing of its longest
 * tween and the easing of its move (or of its first tween when nothing moves).
 */
export function motions(model) {
  return memo(model, "motions", () => {
    const found = [];
    for (const item of model.items) {
      if (item.isMask || neverShown(item)) continue;
      const list = tweensOf(model, item.id).filter((tween) => tween.duration > 0 && !tween.counter && !tween.keys.includes("visible"))
        .sort((a, b) => a.start - b.start);
      for (const tween of list) {
        const motion = found.find((entry) => entry.itemId === item.id && Math.abs(entry.start - tween.start) <= 1 / model.fps + 1e-6);
        if (motion) {
          motion.tweens.push(tween);
          motion.duration = Math.max(motion.duration, tween.duration);
          motion.end = Math.max(motion.end, tween.end);
          if (isMoveTween(tween) && !motion.tweens.slice(0, -1).some(isMoveTween)) { motion.easing = tween.easing; motion.intensity = tween.intensity; }
          if (tween.kind !== "custom") motion.kind = tween.kind;
        } else found.push({ itemId: item.id, start: tween.start, end: tween.end, duration: tween.duration, easing: tween.easing, intensity: tween.intensity, kind: tween.kind, tweens: [tween] });
      }
    }
    return found;
  });
}

export const easingKey = (easing) => (Array.isArray(easing) ? `[${easing.map((value) => Math.round(value * 100) / 100).join(",")}]` : String(easing));

/** The first entrance motion of each item. */
export function entrances(model) {
  return memo(model, "entrances", () => {
    const first = new Map();
    for (const motion of motions(model)) {
      if (motion.kind !== "in") continue;
      const current = first.get(motion.itemId);
      if (!current || motion.start < current.start) first.set(motion.itemId, motion);
    }
    return [...first.values()];
  });
}

/**
 * The first entrance after each cut (and after the start): [{cut, motion, delay}]. A first
 * entrance 0.1–0.3 s after its cut is placed on purpose (first_entrance), so off_beat leaves it.
 */
export function firstEntrances(model) {
  return memo(model, "firstEntrances", () => {
    const list = [...entrances(model)].sort((a, b) => a.start - b.start);
    const times = cuts(model);
    return times.flatMap((cut, position) => {
      const nextCut = times[position + 1] ?? Infinity;
      const motion = list.find((entry) => entry.start >= cut - 1e-6 && entry.start < nextCut);
      return motion ? [{ cut, motion, delay: motion.start - cut }] : [];
    });
  });
}

/** True when a first entrance's delay after its cut is in the 0.1–0.3 s window. */
export const goodEntranceDelay = (model, delay) => delay >= 0.1 - 0.5 / model.fps && delay <= 0.3 + 0.5 / model.fps;

/** The words of a text. */
export const wordsOf = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean);
/** Characters people read: the text with runs of spaces made single. */
export const charactersOf = (text) => String(text ?? "").trim().replace(/\s+/g, " ").length;
// Prices, percentages, phone numbers, dates and other figures take longer to read.
export const hasKeyNumber = (text) => /[$€£¥]\s?\d|\d\s?[%$€£¥]|\d[\d.,:/-]{2,}|\d+\s?(?:x|×|k|m|bn)\b/i.test(String(text ?? ""));

/** Clearcast's recommended time on screen for a text, in seconds. */
export function recommendedHold(text) {
  const words = wordsOf(text).length;
  return 0.2 * words + (words <= 9 ? 2 : 3) + (hasKeyNumber(text) ? 2 : 0);
}
