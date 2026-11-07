// The Mac menu bar. main.mjs passes in what each custom item does; the rest are standard macOS
// items ("roles") that Electron and macOS carry out themselves.

/**
 * @param {object} actions
 * @param {boolean} actions.packaged    The installed app hides the developer tools item.
 * @param {(window, command: "undo" | "redo") => void} actions.editCommand
 * @param {(window) => void} actions.reload
 * @param {() => void} actions.restartService
 * @param {(name: "licenses" | "sources") => void} actions.openBundledFolder
 */
export function appMenuTemplate({ packaged, editCommand, reload, restartService, openBundledFolder }) {
  return [
    { label: "kino", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    // File holds Close Window (⌘W). It closes the window through the window's "close" handler,
    // which asks the page first, like the red close button.
    { role: "fileMenu" },
    // Undo and Redo go to the page (frontend/desktopEdit.js): in a text field they undo typing; in the
    // dashboard, Undo outside a text field reverts the agent's last turn after asking.
    { label: "Edit", submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: (_item, window) => { if (window) editCommand(window, "undo"); } },
      { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: (_item, window) => { if (window) editCommand(window, "redo"); } },
      { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    // Reload is ⇧⌘R, as it has always been in kino.
    { label: "View", submenu: [
      { label: "Reload", accelerator: "CmdOrCtrl+Shift+R", click: (_item, window) => { if (window) reload(window); } },
      { label: "Restart local service", click: () => restartService() },
      { role: "togglefullscreen" },
      ...(packaged ? [] : [{ role: "toggleDevTools" }])] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Bundled media licenses", click: () => openBundledFolder("licenses") },
      { label: "Bundled media source", click: () => openBundledFolder("sources") },
    ] },
  ];
}
