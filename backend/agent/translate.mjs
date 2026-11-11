// Turns an agent's operations into engine operations: `op` may stand for `type`, names and
// short codes become real IDs, and a missing sceneId (or the layerId of an animation) is
// filled in from what it points at. Common spellings of colors ("white", "rgba(…)",
// "transparent") and easings ("easeOutBack") become the engine's values, and each change is
// reported in `fixes`. Every problem names the operation's number. Other common first-try
// mistakes (add_text, layer:{…}, "48px", a property preset given values) are fixed or explained
// in common-mistakes.mjs.
import { randomUUID } from "node:crypto";
import { EASINGS, normalizeEasing } from "../../engine/easing.js";
import { PRESETS } from "../../engine/animation.js";
import { OPERATION_TYPES, SERVICE_OPERATION_TYPES } from "../operation-guide.mjs";
import { VOICE_ENGINES } from "../voice/isolate.mjs";
import { CUTOUT_ENGINES, CUTOUT_OUTPUTS } from "../cutout/cutout.mjs";
import { RULES } from "../../engine/quality/index.js";
import { closest, nearMiss, ReferenceError } from "./refs.mjs";
import { refId } from "../inspire.mjs";
import { BLOCK_OPERATION_TYPES, blockCreatedIds, blockReferencedIds, isBlockOperation, translateBlock } from "./blocks.mjs";
import { durationFromToken, easingFromToken } from "../../engine/blocks/tokens.js";
import { createLayer } from "../../engine/model.js";
import { copyName, MAX_COPIES } from "../../engine/duplicate.js";
import { BACKDROP_STYLE_KEYS } from "../../engine/backdropStyles.js";
import { REACH_OPERATIONS } from "./reach-operations.mjs";
import { LAYER_ROLES } from "../../engine/qualityFields.js";
import { MEDIA_TIMING_TYPES } from "../../engine/mediaTime.js";
import { TRIM_KEYS } from "../../engine/strokeTrim.js";
import { REPEAT_KEYS } from "../../engine/repeater.js";
import { MODIFIER_CHOICE_KEYS, MODIFIER_KEYS } from "../../engine/shapeModifiers.js";
import { bezierFromCss, fixLayerProperties, fixOperation, gradientFromCss, hexFromHsl, isLayerFieldAlias, reshapeOperation, timeFromText } from "./common-mistakes.mjs";

export class OperationError extends Error {
  constructor(index, operation, error) {
    super(error.message);
    this.name = "OperationError";
    this.index = index;
    this.type = operation?.op ?? operation?.type ?? null;
    this.suggestions = error.suggestions ?? [];
    // One op that works instead (null: the op's usual example), sent with the refusal.
    if (error.example !== undefined) this.example = error.example;
    // No example at all: no op would do what was sent (an empty one would change nothing).
    if (error.noExample) this.noExample = true;
    // The layer as the agent named it, for the example.
    const layer = operation?.layer ?? operation?.layerId;
    if (typeof layer === "string") this.layer = layer;
    // A move's refusal shows that move's own example.
    if (this.type === "move" && typeof operation?.name === "string") this.moveName = operation.name;
    this.cause = error;
  }
}

// set_font is handled by the agent service (it may download the font first); every other
// type goes to the engine.
// The building-block ops (blocks.mjs), the reach ops (reach-operations.mjs), isolate_voice and
// cut_out (SERVICE_OPERATION_TYPES) are handled there too.
export const AGENT_OPERATION_TYPES = Object.freeze([...new Set([...OPERATION_TYPES, "set_font", ...SERVICE_OPERATION_TYPES, ...BLOCK_OPERATION_TYPES, ...REACH_OPERATIONS])]);

// Operations that work on one scene. Project operations and add_scene don't need one.
const NO_SCENE = new Set(["rename_project", "update_project", "waive_check", "unwaive_check", "add_scene"]);
// Findings about what a viewer sees: the agent fixes them; only the person's words keep one.
// crop_no_subject and shape_guess are here too: a crop that may cut a face, or a frame shape the
// footage does not have, is the person's call, never the agent's.
export const VIEWER_WAIVERS = new Set(["screen_unreadable", "frozen_picture", "frozen_screen", "frozen_footage", "held_static", "hook_readable", "text_slides", "template_end", "ending_seen", "clip_reuse", "music_stall", "crop_no_subject", "shape_guess"]);
// Findings about a face or a subject cut by the frame. A filmed cut can be meant (a feet shot), so
// the agent may waive these, but only on the layers it looked at: never "*", never a whole scene.
export const SUBJECT_WAIVERS = new Set(["head_cut_off", "narrow_window"]);
// Waiver codes that are not rules in the registry: the gates (review.mjs, viewer.mjs, needs.mjs,
// brief.mjs, critique.mjs, footage-finder/step.mjs, service.mjs REFERENCE_WAIVER) and the findings
// of checks.mjs and av-offset.mjs.
const WAIVER_GATES = ["review", "reference", "viewer", "needs", "treatments", "critique", "footage", "spoiler",
  "missing_media", "empty_text", "off_canvas", "past_scene_end", "missing_font", "missing_glyphs", "av_offset"];
