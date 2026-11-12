// The storyboard's chat text: what notes {action:"checkpoint", id:"board"} gives the agent to
// send as written (backend/agent/stops.mjs). It stands on its own on a phone with no pictures:
// one sentence per shot with kino's measured numbers (engine/boardMeasure.js), flagged shots and the
// agent's own calls first, at most 8 shots unless the person says "all shots".
import { EYES_UNDER_CAPTIONS, shotMeasures, TEXT_UNDER_CAPTIONS } from "../../engine/boardMeasure.js";
import { sec } from "./describe.mjs";
import { isPlainShot, isUnplannedShot } from "../../engine/board.js";

// Shots in one ask, unless the person asks for all of them.
export const ASK_SHOTS = 8;
// Plain shots named on the "Plain" line before the rest are counted.
const PLAIN_NAMED = 6;
// Flags named on the "Look at" line (each with its shots), and lapse reasons on the first line.
const LOOK_AT = 3;
const REASONS = 3;
// A quoted text is cut to this many characters.
const QUOTE = 32;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clip = (text, most) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text);
const span = (shot) => `${sec(shot.cue)}–${sec(shot.cue + shot.dur)} s`;

// Plan §12: the board stop's answer is about 120 tokens plus 35 a shot listed, besides the
// agent's own words (its calls and the brief's message line, which the board's limits bound).
// The shot sentences share their 35 tokens a shot, so a short sentence leaves room for a longer
// one: the longest is cut first (its free words: the subject, the quoted text, the sound),
// each kept between SENTENCE_MIN and SENTENCE_MAX characters; the 120 hold kino's other lines
// and the waiting_for_you lines around the ask (stops.mjs). kino counts 2.5 characters a token
// (backend/meter.mjs). B8 (2026-10-25) added 10: the first ask's sound line names where sound
// search is turned on ("in kino Settings"), so the person knows what to press.
export const ASK_TOKENS = 130;
export const SHOT_TOKENS = 35;
const CHARS_PER_TOKEN = 2.5;
// B4b: the fresh-eyes line (at most 23 tokens) and the lines after a redo or approve with notes
// (what changed as they asked, without being asked, and what they named but did not change:
// 103 tokens at the widest) are counted on their own, outside ASK_TOKENS, like the agent's lines.
export const FRESH_TOKENS = 25;
// The shape line (a guess against the footage's shape, one sentence) is counted on its own too: at most 65 tokens, only when the shapes differ.
export const SHAPE_TOKENS = 65;
export const CHANGED_TOKENS = 105;
export const SENTENCE_MAX = 150;
const SENTENCE_MIN = 60;
// A free word is cut to no fewer characters than this: a quoted text keeps more.
const SHORTEST = { what: 12, quote: 16, sound: 12 };

// "Shot 2, 1.25–3.33 s: the red dragon, 100% in crop, 4% from edge; no text." A shot's sound
// effect is named only when it has one; the ask says once what the others have. Every flag of
// the shot is said here (eyes or text under the app's captions too), so a shot the "Look at"
// line leaves out still says why it is listed first.
function writeSentence({ shot, n, measures }, { what, quote, sound }, withMove = true) {
  const under = (flag) => (measures.flags.includes(flag) ? ", under the app's captions" : "");
  let picture;
  if (shot.media === "none") picture = "no footage";
  else if (!measures.inside.length) picture = "no subject marked";
  else {
    picture = `${clip(shot.subject.what ?? "the subject", what)}, ${Math.min(...measures.inside)}% in crop`;
    if (measures.edge != null && measures.edge < 5) picture += measures.edge === 0 ? ", touching its edge" : `, ${measures.edge}% from edge`;
    if (measures.eyes != null) picture += measures.eyes < 0 || measures.eyes > 100 ? ", eyes outside it" : `, eyes ${measures.eyes}% from top${under(EYES_UNDER_CAPTIONS)}`;
  }
  const text = shot.text === "none" || !shot.text ? "no text" : `"${clip(shot.text.text, quote)}" in ${shot.text.family} ${shot.text.weight ?? 700}${under(TEXT_UNDER_CAPTIONS)}`;
  const heard = shot.sound === "none" || !shot.sound ? "" : `; sound: ${clip(shot.sound.what ?? "a sound", sound)}`;
  const move = !withMove || isPlainShot(shot) ? "" : `; move ${shot.move.name}`;
  return `Shot ${n}, ${span(shot)}: ${picture}; ${text}${heard}${move}.`;
}

