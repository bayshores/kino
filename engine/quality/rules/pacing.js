// Pacing and promise rules. Gates: promo_basics, assertions.
// Warnings: scene_lengths, no_rhythm, transitions_dense, static_scene, off_beat (near misses of a beat only).
import { atFullOpacity, coversFrame, cuts, drawnSize, firstEntrances, goodEntranceDelay, inRest, isPerpetual, motions, primaryItems, readableAt, readingTexts, recommendedHold, sec, sections, shownShare } from "../analysis.js";
import { area, boxAt, chainOf, fillColorsAt, frameAt, hexRgba, insideShare, intersection, isDecor, itemById, luminance, paintColors, startsWithCut, visibleBoxAt } from "../model.js";
import { paceCounts, referencePace } from "../referenceCompare.js";
import { typeLimits } from "./text.js";
import { isHoldMotion } from "./motion.js";

const PROMO_TYPES = new Set(["promo", "ad"]);
const CTA_WORDS = /\b(shop|buy|order|get|try|start|sign up|join|download|learn more|book|visit|subscribe|call|apply|discover|explore|install|watch)\b/i;
const URL_LIKE = /\b[\w-]+\.(com|io|app|co|net|org|ai|dev|shop|store)\b/i;

// The first sample (at or before `limit` seconds) where `test` holds, or -1.
function firstSample(model, test, limit = model.duration) {
  const last = frameAt(model, limit);
  for (let index = 0; index <= last; index += 1) if (test(index)) return index;
  return -1;
}

const fullyShown = (model, item, index) => atFullOpacity(item, index) && shownShare(model, item, index) >= 0.9;

// Near black: every color of a paint under 2% luminance (no paint counts as the black canvas).
const darkPaint = (colors) => colors.every((color) => luminance(hexRgba(color)) < 0.02);

// What is drawn at a sample: not masks, groups or audio, and at least 5% opacity.
const drawnAt = (model, index) => model.items.filter((item) => !item.isMask && item.kind !== "group" && item.kind !== "audio" && item.samples.opacity[index] >= 0.05);

// A plain full-frame shape (not the scene background): a plate under an end mark, or a dip to black.
const plainCover = (model, item) => !item.source?.sceneBackground && ["rectangle", "ellipse"].includes(item.kind) && coversFrame(model, item);

/**
 * True when the video ends on black (a dip to black): at the last sample nothing but dark
 * paint is seen, either an opaque dark layer over the whole frame with nothing drawn above it, or
 * nothing at all over a dark scene background and canvas. A dark background alone is not a dip.
 */
export function endsOnBlack(model) {
  const last = model.times.length - 1;
  const seen = drawnAt(model, last);
  const covers = seen.filter((item) => item.samples.opacity[last] >= 0.95 && plainCover(model, item) && darkPaint(fillColorsAt(item, last)));
  if (covers.some((cover) => seen.every((other) => other === cover || other.z <= cover.z))) return true;
  return seen.every((item) => item.source?.sceneBackground && darkPaint(fillColorsAt(item, last))) && darkPaint(paintColors(model.background));
}

/**
 * True when a logo is the only thing on screen at some sample in the last 20% (a small end
 * mark): every other drawn layer, except the scene background and plain
 * full-frame plates, is under half opacity. A watermark over the hero or footage is not an end.
 */
function endsOnMark(model, logos, tail) {
  return model.times.some((time, index) => time >= tail - 1e-6 && logos.some((logo) => fullyShown(model, logo, index)
    && drawnAt(model, index).every((other) => other.samples.opacity[index] < 0.5 || other.source?.sceneBackground || plainCover(model, other)
      || chainOf(model, other).some((link) => link.role === "logo"))));
}

