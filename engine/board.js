// The storyboard: the shots an agent plans before it builds a video, saved in
// the project document as `board`, so it is saved, undone, merged and exported like any edit.
//
//   document.board = { rev, music, calls, open, shots: [{ id, cue, dur, pacing, media, in, crop,
//     subject, follow, text, sound, move?, why, alts }] }
//
// Every layer of a shot is given, "none" when it is empty, so a missing text or sound shows up
// before anything is built. Times are seconds on the main scene (cue, dur) or in the file (in);
// crop ("whole" for a source shown whole), subject boxes and the eye line are % of the source frame, x and y from its top-left
// corner, as in src/sourceView.js. `music` is the audio layer the shots tile, or "none" for a
// voice-over or silent video, where they tile the whole length. The edit op `board`
// (backend/agent/blocks.mjs) checks what only kino's media and fonts can tell; this file checks
// the shape (normalizeBoard, run last in parseDocument) and the timing (boardCoverage).
//
// `move` is the designed move a shot is built with: {kind, name, ref,
// planned?} or {none: "<reason>"}. A board saved before moves existed has none (unknown); a shot
// with no move or move {none} is plain, "footage plus words" (isPlainShot).
import { mediaPlaybackRange } from "./playback.js";
import { subjectBox } from "./sourceView.js";
import { KEY_ROLES, boardPicks, pickWords } from "./movePicks.js";
import { isRecord } from "./numbers.js";

export const PACING = Object.freeze(["beat_cut", "phrase_flow", "free"]);
// How the crop follows the subject; "none" when the shot has no footage.
export const FOLLOW = Object.freeze(["steady", "track", "sweep"]);
// The layers every shot names, "none" when empty.
export const SHOT_LAYERS = Object.freeze(["media", "in", "crop", "subject", "follow", "text", "sound"]);
// calls: the agent's own (3) and its decisions on the open items the person left to it (3).
export const BOARD_LIMITS = Object.freeze({ shots: 60, what: 40, why: 100, calls: 6, call: 100, open: 3, item: 120, alts: 2, boxes: 4, id: 24, text: 200, family: 100 });
// Shots meet within one frame at 30 fps.
export const ONE_FRAME = 1 / 30;
export const NONE = "none";
// crop "whole": the source is shown whole inside the frame (a portrait phone screen beside other
// things in a 16:9 video), not cropped to the video's shape.
export const WHOLE = "whole";
// The kinds of designed move a shot names, and the planned moves that kino does not have yet: a shot may name one only with planned: true.
export const MOVE_KINDS = Object.freeze(["type", "transition", "camera", "ui"]);
export const PLANNED_MOVES = Object.freeze(["carry", "frame", "drift", "build-in", "type-on", "stream", "focus-band", "ui-plane", "whip", "roll", "accent-hit", "light-sweep", "decode", "assemble"]);
// ref: a saved reference's key and the second of the moment the shot copies, "app-trailer@3.2".
// A YouTube reference may keep the "yt:" of its id (yt:uXlWYZ022zU@3.2); the key is the part after it.
export const MOVE_REF = /^(?:yt:)?([a-z0-9][a-z0-9_-]{0,47})@(\d{1,4}(?:\.\d{1,2})?)$/i;
const MOVE_KEYS = ["kind", "name", "ref", "planned"];

const ID = /^[A-Za-z0-9_-]{1,24}$/;
const HEX = /^#(?:[\da-fA-F]{6}|[\da-fA-F]{8})$/;
const SHOT_KEYS = ["id", "cue", "dur", "pacing", ...SHOT_LAYERS, "move", "why", "alts", "speed"];
const ALT_KEYS = ["media", "in", "crop", "subject", "why"];
const TEXT_KEYS = ["text", "family", "weight", "size", "y", "fill"];
const MAX_SECONDS = 600;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, places) => Number(value.toFixed(places));
// Seconds as kino prints them (backend/agent/describe.mjs sec).
const sec = (value) => Number(value.toFixed(2));

function fail(path, message) {
  throw new Error(`${path} ${message}.`);
}

function text(value, path, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) fail(path, `must be text of 1 to ${limit} characters`);
  return value.trim();
}

/** The scene the board's times are on: the first scene that is not a component. */
export function mainScene(document) {
  return (document?.scenes ?? []).find((scene) => scene.isComponent !== true) ?? null;
}

