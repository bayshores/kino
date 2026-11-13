// Draws the frames of a script layer: the agent's drawing module runs in its own Electron process
// (desktop/script-worker.cjs), in a sandboxed frame with no network (engine/scriptRuntime.js), and
// each frame comes back as a PNG. One process stays open between calls, and a module stays mounted
// while its script, size, pixel ratio and images are the same, because an export asks for
// hundreds of frames.
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_LIMITS, tooLongMessage } from "../engine/scriptRuntime.js";
import { resolveExecutable } from "./chromium-raster.mjs";
import { lowerIfBackground } from "./render-activity.mjs";

const workerEntry = fileURLToPath(new URL("../desktop/script-worker.cjs", import.meta.url));
const STARTUP_MS = 15_000;
// The worker times each mount and draw itself and answers "took too long". This process waits
// longer than that (the PNG may take a while after a big draw) before it stops the worker.
const BACKSTOP_MS = { setup: SCRIPT_LIMITS.setupMs + 15_000, draw: SCRIPT_LIMITS.drawMs + 25_000 };
const MAX_SCRIPT_LENGTH = 65_536;
const MAX_SIDE = 16384;
const MAX_PIXELS = 64_000_000;
const MAX_FRAMES = 100_000;
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function abortError(signal) {
  const error = new Error("Script frames were cancelled.");
  error.name = "AbortError";
  error.cause = signal?.reason;
  return error;
}

// The checks on what render() is given; a mistake here is the caller's, so it throws.
function validate({ script, width, height, pixelRatio, frames, images }) {
  if (typeof script !== "string" || !script.trim() || script.length > MAX_SCRIPT_LENGTH) throw new TypeError(`The script must be text of at most ${MAX_SCRIPT_LENGTH} characters.`);
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 8) throw new RangeError("The pixel ratio must be a number above 0 and at most 8.");
  if (![width, height].every((side) => Number.isFinite(side) && side > 0)) throw new RangeError("The width and height must be numbers above 0.");
  const pixelWidth = Math.max(1, Math.round(width * pixelRatio)), pixelHeight = Math.max(1, Math.round(height * pixelRatio));
  if (pixelWidth > MAX_SIDE || pixelHeight > MAX_SIDE || pixelWidth * pixelHeight > MAX_PIXELS) throw new RangeError("A script frame may have at most 16384 pixels a side and 64 million pixels.");
  if (!Array.isArray(frames) || frames.length > MAX_FRAMES) throw new TypeError(`frames must be an array of at most ${MAX_FRAMES} frames.`);
  for (const frame of frames) {
    if (!frame || typeof frame !== "object" || !Number.isFinite(frame.time)) throw new TypeError("Each frame needs a time in seconds.");
  }
  let bytes = 0;
  for (const [key, value] of Object.entries(images ?? {})) {
    if (value != null && !(value instanceof Uint8Array)) throw new TypeError(`The image input "${key}" must be the bytes of a picture (a Buffer) or null.`);
    bytes += value?.length ?? 0;
  }
  if (bytes > MAX_IMAGE_BYTES) throw new RangeError("The image inputs may have at most 48 MB together.");
  return { pixelWidth, pixelHeight };
}

// A PNG whose header says the size the frame should have. The page's answer passes through a
// frame the script could write to, so its bytes are checked before anyone reads them.
function checkedPng(base64, width, height) {
  const png = Buffer.from(String(base64 ?? ""), "base64");
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") return null;
  return png.readUInt32BE(16) === width && png.readUInt32BE(20) === height ? png : null;
}

function errorOf(reply, time) {
  const error = {
    message: String(reply?.message ?? "The script failed.").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500),
    phase: ["load", "setup", "draw"].includes(reply?.phase) ? reply.phase : "draw",
    time,
  };
  if (Number.isSafeInteger(reply?.line)) error.line = reply.line;
  if (Number.isSafeInteger(reply?.column)) error.column = reply.column;
  return error;
}

