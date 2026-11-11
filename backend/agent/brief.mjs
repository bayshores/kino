// The brief: what the person told their agent in the chat about a new video, saved by the
// agent with notes {action:"brief"} (plan decision D9). Each line is marked "you" (with the
// person's exact words as the agent recorded them: kino cannot see the chat, so it cannot check
// them) or "guessed" (the agent's own call). `log` holds each reply the person gave to a
// question or a playback, as the agent logged it; that is the 10-reply count. The brief is
// confirmed when the person says a playback of its latest revision is right, or settled without
// one when the agent records no_playback ("just start", or no one can answer).
//
// Two more lines are about the person's words, not the video. `ask` is what they typed, stored as
// typed (brief.fields.ask = [{text, at}], never edited by the agent): the one place a later check
// can compare the video with what was asked. `about` is {text, by:"you", quote}: who or what the
// video is about, quoted from the ask; the first reference search uses it. Once an ask is stored,
// every by:"you" quote must be found in it or in a logged reply (quote_not_said). While no ask is
// stored a by:"you" quote is refused: store their message first. ask:"none" is the opt-out for a
// run with no person (a script, a test): a marker, shown in the playback; their quotes are then
// checked only against logged replies and stop answers.
//
// Plain data in and out, like outline.mjs: the service saves the result in the project's agent
// state (state.brief, beside the plan). Turn reverts and dashboard undo never touch it.
//
// One field is not a line of text: `style`, the style spec (style.mjs checks it, and
// engine/styleSpec.js says what check does with it). It is saved as brief.style. Like idea, saving it
// raises the revision but keeps a confirmed brief confirmed: it is the agent's reading of the
// references, shown at each stop. `treatments` is the other (treatments.mjs): 5 stories, each with
// a tension, a turn and how typical it is, or the person's pick of the 3 shown, which becomes the idea line.
// `length` is the third: the video's length in seconds that the person asked for (30, or
// {seconds:30, tolerance:1}). check holds the video to it (the assertions gate, engine/quality/rules/pacing.js),
// so a final render cannot be longer or shorter than asked. Saved as brief.length; like style, it
// raises the revision but keeps a confirmed brief confirmed.
import { needsCall } from "./needs.mjs";
import { closest } from "./refs.mjs";
import { IDEA_SPINE, STYLE_LIMITS, addRejected, cleanStyle, mergeStyle, styleProblem } from "./style.mjs";
import { OWN_PICK_CALL, cleanTreatments, originLine, pickedIdea, pickedSignature, pickedType, treatmentsProblem, treatmentsText, wordsOnly } from "./treatments.mjs";
import { directionLock, styleContext, styleLine } from "../../engine/styleSpec.js";
import { deckLine } from "../../engine/deck.js";
import { isRecord } from "../../engine/numbers.js";
import { footageMove } from "../footage-finder/step.mjs";
import { cleanControls, controlsLine, hasControls, questionsGo, skippedLine } from "./controls.mjs";

// The skip-under length of each stop without a control (stops.mjs DEFAULT_STOP_RULES): a longer
// one asks the person less, so it needs their quote.
const CONTROL_SKIP_DEFAULTS = Object.freeze({ board: 8, rough: 15, color: 15, sound: 15 });

// The brief's lines, in the order they are shown.
// idea is the agent's one creative idea for the video (ideas guide); it is shown to the person at
// each stop, so saving it alone does not need a new playback.
export const BRIEF_FIELDS = ["message", "plays_on", "made_from", "look_sound", "never", "key_moment", "idea"];
const OPTIONAL_FIELDS = ["key_moment", "idea"];
export const REQUIRED_FIELDS = BRIEF_FIELDS.filter((name) => !OPTIONAL_FIELDS.includes(name));
// The order `next:` asks about missing lines in: the open question (message) first, then look and
// sound and never, which only the person can answer, before where it plays and what it is made
// from, which the request often names ("a 24 second TikTok from skate.mp4").
const ASK_ORDER = ["message", "look_sound", "never", "plays_on", "made_from"];
// At most this many replies from the person per video (questions, playbacks, stops and, later,
// picks and style questions).
export const REPLY_LIMIT = 10;
// The direction guide asks at most this many questions, and only the open question for a video
// shorter than SHORT_VIDEO_SECONDS.
export const QUESTION_LIMIT = 3;
export const SHORT_VIDEO_SECONDS = 8;
// Before planning, the agent finds and saves this many reference edits (inspire), unless the
// video is shorter than REFERENCE_SKIP_UNDER seconds or the reference check is waived. The final
// render gate (service.mjs refuseWithoutReference) uses the same length.
export const REFERENCES_WANTED = 2;
export const REFERENCE_SKIP_UNDER = 5;
// A reply may be long (dictated on a phone); the log is kept, never sent back in an answer
// (briefData leaves it out, so 100 replies of 2,000 characters stay out of a --json answer).
export const BRIEF_LIMITS = Object.freeze({ text: 80, quote: 120, q: 300, a: 2000, reason: 80, entriesPerCall: 4, logKept: 100, ask: 2000, asksKept: 30 });
// passed_on: the person's earlier words a lead agent passed on (a brief, not a new reply); kept
// with the log but not counted as a reply or a question.
const LOG_KINDS = ["question", "playback", "rejected", "passed_on"];
const LINE_KEYS = ["text", "by", "quote"];
const LOG_KEYS = ["q", "a", "kind", "rev", "confirmed"];

/** A save the agent must change before it is kept. `code` is quote_needed, yours or bad_input. */
export class BriefError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BriefError";
    this.code = code;
    this.details = details;
  }
}

// The length line: {seconds, tolerance}. Without a tolerance it is 2% of the length, at least 0.5 s.
const LENGTH_MAX = 4 * 3600;
export const lengthTolerance = (seconds) => Math.round(Math.max(0.02 * seconds, 0.5) * 1000) / 1000;
/** The saved length as {seconds, tolerance}, or null when the brief has none. */
export function lengthTarget(brief) {
  const saved = brief?.length;
  if (!(saved?.seconds > 0)) return null;
  return { seconds: saved.seconds, tolerance: saved.tolerance ?? lengthTolerance(saved.seconds) };
}
export const lengthLine = (target) => `length: ${target.seconds} s (within ${target.tolerance} s)`;

// The length sent (seconds, or {seconds, tolerance?}) as {seconds, tolerance|null}; throws when it is not one.
function cleanLength(value) {
  const plain = typeof value === "number" ? { seconds: value } : value;
  const how = "length is the video's length in seconds (30), or {seconds:30, tolerance:1}; null removes it.";
  if (!isRecord(plain) || Object.keys(plain).some((key) => key !== "seconds" && key !== "tolerance")) throw new BriefError("bad_input", how);
  const { seconds, tolerance = null } = plain;
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= LENGTH_MAX)) throw new BriefError("bad_input", `${how} seconds is over 0 and at most ${LENGTH_MAX}.`);
  if (tolerance !== null && !(Number.isFinite(tolerance) && tolerance >= 0 && tolerance < seconds)) throw new BriefError("bad_input", `${how} tolerance is 0 or more seconds, under the length.`);
  const round = (number) => Math.round(number * 1000) / 1000;
  return { seconds: round(seconds), tolerance: tolerance === null ? null : round(tolerance) };
}

// The messages of an ask save that are not stored yet, as typed (outer spaces off). Throws BriefError.
// The ask is only added to: nothing the agent sends edits or removes a message.
function newAsks(value, current) {
  const how = 'ask is their message, pasted whole: ask:"<what they typed>" (a list of up to 4 for several messages).';
  if (value === null) throw new BriefError("yours", "ask is the person's own words; kino keeps them as typed and nothing removes them.");
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > BRIEF_LIMITS.entriesPerCall) throw new BriefError("bad_input", `${how} At most ${BRIEF_LIMITS.entriesPerCall} per call.`);
  const stored = asksOf(current).map((entry) => entry.text);
  const fresh = [];
  for (const item of list) {
    const text = typeof item === "string" ? item : isRecord(item) && Object.keys(item).every((key) => key === "text") ? item.text : null;
    const problem = textProblem("ask", text, BRIEF_LIMITS.ask);
    if (problem) throw new BriefError("bad_input", `${problem} ${how}`);
    const typed = text.trim();
    if (/^<[^<>]*>$/.test(typed)) throw new BriefError("bad_input", `${how} It still holds the placeholder ${typed}.`);
    if (!stored.includes(typed) && !fresh.includes(typed)) fresh.push(typed);
  }
  if (stored.length + fresh.length > BRIEF_LIMITS.asksKept) throw new BriefError("bad_input", `ask keeps at most ${BRIEF_LIMITS.asksKept} messages.`);
  return fresh;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const hasText = (value) => typeof value === "string" && value.trim() !== "";

// ---- the person's words: the ask, and the check that a quote was said --------------------------
/** The person's stored messages, [{text, at}], oldest first; [] when none is stored. */
export const asksOf = (brief) => (Array.isArray(brief?.fields?.ask) ? brief.fields.ask.filter((entry) => hasText(entry?.text)) : []);
export const hasAsk = (brief) => asksOf(brief).length > 0;
// ask:"none" is stored as {none: true, at}: no message of a person, on purpose.
export const asksNone = (brief) => !hasAsk(brief) && Array.isArray(brief?.fields?.ask) && brief.fields.ask.some((entry) => entry?.none === true);
/** True once their message is stored, or ask:"none" says there is no person. */
export const askGiven = (brief) => hasAsk(brief) || asksNone(brief);
const isAskNone = (value) => typeof value === "string" && value.trim().toLowerCase() === "none";
export const ASK_NONE_LINE = "ask: none (no person's words; quotes not checked)";

