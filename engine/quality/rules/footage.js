// Footage rules: a picture drawn bigger than its file, and footage cropped with no subject. They
// came from a trailer whose phone recording was zoomed to 3x and went soft, and whose background
// walk was drawn past the frame so the person's head was cut off.
//   soft_upscale     an image or video drawn at more than 1.3 output pixels per file pixel
//                    (warning; over 2, a gate)
//   crop_no_subject  footage drawn past the frame (over 8% of the file cut off on a side) with no
//                    subject marked (warning); with one marked, the subject cut off (gate). A face
//                    the detector found whole in the file and the crop cuts, nothing marked, is a
//                    gate; a found face cut while the mark misses it warns (a 9:16 crop of 16:9
//                    footage cut 12 whole faces with a 20% box marked by hand beside them). Where
//                    no face was found, the largest saliency box is what kino sees: a crop keeping
//                    under 85% of it is a gate, unless a mark stands for it (a part mark, or one
//                    holding 85% of it; a mouth marked inside a face does not). On drawn faces
//                    saliency found 38 of 55 (precision 0.63), so the words say "what kino sees".
//   narrow_window    footage filling the frame through a window under 40% of its file's width
//                    where no face and no saliency box was found (warning: kino has nothing to
//                    tell an eye strip from a cut face there)
//   burned_in_mark   a layer whose window still shows a logo or site name burned into the file
//                    (warning; the marks come from the footage finder's scan)
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
import { effectiveMediaDuration, mediaFrameState, mediaPlaybackRange } from "../../playback.js";
import { sec } from "../analysis.js";
import { constantSpeed } from "../../mediaTime.js";
import { LOW_CONFIDENCE, lowRuns } from "../../pin.js";
import { inPicture, positionAt } from "../../recording.js";
import { boxAt, itemById, visibleBoxAt } from "../model.js";
import { coveredAt, plateChanges } from "../techniques.js";
import { aloneFrames, lookDifference, SAME_FRAMING, SAME_LIGHT } from "./sourcePixels.js";
import { breakAfter, heardEdges, heardWords } from "./speech.js";
import { peopleNear } from "./people.js";
import { markHoldsSalient, sampleBoxes, SUBJECT_KEPT } from "../../footage/layout.js";
import { cropPast, markSpan, markWays, MARK_SECONDS, MARK_SEEN, MARK_ZOOM_MOST } from "../../footage/burned.js";

