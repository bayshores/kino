import { glyphContours, layoutText, resizeTextLayer, unitGlyphs } from "../engine/textLayout.js";
import { serializePath } from "../engine/vectorPath.js";
import { lottieShapeParts } from "./lottie-shapes.mjs";
import { vectorLayer } from "./lottie-vector.mjs";
import { enabledAnimations } from "../engine/animationEnabled.js";
import { mapAnimationTree } from "../engine/animationTree.js";
import { hasCounters, hasTextChanges, isCounter } from "../engine/textChange.js";
import { isStringDrawnAt, textDrawnPlansAt, textStringPlans, textStringUnitState } from "../engine/textChangeDraw.js";
import { compositionBounds } from "./lottie-bounds.mjs";
import { lottieEffects } from "./lottie-effects.mjs";
import { textAnimationOptions, textAnimationPlan, textAnimationUnitState } from "../engine/textAnimation.js";
import { discreteOpacityProperty } from "./lottie-opacity.mjs";
import { clipTextLayer } from "./lottie-text-clips.mjs";
import { lottieColorTextUnit } from "./lottie-color-text.mjs";

const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));

function requireHelpers(helpers) {
  for (const name of ["sampleLayer", "localMatrix", "multiplyMatrix", "sampledTransform", "property", "colorToRgba"]) {
    if (typeof helpers?.[name] !== "function") {
      throw new TypeError(`Lottie text export requires the ${name} helper.`);
    }
  }
}

function outlineGlyphs(unit) {
  return unit.glyphs.map((glyph) => ({ glyph, contours: glyphContours(glyph) }))
    .filter((entry) => entry.contours.length > 0);
}

function sampledGlyphPaths(unit, label) {
  const outlines = outlineGlyphs(unit);
  try {
    return outlines.map((entry) => serializePath(entry.contours));
  } catch (error) {
    throw new Error(`${label} produced invalid font outline geometry: ${error.message}`);
  }
}

// `unit` is a unit of the layer's own layout; in each frame's layout it draws its own letters,
// wherever that layout puts them (textLayout.js unitGlyphs), as the editor does (render.js).
function shapeLayers(layer, unitIndex, unit, layouts, unitStates, parentMatrices, parentOpacities, helpers, nextIndex, frameCount) {
  const label = `Text layer “${layer.name ?? layer.id}” unit ${unitIndex + 1}`;
  const samples = layouts.map((layout) => ({ glyphs: unitGlyphs(layout, unit) }));
  if (samples.some((sample) => sample.glyphs.some((glyph) => glyph.color))) {
    const colored = lottieColorTextUnit({
      layer, unitIndex, samples, layouts, unitStates, parentMatrices, parentOpacities,
      helpers, nextIndex, frameCount,
    });
    if (!colored.length) return colored;
    if (unitStates.some((state) => state._textClips?.length) && lottieEffects(unitStates, helpers).length)
      helpers.warn?.({ code: "lottie-text-clip-filter-edges",
        message: "Clipped text keeps its native animation and mask in Lottie, but blur and shadow edges can differ from the editor and PNG export, especially under rotation, skew, or aligned strokes." });
    return colored.map((content) => clipTextLayer(content, unitStates, parentMatrices, helpers.compose));
  }
  const geometry = samples.map((sample) => sampledGlyphPaths(sample, label));
  const glyphPaints = samples.map((sample) => outlineGlyphs(sample).map(({ glyph }) => glyph.fill));
  const glyphCount = geometry[0]?.length ?? 0;
  if (geometry.some((sample) => sample.length !== glyphCount)) {
    throw new Error(`${label} changes its shaped glyph count across sampled frames; Lottie cannot safely preserve that text topology.`);
  }
  if (glyphCount === 0) return [];

  const { pathBounds: _layerPathBounds, ...textLayer } = layer;
  const paints = [];
  for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex += 1) {
    const shapeStates = unitStates.map((state, index) => {
      const { pathBounds: _pathBounds, ...withoutPathBounds } = state;
      const layout = layouts[index];
      return {
        ...withoutPathBounds,
        ...(glyphPaints[index][glyphIndex] === undefined ? {} : { fill: glyphPaints[index][glyphIndex] }),
        path: geometry[index][glyphIndex],
        width: layout.width,
        height: layout.height,
        gradientBounds: {
          x: 0,
          y: 0,
          width: layout.width,
          height: layout.height,
        },
      };
    });
    const pseudoLayer = {
      ...textLayer,
      fill: shapeStates[0].fill,
      type: "path",
      name: `${layer.name ?? "Text"} ${unitIndex + 1} Glyph ${glyphIndex + 1}`,
      path: shapeStates[0].path,
      width: shapeStates[0].width,
      height: shapeStates[0].height,
      gradientBounds: shapeStates[0].gradientBounds,
    };
    try {
      paints.push(lottieShapeParts(pseudoLayer, shapeStates, `${label} glyph ${glyphIndex + 1}`, helpers));
    } catch (error) {
      if (/contour|topology|corresponding contours|closed in both/iu.test(String(error?.message))) {
        throw new Error(`${label} changes glyph outline topology across sampled frames; Lottie cannot safely morph those glyphs. ${error.message}`);
      }
      throw error;
    }
  }

  const matrices = unitStates.map((state, index) => {
    const local = helpers.localMatrix(layer, state);
    return helpers.multiplyMatrix(parentMatrices[index], local);
  });
  const visibleStates = unitStates.map((state, index) => ({
    ...state,
    opacity: (state.visible === false ? 0 : clamp(state.opacity, 0, 1)) * clamp(parentOpacities[index], 0, 1),
  }));
  const transform = helpers.sampledTransform(
    layer,
    matrices,
    visibleStates,
    label,
    [0, 0],
  );
  const content = vectorLayer(paints, transform, {
    name: `${layer.name ?? "Text"} ${unitIndex + 1}`,
    frameCount, nextIndex, compose: helpers.compose,
  });
  if (unitStates.some((state) => state._textClips?.length) && lottieEffects(unitStates, helpers).length)
    helpers.warn?.({ code: "lottie-text-clip-filter-edges",
      message: "Clipped text keeps its native animation and mask in Lottie, but blur and shadow edges can differ from the editor and PNG export, especially under rotation, skew, or aligned strokes." });
  const effected = helpers.applyEffects
    ? helpers.applyEffects(content, layer, unitStates, matrices, visibleStates, { transformInChildren: paints.some((paint) => paint.matte) })
    : content;
  return [clipTextLayer(effected, unitStates, parentMatrices, helpers.compose)];
}

