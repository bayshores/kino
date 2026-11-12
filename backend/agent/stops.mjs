// The stops (direction plan §6): the points in a video where the agent shows the person the work
// and waits for their answer before it goes on. In order: the storyboard (board), the rough cut,
// the color pass and the sound pass. The agent asks with notes {action:"checkpoint", id:"rough"},
// and kino decides: the video has no such stop (skipped), the person's settings let it pass
// (allowed), it already passed (passed), or it waits for the person (waiting_for_you, with the ask
// the agent sends them). The person answers in the chat, and the agent records the reply word for
// word with notes {action:"answer"}; or they answer on the dashboard's stop card
// (dashboardAnswerStep), and the agent hears it in its inbox. On the card they can also reopen an
// answer that is not what they meant (reopenStep): the agent asks that stop again. While a stop
// waits, the project's writes are refused (service.mjs). Nothing here approves itself, and render
// approvals (Q…) are never answered here.
//
// Plain data in and out, like brief.mjs: the service saves the rounds (one per ask) in the
// project's agent state (state.stops), so a waiting stop survives a restart. A stop passes by the
// person's answer or settings, because the video has no such stop, or (ask_limit) because the
// person already gave 10 replies. Nothing the agent saves switches one off, not even a brief
// that says no one can answer.
//
// The storyboard's stop (B4a) asks about the board saved in the document (engine/board.js): it
// needs one with no gap, and its open items answered or left to the agent ("your call": the
// agent then writes its decisions in the board's calls); kino writes its ask (board-text.mjs),
// and every way a board round passes (an answer, the person's settings) freezes a copy of the
// board (board.mjs) that later edits are measured against.
import { createHash } from "node:crypto";
import { closest } from "./refs.mjs";
import { sec } from "./describe.mjs";
import { applyBrief, directionLines, guessedBans, hasBrief, nextMove, REPLY_LIMIT, replyCount, shapeAsk } from "./brief.mjs";
import { namedShape } from "../../engine/quality/rules/shape.js";
import { activeApproval, boardSummary, freezeBoard, keepAnswered, lapsedChanges, leavesItToYou, namedShots, shotChanges } from "./board.mjs";
import { boardAsk, unheardLinesLine } from "./board-text.mjs";
import { movesNeeded } from "../../engine/board.js";
import { PICK_QUESTION, pickLines } from "./treatments.mjs";
import { withControls } from "./controls.mjs";

export const STOP_KINDS = Object.freeze(["board", "rough", "color", "sound"]);
// The stops "stop asking" may switch to allow for one video. Never the board or an approval.
export const SWITCHABLE = Object.freeze(["rough", "color", "sound"]);
// The critic's stop: after the last critic round a scene's open P0 lines go to the person as one
// ask (critique.mjs). It is not in the video's ordered stops: kino asks it only while lines are open.
export const CRITIQUE_STOP = "critique";
export const STOP_LABELS = Object.freeze({ board: "the storyboard", rough: "the rough cut", color: "the color pass", sound: "the sound pass", critique: "the critic's open lines" });
// How the agent read the person's reply (notes answer read_as).
export const READ_AS = Object.freeze(["approve", "approve with notes", "redo", "stop asking"]);
// An answer recorded sooner than this after the ask is refused (too_fast): nobody reads a stop
// that fast, so it is the agent's own reply, not the person's.
export const ANSWER_GAP_MS = 5000;
// The person's defaults: every stop asks; the board from 8 s (with or without footage), the others from 15 s.
export const DEFAULT_STOP_RULES = Object.freeze({
  policy: Object.freeze({ board: "ask", rough: "ask", color: "ask", sound: "ask" }),
  skipUnder: Object.freeze({ board: 8, rough: 15, color: 15, sound: 15 }),
});
// The settings fields (backend/agent/dashboard.mjs): approvals["checkpoint-<kind>"] and these limits.
export const SKIP_FIELDS = Object.freeze({ board: "skipBoardUnder", rough: "skipRoughUnder", color: "skipColorUnder", sound: "skipSoundUnder" });
const HEADLINES = { board: "The storyboard is ready", rough: "The rough cut is ready", color: "The color pass is ready", sound: "The sound pass is ready", critique: "A fresh critic still sees problems" };
const PASSING_READS = ["approve", "approve with notes", "stop asking"];
const WORDS_LIMIT = 2000;
const ROUNDS_SHOWN = 20;
// The fresh-eyes check the agent reports with the board's ask (notes checkpoint fresh).
export const FRESH = Object.freeze(["ran", "skipped"]);
// A note on one shot of the board, from the dashboard's c key.
const SHOT_NOTE_LIMIT = 500;
// The answers after which the next board ask says what changed since (B4b).
const REDONE_READS = ["redo", "approve with notes"];

/** A stop call the agent must change. `code` is a stable word (F7 of the B2a design). */
export class StopError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StopError";
    this.code = code;
    this.details = details;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const clock = (at) => String(at ?? "").slice(11, 16);
const stopAskingOn = (state) => Boolean(state?.stopAsking && !state.stopAsking.undoneAt);
const latestRound = (state, kind) => (state?.stops ?? []).findLast((round) => round.kind === kind) ?? null;
// The shot ids a storyboard round showed, in order (round.shown). A round asked before kino kept
// them has none: an answer is only taken while the work is the version it showed, so the board
// now is the one it showed (`board` is boardFacts(document)).
const shownIds = (round, board) => round.shown ?? (board?.board?.shots ?? []).map((shot) => shot.id);
// Of two kinds, the one a video meets first: "rough" before "color".
const firstKind = (a, b) => (STOP_KINDS.indexOf(a) <= STOP_KINDS.indexOf(b) ? a : b);
// The stop to ask again after the person reopened `reopenedId`, which closed `round`: the
// earlier of the two kinds, since stops are asked in order.
const askAfterReopen = (state, round, reopenedId) => firstKind(round.kind, (state?.stops ?? []).find((entry) => entry.id === reopenedId)?.kind ?? round.kind);
// "check, " before asking a stop again: the storyboard is shown before anything is built, so it
// is asked again without a check.
const checkFirst = (kind) => (kind === "board" ? "" : "check, ");
const checkThen = (kind) => (kind === "board" ? "" : "check, then ");

/**
 * The work a stop shows, as a short fingerprint of the project's document without its name.
 * Moving the project to Trash and back, or renaming it, raises the revision but leaves the work
 * as it was, so a stop asked on it still stands.
 */
export function workPrint(document) {
  return createHash("sha256").update(JSON.stringify({ ...document, name: null })).digest("hex").slice(0, 16);
}

// The project moved on from the work `round` showed: another revision, unless its fingerprint
// (`work`, from workPrint) is the same as when the round was asked.
const movedOn = (round, rev, work) => round.rev !== rev && !(work && round.work === work);

/** The person's stop rules from their settings ({approvals, limits}); missing values take the defaults. */
export function stopRules(approvals = {}, limits = {}) {
  const policy = {}, skipUnder = {};
  for (const kind of STOP_KINDS) {
    policy[kind] = approvals?.[`checkpoint-${kind}`] === "allow" ? "allow" : "ask";
    const value = limits?.[SKIP_FIELDS[kind]];
    skipUnder[kind] = Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_STOP_RULES.skipUnder[kind];
  }
  return { policy, skipUnder };
}

// Why this video has no such stop, or null: every stop needs the video to be at least its
// skip-under length (0 never skips). The storyboard is asked with or without footage: a
// graphics-only video's board has shots with media "none" (engine/board.js), and the person
// sees its order and words before anything is built.
function skipReason(kind, video, rules) {
  const under = rules.skipUnder[kind];
  return (video?.seconds ?? 0) < under ? `under ${under} s` : null;
}

// The rules for this video: the person's settings with the brief's controls laid over them
// (controls.mjs). Laying them over twice gives the same rules, so every entry point may call it.
const rulesOf = (state, rules) => withControls(rules, state?.brief?.controls);
// Who let a stop through without the person: their brief's controls, or their settings.
const allowedByOf = (rules, kind) => rules.by?.[kind] ?? "settings";

const skippedText = (kind, reason, video) => `${kind} skipped: this video is ${sec(video.seconds ?? 0)} s, ${reason}.`;

// A round passed: the person's settings allowed it, or the person approved it. A round allowed by
// "stop asking" passes only while that is on: once the person undoes it, the stop asks again.
// "stop asking" passes only rough, color and sound: it never approves the storyboard. A
// storyboard round passes only with its frozen copy (board.mjs), and stops counting once the
// board changed past kino's tolerances.
function roundPassed(round, state) {
  if (round.kind === "board") {
    const frozen = (state?.boards ?? []).findLast((entry) => entry.stop === round.id);
    if (!frozen || frozen.lapsed) return false;
  }
  // A round the brief's controls let through passes only while they still say "go".
  if (round.status === "allowed" && round.allowedBy === "controls") return state?.brief?.controls?.stops?.[round.kind] === "go";
  // A round that passed with another one stands while that one does.
  if (round.status === "allowed" && round.allowedBy === "same-work") {
    const covered = (state?.stops ?? []).find((entry) => entry.id === round.covers);
    return Boolean(covered) && roundPassed(covered, state);
  }
  if (round.status === "allowed") return round.allowedBy !== "chat" || stopAskingOn(state);
  const read = round.answer?.read_as;
  return round.status === "answered" && PASSING_READS.includes(read) && (read !== "stop asking" || SWITCHABLE.includes(round.kind));
}

/**
 * This video's stops in order: [{kind, skipped?, passed, round?}]. A kind is passed when it is
 * skipped, its latest round passed, or (ask_limit) it is switchable, was never asked and the
 * person already gave REPLY_LIMIT replies: then the agent makes that call itself.
 */
