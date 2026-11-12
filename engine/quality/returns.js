// What comes back in a scene: each made layer, word, move or shot shown at two or more places,
// what changes between its first and last place, and what the first second and the last frame
// share. A fact for look's sheet and check's answer, never a rule or a finding.
//
// Why: a viewer reads a video as one piece when something they saw comes back changed (the
// returning-device spec's reference study counted a device returning 4 to 12 times in each
// human-made edit). The line only says what already returns; the agent decides.
import { flattenAnimations } from "../animationTree.js";
import { hasMediaPlay, mediaPlaybackRange } from "../playback.js";
import { visibleByOperations } from "../visibilityOps.js";
import { selectionStart } from "../duplicate.js";

// Places closer than this are one place (a layer and its plate starting together). A guess: a
// quarter second is shorter than any shot the reference edits hold.
const SAME_PLACE = 0.25;
// Two uses of one file within this many file seconds are one shot (a guess: half a second of
// footage reads as the same moment).
const SAME_SHOT = 0.5;
const CHANGE_KEYS = ["scaleX", "scaleY", "rotation", "opacity", "fill", "fontSize", "width", "height"];
const round = (value) => Math.round(value * 100) / 100 + 0;

function subtree(layers, root) {
  const ids = new Set([root.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const layer of layers) if (ids.has(layer.parentId) && !ids.has(layer.id)) { ids.add(layer.id); grew = true; }
  }
  return layers.filter((layer) => ids.has(layer.id));
}

// " copy" and a trailing " 3" come off a name, so copies group with their original.
const nameBase = (name) => String(name ?? "").replace(/( copy)+( \d+)?$/i, "").replace(/ \d+$/, "").trim().toLowerCase();
// The stem of layers named by number ("tread-1" to "tread-4"): one device, whether its parts show
// together or one after another. A name that is only a number keeps it.
const nameStem = (name) => nameBase(name).replace(/(?<=\p{L}\p{L})[-_ ]?\d+$/u, "") || nameBase(name);

// A video's place is its play time, an instance's its clock, any other layer's the first Show or
// animation start in it (0 with none).
function placeOf(layers, layer) {
  if (hasMediaPlay(layer)) return Number.isFinite(layer.mediaStart) ? layer.mediaStart : 0;
  if (layer.type === "component" && Number.isFinite(layer.componentStart)) return layer.componentStart;
  return selectionStart(subtree(layers, layer)) ?? 0;
}

/**
 * The element a layer shows, as a key its copies share: a video or picture is its file, any other
 * layer its type, its name less " copy" and a number (duplicate_layers names copies "<name> 2"),
 * and its words.
 */
export function elementKey(layer) {
  if ((layer?.type === "video" || layer?.type === "image") && layer.src) return `file:${layer.src}`;
  return `${layer?.type}:${nameBase(layer?.name)}:${String(layer?.text ?? "").trim().toLowerCase()}`;
}

/**
 * Each element shown at two or more places (SAME_PLACE apart): Map key → [s], in time order. A
 * video or picture counts at any depth, any other layer at the top level. For rules that leave a
 * returning element's repeats alone (sfx_restraint).
 */
export function elementPlaces(scene) {
  const layers = scene?.layers ?? [];
  const used = layers.filter((layer) => layer.type !== "audio" && layer.enabled !== false && !layer.move?.name
    && (!layer.parentId || ((layer.type === "video" || layer.type === "image") && layer.src)));
  const isClip = (layer) => layer.type === "video" && Boolean(layer.src);
  // A clip's uses are one element when they come from one stretch of its file: cuts from all over
  // one long file are different shots, not one returning shot.
  const offset = (layer) => (Number.isFinite(layer.mediaOffset) ? layer.mediaOffset : 0);
  const stretchStarts = new Map();
  const stretchOf = new Map();
  for (const layer of used.filter(isClip).sort((a, b) => offset(a) - offset(b))) {
    const starts = stretchStarts.get(layer.src) ?? [];
    if (!starts.length || offset(layer) - starts[starts.length - 1] > SAME_STRETCH) starts.push(offset(layer));
    stretchStarts.set(layer.src, starts);
    stretchOf.set(layer, starts.length - 1);
  }
  const uses = used.map((layer) => ({ key: isClip(layer) ? `${elementKey(layer)}#${stretchOf.get(layer)}` : elementKey(layer), time: placeOf(layers, layer), clip: isClip(layer) }));
  const byKey = new Map();
  for (const use of uses) byKey.set(use.key, [...(byKey.get(use.key) ?? []), use]);
  const returning = new Map();
  for (const [key, list] of byKey) {
    const places = [];
    for (const { time } of placesOf(list.sort((a, b) => a.time - b.time))) {
      // A shot returns after a cut away: another clip starts between two of its places. Without one
      // it plays on, so the later place is the same showing.
      const last = places[places.length - 1];
      const cutAway = !list[0].clip || last === undefined || uses.some((other) => other.clip && other.key !== key && other.time > last + 1e-6 && other.time < time - 1e-6);
      if (cutAway) places.push(time);
    }
    if (places.length >= 2) returning.set(key, places);
  }
  return returning;
}

