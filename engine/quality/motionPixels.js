// Rules measured on rendered frames over time: luma_jump and frozen_picture (both gates).
//
// Contrast and flashing (pixels.js) judge single frames. These two render every output frame,
// small (MOTION_WIDTH pixels wide), in short windows the model points at, and compare frames:
// - luma_jump: the picture's brightness steps (more than STEP_LEVELS in STEP_SPAN) off a cut, as
//   a large layer pops on or off (or its color snaps) or during a zoom or push transition; or,
//   inside a transition, it dips or bumps past both shots' brightness (more than DIP_LEVELS).
//   A layer sliding or scaling in is not judged: it brings its own brightness with it. Nor is a
//   transition where only its two shots show, covering the frame: that is their own pictures.
// - frozen_picture: the picture inside a video layer's box (any size: a phone screen counts)
//   does not change for FREEZE_MIN or longer.
// Brightness is the mean Rec.709 luma of the encoded pixels (0 to 255), the number ffmpeg calls
// YAVG. A plain dissolve moves it in a straight line; linear light would dip in every dissolve.
import { cuts, sec } from "./analysis.js";
import { area, boxAt, chainOf, frameAt, intersection, runs, tweensOf, visibleBoxAt } from "./model.js";
import { coveredAt, techniquesUsed, transitions } from "./techniques.js";
import { CUE_WINDOW, cutInOf, freezeCue, frozenFootage, plannedFreeze } from "./rules/footage.js";
import { mediaFrameState } from "../playback.js";
import { positionAt } from "../recording.js";

export const MOTION_WIDTH = 64;
// The most frames one check renders for each rule. A frame costs about 20 ms to draw; footage
// costs its decoding, which is one FFmpeg run per clip when the clip's times sit close together
// (export.mjs decodes a stretch of times in one run). A check's pictures are kept
// (check-pictures.mjs), so the next check of an unchanged scene is quick.
const WINDOW_FRAMES = 120;
const FREEZE_FRAMES = 120;
const STEP_LEVELS = 12;
const STEP_SPAN = 0.2;
const DIP_LEVELS = 8;
// A layer this big (share of the frame) can move the brightness by STEP_LEVELS on its own.
const LARGE = 0.08;
// Opacity changing this much this fast is a pop (a layer shown or hidden at once), not a fade.
const POP_CHANGE = 0.5;
const POP_TIME = 0.1;
// Transitions whose brightness change is the point (a dissolve, a wipe, a flash) are judged only
// by the dip test; a zoom or push through is a move, and its brightness must not jump either.
const MOVE_TRANSITIONS = new Set(["zoom-through", "push-transition", null]);
// Planned brightness beats: never judged.
const PLANNED = new Set(["fade-black", "flash", "cut"]);
const FREEZE_MIN = 0.3;
// An opacity or color change this long or longer is a fade; shorter is a pop. The hint says the same.
const FADE_MIN = 0.3;
const COLOR_KEYS = ["fill", "color", "stroke", "background", "gradient"];
// Mean absolute difference between two frames inside the box (0 to 1): under this is the same picture.
const FREEZE_DIFF = 0.002;
// Freeze sampling: 2 to 3 frames in every FREEZE_MIN, and boxes this many pixels or more at MOTION_WIDTH.
const FREEZE_STEP = 0.15;
const FREEZE_PIXELS = 12;

const frameShare = (model, box) => area(intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height })) / (model.width * model.height);
const shownLarge = (model, item, index) => item.samples.opacity[index] >= 0.3 && frameShare(model, visibleBoxAt(model, item, index)) >= LARGE && !coveredAt(model, item, index);

/** Mean display luma (0 to 255) of an RGBA frame, or of the part of it inside `box` (frame pixels). */
export function brightness(frame, box = null) {
  const { x0, y0, x1, y1 } = pixelBox(frame, box);
  let sum = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const at = (y * frame.width + x) * 4;
      sum += 0.2126 * frame.pixels[at] + 0.7152 * frame.pixels[at + 1] + 0.0722 * frame.pixels[at + 2];
    }
  return sum / Math.max(1, (x1 - x0) * (y1 - y0));
}

