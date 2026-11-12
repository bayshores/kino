import { normalizeQualityDocumentFields, normalizeQualityLayerFields, normalizeQualitySceneFields } from "./qualityFields.js";
import { normalizeShutterAngle } from "./projectSettings.js";
import { normalizeBlockDocumentFields, normalizeBlockLayerFields, normalizeBlockSceneFields } from "./blockFields.js";
import { normalizeDrift } from "./camera.js";
import { normalizeLetterbox, normalizeSceneFinish } from "./sceneFinishFields.js";
import { normalizeAskShows, normalizeSubjectBoxes } from "./sourceView.js";
import { normalizePin, normalizeTracks } from "./pin.js";
import { normalizeRecording } from "./recording.js";
import { normalizeBoard } from "./board.js";
import { normalizeSources } from "./sources.js";
import { FPS_HELP, parseFps } from "./frameRate.js";
import { normalizeFill } from "./paintValidation.js";
import { isEffectAnimation, normalizeEffectAnimation } from "./effects/animation.js";
import { normalizeTextStyleRanges } from "./textStyleRanges.js";
import { DOCUMENT_VERSION, MAX_MEDIA_SECONDS, MAX_TIME, MAX_UPLOAD_BYTES } from "./schema.js";
import { normalizeEasing as canonicalEasing, normalizeIntensity } from "./easing.js";
import { TEXT_UNIT_ORDERS, normalizeSmoothing, normalizeTextRange } from "./textTiming.js";
import { normalizeTextLoop } from "./textLoop.js";
import { normalizeLetterJitter } from "./letterJitter.js";
import { isMoveAnimation, normalizeMotionPath } from "./motionPath.js";
import { behaviorKeys, normalizeBehavior } from "./behavior.js";
import { normalizePreset, normalizeDiscrete } from "./presetCatalog.js";
import { normalizeReveal } from "./reveal.js";
import { normalizeEffectPresetValue } from "./effects/presetCatalog.js";
import { parsePath, interpolatePath } from "./vectorPath.js";
import { INITIAL_VALUE_KEYS, SHAPE_PROPERTY_TYPES } from "./animationCompatibility.js";
import { canUseCurrentInitialValue } from "./animationInitialValue.js";
import { TIMED_ANIMATION_FIELDS, VISIBILITY_KINDS } from "./visibilityOps.js";
import { RESIZE_ANCHOR_LIST, isResizeAnchor, resizeProblem } from "./resizeAnchor.js";
import { SHADOW_LIMITS } from "./shadowInterpolation.js";
import { normalizeShadowChannels } from "./shadowChannels.js";
import { normalizeShadowList } from "./stackedShadows.js";
import { STACKED_STROKE_TYPES, normalizeStrokeList } from "./stackedStrokes.js";
import { migrateDocument } from "./documentMigration.js";
import { sceneRectangles, MAX_CANVAS_COORDINATE } from "./sceneLayout.js";
import { LETTER_SPACING_LIMIT } from "./letterSpacing.js";
import { normalizeAxes } from "./fontAxes.js";
import { LINE_HEIGHT_MAX, LINE_HEIGHT_MIN } from "./lineHeight.js";
import {
  DEFAULT_SLIDE_DISTANCE, DEFAULT_TEXT_EFFECT_SECONDS, MAX_SLIDE_DISTANCE, MAX_TEXT_EFFECT_STAGGER, TEXT_CHANGE_FORBIDDEN_FIELDS,
  TEXT_CHANGE_KIND, TEXT_EFFECT_FIELDS, TEXT_EFFECT_ORDERS, TEXT_EFFECT_UNITS, isSlideEffect, textChangeEffectSeconds, textEffectEasing, textEffectPresets,
} from "./textChange.js";
import { COUNTER_FORBIDDEN_FIELDS, COUNTER_KIND, counterValueProblem } from "./counter.js";
import { normalizeComponentOverrides } from "./componentOverrides.js";
import { backgroundAnimationProblem, backgroundLayer } from "./sceneBackground.js";
import { CORNER_LAYER_TYPES, STROKE_LAYER_TYPES, effectiveBoxStyle, legacyBoxStyles } from "./boxStyles.js";
import { BACKDROP_STYLE_KEYS, defaultBackdropStyle, normalizeBackdropStyle } from "./backdropStyles.js";
import { MAX_ANIMATION_GROUP_DEPTH, flattenAnimations, isComposedAnimation } from "./animationTree.js";
import { LOWPASS_MIN, LOWPASS_OPEN } from "./lowpass.js";
import { MORPH_MAX, MORPH_MIN } from "./morphCut.js";
import { TRIM_KEYS, TRIM_LAYER_TYPES } from "./strokeTrim.js";
import { REPEAT_FRACTION_KEYS, REPEAT_KEYS, REPEAT_LAYER_TYPES, REPEAT_REST, repeatRange } from "./repeater.js";
import { MODIFIER_CHOICES, MODIFIER_CHOICE_KEYS, MODIFIER_KEYS, MODIFIER_LAYER_TYPES, MODIFIER_REST, modifierRange } from "./shapeModifiers.js";
import { DEFAULT_PERSPECTIVE, PERSPECTIVE_MAX, PERSPECTIVE_MIN, TILT_LIMIT } from "./tilt.js";
import { MASK_MODES } from "./maskVisibility.js";
import { LOG_PROFILES } from "./footageLog.js";
import {
  MAX_MEDIA_FRAME_RATE, MAX_MEDIA_SPEED, MAX_VOLUME, MEDIA_INTERPOLATIONS, MEDIA_PITCHES, MEDIA_TIMING_TYPES, MIN_MEDIA_FRAME_RATE, MIN_MEDIA_SPEED,
} from "./mediaTime.js";


const LAYER_TYPES = new Set([
  "rectangle",
  "ellipse",
  "star",
  "text",
  "image",
  "video",
  "path",
  "group",
  "audio",
  "component",
]);
const STROKE_ALIGNMENTS = new Set(["center", "inside", "outside"]);
const PATH_FILL_RULES = new Set(["nonzero", "evenodd"]);
const VALUE_KEYS = new Set([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "scaleX",
  "scaleY",
  // Skew in degrees (geometry.js layerMatrix: rotate · scale · skewX · skewY).
  "skewX",
  "skewY",
  "opacity",
  "blur",
  "backgroundBlur",
  "glass",
  "radius",
  "cornerRadii",
  "donut",
  "sweep",
  "startAngle",
  "spikes",
  "starThickness",
  "fill",
  "stroke",
  "strokeWidth",
  // Trim paths and dashes (strokeTrim.js); only rectangle, ellipse, star and path layers.
  "strokeStart",
  "strokeEnd",
  "strokeOffset",
  "dash",
  "dashOffset",
  "path",
  "shadow",
  "reveal",
  "effectPreset",
  // Percent of the font size (letterSpacing.js); only text layers have letter spacing.
  "letterSpacing",
  // A multiple of the font size (lineHeight.js); only text layers have a line height.
  "lineHeight",
  // Variable font axes {wght, wdth, slnt, opsz} (fontAxes.js); only text layers have them.
  "axes",
  // Sound level 0..MAX_VOLUME, like layer.volume; only video and audio layers have sound.
  "volume",
  // Clip speed 0..16 (mediaTime.js), like layer.mediaSpeed; only video, audio and GIF images play a file.
  "speed",
  // Low-pass cutoff in Hz, 20..20000 (lowpass.js), like layer.lowpass; only video and audio have sound.
  "lowpass",
  // 2.5D tilt (tilt.js): rotateX and rotateY in degrees, perspective in px.
  "rotateX",
  "rotateY",
  "perspective",
  // A repeater (repeater.js); only shape, path, text and group layers.
  ...REPEAT_KEYS,
  // Shape modifiers (shapeModifiers.js); only shape and path layers.
  ...MODIFIER_KEYS,
]);
// Keys measured in fractions (1 is 100%): a wiggle amount for pixels or degrees is far too big.
const FRACTION_KEYS = new Set(["scaleX", "scaleY", "opacity", "lineHeight", "donut", "starThickness", "bloatAmount", ...REPEAT_FRACTION_KEYS]);
// What a tilt animation starts from when the layer has no tilt of its own.
const TILT_REST = { rotateX: 0, rotateY: 0, perspective: DEFAULT_PERSPECTIVE };
// What a trim or dash animation starts from when the layer has none of its own (strokeTrim.js).
const TRIM_REST = { strokeStart: 0, strokeEnd: 1, strokeOffset: 0, dash: [], dashOffset: 0 };
const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const COLOR_PATTERN =
  /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const FONT_SOURCE_PATTERN =
  /^\/api\/(?:(?:media\/[a-f0-9-]{36})|(?:fonts\/[a-z0-9_-][a-z0-9._-]*))\.(?:ttf|otf|woff|woff2)$/i;
/** Longest scene, and latest time an animation may end, in seconds (schema.js; see engine/timeLimits.js). */
export { MAX_TIME };
const MEDIA_FREEZE = new Set(["none", "first", "last", "both"]);
const MAX_COORDINATE = 1_000_000;
const MAX_DIMENSION = 65_536;
const MAX_DOCUMENT_BYTES = MAX_UPLOAD_BYTES;
export const MAX_SCENES = 100;
const MAX_LAYERS_PER_SCENE = 5_000;
export const MAX_LAYERS_TOTAL = 10_000;
const MAX_ANIMATIONS_PER_LAYER = 256;
const MAX_ANIMATIONS_TOTAL = 50_000;
const MAX_TREE_NODES = 250_000;
const MAX_TREE_DEPTH = 64;
export const MAX_STRING_LENGTH = 2_000_000;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeClone(value) {
  const ancestors = new WeakSet();
  let nodes = 0;
  let stringUnits = 0;

  function copy(current, path, depth) {
    nodes += 1;
    if (nodes > MAX_TREE_NODES) fail(path, "document contains too many values");
    if (depth > MAX_TREE_DEPTH) fail(path, "document is nested too deeply");

    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      stringUnits += current.length;
      if (
        current.length > MAX_STRING_LENGTH ||
        stringUnits > MAX_DOCUMENT_BYTES
      ) {
        fail(path, "text exceeds the document size limit");
      }
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Math.abs(current) > 1e12) {
        fail(path, "numbers must be finite and within the supported range");
      }
      return current;
    }
    if (typeof current !== "object")
      fail(path, "only JSON-compatible values are allowed");
    if (ancestors.has(current)) fail(path, "cyclic values are not allowed");
    ancestors.add(current);

    let result;
    if (Array.isArray(current)) {
      if (current.length > MAX_TREE_NODES)
        fail(path, "array contains too many values");
      const ownKeys = Reflect.ownKeys(current);
      if (
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9]\d*)$/.test(key) ||
              Number(key) >= current.length),
        )
      ) {
        fail(path, "arrays cannot have custom properties");
      }
      result = new Array(current.length);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current,
          String(index),
        );
        if (!descriptor || !("value" in descriptor))
          fail(
            `${path}[${index}]`,
            "sparse arrays and accessors are not allowed",
          );
        result[index] = copy(descriptor.value, `${path}[${index}]`, depth + 1);
      }
    } else {
      if (!isRecord(current)) fail(path, "objects must be plain JSON objects");
      const keys = Reflect.ownKeys(current);
      if (keys.length > 10_000) fail(path, "object contains too many fields");
      result = {};
      for (const key of keys) {
        if (typeof key !== "string")
          fail(path, "symbol fields are not allowed");
        if (
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor"
        ) {
          fail(`${path}.${key}`, "unsafe field name");
        }
        stringUnits += key.length;
        if (stringUnits > MAX_DOCUMENT_BYTES)
          fail(path, "text exceeds the document size limit");
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor))
          fail(`${path}.${key}`, "accessors are not allowed");
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, `${path}.${key}`, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }

    ancestors.delete(current);
    return result;
  }

  return copy(value, "document", 0);
}

