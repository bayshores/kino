// Motion rules. Gates: linear_motion, spring_on_fade, same_motion.
// Warnings: easing_repeat, bouncy_layers, duration_band, exit_ratio, stagger_long, stagger_order,
// first_entrance, speed_jump, judder.
import { FADE_KEYS, cuts, drawnSize, easingKey, entrances, firstEntrances, goodEntranceDelay, isPerpetual, motions, neverShown, primaryItems, sec, speechTimed } from "../analysis.js";
import { typeLimits } from "./text.js";
import { heardEdges, heardWords } from "./speech.js";
import { area, boxAt, chainOf, frameAt, itemById, roundBox, tweensOf } from "../model.js";
import { easingBezier } from "../../easing.js";
import { WHIP_SHUTTER } from "../../previewBlur.js";

// Position, scale and rotation: the keys linear_motion and the bounce rules look at.
const MOTION_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation"]);
const COLOR_KEYS = new Set(["fill", "stroke", "background", "color"]);
const BOUNCY = new Set(["bounce", "elastic"]);
const ROLE_RANK = { headline: 0, subhead: 1, body: 2, caption: 2, cta: 3 };
const UNIT_NAME = { letters: "letter", words: "word", lines: "line" };

const movesPlace = (tween) => tween.keys.some((key) => MOTION_KEYS.has(key));

// A slow camera push or drift: a move of 2 s or longer that is not an entrance or exit, by
// position and scale only, of a layer that is not text and covers at least half the frame on
// screen when it starts and ends (a plate, the group that holds the scene) or is the background,
// in which no corner of the layer's part on screen travels more than 4% of the frame's diagonal
// a second on average (so it would take 25 s or more to cross the frame), whatever the easing.
// Linear easing is normal there, and so is a length past the hero band: linear_motion and
// duration_band leave it alone. Only what moves on screen counts: a layer far bigger than the
// frame is measured at the corners of the frame it fills, not at its own corners off screen. A
// full-frame 1.0 -> 1.12 push over 3 s moves its corners about 2% a second; a 1.0 -> 1.2 push
// over 2 s, 5%. A text that enters, or a small layer that moves, stops dead with linear easing.
export const SLOW_PUSH = { seconds: 2, speed: 0.04, cover: 0.5 };
const onScreen = (model, box) => ({ x0: Math.max(0, box.x0), y0: Math.max(0, box.y0), x1: Math.min(model.width, box.x1), y1: Math.min(model.height, box.y1) });
const CORNERS = [["x0", "y0"], ["x1", "y0"], ["x0", "y1"], ["x1", "y1"]];
export function isSlowPush(model, item, tween) {
  if (tween.kind === "in" || tween.kind === "out" || item.kind === "text") return false;
  if (tween.duration < SLOW_PUSH.seconds - 0.5 / model.fps || !movesPlace(tween) || tween.keys.includes("rotation")) return false;
  const [first, last] = [frameAt(model, tween.start), frameAt(model, tween.end)];
  const frame = model.width * model.height;
  const covers = (index) => area(onScreen(model, boxAt(item, index))) / frame >= SLOW_PUSH.cover - 1e-9;
  if (item.role !== "background" && !(covers(first) && covers(last))) return false;
  const travelled = [0, 0, 0, 0];
  for (let index = first + 1; index <= last; index += 1) {
    const [a, b] = [boxAt(item, index - 1), boxAt(item, index)];
    const [width, height] = [a.x1 - a.x0, a.y1 - a.y0];
    const seen = onScreen(model, a);
    if (!(width > 0 && height > 0) || seen.x1 <= seen.x0 || seen.y1 <= seen.y0) continue;
    // Where the point of the layer under each corner of its part on screen is one sample later
    // (the box moves and scales, so each point keeps its place in the box).
    const [scaleX, scaleY] = [(b.x1 - b.x0) / width, (b.y1 - b.y0) / height];
    CORNERS.forEach(([x, y], corner) => {
      const [px, py] = [seen[x], seen[y]];
      travelled[corner] += Math.hypot(b.x0 + (px - a.x0) * scaleX - px, b.y0 + (py - a.y0) * scaleY - py);
    });
  }
  return Math.max(...travelled) / tween.duration <= SLOW_PUSH.speed * Math.hypot(model.width, model.height);
}

// An ambient drift: background lines or light that creep across the frame for seconds (a field of
// streaks or links drifting 50 px over 3 s). A move of 2 s or longer that is not an entrance or exit,
// by position and scale only, of a layer that is not text and is line art (stroke only, no fill) or
// blended as light (any blend but normal), in which no corner travels more than 3% of the frame's
// WIDTH a second on average (so it would take 33 s to cross the frame). Linear easing is fine there:
// the eye reads a constant creep as air, not as a mechanical slide.
// Numbers: the streak-field study drifted its link lines 50 px over 3 s on a 1920 px frame
// (0.9% of the width a second) and the cutout-composite study climbed a figure 76 px over 3 s
// (1.3%); 3% gives both more than twice the room. The limit and the 2 s are guesses beyond those.
// A filled card (normal blend) that drifts, or any fast move, still has to ease.
export const AMBIENT_DRIFT = { seconds: 2, speed: 0.03 };
export function isAmbientDrift(model, item, tween) {
  if (tween.kind === "in" || tween.kind === "out" || item.kind === "text") return false;
  if (tween.duration < AMBIENT_DRIFT.seconds - 0.5 / model.fps || !movesPlace(tween) || tween.keys.includes("rotation")) return false;
  const light = (item.blendMode ?? "normal") !== "normal";
  const lines = item.fill == null && item.stroke != null;
  if (!light && !lines) return false;
  const [first, last] = [frameAt(model, tween.start), frameAt(model, tween.end)];
  const traveled = [0, 0, 0, 0];
  for (let index = first + 1; index <= last; index += 1) {
    const [a, b] = [boxAt(item, index - 1), boxAt(item, index)];
    [["x0", "y0"], ["x1", "y0"], ["x0", "y1"], ["x1", "y1"]].forEach(([x, y], corner) => { traveled[corner] += Math.hypot(b[x] - a[x], b[y] - a[y]); });
  }
  return Math.max(...traveled) / tween.duration <= AMBIENT_DRIFT.speed * model.width;
}

/**
 * A hold drift: the slow move a layer of any size (text too) makes while it holds, so the frame
 * does not stand still (held_static, and its automatic fix): not an entrance or exit, 1.2 s or
 * longer, by position, scale or letter spacing only, with no corner travelling faster than a slow
 * push (4% of the frame's diagonal a second). duration_band and transitions_dense leave it alone.
 */
export function isHoldDrift(model, item, tween) {
  if (tween.kind === "in" || tween.kind === "out" || tween.duration < 1.2 - 0.5 / model.fps) return false;
  if (!tween.keys.length || tween.keys.some((key) => !HOLD_KEYS.has(key))) return false;
  const [first, last] = [frameAt(model, tween.start), frameAt(model, tween.end)];
  let fastest = 0;
  for (let index = first + 1; index <= last; index += 1) {
    const [a, b] = [boxAt(item, index - 1), boxAt(item, index)];
    fastest = Math.max(fastest, Math.abs(b.x0 - a.x0), Math.abs(b.y0 - a.y0), Math.abs(b.x1 - a.x1), Math.abs(b.y1 - a.y1));
  }
  // The fastest a corner moves in one sample, against the slow push's average speed (an eased
  // drift peaks at about 1.6 times its average, so it is allowed twice the average here).
  return fastest * model.fps <= 2 * SLOW_PUSH.speed * Math.hypot(model.width, model.height);
}
const HOLD_KEYS = new Set(["x", "y", "scaleX", "scaleY", "letterSpacing"]);
export const isHoldMotion = (model, item, motion) => motion.tweens.every((tween) => isHoldDrift(model, item, tween));

