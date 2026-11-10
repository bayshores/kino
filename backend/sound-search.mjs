// Sound effects from Openverse (https://api.openverse.org), commercially usable licenses only
// (license_type=commercial: CC0, CC BY and the like, never NC; direction plan fix 8, milestone B8),
// and from Freesound when the person adds a free Freesound API key in kino Settings (optional:
// kino never needs an account; without the key it says so and searches Openverse alone). It is kino's first agent feature that goes online: the search words reach
// Openverse, so it stays off until the person turns on "web search" in kino Settings.
//
// - search(words): up to 10 sounds no longer than maxSeconds, as `openverse:<id>` (and
//   `freesound:<id>`) lines the agent passes to project import. Openverse's category filter returns nothing for effects, so
//   kino filters by license and length instead.
// - importSound("openverse:<id>" or "freesound:<id>"): reads the sound's record again (the license
//   must still allow commercial use), downloads the file (Freesound's MP3 preview, not the original) and adds it to the media
//   library with its credit: title, creator, source page, license and Openverse's credit line.
// - Openverse allows 20 searches a minute, 200 a day and 20 results a page without an account
//   (a bigger page answers 401). A 429 answer stops
//   every call until its retry-after time (60 s at least); kino never retries on its own.
// - No personal details: the requests carry kino's own agent name and the search words only.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";

const API = "https://api.openverse.org/v1/audio/";
const USER_AGENT = "kino (https://github.com/bayshores/kino)";
export const OPENVERSE_NOTE = "Made using Openverse. Not endorsed or certified by Openverse.";
export const SOUND_LIMITS = Object.freeze({ results: 10, words: 120, maxSeconds: 60, defaultSeconds: 10, megabytes: 10 });
const ID = /^openverse:([0-9a-f-]{36})$/i;
const FREESOUND_ID = /^freesound:(\d{1,12})$/i;
const FREESOUND_API = "https://freesound.org/apiv2/";
// Licenses kino imports: free for commercial use (BY ones need the credit kino keeps).
const COMMERCIAL = { cc0: "CC0", pdm: "Public Domain Mark", by: "CC BY", "by-sa": "CC BY-SA", sampling: null, "by-nc": null };
const TYPES = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" };
// The hosts Openverse's sound files come from; anything else is refused.
const FILE_HOSTS = ["cdn.freesound.org", "freesound.org", "upload.wikimedia.org", "ccmixter.org"];

export class SoundSearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isOpenverseId = (value) => ID.test(String(value ?? "").trim());
export const isFreesoundId = (value) => FREESOUND_ID.test(String(value ?? "").trim());

/** A Freesound license URL as kino's short name ("cc0", "by"), or null when it is not commercial (NC, sampling+). */
export function freesoundLicense(url) {
  const text = String(url ?? "").toLowerCase();
  if (text.includes("publicdomain/zero")) return "cc0";
  if (/\/licenses\/by\/\d/.test(text)) return "by";
  return null;
}

/**
 * deps: enabled() (the Settings switch), fetch (tests pass a stub; never the network there),
 * addMedia(file, {name, mime, extra}) (adds a downloaded file to the media library), now().
 */
