// Which screen a session opens: the owner gets the dashboard; every share link (view, comment or
// edit) gets the viewer. Comment and edit links can add comments there; nobody edits by hand.
import { isCommentPinsShortcut } from "./commentPins.js";

export function accessShell(access) {
  if (access?.role === "owner") return "dashboard";
  return ["view", "comment", "edit"].includes(access?.role) ? "viewer" : null;
}

export function viewerLayout(width, coarsePointer = false) {
  return width < 720 || coarsePointer ? "cards" : "stage";
}

export function viewerKeyAction(event) {
  const target = event.target;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
      target?.isContentEditable || target?.closest?.("input, textarea, select, button, a[href], [role='slider'], [contenteditable='true']")) return null;
  return ({ ArrowLeft: "previous", PageUp: "previous", ArrowRight: "next", PageDown: "next",
    Home: "first", End: "last", " ": "toggle" })[event.key] ?? null;
}

/**
 * True for ⇧C, which hides or shows the comment pins on the frame (ViewerComments.jsx), but not
 * while typing: in a text field, a text box, a list or editable text, Shift+C types a capital C.
 */
export function viewerPinsShortcut(event) {
  const target = event.target;
  if (event.defaultPrevented || target?.isContentEditable || target?.closest?.("input, textarea, select, [contenteditable='true']")) return false;
  return isCommentPinsShortcut(event);
}

/** Navigation clamps at either end; the Loop control only repeats playback. */
export function viewerSceneIndex(scenes, currentId, action) {
  if (!scenes.length) return -1;
  const current = Math.max(0, scenes.findIndex((scene) => scene.id === currentId));
  if (action === "first") return 0;
  if (action === "last") return scenes.length - 1;
  return Math.max(0, Math.min(scenes.length - 1, current + (action === "next" ? 1 : action === "previous" ? -1 : 0)));
}
