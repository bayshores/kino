import { interpolatePath } from "./vectorPath.js";
import { createEffectAnimation, isEffectAnimation } from "./effects/animation.js";
import { effectiveBoxStyle, CORNER_LAYER_TYPES, STROKE_LAYER_TYPES } from "./boxStyles.js";
import { readBackdropStyle } from "./backdropStyles.js";
import { mediaFrameState, resolvePlayback } from "./playback.js";
import { MAX_VOLUME } from "./mediaTime.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { createVisibilityOperation, isVisibilityOperation, visibleByOperations } from "./visibilityOps.js";
import { enabledAnimations } from "./animationEnabled.js";
import { contrastingPaint, interpolatePaint, isGradientPaint, isSolidPaint } from "./paintInterpolation.js";
import { FILL_LAYER_TYPES } from "./paints.js";
import { shadowPresetValues } from "./shadowInterpolation.js";
import { interpolateShadowChannels } from "./shadowChannels.js";
import { DEFAULT_RESIZE_ANCHOR, isResizeAnchor, resizableSides, resizeAnchorShift, resizePresetValues } from "./resizeAnchor.js";
import { layoutText, resizeTextLayer } from "./textLayout.js";
import { textUnitGroup } from "./textUnitGeometry.js";
import { layerMatrix, pivotOf } from "./geometry.js";
import { LETTER_SPACING_LIMIT } from "./letterSpacing.js";
import { lineHeightPresetTo } from "./lineHeight.js";
import { interpolateAxes } from "./fontAxes.js";
import { createTextChange } from "./textChange.js";
import { createCounter } from "./counter.js";
import { isMoveAnimation, motionEndpoints, motionPathAt } from "./motionPath.js";
import { createCatalogAnimation, discreteProgress, presetValues } from "./presetCatalog.js";
import { interpolateReveal, normalizeReveal } from "./reveal.js";
import { scatteredAnimation, textRangeProgress, unitDelay } from "./textTiming.js";
import { usesCurrentInitialValue } from "./animationInitialValue.js";
import { flattenAnimations } from "./animationTree.js";
import { behaviorTime, wiggleOffset } from "./behavior.js";

import { easingAt } from "./easing.js";
import { LOWPASS_MIN, LOWPASS_OPEN } from "./lowpass.js";
export { EASINGS, easingAt } from "./easing.js";
import { DEFAULT_PERSPECTIVE } from "./tilt.js";
import { TRIM_LAYER_TYPES } from "./strokeTrim.js";
import { REPEAT_LAYER_TYPES } from "./repeater.js";
import { applyPin } from "./pin.js";

const PRESET_ENTRIES = [
  ["fade-in", "Fade In", "in"],
  ["fade-out", "Fade Out", "out"],
  ["slide-up", "Slide Up", "in"],
  ["slide-down", "Slide Down", "in"],
  ["slide-left", "Slide Left", "in"],
  ["slide-right", "Slide Right", "in"],
  ["grow-in", "Grow In", "in"],
  ["shrink-out", "Shrink Out", "out"],
  ["blur-in", "Blur In", "in"],
  ["blur-out", "Blur Out", "out"],
  ["rotate-in", "Rotate In", "in"],
  ["move", "Move", "custom"],
  ["scale", "Scale", "custom"],
  // Resize animates width and height around an anchor point (see resizeAnchor.js).
  ["resize", "Resize", "custom"],
  ["rotate", "Rotate", "custom"],
  // Tilt turns the layer in 3D: rotateX, rotateY (degrees) and perspective (px); see tilt.js.
  ["tilt", "Tilt", "custom"],
  ["opacity", "Opacity", "custom"],
  ["blur", "Blur", "custom"],
  ["background-blur", "Background Blur", "custom"],
  ["glass", "Glass", "custom"],
  // Shadow animates the drop shadow: color with alpha, x, y and blur (see shadowInterpolation.js).
  ["shadow", "Shadow", "custom"],
  ["arc", "Arc", "custom"],
  ["corners", "Corners", "custom"],
  ["star-shape", "Star", "custom"],
  // Color animates the Fill paint (solid, linear or radial; see paintInterpolation.js).
  ["color", "Color", "custom"],
  ["stroke", "Stroke", "custom"],
  // Trim draws a shape's stroke on along its outline: strokeEnd 0 to 1 (strokeTrim.js).
  ["trim", "Trim paths", "custom"],
  // Repeater grows a layer's copies from 1 to its own count, or to 8 turned 45 degrees each (repeater.js).
  ["repeat", "Repeater", "custom"],
  // Letter spacing animates a text layer's letter spacing, in percent of the font size
  // (letterSpacing.js). Its From ("Initial value") is optional.
  ["letter-spacing", "Letter spacing", "custom"],
  // Line height animates a text layer's line height, a multiple of the font size
  // (lineHeight.js). Its From ("Initial value") is optional, as for Letter spacing.
  ["line-height", "Line height", "custom"],
  // Change text swaps a text layer's string, with optional Out and In effects (see textChange.js).
  // A custom preset whose operation is a Change text (textChange.js), not a From/To animation.
  ["change-text", "Change text", "custom"],
  // Counter counts the number in a text layer's text from one value to another (see counter.js).
  ["counter", "Counter", "custom"],
  // Speed changes how fast a video, audio or GIF plays its file (mediaTime.js).
  ["speed", "Speed", "custom"],
  // Instant operations: a point in time with no duration or easing (see visibilityOps.js).
  ["hide", "Hide", "hide"],
  ["show", "Show", "show"],
];

export const PRESETS = Object.freeze(
  PRESET_ENTRIES.map(([id, name, kind]) => Object.freeze({ id, name, kind })),
);

const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));
const COLOR_PATTERN =
  /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;

function assertFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

// A checked deep copy of JSON-like data: finite numbers, strings, booleans, null, plain objects
// and arrays, with no getters, symbols, cycles or unsafe field names. Every layer is copied this
// way on every frame the preview draws, so the copy is kept cheap: the path in an error message
// ("layer.animations[2].to.x") is only put together when there is an error to report.
function cloneData(value, path = "value") {
  if (value !== null && typeof value === "object" && checkedData.has(value)) return copyData(value);
  const copy = cloneChecked(value, () => path, undefined, []);
  if (value !== null && typeof value === "object") checkedData.add(value);
  return copy;
}