// The words of a text, lowercase, apostrophes kept inside a word ("don't").
const wordsOf = (text) => String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];

// Scripts written without spaces between words: a whole sentence is one "word" to wordsOf.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const squash = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * True when the quote is in one of the texts: whole words, any case; punctuation and spacing do
 * not count. A quote with no words (only emoji or symbols) or in a script written without spaces
 * has no word edges to match, so it is found as plain text (any case) instead.
 */
export function isSaid(quote, texts) {
  const need = wordsOf(quote).join(" ");
  if (need !== "" && !UNSPACED.test(quote)) return texts.some((text) => ` ${wordsOf(text).join(" ")} `.includes(` ${need} `));
  const plain = squash(quote);
  return plain !== "" && texts.some((text) => squash(text).includes(plain));
}

// The sentence of the texts that shares the most words with the quote, cut to 160 characters; "" when there is none.
function closestSentence(quote, texts) {
  const want = new Set(wordsOf(quote));
  let best = { shared: -1, sentence: "" };
  for (const text of texts) {
    for (const part of String(text).split(/(?<=[.!?])\s+|\n+/)) {
      const sentence = part.trim();
      if (!sentence) continue;
      const shared = new Set(wordsOf(sentence).filter((word) => want.has(word))).size;
      if (shared > best.shared) best = { shared, sentence };
    }
  }
  return best.sentence.slice(0, 160);
}

/**
 * What the person is known to have said, for the quote check: { texts } from the stored asks, the
 * asks sent in this call, the replies logged (so far and in this call) and `extra` (other recorded
 * answers a caller passes). `missing` is set while no ask is stored or sent (every by:"you" quote
 * is then refused); `none` while ask is "none" (only logged replies and stop answers count).
 */
function saidBy(current, sentAsks, sentNone, entries, extra) {
  const asks = [...asksOf(current).map((entry) => entry.text), ...sentAsks];
  const replies = [...(current?.log ?? []), ...entries.filter(isRecord)].filter((entry) => entry.kind !== "rejected").map((entry) => entry.a);
  const texts = [...asks, ...replies, ...extra].filter(hasText);
  if (asks.length) return { texts };
  return sentNone || asksNone(current) ? { texts, none: true } : { texts, missing: true };
}

// The refusal for a quote the person did not say, with the closest sentence they did.
function notSaid(where, quote, said) {
  if (said.missing)
    return { code: "quote_not_said", message: `${where} is their words, but no message of theirs is stored to check it against: store it first (ask:"<their message, pasted whole>"; ask:"none" when no person is giving one), then send this again. If they did not say it, send by:"guessed".`, details: { closest: null } };
  const closest = closestSentence(quote, said.texts);
  if (said.none)
    return { code: "quote_not_said", message: `${where} is not in a reply they logged. ask is "none", so nothing else can check it: log their reply (log:[{q, a}]) or send by:"guessed".`, details: { closest: closest || null } };
  return { code: "quote_not_said", message: `${where} is not in anything they said${closest ? ` (closest: "${closest}")` : ""}. Copy their exact words from their message; if they did not say it, send by:"guessed".`,
    details: { closest: closest || null } };
}

// The problem with a quote that must be their words, or null when it was said.
const quoteProblem = (where, quote, said) => (!said.missing && isSaid(quote, said.texts) ? null : notSaid(where, quote, said));

// A string field of 1 to `limit` characters, trimmed; a problem sentence when it is not.
function textProblem(where, value, limit) {
  if (typeof value !== "string" || !value.trim()) return `${where} is text of 1–${limit} characters.`;
  const length = value.trim().length;
  return length > limit ? `${where} is 1–${limit} characters (it has ${length}).` : null;
}

// The problem with one line, as { code, message, details? }, or null.
function lineProblem(name, line, current, said = null) {
  if (!BRIEF_FIELDS.includes(name) && name !== "about")
    return { code: "bad_input", message: `${name} is not a brief line; the lines are ${BRIEF_FIELDS.join(", ")}, about, ask (their message), style (the style spec), treatments, length (seconds) and controls.`, details: { didYouMean: closest(name, [...BRIEF_FIELDS, "about", "ask", "style", "treatments", "length", "controls"]) } };
  if (line === null) {
    if (current?.by === "you") return yoursProblem(name, current);
    return null;
  }
  if (!isRecord(line)) return { code: "bad_input", message: `${name} is text (your guess), {text, by:"you"|"guessed", quote?}, or null to remove it.` };
  const extra = Object.keys(line).filter((key) => !LINE_KEYS.includes(key));
  if (extra.length) return { code: "bad_input", message: `${name} takes text, by and quote, not ${extra.join(", ")}.`, details: { didYouMean: closest(extra[0], LINE_KEYS) } };
  if (line.by !== "you" && line.by !== "guessed")
    return { code: "bad_input", message: `${name}.by is "you" (the person said it; send quote) or "guessed" (your call).` };
  if (name === "about" && line.by !== "you" && !said?.none)
    return { code: "bad_input", message: 'about is who or what the video is about, in their words: by:"you" with quote (by:"guessed" only when ask is "none"). Quote the part of their message that says what it is for.' };
  // The idea line takes as many characters as a treatment's idea and style.idea, so a picked treatment fits.
  const text = textProblem(`${name}.text`, line.text, name === "idea" ? STYLE_LIMITS.idea : BRIEF_LIMITS.text);
  if (text) return { code: "bad_input", message: `${text} Keep the line short; the quote holds their words.` };
  if (line.by === "you") {
    if (!hasText(line.quote))
      return { code: "quote_needed", message: `${name} is by:"you", so it needs quote: the person's exact words from the chat, copied, not retold. If they did not say it, send by:"guessed".`,
        details: { example: { [name]: { text: line.text.trim(), by: "you", quote: "<their exact words>" } } } };
    const quote = textProblem(`${name}.quote`, line.quote, BRIEF_LIMITS.quote);
    if (quote) return { code: "bad_input", message: `${quote} Copy the part of their message that says it.` };
    // A line sent again as it is stored was accepted before (maybe quoted from earlier chat,
    // before an ask was saved): only a new or changed line is checked.
    const sameAsStored = current?.by === "you" && current.text === line.text.trim() && current.quote === line.quote.trim();
    if (said && !sameAsStored) return quoteProblem(`${name}.quote`, line.quote, said);
  } else if (hasText(line.quote))
    return { code: "bad_input", message: `${name} is by:"guessed", so it has no quote. If the person said it, send by:"you" with the quote.` };
  if (current?.by === "you" && line.by === "guessed") return yoursProblem(name, current);
  return null;
}

function yoursProblem(name, current) {
  return { code: "yours", message: `${name} is the person's ("${current.quote}"). Ask them in the chat, then save their new words with by:"you".` };
}

/**
 * Checks a save ({fields?, log?, no_playback?}) against the brief as it is now. Throws
 * BriefError for the first problem (all or nothing: one refused line refuses the call); with
 * several bad lines, details add lines: {name: code}. Returns { lines: [{name, line}],
 * log: [{q, a, kind, rev?, confirmed?}], noPlayback: reason | null }, where lines holds only real
 * changes (line null: removed) in the brief's order.
 */
