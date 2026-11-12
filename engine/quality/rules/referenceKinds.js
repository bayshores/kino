// reference_kinds (error): hold the edit to the kinds of design its own saved references show.
//
// Numbers cannot see design, so the agent labels what it sees at six moments of each saved
// reference (library inspire `seen`, backend/inspire.mjs): kinds type, overlay, composite, color,
// made, spoken or plain, with words. This rule reads those labels (ctx.seenRefs: [{id, seen:
// [{at, kinds, words}]}]) and marks the same kinds on the edit every half second:
//   type       a reading text at opacity 0.5 or more
//   overlay    a particle, glow, light, lens-flare, light-leaks or grain effect, or a shape (not a
//              picture) blended with add or screen
//   composite  2 or more pictures at 0.5+ opacity, each under 90% of the frame, or a masked picture
//   color      a color effect, other than color-wheels gamma alone from 0.8 to 1.5
//   made       a shape, path, star, ellipse, group or image that is not a full-frame plain fill
//   spoken     a clip at volume 0.05 or more with a heard word then (ctx.speech)
//   plain      none of the picture kinds above
// Error: 2 or more references show a kind at 2 or more moments and the edit shows it at none.
// Warning: the edit shows a kind in under the lowest reference share by over 1/6, or plain
// picture in more than the highest reference share by over 1/6. Pure data: no pixels.
import { volumeAt } from "../../animation.js";
import { speechWords } from "../../speech.js";
import { effectDefaults } from "../../effects/catalog.js";
import { PARTICLE_LOOKS } from "../../effects/particles.js";
import { readingTexts } from "../analysis.js";
import { area, boxAt, frameAt, intersection, visibleBoxAt } from "../model.js";

export const KINDS = Object.freeze(["type", "overlay", "composite", "color", "made", "spoken"]);
const PICTURE_KINDS = KINDS.filter((kind) => kind !== "spoken");
const STEP = 0.5;
const SHOWN = 0.5;
const HEARD = 0.05;
const FULL_SHARE = 0.9;
const MARGIN = 1 / 6;
const MIN_MOMENTS = 2;
const MIN_REFS = 2;
const OVERLAY_EFFECTS = new Set([...Object.keys(PARTICLE_LOOKS), "glow", "light-rays", "lens-flare", "grain"]);
const COLOR_EFFECTS = new Set(["curves", "lut", "hue-saturation", "white-balance", "color-wheels", "keep-color", "color-ranges", "color-look", "color-grade", "color-remover", "duotone", "tritone", "threshold-color"]);
const SHAPES = new Set(["rectangle", "ellipse", "star", "path", "group"]);
const PICTURES = new Set(["video", "image"]);
const LIGHT_BLENDS = new Set(["add", "screen"]);

const near = (value) => Math.round(value * 10) / 10;

// Effects whose defaults change nothing: they are a look only when a parameter moves off its default.
const NEUTRAL_DEFAULTS = new Set(["curves", "hue-saturation", "white-balance", "color-ranges", "color-grade"]);
const differs = (value, base) => (typeof value === "number" && typeof base === "number" ? Math.abs(value - base) > 0.005 : JSON.stringify(value) !== JSON.stringify(base));

// Whether a color effect is more than a small gamma lift (the reference_range fix, which alone is not a look)
// and does something: a mix at 0, a LUT with no file, or every value at its neutral default is no look.
function colorLook(entry) {
  if (!COLOR_EFFECTS.has(entry.effect)) return false;
  const to = entry.to ?? {}, from = entry.from ?? {};
  const mix = to.strength ?? to.amount;
  if (mix !== undefined && Number(mix) <= 0.01) return false;
  if (entry.effect === "lut") return Boolean(to.lut ?? from.lut);
  if (NEUTRAL_DEFAULTS.has(entry.effect)) {
    if ((to.colorize ?? from.colorize) === true) return true;
    const base = effectDefaults(entry.effect);
    return [from, to].some((part) => Object.entries(part).some(([key, value]) => key !== "strength" && key !== "colorize" && !(entry.effect === "hue-saturation" && key === "tint") && differs(value, base[key])));
  }
  if (entry.effect !== "color-wheels") return true;
  const set = { ...entry.from, ...entry.to };
  // The parameters come with their neutral values (gain 1, the rest 0): only gamma may be set.
  const others = Object.entries(set).filter(([key]) => key !== "gamma");
  const gamma = Number(set.gamma ?? 1);
  return others.some(([key, value]) => Number(value) !== (key === "gain" ? 1 : 0)) || gamma < 0.8 || gamma > 1.5;
}

