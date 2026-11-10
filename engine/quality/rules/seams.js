// seam_lock and rest_fit: the picture keeps time with the song's seams.
//
// fit_music writes the song's seams as marker cues song-<kind>-<n> at the time each is heard (a
// section edge, a dropout and its return, a filter return, a voice coming in, a beat switch).
// Top music edits lock every seam within one video frame, and when the music rests the picture
// adds no energy and starts again on the return frame (black, a freeze or a held shot are all
// fine; black is not required). These two rules measure that from the document:
//   seam_lock  a picture change near a seam (within 0.2 s) lands within 1 frame of it, and a drop
//              or a return is marked by a change at all
//   rest_fit   inside a dropout no cut, accent or fast move of a large picture starts, and the
//              picture restarts within 1 frame of the return
// With no song cues (no fit_music) both say nothing. Frames are counted at the output rate: the
// frame the seam is heard in against the first frame that shows the change.
import { techniqueOf } from "../../techniques.js";
import { motions, sec, speedAt } from "../analysis.js";
import { itemById } from "../model.js";
import { techniquesUsed } from "../techniques.js";

// A change this many frames from a seam is on it.
const SLACK = 1;
// A change this close to a seam (seconds) was meant for it: further off it is a cut on action.
const NEAR = 0.2;
// Seams a change must mark: the music coming in hard.
const MUST_MARK = new Set(["drop", "return"]);
// Song cues that are not seams to cut on: where the song ends or fades out.
const NOT_SEAMS = new Set(["ending", "fade"]);
// A rest of the music lasts at most this long (song-shape.mjs REST_SECONDS, plus a frame).
const REST_LONGEST = 4.05;
// After the return, the picture restarts within this long or it missed the return.
const RESTART = 0.5;
// Fast inside a rest: a large picture (20% of the frame) moving this many frame widths a second,
// or growing or shrinking this share of its size a second.
const FAST_MOVE = 0.25;
const FAST_SCALE = 0.3;
const LARGE = 0.2;
// Uses that are no change of the picture (a long hold, cut timing, a look over the whole shot).
const AMBIENT = new Set(["hold", "beat-cut", "syncopated", "grain", "vignette", "depth-blur"]);
// What a rest may hold: a slow camera, a fade to black, a freeze or a slowdown.
const RESTFUL = new Set(["slow-push", "drift", "fade-black", "freeze-frame", "speed-ramp", "motion-blur"]);
const isType = (tag) => techniqueOf(tag)?.group === "type";

const SONG = /^song-(.+)-(\d+)$/;
/** The song cues inside the video, as seams [{name, kind, at}] in time order. */
function songSeams(model, ctx) {
  const step = 1 / model.fps;
  return (ctx.cues ?? []).map((cue) => {
    const match = SONG.exec(String(cue?.name ?? ""));
    return match && Number.isFinite(cue.time) ? { name: cue.name, kind: match[1], at: cue.time } : null;
  }).filter((seam) => seam && !NOT_SEAMS.has(seam.kind) && seam.at > step && seam.at < model.duration - step).sort((a, b) => a.at - b.at);
}

/** Each dropout and the cue that ends it (its return, or the section the sound comes back on). */
function restsOf(seams) {
  return seams.filter((seam) => seam.kind === "dropout").map((out) => {
    const back = seams.find((seam) => seam.at > out.at && seam.kind !== "dropout" && seam.kind !== "vocal-in");
    return back && back.at - out.at <= REST_LONGEST ? { out, back } : null;
  }).filter(Boolean);
}

// The output frame a time falls in, and the first output frame that shows a change at a time.
const frameOf = (time, fps) => Math.floor(time * fps + 1e-6);
const shownFrom = (time, fps) => Math.ceil(time * fps - 1e-3);

/**
 * The picture changes the document makes: [{tag, at, itemId?}] by time. A shot change is timed by
 * the layer's own start when the model's sample is the first after it (exact to the frame, even
 * when the model samples at 15 fps); a use is otherwise timed at its sample.
 */