// Contrast is read on the 16 x 9 grid of cells the reference fingerprints use
// (backend/measure/fingerprint.mjs CELL_COLS, CELL_ROWS).
const CONTRAST_COLS = 16;
const CONTRAST_ROWS = 9;
// A contrast gap worth saying: apart by this amount and by this ratio (look versus, reference_range).
export const CONTRAST_GAP = 0.05;
export const CONTRAST_RATIO = 1.5;

/** Contrast from the mean luma (0 to 1) of each cell of the 16 x 9 grid: 2 x their standard deviation, 2 decimals. */
export function cellContrast(means) {
  const count = means.length;
  if (!count) return 0;
  let sum = 0, squares = 0;
  for (const value of means) { sum += value; squares += value * value; }
  const average = sum / count;
  return Math.round(2 * Math.sqrt(Math.max(0, squares / count - average * average)) * 100) / 100;
}

/** The contrast (0 to 1) of an RGBA frame {width, height, pixels}: cellContrast of its 16 x 9 cell mean lumas. */
export function frameContrast(frame) {
  const means = [];
  for (let row = 0; row < CONTRAST_ROWS; row += 1) {
    const y0 = Math.floor((row * frame.height) / CONTRAST_ROWS), y1 = Math.max(y0 + 1, Math.floor(((row + 1) * frame.height) / CONTRAST_ROWS));
    for (let col = 0; col < CONTRAST_COLS; col += 1) {
      const x0 = Math.floor((col * frame.width) / CONTRAST_COLS), x1 = Math.max(x0 + 1, Math.floor(((col + 1) * frame.width) / CONTRAST_COLS));
      means.push(brightness(frame, { x0, y0, x1, y1 }) / 255);
    }
  }
  return cellContrast(means);
}

/** Mean absolute difference (0 to 1) of two RGBA frames, inside `box` (frame pixels) or all of them. */
export function frameDiff(a, b, box = null) {
  const { x0, y0, x1, y1 } = pixelBox(a, box);
  let sum = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const at = (y * a.width + x) * 4;
      sum += Math.abs(a.pixels[at] - b.pixels[at]) + Math.abs(a.pixels[at + 1] - b.pixels[at + 1]) + Math.abs(a.pixels[at + 2] - b.pixels[at + 2]);
    }
  return sum / Math.max(1, 3 * 255 * (x1 - x0) * (y1 - y0));
}

function pixelBox(frame, box) {
  if (!box) return { x0: 0, y0: 0, x1: frame.width, y1: frame.height };
  return {
    x0: Math.max(0, Math.floor(box.x0)), y0: Math.max(0, Math.floor(box.y0)),
    x1: Math.min(frame.width, Math.ceil(box.x1)), y1: Math.min(frame.height, Math.ceil(box.y1)),
  };
}

// True when an opacity animation of FADE_MIN or longer on the item (or a group it is in) runs
// at a time: a fade, not a pop.
function fadingAt(model, item, time) {
  const slack = 1 / model.fps;
  return chainOf(model, item).some((entry) => tweensOf(model, entry.id).some((tween) => tween.end - tween.start >= FADE_MIN - 1e-6
    && tween.keys.includes("opacity") && time >= tween.start - slack && time <= tween.end + slack));
}

// True when a box moved or changed size by 1% of the frame diagonal or more in 0.1 s around a sample.
function boxMovingAt(model, item, index) {
  const span = Math.max(1, Math.round(0.05 * model.fps));
  const a = boxAt(item, Math.max(0, index - span)), b = boxAt(item, Math.min(model.times.length - 1, index + span));
  const most = Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
  return most >= 0.01 * Math.hypot(model.width, model.height);
}

// A pop that a wipe explains: a mask on the item (or a group it is in) moves within 0.2 s of it,
// or a layer drawn over it (a wipe bar, a shutter) moves across it then. The wipe sets the pace.
function wipedAt(model, item, index) {
  const reach = Math.max(1, Math.round(0.2 * model.fps));
  for (let near = Math.max(0, index - reach); near <= Math.min(model.times.length - 1, index + reach); near += 1)
    if (wipedNow(model, item, near)) return true;
  return false;
}

function wipedNow(model, item, index) {
  const chain = chainOf(model, item);
  const masks = chain.map((entry) => entry.maskId).filter(Boolean).map((id) => model.items.find((entry) => entry.id === id)).filter(Boolean);
  if (masks.some((mask) => boxMovingAt(model, mask, index))) return true;
  const box = visibleBoxAt(model, item, index);
  return model.items.some((other) => other.z > item.z && !chain.includes(other) && other.kind !== "audio" && !other.isMask
    && other.samples.opacity[index] >= 0.3 && area(intersection(visibleBoxAt(model, other, index), box)) > 0 && boxMovingAt(model, other, index));
}

