// The quality checker's view of a video: what is on screen at each sampled time.
// Any tool can build one (engine/quality/kinoTimeline.js for kino; another tool would need its own adapter),
// and the rules in engine/quality/rules/ work the same on all of them.
//
// A model is:
//   { width, height, duration, fps, times,          fps = samples a second; times[i] = i / fps
//     videoType, rhythm: {bpm, offset} | null, background: paint | null, audio: boolean,
//     items: [Item], tweens: [Tween], assertions: [Assertion],
//     effects?: [{itemId, effect, start, end, to}], retimes?: [{itemId, start, end, from, to}] }
//   `effects` (optional) lists every effect animation (engine/effects/catalog.js keys such as
//   zoom-blur, snow or rgb-shift), and `retimes` (optional) every Speed animation of a clip
//   (`to` is the speed it reaches; 0 freezes it). The technique finder (techniques.js) reads them.
// An Item is one thing drawn (a text, shape, image, video or group):
//   { id, name, kind, role, perpetual, loops, allowOverlap, z, parentId, clipIds, maskId, isMask,
//     text, texts, fontSize, fontWeight, fontFamily, textAlign, letterSpacing, textCase, fill, painted, opaque, sceneBackground,
//     shadow: {blur, x, y, color} | null, blur, radius, restWidth, restHeight, source, src,
//     samples: { x0, y0, x1, y1, opacity, scale, blur, textIndex, turn?, colors?, matrix? } }
//   `matrix` (optional, not text) is the world transform [a, b, c, d, e, f] of each sample, 6
//   floats a sample (sample i at i * 6), parents included.
//   `clipIds` are the groups that clip it and the mask over it; `maskId` (a mask group only) is
//   the group's own mask. visibleBoxAt clips the box by both. A mask with `maskInvert` true
//   shows its layers everywhere but itself: it is in no clipIds and clips no box.
//   `move` (optional) is the ID of the move (engine/blocks/move.js) that made the layer, or null.
//   Text items may also have (engine/quality/textFacts.js): `font` {family, weight, style,
//   drawnFamily, drawnWeight, drawnStyle, sameFamily}, the face asked for and the one drawn;
//   `lineSets` [[{text, width, soft}]] with `samples.lineSet` (an index into it per time), where
//   its lines break (`soft`: the layout wrapped there); `wrapWidths` {oneLine, balanced, lines}
//   for a text that wraps; and `restX`, `textResize`, its own x and sizing mode.
//   Each sample array has one value per time. The box (x0, y0)–(x1, y1) is in frame pixels: for
//   text it is the ink of its lines, otherwise the layer's box. `opacity` is what the eye gets
//   (0 when hidden, times every parent's opacity). `scale` is the size it is drawn at (1 = its
//   own size). `turn` (optional) is its world rotation in radians (-pi to pi). `textIndex`
//   says which of `texts` is shown (text that changes over time).
//   `colors` (text, optional) lists the solid colors its fill is drawn with at each time, after
//   its fill animations; without it, `fill` is used at every time.
//   `moving` (optional, 1 or 0 per time) is 1 where the item's picture moves by itself in its
//   box, such as a particle generator whose clock runs (video always moves while shown).
//   `flickerHz` (optional, per time) is the fastest rate in Hz at which parts of its picture
//   twinkle by themselves (particle flicker); 0 where nothing does. `flicker` (optional, 0 to
//   1 per time) is how strongly those parts twinkle.
// A Tween is one animation of an item:
//   { id, itemId, keys, start, end, kind: "in" | "out" | "custom", easing, intensity,
//     overshoots, linear, wobbles, unit, spread, stagger, textClip, preset, source, move, handoff, fromKeys?, toKeys? }
//   `handoff` is true for a carry's animations (speed_jump leaves the join into one alone).
//   `keys` are all the values it animates; `fromKeys` and `toKeys` (optional) are the ones its
//   From and its To set (a value missing from To ends on the layer's own value). Without
//   them, `keys` stands for both.
//   `spread` is the time from the first text unit starting to the last (0 for a whole layer).
//   `overshoots` is true when the easing curve leaves 0–1 (bounce, elastic, overshoot).
//   `wobbles` is true when the curve, kept within 0–1, goes back the way it came (a fade with it flickers).

/** Sample index of time `t`, clamped to the model's times. */
export function frameAt(model, t) {
  return Math.max(0, Math.min(model.times.length - 1, Math.round(t * model.fps)));
}

export function boxAt(item, index) {
  const { x0, y0, x1, y1 } = item.samples;
  return { x0: x0[index], y0: y0[index], x1: x1[index], y1: y1[index] };
}

/**
 * The part of the item's box that can be seen at a sample: its box cut by every group that clips
 * it and the mask over it, and for a mask group by its own mask. A video in a rounded tile is
 * judged by the tile, not by the whole video around it.
 */
export function visibleBoxAt(model, item, index) {
  let box = boxAt(item, index);
  for (const id of item.maskId ? [...(item.clipIds ?? []), item.maskId] : item.clipIds ?? []) {
    const clip = itemById(model, id);
    if (clip && !clip.maskInvert) box = intersection(box, boxAt(clip, index));
  }
  return box;
}