function pictureChanges(model, ctx) {
  const step = 1 / model.fps;
  const starts = new Map((ctx.scene?.layers ?? []).map((layer) => [layer.id, layer.start]));
  const timed = (at, itemId) => {
    const sample = Math.round(at * model.fps) / model.fps;
    const start = starts.get(itemId);
    return Number.isFinite(start) && start > sample - step - 1e-6 && start <= sample + 1e-6 ? start : sample;
  };
  const found = [];
  for (const [tag, uses] of Object.entries(techniquesUsed(model))) {
    if (AMBIENT.has(tag)) continue;
    for (const use of uses) found.push({ tag, at: timed(use.at, use.itemId), ...(use.itemId ? { itemId: use.itemId } : {}) });
  }
  return found.sort((a, b) => a.at - b.at);
}

const frames = (count) => `${Math.abs(count)} frame${Math.abs(count) === 1 ? "" : "s"}`;
const side = (count) => `${frames(count)} ${count > 0 ? "late" : "early"}`;
const what = (change) => (change.tag === "cut" ? "cut" : change.tag);

/** seam_lock: a picture change near a song seam lands within 1 frame of it; a drop or a return is marked. */
export function seamLock(model, ctx) {
  const seams = songSeams(model, ctx);
  if (!seams.length) return [];
  const fps = ctx.outputFps ?? 30;
  // A dropout and its return are rest_fit's.
  const owned = new Set(restsOf(seams).flatMap(({ out, back }) => [out.name, back.name]));
  const changes = pictureChanges(model, ctx).filter((change) => !isType(change.tag));
  const findings = [];
  for (const seam of seams) {
    if (owned.has(seam.name)) continue;
    const near = changes.filter((change) => Math.abs(change.at - seam.at) <= NEAR + 1e-6)
      .map((change) => ({ ...change, off: shownFrom(change.at, fps) - frameOf(seam.at, fps) }));
    if (near.some((change) => Math.abs(change.off) <= SLACK)) continue;
    const label = seam.kind.replace(/-/g, " ");
    if (near.length) {
      const miss = near.sort((a, b) => Math.abs(a.off) - Math.abs(b.off))[0];
      findings.push({
        rule: "seam_lock", severity: "warn", at: sec(seam.at), itemId: miss.itemId,
        measured: `${seam.name} at ${sec(seam.at)} s: ${what(miss)} at ${sec(miss.at)} s, ${side(miss.off)}`,
        required: `a picture change within ${SLACK} frame of each song seam`,
        message: `The ${what(miss)} at ${sec(miss.at)} s in ${ctx.sceneName} lands ${frames(miss.off)} ${miss.off > 0 ? "after" : "before"} the song's ${label} at ${sec(seam.at)} s; a change that just misses the seam reads as sloppy.`,
        fix: { kind: "hint", text: `Put it on the seam (start the shot at ${sec(seam.at)} s, cue ${seam.name}), or move it a beat away so it reads as a cut on the action.` },
      });
    } else if (MUST_MARK.has(seam.kind)) {
      findings.push({
        rule: "seam_lock", severity: "warn", at: sec(seam.at),
        measured: `${seam.name} at ${sec(seam.at)} s: no picture change within ${NEAR} s`,
        required: `a drop or a return marked by a picture change within ${SLACK} frame`,
        message: `The song's ${label} at ${sec(seam.at)} s passes with no change in the picture of ${ctx.sceneName}.`,
        fix: { kind: "hint", text: `Cut to a new shot at ${sec(seam.at)} s (cue ${seam.name}), or start a move there.` },
      });
    }
  }
  return findings.slice(0, 8);
}

// The first sample a large picture moves fast inside [from, to] (sample indexes), or null.
function fastMove(model, item, from, to) {
  const { x0, y0, x1, y1, opacity, scale } = item.samples;
  for (let index = Math.max(1, from); index <= to; index += 1) {
    if (opacity[index] < 0.5 || ((x1[index] - x0[index]) * (y1[index] - y0[index])) / (model.width * model.height) < LARGE) continue;
    const growth = Math.abs(scale[index] / Math.max(1e-6, scale[index - 1]) - 1) * model.fps;
    const speed = speedAt(model, item, index);
    if (speed >= FAST_MOVE || growth >= FAST_SCALE) return { index, speed, growth };
  }
  return null;
}

