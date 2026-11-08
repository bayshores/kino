// Optional fields that tell the quality checker (engine/quality/) what a layer or video is for.
// None of them change how anything draws. A document without them still opens and renders the same.
//
// Layer:
//   role          what the layer is: headline, subhead, body, caption, cta, label (small UI text on a plate or
//                 tag), logo, hero, decor, background, ui (the product's own readable text: UI labels,
//                 rows, small captions in its words)
//                 (decor and background are skipped by the text-size and overlap checks; ui keeps the
//                 contrast check but skips type_min, reading_time and hold)
//   perpetual     true for a layer that moves the whole time on purpose (a looping background)
//   allowOverlap  true when this layer may cover or touch other text on purpose
// Document:
//   videoType     promo, ad, clip, explainer, sting or other (sets the length and pacing checks)
//   rhythm        {bpm, offset}: the music beat, so the checker can compare motion to it
//   checkWaivers  [{code, target, reason}]: a check finding the author accepted on purpose
//   cues          [{name, time, kind}]: named moments in seconds that timing can point at ("cue:drop").
//                 kind is marker (placed by hand), beat or onset (found in the music), word or line
//                 (from a voice-over or caption file). Kept sorted by time. A cue with {layer,
//                 media} is pinned to that clip's footage: time follows the clip (footageCues.js).
//   clipLinks     [{a, b, lag, confidence?}]: files (media src) recorded together, a at t = b at
//                 t + lag seconds; sync_clips writes them (clipSync.js), out_of_sync reads them
// Scene:
//   assertions    promises the checker holds the scene to (a recipe adds its own):
//                 {type: "visible_by", target, time}   the layer is fully shown by `time` seconds
//                 {type: "before", target, other}       the layer appears before layer `other`
//                 {type: "inside_frame", target}        the layer never leaves the frame
//                 Each may carry a `note` (up to 200 characters), such as the recipe it came from.
//   rests         [{at, until}]: planned stills in scene seconds (a held end mark, a beat of black).
//                 held_static and static_scene skip them (4 s in all per scene), and no drift or push is added there.
import { MAX_MEDIA_SECONDS } from "./schema.js";
import { FOOTAGE_CUE_TYPES, footageCueTime } from "./footageCues.js";
import { round } from "./numbers.js";

export const LAYER_ROLES = ["headline", "subhead", "body", "caption", "cta", "label", "logo", "hero", "decor", "background", "ui"];
export const VIDEO_TYPES = ["promo", "ad", "clip", "explainer", "sting", "other"];
export const MAX_WAIVERS = 200;
export const MAX_ASSERTIONS = 100;
export const ASSERTION_TYPES = ["visible_by", "before", "inside_frame"];
export const CUE_KINDS = ["marker", "beat", "onset", "word", "line"];
export const MAX_CUES = 5000;
export const MAX_CLIP_LINKS = 100;
export const MAX_RESTS = 20;

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
const TARGET_PATTERN = /^(\*|[a-zA-Z0-9._:-]{1,128})$/;
const CUE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const LAYER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

function fail(path, message) {
  throw new Error(`${path} ${message}.`);
}

function optionalBoolean(record, key, path) {
  if (record[key] === undefined || record[key] === false) {
    delete record[key];
    return;
  }
  if (record[key] !== true) fail(`${path}.${key}`, "must be true or false");
}

/** Checks a layer's role, perpetual and allowOverlap. Unset or false values are removed. */
export function normalizeQualityLayerFields(layer, path) {
  if (layer.role === undefined || layer.role === null || layer.role === "") delete layer.role;
  else if (!LAYER_ROLES.includes(layer.role)) fail(`${path}.role`, `must be one of ${LAYER_ROLES.join(", ")}`);
  optionalBoolean(layer, "perpetual", path);
  optionalBoolean(layer, "allowOverlap", path);
}

