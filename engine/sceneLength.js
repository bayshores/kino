// What follows when update_scene gives a scene another length.
//
// 1. An animation that spans the whole scene (it starts at 0 and ends at the old length, each
//    within a frame) is a whole-scene effect such as a grade, a curve or a grain: it ends at the
//    new length, so the last stretch is not left ungraded. Animations that end anywhere else are
//    the agent's timing and stay.
// 2. A board whose shots tile the scene (no gap, no overlap, the last shot ending where the music
//    or the video ended) lengthens or shortens its last shot to the new end, when the change is
//    at most BOARD_FOLLOW_SECONDS. A bigger change is a different cut: the last shot would hold
//    more than a second of picture or music nobody saw, so the board stays as saved and the
//    board stop's refusal gives the one call (board {end}).
//
// Both change the document passed in and return what moved, for the receipt.
import { boardCoverage, boardSpan, mainScene, ONE_FRAME } from "./board.js";
import { isComposedAnimation } from "./animationTree.js";
import { isVisibilityOperation } from "./visibilityOps.js";

// The most a board's last shot follows a length change. One second is 30 frames at the board's
// 30 frames a second: five times the 6 frames at which an approved board already counts a moved
// cut as a new board (backend/agent/board.mjs CUT_FRAMES), so a follow past 6 frames still lapses
// the approval, and past a second the answer asks the agent to place the end itself.
export const BOARD_FOLLOW_SECONDS = 1;

const round = (value) => Math.round(value * 1000) / 1000;

// Whether `animation` runs from the scene's start to its end (`length` seconds), within `frame`.
function spansScene(animation, length, frame) {
  if (!animation || typeof animation !== "object" || isComposedAnimation(animation) || isVisibilityOperation(animation)) return false;
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
 * Before update_scene: the board's span (boardSpan) when `scene` is the main scene and the saved
 * shots tile it, else null. Pass the result to followBoardLength after the scene changed.
 */
export function boardSpanBefore(document, scene) {
  const board = document?.board;
  if (!board?.shots?.length || mainScene(document)?.id !== scene.id) return null;
  const span = boardSpan(document, board);
  return boardCoverage(board, span) ? null : span;
}

/**
 * After update_scene: the board's last shot ends at the new span's end. Returns
 * { shot, from, to } when it moved; { refused: "too long" } when the change is past
 * BOARD_FOLLOW_SECONDS; null when nothing needed to move.
 */
export function followBoardLength(document, before) {
  const board = document?.board;
  if (!before || !board?.shots?.length) return null;
  const now = boardSpan(document, board);
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
