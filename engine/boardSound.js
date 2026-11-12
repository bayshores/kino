// A board shot's own clip sound: sound {keep: "all" | [from, to]} on a storyboard shot
// (engine/board.js) says the shot keeps its clip's own sound, the whole shot or a stretch in file
// seconds. Run 8 planned sound "none" on 11 of 11 shots and built every clip at volume 0: the board
// could only name a sound to add (sound {media, what}), so "keep this clip's line" had no place in
// the plan (.scratch/run8/trace/audio.md L69, L90). Building the board keeps those stretches with
// keep_line (engine/keepLine.js, used as it is: its subtitle off, its dip and leveling its own).
//
// Plain data in and out: the service picks the layers this edit placed (boardKeepOps), runs each
// keep_line, then one dip under every kept stretch (keptDuck: a later keep_line's dip replaces an
// earlier one's, so two kept shots on two layers would leave only the last dipped).
import { isRecord, round } from "./numbers.js";
import { mainScene, NONE } from "./board.js";
import { mediaPlaybackRange, mediaSoundTime } from "./playback.js";
import { LINE_NAMES } from "./keepLine.js";
import { DUCK_NAMES } from "./audioDucking.js";

export const KEEP_ALL = "all";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** The shot's kept stretch: "all", [from, to] (file seconds) or null when it keeps none. */
export function shotKeep(shot) {
  const keep = isRecord(shot?.sound) ? shot.sound.keep : undefined;
  return keep === KEEP_ALL || (Array.isArray(keep) && keep.length === 2) ? keep : null;
}

/** The file seconds a shot plays: [in, in + dur × speed], or null without a video in-point. */
export function shotFileSpan(shot) {
  if (!isNumber(shot?.in)) return null;
  return [shot.in, round(shot.in + shot.dur * (shot.speed ?? 1), 3)];
}

/**
 * The kept stretch on the scene's clock: [from, to] scene seconds inside the shot, or null when
 * the shot keeps none or its stretch misses what the shot plays.
 */
export function keptSceneSpan(shot) {
  const keep = shotKeep(shot);
  if (!keep) return null;
  const end = shot.cue + shot.dur;
  if (keep === KEEP_ALL) return [round(shot.cue, 3), round(end, 3)];
  const speed = shot.speed ?? 1;
  const at = (file) => shot.cue + (file - (isNumber(shot.in) ? shot.in : 0)) / speed;
  const from = Math.max(shot.cue, at(keep[0]));
  const to = Math.min(end, at(keep[1]));
  return to - from >= 0.1 ? [round(from, 3), round(to, 3)] : null;
}

/** Seconds of clip sound the board keeps (its kept stretches added up). */
export function keptSeconds(board) {
  return round((board?.shots ?? []).reduce((sum, shot) => {
    const span = keptSceneSpan(shot);
    return sum + (span ? span[1] - span[0] : 0);
  }, 0), 2);
}

/**
 * One info line for a board over music on which no footage shot keeps its clip's sound, or null:
 * a fact for the plan (how many seconds of clip sound it keeps), not a finding.
 */
export function silentBoardLine(board) {
  if (!board || board.music === NONE) return null;
  const footage = (board.shots ?? []).filter((shot) => shot.media !== NONE && isNumber(shot.in));
  if (!footage.length || footage.some((shot) => shotKeep(shot))) return null;
  const last = board.shots.at(-1);
  const length = round(last.cue + last.dur - board.shots[0].cue, 2);
  return `clip sound: the plan keeps 0 s of the clips' own sound in ${length} s (every shot is the music alone); a shot keeps its clip's sound with sound {keep:"all"} or {keep:[from, to]} (file seconds)`;
}

