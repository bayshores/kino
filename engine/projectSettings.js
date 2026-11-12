// Edits to project-wide settings: update_project, waive_check and unwaive_check.
// parseDocument (qualityFields.js) checks the values after every edit.
import { MAX_WAIVERS } from "./qualityFields.js";
import { onFrame, readFps } from "./frameRate.js";

// What update_project may change. checkWaivers has its own operations.
const PROJECT_PROPERTIES = new Set(["name", "videoType", "rhythm", "fps", "shutterAngle"]);

/**
 * The project's shutter in degrees (update_project {shutterAngle}): 0 to 360, 180 is half a frame
 * open. Missing means off for look and drafts, as before it existed; finals keep their own 180.
 * Checked by parseDocument; null removes it. A scene may hold its own (update_scene), which wins.
 */
export function normalizeShutterAngle(holder) {
  if (holder.shutterAngle === undefined || holder.shutterAngle === null) { delete holder.shutterAngle; return; }
  const angle = holder.shutterAngle;
  if (typeof angle !== "number" || !Number.isFinite(angle) || angle < 0 || angle > 360)
    throw new Error("shutterAngle must be a number of degrees from 0 to 360 (180 is the film look, 0 is off).");
}

/** update_project {properties}: sets the name, videoType, rhythm, fps or shutterAngle. null removes all but name. */
export function applyProjectUpdate(document, properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Object.keys(properties).length)
    throw new Error("update_project needs properties, such as {videoType:\"promo\"} or {rhythm:{bpm:120, offset:0}}.");
  for (const [key, value] of Object.entries(properties)) {
    // A guess at the shutter's name (motionBlur:true, shutter:180) gets the call that works.
    if (/^(motion_?blur|shutter|motionsamples)$/i.test(key)) throw new Error(`update_project has no ${key}: motion blur is {shutterAngle:180} (degrees, 0 to 360; 0 is off).`);
    if (!PROJECT_PROPERTIES.has(key)) throw new Error(`update_project can change ${[...PROJECT_PROPERTIES].join(", ")}; not ${key}.`);
    if (value === null && key !== "name") delete document[key];
    // The project's frame rate (frameRate.js): 20, 23.976, "24000/1001" are kept as frames a second.
    else if (key === "fps") document.fps = readFps(value);
    else document[key] = value;
  }
}

/**
 * The layer and animation times of `document` that do not sit on a frame of `fps` (frameRate.js
 * onFrame), as {id, field, time}: what a rate change moved off its grid. At most `most`.
 */
export function offGridTimes(document, fps, most = 8) {
  const found = [];
  const add = (id, field, time) => { if (Number.isFinite(time) && !onFrame(time, fps) && found.length < most) found.push({ id, field, time }); };
  for (const scene of document.scenes ?? []) {
    for (const layer of scene.layers ?? []) {
      for (const animation of layer.animations ?? []) {
        add(animation.id, "start", animation.start);
        add(animation.id, "end", animation.start + animation.duration);
      }
    }
  }
  return found;
}

// The waiver's targets as a list: target is one ID (or *) or a list of IDs, saved as one waiver each.
function waiverTargets({ code, target }) {
  if (typeof code !== "string" || !code) throw new Error("A waiver needs code: the check rule to accept, such as reading_time.");
  const targets = [target].flat();
  if (!targets.length || targets.some((each) => typeof each !== "string" || !each))
    throw new Error("A waiver needs target: a layer, a scene, or a list of them.");
  return targets;
}

/**
 * waive_check {code, target, reason, detail?}: accepts a check finding on purpose, on one target or a list.
 * Replaces an earlier waiver of the same finding. Two findings of one code on one target each keep a
 * waiver by giving each its own detail (a word of the finding, or for reference_range its rows); a
 * waiver without a detail is the one slot of old, and replaces every waiver of that code and target.
 */
export function withWaiver(waivers = [], { code, target, reason, detail }) {
  const slot = typeof detail === "string" ? detail.trim().toLowerCase().slice(0, 80) : "";
  const targets = new Set(waiverTargets({ code, target }));
  if (typeof reason !== "string" || !reason.trim()) throw new Error("waive_check needs reason: why this finding is fine in this video.");
  const next = [...waivers.filter((waiver) => waiver.code !== code || !targets.has(waiver.target) || (slot && (waiver.detail ?? "") !== slot)), ...[...targets].map((each) => ({ code, target: each, reason, ...(slot ? { detail: slot } : {}) }))];
  // A glob or list is saved as one waiver per layer, so a broad one ("word-*") can pass the limit.
  if (next.length > MAX_WAIVERS)
    throw new Error(`waive_check would make ${next.length} waivers (${targets.size} from this target); a project keeps at most ${MAX_WAIVERS}. Name fewer layers, or the scene when the rule allows a scene waiver (face, crop and viewer rules name layers only).`);
  return next;
}

/**
 * The waivers `after` keeps once an edit changed `before`: a waiver on a layer lapses when the
 * layer is deleted or its file (src) changes, so a song re-added under the same name is checked
 * again. Waivers the edit itself added, and waivers on scenes or *, stay.
 */
export function keptWaivers(before, after) {
  const files = (document) => {
    const map = new Map();
    for (const scene of document.scenes ?? []) for (const layer of scene.layers ?? []) map.set(layer.id, [map.get(layer.id), layer.src ?? ""].filter((each) => each !== undefined).join("\n"));
    return map;
  };
  const had = new Set((before.checkWaivers ?? []).map((waiver) => `${waiver.code} ${waiver.target}`));
  const was = files(before), now = files(after);
  return (after.checkWaivers ?? []).filter((waiver) => !had.has(`${waiver.code} ${waiver.target}`) || !was.has(waiver.target) || now.get(waiver.target) === was.get(waiver.target));
}

/** unwaive_check {code, target}: removes a waiver, or the waivers of a list of targets (none there: nothing changes). */
export function withoutWaiver(waivers = [], { code, target }) {
  const targets = new Set(waiverTargets({ code, target }));
  return waivers.filter((waiver) => waiver.code !== code || !targets.has(waiver.target));
}
