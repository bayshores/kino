// The preload of the script worker's page (desktop/script-worker.cjs). It runs in the page's
// isolated world and passes messages between the main process and the sandboxed frame that runs
// the script (engine/scriptRuntime.js). The page itself has no script, and the frame (an opaque
// origin) cannot reach this preload or its IPC channel: it only sees postMessage answers.
const { ipcRenderer } = require("electron");

function scriptFrame() {
  return document.getElementById("script-frame");
}

ipcRenderer.on("kino-script:request", (_event, message) => {
  const frame = scriptFrame();
  if (!frame?.contentWindow) return;
  const transfer = [];
  // Image and model bytes arrive as Uint8Arrays; the frame gets each one as its own ArrayBuffer.
  for (const field of ["images", "models"]) {
    if (!message?.[field]) continue;
    const buffers = {};
    for (const [key, bytes] of Object.entries(message[field])) {
      buffers[key] = bytes ? bytes.slice().buffer : null;
      if (buffers[key]) transfer.push(buffers[key]);
    }
    message = { ...message, [field]: buffers };
  }
  frame.contentWindow.postMessage(message, "*", transfer);
});

window.addEventListener("message", (event) => {
  const frame = scriptFrame();
  if (!frame || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || data.kino !== "script" || typeof data.type !== "string") return;
  if (data.type === "ready") return ipcRenderer.send("kino-script:ready");
  if (!Number.isSafeInteger(data.id)) return;
  if (data.type === "loaded") return ipcRenderer.send("kino-script:loaded", data.id);
  if (data.type === "drew") return ipcRenderer.send("kino-script:drew", data.id);
  if (data.type !== "done") return;
  // Only plain fields go on: the frame's script could have put anything in the message.
  const reply = { id: data.id, ok: data.ok === true };
  if (reply.ok) {
    reply.context = typeof data.context === "string" ? data.context.slice(0, 40) : null;
    reply.empty = data.empty === true;
    if (data.png instanceof ArrayBuffer) reply.png = new Uint8Array(data.png);
  } else {
    reply.message = String(data.message ?? "The script failed.").slice(0, 500);
    reply.phase = ["load", "setup", "draw"].includes(data.phase) ? data.phase : "draw";
    reply.time = Number.isFinite(data.time) ? data.time : 0;
    if (Number.isSafeInteger(data.line)) reply.line = data.line;
    if (Number.isSafeInteger(data.column)) reply.column = data.column;
  }
  ipcRenderer.send("kino-script:done", reply);
});
