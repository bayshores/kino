// Footage rules: a picture drawn bigger than its file, and footage cropped with no subject. They
// came from a trailer whose phone recording was zoomed to 3x and went soft, and whose background
// walk was drawn past the frame so the person's head was cut off.
//   soft_upscale     an image or video drawn at more than 1.3 output pixels per file pixel
//                    (warning; over 2, a gate)
//   crop_no_subject  footage drawn past the frame (over 8% of the file cut off on a side) with no
//                    subject marked (warning); with one marked, the subject cut off (gate)
//   jump_cut         back-to-back full-frame shots from one file, a little later in it and framed
//                    alike, with no transition (warning: the trailer cut one walking take every bar)
//   frozen_footage   a clip on screen whose picture stops: slowed to a stop, held before or after
//                    its play range, or a still put where a clip ends or starts (gate: the trailer
//                    froze one shot twice, and a reviewer called both weird). A
//                    freeze placed on a sound hit or a spoken line is a designed beat (a "Stop."
//                    freeze with a shutter): a warning, so only an accidental stall blocks.
//
// The agent service hands in ctx.mediaSizes {src: {width, height} | null} (the file's own size,
// from its library record) and ctx.scene (the raw scene). Without them the rules do not run
// (jump_cut needs only ctx.scene).
import { boxesAt, cropOnSource, insideShare } from "../../sourceView.js";
import { mediaFrameState, mediaPlaybackRange } from "../../playback.js";
import { sec } from "../analysis.js";
import { LOW_CONFIDENCE, lowRuns } from "../../pin.js";
import { boxAt, itemById } from "../model.js";
import { coveredAt, plateChanges } from "../techniques.js";
import { aloneFrames, lookDifference, SAME_FRAMING, SAME_LIGHT } from "./sourcePixels.js";
import { breakAfter, heardEdges, heardWords } from "./speech.js";

// The most file pixels one output pixel may stretch over before the picture looks soft.
export const UPSCALE_MAX = 1.3;
// Past this it is a gate. Between the two it is a warning: 1080p footage reframed to 9:16 at
// 1080x1920 is drawn 1.78x, which is common and only a little soft.
export const UPSCALE_GATE = 2;
// A blur this strong is meant to be soft (a blurred backdrop): neither rule judges it.
const SOFT_BLUR = 16;
// The most of the file a side may lose before the crop needs a reason (a marked subject).
export const CROP_MAX = 8;
// The least of a marked subject that must stay in the frame.
const SUBJECT_KEPT = 0.85;
// A marked box counts for file times this close to it.
const BOX_REACH = 0.5;
const SHOWN = 0.3;

const sizeOf = (ctx, item) => {
  const size = item.src ? ctx.mediaSizes?.[item.src] : null;
  return size?.width > 0 && size?.height > 0 ? size : null;
};
const soft = (item, index) => item.blur >= SOFT_BLUR || item.samples.blur[index] >= SOFT_BLUR;
const onFrame = (model, box) => box.x1 > 0 && box.y1 > 0 && box.x0 < model.width && box.y0 < model.height;

// ---------------------------------------------------------------- soft_upscale

// How fast a drawn size may change (share a second) before the eye cannot see its detail: the
// middle of a zoom-through is a blur of motion, while the shot it lands on and holds is seen.
const FAST_ZOOM = 0.6;

function zoomingFast(model, item, index) {
  const before = Math.max(0, index - 1), after = Math.min(model.times.length - 1, index + 1);
  if (before === after) return false;
  const width = (at) => item.samples.x1[at] - item.samples.x0[at];
  if (!(width(before) > 0 && width(after) > 0)) return false;
  return (Math.abs(Math.log(width(after) / width(before))) * model.fps) / (after - before) > FAST_ZOOM;
}

