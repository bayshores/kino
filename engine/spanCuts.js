// Cuts of a video file that fall inside the stretch of it a layer (or a board shot) plays: the
// frames after the cut belong to another picture, so a span that runs across one shows a shot the
// director did not plan. The file's cuts are in file seconds (backend/shot-detection.mjs: each
// shot {start, end}); a span maps them onto the scene through the clip's offset, speed and
// reverse, as beats are (beatCues.js sceneTimes), so a cut in a slowed stretch lands later.
import { effectiveMediaDuration, mediaPlaybackRange, mediaSceneTime, mediaSoundTime } from "./playback.js";
import { isReversed } from "./mediaTime.js";
import { speedAnimations } from "./animation.js";
import { round } from "./numbers.js";

// A span that crosses a cut by less than this many scene seconds at either end is moved off it
// by a board (the crossing is a leak of a few frames); a longer crossing is only stated.
export const NEAR_CUT = 0.25;
// A trim stops this far (file seconds) short of the cut, so no frame of the other shot is sampled.
export const TRIM_MARGIN = 0.01;
// A cut this close to a span's end is not inside it.
const EDGE = 0.01;

/**
 * The cuts of `fileShots` ([{start, end}] in file seconds) inside a span. The span is
 * { from, to, start, end, sceneAt(file), reversed? }: file seconds played (from < to), the scene
 * seconds it plays in (start < end; a reversed clip plays `to` first) and the scene second a file
 * second lands on. Each cut: { file, at (scene second), early, late (scene seconds of the span
 * on the file-start side and the file-end side of the cut), side ("start" or "end": the file side
 * that is shorter on screen, the leak), leak (its scene seconds), trim: {in} or {out} (the file
 * second that puts the span on the near side of the cut, TRIM_MARGIN away) }.
 */
export function spanCuts(span, fileShots) {
  if (!Array.isArray(fileShots)) return [];
  const found = [];
  for (const { file, edge } of fileCuts(fileShots)) {
    if (!Number.isFinite(file) || file <= span.from + EDGE || file >= span.to - EDGE) continue;
    const at = span.sceneAt(file);
    if (!Number.isFinite(at)) continue;
    const before = at - span.start, after = span.end - at;
    const early = span.reversed ? after : before, late = span.reversed ? before : after;
    const side = early <= late ? "start" : "end";
    // Both sides of a long crossing are real footage, so either may be the planned shot: `other`
    // is the trim that keeps the shorter side instead.
    const keepStart = { out: round(file - TRIM_MARGIN) }, keepEnd = { in: round(file + TRIM_MARGIN) };
    const leak = round(Math.min(early, late));
    found.push({ file: round(file), at: round(at), early: round(early), late: round(late), side, leak,
      trim: side === "start" ? keepEnd : keepStart, ...(leak >= NEAR_CUT ? { other: side === "start" ? keepStart : keepEnd } : {}),
      ...(edge ? { edge } : {}) });
  }
  return found;
}

/**
 * Where a file's picture changes, sorted, in file seconds: [{file, edge?}]. Each shot's start
 * after the first, and the bounds of a shot's edge frames (shot.edge {head, tail, start, end}
 * from the shot finder: a whip, a flash frame, a black frame or a one-frame card at a shot's start
 * or end); `edge` is how many frames lie on the far side of that bound.
 */
export function fileCuts(fileShots) {
  if (!Array.isArray(fileShots)) return [];
  const cuts = fileShots.slice(1).map((shot) => ({ file: shot?.start }));
  for (const shot of fileShots) {
    const edge = shot?.edge;
    if (!edge) continue;
    if (edge.head > 0 && Number.isFinite(edge.start)) cuts.push({ file: edge.start, edge: edge.head });
    if (edge.tail > 0 && Number.isFinite(edge.end)) cuts.push({ file: edge.end, edge: edge.tail });
  }
  return cuts.filter((cut) => Number.isFinite(cut.file)).sort((a, b) => a.file - b.file);
}

/**
 * The edge frames of a file's shots (shot.edge from the shot finder), in file seconds:
 * [{from, to, frames, where: "start" | "end"}], sorted. [] when none are marked.
 */
export function edgeSpans(fileShots) {
  if (!Array.isArray(fileShots)) return [];
  const spans = [];
  for (const shot of fileShots) {
    const edge = shot?.edge;
    if (!edge || !Number.isFinite(shot.start) || !Number.isFinite(shot.end)) continue;
    if (edge.head > 0 && Number.isFinite(edge.start)) spans.push({ from: shot.start, to: edge.start, frames: edge.head, where: "start" });
    if (edge.tail > 0 && Number.isFinite(edge.end)) spans.push({ from: edge.end, to: shot.end, frames: edge.tail, where: "end" });
  }
  return spans.sort((a, b) => a.from - b.from);
}

/**
 * The cut whose trim leaves out every short crossing on one side of a span: of the cut with the
 * least leak and the other cuts on its side under NEAR_CUT (a cut and the edge frames beside it),
 * the one with the most leak. null for no cuts.
 */
