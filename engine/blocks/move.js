// Runs a move: one call that builds a designed set piece (a push through a shot, a whip pan,
// captions word by word, …) from the scene's own layers, uploaded pictures and the brand.
// A move's build() (engine/blocks/moves/) says which layers to add and which animations to put on
// which layers; this file checks what the move was given, names everything, and splices the
// result into the scene. Plain data in, plain data out, like recipe.js.
//
// IDs: a layer the move adds is `<id>-<part>` (zoom-through-glow), its animations
// `<layer>.<name>`. An animation the move puts on one of your layers is `<id>.<role>-<name>`
// (zoom-through.from-push), so the same id again removes exactly what the move made before.
import { seeded } from "./build.js";
import { frameScale, isPortraitFrame } from "./formats.js";
import { evaluateLayer } from "../animation.js";
import { enabledAnimations } from "../animationEnabled.js";
import { visibleByOperations } from "../visibilityOps.js";
import { CURVES, round } from "./moves/kit.js";
import { RESTORED } from "../blockFields.js";
import { subjectOf } from "./subject.js";

const PART = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_TEXT = 200;
const HEX = /^#[0-9a-fA-F]{6}$/;
const LINEAR = Object.freeze([0, 0, 1, 1]);
/** Curve names a move's ease field takes: the kit's curves and linear. */
export const EASE_NAMES = Object.freeze(["linear", ...Object.keys(CURVES)]);

/**
 * Fields any move may take (spread into its fields; shared: true keeps them out of the short
 * moves list, which says once that these exist). A move says in its own about what they change.
 */
export const SHARED = Object.freeze({
  ease: { kind: "ease", shared: true, about: `the curve of its main motion: ${EASE_NAMES.join(", ")}, [x1, y1, x2, y2] or steps-n (n held poses, 1 to 100) (default the move's own)` },
  speed: { kind: "number", low: 0.5, high: 4, shared: true, about: "how quick its motion runs inside dur, about its key moment: 2 = twice as quick, then still; below 1 its short beats last longer, never past dur (default 1)" },
  color: { kind: "color", shared: true, about: "its color, hex such as #FFFFFF" },
  accent: { kind: "color", shared: true, about: "its second color, hex" },
  angle: { kind: "number", low: -180, high: 180, shared: true, about: "the direction it travels in degrees: 0 right, 90 down (default 0)" },
});
/** Shared fields by name, with this move's own about where given: shared("ease", {color: "the flash color"}). */
export function shared(...entries) {
  const fields = {};
  for (const entry of entries) {
    if (typeof entry === "string") fields[entry] = SHARED[entry];
    // A move's own ease about still names the curves it takes.
    else for (const [key, about] of Object.entries(entry)) fields[key] = { ...SHARED[key], about: key === "ease" ? `${about}: ${EASE_NAMES.join(", ")}, [x1, y1, x2, y2] or steps-n` : about };
  }
  return fields;
}

/** A curve by kit name ("accelerate", "linear") or a [x1, y1, x2, y2] bezier, as a new array; "steps-4" is {steps: 4}. */
export function curveOf(value, where = "ease") {
  const steps = typeof value === "string" ? /^steps-(\d{1,3})$/.exec(value) : null;
  if (steps) {
    const count = Number(steps[1]);
    if (count < 1 || count > 100) throw new Error(`${where} steps-n takes n from 1 to 100.`);
    return { steps: count };
  }
  if (Array.isArray(value)) {
    if (value.length !== 4 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) || value[0] < 0 || value[0] > 1 || value[2] < 0 || value[2] > 1 || Math.abs(value[1]) > 3 || Math.abs(value[3]) > 3)
      throw new Error(`${where} as a bezier is [x1, y1, x2, y2] with x1 and x2 from 0 to 1, such as [0.5, 0, 0, 1].`);
    return [...value];
  }
  if (value === "linear") return [...LINEAR];
  if (typeof value === "string" && CURVES[value]) return [...CURVES[value]];
  throw new Error(`${where} is ${EASE_NAMES.join(", ")}, [x1, y1, x2, y2] or steps-n (such as steps-4).`);
}

