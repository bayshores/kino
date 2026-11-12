// Footage search on YouTube: the words an agent typed (or a link the person pasted) become a short,
// ranked list of candidate videos to scan. Metadata only: nothing is downloaded here, and a
// candidate's picture size is never guessed from the search (the scan's probe reads it).
// yt-dlp runs through inspire.mjs runYtDlp: no cookies, no config file, its default user agent.
import { call, callText } from "../agent/next-call.mjs";
import { clock, doubtOf, parseSearchLines, parseVideoInfo, refId } from "../inspire.mjs";
import { scanCall } from "./step.mjs";

/** How many results one YouTube search asks for (ytsearch20). */
export const FOOTAGE_SEARCH_COUNT = 20;
/** How many candidates an answer lists by default. */
export const FOOTAGE_SHOWN = 10;
/** Longer than this (s) is a stream recording or a compilation, not footage to scan. */
export const FOOTAGE_MAX_SECONDS = 3 * 3600;
/** Shorter than this (s) holds no usable shot. */
export const FOOTAGE_MIN_SECONDS = 5;

// Other people's edits: "AMV", "Gojo edit", "#edit", "edited by". "clips for edits" and
// "scenepack for edit" are raw footage made for editors, so they stay.
const EDIT = /\b(?:amv|mmv|gmv)\b|(?<!\bfor )(?<!\bto )\bedit(?:s|ed)?\b/i;
const REACTION = /\breact(?:s|ion|ions|ing)?\b/i;
const REVIEW = /\breviews?\b|\bexplained\b|\btier ?list\b/i;
const MEMBERS = /\bmembers?[- ]only\b/i;
const MEMBERS_AVAILABILITY = new Set(["subscriber_only", "premium_only", "needs_auth"]);
const LIVE = new Set(["is_live", "is_upcoming", "post_live"]);
// A title that claims more picture than the show was made with: often an upscale.
const UPSCALED = /\b(?:4k|8k|2160p|upscal\w*|ai[- ]?enhanced)\b/i;
// Search words that make YouTube answer nothing (one empty answer seen for a "4k" query).
const REWORD = /\b(?:clips? for edits?|4k|raw|hd)\b/gi;
// Words too common to say a channel is the show's own ("Fight Clips" is not the show).
const COMMON = new Set(["the", "and", "for", "with", "from", "fight", "scene", "scenes", "clip", "clips", "episode", "official", "full", "anime", "movie", "trailer", "opening", "ending", "edit", "edits", "raw"]);

const wordsOf = (text) => String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * True for an edit upload kept on purpose: its title has the subject's origin word and a word of
 * what the video is about (origin: {word, about}). An edit can be the only place a scene survives
 * when the show's own clips are not on YouTube; it is kept and labeled, never hidden.
 */
export function isOriginEdit(entry, origin) {
  const word = String(origin?.word ?? "").toLowerCase();
  if (!word || !EDIT.test(String(entry?.title ?? ""))) return false;
  const title = wordsOf(entry.title);
  const about = wordsOf(origin.about).filter((each) => each.length >= 3 && each !== word);
  return title.includes(word) && about.some((each) => title.includes(each));
}

/** Why a search entry is left out: "edits", "reactions", "reviews", "live", "members only", "over 3 h", "under 5 s", or null. */
export function dropReason(entry, origin = null) {
  if (LIVE.has(entry.live_status)) return "live";
  if (MEMBERS_AVAILABILITY.has(entry.availability)) return "members only";
  const title = String(entry.title ?? "");
  if (MEMBERS.test(title)) return "members only";
  if (EDIT.test(title) && !isOriginEdit(entry, origin)) return "edits";
  if (REACTION.test(title)) return "reactions";
  if (REVIEW.test(title)) return "reviews";
  const seconds = Number(entry.duration);
  if (seconds > FOOTAGE_MAX_SECONDS) return "over 3 h";
  if (Number.isFinite(seconds) && seconds > 0 && seconds < FOOTAGE_MIN_SECONDS) return "under 5 s";
  return null;
}