export function promoBasics(model, ctx) {
  // Only promos and ads. Without a video type it says how to turn the check on.
  const type = model.videoType ?? null;
  if (!type) ctx.note?.("promo_basics did not run: set the project's videoType to promo or ad to check the logo, message, hero and CTA");
  if (!type || !PROMO_TYPES.has(type)) return [];
  const findings = [];
  const by = Math.min(5, model.duration);
  const part = (name, message, fix) => findings.push({ rule: "promo_basics", severity: "error", part: name, measured: "missing", required: name, message, fix });

  const logos = model.items.filter((item) => item.role === "logo");
  if (!logos.length) part("logo by 5 s", `No layer in ${ctx.sceneName} is marked role logo, so the brand cannot be checked`, { kind: "hint", text: "Set role logo on the logo or brand name layer." });
  else if (!logos.some((item) => firstSample(model, (index) => fullyShown(model, item, index), by) >= 0))
    part("logo by 5 s", `The logo (${ctx.name(logos[0])}) is not fully shown by ${sec(by)}s`, { kind: "hint", text: "Show the logo, or a brand name, within the first 5 seconds." });

  // The main message: the text marked headline or, when none is, any headline-size text.
  const marked = readingTexts(model).filter((item) => item.role === "headline");
  const minimum = typeLimits(model).headline - 0.5;
  const heads = marked.length ? marked : readingTexts(model).filter((item) => !["cta", "logo", "caption"].includes(item.role) && drawnSize(model, item) >= minimum);
  if (!heads.some((item) => firstSample(model, (index) => readableAt(model, item, index), by) >= 0))
    part("message by 5 s", marked.length
      ? `The headline (${ctx.name(marked[0])}) is not readable by ${sec(by)}s`
      : `No headline-size text (${Math.round(minimum)}px or more) is readable by ${sec(by)}s, and no layer is marked role headline`,
    { kind: "hint", text: "Bring the main message in, and hold it still, within the first 5 seconds; set role headline on it." });

  const markedHero = model.items.filter((item) => item.role === "hero");
  const heroes = markedHero.length ? markedHero : model.items.filter((item) => !isDecor(item) && !item.isMask && !item.sceneBackground && !coversFrame(model, item) && item.kind !== "group");
  const frame = model.width * model.height;
  const coverage = (item, index) => {
    if (item.samples.opacity[index] < 0.5) return 0;
    const box = boxAt(item, index);
    return area(intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height })) / frame;
  };
  let best = 0;
  for (const item of heroes) for (let index = 0; index < model.times.length; index += 1) best = Math.max(best, coverage(item, index));
  if (best < 0.3)
    part("hero ≥30%", `No ${markedHero.length ? "hero" : "single"} layer covers 30% of the frame at any time (largest: ${Math.round(best * 100)}%)`, { kind: "hint", text: "Show the product or hero image large, covering at least 30% of the frame once." });

  const ctas = model.items.filter((item) => item.role === "cta");
  const candidates = ctas.length ? ctas : readingTexts(model).filter((item) => CTA_WORDS.test(item.text) || URL_LIKE.test(item.text));
  const tail = model.duration * 0.8;
  // The end may be a small mark (the logo alone, any size, at some point in the last 20%)
  // or a dip to black instead of a call to action: no big end card is required.
  // The logo must be alone then: a watermark over the hero is not an end.
  if (endsOnMark(model, logos, tail) || endsOnBlack(model)) return findings;
  if (!candidates.length) part("CTA in last 20%", `${ctx.sceneName} has no call to action (a layer with role cta, or text such as "Shop now" or a web address)`, { kind: "hint", text: "End with a call to action (role cta), a small logo mark (role logo) in the last 20%, or a dip to black." });
  else if (!candidates.some((item) => model.times.some((time, index) => time >= tail - 1e-6 && fullyShown(model, item, index))))
    part("CTA in last 20%", `The call to action (${ctx.name(candidates[0])}) is not shown in the last 20% (after ${sec(tail)}s)`, { kind: "hint", text: "Keep the call to action on screen through the end." });
  return findings;
}

// The item an assertion's target means: the layer with that ID in the scene (not a copy).
function assertionItem(model, layerId) {
  return model.items.find((item) => item.source?.layerId === layerId && !item.source.instanceId)
    ?? model.items.find((item) => item.id === layerId);
}

// The brief's length (notes brief fields.length) comes in as ctx.length {seconds, tolerance,
// video} on the scene that is the video, where `video` is the video's length (brief.mjs videoFacts).
// It is checked as one more assertion, type length, after the scene's own.
function lengthFinding(assertion, position) {
  const { seconds, tolerance, video } = assertion;
  if (Math.abs(video - seconds) <= tolerance + 1e-6) return null;
  return {
    rule: "assertions", severity: "error", assertion: position, measured: `${sec(video)} s`, required: `${seconds} s (within ${tolerance} s)`,
    message: `The video is ${sec(video)} s, but the brief asks for ${seconds} s (within ${tolerance} s): ${sec(Math.abs(video - seconds))} s too ${video > seconds ? "long" : "short"}.`,
    fix: { kind: "hint", text: `Make the video ${seconds} s (retime {scene, duration:${seconds}}, or cut or add shots), or save the length the person now wants (notes brief fields:{length}).` },
  };
}

