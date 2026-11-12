// Optional fields the building blocks (engine/blocks/) save on a document, so a later edit can
// regenerate what a recipe or compose made. None of them change how anything draws: a
// document without them opens and renders the same.
//
// Document:
//   brands       [{name, colors, fonts, logos, motion}]: brand kits.
//                colors   {bg, surface, text, accent, accent2}: hex colours for the colour roles
//                fonts    up to 2 families, [{family, weight}]: the first for headlines, the second for body text
//                logos    up to 4: {media} (an uploaded image's ID), {src} (/api/media/<id>) or {text} (a wordmark)
//                motion   snappy, smooth or calm (optional)
// Scene:
//   composition  {format, fps, duration, look, brand, seed, beats, type}: what compose built the scene from
//   footage      {footage, music, voice, treatment, …, made, moves}: what compose {footage} built the
//                scene from, and the layers and moves it made (replaced when it is composed again)
//   variant      {of, set, label, vary, picked}: this scene is a variant of scene `of`; variants that
//                share `set` were made together; vary is timing, layout, look, deck or format; picked is true on the chosen one
//   template     {intro, outro, length, fields}: protected timing. Animations that start in the first
//                `intro` seconds or end in the last `outro` seconds keep their timing when the
//                scene's length changes; the middle stretches. fields: [{name, layer, property}],
//                the few properties a template user may change.
// Layer:
//   recipe       {name, instance, part, settings}: the recipe that made this layer. instance is the
//                ID of the recipe's main layer; part names the other layers; settings (on the main
//                layer only) are what the recipe was given, so it can be made again.
//   move         {name, instance, part}: the move (engine/blocks/moves/) that made this layer.
// Scene (moves):
//   moves        [{id, name, settings}]: the moves applied in this scene, in order, with what each
//                was given, so the same id again makes it again (engine/blocks/move.js).
import { isRecord } from "./numbers.js";

export const MAX_BRANDS = 20;
export const MOTION_FEELS = ["snappy", "smooth", "calm"];
export const VARY_KINDS = ["timing", "layout", "look", "deck", "format"];
export const MAX_TEMPLATE_FIELDS = 12;
export const MAX_MOVES = 60;
const BRAND_COLOR_ROLES = ["bg", "surface", "text", "accent", "accent2"];
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const HEX = /^#(?:[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const MAX_SETTINGS = 12_000;

function fail(path, message) {
  throw new Error(`${path} ${message}.`);
}

const unset = (value) => value === undefined || value === null;

function plainData(value, path, limit) {
  let text;
  try { text = JSON.stringify(value); } catch { fail(path, "must be plain data"); }
  if (text === undefined || text.length > limit) fail(path, `must be plain data of at most ${limit} characters`);
  return JSON.parse(text);
}

function seconds(value, path, maxTime, { allowZero = true } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maxTime || (!allowZero && value === 0))
    fail(path, `must be a number of seconds from ${allowZero ? 0 : "above 0"} to ${maxTime}`);
  return value;
}