/** The moment times (seconds) the edit is read at: every half second, from 0.25 s. */
export function momentTimes(duration) {
  const times = [];
  for (let time = STEP / 2; time < duration; time += STEP) times.push(Math.round(time * 1000) / 1000);
  return times;
}

// Whether an effect animation is on at a time: between its start and end, and past either end when it
// holds there (kinoTimeline.js holdBefore / holdAfter: a ranged effect keeps still both ways by default).
const on = (entry, time) => (entry.holdBefore || entry.start <= time) && (entry.holdAfter || time <= entry.end);

// A letterbox bar: a shape spanning 95% or more of the frame's width or height, against a frame edge.
function isBar(model, box) {
  const edge = 2;
  const wide = box.x1 - box.x0 >= 0.95 * model.width && (box.y0 <= edge || box.y1 >= model.height - edge);
  const tall = box.y1 - box.y0 >= 0.95 * model.height && (box.x0 <= edge || box.x1 >= model.width - edge);
  return wide || tall;
}

// A plain box drawn under a reading text: a rectangle or ellipse holding 80% of a text's box, at most 3 times its size.
function backs(item, box, reading) {
  if (item.kind !== "rectangle" && item.kind !== "ellipse") return false;
  const size = area(box);
  return reading.some((text) => {
    const own = area(text);
    return own > 0 && size <= 3 * own && area(intersection(box, text)) >= 0.8 * own;
  });
}

// Whether what is heard is not known: the clips are not transcribed yet (a quick check) or there is no
// speech model. Spoken is then neither counted as shown nor as missing.
function heardUnknown(ctx) {
  if (!Array.isArray(ctx.speech) || ctx.speech.some((entry) => entry.missing && !entry.music)) return true;
  // A playing clip with no entry at all (no transcriber wired) is unknown too.
  const known = new Set(ctx.speech.map((entry) => entry.layer?.id));
  return (ctx.speechScene ?? ctx.scene)?.layers?.some((layer) => (layer.type === "audio" || layer.type === "video") && layer.src && layer.enabled !== false && Number(layer.volume ?? 1) > 0 && !known.has(layer.id)) ?? false;
}

// The seconds of the scene where a clip with a heard word plays, as [from, to] pairs.
function heardWords(model, ctx) {
  const scene = ctx.speechScene ?? ctx.scene;
  const found = [];
  if (!scene) return found;
  for (const entry of ctx.speech ?? []) {
    if (entry.music || entry.missing || !entry.transcript?.words || !entry.layer) continue;
    for (const word of speechWords(scene, [entry.layer], entry.transcript)) {
      if (word.unclear) continue;
      if (volumeAt(entry.layer, (word.start + word.end) / 2) >= HEARD) found.push([word.start, Math.max(word.end, word.start + 0.1)]);
    }
  }
  return found;
}

/**
 * The kinds the edit shows at each moment: [{time, kinds: Set, plain}] for `momentTimes`. `plain`
 * is true when no picture kind (type, overlay, composite, color, made) shows.
 */
