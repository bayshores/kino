// The direction eval (milestone B1): does an agent follow skills/kino/references/direction.md
// when it sets the brief from the chat? evals/run.mjs plays the person with scripted replies
// (pickReply) and writes a transcript; checkDirection() reads it and reports the rules below.
//
// Transcript (version 1), written by evals/run.mjs or by hand for tests:
//   { version: 1, brief: "direction-01", source: "hand-written" | "claude <cli version> <model>",
//     note?, events: [{type: "person", text} | {type: "call", tool, input, isError} | {type: "agent", text}],
//     saved: <the data of notes {action:"brief"} read at the end> }
// An "agent" event is all of the agent's text in one turn, joined with a blank line. The person
// answers only after a turn ends, so a call anywhere in a turn comes before the person's reply.
//
// kino counts only the replies the agent logs, and it cannot see the chat; this checker sees
// the whole chat, so kino_counted_replies compares the two.
//
// A direction brief (evals/briefs.json) also names `open`: the brief lines its request leaves
// unanswered. The agent must ask about those (open_lines_asked), starting with the path and the
// open question (path_then_open_question).

import { isBoardAsk } from "./board.mjs";

// At most 10 replies from the person per video (plan §3); the same limit as the server's.
export const REPLY_LIMIT = 10;
// How every playback ends (direction.md, rule 6).
const PLAYBACK_END = "what's wrong or missing?";
// The first message offers to skip the questions with these words (direction.md, rule 1).
const SKIP_OFFER = "just start";
// A playback line: "- ", "* " or "• " at the start.
const BULLET = /^\s*[-*•]\s/;

// Curly quotes and apostrophes made straight, so "don’t" and "don't" are the same words.
function straight(text) {
  return String(text ?? "").normalize("NFC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"');
}

// The form a quote is compared in: straight quotes, one space between words, no trailing
// .,!?;: and lower case. Only those differences are forgiven; a retold quote still fails.
export function normalizeQuote(text) {
  return straight(text).replace(/\s+/g, " ").trim().replace(/[.,!?;:]+$/, "").trim().toLowerCase();
}

export function isPlayback(text) {
  return straight(text).toLowerCase().includes(PLAYBACK_END);
}

const questionMarks = (text) => (String(text).match(/\?/g) ?? []).length;

// The playback's lines: the last run of bullet lines before "What's wrong or missing?" (blank
// lines inside the run are allowed). An earlier list in the same turn is not the playback.
export function playbackLines(text) {
  const lines = straight(text).split("\n");
  const end = lines.findIndex((line) => line.toLowerCase().includes(PLAYBACK_END));
  let index = (end === -1 ? lines.length : end) - 1;
  while (index >= 0 && !BULLET.test(lines[index])) index -= 1;
  const found = [];
  for (; index >= 0; index -= 1) {
    if (BULLET.test(lines[index])) found.unshift(lines[index].trim());
    else if (lines[index].trim()) break;
  }
  return found;
}

// The sentence that asks: from the start of the sentence that ends with the last "?".
export function questionOf(text) {
  const plain = straight(text);
  const end = plain.lastIndexOf("?");
  if (end === -1) return "";
  const before = plain.slice(0, end);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf("\n"));
  return plain.slice(start + 1, end + 1).trim();
}

/**
 * The person's next scripted reply to one finished agent turn, or null to end the run.
 * - `brief`: the eval brief (`replies: [{match, text}]`, `playbackReply`, `fallbackReply`; a
 *   board brief also `boardReply`).
 * - `used`: indexes of `replies` already sent; `count`: replies sent so far; `played`: the
 *   playback was answered.
 * A playback gets `playbackReply`. A turn that asks (has a "?") gets the first unused reply
 * whose `match` (a regular expression, any case) hits the question sentence, else the first
 * unused reply, else `fallbackReply`. A turn that asks nothing ends the run, and so does the
 * 10th reply (the person never sends an 11th).
 * A board brief (board: true): once the playback is answered, the brief is settled, so a turn
 * that asks holds the storyboard's open items and gets `boardReply`; a turn with kino's
 * storyboard ask ends the run, even with a "?" of the agent's own (the person answers the
 * board later).
 * Returns { kind: "playback" | "question", text, index } (index: the reply used, or null).
 */
