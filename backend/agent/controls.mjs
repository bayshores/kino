// The person's controls for one video (brief.controls): whether each stop waits for them or goes
// on, and from what length each stop is asked. The agent saves them from the chat with
// notes {action:"brief", fields:{controls:{rough:"go", skip_under:{board:30}, quote}}}.
//
// Only controls that kino acts on are accepted. The stops read them through stopRules (stops.mjs)
// and the question limit through questionLimit (brief.mjs). Counts, pace, feel and the time cap
// are not controls yet: a value nothing reads would be an inert control, so they are refused.
//
// A control that asks the person less (a stop or the questions set to "go", a longer skip-under)
// needs the person's own words in quote: the agent never turns a stop off on its own. A control
// that asks more ("wait", a shorter skip-under) needs no quote.
// brief.mjs imports this file too; BriefError is only used inside functions, so the cycle is safe.
import { BriefError } from "./brief.mjs";

// The stops, and the brief's questions (asked before the brief is settled).
export const CONTROL_STOPS = Object.freeze(["questions", "board", "rough", "color", "sound"]);
export const CONTROL_VALUES = Object.freeze(["wait", "go"]);
// The stops a skip-under length applies to (the questions have their own rule for short videos).
export const SKIP_STOPS = Object.freeze(["board", "rough", "color", "sound"]);
const SKIP_MAX = 3600;
const QUOTE_LIMIT = 120;
const KEYS = [...CONTROL_STOPS, "skip_under", "quote"];
const HOW = `controls takes ${CONTROL_STOPS.join(", ")} ("wait" or "go"), skip_under ({board:30}, seconds) and quote (the person's words); null removes one.`;
const EXAMPLE = { controls: { rough: "go", quote: "<their exact words>" } };

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (message) => new BriefError("bad_input", `${message} ${HOW}`, { example: EXAMPLE });

/** An empty set of controls: every value takes the person's settings or kino's default. */
export const emptyControls = () => ({ stops: {}, skipUnder: {}, quote: null });

/**
 * The controls sent, merged over the saved ones (`current`, or null), as
 * {stops, skipUnder, quote}; throws BriefError when a value is not one kino takes, or when it asks
 * the person less without their quote. `defaults` is the skip-under length each stop has without
 * a control ({board:8, ...}), to tell a longer one (less asking) from a shorter one.
 */
export function cleanControls(sent, current = null, defaults = {}) {
  if (sent === null) return null;
  if (!isRecord(sent)) throw bad("controls is an object.");
  const extra = Object.keys(sent).filter((key) => !KEYS.includes(key));
  if (extra.length) throw bad(`controls has no ${extra.join(", ")}.`);
  const next = { stops: { ...(current?.stops ?? {}) }, skipUnder: { ...(current?.skipUnder ?? {}) }, quote: current?.quote ?? null };
  let asksLess = false;
  for (const stop of CONTROL_STOPS) {
    if (!Object.hasOwn(sent, stop) || sent[stop] === undefined) continue;
    const value = sent[stop];
    if (value === null) { delete next.stops[stop]; continue; }
    if (!CONTROL_VALUES.includes(value)) throw bad(`controls.${stop} is "wait" or "go" (it has ${JSON.stringify(value)}).`);
    if (value === "go" && next.stops[stop] !== "go") asksLess = true;
    next.stops[stop] = value;
  }
  if (sent.skip_under !== undefined && sent.skip_under !== null) {
    if (!isRecord(sent.skip_under)) throw bad("controls.skip_under is {board:30}: seconds per stop.");
    for (const [stop, value] of Object.entries(sent.skip_under)) {
      if (!SKIP_STOPS.includes(stop)) throw bad(`controls.skip_under has no ${stop}; it takes ${SKIP_STOPS.join(", ")}.`);
      if (value === null) { delete next.skipUnder[stop]; continue; }
      if (!(Number.isSafeInteger(value) && value >= 0 && value <= SKIP_MAX)) throw bad(`controls.skip_under.${stop} is whole seconds, 0 to ${SKIP_MAX} (it has ${JSON.stringify(value)}).`);
      const before = next.skipUnder[stop] ?? defaults[stop] ?? 0;
      if (value > before) asksLess = true;
      next.skipUnder[stop] = value;
    }
  } else if (sent.skip_under === null) next.skipUnder = {};
  if (sent.quote !== undefined && sent.quote !== null) {
    if (typeof sent.quote !== "string" || !sent.quote.trim() || sent.quote.trim().length > QUOTE_LIMIT)
      throw bad(`controls.quote is the person's words, 1 to ${QUOTE_LIMIT} characters.`);
  }
  // Asking the person less is their call: their words, copied from the chat, go with it.
  if (asksLess && !(typeof sent.quote === "string" && sent.quote.trim()))
    throw new BriefError("quote_needed", 'These controls ask the person less (a stop set to "go", or a longer skip_under), so they need quote: the person\'s exact words from the chat. If they did not say it, leave the stop on "wait".',
      { example: { controls: { ...sent, quote: "<their exact words>" } } });
  if (asksLess) next.quote = sent.quote.trim();
  return next;
}

