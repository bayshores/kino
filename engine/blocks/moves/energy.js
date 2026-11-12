// energy-aura: colored energy (flame, smoke or electric) that starts at the subject's outline,
// rises and breaks up, sits behind the subject with a little spill on it, and steps on twos like
// drawn effects. One call in place of the traced outline the ceiling study C director fell back to
// (.scratch/ceiling/c/result.md, FRICTION and GAPS: "kino has no fire or energy sim tied to a
// cut-out"); the vetted reference wraps a climbing figure and a profile in rising green energy.
//
// Built from what kino has, nothing new is drawn by hand:
// - the subject cut-out: made or reused in the same edit (translate.mjs moveCutouts), as
//   backdrop-flash does; kino's own copy shows only in the move's span.
// - the energy: copies of the cut-out's picture in one group, each drawing only a rim-light ring
//   (edge outside, style lobes, lightOnly) broken up by noise-warp; the copies after the first rise
//   and fade in staggered cycles, so tongues leave the outline and break up as they climb.
// - the group: blend add (light on the dark shot), frameRate on twos (the layer frameRate field).
// - spill: a rim-light on the inside edge of the subject itself, the energy's color.
// - embers (flame) or sparks (electric): the particle looks, on an add carrier in front.
//
// Defaults and where they come from:
// - frameRate 12 (flame, electric) and 8 (smoke): drawn effects step on twos or threes at 24 fps
//   (rim-light's lobeRate 12, engine/effects/rimLight.js); 8 for smoke is a guess (threes).
// - color "auto": the shot's grade hue or measured hue (backdrop-flash shotHue), not turned, at
//   saturation 0.9 and lightness 0.55 (guess, aimed at the reference's bright green flames, which
//   keep the hue of the green-graded shot). Without a hue: #3CF06A, picked by eye from the
//   reference stills (.scratch/studies/energy-aura/ref).
// - height 0.22 of the frame: how far a tongue climbs in one cycle (guess; in the reference stills
//   the flames reach 40 to 60% of the frame above the figure's lowest edge, counting the glow).
// - cycle 0.5 s flame, 1.1 s smoke, 0.35 s electric; three rising copies (guesses tuned by eye).
// - flame ring width 36 px, spread 60, lobes 90 px at 1080: round 1 (width 14, spread 34) read as
//   a thin rim line on a profile clip (.scratch/studies/energy-aura/r1/frame-1.2.png), not the
//   reference's flame mass; 36 and 60 are guesses toward it. That render drew no tongues because
//   rim-light's lobe noise slid out of its filter (crawl -60, fixed in rimLight.js); with it fixed
//   the skeptic renders (f1, f2) show a flame mass rising off the figure, denser than the reference.
import { createLayer } from "../../model.js";
import { effect, hide, mix, motion, round, show } from "./kit.js";
import { hexToHsl, hslToHex, shotHue } from "./backdrop.js";

const FALLBACK = "#3CF06A";
const STYLES = Object.freeze({
  flame: { cycle: 0.5, copies: 3, fps: 12, width: 36, spread: 60, haze: 0.5, lobe: 90, core: 0.25, warp: 40, warpScale: 3, warpSpeed: 2, rise: 1, grow: 1.12, particles: "embers" },
  smoke: { cycle: 1.1, copies: 3, fps: 8, width: 26, spread: 70, haze: 1.1, lobe: 220, core: 0, warp: 52, warpScale: 1.5, warpSpeed: 0.6, rise: 1, grow: 1.25, particles: null },
  electric: { cycle: 0.35, copies: 2, fps: 12, width: 4, spread: 18, haze: 0.5, lobe: 60, core: 0.6, warp: 6, warpScale: 4, warpSpeed: 3, rise: 0.35, grow: 1.04, particles: "sparks" },
});

