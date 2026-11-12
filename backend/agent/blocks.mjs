// The building-block operations an agent sends in `edit` (plan §3.4):
//   recipe, compose, variants, pick_variant          make layers and scenes from recipes
//   place, align, distribute, stack, fit             lay layers out (blocks-layout.mjs)
//   set_cue, remove_cue                              named moments that timing can point at
//   set_brand, remove_brand                          brand kits (colours, fonts, logos, feel)
//   make_template, use_template, retime              templates with protected timing
//   shift                                            ripple insert or remove time (engine/speech.js)
//   mark_subject                                     the subject's box on a video's source frame
//   frame_shot                                       kino's own crop (or blurred backdrop) for a hand-placed video
//   split_image                                      a screenshot cut into pieces in place (engine/splitImage.js)
//   board                                            the storyboard (engine/board.js)
// They run in the agent service, like set_font, because they need fonts to measure text, the
// uploaded media, and the brand's font files. Each one changes a copy of the document and
// hands back the checked result. This file also turns relative times in add_animation and
// update_animation ("after:title.in", "with:logo+0.1", "cue:drop", "auto") into seconds.
import { randomUUID } from "node:crypto";
import { applyOperations } from "../../engine/operations.js";
import { createLayer, createScene, parseDocument } from "../../engine/model.js";
import { hasMediaPlay, mediaFrameState, mediaPlaybackRange } from "../../engine/playback.js";
import { MAX_ASK_SHOWS, MAX_SUBJECT_BOXES, SAME_MOMENT, subjectBox, subjectOnScene } from "../../engine/sourceView.js";
import { FACE_PARTS, facePartPoint, pickFace } from "../../engine/footage/faceParts.js";
import { moveBeatCues } from "../../engine/beatCues.js";
import { shiftScene } from "../../engine/speech.js";
import { nextScenePosition } from "../../engine/sceneLayout.js";
import { ALIGNMENTS } from "../../engine/arrange.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { retimeBehavior } from "../../engine/behavior.js";
import { composeScene, readComposition } from "../../engine/blocks/compose.js";
import { buildVideoFormat, expandVideoFormat, VIDEO_FORMATS, VIDEO_FORMAT_NAMES } from "../../engine/blocks/videoFormats.js";
import { runRecipe, settingsFrom, SETTING_KEYS } from "../../engine/blocks/recipe.js";
import { placeMove, readMoveInput, removeMove, runMove } from "../../engine/blocks/move.js";
import { withCues } from "../../engine/cues.js";
import { footageCueTime } from "../../engine/footageCues.js";
import { MAX_TIME } from "../../engine/schema.js";
import { MOVES, MOVE_NAMES, moveOf } from "../../engine/blocks/moves/index.js";
import { describeRecipes, recipeOf, RECIPE_NAMES, TRANSITIONS, TRANSITION_NAMES } from "../../engine/blocks/recipes/index.js";
import { applyTransition } from "../../engine/blocks/recipes/transitions.js";
import { LOOKS, LOOK_NAMES, lookOf, seededLook, styleFor } from "../../engine/blocks/looks.js";
import { FORMATS, NAMED_SLOTS, parseFormat, slotBox } from "../../engine/blocks/formats.js";
import { animationWindow, entranceWindow, lastEntranceEnd, parseAt, resolveAt } from "../../engine/blocks/timing.js";
import { DURATIONS, EASING_TOKENS, FEELS } from "../../engine/blocks/tokens.js";
import { MOTION_FEELS, VARY_KINDS } from "../../engine/blockFields.js";
import { EXAMPLES } from "../../engine/blocks/examples.js";
import { prepareFontPatches } from "../font-selection.mjs";
import { closest, nearMiss } from "./refs.mjs";
import { createLayoutOps, isSlot } from "./blocks-layout.mjs";
import { frameTransform } from "../../engine/camera.js";
import { homeCamera } from "../../engine/blocks/moves/plane.js";
import { groupLayers } from "../../engine/grouping.js";
import { geometryOf } from "../../engine/arrange.js";
import { splitImage } from "../../engine/splitImage.js";
import { evaluateLayer } from "../../engine/animation.js";
import { BOARD_LIMITS, boardCoverage, boardSpan, FOLLOW, keepShotIds, mainScene, moveProblems, NONE, PLANNED_MOVES, normalizeBoard, ONE_FRAME, PACING, SHOT_LAYERS, WHOLE } from "../../engine/board.js";
import { PRESET_DEFINITIONS } from "../../engine/presetCatalog.js";
import { sec } from "./describe.mjs";
import { SOURCE_LIMITS } from "../../engine/sources.js";
import { projectSeed } from "../../engine/deck.js";
import { composeLenient, deckComposition, deckFinish } from "../../engine/blocks/deckVariant.js";
import { FOOTAGE_FIELDS, readFootageList } from "./footage.mjs";
import { frameShot } from "../../engine/footage/layout.js";
import { markWays, MARK_ZOOM_MOST } from "../../engine/footage/burned.js";

// "top-left and bottom-right": where a file's burned-in marks sit.
const markPlaces = (marks) => [...new Set(marks.map((mark) => mark.where).filter(Boolean))].join(" and ") || "corner";
import { planEdit } from "../../engine/footage/plan.js";
import { footageCues, footageOps } from "../../engine/footage/ops.js";
import { footageBrand, guessTreatment, treatmentFromPick, treatmentNamed, TREATMENT_NAMES } from "../../engine/footage/treatments.js";
import { PACE_NAMES } from "../../engine/footage/pace.js";
import { isRecord } from "../../engine/numbers.js";

/** A title from a project's name: "Orbit trailer v2" → "Orbit" (words that name the kind of video go). */
export function projectTitle(name) {
  const words = String(name ?? "").replace(/[-_]+/g, " ").split(/\s+/).filter((word) => word && !/^(trailer|edit|video|promo|demo|test|copy|project|cut|final|draft|reel|clip|v\d+)$/i.test(word));
  const text = words.join(" ").trim();
  return text ? text.slice(0, 40) : null;
}

const round = (value) => Math.round(value * 1000) / 1000;
const PRINTABLE = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join("");
const NEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const CUE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_ASSERTIONS = 100;
const MAX_VARIANTS = { layout: 5, timing: 2, look: 4, deck: 3, format: 3 };
const FORMAT_VARIANTS = ["9:16", "1:1", "4:5"];
const COMPOSE_KEYS = ["format", "fps", "duration", "look", "brand", "feel", "type", "seed", "beats", "reduced"];
// What a recipe op may give besides its copy (SETTING_KEYS, from recipe.js), and what is saved
// with it so it can be made again.
const EXTRA_KEYS = ["at", "dur", "look", "brand", "feel", "role", "reduced"];
// A recipe, move or transition saved with no look was made before looks were seeded: it was crisp.
const LEGACY_LOOK = "crisp";
// What every move op may give besides the move's own fields (saved with it, like a recipe's).
const MOVE_KEYS = ["at", "align", "dur", "seed", "reduced", "look", "brand", "feel"];
// Every field any move has: `layer` and `layers` arrive as layerId and layerIds (FIELD_ALIASES).
const MOVE_FIELDS = [...new Set(Object.values(MOVES).flatMap((move) => Object.keys(move.fields)))]
  .map((key) => (key === "layer" ? "layerId" : key === "layers" ? "layerIds" : key));
const moveFieldKey = (key) => (key === "layer" ? "layerId" : key === "layers" ? "layerIds" : key);
// The move ids earlier ops of the same edit took (one resolver per edit), so two draw-on moves in
// one edit become draw-on and draw-on-2 instead of the second making the first again.
const batchMoveIds = new WeakMap();

/** A problem with suggestions, which the service turns into a "did you mean". */
function problem(message, suggestions = []) {
  return Object.assign(new Error(message), suggestions.length ? { suggestions } : {});
}

// The names a board shot's move may give: every move, transition, recipe and preset, plus each
// craft-plan move built as an edit op (frame, the 2D camera) or a scene setting (drift), added below OPERATIONS.
const BOARD_MOVE_NAMES = new Set([...MOVE_NAMES, ...TRANSITION_NAMES, ...RECIPE_NAMES, ...Object.keys(PRESET_DEFINITIONS).filter((name) => name !== "custom-text")]);

/** A refused board: `boardError` (missing_layer, gap, overlap, bad_shot) goes into the refusal's details. */
function boardProblem(code, message, suggestions = []) {
  return Object.assign(problem(message, suggestions), { boardError: code });
}

/**
 * For a board shot's bad move.ref: a sentence on what this project accepts now. `refs` is its saved
 * references [{id, keys}] (null when kino cannot tell: no sentence). A sent name that is a saved key
 * or id without its moment gets the fixed ref; a near miss the closest one; else the saved names,
 * or, with none saved, the call that saves one.
 */
export function referenceHelp(refs) {
  if (!Array.isArray(refs)) return () => "";
  const plain = (name) => String(name).toLowerCase().replace(/^yt:/, "");
  const shown = refs.map((ref) => ref.keys?.[0] ?? ref.id);
  const names = refs.flatMap((ref) => [...(ref.keys ?? []), ref.id].map((name) => ({ name: plain(name), shown: ref.keys?.[0] ?? ref.id })));
  // The saved names (or the save call) are said once per refusal, with the first shot that needs them.
  let said = false;
  const once = (text) => { if (said) return ""; said = true; return text; };
  return (sent) => {
    if (!names.length) return once('No reference is saved in this project: save one with library {topic:"inspire", name:"save yt:<id> as <key>", take:"<what this edit takes from it>"} (ids come from library {topic:"inspire"}), then send ref "<key>@<seconds>".');
    const base = typeof sent === "string" ? plain(sent.trim().replace(/@.*$/, "")) : "";
    const exact = names.find((entry) => entry.name === base);
    // The key is right but the text already has its "@": the seconds are what is wrong, so say how they are written.
    if (exact && /@/.test(sent)) return `"${exact.shown}" is saved, but its seconds are not valid: write digits with up to 2 decimals and no unit (e.g. "${exact.shown}@3.2").`;
    if (exact) return `"${String(sent).trim()}" is saved as ${exact.shown}: send ref "${exact.shown}@<seconds>", the second of it the shot copies.`;
    const near = base ? nearMiss(base, names.map((entry) => entry.name)) : null;
    const close = near ? names.find((entry) => entry.name === near) : null;
    if (close) return `The closest saved reference is ${close.shown}: send ref "${close.shown}@<seconds>".`;
    return once(`Saved now: ${shown.slice(0, 6).join(", ")}${shown.length > 6 ? ` (+${shown.length - 6} more)` : ""}. Send ref "<one of them>@<seconds>".`);
  };
}

// ---- the operations and their rules --------------------------------------------------------
const OPERATIONS = {
  recipe: {
    fields: ["name", "id", "sceneId", "at", "dur", "look", "brand", "feel", "role", "reduced", "copy", ...SETTING_KEYS, "out", "in"],
    rules: 'recipe {name, scene?, id?, at?, dur?, slot?, copy or its fields (text, sub, …), media?, look?, brand?, feel?, seed?, align?, enter?, uppercase?, hero?, box?, color?, corner?, role?, reduced?}: adds a recipe\'s layers (box, color and corner: callout only). at: seconds, "after:<layer or animation>", "with:<…>+0.1", "cue:<name>" or "auto" (the default: when the last entrance ends). dur: seconds until it has left (left out, it stays to the end). The same id again makes it again with your changes. A transition between two recipes: recipe {name:"push"|"cut-on-motion"|"mask-wipe", out:<recipe id>, in:<recipe id>, at?}.',
  },
  move: {
    fields: ["name", "id", "sceneId", "remove", ...MOVE_KEYS, ...MOVE_FIELDS],
    rules: 'move {name, at, align?, dur?, scene?, id?, seed?, reduced?, look?, brand?, …its fields}: builds a designed set piece (zoom-through, whip-pan, caption-words, …) from your layers, pictures and brand. at: seconds or any at form ("cue:drop", "after:title.in"); align: start (default), center or end puts the span starting at, centered on or ending at at (end lands a transition on the beat). Layer fields take names or codes of top-level layers (give a group for nested ones; type-on, accent-hit and light-sweep take a layer inside a group as itself). The same id again makes it again with your changes; {name, id, remove:true} takes it away. id names its parts (<id>-<part>) and the animations it puts on your layers (<id>.<role>-<name>). library {topic:"moves"} lists them; library {topic:"moves", name} gives one\'s fields and an example.',
  },
  compose: {
    fields: ["sceneId", "id", "name", "videoType", ...COMPOSE_KEYS.filter((key) => key !== "type"), ...FOOTAGE_FIELDS],
    rules: 'compose {footage:[media or {media, in?, out?}], music?, voice?, treatment?: calm|story|punchy|loud, pace?: promo|velocity, accents?, duration?, format?, seed?, title?, end?}: a whole edit from footage (moments, cuts on the beat, layouts, captions, title, end card, mix), then check fixes it; dry_run:true gives the plan in words. pace cuts pictures as runs of whole beats on the beat grid, the rate changing only at a phrase line (promo about 2 beats a shot, velocity 1), calm open, ending twice as fast; accents:true zoom-punches the downbeats (off by default), never under words. compose {format?, duration?, look?, brand?, feel?, type?: promo|ad|clip|explainer|sting|other, seed?, fps?, reduced?, beats:[{recipe, copy or its fields, media?, dur?, slot?, transition?, id?, seed?, hero?, region?}], scene?, id?, name?}: builds a whole scene, beat after beat. A promo or ad needs a logo beat (logo-sting, logo-build, wordmark-type) starting by 3.8 s and a hero: device-slide with a picture, or a feature-callout, whose card then fills its slot. A screenshot pushes into region [x, y, w, h] (% of the picture; its busiest part when left out; false keeps it still); screen-detail lifts that part. Left out, scene is the only scene when it is empty or composed; otherwise a new scene (id names it). On a composed scene it changes only the fields you give and keeps your own layers. duration stretches the beats to fill it.',
  },
  format: {
    fields: ["name", "slots", "aspect", "sceneId", "id", "seed"],
    rules: 'format {name, slots:{…}, aspect?, scene?, id?, seed?}: a whole video in a designer-tuned format (product-launch, app-demo, social-promo, feature-announcement, testimonial): its frame, length, beats, pacing, look, transitions and music cues are set; slots fill it (text, lists, imported pictures, logo or name, music, brand). Copy that needs longer than a beat\'s planned length makes the video longer. It is a compose scene, so variants, retime and compose {scene} change it after. library {topic:"formats", name} gives the slots and an example.',
  },
  variants: {
    fields: ["sceneId", "count", "vary", "formats"],
    rules: 'variants {scene, vary?:"layout"|"timing"|"look"|"deck"|"format", count?, formats?}: new scenes beside a composed scene: layout tries other seeds (up to 5), timing the other feels (2), look the other looks (4), deck the project\'s next decks (3: seed, transition, entrances, camera and texture cards; the note says which cards are left to build), format composes it again in each of formats (default ["9:16", "1:1", "4:5"]; a compose {footage} scene too, cropped on its marked subjects), then check {fix:"auto"} runs on each and finished says what is left. look {mode:"variants", scene} shows them side by side (deck: the first 8 s); pick_variant {scene} marks the one to keep (a deck variant\'s deck becomes the project\'s).',
  },
  pick_variant: { fields: ["sceneId"], rules: "pick_variant {scene}: marks this scene as the chosen one of its variant set (the others stay until you delete_scene them)." },
  place: {
    fields: ["layerIds", "layerId", "sceneId", "below", "above", "left_of", "right_of", "gap", "align", "slot", "valign", "on", "of", "at", "offset"],
    rules: "place {layers, below|above|left_of|right_of: <layer>, gap?, align?: start|center|end} moves layers (as one group) next to another layer; place {layers, slot, align?: left|center|right, valign?: top|middle|bottom} moves them into a slot (C2:E4, center, bottom, …); place {layers, on: mouth|eyes|between-eyes|face|above-head, of: <video layer>, at?, offset?: [x, y]} centers them on that part of the face the footage shows at at (default: the layers' first entrance): a mark_subject box with that part is exact, a head mark or a face kino found is an estimate from the box (look to confirm; offset moves it by % of the face box).",
  },
  align: {
    fields: ["layerIds", "layerId", "sceneId", "to", "within"],
    rules: "align {layers, to: left|center|right|top|middle|bottom (or a list of two), within?: safe|frame|<slot>|<layer>}: lines each layer up with an edge or the centre of the safe area (the default), the frame, a slot or a layer.",
  },
  distribute: {
    fields: ["layerIds", "sceneId", "axis", "within"],
    rules: "distribute {layers, axis?: x|y, within?}: equal gaps between 3 or more layers, keeping the first and last in place; with within (2 or more), from its start to its end.",
  },
  stack: {
    fields: ["layerIds", "sceneId", "direction", "gap", "slot", "align"],
    rules: "stack {layers, direction?: down|right, gap?, slot?, align?: start|center|end}: puts layers one after another in the order given, from the first layer's place or the slot's corner.",
  },
  fit: {
    fields: ["layerIds", "layerId", "sceneId", "into"],
    rules: "fit {layers, into?: safe|frame|<slot>|<layer>}: shrinks layers that do not fit (text by its width, then its font size, never below the readable minimum) and moves them inside.",
  },
  frame: {
    fields: ["layerId", "sceneId", "rect", "at", "to", "cut", "dur"],
    rules: 'frame {layer, rect:[x, y, w, h], at, to?, cut?, dur?}: the 2D camera. It moves the layer\'s group (one named <layer>-camera is made around it when it has none; nothing looks different) so the region rect (% of the layer) fills the frame, centered (to:"center", the default), or sits with its center at x, y and w wide (to:[x, y, w], % of the frame). cut:true jumps there at `at` (a stepped punch-in or an axial cut, exempt from speed_jump); otherwise an expo-out move of dur seconds (default 0.7). Several frame ops make a sequence: each starts from where the camera is at its time.',
  },
  set_cue: { fields: ["name", "at", "time", "layerId", "media"], rules: 'set_cue {name, at | layer, media}: a named moment (a marker) that at:"cue:<name>" points at. at is seconds or any other at form. Or layer + media: pinned to media seconds into a video or audio clip\'s file; it follows the clip when trimmed, moved or sped up (not a Speed animation).' },
  remove_cue: { fields: ["name"], rules: "remove_cue {name}: removes a marker you set." },
  set_brand: {
    fields: ["name", "colors", "fonts", "logos", "motion"],
    rules: "set_brand {name, colors?: {bg, surface, text, accent, accent2}, fonts?: [{family, weight?}] (headlines, then body), logos?: [{media}|{text}], motion?: snappy|smooth|calm}: makes or replaces a brand kit. compose and recipe take brand (the only kit when left out).",
  },
  remove_brand: { fields: ["name"], rules: "remove_brand {name}: removes a brand kit (scenes keep their colours)." },
  make_template: {
    fields: ["sceneId", "intro", "outro", "fields"],
    rules: "make_template {scene, intro?, outro?, fields?: [{name, layer, property}]}: the first intro and last outro seconds keep their timing when the scene is retimed; fields are what use_template may change (default: every text and picture).",
  },
  use_template: {
    fields: ["template", "sceneId", "id", "name", "values", "duration"],
    rules: "use_template {template, id?, name?, values?: {field: value}, duration?}: a new scene copied from a template scene, with its fields set and, with duration, retimed.",
  },
  retime: {
    fields: ["sceneId", "duration"],
    rules: "retime {scene, duration}: changes a scene's length. A template keeps its intro and outro timing and stretches the middle; a composed scene is composed again; any other scene keeps its first and last 15%.",
  },
  shift: {
    fields: ["sceneId", "at", "by"],
    rules: "shift {at, by, scene?}: a ripple insert. Everything at or after at (layer play times, animations, cues, captions, rests) moves by seconds and the scene grows by by; an animation running across at stretches. A negative by takes out the by seconds before at, refused when something starts or ends in them. at takes any at form (\"cue:win\").",
  },
  mark_subject: {
    fields: ["layerId", "t", "box", "part", "shows"],
    rules: 'mark_subject {layer, t, box, part?, shows?}: marks the subject in a video layer\'s source frame at scene time t, after you looked at it (no t: the frame of your last look at that layer; a look anywhere in the same shot of the file counts as seen). box is [x, y, w, h] in % of the source (look {mode:"source"} draws the grid; x, y is the top-left corner); kino keeps it at that moment of the file. part names a deliberate part crop (part:"eyes" for a strip). shows names what of the ask this frame shows (the word ask_unmet names; it counts only at a second you looked at). Send shows without box when it stands in the background: the subject boxes stay as they are (shows with box:null removes that mark). box:null removes the box at that frame. Mark each shot\'s start, middle and end (a listed end is the next shot\'s first frame: mark 0.05 s before it), and every 0.5 s where the subject moves.',
  },
  frame_shot: {
    fields: ["layerId", "layerIds", "sceneId"],
    rules: 'frame_shot {layer | layers}: kino\'s own framing for video layers placed by hand: a crop on the subject marked (mark_subject), else on the faces kino found in the file, or the whole shot as a card over a blurred copy of itself when no crop keeps them. kino reads the file\'s size and the faces a full check saved (none yet: the receipt says so). mark_subject first to aim it; a layer in a group is refused.',
  },
  split_image: {
    fields: ["layerId", "sceneId", "boxes"],
    rules: 'split_image {layer, boxes:[{name, rect:[x, y, w, h]}]}: cuts a picture layer (a screenshot, a still of a screen recording) into pieces in place, real pixels: each piece <layer>-<name> is a clipping group (rect in % of the picture\'s box) holding the picture, so nothing moves until you animate it (move build-in). The picture is replaced by its pieces; a part in no box is no longer shown, so give a box for the background too. Split before animating; warns when the picture shows above 1.3x its pixels.',
  },
  source: {
    fields: ["name", "text"],
    rules: `source {name, text}: saves material the person gave you (their message, a README, a script, a transcript), word for word: up to ${SOURCE_LIMITS.text} characters each, ${SOURCE_LIMITS.count} in all; the same name replaces it, text:null removes it. check's own_words then names on-screen text whose words are in no source.`,
  },
  board: {
    fields: ["music", "shots", "calls", "open"],
    rules: 'board {music, shots:[{cue, dur, pacing, media, in, crop, subject, follow, text, sound, move, why, speed?, alts?, id?}], calls?, open?}: the storyboard (undo and rev as any edit); each call replaces it. Shots in time order, no gaps: over the music layer, or the whole video when music is "none". Every layer given, "none" when empty: media (an imported video or picture, or a video layer), in (file seconds), speed (the clip\'s playback speed, default 1: a shot uses dur × speed seconds of the file), crop [x, y, w, h] (% of the source, the video\'s shape) or "whole" (shown whole, such as a phone screen beside other things), subject {what, box, eyes?} (% of the source; eyes: the eye line\'s y), follow steady|track|sweep, text {text, family, weight?, size?, y?, fill?} (y: center, % from the top), sound {media, what}. move: the designed move {kind type|transition|camera|ui, name (a move, transition, recipe or preset; planned:true for a craft-plan move not built yet), ref "<reference key>@<seconds>"}, or {none:"<reason>"}; without one the shot is plain (footage plus words). pacing beat_cut|phrase_flow|free; why: one line; calls: your own calls and your decisions on open items left to you (≤ 6); open: questions for the person (≤ 3). A shot sent without id keeps the id of the shot it continues (same clip and nearest in, or same text). look {mode:"board"} shows it; notes checkpoint {id:"board"} asks the person.',
  },
};
const FIELD_ALIASES = [["scene", "sceneId"], ["layer", "layerId"], ["layers", "layerIds"]];

export const BLOCK_OPERATION_TYPES = Object.freeze(Object.keys(OPERATIONS));
// A planned craft move built as an edit op (frame) is a board move name, not "planned, not built yet".
for (const name of PLANNED_MOVES) if (Object.hasOwn(OPERATIONS, name)) BOARD_MOVE_NAMES.add(name);
// drift is built as a scene setting (scene.drift), not an op, so a camera shot may name it too.
for (const name of ["drift"]) BOARD_MOVE_NAMES.add(name);
export const isBlockOperation = (type) => typeof type === "string" && Object.hasOwn(OPERATIONS, type);

/** One op's rules, short enough to send with a refusal. */
export function blockRules(type) {
  return isBlockOperation(type) ? OPERATIONS[type].rules : undefined;
}

