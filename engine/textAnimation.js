// A shared drawing plan for the editor, raster exports, Change text and Lottie. Source ranges
// keep each shaped glyph with its unit while typography changes. Only explicit text settings
// opt into independent operation units; legacy first-unit animations keep their old timing.
import { enabledAnimations } from "./animationEnabled.js";
import { evaluateLayer, resolveInitialAnimations } from "./animation.js";
import { defaultFonts } from "./fonts.js";
import { layerMatrix, point } from "./geometry.js";
import { layoutText, resizeTextLayer, textUnits } from "./textLayout.js";
import { textUnitGroup } from "./textUnitGeometry.js";

const MODES = ["letters", "words", "lines", "layer"];
export const finerTextUnit = (left, right) => MODES.indexOf(right) >= 0 && MODES.indexOf(right) < MODES.indexOf(left) ? right : left;
export const independentTextOperation = (animation) => animation.textAnchor != null || animation.textClip != null || animation.preset?.text;

export function legacyTextUnitMode(layer) {
  return enabledAnimations(layer?.animations).find((animation) => MODES.slice(0, 3).includes(animation.unit))?.unit ?? "layer";
}

export function textAnimationMode(layer) {
  return enabledAnimations(layer?.animations).reduce((mode, animation) => independentTextOperation(animation)
    ? finerTextUnit(finerTextUnit(mode, animation.unit), animation.textAnchor) : mode, legacyTextUnitMode(layer));
}

export function textAnimationPlan(layer, fonts = defaultFonts, drawingMode) {
  const animations = enabledAnimations(layer.animations);
  const legacyMode = legacyTextUnitMode(layer);
  const mode = finerTextUnit(textAnimationMode(layer), drawingMode);
  const layout = layoutText(layer, fonts);
  const units = textUnits(layout, mode);
  return { layer, fonts, layout, units, mode, legacyMode,
    independent: animations.some(independentTextOperation),
    clips: animations.filter((animation) => animation.textClip === true),
    separate: mode !== "layer" || animations.some((animation) => animation.textClip === true),
  };
}

export function textAnimationOptions(plan, index) {
  const textUnit = plan.units[index];
  const unitGroups = Object.fromEntries(MODES.map((mode) => [mode, textUnitGroup(plan.layout, textUnit, mode)]));
  const legacy = unitGroups[plan.legacyMode];
  return { unit: plan.legacyMode, unitIndex: legacy?.index ?? 0, unitCount: Math.max(1, legacy?.count ?? 1),
    textUnit, unitGroups, fonts: plan.fonts };
}

export function textAnimationUnitState(plan, index, time, { design = false } = {}) {
  const options = textAnimationOptions(plan, index);
  const state = resizeTextLayer(design ? plan.layer : evaluateLayer(plan.layer, time, options), plan.fonts);
  if (design || !plan.clips.length) return state;
  // A clip stays at the unit's resting position and follows other animations. Excluding all
  // clipped effects from this baseline avoids moving a mask with the content it is revealing.
  // Parent-space polygons avoid matrix inverses and stay finite at zero or mirrored scales.
  const baseline = resizeTextLayer(evaluateLayer({ ...plan.layer,
    animations: resolveInitialAnimations(plan.layer, options).filter((animation) => animation.enabled !== false && !animation.textClip) }, time, options), plan.fonts);
  const layout = layoutText(baseline, plan.fonts);
  const matrix = layerMatrix(baseline);
  const clips = plan.clips.flatMap((animation) => {
    const group = textUnitGroup(layout, plan.units[index], animation.unit ?? "layer");
    if (!group) return [];
    const { x, y, width, height } = group.bounds;
    return [[point(matrix, x, y), point(matrix, x + width, y), point(matrix, x + width, y + height), point(matrix, x, y + height)]];
  });
  return { ...state, _textClips: clips };
}
