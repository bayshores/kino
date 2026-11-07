import { createRequire } from "node:module";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { graphicsCacheInput, graphicsLaunch, graphicsNeedsCards, hostPlatform, listGraphics } from "./render-devices.mjs";
import { lowerIfBackground } from "./render-activity.mjs";

const MAX_ACTIVE_CLIENTS = 2;
// An export's extra workers (createChromiumRasterizer `workers`) start only while fewer than this
// many raster workers run in this process, first workers included. An export's first worker waits for one of the MAX_ACTIVE_CLIENTS slots
// instead, so a second export can still start one worker beside a full pool.
export const MAX_RASTER_WORKERS = 8;
const MAX_SVG_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_LINE_BYTES = 256 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_SIDE = 16384;
const MAX_PIXELS = 64_000_000;
const STARTUP_TIMEOUT_MS = 15_000;
// The time a frame of up to 1920x1080 pixels may take (frameTimeLimitMs gives a bigger one more).
const FRAME_TIMEOUT_MS = 45_000;
const FRAME_TIMEOUT_PIXELS = 1920 * 1080;
// The longest time limit the worker accepts (desktop/raster-worker.cjs checks the same number).
const MAX_FRAME_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// A frame is drawn at most this many times: once more, by another worker, after the worker drawing
// it stopped or ran out of time (createPool): one retry is enough when a worker crashes.
const MAX_DRAWS = 2;
// An export starts at most this many workers in place of ones that stopped, so an export whose
// workers keep stopping ends instead of starting Electron again for frame after frame.
const MAX_NEW_WORKERS = 8;
const TERMINATE_GRACE_MS = 1_000;
// The worker's ready message gives this; desktop/raster-worker.cjs must send the same number.
// Version 3: the page paints from an IPC message (no longer from JavaScript source), may load the
// export's own PNG files by kino-frame://media/ link, and each answer gives the renderer's memory.
const PROTOCOL_VERSION = 3;
const require = createRequire(import.meta.url);
const workerEntryPath = fileURLToPath(new URL("../desktop/raster-worker.cjs", import.meta.url));

let activeClients = 0;
// Workers a pool started beyond its first one. They take no queue slot (MAX_ACTIVE_CLIENTS) but
// count against MAX_RASTER_WORKERS.
let extraClients = 0;
const waitingClients = [];

// How many raster workers this process has started. Tests read it to check how many an export used.
export const rasterWorkerStarts = { count: 0 };

// Workers that exports have chosen to start (claimRasterWorkers) and that have not yet taken their
// slot (activeClients or extraClients) or given up. An export's extra workers start only once its
// first worker is ready, about a second later, so without this count a second export that chose
// its worker count in that second saw none of them and chose as many again.
let promisedClients = 0;

// The raster workers running now in this process (all exports), and those chosen to start, so a
// new export can leave room.
export function rasterWorkersRunning() {
  return activeClients + extraClients + promisedClients;
}

/**
 * Counts `count` workers as running from now, before they start, so that an export choosing its
 * worker count next leaves room for them (call it in the same step as choosing the count). Answers
 * release(number = 1), which gives back that many places, never more than `count` in all:
 * createChromiumRasterizer (given it as `claim`) gives one back as each worker takes its slot or
 * will not start, and all that are left once it knows the rest will not start.
 */
export function claimRasterWorkers(count) {
  let left = Number.isSafeInteger(count) && count > 0 ? count : 0;
  promisedClients += left;
  return (number = 1) => {
    const returned = Math.min(left, number > 0 ? Math.floor(number) : 0);
    left -= returned;
    promisedClients -= returned;
  };
}

// How many frames this process has asked Chromium for, by the kind of answer: a PNG file or raw
// pixels. Tests read it to check which one an export used.
export const rasterFrameCounts = { png: 0, pixels: 0 };

function abortError(reason) {
  const message = typeof reason?.message === "string" && reason.message.trim()
    ? reason.message.trim().slice(0, 300)
    : "Chromium rasterization was cancelled.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function conciseError(value, fallback = "Chromium raster worker failed.") {
  const message = typeof value === "string" ? value : value?.message;
  return new Error((message || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500));
}

// Marks a failure that another worker may get past: the worker crashed or ended, or its frame ran
// out of time. A pool draws that frame again with another worker (createPool).
function retryable(error) {
  error.retryable = true;
  return error;
}

// What desktop/raster-worker.cjs answers when the page never showed the frame within its time.
const WORKER_OUT_OF_TIME = "Chromium did not draw the export frame in time.";

/**
 * The time (milliseconds) Chromium may take to draw one frame of width x height: `base` (45 s) for
 * up to 1920x1080 pixels, and that many times more for each further 1920x1080 pixels, since
 * drawing takes about as much longer as there are more pixels. A 4K frame may take 180 s.
 */
export function frameTimeLimitMs(width, height, base = FRAME_TIMEOUT_MS) {
  return Math.min(MAX_FRAME_TIMEOUT_MS, Math.round(base * Math.max(1, (width * height) / FRAME_TIMEOUT_PIXELS)));
}

// 45000 -> "45", 180000 -> "180", 10 -> "0.01".
const secondsText = (milliseconds) => String(Number((milliseconds / 1000).toFixed(2)));

function validateOptions({ directory, signal, mediaDirectory }) {
  if (typeof directory !== "string" || !directory.trim() || !path.isAbsolute(directory)) {
    throw new TypeError("Chromium rasterization needs an absolute export directory.");
  }
  if (mediaDirectory !== undefined && (typeof mediaDirectory !== "string" || !path.isAbsolute(mediaDirectory))) {
    throw new TypeError("The Chromium media folder must be an absolute path.");
  }
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw new TypeError("Chromium rasterization needs a valid AbortSignal.");
  }
}