/**
 * A push that runs out with its layer: a slow move (no corner faster than a hold drift, text too)
 * that is not an entrance or exit and still runs when the layer leaves: by the frame after it ends
 * the layer is gone (a cut, a hide, a fade to nothing) or the scene ends. Linear easing looks
 * mechanical where a move starts or stops on screen; this one never stops on screen, so it may be
 * linear at any length. Evidence: a product film's 1% push cut off after 0.84 s and a trailer's 9%
 * type push over 2.6 s that ends as the type fades out were both flagged
 * (.scratch/recreate/GAPS.md, Friction 2; film-trailer and product-film result.md).
 */
export function isRunOutPush(model, item, tween) {
  if (tween.kind === "in" || tween.kind === "out" || !movesPlace(tween) || tween.keys.includes("rotation")) return false;
  const last = frameAt(model, tween.end);
  const after = Math.min(model.times.length - 1, last + 1);
  const gone = last >= model.times.length - 1 || tween.end >= model.duration - 1 / model.fps || (item.samples.opacity[after] ?? 0) < 0.05;
  if (!gone) return false;
  const first = frameAt(model, tween.start);
  let fastest = 0;
  for (let index = first + 1; index <= last; index += 1) {
    const [a, b] = [boxAt(item, index - 1), boxAt(item, index)];
    fastest = Math.max(fastest, Math.abs(b.x0 - a.x0), Math.abs(b.y0 - a.y0), Math.abs(b.x1 - a.x1), Math.abs(b.y1 - a.y1));
  }
  // A linear move keeps one speed, so its fastest step is its average: held to the slow push's
  // average (4% of the diagonal a second), not the hold drift's eased-peak allowance of twice that.
  // Both benchmark pushes sit far under it (about 1% a second).
  return fastest * model.fps <= SLOW_PUSH.speed * Math.hypot(model.width, model.height);
}

// Motions the timing rules judge: not loops, masks, counters or instant changes, and not the
// voice's captions (speechTimed: a phrase shows when it is said, every phrase alike on purpose).
function judgedMotions(model) {
  const timed = speechTimed(model);
  return motions(model).filter((motion) => {
    const item = itemById(model, motion.itemId);
    return item && !item.isMask && !isPerpetual(model, item) && motion.duration > 0 && !timed.has(item.id)
      && motion.tweens.every((tween) => !tween.discrete);
  });
}

export function linearMotion(model, ctx) {
  const findings = [];
  for (const tween of model.tweens) {
    const item = itemById(model, tween.itemId);
    if (!item || neverShown(item) || !tween.linear || tween.duration <= 0 || tween.discrete || tween.counter || !movesPlace(tween)) continue;
    // A scene's drawn drift camera (engine/camera.js) is a steady slow move on purpose, even over a short hold.
    if (item.sceneCamera || isPerpetual(model, item) || isSlowPush(model, item, tween) || isAmbientDrift(model, item, tween) || isRunOutPush(model, item, tween)) continue;
    const easing = "smooth";
    findings.push({
      rule: "linear_motion", severity: tween.duration * model.fps <= 2 ? "info" : "error", itemId: item.id, tweenId: tween.id,
      at: sec(tween.start), until: sec(tween.end), measured: "linear", required: "eased",
      message: `${ctx.name(item)} moves at a constant speed (linear easing) in "${tween.name}", which looks mechanical.`,
      fix: { kind: "tween", tweenId: tween.id, itemId: item.id, properties: { easing }, auto: true, why: `uses ${easing}; mark the layer perpetual if it loops on purpose` },
    });
  }
  return findings;
}

export function springOnFade(model, ctx) {
  const findings = [];
  for (const tween of model.tweens) {
    const item = itemById(model, tween.itemId);
    if (!item || neverShown(item) || tween.duration <= 0 || tween.discrete) continue;
    const fades = tween.keys.some((key) => key === "opacity" || key === "reveal") && tween.wobbles;
    const colors = tween.keys.some((key) => COLOR_KEYS.has(key)) && tween.overshoots;
    if (!fades && !colors) continue;
    const onlyFade = tween.keys.every((key) => FADE_KEYS.has(key));
    findings.push({
      rule: "spring_on_fade", severity: "error", itemId: item.id, tweenId: tween.id, at: sec(tween.start), until: sec(tween.end),
      measured: easingKey(tween.easing), required: "no bounce on opacity or colour",
      message: `${ctx.name(item)} ${fades ? "flickers" : "shoots past its colour"}: "${tween.name}" uses ${easingKey(tween.easing)} easing on ${fades ? "opacity" : "colour"}.`,
      fix: onlyFade
        ? { kind: "tween", tweenId: tween.id, itemId: item.id, properties: { easing: "smooth" }, auto: true }
        : { kind: "hint", text: "Split it: keep the spring on the move or scale, and fade with Smooth easing in a separate animation." },
    });
  }
  return findings;
}

export function sameMotion(model, ctx) {
  const list = judgedMotions(model);
  const animated = new Set(list.map((motion) => motion.itemId));
  if (animated.size < 4) return [];
  const keys = new Set(list.map((motion) => `${easingKey(motion.easing)} ${sec(motion.duration)}`));
  if (keys.size > 1) return [];
  const [first] = list;
  return [{
    rule: "same_motion", severity: "error", at: sec(first.start),
    measured: `${animated.size} layers, all ${easingKey(first.easing)} ${sec(first.duration)}s`, required: "varied timing",
    message: `All ${animated.size} animated layers in ${ctx.sceneName} move with the same easing (${easingKey(first.easing)}) and duration (${sec(first.duration)}s), which reads as machine-made.`,
    fix: { kind: "hint", text: "Give the headline a longer hero timing (0.8–1.2 s), supporting layers a standard one (0.3–0.5 s), and exits the exit easing." },
  }];
}