// Which large layers pop: opacity jumping by POP_CHANGE within POP_TIME (not in a fade of
// FADE_MIN or longer), or an opacity or color animation shorter than FADE_MIN. A map of model sample index
// to the layers popping there.
function causes(model) {
  if (model._motionCauses) return model._motionCauses;
  const pops = new Map();
  const back = Math.max(1, Math.round(POP_TIME * model.fps));
  const add = (index, item) => pops.set(index, [...(pops.get(index) ?? []), item]);
  for (const item of model.items) {
    if (item.isMask || item.kind === "text" || item.kind === "audio") continue;
    const { opacity } = item.samples;
    for (let index = 1; index < model.times.length; index += 1) {
      const before = Math.max(0, index - back);
      if (Math.abs(opacity[index] - opacity[before]) < POP_CHANGE || fadingAt(model, item, model.times[index])) continue;
      if (!shownLarge(model, item, index) && !shownLarge(model, item, before)) continue;
      if (!wipedAt(model, item, index)) add(index, item);
    }
    // A quick opacity or color animation (under FADE_MIN) is a pop even when it moves under POP_CHANGE.
    for (const tween of tweensOf(model, item.id)) {
      if (tween.end - tween.start >= FADE_MIN - 1e-6 || !tween.keys.some((key) => key === "opacity" || COLOR_KEYS.includes(key))) continue;
      const first = frameAt(model, tween.start), last = frameAt(model, tween.end);
      const index = shownLarge(model, item, last) ? last : first;
      if ((shownLarge(model, item, index)) && !pops.get(index)?.includes(item) && !wipedAt(model, item, index)) add(index, item);
    }
  }
  model._motionCauses = { pops };
  return model._motionCauses;
}

// Cut times: the model's hard cuts and cut transitions, and the times a picture (a video or an
// image filling 30% of the frame or more) is shown or hidden at once: a picture switching is a
// cut, a shade or a shape popping is not.
function cutTimesOf(model, found) {
  // A group holding a video or image (a shot built as a clip over its own blurred copy) switches
  // like a picture does.
  const isPicture = (item, depth = 0) => item.kind === "video" || item.kind === "image"
    || (item.kind === "group" && depth < 8 && model.items.some((child) => child.parentId === item.id && isPicture(child, depth + 1)));
  const pictures = [...found.pops].filter(([index, items]) => items.some((item) => isPicture(item) && frameShare(model, visibleBoxAt(model, item, index)) >= 0.3));
  return [...cuts(model), ...transitions(model).filter((change) => change.tag === "cut").map((change) => change.at), ...pictures.map(([index]) => model.times[index])];
}

// The windows to render, in seconds, most telling first: transitions, then pops.
export function windowsOf(model, found = causes(model)) {
  const windows = [];
  for (const change of transitions(model)) {
    if (PLANNED.has(change.tag)) continue;
    windows.push({ from: change.at - 0.45, to: change.at + 0.25, transition: change });
  }
  const runsOf = (map, pad) => {
    const list = [...map.keys()].sort((a, b) => a - b);
    const result = [];
    for (const index of list) {
      const last = result.at(-1);
      if (last && index - last.last <= 2) last.last = index;
      else result.push({ first: index, last: index, item: [map.get(index)].flat()[0] });
    }
    return result.map((run) => ({ from: model.times[run.first] - pad, to: model.times[run.last] + pad, item: run.item, at: [model.times[run.first], model.times[run.last]] }));
  };
  // A pop on a cut, inside a transition window or in a planned fade or flash is part of that change.
  const cutTimes = cutTimesOf(model, found);
  // A deliberate flash (a light full-frame shape shown 0.35 s or less, engine/quality/techniques.js)
  // is a planned brightness beat too: the flashing gate holds it to the photosensitivity limit.
  const flashes = (techniquesUsed(model).flash ?? []).map((entry) => entry.at);
  const explained = (window) => near(cutTimes, window.at[0] - 0.15, window.at[1] + 0.15) || near(flashes, window.at[0] - 0.5, window.at[1] + 0.15)
    || windows.some((other) => other.transition && window.at[0] >= other.from && window.at[1] <= other.to)
    || transitions(model).some((change) => PLANNED.has(change.tag) && window.at[1] >= change.at - 0.6 && window.at[0] <= change.at + 0.3);
  windows.push(...runsOf(found.pops, 0.1).filter((window) => !explained(window)).map((window) => ({ ...window, pop: true })));
  return windows.map((window) => ({ ...window, from: Math.max(0, window.from), to: Math.min(model.duration, window.to) }));
}