// The listed shots' sentences within `room` characters in all: the longest sentence gives up 4
// characters of its longest free word at a time. The person's ask names no move (a move's name
// means little to them; the plain line and look board carry the moves).
function fitSentences(entries, room) {
  const sentences = entries.map((entry) => ({ entry, most: { what: 40, quote: QUOTE, sound: 40 }, move: false }));
  const write = (sentence) => { sentence.text = writeSentence(sentence.entry, sentence.most, sentence.move); };
  sentences.forEach(write);
  const total = () => sentences.reduce((sum, sentence) => sum + sentence.text.length + 1, 0);
  const shrinkable = (sentence, floor) => sentence.text.length > floor && Object.entries(sentence.most).some(([field, value]) => value > SHORTEST[field]);
  for (;;) {
    const over = sentences.filter((sentence) => shrinkable(sentence, SENTENCE_MAX));
    const pool = over.length ? over : total() > room ? sentences.filter((sentence) => shrinkable(sentence, SENTENCE_MIN)) : [];
    if (!pool.length) break;
    const longest = pool.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const field = Object.keys(longest.most).filter((name) => longest.most[name] > SHORTEST[name]).reduce((a, b) => (longest.most[a] >= longest.most[b] ? a : b));
    longest.most[field] = Math.max(SHORTEST[field], longest.most[field] - 4);
    write(longest);
  }
  for (;;) {
    const moves = total() > room ? sentences.filter((sentence) => sentence.move && !isPlainShot(sentence.entry.shot)) : [];
    if (!moves.length) break;
    const longest = moves.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    longest.move = false;
    write(longest);
  }
  return sentences.map((sentence) => sentence.text);
}

// "shot 2 (subject 4% from the crop edge), shots 3 and 7 (no subject marked)": every flag of the
// flagged shots, the shots that share a flag named together so the flag is said once (more than
// LOOK_AT shots are counted: they are listed first); past LOOK_AT flags, the rest are counted
// (the shots' sentences say them).
function lookAt(entries) {
  const byFlag = new Map();
  for (const entry of entries) for (const flag of entry.measures.flags) byFlag.set(flag, [...(byFlag.get(flag) ?? []), entry.n]);
  const named = [...byFlag].slice(0, LOOK_AT).map(([flag, numbers]) => numbers.length === 1 ? `shot ${numbers[0]} (${flag})`
    : numbers.length > LOOK_AT ? `${numbers.length} shots (${flag})` : `shots ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)} (${flag})`);
  const more = byFlag.size - named.length;
  return `${named.join(", ")}${more ? `, and ${plural(more, "more flag")}` : ""}`;
}

// "Plain, footage plus words: shots 3, 4 and 7." The shots that name no move, neither a designed
// one nor a chosen plain cut (move {none}: most shots should be one, so it is not flagged); null
// when none, or when no shot names a move (a board saved before moves existed).
function plainLine(shots) {
  if (!shots.some((entry) => entry.shot.move)) return null;
  const plain = shots.filter((entry) => isUnplannedShot(entry.shot)).map((entry) => entry.n);
  if (!plain.length) return null;
  if (plain.length === shots.length && shots.length > 1) return `Plain, footage plus words: all ${shots.length} shots (no designed move).`;
  const named = plain.slice(0, PLAIN_NAMED);
  const more = plain.length - named.length;
  const list = more ? `${named.join(", ")} and ${more} more` : numbers(named);
  return `Plain, footage plus words: ${plain.length === 1 ? "shot" : "shots"} ${list}.`;
}

const numbers = (list) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : `${list[0]}`);

