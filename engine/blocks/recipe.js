// Runs a recipe: one call that makes a few designer-tuned layers with their timing, roles and
// assertions. A recipe's build() says what to draw and in what order things enter;
// this file names the layers, times the entrances and exits, checks there is time to read
// every text, and saves the recipe's settings on its main layer so it can be made again.
//
// Layer IDs: the main layer is `id`, the others `id-<part>` (hero-title, hero-title-sub).
// A part marked `child` goes inside the main layer (then a group, as in callout) and leaves with
// it; `exit: "fade"` fades a part out in place; a recipe marked `still` gets no hold motion; a
// part marked `screen` (a screenshot) pushes into a region instead of the group's hold.
// Animation IDs: `<layer>.in`, `<layer>.out`, `<layer>.<name>` (hero-title.in).
import { slotBox, isPortraitFrame } from "./formats.js";
import { entrance, exitFor, exitLength, readSeconds, seeded } from "./build.js";
import { recommendedHold } from "../quality/analysis.js";
import { holdMotion, screenPush } from "./hold.js";
import { round } from "../numbers.js";

// Time after a text is fully in before its exit may start, on top of its reading time.
const READ_MARGIN = 0.15;
// Parts that say no `nudge` get one by their place in the list (a golden-ratio sequence, so no
// two nearby parts match), so a recipe's layers do not all share one easing and duration.
const nudgeOf = (index) => Math.round((((index * 0.618034) % 1) * 0.5 - 0.2) * 1000) / 1000;