// The runs of consecutive frames in which `drawn` is true, as [{ first, last }] frame indexes.
function drawnRuns(drawn) {
  const runs = [];
  for (let index = 0; index < drawn.length; index += 1) {
    if (!drawn[index]) continue;
    if (runs.length && runs[runs.length - 1].last === index - 1) runs[runs.length - 1].last = index;
    else runs.push({ first: index, last: index });
  }
  return runs;
}

// A text layer with Change text operations (textChange.js). Each string it shows becomes its own
// set of text layers (one per unit, as for any text), shown only on the frames that draw that
// string: from its first frame (in point, `ip`) to just after its last one (out point, `op`).
// So no layer changes its glyphs, and the swap happens on the same frame as in the editor. Each
// frame is sampled as textChangeDraw.js draws it; frames outside a string's run hold its
// nearest drawn frame, which the in and out points hide.
function changedTextLayers(layer, frames, frameCount, nextIndex, parentMatrices, parentOpacities, helpers, fonts) {
  const output = [];
  const plans = textStringPlans(layer, fonts);
  for (const plan of plans) {
    const drawn = frames.map((time) => isStringDrawnAt(layer, plan, time));
    for (const run of drawnRuns(drawn)) {
      if (run.first >= frameCount) continue;
      const times = frames.map((_, index) => frames[Math.max(run.first, Math.min(run.last, index))]);
      const stringLayer = {
        ...layer,
        text: plan.text,
        name: plans.length > 1 ? `${layer.name ?? "Text"} (text ${plan.index + 1})` : layer.name,
      };
      for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex += 1) {
        const states = times.map((time) => {
          const state = textStringUnitState(layer, plan, unitIndex, time, fonts);
          // A hidden layer (Hide, Play range) is fully transparent, as export.mjs samples it.
          return state.visible === false ? { ...state, opacity: 0 } : state;
        });
        const layouts = states.map((state) => layoutText(state, fonts));
        const made = shapeLayers(stringLayer, unitIndex, plan.units[unitIndex], layouts, states,
          parentMatrices, parentOpacities, helpers, nextIndex, frameCount);
        for (const item of made) {
          item.ip = run.first;
          item.op = Math.min(run.last + 1, frameCount);
        }
        output.push(...made);
      }
    }
  }
  return output;
}

// The most text layers (one per unit of each number) the Counters of one text layer may add to a
// Lottie file with their In and Out effects. Effects by letter cut every number into letters, so
// a Counter that shows a new number on every frame could otherwise add tens of thousands of
// layers; past this it exports its numbers without the effects, and says so.
export const MAX_COUNTER_UNIT_LAYERS = 3000;

