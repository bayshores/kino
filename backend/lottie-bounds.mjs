import { pathBounds } from "../engine/vectorPath.js";
import { layoutText, textUnits } from "../engine/textLayout.js";
import { effectPadding } from "./lottie-effects.mjs";
import { enabledAnimations } from "../engine/animationEnabled.js";
import { letterSpacingPixels } from "../engine/letterSpacing.js";
import { hasCounters, hasTextChanges } from "../engine/textChange.js";
import { isFillEnabled } from "../engine/paints.js";
import { isStringDrawnAt, textDrawnPlansAt, textStringPlans, textStringUnitState } from "../engine/textChangeDraw.js";
import { textAnimationPlan, textAnimationUnitState } from "../engine/textAnimation.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_DETAILED_TEXT_LENGTH = 65_536;

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

function matrixFor(helper, parent, local, label) {
  const value = helper(parent, local);
  if (!Array.isArray(value) || value.length !== 6 || !value.every(Number.isFinite)) {
    throw new Error(`${label} produced a non-finite transform while measuring Lottie bounds.`);
  }
  return value;
}

function localBounds(layer, state, fonts) {
  const width = Math.max(0, finite(state.width));
  const height = Math.max(0, finite(state.height));

  if (["rectangle", "ellipse", "star", "image"].includes(layer.type)) {
    return { x: 0, y: 0, width, height };
  }

  if (layer.type === "path") {
    const bounds = pathBounds(String(state.path ?? ""));
    const base = state.pathBounds ?? layer.pathBounds;
    const baseWidth = finite(base?.width);
    const baseHeight = finite(base?.height);
    const scaleX = baseWidth > 0 ? width / baseWidth : 1;
    const scaleY = baseHeight > 0 ? height / baseHeight : 1;
    return {
      x: bounds.x * scaleX,
      y: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
    };
  }

  if (layer.type === "text") return textBounds(state, width, fonts);
  return null;
}

function textBounds(state, boxWidth, fonts) {
  const text = String(state.text ?? "");
  if (!text) return { x: 0, y: 0, width: 0, height: 0 };
  // Very large strings get a conservative envelope without materializing every
  // outline. Normal text uses the exact same glyph metrics as its drawing.
  if (text.length > MAX_DETAILED_TEXT_LENGTH) {
    const fontSize = Math.max(1, finite(state.fontSize, 24));
    const width = Math.max(boxWidth, text.length * (fontSize * 2 + Math.abs(letterSpacingPixels(state.letterSpacing, state.fontSize))));
    return { x: -width, y: -fontSize, width: width * 2, height: (text.length + 1) * Math.max(1, finite(state.lineHeight, 1.2) * fontSize) + fontSize * 2 };
  }
  const layout = layoutText(state, fonts);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const line of layout.lines) for (const glyph of line.glyphs) {
    if (!glyph.path && !glyph.color) continue;
    const x = line.x + glyph.x + glyph.bounds.x;
    const y = line.y + glyph.y + glyph.bounds.y;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + glyph.bounds.width); bottom = Math.max(bottom, y + glyph.bounds.height);
  }
  return left === Infinity ? {x: 0, y: 0, width: 0, height: 0} : {x: left, y: top, width: right - left, height: bottom - top};
}

function includeTransformed(bounds, matrix, include) {
  if (!bounds) return;
  const [a, b, c, d, e, f] = matrix;
  const strokeFactor = bounds.strokeAlign === "inside" ? 0 : bounds.strokeAlign === "outside" ? 10 : 5;
  const strokeOutset = Math.max(0, finite(bounds.strokeWidth)) * strokeFactor + Math.max(0, finite(bounds.effectPadding));
  const left = bounds.x - strokeOutset;
  const top = bounds.y - strokeOutset;
  const right = bounds.x + bounds.width + strokeOutset;
  const bottom = bounds.y + bounds.height + strokeOutset;
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  for (const [x, y] of corners) {
    const tx = a * x + c * y + e;
    const ty = b * x + d * y + f;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      throw new Error("Lottie composition bounds exceeded the supported numeric range.");
    }
    include(tx, ty);
  }
}