export function briefChanges(current, input = {}, { said: recorded = [] } = {}) {
  const { fields, log, no_playback: noPlayback } = input;
  if (fields != null && !isRecord(fields))
    throw new BriefError("bad_input", 'fields is an object of lines: {never:{text, by:"you", quote}}; null removes a line.');
  if (log != null && !Array.isArray(log))
    throw new BriefError("bad_input", "log is a list of the person's replies: [{q, a, kind?}].");
  const sentStyle = Object.hasOwn(fields ?? {}, "style") && fields.style !== undefined;
  const sentTreatments = Object.hasOwn(fields ?? {}, "treatments") && fields.treatments !== undefined;
  const sentLength = Object.hasOwn(fields ?? {}, "length") && fields.length !== undefined;
  const sentControls = Object.hasOwn(fields ?? {}, "controls") && fields.controls !== undefined;
  const sentAsk = Object.hasOwn(fields ?? {}, "ask") && fields.ask !== undefined;
  // A pick of a treatment saves the idea line too (unless the idea is sent as well).
  const picking = sentTreatments && isRecord(fields.treatments) && fields.treatments.pick !== undefined;
  // A line sent as plain text is the agent's guess: "never":"no meme text" is {text, by:"guessed"}.
  const sent = Object.entries(fields ?? {}).filter(([name]) => !["style", "treatments", "length", "controls", "ask"].includes(name))
    .map(([name, line]) => [name, typeof line === "string" ? { text: line, by: "guessed" } : line]);
  const entries = log ?? [];
  if (!sent.length && !sentStyle && !sentTreatments && !sentLength && !sentControls && !sentAsk && !entries.length && noPlayback == null)
    throw new BriefError("bad_input", "A brief save needs a line in fields, a reply in log or no_playback; send none of them to read the brief.");

  // Every problem of the call is collected, so one resend fixes them all: [where, {code, message, details?}].
  const problems = [];
  const bad = (where, message, details) => problems.push([where, { code: "bad_input", message, ...(details ? { details } : {}) }]);
  if (noPlayback != null) {
    const problem = textProblem("no_playback", noPlayback, BRIEF_LIMITS.reason);
    if (problem) bad("no_playback", `${problem} Say why there is no playback: "just start" or "no one can answer".`);
  }
  // length: undefined when it does not change, null to remove it, else {seconds, tolerance}.
  let length;
  if (sentLength) {
    try {
      const next = fields.length === null ? null : cleanLength(fields.length);
      const before = current?.length ? { seconds: current.length.seconds, tolerance: current.length.tolerance ?? null } : null;
      if (JSON.stringify(next) !== JSON.stringify(before)) length = next;
    } catch (error) {
      if (!(error instanceof BriefError)) throw error;
      bad("length", error.message);
    }
  }
  // controls: undefined when they do not change, null to remove them all (controls.mjs).
  let controls;
  if (sentControls) {
    try {
      const next = cleanControls(fields.controls, current?.controls ?? null, CONTROL_SKIP_DEFAULTS);
      const plain = (value) => (hasControls(value) ? JSON.stringify({ stops: value.stops, skipUnder: value.skipUnder }) : null);
      if (plain(next) !== plain(current?.controls) || (next?.quote ?? null) !== (current?.controls?.quote ?? null)) controls = hasControls(next) ? next : null;
    } catch (error) {
      if (!(error instanceof BriefError)) throw error;
      problems.push(["controls", { code: error.code, message: error.message, details: error.details }]);
    }
  }
  // ask: the messages not stored yet, in the order sent (the person's words are only added).
  let ask = [];
  const askNone = sentAsk && isAskNone(fields.ask);
  if (sentAsk && !askNone) {
    try {
      ask = newAsks(fields.ask, current);
    } catch (error) {
      if (!(error instanceof BriefError)) throw error;
      problems.push(["ask", { code: error.code, message: error.message }]);
    }
  }
  // Once an ask is stored (or sent here) every by:"you" quote must be in what they said.
  const said = saidBy(current, ask, askNone, entries, recorded);
  // The quote that lets a stop pass without the person (controls) is their words too.
  const controlsProblem = controls?.quote && controls.quote !== current?.controls?.quote ? quoteProblem("controls.quote", controls.quote, said) : null;
  if (controlsProblem) problems.push(["controls", controlsProblem]);
  for (const [name, line] of sent) {
    const problem = lineProblem(name, line, current?.fields?.[name], said);
    if (problem) problems.push([name, problem]);
  }
  // A style sent over a saved one is a partial update, merged into it (style.mjs mergeStyle).
  const merged = sentStyle ? mergeStyle(fields.style, current?.style) : null;
  if (sentStyle) {
    let problem = merged.problem ?? styleProblem(merged.spec, current?.style);
    // The style's quote is their words too (it is how the direction lock is approved); a style
    // sent again with the quote it already has was accepted before.
    const styleQuote = merged.spec?.by === "you" && hasText(merged.spec.quote) ? merged.spec.quote.trim() : null;
    if (!problem && styleQuote && styleQuote !== current?.style?.quote) problem = quoteProblem("style.quote", styleQuote, said);
    if (problem) problems.push(["style", problem]);
  }
  let treatments;
  if (sentTreatments) {
    let problem = treatmentsProblem(fields.treatments, current?.treatments);
    // A pick's quote is the person's words: found in what they said, like a line's.
    // (A pick sent again as it is stored was accepted before, so it is not checked again.)
    if (!problem && picking && typeof fields.treatments.quote === "string" && fields.treatments.quote.trim() !== current?.treatments?.picked?.quote)
      problem = quoteProblem("treatments.quote", fields.treatments.quote, said);
    if (problem) problems.push(["treatments", problem]);
    else {
      treatments = cleanTreatments(fields.treatments, current?.treatments);
      if (picking && !Object.hasOwn(fields, "idea")) {
        const idea = pickedIdea(treatments);
        const ideaProblem = lineProblem("idea", idea, current?.fields?.idea, said);
        if (ideaProblem) problems.push(["idea", ideaProblem]);
        else sent.push(["idea", idea]);
      }
    }
  }

  if (entries.length > BRIEF_LIMITS.entriesPerCall)
    bad("log", `log takes at most ${BRIEF_LIMITS.entriesPerCall} replies in one call (it has ${entries.length}); log each reply when it comes.`);
  const currentRev = current?.rev ?? 0;
  const replies = entries.map((entry, index) => {
    const where = `log[${index}]`;
    const before = problems.length;
    if (!isRecord(entry)) return bad(where, `${where} is {q, a, kind?}: your question and the person's reply, word for word.`);
    const extra = Object.keys(entry).filter((key) => !LOG_KEYS.includes(key));
    if (extra.length) bad(where, `${where} takes q, a, kind, rev and confirmed, not ${extra.join(", ")}.`, { didYouMean: closest(extra[0], LOG_KEYS) });
    const kind = entry.kind ?? "question";
    if (!LOG_KINDS.includes(kind))
      bad(where, `${where}.kind is "question" (the default), "playback" (their answer to your playback), "rejected" (a: text they turned down; it joins style.rejected) or "passed_on" (a: their earlier words someone passed on to you; not a reply).`);
    // Rejected text: a is the text word for word (it joins style.rejected); q is optional, as for
    // passed-on words.
    const rejected = kind === "rejected";
    const qProblem = (rejected || kind === "passed_on") && entry.q === undefined ? null : textProblem(`${where}.q`, entry.q, BRIEF_LIMITS.q);
    if (qProblem) bad(where, qProblem);
    const aLimit = rejected ? STYLE_LIMITS.text : BRIEF_LIMITS.a;
    const aProblem = textProblem(`${where}.a`, entry.a, aLimit);
    if (aProblem) bad(where, hasText(entry.a) && entry.a.trim().length > aLimit
      ? `${aProblem} ${rejected ? "Log each turned-down text on its own." : "Log the part of their reply that answers your question, word for word."}` : aProblem);
    if (entry.rev != null || entry.confirmed != null) {
      if (kind !== "playback") bad(where, `${where}: rev and confirmed go with kind:"playback" (their answer to your playback).`);
      if (entry.confirmed != null && typeof entry.confirmed !== "boolean")
        bad(where, `${where}.confirmed is true (they said the playback is right) or false.`);
      // kino cannot tell a "yes" from a correction, so only the agent's confirmed:true confirms,
      // and only for the revision it played back (rev), which must still be the latest.
      if (entry.confirmed === true && entry.rev == null)
        bad(where, `${where} confirms a playback, so it needs rev: the brief revision you played back (the brief is r${currentRev}).`);
      if (entry.rev != null && (!Number.isInteger(entry.rev) || entry.rev < 1 || entry.rev > currentRev))
        bad(where, `${where}.rev is the brief revision you played back: ${!currentRev ? "none is saved yet" : currentRev === 1 ? "1" : `1 to ${currentRev}`} (it has ${JSON.stringify(entry.rev)}).`);
    }
    if (problems.length > before) return null;
    const reply = { q: hasText(entry.q) ? entry.q.trim() : "", a: entry.a.trim(), kind };
    if (entry.rev == null && entry.confirmed == null) return reply;
    return { ...reply, ...(entry.rev != null ? { rev: entry.rev } : {}), confirmed: entry.confirmed === true };
  });
  if (problems.length) {
    const [[, first]] = problems;
    const lines = problems.length > 1 ? { lines: Object.fromEntries(problems.map(([name, problem]) => [name, problem.code])) } : {};
    const also = problems.slice(1).map(([, problem]) => problem.message).join(" ");
    throw new BriefError(first.code, problems.length > 1 ? `${first.message} Also: ${also} (${problems.length} problems; nothing was saved.)` : first.message, { ...first.details, ...lines });
  }

  // Only real changes raise the revision: a line sent again as it is changes nothing.
  const changed = (name, line) => {
    const before = current?.fields?.[name];
    if (line === null) return Boolean(before);
    return !before || before.text !== line.text.trim() || before.by !== line.by || (before.quote ?? null) !== (line.by === "you" ? line.quote.trim() : null);
  };
  const given = Object.fromEntries(sent);
  const lines = [...BRIEF_FIELDS, "about"].filter((name) => Object.hasOwn(given, name) && changed(name, given[name]))
    .map((name) => ({ name, line: given[name] === null ? null : { text: given[name].text.trim(), by: given[name].by, ...(given[name].by === "you" ? { quote: given[name].quote.trim() } : {}) } }));
  // style: undefined when it does not change, null to remove it, else the cleaned spec.
  let style;
  if (sentStyle) {
    const next = cleanStyle(merged.spec);
    const before = current?.style ? cleanStyle(current.style) : null;
    if (JSON.stringify(next) !== JSON.stringify(before)) style = next;
  }
  // A pick's idea becomes the style spec's idea too, unless the spec has one (orderStep then
  // offers its move as the first signature).
  // Its type direction becomes style.type the same way, and a new pick replaces the type the
  // last pick saved (not one the agent or person wrote since).
  if (picking && treatments && !sentStyle) {
    const entry = treatments.list[treatments.picked.index];
    const saved = current?.style;
    const type = entry.type && (!saved?.type || saved.type === pickedType(current?.treatments)) ? entry.type : undefined;
    if (!saved?.idea || (type && type !== saved?.type))
      style = cleanStyle({ ...(saved ?? { by: "guessed" }), ...(saved?.idea ? {} : { idea: entry.idea }), ...(type ? { type } : {}) });
  }
  // A new list of 5 saved over a picked one drops the type that pick saved: the old pick is gone,
  // so the next pick must not see that type as one written since.
  const oldType = pickedType(current?.treatments);
  if (sentTreatments && !picking && treatments && !sentStyle && oldType && current.style?.type === oldType) {
    const { type, ...rest } = current.style;
    style = cleanStyle(rest);
  }
  if (treatments && JSON.stringify(treatments) === JSON.stringify(current?.treatments ?? null)) treatments = undefined;
  // A save that unlocks a locked direction says so in its first line, with why.
  const lapsed = style !== undefined || treatments ? lockLapse(current, { ...current, ...(style !== undefined ? { style } : {}), ...(treatments ? { treatments } : {}) }, merged?.dropped) : null;
  return { lines, ask, ...(askNone && !askGiven(current) ? { askNone: true } : {}), style, treatments, length, controls, log: replies, noPlayback: noPlayback == null ? null : noPlayback.trim(), ...(lapsed ? { lapsed } : {}) };
}