function randomId() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function uid() {
  return randomId();
}

function layerDefaults(type, id = uid()) {
  return {
    id,
    name: type[0].toUpperCase() + type.slice(1),
    type,
    parentId: null,
    x: 100,
    y: 100,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    opacity: 1,
    fill: type === "text" ? "#171717" : "#6c7cff",
    // Fill on/off. Off keeps the paint in `fill` for turning it back on (paints.js isFillEnabled).
    fillEnabled: type !== "group",
    stroke: "#000000",
    strokeWidth: 0,
    strokeAlign: "center",
    radius: 0,
    cornerRadii: null,
    donut: 0,
    sweep: 1,
    startAngle: 0,
    spikes: 5,
    starThickness: 0.382,
    visible: true,
    locked: false,
    // The aspect-ratio lock: editing width or height keeps the layer's proportions. Only the
    // editor uses it; drawing and exports ignore it.
    lockAspect: false,
    blur: 0,
    blendMode: "normal",
    isMask: false,
    isMaskGroup: false,
    clipContent: false,
    playbackWindows: [],
    shadow: null,
    text: type === "text" ? "Text" : "",
    fontFamily: "Inter",
    fontSource: "",
    fontSize: 48,
    fontWeight: 400,
    fontStyle: "normal",
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    verticalAlign: "top",
    textResize: "fixed",
    textCase: "normal",
    kerning: true,
    ligatures: true,
    path: "",
    ...(type === "path" ? { fillRule: "nonzero" } : {}),
    src: "",
    mediaStart: 0,
    mediaDuration: 0,
    mediaOffset: 0,
    mediaFreeze: "none",
    mediaSourceDuration: 0,
    volume: 1,
    animations: [],
    ...(type === "component" ? {componentSceneId: "", componentStart: 0, componentVisibility: "both", componentBackgroundEnabled: true, clipContent: true} : {}),
  };
}

export function createLayer(type, overrides = {}) {
  if (!LAYER_TYPES.has(type))
    fail("layer.type", `unsupported layer type "${String(type)}"`);
  const safeOverrides = safeClone(overrides);
  if (!isRecord(safeOverrides)) fail("layer overrides", "must be an object");
  return { ...layerDefaults(type), ...safeOverrides, type };
}

export function createScene(overrides = {}) {
  const safeOverrides = safeClone(overrides);
  if (!isRecord(safeOverrides)) fail("scene overrides", "must be an object");
  return {
    id: uid(),
    name: "Scene 1",
    width: 640,
    height: 360,
    duration: 4,
    background: "#ffffff",
    backgroundEnabled: true,
    backgroundAnimations: [],
    isComponent: false,
    aspectLocked: false,
    layers: [],
    ...safeOverrides,
  };
}

export function createDocument(overrides = {}) {
  const safeOverrides = safeClone(overrides);
  if (!isRecord(safeOverrides)) fail("document overrides", "must be an object");
  return {
    version: DOCUMENT_VERSION,
    id: uid(),
    name: "New file",
    scenes: [createScene()],
    ...safeOverrides,
  };
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function requireArray(value, path, maxLength) {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > maxLength)
    fail(path, `cannot contain more than ${maxLength} items`);
  return value;
}

function requireId(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(
      path,
      "must be a non-empty ID containing only letters, numbers, dot, underscore, colon, or hyphen",
    );
  }
  return value;
}

function normalizeBulkVariant(value, path) {
  requireRecord(value, path);
  const baseSceneId = requireId(value.baseSceneId, `${path}.baseSceneId`);
  const key = requireString(value.key, `${path}.key`).trim();
  if (key.length < 1 || key.length > 128)
    fail(`${path}.key`, "must contain 1 to 128 non-whitespace characters");
  const instanceId = requireId(value.instanceId, `${path}.instanceId`);
  return { baseSceneId, key, instanceId };
}

function requireString(value, path, maxLength = 1_000_000) {
  if (typeof value !== "string") fail(path, "must be text");
  if (value.length > maxLength)
    fail(path, `cannot exceed ${maxLength} characters`);
  return value;
}

function requireNumber(value, path, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail(path, `must be a finite number from ${min} to ${max}`);
  }
  return value;
}

// 2.5D tilt (tilt.js): the plane turns at most TILT_LIMIT degrees, so it is never seen edge-on.
function requireTilt(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > TILT_LIMIT)
    fail(path, `must be a number of degrees from -${TILT_LIMIT} to ${TILT_LIMIT} (at 90 the plane is seen edge-on); try 20 to 45`);
  return value;
}

function requirePerspective(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < PERSPECTIVE_MIN || value > PERSPECTIVE_MAX)
    fail(path, `must be the eye's distance in px, from ${PERSPECTIVE_MIN} to ${PERSPECTIVE_MAX} (default ${DEFAULT_PERSPECTIVE}; smaller is a stronger perspective)`);
  return value;
}

function requireInteger(value, path, min, max) {
  requireNumber(value, path, min, max);
  if (!Number.isInteger(value))
    fail(path, `must be an integer from ${min} to ${max}`);
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function requireColor(value, path) {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    fail(path, "must be a hex color such as #336699 or #336699cc");
  }
  return value;
}

// A drop shadow { color (hex, its alpha is the shadow's opacity), x, y (offset in px), blur (px) }:
// a layer's `shadow`, and the from and to values of a Shadow animation. SHADOW_LIMITS
// (shadowInterpolation.js) holds the largest offset and blur, shared with the Shadow preset.
function normalizeShadow(value, path) {
  requireRecord(value, path);
  return {
    ...value,
    color: requireColor(value.color, `${path}.color`),
    x: requireNumber(value.x, `${path}.x`, -SHADOW_LIMITS.offset, SHADOW_LIMITS.offset),
    y: requireNumber(value.y, `${path}.y`, -SHADOW_LIMITS.offset, SHADOW_LIMITS.offset),
    blur: requireNumber(value.blur, `${path}.blur`, 0, SHADOW_LIMITS.blur),
  };
}

// strokeStart and strokeEnd are fractions of each contour; strokeOffset turns it (and wraps);
// dash is [on, off, ...] in px; dashOffset shifts the pattern in px.
function normalizeTrimValue(key, value, path) {
  if (key === "dash") {
    const list = requireArray(value, path, 16);
    const dash = list.map((entry, index) => requireNumber(entry, `${path}[${index}]`, 0, 100_000));
    if (dash.length && !dash.some((entry) => entry > 0)) fail(path, "needs at least one length above 0, or [] for a solid stroke");
    return dash;
  }
  if (key === "strokeOffset") return requireNumber(value, path, -1_000, 1_000);
  if (key === "dashOffset") return requireNumber(value, path, -1_000_000, 1_000_000);
  return requireNumber(value, path, 0, 1);
}

// A layer's anchor: [x, y] percent of its box, -1000 to 1000 each.
function readLayerAnchor(value, path) {
  const list = requireArray(value, path, 2);
  if (list.length !== 2) fail(path, "must be [x, y]: percent of the box (0 0 top-left, 50 50 center, 100 100 bottom-right)");
  return list.map((entry, index) => requireNumber(entry, `${path}[${index}]`, -1_000, 1_000));
}

function validateAnimatedValue(key, value, path) {
  if (!VALUE_KEYS.has(key))
    fail(path, `cannot animate unsupported property "${key}"`);
  if (BACKDROP_STYLE_KEYS.includes(key)) return normalizeBackdropStyle(key, value, path);
  if (key === "fill" || key === "stroke") return normalizeFill(value, path);
  if (key === "reveal") {
    try { return normalizeReveal(value); } catch (error) { fail(path, error.message); }
  }
  if (key === "effectPreset") {
    try { return normalizeEffectPresetValue(value); } catch (error) { fail(path, error.message); }
  }
  if (key === "axes") return normalizeAxes(value, path);
  if (key === "shadow") {
    // null is "no shadow": a Shadow animation fades in from it or out to it (shadowInterpolation.js).
    if (value === null) return null;
    const { color, x, y, blur } = normalizeShadow(value, path);
    return { color, x, y, blur };
  }
  if (key === "path") {
    const d = requireString(value, path, 2_000_000);
    try { parsePath(d); } catch (error) { fail(path, error.message); }
    return d;
  }
  switch (key) {
    case "strokeWidth":
      return requireNumber(value, path, 0, 10_000);
    case "strokeStart":
    case "strokeEnd":
    case "strokeOffset":
    case "dash":
    case "dashOffset":
      return normalizeTrimValue(key, value, path);
    case "radius":
      return requireNumber(value, path, 0, MAX_DIMENSION);
    case "repeatCopies": case "repeatX": case "repeatY": case "repeatRotation": case "repeatScale":
    case "repeatAnchorX": case "repeatAnchorY": case "repeatStartOpacity": case "repeatEndOpacity":
      return requireNumber(value, path, ...repeatRange(key));
    case "zigzagSize": case "zigzagCount": case "offsetAmount": case "roundCorners": case "bloatAmount":
    case "twistAngle": case "twistX": case "twistY":
    case "roughenSize": case "roughenDetail": case "roughenSeed": case "roughenBoil": case "roughenAngle":
      return requireNumber(value, path, ...modifierRange(key));
    case "cornerRadii": {
      const radii = requireArray(value, path, 4);
      if (radii.length !== 4) fail(path, "must contain four corner radii");
      return radii.map((radius, index) =>
        requireNumber(radius, `${path}[${index}]`, 0, MAX_DIMENSION),
      );
    }
    case "donut":
    case "sweep":
    case "starThickness":
      return requireNumber(value, path, 0, 1);
    case "startAngle":
      return requireNumber(value, path, -360_000, 360_000);
    case "spikes":
      return requireInteger(value, path, 0, 1_000);
    case "x":
    case "y":
      return requireNumber(value, path, -MAX_COORDINATE, MAX_COORDINATE);
    case "width":
    case "height":
      return requireNumber(value, path, 0, MAX_DIMENSION);
    case "rotation":
      return requireNumber(value, path, -360_000, 360_000);
    case "rotateX":
    case "rotateY":
      return requireTilt(value, path);
    case "skewX":
    case "skewY":
      return requireNumber(value, path, -89.999, 89.999);
    case "perspective":
      return requirePerspective(value, path);
    case "scaleX":
    case "scaleY":
      return requireNumber(value, path, -1_000, 1_000);
    case "opacity":
      return requireNumber(value, path, 0, 1);
    case "volume":
      return requireNumber(value, path, 0, MAX_VOLUME);
    case "speed":
      return requireNumber(value, path, 0, MAX_MEDIA_SPEED);
    case "lowpass":
      return requireNumber(value, path, LOWPASS_MIN, LOWPASS_OPEN);
    case "blur":
      return requireNumber(value, path, 0, 1_000);
    case "letterSpacing":
      return requireNumber(value, path, -LETTER_SPACING_LIMIT, LETTER_SPACING_LIMIT);
    case "lineHeight":
      return requireNumber(value, path, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX);
    default:
      return value;
  }
}

