// Frame rates: a whole number of frames a second from 1 to 120, or one of the NTSC rates
// 23.976, 29.97 and 59.94 (exactly 24000/1001, 30000/1001 and 60000/1001) that broadcast and
// editing apps expect.
//
// kino keeps a rate as a plain number of frames a second (30000/1001 is 29.97002997...) and every
// time in seconds. parseFps turns what a person or agent writes ("29.97", "30000/1001",
// {num:30000, den:1001}) into that number; frameRateFraction gives the exact fraction back, for
// FFmpeg and for frame-to-time math that must not drift.

const NTSC = Object.freeze([24000, 30000, 60000]);
const NTSC_DEN = 1001;
// "29.97" and "23.976" are rounded spellings of the exact rates: within this many frames a second.
const NTSC_TOLERANCE = 0.0005;

export const FPS_HELP = 'fps is a whole number from 1 to 120, or 23.976, 29.97 or 59.94 (also "30000/1001" or {num:30000, den:1001})';

function fromNumber(value) {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value)) return value >= 1 && value <= 120 ? value : null;
  // Many apps and people write 23.976 as "23.98"; only that rate has a short spelling.
  if (value === 23.98) return 24000 / NTSC_DEN;
  const num = NTSC.find((n) => Math.abs(value - n / NTSC_DEN) <= NTSC_TOLERANCE);
  return num === undefined ? null : num / NTSC_DEN;
}

function fromFraction(num, den) {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den < 1) return null;
  if (den === 1) return fromNumber(num);
  if (den === NTSC_DEN) return NTSC.includes(num) ? num / NTSC_DEN : null;
  return null;
}

/**
 * The frame rate `value` names, as frames a second (a number), or null when it is not one kino
 * renders at. Accepts 30, "30", 29.97, "29.97", "30000/1001" and {num:30000, den:1001}.
 */
export function parseFps(value) {
  if (typeof value === "number") return fromNumber(value);
  if (typeof value === "string") {
    const text = value.trim();
    const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
    if (fraction) return fromFraction(Number(fraction[1]), Number(fraction[2]));
    return /^\d+(\.\d+)?$/.test(text) ? fromNumber(Number(text)) : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return fromFraction(value.num, value.den);
  return null;
}

/** parseFps, or an Error (made by `fail`, default Error) that says what a frame rate may be. */
export function readFps(value, fail = (message) => new Error(message)) {
  const fps = parseFps(value);
  if (fps === null) throw fail(`${FPS_HELP}; not ${JSON.stringify(value)}.`);
  return fps;
}

/** The exact {num, den} of frames a second `fps`: 30 is {30, 1}; 29.97... is {30000, 1001}. */
export function frameRateFraction(fps) {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  const num = NTSC.find((n) => Math.abs(fps - n / NTSC_DEN) <= NTSC_TOLERANCE);
  if (num !== undefined) return { num, den: NTSC_DEN };
  throw new RangeError(`${fps} is not a frame rate kino renders at.`);
}

/** The rate as FFmpeg reads it: "30" or "30000/1001". */
export function ffmpegRate(fps) {
  const { num, den } = frameRateFraction(fps);
  return den === 1 ? String(num) : `${num}/${den}`;
}

/** The rate as people write it: "30", "29.97", "23.976". */
export function fpsLabel(fps) {
  return String(Math.round(fps * 1000) / 1000);
}

/** Frame `frame`'s start in seconds, from the exact fraction (frame 300 at 29.97 is 10.01 s). */
export function frameToTime(frame, fps) {
  const { num, den } = frameRateFraction(fps);
  return (frame * den) / num;
}

// The rate a project's frames step at when it names none: kino's grid before projects kept a rate
// (look, check and draft renders all stepped at 30), so old documents behave as they did.
export const DEFAULT_PROJECT_FPS = 30;

/** The project's own frame rate (document.fps, set at create or by update_project), or 30. */
export function projectFps(document) {
  return parseFps(document?.fps) ?? DEFAULT_PROJECT_FPS;
}

/** The frame of `time` at `fps`: the nearest one (1.5 s at 23.976 is frame 36, 1.5015 s). */
export function nearestFrame(time, fps) {
  const { num, den } = frameRateFraction(fps);
  return Math.max(0, Math.round((time * num) / den));
}

/** `time` moved onto the nearest frame of `fps`, in seconds from the exact fraction. */
export function snapTime(time, fps) {
  return frameToTime(nearestFrame(time, fps), fps);
}

/**
 * Whether `time` sits on a frame of `fps`, within a fiftieth of a frame (my guess: times written
 * with two to four decimals, such as 1.46 or 1.5015 at 23.976, count as on their frame).
 */
export function onFrame(time, fps) {
  const { num, den } = frameRateFraction(fps);
  const frames = (time * num) / den;
  return Math.abs(frames - Math.round(frames)) < 0.02;
}
