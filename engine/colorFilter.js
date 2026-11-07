// color_filter {sceneId, layerId | layerIds, filter, strength?}: a named look in one op, like the
// filter strip of a social video editor (44% of top social templates use one). Each
// filter is one or two ordinary Color effects (engine/effects), named "Filter <name>" so a second
// color_filter on the layer replaces the first; "none" removes it. strength 0 to 1 moves every
// setting toward neutral (1, the default, is the filter as written).
import { effectDefaults } from "./effects/catalog.js";
import { uid } from "./model.js";

export const COLOR_FILTERS = Object.freeze({
  warm: [["white-balance", { temperature: 22, tint: 3 }], ["hue-saturation", { saturation: 1.08 }]],
  cool: [["white-balance", { temperature: -20, tint: -2 }], ["hue-saturation", { saturation: 0.95 }]],
  film: [["color-wheels", { lift: 0.035, liftBlue: 0.02, gain: 0.97, gainRed: 0.03, gainBlue: -0.03 }], ["hue-saturation", { saturation: 0.88 }]],
  "teal-orange": [["color-wheels", { liftRed: -0.04, liftGreen: 0.01, liftBlue: 0.06, gainRed: 0.08, gainGreen: 0.02, gainBlue: -0.1 }], ["hue-saturation", { saturation: 1.15 }]],
  faded: [["color-wheels", { lift: 0.07, gain: 0.94 }], ["hue-saturation", { saturation: 0.75 }]],
  vivid: [["hue-saturation", { saturation: 1.3 }], ["curves", { master: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]] }]],
  mono: [["hue-saturation", { saturation: 0 }], ["curves", { master: [[0, 0], [0.25, 0.19], [0.75, 0.83], [1, 1]] }]],
  "bleach-bypass": [["hue-saturation", { saturation: 0.45 }], ["curves", { master: [[0, 0], [0.25, 0.16], [0.75, 0.87], [1, 1]] }]],
});
export const FILTER_PREFIX = "Filter ";
const round = (value) => Math.round(value * 10000) / 10000;

/** A filter's settings moved toward neutral by `strength` (a curve's outputs toward its inputs). */
function scaled(effect, parameters, strength) {
  if (strength === 1) return parameters;
  const neutral = effectDefaults(effect);
  return Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, Array.isArray(value)
    ? value.map(([input, output]) => [input, round(input + (output - input) * strength)])
    : round(neutral[key] + (value - neutral[key]) * strength)]));
}

/** The engine steps for one color_filter: delete the layer's old filter, add the new one's effects. */
export function colorFilterSteps(document, operation) {
  const fail = (message) => { throw new Error(`color_filter: ${message}`); };
  const names = [...Object.keys(COLOR_FILTERS), "none"];
  if (!names.includes(operation.filter)) fail(`filter is one of ${names.join(", ")}, not ${JSON.stringify(operation.filter)}.`);
  const strength = operation.strength ?? 1;
  if (typeof strength !== "number" || !(strength > 0) || strength > 1) fail("strength is 0 to 1 (1 is the filter as written).");
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) fail(`scene ${operation.sceneId} was not found.`);
  const ids = [...new Set([...(operation.layerIds ?? []), ...(operation.layerId ? [operation.layerId] : [])])];
  if (!ids.length) fail("give layer or layers: the footage, picture or group to filter.");
  const steps = [];
  for (const layerId of ids) {
    const layer = scene.layers.find((item) => item.id === layerId);
    if (!layer) fail(`layer ${layerId} is not in this scene.`);
    if (layer.type === "audio") fail(`"${layer.name}" is an audio layer; a filter goes on a picture.`);
    for (const animation of layer.animations ?? [])
      if (String(animation.name ?? "").startsWith(FILTER_PREFIX)) steps.push({ type: "delete_animation", sceneId: scene.id, layerId, animationId: animation.id });
    for (const [number, [effect, parameters]] of (COLOR_FILTERS[operation.filter] ?? []).entries()) {
      const id = `${layerId}-filter-${operation.filter}-${number}-${uid().slice(0, 8)}`;
      steps.push({ type: "add_animation", sceneId: scene.id, layerId, id, effect, parameters: scaled(effect, parameters, strength) },
        { type: "rename_animation", sceneId: scene.id, layerId, animationId: id, name: `${FILTER_PREFIX}${operation.filter}${number ? ` ${number + 1}` : ""}` });
    }
  }
  return steps;
}
