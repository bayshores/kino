// Runs the quality checker (engine/quality/) on a kino document for the agent service, and turns
// its findings into the agent's words: layer names or codes, and fixes as edit operations.
//
// A finding here: { severity: "error" | "warn" | "info", rule, ref, at?, until?, message,
//   measured?, required?, bbox?, fix? (an op, a list of ops, or an instruction), auto?, waived? }
// `info` findings last 2 samples or less; they are counted, not listed. A waived finding keeps
// its severity but does not count (document.checkWaivers, set with the waive_check operation).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mainScene } from "../../engine/board.js";
import { cardNames } from "../../engine/deck.js";
import { referenceSignature } from "../../engine/quality/layoutSignature.js";
import { shiftAnimation } from "../../engine/animationShift.js";
import { isComposedAnimation } from "../../engine/animationTree.js";
import { evaluateLayer } from "../../engine/animation.js";
import { moveLayerByWorldDelta } from "../../engine/geometry.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { RULES, runQuality } from "../../engine/quality/index.js";
import { kinoTimeline } from "../../engine/quality/kinoTimeline.js";
import { judderBlurId, techniqueCounts, techniquesUsed } from "../../engine/quality/techniques.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";
import { SCREEN_NAME } from "../../engine/movePicks.js";
import { BACKGROUND_OWNER_ID } from "../../engine/sceneBackground.js";
import { refName, sec } from "./describe.mjs";
import { keyedProperties } from "./overridden-values.mjs";
import { createFrameReuse } from "./frame-reuse.mjs";
import { sceneKey } from "./look.mjs";
import { inBackground, waitForQuiet } from "../render-activity.mjs";
import { round as round3 } from "../../engine/numbers.js";

const CACHE_SIZE = 64;
// The models kept are also bounded by the bytes of their samples: a ten-minute scene with a
// caption page every 3 s has 402 items sampled 9,001 times, about 116 MB.
const CACHE_BYTES = 512 * 1024 * 1024;
// The longest a check waits, in all, on old videos' first frame facts (one FFmpeg run each).
const FACTS_WAIT_MS = 8000;

// Bytes of a model's samples (typed arrays; a plain array counts 8 bytes a slot).
function modelBytes(model) {
  let bytes = 0;
  for (const item of model.items) for (const values of Object.values(item.samples)) bytes += values ? values.byteLength ?? values.length * 8 : 0;
  return bytes;
}

// Every string in a value, and each part of a component path ("instance/layer"): the IDs a
// drawn scene mentions, among others.
function stringsIn(value) {
  const found = new Set();
  const stack = [value];
  while (stack.length) {
    const next = stack.pop();
    if (typeof next === "string") {
      found.add(next);
      if (next.includes("/")) for (const part of next.split("/")) found.add(part);
    } else if (next && typeof next === "object") for (const child of Array.isArray(next) ? next : Object.values(next)) stack.push(child);
  }
  return found;
}

// Findings depend on the drawn scene, the project's quality fields, the short codes used in
// messages (sceneBase), whether pixels were checked, and the output frame rate (keyOf). Only
// the codes of IDs the drawn scene mentions count, so a layer added to another scene keeps
// this scene's check.
// The brand's fonts: every font of the document's brand kits (set_brand), then the families the
// brief names (briefFonts). off_brand_font holds the texts to them.
export function brandFontsOf(document, briefFonts = []) {
  const families = [...(document.brands ?? []).flatMap((brand) => (brand.fonts ?? []).map((font) => font?.family)), ...briefFonts].filter(Boolean);
  return [...new Map(families.map((family) => [String(family).toLowerCase(), family])).values()];
}

// The marker cues (set_cues): pacing_jump lets the pace change at them.
const markerCues = (document) => (document.cues ?? []).filter((cue) => cue.kind === "marker");
// The storyboard's shots on the scene they plan (the main scene): plain_beats judges each shot,
// and offers a plain one the moves that fit what it holds (media, text, subject, sound, why).
const boardShots = (document, scene) => (document.board?.shots?.length && mainScene(document)?.id === scene.id
  ? document.board.shots.map((shot) => ({ cue: shot.cue, dur: shot.dur, move: shot.move?.kind ? { kind: shot.move.kind, name: shot.move.name } : null,
    media: shot.media, text: shot.text, subject: shot.subject, sound: shot.sound, why: shot.why })) : null);
function sceneBase(document, scene, { fonts, codes, styleSpec = null, deck = null, briefFonts = [], length = null, asks = null }) {
  const expanded = expandComponents(document, scene.id, { fonts });
  // The brief's style spec and the deck change what the style rules say, so they are part of the key too.
  const fields = { videoType: document.videoType ?? null, rhythm: document.rhythm ?? null, assertions: scene.assertions ?? null, rests: scene.rests ?? null, sources: document.sources ?? null, style: styleSpec, deck: deck ? cardNames(deck) : null, brandFonts: brandFontsOf(document, briefFonts), length, asks, markers: markerCues(document), beatCues: (document.cues ?? []).filter((cue) => cue.kind === "beat" || cue.kind === "onset").map((cue) => cue.time), clipLinks: document.clipLinks ?? null, board: boardShots(document, scene) };
  const named = stringsIn(expanded);
  const used = Object.entries(codes?.byId ?? {}).filter(([id]) => named.has(id));
  return `${sceneKey(expanded, fonts)}\n${JSON.stringify(fields)}\n${JSON.stringify(used)}`;
}
// The scene that is the video: the longest shown scene (not a component, not a variant copy).
export function videoScene(document) {
  const shown = document.scenes.filter((scene) => !scene.isComponent && !(scene.variant && scene.variant.of !== scene.id));
  return shown.reduce((longest, scene) => (!longest || scene.duration > longest.duration ? scene : longest), null);
}
const keyOf = (base, { pixels, outputFps }) => createHash("sha256").update(`${base}\n${pixels}\n${outputFps}`).digest("hex").slice(0, 40);

// How a finding's item is named: its layer's name or code, a component copy as instance›layer.
function refOfItem(item, model, codes) {
  if (!item) return refName(model.sceneId, codes);
  const source = item.source ?? {};
  if (source.sceneBackground) return `${refName(model.sceneId, codes)}.background`;
  if (source.componentBackground) return `${refName(source.instanceId, codes)}.background`;
  if (source.componentPath) return `${refName(source.instanceId, codes)}›${refName(source.layerId, codes)}`;
  return refName(source.layerId ?? item.id, codes);
}

// The layer in the document a finding's item stands for, and the scene it is in.
function sourceLayer(document, item) {
  const source = item?.source;
  if (!source || source.sceneBackground || source.componentBackground) return null;
  const scene = document.scenes.find((entry) => entry.id === source.sceneId);
  const layer = scene?.layers.find((entry) => entry.id === source.layerId);
  return layer ? { scene, layer } : null;
}

