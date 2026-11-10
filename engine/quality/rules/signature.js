// The signature rule: a video with an idea (style.idea, what only this product can
// show) gives it a signature range, and that range holds a designed moment, not another text card.
// signature_missing reads ctx.style (engine/styleSpec.js styleContext): its idea, its signatures
// [{beat, what, source, why, at?}], its moments [{tag, beat, what}] and its spine. It is a warning
// while editing and blocks a final render (engine/quality/index.js FINAL_GATES).
//
// A signature range in time: each spine beat with role "signature", plus each signatures[].at.
import { signatureRanges } from "../../styleSpec.js";
import { techniqueOf } from "../../techniques.js";
import { readingTexts, sec } from "../analysis.js";
import { area, intersection, visibleBoxAt } from "../model.js";
import { coveredAt, techniquesUsed } from "../techniques.js";
import { seamCuts, textSlideSamples } from "./style.js";

// A layer covering this share of the frame is a full-frame graphic or footage.
const FULL = 0.6;
// A beat this share of text over a plain background (no picture) is decorative.
const DECORATIVE = 0.8;
// A picture this share of the frame or more makes a beat more than words on a card.
const PICTURE = 0.05;
// A technique this long before a range still lands in it (a transition into the moment).
const LEAD = 0.3;
// Not a designed moment on their own: how words come on (a faded text card is still a text card),
// beat timing, and accents that dress any change. A cut is designed only when it lands on a song
// seam (designedIn, style.js seamCuts).
const UNDESIGNED_GROUPS = new Set(["type", "rhythm"]);
const UNDESIGNED_TAGS = new Set(["cut", "fade-black", "flash", "glitch-hit", "shake"]);
const designedTag = (tag) => !UNDESIGNED_TAGS.has(tag) && Boolean(techniqueOf(tag)) && !UNDESIGNED_GROUPS.has(techniqueOf(tag).group);
// Plain fills: a full-frame rectangle or ellipse is a background, not a graphic.
const FLAT = new Set(["text", "group", "rectangle", "ellipse"]);

const isRange = (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite) && pair[1] > pair[0];
const short = (text, most = 80) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, most);

/**
 * The idea and signature lines a reviewer judges the edit against (critique packet, viewer match,
 * judge round): "Idea: ..." and one "Signature: <what> using <source> @<from>-<to>s" per
 * signature (at most 2). [] when the spec has neither.
 */
export function ideaLines(style) {
  const lines = [];
  const idea = short(style?.idea, 120);
  if (idea) lines.push(`Idea: ${idea}`);
  const spine = Array.isArray(style?.spine) ? style.spine : [];
  const signatures = Array.isArray(style?.signatures) ? style.signatures.filter((entry) => entry && typeof entry === "object" && short(entry.what)) : [];
  for (const signature of signatures.slice(0, 2)) {
    const beat = spine[signature.beat];
    const time = isRange(signature.at) ? signature.at : isRange([beat?.from, beat?.to]) ? [beat.from, beat.to] : null;
    lines.push(`Signature: ${short(signature.what)}${short(signature.source) ? ` using ${short(signature.source)}` : ""}${time ? ` @${sec(time[0])}-${sec(time[1])}s` : ""}`);
  }
  return lines;
}

const indexOf = (model, time) => Math.max(0, Math.min(model.times.length - 1, Math.round(time * model.fps)));
const frameShare = (model, item, index) => area(intersection(visibleBoxAt(model, item, index), { x0: 0, y0: 0, x1: model.width, y1: model.height })) / (model.width * model.height);
const shown = (model, item, index) => item.samples.opacity[index] >= 0.5 && !coveredAt(model, item, index);

// What makes the range a designed moment, or null: a designed technique there, a layer a set
// piece (move) made on screen, or a full-frame graphic or footage.
function designedIn(model, ctx, from, to) {
  for (const [tag, places] of Object.entries(techniquesUsed(model))) {
    if (!designedTag(tag)) continue;
    if (places.some((place) => place.at >= from - LEAD && place.at <= to)) return tag;
  }
  // A plain cut locked to a song seam is designed (style.js seamCuts).
  if (seamCuts(techniquesUsed(model), ctx, model.fps).some((place) => place.at >= from - LEAD && place.at <= to)) return "cut on a song seam";
  const [first, last] = [indexOf(model, from), indexOf(model, to)];
  const moved = new Map((ctx.scene?.layers ?? []).filter((layer) => layer.move?.name).map((layer) => [layer.id, layer.move.name]));
  for (const item of model.items) {
    if (item.isMask || item.source?.sceneBackground) continue;
    for (let index = first; index <= last; index += 1) {
      if (moved.has(item.id) && item.samples.opacity[index] > 0.05) return moved.get(item.id);
      if (!FLAT.has(item.kind) && shown(model, item, index) && frameShare(model, item, index) >= FULL) return `full-frame ${item.kind}`;
    }
  }
  return null;
}