// Objects already checked by cloneChecked. A document's layers are replaced, not changed in
// place, when it is edited, so each is checked once and later frames copy it plainly (the
// check's descriptors and paths were much of each frame's garbage).
const checkedData = new WeakSet();
function copyData(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) copy[index] = copyData(value[index]);
    return copy;
  }
  const copy = {};
  for (const field of Object.keys(value)) copy[field] = copyData(value[field]);
  return copy;
}

// The operations that play, and the same sorted by start (both read only).
function listsOf(stored) {
  const animations = enabledAnimations(stored);
  return { animations, ordered: orderedAnimations(animations) };
}

// listsOf, remembered for each animations list. Only for documents that are replaced, never
// changed in place (the live preview's): a list changed in place would keep its old lists.
const rememberedListsOf = new WeakMap();
function rememberedLists(stored) {
  if (!Array.isArray(stored)) return listsOf(stored);
  let lists = rememberedListsOf.get(stored);
  if (!lists) rememberedListsOf.set(stored, lists = listsOf(stored));
  return lists;
}

// The renderer only reads a layer's animations, so its copy of a checked layer shares the
// animations list with the layer instead of copying it (most of each frame's copying).
function cloneSharingAnimations(layer) {
  if (!checkedData.has(layer) || !Array.isArray(layer.animations)) return cloneData(layer, "layer");
  const copy = {};
  for (const field of Object.keys(layer)) copy[field] = field === "animations" ? layer.animations : copyData(layer[field]);
  return copy;
}