export function assertions(model, ctx) {
  const findings = [];
  const list = [...model.assertions, ...(ctx.length ? [{ type: "length", ...ctx.length }] : [])];
  list.forEach((assertion, position) => {
    if (assertion.type === "length") {
      const found = lengthFinding(assertion, position);
      if (found) findings.push(found);
      return;
    }
    const note = assertion.note ? ` (${assertion.note})` : "";
    const fail = (message, extra = {}) => findings.push({ rule: "assertions", severity: "error", assertion: position, measured: "failed", required: assertion.type, message: message + note, fix: { kind: "hint", text: "Change the scene so the promise holds, or remove the assertion if it no longer applies." }, ...extra });
    const item = assertionItem(model, assertion.target);
    if (!item) return fail(`Assertion ${position + 1} names layer ${assertion.target}, which is not in ${ctx.sceneName}`);
    if (assertion.type === "visible_by") {
      if (firstSample(model, (index) => fullyShown(model, item, index), assertion.time) < 0)
        fail(`${ctx.name(item)} should be fully shown by ${sec(assertion.time)}s, but is not`, { itemId: item.id, at: sec(assertion.time) });
    } else if (assertion.type === "before") {
      const other = assertionItem(model, assertion.other);
      if (!other) return fail(`Assertion ${position + 1} names layer ${assertion.other}, which is not in ${ctx.sceneName}`);
      const mine = firstSample(model, (index) => item.samples.opacity[index] >= 0.5);
      const theirs = firstSample(model, (index) => other.samples.opacity[index] >= 0.5);
      if (mine < 0 || (theirs >= 0 && mine >= theirs))
        fail(`${ctx.name(item)} should appear before ${ctx.name(other)}, but ${mine < 0 ? "never appears" : `appears at ${sec(model.times[mine])}s, and ${ctx.name(other)} at ${sec(model.times[theirs])}s`}`, { itemId: item.id });
    } else if (assertion.type === "inside_frame") {
      const out = firstSample(model, (index) => item.samples.opacity[index] > 0.05 && insideShare(model, boxAt(item, index)) < 0.999);
      if (out >= 0) fail(`${ctx.name(item)} should stay inside the frame, but leaves it at ${sec(model.times[out])}s`, { itemId: item.id, at: sec(model.times[out]) });
    }
  });
  return findings;
}

export function sceneLengths(model, ctx) {
  const list = sections(model);
  if (list.length < 3) return [];
  const lengths = list.map((section) => section.end - section.start);
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (!lengths.every((value) => Math.abs(value - mean) <= 0.15 * mean)) return [];
  return [{
    rule: "scene_lengths", severity: "warn", measured: lengths.map(sec).join(", "), required: "varied lengths",
    message: `All ${list.length} sections of ${ctx.sceneName} last about ${sec(mean)}s; an even beat of equal sections feels mechanical.`,
    fix: { kind: "hint", text: "Hold the key message longer and make the build-up sections shorter." },
  }];
}

export function noRhythm(model, ctx) {
  if (!model.audio || model.rhythm) return [];
  return [{
    rule: "no_rhythm", severity: "warn", measured: "none", required: "a declared beat",
    message: `${ctx.sceneName} has sound but no rhythm, so motion cannot be checked against the beat.`,
    fix: { kind: "hint", text: "Set the project's rhythm {bpm, offset} to the music's tempo and first beat." },
  }];
}

const beatOf = (model) => 60 / (model.rhythm?.bpm ?? 120);
// off_beat: an accent this far from a beat (or less) is a near miss; further is syncopation.
export const NEAR_MISS = 0.07;

const SHOT_MOVE_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation"]);

// A full-frame layer's place or scale move that starts on its own hard cut in and keeps the frame
// covered to its end: the shot's own camera move. busy_edit and drift_on_every_shot judge it, and
// its cut is already a plain cut. A shot that slides in from off the frame is a transition.
function startsOnOwnCut(model, item, motion, frame) {
  if (!motion.tweens.every((tween) => tween.kind !== "in" && tween.kind !== "out" && tween.keys.every((key) => SHOT_MOVE_KEYS.has(key)))) return false;
  const whole = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const covers = (index) => area(intersection(visibleBoxAt(model, item, index), whole)) / frame >= 0.95;
  if (!covers(frameAt(model, motion.end))) return false;
  const first = frameAt(model, motion.start);
  // The move may start a frame before the first sample where the layer is shown.
  return [first, first + 1].some((index) => index < model.times.length && item.samples.opacity[index] >= 0.9
    && motion.start <= model.times[index] + 1 / model.fps && covers(index) && startsWithCut(model, item, index));
}

