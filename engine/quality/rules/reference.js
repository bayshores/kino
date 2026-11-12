// reference_drift (warning): how far the rendered scene is from the project's saved references,
// measured the same way (backend/measure: Apple Vision on a Mac). It runs only when the project has
// saved Inspire references with a fingerprint and kino can measure frames here
// (ctx.references and ctx.measureRender, given by backend/agent/quality.mjs).
//
// kino renders pairs of frames 1/12 s apart, every half second (at most 120 pairs, 640 px wide,
// the size references are measured at, so small captions read the same):
// flow within each pair (is the picture still or moving), text on the first frame of each pair,
// a feature print once a second. The comparison is referenceCompare.js. Text measures can raise
// the warning on their own; motion and closeness only advise, so they raise it only when at least
// two of them agree.
import { SHARE_MARGIN, compareFingerprints, referenceRanges } from "../referenceCompare.js";
import { readingTexts } from "../analysis.js";
import { CONTRAST_GAP, CONTRAST_RATIO, MOTION_WIDTH, brightness, frameContrast } from "../motionPixels.js";
import { speechWords } from "../../speech.js";
import { backgroundLuma, plateChanges, plates, techniquesUsed, transitions } from "../techniques.js";
import { hasMusic } from "./sound.js";

export const PAIR_SPACING = 0.5;
export const MAX_PAIRS = 120;
export const MEASURE_WIDTH = 640;
const PAIR_GAP = 1 / 12;

/** The [a, b] frame times kino measures in a scene `duration` seconds long. */
export function pairTimes(duration) {
  const spacing = Math.max(PAIR_SPACING, duration / MAX_PAIRS);
  const pairs = [];
  for (let time = 0.25; time + PAIR_GAP < duration; time += spacing) pairs.push([Math.round(time * 1000) / 1000, Math.round((time + PAIR_GAP) * 1000) / 1000]);
  return pairs;
}

/** Whether the rows say the render has drifted: a text row off, or two advice rows off. */
export function drifted(rows) {
  const off = rows.filter((row) => row.off);
  return off.some((row) => row.drives) || off.filter((row) => !row.drives).length >= 2;
}

export async function referenceDrift(model, ctx) {
  const references = ctx.references ?? [];
  if (!references.length || !ctx.measureRender || !ctx.renderFrames) return [];
  const width = Math.min(MEASURE_WIDTH, model.width);
  // ctx.measureRender renders the frames itself at `width` (null while it measures in the background).
  const measured = await ctx.measureRender(pairTimes(model.duration), { seconds: model.duration, width });
  if (!measured?.fingerprint) return [];
  const rows = compareFingerprints(measured.fingerprint, references, { renderPrints: measured.prints });
  if (!drifted(rows)) return [];
  const names = references.map((reference) => reference.id).join(", ");
  const off = rows.filter((row) => row.off);
  return [{
    rule: "reference_drift", severity: "warn",
    measured: off.map((row) => row.line).join("; "),
    required: `near the saved references (${names})`,
    message: `${ctx.sceneName} is far from its references (${names}): ${rows.map((row) => `${row.off ? "OFF " : ""}${row.line}${row.drives ? "" : " (advice)"}`).join("; ")}.`,
    fix: { kind: "hint", text: `Look at how the references do it: look {mode:"reference", ref:"${references[0].id}"}, then change the scene toward them, or waive this if the difference is wanted.` },
  }];
}

// ---------------------------------------------------------------- reference_range
//
// reference_range (warning) holds the edit to the range of the project's own saved references in
// five plain facts, measured the same way on both sides (backend/measure/fingerprint.mjs,
// backend inspire measure): median brightness and the share of the video under DARK, median
// contrast (2 x the spread of 16 x 9 cell brightness, read on the same frames), text
// entrances per 10 s, and whether a voice plays before the loudest change of the music. Unlike
// reference_drift it needs no Apple Vision, so it runs in the normal pixel pass and a final
// render sees it. Every bound is the references' own (no fixed target): an edit may stay outside
// the range and say why (waive_check). ctx.rangeRefs: [{id, fingerprint, heard}] (inspire
// savedFingerprints); at least RANGE_REFS of them need a brightness. ctx.cues carry the song's
// section weights (fit_music), ctx.speech the clips' heard words and the music layer's loudest
// change (`change`, from its saved song shape), ctx.clipLines the lines the clips say (the fix).
const RANGE_REFS = 2;
const RANGE_STEP = 0.5;
const RANGE_FRAMES = 120;
const DARK = 0.15;
// 8 levels of 255: the same step luma_jump counts as a visible brightness change.
const LEVEL_MARGIN = 8 / 255;
const TEXT_MARGIN = 1;
const VOICE_MAJORITY = 2 / 3;

