// The runtime that runs an agent-written drawing module (a script layer) inside a sandboxed frame.
// The backend's offscreen Electron window (backend/script-frames.mjs, desktop/script-worker.cjs)
// and, later, the dashboard preview load the same page, so a frame looks the same everywhere.
//
// The frame has an opaque origin (an iframe with sandbox="allow-scripts" only) and a strict
// content security policy (no network, no workers). Its host talks to it with postMessage:
//
//   host -> frame  {kino:"script", id, type:"mount", script, width, height, pixelRatio, name, images}
//                  {kino:"script", id, type:"draw", frame, output:"png"|"bitmap"}
//   frame -> host  {kino:"script", type:"ready"}                       once the runtime has loaded
//                  {kino:"script", id, type:"loaded"}                  the module loaded; setup runs
//                  {kino:"script", id, type:"drew"}                    the draw function returned
//                  {kino:"script", id, type:"done", ok:true, context, png?|bitmap?, empty?}
//                  {kino:"script", id, type:"done", ok:false, message, phase, time, line?, column?}
//
// `images` maps an image input's key to the bytes of a picture (an ArrayBuffer); each one becomes
// an ImageBitmap in frame.values. The runtime cannot stop a script that never returns: the
// backend's host times each mount and draw (SCRIPT_LIMITS) and throws the frame away when one
// takes too long. The live preview's page (scriptFrameHtml({worker:true})) runs the runtime in a
// Worker instead and stops that Worker itself, so the frame and its process stay usable.
//
// This file only builds text: it runs no DOM code when imported.

/** How long a script may take: loading and setup together, and one draw (milliseconds). */
export const SCRIPT_LIMITS = Object.freeze({ setupMs: 5000, drawMs: 2000 });

/** The error a frame gets when its script ran past a limit. `time`: the frame's time in seconds. */
export function tooLongMessage(time) {
  return `script took too long at ${(Number(time) || 0).toFixed(2)} s`;
}

/**
 * The frame page's content security policy. No request can leave (connect, image, font and
 * frame requests have no allowed source but data: and blob: URLs), and only the runtime itself
 * (inline) and the module (a blob: URL) may run.
 */
export const SCRIPT_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "img-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The live preview's frame policy: the same, except that the page may start its own Worker from a
 * blob: URL (the module runs in it, so a stuck module can be stopped; see scriptRelay).
 */
export const SCRIPT_PREVIEW_FRAME_CSP = SCRIPT_FRAME_CSP.replace("worker-src 'none'", "worker-src blob:");