// Rules another chain adds to the registry (engine/quality/index.js): known by name before they land.
const NEW_RULE_CODES = ["shape_guess", "narrow_window", "ask_unmet"];
// Every code a waiver may name: the rule registry, the gates and the new rules.
const KNOWN_WAIVER_CODES = new Set([...RULES.map((entry) => entry.code), ...WAIVER_GATES, ...NEW_RULE_CODES]);
// What each person-words waiver is about, and the fix to try first (the default text is for what viewers see).
const PERSON_WORDS_ABOUT = {
  crop_no_subject: { about: "who stays in the frame", fix: 'mark_subject the part you mean, or frame the shot with the frame op' },
  shape_guess: { about: "the frame's shape", fix: 'ask which shape they want and save it as plays_on by "you" with their quote, or make the scene the shape the footage has' },
};
const HANDED_OVER = /^\s*(?:it'?s\s+)?(?:your call|up to you|you decide|you pick|whatever you think|ok(?:ay)?|yes|approve[ds]?|looks good|fine)[\s.!]*$/i;
// Fields that name one layer.
const LAYER_FIELDS = ["layerId", "referenceId", "parentId", "maskLayerId", "speechId", "toId", "duckId"];
const LAYER_TYPES = new Set(["rectangle", "ellipse", "star", "path", "text", "image", "video", "audio", "group"]);
// Short field names agents often use, and the engine field each stands for. They are the
// documented way to write these fields, so renaming them is not reported.
const FIELD_ALIASES = [["layer", "layerId"], ["scene", "sceneId"], ["layers", "layerIds"], ["parent", "parentId"], ["component", "componentSceneId"]];
// Operations that make one new layer or scene, which a `name` (or `id`) can name.
const MAKES_ONE = new Set(["add_layer", "add_scene", "insert_component"]);
// add_sequence makes a scene from other scenes; set_cues works on the project.
NO_SCENE.add("set_cues");
NO_SCENE.add("add_sequence");
MAKES_ONE.add("add_sequence");

// Renames the short field names. Only a rename that is not the documented spelling (add_captions
// "animation" for "appear") is reported in `fixes`.
function applyAliases(operation, fixes) {
  for (const [short, field] of FIELD_ALIASES) {
    if (operation[short] === undefined || operation[field] !== undefined) continue;
    operation[field] = operation[short];
    delete operation[short];
  }
  // place_broll {speech, clips:{"<layer>":"<its words>"}}: the voice, and each clip's layer and words.
  if (operation.type === "place_broll" && operation.clips && typeof operation.clips === "object" && !Array.isArray(operation.clips) && operation.layerIds === undefined) {
    operation.layerIds = Object.keys(operation.clips);
    operation.about = Object.values(operation.clips);
    delete operation.clips;
  }
  // add_captions {speech}: the voice layer whose transcript the captions come from.
  if ((operation.type === "add_captions" || operation.type === "place_broll") && operation.speech !== undefined && operation.speechId === undefined) {
    operation.speechId = operation.speech;
    delete operation.speech;
  }
  // keep_line {duck}: the music layer to dip ("none" or false: no dip); {subtitle:false} stays as it is.
  if (operation.type === "keep_line" && operation.duck !== undefined && operation.duckId === undefined) {
    if (operation.duck === "none" || operation.duck === false) operation.duckNone = true;
    else operation.duckId = operation.duck;
    delete operation.duck;
  }
  // sync_clips and match_color {to}: the clip to play in step with, or to match (duck_audio's `to` is a volume).
  if ((operation.type === "sync_clips" || operation.type === "match_color") && operation.to !== undefined && operation.toId === undefined) {
    operation.toId = operation.to;
    delete operation.to;
  }
  // On add_captions, "animation":"fade" (or "cut") means how pages appear.
  if (operation.type === "add_captions" && ["cut", "fade"].includes(operation.animation) && operation.appear === undefined) {
    operation.appear = operation.animation;
    delete operation.animation;
    fixes.push("animation → appear");
  }
  // cut_out {above}: the layer the new layer goes above, a layer reference like any other.
  if (operation.type === "cut_out" && operation.above !== undefined && operation.referenceId === undefined) {
    operation.referenceId = operation.above;
    delete operation.above;
  }
  // cut_out {behind}: the text that goes behind the person; the cut-out goes above it.
  if (operation.type === "cut_out" && operation.behind !== undefined && operation.referenceId === undefined) {
    operation.referenceId = operation.behind;
    operation.behindText = true;
    delete operation.behind;
  }
  // `animation` names an animation everywhere except add_animation, where it is the animation itself.
  if (typeof operation.animation === "string" && operation.type !== "add_animation" && operation.animationId === undefined) {
    operation.animationId = operation.animation;
    delete operation.animation;
  }
  if (MAKES_ONE.has(operation.type)) {
    for (const key of ["name", ...(operation.type === "add_scene" ? ["width", "height", "duration", "background"] : [])]) {
      if (operation[key] === undefined || operation.properties?.[key] !== undefined) continue;
      operation.properties = { ...(operation.properties ?? {}), [key]: operation[key] };
      delete operation[key];
    }
  }
}

// add_layer and update_layer read only these fields (and `animations` on add_layer, which
// becomes add_animation ops). A layer field at the top level, such as add_layer {text}, goes
// into properties and is reported; any other field is refused, so nothing is dropped unseen.
const OPERATION_FIELDS = {
  add_layer: new Set(["type", "sceneId", "layerType", "properties", "animations"]),
  update_layer: new Set(["type", "sceneId", "layerId", "properties"]),
};

function liftLayerFields(operation, fixes) {
  const own = OPERATION_FIELDS[operation.type];
  if (!own) return;
  const loose = Object.keys(operation).filter((key) => !own.has(key));
  if (!loose.length) return;
  if (operation.type === "update_layer" && loose.includes("animations"))
    throw new Error("update_layer has no animations field: add animations with add_animation ops (properties.animations replaces the whole list).");
  // Another name for a layer field (color, colour, font) goes into properties too, where it
  // becomes the field (color → fill) as it does inside properties, or is refused there when the
  // layer does not use that field (align on a rectangle: align_layers lines layers up).
  const unknown = loose.filter((key) => !LAYER_PROPERTIES.has(key) && !isLayerFieldAlias(key));
  if (unknown.length) {
    const suggestions = closest(unknown[0], [...own, ...LAYER_PROPERTY_NAMES].filter((key) => key !== "type"));
    throw Object.assign(new Error(`${unknown.map((key) => `"${key}"`).join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} of ${operation.type} or of a layer.${suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : ""}`), { suggestions });
  }
  const properties = { ...(operation.properties ?? {}) };
  for (const key of loose) {
    if (properties[key] !== undefined) throw new Error(`${key} is given twice: at the top level and in properties. Keep the one in properties.`);
    properties[key] = operation[key];
    delete operation[key];
    fixes.push(`${key} → properties.${key}`);
  }
  operation.properties = properties;
}

// ---- layer properties ----------------------------------------------------------------------
// Every field a layer can have: each layer type's defaults, then the optional ones (styles,
// component instances, clip speed in engine/mediaTime.js, engine/qualityFields.js and engine/blockFields.js).
// A property outside this list is refused, so a misspelled one is never saved without effect.
export const LAYER_PROPERTY_NAMES = [...new Set([
  ...[...LAYER_TYPES].flatMap((type) => Object.keys(createLayer(type))),
  ...Object.keys(MEDIA_TIMING_TYPES), "lowpass", "voiceCleanup", "morphIn", "log",
  ...BACKDROP_STYLE_KEYS, "reveal", "effectPreset", "fillRule", "textStyleRanges", "inactiveBoxStyles", "convertedFrom",
  "componentSceneId", "componentStart", "componentVisibility", "componentBackgroundEnabled", "componentOverrides",
  "role", "perpetual", "allowOverlap", "recipe", "tabularNumbers", "textLoop", "axes", "rotateX", "rotateY", "perspective", "skewY", "anchor", "shadows", "strokes", ...TRIM_KEYS, ...REPEAT_KEYS, ...MODIFIER_KEYS, ...MODIFIER_CHOICE_KEYS, "maskInvert", "maskMode",
])];
const LAYER_PROPERTIES = new Set(LAYER_PROPERTY_NAMES);
// Operations whose `properties` are layer fields.
const LAYER_PROPERTY_OPS = new Set(["add_layer", "update_layer", "update_layers", "insert_component"]);
// Words for showing and hiding a layer that are not its field (that is `visible`).
const HIDING_WORDS = /^(?:hidden|hide|show|shown|enabled?|disabled?|display|isVisible|isHidden|active|on|off)$/i;
// CSS names for rounded corners: a number is `radius`, four numbers are `cornerRadii`.
const CORNER_ALIASES = ["cornerRadius", "borderRadius"];

// The type and scene of the layer an operation changes (or makes), when they can be known now.
function layerContext(operation, resolver, document) {
  let layerId = null;
  try { if (typeof operation.layerId === "string") layerId = resolver.resolve(operation.layerId, "layer"); } catch { /* refused later */ }
  // Also the type of a layer an earlier operation of this edit adds: align on a rectangle added
  // just before was saved as textAlign, since only the saved document was read.
  const layerType = layerId ? resolver.layerTypeOf(layerId) ?? undefined : undefined;
  let sceneId = layerId ? resolver.sceneOf("layer", layerId) : null;
  try { if (!sceneId && typeof operation.sceneId === "string") sceneId = resolver.resolve(operation.sceneId, "scene"); } catch { /* refused later */ }
  const scene = document.scenes.find((entry) => entry.id === sceneId) ?? (document.scenes.length === 1 ? document.scenes[0] : null);
  return {
    layerType: operation.type === "add_layer" ? operation.layerType : layerType,
    layerName: operation.type === "add_layer" ? operation.properties?.name ?? operation.properties?.id : operation.layerId,
    scene,
  };
}

// This op with other properties, as an agent writes it, for a refusal's example; null for an op
// whose other fields cannot be written back here.
function sameOpWith(operation, properties) {
  // add_layer's animations are not written back, so its example would drop them: none then.
  const which = operation.type === "add_layer" && operation.animations === undefined ? { layerType: operation.layerType, ...(typeof operation.sceneId === "string" ? { scene: operation.sceneId } : {}) }
    : operation.type === "update_layer" && typeof operation.layerId === "string" ? { layer: operation.layerId }
      : operation.type === "update_layers" && Array.isArray(operation.layerIds) ? { layers: operation.layerIds } : null;
  // The ID add_layer made from the name is left out (it is made again).
  const { id: _id, ...rest } = properties;
  return which ? { op: operation.type, ...which, properties: operation.type === "add_layer" ? rest : properties } : null;
}

function checkLayerProperties(operation, fixes, resolver, document) {
  const properties = operation.properties;
  if (!LAYER_PROPERTY_OPS.has(operation.type) || !properties || typeof properties !== "object" || Array.isArray(properties)) return;
  operation.properties = fixLayerProperties(properties, fixes, { ...layerContext(operation, resolver, document), known: LAYER_PROPERTIES,
    exampleOp: (changes) => sameOpWith(operation, changes) });
  for (const alias of CORNER_ALIASES) {
    if (properties[alias] === undefined) continue;
    const field = Array.isArray(properties[alias]) ? "cornerRadii" : "radius";
    if (properties[field] === undefined) {
      operation.properties = { ...operation.properties, [field]: properties[alias] };
      fixes.push(`${alias} → ${field}`);
    }
    delete operation.properties[alias];
  }
  const unknown = Object.keys(operation.properties).filter((key) => !LAYER_PROPERTIES.has(key));
  if (unknown.length) {
    // "enabled", "hidden" and the like mean visible, which no spelling distance finds.
    const hiding = unknown.find((key) => HIDING_WORDS.test(key));
    const suggestions = hiding ? ["visible"] : closest(unknown[0], LAYER_PROPERTY_NAMES);
    const hint = hiding ? ` To hide a layer (its animations cannot show it): {"visible":false}; true shows it again.` : "";
    throw Object.assign(new Error(`${unknown.map((key) => `"${key}"`).join(", ")} ${unknown.length === 1 ? "is not a layer property" : "are not layer properties"}${suggestions.length ? `. Did you mean ${suggestions.join(", ")}?` : "."}${hint}`), { suggestions });
  }
  // A role one letter off ("headlin") or in other capitals ("CTA") is fixed and reported.
  const role = operation.properties.role;
  if (typeof role === "string" && role && !LAYER_ROLES.includes(role)) {
    const near = nearMiss(role, LAYER_ROLES);
    if (near) {
      operation.properties = { ...operation.properties, role: near };
      fixes.push(`role "${role}" → ${near}`);
    } else {
      // Refused here (not later by the document check) so the example sets a valid role.
      // In order: a word of the guess that is itself a role ("cta-button" is cta); whole words
      // for the product's own text (a screen's row, a menu: "menu-item" is ui, "arrow" is not);
      // small tag words (tag, chip, badge) mean label; else the nearest spelling, else body.
      const words = role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
      const named = words.find((word) => LAYER_ROLES.includes(word));
      const product = words.some((word) => /^(ui|screens?|rows?|menus?|interface)$/.test(word));
      const tag = /tag|chip|badge|pill|plate|callout/i.test(role);
      const suggestions = named ? [named] : product ? ["ui"] : tag ? ["label"] : closest(role, LAYER_ROLES);
      const pick = suggestions[0] ?? "body";
      const example = sameOpWith(operation, { ...operation.properties, role: pick });
      throw Object.assign(new Error(`role must be one of ${LAYER_ROLES.join(", ")}; "${role}" is not one.`),
        { suggestions: suggestions.length ? suggestions : [pick], ...(example ? { example } : {}) });
    }
  }
}

// ---- media sources --------------------------------------------------------------------------
// Image, video and audio layers show or play a file. One with no src renders nothing, and its
// renders, exports and the contrast check stop on it, so an add_layer without a src (or an
// update_layer that clears it) is refused here, with how to get one.
const MEDIA_LAYER_TYPES = new Set(["image", "video", "audio"]);
const EXAMPLE_SOURCE = { image: "/api/media/<image>.png", video: "/api/media/<clip>.mp4", audio: "/api/media/<sound>.m4a" };
const blankSource = (src) => src === undefined || src === null || (typeof src === "string" && !src.trim());

function checkMediaSource(operation, resolver, document) {
  const properties = operation.properties && typeof operation.properties === "object" ? operation.properties : {};
  if (operation.type === "update_layer" && !Object.hasOwn(properties, "src")) return;
  if (operation.type !== "add_layer" && operation.type !== "update_layer") return;
  const { layerType, layerName } = layerContext(operation, resolver, document);
  if (!MEDIA_LAYER_TYPES.has(layerType) || !blankSource(properties.src)) return;
  const name = typeof layerName === "string" ? ` "${layerName}"` : "";
  const how = `import the file (project {action:"import", file:"/absolute/path"}) and set src to the /api/media/... address it answers`;
  if (operation.type === "update_layer")
    throw Object.assign(new Error(`update_layer cannot clear the src of ${layerType} layer${name}. To swap its file, ${how} (or replace_media); to remove it, delete_layer.`), { noExample: true });
  throw Object.assign(new Error(`${layerType} layer${name} has no src. First ${how}.`),
    { example: sameOpWith(operation, { ...properties, src: EXAMPLE_SOURCE[layerType] }) });
}

// ---- colors and easings -------------------------------------------------------------------
const NAMED_COLORS = {
  transparent: "#00000000", none: "#00000000", white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000",
  lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", pink: "#ffc0cb",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", cyan: "#00ffff", magenta: "#ff00ff", navy: "#000080", teal: "#008080",
};
// Fields that hold a color or paint: fill, stroke, background, color, shadowColor, …
const COLOR_KEY = /^(?:fill|stroke|background|color)$|Color$/;
const HEX = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const byte = (value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");

/** The hex color for a color word, rgb()/rgba(), hsl()/hsla() or a hex without "#"; null if none applies. */
export function colorFromText(text) {
  const value = text.trim().toLowerCase();
  if (HEX.test(value)) return null;
  if (NAMED_COLORS[value]) return NAMED_COLORS[value];
  if (/^(?:[\da-f]{6}|[\da-f]{8})$/.test(value)) return `#${value}`;
  if (value.startsWith("hsl")) return hexFromHsl(value);
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(value);
  if (!rgb) return null;
  const channel = (part) => (part.endsWith("%") ? parseFloat(part) * 2.55 : parseFloat(part));
  const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
  return `#${byte(channel(rgb[1]))}${byte(channel(rgb[2]))}${byte(channel(rgb[3]))}${alpha >= 1 ? "" : byte(alpha * 255)}`;
}

const EASING_NAMES = EASINGS.map((easing) => easing.id).filter((id) => id !== "custom");

/** kino's easing for a name from CSS or animation libraries ("easeOutBack" → overshoot). */
export function easingFromText(text) {
  try { normalizeEasing(text); return null; } catch { /* not one of kino's names */ }
  const token = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/back|overshoot/.test(token)) return "overshoot";
  if (/elastic|spring|wobble/.test(token)) return "elastic";
  if (/bounce/.test(token)) return "bounce";
  if (/inout|^ease$|^standard$|^sine$|^cubic$/.test(token)) return "smooth";
  if (/^(?:ease)?out|out$|decel/.test(token)) return "ease-out";
  if (/^(?:ease)?in|in$|accel/.test(token)) return "ease-in";
  if (/^linear/.test(token)) return "linear";
  throw new Error(`Unknown easing "${text}". Easings: ${EASING_NAMES.join(", ")}, or a cubic bezier [x1, y1, x2, y2].`);
}

// "steps-4", "steps(4)" or "steps 4": the steps easing with that count (its intensity).
const STEPS_TEXT = /^\s*steps?\s*[-(:\s]\s*(\d+)\s*\)?\s*$/i;
const STEPS_HOW = `"steps-4" (4 held poses, 1 to 100), or easing "steps" with intensity 4`;

// The steps shorthand on an object that holds easing (an animation, its properties or an op).
function stepsEasing(value, result) {
  const steps = typeof value.easing === "string" ? STEPS_TEXT.exec(value.easing) : null;
  if (steps) {
    const count = Number(steps[1]);
    if (count < 1 || count > 100) throw new Error(`easing "${value.easing}": steps take a count from 1 to 100, such as ${STEPS_HOW}.`);
    if (value.intensity !== undefined && value.intensity !== count) throw new Error(`easing "${value.easing}" and intensity ${value.intensity} disagree: the intensity is the step count. Send one.`);
    result.easing = "steps";
    result.intensity = count;
  }
  // A key's ease has no intensity of its own: the animation's intensity counts its steps.
  if (typeof value.ease === "string" && STEPS_TEXT.test(value.ease) && value.t !== undefined)
    throw new Error(`a key's ease "${value.ease}": write ease "steps" and give the animation intensity ${STEPS_TEXT.exec(value.ease)[1]} (the step count).`);
}

// A bare "steps" (easing, or a key's ease) needs a count: without an intensity in the op or on
// the saved animation it would hold 50 poses. Checked once references are IDs.
const BARE_STEPS = /^\s*(?:steps|stepped)\s*$/i;
function checkStepsCount(operation, type, document) {
  const savedAnimation = (id) => {
    for (const scene of document?.scenes ?? []) for (const layer of scene.layers ?? []) {
      const stack = [...(layer.animations ?? [])];
      while (stack.length) {
        const entry = stack.pop();
        if (entry?.id === id) return entry;
        if (Array.isArray(entry?.animations)) stack.push(...entry.animations);
      }
    }
    return null;
  };
  const check = (fields, saved) => {
    if (!fields || typeof fields !== "object" || !["easing", "keys", "intensity"].some((key) => fields[key] !== undefined)) return;
    const pick = (key) => (fields[key] !== undefined ? fields[key] : saved?.[key]);
    const keys = Array.isArray(pick("keys")) ? pick("keys") : [];
    const bare = [pick("easing"), ...keys.map((key) => key?.ease)].find((easing) => typeof easing === "string" && BARE_STEPS.test(easing));
    if (bare === undefined || pick("intensity") != null) return;
    if (bare === pick("easing")) throw new Error(`easing "${bare}" needs its count: ${STEPS_HOW}.`);
    throw new Error(`a key's ease "${bare}" counts by the animation's intensity: give intensity 4 for 4 held poses (1 to 100).`);
  };
  if (type === "add_animation") {
    const animation = operation.animation && typeof operation.animation === "object" ? operation.animation : {};
    check({ easing: animation.easing ?? operation.easing, intensity: animation.intensity ?? operation.intensity, keys: animation.keys ?? operation.keys }, null);
  } else if (type === "update_animation") check(operation.properties, savedAnimation(operation.animationId));
  else if (type === "update_animations" && Array.isArray(operation.animationIds))
    for (const id of operation.animationIds) check(operation.properties, savedAnimation(typeof id === "string" ? id : id?.animationId));
}

// Fixes color and easing spellings anywhere in an operation (properties, from/to, keyframes).
function normalizeValues(value, fixes, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeValues(entry, fixes, depth + 1));
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "easing" && typeof entry === "string" && STEPS_TEXT.test(entry)) {
      result[key] = entry;
    } else if (typeof entry === "string" && COLOR_KEY.test(key) && /gradient\(/i.test(entry)) {
      // CSS "linear-gradient(90deg, #f00, #00f)" → kino's gradient paint.
      const gradient = gradientFromCss(entry, colorFromText, key);
      if (gradient) fixes.push(`${key} CSS gradient → {type:"${gradient.type}"${gradient.angle !== undefined ? `, angle:${gradient.angle}` : ""}, ${gradient.stops.length} stops}`);
      result[key] = gradient ?? entry;
    } else if (typeof entry === "string" && COLOR_KEY.test(key)) {
      const color = colorFromText(entry);
      if (color) fixes.push(`${key} "${entry}" → ${color}`);
      result[key] = color ?? entry;
    } else if (key === "easing" && typeof entry === "string" && bezierFromCss(entry)) {
      const easing = bezierFromCss(entry);
      fixes.push(`easing "${entry}" → [${easing.join(", ")}]`);
      result[key] = easing;
    } else if ((key === "duration" || key === "start") && timeFromText(entry) !== null) {
      // "2s" and "500ms" are seconds.
      const seconds = timeFromText(entry);
      fixes.push(`${key} "${entry}" → ${seconds}`);
      result[key] = seconds;
    } else if (key === "easing" && easingFromToken(entry)) {
      // A motion token: "enter", "exit:0.8" or {token, intensity}. Tokens are documented
      // names, not mistakes, so they are not listed in fixed.
      result[key] = easingFromToken(entry);
    } else if (key === "duration" && durationFromToken(entry) !== null) {
      result[key] = durationFromToken(entry);
    } else if (typeof entry === "string" && key === "easing") {
      const easing = easingFromText(entry);
      if (easing) fixes.push(`easing "${entry}" → ${easing}`);
      result[key] = easing ?? entry;
    } else result[key] = normalizeValues(entry, fixes, depth + 1);
  }
  stepsEasing(value, result);
  return result;
}