export function pickReply(brief, turnText, { used = [], count = 0, played = false } = {}) {
  if (count >= REPLY_LIMIT) return null;
  if (brief.board && isBoardAsk(turnText)) return null;
  if (isPlayback(turnText)) return { kind: "playback", text: brief.playbackReply, index: null };
  if (!questionMarks(turnText)) return null;
  if (brief.board && played) return { kind: "question", text: brief.boardReply, index: null };
  const question = questionOf(turnText);
  const unused = (brief.replies ?? []).map((reply, index) => ({ ...reply, index })).filter((reply) => !used.includes(reply.index));
  const reply = unused.find((entry) => new RegExp(entry.match, "i").test(question)) ?? unused[0];
  return reply ? { kind: "question", text: reply.text, index: reply.index } : { kind: "question", text: brief.fallbackReply, index: null };
}

// Each quote the agent says is the person's: `you` lines in the saved brief and in every
// successful notes brief call, and each "…" on a playback line that says "you said".
function quotesClaimed(transcript, playbacks) {
  const quotes = [];
  const fromFields = (fields) => {
    for (const line of Object.values(fields ?? {}))
      if (line && line.by === "you" && typeof line.quote === "string") quotes.push(line.quote);
  };
  fromFields(transcript.saved?.brief?.fields);
  for (const event of transcript.events)
    if (event.type === "call" && event.tool === "notes" && event.input?.action === "brief" && !event.isError) fromFields(event.input.fields);
  for (const event of playbacks)
    for (const line of playbackLines(event.text))
      if (/you said/i.test(line)) for (const match of straight(line).matchAll(/"([^"]+)"/g)) quotes.push(match[1]);
  return [...new Set(quotes.map(normalizeQuote).filter(Boolean))];
}

const isBriefSave = (event) => event.type === "call" && event.tool === "notes" && event.input?.action === "brief" && !event.isError
  && event.input.fields && typeof event.input.fields === "object" && Object.keys(event.input.fields).length > 0;

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/**
 * Checks a transcript against the brief rules, for its eval brief (evals/briefs.json: `open`,
 * the lines the request leaves unanswered). Returns { passed, checks: [{id, ok, detail}] } with
 * the checks in this order (each detail is one sentence with the numbers): questions_at_most_3,
 * one_question_per_message, path_then_open_question, open_lines_asked, quotes_exact,
 * playback_5_to_8_lines, replies_at_most_10, brief_saved_before_playback, kino_counted_replies,
 * brief_confirmed.
 */