/** Checks a document's videoType, rhythm, checkWaivers, cues and clipLinks. Unset values are removed. */
export function normalizeQualityDocumentFields(document, maxTime) {
  if (document.videoType === undefined || document.videoType === null || document.videoType === "") delete document.videoType;
  else if (!VIDEO_TYPES.includes(document.videoType)) fail("document.videoType", `must be one of ${VIDEO_TYPES.join(", ")}`);

  if (document.rhythm === undefined || document.rhythm === null) delete document.rhythm;
  else {
    const rhythm = document.rhythm;
    if (typeof rhythm !== "object" || Array.isArray(rhythm)) fail("document.rhythm", "must be {bpm, offset}");
    const bpm = rhythm.bpm;
    const offset = rhythm.offset ?? 0;
    if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < 30 || bpm > 300) fail("document.rhythm.bpm", "must be a number from 30 to 300");
    if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > maxTime) fail("document.rhythm.offset", `must be a number of seconds from 0 to ${maxTime}`);
    document.rhythm = { bpm, offset };
  }

  if (document.checkWaivers === undefined || document.checkWaivers === null) delete document.checkWaivers;
  else {
    if (!Array.isArray(document.checkWaivers) || document.checkWaivers.length > MAX_WAIVERS)
      fail("document.checkWaivers", `must be a list of at most ${MAX_WAIVERS} waivers`);
    const seen = new Set();
    document.checkWaivers = document.checkWaivers.map((waiver, index) => {
      const path = `document.checkWaivers[${index}]`;
      if (!waiver || typeof waiver !== "object" || Array.isArray(waiver)) fail(path, "must be {code, target, reason}");
      if (typeof waiver.code !== "string" || !CODE_PATTERN.test(waiver.code)) fail(`${path}.code`, "must be a check rule name such as reading_time");
      if (typeof waiver.target !== "string" || !TARGET_PATTERN.test(waiver.target)) fail(`${path}.target`, "must be a layer ID, a scene ID or *");
      if (typeof waiver.reason !== "string" || !waiver.reason.trim() || waiver.reason.length > 500) fail(`${path}.reason`, "must say why, in 1 to 500 characters");
      const key = `${waiver.code} ${waiver.target}`;
      if (seen.has(key)) fail(path, `repeats the waiver for ${waiver.code} on ${waiver.target}`);
      seen.add(key);
      return { code: waiver.code, target: waiver.target, reason: waiver.reason.trim() };
    });
    if (!document.checkWaivers.length) delete document.checkWaivers;
  }

  if (document.cues === undefined || document.cues === null) delete document.cues;
  else {
    if (!Array.isArray(document.cues) || document.cues.length > MAX_CUES) fail("document.cues", `must be a list of at most ${MAX_CUES} cues`);
    const names = new Set();
    document.cues = document.cues.map((cue, index) => {
      const path = `document.cues[${index}]`;
      if (!cue || typeof cue !== "object" || Array.isArray(cue)) fail(path, "must be {name, time, kind}");
      if (typeof cue.name !== "string" || !CUE_NAME_PATTERN.test(cue.name)) fail(`${path}.name`, "must be 1 to 64 letters, digits, dots, dashes or underscores");
      if (names.has(cue.name)) fail(`${path}.name`, `repeats the cue name ${cue.name}`);
      names.add(cue.name);
      const pin = footagePin(document, cue, path, maxTime);
      const time = pin?.time ?? cue.time;
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > maxTime) fail(`${path}.time`, `must be a number of seconds from 0 to ${maxTime}`);
      const kind = cue.kind ?? "marker";
      if (!CUE_KINDS.includes(kind)) fail(`${path}.kind`, `must be one of ${CUE_KINDS.join(", ")}`);
      return pin ? { name: cue.name, time, kind, layer: pin.layer, media: pin.media } : { name: cue.name, time, kind };
    }).sort((a, b) => a.time - b.time);
    if (!document.cues.length) delete document.cues;
  }
  normalizeClipLinks(document);
}

// A footage cue {layer, media} (footageCues.js): its time again from the clip as it is now. A clip
// that is gone or no longer footage leaves a plain cue at its last time; an animated speed keeps
// the last time too (set_cue refuses one, but a later edit may add it).
function footagePin(document, cue, path, maxTime) {
  if (cue.layer === undefined && cue.media === undefined) return null;
  if (typeof cue.layer !== "string" || !LAYER_ID_PATTERN.test(cue.layer)) fail(`${path}.layer`, "must be the ID of a video or audio layer");
  if (typeof cue.media !== "number" || !Number.isFinite(cue.media) || cue.media < 0 || cue.media > MAX_MEDIA_SECONDS)
    fail(`${path}.media`, `must be seconds into the clip's file, from 0 to ${MAX_MEDIA_SECONDS}`);
  let placed;
  try { placed = footageCueTime(document, cue.layer, cue.media); } catch { placed = null; }
  const layer = document.scenes?.flatMap((scene) => scene.layers ?? []).find((item) => item.id === cue.layer);
  if (!layer || !FOOTAGE_CUE_TYPES.includes(layer.type)) return null;
  const time = placed ? Math.min(maxTime, Math.max(0, round(placed.time))) : cue.time;
  // The cue moves to the piece of a split clip that shows its moment.
  return { layer: placed?.layer.id ?? cue.layer, media: cue.media, time };
}

// A media src (/api/media/<id>.mp4 or a file path): any text up to 2048 characters.
const isSrc = (value) => typeof value === "string" && value.length > 0 && value.length <= 2048;