// ---- IDs ------------------------------------------------------------------------------------
function idFromName(name, kind, resolver) {
  // Accents are dropped ("Ünïcode" → unicode) rather than turned into dashes.
  const base = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!base) return null;
  for (let number = 1; number < 100; number += 1) {
    const id = number === 1 ? base : `${base}-${number}`;
    if (resolver.exists("scene", id) || resolver.exists("layer", id) || resolver.exists("animation", id)) continue;
    // A name already in use gets the next free number ("r80" → r80-2). The receipt lists each
    // one in `renamed`, so the agent never has to look for it among the created names.
    if (number > 1) (resolver.renamed ??= []).push({ name, id });
    return id;
  }
  return null;
}

// The copies duplicate_layers and split_layer make get their ID and name here, named as
// duplicate.js and splitLayer.js name them ("<name> copy"; "<name> 2" with count or a split),
// so later operations of the same edit can use them. A split piece's number follows the clip's
// when the clip is itself a piece ("app 2" splits into "app 3" while a layer "app" exists; "shot 1"
// alone splits into "shot 1 2"). Stored as operation.copies: one {original ID: {id, name}} per copy.
function copyNames(operation, type, resolver) {
  const originals = type === "split_layer" ? [operation.layerId] : operation.layerIds;
  if (!Array.isArray(originals) || !originals.every((id) => typeof id === "string")) return;
  const counted = type === "duplicate_layers" && operation.count !== undefined;
  const count = counted && Number.isInteger(operation.count) && operation.count >= 1 && operation.count <= MAX_COPIES ? operation.count : 1;
  const copies = Array.from({ length: count }, () => ({}));
  for (const original of originals) {
    const name = String(resolver.nameOf("layer", original) ?? "");
    const stripped = name.replace(/ \d+$/, "");
    const piece = type === "split_layer" && stripped !== name && resolver.nameTaken("layer", stripped);
    const base = (piece ? stripped : name).slice(0, 240);
    for (const copy of copies) {
      let name = copyName(base);
      if (counted || type === "split_layer") {
        let number = 2;
        while (resolver.nameTaken("layer", `${base} ${number}`)) number += 1;
        name = `${base} ${number}`;
      }
      const id = idFromName(name, "layer", resolver) || randomUUID();
      resolver.declare("layer", id, { sceneId: operation.sceneId, name, type: resolver.layerTypeOf(original) });
      copy[original] = { id, name };
    }
  }
  operation.copies = copies;
}