/**
 * Measure the conservative local-space bounds for a Lottie precomposition.
 *
 * `nodes` is the visibleTree-shaped list of layers inside the precomposition.
 * Each sampled child matrix is composed into its parent's local coordinate
 * space. Non-clipped groups recurse; clipped groups contribute their own
 * animated rectangle because their descendants cannot escape it.
 */
export function compositionBounds(nodes, frameTimes, helpers) {
  if (!Array.isArray(nodes)) throw new TypeError("Lottie composition nodes must be an array.");
  if (!Array.isArray(frameTimes) || !frameTimes.every(Number.isFinite)) {
    throw new TypeError("Lottie composition frameTimes must be an array of finite numbers.");
  }
  if (
    typeof helpers?.sampleLayer !== "function" ||
    typeof helpers?.localMatrix !== "function" ||
    typeof helpers?.multiplyMatrix !== "function"
  ) {
    throw new TypeError("Lottie composition bounds require sampleLayer, localMatrix and multiplyMatrix helpers.");
  }

  const times = frameTimes.length ? frameTimes : [0];
  const padding = (layer, state) => helpers.ignoreEffects?.has(layer.id) ? 0 : effectPadding(state);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const identityMatrices = times.map(() => [...IDENTITY]);
  const stack = [{ nodes, parentMatrices: identityMatrices }];

  while (stack.length) {
    const current = stack.pop();
    for (let nodeIndex = current.nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
      const node = current.nodes[nodeIndex];
      const layer = node?.layer;
      if (!layer || layer.visible === false) continue;

      // A Counter (counter.js) changes its numbers from frame to frame: the strings each frame
      // draws, in each of their units' states, as backend/lottie-text.mjs exports them.
      if (layer.type === "text" && hasCounters(layer)) {
        for (let index = 0; index < times.length; index++) {
          for (const plan of textDrawnPlansAt(layer, times[index], helpers.fonts)) {
            for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
              const state = textStringUnitState(layer, plan, unitIndex, times[index], helpers.fonts);
              const matrix = matrixFor(helpers.multiplyMatrix, current.parentMatrices[index] ?? IDENTITY, helpers.localMatrix(layer, state), "Text unit");
              includeTransformed({...textBounds(state, finite(state.width), helpers.fonts), strokeWidth: Math.max(0, finite(state.strokeWidth)), strokeAlign: state.strokeAlign, effectPadding: padding(layer, state)}, matrix, include);
            }
          }
        }
        continue;
      }
      // A Change text (textChange.js): every string, on the frames that draw it, in each of its
      // units' states, as backend/lottie-text.mjs exports them.
      if (layer.type === "text" && hasTextChanges(layer)) {
        for (const plan of textStringPlans(layer, helpers.fonts)) {
          for (let index = 0; index < times.length; index++) {
            if (!isStringDrawnAt(layer, plan, times[index])) continue;
            for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
              const state = textStringUnitState(layer, plan, unitIndex, times[index], helpers.fonts);
              const matrix = matrixFor(helpers.multiplyMatrix, current.parentMatrices[index] ?? IDENTITY, helpers.localMatrix(layer, state), "Text unit");
              includeTransformed({...textBounds(state, finite(state.width), helpers.fonts), strokeWidth: Math.max(0, finite(state.strokeWidth)), strokeAlign: state.strokeAlign, effectPadding: padding(layer, state)}, matrix, include);
            }
          }
        }
        continue;
      }

      const plan = layer.type === "text" ? textAnimationPlan(layer, helpers.fonts) : null;
      if (plan?.independent) {
        for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
          for (let index = 0; index < times.length; index++) {
            const state = textAnimationUnitState(plan, unitIndex, times[index]);
            const matrix = matrixFor(helpers.multiplyMatrix, current.parentMatrices[index] ?? IDENTITY, helpers.localMatrix(layer, state), "Text unit");
            includeTransformed({ ...textBounds(state, finite(state.width), helpers.fonts), strokeWidth: Math.max(0, finite(state.strokeWidth)),
              strokeAlign: state.strokeAlign, effectPadding: padding(layer, state) }, matrix, include);
          }
        }
        continue;
      }
      const textMode = layer.type === "text" && enabledAnimations(layer.animations).find((animation) => ["letters", "words", "lines"].includes(animation.unit))?.unit;
      if (textMode) {
        const count = Math.max(1, textUnits(layoutText(layer, helpers.fonts), textMode).length);
        for (let unitIndex = 0; unitIndex < count; unitIndex++) {
          const unitStates = helpers.sampleLayer(layer, times, unitIndex, count, textMode);
          if (!Array.isArray(unitStates) || unitStates.length !== times.length) throw new Error("Text unit bounds require one state per frame.");
          for (let index = 0; index < unitStates.length; index++) {
            const state = unitStates[index];
            const matrix = matrixFor(helpers.multiplyMatrix, current.parentMatrices[index] ?? IDENTITY, helpers.localMatrix(layer, state), "Text unit");
            // The whole shaped line is a conservative envelope for each unit.
            includeTransformed({...textBounds(state, finite(state.width), helpers.fonts), strokeWidth: Math.max(0, finite(state.strokeWidth)), strokeAlign: state.strokeAlign, effectPadding: padding(layer, state)}, matrix, include);
          }
        }
        continue;
      }

      const states = helpers.sampleLayer(layer, times);
      if (!Array.isArray(states) || states.length !== times.length) {
        throw new Error(`Layer “${layer.name ?? layer.id ?? "unknown"}” returned an invalid sample set for Lottie bounds.`);
      }
      const worldMatrices = states.map((state, index) => {
        const local = helpers.localMatrix(layer, state);
        if (!Array.isArray(local) || local.length !== 6 || !local.every(Number.isFinite)) {
          throw new Error(`Layer “${layer.name ?? layer.id ?? "unknown"}” has a non-finite local transform while measuring Lottie bounds.`);
        }
        return matrixFor(
          helpers.multiplyMatrix,
          current.parentMatrices[index] ?? IDENTITY,
          local,
          `Layer “${layer.name ?? layer.id ?? "unknown"}”`,
        );
      });

      if (layer.type === "group") {
        if (layer.clipContent || states.some((state) => isFillEnabled(state) || state.strokeWidth > 0)) {
          for (let index = 0; index < states.length; index += 1) {
            const state = states[index];
            includeTransformed(
              {
                x: 0,
                y: 0,
                width: Math.max(0, finite(state.width)),
                height: Math.max(0, finite(state.height)),
                strokeWidth: Math.max(0, finite(state.strokeWidth)),
                strokeAlign: state.strokeAlign,
                effectPadding: padding(layer, state),
              },
              worldMatrices[index],
              include,
            );
          }
        }
        if (!layer.clipContent && Array.isArray(node.children) && node.children.length) {
          if (states.some((state) => padding(layer, state) > 0)) {
            const bounds = compositionBounds(node.children, times, helpers);
            for (let index = 0; index < states.length; index++)
              includeTransformed({ ...bounds, effectPadding: padding(layer, states[index]) }, worldMatrices[index], include);
          } else stack.push({ nodes: node.children, parentMatrices: worldMatrices });
        }
        continue;
      }

      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        const local = localBounds(layer, state, helpers.fonts);
        if (!local) continue;
        includeTransformed(
          { ...local, strokeWidth: Math.max(0, finite(state.strokeWidth)), strokeAlign: state.strokeAlign, effectPadding: padding(layer, state) },
          worldMatrices[index],
          include,
        );
      }
    }
  }

  if (minX === Infinity) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  const right = Math.ceil(maxX);
  const bottom = Math.ceil(maxY);
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  if (![x, y, right, bottom, width, height].every(Number.isFinite)) {
    throw new Error("Lottie composition bounds exceeded the supported numeric range.");
  }
  return { x, y, width, height };
}
