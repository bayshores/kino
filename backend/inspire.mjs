// Inspire (F3): look at how other edits are cut. kino searches YouTube with yt-dlp (no key, no
// account, no cookies), then measures each result: it downloads a small copy (360p at most, the
// first 90 s at most) into <data>/inspire/work, finds the cuts (shot-detection.mjs) and the beat
// (audio-analysis.mjs), measures its fingerprint (backend/measure: motion, camera moves, text on
// screen and how it appears, transitions, palette; Apple Vision on a Mac), keeps small frame
// strips around the moments worth seeing, and deletes the copy. What stays, in <data>/inspire:
// <video id>.json (the numbers and the fingerprint), .jpg (the thumbnail), .prints.json (one
// feature print a shot, for "how alike") and strips/<video id>/ (6 frames 240 px wide around each
// cut, motion peak and text entrance, at most 24 small JPEGs) and stills/<video id>/ (10 frames at
// the copy's own size, for judge rounds: agent/judge.mjs). The footage never goes into a project.
//
// Each project keeps its own searches (query, how many found, who searched) and saved references
// in its agent state (agent/state.mjs, the `inspire` key), so they go when the project is deleted.
//
// One measuring job runs at a time (a download, then FFmpeg twice), in a queue that can be
// cancelled. Every change is published to the dashboard: {type:"inspire", projectId, inspire}
// when a project's searches or saved list change, {type:"inspire-ref", ref} when a reference's
// measuring moves on (with its cuts and beat as soon as they are found), and
// {type:"inspire-live", live} about 4 times a second while its motion and text are read: the frame
// being measured (a small JPEG), its flow arrows and the text Vision read on it. Live frames are
// only sent, never saved.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beatFit, beatFitLine } from "./measure/beat-fit.mjs";
import { suggestStyleLines, suggestionText, typeNote } from "./measure/suggest.mjs";
import { backgroundStep, lowerIfBackground } from "./render-activity.mjs";
import { BOT_CHECK, BOT_CHECK_PAUSE_MS, botCheckError, createSlots, createYouTubeGate } from "./process-slots.mjs";
import { SEARCH_KINDS } from "./agent/actions.mjs";
import { keyframeStills, lookVector, rankLooks, sameFrames, shotMiddles } from "./look-embed.mjs";
import { junkSound, rankSounds, sfxPrompt, soundVector } from "./sfx-rank.mjs";
import { COPY_RUN, copiedRun } from "../engine/quality/rules/reference.js";
import { beatSecondsOf, numbersWithMedian, shotStats } from "../engine/footage/refPace.js";

// What a search looks for: edits, short vertical edits (YouTube Shorts) or sound effects.
export { SEARCH_KINDS };
/** Results a search asks for, unless told otherwise, and the most it may ask for. */
export const SEARCH_COUNT = 8;
export const MAX_SEARCH_COUNT = 20;
/** The part of each video kino measures, and the tallest picture it downloads. */
export const MEASURE_SECONDS = 90;
export const MAX_HEIGHT = 360;
/** A cut is on the beat when it is at most this far from one (two frames at 24 fps). */
export const ON_BEAT_SECONDS = 0.08;
/** The longest query kept. */
export const MAX_QUERY_LENGTH = 120;
/** Searches a project keeps (oldest dropped first) and references it may save. */
export const MAX_SEARCHES = 30;
export const MAX_SAVED = 100;
// Saved with the numbers, so a better measure can tell old results apart. 2 adds the fingerprint
// and the frame strips; 3 reads 2-frame shots, flashes and the cut-to-beat statistics (beat-fit.mjs).
// A reference measured at an older version is measured again when an agent reads it.
export const INSPIRE_VERSION = 3;
/** The shortest shot a reference keeps, in frames: an edit cut in 2-frame shots keeps every cut. */
export const REFERENCE_MIN_SHOT_FRAMES = 2;
// Saved with the stills: 1 is one still a second (measure/stills.mjs); older saves kept 10 spread.
const STILLS_EACH = 1;

/** Live frames: at most one this often (ms), this wide (px). */
export const LIVE_EVERY_MS = 250;
export const LIVE_WIDTH = 320;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const THUMB_HOST = "i.ytimg.com";
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

/** The yt-dlp kino runs: KINO_YTDLP, else Homebrew's, else the one on the PATH. */
export function ytDlpCommand(env = process.env, exists = existsSync) {
  if (env.KINO_YTDLP) return env.KINO_YTDLP;
  return ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"].find((candidate) => exists(candidate)) ?? "yt-dlp";
}

// The bot check and its pause live in process-slots.mjs (one gate for every YouTube download).
export { BOT_CHECK, BOT_CHECK_PAUSE_MS };

// The folders kino looks in for yt-dlp's helpers when the PATH it was started with is short (the
// Mac app's is): Homebrew, /usr/local, and the usual per-user install folders.
const TOOL_FOLDERS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".deno/bin"), path.join(os.homedir(), ".bun/bin"), path.join(os.homedir(), ".local/bin")];
/** yt-dlp's JavaScript runtimes kino uses, in its order: deno, else node, else bun. */
export const JS_RUNTIMES = ["deno", "node", "bun"];

/** The PATH yt-dlp runs with: kino's own, then the usual install folders. */
export function toolPath(env = process.env) {
  return [...new Set([...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...TOOL_FOLDERS])].join(path.delimiter);
}

/**
 * The JavaScript runtime yt-dlp needs to answer YouTube's challenge: {name, path}, or null.
 * KINO_YTDLP_JS names one ("node:/path/to/node", or just a path); else the first of deno, node,
 * bun on the PATH or in the usual folders; else this process's own node (not Electron's).
 */
export function jsRuntime(env = process.env, exists = existsSync, ownNode = process.versions.electron ? null : process.execPath) {
  const wanted = env.KINO_YTDLP_JS;
  if (wanted) {
    const named = /^(deno|node|bun|quickjs):(.+)$/.exec(wanted);
    if (named) return { name: named[1], path: named[2] };
    return { name: JS_RUNTIMES.find((name) => path.basename(wanted).startsWith(name)) ?? "node", path: wanted };
  }
  const folders = toolPath(env).split(path.delimiter);
  for (const name of JS_RUNTIMES) {
    for (const folder of folders) {
      const candidate = path.join(folder, name);
      if (exists(candidate)) return { name, path: candidate };
    }
  }
  return ownNode ? { name: "node", path: ownNode } : null;
}

export const NO_JS_RUNTIME = "yt-dlp needs a JavaScript runtime (deno, node or bun) to download from YouTube, and kino found none. Install deno (brew install deno) or set KINO_YTDLP_JS to one.";

export const NO_YTDLP = "yt-dlp is not installed, so kino cannot search YouTube. Install it (brew install yt-dlp) or set KINO_YTDLP to its path.";

/**
 * A reference id ("yt:" and the 11-character video id) from what an agent or person typed: the id,
 * yt:<id>, or a youtube.com / youtu.be link. null when it is none of these.
 */
export function refId(text) {
  const value = String(text ?? "").trim();
  if (VIDEO_ID.test(value)) return `yt:${value}`;
  if (value.startsWith("yt:") && VIDEO_ID.test(value.slice(3))) return value;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!isYouTubeUrl(url.href)) return null;
  // A slash at the end (youtube.com/shorts/<id>/) is dropped.
  const id = (url.hostname === "youtu.be" ? url.pathname.slice(1)
    : url.pathname.startsWith("/shorts/") ? url.pathname.slice(8)
      : url.searchParams.get("v"))?.replace(/\/$/, "");
  return VIDEO_ID.test(id ?? "") ? `yt:${id}` : null;
}

/** True for an https link to youtube.com or youtu.be (the only pages "open the source" opens). */
export function isYouTubeUrl(text) {
  let url;
  try { url = new URL(String(text)); } catch { return false; }
  return url.protocol === "https:" && ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname) && !url.username && !url.password;
}

export const CLOSED_PLATFORM = "TikTok and Instagram need a faked browser or a login to read, which kino never does; paste a YouTube Shorts link instead, or search with kind:\"shorts\".";

/**
 * True when the text holds a TikTok, Instagram or Douyin link (kino never reads those), with or
 * without https:// and a port. Without https:// a path must follow, so "tiktok.com style" is words.
 */
export function closedPlatform(text) {
  const value = String(text ?? "");
  const host = String.raw`(?:[\w-]+\.)*(?:tiktok\.com|instagram\.com|instagr\.am|douyin\.com)(?::\d+)?`;
  return new RegExp(String.raw`\bhttps?:\/\/${host}(?:[/?#]|\s|$)`, "i").test(value)
    || new RegExp(String.raw`(?:^|[\s(])${host}\/\S`, "i").test(value);
}

const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const shortsUrl = (videoId) => `https://www.youtube.com/shorts/${videoId}`;

/** A Short is at most this long (s) when its link does not say it is one. */
export const SHORT_SECONDS = 60;

// True when yt-dlp's entry is a vertical Short: a /shorts/ link (a search), media_type "short" or
// a picture taller than wide (a full description).
function isVertical(entry) {
  try { if (new URL(entry.url).pathname.startsWith("/shorts/")) return true; } catch { /* no link */ }
  if (entry.media_type === "short") return true;
  return Number(entry.height) > 0 && Number(entry.width) > 0 && Number(entry.height) > Number(entry.width);
}

// The largest thumbnail on i.ytimg.com up to 720 wide; else the one every video has. A Short gets
// its tall first frame (frame0.jpg, 9:16, the picture YouTube's own Shorts grid shows).
function thumbnailUrl(entry, vertical = false) {
  if (vertical) return `https://${THUMB_HOST}/vi/${entry.id}/frame0.jpg`;
  const list = (Array.isArray(entry.thumbnails) ? entry.thumbnails : [])
    .filter((thumb) => { try { return new URL(thumb.url).hostname === THUMB_HOST; } catch { return false; } })
    .filter((thumb) => !thumb.width || thumb.width <= 720)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return list[0]?.url ?? `https://${THUMB_HOST}/vi/${entry.id}/hqdefault.jpg`;
}

/** A search result under this many views is doubtful, unless its channel is verified. */
export const FEW_VIEWS = 1000;
// Words that say a video was made by an AI generator ("AI generated", "made with AI", "#aiart",
// "Sora 2", "Kling AI"). A tool's own name alone (Sora, Runway) is also a person or a word, so
// those count only next to "AI", a version or as a hashtag.
const AI_MADE = /(?:^|[^\p{L}\p{N}])(?:#?ai[\s_-]?(?:generated|art|video|videos|animation|film|movie|music|song|voice|cinematic|short|trailer)s?|#ai|(?:made|created|generated|animated) (?:with|by|using|in) (?:an )?ai|(?:openai )?sora ?2|#sora|kling(?: ai| ?[0-9])|#kling|runway ?(?:ml|gen|ai)|midjourney|stable diffusion|veo ?[23]|#veo|hailuo|pika ?labs|luma (?:ai|dream machine)|pixverse|invideo|heygen|hedra|synthesia|suno(?: ai|\.com)|#suno|udio(?: ai|\.com)|elevenlabs)(?=$|[^\p{L}\p{N}])/iu;
// A hashtag in any script: "#edit", "#モーション".
const HASHTAG = /#[^\s#]+/gu;
// A title written to sell a service in search: "Best SaaS Product Launch Ad Video", or 3+ parts split by "|".
const SEO_TITLE = /\bbest\b.*\b(?:videos?|ads?|animations?|explainers?|promos?)\b/i;
// A template shop's or stock library's upload: made to be sold and reused, not an edit to learn from.
const TEMPLATE = /\b(?:templates?|mogrt|envato|videohive|motion ?array|motion ?elements|placeit|renderforest|(?:after effects|premiere pro|final cut|davinci resolve|capcut|canva) (?:project|preset|pack)|free download|download (?:link|free))\b/i;
const STOCK = /\b(?:stock (?:footage|video|animation)s?|shutterstock|pond5|storyblocks|adobe stock|istock|royalty[ -]free|no copyright)\b/i;
// A lesson about making edits, not an edit: "Typography Tutorial", "How To Make ...".
const TUTORIAL = /\b(?:tutorials?|how to (?:make|create|animate|edit|design|do)|step[ -]by[ -]step|for beginners|course|lesson)\b/i;
/** A video shorter than this (seconds) is too short to learn a cut from. */
export const VERY_SHORT = 6;
/** Most results kept from one channel before the rest drop below other channels' results. */
export const PER_CHANNEL = 2;

/**
 * Why a search result is doubtful as a reference to learn from, or "" when it is not: "ai title" or
 * "ai description" (says it was made by an AI generator), "hashtags" (4 or more in the title), "seo title"
 * (a title written to sell a service, such as "Best SaaS Ad Video"), "tutorial" (a lesson, not an edit), "template" or "stock" (a template shop's
 * or stock library's words in the title or description), "few views" (under FEW_VIEWS, channel not
 * verified) and "very short" (under VERY_SHORT seconds). Only these signals count, never the
 * language, script or country.
 */
export function doubtOf({ title = "", description = "", views, verified = false, duration } = {}) {
  const doubts = [];
  if (AI_MADE.test(title)) doubts.push("ai title");
  else if (AI_MADE.test(description)) doubts.push("ai description");
  if ((String(title).match(HASHTAG) ?? []).length >= 4) doubts.push("hashtags");
  if (SEO_TITLE.test(title) || String(title).split("|").length >= 4) doubts.push("seo title");
  if (TUTORIAL.test(title)) doubts.push("tutorial");
  if (TEMPLATE.test(title) || TEMPLATE.test(description)) doubts.push("template");
  else if (STOCK.test(title) || STOCK.test(description)) doubts.push("stock");
  if (Number.isFinite(views) && views < FEW_VIEWS && !verified) doubts.push("few views");
  if (Number.isFinite(duration) && duration < VERY_SHORT) doubts.push("very short");
  return doubts.join(", ");
}

// Measured doubts (kino's own numbers of the video, not its title): a patch or line that stays in
// place this share of the video or more, fewer cuts a second than RAW_CUTS over RAW_SECONDS or
// more, text on screen this share with this share of it on a plain background, and a length.
export const STAYS_SHARE = 0.6;
export const RAW_CUTS = 0.08;
export const RAW_SECONDS = 15;
export const PLAIN_TEXT = { share: 0.5, onPlain: 0.6 };
export const COMPILATION_SECONDS = 600;

/**
 * Why a measured reference is doubtful from its own frames, or "": "a patch stays in place 92%
 * (a watermark or another app's frame?)", "almost no cuts (a raw clip, not an edit?)", "mostly text
 * on a plain background", "compilation length". Each is a reason to look before saving, never a
 * ban: an edit may keep a frame or hold one shot on purpose.
 */
export function measuredDoubt(ref) {
  const doubts = [];
  const fp = ref?.fingerprint;
  const stays = (fp?.persistent ?? []).filter((item) => item.share >= STAYS_SHARE).sort((a, b) => b.share - a.share)[0];
  if (stays) doubts.push(`${stays.kind === "text" ? `"${String(stays.text).slice(0, 20)}"` : "a patch"} stays in place ${Math.round(stays.share * 100)}% (a watermark or another app's frame?)`);
  const numbers = ref?.numbers;
  if (numbers?.seconds >= RAW_SECONDS && (numbers.shots <= 2 || numbers.cutsPerSecond < RAW_CUTS)) doubts.push("almost no cuts (a raw clip, not an edit?)");
  if (fp?.text?.share >= PLAIN_TEXT.share && fp.text.onPlain >= PLAIN_TEXT.onPlain) doubts.push("mostly text on a plain background");
  if (ref?.duration >= COMPILATION_SECONDS) doubts.push("compilation length");
  return doubts.join(", ");
}

/**
 * How a result fits the video being made (`plan`: {seconds, vertical}), or "": "3:08 for a 20 s
 * edit: name the stretch you take" (over 3 times as long), "0:05 for a 30 s edit: one moment, not
 * the whole" (under a third), "wide for a 9:16 edit: take pacing or type, not framing" (and the
 * other way round). Nothing when the plan's length and shape are unknown.
 */
export function fitNote(ref, plan = {}) {
  const notes = [];
  const seconds = Number(plan.seconds);
  const length = Number(ref?.duration);
  if (seconds > 0 && length > 0) {
    if (length > 3 * seconds && length - seconds >= 20) notes.push(`${clock(length)} for a ${Math.round(seconds)} s edit: name the stretch you take`);
    else if (length < seconds / 3) notes.push(`${clock(length)} for a ${Math.round(seconds)} s edit: one moment, not the whole`);
  }
  if (plan.vertical === true && !ref?.vertical) notes.push("wide for a 9:16 edit: take pacing or type, not framing");
  else if (plan.vertical === false && ref?.vertical) notes.push("9:16 for a wide edit: take pacing or type, not framing");
  return notes.join("; ");
}

/** The longest take a save keeps (characters). */
export const TAKE_LIMIT = 160;
/** A save's take, cleaned: one line, at most TAKE_LIMIT characters; "" when none. */
export const cleanTake = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, TAKE_LIMIT);