/** inspire's doubts about a result, plus "upscaled?" when its title claims 4K or an upscale. */
export function footageDoubt(result) {
  const doubts = [doubtOf({ title: result.title, views: result.views, verified: result.verified, duration: result.seconds })];
  if (UPSCALED.test(result.title ?? "")) doubts.push("upscaled?");
  return doubts.filter(Boolean).join(", ");
}

/** The search without "4k", "raw", "clips for edits" and "hd", or null when that changes nothing or leaves nothing. */
export function rewordQuery(words) {
  const fewer = String(words ?? "").replace(REWORD, " ").replace(/\s+/g, " ").trim();
  return fewer && fewer.toLowerCase() !== String(words ?? "").trim().toLowerCase() ? fewer : null;
}

const compact = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** True when the channel's name holds a telling word of the search ("Jujutsu Kaisen Official" for "jujutsu kaisen fight"). */
export function uploaderMatches(channel, words) {
  const name = compact(channel);
  if (name.length < 3) return false;
  return String(words ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.length >= 4 && !COMMON.has(word) && name.includes(word));
}

// One kept search result as a candidate: a stable id and the YouTube page (license "unknown" as metadata).
function toCandidate(result, { given = false, edit = false } = {}) {
  const candidate = {
    id: `clip:yt-${result.videoId}`,
    source: "youtube",
    videoId: result.videoId,
    title: result.title,
    creator: result.channel,
    seconds: result.duration,
    page: `https://www.youtube.com/watch?v=${result.videoId}`,
    license: "unknown",
    ...(result.verified ? { verified: true } : {}),
    ...(Number.isFinite(result.followers) ? { followers: result.followers } : {}),
    ...(result.views !== undefined ? { views: result.views } : {}),
    ...(given ? { given: true } : {}),
  };
  const doubt = [edit ? "edit upload" : "", footageDoubt(candidate)].filter(Boolean).join(", ");
  return doubt ? { ...candidate, doubt } : candidate;
}

/**
 * The lines of `yt-dlp --flat-playlist --dump-json ytsearchN:...` as {candidates, dropped}:
 * candidates in YouTube's order, dropped counts by reason ({edits: 2, live: 1}). `origin`
 * ({word, about}) keeps the edit uploads isOriginEdit names, with the doubt "edit upload".
 */
export function parseFootageLines(text, origin = null) {
  const candidates = [];
  const dropped = {};
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || seen.has(entry.id)) continue;
    const reason = dropReason(entry, origin);
    if (reason) { seen.add(entry.id); dropped[reason] = (dropped[reason] ?? 0) + 1; continue; }
    const [result] = parseSearchLines(line);
    if (!result) continue;
    seen.add(entry.id);
    candidates.push(toCandidate(result, { edit: isOriginEdit(entry, origin) }));
  }
  return { candidates, dropped };
}

/**
 * Candidates best first: the person's pasted link, then verified channels, then bigger channels
 * (by order of magnitude of subscribers, unknown counts as none), then channels whose name holds a
 * word of the search, then YouTube's own order.
 */
export function rankFootage(candidates, words) {
  const size = (candidate) => (candidate.followers > 0 ? Math.floor(Math.log10(candidate.followers)) : -1);
  return candidates
    .map((candidate, place) => ({ candidate, place, match: uploaderMatches(candidate.creator, words) }))
    .sort((a, b) => Number(Boolean(b.candidate.given)) - Number(Boolean(a.candidate.given))
      || Number(Boolean(b.candidate.verified)) - Number(Boolean(a.candidate.verified))
      || size(b.candidate) - size(a.candidate)
      || Number(b.match) - Number(a.match)
      || a.place - b.place)
    .map((item) => item.candidate);
}

const mergeDropped = (a, b) => {
  const all = { ...a };
  for (const [reason, count] of Object.entries(b)) all[reason] = (all[reason] ?? 0) + count;
  return all;
};

// Why a pasted link was dropped: yt-dlp's reason ("region", "members only", "age", "private"),
// "live" (no length yet), or "unavailable" (deleted, or any other failure).
function givenDropReason(error) {
  if (error?.code === "UNPLAYABLE" && error.reason) return error.reason;
  if (/has no length yet/.test(String(error?.message ?? ""))) return "live";
  return "unavailable";
}