const IDENTITY = [1, 0, 0, 1, 0, 0];

// A short quote of a text for layer names and messages.
function quoted(text) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  return `“${flat.length > 24 ? `${flat.slice(0, 23)}…` : flat}”`;
}

// The runs of consecutive frames that draw the same string (textChangeDraw.js textDrawnPlansAt),
// in the order they first appear: [{ first, plans }], with one plan per frame from `first` on.
// A run that would start on the final frame boundary (`frameCount`) is never shown.
function countedRuns(layer, frames, frameCount, fonts) {
  const runs = [];
  let open = new Map();
  frames.forEach((time, index) => {
    const next = new Map();
    for (const plan of textDrawnPlansAt(layer, time, fonts)) {
      // A string is the same from frame to frame when its key, text and units are.
      let identity = `${plan.key}\n${plan.mode}\n${plan.text}`;
      while (next.has(identity)) identity += "\n";
      let run = open.get(identity);
      if (!run) {
        if (index >= frameCount) continue;
        run = { first: index, plans: [] };
        runs.push(run);
      }
      run.plans.push(plan);
      next.set(identity, run);
    }
    open = next;
  });
  return runs;
}

// The layer with its Counters' In and Out effects left out.
function withoutCounterEffects(layer) {
  return {
    ...layer,
    animations: mapAnimationTree(layer.animations, (animation) =>
      isCounter(animation) ? { ...animation, in: null, out: null } : animation),
  };
}

// The local bounds of a run's effects (blur, shadow), measured over the run's own frames only.
function runEffectBounds(layer, states, times, helpers, fonts) {
  if (!lottieEffects(states, helpers).length) return undefined;
  return compositionBounds([{ layer: { ...layer, animations: [] }, children: [] }], times, {
    sampleLayer: () => states, localMatrix: () => IDENTITY, multiplyMatrix: helpers.multiplyMatrix,
    fonts, ignoreEffects: new Set([layer.id]),
  });
}

// A layer's keyframes use its containing composition's time. Its `st` moves a
// precomposition's child clock, but does not move the layer's own keyframes.
function shiftRunKeyframes(value, first) {
  if (!value || typeof value !== "object") return;
  if (value.a === 1 && Array.isArray(value.k)) {
    for (const keyframe of value.k)
      if (keyframe && typeof keyframe.t === "number") keyframe.t += first;
  }
  for (const child of Object.values(value)) shiftRunKeyframes(child, first);
}

// A text layer with a Counter (counter.js). The numbers it counts through change from frame to
// frame, so each run of frames that draws the same string (a number, or the text before and
// between the operations) becomes its own set of text layers (one per unit), shown only on those
// frames: from its first frame (in point, `ip`) to just after its last one (out point, `op`).
// Each run stores its own samples and one closing sample for interpolation through
// its final visible frame. Its property keyframes use composition time; `st`
// shifts the clock of any nested assets to those samples. This keeps a Counter that shows a
// new number on every frame as small as its frames. Every frame is sampled as
// textChangeDraw.js draws it, In and Out effects included. Past MAX_COUNTER_UNIT_LAYERS the
// numbers are exported without the Counter's effects, with the warning
// "lottie-counter-effects-simplified".
function countedTextLayers(layer, frames, frameCount, nextIndex, parentMatrices, parentOpacities, helpers, fonts) {
  let source = layer;
  let runs = countedRuns(source, frames, frameCount, fonts);
  const unitLayers = runs.reduce((total, run) => total + run.plans[0].units.length, 0);
  const counters = enabledAnimations(layer.animations).filter(isCounter);
  if (unitLayers > MAX_COUNTER_UNIT_LAYERS && counters.some((counter) => counter.in || counter.out)) {
    source = withoutCounterEffects(layer);
    runs = countedRuns(source, frames, frameCount, fonts);
    helpers.warn?.({
      code: "lottie-counter-effects-simplified",
      message: `The Counter on text layer ${quoted(layer.name ?? layer.id)} shows too many numbers for its In and Out effects to fit in a Lottie file, so each number appears and disappears there without them.`,
    });
  }
  const output = [];
  for (const run of runs) {
    const first = run.first;
    const last = first + run.plans.length - 1;
    const plan = run.plans[0];
    const samplePlans = [...run.plans];
    // The next frame hides this run, but its boundary still defines where the
    // current string moves until then. Without it even a linear scale freezes
    // over the last frame (and over every frame of a fast Counter).
    if (last + 1 < frames.length) samplePlans.push(run.plans.at(-1));
    const end = first + samplePlans.length;
    const times = frames.slice(first, end);
    const matrices = parentMatrices.slice(first, end);
    const opacities = parentOpacities.slice(first, end);
    const stringLayer = { ...source, text: plan.text, name: `${layer.name ?? "Text"} ${quoted(plan.text)}` };
    const runHelpers = {
      ...helpers,
      applyEffects: helpers.applyEffects && ((content, effectLayer, states, effectMatrices, visibleStates, options = {}) =>
        helpers.applyEffects(content, effectLayer, states, effectMatrices, visibleStates, { ...options, bounds: runEffectBounds(effectLayer, states, times, helpers, fonts) })),
    };
    for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex += 1) {
      const states = samplePlans.map((framePlan, offset) => {
        const state = textStringUnitState(source, framePlan, unitIndex, times[offset], fonts);
        // A hidden layer (Hide, Play range) is fully transparent, as export.mjs samples it.
        return state.visible === false ? { ...state, opacity: 0 } : state;
      });
      const layouts = states.map((state) => layoutText(state, fonts));
      const made = shapeLayers(stringLayer, unitIndex, plan.units[unitIndex], layouts, states,
        matrices, opacities, runHelpers, nextIndex, times.length);
      for (const item of made) {
        shiftRunKeyframes(item, first);
        item.st = first;
        item.ip = first;
        item.op = Math.min(last + 1, frameCount);
      }
      output.push(...made);
    }
  }
  return output;
}