function normalizeSubject(value, path) {
  if (value === NONE) return NONE;
  if (!isRecord(value)) fail(path, 'must be "none" or {what, boxes, eyes?}');
  const what = text(value.what, `${path}.what`, BOARD_LIMITS.what);
  if (!Array.isArray(value.boxes) || !value.boxes.length || value.boxes.length > BOARD_LIMITS.boxes) fail(`${path}.boxes`, `must be a list of 1 to ${BOARD_LIMITS.boxes} boxes`);
  const boxes = value.boxes.map((box, index) => subjectBox(box) ?? fail(`${path}.boxes[${index}]`, "must be [x, y, w, h] in % of the source frame"));
  if (value.eyes !== undefined && (!isNumber(value.eyes) || value.eyes < 0 || value.eyes > 100)) fail(`${path}.eyes`, "must be the eye line's y in % of the source frame (0 to 100)");
  return { what, boxes, ...(value.eyes !== undefined ? { eyes: round(value.eyes, 1) } : {}) };
}

function normalizeText(value, path) {
  if (value === NONE) return NONE;
  if (!isRecord(value) || Object.keys(value).some((key) => !TEXT_KEYS.includes(key))) fail(path, 'must be "none" or {text, family, weight, size, y, fill}');
  const result = { text: text(value.text, `${path}.text`, BOARD_LIMITS.text), family: text(value.family, `${path}.family`, BOARD_LIMITS.family) };
  if (!Number.isInteger(value.weight) || value.weight < 100 || value.weight > 900) fail(`${path}.weight`, "must be a whole number from 100 to 900");
  if (!isNumber(value.size) || value.size <= 0 || value.size > 2000) fail(`${path}.size`, "must be pixels above 0");
  if (!isNumber(value.y) || value.y < 0 || value.y > 100) fail(`${path}.y`, "must be the text's center in % from the top (0 to 100)");
  if (typeof value.fill !== "string" || !HEX.test(value.fill)) fail(`${path}.fill`, "must be a hex color");
  return { ...result, weight: value.weight, size: round(value.size, 1), y: round(value.y, 1), fill: value.fill };
}

function normalizeSound(value, path) {
  if (value === NONE) return NONE;
  if (!isRecord(value)) fail(path, 'must be "none" or {media, what}');
  return { media: text(value.media, `${path}.media`, 2048), what: text(value.what, `${path}.what`, BOARD_LIMITS.what) };
}

/**
 * What is wrong with a shot's move, one message per bad field (all at once, so one resend fixes
 * them), each starting with `path`: [] when it is right. `known(name)` says whether kino has a
 * move or preset of that name (the board op passes it). `shape: true` checks the shape only, not
 * the names (parseDocument: a saved move whose name was planned, then built, still loads).
 * `refHelp(sentRef)` returns a sentence about the project's saved references, added to a bad ref's message.
 */
export function moveProblems(move, path, known = () => true, { shape = false, refHelp = null } = {}) {
  if (isRecord(move) && Object.hasOwn(move, "none")) {
    const extra = Object.keys(move).filter((key) => key !== "none");
    const problems = extra.map((key) => `${path}.${key} is not a field of move {none}: a shot with no move only says why.`);
    if (typeof move.none !== "string" || !move.none.trim() || move.none.trim().length > BOARD_LIMITS.why) problems.push(`${path}.none is the reason the shot has no designed move (1 to ${BOARD_LIMITS.why} characters).`);
    return problems;
  }
  if (move === NONE) return [`${path} "none" says why: move {none:"<reason>"}.`];
  if (!isRecord(move)) return [`${path} is {kind, name, ref} or {none:"<reason>"}.`];
  const problems = Object.keys(move).filter((key) => !MOVE_KEYS.includes(key)).map((key) => `${path}.${key} is not a field of a move (kind, name, ref, planned).`);
  if (!MOVE_KINDS.includes(move.kind)) problems.push(`${path}.kind is ${MOVE_KINDS.slice(0, -1).join(", ")} or ${MOVE_KINDS.at(-1)}.`);
  const name = typeof move.name === "string" ? move.name.trim() : "";
  if (move.planned !== undefined && move.planned !== true) problems.push(`${path}.planned is true or left out.`);
  if (!name) problems.push(`${path}.name is a kino move or preset (library {topic:"moves"}).`);
  else if (shape) { /* a saved move: its name is not checked */ }
  else if (move.planned === true) {
    if (!PLANNED_MOVES.includes(name)) problems.push(`${path}.name "${name}" is not a planned move: planned are ${PLANNED_MOVES.join(", ")}.`);
  } else if (!known(name)) problems.push(PLANNED_MOVES.includes(name) ? `${path}.name "${name}" is planned, not built yet: add planned: true.` : `${path}.name "${name}" is not a kino move or preset (library {topic:"moves"}).`);
  if (typeof move.ref !== "string" || !MOVE_REF.test(move.ref.trim())) {
    // refHelp(sent): what this project would accept now (its saved keys, or the call that saves one), from the backend.
    const help = refHelp?.(move.ref) ?? "";
    problems.push(`${path}.ref is "<reference key>@<seconds>", the reference moment it copies (e.g. "app-trailer@3.2").${help ? ` ${help}` : ""}`);
  }
  return problems;
}

