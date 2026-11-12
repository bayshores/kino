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

// Every group of alike uses: {key, label, uses:[{time, layer}]} (uses in time order).
function groupUses(scene, scenes) {
  const layers = scene?.layers ?? [];
  const groups = new Map();
  const shots = [];
  const add = (key, label, time, layer) => {
    if (!groups.has(key)) groups.set(key, { key, label, uses: [] });
    groups.get(key).uses.push({ time, layer });
  };
  // A video's place is its play time, an instance's its clock, any other layer's the first
  // Show or animation start in it (0 with none).
  const timeOf = (layer) => {
    if (hasMediaPlay(layer)) return Number.isFinite(layer.mediaStart) ? layer.mediaStart : 0;
    if (layer.type === "component" && Number.isFinite(layer.componentStart)) return layer.componentStart;
    return selectionStart(subtree(layers, layer)) ?? 0;
  };
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
    } else {
      add(`${layer.type}:${nameBase(layer.name)}`, nameBase(layer.name) || layer.type, timeOf(layer), layer);
    }
  }
  for (const { key, label, time, layer } of instances.values()) add(key, label, time, layer);
  for (const group of groups.values()) group.uses.sort((a, b) => a.time - b.time);
  return [...groups.values()];
}

const placesOf = (uses) => {
  const places = [];
  for (const use of uses) if (!places.length || use.time - places[places.length - 1].time >= SAME_PLACE) places.push(use);
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
    devices.push({ key: group.key, label: group.label, places: places.map((place) => round(place.time)), changes });
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

/** One line: `returns: ring 4 at 3.3 7 11.3 14.2 (scaleX 0.4 to 1.6) · ... · first 1 s and last frame share: nothing`. */
export function returnsLine(devices, { share = [] } = {}, limit = 4) {
  const listed = devices.slice(0, limit).map((device) => `${device.label} ${device.places.length} at ${device.places.join(" ")}${device.changes.length ? ` (${device.changes.map((change) => `${change.key} ${change.first} to ${change.last}`).join(", ")})` : ""}`);
  const more = devices.length > limit ? ` · +${devices.length - limit} more` : "";
  const head = listed.length ? listed.join(" · ") + more : "no made layer, word, move or shot is shown twice";
  return `returns: ${head} · first 1 s and last frame share: ${share.length ? share.join(", ") : "nothing"}`;
}

/** The line for a saved scene, as look and check print it. */
export function sceneReturnsLine(scene, { scenes = [], duration = scene?.duration } = {}) {
  return returnsLine(returningDevices(scene, { scenes }), { share: openAndClose(scene, { duration, scenes }) });
}