// A refused add_layer as a plain layer of the same type, ID and name (and text), or null. It
// stands in for the refused layer so the operations that use it are still tried, and their own
// problems are listed in the same refusal. Nothing is saved either way.
export function plainLayer(operation) {
  if (operation?.type !== "add_layer" || !LAYER_TYPES.has(operation.layerType) || typeof operation.sceneId !== "string") return null;
  const { id, name, text } = operation.properties ?? {};
  if (typeof id !== "string" || !id) return null;
  return { type: "add_layer", layerType: operation.layerType, sceneId: operation.sceneId,
    properties: { id, ...(typeof name === "string" ? { name } : {}), ...(operation.layerType === "text" && typeof text === "string" ? { text } : {}) } };
}

function standInLayer(operation, resolver, document) {
  if (operation?.type !== "add_layer") return null;
  let sceneId;
  try {
    sceneId = typeof operation.sceneId === "string" ? resolver.resolve(operation.sceneId, "scene")
      : operation.sceneId === undefined && document.scenes.length === 1 ? document.scenes[0].id : null;
  } catch { return null; }
  return plainLayer({ ...operation, sceneId });
}

// The IDs an operation creates (so later operations may use them, and so operations that use
// them can be skipped when it fails).
export function createdIds(operation) {
  const type = operation?.type;
  const ids = [];
  if (MAKES_ONE.has(type)) ids.push(operation.properties?.id);
  if (type === "add_animation") ids.push(operation.id ?? operation.animation?.id);
  if (type === "group_layers" || type === "create_mask") ids.push(operation.groupId);
  if (type === "create_component_from_layers") ids.push(operation.componentSceneId, operation.instanceId);
  if (type === "isolate_voice") ids.push(operation.backgroundId);
  if (type === "cut_out") ids.push(operation.cutoutId);
  for (const copy of Array.isArray(operation.copies) ? operation.copies : []) ids.push(...Object.values(copy ?? {}).map((chosen) => chosen?.id));
  ids.push(...blockCreatedIds(operation));
  return ids.filter((id) => typeof id === "string" && id);
}

// The IDs an (already translated) operation refers to.
export function referencedIds(operation) {
  const ids = [operation.sceneId, operation.animationId, operation.properties?.parentId, ...LAYER_FIELDS.map((field) => operation[field])];
  if (operation.type !== "create_component_from_layers") ids.push(operation.componentSceneId);
  if (operation.type === "add_sequence" && Array.isArray(operation.scenes)) ids.push(...operation.scenes);
  if (operation.type === "duck_audio" && Array.isArray(operation.under)) ids.push(...operation.under);
  for (const list of [operation.layerIds, operation.animationIds, operation.items])
    for (const entry of Array.isArray(list) ? list : []) ids.push(...(typeof entry === "string" ? [entry] : [entry?.layerId, entry?.animationId]));
  ids.push(...blockReferencedIds(operation));
  return ids.filter((id) => typeof id === "string" && id);
}

function translateOne(raw, resolver, document) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Each operation must be an object.");
  if (isBlockOperation(raw.op ?? raw.type)) return translateBlock(raw, resolver, document);
  let operation = { ...raw };
  if (operation.op !== undefined) {
    // {op:"add_layer", type:"text"}: here `type` is the layer type.
    if (operation.op === "add_layer" && LAYER_TYPES.has(operation.type) && operation.layerType === undefined) {
      operation.layerType = operation.type;
      resolver.fixes.push("type → layerType");
    } else if (operation.type !== undefined && operation.type !== operation.op) throw new Error("Give op or type, not both.");
    operation.type = operation.op;
    delete operation.op;
  }
  if (!AGENT_OPERATION_TYPES.includes(operation.type)) {
    const suggestions = closest(String(operation.type ?? ""), AGENT_OPERATION_TYPES);
    throw Object.assign(new Error(`Unknown operation "${operation.type}". Did you mean ${suggestions.join(", ")}?`), { suggestions });
  }
  const type = operation.type;
  applyAliases(operation, resolver.fixes);
  // A caller-chosen ID may come at the top level too.
  if (MAKES_ONE.has(type) && operation.id !== undefined) {
    operation.properties = { ...(operation.properties ?? {}), id: operation.id };
    delete operation.id;
  }
  // A new layer or scene with a name but no ID gets an ID made from the name ("Hero title" →
  // hero-title), so later operations can use the name. One without a name gets a random ID,
  // which is never shown: its code (L12, s3) is, and the code works in later operations of
  // the same edit too.
  if (MAKES_ONE.has(type) && operation.properties?.id === undefined) {
    const name = operation.properties?.name;
    const id = (typeof name === "string" && idFromName(name, type === "add_scene" ? "scene" : "layer", resolver)) || randomUUID();
    operation.properties = { ...(operation.properties ?? {}), id };
  }
  // A group's name becomes its ID the same way, so later operations can use it.
  if ((type === "group_layers" || type === "create_mask") && operation.groupId === undefined && typeof operation.name === "string") {
    const id = idFromName(operation.name, "layer", resolver);
    if (id) operation.groupId = id;
  }

  let failure = null;
  try {
    fixOperation(operation, resolver.fixes, { resolver, layerRef: raw.layer ?? raw.layerId ?? raw.target });
    nameAnimation(operation, resolver);
    liftLayerFields(operation, resolver.fixes);
    checkLayerProperties(operation, resolver.fixes, resolver, document);
    checkMediaSource(operation, resolver, document);
    operation = normalizeValues(operation, resolver.fixes);
    resolveReferences(operation, type, resolver, document);
    checkStepsCount(operation, type, document);
    if (type === "isolate_voice") checkIsolateVoice(operation, resolver);
    if (type === "cut_out") checkCutOut(operation, resolver);
    if (type === "cut_speech") checkCutSpeech(operation);
    if (type === "place_broll") checkPlaceBroll(operation);
    if (type === "keep_line") checkKeepLine(operation);
    if (type === "color_filter") checkColorFilter(operation);
    if (type === "sync_clips") checkSyncClips(operation);
    if (type === "match_color") checkMatchColor(operation);
    if (type === "track" || type === "pin") checkTrackOrPin(operation, type);
    if (type === "stabilize") checkStabilize(operation);
    if (type === "duplicate_layers" || type === "split_layer") copyNames(operation, type, resolver);
    // A new name given in this edit names the object for the operations after it.
    if ((type === "update_scene" || type === "update_layer") && typeof operation.properties?.name === "string")
      resolver.rename(type === "update_scene" ? "scene" : "layer", type === "update_scene" ? operation.sceneId : operation.layerId, operation.properties.name);
    return operation;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Declared even when this operation has a problem, so the operations after it are not
    // refused for using what it would have made.
    const sceneId = resolver.exists("scene", operation.sceneId) ? operation.sceneId : null;
    const name = operation.properties?.name;
    if (type === "add_scene") resolver.declare("scene", operation.properties?.id, { name });
    if (type === "add_sequence") resolver.declare("scene", operation.properties?.id, { name });
    // With the layer's type, so a later operation's type check sees it (layerContext).
    if (type === "add_layer") resolver.declare("layer", operation.properties?.id, { sceneId, name, type: operation.layerType, parentId: operation.properties?.parentId });
    if (type === "insert_component") resolver.declare("layer", operation.properties?.id, { sceneId, name, type: "component" });
    // With an ID, its kind and its name, so "title.in" names it in a later operation of this edit.
    if (type === "add_animation") {
      if (!failure && operation.id === undefined && operation.animation?.id === undefined) operation.id = randomUUID();
      resolver.declare("animation", operation.id ?? operation.animation?.id, { sceneId, layerId: operation.layerId, kind: animationKind(operation), animationName: operation.animation?.name ?? operation.name });
    }
    if (type === "group_layers" || type === "create_mask") resolver.declare("layer", operation.groupId, { sceneId, name: operation.name, type: "group" });
    if (type === "isolate_voice") resolver.declare("layer", operation.backgroundId, { sceneId, name: operation.backgroundName, type: "audio" });
    // A cut-out is a copy of its layer.
    if (type === "cut_out") resolver.declare("layer", operation.cutoutId, { sceneId, name: operation.cutoutName, type: typeof operation.layerId === "string" ? resolver.layerTypeOf(operation.layerId) : null });
    if (type === "create_component_from_layers") {
      resolver.declare("scene", operation.componentSceneId);
      resolver.declare("layer", operation.instanceId, { sceneId, type: "component" });
    }
    // What a delete removes is free again for the operations after it (same name, no "-2").
    if (!failure && type === "delete_layer") resolver.forget("layer", operation.layerId);
    if (!failure && type === "delete_animation") resolver.forget("animation", operation.animationId);
    if (failure) {
      failure.createdIds = createdIds(operation);
      failure.standIn = standInLayer(operation, resolver, document);
    }
  }
}

