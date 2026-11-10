// Reference looks: what a reference video looks like as numbers, and text in the same space.
//
// SigLIP (google/siglip-base-patch16-224, Apache-2.0 weights) through transformers.js
// (@huggingface/transformers, Apache-2.0), its ONNX port Xenova/siglip-base-patch16-224, 8-bit
// (vision 100 MB, text 112 MB). transformers.js 4.3 runs SigLIP, not SigLIP 2. The model
// downloads once into <data>/models on first use and loads lazily: the image half when a
// thumbnail or keyframe is embedded, the text half when a search is ranked.
//
// A measured reference keeps one vector a shot (a keyframe: the still nearest the middle of the
// shot, at most KEYFRAMES), a search result one for its thumbnail. Vectors are stored as base64
// float16 (music-embed.mjs helpers) with the model id.
//
// The pure half ranks search results: near-identical ones collapse into one (more views wins),
// the query's text vector and the person's taste (saved references liked, unsaved ones rejected)
// order the rest, and MMR keeps the list varied until there is taste.
import { existsSync } from "node:fs";
import path from "node:path";
import { centeredCosine, decodeVector, dot, encodeVector, meanVector, normalize } from "./music-embed.mjs";

export const LOOK_MODEL = "Xenova/siglip-base-patch16-224";
export const KEYFRAMES = 12;
const SIZE = 768;
/** Two references whose looks are at least this alike are the same edit (a re-upload, a recut). */
export const SAME_LOOK = 0.93;
/** A reference whose keyframes are this alike on average shows almost one picture throughout. */
export const SAME_FRAMES = 0.9;

// ---- keyframes -------------------------------------------------------------------------

/** The middle of each shot (cuts in seconds), at most `most`, evenly picked when there are more. */
export function shotMiddles(cuts = [], seconds, most = KEYFRAMES) {
  const edges = [0, ...cuts.filter((cut) => cut > 0 && cut < seconds), seconds];
  const middles = edges.slice(1).map((end, index) => (edges[index] + end) / 2);
  if (middles.length <= most) return middles;
  return Array.from({ length: most }, (_, k) => middles[Math.round((k * (middles.length - 1)) / (most - 1))]);
}

/** The still files ({at, file}) nearest each time, each once. */
export function keyframeStills(stills = [], times = []) {
  if (!stills.length) return [];
  const picked = times.map((t) => stills.reduce((best, still) => (Math.abs(still.at - t) < Math.abs(best.at - t) ? still : best)));
  return [...new Set(picked)];
}

// ---- vectors ---------------------------------------------------------------------------

/** A record's look as one vector: its keyframes' mean, else its thumbnail's; null for none. */
export function lookVector(record, model = LOOK_MODEL) {
  const frames = record?.look?.model === model ? (record.look.vectors ?? []).map(decodeVector).filter(Boolean) : [];
  if (frames.length) return normalize(meanVector(frames));
  if (record?.thumbLook?.model === model) return decodeVector(record.thumbLook.vector);
  return null;
}

/** True when a measured reference's keyframes are nearly one picture (4 or more shots). */
export function sameFrames(look) {
  const vectors = (look?.vectors ?? []).map(decodeVector).filter(Boolean);
  if (vectors.length < 4) return false;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i += 1) for (let j = i + 1; j < vectors.length; j += 1) { sum += dot(vectors[i], vectors[j]); pairs += 1; }
  return sum / pairs >= SAME_FRAMES;
}