export function easingRepeat(model, ctx) {
  if (sameMotion(model, ctx).length) return [];
  // Motions that start together with the same timing are one gesture (a section leaving at once).
  const groups = new Map();
  for (const motion of judgedMotions(model)) {
    // Words keep one way of arriving (busy_edit and role_font_drift ask for one type style), and a
    // move's parts (a layer the move made, or its animations) share its timing by design.
    const item = itemById(model, motion.itemId);
    if (item.kind === "text" || item.move || motion.tweens.every((tween) => tween.move)) continue;
    const key = `${easingKey(motion.easing)} ${sec(motion.duration)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(motion);
  }
  const findings = [];
  for (const [key, list] of groups) {
    const starts = [];
    for (const motion of [...list].sort((a, b) => a.start - b.start))
      if (!starts.length || motion.start - starts.at(-1) > 1 / model.fps + 1e-6) starts.push(motion.start);
    const items = [...new Set(list.map((motion) => motion.itemId))];
    if (starts.length <= 2 || items.length <= 2) continue;
    const [easing, duration] = key.split(" ");
    findings.push({
      rule: "easing_repeat", severity: "warn", itemId: items[0], itemIds: items, at: sec(list[0].start),
      measured: starts.length, required: "at most 2",
      message: `${starts.length} separate motions (${items.slice(0, 4).map((id) => ctx.name(itemById(model, id))).join(", ")}${items.length > 4 ? ", …" : ""}) share ${easing} easing and ${duration}s.`,
      fix: { kind: "hint", text: "Vary duration by size and importance, and use a different easing for exits." },
    });
  }
  return findings;
}

export function bouncyLayers(model, ctx) {
  // By name (kino's presets) or by shape: a curve that goes back the way it came (an
  // "elastic.out(1, 0.6)", a custom bounce).
  const bouncy = [...new Set(model.tweens.filter((tween) => (BOUNCY.has(tween.easing) || tween.wobbles) && movesPlace(tween)).map((tween) => tween.itemId))]
    .map((id) => itemById(model, id)).filter((item) => item && !neverShown(item) && !isPerpetual(model, item));
  if (bouncy.length <= 1) return [];
  return [{
    rule: "bouncy_layers", severity: "warn", itemId: bouncy[1].id, itemIds: bouncy.map((item) => item.id),
    measured: bouncy.length, required: "at most 1",
    message: `${bouncy.length} layers bounce or wobble (${bouncy.slice(0, 4).map((item) => ctx.name(item)).join(", ")}); one is a wink, more looks like confetti.`,
    fix: { kind: "hint", text: "Keep bounce or elastic easing on the one layer that matters most; ease the rest with ease-out." },
  }];
}

/**
 * The duration band a motion should be in (§4.5 motion tokens): text by its drawn size, other
 * layers by how much of the frame they cover; logos may take a standard or a hero timing.
 */
export function bandOf(model, item, motion) {
  const HERO = { name: "hero", min: 0.5, max: 2 };
  const STANDARD = { name: "standard", min: 0.3, max: 1.1 };
  const MICRO = { name: "micro", min: 0.15, max: 0.5 };
  const unit = motion.tweens.find((tween) => tween.unit && tween.unit !== "layer")?.unit;
  if (unit === "letters") return MICRO;
  if (unit) return STANDARD;
  if (item.role === "logo") return { name: "logo", min: 0.3, max: 2 };
  if (item.role === "hero" || item.role === "background" || item.role === "headline") return HERO;
  if (item.text) return drawnSize(model, item) >= typeLimits(model).headline - 0.5 ? HERO : STANDARD;
  const frame = model.width * model.height;
  let largest = 0;
  for (let index = 0; index < model.times.length; index += 1)
    if (item.samples.opacity[index] > 0.05) largest = Math.max(largest, area(boxAt(item, index)) / frame);
  if (largest >= 0.25) return HERO;
  if (largest >= 0.01) return STANDARD;
  return MICRO;
}

// A downbeat accent marked by its name: "Accent", a scale punch of 0.15 s or less, and "Accent
// settles", the scale back in 0.5 s or less. Anything else by those names is judged as before.
const ACCENT_PUNCH = { Accent: 0.15, "Accent settles": 0.5 };
const isAccentPunch = (tween) => tween.duration <= (ACCENT_PUNCH[tween.name] ?? -1) + 1e-6 &&
  tween.keys.length > 0 && tween.keys.every((key) => key === "scaleX" || key === "scaleY");

// A fade (opacity or color only) moves nothing across the frame, so its pace is not judged by the
// layer's size: a quick fade reads as a soft cut, not as a rushed move. Only a slow one is judged.
// A step under half a frame beside it (a scale set at the start) is no move.
const isFadeOnly = (model, motion) => motion.tweens.filter((tween) => tween.duration > 0.5 / model.fps)
  .every((tween) => tween.keys.length > 0 && tween.keys.every((key) => FADE_KEYS.has(key)));
// A press or pulse: scale only, the layer's box at most 10% bigger or smaller than where it starts
// (a key press, a tap) on a layer smaller than a hero. It is quick on purpose (kino's cursor press
// takes 0.07 s); a full-frame punch that fast is a camera jolt and is judged.
const PRESS_SCALE = 0.1;
function isPress(model, item, motion) {
  if (!motion.tweens.every((tween) => tween.keys.length > 0 && tween.keys.every((key) => key === "scaleX" || key === "scaleY"))) return false;
  const [first, last] = [frameAt(model, motion.start), frameAt(model, motion.end ?? motion.start + motion.duration)];
  const start = boxAt(item, first);
  const width = start.x1 - start.x0;
  if (!(width > 0)) return false;
  for (let index = first; index <= last; index += 1) {
    const box = boxAt(item, index);
    if (Math.abs((box.x1 - box.x0) / width - 1) > PRESS_SCALE + 1e-6) return false;
  }
  return true;
}
// An exit that ends on a hard cut (within a frame) is part of the cut: the next picture takes over.
const endsOnCut = (model, motion) => cuts(model).some((time) => time > 0 && Math.abs(time - (motion.start + motion.duration)) <= 1 / model.fps + 1e-6);

export function durationBand(model, ctx) {
  const findings = [];
  for (const motion of judgedMotions(model)) {
    if (motion.duration > 3 || motion.tweens.some((tween) => tween.counter)) continue;
    // An instant step (a frame cut, under half a frame) is a cut on purpose, not a quick move.
    if (motion.duration <= 0.5 / model.fps) continue;
    // A move (engine/blocks/moves/) is timed as one set piece: a 0.12 s cross-fade inside a push is right.
    if (motion.tweens.every((tween) => tween.move)) continue;
    // A whip (presetCatalog.js) is fast on purpose: the swap hides under its smear.
    if (motion.tweens.every((tween) => tween.preset === "whip")) continue;
    // So is a downbeat accent: a scale punch named Accent and its settle (engine/footage/ops.js).
    if (motion.tweens.every(isAccentPunch)) continue;
    const item = itemById(model, motion.itemId);
    // A slow push is long on purpose (a fade as long as it is judged as before).
    if (motion.tweens.filter((tween) => Math.abs(tween.duration - motion.duration) < 1e-6).every((tween) => isSlowPush(model, item, tween))) continue;
    // So is a drift through a hold.
    if (isHoldMotion(model, item, motion)) continue;
    let band = bandOf(model, item, motion);
    // Exits run at 55–75% of an entrance, so their band is scaled the same way.
    if (motion.kind === "out") band = { name: `${band.name} exit`, min: sec(band.min * 0.55), max: sec(band.max * 0.75) };
    const tolerance = 0.5 / model.fps;
    if (motion.duration >= band.min - tolerance && motion.duration <= band.max + tolerance) continue;
    // Too quick is no problem for a fade, a press, or an exit the cut hides.
    if (motion.duration < band.min && (isFadeOnly(model, motion) || (!band.name.startsWith("hero") && isPress(model, item, motion)) || (motion.kind === "out" && endsOnCut(model, motion)))) continue;
    const target = motion.duration < band.min ? band.min : band.max;
    findings.push({
      rule: "duration_band", severity: "warn", itemId: item.id, tweenId: motion.tweens[0].id, at: sec(motion.start),
      measured: sec(motion.duration), required: `${band.min}–${band.max}s`,
      message: `${ctx.name(item)} takes ${sec(motion.duration)}s to ${motion.kind === "out" ? "leave" : motion.kind === "in" ? "enter" : "move"}; for its size that is ${motion.duration < band.min ? "too quick" : "slow"} (${band.name}: ${band.min}–${band.max}s).`,
      fix: { kind: "tweens", changes: motion.tweens.filter((tween) => Math.abs(tween.duration - motion.duration) < 1e-6).map((tween) => ({ tweenId: tween.id, itemId: item.id, properties: { duration: target } })) },
    });
  }
  return findings;
}

export function exitRatio(model, ctx) {
  const findings = [];
  const list = judgedMotions(model);
  for (const entrance of list.filter((motion) => motion.kind === "in")) {
    const exit = list.find((motion) => motion.itemId === entrance.itemId && motion.kind === "out" && motion.start >= entrance.start);
    if (!exit) continue;
    if ([...entrance.tweens, ...exit.tweens].every((tween) => tween.move)) continue;
    const ratio = exit.duration / entrance.duration;
    if (ratio >= 0.53 && ratio <= 0.77) continue;
    const item = itemById(model, entrance.itemId);
    // 65% of the entrance, kept inside the exit's duration band (duration_band) and the ratio.
    const band = bandOf(model, item, exit);
    const target = sec(Math.min(entrance.duration * 0.77, Math.max(entrance.duration * 0.65, sec(band.min * 0.55)), Math.max(entrance.duration * 0.53, sec(band.max * 0.75))));
    // The exit keeps its end (so a shorter one does not leave early), within the section and the scene.
    const sectionEnd = cuts(model).find((time) => time > exit.start + 1e-6) ?? model.duration;
    const end = Math.min(exit.end, sectionEnd, model.duration);
    const start = sec(Math.max(entrance.start + entrance.duration, end - target));
    const scale = (end - start) / exit.duration;
    // An exit that starts before the entrance (a long drift) ends has no room to keep its end:
    // the scaled durations came out 0 or below and every auto fix was refused, so it is a hint.
    const room = exit.tweens.every((tween) => sec(tween.duration * scale) >= 0.01);
    findings.push({
      rule: "exit_ratio", severity: "warn", itemId: item.id, tweenId: exit.tweens[0].id, at: sec(exit.start),
      measured: `${Math.round(ratio * 100)}%`, required: "55–75% of the entrance",
      message: `${ctx.name(item)} leaves in ${sec(exit.duration)}s after entering in ${sec(entrance.duration)}s (${Math.round(ratio * 100)}%); exits read best at 55–75% of the entrance.`,
      fix: room ? { kind: "tweens", auto: true, changes: exit.tweens.map((tween) => ({ tweenId: tween.id, itemId: item.id,
        properties: { start: sec(start + (tween.start - exit.start) * scale), duration: sec(tween.duration * scale) } })) }
        : { kind: "hint", text: `${ctx.name(item)}'s exit starts before its entrance ends (${sec(entrance.start + entrance.duration)}s): end the entrance sooner, or leave it if the overlap is designed.` },
    });
  }
  return findings;
}

