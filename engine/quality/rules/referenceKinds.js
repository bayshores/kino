// reference_kinds (warning, taste): hold the edit to the kinds of design its own saved references show.
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
//   made       a shape, path, star, ellipse, group or image that is not a full-frame plain fill, and
//              the made layers' visible boxes at that moment add up to MADE_MIN_SHARE of the frame
//   spoken     a clip at volume 0.05 or more with a heard word then (ctx.speech)
//   plain      none of the picture kinds above
// Spoken also counts the references' measured voice (ctx.seenRefs[].heard, as reference_range reads
// it): most of them with a voice before their loudest change, and 2 or more, count as showing it, while
// one of the edit's clips says a line keep_line can keep (ctx.clipLines, a full check).
// Made also counts kino's drawn overlays (speed-lines, impact-lines, film-burn, lightning) while they play.
// Advice (info) with a place: 2 or more references show a kind at 2 or more moments and the edit shows it
// at none. It was an error until run 8, where clearing it cost about 14 revisions and 750 s of adding and
// removing the same device against the critics (run 8 trace, critic notes section 5); now it names a free
// moment (freeMoment) and never blocks a render.
// Warning: the edit shows a kind in under the lowest reference share by over 1/6, or plain
// picture in more than the highest reference share by over 1/6. Pure data: no pixels.
import { volumeAt } from "../../animation.js";
import { speechWords } from "../../speech.js";
import { effectDefaults } from "../../effects/catalog.js";
import { PARTICLE_LOOKS } from "../../effects/particles.js";
import { readingTexts } from "../analysis.js";
import { referenceRanges } from "../referenceCompare.js";
import { area, boxAt, frameAt, intersection, visibleBoxAt } from "../model.js";

export const KINDS = Object.freeze(["type", "overlay", "composite", "color", "made", "spoken"]);
const PICTURE_KINDS = KINDS.filter((kind) => kind !== "spoken");
const STEP = 0.5;
const SHOWN = 0.5;
const HEARD = 0.05;
const FULL_SHARE = 0.9;
const MARGIN = 1 / 6;
const MIN_MOMENTS = 2;
// Labeled moments a reference needs before its shares count (a guess: half of the 6 strip moments).
const SHARE_MOMENTS = 3;
const MIN_REFS = 2;
// The share of references with a voice before their loudest change that counts as "they show spoken" (as reference_range).
const VOICE_MAJORITY = 2 / 3;
// A guess, not measured: the made layers' visible boxes at a moment must add up to this share of the frame
// to count as made. 7 lime rectangles with one 1 to 2 px line showing covered about 0.2%; a graphic the
// eye finds is far larger. Raise or lower it when a measured set of drawn overlays says so.
export const MADE_MIN_SHARE = 0.01;
const OVERLAY_EFFECTS = new Set([...Object.keys(PARTICLE_LOOKS), "glow", "light-rays", "lens-flare", "grain"]);
const COLOR_EFFECTS = new Set(["curves", "lut", "hue-saturation", "white-balance", "color-wheels", "keep-color", "color-ranges", "color-look", "color-grade", "color-remover", "duotone", "tritone", "threshold-color"]);
const SHAPES = new Set(["rectangle", "ellipse", "star", "path", "group"]);
// kino's generated overlays (engine/effects/overlays.js, Post FX): drawn graphics, so they count as made.
const DRAWN_OVERLAYS = new Set(["speed-lines", "impact-lines", "film-burn", "lightning"]);
// A drawn overlay at opacity or amount 0 draws nothing.
const drawnShows = (entry) => [entry.to?.opacity, entry.to?.amount].every((value) => value === undefined || Number(value) > 0.01);
const PICTURES = new Set(["video", "image"]);
const LIGHT_BLENDS = new Set(["add", "screen"]);