// `parentPath` gives the path of the value that holds this one, and `key` this value's field
// name or index in it (undefined for the top value). `ancestors` are the objects being copied
// around this one, to catch a cycle.
function cloneChecked(value, parentPath, key, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  const path = () => key === undefined ? parentPath()
    : typeof key === "number" ? `${parentPath()}[${key}]` : `${parentPath()}.${key}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path()} must be finite`);
    return value;
  }
  if (typeof value !== "object")
    throw new TypeError(`${path()} must be JSON-compatible`);
  if (ancestors.includes(value)) throw new TypeError(`${path()} cannot be cyclic`);
  ancestors.push(value);
  let copy;
  if (Array.isArray(value)) {
    copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !("value" in descriptor))
        throw new TypeError(`${path()}[${index}] must be a data value`);
      copy[index] = cloneChecked(descriptor.value, path, index, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${path()} must be a plain object`);
    copy = {};
    for (const field of Reflect.ownKeys(value)) {
      if (typeof field !== "string")
        throw new TypeError(`${path()} cannot contain symbol fields`);
      // Refused before it is set, so a plain assignment below can never change the copy's prototype.
      if (field === "__proto__" || field === "constructor" || field === "prototype")
        throw new TypeError(`${path()}.${field} is unsafe`);
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor))
        throw new TypeError(`${path()}.${field} must be a data value`);
      copy[field] = cloneChecked(descriptor.value, path, field, ancestors);
    }
  }
  ancestors.pop();
  return copy;
}

function currentNumber(layer, property, fallback = 0) {
  return Number.isFinite(layer[property]) ? layer[property] : fallback;
}

export function presetAnimation(presetId, layer, start = 0, scene, options = {}) {
  layer = effectiveBoxStyle(layer);
  assertFinite(start, "animation start");
  if (start < 0) throw new RangeError("animation start cannot be negative");
  if (typeof presetId === "string" && presetId.startsWith("effect:")) {
    if (options.mode !== undefined) throw new TypeError("Effects do not have a preset In/Out mode");
    return createEffectAnimation(presetId.slice(7), layer, start, scene, uid(), options.parameters);
  }
  const catalog = createCatalogAnimation(presetId, layer, start, options, uid());
  if (catalog) return catalog;
  if (options.mode !== undefined || options.parameters !== undefined)
    throw new TypeError("Custom animations do not accept preset mode or parameters");
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset)
    throw new RangeError(`unknown animation preset "${String(presetId)}"`);
  if (!layer || typeof layer !== "object")
    throw new TypeError("layer must be an object");
  if (preset.kind === "hide" || preset.kind === "show")
    return createVisibilityOperation(preset.kind, start, uid());
  if (preset.id === "change-text") return createTextChange(layer, start, uid(), scene);
  if (preset.id === "counter") return createCounter(layer, start, uid());

  const x = currentNumber(layer, "x");
  const y = currentNumber(layer, "y");
  const rotation = currentNumber(layer, "rotation");
  const scaleX = currentNumber(layer, "scaleX", 1);
  const scaleY = currentNumber(layer, "scaleY", 1);
  const opacity = currentNumber(layer, "opacity", 1);
  const blur = currentNumber(layer, "blur");
  let from;
  let to;
  let anchor;
  let duration = 0.6;

  switch (presetId) {
    // Lengths are typical template medians: a move 1 s, a
    // scale 0.8 s from 0, a rotation 1.05 s and a fade 0.5 s.
    case "move":
      from = { x: x + 100, y: y + 60 };
      to = { x, y };
      duration = 1;
      break;
    case "scale":
      from = { scaleX: 0, scaleY: 0 };
      to = { scaleX, scaleY };
      duration = 0.8;
      break;
    case "rotate":
      from = { rotation: rotation - 45 };
      to = { rotation };
      duration = 1.05;
      break;
    case "opacity":
      from = { opacity: 0 };
      to = { opacity: opacity > 0 ? opacity : 1 };
      duration = 0.5;
      break;
    case "blur":
      from = { blur: blur + 12 };
      to = { blur };
      break;
    case "background-blur": {
      if (layer.type === "audio")
        throw new TypeError("Background Blur animation requires a layer that is drawn");
      const style = { ...readBackdropStyle(layer, "backgroundBlur"), enabled: true };
      from = { backgroundBlur: { ...style, radius: 0 } };
      to = { backgroundBlur: style };
      break;
    }
    case "glass": {
      if (layer.type === "audio")
        throw new TypeError("Glass animation requires a layer that is drawn");
      const style = { ...readBackdropStyle(layer, "glass"), enabled: true };
      from = { glass: { ...style, refraction: 0 } };
      to = { glass: style };
      break;
    }
    case "arc": {
      if (layer.type !== "ellipse")
        throw new TypeError("Arc preset requires an ellipse layer");
      const arc = {
        donut: currentNumber(layer, "donut"),
        sweep: currentNumber(layer, "sweep", 1),
        startAngle: currentNumber(layer, "startAngle"),
      };
      from = { ...arc };
      to = { ...arc };
      duration = 0.8;
      break;
    }
    case "corners": {
      if (!CORNER_LAYER_TYPES.has(layer.type))
        throw new TypeError("Corners preset requires a rectangle, group, image, or video layer");
      const radius = currentNumber(layer, "radius");
      const radii =
        Array.isArray(layer.cornerRadii) && layer.cornerRadii.length === 4
          ? [...layer.cornerRadii]
          : [radius, radius, radius, radius];
      from = { cornerRadii: [...radii] };
      to = { cornerRadii: [...radii] };
      duration = 0.8;
      break;
    }
    case "star-shape": {
      if (layer.type !== "star")
        throw new TypeError("Star preset requires a star layer");
      const star = {
        spikes: currentNumber(layer, "spikes", 5),
        starThickness: currentNumber(layer, "starThickness", 0.382),
      };
      from = { ...star };
      to = { ...star };
      duration = 0.8;
      break;
    }
    case "stroke": {
      if (!STROKE_LAYER_TYPES.has(layer.type)) {
        throw new TypeError(
          "Stroke preset requires a rectangle, ellipse, star, path, text, group, image, or video layer",
        );
      }
      const sourceStroke = layer.stroke;
      const strokePaint =
        (typeof sourceStroke === "string" && COLOR_PATTERN.test(sourceStroke)) ||
        (sourceStroke &&
          typeof sourceStroke === "object" &&
          !Array.isArray(sourceStroke) &&
          ["linear", "radial"].includes(sourceStroke.type) &&
          Array.isArray(sourceStroke.stops))
          ? sourceStroke
          : "#000000";
      const stroke = {
        strokeWidth: currentNumber(layer, "strokeWidth"),
        stroke: cloneData(strokePaint, "layer.stroke"),
      };
      from = {
        ...stroke,
        stroke: cloneData(stroke.stroke, "animation.from.stroke"),
      };
      to = {
        ...stroke,
        stroke: cloneData(stroke.stroke, "animation.to.stroke"),
      };
      duration = 0.8;
      break;
    }
    case "trim": {
      if (!TRIM_LAYER_TYPES.has(layer.type))
        throw new TypeError("Trim preset requires a rectangle, ellipse, star, or path layer");
      // A draw-on by default: from nothing to the layer's own end.
      const start = currentNumber(layer, "strokeStart");
      from = { strokeStart: start, strokeEnd: start };
      to = { strokeStart: start, strokeEnd: currentNumber(layer, "strokeEnd", 1) };
      duration = 0.8;
      break;
    }
    case "repeat": {
      if (!REPEAT_LAYER_TYPES.has(layer.type))
        throw new TypeError("Repeater preset requires a rectangle, ellipse, star, path, text, or group layer");
      // A burst: copies appear one after another. A layer without a repeater gets 8 copies a turn apart.
      const copies = currentNumber(layer, "repeatCopies", 1);
      // Copies are placed by a move, a turn or a scale (the anchor only matters with a turn or scale).
      const placed = ["repeatX", "repeatY", "repeatRotation"].some((key) => currentNumber(layer, key) !== 0) ||
        currentNumber(layer, "repeatScale", 1) !== 1;
      from = { repeatCopies: 1 };
      to = { repeatCopies: copies > 1 ? copies : 8 };
      if (!placed) from.repeatRotation = to.repeatRotation = 45;
      duration = 0.8;
      break;
    }
    case "color": {
      if (!FILL_LAYER_TYPES.includes(layer.type)) {
        throw new TypeError(
          "Color preset requires a rectangle, ellipse, star, path, text, or group layer",
        );
      }
      // From is the layer's current fill; To starts as a visibly different paint of the same
      // shape (contrastingPaint), ready to edit. The Fill's on/off box is never changed.
      const fill =
        isSolidPaint(layer.fill) || isGradientPaint(layer.fill)
          ? cloneData(layer.fill, "layer.fill")
          : "#000000";
      from = { fill };
      to = { fill: contrastingPaint(fill) };
      break;
    }
    case "resize": {
      // From is the layer's current size and To 1.5 times it; the box grows around its center.
      // Text that sizes itself, groups, audio and component instances are refused there.
      ({ from, to } = resizePresetValues(layer));
      anchor = DEFAULT_RESIZE_ANCHOR;
      break;
    }
    case "shadow": {
      if (layer.type === "audio")
        throw new TypeError("Shadow preset requires a layer that is drawn; audio layers have no shadow");
      // From is the layer's own shadow (or none); To lifts it (shadowPresetValues).
      const shadow = shadowPresetValues(layer.shadow);
      from = { shadow: shadow.from };
      to = { shadow: shadow.to };
      break;
    }
    case "speed": {
      if (!SPEED_LAYER_TYPES.has(layer.type))
        throw new TypeError("Speed preset requires a video, audio or GIF image layer; only they play a file");
      // A slow-motion ramp: from the clip's own speed (mediaSpeed) down to a quarter of it.
      const speed = Math.max(0, Math.min(MAX_ANIMATED_SPEED, currentNumber(layer, "mediaSpeed", 1)));
      from = { speed };
      to = { speed: Math.round(speed * 250) / 1000 };
      break;
    }
    case "letter-spacing": {
      if (layer.type !== "text")
        throw new TypeError("Letter spacing preset requires a text layer; only text has letter spacing");
      // Set the To percentage; the Initial value (From) is
      // optional. Without From, the animation starts from the value the layer has when it
      // starts. To starts 20 % of the font size wider than the layer's letter spacing now.
      from = {};
      to = { letterSpacing: Math.min(LETTER_SPACING_LIMIT, currentNumber(layer, "letterSpacing") + 20) };
      break;
    }
    case "tilt": {
      if (layer.type === "audio") throw new TypeError("Tilt preset requires a layer that is drawn");
      // A flat layer tilts to a product-shot angle; a tilted one lies back flat.
      const rotateX = currentNumber(layer, "rotateX"), rotateY = currentNumber(layer, "rotateY");
      const perspective = currentNumber(layer, "perspective", DEFAULT_PERSPECTIVE);
      const flat = rotateX === 0 && rotateY === 0;
      from = { rotateX, rotateY, perspective };
      to = flat ? { rotateX: 30, rotateY: -20, perspective } : { rotateX: 0, rotateY: 0, perspective };
      duration = 1.2;
      break;
    }
    case "line-height": {
      if (layer.type !== "text")
        throw new TypeError("Line height preset requires a text layer; only text has a line height");
      // Line Height animates the vertical
      // spacing between lines. kino gives it a To value and an optional Initial value (From),
      // like Letter spacing; without one it starts from the line height the text has when it
      // starts. To starts 0.4 (× the font size) taller than the layer's line height now.
      from = {};
      to = { lineHeight: lineHeightPresetTo(layer) };
      break;
    }
    default:
      throw new RangeError(`unknown animation preset "${String(presetId)}"`);
  }

  return {
    id: uid(),
    name: preset.name,
    // A trim draws the stroke on, so it holds its From (no stroke) until it starts, as an In does.
    kind: presetId === "trim" ? "in" : preset.kind,
    start,
    duration,
    // A trim is an entrance, so it arrives fast and settles (expo-out); an opacity fade is linear
    // (as most template fades are); the rest change smoothly.
    easing: presetId === "trim" ? "expo-out" : presetId === "opacity" ? "linear" : "smooth",
    from,
    to,
    unit: "layer",
    stagger: 0,
    order: "forward",
    ...(anchor ? { anchor } : {}),
  };
}

export function uid() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function numberForAnimation(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function expandColor(color) {
  if (typeof color !== "string" || !COLOR_PATTERN.test(color)) return null;
  let digits = color.slice(1);
  if (digits.length === 3 || digits.length === 4)
    digits = [...digits].map((digit) => digit + digit).join("");
  const hasAlpha = digits.length === 8;
  return {
    channels: [0, 2, 4].map((offset) =>
      Number.parseInt(digits.slice(offset, offset + 2), 16),
    ),
    alpha: hasAlpha ? Number.parseInt(digits.slice(6, 8), 16) : 255,
    hasAlpha,
  };
}

function colorAt(from, to, progress) {
  const a = expandColor(from);
  const b = expandColor(to);
  if (!a || !b) return null;
  const channel = (start, end) =>
    Math.max(0, Math.min(255, Math.round(start + (end - start) * progress)));
  const rgb = a.channels.map((start, index) =>
    channel(start, b.channels[index]),
  );
  const includeAlpha = a.hasAlpha || b.hasAlpha;
  const values = includeAlpha ? [...rgb, channel(a.alpha, b.alpha)] : rgb;
  return `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function interpolateValue(from, to, progress) {
  if (typeof from === "number" && typeof to === "number")
    return from + (to - from) * progress;
  if (typeof from === "string" && typeof to === "string") {
    const color = colorAt(from, to, progress);
    return color ?? (progress >= 1 ? to : from);
  }
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.map((value, index) =>
      interpolateValue(value, to[index], progress),
    );
  }
  if (
    from !== null &&
    to !== null &&
    typeof from === "object" &&
    typeof to === "object" &&
    !Array.isArray(from) &&
    !Array.isArray(to)
  ) {
    const fromKeys = Object.keys(from);
    const toKeys = Object.keys(to);
    if (
      fromKeys.length !== toKeys.length ||
      fromKeys.some((key) => !Object.hasOwn(to, key))
    ) {
      return progress >= 1 ? cloneData(to) : cloneData(from);
    }
    const result = {};
    for (const key of fromKeys) {
      Object.defineProperty(result, key, {
        value: interpolateValue(from[key], to[key], progress),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return progress >= 1 ? cloneData(to) : cloneData(from);
}

/** The index of the text unit being drawn in the animation's own unit mode (0 for a layer). */
function operationUnitIndex(animation, options) {
  if ((animation.textAnchor != null || animation.textClip != null || animation.preset?.text) && options.unitGroups)
    return options.unitGroups[animation.unit ?? "layer"]?.index ?? 0;
  return options.unit && animation.unit !== options.unit ? 0 : options.unitIndex ?? 0;
}

/** How many text units the animation's own unit mode has (1 for a layer). */
function operationUnitCount(animation, options) {
  if ((animation.textAnchor != null || animation.textClip != null || animation.preset?.text) && options.unitGroups)
    return options.unitGroups[animation.unit ?? "layer"]?.count ?? 1;
  return options.unit && animation.unit !== options.unit ? 1 : Math.max(1, options.unitCount ?? 1);
}

export function operationStagger(animation, options) {
  const stagger = numberForAnimation(animation.stagger, 0);
  // New explicit text settings allow each operation to keep its own unit mode. Old documents
  // still use the first unit mode, including their exact legacy stagger arithmetic.
  if ((animation.textAnchor != null || animation.textClip != null || animation.preset?.text) && options.unitGroups) {
    const group = options.unitGroups[animation.unit ?? "layer"];
    return group ? unitDelay(animation, group.index, group.count) : 0;
  }
  if ((stagger <= 0 && !animation.delays?.length) || (options.unit && animation.unit !== options.unit))
    return 0;
  const count = Math.max(1, options.unitCount);
  return unitDelay(animation, options.unitIndex, count);
}

const orderedAnimations = (animations) => animations.map((animation, index) => ({ animation, index })).sort((left, right) =>
  numberForAnimation(left.animation?.start, 0) - numberForAnimation(right.animation?.start, 0) || left.index - right.index);

function withResolvedFrom(animation, initial) {
  const keys = new Set([...Object.keys(animation.from || {}), ...Object.keys(animation.to || {})]);
  const value = (key) => key === "reveal" ? normalizeReveal(initial.reveal)
    : key === "cornerRadii" && initial.cornerRadii == null ? Array(4).fill(numberForAnimation(initial.radius, 0))
      : initial[key] === undefined ? animation.from?.[key] : initial[key];
  const resolved = { ...animation, from: Object.fromEntries([...keys].map((key) =>
    [key, value(key)])) };
  delete resolved.fromCurrent;
  return resolved;
}

function initialState(layer, ordered, index, start, options, initialStates) {
  const item = ordered[index];
  if (!initialStates.has(item)) {
    const state = { ...layer };
    applyOperations(state, layer, ordered.slice(0, index).filter(({ animation }) => animation?.enabled !== false),
      start, options, { initialStates, includeAlignment: false });
    initialStates.set(item, state);
  }
  return initialStates.get(item);
}

// Ephemeral, explicit values for editor overlays and export event sampling. Never save these
// copies: they are resolved against the original full history before a drawing path filters it.
// Flat members keep absolute clocks and effective disabled state.
export function resolveInitialAnimations(layer, options = {}) {
  layer = effectiveBoxStyle(layer);
  const ordered = orderedAnimations(flattenAnimations(layer.animations));
  const context = { ...options, unitIndex: options.unitIndex ?? 0, unitCount: options.unitCount ?? 1 };
  const initialStates = new Map(), resolved = new Map();
  for (let index = 0; index < ordered.length; index++) {
    const { animation } = ordered[index];
    if (!usesCurrentInitialValue(animation)) continue;
    const start = numberForAnimation(animation.start, 0) + operationStagger(animation, context);
    resolved.set(animation.id, withResolvedFrom(animation, initialState(layer, ordered, index, start, context, initialStates)));
  }
  return ordered.sort((left, right) => left.index - right.index).map(({ animation }) => resolved.get(animation?.id) ?? animation);
}

export function resolveAnimationInitialValue(layer, animation, options = {}) {
  if (!usesCurrentInitialValue(animation)) return animation;
  return resolveInitialAnimations(layer, options).find((item) => item?.id === animation.id) ?? animation;
}

export function evaluateLayer(
  layer,
  time,
  options = { unitIndex: 0, unitCount: 1 },
) {
  assertFinite(time, "time");
  if (!layer || typeof layer !== "object" || Array.isArray(layer))
    throw new TypeError("layer must be an object");
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypeError("options must be an object");
  }
  const unitIndex = options.unitIndex ?? 0;
  const unitCount = options.unitCount ?? 1;
  if (
    !Number.isInteger(unitIndex) ||
    !Number.isInteger(unitCount) ||
    unitCount < 1 ||
    unitIndex < 0 ||
    unitIndex >= unitCount
  ) {
    throw new RangeError(
      "unitIndex and unitCount must identify an available unit",
    );
  }
  layer = effectiveBoxStyle(layer);
  const evaluated = options.shareAnimations ? cloneSharingAnimations(layer) : cloneData(layer, "layer");
  const playback = resolvePlayback(layer, time);
  // A pin follows its track in scene seconds (pin.js), read before the layer's own clock.
  const pinTime = time;
  time = playback.time;
  // An operation turned off for playback (animationEnabled.js) is left out, so later
  // operations start from the values they would have without it.
  const { animations, ordered } = options.shareAnimations === "remember"
    ? rememberedLists(evaluated.animations) : listsOf(evaluated.animations);
  // Media outside its Play range is hidden unless Freeze keeps its first or last frame.
  // Hide and Show operations then decide visibility at the layer's own clock time.
  evaluated.visible = playback.visible && mediaFrameState(layer, time).visible &&
    visibleByOperations(animations, time);

  const unitOptions = { ...options, unitIndex, unitCount };
  // A Resize with an anchor point also moves x and y so that point stays put (resizeAnchor.js).
  // The moves are added after every operation has run, so a Move that sets x and y later still
  // moves the box from where the Resize keeps it. Sides that text sizes itself don't count.
  const sides = resizableSides(layer);
  const resizes = [];
  const pivots = [];
  const initialStates = new Map();
  applyOperations(evaluated, layer, ordered, time, unitOptions, {
    initialStates,
    onTransform(animation, before, after) {
      if (layer.type === "text" && options.textUnit && animation.textAnchor && animation.textAnchor !== "layer")
        pivots.push({ mode: animation.textAnchor, before, after });
    },
    onResize(animation, start, before) {
      if (!isResizeAnchor(animation.anchor)) return;
      const change = {
        width: sides.width ? sizeChange(before.width, evaluated.width) : 0,
        height: sides.height ? sizeChange(before.height, evaluated.height) : 0,
      };
      if (change.width === 0 && change.height === 0) return;
      // The turn, scale and skew are read at the Resize's start, so a
      // later Rotate turns the resized box around its own center.
      const transform = transformAt(layer, ordered, start, unitOptions, initialStates);
      resizes.push({ anchor: animation.anchor, change, widths: [before.width, evaluated.width], transform });
    },
  });
  // Each styled run starts a Color/Letter spacing operation from its own value.
  // Explicit From/To values are shared endpoints; current-initial operations
  // sample the run's earlier state. Saved style ranges themselves never change.
  if (layer.type === "text" && layer.textStyleRanges?.length) {
    evaluated.textStyleRanges = layer.textStyleRanges.map((range) => {
      const keys = ["fill", "letterSpacing"].filter((key) => Object.hasOwn(range.style, key));
      if (!keys.length) return range;
      const styled = { ...layer, ...range.style }, values = { ...range.style };
      applyOperations(values, styled, ordered, time, unitOptions, { onlyKeys: keys });
      return { ...range, style: Object.fromEntries(Object.keys(range.style).map((key) => [key, values[key]])) };
    });
  }
  if (layer.type === "text" && layer.textResize === "height") addAutoTextHeights(evaluated, resizes, options.fonts);
  if (resizes.length) {
    const shifts = resizes.map((resize) => resizeAnchorShift(resize.anchor, resize.change, resize.transform));
    evaluated.x = numberForAnimation(evaluated.x, 0) + shifts.reduce((sum, shift) => sum + shift.x, 0);
    evaluated.y = numberForAnimation(evaluated.y, 0) + shifts.reduce((sum, shift) => sum + shift.y, 0);
  }
  if (pivots.length) {
    const measured = resizeTextLayer(evaluated, options.fonts);
    const layout = layoutText(measured, options.fonts);
    for (const { mode, before, after } of pivots) {
      const group = textUnitGroup(layout, options.textUnit, mode);
      if (!group) continue;
      const [px, py] = pivotOf(measured);
      const dx = group.bounds.x + group.bounds.width / 2 - px;
      const dy = group.bounds.y + group.bounds.height / 2 - py;
      // Add the translation that changes the operation's pivot from the layer pivot to its
      // shaped unit center. Matrix differences work through mirrored and zero scales too.
      evaluated.x += (before[0] - after[0]) * dx + (before[2] - after[2]) * dy;
      evaluated.y += (before[1] - after[1]) * dx + (before[3] - after[3]) * dy;
    }
  }
  if (layer.pin) applyPin(evaluated, layer, pinTime);
  return evaluated;
}

// Auto height text sets its own height from the lines that fit its width (textLayout.js), so a
// Resize that makes it narrower also makes it taller when the words wrap onto more lines. This
// measures that height change for each anchored Resize, with the text's final font settings
// and the `fonts` it is drawn with, so the anchor's up/down part stays put too. The height is
// also added to `evaluated`, so that resizeTextLayer's own Vertical align offset (the saved
// height minus the measured one) stays the same while the Resize runs.
function addAutoTextHeights(evaluated, resizes, fonts) {
  const heightAt = (width) => layoutText({ ...evaluated, width }, fonts).height;
  let total = 0;
  for (const resize of resizes) {
    const [before, after] = resize.widths;
    try {
      resize.change.height = heightAt(after) - heightAt(before);
    } catch {
      // A font that isn't loaded: the drawing itself reports it (resizeTextLayer throws).
      resize.change.height = 0;
    }
    total += resize.change.height;
  }
  if (total !== 0) evaluated.height = numberForAnimation(evaluated.height, 0) + total;
}

// How much a size changed: `after` minus `before`, or 0 when either isn't a number.
function sizeChange(before, after) {
  return typeof before === "number" && Number.isFinite(before) &&
    typeof after === "number" && Number.isFinite(after) ? after - before : 0;
}

const TRANSFORM_KEYS = ["rotation", "scaleX", "scaleY", "skewX", "skewY"];

// The layer's rotation, scale and skew at `time` (the layer's own clock), from its operations.
function transformAt(layer, ordered, time, options, initialStates) {
  const state = {
    rotation: numberForAnimation(layer.rotation, 0),
    scaleX: numberForAnimation(layer.scaleX, 1),
    scaleY: numberForAnimation(layer.scaleY, 1),
    skewX: numberForAnimation(layer.skewX, 0),
    skewY: numberForAnimation(layer.skewY, 0),
    // The layer's pivot (geometry.js pivotOf); a Resize keeps its anchor point still about it.
    ...(Array.isArray(layer.anchor) ? { anchor: layer.anchor } : {}),
  };
  applyOperations(state, layer, ordered, time, options, { onlyKeys: TRANSFORM_KEYS, initialStates });
  return state;
}

/** True when one of the layer's operations that play changes its volume (a Volume animation). */
export function animatesVolume(layer) {
  return (layer?.type === "video" || layer?.type === "audio") &&
    enabledAnimations(layer.animations ?? []).some((animation) =>
      Object.hasOwn(animation?.from ?? {}, "volume") || Object.hasOwn(animation?.to ?? {}, "volume"));
}

// The layer's sound level from 0 to MAX_VOLUME at scene `time`: its volume with its Volume animations
// applied, as evaluateLayer would set it. Export samples it into the clip's volume track
// (backend/volume-track.mjs) and the preview sets each video and audio element's volume from it.
export function volumeAt(layer, time) {
  const state = { volume: numberForAnimation(layer.volume, 1) };
  if (animatesVolume(layer)) {
    const ordered = orderedAnimations(enabledAnimations(layer.animations));
    applyOperations(state, layer, ordered, resolvePlayback(layer, time).time,
      { unitIndex: 0, unitCount: 1 }, { onlyKeys: ["volume"] });
  }
  return Math.max(0, Math.min(MAX_VOLUME, numberForAnimation(state.volume, 1)));
}

/** True when one of the layer's operations that play changes its low-pass cutoff (a Lowpass animation). */
export function animatesLowpass(layer) {
  return (layer?.type === "video" || layer?.type === "audio") &&
    enabledAnimations(layer.animations ?? []).some((animation) =>
      Object.hasOwn(animation?.from ?? {}, "lowpass") || Object.hasOwn(animation?.to ?? {}, "lowpass"));
}

/**
 * A function of scene time that gives the layer's low-pass cutoff in Hz (lowpass.js), with its
 * Lowpass animations applied, or 0 when the filter is off or fully open (LOWPASS_OPEN and up).
 * The cutoff moves evenly in octaves, as the ear hears it: halfway through a sweep from 400 to
 * 20000 Hz it is at about 2800 Hz, not 10200. Export samples it (backend/lowpass-track.mjs).
 */
export function lowpassSampler(layer) {
  const cutoff = (hz) => (hz >= LOWPASS_OPEN - 0.5 || !(hz > 0) ? 0 : Math.max(LOWPASS_MIN, hz));
  const rest = layer?.lowpass > 0 ? Math.max(LOWPASS_MIN, layer.lowpass) : LOWPASS_OPEN;
  if (!animatesLowpass(layer)) return () => cutoff(rest);
  // The animations are run on log2(Hz), so their easing is in octaves.
  const toOctaves = (values) => values && Object.hasOwn(values, "lowpass") ? { ...values, lowpass: Math.log2(values.lowpass) } : values;
  const animations = enabledAnimations(layer.animations).map((animation) => ({ ...animation, from: toOctaves(animation.from), to: toOctaves(animation.to),
    ...(animation.keys ? { keys: animation.keys.map((key) => ({ ...key, value: toOctaves(key.value) })) } : {}) }));
  const ordered = orderedAnimations(animations);
  const withRest = { ...layer, lowpass: Math.log2(rest) };
  return (time) => {
    const state = { lowpass: Math.log2(rest) };
    applyOperations(state, withRest, ordered, resolvePlayback(layer, time).time,
      { unitIndex: 0, unitCount: 1 }, { onlyKeys: ["lowpass"] });
    return cutoff(2 ** numberForAnimation(state.lowpass, Math.log2(rest)));
  };
}

// Clip speed (mediaTime.js): video, audio and GIF images play their file faster or slower.
const SPEED_LAYER_TYPES = new Set(["video", "audio", "image"]);
// The fastest a Speed animation may play a clip; mediaTime.js MAX_MEDIA_SPEED is the same.
const MAX_ANIMATED_SPEED = 16;
const touchesSpeed = (animation) =>
  Object.hasOwn(animation?.from ?? {}, "speed") || Object.hasOwn(animation?.to ?? {}, "speed");

/** The layer's operations that play and change its clip speed (Speed animations), flattened out of groups. */
export function speedAnimations(layer) {
  if (!SPEED_LAYER_TYPES.has(layer?.type)) return [];
  return enabledAnimations(layer.animations ?? []).filter(touchesSpeed);
}

/** True when one of the layer's operations that play changes its clip speed (a Speed animation). */
export function animatesSpeed(layer) {
  return speedAnimations(layer).length > 0;
}

/**
 * A function of time that gives the layer's clip speed: its mediaSpeed (1 when not set) with its
 * Speed animations applied, from 0 to 16, as evaluateLayer would set `speed`. The time is on the
 * layer's own clock (after component holds). mediaTime.js adds the speed up over time to find
 * which moment of the file plays.
 */
export function speedSampler(layer) {
  const rest = Math.max(0, Math.min(MAX_ANIMATED_SPEED, numberForAnimation(layer?.mediaSpeed, 1)));
  if (!animatesSpeed(layer)) return () => rest;
  // The layer's own speed is the value a Speed animation without a From starts from.
  const withSpeed = { ...layer, speed: rest };
  const ordered = orderedAnimations(enabledAnimations(layer.animations));
  return (time) => {
    const state = { speed: rest };
    applyOperations(state, withSpeed, ordered, time, { unitIndex: 0, unitCount: 1 }, { onlyKeys: ["speed"] });
    return Math.max(0, Math.min(MAX_ANIMATED_SPEED, numberForAnimation(state.speed, rest)));
  };
}

// Equal-power fades, ported from ArtCraft SoundCraft, soundcraft/crates/model/src/clip.rs
// (`FadeShape::gain`, `Fade::gain`; MIT OR Apache-2.0, (c) the ArtCraft authors). A linear Volume
// fade from or to silence follows sin(t pi/2) in and cos(t pi/2) out, so two sounds crossfading
// keep their summed power: a straight line dips about 3 dB in the middle.
const isPowerFade = (animation, from, to) => (animation.easing ?? "linear") === "linear" && !animation.discrete &&
  typeof from === "number" && typeof to === "number" && from !== to && (from === 0 || to === 0);
// The share of the way from `from` to `to` at `progress`: fade in sin(t pi/2), fade out 1 - cos(t pi/2).
function equalPowerProgress(from, to, progress) {
  return from === 0 ? Math.sin(progress * Math.PI / 2) : 1 - Math.cos(progress * Math.PI / 2);
}

// The step of a keyed animation at `progress` (0..1 of its duration): the two keys around it
// and the eased share between them, in the first key's ease (else the animation's easing).
// Before the first key it holds the first value, after the last key the last.
function keyedStep(animation, progress) {
  const keys = animation.keys;
  const first = keys[0], last = keys.at(-1);
  if (progress <= first.t) return { from: first.value, to: first.value, eased: 0, ease: null };
  if (progress >= last.t) return { from: last.value, to: last.value, eased: 1, ease: null };
  let index = 0;
  while (index < keys.length - 2 && progress >= keys[index + 1].t) index++;
  const a = keys[index], b = keys[index + 1];
  const share = (progress - a.t) / (b.t - a.t);
  const ease = a.ease ?? animation.easing ?? "linear";
  return { from: a.value, to: b.value, eased: easingAt(ease, share, animation.intensity), ease, index };
}

// Runs the timed operations `ordered` (sorted by start) on `target` at `time`: each operation
// sets the values it names, and a later one overrides an earlier one. Before its start, only an
// "in" operation applies (its From values). `onlyKeys` limits the values that are set.
// `onResize(animation, start, before)` is called after each operation that ran, with the
// target's width and height from before it.
function applyOperations(target, layer, ordered, time, options, {
  onlyKeys = null, onResize = null, onTransform = null, initialStates = new Map(), includeAlignment = true,
} = {}) {
  // The latest started aligned Move supplies one tangent offset. Keep it after the Move ends,
  // and add it after the ordinary Rotate operations, so their order doesn't erase alignment.
  let alignment = null;
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    let animation = item.animation;
    if (!animation || typeof animation !== "object") continue;
    if (isVisibilityOperation(animation) || isEffectAnimation(animation)) continue;
    if (!isAnimationCompatible(layer, animation)) continue;
    // Only relative travel is dynamic. Keep the saved resting endpoint and every unrelated
    // property (including extra tracks in an imported combined effect). Parameter edits
    // regenerate the complete preset through patchPresetAnimation, not during playback.
    if (animation.preset?.text) {
      const values = presetValues(animation.preset, layer);
      const from = { ...animation.from }, to = { ...animation.to };
      for (const key of ["x", "y"]) {
        if (!Object.hasOwn(values.from, key)) continue;
        const delta = values.from[key] - values.to[key];
        if (animation.kind === "in") from[key] = numberForAnimation(to[key], layer[key]) + delta;
        else to[key] = numberForAnimation(from[key], layer[key]) - delta;
      }
      animation = { ...animation, from, to };
    }
    // Seeded per-unit offsets (textTiming.js scatteredAnimation): letters assemble from apart.
    if (animation.scatter) animation = scatteredAnimation(animation, operationUnitIndex(animation, options));
    const start =
      numberForAnimation(animation.start, 0) +
      operationStagger(animation, options);
    if (usesCurrentInitialValue(animation) && time >= start) {
      // Freeze earlier enabled operations at this unit's start, in the same stable list order.
      // Cache by ordered item during this evaluation so long chains do not recurse exponentially.
      // Sample raw property channels: Resize anchor shifts, unit pivots and path alignment are
      // additive drawing adjustments and must still be applied only once by the outer evaluator.
      animation = withResolvedFrom(animation, initialState(layer, ordered, index, start, options, initialStates));
    }
    let from =
      animation.from && typeof animation.from === "object"
        ? animation.from
        : {};
    let to =
      animation.to && typeof animation.to === "object" ? animation.to : {};
    let keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];
    const followsPath = isMoveAnimation(animation) && animation.motionPath?.points?.length > 0;
    const aligns = followsPath && animation.motionPath.alignToPath && (!onlyKeys || onlyKeys.includes("rotation"));
    if (onlyKeys) keys = keys.filter((key) => onlyKeys.includes(key));
    if (keys.length === 0 && !aligns) continue;
    const before = onResize ? { width: target.width, height: target.height } : null;
    const beforeTransform = onTransform && keys.some((key) => TRANSFORM_KEYS.includes(key)) ? layerMatrix(target) : null;
    const reportTransform = () => { if (beforeTransform) onTransform(animation, beforeTransform, layerMatrix(target)); };

    if (time < start) {
      if (animation.kind === "in") {
        for (const key of Object.keys(from)) {
          if (!onlyKeys || onlyKeys.includes(key))
            target[key] = key === "shadow"
              ? interpolateShadowChannels(target.shadow, from[key], to[key], 0, animation.shadowChannels)
              : key === "axes"
                ? { ...target.axes, ...interpolateAxes(from.axes, to.axes, 0, target) }
              : cloneData(from[key], `animation.from.${key}`);
        }
        if (Object.hasOwn(from, "effectPreset") && (!onlyKeys || onlyKeys.includes("effectPreset")))
          target._effectPresetOperation = { id: animation.id, start: animation.start };
        if (keys.includes("opacity")) {
          if (animation.discrete) target._discreteOpacity = `${animation.id}:0`;
          else delete target._discreteOpacity;
        }
        onResize?.(animation, start, before);
        reportTransform();
      }
      continue;
    }

    const duration = numberForAnimation(animation.duration, 0);
    // A loop plays the pass again after it ends, and a wiggle drifts the numbers (behavior.js).
    const local = behaviorTime(animation, time - start, duration);
    const wiggle = animation.behavior?.wiggle;
    // Ephemeral sampling metadata: a cycle jumps back at each new pass, which Lottie must hold.
    if (animation.behavior?.loop?.mode === "cycle" && duration > 0)
      target._loopPass = `${target._loopPass ?? ""}${animation.id}:${Math.floor((time - start) / duration)};`;
    let progress =
      duration <= 0 ? 1 : Math.max(0, Math.min(1, local / duration));
    if (progress > 1 - 1e-12) progress = 1;
    let eased = discreteProgress(animation.discrete, easingAt(animation.easing ?? "linear", progress, animation.intensity));
    // A keyed animation plays the step of its keys that holds this moment (keyedStep).
    const step = Array.isArray(animation.keys) && animation.keys.length > 1 ? keyedStep(animation, progress) : null;
    if (step) ({ from, to, eased } = step);
    // Ephemeral sampling metadata: a steps curve jumps between frames, which Lottie must hold.
    if ((step ? step.ease : animation.easing) === "steps")
      target._stepsAt = `${target._stepsAt ?? ""}${animation.id}:${step ? `${step.index}/` : ""}${eased};`;
    // A range selector (textTiming.js textRangeProgress): this unit's share of the eased sweep.
    if (animation.range) eased = textRangeProgress(animation.range, eased, operationUnitIndex(animation, options), operationUnitCount(animation, options));
    // Ephemeral sampling metadata: Lottie must hold these opacity switches between frames.
    // An ordinary opacity operation taking over clears it, so fades remain interpolated.
    if (keys.includes("opacity")) {
      if (animation.discrete) target._discreteOpacity = `${animation.id}:${eased}`;
      else delete target._discreteOpacity;
    }
    for (const key of keys) {
      if (followsPath && (key === "x" || key === "y")) continue;
      const fromValue = Object.hasOwn(from, key) ? from[key] : target[key];
      const toValue = Object.hasOwn(to, key) ? to[key] : target[key];
      target[key] = key === "path"
        ? interpolatePath(fromValue, toValue, eased)
        : key === "fill" || key === "stroke"
          ? interpolatePaint(fromValue, toValue, eased)
          : key === "shadow"
            ? interpolateShadowChannels(target.shadow, fromValue, toValue, eased, animation.shadowChannels)
            : key === "reveal"
              ? interpolateReveal(fromValue, toValue, eased)
            : key === "axes"
              // Axes the animation does not name keep the layer's own value (wdth stays while wght moves).
              ? { ...target.axes, ...interpolateAxes(fromValue, toValue, eased, target) }
            : key === "volume" && !step && isPowerFade(animation, fromValue, toValue)
              ? interpolateValue(fromValue, toValue, equalPowerProgress(fromValue, toValue, progress))
            : interpolateValue(fromValue, toValue, eased);
    if (wiggle && typeof target[key] === "number") {
      target[key] += wiggleOffset(wiggle, key, Math.min(local, duration), duration);
      if (key === "opacity") target[key] = Math.max(0, Math.min(1, target[key]));
    }
    }
    if (keys.includes("effectPreset")) target._effectPresetOperation = { id: animation.id, start: animation.start };
    if (followsPath) {
      const { start: pathStart, end: pathEnd } = motionEndpoints(layer, animation);
      const pose = motionPathAt(pathStart, pathEnd, animation.motionPath, eased);
      if (!onlyKeys || onlyKeys.includes("x")) target.x = pose.x;
      if (!onlyKeys || onlyKeys.includes("y")) target.y = pose.y;
      if (aligns) alignment = pose.angle + (animation.motionPath.alignmentOffset ?? 0);
    }
    onResize?.(animation, start, before);
    reportTransform();
  }
  if (includeAlignment && alignment !== null) target.rotation = numberForAnimation(target.rotation, 0) + alignment;
}

export function evaluateScene(scene, time) {
  assertFinite(time, "time");
  if (!scene || typeof scene !== "object" || Array.isArray(scene))
    throw new TypeError("scene must be an object");
  const evaluated = cloneData(scene, "scene");
  if (!Array.isArray(evaluated.layers))
    throw new TypeError("scene.layers must be an array");
  const unitCount = Math.max(1, evaluated.layers.length);
  evaluated.layers = evaluated.layers.map((layer, unitIndex) =>
    evaluateLayer(layer, time, {
      unitIndex,
      unitCount,
      unit: "layer",
    }),
  );
  return evaluated;
}
