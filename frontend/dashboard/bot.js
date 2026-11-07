// The agent bots (the small circles with two eyes) as plain data: which mood each agent is in,
// and the eye shapes and motion curves for each mood. bot.jsx draws them. Every mood comes from
// real data: the agent's row (agentRows in state.js), its newest call (data.live.latest), and
// whether you pressed hold. Nothing here is random except when a bot blinks (bot.jsx).
//
// Moods, checked in this order:
//   wait   it needs you (an approval or a stop waits for it)
//   held   you pressed hold (agent writes are paused)
//   work   an edit, render or project call runs or ran in the last 20 s
//   look   a look, inspect, check, status or library call runs or ran in the last 20 s
//   error  its last call failed, less than 20 s ago
//   done   its turn went quiet: its last call finished well, 20 to 40 s ago
//   sleep  no call for over 2 min
//   idle   anything else
import { TURN_GAP_MS, WORKING_MS } from "./state.js";
import { START_MS } from "./presence.js";

export const MOODS = ["idle", "look", "work", "wait", "done", "held", "error", "sleep"];

/** How long "done" (^ ^) shows after the agent stops working. */
export const DONE_MS = 20_000;
/** No call for this long and the bot falls asleep. */
export const SLEEP_MS = TURN_GAP_MS;

// Calls that read (the bot looks around) and calls that write or make (the bot works).
export const LOOK_VERBS = new Set(["look", "inspect", "check", "status", "library"]);
export const WORK_VERBS = new Set(["edit", "render", "project"]);

/** "work" or "look" for one call: by its verb, else by whether it writes. */
export function verbMood(presence) {
  const verb = String(presence?.verb ?? "");
  if (LOOK_VERBS.has(verb)) return "look";
  if (WORK_VERBS.has(verb)) return "work";
  return presence?.write ? "work" : "look";
}

const timeOf = (at) => (typeof at === "number" ? at : Date.parse(at));
const ageAt = (at, now) => {
  const time = timeOf(at);
  return Number.isFinite(time) ? Math.max(0, now - time) : null;
};

/**
 * One agent's mood. `row` is its agentRows() row (or null: then the call alone decides),
 * `presence` its newest call from data.live.latest (or null), `hold` whether hold is on,
 * `now` this computer's clock, `skew` data.live.skew (how far this computer is ahead of the
 * server), `turn` the open project's current turn id (a done call from an older turn is not
 * "done" with this one).
 */
export function botMood({ row = null, presence = null, hold = false, now = Date.now(), skew = 0, turn = null } = {}) {
  const serverNow = now - (Number(skew) || 0);
  const callAge = presence ? ageAt(presence.at, serverNow) : null;
  const running = Boolean(presence) && (presence.phase === "start" || presence.running > 0) && callAge != null && callAge < START_MS;
  // How long since the agent's last call: the row's lastAt (agentRows uses this computer's clock), else the call's.
  const quietFor = row ? ageAt(row.lastAt, now) : callAge;
  const recent = quietFor != null && quietFor < WORKING_MS;

  const waitsForApproval = presence?.phase === "done" && Boolean(presence.approval) && callAge != null && callAge < TURN_GAP_MS;
  if (row?.status === "needs-you" || (!row && waitsForApproval)) return "wait";
  if (hold) return "held";
  if (running) return verbMood(presence);
  const failed = row ? row.status === "failed" : Boolean(presence?.isError) && recent;
  if (failed) return "error";
  if (recent) return presence ? verbMood(presence) : "work";
  const finishedWell = presence?.phase === "done" && !presence.isError && (turn == null || presence.turn === turn);
  if (finishedWell && quietFor != null && quietFor < WORKING_MS + DONE_MS) return "done";
  if (quietFor != null && quietFor > SLEEP_MS) return "sleep";
  return "idle";
}

/** The mood of one agentRows() row, read from the dashboard's data. */
export function moodOfRow(data, row, now = Date.now()) {
  return botMood({
    row, presence: data?.live?.latest?.[row?.id] ?? null, hold: Boolean(data?.hold?.on), now,
    skew: data?.live?.skew ?? 0, turn: data?.agent?.turns?.at(-1)?.id ?? null,
  });
}

// ---- how a bot looks -----------------------------------------------------------------------
// A bot is drawn on a 24-unit circle (viewBox 0 0 24 24). Its eyes are two rounded rects
// centered at x 8.75 and 15.25; "done" (^ ^) and "error" (× ×) are drawn as paths once the
// rects have closed. Eye color is the page's darkest ink.

export const EYE_COLOR = "#0b0e12";
export const EYE_X = [8.75, 15.25];