// File seconds that one stretch of a clip spans from its first use (a guess: longer than the
// shots the studied edits cut from one file, shorter than a scene of a long recording).
const SAME_STRETCH = 10;

/** Two places of one element closer than this are one place (a layer and its plate). */
export { SAME_PLACE };

// Every group of alike uses: {key, label, uses:[{time, layer}]} (uses in time order).
function groupUses(scene, scenes) {
  const layers = scene?.layers ?? [];
  const groups = new Map();
  const shots = [];
  const add = (key, label, time, layer, size = 1) => {
    if (!groups.has(key)) groups.set(key, { key, label, uses: [] });
    groups.get(key).uses.push({ time, layer, size });
  };
  const timeOf = (layer) => placeOf(layers, layer);
  const instances = new Map();
  for (const layer of layers) {
    if (layer.type === "audio") continue;
    if (layer.move?.name) {
      // A move's parts are one place per instance, at its earliest part.
      const key = `move:${layer.move.name}`;
      const instance = `${key}#${layer.move.instance ?? ""}`;
      const time = timeOf(layer);
      if (!instances.has(instance) || instances.get(instance).time > time) instances.set(instance, { key, label: `move ${layer.move.name}`, time, layer });
      continue;
    }
    if (layer.type === "video" && layer.src) {
      const offset = Number.isFinite(layer.mediaOffset) ? layer.mediaOffset : 0;
      let shot = shots.find((item) => item.src === layer.src && Math.abs(item.offset - offset) <= SAME_SHOT);
      if (!shot) shots.push(shot = { src: layer.src, offset, key: `shot:${shots.length}`, label: `shot ${layer.name || layer.id} (file ${round(offset)}s)` });
      add(shot.key, shot.label, timeOf(layer), layer);
      continue;
    }
    if (layer.parentId) continue;
    if (layer.type === "component") {
      const source = scenes.find((item) => item.id === layer.componentSceneId);
      add(`component:${layer.componentSceneId}`, source?.name ?? layer.componentSceneId, timeOf(layer), layer);
    } else if (layer.type === "text" && String(layer.text ?? "").trim()) {
      const text = String(layer.text).trim().toLowerCase().replace(/\s+/g, " ");
      add(`text:${text}`, `"${text.length > 24 ? `${text.slice(0, 23)}…` : text}"`, timeOf(layer), layer);
    } else if (layer.type === "image" && layer.src) {
      // An image returns when its file does: two imports both named "image" are not one device.
      const base = nameBase(layer.name);
      add(`image:${layer.src}`, !base || base === "image" ? "image" : `image ${base}`, timeOf(layer), layer);
    } else {
      // A group counts once; the layers inside it are the device's size.
      const stem = nameStem(layer.name);
      add(`${layer.type}:${stem}`, stem || layer.type, timeOf(layer), layer, layer.type === "group" ? Math.max(1, subtree(layers, layer).length - 1) : 1);
    }
  }
  for (const { key, label, time, layer } of instances.values()) add(key, label, time, layer);
  for (const group of groups.values()) group.uses.sort((a, b) => a.time - b.time);
  return [...groups.values()];
}