function normalizeMove(move, path) {
  const [problem] = moveProblems(move, path, undefined, { shape: true });
  if (problem) throw new Error(problem);
  if (Object.hasOwn(move, "none")) return { none: move.none.trim() };
  return { kind: move.kind, name: move.name.trim(), ref: move.ref.trim(), ...(move.planned === true ? { planned: true } : {}) };
}

/** Whether a shot is plain, "footage plus words": no designed move, or none named (an old board). */
export function isPlainShot(shot) {
  return !isRecord(shot?.move) || Object.hasOwn(shot.move, "none");
}

/** Whether a shot names no move at all: neither a designed move nor a chosen plain cut (move {none}). */
export function isUnplannedShot(shot) {
  return !isRecord(shot?.move);
}

/**
 * Why the board cannot be approved yet for want of a designed move, or null. Most shots should
 * be plain cuts on the voice or the beat (move {none:"cut"}), so only the key beats count: the
 * hook, the reveal and the payoff (shotRoles, engine/movePicks.js). The board is refused while
 * none of them names a designed move; the refusal names each role once (a run of payoff
 * shots as "shots 3-6") with moves that fit it, the board's own device first when it already has one (a motif). `names` maps
 * a shot's media src to its file's name, so a screen recording is offered UI moves. `spine`
 * (the style spec's beats): its payoff beat's shots are the payoff, the last shot after it the end.
 * Returns { message, shots: [shot numbers to fix] }.
 */
export function movesNeeded(board, names = {}, spine = null) {
  const shots = board?.shots ?? [];
  const picks = boardPicks(shots, names, spine);
  const keys = picks.flatMap((entry, index) => (KEY_ROLES.includes(entry.role) ? [index + 1] : []));
  if (!keys.length || keys.some((n) => !isPlainShot(shots[n - 1]))) return null;
  // A run of shots in one role (a spine payoff beat cut on the beat) is named once, by its first shot's picks.
  const runs = [];
  for (const n of keys) {
    const last = runs.at(-1);
    if (last && last.to === n - 1 && picks[last.from - 1].role === picks[n - 1].role) last.to = n;
    else runs.push({ from: n, to: n });
  }
  const each = runs.map(({ from, to }) => `${from === to ? `shot ${from}` : `shots ${from}-${to}`} (${picks[from - 1].role}, ${picks[from - 1].word}): ${picks[from - 1].picks.slice(0, 2).map(pickWords).join(" or ")}`);
  const which = keys.length === 1 ? `shot ${keys[0]}` : `one of shots ${keys.join(", ")}`;
  const roles = [...new Set(keys.map((n) => picks[n - 1].role))];
  const named = roles.length > 1 ? `${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}` : roles[0];
  return { message: `no designed move on the ${named} (shot${keys.length === 1 ? "" : "s"} ${keys.join(", ")}). Give ${which} a designed move {kind, name, ref} (library {topic:"moves"}), then ask again; every other shot can stay a plain cut (move {none:"cut"}). Fits: ${each.join("; ")}.`, shots: keys };
}

/** A shot's move in few words: "transition zoom-through (app-trailer@3.2)", "none: <reason>" or "unknown". */
export function moveWords(shot, most = 40) {
  const move = shot?.move;
  if (!isRecord(move)) return "unknown";
  if (Object.hasOwn(move, "none")) return `none: ${move.none.length > most ? `${move.none.slice(0, most - 1).trimEnd()}…` : move.none}`;
  return `${move.kind} ${move.name}${move.planned ? ", planned" : ""} (${move.ref})`;
}