function validateFrame(svg, width, height) {
  if (typeof svg !== "string" || Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
    throw new RangeError("Chromium raster SVG must be a string no larger than 64 MiB.");
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new RangeError("Chromium raster dimensions exceed the 16384-side or 64-megapixel limit.");
  }
}

function resolveExecutable(env, dependencies) {
  const configured = dependencies.electronExecutable ?? env.KINO_ELECTRON_EXECUTABLE;
  let installed = configured;
  if (installed == null) {
    try { installed = require("electron"); }
    catch { throw new Error("Effect export needs Chromium. Run npm ci to install the project dependencies, or use the kino Mac app."); }
  }
  if (typeof installed !== "string" || !installed.trim()) {
    throw new Error("Could not resolve the Electron executable for Chromium rasterization.");
  }
  return installed;
}

// What a worker's message says it draws with (desktop/raster-worker.cjs drawingRenderer):
// { renderer, card }, both null when it does not say; undefined when they are not valid.
function drawingOf(message) {
  if ((message.renderer != null && (typeof message.renderer !== "string" || message.renderer.length > 200)) ||
      (message.card != null && typeof message.card !== "boolean")) return undefined;
  return {
    renderer: message.renderer ? message.renderer.replace(/[\u0000-\u001f\u007f]/g, " ") : null,
    card: typeof message.card === "boolean" ? message.card : null,
  };
}