// Output frame times (on the 1/fps grid) inside the windows, at most `budget` of them.
function gridTimes(windows, fps, budget) {
  const times = new Set();
  for (const window of windows) {
    const list = [];
    for (let k = Math.ceil(window.from * fps - 1e-6); k / fps <= window.to + 1e-6; k += 1) list.push(Math.round((k / fps) * 1e6) / 1e6);
    if (times.size + list.filter((time) => !times.has(time)).length > budget) continue;
    for (const time of list) times.add(time);
  }
  return times;
}

// The spans (seconds) where each video layer is on screen and big enough to measure.
function videoSpans(model, frameWidth) {
  const k = frameWidth / model.width;
  const spans = [];
  for (const item of model.items) {
    if (item.kind !== "video" || item.isMask) continue;
    let start = -1;
    for (let index = 0; index <= model.times.length; index += 1) {
      const box = index < model.times.length ? intersection(visibleBoxAt(model, item, index), { x0: 0, y0: 0, x1: model.width, y1: model.height }) : null;
      const watched = box && item.samples.opacity[index] >= 0.5 && area(box) * k * k >= FREEZE_PIXELS && !coveredAt(model, item, index);
      if (watched) { if (start < 0) start = index; continue; }
      if (start >= 0 && model.times[index - 1] - model.times[start] >= FREEZE_MIN)
        spans.push({ item, from: model.times[start], to: model.times[index - 1], share: frameShare(model, visibleBoxAt(model, item, start)) });
      start = -1;
    }
  }
  return spans;
}

// Freeze sample times: every FREEZE_STEP along each span (2 to 3 frames in FREEZE_MIN), small
// clips first (frozen_footage already reads the big ones from the document), at most `budget`.
// A span is sampled whole or not at all, so its frames stay one close stretch for the decoder.
function freezeTimes(spans, fps, budget) {
  const times = new Set();
  let capped = false;
  for (const span of spans) {
    const list = [];
    // On the output frame grid, FREEZE_STEP apart or a little closer.
    const step = Math.max(1, Math.floor(FREEZE_STEP * fps + 1e-6));
    for (let k = Math.ceil(span.from * fps - 1e-6); k / fps <= span.to + 1e-6; k += step) list.push(Math.round((k / fps) * 1e6) / 1e6);
    const fresh = [...new Set(list)].filter((time) => !times.has(time));
    if (times.size + fresh.length > budget) { capped = true; continue; }
    for (const time of fresh) times.add(time);
  }
  return { times, capped };
}

/**
 * Both rules share one render: measured once per model and check run (the same renderFrames)
 * and kept on the model. The brightness windows and the freeze samples have their own frame
 * budgets. Resolves to {frames: [{time, frame}], windows, spans, capped, freezeCapped}.
 */
async function measured(model, ctx) {
  if (model._motionFrames?.render === ctx.renderFrames) return model._motionFrames.result;
  const result = (async () => {
    const fps = ctx.outputFps ?? 30;
    const width = Math.min(MOTION_WIDTH, model.width);
    const windows = windowsOf(model, causes(model));
    const times = gridTimes(windows, fps, WINDOW_FRAMES);
    const capped = gridTimes(windows, fps, Infinity).size > times.size;
    const spans = videoSpans(model, width).sort((a, b) => a.share - b.share);
    const freeze = freezeTimes(spans, fps, FREEZE_FRAMES);
    const list = [...new Set([...times, ...freeze.times])].sort((a, b) => a - b);
    if (!list.length) return { frames: [], windows, spans, capped, freezeCapped: freeze.capped };
    const rendered = await ctx.renderFrames(list, { width, hide: [] });
    return { frames: list.map((time, index) => ({ time, frame: rendered[index] })).filter((entry) => entry.frame), windows, spans, capped, freezeCapped: freeze.capped };
  })();
  model._motionFrames = { render: ctx.renderFrames, result };
  return result;
}