function normalizeMediaFields(shot, path, result) {
  if ("media" in shot) result.media = shot.media === NONE ? NONE : text(shot.media, `${path}.media`, 2048);
  if ("in" in shot) {
    if (shot.in !== NONE && (!isNumber(shot.in) || shot.in < 0 || shot.in > 86_400)) fail(`${path}.in`, 'must be "none" or file seconds, 0 or more');
    result.in = shot.in === NONE ? NONE : round(shot.in, 3);
  }
  if ("crop" in shot) result.crop = shot.crop === NONE || shot.crop === WHOLE ? shot.crop : subjectBox(shot.crop) ?? fail(`${path}.crop`, 'must be "none", "whole" or [x, y, w, h] in % of the source frame');
  if ("subject" in shot) result.subject = normalizeSubject(shot.subject, `${path}.subject`);
}

function normalizeShot(shot, index) {
  const path = `document.board.shots[${index}]`;
  if (!isRecord(shot)) fail(path, "must be a shot {id, cue, dur, pacing, media, in, crop, subject, follow, text, sound, move?, why}");
  const extra = Object.keys(shot).find((key) => !SHOT_KEYS.includes(key));
  if (extra) fail(`${path}.${extra}`, "is not a field of a shot");
  if (typeof shot.id !== "string" || !ID.test(shot.id)) fail(`${path}.id`, "must be 1 to 24 letters, digits, dashes or underscores");
  if (!isNumber(shot.cue) || shot.cue < 0 || shot.cue > MAX_SECONDS) fail(`${path}.cue`, "must be seconds from 0");
  if (!isNumber(shot.dur) || shot.dur <= 0 || shot.dur > MAX_SECONDS) fail(`${path}.dur`, "must be seconds above 0");
  if (!PACING.includes(shot.pacing)) fail(`${path}.pacing`, `must be ${PACING.join(", ")}`);
  for (const layer of SHOT_LAYERS) if (shot[layer] === undefined) fail(`${path}.${layer}`, 'must be given ("none" when empty)');
  const result = { id: shot.id, cue: round(shot.cue, 3), dur: round(shot.dur, 3), pacing: shot.pacing };
  normalizeMediaFields(shot, path, result);
  if (shot.speed !== undefined) {
    if (!isNumber(shot.speed) || shot.speed < 0.05 || shot.speed > 16) fail(`${path}.speed`, "must be the clip's playback speed, 0.05 to 16");
    if (shot.speed !== 1) result.speed = round(shot.speed, 3);
  }
  if (shot.follow !== NONE && !FOLLOW.includes(shot.follow)) fail(`${path}.follow`, `must be ${FOLLOW.join(", ")} or "none"`);
  result.follow = shot.follow;
  result.text = normalizeText(shot.text, `${path}.text`);
  result.sound = normalizeSound(shot.sound, `${path}.sound`);
  if (shot.move !== undefined) result.move = normalizeMove(shot.move, `${path}.move`);
  result.why = text(shot.why, `${path}.why`, BOARD_LIMITS.why);
  const alts = shot.alts ?? [];
  if (!Array.isArray(alts) || alts.length > BOARD_LIMITS.alts) fail(`${path}.alts`, `must be a list of at most ${BOARD_LIMITS.alts} options`);
  result.alts = alts.map((alt, number) => {
    const where = `${path}.alts[${number}]`;
    if (!isRecord(alt) || Object.keys(alt).some((key) => !ALT_KEYS.includes(key))) fail(where, "must be {media?, in?, crop?, subject?, why}");
    const option = {};
    normalizeMediaFields(alt, where, option);
    option.why = text(alt.why, `${where}.why`, BOARD_LIMITS.why);
    return option;
  });
  return result;
}

function normalizeList(value, path, count, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > count) fail(path, `must be a list of at most ${count}`);
  return value.map((entry, index) => text(entry, `${path}[${index}]`, limit));
}

/**
 * Checks the board's shape and types and rounds its numbers (the last step of parseDocument):
 * a document without a board has none. Throws "document.board.shots[2].text must be …" when a
 * field is wrong. Whether the shots fit the video and the files is the board op's check.
 */
