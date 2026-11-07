// Rules that look at the picture inside a clip, rendered alone (every other layer hidden), small.
// They came from a human QC pass on a trailer that kino's checks passed:
//   source_jump      a flash frame or camera jump in the file within 0.25 s of where a clip
//                    starts or ends on screen (the "ask" shot opened on two frames of another shot)
//   dark_under_title a large title over a clip whose picture is near black or flat most of the
//                    time the title shows (a name reveal sat on an empty burst)
//   low_fps_motion   a large clip played at under 12 new frames a second (mediaFrameRate, or
//                    slowed with nearest frames) while it moves, or while its footage moves
// All are warnings. Each clip is rendered with only itself and its parents shown, MEDIA_WIDTH
// pixels wide, at most FRAME_BUDGET frames a rule a check (the frames are kept for the run, so
// two rules asking for the same clip and time share them).
import { constantSpeed, mediaFrameRateOf, mediaInterpolationOf } from "../../mediaTime.js";
import { mediaFrameState } from "../../playback.js";
import { sec } from "../analysis.js";
import { area, boxAt, chainOf, intersection, visibleBoxAt } from "../model.js";
import { brightness, frameDiff } from "../motionPixels.js";
import { coveredAt } from "../techniques.js";

export const MEDIA_WIDTH = 48;
const FRAME_BUDGET = 240;
// A clip this big (share of the frame) is watched.
const LARGE = 0.2;
const SHOWN = 0.5;
// A blur this strong is a backdrop: its picture is meant to be soft.
const SOFT_BLUR = 16;

const frameShare = (model, box) => area(intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height })) / (model.width * model.height);
const layerOf = (ctx, item) => (ctx.scene ?? ctx.speechScene)?.layers?.find((layer) => layer.id === item.source?.layerId) ?? null;
const shownAt = (model, item, index) => item.samples.opacity[index] >= SHOWN && frameShare(model, visibleBoxAt(model, item, index)) >= LARGE;

/** Frames of `item` drawn alone (its parents and masks kept) at `times`, `MEDIA_WIDTH` wide. */
export function aloneFrames(model, ctx, item, times) {
  const keep = new Set(chainOf(model, item).flatMap((entry) => [entry.id, ...(entry.clipIds ?? []), ...(entry.maskId ? [entry.maskId] : [])]));
  const hide = model.items.filter((entry) => !keep.has(entry.id)).map((entry) => entry.id);
  return ctx.renderFrames(times, { width: Math.min(MEDIA_WIDTH, model.width), hide });
}

// The item's box in frame pixels of a frame `width` wide.
const scaled = (model, box, width) => {
  const k = width / model.width;
  const clipped = intersection(box, { x0: 0, y0: 0, x1: model.width, y1: model.height });
  return { x0: clipped.x0 * k, y0: clipped.y0 * k, x1: clipped.x1 * k, y1: clipped.y1 * k };
};