// Layers that enter one after another at an even gap form a stagger group.
function layerStaggers(model) {
  const list = entrances(model).filter((motion) => !itemById(model, motion.itemId)?.isMask).sort((a, b) => a.start - b.start);
  const groups = [];
  const used = new Set();
  for (let first = 0; first < list.length; first += 1) {
    if (used.has(first)) continue;
    const group = [list[first]];
    for (let next = first + 1; next < list.length; next += 1) {
      const candidate = list[next];
      const last = group.at(-1);
      const gap = candidate.start - last.start;
      const step = group.length > 1 ? group[1].start - group[0].start : gap;
      if (gap <= 1e-6 || gap > 0.4 + 1e-6 || Math.abs(gap - step) > 1 / model.fps + 1e-6) continue;
      if (easingKey(candidate.easing) !== easingKey(last.easing) || Math.abs(candidate.duration - last.duration) > 1e-6) continue;
      group.push(candidate);
      used.add(next);
    }
    if (group.length >= 3) groups.push(group);
  }
  return groups;
}

// Text typed out letter by letter (or word by word) at reading pace, when the style spec backs
// type-letters (type-words): the designed typing, not a slow stagger. Its auto fix sped the
// typing up and the agent spent calls putting it back.
const TYPED = { letters: "type-letters", words: "type-words" };

// A reveal is paced by the voice or the music when 75% of its starts (a word reveal's words, or
// each layer of a one-layer-per-word group) land on a speech word, a named cue or a beat cue
// (within one frame): the long spread is the pacing, not a slow stagger. Only real marks count:
// no onset cues (a busy track has one every 0.1 s) and no made-up beat grid, so a dense grid
// cannot excuse a slow reveal by chance.
const PACED_SHARE = 0.75;

function pacedByAudio(ctx, times) {
  if (times.length < 2) return false;
  const near = 1 / (ctx.outputFps ?? 30) + 1e-3;
  const marks = [...(ctx.cues ?? []), ...(ctx.beatCues ?? []).filter((cue) => cue.kind !== "onset")].map((cue) => cue.time).filter(Number.isFinite);
  for (const edge of heardEdges(ctx)) if (edge.words?.length) for (const word of heardWords(edge)) marks.push(word.start);
  const landed = times.filter((time) => marks.some((mark) => Math.abs(mark - time) <= near)).length;
  return landed / times.length >= PACED_SHARE;
}

// When each word of a reveal starts: its own delays (words timed to speech), else every stagger.
function wordTimes(tween) {
  if (tween.unit !== "words") return [];
  if (tween.delays?.length) return tween.delays.map((delay) => tween.start + delay);
  const count = Math.round(tween.spread / tween.stagger) + 1;
  return count >= 2 ? Array.from({ length: count }, (_, index) => tween.start + index * tween.stagger) : [];
}