export function area(box) {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

export function intersection(a, b) {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

export function overlapArea(a, b) {
  return area(intersection(a, b));
}

/** The share of `box` (0–1) inside the frame. */
export function insideShare(model, box) {
  const whole = area(box);
  if (!whole) return 0;
  return overlapArea(box, { x0: 0, y0: 0, x1: model.width, y1: model.height }) / whole;
}

export const roundBox = (box) => [Math.round(box.x0), Math.round(box.y0), Math.round(box.x1 - box.x0), Math.round(box.y1 - box.y0)];

/**
 * Groups the sample indexes where `test(index)` is true into runs of back-to-back samples:
 * [{from, to, length}] (to is inclusive).
 */
export function runs(count, test) {
  const found = [];
  let from = -1;
  for (let index = 0; index <= count; index += 1) {
    const on = index < count && test(index);
    if (on && from < 0) from = index;
    if (!on && from >= 0) {
      found.push({ from, to: index - 1, length: index - from });
      from = -1;
    }
  }
  return found;
}

export const longestRun = (list) => list.reduce((best, run) => (!best || run.length > best.length ? run : best), null);

/** The tweens of one item, by start time. */
export function tweensOf(model, itemId) {
  model._tweensByItem ??= model.tweens.reduce((map, tween) => {
    if (!map.has(tween.itemId)) map.set(tween.itemId, []);
    map.get(tween.itemId).push(tween);
    return map;
  }, new Map());
  return model._tweensByItem.get(itemId) ?? [];
}

/** The item and every group it is inside. */
export function chainOf(model, item) {
  model._byId ??= new Map(model.items.map((entry) => [entry.id, entry]));
  const chain = [item];
  let parent = model._byId.get(item.parentId);
  while (parent && chain.length < 64) {
    chain.push(parent);
    parent = model._byId.get(parent.parentId);
  }
  return chain;
}

export function itemById(model, id) {
  model._byId ??= new Map(model.items.map((entry) => [entry.id, entry]));
  return model._byId.get(id);
}

/** True while a tween of the item or one of its groups runs at time `t` (text units included). */
export function movingAt(model, item, t, { keys = null } = {}) {
  for (const entry of chainOf(model, item))
    for (const tween of tweensOf(model, entry.id))
      if (t > tween.start + 1e-6 && t < tween.end - 1e-6 && (!keys || tween.keys.some((key) => keys.has(key)))) return true;
  return false;
}

export const isText = (item) => item.kind === "text" && Boolean(String(item.text ?? "").trim());
// Layers the size and overlap checks leave alone.
export const isDecor = (item) => item.role === "decor" || item.role === "background";

/** Relative luminance (WCAG) of [r, g, b] from 0 to 255. */
export function luminance([red, green, blue]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrastOf(lumA, lumB) {
  const [light, dark] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (light + 0.05) / (dark + 0.05);
}

/** [r, g, b, a] (0–255) of a hex color, or null. */
export function hexRgba(color) {
  if (typeof color !== "string") return null;
  const match = /^#([\da-f]{3,8})$/i.exec(color.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((digit) => digit + digit).join("");
  if (digits.length !== 6 && digits.length !== 8) return null;
  const channel = (index) => Number.parseInt(digits.slice(index, index + 2), 16);
  return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) : 255];
}

/** The colors of a paint: one for a hex color, each stop's for a gradient. */
export function paintColors(paint) {
  if (typeof paint === "string") return hexRgba(paint) ? [paint] : [];
  if (paint && typeof paint === "object" && Array.isArray(paint.stops)) return paint.stops.map((stop) => stop?.color).filter((color) => hexRgba(color));
  return [];
}

/** The solid colors a text is drawn with at sample `index`: its animated fill, if the model has it. */
export function fillColorsAt(item, index) {
  return item.samples.colors ? item.samples.colors[index] ?? [] : paintColors(item.fill);
}

export const isGradient = (paint) => Boolean(paint && typeof paint === "object" && Array.isArray(paint.stops) && paint.stops.length >= 2);

// Footage behind a full-frame tint this dark or darker is wallpaper, not a shot: three first
// passes in a row ended on the same centered name and line over darkened, moving footage.
const DIMMED = 0.35;
const FULL_FRAME = 0.9;

/** At sample `index`, the painted shapes covering the frame that tint a playing video under them at DIMMED or more. */
export function tintsAt(model, index) {
  const frame = model.width * model.height;
  const videos = model.items.filter((item) => item.kind === "video" && item.samples.opacity[index] > 0.5);
  if (!videos.length) return [];
  return model.items.filter((item) => {
    if (item.kind === "video" || item.kind === "image" || item.kind === "text" || item.isMask || !item.painted) return false;
    const alpha = item.samples.opacity[index] * (item.paintAlpha ?? 1);
    if (alpha < DIMMED) return false;
    if (area(intersection(visibleBoxAt(model, item, index), { x0: 0, y0: 0, x1: model.width, y1: model.height })) < FULL_FRAME * frame) return false;
    return videos.some((video) => video.z < item.z);
  });
}

/** At sample `index`, a painted shape covering the frame tints a playing video under it at DIMMED or more. */
export const dimmedAt = (model, index) => tintsAt(model, index).length > 0;