// Runs inside the frame (`inWorker` false) or inside the Worker the preview's frame starts
// (`inWorker` true). Written as a real function so it is checked like the rest of the code;
// scriptRuntimeSource() turns it into text.
function scriptRuntime(inWorker) {
  "use strict";
  const scope = globalThis;
  const host = inWorker ? null : window.parent;
  // A module in the Worker cannot start Workers of its own.
  if (inWorker) for (const name of ["Worker", "SharedWorker"]) {
    try { Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false }); } catch { /* not there */ }
  }
  const RealDate = Date;
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  const realSetInterval = setInterval, realClearInterval = clearInterval;
  const realRequestFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  const realCancelFrame = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
  const post = inWorker
    ? (message, transfer) => scope.postMessage({ kino: "script", ...message }, transfer || [])
    : (message, transfer) => host.postMessage({ kino: "script", ...message }, "*", transfer || []);

  // The clock the script sees: the frame's time in milliseconds (0 while loading and in setup).
  let clock = 0;
  // Math.random: a small seeded generator (mulberry32), restarted before setup and every draw, so
  // the same frame gives the same numbers in any order.
  const SEED = 0x6b696e6f;
  let seed = SEED;
  const restartRandom = () => { seed = SEED; };
  Math.random = function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  // crypto.getRandomValues draws from the same seeded generator, one byte at a time.
  if (typeof crypto === "object" && crypto) {
    const seededValues = function getRandomValues(array) {
      if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array)
        throw new TypeError("getRandomValues needs an integer typed array.");
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
      return array;
    };
    try { Object.defineProperty(crypto, "getRandomValues", { value: seededValues, configurable: false, writable: false }); }
    catch { /* a platform that refuses keeps its own */ }
    const seededUuid = function randomUUID() {
      const bytes = seededValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    try { Object.defineProperty(crypto, "randomUUID", { value: seededUuid, configurable: false, writable: false }); }
    catch { /* as above */ }
  }
  function FrameDate(...args) {
    if (!new.target) return new RealDate(clock).toString();
    return args.length ? new RealDate(...args) : new RealDate(clock);
  }
  FrameDate.prototype = RealDate.prototype;
  FrameDate.now = () => clock;
  FrameDate.parse = RealDate.parse;
  FrameDate.UTC = RealDate.UTC;
  scope.Date = FrameDate;
  Object.defineProperty(performance, "now", { value: () => clock, configurable: false, writable: false });

  // Timers the script starts end with the draw that started them.
  const timeouts = new Set(), intervals = new Set(), animationFrames = new Set();
  scope.setTimeout = (callback, delay, ...rest) => { const id = realSetTimeout(callback, delay, ...rest); timeouts.add(id); return id; };
  scope.setInterval = (callback, delay, ...rest) => { const id = realSetInterval(callback, delay, ...rest); intervals.add(id); return id; };
  if (realRequestFrame) scope.requestAnimationFrame =(callback) => { const id = realRequestFrame(callback); animationFrames.add(id); return id; };
  function stopTimers() {
    for (const id of timeouts) realClearTimeout(id);
    for (const id of intervals) realClearInterval(id);
    if (realCancelFrame) for (const id of animationFrames) realCancelFrame(id);
    timeouts.clear(); intervals.clear(); animationFrames.clear();
  }

  let mounted = null;
  let moduleUrl = "";

  // Where in the module an error happened, read from its stack (the module's own blob: URL).
  function placeOf(error) {
    const stack = String(error && error.stack || "");
    if (!moduleUrl) return {};
    const index = stack.indexOf(moduleUrl + ":");
    if (index < 0) return {};
    const match = /^:(\d+):(\d+)/.exec(stack.slice(index + moduleUrl.length));
    return match ? { line: Number(match[1]), column: Number(match[2]) } : {};
  }
  function failure(id, error, phase, time, place) {
    const text = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    const name = error && typeof error === "object" && error.name && error.name !== "Error" ? `${error.name}: ` : "";
    return { id, type: "done", ok: false, message: (name + text).slice(0, 500), phase, time, ...(place || placeOf(error)) };
  }

  // A syntax error from import() carries no line. Loading the same text once more as a module
  // script element reports it to the window's error event, with its line and column. (A Worker
  // has no script elements: there the error has no place; the save already checked the syntax.)
  function syntaxPlace(script) {
    if (inWorker) return Promise.resolve({});
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
      const element = document.createElement("script");
      let settled = false;
      const done = (place) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("error", onError, true);
        element.remove();
        URL.revokeObjectURL(url);
        resolve(place);
      };
      const onError = (event) => {
        if (event.filename !== url) return;
        event.preventDefault();
        done({ line: event.lineno, column: event.colno });
      };
      window.addEventListener("error", onError, true);
      element.type = "module";
      element.src = url;
      element.onload = () => done({});
      element.onerror = () => done({});
      document.head.append(element);
      realSetTimeout(() => done({}), 1000);
    });
  }

  async function decodeImages(images) {
    const decoded = {};
    for (const key of Object.keys(images || {})) {
      const bytes = images[key];
      decoded[key] = bytes ? await createImageBitmap(new Blob([bytes])) : null;
    }
    return decoded;
  }

  async function mount(message) {
    const { id, script, width, height, pixelRatio, name } = message;
    stopTimers();
    if (mounted) for (const bitmap of Object.values(mounted.images)) bitmap?.close?.();
    mounted = null;
    clock = 0;
    restartRandom();
    let images;
    try {
      images = await decodeImages(message.images);
    } catch (error) {
      return post(failure(id, `An image input could not be read: ${error && error.message || error}`, "load", 0, {}));
    }
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)));
    const state = { canvas, kind: null, context: null, draw: null, width, height, pixelRatio, images };
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = (kind, options) => {
      const context = getContext(kind, options);
      if (context && !state.kind) { state.kind = String(kind); state.context = context; }
      return context;
    };
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
    moduleUrl = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    let module;
    try {
      module = await import(moduleUrl);
    } catch (error) {
      const place = error instanceof SyntaxError ? await syntaxPlace(script) : placeOf(error);
      return post(failure(id, error, "load", 0, place));
    }
    if (typeof module.default !== "function") {
      return post(failure(id, "The script must have an export default function setup(layer).", "load", 0, {}));
    }
    post({ id, type: "loaded" });
    try {
      const layer = Object.freeze({ canvas, width, height, pixelRatio, name: String(name || "") });
      const draw = await module.default(layer);
      if (typeof draw !== "function") throw new Error("setup(layer) must return the draw(frame) function.");
      state.draw = draw;
    } catch (error) {
      stopTimers();
      return post(failure(id, error, "setup", 0));
    }
    stopTimers();
    mounted = state;
    post({ id, type: "done", ok: true, context: state.kind });
  }

  // True when every pixel is fully transparent.
  function isEmpty(state) {
    const { canvas } = state;
    let reader = state.kind === "2d" ? state.context : null;
    if (!reader) {
      if (!state.scratch) state.scratch = new OffscreenCanvas(canvas.width, canvas.height).getContext("2d", { willReadFrequently: true });
      state.scratch.clearRect(0, 0, canvas.width, canvas.height);
      state.scratch.drawImage(canvas, 0, 0);
      reader = state.scratch;
    }
    const words = new Uint32Array(reader.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
    // Each pixel is one 32-bit word; in either byte order a fully transparent pixel is 0 once its
    // color channels are premultiplied, and getImageData gives 0, 0, 0, 0 for it.
    for (let index = 0; index < words.length; index += 1) if (words[index] !== 0) return false;
    return true;
  }

  async function draw(message) {
    const { id, frame } = message;
    const time = Number(frame && frame.time) || 0;
    const state = mounted;
    if (!state) return post(failure(id, "No script is mounted.", "draw", time, {}));
    clock = time * 1000;
    restartRandom();
    const values = { ...(frame.values || {}) };
    for (const key of Object.keys(state.images)) values[key] = state.images[key];
    const given = Object.freeze({ ...frame, values: Object.freeze(values), pixelRatio: state.pixelRatio });
    if (state.kind === "2d") {
      // The whole drawing state starts fresh each frame (clips, styles, paths, the saved-state
      // stack), so nothing one frame set leaks into the next; reset() clears the pixels too.
      const context = state.context;
      if (typeof context.reset === "function") context.reset();
      else {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = "source-over";
        context.beginPath();
      }
      context.clearRect(0, 0, state.canvas.width, state.canvas.height);
      context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
    }
    try {
      await state.draw(given);
    } catch (error) {
      stopTimers();
      return post(failure(id, error, "draw", time));
    }
    stopTimers();
    post({ id, type: "drew" });
    try {
      const empty = isEmpty(state);
      if (message.output === "bitmap") {
        const bitmap = await createImageBitmap(state.canvas);
        return post({ id, type: "done", ok: true, context: state.kind, bitmap, empty }, [bitmap]);
      }
      const blob = await state.canvas.convertToBlob({ type: "image/png" });
      const png = await blob.arrayBuffer();
      post({ id, type: "done", ok: true, context: state.kind, png, empty }, [png]);
    } catch (error) {
      post(failure(id, `The frame could not be read: ${error && error.message || error}`, "draw", time, {}));
    }
  }

  scope.addEventListener("message", (event) => {
    if (!inWorker && event.source !== host) return;
    const message = event.data;
    if (!message || message.kino !== "script") return;
    if (message.type === "mount") void mount(message);
    else if (message.type === "draw") void draw(message);
  });
  post({ type: "ready" });
}

