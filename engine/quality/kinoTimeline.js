// Builds the quality checker's model (engine/quality/model.js) from a kino scene.
//
// The scene is first drawn out with its components (expandComponents), so every layer the
// video shows is an item. Then every layer is evaluated at each sample time, the way the
// renderer evaluates it: its box goes through every parent's transform, and its opacity is
// multiplied by every parent's. Text with per-letter or per-word animation is evaluated per
// unit (a few units, spread over the text), and is "fully shown" only when they all are.
import { evaluateLayer } from "../animation.js";
import { enabledAnimations } from "../animationEnabled.js";
import { effectsAt } from "../effects/animation.js";
import { PARTICLE_LOOKS } from "../effects/particles.js";
import { flattenAnimations } from "../animationTree.js";
import { loops } from "../behavior.js";
import { easingAt } from "../easing.js";
import { effectDefinition } from "../effects/catalog.js";
import { IDENTITY, layerMatrix, multiply, point } from "../geometry.js";
import { expandComponents } from "../linkedComponents.js";
import { isFillEnabled } from "../paints.js";
import { mediaFrameState, resolvePlayback } from "../playback.js";
import { BACKGROUND_OWNER_ID, backgroundLayer, isBackgroundEnabled } from "../sceneBackground.js";
import { textAnimationPlan, textAnimationUnitState } from "../textAnimation.js";
import { hasCounters, hasTextChanges } from "../textChange.js";
import { shownTextAt } from "../textChangeDraw.js";
import { layoutText, resizeTextLayer, textUnits } from "../textLayout.js";
import { totalUnitDelay, unitDelay } from "../textTiming.js";
import { hexRgba, isGradient, luminance, paintColors } from "./model.js";
import { fontFacts, linesOf, wrapWidths } from "./textFacts.js";
import { BLUR_EFFECTS, smearLength } from "../effects/motionBlurs.js";
import { EDGE_EFFECTS } from "../effects/edges.js";

const BLUR_KEYS = new Set(BLUR_EFFECTS.map((effect) => effect.key));
const DRAWN_ONLY_EFFECTS = new Set([...BLUR_EFFECTS, ...EDGE_EFFECTS].map((effect) => effect.key));
// Trim fields that move a stroke along its outline (a draw-on, a marching dash).
const TRIM_MOTION_KEYS = new Set(["strokeStart", "strokeEnd", "strokeOffset", "dashOffset"]);
// A box smear of length L spreads a picture as much as a Gaussian blur of L / sqrt(12) (the same
// standard deviation), so a directional, zoom or spin blur counts as that much blur.
const SMEAR_TO_BLUR = 1 / Math.sqrt(12);

export const DEFAULT_FPS = 30;
// Above this many layer samples (layers x times) the samples are taken at 15 a second instead.
// 1,000,000 keeps a 74 s trailer of 209 layers at the output's 30 fps (0.2 s warm, 0.6 s cold,
// 20 MB of samples), so the motion rules see one- and two-frame events; a ten-minute scene of
// 400 caption pages still drops to 15.
const MAX_EVALUATIONS = 1_000_000;
// Per-unit text is evaluated on at most this many units (first, last and some between).
const MAX_UNITS = 6;
// Evaluating a layer (animation.js evaluateLayer) is most of the cost of the model, and a long
// scene has many samples where a layer does not change: before, between and after its
// animations. Those samples reuse what was evaluated at an earlier sample with the same
// standing (stillKey). A layer is evaluated afresh while an animation runs, within this many
// seconds of one starting or ending, and while a text unit may still wait its turn.
const STILL_MARGIN = 0.002;

const easingCurves = new Map();
// Whether an easing leaves 0–1 (bounce, elastic, overshoot) and whether it is a straight line.
function curveOf(easing, intensity = 50) {
  const key = JSON.stringify([easing, intensity]);
  if (easingCurves.has(key)) return easingCurves.get(key);
  let overshoots = false;
  let straight = true;
  // A fade "wobbles" when its value, kept within 0–1, goes back the way it came (bounce, elastic).
  let wobbles = false;
  let highest = 0;
  try {
    for (let step = 1; step < 100; step += 1) {
      const x = step / 100;
      const y = easingAt(easing, x, intensity);
      if (y > 1.002 || y < -0.002) overshoots = true;
      if (Math.abs(y - x) > 0.02) straight = false;
      const kept = Math.max(0, Math.min(1, y));
      if (kept < highest - 0.01) wobbles = true;
      highest = Math.max(highest, kept);
    }
  } catch { straight = false; }
  const curve = { overshoots, linear: straight, wobbles };
  easingCurves.set(key, curve);
  return curve;
}