/**
 * Search results best first, at most `wanted`. Clean results come first, then doubtful ones, and
 * ones made with AI last, so a doubtful one shows only when too few clean ones were found. Within
 * each group, the score is log10(views) (unknown views count as FEW_VIEWS), plus 1 for a verified
 * channel, minus 0.15 a place down YouTube's own list (so how well it matches the words still
 * counts: ten times the views is worth about 7 places). A channel's results past PER_CHANNEL go last.
 */
export function rankResults(results, wanted = results.length) {
  const group = (result) => (/\bai\b/.test(result.doubt ?? "") ? 2 : result.doubt ? 1 : 0);
  const score = (result, place) => Math.log10((result.views ?? FEW_VIEWS) + 1) + (result.verified ? 1 : 0) - 0.15 * place;
  const order = (items) => items.sort((a, b) => a.group - b.group || b.score - a.score);
  const ranked = order(results.map((result, place) => ({ result, group: group(result), score: score(result, place) })));
  // One channel fills at most PER_CHANNEL places while other channels have results.
  const shown = new Map();
  for (const item of ranked) {
    const key = item.result.channel || item.result.id;
    shown.set(key, (shown.get(key) ?? 0) + 1);
    if (shown.get(key) > PER_CHANNEL) item.group += 3;
  }
  return order(ranked)
    .slice(0, Math.max(0, wanted))
    .map((item) => item.result);
}

// ---- results that are not edits to learn from (plain text rules, no language model) -----------
// A result longer than FAR_LONGER times the video being made (and over LONG_ENOUGH seconds, so a
// very short video still keeps a minute-long edit) is not an edit of that kind: 15 s keeps a 113 s
// edit and drops a 15 minute mix.
export const FAR_LONGER = 10;
export const LONG_ENOUGH = 90;
// A release of a song (not an edit made from it) has one of these in its title, or an auto-made
// "- Topic" channel; any word that marks an edit keeps a result even then ("song edit, official
// audio"). Style and technique words (lyric, visualizer, slowed, mix) never drop a result.
const SONG_UPLOAD = /\b(?:official audio|full album)\b/i;
const EDIT_WORD = /\b(?:edits?|amv|fmv|montage|trailer|tribute|fan ?made|clips?|scenes?|shorts?|reel|moments|twixtor|transitions?)\b/i;

/**
 * Why a search result is dropped before it is shown, or null when it stays: "over N s (the video is
 * S s)" when it is far longer than the video being made (`seconds`, when known), or "song uploads"
 * when its title says "official audio" or "full album", or its channel is a "- Topic" channel, and
 * no word marks an edit. Low views alone never drop one.
 */
export function dropReason(result, { seconds } = {}) {
  const limit = Number.isFinite(seconds) && seconds > 0 ? Math.max(LONG_ENOUGH, Math.round(FAR_LONGER * seconds)) : null;
  if (limit && result.duration > limit) return `over ${limit} s (the video is ${Math.round(seconds)} s)`;
  const title = String(result.title ?? "");
  if (EDIT_WORD.test(title)) return null;
  if (SONG_UPLOAD.test(title) || / - topic$/i.test(String(result.channel ?? ""))) return "song uploads";
  return null;
}

/** The results that stay, how many were dropped for each reason, and the dropped ones: { kept, dropped: {reason: count}, items: [{id, title, reason}] }. */
export function dropNonEdits(results, { seconds } = {}) {
  const dropped = {};
  const items = [];
  const kept = results.filter((result) => {
    const reason = dropReason(result, { seconds });
    if (reason) { dropped[reason] = (dropped[reason] ?? 0) + 1; items.push({ id: result.id, title: String(result.title ?? ""), reason }); }
    return !reason;
  });
  return { kept, dropped, items };
}

/**
 * "Dropped 2: 1 over 150 s (the video is 15 s), 1 song uploads. First: "Title" yt:abc, ...", or ""
 * when none were dropped. `items` (from dropNonEdits) names up to 3, so a wrong drop can be seen
 * and the result opened with name:"yt:<id>".
 */
export function droppedText(dropped = {}, items = []) {
  const entries = Object.entries(dropped).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const first = items.slice(0, 3).map((item) => `"${item.title.slice(0, 40)}" ${item.id}`).join(", ");
  return `Dropped ${entries.reduce((sum, [, count]) => sum + count, 0)}: ${entries.map(([reason, count]) => `${count} ${reason}`).join(", ")}.${first ? ` First: ${first}.` : ""}`;
}

// Words that say nothing about what a title shows.
const COMMON_WORDS = new Set(("the and for with from this that into your you are was were his her their its our not but all can has have had out one two new how why what who when where than then them they she him very more most "
  + "just over under about after before also only like make made video videos edit edits amv fmv official full part audio lyrics lyric feat").split(" "));