/** rest_fit: inside a dropout the picture adds no energy, and it restarts within 1 frame of the return. */
export function restFit(model, ctx) {
  const seams = songSeams(model, ctx);
  const rests = restsOf(seams);
  if (!rests.length) return [];
  const fps = ctx.outputFps ?? 30;
  const changes = pictureChanges(model, ctx);
  // Restarts: any change of the picture, a text's entrance or any layer starting to move.
  const restarts = [...changes, ...motions(model).map((motion) => ({ tag: "move", at: motion.start, itemId: motion.itemId }))];
  const findings = [];
  for (const { out, back } of rests) {
    const [first, last] = [frameOf(out.at, fps) + SLACK + 1, frameOf(back.at, fps) - SLACK - 1];
    const span = `${sec(out.at)} to ${sec(back.at)} s`;
    const inside = (time) => shownFrom(time, fps) >= first && shownFrom(time, fps) <= last;
    const added = changes.filter((change) => !RESTFUL.has(change.tag) && !isType(change.tag) && inside(change.at))
      .map((change) => ({ at: change.at, itemId: change.itemId, text: `${what(change)} at ${sec(change.at)} s` }));
    const [lo, hi] = [Math.ceil((first / fps) * model.fps), Math.floor((last / fps) * model.fps)];
    for (const item of model.items) {
      if (item.isMask || item.kind === "text" || item.kind === "group") continue;
      const fast = fastMove(model, item, lo, hi);
      if (fast) added.push({ at: model.times[fast.index], itemId: item.id, text: `${ctx.name(item)} ${fast.speed >= FAST_MOVE ? `moving ${sec(fast.speed)} frame widths a second` : `scaling ${Math.round(fast.growth * 100)}% a second`} at ${sec(model.times[fast.index])} s` });
    }
    added.sort((a, b) => a.at - b.at);
    if (added.length) {
      const early = added.filter((entry) => back.at - entry.at <= RESTART);
      findings.push({
        rule: "rest_fit", severity: "warn", at: sec(added[0].at), until: sec(back.at), itemId: added[0].itemId,
        measured: `the music rests ${span} (${out.name} to ${back.name}): ${added.slice(0, 3).map((entry) => entry.text).join(", ")}${added.length > 3 ? `, +${added.length - 3} more` : ""}`,
        required: "while the music rests the picture adds no energy (a hold, a freeze, a slow push or black)",
        message: `${ctx.sceneName} adds energy while the song rests (${span})${early.length === added.length ? `: it restarts ${frames(shownFrom(early[0].at, fps) - frameOf(back.at, fps))} before the return` : ""}; the rest only lands when the picture rests with it.`,
        fix: { kind: "hint", text: `Hold the picture through the rest (a freeze, a held shot or black) and put the next cut or move at ${sec(back.at)} s (cue ${back.name}).` },
      });
    }
    const near = restarts.filter((entry) => Math.abs(shownFrom(entry.at, fps) - frameOf(back.at, fps)) <= SLACK);
    if (near.length) continue;
    const late = restarts.filter((entry) => entry.at > back.at && entry.at <= back.at + RESTART).sort((a, b) => a.at - b.at)[0];
    const lateBy = late ? shownFrom(late.at, fps) - frameOf(back.at, fps) : 0;
    const item = late?.itemId ? itemById(model, late.itemId) : null;
    findings.push({
      rule: "rest_fit", severity: "warn", at: sec(back.at), ...(item ? { itemId: item.id } : {}),
      measured: late ? `${back.name} at ${sec(back.at)} s: the picture restarts at ${sec(late.at)} s (${late.tag}), ${frames(lateBy)} late` : `${back.name} at ${sec(back.at)} s: nothing in the picture restarts within ${RESTART} s`,
      required: `the picture restarts within ${SLACK} frame of the return`,
      message: late ? `The picture of ${ctx.sceneName} comes back ${frames(lateBy)} after the music returns at ${sec(back.at)} s; the restart should hit with the sound.` : `The music returns at ${sec(back.at)} s but the picture of ${ctx.sceneName} carries on as before; restart it on the return.`,
      fix: { kind: "hint", text: `Start the next shot or move at ${sec(back.at)} s (cue ${back.name}).` },
    });
  }
  return findings.slice(0, 8);
}
