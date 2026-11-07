// The sound curves sync_clips compares (engine/clipSync.js), made once per file with FFmpeg and kept
// in a .sync file beside it, so syncing several clips to one long recording decodes it once.
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { SYNC_RATE, SYNC_SAMPLE_RATE, SYNC_VERSION, syncEnvelopes } from "../engine/clipSync.js";
import { decodeMono } from "./audio-analysis.mjs";

// Each value is kept as one byte, a whole number from -127 to 127 in steps of 1 / STEPS.
const STEPS = 8;

/** Envelopes as a small JSON value: {version, rate, bands, frames, data (base64, one byte each)}. */
export function envelopesToJson(envelopes) {
  const frames = envelopes[0]?.length ?? 0;
  const bytes = new Int8Array(envelopes.length * frames);
  envelopes.forEach((envelope, band) => {
    for (let i = 0; i < frames; i += 1) bytes[band * frames + i] = Math.max(-127, Math.min(127, Math.round(envelope[i] * STEPS)));
  });
  return { version: SYNC_VERSION, rate: SYNC_RATE, bands: envelopes.length, frames, data: Buffer.from(bytes.buffer).toString("base64") };
}

/** The envelopes back from envelopesToJson's value, or null when it is from another version. */
export function envelopesFromJson(saved) {
  if (saved?.version !== SYNC_VERSION || saved.rate !== SYNC_RATE || typeof saved.data !== "string") return null;
  const raw = Buffer.from(saved.data, "base64");
  if (!(saved.bands > 0) || raw.length !== saved.bands * saved.frames) return null;
  const bytes = new Int8Array(raw.buffer, raw.byteOffset, raw.length);
  return Array.from({ length: saved.bands }, (_, band) =>
    Float32Array.from(bytes.subarray(band * saved.frames, (band + 1) * saved.frames), (value) => value / STEPS));
}

/** Decodes one file and makes its envelopes (no cache). Rejects "The file has no sound." without sound. */
export async function fileEnvelopes(filename, options = {}) {
  const { samples } = await decodeMono(filename, { ...options, sampleRate: SYNC_SAMPLE_RATE });
  if (samples.length < SYNC_SAMPLE_RATE) throw new Error("The file has no sound.");
  return syncEnvelopes(samples);
}

/** Makes each file's envelopes once and keeps them in a .sync file beside it. */
export function createSyncEnvelopeCache({ make = fileEnvelopes } = {}) {
  const pending = new Map();
  async function readOrMake(filename) {
    const sidecar = `${filename}.sync`;
    try {
      const saved = envelopesFromJson(JSON.parse(await readFile(sidecar, "utf8")));
      if (saved) return saved;
    } catch { /* Missing or old curves are made again. */ }
    // Kept as bytes, and used as kept, so the first answer and later ones are the same.
    const saved = envelopesToJson(await make(filename));
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
      await rename(temporary, sidecar);
    } catch { /* The curves still count when the folder cannot be written. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
    return envelopesFromJson(saved);
  }
  function get(filename) {
    if (!pending.has(filename)) pending.set(filename, readOrMake(filename).finally(() => pending.delete(filename)));
    return pending.get(filename);
  }
  return { get };
}