const levelsOf = (value) => Math.round(value * 255);
const near = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The brightness numbers of a render's frames: {median, dark, run: [from, to] | null} (0 to 1; the longest dark stretch, seconds). */
function lookOf(samples, spacing, duration) {
  const sorted = samples.map((sample) => sample.level).sort((a, b) => a - b);
  const dark = samples.map((sample) => sample.level < DARK);
  let run = null, start = -1;
  for (let index = 0; index <= samples.length; index += 1) {
    if (dark[index]) { if (start < 0) start = index; continue; }
    if (start >= 0 && (!run || index - start > run[1] - run[0])) run = [start, index];
    start = -1;
  }
  return {
    median: sorted[Math.floor(sorted.length / 2)], dark: dark.filter(Boolean).length / samples.length,
    run: run ? [samples[run[0]].time, Math.min(duration, samples[run[1] - 1].time + spacing)] : null,
  };
}

/**
 * The video's loudest song change, {time}, or null: a song- cue with the biggest weight (fit_music;
 * not the intro or outro), else the music layer's saved song shape (`change` on its ctx.speech
 * entry: the played section with the most weight), so a hand-cut edit has one too.
 */
function loudestChange(ctx) {
  const cues = (ctx.cues ?? []).filter((cue) => /^song-/.test(cue.name ?? "") && !/^song-(intro|outro)-/.test(cue.name) && Number.isFinite(cue.weight));
  const cue = cues.sort((a, b) => b.weight - a.weight || a.time - b.time)[0];
  if (cue) return cue;
  return (ctx.speech ?? []).map((entry) => entry.change).filter((change) => Number.isFinite(change?.time)).sort((a, b) => a.time - b.time)[0] ?? null;
}

/** Whether a clip's own speech (a heard word, not a song) starts before `time`: true or false, or null when a heard clip has no transcript yet. */
function speechBefore(ctx, time) {
  const scene = ctx.speechScene ?? ctx.scene;
  let unknown = false;
  for (const entry of ctx.speech ?? []) {
    if (entry.music) continue;
    if (entry.missing) { unknown = true; continue; }
    if (!entry.transcript?.words || !scene) continue;
    if (speechWords(scene, [entry.layer], entry.transcript).some((word) => !word.unclear && word.start < time)) return true;
  }
  return unknown ? null : false;
}

/**
 * The contrast row, or null: the median contrast of the render's `frames` against the references'
 * `range` ({low, high, n}); a row when at least RANGE_REFS references have one and the render is
 * apart from the nearest bound by CONTRAST_GAP and by CONTRAST_RATIO. The fix is one color-grade
 * step (the next check measures again) on the shown clips and images.
 */
function contrastFinding(model, range, refs, frames, scene, waive) {
  if (!range || range.n < RANGE_REFS) return null;
  const values = (frames ?? []).filter(Boolean).map(frameContrast).sort((a, b) => a - b);
  if (!values.length) return null;
  const ours = values[Math.floor(values.length / 2)];
  const less = ours < range.low && range.low - ours >= CONTRAST_GAP && range.low >= ours * CONTRAST_RATIO;
  const more = ours > range.high && ours - range.high >= CONTRAST_GAP && ours >= range.high * CONTRAST_RATIO;
  if (!less && !more) return null;
  const names = refs.filter((ref) => Number.isFinite(ref.fingerprint?.look?.contrast)).map((ref) => ref.id).join(", ");
  const span = range.low === range.high ? `${range.low}` : `${range.low} to ${range.high}`;
  // One step toward the range, to the nearest 0.05 and no further than 1.1 to 1.5 (or 0.7 to 0.9).
  const step = Math.round((less ? (ours > 0 ? range.low / ours : 2) : range.high / ours) * 20) / 20;
  const amount = less ? Math.min(1.5, Math.max(1.1, step)) : Math.min(0.9, Math.max(0.7, step));
  const shown = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && item.samples.opacity.some((value) => value >= 0.5)).map((item) => item.name ?? item.id);
  return {
    rule: "reference_range", severity: "warn",
    measured: `median contrast ${ours} (2 x the spread of 16x9 cell brightness)`,
    required: `inside your ${range.n} saved references: ${span}`,
    message: `${scene} has ${less ? "less" : "more"} contrast than its saved references (${names}): ${ours} against ${span}.`,
    fix: { kind: "hint", text: `${less ? "Raise" : "Lower"} it one step: edit {ops:[{op:"add_animation", layer:"${shown[0] ?? "<layer>"}", effect:"color-grade", parameters:{contrast:${amount}}}]}${shown.length > 1 ? ` (and ${shown.slice(1).join(", ")})` : ""}, or keep it this way on purpose: ${waive}.` },
  };
}