export function stopPlan(state, video = {}, given = DEFAULT_STOP_RULES) {
  const rules = rulesOf(state, given);
  const replies = replyCount(state).count;
  return STOP_KINDS.map((kind) => {
    const skipped = skipReason(kind, video, rules);
    if (skipped) return { kind, skipped, passed: true };
    const round = latestRound(state, kind);
    if (round) return { kind, passed: roundPassed(round, state), round };
    return { kind, passed: SWITCHABLE.includes(kind) && replies >= REPLY_LIMIT };
  });
}

/**
 * The stops a final render waits for (direction plan B2c): this video's stops that have not
 * passed, [{kind, round?}] in order. A kind the person's settings allow, or one "stop asking"
 * switched off, does not wait. A video without a brief has no stops (a stop checks the work
 * against the brief, so none can be asked): nothing waits. Drafts never wait.
 */
export function openStops(state, video = {}, given = DEFAULT_STOP_RULES) {
  const rules = rulesOf(state, given);
  if (!hasBrief(state?.brief)) return [];
  const released = (kind) => rules.policy[kind] === "allow" || (SWITCHABLE.includes(kind) && stopAskingOn(state));
  return stopPlan(state, video, rules).filter((entry) => !entry.passed && !released(entry.kind)).map(({ kind, round }) => (round ? { kind, round } : { kind }));
}

// How an open stop stands, for the final-render refusal: "rough (C3 waiting)", "board (C1
// lapsed)", or just "color" when it was never asked.
// An allowed round open again was let through by "stop asking", which the person undid.
const ROUND_WORDS = { waiting: "waiting", lapsed: "lapsed", reopened: "reopened", allowed: "asking again" };
const openWords = ({ kind, round }) => {
  if (!round) return kind;
  const words = round.status === "answered" && round.answer?.read_as === "redo" ? "redo" : ROUND_WORDS[round.status] ?? (kind === "board" ? "changed since approved" : round.status);
  return `${kind} (${round.id} ${words})`;
};

/**
 * The refusal of a final render while stops are open: { message, next, stops }. `byYou` is a
 * render the person started on the dashboard: they answer the stops (or allow them in settings);
 * an agent asks them in order.
 */
export function finalRefusal(open, { byYou = false } = {}) {
  const listed = open.map(openWords).join(", ");
  const waiting = open.find((entry) => entry.round?.status === "waiting");
  const message = `A final render waits for this video's stops: ${listed}. A draft render works now.`;
  const next = byYou ? "Answer them when your agent asks, or set them to allow in settings › stops."
    : waiting ? `${waiting.round.id} waits for the person's answer: end your turn.`
      : `Ask them in order: notes {action:"checkpoint", id:"${open[0].kind}"}.`;
  return { message, next, stops: open.map(({ kind, round }) => ({ kind, ...(round ? { id: round.id, status: round.status } : {}) })) };
}

/** The round waiting for the person's answer, or null (at most one waits at a time). */
export function waitingStop(state) {
  return (state?.stops ?? []).findLast((round) => round.status === "waiting") ?? null;
}

/**
 * Closes the waiting round when it no longer stands for what the person would answer, and
 * returns it (else null): the project moved on from the work it showed (the person undid or
 * changed it; `work` is the project's workPrint now, so Trash and back or a new name do not
 * count), or the video has no such stop now (shorter, footage removed, a longer skip-under
 * length): lapsed; or the person's settings now allow it: allowed (a storyboard round freezes
 * the board it showed, `board` being boardFacts(document): the work did not move on, so it is
 * the board now). Without `video`, only the work is compared. The service runs this before a
 * stop blocks a write and before status, checkpoint and answer read it, so a stop nobody can
 * answer any more never stays. Nothing the agent saves (a brief, a note) closes one.
 */
export function settleWaiting(draft, { video = null, rules: given = DEFAULT_STOP_RULES, rev, work = null, now = Date.now(), board = null }) {
  const rules = rulesOf(draft, given);
  const round = waitingStop(draft);
  if (!round) return null;
  const at = new Date(now).toISOString();
  const skipped = video ? skipReason(round.kind, video, rules) : null;
  if (movedOn(round, rev, work) || skipped) Object.assign(round, { status: "lapsed", lapsedAt: at, lapsedRev: rev, ...(skipped ? { lapsedFor: skipped } : {}) });
  else if (video && rules.policy[round.kind] === "allow" && !forThePerson(draft, round.kind).length) {
    const by = allowedByOf(rules, round.kind);
    Object.assign(round, { status: "allowed", allowedBy: by, allowedAt: at });
    if (by === "controls") draft.inbox?.push({ kind: "stops", text: `${round.id} ${round.kind} goes on: the brief's controls say go ("${draft.brief.controls.quote}").` });
    if (round.kind === "board") freezeBoard(draft, round, { board, by: "settings", now });
  } else return null;
  return round;
}

// What only the person can answer in a stop's ask: the treatments to pick (until one is picked)
// and, on the storyboard, the bans the agent guessed. A stop their settings allow still waits
// while any is open: the settings pass the work, not a question nobody else can answer.
const forThePerson = (draft, kind) => [...pickLines(draft.brief, draft.origin), ...(kind === "board" ? guessedBans(draft.brief) : [])];
const HELD_LINE = "Your settings pass this stop: it waits only for the question above.";

// "the sound check", "the color and sound checks", "the rough, color and sound checks".
const offerWords = (offer) => `the ${offer.length > 1 ? `${offer.slice(0, -1).join(", ")} and ${offer.at(-1)}` : offer[0]} check${offer.length > 1 ? "s" : ""}`;

// The stops "stop asking" would switch off, offered on the first of rough, color and sound this
// video asks: those after it that would ask. Never on the storyboard, which the person always
// answers themselves; [] on any other stop, or when none would ask.
function offerFor(kind, video, rules, state) {
  const asks = (entry) => !skipReason(entry, video, rules) && rules.policy[entry] === "ask" && !stopAskingOn(state);
  const asking = SWITCHABLE.filter(asks);
  return asking[0] === kind ? asking.slice(1) : [];
}

/**
 * "39 waived (crop_no_subject 17, held_static 9)": the project's waivers (document.checkWaivers) by
 * rule, the top 3, so a stop shows how many findings the agent called fine. A rule waived on "*" shows
 * "all" (subject rules refuse "*", so a count per rule is one target each). "" when none.
 */
export function waivedLine(waivers = []) {
  const byRule = new Map();
  for (const waiver of Array.isArray(waivers) ? waivers : []) {
    if (!waiver?.code) continue;
    const entry = byRule.get(waiver.code) ?? { count: 0, all: false };
    entry.count += 1;
    entry.all ||= waiver.target === "*";
    byRule.set(waiver.code, entry);
  }
  if (!byRule.size) return "";
  const total = [...byRule.values()].reduce((sum, entry) => sum + entry.count, 0);
  const top = [...byRule].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, 3);
  return `${total} waived (${top.map(([code, entry]) => `${code} ${entry.all ? "all" : entry.count}`).join(", ")})`;
}

/**
 * The open findings' 3 most frequent rules, from a full check's byRule ({rule: {errors, warnings}}):
 * [[rule, count]], most first, then by name. A stop names them, so the person sees what is open.
 */
export function topRules(byRule = {}) {
  return Object.entries(byRule ?? {}).map(([rule, row]) => [rule, (row?.errors ?? 0) + (row?.warnings ?? 0)]).filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
}

// " (shape_guess 2, ask_unmet 1)": the open rules a full check saved (checked.top); "" for none.
const openRulesText = (checked) => (Array.isArray(checked?.top) && checked.top.length ? ` (${checked.top.map(([rule, count]) => `${rule} ${count}`).join(", ")})` : "");

// "Checked: 0 errors · 3 warnings (shape_guess 2, ask_unmet 1) · 49 waived (narrow_window 24, ...)."
function checkedLine(checked, waivers) {
  const waived = waivedLine(waivers);
  return `Checked: ${plural(checked?.errors ?? 0, "error")} · ${plural(checked?.warnings ?? 0, "warning")}${openRulesText(checked)}${waived ? ` · ${waived}` : ""}.`;
}

/**
 * What the agent sends the person (one line each, no revision numbers). The storyboard's ask is
 * its headline and reply lines: the agent puts its shot list (kino's numbers from B4a) after
 * the first line, so plan §12's 120 tokens leave room for it.
 */
