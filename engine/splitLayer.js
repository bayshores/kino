// The agent's split_layer: a razor cut through a video, audio or GIF layer.
//
// split {at}: the layer keeps its Play up to `at` (scene seconds), and a copy right above it
// (duplicate.js, so groups and masks stay right) plays from `at`, reading the file from the
// moment the layer showed at `at`. The picture and sound are the same as before the cut.
// skip {from, to}: the same cut at `from`, and the copy then reads the file from the moment
// the layer showed at `to`: the file between is left out and the clip ends (to - from)
// seconds sooner. The copy's animations that start at or after `to` move (to - from) seconds
// earlier with the clip, so a fade-out timed to its old end still plays; other layers do not move.
//
// Freeze: the first piece keeps only the first-frame hold and the copy only the last-frame hold,
// so neither shows a held frame inside the other's Play.
//
// Animations are divided by time. Each piece keeps the ones that change what it shows: one that
// ends by `at` is dropped from the copy, and one that starts at or after `at` from the first
// piece, unless its held value still shows on that piece (a move that ended before the cut still
// places the copy). A crossing animation is kept on both, at the same scene times. Hide and Show
// are set for each piece's own span: the first piece loses those after `at` (a Hide that was due
// later moves to `at`), the copy keeps only the last one before `at` (moved to `at`) and a Hide
// past its end moves to its end.
import { duplicateSelection } from "./duplicate.js";
import { animatesSpeed, evaluateLayer } from "./animation.js";
import { animationPlaybackLength, effectiveMediaDuration, hasMediaPlay, mediaSoundTime } from "./playback.js";
import { isReversed } from "./mediaTime.js";
import { isVisibilityOperation, visibleByOperations } from "./visibilityOps.js";
import { MIN_PLAY_SECONDS } from "./mediaPlay.js";

const round = (value) => Math.round(value * 1e6) / 1e6 + 0;
const label = (layer) => `“${layer.name || layer.id}”`;

function freezeOf(layer) {
  return layer.mediaFreeze ?? (layer.type === "video" ? "both" : "none");
}

function animationEnd(layer, animation) {
  try { return animation.start + animationPlaybackLength(layer, animation); } catch { return animation.start + (animation.duration ?? 0); }
}

function valuesAt(layer, time) {
  try {
    // The layer's values at `time` (evaluateLayer copies the animations list too: not a value).
    const { animations: _list, ...values } = evaluateLayer(layer, time);
    return JSON.stringify(values);
  } catch { return null; }
}

// The animations of `layer` with those in `drop` (indexes) left out where `times` show no change.
function keptAnimations(layer, drop, times) {
  const reference = times.map((time) => valuesAt(layer, time));
  const dropped = new Set();
  for (const index of drop) {
    dropped.add(index);
    const trial = { ...layer, animations: layer.animations.filter((_, item) => !dropped.has(item)) };
    if (times.some((time, item) => reference[item] === null || valuesAt(trial, time) !== reference[item])) dropped.delete(index);
  }
  return dropped;
}

// Hide and Show operations of a piece, set for the piece's own span. Only plain top-level
// operations are touched (not a Show that holds a card with `keeps`).
const EPS = 1e-6;
const plainVisibility = (animation) => isVisibilityOperation(animation) && typeof animation.start === "number" && typeof animation.keeps !== "string";

// A piece that ends at `until`: operations after it can't change what it shows, so they go, and
// a Hide that was due later while the piece is shown moves to `until` (the one a cut-off piece
// shows no longer). The piece's own earlier operations stay.
function visibleUntil(animations, until) {
  const after = animations.filter((animation) => plainVisibility(animation) && animation.start > until + EPS);
  if (!after.length) return animations;
  const shown = visibleByOperations(animations, until);
  const hide = shown ? [...after].sort((a, b) => a.start - b.start).find((animation) => animation.kind === "hide") : undefined;
  return animations.flatMap((animation) => {
    if (!after.includes(animation)) return [animation];
    return animation === hide ? [{ ...animation, start: round(until) }] : [];
  });
}

// A piece that starts at `from`: of the operations before it only the last one counts (it sets
// what shows at `from`), and it moves to `from`; earlier ones go.
function visibleFrom(animations, from) {
  const before = animations.filter((animation) => plainVisibility(animation) && animation.start < from - EPS).sort((a, b) => a.start - b.start);
  if (!before.length) return animations;
  const last = before.at(-1);
  return animations.flatMap((animation) => {
    if (!before.includes(animation)) return [animation];
    return animation === last ? [{ ...animation, start: round(from) }] : [];
  });
}