// Why a save turned a locked direction (directionLock) into an unlocked one, or null.
function lockLapse(before, after, dropped) {
  if (directionLock(before?.style, before) !== "locked" || directionLock(after.style, after) === "locked") return null;
  if (dropped) return `the waiver went: ${dropped} changed; waive again with a reason, or play it back`;
  const style = after.style ?? {};
  const ideaRule = Boolean(after.treatments?.picked) || style.idea !== undefined || style.signatures !== undefined;
  const gone = [!style.spine?.length && "spine", !(style.fonts && Object.keys(style.fonts).length) && "fonts",
    ideaRule && !hasText(style.idea) && "idea", ideaRule && !style.signatures?.length && "signature"].filter(Boolean);
  return gone.length ? `no ${gone.join(", ")}` : "no approval or waiver";
}

export function emptyBrief() {
  return { rev: 0, savedAt: null, confirmedRev: null, noPlayback: null, fields: {}, log: [] };
}

/**
 * Saves checked changes into the agent state (a draft from state.update). Each reply is logged
 * at the revision it answered (a playback's own rev when given). A line change raises the
 * revision, so the brief needs a new playback. A playback reply with confirmed:true confirms the
 * revision it names only while that is still the latest: a line saved since (by another agent,
 * or in this same call) is a revision the person has not seen. no_playback settles the brief
 * without one for the rest of the video.
 */
export function applyBrief(draft, changes, { now = Date.now(), client = null } = {}) {
  const brief = { ...emptyBrief(), ...draft.brief };
  const at = new Date(now).toISOString();
  for (const entry of changes.log) brief.log.push({ ...entry, rev: entry.rev ?? brief.rev, client, at });
  brief.log = brief.log.slice(-BRIEF_LIMITS.logKept);
  // The person's messages are added as typed; they are not a line, so the revision stays.
  if (changes.ask?.length) brief.fields = { ...brief.fields, ask: [...asksOf(brief), ...changes.ask.map((text) => ({ text, at }))] };
  else if (changes.askNone) brief.fields = { ...brief.fields, ask: [{ none: true, at }] };
  if (changes.lines.length || changes.style !== undefined || changes.treatments || changes.length !== undefined) {
    // Only the idea, the style spec or the treatments changed on a confirmed brief: it stays confirmed (the stops show them).
    const keepsConfirmed = isConfirmed(brief) && changes.lines.every(({ name }) => name === "idea" || name === "about");
    brief.rev += 1;
    if (keepsConfirmed) brief.confirmedRev = brief.rev;
    for (const { name, line } of changes.lines) {
      if (line) brief.fields[name] = { ...line, rev: brief.rev, client, at };
      else delete brief.fields[name];
    }
    if (changes.style) brief.style = { ...changes.style, rev: brief.rev, client, at };
    else if (changes.style === null) delete brief.style;
    if (changes.treatments) brief.treatments = { ...changes.treatments, rev: brief.rev, at };
    if (changes.length) brief.length = { ...changes.length, rev: brief.rev, client, at };
    else if (changes.length === null) delete brief.length;
  }
  if (changes.log.some((entry) => entry.confirmed && entry.rev === brief.rev)) brief.confirmedRev = brief.rev;
  // Controls are how the person wants to be asked, not what the video says: saving them keeps
  // the revision, so a confirmed brief stays confirmed.
  if (changes.controls) brief.controls = { ...changes.controls, client, at };
  else if (changes.controls === null) delete brief.controls;
  if (changes.noPlayback) brief.noPlayback = { reason: changes.noPlayback, rev: brief.rev, client, at };
  // Text the person turned down joins the style spec's never list (rejected_text gates it), as
  // notes answer {rejected} does; it is a reply, not a question. Added after a style sent in the
  // same call, so that style does not drop it.
  const rejected = changes.log.filter((entry) => entry.kind === "rejected").map((entry) => entry.a);
  // The never list keeps the newest 12: the older texts it pushed out ride on the changes, and
  // the answer (savedText) names them.
  if (rejected.length) changes.rejectedDropped = addRejected({ brief }, rejected);
  brief.savedAt = at;
  draft.brief = brief;
  return brief;
}

// A brief was saved: a line, a reply or no_playback (stops.mjs asks a stop only after one).
export const hasBrief = (brief) => Boolean(brief) && Boolean(brief.rev || brief.log?.length || brief.noPlayback);
const isConfirmed = (brief) => Boolean(brief) && brief.rev > 0 && brief.confirmedRev === brief.rev;
// Confirmed, or settled without a playback ("just start", no one can answer): no playback to come.
// The deck is dealt from then on (deck.mjs).
export const isSettled = (brief) => isConfirmed(brief) || Boolean(brief?.noPlayback);
// What the brief still lacks: `ask` (their message; ask:"none" counts) first while it is not stored,
// else `about` while no about line is saved, then each required line.
const missingLines = (brief) => [
  ...(!askGiven(brief) ? ["ask"] : !brief?.fields?.about ? ["about"] : []),
  ...REQUIRED_FIELDS.filter((name) => !brief?.fields?.[name]),
];
const briefState = (brief) => (isConfirmed(brief) ? "confirmed" : brief.noPlayback ? "no playback" : "unconfirmed");

/**
 * What the next step and the stops need to know about the video, from its document: { seconds,
 * layers, footage, width, height }. A video is one scene, so its length is the longest scene's.
 * footage: a scene (not a component) has a video layer, or, while nothing is built yet
 * (notBuilt), `media` (the media library's records, which the service passes) holds a clip
 * uploaded to this project, so the storyboard stop asks before the build. Once the video is
 * built only placed clips count, so removing them still lapses the board. The frame size is the
 * first such scene's.
 */
export function videoFacts(document, media = null) {
  const scenes = document?.scenes ?? [];
  const shown = scenes.filter((scene) => scene.isComponent !== true);
  const placed = shown.some((scene) => (scene.layers ?? []).some((layer) => layer.type === "video"));
  return {
    seconds: scenes.reduce((longest, scene) => Math.max(longest, Number(scene.duration) || 0), 0),
    layers: scenes.reduce((sum, scene) => sum + (scene.layers?.length ?? 0), 0),
    footage: placed || (notBuilt(document) && importedClip(media, document?.id)),
    width: shown[0]?.width ?? null,
    height: shown[0]?.height ?? null,
  };
}
/** Nothing is built yet: no layer but sound and video (the layers buildsSomething in service.mjs counts as building). */
export const notBuilt = (document) => (document?.scenes ?? []).every((scene) =>
  (scene.layers ?? []).every((layer) => layer.type === "audio" || layer.type === "video"));