export async function referenceRange(model, ctx) {
  const refs = ctx.rangeRefs ?? [];
  const ranges = referenceRanges(refs);
  if (!ctx.renderFrames || (ranges.brightness?.n ?? 0) < RANGE_REFS || !(model.duration > 0)) return [];
  const names = refs.filter((ref) => Number.isFinite(ref.fingerprint?.look?.brightness)).map((ref) => ref.id).join(", ");
  const scene = ctx.sceneName;
  const waive = `waive_check {code:"reference_range", target:"${scene}", reason}`;
  const findings = [];

  // Brightness: median and share under DARK, read at 2 frames a second (at most RANGE_FRAMES frames).
  const spacing = Math.max(RANGE_STEP, model.duration / RANGE_FRAMES);
  const times = [];
  for (let time = 0.25; time < model.duration; time += spacing) times.push(Math.round(time * 1000) / 1000);
  const frames = await ctx.renderFrames(times, { width: Math.min(MOTION_WIDTH, model.width), hide: [] });
  const samples = times.map((time, index) => (frames?.[index] ? { time, level: brightness(frames[index]) / 255 } : null)).filter(Boolean);
  if (samples.length) {
    const { median, dark, run } = lookOf(samples, spacing, model.duration);
    const light = ranges.brightness, shade = ranges.dark;
    const offLight = median < light.low - LEVEL_MARGIN || median > light.high + LEVEL_MARGIN;
    const offDark = shade && (dark > shade.high + SHARE_MARGIN || dark < shade.low - SHARE_MARGIN);
    if (offLight || offDark) {
      const lower = (offLight && median < light.low) || (offDark && dark > shade.high);
      const higher = (offLight && median > light.high) || (offDark && dark < shade.low);
      const word = lower && !higher ? "darker than" : higher && !lower ? "brighter than" : "lit differently from";
      const span = (low, high, show) => (low === high ? show(low) : `${show(low)} to ${show(high)}`);
      const [from, to] = lower && run ? run : [0, model.duration];
      // Every clip or image shown in the stretch, so the fix lifts all of it (not only the first shot).
      const inStretch = model.times.map((time, index) => (time >= from && time < to ? index : -1)).filter((index) => index >= 0);
      const indexes = inStretch.length ? inStretch : [Math.max(0, model.times.findIndex((time) => time >= from))];
      const shown = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && indexes.some((index) => item.samples.opacity[index] >= 0.5)).map((item) => item.name ?? item.id);
      const stretch = `${near(from)}-${near(to)} s`;
      const gamma = lower && !higher ? 1.3 : 0.8;
      const target = shown[0] ?? "<layer>";
      findings.push({
        rule: "reference_range", severity: "warn", at: from, until: to,
        measured: `median brightness ${levelsOf(median)} of 255; under ${levelsOf(DARK)} for ${Math.round(dark * 100)}% of the video${lower && run ? `, ${stretch}` : ""}`,
        required: `inside your ${light.n} saved references: median ${span(levelsOf(light.low), levelsOf(light.high), String)}${shade ? `, under ${levelsOf(DARK)} for ${span(Math.round(shade.low * 100), Math.round(shade.high * 100), (value) => `${value}%`)}` : ""}`,
        message: `${scene} is ${word} its saved references (${names}): median ${levelsOf(median)} of 255 against ${span(levelsOf(light.low), levelsOf(light.high), String)}${lower && run ? `; ${stretch} stays under ${levelsOf(DARK)}` : ""}.`,
        // match_references grades each shot toward the references' range (exposure only); check
        // {fix:"auto"} applies it when the edit is darker. Brighter than the references is a ready
        // call, not an auto fix: the owner called the edits dark, and match_references itself only
        // darkens with lower:true (engine/quality/exposureMatch.js aimFor). The hand fix stays in the text.
        fix: { kind: "match_references", auto: !(higher && !lower), ...(higher && !lower ? { lower: true } : {}), text: `${lower ? "Lift" : higher ? "Bring down" : "Match"} ${lower && run ? "that stretch" : "the picture"}: edit {ops:[{op:"match_references"${higher && !lower ? ", lower:true" : ""}}]} (per shot, exposure only), or by hand edit {ops:[{op:"add_animation", layer:"${target}", effect:"color-wheels", parameters:{gamma:${gamma}}}]}${shown.length > 1 ? ` (and ${shown.slice(1).join(", ")})` : ""}, or keep it this way on purpose: ${waive}.` },
      });
    }
  }

  // Contrast: the median of the same frames, apart from the references' range by CONTRAST_GAP and CONTRAST_RATIO.
  const contrast = contrastFinding(model, ranges.contrast, refs, frames, scene, waive);
  if (contrast) findings.push(contrast);

  // Text entrances per 10 s: one per text layer shown.
  const texts = readingTexts(model).length / model.duration * 10;
  const text = ranges.text10;
  if (text && (texts > text.high + TEXT_MARGIN || texts < text.low - TEXT_MARGIN)) {
    const span = text.low === text.high ? `${near(text.low)}` : `${near(text.low)} to ${near(text.high)}`;
    findings.push({
      rule: "reference_range", severity: "warn",
      measured: `${near(texts)} text entrances per 10 s`, required: `${span} per 10 s, as your references`,
      message: `${scene} brings in ${near(texts)} texts per 10 s; its saved references (${names}) bring in ${span}.`,
      fix: { kind: "hint", text: `${texts > text.high ? "Fold texts together or drop the ones the picture already says" : "Add the words the story needs"}, or keep the count: ${waive}.` },
    });
  }

  // A voice before the loudest change of the music: most references have one, and no clip's own
  // speech plays there in the edit (the song's singer does not count: the edit's voice is its
  // footage's). A reference's voice is whisper's, which hears singing and speech alike.
  // Advice only: whisper agreed with hand notes on 3 of 5 measured references.
  const change = loudestChange(ctx);
  const voice = ranges.voice;
  if (change && voice.pending) {
    ctx.note?.(`reference_range: ${voice.pending} saved reference${voice.pending === 1 ? " is" : "s are"} not measured yet for a voice before the loudest change (measuring in the background); the next check includes it.`);
  } else if (change && voice.n >= RANGE_REFS && voice.before / voice.n > VOICE_MAJORITY && speechBefore(ctx, change.time) === false) {
    const at = near(change.time);
    // keep_line needs a layer at speed 1, so a slowed clip's line is named but never the call.
    const lines = ctx.clipLines ?? [];
    const usable = lines.filter((entry) => !entry.slowed);
    const line = usable.find((entry) => entry.from < change.time) ?? usable[0];
    const shown = lines.slice(0, 3).map((entry) => `${entry.layer} "${entry.text.replaceAll('"', "'")}" ${entry.from}-${entry.to} s${entry.slowed ? " (slowed)" : ""}`).join(" · ");
    const fix = line
      ? `Your clips say ${shown}: keep one before ${at} s, edit {ops:[{op:"keep_line", layer:"${line.layer}", line:${JSON.stringify(line.text)}}]}`
      : lines.length ? `Your clips say ${shown}, only on slowed layers (keep_line needs speed 1): set one to speed 1, or find a line with library {topic:"footage", search:"<a spoken line>"}`
      : `No clip kino transcribed says a line: find one, library {topic:"footage", search:"<a spoken line>"}`;
    findings.push({
      rule: "reference_range", severity: "info", at: change.time,
      measured: `no clip's own speech plays before the loudest change at ${at} s`,
      required: `${voice.before} of ${voice.n} references have a voice there (sung or spoken; ${voice.example.id} at ${near(voice.example.at)} s)`,
      message: `${scene}: no clip's own speech plays before the loudest change at ${at} s; ${voice.before} of ${voice.n} saved references have a voice there (whisper hears singing and speech alike).`,
      fix: { kind: "hint", text: `${fix}, or keep the song alone: ${waive}.` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- reference_closeness
//
// reference_closeness (warning) is reference_drift turned round for music edits: a reference lends
// principles (section statistics), never its arrangement. It warns when
//   - a run of COPY_RUN shots or more has a saved reference's shot lengths in order, at one scale,
//     each within a frame, and chance cannot explain it (copiedRun): the cut timing was copied.
//     Two edits cut on 1 and 2 beats share runs by chance; a copied run of uneven lengths does not;
//   - a music edit (song- cues, a music layer or saved references) shows every device the studied
//     contest entries share (POOLED_PROFILE: a black hole, a flash on a seam, letterbox bars and word
//     cards on a plain frame), or three of them in a row in one of their orders (a drop stack lifted
//     whole). A promo's dip, flash and title are not checked.
// ctx.closeRefs: the saved references' lent cuts [{id, seconds, cuts, fps}] (backend inspire
// savedRhythms). Pure: no pixels, so it runs in every check.

export const COPY_RUN = 6;
// A run is a copy only when the number of runs this unlikely that chance alone would give, over
// every pairing of a scene shot with a reference shot, is under CHANCE.
const CHANCE = 0.01;
// The devices the contest entries studied for the anime plan share, and the orders they come in.
export const POOLED_PROFILE = Object.freeze({
  devices: ["black-hole", "seam-flash", "bars", "word-card"],
  orders: [["black-hole", "seam-flash", "word-card"], ["bars", "black-hole", "seam-flash"]],
});
const DEVICE_WORDS = { "black-hole": "a black hole before a hit", "seam-flash": "a flash on a seam", bars: "letterbox bars", "word-card": "word cards on a plain frame" };

const isPicture = (item) => item?.kind === "video" || item?.kind === "image";

// A brief solid plate, shown from a sample on (or within 0.35 s after it): "light" when shown 0.35 s
// or less (a flash), "dark" when shown 0.6 s or less (a black hole), else null. Neither is a shot.
function briefSolid(model, item, index) {
  if (!item || isPicture(item)) return null;
  const { opacity, luma } = item.samples;
  let start = index;
  while (start < model.times.length && opacity[start] < 0.5 && model.times[start] - model.times[index] < 0.35) start += 1;
  let length = 0;
  while (start + length < model.times.length && opacity[start + length] >= 0.5) length += 1;
  if (!length) return null;
  if (luma?.[start] >= 0.85 && length / model.fps <= 0.35 + 1e-6) return "light";
  if (luma?.[start] < 0.1 && length / model.fps <= 0.6 + 1e-6) return "dark";
  return null;
}

/**
 * The scene's shot changes, as [{at, until, from, to, flash}] by time: plate changes where the shot
 * before differs from the shot after. Brief solids (a flash, a dip to a black frame) between two
 * shots make one change from `at` to `until`; inside one shot (the same picture comes back) they
 * make none, so an impact frame is no cut. flash: a light frame is part of the change.
 */
export function shotChanges(model) {
  const changes = plateChanges(model);
  const tags = transitions(model);
  const byId = new Map(model.items.map((item) => [item.id, item]));
  const found = [];
  for (let index = 0; index < changes.length; index += 1) {
    const first = changes[index];
    let last = first;
    let flash = tags[index].tag === "flash";
    for (let solid = briefSolid(model, byId.get(last.to), last.index); solid && changes[index + 1]?.from === last.to; solid = briefSolid(model, byId.get(last.to), last.index)) {
      flash ||= solid === "light";
      index += 1;
      last = changes[index];
      flash ||= tags[index].tag === "flash";
    }
    if (last.to !== first.from) found.push({ at: first.at, until: last.at, from: first.from, to: last.to, flash });
  }
  return found;
}

/** The scene's shot change times (seconds, sorted): every shot change and every content cut. */
export function shotTimes(model) {
  const times = [...shotChanges(model).map((change) => change.at), ...(techniquesUsed(model).cut ?? []).map((entry) => entry.at)];
  const sorted = times.filter((time) => time > 0 && time < model.duration).sort((a, b) => a - b);
  // The same change found twice (one rounded to the hundredth) is one cut.
  return sorted.filter((time, index) => !index || time - sorted[index - 1] > 0.6 / model.fps);
}

/**
 * The longest run of at least `min` of the scene's shot lengths that follows the reference's shot
 * lengths in order at one scale (0.5 to 2), each within `tolerance` seconds, that chance cannot
 * explain. Inner shots only (a cut on both sides). The chance of a run: each shot after the first
 * (which sets the scale) matches as often as the scene's own lengths land on that reference length,
 * times every pairing tried. Returns {run, at, scale, chance} (at: the scene time the run starts) or null.
 */
export function copiedRun(sceneCuts, refCuts, { tolerance, min = COPY_RUN }) {
  const scene = sceneCuts.slice(1).map((time, index) => time - sceneCuts[index]);
  const ref = refCuts.slice(1).map((time, index) => time - refCuts[index]);
  const share = (length) => scene.filter((value) => Math.abs(value - length) <= tolerance).length / scene.length;
  let best = null;
  for (let i = 0; i < scene.length; i += 1) for (let j = 0; j < ref.length; j += 1) {
    const scale = scene[i] / ref[j];
    if (!(scale >= 0.5 && scale <= 2)) continue;
    let run = 0;
    while (i + run < scene.length && j + run < ref.length && Math.abs(scene[i + run] - ref[j + run] * scale) <= tolerance) run += 1;
    if (run < min || (best && run <= best.run)) continue;
    let chance = scene.length * ref.length;
    for (let k = 1; k < run; k += 1) chance *= share(ref[j + k] * scale);
    if (chance < CHANCE) best = { run, at: sceneCuts[i], scale: Math.round(scale * 100) / 100, chance };
  }
  return best;
}

/** The pooled-profile devices the scene shows, as [{device, at}] by time. */
export function profileDevices(model) {
  const found = [];
  const used = techniquesUsed(model);
  const fps = model.fps;
  const shown = (item, index) => item.samples.opacity[index] >= 0.5;
  // Picture: footage or a still filling the frame. A full-frame solid is a plain frame.
  const pictures = plates(model).filter(isPicture);
  const solids = plates(model).filter((item) => !isPicture(item)).sort((a, b) => b.z - a.z);
  const pictureAt = (index) => pictures.some((plate) => shown(plate, index));
  const plainLuma = (index) => {
    const solid = solids.find((item) => shown(item, index));
    return solid ? solid.samples.luma?.[index] ?? 1 : backgroundLuma(model, index);
  };
  const texts = readingTexts(model);
  // A black hole: 1 frame to 0.6 s with no picture and no words on a dark frame, between two shots.
  let run = 0;
  for (let index = 0; index < model.times.length; index += 1) {
    const dark = !pictureAt(index) && plainLuma(index) < 0.1 && !texts.some((item) => shown(item, index));
    if (dark) { run += 1; continue; }
    if (run && run <= 0.6 * fps && index - run > 0) found.push({ device: "black-hole", at: model.times[index - run] });
    run = 0;
  }
  for (const entry of used["fade-black"] ?? []) if (!found.some((item) => Math.abs(item.at - entry.at) < 0.3)) found.push({ device: "black-hole", at: entry.at });
  // A flash on a seam: a light frame within 0.1 s of a change to another shot (a flash inside one
  // shot, an impact frame, is a plain flash).
  const changes = shotChanges(model);
  for (const change of changes) {
    const near = (used.flash ?? []).find((entry) => entry.at >= change.at - 0.1 && entry.at <= change.until + 0.1);
    if (change.flash || near) found.push({ device: "seam-flash", at: near?.at ?? change.until });
  }
  // Letterbox bars: dark shapes across the frame at the top or bottom, 4% to 20% of its height.
  for (const item of model.items) {
    if (item.kind === "text" || item.kind === "video" || item.kind === "image" || item.kind === "group" || item.isMask) continue;
    const index = item.samples.opacity.findIndex((value) => value >= 0.5);
    if (index < 0 || !(item.samples.luma?.[index] <= 0.15)) continue;
    const [x0, y0, x1, y1] = ["x0", "y0", "x1", "y1"].map((key) => item.samples[key][index]);
    const tall = (y1 - y0) / model.height;
    if (x1 - x0 >= 0.95 * model.width && tall >= 0.04 && tall <= 0.2 && (y0 <= 0.01 * model.height || y1 >= 0.99 * model.height)) found.push({ device: "bars", at: model.times[index] });
  }
  // Word cards: big type on a plain frame (the background or a solid), no picture behind it.
  for (const entry of used["type-giant"] ?? []) {
    const index = Math.max(0, Math.min(model.times.length - 1, Math.round(entry.at * fps)));
    if (!pictureAt(index)) found.push({ device: "word-card", at: entry.at });
  }
  return found.sort((a, b) => a.at - b.at);
}

// Three devices in a row in an order: each within 2 s of the one before.
function orderAt(devices, order) {
  for (const [start, first] of devices.entries()) {
    if (first.device !== order[0]) continue;
    let at = first.at, step = 1;
    for (const next of devices.slice(start + 1)) {
      if (next.at - at > 2) break;
      if (next.device === order[step]) { at = next.at; step += 1; if (step === order.length) return first.at; }
    }
  }
  return null;
}

// A music edit: the song's seams are marked (fit_music), a music layer plays, or references are saved.
function musicEdit(ctx) {
  if ((ctx.closeRefs ?? []).length) return true;
  if ((ctx.cues ?? []).some((cue) => String(cue.name ?? "").startsWith("song-"))) return true;
  const scene = ctx.speechScene ?? ctx.scene;
  return Boolean(scene?.layers) && hasMusic(scene, ctx.speech ?? []);
}

export function referenceCloseness(model, ctx) {
  const findings = [];
  const tolerance = 1 / model.fps + 0.01;
  const cuts = shotTimes(model);
  for (const ref of ctx.closeRefs ?? []) {
    if (!Array.isArray(ref.cuts) || ref.cuts.length < COPY_RUN + 1) continue;
    const copied = copiedRun(cuts, ref.cuts, { tolerance });
    if (!copied) continue;
    findings.push({
      rule: "reference_closeness", severity: "warn", at: copied.at,
      measured: `${copied.run} shots in a row from ${copied.at}s have ${ref.id}'s shot lengths in order (x${copied.scale})`,
      required: `under ${COPY_RUN} shots in a row timed like a reference, beyond what beat cutting shares by chance`,
      message: `${ctx.sceneName} copies ${ref.id}'s cutting: ${copied.run} shots in a row from ${copied.at}s are its shot lengths in order, each within a frame, more than chance gives. A reference lends its pace per section, not its arrangement.`,
      fix: { kind: "hint", text: `Cut on this song's seams and the footage's own action instead; borrow_rhythm {ref:"${ref.id}"} lends its section pace in a new order.` },
    });
  }
  if (!musicEdit(ctx)) return findings;
  const devices = profileDevices(model);
  const kinds = new Set(devices.map((entry) => entry.device));
  const order = POOLED_PROFILE.orders.map((list) => ({ list, at: orderAt(devices, list) })).find((entry) => entry.at !== null);
  if (POOLED_PROFILE.devices.every((device) => kinds.has(device)) || order) {
    const shownWords = (order ? order.list : POOLED_PROFILE.devices).map((device) => DEVICE_WORDS[device]);
    findings.push({
      rule: "reference_closeness", severity: "warn", ...(order ? { at: order.at } : {}),
      measured: order ? `${order.list.join(" then ")} from ${order.at}s` : `all of ${POOLED_PROFILE.devices.join(", ")}`,
      required: "not the device stack your saved references share, nor its order",
      message: `${ctx.sceneName} ${order ? `stacks ${shownWords.join(", then ")} within 2 s` : `uses every device (${shownWords.join(", ")})`}: the device stack your saved references share reads as a copy. Keep the ones this song and footage motivate.`,
      fix: { kind: "hint", text: "Drop a device that no seam or footage event calls for; zero of any device is fine." },
    });
  }
  return findings;
}