// The update_animation properties that move each of `animations` by (dx, dy) in the layer's
// own space, as [{animation, properties}]: an animation's x and y (and motion path) are places
// in the scene, so a Slide In ends at the layer's own y and moves with it, as place and align do.
// With `scale`, the scales the animations set are multiplied by it too (a layer grown 10% keeps
// its push from 100% to 105% as 110% to 115.5%).
function shiftedAnimations(animations, dx, dy, scale = 1) {
  const changes = [];
  const position = (value, change) => Math.round((value + change) * 1e6) / 1e6 + 0;
  const scaled = (values) => {
    if (scale === 1 || !values || typeof values !== "object" || !("scaleX" in values || "scaleY" in values)) return values;
    const times = (value) => (Number.isFinite(value) ? Math.round(value * scale * 1e4) / 1e4 : value);
    return { ...values, ...("scaleX" in values ? { scaleX: times(values.scaleX) } : {}), ...("scaleY" in values ? { scaleY: times(values.scaleY) } : {}) };
  };
  for (const animation of Array.isArray(animations) ? animations : []) {
    if (!animation || typeof animation !== "object") continue;
    const moved = dx || dy ? shiftAnimation({ ...animation, animations: undefined }, dx, dy, position) : animation;
    const next = { from: scaled(moved.from), to: scaled(moved.to), motionPath: moved.motionPath };
    let properties = Object.fromEntries(["from", "to", "motionPath"].filter((key) => next[key] !== animation[key]).map((key) => [key, next[key]]));
    // A keyed animation takes its moved keys (it refuses from and to).
    if (animation.keys?.length) {
      const keys = moved.keys.map((key) => ({ ...key, value: scaled(key.value) }));
      properties = keys.some((key, index) => key.value !== animation.keys[index].value) ? { keys } : {};
    }
    if (Object.keys(properties).length) changes.push({ animation, properties });
    if (isComposedAnimation(animation)) changes.push(...shiftedAnimations(animation.animations, dx, dy, scale));
  }
  return changes;
}

const familyKey = (family) => String(family ?? "").split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

// The weight kino draws `family` at for `weight`: the nearest loaded one (any weight of a
// variable font), or `weight` itself when the family is not loaded (set_font downloads it).
function nearestWeight(fonts, family, weight, style = "normal") {
  if (!fonts?.resolve) return weight;
  try {
    const face = fonts.resolve({ fontFamily: family, fontWeight: weight, fontStyle: style });
    if (familyKey(face.family) !== familyKey(family)) return weight;
    return face.font?.variationAxes?.wght ? weight : Number(face.weight) || weight;
  } catch { return weight; }
}

// A readable ID for a layer kino adds next to `base` ("title-plate"), not used in the scene yet.
function freeId(scene, base) {
  const taken = new Set(scene.layers.map((layer) => layer.id));
  if (!taken.has(base)) return base;
  for (let number = 2; ; number += 1) if (!taken.has(`${base}-${number}`)) return `${base}-${number}`;
}

// A readable ID for an animation kino adds ("title.hold"), not used in the scene yet. Fixed IDs
// let a later fix in the same check name it (a random one would differ when the edit is saved).
function freeAnimationId(scene, base) {
  const taken = new Set(scene.layers.flatMap((layer) => (Array.isArray(layer.animations) ? layer.animations : []).map((animation) => animation?.id)));
  if (!taken.has(base)) return base;
  for (let number = 2; ; number += 1) if (!taken.has(`${base}-${number}`)) return `${base}-${number}`;
}

// The animations that show or hide a layer, or fade it, copied for a layer drawn with it (a
// plate under a text): show and hide as they are, and only the
// opacity of the others, times `opacity` (the new layer's own).
export function timingCopies(animations, opacity) {
  const copies = [];
  for (const animation of Array.isArray(animations) ? animations : []) {
    if (!animation || typeof animation !== "object" || animation.enabled === false) continue;
    // The curve's intensity goes too (a steps easing's count, a spring's bounce).
    const intensity = animation.intensity !== undefined ? { intensity: animation.intensity } : {};
    if (animation.kind === "show" || animation.kind === "hide") { copies.push({ kind: animation.kind, name: animation.name ?? animation.kind, start: animation.start }); continue; }
    // A keyed fade or speed change is copied key by key (only its opacity, times `opacity`).
    if (animation.keys?.length && animation.kind === "custom") {
      const key = Number.isFinite(animation.to?.speed) ? "speed" : Number.isFinite(animation.to?.opacity) ? "opacity" : null;
      if (key) copies.push({ kind: "custom", name: `${animation.name ?? "Fade"} (copy)`, start: animation.start, duration: animation.duration, easing: animation.easing ?? "smooth", ...intensity,
        keys: animation.keys.map((entry) => ({ ...entry, value: { [key]: key === "speed" ? entry.value.speed : round3(entry.value.opacity * opacity) } })) });
      continue;
    }
    if (Number.isFinite(animation.to?.speed)) { copies.push({ kind: "custom", name: animation.name ?? "Speed", start: animation.start, duration: animation.duration, easing: animation.easing, ...intensity, from: { speed: animation.from?.speed ?? 1 }, to: { speed: animation.to.speed } }); continue; }
    const from = animation.from?.opacity, to = animation.to?.opacity;
    if (!Number.isFinite(from) && !Number.isFinite(to)) continue;
    copies.push({
      kind: ["in", "out"].includes(animation.kind) ? animation.kind : "custom", name: `${animation.name ?? "Fade"} (copy)`, start: animation.start, duration: animation.duration, easing: animation.easing ?? "smooth", ...intensity,
      ...(Number.isFinite(from) ? { from: { opacity: round3(from * opacity) } } : {}), ...(Number.isFinite(to) ? { to: { opacity: round3(to * opacity) } } : {}),
    });
  }
  return copies;
}

const LAYER_FIXES = new Set(["transform", "plate", "motion", "retime", "smear"]);

/**
 * The polish fixes that change a layer and its animations (engine/quality/rules/polish.js), as
 * {fix: ops, auto}; null for the other kinds. Each needs the layer itself (not a component copy):
 *   transform {itemId, scale, dx, dy}  scale around its middle, then move (its animations too)
 *   plate {itemId, box, fill, opacity, radius}  a rectangle under a text while it shows
 *   motion {itemId, technique, start, duration, easing, scale | dx, dy | spacing}  a slow move through a hold
 *   retime {itemId, end | start}  the text leaves by `end`, or comes on at `start`
 *   smear {itemId, animations}  directional-blur keys added to the layer (motion blur)
 */