/** True for add_animation or update_animation with a relative time, which this file resolves. */
export function needsTiming(operation) {
  if (operation?.type === "add_animation")
    return operation.at !== undefined || typeof operation.start === "string" || typeof operation.animation?.start === "string";
  if (operation?.type === "update_animation") return typeof operation.properties?.start === "string";
  return false;
}

// ---- translating (before anything is applied) ------------------------------------------------
const sceneRef = (resolver, value) => resolver.resolve(String(value), "scene");
// A layer may be one this edit makes (a recipe's part): those are found when the op runs.
function layerRef(resolver, value) {
  if (typeof value !== "string" || !value) throw problem("Each layer is a name, ID or code.");
  try { return resolver.resolve(value, "layer"); } catch { return value; }
}
function regionRef(resolver, value) {
  if (value === undefined || value === "safe" || value === "frame") return value;
  if (isRecord(value)) return value;
  if (typeof value !== "string") throw problem("within/into is safe, frame, a slot such as B2:E5, or a layer.");
  return isSlot(value) ? value.replace(/^slot:/i, "") : layerRef(resolver, value);
}
const slug = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function freeId(resolver, base, kinds = ["scene", "layer", "animation"], start = 1) {
  for (let number = start; number < 500; number += 1) {
    const id = number === 1 ? base : `${base}-${number}`;
    if (!kinds.some((kind) => resolver.exists(kind, id))) return id;
  }
  throw problem(`No free ID for ${base}.`);
}
function onlyScene(document, what) {
  if (document.scenes.length === 1) return document.scenes[0].id;
  throw problem(`${what} needs scene when the project has more than one scene.`, document.scenes.map((scene) => scene.id).slice(0, 3));
}
// The start of the IDs made for a scene: its ID, or its name when the ID is a random one.
const RANDOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
function idBase(scene) {
  if (!RANDOM_ID.test(scene?.id ?? "")) return scene?.id ?? "scene";
  return slug(scene.name) || "scene";
}
// How notes name a scene: its ID, or its name in quotes when the ID is a random one.
const sceneLabel = (scene) => (RANDOM_ID.test(scene.id) ? `'${scene.name}'` : scene.id);
const layerList = (operation) => operation.layerIds ?? (operation.layerId !== undefined ? [operation.layerId] : undefined);

// What compose builds from: the op's fields over the scene's saved composition.
function compositionInput(operation, scene) {
  const stored = { ...(scene?.composition ?? {}) };
  delete stored.backdrop;
  const input = {};
  for (const key of COMPOSE_KEYS) {
    // The op's own `type` is "compose": the video type comes as videoType.
    const given = key === "type" ? operation.videoType : operation[key];
    const value = given !== undefined ? given : stored[key];
    if (value !== undefined && value !== null) input[key] = value;
  }
  if (!input.format && scene && !scene.composition) {
    const size = `${scene.width}x${scene.height}`;
    if (FORMATS[size]) input.format = size;
  }
  return input;
}
function readCompose(input) {
  const { reduced, ...rest } = input;
  if (reduced !== undefined && typeof reduced !== "boolean") throw problem("reduced is true or false.");
  return readComposition(rest);
}

// compose {footage}: the scene it builds in (the only scene when it is empty or was built from
// footage before, else a new one) and its fields, checked before anything is measured.
function translateFootage(operation, resolver, document) {
  const allowed = new Set(["type", "videoType", "sceneId", "id", "name", "format", "duration", "seed", ...FOOTAGE_FIELDS]);
  for (const key of Object.keys(operation)) if (!allowed.has(key)) throw problem(`compose {footage} has no field "${key}". Its fields: footage, music, voice, treatment, pace, accents, duration, format, seed, title, end, scene, id, name.`, closest(key, [...allowed]));
  try { operation.footage = readFootageList(operation.footage); }
  catch (error) { throw problem(error.message); }
  for (const key of ["music", "voice"]) if (operation[key] !== undefined && (typeof operation[key] !== "string" || !operation[key].trim())) throw problem(`${key} is an imported sound's name or id.`);
  if (operation.treatment !== undefined && !treatmentNamed(operation.treatment)) throw problem(`treatment is one of ${TREATMENT_NAMES.join(", ")} (or leave it out: the brief's pick or the material chooses).`, closest(String(operation.treatment), TREATMENT_NAMES));
  if (operation.pace !== undefined && operation.pace !== null && !PACE_NAMES.includes(operation.pace)) throw problem(`pace is ${PACE_NAMES.join(" or ")} (shots as runs of whole beats), or null for the treatment's own cutting.`, closest(String(operation.pace), PACE_NAMES));
  if (operation.accents !== undefined && typeof operation.accents !== "boolean") throw problem("accents is true (a zoom punch on the downbeats; off by default) or false.");
  if (operation.duration !== undefined && (typeof operation.duration !== "number" || !Number.isFinite(operation.duration) || operation.duration < 6 || operation.duration > 600)) throw problem("duration is seconds from 6 to 600 (left out, the footage and music choose).");
  if (operation.format !== undefined) { try { parseFormat(operation.format); } catch (error) { throw problem(error.message); } }
  if (operation.seed !== undefined && (!Number.isInteger(operation.seed) || operation.seed < 1 || operation.seed > 1e6)) throw problem("seed is a whole number from 1 to 1000000.");
  for (const key of ["title", "end"]) if (operation[key] !== undefined && (typeof operation[key] !== "string" || !operation[key].trim() || operation[key].length > 60)) throw problem(`${key} is 1 to 60 characters.`);
  if (operation.sceneId !== undefined) {
    operation.sceneId = sceneRef(resolver, operation.sceneId);
  } else if (operation.id === undefined && document.scenes.length === 1 && (!document.scenes[0].layers.length || document.scenes[0].footage)) {
    operation.sceneId = document.scenes[0].id;
  } else {
    if (operation.id !== undefined && (typeof operation.id !== "string" || !NEW_ID.test(operation.id))) throw problem("id must be 1 to 48 letters, numbers, dashes or underscores.");
    if (operation.id !== undefined && resolver.exists("scene", operation.id)) throw problem(`A scene ${operation.id} exists; compose {scene:"${operation.id}", footage} builds it again.`);
    operation.newSceneId = operation.id ?? freeId(resolver, slug(operation.name) || "edit");
    delete operation.id;
  }
}

const TRANSLATE = {
  recipe(operation, resolver, document) {
    if (typeof operation.name !== "string" || !operation.name) throw problem(`recipe needs name, such as headline-reveal. library {topic:"blocks"} lists them.`);
    if (TRANSITION_NAMES.includes(operation.name)) {
      if (operation.out === undefined || operation.in === undefined)
        throw problem(`${operation.name} is a transition: recipe {name:"${operation.name}", out:<recipe id leaving>, in:<recipe id arriving>, at?}.`);
      operation.out = layerRef(resolver, operation.out);
      operation.in = layerRef(resolver, operation.in);
      operation.sceneId = operation.sceneId !== undefined ? sceneRef(resolver, operation.sceneId) : resolver.sceneOf("layer", operation.in) ?? onlyScene(document, "A transition");
      if (operation.id === undefined) operation.id = `${operation.in}-${operation.name}`;
      if (typeof operation.id !== "string" || !NEW_ID.test(operation.id)) throw problem("id must be 1 to 48 letters, digits, dashes or underscores.");
      return;
    }
    let definition;
    try { definition = recipeOf(operation.name); }
    catch (error) { throw problem(error.message, closest(operation.name, [...RECIPE_NAMES, ...TRANSITION_NAMES])); }
    // The same id as an existing recipe makes it again: then the copy may be partial.
    let again = false;
    if (operation.id !== undefined) {
      if (typeof operation.id !== "string") throw problem("id must be text.");
      if (/^L\d+$/i.test(operation.id)) operation.id = resolver.resolve(operation.id, "layer");
      again = resolver.exists("layer", operation.id);
      if (!again && !NEW_ID.test(operation.id)) throw problem("id must be 1 to 48 letters, digits, dashes or underscores.");
    } else operation.id = freeId(resolver, operation.name);
    if (!again) settingsFrom(definition, operation);
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
    else operation.sceneId = (again && resolver.sceneOf("layer", operation.id)) || onlyScene(document, "recipe");
    if (operation.at !== undefined) parseAt(operation.at);
    if (operation.dur !== undefined && (typeof operation.dur !== "number" || !(operation.dur > 0) || operation.dur > 600)) throw problem("dur is seconds, above 0.");
    if (operation.look !== undefined && !LOOK_NAMES.includes(operation.look)) throw problem(`Unknown look "${operation.look}".`, closest(String(operation.look), LOOK_NAMES));
    if (operation.feel !== undefined && !FEELS[operation.feel]) throw problem(`feel is one of ${Object.keys(FEELS).join(", ")}.`);
    if (operation.reduced !== undefined && typeof operation.reduced !== "boolean") throw problem("reduced is true or false.");
  },
  move(operation, resolver, document) {
    if (typeof operation.name !== "string" || !operation.name)
      throw problem('move needs name, such as zoom-through (library {topic:"moves"} lists them). To move a layer on the canvas, use update_layer, or add_animation {preset:"move"}.');
    let definition;
    try { definition = moveOf(operation.name); }
    catch (error) { throw problem(error.message, error.suggestions ?? []); }
    const own = Object.keys(definition.fields).map(moveFieldKey);
    for (const key of MOVE_FIELDS)
      if (operation[key] !== undefined && !own.includes(key)) throw problem(`move ${definition.name} has no field "${key === "layerId" ? "layer" : key === "layerIds" ? "layers" : key}". Its fields: ${Object.keys(definition.fields).join(", ")}.`, closest(key, Object.keys(definition.fields)));
    // Layer fields name the scene's layers: names and codes become IDs.
    const refs = [];
    for (const [key, field] of Object.entries(definition.fields)) {
      const name = moveFieldKey(key);
      if (operation[name] === undefined) continue;
      if (field.kind === "layer") refs.push(operation[name] = layerRef(resolver, operation[name]));
      if (field.kind === "target" && isRecord(operation[name]) && typeof operation[name].layer === "string")
        refs.push((operation[name] = { ...operation[name], layer: layerRef(resolver, operation[name].layer) }).layer);
      if (field.kind === "stops") {
        // Layer names in a list of stops (a name, {layer, point}, or [x, y] pixels) become IDs.
        const one = (entry) => (typeof entry === "string" ? layerRef(resolver, entry) : isRecord(entry) && typeof entry.layer === "string" ? { ...entry, layer: layerRef(resolver, entry.layer) } : entry);
        const value = operation[name];
        operation[name] = Array.isArray(value) && !(value.length === 2 && value.every((entry) => typeof entry === "number")) ? value.map(one) : one(value);
        for (const entry of [operation[name]].flat()) if (typeof entry === "string" || typeof entry?.layer === "string") refs.push(typeof entry === "string" ? entry : entry.layer);
      }
      if (field.kind === "layers") {
        if (!Array.isArray(operation[name])) throw problem(`${definition.name} ${key} is a list of layer names or codes.`);
        operation[name] = operation[name].map((ref) => layerRef(resolver, ref));
        refs.push(...operation[name]);
      }
    }
    const storedIn = (id) => document.scenes.find((scene) => scene.moves?.some((entry) => entry.id === id)) ?? null;
    // remove:true takes a move away: its own layers and the animations it put on yours.
    if (operation.remove !== undefined) {
      if (operation.remove !== true) throw problem("remove is true (to take the move away) or left out.");
      const scene = typeof operation.id === "string" ? storedIn(operation.id) : null;
      if (!scene) {
        const made = document.scenes.flatMap((item) => (item.moves ?? []).filter((entry) => entry.name === definition.name).map((entry) => entry.id));
        throw problem(`remove needs the id of a ${definition.name} move in this project${made.length ? ` (${made.join(", ")})` : " (there are none)"}.`, made);
      }
      operation.sceneId = scene.id;
      return;
    }
    if (!batchMoveIds.has(resolver)) batchMoveIds.set(resolver, new Set());
    const taken = batchMoveIds.get(resolver);
    if (operation.id !== undefined) {
      if (typeof operation.id !== "string" || !NEW_ID.test(operation.id)) throw problem("id must be 1 to 48 letters, digits, dashes or underscores.");
    } else {
      // The same move sent again (same name, same layers, same time) replaces the earlier one
      // instead of stacking a second copy (ceiling study a, FRICTION 6: overexpose-2); a
      // different time or layer adds another.
      const repeated = sameMoveId(document, definition, operation);
      if (repeated !== undefined) {
        operation.id = repeated;
        operation.replaces = true;
      } else {
        for (let number = 1; number < 500 && operation.id === undefined; number += 1) {
          const id = number === 1 ? definition.name : `${definition.name}-${number}`;
          if (!storedIn(id) && !taken.has(id) && !["scene", "layer", "animation"].some((kind) => resolver.exists(kind, id))) operation.id = id;
        }
        // Director a meant to move the first overexpose with a new at and got a second one: the
        // receipt names the earlier one and the call that moves it instead (a note, nothing refused).
        const earlier = sameLayerMoves(document, definition, operation, { sameTime: false })[0];
        if (earlier) operation.earlier = earlier;
      }
    }
    taken.add(operation.id);
    const again = storedIn(operation.id);
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
    else operation.sceneId = again?.id ?? refs.map((ref) => resolver.sceneOf("layer", ref)).find(Boolean) ?? onlyScene(document, "move");
    if (!again && definition.needsAt && operation.at === undefined) throw problem(`${definition.name} needs at: when it starts (seconds, or a time such as "cue:drop").`);
    if (operation.at !== undefined) parseAt(operation.at);
    if (operation.dur !== undefined && (typeof operation.dur !== "number" || !(operation.dur > 0) || operation.dur > 600)) throw problem("dur is seconds, above 0.");
    if (operation.seed !== undefined && (!Number.isInteger(operation.seed) || operation.seed < 1 || operation.seed > 1e6)) throw problem("seed is a whole number from 1 to 1000000.");
    if (operation.look !== undefined && !LOOK_NAMES.includes(operation.look)) throw problem(`Unknown look "${operation.look}".`, closest(String(operation.look), LOOK_NAMES));
    if (operation.feel !== undefined && !FEELS[operation.feel]) throw problem(`feel is one of ${Object.keys(FEELS).join(", ")}.`);
    if (operation.reduced !== undefined && typeof operation.reduced !== "boolean") throw problem("reduced is true or false.");
    // Fields are checked now when the move is new; a move made again may give only what changes.
    if (!again) readMoveInput(definition, moveInputOf(definition, operation));
  },
  // format {name, slots}: checked, then built as a compose op that also carries the music and cues.
  format(operation, resolver, document) {
    if (typeof operation.name !== "string") throw problem(`format needs name: ${VIDEO_FORMAT_NAMES.join(", ")}.`);
    let expanded;
    try { expanded = expandVideoFormat(operation.name, operation.slots ?? {}, { aspect: operation.aspect }); }
    catch (error) { throw problem(error.message, closest(operation.name, VIDEO_FORMAT_NAMES)); }
    const { type: videoType, ...compose } = expanded.compose;
    const formatName = operation.name;
    for (const key of ["name", "slots", "aspect"]) delete operation[key];
    Object.assign(operation, compose, { type: "compose", videoType, name: VIDEO_FORMATS[formatName].title, formatName, formatMusic: expanded.music, formatCues: expanded.cues });
    TRANSLATE.compose(operation, resolver, document);
  },
  compose(operation, resolver, document) {
    if (operation.footage !== undefined) return translateFootage(operation, resolver, document);
    for (const key of FOOTAGE_FIELDS) if (operation[key] !== undefined) throw problem(`${key} belongs to compose {footage:[…]}, the edit from footage.`);
    let scene = null;
    if (operation.sceneId !== undefined) {
      if (operation.id !== undefined) throw problem("id names a new scene; leave it out when you give scene.");
      operation.sceneId = sceneRef(resolver, operation.sceneId);
      scene = document.scenes.find((item) => item.id === operation.sceneId) ?? null;
    } else if (operation.id === undefined && document.scenes.length === 1 && (!document.scenes[0].layers.length || document.scenes[0].composition)) {
      scene = document.scenes[0];
      operation.sceneId = scene.id;
    } else {
      if (operation.id !== undefined && (typeof operation.id !== "string" || !NEW_ID.test(operation.id))) throw problem("id must be 1 to 48 letters, digits, dashes or underscores.");
      if (operation.id !== undefined && resolver.exists("scene", operation.id)) throw problem(`A scene ${operation.id} exists; compose {scene:"${operation.id}"} composes it again.`);
      operation.newSceneId = operation.id ?? freeId(resolver, slug(operation.name) || slug(operation.videoType) || "promo");
      delete operation.id;
    }
    const input = compositionInput(operation, scene);
    if (!input.beats) throw problem("compose needs beats: [{recipe, copy, …}], one per recipe.");
    readCompose(input);
    if (operation.name !== undefined && (typeof operation.name !== "string" || !operation.name.trim() || operation.name.length > 120)) throw problem("name is 1 to 120 characters.");
    // The beats' main layers get these IDs unless they are taken (then a number is added).
    if (Array.isArray(operation.beats)) {
      const seen = new Set();
      operation.beatIds = operation.beats.map((beat) => {
        const base = beat.id ?? beat.recipe;
        let id = base;
        for (let number = 2; seen.has(id) || (!scene?.composition && resolver.exists("layer", id)); number += 1) id = `${base}-${number}`;
        seen.add(id);
        return id;
      });
    }
  },
  variants(operation, resolver, document) {
    operation.vary ??= "layout";
    if (!VARY_KINDS.includes(operation.vary)) throw problem(`vary is one of ${VARY_KINDS.join(", ")}.`, closest(String(operation.vary), VARY_KINDS));
    const reformat = operation.vary === "format";
    // vary "format" also takes a scene compose {footage} made.
    const madeByCompose = (scene) => Boolean(scene.composition || (reformat && scene.footage));
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
    else {
      const composed = document.scenes.filter((scene) => madeByCompose(scene) && !scene.variant?.of || scene.variant?.of === scene.id);
      if (composed.length !== 1) throw problem("variants needs scene: a scene made by compose.", composed.map((scene) => scene.id).slice(0, 3));
      operation.sceneId = composed[0].id;
    }
    const most = MAX_VARIANTS[operation.vary];
    if (reformat) {
      const source = document.scenes.find((scene) => scene.id === operation.sceneId);
      if (source && !madeByCompose(source))
        throw problem(`variants {vary:"format"} reformats a scene made by compose; ${sceneLabel(source)} was built by hand. Build it with compose {format, beats} or compose {footage}, then vary its format.`);
      const asked = operation.formats ?? FORMAT_VARIANTS.filter((name) => !source || `${parseFormat(name).width}x${parseFormat(name).height}` !== `${source.width}x${source.height}`);
      if (!Array.isArray(asked) || !asked.length || asked.length > most) throw problem(`formats is a list of 1 to ${most} formats, such as ["9:16", "1:1", "4:5"].`);
      const sizes = new Set();
      for (const name of asked) {
        let frame;
        try { frame = parseFormat(name); } catch (error) { throw problem(error.message); }
        const size = `${frame.width}x${frame.height}`;
        if (source && size === `${source.width}x${source.height}`) throw problem(`${name} is ${sceneLabel(source)}'s own format (${size}); leave it out.`);
        if (sizes.has(size)) throw problem(`${name} is in formats twice.`);
        sizes.add(size);
      }
      operation.formats = asked.map(String);
      if (operation.count !== undefined && operation.count !== asked.length) throw problem("vary \"format\" makes one scene per format: leave count out.");
      operation.count = asked.length;
    } else if (operation.formats !== undefined) throw problem('formats goes with vary:"format".');
    operation.count ??= Math.min(3, most);
    if (!Number.isInteger(operation.count) || operation.count < 1 || operation.count > most) throw problem(`count is 1 to ${most} for vary ${operation.vary}.`);
    operation.newSceneIds = [];
    const base = idBase(document.scenes.find((scene) => scene.id === operation.sceneId));
    for (let number = 2; operation.newSceneIds.length < operation.count && number < 500; number += 1) {
      const id = `${base}-v${number}`;
      if (!resolver.exists("scene", id)) operation.newSceneIds.push(id);
    }
  },
  pick_variant(operation, resolver) {
    if (operation.sceneId === undefined) throw problem("pick_variant needs scene, the variant to keep.");
    operation.sceneId = sceneRef(resolver, operation.sceneId);
  },
  place(operation, resolver) {
    layoutLayers(operation, resolver);
    if (operation.on !== undefined || operation.of !== undefined) {
      // place {layers, on, of, at?, offset?}: on a face part of a footage layer (engine/footage/faceParts.js).
      if (!FACE_PARTS.includes(operation.on)) throw problem(`on is ${FACE_PARTS.join(", ")}: the face part of the footage layer \`of\` to place on.`, closest(String(operation.on ?? ""), FACE_PARTS));
      if (operation.of === undefined) throw problem("place {on} needs of: the video layer whose face it places on.");
      if (["below", "above", "left_of", "right_of", "slot"].some((key) => operation[key] !== undefined)) throw problem("place takes on + of, or a side, or a slot: one of them.");
      operation.of = layerRef(resolver, operation.of);
      if (operation.at !== undefined) parseAt(operation.at);
      const offset = operation.offset;
      if (offset !== undefined && !(Array.isArray(offset) && offset.length === 2 && offset.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 200)))
        throw problem("offset is [x, y] in % of the face box's width and height (-200 to 200), such as [0, 5] to move 5% of the face's height down.");
      return;
    }
    const sides = ["below", "above", "left_of", "right_of"].filter((key) => operation[key] !== undefined);
    if (sides.length + (operation.slot !== undefined ? 1 : 0) !== 1) throw problem("place needs one of below, above, left_of, right_of (a layer) or slot.");
    for (const key of sides) operation[key] = layerRef(resolver, operation[key]);
    if (operation.slot !== undefined) slotBox({ width: 1920, height: 1080 }, operation.slot);
    checkGap(operation);
  },
  align(operation, resolver) {
    layoutLayers(operation, resolver);
    const to = [].concat(operation.to ?? []);
    if (!to.length || to.length > 2 || !to.every((value) => ALIGNMENTS.some((alignment) => alignment.id === value)))
      throw problem("to is left, center, right, top, middle or bottom, or a list of two (such as [\"center\", \"middle\"]).", closest(String(to[0] ?? ""), ALIGNMENTS.map((alignment) => alignment.id)));
    operation.within = regionRef(resolver, operation.within);
  },
  distribute(operation, resolver) {
    layoutLayers(operation, resolver);
    if (operation.axis !== undefined && !["x", "y"].includes(operation.axis)) throw problem("axis is x or y.");
    operation.within = regionRef(resolver, operation.within);
    if (operation.layerIds.length < (operation.within ? 2 : 3)) throw problem("distribute needs 3 or more layers (2 or more with within).");
  },
  stack(operation, resolver) {
    layoutLayers(operation, resolver);
    if (operation.direction !== undefined && !["down", "right"].includes(operation.direction)) throw problem("direction is down or right.");
    if (operation.align !== undefined && !["start", "center", "end"].includes(operation.align)) throw problem("align is start, center or end.");
    if (operation.slot !== undefined) slotBox({ width: 1920, height: 1080 }, operation.slot);
    checkGap(operation);
  },
  fit(operation, resolver) {
    layoutLayers(operation, resolver);
    operation.into = regionRef(resolver, operation.into);
  },
  frame(operation, resolver) {
    if (operation.layerId === undefined) throw problem("frame needs layer: the layer whose region the camera frames.");
    operation.layerId = layerRef(resolver, operation.layerId);
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
    const numbers = (value, count) => Array.isArray(value) && value.length === count && value.every((item) => typeof item === "number" && Number.isFinite(item));
    const rect = operation.rect;
    if (!numbers(rect, 4) || rect[2] <= 0 || rect[3] <= 0 || rect.some((value) => value < -100 || value > 200))
      throw problem("rect is [x, y, w, h] in % of the layer (0 to 100, w and h above 0), such as [30, 20, 40, 40].");
    if (rect.every((value) => value >= 0 && value <= 1) && rect[2] + rect[3] < 2)
      throw problem(`rect is in % of the layer (0 to 100), not 0 to 1: [${rect.map((value) => Math.round(value * 100)).join(", ")}].`);
    if (operation.at === undefined) throw problem("frame needs at: seconds, or a time such as \"after:title.in\".");
    parseAt(operation.at);
    if (operation.to !== undefined && operation.to !== "center" && !(numbers(operation.to, 3) && operation.to[2] > 0))
      throw problem('to is "center" or [x, y, w]: where the region\'s center goes and how wide it is, in % of the frame.');
    if (operation.cut !== undefined && typeof operation.cut !== "boolean") throw problem("cut is true (an instant step) or false (an eased move).");
    if (operation.dur !== undefined && (operation.cut || typeof operation.dur !== "number" || !(operation.dur >= 0.1 && operation.dur <= 20)))
      throw problem(operation.cut ? "A cut has no dur: leave dur out, or set cut:false for a move." : "dur is seconds, from 0.1 to 20.");
  },
  set_cue(operation, resolver) {
    if (typeof operation.name !== "string" || !CUE_NAME.test(operation.name)) throw problem("name is 1 to 64 letters, digits, dots, dashes or underscores.");
    if (operation.layerId !== undefined || operation.media !== undefined) {
      if (operation.at !== undefined || operation.time !== undefined) throw problem("Give at (a scene time) or layer + media (a moment of a clip's file), not both.");
      if (operation.layerId === undefined) throw problem("media needs layer: the video or audio layer whose file it counts in.");
      if (typeof operation.media !== "number" || !Number.isFinite(operation.media) || operation.media < 0)
        throw problem("media is seconds into the clip's own file, 0 or more.");
      operation.layerId = layerRef(resolver, operation.layerId);
      return;
    }
    if (operation.at === undefined) { operation.at = operation.time; delete operation.time; }
    if (operation.at === undefined) throw problem("set_cue needs at: seconds, or a time such as \"after:title.in\".");
    parseAt(operation.at);
  },
  remove_cue(operation) {
    if (typeof operation.name !== "string" || !operation.name) throw problem("remove_cue needs name.");
  },
  set_brand(operation) {
    if (typeof operation.name !== "string" || !NAME.test(operation.name)) throw problem("name is 1 to 48 letters, digits, dots, dashes or underscores.");
    if (operation.motion !== undefined && !MOTION_FEELS.includes(operation.motion)) throw problem(`motion is one of ${MOTION_FEELS.join(", ")}.`);
    if (operation.fonts !== undefined && (!Array.isArray(operation.fonts) || operation.fonts.length > 2)) throw problem("fonts is a list of at most 2: [{family, weight}] for headlines, then body.");
    if (operation.logos !== undefined && (!Array.isArray(operation.logos) || operation.logos.length > 4)) throw problem("logos is a list of at most 4: {media} (an uploaded picture) or {text}.");
    if (operation.colors !== undefined && !isRecord(operation.colors)) throw problem("colors is {bg, surface, text, accent, accent2}, each a hex colour.");
  },
  remove_brand(operation) {
    if (typeof operation.name !== "string" || !operation.name) throw problem("remove_brand needs name.");
  },
  make_template(operation, resolver, document) {
    operation.sceneId = operation.sceneId !== undefined ? sceneRef(resolver, operation.sceneId) : onlyScene(document, "make_template");
    for (const key of ["intro", "outro"])
      if (operation[key] !== undefined && (typeof operation[key] !== "number" || operation[key] < 0)) throw problem(`${key} is seconds, 0 or more.`);
    if (operation.fields !== undefined) {
      if (!Array.isArray(operation.fields) || operation.fields.length > 12) throw problem("fields is a list of at most 12 {name, layer, property}.");
      operation.fields = operation.fields.map((field) => {
        if (!isRecord(field) || typeof field.layer !== "string") throw problem("Each field is {name, layer, property}.");
        return { ...field, layer: layerRef(resolver, field.layer) };
      });
    }
  },
  use_template(operation, resolver, document) {
    const source = operation.template ?? operation.sceneId;
    if (source === undefined) throw problem("use_template needs template, the template scene.");
    operation.template = sceneRef(resolver, source);
    delete operation.sceneId;
    const base = idBase(document.scenes.find((scene) => scene.id === operation.template));
    if (operation.id !== undefined && (typeof operation.id !== "string" || !NEW_ID.test(operation.id) || resolver.exists("scene", operation.id)))
      throw problem("id must be a new scene ID: 1 to 48 letters, digits, dashes or underscores.");
    operation.newSceneId = operation.id;
    for (let number = 2; !operation.newSceneId && number < 500; number += 1)
      if (!resolver.exists("scene", `${base}-t${number}`)) operation.newSceneId = `${base}-t${number}`;
    delete operation.id;
    if (operation.values !== undefined && !isRecord(operation.values)) throw problem("values is {field: value}.");
    checkDuration(operation);
  },
  retime(operation, resolver, document) {
    operation.sceneId = operation.sceneId !== undefined ? sceneRef(resolver, operation.sceneId) : onlyScene(document, "retime");
    if (operation.duration === undefined) throw problem("retime needs duration, the new length in seconds.");
    checkDuration(operation);
  },
  shift(operation, resolver, document) {
    operation.sceneId = operation.sceneId !== undefined ? sceneRef(resolver, operation.sceneId) : onlyScene(document, "shift");
    if (operation.at === undefined) throw problem("shift needs at: the time from which everything moves (seconds or \"cue:<name>\").");
    parseAt(operation.at);
    if (typeof operation.by !== "number" || !Number.isFinite(operation.by) || operation.by === 0) throw problem("shift needs by: seconds to insert (positive) or take out before at (negative).");
  },
  // t and box are checked when the op runs: t against the layer's scene.
  split_image(operation, resolver) {
    if (operation.layerId === undefined) throw problem("split_image needs layer, a picture layer's name or code.");
    operation.layerId = layerRef(resolver, operation.layerId);
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
    if (!Array.isArray(operation.boxes) || !operation.boxes.length) throw problem('split_image needs boxes: [{name, rect:[x, y, w, h]}] in % of the picture, such as [{name:"row1", rect:[5, 20, 90, 8]}].');
  },
  mark_subject(operation, resolver) {
    if (operation.layerId === undefined) throw problem("mark_subject needs layer, a video layer's name or code.");
    operation.layerId = layerRef(resolver, operation.layerId);
    // No t: the file second of the last look at this layer's source (a director sent it without t
    // after a look, .scratch/ceiling/c/result.md friction 3); the apply step checks it is this file.
    const look = resolver.sourceLooks?.[operation.layerId];
    if (operation.t === undefined && Array.isArray(look?.at) && look.at.length && Number.isFinite(look.at.at(-1))) operation.lookedAt = { src: look.src, at: look.at.at(-1) };
  },
  // layer and layers both work; they become one list (each layer once).
  frame_shot(operation, resolver) {
    if (operation.layerIds !== undefined && !Array.isArray(operation.layerIds)) throw problem("layers is a list of video layer names or codes.");
    const list = [...(operation.layerId !== undefined ? [operation.layerId] : []), ...(operation.layerIds ?? [])];
    if (!list.length || list.length > 50) throw problem("frame_shot needs layer, a video layer's name or code (or layers, a list of up to 50).");
    operation.layerIds = [...new Set(list.map((ref) => layerRef(resolver, ref)))];
    delete operation.layerId;
    if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
  },
  // The board's names (music, media) are looked up when it runs: they may be layers this edit makes.
  board() {},
  source() {},
};

