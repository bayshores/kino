// backdrop-flash: for a few frames the shot behind the subject becomes a flat color field (a
// radial field, lighter in the middle), optionally with falling streaks, while the subject (the
// cut-out of the shot) stays in front with a rim light and the frame punches in a touch.
// One call in place of the 7 to 14 layers and 2 to 4 cut_outs the technique studies built by hand
// (.scratch/studies/grade-bloom-flash, cutout-composite: rectangle, show, hide, two cut_outs, rim
// glow, group and punch-in).
//
// The subject: the edit makes (or reuses) the cut-out of `layer` and passes it as `subject`
// (backend/agent/translate.mjs, moveCutouts). Without one (the engine alone, or no cut-out on
// this computer) the field tints the shot in "color" blend instead, and a note says so.
//
// Defaults and where they come from:
// - frames [1, 1, 0, 1] at 30 fps: the treatments table in the studies' synthesis (the reference
//   flash holds 1 to 3 frames, flickers once).
// - field colors: the study's final field #36E01C (hsl about 112°, 78%, 49%) with #62F246 in the
//   middle and #1A9A10 at the edges; here the middle is the base mixed 20% to white and the edge
//   32% to black, which gives the same three colors for that green.
// - color "auto": the hue of the shot's own grade when it has a tritone or duotone (its midtone, or
//   its highlight), else the shot's dominant hue measured from its picture at `at`, turned -35°.
//   Evidence for -35°: grade-bloom-flash graded the shot #2FA866 (147°) and settled on #36E01C
//   (112°). Saturation 78% and lightness 49% are the study's field. Without either: the study's green.
// - rim: rim-light width 8, spread 20 (the effect's own defaults, from the rim studies); its color
//   the field's hue turned another -25° at 68% lightness (guess, aimed at the reference's
//   yellow-green rim #D4FF5A over the green field).
// - punch 1.06: the treatments table (the study used 1.08 over 0.1 s; the reference is "a touch closer").
// - texture "streaks": the particle look streaks, faint and light over the field (count 600 and
//   opacity 0.35 are guesses aimed at the reference's faint vertical streaks; the study used
//   speed-lines at opacity 0.18).
import { boxOf, effect, hide, mix, motion, round, scaledAbout, show, centerOf } from "./kit.js";

const FRAME = 1 / 30;
const PATTERN = [1, 1, 0, 1];
const TURN = -35;
const RIM_TURN = -25;
const FALLBACK = "#36E01C";