/**
 * Splits one timed layer. `at` is the cut; with `to`, the file between `at` and `to` is skipped.
 * `copy` is {id?, name} for the new piece. Returns { document, copyId }. Throws an Error that says
 * why when the layer can't be split; the document passed in is never changed.
 */
export function splitLayer(document, sceneId, layerId, { at, to, copy = {} }) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  const layer = scene?.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`Layer ${layerId} was not found.`);
  if (!hasMediaPlay(layer))
    throw new Error(`split_layer cuts video, audio and GIF layers with Play; ${label(layer)} is a ${layer.type === "image" ? "still image" : layer.type} layer. Time a still layer with hide and show animations.`);
  if (animatesSpeed(layer)) throw new Error(`split_layer can't cut ${label(layer)}: it has Speed animations. Cut first, then add Speed to a piece.`);
  const start = layer.mediaStart ?? 0;
  const duration = effectiveMediaDuration(layer);
  const end = start + duration;
  const reversed = isReversed(layer);
  if (reversed && !Number.isFinite(duration)) throw new Error(`split_layer can't cut ${label(layer)}: a reversed clip needs its mediaSourceDuration.`);
  const inside = (time) => typeof time === "number" && time >= start + MIN_PLAY_SECONDS && time <= end - MIN_PLAY_SECONDS;
  const range = `${round(start)} to ${Number.isFinite(end) ? `${round(end)} s` : "the end of the file"}`;
  if (!inside(at)) throw new Error(`${to === undefined ? "at" : "from"} must be a scene time inside ${label(layer)}'s Play, ${range}.`);
  if (to !== undefined && (!inside(to) || to <= at)) throw new Error(`to must be after from and inside ${label(layer)}'s Play, ${range}.`);

  // The copy: same place, same animations (fresh IDs, same order), right above the layer.
  const ids = copy.id ? new Map([[layerId, copy.id]]) : undefined;
  const copied = duplicateSelection(document, sceneId, [layerId], 0, { name: () => copy.name ?? `${layer.name} 2`, ids });
  const copyId = copied.rootIds[0];

  const skip = to === undefined ? 0 : to - at;
  const cutSource = round(mediaSoundTime(layer, at));
  const freeze = freezeOf(layer);
  const first = {
    mediaDuration: round(at - start),
    mediaFreeze: freeze === "first" || freeze === "both" ? "first" : "none",
    ...(reversed ? { mediaOffset: cutSource } : {}),
  };
  const restLength = duration - (at - start) - skip;
  const second = {
    mediaStart: round(at),
    mediaFreeze: freeze === "last" || freeze === "both" ? "last" : "none",
    // A forward clip reads on from the cut (or from `to`); a reversed one ends where it did.
    ...(reversed ? {} : { mediaOffset: round(mediaSoundTime(layer, to ?? at)) }),
    mediaDuration: !reversed && !(layer.mediaDuration > 0) ? 0 : round(restLength),
  };

  const animations = layer.animations ?? [];
  // With a skip, the copy's animations that start at or after `to` move earlier with the clip.
  const moved = (animation) => (skip > 0 && animation.start >= to ? { ...animation, start: round(animation.start - skip) } : animation);
  const firstEnd = at, secondEnd = Number.isFinite(end) ? end - skip : at + 1;
  const timeline = (from, until) => [from, (from + until) / 2, until].map((time) => Math.max(0, round(time)));
  const lateOnes = [], earlyOnes = [];
  animations.forEach((animation, index) => {
    if (isVisibilityOperation(animation)) return;
    if (animation.start >= at) lateOnes.push(index);
    if (animationEnd(layer, animation) <= at) earlyOnes.push(index);
  });
  const dropFirst = keptAnimations({ ...layer, ...first }, lateOnes, [0, ...timeline(start, firstEnd - 1e-3)]);
  const dropSecond = keptAnimations({ ...layer, ...second, animations: animations.map(moved) }, earlyOnes, timeline(at, secondEnd));

  const layers = copied.document.scenes.find((item) => item.id === sceneId).layers.map((item) => {
    if (item.id === layerId) return { ...item, ...first, animations: visibleUntil(item.animations.filter((_, index) => !dropFirst.has(index)), at) };
    if (item.id === copyId) {
      const kept = visibleFrom(item.animations.map(moved).filter((_, index) => !dropSecond.has(index)), at);
      return { ...item, ...second, animations: Number.isFinite(secondEnd) && !reversed && second.mediaDuration > 0 ? visibleUntil(kept, secondEnd) : kept };
    }
    return item;
  });
  return {
    document: { ...copied.document, scenes: copied.document.scenes.map((item) => (item.id === sceneId ? { ...item, layers } : item)) },
    copyId,
  };
}