// The live preview's frame page: it runs the runtime in a Worker and passes the host's messages
// through. It times each mount and draw itself (SCRIPT_LIMITS); a module past its limit is stopped
// with terminate(), the host is told it took too long, and the next message starts a new Worker.
// So a stuck module never leaves a busy process behind, and the same frame keeps working.
function scriptRelay(workerSource, limits, tooLong) {
  "use strict";
  const host = window.parent;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const timers = new Map();
  let worker = null;
  const toHost = (message, transfer) => host.postMessage(message, "*", transfer || []);
  function start() {
    worker = new Worker(workerUrl);
    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || message.kino !== "script" || message.type === "ready") return;
      if (message.type === "done") { clearTimeout(timers.get(message.id)); timers.delete(message.id); }
      const transfer = [message.bitmap, message.png].filter((item) => item instanceof ImageBitmap || item instanceof ArrayBuffer);
      toHost(message, transfer);
    };
  }
  // Stops the Worker; the other requests it held are answered `stopped` (the host may send them again).
  function stop(stuckId) {
    if (worker) worker.terminate();
    worker = null;
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      if (id !== stuckId) toHost({ kino: "script", id, type: "done", ok: false, message: "stopped with another module that took too long", phase: "draw", stopped: true });
    }
    timers.clear();
  }
  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const message = event.data;
    if (!message || message.kino !== "script" || !["mount", "draw"].includes(message.type)) return;
    if (!worker) start();
    const time = message.type === "draw" ? Number(message.frame && message.frame.time) || 0 : 0;
    const phase = message.type === "mount" ? "setup" : "draw";
    timers.set(message.id, setTimeout(() => {
      stop(message.id);
      toHost({ kino: "script", id: message.id, type: "done", ok: false, message: tooLong(time), phase, time, tooLong: true });
    }, message.type === "mount" ? limits.setupMs : limits.drawMs));
    const transfer = Object.values(message.images || {}).filter((item) => item instanceof ArrayBuffer);
    worker.postMessage(message, transfer);
  });
  toHost({ kino: "script", type: "ready" });
}

/** The runtime's JavaScript text, ready to put in a script element (or, `inWorker`, a Worker). */
export function scriptRuntimeSource({ inWorker = false } = {}) {
  return `(${scriptRuntime.toString()})(${inWorker});`;
}

/**
 * The whole frame page: the policy, the runtime, nothing else. `worker` (the live preview) runs
 * the module in a Worker the page can stop (scriptRelay); the backend renderer runs it directly.
 */
export function scriptFrameHtml({ worker = false } = {}) {
  const script = worker
    ? `(${scriptRelay.toString()})(${JSON.stringify(scriptRuntimeSource({ inWorker: true }))}, ${JSON.stringify(SCRIPT_LIMITS)}, ${tooLongMessage.toString()});`
    : scriptRuntimeSource();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${worker ? SCRIPT_PREVIEW_FRAME_CSP : SCRIPT_FRAME_CSP}">
<script>${script}</script></head><body></body></html>`;
}
