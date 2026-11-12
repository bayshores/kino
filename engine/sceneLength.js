// What follows when an edit gives a scene, or the board's music, another length.
//
// 1. An animation that spans the whole scene (it starts at 0 and ends at the old length, each
//    within a frame) is a whole-scene effect such as a grade, a curve or a grain: it ends at the
//    new length, so the last stretch is not left ungraded. Animations that end anywhere else are
//    the agent's timing and stay, and so does a Speed animation.
// 2. A board whose shots tile the scene before an edit (no gap, no overlap, the last shot ending
//    where the music or the video ended) lengthens or shortens its last shot to the end after it
//    (update_scene duration, or the music layer's Play in the same edit), when the change is
//    at most BOARD_FOLLOW_SECONDS. A bigger change is a different cut: the last shot would hold
//    more than a second of picture or music nobody saw, so the board stays as saved and the
//    board stop's refusal gives the one call (board {end}).
//
// 3. A full-frame picture or plate whose Hide is at the old end (within a frame) ends at the new one,
//    so a longer scene does not end on bare background (and a shorter one does not keep a Hide past
//    its end). Other layers that hide at the old end stay, and the receipt names them.
//
// All change the document passed in and return what moved, for the receipt.
import { boardCoverage, boardSpan, mainScene, ONE_FRAME } from "./board.js";
import { isComposedAnimation } from "./animationTree.js";
import { fullFrameLayers } from "./quality/bareGaps.js";
import { isVisibilityOperation, orderedVisibilityOperations } from "./visibilityOps.js";

// The most a board's last shot follows a length change. One second is 30 frames at the board's
// 30 frames a second: five times the 6 frames at which an approved board already counts a moved
// cut as a new board (backend/agent/board.mjs CUT_FRAMES), so a follow past 6 frames still lapses
// the approval, and past a second the answer asks the agent to place the end itself.
export const BOARD_FOLLOW_SECONDS = 1;

const round = (value) => Math.round(value * 1000) / 1000;

// A Speed animation sets which file moments play: stretching it would move every frame of the
// clip (and what is timed to them), so it keeps its times.
const changesSpeed = (animation) => Object.hasOwn(animation.from ?? {}, "speed") || Object.hasOwn(animation.to ?? {}, "speed");

// Whether `animation` runs from the scene's start to its end (`length` seconds), within `frame`.
function spansScene(animation, length, frame) {
  if (!animation || typeof animation !== "object" || isComposedAnimation(animation) || isVisibilityOperation(animation) || changesSpeed(animation)) return false;
  if (typeof animation.start !== "number" || typeof animation.duration !== "number") return false;
  // Text animations timed per letter, word or line end later than start + duration.
  if (animation.stagger || animation.delays || animation.range) return false;
  return Math.abs(animation.start) <= frame && Math.abs(animation.start + animation.duration - length) <= frame;
}

/**
 * The whole-scene animations of `scene` (layers and background) moved to end at the scene's
 * current duration, from `was`. Returns [{ layerId, animationId, name }] for each one that moved.
 */
export function followSceneLength(scene, was, { fps = 30 } = {}) {
  const now = Number(scene?.duration);
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  if (!(was > 0) || !(now > 0) || Math.abs(now - was) < 1e-6) return [];
  const moved = [];
  const follow = (owner, list) => (Array.isArray(list) ? list : []).map((animation) => {
    if (!spansScene(animation, was, frame)) return animation;
    moved.push({ layerId: owner, animationId: animation.id, name: animation.name, to: round(now) });
    return { ...animation, start: 0, duration: round(now) };
  });
  scene.backgroundAnimations = follow("background", scene.backgroundAnimations);
  if (!scene.backgroundAnimations.length) delete scene.backgroundAnimations;
  for (const layer of scene.layers ?? []) if (Array.isArray(layer.animations)) layer.animations = follow(layer.id, layer.animations);
  return moved;
}