// Whether the item's own look (opacity, blur, place, size) holds between samples a and b, so a
// change in its pixels is its file's.
function steady(model, item, a, b) {
  const { opacity, blur } = item.samples;
  const diagonal = Math.hypot(model.width, model.height);
  const p = boxAt(item, a), q = boxAt(item, b);
  const moved = Math.hypot((p.x0 + p.x1 - q.x0 - q.x1) / 2, (p.y0 + p.y1 - q.y0 - q.y1) / 2) + Math.abs((p.x1 - p.x0) - (q.x1 - q.x0));
  return Math.abs(opacity[a] - opacity[b]) <= 0.02 && Math.abs(blur[a] - blur[b]) <= 0.5 && moved <= 0.01 * diagonal;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

// ---------------------------------------------------------------- source_jump

// How far into a clip's start or end a jump is still at the cut (seconds).
const EDGE = 0.25;
// A frame-to-frame difference (0 to 1) this big, and JUMP_RATIO times the window's usual one,
// is another picture: a flash frame or a camera jump.
const JUMP_DIFF = 0.1;
const JUMP_RATIO = 4;

// The first and last on-screen edges of each large clip, the biggest clips first:
// [{item, windows: [{edge, indexes}]}]. Clips that show few new frames (low_fps_motion's) are left out.
function edgeWindows(model, ctx) {
  const reach = Math.max(2, Math.round(EDGE * model.fps));
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
  const list = [];
  for (const item of model.items) {
    if (item.kind !== "video" || item.isMask || item.blur >= SOFT_BLUR) continue;
    const layer = layerOf(ctx, item);
    if (layer && newFramesPerSecond(layer) < 2 * LOW_FPS) continue;
    let first = -1, last = -1, share = 0;
    model.times.forEach((_, index) => {
      if (!shownAt(model, item, index) || coveredAt(model, item, index)) return;
      if (first < 0) first = index;
      last = index;
      share = Math.max(share, frameShare(model, visibleBoxAt(model, item, index)));
    });
    if (first < 0 || last - first < reach) continue;
    list.push({ item, share, windows: [{ edge: "start", indexes: range(first, Math.min(last, first + reach)) }, { edge: "end", indexes: range(Math.max(first, last - reach), last) }] });
  }
  return list.sort((a, b) => b.share - a.share);
}

/** source_jump: a flash frame or camera jump in the file right where a clip starts or ends. */
export async function sourceJump(model, ctx) {
  if (!ctx.renderFrames) return [];
  const findings = [];
  let used = 0, capped = false;
  for (const { item, windows } of edgeWindows(model, ctx)) {
    const all = [...new Set(windows.flatMap((window) => window.indexes))];
    if (used + all.length > FRAME_BUDGET) { capped = true; continue; }
    used += all.length;
    // One render for both edges: one decoding run of the clip.
    const rendered = await aloneFrames(model, ctx, item, all.map((index) => model.times[index]));
    const frameOf = new Map(all.map((index, k) => [index, rendered[k]]));
    const layer = layerOf(ctx, item);
    const fileAt = (index) => (layer ? mediaFrameState(layer, model.times[index]).sourceTime : model.times[index]);
    for (const { edge, indexes } of windows) findings.push(...edgeJump(model, ctx, item, layer, edge, indexes, indexes.map((index) => frameOf.get(index)), fileAt));
  }
  if (capped) ctx.note?.(`source_jump: only part of the clips' starts and ends were measured (${FRAME_BUDGET} frames a check)`);
  return findings;
}

function edgeJump(model, ctx, item, layer, edge, indexes, frames, fileAt) {
  const diffs = [];
  for (let k = 1; k < indexes.length; k += 1) {
    // Only new frames of the file: a held frame is not a change.
    if (!frames[k - 1] || !frames[k] || !steady(model, item, indexes[k - 1], indexes[k]) || Math.abs(fileAt(indexes[k]) - fileAt(indexes[k - 1])) < 1e-4) continue;
    const box = scaled(model, visibleBoxAt(model, item, indexes[k]), frames[k].width);
    diffs.push({ k, diff: frameDiff(frames[k - 1], frames[k], box) });
  }
  if (diffs.length < 3) return [];
  const top = diffs.reduce((a, b) => (b.diff > a.diff ? b : a));
  const usual = median(diffs.filter((entry) => entry !== top).map((entry) => entry.diff));
  if (top.diff < JUMP_DIFF || top.diff < JUMP_RATIO * Math.max(usual, 0.01)) return [];
  const time = model.times[indexes[top.k]], before = model.times[indexes[top.k - 1]];
  const into = edge === "start" ? time - model.times[indexes[0]] : model.times[indexes.at(-1)] - before;
  const at = fileAt(indexes[edge === "start" ? top.k : top.k - 1]);
  // mediaOffset is in file seconds (a sped-up or slowed clip skips more or less of its file).
  const skip = Math.abs(at - fileAt(indexes[0]));
  const file = layer ? ` (its file at ${sec(at)} s)` : "";
  const trim = edge === "start"
    ? `Start the clip past it: raise mediaOffset by ${sec(layer ? skip : into)} s${layer ? ` (to ${sec(at)} s in the file)` : ""} and lower mediaDuration by ${sec(into)} s, or start the layer later`
    : `End the clip before it: lower mediaDuration by ${sec(into + 1 / model.fps)} s${layer ? ` (to end at ${sec(at)} s in the file)` : ""}, or end the layer sooner`;
  return [{
    rule: "source_jump", severity: "warn", itemId: item.id, at: sec(before), until: sec(time),
    message: `${ctx.name(item)} jumps to another picture ${sec(into)} s ${edge === "start" ? "after it starts" : "before it ends"}${file}: a flash frame or camera jump right at the cut.`,
    measured: `frame-to-frame change ${Math.round(top.diff * 100)}% at ${sec(time)} s, the usual one ${Math.round(usual * 100)}% in its first or last ${EDGE} s`,
    required: `no jump over ${JUMP_DIFF * 100}% (and ${JUMP_RATIO}x the usual change) within ${EDGE} s of a clip's start or end`,
    fix: { kind: "hint", text: `${trim}. look {mode:"frame", t:${sec(before)}} and t:${sec(time)} show it.` },
  }];
}

// ---------------------------------------------------------------- dark_under_title

// Mean luma (0 to 255) under this is near black; a spread (standard deviation) under FLAT_SPREAD
// is an empty, muddy picture.
const DARK_LUMA = 28;
const FLAT_SPREAD = 10;
// The share of the title's time the picture may be empty.
const EMPTY_SHARE = 0.6;
const TITLE_SAMPLES = 6;
const TITLE_MIN = 0.5;
// A text this tall (share of the frame's height), or with a display or headline role, is a title.
const TITLE_SIZE = 0.1;

function spread(frame, box, mean) {
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(frame.width, Math.ceil(box.x1)), y1 = Math.min(frame.height, Math.ceil(box.y1));
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y += 1)
    for (let x = x0; x < x1; x += 1) {
      const at = (y * frame.width + x) * 4;
      const luma = 0.2126 * frame.pixels[at] + 0.7152 * frame.pixels[at + 1] + 0.0722 * frame.pixels[at + 2];
      sum += (luma - mean) ** 2;
      count += 1;
    }
  return Math.sqrt(sum / Math.max(1, count));
}

