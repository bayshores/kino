// Relative timing. `at` may be:
//   1.2                 seconds from the start of the scene
//   "after:hero-title"  when that layer's entrance ends ("after:hero-title.in" names the animation)
//   "with:hero-title"   when it starts
//   "cue:drop"          a named moment in document.cues (a marker you set, a beat, a caption word)
//   "auto"              just after the last entrance in the scene (0.2 s into an empty scene)
//   "f12"               frame 12 at the project's frame rate (exactly, not rounded to ms)
// Each may end with +n or -n seconds: "after:hero-title.in-0.2", "with:logo+0.1", "auto+0.3".
// The server turns every form into seconds, and reports the result in the edit's `times`.
import { layoutText, textUnits } from "../textLayout.js";
import { totalUnitDelay } from "../textTiming.js";
import { round } from "../numbers.js";
import { DEFAULT_PROJECT_FPS, frameToTime } from "../frameRate.js";

const FORM = /^(after|with|cue|auto)(?::(.*))?$/;
const OFFSET = /^(.*?)\s*([+-])\s*(\d*\.?\d+)$/;
const AUTO_START = 0.2;

/**
 * Reads an `at` value into {kind: "seconds", seconds} or {kind, target, offset, whole}. A name
 * may itself end in "-2" (step-2), so `whole` keeps the text with no offset taken off: the
 * whole name is tried first.
 */
export function parseAt(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`at ${value} must be 0 seconds or more.`);
    return { kind: "seconds", seconds: value };
  }
  if (typeof value !== "string" || !value.trim()) throw new Error(`at must be seconds, "after:<layer or animation>", "with:<…>", "cue:<name>" or "auto".`);
  const text = value.trim();
  if (/^\d*\.?\d+$/.test(text)) return { kind: "seconds", seconds: Number(text) };
  // "f12": frame 12 at the project's frame rate (frameRate.js projectFps; 30 without one).
  const frame = /^f(\d+)$/i.exec(text);
  if (frame) return { kind: "frame", frame: Number(frame[1]) };
  const auto = /^auto\s*(?:([+-])\s*(\d*\.?\d+))?$/.exec(text);
  if (auto) return { kind: "auto", offset: auto[2] === undefined ? 0 : (auto[1] === "-" ? -1 : 1) * Number(auto[2]) };
  const [, kind, rest = ""] = FORM.exec(text) ?? [];
  if (!kind) throw new Error(`at "${value}" is not a time. Use seconds, "f12" (a frame), "after:hero-title", "with:logo+0.1", "cue:drop" or "auto".`);
  if (kind === "auto") throw new Error(`at "${value}": auto takes no name (write "auto" or "auto+0.3").`);
  const whole = rest.trim();
  if (!whole) throw new Error(`at "${value}" needs a name after "${kind}:".`);
  const split = OFFSET.exec(whole);
  if (split && split[1]) return { kind, target: split[1], offset: (split[2] === "-" ? -1 : 1) * Number(split[3]), whole };
  return { kind, target: whole, offset: 0, whole };
}

/** How many letters, words or lines a text animation runs over (1 for a layer animation). */
export function unitCount(layer, animation, fonts) {
  const unit = animation?.unit ?? "layer";
  if (layer?.type !== "text" || unit === "layer") return 1;
  try { return Math.max(1, textUnits(layoutText(layer, fonts), unit).length); }
  catch { return 1; }
}

/** [start, end] of one animation in seconds, with the delay its stagger adds to the last unit. */
export function animationWindow(layer, animation, fonts, offset = 0) {
  const start = (animation.start ?? 0) + offset;
  const length = animation.kind === "composed"
    ? Math.max(0, ...(animation.animations ?? []).map((member) => (member.start ?? 0) + (member.duration ?? 0)))
    : (animation.duration ?? 0) + totalUnitDelay(animation, unitCount(layer, animation, fonts));
  return [round(start), round(start + length)];
}

/** [start, end] of a layer's entrance: its "in" animations, or all of them when it has none. */
export function entranceWindow(layer, fonts) {
  const animations = (layer.animations ?? []).filter((animation) => animation.kind !== "hide" && animation.kind !== "show");
  const entrances = animations.filter((animation) => animation.kind === "in");
  const chosen = entrances.length ? entrances : animations;
  if (!chosen.length) return null;
  const windows = chosen.map((animation) => animationWindow(layer, animation, fonts));
  return [Math.min(...windows.map((window) => window[0])), Math.max(...windows.map((window) => window[1]))];
}

/** When the last entrance in a scene ends (layers marked decor or background are skipped). */
export function lastEntranceEnd(scene, fonts, { skip = new Set() } = {}) {
  let end = null;
  for (const layer of scene.layers ?? []) {
    if (skip.has(layer.id) || layer.role === "decor" || layer.role === "background" || layer.perpetual) continue;
    const window = entranceWindow(layer, fonts);
    if (window && (end === null || window[1] > end)) end = window[1];
  }
  return end;
}

/**
 * Seconds for an `at` value. `lookup` answers the names:
 *   span(ref)  [start, end] of a layer's entrance or an animation (throws for an unknown name)
 *   cue(name)  a cue's time (throws for an unknown cue)
 *   auto()     the time "auto" means here
 */
export function resolveAt(value, lookup) {
  const at = parseAt(value);
  // A frame's exact start, not rounded to milliseconds: 1.5015 s (frame 36 at 23.976) rounded
  // to 1.502 would first show a frame late.
  if (at.kind === "frame") return frameToTime(at.frame, lookup.fps ?? DEFAULT_PROJECT_FPS);
  let time;
  if (at.kind === "seconds") time = at.seconds;
  else if (at.kind === "auto") time = (lookup.auto?.() ?? AUTO_START) + at.offset;
  else {
    const find = at.kind === "cue" ? (name) => { const t = lookup.cue(name); return [t, t]; } : (name) => lookup.span(name);
    let window;
    let offset = at.offset;
    if (at.whole !== at.target) {
      // "step-2" may be a name, or "step" minus 2 seconds: the whole name wins when it exists.
      try { window = find(at.whole); offset = 0; } catch { window = null; }
    }
    window ??= find(at.target);
    time = (at.kind === "after" ? window[1] : window[0]) + offset;
  }
  if (!Number.isFinite(time)) throw new Error(`at "${value}" is not a time.`);
  if (time < -1e-9) throw new Error(`at "${value}" comes to ${round(time)} s, before the scene starts.`);
  return round(Math.max(0, time));
}

export { AUTO_START };