/**
 * Starts nothing until the first render. `options.directory`: where the worker's private profile
 * folder goes (the system's temporary folder by default). `options.electronExecutable` and
 * `options.env` (KINO_ELECTRON_EXECUTABLE, KINO_ELECTRON_PACKAGED) choose the Electron to run, as
 * for the raster workers.
 */
export function createScriptRenderer(options = {}) {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? nodeSpawn;
  let worker = null;
  let mountedKey = null;
  let queue = Promise.resolve();
  let closed = false;
  let nextId = 1;

  async function startWorker() {
    const folder = await mkdtemp(path.join(options.directory ?? tmpdir(), "kino-script-"));
    const launchEnv = { ...env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    const executable = resolveExecutable(launchEnv, { electronExecutable: options.electronExecutable });
    const packaged = launchEnv.KINO_ELECTRON_PACKAGED === "1";
    const args = [
      "--kino-script-worker",
      `--kino-script-directory=${folder}`,
      `--user-data-dir=${path.join(folder, "profile")}`,
      `--disk-cache-dir=${path.join(folder, "profile", "cache")}`,
      `--crash-dumps-dir=${path.join(folder, "crashes")}`,
    ];
    if (!packaged) args.unshift(workerEntry);
    const child = spawn(executable, args, { env: launchEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    lowerIfBackground(child);
    const state = { child, folder, pending: new Map(), stderr: "", stopped: null, exited: null };
    state.exited = new Promise((resolve) => child.once("close", resolve));
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const stop = (reason) => {
      if (state.stopped) return;
      state.stopped = reason;
      if (worker === state) { worker = null; mountedKey = null; }
      rejectReady(reason);
      for (const entry of state.pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
      state.pending.clear();
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      void state.exited.then(() => rm(folder, { recursive: true, force: true })).catch(() => {});
    };
    state.stop = stop;
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; } // Chromium's own log lines
        if (message?.type === "ready") { resolveReady(); continue; }
        const entry = state.pending.get(message?.id);
        if (!entry) continue;
        state.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { state.stderr = (state.stderr + chunk).slice(-2000); });
    child.on("error", (error) => stop(new Error(error?.code === "ENOENT" ? "The Electron runtime for script layers was not found. Run npm ci or use the kino Mac app." : `The script worker could not start: ${error?.message}`)));
    child.on("exit", (code, signal) => stop(new Error(`The script worker stopped (${signal ?? `exit code ${code}`}). ${state.stderr.replace(/\s+/g, " ").trim().slice(-300)}`.trim())));
    child.stdin.on("error", () => stop(new Error("The script worker stopped taking requests.")));
    // An idle worker never keeps this process running; a request in hand keeps its timer.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
    const startTimer = setTimeout(() => stop(new Error("The script worker did not start within 15 seconds.")), STARTUP_MS);
    try {
      await ready;
    } finally {
      clearTimeout(startTimer);
    }
    return state;
  }

  // One request to the worker. Past the backstop the worker is stopped and the request answers
  // that the script took too long (the next request starts a new worker).
  function call(state, request, backstopMs, time) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        state.pending.delete(id);
        state.stop(new Error("The script worker did not answer in time."));
        resolve({ ok: false, message: tooLongMessage(time), phase: request.type === "mount" ? "setup" : "draw", reset: true });
      }, backstopMs);
      state.pending.set(id, { resolve, reject, timer });
      state.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  async function ensureWorker() {
    if (worker && !worker.stopped) return worker;
    worker = await startWorker();
    mountedKey = null;
    return worker;
  }

  async function renderNow({ script, width, height, pixelRatio, frames, images, signal, name }, { pixelWidth, pixelHeight }) {
    const imageEntries = Object.entries(images ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    const hash = createHash("sha256").update(JSON.stringify([script, width, height, pixelRatio, name ?? ""]));
    for (const [key, bytes] of imageEntries) hash.update(`\n${key}:${bytes?.length ?? -1}:`).update(bytes ?? Buffer.alloc(0));
    const key = hash.digest("hex");
    const results = [];
    for (let index = 0; index < frames.length; index += 1) {
      if (signal?.aborted) throw abortError(signal);
      const frame = frames[index];
      const time = frame.time;
      let reply;
      try {
        const state = await ensureWorker();
        if (mountedKey !== key) {
          mountedKey = null;
          const encoded = Object.fromEntries(imageEntries.map(([name, bytes]) => [name, bytes ? Buffer.from(bytes).toString("base64") : null]));
          const mounted = await call(state, { type: "mount", script, width, height, pixelRatio, name: name ?? "", images: encoded, time }, BACKSTOP_MS.setup, time);
          if (!mounted.ok) {
            // Loading or setup failed: no frame of this call can be drawn.
            const error = errorOf({ ...mounted, phase: mounted.phase === "load" ? "load" : "setup" }, time);
            while (results.length < frames.length) results.push({ error });
            return results;
          }
          mountedKey = key;
        }
        reply = await call(state, { type: "draw", frame: { ...frame, pixelRatio } }, BACKSTOP_MS.draw, time);
      } catch (error) {
        reply = { ok: false, message: error?.message ?? String(error), phase: "draw", reset: true };
      }
      if (reply.reset) mountedKey = null;
      if (reply.ok) {
        const png = checkedPng(reply.png, pixelWidth, pixelHeight);
        results.push(png ? { png, empty: reply.empty === true } : { error: { message: "The script's frame came back damaged.", phase: "draw", time } });
        continue;
      }
      const error = errorOf(reply, time);
      results.push({ error });
      if (error.message === tooLongMessage(time)) {
        // A script that ran out of time once would likely do so again: the frames after it are
        // not drawn, so one call never takes minutes.
        for (let rest = index + 1; rest < frames.length; rest += 1) {
          results.push({ error: { message: `not drawn: the script took too long at ${time.toFixed(2)} s`, phase: "draw", time: frames[rest].time } });
        }
        return results;
      }
    }
    return results;
  }

  return {
    /**
     * Draws `frames` (each {time, duration, progress, values, width, height}) with the module in
     * `script` on a canvas of `width` by `height` layer pixels at `pixelRatio`. `images` maps an
     * image input's key to the bytes of a picture. Resolves to one entry per frame, in order:
     * {png, empty} or {error: {message, phase, time, line?, column?}}.
     */
    render(request = {}) {
      const given = { pixelRatio: 1, images: {}, ...request };
      if (closed) return Promise.reject(new Error("The script renderer is closed."));
      let sizes;
      try { sizes = validate(given); } catch (error) { return Promise.reject(error); }
      if (given.signal?.aborted) return Promise.reject(abortError(given.signal));
      const run = queue.then(() => renderNow(given, sizes));
      queue = run.catch(() => {});
      return run;
    },
    /** What the worker's session saw since the last call: {allowed:[url], cancelled:[url]}. */
    async networkLog() {
      await queue;
      if (!worker || worker.stopped) return { allowed: [], cancelled: [] };
      const reply = await call(worker, { type: "requests" }, 5000, 0);
      return { allowed: reply.allowed ?? [], cancelled: reply.cancelled ?? [] };
    },
    /** Stops the worker and deletes its profile folder. */
    async close() {
      closed = true;
      await queue;
      const state = worker;
      worker = null;
      if (!state) return;
      try { state.child.stdin.end(); } catch { /* already closed */ }
      const quit = setTimeout(() => state.stop(new Error("closed")), 3000);
      await state.exited;
      clearTimeout(quit);
      state.stop(new Error("closed"));
      await rm(state.folder, { recursive: true, force: true }).catch(() => {});
    },
  };
}
