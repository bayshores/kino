// compose: a whole scene from a format, a look, a brand and a list of beats, each
// beat one recipe. Beats get the time their copy needs (or the `dur` you give), and when you
// give a total `duration` the beats stretch to fill it, key beats more than the rest. Each
// beat's layers enter 0.2 s after the beat starts, drift slowly while they are read (hold.js) and
// leave as it ends; the last beat stays to the end. A beat may start with a transition (push, cut-on-motion or mask-wipe).
import { parseFormat } from "./formats.js";
import { fpsLabel, parseFps } from "../frameRate.js";
import { styleFor, seededLook, LOOK_NAMES } from "./looks.js";
import { FEELS } from "./tokens.js";
import { recipeOf, TRANSITION_NAMES } from "./recipes/index.js";
import { applyTransition } from "./recipes/transitions.js";
import { runRecipe, settingsFrom, withoutRetired } from "./recipe.js";
import { backdropLayers } from "./backdrop.js";
import { round } from "../numbers.js";

export const ENTER_DELAY = 0.2;
export const MAX_BEATS = 12;
export const COMPOSITION_TYPES = ["promo", "ad", "clip", "explainer", "sting", "other"];
// 23.976 and 29.97 as frames a second (engine/frameRate.js).
const FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60];
// Beats that carry the message get more of any spare time than openers and closers.
const KEY_BEATS = new Set(["headline-reveal", "device-slide", "feature-callout", "screen-detail", "price-pop", "hook-slam", "tip-card", "step-list", "diagram-build", "bar-chart-grow", "line-chart-draw", "number-counter", "word-stack", "split-reveal"]);
const COMPOSITION_KEYS = new Set(["format", "fps", "duration", "look", "brand", "feel", "type", "seed", "beats"]);
const BEAT_KEYS = new Set(["recipe", "dur", "copy", "media", "slot", "transition", "id", "seed", "align", "enter", "hero", "region"]);
// promo_basics (the checker's gate for promos and ads) wants the logo by 5 s and one hero
// covering 30% of the frame. compose plans for both before it builds anything.
const PROMO_TYPES = new Set(["promo", "ad"]);
const LOGO_RECIPES = new Set(["logo-sting", "logo-build", "wordmark-type"]);
const LOGO_BY = 5;
// A promo's message beat starts by this, so its headline is readable within 5 s (promo_basics).
const MESSAGE_AT = 4.2;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

