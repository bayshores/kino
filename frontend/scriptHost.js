// One sandboxed frame that runs one script layer's module for the live preview. The frame page
// (SCRIPT_FRAME_PATH, backend/script-frame-page.mjs) has an opaque origin (sandbox="allow-scripts"
// only) and its own policy with no network, so a module in a shared video cannot reach the page,
// its cookies or storage, or any server. It speaks the runtime's messages (engine/scriptRuntime.js):
// mount, then draw with output "bitmap"; the picture comes back as an ImageBitmap.
//
// A module that never returns: the host waits SCRIPT_LIMITS (setup, draw), then throws the frame
// away and answers {ok:false, tooLong:true}. The frame is a separate process from the page in the
// Mac app and in the test browser (sandboxed frames get their own), so the page keeps running.
import { SCRIPT_LIMITS, tooLongMessage } from "../engine/scriptRuntime.js";

const HIDDEN_STYLE = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
const START_MS = 15_000;

/**
 * Starts a frame. `src`: the frame page's address (SCRIPT_FRAME_PATH in engine/scriptLayer.js).
 * Returns {mount(request), draw(frame), destroy(), destroyed}. mount and draw resolve to
 * {ok:true, bitmap?} or {ok:false, message, phase, tooLong?}; they never reject.
 */
export function createScriptHost({ src, limits = SCRIPT_LIMITS, parent = globalThis.document?.body } = {}) {
  const frame = globalThis.document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("data-kino-script-frame", "");
  frame.title = "";
  frame.style.cssText = HIDDEN_STYLE;
  frame.src = src;

  const waiting = new Map();
  let nextId = 1;
  let destroyed = false;
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });

  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.kino !== "script" || typeof data.type !== "string") return;
    if (data.type === "ready") return markReady(true);
    if (data.type !== "done") return;
    const entry = waiting.get(data.id);
    if (!entry) return;
    waiting.delete(data.id);
    clearTimeout(entry.timer);
    // The frame's script could have put anything in the message: only plain fields go on.
    if (data.ok === true) {
      const bitmap = typeof ImageBitmap === "function" && data.bitmap instanceof ImageBitmap ? data.bitmap : null;
      entry.resolve({ ok: true, bitmap, empty: data.empty === true });
    } else entry.resolve({ ok: false, message: String(data.message ?? "The script failed.").slice(0, 500), phase: String(data.phase ?? "draw") });
  }
  globalThis.addEventListener("message", onMessage);
  parent.append(frame);
  const startTimer = setTimeout(() => markReady(false), START_MS);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(startTimer);
    globalThis.removeEventListener("message", onMessage);
    frame.remove();
    markReady(false);
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, message: "The script frame was closed.", phase: "draw", closed: true });
    }
    waiting.clear();
  }

  async function call(message, limitMs, time, phase, transfer = []) {
    if (!(await ready) || destroyed) return { ok: false, message: "The script frame did not start.", phase, closed: true };
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        destroy();
        resolve({ ok: false, message: tooLongMessage(time), phase, tooLong: true });
      }, limitMs);
      waiting.set(id, { resolve, timer });
      frame.contentWindow.postMessage({ kino: "script", id, ...message }, "*", transfer);
    });
  }

  return {
    frame,
    get destroyed() { return destroyed; },
    /** {script, width, height, pixelRatio, name, images: {key: ArrayBuffer|null}} */
    mount(request) {
      const transfer = Object.values(request.images ?? {}).filter((bytes) => bytes instanceof ArrayBuffer);
      return call({ type: "mount", ...request }, limits.setupMs, 0, "setup", transfer);
    },
    draw(frameValues) {
      return call({ type: "draw", frame: frameValues, output: "bitmap" }, limits.drawMs, frameValues.time, "draw");
    },
    destroy,
  };
}