function brandOf(raw, path) {
  if (!isRecord(raw)) fail(path, "must be {name, colors, fonts, logos, motion}");
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) fail(`${path}.name`, "must be 1 to 48 letters, digits, dots, dashes or underscores");
  const brand = { name: raw.name };
  if (!unset(raw.colors)) {
    if (!isRecord(raw.colors)) fail(`${path}.colors`, `must be {${BRAND_COLOR_ROLES.join(", ")}}`);
    brand.colors = {};
    for (const [role, color] of Object.entries(raw.colors)) {
      if (!BRAND_COLOR_ROLES.includes(role)) fail(`${path}.colors.${role}`, `is not a colour role (${BRAND_COLOR_ROLES.join(", ")})`);
      if (typeof color !== "string" || !HEX.test(color)) fail(`${path}.colors.${role}`, "must be a hex colour such as #FF6B4A");
      brand.colors[role] = color.toUpperCase();
    }
  }
  if (!unset(raw.fonts)) {
    if (!Array.isArray(raw.fonts) || raw.fonts.length > 2) fail(`${path}.fonts`, "must be a list of at most 2 fonts");
    brand.fonts = raw.fonts.map((font, index) => {
      const at = `${path}.fonts[${index}]`;
      const entry = typeof font === "string" ? { family: font } : font;
      if (!isRecord(entry) || typeof entry.family !== "string" || !entry.family.trim() || entry.family.length > 128) fail(at, "must be {family, weight}");
      const clean = { family: entry.family.trim() };
      if (!unset(entry.weight)) {
        if (!Number.isInteger(entry.weight) || entry.weight < 100 || entry.weight > 900) fail(`${at}.weight`, "must be a whole number from 100 to 900");
        clean.weight = entry.weight;
      }
      return clean;
    });
  }
  if (!unset(raw.logos)) {
    if (!Array.isArray(raw.logos) || raw.logos.length > 4) fail(`${path}.logos`, "must be a list of at most 4 logos");
    brand.logos = raw.logos.map((logo, index) => {
      const at = `${path}.logos[${index}]`;
      if (!isRecord(logo)) fail(at, "must be {media}, {src} or {text}");
      const kinds = ["media", "src", "text"].filter((key) => !unset(logo[key]));
      if (kinds.length !== 1) fail(at, "must have exactly one of media, src or text");
      const [kind] = kinds;
      const value = logo[kind];
      if (typeof value !== "string" || !value.trim() || value.length > (kind === "text" ? 40 : 512)) fail(`${at}.${kind}`, kind === "text" ? "must be 1 to 40 characters" : "must be a media ID or /api/media/ address");
      if (kind === "src" && !/^\/api\/media\/[a-zA-Z0-9._-]+$/.test(value)) fail(`${at}.src`, "must be an uploaded file's address, /api/media/<id>");
      if (kind === "media" && !/^[a-zA-Z0-9._-]{1,128}$/.test(value)) fail(`${at}.media`, "must be an uploaded file's ID");
      const clean = { [kind]: value.trim() };
      if (!unset(logo.name)) {
        if (typeof logo.name !== "string" || !NAME.test(logo.name)) fail(`${at}.name`, "must be 1 to 48 letters, digits, dots, dashes or underscores");
        clean.name = logo.name;
      }
      return clean;
    });
  }
  if (!unset(raw.motion)) {
    if (!MOTION_FEELS.includes(raw.motion)) fail(`${path}.motion`, `must be one of ${MOTION_FEELS.join(", ")}`);
    brand.motion = raw.motion;
  }
  return brand;
}

/** Checks the document's brands. An empty list is removed. */
export function normalizeBlockDocumentFields(document) {
  if (unset(document.brands)) { delete document.brands; return; }
  if (!Array.isArray(document.brands) || document.brands.length > MAX_BRANDS) fail("document.brands", `must be a list of at most ${MAX_BRANDS} brand kits`);
  const names = new Set();
  document.brands = document.brands.map((brand, index) => {
    const clean = brandOf(brand, `document.brands[${index}]`);
    if (names.has(clean.name)) fail(`document.brands[${index}].name`, `repeats the brand name ${clean.name}`);
    names.add(clean.name);
    return clean;
  });
  if (!document.brands.length) delete document.brands;
}