function animationKeys(animation) {
  const keys = new Set([...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})]);
  // An effect's parameters (a lens flare's x and y, a glow's color) are not the layer's own
  // properties, so they are named effect.<effect>.<parameter>: no rule takes them for a move or a fade.
  if (animation.kind === "effect") return [...keys].map((key) => `effect.${animation.effect}.${key}`);
  if (animation.motionPath) { keys.add("x"); keys.add("y"); }
  if (animation.kind === "hide" || animation.kind === "show") keys.add("visible");
  return [...keys];
}

/** A ranged effect whose values stay the same throughout (a steady glow) changes nothing over its time. */
function steadyEffect(animation) {
  if (animation.kind !== "effect") return false;
  try { if (effectDefinition(animation.effect).kind !== "ranged") return false; } catch { return false; }
  return Object.entries(animation.from ?? {}).every(([key, value]) => JSON.stringify(value) === JSON.stringify(animation.to?.[key]));
}

// How long a text animation takes to reach its last unit (the stagger).
function unitSpread(layer, animation, fonts) {
  if (layer.type !== "text" || !(animation.stagger > 0 || animation.delays?.length) || !animation.unit || animation.unit === "layer") return 0;
  let count = 1;
  try { count = textUnits(layoutText(resizeTextLayer(layer, fonts), fonts), animation.unit).length; } catch { count = 1; }
  // Each unit's own delay (caption words timed to speech): the spread is the longest.
  if (animation.delays?.length) return totalUnitDelay(animation, count);
  if (count < 2) return 0;
  try { return Math.max(0, unitDelay(animation, count - 1, count), unitDelay(animation, 0, count)); } catch { return animation.stagger * (count - 1); }
}

// The source layer (and scene) an expanded layer came from, so fixes edit the right one.
function sourceOf(layer, byId, sceneId) {
  if (layer.sceneBackground) return { sceneBackground: true, sceneId, layerId: BACKGROUND_OWNER_ID };
  if (!layer.componentPath && !layer.componentOwnerId) return { layerId: layer.id, sceneId };
  let parent = byId.get(layer.parentId);
  let sourceSceneId = layer.componentSourceSceneId ?? null;
  while (!sourceSceneId && parent) {
    sourceSceneId = parent.componentSourceSceneId ?? null;
    parent = byId.get(parent.parentId);
  }
  if (layer.componentBackground) return { layerId: layer.componentOwnerId, sceneId, componentBackground: true, instanceId: layer.componentOwnerId };
  if (!layer.componentPath) return { layerId: layer.componentOwnerId, sceneId, instanceId: layer.componentOwnerId };
  const sourceLayerId = String(layer.componentPath).split("/").at(-1);
  return { layerId: sourceLayerId, sceneId: sourceSceneId ?? sceneId, instanceId: layer.componentOwnerId, componentPath: layer.componentPath };
}

// Indexes of the units to evaluate: all of them up to MAX_UNITS, else the first, the last and
// evenly spaced ones between.
function sampledUnits(count) {
  if (count <= MAX_UNITS) return [...Array(count).keys()];
  const picks = new Set([0, count - 1]);
  for (let step = 1; step < MAX_UNITS - 1; step += 1) picks.add(Math.round((step * (count - 1)) / (MAX_UNITS - 1)));
  return [...picks].sort((a, b) => a - b);
}