/**
 * Searches YouTube for footage. `run(args, {signal})` runs yt-dlp and resolves with its output
 * (runYtDlp, or a stub in tests). A YouTube link among the words is the person's own pick: it is
 * looked up and ranked first, unfiltered; one that cannot play from here counts in dropped as
 * "yours: region", "yours: live" and the like. When nothing is left, the words are tried once more
 * without "4k", "raw", "clips for edits" and "hd". Answers {words, tried?, candidates, dropped}.
 * `origin` {word, about} keeps edit uploads that carry the subject's origin word (isOriginEdit).
 */
export async function searchFootage(query, { run, count = FOOTAGE_SHOWN, signal, origin = null } = {}) {
  const tokens = String(query ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const links = tokens.filter((token) => /^https:\/\//i.test(token) && refId(token));
  const words = tokens.filter((token) => !links.includes(token)).join(" ").slice(0, 120);
  if (!words && !links.length) throw new Error("A footage search needs words, such as <series> fight, or a YouTube link.");
  const wanted = Math.max(1, Math.min(FOOTAGE_SEARCH_COUNT, Math.round(count) || FOOTAGE_SHOWN));
  const given = [];
  const ownDropped = {};
  for (const link of links) {
    const videoId = refId(link).slice(3);
    if (given.some((candidate) => candidate.videoId === videoId)) continue;
    try {
      const text = await run(["--no-playlist", "--skip-download", "--dump-json", "--ignore-no-formats-error", `https://www.youtube.com/watch?v=${videoId}`], { signal });
      given.push(toCandidate(parseVideoInfo(text, videoId), { given: true }));
    } catch (error) {
      // A pasted video that cannot play here (region, members, private, live) is dropped and the
      // word search carries on. A bot check, a cancel or a missing yt-dlp stops the whole search.
      if (error?.name === "AbortError" || error?.code === "BOT_CHECK" || error?.code === "NO_YTDLP") throw error;
      const reason = `yours: ${givenDropReason(error)}`;
      ownDropped[reason] = (ownDropped[reason] ?? 0) + 1;
    }
  }
  const ask = async (text) => parseFootageLines(await run(["--flat-playlist", "--dump-json", `ytsearch${FOOTAGE_SEARCH_COUNT}:${text}`], { signal }), origin);
  let found = words ? await ask(words) : { candidates: [], dropped: {} };
  found = { ...found, dropped: mergeDropped(ownDropped, found.dropped) };
  let tried;
  const reworded = words && !found.candidates.length ? rewordQuery(words) : null;
  if (reworded) {
    const again = await ask(reworded);
    found = { candidates: again.candidates, dropped: mergeDropped(found.dropped, again.dropped) };
    tried = reworded;
  }
  const others = found.candidates.filter((candidate) => !given.some((own) => own.videoId === candidate.videoId));
  const candidates = rankFootage([...given, ...others], words).slice(0, Math.max(wanted, given.length));
  return { words: words || links.join(" "), ...(tried ? { tried } : {}), candidates, dropped: found.dropped };
}

// ---- someone else's edit ----------------------------------------------------------------------

// measuredDoubt's words for a patch that stays in place (a watermark, another app's frame).
const STAYS = /^(?:"[^"]*"|a patch) stays in place \d+%/;

/**
 * What a project's inspire already knows, from inspire's projectView: {listed: ids of the video
 * searches' results, saved: the saved references, patch: {id: "a patch stays in place 92%"}} for a
 * measured study that shows a persistent patch outside a corner (inspire.mjs measuredDoubt drops
 * a maker's small corner tag). Sound searches are left out: their results are never footage.
 */
export function knownEdits(view) {
  const listed = new Set();
  for (const search of view?.searches ?? []) if (search.kind !== "sounds") for (const id of search.ids ?? []) listed.add(id);
  const patch = {};
  for (const [id, ref] of Object.entries(view?.refs ?? {})) {
    const found = String(ref?.measuredDoubt ?? "").split("; ").find((doubt) => STAYS.test(doubt));
    if (found) patch[id] = found.replace(/ \(.*$/, "");
  }
  return { listed, saved: new Set(view?.saved ?? []), patch };
}

/**
 * Why a YouTube candidate is probably another editor's finished edit, or null: the person saved it
 * as a reference ("saved as a reference"), inspire listed it for this project ("listed by inspire
 * as an edit"), or its stored study shows a patch that stays in place. A flag, never a ban.
 */
export function someoneElses(candidate, known) {
  if (!known || candidate?.source !== "youtube" || !candidate.videoId) return null;
  const id = `yt:${candidate.videoId}`;
  const patch = known.patch?.[id];
  if (known.saved?.has(id)) return { id, saved: true, why: "saved as a reference" };
  if (known.listed?.has(id)) return { id, why: "listed by inspire as an edit" };
  return patch ? { id, why: `measured as another editor's frame (${patch})` } : null;
}

/** The candidates with someone else's edits after the rest, each group in its order. */
export const editsLast = (candidates, known) => known
  ? [...candidates].sort((a, b) => Number(Boolean(someoneElses(a, known)) && !a.given) - Number(Boolean(someoneElses(b, known)) && !b.given))
  : candidates;

/**
 * The one line for a candidate that is someone else's edit, or "": its code, id and why, then the
 * two choices (study it as a reference, or pick another clip). The clip stays usable.
 */
export function elsewhereLine(candidate, known) {
  const edit = someoneElses(candidate, known);
  if (!edit) return "";
  const pick = `pick another clip (${callText(call("library", { topic: "footage" }))} lists them)`;
  return edit.saved
    ? `${candidate.code} is ${edit.id}, ${edit.why}: its picture is another editor's work, so ${pick}.`
    : `${candidate.code} is ${edit.id}, ${edit.why}: study it as a reference (${callText(call("library", { topic: "inspire", name: `save ${edit.id}` }))}) or ${pick}.`;
}

/**
 * When fewer than half of the listed candidates are scanned (and one is): `Found 10, scanned 2:
 * scan the next with library {...}.` The next is the first unscanned one that is not someone
 * else's edit, noted "no" or imported. "" otherwise.
 */
export function scannedLine(listed, known = null) {
  const scanned = listed.filter((candidate) => candidate.scan).length;
  if (!scanned || scanned * 2 >= listed.length) return "";
  const next = listed.find((candidate) => !candidate.scan && !candidate.imported && candidate.note?.verdict !== "no" && !someoneElses(candidate, known));
  return next ? `Found ${listed.length}, scanned ${scanned}: scan the next with ${callText(scanCall(next.code))}.` : "";
}

// ---- agent text -------------------------------------------------------------------------------

/** The answer when nothing was found: `Nothing for "x" (also tried "y"). Try the English title, ...`. */
export function nothingFoundText(words, tried) {
  return `Nothing for "${words}"${tried ? ` (also tried "${tried}")` : ""}. Try the English title, a character name, or source:"commons".`;
}

/** One candidate's line: `F1 <channel> (verified) · 23:40 · "<title>" · doubt: upscaled?` (a stated license, as Commons gives, after the title). */
export function candidateLine(candidate, code) {
  const who = `${candidate.creator || "unknown channel"}${candidate.given ? " (yours)" : candidate.verified ? " (verified)" : ""}`;
  const parts = [`${code} ${who}`, clock(candidate.seconds), `"${candidate.title}"`];
  if (candidate.license && candidate.license !== "unknown") parts.push(candidate.license);
  if (candidate.doubt) parts.push(`doubt: ${candidate.doubt}`);
  return parts.join(" · ");
}

/** What a search left out: `Dropped 6: 3 edits, 2 reactions, 1 live.`, or "" when nothing. */
export function droppedLine(dropped = {}) {
  const entries = Object.entries(dropped).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "";
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return `Dropped ${total}: ${entries.map(([reason, count]) => `${count} ${reason}`).join(", ")}.`;
}