export function farthestCut(cuts) {
  if (!cuts?.length) return null;
  const least = cuts.reduce((top, cut) => (cut.leak < top.leak ? cut : top));
  return cuts.filter((cut) => cut === least || (cut.side === least.side && cut.leak < NEAR_CUT))
    .reduce((top, cut) => (cut.leak > top.leak ? cut : top));
}

/**
 * The cuts inside what a video layer plays: { cuts, fields } where `fields` (per cut, only for a
 * forward clip at a constant speed) are the layer fields that apply the trim, keeping the layer's
 * start (end side) or its end (start side). [] when the file's cuts are not known.
 */
export function layerSpanCuts(layer, fileShots, sceneDuration) {
  if (layer?.type !== "video" || !Array.isArray(fileShots)) return [];
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range) return [];
  const reversed = isReversed(layer);
  // The stretch of the file played: straight from the offset, or through the clip's time map.
  const sceneAt = range.remapped ? (file) => mediaSceneTime(layer, file) ?? NaN : (file) => range.start + (file - range.offset);
  let from = range.offset, to = range.offset + range.duration;
  if (range.remapped) {
    const ends = [mediaSoundTime(layer, range.start), mediaSoundTime(layer, range.end)];
    from = Math.min(...ends); to = Math.max(...ends);
  }
  const cuts = spanCuts({ from, to, start: range.start, end: range.end, sceneAt, reversed }, fileShots);
  const plain = !reversed && speedAnimations(layer).length === 0;
  // The layer's own start and end, which can sit before the scene's start or after its end
  // (the range is clipped to the scene): mediaDuration counts from mediaStart.
  const layerStart = layer.mediaStart ?? 0;
  const played = effectiveMediaDuration(layer);
  const layerEnd = Number.isFinite(played) ? layerStart + played : range.end;
  const fieldsFor = (trim) => (trim.out !== undefined
    ? { mediaDuration: round(sceneAt(trim.out) - layerStart) }
    : { mediaOffset: trim.in, mediaStart: round(sceneAt(trim.in)), mediaDuration: round(layerEnd - sceneAt(trim.in)) });
  return cuts.map((cut) => (plain ? { ...cut, fields: fieldsFor(cut.trim), ...(cut.other ? { otherFields: fieldsFor(cut.other) } : {}) } : cut));
}

// Picture changes closer than this (file seconds, about 6 frames at 24 fps) are one run: a montage.
export const MONTAGE_GAP = 0.25;

/**
 * The picture changes inside one saved shot (shot.changes from the shot finder: a montage of
 * 1 to 5 frame shots, a short cutaway) that a forward, constant-speed video layer shows, as runs:
 * { runs: [{from, to, count, at, until}], move } or null when it shows none. A run is changes
 * under MONTAGE_GAP apart: file seconds from the first change to the last, `count` changes, scene
 * seconds `at`..`until`. `move` is the one call's fields that show the same length from the
 * nearest clean stretch of the same shot (between its start, its changes, its edge frames and its
 * end), {mediaOffset} keeping mediaStart and mediaDuration, with that stretch {from, to}; or the
 * longest clean stretch inside the shown span when none is long enough: {mediaOffset, mediaStart,
 * mediaDuration} for it. A change at an edge-frame bound is left to spanCuts.
 */
export function layerSpanChanges(layer, fileShots, sceneDuration) {
  if (layer?.type !== "video" || !Array.isArray(fileShots) || isReversed(layer) || speedAnimations(layer).length) return null;
  const range = mediaPlaybackRange(layer, sceneDuration);
  if (!range || range.remapped) return null;
  const from = range.offset, to = range.offset + range.duration;
  const sceneAt = (file) => range.start + (file - range.offset);
  const shot = fileShots.find((each) => Number.isFinite(each?.start) && each.start <= from + EDGE && each.end >= to - EDGE);
  if (!shot || !Array.isArray(shot.changes)) return null;
  const edges = new Set([shot.edge?.start, shot.edge?.end].filter(Number.isFinite).map((value) => round(value)));
  const changes = shot.changes.filter((file) => Number.isFinite(file) && !edges.has(round(file))).sort((a, b) => a - b);
  const inside = changes.filter((file) => file > from + EDGE && file < to - EDGE);
  if (!inside.length) return null;
  const runs = [];
  for (const file of inside) {
    const run = runs.at(-1);
    if (run && file - run.to < MONTAGE_GAP) { run.to = file; run.count += 1; } else runs.push({ from: file, to: file, count: 1 });
  }
  for (const run of runs) { run.at = round(sceneAt(run.from)); run.until = round(sceneAt(run.to)); }
  // The clean stretches of the shot: between its body's ends and each change.
  const bounds = [shot.edge?.start ?? shot.start, ...changes, shot.edge?.end ?? shot.end];
  const stretches = bounds.slice(1).map((end, index) => ({ from: bounds[index], to: end })).filter((stretch) => stretch.to > stretch.from);
  const length = to - from;
  const fits = stretches.filter((stretch) => stretch.to - stretch.from >= length + 2 * TRIM_MARGIN);
  let move;
  if (fits.length) {
    const near = fits.reduce((best, stretch) => (Math.abs(stretch.from - from) < Math.abs(best.from - from) ? stretch : best));
    // The layer's own offset moves by as much as its shown span does (the span may start after it).
    const offset = round((layer.mediaOffset ?? 0) + near.from + TRIM_MARGIN - from);
    move = { from: round(near.from), to: round(near.to), fields: { mediaOffset: offset } };
  } else {
    const shown = stretches.map((stretch) => ({ from: Math.max(stretch.from, from), to: Math.min(stretch.to, to) })).filter((stretch) => stretch.to > stretch.from);
    const longest = shown.reduce((best, stretch) => (stretch.to - stretch.from > best.to - best.from ? stretch : best), shown[0]);
    const offset = round(longest.from + (longest.from > from ? TRIM_MARGIN : 0));
    move = { from: round(longest.from), to: round(longest.to), fields: { mediaOffset: offset, mediaStart: round(sceneAt(offset)), mediaDuration: round(longest.to - TRIM_MARGIN - offset) } };
  }
  return { runs, move, shown: { from: round(from), to: round(to) } };
}