/** soft_upscale: a picture or clip drawn bigger than its file's pixels (it looks soft). */
export function softUpscale(model, ctx) {
  if (!ctx.mediaSizes) return [];
  const findings = [];
  for (const item of model.items) {
    if (item.kind !== "image" && item.kind !== "video") continue;
    const size = sizeOf(ctx, item);
    if (!size) continue;
    let worst = null;
    let over = 0;
    model.times.forEach((time, index) => {
      if (item.samples.opacity[index] < SHOWN || soft(item, index)) return;
      const box = boxAt(item, index);
      // The file is drawn inside its box at its own shape ("contain").
      const magnified = Math.min((box.x1 - box.x0) / size.width, (box.y1 - box.y0) / size.height);
      if (magnified <= UPSCALE_MAX || !onFrame(model, box) || zoomingFast(model, item, index) || coveredAt(model, item, index)) return;
      over += 1;
      if (!worst || magnified > worst.magnified) worst = { magnified, time, box };
    });
    // A single sample can be a rounding at a cut; two or more is seen.
    if (!worst || over < Math.min(2, model.times.length)) continue;
    const drawn = [Math.round(size.width * worst.magnified), Math.round(size.height * worst.magnified)];
    const keep = Math.floor((UPSCALE_MAX / worst.magnified) * 100);
    findings.push({
      rule: "soft_upscale", severity: worst.magnified > UPSCALE_GATE ? "error" : "warn", itemId: item.id, at: sec(worst.time),
      message: `${ctx.name(item)} is drawn ${sec(worst.magnified)}x bigger than its ${size.width}x${size.height} file at ${sec(worst.time)} s: it looks soft.`,
      measured: `${sec(worst.magnified)}x at ${sec(worst.time)} s (the file drawn ${drawn[0]}x${drawn[1]} px), over ${UPSCALE_MAX}x for ${sec(over / model.fps)} s`,
      required: `at most ${UPSCALE_MAX} output pixels per file pixel`,
      fix: { kind: "hint", text: `Lower ${ctx.name(item)}'s scale or zoom where it peaks to ${keep}% of it (${UPSCALE_MAX}x), or import a sharper file (at least ${Math.ceil(drawn[0] / UPSCALE_MAX)}x${Math.ceil(drawn[1] / UPSCALE_MAX)}). A blur of ${SOFT_BLUR} or more is left alone (a backdrop).` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- crop_no_subject

// The marked box nearest file time `at` (within BOX_REACH), or null.
export function boxNear(layer, at) {
  const exact = boxesAt(layer, at);
  if (exact.length) return exact[0].box;
  let best = null;
  for (const entry of layer.subjectBoxes?.boxes ?? [])
    if (Math.abs(entry.at - at) <= BOX_REACH && (!best || Math.abs(entry.at - at) < Math.abs(best.at - at))) best = entry;
  return best?.box ?? null;
}

/** crop_no_subject: footage drawn past the frame with no subject marked, or its subject cut off. */
export function cropNoSubject(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene || !ctx.mediaSizes) return [];
  const findings = [];
  const step = Math.max(1, Math.round(model.fps / 10));
  for (const item of model.items) {
    if (item.kind !== "video" || item.source?.componentPath || item.blur >= SOFT_BLUR) continue;
    const layer = scene.layers.find((entry) => entry.id === item.source?.layerId);
    const size = sizeOf(ctx, item);
    if (!layer || !size) continue;
    const marked = layer.subjectBoxes?.src === layer.src && layer.subjectBoxes.boxes.length > 0;
    let cropped = null, croppedCount = 0, lost = null;
    for (let index = 0; index < model.times.length; index += step) {
      if (item.samples.opacity[index] < SHOWN || soft(item, index) || coveredAt(model, item, index)) continue;
      const time = model.times[index];
      const crop = cropOnSource(scene, layer, time, size);
      // Only footage that fills the frame (a picture in a corner is cut_off_at_rest's).
      if (!crop || crop.covers < 0.9) continue;
      const [x0, y0, x1, y1] = crop.bounds;
      if (marked) {
        const box = boxNear(layer, mediaFrameState(layer, time).sourceTime);
        if (!box) continue;
        const share = insideShare(box, crop.bounds);
        if (share < SUBJECT_KEPT && (!lost || share < lost.share)) lost = { share, time, box };
        continue;
      }
      const sides = { left: x0, top: y0, right: 100 - x1, bottom: 100 - y1 };
      const side = Object.keys(sides).reduce((a, b) => (sides[b] > sides[a] ? b : a));
      if (sides[side] <= CROP_MAX) continue;
      croppedCount += 1;
      if (!cropped || sides[side] > cropped.cut) cropped = { cut: sides[side], side, time };
    }
    const look = `look {mode:"source", layer:${ctx.name(item)}, t}`;
    if (lost) {
      findings.push({
        rule: "crop_no_subject", severity: "error", itemId: item.id, at: sec(lost.time),
        message: `${ctx.name(item)} cuts off its marked subject at ${sec(lost.time)} s: only ${Math.round(lost.share * 100)}% of it is in the frame.`,
        measured: `${Math.round(lost.share * 100)}% of the subject box [${lost.box.join(", ")}] in the frame at ${sec(lost.time)} s`,
        required: `at least ${Math.round(SUBJECT_KEPT * 100)}% of the marked subject (a head whole) in the frame`,
        fix: { kind: "hint", text: `Move or scale ${ctx.name(item)} so the subject is in the frame at ${sec(lost.time)} s (${look} shows the crop), or zoom less.` },
      });
    } else if (cropped && croppedCount * step >= model.fps * 0.5) {
      findings.push({
        rule: "crop_no_subject", severity: "warn", itemId: item.id, at: sec(cropped.time),
        message: `${ctx.name(item)} is drawn past the frame with no subject marked: ${Math.round(cropped.cut)}% of the file is cut off at the ${cropped.side}, so the crop is arbitrary.`,
        measured: `${Math.round(cropped.cut)}% of the ${size.width}x${size.height} file cut off at the ${cropped.side} at ${sec(cropped.time)} s, no subject marked`,
        required: `at most ${CROP_MAX}% cut off a side, or a subject marked (mark_subject) that stays in the frame`,
        fix: { kind: "hint", text: `Fit ${ctx.name(item)} to the frame (zoom less), or ${look} and mark_subject the subject, then frame the crop on it (library guide framing).` },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- jump_cut

// How far around a cut a fade, move or blur makes it a transition, not a jump (seconds).
const JUMP_WINDOW = 0.2;
// A shot moving or growing this share of the frame diagonal around the cut is a transition.
const JUMP_MOVE = 0.03;
// Framing this close (size within 10%, centers within 5% of the diagonal) reads as the same shot.
const SAME_SIZE = 1.1;
const SAME_PLACE = 0.05;
// Source times closer than this are one continuous take split in two, not a jump.
const JUMP_MIN = 0.1;

// Whether an item fades, moves or blurs in the samples [from, to] around a cut.
function changesOverCut(model, item, from, to) {
  const diagonal = Math.hypot(model.width, model.height);
  const shown = [];
  for (let index = from; index <= to; index += 1) {
    const opacity = item.samples.opacity[index];
    if (opacity <= 0.05) continue;
    if (opacity < 0.95 || (item.samples.blur[index] ?? 0) > 2) return true;
    shown.push(boxAt(item, index));
  }
  if (shown.length < 2) return false;
  const [a, b] = [shown[0], shown.at(-1)];
  const moved = Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2);
  const grown = Math.abs((a.x1 - a.x0) - (b.x1 - b.x0));
  return Math.max(moved, grown) > JUMP_MOVE * diagonal;
}

/**
 * jump_cut: back-to-back full-frame shots from one file, a little later in it, framed alike, with
 * no transition. With rendered frames (ctx.renderFrames), the two shots' own pictures must also
 * look alike (framing and light, on small thumbnails): a walk that changes place and light between
 * the shots reads as a new shot, not a jump.
 */
export function jumpCut(model, ctx) {
  const found = jumpCandidates(model, ctx);
  if (!ctx.renderFrames || !found.length) return found.map(({ _before, _at, ...finding }) => finding);
  return (async () => {
    // Each clip drawn alone once, at all the times its cuts need (one render a clip, not one a frame).
    const wanted = new Map();
    for (const { _before, _at, itemIds } of found) {
      const [from, to] = itemIds.map((id) => itemById(model, id));
      wanted.set(from, [...(wanted.get(from) ?? []), _before]);
      wanted.set(to, [...(wanted.get(to) ?? []), _at]);
    }
    const frames = new Map();
    for (const [item, times] of wanted) {
      const rendered = await aloneFrames(model, ctx, item, times);
      times.forEach((time, index) => frames.set(`${item.id}@${time}`, rendered[index]));
    }
    const kept = [];
    for (const { _before, _at, ...finding } of found) {
      const [from, to] = finding.itemIds.map((id) => itemById(model, id));
      const a = frames.get(`${from.id}@${_before}`);
      const b = frames.get(`${to.id}@${_at}`);
      const look = a && b ? lookDifference(a, b) : null;
      if (look && (look.framing > SAME_FRAMING || look.light > SAME_LIGHT)) continue;
      if (look) finding.measured += `; the two pictures differ ${Math.round(look.framing * 100)}% in framing and ${Math.round(look.light * 100)}% in light (alike: ${SAME_FRAMING * 100}% or less)`;
      kept.push(finding);
    }
    return kept;
  })();
}

function jumpCandidates(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  const diagonal = Math.hypot(model.width, model.height);
  const reach = Math.max(1, Math.round(JUMP_WINDOW * model.fps));
  // The shot changes the checker already finds: the top full-frame picture changing.
  for (const change of plateChanges(model)) {
    const from = itemById(model, change.from), to = itemById(model, change.to);
    if (from?.kind !== "video" || to?.kind !== "video" || !from.src || from.src !== to.src) continue;
    const before = Math.max(0, change.index - 1), at = change.index;
    // Black or a smaller picture between them (a phone screen on black) is a cutaway, not a jump.
    if (from.samples.opacity[before] < 0.9) continue;
    const fromLayer = scene.layers.find((layer) => layer.id === from.source?.layerId);
    const toLayer = scene.layers.find((layer) => layer.id === to.source?.layerId);
    if (!fromLayer || !toLayer) continue;
    // The skip in the file: how much later the second shot is than the first would have played on to.
    const gap = mediaFrameState(toLayer, model.times[at]).sourceTime - mediaFrameState(fromLayer, model.times[before]).sourceTime - (model.times[at] - model.times[before]);
    if (!(gap >= JUMP_MIN)) continue;
    const window = [Math.max(0, at - reach), Math.min(model.times.length - 1, at + reach)];
    if (changesOverCut(model, from, ...window) || changesOverCut(model, to, ...window)) continue;
    const a = boxAt(from, before), b = boxAt(to, at);
    const size = (a.x1 - a.x0) / Math.max(1e-6, b.x1 - b.x0);
    const shift = Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2) / diagonal;
    if (size > SAME_SIZE || size < 1 / SAME_SIZE || shift > SAME_PLACE) continue;
    const time = model.times[at];
    findings.push({
      rule: "jump_cut", severity: "warn", itemId: to.id, itemIds: [from.id, to.id], at: sec(time), _before: model.times[before], _at: time,
      message: `${ctx.name(from)} cuts to ${ctx.name(to)} at ${sec(time)} s: the same file ${sec(gap)} s later, framed alike, reads as a jump cut.`,
      measured: `one file, ${sec(gap)} s on in it, both full frame and framed alike, no fade, move or blur over the cut`,
      required: "a different shot between them, a dissolve, or a clearly different moment or framing",
      fix: { kind: "hint", text: "Put a different shot between them (a cutaway: another file, the phone screen, a detail), or join them with a short dissolve (about 0.3 s, both shots overlapping), or pick moments where the place clearly changes (or punch in 15% or more on the second)." },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- frozen_footage

// A picture held this long reads as a freeze (a stopped clip, not a beat).
const FREEZE_MIN = 0.3;
// Over this window the file must move on at least this share of the time that passed.
const FREEZE_WINDOW = 0.25;
const FREEZE_SPEED = 0.2;
// Footage this big on screen is what the eye watches.
const FREEZE_AREA = 0.3;
// A still in the clip's own place: size within 10%, center within 5% of the diagonal.
const STILL_SIZE = 1.1;
const STILL_PLACE = 0.05;

const shareOfFrame = (model, box) => Math.max(0, Math.min(model.width, box.x1) - Math.max(0, box.x0)) * Math.max(0, Math.min(model.height, box.y1) - Math.max(0, box.y0)) / (model.width * model.height);
const onScreen = (model, item, index) => item.samples.opacity[index] >= 0.5 && !coveredAt(model, item, index);
const watched = (model, item, index) => onScreen(model, item, index) && shareOfFrame(model, boxAt(item, index)) >= FREEZE_AREA;

/** When `item` came on screen (scene seconds) in the stretch that holds sample `index`: its cut-in. */
export function cutInOf(model, item, index) {
  let at = index;
  while (at > 0 && onScreen(model, item, at - 1)) at -= 1;
  return model.times[at];
}

// The runs of samples [from, to] where `test(index)` holds for FREEZE_MIN or longer.
function longRuns(model, test) {
  const found = [];
  let start = -1;
  for (let index = 0; index <= model.times.length; index += 1) {
    if (index < model.times.length && test(index)) { if (start < 0) start = index; continue; }
    if (start >= 0 && model.times[index - 1] - model.times[start] + 1 / model.fps >= FREEZE_MIN) found.push([start, index - 1]);
    start = -1;
  }
  return found;
}

// A freeze that starts this close to a sound hit or the start of a spoken line is placed on it.
export const CUE_WINDOW = 0.2;
// A sound this short is a hit (a shutter, a whoosh), not a song or a voiceover.
const HIT_SECONDS = 3;

/**
 * What a freeze starting at `time` (scene seconds) is placed on: "a sound hit" (a short sound
 * layer starting there), "a spoken line" (a heard line's first word), or null (an accident).
 */
export function freezeCue(ctx, scene, time) {
  for (const layer of scene?.layers ?? []) {
    if (layer.type !== "audio" || !layer.src || layer.enabled === false) continue;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (range && range.end - range.start <= HIT_SECONDS && Math.abs(range.start - time) <= CUE_WINDOW) return "a sound hit";
  }
  for (const voice of heardEdges(ctx)) {
    if (!voice.words?.length) continue;
    const words = heardWords(voice);
    if (words.some((word, index) => (index === 0 || breakAfter(words[index - 1], word)) && Math.abs(word.start - time) <= CUE_WINDOW)) return "a spoken line";
  }
  return null;
}

// `onCut`: the freeze starts at the shot's own cut-in (a clip held before its play range, a still
// where the clip starts). Cuts sit on hits and words, so a cue there proves nothing: it blocks.
function frozenFinding(ctx, item, from, to, model, how, other = null, onCut = false) {
  const start = model.times[from], end = model.times[to] + 1 / model.fps;
  const cue = onCut ? null : freezeCue(ctx, ctx.scene ?? ctx.speechScene, start);
  return {
    rule: "frozen_footage", severity: cue ? "warn" : "error", itemId: item.id, itemIds: other ? [other.id, item.id] : [item.id], at: sec(start),
    message: `${ctx.name(item)} shows a frozen picture from ${sec(start)} to ${sec(end)} s (${how})${cue ? `, placed on ${cue}: a designed freeze warns, an accidental stall blocks` : ""}.`,
    measured: `${how}, ${sec(end - start)} s`,
    required: `footage on screen keeps moving (a held picture under ${FREEZE_MIN} s), or waive_check a deliberate freeze frame`,
    fix: { kind: "hint", text: "Let the clip play through: remove the stop or the still, start it earlier in its file (mediaOffset) or slow it a little (mediaSpeed 0.85 to 1) so its footage lasts to the cut, end the shot sooner, or cut away to another shot." },
  };
}

/**
 * True when a freeze of `layerId` from `from` to `to` (seconds) is a planned freeze frame: it sits
 * inside a move tagged freeze-frame (freeze-shutter) that froze this layer.
 */
export function plannedFreeze(scene, layerId, from, to) {
  const layer = scene?.layers?.find((entry) => entry.id === layerId);
  if (!layer) return false;
  return (scene.moves ?? []).some((record) => (record.tags ?? []).includes("freeze-frame")
    && (layer.animations ?? []).some((animation) => String(animation.id ?? "").startsWith(`${record.id}.`))
    && from >= record.start - FREEZE_WINDOW - 0.05 && to <= record.end + 0.05);
}

/** frozen_footage: a clip on screen whose picture stops (a speed of 0, a held first or last frame, or a still of it). */
export function frozenFootage(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  const layerOf = (item) => scene.layers.find((layer) => layer.id === item.source?.layerId);
  const back = Math.max(1, Math.round(FREEZE_WINDOW * model.fps));
  for (const item of model.items) {
    const layer = item.kind === "video" ? layerOf(item) : null;
    if (!layer) continue;
    const sourceAt = (index) => mediaFrameState(layer, model.times[index]).sourceTime;
    const stopped = (index) => {
      const before = Math.max(0, index - back);
      const passed = model.times[index] - model.times[before];
      return passed > 0 && Math.abs(sourceAt(index) - sourceAt(before)) < FREEZE_SPEED * passed;
    };
    for (const [from, to] of longRuns(model, (index) => watched(model, item, index) && stopped(index))) {
      // A freeze-shutter's held frame is the point of the move, not a stall.
      if (plannedFreeze(scene, layer.id, model.times[Math.max(0, from - back)], model.times[to])) continue;
      const start = Math.max(0, from - back);
      const onCut = model.times[start] - cutInOf(model, item, from) <= CUE_WINDOW;
      findings.push(frozenFinding(ctx, item, start, to, model, "the clip stops: no new frames from its file", null, onCut));
    }
  }
  // A still in a clip's own place where the clip ends or starts: a freeze frame made of a picture.
  const diagonal = Math.hypot(model.width, model.height);
  for (const change of plateChanges(model)) {
    const from = itemById(model, change.from), to = itemById(model, change.to);
    const pair = from?.kind === "video" && to?.kind === "image" ? [from, to] : from?.kind === "image" && to?.kind === "video" ? [to, from] : null;
    if (!pair) continue;
    const [clip, still] = pair;
    const near = still === to ? change.index : Math.max(0, change.index - 1), far = still === to ? Math.max(0, change.index - 1) : change.index;
    const a = boxAt(clip, far), b = boxAt(still, near);
    const size = (a.x1 - a.x0) / Math.max(1e-6, b.x1 - b.x0);
    const shift = Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2) / diagonal;
    if (size > STILL_SIZE || size < 1 / STILL_SIZE || shift > STILL_PLACE) continue;
    const run = longRuns(model, (index) => watched(model, still, index)).find(([start, end]) => start <= near && near <= end);
    if (run) findings.push(frozenFinding(ctx, still, run[0], run[1], model, `a still in the place of ${ctx.name(clip)}, right where it ${still === to ? "ends" : "starts"}`, clip, still === from));
  }
  return findings;
}

// ---------------------------------------------------------------- track_lost

/**
 * track_lost: a pinned layer (pin.js) follows a track whose confidence stays under 0.5 for more
 * than 0.3 s; the layer holds its last good place there, so it may sit off the object.
 */
export function trackLost(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene) return [];
  const findings = [];
  for (const layer of scene.layers ?? []) {
    if (!layer.pin) continue;
    const runs = lowRuns(layer.pin.path, 0.3);
    if (!runs.length) continue;
    const item = model.items.find((entry) => entry.source?.layerId === layer.id && !entry.source.instanceId);
    const where = runs.map((run) => `${sec(run.start)}-${sec(run.end)} s`).join(", ");
    findings.push({
      rule: "track_lost", severity: "warn", itemId: item?.id ?? layer.id, at: sec(runs[0].start),
      message: `${layer.name} follows track "${layer.pin.track}", which is unsure at ${where}: the layer holds its last good place there and may sit off the object.`,
      measured: `track confidence under ${LOW_CONFIDENCE} at ${where}`,
      required: `confidence ${LOW_CONFIDENCE} or more, or no stretch under it longer than 0.3 s`,
      fix: { kind: "hint", text: `Track again from a clearer moment (track {at}) or a box on more texture, hide ${layer.name} there, or waive_check if holding still is fine.` },
    });
  }
  return findings;
}
