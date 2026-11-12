// cut_out {sceneId, layerId, output?, engine?, grow?, feather?, color?, invert?, points?, exclude?, time?, above?, name?, refine?, fillHoles?, openEdges?} for
// the agent service: finds the subject of a video or image layer on this computer (backend/cutout,
// Apple Vision), adds the result to the media library (backend/cutout/media.mjs), and puts it in a
// new layer.
//
// The new layer is a copy of the layer (the engine's duplicateLayers: same place, size, group,
// Play settings, speed and animations, so it stays exactly over the original), with its src
// swapped by replace_media and without the original's blur and shadow. It goes right above the
// layer, or above `above`. output "subject" shows the subject on a transparent background (a
// title between the two layers looks as if it were behind the subject); "matte" is white on black
// (the bottom layer of create_mask); "silhouette" is the subject's shape in `color` (grown, below
// the subject, it is an outline). Saving, history undo, exports and the dashboard need nothing
// new: they read the layer's src like any imported file. The copy keeps the original's ID in
// cutoutOf, so frame's camera carries it with the original (it sits on the same pixels).
//
// A cut-out takes about 1.6 seconds per second of 1080p video (finding the subject about 1.2,
// writing the file the rest; measured in COMPATIBILITY.md "Subject cut-out"). An edit waits up to
// `waitSeconds` in all: cut-outs are made one at a time, so the cut_outs of one edit share one
// deadline (the agent service passes it); a cut_out reached after it still starts its cut-out but
// answers at once. A longer one keeps going in the background and the operation is refused with
// CUTOUT_RUNNING and how far it got, so the agent sends the same edit again later and gets the
// finished result at once (it is kept by the file's hash).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { aliasClipLinks } from "../../engine/clipSync.js";
import { duplicateLayers } from "../../engine/layerClipboard.js";
import { createLayer, parseDocument } from "../../engine/model.js";
import { outlinePathData, pointsBox } from "../cutout/outline.mjs";
import { presetAnimation } from "../../engine/animation.js";
import { clipShowWindow, LOST_FADE } from "../../engine/cutoutTiming.js";
import { parseFrameRate } from "../media-probe.mjs";
import { applyOperations } from "../../engine/operations.js";
import { mediaSceneTime } from "../../engine/playback.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";

const STILL_RUNNING = Symbol("still running");
// A person matte with more than this share of its pixels see-through: a silhouette on red had
// 0.155, a fast blurred dancer from the subject engine 0.11.
const PERSON_SOFT = 0.14;

// A people scan with a person or face in fewer than this share of its samples says the clip is
// mostly not filmed people (drawn, a product, a landscape). A guess (the spec's 0.5): it only
// changes which engine runs first, never what the edit may do; the second engine is the safety net.
const PEOPLE_SHARE = 0.5;

/**
 * The engines a `behind` cut-out tries, in order: [{ engine, why }]. `people` is the clip's
 * `.people-v1` scan (or null: not measured yet), `available` the cutout helper's engine list
 * ([{ engine, available }]; an engine it does not list stays). A scan with people in under half its
 * samples goes straight to the subject engine; otherwise the person engine first (filmed people),
 * then the subject engine when it finds no one.
 */
export function behindEngines({ people, available = [] } = {}) {
  const samples = Array.isArray(people?.samples) ? people.samples : [];
  const withPeople = samples.filter((sample) => sample?.people?.length || sample?.faces?.length).length;
  const drawn = samples.length > 0 && withPeople / samples.length < PEOPLE_SHARE;
  const order = drawn
    ? [{ engine: "subject", why: `the people scan found a person or face in ${withPeople} of ${samples.length} samples of the clip` }]
    : [{ engine: "person", why: samples.length ? "the people scan found people in the clip" : "the clip has no people scan yet" }, { engine: "subject", why: "the person engine found no one" }];
  const usable = order.filter((entry) => available.find((item) => item.engine === entry.engine)?.available !== false);
  // The person engine is missing here: only the subject engine is left, and the note says why.
  if (usable.length === 1 && usable[0].engine === "subject" && order.length > 1) return [{ engine: "subject", why: "the person engine is not available on this computer" }];
  return usable.length ? usable : order;
}