function normalizeEasing(value, path) {
  try { return canonicalEasing(value); }
  catch (error) { fail(path, error.message); }
}

// A custom animation's keys (animation.js keyedStep): 3 to 64 of {t, value, ease?}, t a share
// of the duration (0..1) rising key by key, every value naming the same properties. from and to
// become the first and last value. Returns the keys with their eases checked.
const MAX_ANIMATION_KEYS = 64;
const KEYS_CLASH = ["motionPath", "scatter", "range", "fromCurrent", "preset", "discrete"];
function readAnimationKeys(animation, path) {
  if (animation.kind !== "custom") fail(`${path}.keys`, "only a custom animation has keys");
  for (const field of KEYS_CLASH) if (animation[field] != null) fail(`${path}.keys`, `can't be used with ${field}`);
  const list = requireArray(animation.keys, `${path}.keys`, MAX_ANIMATION_KEYS);
  if (list.length < 3) fail(`${path}.keys`, "needs 3 or more keys (two ends are from and to)");
  let names = null, before = -1;
  const keys = list.map((raw, index) => {
    const at = `${path}.keys[${index}]`;
    requireRecord(raw, at);
    for (const field of Object.keys(raw)) if (!["t", "value", "ease"].includes(field)) fail(`${at}.${field}`, "is not t, value or ease");
    const t = requireNumber(raw.t, `${at}.t`, 0, 1);
    if (t <= before) fail(`${at}.t`, "must be later than the key before it");
    before = t;
    const own = Object.keys(requireRecord(raw.value, `${at}.value`)).sort().join(", ");
    if (!own) fail(`${at}.value`, "must name at least one property");
    names ??= own;
    if (own !== names) fail(`${at}.value`, `must name the same properties as the first key (${names})`);
    return { t, value: { ...raw.value }, ...(raw.ease == null ? {} : { ease: normalizeEasing(raw.ease, `${at}.ease`) }) };
  });
  animation.from = { ...keys[0].value };
  animation.to = { ...keys.at(-1).value };
  return keys;
}

// Missing intensity keeps old documents structurally unchanged and evaluates as 50.
function normalizeAnimationIntensity(animation, path) {
  if (animation.intensity === undefined) return;
  try { animation.intensity = normalizeIntensity(animation.intensity); }
  catch (error) { fail(`${path}.intensity`, error.message); }
}

// Text delay distribution is independent from each unit's animation progress.
// Missing settings preserve old documents; null explicitly clears a saved setting.
function normalizeTextSmoothing(value, path) {
  if (value.smoothing == null) delete value.smoothing;
  else {
    try { value.smoothing = normalizeSmoothing(value.smoothing); }
    catch (error) { fail(`${path}.smoothing`, error.message); }
  }
  if (value.smoothingIntensity == null) delete value.smoothingIntensity;
  else {
    try { value.smoothingIntensity = normalizeIntensity(value.smoothingIntensity); }
    catch (error) { fail(`${path}.smoothingIntensity`, error.message); }
  }
}

// Checks one animation the way an operation sent it, before it joins a layer, so a problem names
// the operation's own field ("animation.easing: ...") rather than a path inside the document.
// Returns the problem as text, or null when the animation is valid on this layer.
export function animationProblem(animation, layer) {
  try {
    normalizeAnimation(structuredClone(animation), "animation", new Set(), layer);
    return null;
  } catch (error) {
    return error.message;
  }
}