export function askText({ id, kind, video = {}, checked, offer = [], idea = null, pick = [], music = null, waivers = [], brief = null }) {
  const frame = video.width && video.height ? `, ${video.width}×${video.height}` : "";
  return [
    `${HEADLINES[kind]} (${id}): ${sec(video.seconds ?? 0)} s${frame}.`,
    // The shape the video guessed against its footage, and the crops kino measured (the service fills cropLine).
    shapeAsk(brief, video)?.line ?? "",
    typeof video.cropLine === "string" ? video.cropLine : "",
    // What the person's ask points to and which shot shows it (the service fills askLine).
    kind === "rough" && typeof video.askLine === "string" ? video.askLine : "",
    idea ? `Idea: ${idea}` : "",
    // The treatments to pick from (treatments.mjs), until the person picked one.
    ...pick,
    kind === "board" ? "" : checkedLine(checked, waivers),
    // A sound stop with no music says so, with the person's choices (checkpointStep).
    music ?? "",
    // The sound stop's fact: effects placed on the visible actions found (the service fills effectsLine).
    kind === "sound" && typeof video.effectsLine === "string" ? video.effectsLine : "",
    kind === "board" ? "" : "What did you notice, and what would you change?",
    "Reply: approve · approve with notes: ... · redo: ...",
    offer.length ? `Or say "stop asking" to skip ${offerWords(offer)} for this video.` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The critique stop's ask: the open lines, then the two answers (fix as the critic says, or keep),
 * and the critic's ideas that would raise the edit (its UP lines), so they are not lost.
 */
export function critiqueAsk({ id, video = {}, scene, lines = [], question = false, ideas = [] }) {
  return [
    question
      ? `The critic would cut or flatten a designed moment (${id}): ${scene}, ${sec(video.seconds ?? 0)} s. Your call:`
      : `${HEADLINES.critique} (${id}): ${scene}, ${sec(video.seconds ?? 0)} s, after two critic rounds.`,
    ...lines.slice(0, 6).map((line, index) => `${index + 1}. ${line}`),
    lines.length > 6 ? `and ${lines.length - 6} more` : "",
    "Reply: fix (all, or the numbers) · keep: <why they stay>",
    ideas.length ? `The critic's ideas to raise it:\n${ideas.slice(0, 3).map((idea) => `- ${idea}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

// What the agent does with a waiting stop: send the ask, end its turn, record the reply. Kept
// short (plan §12: 120 tokens and 35 a shot listed for the board's answer, 200 for the others);
// the direction and storyboard guides say what to add and how to read the reply.
function askNext(round) {
  if (round.kind === "board") return `send it as written, end your turn, then notes {action:"answer", id:"${round.id}", rev:${round.rev}, words, read_as}.`;
  if (round.kind === CRITIQUE_STOP) return `send it as written, end your turn, then notes {action:"answer", id:"${round.id}", rev:${round.rev}, words, read_as:"redo" (fix) or "approve" (keep)}.`;
  return `send the ask (up to 3 lines of yours after its first; attach look {mode:"sheet"} if you can), end your turn, then notes {action:"answer", id:"${round.id}", rev:${round.rev}, words, read_as}.`;
}

// `ask` is the round's own (a storyboard asked again with all:true lists every shot); `board`
// is the storyboard's {rev, shots, listed, flagged}.
function waitingAnswer(round, ask = round.ask, board = round.board) {
  const next = askNext(round);
  // A storyboard ask carries one style frame (board-look.mjs styleFrameFacts): the picked type
  // direction over a real frame of the first footage shot. No question goes with it.
  const frame = round.styleFrame ? { shot: round.styleFrame.shot, type: round.styleFrame.type } : null;
  return {
    text: [`waiting_for_you ${round.id} ${round.kind} · rev ${round.rev}`, "ask:", ask, frame ? `style frame (${frame.type}): attached; send it with the ask, no question about it.` : "", `step: ${next}`].filter(Boolean).join("\n"),
    data: { status: "waiting_for_you", id: round.id, kind: round.kind, rev: round.rev, ask, offer: round.offer ?? [], next, ...(board ? { board } : {}), ...(frame ? { styleFrame: frame } : {}) },
    nextCall: answerCall(round),
  };
}

/** The answer to a write while a stop waits (and to a stop asked while another waits). */
export function waitingData(round) {
  // The storyboard's one write that still saves: a revised board refreshes this same ask.
  const board = round.kind === "board" ? " A revised board (an edit of board ops only, music by a sound's src or id included) saves and refreshes this ask." : "";
  return { waiting: round.id, kind: round.kind,
    next: `Nothing was changed. ${round.id} (${STOP_LABELS[round.kind]}) waits for the person's answer: end your turn. Reads, look, check and notes still work.${board}` };
}

// How a passed round passed, for the passed and answered refusals: "approve, 14:05", or
// "approve in kino, 14:05" when the person answered on the dashboard.
function howPassed(round) {
  if (round.status === "allowed" && round.allowedBy === "same-work") return `passed with ${round.covers}, ${clock(round.allowedAt ?? round.askedAt)}`;
  if (round.status === "allowed") return `${round.allowedBy === "chat" ? "allowed in chat" : round.allowedBy === "controls" ? "allowed by the person's controls" : "allowed by the person's settings"}, ${clock(round.allowedAt ?? round.askedAt)}`;
  return `${round.answer?.read_as ?? round.status}${round.answer?.via === "dashboard" ? " in kino" : ""}${round.answer?.silent ? `, ${SILENT}` : ""}, ${clock(round.answer?.at)}`;
}

// The sound stop of a video with no music (video.music false; no_music says the same).
// No song search here: the ask offers the person's three choices, and a plain approval records
// SILENT, so the final message says whose call the silence was (also after the measured songs).
// waive_check {code:"no_music"} (service musicIn) is the way out of both. Song search (songSearch:
// YouTube songs need no switch): the stop waits until the agent found and measured MEASURED_SONGS
// songs (library soundtrack).
const SILENT = "silent by the person's call";
const MEASURED_SONGS = 2;
const NO_MUSIC_ASK = "No music yet: name a song or artist, send a track, or keep it silent.";

/**
 * notes {action:"checkpoint", id:<kind>}, applied to a draft of the agent state (state.update):
 * returns { text, data } or throws StopError. `rev` is the project's revision now and `work` its
 * workPrint, saved with a new round. A waiting stop that no longer stands (settleWaiting: the
 * project moved on, the video has no such stop now, or the person's settings allow it) is
 * closed first; that change stays even when a later rule refuses the call, so the project's
 * writes work again.
 */
export function checkpointStep(draft, { kind: wanted, video = {}, rules: given = DEFAULT_STOP_RULES, rev, work = null, now = Date.now(), client = null, board = null, all = false, words, soundFiles = false, soundSearch = false, songSearch = soundSearch, fresh = null, critique = null, styleFrame = null, waivers = video.waivers ?? [] }) {
  const kind = typeof wanted === "string" ? wanted.trim().toLowerCase() : "";
  const rules = rulesOf(draft, given);
  if (!STOP_KINDS.includes(kind) && kind !== CRITIQUE_STOP)
    throw new StopError("bad_input", "id is board, rough, color, sound or critique.", { didYouMean: closest(String(wanted ?? ""), [...STOP_KINDS, CRITIQUE_STOP]) });
  if (fresh != null && kind !== "board") throw new StopError("bad_input", "fresh goes with the storyboard stop.");
  if (fresh != null && !FRESH.includes(fresh))
    throw new StopError("bad_input", 'fresh is "ran" (a second agent checked the board) or "skipped" (your app cannot start one).');
  draft.stops ??= [];
  const at = new Date(now).toISOString();
  const closed = settleWaiting(draft, { video, rules, rev, work, now, board });
  const skipped = skipReason(kind, video, rules);
  if (skipped) {
    const text = `${skippedText(kind, skipped, video)}${closed?.kind === kind ? ` ${closed.id} no longer waits.` : ""}`;
    return { text, data: { status: "skipped", kind, reason: skipped } };
  }
  if (kind !== CRITIQUE_STOP && !hasBrief(draft.brief)) throw new StopError("brief_first", "Save the brief first (library guide direction): a stop checks the work against it.");

  // A round still waiting shows this revision (settleWaiting closed any other).
  // A storyboard asked again while it waits: every shot with all:true, and the fresh-eyes check
  // when the agent reports it now.
  const waiting = waitingStop(draft);
  if (waiting && waiting.kind === kind) {
    if (kind === "board" && styleFrame) waiting.styleFrame = styleFrame;
    if (kind !== "board" || !(all || fresh) || !board?.board) return waitingAnswer(waiting);
    if (fresh) waiting.fresh = fresh;
    return boardWaiting(draft, waiting, board, { all, soundFiles, soundSearch, video: { ...video, waivers } });
  }
  if (waiting) {
    const data = waitingData(waiting);
    return { text: JSON.stringify(data), data };
  }
  if (kind === CRITIQUE_STOP) return critiqueCheckpoint(draft, { critique, video, rev, at, client, work });

  const plan = stopPlan(draft, video, rules);
  const first = plan.slice(0, STOP_KINDS.indexOf(kind)).find((entry) => !entry.passed);
  if (first) throw new StopError("out_of_order", `${kind} refused: ${first.kind} is not approved yet; run notes checkpoint {id:"${first.kind}"} first.`, { first: first.kind });
  if (kind === "board") return boardCheckpoint(draft, { facts: board, rules, rev, work, now, client, all, words, soundFiles, soundSearch, fresh, styleFrame, video: { ...video, waivers } });
  const latest = latestRound(draft, kind);
  if (latest && latest.rev === rev && roundPassed(latest, draft)) {
    return { text: `${latest.id} ${kind} passed at rev ${rev} (${howPassed(latest)}); nothing changed since. Go on.`, data: { status: "passed", id: latest.id, kind, rev } };
  }
  // The person already approved another of rough, color and sound on this same work: one answer
  // covers them. The board never merges, and a stop whose work changed asks on its own. An approve
  // with notes asked for changes (the same work means none was made), and a sound stop with no
  // music has its own question (music_first and the person's choice of silence), so neither merges.
  const silentSound = kind === "sound" && (video.music === false || (video.music === "waived" && (draft.soundtrack?.candidates ?? []).length > 0));
  const covered = SWITCHABLE.includes(kind) && work && !silentSound ? draft.stops.findLast((round) => round.kind !== kind && SWITCHABLE.includes(round.kind) && round.status === "answered" && round.answer?.read_as === "approve"
    && round.rev === rev && round.work === work && roundPassed(round, draft)) : null;
  if (covered) {
    const round = { id: `C${draft.nextStop}`, kind, rev, askedAt: at, client, status: "allowed", allowedBy: "same-work", allowedAt: at, covers: covered.id, offer: [], ask: null, answer: null, work };
    draft.nextStop += 1;
    draft.stops.push(round);
    const text = `${round.id} ${kind} passed with ${covered.id} ${covered.kind}: the person answered this same revision (rev ${rev}) and nothing changed since. Change the ${kind} first to ask it on its own.`;
    draft.inbox?.push({ kind: "stops", text });
    return { text, data: { status: "passed", id: round.id, kind, rev, covers: covered.id } };
  }

  // The agent checks its own work before it shows it: a full check of this revision, no errors.
  const checked = draft.checked;
  if (!checked || checked.rev !== rev)
    throw new StopError("check_first", `Run check first: a stop shows work kino checked on this revision (rev ${rev}; ${checked ? `last full check: rev ${checked.rev}` : "no full check yet"}).`, { rev, checked: checked ?? null });
  if (checked.errors)
    throw new StopError("check_first", `check found ${plural(checked.errors, "error")} on rev ${rev}: fix it first, then check again.`, { rev, checked });
  // An agent's own no_music waiver (video.music "waived") does not count while the search found songs.
  const found = (draft.soundtrack?.candidates ?? []).length;
  const noMusic = kind === "sound" && (video.music === false || (video.music === "waived" && found > 0));
  const measured = (draft.soundtrack?.candidates ?? []).filter((entry) => entry.measure).length;
  if (noMusic && songSearch && measured < MEASURED_SONGS) {
    const next = measured || draft.soundtrack?.candidates?.length ? 'library {topic:"soundtrack", measure:"<id>"}' : 'library {topic:"soundtrack", search:"<mood, tempo>"}';
    throw new StopError("music_first", `sound refused: the video has no music. Find and measure ${MEASURED_SONGS} songs first (${measured} measured), import the best fit, check, then ask again. Next: ${next}. If the search finds nothing: waive_check {code:"no_music", target:"*", reason}; if the person asked for silence, add quote (their words).`, { measured, next });
  }

  const switched = SWITCHABLE.includes(kind) && stopAskingOn(draft);
  const passes = rules.policy[kind] === "allow" || switched;
  if (passes && !forThePerson(draft, kind).length) {
    const by = rules.policy[kind] === "allow" ? allowedByOf(rules, kind) : "chat";
    const round = { id: `C${draft.nextStop}`, kind, rev, askedAt: at, client, status: "allowed", allowedBy: by, offer: [], ask: null, answer: null };
    draft.nextStop += 1;
    draft.stops.push(round);
    // The person sees in their inbox that a stop went on by their controls, with their words.
    if (by === "controls") draft.inbox?.push({ kind: "stops", text: `${round.id} ${kind} goes on: the brief's controls say go ("${draft.brief.controls.quote}").` });
    const next = "say in one line what you checked, then go on.";
    // A sound stop passed with no music: the final message says why the video is silent.
    if (noMusic) round.noMusic = songSearch ? "search" : true;
    return {
      text: [`${round.id} ${kind} allowed (${by === "chat" ? "set in chat" : by === "controls" ? "the person's controls" : "the person's settings"}) · checked: ${plural(checked.errors, "error")} · ${plural(checked.warnings, "warning")}${openRulesText(checked)}`,
        noMusic ? `No music: silent because ${songSearch ? "no measured song was imported" : "no track was sent and no song search is available"}. Your final message says so; never that they asked for silence.` : "",
        kind === "sound" && typeof video.effectsLine === "string" ? video.effectsLine : "", `step: ${next}`].filter(Boolean).join("\n"),
      data: { status: "allowed", id: round.id, kind, rev, by, next },
    };
  }
  const { count } = replyCount(draft);
  if (SWITCHABLE.includes(kind) && !latest && count >= REPLY_LIMIT)
    throw new StopError("ask_limit", `${count} of ${REPLY_LIMIT} replies used: kino does not ask the person about ${kind} for this video.`,
      { kind, replies: count, next: `Make the ${kind} call yourself, say "my call: …" in your message, and go on.` });

  const id = `C${draft.nextStop}`;
  const offer = offerFor(kind, video, rules, draft);
  const music = noMusic ? (songSearch ? `No music yet: ${measured} songs measured; name one to use, or keep it silent.` : NO_MUSIC_ASK) : null;
  const asked = askText({ id, kind, video, checked, offer, idea: draft.brief?.fields?.idea?.text ?? null, pick: pickLines(draft.brief, draft.origin), music, waivers, brief: draft.brief });
  const shape = shapeAsk(draft.brief, video)?.round;
  const round = { id, kind, rev, askedAt: at, client, status: "waiting", offer, ask: passes ? `${asked}\n${HELD_LINE}` : asked, answer: null, ...(shape ? { shape } : {}), ...(work ? { work } : {}), ...(noMusic ? { noMusic: songSearch ? "search" : true } : {}) };
  draft.nextStop += 1;
  draft.stops.push(round);
  return waitingAnswer(round);
}

// notes checkpoint {id:"critique"}: the open P0 lines of a scene that had its last critic round
// (`critique` is {sceneId, scene, rev, lines}, from the service) wait for the person as one ask.
function critiqueCheckpoint(draft, { critique, video, rev, at, client, work }) {
  if (!critique?.lines?.length)
    throw new StopError("nothing_open", "No critic lines wait for the person: a critique stop is asked only after the last critic round left a P0 open. Go on.");
  const id = `C${draft.nextStop}`;
  const round = { id, kind: CRITIQUE_STOP, rev, askedAt: at, client, status: "waiting", offer: [], scene: critique.sceneId,
    ask: critiqueAsk({ id, video, scene: critique.scene, lines: critique.lines, question: critique.question === true, ideas: critique.ideas ?? [] }), answer: null, ...(work ? { work } : {}) };
  draft.nextStop += 1;
  draft.stops.push(round);
  return waitingAnswer(round);
}

// The storyboard's rows of notes checkpoint (B4a design F5), after the rows every stop shares:
// a saved board with no gap, then passed (its approval stands), the open items, the person's
// settings, or a new round that waits with kino's ask. No check first: the board is shown before
// anything is built. `facts` is boardFacts(document).
function boardCheckpoint(draft, { facts, rules, rev, work, now, client, all, words, soundFiles, soundSearch, fresh, styleFrame, video = {} }) {
  const board = facts?.board;
  if (!board) throw new StopError("board_first", 'Save the storyboard first: edit {ops:[{op:"board", music, shots}]} (library {topic:"op", name:"board"}; library guide storyboard).');
  if (facts.coverage) {
    // A gap at the end is closed by one call that moves only the last shot's end (blocks.mjs endBoard).
    const call = facts.coverage.end === undefined ? null : `edit {ops:[{op:"board", end:${facts.coverage.end}}]}`;
    throw new StopError("board_gap", `${facts.coverage.message} ${call ? `One call that does it: ${call}, then ask again.` : "Fix the board (edit board), then ask again."}`, { at: facts.coverage.at, ...(call ? { call } : {}) });
  }
  const approval = activeApproval(draft);
  if (approval && !approval.lapsed) {
    const round = draft.stops.find((entry) => entry.id === approval.stop);
    const logged = approval.revisions.length;
    const since = approval.rev === rev ? "nothing changed since" : `board changes since are within kino's tolerances (${plural(logged, "revision")} logged)`;
    return { text: `${approval.stop} board passed at rev ${approval.rev} (${howPassed(round)}); ${since}. Go on.`,
      data: { status: "passed", id: approval.stop, kind: "board", rev: approval.rev, revisions: approval.revisions.slice(-8).map((entry) => entry.line) } };
  }
  // A designed move on a key beat (hook, reveal or payoff): the person never sees a board with no emphasis; plain cuts elsewhere are right.
  const needed = movesNeeded(board, facts.mediaNames, draft?.brief?.style?.spine ?? null);
  if (needed) throw new StopError("move_needed", `board refused: ${needed.message}`, { shots: needed.shots });
  const at = new Date(now).toISOString();
  const open = board.open ?? [];
  const given = words !== undefined && words !== null;
  if (given && (typeof words !== "string" || !words.trim() || words.length > WORDS_LIMIT))
    throw new StopError("bad_input", `words is the person's reply to the board's open items, word for word (1–${WORDS_LIMIT} characters).`);
  if (given && !open.length) throw new StopError("bad_input", "words goes with the board's open items, and this board has none: ask without words.");
  const theirs = given ? words.trim() : null;
  // "your call": their words are a reply (counted), and the agent decides each open item and
  // writes its decisions in the board's calls, so the ask shows what it chose ("say no to any").
  // Each "ask again" names fresh: the round kino makes then is the one the person sees, and an
  // ask without it says "Fresh-eyes check: not reported" on the video's first storyboard ask.
  const decide = 'decide each, write your decisions in calls and empty open (edit board), then ask again: notes checkpoint {id:"board", fresh}.';
  if (open.length && theirs && leavesItToYou(theirs)) return leftToAgent(draft, open, theirs, { now, client });
  if (open.length) {
    const left = JSON.stringify(draft.leftToAgent?.open) === JSON.stringify(open);
    const message = left ? `They left these to you ("your call"): ${decide}`
      : theirs ? 'Their words do not say "your call": fold their answers into the board (edit board), then ask again: notes checkpoint {id:"board", fresh}.'
      : `The board has ${plural(open.length, "open item")}: ask the person in one message, fold their answers into the board (edit board, open emptied), then ask again: notes checkpoint {id:"board", fresh}. If they say "your call", send their words: notes {action:"checkpoint", id:"board", words}.`;
    throw new StopError("open_items", message, { open_items: open.length, open });
  }
  const id = `C${draft.nextStop}`;
  const held = rules.policy.board === "allow";
  if (held && !forThePerson(draft, "board").length) {
    const round = { id, kind: "board", rev, askedAt: at, client, status: "allowed", allowedBy: allowedByOf(rules, "board"), allowedAt: at, offer: [], ask: null, answer: null };
    draft.nextStop += 1;
    draft.stops.push(round);
    freezeBoard(draft, round, { board: facts, by: "settings", now });
    const next = "say in one line that the storyboard passed by their settings, then build.";
    return { text: [`${id} board allowed (the person's settings): kino keeps this board as the approved one.`, `step: ${next}`].join("\n"),
      data: { status: "allowed", id, kind: "board", rev, by: "settings", next } };
  }
  // After a lapse the ask shows only the changed shots (and why); after a redo or approve with
  // notes, what changed since the board they answered. The sound offer is made once, on the
  // video's first storyboard ask (and an unreported fresh-eyes check is said there).
  const changed = lapsedChanges(draft, facts);
  const redone = redoneSince(draft, facts);
  const offerSound = !draft.stops.some((entry) => entry.kind === "board");
  const shape = shapeAsk(draft.brief, boardVideo(facts, video))?.round;
  const round = { id, kind: "board", rev, askedAt: at, client, status: "waiting", offer: [], ask: null, answer: null,
    ...(shape ? { shape } : {}), ...(held ? { held } : {}), ...(changed ? { changed } : {}), ...(redone ? { redone } : {}), ...(fresh ? { fresh } : {}), ...(offerSound ? { offerSound } : {}), ...(styleFrame ? { styleFrame } : {}), ...(work ? { work } : {}) };
  draft.nextStop += 1;
  draft.stops.push(round);
  return boardWaiting(draft, round, facts, { all, soundFiles, soundSearch, video });
}

// "your call" on the board's open items: the person's words are a reply (counted), the agent
// decides each open item, and the answer lists them. Not a stop that passes, so no too_fast.
const DECIDE_BOARD = 'decide each, write your decisions in calls and empty open (edit board), then ask again: notes checkpoint {id:"board", fresh}.';
function leftToAgent(draft, open, theirs, { now, client }) {
  const at = new Date(now).toISOString();
  applyBrief(draft, { lines: [], log: [{ q: `Open: ${open.join(" · ")}`.slice(0, 300), a: theirs, kind: "question" }], noPlayback: null }, { now, client });
  draft.leftToAgent = { open, words: theirs, at };
  const items = open.map((item, index) => `${index + 1}. ${item}`).join(" · ");
  return { text: [`recorded: they left ${plural(open.length, "open item")} to you ("your call"): ${items}`, `step: ${DECIDE_BOARD}`].join("\n"),
    data: { status: "your_call", open, next: DECIDE_BOARD }, nextCall: { tool: "library", input: { topic: "op", name: "board" } } };
}

// The treatment pick left to the agent ("your call" through notes answer): their words are a
// reply (counted); the pick is the agent's own, with why, so no quote is asked for.
function pickToAgent(draft, theirs, { now, client }) {
  applyBrief(draft, { lines: [], log: [{ q: PICK_QUESTION, a: theirs, kind: "question" }], noPlayback: null }, { now, client });
  const next = 'pick one yourself and say why a viewer would retell it (1 to 80 characters): notes brief fields.treatments {pick:"A", why}.';
  return { text: ['recorded: they left the treatment pick to you ("your call").', `step: ${next}`].join("\n"),
    data: { status: "your_call", open: ["treatment pick"], next }, nextCall: { tool: "notes", input: { action: "brief", fields: { treatments: { pick: "<A, B or C>", why: "<why a viewer would retell it>" } } } } };
}

// notes answer with read_as "your call": the open items of the board, or the treatment pick,
// become the agent's. A stop that waits for an approval is not left this way (it needs approve).
function yourCallAnswer(draft, input, { board, now, client }) {
  const asked = String(input.id ?? "").trim().toLowerCase();
  const theirs = typeof input.words === "string" ? input.words.trim() : "";
  if (!theirs || theirs.length > WORDS_LIMIT) throw new StopError("bad_input", `words is the person's reply, word for word (1-${WORDS_LIMIT} characters).`);
  if (!leavesItToYou(theirs)) throw new StopError("bad_input", `Their words do not say "your call": read them as approve, approve with notes or redo, or record what they said.`);
  if (["treatments", "treatment", "pick"].includes(asked)) {
    if (!draft.brief?.treatments?.list) throw new StopError("bad_input", "Save the 5 treatments first (notes brief fields.treatments), then the pick.");
    return pickToAgent(draft, theirs, { now, client });
  }
  const open = board?.board?.open ?? [];
  if (asked === "board" && open.length) return leftToAgent(draft, open, theirs, { now, client });
  throw new StopError("bad_input", `"your call" leaves the board's open items (${asked === "board" ? "this board has none" : 'id "board"'}) or the treatment pick (id "treatments") to you. A stop that waits for an approval passes on approve, approve with notes or redo: record their words with one of those.`);
}

// The video's facts for the shape line of a board ask: the service's video, with the board's frame when it has no size.
const boardVideo = (facts, video) => ({ width: facts?.frame?.width, height: facts?.frame?.height, ...video });

// After a redo or an approve with notes of the last storyboard round that did not lapse: what
// changed since, against the copy kino kept when they answered (draft.boardAnswered), in
// round.redone's words: named, the shots their words or notes named; asked, those that changed;
// unasked, the other changed shots (only when they named any); missed, those named that did not
// change; removed; changed, every changed shot on the board now with what changed; and order
// and music, true when the shot order (not only the named shots moved) or the music changed.
// A round that lapsed in between (the work moved on while it waited) is passed over, so its
// lines are said again on the next ask. Null otherwise. kino never refuses an ask for a change
// nobody asked for: the ask tells the person. `facts` is boardFacts(document).
function redoneSince(draft, facts) {
  const previous = (draft.stops ?? []).findLast((round) => round.kind === "board" && round.status !== "lapsed");
  const answered = draft.boardAnswered;
  if (previous?.status !== "answered" || !REDONE_READS.includes(previous.answer?.read_as) || answered?.stop !== previous.id) return null;
  const named = previous.answer.named ?? [];
  const { shots, removed, order, music } = shotChanges(answered.copy, facts.board, { frame: facts.frame, named });
  // The same music layer playing another file (or none) is a change too.
  const song = music || (answered.musicFile !== undefined && answered.musicFile !== (facts.musicFile ?? null));
  const changedIds = new Set([...shots, ...removed].map((entry) => entry.id));
  const what = ({ id, what: words }) => ({ id, what: words });
  return { stop: previous.id, named, asked: named.filter((id) => changedIds.has(id)), unasked: named.length ? shots.filter((entry) => !named.includes(entry.id)).map(what) : [],
    missed: named.filter((id) => !changedIds.has(id)), removed, changed: shots.map(what), ...(order ? { order: true } : {}), ...(song ? { music: true } : {}) };
}

// The fresh-eyes line of a board round's ask: what the agent reported, else "not reported" on
// the video's first storyboard ask (the one that offers sound) and nothing on a later one.
const freshWord = (round) => round.fresh ?? (round.offerSound === true ? "not reported" : null);

// Writes a storyboard round's ask (board-text.mjs; the round keeps the one with at most 8 shots)
// and answers waiting_for_you with it, every shot when `all`. `soundFiles`: the person sent
// sound files (kino's media library has some this video does not play yet). The round keeps the
// shot ids in the order it showed them (round.shown: the places the person's words name).
function boardWaiting(draft, round, facts, { all = false, soundFiles = false, soundSearch = false, video = {} } = {}) {
  const input = { id: round.id, board: facts.board, frame: facts.frame, seconds: facts.seconds, music: facts.span?.music ?? null, audio: facts.audio ?? [],
    shape: shapeAsk(draft.brief, boardVideo(facts, video))?.line ?? "", crops: typeof video.cropLine === "string" ? video.cropLine : "", ask: typeof video.askLine === "string" ? video.askLine : "", waived: waivedLine(video.waivers ?? []), heard: unheardLinesLine(video.clipLines),
    message: draft.brief?.fields?.message?.text ?? null, idea: draft.brief?.fields?.idea?.text ?? null, pick: pickLines(draft.brief, draft.origin), bans: guessedBans(draft.brief), soundSearch, soundFiles, offerSound: round.offerSound === true, changed: round.changed ?? null,
    fresh: freshWord(round), redone: round.redone ?? null };
  // A board their settings allow waits only for its open questions (held), and says so.
  const told = (ask) => (round.held ? { ...ask, text: `${ask.text}\n${HELD_LINE}` } : ask);
  const kept = told(boardAsk({ ...input, all: false }));
  const shown = all ? told(boardAsk({ ...input, all: true })) : kept;
  round.ask = kept.text;
  round.board = { rev: facts.board.rev, shots: kept.total, listed: kept.listed, flagged: kept.flagged };
  round.shown = facts.board.shots.map((shot) => shot.id);
  return waitingAnswer(round, shown.text, { ...round.board, listed: shown.listed, flagged: shown.flagged });
}

/**
 * A revised storyboard saved while its board round waits (the service lets only board ops
 * through then): the same round now shows the new revision. Its rev and work move to the saved
 * one (so it does not lapse as "moved on") and its ask is written again from the new board, so the
 * person answers once, on the board they see. Returns the waiting_for_you answer, or null when no
 * board round waits. `facts` is boardFacts(document) of the saved revision; `styleFrame` is the
 * style frame of the new board (null: none), so the ask never names a frame of the old one.
 */
export function reviseWaitingBoard(draft, { facts, rev, work = null, now = Date.now(), soundFiles = false, soundSearch = false, video = {}, styleFrame = null }) {
  const round = waitingStop(draft);
  if (!round || round.kind !== "board" || !facts?.board) return null;
  Object.assign(round, { rev, revisedAt: new Date(now).toISOString(), revisions: (round.revisions ?? 0) + 1, ...(work ? { work } : {}) });
  if (styleFrame) round.styleFrame = styleFrame;
  else delete round.styleFrame;
  return boardWaiting(draft, round, facts, { soundFiles, soundSearch, video });
}

// "shot 3", "shots 3 and 5", "shots 2, 3, 4, and 2 more": the places in `shown` of the named ids.
function namedWords(named, shown = []) {
  const places = named.map((id) => shown.indexOf(id) + 1).filter((place) => place > 0);
  const listed = places.slice(0, 3);
  if (places.length > 3) return `shots ${listed.join(", ")}, and ${places.length - 3} more`;
  return listed.length === 1 ? `shot ${listed[0]}` : `shots ${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
}

// read_as as the agent may write it: trimmed, any case, "_" and "-" for spaces.
const readAsWords = (value) => (typeof value === "string" ? value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") : "");

/**
 * notes {action:"answer", id, rev, words, read_as}: the person's chat reply to a waiting stop, as
 * the agent recorded it. Applied to a draft; returns { text, data } or throws StopError. `rev` is
 * the project's revision now and `work` its workPrint. `waited` is the milliseconds since the ask when the caller measured
 * them on a steady clock (the wall clock can jump: WSL 2 steps it by seconds); without it, the
 * time since askedAt. The words are saved, never sent back to the agent. The service refuses
 * by:"you", a missing id and approval ids (Q…) before this. `video` and `rules` close a waiting
 * stop that no longer stands first (settleWaiting), as checkpointStep does.
 */
export function answerStep(draft, { input = {}, video = null, rules = DEFAULT_STOP_RULES, rev, work = null, now = Date.now(), client = null, waited: measured = null, board = null }) {
  const asked = String(input.id ?? "").trim();
  const stops = draft.stops ?? [];
  // "your call": the person leaves the board's open items or the treatment pick to the agent.
  if (readAsWords(input.read_as) === "your call") return yourCallAnswer(draft, input, { board, now, client });
  // The id (C1), or the stop's name as the docs write it (board): the one waiting, else the latest asked.
  const ofKind = stops.filter((entry) => entry.kind === asked.toLowerCase());
  const round = stops.find((entry) => entry.id.toLowerCase() === asked.toLowerCase()) ?? ofKind.findLast((entry) => entry.status === "waiting") ?? ofKind.at(-1);
  if (!round) throw new StopError("not_found", `kino never asked ${asked} in this project.${stops.length ? ` Asked so far: ${stops.map((entry) => `${entry.id} (${entry.kind})`).join(", ")}.` : ""}`, { didYouMean: closest(asked, stops.map((entry) => entry.id)) });
  settleWaiting(draft, { video, rules, rev, work, now, board });
  const askAgain = `Ask again: notes {action:"checkpoint", id:"${round.kind}"}.`;
  if (round.status === "answered" || round.status === "allowed")
    throw new StopError("answered", `${round.id} is already answered (${howPassed(round).replace("allowed by the person's settings", "allowed")}). If they changed their mind, make the change and ask again.`);
  // The person pressed reopen on the dashboard: the answer recorded was not what they meant.
  if (round.status === "reopened") throw new StopError("reopened", `${round.id} was reopened by the person in kino. ${askAgain}`);
  // It waited when the person reopened an answer before it: they answer again in order.
  if (round.status === "lapsed" && round.lapsedBy)
    throw new StopError("reopened", `${round.id} no longer waits: the person reopened ${round.lapsedBy} in kino. Ask again: notes {action:"checkpoint", id:"${askAfterReopen(draft, round, round.lapsedBy)}"}.`);
  if (round.status === "lapsed" && round.lapsedFor)
    throw new StopError("stale_rev", `${round.id} no longer waits: this video has no ${round.kind} stop now (${round.lapsedFor}). Nothing to record; go on.`, { asked: round.rev, now: rev });
  if (round.status === "lapsed")
    throw new StopError("stale_rev", `${round.id} showed rev ${round.rev}, and the project is rev ${rev} now. ${askAgain}`, { asked: round.rev, now: rev });
  const { words } = input;
  if (typeof words !== "string" || !words.trim())
    throw new StopError("bad_input", `words is the person's reply to ${round.id}, word for word (1–${WORDS_LIMIT} characters).`);
  if (words.length > WORDS_LIMIT)
    throw new StopError("bad_input", `words is at most ${WORDS_LIMIT} characters (it has ${words.length}): record the part of their reply that answers ${round.id}, word for word.`);
  const readAs = readAsWords(input.read_as);
  if (!READ_AS.includes(readAs))
    throw new StopError("bad_input", `read_as is ${READ_AS.slice(0, -1).join(", ")} or ${READ_AS.at(-1)}: how you read their reply.`, { didYouMean: closest(readAs || String(input.read_as ?? ""), READ_AS) });
  if (!Number.isInteger(input.rev))
    throw new StopError("bad_input", `rev is the revision ${round.id} showed (rev ${round.rev}, in its waiting_for_you answer).`);
  // An answer covers only the version the person was shown.
  const moved = movedOn(round, rev, work);
  if (input.rev !== round.rev || moved) {
    const message = moved ? `${round.id} showed rev ${round.rev}, and the project is rev ${rev} now. ${askAgain}`
      : `${round.id} showed rev ${round.rev}, not rev ${input.rev}: record their reply with rev:${round.rev}.`;
    throw new StopError("stale_rev", message, { asked: round.rev, now: rev });
  }
  const waited = Number.isFinite(measured) ? measured : now - Date.parse(round.askedAt);
  if (waited < ANSWER_GAP_MS) {
    const seconds = Math.max(0, Math.floor(waited / 1000));
    throw new StopError("too_fast", `${round.id} was asked ${seconds} s ago: nobody reads a stop that fast. Send the ask and record the reply they send.`, { seconds });
  }
  if (readAs === "stop asking" && !round.offer?.length)
    throw new StopError("not_offered", `${round.id} did not offer "stop asking" (only the first of rough, color and sound does). Read their reply as approve, approve with notes or redo, or ask once what they meant.`);

  const at = new Date(now).toISOString();
  const afterSeconds = Math.floor(waited / 1000);
  // The shots a storyboard redo or approve with notes names: the next ask says which changed.
  const shown = round.kind === "board" ? shownIds(round, board) : [];
  const named = round.kind === "board" && REDONE_READS.includes(readAs) ? namedShots(words, shown) : [];
  const which = named.length ? ` (${namedWords(named, shown)})` : "";
  round.status = "answered";
  // A plain approval of a sound stop with no music keeps the video silent:
  // kino records whose call that was, so it is never reported as something they asked for.
  const silent = Boolean(round.noMusic) && (readAs === "approve" || readAs === "stop asking");
  round.answer = { via: "chat", words, read_as: readAs, at, client, afterSeconds, ...(named.length ? { named } : {}), ...(silent ? { silent: true } : {}) };
  // The board they answered with notes: the next ask says what changed since.
  if (round.kind === "board" && REDONE_READS.includes(readAs)) keepAnswered(draft, round, board);
  if (readAs === "stop asking") draft.stopAsking = { stop: round.id, words, at, client, undoneAt: null };
  // An approved storyboard: kino keeps the board it showed (`board` is boardFacts(document)).
  if (round.kind === "board" && (readAs === "approve" || readAs === "approve with notes")) freezeBoard(draft, round, { board, by: "chat", now });
  // The ask also put the footage's shape to the person: their answer is the plays_on line.
  const shaped = round.shape ? saveShape(draft, round, words.trim(), { now, client }) : null;
  const shapeSaid = shaped?.line ?? "";
  const replies = replyCount(draft);
  const next = {
    approve: 'say "Read as: approve" in one line, then go on.',
    "approve with notes": `say "Read as: approve with notes (<what>)" in one line, make those changes${which}, then go on.`,
    redo: `say "Read as: redo (<what>)" in one line; fix only what they named${which}, ${checkFirst(round.kind)}then ask again: notes {action:"checkpoint", id:"${round.kind}"}.`,
    "stop asking": "say in one line that you go on without stopping for rough, color and sound; go on.",
  }[readAs];
  // The critique stop: a fix is made once (no critic round after), a keep stands as their waiver.
  const critiqueNext = readAs === "redo" ? "make each change they asked for (only those), then check and go on: their answer clears the lines."
    : "the lines stay as they are, in their words; go on to the final render.";
  const said = round.kind === CRITIQUE_STOP ? critiqueNext : next;
  return {
    text: [
      `${round.id} ${round.kind}: ${readAs}, recorded ${afterSeconds} s after asking · replies ${replies.count} of ${replies.limit}`,
      readAs === "stop asking" ? "rough, color and sound are set to allow for this video (set in chat, recorded by the agent; the person can undo it in kino)." : "",
      silent ? `No music: ${SILENT} (${round.noMusic === "search" ? "they picked none of the measured songs" : "they sent no track and sound search is off"}). Your final message says so; never that they asked for silence.` : "",
      shapeSaid,
      `step: ${said}`,
    ].filter(Boolean).join("\n"),
    data: { id: round.id, kind: round.kind, rev: round.rev, read_as: readAs, passed: PASSING_READS.includes(readAs), afterSeconds, replies, next: said, ...(silent ? { silent: SILENT } : {}) },
    ...(REDONE_READS.includes(readAs) || readAs === "redo" ? { nextCall: fixCall } : {}),
    // The shape the scene takes now (the service runs it: update_scene plus frame_shot), not sent to the agent.
    ...(shaped?.follow ? { shapeFollow: shaped.follow } : {}),
  };
}

/**
 * Saves the person's answer to a stop's shape question as the brief's plays_on line (applyBrief,
 * so brief.rev stays right) and returns the line the answer text adds. Their words name a shape
 * (namedShape): the line holds the sentence that names it. Else they left it to kino, which
 * follows the footage. A line that is already saved this way changes nothing.
 */
function saveShape(draft, round, words, { now, client }) {
  const shape = namedShape(words, { reply: true });
  const sentence = shape ? words.split(/(?<=[.!?])\s+|\n+/).find((part) => namedShape(part, { reply: true }) === shape) ?? words : words;
  const quote = sentence.trim().slice(0, 200);
  const line = shape ? { text: `${shape} (their words)`, by: "you", quote, named: shape } : { text: `${round.shape.footage}, like the footage`, by: "you", quote, named: false };
  const before = draft.brief?.fields?.plays_on;
  const same = before && before.by === "you" && before.text === line.text && before.quote === line.quote && before.named === line.named;
  // The person said this line themselves in the stop: a brief they confirmed stays confirmed
  // (no second playback for their own answer).
  const confirmed = draft.brief?.rev > 0 && draft.brief.confirmedRev === draft.brief.rev;
  if (!same) applyBrief(draft, { lines: [{ name: "plays_on", line }], log: [], noPlayback: null }, { now, client });
  if (!same && confirmed) draft.brief.confirmedRev = draft.brief.rev;
  // follow: the shape the service then gives the scene (the named one, or null: the footage's),
  // so a reply with no shape word never leaves the frame a guess for the agent to fix.
  if (shape) return { line: `shape: they named ${shape}; saved as plays_on (brief r${draft.brief.rev})`, follow: { shape } };
  if (round.shape.followed) return { line: `shape: no shape named: it stays ${round.shape.footage} like the footage; saved as plays_on (brief r${draft.brief.rev})`, follow: null };
  return { line: `shape: no shape named: kino follows the footage (${round.shape.footage})`, follow: { shape: null } };
}

/**
 * The person undoes "stop asking" (dashboard): rough, color and sound ask again for this video,
 * and the agent hears it in its inbox. Throws StopError when stops were not turned off in chat.
 */
export function keepAsking(draft, { now = Date.now() } = {}) {
  if (!stopAskingOn(draft)) throw new StopError("nothing_to_undo", "Nothing to undo: stops were not turned off in chat for this video.");
  draft.stopAsking.undoneAt = new Date(now).toISOString();
  draft.inbox.push({ kind: "stops", text: `you turned the rough, color and sound stops back on for this video (undid "stop asking" from ${draft.stopAsking.stop})` });
  draft.turnBreak = true;
  return stopsSummary(draft);
}

// What the person answers on the dashboard: "stop asking" is said in the chat only.
const DASHBOARD_READS = ["approve", "approve with notes", "redo"];
// A stop as the dashboard names it: "rough cut", "color pass".
const labelOf = (kind) => STOP_LABELS[kind].replace(/^the /, "");

// The round the dashboard names (input.id), or a StopError (bad_input, not_found).
function namedRound(draft, input) {
  const asked = typeof input?.id === "string" ? input.id.trim() : "";
  if (!asked) throw new StopError("bad_input", "Choose a stop: id is its C id, such as C2.");
  const round = (draft.stops ?? []).find((entry) => entry.id.toLowerCase() === asked.toLowerCase());
  if (!round) throw new StopError("not_found", `kino never asked ${asked} in this project.`);
  return round;
}

// How a round the person can no longer answer passed, in their words: "approve, in chat".
function answeredFor(round) {
  if (round.status === "allowed") return round.allowedBy === "chat" ? 'allowed by "stop asking"' : round.allowedBy === "same-work" ? `answered with ${round.covers}` : "allowed by your settings";
  return `${round.answer?.read_as}, ${round.answer?.via === "dashboard" ? "on the dashboard" : "in chat"}`;
}

// The notes on single shots of a storyboard answered on the dashboard (input.shots, the c key):
// [{id, n, words}] in board order, or a StopError. An empty or missing list is no notes.
function shotNotes(input, round, readAs, board) {
  const given = input.shots;
  if (given == null || (Array.isArray(given) && !given.length)) return [];
  const isNote = (note) => Boolean(note) && typeof note === "object" && !Array.isArray(note) && typeof note.id === "string" && typeof note.words === "string";
  if (!Array.isArray(given) || !given.every(isNote)) throw new StopError("bad_input", "shots is a list of {id, words}: a note on one shot of the board.");
  if (round.kind !== "board") throw new StopError("bad_input", "Notes on shots go with a storyboard stop.");
  if (readAs === "approve") throw new StopError("bad_input", "approve takes no note: send approve with notes.");
  const shown = shownIds(round, board);
  const seen = new Set();
  const notes = given.map((note) => {
    const id = shown.find((entry) => entry.toLowerCase() === note.id.trim().toLowerCase());
    if (!id) throw new StopError("bad_input", `shot ${note.id.trim()} is not on the board ${round.id} showed.`);
    if (seen.has(id)) throw new StopError("bad_input", `shot ${id} has two notes: send one.`);
    seen.add(id);
    return { id, n: shown.indexOf(id) + 1, words: note.words.trim() };
  });
  for (const note of notes) if (!note.words || note.words.length > SHOT_NOTE_LIMIT) throw new StopError("bad_input", `A note on shot ${note.n} is 1–${SHOT_NOTE_LIMIT} characters.`);
  return notes.sort((a, b) => a.n - b.n);
}

/**
 * The person answers a waiting stop on the dashboard's stop card (POST /api/dashboard/stops
 * {action:"answer", id, rev, read_as, words?, shots?}): approve (no note), approve with notes or
 * redo (with a note; on a storyboard, notes on single shots, shots: [{id, words}], may stand in
 * for it or go with it). Applied to a draft; returns stopsSummary(draft) or throws StopError: bad_input,
 * not_found, not_waiting or stale_rev, with the message the dashboard shows as it is. The
 * waiting round is settled first (settleWaiting), as for the agent's answer; when that closed
 * one, the refusal carries the new summary (details.stops) so the dashboard can show it. `waited`
 * is the milliseconds since the ask on the steady clock, as for answerStep. No too_fast here:
 * the person is at the screen. The agent hears the answer in its inbox with its next call, which
 * marks it answer.heardAt. An approved storyboard (approve, or approve with notes) freezes the
 * board it showed, as a chat answer does (`board` is boardFacts(document); by "dashboard").
 */
export function dashboardAnswerStep(draft, { input = {}, video = null, rules = DEFAULT_STOP_RULES, rev, work = null, now = Date.now(), waited: measured = null, board = null }) {
  const round = namedRound(draft, input);
  const readAs = readAsWords(input.read_as);
  if (readAs === "stop asking") throw new StopError("bad_input", '"Stop asking" is said in the chat. In kino, set a stop to allow in settings.');
  if (!DASHBOARD_READS.includes(readAs)) throw new StopError("bad_input", "read_as is approve, approve with notes or redo.");
  // The note as typed, without spaces around it; null when words is not text at all.
  const words = typeof input.words === "string" ? input.words.trim() : input.words == null ? "" : null;
  const notes = shotNotes(input, round, readAs, board);
  if (notes.length && (words ?? "").length + notes.reduce((sum, note) => sum + note.words.length, 0) > WORDS_LIMIT)
    throw new StopError("bad_input", `The notes together are at most ${WORDS_LIMIT} characters.`);
  if (readAs === "approve" && words !== "") throw new StopError("bad_input", "approve takes no note: send approve with notes.");
  if (readAs !== "approve" && (words === null || (!words && !notes.length) || words.length > WORDS_LIMIT))
    throw new StopError("bad_input", readAs === "redo" ? `A redo needs a note: say what to change (1–${WORDS_LIMIT} characters).` : `approve with notes needs a note (1–${WORDS_LIMIT} characters).`);
  if (!Number.isInteger(input.rev)) throw new StopError("bad_input", `rev is the revision ${round.id} showed (rev ${round.rev}).`);

  const closed = settleWaiting(draft, { video, rules, rev, work, now, board });
  const refuse = (code, message) => new StopError(code, message, closed ? { stops: stopsSummary(draft) } : {});
  const { id } = round;
  if (round.status === "allowed" && round.allowedBy === "settings") throw refuse("not_waiting", `${id} no longer waits: your settings allow the ${labelOf(round.kind)} now.`);
  if (round.status === "answered" || round.status === "allowed") throw refuse("not_waiting", `${id} no longer waits: it is already answered (${answeredFor(round)}).`);
  if (round.status === "lapsed" && round.lapsedBy) throw refuse("not_waiting", `${id} no longer waits: you reopened ${round.lapsedBy}. The agent asks again.`);
  if (round.status === "lapsed" && round.lapsedFor) throw refuse("not_waiting", `${id} no longer waits: this video has no ${labelOf(round.kind)} stop now (${round.lapsedFor}).`);
  if (round.status === "lapsed") throw refuse("not_waiting", `${id} no longer waits: the work changed after it was asked (rev ${round.rev}, now rev ${rev}). The agent asks again.`);
  if (round.status === "reopened") throw refuse("not_waiting", `${id} was reopened: the agent asks again with a new id.`);
  // An answer covers only the version the person was shown.
  if (input.rev !== round.rev) throw refuse("stale_rev", `${id} showed rev ${round.rev}, not rev ${input.rev}: look again.`);

  const waited = Number.isFinite(measured) ? measured : now - Date.parse(round.askedAt);
  // The shots the note names and those noted one by one, in board order: the next ask says
  // which changed.
  const shown = round.kind === "board" ? shownIds(round, board) : [];
  const noted = new Set(notes.map((note) => note.id));
  const named = round.kind === "board" && readAs !== "approve" ? shown.filter((shotId) => noted.has(shotId) || namedShots(words, shown).includes(shotId)) : [];
  round.status = "answered";
  round.answer = { via: "dashboard", words: readAs === "approve" || !words ? null : words, read_as: readAs, at: new Date(now).toISOString(), client: "dashboard", afterSeconds: Math.max(0, Math.floor(waited / 1000)),
    ...(notes.length ? { shots: notes } : {}), ...(named.length ? { named } : {}), ...(round.noMusic && readAs === "approve" ? { silent: true } : {}) };
  // An approved storyboard: kino keeps the board it showed. The work did not move on since the
  // ask (settleWaiting), so the board now is that board.
  if (round.kind === "board" && (readAs === "approve" || readAs === "approve with notes")) freezeBoard(draft, round, { board, by: "dashboard", now });
  if (round.kind === "board" && REDONE_READS.includes(readAs)) keepAnswered(draft, round, board);
  const stop = `${id} ${round.kind}`;
  // Their note, then each shot's: "warmer"; on shot 3 (S3): "tighter".
  const said = [words ? `"${words}"` : "", ...notes.map((note) => `on shot ${note.n} (${note.id}): "${note.words}"`)].filter(Boolean).join("; ");
  const which = named.length ? ` (${namedWords(named, shown)})` : "";
  const text = {
    approve: `${stop} approved by the person in kino. Go on.`,
    "approve with notes": `${stop} approved by the person in kino, with notes: ${said}. Make those changes${which}, then go on.`,
    redo: `${stop}: the person asked for a redo in kino: ${said}. Fix only what they named${which}, ${checkFirst(round.kind)}then ask again: notes {action:"checkpoint", id:"${round.kind}"}.`,
  }[readAs];
  // stopId: when the agent's next call takes this, the answer is marked heard (heardAt, service.mjs).
  draft.inbox.push({ kind: "stop", stopId: id, text });
  draft.turnBreak = true;
  return stopsSummary(draft);
}

/**
 * The person reopens an answered stop on the dashboard (POST /api/dashboard/stops
 * {action:"reopen", id}): the answer the agent recorded from the chat, or their own on the
 * dashboard, is not what they meant. The round becomes reopened and keeps its answer. It no
 * longer passes, so the agent asks that stop again (a new id), and later stops answer
 * out_of_order until then; the agent's writes are not refused meanwhile. A stop waiting now
 * closes (lapsed, lapsedBy: this id): the person goes back to this one, and the agent asks the
 * stops again in order (a later stop builds on the work reopened). Reopening a "stop
 * asking" answer also undoes it. Only the latest round of a kind can be reopened. Applied to a
 * draft; returns stopsSummary(draft) or throws StopError: bad_input, not_found, not_answered or
 * superseded. The agent hears it in its inbox with its next call.
 */
export function reopenStep(draft, { input = {}, now = Date.now() } = {}) {
  const round = namedRound(draft, input);
  const { id } = round;
  if (round.status === "waiting") throw new StopError("not_answered", `${id} is not answered yet: answer it instead.`);
  if (round.status === "lapsed") throw new StopError("not_answered", `${id} lapsed: nothing to reopen.`);
  if (round.status === "reopened") throw new StopError("not_answered", `${id} is already reopened.`);
  if (round.status === "allowed" && round.allowedBy === "chat") throw new StopError("not_answered", `${id} was allowed by "stop asking": use keep asking.`);
  if (round.status === "allowed" && round.allowedBy === "same-work") throw new StopError("not_answered", `${id} passed with ${round.covers}: reopen ${round.covers} instead.`);
  if (round.status === "allowed") throw new StopError("not_answered", `${id} was allowed by your settings: set the ${labelOf(round.kind)} to ask in settings.`);
  const newer = latestRound(draft, round.kind);
  if (newer !== round) throw new StopError("superseded", `${id} has a newer round (${newer.id}) of ${STOP_LABELS[round.kind]}: reopen that one.`);

  const at = new Date(now).toISOString();
  const { answer } = round;
  const waiting = waitingStop(draft);
  round.status = "reopened";
  round.reopenedAt = at;
  if (waiting) Object.assign(waiting, { status: "lapsed", lapsedAt: at, lapsedBy: id });
  const askKind = waiting ? askAfterReopen(draft, waiting, id) : round.kind;
  const undid = answer.read_as === "stop asking" && stopAskingOn(draft) && draft.stopAsking.stop === id;
  if (undid) draft.stopAsking.undoneAt = at;
  const words = answer.words?.length > 200 ? `${answer.words.slice(0, 200)}…` : answer.words;
  const why = answer.via === "dashboard" ? `they take back their answer (${answer.read_as})` : `your record "${words}" (${answer.read_as}) is not what they meant`;
  const closed = waiting ? ` ${waiting.id} ${waiting.kind} no longer waits.` : "";
  draft.inbox.push({ kind: "stop", text: `${id} ${round.kind} reopened by the person in kino: ${why}.${closed} Ask again: notes {action:"checkpoint", id:"${askKind}"}.${undid ? " Rough, color and sound ask again for this video." : ""}` });
  draft.turnBreak = true;
  return stopsSummary(draft);
}

/**
 * The two lines status shows after its header, [direction, step], at most 40 tokens. Before any
 * stop they are the brief's (directionLines), whose step names the first stop to ask once the
 * brief is settled; after, they follow the latest round. The service settles a waiting round
 * first (settleWaiting), so "waiting" means the person still has that stop in front of them.
 */
export function statusLines(state, video = {}, rules = DEFAULT_STOP_RULES) {
  const { direction, step } = statusMove(state, video, rules);
  return [direction, `step: ${step}`];
}

// The calls a stop's step leads to ({tool, input}); <angle brackets> are the agent's to fill in.
const askCall = (kind) => ({ tool: "notes", input: { action: "checkpoint", id: kind } });
const checkCall = { tool: "check", input: { fix: "auto" } };
const fixCall = { tool: "edit", input: { ops: [{ op: "update_layer", layer: "<the layer they named>", properties: { "<field>": "<new value>" } }] } };
const answerCall = (round) => ({ tool: "notes", input: { action: "answer", id: round.id, rev: round.rev, words: "<their reply, word for word>", read_as: "approve" } });

/**
 * What status says comes next: { direction, step, call }. `direction` and `step` are its two
 * lines' words; `call` the exact call for the step, or null when the step is building (the
 * service's build steps say which call: check, review, the stop, render).
 */
export function statusMove(state, video = {}, rules = DEFAULT_STOP_RULES) {
  const plan = stopPlan(state, video, rules);
  const open = plan.find((entry) => !entry.passed);
  // The latest round, unless nothing waits and the first stop still open is one the person
  // reopened: asking it again is what comes next.
  // A critique round counts here only while it waits (buildNext follows the person's answer).
  const latest = (state?.stops ?? []).findLast((entry) => entry.kind !== CRITIQUE_STOP || entry.status === "waiting");
  const round = latest?.status !== "waiting" && open?.round?.status === "reopened" ? open.round : latest;
  if (!round) {
    const stop = hasBrief(state?.brief) ? open?.kind : null;
    const [direction] = directionLines(state, video, stop);
    const { step, call } = nextMove(state, video, stop);
    return { direction, step, call };
  }
  const { count, limit } = replyCount(state);
  // The approved storyboard changed past kino's tolerances (board.mjs): ask it again, unless
  // the video has no storyboard stop now (under its skip-under length).
  const approval = activeApproval(state);
  const boardSkipped = plan.find((entry) => entry.kind === "board")?.skipped;
  if (approval?.lapsed && !boardSkipped && !waitingStop(state)) return { direction: `direction: ${approval.stop} board lapsed · replies ${count}/${limit}`, step: "ask board again (changed shots)", call: askCall("board") };
  // What comes after a stop that is done: the next stop this video has, or the brief's next.
  // The storyboard comes before building (footage added after a later stop passed).
  const onward = open?.kind === "board" ? { step: "ask board, then follow the plan", call: askCall("board") }
    : open ? { step: `follow the plan, then ask ${open.kind}`, call: null } : nextMove(state, video);
  // An earlier stop that is open now comes first (footage added after the storyboard stop was
  // skipped makes it due, and notes checkpoint refuses the later one until it passes).
  const roundAt = plan.findIndex((entry) => entry.kind === round.kind);
  const earlier = open && open.kind !== round.kind && roundAt >= 0 && plan.indexOf(open) < roundAt ? open.kind : null;
  const askAgain = (kind) => (earlier ? `ask ${earlier}, then ${kind}` : `ask ${kind} again`);
  // Check first (not for the storyboard), then ask: the call is the first of the two.
  const checkThenAsk = (kind) => ({ step: `${checkThen(kind)}${askAgain(kind)}`, call: checkThen(kind) ? checkCall : askCall(earlier ?? kind) });
  let words, move;
  if (round.status === "waiting") [words, move] = [`waiting since ${clock(round.askedAt)}`, { step: "end your turn until they answer", call: answerCall(round) }];
  // A stop the video no longer has lapsed: nothing to ask again.
  else if (round.status === "lapsed") [words, move] = ["lapsed", plan.find((entry) => entry.kind === round.kind)?.skipped ? onward : checkThenAsk(round.kind)];
  else if (round.status === "answered" && round.answer?.read_as === "redo") [words, move] = ["redo", { step: `fix what they named, ${checkFirst(round.kind)}${askAgain(round.kind)}`, call: fixCall }];
  // The person reopened the answer on the dashboard: it no longer counts (a storyboard's approval
  // with it: board.mjs activeApproval).
  else if (round.status === "reopened") [words, move] = ["reopened", checkThenAsk(round.kind)];
  else {
    const read = round.answer?.read_as;
    words = round.status === "allowed" ? (round.allowedBy === "chat" ? "allowed in chat" : "allowed")
      : read === "stop asking" ? "allowed in chat" : read === "approve with notes" ? "approved (notes)" : "approved";
    move = onward;
  }
  return { direction: `direction: ${round.id} ${round.kind} ${words} · replies ${count}/${limit}`, step: move.step, call: move.call };
}

/**
 * What the dashboard shows: the waiting stop (with the ask the agent sends, which the stop card
 * shows, and the stops it offers to switch off; a storyboard's also its board {rev, shots,
 * listed, flagged}, so the card shows the board's pages), the last rounds (without their ask) and
 * "stop asking".
 */
export function stopsSummary(state) {
  const waiting = waitingStop(state);
  const stopAsking = state?.stopAsking;
  return {
    waiting: waiting ? { id: waiting.id, kind: waiting.kind, rev: waiting.rev, askedAt: waiting.askedAt, client: waiting.client ?? null, ask: waiting.ask, offer: waiting.offer ?? [],
      // The agent that asked (live.mjs), with the server run it asked in.
      ...(waiting.agentId ? { agentId: waiting.agentId, agentBoot: waiting.agentBoot ?? null } : {}),
      ...(waiting.board ? { board: waiting.board } : {}) } : null,
    // steady is the service's clock stamp for too_fast and work the fingerprint of what the
    // round showed, not things to show; a storyboard's shown and redone are on the board screen
    // (GET /api/dashboard/board-data).
    rounds: (state?.stops ?? []).slice(-ROUNDS_SHOWN).map(({ ask, steady, work, shown, redone, styleFrame, ...round }) => round),
    stopAsking: stopAsking ? { stop: stopAsking.stop, words: stopAsking.words, at: stopAsking.at, undoneAt: stopAsking.undoneAt ?? null } : null,
    board: boardSummary(state),
  };
}
