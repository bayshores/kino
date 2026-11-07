// Comment pins on the canvas: where each pin is drawn, which scene a click or a drop lands on,
// and the change a move sends to the server. Everything here is plain math with no React, so
// the tests in commentPins.test.js can check it.
//
// Three kinds of points are used:
// - screen: pixels from the top-left corner of the canvas (<main class="stage"> in Stage.jsx).
// - world: pixels inside .stage-world before zoom. (0, 0) is the center of the active scene.
//   Stage.jsx puts .stage-world at the canvas center plus `pan`, raised by VIEW_LIFT, and scales
//   it by `zoom`, so a world point p is drawn at  canvas center + pan - (0, VIEW_LIFT) + p * zoom.
// - scene: pixels from a scene's top-left corner. Layers and comments store these.
import { commentPlacement } from "./comments.js";
import { shortcutLetter } from "./keyboardLayout.js";

/** Comment positions are kept to a tenth of a pixel. */
export function roundCoordinate(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Where a thread's pin sits on its scene: {x, y, time?}. A scene that became smaller shows the
 * pin at its nearest edge (comments.js commentPlacement). A comment saved without x and y (one
 * posted before comments had a place on the canvas) shows at the scene's top-left corner.
 */
export function pinPlacement(comment, scene) {
  const place = commentPlacement(comment, scene);
  return { ...place, x: place.x ?? 0, y: place.y ?? 0 };
}

/**
 * The comments with moves that are not saved yet shown in place: `pending` maps a comment ID
 * to the fields it moves to. The server's copy replaces these once a move is saved or refused.
 */
export function withPendingMoves(comments = [], pending = {}) {
  if (!Object.keys(pending).length) return comments;
  return comments.map((comment) => (pending[comment.id] ? { ...comment, ...pending[comment.id] } : comment));
}

/**
 * True for ⇧C, which hides or shows comment pins.
 * C means the key with C printed on it on this keyboard layout (keyboardLayout.js), and ⌘, Ctrl
 * or Option with it makes a different shortcut, so those presses are not this one.
 */
export function isCommentPinsShortcut(event, layoutMap = null) {
  if (!event?.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return shortcutLetter(event, layoutMap) === "c";
}