function layerFix(fix, model, document, codes) {
  if (!LAYER_FIXES.has(fix.kind)) return null;
  const item = model.itemOf(fix.itemId);
  const found = sourceLayer(document, item);
  if (!found || item.source.componentPath) return { fix: item ? `${refOfItem(item, model, codes)} is a copy of a component; change it in the component's scene.` : undefined, auto: false };
  const { layer, scene } = found;
  const ref = refName(layer.id, codes);
  const sceneField = scene.id !== model.sceneId ? { sceneId: refName(scene.id, codes) } : {};
  const auto = Boolean(fix.auto);
  const updates = (changes) => changes.map(({ animation, properties }) => ({ op: "update_animation", animationId: refName(animation.id, codes), ...sceneField, properties }));
  if (fix.kind === "transform") {
    const place = moveLayerByWorldDelta(layer, scene.layers, fix.dx, fix.dy);
    const [x, y] = [Math.round(place.x), Math.round(place.y)];
    const properties = { x, y, scaleX: round3((layer.scaleX ?? 1) * fix.scale), scaleY: round3((layer.scaleY ?? 1) * fix.scale) };
    return { fix: [{ op: "update_layer", layerId: ref, ...sceneField, properties }, ...updates(shiftedAnimations(layer.animations, x - (layer.x ?? 0), y - (layer.y ?? 0), fix.scale))], auto };
  }
  if (fix.kind === "plate") {
    if (layer.parentId) return { fix: "Put a solid plate under the text (add_layer a rectangle, then move_layers below it).", auto: false };
    const name = freeId(scene, `${layer.id}-plate`);
    const { box } = fix;
    const properties = { name, role: "decor", x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, fill: fix.fill, opacity: fix.opacity, radius: fix.radius };
    const animations = timingCopies(layer.animations, fix.opacity).map((animation, index) => ({ animation: { id: `${name}.${index + 1}`, ...animation } }));
    return { fix: [{ op: "add_layer", ...sceneField, layerType: "rectangle", properties, ...(animations.length ? { animations } : {}) },
      { op: "move_layers", ...sceneField, layerIds: [name], position: "below", referenceId: ref }], auto };
  }
  if (fix.kind === "motion") {
    const state = evaluateLayer(layer, fix.start);
    const end = fix.start + fix.duration;
    let from, to, change;
    if (fix.technique === "slow-push") {
      from = { scaleX: round3(state.scaleX ?? 1), scaleY: round3(state.scaleY ?? 1) };
      to = { scaleX: round3(from.scaleX * fix.scale), scaleY: round3(from.scaleY * fix.scale) };
      change = (values) => ({ ...values, ...("scaleX" in values ? { scaleX: round3(values.scaleX * fix.scale) } : {}), ...("scaleY" in values ? { scaleY: round3(values.scaleY * fix.scale) } : {}) });
      // frozen_screen: the push also moves (dx, dy frame pixels), so it grows about a region.
      if (fix.dx || fix.dy) {
        const place = moveLayerByWorldDelta(layer, scene.layers, fix.dx ?? 0, fix.dy ?? 0);
        const [dx, dy] = [place.x - (layer.x ?? 0), place.y - (layer.y ?? 0)];
        const [x, y] = [round3(state.x ?? layer.x ?? 0), round3(state.y ?? layer.y ?? 0)];
        Object.assign(from, { x, y });
        Object.assign(to, { x: round3(x + dx), y: round3(y + dy) });
        const scaled = change;
        change = (values) => ({ ...scaled(values), ...("x" in values ? { x: round3(values.x + dx) } : {}), ...("y" in values ? { y: round3(values.y + dy) } : {}) });
      }
    } else if (fix.technique === "type-kinetic") {
      from = { letterSpacing: round3(state.letterSpacing ?? 0) };
      to = { letterSpacing: round3(from.letterSpacing + fix.spacing) };
      change = (values) => ("letterSpacing" in values ? { ...values, letterSpacing: round3(values.letterSpacing + fix.spacing) } : values);
    } else {
      // A drift in the frame turned into the layer's own units (its groups may be scaled).
      const place = moveLayerByWorldDelta(layer, scene.layers, fix.dx, fix.dy);
      const [dx, dy] = [place.x - (layer.x ?? 0), place.y - (layer.y ?? 0)];
      const keys = [...(fix.dx ? ["x"] : []), ...(fix.dy ? ["y"] : [])];
      from = Object.fromEntries(keys.map((key) => [key, round3(state[key] ?? 0)]));
      to = Object.fromEntries(keys.map((key) => [key, round3(from[key] + (key === "x" ? dx : dy))]));
      change = (values) => ({ ...values, ...("x" in values ? { x: round3(values.x + dx) } : {}), ...("y" in values ? { y: round3(values.y + dy) } : {}) });
    }
    const names = { "slow-push": "Slow push", "type-kinetic": "Letters spread", drift: "Drift" };
    // frozen_screen over a recipe's own 2 to 4% hold (a scale animation spanning the stretch):
    // that hold grows by the push instead, so two animations do not fight over the scale. So does
    // held_static's end card push (card) over a push of the layer's own.
    const overlap = (animation) => Math.min(end, animation.start + (animation.duration ?? 0)) - Math.max(fix.start, animation.start);
    const held = fix.technique === "slow-push" && (fix.dx || fix.dy || fix.card) ? (Array.isArray(layer.animations) ? layer.animations : []).find((animation) => animation?.kind === "custom"
      && !animation.keys && animation.from && animation.to && "scaleX" in animation.to && overlap(animation) >= 0.6 * fix.duration) : null;
    if (held) {
      // The hold becomes the push: from where it starts, grown by the push and moved by dx, dy.
      const start = { x: layer.x ?? 0, y: layer.y ?? 0, scaleX: 1, scaleY: 1, ...held.from };
      const next = { ...held.to, scaleX: round3(start.scaleX * fix.scale), scaleY: round3(start.scaleY * fix.scale), x: round3(start.x + ((to.x ?? 0) - (from.x ?? 0))), y: round3(start.y + ((to.y ?? 0) - (from.y ?? 0))) };
      const old = { ...start, ...held.to };
      const heldEnd = held.start + (held.duration ?? 0);
      const shift = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key in next && typeof value === "number"
        ? round3(key.startsWith("scale") ? value * (next[key] / (old[key] || 1)) : value + next[key] - old[key]) : value]));
      const after = (Array.isArray(layer.animations) ? layer.animations : []).filter((animation) => animation !== held && animation?.from && animation.start >= heldEnd - 1e-3
        && JSON.stringify(shift(animation.from)) !== JSON.stringify(animation.from));
      return { fix: [{ op: "update_animation", animationId: refName(held.id, codes), ...sceneField, properties: { easing: fix.easing, from: start, to: next } },
        ...after.map((animation) => ({ op: "update_animation", animationId: refName(animation.id, codes), ...sceneField, properties: keyedProperties(animation, { from: shift(animation.from) }) }))], auto };
    }
    const add = { op: "add_animation", layerId: ref, ...sceneField, animation: { id: freeAnimationId(scene, `${layer.id}.hold`), kind: "custom", name: names[fix.technique] ?? "Hold motion", start: fix.start, duration: fix.duration, easing: fix.easing, from, to } };
    // A later animation that starts from the old value starts from the moved one, so nothing jumps.
    const later = (Array.isArray(layer.animations) ? layer.animations : []).filter((animation) => animation?.from && animation.start >= end - 1e-3 && change(animation.from) !== animation.from
      && JSON.stringify(change(animation.from)) !== JSON.stringify(animation.from));
    return { fix: [add, ...later.map((animation) => ({ op: "update_animation", animationId: refName(animation.id, codes), ...sceneField, properties: keyedProperties(animation, { from: change(animation.from) }) }))], auto };
  }
  if (fix.kind === "smear") {
    // Motion blur: directional-blur keys that follow the layer's speed (judder). The IDs name the
    // stretch's start, so two stretches of one layer fixed in one edit do not share an ID, and
    // mark the keys as kino's own (techniques.js leaves them out of the style's moves).
    const stretch = judderBlurId(layer.id, fix.animations[0]?.start ?? 0);
    return { fix: fix.animations.map((animation, index) => ({ op: "add_animation", layerId: ref, ...sceneField,
      animation: { id: freeAnimationId(scene, `${stretch}.${index + 1}`), kind: "effect", effect: "directional-blur", name: "Motion blur", ...animation } })), auto };
  }
  // retime: end the text's exit and hide by `end`, or start its entrance and show at `start`.
  const animations = Array.isArray(layer.animations) ? layer.animations : [];
  const ops = [];
  const set = (animation, start) => ops.push({ op: "update_animation", animationId: refName(animation.id, codes), ...sceneField, properties: { start: round3(start) } });
  if (fix.end != null) {
    for (const animation of animations.filter((entry) => entry.kind === "out")) if (animation.start + (animation.duration ?? 0) > fix.end) set(animation, Math.max(0, fix.end - (animation.duration ?? 0)));
    const hides = animations.filter((entry) => entry.kind === "hide" && entry.start > fix.end);
    for (const animation of hides) set(animation, fix.end);
    if (!animations.some((entry) => entry.kind === "hide")) ops.push({ op: "add_animation", layerId: ref, ...sceneField, animation: { id: freeAnimationId(scene, `${layer.id}.leave`), kind: "hide", name: "Hide", start: fix.end } });
  } else {
    const delay = fix.start - Math.min(...animations.filter((entry) => entry.kind === "in" || entry.kind === "show").map((entry) => entry.start), fix.start);
    for (const animation of animations.filter((entry) => (entry.kind === "in" || entry.kind === "show") && entry.start < fix.start)) set(animation, animation.start + delay);
    if (!animations.some((entry) => entry.kind === "in" || entry.kind === "show")) ops.push({ op: "add_animation", layerId: ref, ...sceneField, animation: { id: freeAnimationId(scene, `${layer.id}.arrive`), kind: "show", name: "Show", start: fix.start } });
  }
  return ops.length ? { fix: ops, auto } : null;
}

