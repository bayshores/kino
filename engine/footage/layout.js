// How compose {footage} puts one shot in the frame (the layout), like a short-form clipper does:
//   fill         the clip covers the frame, cropped around the faces (eyes in the upper part)
//   blur-fill    a clip of another shape (a portrait clip in a landscape video) as a card in the
//                safe area, over a blurred, darker copy of itself that fills the frame
//   screen-over  a screen recording as a tall card beside the frame's middle, over a camera shot
//                that plays behind it (softened), so the screen and the world show together
// Every box stays inside the frame; cards stay inside the safe area.
import { safeArea } from "../blocks/formats.js";
import { SCREEN_NAME } from "../movePicks.js";
import { mediaFrameState, mediaPlaybackRange } from "../playback.js";
import { markedSubject } from "./moments.js";
import { cropPast, paddedMark, MARK_ZOOM_MOST } from "./burned.js";

const round = (value) => Math.round(value);

/** "landscape", "portrait" or "square" for a width × height. */
export function shapeOf(width, height) {
  const ratio = width / Math.max(1, height);
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.87) return "portrait";
  return "square";
}

/**
 * A box for a width × height source that covers `frame`, scaled by `zoom` (1 or more), with the
 * source point `focus` ([x, y] fractions, default the middle) put near `target` ([x, y] fractions
 * of the frame) as far as covering allows.
 */