function normalizeAnimation(raw, path, ids, layer, depth = 0, offset = 0) {
  requireRecord(raw, path);
  const animation = { ...raw };
  animation.id = requireId(animation.id, `${path}.id`);
  if (ids.has(animation.id))
    fail(`${path}.id`, `duplicate animation ID "${animation.id}"`);
  ids.add(animation.id);
  if (ids.size > MAX_ANIMATIONS_TOTAL) fail(path, `document cannot contain more than ${MAX_ANIMATIONS_TOTAL} animations`);
  animation.name = requireString(animation.name, `${path}.name`, 256);
  // Turned off for playback (animationEnabled.js) is saved as `enabled: false`; on has no field.
  if (animation.enabled === undefined || animation.enabled === true) delete animation.enabled;
  else requireBoolean(animation.enabled, `${path}.enabled`);
  if (animation.fromCurrent == null || animation.fromCurrent === false) delete animation.fromCurrent;
  else {
    requireBoolean(animation.fromCurrent, `${path}.fromCurrent`);
    if (!canUseCurrentInitialValue(animation)) fail(`${path}.fromCurrent`, "requires a custom operation without preset metadata");
  }
  if (isComposedAnimation(animation)) {
    if (depth >= MAX_ANIMATION_GROUP_DEPTH) fail(path, `animation groups cannot exceed ${MAX_ANIMATION_GROUP_DEPTH} levels`);
    animation.start = requireNumber(animation.start, `${path}.start`, 0, MAX_TIME);
    const allowed = new Set(["id", "name", "kind", "start", "enabled", "animations"]);
    for (const key of Object.keys(animation)) if (!allowed.has(key)) fail(`${path}.${key}`, "is not a Composed group field");
    const children = requireArray(animation.animations, `${path}.animations`, MAX_ANIMATIONS_PER_LAYER);
    if (!children.length) fail(`${path}.animations`, "a Composed group needs at least one member");
    animation.animations = children.map((child, index) => normalizeAnimation(child, `${path}.animations[${index}]`, ids, layer, depth + 1, offset + animation.start));
    return animation;
  }
  if (animation.animations !== undefined) fail(`${path}.animations`, "members require a Composed group");
  if (offset + Number(animation.start) + (Number(animation.duration) || 0) > MAX_TIME)
    fail(path, `absolute start plus duration cannot exceed ${MAX_TIME} seconds`);
  if (animation.behavior != null && !["in", "out", "custom", "effect"].includes(animation.kind))
    fail(`${path}.behavior`, "requires a timed in, out, custom or effect operation");
  if (isEffectAnimation(animation)) {
    if (layer.type === "audio") fail(path, "Effects need a layer that is drawn");
    try { return normalizeEffectAnimation(animation, { maxTime: MAX_TIME }); }
    catch (error) { fail(path, error.message); }
  }
  if (animation.effect !== undefined || animation.keepStill !== undefined)
    fail(path, "effect and keepStill fields require kind effect");
  if (!["in", "out", "custom"].includes(animation.kind)) {
    for (const field of ["preset", "discrete", "shadowChannels", "textAnchor", "textClip"])
      if (animation[field] != null) fail(`${path}.${field}`, "requires a timed in, out, or custom operation");
  }
  if (VISIBILITY_KINDS.includes(animation.kind)) {
    // Hide and Show are instant: a start time and nothing that describes a duration or values.
    animation.start = requireNumber(animation.start, `${path}.start`, 0, MAX_TIME);
    for (const field of TIMED_ANIMATION_FIELDS) {
      if (animation[field] !== undefined)
        fail(`${path}.${field}`, `a ${animation.kind} operation is instant and cannot have ${field}`);
    }
    return animation;
  }
  if (animation.kind === TEXT_CHANGE_KIND) {
    const normalized = normalizeTextChange(animation, path, layer);
    if (offset + normalized.start + textChangeEffectSeconds(normalized) > MAX_TIME)
      fail(path, `absolute start plus text effects cannot exceed ${MAX_TIME} seconds`);
    return normalized;
  }
  if (animation.kind === COUNTER_KIND) return normalizeCounter(animation, path, layer);
  if (!["in", "out", "custom"].includes(animation.kind))
    fail(`${path}.kind`, "must be in, out, custom, hide, or show (or change-text for a Change text, counter for a Counter)");
  animation.start = requireNumber(
    animation.start,
    `${path}.start`,
    0,
    MAX_TIME,
  );
  animation.duration = requireNumber(
    animation.duration,
    `${path}.duration`,
    0.001,
    MAX_TIME,
  );
  if (animation.start + animation.duration > MAX_TIME)
    fail(path, `start plus duration cannot exceed ${MAX_TIME} seconds`);
  animation.easing = normalizeEasing(animation.easing, `${path}.easing`);
  normalizeAnimationIntensity(animation, path);
  if (animation.keys == null) delete animation.keys;
  const keyList = animation.keys ? readAnimationKeys(animation, path) : null;
  const from = requireRecord(animation.from, `${path}.from`);
  const to = requireRecord(animation.to, `${path}.to`);
  // A behavior may name the keys it moves in its amount (behavior.js): they join from and to at
  // the layer's own value, so the layer wiggles (oscillates, ramps...) in place.
  const wiggled = behaviorKeys(animation.behavior);
  const propertyKeys = new Set([...Object.keys(from), ...Object.keys(to), ...wiggled]);
  if (propertyKeys.size === 0) fail(path, "must animate at least one property");
  const normalizedFrom = {};
  const normalizedTo = {};
  for (const key of propertyKeys) {
    if (!VALUE_KEYS.has(key))
      fail(path, `cannot animate unsupported property "${key}"${key === "scale" ? "; animate scaleX and scaleY" : ""}`);
    // A Speed animation starts from the clip's own speed (mediaSpeed, 1 when not set).
    // A Lowpass animation starts from the layer's cutoff, or fully open when it has none.
    const layerRest = key === "speed" ? layer.mediaSpeed ?? 1
      : key === "lowpass" ? (layer.lowpass > 0 ? Math.max(LOWPASS_MIN, layer.lowpass) : LOWPASS_OPEN)
        : effectiveBoxStyle(layer)[key];
    const rest = layerRest === undefined && BACKDROP_STYLE_KEYS.includes(key) ? defaultBackdropStyle(key)
      : layerRest === undefined && TILT_REST[key] !== undefined ? TILT_REST[key]
        : layerRest === undefined && Object.hasOwn(TRIM_REST, key) ? structuredClone(TRIM_REST[key])
          : layerRest === undefined && Object.hasOwn(REPEAT_REST, key) ? REPEAT_REST[key]
            : layerRest === undefined && Object.hasOwn(MODIFIER_REST, key) ? MODIFIER_REST[key] : layerRest;
    if ((key === "stroke" || key === "strokeWidth") && !STROKE_LAYER_TYPES.has(layer.type)) {
      fail(
        path,
        `the ${key} property requires a rectangle, ellipse, star, path, text, group, image, or video layer`,
      );
    }
    // A Color (fill) animation on a layer without a Fill (an image, video, audio or
    // component instance) is not refused here: older documents could hold one, and refusing it
    // would make the whole document impossible to open, edit, save or export. It draws nothing.
    // Legacy group Color animations stay invisible through the inactive fill migration flag.
    // apply_operations refuses new or changed ones (paints.js fillAnimationEditProblem), and
    // pasteAnimations refuses pasting one onto such a layer.
    if (TILT_REST[key] !== undefined && layer.type === "audio")
      fail(path, `a ${key} animation needs a layer that is drawn; audio layers have no tilt`);
    if (key === "shadow" && layer.type === "audio")
      fail(path, "a Shadow animation needs a layer that is drawn; audio layers have no shadow");
    if ((key === "reveal" || key === "effectPreset") && layer.type === "audio")
      fail(path, "a reveal animation needs a layer that is drawn; audio layers have no reveal");
    if (BACKDROP_STYLE_KEYS.includes(key) && layer.type === "audio")
      fail(path, `a ${key} animation needs a layer that is drawn; audio layers have no backdrop style`);
    if (key === "letterSpacing" && layer.type !== "text")
      fail(path, "a Letter spacing animation needs a text layer; only text has letter spacing");
    if (REPEAT_KEYS.includes(key) && !REPEAT_LAYER_TYPES.has(layer.type))
      fail(path, `a ${key} animation needs a rectangle, ellipse, star, path, text or group layer; a ${layer.type} layer has no repeater`);
    if (MODIFIER_KEYS.includes(key) && !MODIFIER_LAYER_TYPES.has(layer.type))
      fail(path, `a ${key} animation needs a rectangle, ellipse, star or path layer; a ${layer.type} layer has no outline`);
    if (key === "lineHeight" && layer.type !== "text")
      fail(path, "a Line height animation needs a text layer; only text has a line height");
    if (key === "axes" && layer.type !== "text")
      fail(path, "an axes animation needs a text layer; only text has font axes");
    if (key === "volume" && layer.type !== "video" && layer.type !== "audio")
      fail(path, `a Volume animation needs a video or audio layer; a ${layer.type} layer has no sound`);
    if (key === "lowpass" && layer.type !== "video" && layer.type !== "audio")
      fail(path, `a Lowpass animation needs a video or audio layer; a ${layer.type} layer has no sound`);
    if (key === "speed" && !MEDIA_TIMING_TYPES.mediaSpeed.includes(layer.type))
      fail(path, `a Speed animation needs a video, audio or GIF image layer; a ${layer.type} layer plays no file`);
    const requiredType = SHAPE_PROPERTY_TYPES[key];
    const retainedAfterConversion = layer.type === "path" && layer.convertedFrom === requiredType;
    const boxCorner = (key === "radius" || key === "cornerRadii") && CORNER_LAYER_TYPES.has(layer.type);
    if (requiredType && layer.type !== requiredType && !retainedAfterConversion && !boxCorner) {
      const article = requiredType === "ellipse" ? "an" : "a";
      fail(path, `the ${key} property requires ${article} ${requiredType} layer`);
    }
    const animationRest =
      key === "cornerRadii" && rest === null
        ? Array(4).fill(effectiveBoxStyle(layer).radius)
        : rest;
    // A Letter spacing or Line height animation's From (its "Initial value") is optional: left
    // out, the animation starts from the value the layer has when it starts (animation.js uses
    // the value the earlier operations leave), so it is not filled in with the design value here.
    if (Object.hasOwn(from, key) || !INITIAL_VALUE_KEYS.has(key))
      normalizedFrom[key] = validateAnimatedValue(
        key,
        Object.hasOwn(from, key) ? from[key] : animationRest,
        `${path}.from.${key}`,
      );
    normalizedTo[key] = validateAnimatedValue(
      key,
      Object.hasOwn(to, key) ? to[key] : animationRest,
      `${path}.to.${key}`,
    );
  }
  animation.from = normalizedFrom;
  animation.to = normalizedTo;
  if (keyList) {
    animation.keys = keyList.map((key, index) => ({ ...key, value: Object.fromEntries(Object.entries(key.value).map(([name, value]) =>
      [name, validateAnimatedValue(name, value, `${path}.keys[${index}].value.${name}`)])) }));
    if (Object.hasOwn(normalizedTo, "path")) {
      for (let index = 1; index < animation.keys.length; index++) {
        try { interpolatePath(animation.keys[index - 1].value.path, animation.keys[index].value.path, 0.5); }
        catch (error) { fail(`${path}.keys[${index}].value.path`, error.message); }
      }
    }
  }
  if (animation.behavior === undefined || animation.behavior === null) delete animation.behavior;
  else {
    try { animation.behavior = normalizeBehavior(animation.behavior, (key) => typeof normalizedTo[key] === "number", { duration: animation.duration }); }
    catch (error) { fail(`${path}.behavior`, error.message); }
    // The sound and clip clock read each animation once (mediaTime.js, audio mix): no repeats.
    const media = ["speed", "volume", "lowpass"].filter((key) => propertyKeys.has(key));
    if (media.length) fail(`${path}.behavior`, `can't loop or wiggle ${media.join(", ")}: give each change its own animation`);
    // One wiggle number is in each key's own units: 8 is fine for x and rotation, 800% for scale.
    const numeric = Object.keys(normalizedTo).filter((key) => typeof normalizedTo[key] === "number");
    const fractions = numeric.filter((key) => FRACTION_KEYS.has(key));
    for (const [kind, field] of [["wiggle", "amount"], ["oscillate", "amount"], ["randomize", "amount"], ["ramp", "to"]])
      if (typeof animation.behavior[kind]?.[field] === "number" && fractions.length && numeric.length > 1)
        fail(`${path}.behavior.${kind}.${field}`, `one number ${kind === "wiggle" ? "drifts" : "moves"} every key by the same size, but ${fractions.join(", ")} ${fractions.length > 1 ? "are fractions" : "is a fraction"}: give one per key, such as {x:8, ${fractions[0]}:0.05}`);
  }
  // fill: "both" holds From before the start, "forwards" keeps the layer's own values until then
  // (animation.js holdsFromBeforeStart; left out, a Move holds and other operations do not).
  if (animation.fill == null) delete animation.fill;
  else if (animation.fill !== "both" && animation.fill !== "forwards") fail(`${path}.fill`, 'must be "both" or "forwards"');
  // peak and return shape an effect's window (effects/animation.js); here they would do nothing.
  for (const key of ["peak", "return"]) if (animation[key] != null)
    fail(`${path}.${key}`, "works on an effect animation (effect: glow, zoom-blur, color-grade...); for a property that rises and falls, use keys or two animations");
  delete animation.peak;
  delete animation.return;
  if (animation.shadowChannels === undefined || animation.shadowChannels === null) delete animation.shadowChannels;
  else {
    if (!propertyKeys.has("shadow")) fail(`${path}.shadowChannels`, "requires a Shadow animation");
    try { animation.shadowChannels = normalizeShadowChannels(animation.shadowChannels); }
    catch (error) { fail(`${path}.shadowChannels`, error.message); }
  }
  if (animation.preset === undefined || animation.preset === null) delete animation.preset;
  else {
    try { animation.preset = normalizePreset(animation.preset); } catch (error) { fail(`${path}.preset`, error.message); }
    if (animation.kind !== animation.preset.mode) fail(`${path}.preset.mode`, "must match the operation kind");
    // A fade is the one preset a sound layer takes: a Volume fade (presetCatalog.js presetValues).
    if (layer.type === "audio" && animation.preset.id !== "fade") fail(`${path}.preset`, "presets need a layer that is drawn");
    if (animation.preset.text && layer.type !== "text") fail(`${path}.preset.text`, "requires a text layer");
  }
  if (animation.discrete === undefined || animation.discrete === null) delete animation.discrete;
  else {
    try { animation.discrete = normalizeDiscrete(animation.discrete, [...propertyKeys]); } catch (error) { fail(`${path}.discrete`, error.message); }
  }
  if (animation.motionPath === undefined || animation.motionPath === null) delete animation.motionPath;
  else {
    if (!isMoveAnimation(animation))
      fail(`${path}.motionPath`, "only a custom Move with x and/or y values can have a motion path");
    try { animation.motionPath = normalizeMotionPath(animation.motionPath); }
    catch (error) { fail(`${path}.motionPath`, error.message); }
  }
  // A Resize's anchor point (resizeAnchor.js): the point of the box that stays put while width
  // and height change. Left out (or null, which removes it), x and y stay put instead.
  if (animation.anchor === null || animation.anchor === undefined) delete animation.anchor;
  else {
    if (!propertyKeys.has("width") && !propertyKeys.has("height"))
      fail(`${path}.anchor`, "only a Resize (an animation of width or height) has an anchor point; a rotate, scale or skew turns about the layer's anchor: update_layer {anchor:[x, y]} (percent of its box)");
    if (!isResizeAnchor(animation.anchor))
      fail(`${path}.anchor`, `must be one of ${RESIZE_ANCHOR_LIST}`);
    if (["group", "audio", "component"].includes(layer.type))
      fail(`${path}.anchor`, resizeProblem(layer, animation));
  }
  if (Object.hasOwn(normalizedFrom, "path") || Object.hasOwn(normalizedTo, "path")) {
    if (layer.type !== "path") fail(path, "morph operations require a path layer");
    try { interpolatePath(normalizedFrom.path ?? layer.path, normalizedTo.path ?? layer.path, 0.5); }
    catch (error) { fail(path, error.message); }
  }
  animation.unit ??= "layer";
  if (!["layer", "letters", "words", "lines"].includes(animation.unit)) {
    fail(`${path}.unit`, "must be layer, letters, words, or lines");
  }
  animation.stagger =
    animation.stagger === undefined
      ? 0
      : requireNumber(animation.stagger, `${path}.stagger`, 0, 60);
  // Each unit's own delay after the start (textTiming.js unitDelay), in place of the stagger.
  if (animation.delays == null) delete animation.delays;
  else {
    if (animation.unit === "layer") fail(`${path}.delays`, "requires a unit of letters, words or lines");
    animation.delays = requireArray(animation.delays, `${path}.delays`, 2000).map((delay, index) => requireNumber(delay, `${path}.delays[${index}]`, 0, 60));
  }
  // Seeded per-unit offsets of the away end (textTiming.js scatteredAnimation).
  if (animation.scatter == null) delete animation.scatter;
  else {
    if (animation.unit === "layer") fail(`${path}.scatter`, "requires a unit of letters, words or lines");
    const scatter = animation.scatter;
    if (!scatter || typeof scatter !== "object" || Array.isArray(scatter)) fail(`${path}.scatter`, "must be {x?, y?, rotation?, scale?, seed?}");
    const most = { x: 10000, y: 10000, rotation: 720, scale: 4, seed: 1e6 };
    for (const key of Object.keys(scatter)) if (!Object.hasOwn(most, key)) fail(`${path}.scatter.${key}`, "is not x, y, rotation, scale or seed");
    animation.scatter = Object.fromEntries(Object.entries(scatter).map(([key, value]) => [key, requireNumber(value, `${path}.scatter.${key}`, 0, most[key])]));
  }
  // A range selector times each unit in place of the stagger (textTiming.js textRangeProgress).
  if (animation.range == null) delete animation.range;
  else {
    if (animation.unit === "layer") fail(`${path}.range`, "requires a unit of letters, words or lines");
    if (animation.delays) fail(`${path}.range`, "and delays both time the units: use one");
    try { animation.range = normalizeTextRange(animation.range, animation.kind); }
    catch (error) { fail(`${path}.range`, error.message); }
  }
  animation.order ??= "forward";
  if (!TEXT_UNIT_ORDERS.includes(animation.order))
    fail(`${path}.order`, `must be ${TEXT_UNIT_ORDERS.join(", ")}`);
  normalizeOrderSeed(animation, path);
  normalizeTextSmoothing(animation, path);
  if (animation.textAnchor == null) delete animation.textAnchor;
  else {
    if (layer.type !== "text") fail(`${path}.textAnchor`, "requires a text layer");
    if (!["layer", "letters", "words", "lines"].includes(animation.textAnchor))
      fail(`${path}.textAnchor`, "must be layer, letters, words, or lines");
  }
  if (animation.textClip == null) delete animation.textClip;
  else {
    if (layer.type !== "text") fail(`${path}.textClip`, "requires a text layer");
    animation.textClip = requireBoolean(animation.textClip, `${path}.textClip`);
  }
  return animation;
}

