// Footage search on YouTube: the words an agent typed (or a link the person pasted) become a short,
// ranked list of candidate videos to scan. Metadata only: nothing is downloaded here, and a
// candidate's picture size is never guessed from the search (the scan's probe reads it).
// yt-dlp runs through inspire.mjs runYtDlp: no cookies, no config file, its default user agent.
import { clock, doubtOf, parseSearchLines, parseVideoInfo, refId } from "../inspire.mjs";

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

/** Why a search entry is left out: "edits", "reactions", "reviews", "live", "members only", "over 3 h", "under 5 s", or null. */
export function dropReason(entry) {
  if (LIVE.has(entry.live_status)) return "live";
  if (MEMBERS_AVAILABILITY.has(entry.availability)) return "members only";
  const title = String(entry.title ?? "");
  if (MEMBERS.test(title)) return "members only";
  if (EDIT.test(title)) return "edits";
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

// One kept search result as a candidate: a stable id, the YouTube page and license unknown.
function toCandidate(result, { given = false } = {}) {
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
  const doubt = footageDoubt(candidate);
  return doubt ? { ...candidate, doubt } : candidate;
}

/**
 * The lines of `yt-dlp --flat-playlist --dump-json ytsearchN:...` as {candidates, dropped}:
 * candidates in YouTube's order, dropped counts by reason ({edits: 2, live: 1}).
 */
export function parseFootageLines(text) {
  const candidates = [];
  const dropped = {};
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || seen.has(entry.id)) continue;
    const reason = dropReason(entry);
    if (reason) { seen.add(entry.id); dropped[reason] = (dropped[reason] ?? 0) + 1; continue; }
    const [result] = parseSearchLines(line);
    if (!result) continue;
    seen.add(entry.id);
    candidates.push(toCandidate(result));
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

/**
 * Searches YouTube for footage. `run(args, {signal})` runs yt-dlp and resolves with its output
 * (runYtDlp, or a stub in tests). A YouTube link among the words is the person's own pick: it is
 * looked up and ranked first, unfiltered. When nothing is left, the words are tried once more
 * without "4k", "raw", "clips for edits" and "hd". Answers {words, tried?, candidates, dropped}.
 */
export async function searchFootage(query, { run, count = FOOTAGE_SHOWN, signal } = {}) {
  const tokens = String(query ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const links = tokens.filter((token) => /^https:\/\//i.test(token) && refId(token));
  const words = tokens.filter((token) => !links.includes(token)).join(" ").slice(0, 120);
  if (!words && !links.length) throw new Error("A footage search needs words, such as <series> fight, or a YouTube link.");
  const wanted = Math.max(1, Math.min(FOOTAGE_SEARCH_COUNT, Math.round(count) || FOOTAGE_SHOWN));
  const given = [];
  for (const link of links) {
    const videoId = refId(link).slice(3);
    if (given.some((candidate) => candidate.videoId === videoId)) continue;
    const text = await run(["--no-playlist", "--skip-download", "--dump-json", "--ignore-no-formats-error", `https://www.youtube.com/watch?v=${videoId}`], { signal });
    given.push(toCandidate(parseVideoInfo(text, videoId), { given: true }));
  }
  const ask = async (text) => parseFootageLines(await run(["--flat-playlist", "--dump-json", `ytsearch${FOOTAGE_SEARCH_COUNT}:${text}`], { signal }));
  let found = words ? await ask(words) : { candidates: [], dropped: {} };
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

// ---- agent text -------------------------------------------------------------------------------

/** The answer when nothing was found: `Nothing for "x" (also tried "y"). Try the English title, ...`. */
export function nothingFoundText(words, tried) {
  return `Nothing for "${words}"${tried ? ` (also tried "${tried}")` : ""}. Try the English title, a character name, or source:"commons".`;
}

/** One candidate's line: `F1 <channel> (verified) · 23:40 · "<title>" · license unknown · doubt: upscaled?`. */
export function candidateLine(candidate, code) {
  const who = `${candidate.creator || "unknown channel"}${candidate.given ? " (yours)" : candidate.verified ? " (verified)" : ""}`;
  const parts = [`${code} ${who}`, clock(candidate.seconds), `"${candidate.title}"`, `license ${candidate.license}`];
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