/** Turns a neutral fix into edit operations (agent names), or an instruction. */
function fixOps(fix, finding, model, document, codes, fonts = null) {
  if (!fix) return { fix: undefined, auto: false };
  if (fix.kind === "group") {
    // Several fixes that go together (a caption's parts moved as one): all ops, or the first hint.
    const parts = fix.changes.map((change) => fixOps({ ...change, auto: fix.auto }, finding, model, document, codes, fonts));
    const hint = parts.find((part) => typeof part.fix !== "object" || part.fix === null);
    if (hint) return { fix: hint.fix, auto: false };
    return { fix: parts.flatMap((part) => [part.fix].flat()), auto: parts.every((part) => part.auto) };
  }
  const placed = layerFix(fix, model, document, codes);
  if (placed) return placed;
  if (fix.kind === "animation") {
    // One animation of the layer, by its ID (an effect: it has no tween).
    const item = model.itemOf(fix.itemId);
    const found = sourceLayer(document, item);
    if (!found || item.source.componentPath) return { fix: item ? `${refOfItem(item, model, codes)} is a copy of a component; change it in the component's scene.` : undefined, auto: false };
    return { fix: { op: "update_animation", animationId: refName(fix.animationId, codes), ...(found.scene.id !== model.sceneId ? { sceneId: refName(found.scene.id, codes) } : {}), properties: fix.properties }, auto: Boolean(fix.auto) };
  }
  const itemOf = (id) => model.itemOf(id);
  const sceneField = (sceneId) => (sceneId && sceneId !== model.sceneId ? { sceneId: refName(sceneId, codes) } : {});
  const tweenOp = ({ tweenId, properties }) => {
    const tween = model.tweens.find((entry) => entry.id === tweenId);
    const animationId = tween?.source?.animationId;
    if (!animationId) return null;
    return { op: "update_animation", animationId: refName(animationId, codes), ...sceneField(tween.source.sceneId), properties };
  };
  const copyHint = (item) => `${refOfItem(item, model, codes)} is a copy of a component; change it in the component's scene (${refName(item.source.sceneId, codes)}).`;
  if (fix.kind === "hint") return { fix: fix.text, auto: false };
  // A layer of the scene itself, by its ID (speech_cut: audio layers are not model items).
  if (fix.kind === "layer") return { fix: { op: "update_layer", layerId: refName(fix.layerId, codes), properties: fix.properties }, auto: Boolean(fix.auto) };
  if (fix.kind === "tween" || fix.kind === "tweens") {
    const list = fix.kind === "tween" ? [fix] : fix.changes;
    const ops = list.map(tweenOp);
    if (!ops.length || ops.some((op) => !op)) {
      const item = itemOf(list[0]?.itemId ?? finding.itemId);
      return { fix: item?.source?.componentPath ? copyHint(item) : "Change the animation's timing as described.", auto: false };
    }
    const fromCopy = list.some((entry) => itemOf(entry.itemId)?.source?.componentPath);
    return { fix: ops.length === 1 ? ops[0] : ops, auto: Boolean(fix.auto) && !fromCopy };
  }
  if (fix.kind === "fades") {
    // A fade with the same timing as an exit or entrance that does not fade the layer.
    const ops = fix.changes.map(({ itemId, mode, start, end }) => {
      const item = itemOf(itemId);
      const found = sourceLayer(document, item);
      if (!found || item.source.componentPath) return null;
      const round = (value) => Math.round(value * 1000) / 1000;
      return { op: "add_animation", layerId: refName(found.layer.id, codes), ...sceneField(found.scene.id), id: freeAnimationId(found.scene, `${found.layer.id}.fade-${mode}`), preset: "preset-fade", mode, start: round(start), duration: round(Math.max(0.05, end - start)) };
    });
    if (!ops.length || ops.some((op) => !op)) {
      const item = itemOf(fix.changes[0]?.itemId ?? finding.itemId);
      return { fix: item ? copyHint(item) : "Add a fade with the same timing as the exit or entrance named.", auto: false };
    }
    return { fix: ops.length === 1 ? ops[0] : ops, auto: Boolean(fix.auto) };
  }
  // A layer to take out (stacked_label). Never auto: the agent decides the layer has to go.
  if (fix.kind === "delete_item") {
    const item = itemOf(fix.itemId);
    const found = sourceLayer(document, item);
    if (!found || item.source.componentPath) return { fix: item ? copyHint(item) : undefined, auto: false };
    return { fix: { op: "delete_layer", layerId: refName(found.layer.id, codes), ...sceneField(found.scene.id) }, auto: false };
  }
  if (fix.kind === "item") {
    const item = itemOf(fix.itemId);
    if (item?.source?.sceneBackground) {
      const properties = "fill" in fix.properties ? { background: fix.properties.fill } : fix.properties;
      return { fix: { op: "update_scene", sceneId: refName(model.sceneId, codes), properties }, auto: Boolean(fix.auto) };
    }
    const found = sourceLayer(document, item);
    if (!found) return { fix: item ? copyHint(item) : undefined, auto: false };
    return { fix: { op: "update_layer", layerId: refName(found.layer.id, codes), ...sceneField(found.scene.id), properties: fix.properties }, auto: Boolean(fix.auto) && !item.source.componentPath };
  }
  if (fix.kind === "move") {
    const item = itemOf(fix.itemId);
    const found = sourceLayer(document, item);
    if (!found || item.source.componentPath) return { fix: item ? copyHint(item) : undefined, auto: false };
    const { layer, scene } = found;
    const place = moveLayerByWorldDelta(layer, scene.layers, fix.dx, fix.dy);
    const [x, y] = [Math.round(place.x), Math.round(place.y)];
    // Its animations' places move by as much as the layer, or an entrance would still end where
    // the layer was (and each check {fix:"auto"} would move the layer again).
    const ops = [{ op: "update_layer", layerId: refName(layer.id, codes), ...sceneField(scene.id), properties: { x, y } },
      ...shiftedAnimations(layer.animations, x - (layer.x ?? 0), y - (layer.y ?? 0)).map(({ animation, properties }) =>
        ({ op: "update_animation", animationId: refName(animation.id, codes), ...sceneField(scene.id), properties }))];
    return { fix: ops.length === 1 ? ops[0] : ops, auto: Boolean(fix.auto) };
  }
  if (fix.kind === "font") {
    // set_font on the layers (it downloads the face first when the font catalog has it).
    const items = fix.itemIds.map((id) => itemOf(id));
    const layers = items.map((item) => sourceLayer(document, item)).filter(Boolean);
    if (!layers.length) return { fix: `Set the font of these layers to ${fix.family}${fix.weight ? ` ${fix.weight}` : ""} with set_font.`, auto: false };
    // `nearest`: each layer keeps its weight, as near as the family has it (one set_font per weight).
    const byWeight = new Map();
    for (const { layer } of layers) {
      const weight = fix.nearest ? nearestWeight(fonts, fix.family, Number(layer.fontWeight) || 400, fix.style ?? layer.fontStyle ?? "normal") : fix.weight ?? null;
      if (!byWeight.has(weight)) byWeight.set(weight, []);
      const id = refName(layer.id, codes);
      if (!byWeight.get(weight).includes(id)) byWeight.get(weight).push(id);
    }
    const ops = [...byWeight].map(([weight, layerIds]) => ({ op: "set_font", layerIds, family: fix.family, ...(weight ? { weight } : {}), ...(fix.style ? { style: fix.style } : {}) }));
    const fromCopy = items.some((item) => item?.source?.componentPath);
    return { fix: ops.length === 1 ? ops[0] : ops, auto: Boolean(fix.auto) && !fromCopy };
  }
  // An audio or video layer's own animation (sound rules: these layers are not model items).
  if (fix.kind === "layer_animation") return { fix: { op: "update_animation", animationId: refName(fix.animationId, codes), properties: fix.properties }, auto: Boolean(fix.auto) };
  if (fix.kind === "add_layer_animation") {
    const scene = document.scenes.find((entry) => entry.id === model.sceneId);
    return { fix: { op: "add_animation", layerId: refName(fix.layerId, codes), animation: { id: freeAnimationId(scene, `${fix.layerId}.fade-out`), ...fix.animation } }, auto: Boolean(fix.auto) };
  }
  if (fix.kind === "scene") return { fix: { op: "update_scene", sceneId: refName(model.sceneId, codes), properties: fix.properties }, auto: Boolean(fix.auto) };
  if (fix.kind === "project") return { fix: { op: "update_project", properties: fix.properties }, auto: Boolean(fix.auto) };
  return { fix: undefined, auto: false };
}