// A lag is a difference between two file times, so it is bounded by the media limit, not the scene's.
function normalizeClipLinks(document) {
  if (document.clipLinks === undefined || document.clipLinks === null) return void delete document.clipLinks;
  if (!Array.isArray(document.clipLinks) || document.clipLinks.length > MAX_CLIP_LINKS)
    fail("document.clipLinks", `must be a list of at most ${MAX_CLIP_LINKS} links`);
  document.clipLinks = document.clipLinks.map((link, index) => {
    const path = `document.clipLinks[${index}]`;
    if (!link || typeof link !== "object" || Array.isArray(link)) fail(path, "must be {a, b, lag, confidence?}");
    if (!isSrc(link.a) || !isSrc(link.b) || link.a === link.b) fail(path, "must name two different files as a and b");
    if (typeof link.lag !== "number" || !Number.isFinite(link.lag) || Math.abs(link.lag) > MAX_MEDIA_SECONDS) fail(`${path}.lag`, `must be a number of seconds from -${MAX_MEDIA_SECONDS} to ${MAX_MEDIA_SECONDS}`);
    if (link.confidence !== undefined && !(typeof link.confidence === "number" && link.confidence >= 0 && link.confidence <= 1)) fail(`${path}.confidence`, "must be a number from 0 to 1");
    return { a: link.a, b: link.b, lag: link.lag, ...(link.confidence !== undefined ? { confidence: link.confidence } : {}) };
  });
  if (!document.clipLinks.length) delete document.clipLinks;
}

/** Checks a scene's rests [{at, until}] (planned stills). An empty list is removed. */
function normalizeRests(scene, path, maxTime) {
  if (scene.rests === undefined || scene.rests === null) {
    delete scene.rests;
    return;
  }
  if (!Array.isArray(scene.rests) || scene.rests.length > MAX_RESTS) fail(`${path}.rests`, `must be a list of at most ${MAX_RESTS} {at, until}`);
  scene.rests = scene.rests.map((rest, index) => {
    const at = `${path}.rests[${index}]`;
    if (!rest || typeof rest !== "object" || Array.isArray(rest)) fail(at, "must be {at, until} in scene seconds");
    for (const key of ["at", "until"])
      if (typeof rest[key] !== "number" || !Number.isFinite(rest[key]) || rest[key] < 0 || rest[key] > maxTime) fail(`${at}.${key}`, `must be a number of seconds from 0 to ${maxTime}`);
    if (rest.until <= rest.at) fail(`${at}.until`, "must be after at");
    return { at: rest.at, until: rest.until };
  }).sort((a, b) => a.at - b.at);
  scene.rests.forEach((rest, index) => {
    if (index && rest.at <= scene.rests[index - 1].until) fail(`${path}.rests`, "must not overlap or touch: leave a gap between one rest's until and the next at");
  });
  if (!scene.rests.length) delete scene.rests;
}

/** Checks a scene's assertions and rests. An empty list is removed. */
export function normalizeQualitySceneFields(scene, path, maxTime) {
  normalizeRests(scene, path, maxTime);
  if (scene.assertions === undefined || scene.assertions === null) {
    delete scene.assertions;
    return;
  }
  if (!Array.isArray(scene.assertions) || scene.assertions.length > MAX_ASSERTIONS)
    fail(`${path}.assertions`, `must be a list of at most ${MAX_ASSERTIONS} assertions`);
  scene.assertions = scene.assertions.map((assertion, index) => {
    const at = `${path}.assertions[${index}]`;
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) fail(at, "must be {type, target, …}");
    if (!ASSERTION_TYPES.includes(assertion.type)) fail(`${at}.type`, `must be one of ${ASSERTION_TYPES.join(", ")}`);
    if (typeof assertion.target !== "string" || !LAYER_ID_PATTERN.test(assertion.target)) fail(`${at}.target`, "must be a layer ID");
    const clean = { type: assertion.type, target: assertion.target };
    if (assertion.type === "visible_by") {
      if (typeof assertion.time !== "number" || !Number.isFinite(assertion.time) || assertion.time < 0 || assertion.time > maxTime)
        fail(`${at}.time`, `must be a number of seconds from 0 to ${maxTime}`);
      clean.time = assertion.time;
    }
    if (assertion.type === "before") {
      if (typeof assertion.other !== "string" || !LAYER_ID_PATTERN.test(assertion.other)) fail(`${at}.other`, "must be a layer ID");
      if (assertion.other === assertion.target) fail(`${at}.other`, "must be a different layer from target");
      clean.other = assertion.other;
    }
    if (assertion.note !== undefined) {
      if (typeof assertion.note !== "string" || assertion.note.length > 200) fail(`${at}.note`, "must be text of up to 200 characters");
      if (assertion.note.trim()) clean.note = assertion.note.trim();
    }
    return clean;
  });
  if (!scene.assertions.length) delete scene.assertions;
}