// An effect animation (a glow, a grade) on a layer shown before and after it: it changes the look
// of a shot that stays on screen, not the picture between shots. A blur on a shot that leaves at
// its end is still a transition.
function effectOnStayingLayer(model, item, motion) {
  if (!motion.tweens.every((tween) => tween.keys.every((key) => key.startsWith("effect.")))) return false;
  const shown = (time) => item.samples.opacity[frameAt(model, time)] > 0.05;
  return shown(motion.start - 1 / model.fps) && shown(motion.end + 1 / model.fps);
}

// Transitions that move a large share of the frame: entrances, exits and moves of big layers.
function bigTransitions(model) {
  const frame = model.width * model.height;
  return motions(model).filter((motion) => {
    const item = itemById(model, motion.itemId);
    // A slow drift through a hold is not a transition, nor is an instant step (a frame cut).
    if (!item || isPerpetual(model, item) || isHoldMotion(model, item, motion) || motion.duration <= 0.5 / model.fps) return false;
    if (startsOnOwnCut(model, item, motion, frame) || effectOnStayingLayer(model, item, motion)) return false;
    let largest = 0;
    for (let index = 0; index < model.times.length; index += 1)
      if (item.samples.opacity[index] > 0.05 || item.isMask) largest = Math.max(largest, area(boxAt(item, index)) / frame);
    return largest >= 0.25;
  }).sort((a, b) => a.start - b.start);
}

export function transitionsDense(model, ctx) {
  const list = bigTransitions(model);
  const windowLength = 6 * beatOf(model);
  // Starts within one sample of each other are one transition.
  // A move counts once, at its first start, however many layers and parts it animates.
  const seenMoves = new Set();
  const starts = [];
  for (const motion of list) {
    if (motion.tweens.every((tween) => tween.move)) {
      const id = motion.tweens[0].move;
      if (seenMoves.has(id)) continue;
      seenMoves.add(id);
    }
    if (!starts.length || motion.start - starts.at(-1).time > 1 / model.fps + 1e-6) starts.push({ time: motion.start, itemId: motion.itemId });
  }
  // With 2 or more measured references, the bound is how many cuts they make in a window this long
  // (never under 2: the references only loosen it).
  const pace = referencePace(ctx.closeRefs);
  const theirs = pace ? paceCounts(pace.cut, windowLength) : null;
  const bound = Math.max(2, theirs?.high ?? 0);
  for (let first = 0; first < starts.length; first += 1) {
    const from = starts[first].time;
    const inside = starts.filter(({ time }) => time >= from - 1e-6 && time < from + windowLength - 1e-6);
    if (inside.length <= bound) continue;
    const named = inside.slice(0, 3).map(({ time, itemId }) => `${ctx.name(itemById(model, itemId))} ${sec(time)} s`).join(", ");
    const refs = pace ? `your references (${pace.cut.ids.join(", ")}) cut ${theirs.low} to ${theirs.high} times in ${sec(windowLength)}s` : "";
    return [{
      rule: "transitions_dense", severity: "warn", at: sec(from), until: sec(from + windowLength),
      measured: `${inside.length} in 6 beats`, required: pace ? `at most ${bound} in 6 beats (${theirs.low} to ${theirs.high} in your references)` : "at most 2 in 6 beats",
      message: `${inside.length} large transitions start within 6 beats (${sec(windowLength)}s from ${sec(from)}s: ${named})${model.rhythm ? "" : " at an assumed 120 bpm"}; ${pace ? refs : "it feels busy"}.`,
      fix: { kind: "hint", text: "Replace some with simple cuts, or spread them out." },
    }];
  }
  return [];
}

