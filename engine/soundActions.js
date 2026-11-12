// Sounds on visible actions: the cut's moments a viewer sees happen at one frame (kino's own moves,
// found by techniquesUsed, and the clips' measured impacts and light), a library sound offered for
// each, and place_sounds, which lands a sound's transient on its action's frame under the song there.
//
// Why: an added sound is heard as caused by something on screen when its transient lands on that
// action's frame and it sits under the bed it plays over. Studied edits put a boom where the frame
// reaches black, a burst on a whip, a tone as a cap lands, 3 of 4 within 100 ms
// (.scratch/barwave/design/sounds-on-actions.md, REFERENCES); 5 of 9 studied edits add none, so
// every sound here is an offer and zero sounds stays valid.
import { createLayer } from "./model.js";
import { bedLoudness } from "./mixLevels.js";
import { mediaPlaybackRange } from "./playback.js";

// Technique tag (engine/quality/techniques.js) → the kind of sound it can carry. Left out on purpose:
// dissolve, fade-black, slow-push, drift, hold, parallax, depth-blur, particles, speed-lines, grain,
// vignette, a plain cut and the other type-* entrances: nothing happens on screen at one frame.
export const ACTION_KINDS = Object.freeze({
  "whip-pan": "whip", "push-transition": "whip", "swipe-cards": "whip",
  "zoom-through": "whoosh", "mask-wipe": "whoosh", "punch-in": "whoosh", "screen-zoom": "whoosh",
  "glitch-hit": "glitch", "rgb-split": "glitch",
  flash: "flash",
  shake: "impact", "accent-hit": "impact",
  "type-kinetic": "text-hit", "type-giant": "text-hit",
  cursor: "click",
});
// The order a merge keeps (the first kind listed wins when two actions are within MERGE seconds).
const KIND_ORDER = ["impact", "flash", "glitch", "whip", "whoosh", "text-hit", "click"];
// The library words each kind searches (backend/sound-library.mjs searchSounds). Builder's choice:
// flash "zap" (the library's word for a short bright electric hit).
export const KIND_WORDS = Object.freeze({ whip: "swish whoosh", whoosh: "whoosh", glitch: "glitch", flash: "zap", impact: "impact hit", "text-hit": "tap pop", click: "click" });
// Low sounds are offered for impacts only, never on a dim or a fade (lead decision).
export const LOW_WORDS = ["sub", "low", "rumble", "boom"];
// Two actions this close are one moment (0.15 s: under 5 frames at 30 fps; a guess).
const MERGE = 0.15;
// A song onset or accent this close to an action means the song already hits there (60 ms: about
// 2 frames at 30 fps, inside the 100 ms the studied edits land within).
const SONG_HIT = 0.06;
// A clip's light change is a flash only when it comes up in 3 frames or less.
const LIGHT_FRAMES = 3;
export const MAX_ACTIONS = 12;

const round = (value) => Math.round(value * 100) / 100;

/**
 * The cut's visible actions: `found` is techniquesUsed's {tag: [{at, itemId?}]}, `events` the clips'
 * measured events in scene time ({kind: "impact" | "light", at, from?, layer}, as cueFactsOf gives
 * them), `cues` the document's cues. Returns {actions: [{id, at, kind, tags, layer?, songHit?}], more}.
 */