const plainTitle = (title) => String(title ?? "").toLowerCase().replace(/#[^\s#]+/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** True when two results are the same edit: alike looks, or the same title and length. */
export function sameEdit(a, b, vectorA, vectorB) {
  if (vectorA && vectorB && dot(vectorA, vectorB) >= SAME_LOOK) return true;
  const title = plainTitle(a.title);
  return title.length >= 8 && title === plainTitle(b.title) && Math.abs((a.duration ?? 0) - (b.duration ?? 0)) <= 2;
}

// More views wins; then a verified channel; then the earlier place.
const keeps = (a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.verified ? 1 : 0) - (a.verified ? 1 : 0);

/**
 * Results in their best order with copies collapsed: {results, collapsed: [{id, into}]}.
 * query: the search's text vector; liked and rejected: vectors of saved and unsaved references.
 * Relevance: the result's earlier place (kino's views-and-slop order), how well its look matches
 * the words, and with taste, closeness to the liked minus half the closeness to the rejected.
 * Doubtful results stay behind clean ones. MMR picks each next result as the most relevant least
 * like those already picked: wide (0.6) until 2 references are liked, then 0.85.
 */
export function rankLooks(results, { query = null, liked = [], rejected = [], model = LOOK_MODEL } = {}) {
  const vectors = new Map(results.map((result) => [result.id, lookVector(result, model)]));
  // Copies: the keeper is the one with more views (else verified, else the earlier place).
  const order = results.map((result, place) => ({ result, place }));
  const into = new Map();
  for (const item of [...order].sort((x, y) => keeps(x.result, y.result) || x.place - y.place)) {
    if (into.has(item.result.id)) continue;
    for (const other of order) {
      if (other === item || into.has(other.result.id) || keeps(item.result, other.result) > 0) continue;
      if (sameEdit(item.result, other.result, vectors.get(item.result.id), vectors.get(other.result.id))) into.set(other.result.id, item.result.id);
    }
  }
  const kept = order.filter((item) => !into.has(item.result.id));
  const known = kept.map((item) => vectors.get(item.result.id)).filter(Boolean);
  const center = known.length >= 3 ? meanVector(known) : null;
  const likedCenter = liked.length ? normalize(meanVector(liked)) : null;
  const rejectedCenter = rejected.length ? normalize(meanVector(rejected)) : null;
  const zs = (values) => {
    const real = values.filter((value) => value !== null);
    const mean = real.reduce((sum, value) => sum + value, 0) / (real.length || 1);
    const spread = Math.sqrt(real.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (real.length || 1)) || 1;
    return values.map((value) => (value === null ? 0 : (value - mean) / spread));
  };
  const words = zs(kept.map((item) => (query && vectors.get(item.result.id) ? dot(query, vectors.get(item.result.id)) : null)));
  const taste = zs(kept.map((item) => {
    const vector = vectors.get(item.result.id);
    if (!vector || !likedCenter) return null;
    return centeredCosine(vector, likedCenter, center) - (rejectedCenter ? 0.5 * centeredCosine(vector, rejectedCenter, center) : 0);
  }));
  const group = (result) => (/\bai\b/.test(result.doubt ?? "") ? 2 : result.doubt ? 1 : 0);
  const rows = kept.map((item, k) => ({ ...item, group: group(item.result), score: -0.25 * k + 0.6 * words[k] + (likedCenter ? 1 * taste[k] : 0) }));
  const lambda = liked.length >= 2 ? 0.85 : 0.6;
  const picked = [];
  for (const level of [0, 1, 2]) {
    const open = rows.filter((row) => row.group === level);
    while (open.length) {
      let best = 0;
      let bestScore = -Infinity;
      open.forEach((row, index) => {
        const vector = vectors.get(row.result.id);
        const alike = picked.reduce((most, other) => {
          const near = vector && vectors.get(other.result.id) ? centeredCosine(vector, vectors.get(other.result.id), center) : 0;
          return Math.max(most, near);
        }, 0);
        const score = lambda * row.score - (1 - lambda) * 3 * alike;
        if (score > bestScore) { bestScore = score; best = index; }
      });
      picked.push(...open.splice(best, 1));
    }
  }
  return { results: picked.map((row) => row.result), collapsed: [...into].map(([id, keeper]) => ({ id, into: keeper })) };
}

// ---- the model ---------------------------------------------------------------------------

/**
 * deps: modelDir (<data>/models), load() (imports @huggingface/transformers; tests pass a stub),
 * download (false: only a model already on disk).
 * images(files) → {model, vectors: [base64]} or null; text(prompts) → [Float32Array] or null;
 * notice() → the one line that says looks are off (once), else null.
 */
export function createLookEmbed({ modelDir, load = () => import("@huggingface/transformers"), download = true, model = LOOK_MODEL } = {}) {
  let imageParts = null;
  let textParts = null;
  let failure = null;
  let told = false;
  let library = null;

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
    if (kind === "image" && imageParts) return imageParts;
    if (kind === "text" && textParts) return textParts;
    const job = (async () => {
      const t = await lib();
      if (kind === "image") return { t, processor: await t.AutoProcessor.from_pretrained(model), net: await t.SiglipVisionModel.from_pretrained(model, { dtype: "q8" }) };
      return { tokenizer: await t.AutoTokenizer.from_pretrained(model), net: await t.SiglipTextModel.from_pretrained(model, { dtype: "q8" }) };
    })().catch((error) => {
      failure = String(error?.message ?? error).split("\n")[0].slice(0, 120);
      return null;
    });
    if (kind === "image") imageParts = job; else textParts = job;
    return job;
  }

  async function images(files) {
    if (!files?.length) return null;
    const parts = await part("image");
    if (!parts) return null;
    const vectors = [];
    // A few at a time keeps memory small.
    for (let start = 0; start < files.length; start += 4) {
      const pictures = await Promise.all(files.slice(start, start + 4).map((file) => parts.t.RawImage.read(file)));
      const { pooler_output: pooled } = await parts.net(await parts.processor(pictures));
      pictures.forEach((_, k) => vectors.push(encodeVector(normalize(pooled.data.slice(k * SIZE, (k + 1) * SIZE)))));
    }
    return { model, vectors };
  }

  async function text(prompts) {
    const parts = await part("text");
    if (!parts || !prompts.length) return null;
    // SigLIP was trained on lowercase text padded to 64 tokens.
    const { pooler_output: pooled } = await parts.net(parts.tokenizer(prompts.map((prompt) => String(prompt).toLowerCase()), { padding: "max_length", truncation: true, max_length: 64 }));
    return prompts.map((_, k) => normalize(pooled.data.slice(k * SIZE, (k + 1) * SIZE)));
  }

  function notice() {
    if (!failure || told) return null;
    told = true;
    return `reference looks are off (${failure}): results keep kino's views-and-slop order.`;
  }

  return { model, images, text, notice, failed: () => failure, ready: () => lookModelReady(modelDir, model) };
}

/** True when the model is already on disk: transformers.js keeps it in <modelDir>/hf/<model id>. */
export function lookModelReady(modelDir, model = LOOK_MODEL) {
  return Boolean(modelDir) && existsSync(path.join(modelDir, "hf", model));
}
