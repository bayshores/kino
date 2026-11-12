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
import { outlinePathData } from "../cutout/outline.mjs";
import { parseFrameRate } from "../media-probe.mjs";
import { applyOperations } from "../../engine/operations.js";
import { mediaSceneTime } from "../../engine/playback.js";
import { mediaIdFromSource } from "../../engine/replaceMedia.js";

const STILL_RUNNING = Symbol("still running");
// A person matte with more than this share of its pixels see-through: a silhouette on red had
// 0.155, a fast blurred dancer from the subject engine 0.11.
const PERSON_SOFT = 0.14;

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
// clip's place, size and turn (not its animations: a clip that is scaled or moved by an animation
// needs the same one added to the outline), and its path morphs through the traced shapes at the
// scene times those frames show (custom animations of up to OUTLINE_KEYS keys each, one closed
// path per frame, so the shapes always match). Strokes, neon, taper and roughen work on it as on
// any path. Defaults: stroke color white, width 3 px (guesses).
const OUTLINE_KEYS = 48;
const PLACE_KEYS = ["parentId", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "skewY", "anchor", "opacity", "blendMode",
  "playbackWindows", "anchorX", "anchorY", "rotateX", "rotateY", "perspective"];

async function addOutlineLayer({ document, operation, scene, layer, made, reports, operationContext }) {
  const { sceneId, layerId } = operation;
  const { outline } = made;
  const scaleX = layer.width / outline.width, scaleY = layer.height / outline.height;
  const rate = parseFrameRate(outline.rate) || 30;
  // Each traced frame at the scene time Play shows it; frames Play never shows or with no subject are left out.
  let empty = 0;
  const shapes = outline.frames.flatMap((frame) => {
    if (!frame.points) { empty += 1; return []; }
    const time = layer.type === "image" ? 0 : mediaSceneTime(layer, outline.lead + frame.index / rate);
    return time === null ? [] : [{ time: Math.round(time * 1000) / 1000, path: outlinePathData(frame.points, scaleX, scaleY) }];
  }).sort((a, b) => a.time - b.time).filter((shape, index, all) => index === 0 || shape.time > all[index - 1].time);
  if (!shapes.length) throw new Error(`no outline could be traced for "${layer.name}": no sampled frame has a subject that Play shows.`);

  const outlineLayer = createLayer("path", { id: operation.cutoutId, name: operation.cutoutName, cutoutOf: layerId, allowOverlap: true,
    ...Object.fromEntries(PLACE_KEYS.filter((key) => layer[key] !== undefined).map((key) => [key, structuredClone(layer[key])])),
    path: shapes[0].path, pathBounds: { x: 0, y: 0, width: layer.width, height: layer.height }, fillEnabled: false,
    stroke: operation.color ?? "#ffffff", strokeWidth: operation.width ?? 3 });
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
  next = parseDocument(applyOperations(next, steps, await operationContext(next, steps)));
  const notes = made.note ? [made.note] : [];
  if (made.empty > 0) notes.push(`no ${made.engine === "person" ? "person" : "subject"} was found in ${made.empty} of ${made.frames} frames; their outline holds the shape before it`);
  if (empty > 0) notes.push(`${empty} sampled frame(s) had no subject and were skipped`);
  if (layer.animations?.some((animation) => animation.kind !== "effect")) notes.push(`"${layer.name}" has animations that move or scale it; the outline layer does not copy them, so add the same ones to it`);
  reports?.set(operation, { engine: made.engine, output: "outline", frames: made.frames, seconds: Math.round(made.seconds * 10) / 10,
    cached: made.cached, outline: { shapes: shapes.length, step: outline.step, points: Math.max(...outline.frames.map((frame) => frame.points?.length ?? 0)) },
    ...(notes.length ? { note: notes.join("; ") } : {}) });
  return next;
}