// `graphics`: what graphicsLaunch answered for the export's graphics setting, { env, args } (the
// variables and switches that steer which card the worker draws on).
function createLaunch(directory, dependencies, mediaDirectory, graphics) {
  const env = { ...(dependencies.env ?? process.env), ...graphics?.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = resolveExecutable(env, dependencies);
  const packaged = dependencies.isPackaged ?? env.KINO_ELECTRON_PACKAGED === "1";
  const workerEntry = dependencies.workerEntry ?? workerEntryPath;
  const args = [
    "--kino-raster-worker",
    `--kino-raster-directory=${directory}`,
    `--user-data-dir=${path.join(directory, "profile")}`,
    `--disk-cache-dir=${path.join(directory, "profile", "cache")}`,
    `--crash-dumps-dir=${path.join(directory, "crashes")}`,
  ];
  if (mediaDirectory) args.push(`--kino-raster-media=${mediaDirectory}`);
  for (const argument of graphics?.args ?? []) args.push(argument);
  if (!packaged) args.unshift(workerEntry);
  return {
    executable,
    args,
    options: { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  };
}

function reserve(client) {
  if (client.closing) return;
  if (client.extra) {
    // A pool's extra worker never waits: it starts now if the process-wide total allows it.
    if (activeClients + extraClients >= MAX_RASTER_WORKERS) {
      void client.stop(new Error("No Chromium export worker is free."));
      return;
    }
    extraClients += 1;
    client.slotHeld = true;
    client.dropClaim();
    client.launch();
    return;
  }
  if (activeClients < MAX_ACTIVE_CLIENTS) {
    activeClients += 1;
    client.slotHeld = true;
    client.dropClaim();
    client.launch();
    return;
  }
  client.queued = true;
  waitingClients.push(client);
}

function release(client) {
  if (!client.slotHeld) return;
  client.slotHeld = false;
  if (client.extra) {
    extraClients -= 1;
    return;
  }
  activeClients -= 1;
  while (waitingClients.length) {
    const next = waitingClients.shift();
    next.queued = false;
    if (next.closing || next.signal?.aborted) {
      next.stop(next.signal?.aborted ? abortError(next.signal.reason) : new Error("Chromium rasterizer is closed."));
      continue;
    }
    activeClients += 1;
    next.slotHeld = true;
    next.dropClaim();
    next.launch();
    break;
  }
}

function removeWaiting(client) {
  if (!client.queued) return;
  client.queued = false;
  const index = waitingClients.indexOf(client);
  if (index >= 0) waitingClients.splice(index, 1);
}

class ChromiumRasterClient {
  constructor(options, dependencies, resolve, reject) {
    this.directory = options.directory;
    this.mediaDirectory = options.mediaDirectory;
    this.graphics = options.graphics;
    this.signal = options.signal;
    // An extra worker of a pool (createPool): it starts without waiting for a queue slot.
    this.extra = options.extra === true;
    // Its export's claim (claimRasterWorkers), given back once this worker has a slot or stops.
    this.claim = typeof options.claim === "function" ? options.claim : null;
    // Called once when the worker has stopped, with the reason (a pool stops its other workers).
    this.onStop = null;
    // What the page's renderer said about its memory (KB): after the last frame and the most.
    this.memory = { frames: 0, rendererKB: null, peakRendererKB: null };
    // What the worker said it draws with, in its ready line or a later answer: the card's name or
    // "processor (software)", and whether that is a graphics card (both null when it did not say).
    this.drawing = { renderer: null, card: null };
    this.dependencies = dependencies;
    this.resolveStartup = resolve;
    this.rejectStartup = reject;
    this.startupSettled = false;
    this.slotHeld = false;
    this.queued = false;
    this.ready = false;
    this.closing = false;
    this.closed = false;
    this.finalized = false;
    this.child = null;
    this.childClosePromise = null;
    this.resolveChildClose = null;
    this.stopPromise = null;
    this.stopReason = null;
    this.startupTimer = null;
    this.frameTimer = null;
    this.nextRequestId = 1;
    this.requests = [];
    this.inFlight = null;
    this.stdoutParts = [];
    this.stdoutLength = 0;
    // The pixels of a `pixels` response while their bytes arrive: { request, buffer, received }.
    this.incomingPixels = null;
    // The request whose pixels have all arrived and whose end line ({"id":N,"end":true}) comes next.
    this.awaitingPixelsEnd = null;
    this.stderrParts = [];
    this.stderrLength = 0;
    this.stderrTail = Buffer.alloc(0);
    this.signalHandler = () => { void this.stop(abortError(this.signal?.reason)); };
    this.onStdout = (chunk) => this.consumeStdout(chunk);
    this.onStderr = (chunk) => this.consumeStderr(chunk);
    this.onChildError = (error) => { void this.stop(error?.code === "ENOENT"
      ? new Error("The Chromium export runtime was not found. Run npm ci or use the kino Mac app.")
      : conciseError(error, "Chromium raster worker could not start.")); };
    this.onStdinError = (error) => { void this.stop(conciseError(error, "Chromium raster request could not be written.")); };
    this.onChildExit = (code, childSignal) => {
      if (this.closing) return;
      const error = retryable(this.exitError(code, childSignal));
      if (this.inFlight) error.message = `${error.message.replace(/\.$/, "")} while drawing ${this.describe(this.inFlight)}.`.slice(0, 500);
      void this.stop(error);
    };
    this.onChildClose = (code, childSignal) => this.childDidClose(code, childSignal);
  }

  dropClaim() {
    const release = this.claim;
    this.claim = null;
    release?.(1);
  }

  launch() {
    if (this.closing) return;
    if (this.signal?.aborted) {
      void this.stop(abortError(this.signal.reason));
      return;
    }
    let launch;
    try {
      launch = createLaunch(this.directory, this.dependencies, this.mediaDirectory, this.graphics);
      const spawn = this.dependencies.spawn ?? nodeSpawn;
      this.child = spawn(launch.executable, launch.args, launch.options);
      lowerIfBackground(this.child);
      if (!this.child?.stdin || !this.child.stdout || !this.child.stderr || typeof this.child.on !== "function") {
        throw new Error("Electron did not provide the raster worker streams.");
      }
      rasterWorkerStarts.count += 1;
    } catch (error) {
      this.stopReason = conciseError(error, "Chromium raster worker could not start.");
      this.finalize(this.stopReason);
      return;
    }

    this.childClosePromise = new Promise((resolve) => { this.resolveChildClose = resolve; });
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.stdin.on("error", this.onStdinError);
    this.child.on("error", this.onChildError);
    this.child.on("exit", this.onChildExit);
    this.child.on("close", this.onChildClose);
    this.startupTimer = this.setTimer(() => {
      void this.stop(new Error("Chromium raster worker did not become ready within 15 seconds."));
    }, this.dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    this.startupTimer?.unref?.();
  }

  setTimer(callback, delay) {
    return (this.dependencies.setTimeout ?? setTimeout)(callback, delay);
  }

  clearTimer(timer) {
    if (timer !== null && timer !== undefined) (this.dependencies.clearTimeout ?? clearTimeout)(timer);
  }

  consumeStderr(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // The worker's line about its page's renderer (desktop/raster-worker.cjs) says why it stopped,
    // and comes last: it is kept however much Chromium logged before it.
    this.stderrTail = Buffer.concat([this.stderrTail, value]).subarray(-1024);
    if (this.stderrLength >= MAX_STDERR_BYTES) return;
    const kept = value.subarray(0, MAX_STDERR_BYTES - this.stderrLength);
    this.stderrParts.push(Buffer.from(kept));
    this.stderrLength += kept.length;
  }

  stderrSummary() {
    const text = Buffer.concat(this.stderrParts, this.stderrLength).toString("utf8");
    const gone = /page renderer gone: [^\n]*/.exec(this.stderrTail.toString("utf8"))?.[0];
    return (gone && !text.slice(0, 240).includes(gone) ? `${gone} ${text}` : text)
      .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  }

  consumeStdout(chunk) {
    if (this.closing || this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && !this.closing) {
      if (this.incomingPixels) {
        start = this.consumePixels(bytes, start);
        continue;
      }
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) {
        const part = bytes.subarray(start);
        if (this.stdoutLength + part.length > MAX_OUTPUT_LINE_BYTES) {
          void this.stop(new Error("Chromium raster worker exceeded the 256 MiB response limit."));
          return;
        }
        if (part.length) {
          this.stdoutParts.push(Buffer.from(part));
          this.stdoutLength += part.length;
        }
        return;
      }
      const part = bytes.subarray(start, newline);
      const lineLength = this.stdoutLength + part.length;
      if (lineLength > MAX_OUTPUT_LINE_BYTES) {
        void this.stop(new Error("Chromium raster worker exceeded the 256 MiB response limit."));
        return;
      }
      let line = this.stdoutLength
        ? Buffer.concat([...this.stdoutParts, part], lineLength)
        : Buffer.from(part);
      this.stdoutParts = [];
      this.stdoutLength = 0;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      this.handleLine(line);
      start = newline + 1;
    }
  }

  // Copies the bytes of a pixel response that follow its JSON line. Once all of them have arrived,
  // the request waits for its end line (pixelsEndLine). Returns where the unread bytes of this
  // chunk start.
  consumePixels(bytes, start) {
    const incoming = this.incomingPixels;
    const end = Math.min(bytes.length, start + incoming.buffer.length - incoming.received);
    bytes.copy(incoming.buffer, incoming.received, start, end);
    incoming.received += end - start;
    if (incoming.received === incoming.buffer.length) {
      this.incomingPixels = null;
      const { request, buffer } = incoming;
      request.pixelsValue = { pixels: buffer, width: request.width, height: request.height };
      this.awaitingPixelsEnd = request;
    }
    return end;
  }

  // The line right after a frame's pixels must be exactly {"id":N,"end":true}. Any other line means
  // bytes that do not belong got into the response (or some are missing), so the pixels counted
  // as this frame's are shifted: the worker is stopped instead of the frame being answered.
  pixelsEndLine(line) {
    const request = this.awaitingPixelsEnd;
    this.awaitingPixelsEnd = null;
    if (line.toString("latin1") !== JSON.stringify({ id: request.id, end: true })) {
      void this.stop(new Error("Chromium raster worker sent a frame's pixels with bytes that do not belong or are missing."));
      return;
    }
    request.response = { value: request.pixelsValue };
    this.finishRequestIfReady(request);
  }

  handleLine(line) {
    if (!line.length || this.closing) {
      if (!this.closing) void this.stop(new Error("Chromium raster worker sent an empty protocol line."));
      return;
    }
    if (this.awaitingPixelsEnd) return this.pixelsEndLine(line);
    const text = line.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(line)) {
      void this.stop(new Error("Chromium raster worker sent invalid UTF-8."));
      return;
    }
    let message;
    try { message = JSON.parse(text); }
    catch { void this.stop(new Error("Chromium raster worker sent invalid JSON.")); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      void this.stop(new Error("Chromium raster worker sent an invalid message."));
      return;
    }

    if (!this.ready) {
      // A server that kept running while kino was updated still has the old version of this file,
      // but starts the worker from the new file on disk (or the other way round).
      if (message.type === "ready" && Number.isSafeInteger(message.version) && message.version !== PROTOCOL_VERSION) {
        void this.stop(new Error(`The Chromium export worker is version ${message.version}, but this kino needs version ${PROTOCOL_VERSION}. Restart kino after updating it.`));
        return;
      }
      // `renderer` and `card` are new in the same version 3, so an older worker may leave them out.
      const drawing = drawingOf(message);
      if (message.type !== "ready" || message.version !== PROTOCOL_VERSION ||
          typeof message.electron !== "string" || message.electron.length > 80 ||
          typeof message.chromium !== "string" || message.chromium.length > 80 || !drawing) {
        void this.stop(new Error("Chromium raster worker sent an invalid startup message."));
        return;
      }
      this.drawing = drawing;
      this.ready = true;
      this.clearTimer(this.startupTimer);
      this.startupTimer = null;
      this.startupSettled = true;
      this.resolveStartup({
        render: (svg, width, height, options) => this.render(svg, width, height, { ...options, pixels: false }),
        renderPixels: (svg, width, height, options) => this.render(svg, width, height, { ...options, pixels: true }),
        mediaUrl: (file) => this.mediaUrl(file),
        memory: () => ({ ...this.memory }),
        drawing: () => ({ ...this.drawing }),
        close: () => this.close(),
      });
      this.pump();
      return;
    }

    const request = this.inFlight;
    if (!request || message.id !== request.id || !Number.isSafeInteger(message.id)) {
      void this.stop(new Error("Chromium raster worker returned a response for the wrong request."));
      return;
    }
    // A worker whose GPU process reported after its ready line says what draws in the answer after.
    if (message.renderer != null || message.card != null) {
      const drawing = drawingOf(message);
      if (!drawing) {
        void this.stop(new Error("Chromium raster worker returned an invalid renderer."));
        return;
      }
      this.drawing = drawing;
    }
    if (Number.isSafeInteger(message.rendererKB) && message.rendererKB > 0) {
      this.memory.frames += 1;
      this.memory.rendererKB = message.rendererKB;
      this.memory.peakRendererKB = Math.max(this.memory.peakRendererKB ?? 0, message.rendererKB);
    }
    if (Object.hasOwn(message, "error")) {
      if (typeof message.error !== "string") {
        void this.stop(new Error("Chromium raster worker returned an invalid error response."));
        return;
      }
      const error = conciseError(message.error, "Chromium could not render this frame.");
      // The page never showed this frame in time: say which frame it was, as the time limit
      // below does, and let a pool draw it again with another worker.
      if (error.message === WORKER_OUT_OF_TIME) retryable(error).message = `${WORKER_OUT_OF_TIME.slice(0, -1)} (${this.describe(request)}).`;
      request.response = { error };
    } else if (request.pixels) {
      // The pixels follow this line as width × height × 4 bytes (consumePixels).
      if (message.width !== request.width || message.height !== request.height ||
          message.pixelBytes !== request.width * request.height * 4 || Object.hasOwn(message, "png")) {
        void this.stop(new Error("Chromium raster worker returned invalid pixel data or dimensions."));
        return;
      }
      this.incomingPixels = { request, buffer: Buffer.allocUnsafe(message.pixelBytes), received: 0 };
      return;
    } else {
      try {
        request.response = { value: this.validatePng(message, request.width, request.height) };
      } catch (error) {
        void this.stop(error);
        return;
      }
    }
    this.finishRequestIfReady(request);
  }

  validatePng(message, width, height) {
    if (message.width !== width || message.height !== height || typeof message.png !== "string" ||
        message.png.length === 0 || message.png.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(message.png)) {
      throw new Error("Chromium raster worker returned invalid PNG data or dimensions.");
    }
    const buffer = Buffer.from(message.png, "base64");
    if (buffer.toString("base64") !== message.png || buffer.length < 24 ||
        !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        buffer.toString("ascii", 12, 16) !== "IHDR" ||
        buffer.readUInt32BE(16) !== width || buffer.readUInt32BE(20) !== height) {
      throw new Error("Chromium raster worker returned a PNG with an unexpected header.");
    }
    return { buffer, width, height };
  }

  // The link by which the page loads `file`, a picture (PNG, JPEG, WebP, GIF or AVIF) inside this
  // worker's media folder, without its bytes going into the SVG (desktop/raster-worker.cjs answers
  // it); null for any other file.
  mediaUrl(file) {
    if (!this.mediaDirectory || typeof file !== "string" || !path.isAbsolute(file)) return null;
    const relative = path.relative(this.mediaDirectory, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !/\.(?:png|jpe?g|webp|gif|avif)$/i.test(file)) return null;
    return `kino-frame://media${pathToFileURL(file).pathname}`;
  }

  // Answers { buffer, width, height } with a PNG file, or with `pixels: true`
  // { pixels, width, height }: RGBA bytes with premultiplied alpha, row by row. `label` names the
  // frame (for example "frame 151 at 5.033 s") in a time-limit error. `draft` (check and look
  // frames) lets the page draw a tilted layer's shared bitmap no bigger than the output needs.
  render(svg, width, height, { pixels = false, label, draft = false } = {}) {
    if (this.closing || this.closed) return Promise.reject(new Error("Chromium rasterizer is closed."));
    try { validateFrame(svg, width, height); }
    catch (error) { return Promise.reject(error); }
    rasterFrameCounts[pixels ? "pixels" : "png"] += 1;
    const timeoutMs = frameTimeLimitMs(width, height, this.dependencies.frameTimeoutMs ?? FRAME_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      this.requests.push({ svg, width, height, pixels, draft: draft === true, timeoutMs, label: typeof label === "string" ? label.slice(0, 120) : null, resolve, reject });
      this.pump();
    });
  }

  // Which frame a request is, for an error: its label (or request number), size and SVG length.
  describe(request) {
    const megabytes = (Buffer.byteLength(request.svg, "utf8") / 1048576).toFixed(1);
    return `${request.label ?? `request ${request.id}`}, ${request.width}x${request.height}, SVG ${megabytes} MB`;
  }

  pump() {
    if (!this.ready || this.closing || this.closed || this.inFlight || this.requests.length === 0) return;
    const request = this.requests.shift();
    request.id = this.nextRequestId++;
    this.inFlight = request;
    this.frameTimer = this.setTimer(() => {
      void this.stop(retryable(new Error(`Chromium raster frame exceeded the ${secondsText(request.timeoutMs)} second time limit (${this.describe(request)}).`)));
    }, request.timeoutMs);
    this.frameTimer?.unref?.();

    let callbackDone = false;
    let callbackError = null;
    let writeReturned = false;
    let accepted = false;
    let drainOccurred = false;
    const stdin = this.child.stdin;
    const onDrain = () => {
      drainOccurred = true;
      if (writeReturned && !accepted) this.completeWrite(request, callbackDone, callbackError, true);
    };
    request.onDrain = onDrain;
    stdin.once("drain", onDrain);
    // `timeoutMs` tells the worker how long it may try to capture the frame (raster-worker.cjs).
    const line = `${JSON.stringify({ id: request.id, svg: request.svg, width: request.width, height: request.height, pixels: request.pixels, ...(request.draft ? { draft: true } : {}), timeoutMs: request.timeoutMs })}\n`;
    try {
      accepted = stdin.write(line, (error) => {
        callbackDone = true;
        callbackError = error ?? null;
        if (writeReturned) this.completeWrite(request, callbackDone, callbackError, accepted || drainOccurred);
      });
      writeReturned = true;
      if (accepted) stdin.removeListener("drain", onDrain);
      this.completeWrite(request, callbackDone, callbackError, accepted || drainOccurred || stdin.writableNeedDrain === false);
    } catch (error) {
      stdin.removeListener("drain", onDrain);
      void this.stop(conciseError(error, "Chromium raster request could not be written."));
    }
  }

  completeWrite(request, callbackDone, callbackError, drained) {
    if (this.inFlight !== request || this.closing) return;
    if (callbackError) {
      void this.stop(conciseError(callbackError, "Chromium raster request could not be written."));
      return;
    }
    if (!callbackDone || !drained) return;
    request.writeDone = true;
    if (request.onDrain) {
      this.child.stdin.removeListener("drain", request.onDrain);
      request.onDrain = null;
    }
    this.finishRequestIfReady(request);
  }

  finishRequestIfReady(request) {
    if (this.inFlight !== request || !request.writeDone || !request.response) return;
    this.clearTimer(this.frameTimer);
    this.frameTimer = null;
    this.inFlight = null;
    if (request.response.error) request.reject(request.response.error);
    else request.resolve(request.response.value);
    this.pump();
  }

  exitError(code, childSignal) {
    const detail = this.stderrSummary();
    const status = childSignal ? `signal ${childSignal}` : `code ${code ?? "unknown"}`;
    return new Error(`Chromium raster worker exited with ${status}.${detail ? ` ${detail}` : ""}`.slice(0, 500));
  }

  childDidClose(code, childSignal) {
    if (this.closed) return;
    let reason = this.stopReason;
    if (!this.closing) {
      if (!this.ready) reason = new Error(`Chromium raster worker exited before startup completed. ${this.stderrSummary()}`.slice(0, 500));
      else if (this.stdoutLength || this.incomingPixels || this.awaitingPixelsEnd) reason = retryable(new Error("Chromium raster worker ended during a response."));
      else reason = retryable(this.exitError(code, childSignal));
      this.stopReason = reason;
      this.closing = true;
    }
    this.finalize(reason ?? new Error("Chromium rasterizer is closed."));
  }

  finalize(reason) {
    if (this.finalized) return;
    this.finalized = true;
    this.incomingPixels = null;
    this.awaitingPixelsEnd = null;
    this.closing = true;
    this.closed = true;
    this.clearTimer(this.startupTimer);
    this.clearTimer(this.frameTimer);
    this.startupTimer = null;
    this.frameTimer = null;
    this.signal?.removeEventListener("abort", this.signalHandler);
    removeWaiting(this);
    const failure = reason instanceof Error ? reason : new Error("Chromium rasterizer is closed.");
    this.settleStartupFailure(failure);
    if (this.inFlight) {
      if (this.inFlight.onDrain) this.child?.stdin?.removeListener("drain", this.inFlight.onDrain);
      this.inFlight.reject(failure);
      this.inFlight = null;
    }
    for (const request of this.requests.splice(0)) request.reject(failure);
    if (this.child) {
      this.child.stdout?.removeListener("data", this.onStdout);
      this.child.stderr?.removeListener("data", this.onStderr);
      this.child.stdin?.removeListener("error", this.onStdinError);
      this.child.removeListener("error", this.onChildError);
      this.child.removeListener("exit", this.onChildExit);
      this.child.removeListener("close", this.onChildClose);
    }
    this.resolveChildClose?.();
    this.dropClaim();
    release(this);
    const onStop = this.onStop;
    this.onStop = null;
    onStop?.(failure);
  }

  settleStartupFailure(error) {
    if (this.startupSettled) return;
    this.startupSettled = true;
    this.rejectStartup(error);
  }

  stop(reason = new Error("Chromium rasterizer is closed.")) {
    if (this.stopPromise) return this.stopPromise;
    this.stopReason = reason instanceof Error ? reason : new Error(String(reason));
    this.closing = true;
    this.clearTimer(this.startupTimer);
    this.clearTimer(this.frameTimer);
    this.startupTimer = null;
    this.frameTimer = null;
    this.signal?.removeEventListener("abort", this.signalHandler);
    removeWaiting(this);
    // During startup the caller has no close() handle yet. Its rejection must
    // wait for the child to exit so the caller can safely remove the profile.
    if (this.inFlight) {
      if (this.inFlight.onDrain) this.child?.stdin?.removeListener("drain", this.inFlight.onDrain);
      this.inFlight.reject(this.stopReason);
      this.inFlight = null;
    }
    for (const request of this.requests.splice(0)) request.reject(this.stopReason);

    if (!this.child || this.closed) {
      this.finalize(this.stopReason);
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }
    this.stopPromise = (async () => {
      const killTimer = this.setTimer(() => {
        if (!this.closed) {
          try { this.child.kill("SIGKILL"); } catch { /* the close event settles the client */ }
        }
      }, this.dependencies.terminateGraceMs ?? TERMINATE_GRACE_MS);
      killTimer?.unref?.();
      if (!this.closed) {
        try { this.child.kill("SIGTERM"); } catch { /* still wait for close before releasing the slot */ }
      }
      await this.childClosePromise;
      this.clearTimer(killTimer);
      this.finalize(this.stopReason);
    })();
    return this.stopPromise;
  }

  close() {
    return this.stop(new Error("Chromium rasterizer is closed."));
  }
}

