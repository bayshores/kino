// The Undo and Redo menus go through the page (frontend/desktopEdit.js): in a text field the page
// asks for Chromium's own text undo or redo here. No other command is accepted.
export function installEditCommands({ ipcMain, trustedSender, isClosing = () => false }) {
  ipcMain.handle("kino:edit-text", (event, action) => {
    if (!trustedSender(event) || isClosing() || !["undo", "redo"].includes(action))
      return { ok: false, error: "This text edit command is not allowed." };
    event.sender[action]();
    return { ok: true };
  });
}