// A random order's seed (textTiming.js unitDelay): a whole number, only with order random.
function normalizeOrderSeed(animation, path) {
  if (animation.orderSeed == null) { delete animation.orderSeed; return; }
  if (animation.order !== "random") fail(`${path}.orderSeed`, "only seeds order random");
  animation.orderSeed = requireNumber(animation.orderSeed, `${path}.orderSeed`, 0, 4294967295);
  if (!Number.isInteger(animation.orderSeed)) fail(`${path}.orderSeed`, "must be a whole number");
}

// One text effect of a Change text (textChange.js): null for none, or { preset, duration,
// easing, unit, stagger, order, distance? }. Left-out settings get those of a new preset
// animation (0.6 s, smooth, the whole layer, no stagger, forward), so { "preset": "fade-in" } is
// a complete effect. Only a Slide has a distance (pixels; 80 when left out).
function normalizeTextEffect(raw, path, side) {
  if (raw === null || raw === undefined) return null;
  requireRecord(raw, path);
  for (const key of Object.keys(raw)) {
    if (!TEXT_EFFECT_FIELDS.includes(key))
      fail(`${path}.${key}`, `is not a text effect setting; use ${TEXT_EFFECT_FIELDS.join(", ")}`);
  }
  const presets = textEffectPresets(side);
  if (!presets.includes(raw.preset))
    fail(`${path}.preset`, `must be one of ${presets.join(", ")} (or set ${side} to null for no effect)`);
  const effect = {
    preset: raw.preset,
    duration: requireNumber(raw.duration ?? DEFAULT_TEXT_EFFECT_SECONDS, `${path}.duration`, 0.001, MAX_TIME),
    easing: normalizeEasing(raw.easing ?? textEffectEasing(side), `${path}.easing`),
    unit: raw.unit ?? "layer",
    stagger: requireNumber(raw.stagger ?? 0, `${path}.stagger`, 0, MAX_TEXT_EFFECT_STAGGER),
    order: raw.order ?? "forward",
  };
  if (raw.orderSeed != null) effect.orderSeed = raw.orderSeed;
  if (raw.intensity !== undefined) {
    effect.intensity = raw.intensity;
    normalizeAnimationIntensity(effect, path);
  }
  if (raw.smoothing !== undefined) effect.smoothing = raw.smoothing;
  if (raw.smoothingIntensity !== undefined) effect.smoothingIntensity = raw.smoothingIntensity;
  normalizeTextSmoothing(effect, path);
  if (!TEXT_EFFECT_UNITS.includes(effect.unit)) fail(`${path}.unit`, "must be layer, letters, words, or lines");
  if (!TEXT_EFFECT_ORDERS.includes(effect.order)) fail(`${path}.order`, `must be ${TEXT_EFFECT_ORDERS.join(", ")}`);
  normalizeOrderSeed(effect, path);
  // A range selector times each unit in place of the stagger, as on an in or out (textTiming.js).
  if (raw.range != null) {
    if (effect.unit === "layer") fail(`${path}.range`, "requires a unit of letters, words or lines");
    try { effect.range = normalizeTextRange(raw.range, "in"); }
    catch (error) { fail(`${path}.range`, error.message); }
  }
  if (isSlideEffect(effect.preset))
    effect.distance = requireNumber(raw.distance ?? DEFAULT_SLIDE_DISTANCE, `${path}.distance`, 0, MAX_SLIDE_DISTANCE);
  else if (raw.distance !== undefined) fail(`${path}.distance`, "only a Slide effect has a distance");
  return effect;
}

// A Change text (textChange.js): a start time, the new string (with the same limit as a text
// layer's own text), whether the Out and In effects overlap, and the two effects.
function normalizeTextChange(animation, path, layer) {
  if (layer.type !== "text") fail(path, "a Change text operation needs a text layer; only text has a string to change");
  for (const field of TEXT_CHANGE_FORBIDDEN_FIELDS) {
    if (animation[field] !== undefined)
      fail(`${path}.${field}`, `a Change text operation cannot have ${field}; its out and in effects have their own timing`);
  }
  animation.start = requireNumber(animation.start, `${path}.start`, 0, MAX_TIME);
  animation.text = requireString(animation.text, `${path}.text`, MAX_STRING_LENGTH);
  animation.overlap = animation.overlap === undefined ? false : requireBoolean(animation.overlap, `${path}.overlap`);
  animation.out = normalizeTextEffect(animation.out, `${path}.out`, "out");
  animation.in = normalizeTextEffect(animation.in, `${path}.in`, "in");
  if (animation.start + textChangeEffectSeconds(animation) > MAX_TIME)
    fail(path, `start plus the out and in effect durations cannot exceed ${MAX_TIME} seconds`);
  return animation;
}

// A Counter (counter.js): a start, duration and easing like a timed animation, the From, To and
// Step numbers, and the Out and In effects of each step. A text that has no number (any more) is
// not refused here, so the document still opens; it counts in the plain number format, and
// apply_operations refuses adding a Counter to such a text (counter.js counterEditProblem).
function normalizeCounter(animation, path, layer) {
  if (layer.type !== "text") fail(path, "a Counter needs a text layer; only text has a number to count");
  for (const field of COUNTER_FORBIDDEN_FIELDS) {
    if (animation[field] !== undefined)
      fail(`${path}.${field}`, `a Counter cannot have ${field}; its out and in effects have their own units and stagger`);
  }
  animation.start = requireNumber(animation.start, `${path}.start`, 0, MAX_TIME);
  animation.duration = requireNumber(animation.duration, `${path}.duration`, 0.001, MAX_TIME);
  if (animation.start + animation.duration > MAX_TIME)
    fail(path, `start plus duration cannot exceed ${MAX_TIME} seconds`);
  animation.easing = normalizeEasing(animation.easing, `${path}.easing`);
  normalizeAnimationIntensity(animation, path);
  animation.step = animation.step ?? 1;
  for (const field of ["from", "to", "step"]) {
    if (typeof animation[field] !== "number" || !Number.isFinite(animation[field])) fail(`${path}.${field}`, "must be a number");
  }
  const problem = counterValueProblem(animation);
  if (problem) fail(path, problem);
  animation.out = normalizeTextEffect(animation.out, `${path}.out`, "out");
  animation.in = normalizeTextEffect(animation.in, `${path}.in`, "in");
  return animation;
}

const TIMING_TYPE_NAMES = { video: "video", audio: "audio", image: "GIF image" };

/**
 * Clip speed and time remapping (mediaTime.js): mediaSpeed, mediaReverse, mediaFrameRate,
 * mediaInterpolation and mediaPitch. All are optional; null removes one, and a layer without
 * them plays its file at speed 1, forwards, showing every frame.
 */
function normalizeMediaTiming(layer, path) {
  for (const [key, types] of Object.entries(MEDIA_TIMING_TYPES)) {
    if (layer[key] === null) delete layer[key];
    if (layer[key] === undefined) continue;
    if (!types.includes(layer.type))
      fail(`${path}.${key}`, `needs a ${types.map((type) => TIMING_TYPE_NAMES[type]).join(" or ")} layer; a ${layer.type} layer has none`);
  }
  if (layer.mediaSpeed !== undefined)
    layer.mediaSpeed = requireNumber(layer.mediaSpeed, `${path}.mediaSpeed`, MIN_MEDIA_SPEED, MAX_MEDIA_SPEED);
  if (layer.mediaFrameRate !== undefined)
    layer.mediaFrameRate = requireNumber(layer.mediaFrameRate, `${path}.mediaFrameRate`, MIN_MEDIA_FRAME_RATE, MAX_MEDIA_FRAME_RATE);
  // frameRate ("on twos"): the layer, or a group with everything in it, is drawn at this many
  // pictures a second, motion and effects alike (render.js steppedContext). null removes it.
  if (layer.frameRate === null) delete layer.frameRate;
  if (layer.frameRate !== undefined) {
    if (layer.type === "audio") fail(`${path}.frameRate`, "needs a layer that is drawn; a sound has no pictures");
    layer.frameRate = requireNumber(layer.frameRate, `${path}.frameRate`, 1, 120);
  }
  if (layer.mediaInterpolation !== undefined && !MEDIA_INTERPOLATIONS.includes(layer.mediaInterpolation))
    fail(`${path}.mediaInterpolation`, `must be ${MEDIA_INTERPOLATIONS.join(", ")}`);
  if (layer.mediaPitch !== undefined && !MEDIA_PITCHES.includes(layer.mediaPitch))
    fail(`${path}.mediaPitch`, `must be ${MEDIA_PITCHES.join(" or ")}`);
  if (layer.mediaReverse !== undefined) {
    requireBoolean(layer.mediaReverse, `${path}.mediaReverse`);
    // Backwards needs an end to start from: a Play duration, or the file's length.
    if (layer.mediaReverse && !(layer.mediaDuration > 0) && !(layer.type !== "image" && layer.mediaSourceDuration > 0))
      fail(`${path}.mediaReverse`, layer.type === "image"
        ? "needs a Play range: give the GIF a mediaDuration first"
        : "needs a known end: set mediaDuration, or mediaSourceDuration (the length importing the file answered)");
  }
}