// The IDs a waiver can name for a finding: its layer (or component copy), and its scene.
function waiverTargets(finding, model) {
  const item = finding.itemId ? model.itemOf(finding.itemId) : null;
  const targets = new Set([model.sceneId]);
  if (finding.layerId) targets.add(finding.layerId);
  if (item?.source?.layerId && item.source.layerId !== BACKGROUND_OWNER_ID) targets.add(item.source.layerId);
  if (item?.source?.instanceId) targets.add(item.source.instanceId);
  if (item) targets.add(item.id);
  return targets;
}

function waiverFor(finding, model, waivers) {
  const targets = waiverTargets(finding, model);
  return waivers.find((waiver) => waiver.code === finding.rule && (waiver.target === "*" || targets.has(waiver.target)));
}

// The scene's audio and video layers whose sound may be heard, each with its word transcript or
// why there is none. `transcriptOf(layer, {make})` reads the saved transcript, and with make
// (a full check) transcribes the file first; it throws when it cannot (no speech model).
// `loudnessOf(layer, {make})` gives the file's waveform peaks (null when unknown), so speech_cut
// can hear whether a cut is inside the voice.
async function heardSpeech(scene, transcriptOf, make, loudnessOf = null, levelsOf = null) {
  const layers = scene.layers.filter((layer) => (layer.type === "audio" || layer.type === "video") && layer.src && layer.enabled !== false
    && (Number(layer.volume ?? 1) > 0 || (layer.animations ?? []).some((animation) => animation?.to && "volume" in animation.to)));
  const list = [];
  for (const layer of layers) {
    if (!transcriptOf) continue;
    let entry;
    try {
      const transcript = await transcriptOf(layer, { make });
      // A song's lyrics are not checked; its loudness is (music_hard_stop).
      entry = transcript?.music ? { layer, transcript: null, music: true } : transcript?.words ? { layer, transcript } : { layer, transcript: null, missing: make ? "no transcript" : "not transcribed yet (check with pixels transcribes it)" };
    } catch (error) {
      entry = { layer, transcript: null, missing: `no transcript: ${String(error.message).split("\n")[0].slice(0, 160)}` };
    }
    const loudness = loudnessOf ? await loudnessOf(layer, { make }).catch(() => null) : null;
    // The file's loudness in LUFS (backend/loudness-curve.mjs) for the measured sound rules.
    const levels = levelsOf ? await levelsOf(layer, { make }).catch(() => null) : null;
    list.push({ ...entry, ...(loudness?.available ? { loudness } : {}), ...(levels ? { levels } : {}) });
  }
  return list;
}

/**
 * The people found in each clip the scene shows: {people: {src: found}, stamp, why}. A full check
 * (make) finds them in a clip with no saved answer; a quick one uses saved answers only. `why`
 * says when the people checks could not run (not a Mac, macOS before 12, no helper).
 */