function within(promise, seconds) {
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(() => resolve(STILL_RUNNING), seconds * 1000); });
  return Promise.race([promise, wait]).finally(() => clearTimeout(timer));
}

// What to do when a cut-out can't be made: the plain next step for each error code.
async function nextStep(error, { engine, cutoutMedia, points }) {
  const engines = await cutoutMedia.engines().catch(() => []);
  const available = engines.filter((entry) => entry.available).map((entry) => entry.engine);
  if (error.code === "CUTOUT_ENGINE_UNAVAILABLE") {
    if (available.length) return `Send engine:"auto" (it uses ${available[0]} on this computer).`;
    // Off macOS, or a Mac whose helper says it is too old for Apple Vision, a newer Mac is the only
    // way. A Mac without a working helper (the browser development path) can build it.
    if (process.platform !== "darwin" || engines[0]?.macOS)
      return "Subject cut-out needs a Mac with macOS 13 or later (Apple Vision; any subject needs macOS 14). On this computer, mask the layer with a shape instead (create_mask).";
    // The reason already says how when the helper is not built.
    return /desktop:cutout/.test(engines[0]?.reason ?? "") ? "Then send the edit again."
      : "Build the helper (npm run desktop:cutout) or set KINO_CUTOUT_HELPER, then send the edit again.";
  }
  if (error.code === "CUTOUT_NO_SUBJECT" && points) return 'Point at an object (look mode:"source" shows the picture), or leave points out to keep every object.';
  if (error.code === "CUTOUT_NO_SUBJECT") {
    if (engine === "person" || (engine === "auto" && available[0] === "person"))
      return available.includes("subject") ? 'The person engine finds only people; send engine:"subject" for any subject.' : "The person engine finds only people (this Mac has no subject engine).";
    return "Pick a layer whose picture has a clear subject in front of its background (a person, an animal, an object).";
  }
  if (error.code === "CUTOUT_ENGINE_FAILED") return "Send the edit again; if it fails again, check that FFmpeg works (kino status shows the media tools).";
  if (error.code === "CUTOUT_NO_PICTURE") return "Pick a video or image layer whose file has a picture.";
  return null;
}

