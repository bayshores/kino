// Song embeddings: what a song sounds like as 512 numbers, and text in the same space.
//
// LAION-CLAP (clap-htsat-unfused, Apache-2.0 weights) through transformers.js
// (@huggingface/transformers, Apache-2.0), its ONNX port Xenova/clap-htsat-unfused. The model
// downloads once into <data>/models (about 600 MB: audio 118 MB, text 502 MB) on first use and
// loads lazily: the audio half when a song is measured, the text half when a lane or a brief is
// scored. Text vectors are cached on disk by prompt, so the fixed lanes need the text model once.
//
// A song is 3 windows of 10 s (at 25, 50 and 75% of what measure decoded), resampled to 48 kHz,
// each embedded and normalized, then averaged and normalized again. It is stored with the song as
// base64 float16 (1 KB) plus the model id.
//
// When the model cannot load (no network on first use, the package missing), every call answers
// null and notice() says so once; ranking falls back to tempo and the measured features.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLAP_MODEL = "Xenova/clap-htsat-unfused";
const RATE = 48_000;
const WINDOW_SECONDS = 10;
const SIZE = 512;

/**
 * Clearly different lanes a song falls in, each a short CLAP text prompt. The label is the chip
 * on the music tab.
 */
export const LANES = Object.freeze([
  { id: "electronic pop", prompt: "bright upbeat electronic pop music with synths" },
  { id: "house", prompt: "energetic house dance music with a four on the floor kick" },
  { id: "guitar", prompt: "indie rock or funk band with electric guitar" },
  { id: "hip-hop", prompt: "hip hop beat with sampled drums" },
  { id: "lo-fi", prompt: "mellow lo-fi chill beat" },
  { id: "cinematic", prompt: "cinematic orchestral strings and piano score" },
  { id: "synthwave", prompt: "retro 80s synthwave" },
  { id: "ambient", prompt: "calm ambient downtempo electronic" },
  { id: "folk", prompt: "acoustic folk guitar and singing" },
  { id: "trap", prompt: "trap beat with 808 bass and hi-hats" },
]);

// ---- vectors -----------------------------------------------------------------------------

/** The vector scaled to length 1 (a zero vector stays zero). */
export function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / length);
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** The mean of vectors (null for none). */
export function meanVector(vectors) {
  if (!vectors.length) return null;
  const sum = new Float32Array(vectors[0].length);
  for (const vector of vectors) for (let i = 0; i < sum.length; i += 1) sum[i] += vector[i];
  return sum.map((value) => value / vectors.length);
}

/** Cosine of a and b after subtracting `center` from both (center null: plain cosine). */
export function centeredCosine(a, b, center = null) {
  const shift = (vector) => (center ? normalize(vector.map((value, i) => value - center[i])) : normalize(vector));
  return dot(shift(a), shift(b));
}

// float16 by hand (Float16Array is not in every Node kino runs on).
function toHalf(value) {
  const f = new Float32Array([value]);
  const bits = new Uint32Array(f.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | (mantissa >>> 13);
}
function fromHalf(half) {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/** A vector as base64 float16. */
export function encodeVector(vector) {
  const halves = Uint16Array.from(vector, toHalf);
  return Buffer.from(halves.buffer).toString("base64");
}

/** base64 float16 back to a Float32Array; null when it is not a vector. */
export function decodeVector(text) {
  if (typeof text !== "string" || !text) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length < 4 || bytes.length % 2) return null;
  const halves = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return Float32Array.from(halves, fromHalf);
}

/** A song's stored embedding ({model, vector}) as numbers, or null (none, or another model's). */
export function songVector(embedding, model = CLAP_MODEL) {
  if (!embedding || embedding.model !== model) return null;
  return decodeVector(embedding.vector);
}

// ---- audio -------------------------------------------------------------------------------

/** Mono samples at `from` Hz resampled to `to` Hz (linear; CLAP wants 48 kHz). */
export function resample(samples, from, to = RATE) {
  if (from === to) return samples;
  const length = Math.floor((samples.length * to) / from);
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i += 1) {
    const at = i * step;
    const left = Math.floor(at);
    const right = Math.min(samples.length - 1, left + 1);
    out[i] = samples[left] + (samples[right] - samples[left]) * (at - left);
  }
  return out;
}

