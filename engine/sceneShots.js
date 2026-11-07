// The shots of a scene, in scene seconds: where its footage cuts. A look sheet gives every shot at
// least one tile, so a half-second shot is never missed between 12 evenly spread frames, and a long
// shot as many as 12 even frames would give it.
//
// A scene's picture changes at a video layer's Play range ends (one clip ends, the next begins)
// and at the cuts inside each clip's file, which kino finds when the file is imported
// (backend/shot-detection.mjs: each file shot is {start, end} in file seconds). The file cuts are
// moved onto the scene through the clip's offset, speed and reverse (beatCues.js sceneTimes), as
// beats are.
import { mediaPlaybackRange } from "./playback.js";
import { sceneTimes } from "./beatCues.js";
import { round } from "./numbers.js";

// The shortest scene shot: a shorter stretch joins the shot before it (the first, the one after).
// Six frames at 30 fps, as the shot finder's shortest shot, so the sliver of black after a clip
// ends 0.08 s before the scene does is not a shot of its own.
export const SHORTEST_SHOT = 0.2;
// A sheet's tiles are shared out among its shots by length, as 12 even frames would be.
export const EVEN_TILES = 12;
// The most tiles one sheet shows; look sheet {from} shows the rest.
export const MOST_TILES = 24;

const sec = (seconds) => Number(seconds.toFixed(2));

/**
 * The scene's shots: { shots: [{start, end}], unknown: [layerId] }. `fileShots(layer)` gives a
 * video layer's file shots, or null when they are not known (the layer is then listed in
 * `unknown`, and only its Play range ends count as cuts).
 */
export function sceneShots(scene, fileShots) {
  const duration = scene.duration;
  const points = [];
  const unknown = [];
  for (const layer of scene.layers ?? []) {
    if (layer.type !== "video" || layer.visible === false) continue;
    const range = mediaPlaybackRange(layer, duration);
    if (!range) continue;
    for (const end of [range.start, range.end]) if (end > 0 && end < duration) points.push(round(end));
    const shots = fileShots(layer);
    if (!Array.isArray(shots)) { unknown.push(layer.id); continue; }
    const cuts = shots.slice(1).map((shot) => shot.start).filter(Number.isFinite);
    points.push(...sceneTimes(layer, duration, cuts));
  }
  // The scene's start is the first cut; a cut within SHORTEST_SHOT of the one before it, or of the
  // scene's end, is dropped.
  const starts = [0];
  for (const point of points.sort((a, b) => a - b)) {
    if (point - starts.at(-1) < SHORTEST_SHOT || duration - point < SHORTEST_SHOT) continue;
    starts.push(point);
  }
  const shots = starts.map((start, index) => ({ start, end: round(starts[index + 1] ?? duration) }));
  return { shots, unknown };
}

/**
 * The tiles a sheet shows for `shots`: those that overlap from–to, clipped to it, at most `limit`
 * shots. The tiles are shared out by length, as EVEN_TILES even frames would be, with at least one
 * a shot: a shot of a third of the scene gets 4, spread evenly through it (at the middles of equal
 * parts). Each tile keeps its shot's number in the whole scene, and its shot's start and end.
 * Returns { tiles: [{n, start, end, time}], total, shown } (total: how many shots overlap; shown:
 * how many have tiles).
 */
export function shotTiles(shots, { from = 0, to = Infinity, limit = MOST_TILES } = {}) {
  const parts = [];
  shots.forEach((shot, index) => {
    if (!(shot.end > from && shot.start < to)) return;
    parts.push({ n: index + 1, start: Math.max(shot.start, from), end: Math.min(shot.end, to) });
  });
  const shown = parts.slice(0, limit);
  const length = shown.reduce((total, part) => total + part.end - part.start, 0);
  const counts = shown.map((part) => Math.max(1, Math.round(((part.end - part.start) / length) * EVEN_TILES)));
  // Over the limit: the shot with the most tiles gives one up, until each has one.
  for (let extra = counts.reduce((total, count) => total + count, 0) - limit; extra > 0; extra -= 1) {
    const most = counts.indexOf(Math.max(...counts));
    if (counts[most] === 1) break;
    counts[most] -= 1;
  }
  const tiles = shown.flatMap((part, index) => Array.from({ length: counts[index] }, (_, at) => ({
    n: part.n, start: round(part.start), end: round(part.end), time: sec(part.start + ((at + 0.5) * (part.end - part.start)) / counts[index]),
  })));
  return { tiles, total: parts.length, shown: shown.length };
}
