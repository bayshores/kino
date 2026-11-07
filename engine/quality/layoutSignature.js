// The layout signature of a moment: what type and pictures sit where, read from the model (not
// pixels), so footage content and colors do not count. kino keeps the signatures of what it
// rendered in other projects (house memory, backend/house-memory.mjs); the seen_before check
// (rules/seenBefore.js) warns when a new edit repeats one. Sameness across projects is the tell.
//
// A signature is {backdrop, items}: `backdrop` is the share of the frame the largest picture or
// clip covers (footage filling the frame is backdrop, not an item); each item is
//   {k: "t" text | "i" picture or logo | "m" inset clip, x, y (center), w, h (shares of the frame),
//    r font size rank (0 largest, 2 the rest), a align, c case (caps, lower, mixed, none),
//    m mono 0 or 1, n words bucket (0: 1 word, 1: 2-3, 2: 4-7, 3: 8+), d designed type or logo 0 or 1}.
import { cuts, designedTexts, sec, speechTimed } from "./analysis.js";
import { area, frameAt, insideShare, isDecor, isText, visibleBoxAt } from "./model.js";

// A picture or clip covering this share of the frame is the backdrop.
const BACKDROP = 0.6;
// Items kept per moment: the largest.
const MAX_ITEMS = 8;
const MONO = /mono|code|courier|menlo|consol/i;
// What an unmatched item costs (a matched pair costs 0 to 1).
const UNMATCHED = 0.6;
// How much the backdrop share counts.
const BACKDROP_WEIGHT = 0.3;

const round = (value) => Math.round(value * 1000) / 1000;

export function caseOf(text) {
  const letters = String(text ?? "").replace(/[^\p{L}]/gu, "");
  if (!letters) return "none";
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return "caps";
  if (letters === letters.toLowerCase()) return "lower";
  return "mixed";
}

const wordsBucket = (text) => {
  const count = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
  return count <= 1 ? 0 : count <= 3 ? 1 : count <= 7 ? 2 : 3;
};

const shownText = (item, index) => {
  const at = item.samples.textIndex?.[index];
  return Array.isArray(item.texts) && Number.isInteger(at) && item.texts[at] != null ? item.texts[at] : item.text;
};

/** The signature of the model at time `t`. `families` (optional): layer id to the family it asks for, when the model was built with stand-in fonts. */
export function layoutSignature(model, t, { families = null } = {}) {
  const index = frameAt(model, t);
  const frame = model.width * model.height;
  const designed = new Set(designedTexts(model).map((item) => item.id));
  const captions = speechTimed(model);
  let backdrop = 0;
  const found = [];
  for (const item of model.items) {
    if (item.isMask || item.kind === "group" || (item.samples.opacity[index] ?? 0) < 0.5) continue;
    const box = visibleBoxAt(model, item, index);
    const share = area(box) / frame;
    if (!(share > 0) || insideShare(model, box) < 0.5) continue;
    const picture = item.kind === "image" || item.kind === "video";
    const logo = item.role === "logo";
    if (picture && share * insideShare(model, box) >= BACKDROP) { backdrop = Math.max(backdrop, Math.min(1, share * insideShare(model, box))); continue; }
    const text = isText(item) && !isDecor(item);
    if (!text && !picture && !logo) continue;
    const entry = {
      k: text ? "t" : item.kind === "video" ? "m" : "i",
      x: round((box.x0 + box.x1) / 2 / model.width), y: round((box.y0 + box.y1) / 2 / model.height),
      w: round((box.x1 - box.x0) / model.width), h: round((box.y1 - box.y0) / model.height),
      d: logo || (text && designed.has(item.id) && !captions.has(item.id)) ? 1 : 0,
    };
    if (text) {
      const value = shownText(item, index);
      Object.assign(entry, { size: (item.fontSize ?? 0) * (item.samples.scale[index] ?? 1), a: item.textAlign ?? "left", c: caseOf(value), m: MONO.test(families?.get(item.id) ?? item.fontFamily ?? item.font?.family ?? "") ? 1 : 0, n: wordsBucket(value) });
    }
    found.push(entry);
  }
  const items = found.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, MAX_ITEMS);
  const sizes = [...new Set(items.filter((item) => item.k === "t").map((item) => Math.round(item.size)))].sort((a, b) => b - a);
  for (const item of items) if (item.k === "t") { item.r = Math.min(2, sizes.indexOf(Math.round(item.size))); delete item.size; }
  return { backdrop: round(backdrop), items };
}

/** True when the signature holds designed type or a logo (captions alone do not count). */
export const hasDesigned = (signature) => Boolean(signature?.items?.some((item) => item.d));