export function checkDirection(transcript, brief) {
  if (!brief || !Array.isArray(brief.open)) throw new Error("checkDirection needs the eval brief, with open: the lines its request leaves unanswered.");
  const events = transcript.events ?? [];
  const agentTurns = events.filter((event) => event.type === "agent");
  const playbacks = agentTurns.filter((event) => isPlayback(event.text));
  const questions = agentTurns.filter((event) => !isPlayback(event.text) && questionMarks(event.text) > 0);
  const persons = events.filter((event) => event.type === "person");
  const replies = Math.max(0, persons.length - 1);
  // Each reply after the request, and whether it answered a playback (the agent turn before it).
  const answered = events.flatMap((event, index) => {
    if (event.type !== "person" || index === events.findIndex((entry) => entry.type === "person")) return [];
    const asked = events.slice(0, index).findLast((entry) => entry.type === "agent");
    return [{ playback: Boolean(asked && isPlayback(asked.text)) }];
  });
  const saved = transcript.saved?.brief;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  add("questions_at_most_3", questions.length <= 3, `${questions.length} question message${questions.length === 1 ? "" : "s"}; the limit is 3.`);

  const crowded = questions.map((event, index) => ({ index: index + 1, marks: questionMarks(event.text) })).filter((entry) => entry.marks !== 1);
  add("one_question_per_message", crowded.length === 0, crowded.length
    ? `Question message ${crowded[0].index} has ${crowded[0].marks} question marks; each may ask one.`
    : `${questions.length} question message${questions.length === 1 ? "" : "s"}, one question each.`);

  // Rule 1: the first message gives the path (with the offer to skip) and asks the open question.
  const first = agentTurns[0];
  const where = first ? `The agent's first message (event ${events.indexOf(first) + 1})` : "";
  const opens = Boolean(first) && !isPlayback(first.text) && questionMarks(first.text) > 0 && straight(first.text).toLowerCase().includes(SKIP_OFFER);
  add("path_then_open_question", !brief.open.length || opens, !brief.open.length
    ? "The request left 0 lines open, so no question is needed."
    : !first ? "The agent sent 0 messages."
      : opens ? `${where} offers "${SKIP_OFFER}" and asks: "${questionOf(first.text)}"`
        : `${where} ${questionMarks(first.text) && !isPlayback(first.text) ? `asks, but makes 0 offers of "${SKIP_OFFER}"` : "asks 0 questions"}; it should give the path and ask the open question.`);

  // The lines the request left open were asked about, so kino holds them in the person's words.
  const guessed = brief.open.filter((name) => saved?.fields?.[name]?.by !== "you");
  add("open_lines_asked", guessed.length === 0, guessed.length
    ? `${plural(guessed.length, "line")} the request left open ${guessed.length === 1 ? "is" : "are"} not the person's words in kino's brief: ${guessed.join(", ")} (of ${brief.open.join(", ")}).`
    : `All ${brief.open.length} lines the request left open (${brief.open.join(", ")}) are the person's words in kino's brief.`);

  const said = persons.map((event) => normalizeQuote(event.text));
  const quotes = quotesClaimed(transcript, playbacks);
  const unsaid = quotes.filter((quote) => !said.some((text) => text.includes(quote)));
  add("quotes_exact", unsaid.length === 0, unsaid.length
    ? `${unsaid.length} of ${quotes.length} quotes ${unsaid.length === 1 ? "is" : "are"} in no message from the person, such as "${unsaid[0]}".`
    : `All ${quotes.length} quotes are word for word in the person's messages.`);

  const sizes = playbacks.map((event) => playbackLines(event.text).length);
  const badSize = sizes.findIndex((size) => size < 5 || size > 8);
  add("playback_5_to_8_lines", sizes.length > 0 && badSize === -1, !sizes.length
    ? "No playback: no agent message asks \"What's wrong or missing?\"."
    : badSize !== -1 ? `Playback ${badSize + 1} has ${sizes[badSize]} lines; the rule is 5 to 8.`
      : `${sizes.length} playback${sizes.length === 1 ? "" : "s"} of ${sizes.join(", ")} lines; the rule is 5 to 8.`);

  // The harness never sends an 11th reply, so the agent's asks are counted too: an 11th
  // question is a broken rule even when no one answers it.
  const asks = questions.length + playbacks.length;
  add("replies_at_most_10", Math.max(asks, replies) <= REPLY_LIMIT,
    `${plural(asks, "message")} asked for a reply and the person sent ${plural(replies, "reply", "replies")} after the request; the limit is ${REPLY_LIMIT}.`);

  const firstPlayback = events.findIndex((event) => event.type === "agent" && isPlayback(event.text));
  const firstSave = events.findIndex(isBriefSave);
  const savedFirst = firstSave !== -1 && (firstPlayback === -1 || firstSave < firstPlayback);
  add("brief_saved_before_playback", savedFirst, firstSave === -1
    ? "No successful notes brief call saved a line."
    : firstPlayback === -1 ? "The brief was saved (there was no playback)."
      : savedFirst ? `The brief was saved at event ${firstSave + 1}, before the first playback at event ${firstPlayback + 1}.`
        : `The first playback (event ${firstPlayback + 1}) came before the first save (event ${firstSave + 1}).`);

  // The count and its kinds: a playback answer logged as a question would never confirm.
  const counted = transcript.saved?.replies;
  const playbackReplies = answered.filter((reply) => reply.playback).length;
  const countedText = (count, playbackCount) => `${plural(count, "reply", "replies")} (${plural(playbackCount, "playback")})`;
  add("kino_counted_replies", counted?.count === replies && counted?.playbacks === playbackReplies, counted == null
    ? `kino has no reply count (no saved brief read); the transcript has ${countedText(replies, playbackReplies)}.`
    : `kino counted ${countedText(counted.count, counted.playbacks ?? 0)}; the transcript has ${countedText(replies, playbackReplies)}.`);

  // The scripted person accepts the playback, so kino's brief ends confirmed at its last revision.
  const confirmed = Boolean(saved) && saved.rev > 0 && saved.confirmedRev === saved.rev;
  add("brief_confirmed", playbackReplies > 0 && confirmed, !playbackReplies
    ? "The person answered 0 playbacks, so nothing confirmed the brief."
    : confirmed ? `kino's brief is confirmed at its last revision (r${saved.rev}) after ${plural(playbackReplies, "playback answer")}.`
      : `kino's brief is r${saved?.rev ?? 0}, confirmed at ${saved?.confirmedRev ? `r${saved.confirmedRev}` : "no revision"}, after ${plural(playbackReplies, "playback answer")}; log the yes with kind:"playback", rev and confirmed:true.`);

  return { passed: checks.every((check) => check.ok), checks };
}