// add_animation {name}: the animation's name, and (when no id is given) its ID made from the
// name, so later operations can use it.
function nameAnimation(operation, resolver) {
  if (operation.type !== "add_animation" || typeof operation.name !== "string") return;
  const { name } = operation;
  delete operation.name;
  if (operation.animation && typeof operation.animation === "object") operation.animation = { ...operation.animation, name: operation.animation.name ?? name };
  if (operation.id === undefined && operation.animation?.id === undefined) {
    const id = idFromName(name, "animation", resolver);
    if (id) {
      operation.id = id;
      resolver.fixes.push(`name → id "${id}"`);
    }
  }
}

// Names and codes become IDs, in place.
function resolveReferences(operation, type, resolver, document) {
  const resolve = (value, kind, hint) => resolver.resolve(value, kind, hint);
  let sceneHint = null;
  const noteScene = (kind, id) => { sceneHint ??= resolver.sceneOf(kind, id); };

  if (type !== "create_component_from_layers") {
    if (typeof operation.componentSceneId === "string") operation.componentSceneId = resolve(operation.componentSceneId, "scene");
  }
  for (const field of LAYER_FIELDS) {
    if (typeof operation[field] === "string") {
      operation[field] = resolve(operation[field], "layer");
      noteScene("layer", operation[field]);
    }
  }
  if (Array.isArray(operation.replaceLayers)) operation.replaceLayers = operation.replaceLayers.map((id) => resolve(id, "layer"));
  if (Array.isArray(operation.layerIds) && type !== "copy_layers") {
    operation.layerIds = operation.layerIds.map((id) => resolve(id, "layer"));
    if (operation.layerIds[0]) noteScene("layer", operation.layerIds[0]);
  }
  if (operation.properties && typeof operation.properties.parentId === "string")
    operation.properties = { ...operation.properties, parentId: resolve(operation.properties.parentId, "layer") };
  if (typeof operation.animationId === "string") {
    operation.animationId = resolve(operation.animationId, "animation", { layerId: operation.layerId });
    noteScene("animation", operation.animationId);
    if (operation.layerId === undefined && ["update_animation", "delete_animation"].includes(type)) {
      const layerId = resolver.layerOfAnimation(operation.animationId);
      if (layerId) operation.layerId = layerId;
    }
  }
  const animationEntry = (entry, { layers = false } = {}) => {
    if (typeof entry === "string") {
      // In a stagger, a bare name may also be a layer: all of that layer's animations.
      if (layers && !/\./.test(entry)) {
        try { resolve(entry, "animation"); } catch (error) {
          let layerId;
          try { layerId = resolve(entry, "layer"); } catch { throw error; }
          noteScene("layer", layerId);
          return { layerId };
        }
      }
      const id = resolve(entry, "animation");
      noteScene("animation", id);
      return id;
    }
    if (entry && typeof entry === "object") {
      const next = { ...entry };
      if (typeof next.layerId === "string") { next.layerId = resolve(next.layerId, "layer"); noteScene("layer", next.layerId); }
      if (typeof next.animationId === "string") { next.animationId = resolve(next.animationId, "animation"); noteScene("animation", next.animationId); }
      return next;
    }
    return entry;
  };
  if (Array.isArray(operation.animationIds)) operation.animationIds = operation.animationIds.map(animationEntry);
  if (type === "stagger_animations" && Array.isArray(operation.items)) operation.items = operation.items.map((entry) => animationEntry(entry, { layers: true }));

  // What a viewer sees (an unreadable screen, a frozen picture, slides, a template end, a clip
  // looped): a blind judge marked fp-6 down for exactly the screen_unreadable and frozen_picture
  // findings its agent waived. The agent fixes these; only the person's own words accept one
  // (quote: what they said about it), never "your call", and only on named layers.
  // A code nobody checks would sit in the document and cover nothing: refuse it, with the near names.
  if (type === "waive_check" && typeof operation.code === "string" && operation.code && !KNOWN_WAIVER_CODES.has(operation.code)) {
    const suggestions = closest(operation.code, [...KNOWN_WAIVER_CODES]);
    throw Object.assign(new Error(`waive_check: "${operation.code}" is not a check rule or a gate. Did you mean ${suggestions.join(", ")}? library {topic:"rules"} lists the rules.`), { suggestions });
  }
  const targetsStar = operation.target === "*" || (Array.isArray(operation.target) && operation.target.includes("*"));
  if (type === "waive_check" && VIEWER_WAIVERS.has(operation.code)) {
    const quote = typeof operation.quote === "string" ? operation.quote.trim() : "";
    const own = PERSON_WORDS_ABOUT[operation.code];
    if (!quote || HANDED_OVER.test(quote) || quote.split(/\s+/).length < 4)
      throw new Error(`${operation.code} is ${own ? `about ${own.about}` : "what viewers see"}: fix it (${own ? own.fix : `its finding's fix, or check {fix:"auto"}`}), do not waive it. Only the person can keep it: when they asked for it in their own words, send waive_check with quote (their words about this, word for word; "your call" is not one) and the layers it covers.`);
    if (targetsStar)
      throw new Error(`waive_check ${operation.code} names the layers the person kept, not target:"*".`);
    operation.reason = `${String(operation.reason ?? "").trim() || "the person kept it"} (the person: "${quote.slice(0, 200)}")`;
  }
  // A face cut by the frame can be meant (a feet shot), so these stay waivable by the agent, one
  // layer at a time: a waiver on "*" or a scene would cover shots nobody looked at (scenes: below).
  if (type === "waive_check" && SUBJECT_WAIVERS.has(operation.code) && targetsStar)
    throw new Error(`waive_check ${operation.code} names the layers whose cut is meant (look {mode:"source"} shows each), not target:"*".`);
  // ask_unmet: the video never shows what the person's subject search found everyone calls it. A
  // waiver says which word it is about, so it cannot be a stock reason (resolver.origin: state.origin).
  if (type === "waive_check" && operation.code === "ask_unmet") {
    const words = (resolver.origin?.words ?? []).map((entry) => String(entry?.word ?? "")).filter(Boolean);
    if (!words.length)
      throw new Error("waive_check ask_unmet: this project has no origin word (the subject search found none), so there is nothing to waive.");
    const reason = String(operation.reason ?? "");
    const said = (word) => new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(reason);
    if (!words.some(said))
      throw new Error(`waive_check ask_unmet names the origin word in its reason (${words.map((word) => `"${word}"`).join(", ")}) and why the video does without it.`);
  }
  // no_music: silence is the person's call. Their words (quote) mark the waiver as theirs; an
  // agent's own waiver still holds the sound stop while the song search found songs (stops.mjs).
  if (type === "waive_check" && operation.code === "no_music" && typeof operation.quote === "string") {
    const quote = operation.quote.trim();
    if (quote && !HANDED_OVER.test(quote) && quote.split(/\s+/).length >= 3)
      operation.reason = `${String(operation.reason ?? "").trim() || "the person asked for silence"} (the person: "${quote.slice(0, 200)}")`;
  }
  // effect_fit: an effect kept on purpose still has a reason in the song or the footage, so its
  // waiver names that cue (reason "... cue:<name> ...") and the cue must exist.
  if (type === "waive_check" && operation.code === "effect_fit") {
    const named = /cue:([^\s,;)]+)/.exec(String(operation.reason ?? ""))?.[1];
    if (!named || !(document?.cues ?? []).some((cue) => cue.name === named))
      throw new Error(`waive_check effect_fit names the cue that motivates the effect in its reason ("on the punch at cue:<name>")${named ? `; there is no cue ${named}` : ""}. No cue motivates it: take the effect off.`);
  }
  // type_seen: kino has no default type look, so a look kept from the last projects was chosen by a
  // reference of this project (reason names it: yt:<id>; resolver.references: its style lines' refs and
  // saved Inspire references). A picked treatment's type direction needs no waiver (style.type).
  if (type === "waive_check" && operation.code === "type_seen") {
    const named = [...String(operation.reason ?? "").matchAll(/\byt:([\w-]{6,})/gi)].map((match) => match[1]);
    // Both sides as reference ids (refId: a link or a bare id becomes yt:<id>), matched exactly.
    const own = new Set((resolver.references ?? []).map(refId).filter(Boolean));
    if (!named.length)
      throw new Error('waive_check type_seen names the reference that chose this type in its reason ("set like the title in yt:<id>"). No reference chose it: take the type from your references and this footage instead.');
    if (!named.some((id) => own.has(refId(`yt:${id}`))))
      throw new Error(`waive_check type_seen names yt:${named[0]}, which is not a reference of this project (a style line's ref or a saved Inspire reference). Save it (library inspire, name "save yt:${named[0]}") and study it, or take the type from the references this project has.`);
  }
  if (type === "waive_check") delete operation.quote;
  // A waiver's target is a layer, a scene, or * for the whole project; or a list of layers and
  // scenes, or a glob such as "arch-*" for the layers whose names match now (layers added later
  // are not covered). One target stays a string; several become a list of IDs.
  if ((type === "waive_check" || type === "unwaive_check") && operation.target !== "*"
    && (typeof operation.target === "string" || Array.isArray(operation.target))) {
    const one = (ref) => {
      if (typeof ref === "string" && /[*?]/.test(ref)) {
        const matched = resolver.matchAll(ref, "layer");
        if (!matched.length) throw new ReferenceError(`No layer name matches "${ref}".`, { ref, kind: "layer" });
        return matched;
      }
      try { return [resolve(ref, "layer")]; }
      catch (error) {
        let scene;
        try { scene = resolve(ref, "scene"); } catch { throw error; }
        // A scene covers every layer in it, shots nobody looked at: these name layers.
        if (type === "waive_check" && (VIEWER_WAIVERS.has(operation.code) || SUBJECT_WAIVERS.has(operation.code)))
          throw new Error(`waive_check ${operation.code} names layers, not the scene "${ref}": a scene waiver covers every shot in it. Name the layers (a list, or a glob such as "shot-*").`);
        return [scene];
      }
    };
    if (!operation.target.length || (Array.isArray(operation.target) && operation.target.includes("*")))
      throw new Error(`${type} target names layers or scenes (a list, or a glob such as "arch-*"); target:"*" alone waives the whole project.`);
    const ids = [...new Set([operation.target].flat().flatMap(one))];
    operation.target = ids.length === 1 ? ids[0] : ids;
  }
  // Removing a waiver that is not there changes nothing: the edit goes on, and the receipt says so.
  if (type === "waive_check" || type === "unwaive_check") {
    const keys = [operation.target].flat().map((target) => `${operation.code} ${target}`);
    if (type === "waive_check") for (const key of keys) (resolver.batchWaivers ??= new Set()).add(key);
    else {
      const had = new Set([...(document?.checkWaivers ?? []).map((waiver) => `${waiver.code} ${waiver.target}`), ...(resolver.batchWaivers ?? [])]);
      if (!keys.some((key) => had.has(key))) resolver.fixes.push(`unwaive_check: no ${operation.code} waiver on ${[operation.target].flat().map((id) => resolver.nameOf("layer", id) ?? resolver.nameOf("scene", id) ?? id).join(", ")}, nothing to remove`);
    }
  }
  // A sequence lists its scenes by name or code.
  if (type === "add_sequence" && Array.isArray(operation.scenes))
    operation.scenes = operation.scenes.map((id) => (typeof id === "string" ? resolve(id, "scene") : id));
  // duck_audio lists the layers it ducks under by name or code; one name alone is a list of one.
  if (type === "duck_audio" && typeof operation.under === "string") operation.under = [operation.under];
  if (type === "duck_audio" && Array.isArray(operation.under))
    operation.under = operation.under.map((id) => (typeof id === "string" ? resolve(id, "layer") : id));
  if (!NO_SCENE.has(type)) {
    if (typeof operation.sceneId === "string") operation.sceneId = resolve(operation.sceneId, "scene");
    else if (operation.sceneId === undefined) {
      if (sceneHint) operation.sceneId = sceneHint;
      else if (document.scenes.length === 1) operation.sceneId = document.scenes[0].id;
      else if (OPERATION_TYPES.includes(type) && document.scenes.length > 1) {
        // The engine needs the scene, and more than one could be meant.
        const shown = document.scenes.slice(0, 4).map((scene) => {
          const code = resolver.codeOf(scene.id);
          return `${code ?? scene.id}${scene.name ? ` "${scene.name}"` : ""}`;
        });
        const first = resolver.codeOf(document.scenes[0].id) ?? document.scenes[0].id;
        throw Object.assign(new Error(`${type} needs scene: this project has ${document.scenes.length} scenes (${shown.join(", ")}${document.scenes.length > 4 ? ", …" : ""}).`),
          { example: { op: type, scene: first, ...(type === "add_layer" ? { layerType: "rectangle", name: "card" } : type === "update_scene" ? { properties: { duration: 6 } } : {}) }, suggestions: document.scenes.slice(0, 3).map((scene) => resolver.codeOf(scene.id) ?? scene.id) });
      }
    }
  }
}