async function peopleIn(scene, peopleOf, make) {
  if (!peopleOf) return { people: null, stamp: "", why: null };
  const people = {};
  let why = null;
  for (const layer of scene.layers) {
    if (layer.type !== "video" || !layer.src || layer.enabled === false || layer.src in people) continue;
    try {
      const found = await peopleOf(layer, { make });
      if (found?.unavailable) why ??= `head_cut_off and finding people for overlay_covers_subject did not run: ${found.unavailable}.`;
      people[layer.src] = found?.samples ? found : null;
    } catch (error) {
      people[layer.src] = null;
      why ??= `finding people did not run: ${String(error.message).split("\n")[0].slice(0, 160)}`;
    }
  }
  const stamp = Object.entries(people).map(([src, found]) => `${src}:${found ? found.samples.length : "none"}`).join(",");
  return { people, stamp, why };
}

/**
 * The quality checker for one agent service. `renderFrames(scene, times, {width})` renders an
 * expanded scene (backend/export.mjs renderSceneFrames); without it the pixel rules are skipped.
 * `references(projectId)` gives the project's saved Inspire references with fingerprints, and
 * `measureRender(pairTimes, {render, seconds})` measures rendered frames the same way
 * (backend/measure/measure.mjs measureRendered): both for the reference_drift check. `house(projectId, name)`
 * gives the other projects' house memory, the project's copies left out (backend/house-memory.mjs) for seen_before. `quietMs`: how
 * long its renders wait after the last call or render (render-activity.mjs QUIET_MS; tests shorten it).
 */