const near = (list, from, to) => list.some((time) => time >= from && time <= to);

/** luma_jump: brightness that steps off a cut, or dips or bumps inside a transition. */
export async function lumaJump(model, ctx) {
  if (!ctx.renderFrames) return [];
  const { frames, windows, capped } = await measured(model, ctx);
  if (capped) ctx.note?.(`luma_jump: at most ${WINDOW_FRAMES} frames a check; some pops or transitions were not measured`);
  const fps = ctx.outputFps ?? 30;
  const tolerance = 1 / model.fps + 1 / fps;
  const cutTimes = cutTimesOf(model, causes(model));
  const levels = new Map(frames.map(({ time, frame }) => [time, brightness(frame)]));
  const inWindow = (window) => frames.filter(({ time }) => time >= window.from - 1e-6 && time <= window.to + 1e-6).map(({ time }) => ({ time, level: levels.get(time) }));
  const findings = [];
  const flagged = [];
  const round = (value) => Math.round(value);
  const add = (finding, from, to) => {
    if (flagged.some(([a, b]) => from <= b + 0.1 && to >= a - 0.1)) return;
    flagged.push([from, to]);
    findings.push(finding);
  };
  for (const window of windows) {
    const points = inWindow(window);
    if (points.length < 2) continue;
    const tag = window.transition?.tag;
    // Only the two shots, together covering the frame, and nothing else changing: what moves the
    // brightness is the shots' own pictures (a push into a bright point, a quick crossfade, which
    // is a cut drawn out), not a fault.
    if (window.transition && shotsOnly(model, window)) continue;
    // (b) Inside a transition: brightness stays between the two shots' brightness.
    if (window.transition) {
      const first = points[0].level, last = points.at(-1).level;
      const high = Math.max(...points.map((point) => point.level)), low = Math.min(...points.map((point) => point.level));
      const over = high - Math.max(first, last), under = Math.min(first, last) - low;
      if (Math.max(over, under) > DIP_LEVELS) {
        const peak = points.find((point) => point.level === (over >= under ? high : low));
        const item = model.items.find((entry) => entry.id === window.transition.itemId);
        add({
          rule: "luma_jump", severity: "error", itemId: window.transition.itemId, at: sec(peak.time), until: sec(points.at(-1).time),
          measured: `brightness ${round(first)} to ${round(over >= under ? high : low)} to ${round(last)} (0-255) in the ${tag ?? "transition"} at ${sec(window.transition.at)}s`,
          required: `brightness moves steadily from one shot to the next (within ${DIP_LEVELS} levels past either end)`,
          message: `The picture ${over >= under ? "brightens" : "darkens"} mid-transition into ${ctx.name(item)}: ${round(first)}, then ${round(over >= under ? high : low)} at ${sec(peak.time)}s, then ${round(last)}.`,
          fix: { kind: "hint", text: "Keep both shots lit through the move: overlap them (the new shot fades in while the old one is still full), remove the dark or bright layer between them, or make it a planned fade_black or flash (or waive_check)." },
        }, points[0].time, points.at(-1).time);
        continue;
      }
      if (!MOVE_TRANSITIONS.has(tag)) continue;
    }
    // (a) A step of STEP_LEVELS within STEP_SPAN, off a cut. A pop is judged only on the frames
    // its own opacity changes in, so a fade of other layers just before it is not counted.
    const span = window.pop ? opacitySpan(model, window.item, window.at) : null;
    for (let i = 1; i < points.length; i += 1) {
      if (span && (points[i].time > span[1] + 1e-6)) break;
      for (let j = i - 1; j >= 0 && points[i].time - points[j].time <= STEP_SPAN + 1e-6; j -= 1) {
        const step = points[i].level - points[j].level;
        if (Math.abs(step) <= STEP_LEVELS) continue;
        if (span && points[j].time < span[0] - 1e-6) continue;
        if (near(cutTimes, points[j].time - tolerance, points[i].time + tolerance)) continue;
        // A pop explains only the step it is in; the rest of its window is the footage's own.
        if (window.pop && !(points[j].time <= window.at[1] + tolerance && points[i].time >= window.at[0] - tolerance)) continue;
        const how = window.transition ? `during the ${tag ?? "transition"} into ${ctx.name(model.items.find((entry) => entry.id === window.transition.itemId))}`
          : window.item ? `as ${ctx.name(window.item)} ${windowKind(model, window)}` : "";
        add({
          rule: "luma_jump", severity: "error", itemId: window.transition?.itemId ?? window.item?.id, at: sec(points[j].time), until: sec(points[i].time),
          measured: `brightness ${round(points[j].level)} to ${round(points[i].level)} (0-255) in ${sec(points[i].time - points[j].time)} s`,
          required: `off a cut, at most ${STEP_LEVELS} levels in ${STEP_SPAN} s`,
          message: `The picture ${step > 0 ? "brightens" : "darkens"} by ${round(Math.abs(step))} levels from ${sec(points[j].time)} to ${sec(points[i].time)} s ${how}, with no cut.`.replace(/ ,/, ","),
          fix: { kind: "hint", text: "Fade the layer over 0.3 s or more instead of popping it, keep the light steady while things move (light the plate behind, or move the dark layer with the shot), or change the brightness on a cut. waive_check a planned flash." },
        }, points[j].time, points[i].time);
        i = points.length;
        break;
      }
    }
  }
  return findings;
}