export function staticScene(model, ctx) {
  const count = model.times.length;
  const changed = new Uint8Array(count);
  for (const item of model.items) {
    const { x0, y0, x1, y1, opacity, textIndex, moving: movesAt } = item.samples;
    const moving = item.kind === "video";
    // Compare with the last sample where this item changed, so a slow push-in (under half a
    // pixel a sample) still adds up to a change.
    let last = 0;
    const differs = (index) => Math.abs(opacity[index] - opacity[last]) > 0.01 || Math.abs(x0[index] - x0[last]) > 0.5 || Math.abs(y0[index] - y0[last]) > 0.5
      || Math.abs(x1[index] - x1[last]) > 0.5 || Math.abs(y1[index] - y1[last]) > 0.5 || (textIndex && textIndex[index] !== textIndex[last]);
    for (let index = 1; index < count; index += 1) {
      if (opacity[index] < 0.05 && opacity[last] < 0.05) { last = index; continue; }
      if ((moving && opacity[index] >= 0.05) || movesAt?.[index] || differs(index)) { changed[index] = 1; last = index; }
    }
  }
  // A planned still (scene.rests) splits the stills around it.
  for (let index = 1; index < count; index += 1) if (inRest(model, model.times[index])) changed[index] = 1;
  const stills = [];
  let from = 0;
  for (let index = 1; index <= count; index += 1) {
    if (index < count && !changed[index]) continue;
    stills.push({ from, to: index - 1 });
    from = index;
  }
  const findings = [];
  for (const still of stills) {
    const length = (still.to - still.from) / model.fps;
    const shownTexts = readingTexts(model).filter((item) => item.samples.opacity[still.from] >= 0.5);
    const hold = Math.max(2, ...shownTexts.map((item) => recommendedHold(item.texts ? item.texts[item.samples.textIndex[still.from]] : item.text)));
    const limit = hold + 2;
    if (length <= limit + 1e-6 || still.to === count - 1 && still.from === 0 && !primaryItems(model).length) continue;
    findings.push({
      rule: "static_scene", severity: "warn", at: sec(model.times[still.from]), until: sec(model.times[still.to]),
      measured: sec(length), required: `≤${sec(limit)}s`,
      message: `Nothing changes in ${ctx.sceneName} for ${sec(length)}s from ${sec(model.times[still.from])}s; the longest needed hold here is ${sec(hold)}s.`,
      fix: { kind: "hint", text: "Cut sooner, or add a slow move (a push-in or drift) while the text is read." },
    });
  }
  return findings;
}

export function offBeat(model, ctx) {
  if (!model.rhythm) return [];
  const beat = beatOf(model);
  const frame = 1 / (ctx.outputFps ?? 30);
  const findings = [];
  const seen = new Set();
  // Not every accent belongs on a beat: one placed clearly between beats is syncopated, a choice.
  // The eye reads a miss of a frame or two (up to about 70 ms) as an error, so only those are flagged.
  // A first entrance placed 0.1–0.3 s after its cut follows the cut's beat on purpose.
  const delayed = new Set(firstEntrances(model).filter((entry) => goodEntranceDelay(model, entry.delay)).map((entry) => entry.motion));
  // A move's parts are timed by the move (a logo-settle name types on after its mark lands): the
  // move is placed on the beat as a whole, so its parts are not judged one by one.
  const byMove = (motion) => Boolean(itemById(model, motion.itemId)?.move) || motion.tweens.every((tween) => tween.move);
  for (const motion of motions(model)) if (byMove(motion)) delayed.add(motion);
  const accents = [...cuts(model).filter((time) => time > 0).map((time) => ({ time, motion: null })),
    ...motions(model).filter((motion) => !delayed.has(motion) && primaryItems(model).some((item) => item.id === motion.itemId)).map((motion) => ({ time: motion.start, motion }))];
  for (const { time, motion } of accents.sort((a, b) => a.time - b.time)) {
    const key = sec(time);
    if (seen.has(key)) continue;
    seen.add(key);
    const beats = (time - model.rhythm.offset) / beat;
    const nearest = model.rhythm.offset + Math.round(beats) * beat;
    const off = time - nearest;
    // On the beat (within a frame), or clearly between beats (syncopation, a choice): fine.
    // Only a near miss, more than a frame and up to NEAR_MISS off, reads as a mistake.
    if (Math.abs(off) <= frame + 1e-6 || Math.abs(off) > Math.max(NEAR_MISS, frame) + 1e-6 || nearest < 0) continue;
    // A quick motion that ends on the beat (an exit or a press finishing on it) lands on it.
    if (motion && motion.duration <= 0.2 + 1e-6 && Math.abs(motion.start + motion.duration - nearest) <= frame + 1e-6) continue;
    const item = motion ? itemById(model, motion.itemId) : null;
    findings.push({
      rule: "off_beat", severity: "warn", itemId: item?.id, at: sec(time),
      measured: `${Math.round(off * 1000)}ms off`, required: `on the beat (within 1 frame), or clearly between beats (over ${Math.round(NEAR_MISS * 1000)} ms off)`,
      message: `${item ? `${ctx.name(item)}'s ${motion.kind === "out" ? "exit" : motion.kind === "in" ? "entrance" : "move"}` : "The cut"} at ${sec(time)}s is ${Math.round(Math.abs(off) * 1000)}ms ${off > 0 ? "after" : "before"} the beat at ${sec(nearest)}s: a near miss that looks like an error.`,
      fix: motion
        ? { kind: "tweens", changes: motion.tweens.map((tween) => ({ tweenId: tween.id, itemId: motion.itemId, properties: { start: sec(Math.max(0, tween.start - off)) } })) }
        : { kind: "hint", text: `Move the cut to ${sec(nearest)}s.` },
    });
  }
  return findings;
}