// A clip with pictures (not sound only) uploaded to this project. Clips it only used once
// (usedInProjects, which saves never shrink) do not count.
const importedClip = (media, projectId) => Array.isArray(media) && projectId != null && media.some((item) =>
  /^video\//.test(item?.mime ?? "") && item.hasVideo !== false && item.projectId === projectId);

// Under 8 s the guide asks only the open question. A length counts only once the agent chose
// it: project create without a duration gives the scene 5 s (state.defaultLength), which says
// nothing about the video, so while the scene still has that length the video is not short.
function questionLimit(state, video) {
  const seconds = video?.seconds;
  const chosen = seconds > 0 && seconds !== state?.defaultLength;
  // The person set the questions to go (controls.mjs): no questions, the agent guesses.
  if (questionsGo(state?.brief)) return 0;
  return chosen && seconds < SHORT_VIDEO_SECONDS ? 1 : QUESTION_LIMIT;
}

/**
 * The person's replies as the agent logged them: { count, limit, questions, playbacks, stops }.
 * stops: the stops they answered (stops.mjs), in the chat or on the dashboard.
 */
export function replyCount(state) {
  const log = (state?.brief?.log ?? []).filter((entry) => entry.kind !== "passed_on");
  const playbacks = log.filter((entry) => entry.kind === "playback").length;
  const rejected = log.filter((entry) => entry.kind === "rejected").length;
  const stops = (state?.stops ?? []).filter((round) => round.answer).length;
  return { count: log.length + stops, limit: REPLY_LIMIT, questions: log.length - playbacks - rejected, playbacks, stops };
}

// The calls the brief's steps lead to ({tool, input}; next-call.mjs writes them out). Words in
// <angle brackets> are the agent's to fill in: kino cannot know them.
// A plain text line is a guess (briefChanges): the shortest call a weak agent can copy.
// A guessed never names only what the person said (their words and scope), else "none said".
const guessLine = (name) => (name === "never" ? '<only what the person said not to do, or "none said">' : `<your guess: ${name.replace("_", " ")}>`);
const briefCall = (fields) => ({ tool: "notes", input: { action: "brief", fields } });
// The first part of the order until their message is stored (orderSteps).
const ASK_STEP = Object.freeze({ step: "save their message (ask)", call: briefCall({ ask: "<their message, pasted whole>" }) });
// The call that fills every missing line at once. It carries their message (ask) and the about line
// when those are missing: about is by:"you" with their words, or a guess when ask is "none".
const guessAll = (missing, brief = null) => briefCall({
  ...(missing.includes("ask") ? { ask: ASK_STEP.call.input.fields.ask } : {}),
  ...(missing.includes("ask") || missing.includes("about") ? { about: asksNone(brief) ? { text: "<the subject>", by: "guessed" } : { text: "<the subject>", by: "you", quote: "<their words for it>" } } : {}),
  ...Object.fromEntries(ASK_ORDER.filter((name) => missing.includes(name)).map((name) => [name, guessLine(name)])),
});
// The step words for what is missing: their message first, then the about line, then the lines.
const missingStep = (missing) => (missing[0] === "ask" ? "save ask and about"
  : missing[0] === "about" ? "save about" : `guess ${plural(missing.length, "missing line")}`);
export const PLAN_CALL = (stop) => ({ tool: "notes", input: { action: "set_plan", steps: [
  "Build the whole video in one edit (compose)", "check {fix:\"auto\"}", ...(stop ? [`Ask ${stop} (notes checkpoint)`] : []),
  "look {mode:\"review\"} until every moment is reviewed", "Render final"] } });

// What the agent should do next: { step, call }. `step` is the words (status and notes brief say
// the same, but status adds the stop); `call` the exact call for it, or null when the next step
// is building (the service's build steps say which call). It reads the brief, the plan and the
// video (videoFacts), never the chat. `stop` is the first stop this video still has to ask
// (statusLines in stops.mjs): once the brief is settled, building leads to it, except the
// storyboard, which comes before building. video.references and video.referenceWaived (the
// service's directionFacts) bring in the find-references step before the plan.
export function nextMove(state, video = {}, stop = null) {
  const brief = state?.brief;
  const planned = Boolean(state?.plan?.steps?.length);
  if (!hasBrief(brief)) {
    // Nothing built yet is a new video, even with a plan set. Layers already made: a video begun
    // before briefs, or a change to it (frontend/dashboard/state.js briefRows says the same).
    // A stored ask alone does not make a brief (no revision), so only what is still missing is named.
    if (!video.layers) return { step: "new video? brief first (library guide direction)", call: briefCall({ ...guessAll(missingLines(brief), brief).input.fields, message: "<what the video must say, from the chat>" }) };
    return { step: planned ? "follow the plan" : "a change to this video needs no brief", call: null };
  }
  const { count, questions } = replyCount(state);
  const outOfReplies = count >= REPLY_LIMIT;
  const settled = isSettled(brief);
  const missing = missingLines(brief);
  // Built, checked and looked at without a playback: the agent is past it, so the brief no
  // longer holds the video back (the step still names the playback; the build steps lead).
  // Out of replies, there is no playback left to name.
  const pastPlayback = !settled && !outOfReplies && isBuilt(state, video);
  if (missing.length && !settled && !outOfReplies && !pastPlayback && questions < questionLimit(state, video)) {
    // The call guesses every missing line at once (the shortest path); asking is the agent's
    // other choice, and its answer is saved the same way (by:"you", quote).
    const name = ASK_ORDER.find((line) => missing.includes(line));
    return { step: name ? `ask about ${name}, or guess it` : missingStep(missing), call: guessAll(missing, brief) };
  }
  // One step at a time: once the lines are guessed, the next answer says to play it back.
  if (missing.length && !pastPlayback) return { step: missingStep(missing), call: guessAll(missing, brief) };
  // Past a rough first pass (over 30 layers), the direction is locked before anything else: a
  // story spine and a style bible the person approved (or the agent waived with a reason). One
  // call does it; asking the person to approve it plays the brief back too.
  const lock = lockNeeded(state, video);
  if (lock) return lock;
  if (!settled && !outOfReplies && !pastPlayback) {
    // Their answer to a playback of this revision did not confirm it: a correction to save.
    const last = brief.log.findLast((entry) => entry.kind !== "passed_on");
    if (last?.kind === "playback" && !last.confirmed && last.rev === brief.rev)
      return { step: "save their fix, then play it back", call: briefCall({ "<the line they corrected>": { text: "<their fix>", by: "you", quote: "<their words>" } }) };
    return { step: "play the brief back (5–8 lines)", call: { tool: "notes", input: { action: "brief", log: [{ q: "<the playback you sent>", a: "<their reply>", kind: "playback", rev: brief.rev, confirmed: true }] } } };
  }
  // The idea before the template: references, then treatments and the signature (orderStep).
  // Building before this step is done is refused (the service's edit gate).
  const order = orderStep(state, video);
  // Their message first: every later part (the searches, the pick) is read against it.
  if (order?.step === ASK_STEP.step) return order;
  // A footage-led brief with none of the person's clips (the service's directionFacts sets
  // video.findFootage): the footage search comes after the references and before the treatments,
  // so the ideas are built from found shots. It ends when a clip is in the project, something is
  // built, a plan is set or waive_check {code:"footage"} waives it (footageStepOn).
  const referencesOpen = order && (order.call?.tool === "look" || order.call?.input?.topic === "inspire");
  if (video.findFootage && !referencesOpen) return footageMove(state?.footage);
  if (order) return order;
  // The material against the story, before planning: video.needs is {checked} when the video has
  // footage or speech (the service's directionFacts; left out otherwise, which skips this step).
  // The call is drafted from the pick (needs.mjs needsCall): footage of its who, for its tension;
  // with video.needs.search (web search on) finding that footage is one of its options.
  if (video.needs && !video.needs.checked) return { step: "check material: notes needs", call: needsCall(brief.treatments, { search: video.needs.search === true }) };
  if (stop === "board") {
    const askBoard = { tool: "notes", input: { action: "checkpoint", id: "board" } };
    if (planned) return { step: "ask board, then follow the plan", call: askBoard };
    if (isBuilt(state, video)) return { step: `ask board, then build on${pastPlayback ? "; play the brief back then" : ""}`, call: askBoard };
    return { step: `${settled ? "notes" : "out of replies:"} set_plan, board a move per shot (library {topic:"moves"}), ask board, then build`, call: PLAN_CALL("board") };
  }
  const then = stop ? `, then ask ${stop}` : "";
  if (pastPlayback) return { step: `build on${then}; play the brief back at your next ask`, call: null };
  if (planned) return { step: `follow the plan${then}`, call: null };
  if (isBuilt(state, video)) return { step: `build on${then}`, call: null };
  if (!settled) return { step: `out of replies: set_plan, build${then}`, call: PLAN_CALL(stop) };
  return { step: stop ? `notes set_plan, build, then ask ${stop}` : "notes set_plan, then build", call: PLAN_CALL(stop) };
}

// The waiver that skips the treatments step (waive_check {code:"treatments", target:"*", reason}),
// as waive_check {code:"reference"} skips the references step. The person sees both.
export const TREATMENTS_WAIVER = "treatments";
// The idea a treatment asks for: the story in one line, from the material, not a technique. Neutral
// on purpose: the tension and turn fields carry the rest, so not every video becomes a problem ad.
const STORY_PLACEHOLDER = "<the story in one line, from this material>";

/**
 * The idea-first order a briefed video keeps before it is built: { step, call } for the first
 * part not done, or null. Taste comes from looking first: 2 saved references, each studied with
 * look {mode:"reference"}; then 5 treatments and a pick, whose idea and signature move go into
 * the style spec (style.idea, style.signatures). No brief, a video shorter than
 * REFERENCE_SKIP_UNDER and a waived part skip it. From the service's directionFacts:
 * video.references (the saved count; left out without inspire, which skips that part),
 * video.saved (their ids), video.studied (the studied ids), video.songTitle,
 * video.treatmentsWaived and video.picture.
 */
export function orderStep(state, video = {}) {
  return orderSteps(state, video, { ask: true })[0] ?? null;
}

/**
 * True while orderSteps still asks for the 5 treatments or their pick: the deck waits for the
 * pick (service deckFor), so the treatments are not the dealt cards turned into ideas. video:
 * { seconds, treatmentsWaived }.
 */
export function pickOpen(brief, video = {}) {
  return hasBrief(brief) && !(video.seconds < REFERENCE_SKIP_UNDER) && !video.treatmentsWaived && !brief.treatments?.picked;
}

// ---- the first reference search, from what the person named -------------------------------------
// Plain text rules, no language model. kino does not guess names from capital letters (people
// type asks in lowercase, and a capitalized word is often not a name). It takes only text the
// brief puts in quotes; with none, the search has a slot the agent fills with who or what the
// video is about, which the agent knows from the chat.
const NAMED_LINES = ["message", "made_from", "look_sound"];
const MAX_NAMED = 3;
const SEARCH_LIMIT = 100;
export const SUBJECT_SLOT = "<who or what it is about>";
const SONG_NOISE = /\b(?:official|lyrics?|audio|video|music video|hd|hq|4k|topic|reupload|re-upload)\b/gi;

/** The things a brief names in quotes, in order. [] when it quotes none. */
export function namedThings(brief) {
  const names = [];
  const add = (text) => {
    const name = String(text).replace(/\s+/g, " ").trim().slice(0, 40);
    if (name.length >= 2 && !names.some((have) => have.toLowerCase() === name.toLowerCase())) names.push(name);
  };
  for (const field of NAMED_LINES) {
    const text = brief?.fields?.[field]?.text;
    if (!hasText(text)) continue;
    const quotes = /(?:^|[\s(])(?:"([^"]{2,40})"|“([^”]{2,40})”|'([^']{2,40})'(?=$|[\s.,;:!?)])|‘([^’]{2,40})’)/gu;
    for (const match of text.matchAll(quotes)) add(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return names;
}

/** The brief's `about` quote cut to whole words within 40 characters (the name length above); "" when there is none. */
export function aboutWords(brief) {
  const quote = brief?.fields?.about?.quote;
  if (!hasText(quote)) return "";
  let text = "";
  for (const word of quote.trim().split(/\s+/)) {
    if ((text ? `${text} ${word}` : word).length > 40) break;
    text = text ? `${text} ${word}` : word;
  }
  return text;
}

const LINK_OR_ID =/^(?:https?:|www\.|yt:)|youtu\.?be/i;

/**
 * The title of the song a video is about, from the project's soundtrack candidates and its audio
 * media: the picked candidate the person named (its title when they gave a link or an id), else
 * the title of the longest audio of 20 s or more that is one of the candidates (so a sound effect
 * or an ambience, which is none, never counts). "" when there is none.
 */
export function songTitleOf(candidates = [], audio = []) {
  const named = candidates.find((entry) => entry.picked && entry.named);
  if (named) return LINK_OR_ID.test(String(named.named).trim()) ? String(named.title ?? "") : String(named.named);
  const songs = audio.filter((item) => item.duration >= 20 && candidates.some((entry) => entry.id === item.credit?.id)).sort((a, b) => b.duration - a.duration);
  return songs[0]?.credit?.title ?? "";
}

/**
 * The first reference search words: who or what the video is about (the brief's quoted names, at
 * most 3, else SUBJECT_SLOT for the agent to fill), the song's title when there is one, and
 * "edit". { search, withoutSong }, or null when there is no quoted name and no song (the step
 * then keeps its open placeholder). withoutSong is set only when there is a song.
 */
export function referenceSearches(brief, songTitle) {
  // A link or an id is not a title.
  const song = (LINK_OR_ID.test(String(songTitle ?? "").trim()) ? "" : String(songTitle ?? "")).replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(SONG_NOISE, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  // Names quoted in the brief's lines first; with none, the person's own subject words (about).
  const subject = aboutWords(brief);
  const named = (namedThings(brief).length ? namedThings(brief) : subject ? [subject] : [])
    .filter((name) => !song.toLowerCase().includes(name.toLowerCase())).slice(0, MAX_NAMED);
  if (!named.length && !song) return null;
  const join = (withSong) => {
    const kept = named.length ? [...named] : [SUBJECT_SLOT];
    const words = () => [...kept, ...(withSong && song ? [song] : []), "edit"].join(" ");
    while (words().length > SEARCH_LIMIT && kept.length > 1) kept.pop();
    return words().slice(0, SEARCH_LIMIT);
  };
  return { search: join(true), withoutSong: song ? join(false) : null };
}

/**
 * Every part of the order (orderStep) still open, in order: [{step, call}], [] when none. The
 * order_needed refusal names them all, so a build finds every gate in one answer. The find step's
 * search is filled from what the person named (referenceSearches; video.songTitle is the song's
 * title) and carries `alt`, the same search without the song, when there is one. The study step
 * names each saved reference not yet studied (video.studied: the studied ids) in `refs`: the
 * first REFERENCES_WANTED saved must each be studied, not one of them.
 */
export function orderSteps(state, video = {}, { ask = false } = {}) {
  const parts = openParts(state, video);
  // Their message comes before anything else in the order, and is named by `next:` (ask: true,
  // orderStep). It is not a gate: the build refusal (order_needed) lists only the parts below,
  // so a project without an ask builds as it did. It is named only while the order still has an
  // open part and the video is not built: a finished order, or a video past its first look, is
  // never held back for a message an older project never saved.
  if (ask && parts.length && !askGiven(state.brief) && !isBuilt(state, video)) return [{ ...ASK_STEP }, ...parts];
  return parts;
}

// The parts of the order still open, without their message (orderSteps adds that).
function openParts(state, video) {
  const brief = state?.brief;
  if (!hasBrief(brief) || video.seconds < REFERENCE_SKIP_UNDER) return [];
  const open = [];
  if (Number.isFinite(video.references) && !video.referenceWaived) {
    // Short words: status's two lines stay within 40 tokens (the call says how).
    if (video.references < REFERENCES_WANTED) {
      const left = REFERENCES_WANTED - video.references;
      const found = referenceSearches(brief, video.songTitle);
      const search = (words) => ({ tool: "library", input: { topic: "inspire", search: words } });
      open.push({ step: video.references ? `find ${left} more reference (inspire)` : `find ${REFERENCES_WANTED} references (inspire)`,
        call: search(found?.search ?? "<an edit like yours>"), ...(found?.withoutSong ? { alt: search(found.withoutSong) } : {}) });
    }
    if (Array.isArray(video.studied)) {
      const saved = video.saved ?? [];
      const unstudied = saved.filter((id) => !video.studied.includes(id));
      const needed = Math.max(0, REFERENCES_WANTED - (saved.length - unstudied.length));
      const refs = unstudied.slice(0, needed);
      if (!saved.length) open.push({ step: "study a reference (look)", call: { tool: "look", input: { mode: "reference", ref: "<a saved reference>" } } });
      else if (refs.length) open.push({ step: `study ${refs[0]}${refs.length > 1 ? ` +${refs.length - 1}` : ""} (look)`, refs, call: { tool: "look", input: { mode: "reference", ref: refs[0] } } });
    }
  }
  if (video.treatmentsWaived) return open;
  const treatments = brief.treatments;
  if (!treatments?.list) {
    const one = { idea: STORY_PLACEHOLDER, who: "<whose want or fear drives it: a person, a crew, a viewer, a thing>",
      tension: "<what they want, fear or wonder before the turn>", turn: "<the on-screen moment it flips>",
      move: "<the signature move>", ending: "<the last image, from this material>", type: "<the type and how it appears, from the references you studied>", p: "<0 to 1: how typical the story is>", source: "<the file or screen the move uses, and the moment>" };
    return [...open, { step: "write 5 treatments", call: briefCall({ treatments: Array.from({ length: 5 }, () => one) }) }];
  }
  const picked = treatments.picked;
  // Under "just start" the pick is the agent's own, with why (treatmentsText says what to pick).
  if (!picked && /just start/i.test(brief.noPlayback?.reason ?? "")) return [...open, { step: "pick a treatment, with why", call: briefCall({ treatments: { ...OWN_PICK_CALL } }) }];
  if (!picked) return [...open, { step: "ask their treatment pick", call: briefCall({ treatments: { pick: "<A, B or C>", quote: "<their words>" } }) }];
  // The pick's idea is copied into style.idea when it is saved (briefChanges); its move and
  // material are offered as the first signature. A pick that carries its story (tension and
  // turn) also drafts the spine in the same call: the build waits until the spine has the
  // problem, turn and payoff (purposes, never exact times). A pick saved before tension and
  // turn existed asks only the signature, as before.
  const style = brief.style ?? {};
  const entry = treatments.list[picked.index];
  const needSignature = !style.idea || !style.signatures?.length;
  const missing = entry?.tension && entry?.turn ? STORY_ROLES.filter((role) => !hasPurpose(style.spine, role)) : [];
  if (!needSignature && !missing.length) return open;
  // Beats are timed over the brief's length; else the scene's, unless it is still create's
  // default (state.defaultLength, as questionLimit), which says nothing about the video.
  const sceneSeconds = video.seconds !== state.defaultLength ? video.seconds : undefined;
  const spine = missing.length ? draftSpine(style.spine, entry, lengthTarget(brief)?.seconds ?? sceneSeconds) : null;
  // Where a saved beat moved to in the drafted spine (a signature's beat is an index).
  const beatIn = (index) => {
    const at = spine && style.spine?.length ? spine.indexOf(style.spine[index]) : -1;
    return at >= 0 ? at : (spine ?? style.spine ?? []).findIndex((beat) => beat.role === "signature");
  };
  const fields = { ...(brief.style ? {} : { by: "guessed" }) };
  if (needSignature) {
    // A source in words only (copy, a tagline) is offered the product's own picture instead:
    // video.picture, the project's largest screenshot or its clip (the service's directionFacts).
    const source = !wordsOnly(entry.source) ? entry.source : video.picture ? `${video.picture}, <the moment>` : "<a screenshot or clip of the product, and the moment>";
    const beat = beatIn(-1);
    if (!style.idea) fields.idea = entry.idea;
    fields.signatures = [{ beat: beat >= 0 ? beat : "<index of its spine beat>", what: entry.move, source, why: "<why only this product>" }];
  } else if (spine) {
    // The saved signatures follow their beat into the drafted spine.
    const moved = style.signatures.map((signature) => ({ ...signature, beat: Math.max(0, beatIn(signature.beat)) }));
    if (moved.some((signature, index) => signature.beat !== style.signatures[index].beat)) fields.signatures = moved;
  }
  if (spine) fields.spine = spine;
  const step = !needSignature ? `add the spine's ${missing.join(", ").replace(/, (\w+)$/, " and $1")} (notes brief style.spine)` : spine ? "save the signature and spine" : "save the signature";
  return [...open, { step, call: briefCall({ style: fields }) }];
}

// The beats the build waits for: what the story is about, where it flips, what it pays off.
const STORY_ROLES = ["problem", "turn", "payoff"];
// Rough shares of the runtime for the drafted beats (IDEA_SPINE); the problem starts by 10%, as
// spine_drift wants it in the first 15%. Times are rough: retiming is not another story
// (style.mjs directionChange compares roles only).
const SPINE_SHARES = { hook: [0, 0.1], problem: [0.1, 0.3], turn: [0.3, 0.45], signature: [0.45, 0.7], payoff: [0.7, 0.9], end: [0.9, 1] };
const hasPurpose = (spine, role) => (Array.isArray(spine) ? spine : []).some((beat) => beat?.role === role && typeof beat.purpose === "string" && beat.purpose.trim() !== "");

/**
 * The spine the signature step drafts from the pick, so the beats tell the picked story and not
 * another: with none saved, IDEA_SPINE over the video's seconds (30 when unknown), the hook's
 * purpose the first image of the pick's who, the problem's its tension, the turn's its turn and
 * the end's its ending (a pick from before who or ending keeps "<what the hook does>" and
 * "<what the end does>"). A saved spine is kept as it is, with each missing story beat put after
 * the last saved beat that comes before it in IDEA_SPINE.
 */
function draftSpine(saved, entry, seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
  const at = (share) => Math.round(share * total * 10) / 10;
  const purposes = { problem: entry.tension, turn: entry.turn, payoff: "<what the turn pays off>",
    ...(entry.who ? { hook: `<the first image of ${entry.who}'s story>` } : {}), ...(entry.ending ? { end: entry.ending } : {}) };
  const drafted = (role) => ({ role, from: at(SPINE_SHARES[role][0]), to: at(SPINE_SHARES[role][1]), purpose: purposes[role] ?? `<what the ${role} does>` });
  if (!Array.isArray(saved) || !saved.length) return IDEA_SPINE.map(drafted);
  const spine = [...saved];
  for (const role of STORY_ROLES) {
    if (hasPurpose(spine, role)) continue;
    const rank = IDEA_SPINE.indexOf(role);
    const before = spine.findLastIndex((beat) => IDEA_SPINE.indexOf(beat.role) >= 0 && IDEA_SPINE.indexOf(beat.role) < rank);
    spine.splice(before + 1, 0, drafted(role));
  }
  return spine;
}

// A rough first pass: up to this many layers may be built before the direction is locked.
export const ROUGH_LAYERS = 30;

/**
 * The bans the agent guessed, as the board stop asks about them: the brief's never line when it
 * is not the person's (by:"you"), and the style spec's avoids unless they are the person's words
 * (styleContext avoidsBacked: by:"you" with a quote, not copied or guessed). [] when every ban
 * is the person's.
 */
export function guessedBans(brief) {
  const never = brief?.fields?.never;
  const style = styleContext(brief?.style);
  return [
    ...(never?.text && never.by !== "you" && !/^\s*none( said)?\W*$/i.test(never.text) ? [`never: ${never.text}`] : []),
    ...(style && !style.avoidsBacked && style.avoids.length ? [`avoids: ${style.avoids.join(", ")}`] : []),
  ];
}

/**
 * The lock call: notes brief with the style spec plus a story spine and a style bible, drafted
 * from what is saved (the spec's wants and avoids, the deck's cards) so the agent fills in names
 * and times and asks the person, or waives with a reason when no one is watching. The spine is
 * drafted around the idea and its signature (IDEA_SPINE); a spine already saved (the signature
 * step drafts it before the build) is kept, and the call asks the rest of the bible: fonts, moves
 * and logo. With no idea yet (no picked treatment,
 * idea line or spec idea) the call asks for the idea and its signature moment, built from the
 * real material, before any spine: no template spine stands in for a missing idea.
 * The approval sends only by:"you" and their quote: copied or dealt lists and guessed avoids keep their source
 * (style.mjs mergeStyle), so a copied avoid or a dealt move never becomes the person's words.
 */
export function lockCall(state, { approve = false } = {}) {
  const saved = state?.brief?.style ?? {};
  const cards = (state?.deck?.cards ?? []).map((card) => card?.tag ?? card).filter((tag) => typeof tag === "string").slice(0, 3);
  const picked = pickedSignature(state?.brief?.treatments);
  const idea = saved.idea ?? state?.brief?.fields?.idea?.text ?? (picked ? "<one sentence: what only this product can show>" : null);
  // The signature beat: the saved spine's "signature" beat, else the drafted spine's.
  const beat = Math.max(0, (saved.spine ?? IDEA_SPINE.map((role) => ({ role }))).findIndex((entry) => entry.role === "signature"));
  const signatures = saved.signatures ?? [{ beat, what: picked?.what ?? "<the designed moment>",
    source: picked?.source ?? "<the material it uses, and the moment>", why: "<why only this product can show it>" }];
  // A spine and fonts are saved, the idea or its signature is missing: add just those.
  const bibleSaved = saved.spine?.length && saved.fonts && Object.keys(saved.fonts).length;
  const yours = saved.by === "you" ? { by: "you", quote: "<their words approving it>" } : {};
  if (approve) return briefCall({ style: { by: "you", quote: "<their words approving it>" } });
  if (bibleSaved || !idea) {
    // The idea first: one sentence and its signature moment from the real material, no spine yet.
    const add = { idea: idea ?? "<one sentence: what only this product can show, from its real material>", signatures };
    return briefCall({ style: saved.by ? { ...add, ...yours } : { ...add, by: "guessed" } });
  }
  // The picked treatment's type direction says what the fonts are for (the spec's type, else the pick's).
  const type = saved.type ?? pickedType(state?.brief?.treatments);
  const family = type ? `<font for: ${type}>` : "<font>";
  const fonts = { caption: { family, size: "<px>" }, display: { family, size: "<px>" } };
  // No drafted avoids: a ban is the person's words (a guessed one only warns, and the board
  // stop asks about it). Saved avoids are kept as they are.
  const kept = { ...(saved.wants?.length ? { wants: saved.wants } : {}), ...(saved.avoids?.length ? { avoids: saved.avoids } : {}) };
  const moves = {
    moves: (cards.length ? cards : ["<technique>"]).map((tag) => ({ tag, where: "<where it recurs>" })),
    // Deck cards are suggestions: they stay "dealt", never the person's style, unless they ask.
    ...(cards.length ? { sources: { ...saved.sources, moves: "dealt" } } : {}),
  };
  const logo = { asset: "<logo layer>", max: 2 };
  // A spine saved before the build (the signature step) is kept: the lock asks the rest of the
  // bible (fonts, plus the moves and logo when they are not saved yet), never the spine again.
  if (saved.spine?.length)
    return briefCall({ style: { ...kept, ...(saved.idea ? {} : { idea }), ...(saved.signatures ? {} : { signatures }), fonts,
      ...(saved.moves?.length ? {} : moves), ...(saved.logo ? {} : { logo }), ...(saved.by ? yours : { by: "guessed" }) } });
  const style = {
    ...kept,
    idea, signatures,
    spine: IDEA_SPINE.map((role) => ({ role, from: `<s>`, to: `<s>`, uses: ["<layer or media>"], purpose: `<what the ${role} does>` })),
    fonts,
    ...moves,
    // No `waived` in the draft: the agent asks the person. Waiving is for when no one is watching,
    // and the step says so; a drafted waiver would invite skipping the person.
    logo, by: "guessed", ...yours,
  };
  return briefCall({ style });
}

/** The lock step when the video is past a rough first pass and the direction is not locked, else null. */
export function lockNeeded(state, video = {}) {
  if (!hasBrief(state?.brief) || !(video.layers > ROUGH_LAYERS)) return null;
  const lock = directionLock(state.brief.style, state.brief);
  if (lock === "locked") return null;
  const style = state.brief.style;
  // No idea yet, or the bible is saved: the idea and its signature come first.
  const noIdea = !(style?.idea ?? state.brief.fields?.idea?.text ?? state.brief.treatments?.picked);
  const onlyIdea = noIdea || (style?.spine?.length && style?.fonts && Object.keys(style.fonts).length);
  return lock === "missing"
    ? { step: `lock direction: ${onlyIdea ? "idea + signature" : style?.spine?.length ? "style bible" : "spine + style bible"} (${video.layers} layers built)`, call: lockCall(state) }
    : { step: "play spine + style bible back; save their approval (no one watching: style {waived:\"<why>\"} instead)", call: lockCall(state, { approve: true }) };
}

// A video the agent built, checked and looked at: past the brief's playback and plan steps.
const isBuilt = (state, video) => video.layers > 0 && Boolean(state?.checked?.rev) && Boolean(state?.lastLook);

const nextStep = (state, video = {}, stop = null) => nextMove(state, video, stop).step;

/**
 * The two lines status shows right after its header: [direction, next]. At most 40 tokens.
 * `stop`: the first stop still to ask (statusLines in stops.mjs passes it).
 */
export function directionLines(state, video = {}, stop = null) {
  const brief = state?.brief;
  const { count, limit } = replyCount(state);
  let direction;
  if (!hasBrief(brief)) direction = "no brief";
  else if (!brief.rev) direction = brief.noPlayback ? "no brief lines, no playback" : "no brief lines";
  else {
    const guessed = Object.values(brief.fields).filter((line) => line.by === "guessed").length;
    direction = `brief r${brief.rev}${guessed ? ` (${guessed} guessed)` : ""}, ${briefState(brief)}`;
  }
  return [`direction: ${direction} · replies ${count}/${limit}`, `step: ${nextStep(state, video, stop)}`];
}

/**
 * The facts of a read or save, for programs: { brief, missing, replies, next }. `brief` is the
 * saved brief without its log (replyCount counts it); the log stays in the agent-state file.
 */
export function briefData(state, video = {}) {
  // The log and the person's messages stay out (up to 30 messages of 2,000 characters would be
  // about 14,000 tokens): `asks` is the count; the messages are in the saved state.
  const { log, ...brief } = state?.brief ?? {};
  if (brief.fields?.ask) {
    const { ask, ...fields } = brief.fields;
    brief.fields = fields;
    brief.asks = asksOf(state.brief).length;
    if (asksNone(state.brief)) brief.askNone = true;
  }
  return { brief: state?.brief ? brief : null, missing: missingLines(state?.brief), replies: replyCount(state), next: nextStep(state, video) };
}

// A line the person said reads back as their exact words only: the agent's restatement (text)
// stays saved and on the dashboard, but repeating it here would double each line's cost.
const lineText = (name, line) => (line.by === "you" ? `${name}: you said "${line.quote}"` : `${name}: guessed → ${line.text}`);

// The aspect names a person knows; a size within 4% of one is named by it, any other is "1.33:1".
const ASPECTS = [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1], ["4:5", 4 / 5], ["5:4", 5 / 4], ["4:3", 4 / 3], ["3:4", 3 / 4], ["3:2", 3 / 2], ["2:3", 2 / 3], ["21:9", 21 / 9]];
export function aspectLabel(width, height) {
  const ratio = width / height;
  const [name, value] = ASPECTS.reduce((best, entry) => (Math.abs(Math.log(ratio / entry[1])) < Math.abs(Math.log(ratio / best[1])) ? entry : best));
  return Math.abs(Math.log(ratio / value)) <= 0.04 ? name : `${ratio.toFixed(2)}:1`;
}

/**
 * The shape the video has against the shape of its footage, `shape: 9:16 (guessed), footage 16:9 (4 of 4)`:
 * the frame's aspect, whether the person said it (plays_on by "you") or it is a guess, and the aspect
 * most footage files have with how many of them. video.footageSizes is [{width, height}] for each
 * distinct video file placed in the scene. "" with no footage or no frame size: nothing to compare.
 */
export function shapeLine(brief, video = {}) {
  const sizes = (Array.isArray(video?.footageSizes) ? video.footageSizes : []).filter((size) => size?.width > 0 && size?.height > 0);
  if (!sizes.length || !(video?.width > 0 && video?.height > 0)) return "";
  const counts = new Map();
  for (const size of sizes) { const label = aspectLabel(size.width, size.height); counts.set(label, (counts.get(label) ?? 0) + 1); }
  const [label, count] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return `shape: ${aspectLabel(video.width, video.height)} (${brief?.fields?.plays_on?.by === "you" ? "you said" : "guessed"}), footage ${label} (${count} of ${sizes.length})`;
}

/** The answer to notes {action:"brief"} with nothing to save. */
export function briefText(state, video = {}) {
  const brief = state?.brief;
  const replies = replyCount(state);
  const missing = missingLines(brief);
  if (!hasBrief(brief)) {
    const save = askGiven(brief) ? "" : 'ask:"<their message, pasted whole>", ';
    return `No brief yet · replies 0 of ${REPLY_LIMIT}. Ask in the chat (library guide direction), then save: notes {action:"brief", fields:{${save}message:{text, by:"you", quote}}, log:[{q, a}]}.${hasAsk(brief) ? " Their message is saved (ask)." : asksNone(brief) ? ` ${ASK_NONE_LINE}.` : ""}\nmissing: ${missing.join(", ")}`;
  }
  return [
    `brief r${brief.rev}, ${briefState(brief)} · replies ${replies.count} of ${replies.limit} (${plural(replies.questions, "question")}, ${plural(replies.playbacks, "playback")}${replies.stops ? `, ${plural(replies.stops, "stop")}` : ""})`,
    ...BRIEF_FIELDS.filter((name) => brief.fields[name]).flatMap((name) => [lineText(name, brief.fields[name]), name === "plays_on" ? shapeLine(brief, video) : ""]),
    brief.fields.about ? lineText("about", brief.fields.about) : "",
    hasAsk(brief) ? `ask: ${plural(asksOf(brief).length, "message")} saved as typed` : asksNone(brief) ? ASK_NONE_LINE : "",
    originLine(state.origin),
    brief.style ? styleLine(brief.style) : "",
    lengthTarget(brief) ? lengthLine(lengthTarget(brief)) : "",
    treatmentsText(brief, state.origin),
    state.deck ? deckLine(state.deck) : "",
    ...(state.deck?.swaps ?? []).map((swap) => `deck swap: ${swap.out} → ${swap.in} (${swap.why})`),
    brief.noPlayback ? `no playback: ${brief.noPlayback.reason}` : "",
    controlsLine(brief.controls) ?? "",
    `missing: ${missing.length ? missing.join(", ") : "none"}`,
    `step: ${nextStep(state, video)}`,
  ].filter(Boolean).join("\n");
}

/** The answer to a save: what changed, the count, what is missing and what to do next. */
export function savedText(state, changes, video = {}) {
  const brief = state.brief;
  const replies = replyCount(state);
  const count = `replies ${replies.count} of ${replies.limit}`;
  const logged = changes.log.length ? `${plural(changes.log.length, "reply")} logged (${[...new Set(changes.log.map((entry) => entry.kind))].join(", ")})` : "";
  const skipped = changes.noPlayback ? `no playback (${changes.noPlayback})` : "";
  const asked = changes.ask?.length ? `ask saved (${plural(changes.ask.length, "message")} as typed)` : changes.askNone ? ASK_NONE_LINE : "";
  let head;
  if (changes.lines.length || changes.style !== undefined || changes.treatments || changes.length !== undefined) {
    const names = [...changes.lines, ...(changes.style !== undefined ? [{ name: "style", line: changes.style }] : []), ...(changes.length !== undefined ? [{ name: "length", line: changes.length && { label: `${changes.length.seconds} s` } }] : []), ...(changes.treatments ? [{ name: "treatments", line: { by: changes.treatments.picked?.by ?? "guessed" } }] : [])]
      .map(({ name, line }) => `${name} (${!line ? "removed" : line.label ?? (line.by === "you" ? "you said" : "guessed")})`).join(", ");
    head = [`brief r${brief.rev} saved: ${names}`, asked, changes.lapsed ? `direction lock lapsed (${changes.lapsed})` : "", logged, skipped, count].filter(Boolean).join(" · ");
  } else if (logged || skipped) head = [`brief r${brief.rev}: ${logged || skipped}`, logged ? skipped : "", asked, briefState(brief), count].filter(Boolean).join(" · ");
  else if (asked) head = `brief r${brief.rev}: ${asked} · ${count}`;
  else head = `brief r${brief.rev}: no line changed · ${count}`;
  // A "yes" to a revision that is no longer the latest confirms nothing.
  const stale = changes.log.find((entry) => entry.confirmed && entry.rev !== brief.rev);
  const missing = missingLines(brief);
  const limit = questionLimit(state, video);
  return [
    head,
    changes.style ? styleLine(brief.style) : "",
    changes.length ? `${lengthLine(lengthTarget(brief))}; check holds the video to it` : "",
    changes.treatments ? [originLine(state.origin), treatmentsText(brief, state.origin)].filter(Boolean).join("\n") : "",
    // The receipt of a controls save: what they are now, and each step they pass without the person.
    changes.controls !== undefined ? (controlsLine(brief.controls) ?? "controls removed: the person's settings ask every stop again") : "",
    changes.controls ? skippedLine(brief.controls, video?.seconds ?? 0) ?? "" : "",
    stale ? `not confirmed: they answered r${stale.rev}, and the brief is r${brief.rev} now; play it back again.` : "",
    changes.rejectedDropped?.length ? `style.rejected keeps the newest ${STYLE_LIMITS.rejected}; dropped: ${changes.rejectedDropped.map((text) => `"${text}"`).join(", ")}` : "",
    `missing: ${missing.length ? missing.join(", ") : "none"}`,
    `step: ${nextStep(state, video)}`,
    replies.questions > limit ? `questions: ${replies.questions} so far; the guide asks at most ${limit}${limit < QUESTION_LIMIT ? ` under ${SHORT_VIDEO_SECONDS} s` : ""}.` : "",
    replies.count >= REPLY_LIMIT ? `replies: ${replies.count} of ${REPLY_LIMIT}; make the remaining calls yourself and say "my call".` : "",
  ].filter(Boolean).join("\n");
}

/** What the dashboard shows (the agent data of the snapshot and of each call event). */
export function briefSummary(state) {
  const brief = state?.brief ? { ...emptyBrief(), ...state.brief } : null;
  if (!brief) return null;
  const { count, limit } = replyCount(state);
  return {
    rev: brief.rev,
    savedAt: brief.savedAt,
    confirmed: isConfirmed(brief),
    noPlayback: isConfirmed(brief) ? null : brief.noPlayback?.reason ?? null,
    lines: BRIEF_FIELDS.filter((name) => brief.fields[name]).map((name) => {
      const { text, by, quote } = brief.fields[name];
      return { name, text, by, ...(by === "you" ? { quote } : {}) };
    }),
    // The style spec as saved (wants, avoids, lines, by, quote), when there is one.
    ...(brief.style ? { style: (({ rev, client, at, ...spec }) => spec)(brief.style) } : {}),
    // The length asked for, {seconds, tolerance}, when there is one.
    ...(lengthTarget(brief) ? { length: lengthTarget(brief) } : {}),
    // The treatments (5 directions), which one was dropped, the 3 shown and the pick.
    ...(brief.treatments ? { treatments: (({ rev, at, ...saved }) => saved)(brief.treatments) } : {}),
    // The deck: its line and any swaps with their reasons.
    ...(state.deck ? { deck: { line: deckLine(state.deck), swaps: state.deck.swaps ?? [] } } : {}),
    missing: missingLines(brief),
    replies: { count, limit },
  };
}