// True when a beat is only text on a plain background: most of its samples a text slide with no
// picture (image or video) on screen.
function decorative(model, slide, beat) {
  const [first, last] = [indexOf(model, beat.from), indexOf(model, Math.min(beat.to, model.duration))];
  if (last <= first) return false;
  const pictures = model.items.filter((item) => (item.kind === "image" || item.kind === "video") && !item.isMask);
  let plain = 0;
  for (let index = first; index < last; index += 1)
    if (slide[index] && !pictures.some((item) => item.samples.opacity[index] > 0.3 && frameShare(model, item, index) >= PICTURE)) plain += 1;
  return plain / (last - first) >= DECORATIVE;
}

// The fix's suggestion: the spec's moments, else the deck's set piece.
function setPieceHint(ctx) {
  const tags = (ctx.style?.moments ?? []).map((moment) => moment?.tag).filter(Boolean);
  if (tags.length) return `the moments' ${tags.map((tag) => (techniqueOf(tag) ? `${tag} (${techniqueOf(tag).fits})` : tag)).join(", ")}`;
  if (ctx.deck?.setPiece?.name) return `the deck's set piece ${ctx.deck.setPiece.name}`;
  return 'a set piece (library {topic:"techniques"}) or the product\'s own picture filling the frame';
}

const signatureName = (ctx, range) => {
  const signature = range?.signature ?? (ctx.style?.signatures ?? [])[0] ?? null;
  return { what: short(signature?.what) || "the signature moment", source: short(signature?.source) || "the product's own material" };
};

/** signature_missing: the idea has no signature range, or the range holds no designed moment or is shorter than a text card. */
export function signatureMissing(model, ctx) {
  const style = ctx.style;
  if (!style) return [];
  const ranges = signatureRanges(style).map((range) => ({ ...range, to: Math.min(range.to, model.duration) })).filter((range) => range.to > range.from);
  const finding = (at, measured, required, message, range) => {
    const { what, source } = signatureName(ctx, range);
    const where = range ? `${sec(range.from)}-${sec(range.to)}s` : "its beat";
    return { rule: "signature_missing", severity: "warn", at: sec(at), ...(range ? { until: sec(range.to) } : {}), measured, required, message,
      fix: { kind: "hint", text: `Make ${what} using ${source} fill ${where}: ${setPieceHint(ctx)}.${range ? "" : ' Give it a spine beat with role "signature" or signatures[].at (notes brief style).'}` } };
  };
  if (!ranges.length)
    return style.idea && !signatureRanges(style).length
      ? [finding(0, "no signature range", 'a spine beat with role "signature" or signatures[].at', `${ctx.sceneName} has an idea ("${short(style.idea, 60)}") but no signature range: nothing in the timeline shows what only this product can.`, null)]
      : [];
  const findings = [];
  for (const range of ranges)
    if (!designedIn(model, ctx, range.from, range.to))
      findings.push(finding(range.from, "no designed moment", "a designed technique, a set piece or a full-frame graphic or footage",
        `The signature range ${sec(range.from)}-${sec(range.to)}s of ${ctx.sceneName} holds no designed moment: no technique, set piece or full-frame picture.`, range));
  // A signature shorter than the longest text card: the video spends more time on words than on its idea.
  const spine = Array.isArray(style.spine) ? style.spine : [];
  if (spine.length && readingTexts(model).length) {
    const slide = textSlideSamples(model, ctx);
    const cards = spine.filter((beat) => beat?.role !== "signature" && isRange([beat?.from, beat?.to]) && decorative(model, slide, beat));
    const longestCard = cards.reduce((best, beat) => (!best || beat.to - beat.from > best.to - best.from ? beat : best), null);
    const longest = ranges.reduce((best, range) => (range.to - range.from > best.to - best.from ? range : best));
    if (longestCard && longest.to - longest.from < Math.min(longestCard.to, model.duration) - longestCard.from - 0.01)
      findings.push(finding(longest.from, `signature ${sec(longest.to - longest.from)}s, ${longestCard.role} card ${sec(longestCard.to - longestCard.from)}s`, "the signature at least as long as the longest text-only beat",
        `The signature range (${sec(longest.from)}-${sec(longest.to)}s) is shorter than the ${longestCard.role} beat (${sec(longestCard.from)}-${sec(longestCard.to)}s), which is only text on a plain background.`, longest));
  }
  return findings;
}

export { signatureRanges };
