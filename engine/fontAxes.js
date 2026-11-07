// Variable font axes on a text layer: `axes: {wght?, wdth?, slnt?, opsz?}`.
//
// A variable font holds every weight (wght), width (wdth, % of normal), slant (slnt, degrees)
// and optical size (opsz, points) between its own limits. A text layer picks a point on each
// axis with `axes`, and an animation can move it (`from:{axes:{wght:300}}, to:{axes:{wght:800}}`),
// so the letters grow bolder or wider as they play. fonts.js asks fontkit for that instance
// (getVariation) and the renderer draws its outlines like any other face, in Node and Electron.
//
// Every instance is a new font object, so an animated value is rounded (wght to 5 units, the
// others to 1% of the axis) and a face keeps more instances for an animated layer: a sweep
// reuses about a hundred instances instead of making one per frame.

/** The axes a text layer can set, with the widest values any font uses (the font narrows them). */
export const AXIS_LIMITS = Object.freeze({
  wght: [1, 1000],
  wdth: [1, 1000],
  slnt: [-90, 90],
  opsz: [1, 1000],
});
export const AXIS_TAGS = Object.freeze(Object.keys(AXIS_LIMITS));

/** A saved `axes` value, checked: an object of known axes with numbers in their limits. */
export function normalizeAxes(value, path = "axes") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: must be an object like {wght: 700, wdth: 90}`);
  const result = {};
  for (const [tag, number] of Object.entries(value)) {
    if (!AXIS_TAGS.includes(tag)) throw new Error(`${path}.${tag}: kino animates the axes ${AXIS_TAGS.join(", ")}`);
    const [min, max] = AXIS_LIMITS[tag];
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max)
      throw new Error(`${path}.${tag}: must be a number from ${min} to ${max}`);
    result[tag] = number;
  }
  return result;
}

/** update_layer's axes: the patch merged into the layer's axes per axis, a null axis removed (null when none is left). */
export function mergeAxes(current, patch) {
  const merged = { ...current, ...patch };
  for (const tag of Object.keys(merged)) if (merged[tag] === null) delete merged[tag];
  return Object.keys(merged).length ? merged : null;
}

/** True when an animation of the layer changes its axes. */
export function animatesAxes(layer) {
  return Array.isArray(layer?.animations) && layer.animations.some((animation) =>
    animation && (animation.from?.axes || animation.to?.axes));
}

/**
 * The fontkit variation settings for a layer on a face's axes: its `axes`, with `fontWeight` as
 * the weight when `axes.wght` is not set. Values are clamped to the face's range; `quantize`
 * rounds them (wght to 5 units, others to 1% of the axis) so animated frames share instances.
 */
export function variationSettings(faceAxes, layer, { quantize = false } = {}) {
  const asked = { ...(Number.isFinite(Number(layer.fontWeight)) ? { wght: Number(layer.fontWeight) } : {}), ...(layer.axes ?? {}) };
  const settings = {};
  for (const tag of AXIS_TAGS) {
    const axis = faceAxes?.[tag];
    if (!axis || !Number.isFinite(asked[tag])) continue;
    let value = Math.max(axis.min, Math.min(axis.max, asked[tag]));
    if (quantize) {
      const step = tag === "wght" ? 5 : (axis.max - axis.min) / 100;
      if (step > 0) value = Math.max(axis.min, Math.min(axis.max, axis.min + Math.round((value - axis.min) / step) * step));
    }
    settings[tag] = Math.round(value * 1000) / 1000;
  }
  return settings;
}

/**
 * What is wrong with asking a face for these axes, or null: an axis the face does not have, or a
 * value outside its range (named with the range, so the next call can fix it).
 */
export function axesProblem(face, axes, family = face?.family) {
  if (!axes) return null;
  const faceAxes = face?.font?.variationAxes ?? {};
  for (const [tag, value] of Object.entries(axes)) {
    const axis = faceAxes[tag];
    if (!axis) {
      const has = AXIS_TAGS.filter((name) => faceAxes[name]);
      return `${family} has no ${tag} axis${has.length ? ` (it has ${has.join(", ")})` : " (it is not a variable font)"}; send axes:{${tag}:null} (or axes:null for all) with the font change, and delete any axes animation`;
    }
    if (value < axis.min || value > axis.max)
      return `${tag} ${value} is outside ${family}'s range ${axis.min} to ${axis.max}`;
  }
  return null;
}

/** Every axes value a layer asks for: its own and each animation's from and to. */
export function askedAxes(layer) {
  const values = layer?.axes ? [layer.axes] : [];
  for (const animation of Array.isArray(layer?.animations) ? layer.animations : [])
    for (const side of [animation?.from?.axes, animation?.to?.axes]) if (side) values.push(side);
  return values;
}

/**
 * Axes between `from` and `to` at progress p. An axis only one side names starts (or ends) at
 * the layer's own value (`fontWeight` for wght), else holds the side's value.
 */
export function interpolateAxes(from = {}, to = {}, progress, layer = {}) {
  const own = { ...(Number.isFinite(Number(layer.fontWeight)) ? { wght: Number(layer.fontWeight) } : {}), ...(layer.axes ?? {}) };
  const result = {};
  for (const tag of AXIS_TAGS) {
    if (!(tag in (from ?? {})) && !(tag in (to ?? {}))) continue;
    const start = from?.[tag] ?? own[tag] ?? to[tag];
    const end = to?.[tag] ?? own[tag] ?? from[tag];
    result[tag] = start + (end - start) * progress;
  }
  return result;
}

const axesSignature = (layer) => JSON.stringify([askedAxes(layer), layer.fontFamily, layer.fontSource, layer.fontStyle]);

/**
 * Refuses an edit that asks a text for axes its face cannot draw: an axis the face lacks or a
 * value outside its range, named with the range. Only text whose axes or font changed is checked,
 * so an older document keeps opening and saving.
 */
export function assertAxesInRange(before, after, fonts) {
  if (!fonts?.renderingFace) return;
  const old = new Map();
  for (const scene of before?.scenes ?? []) for (const layer of scene.layers ?? []) old.set(`${scene.id}/${layer.id}`, axesSignature(layer));
  for (const scene of after.scenes ?? []) for (const layer of scene.layers ?? []) {
    if (layer.type !== "text") continue;
    const asked = askedAxes(layer);
    if (!asked.length || old.get(`${scene.id}/${layer.id}`) === axesSignature(layer)) continue;
    let face;
    try { face = fonts.renderingFace({ ...layer, axes: undefined, animations: [] }); } catch { continue; }
    // The font file is missing and another face stands in: its ranges say nothing about the
    // asked font, so the edit goes through and check's font_fallback names the missing face.
    if (face.missingReference) continue;
    const family = face.family ?? layer.fontFamily;
    for (const axes of asked) {
      const problem = axesProblem(face, axes, family);
      if (problem) throw new Error(`${layer.name ?? layer.id}: ${problem}.`);
    }
  }
}