/**
 * Runs one cut_out operation on `document` (as the operations before it in the edit left it) and
 * returns the new document. Options: mediaRoot, cutoutMedia (createCutoutMedia), operationContext
 * (as for applyOperations), reports (the edit's report Map: this adds the receipt's `cutout`),
 * waitSeconds (how long to wait for a cut-out still being made; default 50) or deadline (the
 * performance.now() time to stop waiting, shared by the cut_outs of one edit; it replaces
 * waitSeconds). Refusals are thrown as errors; a cut-out error says what to send instead and
 * carries its code as `cutoutError`.
 */
export async function runCutOut(document, operation, { mediaRoot, cutoutMedia, operationContext, reports, waitSeconds = 50, deadline }) {
  const { sceneId, layerId } = operation;
  // behind: a person matte by default, and the text moves right above the clip first (below).
  // points pick among the subject engine's objects, so they need it.
  const output = operation.output ?? "subject", engine = operation.engine ?? (operation.points ? "subject" : operation.behindText ? "person" : "auto");
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
  const job = cutoutMedia.start({ file, name: typeof record.name === "string" ? record.name : layer.name,
    ...(output === "outline" ? { outline: { step: operation.step, points: operation.detail } } : {}),
    kind: layer.type === "video" ? "video" : "image", output, engine,
    grow: inFilePixels(operation.grow), feather: inFilePixels(operation.feather),
    color: operation.color ?? "#ffffff", invert: operation.invert === true,
    openEdges: typeof operation.openEdges === "number" ? inFilePixels(operation.openEdges) : operation.openEdges ?? "fade",
    ...(operation.refine !== undefined || operation.fillHoles !== undefined
      ? { clean: { refine: typeof operation.refine === "number" ? inFilePixels(operation.refine) : operation.refine, holes: operation.fillHoles } } : {}),
    ...(operation.points ? { pick: { points: operation.points, ...(operation.exclude ? { exclude: operation.exclude } : {}), ...(layer.type === "video" && operation.time !== undefined ? { time: operation.time } : {}) } } : {}) });

  // Past the deadline the job is still started (or joined), so it is made while the agent waits.
  const left = deadline === undefined ? waitSeconds : Math.max(0, (deadline - performance.now()) / 1000);
  let made;
  try {
    made = await within(job.done, left);
  } catch (error) {
    // behind with no person anywhere in the clip: the text stays in front, and the receipt says so.
    if (operation.behindText && error.code === "CUTOUT_NO_SUBJECT") {
      const text = scene.layers.find((item) => item.id === operation.referenceId);
      reports?.set(operation, { engine, behind: text?.name ?? operation.referenceId, fallback: `no person was found in "${layer.name}", so "${text?.name ?? "the text"}" stays in front` });
      return document;
    }
    const said = error.code === "CUTOUT_NO_SUBJECT" ? `${error.message.replace(/\.$/, "")} of "${layer.name}".` : error.message;
    const next = await nextStep(error, { engine, cutoutMedia, points: !!operation.points });
    throw Object.assign(new Error(next ? `${said} ${next}` : said), error.code ? { cutoutError: error.code } : {});
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
  // The person engine can leave a silhouette or a dark figure half see-through (gray over a title
  // behind it); the subject engine gives it a solid body.
  if (made.engine === "person" && made.soft > PERSON_SOFT) notes.push(`${Math.round(made.soft * 100)}% of the person is see-through (a silhouette or a dark figure?): engine:"subject" may give a solid one`);
  if (made.empty > 0) notes.push(`no ${made.engine === "person" ? "person" : "subject"} was found in ${made.empty} of ${made.frames} frames; the layer is empty there`);
  const picked = made.picked && pickedReport(made.picked, next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === operation.cutoutId));
  if (picked?.lost?.length) notes.push(`the picked object is lost in ${picked.lost.length} span(s) of the file (picked.lost)${picked.seeAt ? "; look at the times in picked.seeAt" : ""}`);
  reports?.set(operation, { engine: made.engine, output, frames: made.frames, seconds: Math.round(made.seconds * 10) / 10,
    cached: made.cached, ...(picked ? { picked } : {}), ...(operation.behindText ? { behind: next.scenes.find((item) => item.id === sceneId)?.layers.find((item) => item.id === operation.referenceId)?.name } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) });
  return next;
}