/**
 * The font the project's own text layers use most (not ones a move or a recipe made), as
 * faces for styleFor: display at the heaviest weight the project uses it in, body at its most
 * used weight. Null when the project has no text of its own.
 */
export function projectFaces(document) {
  const counts = new Map();
  for (const scene of document.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      if (layer.type !== "text" || layer.move || layer.recipe || !layer.fontFamily) continue;
      const key = `${layer.fontFamily}\u0000${layer.fontSource ?? ""}`;
      const entry = counts.get(key) ?? { fontFamily: layer.fontFamily, fontSource: layer.fontSource ?? "", count: 0, weights: new Map() };
      entry.count += 1;
      const weight = layer.fontWeight ?? 400;
      entry.weights.set(weight, (entry.weights.get(weight) ?? 0) + 1);
      counts.set(key, entry);
    }
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!best) return null;
  const weights = [...best.weights.entries()];
  const face = (fontWeight) => ({ fontFamily: best.fontFamily, fontSource: best.fontSource, fontWeight, fontStyle: "normal" });
  return { display: face(Math.max(...weights.map(([weight]) => weight))), body: face(weights.sort((a, b) => b[1] - a[1])[0][0]) };
}

// Saved moves this op would repeat: the same move on the same layers (every layer field the op
// gives). `sameTime` keeps those at the same time too. Empty when there is none.
function sameLayerMoves(document, definition, operation, { sameTime = true } = {}) {
  if (operation.remove !== undefined) return [];
  const layerFields = Object.entries(definition.fields).filter(([, field]) => ["layer", "layers", "target", "stops"].includes(field.kind)).map(([key]) => moveFieldKey(key));
  // A move that names no layer (a text move such as roll) has no identity beyond its time: two at
  // the same time are two moves, never a repeat.
  if (!layerFields.some((field) => operation[field] !== undefined && operation[field] !== null)) return [];
  const key = (value) => JSON.stringify(value ?? null);
  const found = [];
  for (const scene of document.scenes) for (const entry of scene.moves ?? []) {
    if ((MOVES[entry.name]?.name ?? entry.name) !== definition.name) continue;
    if (sameTime && key(entry.settings?.at) !== key(operation.at)) continue;
    const same = layerFields.every((field) => {
      const settingsKey = Object.keys(definition.fields).find((name) => moveFieldKey(name) === field);
      return key(operation[field]) === key(entry.settings?.[settingsKey]);
    });
    if (same) found.push(entry);
  }
  return found;
}
const sameMoveId = (document, definition, operation) => sameLayerMoves(document, definition, operation)[0]?.id;

/** The move's own fields in an op ({layer, layers, from, to, text, …}), under the move's names. */
function moveInputOf(definition, operation) {
  const input = {};
  for (const key of Object.keys(definition.fields)) {
    const value = operation[moveFieldKey(key)];
    if (value !== undefined) input[key] = value;
  }
  return input;
}

function layoutLayers(operation, resolver) {
  const list = layerList(operation);
  if (!Array.isArray(list) || !list.length || list.length > 50) throw problem(`${operation.type} needs layers: a list of 1 to 50 layer names or codes.`);
  operation.layerIds = list.map((ref) => layerRef(resolver, ref));
  delete operation.layerId;
  if (operation.sceneId !== undefined) operation.sceneId = sceneRef(resolver, operation.sceneId);
}
function checkGap(operation) {
  if (operation.gap !== undefined && (typeof operation.gap !== "number" || !Number.isFinite(operation.gap) || operation.gap < 0 || operation.gap > 4096)) throw problem("gap is pixels, 0 or more.");
}
function checkDuration(operation) {
  if (operation.duration !== undefined && (typeof operation.duration !== "number" || !Number.isFinite(operation.duration) || operation.duration < 1 || operation.duration > 600))
    throw problem("duration is seconds from 1 to 600.");
}

/**
 * Checks a building-block op and turns its names and codes into IDs (a layer this edit makes
 * is looked up when the op runs). Like translate.mjs, it declares what the op makes, even when
 * the op has a problem, so the ops after it can use those names.
 */
export function translateBlock(raw, resolver, document) {
  const operation = { ...raw };
  if (operation.op !== undefined) {
    // {op:"compose", type:"promo"}: here `type` is the video type.
    if (operation.type !== undefined && operation.type !== operation.op) {
      if (operation.op !== "compose" || operation.videoType !== undefined) throw problem("Give op or type, not both.");
      operation.videoType = operation.type;
    }
    operation.type = operation.op;
    delete operation.op;
  }
  const type = operation.type;
  // scene and layers are the documented names, so renaming them is not reported in `fixed`.
  for (const [short, field] of FIELD_ALIASES) {
    if (operation[short] === undefined || operation[field] !== undefined) continue;
    operation[field] = operation[short];
    delete operation[short];
  }
  if (type === "recipe" && operation.recipe !== undefined && operation.name === undefined) {
    operation.name = operation.recipe;
    delete operation.recipe;
    resolver.fixes.push("recipe → name");
  }
  let failure = null;
  try {
    const allowed = new Set(["type", ...OPERATIONS[type].fields]);
    // The recipe's name first: its copy fields depend on it.
    if (type === "recipe" && typeof operation.name === "string" && !TRANSITION_NAMES.includes(operation.name)) {
      try { for (const field of recipeOf(operation.name).copy ?? []) allowed.add(field.key); }
      catch (error) { throw problem(error.message, closest(operation.name, [...RECIPE_NAMES, ...TRANSITION_NAMES])); }
    }
    for (const key of Object.keys(operation))
      if (!allowed.has(key)) throw problem(`${type}${type === "recipe" && operation.name ? ` ${operation.name}` : ""} has no field "${key}".`, closest(key, [...allowed].filter((field) => field !== "type")));
    TRANSLATE[type](operation, resolver, document);
    return operation;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    declare(operation, resolver);
    if (failure) failure.createdIds = blockCreatedIds(operation);
  }
}

function declare(operation, resolver) {
  const type = operation.type;
  if (type === "recipe" && typeof operation.id === "string") {
    if (TRANSITION_NAMES.includes(operation.name)) {
      if (operation.name === "mask-wipe") resolver.declare("layer", `${operation.id}-bar`, { sceneId: operation.sceneId ?? null });
    } else if (!resolver.exists("layer", operation.id)) {
      resolver.declare("layer", operation.id, { sceneId: operation.sceneId ?? null });
      resolver.declare("animation", `${operation.id}.in`, { sceneId: operation.sceneId ?? null, layerId: operation.id });
    }
  }
  if (type === "compose") {
    const sceneId = operation.newSceneId ?? operation.sceneId ?? null;
    if (operation.newSceneId) resolver.declare("scene", operation.newSceneId, { name: operation.name });
    for (const id of operation.beatIds ?? []) {
      if (resolver.exists("layer", id)) continue;
      resolver.declare("layer", id, { sceneId });
      resolver.declare("animation", `${id}.in`, { sceneId, layerId: id });
    }
  }
  // A move's layers (<id>-caret, <id>-w1) can be named by the ops after it in the same edit.
  if (type === "move" && typeof operation.id === "string" && operation.remove === undefined) resolver.declarePrefix?.(`${operation.id}-`, { sceneId: operation.sceneId ?? null });
  if (type === "variants") for (const id of operation.newSceneIds ?? []) resolver.declare("scene", id);
  // split_image's pieces (<layer>-<name>) can be named by the ops after it in the same edit.
  if (type === "split_image" && typeof operation.layerId === "string" && Array.isArray(operation.boxes))
    for (const box of operation.boxes) if (typeof box?.name === "string" && box.name.trim()) resolver.declare("layer", `${operation.layerId}-${box.name.trim().toLowerCase()}`, { sceneId: operation.sceneId ?? null });
  if (type === "use_template" && operation.newSceneId) resolver.declare("scene", operation.newSceneId, { name: operation.name });
}

/** The IDs a building-block op makes (so the ops that use them are skipped when it fails). */
export function blockCreatedIds(operation) {
  const type = operation?.type;
  const ids = [];
  if (type === "recipe") ids.push(TRANSITION_NAMES.includes(operation.name) ? `${operation.id}-bar` : operation.id);
  if (type === "compose") ids.push(operation.newSceneId, ...(operation.beatIds ?? []));
  if (type === "variants") ids.push(...(operation.newSceneIds ?? []));
  if (type === "use_template") ids.push(operation.newSceneId);
  if (type === "split_image" && Array.isArray(operation.boxes)) ids.push(...operation.boxes.map((box) => typeof box?.name === "string" ? `${operation.layerId}-${box.name.trim().toLowerCase()}` : null));
  return ids.filter((id) => typeof id === "string" && id);
}

/** The IDs a (translated) building-block op uses. */
export function blockReferencedIds(operation) {
  if (!isBlockOperation(operation?.type)) return [];
  const ids = [operation.sceneId, operation.template, operation.out, operation.in, operation.below, operation.above, operation.left_of, operation.right_of];
  if (["mark_subject", "frame", "split_image", "set_cue"].includes(operation.type)) ids.push(operation.layerId);
  if (operation.type === "move" && MOVES[operation.name]) {
    for (const [key, field] of Object.entries(MOVES[operation.name].fields)) {
      const value = operation[moveFieldKey(key)];
      if (field.kind === "layer") ids.push(value);
      if (field.kind === "target") ids.push(value?.layer);
      if (field.kind === "layers" && Array.isArray(value)) ids.push(...value);
      if (field.kind === "stops") for (const entry of [value].flat()) ids.push(typeof entry === "string" ? entry : entry?.layer);
    }
  }
  if (operation.type !== "recipe" || !operation.id) ids.push(...(Array.isArray(operation.layerIds) ? operation.layerIds : []));
  return ids.filter((id) => typeof id === "string" && id);
}

// ---- running the ops --------------------------------------------------------------------------
// The roles of layers the agent made itself (compose counts their logo or hero).
const rolesOf = (layers) => new Set(layers.map((layer) => layer.role).filter(Boolean));
function idsInLayers(layers) {
  const ids = [];
  for (const layer of layers) {
    ids.push(layer.id);
    for (const { animation } of animationTreeEntries(layer.animations ?? [])) if (animation?.id) ids.push(animation.id);
  }
  return ids;
}
function idsInDocument(document, skipScene = null) {
  const ids = new Set();
  for (const scene of document.scenes) {
    ids.add(scene.id);
    if (scene.id !== skipScene) for (const id of idsInLayers(scene.layers)) ids.add(id);
  }
  return ids;
}
function sceneOf(document, id) {
  const scene = document.scenes.find((item) => item.id === id);
  if (!scene) throw problem(`No scene "${id}".`, closest(String(id), document.scenes.map((item) => item.id)));
  return scene;
}

/** Uploaded pictures and videos (a screen recording plays where a picture would show) by ID, address or name; this project's own uploads come first. */
function mediaFinder(list, projectId) {
  const images = list.filter((item) => /^(image|video)\//.test(String(item.mime ?? "")))
    .sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId));
  const bare = (name) => String(name ?? "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
  return (ref) => {
    const text = String(ref);
    const found = images.find((item) => item.id === text || item.src === text || `/api/media/${item.id}` === text)
      ?? images.find((item) => String(item.name ?? "").toLowerCase() === text.toLowerCase())
      ?? images.find((item) => bare(item.name) === bare(text));
    if (!found) throw problem(`No uploaded picture or video "${text}".${images.length ? "" : ' Import one first: project {action:"import", file}.'}`, closest(text, images.map((item) => item.name)));
    if (!(found.width > 0 && found.height > 0)) throw problem(`The picture "${text}" has no known size; import it again.`);
    const video = String(found.mime).startsWith("video/") ? { kind: "video", duration: Number(found.duration) || 0 } : {};
    // footage.marks: logos the footage finder's scan found burned into the file (frame_shot keeps them out).
    return { id: found.id, src: found.src ?? `/api/media/${found.id}`, width: found.width, height: found.height, name: found.name, ...video, ...(Array.isArray(found.busy) ? { busy: found.busy, edges: found.edges, flat: found.flat } : {}),
      ...(Array.isArray(found.footage?.marks) && found.footage.marks.length ? { footage: { marks: found.footage.marks } } : {}) };
  };
}

// The text a brand's fonts must draw: plain ASCII and every copy text the op gives.
function copyText(value, depth = 0) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || depth > 6) return "";
  return Object.values(value).map((entry) => copyText(entry, depth + 1)).join("");
}