// isolate_voice {sceneId, layerId, keep?, engine?, amount?} is checked here, so a wrong value is
// refused before any sound is decoded. With keep "both" it also names the new background layer
// now ("<layer name>-background", without a file extension), so later operations in the same edit
// can use that name. The agent service does the rest (service.mjs runIsolateVoice).
const VOICE_FIELDS = new Set(["type", "sceneId", "layerId", "keep", "engine", "amount"]);
const VOICE_KEEP = ["voice", "background", "both"];
function checkIsolateVoice(operation, resolver) {
  const extra = Object.keys(operation).filter((key) => !VOICE_FIELDS.has(key));
  if (extra.length) throw new Error(`isolate_voice has no ${extra.join(", ")}; it takes layer, keep, engine and amount.`);
  if (typeof operation.layerId !== "string") throw new Error("isolate_voice needs layer: the audio or video layer whose sound to split.");
  if (operation.keep !== undefined && !VOICE_KEEP.includes(operation.keep))
    throw Object.assign(new Error(`keep must be "voice", "background" or "both", not ${JSON.stringify(operation.keep)}.`), { suggestions: closest(String(operation.keep), VOICE_KEEP) });
  if (operation.engine !== undefined && !VOICE_ENGINES.includes(operation.engine))
    throw Object.assign(new Error(`engine must be ${VOICE_ENGINES.map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(operation.engine)}.`), { suggestions: closest(String(operation.engine), VOICE_ENGINES) });
  if (operation.amount !== undefined && !(typeof operation.amount === "number" && operation.amount >= 0 && operation.amount <= 1))
    throw new Error(`amount must be a number from 0 to 1 (1 keeps only the voice), not ${JSON.stringify(operation.amount)}.`);
  if (operation.keep === "both") {
    const layerName = resolver.nameOf("layer", operation.layerId) ?? operation.layerId;
    const base = layerName.replace(/\.(?:mp4|webm|mov|m4a|mp3|wav|ogg|aac|flac)$/i, "") || layerName;
    operation.backgroundName = `${base}-background`.slice(0, 200);
    operation.backgroundId = idFromName(operation.backgroundName, "layer", resolver) || randomUUID();
  }
}

// cut_speech {sceneId, layerId, words?, spans?, pauses?, restore?, ripple?, morph?}: an unknown field is
// refused here, before the voice is transcribed; the engine checks the values (engine/speech.js).
const CUT_SPEECH_FIELDS = new Set(["type", "sceneId", "layerId", "words", "spans", "pauses", "restore", "ripple", "morph"]);
function checkCutSpeech(operation) {
  const extra = Object.keys(operation).filter((key) => !CUT_SPEECH_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`cut_speech has no ${extra.join(", ")}; it takes layer, words, spans, pauses, restore, ripple and morph.`), { suggestions: closest(extra[0], ["words", "spans", "pauses", "restore", "ripple", "morph"]) });
  if (typeof operation.layerId !== "string") throw new Error("cut_speech needs layer: the audio or video layer with the voice.");
}

// place_broll {sceneId, speechId, layerIds, about, lead?}: an unknown field is refused here, before
// the voice is transcribed; the engine checks the layers and the words (engine/broll.js).
const PLACE_BROLL_FIELDS = new Set(["type", "sceneId", "speechId", "layerIds", "about", "lead"]);
function checkPlaceBroll(operation) {
  const extra = Object.keys(operation).filter((key) => !PLACE_BROLL_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`place_broll has no ${extra.join(", ")}; it takes speech, clips and lead.`), { suggestions: closest(extra[0], ["speech", "clips", "lead"]) });
  if (typeof operation.speechId !== "string") throw new Error("place_broll needs speech: the audio or video layer with the voice.");
  if (!Array.isArray(operation.layerIds) || !operation.layerIds.length || !operation.about?.every((item) => typeof item === "string"))
    throw new Error('place_broll needs clips: {"<video layer>":"<a few words the voice says about it>"}.');
}