export function visibleActions(found = {}, events = [], cues = [], { fps = 30, max = MAX_ACTIONS } = {}) {
  const raw = [];
  for (const [tag, uses] of Object.entries(found ?? {})) {
    const kind = ACTION_KINDS[tag];
    if (!kind) continue;
    for (const use of uses ?? []) if (Number.isFinite(use?.at)) raw.push({ at: use.at, kind, tag, layer: use.itemId });
  }
  for (const event of events ?? []) {
    if (!Number.isFinite(event?.at)) continue;
    if (event.kind === "impact") raw.push({ at: event.at, kind: "impact", tag: "clip impact", layer: event.layer });
    else if (event.kind === "light" && Number.isFinite(event.from) && event.at - event.from <= LIGHT_FRAMES / fps + 1e-6) raw.push({ at: event.at, kind: "flash", tag: "clip light", layer: event.layer });
  }
  raw.sort((a, b) => a.at - b.at || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const merged = [];
  for (const entry of raw) {
    const near = merged.find((item) => Math.abs(item.at - entry.at) <= MERGE + 1e-9);
    if (!near) { merged.push({ at: entry.at, kind: entry.kind, tags: [entry.tag], ...(entry.layer ? { layer: entry.layer } : {}) }); continue; }
    if (!near.tags.includes(entry.tag)) near.tags.push(entry.tag);
    if (KIND_ORDER.indexOf(entry.kind) < KIND_ORDER.indexOf(near.kind)) near.kind = entry.kind;
  }
  const hits = (cues ?? []).filter((cue) => (cue?.kind === "onset" || cue?.kind === "accent") && Number.isFinite(cue.time));
  const actions = merged.map((action, index) => ({
    id: `a${index + 1}`, at: round(action.at), kind: action.kind, tags: action.tags, ...(action.layer ? { layer: action.layer } : {}),
    ...(hits.some((cue) => Math.abs(cue.time - action.at) <= SONG_HIT + 1e-9) ? { songHit: true } : {}),
  }));
  return { actions: actions.slice(0, max), more: Math.max(0, actions.length - max), all: actions };
}

// The level an effect sits under the bed it plays over (LU), by default. A guess (lead decision):
// the studied edits give no clean measure; the agent sets `under` per call or per sound.
export const UNDER_BED = 3;
// Volume limits for a placed sound (a guess: 0.05 is about -26 dB, 2 is +6 dB).
const MIN_VOLUME = 0.05;
const MAX_VOLUME = 2;
// With no bed to measure against: the middle of the old hand rule (volume 0.4 to 0.7, sound.md).
export const UNMEASURED_VOLUME = 0.6;
// A sound under 0.4 s has no momentary reading; its sample peak stands in, less this many dB. Set
// from the proof render (.scratch/barwave/wave/sounds-on-actions/RESULT.md): placed by peak alone, a
// pluck and a metal hit raised the song's momentary 0.0 to 0.1 LU, about 13 dB quieter than meant.
// A guess for other short sounds.
export const PEAK_OVER_MOMENTARY = 12;

/**
 * Where and how loud one effect plays so its transient lands on `at` (scene s) `under` LU under the
 * beds there. `peaks` {peaks, secondsPerPeak} is the file's waveform (.peaks, 100 a second): the
 * transient is its largest value. `curve` {step, momentary} is its loudness (.lufs); without a value
 * the catalog `peak` (dBFS) stands in. `beds` are [{curve, layer, range}] as bedLoudness takes them.
 * Returns {mediaStart, mediaOffset, transient, volume, level: "measured" | "peak" | "unmeasured", bed, effect}.
 */
export function soundPlacement({ peaks = null, curve = null, peak = null, beds = [], at, under = UNDER_BED }) {
  const values = Array.isArray(peaks?.peaks) ? peaks.peaks : [];
  const each = peaks?.secondsPerPeak > 0 ? peaks.secondsPerPeak : 0.01;
  let largest = 0;
  values.forEach((value, index) => { if (value > values[largest]) largest = index; });
  const transient = values.length ? Math.round(largest * each * 1000) / 1000 : 0;
  const start = at - transient;
  const mediaStart = start >= 0 ? round3(start) : 0;
  const mediaOffset = start >= 0 ? 0 : round3(-start);
  const heard = (curve?.momentary ?? []).filter((value) => Number.isFinite(value) && value > -70);
  const effect = heard.length ? Math.max(...heard) : Number.isFinite(peak) ? peak - PEAK_OVER_MOMENTARY : null;
  const bed = bedLoudness(beds ?? [], at - 0.2, at + 0.2);
  if (bed === null || effect === null) return { mediaStart, mediaOffset, transient, volume: UNMEASURED_VOLUME, level: "unmeasured", bed, effect };
  const volume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, 10 ** ((bed - under - effect) / 20)));
  return { mediaStart, mediaOffset, transient, volume: Math.round(volume * 1000) / 1000, level: heard.length ? "measured" : "peak", bed: round1(bed), effect: round1(effect) };
}
const round3 = (value) => Math.round(value * 1000) / 1000;
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * place_sounds, resolved by the agent service: {sceneId, sounds: [{at, kind?, action?, tags?, src,
 * name?, duration?, peaks?, curve?, peak?, under?}], beds?: [layerId], levels?: {layerId: curve}}.
 * Adds one audio layer `sfx-<kind>-<n>` per sound and reports where each transient lands.
 */