/** The 3 windows (10 s each at 25, 50, 75%; fewer for a short song) at 48 kHz. */
export function songWindows(samples, sampleRate) {
  const size = WINDOW_SECONDS * sampleRate;
  if (samples.length <= size) return [resample(samples, sampleRate)];
  return [0.25, 0.5, 0.75].map((share) => {
    const start = Math.max(0, Math.min(samples.length - size, Math.round(samples.length * share - size / 2)));
    return resample(samples.subarray(start, start + size), sampleRate);
  });
}

// ---- the model ---------------------------------------------------------------------------

/**
 * deps: modelDir (<data>/models), load() (imports @huggingface/transformers; tests pass a stub),
 * download (false: only a model already on disk).
 * audio(samples, sampleRate) → {model, vector} or null; text(prompts) → [Float32Array] or null;
 * notice() → the one line that says embeddings are off (once), else null.
 */
export function createMusicEmbed({ modelDir, load = () => import("@huggingface/transformers"), download = true, model = CLAP_MODEL } = {}) {
  let audioParts = null;
  let textParts = null;
  let failure = null;
  let told = false;
  let library = null;
  const textFile = modelDir ? path.join(modelDir, "clap-text.json") : null;
  let textCache = null;

  async function lib() {
    if (!library) {
      library = await load();
      if (library.env && modelDir) {
        library.env.cacheDir = path.join(modelDir, "hf");
        library.env.allowRemoteModels = download;
      }
    }
    return library;
  }

  // One load at a time per half; a failure is kept, so a missing model is not retried every call.
  function part(kind) {
    if (failure) return Promise.resolve(null);
    if (kind === "audio" && audioParts) return audioParts;
    if (kind === "text" && textParts) return textParts;
    const job = (async () => {
      const t = await lib();
      if (kind === "audio") return { processor: await t.AutoProcessor.from_pretrained(model), net: await t.ClapAudioModelWithProjection.from_pretrained(model, { dtype: "fp32" }) };
      return { tokenizer: await t.AutoTokenizer.from_pretrained(model), net: await t.ClapTextModelWithProjection.from_pretrained(model, { dtype: "fp32" }) };
    })().catch((error) => {
      failure = String(error?.message ?? error).split("\n")[0].slice(0, 120);
      return null;
    });
    if (kind === "audio") audioParts = job; else textParts = job;
    return job;
  }

  async function audio(samples, sampleRate) {
    const parts = await part("audio");
    if (!parts || !samples?.length) return null;
    const sum = new Float32Array(SIZE);
    for (const window of songWindows(samples, sampleRate)) {
      const { audio_embeds: embeds } = await parts.net(await parts.processor(window));
      normalize(embeds.data).forEach((value, i) => { sum[i] += value; });
    }
    return { model, vector: encodeVector(normalize(sum)) };
  }

  async function readTextCache() {
    if (textCache) return textCache;
    try { textCache = JSON.parse(await readFile(textFile, "utf8")); } catch { textCache = {}; }
    if (textCache.model !== model) textCache = { model, prompts: {} };
    return textCache;
  }

  async function text(prompts) {
    const cache = textFile ? await readTextCache() : { model, prompts: {} };
    const missing = [...new Set(prompts.filter((prompt) => !cache.prompts[prompt]))];
    if (missing.length) {
      const parts = await part("text");
      if (!parts) return null;
      const { text_embeds: embeds } = await parts.net(parts.tokenizer(missing, { padding: true, truncation: true }));
      missing.forEach((prompt, k) => { cache.prompts[prompt] = encodeVector(normalize(embeds.data.slice(k * SIZE, (k + 1) * SIZE))); });
      if (textFile) {
        await mkdir(path.dirname(textFile), { recursive: true, mode: 0o700 });
        const temporary = `${textFile}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
        await rename(temporary, textFile);
      }
    }
    return prompts.map((prompt) => decodeVector(cache.prompts[prompt]));
  }

  function notice() {
    if (!failure || told) return null;
    told = true;
    return `song embeddings are off (${failure}): taste uses tempo and 5 sound features, no lanes or brief scores.`;
  }

  return { model, audio, text, notice, failed: () => failure };
}