/** What matching item `a` with item `b` costs, 0 (same) to 1. */
export function itemCost(a, b) {
  if (a.k !== b.k) return 1;
  const place = 0.6 * Math.hypot(a.x - b.x, a.y - b.y);
  const size = Math.min(0.5, Math.abs(Math.log((a.h + 0.01) / (b.h + 0.01))) * 0.15 + Math.abs(Math.log((a.w + 0.01) / (b.w + 0.01))) * 0.05);
  let look = 0;
  if (a.k === "t") {
    look += a.c === b.c ? 0 : 0.1;
    look += a.m === b.m ? 0 : 0.15;
    look += a.a === b.a ? 0 : 0.05;
    look += 0.05 * Math.abs((a.r ?? 0) - (b.r ?? 0));
    look += 0.04 * Math.abs((a.n ?? 0) - (b.n ?? 0));
  }
  return Math.min(1, place + size + look);
}

/**
 * The distance between two signatures: items matched greedily by cost (cheapest pairs first), each
 * unmatched item costing 1, the sum over the larger item count, plus the backdrop difference
 * times 0.3. 0 is the same layout; about 1 shares nothing.
 */
export function signatureDistance(a, b) {
  const left = a?.items ?? [], right = b?.items ?? [];
  const backdrop = BACKDROP_WEIGHT * Math.abs((a?.backdrop ?? 0) - (b?.backdrop ?? 0));
  const count = Math.max(left.length, right.length);
  if (!count) return round(backdrop);
  const pairs = [];
  left.forEach((item, i) => right.forEach((other, j) => pairs.push({ i, j, cost: itemCost(item, other) })));
  pairs.sort((x, y) => x.cost - y.cost);
  const usedLeft = new Set(), usedRight = new Set();
  let total = 0;
  for (const pair of pairs) {
    if (usedLeft.has(pair.i) || usedRight.has(pair.j)) continue;
    usedLeft.add(pair.i); usedRight.add(pair.j);
    total += pair.cost;
  }
  total += UNMATCHED * (count - Math.min(left.length, right.length));
  return round(total / count + backdrop);
}

/**
 * The moments of a model worth remembering: shot midpoints and every `every` seconds, those with
 * designed type or a logo, a moment within 0.03 of the one kept before it left out, at most `max`
 * (evenly thinned). Returns [{t, sig}].
 */
export function layoutMoments(model, { every = 1, max = 40, families = null } = {}) {
  const starts = cuts(model);
  const times = new Set();
  starts.forEach((start, index) => times.add(sec((start + (starts[index + 1] ?? model.duration)) / 2)));
  for (let t = every / 2; t < model.duration; t += every) times.add(sec(t));
  const kept = [];
  for (const t of [...times].sort((x, y) => x - y)) {
    const sig = layoutSignature(model, t, { families });
    if (!hasDesigned(sig)) continue;
    if (kept.length && signatureDistance(kept.at(-1).sig, sig) < 0.03) continue;
    kept.push({ t, sig });
  }
  if (kept.length <= max) return kept;
  return Array.from({ length: max }, (_, index) => kept[Math.round((index * (kept.length - 1)) / (max - 1))]);
}

/**
 * A saved reference's layout as a signature, from the text its fingerprint found in one place
 * across shots (fingerprint.persistent, boxes [x, y, w, h] as shares of the frame), or null.
 * Coarse: references keep no per-moment boxes, so only their lasting type counts.
 */
export function referenceSignature(fingerprint) {
  const texts = (fingerprint?.persistent ?? []).filter((entry) => entry.kind === "text" && Array.isArray(entry.box));
  if (!texts.length) return null;
  const heights = [...new Set(texts.map((entry) => entry.box[3]))].sort((a, b) => b - a);
  return {
    backdrop: fingerprint?.text?.onPlain >= 0.5 ? 0 : 1,
    items: texts.map(({ box: [x, y, w, h], text }) => ({ k: "t", x: round(x + w / 2), y: round(y + h / 2), w: round(w), h: round(h), r: Math.min(2, heights.indexOf(h)), a: "center", c: caseOf(text), m: 0, n: wordsBucket(text), d: 1 })),
  };
}

/**
 * The signature as a stack: with 3 items or more, each item's y measured within the items' own
 * vertical span (0 top, 1 bottom) and its height and width as a share of the largest item's, so two
 * stacks of the same parts in the same order read alike wherever they sit and however they are spaced.
 */
export function stackOf(signature) {
  const items = signature?.items ?? [];
  if (items.length < 3) return signature;
  const top = Math.min(...items.map((item) => item.y)), bottom = Math.max(...items.map((item) => item.y));
  const span = bottom - top;
  const tallest = Math.max(...items.map((item) => item.h)), widest = Math.max(...items.map((item) => item.w));
  return { ...signature, items: items.map((item) => ({ ...item, y: span > 0.05 ? (item.y - top) / span : 0.5, h: item.h / tallest, w: item.w / widest })) };
}

/** The closer of the plain distance and the stack distance (stackOf), so a repeated arrangement counts. */
export function layoutDistance(a, b) {
  const plain = signatureDistance(a, b);
  if ((a?.items?.length ?? 0) < 3 || (b?.items?.length ?? 0) < 3) return plain;
  return Math.min(plain, signatureDistance(stackOf(a), stackOf(b)));
}