// Starts one worker. `client` is there at once; `ready` gives its handle once the page is ready.
function startClient(options, dependencies) {
  let client;
  const ready = new Promise((resolve, reject) => {
    client = new ChromiumRasterClient(options, dependencies, resolve, reject);
    if (options.signal) options.signal.addEventListener("abort", client.signalHandler, { once: true });
    if (options.signal?.aborted) client.signalHandler();
    else reserve(client);
  });
  return { client, ready };
}

// One or several workers that draw frames at the same time. Each request waits in one queue and
// goes to the first worker that is free, so the answers can come back in another order than the
// requests (export.mjs orderedFrames puts the frames back in order for FFmpeg). Every worker is the
// same Electron with the same switches, and each paint decodes its pictures afresh
// (desktop/raster-page.cjs paintLinks) and shows a frame only once it is ready (paintSvg), so
// pictures have the same pixels whichever worker draws them. Not every frame does yet when the
// graphics processor draws: what it draws depends a little on what that worker drew before and
// when (most likely the caches its process keeps from one frame to the next, one set per worker).
// On a 640x360 test scene of 60 frames (final quality, motion blur; a large group with zoom blur,
// glow, RGB shift and curves; nested groups with spin blur; a mask; fog, embers and grain; video,
// GIF, PNG and JPEG pictures), measured on 2026-10-20 on a Mac:
// - 4 workers gave 6 to 12 frames away from 1 worker's in each of 5 runs (1 to 3 pixels by 1 level
//   of 255 in each frame, where counted); each paint that differed, by 1 to 4 pixels and at most 2
//   levels;
// - 1 worker gave 1 or 2 frames 1 level away from its own first run in 3 of 7 runs (once 247 pixels);
// - one frame's SVG drawn after other frames came out 2 ways with the graphics processor (after the
//   same 8 frames, once each way), and 1 way after every history without it (KINO_RASTER_GPU=off,
//   10 paints); without it 4 workers gave 1 worker's pixels in 2 of 2 runs, but 4 times slower
//   (214.6 s for 1 worker, 121.5 to 126.2 s for 4, against 51.8 to 55.4 s and 47.5 to 49.6 s).
// - 1 worker on a transparent scene (a blurred, glowing, rotated group holding a JPEG, partly off the
//   scene) gave 1 to 11 pixels 1 level away in 6 of 35 runs; kino before the fresh decodes gave the
//   same bytes in 36 of 36, so that drift comes with the fresh decodes, not the graphics processor
//   alone. Its cause is not found yet.
// So exports use one worker unless KINO_RASTER_WORKERS asks for more (raster-workers.mjs).
//
// The first worker is already ready; the others start now and join when ready. One that cannot
// start is left out.
// A worker that stops for a reason another worker may get past (it crashed, its page's renderer
// was gone, or a frame ran out of time; `retryable` marks these) is left out, and the frame it was
// drawing goes back to the front of the queue for another worker. When no worker is left, a new
// one starts (at most MAX_NEW_WORKERS for the export). A frame that fails that way a second time
// (MAX_DRAWS), or any other stop (cancel, close, a broken answer), stops every worker with that
// reason, so the error names the frame that caused it. A frame the worker answers with an error of
// its own (an SVG that does not parse) fails alone, as before. `onWorkerStopped({ reason, label })`
// is called for each worker that was left out this way, with the label of the frame drawn again
// (null when it was drawing none). Workers are not restarted after some number of frames: a new
// worker can draw a frame 1 level of 255 away with the graphics processor (above), so each
// restart could change pixels, and only a worker that failed is replaced.
function createPool(first, options, dependencies) {
  const { directory, signal, mediaDirectory, graphics, graphicsKey, workers: count, claim, onWorkerStopped } = options;
  const workers = [];
  const clients = [first.client];
  const queue = [];
  let failure = null;
  let closing = false;
  // Workers asked for that are not ready yet and have not failed to start.
  let starting = 0;
  // Workers started in place of ones that stopped, and the folder number of the next worker.
  let newWorkers = 0;
  let nextFolder = 1;
  // Why the last worker that stopped did, for the error when no new worker can take its place.
  let lastStop = null;
  // The most workers that were ready at the same time (one started in place of a stopped one
  // does not add to it), for the answer's "N frames at once".
  let mostAtOnce = 0;

  function fail(reason) {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error("Chromium rasterizer is closed.");
    signal?.removeEventListener("abort", onAbort);
    for (const request of queue.splice(0)) request.reject(failure);
    for (const client of clients) void client.stop(failure);
  }
  const onAbort = () => fail(abortError(signal?.reason));
  const live = () => workers.filter((worker) => !worker.client.closing);

  function add(client, handle) {
    const worker = { client, handle, busy: false, request: null, reported: false };
    client.onStop = (reason) => stopped(worker, reason);
    workers.push(worker);
    mostAtOnce = Math.max(mostAtOnce, live().length);
  }

  // A worker has stopped. Its frame, when it was drawing one, comes back through drawFailed (just
  // before or just after this), which also reports it.
  function stopped(worker, reason) {
    if (closing || failure) return;
    if (!reason?.retryable) return fail(reason);
    lastStop = reason;
    if (!worker.request && !worker.reported) {
      worker.reported = true;
      onWorkerStopped?.({ reason, label: null });
    }
    dispatch();
  }

  function dispatch() {
    if (closing || failure) return;
    for (const worker of workers) {
      if (!queue.length) return;
      if (worker.busy || worker.client.closing) continue;
      draw(worker, queue.shift());
    }
    // Frames are waiting and no worker is left to draw them: start a new one.
    if (queue.length && starting === 0 && live().length === 0) replace();
  }

  function draw(worker, request) {
    worker.busy = true;
    worker.request = request;
    request.draws += 1;
    const render = request.pixels ? worker.handle.renderPixels : worker.handle.render;
    render(request.svg, request.width, request.height, { label: request.label, draft: request.draft })
      .then(request.resolve, (error) => drawFailed(worker, request, error))
      .finally(() => {
        worker.busy = false;
        worker.request = null;
        dispatch();
      });
  }

  function drawFailed(worker, request, error) {
    if (failure) return request.reject(failure);
    if (closing || !error?.retryable) return request.reject(error);
    if (request.draws >= MAX_DRAWS) {
      const final = new Error(`${error.message.slice(0, 440)} This was the frame's second try, on another worker.`);
      fail(final);
      return request.reject(final);
    }
    lastStop = error;
    // A worker that answered that the frame did not show in time is still running: it stops too.
    if (!worker.client.closing) void worker.client.stop(error);
    worker.reported = true;
    onWorkerStopped?.({ reason: error, label: request.label ?? null });
    // .finally() above calls dispatch(), which gives it to another worker or starts a new one.
    queue.unshift(request);
  }

  // Starts a worker in a folder of its own. `replacing`: it takes the place of workers that stopped.
  function start(replacing) {
    starting += 1;
    const folder = path.join(directory, `worker-${nextFolder++}`);
    // Called once if the worker will not draw. `started`: its Electron was started, and it gives
    // back its place in the claim itself.
    const gaveUp = (error, started) => {
      starting -= 1;
      if (!started && !replacing) claim?.(1);
      if (closing || failure) return;
      // A pool draws with the workers it has; when none is left to take a stopped one's place,
      // the export ends.
      if (replacing) fail(new Error(`${(lastStop?.message ?? "A Chromium raster worker stopped.").slice(0, 300)} A new worker could not start: ${String(error?.message).slice(0, 150)}`));
      else dispatch();
    };
    void mkdir(folder, { recursive: true, mode: 0o700 }).then(() => {
      if (closing || failure) return gaveUp(null, false);
      const { client, ready } = startClient({ directory: folder, signal, mediaDirectory, graphics, extra: true, claim: replacing ? undefined : claim }, dependencies);
      clients.push(client);
      ready.then((handle) => {
        starting -= 1;
        // A worker that became ready after a cancel or close was stopped with the others.
        if (closing || failure) return;
        add(client, handle);
        dispatch();
      }, (error) => gaveUp(error, true));
    }, (error) => gaveUp(error, false));
  }

  function replace() {
    if (newWorkers >= MAX_NEW_WORKERS) {
      return fail(new Error(`${(lastStop?.message ?? "Chromium raster workers stopped.").slice(0, 400)} ${MAX_NEW_WORKERS} new workers had already been started for this export.`));
    }
    newWorkers += 1;
    start(true);
  }

  add(first.client, first.handle);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  for (let number = 1; number < count; number += 1) start(false);

  const render = (pixels) => (svg, width, height, { label, draft } = {}) => {
    if (closing) return Promise.reject(new Error("Chromium rasterizer is closed."));
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      queue.push({ svg, width, height, pixels, label, draft, draws: 0, resolve, reject });
      dispatch();
    });
  };

  return {
    render: render(false),
    renderPixels: render(true),
    mediaUrl: (file) => first.handle.mediaUrl(file),
    // The graphics setting, KINO_RASTER_GPU, the card variables and whether the display is WSLg's
    // (render-devices.mjs graphicsCacheInput): frames drawn with another are not the same pixels,
    // so frame caches keep them apart.
    graphicsKey,
    // How many workers draw now or are starting (export.mjs keeps one frame more than this in hand).
    get workers() { return live().length + starting; },
    // The renderers' memory (KB) added up over the workers: after their last frames (the workers
    // still running) and the most (every worker). `workers`: the most that drew at once.
    memory: () => {
      const all = workers.map((worker) => ({ ...worker.handle.memory(), live: !worker.client.closing }));
      const add = (key, entries = all) => entries.some((entry) => entry[key] != null) ? entries.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) : null;
      return { frames: add("frames") ?? 0, rendererKB: add("rendererKB", all.filter((entry) => entry.live)), peakRendererKB: add("peakRendererKB"), workers: mostAtOnce };
    },
    // What the workers drew with, each different renderer once ({ renderer, card }, in the order
    // the workers became ready; a worker that did not say gives renderer null).
    renderers: () => {
      const seen = [];
      for (const worker of workers) {
        const drawing = worker.handle.drawing?.() ?? { renderer: null, card: null };
        if (!seen.some((entry) => entry.renderer === drawing.renderer)) seen.push(drawing);
      }
      return seen;
    },
    close: async () => {
      closing = true;
      signal?.removeEventListener("abort", onAbort);
      for (const request of queue.splice(0)) request.reject(new Error("Chromium rasterizer is closed."));
      // A worker that is still starting is stopped too (its folder must be free to delete).
      for (let settled = 0; settled < clients.length;) {
        settled = clients.length;
        await Promise.all(clients.map((client) => client.close()));
      }
    },
  };
}

