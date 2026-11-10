// The type look of a video: which face, how heavy, what case, how big and how the words come in,
// read from the model (not pixels). House memory (backend/house-memory.mjs) saves it per render
// and type_seen (rules/seenBefore.js) warns when a new project reuses the look of the last ones
// without a reference or treatment that chose it. kino has no default type look; sameness is the tell.
//
// typeSignature(model, {families}) answers null for a video with no text, else
//   {family, weight, case, size, reveal} of its main text (the largest designed text, else the
//   largest caption), where
//   family   the face asked for, lower case ("inter")
//   weight   light (300 or less), regular (up to 500), bold (up to 700), black
//   case     caps, lower, mixed
//   size     caption (under 4.5% of the frame height), body (under 8%), title (under 16%), display
//   reveal   how it comes in: blur, per-words (per-letters, per-lines), mask (a wipe, or a rise under a clip), slide, scale,
//            fade, cut (no in-animation)
import { designedTexts, drawnSize, readingTexts } from "./analysis.js";
import { caseOf } from "./layoutSignature.js";

export const TYPE_VERSION = 1;
export const TYPE_PARTS = ["family", "weight", "case", "size", "reveal"];

const weightClass = (value) => {
  const weight = Number(value) || 400;
  return weight <= 300 ? "light" : weight <= 500 ? "regular" : weight <= 700 ? "bold" : "black";
};

const sizeClass = (share) => (share < 0.045 ? "caption" : share < 0.08 ? "body" : share < 0.16 ? "title" : "display");

/** How the item comes in, from its first in-animation (or the text it is revealed under). */
function revealOf(model, item) {
  const first = model.tweens.filter((tween) => tween.itemId === item.id && tween.kind === "in").sort((a, b) => a.start - b.start)[0];
  if (!first) return "cut";
  const has = (pattern) => first.keys.some((key) => pattern.test(key));
  if (has(/^blur$/)) return "blur";
  if (first.unit && first.unit !== "layer" && first.spread > 0) return `per-${first.unit}`;
  if (has(/^reveal$/) || (has(/^[xy]$/) && item.clipIds?.length)) return "mask";
  if (has(/^[xy]$/)) return "slide";
  if (has(/^scale/)) return "scale";
  return has(/^opacity$/) ? "fade" : "cut";
}

export function typeSignature(model, { families = null } = {}) {
  const designed = designedTexts(model);
  const pool = designed.length ? designed : readingTexts(model);
  if (!pool.length) return null;
  const main = pool.reduce((best, item) => (drawnSize(model, item) > drawnSize(model, best) ? item : best));
  const family = String(families?.get(main.id) ?? main.fontFamily ?? main.font?.family ?? "").trim().toLowerCase();
  const shown = main.texts?.length ? main.texts.join(" ") : main.text;
  const letters = caseOf(shown);
  return {
    family: family || "unknown", weight: weightClass(main.fontWeight), case: letters === "none" ? "mixed" : letters,
    size: sizeClass(drawnSize(model, main) / Math.max(1, model.height)), reveal: revealOf(model, main),
  };
}

/** The parts two type signatures share, as names (TYPE_PARTS order). */
export function typeAlike(a, b) {
  return TYPE_PARTS.filter((part) => a?.[part] !== undefined && a[part] === b?.[part]);
}

/** True when two type looks read as one: the same face and at least 4 of the 5 parts. */
export const sameType = (a, b) => typeAlike(a, b).includes("family") && typeAlike(a, b).length >= 4;
