// Soundtrack search: songs for the open video, compared against its story beats.
//
// Three sources, all reached only when an agent (or the person) asks:
// - Openverse (https://api.openverse.org): Creative Commons music, often from Jamendo. Only
//   licenses that allow commercial use and changes (CC0, CC BY, CC BY-SA) are kept, so a pick can
//   be cut to the edit and credited. It shares the "sound search" switch in kino Settings with
//   library sounds, because the search words leave this computer.
// - The Internet Archive's netlabels collection (https://archive.org/details/netlabels): albums
//   from Creative Commons labels, each with its license link. Only CC BY, CC BY-SA, CC0 and public
//   domain items are kept (the search asks for those links; the parser checks them again), behind
//   the same switch. Asked at the same time as Openverse, which is often slow: a search answers
//   with what came back (the Archive first when Openverse is late or fails). One item's file list
//   (metadata/<id>/files) gives its tracks: one or two from each item, so the list is varied.
// - YouTube (yt-dlp, as inspire searches): popular songs, marked "license unknown". kino measures
//   them like the others, and imports one when asked (the whole song as WAV, credit kept), for a
//   private video: the person checks the rights before publishing it.
//
// measure downloads one song at a time (an Openverse preview, an Archive mp3, or a small audio copy from YouTube,
// the first 4 minutes at most) into a temporary folder, decodes it with FFmpeg, runs kino's beat
// analysis (engine/beatDetection.js), the loudness curve below and the song's shape (song-shape.mjs:
// sections from the low band and spectral novelty, a sound fingerprint, vocal spans from whisper),
// then deletes the file. It keeps
// only a small preview for the person to listen to on the inspire screen (<data>/soundtrack/songs/
// <key>.m4a: AAC at 96 kbps, the whole song or 90 s around its build and drop; the newest 24 stay).
// compareToStory lines a measured song up against the story beats (notes intents). kino never
// judges a song: the agent writes why it fits and its verdict (library soundtrack note).
//
// Search answers are cached on disk for a day (<data>/soundtrack/cache), so the same words do not
// reach Openverse, the Archive or YouTube again. No personal details: the requests carry kino's own name.
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { songShape, vocalShare } from "./song-shape.mjs";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";
import { createWebCache } from "./web-cache.mjs";

const API = "https://api.openverse.org/v1/audio/";
const ARCHIVE = "https://archive.org";
const USER_AGENT = "kino (https://github.com/bayshores/kino)";
export const SOUNDTRACK_LIMITS = Object.freeze({ results: 5, words: 120, minSeconds: 20, cacheMs: 24 * 60 * 60 * 1000, measureSeconds: 240, megabytes: 15, kept: 24, previewSeconds: 90, previews: 24, mix: 12, searchMs: 60000, graceMs: 8000, slowSearchMs: 180000, downloadMs: 90000 });
const TYPES = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" };
// Licenses that allow commercial use and changes (a song cut to an edit is a change).
const USABLE = new Set(["cc0", "by", "by-sa", "pdm"]);
// archive.org/download answers with a redirect to one of its file servers (ia*.us.archive.org,
// dn*.ca.archive.org), so any archive.org host is allowed.
const FILE_HOSTS = ["jamendo.com", "freesound.org", "wikimedia.org", "ccmixter.org", "archive.org"];
const OPENVERSE_ID = /^openverse:([0-9a-f-]{36})$/i;
const YT_ID = /^yt:([A-Za-z0-9_-]{11})$/;
// archive:<item identifier>/<file name, URL-encoded so it has no slash or space>
const ARCHIVE_ID = /^archive:([A-Za-z0-9._-]{1,100})\/([^\s/]{1,240})$/;
const NAMES = { openverse: "Openverse", archive: "Internet Archive" };
// ListenBrainz: the open catalog explore reads genre tags from (keyless; data CC0).
const LISTENBRAINZ = "https://api.listenbrainz.org/1";
const ASKED = { ...NAMES, listenbrainz: "ListenBrainz" };

const SLOW = Symbol("slow");