/** The building-block runner the agent service calls for each block op. */
// deckDeals(document, count): the project's next `count` decks (engine/deck.js), from the service,
// which knows the brief and the other projects; variants {vary:"deck"} uses them.
// footageFacts(document, input), footageDeck(document, {seed, material}) and runOps(document, ops):
// what compose {footage} needs from the service (backend/agent/footage.mjs, the deck, an edit's
// translate-and-apply).
// pictureAlpha(src): a picture's alpha grid (backend/agent/picture-alpha.mjs) for moves that push into it.
// clipEvents(src): a clip's measured events in file seconds (footage/events.mjs), or null.
// styleType(document): the picked type {fonts (the style spec's {caption:{family}, display:{family}, …}
// or null), type (style.type or the picked treatment's type direction, or null)}, or null.
// subjectSamples(layer): the faces (and where the eye goes) saved for a video layer's file, as
// samples [{t, faces, subjects?}], the same ones check reads; [] when none were saved. frame_shot uses them.
export function createBlockRunner({ fontsFor, listMedia, fontCatalog, operationContext, deckDeals = null, footageFacts = null, footageDeck = null, runOps = null, pictureAlpha = null, clipEvents = null, styleType = null, savedRefs = null, subjectSamples = null, shotColor = null }) {
  async function fontsOf(document, work) { return work.fonts ??= await fontsFor(document); }
  const layout = createLayoutOps({ fontsOf, problem, sceneOf, faceTarget });
  async function mediaOf(document, work) {
    work.mediaList ??= await listMedia();
    return mediaFinder(work.mediaList, document.id);
  }

  // The brand kit for an op: the one named, or the only one (null when there are none).
  function brandOf(document, name) {
    const brands = document.brands ?? [];
    if (name === undefined || name === null) return brands.length === 1 ? brands[0] : null;
    const found = brands.find((brand) => brand.name === name) ?? brands.find((brand) => brand.name.toLowerCase() === String(name).toLowerCase());
    if (!found) throw problem(`No brand kit "${name}".${brands.length ? "" : " set_brand makes one."}`, closest(String(name), brands.map((brand) => brand.name)));
    return found;
  }

  // The type the project picked, read on every build so a block made again keeps it: the brand
  // kit's fonts, else the style spec's as [display, body], else none. {fonts, note (for the receipt)}.
  async function typeFor(document, brand) {
    if (brand?.fonts?.length) return { fonts: brand.fonts, note: `type from the brand kit ${brand.name}` };
    const spec = await styleType?.(document);
    const style = spec?.fonts;
    const face = style?.display?.family ? style.display : style?.caption?.family ? style.caption : null;
    if (face) {
      const body = style.caption?.family ? style.caption : face;
      return { fonts: [{ family: face.family }, { family: body.family }], note: `type from the style spec: ${face.family}${body.family === face.family ? "" : ` and ${body.family}`}` };
    }
    if (spec?.type) return { fonts: null, note: `the picked type is '${spec.type}': set style.fonts or set_font to a face for it` };
    return { fonts: null, note: null };
  }

  // The look for an op that was given none: the project's seed picks it. {look, note (which look and why)}.
  function lookPick(document, type) {
    const look = seededLook(projectSeed(document.id));
    return { look, note: `look ${look} (seeded${type.note ? `; ${type.note}` : ": no type picked yet; pick from your references"})` };
  }

  // The receipt says which look was picked and why, once for each answer.
  function noteLook(work, who, pick) {
    work.lookNotes ??= new Set();
    if (work.lookNotes.has(pick.note)) return;
    work.lookNotes.add(pick.note);
    work.notes.push(`${who}: ${pick.note}`);
  }

  // The fonts as faces ready to draw (the brand kit's, else `fontList`), downloading them first when needed.
  async function facesOf(document, brand, lookName, text, work, fontList = brand?.fonts) {
    if (!fontList?.length) return null;
    const fonts = await fontsOf(document, work);
    const look = lookOf(lookName);
    const face = async (font, slot, weight) => {
      const layer = { id: `brand-${slot}`, type: "text", text: `${PRINTABLE}${text}`, fontFamily: font.family, fontWeight: weight, fontStyle: "normal", fontSource: "", animations: [], textStyleRanges: [] };
      const [patch] = await prepareFontPatches([layer], { family: font.family, weight }, { fonts, catalog: fontCatalog });
      return { fontFamily: patch.fontFamily, fontSource: patch.fontSource, fontWeight: patch.fontWeight, fontStyle: patch.fontStyle };
    };
    try {
      return {
        display: await face(fontList[0], "display", fontList[0].weight ?? look.fonts.display.weight),
        body: await face(fontList[1] ?? fontList[0], "body", fontList[1]?.weight ?? look.fonts.body.weight),
      };
    } catch (error) { throw problem(`${brand?.fonts === fontList ? `Brand ${brand.name}'s` : "The style spec's"} font: ${error.message}`); }
  }

  // A font family a move's font field asks for, ready to draw, or null when kino has none by that name.
  async function askedFace(document, family, text, work, weight = 700) {
    const fonts = await fontsOf(document, work);
    const layer = { id: "move-font", type: "text", text: `${PRINTABLE}${text}`, fontFamily: family, fontWeight: weight, fontStyle: "normal", fontSource: "", animations: [], textStyleRanges: [] };
    try {
      const [patch] = await prepareFontPatches([layer], { family, weight }, { fonts, catalog: fontCatalog });
      return { fontFamily: patch.fontFamily, fontSource: patch.fontSource, fontWeight: patch.fontWeight, fontStyle: patch.fontStyle };
    } catch { return null; }
  }

  // The alpha grids of the pictures a move names, and of the pictures inside a group it names.
  async function alphasOf(scene, input) {
    const named = new Set(Object.values(input).filter((value) => typeof value === "string"));
    const grids = new Map();
    if (!pictureAlpha || !named.size) return grids;
    for (const layer of scene.layers) {
      if (layer.type !== "image" || grids.has(layer.src)) continue;
      let hit = false;
      for (let at = layer; at && !hit; at = scene.layers.find((entry) => entry.id === at.parentId)) hit = named.has(at.id);
      if (hit) grids.set(layer.src, await pictureAlpha(layer.src).catch(() => null));
    }
    return grids;
  }
  function logoOf(brand, media) {
    const logo = brand?.logos?.[0];
    if (!logo) return null;
    if (logo.text) return { text: logo.text };
    try { return { media: media(logo.media ?? logo.src) }; }
    catch (error) { throw problem(`Brand ${brand.name}'s logo: ${error.message}`); }
  }

  // Answers the names in an `at` value, inside one scene.
  function timeLookup(document, scene, fonts, work, skip = new Set()) {
    const find = (ref) => {
      for (const layer of scene.layers) {
        if (layer.id === ref) return { layer };
        for (const { animation, offset } of animationTreeEntries(layer.animations ?? []))
          if (animation?.id === ref) return { layer, animation, offset: offset ?? 0 };
      }
      return null;
    };
    return {
      span(ref) {
        let found = skip.has(ref) ? null : find(ref);
        if (!found && work.resolver) {
          for (const kind of ["animation", "layer"]) {
            try { found = find(work.resolver.resolve(ref, kind)); } catch { /* try the other kind */ }
            if (found) break;
          }
        }
        if (!found) {
          const names = idsInLayers(scene.layers.filter((layer) => !skip.has(layer.id)));
          throw problem(`No layer or animation "${ref}" in scene ${scene.id}.`, closest(ref, names));
        }
        // animationTreeEntries already gives a grouped animation its scene time.
        if (found.animation) return animationWindow(found.layer, found.animation, fonts);
        const window = entranceWindow(found.layer, fonts);
        if (!window) throw problem(`${ref} has no animations to time from; use a number or another layer.`);
        return window;
      },
      cue(name) {
        const cue = (document.cues ?? []).find((entry) => entry.name === name);
        if (!cue) throw problem(`No cue "${name}".${document.cues?.length ? "" : " set_cue {name, at} makes one."}`, closest(name, (document.cues ?? []).map((entry) => entry.name)));
        // A footage cue follows its clip as earlier ops in this edit left it.
        if (cue.layer !== undefined) {
          try { return Math.min(MAX_TIME, Math.max(0, round(footageCueTime(document, cue.layer, cue.media).time))); } catch { return cue.time; }
        }
        return cue.time;
      },
      auto() { return lastEntranceEnd(scene, fonts, { skip }); },
    };
  }

  // ---- relative times in add_animation and update_animation ---------------------------------
  async function applyTiming(document, raw, work) {
    const operation = structuredClone(raw);
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === operation.layerId))
      ?? (operation.sceneId ? sceneOf(document, operation.sceneId) : null);
    if (!scene) throw problem(`No layer "${operation.layerId}".`);
    const fonts = await fontsOf(document, work);
    const lookup = timeLookup(document, scene, fonts, work);
    if (operation.type === "add_animation") {
      const value = operation.at ?? (operation.animation ? operation.animation.start : operation.start);
      const time = resolveAt(value, lookup);
      delete operation.at;
      if (operation.animation) operation.animation = { ...operation.animation, start: time };
      else operation.start = time;
    } else {
      operation.properties = { ...operation.properties, start: resolveAt(operation.properties.start, lookup) };
    }
    const context = await operationContext(document, [operation]);
    return parseDocument(applyOperations(document, [operation], context));
  }

  // ---- recipe -------------------------------------------------------------------------------
  async function applyRecipe(document, operation, work) {
    if (TRANSITION_NAMES.includes(operation.name)) return applyTransitionOp(document, operation, work);
    const scene = sceneOf(document, operation.sceneId);
    const previous = scene.layers.filter((layer) => layer.recipe?.instance === operation.id);
    const main = previous.find((layer) => !layer.recipe.part && layer.id === operation.id);
    if (!main && document.scenes.some((item) => item.layers.some((layer) => layer.id === operation.id)))
      throw problem(`${operation.id} is a layer no recipe made here; give the recipe a new id.`);
    if (main && main.recipe.name !== operation.name)
      throw problem(`${operation.id} was made by recipe ${main.recipe.name}; use name "${main.recipe.name}" to change it, or give a new id.`);
    // A beat of a composition is changed in the composition, which is composed again.
    const beatIndex = scene.composition?.beats?.findIndex((beat) => beat.id === operation.id) ?? -1;
    if (beatIndex >= 0) {
      const extra = ["at", "look", "brand", "feel", "role", "reduced"].filter((key) => operation[key] !== undefined);
      if (extra.length) throw problem(`${operation.id} is beat ${beatIndex + 1} of the composition; ${extra.join(", ")} belong to compose {scene:"${scene.id}"}.`);
      const beat = { ...scene.composition.beats[beatIndex], ...rawCopyFields(recipeOf(operation.name), operation, scene.composition.beats[beatIndex]) };
      for (const key of SETTING_KEYS) if (operation[key] !== undefined) beat[key] = operation[key];
      if (operation.dur !== undefined) beat.dur = operation.dur;
      for (const key of Object.keys(beat)) if (beat[key] === null) delete beat[key];
      const beats = scene.composition.beats.map((entry, index) => (index === beatIndex ? beat : entry));
      return applyCompose(document, { type: "compose", sceneId: scene.id, beats }, work);
    }

    const definition = recipeOf(operation.name);
    const stored = main?.recipe.settings ?? {};
    const raw = { copy: rawCopyFields(definition, operation, stored.copy ?? {}).copy };
    for (const key of SETTING_KEYS) {
      const value = operation[key] !== undefined ? operation[key] : stored[key];
      if (value !== undefined && value !== null) raw[key] = value;
    }
    // A new recipe without a seed takes the project's seed, so two projects get different layouts
    // (a recipe made before this keeps its old default, 1, and its layout).
    if (raw.seed === undefined && !main) raw.seed = projectSeed(document.id);
    const settings = settingsFrom(definition, raw);
    const extras = {};
    for (const key of EXTRA_KEYS) {
      const value = operation[key] !== undefined ? operation[key] : stored[key];
      if (value !== undefined && value !== null) extras[key] = value;
    }
    const composition = scene.composition ?? {};
    const brand = brandOf(document, extras.brand ?? composition.brand);
    // No look anywhere: a recipe made before looks were seeded stays crisp; a new one takes the
    // brand's or the style spec's type, else the project's seed picks (and the recipe saves it).
    // The picked type is read on every build (a saved look does not stop it); a legacy recipe keeps
    // only its brand's fonts.
    let look = extras.look ?? composition.look;
    const legacy = !look && main;
    const type = await typeFor(document, brand);
    if (legacy) look = LEGACY_LOOK;
    else if (!look) {
      const pick = lookPick(document, type);
      look = extras.look = pick.look;
      noteLook(work, `recipe ${operation.id}`, pick);
    }
    const feel = extras.feel ?? composition.feel ?? null;
    const reduced = extras.reduced ?? composition.reduced ?? false;
    const media = await mediaOf(document, work);
    const fonts = await fontsOf(document, work);
    const faces = await facesOf(document, brand, look, copyText(settings.copy), work, legacy ? brand?.fonts : type.fonts);
    const frame = { width: scene.width, height: scene.height };
    const style = styleFor({ look, brand, frame, faces, feel });

    const others = { ...scene, layers: scene.layers.filter((layer) => layer.recipe?.instance !== operation.id) };
    const skip = new Set(previous.map((layer) => layer.id));
    const start = resolveAt(extras.at ?? "auto", timeLookup(document, others, fonts, work, skip));
    const end = extras.dur !== undefined ? round(start + extras.dur) : null;
    if (end !== null && end > scene.duration + 1e-6)
      throw problem(`${operation.id} would end at ${end} s, after the scene ends (${scene.duration} s). Start it earlier, shorten dur, or lengthen the scene (retime {scene, duration}).`);
    const made = runRecipe(definition, { id: operation.id, settings, style, frame, fonts, start, end, holdUntil: scene.duration, media, logo: logoOf(brand, media), reduced, ...(extras.role ? { role: extras.role } : {}) });
    if (end === null && start + made.staying > scene.duration + 1e-6)
      throw problem(`${operation.id} needs ${made.staying} s from ${start} s to enter and be read, past the scene's end (${scene.duration} s). Start it earlier or lengthen the scene (retime {scene, duration}).`);

    const taken = idsInDocument(document);
    for (const id of idsInLayers(previous)) taken.delete(id);
    const clash = idsInLayers(made.layers).find((id) => taken.has(id));
    if (clash) throw problem(`The ID ${clash} is already used; give the recipe another id.`);
    const top = made.layers.find((layer) => layer.id === operation.id);
    top.recipe = { ...top.recipe, settings: { ...top.recipe.settings, ...extras } };

    const at = scene.layers.findIndex((layer) => layer.recipe?.instance === operation.id);
    const kept = scene.layers.filter((layer) => layer.recipe?.instance !== operation.id);
    scene.layers = at >= 0 ? [...kept.slice(0, at), ...made.layers, ...kept.slice(at)] : [...kept, ...made.layers];
    setAssertions(scene, [...(scene.assertions ?? []).filter((assertion) => !skip.has(assertion.target)), ...made.assertions]);
    work.notes.push(`recipe ${operation.id}${main ? " (made again)" : ""}: ${made.layers.length} layers, ${start}–${end ?? scene.duration} s${made.notes.length ? `; ${made.notes.join("; ")}` : ""}`);
  }

  async function applyTransitionOp(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    const group = (ref, side) => {
      const id = scene.layers.some((layer) => layer.id === ref) ? ref : (() => { try { return work.resolver?.resolve(ref, "layer"); } catch { return null; } })();
      const layers = scene.layers.filter((layer) => layer.recipe?.instance === id && layer.recipe.name !== "mask-wipe");
      if (!layers.length) throw problem(`${side} must name a recipe in scene ${scene.id}.`, closest(String(ref), scene.layers.filter((layer) => layer.recipe && !layer.recipe.part).map((layer) => layer.id)));
      return layers;
    };
    const outgoing = group(operation.out, "out");
    const incoming = group(operation.in, "in");
    const fonts = await fontsOf(document, work);
    const settings = incoming.find((layer) => !layer.recipe.part)?.recipe.settings ?? {};
    const composition = scene.composition ?? {};
    // The look the incoming recipe saved (a new recipe always saves one; none is an older document).
    const look = settings.look ?? composition.look ?? LEGACY_LOOK;
    const brand = brandOf(document, settings.brand ?? composition.brand);
    const reduced = operation.reduced ?? settings.reduced ?? composition.reduced ?? false;
    const faces = await facesOf(document, brand, look, "", work);
    const style = styleFor({ look, brand, frame: { width: scene.width, height: scene.height }, faces, feel: settings.feel ?? composition.feel ?? null });
    const firstIn = Math.min(...incoming.map((layer) => entranceWindow(layer, fonts)?.[0] ?? Infinity));
    const outReady = Math.max(...outgoing.map((layer) => entranceWindow(layer, fonts)?.[1] ?? 0));
    const lookup = timeLookup(document, scene, fonts, work);
    const at = operation.at !== undefined ? resolveAt(operation.at, lookup) : round(Math.max(0, (Number.isFinite(firstIn) ? firstIn : outReady) - 0.2));
    if (at < outReady - 1e-6) throw problem(`${operation.name} at ${at} s would start before ${operation.out} has finished entering (${round(outReady)} s). Give at ${round(outReady + 0.5)} or later.`);
    const barId = `${operation.id}-bar`;
    scene.layers = scene.layers.filter((layer) => layer.id !== barId);
    const bars = applyTransition(operation.name, { style, frame: { width: scene.width, height: scene.height }, reduced }, { outgoing, incoming, at, id: operation.id });
    const clash = idsInLayers(bars).find((id) => idsInDocument(document).has(id));
    if (clash) throw problem(`The ID ${clash} is already used; give the transition another id.`);
    scene.layers.push(...bars);
    work.notes.push(`${operation.name}: ${operation.out} → ${operation.in} at ${at} s`);
  }

  // ---- move ---------------------------------------------------------------------------------
  // What a move that needs a cue (impact-accent) reads: its at as given, the cues, and the scene's
  // clips' measured impacts and light in scene seconds (each with its clip and file seconds).
  async function cueFactsOf(document, scene, at) {
    const events = [];
    const clips = scene.layers.filter((layer) => layer.type === "video" && layer.src).slice(0, 12);
    for (const layer of clips) {
      let measured = null;
      try { measured = clipEvents ? await clipEvents(layer.src) : null; } catch { measured = null; }
      for (const event of measured ?? []) {
        if (event.kind !== "impact" && event.kind !== "light") continue;
        try {
          const placed = footageCueTime(document, layer.id, event.t);
          if (!placed.shown || placed.layer.id !== layer.id) continue;
          const from = event.from !== undefined ? footageCueTime(document, layer.id, event.from).time : undefined;
          events.push({ ...event, at: round(placed.time), media: event.t, layer: layer.id, ...(from !== undefined ? { from: round(from) } : {}) });
        } catch { /* a clip with an animated speed has no steady time: its events are left out */ }
      }
    }
    return { at, cues: document.cues ?? [], events };
  }

  // A move builds a set piece from the scene's layers (engine/blocks/move.js). The same id again
  // removes what it made before and makes it again from its saved settings plus the changes.
  async function applyMove(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    const definition = moveOf(operation.name);
    const stored = scene.moves?.find((entry) => entry.id === operation.id) ?? null;
    if (!stored && document.scenes.some((item) => item.moves?.some((entry) => entry.id === operation.id)))
      throw problem(`The move ${operation.id} is in another scene; give scene, or a new id.`);
    if (stored && (MOVES[stored.name]?.name ?? stored.name) !== definition.name)
      throw problem(`${operation.id} was made by move ${stored.name}; use name "${stored.name}" to change it, or give a new id.`);
    // The cues a move wrote (roll: <id>.1, <id>.2, ... <id>.land) go with it and come back with it.
    // Only the names on its record go, so a cue the agent set itself (hook.hit) stays.
    const dropMoveCues = () => {
      if (!document.cues?.length || !stored?.cues?.length) return;
      document.cues = withCues(document.cues, [], { names: stored.cues });
      if (!document.cues.length) delete document.cues;
    };
    if (operation.remove) {
      const before = scene.layers.length;
      removeMove(scene, operation.id);
      dropMoveCues();
      work.notes.push(`removed move ${operation.id}: ${before - scene.layers.length} of its layers and the animations it put on your layers (your layers keep their place in the stack)`);
      return;
    }
    const given = moveInputOf(definition, operation);
    const settings = { ...(stored?.settings ?? {}) };
    for (const key of MOVE_KEYS) if (operation[key] !== undefined) settings[key] = operation[key];
    for (const [key, value] of Object.entries(given)) settings[key] = value;
    for (const key of Object.keys(settings)) if (settings[key] === null) delete settings[key];
    const input = readMoveInput(definition, Object.fromEntries(Object.keys(definition.fields).filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])));
    if (definition.needsAt && settings.at === undefined) throw problem(`${definition.name} needs at: when it starts.`);

    // What the move made before is taken away first, so it times itself against the rest.
    removeMove(scene, operation.id);
    const composition = scene.composition ?? {};
    const brand = brandOf(document, settings.brand ?? composition.brand);
    // No look anywhere: a move made before looks were seeded stays crisp; a new one is seeded and saves it.
    let look = settings.look ?? composition.look;
    const legacy = !look && stored;
    const type = await typeFor(document, brand);
    if (legacy) look = LEGACY_LOOK;
    else if (!look) {
      const pick = lookPick(document, type);
      look = settings.look = pick.look;
      noteLook(work, `move ${operation.id}`, pick);
    }
    const media = await mediaOf(document, work);
    const fonts = await fontsOf(document, work);
    // A move writes in the brand's fonts, else in the font the project's own text uses (captions
    // and titles match the rest of the video), else the style spec's, else in the look's fonts.
    const faces = await facesOf(document, brand, look, copyText(input), work) ?? projectFaces(document) ?? (legacy ? null : await facesOf(document, brand, look, copyText(input), work, type.fonts));
    const frame = { width: scene.width, height: scene.height };
    const style = styleFor({ look, brand, frame, faces, feel: settings.feel ?? composition.feel ?? null });
    const start = resolveAt(settings.at ?? "auto", timeLookup(document, scene, fonts, work));
    const alphas = await alphasOf(scene, input);
    // The faces measured in each named clip's file, so a pane or an inset is cropped on them.
    const subjects = new Map();
    const namedIds = Object.values(input).flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value) => typeof value === "string");
    for (const layer of scene.layers) if (layer.type === "video" && namedIds.includes(layer.id) && subjectSamples) subjects.set(layer.id, (await subjectSamples(layer).catch(() => null)) ?? []);
    // The dominant hue of each named clip or picture at the move's start (backdrop-flash color "auto").
    const hues = new Map();
    if (definition.fields.color?.auto && (settings.color ?? "auto") === "auto" && shotColor)
      for (const layer of scene.layers) if ((layer.type === "video" || layer.type === "image") && namedIds.includes(layer.id) && !layer.cutoutOf) hues.set(layer.id, await shotColor(layer, start).catch(() => null));
    // font (push-through-type, a display face at 700) or fontFamily (caption-words, body text at
    // 600); a fontWeight alone loads that weight of the body font the move would use.
    const weightFamily = typeof input.fontFamily === "string" ? input.fontFamily
      : typeof input.fontWeight === "number" ? style.fonts.body?.fontFamily : undefined;
    const fontFaces = typeof input.font === "string" ? { [input.font]: await askedFace(document, input.font, copyText(input), work) }
      : typeof weightFamily === "string" ? { [weightFamily]: await askedFace(document, weightFamily, copyText(input), work, input.fontWeight ?? 600) } : {};
    const cueFacts = definition.needsCue ? await cueFactsOf(document, scene, settings.at) : null;
    let made;
    try {
      made = runMove(definition, {
        cueFacts,
        id: operation.id, input, scene, style, fonts, start, align: settings.align ?? "start", dur: settings.dur ?? null, media, logo: logoOf(brand, media),
        reduced: settings.reduced ?? composition.reduced ?? false, seed: settings.seed ?? 1, brandFonts: Boolean(faces), bpm: document.rhythm?.bpm ?? null,
        alpha: (src) => alphas.get(src) ?? null, samples: (layerId) => subjects.get(layerId) ?? [], shotColor: (layerId) => hues.get(layerId) ?? null, fontFaces: Object.fromEntries(Object.entries(fontFaces).filter(([, face]) => face)),
        fileSize: (src) => {
          const item = work.mediaList?.find((entry) => entry.src === src || `/api/media/${entry.id}` === src);
          return item?.width > 0 && item?.height > 0 ? { width: item.width, height: item.height } : null;
        },
      });
    } catch (error) { throw problem(error.message, error.suggestions ?? []); }
    const taken = idsInDocument(document);
    const newIds = [...idsInLayers(made.added.map((entry) => entry.layer)), ...made.animations.map((entry) => entry.animation.id)];
    const clash = newIds.find((id) => taken.has(id));
    if (clash) throw problem(`The ID ${clash} is already used; give the move another id.`);
    placeMove(scene, { id: operation.id, name: definition.name, settings }, made);
    dropMoveCues();
    if (made.cues.length) document.cues = withCues(document.cues, made.cues.map((cue) => ({ name: cue.name, time: round(cue.time), kind: "marker" })));
    const touched = [...new Set(made.animations.map((entry) => entry.layerId))];
    const cueNote = made.cues.length ? `; cues ${made.cues[0].name} to ${made.cues.at(-1).name} (a sound on each: at "cue:${made.cues[0].name}")` : "";
    // Only the cut-outs that were made (an optional one is skipped where no engine or subject is found).
    const cutsMade = (operation.cutoutMade ?? []).filter((cut) => scene.layers.some((layer) => layer.id === cut.id)).map((cut) => cut.text);
    const cutNote = cutsMade.length ? `; made the subject ${cutsMade.join(", ")}` : "";
    // Which layers the move made (up to 6 by name), so the receipt need not be read from the outline.
    const madeIds = made.added.map((entry) => entry.layer.id);
    const madeNames = madeIds.length ? ` (${madeIds.slice(0, 6).join(", ")}${madeIds.length > 6 ? `, +${madeIds.length - 6} more` : ""})` : "";
    const again = stored ? (operation.replaces ? " (replaced: the same move on the same layers at the same time)" : " (made again)") : "";
    const earlier = operation.earlier;
    const earlierNote = earlier && !stored ? `; ${earlier.id} on the same layers stays${earlier.settings?.at !== undefined ? ` at ${JSON.stringify(earlier.settings.at)}` : ""} (to move it instead: {op:"move", name:"${definition.name}", id:"${earlier.id}", at:${JSON.stringify(settings.at ?? made.start)}}, then {op:"move", name:"${definition.name}", id:"${operation.id}", remove:true})` : "";
    work.notes.push(`move ${operation.id}${again}: ${made.start}–${made.end} s; ${made.added.length} new layer${made.added.length === 1 ? "" : "s"}${madeNames}${touched.length ? `, animates ${touched.join(", ")}` : ""}${cutNote}; ${made.tags.join(", ")}${made.notes.length ? `; ${made.notes.join("; ")}` : ""}${cueNote}${earlierNote}`);
  }

  // ---- compose ------------------------------------------------------------------------------
  async function applyCompose(document, operation, work) {
    const existing = operation.sceneId ? sceneOf(document, operation.sceneId) : null;
    if (existing && !existing.composition && existing.layers.length)
      throw problem(`Scene ${existing.id} already has layers that compose did not make. Compose into a new scene (leave scene out and give id), or delete its layers first.`);
    const input = compositionInput(operation, existing);
    // A new composition without a seed takes the project's seed (engine/deck.js projectSeed).
    if (input.seed === undefined) input.seed = projectSeed(document.id);
    const reduced = Boolean(input.reduced);
    // No look given (and none saved on the scene): the project's seed picks the look, saved on the
    // scene so making it again keeps it. The picked type (brand kit, else style spec) is read on
    // every build, so composing again keeps it too.
    const type = await typeFor(document, brandOf(document, input.brand));
    const pick = input.look === undefined ? lookPick(document, type) : null;
    if (pick) input.look = pick.look;
    const composition = readCompose(input);
    const brand = brandOf(document, composition.brand);
    const media = await mediaOf(document, work);
    const fonts = await fontsOf(document, work);
    const faces = await facesOf(document, brand, composition.look, copyText(composition.beats), work, brand?.fonts?.length ? brand.fonts : type.fonts);
    const sceneId = existing?.id ?? operation.newSceneId;
    // The project's first, empty scene takes the video type as its name ("Promo").
    if (existing && !existing.composition && operation.name === undefined && composition.type) existing.name = composition.type[0].toUpperCase() + composition.type.slice(1);
    const base = existing ? idBase(existing) : sceneId;
    const old = existing?.composition;
    const replaced = new Set(old ? [...(old.backdrop ?? []), ...old.beats.map((beat) => beat.id), ...old.beats.filter((beat) => beat.transition).map((beat) => `${beat.id}-${beat.transition}-bar`)] : []);
    const kept = (existing?.layers ?? []).filter((layer) => !replaced.has(layer.recipe?.instance ?? layer.id));
    const taken = idsInDocument(document, sceneId);
    for (const id of idsInLayers(kept)) taken.add(id);
    let made;
    try {
      made = composeScene({ ...composition, ...(brand ? { brand: brand.name } : {}) }, { fonts, media, brand, faces, logo: logoOf(brand, media), sceneId: base, taken, reduced, ownRoles: rolesOf(kept) });
    } catch (error) { throw Object.assign(problem(error.message), { beat: error.beat, least: error.least, needed: error.needed }); }
    const backdrop = made.layers.filter((layer) => !layer.recipe).map((layer) => layer.id);
    const saved = { ...made.composition, ...(reduced ? { reduced: true } : {}), backdrop };
    const layers = [...made.layers, ...kept];
    const ids = new Set(idsInLayers(layers));
    const keptAssertions = (existing?.assertions ?? []).filter((assertion) => ids.has(assertion.target) && (assertion.other === undefined || ids.has(assertion.other)) && !made.assertions.some((entry) => sameAssertion(entry, assertion)));
    let scene = existing;
    if (!scene) {
      scene = createScene({ ...nextScenePosition(document.scenes), id: sceneId, name: operation.name ?? (composition.type ? composition.type[0].toUpperCase() + composition.type.slice(1) : "Composition") });
      document.scenes.push(scene);
    } else if (operation.name !== undefined) scene.name = operation.name;
    Object.assign(scene, { width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, backgroundEnabled: true, layers, composition: saved });
    setAssertions(scene, [...keptAssertions, ...made.assertions]);
    if (composition.type) document.videoType = composition.type;
    const beats = made.beats.map((beat) => `${beat.id} ${beat.start}–${beat.end}`).join(", ");
    work.notes.push(`compose ${sceneLabel(scene)}: ${made.frame.width}×${made.frame.height} ${made.duration} s, ${pick ? pick.note : composition.look}${brand ? ` + ${brand.name}` : ""}; beats ${beats}${kept.length ? `; kept your ${kept.length} other layer${kept.length === 1 ? "" : "s"} on top` : ""}`);
    work.notes.push(...made.notes);
    return made;
  }

  // ---- format -------------------------------------------------------------------------------
  // A format's compose, made longer where its copy needs more reading time, then its music
  // under the whole video and a cue at each section (engine/blocks/videoFormats.js).
  async function applyFormat(document, operation, work) {
    const { formatName, formatMusic, formatCues, ...rest } = operation;
    const plan = Object.fromEntries(COMPOSE_KEYS.filter((key) => key !== "type" && rest[key] !== undefined).map((key) => [key, rest[key]]));
    let scene = null;
    const { made, compose } = await buildVideoFormat({ compose: plan }, async (fitted) => {
      const trial = structuredClone(document);
      const result = await applyCompose(trial, { ...rest, ...fitted }, work);
      Object.assign(document, trial);
      scene = sceneOf(document, rest.sceneId ?? rest.newSceneId);
      return result;
    });
    if (formatMusic) {
      work.mediaList ??= await listMedia();
      const text = String(formatMusic);
      const sounds = work.mediaList.filter((item) => /^(audio|video)\//.test(String(item.mime ?? "")));
      const file = sounds.find((item) => item.id === text || item.src === text || String(item.name ?? "").toLowerCase() === text.toLowerCase());
      if (!file) throw problem(`No imported sound "${text}" for the music slot (library {topic:"media"} lists them).`, closest(text, sounds.map((item) => item.name)));
      scene.layers = scene.layers.filter((layer) => layer.id !== `${scene.id}-music`);
      scene.layers.push(createLayer("audio", { id: `${scene.id}-music`, name: "Music", src: file.src ?? `/api/media/${file.id}`, mediaSourceDuration: file.duration ?? 0, mediaDuration: scene.duration, volume: 0.8 }));
    }
    const cues = formatCues.map((cue) => ({ name: cue.name, time: round(made.beats[cue.beat].start), kind: "marker" }));
    document.cues = withCues(document.cues, cues);
    const longer = compose.duration > plan.duration + 1e-6 ? `; ${round(compose.duration - plan.duration)} s longer than planned so the copy can be read` : "";
    work.notes.push(`format ${formatName}: cues ${cues.map((cue) => `${cue.name} ${cue.time}`).join(", ")}${formatMusic ? "; music under it" : ""}${longer}`);
  }

  // ---- compose {footage} --------------------------------------------------------------------
  // A whole edit from footage (engine/footage/): the service measures the material (footageFacts),
  // plan.js plans the edit, ops.js writes it as ordinary ops, and runOps applies them, so every
  // layer is one an agent can change. Composing the scene again replaces what it made before and
  // keeps the agent's own layers. Returns the new document.
  async function applyFootage(document, operation, work) {
    if (!footageFacts || !runOps) throw problem("compose {footage} needs kino's agent service.");
    const existing = operation.sceneId ? sceneOf(document, operation.sceneId) : null;
    if (existing && existing.layers.length && !existing.footage)
      throw problem(`Scene ${existing.id} already has layers; compose {footage} builds into a new scene: leave scene out and give id, or delete its layers first.`);
    const saved = existing?.footage ?? {};
    const input = { footage: operation.footage };
    for (const key of ["music", "voice", "treatment", "pace", "accents", "duration", "format", "seed", "title", "end"]) {
      const value = operation[key] !== undefined ? operation[key] : saved[key];
      if (value !== undefined && value !== null) input[key] = value;
    }
    const facts = await footageFacts(document, input);
    // Subjects marked on these files anywhere in the project frame the crops (plan.js).
    const marks = markedSubjects(document);
    for (const clip of facts.clips) if (marks.has(clip.src)) clip.subjects = marks.get(clip.src);
    const sized = existing && !existing.footage && FORMATS[`${existing.width}x${existing.height}`] ? `${existing.width}x${existing.height}` : "16:9";
    const frame = parseFormat(input.format ?? sized);
    const seed = input.seed ?? projectSeed(document.id);
    const spoken = facts.clips.some((clip) => clip.words?.length) || Boolean(facts.voice?.words?.length);
    const allWords = [...facts.clips.flatMap((clip) => clip.words ?? []), ...(facts.voice?.words ?? [])].map((word) => word.text).join(" ");
    const material = {
      known: true, fromLayers: false, video: facts.clips.some((clip) => clip.kind !== "picture"), pictures: true, pictureCount: facts.clips.length,
      text: spoken, numbers: /\d/.test(allWords), sound: Boolean(facts.music || facts.voice || facts.clips.some((clip) => clip.sound)),
      device: facts.clips.some((clip) => /screen|recording|\brec\b/i.test(clip.name) || (clip.height >= 1.8 * clip.width)),
    };
    const dealt = footageDeck ? await footageDeck(document, { seed: input.seed, material }) : { deck: null, pick: null };
    const deck = dealt?.deck ?? null;
    const speechSeconds = facts.clips.reduce((total, clip) => total + (clip.words ?? []).reduce((sum, word) => sum + (word.end - word.start), 0), 0);
    const footageSeconds = facts.clips.reduce((total, clip) => total + (clip.out - clip.in), 0);
    const treatment = treatmentNamed(input.treatment) ?? treatmentFromPick(dealt?.pick) ?? guessTreatment({ speechShare: facts.voice ? 1 : speechSeconds / Math.max(1, Math.min(60, footageSeconds)), bpm: facts.music?.analysis?.bpm ?? null, deck, seed });
    const brand = brandOf(document, undefined);
    const titleText = input.title ?? brand?.logos?.find((logo) => logo.text)?.text ?? brand?.name ?? projectTitle(document.name);
    let plan;
    try {
      plan = planEdit({ clips: facts.clips, music: facts.music, voice: facts.voice, frame, duration: input.duration, treatment, deck, seed, title: titleText, end: input.end ?? null, pace: input.pace ?? null, accents: input.accents });
    } catch (error) { throw problem(error.message); }

    // The scene: new, or emptied of what compose {footage} made in it before.
    let scene = existing;
    if (!scene) {
      scene = createScene({ ...nextScenePosition(document.scenes), id: operation.newSceneId, name: operation.name ?? "Edit" });
      document.scenes.push(scene);
    } else {
      const moveLayers = scene.layers.filter((layer) => layer.move && (saved.moves ?? []).includes(layer.move.instance)).map((layer) => layer.id);
      for (const id of saved.moves ?? []) removeMove(scene, id);
      const gone = new Set([...(saved.made ?? []), ...moveLayers]);
      // What check {fix:"auto"} added for those layers goes too (a plate "<layer>-plate", a backdrop).
      const made = [...gone];
      for (const layer of scene.layers) if (made.some((id) => layer.id.startsWith(`${id}-`))) gone.add(layer.id);
      for (let grew = true; grew;) {
        grew = false;
        for (const layer of scene.layers) if (layer.parentId && gone.has(layer.parentId) && !gone.has(layer.id)) { gone.add(layer.id); grew = true; }
      }
      scene.layers = scene.layers.filter((layer) => !gone.has(layer.id));
      if (operation.name !== undefined) scene.name = operation.name;
    }
    Object.assign(scene, { width: frame.width, height: frame.height, duration: plan.duration, background: "#0A0A0C", backgroundEnabled: true });
    const kept = new Set(scene.layers.map((layer) => layer.id));
    const keptMoves = new Set((scene.moves ?? []).map((entry) => entry.id));
    scene.footage = { ...input, treatment: plan.treatment, made: [], moves: [] };
    const clips = new Map(facts.clips.map((clip) => [clip.key, clip]));
    let ops = footageOps(plan, clips, { scene: document.scenes.length > 1 ? scene.id : null });
    // Beside another footage scene, its names take a suffix (a format variant's own, or the scene's id).
    const elsewhere = new Set(document.scenes.filter((item) => item !== scene).flatMap((item) => item.layers.map((layer) => layer.id)));
    let suffix = "";
    if (operation.suffix || ops.some((op) => elsewhere.has(op.name) || elsewhere.has(op.id))) {
      suffix = operation.suffix ?? `-${slug(scene.id)}`;
      ops = suffixFootageOps(ops, suffix);
    }
    // Without a brand kit, the edit gets one from its treatment: fonts that are not a default, an
    // accent; titles, captions and the end card use it (set_brand can change it later).
    if (!brand) {
      // With saved references the kit keeps colors and motion but no fonts: the type comes from what they show.
      const fromRefs = Boolean((await savedRefs?.(document))?.length);
      const kit = footageBrand(plan.treatment, seed, { fonts: !fromRefs });
      ops.unshift({ op: "set_brand", name: slug(titleText) || "edit", ...kit, ...(titleText ? { logos: [{ text: titleText }] } : {}) });
      work.notes.push(fromRefs
        ? `brand ${slug(titleText) || "edit"} made for this edit: colors only, accent ${kit.colors.accent}; fonts come from your references: library {topic:"fonts", search:"<the type your reference strip shows, e.g. condensed bold sans>"}`
        : `brand ${slug(titleText) || "edit"} made for this edit: ${kit.fonts.map((font) => font.family).join(" and ")}, accent ${kit.colors.accent}`);
    }
    let next;
    try { next = await runOps(parseDocument(document), ops); }
    catch (error) { throw problem(`compose {footage} could not build its plan: ${error.message}`); }
    const built = next.scenes.find((item) => item.id === scene.id);
    // The song's seams and rests (fitted, as fit_music writes them) and the end card's moment as
    // cues. The end card's cue is where its first entrance really starts (the recipe's own lead).
    const endStarts = (built.layers.find((layer) => layer.id === `end-card${suffix}`)?.animations ?? []).map((animation) => animation.start).filter(Number.isFinite);
    const planned = footageCues(plan, { suffix, endCardStart: endStarts.length ? Math.min(...endStarts) : null });
    if (planned.length) next.cues = withCues(next.cues, planned, plan.song && !suffix ? { kinds: ["marker"], prefix: "song-" } : {});
    built.footage.made = built.layers.filter((layer) => !kept.has(layer.id) && !layer.parentId).map((layer) => layer.id);
    built.footage.moves = (built.moves ?? []).map((entry) => entry.id).filter((id) => !keptMoves.has(id));
    // The new shots carry those marks, so check (crop_no_subject) sees whether each crop keeps its subject.
    for (const layer of built.layers)
      if (layer.type === "video" && !layer.subjectBoxes && marks.has(layer.src)) layer.subjectBoxes = { src: layer.src, boxes: marks.get(layer.src) };
    const label = sceneLabel(built);
    work.notes.push(`compose ${label} from footage: ${frame.width}×${frame.height} ${plan.duration} s, ${plan.treatment}${plan.pace ? `, ${plan.pace} pace` : ""}, ${plan.shots.length} shots, ${plan.captions.length} caption runs${plan.title ? ", title" : ""}${plan.endCard.text ? ", end card" : ""}${plan.music ? ", music ducked under speech" : ""}`);
    work.notes.push(...facts.notes);
    work.plan = plan.words;
    work.footage = { sceneId: built.id };
    return parseDocument(next);
  }

  // variants {vary:"format"} of a compose {footage} scene: the same footage, music and treatment
  // composed again in each format as a new scene beside it; the service then runs check
  // {fix:"auto"} on each (work.finishScenes).
  async function applyFootageFormats(document, operation, work) {
    const source = sceneOf(document, operation.sceneId);
    if (source.variant && source.variant.of !== source.id) throw problem(`${sceneLabel(source)} is a variant of ${source.variant.of}; make variants of ${source.variant.of}.`);
    const set = newVariantSet(document, source, "format");
    const saved = source.footage;
    const prefix = idBase(source);
    // Your own layers (not made by compose {footage} or a move) come along, in proportion to the
    // new frame; moves you added are left out and the note names them.
    const made = new Set(saved.made ?? []);
    const byId = new Map(source.layers.map((layer) => [layer.id, layer]));
    const rootOf = (layer) => { while (layer.parentId && byId.has(layer.parentId)) layer = byId.get(layer.parentId); return layer; };
    const own = source.layers.filter((layer) => { const root = rootOf(layer); return !made.has(root.id) && !root.move; });
    const movesLeft = (source.moves ?? []).map((entry) => entry.id).filter((id) => !(saved.moves ?? []).includes(id));
    // A compose {footage} earlier in this same edit keeps its own finish report (work.footage).
    const { footage: composed, plan: words } = work;
    let next = document;
    const scenes = [];
    for (const [index, format] of operation.formats.entries()) {
      const wanted = operation.newSceneIds?.[index];
      let id = wanted && !next.scenes.some((scene) => scene.id === wanted) ? wanted : null;
      for (let number = 2; !id; number += 1) if (!idsInDocument(next).has(`${prefix}-v${number}`)) id = `${prefix}-v${number}`;
      const label = `Format ${format}`;
      const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : `-${id}`;
      const op = { type: "compose", footage: saved.footage, format, newSceneId: id, name: `${source.name} · ${label}`.slice(0, 120), suffix };
      for (const key of ["music", "voice", "treatment", "pace", "accents", "duration", "seed", "title", "end"]) if (saved[key] !== undefined && saved[key] !== null) op[key] = saved[key];
      next = structuredClone(await applyFootage(next, op, work));
      // Beside the original, in format order.
      const scene = next.scenes.find((item) => item.id === id);
      next.scenes.splice(next.scenes.indexOf(scene), 1);
      next.scenes.splice(next.scenes.findIndex((item) => item.id === source.id) + 1 + index, 0, scene);
      const copies = copyLayers(own, suffix, idsInDocument(next));
      for (const layer of copies.filter((item) => !item.parentId)) {
        layer.x = Math.round((layer.x + layer.width / 2) * scene.width / source.width - layer.width / 2);
        layer.y = Math.round((layer.y + layer.height / 2) * scene.height / source.height - layer.height / 2);
      }
      scene.layers.push(...copies);
      scene.variant = { of: source.id, set, label, vary: "format" };
      (work.finishScenes ??= []).push(id);
      scenes.push(scene);
    }
    next.scenes.find((item) => item.id === source.id).variant = { of: source.id, set, label: "Original", vary: "format" };
    if (composed) Object.assign(work, { footage: composed, plan: words });
    else { delete work.footage; delete work.plan; }
    const ownCount = own.filter((layer) => !layer.parentId).length;
    const ownNote = ownCount ? `; your ${ownCount} own layer${ownCount === 1 ? "" : "s"} came along` : "";
    const movesNote = movesLeft.length ? `; moves left out (add them again on each): ${movesLeft.join(", ")}` : "";
    work.notes.push(`variants ${set}: ${scenes.map((scene) => `${scene.id} (${scene.variant.label})`).join(", ")}${ownNote}${movesNote}. look {mode:"variants", scene:"${scenes[0].id}"} shows them beside the original; pick_variant {scene} marks the one to keep.`);
    return parseDocument(next);
  }

  // ---- variants -----------------------------------------------------------------------------
  async function applyVariants(document, operation, work) {
    const source = sceneOf(document, operation.sceneId);
    if (!source.composition) throw problem(`variants works on a scene made by compose; ${source.id} was not.`);
    if (source.variant && source.variant.of !== source.id) throw problem(`${source.id} is a variant of ${source.variant.of}; make variants of ${source.variant.of}.`);
    const base = compositionInput({}, source);
    const vary = operation.vary;
    const changes = [];
    if (vary === "layout") {
      for (let index = 1; changes.length < operation.count; index += 1) {
        const step = 7 * index;
        changes.push({ label: `Layout ${index + 1}`, input: { ...base, seed: (base.seed ?? 1) + step, beats: base.beats.map((beat) => (beat.seed !== undefined ? { ...beat, seed: beat.seed + step } : beat)) } });
      }
    } else if (vary === "timing") {
      const current = base.feel ?? brandOf(document, base.brand)?.motion ?? lookOf(base.look ?? "crisp").feel;
      for (const feel of Object.keys(FEELS).filter((name) => name !== current).slice(0, operation.count)) changes.push({ label: `Feel: ${feel}`, input: { ...base, feel } });
    } else if (vary === "deck") {
      // Each variant is the composition made again with one of the project's next decks.
      const deals = deckDeals ? await deckDeals(document, operation.count) : [];
      if (!deals.length) throw problem('vary "deck" needs the project\'s deck: notes {action:"deck"} deals one.');
      for (const deck of deals) {
        const { input, applied } = deckComposition(base, deck);
        const names = [...deck.cards.map((card) => card.tag), ...(deck.setPiece ? [deck.setPiece.name] : [])];
        // A label is at most 80 characters: whole card names, then "+N".
        let label = `Deck ${deck.seed}: ${names.join(", ")}`;
        for (let kept = names.length - 1; label.length > 80 && kept > 0; kept -= 1) label = `Deck ${deck.seed}: ${names.slice(0, kept).join(", ")} +${names.length - kept}`;
        changes.push({ label, input, deck, applied, names });
      }
    } else if (vary === "format") {
      for (const format of operation.formats) changes.push({ label: `Format ${format}`, input: { ...base, format } });
    } else {
      for (const look of LOOK_NAMES.filter((name) => name !== (base.look ?? "crisp")).slice(0, operation.count)) changes.push({ label: `Look: ${look}`, input: { ...base, look } });
    }
    const set = newVariantSet(document, source, vary);
    const media = await mediaOf(document, work);
    const fonts = await fontsOf(document, work);
    const made = [];
    const backdropIds = new Set(source.composition.backdrop ?? []);
    const own = source.layers.filter((layer) => !layer.recipe && !backdropIds.has(layer.id));
    let insertAt = document.scenes.indexOf(source) + 1;
    const prefix = idBase(source);
    for (const [index, change] of changes.entries()) {
      const wanted = operation.newSceneIds?.[index];
      let id = wanted && !document.scenes.some((scene) => scene.id === wanted) ? wanted : null;
      for (let number = 2; !id; number += 1) if (!idsInDocument(document).has(`${prefix}-v${number}`)) id = `${prefix}-v${number}`;
      const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : `-${id}`;
      const composition = readCompose(change.input);
      const brand = brandOf(document, composition.brand);
      const faces = await facesOf(document, brand, composition.look, copyText(composition.beats), work, (await typeFor(document, brand)).fonts);
      const taken = idsInDocument(document);
      const copies = copyLayers(own, suffix, taken);
      for (const layerId of idsInLayers(copies)) taken.add(layerId);
      const env = { fonts, media, brand, faces, logo: logoOf(brand, media), sceneId: prefix, taken, suffix, renumber: true, reduced: Boolean(change.input.reduced), ownRoles: rolesOf(own) };
      let result;
      let finish = null;
      try {
        if (change.deck) {
          // A beat whose recipe does not offer the deck's entrance keeps its own.
          ({ result } = composeLenient({ ...composition, ...(brand ? { brand: brand.name } : {}) }, (input) => composeScene(input, { ...env, taken: new Set(taken) })));
          const used = new Set([...taken, ...idsInLayers(result.layers)]);
          finish = deckFinish(result.layers, change.deck, { frame: result.frame, duration: result.duration, id: `${prefix}-deck${suffix}`, taken: used });
        } else result = composeScene({ ...composition, ...(brand ? { brand: brand.name } : {}) }, env);
      } catch (error) { throw problem(`${change.label}: ${error.message}`); }
      if (finish) {
        result.layers.push(...finish.layers);
        const shown = new Set([...change.applied, ...finish.applied]);
        const left = change.names.filter((name) => !shown.has(name));
        work.notes.push(`${id}: deck ${change.deck.seed} built ${[...shown].join(", ") || "its seed only"}${left.length ? `; left to build: ${left.join(", ")}` : ""}`);
      }
      const backdrop = result.layers.filter((layer) => !layer.recipe).map((layer) => layer.id);
      if (vary === "format") {
        // Your own layers keep their place in proportion to the new frame; check says if one no longer fits.
        for (const layer of copies.filter((item) => !item.parentId)) {
          layer.x = Math.round((layer.x + layer.width / 2) * result.frame.width / source.width - layer.width / 2);
          layer.y = Math.round((layer.y + layer.height / 2) * result.frame.height / source.height - layer.height / 2);
        }
        (work.finishScenes ??= []).push(id);
      }
      const scene = createScene({
        ...nextScenePosition(document.scenes), ...(source.drift ? { drift: { ...source.drift } } : {}), id, name: `${source.name} · ${change.label}`.slice(0, 120),
        width: result.frame.width, height: result.frame.height, duration: result.duration, background: result.background,
        layers: [...result.layers, ...copies],
        composition: { ...result.composition, ...(change.input.reduced ? { reduced: true } : {}), backdrop },
        variant: { of: source.id, set, label: change.label, vary, ...(change.deck ? { deck: { seed: change.deck.seed, reroll: change.deck.reroll, cards: change.deck.cards.map((card) => card.tag), setPiece: change.deck.setPiece?.name ?? null } } : {}) },
      });
      setAssertions(scene, result.assertions);
      document.scenes.splice(insertAt, 0, scene);
      insertAt += 1;
      made.push(scene);
    }
    source.variant = { of: source.id, set, label: "Original", vary };
    work.notes.push(`variants ${set}: ${made.map((scene) => `${scene.id} (${scene.variant.label})`).join(", ")}. look {mode:"variants", scene:"${made[0].id}"} shows them beside the original; pick_variant {scene} marks the one to keep.`);
  }

  function applyPickVariant(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    if (!scene.variant) throw problem(`${scene.id} is not a variant. variants {scene} makes some.`);
    for (const item of document.scenes) {
      if (item.variant?.set !== scene.variant.set) continue;
      if (item.id === scene.id) item.variant = { ...item.variant, picked: true };
      else { const { picked, ...rest } = item.variant; item.variant = rest; }
    }
    const others = document.scenes.filter((item) => item.variant?.set === scene.variant.set && item.id !== scene.id).map((item) => item.id);
    work.notes.push(`picked ${scene.id} (${scene.variant.label}). The others stay: ${others.join(", ")}; delete_scene removes one.`);
  }

  // ---- the 2D camera ----------------------------------------------------------------------
  // frame: the layer's group (or a new <layer>-camera group around it) moves so a region of the
  // layer fills the frame or sits at a spot: an instant step (cut) or an expo-out move.
  async function applyFrame(document, operation, work) {
    const fonts = await fontsOf(document, work);
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === operation.layerId));
    if (!scene) throw problem(`No layer "${operation.layerId}".`, closest(String(operation.layerId), document.scenes.flatMap((item) => item.layers.map((layer) => layer.id))));
    if (operation.sceneId && operation.sceneId !== scene.id) throw problem(`${operation.layerId} is not in scene ${operation.sceneId}.`);
    const layerOf = (id) => scene.layers.find((item) => item.id === id);
    let group = layerOf(layerOf(operation.layerId).parentId);
    if (!group) {
      const taken = idsInDocument(document);
      let id = `${operation.layerId}-camera`;
      for (let number = 2; taken.has(id); number += 1) id = `${operation.layerId}-camera-${number}`;
      const layer = layerOf(operation.layerId);
      // A ui-plane's light falloff is a copy of the plane's box moved with it: the camera carries it too.
      const falloff = scene.layers.filter((item) => item.move?.name === "ui-plane" && item.move.part === "falloff" && !item.parentId
        && (layer.animations ?? []).some((animation) => String(animation.id ?? "").startsWith(`${item.move.instance}.plane-`)));
      const carried = cutoutSpan(scene, layer);
      try { scene.layers = groupLayers(document, scene.id, [...new Set([layer.id, ...falloff.map((item) => item.id), ...carried])], { name: `${layer.name || layer.id} camera`, id, fonts }).layers; }
      catch (error) { throw problem(error.message); }
      group = layerOf(id);
      work.notes.push(`frame: made the camera group ${id} around ${[layer.id, ...carried].join(", ")} (nothing looks different)`);
    }
    const layer = layerOf(operation.layerId);
    const time = resolveAt(operation.at, timeLookup(document, scene, fonts, work));
    if (time < 0 || time >= scene.duration) throw problem(`at is ${round(time)} s, outside the scene (0 to ${round(scene.duration)} s).`);
    let target;
    try { target = frameTransform({ group, layer, geometry: geometryOf(layer, document.scenes, fonts), layers: scene.layers, rect: operation.rect, to: operation.to ?? "center", frame: { width: scene.width, height: scene.height }, evaluate: (item) => evaluateLayer(item, time) }); }
    catch (error) { throw problem(error.message); }
    if (!(target.scaleX >= 0.05 && target.scaleX <= 40)) throw problem(`That framing scales ${group.id} by ${target.scaleX}; pick a rect between about 3% and 100% of the layer.`);
    const now = evaluateLayer(group, time);
    const from = { x: round(now.x), y: round(now.y), scaleX: round(now.scaleX ?? 1, 4), scaleY: round(now.scaleY ?? 1, 4) };
    const taken = idsInDocument(document);
    let id = `${group.id}.frame`;
    for (let number = 2; taken.has(id); number += 1) id = `${group.id}.frame-${number}`;
    const cut = operation.cut === true;
    if (cut && time < 0.001) {
      // A cut at the scene's start has no frame before it to step from: the group starts framed
      // (an animation clamped to 0 would show the wide shot on frame 0, a one-frame flash).
      Object.assign(group, target);
      work.notes.push(`frame ${layer.id} [${operation.rect.join(", ")}] at 0 s: ${group.id} starts at ${round(target.scaleX / (from.scaleX || 1), 2)}x of its framing before`);
      planeLands(group, scene, work);
      return;
    }
    // A cut is an instant step that ends at `at`, so the frame at that time shows the new
    // framing; speed_jump and the other motion rules treat a step under half a frame as a jump
    // on purpose.
    const start = cut ? Math.max(0, round(time - 0.001)) : round(time);
    const duration = cut ? 0.001 : Math.min(operation.dur ?? 0.7, round(scene.duration - time));
    group.animations = [...(group.animations ?? []), {
      id, name: cut ? "Camera cut" : "Camera move", kind: "custom", start, duration, easing: cut ? "linear" : "expo-out",
      unit: "layer", stagger: 0, order: "forward", from, to: target,
    }];
    const ratio = round(target.scaleX / (from.scaleX || 1), 2);
    work.notes.push(`frame ${layer.id} [${operation.rect.join(", ")}] at ${round(time)} s: ${cut ? "cut" : `${round(duration)} s move`} on ${group.id} to ${ratio}x of its framing before (${id})`);
    planeLands(group, scene, work);
  }

  // A cut-out of the footage (cut_out marks it cutoutOf; a masked-type subject made before that)
  // sits on the footage's own pixels, so the camera carries it, and every layer stacked between
  // them: a title behind the subject is inside the shot. Left behind, the cut-out stays still
  // while the shot moves and the subject shows twice. Hiding the cut-out when masked-type ends
  // would not do: the camera can move during the title, and a cut-out can serve other titles.
  // Only layers outside groups, as the footage is when frame makes its camera.
  function cutoutSpan(scene, layer) {
    const roots = scene.layers.filter((item) => !item.parentId);
    const ids = new Set(roots.filter((item) => item.cutoutOf === layer.id).map((item) => item.id));
    for (const entry of scene.moves ?? []) if (entry.name === "masked-type" && entry.settings?.layer === layer.id && entry.settings.subject) ids.add(entry.settings.subject);
    const places = roots.map((item, index) => (ids.has(item.id) ? index : -1)).filter((index) => index >= 0);
    if (!places.length) return [];
    const at = roots.indexOf(layer), low = Math.min(at, ...places), high = Math.max(at, ...places);
    return roots.slice(low, high + 1).filter((item) => item !== layer).map((item) => item.id);
  }

  // A ui-plane's swing flat was placed in the frame: the camera goes home over it, so the plane lands flat at 90%.
  function planeLands(group, scene, work) {
    if (homeCamera(group, scene.layers, { width: scene.width, height: scene.height })) work.notes.push(`frame: ${group.id} goes home over the ui-plane swing, so the plane lands flat at 90% of the frame`);
  }

  // split_image: the picture becomes clipping groups of real pixels in its place (engine/splitImage.js).
  async function applySplitImage(document, operation, work) {
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === operation.layerId));
    if (!scene) throw problem(`No layer "${operation.layerId}".`, closest(String(operation.layerId), document.scenes.flatMap((item) => item.layers.map((layer) => layer.id))));
    if (operation.sceneId && operation.sceneId !== scene.id) throw problem(`${operation.layerId} is not in scene ${operation.sceneId}.`);
    const layer = scene.layers.find((item) => item.id === operation.layerId);
    let source = null;
    if (layer.type === "image" && layer.src) {
      try { source = (await mediaOf(document, work))(layer.src); } catch { source = null; }
    }
    let made;
    try { made = splitImage(scene, layer.id, operation.boxes, { taken: idsInDocument(document), source }); }
    catch (error) { throw problem(error.message); }
    scene.layers = made.layers;
    work.notes.push(...made.notes);
  }

  // ---- cues and brands ----------------------------------------------------------------------
  async function applySetCue(document, operation, work) {
    let time;
    let pin = null;
    if (operation.layerId !== undefined) {
      let placed;
      try { placed = footageCueTime(document, operation.layerId, operation.media); } catch (error) { throw problem(error.message); }
      pin = { layer: placed.layer.id, name: placed.layer.name || placed.layer.id, media: operation.media, shown: placed.shown, raw: placed.time };
      time = Math.min(MAX_TIME, Math.max(0, placed.time));
    } else if (typeof operation.at === "number" || /^\s*\d*\.?\d+\s*$/.test(String(operation.at))) time = Number(operation.at);
    else {
      const fonts = await fontsOf(document, work);
      const parsed = parseAt(operation.at);
      if (parsed.kind === "auto") throw problem("set_cue needs a time; auto has no meaning outside a scene.");
      const name = parsed.kind === "cue" ? null : parsed.whole ?? parsed.target;
      const scene = name ? document.scenes.find((item) => idsInLayers(item.layers).some((id) => id === name || id === parsed.target)) ?? document.scenes[0] : document.scenes[0];
      time = resolveAt(operation.at, timeLookup(document, scene, fonts, work));
    }
    const cues = document.cues ?? [];
    const same = cues.find((cue) => cue.name === operation.name);
    if (same && same.kind !== "marker") throw problem(`The cue ${operation.name} comes from a ${same.kind}; choose another name for your marker.`);
    const cue = { name: operation.name, time: round(time), kind: "marker", ...(pin ? { layer: pin.layer, media: pin.media } : {}) };
    document.cues = [...cues.filter((entry) => entry.name !== operation.name), cue].sort((a, b) => a.time - b.time);
    const where = pin ? ` (${pin.media} s into ${pin.name}'s file${pin.shown ? "" : `; the clip does not show it, it would be at ${round(pin.raw)} s`})` : "";
    work.notes.push(`cue ${operation.name} at ${round(time)} s${where}${same ? " (moved)" : ""}`);
  }

  function applyRemoveCue(document, operation, work) {
    const cue = (document.cues ?? []).find((entry) => entry.name === operation.name);
    if (!cue) throw problem(`No cue "${operation.name}".`, closest(operation.name, (document.cues ?? []).map((entry) => entry.name)));
    if (cue.kind !== "marker") throw problem(`${operation.name} comes from a ${cue.kind}, not a marker you set; it cannot be removed here.`);
    document.cues = document.cues.filter((entry) => entry !== cue);
    work.notes.push(`removed cue ${operation.name}`);
  }

  async function applySetBrand(document, operation, work) {
    const brand = { name: operation.name };
    if (operation.colors !== undefined) {
      brand.colors = {};
      for (const [role, value] of Object.entries(operation.colors)) {
        const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(String(value));
        brand.colors[role] = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : value;
      }
    }
    if (operation.fonts !== undefined) brand.fonts = operation.fonts.map((font) => (typeof font === "string" ? { family: font } : font));
    if (operation.logos !== undefined) {
      const media = await mediaOf(document, work);
      brand.logos = operation.logos.map((logo) => {
        const entry = typeof logo === "string" ? { media: logo } : logo;
        if (!isRecord(entry)) throw problem("Each logo is {media} (an uploaded picture's ID or name) or {text}.");
        if (entry.media !== undefined || entry.src !== undefined) {
          const found = media(entry.media ?? entry.src);
          return { media: found.id, ...(entry.name ? { name: entry.name } : {}) };
        }
        return entry;
      });
    }
    if (operation.motion !== undefined) brand.motion = operation.motion;
    // Checks the colours and the rest before any font is downloaded.
    const brands = [...(document.brands ?? []).filter((entry) => entry.name !== operation.name), brand];
    try { parseDocument({ ...document, brands }); } catch (error) { throw problem(error.message.replace(/^document\.brands\[\d+\]\./, "")); }
    if (brand.fonts?.length) await facesOf(document, brand, "crisp", "", work);
    const existed = (document.brands ?? []).some((entry) => entry.name === operation.name);
    document.brands = brands;
    work.notes.push(`brand ${operation.name} ${existed ? "replaced" : "saved"}${brand.fonts ? `: fonts ${brand.fonts.map((font) => `${font.family}${font.weight ? ` ${font.weight}` : ""}`).join(" / ")}` : ""}`);
  }

  function applyRemoveBrand(document, operation, work) {
    const brands = document.brands ?? [];
    if (!brands.some((brand) => brand.name === operation.name)) throw problem(`No brand kit "${operation.name}".`, closest(operation.name, brands.map((brand) => brand.name)));
    document.brands = brands.filter((brand) => brand.name !== operation.name);
    work.notes.push(`removed brand ${operation.name}`);
  }

  // ---- templates ----------------------------------------------------------------------------
  function applyMakeTemplate(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    const length = scene.duration;
    const beats = scene.composition?.beats ? composedBeats(scene) : null;
    let intro = operation.intro ?? (beats && beats[0].end < length / 2 ? beats[0].end : round(length * 0.15));
    let outro = operation.outro ?? (beats && length - beats.at(-1).start < length / 2 ? round(length - beats.at(-1).start) : round(length * 0.15));
    if (intro + outro >= length - 0.5) throw problem(`intro (${intro} s) and outro (${outro} s) leave no middle in a ${length} s scene; make them shorter.`);
    let fields = operation.fields;
    if (fields === undefined) {
      const used = new Set();
      fields = scene.layers.filter((layer) => (layer.type === "text" && layer.role !== "decor") || layer.type === "image").slice(0, 12).map((layer) => {
        let name = slug(layer.recipe ? `${layer.recipe.instance}${layer.recipe.part ? `-${layer.recipe.part}` : ""}` : layer.name ?? layer.id) || "field";
        for (let number = 2; used.has(name); number += 1) name = `${name.replace(/-\d+$/, "")}-${number}`;
        used.add(name);
        return { name, layer: layer.id, property: layer.type === "text" ? "text" : "src" };
      });
    } else {
      fields = fields.map((field) => {
        const layer = scene.layers.find((item) => item.id === field.layer);
        if (!layer) throw problem(`No layer "${field.layer}" in ${scene.id}.`, closest(field.layer, scene.layers.map((item) => item.id)));
        if (typeof field.property !== "string" || layer[field.property] === undefined || isRecord(layer[field.property]) || Array.isArray(layer[field.property]))
          throw problem(`${layer.id} has no simple property "${field.property}" (text, src, fill, fontSize, …).`, closest(String(field.property), Object.keys(layer).filter((key) => !isRecord(layer[key]) && !Array.isArray(layer[key]))));
        return { name: field.name ?? field.property, layer: layer.id, property: field.property };
      });
    }
    scene.template = { length, intro: round(intro), outro: round(outro), fields };
    work.notes.push(`template ${sceneLabel(scene)}: ${length} s, intro ${round(intro)} s and outro ${round(outro)} s keep their timing; fields ${fields.map((field) => field.name).join(", ") || "none"}`);
  }

  async function applyUseTemplate(document, operation, work) {
    const source = sceneOf(document, operation.template);
    if (!source.template) throw problem(`${source.id} is not a template; make_template {scene:"${source.id}"} makes it one.`);
    const id = operation.newSceneId;
    if (document.scenes.some((scene) => scene.id === id)) throw problem(`A scene ${id} exists already.`);
    const taken = idsInDocument(document);
    const base = idBase(source);
    let suffix = id.startsWith(base) ? id.slice(base.length) : `-${id}`;
    if (!suffix || [...copiedIds(source.layers, suffix).values()].some((copy) => taken.has(copy))) suffix = `-${id}`;
    const map = copiedIds(source.layers, suffix);
    const clash = [...map.values()].find((value) => taken.has(value));
    if (clash) throw problem(`The ID ${clash} is already used; give use_template another id.`);
    const scene = structuredClone(source);
    Object.assign(scene, nextScenePosition(document.scenes), { id, name: operation.name ?? `${source.name} copy`.slice(0, 120) });
    delete scene.variant;
    scene.layers = copyLayers(source.layers, suffix, taken);
    if (scene.assertions) scene.assertions = scene.assertions.map((assertion) => ({ ...assertion, target: map.get(assertion.target) ?? assertion.target, ...(assertion.other ? { other: map.get(assertion.other) ?? assertion.other } : {}) }));
    scene.template = { ...scene.template, fields: scene.template.fields.map((field) => ({ ...field, layer: map.get(field.layer) ?? field.layer })) };
    if (scene.composition) {
      scene.composition = { ...scene.composition, beats: scene.composition.beats.map((beat) => ({ ...beat, id: `${beat.id}${suffix}` })), backdrop: (scene.composition.backdrop ?? []).map((layerId) => map.get(layerId) ?? layerId) };
    }
    const values = operation.values ?? {};
    const names = scene.template.fields.map((field) => field.name);
    let media = null;
    for (const [name, value] of Object.entries(values)) {
      const field = scene.template.fields.find((entry) => entry.name === name);
      if (!field) throw problem(`The template has no field "${name}". Fields: ${names.join(", ")}.`, closest(name, names));
      const layer = scene.layers.find((item) => item.id === field.layer);
      if (field.property === "src" && layer.type === "image") {
        media ??= await mediaOf(document, work);
        const found = media(value);
        layer.src = found.src;
      } else {
        if (typeof value !== typeof layer[field.property]) throw problem(`${name} takes ${typeof layer[field.property] === "string" ? "text" : `a ${typeof layer[field.property]}`}.`);
        layer[field.property] = value;
      }
    }
    // Copy that changes no longer matches what the recipe or composition was given.
    if (Object.keys(values).length) delete scene.composition;
    const at = document.scenes.indexOf(source) + 1;
    document.scenes.splice(at, 0, scene);
    work.notes.push(`use_template ${sceneLabel(source)} → ${id}${Object.keys(values).length ? `, set ${Object.keys(values).join(", ")}` : ""}`);
    if (operation.duration !== undefined && operation.duration !== scene.duration) retimeScene(document, scene, operation.duration, work, { newScene: true });
  }

  async function applyRetime(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    if (!scene.template && scene.composition) {
      await applyCompose(document, { type: "compose", sceneId: scene.id, duration: operation.duration }, work);
      return;
    }
    retimeScene(document, scene, operation.duration, work);
  }

  async function applyShift(document, operation, work) {
    const scene = sceneOf(document, operation.sceneId);
    const plain = typeof operation.at === "number" || /^\s*\d*\.?\d+\s*$/.test(String(operation.at));
    const at = round(plain ? Number(operation.at) : resolveAt(operation.at, timeLookup(document, scene, await fontsOf(document, work), work)));
    let receipt;
    try { receipt = shiftScene(document, scene, at, round(operation.by)); }
    catch (error) { throw problem(error.message); }
    work.notes.push(`shift ${sceneLabel(scene)}: ${Object.values(receipt).join("; ")}`);
  }

  // ---- subject boxes ------------------------------------------------------------------------
  // The box is kept at the file moment the layer shows at t (sourceView.js), on the file the
  // layer plays now: boxes marked on an earlier file (before replace_media) are dropped.
  function applyMarkSubject(document, operation, work) {
    const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === operation.layerId));
    if (!scene) throw problem(`No layer "${operation.layerId}".`, closest(String(operation.layerId), document.scenes.flatMap((item) => item.layers.map((layer) => layer.id))));
    const layer = scene.layers.find((item) => item.id === operation.layerId);
    const name = layer.name || layer.id;
    if (layer.type !== "video") throw problem(`mark_subject needs a video layer; ${name} is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer.`);
    const t = operation.t;
    const looked = t === undefined && operation.lookedAt?.src === layer.src ? operation.lookedAt.at : null;
    if (looked === null && (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > scene.duration)) {
      // The refusal names the layer's own span in scene seconds, so the next call can be sent as it is.
      const range = mediaPlaybackRange(layer, scene.duration);
      const [from, to] = [round(range?.start ?? 0), round(range?.end ?? scene.duration)];
      const middle = round((from + to) / 2);
      const said = t === undefined ? `No t and no look at ${name} yet: t is scene seconds` : "t is scene seconds";
      // retryWith: the answer's next resends this op with t in the layer's span (not the op's generic
      // example on a layer named "footage", which a weak agent sends as it is and fails again).
      throw Object.assign(problem(`${said}, from 0 to ${round(scene.duration)}. ${name} shows from ${from} to ${to} s (look {mode:"source", layer:"${name}", t:${middle}} first, then mark_subject {layer:"${name}", t:${middle}, box}; without t kino uses your last look at ${name}).`), { retryWith: { t: middle } });
    }
    const at = looked !== null ? round(looked) : round(mediaFrameState(layer, t).sourceTime);
    if (looked !== null) work.notes.push(`mark_subject ${name}: no t, so at your last look (file ${Number(at.toFixed(2))} s)`);
    const boxes = layer.subjectBoxes?.src === layer.src ? layer.subjectBoxes.boxes : [];
    const others = boxes.filter((entry) => Math.abs(entry.at - at) > SAME_MOMENT + 1e-9);
    const count = (number) => `${number} ${number === 1 ? "box" : "boxes"} on this layer`;
    const shown = (seconds) => Number(seconds.toFixed(2));
    // shows names what of the person's ask this frame shows (the origin word ask_unmet names). It is
    // kept apart from the subject (layer.askShows): the thing the ask points to may stand in the
    // background, and a box around it must not move the crop off the face. Alone (no box) it marks
    // only that; with a box the box marks the subject as usual; box:null removes the shows mark.
    const shows = operation.shows === undefined || operation.shows === null ? null : typeof operation.shows === "string" ? operation.shows.trim() : "";
    if (shows !== null && (shows.length < 1 || shows.length > 30)) throw problem('shows is 1-30 characters naming what of their ask this frame shows (the word ask_unmet names), such as shows:"tower".');
    const askMarks = layer.askShows?.src === layer.src ? layer.askShows.marks : [];
    const askOthers = askMarks.filter((entry) => Math.abs(entry.at - at) > SAME_MOMENT + 1e-9);
    if (shows && operation.box === null) {
      if (askOthers.length === askMarks.length) throw problem(`There is no shows mark at file ${shown(at)} s to remove.`);
      if (askOthers.length) layer.askShows = { src: layer.src, marks: askOthers };
      else delete layer.askShows;
      work.notes.push(`mark_subject ${name}: removed the shows mark at file ${shown(at)} s`);
      return;
    }
    if (shows && operation.box === undefined) {
      if (askOthers.length >= MAX_ASK_SHOWS) throw problem(`${name} has ${MAX_ASK_SHOWS} shows marks, the most kept.`);
      layer.askShows = { src: layer.src, marks: [...askOthers, { at, what: shows }].sort((a, b) => a.at - b.at) };
      work.notes.push(`mark_subject ${name}: shows "${shows}" at file ${shown(at)} s (the subject boxes are unchanged)`);
      return;
    }
    if (operation.box === null) {
      if (others.length === boxes.length) {
        const times = boxes.map((entry) => shown(entry.at));
        throw problem(`There is no box at file ${shown(at)} s to remove (${times.length ? `boxes at ${times.length > 8 ? `${times.slice(0, 8).join(", ")}, …` : times.join(", ")} s` : "no boxes on this layer"}).`);
      }
      if (others.length) layer.subjectBoxes = { src: layer.src, boxes: others };
      else delete layer.subjectBoxes;
      noteMark(work, layer.id, { name, at, removed: true, total: count(others.length),
        line: `mark_subject ${name}: removed the box at file ${shown(at)} s · ${count(others.length)}` });
      return;
    }
    // Four numbers from 0 to 1 are a fraction box (many vision tools give those): a subject under
    // 1% of the frame in its top-left corner is not what was meant.
    if (Array.isArray(operation.box) && operation.box.length === 4 && operation.box.every((value) => typeof value === "number" && value >= 0 && value <= 1)) {
      const percent = operation.box.map((value) => round(value * 100));
      throw problem(`box is in % of the source frame (0–100), not 0–1: [${percent.join(", ")}], not [${operation.box.join(", ")}].`);
    }
    const box = subjectBox(operation.box);
    if (!box) throw problem('box is [x, y, w, h] in % of the source frame (look {mode:"source"} draws the grid), such as [40, 10, 25, 80]: each from 0 to 100, w and h above 0, x + w and y + h at most 100.');
    if (others.length >= MAX_SUBJECT_BOXES) throw problem(`${name} has ${MAX_SUBJECT_BOXES} subject boxes, the most kept; remove some with box:null.`);
    // part names a deliberate part crop (an eye strip): 1 to 30 characters, kept on the box.
    const part = operation.part === undefined || operation.part === null ? null : typeof operation.part === "string" ? operation.part.trim() : "";
    if (part !== null && (part.length < 1 || part.length > 30)) throw problem("part is 1-30 characters naming the part you mean (eyes), or leave it out for the whole subject.");
    if (shows && askOthers.length >= MAX_ASK_SHOWS) throw problem(`${name} has ${MAX_ASK_SHOWS} shows marks, the most kept.`);
    layer.subjectBoxes = { src: layer.src, boxes: [...others, { at, box, by: "agent", ...(part ? { part } : {}) }].sort((a, b) => a.at - b.at) };
    if (shows) layer.askShows = { src: layer.src, marks: [...askOthers, { at, what: shows }].sort((a, b) => a.at - b.at) };
    noteMark(work, layer.id, { name, at, removed: false, total: count(others.length + 1),
      line: `mark_subject ${name}: agent box [${box.join(", ")}]${part ? ` (${part})` : ""}${shows ? ` and shows "${shows}"` : ""} at file ${shown(at)} s · ${count(others.length + 1)}` });
  }

  // One receipt line per layer, however many marks the edit makes (an edit may hold 200 ops):
  // the op's own line for one mark, else how many, over which file seconds, and the layer's total.
  function noteMark(work, layerId, { name, at, removed, total, line }) {
    work.marks ??= new Map();
    let mark = work.marks.get(layerId);
    if (!mark) {
      mark = { index: work.notes.push(line) - 1, marked: 0, removed: 0, from: at, to: at };
      work.marks.set(layerId, mark);
    }
    mark[removed ? "removed" : "marked"] += 1;
    mark.from = Math.min(mark.from, at);
    mark.to = Math.max(mark.to, at);
    if (mark.marked + mark.removed === 1) return;
    const shown = (seconds) => Number(seconds.toFixed(2));
    const done = [mark.marked && `${mark.marked} agent boxes marked`, mark.removed && `${mark.removed} removed`].filter(Boolean).join(", ");
    work.notes[mark.index] = `mark_subject ${name}: ${done} at file ${shown(mark.from)}–${shown(mark.to)} s · ${total}`;
  }

  // ---- place {on, of}: a face part of a footage layer, in scene pixels (engine/footage/faceParts.js) ----
  // Reads the layer's own marks and the faces a full check saved (never a new decode). Returns
  // {x, y, edge, time, faceWidth, line}: the point, whether the layers' center or bottom goes on it,
  // the face box's width on screen (to size type against) and the receipt's words for the source.
  async function faceTarget(document, scene, operation, work, layers) {
    const footage = scene.layers.find((layer) => layer.id === operation.of);
    if (!footage) throw problem(`No video layer "${operation.of}" in ${sceneLabel(scene)} (the layers placed are there).`, closest(String(operation.of), scene.layers.filter((layer) => layer.type === "video").map((layer) => layer.name || layer.id)));
    const name = footage.name || footage.id;
    if (footage.type !== "video") throw problem(`place {on} needs a video layer in of; ${name} is ${/^[aeiou]/.test(footage.type) ? "an" : "a"} ${footage.type} layer.`);
    const fonts = await fontsOf(document, work);
    // Default: the earliest entrance among the placed layers (0 when none has one).
    const entrances = layers.map((layer) => entranceWindow(layer, fonts)?.[0]).filter((start) => Number.isFinite(start));
    const time = operation.at !== undefined ? resolveAt(operation.at, timeLookup(document, scene, fonts, work)) : (entrances.length ? Math.min(...entrances) : 0);
    if (!(time >= 0 && time <= scene.duration)) throw problem(`at is ${round(time)} s, outside the scene (0 to ${round(scene.duration)} s).`);
    const sourceTime = mediaFrameState(footage, time).sourceTime;
    let size = null;
    try { const file = (await mediaOf(document, work))(footage.src); if (file?.width > 0 && file?.height > 0) size = { width: file.width, height: file.height }; } catch { /* drawn as the box's shape */ }
    const marks = footage.subjectBoxes?.src === footage.src ? footage.subjectBoxes.boxes : [];
    const samples = (await subjectSamples?.(footage).catch(() => null)) ?? [];
    const found = pickFace({ marks, samples, sourceTime, on: operation.on, size });
    const t = round(time);
    // No face: the refusal names the mark call (its own example would place on a slot instead).
    if (!found)
      throw Object.assign(problem(`No face on ${name} near file ${round(sourceTime)} s (no mark there${samples.length ? ", and kino found no face in the saved samples" : ", and no faces measured yet: check measures them in camera footage, drawn faces are mostly missed"}). Look at the frame (look {mode:"source", layer:"${name}", t:${t}}), mark the head: mark_subject {layer:"${name}", t:${t}, box:[x, y, w, h], part:"face"} (or part:"${operation.on === "above-head" ? "face" : operation.on}" for the part itself), then place again.`), { noExample: true });
    const { point, edge } = facePartPoint(found, operation.on, { offset: operation.offset });
    const spot = subjectOnScene(scene, footage, time, [point[0], point[1], 0, 0], size);
    const face = subjectOnScene(scene, footage, time, found.box, size);
    if (!spot || !face) throw problem(`${name} has no size at ${t} s.`);
    const shares = found.how === "part" ? null : facePartPoint(found, operation.on, {}).point;
    const how = found.how === "part"
      ? `your ${operation.on === "between-eyes" ? "eyes" : operation.on} mark at file ${round(found.at)} s (exact)`
      : `${found.how === "head" ? "your head mark" : "the face kino found"} at file ${round(found.at)} s, an estimate from the box${shares && operation.on !== "above-head" ? ` (${operation.on} at ${Math.round(((shares[1] - found.box[1]) / found.box[3]) * 100)}% of its height)` : ""}: look {mode:"frame", t:${t}} confirms it; offset:[x, y] (% of the face box)${["face", "above-head"].includes(operation.on) ? "" : ` or mark_subject {part:"${operation.on}"}`} corrects it`;
    return { x: spot.x0, y: spot.y0, edge, time: t, faceWidth: Math.round(face.x1 - face.x0), line: `${{ "between-eyes": "between the eyes", "above-head": "above the head" }[operation.on] ?? `on the ${operation.on}`} of ${name} at ${t} s: ${how}` };
  }

  // ---- frame_shot: kino's own shot layout on hand-placed video layers (engine/footage/layout.js) ----
  // The file's size comes from its media record and the faces from the saved samples, so the agent
  // names only the layer. A layer kino already framed (its blurred backdrop is there, or the crop
  // would not move) is said so in the receipt, not refused.
  async function applyFrameShot(document, operation, work) {
    const media = await mediaOf(document, work);
    const allIds = () => document.scenes.flatMap((item) => item.layers.map((layer) => layer.id));
    for (const layerId of operation.layerIds) {
      const scene = document.scenes.find((item) => item.layers.some((layer) => layer.id === layerId));
      if (!scene) throw problem(`No layer "${layerId}".`, closest(String(layerId), allIds()));
      if (operation.sceneId && operation.sceneId !== scene.id) throw problem(`${layerId} is not in scene ${operation.sceneId}.`);
      const layer = scene.layers.find((item) => item.id === layerId);
      const name = layer.name || layer.id;
      if (layer.type !== "video") throw problem(`frame_shot needs a video layer; ${name} is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer.`);
      let file;
      try { file = media(layer.src); }
      catch { throw problem(`frame_shot needs ${name}'s file in kino's media library (import it with project {action:"import", file} and use its src).`); }
      const size = { width: file.width, height: file.height };
      const samples = (await subjectSamples?.(layer)) ?? [];
      // Logos the footage finder found burned into the file: the crop keeps them out (a reset to the
      // full frame brought one back in a director's draft, .scratch/ceiling/c/result.md friction 2).
      const marks = Array.isArray(file.footage?.marks) ? file.footage.marks.filter((mark) => Array.isArray(mark?.box) && mark.box.length === 4) : [];
      let shot;
      try { shot = frameShot(scene, layer, { size, samples, taken: new Set(allIds()), marks }); }
      catch (error) {
        if (!/is already framed/.test(error.message)) throw problem(error.message);
        const backdrop = error.message.match(/framed: (.+) is its blurred backdrop/)?.[1] ?? "a blurred copy";
        work.notes.push(`frame_shot ${name}: already framed (${backdrop} is its blurred backdrop; delete it to frame again)`);
        continue;
      }
      const same = ["x", "y", "width", "height"].every((key) => Math.abs((layer[key] ?? 0) - shot.patch[key]) <= 1);
      if (shot.kind === "fill" && same) { work.notes.push(`frame_shot ${name}: already framed (kino's crop is where it is)`); continue; }
      let next;
      try { next = applyOperations(document, [{ type: "frame_shot", sceneId: scene.id, layerId, size, samples, ...(marks.length ? { marks } : {}) }]); }
      catch (error) { throw problem(error.message); }
      document.scenes = next.scenes;
      const box = `${shot.patch.width}×${shot.patch.height} at ${shot.patch.x}, ${shot.patch.y}`;
      const on = { mark: "the marked subject", "mark-salient": "the mark and what kino sees around it", face: "the face", salient: "what kino sees (a saliency box)" }[shot.on];
      work.notes.push(shot.kind === "fill"
        ? `frame_shot ${name}: ${on ? `cropped to ${on}` : "filled the frame"} (${box})`
        : `frame_shot ${name}: whole shot as a card (${box}), blurred backdrop ${shot.backdrop.id} added under it`);
      if (shot.marks) work.notes.push(shot.marks.out
        ? `frame_shot ${name}: the mark burned into its ${markPlaces(marks)} stays outside the crop (${shot.marks.zoom}x)`
        : `frame_shot ${name}: the mark burned into its ${markPlaces(marks)} still shows: cropping it out would ${shot.marks.kept === "face" ? "cut the subject" : `need over ${MARK_ZOOM_MOST}x`}. ${markWays(name, marks, { width: scene.width, height: scene.height }, size, shot.patch)}`);
      // No saved faces and no mark: kino framed the file by its size alone. Faces are measured by a full check.
      if (!samples.length && !layer.subjectBoxes?.boxes?.length)
        work.notes.push(`frame_shot ${name}: no faces measured for this file yet, so the frame uses only its size (a full check with pixels on finds faces; then frame_shot again after deleting the backdrop, or mark_subject)`);
      // The op writes the box once; a move or scale animation of the layer keeps its own x, y, width or height.
      const framed = document.scenes.flatMap((item) => item.layers).find((item) => item.id === layerId);
      const moving = (framed?.animations ?? []).filter((animation) => /"(?:x|y|width|height)":/.test(JSON.stringify([animation.from ?? null, animation.to ?? null, animation.keyframes ?? null])));
      if (moving.length)
        work.notes.push(`frame_shot ${name}: ${moving.length} animation${moving.length === 1 ? "" : "s"} on it still move or scale the layer from its old box and pull it off the frame above (delete_animation ${moving.length === 1 ? "it" : "them"}, or update_animation to the new box)`);
    }
  }

  // ---- source: the material the video is made from (engine/sources.js) ----
  function applySource(document, operation, work) {
    const name = typeof operation.name === "string" ? operation.name.trim() : "";
    if (!name || name.length > SOURCE_LIMITS.name) throw problem(`source name is 1–${SOURCE_LIMITS.name} characters: what the material is, such as "README" or "their message".`);
    const list = document.sources ?? [];
    const at = list.findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (operation.text === null) {
      if (at < 0) throw problem(`There is no source "${name}" to remove.`, list.map((entry) => entry.name));
      list.splice(at, 1);
      document.sources = list;
      work.notes.push(`source "${name}" removed · ${list.length} left`);
      return;
    }
    if (typeof operation.text !== "string" || !operation.text.trim()) throw problem("source text is the material itself, copied word for word (null removes the source).");
    if (operation.text.length > SOURCE_LIMITS.text)
      throw problem(`source text is at most ${SOURCE_LIMITS.text} characters (it has ${operation.text.length}): save the parts the video uses, or split it into two sources.`);
    if (at < 0 && list.length >= SOURCE_LIMITS.count) throw problem(`At most ${SOURCE_LIMITS.count} sources: replace one (same name) or remove one (text:null).`, list.map((entry) => entry.name));
    if (at < 0) list.push({ name, text: operation.text });
    else list[at] = { name: list[at].name, text: operation.text };
    document.sources = list;
    work.notes.push(`source "${name}" ${at < 0 ? "saved" : "replaced"}: ${operation.text.length} characters · ${list.length} source${list.length === 1 ? "" : "s"}`);
  }

  // ---- board: the storyboard (engine/board.js, direction plan §5) ----
  // Every problem is collected, so the refusal names the first and counts the rest; nothing is
  // saved unless the whole board is right.
  async function applyBoard(document, operation, work) {
    const scene = mainScene(document);
    if (!scene) throw boardProblem("bad_shot", "the board needs a scene: add_scene first.");
    const problems = [];
    const add = (code, message, suggestions = []) => problems.push({ code, message, suggestions });
    const media = await boardMedia(document, work);
    const music = boardMusic(document, scene, operation.music, work, add);
    const lists = {
      calls: boardList(operation.calls, `calls is at most ${BOARD_LIMITS.calls} of your own calls, each up to ${BOARD_LIMITS.call} characters.`, BOARD_LIMITS.calls, BOARD_LIMITS.call, add, "calls"),
      open: boardList(operation.open, `open is at most ${BOARD_LIMITS.open} questions for the person, each up to ${BOARD_LIMITS.item} characters.`, BOARD_LIMITS.open, BOARD_LIMITS.item, add, "open"),
    };
    const sent = operation.shots;
    if (!Array.isArray(sent) || !sent.length || sent.length > BOARD_LIMITS.shots) add("bad_shot", `shots is a list of 1 to ${BOARD_LIMITS.shots} shots.`);
    const shots = [];
    const refHelp = referenceHelp(await savedRefs?.(document));
    for (const [index, shot] of (Array.isArray(sent) ? sent : []).slice(0, BOARD_LIMITS.shots).entries())
      shots.push(await boardShot(document, scene, shot, index + 1, { media, add, work, refHelp }));
    if (!problems.length) {
      // A shot sent without an id keeps the id of the shot it continues (engine/board.js).
      keepShotIds(shots, document.board?.shots ?? []);
      const ids = new Map();
      shots.forEach((shot, index) => {
        if (ids.has(shot.id)) add("bad_shot", `shot ${index + 1} id "${shot.id}" is shot ${ids.get(shot.id)}'s too: ids are unique.`);
        ids.set(shot.id, index + 1);
      });
    }
    const board = { music, calls: lists.calls, open: lists.open, shots: shots.map(({ id, ...shot }) => ({ id, ...shot })) };
    const span = problems.length ? null : boardSpan(document, board);
    const gap = span ? boardCoverage(board, span) : null;
    if (gap) add(gap.code, gap.message);
    if (problems.length) {
      const [first] = problems;
      // Every problem, so one resend can fix them all (at most 8 listed, the rest counted).
      const rest = problems.slice(1, 9).map((problem) => problem.message);
      const more = problems.length > 1
        ? ` Also: ${rest.join(" ")}${problems.length > 9 ? ` (+${problems.length - 9} more)` : ""}` : "";
      throw boardProblem(first.code, `${first.message}${more}`, first.suggestions);
    }
    // Only a real change raises the board's rev: the board as parseDocument keeps it, compared.
    const old = document.board;
    const kept = normalizeBoard({ board: { rev: (old?.rev ?? 0) + 1, ...board } }).board;
    if (old && JSON.stringify({ ...old, rev: kept.rev }) === JSON.stringify(kept)) { work.notes.push(`board r${old.rev}: no change`); return; }
    document.board = kept;
    const last = board.shots.at(-1);
    work.notes.push(`board r${document.board.rev}: ${board.shots.length} shot${board.shots.length === 1 ? "" : "s"}, ${sec(board.shots[0].cue)}–${sec(last.cue + last.dur)} s, ${span.music ? `music ${span.music}` : "no music"} · look {mode:"board"} shows it`);
  }

  // The library's videos, pictures and sounds, found by a layer (its src), id, src or name.
  async function boardMedia(document, work) {
    work.mediaList ??= await listMedia();
    const list = work.mediaList.filter((item) => /^(?:video|image|audio)\//.test(String(item.mime ?? "")));
    const bare = (name) => String(name ?? "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
    const layers = document.scenes.flatMap((item) => item.layers);
    return (ref, kinds) => {
      const text = String(ref);
      let src = null;
      if (!text.startsWith("/api/media/") && work.resolver) {
        try {
          const id = work.resolver.resolve(text, "layer");
          src = layers.find((layer) => layer.id === id && ["video", "image", "audio"].includes(layer.type))?.src ?? null;
        } catch { /* not a layer: a file of the library */ }
      }
      const found = src ? list.find((item) => (item.src ?? `/api/media/${item.id}`) === src)
        : list.find((item) => item.id === text || item.src === text || `/api/media/${item.id}` === text)
          ?? list.find((item) => String(item.name ?? "").toLowerCase() === text.toLowerCase())
          ?? list.find((item) => bare(item.name) === bare(text));
      const kind = String(found?.mime ?? "").split("/")[0];
      if (!found || !kinds.includes(kind)) return { suggestions: closest(text, list.filter((item) => kinds.includes(String(item.mime).split("/")[0])).map((item) => item.name)) };
      return { src: found.src ?? `/api/media/${found.id}`, kind, width: found.width, height: found.height, duration: Number(found.duration) || 0, name: found.name ?? found.id };
    };
  }

  // music: "none", or an audio layer that plays in the main scene (its id is kept).
  function boardMusic(document, scene, ref, work, add) {
    if (ref === undefined || ref === null) {
      add("missing_layer", 'the board has no music: name the music layer, or say "none" if there is no music.');
      return NONE;
    }
    if (ref === NONE) return NONE;
    const rule = 'music is an audio layer\'s name or code, or "none"';
    let id = null, suggestions = [];
    try { id = typeof ref === "string" && work.resolver ? work.resolver.resolve(ref, "layer") : null; }
    catch (error) { suggestions = error.suggestions ?? []; }
    const layer = id ? document.scenes.flatMap((item) => item.layers).find((entry) => entry.id === id) : null;
    if (!layer) { add("bad_shot", `${rule}; there is no layer ${JSON.stringify(ref)}.`, suggestions); return NONE; }
    const name = layer.name || layer.id;
    if (layer.type !== "audio") { add("bad_shot", `${rule}; ${name} is ${/^[aeiou]/.test(layer.type) ? "an" : "a"} ${layer.type} layer.`); return NONE; }
    if (!scene.layers.includes(layer) || !mediaPlaybackRange(layer, scene.duration)) add("bad_shot", `music layer ${name} does not play in the video.`);
    return layer.id;
  }

  function boardList(value, rule, count, limit, add, name) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > count || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      add("bad_shot", rule);
      return [];
    }
    // Each entry over the limit is named, so one retry fixes them all.
    const long = value.map((entry, index) => [index, entry.trim().length]).filter(([, length]) => length > limit);
    for (const [index, length] of long) add("bad_shot", `${name}[${index}] is ${length} characters, limit ${limit}.`);
    return long.length ? [] : value.map((entry) => entry.trim());
  }

  // One shot, checked and filled in (text defaults), or what is wrong with it (`add`).
  async function boardShot(document, scene, shot, n, { media, add, work, refHelp }) {
    if (!isRecord(shot)) { add("bad_shot", `shot ${n} is {cue, dur, pacing, media, in, crop, subject, follow, text, sound, why}.`); return {}; }
    const keys = ["id", "cue", "dur", "pacing", ...SHOT_LAYERS, "move", "why", "speed", "alts"];
    const extra = Object.keys(shot).filter((key) => !keys.includes(key));
    if (extra.length) add("bad_shot", `shot ${n} has no field "${extra[0]}"; a shot has ${keys.join(", ")}.`, closest(extra[0], keys));
    const missing = SHOT_LAYERS.filter((layer) => shot[layer] === undefined || shot[layer] === null);
    for (const layer of missing) add("missing_layer", `shot ${n} has no ${layer}: say "none" if there is no ${layer}.`);
    if (shot.id !== undefined && (typeof shot.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(shot.id))) add("bad_shot", `shot ${n} id is 1 to 24 letters, digits, dashes or underscores.`);
    const number = (value) => typeof value === "number" && Number.isFinite(value);
    if (!number(shot.cue) || shot.cue < 0) add("bad_shot", `shot ${n} has no cue: its start in seconds.`);
    if (!number(shot.dur) || shot.dur <= 0) add("bad_shot", `shot ${n} has no dur: its length in seconds.`);
    if (shot.speed !== undefined && (!number(shot.speed) || shot.speed < 0.05 || shot.speed > 16)) add("bad_shot", `shot ${n} speed is the clip's playback speed, 0.05 to 16 (default 1).`);
    const speed = number(shot.speed) && shot.speed >= 0.05 && shot.speed <= 16 ? shot.speed : 1;
    if (!PACING.includes(shot.pacing)) add("bad_shot", shot.pacing === undefined ? `shot ${n} has no pacing: beat_cut, phrase_flow or free.` : `shot ${n} pacing is beat_cut, phrase_flow or free.`, closest(String(shot.pacing ?? ""), PACING));
    const why = boardWhy(shot.why, `shot ${n}`, add);
    // move: the designed move (engine/board.js), every bad field named at once.
    const wrong = shot.move === undefined ? [] : moveProblems(shot.move, `shot ${n} move`, (name) => BOARD_MOVE_NAMES.has(name), { refHelp });
    for (const message of wrong) add("bad_shot", message, /name "/.test(message) ? closest(String(shot.move.name), [...BOARD_MOVE_NAMES]) : []);
    const move = shot.move !== undefined && !wrong.length ? shot.move : null;
    if (missing.length) return {};
    const result = { id: shot.id, cue: number(shot.cue) ? round(shot.cue) : 0, dur: number(shot.dur) ? round(shot.dur) : 0, pacing: shot.pacing, ...(speed !== 1 ? { speed: round(speed) } : {}) };
    const footage = boardFootage(shot, `shot ${n}`, { media, add, frame: scene });
    if (shot.follow !== NONE && !FOLLOW.includes(shot.follow)) add("bad_shot", `shot ${n} follow is steady, track, sweep or "none".`, closest(String(shot.follow), FOLLOW));
    if (shot.media === NONE && [shot.in, shot.crop, shot.subject, shot.follow].some((value) => value !== NONE))
      add("bad_shot", `shot ${n} has no media, so in, crop, subject and follow are "none".`);
    if (footage.file?.kind === "video") {
      if (!number(shot.in) || shot.in < 0) add("bad_shot", `shot ${n} is a video: in is the file second it starts at (0 or more).`);
      else if (footage.file.duration > 0 && number(shot.dur) && shot.in + shot.dur * speed > footage.file.duration + ONE_FRAME)
        add("bad_shot", `shot ${n} needs ${sec(shot.dur * speed)} s of ${footage.file.name} from ${sec(shot.in)} s, but the file ends at ${sec(footage.file.duration)} s.`);
      if (!FOLLOW.includes(shot.follow)) add("bad_shot", `shot ${n} is a video: follow is steady, track or sweep.`);
    }
    if (footage.file?.kind === "image" && shot.in !== NONE) add("bad_shot", `shot ${n} is a picture: in is "none".`);
    if (footage.file && shot.crop === NONE) add("bad_shot", `shot ${n} shows ${footage.file.name}, so crop is [x, y, w, h] in % of the source, or "whole" when it shows whole.`);
    Object.assign(result, footage.fields, { follow: shot.follow });
    result.text = await boardText(document, scene, shot.text, `shot ${n}`, { add, work });
    result.sound = boardSound(shot.sound, `shot ${n}`, { media, add });
    if (move) result.move = move;
    result.why = why;
    const alts = shot.alts ?? [];
    if (!Array.isArray(alts) || alts.length > BOARD_LIMITS.alts) add("bad_shot", `shot ${n} alts is a list of at most ${BOARD_LIMITS.alts} options {media?, in?, crop?, subject?, why}.`);
    result.alts = (Array.isArray(alts) ? alts : []).map((alt, index) => {
      const where = `shot ${n} option ${index + 1}`;
      if (!isRecord(alt) || Object.keys(alt).some((key) => !["media", "in", "crop", "subject", "why"].includes(key))) { add("bad_shot", `${where} is {media?, in?, crop?, subject?, why}.`); return {}; }
      const option = boardFootage({ in: NONE, crop: NONE, subject: NONE, ...alt, media: alt.media ?? NONE }, where, { media, add, frame: scene, partial: alt });
      return { ...option.fields, why: boardWhy(alt.why, where, add) };
    });
    return result;
  }

  function boardWhy(value, where, add) {
    if (typeof value !== "string" || !value.trim()) { add("bad_shot", `${where} has no why: one line on why this shot.`); return ""; }
    if (value.trim().length > BOARD_LIMITS.why) add("bad_shot", `${where} why is ${value.trim().length} characters, limit ${BOARD_LIMITS.why}: one line.`);
    return value.trim();
  }

  // media, in, crop and subject of a shot (or of an option, where `partial` holds what it gave).
  function boardFootage(shot, where, { media, add, frame, partial = null }) {
    const fields = {};
    const keep = (key, value) => { if (!partial || Object.hasOwn(partial, key)) fields[key] = value; };
    let file = null;
    if (shot.media === NONE) keep("media", NONE);
    else if (typeof shot.media !== "string" || !shot.media.trim()) add("bad_shot", `${where} media is an imported video or picture, a video layer, or "none".`);
    else {
      file = media(shot.media.trim(), ["video", "image"]);
      if (!file.src) { add("bad_shot", `${where} media ${JSON.stringify(shot.media)} is not an imported video or picture (library {topic:"media"} lists them).`, file.suggestions); file = null; }
      else keep("media", file.src);
    }
    if (shot.in === NONE) keep("in", NONE);
    else if (typeof shot.in === "number" && Number.isFinite(shot.in) && shot.in >= 0) keep("in", round(shot.in));
    else add("bad_shot", `${where} in is the file second the shot starts at, or "none".`);
    if (shot.crop === NONE || shot.crop === WHOLE) keep("crop", shot.crop);
    else {
      const crop = subjectBox(shot.crop);
      if (!crop) add("bad_shot", `${where} crop is [x, y, w, h] in % of the source: each from 0 to 100, w and h above 0, x + w and y + h at most 100.`);
      else {
        keep("crop", crop);
        // The crop has the video's shape on the file's pixels, within 2%.
        if (file?.width > 0 && file?.height > 0) {
          const shape = (crop[2] * file.width) / (crop[3] * file.height);
          const wanted = frame.width / frame.height;
          if (Math.abs(shape / wanted - 1) > 0.02) {
            const width = Number(((crop[3] * file.height * wanted) / file.width).toFixed(1));
            add("bad_shot", `${where} crop [${crop.join(", ")}] is ${shape.toFixed(2)} wide per 1 tall on the source; the video is ${frame.width}×${frame.height} (${wanted.toFixed(2)}): with h ${crop[3]}, w is ${width} (or crop "whole" when the source is shown whole).`);
          }
        }
      }
    }
    if (shot.subject === NONE) keep("subject", NONE);
    else {
      const subject = shot.subject;
      const boxes = isRecord(subject) ? (subject.boxes ?? (subject.box !== undefined ? [subject.box] : null)) : null;
      const checked = Array.isArray(boxes) ? boxes.map(subjectBox) : [];
      const extra = isRecord(subject) ? Object.keys(subject).filter((key) => !["what", "box", "boxes", "eyes"].includes(key)) : [];
      const eyes = subject?.eyes;
      const rule = `${where} subject is "none" or {what (up to ${BOARD_LIMITS.what} characters), box [x, y, w, h] (% of the source; boxes for up to ${BOARD_LIMITS.boxes}), eyes? (the eye line's y %)}`;
      let bad = false;
      const flag = (message) => { bad = true; add("bad_shot", message); };
      if (!isRecord(subject)) flag(`${rule}.`);
      else {
        if (extra.length) flag(`${rule}; it has ${extra.join(", ")}.`);
        if (typeof subject.what !== "string" || !subject.what.trim()) flag(`${where} subject.what is 1 to ${BOARD_LIMITS.what} characters: what the subject is.`);
        else if (subject.what.trim().length > BOARD_LIMITS.what) flag(`${where} subject.what is ${subject.what.trim().length} characters, limit ${BOARD_LIMITS.what}.`);
        if (!checked.length || checked.length > BOARD_LIMITS.boxes || checked.includes(null))
          flag(`${where} subject.box is [x, y, w, h] in % of the source (each 0 to 100, x + w and y + h at most 100); boxes for up to ${BOARD_LIMITS.boxes}.`);
        if (eyes !== undefined && !(typeof eyes === "number" && eyes >= 0 && eyes <= 100)) flag(`${where} subject.eyes is the eye line's y, 0 to 100 %.`);
      }
      if (!bad) keep("subject", { what: subject.what.trim(), boxes: checked, ...(eyes !== undefined ? { eyes: Number(eyes.toFixed(1)) } : {}) });
    }
    return { fields, file };
  }

  // text: "none", or {text, family, weight, size, y, fill} with kino's defaults, in a font kino has.
  async function boardText(document, scene, value, where, { add, work }) {
    if (value === NONE) return NONE;
    const keys = ["text", "family", "weight", "size", "y", "fill"];
    // Too long is one problem among the rest: the other checks still run, so one refusal names all.
    const long = isRecord(value) && typeof value.text === "string" && value.text.trim().length > BOARD_LIMITS.text;
    if (long) add("bad_shot", `${where} text.text is ${value.text.trim().length} characters, limit ${BOARD_LIMITS.text}.`);
    if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)) || typeof value.text !== "string" || !value.text.trim()
      || typeof value.family !== "string" || !value.family.trim()) {
      add("bad_shot", `${where} text is "none" or {text (up to ${BOARD_LIMITS.text} characters), family, weight?, size?, y?, fill?}.`);
      return NONE;
    }
    const text = { text: value.text.trim(), family: value.family.trim(), weight: value.weight ?? 700, size: value.size ?? Math.round(scene.height * 0.05), y: value.y ?? 20, fill: value.fill ?? "#ffffff" };
    if (!Number.isInteger(text.weight) || text.weight < 100 || text.weight > 900) add("bad_shot", `${where} text weight is a whole number from 100 to 900.`);
    if (typeof text.size !== "number" || !(text.size > 0) || text.size > 2000) add("bad_shot", `${where} text size is pixels at the video's size, above 0.`);
    if (typeof text.y !== "number" || !(text.y >= 0 && text.y <= 100)) add("bad_shot", `${where} text y is the text's center in % from the top (0 to 100).`);
    if (typeof text.fill !== "string" || !/^#(?:[\da-fA-F]{6}|[\da-fA-F]{8})$/.test(text.fill)) add("bad_shot", `${where} text fill is a hex color such as "#ffffff".`);
    const family = await boardFamily(document, text.family, work);
    if (family.found) text.family = family.found;
    else add("bad_shot", `${where} text family ${JSON.stringify(text.family)} is not a font kino has (library {topic:"fonts", search:${JSON.stringify(text.family)}}).`, family.suggestions);
    if (typeof text.size === "number") text.size = Number(text.size.toFixed(1));
    if (typeof text.y === "number") text.y = Number(text.y.toFixed(1));
    return long ? NONE : text;
  }

  // A family kino has: installed, or in the font catalog (set_font downloads catalog fonts).
  async function boardFamily(document, family, work) {
    const key = (name) => String(name ?? "").trim().toLowerCase();
    const fonts = await fontsOf(document, work);
    const installed = [...new Set(fonts.entries().flatMap((face) => [face.family, ...(face.aliases ?? [])]))];
    const local = installed.find((name) => key(name) === key(family));
    if (local) return { found: local };
    let families = [];
    try { families = (await fontCatalog?.list({ search: family, limit: 50 }))?.families ?? []; } catch { /* offline with no list: installed fonts only */ }
    const listed = families.find((entry) => key(entry.family) === key(family));
    if (listed) return { found: listed.family };
    return { suggestions: closest(family, [...installed, ...families.map((entry) => entry.family)]) };
  }

  // sound: "none", or {media, what}: a sound file the person sent (an audio or video file, or layer).
  function boardSound(value, where, { media, add }) {
    if (value === NONE) return NONE;
    const long = isRecord(value) && typeof value.what === "string" && value.what.trim().length > BOARD_LIMITS.what;
    if (long) add("bad_shot", `${where} sound.what is ${value.what.trim().length} characters, limit ${BOARD_LIMITS.what}.`);
    if (!isRecord(value) || typeof value.what !== "string" || !value.what.trim() || typeof value.media !== "string") {
      add("bad_shot", `${where} sound is "none" or {media, what (up to ${BOARD_LIMITS.what} characters)}.`);
      return NONE;
    }
    const file = media(value.media.trim(), ["audio", "video"]);
    if (!file.src) { add("bad_shot", `${where} sound media ${JSON.stringify(value.media)} is not an imported sound file (library {topic:"media"} lists them).`, file.suggestions); return NONE; }
    return long ? NONE : { media: file.src, what: value.what.trim() };
  }

  const APPLY = {
    recipe: applyRecipe, move: applyMove, compose: applyCompose, variants: applyVariants, pick_variant: applyPickVariant,
    place: layout.place, align: layout.align, distribute: layout.distribute, stack: layout.stack, fit: layout.fit,
    set_cue: applySetCue, remove_cue: applyRemoveCue, set_brand: applySetBrand, remove_brand: applyRemoveBrand,
    make_template: applyMakeTemplate, use_template: applyUseTemplate, retime: applyRetime, shift: applyShift, mark_subject: applyMarkSubject, split_image: applySplitImage,
    board: applyBoard, source: applySource, frame: applyFrame, frame_shot: applyFrameShot,
  };

  return {
    handles(operation) { return isBlockOperation(operation?.type) || needsTiming(operation); },
    /** Runs one op on a copy of `document` and returns the checked result. */
    async apply(document, operation, work) {
      work.notes ??= [];
      const next = structuredClone(document);
      if (needsTiming(operation)) return applyTiming(next, operation, work);
      if (operation.type === "compose" && operation.footage) return applyFootage(next, operation, work);
      if (operation.type === "compose" && operation.formatName) { await applyFormat(next, operation, work); return parseDocument(next); }
      if (operation.type === "variants" && operation.vary === "format" && !sceneOf(next, operation.sceneId).composition) return applyFootageFormats(next, operation, work);
      await APPLY[operation.type](next, operation, work);
      return parseDocument(next);
    },
  };
}

