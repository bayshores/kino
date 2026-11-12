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
  for (const shot of fileShots.slice(1)) {
    const file = shot?.start;
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
      trim: side === "start" ? keepEnd : keepStart, ...(leak >= NEAR_CUT ? { other: side === "start" ? keepStart : keepEnd } : {}) });
  }
  return found;
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
  if (cuts.length > 1) return { shot: null, cuts, why: "more than one cut" };
  if (Array.isArray(shot.sound?.keep)) return { shot: null, cuts, why: "sound" };
  const [cut] = cuts;
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
    return `file ${sec(cut.file)} s lands at ${sec(cut.at)} s of the scene (${sec(cut.early)} s of the shot before it, ${sec(cut.late)} s of the next): ${trimText(cut.trim, cut.fields)}${other}`;
  });
  const more = cuts.length > 3 ? `; ${cuts.length - 3} more` : "";
  return `${name} plays across ${cuts.length === 1 ? "a cut" : `${cuts.length} cuts`} of its file, so frames of the other shot show: ${parts.join("; ")}${more}`;
}