export class SoundtrackError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** A song id's file-safe name: yt-<video id>, ov-<Openverse id> or ia-<Archive item and file>; null for anything else. */
export function songKey(id) {
  const text = String(id ?? "");
  const youtube = YT_ID.exec(text);
  if (youtube) return `yt-${youtube[1]}`;
  if (ARCHIVE_ID.test(text)) return `ia-${archiveKey(text)}`;
  const openverse = OPENVERSE_ID.exec(text);
  return openverse ? `ov-${openverse[1].toLowerCase()}` : null;
}
// An Archive id as a file-safe name: letters, digits, _ and -, at most 120. A longer one keeps its
// first 111 and a hash of the whole id, so two long names in one item never share a preview.
// frontend/dashboard/inspireView.js has the same function.
function archiveKey(id) {
  const name = id.slice(8).replace(/[^A-Za-z0-9_-]+/g, "_");
  if (name.length <= 120) return name;
  let hash = 0x811c9dc5;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${name.slice(0, 111)}_${hash.toString(16).padStart(8, "0")}`;
}
// A file name as an id part: URL-encoded, and ! ' ( ) * too, so a shell takes the id as it is.
const idPart = (name) => encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
/** What a preview's name (and the dashboard's song route) must look like. */
export const SONG_KEY = /^(?:yt-[A-Za-z0-9_-]{11}|ov-[0-9a-f-]{36}|ia-[A-Za-z0-9_-]{1,120})$/;

/**
 * The stretch of a song kept as its preview: the whole song when it is short, else `limit` seconds
 * from 5 s before its first build (or 20 s before its first drop), so the build and drop are in it.
 */
export function previewStretch(seconds, sections = [], limit = SOUNDTRACK_LIMITS.previewSeconds) {
  const length = Math.max(0, Number(seconds) || 0);
  if (length <= limit) return { from: 0, seconds: round(length, 1) };
  const drop = sections.find((part) => part.kind === "drop");
  const build = sections.filter((part) => part.kind === "build" && (!drop || part.at <= drop.at)).at(-1);
  const anchor = build ? build.at - 5 : drop ? drop.at - 20 : 0;
  return { from: round(Math.max(0, Math.min(anchor, length - limit)), 1), seconds: limit };
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const clean = (value, fallback) => String(value ?? fallback).replace(/\s+/g, " ").trim().slice(0, 120) || fallback;

/** A license as people write it: CC0 1.0, CC BY 4.0, Public Domain Mark. */
export function licenseName(license, version) {
  const id = String(license ?? "").toLowerCase();
  if (id === "cc0") return "CC0 1.0";
  if (id === "pdm") return "Public Domain Mark 1.0";
  return `CC ${id.toUpperCase()}${version ? ` ${version}` : ""}`;
}

/** Openverse's answer as candidates: usable licenses, songs of 20 s or more, a file kino reads. */
export function parseOpenverseMusic(body) {
  const records = Array.isArray(body?.results) ? body.results : [];
  return records.map((record) => {
    if (!record || typeof record.id !== "string" || typeof record.url !== "string") return null;
    const license = String(record.license ?? "").toLowerCase();
    if (!USABLE.has(license)) return null;
    // Jamendo's mp31 and mp32 (its bitrate labels, all Openverse sends for its songs) are mp3.
    let filetype = String(record.filetype ?? "").toLowerCase().replace(/^mp3\d$/, "mp3");
    if (!filetype) try { filetype = path.extname(new URL(record.url).pathname).slice(1).toLowerCase(); } catch { return null; }
    if (!TYPES[filetype]) return null;
    const seconds = round((Number(record.duration) || 0) / 1000, 1);
    if (seconds < SOUNDTRACK_LIMITS.minSeconds) return null;
    const title = clean(record.title, "untitled song");
    const creator = clean(record.creator, "unknown");
    const page = typeof record.foreign_landing_url === "string" ? record.foreign_landing_url : null;
    const name = licenseName(license, record.license_version);
    const licenseUrl = typeof record.license_url === "string" ? record.license_url : null;
    return {
      id: `openverse:${record.id.toLowerCase()}`, source: "openverse", use: "licensed", title, creator, seconds,
      provider: clean(record.source ?? record.provider, "openverse"), page, url: record.url, filetype,
      license: name, licenseUrl,
      credit: `"${title}" by ${creator}${page ? ` (${page})` : ""}, ${name}${licenseUrl ? ` (${licenseUrl})` : ""}`,
    };
  }).filter(Boolean);
}

/** A Creative Commons license link as Openverse names it (by, by-sa, cc0, pdm) and its version; null otherwise. */
export function licenseFromUrl(url) {
  const match = /creativecommons\.org\/(?:licenses\/([a-z-]+)|publicdomain\/(zero|mark))\/(\d+(?:\.\d+)?)/i.exec(String(url ?? ""));
  if (!match) return null;
  const license = match[1] ? match[1].toLowerCase() : match[2].toLowerCase() === "zero" ? "cc0" : "pdm";
  return { license, version: match[3] };
}

// "3:36" or "1:02:05" as seconds; 0 when it is neither.
const clockSeconds = (text) => (/^\d+(?::\d{1,2}){1,2}$/.test(String(text ?? "").trim()) ? String(text).trim().split(":").reduce((sum, part) => sum * 60 + Number(part), 0) : 0);

// Swear words in a title or a creator's name (the Archive marks nothing as explicit).
const EXPLICIT = /\b(?:fuck\w*|shit\w*|bitch\w*|cunt\w*|nigg\w*|fagg\w*|porn\w*|pussy|whore\w*|slut\w*)\b/i;

/** The Archive's search answer (advancedsearch.php) as items with a usable license; never NC or ND. */
export function parseArchiveSearch(body) {
  const docs = Array.isArray(body?.response?.docs) ? body.response.docs : [];
  const first = (value) => [value].flat().find((entry) => typeof entry === "string");
  return docs.map((doc) => {
    const identifier = String(doc?.identifier ?? "");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(identifier)) return null;
    const licenseUrl = first(doc.licenseurl) ?? null;
    const found = licenseFromUrl(licenseUrl);
    if (!found || !USABLE.has(found.license)) return null;
    // The Archive has no explicit flag: an item whose title or creator swears is left out.
    if (EXPLICIT.test(`${first(doc.title) ?? ""} ${first(doc.creator) ?? ""}`)) return null;
    return { identifier, album: clean(first(doc.title), identifier), creator: clean(first(doc.creator), "unknown"), license: licenseName(found.license, found.version), licenseUrl };
  }).filter(Boolean);
}

// An Archive file's length: "439.82" (seconds) or "07:19".
const lengthSeconds = (text) => (String(text ?? "").includes(":") ? clockSeconds(text) : Number(text) || 0);
// Search words worth matching: no numbers, "bpm" or short words.
const searchTerms = (words) => [...new Set(String(words).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !/\d|^bpm$/.test(word) && !["and", "not", "the"].includes(word)))].slice(0, 6);

/**
 * One Archive item's tracks (its metadata/<id>/files answer) as candidates: each song once (an mp3
 * and the mp3s made from the same original are one song), the largest mp3 that fits the download
 * limit, 20 s or more. Tracks whose title has one of the words come first, then in track order.
 */
export function parseArchiveFiles(item, body, words = "") {
  const files = Array.isArray(body?.result) ? body.result : [];
  const songs = new Map();
  files.forEach((file, index) => {
    const name = String(file?.name ?? "");
    if (!/\.mp3$/i.test(name) || !/mp3/i.test(String(file.format ?? ""))) return;
    const song = file.source === "derivative" && typeof file.original === "string" ? file.original : name;
    if (!songs.has(song)) songs.set(song, []);
    songs.get(song).push({ ...file, index });
  });
  const limit = SOUNDTRACK_LIMITS.megabytes * 1024 * 1024;
  const wanted = searchTerms(words);
  const page = `https://archive.org/details/${item.identifier}`;
  const license = `${item.license}${item.licenseUrl ? ` (${item.licenseUrl})` : ""}`;
  return [...songs.values()].map((versions) => {
    const file = versions.filter((entry) => (Number(entry.size) || 0) <= limit).sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
    if (!file) return null;
    const seconds = round(lengthSeconds(versions.find((entry) => entry.length)?.length), 1);
    if (seconds < SOUNDTRACK_LIMITS.minSeconds) return null;
    // An id kino could not read back (a very long name) would be a song it cannot import.
    const id = `archive:${item.identifier}/${idPart(file.name)}`;
    if (!ARCHIVE_ID.test(id)) return null;
    const named = versions.find((entry) => typeof entry.title === "string" && entry.title.trim());
    const title = clean(named?.title ?? file.name.replace(/^.*\//, "").replace(/\.mp3$/i, ""), "untitled song");
    if (EXPLICIT.test(title)) return null;
    const creator = clean(versions.find((entry) => typeof entry.creator === "string")?.creator ?? item.creator, "unknown");
    return {
      id, source: "archive", use: "licensed", title, creator, seconds, album: item.album,
      provider: "archive.org", page, url: `https://archive.org/download/${item.identifier}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
      filetype: "mp3", license: item.license, licenseUrl: item.licenseUrl,
      credit: `"${title}" by ${creator} (from "${item.album}", ${page}), ${license}`,
      order: [wanted.some((word) => title.toLowerCase().includes(word)) ? 0 : 1, Number.parseInt(String(named?.track ?? file.track ?? ""), 10) || 1000, file.index],
    };
  }).filter(Boolean)
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2])
    .map(({ order, ...candidate }) => candidate);
}

// The license links the Archive search asks for (CC BY, CC BY-SA, CC0, public domain): its search
// matches each link exactly. The parser checks every item again.
const ARCHIVE_LICENSES = ["http", "https"].flatMap((scheme) => [
  ...["by", "by-sa"].flatMap((kind) => ["1.0", "2.0", "2.5", "3.0", "4.0"].map((version) => `${scheme}://creativecommons.org/licenses/${kind}/${version}/`)),
  `${scheme}://creativecommons.org/publicdomain/zero/1.0/`, `${scheme}://creativecommons.org/publicdomain/mark/1.0/`]);

/** The Archive search for the words: any of them in a netlabels item's title, subject or description, usable licenses only. */
export function archiveQuery(words) {
  const any = searchTerms(words).join(" OR ");
  const match = any ? ` AND (title:(${any}) OR subject:(${any}) OR description:(${any}))` : "";
  return `collection:netlabels AND mediatype:audio${match} AND (${ARCHIVE_LICENSES.map((url) => `licenseurl:"${url}"`).join(" OR ")})`;
}

/**
 * The candidates a video keeps, at most `limit`: songs that were measured, noted or picked stay;
 * the oldest of the rest go first.
 */
export function keepCandidates(list, limit = SOUNDTRACK_LIMITS.kept) {
  // Over the limit, songs the person said no to go first (their taste keeps them), then the oldest
  // never measured, noted, picked or queued to measure.
  const valued = (entry) => Boolean(entry.queued || entry.measure || entry.note || entry.picked);
  let extra = list.length - limit;
  let kept = list.filter((entry) => (extra > 0 && entry.rejected && !entry.picked ? (extra -= 1, false) : true));
  kept = kept.filter((entry) => (extra > 0 && !valued(entry) ? (extra -= 1, false) : true));
  return kept.slice(-limit);
}

// Search results that are not the song itself: reviews, tutorials, live sets, lyric and slowed
// re-uploads, mixes and compilations. Kept when the search asked for one ("live", "remix" ...).
// "Original Mix", "Radio Mix" and "Extended Mix" are a dance track's own name, so they stay.
const NOT_THE_SONG = /\b(review|reaction|tutorial|deconstruction|breakdown|full album|live|lyrics?|slowed|sped up|reverb|nightcore|8d|(?<!(?:original|radio|extended|club|dub|vocal|instrumental)\s)mix|mixtape|best of|cover|remake|karaoke|instrumental|\d+\s*hours?)\b/gi;
// Never a song, whatever the search asked: producers' type beats and free beats, loops and drum
// practice tracks, game videos, stock "royalty free" uploads, how-tos and long compilations.
const JUNK = /type beat|\[\s*free\s*\]|\bfree\b[^|]*\bbeats?\b|beat ?tape|\bloops?\b|\b\d{2,3}\s?bpm\b|\bpractice\b|drum(?:less)? track|backing track|play[- ]?along|geometry dash|gameplay|\blevel\b|minecraft|fortnite|roblox|royalty[ -]?free|no copyright|copyright[ -]free|stock music|background music|music for (?:commercials|videos|youtube)|\bhow to\b|\btutorial\b|\b1 ?hour\b|\b\d+\s*hours?\b|slowed|reverb|sped up|nightcore|\bcover\b/i;

/** True for a YouTube title that is never the song itself (JUNK), whatever the search words. */
export function junkTitle(title) {
  return JUNK.test(String(title ?? ""));
}

/** yt-dlp search results (inspire's parseSearchLines) as reference-only candidates: songs only, once each. */
export function youtubeCandidates(results, query = "") {
  const asked = new Set((String(query).match(NOT_THE_SONG) ?? []).map((word) => word.toLowerCase()));
  const seen = new Set();
  return (Array.isArray(results) ? results : []).filter((entry) => {
    if (!entry?.id || Number(entry.duration) < SOUNDTRACK_LIMITS.minSeconds || Number(entry.duration) > 600) return false;
    if (junkTitle(entry.title)) return false;
    if ((String(entry.title).match(NOT_THE_SONG) ?? []).some((word) => !asked.has(word.toLowerCase()))) return false;
    const name = String(entry.title).toLowerCase().replace(/\(official[^)]*\)|\[[^\]]*\]/g, "").replace(/[^a-z0-9]+/g, "");
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  }).map((entry) => ({
    id: entry.id, source: "youtube", use: "license unknown", title: clean(entry.title, "untitled"), creator: clean(String(entry.channel ?? "").replace(/\s+-\s+Topic$/i, ""), "unknown"),
    seconds: round(Number(entry.duration), 1), page: entry.url ?? null, license: "license unknown",
  }));
}

// ---- catalog songs by genre (ListenBrainz, CC0 data, no key) ------------------------------
// A YouTube keyword search is not a music catalog: it finds type beats, mixes and stock uploads.
// ListenBrainz knows real songs by genre tag (MusicBrainz tags, with a popularity percentile); each
// one is then found on YouTube by "artist - title" (pickRecording) and becomes a normal candidate.

/** Each sound lane (music-embed LANES) as MusicBrainz genre tags and words a brief may use. */
export const EXPLORE_LANES = Object.freeze({
  "electronic pop": { tags: ["electropop", "synthpop", "dance-pop"], words: "bright upbeat catchy synth pop electronic modern playful" },
  house: { tags: ["french house", "nu disco", "house"], words: "dance club disco groove driving energetic four floor" },
  guitar: { tags: ["indie rock", "funk", "indie pop"], words: "band guitar rock funk indie energetic" },
  "hip-hop": { tags: ["hip hop", "boom bap"], words: "rap hip hop drums sampled" },
  "lo-fi": { tags: ["lo-fi", "chillhop"], words: "chill mellow relaxed study lo fi" },
  cinematic: { tags: ["soundtrack", "modern classical"], words: "cinematic orchestral strings piano epic score film" },
  synthwave: { tags: ["synthwave", "chillwave"], words: "retro 80s neon synth driving" },
  ambient: { tags: ["ambient", "downtempo"], words: "calm ambient atmospheric slow downtempo" },
  folk: { tags: ["indie folk", "folk pop"], words: "acoustic folk singing warm" },
  trap: { tags: ["trap"], words: "trap 808 hi hats hard" },
});
// Clearly different lanes first, for an explore with no brief and no taste.
const DEFAULT_LANES = ["electronic pop", "guitar", "hip-hop", "cinematic", "house", "ambient"];
const PLAIN = new Set(["music", "beat", "beats", "sound", "song", "songs", "with", "and", "the", "a", "an", "or", "no", "not", "very", "some"]);
const wordsOf = (text) => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !PLAIN.has(word));

/**
 * The lanes an explore asks, `count` of them (4 to 6): lanes the brief's `not` names and lanes the
 * person closed (two rejects) are skipped; the rest go by `scores` (lane id → number, CLAP text
 * closeness to the brief) or, without them, by the brief's words, then in DEFAULT_LANES order.
 */
export function exploreLanes({ brief = null, scores = null, excluded = [], count = 5 } = {}) {
  const wanted = Math.max(4, Math.min(6, Math.round(count) || 5));
  const closed = new Set(excluded);
  const text = (id) => new Set(wordsOf(`${id} ${EXPLORE_LANES[id].tags.join(" ")} ${EXPLORE_LANES[id].words}`));
  const named = (id) => (brief?.not ?? []).some((phrase) => wordsOf(phrase).some((word) => text(id).has(word)));
  const want = wordsOf(brief?.want);
  const score = (id) => (scores?.[id] ?? 0) * 100 + want.filter((word) => text(id).has(word)).length;
  const order = [...DEFAULT_LANES, ...Object.keys(EXPLORE_LANES).filter((id) => !DEFAULT_LANES.includes(id))];
  return order.filter((id) => !closed.has(id) && !named(id))
    .map((id, place) => ({ id, place, score: brief ? score(id) : 0 }))
    .sort((a, b) => b.score - a.score || a.place - b.place)
    .slice(0, wanted).map((lane) => lane.id);
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * ListenBrainz lb-radio/tags answers as recording ids, the most tagged first: a tag on the
 * recording itself or its release beats one only on its artist.
 */
export function parseTagRecordings(body) {
  const rank = { recording: 0, "release-group": 1, artist: 2 };
  return (Array.isArray(body) ? body : []).filter((row) => MBID.test(String(row?.recording_mbid ?? "")))
    .map((row, place) => ({ id: row.recording_mbid, place, by: rank[row.source] ?? 2, count: Number(row.tag_count) || 0 }))
    .sort((a, b) => a.by - b.by || b.count - a.count || a.place - b.place)
    .map((row) => row.id);
}

/** ListenBrainz metadata/recording answers as songs {mbid, artist, title, seconds, tags}, in `ids` order. */
export function parseRecordings(body, ids, tag) {
  const songs = [];
  for (const id of ids) {
    const row = body?.[id];
    const artist = clean(row?.artist?.artists?.[0]?.name ?? row?.artist?.name, "");
    const title = clean(row?.recording?.name, "");
    const seconds = Number(row?.recording?.length) / 1000;
    if (!artist || !title || EXPLICIT.test(title)) continue;
    if (Number.isFinite(seconds) && seconds > 0 && (seconds < 60 || seconds > 600)) continue;
    songs.push({ mbid: id, artist, title, seconds: Number.isFinite(seconds) && seconds > 0 ? round(seconds, 1) : null, tags: [tag] });
  }
  return songs;
}

const plainText = (text) => String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const coreTitle = (title) => plainText(String(title).replace(/\((?:feat|ft)\.?[^)]*\)|\s(?:feat|ft)\.?\s.*$/i, "").replace(/\([^)]*\)|\[[^\]]*\]/g, ""));