// The times (seconds) a popping layer's opacity starts and stops changing around its pop, or
// null when its opacity holds (a color pop): then the whole pop window is judged.
function opacitySpan(model, item, at) {
  const { opacity } = item.samples;
  const moving = (index) => Math.abs(opacity[index] - opacity[index - 1]) > 0.01;
  let start = frameAt(model, at[0]), end = frameAt(model, at[1]);
  while (start > 0 && moving(start)) start -= 1;
  while (end < model.times.length - 1 && moving(end + 1)) end += 1;
  if (Math.abs(opacity[end] - opacity[start]) < 0.05) return null;
  return [model.times[start], model.times[end]];
}

// True when, all through a transition window, its two shots together cover the frame (at least
// SHOTS_COVER: no background showing between them) and no other layer appears, disappears or
// fades (its opacity times its share of the frame moves under 2%).
const SHOTS_COVER = 0.97;
function shotsOnly(model, window) {
  const shots = [window.transition.from, window.transition.itemId].map((id) => model.items.find((item) => item.id === id)).filter(Boolean);
  if (shots.length < 2) return false;
  const inShots = new Set(shots.flatMap((shot) => chainOf(model, shot)));
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const first = frameAt(model, window.from), last = frameAt(model, window.to);
  const others = model.items.filter((item) => !inShots.has(item) && !item.isMask && item.kind !== "audio" && item.kind !== "group" && !item.source?.sceneBackground);
  const seen = (item, index) => (coveredAt(model, item, index) ? 0 : item.samples.opacity[index] * frameShare(model, visibleBoxAt(model, item, index)));
  // A shot that turns (rotation or tilt) in the window has a box wider than its picture: the
  // frame's corners can show past it, so it counts as covering nothing.
  const TURNS = ["rotation", "rotateX", "rotateY"];
  const turned = new Set(shots.filter((shot) => chainOf(model, shot).some((entry) => tweensOf(model, entry.id).some((tween) =>
    tween.keys.some((key) => TURNS.includes(key)) && tween.end >= window.from && tween.start <= window.to))));
  const none = { x0: 0, y0: 0, x1: 0, y1: 0 };
  for (let index = first; index <= last; index += 1) {
    const [a, b] = shots.map((shot) => ({ box: turned.has(shot) ? none : intersection(visibleBoxAt(model, shot, index), frame), opacity: shot.samples.opacity[index] }));
    const both = area(intersection(a.box, b.box));
    const covered = a.opacity * (area(a.box) - both) + b.opacity * (area(b.box) - both) + (1 - (1 - a.opacity) * (1 - b.opacity)) * both;
    if (covered < SHOTS_COVER * model.width * model.height) return false;
  }
  return others.every((item) => {
    let low = Infinity, high = -Infinity;
    for (let index = first; index <= last; index += 1) { const value = seen(item, index); low = Math.min(low, value); high = Math.max(high, value); }
    return high - low < 0.02;
  });
}