// A word with an apostrophe (a contraction) says nothing about what a title shows either.
// Styled letters (bold or script Unicode) read as plain ones.
const titleWords = (text) => (String(text ?? "").normalize("NFKC").toLowerCase().match(/\p{L}[\p{L}\p{N}'’]*/gu) ?? []).filter((word) => !/['’]/.test(word));

/**
 * Words that many of the shown titles share and the search itself does not have: [{word, count}],
 * at most 4, most shared first. A word counts when it is in at least a third of the titles and in
 * at least 3 of them (a title counts a word once). Common words and words under 3 letters are left out.
 * `dropped` is the dropped results ({title}): their titles count too, so a drop for length cannot
 * hide the word most titles share.
 */
export function sharedWords(results, query = "", dropped = []) {
  const titles = [...results, ...dropped];
  if (titles.length < 3) return [];
  const own = new Set(titleWords(query));
  const counts = new Map();
  for (const result of titles) {
    for (const word of new Set(titleWords(result.title))) {
      if (word.length >= 3 && !COMMON_WORDS.has(word) && !own.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const need = Math.max(3, Math.ceil(titles.length / 3));
  return [...counts].filter(([, count]) => count >= need).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([word, count]) => ({ word, count }));
}

/** The one line for sharedWords: `shared: "stairs" in 5 of 9 titles, "climbs" in 3. If one names something you could film: ...`, or "". */
export function sharedLine(results, query = "", dropped = []) {
  const shared = sharedWords(results, query, dropped);
  if (!shared.length) return "";
  const words = shared.map(({ word, count }, index) => `"${word}" in ${count}${index ? "" : ` of ${results.length + dropped.length} titles`}`).join(", ");
  return `shared: ${words}. If one names something you could film: library {topic:"footage", search:"<that word>"}.`;
}

// ---- the origin of the ask: what the video's subject is known for ----------------------------
// The person's subject words (the brief's `about` quote) are searched once, at any length, and the
// words the relevant titles share are the origin: what the subject is known for, which the ask
// itself may never say. Only titles that carry the subject count, so an unrelated hit adds nothing.
export const ORIGIN_QUERY_LENGTH = 40;
export const ORIGIN_MIN_TITLES = 6;
export const ORIGIN_SHARE = 0.4;
// A word in fewer titles still counts when the most viewed results carry it: the thing a subject is
// known for is often one much-watched upload and a few copies of it.
export const ORIGIN_VIEWED = 5;
export const ORIGIN_VIEWED_IN = 3;
export const ORIGIN_VIEWED_SHARE = 0.25;
export const ORIGIN_TOP = 3;
export const ORIGIN_MAX_WORDS = 4;
// Words that name the kind of upload, not what it shows.
const UPLOAD_WORDS = new Set("vlog playlist compilation gameplay episode season dub sub hour slowed reverb remix version".split(" "));
// "stairs" and "stair" are one word; "glass" keeps its s.
const stem = (word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** The subject words as a search, at most ORIGIN_QUERY_LENGTH characters, cut between words. */
export function originQuery(text) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim();
  if (words.length <= ORIGIN_QUERY_LENGTH) return words;
  const cut = words.slice(0, ORIGIN_QUERY_LENGTH);
  return (cut.includes(" ") && words[ORIGIN_QUERY_LENGTH] !== " " ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim();
}

// Words that name the kind of video, not what it shows (COMMON_WORDS has edit, video, amv).
const KIND_WORDS = new Set("trailer clip clips short shorts promo reel reels montage teaser ad ads mmv tribute".split(" "));
export const ORIGIN_PHRASE_WORDS = 6;
const CLAUSE_END = /[.!?;:,]["'”’)\]]*$/;

/**
 * The quote with the words beside it in the person's message, as a second origin search ("keeper
 * lantern ladder"), or "" when there is none. A subject often comes with what it is known for
 * ("keeper lantern ladder edit"), and the title words of a search that has both are shared by far
 * more results than a search of the name alone. `asks` are the person's messages; the first one
 * that has the quote's words in a row is read. Up to ORIGIN_PHRASE_WORDS words in all are taken:
 * the words after the quote first, and the words before it only when none follow. A word must be
 * letters only (no digits, links, handles or emails) and at least 3 letters, and the reading stops
 * at a sentence or clause mark, a line break, or a common, upload or video-kind word. Only these
 * words leave the machine, never the message.
 */
export function originPhrase(quote, asks = []) {
  const subject = titleWords(quote);
  if (!subject.length || subject.length >= ORIGIN_PHRASE_WORDS) return "";
  const wordOf = (token) => token.normalize("NFKC").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/, "");
  const usable = (word) => /^\p{L}+$/u.test(word) && word.length >= 3 && !COMMON_WORDS.has(word) && !UPLOAD_WORDS.has(word) && !KIND_WORDS.has(word);
  for (const ask of asks) {
    const tokens = String(ask ?? "").split(/\r?\n/).flatMap((line) => {
      const parts = line.split(/\s+/).filter(Boolean);
      return parts.map((text, k) => ({ word: wordOf(text), end: k === parts.length - 1 || CLAUSE_END.test(text) }));
    });
    const at = tokens.findIndex((_, k) => subject.every((word, j) => tokens[k + j]?.word === word));
    if (at < 0) continue;
    const room = ORIGIN_PHRASE_WORDS - subject.length;
    const after = [];
    for (let k = at + subject.length; k < tokens.length && after.length < room && tokens[k - 1].end === false && usable(tokens[k].word); k++) {
      after.push(tokens[k].word);
      if (tokens[k].end) break;
    }
    const before = [];
    if (!after.length) {
      for (let k = at - 1; k >= 0 && before.length < room && !tokens[k].end && usable(tokens[k].word); k--) before.unshift(tokens[k].word);
    }
    const phrase = [...before, ...subject, ...after];
    return phrase.length > subject.length ? originQuery(phrase.join(" ")) : "";
  }
  return "";
}

/**
 * What the results say the subject is known for: { words: [{word, count, of}], top: [{id, title,
 * views, seconds}] }. `about` is the brief's about line ({text, quote}). A result is relevant when
 * its title has 2 or more of the quote's words (all of them when it has 1 or 2), or has one of them
 * and shares another word with such a title (titles shorten names: a quote of three words is often
 * one word in the title of the upload it is known for). Plurals count as one word. A word is an
 * origin word when it is in 3 or more of at least ORIGIN_MIN_TITLES relevant titles, and either in
 * ORIGIN_SHARE of them, or in ORIGIN_VIEWED_SHARE of them and in ORIGIN_VIEWED_IN of the
 * ORIGIN_VIEWED most viewed. Words in the quote or the person's words (`ask`: their messages),
 * common words, edit words and upload words are never origin words. `top` is the ORIGIN_TOP most
 * viewed relevant results, whatever their length. Under ORIGIN_MIN_TITLES relevant titles there
 * are no words.
 */
export function originOf(results, about, { ask = [] } = {}) {
  const quote = String(about?.quote ?? about?.text ?? "");
  const subject = new Set(titleWords(quote).filter((word) => word.length >= 3 && !COMMON_WORDS.has(word)).map(stem));
  const said = new Set([...subject, ...[about?.text, ...ask].flatMap((text) => titleWords(text).map(stem))]);
  const counts = (word) => word.length >= 3 && !COMMON_WORDS.has(word) && !EDIT_WORD.test(word) && !UPLOAD_WORDS.has(word) && !said.has(word);
  const rows = results.map((result) => {
    const stems = [...new Set(titleWords(result.title).map(stem))];
    return { result, stems, hits: stems.filter((word) => subject.has(word)).length };
  });
  const need = Math.min(2, subject.size);
  const core = need ? rows.filter((row) => row.hits >= need) : [];
  const coreWords = new Set(core.flatMap((row) => row.stems.filter(counts)));
  const relevant = [...core, ...rows.filter((row) => need && row.hits >= 1 && row.hits < need && row.stems.some((word) => coreWords.has(word)))];
  const viewed = [...relevant].sort((a, b) => (b.result.views ?? 0) - (a.result.views ?? 0));
  const top = viewed.slice(0, ORIGIN_TOP)
    .map(({ result }) => ({ id: result.id, title: String(result.title ?? ""), views: result.views ?? 0, seconds: result.duration }));
  if (relevant.length < ORIGIN_MIN_TITLES) return { words: [], top };
  const found = new Map();
  for (const row of relevant) {
    for (const word of new Set(titleWords(row.result.title))) {
      if (!counts(stem(word))) continue;
      const entry = found.get(stem(word)) ?? found.set(stem(word), { titles: new Set(), forms: new Map() }).get(stem(word));
      entry.titles.add(row);
      entry.forms.set(word, (entry.forms.get(word) ?? 0) + 1);
    }
  }
  const mostViewed = new Set(viewed.slice(0, ORIGIN_VIEWED));
  const words = [...found.values()].map(({ titles, forms }) => ({
    word: [...forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], count: titles.size, of: relevant.length,
    viewed: [...titles].filter((row) => mostViewed.has(row)).length,
  })).filter(({ count, viewed: inViewed }) => count >= 3 && (count >= ORIGIN_SHARE * relevant.length
    || (count >= ORIGIN_VIEWED_SHARE * relevant.length && inViewed >= ORIGIN_VIEWED_IN)))
    .sort((a, b) => b.viewed - a.viewed || b.count - a.count || a.word.localeCompare(b.word)).slice(0, ORIGIN_MAX_WORDS)
    .map(({ word, count, of }) => ({ word, count, of }));
  return { words, top };
}

/**
 * The results of `yt-dlp --flat-playlist --dump-json ytsearchN:…`, one JSON object a line, as
 * [{id: "yt:…", videoId, title, channel, duration, url, thumbnail, vertical?, views?, verified?,
 * doubt?}]. Live streams and premieres (no length yet) are left out, and so is anything that is not
 * a video. A vertical Short has vertical: true, its /shorts/ link and a tall thumbnail. views and
 * verified (a verified channel) are kept when YouTube says them; doubt says why it may be slop.
 */
export function parseSearchLines(text) {
  const results = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || !VIDEO_ID.test(String(entry.id ?? "")) || seen.has(entry.id)) continue;
    if (["is_live", "is_upcoming", "post_live"].includes(entry.live_status)) continue;
    const duration = Number(entry.duration);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    if (entry.url && !isYouTubeUrl(entry.url)) continue;
    seen.add(entry.id);
    const vertical = isVertical(entry);
    const title = String(entry.title ?? "").slice(0, 200);
    const views = entry.view_count == null || !Number.isFinite(Number(entry.view_count)) ? undefined : Math.max(0, Math.round(Number(entry.view_count)));
    const verified = entry.channel_is_verified === true;
    const doubt = doubtOf({ title, description: String(entry.description ?? "").slice(0, 2000), views, verified, duration });
    const followers = Number(entry.channel_follower_count);
    results.push({
      id: `yt:${entry.id}`,
      videoId: entry.id,
      title,
      channel: String(entry.channel ?? entry.uploader ?? "").slice(0, 100),
      duration: Math.round(duration),
      url: vertical ? shortsUrl(entry.id) : watchUrl(entry.id),
      thumbnail: thumbnailUrl(entry, vertical),
      ...(vertical ? { vertical: true } : {}),
      ...(views !== undefined ? { views } : {}),
      ...(verified ? { verified: true } : {}),
      ...(entry.channel_follower_count != null && Number.isFinite(followers) ? { followers: Math.round(followers) } : {}),
      ...(doubt ? { doubt } : {}),
    });
  }
  return results;
}

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The numbers kino shows for a measured video, from its cut times and beats (seconds) over the
 * `seconds` it measured: shots, cuts a second, the longest shot and where it is, and which cuts are
 * on the beat (null when no steady beat was found). median: the median shot in seconds (a mean is
 * skewed by one long shot); medianBeats: {exact, near, beatSeconds}, the median shot in beats of the
 * reference's own sound (near is the nearest of 1, 2, 4, 8), null without a beat. steady: false when
 * the sound's beat grid is unsure (a voice or noise gets one too): the median is then kept in
 * seconds only, never in made-up beats. beatFit: the cuts against the beat in frames at
 * `fps`, with a random baseline (beat-fit.mjs; null without a beat); flashes: how many were found.
 */
export function measureNumbers({ cuts, beats, seconds, fps = 24, flashes = 0, steady = true }) {
  const length = Math.max(0, Number(seconds) || 0);
  const times = [...new Set((cuts ?? []).filter((time) => Number.isFinite(time) && time > 0 && time < length).map((time) => round(time, 3)))].sort((a, b) => a - b);
  const edges = [0, ...times, length];
  let longest = { seconds: 0, start: 0, index: 0 };
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const span = edges[index + 1] - edges[index];
    if (span > longest.seconds + 1e-9) longest = { seconds: span, start: edges[index], index };
  }
  const shots = edges.length - 1;
  const where = shots === 1 ? "the whole clip" : longest.index === 0 ? "the start" : longest.index === shots - 1 ? "the end" : null;
  const beatList = Array.isArray(beats) ? beats.filter(Number.isFinite).sort((a, b) => a - b) : [];
  let onBeat = null;
  if (beatList.length) {
    let cursor = 0;
    onBeat = times.map((time) => {
      while (cursor + 1 < beatList.length && beatList[cursor + 1] <= time) cursor += 1;
      const near = Math.min(Math.abs(beatList[cursor] - time), Math.abs((beatList[cursor + 1] ?? Infinity) - time));
      return near <= ON_BEAT_SECONDS + 1e-9;
    });
  }
  // The mean cuts a second is skewed by one long shot, so the median shot is kept too (in beats when
  // the reference's own sound gave a beat). No audio, no beat: medianBeats is null.
  const { median, medianBeats } = shotStats(times, length, steady ? beatSecondsOf(beatList) : null);
  return {
    seconds: round(length),
    shots,
    cuts: times,
    cutsPerSecond: length > 0 ? round(times.length / length) : 0,
    median,
    medianBeats,
    longest: { seconds: round(longest.seconds, 1), start: round(longest.start, 1), where },
    onBeat,
    onBeatCount: onBeat ? onBeat.filter(Boolean).length : null,
    beatFit: beatFit(times, beatList, { fps: fps > 0 ? fps : 24 }),
    flashes,
    fps: fps > 0 ? round(fps, 3) : 24,
  };
}

/** Sound effects: results a sounds search asks for, the longest kept, the part measured, the bars kept. */
export const SOUND_SEARCH_COUNT = 12;
// Extra results asked of YouTube, so the junk filter still leaves SOUND_SEARCH_COUNT.
const SOUND_SEARCH_SPARE = 8;
export const MAX_SOUND_SECONDS = 60;
export const SOUND_PEAKS = 64;
// A 10 ms window is sound when it is louder than this far under the loudest window (and -60 dBFS).
const SOUND_FLOOR_DB = -45;
const SOUND_WINDOW_SECONDS = 0.01;

/**
 * The shape of a sound effect from its mono samples (the first MAX_SOUND_SECONDS): where the sound
 * is (start and end in seconds, silence before and after left out), its length, SOUND_PEAKS bars
 * over that stretch (0..1, the loudest is 1) and when its loudest moment comes, in seconds from
 * start. Throws when it is silent.
 */
export function soundShape(samples, sampleRate) {
  const total = Math.min(samples.length, Math.round(MAX_SOUND_SECONDS * sampleRate));
  const window = Math.max(1, Math.round(SOUND_WINDOW_SECONDS * sampleRate));
  const levels = [];
  for (let from = 0; from < total; from += window) {
    let sum = 0;
    const to = Math.min(total, from + window);
    for (let index = from; index < to; index += 1) sum += samples[index] * samples[index];
    levels.push(Math.sqrt(sum / (to - from)));
  }
  const loudest = Math.max(0, ...levels);
  if (!(loudest > 1e-4)) throw new Error("The sound is silent.");
  const floor = Math.max(loudest * 10 ** (SOUND_FLOOR_DB / 20), 10 ** (-60 / 20));
  const first = levels.findIndex((level) => level >= floor);
  const last = levels.length - 1 - [...levels].reverse().findIndex((level) => level >= floor);
  const start = first * window, end = Math.min(total, (last + 1) * window);
  const bars = new Array(SOUND_PEAKS).fill(0);
  let peak = 0, peakIndex = start;
  for (let index = start; index < end; index += 1) {
    const value = Math.abs(samples[index]);
    const bar = Math.min(SOUND_PEAKS - 1, Math.floor(((index - start) / (end - start)) * SOUND_PEAKS));
    if (value > bars[bar]) bars[bar] = value;
    if (value > peak) { peak = value; peakIndex = index; }
  }
  return {
    peaks: bars.map((value) => round(peak > 0 ? value / peak : 0, 3)),
    peakAt: round((peakIndex - start) / sampleRate, 2),
    start: round(start / sampleRate, 2),
    end: round(end / sampleRate, 2),
    length: round((end - start) / sampleRate, 2),
    onsets: countOnsets(levels.slice(first, last + 1), loudest),
  };
}

/**
 * Separate hits in a sound's 10 ms levels: a rise to half the loudest level (-6 dB) after at least
 * 50 ms under a quarter of it (-12 dB). A clean whoosh or tap is 1; a clip of several taps is more.
 */
export function countOnsets(levels, loudest) {
  let onsets = 0, quiet = 5;
  for (const level of levels) {
    if (level >= loudest * 0.5) { if (quiet >= 5) onsets += 1; quiet = 0; }
    else if (level < loudest * 0.25) quiet += 1;
  }
  return onsets;
}

// The shortest gap between two cuts a reference lends, in its frames: MIN_SHOT_FRAMES of
// shot-detection.mjs (not imported: that module loads only when a reference is measured).
const LEND_MIN_FRAMES = 6;

/**
 * The indexes of the cuts a reference lends (borrow_rhythm, the "cuts (s)" line): a cut less than
 * LEND_MIN_FRAMES frames at the reference's rate after the last one kept is left out, as the shot
 * finder drops a sliver. The 2-frame read feeds only the statistics (cuts/s, beat fit, flashes), so
 * a borrowed rhythm never copies a reference's cutting frame for frame.
 */
export function lentCuts(numbers) {
  const fps = numbers.fps > 0 ? numbers.fps : numbers.beatFit?.fps > 0 ? numbers.beatFit.fps : 24;
  const shortest = LEND_MIN_FRAMES / fps - 1e-6;
  let last = 0;
  return (numbers.cuts ?? []).flatMap((time, index) => (time - last >= shortest ? ((last = time), [index]) : []));
}

// A reference lends its pace in parts of at least this many seconds, at most LEND_PARTS of them.
const LEND_PART_SECONDS = 4;
const LEND_PARTS = 4;

/**
 * What a reference lends (borrow_rhythm): its pace per section, never its arrangement. The
 * measured stretch in up to LEND_PARTS equal parts, each with the lengths of the shots that start
 * in it (lentCuts), shortest first: [{from, to, shots: [seconds]}].
 */
export function lentSections(numbers) {
  const seconds = numbers.seconds > 0 ? numbers.seconds : 0;
  const count = Math.max(1, Math.min(LEND_PARTS, Math.floor(seconds / LEND_PART_SECONDS)));
  const starts = [0, ...lentCuts(numbers).map((index) => numbers.cuts[index])];
  const parts = Array.from({ length: count }, (_, index) => ({ from: round((index * seconds) / count), to: round(((index + 1) * seconds) / count), shots: [] }));
  starts.forEach((start, index) => {
    const part = parts[Math.min(count - 1, Math.floor((start / seconds) * count))];
    part.shots.push(round((starts[index + 1] ?? seconds) - start, 3));
  });
  for (const part of parts) part.shots.sort((a, b) => a - b);
  return parts;
}

/** "lend: 0-5 s 3 shots median 2 s · ..." (the reference answer's line). */
export function lendLine(numbers) {
  const parts = lentSections(numbers).map((part) => `${part.from}-${part.to} s ${part.shots.length} shot${part.shots.length === 1 ? "" : "s"}${part.shots.length ? ` median ${part.shots[Math.floor(part.shots.length / 2)]} s` : ""}`);
  return `lend: pace per section (${parts.join(" · ")}); avoid: its shot lengths in order (reference_closeness warns at 6 in a row)`;
}

// The same order every time for the same reference: a small linear congruential generator.
function seeded(seed) {
  let state = (Math.floor(Math.abs(seed)) % 2147483646) + 1;
  return () => (state = (state * 48271) % 2147483647) / 2147483647;
}

/**
 * Cue marks from a reference's section statistics (lentSections): each part's shot lengths in a
 * new order (the same for the same reference), `at` seconds into the scene. With `fit` the measured
 * stretch is scaled to fill `fit` seconds. `seams` (scene seconds, the song's section edges) become
 * the sections: each takes the pace of the reference part at the same place, and every seam is a
 * cut. Cuts past `length` (the scene) are left out.
 * Returns {cues: [{name: "rhythm-1", time, kind: "marker"}], dropped, scale}.
 */
export function rhythmCues(numbers, { length, fit = null, at = 0, seams = [] } = {}) {
  const seconds = numbers.seconds > 0 ? numbers.seconds : 0;
  const scale = fit && seconds > 0 ? fit / seconds : 1;
  const span = seconds * scale;
  const parts = lentSections(numbers);
  const fps = numbers.fps > 0 ? numbers.fps : 24;
  const shortest = (LEND_MIN_FRAMES / fps) * scale - 1e-6;
  const inner = [...new Set(seams.filter((time) => time > at + shortest && time < at + span - shortest).map((time) => round(time, 3)))].sort((a, b) => a - b);
  const edges = inner.length ? [at, ...inner, at + span] : parts.map((part) => at + part.from * scale).concat(at + span);
  const random = seeded(Math.round(seconds * 1000) + (numbers.cuts?.length ?? 0) * 7919);
  // A new order can still put COPY_RUN of the reference's shot lengths in its order by chance
  // (reference_closeness would warn): such a draw is drawn again, LEND_DRAWS times at most.
  const refCuts = lentCuts(numbers).map((index) => numbers.cuts[index]);
  const copies = (times) => refCuts.length > COPY_RUN && [24, 30, 60].some((rate) => copiedRun(times, refCuts, { tolerance: 1 / rate + 0.01 }));
  const plan = { at, span, scale, shortest, parts, edges, inner };
  let times = drawLentCuts(random, plan);
  for (let tries = 1; tries < LEND_DRAWS && copies(times); tries += 1) times = drawLentCuts(random, plan);
  const unique = [...new Set(times)];
  const kept = unique.filter((value) => value >= 0 && (!(length > 0) || value < length));
  return { cues: kept.map((value, index) => ({ name: `rhythm-${index + 1}`, time: value, kind: "marker" })), dropped: unique.length - kept.length, scale: round(scale, 3) };
}

const LEND_DRAWS = 8;

// One draw of rhythmCues: each section's shot lengths in a new order, cut times by time.
function drawLentCuts(random, { at, span, scale, shortest, parts, edges, inner }) {
  const times = [];
  let time = at;
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const end = edges[index + 1];
    const middle = (edges[index] + end) / 2 - at;
    const place = Math.min(parts.length - 1, Math.max(0, Math.floor((middle / Math.max(span, 1e-6)) * parts.length)));
    // A part no shot starts in (one long shot runs through it) takes the pace of the nearest that has one.
    const part = [...parts].sort((a, b) => (a.shots.length ? 0 : 1) - (b.shots.length ? 0 : 1) || Math.abs(parts.indexOf(a) - place) - Math.abs(parts.indexOf(b) - place))[0];
    const lengths = part.shots.map((shot) => shot * scale);
    if (!lengths.length) continue;
    // A new order of the part's shots, drawn again each time they run out.
    let bag = [];
    while (time + shortest < end) {
      if (!bag.length) {
        bag = [...lengths];
        for (let last = bag.length - 1; last > 0; last -= 1) {
          const pick = Math.floor(random() * (last + 1));
          [bag[last], bag[pick]] = [bag[pick], bag[last]];
        }
      }
      // The next shot that still fits before the section's end (a longer one waits for the next round).
      const pick = bag.findLastIndex((shot) => time + shot <= end - shortest);
      if (pick < 0) break;
      const next = time + bag.splice(pick, 1)[0];
      times.push(round(next, 3));
      time = next;
    }
    // A seam from the song is a cut; the reference's own part edges are not.
    if (inner.length && index + 1 < edges.length - 1) { times.push(round(end, 3)); time = end; }
  }
  return times;
}