const isTitle = (model, item) => item.kind === "text" && !item.isMask && (["display", "headline"].includes(item.role) || item.fontSize >= TITLE_SIZE * model.height);
const centerIn = (box, outer) => {
  const x = (box.x0 + box.x1) / 2, y = (box.y0 + box.y1) / 2;
  return x >= outer.x0 && x <= outer.x1 && y >= outer.y0 && y <= outer.y1;
};

/** dark_under_title: a large title over a clip whose own picture is near black or flat most of the time. */
export async function darkUnderTitle(model, ctx) {
  if (!ctx.renderFrames) return [];
  const findings = [];
  let used = 0, capped = false;
  const plans = [];
  for (const title of model.items.filter((item) => isTitle(model, item))) {
    const shown = model.times.map((_, index) => index).filter((index) => title.samples.opacity[index] >= SHOWN);
    if (shown.length / model.fps < TITLE_MIN) continue;
    // The clip under the title: the topmost large video below it holding the title's center, not
    // under an opaque card (a title on a card is fine).
    const under = (index) => model.items
      .filter((item) => item.kind === "video" && !item.isMask && item.z < title.z && shownAt(model, item, index) && !coveredAt(model, item, index) && centerIn(boxAt(title, index), visibleBoxAt(model, item, index)))
      .sort((a, b) => b.z - a.z)[0] ?? null;
    const picks = [];
    for (let k = 0; k < TITLE_SAMPLES; k += 1) picks.push(shown[Math.floor(((k + 0.5) / TITLE_SAMPLES) * shown.length)]);
    const byClip = new Map();
    for (const index of picks) {
      const clip = under(index);
      if (clip) byClip.set(clip, [...(byClip.get(clip) ?? []), index]);
    }
    // Samples with a clip under the title must be most of them (a title over a plain card is fine).
    const over = [...byClip.values()].reduce((sum, list) => sum + list.length, 0);
    if (over < Math.ceil(TITLE_SAMPLES * EMPTY_SHARE)) continue;
    if (used + over > FRAME_BUDGET) { capped = true; continue; }
    used += over;
    plans.push({ title, shown, byClip });
  }
  // Each clip drawn alone once, at every time the titles over it need (one render a clip).
  const wanted = new Map();
  for (const { byClip } of plans) for (const [clip, indexes] of byClip) wanted.set(clip, [...new Set([...(wanted.get(clip) ?? []), ...indexes])]);
  const drawn = new Map();
  for (const [clip, indexes] of wanted) {
    const frames = await aloneFrames(model, ctx, clip, indexes.map((index) => model.times[index]));
    indexes.forEach((index, k) => drawn.set(`${clip.id}@${index}`, frames[k]));
  }
  for (const { title, shown, byClip } of plans) {
    const reads = [];
    for (const [clip, indexes] of byClip) {
      const frames = indexes.map((index) => drawn.get(`${clip.id}@${index}`));
      indexes.forEach((index, k) => {
        if (!frames[k]) return;
        const box = scaled(model, visibleBoxAt(model, clip, index), frames[k].width);
        const luma = brightness(frames[k], box);
        reads.push({ clip, time: model.times[index], luma, spread: spread(frames[k], box, luma) });
      });
    }
    const empty = reads.filter((read) => read.luma < DARK_LUMA || read.spread < FLAT_SPREAD);
    if (empty.length / TITLE_SAMPLES < EMPTY_SHARE) continue;
    const clips = [...new Set(empty.map((read) => read.clip))];
    const names = clips.map((clip) => ctx.name(clip)).join(" and ");
    const from = model.times[shown[0]], to = model.times[shown.at(-1)];
    findings.push({
      rule: "dark_under_title", severity: "warn", itemId: title.id, itemIds: [title.id, ...clips.map((clip) => clip.id)], at: sec(from), until: sec(to),
      message: `${ctx.name(title)} sits over ${names}, whose picture is near black or empty most of the time the title shows (${sec(from)} to ${sec(to)} s): the reveal lands on nothing.`,
      measured: `${empty.length} of ${TITLE_SAMPLES} samples empty: ${empty.map((read) => `${sec(read.time)} s luma ${Math.round(read.luma)}, spread ${Math.round(read.spread)}`).join("; ")}`,
      required: `the clip under a title shows a picture (luma ${DARK_LUMA} or more and spread ${FLAT_SPREAD} or more) for at least ${Math.round((1 - EMPTY_SHARE) * 100)}% of the title's time; a title over a plain card is fine`,
      fix: { kind: "hint", text: `Show a part of ${names}'s file with a clear picture under the title (mediaOffset; look {mode:"source", layer:${ctx.name(clips[0])}} to pick), put the title on a deliberate plain card (hide the clip), or move the title to a stronger shot.` },
    });
  }
  if (capped) ctx.note?.(`dark_under_title: only some titles were measured (${FRAME_BUDGET} frames a check)`);
  return findings;
}