/** Eye rect per mood, in units: y (top), width, height. */
export const SHAPE = {
  idle: { y: 8, w: 3.5, h: 6 },
  look: { y: 8, w: 3.5, h: 6 },
  work: { y: 10.4, w: 4.5, h: 2.2 },
  wait: { y: 6.2, w: 4, h: 8.4 },
  done: { y: 11, w: 4, h: 0.01 },
  held: { y: 11.6, w: 4.5, h: 1.4 },
  error: { y: 11, w: 4, h: 0.01 },
  sleep: { y: 12.4, w: 4.5, h: 1.2 },
};

// The ^ ^ and × × paths, left eye then right eye.
export const GLYPHS = {
  done: ["M6.6 12.6 L8.8 9.8 L11 12.6", "M13 12.6 L15.2 9.8 L17.4 12.6"],
  error: ["M7 9.2 L10.6 12.8 M10.6 9.2 L7 12.8", "M13.4 9.2 L17 12.8 M17 9.2 L13.4 12.8"],
};

// The smallest an eye line may be on screen, in px, so a 14 px bot's flat eyes still read.
const MIN_EYE_PX = 1.4;
const MIN_STROKE_PX = 1.3;

/** Units per px for a bot `size` px wide. */
const unitsPerPx = (size) => 24 / Math.max(1, size);

/**
 * The eye rect for a mood at `size` px: SHAPE, but a flat eye (work, held, sleep) is never
 * thinner than 1.4 px, so it shows at 12–16 px. Closed eyes (done, error) stay closed.
 */
export function eyeShape(mood, size = 24) {
  const shape = SHAPE[mood] ?? SHAPE.idle;
  if (shape.h < 0.1) return { ...shape };
  const h = Math.max(shape.h, MIN_EYE_PX * unitsPerPx(size));
  // Keep the eye's middle where it was.
  return { y: shape.y - (h - shape.h) / 2, w: shape.w, h };
}

/** The ^ ^ and × × line width, in units: at least 1.3 px on screen. */
export function glyphStroke(size = 24) {
  return Math.max(1.9, MIN_STROKE_PX * unitsPerPx(size));
}

// ---- how a bot moves -----------------------------------------------------------------------

/** Squash and spring back after a mood change: 1 at the start, a damped wobble, 0 after 600 ms. */
export const wobble = (ms) => (ms < 0 || ms > 600 ? 0 : Math.exp(-ms / 110) * Math.cos((ms / 260) * Math.PI * 2));

/** A hop: 0 → 1 → 0 over `length` ms (a half sine). */
export const hop = (ms, length = 260) => (ms < 0 || ms > length ? 0 : Math.sin((ms / length) * Math.PI));

/** The error shake: ±1 → 0 over 360 ms, three times side to side. */
export const shake = (ms) => (ms < 0 || ms >= 360 ? 0 : Math.sin((ms / 120) * Math.PI * 2) * (1 - ms / 360));

/** Eases `current` toward `target`: after `ms` milliseconds about 63% of the way there. */
export const easeToward = (current, target, dt, ms) => current + (target - current) * (1 - Math.exp(-dt / Math.max(1, ms)));

/** How long a blink keeps the eyes shut, in ms; a double blink shuts them again 190 ms in. */
export const BLINK_MS = 120;
export const DOUBLE_AT = 190;

/**
 * How shut the eyes are `ms` after a blink starts: 1 (shut) for 120 ms, else 0; a double blink
 * does it twice. A blink is two steps, not a curve, so a resting bot blinks from a timer and
 * never needs a frame-by-frame loop.
 */
export function blinkShut(ms, double = false) {
  const shut = (t) => t >= 0 && t < BLINK_MS;
  return shut(ms) || (double && shut(ms - DOUBLE_AT)) ? 1 : 0;
}

/** When a blink that started at 0 changes next, in ms: when the eyes open (and shut again). */
export const blinkEdges = (double) => (double ? [BLINK_MS, DOUBLE_AT, DOUBLE_AT + BLINK_MS] : [BLINK_MS]);

/** A sleeping bot's "z" moves in 4 steps of 650 ms (no frame-by-frame loop): rises, then is gone. */
export const Z_STEP_MS = 650;
/** The "z" at step 0 to 3: how high it is (in units, smaller is higher) and how much it shows. */
export function zStep(step) {
  return [{ y: 1, opacity: 0.55 }, { y: -0.8, opacity: 1 }, { y: -2.6, opacity: 0.6 }, { y: -2.6, opacity: 0 }][((step % 4) + 4) % 4];
}

/** The mood boundaries of an agent whose newest call was at `at` (ms): work or look ends, done ends, asleep. */
export function moodTimes(at) {
  return [at + WORKING_MS, at + WORKING_MS + DONE_MS, at + SLEEP_MS + 1];
}

/** When the next blink comes: in 3 to 6 s, or every 10 s under reduced motion. `random` is 0–1. */
export const nextBlinkIn = (still, random) => (still ? 10_000 : 3000 + random * 3000);

/** Moods whose eyes do not blink (closed, flat or glyph eyes). */
export const NO_BLINK = new Set(["done", "error", "held", "sleep"]);