/**
 * The cuts inside a board shot's span: its file seconds are in .. in + dur × speed, played from
 * its cue. Same answer as spanCuts. [] for a shot with no video span.
 */
export function shotSpanCuts(shot, fileShots) {
  if (!Number.isFinite(shot?.in) || !(shot.dur > 0)) return [];
  const speed = shot.speed > 0 ? shot.speed : 1;
  return spanCuts({ from: shot.in, to: shot.in + shot.dur * speed, start: shot.cue, end: shot.cue + shot.dur, sceneAt: (file) => shot.cue + (file - shot.in) / speed }, fileShots);
}

/**
 * A board shot moved off a cut it crosses by under `near` scene seconds at one end: the same
 * cue, length and speed, its in slid so the span ends before the cut (a cut near the end) or
 * begins after it (a cut near the start). { shot, cuts } where `shot` is the slid shot or null
 * and `cuts` the cuts the shot still crosses as saved (every cut when it is left as given).
 * `why` says why a short crossing was left: "more than one cut", "file", "sound" or "cut".
 * `fileDuration` bounds the slide; a shot that keeps the clip's own sound (sound.keep, in file
 * seconds, as a range) is left as given.
 */
export function slideOffCut(shot, fileShots, { fileDuration = 0, near = NEAR_CUT } = {}) {
  const cuts = shotSpanCuts(shot, fileShots);
  const short = cuts.filter((cut) => cut.leak < near);
  if (!short.length) return { shot: null, cuts };
  // A cut and the edge frames next to it (a whip or black frames at the next shot's head) are one
  // short crossing on one side: the shot slides past the farthest of them.
  const oneSide = short.length === cuts.length && short.every((cut) => cut.side === short[0].side);
  if (cuts.length > 1 && !oneSide) return { shot: null, cuts, why: "more than one cut" };
  if (Array.isArray(shot.sound?.keep)) return { shot: null, cuts, why: "sound" };
  const cut = farthestCut(cuts);
  const length = shot.dur * (shot.speed > 0 ? shot.speed : 1);
  const slid = round(cut.trim.in !== undefined ? cut.trim.in : cut.trim.out - length);
  if (slid < 0 || (fileDuration > 0 && slid + length > fileDuration + 1e-6)) return { shot: null, cuts, why: "file" };
  const moved = { ...shot, in: slid };
  if (shotSpanCuts(moved, fileShots).length) return { shot: null, cuts, why: "cut" };
  return { shot: moved, cuts: [], was: cut };
}

const sec = (value) => round(value, 2);

/**
 * The fact for one span that crosses cuts, one line: the file second of each cut, the scene
 * second it lands on, and the trim that ends the span on the near side of it (for a long
 * crossing, then the trim that keeps the other side). `name` is the layer or shot; a cut's
 * `fields` and `otherFields` name the layer fields that make each trim.
 */
export function spanCutLine(name, cuts) {
  const trimText = (trim, fields) => `${trim.in !== undefined ? `in ${trim.in} s begins after it` : `out ${trim.out} s ends before it`}${fields ? ` (${Object.entries(fields).map(([key, value]) => `${key} ${value}`).join(", ")})` : ""}`;
  const parts = cuts.slice(0, 3).map((cut) => {
    const other = cut.other ? `, or ${trimText(cut.other, cut.otherFields)}` : "";
    const edge = cut.edge ? ` (${cut.edge} edge frame${cut.edge === 1 ? "" : "s"} of a whip, flash, black or card past it)` : "";
    return `file ${sec(cut.file)} s${edge} lands at ${sec(cut.at)} s of the scene (${sec(cut.early)} s of the shot before it, ${sec(cut.late)} s of the next): ${trimText(cut.trim, cut.fields)}${other}`;
  });
  const more = cuts.length > 3 ? `; ${cuts.length - 3} more` : "";
  return `${name} plays across ${cuts.length === 1 ? "a cut" : `${cuts.length} cuts`} of its file, so frames of the other shot show: ${parts.join("; ")}${more}`;
}
