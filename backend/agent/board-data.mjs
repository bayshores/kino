// The storyboard as data for the dashboard's board screen (GET /api/dashboard/board-data, B4b):
// what a board stop showed, so the screen writes every shot as real text at its normal size
// and draws the crop, the subject boxes and the app's covered areas on the shot's own images
// (GET /api/dashboard/board-shot), instead of shrinking the agent's page images. The same
// measures as the agent's chat text and look board (engine/boardMeasure.js), so the person and the
// agent read the same numbers. Plain data in and out: the service reads the project, the
// revision, the agent state and the media records.
import { boardSpan, mainScene, NONE } from "../../engine/board.js";
import { isPortrait, shotMeasures } from "../../engine/boardMeasure.js";
import { shotRoles } from "../../engine/movePicks.js";
import { SAFE_ZONES } from "../../engine/quality/rules/layout.js";
import { boardFacts } from "./board.mjs";
import { sec } from "./describe.mjs";

// The shapes the header names; another one is written as its size.
const ASPECTS = [["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["4:5", 4 / 5]];

const isNone = (value) => value === NONE || value == null;
const percent = (share) => Number((share * 100).toFixed(1));

/** "9:16", "16:9", "1:1", "4:5" (within 2%, as isPortrait), else "<w>×<h>". */
export function aspectWords({ width, height }) {
  const found = width > 0 && height > 0 ? ASPECTS.find(([, ratio]) => Math.abs(width / height / ratio - 1) <= 0.02) : null;
  return found ? found[0] : `${width}×${height}`;
}

// A shot's file: "none", its record's facts, or {src, missing: true} when kino's library no
// longer has it.
function mediaFacts(src, record) {
  if (isNone(src)) return NONE;
  if (!record) return { src, missing: true };
  const kind = String(record.mime ?? "").startsWith("image/") ? "image" : "video";
  return { src, name: record.name ?? String(src).replace(/^\/api\/media\//, ""), width: record.width ?? null, height: record.height ?? null, kind };
}

// How a shot changed since the board the person answered (round.redone, stops.mjs): asked true
// when they named it, false when it changed without being asked; null when they named no shot
// (the ask says "Changed since C1"); the whole field null when it did not change.
function changeOf(id, redone) {
  if (!redone) return null;
  const what = (redone.changed ?? []).find((entry) => entry.id === id)?.what;
  if (!what) return null;
  if (!(redone.named ?? []).length) return { asked: null, what };
  return { asked: (redone.asked ?? []).includes(id), what };
}

/**
 * The board screen's data (B4b design F6) for the board in `document` (the revision `rev`):
 * `round` is the board stop that showed it, or null ("not asked yet"); `state` the agent state
 * (the brief's lines); `records` a Map of each shot's media src to its library record or null;
 * `soundFiles` whether the person sent sound files for this video; `soundSearch` whether the
 * person turned on sound search in Settings (backend/sound-search.mjs). Returns null when the
 * revision has no board.
 */
export function boardData(document, { state = null, round = null, rev, project, records = new Map(), soundFiles = false, soundSearch = false }) {
  const board = document?.board;
  if (!board?.shots?.length) return null;
  const scene = mainScene(document);
  const frame = { width: scene?.width ?? 0, height: scene?.height ?? 0 };
  const facts = boardFacts(document);
  const fields = state?.brief?.fields ?? {};
  const answer = round?.answer;
  const redone = round?.redone ?? null;
  // The hook, the reveal and the payoff, as kino picks moves for them (engine/movePicks.js).
  const names = Object.fromEntries([...records].map(([src, record]) => [src, record?.name ?? null]));
  const roles = shotRoles(board.shots, names);
  return {
    project,
    rev,
    stop: round?.id ?? null,
    status: round?.status ?? "not asked yet",
    answer: answer ? { via: answer.via, read_as: answer.read_as, words: answer.words ?? null, shots: answer.shots ?? [], at: answer.at } : null,
    fresh: round?.fresh ?? null,
    header: { board: board.rev, shots: board.shots.length, seconds: sec(Number(scene?.duration) || 0), width: frame.width, height: frame.height, aspect: aspectWords(frame), background: scene?.background ?? "#000000",
      platform: fields.plays_on?.text ?? null },
    purpose: fields.message?.text ?? null,
    music: boardSpan(document, board).music,
    audio: facts.audio,
    calls: board.calls ?? [],
    open: board.open ?? [],
    lapsed: round?.changed ? { why: round.changed.why ?? [], approved: round.changed.approved ?? null } : null,
    redone,
    // The phone app's covered areas (engine/quality/rules/layout.js: third-party measurements).
    covered: isPortrait(frame) ? { right: percent(SAFE_ZONES.portrait.right), bottom: percent(SAFE_ZONES.portrait.bottom), verified: false } : null,
    shots: board.shots.map((shot, index) => ({
      n: index + 1,
      id: shot.id,
      start: sec(shot.cue),
      end: sec(shot.cue + shot.dur),
      dur: sec(shot.dur),
      speed: shot.speed ?? 1,
      role: roles[index],
      pacing: shot.pacing,
      follow: shot.follow,
      in: shot.in,
      crop: shot.crop,
      text: shot.text,
      sound: shot.sound,
      why: shot.why,
      // An option keeps the shot's own media, in-point and crop where it leaves them out.
      alts: (shot.alts ?? []).map((alt) => ({ ...alt, ...(alt.media === undefined ? {} : { media: mediaFacts(alt.media, records.get(alt.media) ?? null) }) })),
      move: shot.move ?? NONE,
      media: mediaFacts(shot.media, records.get(shot.media) ?? null),
      // Every subject box is the agent's until kino has detectors (direction plan B12).
      subject: isNone(shot.subject) ? NONE : { ...shot.subject, by: "agent" },
      measures: shotMeasures(shot, frame),
      change: changeOf(shot.id, redone),
    })),
    soundSearch,
    soundFiles,
  };
}