// The most file pixels one output pixel may stretch over before the picture looks soft.
export const UPSCALE_MAX = 1.3;
// Past this it is a gate. Between the two it is a warning: 1080p footage reframed to 9:16 at
// 1080x1920 is drawn 1.78x, which is common and only a little soft.
export const UPSCALE_GATE = 2;
// A blur this strong is meant to be soft (a blurred backdrop): neither rule judges it.
export const SOFT_BLUR = 16;
// The most of the file a side may lose before the crop needs a reason (a marked subject).
export const CROP_MAX = 8;
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
  // Layers that draw one file at one magnification are one finding that names them all (nine
  // 960x540 elements on a 1920x1080 scene are one fact, not nine).
  const byDrawing = new Map();
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
    const key = `${item.src} ${sec(worst.magnified)}`;
    if (!byDrawing.has(key)) byDrawing.set(key, []);
    byDrawing.get(key).push({ item, size, worst, over });
  }
  for (const group of byDrawing.values()) {
    const [{ item, size, worst, over }] = group;
    const items = group.map((entry) => entry.item);
    const names = items.length > 1 ? `${items.slice(0, 4).map((entry) => ctx.name(entry)).join(", ")}${items.length > 4 ? ` and ${items.length - 4} more` : ""}` : ctx.name(item);
    const drawn = [Math.round(size.width * worst.magnified), Math.round(size.height * worst.magnified)];
    const keep = Math.floor((UPSCALE_MAX / worst.magnified) * 100);
    findings.push({
      rule: "soft_upscale", severity: worst.magnified > UPSCALE_GATE ? "error" : "warn", itemId: item.id, ...(items.length > 1 ? { itemIds: items.map((entry) => entry.id) } : {}), at: sec(worst.time),
      message: items.length > 1
        ? `${items.length} layers (${names}) draw one ${size.width}x${size.height} file ${sec(worst.magnified)}x bigger than its pixels: they look soft.`
        : `${names} is drawn ${sec(worst.magnified)}x bigger than its ${size.width}x${size.height} file at ${sec(worst.time)} s: it looks soft.`,
      measured: `${sec(worst.magnified)}x at ${sec(worst.time)} s (the file drawn ${drawn[0]}x${drawn[1]} px), over ${UPSCALE_MAX}x for ${sec(over / model.fps)} s${items.length > 1 ? `, on ${items.length} layers` : ""}`,
      required: `at most ${UPSCALE_MAX} output pixels per file pixel`,
      fix: { kind: "hint", text: `Lower ${names}'s scale or zoom where it peaks to ${keep}% of it (${UPSCALE_MAX}x), or import a sharper file (at least ${Math.ceil(drawn[0] / UPSCALE_MAX)}x${Math.ceil(drawn[1] / UPSCALE_MAX)}). A blur of ${SOFT_BLUR} or more is left alone (a backdrop).` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- crop_no_subject

// The mark ({at, box, part?}) nearest file time `at` (within BOX_REACH), or null.
function markNear(layer, at) {
  // Marks made on another file (before replace_media) are not this file's subject.
  if (layer.subjectBoxes?.src !== layer.src) return null;
  const exact = boxesAt(layer, at);
  if (exact.length) return exact[0];
  let best = null;
  for (const entry of layer.subjectBoxes?.boxes ?? [])
    if (Math.abs(entry.at - at) <= BOX_REACH && (!best || Math.abs(entry.at - at) < Math.abs(best.at - at))) best = entry;
  return best;
}

// The marked box nearest file time `at` (within BOX_REACH), or null.
export function boxNear(layer, at) {
  return markNear(layer, at)?.box ?? null;
}

// A source look reaches a file second this far (seconds), as a measured sample does (footage/layout.js).
export const LOOK_REACH = 0.5;

// The stretch of the file a layer plays, [from, to] in file seconds (as frameShot reads it).
function playedStretch(scene, layer) {
  const range = mediaPlaybackRange(layer, scene.duration);
  const from = mediaFrameState(layer, range?.start ?? 0).sourceTime;
  return [from, Math.max(from, mediaFrameState(layer, range?.end ?? scene.duration).sourceTime)];
}

/**
 * Whether the agent looked at the file stretch [from, to] (file seconds) of `layer`:
 * `sourceLooks` is {layerId: {src, at: [file seconds]}} (look {mode:"source"}); a look counts when
 * it was of this same file and one of its moments lies in the stretch, give or take LOOK_REACH.
 * A look through another layer of the same file counts too (a copy in another scene or shape shows
 * the file the agent already saw). A mark made without that look is a guess from the layer's
 * position, not a seen subject.
 */
export function seenMark(layer, sourceLooks, from, to, shots = null) {
  // A look inside the same shot of the file (no cut between it and the stretch) saw the same
  // picture: a director's mark was refused although a look had shown a nearby second
  // (.scratch/ceiling/a/result.md friction 8). shots: the file's measured [{start, end}].
  const same = (Array.isArray(shots) ? shots : []).filter((shot) => shot.start <= to + 1e-6 && shot.end >= from - 1e-6);
  return Object.values(sourceLooks ?? {}).some((look) => look?.src === layer.src
    && (look.at ?? []).some((at) => (at >= from - LOOK_REACH && at <= to + LOOK_REACH) || same.some((shot) => at >= shot.start - 1e-6 && at <= shot.end + 1e-6)));
}

/**
 * The people samples of a file ({samples}) a layer plays: those in the file stretch [from, to],
 * else the one nearest its middle within half a second plus half the stretch (as frame_shot reads
 * them). Answers the same shape, or the input when it has no samples.
 */
export function playedSamples(found, from, to) {
  const samples = found?.samples;
  if (!Array.isArray(samples) || !samples.length) return found;
  let inside = samples.filter((sample) => Number.isFinite(sample?.t) && sample.t >= from - 1e-6 && sample.t <= to + 1e-6);
  if (!inside.length) {
    const middle = (from + to) / 2;
    const closest = samples.filter((sample) => Number.isFinite(sample?.t)).reduce((best, sample) => (!best || Math.abs(sample.t - middle) < Math.abs(best.t - middle) ? sample : best), null);
    inside = closest && Math.abs(closest.t - middle) <= SALIENT_REACH + (to - from) / 2 ? [closest] : [];
  }
  return { ...found, samples: inside };
}

const hasMarks = (layer) => layer.subjectBoxes?.src === layer.src && (layer.subjectBoxes.boxes?.length ?? 0) > 0;

// A face box this close (% of the file) to a file edge reaches that edge.
const FILE_EDGE = 1;
// A found face cut this long (seconds) is seen, not a flicker at a cut.
const FACE_CUT_SECONDS = 0.2;
// A face under this share inside the mark is one the mark misses.
const MARK_MISSES = 0.5;
// A mark with this share inside the face box is on that face (a part of it, as in an eye strip).
const MARK_ON_FACE = 0.9;
const SIDES = ["left", "top", "right", "bottom"];

/**
 * The faces found near file time `at`, as [x, y, w, h] in % of the file. Reads a subjects-v1
 * sample's tagged `subjects` ({box, kind}; a "saliency" box is where the eye goes, never a face)
 * and a people-v1 sample's plain `faces` ([x, y, w, h] fractions).
 */
export function facesAt(found, at) {
  return sampleBoxes(peopleNear(found, at)).filter((entry) => entry.kind === "face").map((entry) => entry.box.map((value) => value * 100));
}

// A sample this close (seconds) to a short shot's middle stands in when none falls in it (as frame_shot reads them).
const SALIENT_REACH = 0.5;

/**
 * What kino sees at file second `second` of a shot with no face found: the largest saliency box
 * (subjects-v1) of the sample nearest it in the stretch [from, to] the layer plays (the samples
 * frame_shot aims at; with none inside, the one nearest the stretch's middle), as [x, y, w, h] in
 * % of the file, or null. A face in any of those samples makes the shot face-led (null), as
 * frame_shot reads it. A box touching three or more file edges is the whole picture, no subject.
 * Saliency is where the eye goes, never a face.
 */
export function salientAt(found, second, from, to) {
  const measured = (found?.samples ?? []).filter((sample) => Number.isFinite(sample?.t));
  let stretch = measured.filter((sample) => sample.t >= from - 1e-6 && sample.t <= to + 1e-6);
  if (!stretch.length) {
    const middle = (from + to) / 2;
    let closest = null;
    for (const entry of measured) if (Math.abs(entry.t - middle) <= SALIENT_REACH + (to - from) / 2 && (!closest || Math.abs(entry.t - middle) < Math.abs(closest.t - middle))) closest = entry;
    stretch = closest ? [closest] : [];
  }
  if (stretch.some((entry) => sampleBoxes(entry).some((box) => box.kind === "face"))) return null;
  const boxes = sampleBoxes(peopleNear({ samples: stretch }, second));
  let largest = null;
  for (const { box, kind } of boxes) {
    const percent = box.map((value) => value * 100);
    if (kind !== "saliency" || !faceKept(percent, [0, 0, 100, 100])) continue;
    if (!largest || percent[2] * percent[3] > largest[2] * largest[3]) largest = percent;
  }
  return largest;
}

/**
 * How much of a face ([x, y, w, h] in %) the crop `bounds` ([x0, y0, x1, y1] in %) keeps, and the
 * side it cuts most: {share, side}. The face box is what the detector saw in the file, so the
 * share is measured against the crop's own bounds: a face the file already cut (touching a file
 * edge) is judged by what the crop keeps of that box. Only a face touching three or more file
 * edges is a filmed strip (an eye or mouth close-up): null, the crop did not make that cut.
 */
export function faceKept(face, bounds) {
  const [x, y, w, h] = face;
  const touching = [x <= FILE_EDGE, y <= FILE_EDGE, x + w >= 100 - FILE_EDGE, y + h >= 100 - FILE_EDGE].filter(Boolean).length;
  if (touching >= 3 || !(w > 0 && h > 0)) return null;
  const lost = [Math.max(0, bounds[0] - x) / w, Math.max(0, bounds[1] - y) / h, Math.max(0, x + w - bounds[2]) / w, Math.max(0, y + h - bounds[3]) / h];
  return { share: insideShare(face, bounds), side: SIDES[lost.indexOf(Math.max(...lost))] };
}

const boxText = (box) => `[${box.map((value) => Math.round(value)).join(", ")}]`;

// Whether the layer keeps one place and size on screen the whole scene (within a pixel). kino's own
// framing (the agent's frame_shot op) places a still layer; one an animation moves or scales was
// framed by hand on purpose, so the op is offered there but not applied by check {fix:"auto"}.
export function heldStill(model, item) {
  const first = boxAt(item, 0);
  return model.times.every((_, index) => {
    const box = boxAt(item, index);
    return ["x0", "y0", "x1", "y1"].every((key) => Math.abs(box[key] - first[key]) <= 1);
  });
}

// The fix for a face cut or a window kino cannot see into: kino's own framing of the layer
// (frame_shot), with `text` as the words when the op cannot be offered (a layer inside a group).
// `auto` false offers it without applying it: narrow_window found no problem, only a window kino
// cannot see into (scenery, b-roll and a requested vertical edit are fine), so a person's or an
// agent's look decides before a deliberate crop becomes a card.
const frameFix = (model, item, text, auto = true) => {
  const still = heldStill(model, item);
  return { kind: "frame_shot", itemId: item.id, auto: auto && still, still, text };
};

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
    // A screen recording's subject is its pointer: a 10% box around where it was (recording.js).
    // A pointer outside a window recording's picture is no subject (null skips that moment).
    const pointer = !layer.subjectBoxes && layer.recording?.moves?.length ? (second) => {
      const [x, y] = positionAt(layer.recording, second);
      if (!inPicture(layer.recording, x, y)) return null;
      const [width, height] = layer.recording.frame;
      return [Math.max(0, (x / width) * 100 - 5), Math.max(0, (y / height) * 100 - 5), 10, 10].map((value) => Math.round(value * 10) / 10);
    } : null;
    const [playsFrom, playsTo] = playedStretch(scene, layer);
    // Only the samples of the stretch the layer plays: a face or a crop at a file second the layer
    // never shows is not this shot's (a director's crop was judged at a second before its mediaOffset,
    // .scratch/ceiling/c/result.md friction 2).
    const found = playedSamples(ctx.people?.[layer.src], playsFrom, playsTo);
    // On a file with no faces found, a mark made without a look at the file is a guess from the
    // layer's position, so it does not count as marked (the crop is judged as if nothing were marked).
    const faceFound = (found?.samples ?? []).some((sample) => sampleBoxes(sample).some((entry) => entry.kind === "face"));
    const unlooked = hasMarks(layer) && !faceFound && !seenMark(layer, ctx.sourceLooks, playsFrom, playsTo, ctx.mediaShots?.[layer.src]);
    const marked = (hasMarks(layer) && !unlooked) || Boolean(pointer);
    let cropped = null, croppedCount = 0, lost = null;
    // Faces the detector found whole in the file that the crop cuts: with no mark (faceCut), or
    // while the mark sits somewhere else (missed).
    // What kino sees (a saliency box where no face was found) that the crop cuts.
    const faceCut = { count: 0, worst: null }, missed = { count: 0, worst: null }, salientCut = { count: 0, worst: null };
    for (let index = 0; index < model.times.length; index += step) {
      if (item.samples.opacity[index] < SHOWN || soft(item, index) || coveredAt(model, item, index)) continue;
      const time = model.times[index];
      const crop = cropOnSource(scene, layer, time, size);
      // Only footage that fills the frame (a picture in a corner is cut_off_at_rest's).
      if (!crop || crop.covers < 0.9) continue;
      const [x0, y0, x1, y1] = crop.bounds;
      const second = mediaFrameState(layer, time).sourceTime;
      const entry = marked && !pointer ? markNear(layer, second) : null;
      const mark = marked ? (pointer ? pointer(second) : entry?.box ?? null) : null;
      const facesHere = found ? facesAt(found, second) : [];
      let cutHere = null, missedHere = null;
      for (const face of facesHere) {
        const kept = faceKept(face, crop.bounds);
        if (!kept || kept.share >= SUBJECT_KEPT) continue;
        const cut = { ...kept, face, time, second };
        if (!marked) { if (!cutHere || cut.share < cutHere.share) cutHere = cut; continue; }
        // A mark wholly inside the face is the part the agent means (an eye strip), not a miss.
        const onFace = mark && insideShare(mark, [face[0], face[1], face[0] + face[2], face[1] + face[3]]) >= MARK_ON_FACE;
        // A face wholly outside the window is a framing choice; only a face the window slices is a miss.
        const sliced = kept.share > 0;
        if (mark && sliced && !onFace &&insideShare(face, [mark[0], mark[1], mark[0] + mark[2], mark[1] + mark[3]]) < MARK_MISSES && (!missedHere || cut.share < missedHere.share)) missedHere = { ...cut, mark };
      }
      for (const [tally, cut] of [[faceCut, cutHere], [missed, missedHere]]) {
        if (!cut) continue;
        tally.count += 1;
        if (!tally.worst || cut.share < tally.worst.share) tally.worst = cut;
      }
      // A counted mark elsewhere in the shot but none near this moment: the agent chose the subject.
      if (marked && !mark) continue;
      // Where no face was found, what kino sees is the subject unless a mark stands for it: a part
      // mark (a deliberate part crop), or one that holds SUBJECT_KEPT of it or sits elsewhere.
      const salient = !pointer && !facesHere.length ? salientAt(found, second, playsFrom, playsTo) : null;
      if (mark && (!salient || entry?.part || markHoldsSalient(mark, salient))) {
        const share = insideShare(mark, crop.bounds);
        if (share < SUBJECT_KEPT && (!lost || share < lost.share)) lost = { share, time, box: mark };
        continue;
      }
      if (salient) {
        const kept = faceKept(salient, crop.bounds);
        if (kept.share < SUBJECT_KEPT) {
          salientCut.count += 1;
          if (!salientCut.worst || kept.share < salientCut.worst.share) salientCut.worst = { ...kept, box: salient, mark, time, second };
        }
        continue;
      }
      const sides = { left: x0, top: y0, right: 100 - x1, bottom: 100 - y1 };
      const side = Object.keys(sides).reduce((a, b) => (sides[b] > sides[a] ? b : a));
      if (sides[side] <= CROP_MAX) continue;
      croppedCount += 1;
      if (!cropped || sides[side] > cropped.cut) cropped = { cut: sides[side], side, time };
    }
    const look = `look {mode:"source", layer:${ctx.name(item)}, t}`;
    const seen = (tally) => tally.worst && tally.count * step >= model.fps * FACE_CUT_SECONDS - 1e-6;
    if (seen(faceCut)) {
      const cut = faceCut.worst;
      findings.push({
        rule: "crop_no_subject", severity: "error", itemId: item.id, at: sec(cut.time),
        message: `${ctx.name(item)} cuts a face found whole in its file at the ${cut.side} at ${sec(cut.time)} s (scene; file ${sec(cut.second)} s): only ${Math.round(cut.share * 100)}% of it is in the frame. If the cut is meant (an eye strip), mark_subject the part you mean.`,
        measured: `${Math.round(cut.share * 100)}% of the face box ${boxText(cut.face)} (file ${sec(cut.second)} s) in the frame at ${sec(cut.time)} s, cut at the ${cut.side}, for ${sec((faceCut.count * step) / model.fps)} s, no subject marked`,
        required: `at least ${Math.round(SUBJECT_KEPT * 100)}% of a face found whole in the file in the frame; if the cut is meant (an eye strip), mark_subject the part you mean`,
        // kino's own framing of the layer: automatic when nothing moves it.
        fix: frameFix(model, item, `Move or scale ${ctx.name(item)} so the face is in the frame at ${sec(cut.time)} s (${look} shows the crop), or fit the file to the frame; if the cut is meant (an eye strip), mark_subject the part you mean.`),
      });
      continue;
    }
    if (seen(salientCut)) {
      const cut = salientCut.worst;
      const name = ctx.name(item);
      const call = `edit {"ops":[{"op":"frame_shot","layers":[${JSON.stringify(String(name).replace(/^"(.*)"$/, "$1"))}]}]}`;
      const held = cut.mark ? `; the mark ${boxText(cut.mark)} holds ${Math.round(insideShare(cut.box, [cut.mark[0], cut.mark[1], cut.mark[0] + cut.mark[2], cut.mark[1] + cut.mark[3]]) * 100)}% of it` : "";
      const cutText = `${name} cuts what kino sees in its file at the ${cut.side} at ${sec(cut.time)} s (scene; file ${sec(cut.second)} s): ${Math.round(cut.share * 100)}% of it is in the frame (a saliency box, not a face)`;
      // A mark nobody looked at does not count here, yet frame_shot would crop on it: the look comes first.
      const lookCall = `look {mode:"source", layer:${name}, t:${sec(cut.time)}}`;
      findings.push({
        rule: "crop_no_subject", severity: "error", itemId: item.id, at: sec(cut.time),
        message: unlooked
          ? `${cutText}, and its mark was never looked at: ${lookCall} first, then mark what the shot is about.`
          : `${cutText}. ${call} keeps it whole, as a card when it is wider than the frame; a deliberate part: mark_subject with part.`,
        measured: `${Math.round(cut.share * 100)}% of the saliency box ${boxText(cut.box)} (file ${sec(cut.second)} s) in the frame at ${sec(cut.time)} s, cut at the ${cut.side}, for ${sec((salientCut.count * step) / model.fps)} s, no face found${held}${unlooked ? ", marked without a look" : ""}`,
        required: `at least ${Math.round(SUBJECT_KEPT * 100)}% of what kino sees (the largest saliency box where no face is found) in the frame, or a mark that holds it (part:"<name>" for a deliberate part)`,
        fix: unlooked
          ? { kind: "hint", text: `${lookCall}, then mark_subject what the shot is about (part:"<name>" for a deliberate part) and frame_shot crops on it.` }
          : frameFix(model, item, `${call} keeps what kino sees whole (a card when it is wider than the frame); ${look} shows it; a deliberate part: mark_subject with part.`),
      });
      continue;
    }
    if (!lost && seen(missed)) {
      const cut = missed.worst;
      findings.push({
        rule: "crop_no_subject", severity: "warn", itemId: item.id, at: sec(cut.time),
        message: `${ctx.name(item)} cuts a face found whole in its file at the ${cut.side} at ${sec(cut.time)} s while its marked subject is elsewhere: is the mark on the right part?`,
        measured: `${Math.round(cut.share * 100)}% of the face box ${boxText(cut.face)} in the frame at ${sec(cut.time)} s; the marked subject ${boxText(cut.mark)} holds under ${Math.round(MARK_MISSES * 100)}% of it`,
        required: `a face found whole in the file kept ${Math.round(SUBJECT_KEPT * 100)}% in the frame, or the mark on it`,
        fix: { kind: "hint", text: `${look}, then mark_subject the face (or the part you mean) and frame the crop on it.` },
      });
      continue;
    }
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
        message: `${ctx.name(item)} is drawn past the frame with no subject marked${unlooked ? " (marked without a look)" : ""}: ${Math.round(cropped.cut)}% of the file is cut off at the ${cropped.side}, so the crop is arbitrary.`,
        measured: `${Math.round(cropped.cut)}% of the ${size.width}x${size.height} file cut off at the ${cropped.side} at ${sec(cropped.time)} s, no subject marked`,
        required: `at most ${CROP_MAX}% cut off a side, or a subject marked (mark_subject) that stays in the frame`,
        fix: { kind: "hint", text: `Fit ${ctx.name(item)} to the frame (zoom less), or ${look} and mark_subject the subject, then frame the crop on it (library guide framing).` },
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- narrow_window

// The least of the file's width a full-frame window keeps before kino needs to see a face in it
// (the share footage/layout.js asks of a face-led crop).
export const NARROW_WINDOW = 40;

/** narrow_window: footage seen through a window under 40% of its file's width with no face found. */
export function narrowWindow(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene || !ctx.mediaSizes) return [];
  const findings = [];
  const step = Math.max(1, Math.round(model.fps / 10));
  for (const item of model.items) {
    if (item.kind !== "video" || item.source?.componentPath || item.blur >= SOFT_BLUR) continue;
    const layer = scene.layers.find((entry) => entry.id === item.source?.layerId);
    const size = sizeOf(ctx, item);
    // A screen recording's detail crop is read by its pointer (screen_unreadable asks for them).
    if (!layer || !size || layer.recording) continue;
    const found = ctx.people?.[layer.src];
    // A mark the agent made after looking at this stretch of the file clears a window that keeps it.
    const [playsFrom, playsTo] = playedStretch(scene, layer);
    const looked = seenMark(layer, ctx.sourceLooks, playsFrom, playsTo, ctx.mediaShots?.[layer.src]);
    let count = 0, narrowest = null, shownFrom = null, shownTo = null;
    for (let index = 0; index < model.times.length; index += step) {
      if (item.samples.opacity[index] < SHOWN || soft(item, index) || coveredAt(model, item, index)) continue;
      const time = model.times[index];
      shownFrom ??= time;
      shownTo = time;
      const crop = cropOnSource(scene, layer, time, size);
      if (!crop || crop.covers < 0.9) continue;
      const width = crop.bounds[2] - crop.bounds[0];
      if (width >= NARROW_WINDOW) continue;
      const second = mediaFrameState(layer, time).sourceTime;
      // A face found here is judged by crop_no_subject; only a window kino cannot see into warns.
      if (found && facesAt(found, second).length) continue;
      // So is what kino sees where no face was found (a saliency box): only a window kino has nothing for warns.
      if (salientAt(found, second, playsFrom, playsTo)) continue;
      // A seen mark (a part such as an eye strip counts the same) that the window keeps is a crop on a subject.
      const mark = looked ? boxNear(layer, second) : null;
      if (mark && insideShare(mark, crop.bounds) >= SUBJECT_KEPT) continue;
      count += 1;
      if (!narrowest || width < narrowest.width) narrowest = { width, time, bounds: crop.bounds };
    }
    if (!narrowest || count * step < model.fps * FACE_CUT_SECONDS - 1e-6) continue;
    const middle = sec((narrowest.bounds[0] + narrowest.bounds[2]) / 2);
    const name = ctx.name(item);
    const lookCall = `look {mode:"source", layer:${name}, t:${sec((shownFrom + shownTo) / 2)}}`;
    const markHow = 'mark what the shot is about (mark_subject; part:"eyes" for a deliberate strip), then frame_shot crops on it';
    findings.push({
      rule: "narrow_window", severity: "warn", itemId: item.id, at: sec(narrowest.time),
      message: hasMarks(layer) && !looked
        ? `${name}'s marked subject was never looked at: ${lookCall} first.`
        : `${name} shows ${Math.round(narrowest.width)}% of its file's width at ${sec(narrowest.time)} s and kino cannot see faces here: ${lookCall}, ${markHow}.`,
      measured: `a window ${Math.round(narrowest.width)}% of the ${size.width}x${size.height} file wide (middle at ${middle}%) at ${sec(narrowest.time)} s, for ${sec((count * step) / model.fps)} s, no face found`,
      required: `a full-frame window at least ${NARROW_WINDOW}% of the file wide, or a mark made after a look that the window keeps`,
      fix: frameFix(model, item, `${lookCall} at the middle of the shot: if a face is cut, move or scale it so the face is whole, or fit the file to the frame; else ${markHow}.`, false),
    });
  }
  return findings;
}

// ---------------------------------------------------------------- burned_in_mark

/**
 * burned_in_mark: a layer whose visible window still holds a mark burned into the file (a logo or a
 * site name the footage finder's scan found in a corner or along an edge, footage.marks on the
 * clip's record, ctx.burnedMarks {src: [{where, box}]}). Warns once the mark is on screen (at least
 * MARK_SEEN of its box in the window) for MARK_SECONDS. Nothing is hidden or banned: a mark that
 * is meant, or one a cover layer or a sticker hides, is waived or covered (covered layers are skipped).
 */
export function burnedInMark(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  if (!scene || !ctx.burnedMarks) return [];
  const findings = [];
  const step = Math.max(1, Math.round(model.fps / 10));
  for (const item of model.items) {
    if (item.kind !== "video" || item.source?.componentPath) continue;
    const marks = item.src ? ctx.burnedMarks[item.src] : null;
    const layer = scene.layers.find((entry) => entry.id === item.source?.layerId);
    if (!marks?.length || !layer) continue;
    const size = sizeOf(ctx, item);
    const worst = new Map();
    for (let index = 0; index < model.times.length; index += step) {
      if (item.samples.opacity[index] < SHOWN || soft(item, index) || coveredAt(model, item, index)) continue;
      const time = model.times[index];
      const crop = cropOnSource(scene, layer, time, size);
      if (!crop) continue;
      for (const mark of marks) {
        const share = insideShare(mark.box.map((value) => value * 100), crop.bounds);
        if (share < MARK_SEEN) continue;
        const entry = worst.get(mark) ?? { count: 0, share, time };
        entry.count += 1;
        if (share > entry.share) { entry.share = share; entry.time = time; }
        worst.set(mark, entry);
      }
    }
    for (const [mark, found] of worst) {
      if (found.count * step < model.fps * MARK_SECONDS - 1e-6) continue;
      const name = ctx.name(item);
      const plain = JSON.stringify(String(name).replace(/^"(.*)"$/, "$1"));
      const frame = { width: scene.width, height: scene.height };
      const fit = size && heldStill(model, item) ? cropPast(marks, frame, size) : null;
      // A crop past MARK_ZOOM_MOST (a guess) or one that cuts a face found in the file: the other ways first.
      const second = mediaFrameState(layer, found.time).sourceTime;
      const faces = fit && ctx.people?.[layer.src] ? facesAt(ctx.people[layer.src], second) : [];
      const fitBounds = fit ? [-fit.x / fit.width * 100, -fit.y / fit.height * 100, (scene.width - fit.x) / fit.width * 100, (scene.height - fit.y) / fit.height * 100] : null;
      const cutsFace = Boolean(fitBounds && faces.some((face) => (faceKept(face, fitBounds)?.share ?? 1) < SUBJECT_KEPT));
      const ways = size ? markWays(name, marks, frame, size, layer) : "";
      const call = fit && fit.zoom <= MARK_ZOOM_MOST && !cutsFace
        ? `edit {"ops":[{"op":"update_layer","layer":${plain},"properties":{"x":${fit.x},"y":${fit.y},"width":${fit.width},"height":${fit.height}}}]} crops every mark out (${fit.zoom}x zoom; look {mode:"source", layer:${name}} shows what it keeps)`
        : fit ? `${cutsFace ? "a crop past it cuts a face" : `a crop past it needs ${fit.zoom}x`}. ${ways}`
          : `zoom or move ${name} until the mark is outside the frame. ${ways}`;
      findings.push({
        rule: "burned_in_mark", severity: "warn", itemId: item.id, at: sec(found.time),
        message: `${name} still shows the mark burned into its ${mark.where} (${markSpan(mark.box)} of the file) at ${sec(found.time)} s.`,
        measured: `${Math.round(found.share * 100)}% of the mark box ${boxText(mark.box.map((value) => value * 100))} (% of the file) in the frame at ${sec(found.time)} s, for ${sec((found.count * step) / model.fps)} s`,
        required: `the mark outside the visible window (under ${Math.round(MARK_SEEN * 100)}% of its box in the frame), a cover over it, or a clean clip`,
        fix: { kind: "hint", text: `Pick a clean clip (library {topic:"footage"} lists them first), or ${call}.` },
      });
    }
  }
  return findings;
}

/**
 * How a scene's footage is cropped, for the stop asks: {shots, narrow, seen, parts, unseen, partNames}.
 * shots: enabled video layers that fill the frame (not recordings); narrow: of those, ones whose
 * window at the middle of their shown time is under NARROW_WINDOW % of the file's width with no
 * face and no saliency box found there (as narrow_window judges it). Each narrow one is `seen` (a mark made after a
 * look, which the window keeps), `parts` (the same, marked as a part such as "eyes"; partNames
 * lists the distinct names) or `unseen` (anything else).
 */
export function cropCounts(scene, { mediaSizes, sourceLooks, people } = {}) {
  const counts = { shots: 0, narrow: 0, seen: 0, parts: 0, unseen: 0, partNames: [] };
  for (const layer of scene?.layers ?? []) {
    const size = layer.src ? mediaSizes?.[layer.src] : null;
    if (layer.type !== "video" || layer.visible === false || layer.recording || layer.blur >= SOFT_BLUR || !(size?.width > 0 && size?.height > 0)) continue;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!range) continue;
    const time = (range.start + range.end) / 2;
    const crop = cropOnSource(scene, layer, time, size);
    if (!crop || crop.covers < 0.9) continue;
    counts.shots += 1;
    const second = mediaFrameState(layer, time).sourceTime;
    const [from, to] = playedStretch(scene, layer);
    if (crop.bounds[2] - crop.bounds[0] >= NARROW_WINDOW || facesAt(people?.[layer.src], second).length || salientAt(people?.[layer.src], second, from, to)) continue;
    counts.narrow += 1;
    const mark = seenMark(layer, sourceLooks, from, to) ? markNear(layer, second) : null;
    if (!mark || insideShare(mark.box, crop.bounds) < SUBJECT_KEPT) counts.unseen += 1;
    else if (mark.part) {
      counts.parts += 1;
      if (!counts.partNames.includes(mark.part)) counts.partNames.push(mark.part);
    } else counts.seen += 1;
  }
  return counts;
}

/** cropCounts as one line for a stop ask, or "" when no shot is narrow. */
export function cropLine(counts) {
  if (!counts?.narrow) return "";
  const parts = [
    counts.seen && `${counts.seen} marked after a look`,
    counts.parts && `${counts.parts} part ${counts.parts === 1 ? "crop" : "crops"} (${counts.partNames.slice(0, 3).join(", ")})`,
    counts.unseen && `${counts.unseen} not looked at`,
  ].filter(Boolean);
  return `Crops: ${counts.narrow} of ${counts.shots} shots show under ${NARROW_WINDOW}% of their file's width: ${parts.join(", ")}.`;
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

// A drawn hold (a held drawing of drawn footage) kept by the agent's own waiver lasts under this
// long on screen (2 s is a guess: a study's held drawings ran about 0.4 to 1.5 s). A longer
// still stays the person's call. backend/agent/checks.mjs reads it.
export const DRAWN_HOLD_SECONDS = 2;
// Slack for file times that are rounded to a frame (seconds).
const POSE_SLACK = 1 / 60;

/**
 * The file's still pose (holds.stills, file seconds) that holds every file time from `from` to
 * `to`: the stop shows a drawing the file itself holds there. null when none does, and for live
 * footage (a usual hold of 1 frame): a still stretch of a live clip stays a stop, as before.
 */
export function nativeStill(holds, from, to) {
  if (!(holds?.frames >= 2)) return null;
  const [low, high] = from <= to ? [from, to] : [to, from];
  return (holds?.stills ?? []).find((still) => still.start <= low + POSE_SLACK && high < still.end + POSE_SLACK) ?? null;
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
      // mediaFreeze "last" (or "both") keeps the last frame from where Play ends to the scene's end,
      // under the shots after it (study b/result.md 5): the ready fix hides the clip where Play ends.
      const playEnd = (layer.mediaStart ?? 0) + effectiveMediaDuration(layer);
      const heldAfter = Number.isFinite(playEnd) && !mediaFrameState(layer, model.times[from]).playing && model.times[from] >= playEnd - 1e-6;
      // The file's own still pose (a drawing it holds, measured on import: holdPattern) under the
      // whole stop: a fact of the material, waivable as a drawn hold. Past the pose, the edit froze it.
      const pose = heldAfter ? null : nativeStill(ctx.mediaHolds?.[layer.src], sourceAt(start), sourceAt(to));
      const finding = frozenFinding(ctx, item, start, to, model, heldAfter ? `the clip's last frame, held after its Play ends at ${sec(playEnd)} s (mediaFreeze ${layer.mediaFreeze ?? "both"} holds it to the scene's end)`
        : pose ? `the file's own held drawing: a still pose of ${sec(pose.end - pose.start)} s in the file (${sec(pose.start)}-${sec(pose.end)} s), stretched by mediaSpeed ${sec(constantSpeed(layer))}` : "the clip stops: no new frames from its file", null, onCut);
      if (heldAfter) finding.fix = { kind: "retime", itemId: item.id, end: sec(playEnd) };
      if (pose) {
        finding.native = { start: pose.start, end: pose.end };
        finding.until = sec(model.times[to] + 1 / model.fps);
        finding.required = `${finding.required}; a drawn hold of the file's own pose under ${DRAWN_HOLD_SECONDS} s on screen is yours to keep: waive_check with a reason naming the drawn hold, on this layer`;
      }
      findings.push(finding);
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

// ---------------------------------------------------------------- clip_reuse
// One clip filling the frame again and again reads as a short reel stretched: three first passes
// in a row cut back to the same red dancer clip about six times. A hero shot returning twice or
// three times is a motif; four times, or a third of the video, is a loop. Only once the video
// shows 4 or more files full frame (with fewer there is no other clip to cut to).
const REUSE_USES = 4;
const REUSE_SHARE = 0.35;
const REUSE_FILES = 4;
const REUSE_SECONDS = 15;
// A gap this short (a flash frame, a glimpse) does not split one use into two.
const REUSE_GAP = 0.25;

export function clipReuse(model, ctx) {
  if (model.duration < REUSE_SECONDS) return [];
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const whole = model.width * model.height;
  const videos = model.items.filter((item) => item.kind === "video" && item.src && !item.isMask);
  // The file that fills the frame at each sample: the topmost playing video covering 90% of it.
  const shown = model.times.map((_, index) => {
    let best = null;
    for (const item of videos) {
      if (item.samples.opacity[index] < 0.5 || coveredAt(model, item, index)) continue;
      const box = visibleBoxAt(model, item, index);
      const inside = { x0: Math.max(box.x0, frame.x0), y0: Math.max(box.y0, frame.y0), x1: Math.min(box.x1, frame.x1), y1: Math.min(box.y1, frame.y1) };
      if (Math.max(0, inside.x1 - inside.x0) * Math.max(0, inside.y1 - inside.y0) < 0.9 * whole) continue;
      if (!best || item.z > best.z) best = item;
    }
    return best?.src ?? null;
  });
  const files = new Map();
  const gap = Math.round(REUSE_GAP * model.fps);
  for (let index = 0; index < shown.length; index += 1) {
    const src = shown[index];
    if (!src) continue;
    const entry = files.get(src) ?? { samples: 0, uses: [], last: -Infinity };
    entry.samples += 1;
    if (index - entry.last > gap + 1) entry.uses.push(index);
    entry.last = index;
    files.set(src, entry);
  }
  if (files.size < REUSE_FILES) return [];
  const findings = [];
  for (const [src, entry] of files) {
    const share = entry.samples / shown.length;
    if (entry.uses.length < REUSE_USES && share <= REUSE_SHARE) continue;
    const layers = [...new Set(videos.filter((item) => item.src === src).map((item) => item.name))];
    const name = layers.length === 1 ? layers[0] : `${src.split("/").pop()} (${layers.slice(0, 3).join(", ")})`;
    const at = entry.uses.map((index) => sec(model.times[index]));
    findings.push({
      rule: "clip_reuse", severity: "warn", itemId: videos.find((item) => item.src === src).id, at: at[0], media: src,
      measured: `${name} fills the frame ${entry.uses.length === 1 ? "once" : `${entry.uses.length} times`} (${at.slice(0, 6).map((time) => `${time}s`).join(", ")}), ${Math.round(share * 100)}% of the video`,
      required: `under ${REUSE_USES} returns and at most ${Math.round(REUSE_SHARE * 100)}% of the video for one clip`,
      message: `${ctx.sceneName} keeps cutting back to ${name}: ${entry.uses.length} times, ${Math.round(share * 100)}% of the video.`,
      fix: { kind: "hint", text: "Keep its strongest return or two; cut the others to other clips (look source shows them all)." },
    });
  }
  return findings;
}