/** "about 2 minutes" for a number of seconds. */
function roughly(seconds) {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

// The receipt's picked, with seeAt: the scene seconds (sorted) where each lost or weak span's first
// frame shows on the cut-out layer, for look {mode:"frame", t}; spans Play never shows are left out.
function pickedReport(picked, layer) {
  if (!layer || !(picked.lost?.length || picked.weak?.length)) return picked;
  const starts = [...(picked.lost ?? []), ...(picked.weak ?? [])].map(([from]) => mediaSceneTime(layer, from + 0.0005))
    .filter((time) => time !== null).map((time) => Math.ceil(time * 100 - 1e-6) / 100);
  const seeAt = [...new Set(starts)].sort((a, b) => a - b);
  return seeAt.length ? { ...picked, seeAt } : picked;
}

// output "outline": a path layer of the subject's edge instead of a media copy. It takes the
// clip's place, size and turn, and the clip's animations of those (MOVE_KEYS), and its path morphs through the traced shapes at the
// scene times those frames show (custom animations of up to OUTLINE_KEYS keys each, one closed
// path per frame, so the shapes always match). Strokes, neon, taper and roughen work on it as on
// any path. Defaults: stroke color white, width 3 px (guesses).
const OUTLINE_KEYS = 48;
// Where no subject is found: the line holds its last shape this long, then fades out over
// OUTLINE_FADE_OUT, and fades back in over OUTLINE_FADE_IN when the subject is back (all guesses:
// half a second reads as the same moment, a fade under a fifth of a second as a cut).
const OUTLINE_HOLD = 0.5, OUTLINE_FADE_OUT = 0.15, OUTLINE_FADE_IN = 0.08;
// The animated values an outline takes over from its clip (place, size, turn, fade).
const MOVE_KEYS = new Set(["x", "y", "scaleX", "scaleY", "rotation", "skewX", "skewY", "opacity", "anchorX", "anchorY"]);
const PLACE_KEYS = ["parentId", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "skewY", "anchor", "opacity", "blendMode",
  "playbackWindows", "anchorX", "anchorY", "rotateX", "rotateY", "perspective"];

async function addOutlineLayer({ document, operation, scene, layer, made, reports, operationContext }) {
  const { sceneId, layerId } = operation;
  const { outline } = made;
  const scaleX = layer.width / outline.width, scaleY = layer.height / outline.height;
  const rate = parseFrameRate(outline.rate) || 30;
  // Each traced frame at the scene time Play shows it (frames Play never shows are left out); a
  // frame with no subject keeps its time, with no path.
  const sampled = outline.frames.flatMap((frame) => {
    const time = layer.type === "image" ? 0 : mediaSceneTime(layer, outline.lead + frame.index / rate);
    return time === null ? [] : [{ time: Math.round(time * 1000) / 1000, path: frame.points ? outlinePathData(frame.points, scaleX, scaleY) : null,
      box: frame.points ? pointsBox(frame.points, outline.width, outline.height) : null }];
  }).sort((a, b) => a.time - b.time).filter((shape, index, all) => index === 0 || shape.time > all[index - 1].time);
  const found = sampled.filter((shape) => shape.path);
  if (!found.length) throw new Error(`no outline could be traced for "${layer.name}": no sampled frame has a subject that Play shows.`);
  // Where no subject is found the line holds its last shape (a key just before the next found one,
  // so it does not morph across the gap), and after OUTLINE_HOLD seconds it fades out until the
  // subject is back; before the first found shape it is hidden. Study c: an outline drawn over the
  // door shot before the subject came in.
  const shapes = [], gaps = [];
  let lost = null;
  for (const shape of sampled) {
    if (!shape.path) { if (shapes.length && lost === null) lost = shape.time; continue; }
    if (lost !== null) {
      const held = Math.round((shape.time - 0.001) * 1000) / 1000;
      if (held > shapes.at(-1).time) shapes.push({ time: held, path: shapes.at(-1).path });
      gaps.push({ lost, back: shape.time });
      lost = null;
    }
    shapes.push(shape);
  }
  if (lost !== null) gaps.push({ lost, back: null });
  const empty = sampled.length - found.length;

  const outlineLayer = createLayer("path", { id: operation.cutoutId, name: operation.cutoutName, cutoutOf: layerId, allowOverlap: true,
    ...Object.fromEntries(PLACE_KEYS.filter((key) => layer[key] !== undefined).map((key) => [key, structuredClone(layer[key])])),
    path: shapes[0].path, pathBounds: { x: 0, y: 0, width: layer.width, height: layer.height }, fillEnabled: false,
    stroke: operation.color ?? "#ffffff", strokeWidth: operation.width ?? 3 });
  // The line shows only while its clip is drawn (a clip with Freeze "none" is not drawn outside Play).
  const shows = clipShowWindow(layer, scene.duration);
  if (shows) outlineLayer.playbackWindows = [...(outlineLayer.playbackWindows ?? []), shows];
  let next = parseDocument({ ...document, scenes: document.scenes.map((item) => item.id === sceneId ? { ...item, layers: [...item.layers, outlineLayer] } : item) });
  const steps = [{ type: "move_layers", sceneId, layerIds: [operation.cutoutId], position: "above", referenceId: operation.referenceId ?? layerId }];
  // One custom animation per run of shapes, each ending where the next begins.
  for (let from = 0; from < shapes.length - 1; from += OUTLINE_KEYS - 1) {
    const run = shapes.slice(from, from + OUTLINE_KEYS);
    const start = run[0].time, duration = Math.max(0.001, run.at(-1).time - start);
    steps.push({ type: "add_animation", sceneId, layerId: operation.cutoutId, animation: { kind: "custom", start, duration, easing: "linear",
      from: { path: run[0].path }, to: { path: run.at(-1).path },
      ...(run.length > 2 ? { keys: run.map((shape) => ({ t: Math.min(1, (shape.time - start) / duration), value: { path: shape.path } })) } : {}) } });
  }
  // The clip's moves (a push, a slide, a turn, its fades) go on the line too, or a pushed clip's
  // subject grows away from its outline (probe on run 6: "final" pushed 1 to 1.15, line 60 px off).
  // Its Hide and Show go on the line too (study b hid each clip with them).
  const moves = (layer.animations ?? []).filter((animation) => ["custom", "in", "out", "hide", "show"].includes(animation.kind)
    && [animation.from, animation.to, ...(animation.keys ?? []).map((key) => key.value)].every((values) => Object.keys(values ?? {}).every((key) => MOVE_KEYS.has(key))));
  for (const animation of moves) {
    const { id, ...copy } = structuredClone(animation);
    steps.push({ type: "add_animation", sceneId, layerId: operation.cutoutId, animation: copy });
  }
  // Their ids say they mark lost frames, so a retimed clip moves them too (engine/cutoutTiming.js).
  let fades = 0;
  const fade = (mode, start, duration) => ({ type: "add_animation", sceneId, layerId: operation.cutoutId,
    animation: { ...presetAnimation("preset-fade", outlineLayer, Math.max(0, Math.round(start * 1000) / 1000), scene, { mode }), duration, id: `${operation.cutoutId}.${LOST_FADE}${(fades += 1)}` } });
  if (found[0].time > sampled[0].time) steps.push(fade("in", found[0].time, OUTLINE_FADE_IN));
  const faded = [];
  for (const { lost, back } of gaps) {
    if (back !== null && back - lost <= OUTLINE_HOLD) continue;
    steps.push(fade("out", lost + OUTLINE_HOLD, OUTLINE_FADE_OUT));
    if (back !== null) steps.push(fade("in", back, OUTLINE_FADE_IN));
    faded.push(Math.round((lost + OUTLINE_HOLD) * 100) / 100);
  }
  next = parseDocument(applyOperations(next, steps, await operationContext(next, steps)));
  const notes = made.note ? [made.note] : [];
  if (empty > 0) notes.push(`no ${made.engine === "person" ? "person" : "subject"} in ${empty} of ${sampled.length} traced frames Play shows: held ${OUTLINE_HOLD} s or faded${faded.length ? ` (faded out at ${faded.join(", ")} s)` : ""}`);
  if (layer.animations?.some((animation) => animation.kind !== "effect" && !moves.includes(animation))) notes.push(`"${layer.name}" has animations the outline does not copy (only its moves, scales, turns, fades, shows and hides); add the same ones to it if they change its place`);
  const subject = subjectReport(layer, found.map(({ time, box }) => ({ time, box })), scene);
  reports?.set(operation, { engine: made.engine, output: "outline", frames: made.frames, seconds: Math.round(made.seconds * 10) / 10,
    cached: made.cached, outline: { shapes: shapes.length, step: outline.step, points: Math.max(...outline.frames.map((frame) => frame.points?.length ?? 0)) },
    ...(subject ? { subject: subject.report } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) });
  return next;
}

// The subject's box over time for the receipt, so an agent can place type beside it without a look:
// box [x, y, width, height] in scene pixels around every shown frame, at [[t, x, y, width, height]]
// at up to 4 times spread over the clip, and room {left, right, top, bottom}: the scene's pixels
// clear of the box on each side. Boxes are at the layer's own place (its animations aside). `share`
// is the same box in shares of the layer (type_covered reads it from the layer's subjectBox).
function subjectReport(layer, frames, scene) {
  const shown = frames.filter((frame) => frame.box);
  if (!shown.length) return null;
  const px = ([x0, y0, x1, y1]) => [layer.x + x0 * layer.width, layer.y + y0 * layer.height, (x1 - x0) * layer.width, (y1 - y0) * layer.height].map(Math.round);
  const share = [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...shown.map(({ box }) => box[i])));
  const picks = [...new Set([0, 1, 2, 3].map((k) => Math.round((k * (shown.length - 1)) / 3)))];
  const [x, y, width, height] = px(share);
  const room = { left: Math.max(0, x), right: Math.max(0, Math.round((scene?.width ?? 0) - x - width)), top: Math.max(0, y), bottom: Math.max(0, Math.round((scene?.height ?? 0) - y - height)) };
  return { share, report: { box: [x, y, width, height], at: picks.map((index) => [Math.round(shown[index].time * 100) / 100, ...px(shown[index].box)]), room } };
}