/** #RRGGBB to {h (degrees), s, l (0 to 1)}. */
export function hexToHsl(hex) {
  const [r, g, b] = [0, 1, 2].map((index) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255);
  const high = Math.max(r, g, b), low = Math.min(r, g, b), l = (high + low) / 2, d = high - low;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = high === r ? 60 * (((g - b) / d) % 6) : high === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** {h, s, l} to #RRGGBB. */
export function hslToHex({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hue = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs((hue % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** The hue the field turns from: the layer's own grade (tritone midtone, duotone highlight), else its measured picture. */
function shotHue(ctx, layer) {
  for (const animation of [...(layer.animations ?? [])].reverse()) {
    if (animation?.kind !== "effect" || animation.enabled === false) continue;
    const values = { ...(animation.from ?? {}), ...(animation.to ?? {}), ...(animation.parameters ?? {}) };
    const color = animation.effect === "tritone" ? values.midtoneColor : animation.effect === "duotone" ? values.highlightColor : null;
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) && hexToHsl(color).s > 0.15) return { hue: hexToHsl(color).h, from: `its ${animation.effect} grade` };
  }
  const measured = ctx.shotColor(layer.id);
  if (measured && measured.s > 0.12) return { hue: measured.h, from: "its picture" };
  return null;
}

/** On and off runs of a frame pattern: [{start, frames}] for each run of 1s. */
function onRuns(pattern) {
  const runs = [];
  pattern.forEach((on, index) => {
    if (!on) return;
    const last = runs.at(-1);
    if (last && last.start + last.frames === index) last.frames += 1;
    else runs.push({ start: index, frames: 1 });
  });
  return runs;
}

export const backdropFlash = {
  name: "backdrop-flash",
  needsAt: true,
  about: "for a few frames the background behind the subject becomes a flat color field (a color flash behind a person), with falling streaks, a rim light on the subject and a small punch-in; kino cuts the subject out of the clip itself",
  fits: "a hit, a beat, a line that lands: 2 to 6 frames on a full-frame clip with a clear subject",
  tags: ["flash", "punch-in"],
  length: PATTERN.length * FRAME,
  shortest: FRAME,
  fields: {
    layer: { kind: "layer", required: true, about: "the clip or picture (full frame); its subject cut-out is made or reused in the same edit" },
    subject: { kind: "layer", cutout: { of: "layer", auto: true }, about: "the subject cut-out (default: kino makes or reuses the cut_out of layer; a plain clip given here is cut out too)" },
    frames: { kind: "flags", most: 24, about: "the flash's frames at 30 fps, 1 on and 0 off (default [1, 1, 0, 1])" },
    color: { kind: "color", auto: true, about: "the field's color (default auto: the shot's grade or picture hue turned -35°)" },
    texture: { kind: "choice", values: ["streaks", "none"], about: "streaks (default: faint falling light streaks on the field) or none (a flat field)" },
    rim: { kind: "choice", values: [true, false], about: "a rim light on the subject while the field shows (default true)" },
    punch: { kind: "number", low: 1, high: 1.5, about: "how much closer the frame is during the flash (default 1.06; 1 none)" },
  },
  example: { layer: "shot-a", at: 0.3 },
  setup: "shot-a, a full-frame picture or clip with a clear subject (the edit cuts it out)",
  timing: (input) => ({ length: round((input.frames ?? PATTERN).length * FRAME, 4) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const footage = layer.cutoutOf ? ctx.layer(layer.cutoutOf, "layer") : layer;
    const subject = input.subject ? ctx.layer(input.subject, "subject") : layer.cutoutOf ? layer : null;
    if (subject && ctx.order(subject.id) < ctx.order(footage.id)) throw new Error(`backdrop-flash subject: ${subject.id} is under ${footage.id}; the cut-out must be above the clip.`);
    const pattern = input.frames ?? PATTERN;
    if (!pattern.some(Boolean)) throw new Error("backdrop-flash frames: give at least one 1 (an on frame).");
    const t = ctx.start;
    const end = round(t + pattern.length * FRAME, 4);
    // The field's color.
    let base = input.color && input.color !== "auto" ? input.color : null;
    if (!base) {
      const found = shotHue(ctx, footage);
      base = found ? hslToHex({ h: found.hue + TURN, s: 0.78, l: 0.49 }) : FALLBACK;
      ctx.note(found ? `color ${base}: ${footage.id}'s hue from ${found.from} (${Math.round(found.hue)}°) turned ${TURN}°` : `color ${base}: no hue measured on ${footage.id}, the default green`);
    }
    const { h } = hexToHsl(base);
    const size = Math.round(Math.max(ctx.frame.width, ctx.frame.height) * 1.25);
    const field = ctx.add("field", {
      type: "rectangle", x: Math.round((ctx.frame.width - size) / 2), y: Math.round((ctx.frame.height - size) / 2), width: size, height: size, radius: 0,
      fill: { type: "radial", stops: [{ offset: 0, color: mix(base, "#FFFFFF", 0.2) }, { offset: 0.45, color: base }, { offset: 1, color: mix(base, "#000000", 0.32) }] },
      strokeWidth: 0, opacity: 1, visible: true, role: "decor", allowOverlap: true, ...(subject ? {} : { blendMode: "color" }),
    }, subject ? { below: subject.id } : { above: footage.id });
    if (!subject) ctx.note(`no subject cut-out of ${footage.id}: the field tints the shot (blend color) instead of replacing what is behind the subject`);
    // On and off frames: shown on each run of 1s, hidden after it.
    const runs = onRuns(pattern);
    for (const [index, run] of runs.entries()) {
      ctx.animate(field, `on-${index + 1}`, show(t + run.start * FRAME));
      ctx.animate(field, `off-${index + 1}`, hide(t + (run.start + run.frames) * FRAME));
    }
    if ((input.texture ?? "streaks") === "streaks") {
      // From the scene's start, so the falling field is full (not just born) when it shows.
      ctx.animate(field, "streaks", effect({ name: "Streaks", effect: "streaks", start: 0, duration: Math.max(FRAME, end), easing: [0, 0, 1, 1],
        to: { count: 600, color: mix(base, "#FFFFFF", 0.35), color2: mix(base, "#FFFFFF", 0.8), opacity: 0.35, direction: 180, haze: 0 } }));
    }
    if (subject && (input.rim ?? true) && !ctx.reduced) {
      const rimColor = hslToHex({ h: h + RIM_TURN, s: 1, l: 0.68 });
      runs.forEach((run, index) => ctx.animate(subject.id, `rim-${index + 1}`, effect({ name: "Flash rim", effect: "rim-light", start: t + run.start * FRAME, duration: run.frames * FRAME, easing: [0, 0, 1, 1],
        to: { color: rimColor, width: 8, spread: 20 } }), "subject"));
    }
    const punch = ctx.reduced ? 1 : input.punch ?? 1.06;
    if (punch > 1) {
      // The clip and its cut-out snap closer together (the same box, so they stay on each other) and cut back.
      const here = ctx.stateAt(footage.id, t);
      const scaleX = here.scaleX ?? 1, scaleY = here.scaleY ?? 1;
      const box = { ...boxOf(footage), x: here.x ?? footage.x, y: here.y ?? footage.y };
      const moved = scaledAbout(box, centerOf(box), punch);
      const rest = { x: round(box.x, 2), y: round(box.y, 2), scaleX: round(scaleX, 4), scaleY: round(scaleY, 4) };
      const close = { x: round(moved.x, 2), y: round(moved.y, 2), scaleX: round(scaleX * punch, 4), scaleY: round(scaleY * punch, 4) };
      for (const [target, role] of [[footage.id, "layer"], ...(subject ? [[subject.id, "subject"]] : [])]) {
        ctx.animate(target, "punch", motion({ name: `Flash punch x${round(punch, 2)}`, start: Math.max(0, t - 0.001), duration: 0.001, easing: [0, 0, 1, 1], from: rest, to: close }), role);
        ctx.animate(target, "back", motion({ name: "Flash punch back", start: end - 0.001, duration: 0.001, easing: [0, 0, 1, 1], from: close, to: rest }), role);
      }
    }
    return { end, tags: punch > 1 ? backdropFlash.tags : ["flash"] };
  },
};