function normalizeLayer(raw, path, animationIds, counters) {
  requireRecord(raw, path);
  const type = raw.type;
  if (!LAYER_TYPES.has(type))
    fail(`${path}.type`, `unsupported layer type "${String(type)}"`);
  const layer = { ...layerDefaults(type, raw.id ?? null), ...raw, type };
  delete layer._textClips;
  if (raw.inactiveBoxStyles !== undefined) {
    const styles = requireArray(raw.inactiveBoxStyles, `${path}.inactiveBoxStyles`, 3);
    const allowed = legacyBoxStyles(type);
    if (styles.some((style) => !allowed.includes(style)) || new Set(styles).size !== styles.length)
      fail(`${path}.inactiveBoxStyles`, "must list distinct previously unused fill, stroke, or corners styles for this layer type");
    if (!styles.length) delete layer.inactiveBoxStyles;
  }
  if (raw.legacyStyleOverrides !== undefined && (type !== "component" || raw.legacyStyleOverrides !== true))
    fail(`${path}.legacyStyleOverrides`, "is only a migration marker on component instances");
  // Older documents always showed a video's first frame before Play and held its last frame after.
  if (raw.mediaFreeze === undefined) layer.mediaFreeze = type === "video" ? "both" : "none";
  layer.id = requireId(layer.id, `${path}.id`);
  if (counters.layerIds.has(layer.id))
    fail(`${path}.id`, `duplicate layer ID "${layer.id}"`);
  counters.layerIds.add(layer.id);
  counters.layers += 1;
  if (counters.layers > MAX_LAYERS_TOTAL)
    fail(path, `document cannot contain more than ${MAX_LAYERS_TOTAL} layers`);

  layer.name = requireString(layer.name, `${path}.name`, 256);
  if (layer.parentId !== null)
    layer.parentId = requireId(layer.parentId, `${path}.parentId`);
  layer.x = requireNumber(
    layer.x,
    `${path}.x`,
    -MAX_COORDINATE,
    MAX_COORDINATE,
  );
  layer.y = requireNumber(
    layer.y,
    `${path}.y`,
    -MAX_COORDINATE,
    MAX_COORDINATE,
  );
  layer.width = requireNumber(
    layer.width,
    `${path}.width`,
    0.001,
    MAX_DIMENSION,
  );
  layer.height = requireNumber(
    layer.height,
    `${path}.height`,
    0.001,
    MAX_DIMENSION,
  );
  layer.rotation = requireNumber(
    layer.rotation,
    `${path}.rotation`,
    -360_000,
    360_000,
  );
  layer.scaleX = requireNumber(layer.scaleX, `${path}.scaleX`, -1_000, 1_000);
  layer.scaleY = requireNumber(layer.scaleY, `${path}.scaleY`, -1_000, 1_000);
  layer.skewX = requireNumber(layer.skewX, `${path}.skewX`, -89.999, 89.999);
  // Optional skewY (absent is 0) and anchor [x%, y%]: the pivot of rotation, scale and skew
  // (geometry.js pivotOf; absent is the center). null removes either.
  if (layer.skewY === null || layer.skewY === 0) delete layer.skewY;
  if (layer.skewY !== undefined) layer.skewY = requireNumber(layer.skewY, `${path}.skewY`, -89.999, 89.999);
  if (layer.anchor === null) delete layer.anchor;
  if (layer.anchor !== undefined) layer.anchor = readLayerAnchor(layer.anchor, `${path}.anchor`);
  // 2.5D tilt (tilt.js): optional; null removes it.
  for (const key of ["rotateX", "rotateY", "perspective"]) {
    if (layer[key] === null) delete layer[key];
    if (layer[key] === undefined) continue;
    if (layer.type === "audio") fail(`${path}.${key}`, "needs a layer that is drawn; audio layers have no tilt");
    layer[key] = key === "perspective" ? requirePerspective(layer[key], `${path}.${key}`) : requireTilt(layer[key], `${path}.${key}`);
  }
  layer.opacity = requireNumber(layer.opacity, `${path}.opacity`, 0, 1);
  layer.fill = normalizeFill(layer.fill, `${path}.fill`);
  layer.fillEnabled = requireBoolean(layer.fillEnabled, `${path}.fillEnabled`);
  layer.stroke = normalizeFill(layer.stroke, `${path}.stroke`);
  layer.strokeWidth = requireNumber(
    layer.strokeWidth,
    `${path}.strokeWidth`,
    0,
    10_000,
  );
  if (!STROKE_ALIGNMENTS.has(layer.strokeAlign)) {
    fail(`${path}.strokeAlign`, "must be center, inside, or outside");
  }
  layer.radius = requireNumber(
    layer.radius,
    `${path}.radius`,
    0,
    MAX_DIMENSION,
  );
  if (layer.cornerRadii !== null) {
    const radii = requireArray(layer.cornerRadii, `${path}.cornerRadii`, 4);
    if (radii.length !== 4)
      fail(`${path}.cornerRadii`, "must be null or contain four corner radii");
    layer.cornerRadii = radii.map((radius, index) =>
      requireNumber(
        radius,
        `${path}.cornerRadii[${index}]`,
        0,
        MAX_DIMENSION,
      ),
    );
  }
  for (const key of TRIM_KEYS) {
    if (layer[key] == null) { delete layer[key]; continue; }
    if (!TRIM_LAYER_TYPES.has(type)) fail(`${path}.${key}`, "only rectangle, ellipse, star and path layers have trim paths and dashes");
    layer[key] = normalizeTrimValue(key, layer[key], `${path}.${key}`);
  }
  for (const key of REPEAT_KEYS) {
    if (layer[key] == null) { delete layer[key]; continue; }
    if (!REPEAT_LAYER_TYPES.has(type)) fail(`${path}.${key}`, "only rectangle, ellipse, star, path, text and group layers have a repeater");
    layer[key] = requireNumber(layer[key], `${path}.${key}`, ...repeatRange(key));
  }
  for (const key of [...MODIFIER_KEYS, ...MODIFIER_CHOICE_KEYS]) {
    if (layer[key] == null) { delete layer[key]; continue; }
    if (!MODIFIER_LAYER_TYPES.has(type)) fail(`${path}.${key}`, "only rectangle, ellipse, star and path layers have shape modifiers (zig zag, offset, twist, bloat, round corners)");
    if (MODIFIER_CHOICES[key]) {
      if (!MODIFIER_CHOICES[key].includes(layer[key])) fail(`${path}.${key}`, `must be ${MODIFIER_CHOICES[key].map((choice) => `"${choice}"`).join(" or ")}`);
    } else layer[key] = requireNumber(layer[key], `${path}.${key}`, ...modifierRange(key));
  }
  layer.donut = requireNumber(layer.donut, `${path}.donut`, 0, 1);
  layer.sweep = requireNumber(layer.sweep, `${path}.sweep`, 0, 1);
  layer.startAngle = requireNumber(
    layer.startAngle,
    `${path}.startAngle`,
    -360_000,
    360_000,
  );
  layer.spikes = requireInteger(layer.spikes, `${path}.spikes`, 0, 1_000);
  layer.starThickness = requireNumber(
    layer.starThickness,
    `${path}.starThickness`,
    0,
    1,
  );
  layer.visible = requireBoolean(layer.visible, `${path}.visible`);
  layer.locked = requireBoolean(layer.locked, `${path}.locked`);
  layer.lockAspect = requireBoolean(layer.lockAspect, `${path}.lockAspect`);
  layer.blur = requireNumber(layer.blur, `${path}.blur`, 0, 1_000);
  for (const styleKey of BACKDROP_STYLE_KEYS) {
    if (layer[styleKey] == null) {
      delete layer[styleKey];
      continue;
    }
    if (type === "audio") fail(`${path}.${styleKey}`, "audio layers cannot have backdrop styles");
    layer[styleKey] = normalizeBackdropStyle(styleKey, layer[styleKey], `${path}.${styleKey}`);
  }
  if (
    typeof layer.blendMode !== "string" ||
    !/^[a-z-]{1,64}$/.test(layer.blendMode)
  ) {
    fail(`${path}.blendMode`, "must be a simple blend-mode name");
  }
  layer.isMask = requireBoolean(layer.isMask, `${path}.isMask`);
  // A mask group's bottom-most mask hides its other layers outside the mask's shape.
  layer.isMaskGroup = requireBoolean(layer.isMaskGroup, `${path}.isMaskGroup`);
  if (layer.isMaskGroup && type !== "group") fail(`${path}.isMaskGroup`, "only a group can be a mask group");
  // A mask's invert and mode (maskVisibility.js maskStyle); absent is a plain luminance mask.
  if (layer.maskInvert == null) delete layer.maskInvert;
  else layer.maskInvert = requireBoolean(layer.maskInvert, `${path}.maskInvert`);
  if (layer.maskMode == null) delete layer.maskMode;
  else if (!MASK_MODES.includes(layer.maskMode)) fail(`${path}.maskMode`, `must be ${MASK_MODES.map((mode) => `"${mode}"`).join(" or ")}`);
  layer.clipContent = requireBoolean(layer.clipContent, `${path}.clipContent`);
  // A root layer drawn above the scene's letterbox bars (sceneFinish.js); absent is below them.
  if (layer.aboveLetterbox == null) delete layer.aboveLetterbox;
  else layer.aboveLetterbox = requireBoolean(layer.aboveLetterbox, `${path}.aboveLetterbox`);
  normalizeQualityLayerFields(layer, path);
  normalizeBlockLayerFields(layer, path);
  // Subject boxes an agent marked on a video's source frame (mark_subject, sourceView.js).
  // A layer that follows a track (the pin op, pin.js).
  if (layer.pin == null) delete layer.pin;
  else layer.pin = normalizePin(layer.pin, `${path}.pin`);
  if (layer.subjectBoxes == null) delete layer.subjectBoxes;
  else layer.subjectBoxes = normalizeSubjectBoxes(layer.subjectBoxes, `${path}.subjectBoxes`, type);
  // The frames the agent says show what the person asked for (mark_subject {shows}), apart from the subject.
  if (layer.askShows == null) delete layer.askShows;
  else layer.askShows = normalizeAskShows(layer.askShows, `${path}.askShows`, type);
  // A screen recording's pointer, clicks and keys (engine/recording.js), kept by the service
  // when the layer plays a recording kino made.
  if (layer.recording == null) delete layer.recording;
  else if (type !== "video") fail(`${path}.recording`, "only a video layer keeps a screen recording");
  else layer.recording = normalizeRecording(layer.recording, `${path}.recording`);
  if (!Array.isArray(layer.playbackWindows) || layer.playbackWindows.length > 32)
    fail(`${path}.playbackWindows`, "must be an array of at most 32 playback windows");
  layer.playbackWindows = layer.playbackWindows.map((window, index) => {
    const label = `${path}.playbackWindows[${index}]`;
    requireRecord(window, label);
    const start = requireNumber(window.start, `${label}.start`, 0, MAX_TIME * 32);
    const end = requireNumber(window.end, `${label}.end`, start, MAX_TIME * 32);
    if (!["during", "before", "after", "both"].includes(window.visibility)) fail(`${label}.visibility`, "must be a component visibility mode");
    return { start, end, visibility: window.visibility, hold: requireBoolean(window.hold, `${label}.hold`) };
  });
  if (type === "component") {
    layer.componentSceneId = requireId(layer.componentSceneId, `${path}.componentSceneId`);
    layer.componentStart = requireNumber(layer.componentStart, `${path}.componentStart`, 0, MAX_TIME);
    layer.componentBackgroundEnabled = requireBoolean(layer.componentBackgroundEnabled, `${path}.componentBackgroundEnabled`);
    if (!["during", "before", "after", "both"].includes(layer.componentVisibility)) fail(`${path}.componentVisibility`, "must be a component visibility mode");
  } else if (Object.hasOwn(layer, "componentBackgroundEnabled")) {
    fail(`${path}.componentBackgroundEnabled`, "only a component instance can switch its source background off");
  }
  // An instance's overrides are checked once every scene is read (validateComponents), because
  // they name layers of other scenes. Only instances can have them.
  if (Object.hasOwn(layer, "componentOverrides")) {
    if (layer.componentOverrides === undefined) delete layer.componentOverrides;
    else if (type !== "component")
      fail(`${path}.componentOverrides`, "only a component instance can override layers of its main component");
  }
  if (layer.shadow !== null) layer.shadow = normalizeShadow(layer.shadow, `${path}.shadow`);
  // Stacked shadows (stackedShadows.js): optional, left out when empty.
  if (layer.shadows == null) delete layer.shadows;
  else if (type === "audio") fail(`${path}.shadows`, "audio layers are not drawn, so they have no shadows");
  else {
    layer.shadows = normalizeShadowList(layer.shadows, `${path}.shadows`);
    if (!layer.shadows) delete layer.shadows;
  }
  // Stacked strokes (stackedStrokes.js): optional, left out when empty.
  if (layer.strokes == null) delete layer.strokes;
  else if (!STACKED_STROKE_TYPES.has(type)) fail(`${path}.strokes`, "only text, rectangle, ellipse, star and path layers take a strokes list");
  else {
    layer.strokes = normalizeStrokeList(layer.strokes, `${path}.strokes`);
    if (!layer.strokes) delete layer.strokes;
  }
  layer.text = requireString(layer.text, `${path}.text`, MAX_STRING_LENGTH);
  if (layer.textStyleRanges !== undefined) {
    if (type !== "text") fail(`${path}.textStyleRanges`, "only text layers can have style ranges");
    layer.textStyleRanges = normalizeTextStyleRanges(layer.text, layer.textStyleRanges, `${path}.textStyleRanges`);
  } else delete layer.textStyleRanges;
  layer.fontFamily = requireString(layer.fontFamily, `${path}.fontFamily`, 256);
  layer.fontSource = requireString(layer.fontSource, `${path}.fontSource`, 512);
  if (
    layer.fontSource &&
    (!FONT_SOURCE_PATTERN.test(layer.fontSource) || layer.fontSource.includes(".."))
  ) {
    fail(
      `${path}.fontSource`,
      "must be empty or a safe local font URL under /api/media or /api/fonts",
    );
  }
  layer.fontSize = requireNumber(
    layer.fontSize,
    `${path}.fontSize`,
    0.1,
    10_000,
  );
  layer.fontWeight = requireNumber(
    layer.fontWeight,
    `${path}.fontWeight`,
    1,
    1_000,
  );
  if (!["normal", "italic"].includes(layer.fontStyle))
    fail(`${path}.fontStyle`, "must be normal or italic");
  // A multiple of the font size (lineHeight.js).
  layer.lineHeight = requireNumber(
    layer.lineHeight,
    `${path}.lineHeight`,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_MAX,
  );
  // Percent of the font size (letterSpacing.js); version 1 saved pixels (documentMigration.js).
  layer.letterSpacing = requireNumber(
    layer.letterSpacing,
    `${path}.letterSpacing`,
    -LETTER_SPACING_LIMIT,
    LETTER_SPACING_LIMIT,
  );
  if (!["left", "center", "right"].includes(layer.textAlign))
    fail(`${path}.textAlign`, "must be left, center, or right");
  if (!["top", "middle", "bottom"].includes(layer.verticalAlign))
    fail(`${path}.verticalAlign`, "must be top, middle, or bottom");
  if (!["fixed", "height", "width-height"].includes(layer.textResize))
    fail(`${path}.textResize`, "must be fixed, height, or width-height");
  if (!["normal", "upper", "lower"].includes(layer.textCase))
    fail(`${path}.textCase`, "must be normal, upper, or lower");
  layer.kerning = requireBoolean(layer.kerning, `${path}.kerning`);
  layer.ligatures = requireBoolean(layer.ligatures, `${path}.ligatures`);
  // Optional: digits all one width (OpenType tnum), for a number that counts (count-up).
  if (layer.tabularNumbers !== undefined) layer.tabularNumbers = requireBoolean(layer.tabularNumbers, `${path}.tabularNumbers`);
  // Optional per-unit loop between the in and out animations (textLoop.js); null clears it.
  if (layer.textLoop == null) delete layer.textLoop;
  else if (type !== "text") fail(`${path}.textLoop`, "only text layers loop their letters, words or lines");
  else {
    try { layer.textLoop = normalizeTextLoop(layer.textLoop); }
    catch (error) { const [, key = "", why] = /^(\.\w+)? ?(.*)$/.exec(error.message); fail(`${path}.textLoop${key}`, why); }
  }
  // Optional fixed per-letter tilt and lift (letterJitter.js); null clears it.
  if (layer.jitter == null || layer.jitter === false) delete layer.jitter;
  else if (type !== "text") fail(`${path}.jitter`, "only text layers jitter their letters");
  else {
    try { layer.jitter = normalizeLetterJitter(layer.jitter); }
    catch (error) { const [, key = "", why] = /^(\.\w+)? ?(.*)$/.exec(error.message); fail(`${path}.jitter${key}`, why); }
  }
  // Optional variable font axes {wght, wdth, slnt, opsz} (fontAxes.js); null clears them.
  if (layer.axes === null) delete layer.axes;
  else if (layer.axes !== undefined) {
    if (type !== "text") fail(`${path}.axes`, "only text layers have font axes");
    layer.axes = normalizeAxes(layer.axes, `${path}.axes`);
  }
  layer.path = requireString(layer.path, `${path}.path`, MAX_STRING_LENGTH);
  if (layer.convertedFrom !== undefined) {
    if (type !== "path" || !["rectangle", "ellipse", "star"].includes(layer.convertedFrom)) {
      fail(`${path}.convertedFrom`, "must identify a rectangle, ellipse, or star converted to a path");
    }
  }
  if (type === "path") {
    try { parsePath(layer.path); } catch (error) { fail(`${path}.path`, error.message); }
    if (!PATH_FILL_RULES.has(layer.fillRule))
      fail(`${path}.fillRule`, "must be nonzero or evenodd");
  } else if (Object.hasOwn(raw, "fillRule")) {
    fail(`${path}.fillRule`, "only a path layer can have a fill rule");
  }
  layer.src = requireString(layer.src, `${path}.src`, MAX_STRING_LENGTH);
  if (/^\s*(?:javascript|vbscript):/i.test(layer.src))
    fail(`${path}.src`, "script URLs are not allowed");
  layer.mediaStart = requireNumber(
    layer.mediaStart,
    `${path}.mediaStart`,
    0,
    MAX_TIME,
  );
  layer.mediaDuration = requireNumber(
    layer.mediaDuration,
    `${path}.mediaDuration`,
    0,
    MAX_TIME,
  );
  layer.mediaOffset = requireNumber(
    layer.mediaOffset,
    `${path}.mediaOffset`,
    0,
    MAX_MEDIA_SECONDS,
  );
  layer.mediaSourceDuration = requireNumber(
    layer.mediaSourceDuration,
    `${path}.mediaSourceDuration`,
    0,
    MAX_MEDIA_SECONDS,
  );
  if (!MEDIA_FREEZE.has(layer.mediaFreeze))
    fail(`${path}.mediaFreeze`, "must be none, first, last, or both");
  layer.volume = requireNumber(layer.volume, `${path}.volume`, 0, MAX_VOLUME);
  // Voice cleanup on export (backend/voice-chain.mjs): optional, false turns it off, null removes it.
  if (layer.voiceCleanup === null) delete layer.voiceCleanup;
  if (layer.voiceCleanup !== undefined) {
    if (layer.type !== "video" && layer.type !== "audio")
      fail(`${path}.voiceCleanup`, `needs a video or audio layer; a ${layer.type} layer has no sound`);
    requireBoolean(layer.voiceCleanup, `${path}.voiceCleanup`);
  }
  // Low-pass cutoff in Hz (lowpass.js): optional, 0 is off, null removes it.
  if (layer.lowpass === null) delete layer.lowpass;
  if (layer.lowpass !== undefined) {
    if (layer.type !== "video" && layer.type !== "audio")
      fail(`${path}.lowpass`, `needs a video or audio layer; a ${layer.type} layer has no sound`);
    layer.lowpass = requireNumber(layer.lowpass, `${path}.lowpass`, 0, LOWPASS_OPEN);
    if (layer.lowpass > 0 && layer.lowpass < LOWPASS_MIN)
      fail(`${path}.lowpass`, `must be 0 (off) or from ${LOWPASS_MIN} to ${LOWPASS_OPEN} Hz`);
  }
  // Morph cut into this speech piece, in seconds (morphCut.js): optional, 0 is off, null removes it.
  if (layer.morphIn === null) delete layer.morphIn;
  if (layer.morphIn !== undefined) {
    if (layer.type !== "video") fail(`${path}.morphIn`, `needs a video layer (a piece of a cut speech video); a ${layer.type} layer has no picture to morph`);
    layer.morphIn = requireNumber(layer.morphIn, `${path}.morphIn`, 0, MORPH_MAX);
    if (layer.morphIn > 0 && layer.morphIn < MORPH_MIN) fail(`${path}.morphIn`, `must be 0 (off) or from ${MORPH_MIN} to ${MORPH_MAX} seconds`);
  }
  normalizeMediaTiming(layer, path);
  // Log footage converted to Rec.709 (footageLog.js); absent or null is the picture as decoded.
  if (layer.log == null) delete layer.log;
  else if (layer.type !== "video") fail(`${path}.log`, `needs a video layer; a ${layer.type} layer has none`);
  else if (!LOG_PROFILES.includes(layer.log)) fail(`${path}.log`, `must be ${LOG_PROFILES.map((name) => `"${name}"`).join(" or ")}, or null for none`);
  const animations = requireArray(
    layer.animations,
    `${path}.animations`,
    MAX_ANIMATIONS_PER_LAYER,
  );
  counters.animations += animations.length;
  if (counters.animations > MAX_ANIMATIONS_TOTAL)
    fail(
      path,
      `document cannot contain more than ${MAX_ANIMATIONS_TOTAL} animations`,
    );
  const beforeAnimationIds = animationIds.size;
  layer.animations = animations.map((animation, index) =>
    normalizeAnimation(
      animation,
      `${path}.animations[${index}]`,
      animationIds,
      layer,
    ),
  );
  if (animationIds.size - beforeAnimationIds > MAX_ANIMATIONS_PER_LAYER)
    fail(`${path}.animations`, `cannot contain more than ${MAX_ANIMATIONS_PER_LAYER} operations including group members`);
  // An explicit Morph may start with a different topology from the design path. Automatic
  // starts instead inherit the preceding enabled path, so validate that topology too. Each
  // earlier operation already has matching From/To contours; their exact progress cannot
  // change topology, and start/list order determines which one supplies the inherited path.
  if (layer.type === "path") {
    let currentPath = layer.path;
    const ordered = flattenAnimations(layer.animations).map((animation, index) => ({ animation, index }))
      .sort((a, b) => a.animation.start - b.animation.start || a.index - b.index);
    for (const { animation } of ordered) {
      if (!Object.hasOwn(animation.to ?? {}, "path")) continue;
      if (animation.fromCurrent === true) {
        try { interpolatePath(currentPath, animation.to.path, 0.5); }
        catch (error) { fail(`${path}.animations.${animation.id}.fromCurrent`, `current path cannot morph to this endpoint: ${error.message}`); }
      }
      if (animation.enabled !== false) currentPath = animation.to.path;
    }
  }
  return layer;
}

