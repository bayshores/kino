import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { MAX_MOTION_SAMPLES } from "./render-quality.mjs";

const DEFAULT_SIZE = 2;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_IDLE_MS = 1000;
const MAX_POOL_SIZE = 8;
// The SVG text of one request, its shutter samples included (export.mjs draws larger frames one
// sample at a time).
export const MAX_SVG_BYTES = 64 * 1024 * 1024;
const WORKER_URL = new URL("./render-worker.mjs", import.meta.url);

function abortError(reason) {
  const message = typeof reason?.message === "string" && reason.message.trim()
    ? reason.message.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
    : "Resvg render was cancelled.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function poolError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a whole number from 1 to ${maximum}.`);
  }
  return value;
}

function nonnegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a whole number from 0 to ${maximum}.`);
  }
  return value;
}

function validateSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw new TypeError("Resvg render needs a valid AbortSignal.");
  }
}

function prepareInput(svg, resvgOptions, samples) {
  if (typeof svg !== "string") throw new TypeError("Resvg render input must be SVG text.");
  if (!Array.isArray(samples)) throw new TypeError("Resvg render samples must be an array of SVG text.");
  if (samples.length > MAX_MOTION_SAMPLES - 1) {
    throw new RangeError(`Resvg render supports at most ${MAX_MOTION_SAMPLES - 1} additional SVG samples.`);
  }
  samples = [...samples];
  let svgBytes = Buffer.byteLength(svg, "utf8");
  for (const sample of samples) {
    if (typeof sample !== "string") throw new TypeError("Resvg render sample input must be SVG text.");
    svgBytes += Buffer.byteLength(sample, "utf8");
  }
  if (svgBytes > MAX_SVG_BYTES) throw new RangeError("Combined Resvg render SVG input must be no larger than 64 MiB.");
  if (resvgOptions == null) resvgOptions = {};
  if (typeof resvgOptions !== "object" || Array.isArray(resvgOptions)) {
    throw new TypeError("Resvg render options must be an object.");
  }
  let options;
  let optionBytes;
  try {
    options = structuredClone(resvgOptions);
    optionBytes = serialize(options).byteLength;
  } catch {
    throw new TypeError("Resvg render options must be cloneable data.");
  }
  return { svg, samples, options, bytes: svgBytes + optionBytes };
}

function removeFromQueue(queue, task) {
  const index = queue.indexOf(task);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

function workerFailureMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "Resvg worker failed.";
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function isWatchDependencyNotification(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const keys = Object.keys(message);
  if (keys.length === 0 || keys.length > 2 ||
      keys.some((key) => key !== "watch:import" && key !== "watch:require")) return false;
  return keys.every((key) => Array.isArray(message[key]) && message[key].every((dependency) =>
    typeof dependency === "string" || (key === "watch:require" && (dependency === null || dependency === undefined))));
}

function forwardWatchDependencyNotification(message) {
  if (process.env.WATCH_REPORT_DEPENDENCIES !== "1" || typeof process.send !== "function") return;
  try { process.send(message, () => {}); } catch {}
}

/**
 * Each Resvg worker is its own process, shaped like a worker thread for the pool. A Resvg panic
 * aborts the whole process it runs in (an unwrap in resvg's geom.rs did, twice, during a product
 * trailer's renders): in a worker thread that took down the kino service with every render, look
 * and check running in it; in a child process only that frame fails and the next frame gets a new
 * worker. Inside the Mac app the service is Electron, so ELECTRON_RUN_AS_NODE runs it as Node.
 */
export function processWorkerFactory(url, { execPath } = {}) {
  const electron = Boolean(process.versions.electron);
  const child = fork(fileURLToPath(url), [], {
    execPath: execPath ?? (electron ? process.env.KINO_ELECTRON_EXECUTABLE || process.execPath : process.execPath),
    execArgv: [],
    env: { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const worker = new EventEmitter();
  let exited = null;
  let spawned = false;
  let finish;
  const exitedPromise = new Promise((resolve) => { finish = (code) => {
    if (exited !== null) return;
    exited = code;
    resolve(exited);
  }; });
  child.once("spawn", () => { spawned = true; });
  child.once("exit", (code, signal) => finish(code ?? signal ?? 1));
  child.on("message", (message) => worker.emit("message", message));
  child.on("error", (error) => {
    worker.emit("error", error);
    // A process that never started (a missing executable, too many processes) sends no exit.
    if (!spawned) finish(1);
  });
  exitedPromise.then((code) => worker.emit("exit", code));
  worker.postMessage = (message) => {
    if (!child.connected) throw new Error("Resvg worker process is not running.");
    child.send(message);
  };
  worker.terminate = () => {
    if (exited === null) {
      child.ref(); // keeps the parent alive until the exit arrives
      child.kill("SIGKILL");
    }
    return exitedPromise;
  };
  worker.ref = () => { child.ref(); child.channel?.ref?.(); };
  worker.unref = () => { child.unref(); child.channel?.unref?.(); };
  return worker;
}

const defaultWorkerFactory = processWorkerFactory;

/**
 * Creates a bounded pool of persistent Resvg workers.
 * `workerFactory` is an internal test seam; production workers are child processes (processWorkerFactory).
 */
export function createRenderPool({
  size = DEFAULT_SIZE,
  maxQueue = DEFAULT_MAX_QUEUE,
  maxBytes = DEFAULT_MAX_BYTES,
  idleMs = DEFAULT_IDLE_MS,
  workerFactory = defaultWorkerFactory,
} = {}) {
  positiveInteger(size, "size", MAX_POOL_SIZE);
  nonnegativeInteger(maxQueue, "maxQueue");
  positiveInteger(maxBytes, "maxBytes");
  nonnegativeInteger(idleMs, "idleMs");
  if (typeof workerFactory !== "function") throw new TypeError("workerFactory must be a function.");

  const slots = new Set();
  const queue = [];
  const activeTasks = new Set();
  let queuedBytes = 0;
  let nextId = 1;
  let closed = false;
  let closePromise = null;

  function settle(task, error, value) {
    if (task.settled) return;
    task.settled = true;
    task.state = "settled";
    task.signal?.removeEventListener("abort", task.abortListener);
    activeTasks.delete(task);
    if (error) task.reject(error);
    else task.resolve(value);
  }

  function clearIdleTimer(slot) {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  function scheduleIdleRetirement(slot) {
    clearIdleTimer(slot);
    if (closed || idleMs === 0 || slot.state !== "idle") {
      if (slot.state === "idle") void retireSlot(slot, new Error("Resvg worker is idle."));
      return;
    }
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.state === "idle" && queue.length === 0) void retireSlot(slot, new Error("Resvg worker is idle."));
    }, idleMs);
    slot.idleTimer.unref?.();
  }

  function retireSlot(slot, reason) {
    if (slot.retirePromise) return slot.retirePromise;
    slot.state = "stopping";
    clearIdleTimer(slot);
    const task = slot.task;
    slot.task = null;
    if (task) task.state = "terminating";
    slot.retirePromise = (async () => {
      try { await slot.worker.terminate(); } catch {}
      slots.delete(slot);
      slot.worker.removeAllListeners?.();
      if (task) settle(task, reason);
      if (!closed) pump();
    })();
    return slot.retirePromise;
  }

  function completeSlot(slot, task, error, value) {
    if (slot.state === "stopping" || slot.task !== task) return;
    slot.task = null;
    task.slot = null;
    slot.state = "idle";
    settle(task, error, value);
    slot.worker.unref?.();
    if (queue.length) pump();
    else scheduleIdleRetirement(slot);
  }

  function dispatch(slot, task) {
    clearIdleTimer(slot);
    slot.task = task;
    slot.state = "busy";
    task.slot = slot;
    task.state = "active";
    activeTasks.add(task);
    slot.worker.ref?.();
    try {
      slot.worker.postMessage({
        id: task.id,
        svg: task.svg,
        samples: task.samples,
        options: task.options,
        raw: task.raw,
        dither: task.dither,
        ...(task.draft ? { draft: true } : {}),
      });
    } catch (error) {
      completeSlot(slot, task, poolError(workerFailureMessage(error), "RENDER_WORKER_INPUT"));
    }
  }

  function handleMessage(slot, message) {
    if (isWatchDependencyNotification(message)) {
      forwardWatchDependencyNotification(message);
      return;
    }
    if (slot.state === "stopping") return;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      void retireSlot(slot, poolError("Resvg worker sent an invalid response.", "RENDER_WORKER_PROTOCOL"));
      return;
    }
    if (message.type === "ready") {
      if (slot.ready || message.version !== 1 || slot.state !== "starting") {
        void retireSlot(slot, poolError("Resvg worker sent an invalid startup response.", "RENDER_WORKER_PROTOCOL"));
        return;
      }
      slot.ready = true;
      if (slot.task) dispatch(slot, slot.task);
      else {
        slot.state = "idle";
        slot.worker.unref?.();
        scheduleIdleRetirement(slot);
      }
      pump();
      return;
    }
    const task = slot.task;
    if (!task || message.id !== task.id) {
      void retireSlot(slot, poolError("Resvg worker returned a response for the wrong request.", "RENDER_WORKER_PROTOCOL"));
      return;
    }
    if (typeof message.error === "string") {
      completeSlot(slot, task, new Error(message.error.slice(0, 500)));
      return;
    }
    const pixels = task.raw ? message.pixels : message.buffer;
    if (!Number.isSafeInteger(message.width) || message.width < 1 ||
        !Number.isSafeInteger(message.height) || message.height < 1 ||
        !(pixels instanceof ArrayBuffer)) {
      void retireSlot(slot, poolError("Resvg worker returned invalid image data.", "RENDER_WORKER_PROTOCOL"));
      return;
    }
    const image = task.raw
      ? { pixels: Buffer.from(pixels), width: message.width, height: message.height }
      : { buffer: Buffer.from(pixels), width: message.width, height: message.height };
    if (task.reference) {
      if (!(message.reference instanceof ArrayBuffer) || message.reference.byteLength !== 32 * 18 * 3) {
        void retireSlot(slot, poolError("Resvg worker returned an invalid frame reference.", "RENDER_WORKER_PROTOCOL"));
        return;
      }
      image.reference = Buffer.from(message.reference);
    } else if (message.reference !== undefined) {
      void retireSlot(slot, poolError("Resvg worker returned an unexpected frame reference.", "RENDER_WORKER_PROTOCOL"));
      return;
    }
    completeSlot(slot, task, null, image);
  }

  function spawnSlot(task) {
    let worker;
    try {
      worker = workerFactory(WORKER_URL, {});
      if (!worker || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function" ||
          typeof worker.on !== "function") throw new TypeError("workerFactory did not return a Worker.");
    } catch (error) {
      settle(task, poolError(workerFailureMessage(error), "RENDER_WORKER_START"));
      return;
    }
    const slot = {
      worker,
      task,
      state: "starting",
      ready: false,
      idleTimer: null,
      retirePromise: null,
    };
    task.slot = slot;
    task.state = "starting";
    activeTasks.add(task);
    slots.add(slot);
    worker.ref?.();
    worker.on("message", (message) => handleMessage(slot, message));
    worker.on("error", (error) => {
      void retireSlot(slot, poolError(workerFailureMessage(error), "RENDER_WORKER_CRASH"));
    });
    worker.on("exit", (code) => {
      if (slot.state !== "stopping") {
        void retireSlot(slot, poolError(`Resvg worker exited unexpectedly (${code}).`, "RENDER_WORKER_CRASH"));
      }
    });
  }

  function pump() {
    if (closed) return;
    while (queue.length) {
      let slot = [...slots].find((candidate) => candidate.state === "idle");
      const task = queue.shift();
      queuedBytes -= task.bytes;
      task.state = "dispatching";
      if (slot) {
        dispatch(slot, task);
        continue;
      }
      // Load native Resvg modules one worker at a time, then allow the next worker to start.
      if (slots.size >= size || [...slots].some((candidate) => candidate.state === "starting")) {
        queue.unshift(task);
        queuedBytes += task.bytes;
        task.state = "queued";
        return;
      }
      spawnSlot(task);
    }
  }

  function abortTask(task) {
    if (task.settled) return;
    const error = abortError(task.signal?.reason);
    if (task.state === "queued") {
      if (removeFromQueue(queue, task)) queuedBytes -= task.bytes;
      settle(task, error);
      pump();
      return;
    }
    if (task.slot) void retireSlot(task.slot, error);
  }

  // Every frame draws each tilted layer's flat drawing once (flatten-tilts.mjs); `draft` (check,
  // look and draft render frames) caps that bitmap by the frame's size.
  async function render(svg, resvgOptions = {}, { signal, raw = false, samples = [], dither = false, draft = false } = {}) {
    if (closed) throw poolError("Resvg render pool is closed.", "RENDER_POOL_CLOSED");
    validateSignal(signal);
    if (signal?.aborted) throw abortError(signal.reason);
    if (typeof raw !== "boolean") throw new TypeError("Resvg render raw must be true or false.");
    if (typeof dither !== "boolean") throw new TypeError("Resvg render dither must be true or false.");
    const input = prepareInput(svg, resvgOptions, samples);
    if (raw && (input.samples.length > 0 || dither)) {
      throw new TypeError("Resvg raw renders cannot blend samples or apply dither.");
    }
    if (input.bytes > maxBytes) {
      throw poolError("Resvg render request exceeds the pool's queued byte limit.", "RENDER_POOL_FULL");
    }
    let id = nextId;
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    return await new Promise((resolve, reject) => {
      const task = {
        ...input,
        id,
        raw,
        dither,
        draft: draft === true,
        reference: !raw && (input.samples.length > 0 || dither),
        bytes: input.bytes,
        signal,
        resolve,
        reject,
        state: "queued",
        slot: null,
        settled: false,
        abortListener: null,
      };
      task.abortListener = () => abortTask(task);
      signal?.addEventListener("abort", task.abortListener, { once: true });
      if (signal?.aborted) {
        task.abortListener();
        return;
      }
      queue.push(task);
      queuedBytes += task.bytes;
      pump();
      if (task.state === "queued" && (queue.length > maxQueue || queuedBytes > maxBytes)) {
        removeFromQueue(queue, task);
        queuedBytes -= task.bytes;
        const full = poolError("Resvg render pool is full; try again after an active frame finishes.", "RENDER_POOL_FULL");
        full.retry = true;
        settle(task, full);
      }
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const closedError = poolError("Resvg render pool is closed.", "RENDER_POOL_CLOSED");
    for (const task of queue.splice(0)) {
      queuedBytes -= task.bytes;
      settle(task, closedError);
    }
    closePromise = Promise.all([...slots].map((slot) => retireSlot(slot, closedError))).then(() => undefined);
    return closePromise;
  }

  function stats() {
    return {
      size,
      maxQueue,
      maxBytes,
      workers: slots.size,
      starting: [...slots].filter((slot) => slot.state === "starting").length,
      busy: [...slots].filter((slot) => slot.state === "busy" || slot.state === "starting").length,
      active: activeTasks.size,
      queued: queue.length,
      queuedBytes,
      closed,
    };
  }

  return { render, close, stats };
}

/**
 * A pool whose render waits for room instead of failing when the queue is full: a render, a look
 * and a check share one pool, so a look's frames must not make the render's next frame fail.
 */
export function waitingPool(pool, retryMs = 50) {
  async function render(svg, options, settings = {}) {
    for (;;) {
      try { return await pool.render(svg, options, settings); }
      catch (error) {
        if (!error?.retry) throw error;
        if (settings.signal?.aborted) throw abortError(settings.signal.reason);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }
  return { ...pool, render };
}

/** Shared lazy pool: no worker process starts until the first render request. */
export const defaultRenderPool = waitingPool(createRenderPool());