export function createSoundSearch({ enabled, fetch = globalThis.fetch, addMedia, now = Date.now, api = API, freesoundKey = () => null, freesoundApi = FREESOUND_API }) {
  let blockedUntil = 0;
  // Tests point api at a local stub (KINO_OPENVERSE_API); its files are then allowed from there.
  const stub = api === API ? null : new URL(api);
  const seen = new Map();

  function ready() {
    if (!enabled()) throw new SoundSearchError("sound_search_off", "Sound search is off: the person turns it on in kino Settings (web search). Until then, ask them for sound files and import those.");
    const wait = Math.ceil((blockedUntil - now()) / 1000);
    if (wait > 0) throw new SoundSearchError("rate_limited", `Openverse limits searches (20 a minute, 200 a day without an account). Try again in ${wait} s; kino does not retry on its own.`);
  }

  async function get(url, headers = {}) {
    let response;
    // A time limit, as soundtrack.mjs has: a network that never answers must not hold the turn.
    try { response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers }, redirect: "follow", signal: AbortSignal.timeout(60000) }); }
    catch (error) {
      if (error?.name === "TimeoutError") throw new SoundSearchError("failed", "Openverse did not answer within 60 s; try again later or import a sound file.");
      throw new SoundSearchError("failed", `Openverse could not be reached (${error.message}).`);
    }
    if (response.status === 429) {
      const after = Number(response.headers?.get?.("retry-after"));
      blockedUntil = now() + Math.max(60, Number.isFinite(after) ? after : 0) * 1000;
      ready();
    }
    if (response.status === 404) throw new SoundSearchError("not_found", "Openverse has no sound with that id.");
    if (!response.ok) throw new SoundSearchError("failed", `Openverse answered ${response.status}.`);
    return response;
  }

  const key = () => String(freesoundKey() ?? "").trim() || null;

  // Freesound's text search (a free API key; previews need no OAuth). A failure leaves Openverse's results.
  async function freesound(query, longest) {
    if (!key()) return [];
    const params = new URLSearchParams({ query, filter: `duration:[0 TO ${longest}]`, fields: "id,name,username,license,duration,previews,url", page_size: "15" });
    try {
      const body = await (await get(`${freesoundApi}search/text/?${params}`, { authorization: `Token ${key()}` })).json();
      return (Array.isArray(body?.results) ? body.results : []).map(freesoundSound).filter(Boolean);
    } catch { return []; }
  }

  /** Commercially usable sounds for the words (Openverse, plus Freesound with a key), the best matches first. */
  async function search(words, { maxSeconds = SOUND_LIMITS.defaultSeconds } = {}) {
    ready();
    const query = String(words ?? "").trim().replace(/\s+/g, " ").slice(0, SOUND_LIMITS.words);
    if (!query) throw new SoundSearchError("bad_input", 'sounds needs search: what the sound is, concretely ("camera shutter", "phone vibrate on a table").');
    const longest = Math.min(SOUND_LIMITS.maxSeconds, Math.max(0.1, Number(maxSeconds) || SOUND_LIMITS.defaultSeconds));
    const url = `${api}?${new URLSearchParams({ q: query, license_type: "commercial", page_size: "20", mature: "false" })}`;
    const body = await (await get(url)).json();
    const fromOpenverse = (Array.isArray(body?.results) ? body.results : []).map(sound);
    const fromFreesound = await freesound(query, longest);
    // Both lists interleaved, so neither source fills the page alone; one sound found twice is kept once.
    const both = [];
    for (let i = 0; i < Math.max(fromOpenverse.length, fromFreesound.length); i += 1) both.push(fromFreesound[i], fromOpenverse[i]);
    const titles = new Set();
    const results = both
      .filter((entry) => entry && entry.seconds > 0 && entry.seconds <= longest)
      .filter((entry) => { const name = `${entry.title}|${entry.creator}`.toLowerCase(); if (titles.has(name)) return false; titles.add(name); return true; })
      .slice(0, SOUND_LIMITS.results);
    for (const entry of results) seen.set(entry.id, entry);
    return { query, maxSeconds: longest, results, total: (Number(body?.result_count) || fromOpenverse.length) + fromFreesound.length, freesound: Boolean(key()) };
  }

  /** Downloads one sound into the media library with its credit. */
  async function importSound(value) {
    ready();
    const free = String(value ?? "").trim().match(FREESOUND_ID);
    const match = free ? null : String(value ?? "").trim().match(ID);
    if (!match && !free) throw new SoundSearchError("bad_input", "A found sound is openverse:<id> or freesound:<id>, as library sounds lists it.");
    if (free && !key()) throw new SoundSearchError("refused", "freesound sounds need the free Freesound API key in kino Settings (sound search); it is not set.");
    const id = free ? free[1] : match[1].toLowerCase();
    // The record is read again: a license can change, and only commercial-use licenses are accepted.
    const entry = free
      ? freesoundSound(await (await get(`${freesoundApi}sounds/${id}/?fields=id,name,username,license,duration,previews,url`, { authorization: `Token ${key()}` })).json())
      : sound(await (await get(`${api}${id}/`)).json());
    if (!entry) throw new SoundSearchError("refused", `${free ? "freesound" : "openverse"}:${id} no longer allows commercial use (or has no file), so kino does not import it.`);
    const fileUrl = new URL(entry.url);
    const fromStub = stub && fileUrl.host === stub.host;
    if (!fromStub && (fileUrl.protocol !== "https:" || !FILE_HOSTS.some((host) => fileUrl.hostname === host || fileUrl.hostname.endsWith(`.${host}`))))
      throw new SoundSearchError("refused", `openverse:${id}'s file is on ${fileUrl.hostname}, which kino does not download from.`);
    const response = await get(fileUrl.href);
    // A redirect must stay on an allowed host too.
    const landed = response.url ? new URL(response.url) : fileUrl;
    if (!fromStub && landed.hostname !== fileUrl.hostname && !FILE_HOSTS.some((host) => landed.hostname === host || landed.hostname.endsWith(`.${host}`)))
      throw new SoundSearchError("refused", `openverse:${id}'s file moved to ${landed.hostname}, which kino does not download from.`);
    const limit = SOUND_LIMITS.megabytes * 1024 * 1024;
    if (Number(response.headers?.get?.("content-length")) > limit) throw new SoundSearchError("refused", `openverse:${id} is over ${SOUND_LIMITS.megabytes} MB.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new SoundSearchError("refused", `openverse:${id} is over ${SOUND_LIMITS.megabytes} MB.`);
    const folder = await makeTempFolder("kino-sound-");
    try {
      const file = path.join(folder, `sound.${entry.filetype}`);
      await writeFile(file, bytes, { mode: 0o600 });
      const credit = {
        source: free ? "freesound" : "openverse", id: entry.id, title: entry.title, creator: entry.creator, page: entry.page,
        license: entry.license, licenseUrl: entry.licenseUrl, line: entry.line,
        file: entry.provider === "freesound" ? "Freesound preview (MP3), not the original file" : `${entry.filetype.toUpperCase()} from ${entry.provider}`,
      };
      return await addMedia(file, { name: `${entry.title}.${entry.filetype}`.slice(0, 200), mime: TYPES[entry.filetype], extra: { credit } });
    } finally {
      await removeTempFolder(folder);
    }
  }

  return { search, importSound, enabled: () => Boolean(enabled()) };
}

// One Freesound record as kino keeps it (its MP3 preview), or null when its license is not commercial.
function freesoundSound(record) {
  if (!record || typeof record !== "object" || !Number.isInteger(Number(record.id))) return null;
  const short = freesoundLicense(record.license);
  const url = record.previews?.["preview-hq-mp3"] ?? record.previews?.["preview-lq-mp3"];
  if (!short || typeof url !== "string") return null;
  const clean = (value, fallback) => String(value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
  const title = clean(record.name, "untitled sound");
  const creator = clean(record.username, "unknown");
  const page = typeof record.url === "string" ? record.url : `https://freesound.org/s/${record.id}/`;
  const license = COMMERCIAL[short];
  return {
    id: `freesound:${record.id}`, title, creator, seconds: Math.round((Number(record.duration) || 0) * 100) / 100,
    provider: "freesound", page, url, filetype: "mp3", license, licenseUrl: String(record.license),
    line: `"${title}" by ${creator}, ${license} (${page})`,
  };
}

// One Openverse record as kino keeps it, or null when its license is not commercial or it has no file kino reads.
function sound(record) {
  if (!record || typeof record !== "object") return null;
  const short = String(record.license).toLowerCase();
  if (!COMMERCIAL[short] || typeof record.url !== "string" || typeof record.id !== "string") return null;
  let filetype = String(record.filetype ?? "").toLowerCase();
  if (!filetype) try { filetype = path.extname(new URL(record.url).pathname).slice(1).toLowerCase(); } catch { return null; }
  if (!TYPES[filetype]) return null;
  const clean = (value, fallback) => String(value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
  const title = clean(record.title, "untitled sound");
  const creator = clean(record.creator, "unknown");
  return {
    id: `openverse:${record.id.toLowerCase()}`, title, creator,
    seconds: Math.round((Number(record.duration) || 0) / 10) / 100,
    provider: clean(record.provider ?? record.source, "openverse"),
    page: typeof record.foreign_landing_url === "string" ? record.foreign_landing_url : null,
    url: record.url, filetype,
    license: `${COMMERCIAL[short]}${record.license_version ? ` ${record.license_version}` : ""}`,
    licenseUrl: typeof record.license_url === "string" ? record.license_url : null,
    line: typeof record.attribution === "string" && short !== "cc0" ? record.attribution.replace(/\s+/g, " ").trim().slice(0, 300)
      : `"${title}" by ${creator}, ${COMMERCIAL[short]}${record.license_version ? ` ${record.license_version}` : ""}${record.foreign_landing_url ? ` (${record.foreign_landing_url})` : ""}`,
  };
}

/** The lines library sounds answers with. */
export function soundsText({ query, maxSeconds, results, total, freesound = false }) {
  const keyLine = freesound ? null : "Freesound is not searched: no Freesound API key in kino Settings (optional, free).";
  if (!results.length) return [`No commercial-use sound of ${maxSeconds} s or less for "${query}" (${total} found in all). Try other words for the same thing, or full:true for sounds up to ${SOUND_LIMITS.maxSeconds} s.`, keyLine].filter(Boolean).join("\n");
  return [
    `${results.length} commercial-use sounds for "${query}" (${maxSeconds} s or less; Freesound previews are MP3s):`,
    ...results.map((entry) => `${entry.id} '${entry.title}' ${entry.seconds}s by ${entry.creator} (${entry.provider}, ${entry.license})`),
    'Import one: project {action:"import", file:"<id>"}; kino keeps its credit (license, creator, page) with the file.',
    keyLine,
    OPENVERSE_NOTE,
  ].filter(Boolean).join("\n");
}