// The sound effects in one line: with none on any shot, "No sound effects.", and on the video's
// first ask (`offer`) where to get some unless the person sent sound files: their files, or kino's
// built-in library (it needs no sound search switch).
function soundLine(shots, { soundFiles, offer }) {
  const heard = shots.filter((entry) => entry.shot.sound !== "none" && entry.shot.sound);
  if (heard.length) return heard.length === shots.length ? null : `Sound effects only on ${heard.length === 1 ? "shot" : "shots"} ${numbers(heard.map((entry) => entry.n))}.`;
  return `No sound effects.${offer && !soundFiles ? " Send me sound files, or say so and I add a few from kino's library." : ""}`;
}

// The fresh-eyes check (skills/kino/references/storyboard.md): a second agent read the board
// before the ask, or the agent's app cannot start one. "not reported" is said on the video's
// first board ask when the agent did not say (stops.mjs).
const FRESH_LINES = {
  ran: "Fresh-eyes check: ran.",
  skipped: "Fresh-eyes check: skipped (no second agent in this app).",
  "not reported": "Fresh-eyes check: not reported.",
};
// Shots named in one change line, and what-words for one shot, before the rest are counted.
const CHANGE_SHOTS = 3;
const CHANGE_WORDS = 2;

// "crop", "crop and text", "crop, text and 2 more"; with `most` 1, "crop and 3 more".
function whatWords(what, most = CHANGE_WORDS) {
  if (what.length <= most) return what.join(" and ");
  return `${what.slice(0, most).join(", ")} and ${what.length - most} more`;
}

// One change line's shots: "shots 3 and 5", "shot 7 (crop), the shot at 8–9 s (removed)", at
// most `shots` (CHANGE_SHOTS) named, then ", and N more". An entry is {n, what?} for a shot on
// the board now, or {start, end} for a removed one; with `withWhat` each shot says what changed,
// in at most `most` words.
function changeList(entries, withWhat, { most = CHANGE_WORDS, shots = CHANGE_SHOTS } = {}) {
  const named = entries.slice(0, shots);
  const more = entries.length - named.length;
  const tail = more ? `, and ${more} more` : "";
  if (!withWhat && named.every((entry) => entry.n)) {
    const places = named.map((entry) => entry.n);
    if (more) return places.length === 1 ? `shot ${places[0]} and ${more} more` : `shots ${places.join(", ")}${tail}`;
    return places.length === 1 ? `shot ${places[0]}` : `shots ${numbers(places)}`;
  }
  const name = (entry) => (entry.n ? `shot ${entry.n}${withWhat ? ` (${whatWords(entry.what, most)})` : ""}` : `the shot at ${entry.start}–${entry.end} s (removed)`);
  return `${named.map(name).join(", ")}${tail}`;
}

// The board-wide changes of round.redone (stops.mjs): "the shot order and the music", or "".
function boardWide(redone) {
  const wide = [redone.order ? "the shot order" : "", redone.music ? "the music" : ""].filter(Boolean);
  return wide.length ? numbers(wide) : "";
}

/**
 * What changed since the board the person answered (round.redone, stops.mjs): the lines, and
 * the shots to list first, in groups (asked, unasked, missed; or every changed shot when they
 * named none), each group in board order, or null when no shot changed. `places` maps a shot
 * id to its place now. A new shot order or new music is said too: after the changed shots when
 * they named none, else on a line of its own (their words may have asked for it).
 */