function validateParents(layers, path) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  for (const layer of layers) {
    if (layer.parentId === null) continue;
    const parent = byId.get(layer.parentId);
    if (!parent)
      fail(
        `${path}.layers.${layer.id}.parentId`,
        `references missing layer "${layer.parentId}"`,
      );
    if (parent.type !== "group")
      fail(
        `${path}.layers.${layer.id}.parentId`,
        "must reference a group layer",
      );
  }
  const visited = new Set();
  for (const layer of layers) {
    let current = layer;
    const chain = new Set();
    while (current && current.parentId !== null) {
      if (chain.has(current.id))
        fail(
          `${path}.layers.${layer.id}.parentId`,
          "group hierarchy contains a cycle",
        );
      if (visited.has(current.id)) break;
      chain.add(current.id);
      current = byId.get(current.parentId);
    }
    for (const id of chain) visited.add(id);
  }
}

function normalizeScene(raw, index, counters) {
  const path = `document.scenes[${index}]`;
  requireRecord(raw, path);
  const scene = {
    id: raw.id,
    name: `Scene ${index + 1}`,
    width: 640,
    height: 360,
    duration: 4,
    background: "#ffffff",
    backgroundEnabled: true,
    backgroundAnimations: [],
    isComponent: false,
    aspectLocked: false,
    layers: [],
    ...raw,
  };
  scene.id = requireId(scene.id, `${path}.id`);
  if (Object.prototype.hasOwnProperty.call(raw, "bulkVariant"))
    scene.bulkVariant = normalizeBulkVariant(raw.bulkVariant, `${path}.bulkVariant`);
  if (counters.sceneIds.has(scene.id))
    fail(`${path}.id`, `duplicate scene ID "${scene.id}"`);
  counters.sceneIds.add(scene.id);
  scene.name = requireString(scene.name, `${path}.name`, 256);
  scene.aspectLocked = requireBoolean(scene.aspectLocked, `${path}.aspectLocked`);
  for (const key of ["canvasX", "canvasY"]) if (Object.hasOwn(raw, key))
    scene[key] = requireNumber(raw[key], `${path}.${key}`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE);
  scene.width = requireNumber(scene.width, `${path}.width`, 1, MAX_DIMENSION);
  scene.height = requireNumber(
    scene.height,
    `${path}.height`,
    1,
    MAX_DIMENSION,
  );
  scene.duration = requireNumber(
    scene.duration,
    `${path}.duration`,
    0.001,
    MAX_TIME,
  );
  scene.background = normalizeFill(scene.background, `${path}.background`);
  scene.backgroundEnabled = requireBoolean(scene.backgroundEnabled, `${path}.backgroundEnabled`);
  normalizeQualitySceneFields(scene, path, MAX_TIME);
  scene.drift = normalizeDrift(scene.drift, `${path}.drift`, fail);
  if (scene.drift === undefined) delete scene.drift;
  // The frame finish and bars drawn above the scene's layers (sceneFinish.js).
  scene.finish = normalizeSceneFinish(scene.finish, `${path}.finish`, fail);
  if (scene.finish === undefined) delete scene.finish;
  scene.letterbox = normalizeLetterbox(scene.letterbox, `${path}.letterbox`, fail);
  if (scene.letterbox === undefined) delete scene.letterbox;
  normalizeBlockSceneFields(scene, path, MAX_TIME);
  // Objects followed through a video layer (the track op, pin.js).
  if (scene.tracks == null) delete scene.tracks;
  else scene.tracks = normalizeTracks(scene.tracks, `${path}.tracks`);
  const backgroundAnimations = requireArray(scene.backgroundAnimations, `${path}.backgroundAnimations`, MAX_ANIMATIONS_PER_LAYER);
  const backgroundProblem = backgroundAnimationProblem(scene);
  if (backgroundProblem) fail(`${path}.backgroundAnimations`, backgroundProblem);
  counters.animations += backgroundAnimations.length;
  if (counters.animations > MAX_ANIMATIONS_TOTAL)
    fail(path, `document cannot contain more than ${MAX_ANIMATIONS_TOTAL} animations`);
  const background = backgroundLayer(scene);
  const beforeBackgroundIds = counters.animationIds.size;
  scene.backgroundAnimations = backgroundAnimations.map((animation, animationIndex) =>
    normalizeAnimation(animation, `${path}.backgroundAnimations[${animationIndex}]`, counters.animationIds, background),
  );
  if (counters.animationIds.size - beforeBackgroundIds > MAX_ANIMATIONS_PER_LAYER)
    fail(`${path}.backgroundAnimations`, `cannot contain more than ${MAX_ANIMATIONS_PER_LAYER} operations including group members`);
  scene.isComponent = requireBoolean(scene.isComponent, `${path}.isComponent`);
  if (Object.hasOwn(scene, "componentPlayback") && !["content", "scene"].includes(scene.componentPlayback))
    fail(`${path}.componentPlayback`, "must be content or scene");
  const layers = requireArray(
    scene.layers,
    `${path}.layers`,
    MAX_LAYERS_PER_SCENE,
  );
  scene.layers = layers.map((layer, layerIndex) =>
    normalizeLayer(
      layer,
      `${path}.layers[${layerIndex}]`,
      counters.animationIds,
      counters,
    ),
  );
  validateParents(scene.layers, path);
  return scene;
}