export function coverBox(source, frame, { focus = null, zoom = 1, target = [0.5, 0.42] } = {}) {
  const scale = Math.max(frame.width / source.width, frame.height / source.height) * zoom;
  const width = source.width * scale;
  const height = source.height * scale;
  const [fx, fy] = focus ?? [0.5, 0.5];
  const [tx, ty] = focus ? target : [0.5, 0.5];
  const x = Math.min(0, Math.max(frame.width - width, frame.width * tx - fx * width));
  const y = Math.min(0, Math.max(frame.height - height, frame.height * ty - fy * height));
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

/** The largest box of the source's shape inside `area`, centered in it (or at `align` 0 to 1 across). */
export function fitBox(source, area, { align = 0.5 } = {}) {
  const scale = Math.min(area.width / source.width, area.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: round(area.x + (area.width - width) * align), y: round(area.y + (area.height - height) / 2), width: round(width), height: round(height) };
}

/** True when a clip reads as a screen recording: it says so in its name, or it is tall and full of text. */
export function isScreenRecording(clip) {
  if (SCREEN_NAME.test(clip.name ?? "")) return true;
  const measured = (clip.samples ?? []).filter((sample) => Array.isArray(sample.text));
  if (!measured.length) return false;
  const lines = measured.reduce((sum, sample) => sum + sample.text.length, 0) / measured.length;
  return lines >= 4 && shapeOf(clip.width, clip.height) !== "landscape";
}

// A face counts when it is at least 0.4% of the frame (a person, not a poster in the back).
const FACE_AREA = 0.004;
// A sample this close (seconds) to a shot's stretch stands in for it (samples come twice a second).
const SAMPLE_REACH = 0.5;

/** A box of a subjects-v1 or people-v1 sample: [x, y, w, h] fractions, and "face" or "saliency". */
export function boxEntry(entry) {
  if (Array.isArray(entry)) return entry.length === 4 ? { box: entry, kind: "face" } : null;
  if (Array.isArray(entry?.box) && entry.box.length === 4) return { box: entry.box, kind: entry.kind === "saliency" ? "saliency" : "face" };
  return null;
}

/**
 * The tagged boxes of one sample. A subjects-v1 sample keeps its faces as plain [x, y, w, h] in
 * `faces` and the tagged boxes (faces, or saliency when there is no face) in `subjects`: `subjects`
 * is read when present. A people-v1 sample has only `faces`.
 */
export function sampleBoxes(sample) {
  return (Array.isArray(sample?.subjects) ? sample.subjects : sample?.faces ?? []).map(boxEntry).filter(Boolean);
}

// The least of a subject a crop keeps in the frame (crop_no_subject reads it too).
export const SUBJECT_KEPT = 0.85;

// The share of box `a` inside box `b`, both [x, y, w, h] in the same units.
function shareIn(a, b) {
  const width = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return a[2] > 0 && a[3] > 0 ? (width * height) / (a[2] * a[3]) : 0;
}

/**
 * Whether a mark without a part ([x, y, w, h]) stands for the saliency box it is near (same units):
 * it holds SUBJECT_KEPT of that box, or does not touch it (a subject elsewhere in the picture). A
 * mark inside it (a mouth in a face) stands for less than what kino sees there.
 */
export function markHoldsSalient(mark, salient) {
  return shareIn(mark, salient) === 0 || shareIn(salient, mark) >= SUBJECT_KEPT;
}

/**
 * What a file's measured subjects (subjects-v1 samples, or people-v1: [{t, faces}]) show in the file
 * time stretch [from, to] (a sample within half a second stands in when none falls inside):
 *   face      the middle of the face boxes as [x, y] fractions (the biggest counts most), or null
 *   salient   with no face: {box, center} of the boxes of where the eye goes (Vision saliency), or null
 * A saliency box is never a face: it only decides whether a crop fits (fill) or not (blur-fill).
 */
export function subjectsIn(samples, from, to) {
  const measured = (samples ?? []).filter((sample) => (Array.isArray(sample?.subjects) || Array.isArray(sample?.faces)) && Number.isFinite(sample.t));
  let near = measured.filter((sample) => sample.t >= from - 1e-6 && sample.t <= to + 1e-6);
  if (!near.length) {
    const middle = (from + to) / 2;
    const closest = measured.reduce((best, sample) => (!best || Math.abs(sample.t - middle) < Math.abs(best.t - middle) ? sample : best), null);
    if (closest && Math.abs(closest.t - middle) <= SAMPLE_REACH + (to - from) / 2) near = [closest];
  }
  const entries = near.flatMap(sampleBoxes);
  const faces = entries.filter((entry) => entry.kind === "face" && entry.box[2] * entry.box[3] >= FACE_AREA);
  if (faces.length) {
    let x = 0, y = 0, weight = 0;
    for (const { box: [left, top, w, h] } of faces) { const size = w * h; x += (left + w / 2) * size; y += (top + h / 2) * size; weight += size; }
    // faceBox: the union of the face boxes (a crop that cuts one of them cuts a face).
    const lefts = faces.map(({ box }) => box[0]), tops = faces.map(({ box }) => box[1]);
    const rights = faces.map(({ box }) => box[0] + box[2]), bottoms = faces.map(({ box }) => box[1] + box[3]);
    const faceBox = [Math.min(...lefts), Math.min(...tops), Math.max(...rights) - Math.min(...lefts), Math.max(...bottoms) - Math.min(...tops)];
    return { face: [x / weight, y / weight], faceBox, salient: null };
  }
  const eye = entries.filter((entry) => entry.kind === "saliency").map((entry) => entry.box);
  if (!eye.length) return { face: null, salient: null };
  const left = Math.min(...eye.map((box) => box[0])), top = Math.min(...eye.map((box) => box[1]));
  const right = Math.max(...eye.map((box) => box[0] + box[2])), bottom = Math.max(...eye.map((box) => box[1] + box[3]));
  return { face: null, salient: { box: [left, top, right - left, bottom - top], center: [(left + right) / 2, (top + bottom) / 2] } };
}

/**
 * The layout of a shot of `clip` in `frame`. `focus` is the face center ([x, y]) in the stretch
 * or null; `subject` the marked subject box ([x, y, w, h] fractions) or null; `salient` where the
 * eye goes ({box, center}) when no face or mark was found: it picks fill or blur-fill and centers
 * the crop, but is never a face; `partner` a camera
 * shot to show behind a screen recording ({clip, focus}) or null;
 * `side` puts a card left (0) or right (1) of the middle. Returns {kind, main, backdrop?, partner?,
 * radius}: boxes in scene pixels.
 */
export function shotLayout(clip, frame, { focus = null, subject = null, salient = null, partner = null, side = 1, zoom = 1, captions = false } = {}) {
  const outer = safeArea(frame);
  // Cards keep 2% inside the safe area, so their drift and shadow never touch its edge.
  const inset = Math.round(0.02 * Math.min(frame.width, frame.height));
  const safe = { x: outer.x + inset, y: outer.y + inset, width: outer.width - 2 * inset, height: outer.height - 2 * inset };
  const source = { width: clip.width || frame.width, height: clip.height || frame.height };
  const frameShape = shapeOf(frame.width, frame.height);
  const clipShape = shapeOf(source.width, source.height);
  const radius = round(Math.min(frame.width, frame.height) * 0.03);
  const screen = clip.kind === "screen";
  if (screen && partner && frameShape !== "portrait") {
    // A tall card a third of the way in from one side; the camera shot fills the frame behind it.
    const height = safe.height;
    const width = height * source.width / source.height;
    const center = side ? frame.width * 0.68 : frame.width * 0.32;
    const x = Math.min(safe.x + safe.width - width, Math.max(safe.x, center - width / 2));
    return {
      kind: "screen-over", radius,
      main: { x: round(x), y: safe.y, width: round(width), height: round(height) },
      partner: { box: coverBox({ width: partner.clip.width, height: partner.clip.height }, frame, { focus: partner.focus, zoom: 1.04, target: [side ? 0.3 : 0.7, 0.42] }) },
    };
  }
  const sameShape = clipShape === frameShape || (clipShape === "square" && frameShape !== "portrait" && !screen);
  // A face-led clip of another shape is cropped around the face (a portrait video from a
  // landscape interview) when the crop keeps at least 40% of the picture's width.
  const keeps = Math.min(1, (frame.width / frame.height) / (source.width / source.height));
  // The share of the picture's height the crop keeps (below 1 for a tall clip in a wider frame).
  const keepsHeight = Math.min(1, (source.width / source.height) / (frame.width / frame.height));
  // A marked subject ([x, y, w, h] fractions) that fits the crop both ways with room to spare fills
  // the frame of any shape, centered on it.
  const aim = subject ?? salient?.box ?? null;
  const subjectFits = Boolean(aim && !screen && aim[2] <= keeps * 0.85 && aim[3] <= keepsHeight * 0.85);
  if (sameShape || subjectFits || (focus && !screen && keeps >= 0.4 && frameShape === "portrait")) {
    // Where the eye goes (no face, no mark) is only a place to center on.
    const center = focus ?? (!subject && salient ? salient.center : null);
    return { kind: "fill", radius: 0, main: coverBox(source, frame, { focus: center, zoom, ...(aim ? { target: [0.5, 0.5] } : {}) }) };
  }
  // A card in the safe area over a blurred copy of itself. With captions, the card sits well to
  // one side so the captions have the other side, and its parts stay separate layers (loose), so
  // the captions keep clear of the card itself.
  const reach = captions ? 0.3 : 0.18;
  const align = frameShape === "portrait" ? 0.5 : side ? 0.5 + reach : 0.5 - reach;
  let area = safe;
  if (captions && (clipShape === "landscape" || frameShape === "portrait")) area = { ...safe, height: Math.round(safe.height * 0.74) };
  const card = fitBox(source, area, { align: clipShape === "landscape" ? 0.5 : align });
  return {
    kind: "blur-fill", radius, loose: captions,
    main: card,
    backdrop: { ...coverBox(source, frame, { zoom: 1.12 }), blur: round(0.03 * Math.max(frame.width, frame.height)), opacity: 0.45 },
  };
}

// Geometry an animation may carry: a backdrop copy keeps only the other keys (fades), so it does
// not move or scale on its own.
const GEOMETRY = ["x", "y", "width", "height", "scaleX", "scaleY", "rotation"];

// An animation of the layer for its blurred copy: fades keep their timing, scaled to the copy's
// opacity; an animation of the layer's place or size is left out.
function backdropAnimation(animation, opacity) {
  const keep = (values) => {
    if (!values || typeof values !== "object") return values;
    const out = {};
    for (const [key, value] of Object.entries(values)) {
      if (GEOMETRY.includes(key)) continue;
      out[key] = key === "opacity" && Number.isFinite(value) ? Math.round(value * opacity * 1000) / 1000 : value;
    }
    return out;
  };
  // A new id: animation ids are unique in the document.
  const copy = { ...animation, ...(animation.id ? { id: `${animation.id}-blur` } : {}), from: keep(animation.from), to: keep(animation.to) };
  return [copy.from, copy.to].some((values) => values && Object.keys(values).length) ? copy : null;
}

/**
 * A fill crop (`box`, the layer's box in scene pixels) moved or zoomed so the marks burned into the
 * file (`marks` [{where, box}], fractions) are outside the window: the least zoom from the crop's own
 * zoom, as near its own center as the cuts allow (burned.js cropPast). `aim` (the subject or face
 * box, fractions) must stay SUBJECT_KEPT in the new window and the zoom at most `zoomMost`; else the
 * crop is kept and the answer says why. Answers null when no mark shows in the crop, else
 * {box | null, marks: {out, zoom?, kept?: "face" | "zoom"}}.
 */
export function cropPastMarks(box, marks, frame, size, aim = null, zoomMost = MARK_ZOOM_MOST) {
  const windowOf = (layerBox) => {
    const left = -layerBox.x / layerBox.width, top = -layerBox.y / layerBox.height;
    return [left, top, left + frame.width / layerBox.width, top + frame.height / layerBox.height];
  };
  const shows = (bounds) => marks.some((mark) => Array.isArray(mark?.box) && shareIn(paddedMark(mark.box), [bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]]) > 0);
  const before = windowOf(box);
  if (!shows(before)) return null;
  const fit = cropPast(marks, frame, size, { center: [(before[0] + before[2]) / 2, (before[1] + before[3]) / 2], scale: box.width / size.width });
  if (!fit) return { box: null, marks: { out: false, kept: "zoom" } };
  const after = windowOf(fit);
  if (fit.zoom > zoomMost + 1e-9) return { box: null, marks: { out: false, kept: "zoom", zoom: fit.zoom } };
  if (aim && shareIn(aim, [after[0], after[1], after[2] - after[0], after[3] - after[1]]) < SUBJECT_KEPT) return { box: null, marks: { out: false, kept: "face", zoom: fit.zoom } };
  return { box: { x: fit.x, y: fit.y, width: fit.width, height: fit.height }, marks: { out: true, zoom: fit.zoom } };
}