/** The YouTube search that finds one catalog song. */
export function catalogQuery(song) {
  return `${song.artist} - ${String(song.title).replace(/\((?:feat|ft)\.?[^)]*\)/i, "").trim()}`.slice(0, 120);
}

/**
 * The YouTube result that is this catalog song, or null: its title names the song, the artist is
 * the channel or in the title, the length is close, and it is not junk, live or an unasked remix.
 * An "Artist - Topic" upload (the label's own audio) beats "official audio", which beats the rest.
 */
export function pickRecording(results, song) {
  const title = coreTitle(song.title);
  const artist = plainText(song.artist);
  const own = plainText(song.title);
  let best = null;
  for (const entry of Array.isArray(results) ? results : []) {
    const named = plainText(entry?.title);
    const channel = plainText(entry?.channel).replace(/ topic$/, "");
    if (!entry?.id || !title || junkTitle(entry.title) || !named.includes(title)) continue;
    if (!channel.includes(artist) && !named.includes(artist) && !(channel && artist.includes(channel))) continue;
    if (/\b(?:live|karaoke|lyrics?|instrumental|remix)\b/.test(named.replace(own, "")) ) continue;
    if (song.seconds && Math.abs(Number(entry.duration) - song.seconds) > Math.max(20, song.seconds * 0.15)) continue;
    const score = (/ - topic$/i.test(String(entry.channel ?? "")) ? 3 : 0) + (/official audio/.test(named) ? 2 : 0) + (entry.verified ? 1 : 0) + (/official/.test(named) ? 0.5 : 0);
    if (!best || score > best.score) best = { entry, score };
  }
  return best ? youtubeCandidates([best.entry], song.title)[0] ?? null : null;
}

