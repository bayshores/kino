// Sync rule: a line heard over a picture of another moment, when the two files were filmed
// together. It came from a trailer: the app's screen recording (the app's voice) and the phone
// filming the walk were synced, then the walk footage was replaced, and "bear left." played over
// a straight walk with nothing in the way.
//   out_of_sync  a layer of file A is heard and a layer of file B is the picture (over 25% of the
//                frame, not covered), A and B are linked (document.clipLinks, written by
//                sync_clips), and their file times differ by over 0.25 s from the link (gate),
//                or B's file has no frame of that moment. Left alone: a J or L cut under 1 s, and
//                clips slowed, sped up or reversed (the moment is stretched on purpose).
//
// The agent service hands in ctx.clipLinks (the document's) and ctx.scene (the raw scene).
// Without them the rule does not run. Copies of a component are left out (their clock differs).
import { volumeAt } from "../../animation.js";
import { linkLag } from "../../clipSync.js";
import { fileSecondsPlayed, isRemapped } from "../../mediaTime.js";
import { effectiveMediaDuration, mediaFrameState, mediaSoundTime } from "../../playback.js";
import { audibleRanges, heardAt, shownWithGroups } from "../../videoSound.js";
import { sec } from "../analysis.js";
import { area, intersection, runs, visibleBoxAt } from "../model.js";
import { coveredAt } from "../techniques.js";

// How far apart (seconds of file) the line and the picture may be before they read as two moments.
export const SYNC_TOLERANCE = 0.25;
// The share of the frame a clip must fill to read as the picture.
const PICTURE_SHARE = 0.25;
// Quieter than this (volume 0 to 1) the line is not heard.
const AUDIBLE = 0.05;
// A mismatch shorter than this is a cut's edge, not a moment.
const MIN_RUN = 0.2;
// A J or L cut (the line leads into the next shot or runs on over it) shorter than this is left alone.
const CUT_OVERLAP = 1;
// An auto fix re-picks the shot only when the mismatch is at least this share of the time it is shown.
const MOST_SHOWN = 0.5;

const plays = (layer) => (layer.type === "audio" || layer.type === "video") && Boolean(layer.src) && layer.enabled !== false;