/**
 * kino's own shot layout for a video layer that was placed by hand: the same choice compose
 * {footage} makes (shotLayout), from the file's size, the subject marked on the layer (mark_subject)
 * and the subjects measured in the file (`samples`, subjects-v1 or people-v1). Returns
 *   {kind, on, patch, backdrop}  on: "mark", "mark-salient" (a mark widened to the saliency box it
 *                            sits in), "face", "salient" or null (what the layout aimed at);
 *                            patch: the layer's new box (and, for blur-fill, radius and shadow);
 *                            backdrop: a blurred copy to put right under the layer (blur-fill), or null.
 * `taken` is the set of layer ids in use. Throws a plain sentence when the layer cannot be framed.
 */
export function frameShot(scene, layer, { size, samples = [], taken = new Set(), marks: burnedMarks = [], zoomMost = MARK_ZOOM_MOST } = {}) {
  if (layer.type !== "video") throw new Error(`frame needs a video layer; ${layer.name || layer.id} is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer.`);
  if (layer.parentId) throw new Error(`${layer.name || layer.id} is inside a group: frame works on a layer of the scene itself (take it out of the group, or frame the group's footage before grouping).`);
  if (!(size?.width > 0 && size?.height > 0)) throw new Error(`frame needs the size of ${layer.name || layer.id}'s file (import it with import_media first).`);
  const frame = { width: scene.width, height: scene.height };
  // A blurred copy of this file that fills the frame is already behind it (frame ran before, or it
  // was built by hand): a second one would stack on the first.
  const backed = scene.layers.find((other) => other !== layer && other.type === "video" && other.src === layer.src && other.blur > 0 && other.width >= frame.width && other.height >= frame.height);
  if (backed) throw new Error(`${layer.name || layer.id} is already framed: ${backed.name || backed.id} is its blurred backdrop. Delete the backdrop first to frame it again.`);
  // The stretch of the file the layer plays, so a mark or a face elsewhere in the file does not count.
  const range = mediaPlaybackRange(layer, scene.duration);
  const from = mediaFrameState(layer, range?.start ?? 0).sourceTime;
  const to = Math.max(from, mediaFrameState(layer, range?.end ?? scene.duration).sourceTime);
  const marks = layer.subjectBoxes?.src === layer.src ? layer.subjectBoxes.boxes ?? [] : [];
  let marked = markedSubject({ subjects: marks.map(({ at, box }) => ({ at, box })) }, from, to);
  const measured = subjectsIn(samples, from, to);
  // A mark without a part that holds only a piece of what kino sees (a mouth in a face) widens to
  // hold both, as crop_no_subject judges it; a part mark ({part:"eyes"}) stays a deliberate part crop.
  const part = marks.some((entry) => entry.part && entry.at >= from - SAMPLE_REACH && entry.at <= to + SAMPLE_REACH);
  const widened = Boolean(marked && !part && measured.salient && !markHoldsSalient(marked.box, measured.salient.box));
  if (widened) {
    const [a, b] = [marked.box, measured.salient.box];
    const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]);
    const right = Math.max(a[0] + a[2], b[0] + b[2]), bottom = Math.max(a[1] + a[3], b[1] + b[3]);
    marked = { box: [left, top, right - left, bottom - top], center: [(left + right) / 2, (top + bottom) / 2] };
  }
  const seen = marked ? { face: null, salient: null } : measured;
  const screen = Boolean(layer.recording);
  const layout = shotLayout({ width: size.width, height: size.height, name: layer.name, kind: screen ? "screen" : "camera" }, frame,
    { focus: marked?.center ?? seen.face, subject: marked?.box ?? null, salient: seen.salient });
  // What the crop was aimed at, for the agent's receipt.
  const on = widened ? "mark-salient" : marked ? "mark" : seen.face ? "face" : seen.salient ? "salient" : null;
  if (layout.kind === "fill") {
    // A mark burned into the file (the footage facts' marks) stays outside the crop when it can.
    const aim = marked?.box ?? seen.faceBox ?? null;
    const past = burnedMarks.length ? cropPastMarks(layout.main, burnedMarks, frame, size, aim, zoomMost) : null;
    return { kind: "fill", on, patch: { ...(past?.box ?? layout.main) }, backdrop: null, ...(past ? { marks: past.marks } : {}) };
  }
  const patch = { ...layout.main, radius: layout.radius, shadow: { color: "#000000B3", x: 0, y: Math.round(0.02 * frame.height), blur: Math.round(0.05 * frame.height) } };
  const back = layout.backdrop;
  let id = `${layer.id}-blur`;
  for (let number = 2; taken.has(id); number += 1) id = `${layer.id}-blur-${number}`;
  const backdrop = {
    ...structuredClone(layer), id, name: `${layer.name || layer.id} blur`,
    x: back.x, y: back.y, width: back.width, height: back.height, blur: back.blur, opacity: back.opacity, volume: 0,
    animations: (layer.animations ?? []).map((animation) => backdropAnimation(animation, back.opacity)).filter(Boolean),
  };
  delete backdrop.radius;
  delete backdrop.shadow;
  delete backdrop.subjectBoxes;
  delete backdrop.move;
  return { kind: "blur-fill", on, patch, backdrop };
}