export function onscreenKinds(model, ctx = {}) {
  const frameArea = model.width * model.height;
  const texts = new Set(readingTexts(model).map((item) => item.id));
  const effects = model.effects ?? [];
  const words = heardWords(model, ctx);
  return momentTimes(model.duration).map((time) => {
    const index = frameAt(model, time);
    const shown = model.items.filter((item) => !item.isMask && (item.samples.opacity[index] ?? 0) >= SHOWN);
    const kinds = new Set();
    if (shown.some((item) => texts.has(item.id))) kinds.add("type");
    // A shape or picture the eye gets that is not the whole frame in one plain fill.
    const partial = (item) => area(visibleBoxAt(model, item, index)) < FULL_SHARE * frameArea;
    const visible = new Set(model.items.filter((item) => !item.isMask && (item.samples.opacity[index] ?? 0) > 0.05).map((item) => item.id));
    if (effects.some((entry) => visible.has(entry.itemId) && on(entry, time) && OVERLAY_EFFECTS.has(entry.effect))) kinds.add("overlay");
    if (model.items.some((item) => visible.has(item.id) && !PICTURES.has(item.kind) && item.kind !== "text" && LIGHT_BLENDS.has(item.blendMode))) kinds.add("overlay");
    const pictures = shown.filter((item) => PICTURES.has(item.kind));
    if (pictures.filter(partial).length >= 2 || pictures.some((item) => (item.clipIds?.length ?? 0) > 0 || item.maskId)) kinds.add("composite");
    if (effects.some((entry) => visible.has(entry.itemId) && on(entry, time) && colorLook(entry))) kinds.add("color");
    const reading = shown.filter((item) => texts.has(item.id)).map((item) => boxAt(item, index));
    if (shown.some((item) => !item.sceneBackground && item.role !== "background" && partial(item)
      && ((SHAPES.has(item.kind) && item.painted && !isBar(model, boxAt(item, index)) && !backs(item, boxAt(item, index), reading)) || item.kind === "image"))) kinds.add("made");
    const plain = !kinds.size;
    if (words.some(([from, to]) => from < time + STEP / 2 && to >= time - STEP / 2)) kinds.add("spoken");
    return { time, kinds, plain };
  });
}

// What the references show: [{id, total, count: {kind: n}, plain, first: {kind: {at, words}}}] for the
// references labeled at all their moments (ref.moments of them, 6 unless the strips are shared): a partly
// labeled one would skew the shares. A labeled moment is plain when it names no picture kind (or only "plain").
function referenceShares(refs) {
  return (refs ?? []).filter((ref) => Array.isArray(ref.seen) && ref.seen.length >= Math.min(6, ref.moments ?? 6)).map((ref) => {
    const count = {}, first = {};
    let plain = 0;
    for (const entry of ref.seen) {
      const named = entry.kinds ?? [];
      if (!named.some((kind) => PICTURE_KINDS.includes(kind) || kind === "frame")) plain += 1;
      for (const kind of named.filter((name) => KINDS.includes(name))) { count[kind] = (count[kind] ?? 0) + 1; first[kind] ??= { at: entry.at, words: String(entry.words ?? "") }; }
    }
    return { id: ref.id, total: ref.seen.length, count, plain, first };
  });
}