// ---- shared helpers ---------------------------------------------------------------------------
// The name a new set of variants of `source` shares: "<scene>-<vary>", numbered when taken.
function newVariantSet(document, source, vary) {
  let set = `${idBase(source)}-${vary}`;
  const sets = new Set(document.scenes.map((scene) => scene.variant?.set).filter(Boolean));
  for (let number = 2; sets.has(set); number += 1) set = `${idBase(source)}-${vary}-${number}`.slice(-48);
  return set;
}

// compose {footage} ops (engine/footage/ops.js) with `suffix` on every name they make and every
// reference to one (shot-1 → shot-1-v2): a layer name belongs to the whole project, so a second
// footage scene cannot reuse the first one's.
function suffixFootageOps(ops, suffix) {
  const naming = (op) => op.op === "add_layer" || op.op === "group_layers";
  const made = new Set(ops.flatMap((op) => (naming(op) ? [op.name] : op.op === "move" || op.op === "recipe" ? [op.id] : [])).filter(Boolean));
  const rename = (value) => (typeof value === "string" && made.has(value) ? `${value}${suffix}` : Array.isArray(value) ? value.map(rename) : value);
  return ops.map((op) => {
    const copy = { ...op };
    for (const key of ["name", "id", "layer", "layers", "under", "next", "from", "to"])
      if (copy[key] !== undefined && (key !== "name" || naming(op))) copy[key] = rename(copy[key]);
    return copy;
  });
}

