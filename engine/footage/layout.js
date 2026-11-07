// How compose {footage} puts one shot in the frame (the layout), like a short-form clipper does:
//   fill         the clip covers the frame, cropped around the faces (eyes in the upper part)
//   blur-fill    a clip of another shape (a portrait clip in a landscape video) as a card in the
//                safe area, over a blurred, darker copy of itself that fills the frame
//   screen-over  a screen recording as a tall card beside the frame's middle, over a camera shot
//                that plays behind it (softened), so the screen and the world show together
// Every box stays inside the frame; cards stay inside the safe area.
import { safeArea } from "../blocks/formats.js";
import { SCREEN_NAME } from "../movePicks.js";

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

/**
 * The layout of a shot of `clip` in `frame`. `focus` is the face center ([x, y]) in the stretch
 * or null; `subject` the marked subject box ([x, y, w, h] fractions) or null; `partner` a camera
 * shot to show behind a screen recording ({clip, focus}) or null;
 * `side` puts a card left (0) or right (1) of the middle. Returns {kind, main, backdrop?, partner?,
 * radius}: boxes in scene pixels.
 */
export function shotLayout(clip, frame, { focus = null, subject = null, partner = null, side = 1, zoom = 1, captions = false } = {}) {
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
  const subjectFits = Boolean(subject && !screen && subject[2] <= keeps * 0.85 && subject[3] <= keepsHeight * 0.85);
  if (sameShape || subjectFits || (focus && !screen && keeps >= 0.4 && frameShape === "portrait")) {
    return { kind: "fill", radius: 0, main: coverBox(source, frame, { focus, zoom, ...(subject ? { target: [0.5, 0.5] } : {}) }) };
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