/**
 * The song's loudness each `step` seconds, 0 to 100 (100: its loudest second, 0: 50 dB quieter
 * or silent). Mono samples in, numbers out.
 */
export function energyCurve(samples, sampleRate, step = 1) {
  const size = Math.max(1, Math.round(sampleRate * step));
  const decibels = [];
  for (let start = 0; start < samples.length; start += size) {
    let sum = 0;
    const end = Math.min(samples.length, start + size);
    for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    decibels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  const loudest = Math.max(...decibels, -120);
  return decibels.map((value) => Math.round(Math.max(0, Math.min(100, ((value - (loudest - 50)) / 50) * 100))));
}

/**
 * The song's sections from its loudness (one value a second): a drop (at least 20 louder than the
 * 4 s before it, and 70 or more), the build before it (from the quietest second in the 12 s before
 * a drop, when it rises 15 or more), a break (25 quieter than the 4 s before, 50 or less) and the
 * outro (from where every later second stays 15 under the song's middle loudness).
 */
export function songSections(curve) {
  const smooth = curve.map((_, index) => {
    const near = curve.slice(Math.max(0, index - 1), index + 2);
    return near.reduce((sum, value) => sum + value, 0) / near.length;
  });
  const before = (index) => {
    const prior = smooth.slice(Math.max(0, index - 4), index);
    return prior.length ? prior.reduce((sum, value) => sum + value, 0) / prior.length : smooth[index];
  };
  const sections = [];
  const last = (kind) => sections.filter((entry) => entry.kind === kind).at(-1)?.at ?? -Infinity;
  for (let index = 4; index < smooth.length; index += 1) {
    if (smooth[index] >= 70 && smooth[index] - before(index) >= 20 && index - last("drop") >= 8) {
      const from = Math.max(0, index - 12);
      const window = smooth.slice(from, index);
      const low = from + window.indexOf(Math.min(...window));
      if (smooth[index] - smooth[low] >= 15 && low < index - 1 && low > last("drop")) sections.push({ at: low, kind: "build" });
      sections.push({ at: index, kind: "drop" });
    } else if (smooth[index] <= 50 && before(index) - smooth[index] >= 25 && index - last("break") >= 8 && index < smooth.length - 10) {
      sections.push({ at: index, kind: "break" });
    }
  }
  const sorted = [...smooth].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let outro = smooth.length;
  while (outro > 0 && smooth[outro - 1] <= middle - 15) outro -= 1;
  if (outro < smooth.length - 2 && outro > smooth.length * 0.6) sections.push({ at: outro, kind: "outro" });
  return sections.sort((a, b) => a.at - b.at);
}

/**
 * One measured song against the video: beats [{from, to}] (the story intents, or the whole scene)
 * and length (seconds). The song starts at `start` seconds in so its first drop lands on the
 * payoff (the last beat's start; 75% in with one beat) when it can, else at 0. Numbers only.
 */
export function compareToStory(measure, { beats, length }) {
  const curve = measure?.energy ?? [];
  const seconds = Number(measure?.seconds) || curve.length;
  const story = beats?.length ? beats : [{ from: 0, to: length }];
  const payoff = story.length > 1 ? story.at(-1).from : round(length * 0.75, 1);
  const drops = (measure?.sections ?? []).filter((entry) => entry.kind === "drop").map((entry) => entry.at);
  const drop = drops.find((at) => at >= payoff) ?? null;
  const start = drop === null ? 0 : Math.max(0, Math.min(drop - payoff, Math.max(0, seconds - length)));
  const mean = (from, to) => {
    const values = curve.slice(Math.floor(from), Math.max(Math.floor(from) + 1, Math.ceil(to)));
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  };
  const rows = story.map((beat, index) => ({ n: index + 1, from: beat.from, to: beat.to, energy: mean(start + beat.from, start + beat.to) }));
  const inside = (at) => at >= start && at < start + length;
  return {
    start, end: round(Math.min(seconds, start + length), 1), payoff,
    dropAt: drop === null ? null : round(drop - start, 1),
    dropOff: drop === null ? null : round(drop - start - payoff, 1),
    beats: rows,
    rise: rows.length > 1 ? rows.at(-1).energy - rows[0].energy : 0,
    breaks: (measure?.sections ?? []).filter((entry) => entry.kind === "break" && inside(entry.at)).map((entry) => round(entry.at - start, 1)),
    short: round(Math.max(0, length - (seconds - start)), 1),
    bpm: measure?.bpm ?? null,
  };
}

/** One candidate's comparison as a short table (numbers, not adjectives). */
export function compareText(candidate, comparison) {
  const c = comparison;
  const lines = [`${candidate.id} '${candidate.title}' by ${candidate.creator} · ${candidate.license} · ${candidate.measure?.bpm ? `${Math.round(candidate.measure.bpm)} bpm${candidate.measure.alt ? ` (or ${Math.round(candidate.measure.alt)})` : ""}` : "no steady beat"} · ${candidate.seconds}s`,
    `  start at ${c.start}s in the song (to ${c.end}s)${c.short ? `, ${c.short}s short of the video` : ""}`,
    `  drop: ${c.dropAt === null ? "none lands in the video" : `at ${c.dropAt}s in the video, payoff at ${c.payoff}s (${c.dropOff >= 0 ? "+" : ""}${c.dropOff}s)`}${c.breaks.length ? ` · breaks at ${c.breaks.join(", ")}s` : ""}`,
    `  energy by beat: ${c.beats.map((beat) => `${beat.n} ${beat.from}-${beat.to}s ${beat.energy}`).join(" · ")} (rise ${c.rise >= 0 ? "+" : ""}${c.rise})`];
  if (candidate.note) lines.push(`  ${candidate.note.verdict}: ${candidate.note.why}`);
  return lines.join("\n");
}

/** A project import of a candidate: the video's candidate with that id, or null. */
export function importableId(file, candidates = []) {
  const text = String(file ?? "").trim();
  if (YT_ID.test(text)) return candidates.find((entry) => entry.id === text && entry.source === "youtube") ?? null;
  if (ARCHIVE_ID.test(text)) return candidates.find((entry) => entry.id === text && entry.source === "archive") ?? null;
  const match = OPENVERSE_ID.exec(text);
  if (!match) return null;
  return candidates.find((entry) => entry.id === `openverse:${match[1].toLowerCase()}` && entry.source === "openverse") ?? null;
}

/**
 * deps: enabled() (the sound search switch, for Openverse and the Archive), directory (<data>/soundtrack),
 * fetch (tests pass a stub), api, archiveApi (https://archive.org), graceMs, searchYouTube(words, {count}), mixYouTube(videoId, {count}) (YouTube's
 * mix for a song, as search results), downloadYouTube(videoId, folder)
 * (the file it saved), decode(file) → {samples, sampleRate}, analyze(samples, rate) (beats),
 * vocals(file, seconds) → [[from, to]] (optional: whisper's vocal spans; without it, or when it
 * throws, a rough guess from the sound), addMedia(file, {name, mime, extra}), preview(file, target, {start, end}) (writes that stretch as
 * AAC .m4a; optional: without it no preview is kept), embed(samples, sampleRate) → {model, vector}
 * or null (optional: the song's CLAP embedding, backend/music-embed.mjs), now().
 */
export function createSoundtrack(deps) {
  const { enabled, directory, fetch = globalThis.fetch, api = API, archiveApi = ARCHIVE, listenbrainzApi = LISTENBRAINZ, now = Date.now, searchMs = SOUNDTRACK_LIMITS.searchMs, graceMs = SOUNDTRACK_LIMITS.graceMs } = deps;
  const stubs = [api === API ? null : new URL(api), archiveApi === ARCHIVE ? null : new URL(archiveApi)].filter(Boolean);
  const blockedUntil = { openverse: 0, archive: 0, listenbrainz: 0 };
  let measuring = Promise.resolve();

  // Every request has a time limit: a network that never answers once held an agent's search
  // (and its turn) for minutes. ms covers the whole answer, body included. source names who is
  // asked (openverse or archive), for its own rate limit and messages.
  async function get(url, ms = searchMs, source = "openverse") {
    const name = ASKED[source];
    const wait = Math.ceil((blockedUntil[source] - now()) / 1000);
    if (wait > 0) throw new SoundtrackError("rate_limited", `${name} limits searches${source === "openverse" ? " (20 a minute, 200 a day without an account)" : ""}. Try again in ${wait} s.`);
    let response;
    try { response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(ms) }); }
    catch (error) {
      if (error?.name === "TimeoutError") throw new SoundtrackError("failed", `${name} did not answer within ${Math.round(ms / 1000)} s; try again later or send a track.`);
      throw new SoundtrackError("failed", `${name} could not be reached (${error.message}).`);
    }
    if (response.status === 429) {
      const after = Number(response.headers?.get?.("retry-after"));
      blockedUntil[source] = now() + Math.max(60, Number.isFinite(after) ? after : 0) * 1000;
      throw new SoundtrackError("rate_limited", `${name} limits searches; try again in ${Math.ceil((blockedUntil[source] - now()) / 1000)} s.`);
    }
    if (!response.ok) throw new SoundtrackError("failed", `${name} answered ${response.status}.`);
    return response;
  }

  // Search answers last a day (web-cache.mjs); sweep() below removes older files.
  const { cached } = createWebCache({ directory: path.join(directory, "cache"), ttlMs: SOUNDTRACK_LIMITS.cacheMs, now });

  // Openverse can take minutes to answer. The agent waits searchMs (or until `stop`, when another
  // source already answered); the search itself keeps going (up to slowSearchMs) and lands in the
  // cache, so the same search a minute later answers at once. The Archive is asked the same way.
  const searching = new Map();
  async function waiting(source, words, stop) {
    const key = `${source}\n${words.toLowerCase()}`;
    let job = searching.get(key);
    if (!job) {
      job = cached(key, () => (source === "archive" ? archive(words) : openverse(words))).finally(() => searching.delete(key));
      job.catch(() => {});
      searching.set(key, job);
    }
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(SLOW), searchMs); });
    try {
      const found = await Promise.race([job, late, ...(stop ? [stop.then(() => SLOW)] : [])]);
      if (found === SLOW) throw new SoundtrackError("slow", `${NAMES[source]} is slow right now; kino keeps this search going for ${Math.round(SOUNDTRACK_LIMITS.slowSearchMs / 60000)} min: send the same search again in a minute.`);
      return found;
    } finally { clearTimeout(timer); }
  }

  // The Archive: 20 items for the words (most downloaded first), then the file lists of the first
  // 5 with a usable license, one or two tracks from each (round by round) up to 5.
  async function archive(words) {
    const params = new URLSearchParams({ q: archiveQuery(words), rows: "20", output: "json" });
    for (const field of ["identifier", "title", "creator", "licenseurl"]) params.append("fl[]", field);
    params.append("sort[]", "downloads desc");
    const json = async (response) => {
      try { return await response.json(); } catch { throw new SoundtrackError("failed", "Internet Archive did not answer with JSON."); }
    };
    const body = await json(await get(`${archiveApi}/advancedsearch.php?${params}`, SOUNDTRACK_LIMITS.slowSearchMs, "archive"));
    // Its search sometimes answers 200 with {"error": "[BACKEND_ERROR] ..."}: a failed search.
    if (body?.error) throw new SoundtrackError("failed", `Internet Archive search failed (${clean(body.error, "error").slice(0, 80)}).`);
    const items = parseArchiveSearch(body).slice(0, SOUNDTRACK_LIMITS.results);
    const lists = await Promise.all(items.map(async (item) => {
      try { return parseArchiveFiles(item, await json(await get(`${archiveApi}/metadata/${item.identifier}/files`, searchMs, "archive")), words).slice(0, 2); }
      catch { return []; }
    }));
    const found = [];
    for (let round = 0; round < 2; round += 1) for (const list of lists) if (list[round] && found.length < SOUNDTRACK_LIMITS.results) found.push(list[round]);
    return found;
  }

  async function openverse(words) {
    const url = `${api}?${new URLSearchParams({ q: words, category: "music", license_type: "commercial,modification", page_size: "20", mature: "false" })}`;
    const response = await get(url, SOUNDTRACK_LIMITS.slowSearchMs);
    let body;
    try { body = await response.json(); }
    catch { throw new SoundtrackError("failed", "Openverse did not answer with JSON (a browser check on this network, most likely)."); }
    return parseOpenverseMusic(body).slice(0, SOUNDTRACK_LIMITS.results);
  }

  /**
   * Candidates for the words from each source; a source that cannot answer adds a line why. With
   * no source, Openverse, the Archive and YouTube are asked at the same time. Once one licensed
   * source has songs, the other gets graceMs more; a late or failed Openverse puts the Archive first.
   */
  async function search(text, { source } = {}) {
    const words = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, SOUNDTRACK_LIMITS.words);
    if (!words) throw new SoundtrackError("bad_input", 'soundtrack needs search: mood, genre and tempo words ("tense cinematic build, 120 bpm").');
    if (source && !["openverse", "archive", "youtube"].includes(source)) throw new SoundtrackError("bad_input", 'source is "openverse", "archive" or "youtube" (default all).');
    const asks = (name) => !source || source === name;
    let release;
    const enough = new Promise((resolve) => { release = resolve; });
    const off = (name) => ({ results: [], notes: [`${name}: off (the person turns on sound search in kino Settings).`] });
    const openverseJob = !asks("openverse") ? null : !enabled() ? Promise.resolve(off("Openverse")) : (async () => {
      const notes = [];
      try {
        let found = await waiting("openverse", words, enough);
        // Openverse matches every word, so a long ask often finds nothing: try its first two
        // mood or genre words (numbers and "bpm" left out) once.
        const short = words.split(" ").filter((word) => !/\d|^bpm$/i.test(word)).slice(0, 2).join(" ");
        if (!found.length && short && short !== words) {
          found = await waiting("openverse", short, enough);
          if (found.length) notes.push(`Openverse: nothing for all the words; these are for "${short}".`);
        }
        if (found.length && !source) setTimeout(release, graceMs).unref?.();
        return { results: found, notes, answered: true };
      } catch (error) { return { results: [], notes: [`Openverse: ${error.message}`] }; }
    })();
    const archiveJob = !asks("archive") ? null : !enabled() ? Promise.resolve(off("Internet Archive")) : (async () => {
      try {
        const found = await waiting("archive", words, source ? null : enough);
        if (found.length && !source) setTimeout(release, graceMs).unref?.();
        return { results: found, notes: found.length ? [] : ["Internet Archive: nothing for these words."] };
      } catch (error) { return { results: [], notes: [`Internet Archive: ${error.message}`] }; }
    })();
    const youtubeJob = !asks("youtube") ? null : !deps.searchYouTube ? Promise.resolve({ results: [], notes: ["YouTube: not available here."] }) : (async () => {
      // 25 asked: a genre search's first results are mostly hour-long mixes and stock uploads, and
      // with 10 asked nothing was left ("french house", "synthwave upbeat"). Nothing found is not
      // kept for a day.
      try {
        const found = await cached(`youtube2\n${words.toLowerCase()}`, async () => {
          const results = youtubeCandidates(await deps.searchYouTube(words, { count: 25 }), words).slice(0, SOUNDTRACK_LIMITS.results);
          if (!results.length) throw Object.assign(new SoundtrackError("failed", "nothing but mixes, beats and stock uploads for these words; try explore:true (songs by genre)."), { empty: true });
          return results;
        });
        return { results: found, notes: [] };
      }
      catch (error) { return { results: [], notes: [`YouTube: ${error.message}`] }; }
    })();
    const [ov, ia, yt] = await Promise.all([openverseJob, archiveJob, youtubeJob]);
    release();
    const licensed = ov?.answered ? [ov, ia] : [ia, ov];
    const parts = [...licensed, yt].filter(Boolean);
    return { query: words, results: parts.flatMap((part) => part.results), notes: parts.flatMap((part) => part.notes) };
  }

  /**
   * Songs like one YouTube song: YouTube's own mix for it (yt-dlp, metadata only), filtered as a
   * search is (youtubeCandidates), without the song itself. Cached a day like a search.
   */
  async function mix(id) {
    const videoId = YT_ID.exec(String(id ?? "").trim())?.[1];
    if (!videoId) throw new SoundtrackError("bad_input", `like is a YouTube song id (yt:<11 characters>); "${id}" is not one.`);
    if (!deps.mixYouTube) throw new SoundtrackError("failed", "YouTube: not available here.");
    return cached(`mix\n${videoId}`, async () => youtubeCandidates(await deps.mixYouTube(videoId, { count: 25 })).filter((entry) => entry.id !== `yt:${videoId}`).slice(0, SOUNDTRACK_LIMITS.mix));
  }

  function allowedFile(url) {
    const file = new URL(url);
    if (stubs.some((stub) => file.host === stub.host)) return file;
    if (file.protocol !== "https:" || !FILE_HOSTS.some((host) => file.hostname === host || file.hostname.endsWith(`.${host}`)))
      throw new SoundtrackError("refused", `The song's file is on ${file.hostname}, which kino does not download from.`);
    return file;
  }

  async function download(candidate, folder) {
    if (candidate.source === "youtube") return deps.downloadYouTube(candidate.id.slice(3), folder);
    const response = await get(allowedFile(candidate.url).href, SOUNDTRACK_LIMITS.downloadMs, candidate.source);
    // A redirect (the Archive sends one to its file server) must land on an allowed host too.
    if (typeof response.url === "string" && response.url) allowedFile(response.url);
    const limit = SOUNDTRACK_LIMITS.megabytes * 1024 * 1024;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new SoundtrackError("refused", `${candidate.id} is over ${SOUNDTRACK_LIMITS.megabytes} MB.`);
    const file = path.join(folder, `song.${candidate.filetype}`);
    await writeFile(file, bytes, { mode: 0o600 });
    return file;
  }

  /** Tempo, beat grid, loudness curve and sections of one song; one song at a time. */
  function measure(candidate) {
    if (candidate.source !== "youtube" && !enabled()) throw new SoundtrackError("sound_search_off", "Sound search is off: the person turns it on in kino Settings.");
    const job = measuring.then(async () => {
      const folder = await makeTempFolder("kino-sound-");
      try {
        const file = await download(candidate, folder);
        const { samples, sampleRate } = await deps.decode(file);
        const limited = samples.subarray(0, sampleRate * SOUNDTRACK_LIMITS.measureSeconds);
        if (!limited.length) throw new SoundtrackError("failed", "The song has no sound.");
        const beats = deps.analyze(limited, sampleRate);
        const energy = energyCurve(limited, sampleRate, 1);
        const seconds = round(limited.length / sampleRate, 1);
        // Sections from the sound (the low band and spectral novelty); the loudness curve's when the
        // song is too short for them.
        const shape = songShape(limited, sampleRate, { bpm: beats.bpm, whole: limited.length === samples.length });
        const sections = shape.sections.length ? shape.sections : songSections(energy);
        let vocals = shape.voiceGuess;
        let vocalsBy = "guess";
        if (deps.vocals) try { vocals = await deps.vocals(file, seconds); vocalsBy = "whisper"; } catch { /* whisper is not installed: the guess stays */ }
        const features = { ...shape.features, vocals: vocalShare(vocals, seconds) };
        const preview = await keepPreview(candidate, file, seconds, sections);
        // How it sounds as a CLAP embedding (backend/music-embed.mjs); left out when the model is off.
        let embedding = null;
        if (deps.embed) try { embedding = await deps.embed(limited, sampleRate); } catch { /* the old features still rank it */ }
        return { seconds, bpm: beats.bpm, ...(beats.alt ? { alt: beats.alt } : {}), confidence: beats.confidence, beats: beats.beats?.length ?? 0, energy, sections, features, vocals, vocalsBy, ...(preview ? { preview } : {}), ...(embedding ? { embedding } : {}), at: new Date(now()).toISOString() };
      } finally {
        await removeTempFolder(folder);
      }
    });
    measuring = job.catch(() => {});
    return job;
  }

  const songsFolder = path.join(directory, "songs");
  const songPath = (key) => path.join(songsFolder, `${key}.m4a`);

  /** Writes the song's preview (previewStretch) and returns {from, seconds}; null when it cannot. */
  async function keepPreview(candidate, file, seconds, sections) {
    const key = songKey(candidate.id);
    if (!deps.preview || !key) return null;
    const stretch = previewStretch(seconds, sections);
    const part = path.join(songsFolder, `${key}.part.m4a`);
    try {
      await mkdir(songsFolder, { recursive: true, mode: 0o700 });
      await deps.preview(file, part, { start: stretch.from, end: stretch.from + stretch.seconds });
      await rename(part, songPath(key));
      await prunePreviews();
      return stretch;
    } catch {
      // The numbers still count without a preview.
      await rm(part, { force: true }).catch(() => {});
      return null;
    }
  }

  /** Only the newest SOUNDTRACK_LIMITS.previews song previews stay on disk. */
  async function prunePreviews() {
    const names = (await readdir(songsFolder).catch(() => [])).filter((name) => name.endsWith(".m4a"));
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(songsFolder, name)).catch(() => null))?.mtimeMs ?? 0 })));
    const keep = new Set(dated.filter((entry) => SONG_KEY.test(entry.name.slice(0, -4))).sort((a, b) => b.at - a.at).slice(0, SOUNDTRACK_LIMITS.previews).map((entry) => entry.name));
    for (const { name } of dated) if (!keep.has(name)) await rm(path.join(songsFolder, name), { force: true }).catch(() => {});
  }

  /** A measured song's preview file (by its id or its key), or null. */
  function songFile(idOrKey) {
    const key = SONG_KEY.test(String(idOrKey ?? "")) ? String(idOrKey) : songKey(idOrKey);
    return key && existsSync(songPath(key)) ? songPath(key) : null;
  }

  /**
   * Imports a picked song into the media library with its credit: an Openverse or Archive song with
   * its license, a YouTube song whole as WAV with "license unknown" (for a private video).
   */
  async function importCandidate(candidate) {
    if (candidate.source === "youtube") {
      const folder = await makeTempFolder("kino-sound-");
      try {
        const file = await deps.downloadYouTube(candidate.id.slice(3), folder, { whole: true });
        const type = path.extname(file).slice(1).toLowerCase();
        const credit = { source: "youtube", id: candidate.id, title: candidate.title, creator: candidate.creator, page: candidate.page, license: "unknown",
          line: `"${candidate.title}" by ${candidate.creator} (${candidate.page ?? "YouTube"})`, file: `${type.toUpperCase()} from YouTube` };
        return await deps.addMedia(file, { name: `${candidate.title}.${type}`.slice(0, 200), mime: TYPES[type] ?? "audio/wav", extra: { credit } });
      } finally {
        await removeTempFolder(folder);
      }
    }
    if (!NAMES[candidate.source]) throw new SoundtrackError("refused", `${candidate.id} is not a song kino imports.`);
    if (!enabled()) throw new SoundtrackError("sound_search_off", "Sound search is off: the person turns it on in kino Settings.");
    // The license is read again: it must still allow use with credit.
    const again = candidate.source === "archive"
      ? await archiveAgain(candidate)
      : parseOpenverseMusic({ results: [await (await get(`${api}${candidate.id.slice(10)}/`)).json()] })[0];
    if (!again) throw new SoundtrackError("refused", `${candidate.id}'s license no longer allows commercial use and changes, so kino does not import it.`);
    const folder = await makeTempFolder("kino-sound-");
    try {
      const file = await download(again, folder);
      const credit = { source: again.source, id: again.id, title: again.title, creator: again.creator, page: again.page, license: again.license, licenseUrl: again.licenseUrl, line: again.credit, file: `${again.filetype.toUpperCase()} from ${again.provider}` };
      return await deps.addMedia(file, { name: `${again.title}.${again.filetype}`.slice(0, 200), mime: TYPES[again.filetype], extra: { credit } });
    } finally {
      await removeTempFolder(folder);
    }
  }

  // An Archive song with its item's license read again (metadata/<id>/metadata); null when it no
  // longer allows commercial use and changes.
  async function archiveAgain(candidate) {
    const identifier = ARCHIVE_ID.exec(candidate.id)?.[1];
    if (!identifier) return null;
    const meta = (await (await get(`${archiveApi}/metadata/${identifier}/metadata`, searchMs, "archive")).json())?.result ?? {};
    const [item] = parseArchiveSearch({ response: { docs: [{ ...meta, identifier }] } });
    if (!item) return null;
    const license = (entry) => `${entry.license}${entry.licenseUrl ? ` (${entry.licenseUrl})` : ""}`;
    return { ...candidate, license: item.license, licenseUrl: item.licenseUrl, credit: candidate.credit.replace(license(candidate), license(item)) };
  }

  /** Old cache answers and extra song previews go (called when the server starts). */
  async function sweep() {
    const folder = path.join(directory, "cache");
    for (const name of await readdir(folder).catch(() => [])) {
      const file = path.join(folder, name);
      const info = await stat(file).catch(() => null);
      if (info && now() - info.mtimeMs > SOUNDTRACK_LIMITS.cacheMs) await rm(file, { force: true });
    }
    await prunePreviews();
  }

  /**
   * A song measured before embeddings existed gets one from its kept preview (the build and drop,
   * up to 90 s); null without a preview or the model. Queued with measure: one song at a time.
   */
  function embedSaved(id) {
    const file = songFile(id);
    if (!file || !deps.embed || !deps.decode) return Promise.resolve(null);
    const job = measuring.then(async () => {
      const { samples, sampleRate } = await deps.decode(file);
      return samples.length ? deps.embed(samples, sampleRate) : null;
    });
    measuring = job.catch(() => {});
    return job;
  }

  // One genre tag's songs from ListenBrainz (cached a day): up to 40 recordings from the more
  // popular half for the tag, then their artists and titles in one metadata call. Its server
  // sometimes does not answer a connection, so a failed call is tried once more.
  async function catalog(tag) {
    const json = async (url) => {
      let response;
      try { response = await get(url, searchMs, "listenbrainz"); }
      catch (error) { if (error.code === "rate_limited") throw error; response = await get(url, searchMs, "listenbrainz"); }
      try { return await response.json(); } catch { throw new SoundtrackError("failed", "ListenBrainz did not answer with JSON."); }
    };
    return cached(`listenbrainz\n${tag}`, async () => {
      const params = new URLSearchParams({ tag, operator: "or", pop_begin: "50", pop_end: "100", count: "40" });
      const ids = parseTagRecordings(await json(`${listenbrainzApi}/lb-radio/tags?${params}`)).slice(0, 40);
      if (!ids.length) return [];
      return parseRecordings(await json(`${listenbrainzApi}/metadata/recording/?${new URLSearchParams({ recording_mbids: ids.join(","), inc: "artist" })}`), ids, tag);
    });
  }

  /**
   * Songs for each lane (EXPLORE_LANES): catalog songs from its tags, taken in turn, each found on
   * YouTube by "artist - title" (pickRecording; one yt-dlp search at a time, cached a day) until
   * `perLane` are found or perLane + 3 were tried. `skip` holds ids and "artist - title" keys
   * already kept or rejected. Each song keeps its lane and genre tag.
   */
  async function explore(lanes, { perLane = 2, skip = new Set() } = {}) {
    if (!deps.searchYouTube) throw new SoundtrackError("failed", "YouTube: not available here.");
    const results = [];
    const notes = [];
    for (const lane of lanes) {
      const lists = [];
      for (const tag of EXPLORE_LANES[lane]?.tags ?? [lane]) {
        try { lists.push(await catalog(tag)); }
        catch (error) { notes.push(`${lane} (${tag}): ${error.message}`); if (error.code === "rate_limited") break; }
      }
      const songs = [];
      for (let place = 0; songs.length < 40 && lists.some((list) => list[place]); place += 1) for (const list of lists) if (list[place]) songs.push(list[place]);
      let found = 0;
      let tried = 0;
      for (const song of songs) {
        if (found >= perLane || tried >= perLane + 3) break;
        const key = `${song.artist} - ${song.title}`.toLowerCase();
        if (skip.has(key)) continue;
        skip.add(key);
        tried += 1;
        let hit;
        try { hit = await cached(`catalog-song\n${key}`, async () => pickRecording(await deps.searchYouTube(catalogQuery(song), { count: 6 }), song)); }
        catch (error) { notes.push(`${lane}: YouTube ${error.message}`); break; }
        if (!hit || skip.has(hit.id)) continue;
        skip.add(hit.id);
        found += 1;
        results.push({ ...hit, creator: song.artist, title: song.title, lane, tags: song.tags, catalog: "ListenBrainz" });
      }
      if (!found && songs.length) notes.push(`${lane}: none of ${tried} catalog songs found on YouTube.`);
      if (!songs.length && !notes.some((line) => line.startsWith(`${lane} (`))) notes.push(`${lane}: no catalog songs for its tags.`);
    }
    return { results, notes };
  }

  return { search, mix, measure, importCandidate, sweep, songFile, embedSaved, explore };
}