/** Checks a scene's composition, variant and template. Unset values are removed. */
export function normalizeBlockSceneFields(scene, path, maxTime) {
  normalizeSceneMoves(scene, path);
  if (unset(scene.composition)) delete scene.composition;
  else {
    if (!isRecord(scene.composition)) fail(`${path}.composition`, "must be {format, look, beats, …}");
    const composition = plainData(scene.composition, `${path}.composition`, MAX_SETTINGS);
    if (!Array.isArray(composition.beats) || composition.beats.length < 1 || composition.beats.length > 40) fail(`${path}.composition.beats`, "must be a list of 1 to 40 beats");
    scene.composition = composition;
  }

  // compose {footage}: what the edit was made from and what it made (engine/footage/).
  if (unset(scene.footage)) delete scene.footage;
  else {
    if (!isRecord(scene.footage)) fail(`${path}.footage`, "must be {footage, music, voice, treatment, made, …}");
    const footage = plainData(scene.footage, `${path}.footage`, MAX_SETTINGS);
    if (!Array.isArray(footage.footage) || footage.footage.length < 1 || footage.footage.length > 12) fail(`${path}.footage.footage`, "must be a list of 1 to 12 clips");
    for (const key of ["made", "moves"]) if (footage[key] !== undefined && (!Array.isArray(footage[key]) || !footage[key].every((id) => typeof id === "string" && ID.test(id)))) fail(`${path}.footage.${key}`, "must be a list of IDs");
    scene.footage = footage;
  }

  if (unset(scene.variant)) delete scene.variant;
  else {
    const raw = scene.variant;
    if (!isRecord(raw)) fail(`${path}.variant`, "must be {of, set, label, vary}");
    if (typeof raw.of !== "string" || !ID.test(raw.of)) fail(`${path}.variant.of`, "must be a scene ID");
    if (typeof raw.set !== "string" || !NAME.test(raw.set)) fail(`${path}.variant.set`, "must be 1 to 48 letters, digits, dots, dashes or underscores");
    if (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 80) fail(`${path}.variant.label`, "must be 1 to 80 characters");
    if (!VARY_KINDS.includes(raw.vary)) fail(`${path}.variant.vary`, `must be one of ${VARY_KINDS.join(", ")}`);
    const variant = { of: raw.of, set: raw.set, label: raw.label.trim(), vary: raw.vary };
    if (raw.picked !== undefined && raw.picked !== false) {
      if (raw.picked !== true) fail(`${path}.variant.picked`, "must be true or false");
      variant.picked = true;
    }
    // A deck variant keeps the deal it was made from (engine/deck.js), so picking it adopts that deck.
    if (raw.deck !== undefined) {
      const deck = raw.deck;
      const tag = (value) => typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value);
      if (!isRecord(deck) || !Number.isInteger(deck.seed) || deck.seed < 1 || !Number.isInteger(deck.reroll) || deck.reroll < 0
        || !Array.isArray(deck.cards) || deck.cards.length > 8 || !deck.cards.every(tag) || (deck.setPiece != null && !tag(deck.setPiece)))
        fail(`${path}.variant.deck`, "must be {seed, reroll, cards:[tags], setPiece}");
      variant.deck = { seed: deck.seed, reroll: deck.reroll, cards: [...deck.cards], setPiece: deck.setPiece ?? null };
    }
    scene.variant = variant;
  }

  if (unset(scene.template)) delete scene.template;
  else {
    const raw = scene.template;
    if (!isRecord(raw)) fail(`${path}.template`, "must be {intro, outro, length, fields}");
    const length = seconds(raw.length, `${path}.template.length`, maxTime, { allowZero: false });
    const intro = seconds(raw.intro, `${path}.template.intro`, maxTime);
    const outro = seconds(raw.outro, `${path}.template.outro`, maxTime);
    if (intro + outro >= length) fail(`${path}.template`, "intro and outro together must be shorter than the length");
    const fields = raw.fields ?? [];
    if (!Array.isArray(fields) || fields.length > MAX_TEMPLATE_FIELDS) fail(`${path}.template.fields`, `must be a list of at most ${MAX_TEMPLATE_FIELDS} fields`);
    const names = new Set();
    scene.template = {
      length, intro, outro,
      fields: fields.map((field, index) => {
        const at = `${path}.template.fields[${index}]`;
        if (!isRecord(field)) fail(at, "must be {name, layer, property}");
        if (typeof field.name !== "string" || !NAME.test(field.name)) fail(`${at}.name`, "must be 1 to 48 letters, digits, dots, dashes or underscores");
        if (names.has(field.name)) fail(`${at}.name`, `repeats the field name ${field.name}`);
        names.add(field.name);
        if (typeof field.layer !== "string" || !ID.test(field.layer)) fail(`${at}.layer`, "must be a layer ID");
        if (typeof field.property !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(field.property)) fail(`${at}.property`, "must be a layer property name such as text or fill");
        return { name: field.name, layer: field.layer, property: field.property };
      }),
    };
  }
}

// The kinds of accent impact-accent makes (engine/blocks/moves/impact.js).
export const IMPACT_KINDS = Object.freeze(["flash", "shake", "impact-frame", "dip", "strobe", "hit"]);

// The layer fields a move may change on your own layers (ctx.set in engine/blocks/move.js).
// mediaFreeze: a move that carries a clip past its play holds the edge frame (whip-pan holdEnds).
export const RESTORED = Object.freeze(["mediaStart", "mediaOffset", "mediaDuration", "mediaFreeze"]);
const FREEZES = Object.freeze(["none", "first", "last", "both"]);