// The video layer that plays a shot: its file, playing the shot's middle at about its file time.
function layerOfShot(scene, shot) {
  const middle = shot.cue + shot.dur / 2;
  const fileMiddle = isNumber(shot.in) ? shot.in + (shot.dur * (shot.speed ?? 1)) / 2 : null;
  const near = scene.layers.filter((layer) => {
    if (layer.type !== "video" || layer.src !== shot.media || layer.enabled === false) return false;
    const range = mediaPlaybackRange(layer, scene.duration);
    if (!range || middle < range.start || middle > range.end) return false;
    // Within half a second of the shot's file time: another shot of the same clip is not this one.
    return fileMiddle === null || Math.abs(mediaSoundTime(layer, middle) - fileMiddle) <= 0.5;
  });
  return near.sort((a, b) => Math.abs((a.mediaStart ?? 0) - shot.cue) - Math.abs((b.mediaStart ?? 0) - shot.cue))[0] ?? null;
}

const hasLineMarks = (layer) => (layer.animations ?? []).some((animation) => Object.values(LINE_NAMES).includes(animation?.name));
const sameSound = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The keep_line operations building the board needs after an edit: one per kept shot whose layer
 * this edit placed (not in `before`), or whose shot's sound this edit changed, and that plays no
 * kept line yet. [{n, shot, operation: {type:"keep_line", sceneId, layerId, from, to, subtitle:false}}].
 * The subtitle is off: the board's own text field plans the words on screen.
 */
export function boardKeepOps(before, after) {
  const board = after?.board;
  const scene = mainScene(after);
  if (!board?.shots?.length || !scene) return [];
  const had = new Set((before?.scenes ?? []).flatMap((item) => item.layers.map((layer) => layer.id)));
  const oldSound = new Map((before?.board?.shots ?? []).map((shot) => [shot.id, shot.sound]));
  // The board's music layer is the one to dip when it is still in the scene (keep_line alone looks
  // for a layer named music or song, which a song layer named after its file is not).
  const music = board.music !== NONE && scene.layers.some((layer) => layer.id === board.music && (layer.type === "audio" || layer.type === "video")) ? board.music : null;
  // A dip already in the scene (duck_audio under a voice, or the agent's own keep_line) stays: a
  // keep_line dip would replace it, so the kept stretches get none (duckNone) and the receipt says so.
  const ducked = scene.layers.some((layer) => (layer.animations ?? []).some((animation) => animation?.name === DUCK_NAMES.down || animation?.name === DUCK_NAMES.up));
  const dip = ducked ? { duckNone: true } : music ? { duckId: music } : {};
  const ops = [];
  for (const [index, shot] of board.shots.entries()) {
    const span = keptSceneSpan(shot);
    if (!span) continue;
    const layer = layerOfShot(scene, shot);
    if (!layer || hasLineMarks(layer)) continue;
    if (had.has(layer.id) && sameSound(oldSound.get(shot.id), shot.sound)) continue;
    ops.push({ n: index + 1, shot, operation: { type: "keep_line", sceneId: scene.id, layerId: layer.id, from: span[0], to: span[1], subtitle: false, ...(dip.duckId === layer.id ? {} : dip) } });
  }
  return ops;
}

/**
 * The one dip under every stretch the board kept, for a duck_audio after the keep_lines: null
 * with fewer than 2 kept layers (keep_line's own dip covers one) or no dip (`to` null).
 * `kept` is [{layerId, from, to}] (scene seconds); `musicId` the music layer, `to` its dip.
 */
export function keptDuck(document, sceneId, kept, musicId, to) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  const layers = [...new Set(kept.map((entry) => entry.layerId))];
  // A music layer deleted since the board was saved has nothing to dip (and would refuse the edit).
  if (!scene || layers.length < 2 || !musicId || !isNumber(to) || !scene.layers.some((layer) => layer.id === musicId)) return null;
  const speech = {};
  for (const entry of kept) {
    const layer = scene.layers.find((item) => item.id === entry.layerId);
    if (!layer) continue;
    (speech[layer.id] ??= { words: [] }).words.push({ text: "line", start: round(mediaSoundTime(layer, entry.from)), end: round(mediaSoundTime(layer, entry.to)), p: 1 });
  }
  return { type: "duck_audio", sceneId, layerId: musicId, under: layers, to, speech };
}