export function applyPlaceSounds(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) throw new Error(`Scene ${operation.sceneId} was not found.`);
  const sounds = Array.isArray(operation.sounds) ? operation.sounds : [];
  if (!sounds.length) throw new Error('place_sounds needs at: action ids from library {topic:"sounds", actions:true}, or seconds.');
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const beds = (operation.beds ?? []).map((id) => byId.get(id)).filter(Boolean)
    .map((layer) => ({ layer, curve: operation.levels?.[layer.id], range: mediaPlaybackRange(layer, scene.duration) }))
    .filter((bed) => bed.curve && bed.range);
  const used = new Set(document.scenes.flatMap((item) => item.layers.map((layer) => layer.id)));
  const placed = [];
  for (const sound of sounds) {
    if (!Number.isFinite(sound?.at) || sound.at < 0 || sound.at >= scene.duration) throw new Error(`place_sounds at ${sound?.at} is outside the scene (0 to ${scene.duration} s).`);
    if (typeof sound.src !== "string" || !sound.src) throw new Error("place_sounds needs a sound file for each time.");
    const where = soundPlacement({ peaks: sound.peaks, curve: sound.curve, peak: sound.peak, beds, at: sound.at, under: Number.isFinite(sound.under) ? sound.under : Number.isFinite(operation.under) ? operation.under : UNDER_BED });
    const kind = String(sound.kind ?? "hit").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "hit";
    let n = 1;
    while (used.has(`sfx-${kind}-${n}`)) n += 1;
    const id = `sfx-${kind}-${n}`;
    used.add(id);
    const playLength = Number.isFinite(sound.duration) && sound.duration > 0 ? round3(sound.duration - where.mediaOffset) : null;
    scene.layers.push(createLayer("audio", {
      id, name: id, src: sound.src, mediaStart: where.mediaStart, mediaOffset: where.mediaOffset, volume: where.volume,
      ...(Number.isFinite(sound.duration) && sound.duration > 0 ? { mediaSourceDuration: sound.duration } : {}),
      ...(playLength > 0 ? { mediaDuration: Math.min(playLength, round3(scene.duration - where.mediaStart)) } : {}),
    }));
    placed.push({ layer: id, at: sound.at, ...(sound.action ? { action: sound.action } : {}), ...(sound.tags ? { tags: sound.tags } : {}), file: sound.name ?? sound.src, ...where });
  }
  // The scene's sound effects after this (layers named sfx-*), so the receipt says how many it now has.
  const effects = scene.layers.filter((layer) => layer.type === "audio" && /^sfx-/.test(layer.id)).length;
  return { placed: placed.length, summary: `${placed.map(placedLine).join(" · ")} · ${effects} ${effects === 1 ? "effect" : "effects"} in ${round(scene.duration)} s` };
}

const tagsOf = (entry) => (entry.action ? ` (${entry.action}${entry.tags?.length ? ` ${entry.tags.join("+")}` : ""}, transient at ${entry.at})` : ` (transient at ${entry.at})`);
function placedLine(entry) {
  const level = entry.level === "unmeasured" ? `volume ${entry.volume} (no song measured there)`
    : `volume ${entry.volume}, ${round1(entry.bed - entry.effect - 20 * Math.log10(entry.volume))} LU under the song (${entry.bed} LUFS)${entry.level === "peak" ? ", level from peak" : ""}`;
  return `${entry.layer} at ${round3(entry.mediaStart)}${entry.mediaOffset ? ` (head trimmed ${entry.mediaOffset} s)` : ""}${tagsOf(entry)}, ${level}`;
}
