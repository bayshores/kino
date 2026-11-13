const { contextBridge, ipcRenderer } = require("electron");

function setting(action, key, value) {
  const result = ipcRenderer.sendSync("kino:setting", { action, key, value });
  if (!result?.ok) throw new Error("The local recovery store is unavailable.");
  return result.value;
}

let beforeClose = async () => true;
let beforeServiceReload = async () => true;
ipcRenderer.on("kino:save-before-close", async (_event, requestId) => {
  let saved = false;
  try { saved = (await beforeClose()) === true; } catch { /* The main process keeps the window open on failure. */ }
  ipcRenderer.send("kino:saved-before-close", { requestId, saved });
});
ipcRenderer.on("kino:checkpoint-before-reload", async (_event, requestId) => {
  let retained = false;
  try { retained = (await beforeServiceReload()) === true; } catch { /* Keep the original page on failure. */ }
  ipcRenderer.send("kino:checkpointed-before-reload", { requestId, retained });
});

// A Mac window without a system title bar: the page marks <html> so its top line keeps room for
// the traffic lights and drags the window (dashboard.css, "mac title bar"); none in full screen.
function markTitleBar(state) {
  const root = document.documentElement;
  if (!root || !state?.insetTitleBar) return;
  root.classList.add("mac-titlebar");
  root.classList.toggle("full-screen", Boolean(state.fullScreen));
}
window.addEventListener("DOMContentLoaded", () => markTitleBar(ipcRenderer.sendSync("kino:window-state")));
ipcRenderer.on("kino:full-screen", (_event, fullScreen) => markTitleBar({ insetTitleBar: true, fullScreen }));

contextBridge.exposeInMainWorld("kinoDesktop", {
  windowId: () => ipcRenderer.sendSync("kino:window-state")?.windowId,
  setBadge: (count) => ipcRenderer.send("kino:set-badge", count),
  onServiceStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("kino:service-status", listener);
    callback(ipcRenderer.sendSync("kino:window-state")?.status || "reconnecting");
    return () => ipcRenderer.removeListener("kino:service-status", listener);
  },
  onBeforeServiceReload: (callback) => {
    beforeServiceReload = callback;
    return () => { if (beforeServiceReload === callback) beforeServiceReload = async () => true; };
  },
  editText: (action) => ipcRenderer.invoke("kino:edit-text", action),
  // Inspire's "o open the source": a YouTube page in the default browser (desktop/open-source.mjs).
  openSource: (url) => ipcRenderer.invoke("kino:open-source", url),
  // Settings, agents: Cursor's and VS Code's install links, and the Claude Desktop extension (desktop/agent-connect.mjs).
  openAgentLink: (url) => ipcRenderer.invoke("kino:agent-link", url),
  claudeDesktop: (action) => ipcRenderer.invoke("kino:claude-desktop", action),
  onEditCommand: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("kino:edit-command", listener);
    return () => ipcRenderer.removeListener("kino:edit-command", listener);
  },
  storage: {
    getItem: (key) => setting("get", key),
    setItem: (key, value) => setting("set", key, value),
    removeItem: (key) => setting("remove", key),
    keys: (prefix) => setting("keys", prefix),
  },
  onBeforeClose: (callback) => {
    beforeClose = callback;
    return () => { if (beforeClose === callback) beforeClose = async () => true; };
  },
});