export function staggerLong(model, ctx) {
  const findings = [];
  const typed = (tween) => Boolean(TYPED[tween.unit]) && (ctx.style?.backed ?? []).includes(TYPED[tween.unit]);
  for (const tween of model.tweens) {
    if (!(tween.spread > 0.5 + 1e-6) || !(tween.stagger > 0)) continue;
    if (typed(tween)) { ctx.note?.(`stagger_long leaves ${UNIT_NAME[tween.unit]}-by-${UNIT_NAME[tween.unit]} typing alone: the style spec wants ${TYPED[tween.unit]}.`); continue; }
    if (pacedByAudio(ctx, wordTimes(tween))) { ctx.note?.("stagger_long leaves a word-by-word reveal alone: its words land on speech or beat cues."); continue; }
    const item = itemById(model, tween.itemId);
    if (!item || neverShown(item) || isPerpetual(model, item)) continue;
    findings.push({
      rule: "stagger_long", severity: "warn", itemId: item.id, tweenId: tween.id, at: sec(tween.start),
      measured: sec(tween.spread), required: "≤0.5s",
      message: `${ctx.name(item)}'s ${UNIT_NAME[tween.unit] ?? tween.unit}-by-${UNIT_NAME[tween.unit] ?? tween.unit} "${tween.name}" takes ${sec(tween.spread)}s to reach its last ${UNIT_NAME[tween.unit] ?? tween.unit}; keep a stagger within 0.5s.`,
      fix: { kind: "tween", tweenId: tween.id, itemId: item.id, properties: { stagger: Math.max(0.01, Math.floor((tween.stagger * 0.5) / tween.spread * 1000) / 1000) }, auto: true },
    });
  }
  for (const group of layerStaggers(model)) {
    const spread = group.at(-1).start - group[0].start;
    if (spread <= 0.5 + 1e-6) continue;
    if (pacedByAudio(ctx, group.map((motion) => motion.start))) { ctx.note?.(`stagger_long leaves ${group.length} layers entering one after another alone: they land on speech or beat cues.`); continue; }
    const ids = group.map((motion) => motion.itemId);
    // The same order, at an even gap that ends within 0.5 s (each entrance keeps its own timing).
    const gap = Math.max(0.001, Math.floor((0.5 / (ids.length - 1)) * 1000) / 1000);
    findings.push({
      rule: "stagger_long", severity: "warn", itemId: ids[0], itemIds: ids, at: sec(group[0].start),
      measured: sec(spread), required: "≤0.5s",
      message: `${ids.length} layers (${ids.slice(0, 4).map((id) => ctx.name(itemById(model, id))).join(", ")}) enter one after another over ${sec(spread)}s; keep a stagger within 0.5s.`,
      fix: { kind: "tweens", auto: true, changes: group.flatMap((motion, index) => motion.tweens.map((tween) =>
        ({ tweenId: tween.id, itemId: motion.itemId, properties: { start: Math.round((group[0].start + index * gap + (tween.start - motion.start)) * 1000) / 1000 } }))) },
    });
  }
  return findings;
}

// Only roles the author set count here: guessing the headline could put a large CTA first.
const rankOf = (model, item) => (item.role in ROLE_RANK ? ROLE_RANK[item.role] : null);

export function staggerOrder(model, ctx) {
  const findings = [];
  const sectionStarts = cuts(model);
  const list = entrances(model).map((motion) => ({ motion, item: itemById(model, motion.itemId) }))
    .filter(({ item }) => item && rankOf(model, item) !== null).sort((a, b) => a.motion.start - b.motion.start);
  for (let index = 0; index < list.length; index += 1) {
    const { motion, item } = list[index];
    const cut = sectionStarts.filter((time) => time <= motion.start + 1e-6).at(-1) ?? 0;
    const nextCut = sectionStarts.find((time) => time > motion.start + 1e-6) ?? Infinity;
    const later = list.find((entry) => entry.motion.start > motion.start + 1 / model.fps && entry.motion.start < nextCut && entry.motion.start >= cut
      && rankOf(model, entry.item) < rankOf(model, item));
    if (!later) continue;
    findings.push({
      rule: "stagger_order", severity: "warn", itemId: item.id, at: sec(motion.start),
      measured: `${item.role} before ${later.item.role}`, required: "headline, subhead, body, CTA",
      message: `${ctx.name(item)} (${item.role}) enters before ${ctx.name(later.item)} (${later.item.role}); people read in role order: headline, subhead, body, then CTA.`,
      fix: { kind: "hint", text: `Start ${ctx.name(later.item)} first, or swap their start times.` },
    });
  }
  return findings;
}

export function firstEntrance(model, ctx) {
  const findings = [];
  const timed = speechTimed(model);
  for (const { cut, motion: first, delay } of firstEntrances(model)) {
    if (timed.has(first.itemId)) continue;
    const index = frameAt(model, cut);
    if (primaryItems(model).some((item) => item.samples.opacity[index] >= 0.5)) continue;
    if (goodEntranceDelay(model, delay)) continue;
    // A move times its own parts (captions start when the word is said).
    if (first.tweens.every((tween) => tween.move)) continue;
    const item = itemById(model, first.itemId);
    const target = sec(cut + 0.2);
    const shift = target - first.start;
    // Moved later, the first entrance takes the ones right behind it along (a stagger keeps its order).
    const moved = [first];
    if (shift > 0) {
      const nextCut = cuts(model).find((time) => time > cut + 1e-6) ?? Infinity;
      for (const motion of [...entrances(model)].sort((a, b) => a.start - b.start)) {
        if (motion === first || motion.start < first.start - 1e-6 || motion.start >= nextCut) continue;
        if (motion.start > moved.at(-1).start + shift + 1e-6) break;
        moved.push(motion);
      }
    }
    // A late entrance is never pulled earlier by the fix: moving it would show the layer before its
    // own beat, over a shot it was not made for (study c/result.md 6: a word moved from 2.12 s to 0 s).
    findings.push({
      rule: "first_entrance", severity: "warn", itemId: item.id, at: sec(first.start),
      measured: sec(delay), required: "0.1–0.3s after the cut",
      message: `The first entrance after ${cut ? `the cut at ${sec(cut)}s` : "the start"} (${ctx.name(item)}) begins ${delay < 0.1 ? "at once" : `${sec(delay)}s later`}; give the eye 0.1–0.3s.`,
      fix: shift < 0
        ? { kind: "hint", text: `Keep it when ${ctx.name(item)} enters on its own beat; else start something 0.1-0.3 s after the cut (${sec(cut + 0.2)} s).` }
        : { kind: "tweens", auto: true, changes: moved.flatMap((motion) => motion.tweens.map((tween) => ({ tweenId: tween.id, itemId: motion.itemId, properties: { start: sec(tween.start + shift) } }))) },
    });
  }
  return findings;
}

// speed_jump: where one move hands off to the next (the second starts as the first ends), the
// on-screen speed carries on. On-screen motion has three parts, all in px: the center (x, y),
// the size (how far a corner is from the center: the drawn scale times half the layer's
// diagonal) and the turn (the rotation times that distance: how far a corner travels). Two moves
// are judged on the parts both animate.
const JOIN_GROUPS = { place: ["x", "y"], size: ["scaleX", "scaleY"], turn: ["rotation"] };
const GROUP_PARTS = { place: [0, 1], size: [2], turn: [3] };
const JUMP_LIMIT = 0.05;
const round3 = (value) => Math.round(value * 1000) / 1000;
const wrapAngle = (angle) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
const norm = (vector) => Math.hypot(...vector);
const masked = (vector, mask) => vector.map((value, part) => (mask[part] ? value : 0));

// Half the layer's own diagonal (before scale), in px.
function radiusOf(item, index) {
  const own = Math.hypot(item.restWidth || 0, item.restHeight || 0) / 2;
  if (own > 0) return own;
  const { x0, y0, x1, y1, scale } = item.samples;
  return Math.hypot(x1[index] - x0[index], y1[index] - y0[index]) / 2 / (scale[index] || 1);
}

// How far each part moves on screen from sample `a` to sample `b`: [x, y, size, turn] in px.
function partsChange(item, a, b, radius) {
  const { x0, y0, x1, y1, scale, turn } = item.samples;
  return [(x0[b] + x1[b] - x0[a] - x1[a]) / 2, (y0[b] + y1[b] - y0[a] - y1[a]) / 2,
    (scale[b] - scale[a]) * radius, turn ? wrapAngle(turn[b] - turn[a]) * radius * scale[b] : 0];
}