// What the window's layer does: "appears", "disappears" or "moves" (by its opacity around the window's middle).
function windowKind(model, window) {
  const { opacity } = window.item.samples;
  const middle = frameAt(model, (window.from + window.to) / 2);
  const change = opacity[Math.min(model.times.length - 1, middle + 2)] - opacity[Math.max(0, middle - 2)];
  return change > 0.2 ? "appears" : change < -0.2 ? "disappears" : "moves";
}

/**
 * True when something moves on or over `item` all through `from` to `to` (seconds), leaving no
 * still stretch of FREEZE_MIN: an animation of the layer or a group around it (an eased push or
 * drift, a shake), an effect animation on it, or a layer drawn over its box that animates, runs an
 * effect or moves by itself (text animating in, an overlay running). Drawn animation holds a cel
 * on purpose (study a/result.md 7, b/result.md 3 and 4): an eased push's slow ends changed the
 * pixels too little and brought frozen_picture back, so a held picture under motion is alive.
 */
export function aliveDuring(model, item, from, to) {
  const chain = chainOf(model, item);
  const own = new Set(chain.map((entry) => entry.id));
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const spans = [];
  const add = (start, end) => { if (end > start && end >= from && start <= to) spans.push([Math.max(from, start), Math.min(to, end)]); };
  const over = (other, start, end) => {
    const index = frameAt(model, (Math.max(from, start) + Math.min(to, end)) / 2);
    return other.samples.opacity[index] >= 0.1 && area(intersection(intersection(visibleBoxAt(model, other, index), visibleBoxAt(model, item, index)), frame)) > 0;
  };
  const timed = (entry) => [
    ...tweensOf(model, entry.id).filter((tween) => !tween.discrete && tween.end > tween.start).map((tween) => [tween.start, tween.end]),
    ...(model.effects ?? []).filter((effect) => effect.itemId === entry.id).map((effect) => [effect.start, effect.end])];
  for (const entry of chain) for (const [start, end] of timed(entry)) add(start, end);
  for (const other of model.items) {
    // Only what is drawn over the picture: a layer under a full-frame shot moves where no one sees it.
    if (own.has(other.id) || other.z <= item.z || other.isMask || other.kind === "audio" || other.kind === "group" || other.source?.sceneBackground) continue;
    for (const [start, end] of timed(other)) if (over(other, start, end)) add(start, end);
    // A clip counts as moving whenever it shows (model.js), even when it is itself held: only drawn movers here.
    if (other.samples.moving && other.kind !== "video") for (const run of runs(model.times.length, (index) => other.samples.moving[index] > 0))
      if (over(other, model.times[run.from], model.times[run.to])) add(model.times[run.from], model.times[run.to] + 1 / model.fps);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let reached = from;
  for (const [start, end] of spans) {
    if (start - reached >= FREEZE_MIN - 1e-6) return false;
    reached = Math.max(reached, end);
  }
  return to - reached < FREEZE_MIN - 1e-6;
}

// The ready fix for a held picture: an eased slow push over the hold (passes linear_motion, and a
// moving layer is alive for frozen_picture). 4% of the size a second, from SLOW_PUSH's full-frame
// 1.0 to 1.12 over 3 s (rules/motion.js); at least 2% so a short hold still moves (a guess).
function holdPush(item, from, to) {
  const duration = Math.max(FREEZE_MIN, to - from);
  return { kind: "motion", technique: "slow-push", itemId: item.id, start: sec(from), duration: sec(duration), scale: Math.round((1 + Math.max(0.02, 0.04 * duration)) * 1000) / 1000, easing: "smooth" };
}

/** frozen_picture: the rendered picture inside a video layer's box stops changing for FREEZE_MIN or longer. */
export async function frozenPicture(model, ctx) {
  if (!ctx.renderFrames) return [];
  const { frames, spans, freezeCapped } = await measured(model, ctx);
  if (!frames.length) return [];
  const width = frames[0].frame.width;
  const k = width / model.width;
  // frozen_footage already reports the stops it can see in the document.
  const known = (() => { try { return frozenFootage(model, ctx); } catch { return []; } })();
  const findings = [];
  let unmeasured = false;
  const layerOf = (item) => ctx.scene?.layers?.find((layer) => layer.id === item.source?.layerId) ?? null;
  for (const span of spans) {
    const points = frames.filter(({ time }) => time >= span.from - 1e-6 && time <= span.to + 1e-6);
    if (points.length < 2) { unmeasured = true; continue; }
    const layer = layerOf(span.item);
    const sourceAt = (time) => (layer ? mediaFrameState(layer, time).sourceTime : null);
    // A screen recording with its pointer moving over a still app is not frozen: only the
    // stretches where the recorded pointer also stays put are reported.
    const report = (from, to) => {
      if (!layer?.recording?.moves?.length) return reportStill(from, to);
      let start = from, anchor = positionAt(layer.recording, sourceAt(from));
      for (let time = from; time <= to + 1e-6; time += 1 / 30) {
        const [x, y] = positionAt(layer.recording, sourceAt(time));
        if (Math.hypot(x - anchor[0], y - anchor[1]) <= 3) continue;
        reportStill(start, time - 1 / 30);
        start = time;
        anchor = [x, y];
      }
      reportStill(start, to);
    };
    const reportStill = (from, to) => {
      if (to - from < FREEZE_MIN - 1e-6) return;
      if (layer && plannedFreeze(ctx.scene, layer.id, from, to)) return;
      // Something moves on or over the held picture all through the hold: alive, not frozen.
      if (aliveDuring(model, span.item, from, to)) return;
      if (known.some((finding) => (finding.itemIds ?? [finding.itemId]).includes(span.item.id) && finding.at <= to + 0.1 && finding.at >= from - 1)) return;
      const source = layer ? ` (its file from ${sec(sourceAt(from))} to ${sec(sourceAt(to))} s)` : "";
      // A still placed on a sound hit or a spoken line is a designed beat: it warns. Not at the
      // shot's own cut-in: cuts sit on hits and words, and a stall there is an accident.
      const onCut = from - cutInOf(model, span.item, frameAt(model, from)) <= CUE_WINDOW;
      const cue = onCut ? null : freezeCue(ctx, ctx.scene ?? ctx.speechScene, from);
      findings.push({
        rule: "frozen_picture", severity: cue ? "warn" : "error", itemId: span.item.id, at: sec(from), until: sec(to),
        measured: `picture inside the layer changes under ${FREEZE_DIFF * 100}% for ${sec(to - from)} s${source}`,
        required: `video on screen keeps moving (a held picture under ${FREEZE_MIN} s), or waive_check a deliberate freeze frame`,
        message: `${ctx.name(span.item)} shows a still picture from ${sec(from)} to ${sec(to)} s${source} while it is on screen${cue ? `, placed on ${cue}: a designed freeze warns, an accidental stall blocks` : ""}.`,
        fix: holdPush(span.item, from, to),
      });
    };
    // The picture of points[i] is the one of points[from]: each frame is compared with the first of
    // the run, not with the one before (the transition windows sample every frame, and a slow scroll
    // changes little from one frame to the next). A layer whose own opacity or blur changes is not
    // a still picture: it is fading or blurring in or out.
    const sameAs = (from, i) => {
      if (points[i].time - points[i - 1].time > FREEZE_STEP + 1e-6) return false;
      const a = frameAt(model, points[from].time), b = frameAt(model, points[i].time);
      const { opacity, blur } = span.item.samples;
      for (let index = a; index <= b; index += 1)
        if (Math.abs(opacity[index] - opacity[a]) > 0.02 || Math.abs(blur[index] - blur[a]) > 0.5) return false;
      const box = visibleBoxAt(model, span.item, b);
      const scaled = { x0: box.x0 * k, y0: box.y0 * k, x1: box.x1 * k, y1: box.y1 * k };
      return frameDiff(points[from].frame, points[i].frame, scaled) < FREEZE_DIFF;
    };
    let from = 0;
    for (let i = 1; i <= points.length; i += 1) {
      if (i < points.length && sameAs(from, i)) continue;
      if (i - 1 > from) report(points[from].time, points[i - 1].time);
      from = i < points.length && sameAs(i - 1, i) ? i - 1 : i;
    }
  }
  if (freezeCapped || unmeasured) ctx.note?.(`frozen_picture: only part of the time video is on screen was measured (${FREEZE_FRAMES} frames a check)`);
  return findings;
}

/** The scene's cuts and transitions (seconds): a rendered file's brightness may jump on them. */
export function plannedTimes(model) {
  return [...cuts(model), ...transitions(model).map((change) => change.at)].sort((a, b) => a - b);
}