function hashName(text) {
  let hash = 0;
  for (const character of String(text)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 997;
}

/** The recipe's default slot for this frame: portrait, square or landscape. */
export function defaultSlot(definition, frame) {
  const slots = definition.slots ?? {};
  if (isPortraitFrame(frame)) return slots.portrait ?? slots.landscape ?? "full";
  if (frame.width === frame.height || frame.height / frame.width > 1) return slots.square ?? slots.landscape ?? "full";
  return slots.landscape ?? "full";
}

/** Reads `copy` (a string or an object) into the recipe's fields, checking what it needs. */
export function readCopy(definition, copy) {
  const fields = definition.copy ?? [];
  const value = typeof copy === "string" || Array.isArray(copy) ? { [fields[0]?.key ?? "text"]: copy } : { ...(copy ?? {}) };
  for (const key of Object.keys(value)) {
    if (!fields.some((field) => field.key === key))
      throw new Error(`${definition.name} has no copy field "${key}". Its fields: ${fields.map((field) => field.key).join(", ") || "none"}.`);
  }
  for (const field of fields) {
    const entry = value[field.key];
    if (entry === undefined || entry === null || entry === "") {
      if (field.required) throw new Error(`${definition.name} needs copy.${field.key} (${field.about}).`);
      delete value[field.key];
      continue;
    }
    if (field.list) {
      if (!Array.isArray(entry) || entry.length < (field.min ?? 1) || entry.length > field.list)
        throw new Error(`${definition.name} copy.${field.key} must be a list of ${field.min ?? 1} to ${field.list} ${field.of ?? "texts"}.`);
      for (const item of entry) {
        const text = typeof item === "object" && item ? item.label : item;
        if (field.of !== "numbers" && (typeof text !== "string" || !text.trim() || text.length > (field.max ?? 60)))
          throw new Error(`${definition.name} copy.${field.key}: each entry must be text of 1 to ${field.max ?? 60} characters.`);
      }
    } else if (field.number) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${definition.name} copy.${field.key} must be a number.`);
    } else if (typeof entry !== "string" || entry.length > (field.max ?? 80)) {
      throw new Error(`${definition.name} copy.${field.key} must be text of at most ${field.max ?? 80} characters.`);
    }
  }
  return value;
}

// Settings a recipe may take besides its copy. enter, align, uppercase, hero, box, color and
// corner are choices only some recipes offer: giving one a recipe does not offer is an error,
// never ignored.
export const SETTING_KEYS = ["media", "slot", "seed", "align", "enter", "uppercase", "hero", "box", "color", "corner", "region"];
const CHOICE_KEYS = ["align", "enter", "uppercase", "hero", "box", "color", "corner", "region"];

/**
 * The recipe settings in an op or a beat: `copy` (a text, a list, or {field: value}) plus any
 * copy field given on its own (text, sub, …), and media, slot, seed, align, enter, uppercase.
 */
export function settingsFrom(definition, raw) {
  const keys = (definition.copy ?? []).map((field) => field.key);
  const loose = Object.fromEntries(keys.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
  let copy = raw.copy;
  if (Object.keys(loose).length) {
    const base = copy === undefined ? {} : typeof copy === "string" || Array.isArray(copy) ? { [keys[0] ?? "text"]: copy } : copy;
    copy = { ...base, ...loose };
  }
  const settings = {};
  if (copy !== undefined) settings.copy = readCopy(definition, copy);
  for (const key of SETTING_KEYS) if (raw[key] !== undefined && raw[key] !== null) settings[key] = raw[key];
  if (settings.align !== undefined && !["left", "center", "right"].includes(settings.align)) throw new Error("align is left, center or right.");
  if (settings.enter !== undefined && typeof settings.enter !== "string") throw new Error("enter is the name of an entrance style.");
  if (settings.uppercase !== undefined && typeof settings.uppercase !== "boolean") throw new Error("uppercase is true or false.");
  if (settings.hero !== undefined && typeof settings.hero !== "boolean") throw new Error("hero is true or false.");
  if (settings.seed !== undefined && (!Number.isInteger(settings.seed) || settings.seed < 1 || settings.seed > 1e6)) throw new Error("seed is a whole number from 1 to 1000000.");
  if (settings.box !== undefined && !(Array.isArray(settings.box) && settings.box.length === 4 && settings.box.every((value) => typeof value === "number" && Number.isFinite(value)) && settings.box[2] > 0 && settings.box[3] > 0))
    throw new Error("box is [x, y, width, height] in frame pixels, such as [640, 300, 420, 360].");
  if (settings.color !== undefined && !(typeof settings.color === "string" && /^(#[0-9a-f]{6}([0-9a-f]{2})?|[a-z][a-z0-9]{0,15})$/i.test(settings.color)))
    throw new Error('color is a hex color ("#ff4f9a") or a look color (accent, accent2, text).');
  if (settings.corner !== undefined && !(typeof settings.corner === "number" && settings.corner >= 4 && settings.corner <= 400)) throw new Error("corner is the bracket length in pixels, 4 to 400.");
  if (settings.region !== undefined && settings.region !== false && !(Array.isArray(settings.region) && settings.region.length === 4 && settings.region.every((value) => typeof value === "number" && value >= 0 && value <= 100) && settings.region[2] > 0 && settings.region[3] > 0))
    throw new Error("region is [x, y, w, h] in % of the picture (look {mode:\"source\"} shows a % grid), or false to keep the screen still.");
  if (settings.media !== undefined && ![].concat(settings.media).every((ref) => typeof ref === "string" && ref)) throw new Error("media is an uploaded picture's ID or name (or a list of them).");
  return settings;
}

/**
 * Makes a recipe's layers. Options:
 *   id        the main layer's ID
 *   settings  what the agent gave: copy, media, slot, style, seed, …
 *   style     from looks.styleFor
 *   frame     {width, height}
 *   fonts     the font registry for measuring text
 *   start     seconds the recipe starts
 *   end       seconds its beat ends (it leaves by then), or null to stay to the end of the scene
 *   media     media(ref) → {id, src, width, height, name}
 *   logo      the brand's logo, if any: {media} or {text}
 *   holdUntil seconds the scene ends, for a recipe that stays (end null): its hold motion runs to then
 * Returns {layers, assertions, readyBy, needs, least, ends}: needs is the beat (in seconds from
 * start) that leaves every text its recommended hold and time to leave; least is the shortest
 * beat that still leaves its reading time (the checker's hold warning may then show); staying
 * is least for a beat that never leaves (the last one).
 */
export function runRecipe(definition, options) {
  const { id, settings = {}, style, frame, fonts, start, end = null, media, logo = null, reduced = false } = options;
  const seed = Number.isInteger(settings.seed) ? settings.seed : 1;
  const ctx = {
    recipe: definition.name, style, frame, fonts, reduced, logo,
    rng: seeded(seed * 1009 + hashName(definition.name)),
    media: (ref) => media(ref),
    used: new Set(),
  };
  const copy = readCopy(definition, settings.copy);
  if (definition.media === "required" && !settings.media) throw new Error(`${definition.name} needs media: an uploaded image's ID or name (library {topic:"media"} lists them).`);
  const pictures = settings.media ? [].concat(settings.media).map((ref) => ctx.media(ref)) : [];
  const box = slotBox(frame, settings.slot ?? defaultSlot(definition, frame));
  const built = definition.build(ctx, { copy, box, media: pictures, settings });
  for (const key of CHOICE_KEYS)
    if (settings[key] !== undefined && !ctx.used.has(key)) throw new Error(`${definition.name} has no ${key} choice; leave ${key} out.`);

  const idOf = (part) => (part ? `${id}-${part}` : id);
  const parts = built.parts;
  const ends = new Map();
  const starts = new Map();
  const layers = [];
  const entrances = new Map();
  // Entrances, in the order the recipe lists them (a part may start after another part).
  for (const [index, entry] of parts.entries()) {
    const layer = { ...entry.layer, id: idOf(entry.part), animations: [] };
    delete layer.lines;
    const spec = entry.enter ?? {};
    let at = start + (typeof spec.at === "number" ? spec.at : 0);
    if (spec.after !== undefined) {
      const key = spec.after === null ? id : idOf(spec.after);
      if (!ends.has(key)) throw new Error(`${definition.name}: part ${entry.part} starts after ${spec.after}, which comes later.`);
      at = ends.get(key) + (spec.gap ?? 0);
    }
    if (spec.with !== undefined) at = starts.get(idOf(spec.with)) + (spec.gap ?? 0);
    at = round(Math.max(0, at));
    if (layer.type === "video") layer.mediaStart = at;
    const made = entrance(ctx, layer, { style: spec.style ?? "fade-up", start: at, kind: spec.kind, nudge: spec.nudge ?? nudgeOf(index), easing: spec.easing, anchor: spec.anchor });
    layer.animations.push({ id: `${layer.id}.in`, ...made.animation });
    for (const extra of made.also ?? []) layer.animations.push({ id: `${layer.id}.${extra.key}`, ...extra.animation });
    // An entrance's length is its longest animation (a pop's scale outlasts its fade).
    entrances.set(layer.id, { ...made.animation, length: Math.max(made.animation.duration, ...(made.also ?? []).map((extra) => extra.animation.duration)) });
    starts.set(layer.id, at);
    ends.set(layer.id, made.end);
    layer.recipe = { name: definition.name, instance: id, ...(entry.part ? { part: entry.part } : {}) };
    layers.push({ layer, entry });
  }
  // Extra animations a recipe adds (a counter, a pulse), timed from its parts' entrances.
  // An extra may start with or after a part, and `follow` copies that part's entrance length and easing.
  // Under reduced motion an extra that moves or resizes a layer is left out (counters stay).
  for (const extra of built.extras ?? []) {
    const target = layers.find(({ entry }) => (entry.part ?? null) === (extra.part ?? null))?.layer;
    if (!target) continue;
    if (reduced && extra.animation.kind !== "counter" && [extra.animation.from, extra.animation.to].some((side) => side && Object.keys(side).some((key) => key !== "opacity"))) continue;
    let base = start;
    if (extra.after !== undefined) base = ends.get(idOf(extra.after));
    if (extra.with !== undefined) base = starts.get(idOf(extra.with));
    const animation = { ...extra.animation, id: `${target.id}.${extra.name}`, start: round(base + (extra.gap ?? 0)) };
    if (extra.follow !== undefined) {
      const lead = entrances.get(idOf(extra.follow));
      animation.duration = lead.duration;
      animation.easing = lead.easing;
    }
    target.animations.push(animation);
    ends.set(target.id, Math.max(ends.get(target.id), round(animation.start + animation.duration)));
  }

  // Time on screen: every text needs its reading time (20 characters a second) and, except
  // logos and captions, the recommended hold for its word count (the checker's hold rule).
  // `least` leaves only the reading time (shorter beats get a hold warning, not an error).
  let readyBy = start;
  let needs = 0;
  let least = 0;
  let staying = 0;
  for (const { layer, entry } of layers) {
    readyBy = Math.max(readyBy, ends.get(layer.id));
    // A part inside the recipe's group leaves with the group.
    const leaver = entry.child ? layers.find(({ entry: other }) => !other.part) : { layer, entry };
    const leaving = leaver.entry.exit === false ? 0 : exitLength(ctx, leaver.layer, entrances.get(leaver.layer.id).length);
    const reading = layer.type === "text" && layer.role !== "decor";
    const held = reading && !["logo", "caption", "label"].includes(layer.role) ? recommendedHold(layer.text) : 0;
    const readOnly = reading ? readSeconds(layer.text) + READ_MARGIN : 0.4;
    const read = Math.max(readOnly, held);
    needs = Math.max(needs, ends.get(layer.id) - start + read + leaving + (built.hold ?? 0));
    least = Math.max(least, ends.get(layer.id) - start + readOnly + leaving + (built.hold ?? 0));
    staying = Math.max(staying, ends.get(layer.id) - start + readOnly + (built.hold ?? 0));
  }
  needs = round(needs);
  least = round(least);
  staying = round(staying);

  // Exits: every layer leaves so its exit ends at `end`.
  if (end !== null && options.exit !== false) {
    if (end - start < least - 1e-6)
      throw Object.assign(new Error(`${definition.name} needs ${least} s to enter, be read and leave, but its beat gives ${round(end - start)} s. Make the beat at least ${Math.ceil(least * 10) / 10} s, or shorten the copy.`), { needs: least });
    for (const { layer, entry } of layers) {
      if (entry.exit === false || entry.child) continue;
      layer.animations.push({ id: `${layer.id}.out`, ...exitFor(ctx, layer, entrances.get(layer.id).length, end, { fade: entry.exit === "fade" }) });
    }
  }

  // The hold: once every part has landed, the group moves slowly until it leaves (or until
  // `holdUntil`, the end of the scene, for a recipe that stays). Each exit then starts from where
  // the hold left its layer.
  const exits = layers.map(({ layer }) => layer.animations.find((animation) => animation.kind === "out")).filter(Boolean);
  const holdEnd = exits.length ? Math.min(...exits.map((animation) => animation.start)) : end === null ? options.holdUntil ?? null : null;
  // A recipe that marks a place in the picture (a callout over footage) keeps still: a drift
  // would slide it off what it marks.
  if (holdEnd !== null) {
    const held = definition.still ? new Map() : holdMotion(layers.map(({ layer }) => layer), { frame, from: readyBy, to: holdEnd, seed: seed * 31 + hashName(definition.name), reduced });
    // A screenshot (a part marked screen) pushes into its region instead: settings.region, else
    // the picture's busiest part (engine/imageFacts.js). region: false keeps the group's hold.
    if (settings.region !== false) for (const { layer, entry } of layers) {
      if (!entry.screen) continue;
      // focus: the part's own push point (screen-detail's lifted card pushes about its middle).
      const region = entry.focus ?? settings.region ?? entry.screen.busy ?? [30, 30, 40, 40];
      const keep = layers.filter(({ layer: other }) => other.type === "text").map(({ layer: other }) => ({ x0: other.x, y0: other.y, x1: other.x + other.width, y1: other.y + other.height }));
      // room "card": a picture on the recipe's card (feature-callout) drifts with the card and pushes
      // only as far as the card's end box, less a rim, so it never leaves the card.
      const card = entry.room === "card" ? layers.find(({ entry: other }) => !other.part)?.layer : null;
      const cardMove = card ? held.get(card.id) : null;
      let room = entry.room === "card" ? null : entry.room ?? null;
      if (card) {
        const scale = cardMove ? (cardMove.animation.to.scaleX ?? 1) / (cardMove.animation.from.scaleX ?? 1) : 1;
        const rim = Math.round(0.015 * Math.min(frame.width, frame.height));
        const [cx, cy] = [card.x + card.width / 2 + (cardMove?.dx ?? 0), card.y + card.height / 2 + (cardMove?.dy ?? 0)];
        const [w, h] = [(card.width * scale) / 2 - rim, (card.height * scale) / 2 - rim];
        room = { x0: cx - w, y0: cy - h, x1: cx + w, y1: cy + h };
      }
      const own = card ? held.get(layer.id) : null;
      const shift = own ? { dx: own.dx, dy: own.dy } : null;
      // Every screen part pushes over the same time, so parts that sit on one another stay lined up.
      const push = screenPush(layer, region, { from: readyBy + 0.1, to: holdEnd, keep, room, shift, reduced });
      // On a card it eases as the card does, so the two move together all the way.
      if (push && cardMove) push.animation.easing = [...cardMove.animation.easing];
      if (push) held.set(layer.id, push);
    }
    for (const { layer } of layers) {
      const move = held.get(layer.id);
      if (!move) continue;
      layer.animations.push({ id: `${layer.id}.hold`, ...move.animation });
      const exit = layer.animations.find((animation) => animation.kind === "out");
      for (const side of exit ? [exit.from, exit.to] : []) {
        if (side?.y !== undefined) side.y = round(side.y + move.dy);
        if (side?.x !== undefined) side.x = round(side.x + move.dx);
        // A pushed screen leaves from its pushed size, not with a jump back.
        for (const key of move.scale ? ["scaleX", "scaleY"] : []) if (side?.[key] !== undefined) side[key] = round(side[key] * move.scale);
      }
    }
  }

  const assertions = (built.assertions ?? []).map((assertion) => {
    const target = idOf(assertion.part ?? null);
    const note = `recipe ${definition.name}`;
    if (assertion.type === "visible_by") return { type: "visible_by", target, time: round(ends.get(target) + (assertion.slack ?? 0.1)), note };
    if (assertion.type === "before") return { type: "before", target, other: idOf(assertion.other), note };
    return { type: "inside_frame", target, note };
  });

  // Parts marked child go inside the main layer (a group): their places become the group's own
  // (relative to its corner), animations included.
  const group = layers.find(({ entry }) => !entry.part)?.layer;
  for (const { layer, entry } of layers) {
    if (!entry.child || !group) continue;
    layer.parentId = group.id;
    layer.x = round(layer.x - group.x);
    layer.y = round(layer.y - group.y);
    for (const animation of layer.animations) for (const side of [animation.from, animation.to]) {
      if (typeof side?.x === "number") side.x = round(side.x - group.x);
      if (typeof side?.y === "number") side.y = round(side.y - group.y);
    }
  }

  const main = group ?? layers[0].layer;
  if (options.role) main.role = options.role;
  main.recipe = { ...main.recipe, settings: { ...settings, ...(settings.copy !== undefined ? { copy: settings.copy } : {}) } };
  return { layers: layers.map(({ layer }) => layer), assertions, readyBy: round(readyBy), needs, least, staying, ends: Object.fromEntries(ends) };
}
