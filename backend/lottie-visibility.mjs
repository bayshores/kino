// Keeps a layer's visibility switches instant in Lottie.
//
// Lottie export samples every frame and joins neighbouring samples with linear keyframes. When a
// layer is hidden or shown between two frames (a Hide or Show operation, or media Play), a linear
// keyframe would fade the opacity across that frame gap in players that draw between frames.
// A hold keyframe (h: 1) keeps the earlier value until the next frame instead, so the layer
// appears or disappears at once, as it does in the editor and in PNG, GIF and video exports.
//
// Opacity hold keyframes were chosen over in and out points (ip/op): a layer has one in point and
// one out point, so they can describe only one visible range, while Hide and Show can hide and
// show a layer several times. Holding only the switch frames also keeps any opacity animation
// inside the visible ranges.

/**
 * Indexes of sampled frames after which visibility changes: frame i is in the result when
 * frame i and frame i + 1 differ in `visible`. `states` are sampled layer states, one per frame.
 */
export function visibilitySwitchFrames(states) {
  const frames = new Set();
  for (let index = 0; index + 1 < states.length; index += 1) {
    const visibilityChanged = (states[index]?.visible === false) !== (states[index + 1]?.visible === false);
    const discreteOpacityChanged = (states[index]?._discreteOpacity ?? null) !==
      (states[index + 1]?._discreteOpacity ?? null);
    if (visibilityChanged || discreteOpacityChanged) frames.add(index);
  }
  return frames;
}

/**
 * Indexes of sampled frames after which a cycling loop (behavior.js) starts a new pass: the
 * value jumps back there, so every transform key holds instead of sliding across the gap.
 */
export function loopRestartFrames(states) {
  const frames = new Set();
  for (let index = 0; index + 1 < states.length; index += 1)
    if ((states[index]?._loopPass ?? null) !== (states[index + 1]?._loopPass ?? null) && states[index + 1]?._loopPass) frames.add(index);
  return frames;
}

/**
 * Indexes of sampled frames after which a steps curve (engine/easing.js) jumps: every transform
 * and opacity key holds there, so the value changes at once as in the other exports.
 */
export function stepFrames(states) {
  const frames = new Set();
  for (let index = 0; index + 1 < states.length; index += 1)
    if ((states[index]?._stepsAt ?? null) !== (states[index + 1]?._stepsAt ?? null)) frames.add(index);
  return frames;
}

/**
 * Turns the keyframes of an animated Lottie property at the frame indexes in `frames` into hold
 * keyframes, which keep their value until the next keyframe. A static property (a: 0) is
 * returned unchanged. Returns the property.
 */
export function holdKeyframesAt(property, frames) {
  if (property?.a !== 1 || !Array.isArray(property.k) || frames.size === 0) return property;
  for (const keyframe of property.k) {
    if (!frames.has(keyframe.t)) continue;
    delete keyframe.e;
    delete keyframe.i;
    delete keyframe.o;
    keyframe.h = 1;
  }
  return property;
}