/** Checks a composition and fills in its defaults. Throws a plain message for each problem. */
export function readComposition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("compose needs {format, look, beats:[{recipe, …}]}.");
  for (const key of Object.keys(raw)) if (!COMPOSITION_KEYS.has(key)) throw new Error(`compose has no field "${key}". Fields: ${[...COMPOSITION_KEYS].join(", ")}.`);
  const frame = parseFormat(raw.format ?? "1920x1080");
  const fps = parseFps(raw.fps ?? 30);
  if (!FPS.includes(fps)) throw new Error(`fps must be one of ${FPS.map(fpsLabel).join(", ")}.`);
  const duration = raw.duration ?? "auto";
  if (duration !== "auto" && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1 || duration > 600))
    throw new Error('duration is seconds from 1 to 600, or "auto" (the time the beats need).');
  // No look given: the seed picks one (backend/agent/blocks.mjs passes the project's seed and says so).
  const look = raw.look ?? seededLook(raw.seed ?? 1);
  if (!LOOK_NAMES.includes(look)) throw new Error(`Unknown look "${look}". Looks: ${LOOK_NAMES.join(", ")}.`);
  if (raw.feel !== undefined && !FEELS[raw.feel]) throw new Error(`feel must be one of ${Object.keys(FEELS).join(", ")}.`);
  if (raw.type !== undefined && !COMPOSITION_TYPES.includes(raw.type)) throw new Error(`type must be one of ${COMPOSITION_TYPES.join(", ")}.`);
  if (raw.seed !== undefined && (!Number.isInteger(raw.seed) || raw.seed < 1 || raw.seed > 1e6)) throw new Error("seed is a whole number from 1 to 1000000.");
  if (raw.brand !== undefined && raw.brand !== null && typeof raw.brand !== "string") throw new Error("brand is the name of a brand kit (set_brand makes one).");
  if (!Array.isArray(raw.beats) || raw.beats.length < 1 || raw.beats.length > MAX_BEATS) throw new Error(`beats must be a list of 1 to ${MAX_BEATS} beats, each {recipe, copy, …}.`);
  const ids = new Set();
  const beats = raw.beats.map((beat, index) => {
    const where = `beat ${index + 1}`;
    if (!beat || typeof beat !== "object" || Array.isArray(beat)) throw new Error(`${where} must be {recipe, copy, …}.`);
    if (typeof beat.recipe !== "string") throw new Error(`${where} needs recipe (library {topic:"blocks"} lists them).`);
    const definition = recipeOf(beat.recipe);
    const copyKeys = new Set((definition.copy ?? []).map((field) => field.key));
    for (const key of Object.keys(beat)) if (!BEAT_KEYS.has(key) && !copyKeys.has(key)) throw new Error(`${where} (${beat.recipe}) has no field "${key}". Beat fields: ${[...BEAT_KEYS].join(", ")}, or its copy fields: ${[...copyKeys].join(", ") || "none"}.`);
    if (beat.dur !== undefined && (typeof beat.dur !== "number" || !Number.isFinite(beat.dur) || beat.dur < 0.5 || beat.dur > 120)) throw new Error(`${where} dur is seconds from 0.5 to 120.`);
    if (beat.transition !== undefined && !TRANSITION_NAMES.includes(beat.transition)) throw new Error(`${where} transition must be one of ${TRANSITION_NAMES.join(", ")}.`);
    if (beat.transition !== undefined && index === 0) throw new Error("The first beat has nothing to change from, so it takes no transition.");
    if (beat.id !== undefined) {
      if (typeof beat.id !== "string" || !ID.test(beat.id)) throw new Error(`${where} id must be 1 to 48 letters, digits, dashes or underscores.`);
      if (ids.has(beat.id)) throw new Error(`${where} repeats the id ${beat.id}.`);
      ids.add(beat.id);
    }
    if (beat.seed !== undefined && (!Number.isInteger(beat.seed) || beat.seed < 1 || beat.seed > 1e6)) throw new Error(`${where} seed is a whole number from 1 to 1000000.`);
    // Reading the copy now gives each problem its beat number.
    try { settingsFrom(definition, beat); } catch (error) { throw new Error(`${where}: ${error.message}`); }
    return JSON.parse(JSON.stringify(beat));
  });
  return {
    format: frame.name, fps, duration, look,
    ...(raw.brand ? { brand: raw.brand } : {}), ...(raw.feel ? { feel: raw.feel } : {}), ...(raw.type ? { type: raw.type } : {}),
    seed: raw.seed ?? 1, beats,
  };
}

// The IDs a recipe instance named `id` would use: its layers and their animations.
function idsOf(layers) {
  return layers.flatMap((layer) => [layer.id, ...(layer.animations ?? []).map((animation) => animation.id)]);
}

/**
 * The first free ID for a beat: `wanted` (with `suffix`) when free, else a numbered one.
 * `probe` makes the instance with a given ID. An explicit ID that is taken is an error.
 */
function freeId(base, { explicit, suffix, taken, probe, renumber = false }) {
  for (let number = 1; number < 200; number += 1) {
    const id = `${base}${number === 1 ? "" : `-${number}`}${suffix}`;
    const made = probe(id);
    if (!idsOf(made.layers).some((entry) => taken.has(entry))) return { id, made };
    if (explicit && !renumber) throw new Error(`id ${id} is already used in this project; choose another.`);
  }
  throw new Error(`No free ID for ${base}.`);
}

// In a promo or ad, the beat that carries the message: the first with a headline, or else the
// first after the logo beats. The beats before it are kept short, so it arrives within 5 s.
function messageBeat(entries, type) {
  if (!PROMO_TYPES.has(type)) return -1;
  const headline = entries.findIndex((entry) => entry.headline);
  return headline >= 0 ? headline : entries.findIndex((entry) => !LOGO_RECIPES.has(entry.beat.recipe));
}

// Spreads `extra` seconds over the beats without a fixed `dur`, by weight. In a promo or ad,
// beats before the message beat get none.
function stretch(lengths, entries, extra, type) {
  const message = messageBeat(entries, type);
  const early = (entry) => entry.index < message;
  const open = entries.filter((entry) => entry.beat.dur === undefined && !early(entry));
  const pool = open.length ? open : [entries.at(-1)];
  const weight = (entry) => (KEY_BEATS.has(entry.beat.recipe) ? 1.6 : 1) * lengths[entry.index];
  const total = pool.reduce((sum, entry) => sum + weight(entry), 0);
  for (const entry of pool) lengths[entry.index] += (extra * weight(entry)) / total;
}