export function createQualityChecker({ mediaRoot, renderFrames, videoFacts = null, factsWaitMs = FACTS_WAIT_MS, references = null, measureRender = null, house = null, cacheBytes = CACHE_BYTES, reuseFrames = true, quietMs } = {}) {
  const cache = new Map();
  // Frames rendered for earlier checks, reused where a changed scene looks the same (frame-reuse.mjs).
  const frameReuse = reuseFrames ? createFrameReuse() : null;
  // The frame rate of each scene's latest full check (check at any fps), so status and edit
  // receipts can count it while the scene is unchanged. Keyed by the scene's base; newest kept.
  const fullCheckFps = new Map();
  const baseKey = (base) => keyOf(base, { pixels: "latest full check", outputFps: "" });
  // reference_drift renders and measures the scene every half second (240 frames for a minute:
  // 30 to 70 s with footage), so a full check starts it in the background and answers without it,
  // with a note; the next check of the unchanged scene has it. Keyed like the check. One runs at a
  // time, only for a scene's latest version (an older one is dropped and runs again if checked
  // again), and each batch of its renders waits until no agent call, check, look or export has run
  // for a second (render-activity.mjs waitForQuiet): one FFmpeg job at a time.
  const drifts = new Map();
  const latestDrift = new Map();
  let driftQueue = Promise.resolve();
  function driftFor(key, scope, measure) {
    const hit = drifts.get(key);
    if (hit) { drifts.delete(key); drifts.set(key, hit); return hit; }
    const job = { done: false, value: null };
    latestDrift.set(scope, key);
    if (latestDrift.size > 256) latestDrift.delete(latestDrift.keys().next().value);
    job.promise = driftQueue = driftQueue.then(async () => {
      if (latestDrift.get(scope) !== key) { drifts.delete(key); return; }
      try { job.value = await inBackground(measure); } catch { job.value = null; }
    }).finally(() => { job.done = true; });
    drifts.set(key, job);
    if (drifts.size > 64) drifts.delete(drifts.keys().next().value);
    return job;
  }
  // Each picture and clip file's own size, from its library record (soft_upscale, crop_no_subject):
  // {src: {width, height, busy?, edges?, flat?} | null} (the last three: frozen_screen, screen_unreadable). Also each media file's name as the library lists it
  // {src: "target.mp4"}: spine_drift matches a beat's uses by it.
  const sizes = new Map();
  async function mediaSizes(document) {
    const found = {};
    const names = {};
    const pending = [];
    // Videos measured before kino read a frame's facts (backend/media-probe.mjs videoFrameFacts):
    // all are asked at once (videoFacts runs them one at a time) and waited on factsWaitMs in all.
    // One not measured by then is judged without facts and asked again next check.
    const asked = new Map();
    const records = new Map();
    for (const scene of document.scenes) for (const layer of scene.layers) {
      if (!["image", "video", "audio"].includes(layer.type) || !layer.src || sizes.has(layer.src) || records.has(layer.src)) continue;
      const id = mediaIdFromSource(layer.src);
      let record = null;
      try { record = id && mediaRoot ? JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8")) : null; } catch { record = null; }
      records.set(layer.src, record);
      if (record && layer.type === "video" && videoFacts && record.hasVideo !== false && !Object.hasOwn(record, "busy") && !record.recording) {
        const facts = {};
        asked.set(layer.src, { facts, job: Promise.resolve().then(() => videoFacts(id, record)).then((value) => Object.assign(facts, value), () => {}) });
      }
    }
    if (asked.size) {
      let timer;
      await Promise.race([Promise.all([...asked.values()].map((entry) => entry.job)), new Promise((done) => { timer = setTimeout(done, factsWaitMs); })]);
      clearTimeout(timer);
    }
    for (const scene of document.scenes) for (const layer of scene.layers) {
      if (!["image", "video", "audio"].includes(layer.type) || !layer.src || layer.src in names) continue;
      let entry = sizes.get(layer.src);
      if (!entry) {
        let record = records.get(layer.src) ?? null;
        const measured = asked.get(layer.src)?.facts;
        if (measured) record = { ...record, ...measured };
        const size = record?.width > 0 && record?.height > 0 ? { width: record.width, height: record.height,
          ...(Array.isArray(record.busy) ? { busy: record.busy, edges: record.edges, flat: record.flat } : {}),
          // screen_unreadable: kino recorded it (its frame in points), or its name says screen.
          ...(layer.type === "video" && record.recording ? { screen: true, ...(record.recording.frame?.[0] > 0 ? { points: record.recording.frame[0] } : {}) } : {}),
          ...(layer.type === "video" && SCREEN_NAME.test(String(record.name ?? "")) ? { named: true } : {}) } : null;
        entry = { size, name: typeof record?.name === "string" ? record.name : null };
        // Unmeasured (failed or still running): not kept, so the next check reads the saved facts.
        if (!measured || Object.hasOwn(measured, "busy")) sizes.set(layer.src, entry);
        else pending.push(layer.src);
        if (sizes.size > 4096) sizes.delete(sizes.keys().next().value);
      }
      const { size, name } = entry;
      if (layer.type !== "audio") found[layer.src] = size;
      names[layer.src] = name;
    }
    // In each scene's key, so a check made before the facts came is not kept after.
    return { sizes: found, names, pending: pending.join(",") };
  }

  // A kept check, made the most recently used.
  function kept(key) {
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); }
    return hit;
  }

  async function sceneFindings(document, scene, { fonts, codes, pixels, outputFps, signal, refs = [], houseMoments = [], styleSpec = null, deck = null, briefFonts = [], length = null, asks = null, speech = [], people = null, soundSearch = false, media = { sizes: {}, names: {} }, isVideo = false, base = sceneBase(document, scene, { fonts, codes, styleSpec, deck, briefFonts, length, asks }) }) {
    const key = keyOf(base, { pixels, outputFps });
    if (pixels && renderFrames) {
      const at = baseKey(base);
      fullCheckFps.delete(at);
      fullCheckFps.set(at, outputFps);
      if (fullCheckFps.size > 1024) fullCheckFps.delete(fullCheckFps.keys().next().value);
    }
    const hit = kept(key);
    if (hit) return hit;
    const started = performance.now();
    const model = kinoTimeline(document, scene.id, { fonts });
    let expanded = null;
    let driftPending = false;
    // Renders the scene's frames for the pixel rules (`signal`: the check's; none for background work).
    // `solo` draws only those layers (with their groups and children) over a plain `background`:
    // the contrast rule reads which pixels a layer in front of a text covers from two such frames.
    const renderWith = (renderSignal) => async (times, { width, hide = [], solo = null, background = null }) => {
      expanded ??= expandComponents(document, scene.id, { fonts });
      const hidden = new Set(hide);
      if (solo) {
        const byId = new Map(expanded.layers.map((layer) => [layer.id, layer]));
        const kept = new Set();
        for (const id of solo) for (let layer = byId.get(id); layer && !kept.has(layer.id); layer = byId.get(layer.parentId)) kept.add(layer.id);
        const inside = (layer) => { for (let at = layer; at; at = byId.get(at.parentId)) if (solo.includes(at.id)) return true; return false; };
        for (const layer of expanded.layers) if (!kept.has(layer.id) && !inside(layer)) hidden.add(layer.id);
      }
      let drawn = hidden.size ? { ...expanded, layers: expanded.layers.map((layer) => (hidden.has(layer.id) ? { ...layer, visible: false } : layer)) } : expanded;
      if (background) drawn = { ...drawn, background, backgroundEnabled: true, backgroundAnimations: [] };
      const render = (scene, missing) => renderFrames(scene, missing, { mediaRoot, fonts, width, signal: renderSignal });
      return frameReuse ? (await frameReuse.framesFor(drawn, times, { width, fonts, render })).frames : render(drawn, times);
    };
    const context = {
      outputFps,
      // Messages name layers the way the agent does: by ID or short code.
      name: (item) => (item ? refOfItem(item, model, codes) : "a layer"),
      sceneName: refName(scene.id, codes),
      // The brand's fonts (off_brand_font, default_font).
      brandFonts: brandFontsOf(document, briefFonts),
      // The material the video is made from (source op): own_words compares on-screen words to it.
      sources: document.sources ?? [],
      // The saved references' fingerprints and a way to measure this scene's frames (reference_drift):
      // null while that runs in the background (driftFor).
      ...(pixels && refs.length && measureRender ? { references: refs, measureRender: async (pairs, { seconds, width }) => {
        const job = driftFor(key, `${document.id}\n${scene.id}`, () => measureRender(pairs, { seconds, render: async (times) => { await waitForQuiet({ quietMs }); return renderWith(undefined)(times, { width }); } }));
        if (job.done) return job.value;
        driftPending = true;
        return null;
      } } : {}),
      // What kino rendered in other projects, and this project's references as layouts (seen_before).
      house: houseMoments, referenceSignatures: refs.map((ref) => referenceSignature(ref.fingerprint)).filter(Boolean),
      // Only the video's scene has an ending (ending_seen); another scene's tail stays seen_before.
      videoScene: isVideo,
      // The brief's style spec: the style rules follow it (engine/styleSpec.js).
      styleSpec,
      // The brief's length on the scene that is the video (the assertions gate holds it).
      ...(length ? { length } : {}),
      // What the person asked for (brief lines in their words, their notes): request_unmet.
      ...(asks?.length ? { asks } : {}),
      // The project's deck (engine/deck.js): deck_unused counts the cards the video uses.
      // The moves the scene holds (a move marks the layers it makes), so a set piece counts too.
      // The scene's heard sound with its word transcripts (speech_cut, speech_captions).
      speech, speechScene: scene,
      // Whether sound search is on in Settings: no_music says the next call by it.
      soundSearch,
      // The people Apple Vision found in each clip (head_cut_off, overlay_covers_subject).
      ...(people ? { people } : {}),
      // The marker cues: music or story turns where pacing_jump lets the cut rate change.
      cues: markerCues(document),
      // The beat and onset cues: cut_motivation counts a cut on one as on the beat.
      beatCues: (document.cues ?? []).filter((cue) => cue.kind === "beat" || cue.kind === "onset"),
      // The raw scene and each picture's file size (soft_upscale, crop_no_subject).
      scene, mediaSizes: media.sizes, mediaNames: media.names,
      // Files recorded together (sync_clips): out_of_sync holds a line to the picture of its moment.
      clipLinks: document.clipLinks ?? [],
      // The storyboard's shots (cue, dur, move kind): plain_beats judges each one.
      ...(boardShots(document, scene) ? { board: boardShots(document, scene) } : {}),
      ...(deck ? { deck, movesUsed: [...new Set(scene.layers.map((layer) => layer.move?.name).filter(Boolean))] } : {}),
      ...(pixels && renderFrames ? { renderFrames: renderWith(signal) } : {}),
    };
    const result = await runQuality(model, { pixels: pixels && Boolean(renderFrames), context });
    if (driftPending) {
      // Not kept: the next check runs the scene again (its frames are reused) and reads the drift.
      const note = "reference_drift is measuring this scene against its references in the background (about a minute); the next check includes it.";
      return { model, findings: result.findings, notes: [...result.notes, note], techniques: techniqueCounts(techniquesUsed(model)), ms: Math.round(performance.now() - started), bytes: modelBytes(model) };
    }
    const entry = { model, findings: result.findings, notes: result.notes, techniques: techniqueCounts(techniquesUsed(model)), ms: Math.round(performance.now() - started), bytes: modelBytes(model) };
    cache.set(key, entry);
    let bytes = 0;
    for (const kept of cache.values()) bytes += kept.bytes;
    // The oldest go first; the model just made stays even when it alone is over the budget.
    for (const [oldKey, kept] of cache) {
      if ((cache.size <= CACHE_SIZE && bytes <= cacheBytes) || oldKey === key) break;
      cache.delete(oldKey);
      bytes -= kept.bytes;
    }
    return entry;
  }

  /**
   * Checks the document's scenes (not main component scenes, which are checked where they are
   * used), or only `sceneId`. Returns {findings, notes, ms, scenes, unchecked, techniques}, where
   * techniques counts each technique tag used (engine/quality/techniques.js), most used first.
   * `styleSpec` is the brief's style spec (or null for kino's default style). `length` is the
   * brief's length {seconds, tolerance} (or null): the video's scene is held to it.
   * Without `pixels` the rules that render frames (contrast, flashing, luma_jump, ...) do not run, except that a
   * scene whose full check is kept (check ran on it and it has not changed since) answers with
   * that check. `unchecked` lists the IDs of the scenes whose rendered rules did not run, so a
   * count can say what it leaves out; it stays empty when this checker cannot render at all.
   */
  async function check(document, { fonts, codes, sceneId = null, pixels = false, outputFps = 30, signal, styleSpec = null, deck = null, briefFonts = [], length = null, asks = null, transcriptOf = null, loudnessOf = null, levelsOf = null, peopleOf = null, soundSearch = false } = {}) {
    const started = performance.now();
    const scenes = document.scenes.filter((scene) => (sceneId ? scene.id === sceneId : !scene.isComponent));
    const waivers = document.checkWaivers ?? [];
    const findings = [];
    const notes = [];
    const unchecked = [];
    // The saved references change a full check: their ids and when they were measured are part of
    // the key, so a new reference checks again.
    const refs = references ? await references(document.id).catch(() => []) : [];
    const refStamp = refs.map((ref) => `${ref.id}@${ref.measuredAt ?? ""}`).join(",");
    // The house memory changes seen_before: which projects and revs it holds are part of the key.
    const houseMoments = house ? await house(document.id, document.name ?? null).catch(() => []) : [];
    const houseStamp = houseMoments.map((entry) => `${entry.projectId}@${entry.rev}v${entry.sigVersion ?? 1}`).join(",");
    // How many times each technique is used, over the scenes checked.
    const techniques = {};
    // The deck is the whole video's, and a video is its longest scene: only that scene counts it.
    const deckScene = deck ? videoScene(document) : null;
    // The brief's length is the whole video's too: the video's scene is measured (its duration is
    // what a render makes; component and variant scenes are left out).
    const lengthScene = length ? videoScene(document) : null;
    const videoLength = lengthScene ? { ...length, video: lengthScene.duration } : null;
    const media = await mediaSizes(document);
    // The story spine is the video's: only its scene is held to it (a format variant or a
    // component scene has other layers and times). The rest of the style spec counts everywhere.
    // The idea's signature ranges are the video's too (signature_missing).
    const spineScene = styleSpec?.spine?.length || styleSpec?.idea || styleSpec?.signatures?.length ? videoScene(document) : null;
    for (const scene of scenes) {
      const sceneStyle = spineScene && scene.id !== spineScene.id ? { ...styleSpec, spine: undefined, idea: undefined, signatures: undefined } : styleSpec;
      const sceneDeck = scene.id === deckScene?.id ? deck : null;
      const sceneLength = scene.id === lengthScene?.id ? videoLength : null;
      // The video's scene (its longest shown scene) is the one with an ending (ending_seen).
      const isVideo = scene.id === videoScene(document)?.id;
      const sceneAsks = asks?.length && isVideo ? asks : null;
      // The transcripts change what the speech rules say, so whether each is known is in the key.
      const speech = await heardSpeech(scene, transcriptOf, pixels, loudnessOf, levelsOf);
      const speechStamp = speech.map((entry) => `${entry.layer.id}:${entry.transcript ? `${entry.transcript.model}@${entry.transcript.version}` : entry.music ? "music" : "none"}${entry.loudness ? `:peaks${entry.loudness.duration}` : ""}${entry.levels ? `:lufs${entry.levels.duration}` : ""}`).join(",");
      const { people, stamp: peopleStamp, why: peopleWhy } = await peopleIn(scene, peopleOf, pixels);
      if (peopleWhy && !notes.includes(peopleWhy)) notes.push(peopleWhy);
      const base = `${sceneBase(document, scene, { fonts, codes, styleSpec: sceneStyle, deck: sceneDeck, briefFonts, length: sceneLength, asks: sceneAsks })}\n${refStamp}\nhouse:${houseStamp}\nvideo:${isVideo}\n${speechStamp}\n${peopleStamp}\nsearch:${soundSearch}${media.pending ? `\nunmeasured:${media.pending}` : ""}`;
      const latestFps = fullCheckFps.get(baseKey(base));
      const full = !pixels && renderFrames
        ? kept(keyOf(base, { pixels: true, outputFps })) ?? (latestFps != null ? kept(keyOf(base, { pixels: true, outputFps: latestFps })) : null) ?? null
        : null;
      if (!pixels && !full && renderFrames) unchecked.push(scene.id);
      const { model, findings: found, notes: sceneNotes, techniques: used = {} } = full ?? await sceneFindings(document, scene, { fonts, codes, pixels, outputFps, signal, refs, houseMoments, styleSpec: sceneStyle, deck: sceneDeck, briefFonts, length: sceneLength, asks: sceneAsks, speech, people, soundSearch, media, isVideo, base });
      for (const [tag, count] of Object.entries(used)) techniques[tag] = (techniques[tag] ?? 0) + count;
      for (const note of sceneNotes) if (!notes.includes(note)) notes.push(note);
      for (const finding of found) {
        const item = finding.itemId ? model.itemOf(finding.itemId) : null;
        const { fix, auto } = fixOps(finding.fix, finding, model, document, codes, fonts);
        const waiver = waiverFor(finding, model, waivers);
        findings.push({
          severity: finding.severity, rule: finding.rule,
          ref: item ? refOfItem(item, model, codes) : finding.layerId ? refName(finding.layerId, codes) : refName(scene.id, codes),
          ...(scenes.length > 1 || sceneId ? { scene: refName(scene.id, codes) } : {}),
          ...(finding.at != null ? { at: sec(finding.at) } : {}), ...(finding.until != null ? { until: sec(finding.until) } : {}),
          message: finding.message,
          ...(finding.measured != null ? { measured: finding.measured } : {}), ...(finding.required != null ? { required: finding.required } : {}),
          ...(finding.bbox ? { bbox: finding.bbox } : {}),
          ...(fix !== undefined ? { fix } : {}), ...(auto ? { auto: true, ...(finding.fix?.why ? { why: finding.fix.why } : {}), ...(finding.fix?.push ? { push: true } : {}) } : {}),
          ...(waiver ? { waived: waiver.reason } : {}),
          ...(finding.internal ? { internal: true } : {}),
          // plain_beats marks the warning that holds a final render (blocksFinal).
          ...(finding.final ? { final: true } : {}),
        });
      }
    }
    const sorted = Object.fromEntries(Object.entries(techniques).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    return { findings, notes, ms: Math.round(performance.now() - started), scenes: scenes.length, unchecked, techniques: sorted };
  }

  return { check };
}

/** library {topic:"rules", name:"quality"}: every rule, one line each. */
export function qualityRulesText() {
  const line = (entry) => `  ${entry.code}: ${entry.summary}${entry.pixels ? " (rendered)" : ""}`;
  return [
    "Gates (errors; a final render is refused while one is not fixed or waived):",
    ...RULES.filter((entry) => entry.level === "error").map(line),
    "  av_offset: after a final render with sound, audio within 45 ms early to 125 ms late (ITU-R BT.1359)",
    "Render checks: missing_media (error), empty_text, off_canvas, past_scene_end, missing_font, missing_glyphs.",
    "Warnings (a real edit: block final until fixed or waived):",
    ...RULES.filter((entry) => entry.level === "warn").map(line),
    "Advice (info, never blocks):",
    ...RULES.filter((entry) => entry.level === "info").map(line),
    "A problem that lasts 2 samples or less is info: counted, not listed. Sizes are for 1080p and scale with the frame.",
    "library {topic:\"rules\", name:\"quality-settings\"} covers roles, videoType, assertions and waivers.",
  ].join("\n");
}