function validateComponents(document) {
  const scenes = new Map(document.scenes.map((scene) => [scene.id, scene]));
  const bulkVariantKeys = new Set();
  for (const scene of document.scenes) {
    const bulkVariant = scene.bulkVariant;
    if (!bulkVariant) continue;
    if (bulkVariant.baseSceneId === scene.id || !scenes.has(bulkVariant.baseSceneId)) {
      delete scene.bulkVariant;
      continue;
    }
    const identity = JSON.stringify([bulkVariant.baseSceneId, bulkVariant.key]);
    if (bulkVariantKeys.has(identity)) delete scene.bulkVariant;
    else bulkVariantKeys.add(identity);
  }
  const counts = new Map();
  function visit(scene, chain = []) {
    if (chain.includes(scene.id)) fail(`scene.${scene.id}`, "component references contain a cycle");
    if (chain.length > 16) fail(`scene.${scene.id}`, "components are nested too deeply");
    if (counts.has(scene.id)) {
      const cached = counts.get(scene.id);
      if (chain.length + cached.depth > 16) fail(`scene.${scene.id}`, "components are nested too deeply");
      return cached;
    }
    let count = scene.layers.length;
    let depth = 0;
    for (const layer of scene.layers) {
      if (layer.type !== "component") continue;
      const source = scenes.get(layer.componentSceneId);
      if (!source || !source.isComponent) fail(`layer.${layer.id}.componentSceneId`, "must reference a main component scene");
      layer.width = source.width;
      layer.height = source.height;
      const child = visit(source, [...chain, scene.id]);
      count += 1 + child.count;
      depth = Math.max(depth, child.depth + 1);
      if (count > MAX_LAYERS_TOTAL) fail(`scene.${scene.id}`, "expanded components contain too many layers");
    }
    if (chain.length + depth > 16) fail(`scene.${scene.id}`, "components are nested too deeply");
    const result = {count, depth};
    counts.set(scene.id, result);
    return result;
  }
  for (const scene of document.scenes) visit(scene);
  validateComponentOverrides(document, scenes);
}

// Checks every instance's componentOverrides (componentOverrides.js). The main components used
// by other main components come first, so an override is compared with what a nested instance
// really shows. Each override is checked by running the layer validator on the overridden
// layer, with counters of its own so the check doesn't count as another layer of the document.
function validateComponentOverrides(document, scenes) {
  const checkLayer = (layer, path) => normalizeLayer(layer, path, new Set(), {
    sceneIds: new Set(), layerIds: new Set(), animationIds: new Set(), layers: 0, animations: 0,
  });
  const counters = { entries: 0 };
  const indexes = new Map(document.scenes.map((scene, index) => [scene.id, index]));
  const done = new Set();
  function visit(scene) {
    if (done.has(scene.id)) return;
    done.add(scene.id);
    scene.layers.forEach((layer, layerIndex) => {
      if (layer.type !== "component") return;
      visit(scenes.get(layer.componentSceneId));
      normalizeComponentOverrides(layer, scenes, checkLayer, counters, `document.scenes[${indexes.get(scene.id)}].layers[${layerIndex}]`);
    });
  }
  for (const scene of document.scenes) visit(scene);
}

export function parseDocument(value) {
  let input = value;
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > MAX_DOCUMENT_BYTES)
      fail("document", `text exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    try {
      input = JSON.parse(value);
    } catch (error) {
      fail(
        "document",
        `invalid JSON (${error instanceof Error ? error.message : "parse error"})`,
      );
    }
  }
  // A document saved by an older kino is brought up to date first (documentMigration.js).
  const safe = migrateDocument(safeClone(input));
  requireRecord(safe, "document");
  if (safe.version !== DOCUMENT_VERSION)
    fail("document.version", `must be ${DOCUMENT_VERSION}`);
  const document = { ...safe };
  document.id = requireId(document.id, "document.id");
  document.name = requireString(document.name, "document.name", 256);
  const scenes = requireArray(document.scenes, "document.scenes", MAX_SCENES);
  const counters = {
    sceneIds: new Set(),
    layerIds: new Set(),
    animationIds: new Set(),
    layers: 0,
    animations: 0,
  };
  document.scenes = scenes.map((scene, index) =>
    normalizeScene(scene, index, counters),
  );
  // Materialize the old row once. Later size/order edits keep each artboard in place.
  const rectangles = sceneRectangles(document.scenes);
  document.scenes.forEach((scene, index) => {
    scene.canvasX = requireNumber(rectangles[index].left, `document.scenes[${index}].canvasX`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE);
    scene.canvasY = requireNumber(rectangles[index].top, `document.scenes[${index}].canvasY`, -MAX_CANVAS_COORDINATE, MAX_CANVAS_COORDINATE);
  });
  validateComponents(document);
  normalizeQualityDocumentFields(document, MAX_TIME);
  normalizeShutterAngle(document);
  for (const scene of document.scenes ?? []) normalizeShutterAngle(scene);
  normalizeBlockDocumentFields(document);
  // The storyboard (board.js): its shape only; the board op checks it against media and fonts.
  normalizeBoard(document);
  // The material the video is made from (sources.js): names and text only.
  normalizeSources(document);
  // The project's frame rate (frameRate.js projectFps): left out, frames step at 30 as before.
  if (document.fps !== undefined) {
    const fps = parseFps(document.fps);
    if (fps === null) fail("document.fps", FPS_HELP);
    document.fps = fps;
  }
  return document;
}