const near = (value) => Math.round(value * 10) / 10;
const frameBox = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });

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
    // What a viewer can see: the made layers' visible boxes (inside the frame) add up to MADE_MIN_SHARE of it.
    const frame = frameBox(model);
    const made = shown.filter((item) => !item.sceneBackground && item.role !== "background" && partial(item)
      && ((SHAPES.has(item.kind) && item.painted && !isBar(model, boxAt(item, index)) && !backs(item, boxAt(item, index), reading)) || item.kind === "image"));
    // kino's own drawn overlays (the made error's ready call) are made too, over the layer they are drawn on, while on.
    const drawn = model.items.filter((item) => !made.includes(item) && shown.includes(item)
      && effects.some((entry) => entry.itemId === item.id && DRAWN_OVERLAYS.has(entry.effect) && on(entry, time) && drawnShows(entry)));
    const madeShare = [...made, ...drawn].reduce((sum, item) => sum + area(intersection(visibleBoxAt(model, item, index), frame)), 0) / frameArea;
    if (madeShare >= MADE_MIN_SHARE) kinds.add("made");
    const plain = !kinds.size;
    if (words.some(([from, to]) => from < time + STEP / 2 && to >= time - STEP / 2)) kinds.add("spoken");
    return { time, kinds, plain, madeShare };
  });
}