/** Reads the fields a move was given, checking each against the move's field list. */
export function readMoveInput(definition, raw) {
  const fields = definition.fields;
  const input = {};
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!fields[key]) throw new Error(`${definition.name} has no field "${key}". Its fields: ${Object.keys(fields).join(", ")}.`);
  }
  for (const [key, field] of Object.entries(fields)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (field.required) throw new Error(`${definition.name} needs ${key}: ${field.about}.`);
      continue;
    }
    input[key] = readField(definition.name, key, field, value);
  }
  for (const rule of definition.oneOf ?? []) {
    const given = rule.filter((key) => input[key] !== undefined);
    if (given.length !== 1) throw new Error(`${definition.name} needs exactly one of ${rule.join(" or ")}.`);
  }
  for (const rule of definition.anyOf ?? []) {
    if (!rule.some((key) => input[key] !== undefined)) throw new Error(`${definition.name} needs ${rule.join(" or ")}: ${rule.map((key) => fields[key].about).join("; or ")}.`);
  }
  return input;
}

function readField(move, key, field, value) {
  const where = `${move} ${key}`;
  const text = (entry, max = field.max ?? MAX_TEXT) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > max) throw new Error(`${where} must be text of 1 to ${max} characters.`);
    return entry.trim();
  };
  const seconds = (entry, label = where) => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 600) throw new Error(`${label} must be seconds from 0 to 600.`);
    return entry;
  };
  const list = (entry) => {
    if (!Array.isArray(entry) || entry.length < (field.min ?? 1) || entry.length > (field.most ?? 50))
      throw new Error(`${where} must be a list of ${field.min ?? 1} to ${field.most ?? 50}.`);
    return entry;
  };
  switch (field.kind) {
    case "layer": case "picture": return text(value, 128);
    case "layers": case "pictures": return list(value).map((entry) => text(entry, 128));
    case "text": return text(value);
    case "ease": return typeof value === "string" ? (curveOf(value, where), value) : curveOf(value, where);
    case "flags": return list(value).map((entry) => {
      if (entry !== 0 && entry !== 1) throw new Error(`${where} is a list of 1 (on) and 0 (off), such as [1, 1, 0, 1].`);
      return entry;
    });
    case "color": {
      if (field.auto && value === "auto") return "auto";
      if (typeof value !== "string" || !HEX.test(value)) throw new Error(`${where} is a hex color such as #FFFFFF${field.auto ? ', or "auto"' : ""}.`);
      return value.toUpperCase();
    }
    case "colors": return list(value).map((entry) => {
      if (typeof entry !== "string" || !HEX.test(entry)) throw new Error(`${where} is a list of hex colors such as ["#3BEA7A", "#E0308F"].`);
      return entry.toUpperCase();
    });
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < field.low || value > field.high) throw new Error(`${where} must be a number from ${field.low} to ${field.high}.`);
      return field.whole ? Math.round(value) : value;
    }
    case "choice": {
      // aliases: words agents often send for a value, such as center for middle.
      if (field.aliases && Object.hasOwn(field.aliases, value)) return field.aliases[value];
      if (!field.values.includes(value)) throw new Error(`${where} is one of ${field.values.join(", ")}.`);
      return value;
    }
    case "choices": return list(value).map((entry) => {
      if (!field.values.includes(entry)) throw new Error(`${where}: each one is ${field.values.join(" or ")}.`);
      return entry;
    });
    case "point": {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === "number" && entry >= -50 && entry <= 150))
        throw new Error(`${where} is [x, y] in percent of the layer's box, such as [50, 40].`);
      return value;
    }
    case "box": {
      if (!Array.isArray(value) || value.length !== 4 || !value.every((entry) => typeof entry === "number" && entry >= -50 && entry <= 150) || value[2] <= 0 || value[3] <= 0)
        throw new Error(`${where} is [x, y, width, height] in percent of the layer's box, such as [6, 8, 10, 12].`);
      return value;
    }
    case "amounts": {
      // {name: number}: named amounts, each in its own range (assemble's spread {x, y, angle, scale}).
      const names = Object.keys(field.keys);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((entry) => !names.includes(entry)))
        throw new Error(`${where} is {${names.map((name) => `${name}?`).join(", ")}}: numbers, such as {${names.map((name) => `${name}: ${field.keys[name].high / 10}`).join(", ")}}.`);
      for (const [name, amount] of Object.entries(value)) {
        const { low, high } = field.keys[name];
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < low || amount > high) throw new Error(`${where}.${name} must be a number from ${low} to ${high}.`);
      }
      return { ...value };
    }
    case "target": {
      // {layer, rect?}: a layer (inside a group too) and a part of its box in percent.
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.layer !== "string" || Object.keys(value).some((entry) => !["layer", "rect"].includes(entry)))
        throw new Error(`${where} is {layer, rect?}: a layer (a phone's screen inside its group) and [x, y, width, height] in % of its box, such as {layer: "phone-screen", rect: [0, 40, 100, 30]}.`);
      const target = { layer: text(value.layer, 128) };
      if (value.rect !== undefined) target.rect = readField(move, `${key}.rect`, { kind: "box" }, value.rect);
      return target;
    }
    case "stops": {
      // A layer, [x, y] in scene pixels, {layer, point?}, or a list of these: {layer, point?} or {point}.
      const most = field.most ?? 8;
      const pixels = (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((number) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 20000);
      const hint = `${where} is a layer, [x, y] in scene pixels, {layer, point: [x%, y%]}, or a list of up to ${most} of these.`;
      const stop = (entry) => {
        if (typeof entry === "string") return { layer: text(entry, 128) };
        if (pixels(entry)) return { point: entry };
        if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.layer === "string" && Object.keys(entry).every((name) => name === "layer" || name === "point")) {
          const found = { layer: text(entry.layer, 128) };
          if (entry.point !== undefined) found.point = readField(move, `${key}.point`, { kind: "point" }, entry.point);
          return found;
        }
        throw new Error(hint);
      };
      const entries = typeof value === "string" || pixels(value) || (value && !Array.isArray(value)) ? [value] : value;
      if (!Array.isArray(entries) || !entries.length || entries.length > most) throw new Error(hint);
      return entries.map(stop);
    }
    case "times": return list(value).map((entry) => seconds(entry));
    case "timed": return list(value).map((entry, index) => {
      // {text, at, end?}: a word or a line and when it starts (scene seconds).
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where}[${index}] is {text, at${field.ends ? ", end?" : ""}}.`);
      const item = { text: text(entry.text, field.max ?? 60), at: seconds(entry.at, `${where}[${index}].at`) };
      if (entry.end !== undefined) {
        if (!field.ends) throw new Error(`${where}[${index}] has no end; each one lasts until the next.`);
        item.end = seconds(entry.end, `${where}[${index}].end`);
        if (item.end <= item.at) throw new Error(`${where}[${index}].end must come after its at.`);
      }
      return item;
    });
    case "texts": return list(value).map((entry) => text(entry, field.max ?? 40));
    default: throw new Error(`${where}: unknown field kind ${field.kind}.`);
  }
}

/**
 * Where a move of `duration` starts so that it starts at, is centered on, or ends at `at`.
 * Ported from ArtCraft FilmCraft, filmcraft/crates/edit/src/transitions.rs (`Alignment`,
 * `start_for`, `set_span`; MIT OR Apache-2.0, (c) the ArtCraft authors). Like set_span, a span
 * that would start before 0 s is refused rather than cut short.
 */
export function alignedStart(at, duration, align = "start", name = "move") {
  if (!["start", "center", "end"].includes(align)) throw new Error(`${name} align is start, center or end.`);
  const start = align === "end" ? at - duration : align === "center" ? at - duration / 2 : at;
  if (start < -1e-9) throw new Error(`${name} with align:"${align}" would start at ${round(start)} s; give a later at or a shorter dur.`);
  return round(Math.max(0, start));
}

/**
 * Builds a move. Options:
 *   id        the move's ID
 *   input     what readMoveInput returned (layer fields are layer IDs)
 *   scene     {width, height, duration, layers}: the scene as it is without this move
 *   style     from looks.styleFor (colors, fonts, type sizes, feel)
 *   fonts     the font registry for measuring text
 *   start     seconds of its `at`
 *   align     where the move's span sits on `at`: "start" (the default, it starts there), "center"
 *             or "end" (it ends there, so a transition lands on the beat)
 *   dur       seconds it lasts, or null for the move's own length
 *   media     media(ref) → {id, src, width, height, name} for an uploaded picture
 *   logo      the brand's logo, if any: {media} or {text}
 *   reduced   true for the reduced-motion version (no big moves, no blur sweeps)
 *   seed      a whole number; the same seed makes the same choices
 *   brandFonts true when the brand chose its own fonts (moves then use them, not their own pick)
 *   bpm       the music's tempo (document.rhythm.bpm), or null
 *   fileSize  src → {width, height} of a library file (a video too), or null
 *   samples   layer ID → the subjects measured in that video layer's file ([] when none)
 *   cueFacts  for a move that needs a cue: {at (as given), cues, events: footage events in scene s}
 * Returns {added: [{layer, place}], animations: [{layerId, animation}], start, end, notes}.
 */
export function runMove(definition, options) {
  const { id, input, scene, style, fonts, start: at, align = "start", dur = null, media, logo = null, reduced = false, seed = 1, brandFonts = false, bpm = null, fileSize = () => null, alpha = () => null, samples = () => [], shotColor = () => null, fontFaces = {}, cueFacts = null } = options;
  const frame = { width: scene.width, height: scene.height };
  const added = [];
  const animations = [];
  const notes = [];
  const raises = [];
  const sets = [];
  const keys = new Set();
  // Layers inside a group a move works on as they are (definition.nested): layer ID -> its group.
  const lifted = new Map();
  // A move that stays (a status line) lasts to the end of the scene unless dur says otherwise.
  // timing(input, {reduced}): a move whose length depends on its fields (zoom-through reverse is shorter).
  const timing = { length: definition.length, shortest: definition.shortest, ...definition.timing?.(input, { reduced }) };
  const duration = dur ?? (definition.untilEnd ? Math.max(0.1, scene.duration - at) : timing.length);
  const start = alignedStart(at, duration, align, definition.name);
  if (dur !== null && timing.shortest && dur < timing.shortest) throw new Error(`${definition.name} needs dur of at least ${timing.shortest} s.`);
  const ctx = {
    move: definition.name, recipe: definition.name, id, frame, style, fonts, reduced, logo, brandFonts,
    scale: frameScale(frame), portrait: isPortraitFrame(frame),
    rng: seeded(seed * 7919 + definition.name.length * 31),
    start: round(start), duration: round(duration), end: round(start + duration),
    // The dur the agent gave, or null: a move that times itself (draw-on) uses it when given.
    dur,
    sceneDuration: scene.duration,
    // The music's tempo (document.rhythm), when there is one: caption-words reads its energy.
    bpm,
    // A move that needs a cue (impact-accent): {at (as given), cues, events (footage, scene s)}.
    cueFacts,
    // The shared speed field (SHARED): 1 plays the move's beats as designed.
    speed: input.speed ?? 1,
    /** A curve by kit name or a bezier (a move's own defaults table), as a new array. */
    curve(value) { return curveOf(value, `${definition.name} curve`); },
    /** The move's main curve: its ease field when given, else `fallback` (a curve name or bezier). */
    ease(fallback) { return input.ease !== undefined ? curveOf(input.ease) : curveOf(fallback, `${definition.name} curve`); },
    /**
     * A color: the move's field `key` when given (color, accent), else `fallback`, which is a hex
     * or a look color role (accent, surface, bg, text) read from the style.
     */
    color(key, fallback) {
      if (typeof input[key] === "string") return input[key];
      const found = ctx.style?.colors?.[fallback] ?? fallback;
      if (typeof found !== "string") throw new Error(`${definition.name}: no color for ${key}.`);
      return found;
    },
    /**
     * Times on the move's clock under its speed: each moment's distance from `pivot` (its key
     * moment, such as the cut) is divided by speed, and a moment inside the move's span stays
     * inside it. at(t) a moment; span(start, duration) a beat as {start, duration}.
     */
    pace(pivot) {
      const speed = input.speed ?? 1;
      const at = (time) => {
        if (speed === 1) return time;
        const moved = pivot + (time - pivot) / speed;
        return Math.min(Math.max(moved, Math.min(time, ctx.start)), Math.max(time, ctx.end));
      };
      const span = (begin, length) => {
        if (speed === 1) return { start: begin, duration: length };
        const from = at(begin);
        return { start: from, duration: at(begin + length) - from };
      };
      return { at, span };
    },
    picture(ref) { return media(ref); },
    /** A clip's or picture's file size by its src ({width, height}), or null when unknown. */
    fileSize(src) { return fileSize(src); },
    /** A picture's alpha grid by its src ({columns, rows, solid: 1 where mostly opaque}), or null when unknown. */
    alpha(src) { return alpha(src); },
    /** The subjects measured in a named video layer's file (subjects-v1 samples), or [] when none are saved. */
    samples(layerId) { return samples(layerId) ?? []; },
    /** A named clip's or picture's dominant hue at the move's start ({h, s, l}), or null when not measured. */
    shotColor(layerId) { return shotColor(layerId) ?? null; },
    /** A font family the op asked for (a move's font field), ready to draw, or null when kino has none by that name. */
    fontFace(family) { return fontFaces[family] ?? null; },
    /** Every layer of the scene (groups' parts too), as they are now. */
    sceneLayers() { return scene.layers; },
    /**
     * One of the scene's layers by ID, as it is now. Moves work on top-level layers, except in
     * the fields a move lists in `nested`: it only animates that layer and adds its parts beside
     * it in its group (ctx.add with {above} or {below} it), so a layer inside a group works as itself.
     */
    layer(layerId, field = "layer") {
      const found = scene.layers.find((layer) => layer.id === layerId);
      if (!found) throw new Error(`${definition.name} ${field}: no layer "${layerId}" in this scene.`);
      if (definition.nested?.includes(field) && found.type !== "audio" && found.move?.instance !== id) {
        if (found.isMask) throw new Error(`${definition.name} ${field}: ${layerId} is a mask; give the layer it masks or its group.`);
        // Every layer the move reads must share one group's coordinates.
        const group = found.parentId ?? null;
        const other = [...lifted].find(([, parent]) => parent !== group);
        if (other) throw new Error(`${definition.name} ${field}: ${layerId} and ${other[0]} must be in the same group (or both at the top level).`);
        lifted.set(found.id, group);
        return found;
      }
      if (found.parentId) {
        // A layer alone in its group (frame wraps one in a <layer>-camera group): the group is meant.
        let top = found;
        const chain = new Set([found.id]);
        while (top.parentId) { top = scene.layers.find((layer) => layer.id === top.parentId); chain.add(top.id); }
        const alone = [...chain].every((id) => scene.layers.filter((layer) => layer.parentId === id).every((layer) => chain.has(layer.id)));
        if (!alone) throw new Error(`${definition.name} ${field}: ${layerId} is inside a group; give the group instead (moves work on top-level layers).`);
        if (!notes.includes(`${field}: ${top.id}, the group around ${layerId}`)) notes.push(`${field}: ${top.id}, the group around ${layerId}`);
        return ctx.layer(top.id, field);
      }
      if (found.type === "audio") throw new Error(`${definition.name} ${field}: ${layerId} is a sound; give a layer that is drawn.`);
      if (found.move?.instance === id) throw new Error(`${definition.name} ${field}: ${layerId} was made by this move; give one of your own layers.`);
      if (definition.nested) {
        const other = [...lifted].find(([, parent]) => parent !== null);
        if (other) throw new Error(`${definition.name} ${field}: ${layerId} and ${other[0]} must be in the same group (or both at the top level).`);
        lifted.set(found.id, null);
      }
      return found;
    },
    /**
     * The subject of the move (engine/blocks/subject.js): a layer ID or {text: words}. Returns its
     * kind, box, scene box, the center of what it draws and mask(part, place) for a white mask copy.
     */
    subject(input, options) { return subjectOf(ctx, scene.layers, input, options); },
    /** Adds a layer. place: "top", "bottom", {below: layerId} or {above: layerId}; parent: a group this move made. Returns the layer. */
    add(part, layer, place = "top", parent = null) {
      if (!PART.test(part)) throw new Error(`${definition.name}: bad part name ${part}.`);
      const layerId = `${id}-${part}`;
      if (added.some((entry) => entry.layer.id === layerId)) throw new Error(`${definition.name}: part ${part} is made twice.`);
      // A layer inside a group the move made uses the group's box as its coordinates (x 0, y 0 is its corner).
      // Its name is its ID, so the name an agent reads in status is unique and works in an edit
      // (seven "Caption shade" layers could not be told apart).
      // A part placed beside a layer of yours inside a group (definition.nested) goes in that group.
      const beside = typeof place === "object" ? lifted.get(place.below ?? place.above) ?? null : null;
      const made = { ...layer, id: layerId, name: layerId, parentId: parent ? parent.id : beside, animations: [], move: { name: definition.name, instance: id, part } };
      added.push({ layer: made, place });
      return made;
    },
    /**
     * Puts an animation on a layer: one this move added (by the layer object or its part
     * name), or one of the scene's layers (its ID) under a short role name such as "from".
     */
    animate(target, name, animation, role = null) {
      const own = typeof target === "object" ? target : added.find((entry) => entry.layer.move.part === target)?.layer;
      if (own) {
        const animationId = `${own.id}.${name}`;
        if (keys.has(animationId)) throw new Error(`${definition.name}: animation ${animationId} is made twice.`);
        keys.add(animationId);
        own.animations.push({ id: animationId, ...animation });
        return;
      }
      const animationId = `${id}.${role ?? target}-${name}`;
      if (keys.has(animationId)) throw new Error(`${definition.name}: animation ${animationId} is made twice.`);
      keys.add(animationId);
      animations.push({ layerId: target, animation: { id: animationId, ...animation } });
    },
    /** The animations this move has put on one of the scene's layers so far. */
    ownAnimations(layerId) { return animations.filter((entry) => entry.layerId === layerId).map((entry) => entry.animation); },
    note(text) { notes.push(text); },
    /** A scene layer's state at `time` (x, y, scaleX, rotation, opacity, …) with its own animations. */
    stateAt(layerId, time) { return evaluateLayer(ctx.layer(layerId), time); },
    /**
     * When the layer's own animations of `keys` (such as x, y, scaleX) that play between `from`
     * and `until` have finished (`from` when none do). A long push starts then, from where they
     * left the layer, so it follows their motion instead of freezing the layer where it started.
     */
    settledAt(layerId, keys, from, until) {
      let at = from;
      for (const animation of enabledAnimations(ctx.layer(layerId).animations)) {
        // A recipe's hold drift (engine/blocks/hold.js) gives way: the move starts over it.
        if (!animation || animation.kind === "effect" || String(animation.id ?? "").startsWith(`${id}.`) || String(animation.id ?? "").endsWith(".hold")) continue;
        if (![...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})].some((key) => keys.includes(key))) continue;
        const begins = animation.start ?? 0;
        const ends = begins + (animation.duration ?? 0);
        if (ends > from && begins < until) at = Math.max(at, ends);
      }
      return round(at);
    },
    /**
     * A layer anywhere in the scene (inside groups too) and its box in the coordinates of the
     * top-level layer that holds it (its parts' x and y added up; a part's own scale is left out).
     * Returns {layer, top (the top-level layer's ID), box}.
     */
    inside(layerId, field = "layer") {
      const found = scene.layers.find((layer) => layer.id === layerId);
      if (!found) throw new Error(`${definition.name} ${field}: no layer "${layerId}" in this scene.`);
      let x = 0;
      let y = 0;
      let at = found;
      while (at.parentId) {
        x += at.x;
        y += at.y;
        at = scene.layers.find((layer) => layer.id === at.parentId);
      }
      const box = found.parentId ? { x, y, width: found.width, height: found.height } : { x: 0, y: 0, width: found.width, height: found.height };
      return { layer: found, top: at.id, box };
    },
    /** The groups around a layer, nearest first (none for a top-level layer). */
    parents(layerId) {
      const chain = [];
      for (let at = scene.layers.find((layer) => layer.id === layerId); at?.parentId;) {
        at = scene.layers.find((layer) => layer.id === at.parentId);
        if (at) chain.push(at);
      }
      return chain;
    },
    /** Any scene layer's state at `time`, a part inside a group too (in its group's coordinates). */
    partStateAt(layerId, time) { return evaluateLayer(ctx.inside(layerId).layer, time); },
    /** The scene's top-level layers that are drawn (not sounds), bottom of the stack first. */
    topLayers() { return scene.layers.filter((layer) => !layer.parentId && layer.type !== "audio"); },
    /** The drawn layers beside a layer in its own group (or at the top level), bottom of the stack first. */
    siblings(layerId) {
      const parentId = ctx.inside(layerId).layer.parentId ?? null;
      return scene.layers.filter((layer) => (layer.parentId ?? null) === parentId && layer.id !== layerId && layer.type !== "audio");
    },
    /**
     * Whether a scene layer is on screen at `time`: not switched off, not hidden by its show and
     * hide steps, inside its clip's time (a video), seen (opacity above 2%), and for a group,
     * with at least one part on screen.
     */
    shownAt(layerId, time) {
      const shown = (layer) => {
        if (!layer || layer.visible === false || !visibleByOperations(layer.animations ?? [], time)) return false;
        if (layer.type === "video" && Number.isFinite(layer.mediaDuration) && layer.mediaDuration > 0) {
          const begins = layer.mediaStart ?? 0;
          if (time < begins || time > begins + layer.mediaDuration) return false;
        }
        if ((evaluateLayer(layer, time).opacity ?? 1) <= 0.02) return false;
        if (layer.type !== "group") return true;
        return scene.layers.some((child) => child.parentId === layer.id && shown(child));
      };
      return shown(scene.layers.find((layer) => layer.id === layerId));
    },
    /** A scene layer's box on screen at `time` (its own moves and scale about its center applied). */
    boxAt(layerId, time) {
      const state = evaluateLayer(scene.layers.find((layer) => layer.id === layerId), time);
      const width = state.width * Math.abs(state.scaleX ?? 1);
      const height = state.height * Math.abs(state.scaleY ?? 1);
      return { x: state.x + (state.width - width) / 2, y: state.y + (state.height - height) / 2, width, height };
    },
    /** Where a layer is in the stack: a higher number is drawn on top. */
    order(layerId) { return scene.layers.findIndex((layer) => layer.id === layerId); },
    /**
     * Changes a clip's timing on one of the scene's layers (mediaStart, mediaOffset,
     * mediaDuration): a clip the move shows starts playing when it is shown. Removing or making
     * the move again puts the old values back.
     */
    set(layerId, properties) {
      const layer = scene.layers.find((entry) => entry.id === layerId);
      if (!layer) throw new Error(`${definition.name}: no layer ${layerId} to change.`);
      for (const key of Object.keys(properties)) if (!RESTORED.includes(key)) throw new Error(`${definition.name}: a move cannot change ${key}.`);
      sets.push({ layerId, properties });
    },
    /** The video layers a scene layer is or holds (a clip in a camera group), as they are now. */
    clipsOf(layerId) { return ctx.mediaOf(layerId).filter((layer) => layer.type === "video"); },
    /** The layer and every layer inside it (groups in groups too) that is a picture or a clip. */
    mediaOf(layerId) {
      const ids = new Set([layerId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const layer of scene.layers) if (layer.parentId && ids.has(layer.parentId) && !ids.has(layer.id)) { ids.add(layer.id); grew = true; }
      }
      return scene.layers.filter((layer) => ids.has(layer.id) && (layer.type === "video" || layer.type === "image"));
    },
    /** Moves one of the scene's layers to just above another (a reveal needs the new shot on top). */
    raise(layerId, aboveId) { raises.push({ layerId, aboveId }); notes.push(`put ${layerId} above ${aboveId}`); },
  };
  const built = definition.build(ctx, input) ?? {};
  const end = round(built.end ?? ctx.end);
  if (end > scene.duration + 1e-6)
    throw Object.assign(new Error(`${definition.name} ${id} would end at ${end} s, after the scene ends (${scene.duration} s). Start it earlier, shorten dur, or lengthen the scene (retime {scene, duration}).`), { needs: end });
  // textLayer counts a text's lines for the build only (as in recipes); it is not a layer property.
  for (const { layer } of added) delete layer.lines;
  // A move may leave out a technique it was asked not to use (rgb-split-hit with kick 0: no beat-kick).
  // A move may name moments for sound (roll: one cue per item), in scene seconds.
  // A move that times itself from its fields (caption-words from its first word) says when it starts.
  // An accent move names the cue that motivates it ({cue, at, motive, weight}): effect_fit reads it.
  return { added, animations, raises, sets, start: round(built.start ?? ctx.start), end, notes, tags: [...(built.tags ?? definition.tags)], cues: built.cues ?? [], ...(built.trigger ? { trigger: built.trigger } : {}) };
}

/** Removes what the move `id` made in a scene: its layers and the animations it put on others. */
export function removeMove(scene, id) {
  const prefix = `${id}.`;
  // The clip timing it changed on your layers goes back to what it was.
  const restore = scene.moves?.find((entry) => entry.id === id)?.restore ?? {};
  for (const [layerId, before] of Object.entries(restore)) {
    const layer = scene.layers.find((entry) => entry.id === layerId);
    if (!layer) continue;
    for (const [key, value] of Object.entries(before)) {
      if (value === null) delete layer[key];
      else layer[key] = value;
    }
  }
  scene.layers = scene.layers
    .filter((layer) => layer.move?.instance !== id)
    .map((layer) => (layer.animations ?? []).some((animation) => animation.id?.startsWith(prefix))
      ? { ...layer, animations: layer.animations.filter((animation) => !animation.id?.startsWith(prefix)) }
      : layer);
  if (scene.moves) scene.moves = scene.moves.filter((entry) => entry.id !== id);
}

/**
 * Puts a built move into the scene (in place): new layers where their place says, animations
 * on their layers, and the move's record in scene.moves (settings, so it can be made again).
 */
export function placeMove(scene, { id, name, settings }, made) {
  for (const { layerId, aboveId } of made.raises ?? []) {
    const layer = scene.layers.find((entry) => entry.id === layerId);
    scene.layers = scene.layers.filter((entry) => entry !== layer);
    scene.layers.splice(scene.layers.findIndex((entry) => entry.id === aboveId) + 1, 0, layer);
  }
  for (const { layer, place } of made.added) {
    if (place === "bottom") scene.layers.unshift(layer);
    else if (place === "top") scene.layers.push(layer);
    else {
      const reference = place.below ?? place.above;
      const index = scene.layers.findIndex((entry) => entry.id === reference);
      if (index < 0) throw new Error(`${name}: no layer ${reference} to place ${layer.id} next to.`);
      scene.layers.splice(place.below ? index : index + 1, 0, layer);
    }
  }
  const restore = {};
  for (const { layerId, properties } of made.sets ?? []) {
    const layer = scene.layers.find((entry) => entry.id === layerId);
    if (!layer) continue;
    const before = (restore[layerId] ??= {});
    for (const key of Object.keys(properties)) if (!(key in before)) before[key] = layer[key] ?? null;
    Object.assign(layer, properties);
  }
  for (const { layerId, animation } of made.animations) {
    const layer = scene.layers.find((entry) => entry.id === layerId);
    layer.animations = [...(layer.animations ?? []), animation];
  }
  // The record keeps the settings (to make it again), its technique tags, when it plays and the
  // names of the cues it wrote (so making it again or removing it takes only those cues away).
  const record = { id, name, settings, ...(made.tags ? { tags: [...made.tags] } : {}), start: made.start, end: made.end,
    ...(made.cues?.length ? { cues: made.cues.map((cue) => cue.name) } : {}), ...(made.trigger ? { trigger: { ...made.trigger } } : {}), ...(Object.keys(restore).length ? { restore } : {}) };
  scene.moves = [...(scene.moves ?? []).filter((entry) => entry.id !== id), record];
}