/**
 * Before an edit: the board's span (boardSpan) with the main scene's id and the board's rev when
 * the saved shots tile it, else null. Pass the result to followBoardLength after the edit, so a
 * change to the scene's length or to the music layer's Play (update_layer mediaDuration) in any
 * order is followed once.
 */
export function boardSpanBefore(document) {
  const board = document?.board;
  const scene = mainScene(document);
  if (!board?.shots?.length || !scene) return null;
  const span = boardSpan(document, board);
  return boardCoverage(board, span) ? null : { ...span, sceneId: scene.id, rev: board.rev };
}

// The key a board follow is reported under in applyOperations' reports (it belongs to the whole
// edit, not to one operation).
export const BOARD_FOLLOW = Object.freeze({ type: "board_follow" });

/**
 * After an edit: the board's last shot ends at the new span's end. Returns
 * { shot, from, to } when it moved; { refused: "too long" } when the change is past
 * BOARD_FOLLOW_SECONDS; null when nothing needed to move (or the board, the main scene or the
 * music layer is another one now).
 */
export function followBoardLength(document, before) {
  const board = document?.board;
  if (!before || !board?.shots?.length || board.rev !== before.rev || mainScene(document)?.id !== before.sceneId) return null;
  const now = boardSpan(document, board);
  if (now.music !== before.music) return null;
  const delta = now.end - before.end;
  if (Math.abs(delta) <= ONE_FRAME) return null;
  if (Math.abs(delta) > BOARD_FOLLOW_SECONDS) return { refused: "too long", from: round(before.end), to: round(now.end) };
  const last = board.shots.at(-1);
  const dur = round(now.end - last.cue);
  if (!(dur > ONE_FRAME)) return null;
  const next = { ...board, shots: [...board.shots.slice(0, -1), { ...last, dur }] };
  if (boardCoverage(next, now)) return null;
  document.board = { ...next, rev: board.rev + 1 };
  return { shot: board.shots.length, from: round(last.cue + last.dur), to: round(last.cue + dur) };
}

// The most layers a follow names, moved or left.
const NAMED = 12;

/**
 * After an edit that gave `scene` another length than `was`: the full-frame pictures and plates drawn
 * whole on the old last frame whose Hide is at the old end (within a frame) now hide at the new end.
 * Returns { moved: [{ layerId, animationId, from, to }], left: [{ layerId, why }], more } (left: a
 * layer that hides at the old end and did not move: not a full-frame picture, or a Show in the way),
 * or null when the length is the same or nothing hides at the old end.
 */
export function followLastLayers(scene, was, { fps = 30 } = {}) {
  const now = Number(scene?.duration);
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  if (!(was > 0) || !(now > 0) || Math.abs(now - was) < 1e-6) return null;
  const whole = new Set(fullFrameLayers(scene, Math.max(0, was - frame)).map((layer) => layer.id));
  const moved = [];
  const left = [];
  for (const layer of scene.layers ?? []) {
    if (layer.type === "audio" || !Array.isArray(layer.animations)) continue;
    const hide = layer.animations.find((animation) => animation?.kind === "hide" && typeof animation.start === "number" && Math.abs(animation.start - was) <= 1.5 * frame);
    if (!hide) continue;
    const others = orderedVisibilityOperations(layer.animations).filter((operation) => operation.start >= now - 1e-6 && operation.start !== hide.start);
    if (!whole.has(layer.id)) left.push({ layerId: layer.id, why: "not a full-frame picture" });
    else if (others.length) left.push({ layerId: layer.id, why: `another Hide or Show at ${others[0].start} s` });
    else {
      moved.push({ layerId: layer.id, animationId: hide.id, from: round(hide.start), to: round(now) });
      hide.start = round(now);
    }
  }
  if (!moved.length && !left.length) return null;
  return { moved: moved.slice(0, NAMED), left: left.slice(0, NAMED), more: Math.max(0, moved.length - NAMED) + Math.max(0, left.length - NAMED) };
}