export const energyAura = {
  name: "energy-aura",
  needsAt: true,
  about: "an aura of colored energy (power, fire, flame, smoke or electric) that rises from the subject's outline, behind the subject with a little spill on it, stepping on twos; kino cuts the subject out of the clip itself",
  fits: "a figure powering up, a climb, a grin, a turn: a full-frame clip or picture with a clear subject, on a dark or graded shot",
  tags: ["particles"],
  length: 2,
  shortest: 0.2,
  fields: {
    layer: { kind: "layer", required: true, about: "the clip or picture (full frame); its subject cut-out is made or reused in the same edit" },
    subject: { kind: "layer", cutout: { of: "layer", auto: true, own: true }, about: "the subject cut-out (default: kino makes one, shown only during the aura, or reuses a cut_out of layer)" },
    color: { kind: "color", auto: true, about: "the energy's color (default auto: the shot's grade or picture hue, bright)" },
    style: { kind: "choice", values: ["flame", "smoke", "electric"], about: "flame (default: tongues rise and break up, embers), smoke (slow, soft, wide) or electric (a thin crackling edge, sparks)" },
    height: { kind: "number", low: 0, high: 1, about: "how far the energy climbs, as a share of the frame height (default 0.22 of the frame's shorter side; 0 stays on the outline)" },
    strength: { kind: "number", low: 0, high: 3, about: "how bright and dense (default 1)" },
    frameRate: { kind: "number", low: 1, high: 60, about: "pictures a second the energy is drawn at (default 12, on twos; smoke 8)" },
    seed: { kind: "number", low: 0, high: 100000, whole: true, about: "another whole number gives other tongues and lobes (default the move's seed)" },
  },
  example: { layer: "shot-a", at: 0.3 },
  setup: "shot-a, a full-frame picture or clip with a clear subject (the edit cuts it out)",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const footage = layer.cutoutOf ? ctx.layer(layer.cutoutOf, "layer") : layer;
    const made = input.subject && ctx.sceneLayers().some((entry) => entry.id === input.subject);
    const subject = made ? ctx.layer(input.subject, "subject") : layer.cutoutOf ? layer : null;
    if (subject && ctx.order(subject.id) < ctx.order(footage.id)) throw new Error(`energy-aura subject: ${subject.id} is under ${footage.id}; the cut-out must be above the clip.`);
    const style = input.style ?? "flame";
    const look = STYLES[style];
    const strength = input.strength ?? 1;
    const t = ctx.start, end = ctx.end;
    // The color.
    let color = input.color && input.color !== "auto" ? input.color : null;
    if (!color) {
      const found = shotHue(ctx, footage);
      color = found ? hslToHex({ h: found.hue, s: 0.9, l: 0.55 }) : FALLBACK;
      ctx.note(found ? `color ${color}: ${footage.id}'s hue from ${found.from} (${Math.round(found.hue)}°)` : `color ${color}: no hue measured on ${footage.id}, the default green`);
    }
    // Smoke is the color grayed toward its own lightness (guess: 45%).
    if (style === "smoke") color = mix(color, hslToHex({ h: 0, s: 0, l: hexToHsl(color).l }), 0.45);
    const scale = Math.min(ctx.frame.width, ctx.frame.height) / 1080;
    const px = (value) => round(value * scale, 1);
    const fps = input.frameRate ?? look.fps;
    const seed = input.seed ?? Math.floor(ctx.rng.next() * 1000);
    // The parts of the move: the energy group, the particles; spill and visibility on the subject.
    const parts = [];
    if (subject) {
      const group = ctx.add("energy", createLayer("group", { x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height,
        blendMode: "add", frameRate: fps, role: "decor", allowOverlap: true }), { below: subject.id });
      parts.push(group);
      const here = ctx.stateAt(subject.id, t);
      const base = { x: round(here.x ?? subject.x, 2), y: round(here.y ?? subject.y, 2), scaleX: round(here.scaleX ?? 1, 4), scaleY: round(here.scaleY ?? 1, 4) };
      const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, cutoutFor: _for, isMask: _mask, ...picture } = subject;
      // The default climb is 0.22 of the frame's shorter side, so the flame is the same size beside
      // its subject in a tall frame as in a wide one (0.22 of a 1920 px height flashed over 3.3% of
      // a 9:16 frame, past the 2.8% the flashing gate allows; 0.22 of 1080 px passes).
      const climb = ctx.reduced ? 0 : (input.height === undefined ? 0.22 * Math.min(ctx.frame.width, ctx.frame.height) : input.height * ctx.frame.height) * look.rise;
      const copies = ctx.reduced || climb === 0 ? 1 : 1 + look.copies;
      let below = null;
      for (let index = 0; index < copies; index += 1) {
        // The first copy stays on the outline (where the energy starts); the others rise. Silent
        // (volume 0): the clip under it already plays the sound.
        const tongue = ctx.add(`tongue-${index + 1}`, createLayer(subject.type, { ...picture, ...base, ...(subject.type === "video" ? { volume: 0 } : {}),
          // perpetual: the rise restarts at the outline every cycle on purpose, an ambient loop like
          // backdrop glow, so speed_jump and judder do not report each restart (16 warnings before).
          cutoutFor: energyAura.name, cutoutOutput: "energy", role: "decor", allowOverlap: true, perpetual: true, opacity: 1 }), { above: below ?? group.id }, group);
        below = tongue.id;
        const rising = index > 0;
        ctx.animate(tongue, "ring", effect({ name: "Energy ring", effect: "rim-light", start: t, duration: end - t, easing: [0, 0, 1, 1],
          // openEdges box: a risen copy's box ends inside the frame, and with "frame" the clip's
          // cut by the frame border was lit as a straight line (skeptic run f1, bottom and right).
          // Intensity 0.55 rising, 0.9 on the outline: at 1.1 and 1.4 the four copies added up to
          // one blown-out wall with no dark gaps (skeptic run f1); lower values are guesses toward
          // the reference stills, where tongues are bright with dark gaps between them.
          to: { color, lightOnly: true, edge: "outside", style: "lobes", openEdges: "box", width: px(look.width * (rising ? 1.3 : 1)), spread: px(look.spread), haze: look.haze, hazeSpread: px(140),
            lobeSize: px(look.lobe), crawl: px(-60), lobeRate: style === "electric" ? fps : 0, flicker: style === "electric" ? 1.2 : 0, seed: seed + index * 17,
            core: look.core, intensity: round(Math.min(4, (rising ? 0.55 : 0.9) * strength), 3) } }));
        ctx.animate(tongue, "break", effect({ name: "Energy break-up", effect: "noise-warp", start: t, duration: end - t, easing: [0, 0, 1, 1],
          to: { amount: Math.min(128, px(look.warp * (rising ? 1.4 : 1))), noiseScale: look.warpScale, speed: look.warpSpeed, contain: false, seed: seed + index * 31 } }));
        if (!rising) continue;
        // Each rising copy climbs `climb` px and fades in one cycle, then starts again at the
        // outline; the copies start a cycle apart / copies, so a tongue leaves every few frames.
        const offset = ((index - 1) / look.copies) * look.cycle;
        for (let begin = t - offset, cycle = 0; begin < end - 1e-6; begin += look.cycle, cycle += 1) {
          const from = Math.max(t, begin), share = (from - begin) / look.cycle;
          const until = Math.min(end, begin + look.cycle), last = (until - begin) / look.cycle;
          const state = (p) => ({ y: round(base.y - climb * p, 2), scaleY: round(base.scaleY * (1 + (look.grow - 1) * p), 4), opacity: round(Math.max(0, 1 - p) ** 1.5, 3) });
          ctx.animate(tongue, `rise-${cycle + 1}`, motion({ name: "Energy rise", start: from, duration: until - from, easing: [0.3, 0.2, 0.7, 0.9], from: state(share), to: state(last) }));
        }
      }
      // Spill: the energy's light on the subject's own edge, inside.
      ctx.animate(subject.id, "spill", effect({ name: "Energy spill", effect: "rim-light", start: t, duration: end - t, easing: [0, 0, 1, 1],
        to: { color, edge: "inside", width: px(10), spread: px(16), haze: 0, core: 0, intensity: round(Math.min(4, 0.55 * strength), 3) } }), "subject");
      if (subject.cutoutFor === energyAura.name) {
        // kino's own cut-out shows only during the aura, with the clip's one-hue grade put back.
        ctx.animate(subject.id, "on", show(t), "subject");
        ctx.animate(subject.id, "off", hide(end), "subject");
        const grades = (footage.animations ?? []).filter((animation) => animation?.kind === "effect" && animation.enabled !== false && ["tritone", "duotone", "glow"].includes(animation.effect));
        grades.forEach((grade, number) => {
          const { id: _gradeId, ...copy } = grade;
          ctx.animate(subject.id, `grade-${number + 1}`, { ...copy, start: t, duration: round(end - t, 4) }, "subject");
        });
      }
    } else {
      ctx.note(`no subject cut-out of ${footage.id}: only the ${look.particles ?? "embers"} rise over the shot`);
    }
    // Particles in front: embers or sparks in the energy's color, more of them with strength.
    const kind = look.particles ?? (subject ? null : "embers");
    if (kind) {
      const carrier = ctx.add("particles", createLayer("rectangle", { x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, radius: 0, fillEnabled: false, strokeWidth: 0,
        blendMode: "add", role: "decor", allowOverlap: true, frameRate: fps }), subject ? { above: subject.id } : { above: footage.id });
      parts.push(carrier);
      // embers: count 70, speed 260, trail 0.06 and wind 40 (guesses aimed at the reference's
      // flecks, short streaks drifting up and sideways); sparks: the look's own burst, fewer.
      const to = kind === "embers"
        ? { count: Math.max(1, Math.round(70 * strength)), size: px(5), speed: px(260), wind: px(40), turbulence: 40, lifetime: 2.5, trail: 0.06, color: mix(color, "#FFFFFF", 0.5), color2: color, opacity: Math.min(1, 0.8 * strength), seed: seed % 1000 }
        : { count: Math.max(1, Math.round(60 * strength)), size: px(2.5), color: mix(color, "#FFFFFF", 0.6), color2: color, opacity: Math.min(1, 0.9 * strength), emitter: "bottom", gravity: 200, seed: seed % 1000 };
      ctx.animate(carrier, kind, effect({ name: kind === "embers" ? "Embers" : "Sparks", effect: kind, start: t, duration: end - t, easing: [0, 0, 1, 1], to }));
    }
    for (const part of parts) {
      ctx.animate(part, "on", show(t));
      ctx.animate(part, "off", hide(end));
    }
    return { end };
  },
};