/** Checks a scene's list of applied moves. */
function normalizeSceneMoves(scene, path) {
  if (unset(scene.moves)) { delete scene.moves; return; }
  if (!Array.isArray(scene.moves) || scene.moves.length > MAX_MOVES) fail(`${path}.moves`, `must be a list of at most ${MAX_MOVES} moves`);
  const ids = new Set();
  scene.moves = scene.moves.map((raw, index) => {
    const at = `${path}.moves[${index}]`;
    if (!isRecord(raw)) fail(at, "must be {id, name, settings}");
    if (typeof raw.id !== "string" || !ID.test(raw.id)) fail(`${at}.id`, "must be an ID");
    if (ids.has(raw.id)) fail(`${at}.id`, `repeats the move ID ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(raw.name)) fail(`${at}.name`, "must be a move name");
    const entry = { id: raw.id, name: raw.name, settings: isRecord(raw.settings) ? plainData(raw.settings, `${at}.settings`, MAX_SETTINGS) : {} };
    // The move's technique tags and when it plays, so check can name what it built.
    if (raw.tags !== undefined) {
      if (!Array.isArray(raw.tags) || raw.tags.length > 8 || !raw.tags.every((tag) => typeof tag === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(tag))) fail(`${at}.tags`, "must be a list of up to 8 technique tags");
      entry.tags = [...raw.tags];
    }
    for (const key of ["start", "end"]) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0) fail(`${at}.${key}`, "must be seconds");
      entry[key] = raw[key];
    }
    // The names of the cues the move wrote (roll), so making it again takes only those away.
    if (raw.cues !== undefined) {
      if (!Array.isArray(raw.cues) || raw.cues.length > 64 || !raw.cues.every((name) => typeof name === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(name))) fail(`${at}.cues`, "must be a list of up to 64 cue names");
      entry.cues = [...raw.cues];
    }
    // The clip timing a move changed on your layers (roll, zoom-through), as it was before, so
    // making the move again or removing it puts it back.
    if (raw.restore !== undefined) {
      const ok = isRecord(raw.restore) && Object.keys(raw.restore).length <= 64 && Object.entries(raw.restore).every(([id, before]) => ID.test(id) && isRecord(before)
        && Object.entries(before).every(([key, value]) => RESTORED.includes(key) && (value === null || (key === "mediaFreeze" ? FREEZES.includes(value) : typeof value === "number" && Number.isFinite(value)))));
      if (!ok) fail(`${at}.restore`, `must be {layerId: {${RESTORED.join(", ")}}}`);
      entry.restore = JSON.parse(JSON.stringify(raw.restore));
    }
    // The cue an accent move answers (impact-accent), so effect_fit reads its reason after a save.
    if (raw.trigger !== undefined) {
      const trigger = raw.trigger;
      const ok = isRecord(trigger) && typeof trigger.cue === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(trigger.cue)
        && typeof trigger.at === "number" && Number.isFinite(trigger.at) && trigger.at >= 0
        && typeof trigger.motive === "string" && /^[a-z][a-z-]{0,23}$/.test(trigger.motive)
        && typeof trigger.weight === "number" && trigger.weight >= 0 && trigger.weight <= 1
        && IMPACT_KINDS.includes(trigger.kind);
      if (!ok) fail(`${at}.trigger`, `must be {cue, at, motive, weight: 0 to 1, kind: ${IMPACT_KINDS.join(", ")}}`);
      entry.trigger = { cue: trigger.cue, at: trigger.at, motive: trigger.motive, weight: trigger.weight, kind: trigger.kind };
    }
    return entry;
  });
  if (!scene.moves.length) delete scene.moves;
}

/** Checks a layer's move record: the move that made it. */
function normalizeLayerMove(layer, path) {
  if (unset(layer.move)) { delete layer.move; return; }
  const raw = layer.move;
  if (!isRecord(raw)) fail(`${path}.move`, "must be {name, instance, part}");
  if (typeof raw.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(raw.name)) fail(`${path}.move.name`, "must be a move name");
  if (typeof raw.instance !== "string" || !ID.test(raw.instance)) fail(`${path}.move.instance`, "must be the move's ID");
  if (typeof raw.part !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(raw.part)) fail(`${path}.move.part`, "must be a part name");
  layer.move = { name: raw.name, instance: raw.instance, part: raw.part };
}

/** Checks a layer's recipe record (and its move record). */
export function normalizeBlockLayerFields(layer, path) {
  normalizeLayerMove(layer, path);
  if (unset(layer.recipe)) { delete layer.recipe; return; }
  const raw = layer.recipe;
  if (!isRecord(raw)) fail(`${path}.recipe`, "must be {name, instance, part, settings}");
  if (typeof raw.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(raw.name)) fail(`${path}.recipe.name`, "must be a recipe name");
  if (typeof raw.instance !== "string" || !ID.test(raw.instance)) fail(`${path}.recipe.instance`, "must be the ID of the recipe's main layer");
  const recipe = { name: raw.name, instance: raw.instance };
  if (!unset(raw.part)) {
    if (typeof raw.part !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(raw.part)) fail(`${path}.recipe.part`, "must be a part name");
    recipe.part = raw.part;
  }
  if (!unset(raw.settings)) {
    if (!isRecord(raw.settings)) fail(`${path}.recipe.settings`, "must be an object");
    recipe.settings = plainData(raw.settings, `${path}.recipe.settings`, MAX_SETTINGS);
  }
  layer.recipe = recipe;
}
