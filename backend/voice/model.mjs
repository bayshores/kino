// The DPDFNet voice model: a 10.6 MB file kino downloads once, on first use, into the data folder
// (<MOTION_DATA_DIR>/models). The download is checked against a pinned SHA-256 and only renamed
// into place when it matches, so a cut-off or changed download is never used.
// Model: DPDFNet2 48 kHz HR by Ceva, Apache-2.0, converted to ONNX by the sherpa-onnx project
// (k2-fsa, Apache-2.0). See assets/voice/README.md.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DPDFNET_MODEL = Object.freeze({
  name: "DPDFNet2 48 kHz HR",
  file: "dpdfnet2_48khz_hr.onnx",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet2_48khz_hr.onnx",
  bytes: 10596848,
  sha256: "0b399f8a58dc4d70d8cd97541f5c39869406145193b957d00a03b66070944928",
});

// GitHub release downloads redirect to its asset storage.
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

function abortError(signal) {
  const error = new Error("Voice isolation was cancelled.", { cause: signal?.reason });
  error.name = "AbortError";
  return error;
}

/** The SHA-256 of a file's bytes, as hex. Cancelling `signal` stops reading. */
export async function sha256File(path, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === DPDFNET_MODEL.bytes && await sha256File(path) === DPDFNET_MODEL.sha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Where the model is or will be. KINO_VOICE_MODEL names a model file directly (tests and CI use
 * it to share one copy); otherwise it is <modelDir>/dpdfnet2_48khz_hr.onnx.
 */
export function voiceModelPath(modelDir) {
  return process.env.KINO_VOICE_MODEL || join(modelDir, DPDFNET_MODEL.file);
}

/** True when the model is already on this computer and matches its pinned hash. */
export function voiceModelReady(modelDir) {
  return verified(voiceModelPath(modelDir));
}

function offlineError(reason) {
  return Object.assign(new Error(
    `Voice isolation with DPDFNet needs a one-time 10.6 MB model download from github.com, and ${reason}. ` +
    "Connect to the internet and try again, or use engine \"rnnoise\", which works offline" +
    (process.platform === "darwin" ? " (or \"apple\" on macOS 13 and later)." : "."),
  ), { code: "VOICE_MODEL_UNAVAILABLE" });
}

/**
 * Returns the model's path, downloading it first when needed and `download` allows it.
 * onProgress receives the downloaded fraction (0 to 1).
 */
export async function ensureVoiceModel({ modelDir, download = true, signal, onProgress } = {}) {
  const path = voiceModelPath(modelDir);
  if (await verified(path)) return path;
  if (process.env.KINO_VOICE_MODEL)
    throw offlineError(`KINO_VOICE_MODEL (${path}) is missing or does not match the pinned SHA-256`);
  if (!download) throw offlineError("the model is not downloaded yet and downloads are turned off");
  if (signal?.aborted) throw abortError(signal);
  await mkdir(modelDir, { recursive: true });
  const partial = join(modelDir, `.${DPDFNET_MODEL.file}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
  let response;
  try {
    response = await fetch(DPDFNET_MODEL.url, { redirect: "follow", signal });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw offlineError(`kino could not reach it (${error?.cause?.code ?? error?.message ?? "network error"})`);
  }
  try {
    const host = response.url ? new URL(response.url).hostname : "";
    if (!response.ok || !response.body) throw offlineError(`the download failed (HTTP ${response.status})`);
    if (!DOWNLOAD_HOSTS.has(host)) throw offlineError(`the download was redirected to an unexpected host (${host})`);
    const hash = createHash("sha256");
    let received = 0, reported = -1;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > DPDFNET_MODEL.bytes) return callback(offlineError("the download was larger than the pinned model"));
        hash.update(chunk);
        // Progress is reported once per whole percent.
        const percent = Math.floor((100 * received) / DPDFNET_MODEL.bytes);
        if (percent !== reported) {
          reported = percent;
          onProgress?.(percent / 100);
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: "wx", mode: 0o644 }), { signal });
    const digest = hash.digest("hex");
    if (received !== DPDFNET_MODEL.bytes || digest !== DPDFNET_MODEL.sha256)
      throw offlineError(`the download did not match the pinned SHA-256 (received ${received} bytes, ${digest})`);
    await rename(partial, path);
    return path;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    if (signal?.aborted) throw abortError(signal);
    if (error?.code === "VOICE_MODEL_UNAVAILABLE") throw error;
    throw offlineError(`the download stopped (${error?.cause?.code ?? error?.message ?? "network error"})`);
  }
}
