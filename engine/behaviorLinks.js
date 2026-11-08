// Behaviors that read another layer (behavior.js follow and audio) keep what they read in the
// document, so every frame stays a pure function of the document and preview, exports and Lottie
// draw the same numbers. applyOperations calls refreshBehaviorLinks after each edit:
//   follow: the leader's move (its value minus its saved value) sampled FOLLOW_RATE times a
//     second from the animation's start minus lag, into follow.track {rate, values: {property}}.
//     Leaders that follow others are sampled first; a loop of followers is refused.
//   audio: the sound layer's level in the band, LEVEL_RATE times a second over the animation,
//     into audio.levels {rate, values}. The levels of each sound file come from the edit's
//     context (soundLevels: src -> {rate, all, low, mid, high}, backend/audio-levels.mjs); an edit
//     without them keeps the levels already saved. A time the sound does not play is 0.
// Both name their layer by name or ID and save its ID. A leader or sound deleted later leaves the
// last saved track or levels.
import { evaluateLayer } from "./animation.js";
import { animationTreeEntries } from "./animationTree.js";
import { mediaPlaybackRange, mediaSoundTime } from "./playback.js";
import { MAX_TRACK_VALUES } from "./behavior.js";

export const FOLLOW_RATE = 60;
export const LEVEL_RATE = 30;
const SOUND_TYPES = new Set(["audio", "video"]);
const round3 = (value) => Math.round(value * 1000) / 1000;

function findLayer(scene, ref) {
  return scene.layers.find((layer) => layer.id === ref) ?? scene.layers.find((layer) => layer.name === ref);
}

// The rate and count of samples over `duration` seconds: `rate` a second, fewer for a long one.
function grid(duration, rate) {
  const fitted = Math.min(rate, (MAX_TRACK_VALUES - 1) / Math.max(duration, 1e-9));
  return { rate: fitted, count: Math.floor(duration * fitted + 1e-9) + 2 };
}

/** Bakes every follow track and audio level list in `document` (changed in place). */
export function refreshBehaviorLinks(document, { soundLevels } = {}) {
  for (const scene of document.scenes ?? []) {
    const entries = new Map();
    for (const layer of scene.layers ?? []) {
      const linked = animationTreeEntries(layer.animations ?? []).filter(({ stored }) => stored?.behavior?.follow || stored?.behavior?.audio);
      if (linked.length) entries.set(layer, linked);
    }
    if (!entries.size) continue;
    const done = new Set(), visiting = new Set();
    const refresh = (layer) => {
      if (done.has(layer) || !entries.has(layer)) return;
      if (visiting.has(layer)) throw new Error(`behavior.follow: "${layer.name}" follows itself through a loop of leaders`);
      visiting.add(layer);
      for (const { animation, stored } of entries.get(layer)) {
        const label = `"${layer.name}" ${stored.name ?? stored.id}`;
        if (stored.behavior.follow) bakeFollow(scene, layer, animation, stored.behavior.follow, label, refresh);
        if (stored.behavior.audio) bakeAudio(scene, animation, stored.behavior.audio, label, soundLevels);
      }
      visiting.delete(layer);
      done.add(layer);
    };
    for (const layer of entries.keys()) refresh(layer);
  }
  return document;
}

function bakeFollow(scene, layer, animation, follow, label, refresh) {
  const leader = findLayer(scene, follow.layer);
  if (!leader) {
    if (follow.track) return;
    throw new Error(`${label}: behavior.follow.layer "${follow.layer}" is not a layer of this scene`);
  }
  if (leader === layer) throw new Error(`${label}: behavior.follow.layer can't be the layer itself`);
  refresh(leader);
  follow.layer = leader.id;
  const keys = new Set(Object.keys(animation.to ?? {}).filter((key) => typeof animation.to[key] === "number"));
  if (follow.offset && typeof follow.offset === "object") for (const key of Object.keys(follow.offset)) keys.add(key);
  const properties = [...new Set([...keys].map((key) => follow.property ?? key))];
  for (const property of properties)
    if (typeof leader[property] !== "number" || !Number.isFinite(leader[property]))
      throw new Error(`${label}: behavior.follow: "${leader.name}" has no number ${property}${follow.property ? "" : "; name one with property"}`);
  const duration = Math.max(0, animation.duration ?? 0);
  const { rate, count } = grid(duration, FOLLOW_RATE);
  const values = Object.fromEntries(properties.map((property) => [property, []]));
  for (let index = 0; index < count; index += 1) {
    const time = Math.max(0, (animation.start ?? 0) - follow.lag + Math.min(duration, index / rate));
    const state = evaluateLayer(leader, time, { unitIndex: 0, unitCount: 1, shareAnimations: true });
    for (const property of properties) values[property].push(round3((Number(state[property]) || 0) - leader[property]));
  }
  follow.track = { rate, values };
}

function bakeAudio(scene, animation, audio, label, soundLevels) {
  const sound = findLayer(scene, audio.layer);
  if (sound && !(SOUND_TYPES.has(sound.type) && sound.src)) throw new Error(`${label}: behavior.audio.layer "${sound.name}" is a ${sound.type} layer; name an audio or video layer with sound`);
  const file = sound ? soundLevels?.get?.(sound.src) : null;
  if (!file) {
    if (audio.levels) return;
    throw new Error(sound
      ? `${label}: behavior.audio: the sound of "${sound.name}" has not been measured; send this edit through kino's edit tool, which measures it`
      : `${label}: behavior.audio.layer "${audio.layer}" is not a layer of this scene`);
  }
  audio.layer = sound.id;
  const bandLevels = file[audio.band] ?? [];
  const range = mediaPlaybackRange(sound, scene.duration);
  const duration = Math.max(0, animation.duration ?? 0);
  const { rate, count } = grid(duration, LEVEL_RATE);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const time = (animation.start ?? 0) + Math.min(duration, index / rate);
    if (!range || time < range.start || time > range.end) { values.push(0); continue; }
    const at = Math.max(0, mediaSoundTime(sound, time) * file.rate);
    const i = Math.floor(at), a = bandLevels[i] ?? 0, b = bandLevels[i + 1] ?? a;
    values.push(round3(a + (b - a) * (at - i)));
  }
  audio.levels = { rate, values };
}