/** Export shaped text as portable vector outlines, retaining per-frame layout and unit animation. */
export function lottieTextLayers(
  layer,
  baseState,
  frames,
  frameCount,
  fps,
  nextIndex,
  parentMatrices,
  parentOpacities,
  helpers,
  fonts,
) {
  requireHelpers(helpers);
  if (!layer || layer.type !== "text") throw new TypeError("Lottie text export requires a text layer.");
  if (!Array.isArray(frames)) throw new TypeError("Lottie text export requires sampled frame times.");
  if (typeof nextIndex !== "function") throw new TypeError("Lottie text export requires an index allocator.");
  if (!frames.length) return [];
  void fps;
  if (hasCounters(layer))
    return countedTextLayers(layer, frames, frameCount, nextIndex, parentMatrices, parentOpacities, helpers, fonts);
  if (hasTextChanges(layer))
    return changedTextLayers(layer, frames, frameCount, nextIndex, parentMatrices, parentOpacities, helpers, fonts);
  const label = `Text layer “${layer.name ?? layer.id}”`;
  const plan = textAnimationPlan(layer, fonts);
  const mode = plan.mode;
  const sampled = helpers.sampleLayer(layer, frames);
  if (!Array.isArray(sampled) || sampled.length !== frames.length) {
    throw new Error(`${label} could not be sampled for every export frame.`);
  }
  const layoutStates = sampled.map((state) => ({
    ...(baseState ?? layer),
    ...state,
  }));
  // The units, and the count that staggers them, are those of the layer's own layout, as in the
  // editor (render.js) and the playback length (playback.js). Each unit draws its own characters
  // wherever a frame's layout puts them (unitGlyphs), so a Letter spacing, size or width change
  // that wraps the text onto more or fewer lines exports the way the editor draws it.
  const restUnits = plan.units;
  const count = restUnits.length;
  if (!count) return [];

  const output = [];
  const unitCount = Math.max(1, count);
  for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
    const opacity = plan.independent ? discreteOpacityProperty(layer, frames, textAnimationOptions(plan, unitIndex)) : null;
    const unitStates = plan.independent ? frames.map((time) => ({
      ...textAnimationUnitState(plan, unitIndex, time), ...(opacity ? { _lottieOpacity: opacity } : {}),
    })) : helpers.sampleLayer(
      layer,
      frames,
      mode === "layer" ? 0 : unitIndex,
      mode === "layer" ? 1 : unitCount,
      mode,
    );
    if (!Array.isArray(unitStates) || unitStates.length !== frames.length) {
      throw new Error(`${label} unit ${unitIndex + 1} could not be sampled for every export frame.`);
    }
    const completedStates = unitStates.map((state, index) => resizeTextLayer({
      ...(baseState ?? layer),
      ...layoutStates[index],
      ...state,
    }, fonts));
    const unitLayouts = completedStates.map((state) => layoutText(state, fonts));
    output.push(...shapeLayers(
      layer,
      unitIndex,
      restUnits[unitIndex],
      unitLayouts,
      completedStates,
      parentMatrices,
      parentOpacities,
      helpers,
      nextIndex,
      frameCount,
    ));
  }
  return output;
}