// Subject boxes of the matte's sampled frames (media.mjs boxes) at the scene times Play shows them.
function shownBoxes(layer, made) {
  if (!made.boxes?.frames?.length) return [];
  const rate = parseFrameRate(made.rate) || 30;
  return made.boxes.frames.flatMap(({ index, box }) => {
    const time = layer.type === "image" ? 0 : mediaSceneTime(layer, (made.lead ?? 0) + index / rate);
    return time === null ? [] : [{ time, box }];
  }).sort((a, b) => a.time - b.time);
}

/**
 * Runs one cut_out operation on `document` (as the operations before it in the edit left it) and
 * returns the new document. Options: mediaRoot, cutoutMedia (createCutoutMedia), operationContext
 * (as for applyOperations), reports (the edit's report Map: this adds the receipt's `cutout`),
 * waitSeconds (how long to wait for a cut-out still being made; default 50) or deadline (the
 * performance.now() time to stop waiting, shared by the cut_outs of one edit; it replaces
 * waitSeconds), graceSeconds (past that, how long to keep waiting for one whose progress says it
 * is that close to done; default 0, the server passes 30). Refusals are thrown as errors; a cut-out error says what to send instead and
 * carries its code as `cutoutError`.
 */
export async function runCutOut(document, operation, options) {
  if (!operation.optional) return cutOut(document, operation, options);
  // A cut-out a move asked for on its own (translate.mjs moveCutouts, subject left out): with no
  // engine on this computer or no subject in the clip, the edit goes on without it and the move
  // falls back (backdrop-flash tints the shot), so the move still works where cut_out cannot.
  try {
    return await cutOut(document, operation, options);
  } catch (error) {
    if (!cutoutMediaMissing(error) && !["CUTOUT_ENGINE_UNAVAILABLE", "CUTOUT_NO_SUBJECT"].includes(error.cutoutError ?? error.code)) throw error;
    options.reports?.set(operation, { output: operation.output ?? "subject", fallback: `no cut-out made (${error.message.split(".")[0]}); the move goes on without it` });
    return document;
  }
}