// ---------------------------------------------------------------- low_fps_motion

// Under this many new frames a second, motion stutters.
export const LOW_FPS = 12;
// A file's frame rate when it is not known: slowing a 30 fps file to 0.4 gives 12 frames a second.
const FILE_FPS = 30;
// Moving: the box's center or width changes this share of the frame diagonal a second.
const MOVING = 0.02;
const MOVING_MIN = 0.3;
// Footage moving: each new frame differs from the last by this much (0 to 1), at the median.
const STEP_DIFF = 0.03;
const STEP_SAMPLES = 5;

// New frames a second the layer shows, or Infinity.
function newFramesPerSecond(layer) {
  const rate = mediaFrameRateOf(layer);
  const speed = constantSpeed(layer);
  const slowed = speed < 1 && mediaInterpolationOf(layer) === "nearest" ? FILE_FPS * speed : Infinity;
  return Math.min(rate > 0 ? rate : Infinity, slowed);
}

function movingTime(model, item) {
  const diagonal = Math.hypot(model.width, model.height);
  let moving = 0;
  for (let index = 1; index < model.times.length; index += 1) {
    if (!shownAt(model, item, index) || !shownAt(model, item, index - 1)) continue;
    const p = boxAt(item, index - 1), q = boxAt(item, index);
    const change = Math.hypot((p.x0 + p.x1 - q.x0 - q.x1) / 2, (p.y0 + p.y1 - q.y0 - q.y1) / 2) + Math.abs((p.x1 - p.x0) - (q.x1 - q.x0));
    if (change * model.fps >= MOVING * diagonal) moving += 1 / model.fps;
  }
  return moving;
}

function lowFpsFinding(ctx, item, layer, fps, at, how) {
  const why = mediaFrameRateOf(layer) > 0 && mediaFrameRateOf(layer) <= fps + 1e-6 ? `mediaFrameRate ${mediaFrameRateOf(layer)}` : `mediaSpeed ${constantSpeed(layer)} with nearest frames`;
  return {
    rule: "low_fps_motion", severity: "warn", itemId: item.id, at: sec(at),
    message: `${ctx.name(item)} shows ${sec(fps)} new frames a second (${why}) while ${how}: it stutters.`,
    measured: `${sec(fps)} new frames a second, ${how}`,
    required: `a large clip that moves (or whose footage moves) shows ${LOW_FPS} or more new frames a second`,
    fix: { kind: "hint", text: `Raise mediaFrameRate to ${LOW_FPS} or more (or remove it)${mediaFrameRateOf(layer) > 0 ? "" : ", set mediaInterpolation \"flow\" (new in-between frames, smoothest) or \"blend\", or slow it less"}, or keep the layer still over a still part of its file. A deliberate step-frame look: waive_check.` },
  };
}