export function normalizeBoard(document) {
  if (document.board === undefined || document.board === null) {
    delete document.board;
    return document;
  }
  const board = document.board;
  if (!isRecord(board)) fail("document.board", "must be {rev, music, calls, open, shots}");
  if (!Number.isSafeInteger(board.rev) || board.rev < 1) fail("document.board.rev", "must be a whole number from 1");
  const music = board.music === NONE ? NONE : text(board.music, "document.board.music", 256);
  if (!Array.isArray(board.shots) || !board.shots.length || board.shots.length > BOARD_LIMITS.shots) fail("document.board.shots", `must be a list of 1 to ${BOARD_LIMITS.shots} shots`);
  const shots = board.shots.map(normalizeShot);
  const ids = new Set();
  shots.forEach((shot, index) => {
    if (ids.has(shot.id)) fail(`document.board.shots[${index}].id`, "must be unique");
    ids.add(shot.id);
  });
  document.board = {
    rev: board.rev, music,
    calls: normalizeList(board.calls, "document.board.calls", BOARD_LIMITS.calls, BOARD_LIMITS.call),
    open: normalizeList(board.open, "document.board.open", BOARD_LIMITS.open, BOARD_LIMITS.item),
    shots,
  };
  return document;
}

// How far apart two shots are when one may be the other sent again, or null when it cannot be:
// the same footage at in-points within IN_MATCH seconds, or the same text on shots with no footage.
const IN_MATCH = 1;
function shotDistance(shot, old) {
  if (shot.media !== NONE && shot.media === old.media && isNumber(shot.in) && isNumber(old.in)) {
    const apart = Math.abs(shot.in - old.in);
    return apart <= IN_MATCH ? apart : null;
  }
  if (shot.media === NONE && old.media === NONE && isRecord(shot.text) && isRecord(old.text) && shot.text.text === old.text.text)
    return Math.abs(shot.cue - old.cue) / MAX_SECONDS;
  return null;
}

/**
 * Gives each shot sent without an id the id of the shot it continues in the board saved before
 * (`previous`, its shots), so a board sent again keeps its ids and the approved storyboard's
 * rules (backend/agent/board.mjs) compare each shot with itself, not with whatever shot was at
 * its place: the same footage at the nearest in-point (within 1 s), else the same text on a
 * shot with no footage, else the shot at the same place. A shot that matches none gets a new id,
 * S and a number past every id in either board. Ids the agent sent are kept. Changes `shots`.
 */
export function keepShotIds(shots, previous = []) {
  const sent = new Set(shots.map((shot) => shot.id).filter((id) => id !== undefined));
  const free = previous.filter((old) => !sent.has(old.id));
  const claimed = new Set();
  const take = (shot, old) => { shot.id = old.id; claimed.add(old.id); };
  const pairs = [];
  for (const shot of shots) if (shot.id === undefined) for (const old of free) {
    const distance = shotDistance(shot, old);
    if (distance !== null) pairs.push({ shot, old, distance });
  }
  pairs.sort((a, b) => a.distance - b.distance);
  for (const { shot, old } of pairs) if (shot.id === undefined && !claimed.has(old.id)) take(shot, old);
  shots.forEach((shot, index) => {
    const old = previous[index];
    if (shot.id === undefined && old && !sent.has(old.id) && !claimed.has(old.id) && !shots.some((other) => other.id === old.id)) take(shot, old);
  });
  const numbers = [...previous, ...shots].map((shot) => /^S(\d+)$/.exec(shot.id ?? "")?.[1]).filter(Boolean).map(Number);
  let next = Math.max(0, ...numbers);
  for (const shot of shots) if (shot.id === undefined) shot.id = `S${(next += 1)}`;
  return shots;
}

/**
 * What the shots must cover: { start, end, music, length }. With a music layer that plays in the
 * main scene, its Play range (music: the layer's name); otherwise the whole main scene, 0 to its
 * length (music: null). `length` is the video's length (the main scene's duration).
 */
export function boardSpan(document, board = document?.board) {
  const scene = mainScene(document);
  const length = Number(scene?.duration) || 0;
  const layer = board && board.music !== NONE ? scene?.layers?.find((entry) => entry.id === board.music) : null;
  const range = layer ? mediaPlaybackRange(layer, length) : null;
  if (range) return { start: round(range.start, 3), end: round(range.end, 3), music: layer.name || layer.id, length };
  return { start: 0, end: length, music: null, length };
}

/**
 * Whether the shots tile the span (boardSpan) with no gap and no overlap: null when they do,
 * else { code: "gap" | "overlap", message, at: [a, b] } for the first problem in time order.
 * Shots are in time order and each starts where the last ended, within ONE_FRAME; the first
 * starts by the span's start, the last ends at or after its end, and none ends after the video.
 */
