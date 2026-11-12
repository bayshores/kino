// The saved shape of a scene's `finish` and `letterbox` fields (drawn by engine/sceneFinish.js).
// Kept apart so engine/model.js can check them without importing the layer builder.

export const FINISH_KEYS = ["grain", "blackLift", "halation", "vignette", "soften", "haze"];
// The documented starting point `finish: true` stands for. Values are the synthesis table's
// "frame finish" row (grain 0.15, blackLift 0.04, halation 0.2, vignette 0.3): a guess, not a
// measurement. The type-on study's heavy vignette (nearly black corners) is vignette 0.9.
// soften: edge softness S = mean|I - box1(I)| / mean|I - box4(I)| on edge pixels of luma at 854 px
// wide (lower is softer). Seven vetted reference stills: 0.21 to 0.34 (median about 0.29); the
// transitions study face frame with finish but no soften: 0.335; with soften 0.35: 0.314. A
// restrained start that moves toward the references without blurring the frame. haze stays off.
// Skeptic re-measure (window 4 vs 1 on the top 10% gradient pixels, same study frame at 2.25 s;
// a different mask, so other numbers): references 0.38 to 0.45 (one at 0.26), ours 0.488 with no
// soften, 0.471 at 0.35, 0.453 at 0.6 with the face still in focus. 0.5 sits between those two.
export const SOFTEN_START = 0.5;
export const FINISH_START = { grain: 0.15, blackLift: 0.04, halation: 0.2, vignette: 0.3, soften: SOFTEN_START };
export const LETTERBOX_MIN = 1.2;
export const LETTERBOX_MAX = 6;

/** A saved finish: an object of the four numbers, or undefined when it is off. `fail(path, message)` throws. */
export function normalizeSceneFinish(value, path, fail) {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return { ...FINISH_START };
  if (typeof value !== "object" || Array.isArray(value))
    fail(path, "must be true or {grain, blackLift, halation, vignette, soften, haze}, each 0 to 1, such as {grain:0.15, vignette:0.3}");
  const finish = {};
  for (const key of Object.keys(value)) {
    if (!FINISH_KEYS.includes(key)) fail(`${path}.${key}`, `is not a finish part; use ${FINISH_KEYS.join(", ")}`);
    const amount = value[key];
    if (amount === undefined || amount === null || amount === false) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1) fail(`${path}.${key}`, "must be a number from 0 to 1");
    if (amount > 0) finish[key] = amount;
  }
  return Object.keys(finish).length ? finish : undefined;
}

/** A saved letterbox: the picture's width : height (such as 2.35), or undefined when it is off. */
export function normalizeLetterbox(value, path, fail) {
  if (value === undefined || value === null || value === false || value === 0) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < LETTERBOX_MIN || value > LETTERBOX_MAX)
    fail(path, `must be the picture's width : height from ${LETTERBOX_MIN} to ${LETTERBOX_MAX}, such as 2.35 (false removes the bars)`);
  return value;
}

/** The height of each bar in scene pixels (0 when the scene is already that wide or wider). */
export function letterboxBar(width, height, ratio) {
  if (!(ratio > 0)) return 0;
  const bar = (height - width / ratio) / 2;
  return bar >= 0.5 ? Math.round(bar * 100) / 100 : 0;
}

/** True when a scene asks for a finish or bars (so an export that cannot draw them can say so). */
export function hasSceneFinish(scene) {
  return Boolean(scene?.finish || scene?.letterbox);
}