/** low_fps_motion: a large clip at under LOW_FPS new frames a second while it or its footage moves. */
export function lowFpsMotion(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  const still = [];
  for (const item of model.items) {
    if (item.kind !== "video" || item.isMask || item.blur >= SOFT_BLUR) continue;
    const layer = layerOf(ctx, item);
    const fps = layer ? newFramesPerSecond(layer) : Infinity;
    if (!(fps < LOW_FPS)) continue;
    const shown = model.times.map((_, index) => index).filter((index) => shownAt(model, item, index));
    if (shown.length < 2) continue;
    if (movingTime(model, item) >= MOVING_MIN) findings.push(lowFpsFinding(ctx, item, layer, fps, model.times[shown[0]], "it moves on screen"));
    else still.push({ item, layer, fps, shown });
  }
  // A still layer stutters when its footage moves: compare the new frames it shows.
  if (!ctx.renderFrames || !still.length) return findings;
  return (async () => {
    for (const { item, layer, fps, shown } of still) {
      const from = model.times[shown[0]], to = model.times[shown.at(-1)];
      const steps = [];
      for (let time = from + 0.5 / fps; time <= to && steps.length < STEP_SAMPLES; time += 1 / fps) steps.push(Math.round(time * model.fps) / model.fps);
      if (steps.length < 3) continue;
      const frames = await aloneFrames(model, ctx, item, steps);
      const diffs = [];
      for (let k = 1; k < steps.length; k += 1) {
        if (!frames[k - 1] || !frames[k]) continue;
        const index = Math.min(model.times.length - 1, Math.round(steps[k] * model.fps));
        diffs.push(frameDiff(frames[k - 1], frames[k], scaled(model, visibleBoxAt(model, item, index), frames[k].width)));
      }
      if (diffs.length >= 2 && median(diffs) >= STEP_DIFF) findings.push(lowFpsFinding(ctx, item, layer, fps, from, `its footage moves (each new frame ${Math.round(median(diffs) * 100)}% different)`));
    }
    return findings;
  })();
}

// ---------------------------------------------------------------- jump_cut's look test

// A picture as GRID x GRID cells of mean luma, plus its mean color: enough to tell framing and light.
const GRID = 8;
function thumb(frame) {
  const cells = new Float32Array(GRID * GRID), counts = new Float32Array(GRID * GRID);
  const color = [0, 0, 0];
  for (let y = 0; y < frame.height; y += 1)
    for (let x = 0; x < frame.width; x += 1) {
      const at = (y * frame.width + x) * 4;
      const [r, g, b] = [frame.pixels[at], frame.pixels[at + 1], frame.pixels[at + 2]];
      const cell = Math.min(GRID - 1, Math.floor((y / frame.height) * GRID)) * GRID + Math.min(GRID - 1, Math.floor((x / frame.width) * GRID));
      cells[cell] += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      counts[cell] += 1;
      color[0] += r; color[1] += g; color[2] += b;
    }
  const total = frame.width * frame.height;
  for (let k = 0; k < cells.length; k += 1) cells[k] /= Math.max(1, counts[k]);
  return { cells, color: color.map((sum) => sum / Math.max(1, total)) };
}

// Framing alike: the cells' luma pattern (each picture's mean taken out) differs this little (0-1).
export const SAME_FRAMING = 0.08;
// Light and color alike: the mean colors differ this little (0-1, per channel on average).
export const SAME_LIGHT = 0.08;

/** How alike two frames look: {framing, light} differences (0 to 1). */
export function lookDifference(a, b) {
  const p = thumb(a), q = thumb(b);
  const mean = (cells) => cells.reduce((sum, value) => sum + value, 0) / cells.length;
  const mp = mean(p.cells), mq = mean(q.cells);
  let framing = 0;
  for (let k = 0; k < p.cells.length; k += 1) framing += Math.abs((p.cells[k] - mp) - (q.cells[k] - mq));
  const light = p.color.reduce((sum, value, k) => sum + Math.abs(value - q.color[k]), 0) / 3;
  return { framing: framing / p.cells.length / 255, light: light / 255 };
}
