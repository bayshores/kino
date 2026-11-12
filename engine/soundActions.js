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
// The service measures each effect with 0.4 s of silence after it (backend/loudness-curve.mjs pad),
// so a short sound has a momentary reading. Only when that fails (no curve value) does its sample
// peak stand in, less this many dB. Set
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
  const momentary = Array.isArray(curve?.momentary) ? curve.momentary : [];
  let loudest = -1;
  momentary.forEach((value, index) => { if (Number.isFinite(value) && value > -70 && (loudest < 0 || value > momentary[loudest])) loudest = index; });
  const effect = loudest >= 0 ? momentary[loudest] : Number.isFinite(peak) ? peak - PEAK_OVER_MOMENTARY : null;
  // The bed is measured over the 0.4 s window where the effect's own loudest momentary value falls
  // (its middle, in scene seconds), so the two numbers compared are the same moment: measured at the
  // action alone, a 2.5 s riser sat 1.4 LU under and an impact 4.6 LU under an aim of 3 (sounds-on-actions).
  // With a measured loudest window, the bed is its one momentary value there (the same 400 ms): an
  // energy mean of the values 0.2 s either side reads 0.8 s of the bed, and a riser into a drop read
  // the quiet build before it (7.9 LU under in the synthesized proof instead of 3).
  const middle = loudest >= 0 && curve.step > 0 ? at - transient + loudest * curve.step : at;
  const sample = Math.round(middle * 10) / 10;
  const bed = loudest >= 0 ? bedLoudness(beds ?? [], sample + 0.001, sample + 0.002) : bedLoudness(beds ?? [], at - 0.2, at + 0.2);
  if (bed === null || effect === null) return { mediaStart, mediaOffset, transient, volume: UNMEASURED_VOLUME, level: "unmeasured", bed, effect };
  const volume = Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, 10 ** ((bed - under - effect) / 20)));
  return { mediaStart, mediaOffset, transient, volume: Math.round(volume * 1000) / 1000, level: loudest >= 0 ? "measured" : "peak", bed: round1(bed), effect: round1(effect), loudestAt: round3(middle) };
}

/**
 * A sound at the volume limit that still misses its aim by more than 0.05 LU: the next louder sound
 * of its kind in `pool` ([{id, level}], the library catalog's measured level: LUFS, or its sample
 * peak less PEAK_OVER_MOMENTARY for a sound under 0.4 s), compared with `own` (the sound's own
 * catalog level, else its measured loudest moment). The first one louder by the shortfall, else the
 * loudest louder one. Returns {id, db, short} or null.
 */
export function louderSound(where, under, own, pool = []) {
  if (where.level === "unmeasured" || where.volume < MAX_VOLUME) return null;
  const short = round1(where.bed - where.effect - 20 * Math.log10(where.volume) - under);
  if (!(short > 0.05) || !Number.isFinite(own)) return null;
  const louder = pool.filter((sound) => Number.isFinite(sound?.level) && sound.level > own + 0.05).sort((a, b) => a.level - b.level);
  const pick = louder.find((sound) => sound.level - own >= short) ?? louder.at(-1);
  return pick ? { id: pick.id, db: round1(pick.level - own), short } : null;
}

/** A library sound's measured level for louderSound: its LUFS when it has one, else its peak less PEAK_OVER_MOMENTARY. */
export const catalogLevel = (sound) => (Number.isFinite(sound?.lufs) && sound.lufs > -70 ? sound.lufs : Number.isFinite(sound?.peak) ? sound.peak - PEAK_OVER_MOMENTARY : null);
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
    const under = Number.isFinite(sound.under) ? sound.under : Number.isFinite(operation.under) ? operation.under : UNDER_BED;
    const where = soundPlacement({ peaks: sound.peaks, curve: sound.curve, peak: sound.peak, beds, at: sound.at, under });
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
    // At the volume limit and still under its aim: the next louder sound of its kind, as one edit call.
    const louder = louderSound(where, under, Number.isFinite(sound.level) ? sound.level : where.effect, sound.pool);
    const call = louder ? `edit {ops:[{op:"delete_layer", layer:"${id}"}, {op:"place_sounds", scene:"${scene.id}", at:[{at:${sound.action ? `"${sound.action}"` : sound.at}, sound:"sfx:${louder.id}"${Number.isFinite(sound.under) ? `, under:${sound.under}` : ""}}]}]}` : null;
    placed.push({ layer: id, at: sound.at, ...(sound.action ? { action: sound.action } : {}), ...(sound.tags ? { tags: sound.tags } : {}), file: sound.name ?? sound.src, ...where, ...(louder ? { louder: { ...louder, call } } : {}) });
  }
  // The scene's sound effects after this (layers named sfx-*), so the receipt says how many it now has.
  const effects = scene.layers.filter((layer) => layer.type === "audio" && /^sfx-/.test(layer.id)).length;
  const louder = placed.filter((entry) => entry.louder).map((entry) => ({ layer: entry.layer, sound: `sfx:${entry.louder.id}`, db: entry.louder.db, call: entry.louder.call }));
  return { placed: placed.length, summary: `${placed.map(placedLine).join(" · ")} · ${effects} ${effects === 1 ? "effect" : "effects"} in ${round(scene.duration)} s`, ...(louder.length ? { louder } : {}) };
}

const tagsOf = (entry) => (entry.action ? ` (${entry.action}${entry.tags?.length ? ` ${entry.tags.join("+")}` : ""}, transient at ${entry.at})` : ` (transient at ${entry.at})`);
function placedLine(entry) {
  const level = entry.level === "unmeasured" ? `volume ${entry.volume} (${entry.bed === null ? "no song measured there" : "the sound's loudness was not measured"})`
    : `volume ${entry.volume}, ${round1(entry.bed - entry.effect - 20 * Math.log10(entry.volume))} LU under the song (${entry.bed} LUFS)${entry.level === "peak" ? ", level from peak" : ""}`;
  const louder = entry.louder ? `; at the volume limit, ${entry.louder.short} LU short of the aim: sfx:${entry.louder.id} measures ${entry.louder.db} dB louder: ${entry.louder.call}` : "";
  return `${entry.layer} at ${round3(entry.mediaStart)}${entry.mediaOffset ? ` (head trimmed ${entry.mediaOffset} s)` : ""}${tagsOf(entry)}, ${level}${louder}`;
}