// The search for a label's words: the kind word first (so it lands on that kind's tools), then the first five
// plain words. A type label searches the fonts first, a spoken label points to keep_line too.
// Gives { text, call } (the ready library call, for the finding's next).
function searchFor(kind, words) {
  const plain = String(words ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ") || "<what you saw>";
  const find = { tool: "library", input: { topic: "search", search: `${kind} ${plain}` } };
  const text = `library {topic:"search", search:${JSON.stringify(find.input.search)}} names kino's tools for those words`;
  if (kind === "type") return { text: `library {topic:"fonts", search:${JSON.stringify(plain)}} lists fonts for those words, and ${text}`, call: { tool: "library", input: { topic: "fonts", search: plain } } };
  if (kind === "spoken") return { text: `edit keep_line lets a clip's line be heard; ${text}`, call: find };
  return { text, call: find };
}

const showing = (share, kind) => `${share.count[kind] ?? 0} of ${share.total}`;
const labelOf = (share, kind) => {
  const first = share.first[kind];
  return first ? ` ${share.id} @${near(first.at)} "${first.words.replaceAll('"', "'")}"` : "";
};

export function referenceKinds(model, ctx) {
  const shares = referenceShares(ctx.seenRefs);
  if (!shares.length || !(model.duration > 0)) return [];
  const moments = onscreenKinds(model, ctx);
  if (!moments.length) return [];
  const scene = ctx.sceneName;
  const total = moments.length;
  const mine = (kind) => moments.filter((moment) => moment.kinds.has(kind)).length;
  const waive = `waive_check {code:"reference_kinds", target:"${scene}", reason:"<why>", quote:"<their words, as they typed them>"}`;
  const own = `Make your own version, not a copy of what the reference shows. Plain on purpose, only when the person asked for it in words they typed: ${waive}.`;
  const unknownSpoken = heardUnknown(ctx);
  const findings = [];
  for (const kind of KINDS) {
    const have = mine(kind);
    const showers = shares.filter((share) => (share.count[kind] ?? 0) >= MIN_MOMENTS);
    const lowest = Math.min(...shares.map((share) => (share.count[kind] ?? 0) / share.total));
    const lines = showers.map((share) => `${showing(share, kind)} (${labelOf(share, kind).trim()})`).join(" and ");
    const lead = showers[0]?.first[kind]?.words;
    const search = searchFor(kind, lead);
    if (kind === "spoken" && unknownSpoken) {
      // Not heard yet (the clips are not transcribed): neither shown nor missing. A note, not a count of 0.
      if (unknownSpoken && showers.length >= MIN_REFS) findings.push({ rule: "reference_kinds", severity: "info", measured: "spoken not judged", required: "check {pixels:true}", message: "reference_kinds: spoken is not judged yet, because the clips are not transcribed. check {pixels:true} transcribes them and judges it." });
      continue;
    }
    if (showers.length >= MIN_REFS && have === 0) {
      findings.push({
        rule: "reference_kinds", severity: "error",
        measured: `${kind} at 0 of ${total} moments`,
        required: `${kind} at some moment, as ${showers.length} of your references show it at 2 or more`,
        message: `reference_kinds: your edit shows ${kind} at 0 of ${total} moments; your references show it at ${lines}.`,
        fix: { kind: "hint", text: `${search.text}. ${own}`, call: search.call },
      });
    } else if (have > 0 && have / total < lowest - MARGIN) {
      const all = shares.map((share) => `${showing(share, kind)} (${share.id})`).join(" and ");
      findings.push({
        rule: "reference_kinds", severity: "warn",
        measured: `${kind} at ${have} of ${total} moments`,
        required: `${kind} at about ${Math.round(lowest * 100)}% of moments or more, as every reference`,
        message: `reference_kinds: your edit shows ${kind} at ${have} of ${total} moments; every reference shows it more: ${all}.`,
        fix: { kind: "hint", text: `${search.text}. ${own}`, call: search.call },
      });
    }
  }
  // Plain picture (nothing laid on the footage) in a larger share than any reference.
  const plainMine = moments.filter((moment) => moment.plain).length;
  const plainMost = Math.max(...shares.map((share) => share.plain / share.total));
  if (plainMine / total > plainMost + MARGIN) {
    const best = shares.flatMap((share) => KINDS.filter((kind) => share.first[kind]).map((kind) => share.first[kind].words))[0];
    findings.push({
      rule: "reference_kinds", severity: "warn",
      measured: `plain picture at ${plainMine} of ${total} moments`,
      required: `plain picture at ${Math.round(plainMost * 100)}% of moments or less, as the most plain of your references`,
      message: `reference_kinds: your edit is plain picture at ${plainMine} of ${total} moments; your references are plain at ${shares.map((share) => `${share.plain} of ${share.total} (${share.id})`).join(" and ")}.`,
      fix: { kind: "hint", text: `${searchFor("overlay", best).text}. ${own}` },
    });
  }
  return findings;
}