/** The saved controls with no values left are no controls. */
export const hasControls = (controls) => Boolean(controls) && (Object.keys(controls.stops ?? {}).length > 0 || Object.keys(controls.skipUnder ?? {}).length > 0);

/**
 * The stop rules (stops.mjs stopRules) with this video's controls laid over the person's
 * settings: "go" allows a stop, "wait" makes it ask even when the settings allow it, and a
 * skip_under replaces the settings' length. rules.by names "controls" for each stop they set, so
 * a round they let through says so, and stops counting once the control goes back to "wait".
 */
export function withControls(rules, controls) {
  if (!hasControls(controls)) return rules;
  const policy = { ...rules.policy }, skipUnder = { ...rules.skipUnder }, by = { ...(rules.by ?? {}) };
  for (const stop of SKIP_STOPS) {
    const value = controls.stops?.[stop];
    if (value) { policy[stop] = value === "go" ? "allow" : "ask"; by[stop] = "controls"; }
    if (Number.isSafeInteger(controls.skipUnder?.[stop])) skipUnder[stop] = controls.skipUnder[stop];
  }
  return { ...rules, policy, skipUnder, by };
}

/** The questions are set to "go": the agent asks none and guesses the missing lines. */
export const questionsGo = (brief) => brief?.controls?.stops?.questions === "go";

/**
 * The status line for a video with controls, else null: each value with its source word ("you":
 * the person said it, in the quote). Example: "controls (you): rough go · skip board under 30 s".
 */
export function controlsLine(controls) {
  if (!hasControls(controls)) return null;
  const stops = CONTROL_STOPS.filter((stop) => controls.stops?.[stop]).map((stop) => `${stop} ${controls.stops[stop]}`);
  const skips = SKIP_STOPS.filter((stop) => Number.isSafeInteger(controls.skipUnder?.[stop])).map((stop) => `skip ${stop} under ${controls.skipUnder[stop]} s`);
  return `controls (you): ${[...stops, ...skips].join(" · ")}`;
}

/**
 * The receipt line of a save: the steps the controls now pass without the person, in one line,
 * or null. `seconds` is the video's length, so a skip_under longer than it reads as skipped.
 */
export function skippedLine(controls, seconds = 0) {
  if (!hasControls(controls)) return null;
  const going = CONTROL_STOPS.filter((stop) => controls.stops?.[stop] === "go");
  const under = SKIP_STOPS.filter((stop) => !going.includes(stop) && controls.skipUnder?.[stop] > seconds);
  const parts = [...going.map((stop) => `${stop} (go on)`), ...under.map((stop) => `${stop} (under ${controls.skipUnder[stop]} s)`)];
  return parts.length ? `skipped for this video: ${parts.join(", ")}` : null;
}