// Uses closer than SAME_PLACE are one place; its size is the layers they add up to.
const placesOf = (uses) => {
  const places = [];
  for (const use of uses) {
    const last = places[places.length - 1];
    if (!last || use.time - last.time >= SAME_PLACE) places.push({ ...use, size: use.size ?? 1 });
    else last.size += use.size ?? 1;
  }
  return places;
};

/**
 * The devices that return: [{key, label, places:[s], changes:[{key, first, last}]}], two or more
 * places each, most places first. `scenes` (the document's) names component instances.
 */
export function returningDevices(scene, { scenes = [] } = {}) {
  const devices = [];
  for (const group of groupUses(scene, scenes)) {
    const places = placesOf(group.uses);
    if (places.length < 2) continue;
    const first = places[0].layer, last = places[places.length - 1].layer;
    const changes = CHANGE_KEYS.filter((key) => first[key] !== undefined && last[key] !== undefined && first[key] !== last[key])
      .slice(0, 2).map((key) => ({ key, first: first[key], last: last[key] }));
    devices.push({ key: group.key, label: group.label, places: places.map((place) => round(place.time)), layers: Math.max(...places.map((place) => place.size ?? 1)), changes });
  }
  // A shot inside a returning group returns with it: listed once, as the group.
  const kept = devices.filter((device) => !device.key.startsWith("shot:")
    || !devices.some((other) => !other.key.startsWith("shot:") && other.places.join() === device.places.join()));
  return kept.sort((a, b) => b.places.length - a.places.length || a.places[0] - b.places[0]);
}

/**
 * The labels shown in the first second that come back in the last frame (duration - 0.05 s): a
 * group with a use starting before 1 s and a later use visible at the end.
 */
export function openAndClose(scene, { duration = scene?.duration ?? 0, scenes = [] } = {}) {
  const end = Math.max(0, duration - 0.05);
  const visibleAtEnd = (layer) => {
    if (!visibleByOperations(flattenAnimations(layer.animations ?? []), end)) return false;
    if (!hasMediaPlay(layer)) return true;
    const range = mediaPlaybackRange(layer, duration);
    return Boolean(range && range.start <= end && end < range.end);
  };
  return groupUses(scene, scenes)
    .filter(({ uses }) => uses[0].time < 1 && uses.some((use) => use.time - uses[0].time >= SAME_PLACE && visibleAtEnd(use.layer)))
    .map((group) => group.label);
}

/** One line: `returns: ring at 3.3 7 11.3 14.2 (scaleX 0.4 to 1.6) · ... · first 1 s and last frame share: nothing`. */
// At most this many times per device, so a 50-copy duplicate keeps the line short (a guess).
const SHOWN_PLACES = 8;
export function returnsLine(devices, { share = [] } = {}, limit = 4) {
  // "<label> at <times>": no count after the label, so "image at 2 5" is not read as a layer "image 2".
  // A short run ends with its count ("×4"); a device of several layers says how many at a place.
  const times = (places) => (places.length > SHOWN_PLACES ? `${places.slice(0, SHOWN_PLACES).join(" ")} … (${places.length} places)` : `${places.join(" ")} ×${places.length}`);
  const listed = devices.slice(0, limit).map((device) => `${device.label}${device.layers > 1 ? ` (${device.layers} layers)` : ""} at ${times(device.places)}${device.changes.length ? ` (${device.changes.map((change) => `${change.key} ${change.first} to ${change.last}`).join(", ")})` : ""}`);
  const rest = devices.slice(limit);
  const more = rest.length ? ` · +${rest.length} more (${rest.slice(0, 8).map((device) => `${device.label} ×${device.places.length}`).join(", ")}${rest.length > 8 ? ", ..." : ""})` : "";
  const head = listed.length ? listed.join(" · ") + more : "no made layer, word, move or shot is shown twice";
  return `returns: ${head} · first 1 s and last frame share: ${share.length ? share.join(", ") : "nothing"}`;
}

/** The line for a saved scene, as look and check print it. */
export function sceneReturnsLine(scene, { scenes = [], duration = scene?.duration } = {}) {
  return returnsLine(returningDevices(scene, { scenes }), { share: openAndClose(scene, { duration, scenes }) });
}
