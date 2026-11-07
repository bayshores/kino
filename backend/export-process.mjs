import { spawn } from "node:child_process";
import { basename } from "node:path";
import { ffmpegArgs, lowerIfBackground } from "./render-activity.mjs";

function canceled() {
  const error = new Error("Export was cancelled.");
  error.name = "AbortError";
  return error;
}

/** Wait for encoder exit before deleting its working files. Give an encoder one second to
 * stop cleanly, then reap it even if it ignores SIGTERM, as media-probe already does. */
export function runExportProcess(command, args, signal, cwd) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(canceled()); return; }
    const child = spawn(command, basename(command).startsWith("ffmpeg") ? ffmpegArgs(args) : args, { stdio: ["ignore", "pipe", "pipe"], shell: false, cwd });
    lowerIfBackground(child);
    let stderr = "", stdout = "", killTimer;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const clean = () => { clearTimeout(killTimer); signal?.removeEventListener("abort", stop); };
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => { clean(); reject(error); });
    child.once("close", (code, terminatingSignal) => {
      clean();
      if (signal?.aborted) reject(canceled());
      else if (code === 0) resolve(stdout);
      else reject(new Error(`${basename(command)} failed with exit code ${code ?? terminatingSignal}: ${stderr.trim() || "no diagnostic output"}`));
    });
  });
}

/** Feed a bounded async sequence into an encoder. A write must drain before the next
 * frame is requested. An encoder failure cancels the producer and is reaped before return. */
export async function runExportStream(command, args, { input, signal, cwd } = {}) {
  if (typeof input !== "function") throw new TypeError("An encoder input producer is required.");
  if (signal?.aborted) throw canceled();
  const controller = new AbortController();
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, cwd });
  lowerIfBackground(child);
  let stderr = "", stdout = "", spawnError, inputError, killTimer, stopping = false, inputComplete = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    child.stdin.destroy();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  // A closed pipe is handled by the awaited write; it must never become an unhandled event.
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-1_000_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
  const closed = new Promise(resolve => {
    child.once("error", error => { spawnError = error; });
    child.once("close", (code, terminatingSignal) => {
      controller.abort();
      child.stdin.destroy();
      resolve({ code, terminatingSignal });
    });
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const pumping = (async () => {
    try {
      for await (const bytes of input(controller.signal)) {
        if (controller.signal.aborted) throw canceled();
        if (!(bytes instanceof Uint8Array)) throw new TypeError("Encoder input must contain byte buffers.");
        await new Promise((resolve, reject) => child.stdin.write(bytes, error => {
          if (error) { stop(); reject(error); } else resolve();
        }));
      }
      inputComplete = true;
      child.stdin.end();
    } catch (error) { inputError = error; stop(); }
  })();
  try {
    const { code, terminatingSignal } = await closed;
    await pumping;
    if (signal?.aborted) throw canceled();
    if (spawnError) throw spawnError;
    if (inputError && inputError.code !== "EPIPE" && inputError.name !== "AbortError") throw inputError;
    if (code !== 0) throw new Error(`${basename(command)} failed with exit code ${code ?? terminatingSignal}: ${stderr.trim() || inputError?.message || "no diagnostic output"}`);
    if (inputError) throw inputError;
    if (!inputComplete) throw new Error("The encoder closed before all frames were written.");
    return stdout;
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}
