// The lightest fix that makes one text readable over rendered frames of what is behind it (the
// text left out), in the order contrastFixes (pixels.js) tries them: a scrim, a halo shadow, a
// darker place in the frame, a size that counts as large text, and a solid plate last. Readable is
// what the two pixel checks measure, on every frame given: contrast (pixels.js, the 10th
// percentile of the text color over the pixels behind it) and text_on_busy (polish.js, under
// BUSY_SHARE edge pixels around the letters, a scrim included). Used where kino sets a text itself
// over a picture it did not choose for it (a built sketch's line, backend/agent/sketches.mjs).
import { contrastOf, hexRgba, luminance } from "./model.js";
import { contrastOver, HALO, HALO_COVER, haloShadow, pixelsBehind, requiredRatio, SCRIM_ALPHAS, through } from "./pixels.js";
import { BUSY_SHARE, edgeShare } from "./rules/polish.js";

// A frame seen through a black layer at `alpha` (a scrim solid where the text sits).
const darkened = (frame, alpha) => ({ ...frame, pixels: Uint8ClampedArray.from(frame.pixels, (value, index) => (index % 4 === 3 ? value : value * (1 - alpha))) });
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Measures a text over `frames` ([{pixels, width, height}], rendered without it) and answers
 * {required, before: {contrast, busy}, fix} where fix is null (it passes as it is) or the first
 * that passes: {kind: "scrim", alpha} | {kind: "halo", shadow} | {kind: "place", dy} |
 * {kind: "size", fontSize} | {kind: "plate", fill, margin}, each with `after` {contrast, busy}.
 * `box` {x0, y0, x1, y1} is the text's ink box in scene pixels; `scene` {width, height};
 * `size` its drawn size, `fontSize` its own; `color` its fill.
 */
export function legibleFix({ frames, box, scene, color, size, fontSize = size, weight = 400 }) {
  const scale = Math.min(scene.width, scene.height) / 1080;
  const required = requiredRatio(size, weight, scale);
  const pad = 0.15 * size;
  const measure = (list, at = box, halo = null) => {
    let contrast = Infinity, busy = 0;
    for (const frame of list) {
      contrast = Math.min(contrast, contrastOver(color, 1, through(pixelsBehind(frame, at, scene.width), halo)) ?? Infinity);
      busy = Math.max(busy, edgeShare(frame, { x0: at.x0 - pad, y0: at.y0 - pad, x1: at.x1 + pad, y1: at.y1 + pad }, scene.width));
    }
    return { contrast: round2(contrast), busy: round2(busy) };
  };
  const passes = (measured, need = required) => measured.contrast >= need && measured.busy < BUSY_SHARE;
  const before = measure(frames);
  const answer = (fix) => ({ required, before, fix });
  if (!frames.length || passes(before)) return answer(null);
  for (const alpha of SCRIM_ALPHAS) {
    const after = measure(frames.map((frame) => darkened(frame, alpha)));
    if (passes(after)) return answer({ kind: "scrim", alpha, after });
  }
  // A halo darkens around the strokes; it does not calm busy detail (text_on_busy says so).
  const haloed = measure(frames, box, { rgb: [0, 0, 0], alpha: HALO.alpha * HALO_COVER });
  if (passes(haloed)) return answer({ kind: "halo", shadow: { color: HALO.color, ...haloShadow(size, scale) }, after: haloed });
  // The nearest height (same x) in the frame's middle 80% where it passes, as contrastFixes looks.
  const height = box.y1 - box.y0;
  const places = [];
  for (let y = scene.height * 0.1; y + height <= scene.height * 0.9; y += scene.height * 0.05) places.push(Math.round(y));
  for (const { dy } of places.map((y) => ({ dy: y - box.y0 })).filter((entry) => Math.abs(entry.dy) >= height / 2).sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy))) {
    const after = measure(frames, { ...box, y0: box.y0 + dy, y1: box.y1 + dy });
    if (passes(after)) return answer({ kind: "place", dy: Math.round(dy), after });
  }
  const large = (weight >= 700 ? 36 : 48) * scale;
  if (required > 3 && before.contrast >= 3 && before.busy < BUSY_SHARE)
    return answer({ kind: "size", fontSize: Math.ceil((fontSize * large) / size), after: before });
  // The plate: near-black or white, whichever contrasts more with the text (plateOps' palette floor).
  const ink = luminance(hexRgba(color) ?? [255, 255, 255]);
  const fill = ["#0b0b0c", "#ffffff"].reduce((best, entry) => (contrastOf(luminance(hexRgba(entry)), ink) > contrastOf(luminance(hexRgba(best)), ink) ? entry : best));
  return answer({ kind: "plate", fill, margin: Math.round(size * 0.3), after: { contrast: round2(contrastOf(luminance(hexRgba(fill)), ink)), busy: 0 } });
}