// The box around the glyphs' own outlines (not the font's line height), so two lines set
// close together do not count as overlapping when their letters do not touch. A line whose
// glyphs have no outlines (all missing) falls back to the font's ascent and descent.
// In the layer's own space, as {x0, y0, x1, y1}, or null when it draws no line. look zoom crops
// to it too, since letters can be drawn past the layer's box.
export function inkBox(state, fonts) {
  const layout = layoutText(state, fonts);
  if (!layout.lines.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (left, top, right, bottom) => {
    x0 = Math.min(x0, left); y0 = Math.min(y0, top); x1 = Math.max(x1, right); y1 = Math.max(y1, bottom);
  };
  for (const line of layout.lines) {
    if (!line.width) continue;
    let drawn = false;
    for (const glyph of line.glyphs ?? []) {
      const bounds = glyph.bounds;
      if (glyph.hidden || !bounds || (!bounds.width && !bounds.height)) continue;
      const left = line.x + glyph.x + bounds.x;
      const top = line.y + (glyph.y ?? 0) + bounds.y;
      add(left, top, left + bounds.width, top + bounds.height);
      drawn = true;
    }
    if (!drawn) add(line.x, line.y - (line.ascent ?? state.fontSize * 0.8), line.x + line.width, line.y + (line.descent ?? state.fontSize * 0.2));
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

// Writes one sample of an item's model from what it drew (see kinoTimeline).
function writeSample(samples, index, result) {
  const { box } = result;
  samples.x0[index] = box.x0; samples.y0[index] = box.y0; samples.x1[index] = box.x1; samples.y1[index] = box.y1;
  samples.opacity[index] = result.opacity;
  samples.scale[index] = result.scale;
  samples.turn[index] = Math.atan2(result.matrix[1], result.matrix[0]);
  samples.blur[index] = result.blur;
  samples.luma[index] = result.luma;
  if (samples.colors) samples.colors[index] = result.colors;
  if (samples.textIndex) samples.textIndex[index] = result.textIndex;
  if (samples.lineSet) samples.lineSet[index] = result.lineSet;
}

// The stretches of a layer's own clock in which it may change: one for each animation it
// evaluates, from its start to its end plus the longest unit delay (stagger times the characters
// is more than any unit waits). Null when an animation has no finite time (never reused).
// A Change text has no duration of its own and a Counter's last step plays its effects after its
// duration: their Out and In effects (each with its own stagger) are counted on top, so the
// samples while the old string leaves and the new one arrives are evaluated, not copied.
// A looping animation (behavior.js) keeps changing after its first pass: never reused.
function changeWindows(layer) {
  const animations = enabledAnimations(layer.animations);
  if (flattenAnimations(animations).some(loops)) return null;
  const strings = layer.type === "text" ? [layer.text, ...animations.map((animation) => animation?.text)] : [];
  const characters = layer.type === "text" ? Math.max(...strings.map((text) => String(text ?? "").length)) + 1 : 0;
  const effectWaits = (effect) => (effect ? Math.max(0, finite(effect.duration)) + Math.max(0, finite(effect.stagger)) * characters : 0);
  const windows = [];
  for (const animation of animations) {
    const start = animation.start ?? 0;
    const length = animation.duration ?? 0;
    if (!Number.isFinite(start) || !Number.isFinite(length)) return null;
    const effects = animation.kind === "change-text" || animation.kind === "counter" ? effectWaits(animation.out) + effectWaits(animation.in) : 0;
    // Units with their own delays (textTiming.js) change until the last one has.
    const spread = animation.delays?.length ? Math.max(0, ...animation.delays.map((delay) => finite(delay))) : Math.max(0, finite(animation.stagger)) * characters;
    const waits = spread + effects;
    windows.push({ from: start - STILL_MARGIN, to: start + Math.max(0, length) + waits + STILL_MARGIN, start });
  }
  return windows;
}

// A layer's standing at scene time `time`: whether its component window and Play range show it,
// and which of its animations have started. Null while it may be changing (inside a window).
function stillKey(layer, windows, time) {
  if (!windows) return null;
  const clock = resolvePlayback(layer, time);
  let key = `${clock.visible ? 1 : 0}${mediaFrameState(layer, clock.time).visible ? 1 : 0}`;
  for (const window of windows) {
    if (clock.time >= window.from && clock.time <= window.to) return null;
    key += clock.time > window.start ? "1" : "0";
  }
  return key;
}

// The blur a layer's active directional, zoom and spin blurs give it, in scene pixels.
function smearBlur(layer, time, state, scale) {
  try { return smearLength(effectsAt(layer, time), { width: finite(state.width), height: finite(state.height) }) * scale * SMEAR_TO_BLUR; }
  catch { return 0; }
}

function worldBox(matrix, box) {
  const corners = [point(matrix, box.x0, box.y0), point(matrix, box.x1, box.y0), point(matrix, box.x0, box.y1), point(matrix, box.x1, box.y1)];
  return {
    x0: Math.min(...corners.map((c) => c.x)), y0: Math.min(...corners.map((c) => c.y)),
    x1: Math.max(...corners.map((c) => c.x)), y1: Math.max(...corners.map((c) => c.y)),
  };
}

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value, 1)));
// The paint's alpha (0 to 1): a gradient's most opaque stop, or with `least` its clearest one (a
// vignette or a scrim that is clear somewhere hides nothing whole, so it is not opaque).
const fillAlpha = (paint, least = false) => {
  if (typeof paint === "string") return (hexRgba(paint)?.[3] ?? 0) / 255;
  if (isGradient(paint)) return Math[least ? "min" : "max"](...paint.stops.map((stop) => (hexRgba(stop.color)?.[3] ?? 0) / 255));
  return 0;
};

