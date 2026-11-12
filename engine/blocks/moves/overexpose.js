// overexpose: the shot's own exposure rises to a near-white wash and falls back, with a highlight
// roll-off (color-grade shoulder) and a soft bloom, so eyes, mouth and line work still read at the
// peak instead of clipping to a white blob. With `into` it is a hand-off: the first shot burns
// out, the cut lands on the peak, and the next shot settles out of the wash.
//
// Where the defaults come from:
//   dur 0.4 s     the grade-bloom-flash study's wash settled over 0.4 s (its final.mjs).
//   peak 0.3      without into: a short rise and a longer settle (a guess shaped by the same wash,
//                 which starts near its peak and settles); with into, 0.5: the radial hand-off
//                 studied in transitions peaks in frames 7 to 12 of 21, the middle.
//   amount 1      2 stops in linear light at the peak, rolled off with shoulder 1: tuned on the
//                 grade-bloom-flash wash (after-overexpose-soften.jpg). 3 stops with shoulder 0.8
//                 still whited the mouth and ear out; the old ramp (1.8x sRGB gain plus glow 2)
//                 whited out the whole face.
//   bloom 0.3     glow strength 0.3 of the bright parts (threshold 0.75), radius 2% of the frame
//                 height: tuned on the same frame (0.5 at threshold 0.6 spread over the features).
//   saturation 1.4  color kept at the peak: the roll-off pulls bright colors toward white, and the
//                 contest-a recreate's bloom read milky (f909 L/C/S 131/69/45 against the
//                 reference's 146/83/62, GAPS item 4); 62/45 = 1.38, so the peak lifts saturation
//                 by 0.4 (scaled by amount). 1 gives the old milky wash.
// Reduced motion: half the stops and bloom (as impact-accent's flash).
import { CURVES, effect, hide, round, show } from "./kit.js";
import { startClips } from "./transitions.js";

const FRAME = 1 / 30;
const PEAK_STOPS = 2;
const SHOULDER = 1;
const BLOOM = 0.3;
const SATURATION = 1.4;
const HEX = /^#[0-9a-f]{6}$/i;

export const overexpose = {
  name: "overexpose",
  needsAt: true,
  nested: ["layer", "into"],
  about: "the shot burns out to a soft near-white wash and settles back (exposure with a highlight roll-off and bloom, so faces keep their features); with into, a flash hand-off whose cut lands on the peak",
  fits: "a cut into a new section, a reveal, a hit; out of one shot and into the next",
  tags: ["flash"],
  length: 0.4,
  shortest: 0.1,
  fields: {
    layer: { kind: "layer", required: true, about: "the shot that burns out (alone: it also settles back)" },
    into: { kind: "layer", about: "the next shot: hidden until the peak, then it settles out of the wash (the cut lands on the peak)" },
    amount: { kind: "number", low: 0.1, high: 1, about: "how far it burns out (default 1: 2 stops at the peak)" },
    peak: { kind: "number", low: 0, high: 1, about: "where the peak sits in dur, 0 to 1 (default 0.3; 0.5 with into; 0 starts washed out)" },
    shoulder: { kind: "number", low: 0, high: 1, about: "highlight roll-off: 0 clips hard, 1 the softest (default 1)" },
    bloom: { kind: "number", low: 0, high: 1, about: "soft glow of the bright parts at the peak (default 0.3; 0 none)" },
    color: { kind: "text", max: 7, about: "tint of the bloom, hex (default none: the shot's own colors)" },
    saturation: { kind: "number", low: 0, high: 3, about: "color at the peak: 1 lets the wash go milky, above 1 keeps colors rich (default 1.4)" },
  },
  example: { layer: "shot-a", into: "shot-b", at: 1 },
  setup: "shot-a and shot-b, two full-frame pictures",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const into = input.into ? ctx.layer(input.into, "into") : null;
    if (into && into.id === layer.id) throw new Error("overexpose: into is the shot after layer; give another layer, or leave into out.");
    if (input.color !== undefined && !HEX.test(input.color)) throw new Error("overexpose color is a hex color such as \"#FFF4E0\".");
    const strength = ctx.reduced ? 0.5 : 1;
    const amount = input.amount ?? 1;
    const stops = round(PEAK_STOPS * amount * strength, 2);
    const shoulder = input.shoulder ?? SHOULDER;
    const bloom = (input.bloom ?? BLOOM) * amount * strength;
    const saturation = round(1 + ((input.saturation ?? SATURATION) - 1) * amount * strength, 3);
    const share = input.peak ?? (into ? 0.5 : 0.3);
    const top = round(ctx.start + ctx.duration * share);
    const rise = top - ctx.start;
    const fall = ctx.end - top;
    // mode spill: the bloom only lightens what is darker than it, so a brow or an eye line inside
    // the washed face keeps its tone (an added bloom at 0.3 filled them in: skeptic-bloom0 vs bloom015 frames).
    const glow = { radius: Math.max(4, Math.round(ctx.frame.height * 0.02)), passes: 2, threshold: 0.75, softness: 0.4, mode: "spill",
      ...(input.color ? { color: input.color, colorMix: 0.6 } : {}) };
    const up = (target, role) => {
      if (rise < 0.001) return;
      ctx.animate(target.id, "up", effect({ name: "Overexpose up", effect: "color-grade", start: ctx.start, duration: rise, easing: CURVES.accelerate, from: { stops: 0, shoulder, saturation: 1 }, to: { stops, shoulder, saturation }, keepStill: "off" }), role);
      if (bloom > 0) ctx.animate(target.id, "bloom-up", effect({ name: "Overexpose bloom", effect: "glow", start: ctx.start, duration: rise, easing: CURVES.accelerate, from: { strength: 0 }, to: { strength: round(bloom, 3), ...glow }, keepStill: "off" }), role);
    };
    const down = (target, role) => {
      if (fall < 0.001) return;
      ctx.animate(target.id, "down", effect({ name: "Overexpose settles", effect: "color-grade", start: top, duration: fall, easing: CURVES.settle, from: { stops, shoulder, saturation }, to: { stops: 0, shoulder, saturation: 1 }, keepStill: "off" }), role);
      if (bloom > 0) ctx.animate(target.id, "bloom-down", effect({ name: "Overexpose bloom fades", effect: "glow", start: top, duration: fall, easing: CURVES.settle, from: { strength: round(bloom, 3) }, to: { strength: 0, ...glow }, keepStill: "off" }), role);
    };
    up(layer, "layer");
    if (into) {
      // The cut on the peak: the first shot goes, the next appears (a clip starts playing then).
      ctx.animate(layer.id, "hide", hide(top + FRAME / 2), "layer");
      startClips(ctx, into.id, top);
      ctx.animate(into.id, "show", show(top), "into");
      down(into, "into");
    } else down(layer, "layer");
    ctx.note(`overexpose ${layer.id}${into ? ` into ${into.id}` : ""}: ${stops} stops at ${top} s, shoulder ${shoulder}`);
    return { end: round(ctx.end), tags: overexpose.tags };
  },
};
