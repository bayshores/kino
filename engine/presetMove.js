// A preset animation moves with its layer.
//
// A preset (a slide, a custom text effect) stores the places it works out from the layer as
// absolute x and y in its `from` and `to`: a Slide In ends at the layer's own y. So when
// update_layer or update_layers moves a layer (x, y) or changes its size (a slide travels a
// share of the layer's height), each preset's x and y change by what the preset itself would
// work out differently at the layer's new place and size. A preset left behind before keeps its
// offset, and its other values (opacity, scale) stay as they are. Animations without a preset
// hold values the agent wrote, so they stay where they are (the receipt warns about those).
import { isComposedAnimation } from "./animationTree.js";
import { presetLayerGeometry, presetValues } from "./presetCatalog.js";
import { isRecord } from "./numbers.js";

const GEOMETRY = ["x", "y", "width", "height"];
const round = (value) => Math.round(value * 1e6) / 1e6 + 0;

/**
 * `after`'s animations with every preset's x and y moved the way the layer changed from
 * `before` to `after`, and `moved`: the animations that moved (as they were). The same array
 * when nothing moved.
 */
export function movePresetAnimations(before, after, { document, fonts } = {}) {
  const animations = after?.animations;
  if (!Array.isArray(animations) || !before || GEOMETRY.every((key) => before[key] === after[key])) return { animations, moved: [] };
  const geometry = (layer) => {
    try { return presetLayerGeometry(layer, document, fonts); } catch { return layer; }
  };
  const [was, now] = [geometry(before), geometry(after)];
  const moved = [];
  const carry = (animation) => {
    if (!isRecord(animation)) return animation;
    if (isComposedAnimation(animation)) {
      if (!Array.isArray(animation.animations)) return animation;
      const inner = animation.animations.map(carry);
      return inner.every((item, index) => item === animation.animations[index]) ? animation : { ...animation, animations: inner };
    }
    if (!isRecord(animation.preset)) return animation;
    let old, next;
    try { [old, next] = [presetValues(animation.preset, was), presetValues(animation.preset, now)]; } catch { return animation; }
    const side = (name) => {
      const values = animation[name];
      if (!isRecord(values)) return values;
      let changed = values;
      for (const key of ["x", "y"]) {
        const change = (next[name]?.[key] ?? 0) - (old[name]?.[key] ?? 0);
        if (typeof values[key] !== "number" || Math.abs(change) < 1e-9) continue;
        changed = { ...changed, [key]: round(values[key] + change) };
      }
      return changed;
    };
    const [from, to] = [side("from"), side("to")];
    if (from === animation.from && to === animation.to) return animation;
    moved.push(animation);
    return { ...animation, from, to };
  };
  const carried = animations.map(carry);
  return { animations: moved.length ? carried : animations, moved };
}