/** The clip's effects a cut-out made for a move's own frames leaves out (see cutOut). */
export const MOVE_DROPS = Object.freeze(["glow", "tritone", "duotone"]);

const cutoutMediaMissing =(error) => /cut-out is not set up/.test(error?.message ?? "");

async function cutOut(document, operation, { mediaRoot, cutoutMedia, operationContext, reports, waitSeconds = 50, deadline, graceSeconds = 0 }) {
  const { sceneId, layerId } = operation;
  // behind: the engine follows the clip's people scan (behindEngines below), and the text moves
  // right above the clip first. points pick among the subject engine's objects, so they need it.
  const output = operation.output ?? "subject";
  const own = operation.engine ?? (operation.points ? "subject" : operation.behindText ? null : "auto");
  const scene = document.scenes.find((item) => item.id === sceneId);
  const layer = scene?.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`No layer "${layerId}" in this scene.`);
  if (layer.type !== "video" && layer.type !== "image")
    throw new Error(`cut_out finds the subject of a video or image layer, and "${layer.name}" is a ${layer.type} layer.`);
  if (!cutoutMedia) throw new Error("subject cut-out is not set up in this kino service.");
  const id = mediaIdFromSource(layer.src);
  const file = id && mediaRoot ? path.join(mediaRoot, id) : null;
  if (!file || !existsSync(file))
    throw new Error("the layer's picture is not in kino's media library; import the file with project {action:\"import\", file} and use its src.");
  let record = {};
  try { record = JSON.parse(await readFile(`${file}.json`, "utf8")); } catch {}
  const mime = typeof record.mime === "string" ? record.mime : layer.type === "video" ? (id.endsWith(".webm") ? "video/webm" : "video/mp4") : "image/png";
  if (mime === "image/svg+xml")
    throw new Error(`"${layer.name}" is an SVG drawing: its shapes already have their own transparency, so there is no photo to cut out.`);
  if (mime === "image/gif" && (record.animated === true || Number(record.frameCount) > 1))
    throw new Error(`"${layer.name}" is an animated GIF; cut_out works on videos and still images. Import the clip as MP4 or WebM.`);

  // grow and feather are in the layer's own pixels (as drawn at scale 1); the file may be larger.
  const fileWidth = Number(record.width) || layer.width, fileHeight = Number(record.height) || layer.height;
  const perLayerPixel = Math.sqrt((fileWidth / Math.max(1, layer.width)) * (fileHeight / Math.max(1, layer.height)));
  const inFilePixels = (value) => Math.round((value ?? 0) * perLayerPixel * 100) / 100;
  // behind with no engine or points of the agent's own: read the clip's people scan (one small file,
  // nothing decoded) and the helper's engine list to order the engines to try.
  let engines = [{ engine: own }];
  if (!own) {
    let people = null;
    try { people = JSON.parse(await readFile(`${file}.people-v1`, "utf8")); } catch {}
    const listed = await cutoutMedia.engines().catch(() => []);
    engines = behindEngines({ people, available: listed });
  }
  const startWith = (engine) => cutoutMedia.start({ file, name: typeof record.name === "string" ? record.name : layer.name,
    ...(output === "outline" ? { outline: { step: operation.step, points: operation.detail } } : {}),
    kind: layer.type === "video" ? "video" : "image", output, engine,
    grow: inFilePixels(operation.grow), feather: inFilePixels(operation.feather),
    color: operation.color ?? "#ffffff", invert: operation.invert === true,
    // A subject cut by the frame reaches the border ("extend") by default; a silhouette or matte,
    // the base of a glow or outline, fades there so it does not trace the border (GAPS item 14:
    // the fade left a pale strip under contest-b's figure).
    openEdges: typeof operation.openEdges === "number" ? inFilePixels(operation.openEdges) : operation.openEdges ?? (output === "subject" ? "extend" : "fade"),
    // edge "auto" (the subject's default): crisp on drawn footage, the refined soft edge on camera footage.
    edge: operation.edge ?? (output === "subject" ? "auto" : "soft"),
    ...(operation.refine !== undefined || operation.fillHoles !== undefined
      ? { clean: { refine: typeof operation.refine === "number" ? inFilePixels(operation.refine) : operation.refine, holes: operation.fillHoles } } : {}),
    ...(operation.points ? { pick: { points: operation.points, ...(operation.exclude ? { exclude: operation.exclude } : {}), ...(layer.type === "video" && operation.time !== undefined ? { time: operation.time } : {}) } } : {}) });

  // Past the deadline the job is still started (or joined), so it is made while the agent waits.
  // The engines of one cut-out share that one wait.
  const stopAt = deadline === undefined ? performance.now() + waitSeconds * 1000 : deadline;
  let made = null, job, engine = engines[0].engine, lastError = null;
  const tried = [];
  let extraStart = 0, extraSeconds = 0;
  for (let index = 0; index < engines.length; index += 1) {
    engine = engines[index].engine;
    const last = index === engines.length - 1;
    if (index > 0) extraStart = performance.now();
    job = startWith(engine);
    tried.push(engine);
    let result;
    try {
      result = await within(job.done, Math.max(0, (stopAt - performance.now()) / 1000));
      // A cut-out that says it is within graceSeconds of done is waited for here instead of asking
      // for a resend (study c: refused at 50 s with "about 10 seconds" left).
      if (result === STILL_RUNNING && graceSeconds > 0) {
        const { fraction, seconds } = job.progress();
        const more = fraction > 0.02 ? seconds / fraction - seconds : Infinity;
        if (more <= graceSeconds) result = await within(job.done, graceSeconds);
      }
    } catch (error) {
      // This engine found no one: the next one tries (behind only), else it is the error below.
      if (error.code === "CUTOUT_NO_SUBJECT" && !last) { lastError = error; if (index > 0) extraSeconds += (performance.now() - extraStart) / 1000; continue; }
      if (error.code === "CUTOUT_NO_SUBJECT" && made) break;
      // behind with no subject anywhere in the clip: the text stays in front, and the receipt says so.
      if (operation.behindText && error.code === "CUTOUT_NO_SUBJECT") {
        const text = scene.layers.find((item) => item.id === operation.referenceId);
        reports?.set(operation, { engine, ...(tried.length > 1 ? { tried } : {}), behind: text?.name ?? operation.referenceId,
          fallback: `no ${own ? (own === "person" ? "person" : "subject") : "person or subject"} was found in "${layer.name}", so "${text?.name ?? "the text"}" stays in front` });
        return document;
      }
      const said = error.code === "CUTOUT_NO_SUBJECT" ? `${error.message.replace(/\.$/, "")} of "${layer.name}".` : error.message;
      const next = await nextStep(error, { engine, cutoutMedia, points: !!operation.points });
      throw Object.assign(new Error(next ? `${said} ${next}` : said), error.code ? { cutoutError: error.code } : {});
    }
    if (result === STILL_RUNNING) { made = STILL_RUNNING; break; }
    if (index > 0) extraSeconds += (performance.now() - extraStart) / 1000;
    // Mostly empty (over half the frames): the next engine may do better; keep the fuller one.
    if (!last && result.empty > result.frames / 2) { if (!made || result.empty < made.empty) made = result; continue; }
    if (made && made !== STILL_RUNNING && made.empty <= result.empty) break;
    made = result;
    break;
  }
  if (made === STILL_RUNNING) {
    const { fraction, seconds } = job.progress();
    const left = fraction > 0.02 ? seconds / fraction - seconds : null;
    throw Object.assign(new Error(`the cut-out of "${layer.name}" is still being made (${Math.floor(fraction * 100)}% done${left ? `, ${roughly(left)} left` : ""}); nothing was changed. Send the same edit again${left ? ` in ${roughly(left)}` : " in a minute"}: the finished cut-out is kept, so it then answers at once.`),
      { cutoutError: "CUTOUT_RUNNING" });
  }

  if (output === "outline") return addOutlineLayer({ document, operation, scene, layer, made, reports, operationContext });

  // A copy of the layer right above it, then its new file, name and look.
  const copied = duplicateLayers(document, sceneId, [layerId]);
  const copy = copied.document.scenes.find((item) => item.id === sceneId).layers.find((item) => item.id === copied.rootIds[0]);
  copy.id = operation.cutoutId;
  copy.cutoutOf = layerId;
  // Which output it shows, so a move that needs the subject reuses this one (translate.mjs moveCutouts).
  copy.cutoutOutput = output;
  // The subject's measured box (shares of the layer, around every shown frame): type_covered
  // judges type behind the cut-out by it instead of by the whole layer box.
  const subject = output === "matte" ? null : subjectReport(layer, shownBoxes(layer, made), scene);
  if (subject) copy.subjectBox = subject.share;
  // Made by a move for its own frames (translate.mjs moveCutouts, field cutout.own): the copy keeps
  // the clip's other effects (curves, color) but not its glow or its one-hue grade (tritone,
  // duotone); the move puts its own tone on the subject or the clip's grade back (backdrop-flash
  // tone). grade-bloom-flash study: the subject had the clip's curves and its own tritone, no glow;
  // with the clip's glow and tritone copied too, the face was drawn blown to one white.
  if (operation.forMove) {
    copy.cutoutFor = operation.forMove;
    copy.animations = (copy.animations ?? []).filter((animation) => !(animation.kind === "effect" && MOVE_DROPS.includes(animation.effect)));
  }
  // Any subject cut-out leaves the clip's glow on the clip, so the glow sits behind the subject
  // instead of blooming the face (run 8: threshold 0.1 turned the face flat; the human edits' halo
  // sits behind the head, .scratch/run8/trace/effects.md section 3). Add a glow to the cut-out to bloom it too.
  const glowKept = output === "subject" && !operation.forMove && (copy.animations ?? []).some((animation) => animation.kind === "effect" && animation.effect === "glow");
  if (glowKept) copy.animations = copy.animations.filter((animation) => !(animation.kind === "effect" && animation.effect === "glow"));
  let next = parseDocument(copied.document);
  const steps = [
    { type: "replace_media", sceneId, layerId: operation.cutoutId, mediaId: made.record.id },
    // A subject or silhouette is transparent around the subject, but the quality check sees layer
    // boxes, so it would call every title behind a subject hidden: allowOverlap says it is on purpose.
    // Only a subject keeps the clip's own pixels, so only it keeps the log conversion; a
    // silhouette's color and a matte's grays are kino's own.
    { type: "update_layer", sceneId, layerId: operation.cutoutId, properties: { name: operation.cutoutName, blur: 0, shadow: null, isMask: false,
      log: output === "subject" ? layer.log ?? null : null,
      ...(output === "matte" ? {} : { allowOverlap: true }) } },
    // behind: the text right above the clip, so nothing else ends up between it and the person.
    ...(operation.behindText ? [{ type: "move_layers", sceneId, layerIds: [operation.referenceId], position: "above", referenceId: layerId }] : []),
    ...(operation.referenceId ? [{ type: "move_layers", sceneId, layerIds: [operation.cutoutId], position: "above", referenceId: operation.referenceId }] : []),
  ];
  next = parseDocument(applyOperations(next, steps, await operationContext(next, steps)));
  // The cut-out keeps the original's timing, so it keeps its sync links (out_of_sync).
  aliasClipLinks(next, layer.src, next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === operation.cutoutId)?.src);

  const notes = made.note ? [made.note] : [];
  // Which engine behind used and why (the receipt states the engine kept, and the time of any extra pass).
  if (!own && operation.behindText) {
    const first = engines[0];
    if (tried.length === 1 && first.engine === "subject") notes.push(`behind used the subject engine: ${first.why.replace(/ of the clip$/, ` of "${layer.name}"`)}`);
    else if (tried.length > 1 && made.engine !== tried[0])
      notes.push(`the ${tried[0]} engine found no one in "${layer.name}" (or in over half its frames); behind used the ${made.engine} engine (one more pass, ${Math.round(extraSeconds * 10) / 10} s)`);
    else if (tried.length > 1) notes.push(`the ${tried[1]} engine found no more in "${layer.name}" than the ${tried[0]} engine, so behind kept the ${tried[0]} matte`);
  }
  // The person engine can leave a silhouette or a dark figure half see-through (gray over a title
  // behind it); the subject engine gives it a solid body.
  if (made.engine === "person" && made.soft > PERSON_SOFT) notes.push(`${Math.round(made.soft * 100)}% of the person is see-through (a silhouette or a dark figure?): engine:"subject" may give a solid one`);
  if (made.empty > 0) notes.push(`no ${made.engine === "person" ? "person" : "subject"} was found in ${made.empty} of ${made.frames} frames; the layer is empty there`);
  if (glowKept) notes.push(`the glow on "${layer.name}" now sits behind the subject (the cut-out has none); add a glow to "${operation.cutoutName}" to bloom the subject too`);
  const picked = made.picked && pickedReport(made.picked, next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === operation.cutoutId));
  if (picked?.lost?.length) notes.push(`the picked object is lost in ${picked.lost.length} span(s) of the file (picked.lost)${picked.seeAt ? "; look at the times in picked.seeAt" : ""}`);
  reports?.set(operation, { engine: made.engine, output, frames: made.frames, seconds: Math.round(made.seconds * 10) / 10,
    cached: made.cached, ...(tried.length > 1 ? { tried } : {}), ...(subject ? { subject: subject.report } : {}), ...(picked ? { picked } : {}), ...(operation.behindText ? { behind: next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === operation.referenceId)?.name } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) });
  return next;
}
