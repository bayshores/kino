// The approved storyboard (direction plan §5): when the person approves the board stop, kino
// keeps a frozen copy of the board in the agent state (state.boards). Later edits are compared
// with that copy, field by field, so many small nudges cannot add up to a board nobody saw:
// a change past kino's tolerances lapses the approval (the agent asks again, and the person sees
// only the changed shots); a smaller one is logged, one line each ("revision: shot 5 cut moved 3
// frames onto a beat"). Once the person answered a later stop (rough, color or sound) after the
// approval, the board is built and later changes are that stop's to review: the approval no
// longer lapses, and changes past the tolerances are logged too (laterAnswer).
//
// Plain data in and out, like stops.mjs: the service calls settleBoard inside its agent-state
// updates (after an edit, revert or restore that changed the board, and before status and the
// stops decide), and stops.mjs calls freezeBoard when a board round passes.
import { boardCoverage, boardSpan, mainScene, NONE, ONE_FRAME } from "../../engine/board.js";
import { sec } from "./describe.mjs";

export const BOARD_FPS = 30;
// A cut, in-point or end that moved more than this many frames lapses the approval.
export const CUT_FRAMES = 6;
// A crop edge that moved, or a crop whose width changed, by more than this % of the video's
// width lapses the approval (and counts as a changed crop after a redo: shotChanges).
export const CROP_SHARE = 5;
// The person's reply that leaves the board's open items to the agent ("your call"), unless it
// says the opposite ("that's not your call", "it isn't your call", "never your call").
export const YOUR_CALL = /\byour call\b/i;
const NOT_YOUR_CALL = /(?:\bnot|n['’]t|\bnever)\s+(?:(?:really|quite|just|entirely|actually|all)\s+)?your call\b/i;
export const leavesItToYou = (words) => YOUR_CALL.test(words) && !NOT_YOUR_CALL.test(words);
// A board approved with only these words handed the whole board over: later changes, a removed
// shot or another song too, are logged on the approval (shown on the dashboard and with the final
// render) and never asked again. A first pass lost a viewer's fix to that ask: it waived the fix.
const HANDED_OVER = /^\s*(?:it'?s\s+)?(?:your call|up to you|you decide|you pick|whatever you think)[\s.!]*$/i;
export const handedOver = (round) => round?.answer?.via === "chat" && typeof round.answer.words === "string" && HANDED_OVER.test(round.answer.words);
const BOARDS_KEPT = 20;
const REVISIONS_KEPT = 50;
const REVISIONS_SHOWN = 10;
// Fields of a shot whose change lapses the approval, in the order they are named.
const LAPSING = ["media", "text", "sound", "pacing", "follow", "move"];
const PASSING_READS = ["approve", "approve with notes"];
// The stops after the storyboard; one the person answered after the approval supersedes its lapse.
const LATER_KINDS = ["rough", "color", "sound"];
// After a later stop, only these still lapse the board: the person would not recognize the video.
const MAJOR = /music|shot order changed|removed|added|media changed|sound changed/;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const frames = (a, b) => Math.round(Math.abs(a - b) * BOARD_FPS);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * What the board stop and the lapse rules need from a document: { board, frame: {width, height},
 * seconds, span, coverage, beats, audio, musicFile }. board is null without one; beats are the
 * times of the document's beat cues (detect_beats), for "onto a beat"; audio the names of the
 * main scene's audio layers that are not the board's music (a voice-over), so the ask can say
 * what is heard; musicFile the file the board's music layer plays (null without one).
 */
export function boardFacts(document) {
  const scene = mainScene(document);
  const board = document?.board ?? null;
  const span = board ? boardSpan(document, board) : null;
  const music = board && board.music !== NONE ? (scene?.layers ?? []).find((layer) => layer.id === board.music) : null;
  return {
    board,
    frame: { width: scene?.width ?? 0, height: scene?.height ?? 0 },
    seconds: Number(scene?.duration) || 0,
    span,
    coverage: board ? boardCoverage(board, span) : null,
    beats: (document?.cues ?? []).filter((cue) => cue.kind === "beat").map((cue) => cue.time),
    audio: (scene?.layers ?? []).filter((layer) => layer.type === "audio" && layer.id !== board?.music).map((layer) => layer.name || layer.id),
    musicFile: music?.src ?? null,
  };
}

/** What a save must change to matter to the approved board: the board, its gap, its music file. */
export function boardPrint(document) {
  const facts = boardFacts(document);
  return JSON.stringify([facts.board, facts.coverage, facts.musicFile]);
}

// How a crop changed, seen in the video's frame, as % of its width (one decimal): `moved`, the
// edge that moved most (left and right by the copy's crop width, top and bottom by its height,
// times H / W), and `resized`, how much its width changed (a zoom kept centered moves each edge
// only half as far).
function cropChange(before, after, frame) {
  const [x, y, w, h] = before;
  const [x2, y2, w2, h2] = after;
  const tall = frame.width > 0 ? frame.height / frame.width : 1;
  const edges = [Math.abs(x2 - x) / w, Math.abs(x2 + w2 - (x + w)) / w, (Math.abs(y2 - y) / h) * tall, (Math.abs(y2 + h2 - (y + h)) / h) * tall];
  const share = (value) => Number((value * 100).toFixed(1));
  return { moved: share(Math.max(...edges)), resized: share(Math.abs(w2 - w) / w) };
}

const nearBeat = (time, beats) => beats.find((beat) => Math.abs(time - beat) <= ONE_FRAME + 1e-9);

/**
 * The board now compared with the approved copy: { lapse: [why], revisions: ["revision: …"],
 * changed: [ids of shots whose change lapses] }. Shots are matched by id (the board op keeps a
 * shot's id when the agent sends the board again without ids: engine/board.js keepShotIds); `n`
 * is a shot's place now, and a removed shot is named by its time in the approved board, so its
 * old place is not read as another shot's.
 */
export function boardChanges(copy, board, { frame = { width: 1, height: 1 }, beats = [] } = {}) {
  const lapse = [], revisions = [], changed = new Set();
  if (!board) return { lapse: ["board removed"], revisions, changed: [] };
  const place = new Map(board.shots.map((shot, index) => [shot.id, index + 1]));
  const old = new Map(copy.shots.map((shot) => [shot.id, shot]));
  const oldNext = new Map(copy.shots.map((shot, index) => [shot.id, copy.shots[index + 1]?.id ?? null]));
  if (copy.music !== board.music) lapse.push("music changed");
  const kept = (list, other) => list.map((shot) => shot.id).filter((id) => other.has(id));
  if (!same(kept(copy.shots, place), kept(board.shots, old))) lapse.push("shot order changed");
  for (const shot of copy.shots) if (!place.has(shot.id)) lapse.push(`the shot at ${sec(shot.cue)}–${sec(shot.cue + shot.dur)} s removed`);
  const revision = (line) => revisions.push(`revision: ${line}`);
  // A time that moved: over CUT_FRAMES lapses, 1 to CUT_FRAMES frames is a revision.
  const moved = (id, n, what, before, after, beatCheck) => {
    const count = frames(before, after);
    if (!count) return;
    const line = `shot ${n} ${what} moved ${plural(count, "frame")}`;
    if (count > CUT_FRAMES) { lapse.push(line); changed.add(id); return; }
    const beat = beatCheck ? nearBeat(after, beats) : undefined;
    revision(beat !== undefined && Math.abs(before - beat) > ONE_FRAME + 1e-9 ? `${line} onto a beat` : line);
  };
  for (const [index, shot] of board.shots.entries()) {
    const n = place.get(shot.id);
    const before = old.get(shot.id);
    if (!before) { lapse.push(`shot ${n} added`); changed.add(shot.id); continue; }
    for (const field of LAPSING) if (!same(before[field], shot[field])) { lapse.push(`shot ${n} ${field} changed`); changed.add(shot.id); }
    moved(shot.id, n, "cut", before.cue, shot.cue, true);
    // Its end. When the same shot follows it in both boards, the end is that shot's cut (named
    // there), and a shot that got longer or shorter past the tolerance is listed as changed too;
    // otherwise (the last shot, or a neighbor added or removed) the end is named here.
    const next = board.shots[index + 1]?.id ?? null;
    const [endBefore, endNow] = [before.cue + before.dur, shot.cue + shot.dur];
    if (next === null || next !== oldNext.get(shot.id)) moved(shot.id, n, "end", endBefore, endNow, false);
    else if (frames(endBefore, endNow) > CUT_FRAMES) changed.add(shot.id);
    if (typeof before.in === "number" && typeof shot.in === "number") moved(shot.id, n, "in-point", before.in, shot.in, false);
    if (!Array.isArray(before.crop) || !Array.isArray(shot.crop)) {
      if (before.crop !== shot.crop) { lapse.push(`shot ${n} crop changed`); changed.add(shot.id); }
    } else {
      const { moved: edge, resized } = cropChange(before.crop, shot.crop, frame);
      const how = [edge > 0 ? `moved ${edge}%` : "", resized > 0 ? `resized ${resized}%` : ""].filter(Boolean).join(" and ");
      const line = `shot ${n} crop ${how} of the frame width`;
      if (edge > CROP_SHARE || resized > CROP_SHARE) { lapse.push(line); changed.add(shot.id); }
      else if (how) revision(line);
    }
    if (!same(before.subject, shot.subject)) revision(`shot ${n} subject changed`);
    if (before.why !== shot.why) revision(`shot ${n} reason changed`);
    if (!same(before.alts ?? [], shot.alts ?? [])) revision(`shot ${n} options changed`);
  }
  if (!same(copy.calls ?? [], board.calls ?? [])) revision("my calls changed");
  // A new question for the person lapses it: the board stop asks it before building. Answered
  // (removed) items are only logged.
  const added = (board.open ?? []).filter((item) => !(copy.open ?? []).includes(item));
  if (added.length) lapse.push(`${plural(added.length, "open item")} added`);
  else if (!same(copy.open ?? [], board.open ?? [])) revision("open items changed");
  return { lapse, revisions, changed: [...changed] };
}

// Why the board no longer stands on the approval, worked out now: its changes past kino's
// tolerances (with the music layer's file: another song, or none), then a gap or overlap the
// video or music made (a longer video, a moved music layer) as `gaps`. `facts` is
// boardFacts(document) (frame, beats, coverage, musicFile).
function lapseNow(approval, board, facts) {
  const changes = boardChanges(approval.copy, board, facts);
  // An entry frozen from a bare board (no facts) has no music file to compare.
  if (board && approval.musicFile !== undefined && approval.copy.music !== NONE && approval.copy.music === board.music && approval.musicFile !== (facts.musicFile ?? null))
    changes.lapse.unshift(facts.musicFile ? "music file changed" : "music removed");
  const coverage = facts.coverage;
  const gaps = coverage ? [`${coverage.code === "gap" ? "a gap" : "an overlap"} at ${sec(coverage.at[0])}–${sec(coverage.at[1])} s`] : [];
  return { ...changes, gaps, lapse: [...changes.lapse, ...gaps] };
}

/**
 * The approval the board stands on: the frozen entry of the latest board round when that round
 * passed (allowed by the person's settings, or answered approve or approve with notes), else
 * null. A redo, a round still waiting or one that lapsed has none. The entry may itself have
 * lapsed (entry.lapsed): the agent then asks the board again.
 */
export function activeApproval(state) {
  const round = (state?.stops ?? []).findLast((entry) => entry.kind === "board");
  if (!round) return null;
  const passed = round.status === "allowed" || (round.status === "answered" && PASSING_READS.includes(round.answer?.read_as));
  if (!passed) return null;
  return (state.boards ?? []).findLast((entry) => entry.stop === round.id) ?? null;
}

// `board` is boardFacts(document) or the document's board itself.
const isFacts = (value) => Boolean(value && "frame" in value && "span" in value);
const boardOf = (value) => (isFacts(value) ? value.board : value) ?? null;

/**
 * A board round passed: keeps a copy of the board it showed (state.boards; the last 20), and the
 * file its music layer played (musicFile, from boardFacts). An approval adds an entry and never
 * changes one; the copy is never changed after this.
 * by: "chat" (the agent recorded the person's reply), "settings" or "dashboard".
 */
export function freezeBoard(draft, round, { board, by, now = Date.now() }) {
  const shown = boardOf(board);
  if (!shown) return null;
  const entry = { stop: round.id, board: shown.rev, rev: round.rev, at: new Date(now).toISOString(), by, read_as: round.answer?.read_as ?? null,
    ...(isFacts(board) ? { musicFile: board.musicFile ?? null } : {}), copy: structuredClone(shown), lapsed: null, revisions: [] };
  draft.boards = [...(draft.boards ?? []), entry].slice(-BOARDS_KEPT);
  return entry;
}

// A lapsed approval whose board is back as approved still needs asking again (a lapse sticks).
const BACK = "changed, then changed back to what you approved";

/**
 * Compares the board now with the active approval's copy and saves what that means: a lapse or
 * the revision lines not logged yet. A lapse from a change past the tolerances sticks: an undo
 * back to the copy does not restore it, and asking again makes a new entry. A lapse from a gap
 * or overlap alone (lapsed.gap: the video or the music changed, not the board) lasts while the
 * gap does: once the board covers it again within the tolerances, the approval stands again and
 * the board's small changes are logged, as if made in one edit. Returns null without an
 * approval, else { approval, lapsed: why | null, earlier, revisions: [new lines], stands };
 * earlier is true when it had lapsed before this change, stands when a gap's lapse just ended.
 * The reasons are always the board's now, against the copy. `board` is the document's board now
 * (boardFacts spread in: frame, beats, coverage, musicFile).
 */
export function settleBoard(draft, { board, frame, beats = [], coverage = null, musicFile = null, rev, now = Date.now() }) {
  const approval = activeApproval(draft);
  if (!approval) return null;
  const at = new Date(now).toISOString();
  const changes = lapseNow(approval, board, { frame, beats, coverage, musicFile });
  const round = (draft.stops ?? []).find((entry) => entry.id === approval.stop);
  if (handedOver(round)) {
    approval.lapsed = null;
    const lines = changes.lapse.filter((line) => !changes.gaps.includes(line)).map((line) => `after "${round.answer.words.trim()}": ${line}`);
    return { approval, lapsed: null, revisions: logRevisions(approval, [...changes.revisions, ...lines], at, rev) };
  }
  const later = laterAnswer(draft, approval);
  if (later) {
    // Past the board: fixes (a moved cut, new words, a crop) are logged with the later stop; another
    // song, other footage or shots added, removed or reordered still lapse it (MAJOR).
    const major = changes.lapse.filter((line) => MAJOR.test(line));
    const minor = changes.lapse.filter((line) => !MAJOR.test(line)).map((line) => `after ${later.id} ${later.kind}: ${line}`);
    if (!major.length) {
      approval.lapsed = null;
      return { approval, lapsed: null, revisions: logRevisions(approval, [...changes.revisions, ...minor], at, rev) };
    }
    changes.revisions.push(...minor);
    changes.lapse = major;
    changes.gaps = [];
  }
  const earlier = Boolean(approval.lapsed);
  if (earlier && !approval.lapsed.gap) {
    approval.lapsed.why = changes.lapse.length ? changes.lapse : [BACK];
    return { approval, lapsed: approval.lapsed.why, earlier, revisions: [] };
  }
  if (changes.lapse.length) {
    const gap = changes.lapse.length === changes.gaps.length;
    approval.lapsed = { at: approval.lapsed?.at ?? at, rev: approval.lapsed?.rev ?? rev, why: changes.lapse, ...(gap ? { gap } : {}) };
    return { approval, lapsed: changes.lapse, earlier, revisions: [] };
  }
  approval.lapsed = null;
  return { approval, lapsed: null, revisions: logRevisions(approval, changes.revisions, at, rev), ...(earlier ? { stands: true } : {}) };
}

// Logs the lines not logged yet on the approval, and returns them.
function logRevisions(approval, lines, at, rev) {
  const logged = new Set(approval.revisions.map((entry) => entry.line));
  const added = lines.filter((line) => !logged.has(line));
  approval.revisions = [...approval.revisions, ...added.map((line) => ({ at, rev, line }))].slice(-REVISIONS_KEPT);
  return added;
}

/**
 * The rough, color or sound round the person answered (any answer, on the chat or the dashboard)
 * after `approval`'s board round, or null. Once there is one, the board's approval no longer
 * lapses: the person has seen the video built on it, and that stop has its own rules (a redo
 * still blocks it). Rounds allowed by settings or "stop asking" carry no answer and do not count.
 */
export function laterAnswer(state, approval) {
  const stops = state?.stops ?? [];
  const from = stops.findIndex((round) => round.id === approval?.stop);
  if (from < 0) return null;
  return stops.slice(from + 1).find((round) => LATER_KINDS.includes(round.kind) && round.answer) ?? null;
}

/** What the dashboard shows: { approved: null | {stop, board, rev, at, by, lapsed, revisions} }. */
export function boardSummary(state) {
  const approval = activeApproval(state);
  if (!approval) return { approved: null };
  const { stop, board, rev, at, by, lapsed } = approval;
  return { approved: { stop, board, rev, at, by, lapsed, revisions: approval.revisions.slice(-REVISIONS_SHOWN).map((entry) => entry.line) } };
}

// ---- what the person named, and what changed since (B4b) -----------------------------------
// The word "shot" or "shots" before a number ("shot 3", "shots #2").
const SHOT_WORD = /\b(shots?)\s*#?\s*(?=\d)/gi;
const NUMBER = /\d+/y;
// After "shots": a range ("2-4", "2 to 4") and a list (commas, "and", "&"). After "shot": only a
// dash range and "and" or "&", so "shot 5 to 1 second" and "shot 4, 2 things" name one shot.
// The dashes are written as escapes (\u2013 en dash, \u2014 em dash): the project has no literal em dash.
const RANGE = { one: /\s*[-\u2013\u2014]\s*/y, many: /\s*(?:[-\u2013\u2014]|to\b)\s*/y };
const JOIN = { one: /\s*(?:and\s+|&\s*)/y, many: /\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)/y };
// What makes a number a length or a count, not a shot: "1.5", "2 s", "3 frames", "20%", "2
// things" ("trim shots 3 and 4 to 2 s" names shots 3 and 4 only).
const MEASURE = /^(?:\.\d|\s*(?:%|(?:s|secs?|seconds?|ms|f|frames?|fps|x|times|mins?|minutes?|beats?|px|pixels?|percent|things?|others?)\b))/i;
const ENDS = /\b(first|last)\s+shot\b/gi;

// The [from, to] places a list names, read from `at` in `text` (`many`: after "shots"). A number
// that is a length or a count (MEASURE) ends the list.
function placesFrom(text, at, many) {
  const kind = many ? "many" : "one";
  const take = (pattern, from) => {
    pattern.lastIndex = from;
    return pattern.exec(text) ? pattern.lastIndex : -1;
  };
  // The number at `from` when it is a place: [value, end], else null.
  const place = (from) => {
    NUMBER.lastIndex = from;
    const found = NUMBER.exec(text);
    return found && !MEASURE.test(text.slice(NUMBER.lastIndex, NUMBER.lastIndex + 16)) ? [Number(found[0]), NUMBER.lastIndex] : null;
  };
  const spans = [];
  for (let first = place(at); first; ) {
    let [from, end] = first;
    let to = from;
    const dash = take(RANGE[kind], end);
    const last = dash < 0 ? null : place(dash);
    if (last) [to, end] = last;
    spans.push([from, to]);
    const joined = take(JOIN[kind], end);
    first = joined < 0 ? null : place(joined);
  }
  return spans;
}

/**
 * The shots the person's words name: the ids, in board order, no repeats. `ids` are the shot
 * ids in the order the round showed them (round.shown); numbers are 1-based places in that
 * list, and one past it is ignored. Reads, any case: "shot 3", "shot 3 and 5", "shots 3, 5 and
 * 7", "shots 2-4" (or 2–4, 2 to 4; "shot 2-4" too), "S3" (an id on the list with a letter and a
 * digit, so a word such as "a" or "intro", or the "2" of "2 seconds" with ids "1" to "4", is
 * never read as an id: wordId), "first shot" and "last shot". A number
 * that is a length or a count is not a shot: "trim shot 4 to 2 s", "shot 2, 1.5 s shorter",
 * "in shot 4, 2 things" and "the shots 2 seconds longer" name shot 4, shot 2, shot 4 and none.
 */
export function namedShots(words, ids = []) {
  const text = typeof words === "string" ? words : "";
  const places = new Set();
  for (const match of text.matchAll(SHOT_WORD)) {
    for (const span of placesFrom(text, match.index + match[0].length, match[1].toLowerCase() === "shots")) {
      const [low, high] = span.sort((a, b) => a - b);
      for (let place = low; place <= Math.min(high, ids.length); place += 1) places.add(place);
    }
  }
  for (const [, end] of text.matchAll(ENDS)) if (ids.length) places.add(end.toLowerCase() === "first" ? 1 : ids.length);
  const tokens = new Set((text.match(/[A-Za-z0-9_-]+/g) ?? []).map((word) => word.toLowerCase()));
  return ids.filter((id, index) => places.has(index + 1) || (wordId(id) && tokens.has(id.toLowerCase())));
}

// Whether an id is read as a word: it has a letter and a digit, and it is not a length or a
// count ("2s", "30fps"). With ids "1" to "4", "shot 4 should be 2 seconds longer" names shot 4
// only: a plain number is a shot only after "shot" (a place), never as an id.
function wordId(id) {
  if (!/\d/.test(id) || !/[a-z]/i.test(id)) return false;
  const number = /^\d+/.exec(id);
  return !(number && MEASURE.test(id.slice(number[0].length)));
}

// What changed in one shot kept from `before`, past kino's tolerances, in the order they are
// named. The cue is not counted: it moves when a shot before it changes.
function shotWhat(was, shot, frame) {
  const what = [];
  if (!same(was.media, shot.media)) what.push("footage");
  const bothTimes = typeof was.in === "number" && typeof shot.in === "number";
  if (bothTimes ? frames(was.in, shot.in) > CUT_FRAMES : !same(was.in, shot.in)) what.push("in-point");
  if (frames(was.dur, shot.dur) > CUT_FRAMES) what.push("length");
  if (!Array.isArray(was.crop) || !Array.isArray(shot.crop)) {
    if (was.crop !== shot.crop) what.push("crop");
  } else {
    const { moved, resized } = cropChange(was.crop, shot.crop, frame);
    if (moved > CROP_SHARE || resized > CROP_SHARE) what.push("crop");
  }
  for (const field of ["follow", "pacing", "text", "sound", "move"]) if (!same(was[field], shot[field])) what.push(field);
  return what;
}

/**
 * The shots that changed between two boards past kino's tolerances (as for a lapse: CUT_FRAMES,
 * CROP_SHARE): { shots: [{id, n, what: [words]}], removed: [{id, start, end}], order, music }.
 * `n` is a shot's place in `after`; what-words, in this order: added, moved, footage, in-point,
 * length, crop, follow, pacing, text, sound, move. A new reason, subject box or option is not counted.
 * A removed shot is named by its time in `before`. The shot order: when only the `named` shots
 * moved (the others keep their order), each named shot that moved says "moved"; any other
 * reorder is `order: true`. `music` is true when the board's music layer changed.
 */
export function shotChanges(before, after, { frame = { width: 1, height: 1 }, named = [] } = {}) {
  const old = new Map((before?.shots ?? []).map((shot) => [shot.id, shot]));
  const kept = new Set((after?.shots ?? []).map((shot) => shot.id));
  // The kept shots in each board's order, and the same without the named ones.
  const was = [...old.keys()].filter((id) => kept.has(id));
  const now = [...kept].filter((id) => old.has(id));
  const others = (ids) => ids.filter((id) => !named.includes(id));
  const reordered = !same(was, now);
  const byNamed = reordered && named.length > 0 && same(others(was), others(now));
  const moved = new Set(byNamed ? named.filter((id) => was.includes(id) && was.indexOf(id) !== now.indexOf(id)) : []);
  const shots = [];
  for (const [index, shot] of (after?.shots ?? []).entries()) {
    const prior = old.get(shot.id);
    const what = prior ? [...(moved.has(shot.id) ? ["moved"] : []), ...shotWhat(prior, shot, frame)] : ["added"];
    if (what.length) shots.push({ id: shot.id, n: index + 1, what });
  }
  const removed = (before?.shots ?? []).filter((shot) => !kept.has(shot.id)).map((shot) => ({ id: shot.id, start: sec(shot.cue), end: sec(shot.cue + shot.dur) }));
  return { shots, removed, order: reordered && !byNamed, music: (before?.music ?? NONE) !== (after?.music ?? NONE) };
}

/**
 * The person answered a storyboard round with notes (a redo, or an approve with notes): kino
 * keeps the board it showed, and the file its music layer played, as draft.boardAnswered
 * {stop, rev, copy, musicFile}; the next ask says what changed since (stops.mjs redoneSince).
 * An answer to an older version is refused before this, so the board now is the one shown.
 * `board` is boardFacts(document) or the document's board itself.
 */
export function keepAnswered(draft, round, board) {
  const shown = boardOf(board);
  if (!shown) return;
  draft.boardAnswered = { stop: round.id, rev: round.rev, copy: structuredClone(shown), ...(isFacts(board) ? { musicFile: board.musicFile ?? null } : {}) };
}

/**
 * The changed shots after a lapse, for the board's ask: { why, ids, approved: the stop that
 * approved the copy } or null, worked out now.
 */
export function lapsedChanges(state, facts) {
  const approval = activeApproval(state);
  if (!approval?.lapsed) return null;
  const changes = lapseNow(approval, facts.board, facts);
  return { why: changes.lapse.length ? changes.lapse : [BACK], ids: changes.changed, approved: approval.stop };
}
