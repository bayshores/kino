// kino's built-in sound library (assets/sound-library.json): CC0 sound effects (Kenney and
// OpenGameArt packs) and mood-tagged music (Kevin MacLeod, CC BY 4.0). The catalog is in git; the
// audio is not. Each source downloads on first use into <data>/sound-library, must match the
// catalog's SHA-256, and is kept for next time. Works with sound search off: nothing about the
// project is sent, only the download of a fixed file.
//
// - searchSounds(words): effects whose description words match, best first.
// - listMusic({mood, energy, bpm, search, seed}): tracks that fit, in an order that differs per
//   project (seed), so two videos do not open on the same song.
// - importItem("sfx:<id>" | "music:<id>"): adds the file to the media library with its credit.
import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";

const run = promisify(execFile);

export const CATALOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "sound-library.json");
const ID = /^(sfx|music):([a-z0-9-]{1,60})$/;
const TYPES = { ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg" };
export const MOODS = ["uplifting", "bright", "playful", "calm", "warm", "groovy", "driving", "tense", "dark", "mysterious", "epic", "sad", "ambient"];
export const ENERGIES = ["low", "medium", "high"];

export class SoundLibraryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isLibraryId = (value) => ID.test(String(value ?? "").trim());
const words = (text) => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// A word matches its plural and simple stems ("whooshes" finds whoosh).
const stem = (word) => word.replace(/(es|s|ing|ed)$/, "") || word;
const hash = (text) => createHash("sha256").update(text).digest().readUInt32BE(0);

/** The parts of a music request: moods, energies and a bpm range from fields or free words. */
export function musicQuery({ mood, energy, bpm, search } = {}) {
  const free = words([mood, energy, search].flat().join(" "));
  const moods = free.filter((word) => MOODS.includes(word));
  const energies = free.filter((word) => ENERGIES.includes(word));
  const numbers = [bpm, search].flat().join(" ").match(/\d{2,3}/g)?.map(Number) ?? [];
  const range = numbers.length >= 2 ? [Math.min(numbers[0], numbers[1]), Math.max(numbers[0], numbers[1])] : numbers.length ? [numbers[0] - 10, numbers[0] + 10] : null;
  const rest = free.filter((word) => !moods.includes(word) && !energies.includes(word) && !/^\d+$/.test(word) && word !== "bpm");
  return { moods, energies, range, rest };
}

// curl writes the file to a temp folder; the bytes come back (only with the real fetch: tests stub
// both).
export async function curlBytes(url) {
  const folder = await makeTempFolder("kino-sound-");
  try {
    const file = path.join(folder, "download");
    await run("curl", ["-fsSL", "--max-time", "120", "-o", file, url]);
    return await readFile(file);
  } finally {
    await removeTempFolder(folder);
  }
}

/** deps: directory (the download folder), addMedia(file, {name, mime, extra}), fetch, catalog, curl(url) → bytes, retryWaits (ms). */
export function createSoundLibrary({ directory, addMedia, fetch = globalThis.fetch, catalog = null, curl = fetch === globalThis.fetch ? curlBytes : null, retryWaits = [1000, 3000] } = {}) {
  let data = catalog;
  const read = () => (data ??= JSON.parse(readFileSync(CATALOG_FILE, "utf8")));

  function searchSounds(text, { maxSeconds = 10 } = {}) {
    const asked = words(text).map(stem);
    if (!asked.length) throw new SoundLibraryError("bad_input", 'sounds needs search: what the sound is ("whoosh", "click", "impact", "pop").');
    const scored = read().sounds
      .filter((sound) => sound.seconds <= maxSeconds)
      .map((sound) => {
        const own = words(`${sound.id} ${sound.words}`).map(stem);
        return { sound, score: asked.filter((word) => own.includes(word)).length };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.sound.seconds - b.sound.seconds);
    return { query: asked.join(" "), results: scored.map((entry) => entry.sound), total: read().sounds.length };
  }

  function listMusic(request = {}, { seed = "" } = {}) {
    const { moods, energies, range, rest } = musicQuery(request);
    const fits = read().music.filter((track) =>
      (!moods.length || moods.some((mood) => track.moods.includes(mood)))
      && (!energies.length || energies.includes(track.energy))
      && (!range || (track.bpm && track.bpm >= range[0] && track.bpm <= range[1]))
      && (!rest.length || rest.some((word) => words(`${track.title} ${track.genre} ${track.instruments}`).includes(word))));
    // Most matched moods first; ties in an order of this project's own, never the catalog's.
    const matched = (track) => moods.filter((mood) => track.moods.includes(mood)).length;
    fits.sort((a, b) => matched(b) - matched(a) || hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));
    return { moods, energies, range, results: fits, total: read().music.length };
  }

  // A network error (not an HTTP answer) is tried 3 times, 1 s then 3 s apart, then once with
  // curl: two first passes lost every song to an instant "fetch failed" that a plain download did
  // not repeat. The error names the cause code so the next failure says why.
  async function downloadBytes(url, name) {
    let failure;
    for (const wait of [0, ...retryWaits]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      let response;
      try { response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) }); }
      catch (error) { failure = [error.message, error.cause?.code ?? error.cause?.message].filter(Boolean).join(": "); continue; }
      if (!response.ok) throw new SoundLibraryError("failed", `The sound library's source answered ${response.status} for ${name}.`);
      return Buffer.from(await response.arrayBuffer());
    }
    if (curl) try { return await curl(url); } catch (error) { failure += `; curl: ${String(error.message).split("\n")[0]}`; }
    throw new SoundLibraryError("failed", `The sound library could not download ${name} (${failure}); try again later or import a sound file.`);
  }

  // The source file, downloaded once and checked against the catalog.
  async function sourceFile(key, { url, sha256, name }) {
    const file = path.join(directory, `${key}${path.extname(name)}`);
    if (existsSync(file)) return file;
    const bytes = await downloadBytes(url, name);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new SoundLibraryError("refused", `${name} changed at its source (its SHA-256 no longer matches kino's catalog), so kino does not use it.`);
    await mkdir(directory, { recursive: true });
    await writeFile(`${file}.part`, bytes, { mode: 0o600 });
    await rename(`${file}.part`, file);
    return file;
  }

  async function importItem(value) {
    const match = String(value ?? "").trim().match(ID);
    if (!match) throw new SoundLibraryError("bad_input", "A library sound is sfx:<id> (library sounds) or music:<id> (library music).");
    const [, kind, id] = match;
    const catalogData = read();
    const item = (kind === "sfx" ? catalogData.sounds : catalogData.music).find((entry) => entry.id === id);
    if (!item) throw new SoundLibraryError("not_found", `kino's sound library has no ${kind}:${id}.`);
    let bytes, name, credit;
    if (kind === "music") {
      name = `${item.title}${path.extname(new URL(item.url).pathname) || ".mp3"}`;
      bytes = await readFile(await sourceFile(`music-${id}`, { url: item.url, sha256: item.sha256, name }));
      credit = { source: "kino library", id: value.trim(), title: item.title, creator: "Kevin MacLeod", page: item.page, license: item.license, licenseUrl: item.licenseUrl, line: item.credit };
    } else {
      const source = catalogData.sources[item.source];
      const packed = await sourceFile(item.source, { url: source.url, sha256: source.sha256, name: path.basename(new URL(source.url).pathname) });
      bytes = item.path ? zipEntry(await readFile(packed), item.path) : await readFile(packed);
      if (item.reverse) bytes = reversedWav(bytes, item.reverse);
      name = `${id}${path.extname(item.path ?? packed)}`;
      credit = { source: "kino library", id: value.trim(), title: id, creator: source.author, page: source.page, license: source.license, licenseUrl: source.licenseUrl,
        line: `"${id}" from ${source.title} by ${source.author}, ${source.license} (${source.page})` };
    }
    const folder = await makeTempFolder("kino-sound-");
    try {
      const file = path.join(folder, name.replace(/[/\\]/g, "-"));
      await writeFile(file, bytes, { mode: 0o600 });
      return await addMedia(file, { name, mime: TYPES[path.extname(name).slice(1).toLowerCase()], extra: { credit } });
    } finally {
      await removeTempFolder(folder);
    }
  }

  return { searchSounds, listMusic, importItem, catalog: read };
}

