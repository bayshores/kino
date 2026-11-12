// A cut-out follows its clip's timing. cut_out makes a layer that sits on the clip's own frames:
// a media copy (subject, silhouette, matte) with the clip's Play fields, or an outline path whose
// shapes are keyed at the scene times the clip showed each frame. When the clip is retimed later
// (mediaStart, mediaOffset, speed, trim), the cut-out kept the old times and drew the subject of
// another moment: study c moved its clip 0.1 s earlier after cut_out output "outline", and the
// line sat beside the head (measured: every key one sampled frame late).
//
//   followClipTiming(scene, before, after)  after update_layer on clip `after` (was `before`):
//     a media copy that had the clip's old Play fields gets the new ones; an outline's path keys
//     move to the scene times the clip now shows the same file moments (keys it never shows go).
//   clipShowWindow(clip, sceneDuration)  the playback window an outline needs to show only when
//     its clip does: a clip whose Freeze is not "both" is not drawn before or after Play, but a
//     path is drawn the whole scene (run 6 probe: the last shot's outline over another shot at 10 s;
//     study b: "the side shot's band and outline over every frame"). null when the clip always shows.
import { effectiveMediaDuration, mediaSceneTime, mediaSoundTime } from "./playback.js";

/** The id part of an outline's fades where no subject is found (cutout-operation.mjs). */
export const LOST_FADE = "lost-fade-";
const PLAY_KEYS =["mediaStart", "mediaDuration", "mediaOffset", "mediaSpeed", "mediaReverse", "mediaFreeze", "mediaSourceDuration", "mediaFrameRate", "playbackWindows"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const FREEZE_SHOWS = { first: "before", last: "after", none: "during" };

export function clipShowWindow(clip, sceneDuration) {
  const media = clip.type === "video" || (clip.type === "image" && clip.mediaDuration > 0);
  const visibility = media ? FREEZE_SHOWS[clip.mediaFreeze ?? (clip.type === "video" ? "both" : "none")] : undefined;
  if (!visibility) return null;
  const start = Math.max(0, clip.mediaStart ?? 0), length = effectiveMediaDuration(clip);
  const end = Number.isFinite(length) ? start + length : Math.max(start, sceneDuration ?? start);
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, visibility, hold: false };
}

export function playChanged(before, after) {
  return PLAY_KEYS.some((key) => !same(before[key], after[key]));
}

function retimePath(animation, before, after) {
  const times = animation.keys?.length ? animation.keys.map((key) => animation.start + key.t * animation.duration) : [animation.start, animation.start + animation.duration];
  const paths = animation.keys?.length ? animation.keys.map((key) => key.value?.path) : [animation.from?.path, animation.to?.path];
  const moved = times.map((time, index) => ({ time: mediaSceneTime(after, mediaSoundTime(before, time)), path: paths[index] }))
    .filter((key) => key.time !== null && typeof key.path === "string")
    .map((key) => ({ ...key, time: Math.round(key.time * 1000) / 1000 }))
    .filter((key, index, all) => index === 0 || key.time > all[index - 1].time);
  if (!moved.length) return null;
  const start = moved[0].time, duration = Math.max(0.001, moved.at(-1).time - start);
  return { ...animation, start, duration, from: { ...animation.from, path: moved[0].path }, to: { ...animation.to, path: moved.at(-1).path },
    ...(moved.length > 2 ? { keys: moved.map((key) => ({ t: Math.min(1, (key.time - start) / duration), value: { path: key.path } })) } : { keys: undefined }) };
}

/** Moves the cut-outs of clip `after` (was `before`) in `scene` with its new timing. Changes them in place. */
export function followClipTiming(scene, before, after) {
  if ((after.type !== "video" && after.type !== "image") || !playChanged(before, after)) return;
  for (const layer of scene.layers) {
    if (layer.cutoutOf !== after.id || layer.id === after.id) continue;
    if (layer.type === "path") {
      layer.animations = (layer.animations ?? []).flatMap((animation) => {
        // Its fades where no subject is found stay on the same clip moment (the clip's own copied
        // moves and fades stay where the clip's do).
        if ((animation.kind === "in" || animation.kind === "out") && String(animation.id ?? "").includes(`.${LOST_FADE}`)) {
          const start = mediaSceneTime(after, mediaSoundTime(before, animation.start));
          return [start === null ? animation : { ...animation, start: Math.round(start * 1000) / 1000 }];
        }
        if (animation.kind !== "custom" || typeof animation.from?.path !== "string") return [animation];
        const moved = retimePath(animation, before, after);
        if (!moved) return [];
        if (!moved.keys) delete moved.keys;
        return [moved];
      });
      // Its show window (clipShowWindow) moves to the clip's new Play range.
      const old = clipShowWindow(before, scene.duration), now = clipShowWindow(after, scene.duration);
      const windows = (layer.playbackWindows ?? []).filter((window) => !(old && same(window, old)));
      if (old || now) layer.playbackWindows = now ? [...windows, now] : windows;
      continue;
    }
    // A copy that still had the clip's old timing takes the new one (one retimed on its own keeps its own).
    if (PLAY_KEYS.every((key) => same(layer[key], before[key]))) {
      for (const key of PLAY_KEYS) if (after[key] !== undefined) layer[key] = structuredClone(after[key]);
      // Its subject's path (scene seconds, place {around} reads it) moves to the times the clip
      // now shows the same file moments; samples it no longer shows go.
      if (Array.isArray(layer.subjectPath)) {
        const path = layer.subjectPath.map(([time, ...box]) => [mediaSceneTime(after, mediaSoundTime(before, time)), ...box])
          .filter(([time]) => time !== null).map(([time, ...box]) => [Math.round(time * 1000) / 1000, ...box]).sort((a, b) => a[0] - b[0]);
        if (path.length) layer.subjectPath = path;
        else delete layer.subjectPath;
      }
    }
  }
}