// keep_line {sceneId, layerId, line? | from?, to?, text?, subtitle?, look?, name?, duckId?, duckNone?, dip?}: an unknown
// field is refused here, before the clip is transcribed; the engine checks the values (engine/keepLine.js).
const KEEP_LINE_FIELDS = new Set(["type", "sceneId", "layerId", "line", "from", "to", "text", "subtitle", "look", "name", "duckId", "duckNone", "dip"]);
function checkKeepLine(operation) {
  const extra = Object.keys(operation).filter((key) => !KEEP_LINE_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`keep_line has no ${extra.join(", ")}; it takes layer, line or from and to, text, subtitle, look, name, duck and dip.`), { suggestions: closest(extra[0], ["line", "from", "to", "text", "subtitle", "duck", "dip"]) });
  if (typeof operation.layerId !== "string") throw new Error("keep_line needs layer: the video or audio layer with the spoken line.");
}

// color_filter {sceneId, layerId | layerIds, filter, strength?}: checked by the engine (engine/colorFilter.js).
const COLOR_FILTER_FIELDS = new Set(["type", "sceneId", "layerId", "layerIds", "filter", "strength"]);
function checkColorFilter(operation) {
  const extra = Object.keys(operation).filter((key) => !COLOR_FILTER_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`color_filter has no ${extra.join(", ")}; it takes layer or layers, filter and strength.`), { suggestions: closest(extra[0], ["layers", "filter", "strength"]) });
}

// sync_clips {sceneId, layerId, toId, search?, at?}: an unknown field is refused here, before any
// sound is decoded; the engine checks the layers and `at` (engine/clipSync.js).
const SYNC_CLIPS_FIELDS = new Set(["type", "sceneId", "layerId", "toId", "search", "at"]);
function checkSyncClips(operation) {
  const extra = Object.keys(operation).filter((key) => !SYNC_CLIPS_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`sync_clips has no ${extra.join(", ")}; it takes layer, to, search and at.`), { suggestions: closest(extra[0], ["to", "search", "at"]) });
  if (typeof operation.layerId !== "string") throw new Error("sync_clips needs layer: the video or audio layer to move.");
  if (typeof operation.toId !== "string") throw new Error("sync_clips needs to: the video or audio layer to play in step with.");
  if (operation.search !== undefined && !(typeof operation.search === "number" && operation.search > 0))
    throw new Error("search is how many seconds either way of the clips' current placement to look, a number above 0.");
}

// match_color {sceneId, layerId | layerIds, toId, at?}: an unknown field is refused here, before
// any frame is decoded (color-operation.mjs runMatchColor does the rest).
const MATCH_COLOR_FIELDS = new Set(["type", "sceneId", "layerId", "layerIds", "toId", "at"]);
function checkMatchColor(operation) {
  const extra = Object.keys(operation).filter((key) => !MATCH_COLOR_FIELDS.has(key));
  if (extra.length) throw Object.assign(new Error(`match_color has no ${extra.join(", ")}; it takes layer or layers, to and at.`), { suggestions: closest(extra[0], ["layers", "to", "at"]) });
  if (typeof operation.layerId !== "string" && !Array.isArray(operation.layerIds)) throw new Error("match_color needs layer or layers: the footage to grade.");
  if (typeof operation.toId !== "string") throw new Error("match_color needs to: the video or image layer whose color to match.");
  if (operation.at !== undefined && !(typeof operation.at === "number" && operation.at >= 0)) throw new Error("at is the scene time (seconds) of the reference frame, a number from 0.");
}

// track {sceneId, layerId, at, point | box, name?} and pin {sceneId, layerId, to, offset?, scale?}:
// wrong fields are refused here, before any frame is decoded (track-operation.mjs does the rest).
const TRACK_FIELDS = { track: ["at", "point", "box", "name"], pin: ["to", "offset", "scale"] };
// stabilize {sceneId, layerId, smooth?, zoom?}: checked here, before any frame is decoded.
const STABILIZE_FIELDS = ["smooth", "zoom"];
function checkStabilize(operation) {
  const extra = Object.keys(operation).filter((key) => !["type", "sceneId", "layerId", ...STABILIZE_FIELDS].includes(key));
  if (extra.length) throw Object.assign(new Error(`stabilize has no ${extra.join(", ")}; it takes layer, smooth and zoom.`), { suggestions: closest(extra[0], STABILIZE_FIELDS) });
  if (typeof operation.layerId !== "string") throw new Error("stabilize needs layer: the video layer to steady.");
  if (operation.smooth !== undefined && !(typeof operation.smooth === "number" && operation.smooth >= 0.2 && operation.smooth <= 5)) throw new Error("smooth is the seconds the camera path is smoothed over, from 0.2 to 5 (default 1).");
  if (operation.zoom !== undefined && !(typeof operation.zoom === "number" && operation.zoom >= 1 && operation.zoom <= 1.15)) throw new Error("zoom is the fixed crop zoom from 1 to 1.15 (left out, the least that hides the edges).");
}

function checkTrackOrPin(operation, type) {
  const allowed = new Set(["type", "sceneId", "layerId", ...TRACK_FIELDS[type]]);
  const extra = Object.keys(operation).filter((key) => !allowed.has(key));
  if (extra.length) throw Object.assign(new Error(`${type} has no ${extra.join(", ")}; it takes layer, ${TRACK_FIELDS[type].join(", ")}.`), { suggestions: closest(extra[0], TRACK_FIELDS[type]) });
  if (typeof operation.layerId !== "string") throw new Error(type === "track" ? "track needs layer: the video layer to follow an object in." : "pin needs layer: the layer that follows the track.");
  const numbers = (value, length) => Array.isArray(value) && value.length === length && value.every((item) => typeof item === "number" && Number.isFinite(item));
  if (type === "track") {
    if (!(typeof operation.at === "number" && operation.at >= 0)) throw new Error("track needs at: the second of the video file where point or box is (look {mode:\"source\"} shows the file's frames).");
    if ((operation.point === undefined) === (operation.box === undefined)) throw new Error("track needs point [x, y] or box [x, y, w, h] (one of them), in % of the source frame.");
    if (operation.point !== undefined && !(numbers(operation.point, 2) && operation.point.every((value) => value >= 0 && value <= 100))) throw new Error("point is [x, y] in % of the source frame (0 to 100).");
    if (operation.box !== undefined && !(numbers(operation.box, 4) && operation.box[0] >= 0 && operation.box[1] >= 0 && operation.box[2] > 0 && operation.box[3] > 0 && operation.box[0] + operation.box[2] <= 100.05 && operation.box[1] + operation.box[3] <= 100.05))
      throw new Error("box is [x, y, w, h] in % of the source frame, inside it.");
    if (operation.name !== undefined && !(typeof operation.name === "string" && operation.name.trim() && operation.name.length <= 128)) throw new Error("name is the track's name (text), which pin {to} uses.");
  } else {
    if (operation.to !== null && !(typeof operation.to === "string" && operation.to)) throw new Error("pin needs to: the name of a track in this scene (track {name}), or null to let go.");
    if (operation.offset !== undefined && !numbers(operation.offset, 2)) throw new Error("offset is [dx, dy] in scene pixels from the track's center.");
    if (operation.scale !== undefined && typeof operation.scale !== "boolean") throw new Error("scale is true to grow and shrink with the tracked object.");
  }
}