/** out_of_sync: the sound of one file over the picture of a file filmed with it, from another moment. */
export function outOfSync(model, ctx) {
  const links = ctx.clipLinks ?? [];
  const scene = ctx.scene;
  if (!links.length || !scene) return [];
  const frame = { x0: 0, y0: 0, x1: model.width, y1: model.height };
  const frameArea = model.width * model.height;
  const linked = new Set(links.flatMap((link) => [link.a, link.b]));
  const heard = scene.layers.filter((layer) => plays(layer) && linked.has(layer.src) && shownWithGroups(scene.layers, layer))
    .map((layer) => ({ layer, ranges: audibleRanges(scene.layers, layer, scene.duration) }))
    .filter((entry) => entry.ranges.length);
  const shown = model.items.filter((item) => item.kind === "video" && linked.has(item.src) && !item.source?.componentPath)
    .map((item) => ({ item, layer: scene.layers.find((layer) => layer.id === item.source?.layerId) }))
    .filter((entry) => entry.layer?.src);
  const pairs = [];
  for (const sound of heard) for (const picture of shown) {
    // Slowed, sped up or reversed on purpose: the moment is stretched, so file times drift (sync_clips needs speed 1).
    if (isRemapped(sound.layer) || isRemapped(picture.layer)) continue;
    const lag = sound.layer.src === picture.layer.src ? null : linkLag(links, sound.layer.src, picture.layer.src);
    if (lag !== null) pairs.push({ sound, picture, lag, samples: [], heard: [], pictured: [] });
  }
  // Each sample of each pair: the sound's file time, the picture's, and the picture time that matches.
  const shifts = new Map();
  for (const pair of pairs) {
    const { sound, picture, lag } = pair;
    const fileLength = picture.layer.mediaSourceDuration > 0 ? picture.layer.mediaSourceDuration : Infinity;
    pair.samples = model.times.map((t, index) => {
      pair.heard[index] = heardAt(sound.ranges, t) && volumeAt(sound.layer, t) > AUDIBLE;
      const state = mediaFrameState(picture.layer, t);
      pair.pictured[index] = picture.item.samples.opacity[index] >= 0.5 && !coveredAt(model, picture.item, index) && state.playing
        && area(intersection(visibleBoxAt(model, picture.item, index), frame)) / frameArea > PICTURE_SHARE;
      if (!pair.heard[index] || !pair.pictured[index]) return null;
      const heardTime = mediaSoundTime(sound.layer, t);
      const wanted = heardTime + lag;
      // The picture's file has no frame of that moment (filmed before or after it): always another moment.
      if (wanted < 0 || wanted > fileLength) return { t, heardTime, shownTime: state.sourceTime, wanted, outside: true };
      const shift = wanted - state.sourceTime;
      if (!shifts.has(picture.layer.id)) shifts.set(picture.layer.id, []);
      shifts.get(picture.layer.id).push(shift);
      return { t, heardTime, shownTime: state.sourceTime, wanted, shift };
    });
  }
  // Layers whose own sound is held to a picture: moving them would move that line too.
  const heardIds = new Set(pairs.filter((pair) => pair.samples.some(Boolean)).map((pair) => pair.sound.layer.id));
  const findings = [];
  const shortest = Math.max(1, Math.round(MIN_RUN * model.fps));
  const lead = Math.round(CUT_OVERLAP * model.fps);
  for (const pair of pairs) {
    const { sound, picture, samples } = pair;
    const shownFor = pair.pictured.filter(Boolean).length;
    const mismatch = (index) => Boolean(samples[index]) && (samples[index].outside || Math.abs(samples[index].shift) > SYNC_TOLERANCE);
    for (const run of runs(samples.length, mismatch)) {
      if (run.length < shortest) continue;
      // A J or L cut: the line starts while the last shot is still on, or runs on over the next one.
      // One end of the run is the line's edge and the other the picture's, and it is short.
      const lineEdge = (index) => index >= 0 && index < samples.length && !pair.heard[index];
      const pictureEdge = (index) => index >= 0 && index < samples.length && !pair.pictured[index];
      const before = run.from - 1, after = run.to + 1;
      if (run.length < lead && ((lineEdge(before) && pictureEdge(after)) || (pictureEdge(before) && lineEdge(after)))) continue;
      const first = samples[run.from];
      const last = samples[run.to];
      const layer = picture.layer;
      const soundName = `"${sound.layer.name ?? sound.layer.id}"`;
      const pictureName = ctx.name(picture.item);
      const offset = Math.max(0, layer.mediaOffset ?? 0);
      const start = layer.mediaStart ?? 0;
      const inside = samples.slice(run.from, run.to + 1).find((sample) => !sample.outside);
      let fix;
      let advice = "";
      if (!inside) {
        fix = { kind: "hint", text: `${pictureName}'s file has no frame of that moment (it was filmed before or after it). Cut the line together with its moment (trim ${soundName} to the stretch the picture shows), or show another shot under the line.` };
      } else {
        const fileLength = layer.mediaSourceDuration > 0 ? layer.mediaSourceDuration : Infinity;
        const mediaOffset = Math.round((offset + inside.shift) * 1000) / 1000;
        if (mediaOffset < 0) {
          // The moment is in the file, but the clip starts too early in the scene to reach it: start it later.
          const mediaStart = Math.round((start - mediaOffset) * 1000) / 1000;
          fix = { kind: "layer", layerId: layer.id, properties: { mediaStart, mediaOffset: 0 }, auto: false };
          advice = ` Start ${pictureName} at ${mediaStart} s of the scene with mediaOffset 0, or cut the line with its moment.`;
        } else {
          // The file seconds the clip reads inside the scene: they must still be in the file once moved.
          const span = fileSecondsPlayed(layer, Math.max(0, Math.min(start + effectiveMediaDuration(layer), scene.duration) - Math.max(0, start)));
          // Safe alone: the whole clip plays inside its file, it is no line itself, every line heard
          // over it asks for the same move (no other layer depends on where it is now), and the
          // mismatch is half the time it is shown or more (never re-pick a whole shot for a lead-in or tail).
          const asked = shifts.get(layer.id) ?? [];
          const safe = mediaOffset < fileLength && mediaOffset + span <= fileLength + 1e-6 && !heardIds.has(layer.id)
            && Math.max(...asked) - Math.min(...asked) <= SYNC_TOLERANCE && run.length >= MOST_SHOWN * shownFor;
          fix = { kind: "layer", layerId: layer.id, properties: { mediaOffset }, auto: safe };
          advice = ` Retime ${pictureName} to mediaOffset ${mediaOffset} (now ${sec(offset)}), or cut the line with its moment.`;
        }
      }
      findings.push({
        rule: "out_of_sync", severity: "error", itemId: picture.item.id, layerId: sound.layer.id, at: sec(first.t), until: sec(last.t),
        message: `The line heard here (${soundName}) is from ${sec(first.heardTime)} s of its recording, but the picture shown (${pictureName}) is from ${sec(first.shownTime)} s: they were filmed together, so the picture is from another moment.${advice}`,
        measured: `${sec(first.t)} to ${sec(last.t)} s: ${soundName} at ${sec(first.heardTime)} s of its file, ${pictureName} at ${sec(first.shownTime)} s; filmed together, the picture of that moment is ${sec(first.wanted)} s (${sec(Math.abs(first.wanted - first.shownTime))} s apart)`,
        required: `a heard line over the picture of its own moment (within ${SYNC_TOLERANCE} s), or a picture filmed apart from it`,
        fix,
      });
    }
  }
  return findings;
}