// The subject boxes marked (mark_subject) on each video file in the project: src → [{at, box, by}].
function markedSubjects(document) {
  const marks = new Map();
  for (const scene of document.scenes)
    for (const layer of scene.layers) {
      if (layer.type !== "video" || layer.subjectBoxes?.src !== layer.src) continue;
      const list = marks.get(layer.src) ?? [];
      for (const entry of layer.subjectBoxes.boxes) if (!list.some((kept) => Math.abs(kept.at - entry.at) <= SAME_MOMENT)) list.push(entry);
      marks.set(layer.src, list);
    }
  for (const [src, list] of marks) marks.set(src, list.sort((a, b) => a.at - b.at).slice(0, MAX_SUBJECT_BOXES));
  return marks;
}

// The copy an op gives (copy plus copy fields given on their own) over `base`.
function rawCopyFields(definition, operation, base) {
  const keys = (definition.copy ?? []).map((field) => field.key);
  const first = keys[0] ?? "text";
  const asObject = (value) => (value === undefined ? {} : typeof value === "string" || Array.isArray(value) ? { [first]: value } : { ...value });
  const copy = { ...asObject(base.copy ?? base), ...asObject(operation.copy) };
  for (const key of keys) if (operation[key] !== undefined) copy[key] = operation[key];
  for (const key of Object.keys(copy)) if (copy[key] === null) delete copy[key];
  const loose = {};
  if (base.recipe) for (const key of keys) if (Object.hasOwn(copy, key)) loose[key] = copy[key];
  return base.recipe ? { ...loose, copy: undefined } : { copy };
}