// What the references show: [{id, total, count: {kind: n}, plain, first: {kind: {at, words}}}] for every
// reference labeled at one moment or more, judged on the moments it has (total = its labeled moments). Until
// 2026-11-11 only references labeled at all their moments counted, so a half-labeled set left the rule silent
// (.scratch/ceiling/trace-code.md section 1). A kind still needs MIN_MOMENTS labeled moments to count a
// reference as showing it. A labeled moment is plain when it names no picture kind (or only "plain").
function referenceShares(refs) {
  return (refs ?? []).filter((ref) => Array.isArray(ref.seen) && ref.seen.length >= 1).map((ref) => {
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
  const plain = plainWords(words) || "<what you saw>";
  const find = { tool: "library", input: { topic: "search", search: `${kind} ${plain}` } };
  const text = `library {topic:"search", search:${JSON.stringify(find.input.search)}} names kino's tools for those words`;
  if (kind === "type") return { text: `library {topic:"fonts", search:${JSON.stringify(plain)}} lists fonts for those words, and ${text}`, call: { tool: "library", input: { topic: "fonts", search: plain } } };
  if (kind === "spoken") return { text: `edit keep_line lets a clip's line be heard; ${text}`, call: find };
  return { text, call: find };
}

const plainWords = (words) => String(words ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" ");

/**
 * The words of the first "type" label the agent saved on a reference (library inspire seen), in
 * the plain words the fonts search takes, or "" when no reference has one. default_font's fix searches with it.
 */
export function typeLabelWords(refs) {
  for (const ref of refs ?? []) {
    const entry = [...(ref.seen ?? [])].sort((a, b) => a.at - b.at).find((seen) => (seen.kinds ?? []).includes("type") && plainWords(seen.words));
    if (entry) return plainWords(entry.words);
  }
  return "";
}

// kino's own generated overlays (engine/effects/overlays.js, group Post FX) and the words that point to each.
const OVERLAY_WORDS = [
  ["speed-lines", /line|streak|stream|speed|ray|beam|motion|slash/i],
  ["impact-lines", /impact|focus|burst|radial|comic|zoom|shock/i],
  ["film-burn", /burn|heat|hot|fire|flare|orange|leak|glow/i],
  ["lightning", /lightning|electric|bolt|thunder|\barcs?\b/i],
];

/**
 * A free moment for a missing kind (seconds): the middle of the longest run of plain moments (nothing
 * laid on the footage), else the moment showing the fewest kinds. A guess at "where it does not crowd
 * anything", not measured against edits; null with no moments.
 */
export function freeMoment(moments) {
  if (!moments.length) return null;
  let best = null;
  let start = -1;
  moments.forEach((moment, index) => {
    if (moment.plain && start < 0) start = index;
    const ends = start >= 0 && (!moment.plain || index === moments.length - 1);
    if (!ends) return;
    const last = moment.plain ? index : index - 1;
    if (!best || last - start > best.last - best.start) best = { start, last };
    start = -1;
  });
  if (best) return moments[Math.floor((best.start + best.last) / 2)].time;
  return [...moments].sort((a, b) => a.kinds.size - b.kinds.size || a.time - b.time)[0].time;
}

// The generated overlay a made label's words point to (speed-lines when none does), as a ready edit call on the
// picture shown at `at` (the free moment; else the first picture shown): 1 s from then (2 moments), not the whole
// shot, so it reads as an accent.
function overlayFix(model, ctx, words, at = null) {
  const key = (OVERLAY_WORDS.find(([, pattern]) => pattern.test(String(words ?? ""))) ?? OVERLAY_WORDS[0])[0];
  const shots = model.items.filter((item) => PICTURES.has(item.kind) && !item.isMask)
    .map((item) => ({ item, at: item.samples.opacity.findIndex((value) => value >= SHOWN) })).filter((entry) => entry.at >= 0);
  const index = at === null ? -1 : frameAt(model, at);
  const there = index >= 0 ? shots.find((entry) => (entry.item.samples.opacity[index] ?? 0) >= SHOWN) : null;
  const first = there ?? shots.sort((a, b) => a.at - b.at)[0];
  if (!first) return null; // no picture to lay it on: the library search stays the call
  const start = near(there ? Math.max(0, at - STEP / 2) : model.times[first.at] ?? 0);
  const ops = [{ op: "add_animation", layer: first.item.name ?? first.item.id, effect: key, start, duration: near(Math.max(0.5, Math.min(1, model.duration - start))) }];
  return { text: `edit ${JSON.stringify({ ops })} lays kino's ${key} overlay on a shot`, call: { tool: "edit", input: { ops } } };
}

// keep_line on the first line a clip says, as the ready call (the clips' own lines, ctx.clipLines): a line cut short with "…" is kept by its scene seconds.
// null when no clip says a line at speed 1 (keep_line needs it).
function spokenFix(ctx) {
  // A song's sung words are not a clip's line: the music layers' transcripts are left out.
  const songs = new Set((ctx.speech ?? []).filter((entry) => entry.music).map((entry) => entry.layer?.id));
  const lines = (ctx.clipLines ?? []).filter((entry) => !songs.has(entry.layerId));
  const line = lines.find((entry) => !entry.slowed);
  if (!line) return null;
  const what = line.text.endsWith("…") ? { from: line.from, to: line.to } : { line: line.text };
  const ops = [{ op: "keep_line", layer: line.layer, ...what }, { op: "isolate_voice", layer: line.layer }];
  const shown = lines.slice(0, 3).map((entry) => `${entry.layer} "${entry.text.replaceAll('"', "'")}" ${entry.from}-${entry.to} s${entry.slowed ? " (slowed)" : ""}`).join(" · ");
  return { text: `edit ${JSON.stringify({ ops })} lets a clip's own line be heard (your clips say ${shown})`, call: { tool: "edit", input: { ops } } };
}

const showing = (share, kind) => `${share.count[kind] ?? 0} of ${share.total}`;
const labelOf = (share, kind) => {
  const first = share.first[kind];
  return first ? ` ${share.id} @${near(first.at)} "${first.words.replaceAll('"', "'")}"` : "";
};

export function referenceKinds(model, ctx) {
  const shares = referenceShares(ctx.seenRefs);
  if (!shares.length || !(model.duration > 0)) return [];
  // The share warnings (less of a kind, more plain picture) compare percentages, so they read only
  // references labeled at SHARE_MOMENTS moments or more: one labeled moment is a share of 0 or 100%.
  // The missing-kind error needs MIN_MOMENTS moments showing it anyway.
  const sized = shares.filter((share) => share.total >= SHARE_MOMENTS);
  const moments = onscreenKinds(model, ctx);
  if (!moments.length) return [];
  const scene = ctx.sceneName;
  const total = moments.length;
  const mine = (kind) => moments.filter((moment) => moment.kinds.has(kind)).length;
  const waive = `waive_check {code:"reference_kinds", target:"${scene}", reason:"<why>", quote:"<their words, as they typed them>"}`;
  const own = `Make your own version, not a copy of what the reference shows. Plain on purpose, only when the person asked for it in words they typed: ${waive}.`;
  // The missing-kind advice's place: one free moment for every kind (a guess, see freeMoment).
  const free = freeMoment(moments);
  const advice = "Advice, never a gate: your own shape, image or cutout there counts as made; plain on purpose is fine.";
  const unknownSpoken = heardUnknown(ctx);
  // The references' measured voice: 2 or more with a voice before their loudest change, and most of those that were heard.
  const voice = referenceRanges(ctx.seenRefs ?? []).voice;
  const voiced = voice.before >= MIN_REFS && voice.before / voice.n > VOICE_MAJORITY;
  const findings = [];
  for (const kind of KINDS) {
    const have = mine(kind);
    const showers = shares.filter((share) => (share.count[kind] ?? 0) >= MIN_MOMENTS);
    const lowest = Math.min(...sized.map((share) => (share.count[kind] ?? 0) / share.total));
    // Spoken: the labels first; with fewer than 2 labeled, the measured voice (2 of 2 with a voice) counts, and
    // only while a clip says a line keep_line can keep (else nothing in the edit fixes it: reference_range's
    // advice row names the footage finder instead).
    const byVoice = kind === "spoken" && voiced && showers.length < MIN_REFS && Boolean(spokenFix(ctx));
    const counted = byVoice ? voice.before : showers.length;
    const lines = byVoice ? `${voice.before} of ${voice.n} with a voice before their loudest change (${voice.example.id} @${near(voice.example.at)})`
      : showers.map((share) => `${showing(share, kind)} (${labelOf(share, kind).trim()})`).join(" and ");
    const lead = showers[0]?.first[kind]?.words;
    const search = searchFor(kind, lead);
    if (kind === "spoken" && unknownSpoken) {
      // Not heard yet (the clips are not transcribed): neither shown nor missing. A note, not a count of 0.
      if (unknownSpoken && counted >= MIN_REFS) findings.push({ rule: "reference_kinds", severity: "info", measured: "spoken not judged", required: "check {pixels:true}", message: "reference_kinds: spoken is not judged yet, because the clips are not transcribed. check {pixels:true} transcribes them and judges it." });
      continue;
    }
    if (counted >= MIN_REFS && have === 0) {
      // The fix is a ready call: spoken, keep_line on a clip's own line; made, a generated overlay for the label's words.
      const ready = kind === "spoken" ? spokenFix(ctx) : kind === "made" ? overlayFix(model, ctx, lead, free) : null;
      // Made layers exist but a viewer cannot see them: say how little of the frame they cover.
      const unseen = kind === "made" ? moments.filter((moment) => moment.madeShare > 0) : [];
      const covers = unseen.length ? Math.max(...unseen.map((moment) => moment.madeShare)) : 0;
      const hidden = unseen.length ? `made shows at ${unseen.length} of ${total} moments but covers ${Math.round(covers * 1000) / 10}% of the frame (under ${Math.round(MADE_MIN_SHARE * 100)}%)` : "";
      // Spoken has no free moment: a kept line plays where the clip says it (spokenFix names the times).
      const place = kind === "spoken" ? null : free;
      findings.push({
        rule: "reference_kinds", severity: "info", ...(place === null ? {} : { at: place }),
        measured: hidden || `${kind} at 0 of ${total} moments`,
        required: byVoice ? `${kind} at some moment, as ${voice.before} of ${voice.n} of your references have a voice there` : `${kind} at some moment, as ${showers.length} of your references show it at 2 or more`,
        message: `reference_kinds: ${hidden || `your edit shows ${kind} at 0 of ${total} moments`}; your references show it at ${lines}.${place === null ? "" : ` A free moment: ${place} s${lead ? ` ("${String(lead).replaceAll('"', "'").slice(0, 60)}")` : ""}.`}`,
        fix: { kind: "hint", text: `${ready ? `${ready.text}, or ${search.text}` : search.text}. ${kind === "made" ? advice : "Advice, never a gate; plain on purpose is fine."}`, call: (ready ?? search).call },
      });
    } else if (sized.length && have > 0 && have / total < lowest - MARGIN) {
      const all = sized.map((share) => `${showing(share, kind)} (${share.id})`).join(" and ");
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
  const plainMost = Math.max(...sized.map((share) => share.plain / share.total));
  if (sized.length && plainMine / total > plainMost + MARGIN) {
    const best = shares.flatMap((share) => KINDS.filter((kind) => share.first[kind]).map((kind) => share.first[kind].words))[0];
    findings.push({
      rule: "reference_kinds", severity: "warn",
      measured: `plain picture at ${plainMine} of ${total} moments`,
      required: `plain picture at ${Math.round(plainMost * 100)}% of moments or less, as the most plain of your references`,
      message: `reference_kinds: your edit is plain picture at ${plainMine} of ${total} moments; your references are plain at ${sized.map((share) => `${share.plain} of ${share.total} (${share.id})`).join(" and ")}.`,
      fix: { kind: "hint", text: `${searchFor("overlay", best).text}. ${own}` },
    });
  }
  return findings;
}