function redoneLines(redone, places) {
  const stop = redone.stop;
  const wide = boardWide(redone);
  const what = new Map([...(redone.changed ?? []), ...(redone.unasked ?? [])].map((entry) => [entry.id, entry.what]));
  const named = new Set(redone.named ?? []);
  const removed = redone.removed ?? [];
  const byPlace = (ids) => ids.filter((id) => places.has(id)).sort((a, b) => places.get(a) - places.get(b));
  const present = (ids) => byPlace(ids).map((id) => ({ id, n: places.get(id), what: what.get(id) ?? [] }));
  if (!named.size) {
    const changed = [...present([...what.keys()]), ...removed];
    if (!changed.length) return { lines: [wide ? `Changed since ${stop}: ${wide}.` : `Nothing changed since ${stop}.`], groups: null };
    return { lines: [`Changed since ${stop}: ${changeList(changed, true)}${wide ? `; also ${wide}` : ""}.`], groups: [changed.filter((entry) => entry.n).map((entry) => entry.id)] };
  }
  const asked = [...present(redone.asked ?? []), ...removed.filter((entry) => named.has(entry.id))];
  const unasked = [...present((redone.unasked ?? []).map((entry) => entry.id)), ...removed.filter((entry) => !named.has(entry.id))];
  const missed = present(redone.missed ?? []);
  // Up to 3 shots a list and 2 what-words a shot; when the lines would pass CHANGED_TOKENS
  // (every list full, removed shots named by their times), 1 word, then fewer shots a list.
  const write = (limits) => [
    asked.length ? `Changed as you asked in ${stop}: ${changeList(asked, false, limits)}.` : "",
    unasked.length ? `Changed without being asked: ${changeList(unasked, true, limits)}.` : "",
    missed.length ? `Named but not changed: ${changeList(missed, false, limits)}.` : "",
    wide ? `Also changed: ${wide}.` : "",
  ].filter(Boolean);
  const fits = (written) => Math.ceil(written.join("\n").length / CHARS_PER_TOKEN) <= CHANGED_TOKENS;
  const tries = [{ most: CHANGE_WORDS, shots: CHANGE_SHOTS }, { most: 1, shots: CHANGE_SHOTS }, { most: 1, shots: 2 }, { most: 1, shots: 1 }].map(write);
  const lines = tries.find(fits) ?? tries.at(-1);
  const ids = (list) => list.filter((entry) => entry.n).map((entry) => entry.id);
  // With nothing changed (only shots named but not changed), the board is listed as on a first ask.
  return { lines, groups: asked.length || unasked.length ? [ids(asked), ids(unasked), ids(missed)] : null };
}

// What is heard besides the shots' sound effects: the music layer, else the other audio layers.
function audioWords(music, audio) {
  if (music) return `music: ${music}`;
  if (!audio.length) return "no music";
  return `no music, audio: ${audio.length > 2 ? `${audio.slice(0, 2).join(", ")} and ${audio.length - 2} more` : audio.join(", ")}`;
}

/**
 * The ask for the board stop: { text, listed, flagged, total } (counts of shots).
 * `id` is the stop's id (C1); `board` document.board; `frame` the video's {width, height};
 * `seconds` its length; `music` the music layer's name or null; `audio` the names of the other
 * audio layers (a voice-over); `message` the brief's message line or null; `soundFiles` whether
 * the person sent sound files; `bans` the guessed bans to ask about (brief.mjs guessedBans);
 * `offerSound` on the video's first storyboard ask; `shape`, `crops`, `ask` and `waived` lines that
 * follow the headline (empty for none); `changed`
 * ({why: [reasons], ids: [shot ids], approved: the stop that approved the board}) after an
 * approval lapsed: this ask (`id`) is a new one. `fresh` is the fresh-eyes check ("ran",
 * "skipped", "not reported", or null for no line); `redone` (round.redone, stops.mjs) what
 * changed since a redo or approve with notes: then the shots that changed as asked come first,
 * then those changed without being asked, then those named but not changed.
 */