function sameAssertion(a, b) {
  return a.type === b.type && a.target === b.target && (a.other ?? null) === (b.other ?? null);
}
function setAssertions(scene, list) {
  const unique = [];
  for (const assertion of list) if (!unique.some((entry) => sameAssertion(entry, assertion) && (entry.time ?? null) === (assertion.time ?? null))) unique.push(assertion);
  if (unique.length > MAX_ASSERTIONS) throw problem(`Scene ${scene.id} would have ${unique.length} assertions, more than ${MAX_ASSERTIONS}. Remove a recipe or two first.`);
  scene.assertions = unique;
}

// Copies of layers with `suffix` on every layer and animation ID (and the IDs they point at):
// "title" → "title-t2", and its "title.in" → "title-t2.in".
function copiedIds(layers, suffix) {
  const map = new Map(layers.map((layer) => [layer.id, `${layer.id}${suffix}`]));
  for (const layer of layers)
    for (const { animation } of animationTreeEntries(layer.animations ?? []))
      if (animation?.id) map.set(animation.id, animation.id.startsWith(`${layer.id}.`) ? `${map.get(layer.id)}${animation.id.slice(layer.id.length)}` : RANDOM_ID.test(animation.id) ? randomUUID() : `${animation.id}${suffix}`);
  return map;
}
function copyLayers(layers, suffix, taken = new Set()) {
  const map = copiedIds(layers, suffix);
  const clash = [...map.values()].find((id) => taken.has(id));
  if (clash) throw problem(`The ID ${clash} is already used.`);
  const renameAnimations = (list) => (list ?? []).map((animation) => ({
    ...animation, ...(animation.id ? { id: map.get(animation.id) ?? animation.id } : {}),
    ...(Array.isArray(animation.animations) ? { animations: renameAnimations(animation.animations) } : {}),
  }));
  return layers.map((layer) => {
    const copy = structuredClone(layer);
    copy.id = map.get(layer.id);
    if (copy.parentId && map.has(copy.parentId)) copy.parentId = map.get(copy.parentId);
    if (copy.recipe) copy.recipe = { ...copy.recipe, instance: map.get(copy.recipe.instance) ?? copy.recipe.instance };
    copy.animations = renameAnimations(copy.animations);
    return copy;
  });
}