/**
 * The model of one scene of a kino document. `fps` is samples a second (default 30, or 15
 * for very large scenes). `reuse: false` evaluates every layer at every sample (tests compare).
 */
export function kinoTimeline(document, sceneId, { fonts, fps, reuse = true } = {}) {
  const source = document.scenes.find((scene) => scene.id === sceneId);
  if (!source) throw new Error(`Scene ${sceneId} was not found.`);
  const scene = expandComponents(document, sceneId, { fonts });
  const layers = scene.layers.filter((layer) => layer.type !== "audio");
  const duration = Math.max(0.05, finite(scene.duration, 1));
  let rate = fps ?? DEFAULT_FPS;
  if (!fps && layers.length * (Math.floor(duration * rate) + 1) > MAX_EVALUATIONS) rate = 15;
  const count = Math.floor(duration * rate + 1e-6) + 1;
  const times = Array.from({ length: count }, (_, index) => Math.min(duration, index / rate));
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  // Animations a move made (engine/blocks/move.js): the timing warnings judge a move as one designed
  // piece, not each of its parts on its own. Its layers carry `move`; on your layers its
  // animations are named "<move id>.<role>-<name>".
  const moveIds = (source.moves ?? []).map((entry) => entry.id);
  const madeBy = (layer, animation) => layer.move?.instance ?? moveIds.find((id) => String(animation.id ?? "").startsWith(`${id}.`)) ?? null;
  // A carry hands one shot's motion to the next on purpose (a fast start where the layer was
  // already moving), so speed_jump leaves the join into it alone. Found by the animation's id,
  // not madeBy: on a layer another move made, madeBy names that move.
  const carryIds = (source.moves ?? []).filter((entry) => entry.name === "carry").map((entry) => entry.id);
  const isCarry = (animation) => carryIds.some((id) => String(animation.id ?? "").startsWith(`${id}.`));

  // Paint order: parents first, then children, in array order (later draws on top).
  const children = new Map();
  for (const layer of layers) {
    const parent = byId.has(layer.parentId) ? layer.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(layer);
  }
  // The scene's own background comes first, as a full-frame item with its Color animations.
  const order = isBackgroundEnabled(scene) ? [{ ...backgroundLayer(scene), role: "background", sceneBackground: true }] : [];
  const visit = (parentId, depth) => {
    if (depth > 64) return;
    for (const layer of children.get(parentId) ?? []) { order.push(layer); visit(layer.id, depth + 1); }
  };
  visit(null, 0);

  // A mask hides what is outside it: in a mask group, the layers above the bottom-most mask;
  // otherwise the next layer above it.
  const maskOf = new Map();
  const groupMaskOf = new Map();
  for (const [parentId, siblings] of children) {
    const parent = byId.get(parentId);
    const groupMask = parent?.isMaskGroup ? siblings.findIndex((layer) => layer.isMask) : -1;
    if (groupMask >= 0) groupMaskOf.set(parentId, siblings[groupMask].id);
    siblings.forEach((layer, index) => {
      if (groupMask >= 0 && index > groupMask) maskOf.set(layer.id, siblings[groupMask].id);
      else if (index > 0 && siblings[index - 1].isMask && groupMask < 0) maskOf.set(layer.id, siblings[index - 1].id);
    });
  }

  const items = order.map((layer, z) => {
    const isTextLayer = layer.type === "text";
    const changes = isTextLayer && hasTextChanges(layer);
    let plan = null;
    if (isTextLayer && !changes) {
      try { plan = textAnimationPlan(layer, fonts); } catch { plan = null; }
      if (plan && !plan.separate) plan = null;
    }
    const clipIds = [];
    let parent = byId.get(layer.parentId);
    while (parent && clipIds.length < 64) {
      if (parent.clipContent && parent.type === "group") clipIds.push(parent.id);
      parent = byId.get(parent.parentId);
    }
    if (maskOf.has(layer.id)) clipIds.push(maskOf.get(layer.id));
    const fill = isFillEnabled(layer) ? layer.fill : null;
    const media = layer.type === "image" || layer.type === "video";
    return {
      id: layer.id, name: layer.name ?? layer.id, kind: layer.type === "component" ? "group" : layer.type,
      role: layer.role ?? (layer.componentBackground ? "background" : null),
      perpetual: layer.perpetual === true, sceneCamera: layer.sceneCamera === true, loops: flattenAnimations(layer.animations, { enabledOnly: true }).some(loops),
      allowOverlap: layer.allowOverlap === true, move: layer.move?.instance ?? null,
      // A copy a move lays over your layer to color it (accent-hit, light-sweep): drawn as part of that layer.
      overlay: layer.move?.part === "overlay",
      z, parentId: byId.has(layer.parentId) ? layer.parentId : null, clipIds, maskId: groupMaskOf.get(layer.id) ?? null, isMask: layer.isMask === true,
      text: isTextLayer ? String(layer.text ?? "") : null, texts: null,
      counter: isTextLayer && hasCounters(layer),
      fontSize: isTextLayer ? finite(layer.fontSize, 48) : null, fontWeight: isTextLayer ? finite(layer.fontWeight, 400) : null,
      fontFamily: isTextLayer ? layer.fontFamily : null, textAlign: isTextLayer ? layer.textAlign : null,
      // Letter spacing (percent of the font size) and case: page_chrome finds tracked caps labels.
      letterSpacing: isTextLayer ? finite(layer.letterSpacing) : null, textCase: isTextLayer ? layer.textCase ?? "normal" : null,
      sceneBackground: layer.sceneBackground === true,
      fill, painted: media || (fill != null && fillAlpha(fill) > 0.05) || (layer.strokeWidth > 0 && layer.type !== "text"),
      opaque: media || (fill != null && fillAlpha(fill, true) >= 0.5),
      // An outline's paint and width (accent_budget counts an accent stroke).
      stroke: layer.strokeWidth > 0 && layer.type !== "text" ? { paint: layer.stroke ?? null, width: finite(layer.strokeWidth) } : null,
      shadow: layer.shadow ? { blur: finite(layer.shadow.blur), x: finite(layer.shadow.x), y: finite(layer.shadow.y), color: layer.shadow.color ?? null } : null,
      blur: finite(layer.blur), radius: finite(layer.radius),
      restWidth: finite(layer.width), restHeight: finite(layer.height), restX: finite(layer.x), textResize: isTextLayer ? layer.textResize ?? "fixed" : null,
      src: media ? layer.src ?? null : null,
      // The face the renderer really draws the text with (font_fallback), and its lines (text_wrap).
      font: isTextLayer ? fontFacts(layer, fonts) : null, lineSets: isTextLayer ? [] : null,
      source: sourceOf(layer, byId, sceneId),
      samples: {
        x0: new Float32Array(count), y0: new Float32Array(count), x1: new Float32Array(count), y1: new Float32Array(count),
        opacity: new Float32Array(count), scale: new Float32Array(count), blur: new Float32Array(count),
        turn: new Float32Array(count), luma: new Float32Array(count).fill(Number.NaN),
        colors: isTextLayer ? new Array(count) : null,
        textIndex: changes ? new Int16Array(count) : null,
        lineSet: isTextLayer ? new Int16Array(count) : null,
      },
      _layer: layer, _plan: plan, _units: plan ? sampledUnits(plan.units.length) : null, _changes: changes,
      _windows: reuse ? changeWindows(layer) : null, _still: new Map(),
      _smear: enabledAnimations(layer.animations).some((animation) => animation?.kind === "effect" && BLUR_KEYS.has(animation.effect)),
    };
  });
  const itemOf = new Map(items.map((item) => [item.id, item]));

  // What an item gives the layers inside it at one sample (its place, opacity and blur), with
  // what it drew there. `stable` when the item and every group around it stand still: an item
  // whose standing and parent's result are the same as at an earlier sample copies that
  // sample's result instead of working it out again (a caption page waits hidden for minutes).
  const TOP = { matrix: IDENTITY, alpha: 1, blur: 0, stable: true };
  const NOT_DRAWN = { matrix: IDENTITY, alpha: 0, blur: 0, stable: true };
  for (let index = 0; index < count; index += 1) {
    const time = times[index];
    const drawn = new Map();
    for (const item of items) {
      const layer = item._layer;
      const parent = item.parentId ? (drawn.get(item.parentId) ?? NOT_DRAWN) : TOP;
      const parentWorld = parent.matrix;
      const parentAlpha = parent.alpha;
      const parentBlur = parent.blur;
      // What this layer was at an earlier sample with the same standing, when it is still.
      const key = stillKey(layer, item._windows, time);
      const still = key === null ? null : item._still.get(key);
      const copied = still && parent.stable ? still.results?.get(parent) : undefined;
      if (copied) {
        writeSample(item.samples, index, copied);
        drawn.set(item.id, copied);
        continue;
      }
      const evaluated = still ?? { units: new Map() };
      if (key !== null && !still) item._still.set(key, evaluated);
      let state;
      if (still) state = still.state;
      else {
        try { state = evaluateLayer(layer, time, { unitIndex: 0, unitCount: 1, fonts }); }
        catch { state = { ...layer, visible: false }; }
        evaluated.state = state;
      }
      if (item._changes) {
        if (!still) evaluated.text = shownTextAt(layer, time, fonts);
        const text = evaluated.text;
        item.texts ??= [];
        let textIndex = item.texts.indexOf(text);
        if (textIndex < 0) { item.texts.push(text); textIndex = item.texts.length - 1; }
        item.samples.textIndex[index] = textIndex;
        state = { ...state, text };
      }
      state = resizeTextLayer(state, fonts);
      // Where its lines break now: an index into item.lineSets (one entry per different set).
      let lineSet = 0;
      if (item.lineSets) {
        if (still && evaluated.lineSet !== undefined) lineSet = evaluated.lineSet;
        else {
          let lines = [];
          try { lines = linesOf(state, fonts); } catch { lines = []; }
          const key = JSON.stringify(lines);
          lineSet = item.lineSets.findIndex((entry) => entry.key === key);
          if (lineSet < 0) { item.lineSets.push({ key, lines }); lineSet = item.lineSets.length - 1; }
          evaluated.lineSet = lineSet;
        }
      }
      const matrix = multiply(parentWorld, layerMatrix(state));
      const shown = layer.visible !== false && state.visible !== false && parentAlpha > 0;
      const reveal = state.reveal && typeof state.reveal.progress === "number" ? clamp01(state.reveal.progress) : 1;
      let opacity = shown ? parentAlpha * clamp01(state.opacity) * (reveal >= 0.999 ? 1 : reveal) : 0;
      let box = null;
      let scale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));
      // The paints it is drawn with now, after its fill animations (text: one per sampled unit).
      let fills = [isFillEnabled(state) ? state.fill : null];
      if (item.kind === "text") {
        if (item._plan && shown) {
          // Each sampled unit in its own state: the text is as shown as its least shown unit.
          let least = 1;
          let leastScale = Infinity;
          const unitFills = [];
          for (const unitIndex of item._units) {
            if (!evaluated.units.has(unitIndex)) {
              try { evaluated.units.set(unitIndex, textAnimationUnitState(item._plan, unitIndex, time)); }
              catch { evaluated.units.set(unitIndex, null); }
            }
            const unitState = evaluated.units.get(unitIndex);
            if (!unitState) continue;
            unitFills.push(isFillEnabled(unitState) ? unitState.fill : null);
            const unitMatrix = multiply(parentWorld, layerMatrix(unitState));
            const unitReveal = unitState.reveal && typeof unitState.reveal.progress === "number" ? clamp01(unitState.reveal.progress) : 1;
            least = Math.min(least, unitState.visible === false ? 0 : clamp01(unitState.opacity) * (unitReveal >= 0.999 ? 1 : unitReveal));
            leastScale = Math.min(leastScale, Math.sqrt(Math.abs(unitMatrix[0] * unitMatrix[3] - unitMatrix[1] * unitMatrix[2])));
            const ink = inkBox(unitState, fonts);
            if (ink) {
              const unitBox = worldBox(unitMatrix, ink);
              box = box ? { x0: Math.min(box.x0, unitBox.x0), y0: Math.min(box.y0, unitBox.y0), x1: Math.max(box.x1, unitBox.x1), y1: Math.max(box.y1, unitBox.y1) } : unitBox;
            }
          }
          opacity = parentAlpha * least;
          if (Number.isFinite(leastScale)) scale = leastScale;
          if (unitFills.length) fills = unitFills;
        }
        if (!box) {
          const ink = inkBox(state, fonts);
          box = ink ? worldBox(matrix, ink) : worldBox(matrix, { x0: 0, y0: 0, x1: finite(state.width), y1: finite(state.height) });
        }
      } else box = worldBox(matrix, { x0: 0, y0: 0, x1: finite(state.width), y1: finite(state.height) });
      // How bright a solid fill is (for flashing); NaN for gradients, media and no fill.
      const rgba = item.kind !== "image" && item.kind !== "video" && isFillEnabled(state) ? hexRgba(state.fill) : null;
      const result = {
        matrix,
        alpha: shown ? parentAlpha * clamp01(state.opacity) * (reveal >= 0.999 ? 1 : reveal) : 0,
        blur: parentBlur + Math.max(0, finite(state.blur)) + (item._smear && shown ? smearBlur(layer, time, state, scale) : 0),
        box, opacity: item.isMask ? 0 : opacity, scale,
        colors: item.samples.colors ? [...new Set(fills.flatMap(paintColors))] : null,
        luma: rgba ? luminance(rgba) : Number.NaN,
        textIndex: item.samples.textIndex ? item.samples.textIndex[index] : 0,
        lineSet,
        stable: key !== null && parent.stable,
      };
      if (result.stable) (evaluated.results ??= new Map()).set(parent, result);
      writeSample(item.samples, index, result);
      drawn.set(item.id, result);
    }
  }

  const tweens = [];
  for (const item of items) {
    const layer = item._layer;
    const flat = flattenAnimations(layer.animations, { enabledOnly: true });
    // A component copy's animations have new IDs in the same order as the source layer's.
    const sourceLayer = item.source.componentPath
      ? document.scenes.find((entry) => entry.id === item.source.sceneId)?.layers.find((entry) => entry.id === item.source.layerId) : null;
    const sourceFlat = sourceLayer ? flattenAnimations(sourceLayer.animations, { enabledOnly: true }) : null;
    flat.forEach((animation, position) => {
      if (!animation || animation.kind === "composed") return;
      const keys = animationKeys(animation);
      // A Volume animation (a fade or a duck) changes the sound, not what is seen, and a Speed
      // animation changes how fast a clip's file plays (engine/mediaTime.js), not how the layer moves:
      // neither is a motion for the motion rules (a linear speed ramp is fine). A blur or edge
      // effect (engine/effects/motionBlurs.js, edges.js) changes how the layer is drawn, not where it
      // is: the half of a whip's blur that falls back to 0 is not a 0.2 s move.
      // A Lowpass animation (a muffle opening up) is sound too.
      if (keys.every((key) => key === "volume" || key === "speed" || key === "lowpass")) return;
      if (animation.kind === "effect" && DRAWN_ONLY_EFFECTS.has(animation.effect)) return;
      // Nor is an effect that holds the same values all through, such as a steady glow.
      if (steadyEffect(animation)) return;
      const start = finite(animation.start);
      const spread = unitSpread(layer, animation, fonts);
      const length = Math.max(0, finite(animation.duration));
      const easing = animation.easing ?? "smooth";
      const intensity = Number.isInteger(animation.intensity) ? animation.intensity : 50;
      const curve = length > 0 ? curveOf(easing, intensity) : { overshoots: false, linear: false, wobbles: false };
      tweens.push({
        id: animation.id, itemId: item.id, name: animation.name ?? animation.id, keys, start, end: start + length + spread, duration: length,
        fromKeys: Object.keys(animation.from ?? {}), toKeys: Object.keys(animation.to ?? {}),
        kind: ["in", "out"].includes(animation.kind) ? animation.kind : animation.preset?.mode === "in" || animation.preset?.mode === "out" ? animation.preset.mode : animation.kind ?? "custom",
        easing, intensity, overshoots: curve.overshoots, linear: curve.linear, wobbles: curve.wobbles,
        unit: animation.unit ?? "layer", spread, stagger: finite(animation.stagger), preset: animation.preset?.id ?? null,
        discrete: animation.discrete?.type ?? null, counter: animation.kind === "counter",
        move: madeBy(layer, animation), handoff: isCarry(animation),
        source: { animationId: sourceFlat?.[position]?.id ?? (item.source.componentPath ? null : animation.id), layerId: item.source.layerId, sceneId: item.source.sceneId },
      });
    });
  }

  // A particle generator (engine/effects/particles.js) moves by itself while its clock runs and it
  // draws something, so a title with snow falling around it is not standing still. Its particles
  // may also twinkle: flickerHz is the fastest rate they do and flicker how strongly (the
  // generator's flicker times its opacity), which the flashing rule reads.
  for (const item of items) {
    const layer = item._layer;
    if (!enabledAnimations(layer.animations).some((animation) => animation.kind === "effect" && PARTICLE_LOOKS[animation.effect])) continue;
    item.samples.moving = new Uint8Array(count);
    item.samples.flickerHz = new Float32Array(count);
    item.samples.flicker = new Float32Array(count);
    let previous = null;
    for (let index = 0; index < count; index += 1) {
      let clock = null;
      try {
        const drawn = effectsAt(layer, times[index]).filter((frame) => PARTICLE_LOOKS[frame.effect.key] && frame.parameters.opacity > 0);
        clock = drawn.map((frame) => frame.time).join(" ") || null;
        for (const frame of drawn) {
          const hz = frame.parameters.flicker > 0 ? PARTICLE_LOOKS[frame.effect.key].flickerHz[1] : 0;
          const strength = frame.parameters.flicker * frame.parameters.opacity;
          if (hz > item.samples.flickerHz[index] || (hz && hz === item.samples.flickerHz[index] && strength > item.samples.flicker[index])) {
            item.samples.flickerHz[index] = hz;
            item.samples.flicker[index] = strength;
          }
        }
      } catch { clock = null; }
      if (clock !== null && previous !== null && clock !== previous && item.samples.opacity[index] >= 0.05) item.samples.moving[index] = 1;
      previous = clock;
    }
  }

  // A stroke drawing on, or a dash marching along (engine/strokeTrim.js), moves on screen while its
  // box stays put, so a diagram whose lines draw themselves is not standing still.
  for (const item of items) {
    if (!(item._layer.strokeWidth > 0)) continue;
    const trims = tweens.filter((tween) => tween.itemId === item.id && tween.keys.some((key) => TRIM_MOTION_KEYS.has(key)));
    if (!trims.length) continue;
    item.samples.moving ??= new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      if (item.samples.opacity[index] >= 0.05 && trims.some((tween) => times[index] > tween.start && times[index] < tween.end)) item.samples.moving[index] = 1;
    }
  }

  // Text revealed letter by letter or word by word (type-on, a write-on) changes on screen while
  // its box and its opacity as a whole stay put, so a prompt being typed is not standing still.
  for (const item of items) {
    if (item._layer.type !== "text") continue;
    // Its sampled opacity is the last letter's, so it reads the whole text's opacity only where
    // every letter is in (an in reveal's end, an out reveal's start): a text unseen there is skipped.
    const near = (time) => item.samples.opacity[Math.max(0, Math.min(count - 1, Math.round(time * rate)))];
    const reveals = tweens.filter((tween) => tween.itemId === item.id && tween.spread > 0 && tween.unit !== "layer" && tween.keys.includes("opacity")
      && Math.max(near(tween.start), near(tween.end), near(tween.end + 1 / rate)) >= 0.05);
    if (!reveals.length) continue;
    item.samples.moving ??= new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      if (reveals.some((tween) => times[index] > tween.start && times[index] < tween.end)) item.samples.moving[index] = 1;
    }
  }

  // Every effect animation (the blurs and edges included, which are not tweens) and every Speed
  // animation of a clip, for the technique finder (techniques.js): a zoom blur, particles or a
  // speed ramp is a technique even where it is not a motion.
  const effects = [];
  const retimes = [];
  for (const item of items) {
    for (const animation of flattenAnimations(item._layer.animations, { enabledOnly: true })) {
      if (!animation || animation.kind === "composed") continue;
      const start = finite(animation.start);
      const end = start + Math.max(0, finite(animation.duration));
      if (animation.kind === "effect" && typeof animation.effect === "string") effects.push({ itemId: item.id, animationId: animation.id ?? null, name: animation.name ?? null, effect: animation.effect, start, end, to: animation.to ?? {} });
      if (Number.isFinite(animation.to?.speed)) retimes.push({ itemId: item.id, start, end, from: Number.isFinite(animation.from?.speed) ? animation.from.speed : null, to: animation.to.speed });
    }
  }

  // A text that the layout wraps gets the widths that would change its breaks (text_wrap's fix).
  for (const item of items) {
    if (!item.lineSets) continue;
    item.lineSets = item.lineSets.map((entry) => entry.lines);
    if (!item.lineSets.some((lines) => lines.some((line) => line.soft))) continue;
    try { item.wrapWidths = wrapWidths(item._layer, fonts); } catch { item.wrapWidths = null; }
  }

  for (const item of items) { delete item._layer; delete item._plan; delete item._units; delete item._changes; delete item._windows; delete item._still; delete item._smear; }
  return {
    width: finite(scene.width, 1920), height: finite(scene.height, 1080), duration, fps: rate, times,
    sceneId, sceneName: source.name ?? sceneId,
    videoType: document.videoType ?? null, rhythm: document.rhythm ?? null,
    background: scene.backgroundEnabled === false ? null : scene.background ?? null,
    audio: scene.layers.some((layer) => layer.type === "audio" || (layer.type === "video" && finite(layer.volume, 1) > 0)),
    items, tweens, effects, retimes, assertions: Array.isArray(source.assertions) ? source.assertions : [],
    // Planned stills (scene.rests): held_static and static_scene let them hold.
    rests: Array.isArray(source.rests) ? source.rests : [],
    // The set pieces moves built here (scene.moves): their techniques, from start to end, and
    // their settings (busy_edit reads a stream's color as part of its look).
    moves: (source.moves ?? []).filter((entry) => Array.isArray(entry.tags)).map((entry) => ({ id: entry.id, name: entry.name, tags: entry.tags, settings: entry.settings ?? {}, start: finite(entry.start, 0), end: finite(entry.end, duration) })),
    itemOf: (id) => itemOf.get(id),
  };
}