/**
 * Starts isolated Electron workers that rasterize SVG frames: one by default, which draws one SVG
 * at a time, or `workers` (1 to MAX_RASTER_WORKERS) that draw that many frames at the same time.
 */
// `mediaDirectory` (optional, absolute): the folder whose PNG files the page may load by the links
// that mediaUrl(file) gives, so that big pictures need not travel inside the SVG.
// `claim` (optional): what claimRasterWorkers(workers) answered when the export chose `workers`.
// `onWorkerStopped` (optional): called with { reason, label } when a worker stopped and another
// draws on in its place (createPool).
// `graphics` (optional): "auto" (the default), "processor" or a card's name: which card the workers
// draw on (backend/render-devices.mjs graphicsLaunch). On WSL, and for a card's name on Linux, the
// cards are detected first (once for the server's life). Tests may give `dependencies.platform`,
// `dependencies.env`, `dependencies.files` and `dependencies.listGraphics`.
export async function createChromiumRasterizer(options = {}) {
  const { directory, signal, mediaDirectory, workers = 1 } = options;
  const setting = options.graphics ?? "auto";
  const claim = typeof options.claim === "function" ? options.claim : undefined;
  const onWorkerStopped = typeof options.onWorkerStopped === "function" ? options.onWorkerStopped : undefined;
  let handle, client;
  try {
    validateOptions({ directory, signal, mediaDirectory });
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > MAX_RASTER_WORKERS) {
      throw new RangeError(`Chromium raster workers must be a whole number from 1 to ${MAX_RASTER_WORKERS}.`);
    }
    const dependencies = options.dependencies ?? {};
    if (!dependencies || typeof dependencies !== "object") throw new TypeError("Chromium raster dependencies must be an object.");
    if (signal?.aborted) throw abortError(signal.reason);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The Chromium export directory must be a real directory.");
    if (signal?.aborted) throw abortError(signal.reason);
    if (typeof setting !== "string" || !setting.trim() || setting.length > 120) throw new TypeError("The graphics setting must be \"auto\", \"processor\" or a card's name.");
    const env = dependencies.env ?? process.env;
    const platform = dependencies.platform ?? hostPlatform({ env });
    const cards = graphicsNeedsCards(setting, platform) && env.KINO_RASTER_GPU !== "off"
      ? (await (dependencies.listGraphics ?? listGraphics)()).cards : [];
    if (signal?.aborted) throw abortError(signal.reason);
    const graphics = graphicsLaunch(setting, { platform, env, cards, ...(dependencies.files ? { files: dependencies.files } : {}) });
    let ready;
    ({ client, ready } = startClient({ directory, signal, mediaDirectory, graphics, claim }, dependencies));
    handle = await ready;
    // Extra workers give back their places in the claim as they start or give up (createPool).
    if (workers === 1) claim?.(Infinity);
    return createPool({ client, handle }, { directory, signal, mediaDirectory, graphics, graphicsKey: graphicsCacheInput(setting, env, dependencies.files ? { files: dependencies.files } : {}),
      workers, claim, onWorkerStopped }, dependencies);
  } catch (error) {
    // No worker of this export starts any more: every place still claimed goes back.
    claim?.(Infinity);
    throw error;
  }
}
