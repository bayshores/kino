// The Mac app's Edit menu (desktop/main.mjs) takes ⌘Z and ⇧⌘Z before the page sees them and
// sends "undo" or "redo" here instead. In a text field they undo and redo typing, with
// Chromium's own history (desktop/edit-commands.mjs). Outside a text field each page decides:
// the dashboard's Undo reverts the agent's last turn after asking; the viewer has nothing to undo.
import { isTyping as textFieldFocused } from "./dashboard/keys.js";

/** What a menu Undo or Redo does: "text" (in a text field), "page" (outside one) or null. */
export function editCommandTarget(action, typing) {
  if (action !== "undo" && action !== "redo") return null;
  return typing ? "text" : "page";
}

/**
 * Listens for the menu's Undo and Redo. `onPage(action)` runs when no text field has focus.
 * Returns a function that stops listening (in a plain browser there is no menu, so it does nothing).
 */
export function listenForEditCommands(onPage) {
  const desktop = globalThis.kinoDesktop;
  if (!desktop?.onEditCommand) return () => {};
  return desktop.onEditCommand((action) => {
    const target = editCommandTarget(action, textFieldFocused(globalThis.document?.activeElement));
    if (target === "text") desktop.editText(action).catch(() => {});
    else if (target === "page") onPage(action);
  });
}