// cut_out {sceneId, layerId, output?, engine?, grow?, feather?, color?, invert?, points?, exclude?, time?, above?, name?} is
// checked here, so a wrong value is refused before any picture is decoded. It names the new layer
// now ("<layer name>-<output>" without a file extension, or `name`), so later operations in the
// same edit can use that name. The agent service does the rest (cutout-operation.mjs runCutOut).
const CUTOUT_FIELDS = new Set(["type", "sceneId", "layerId", "output", "engine", "grow", "feather", "color", "invert", "points", "exclude", "time", "referenceId", "behindText", "name"]);
// [[x%, y%], …] of the clip's own picture, 1 to 8 points.
function checkPoints(name, value) {
  const point = (item) => Array.isArray(item) && item.length === 2 && item.every((part) => typeof part === "number" && part >= 0 && part <= 100);
  if (!(Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(point)))
    throw new Error(`${name} must be 1 to 8 points [x, y] in % of the clip's own picture (0 to 100, from its top left; look mode:"source" shows the grid), not ${JSON.stringify(value)}.`);
}
function checkCutOut(operation, resolver) {
  const extra = Object.keys(operation).filter((key) => !CUTOUT_FIELDS.has(key));
  if (extra.length) {
    const suggestions = closest(extra[0], ["output", "engine", "grow", "feather", "color", "invert", "points", "exclude", "time", "above", "behind", "name"]);
    throw Object.assign(new Error(`cut_out has no ${extra.join(", ")}; it takes layer, output, engine, grow, feather, color, invert, points, exclude, time, above, behind and name.`), { suggestions });
  }
  if (typeof operation.layerId !== "string") throw new Error("cut_out needs layer: the video or image layer whose subject to cut out.");
  if (operation.behindText && (operation.output ?? "subject") !== "subject") throw new Error('behind puts a layer behind the person, so it takes output "subject" (the default).');
  const output = operation.output ?? "subject";
  if (!CUTOUT_OUTPUTS.includes(output))
    throw Object.assign(new Error(`output must be ${CUTOUT_OUTPUTS.map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(operation.output)}.`), { suggestions: closest(String(operation.output), CUTOUT_OUTPUTS) });
  if (operation.engine !== undefined && !CUTOUT_ENGINES.includes(operation.engine))
    throw Object.assign(new Error(`engine must be ${CUTOUT_ENGINES.map((name) => `"${name}"`).join(", ")}, not ${JSON.stringify(operation.engine)}.`), { suggestions: closest(String(operation.engine), CUTOUT_ENGINES) });
  if (operation.grow !== undefined && !(typeof operation.grow === "number" && Math.abs(operation.grow) <= 100))
    throw new Error(`grow must be a number of pixels from -100 to 100 (positive makes the subject bigger), not ${JSON.stringify(operation.grow)}.`);
  if (operation.feather !== undefined && !(typeof operation.feather === "number" && operation.feather >= 0 && operation.feather <= 200))
    throw new Error(`feather must be a number of pixels from 0 to 200 (how wide the soft edge is), not ${JSON.stringify(operation.feather)}.`);
  if (operation.color !== undefined) {
    if (output !== "silhouette") throw new Error('color is the color of output "silhouette"; the subject keeps its own colors and a matte is white on black.');
    if (typeof operation.color !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(operation.color))
      throw new Error(`color must be an opaque hex color such as "#ffffff", not ${JSON.stringify(operation.color)} (fade the layer with opacity).`);
  }
  if (operation.invert !== undefined) {
    if (output !== "matte") throw new Error('invert is for output "matte" (black subject on white, so a mask shows everything but the subject).');
    if (typeof operation.invert !== "boolean") throw new Error(`invert must be true or false, not ${JSON.stringify(operation.invert)}.`);
  }
  if (operation.points !== undefined) {
    checkPoints("points", operation.points);
    if (operation.engine === "person") throw new Error('points pick among the objects the subject engine finds; leave engine out or send engine:"subject".');
  }
  for (const field of ["exclude", "time"]) if (operation[field] !== undefined && operation.points === undefined)
    throw new Error(`${field} goes with points: points name the objects to keep, exclude the ones to drop and time the moment they are pointed at.`);
  if (operation.exclude !== undefined) checkPoints("exclude", operation.exclude);
  if (operation.time !== undefined && !(typeof operation.time === "number" && operation.time >= 0 && operation.time <= 86400))
    throw new Error(`time must be seconds into the clip's file (0 or more) where points are measured, not ${JSON.stringify(operation.time)}.`);
  if (operation.name !== undefined && !(typeof operation.name === "string" && operation.name.trim() && operation.name.length <= 200))
    throw new Error("name must be a name of 1 to 200 characters for the new layer.");
  const layerName = resolver.nameOf("layer", operation.layerId) ?? operation.layerId;
  const base = layerName.replace(/\.(?:mp4|webm|mov|png|jpe?g|webp|gif)$/i, "") || layerName;
  operation.cutoutName = (operation.name ?? `${base}-${output}`).slice(0, 200);
  delete operation.name;
  operation.cutoutId = idFromName(operation.cutoutName, "layer", resolver) || randomUUID();
}

function checkCount(operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("ops must be a list of 1 to 200 operations.");
  if (operations.length > 200) throw new Error(`ops has ${operations.length} operations; send at most 200 per edit.`);
}

// add_layer {animations: [{preset, start, duration, …}]}: each entry is an add_animation op on
// the new layer, run right after it. Returns the layer op and the entries, or null.
function inlineAnimations(raw) {
  if ((raw?.op ?? raw?.type) !== "add_layer" || raw.animations === undefined) return null;
  if (!Array.isArray(raw.animations)) throw new Error('animations is a list of add_animation fields, such as [{"preset":"preset-fade", "start":0, "duration":0.4}].');
  const { animations, ...layer } = raw;
  return { layer, animations };
}

// A refused inline animation's example is the add_layer with that entry written as it works (an
// add_animation example becomes its inline entry), so `fix` can send it in the op's place.
function inlineExample(raw, number, example) {
  if (!Array.isArray(raw?.animations) || !example || typeof example !== "object" || (example.op ?? example.type) !== "add_animation") return null;
  const { op, type, layer, layerId, scene, sceneId, ...fields } = example;
  const entry = fields.animation && typeof fields.animation === "object" && Object.keys(fields).length === 1 ? fields.animation : fields;
  return { ...raw, animations: raw.animations.map((item, index) => (index === number ? entry : item)) };
}

// The kind an add_animation makes: its animation's, or its preset's (a catalog preset is in
// unless mode is out).
function animationKind(operation) {
  if (operation.animation?.kind) return operation.animation.kind;
  if (operation.effect !== undefined) return "effect";
  const preset = String(operation.preset ?? "");
  return PRESETS.find((entry) => entry.id === preset)?.kind ?? (operation.mode === "out" ? "out" : "in");
}

function translateInlineAnimation(entry, number, layerOperation, resolver, document, raw) {
  try {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("each one is an object of add_animation fields.");
    const { op, type, layer, layerId, ...fields } = entry;
    if ((op ?? type ?? "add_animation") !== "add_animation") throw new Error(`each one is an add_animation, not ${op ?? type}.`);
    if (layer !== undefined || layerId !== undefined) throw new Error("it belongs to the new layer; leave out layer.");
    // An entry written as an animation ({kind:"custom", name, start, duration, from, to}, the
    // `animation` of add_animation, as edits.md shows it) is that animation. With a preset or
    // an effect, kind is not read this way (a preset's exit is mode:"out").
    const asAnimation = typeof fields.kind === "string" && fields.animation === undefined && fields.preset === undefined && fields.effect === undefined;
    return translateOne({ ...(asAnimation ? { animation: fields } : fields), type: "add_animation", layerId: layerOperation.properties.id, sceneId: layerOperation.sceneId }, resolver, document);
  } catch (error) {
    const example = inlineExample(raw, number, error.example);
    throw Object.assign(new Error(`animations[${number}]: ${error.message}`), { suggestions: error.suggestions ?? [], createdIds: error.createdIds,
      ...(example ? { example } : {}) });
  }
}

/**
 * Translates every operation and collects the problems instead of stopping at the first.
 * Returns { operations, problems, blocked }: a refused operation is null in `operations`
 * and an OperationError in `problems`; `blocked` maps the number of each operation that uses
 * something a refused operation would have made to that operation's number. An add_layer with
 * inline animations is a list: the layer op, then one add_animation op for each.
 */
export function translateAll(operations, resolver, document) {
  checkCount(operations);
  const translated = [];
  const problems = [];
  const blocked = new Map();
  const failedIds = new Map();
  operations.forEach((raw, index) => {
    let operation;
    const made = [];
    // add_text → add_layer, add_layer {layer:{…}} → its fields, {layers:[…]} → one op per layer, …
    const shaped = reshapeOperation(raw, resolver.fixes, AGENT_OPERATION_TYPES);
    const parts = [];
    // Each part of a reshaped op ({layers:[…]} is one op per layer) is tried, so a refusal
    // names every layer of the list that is not found, not only the first.
    const errors = [];
    for (const part of Array.isArray(shaped) ? shaped : [shaped]) {
      // A layer that went with its group earlier in this edit: its delete is passed on as is,
      // and the service skips it with a note ("went with g1").
      const gone = (part?.type ?? part?.op) === "delete_layer" && resolver.removedId("layer", part.layerId ?? part.layer);
      if (gone) {
        parts.push({ type: "delete_layer", layerId: gone });
        continue;
      }
      try {
        const inline = inlineAnimations(part);
        const first = translateOne(inline ? inline.layer : part, resolver, document);
        made.push(...createdIds(first));
        parts.push(first);
        inline?.animations.forEach((entry, number) => {
          const animation = translateInlineAnimation(entry, number, first, resolver, document, part);
          made.push(...createdIds(animation));
          parts.push(animation);
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!errors.length) operation = parts.length === 1 ? parts[0] : parts;
    else {
      const [error] = errors;
      const problem = new OperationError(index, Array.isArray(shaped) ? shaped[0] : shaped, error);
      problem.missing = errors.filter((each) => each instanceof ReferenceError && !each.ambiguous && typeof each.ref === "string" && each.kind)
        .map((each) => ({ kind: each.kind, ref: each.ref }));
      if (errors.length > 1) problem.message += ` ${errors.length - 1} more of its ${shaped.length} parts were refused too${problem.missing.length > 1 ? " (see missing)" : ""}.`;
      problems.push(problem);
      // A refused add_layer leaves a plain layer in its place (or, when only an inline animation
      // was refused, the layer and its other animations), so the ops that use it are still tried.
      const standIn = parts.length ? parts : error.standIn ?? null;
      translated.push(standIn);
      // What it would have made is declared by now; remember it so its users are skipped.
      const kept = new Set((standIn ? [standIn].flat() : []).flatMap(createdIds));
      for (const id of [...made, ...errors.flatMap((each) => each.createdIds ?? [])]) if (!kept.has(id)) failedIds.set(id, index);
      return;
    }
    const all = Array.isArray(operation) ? operation : [operation];
    const cause = all.flatMap(referencedIds).find((id) => failedIds.has(id));
    if (cause !== undefined) {
      blocked.set(index, failedIds.get(cause));
      for (const id of all.flatMap(createdIds)) failedIds.set(id, failedIds.get(cause));
      translated.push(null);
      return;
    }
    translated.push(operation);
  });
  return { operations: translated, problems, blocked };
}

/** Translates every operation, throwing an OperationError at the first problem. */
export function translateOperations(operations, resolver, document) {
  const { operations: translated, problems } = translateAll(operations, resolver, document);
  if (problems.length) throw problems[0];
  return translated.flat();
}

export { ReferenceError };