/** "0:39", "3:12", "1:02:05" for a length in seconds. */
export function clock(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// ---- running yt-dlp ------------------------------------------------------------------------

// Never reads the person's yt-dlp config (it may name a cookie file or a browser to take
// cookies from), sends no cookies, keeps no cache.
const PRIVATE_ARGS = ["--ignore-config", "--no-cookies", "--no-cache-dir", "--no-warnings", "--no-color"];

function abortError() {
  const error = new Error("Cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Why yt-dlp can never play a video from here, from its error line: "region" (blocked in this
 * country), "members only", "age" (needs a signed-in adult) or "private"; null for anything else.
 */
export function cannotPlayReason(line) {
  const text = String(line ?? "");
  if (/in your country|from your location|geo.?restrict/i.test(text)) return "region";
  if (/members[- ]only|channel's members|join this channel/i.test(text)) return "members only";
  if (/confirm your age|age.?restrict|inappropriate for some users/i.test(text)) return "age";
  if (/private video/i.test(text)) return "private";
  return null;
}

/** The agent's line for a found clip that cannot play: `F3 cannot play from here (region). Dropped; F4 is next.` */
export function cannotPlayLine(code, reason, next) {
  return `${code} cannot play from here (${reason}). Dropped${next ? `; ${next} is next` : ""}.`;
}

/** Runs yt-dlp; resolves with its standard output. Rejects with a plain reason. */
export function runYtDlp(args, { command = ytDlpCommand(), signal, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, [...PRIVATE_ARGS, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: toolPath() } });
    lowerIfBackground(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) child.kill("SIGKILL"); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.once("error", (error) => {
      finish();
      reject(error.code === "ENOENT" ? Object.assign(new Error(NO_YTDLP), { code: "NO_YTDLP" }) : new Error(`yt-dlp could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      finish();
      if (signal?.aborted) return reject(abortError());
      if (timedOut) return reject(new Error(`yt-dlp took longer than ${Math.round(timeoutMs / 1000)} s.`));
      if (code !== 0) {
        const line = stderr.split("\n").map((text) => text.trim()).filter(Boolean).find((text) => text.startsWith("ERROR")) ?? stderr.trim().split("\n").at(-1) ?? "";
        // A video this network or this visitor can never play (region, members, age): not a bot check.
        const unplayable = cannotPlayReason(line);
        if (unplayable) return reject(Object.assign(new Error(`yt-dlp cannot play this video from here (${unplayable}).`), { code: "UNPLAYABLE", reason: unplayable }));
        // YouTube's bot check wants an account's cookies, which kino never sends.
        if (/sign in to confirm/i.test(line)) return reject(botCheckError());
        return reject(new Error(`yt-dlp failed: ${line.replace(/^ERROR:\s*/, "").slice(0, 200) || `exit code ${code}`}`));
      }
      resolve(stdout);
    });
  });
}

/** YouTube's search page with its Shorts filter on, for these words. */
export const shortsSearchUrl = (words) => `https://www.youtube.com/results?search_query=${encodeURIComponent(words)}&sp=EgIQCQ%3D%3D`;

/**
 * Searches YouTube: up to `count` results, metadata only (nothing is downloaded). With `shorts`,
 * short vertical edits: YouTube's Shorts filter first, then a plain search's /shorts/ links and
 * videos of SHORT_SECONDS or less to fill up (yt-dlp reads only part of the Shorts filter's grid).
 * Only a result with vertical: true is known to be 9:16; measuring tells the others. With `vet`, it
 * asks for twice as many (up to MAX_SEARCH_COUNT) and keeps the best by rankResults. With `dropped`
 * (an object), results that are not edits to learn from (dropReason, judged against `seconds`, the
 * length of the video being made) are left out before the best are kept, and `dropped` gets the
 * count for each reason (`droppedItems`, an array, gets each one's {id, title, reason}). When drops
 * leave fewer than wanted, a plain search asks once more for MAX_SEARCH_COUNT.
 */
export async function searchYouTube(query, { count = SEARCH_COUNT, command, signal, shorts = false, vet = false, dropped, droppedItems, seconds } = {}) {
  const words = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (!words) throw new Error("A search needs words, such as walking tour edit.");
  const wanted = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.round(count) || SEARCH_COUNT));
  const asked = vet ? Math.min(MAX_SEARCH_COUNT, wanted * 2) : wanted;
  const split = (text) => (dropped ? dropNonEdits(parseSearchLines(text), { seconds }) : { kept: parseSearchLines(text), dropped: {}, items: [] });
  const parse = (found) => {
    Object.assign(dropped ?? {}, found.dropped);
    droppedItems?.push(...found.items);
    return found.kept;
  };
  const keep = (results) => (vet ? rankResults(results, wanted) : results.slice(0, wanted));
  if (!shorts) {
    const run = async (n) => split(await runYtDlp(["--flat-playlist", "--dump-json", `ytsearch${n}:${words}`], { command, signal }));
    let found = await run(asked);
    // Drops left fewer than wanted: ask once for the most YouTube gives, and count that answer's drops.
    if (dropped && found.kept.length < wanted && found.items.length && asked < MAX_SEARCH_COUNT) found = await run(MAX_SEARCH_COUNT);
    return keep(parse(found));
  }
  const [grid, plain] = await Promise.allSettled([
    runYtDlp(["--flat-playlist", "--dump-json", "--playlist-end", String(asked), shortsSearchUrl(words)], { command, signal }),
    runYtDlp(["--flat-playlist", "--dump-json", `ytsearch${Math.min(MAX_SEARCH_COUNT, asked * 2)}:${words} shorts`], { command, signal }),
  ]);
  if (grid.status === "rejected" && plain.status === "rejected") throw grid.reason;
  const text = [grid, plain].map((answer) => (answer.status === "fulfilled" ? answer.value : "")).join("\n");
  const found = keep(parse(split(text)).filter((result) => result.vertical || result.duration <= SHORT_SECONDS));
  // Nothing left and one run failed: its error (a bot check, a 429), not a quiet "nothing found".
  const failed = [grid, plain].find((answer) => answer.status === "rejected");
  if (!found.length && failed) throw failed.reason;
  return found;
}

/** YouTube's own mix for one video (songs like it): up to `count` results, metadata only. */
export async function mixYouTube(videoId, { count = MAX_SEARCH_COUNT, command, signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  const wanted = Math.max(1, Math.min(50, Math.round(count) || MAX_SEARCH_COUNT));
  const text = await runYtDlp(["--flat-playlist", "--dump-json", "--playlist-end", String(wanted), `${watchUrl(videoId)}&list=RD${videoId}`], { command, signal });
  return parseSearchLines(text);
}

/**
 * One video's title, channel and length from yt-dlp's full description of it (--dump-json on its
 * page), as a search result. Rejects when it is not that video or has no length yet (a live
 * stream or premiere).
 */
export function parseVideoInfo(text, videoId) {
  let entry;
  try { entry = JSON.parse(String(text ?? "").trim().split("\n").at(-1)); }
  catch { throw new Error(`yt-dlp did not describe yt:${videoId}.`); }
  // A full description's url is the video file's own address; kino links the watch page instead.
  const [result] = parseSearchLines(JSON.stringify({ ...entry, url: undefined }));
  if (result?.videoId !== videoId) throw new Error(`yt:${videoId} has no length yet (a live stream or premiere), so kino cannot measure it.`);
  return result;
}

/** Reads one video's metadata from its page (nothing is downloaded), as a search result. */
export async function lookupYouTube(videoId, { command, signal } = {}) {
  if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
  // --ignore-no-formats-error: only the title and length are wanted, so a video whose formats
  // yt-dlp cannot list (YouTube's challenge) is still described.
  const text = await runYtDlp(["--no-playlist", "--skip-download", "--dump-json", "--ignore-no-formats-error", watchUrl(videoId)], { command, signal });
  return parseVideoInfo(text, videoId);
}

/** The yt-dlp arguments that download a sound effect's audio (the first MAX_SOUND_SECONDS) into `folder`. */
export function soundDownloadArgs(videoId, folder, { ffmpeg } = {}) {
  return [
    "--no-playlist", "--no-part", "--no-mtime", "--no-write-thumbnail", "--no-write-info-json",
    "-f", "ba[abr<=160]/ba/wa",
    "--download-sections", `*0-${MAX_SOUND_SECONDS}`,
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    "-o", path.join(folder, "sound.%(ext)s"),
    watchUrl(videoId),
  ];
}

/** The yt-dlp arguments that download the small copy kino measures into `folder`. */
export function downloadArgs(videoId, folder, { ffmpeg } = {}) {
  return [
    "--no-playlist", "--no-part", "--no-mtime", "--no-write-thumbnail", "--no-write-info-json",
    // One file with picture and sound, else the two merged, else the smallest. "res" is the short
    // side, so a tall Short comes down as big as a wide video (324x720, not 162x360).
    "-f", "b/bv*+ba/w", "-S", `res:${MAX_HEIGHT}`,
    "--download-sections", `*0-${MEASURE_SECONDS}`,
    ...(ffmpeg ? ["--ffmpeg-location", ffmpeg] : []),
    "--merge-output-format", "mp4",
    "-o", path.join(folder, "clip.%(ext)s"),
    watchUrl(videoId),
  ];
}

// ---- the cache and the queue ---------------------------------------------------------------

const emptyProject = () => ({ searches: [], saved: [], rejected: [], nextSearch: 1, ideas: null, nextIdeas: 1 });

/** Ideas an agent may propose from one reference, and the limits of their words. */
export const MAX_IDEAS = 6;
export const MAX_SKIPPED = 4;
const IDEA_LIMITS = { title: 60, what: 160, why: 160, use: 160, skipWhy: 120, tag: 24, note: 300 };

/**
 * An agent's ideas from one measured reference, checked and tidied: {take, skip}. take is
 * [{n, title, from, to?, what, why, use, place?, tags, on: true}], numbered 1, 2, … in time order;
 * skip is [{n, title, why, on: false}] numbered after them. `duration` is the measured stretch of
 * the reference (seconds). Throws an Error that says what to fix.
 */
export function cleanIdeas(input, duration) {
  const text = (value, limit, what) => {
    const words = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!words) throw new Error(`each idea needs ${what}`);
    if (words.length > limit) throw new Error(`${what} is at most ${limit} characters ("${words.slice(0, 40)}…" is ${words.length})`);
    return words;
  };
  const time = (value, what) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > duration + 0.5) throw new Error(`${what} is a time in the reference, 0 to ${Math.round(duration)} s (got ${JSON.stringify(value)})`);
    return round(Math.min(number, duration), 1);
  };
  const take = Array.isArray(input?.take) ? input.take : [];
  const skip = Array.isArray(input?.skip) ? input.skip : [];
  if (!take.length) throw new Error("take needs at least one idea: [{title, from, to?, what, why, use}]");
  if (take.length > MAX_IDEAS) throw new Error(`at most ${MAX_IDEAS} ideas (got ${take.length}): keep the strongest`);
  if (skip.length > MAX_SKIPPED) throw new Error(`at most ${MAX_SKIPPED} skipped (got ${skip.length})`);
  const ideas = take.map((idea) => {
    const from = time(idea?.from ?? idea?.at, "from");
    const to = idea?.to == null ? null : time(idea.to, "to");
    if (to != null && to < from) throw new Error(`to (${to}) comes before from (${from})`);
    const tags = (Array.isArray(idea?.tags) ? idea.tags : []).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4);
    for (const tag of tags) if (tag.length > IDEA_LIMITS.tag) throw new Error(`a tag is at most ${IDEA_LIMITS.tag} characters ("${tag}")`);
    let place = null;
    if (idea?.place != null) {
      const at = Number(idea.place.at), end = idea.place.to == null ? null : Number(idea.place.to);
      if (!Number.isFinite(at) || at < 0 || (end != null && (!Number.isFinite(end) || end < at))) throw new Error("place is {at, to?}: seconds in your video, to after at");
      place = { at: round(at, 1), ...(end != null ? { to: round(end, 1) } : {}) };
    }
    return { title: text(idea?.title, IDEA_LIMITS.title, "a title"), from, ...(to != null ? { to } : {}), what: text(idea?.what, IDEA_LIMITS.what, "what (what happens in the reference)"),
      why: text(idea?.why, IDEA_LIMITS.why, "why (why it is good)"), use: text(idea?.use, IDEA_LIMITS.use, "use (what it becomes in this video)"), ...(place ? { place } : {}), tags, on: true };
  }).sort((a, b) => a.from - b.from).map((idea, index) => ({ n: index + 1, ...idea }));
  const skipped = skip.map((item, index) => ({ n: ideas.length + index + 1, title: text(item?.title, IDEA_LIMITS.title, "a title"), why: text(item?.why, IDEA_LIMITS.skipWhy, "why (why it is skipped)"), on: false }));
  return { take: ideas, skip: skipped };
}

/**
 * The inspire service. deps:
 *   directory     <data>/inspire
 *   projectState  {read(projectId), update(projectId, fn)}: the project's `inspire` state
 *   publish       sends a dashboard event
 *   search        (query, {count, signal}) → results (searchYouTube)
 *   lookup        (videoId, {signal}) → one result (lookupYouTube), for a link kino has not seen
 *   download      (videoId, folder, {signal}) → the file (runs yt-dlp)
 *   findShots     (file, {duration, signal}) → {shots} (shot-detection.mjs)
 *   findBeats     (file, {signal}) → {beats, bpm} (audio-analysis.mjs)
 *   probe         (file, {signal}) → {duration}
 *   fetchThumb    (url, {signal}) → bytes
 *   fingerprint   (file, {seconds, cuts, signal}) → {fingerprint, prints} (measure/measure.mjs);
 *                 optional: without it only the cuts and the beat are measured
 *   strips        (file, moments, folder, {signal}) → [{at, kinds, file}] (measure/strips.mjs)
 *   heard         (file, {seconds, bpm, signal}) → {change: {at, kind} | null, voice: [[from, to]] | null, by}:
 *                 the loudest change of the sound and where a voice is heard (reference_range); optional
 *   encodeFrame  ({bgra, width, height}) → JPEG bytes LIVE_WIDTH wide; optional: without it the
 *                 live view gets no picture
 * Sound effects (a sounds search; optional):
 *   downloadSound (videoId, folder, {signal}) → the audio file (yt-dlp, the first 60 s)
 *   decodeSound   (file, {signal}) → {samples, sampleRate} (mono)
 *   soundPreview  (file, target, {start, end, signal}) writes that stretch as AAC mono .m4a
 *   soundLoudness (file, {signal}) → integrated LUFS or null
 *   addMedia      (file, {name, mime, extra}) → media record (import of a measured sound)
 *   embedSound    (samples, sampleRate) → {model, vector} or null (CLAP, backend/music-embed.mjs)
 *   embedText     (prompts) → [Float32Array] or null; embedModel: the model id
 *   soundTaste    {read() → {liked, rejected}} (the person's use and no on sounds)
 */
export function createInspire(deps) {
  const { directory, projectState, publish = () => {} } = deps;
  const now = deps.now ?? Date.now;
  const workRoot = path.join(directory, "work");
  const refs = new Map(); // ref id → record (memory copy of <id>.json, plus the queue state)
  const queue = []; // ref ids waiting
  let running = null; // {id, controller, phase, partial?, live?}
  const waiters = new Map(); // ref id → [resolve]
  // Ref id → how many calls wait for it now (look reference, library inspire name:"yt:...").
  const wanted = new Map();
  // Measuring is background work: each download and FFmpeg or yt-dlp step waits until no agent
  // call or render has run for a second (render-activity.mjs backgroundStep), at low priority. A
  // reference a call waits for is measured at once, at normal priority, and so is the one ahead of
  // it in the queue: that call counts as busy, so a waiting step would hold its wanted ref back.
  const step = deps.backgroundStep ?? backgroundStep;
  // YouTube downloads go through the gate kino shares with soundtrack and footage (one at a time,
  // a gap between them, and after a bot check none until its pause ends; "m" on the screen
  // (measure) forces one at once). Without one passed in, a gate of this service's own.
  const youtube = deps.youtube ?? createYouTubeGate({ gapMs: 0, now, slot: createSlots(1) });
  const downloads = new Set(["download", "downloadSound"]);
  const heavy = {};
  for (const name of ["download", "probe", "findShots", "findBeats", "heard", "fingerprint", "strips", "stills", "downloadSound", "decodeSound", "soundPreview", "soundLoudness"]) {
    if (typeof deps[name] !== "function") continue;
    const work = downloads.has(name)
      ? (videoId, folder, { force, ...options } = {}) => youtube(() => deps[name](videoId, folder, options), { force, signal: options.signal })
      : deps[name];
    heavy[name] = (...args) => step(() => work(...args), { urgent: () => wanted.size > 0, signal: running?.controller.signal });
  }
  let started = null;
  // The searches running now ("<project>/<n>"). A search saved as running that is not here was
  // cut off when kino stopped: it shows as failed.
  const inFlight = new Set();
  const forced = new Set();
  // Saved references queued only for their voice facts (measureHeardLater): tried this run, waiting.
  const heardTried = new Set();
  const heardPending = new Set();
  const heardOnly = new Set();

  // Work folders a stopped server left behind are deleted: they hold downloaded video.
  async function start() {
    started ??= (async () => {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
      await mkdir(directory, { recursive: true, mode: 0o700 });
    })();
    return started;
  }

  const fileOf = (id, ext) => path.join(directory, `${id.slice(3)}.${ext}`);
  const stripsOf = (id) => path.join(directory, "strips", id.slice(3));
  const stillsOf = (id) => path.join(directory, "stills", id.slice(3));
  const soundOf = (id) => path.join(directory, "sounds", `${id.slice(3)}.m4a`);
  const isSound = (record) => record?.kind === "sound";
  // A measured reference kept before stills were (a judge round measures it again).
  const needsStills = (record) => record?.state === "measured" && !record.stills?.length && Boolean(deps.stills);
  // A measured reference whose stills are the older 10 spread over the video, not one a second
  // (saving it again measures it again, so a board pin finds the still at its second).
  const sparseStills = (record) => record?.state === "measured" && record.stills?.length > 0 && record.stillsEach !== STILLS_EACH && Boolean(deps.stills);
  // A measured reference whose numbers come from an older measure (no fingerprint yet).
  const outdated = (record) => !isSound(record) && record?.state === "measured" && (record.version ?? 1) < INSPIRE_VERSION && Boolean(deps.fingerprint);
  // Not measured yet: a sound without its shape, a video without its numbers (or with old ones).
  const unmeasured = (record) => (isSound(record) ? !record.sound && record.state !== "failed" : (record.state !== "measured" && record.state !== "failed") || outdated(record));

  async function load(id) {
    if (refs.has(id)) return refs.get(id);
    try {
      const saved = JSON.parse(await readFile(fileOf(id, "json"), "utf8"));
      if (saved?.id === id) {
        // A measure that was running when kino stopped starts again when asked.
        const record = saved.state === "measured" || saved.state === "failed" ? saved : { ...saved, state: "found" };
        if (!refs.has(id)) refs.set(id, record);
        return refs.get(id);
      }
    } catch { /* not measured yet */ }
    return null;
  }

  async function save(record) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { phase, ...kept } = record;
    const temporary = `${fileOf(record.id, "json")}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(kept), { mode: 0o600 });
    await rename(temporary, fileOf(record.id, "json"));
  }

  /**
   * What the screen and the agent see of one reference. The screen gets a few fingerprint numbers;
   * `full` adds the whole fingerprint, the suggested lines' inputs and the strips (for agents).
   */
  function summary(record, { full = false } = {}) {
    if (!record) return null;
    const waiting = queue.indexOf(record.id);
    const measured = record.state === "measured" ? measuredDoubt(record) : "";
    return {
      id: record.id, title: record.title, channel: record.channel, duration: record.duration, url: record.url,
      thumb: Boolean(record.thumb), kind: isSound(record) ? "sound" : "video", ...(record.vertical ? { vertical: true } : {}),
      ...(record.views != null ? { views: record.views } : {}), ...(record.verified ? { verified: true } : {}), ...(record.followers != null ? { followers: record.followers } : {}),
      ...(record.doubt ? { doubt: record.doubt } : {}), ...(measured ? { measuredDoubt: measured } : {}), ...(record.same ? { same: true } : {}), ...(record.copies?.length ? { copies: record.copies } : {}),
      state: running?.id === record.id ? "measuring" : waiting >= 0 ? "queued" : isSound(record) && !record.sound && record.state === "measured" ? "found" : record.state,
      ...(running?.id === record.id ? { phase: running.phase, ...(running.partial ? { partial: running.partial } : {}) } : {}),
      ...(waiting >= 0 ? { place: waiting + 1 } : {}),
      ...(record.sound ? { sound: soundView(record.sound) } : {}),
      ...(record.numbers ? { numbers: record.numbers } : {}),
      ...(record.bpm ? { bpm: record.bpm } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.measuredAt ? { measuredAt: record.measuredAt } : {}),
      ...(record.fingerprint ? { print: screenNumbers(record.fingerprint), strips: record.strips?.length ?? 0 } : {}),
      ...(record.fingerprintError ? { fingerprintError: record.fingerprintError } : {}),
      ...(full && record.fingerprint ? { fingerprint: record.fingerprint, stripList: record.strips ?? [] } : {}),
    };
  }

  function changed(record) {
    try { publish({ type: "inspire-ref", ref: summary(record) }); } catch { /* the dashboard may be gone */ }
  }

  async function projectView(projectId) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const ids = new Set([...state.searches.flatMap((search) => search.ids ?? []), ...state.saved]);
    const refList = {};
    for (const id of ids) {
      const record = await load(id);
      if (record) refList[id] = summary(record);
    }
    const searches = [];
    for (const search of state.searches) {
      const shown = search.state === "searching" && !inFlight.has(`${projectId}/${search.n}`)
        ? { ...search, state: "failed", error: "kino stopped before this search finished" } : search;
      searches.push(search.kind === "sounds" && search.state === "done" ? { ...shown, ranks: await soundRanks(search) } : shown);
    }
    return {
      searches,
      saved: state.saved,
      // Keys the agent gave its saved references (save yt:<id> as phone-film): {"phone-film": "yt:<id>"}.
      keys: state.keys ?? {},
      // The reference an agent read last ({id, by, at}): the screen marks its tile with the bot.
      looking: state.looking ?? null,
      refs: refList,
      queue: { running: running?.id ?? null, phase: running?.phase ?? null, waiting: queue.length },
      live: running?.live ?? null,
      ideas: state.ideas ? await ideasView(state.ideas) : null,
    };
  }

  /**
   * A sounds search's ranking ({id: {match, taste, score, order, alike?, why?}}, backend/sfx-rank.mjs):
   * how each measured sound matches the search words (CLAP) and the person's taste. {} when
   * embeddings are off or nothing is measured yet.
   */
  async function soundRanks(search) {
    try {
      const entries = [];
      for (const id of search.ids ?? []) {
        const record = await load(id);
        if (record?.sound) entries.push({ id, title: record.title, vector: soundVector(record.sound, deps.embedModel), seconds: record.sound.length, onsets: record.sound.onsets });
      }
      if (!entries.some((entry) => entry.vector)) return {};
      const [query] = deps.embedText ? (await deps.embedText([sfxPrompt(search.query)])) ?? [null] : [null];
      const taste = deps.soundTaste ? await deps.soundTaste.read() : null;
      const ranked = rankSounds(entries, { query, taste, model: deps.embedModel, words: search.query });
      return Object.fromEntries(ranked.filter((row) => row.score !== null).map((row, index) => [row.id, { ...row, order: index + 1 }]));
    } catch { return {}; }
  }

  /** A measured sound as a taste entry (backend/songTaste.mjs tasteEntry reads it), or null. */
  async function soundTasteEntry(id) {
    const record = await load(id);
    if (!isSound(record) || !record.sound) return null;
    return { id, title: record.title, creator: record.channel ?? "YouTube", source: "youtube", measure: { embedding: record.sound.embedding ?? null } };
  }

  /** One search of a project ({search, ranks, results}), or null. */
  async function searchView(projectId, n) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const search = state.searches.find((item) => item.n === n);
    if (!search) return null;
    const results = [];
    for (const id of search.ids ?? []) { const record = await load(id); if (record) results.push(summary(record)); }
    return { search, ranks: search.kind === "sounds" ? await soundRanks(search) : {}, results };
  }

  // The ideas with what the screen draws them from: the reference's title, length and frame strips.
  async function ideasView(ideas) {
    const record = await load(ideas.ref);
    return { ...ideas, title: record?.title ?? ideas.ref, seconds: record?.numbers?.seconds ?? record?.duration ?? null, thumb: Boolean(record?.thumb),
      strips: (record?.strips ?? []).map((strip) => ({ at: strip.at, file: strip.file })) };
  }

  /**
   * A live frame from the measure (measure.mjs onFrame), at most one every LIVE_EVERY_MS: the
   * picture as a small JPEG, the flow arrows as fractions of the picture per sample, and the text
   * lines Vision read ({box, s}). Published, and kept as the running measure's latest.
   */
  let lastLive = 0;
  function liveFrame(record, frame) {
    if (running?.id !== record.id || now() - lastLive < LIVE_EVERY_MS) return;
    lastLive = now();
    let image = null;
    try {
      const bytes = frame.bgra && deps.encodeFrame ? deps.encodeFrame(frame) : null;
      if (bytes?.length) image = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
    } catch { /* no picture this time */ }
    const live = { id: record.id, t: round(frame.t, 2), seconds: round(frame.seconds, 2), image, flow: liveFlow(frame.flow, frame.width, frame.height),
      text: (frame.text ?? []).filter((line) => Array.isArray(line.box)).slice(0, 12).map((line) => ({ box: line.box, s: String(line.s ?? "").slice(0, 80) })) };
    running.live = live;
    try { publish({ type: "inspire-live", live }); } catch { /* the dashboard may be gone */ }
  }

  async function updateProject(projectId, change) {
    const result = await projectState.update(projectId, (current) => {
      const state = { ...emptyProject(), ...current };
      const value = change(state);
      return { state, value };
    });
    try { publish({ type: "inspire", projectId, inspire: await projectView(projectId) }); } catch { /* the dashboard may be gone */ }
    return result;
  }

  // ---- the queue -------------------------------------------------------------------------
  function enqueue(id, { first = false } = {}) {
    if (running?.id === id) return;
    const at = queue.indexOf(id);
    if (at >= 0) {
      if (!first) return;
      queue.splice(at, 1);
    }
    // A sound effect (seconds to measure) waits only behind other sounds, never behind videos.
    const sound = isSound(refs.get(id));
    const firstVideo = sound ? queue.findIndex((other) => !isSound(refs.get(other))) : -1;
    if (first) queue.unshift(id); else if (firstVideo >= 0) queue.splice(firstVideo, 0, id); else queue.push(id);
    refs.has(id) && changed(refs.get(id));
    pump();
  }

  function settle(id) {
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
  }

  function pump() {
    if (running || !queue.length) return;
    const id = queue.shift();
    const controller = new AbortController();
    running = { id, controller, phase: "fetching" };
    measure(id, controller.signal)
      .catch(() => {})
      .finally(() => {
        running = null;
        heardPending.delete(id);
        // Asked to measure again while it was finishing: it goes first.
        if (forced.has(id)) queue.unshift(id);
        if (refs.has(id)) changed(refs.get(id));
        if (!forced.has(id)) settle(id);
        pump();
      });
  }

  function setPhase(record, phase) {
    if (running?.id !== record.id) return;
    running.phase = phase;
    changed(record);
  }

  async function measure(id, signal) {
    const record = await load(id);
    if (!record) return;
    changed(record);
    await start();
    // Queued only for its voice facts (measureHeardLater): a full measure when it needs one anyway.
    if (heardOnly.delete(id) && !forced.has(id) && !isSound(record) && !unmeasured(record)) return measureHeard(record, signal);
    if (isSound(record)) return measureSound(record, signal);
    const folder = path.join(workRoot, `${record.id.slice(3)}-${randomUUID().slice(0, 8)}`);
    const force = forced.delete(id);
    try {
      if (!force && youtube.paused()) throw botCheckError();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = await heavy.download(record.id.slice(3), folder, { signal, force });
      setPhase(record, "reading cuts");
      const probed = await heavy.probe(file, { signal });
      // The downloaded picture tells a vertical edit for sure (a search only guesses from the link).
      if (probed.width > 0 && probed.height > 0) record.vertical = probed.height > probed.width;
      const seconds = Math.min(MEASURE_SECONDS, probed.duration || record.duration || 0);
      if (!(seconds > 0)) throw new Error("The download has no length.");
      const { shots, flashes, fps } = await heavy.findShots(file, { duration: seconds, signal, minShotFrames: REFERENCE_MIN_SHOT_FRAMES });
      const read = { seconds, fps: fps ?? undefined, flashes: (flashes ?? []).filter((flash) => flash.start < seconds).length };
      // The cuts are known: the screen draws them while the beat is found.
      if (running?.id === record.id) running.partial = measureNumbers({ cuts: shots.slice(1).map((shot) => shot.start), beats: [], ...read });
      setPhase(record, "finding the beat");
      let beat = null;
      try { beat = await heavy.findBeats(file, { signal }); }
      catch (error) { if (signal.aborted) throw error; /* no sound: no beat to measure */ }
      // findBeats says steady: false for a beat grid it is unsure of (a stub that says nothing is steady).
      const numbers = measureNumbers({ cuts: shots.slice(1).map((shot) => shot.start), beats: beat?.beats ?? [], steady: beat?.steady !== false, ...read });
      if (running?.id === record.id) running.partial = { ...numbers, ...(beat?.bpm ? { bpm: beat.bpm } : {}) };
      // The loudest change of the sound and where a voice plays: a failure leaves it out (never guessed).
      let heard = null;
      if (heavy.heard) {
        try { heard = await heavy.heard(file, { seconds, bpm: beat?.bpm ?? null, signal }); }
        catch (error) { if (signal.aborted) throw error; }
      }
      // The fingerprint and the strips: a failure here keeps the cuts and says what went wrong.
      let fingerprint = null, strips = [], fingerprintError = null;
      if (deps.fingerprint) {
        setPhase(record, "reading motion and text");
        try {
          const measured = await heavy.fingerprint(file, { seconds, cuts: numbers.cuts, signal, onFrame: (frame) => liveFrame(record, frame) });
          fingerprint = measured.fingerprint;
          await writeFile(fileOf(record.id, "prints.json"), JSON.stringify(measured.prints ?? []), { mode: 0o600 });
          if (deps.strips) {
            setPhase(record, "keeping frame strips");
            await mkdir(path.join(directory, "strips"), { recursive: true, mode: 0o700 });
            const { stripMoments } = await import("./measure/strips.mjs");
            strips = await heavy.strips(file, stripMoments(fingerprint, numbers.cuts), stripsOf(record.id), { signal });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          fingerprintError = String(error?.message ?? error).split("\n")[0].slice(0, 200);
        }
      }
      // Stills for judge rounds: a failure leaves them out.
      let stills = [];
      if (deps.stills) {
        setPhase(record, "keeping stills");
        try { stills = await heavy.stills(file, seconds, stillsOf(record.id), { signal }); }
        catch (error) { if (signal.aborted) throw error; }
      }
      // One SigLIP vector a shot (the still nearest its middle): how it looks, for ranking and copies.
      let look = null;
      if (deps.look && stills.length) {
        setPhase(record, "looking at shots");
        try {
          const frames = keyframeStills(stills, shotMiddles(numbers.cuts, seconds));
          const embedded = await deps.look.images(frames.map((still) => path.join(stillsOf(record.id), still.file)));
          if (embedded) look = { ...embedded, at: frames.map((still) => still.at) };
        } catch (error) { if (signal.aborted) throw error; }
      }
      Object.assign(record, { state: "measured", numbers, bpm: beat?.bpm ?? null, error: null, measuredAt: new Date(now()).toISOString(), version: INSPIRE_VERSION,
        fingerprint, strips, fingerprintError, stills, stillsEach: STILLS_EACH, seconds, ...(heard ? { heard } : {}), ...(look ? { look, same: sameFrames(look) } : {}) });
    } catch (error) {
      if (signal.aborted) record.state = "found";
      else Object.assign(record, { state: "failed", error: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
    } finally {
      // The downloaded copy is never kept.
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
    await save(record).catch(() => {});
  }

  /**
   * A sound effect: its audio (the first MAX_SOUND_SECONDS), decoded mono, gives its shape
   * (soundShape); the sounding stretch is kept as a small preview (<inspire>/sounds/<id>.m4a) whose
   * loudness is measured. The download is deleted.
   */
  async function measureSound(record, signal) {
    const folder = path.join(workRoot, `${record.id.slice(3)}-${randomUUID().slice(0, 8)}`);
    const force = forced.delete(record.id);
    try {
      if (!deps.downloadSound || !deps.decodeSound || !deps.soundPreview) throw new Error("kino cannot measure sound effects here.");
      if (!force && youtube.paused()) throw botCheckError();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = await heavy.downloadSound(record.id.slice(3), folder, { signal, force });
      setPhase(record, "reading the sound");
      const { samples, sampleRate } = await heavy.decodeSound(file, { signal });
      const shape = soundShape(samples, sampleRate);
      setPhase(record, "keeping a preview");
      await mkdir(path.join(directory, "sounds"), { recursive: true, mode: 0o700 });
      const temporary = path.join(folder, "preview.m4a");
      await heavy.soundPreview(file, temporary, { start: shape.start, end: shape.end, signal });
      let loudness = null;
      try { loudness = await heavy.soundLoudness?.(temporary, { signal }) ?? null; }
      catch (error) { if (signal.aborted) throw error; }
      await rename(temporary, soundOf(record.id));
      // How it sounds as a CLAP embedding (backend/sfx-rank.mjs): its sounding stretch, one window.
      let embedding = null;
      if (deps.embedSound) {
        try { embedding = await deps.embedSound(samples.subarray(Math.round(shape.start * sampleRate), Math.round(shape.end * sampleRate)), sampleRate); }
        catch { /* ranked by words alone */ }
      }
      Object.assign(record, { state: "measured", sound: { ...shape, loudness: Number.isFinite(loudness) ? round(loudness, 1) : null, ...(embedding ? { embedding } : {}) }, error: null, measuredAt: new Date(now()).toISOString() });
    } catch (error) {
      if (signal.aborted) record.state = record.sound ? "measured" : "found";
      else Object.assign(record, { state: "failed", error: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
    } finally {
      // The download is never kept.
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
    await save(record).catch(() => {});
  }

  async function fetchThumb(record, signal) {
    if (record.thumb) return;
    try {
      const url = new URL(record.thumbnail);
      if (url.protocol !== "https:" || url.hostname !== THUMB_HOST) return;
      const bytes = await deps.fetchThumb(url.href, { signal });
      if (!bytes?.length || bytes.length > MAX_THUMB_BYTES) return;
      await writeFile(fileOf(record.id, "jpg"), bytes, { mode: 0o600 });
      record.thumb = true;
      await save(record);
      changed(record);
    } catch { /* the tile shows its ASCII stand-in */ }
  }

  // ---- what agents and the person call --------------------------------------------------

  /**
   * Searches YouTube for a project, saves the search (who asked: an agent {id, name, color} or
   * "you") and queues every result that is not measured yet. `seconds` is the length of the video
   * being made: results far longer than it, and song uploads, are dropped (dropReason) and counted.
   * Resolves with {search, results, collapsed, dropped: {reason: count}, droppedItems: [{id, title, reason}]}.
   */
  async function search(projectId, query, { by, count = SEARCH_COUNT, signal, kind = "videos", seconds } = {}) {
    await start();
    const words = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
    if (!words) throw new Error("A search needs words, such as walking tour edit.");
    if (!SEARCH_KINDS.includes(kind)) throw new Error(`kind is "videos", "shorts" or "sounds" (got ${JSON.stringify(kind)}).`);
    const sounds = kind === "sounds";
    const wanted = sounds ? SOUND_SEARCH_COUNT : Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.round(Number(count)) || SEARCH_COUNT));
    const entry = await updateProject(projectId, (state) => {
      const made = { n: state.nextSearch, query: words, kind, by: by ?? "you", at: new Date(now()).toISOString(), state: "searching", wanted, ids: [] };
      inFlight.add(`${projectId}/${made.n}`);
      state.nextSearch += 1;
      state.searches = [...state.searches, made].slice(-MAX_SEARCHES);
      return made;
    });
    let results;
    const dropped = {};
    const droppedItems = [];
    try {
      // Sound effects: YouTube's sound effect uploads, a minute or shorter.
      // Junk (compilations, meme sounds, long ambiences for a hit, sci-fi unasked) is left out.
      results = sounds ? (await deps.search(`${words} sound effect`, { count: wanted + SOUND_SEARCH_SPARE, signal }))
        .filter((result) => result.duration <= MAX_SOUND_SECONDS && !junkSound(result.title, { words, seconds: result.duration })).slice(0, wanted)
        : await deps.search(words, { count: wanted, signal, vet: true, dropped, droppedItems, seconds, ...(kind === "shorts" ? { shorts: true } : {}) });
    } catch (error) {
      inFlight.delete(`${projectId}/${entry.n}`);
      await updateProject(projectId, (state) => {
        const found = state.searches.find((item) => item.n === entry.n);
        if (found) Object.assign(found, { state: "failed", error: String(error.message).slice(0, 200) });
      });
      throw error;
    }
    inFlight.delete(`${projectId}/${entry.n}`);
    for (const result of results) {
      const known = await load(result.id);
      if (known) {
        // A video seen before as a wide one, now found as a Short: its tall thumbnail is fetched. Once
        // measured (vertical true or false), the downloaded picture wins over the link's guess.
        if (result.vertical && known.vertical === undefined) Object.assign(known, { vertical: true, thumb: false });
        Object.assign(known, { title: result.title, channel: result.channel, duration: result.duration, views: result.views, verified: result.verified, doubt: result.doubt },
          known.vertical === false ? {} : { url: result.url, thumbnail: result.thumbnail });
      } else refs.set(result.id, { ...result, state: "found", thumb: false });
      if (sounds) refs.get(result.id).kind = "sound";
    }
    // By how they look: copies collapse, the words and the person's taste order the rest.
    let collapsed = [];
    if (!sounds && deps.look && !deps.look.failed?.()) {
      try { ({ results, collapsed } = await rankByLook(projectId, words, results, signal)); }
      catch { /* kino's views-and-slop order stands */ }
    }
    const done = await updateProject(projectId, (state) => {
      const found = state.searches.find((item) => item.n === entry.n);
      const made = { state: "done", ids: results.map((result) => result.id), count: results.length, ...(collapsed.length ? { collapsed } : {}) };
      if (found) Object.assign(found, made);
      return found ?? { ...entry, ...made };
    });
    for (const result of results) {
      const record = refs.get(result.id);
      fetchThumb(record).catch(() => {});
      if (isSound(record) ? !record.sound : record.state !== "measured") enqueue(record.id);
    }
    return { search: done, results: results.map((result) => summary(refs.get(result.id))), collapsed, dropped, droppedItems };
  }

  /**
   * The origin of a video's subject (the brief's about line): a search of its quote, and of the
   * quote with the words beside it in the person's message (originPhrase) at the same time, each
   * unmeasured (nothing is queued or saved) and read by originOf. Resolves with the state.origin
   * shape {query, phrase?, words, top}, or {query, skipped: "<why>"} when YouTube cannot be
   * searched (no yt-dlp, or both fail), so a failed search is never read as "nothing is known".
   */
  async function origin(about, { ask = [], signal } = {}) {
    const query = originQuery(about?.quote ?? about?.text);
    if (!query) return { skipped: "the about line has no words to search" };
    // The quote with the words beside it in the person's message is searched too, at the same time.
    const phrase = originPhrase(about?.quote ?? about?.text, ask);
    const searches = await Promise.allSettled([query, ...(phrase ? [phrase] : [])].map((words) => deps.search(words, { count: MAX_SEARCH_COUNT, signal })));
    const failed = searches.find((one) => one.status === "rejected");
    if (failed && searches.every((one) => one.status === "rejected")) {
      const error = failed.reason;
      // The phrase is kept so findOrigin's once-per-run retry rule sees the same search.
      return { query, ...(phrase ? { phrase } : {}), skipped: error?.code === "NO_YTDLP" ? "yt-dlp is not installed" : `the search failed: ${String(error?.message).replace(/\s+/g, " ").slice(0, 80)}` };
    }
    const [named, beside] = searches.map((one) => (one.status === "fulfilled" ? originOf(one.value, about, { ask }) : null));
    if (!phrase) return { query, ...named };
    // The phrase's words come first (each says the words that found it), then the quote's new ones.
    const first = new Set((beside?.words ?? []).map(({ word }) => stem(word.toLowerCase())));
    const words = [...(beside?.words ?? []).map((entry) => ({ ...entry, query: phrase })), ...(named?.words ?? []).filter(({ word }) => !first.has(stem(word.toLowerCase())))].slice(0, ORIGIN_MAX_WORDS);
    const top = [...(beside?.top ?? []), ...(named?.top ?? [])].filter((item, k, all) => all.findIndex((other) => other.id === item.id) === k).slice(0, ORIGIN_TOP);
    return { query, phrase, words, top };
  }

  /**
   * Search results ordered by look (look-embed.mjs rankLooks): each result's thumbnail is fetched
   * and embedded (a measured one uses its keyframes), the words are embedded, and the project's
   * saved references are its likes, the ones it unsaved its rejects. A copy's id is kept on the
   * one it collapsed into (copies), so the screen and the agent can say so.
   */
  async function rankByLook(projectId, words, results, signal) {
    const records = results.map((result) => refs.get(result.id));
    await Promise.all(records.map((record) => Promise.race([fetchThumb(record, signal), new Promise((resolve) => { setTimeout(resolve, 8000).unref?.(); })])));
    const thumbs = records.filter((record) => record.thumb && !lookVector(record, deps.look.model));
    const embedded = thumbs.length ? await deps.look.images(thumbs.map((record) => fileOf(record.id, "jpg"))) : null;
    thumbs.forEach((record, k) => { if (embedded?.vectors[k]) record.thumbLook = { model: embedded.model, vector: embedded.vectors[k] }; });
    await Promise.all(thumbs.map((record) => save(record).catch(() => {})));
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const vectorsOf = async (ids) => (await Promise.all(ids.map(load))).map((record) => lookVector(record, deps.look.model)).filter(Boolean);
    const [query] = records.some((record) => lookVector(record, deps.look.model)) ? (await deps.look.text([words])) ?? [null] : [null];
    const ranked = rankLooks(records, { query, liked: await vectorsOf(state.saved), rejected: await vectorsOf(state.rejected ?? []), model: deps.look.model });
    for (const { id, into } of ranked.collapsed) {
      const keeper = refs.get(into);
      keeper.copies = [...new Set([...(keeper.copies ?? []), id])].slice(-5);
      await save(keeper).catch(() => {});
    }
    const place = new Map(ranked.results.map((record, index) => [record.id, index]));
    return { results: results.filter((result) => place.has(result.id)).sort((a, b) => place.get(a.id) - place.get(b.id)), collapsed: ranked.collapsed };
  }

  /**
   * Adds a video kino has not seen yet (from a link the person gave): yt-dlp reads its title and
   * length, nothing is downloaded. The project records it as a one-video search (its query is the
   * link), so the screen shows it, and it waits in the queue like a search result. One that is
   * already known is answered as it is. Resolves with its summary.
   */
  async function add(projectId, id, { by, signal } = {}) {
    const known = await load(id);
    if (known) return summary(known);
    await start();
    const result = await deps.lookup(id.slice(3), { signal });
    if (!refs.has(id)) refs.set(id, { ...result, state: "found", thumb: false });
    const record = refs.get(id);
    await updateProject(projectId, (state) => {
      const made = { n: state.nextSearch, query: record.url, by: by ?? "you", at: new Date(now()).toISOString(), state: "done", wanted: 1, ids: [id], count: 1 };
      state.nextSearch += 1;
      state.searches = [...state.searches, made].slice(-MAX_SEARCHES);
    });
    fetchThumb(record).catch(() => {});
    return summary(record);
  }

  /**
   * One reference. With `wait` (ms), a reference not measured yet moves to the front of the queue
   * and this waits up to that long for its numbers.
   */
  async function reference(id, { wait = 0, full = false } = {}) {
    const record = await load(id);
    if (!record) return null;
    if (wait > 0 && unmeasured(record)) {
      enqueue(id, { first: true });
      await waitFor(id, wait);
    }
    return summary(refs.get(id) ?? record, { full });
  }

  /** Measures a reference again (after it failed), at the front of the queue. */
  async function remeasure(id) {
    const record = await load(id);
    if (!record) return null;
    if (record.state === "failed") record.state = "found";
    if (unmeasured(record)) {
      forced.add(id);
      enqueue(id, { first: true });
    }
    return summary(record);
  }

  /** Stops measuring `id` (or everything, with no id). Resolves with how many were stopped. */
  function cancel(id = null) {
    let stopped = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (id && queue[index] !== id) continue;
      const [gone] = queue.splice(index, 1);
      stopped += 1;
      heardPending.delete(gone);
      heardOnly.delete(gone);
      settle(gone);
      if (refs.has(gone)) changed(refs.get(gone));
    }
    if (running && (!id || running.id === id)) {
      running.controller.abort();
      stopped += 1;
    }
    return stopped;
  }

  /** Forgets search `n` of a project (the references stay in kino's cache). Resolves with the search. */
  async function forget(projectId, n) {
    return updateProject(projectId, (state) => {
      const found = state.searches.find((item) => item.n === n);
      if (!found) throw new Error(`There is no search ${n} in this project${state.searches.length ? `: they are ${state.searches.map((item) => item.n).join(", ")}` : ""}.`);
      state.searches = state.searches.filter((item) => item.n !== n);
      inFlight.delete(`${projectId}/${n}`);
      return found;
    });
  }

  /**
   * Imports a measured sound effect's preview into the media library, with its credit (YouTube:
   * the license is unknown). null when `id` is not a measured sound.
   */
  async function importSound(id) {
    const record = await load(id);
    if (!isSound(record) || !record.sound || !existsSync(soundOf(id))) return null;
    if (!deps.addMedia) throw new Error("kino cannot import sounds here.");
    await start();
    const folder = path.join(workRoot, `import-${randomUUID().slice(0, 8)}`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      const copy = path.join(folder, "sound.m4a");
      await writeFile(copy, await readFile(soundOf(id)), { mode: 0o600 });
      const credit = { source: "youtube", id, title: record.title, channel: record.channel, url: record.url, license: "unknown",
        line: `"${record.title}" by ${record.channel || "unknown"} (YouTube) ${record.url}`, file: "AAC from YouTube" };
      return await deps.addMedia(copy, { name: `${record.title}.m4a`.slice(0, 200), mime: "audio/mp4", extra: { credit } });
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The preview of a measured sound effect, or null. */
  async function soundFile(id) {
    const record = await load(id);
    return record?.sound && existsSync(soundOf(id)) ? soundOf(id) : null;
  }

  /** How many references a project has saved (the direction step and the render gate ask). */
  async function savedIds(projectId) {
    return ({ ...emptyProject(), ...(await projectState.read(projectId)) }).saved;
  }
  /** The saved references with the keys they were given: [{id, keys}] (cheap: no reference is loaded). */
  async function savedKeys(projectId) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    return state.saved.map((id) => ({ id, keys: Object.keys(state.keys ?? {}).filter((key) => state.keys[key] === id) }));
  }
  async function savedCount(projectId) {
    return (await savedIds(projectId)).length;
  }
  /**
   * What the edit takes from a saved reference (a save's take: "pacing: cuts on every beat in the
   * chorus"), kept beside the saved list in the project's state.takes {id: text}. "" removes it.
   */
  async function setTake(projectId, id, text) {
    const take = cleanTake(text);
    return updateProject(projectId, (state) => {
      const takes = { ...(state.takes ?? {}) };
      if (take) takes[id] = take; else delete takes[id];
      state.takes = takes;
      return take;
    });
  }
  /** The takes of the saved references: {id: text}; a saved reference with none is left out. */
  async function savedTakes(projectId) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    return Object.fromEntries(Object.entries(state.takes ?? {}).filter(([id]) => state.saved.includes(id)));
  }

  /**
   * Saves (or with `on` false, unsaves) a reference in a project. A saved one not measured yet goes
   * to the front of the queue, ahead of search results nobody picked; one that failed is tried again.
   */
  // `key` (save yt:<id> as phone-film) names the reference for a board's move.ref ("phone-film@3.13") and
  // look versus; a key names one reference, and an unsaved reference loses its keys.
  async function setSaved(projectId, id, on = true, { key = null } = {}) {
    const record = await load(id);
    if (!record) throw new Error(`No reference ${id}: search first.`);
    if (on && record.state === "failed") record.state = "found";
    if (on && (unmeasured(record) || sparseStills(record))) enqueue(id, { first: true });
    return updateProject(projectId, (state) => {
      const without = state.saved.filter((entry) => entry !== id);
      state.saved = on ? [...without, id].slice(-MAX_SAVED) : without;
      // An unsaved reference counts against its look in the next searches' order (taste).
      const rejected = (state.rejected ?? []).filter((entry) => entry !== id);
      state.rejected = on ? rejected : [...rejected, id].slice(-MAX_SAVED);
      const keys = Object.fromEntries(Object.entries(state.keys ?? {}).filter(([, ref]) => state.saved.includes(ref)));
      if (on && key) keys[key.toLowerCase()] = id;
      state.keys = keys;
      return state.saved.length;
    });
  }

  /**
   * An agent proposes ideas from a measured reference (cleanIdeas): they replace any ideas the
   * project had and wait for the person, who turns each on or off and allows them or says not
   * yet. Resolves with the ideas.
   */
  async function setIdeas(projectId, input, by) {
    const id = refId(input?.ref);
    if (!id) throw new Error("ref is the reference the ideas come from, such as yt:dQw4w9WgXcQ");
    const record = await load(id);
    if (!record?.numbers) throw new Error(`${id} is not measured yet: read it first (library {topic:"inspire", name:"${id}"})`);
    const { take, skip } = cleanIdeas(input, record.numbers.seconds);
    return updateProject(projectId, (state) => {
      state.ideas = { id: `I${state.nextIdeas}`, ref: id, by: by ?? "you", at: new Date(now()).toISOString(), status: "waiting", take, skip };
      state.nextIdeas += 1;
      return state.ideas;
    });
  }

  /** The person turns idea `n` on or off while it waits. Resolves with the ideas. */
  async function toggleIdea(projectId, n, on) {
    return updateProject(projectId, (state) => {
      const ideas = state.ideas;
      if (!ideas || ideas.status !== "waiting") throw new Error("No ideas wait for you now.");
      const idea = [...ideas.take, ...ideas.skip].find((entry) => entry.n === n);
      if (!idea) throw new Error(`There is no idea ${n}: they go 1 to ${ideas.take.length + ideas.skip.length}.`);
      idea.on = on ?? !idea.on;
      return ideas;
    });
  }

  /**
   * The person's answer: "allowed" (the ideas turned on go to the agent) or "held" (not yet), with
   * an optional note. Resolves with the ideas.
   */
  async function answerIdeas(projectId, decision, note = "") {
    return updateProject(projectId, (state) => {
      const ideas = state.ideas;
      if (!ideas || ideas.status !== "waiting") throw new Error("No ideas wait for you now.");
      if (decision === "allowed" && ![...ideas.take, ...ideas.skip].some((idea) => idea.on)) throw new Error("Every idea is off: turn one on (1, 2, …) or press d for not yet.");
      ideas.status = decision;
      ideas.answeredAt = new Date(now()).toISOString();
      const words = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, IDEA_LIMITS.note);
      if (words) ideas.note = words;
      return ideas;
    });
  }

  /** Notes that an agent ({id, name, color}) is reading reference `id` in a project. */
  async function setLooking(projectId, id, by) {
    return updateProject(projectId, (state) => { state.looking = { id, by, at: new Date(now()).toISOString() }; });
  }

  function waitFor(id, ms) {
    wanted.set(id, (wanted.get(id) ?? 0) + 1);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      waiters.set(id, [...(waiters.get(id) ?? []), () => { clearTimeout(timer); resolve(); }]);
    }).finally(() => {
      const left = (wanted.get(id) ?? 1) - 1;
      if (left > 0) wanted.set(id, left); else wanted.delete(id);
    });
  }

  /**
   * The stills of a project's saved references: [{id, keys, title, channel, seconds, folder, stills}],
   * the first `most`, or those of `ids`. With `wait` (ms), a saved reference without stills is
   * measured again first (one at a time, in the queue) and this waits up to that long for each.
   * `bare` keeps the ones with no stills yet too (stills: []), to match a board's ref keys.
   */
  async function savedStills(projectId, { wait = 0, most = 5, ids = null, bare = false } = {}) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const found = [];
    for (const id of ids ? state.saved.filter((saved) => ids.includes(saved)) : state.saved.slice(0, most)) {
      let record = await load(id);
      if (!record) continue;
      if (wait > 0 && deps.stills && !record.stills?.length && record.state !== "failed") {
        if (needsStills(record)) forced.add(id);
        enqueue(id, { first: true });
        await waitFor(id, wait);
        record = await load(id);
      }
      const keys = Object.keys(state.keys ?? {}).filter((key) => state.keys[key] === id);
      if (record?.stills?.length || (bare && record)) found.push({ id, keys, title: record.title, channel: record.channel ?? null, seconds: record.seconds ?? record.numbers?.seconds ?? null, folder: stillsOf(id), stills: record.stills ?? [] });
    }
    return found;
  }

  /** The folder of a reference's frame strips and the strips in it ([{at, kinds, file}]). */
  async function stripsFor(id) {
    const record = await load(id);
    return record?.strips?.length ? { folder: stripsOf(id), strips: record.strips } : null;
  }

  // A reference measured before `heard` existed gets it once, when a full check first asks: it waits
  // in the measuring queue like any other job (so it never runs beside a measure), downloads the same
  // small copy and runs heard() only, never for every project at launch. A failure leaves it out
  // (never guessed) and is not tried again this run.
  function measureHeardLater(record) {
    if (heardTried.has(record.id) || !heavy.heard || !heavy.download) return;
    heardTried.add(record.id);
    heardPending.add(record.id);
    heardOnly.add(record.id);
    enqueue(record.id);
  }

  async function measureHeard(record, signal) {
    const folder = path.join(workRoot, `${record.id.slice(3)}-heard-${randomUUID().slice(0, 8)}`);
    try {
      if (youtube.paused()) return;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = await heavy.download(record.id.slice(3), folder, { signal });
      const heard = await heavy.heard(file, { seconds: record.seconds, bpm: record.bpm ?? null, signal });
      if (heard) { record.heard = heard; await save(record); }
    } catch { /* left out */ } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  // A fingerprint measured before contrast was kept gets the median contrast of its saved stills
  // (read at 640 px wide, as look versus reads them), marked contrastFrom:"stills". No readable
  // still leaves it out. The saved record itself is not changed.
  // The median is kept per reference and set of stills, so a check does not decode them again.
  const stillContrasts = new Map();
  async function withStillContrast(record, id) {
    const fingerprint = record.fingerprint;
    if (!fingerprint.look || Number.isFinite(fingerprint.look.contrast) || !record.stills?.length) return fingerprint;
    const key = `${id}:${record.stills.length}:${record.stills.at(-1)?.file}`;
    if (!stillContrasts.has(key)) {
      const { imageContrast } = await import("./agent/versus.mjs");
      const values = [];
      for (const still of record.stills) {
        const value = await imageContrast(path.join(stillsOf(id), still.file));
        if (Number.isFinite(value)) values.push(value);
      }
      values.sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      stillContrasts.set(key, !values.length ? null : Math.round((values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) * 100) / 100);
    }
    const contrast = stillContrasts.get(key);
    return contrast === null ? fingerprint : { ...fingerprint, look: { ...fingerprint.look, contrast, contrastFrom: "stills" } };
  }

  /**
   * The fingerprints of a project's saved references that have one, with their feature prints:
   * [{id, title, fingerprint, prints, heard?, heardPending?}] (for the reference_drift and
   * reference_range checks). heardLater: measure a missing `heard` in the background.
   */
  async function savedFingerprints(projectId, { heardLater = false } = {}) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const found = [];
    for (const id of state.saved) {
      const record = await load(id);
      if (!record?.fingerprint) continue;
      if (heardLater && !record.heard) measureHeardLater(record);
      let prints = [];
      try { prints = JSON.parse(await readFile(fileOf(id, "prints.json"), "utf8")); } catch { /* none kept */ }
      found.push({ id, title: record.title, measuredAt: record.measuredAt, fingerprint: await withStillContrast(record, id), prints, ...(record.heard ? { heard: record.heard } : heardPending.has(id) ? { heardPending: true } : {}) });
    }
    return found;
  }

  /**
   * The lent cuts of a project's saved, measured references: [{id, seconds, cuts, fps}] (for the
   * reference_closeness check: their shot lengths in order are what an edit must not copy).
   */
  async function savedRhythms(projectId) {
    const state = { ...emptyProject(), ...(await projectState.read(projectId)) };
    const found = [];
    for (const id of state.saved) {
      const numbers = (await load(id))?.numbers;
      if (!numbers?.cuts?.length) continue;
      found.push({ id, seconds: numbers.seconds, cuts: lentCuts(numbers).map((index) => numbers.cuts[index]), fps: numbers.fps ?? 24 });
    }
    return found;
  }

  async function thumbFile(id) {
    const record = await load(id);
    return record?.thumb ? fileOf(id, "jpg") : null;
  }

  /** The ids of every reference kept in the cache. */
  async function cachedIds() {
    try { return (await readdir(directory)).filter((name) => name.endsWith(".json")).map((name) => `yt:${name.slice(0, -5)}`); }
    catch { return []; }
  }

  return { start, search, origin, searchView, soundTasteEntry, add, forget, importSound, soundFile, reference, remeasure, cancel, setSaved, setTake, savedTakes, savedCount, savedIds, savedKeys, setLooking, setIdeas, toggleIdea, answerIdeas, projectView, thumbFile, stripsFor, savedStills, savedFingerprints, savedRhythms, cachedIds, summary: (id) => summary(refs.get(id)) };
}

/**
 * The flow arrows of a live frame as fractions of the picture per sample (1/12 s): {cols, rows, u,
 * v}, rounded to 3 places; null without flow.
 */
export function liveFlow(flow, width, height) {
  if (!flow?.cols || !flow?.rows || !Array.isArray(flow.u) || !Array.isArray(flow.v) || !(width > 0 && height > 0)) return null;
  const count = flow.cols * flow.rows;
  if (flow.u.length < count || flow.v.length < count) return null;
  return { cols: flow.cols, rows: flow.rows, u: flow.u.slice(0, count).map((value) => round((Number(value) || 0) / width, 3)), v: flow.v.slice(0, count).map((value) => round((Number(value) || 0) / height, 3)) };
}

/** A live frame's BGRA bytes as a JPEG LIVE_WIDTH wide (createCanvas from @napi-rs/canvas). */
export function encodeLiveFrame({ bgra, width, height }, createCanvas) {
  const full = createCanvas(width, height);
  const image = full.getContext("2d").createImageData(width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = bgra[index + 2]; image.data[index + 1] = bgra[index + 1]; image.data[index + 2] = bgra[index]; image.data[index + 3] = 255;
  }
  full.getContext("2d").putImageData(image, 0, 0);
  const outWidth = Math.min(LIVE_WIDTH, width), outHeight = Math.max(2, Math.round((height * outWidth) / width));
  const small = createCanvas(outWidth, outHeight);
  small.getContext("2d").drawImage(full, 0, 0, outWidth, outHeight);
  return small.encodeSync("jpeg", 70);
}

/** The few fingerprint numbers the inspire screen shows on a reference. */
export function screenNumbers(fp) {
  if (!fp) return null;
  const counts = fp.text?.counts;
  const total = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0;
  return {
    still: fp.motion?.stillShare ?? null,
    camera: fp.camera?.moving ?? null,
    text: fp.text?.share ?? null,
    lowercase: fp.text?.lowercase ?? null,
    words: total >= 3 ? Math.round((counts.words / total) * 100) / 100 : null,
    blurDips: fp.transitions?.blurDips?.length ?? null,
  };
}

/** The real tools behind createInspire: yt-dlp, FFmpeg's shot and beat finders, fetch, and the
 * fingerprint measure (Apple Vision on a Mac). */
export async function inspireTools({ command } = {}) {
  const [{ findShots }, { analyzeAudioFile, decodeMono, steadyBeat }, { probeMedia, ffmpegCommand }, { measureVideo }, { makeStrips }, { makeStills }, { createCanvas }, { runExportProcess }, { measureFileLevels }] = await Promise.all([
    import("./shot-detection.mjs"), import("./audio-analysis.mjs"), import("./media-probe.mjs"), import("./measure/measure.mjs"), import("./measure/strips.mjs"),
    import("./measure/stills.mjs"), import("@napi-rs/canvas"), import("./export-process.mjs"), import("./audio-levels.mjs"),
  ]);
  return {
    search: (query, options) => searchYouTube(query, { ...options, command: command ?? ytDlpCommand() }),
    mix: (videoId, options) => mixYouTube(videoId, { ...options, command: command ?? ytDlpCommand() }),
    lookup: (videoId, options) => lookupYouTube(videoId, { ...options, command: command ?? ytDlpCommand() }),
    async download(videoId, folder, { signal } = {}) {
      const ffmpeg = ffmpegCommand();
      // YouTube sends a JavaScript challenge; without a runtime to answer it yt-dlp falls back to
      // clients YouTube refuses ("not a bot"), so kino names one explicitly.
      const runtime = jsRuntime();
      if (!runtime) throw Object.assign(new Error(NO_JS_RUNTIME), { code: "NO_JS_RUNTIME" });
      await runYtDlp(["--js-runtimes", `${runtime.name}:${runtime.path}`, ...downloadArgs(videoId, folder, { ffmpeg: ffmpeg.includes("/") ? ffmpeg : undefined })],
        { command: command ?? ytDlpCommand(), signal, timeoutMs: 180_000 });
      const files = (await readdir(folder)).filter((name) => name.startsWith("clip."));
      if (!files.length) throw new Error("yt-dlp downloaded nothing.");
      return path.join(folder, files[0]);
    },
    // Soundtrack measuring (backend/soundtrack.mjs): the smallest audio-only copy, 4 minutes at
    // most, measured and deleted. whole: the best audio of the whole song as WAV, for an import.
    async downloadAudio(videoId, folder, { signal, whole = false } = {}) {
      if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
      const ffmpeg = ffmpegCommand();
      const runtime = jsRuntime();
      if (!runtime) throw Object.assign(new Error(NO_JS_RUNTIME), { code: "NO_JS_RUNTIME" });
      await runYtDlp(["--js-runtimes", `${runtime.name}:${runtime.path}`, "--no-playlist", "--no-part", "--no-mtime",
        ...(whole ? ["-f", "ba", "-x", "--audio-format", "wav"] : ["-f", "wa/ba", "--download-sections", "*0-240"]), ...(ffmpeg.includes("/") ? ["--ffmpeg-location", ffmpeg] : []), "-o", path.join(folder, "song.%(ext)s"), watchUrl(videoId)],
      { command: command ?? ytDlpCommand(), signal, timeoutMs: whole ? 600_000 : 180_000 });
      const files = (await readdir(folder)).filter((name) => name.startsWith("song.") && (!whole || name.endsWith(".wav")));
      if (!files.length) throw new Error("yt-dlp downloaded nothing.");
      return path.join(folder, files[0]);
    },
    // Sound effects: the smallest audio-only copy of the first 60 s, deleted after it is measured.
    async downloadSound(videoId, folder, { signal } = {}) {
      if (!VIDEO_ID.test(String(videoId ?? ""))) throw new Error(`"${videoId}" is not a YouTube video id.`);
      const ffmpeg = ffmpegCommand();
      const runtime = jsRuntime();
      if (!runtime) throw Object.assign(new Error(NO_JS_RUNTIME), { code: "NO_JS_RUNTIME" });
      await runYtDlp(["--js-runtimes", `${runtime.name}:${runtime.path}`, ...soundDownloadArgs(videoId, folder, { ffmpeg: ffmpeg.includes("/") ? ffmpeg : undefined })],
        { command: command ?? ytDlpCommand(), signal, timeoutMs: 120_000 });
      const files = (await readdir(folder)).filter((name) => name.startsWith("sound."));
      if (!files.length) throw new Error("yt-dlp downloaded nothing.");
      return path.join(folder, files[0]);
    },
    decodeSound: (file) => decodeMono(file),
    async soundPreview(file, target, { start, end, signal } = {}) {
      await runExportProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(Math.max(0.05, end - start)), "-i", file,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", target], signal);
    },
    // A measured song's preview (backend/soundtrack.mjs): that stretch in stereo AAC, 96 kbps.
    async songPreview(file, target, { start, end, signal } = {}) {
      await runExportProcess(ffmpegCommand(), ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(Math.max(0.05, end - start)), "-i", file,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "96k", "-f", "mp4", "-movflags", "+faststart", target], signal);
    },
    soundLoudness: async (file, { signal } = {}) => (await measureFileLevels(file, signal)).integratedLufs,
    findShots: (file, options) => findShots(file, options),
    fingerprint: (file, { seconds, cuts, signal, onFrame } = {}) => measureVideo(file, { seconds, cuts, signal, onFrame }),
    encodeFrame: (frame) => encodeLiveFrame(frame, createCanvas),
    strips: (file, moments, folder, options) => makeStrips(file, moments, folder, options),
    stills: (file, seconds, folder, options) => makeStills(file, seconds, folder, options),
    // The loudest change (the song's section with the most weight, not the intro or outro) and the
    // voice spans (whisper, when a model is installed: by "none" says it was not heard).
    async heard(file, { seconds, bpm } = {}) {
      const { songShape, songVocals, whisperModelReady } = await import("./song-shape.mjs");
      const { samples, sampleRate } = await decodeMono(file);
      const top = songShape(samples, sampleRate, { bpm }).sections.filter((part) => part.kind !== "intro" && part.kind !== "outro" && Number.isFinite(part.weight))
        .sort((a, b) => b.weight - a.weight || a.at - b.at)[0];
      let voice = null;
      if (whisperModelReady()) { try { voice = await songVocals(file, { seconds }); } catch { voice = null; } }
      return { change: top ? { at: top.at, kind: top.kind } : null, voice, by: voice ? "whisper" : "none" };
    },
    // steady: kino's own test of whether the beat grid is a song's (a voice scores low).
    findBeats: async (file) => { const analysis = await analyzeAudioFile(file); return { ...analysis, steady: steadyBeat(analysis) }; },
    probe: (file, options) => probeMedia(file, options),
    async fetchThumb(url, { signal } = {}) {
      // KINO_INSPIRE_THUMBS=off: no thumbnails (the tests, which never go online).
      if (process.env.KINO_INSPIRE_THUMBS === "off") return null;
      // A plain request: no cookies, no referrer, nothing about the person.
      const response = await fetch(url, { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error(`thumbnail ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

// ---- what agents read ----------------------------------------------------------------------

const quoted = (text) => `'${String(text ?? "").replace(/\s+/g, " ").slice(0, 70)}'`;
const PHASE_WORDS = { fetching: "fetching a 360p copy", "reading cuts": "reading cuts", "finding the beat": "finding the beat",
  "reading motion and text": "reading motion and text", "keeping frame strips": "keeping frame strips", "keeping stills": "keeping stills",
  "looking at shots": "looking at each shot", "reading the sound": "reading the sound", "keeping a preview": "keeping a preview" };

/** A measured sound as the screen and agents see it: the embedding is left out (1 KB), `embedded` says it has one. */
function soundView(sound) {
  const { embedding, ...rest } = sound;
  return embedding ? { ...rest, embedded: true } : rest;
}

/**
 * A sounds search ranked (library inspire name:"sounds <n>"): the best first with its match to the
 * words and the person's taste, near-duplicates folded into the one kept.
 */
export function rankedSoundsText({ search, ranks, results }) {
  const byId = new Map(results.map((ref) => [ref.id, ref]));
  const ranked = Object.entries(ranks).sort((a, b) => a[1].order - b[1].order);
  const waiting = results.filter((ref) => !ref.sound && ref.state !== "failed").length;
  if (!ranked.length) return `sounds ${search.n} "${search.query}": nothing ranked yet (${waiting} still measuring; embeddings need the CLAP model). Ask again in a minute.`;
  return [`sounds ${search.n} "${search.query}" ranked by match to the words${ranked.some(([, row]) => row.taste != null) ? " and your taste" : ""}${waiting ? ` (${waiting} still measuring)` : ""}:`,
    ...ranked.slice(0, 8).map(([id, row], index) => {
      const ref = byId.get(id);
      return `${index + 1}) ${ref ? soundResultLine(ref) : id} · match ${row.match ?? "?"}${row.taste != null ? ` · taste ${row.taste}` : ""}${row.alike ? ` · ${row.alike.length} alike folded in` : ""}${row.why ? ` (${row.why})` : ""}`;
    }),
    `Use one: project {action:"import", source:"${ranked[0][0]}"}. Sound effects only on visible actions, one at a time.`].join("\n");
}

/** A measured sound effect in a line: "2.1 s, peak 1.1 s, -18 LUFS". */
export function soundLine(sound) {
  return `${sound.length} s, peak ${sound.peakAt} s, ${sound.loudness == null ? "too short for LUFS" : `${sound.loudness} LUFS`}`;
}

/** A sound effect result: yt:<id> "title" 2.1 s, peak 1.1 s, -18 LUFS (or how far its measure is). */
export function soundResultLine(ref) {
  const title = `"${String(ref.title ?? "").replace(/\s+/g, " ").slice(0, 70)}"`;
  return ref.sound ? `${ref.id} ${title} ${soundLine(ref.sound)}` : `${ref.id} ${title} ${clock(ref.duration)} · ${numbersLine(ref)}`;
}

const ideaTime = (idea) => (idea.to != null && clock(idea.to) !== clock(idea.from) ? `${clock(idea.from)} to ${clock(idea.to)}` : clock(idea.from));

/** What an agent reads after it proposed ideas. */
export function ideasProposedText(ideas) {
  return [`${ideas.id}: ${ideas.take.length} idea${ideas.take.length === 1 ? "" : "s"} from ${ideas.ref} wait for the person on the inspire screen (F3), with ${ideas.skip.length} skipped.`,
    ...ideas.take.map((idea) => `${idea.n}) ${idea.title} (${ideaTime(idea)}): ${idea.use}`),
    ...ideas.skip.map((idea) => `${idea.n}) skipped: ${idea.title}: ${idea.why}`),
    "They turn each on or off, then allow or say not yet; the answer comes in your inbox. Keep working meanwhile; proposing again replaces these."].join("\n");
}

/** The inbox line the agent gets when the person answers its ideas. */
export function ideasAnswerText(ideas) {
  const note = ideas.note ? ` Their note: "${ideas.note}".` : "";
  if (ideas.status !== "allowed") return `${ideas.id} not yet: the person held your ideas from ${ideas.ref}.${note} Change them and propose again (library {topic:"inspire", ideas}), or ask.`;
  const used = [...ideas.take, ...ideas.skip].filter((idea) => idea.on);
  const off = ideas.take.filter((idea) => !idea.on);
  const lines = used.map((idea) => (idea.why && idea.use ? `${idea.n} "${idea.title}" (${ideaTime(idea)}): ${idea.use}` : `${idea.n} "${idea.title}" (you skipped it; the person wants it anyway)`));
  return `${ideas.id} allowed by the person: use ${lines.join("; ")}.${off.length ? ` Not using: ${off.map((idea) => `${idea.n} "${idea.title}"`).join(", ")}.` : ""}${note} Next: add each to the brief's style (notes {action:"brief", fields:{style}}, a line with ref "${ideas.ref}" and at), then plan and make them.`;
}

/** One reference's numbers in a line: "1.2 cuts/s · 16 shots in 39 s · on the beat 11 of 15". */
export function numbersLine(ref) {
  if (ref?.state === "measuring") return `measuring (${ref.kind === "sound" && ref.phase === "fetching" ? "fetching the sound" : PHASE_WORDS[ref.phase] ?? "starting"})`;
  if (ref?.state === "queued") return `waiting to be measured (${ref.place} in line)`;
  if (ref?.state === "failed") return `not measured: ${ref.error}`;
  if (ref?.kind === "sound") return ref.sound ? soundLine(ref.sound) : "not measured";
  const numbers = ref?.numbers;
  if (!numbers) return "not measured";
  const beat = numbers.onBeat ? `on the beat ${numbers.onBeatCount} of ${numbers.cuts.length}` : "no steady beat";
  return [`${numbers.cutsPerSecond} cuts/s`, `${numbers.shots} shots in ${Math.round(numbers.seconds)} s`, shotWords(numbers), beat].filter(Boolean).join(" · ");
}

/** "median shot 0.9 s · longest 3.2 s": the usual shot and the longest, which a mean cuts/s hides.
 * A part a saved record lacks is left out ("" when both are). */
function shotWords(numbers) {
  const { median } = numbersWithMedian(numbers);
  return [median != null ? `median shot ${round(median, 1)} s` : "", numbers.longest ? `longest ${numbers.longest.seconds} s` : ""].filter(Boolean).join(" · ");
}

/** " (1.8 beats, about 2 at 120 bpm)" when the reference's own beat is known; "" otherwise. */
const medianBeatWords = (numbers, bpm) => (numbers.medianBeats ? ` (${numbers.medianBeats.exact} beats, about ${numbers.medianBeats.near}${bpm ? ` at ${Math.round(bpm)} bpm` : ""})` : "");

// " · Short 9:16" for a vertical YouTube Short; nothing for any other video.
const shapeWords = (ref) => (ref?.vertical ? " · Short 9:16" : "");

/** A view count in a few letters: 618, 12k, 1.2M, 3.4B. */
export function viewsShort(views) {
  const [size, letter] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]].find(([step]) => views >= step) ?? [1, ""];
  const value = views / size;
  return `${value < 10 && letter ? Math.floor(value * 10) / 10 : Math.floor(value)}${letter}`;
}

// " · 12k views · verified · doubt: few views": who made it and why it may be slop, when known.
// Doubts from its title and from kino's own measure of it (measuredDoubt) are one list.
const doubtWords = (ref) => [ref?.doubt, ref?.measuredDoubt].filter(Boolean).join(", ");
const sourceWords = (ref) => `${ref?.views != null ? ` · ${viewsShort(ref.views)} views` : ""}${ref?.followers != null ? ` · ${viewsShort(ref.followers)} subs` : ""}${ref?.verified ? " · verified" : ""}${doubtWords(ref) ? ` · doubt: ${doubtWords(ref)}` : ""}${ref?.same ? " · same frames (ai or a still? look first)" : ""}${ref?.copies?.length ? ` · ${ref.copies.length} cop${ref.copies.length === 1 ? "y" : "ies"} hidden` : ""}`;

/**
 * A search's answer: one line per result, then what to do next. dropped: {reason: count} from the
 * search (never shown as results, only counted). alsoTry: a second ready search words (the
 * person's named things without the song), offered when the first search was the filled one.
 * droppedItems: the dropped results' {id, title}, a few of which the Dropped line names.
 */
export function searchText(query, results, { kind = "videos", collapsed = [], dropped = {}, droppedItems = [], alsoTry = "", plan = {} } = {}) {
  const dropLine = droppedText(dropped, droppedItems);
  if (!results.length) return `inspire "${query}": nothing found on YouTube${kind === "sounds" ? ` (sound effects of ${MAX_SOUND_SECONDS} s or less)` : kind === "shorts" ? " Shorts" : ""}. Try other words${kind === "shorts" ? ', or the same words without kind:"shorts"' : ""}.${dropLine ? ` ${dropLine}` : ""}${alsoTry ? ` Without the song: library {topic:"inspire", search:"${alsoTry}"}.` : ""}`;
  if (kind === "sounds") {
    return [`inspire sounds "${query}": ${results.length} sound effect${results.length === 1 ? "" : "s"} on YouTube (${MAX_SOUND_SECONDS} s or less). kino measures each, one at a time: length (silence trimmed), loudest moment, loudness, and keeps a short preview.`,
      ...results.map((ref, index) => `${index + 1}) ${soundResultLine(ref)} · ${ref.channel || "?"}`),
      `Ranked by how each sounds against the words, once measured: library {topic:"inspire", name:"sounds <search n>"}. One sound (waits for its measure): library {topic:"inspire", name:"${results[0].id}"}. Use one: project {action:"import", source:"${results[0].id}"} (credit kept).`].join("\n");
  }
  // plan ({seconds, vertical}: the video being made) adds each result's fit (fitNote).
  const fit = (ref) => { const note = fitNote(ref, plan); return note ? ` · fit: ${note}` : ""; };
  const lines = results.map((ref, index) => `${index + 1}) ${ref.id} ${quoted(ref.title)} · ${ref.channel || "?"} · ${clock(ref.duration)}${shapeWords(ref)}${sourceWords(ref)}${fit(ref)} · ${numbersLine(ref)}`);
  return [
    `inspire ${kind === "shorts" ? "shorts " : ""}"${query}": ${results.length} found on YouTube${kind === "shorts" ? ` (Shorts, and videos of ${SHORT_SECONDS} s or less; "Short 9:16" marks a vertical one)` : ""}, best first (views, verified channel, how the frames match the words and the saved references; doubt: likely slop, vet it before saving)${collapsed.length ? `; ${collapsed.length} near-identical cop${collapsed.length === 1 ? "y" : "ies"} hidden (${collapsed.map((copy) => `${copy.id} = ${copy.into}`).join(", ")})` : ""}. kino measures the first ${MEASURE_SECONDS} s of each, one at a time (from a 360p copy it deletes after).`,
    ...lines,
    ...[dropLine, sharedLine(results, query, droppedItems), alsoTry ? `Without the song: library {topic:"inspire", search:"${alsoTry}"}.` : ""].filter(Boolean),
    `Compare before saving: read ${results.length > 2 ? 3 : results.length} (name:"<id>"), then save the 2 that fit, each with what this edit takes from it: library {topic:"inspire", name:"save <id>", take:"<structure, pacing, type, transitions or sound: what, and the stretch>"}.`,
    `One ref's cuts (waits for its numbers): library {topic:"inspire", name:"${results[0].id}"}. Borrow its rhythm as cue marks: edit {ops:[{op:"borrow_rhythm", ref:"${results[0].id}", fit:true}]}.`,
  ].join("\n");
}

/** One reference in full: its numbers, where the longest shot is and its cut times. */
export function referenceText(ref, { full = false } = {}) {
  const head = `${ref.id} ${quoted(ref.title)} · ${ref.channel || "?"} · ${clock(ref.duration)}${shapeWords(ref)}${sourceWords(ref)} · ${ref.url}`;
  if (ref.kind === "sound") {
    if (!ref.sound) return `${head}\nsound effect: ${numbersLine(ref)}`;
    const s = ref.sound;
    return [head, `sound effect: ${soundLine(s)} · sounds from ${s.start} s to ${s.end} s of the upload`,
      `shape (${s.peaks.length} bars, loudest 9): ${s.peaks.map((value) => Math.round(value * 9)).join("")}`,
      `import: project {action:"import", source:"${ref.id}"} (the ${s.length} s preview, credit kept). Line its peak (${s.peakAt} s in) up with the moment it marks.`].join("\n");
  }
  const numbers = ref.numbers;
  if (!numbers) return `${head}\n${numbersLine(ref)}`;
  const span = numbers.seconds < ref.duration - 0.5 ? `the first ${Math.round(numbers.seconds)} s of ${clock(ref.duration)}` : `all ${Math.round(numbers.seconds)} s`;
  const longest = numbers.longest ? `longest ${numbers.longest.seconds} s ${numbers.longest.where ? `(${numbers.longest.where})` : `from ${clock(numbers.longest.start)}`}` : "";
  const beat = numbers.onBeat ? `cuts on the beat ${numbers.onBeatCount} of ${numbers.cuts.length}${ref.bpm ? ` (${Math.round(ref.bpm)} bpm)` : ""}` : "no steady beat in its sound";
  const lent = lentCuts(numbers);
  const shown = full ? lent : lent.slice(0, 40);
  const closer = numbers.cuts.length - lent.length;
  const cuts = numbers.cuts.length
    ? `cuts (s): ${shown.map((index) => `${numbers.cuts[index]}${numbers.onBeat?.[index] ? "*" : ""}`).join(" ")}${shown.length < lent.length ? ` … (${lent.length} in all; full:true lists them)` : ""}${numbers.onBeat ? " (* on the beat)" : ""}${closer ? ` (${closer} under ${LEND_MIN_FRAMES} frames apart not listed or borrowed)` : ""}`
    : "cuts: none (one shot)";
  const fit = [beatFitLine(numbers.beatFit), numbers.flashes ? `flashes ${numbers.flashes}` : ""].filter(Boolean).join(" · ");
  const filled = numbersWithMedian(numbers, ref.bpm);
  const median = filled.median != null ? `median shot ${round(filled.median, 1)} s${medianBeatWords(filled, ref.bpm)}` : "";
  return [head, `measured ${span}: ${[`${numbers.shots} shots`, `${numbers.cutsPerSecond} cuts/s`, median, longest, beat].filter(Boolean).join(" · ")}`, ...(fit ? [fit] : []), cuts, lendLine(numbers),
    ...fingerprintLines(ref),
    `borrow: edit {ops:[{op:"borrow_rhythm", ref:"${ref.id}", fit:true}]} (each section's shot lengths in a new order, cut on the song's seams when fit_music marked them; fit:true scales to the scene)`].join("\n");
}

const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?");
// Up to 3 example times as " (1.1 6.7 15.3)", or nothing when there are none.
const at = (times = []) => (times.length ? ` (${times.slice(0, 3).map((time) => Number(time).toFixed(1)).join(" ")})` : "");
const REVEAL_NAMES = { whole: "whole lines", words: "a few words at a time", letters: "letter by letter", slides: "sliding in", grows: "growing in" };

/**
 * A reference's fingerprint in a few lines (ref from reference(id, {full: true})): what each number
 * is and where to look, then the suggested style lines. Vision numbers this Mac could not measure
 * are named, not guessed.
 */
export function fingerprintLines(ref) {
  const fp = ref.fingerprint;
  if (!fp) {
    if (ref.fingerprintError) return [`fingerprint: not measured (${ref.fingerprintError})`];
    if (ref.state === "measuring") return [];
    return [`fingerprint: not measured yet (measured by an older kino); name:"measure ${ref.id}" measures it again`];
  }
  const lines = ["fingerprint (numbers only, from a 360p copy; motion and closeness are advice, text is read reliably):"];
  const missing = Object.entries(fp.vision ?? {}).filter(([, value]) => value !== true);
  if (missing.length) lines.push(`not measured: ${missing.map(([job, why]) => `${job} (${why})`).join("; ")}`);
  if (fp.motion) {
    lines.push(`motion: median ${fp.motion.median} frame/s · still ${pct(fp.motion.stillShare)} (longest ${fp.motion.longestStill.seconds} s at ${fp.motion.longestStill.at ?? "?"} s) · peaks${at(fp.motion.peaks)}`);
  }
  if (fp.camera) {
    const c = fp.camera;
    lines.push(`camera: moves ${pct(c.moving)} · push-in ${pct(c.zoomIn)}${at(c.examples?.["zoom-in"])} · pull-back ${pct(c.zoomOut)} · pan ${pct(c.pan)} · rotate ${pct(c.rotate)} · shaky ${pct(c.shaky)} of moves`);
  }
  if (fp.transitions || fp.handoff) {
    const t = fp.transitions;
    lines.push(`hand-offs: ${fp.handoff ? `cuts in motion ${fp.handoff.inMotion} of ${fp.handoff.cuts}` : "cuts in motion ?"}${t ? ` · blur dips ${t.blurDips.length}${at(t.blurDips)} · dissolves ${t.dissolves.length}${at(t.dissolves)} · fades ${t.fades.length}${at(t.fades)}` : ""}`);
  }
  if (fp.text) {
    const counts = fp.text.counts ? Object.entries(fp.text.counts).filter(([, n]) => n).map(([style, n]) => `${REVEAL_NAMES[style]} ${n}${at(fp.text.examples[style])}`).join(", ") : "";
    lines.push(`text: on screen ${pct(fp.text.share)} · big type ${pct(fp.text.bigShare)} · on a plain background ${pct(fp.text.onPlain)} of text · lowercase ${pct(fp.text.lowercase)}${counts ? ` · appears: ${counts}` : ""}`);
  }
  if (fp.persistent?.length) lines.push(`stays in place across cuts: ${fp.persistent.map((item) => `${item.kind === "text" ? `"${item.text}"` : "a patch"} at ${item.box.slice(0, 2).join(",")} (${pct(item.share)})`).join("; ")}`);
  lines.push(`look: brightness ${fp.look.brightness}${Number.isFinite(fp.look.darkShare) ? ` · dark ${pct(fp.look.darkShare)}` : ""} · palette ${fp.look.palette.map((entry) => `${entry.hex} ${pct(entry.share)}`).join(" ")}${fp.shots?.subjectArea != null ? ` · subject ${pct(fp.shots.subjectArea)} of the frame` : ""}`);
  // What reference_range compares: the loudest change of the sound and where a voice is heard (whisper hears sung and spoken voice alike).
  if (ref.heard) lines.push(`heard: loudest change ${ref.heard.change ? `${ref.heard.change.at} s (${ref.heard.change.kind})` : "none found"} · voice ${ref.heard.voice ? (ref.heard.voice.length ? ref.heard.voice.map(([from, to]) => `${from}-${to} s`).join(", ") : "none") : "not heard"}`);
  if (ref.stripList?.length) lines.push(`frame strips kept: ${ref.stripList.length} (cuts, motion peaks, text entrances): look {mode:"reference", ref:"${ref.id}", t:${ref.stripList[0].at}}; without t, page 1 of ${Math.ceil(ref.stripList.length / 6)}`);
  const suggested = suggestionText(suggestStyleLines(fp, ref.numbers, ref.id), ref.id);
  if (suggested) lines.push(suggested);
  const type = typeNote(fp, ref.id);
  if (type) lines.push(type);
  return lines;
}

/** The project's searches and saved references. */
export function projectText(view) {
  if (!view.searches.length && !view.saved.length) return 'inspire: no searches in this project yet. library {topic:"inspire", search:"walking tour edit"} searches YouTube.';
  const who = (search) => (search.by === "you" ? " · by you" : search.by?.name ? ` · by ${search.by.name}` : "");
  const searches = view.searches.slice(-8).map((search) => `${search.n}) ${search.kind === "sounds" || search.kind === "shorts" ? `${search.kind} ` : ""}"${search.query}" ${search.state === "done" ? `${search.count} found` : search.state}${who(search)}`);
  const saved = view.saved.map((id) => view.refs[id]).filter(Boolean).map((ref) => `${ref.id} ${quoted(ref.title)} · ${numbersLine(ref)}`);
  return [`inspire searches (name:"forget <n>" removes one): ${searches.join(" · ")}`,
    saved.length ? `saved ${saved.length}:\n${saved.join("\n")}` : "saved: none",
    view.queue.running ? `measuring ${view.queue.running}${view.queue.waiting ? `, ${view.queue.waiting} waiting` : ""}` : null].filter(Boolean).join("\n");
}