export function boardAsk({ id, board, frame, seconds, music = null, audio = [], message = null, idea = null, pick = [], bans = [], soundSearch = false, soundFiles = false, offerSound = false, all = false, changed = null, fresh = null, redone = null, shape = "", crops = "", ask = "", waived = "" }) {
  const shots = board.shots.map((shot, index) => ({ shot, n: index + 1, measures: shotMeasures(shot, frame) }));
  const lines = [];
  if (changed) {
    const why = changed.why ?? [];
    const more = why.length > REASONS ? `; and ${why.length - REASONS} more` : "";
    const approved = changed.approved ? ` (${changed.approved})` : "";
    lines.push(`The storyboard changed since you approved it${approved}; asking again (${id}): ${why.slice(0, REASONS).join("; ")}${more}.`);
  } else {
    lines.push(`The storyboard is ready (${id}): ${plural(shots.length, "shot")}, ${sec(seconds)} s, ${frame.width}×${frame.height}, ${audioWords(music, audio)}.`);
  }
  // Right after the headline: the shape kino guessed against the footage's, the crops it measured
  // what the person's ask points to and which shot shows it (ask.js askLine), and the findings
  // called fine (stops.mjs builds the four lines).
  lines.push(...[shape, crops, ask, waived].filter(Boolean));
  if (!changed && message) lines.push(`Brief: ${message}`);
  if (idea) lines.push(`Idea: ${idea}`);
  // The treatments to pick from (treatments.mjs), until the person picked one.
  lines.push(...pick);
  const places = new Map(shots.map((entry) => [entry.shot.id, entry.n]));
  const since = redone ? redoneLines(redone, places) : null;
  if (since) lines.push(...since.lines);
  if (board.calls?.length) lines.push(`My calls (say no to any): ${board.calls.join(" · ")}`);
  // A ban is the person's words: the ones the agent guessed are asked, never applied as gates.
  if (bans.length) lines.push(`Bans I guessed (which are yours?): ${bans.join(" · ")}`);
  if (FRESH_LINES[fresh]) lines.push(FRESH_LINES[fresh]);

  // After a redo the shots it changed (and those named) come first, in their groups; with
  // nothing changed, the board is listed as on a first ask. After a lapse only the changed
  // shots are shown again; the rest were approved as they are.
  const byId = new Map(shots.map((entry) => [entry.shot.id, entry]));
  const groups = since?.groups ? since.groups.map((group) => group.map((shotId) => byId.get(shotId))) : null;
  const changedIds = changed ? new Set(changed.ids ?? []) : null;
  if (groups && changedIds) {
    // A shot the lapse names that no group has (a cut moved past the tolerances) comes last.
    const grouped = new Set(groups.flat().map((entry) => entry.shot.id));
    groups.push(shots.filter((entry) => changedIds.has(entry.shot.id) && !grouped.has(entry.shot.id)));
  }
  // Plain shots first (flagged ones first among them), then flagged shots, then the rest.
  const flaggedFirst = (list) => {
    const rank = (entry) => (isUnplannedShot(entry.shot) ? 0 : 2) + (entry.measures.flags.length ? 0 : 1);
    return [0, 1, 2, 3].flatMap((place) => list.filter((entry) => rank(entry) === place));
  };
  let candidates, ordered;
  if (groups) {
    const first = groups.flatMap(flaggedFirst);
    const rest = shots.filter((entry) => !first.includes(entry));
    [candidates, ordered] = all ? [shots, [...first, ...flaggedFirst(rest)]] : [first, first];
  } else {
    candidates = changedIds && !all ? shots.filter((entry) => changedIds.has(entry.shot.id)) : shots;
    ordered = flaggedFirst(candidates);
  }
  // The flags in board order, so the shots that share one are named in order.
  const flagged = candidates.filter((entry) => entry.measures.flags.length).sort((a, b) => a.n - b.n);
  const plain = plainLine(shots);
  if (plain) lines.push(plain);
  if (flagged.length) lines.push(`Look at: ${lookAt(flagged)}.`);
  const listed = all ? ordered : ordered.slice(0, ASK_SHOTS);
  // The shots left out: changed ones that did not fit, and (after a lapse or a redo) the
  // unchanged ones; after a redo, the named ones that did not fit are counted on their own.
  const after = [];
  const shown = new Set(listed);
  const missed = new Set(groups ? since.groups[2] ?? [] : []);
  const leftOut = candidates.filter((entry) => !shown.has(entry));
  const namedLeft = leftOut.filter((entry) => missed.has(entry.shot.id)).length;
  const changedLeft = leftOut.length - namedLeft;
  const unchanged = shots.length - candidates.length;
  const left = [changedLeft ? plural(changedLeft, (changedIds || groups) && !all ? "more changed shot" : "more shot") : "", namedLeft ? plural(namedLeft, "more named shot") : "", unchanged ? `${unchanged} unchanged` : ""].filter(Boolean);
  if (left.length) after.push(`${left.join(" and ")}: say "all shots".`);
  const sound = soundLine(shots, { soundFiles, offer: offerSound && !changed });
  if (sound) after.push(sound);
  after.push("Reply: approve · approve with notes: ... · redo: ...");
  lines.push(...fitSentences(listed, SHOT_TOKENS * CHARS_PER_TOKEN * listed.length), ...after);
  return { text: lines.join("\n"), listed: listed.length, flagged: shots.filter((entry) => entry.measures.flags.length).length, total: shots.length };
}