/**
 * Builds the scene's layers. `env`:
 *   fonts      the font registry for measuring text
 *   media      (ref) → {id, src, width, height, name}; throws for an unknown picture
 *   brand      the brand kit (or null); faces: its prepared fonts (or null)
 *   logo       {media} or {text} from the brand, or null
 *   sceneId    the scene's ID (background layers are named after it)
 *   taken      IDs used elsewhere in the project (layers and animations)
 *   suffix     added to every beat ID ("-v2" for a variant)
 *   renumber   true lets a beat's own id take a number when it is taken (for copies)
 *   reduced    reduced motion: fades only
 *   ownRoles   roles of the agent's own layers kept in the scene (a logo or hero there counts)
 * Returns {frame, duration, layers, assertions, beats:[{id, recipe, start, end, needs}], composition, notes}.
 */
export function composeScene(input, env) {
  const composition = readComposition(input);
  const frame = parseFormat(composition.format);
  const style = styleFor({ look: composition.look, brand: env.brand ?? null, frame, faces: env.faces ?? null, feel: composition.feel ?? null });
  const fps = composition.fps;
  const toFrame = (time) => round(Math.round(time * fps) / fps);
  const upToFrame = (time) => round(Math.ceil(time * fps - 1e-6) / fps);
  const taken = new Set(env.taken ?? []);
  const suffix = env.suffix ?? "";
  const common = { style, frame, fonts: env.fonts, media: env.media, logo: env.logo ?? null, reduced: Boolean(env.reduced) };
  const promo = PROMO_TYPES.has(composition.type);
  const ownRoles = env.ownRoles ?? new Set();
  const notes = [];
  // A promo with no hero beat: the first feature-callout's card becomes the hero.
  let heroBeat = -1;
  if (promo && !ownRoles.has("hero")) {
    const hasHero = composition.beats.some((beat) => (recipeOf(beat.recipe).hero && beat.media) || beat.hero === true);
    if (!hasHero) {
      heroBeat = composition.beats.findIndex((beat) => beat.recipe === "feature-callout" && beat.hero === undefined);
      if (heroBeat < 0) throw new Error(`A ${composition.type} needs a hero covering 30% of the frame once (promo_basics). Add a device-slide beat with a product picture, or a feature-callout beat (its card then fills its slot as the hero).`);
      notes.push(`beat ${heroBeat + 1} (feature-callout) is the hero: its card fills its slot, as a ${composition.type} needs one layer covering 30% of the frame`);
    }
  }

  // First pass: an ID and the time each beat needs.
  const entries = composition.beats.map((beat, index) => {
    const definition = recipeOf(beat.recipe);
    const settings = { ...settingsFrom(definition, beat), seed: beat.seed ?? composition.seed + index, ...(index === heroBeat ? { hero: true } : {}) };
    const where = `beat ${index + 1} (${beat.recipe})`;
    let chosen;
    try {
      chosen = freeId(beat.id ?? beat.recipe, {
        explicit: beat.id !== undefined, suffix, taken, renumber: Boolean(env.renumber),
        probe: (id) => runRecipe(definition, { ...common, id, settings, start: 0, end: null }),
      });
    } catch (error) { throw Object.assign(new Error(`${where}: ${error.message}`), { beat: index }); }
    for (const id of idsOf(chosen.made.layers)) taken.add(id);
    if (beat.transition) for (const id of [`${chosen.id}-${beat.transition}-bar`, `${chosen.id}-${beat.transition}-bar.sweep`]) taken.add(id);
    // The last beat stays to the end, so it needs no time to leave.
    const comfortable = upToFrame(ENTER_DELAY + chosen.made.needs + 0.1);
    const last = index === composition.beats.length - 1;
    const least = upToFrame(ENTER_DELAY + (last ? chosen.made.staying : chosen.made.least) + 0.1);
    if (beat.dur !== undefined && beat.dur < least - 1e-6)
      throw Object.assign(new Error(`${where} needs ${least} s (to enter, be read and leave) but dur is ${beat.dur}. Give it at least ${least}, leave dur out, or shorten its copy.`), { beat: index, least });
    const headline = chosen.made.layers.some((layer) => layer.role === "headline");
    return { index, beat, definition, settings, id: chosen.id, needs: chosen.made.needs, comfortable, least, headline };
  });

  // Beat lengths: dur, or the time needed for the recommended hold. A total duration stretches
  // the beats to fill it; when the holds do not fit, beats keep just their reading time.
  const sum = (list) => round(list.reduce((total, length) => total + length, 0));
  // In a promo or ad, the beats before the message beat share at most MESSAGE_AT s (each keeps
  // at least its reading time), so the message is readable within 5 s.
  const message = messageBeat(entries, composition.type);
  const early = entries.filter((entry) => entry.index < message && entry.beat.dur === undefined);
  const [least, comfortable] = [early.reduce((total, entry) => total + entry.least, 0), early.reduce((total, entry) => total + entry.comfortable, 0)];
  const share = comfortable > least ? Math.min(1, Math.max(0, (MESSAGE_AT - least) / (comfortable - least))) : 1;
  let lengths = entries.map((entry) => entry.beat.dur ?? (early.includes(entry) ? Math.floor((entry.least + share * (entry.comfortable - entry.least)) * fps + 1e-6) / fps : entry.comfortable));
  let duration = sum(lengths);
  if (composition.duration !== "auto") {
    duration = composition.duration;
    if (sum(lengths) > duration + 1e-6) lengths = entries.map((entry) => entry.beat.dur ?? entry.least);
    const needed = sum(lengths);
    if (needed > duration + 1e-6)
      throw Object.assign(new Error(`These beats need at least ${needed} s (${entries.map((entry) => `${entry.beat.recipe} ${lengths[entry.index]}`).join(", ")}), more than duration ${duration}. Make duration at least ${Math.ceil(needed * 10) / 10}, drop a beat, or shorten the copy.`), { needed });
    if (duration - needed > 1e-6) stretch(lengths, entries, duration - needed, composition.type);
  }
  const bounds = [0];
  for (const length of lengths) bounds.push(toFrame(bounds.at(-1) + length));
  bounds[bounds.length - 1] = round(duration);
  if (promo && !ownRoles.has("logo")) {
    const logoBeat = entries.find((entry) => LOGO_RECIPES.has(entry.beat.recipe));
    // The logo itself lands within about a second of its beat's start.
    const latest = LOGO_BY - ENTER_DELAY - 1;
    if (!logoBeat) throw new Error(`A ${composition.type} shows the logo by ${LOGO_BY} s (promo_basics). Start with a logo-sting beat (or logo-build, wordmark-type).`);
    if (bounds[logoBeat.index] > latest + 1e-6) throw new Error(`The ${logoBeat.beat.recipe} beat starts at ${bounds[logoBeat.index]} s, but a ${composition.type} shows the logo by ${LOGO_BY} s (promo_basics). Move it earlier, so it starts by ${latest} s.`);
  }

  // Second pass: the layers, timed in their beats.
  const groups = [];
  const assertions = [];
  const beats = [];
  for (const entry of entries) {
    const start = bounds[entry.index];
    const end = bounds[entry.index + 1];
    const last = entry.index === entries.length - 1;
    const made = runRecipe(entry.definition, { ...common, id: entry.id, settings: entry.settings, start: start + ENTER_DELAY, end: last ? null : end, holdUntil: round(duration) });
    const extra = entry.beat.transition
      ? applyTransition(entry.beat.transition, { style, frame, reduced: common.reduced }, { outgoing: groups.at(-1), incoming: made.layers, at: start, id: `${entry.id}-${entry.beat.transition}` })
      : [];
    groups.push([...made.layers, ...extra]);
    assertions.push(...made.assertions);
    for (const note of made.notes) notes.push(`beat ${entry.index + 1} (${entry.beat.recipe}): ${note}`);
    beats.push({ id: entry.id, recipe: entry.beat.recipe, start, end, needs: entry.needs });
  }
  let backdropId = `${env.sceneId ?? "scene"}-bg${suffix}`;
  for (let number = 2; backdropLayers(style, { frame, duration, id: backdropId }).some((layer) => idsOf([layer]).some((id) => taken.has(id))); number += 1)
    backdropId = `${env.sceneId ?? "scene"}-bg-${number}${suffix}`;
  const backdrop = backdropLayers(style, { frame, duration, id: backdropId, reduced: common.reduced });
  return {
    frame, duration: round(duration), background: style.colors.bg, style,
    layers: [...backdrop, ...groups.flat()],
    assertions, beats,
    // Saved with each beat's ID, so making the scene again keeps every layer's ID.
    composition: { ...composition, beats: composition.beats.map((beat, index) => ({ ...withoutRetired(entries[index].definition, beat), ...(beat.copy !== undefined ? { copy: withoutRetired(entries[index].definition, beat.copy) } : {}), id: entries[index].id })) },
    notes,
  };
}