/**
 * A reverse swell from a PCM WAV: its first `seconds` (a hit and its early ring) played backwards,
 * faded in over the first 60%, so it rises into the hit (a reverse cymbal from a CC0 crash).
 */
export function reversedWav(wav, seconds) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new SoundLibraryError("failed", "The sound to reverse is not a WAV file.");
  let at = 12, format = null, data = null;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") format = { code: wav.readUInt16LE(at + 8), channels: wav.readUInt16LE(at + 10), rate: wav.readUInt32LE(at + 12), bits: wav.readUInt16LE(at + 22) };
    if (id === "data") data = { start: at + 8, size: Math.min(size, wav.length - at - 8) };
    at += 8 + size + (size % 2);
  }
  if (!format || !data || format.code !== 1 || ![16, 24].includes(format.bits)) throw new SoundLibraryError("failed", "kino reverses only 16 or 24-bit PCM WAV files.");
  const width = (format.bits / 8) * format.channels;
  const frames = Math.min(Math.floor(data.size / width), Math.round(seconds * format.rate));
  const body = Buffer.alloc(frames * width);
  const fade = Math.max(1, Math.round(frames * 0.6));
  const bytes = format.bits / 8, max = 2 ** (format.bits - 1);
  for (let frame = 0; frame < frames; frame++) {
    const gain = frame < fade ? (frame / fade) ** 2 : 1;
    for (let channel = 0; channel < format.channels; channel++) {
      const from = data.start + (frames - 1 - frame) * width + channel * bytes;
      const value = Math.round(wav.readIntLE(from, bytes) * gain);
      body.writeIntLE(Math.max(-max, Math.min(max - 1, value)), frame * width + channel * bytes, bytes);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + body.length, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(format.channels, 22); header.writeUInt32LE(format.rate, 24);
  header.writeUInt32LE(format.rate * width, 28); header.writeUInt16LE(width, 32); header.writeUInt16LE(format.bits, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

/** One file out of a ZIP archive (stored or deflated), read from its central directory. */
export function zipEntry(zip, wanted) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new SoundLibraryError("failed", "The sound pack is not a ZIP archive.");
  let at = zip.readUInt32LE(end + 16);
  for (let count = zip.readUInt16LE(end + 10); count > 0; count--) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (name === wanted) {
      const local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(body);
      if (method === 8) return inflateRawSync(body);
      throw new SoundLibraryError("failed", `${wanted} uses a ZIP method kino does not read (${method}).`);
    }
    at += 46 + skip;
  }
  throw new SoundLibraryError("not_found", `${wanted} is not in the sound pack.`);
}

// A music drop, from ebur128's loudness every 0.1 s as [[t, short, momentary]] (LUFS; the 3 s and
// 0.4 s windows): the moment after 8 s with the most rise plus jump (the last of equals) where
//   - the short-term level from 2 to 5 s after it is DROP_RISE LU or more over the 6 s before,
//   - that level is within 3 LU of the track's loudest, and
//   - the momentary level jumps DROP_JUMP LU or more across it (1.3 s each side): it hits at once.
// A soft track that swells back over seconds after a quiet break (Bittersweet: 6.2 LU across its
// return) has no drop. Silence and the first 3 s (a window not yet full) do not count.
// scripts/sound-library-measure.mjs measures the catalog with it.
export const DROP_RISE = 6;
export const DROP_JUMP = 9;
export function musicDrop(curve) {
  const points = (curve ?? []).filter(([t, short]) => t >= 3 && short > -70);
  if (points.length < 2) return null;
  const mean = (from, to, k = 1) => { const part = points.filter(([t]) => t >= from && t < to); return part.length ? part.reduce((total, point) => total + Math.max(-70, point[k] ?? point[1]), 0) / part.length : null; };
  const loudest = Math.max(...points.map(([, short]) => short));
  const end = points.at(-1)[0];
  let best = null;
  for (let tenth = 80; tenth / 10 + 5 <= end; tenth += 1) {
    const t = tenth / 10, before = mean(t - 6, t), after = mean(t + 2, t + 5);
    if (before == null || after == null || after < loudest - 3) continue;
    const rise = after - before, jump = mean(t + 0.2, t + 1.5, 2) - mean(t - 1.5, t - 0.2, 2);
    if (rise >= DROP_RISE && jump >= DROP_JUMP && (!best || rise + jump >= best.score - 1e-9)) best = { at: t, score: rise + jump };
  }
  return best?.at ?? null;
}

const sec = (value) => Math.round(value * 10) / 10;

/** The lines library sounds answers with, from the built-in library. */
export function librarySoundsText({ query, results }, { searchOn = false } = {}) {
  if (!results.length) return `No library sound matches "${query}". Try a plainer word (whoosh, swish, click, tap, pop, impact, boom, glitch, chime, error, zap).${searchOn ? " Or search Openverse: library {topic:\"sounds\", search, name:\"openverse\"}." : ""}`;
  return [
    `${Math.min(results.length, 10)} of ${results.length} CC0 library sounds for "${query}" (seconds, loudness LUFS):`,
    ...results.slice(0, 10).map((sound) => `sfx:${sound.id} ${sec(sound.seconds)}s ${sound.lufs ?? "?"} LUFS: ${sound.words}`),
    'Import one: project {action:"import", file:"sfx:<id>"} (credit kept). Put each on a visible action only.',
  ].join("\n");
}

/** The lines library music answers with. */
export function musicText({ moods, energies, range, results, total }) {
  const asked = [...moods, ...energies, range ? `${range[0]}-${range[1]} bpm` : ""].filter(Boolean).join(", ") || "any";
  if (!results.length) return `No library track fits ${asked} (of ${total}). Drop a filter, or try moods: ${MOODS.join(", ")}; energy: ${ENERGIES.join(", ")}.`;
  return [
    `${Math.min(results.length, 8)} of ${results.length} library tracks for ${asked} (this project's order; Kevin MacLeod, CC BY 4.0, credit required):`,
    ...results.slice(0, 8).map((track) => `music:${track.id} '${track.title}' ${track.moods.join("/")} ${track.energy} ${track.bpm ?? "?"} bpm ${Math.round(track.seconds)}s ${track.genre}${track.drop ? `, drop at ${track.drop}s` : ", no drop"}`),
    'Import one: project {action:"import", file:"music:<id>"}; put its credit line in the end credits.',
  ].join("\n");
}