// On-screen velocity at sample `index` from the samples on one side, in px a second: a
// second-order one-sided difference, so smooth motion is not mistaken for a jump.
function partsVelocity(model, item, index, side, radius) {
  const step = side === "before" ? -1 : 1;
  if (index + 2 * step < 0 || index + 2 * step >= model.times.length) return null;
  const near = partsChange(item, index, index + step, radius);
  const far = partsChange(item, index, index + 2 * step, radius);
  return near.map((value, part) => (step * (4 * value - far[part]) * model.fps) / 2);
}

// What a tween moves on screen over its time: the net change of each part, and the distance
// each group of parts travels.
function tweenTravel(model, item, tween, radius) {
  const net = [0, 0, 0, 0];
  const path = { place: 0, size: 0, turn: 0 };
  for (let index = frameAt(model, tween.start); index < frameAt(model, tween.end); index += 1) {
    const change = partsChange(item, index, index + 1, radius);
    change.forEach((value, part) => { net[part] += value; });
    for (const [group, parts] of Object.entries(GROUP_PARTS)) path[group] += norm(parts.map((part) => change[part]));
  }
  return { net, path };
}

export function speedJump(model, ctx) {
  const findings = [];
  const frame = 0.5 / model.fps;
  for (const item of model.items) {
    if (item.isMask || neverShown(item) || isPerpetual(model, item)) continue;
    const tweens = tweensOf(model, item.id);
    // An instant set (no length) is a jump on purpose, not a speed change, and so is a join
    // where one happens.
    const instant = tweens.filter((tween) => tween.end - tween.start <= frame);
    const radius = radiusOf(item, frameAt(model, tweens[0]?.start ?? 0));
    const travel = new Map(tweens.map((tween) => [tween, tweenTravel(model, item, tween, radius)]));
    const pairs = new Map();
    for (const [group, keys] of Object.entries(JOIN_GROUPS)) {
      const touches = (tween) => tween.keys.some((key) => keys.includes(key));
      // A tween that leaves these parts still (a hold) is not a move: stopping before it is deliberate.
      const moves = tweens.filter((tween) => touches(tween) && !instant.includes(tween) && travel.get(tween).path[group] > 1)
        .sort((a, b) => a.start - b.start);
      for (let index = 1; index < moves.length; index += 1) {
        const [before, after] = [moves[index - 1], moves[index]];
        // A carry taking over a moving layer is a hand-off on purpose; a move after a carry is still judged.
        if (Math.abs(after.start - before.end) > frame || after.spread || before.spread || after.handoff) continue;
        if (instant.some((tween) => touches(tween) && Math.abs(tween.start - after.start) <= frame)) continue;
        const key = `${before.id} ${after.id}`;
        if (!pairs.has(key)) pairs.set(key, { before, after, mask: [0, 0, 0, 0] });
        for (const part of GROUP_PARTS[group]) pairs.get(key).mask[part] = 1;
      }
    }
    const joins = [];
    for (const join of pairs.values()) {
      const at = frameAt(model, join.after.start);
      const into = partsVelocity(model, item, at, "before", radius);
      const out = partsVelocity(model, item, at, "after", radius);
      if (!into || !out) continue;
      join.into = masked(into, join.mask);
      join.out = masked(out, join.mask);
      join.fastest = Math.max(norm(join.into), norm(join.out));
      // Coming to rest and starting again is not a jump.
      if (join.fastest < 0.02 * model.width) continue;
      join.change = norm(join.out.map((value, part) => value - join.into[part])) / join.fastest;
      joins.push(join);
    }
    const jumps = joins.filter((join) => join.change > JUMP_LIMIT);
    if (!jumps.length) continue;
    const [first] = jumps;
    const percent = Math.round(first.change * 100);
    const changes = smoothedJoins(joins, travel);
    findings.push({
      rule: "speed_jump", severity: "warn", itemId: item.id, tweenId: first.after.id, at: sec(first.after.start),
      measured: `${percent}%`, required: "≤5%",
      message: `${ctx.name(item)} changes speed by ${percent}% where "${first.before.name}" flows into "${first.after.name}"${jumps.length > 1 ? ` (and ${jumps.length - 1} more joins)` : ""}.`,
      fix: changes ? { kind: "tweens", auto: true, changes }
        : { kind: "hint", text: "Match the speeds at the join: ease both moves the same way, or make them one move." },
    });
  }
  return findings;
}

/**
 * The fix for a layer's jumpy joins as tween changes, or null when it cannot be made safely.
 * Where two moves go on the same way, the hand-off is roved ("rove across time"):
 * their time is shared out by distance so the speed at the join is the same on both sides.
 * Where the move turns a corner, or one side is at rest, both sides ease to rest at the
 * join. Every move keeps its values, and the pair keeps its start and end time. Each changed
 * move gets a curve that speeds up or slows down evenly from its kept end to the join's speed.
 */