// The start and end of each beat of a composed scene, from its main layers' entrances.
function composedBeats(scene) {
  const beats = scene.composition.beats;
  const starts = beats.map((beat) => {
    const layers = scene.layers.filter((layer) => layer.recipe?.instance === beat.id);
    const entrances = layers.flatMap((layer) => (layer.animations ?? []).filter((animation) => animation.kind === "in").map((animation) => animation.start));
    return entrances.length ? Math.max(0, round(Math.min(...entrances) - 0.2)) : 0;
  });
  return beats.map((beat, index) => ({ id: beat.id, start: starts[index], end: index + 1 < beats.length ? starts[index + 1] : scene.duration }));
}

/**
 * Changes a scene's length. Times in the first `intro` seconds stay, times in the last `outro`
 * seconds move with the end, and the middle stretches. Short animations (1 s or less) keep
 * their length, and an exit stays tied to its end.
 */
function retimeScene(document, scene, duration, work, { newScene = false } = {}) {
  const length = scene.duration;
  const starts = new Map(scene.layers.map((layer) => [layer, layer.mediaStart]));
  // A Speed animation decides which moment of the file plays when (mediaTime.js); beat cues
  // follow the file through the animations as they were.
  const animationsBefore = new Map(scene.layers.map((layer) => [layer, layer.animations]));
  const template = scene.template ?? { length, intro: round(length * 0.15), outro: round(length * 0.15), fields: [] };
  const { intro, outro } = template;
  if (duration < intro + outro + 0.5) throw problem(`A ${duration} s scene leaves no middle between the ${intro} s intro and ${outro} s outro; make it at least ${round(intro + outro + 0.5)} s.`);
  const middle = length - intro - outro;
  const scale = (duration - intro - outro) / middle;
  const map = (time) => round(time <= intro ? time : time >= length - outro ? time + duration - length : intro + (time - intro) * scale);
  const clamp = (time) => Math.min(duration, Math.max(0, time));
  const retimeList = (list) => (list ?? []).map((animation) => {
    if (!animation || typeof animation.start !== "number") return animation;
    const span = animation.kind === "composed" ? Math.max(0, ...(animation.animations ?? []).map((member) => (member.start ?? 0) + (member.duration ?? 0))) : animation.duration ?? 0;
    const end = animation.start + span;
    if (animation.kind === "composed" || span <= 1) {
      const start = animation.kind === "out" ? map(end) - span : map(animation.start);
      return { ...animation, start: round(clamp(Math.min(start, duration - span))) };
    }
    const start = clamp(map(animation.start));
    const length = round(Math.max(0.05, clamp(map(end)) - start));
    return { ...animation, start, duration: length, ...(animation.behavior ? { behavior: retimeBehavior(animation.behavior, span, length) } : {}) };
  });
  for (const layer of scene.layers) {
    layer.animations = retimeList(layer.animations);
    // A component plays its scene from componentStart, and a video or sound plays from
    // mediaStart: both move like the Show around them, so a sequence part still starts its
    // clock when it appears.
    if (layer.type === "component" && typeof layer.componentStart === "number") layer.componentStart = map(layer.componentStart);
    if (hasMediaPlay(layer) && typeof layer.mediaStart === "number") layer.mediaStart = map(layer.mediaStart);
  }
  scene.backgroundAnimations = retimeList(scene.backgroundAnimations);
  if (scene.assertions) scene.assertions = scene.assertions.map((assertion) => (typeof assertion.time === "number" ? { ...assertion, time: clamp(map(assertion.time)) } : assertion));
  // Planned stills (rests) move with the moments they cover; one squeezed to nothing, or onto
  // the one before it, is dropped (rests may not touch).
  if (scene.rests) {
    scene.rests = scene.rests.map((rest) => ({ at: clamp(map(rest.at)), until: clamp(map(rest.until)) }))
      .filter((rest, index, list) => rest.until > rest.at && (!index || rest.at > list[index - 1].until));
    if (!scene.rests.length) delete scene.rests;
  }
  scene.duration = round(duration);
  if (scene.template) scene.template = { ...scene.template, length: round(duration) };
  if (scene.composition) scene.composition = { ...scene.composition, duration: round(duration) };
  work.notes.push(`retime ${sceneLabel(scene)}: ${length} s → ${round(duration)} s (first ${intro} s and last ${outro} s keep their timing)`);
  // Beat and onset cues found in a sound move with it (a new scene's sounds have none yet).
  const cueNote = newScene ? null : moveBeatCues(document, scene, starts, length, animationsBefore);
  if (cueNote) work.notes.push(cueNote);
}

// ---- variants for look ------------------------------------------------------------------------
/** The scenes of a variant set, the original first: {set, members:[scene]} or null. */
export function variantSet(document, scene) {
  const set = scene?.variant?.set
    ?? document.scenes.filter((item) => item.variant?.of === scene?.id && item.variant.of !== item.id).at(-1)?.variant.set;
  if (!set) return null;
  const members = document.scenes.filter((item) => item.variant?.set === set);
  members.sort((a, b) => Number(b.variant.of === b.id) - Number(a.variant.of === a.id));
  return { set, members };
}

// ---- library ----------------------------------------------------------------------------------
/** library {topic:"moves"}: every move in one line each; with name, one move's fields and an example. */
export function movesLibraryText(name) {
  // Shared fields (move.js SHARED: ease, speed, color, accent, angle) and a move's knobs (font,
  // color and size knobs) show as one "+" in the short list.
  const fieldList = (move) => {
    const fields = Object.entries(move.fields).filter(([, field]) => !field.retired);
    const own = fields.filter(([, field]) => !field.shared && !field.knob).map(([key, field]) => `${key}${field.required ? "*" : ""}`).join(" ");
    return fields.some(([, field]) => field.shared || field.knob) ? `${own} +` : own;
  };
  if (name) {
    const move = MOVES[String(name)];
    if (!move) {
      try { moveOf(String(name)); } catch (error) { throw problem(error.message, error.suggestions ?? []); }
    }
    return [
      `${move.name} [${move.tags.join(", ")}]: ${move.about}.`,
      `fits: ${move.fits}.`,
      `fields (* = required): ${Object.entries(move.fields).filter(([, field]) => !field.retired).map(([key, field]) => `${key}${field.required ? "*" : ""}: ${field.about}`).join("; ")}.`,
      `at${move.needsAt ? "*" : ""}: when it starts; dur: seconds (${move.lasts ?? `default ${move.length}`}${move.shortest ? `, at least ${move.shortest}` : ""}); seed: other choices; reduced:true (or a reduced composition): ${move.reduced ?? "a calm version with fades, no blur sweeps"}.`,
      move.nested?.length ? `${move.nested.join(" and ")} may be a layer inside a group (used as itself; its parts go in that group).` : "",
      `example: ${JSON.stringify({ op: "move", name: move.name, ...move.example })}`,
      move.setup ? `the example's layers: ${move.setup}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    'Moves: move {name, at, …} on your layers, pictures, brand. * required; + more knobs (ease, speed, color, font…). library {topic:"moves", name}: fields, example.',
    ...MOVE_NAMES.map((key) => { const move = MOVES[key]; return `- ${key}(${fieldList(move)}) [${move.tags.join(", ")}]: fits ${move.fits}.`; }),
  ].join("\n");
}

/** library {topic:"blocks"}: recipes, looks, formats, slots and timing; with name, one of them. */
export function blocksLibraryText(name) {
  if (name) {
    const text = String(name);
    if (isBlockOperation(text)) return OPERATIONS[text].rules;
    if (LOOKS[text]) {
      const look = LOOKS[text];
      return `look ${text}: ${look.about}. Fonts ${look.fonts.display.family} ${look.fonts.display.weight} / ${look.fonts.body.family} ${look.fonts.body.weight}; colours ${Object.entries(look.colors).map(([role, color]) => `${role} ${color}`).join(", ")}; feel ${look.feel}.`;
    }
    if (TRANSITIONS[text]) return `${text} (transition): ${TRANSITIONS[text].about}. As a beat: {recipe, …, transition:"${text}"}. On its own: recipe {name:"${text}", out:<recipe id>, in:<recipe id>, at?}.`;
    const recipe = describeRecipes().find((entry) => entry.name === text);
    if (!recipe) throw problem(`No recipe, look or block op "${text}".`, closest(text, [...RECIPE_NAMES, ...TRANSITION_NAMES, ...LOOK_NAMES, ...BLOCK_OPERATION_TYPES]));
    const example = EXAMPLES[text];
    const op = { op: "recipe", name: text, ...(example?.copy ? { copy: example.copy } : {}), ...(example?.settings ?? {}), ...(example?.media ? { media: "<an uploaded picture>" } : {}) };
    return [
      `${text} (${recipe.group}): ${recipe.about}`,
      `copy: ${Object.entries(recipe.copy).map(([key, about]) => `${key}: ${about}`).join("; ") || "none"}`,
      recipe.media ? `media: ${recipe.media === "required" ? "required" : "optional"}, an uploaded picture's ID or name` : "",
      recipe.slots && Object.keys(recipe.slots).length ? `default slot: ${Object.entries(recipe.slots).map(([shape, slot]) => `${shape} ${slot}`).join(", ")}` : "",
      `example: ${JSON.stringify(op)}`,
    ].filter(Boolean).join("\n");
  }
  const groups = {};
  for (const recipe of describeRecipes()) {
    if (recipe.group === "transition") continue;
    const fields = Object.entries(recipe.copy).map(([key, about]) => (/^required/.test(about) ? `${key}*` : key));
    (groups[recipe.group] ??= []).push(`${recipe.name}(${[...fields, ...(recipe.media === "required" ? ["media*"] : recipe.media ? ["media"] : [])].join(" ")})`);
  }
  return [
    "Building blocks. Recipes (* = required; library {topic:\"blocks\", name} has one recipe's copy limits and an example):",
    ...Object.entries(groups).map(([group, list]) => `  ${group}: ${list.join(", ")}`),
    `Transitions (a beat's transition, or recipe {name, out, in}): ${TRANSITION_NAMES.join(", ")}.`,
    `Looks: ${LOOK_NAMES.map((look) => `${look} (${LOOKS[look].about.split(":")[0]})`).join("; ")}.`,
    "Formats: 16:9, 9:16, 1:1, 4:5 or WxH. Slots: a 6×6 grid over the safe area, columns A–F and rows 1–6 (\"B2:E5\"), or " + Object.keys(NAMED_SLOTS).join(", ") + ".",
    'at: seconds, "after:<layer or animation>", "with:<…>", "cue:<name>" or "auto", each with an optional +n or -n ("after:title.in+0.2"). add_animation takes at too.',
    `Tokens: duration ${Object.keys(DURATIONS).join("|")} (e.g. duration:"standard"); easing ${Object.keys(EASING_TOKENS).join("|")} (e.g. easing:"enter" or "enter:0.8"). Feels: ${Object.keys(FEELS).join(", ")}.`,
    `Ops: ${BLOCK_OPERATION_TYPES.join(", ")} (library {topic:"blocks", name:<op>} has each one's fields).`,
  ].join("\n");
}