export function boardCoverage(board, span) {
  const shots = board?.shots ?? [];
  if (!shots.length) return null;
  const where = span.music ? "music" : "video";
  const end = (shot) => shot.cue + shot.dur;
  for (const [index, shot] of shots.entries()) {
    const n = index + 1;
    if (index === 0 && shot.cue > span.start + ONE_FRAME)
      return { code: "gap", message: `the shots start at ${sec(shot.cue)} s, after the ${where} starts (${sec(span.start)} s): start shot 1 at ${sec(span.start)} s.`, at: [span.start, shot.cue] };
    if (index > 0) {
      const last = shots[index - 1];
      if (shot.cue < last.cue)
        return { code: "overlap", message: `shots are in time order: shot ${n} starts at ${sec(shot.cue)} s, before shot ${index} (${sec(last.cue)} s).`, at: [shot.cue, last.cue] };
      if (shot.cue < end(last) - ONE_FRAME)
        return { code: "overlap", message: `shot ${n} starts at ${sec(shot.cue)} s, inside shot ${index} (${sec(last.cue)}–${sec(end(last))} s): start it at ${sec(end(last))} s.`, at: [shot.cue, end(last)] };
      if (shot.cue > end(last) + ONE_FRAME)
        return { code: "gap", message: `the shots leave a gap in the ${where} from ${sec(end(last))} to ${sec(shot.cue)} s (after shot ${index}): make shot ${index} longer or start shot ${n} at ${sec(end(last))} s.`, at: [end(last), shot.cue] };
    }
    if (end(shot) > span.length + ONE_FRAME)
      return { code: "overlap", message: `shot ${n} ends at ${sec(end(shot))} s, after the video ends (${sec(span.length)} s).`, at: [span.length, end(shot)] };
  }
  const last = end(shots.at(-1));
  if (last < span.end - ONE_FRAME)
    return { code: "gap", message: `the shots end at ${sec(last)} s, before the ${where} ends (${sec(span.end)} s): make the last shot ${sec(span.end - last)} s longer.`, at: [last, span.end] };
  return null;
}

/**
 * The widest window of `frame`'s shape on a file of `source` pixels, centered on `crop`'s center
 * and kept inside the file: [x, y, w, h] in % of the file, one decimal. kino uses it when it gives
 * a scene with a board another shape (backend/agent/service.mjs followShape), so each shot keeps
 * what it was centered on and shows as much of its file as the new frame allows.
 */
export function reframeCrop(crop, source, frame) {
  const aspect = frame.width / frame.height;
  const wide = source.width / source.height >= aspect;
  const w = round(wide ? (aspect * source.height * 100) / source.width : 100, 1);
  const h = round(wide ? 100 : (source.width * 100) / aspect / source.height, 1);
  const [x, y, cw, ch] = crop;
  const place = (center, size) => Math.min(round(100 - size, 1), Math.max(0, round(center - size / 2, 1)));
  return [place(x + cw / 2, w), place(y + ch / 2, h), w, h];
}

/**
 * The board with each crop given in [x, y, w, h] (shots and their options) re-framed to `frame`
 * (reframeCrop), or null when no crop changed. `sizeOf(src)` is the file's {width, height} or null
 * (a crop on a file of unknown size is kept). Returns { board, shots: the numbers of the shots whose crop changed }.
 */
export function reframeBoard(board, frame, sizeOf) {
  if (!board?.shots?.length || !(frame?.width > 0 && frame?.height > 0)) return null;
  const changed = new Set();
  const redo = (crop, media, n) => {
    const source = Array.isArray(crop) && typeof media === "string" && media !== NONE ? sizeOf(media) : null;
    if (!(source?.width > 0 && source?.height > 0)) return crop;
    const next = reframeCrop(crop, source, frame);
    if (next.some((value, index) => value !== crop[index])) changed.add(n);
    return next;
  };
  const shots = board.shots.map((shot, index) => ({
    ...shot,
    crop: redo(shot.crop, shot.media, index + 1),
    ...(Array.isArray(shot.alts) ? { alts: shot.alts.map((alt) => (Object.hasOwn(alt, "crop") ? { ...alt, crop: redo(alt.crop, alt.media ?? shot.media, index + 1) } : alt)) } : {}),
  }));
  return changed.size ? { board: { ...board, shots }, shots: [...changed] } : null;
}