function smoothedJoins(joins, travel) {
  const state = new Map();
  const stateOf = (tween) => {
    if (!state.has(tween.id)) state.set(tween.id, { tween, start: tween.start, end: tween.end, startSlope: null, endSlope: null });
    return state.get(tween.id);
  };
  // The slope (speed over the move's average speed) asked at one end; false when another join
  // asked that end for a different one.
  const slope = (entry, side, value) => {
    const key = `${side}Slope`;
    if (entry[key] != null && Math.abs(entry[key] - value) > 1e-6) return false;
    entry[key] = value;
    return true;
  };
  const curveOf = (tween) => { try { return easingBezier(tween.easing, tween.intensity ?? 50); } catch { return null; } };
  for (const join of [...joins].sort((a, b) => a.after.start - b.after.start)) {
    if (join.change <= JUMP_LIMIT) continue;
    const [a, b] = [travel.get(join.before).net, travel.get(join.after).net].map((net) => masked(net, join.mask));
    const moving = [norm(join.into), norm(join.out)].map((speed) => speed >= 0.1 * join.fastest);
    const cosine = a.reduce((sum, value, part) => sum + value * b[part], 0) / (norm(a) * norm(b) || 1);
    if (!moving[0] || !moving[1] || cosine < 0.9) {
      // A corner, a stop or a start: both sides ease to rest at the join (a slow side left
      // moving would jump from the other's stop).
      if (!slope(stateOf(join.before), "end", 0) || !slope(stateOf(join.after), "start", 0)) return null;
      continue;
    }
    // The same way on: rove the pair. Each side's speed at the join is set from its kept end
    // (from rest it ends twice as fast as its average, already moving once), and the pair's
    // time is shared so both reach the same speed.
    const { before, after } = join;
    const [first, second] = [curveOf(before), curveOf(after)];
    // A move already retimed by another join, or with this end already set, is left alone.
    const [setA, setB] = [state.get(before.id), state.get(after.id)];
    const retimed = (entry) => entry && (entry.start !== entry.tween.start || entry.end !== entry.tween.end);
    if (!first || !second || setA?.endSlope != null || setB?.startSlope != null) return null;
    const [lengthA, lengthB] = [norm(a), norm(b)];
    // Retiming a move changes its speed at its other end: a smooth join there (a run of 3 or
    // more moves), or a move another join retimed, keeps its times instead. The join gets one
    // speed, the pair's travel over the pair's time, as an auto-Bezier key does (ported from
    // ArtCraft EffectCraft, effectcraft/crates/keyframe/src/lib.rs `effective_ease`:
    // speed = (v[i+1] - v[i-1]) / (t[i+1] - t[i-1])). Each side's other end keeps its slope.
    if (retimed(setA) || retimed(setB) || joins.some((other) => other.change <= JUMP_LIMIT && (other.after === before || other.before === after))) {
      const [entryA, entryB] = [stateOf(before), stateOf(after)];
      const [timeA, timeB] = [entryA.end - entryA.start, entryB.end - entryB.start];
      const speed = (lengthA + lengthB) / (timeA + timeB);
      if (!slope(entryA, "end", (speed * timeA) / lengthA) || !slope(entryB, "start", (speed * timeB) / lengthB)) return null;
      continue;
    }
    const even = (slopeAtOtherEnd) => Math.min(2, Math.max(1, 2 - slopeAtOtherEnd));
    const want = [even(setA?.startSlope ?? startSlope(first)), even(setB?.endSlope ?? endSlope(second))];
    const total = after.end - before.start;
    const least = [Math.min(before.duration, 0.1), Math.min(after.duration, 0.1)];
    const share = (total * want[0] * lengthA) / (want[0] * lengthA + want[1] * lengthB);
    const timeA = round3(Math.min(total - least[1], Math.max(least[0], share)));
    const [averageA, averageB] = [lengthA / timeA, lengthB / (total - timeA)];
    const speed = (want[0] * averageA + want[1] * averageB) / 2;
    Object.assign(stateOf(before), { end: round3(before.start + timeA), endSlope: speed / averageA });
    Object.assign(stateOf(after), { start: round3(before.start + timeA), startSlope: speed / averageB });
  }
  const changes = [];
  for (const entry of state.values()) {
    const { tween } = entry;
    const curve = curveOf(tween);
    if (!curve || tween.spread) return null;
    const [from, to] = [entry.startSlope ?? startSlope(curve), entry.endSlope ?? endSlope(curve)];
    const eased = evenCurve(from, to) ?? influenceCurve(from, to);
    if (!eased) return null;
    const properties = { easing: eased };
    if (Math.abs(entry.start - tween.start) > 1e-6) properties.start = entry.start;
    if (Math.abs(entry.end - entry.start - tween.duration) > 1e-6) properties.duration = round3(entry.end - entry.start);
    changes.push({ tweenId: tween.id, itemId: tween.itemId, properties });
  }
  return changes.length ? changes : null;
}

// The slope of a cubic bezier easing at its start and at its end.
const startSlope = ([x1, y1, x2, y2]) => (x1 > 1e-3 ? y1 / x1 : x2 > 1e-3 ? y2 / x2 : 1);
const endSlope = ([x1, y1, x2, y2]) => (1 - x2 > 1e-3 ? (1 - y2) / (1 - x2) : 1 - x1 > 1e-3 ? (1 - y1) / (1 - x1) : 1);

// The cubic bezier easing with these slopes at its ends whose speed changes most evenly between
// them (handles a third of the way in: a Hermite curve). Null when it would go back on itself.
function evenCurve(from, to) {
  // Its speed is a quadratic in time: s0 + (6 - 4 s0 - 2 s1) t + (3 s0 + 3 s1 - 6) t^2.
  const [c, b, a] = [from, 6 - 4 * from - 2 * to, 3 * from + 3 * to - 6];
  const lowest = Math.min(c, a + b + c, a > 0 && -b / (2 * a) > 0 && -b / (2 * a) < 1 ? c - (b * b) / (4 * a) : Infinity);
  if (lowest < -1e-9 || from > 30 || to > 30) return null;
  return [1 / 3, from / 3, 2 / 3, 1 - to / 3].map(round3);
}

// The curve with these end slopes when the even one would go back on itself (a short fast move
// between slow ones): each handle's reach (influence) is shortened until it stays inside the move.
// Ported from ArtCraft EffectCraft, effectcraft/crates/keyframe/src/lib.rs `ease_progress`: a
// side with normalized speed s and influence i has its handle at (i, s · i) from its end; the time
// handles may cross, which kino's cubic solver (engine/easing.js cubicBezierAt, like EffectCraft's
// `solve_u`: Newton steps, then bisection) handles. Null when no influence keeps it going forward.
function influenceCurve(from, to) {
  if (!(from >= 0 && to >= 0) || from > 30 || to > 30) return null;
  const reach = (slope) => Math.min(1 / 3, 0.9 / Math.max(slope, 1e-9));
  const [inFrom, inTo] = [reach(from), reach(to)];
  const curve = [inFrom, from * inFrom, 1 - inTo, 1 - to * inTo].map(round3);
  // It goes forward when its value never falls: the derivative of y over u stays at or above 0.
  const [, y1, , y2] = curve;
  for (let step = 0; step <= 20; step += 1) {
    const u = step / 20;
    if (3 * (1 - u) ** 2 * y1 + 6 * (1 - u) * u * (y2 - y1) + 3 * u * u * (1 - y2) < -1e-9) return null;
  }
  return curve;
}

// judder: a large layer (JUDDER_AREA of the frame or more) panning with no motion blur strobes at
// 30 fps or less. RED's guide for a 180 degree shutter is a frame width every 7 s (JUDDER_SLOW a
// second); graphics drawn with no blur are a 0 degree shutter, so they strobe sooner, and past
// JUDDER_FAST they judder outright. Blur counts when it is 2 px or more, or half of what a 180
// degree shutter gives at that speed (less for a slow pan).
const JUDDER_SLOW = 0.14;
const JUDDER_FAST = 0.5;
const JUDDER_AREA = 0.2;
// A directional blur of length L reads as a blur of L / sqrt(12) (kinoTimeline.js SMEAR_TO_BLUR).
const SMEAR_TO_BLUR = 1 / Math.sqrt(12);

// A whip preset (presetCatalog.js) is smeared along its path while it runs, for WHIP_SHUTTER of its
// travel (previewBlur.js), on the layer and every layer it carries.
function whipping(model, item, time) {
  return chainOf(model, item).some((entry) => tweensOf(model, entry.id).some((tween) => tween.preset === "whip"
    && time >= tween.start - WHIP_SHUTTER && time <= tween.end + WHIP_SHUTTER));
}

// The item's center velocity at sample `at` (from the sample before), in px a second.
function stepVelocity(model, item, at) {
  const box = boxAt(item, at), prev = boxAt(item, Math.max(0, at - 1));
  return [((box.x0 + box.x1) - (prev.x0 + prev.x1)) / 2 * model.fps, ((box.y0 + box.y1) - (prev.y0 + prev.y1)) / 2 * model.fps];
}

export function judder(model, ctx) {
  const outputFps = ctx.outputFps ?? 30;
  if (outputFps > 30) return [];
  const frame = model.width * model.height;
  // The fast stretches of each layer, given to the outermost group it rides with (a card moved by
  // its group): the group is blurred once instead of each layer in it.
  const stretches = new Map();
  for (const item of model.items) {
    if (item.isMask || isPerpetual(model, item) || item.kind === "group") continue;
    let streak = 0;
    let from = -1;
    for (let index = 1; index <= model.times.length; index += 1) {
      const at = Math.min(index, model.times.length - 1);
      const pixels = Math.hypot(...stepVelocity(model, item, at));
      const shutter = pixels / 2 / outputFps;
      const smear = whipping(model, item, model.times[at]) ? pixels * WHIP_SHUTTER * SMEAR_TO_BLUR : 0;
      const fast = index < model.times.length && item.samples.opacity[at] >= 0.5 && area(boxAt(item, at)) / frame >= JUDDER_AREA
        && pixels / model.width >= JUDDER_SLOW && item.samples.blur[at] + smear < Math.min(2, 0.5 * shutter * SMEAR_TO_BLUR);
      if (fast) { if (from < 0) from = at; streak += 1; continue; }
      if (streak >= 4) {
        const owner = carrierOf(model, item, from, from + streak - 1);
        const entry = stretches.get(owner.id) ?? { owner, rider: item, spans: [] };
        entry.spans.push([from, from + streak - 1]);
        stretches.set(owner.id, entry);
      }
      streak = 0;
      from = -1;
    }
  }
  const findings = [];
  for (const { owner, rider, spans } of stretches.values()) {
    // Riders' stretches that overlap or touch are one stretch of the group.
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    for (const [first, last] of merged) findings.push(judderFinding(model, ctx, owner, first, last, outputFps, rider));
  }
  return findings;
}

// The outermost group that carries the item's move from sample first to last: one whose shown
// layers all move the same way as it at every sample (within 5%), so they only ride along and one
// blur on the group fits each of them. The item itself when none.
function carrierOf(model, item, first, last) {
  let owner = item;
  for (let parent = itemById(model, item.parentId); parent?.kind === "group"; parent = itemById(model, parent.parentId)) {
    const inside = model.items.filter((entry) => entry !== parent && chainOf(model, entry).includes(parent));
    let rides = true;
    for (let at = first; at <= last && rides; at += 1) {
      const [gx, gy] = stepVelocity(model, parent, at);
      rides = inside.every((entry) => {
        if (!(entry.samples.opacity[at] > 0)) return true;
        const [vx, vy] = stepVelocity(model, entry, at);
        return Math.hypot(vx - gx, vy - gy) <= 0.05 * Math.hypot(gx, gy) + 1;
      });
    }
    if (!rides) break;
    owner = parent;
  }
  return owner;
}

// The finding for a fast stretch (samples first to last) of the item, or of the group that
// carries `rider` there. Its fix is motion blur: a directional blur along the move as long as a
// 180 degree shutter at each moment (the usual default), from 0 just before the stretch back
// to 0 just after it, so only the fast part blurs. Keys go where the blur changes: the stretch's
// ends and fastest sample, then wherever a straight line between keys misses the shutter blur by
// more than JUDDER_LENGTH_SLACK of the peak (2 px at least) or JUDDER_ANGLE_SLACK degrees, up to
// JUDDER_MAX_KEYS keys, however long the stretch.
const JUDDER_MAX_KEYS = 8;
const JUDDER_LENGTH_SLACK = 0.1;
const JUDDER_ANGLE_SLACK = 5;
function judderFinding(model, ctx, item, first, last, outputFps, rider = item) {
  const speedAt = (at) => Math.hypot(...stepVelocity(model, item, at));
  let peak = first;
  for (let at = first; at <= last; at += 1) if (speedAt(at) > speedAt(peak)) peak = at;
  const speed = speedAt(peak) / model.width;
  const fast = speed >= JUDDER_FAST;
  // The blur at each sample, in the layer's own pixels and turned with it: {length, angle}.
  const smears = [];
  let lastAngle = null;
  for (let at = first; at <= last; at += 1) {
    const [vx, vy] = stepVelocity(model, item, at);
    const matrix = item.samples.matrix;
    const turn = matrix ? Math.atan2(matrix[at * 6 + 1], matrix[at * 6]) : 0;
    const scale = item.samples.scale?.[at] > 0 ? item.samples.scale[at] : 1;
    let angle = ((Math.atan2(vy, vx) - turn) * 180) / Math.PI;
    if (lastAngle !== null) angle -= 360 * Math.round((angle - lastAngle) / 360);
    lastAngle = angle;
    smears.push({ length: Math.round(Math.hypot(vx, vy) / 2 / outputFps / scale), angle: Math.round(angle) });
  }
  const smearAt = (at) => smears[at - first];
  const keys = [...new Set([first, peak, last])].sort((a, b) => a - b);
  const lengthSlack = Math.max(2, JUDDER_LENGTH_SLACK * smearAt(peak).length);
  while (keys.length < JUDDER_MAX_KEYS) {
    let worst = -1, worstMiss = 1;
    for (let key = 1; key < keys.length; key += 1) {
      const [a, b] = [keys[key - 1], keys[key]];
      for (let at = a + 1; at < b; at += 1) {
        const share = (at - a) / (b - a);
        const line = (field) => smearAt(a)[field] + share * (smearAt(b)[field] - smearAt(a)[field]);
        const miss = Math.max(Math.abs(line("length") - smearAt(at).length) / lengthSlack, Math.abs(line("angle") - smearAt(at).angle) / JUDDER_ANGLE_SLACK);
        if (miss > worstMiss) { worst = at; worstMiss = miss; }
      }
    }
    if (worst < 0) break;
    keys.push(worst);
    keys.sort((a, b) => a - b);
  }
  const knots = keys.map((at) => ({ time: model.times[at], ...smearAt(at) }));
  const pad = 2 / model.fps;
  const start = Math.max(0, knots[0].time - pad), end = Math.min(model.duration, knots.at(-1).time + pad);
  const points = [{ ...knots[0], time: start, length: 0 }, ...knots, { ...knots.at(-1), time: end, length: 0 }].filter((point, index, list) => index === 0 || point.time > list[index - 1].time + 1e-6);
  const animations = points.slice(1).map((point, index) => ({ start: sec(points[index].time), duration: sec(point.time - points[index].time), easing: "linear",
    ...(index === 0 ? { from: { length: 0, angle: point.angle } } : {}), to: { length: point.length, angle: point.angle } }));
  const blurred = (model.effects ?? []).some((effect) => effect.itemId === item.id && effect.effect === "directional-blur" && effect.start < end && effect.end > start);
  return {
    rule: "judder", severity: "warn", itemId: item.id, at: sec(model.times[first]), until: sec(model.times[last]), bbox: roundBox(boxAt(rider, first)),
    measured: `${Math.round(speed * 100) / 100} frame widths a second`, required: `under ${JUDDER_SLOW} without motion blur`,
    message: `${ctx.name(item)} is large and pans ${fast ? "fast" : "steadily"} without motion blur at ${Math.round(outputFps * 1000) / 1000} fps; it will ${fast ? "judder" : "strobe"}.`,
    fix: blurred || !(smearAt(peak).length >= 2) ? { kind: "hint", text: "Slow the move, add blur while it moves, or render at 60 fps." }
      : { kind: "smear", auto: true, itemId: item.id, animations },
  };
}
