// Set pieces from an app trailer reference: rgb-split-hit, parallax-stack, logo-match-move,
// speed-lines-phone, swipe-cards and tile-ring.
import { createLayer } from "../../model.js";
import { textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { CURVES, boxOf, centerOf, contrast, coversFrameAt, effect, hide, mix, motion, round, scaledAbout } from "./kit.js";
import { RAMPS, rampTimes } from "./roll.js";

const rad = (degrees) => (degrees * Math.PI) / 180;
// The values a long push or drift sets on your layer, and the least time left for one: it waits
// for the layer's own moves of these values to finish (ctx.settledAt), or is left out.
const TRANSFORM_KEYS = ["x", "y", "scaleX", "scaleY"];
const MIN_PUSH = 0.8;

// ---- rgb-split-hit ------------------------------------------------------------------------
// A hit on a beat: the colors split apart and snap back while the layer kicks a few percent
// larger and settles. Hits at least this far apart, so the flashing gate (3 a second) holds.
const HIT_GAP = 0.36;

export const rgbSplitHit = {
  name: "rgb-split-hit",
  needsAt: true,
  about: "on a beat the layer's colors split into red, green and blue and snap back while it kicks a few percent larger with a short zoom blur and settles",
  fits: "a beat drop, a word that lands, a logo that hits; a cut that needs a jolt without a flash",
  tags: ["rgb-split", "beat-kick", "glitch-hit"],
  length: 0.4,
  lasts: "not needed: it ends just after the last hit",
  fields: {
    layer: { kind: "layer", required: true, about: "the layer that is hit (a shot, a word, a logo or a group)" },
    beats: { kind: "times", most: 32, about: "more hits: scene seconds, each at least 0.36 s after the one before (at is the first)" },
    strength: { kind: "number", low: 0.2, high: 1, about: "how far the colors split and the layer kicks (default 0.5)" },
    kick: { kind: "number", low: 0, high: 1, about: "how far the layer kicks larger (default strength); 0 leaves its scale alone (no beat-kick)" },
  },
  example: { layer: "shot-a", at: 1, beats: [2.2] },
  setup: "shot-a, any layer",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const hits = [ctx.start, ...(input.beats ?? [])].sort((a, b) => a - b);
    for (let index = 1; index < hits.length; index += 1)
      if (hits[index] - hits[index - 1] < HIT_GAP - 1e-6) throw new Error(`rgb-split-hit: hits at ${hits[index - 1]} and ${hits[index]} s are closer than ${HIT_GAP} s (more than 3 a second flashes).`);
    const strength = input.strength ?? 0.5;
    const kicks = (input.kick ?? strength) > 0;
    const kick = 1 + 0.06 * (input.kick ?? strength);
    hits.forEach((time, index) => {
      const name = hits.length > 1 ? `-${index + 1}` : "";
      // The colors split along a seeded side each time, so a run of hits is not one stamp.
      const direction = ctx.rng.pick([0, 180, 20, 200]);
      ctx.animate(layer.id, `split${name}`, effect({ name: "RGB split", effect: "rgb-shift", start: time, duration: 0.28, easing: CURVES.settle,
        from: { amount: round(0.75 * strength) }, to: { amount: 0, direction }, keepStill: "off" }), "layer");
      if (ctx.reduced) return;
      // The kick sets only the scale (about the layer's center), so the layer's own moves of x and y go on.
      if (kicks) {
        const state = ctx.stateAt(layer.id, time);
        ctx.animate(layer.id, `kick${name}`, motion({ name: "Kick", start: time, duration: 0.08, easing: [0.2, 0.7, 0.4, 1],
          from: { scaleX: state.scaleX, scaleY: state.scaleY }, to: { scaleX: round(state.scaleX * kick), scaleY: round(state.scaleY * kick) } }), "layer");
        ctx.animate(layer.id, `settle${name}`, motion({ name: "Settle", start: time + 0.08, duration: 0.34, easing: CURVES.settle,
          from: { scaleX: round(state.scaleX * kick), scaleY: round(state.scaleY * kick) }, to: { scaleX: state.scaleX, scaleY: state.scaleY } }), "layer");
      }
      ctx.animate(layer.id, `blur${name}`, effect({ name: "Zoom blur", effect: "zoom-blur", start: time, duration: 0.3, easing: CURVES.settle,
        from: { amount: round(0.18 * strength) }, to: { amount: 0, centerX: 0.5, centerY: 0.5 } }), "layer");
    });
    // A beat-kick only when the layer kicks (in reduced motion it does not).
    return { end: round(hits.at(-1) + 0.42), tags: kicks && !ctx.reduced ? rgbSplitHit.tags : rgbSplitHit.tags.filter((tag) => tag !== "beat-kick") };
  },
};

// ---- parallax-stack -------------------------------------------------------------------------
const SIDES = ["left", "right", "up", "down"];

export const parallaxStack = {
  name: "parallax-stack",
  about: "two to four layers drift the same way at different speeds, the near ones faster and a little closer, while the far ones fall softly out of focus, so a flat frame gets depth",
  fits: "a still picture, a cut-out or UI cards over a backdrop that should still breathe",
  tags: ["parallax", "depth-blur", "drift"],
  length: 3,
  shortest: 1.5,
  fields: {
    layers: { kind: "layers", required: true, min: 2, most: 4, about: "the layers from the farthest to the nearest" },
    direction: { kind: "choice", values: SIDES, about: "where the layers drift (default a seeded left or right)" },
    amount: { kind: "number", low: 0.5, high: 3, about: "how far they drift, 1 = the near layer moves 7% of the frame (default 1)" },
  },
  example: { layers: ["shot-a", "phone"], at: 0.5, dur: 3 },
  setup: "shot-a (a full-frame picture) and phone (a smaller layer over it)",
  build(ctx, input) {
    const layers = input.layers.map((layerId) => ctx.layer(layerId, "layers"));
    if (new Set(input.layers).size !== input.layers.length) throw new Error("parallax-stack: each layer once.");
    const direction = input.direction ?? ctx.rng.pick(["left", "right"]);
    const across = direction === "left" || direction === "right";
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    const span = across ? ctx.frame.width : ctx.frame.height;
    const amount = input.amount ?? 1;
    layers.forEach((layer, index) => {
      // depth 1 is the nearest layer, smaller numbers are farther away.
      const depth = (index + 1) / layers.length;
      const near = index === layers.length - 1;
      const role = `layer${index + 1}`;
      // Far layers fall out of focus in the first moment, like a lens racking to the near one.
      const softness = near ? 0 : Math.round(9 * ctx.scale * (1 - depth) + 2 * ctx.scale);
      if (softness) ctx.animate(layer.id, "focus", motion({ name: "Rack focus", start: ctx.start, duration: Math.min(0.8, ctx.duration * 0.4), easing: CURVES.settle,
        from: { blur: layer.blur ?? 0 }, to: { blur: softness } }), role);
      if (ctx.reduced) return;
      const travel = Math.round(span * 0.07 * amount * depth);
      const grow = round(1 + 0.05 * amount * depth * depth);
      const box = boxOf(layer);
      const covers = coversFrameAt(ctx, layer.id, ctx.start);
      // A plate that fills the frame mirrors its picture past its edges, so the drift never shows a gap.
      if (covers) ctx.animate(layer.id, "edges", effect({ name: "Edge fill", effect: "edge-fill", start: ctx.start, duration: ctx.duration, easing: CURVES.drift, to: { mode: "mirror", extend: 0.25 }, keepStill: "end" }), role);
      // It drifts from where the layer is once its own moves are done (from the start when it has none).
      const driftAt = ctx.settledAt(layer.id, TRANSFORM_KEYS, ctx.start, ctx.end);
      if (ctx.end - driftAt < MIN_PUSH) { ctx.note(`no drift: ${layer.id} moves by its own animations until ${driftAt} s`); return; }
      const state = ctx.stateAt(layer.id, driftAt);
      const key = across ? "x" : "y";
      const now = { x: state.x, y: state.y, width: state.width, height: state.height };
      const grown = scaledAbout(now, centerOf(now), grow);
      const moved = { x: grown.x, y: grown.y };
      moved[key] = round(moved[key] + sign * travel);
      ctx.animate(layer.id, "drift", motion({ name: "Drift", start: driftAt, duration: ctx.end - driftAt, easing: CURVES.drift,
        from: { x: state.x, y: state.y, scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1 }, to: { x: moved.x, y: moved.y, scaleX: grow * (state.scaleX ?? 1), scaleY: grow * (state.scaleY ?? 1) } }), role);
    });
    return { end: ctx.end };
  },
};

// ---- logo-match-move ----------------------------------------------------------------------
export const logoMatchMove = {
  name: "logo-match-move",
  about: "the logo arrives big in the middle over a blurred, dimmed page, then flies into its place in that page while the page comes into focus, and lands with a small settle",
  fits: "tying a brand mark to the product: a site, an app screen, a sign where the logo lives",
  tags: ["logo-match-move", "screen-zoom"],
  length: 1.8,
  shortest: 1.2,
  fields: {
    into: { kind: "layer", required: true, about: "the screenshot or layer the logo lands in" },
    spot: { kind: "box", about: "[x, y, width, height] in % of into's box: where the logo sits in it (default: where the logo layer already is)" },
    logo: { kind: "layer", about: "your logo layer (default: a new one from picture or the brand's logo)" },
    picture: { kind: "picture", about: "an uploaded picture of the logo (default the brand's logo)" },
  },
  example: { into: "shot-b", spot: [44, 40, 12, 22], at: 0.3 },
  setup: "shot-b, a picture of a page or sign, and set_brand with a logo picture (or give picture)",
  build(ctx, input) {
    const into = ctx.layer(input.into, "into");
    const given = input.logo ? ctx.layer(input.logo, "logo") : null;
    if (given && given.id === into.id) throw new Error("logo-match-move: logo and into must be two layers.");
    if (!given && !input.spot) throw new Error("logo-match-move needs spot (where the logo sits in into) when it makes the logo itself.");
    const box = boxOf(into);
    const spot = input.spot
      ? { x: box.x + (box.width * input.spot[0]) / 100, y: box.y + (box.height * input.spot[1]) / 100, width: (box.width * input.spot[2]) / 100, height: (box.height * input.spot[3]) / 100 }
      : boxOf(given);
    let logo = given;
    if (!logo) {
      const picture = input.picture ? ctx.picture(input.picture) : ctx.logo?.media;
      if (!picture) throw new Error("logo-match-move needs logo (a layer), picture (an uploaded picture), or a brand with a logo picture.");
      const fit = Math.min(spot.width / picture.width, spot.height / picture.height);
      const width = Math.round(picture.width * fit);
      const height = Math.round(picture.height * fit);
      logo = ctx.add("logo", createLayer("image", { name: "Logo", src: picture.src, x: Math.round(spot.x + (spot.width - width) / 2), y: Math.round(spot.y + (spot.height - height) / 2), width, height, role: "logo" }), { above: into.id });
    }
    // Where the logo lands: its own box scaled to fit the spot.
    const fit = Math.min(spot.width / logo.width, spot.height / logo.height);
    const landed = centerOf(spot);
    const rest = centerOf(boxOf(logo));
    // How big it starts: about 40% of the frame's short side and bigger than where it lands,
    // in the middle of the safe area and never past its edges (phone apps cover the rest).
    const safe = safeArea(ctx.frame);
    const roomy = 0.85 * Math.min(safe.width / logo.width, safe.height / logo.height);
    const start = Math.min(roomy, Math.max(1.3, (Math.min(ctx.frame.width, ctx.frame.height) * 0.42) / Math.max(logo.width, logo.height)));
    const frameCenter = centerOf(safe);
    const at = (center, scale) => ({ x: round(logo.x + center.x - rest.x, 1), y: round(logo.y + center.y - rest.y, 1), scaleX: round(scale), scaleY: round(scale) });
    const appear = 0.4;
    const hold = Math.max(0.15, ctx.duration - 1.35);
    const flight = 0.65;
    const flyAt = ctx.start + appear + hold;
    const landAt = flyAt + flight;
    if (ctx.reduced) {
      ctx.animate(logo, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.5, easing: CURVES.fade, from: { opacity: 0, ...at(landed, fit) }, to: { opacity: 1, ...at(landed, fit) } }), "logo");
      ctx.animate(into.id, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.5, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "into");
      return { end: ctx.start + 0.6 };
    }
    // 1. Big in the middle, sharpening out of a blur.
    ctx.animate(logo, "in", motion({ name: "Arrive", kind: "in", start: ctx.start, duration: appear, easing: CURVES.settle,
      from: { opacity: 0, blur: Math.round(14 * ctx.scale), ...at(frameCenter, start * 0.86) }, to: { opacity: 1, blur: 0, ...at(frameCenter, start) } }), "logo");
    // 2. The flight: it shrinks into its spot, a little past its size, smeared along the way.
    const overshoot = 1.07;
    ctx.animate(logo, "fly", motion({ name: "Fly to place", start: flyAt, duration: flight, easing: CURVES.fly,
      from: at(frameCenter, start), to: at(landed, fit * overshoot) }), "logo");
    const angle = round((Math.atan2(landed.y - frameCenter.y, landed.x - frameCenter.x) * 180) / Math.PI);
    const smear = Math.round(Math.hypot(landed.x - frameCenter.x, landed.y - frameCenter.y) * 0.18 / Math.max(0.2, fit));
    ctx.animate(logo, "smear", effect({ name: "Smear", effect: "directional-blur", start: flyAt, duration: flight / 2, easing: [0.5, 0, 1, 1], from: { length: 0 }, to: { length: smear, angle } }), "logo");
    ctx.animate(logo, "unsmear", effect({ name: "Unsmear", effect: "directional-blur", start: flyAt + flight / 2, duration: flight / 2, easing: [0, 0, 0.5, 1], to: { length: 0, angle } }), "logo");
    // 3. It lands and settles to its size.
    ctx.animate(logo, "settle", motion({ name: "Settle", start: landAt, duration: 0.4, easing: CURVES.settle,
      from: { scaleX: round(fit * overshoot), scaleY: round(fit * overshoot) }, to: { scaleX: round(fit), scaleY: round(fit) } }), "logo");
    // The page waits dim and soft behind the big logo, then comes forward into focus as the logo lands.
    const page = scaledAbout(box, landed, 1.12);
    ctx.animate(into.id, "in", motion({ name: "Dim", kind: "in", start: ctx.start, duration: appear, easing: CURVES.fade,
      from: { opacity: 0 }, to: { opacity: 0.35 } }), "into");
    ctx.animate(into.id, "focus", motion({ name: "Into focus", start: flyAt, duration: flight + 0.35, easing: CURVES.settle,
      from: { opacity: 0.35, blur: Math.round(18 * ctx.scale), x: page.x, y: page.y, scaleX: 1.12 * (into.scaleX ?? 1), scaleY: 1.12 * (into.scaleY ?? 1) },
      to: { opacity: 1, blur: 0, x: into.x, y: into.y, scaleX: into.scaleX ?? 1, scaleY: into.scaleY ?? 1 } }), "into");
    ctx.animate(into.id, "hold", motion({ name: "Soft", start: ctx.start, duration: appear, easing: CURVES.fade,
      from: { blur: Math.round(18 * ctx.scale), x: page.x, y: page.y, scaleX: 1.12 * (into.scaleX ?? 1), scaleY: 1.12 * (into.scaleY ?? 1) },
      to: { blur: Math.round(18 * ctx.scale), x: page.x, y: page.y, scaleX: 1.12 * (into.scaleX ?? 1), scaleY: 1.12 * (into.scaleY ?? 1) } }), "into");
    return { end: round(Math.max(ctx.end, landAt + 0.4)) };
  },
};

// ---- speed-lines-phone ------------------------------------------------------------------
const DENSITY = { low: 90, medium: 160, high: 260 };

export const speedLinesPhone = {
  name: "speed-lines-phone",
  about: "a device or layer holds the center while light streaks rush out from behind it toward the edges, like hyperspace, and it eases a little closer",
  fits: "showing an app on a phone with energy; a product moment that needs speed without a cut",
  tags: ["speed-lines", "particles", "slow-push"],
  length: 3,
  shortest: 1,
  fields: {
    layer: { kind: "layer", required: true, about: "the device or layer in the middle; the streaks come from its center" },
    density: { kind: "choice", values: Object.keys(DENSITY), about: "how many streaks: low, medium or high (default medium)" },
  },
  example: { layer: "phone", at: 0.2, dur: 3 },
  setup: "phone, a picture or video of a phone screen in the middle of the frame",
  build(ctx, input) {
    const device = ctx.layer(input.layer, "layer");
    const center = centerOf(boxOf(device));
    const end = ctx.end;
    if (!ctx.reduced) {
      // Two depths of streaks: far ones fat, dim and out of focus, near ones thin and bright.
      const count = DENSITY[input.density ?? "medium"];
      const origin = { originX: round(center.x / ctx.frame.width), originY: round(center.y / ctx.frame.height) };
      const depths = [
        { part: "far-lines", name: "Far streaks", blur: Math.round(11 * ctx.scale), count: Math.round(count * 0.55), size: round(8 * ctx.scale, 1), speed: Math.round(1500 * ctx.scale), opacity: 0.5, color2: ctx.style.colors.accent, trail: 0.45 },
        { part: "near-lines", name: "Near streaks", blur: 0, count: Math.round(count * 0.45), size: round(Math.max(1.5, 2.2 * ctx.scale), 1), speed: Math.round(3000 * ctx.scale), opacity: 0.9, color2: ctx.style.colors.accent2, trail: 0.5 },
      ];
      depths.forEach((depth, index) => {
        const lines = ctx.add(depth.part, createLayer("rectangle", {
          name: depth.name, x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fillEnabled: false, strokeWidth: 0, blendMode: "add", blur: depth.blur, role: "decor", allowOverlap: true,
        }), { below: device.id });
        const streaks = {
          count: depth.count, size: depth.size, speed: depth.speed, direction: 0, spread: 360, gravity: 0, wind: 0, turbulence: 0, lifetime: 0.7,
          color: "#FFFFFF", color2: depth.color2, opacity: depth.opacity, softness: 0.5, glow: 0.1, flicker: 0, trail: depth.trail, emitter: "point", ...origin,
          prewarm: true, seed: ctx.rng.pick([3, 7, 11, 19, 23]) + index * 101, loop: 0,
        };
        ctx.animate(lines, "streaks", effect({ name: "Streaks", effect: "sparks", start: ctx.start, duration: ctx.duration, easing: CURVES.fade, to: streaks, keepStill: "off" }));
        ctx.animate(lines, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.4 + index * 0.15, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
        ctx.animate(lines, "out", motion({ name: "Fade out", kind: "out", start: end - 0.3, duration: 0.3, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
        ctx.animate(lines, "hide", hide(end));
      });
      // The device eases a little closer the whole time, once its own moves (a rise in) are done.
      const pushAt = ctx.settledAt(device.id, TRANSFORM_KEYS, ctx.start, end);
      if (end - pushAt >= MIN_PUSH) {
        const state = ctx.stateAt(device.id, pushAt);
        const box = { x: state.x, y: state.y, width: state.width, height: state.height };
        const closer = scaledAbout(box, centerOf(box), 1.05);
        ctx.animate(device.id, "push", motion({ name: "Push in", start: pushAt, duration: end - pushAt, easing: CURVES.drift,
          from: { x: state.x, y: state.y, scaleX: state.scaleX, scaleY: state.scaleY }, to: { x: closer.x, y: closer.y, scaleX: round(state.scaleX * 1.05), scaleY: round(state.scaleY * 1.05) } }), "layer");
      } else ctx.note(`no push in: ${device.id} moves by its own animations until ${pushAt} s`);
    } else ctx.note("reduced motion: no streaks");
    return { end };
  },
};

// ---- swipe-cards ----------------------------------------------------------------------------
// The cards sit in a stack. The top card is dragged a little to the side and tilts (its turn
// follows how far it has moved), a fill of the brand color rises over it with YES or NO on it,
// then it flies off that way while the card under it settles up to the top. One object the
// whole time: the color and the answer ride on the card.
const CARD_DRAG = 0.35;
const CARD_EXIT = 0.4;
const CARD_SETTLE = 0.4;
// The answer stays readable on the card at least 20 frames (plus its arrival) before it flies.
const LABEL_HOLD = 0.8;
// A fast card (ramp) still shows its answer this long, so the reading-time gate passes (0.67 s).
const ANSWER_HOLD_FAST = 0.75;
// Each card further down the stack is a little smaller and lower, so its edge shows.
const STACK_SCALE = 0.05;
const STACK_DROP = 0.028;

export const swipeCards = {
  name: "swipe-cards",
  about: "a stack of cards: the top one is dragged aside and tilts while a fill of the brand color rises over it with a big YES or NO, then it flies off right for yes or left for no as the next card settles up",
  fits: "choices, matches, rating things, a quick run through options or screens",
  tags: ["swipe-cards"],
  length: 4,
  fields: {
    cards: { kind: "layers", min: 2, most: 6, about: "your card layers, top card first (all at the same place)" },
    pictures: { kind: "pictures", min: 2, most: 6, about: "uploaded pictures to make the cards from, top card first" },
    answers: { kind: "choices", values: ["yes", "no"], most: 6, about: "yes or no for each card that leaves (default seeded; the last card stays unless it has one)" },
    labels: { kind: "texts", min: 2, most: 2, max: 8, about: "the words for yes and no (default [\"YES\", \"NO\"])" },
    every: { kind: "number", low: 1.6, high: 4, about: "seconds from one card to the next (default 2); with ramp, the first gap" },
    ramp: { kind: "choice", values: [...RAMPS], about: "the gaps shrink from every to last: expo or linear (default none: every gap is every)" },
    last: { kind: "number", low: 1, high: 4, about: "with ramp, the last gap in seconds (default 1); a fast card's drag and fling shrink to fit, its answer holds 0.75 s" },
  },
  oneOf: [["cards", "pictures"]],
  example: { pictures: ["screen-a", "screen-b", "screen-c"], at: 0.3, answers: ["no", "yes"] },
  setup: "three uploaded pictures named screen-a, screen-b and screen-c",
  build(ctx, input) {
    let cards;
    if (input.cards) cards = input.cards.map((layerId) => ctx.layer(layerId, "cards"));
    else {
      const pictures = input.pictures.map((ref) => ctx.picture(ref));
      const height = Math.round(ctx.frame.height * (ctx.portrait ? 0.5 : 0.7));
      // Made in reverse, so the first card is drawn on top.
      cards = pictures.map((picture, index) => {
        const width = Math.round((height * picture.width) / picture.height);
        return { picture, width, index };
      }).reverse().map(({ picture, width, index }) => ctx.add(`card${index + 1}`, createLayer("image", {
        name: `Card ${index + 1}`, src: picture.src, x: Math.round((ctx.frame.width - width) / 2), y: Math.round((ctx.frame.height - height) / 2), width, height,
        radius: Math.round(Math.min(width, height) * 0.06),
      }))).reverse();
    }
    if (new Set(cards.map((card) => card.id)).size !== cards.length) throw new Error("swipe-cards: each card once.");
    // Your own cards are put in order: the first one on top.
    if (input.cards) for (let index = cards.length - 2; index >= 0; index -= 1) if (ctx.order(cards[index].id) < ctx.order(cards[index + 1].id)) ctx.raise(cards[index].id, cards[index + 1].id);
    const answers = input.answers ?? cards.slice(0, -1).map((_, index) => ((index + ctx.rng.pick([0, 1])) % 2 ? "yes" : "no"));
    if (answers.length > cards.length) throw new Error(`swipe-cards: ${answers.length} answers for ${cards.length} cards.`);
    const [yes, no] = input.labels ?? ["YES", "NO"];
    const every = input.every ?? 2;
    // The gap before each card flies: the same every time, or shrinking along the ramp.
    const leaving = cards.filter((_, index) => answers[index]).length;
    const gaps = rampTimes(leaving, every, input.ramp && input.ramp !== "none" ? input.last ?? 1 : every, input.ramp ?? "none");
    const accent = ctx.style.colors.accent;
    // The answer is a deep shade of the brand color (pink on pink), or the background color
    // when that shade would not read (the contrast gate needs 3:1 for large type).
    const deep = mix(accent, "#000000", 0.62);
    const ink = contrast(deep, accent) >= 3.2 ? deep : ctx.style.colors.bg;
    // How far the card is dragged before it flies, and how much it turns per pixel moved.
    const drag = ctx.frame.width * 0.1;
    const fling = ctx.frame.width * 0.95;
    const turn = 20 / ctx.frame.width;

    // When each card reaches the top, is dragged, shows its answer and flies.
    const steps = [];
    let ready = ctx.start + 0.5;
    for (let index = 0; index < cards.length && answers[index]; index += 1) {
      // A gap shorter than the full swipe (2 s) shrinks its drag, fling and settle alike; the
      // answer shrinks only down to ANSWER_HOLD_FAST, so the word stays readable.
      const holdSeconds = Math.max(ANSWER_HOLD_FAST, round(LABEL_HOLD * Math.min(1, gaps[index] / (0.45 + CARD_DRAG + LABEL_HOLD + CARD_SETTLE))));
      const pace = Math.min(1, Math.max(0, gaps[index] - holdSeconds) / (0.45 + CARD_DRAG + CARD_SETTLE));
      const [dragSeconds, exitSeconds, settleSeconds] = [CARD_DRAG, CARD_EXIT, CARD_SETTLE].map((value) => round(value * pace));
      const dragAt = ready + Math.max(0.45 * pace, gaps[index] - dragSeconds - holdSeconds - settleSeconds);
      const exitAt = dragAt + dragSeconds + holdSeconds;
      steps.push({ ready, dragAt, exitAt, dragSeconds, exitSeconds, settleSeconds, pace });
      ready = exitAt + settleSeconds;
    }
    // A card's place in the stack: `depth` cards above it (only three show).
    const stacked = (card, depth) => {
      const shown = Math.min(depth, 2);
      const scale = 1 - STACK_SCALE * shown;
      return { x: card.x, y: round(card.y + ctx.frame.height * STACK_DROP * shown), scaleX: round(scale * (card.scaleX ?? 1)), scaleY: round(scale * (card.scaleY ?? 1)), rotation: card.rotation ?? 0 };
    };
    let end = ready;
    cards.forEach((card, index) => {
      const role = input.cards ? `card${index + 1}` : null;
      const target = role ? card.id : card;
      // In: the top card rises in, the ones under it fade in at their place in the stack;
      // cards deeper than three fade in when they reach the third place.
      const firstShown = index <= 2 ? ctx.start : steps[index - 3]?.exitAt ?? null;
      if (firstShown === null) return;
      const depthThen = index <= 2 ? index : 2;
      if (ctx.reduced || index > 0) ctx.animate(target, "in", motion({ name: "Fade in", kind: "in", start: firstShown, duration: 0.4, easing: CURVES.fade,
        from: { opacity: 0, ...stacked(card, depthThen) }, to: { opacity: 1, ...stacked(card, depthThen) } }), role);
      else ctx.animate(target, "in", motion({ name: "Rise in", kind: "in", start: ctx.start, duration: 0.5, easing: CURVES.settle,
        from: { opacity: 0, ...stacked(card, 0), y: card.y + Math.round(60 * ctx.scale) }, to: { opacity: 1, ...stacked(card, 0) } }), role);
      // It settles up one place each time a card above it flies.
      steps.forEach((step, above) => {
        if (above >= index || index - above > 2) return;
        ctx.animate(target, `up${above + 1}`, motion({ name: "Settle up", start: step.exitAt, duration: step.settleSeconds, easing: CURVES.settle,
          from: stacked(card, index - above), to: stacked(card, index - above - 1) }), role);
      });
      const step = steps[index];
      if (!step) return;
      const away = answers[index] === "yes" ? 1 : -1;
      const top = stacked(card, 0);
      const dragged = { x: round(card.x + away * drag), y: card.y, rotation: round((card.rotation ?? 0) + away * drag * turn, 1) };
      const flown = { x: round(card.x + away * fling), y: round(card.y + 50 * ctx.scale), rotation: round((card.rotation ?? 0) + away * fling * turn, 1) };
      // The color and the answer: the card's own size and place, so they turn with it.
      const box = { x: card.x, y: card.y, width: card.width, height: card.height };
      const clear = `${accent}00`;
      const rise = (edge) => ({ type: "linear", angle: 90, stops: [{ offset: 0, color: clear }, { offset: edge, color: clear }, { offset: edge, color: `${accent}EB` }, { offset: 1, color: `${accent}EB` }] });
      const fill = ctx.add(`fill${index + 1}`, createLayer("rectangle", { name: `Answer color ${index + 1}`, ...box, radius: card.radius ?? 0, fill: rise(0), role: "decor", allowOverlap: true }));
      const word = away > 0 ? yes : no;
      const label = textLayer(ctx, { part: `answer${index + 1}`, text: word, role: "headline", step: "display", size: Math.round(card.width * 0.34), weight: ctx.brandFonts ? undefined : 700, box, align: "center", valign: "middle", maxLines: 1, name: word });
      // Centered on the card, so it turns about the same point as the card.
      const answer = ctx.add(`answer${index + 1}`, { ...label, x: Math.round(box.x + (box.width - label.width) / 2), y: Math.round(box.y + (box.height - label.height) / 2), fill: ink });
      const exit = { start: step.exitAt, duration: step.exitSeconds, easing: [0.45, 0, 0.85, 0.5] };
      if (ctx.reduced) {
        ctx.animate(fill, "in", motion({ name: "Fade in", kind: "in", start: step.dragAt, duration: round(0.3 * step.pace), easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
        ctx.animate(answer, "in", motion({ name: "Fade in", kind: "in", start: step.dragAt, duration: round(0.3 * step.pace), easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
        for (const [layer, layerRole] of [[target, role], [fill, null], [answer, null]])
          ctx.animate(layer, "out", motion({ name: "Fade out", kind: "out", start: step.exitAt, duration: step.exitSeconds, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), layerRole);
      } else {
        // The drag and the fling move the card, its color and its answer the same way.
        for (const [layer, layerRole, base] of [[target, role, top], [fill, null, fill], [answer, null, answer]]) {
          const at = (where) => ({ x: round(base.x + where.x - card.x), y: round(base.y + where.y - card.y), rotation: where.rotation });
          ctx.animate(layer, "drag", motion({ name: "Drag", start: step.dragAt, duration: step.dragSeconds, easing: CURVES.settle,
            from: { x: base.x, y: base.y, rotation: card.rotation ?? 0 }, to: at(dragged) }), layerRole);
          ctx.animate(layer, "fling", motion({ name: away > 0 ? "Swipe right" : "Swipe left", start: exit.start, duration: exit.duration, easing: exit.easing,
            from: at(dragged), to: at(flown) }), layerRole);
        }
        ctx.animate(fill, "rise", motion({ name: "Color rises", start: step.dragAt, duration: step.dragSeconds + 0.1 * step.pace, easing: CURVES.settle, from: { fill: rise(1) }, to: { fill: rise(0) } }));
        ctx.animate(answer, "in", motion({ name: "Stamp", kind: "in", start: step.dragAt + 0.1 * step.pace, duration: 0.3 * step.pace, easing: CURVES.settle,
          from: { opacity: 0, scaleX: 1.25, scaleY: 1.25 }, to: { opacity: 1, scaleX: 1, scaleY: 1 } }));
        ctx.animate(fill, "show", motion({ name: "Show", kind: "in", start: step.dragAt, duration: 0.05, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      }
      for (const [layer, layerRole] of [[target, role], [fill, null], [answer, null]]) ctx.animate(layer, "hide", hide(step.exitAt + step.exitSeconds), layerRole);
      end = Math.max(end, step.exitAt + step.exitSeconds);
    });
    return { end: round(Math.max(ctx.end, end + 0.2)) };
  },
};

// ---- tile-ring ------------------------------------------------------------------------------
// The shot shrinks to the middle and breaks into tiles (of itself and of other pictures) that fly
// out into a ring seen a little from above: tiles at the back are smaller and soft, at the front
// bigger and sharp. The ring turns, then breaks outward into a field of tiles across the frame
// (or the tiles scatter and fade).
export const tileRing = {
  name: "tile-ring",
  about: "one shot shrinks to the middle and breaks into a ring of tiles (of itself and of your other pictures) that fills most of the frame, seen a little from above, soft at the back, over a dim soft copy of the shot; the ring turns, then breaks outward into a field of tiles that covers the whole frame",
  fits: "showing that there is a lot of footage or many moments; a transition into a montage",
  tags: ["tile-ring", "depth-blur"],
  length: 3.2,
  shortest: 2.2,
  fields: {
    layer: { kind: "layer", required: true, about: "the picture or video layer that breaks into tiles" },
    pictures: { kind: "pictures", min: 1, most: 16, about: "more uploaded pictures or clips for the tiles, used in turn after the layer's own (default only the layer's)" },
    count: { kind: "number", low: 6, high: 24, whole: true, about: "how many tiles (default 18, overlapping into a dense ring)" },
    spin: { kind: "number", low: -90, high: 90, about: "degrees the ring turns while it is up (default 30)" },
    ending: { kind: "choice", values: ["field", "fade"], about: "field: the ring breaks into tiles across the frame that stay to the end (default); fade: they scatter and fade" },
  },
  example: { layer: "shot-a", pictures: ["screen-a", "screen-b"], at: 0.5 },
  setup: "shot-a, a picture or video layer, and uploaded pictures named screen-a and screen-b",
  build(ctx, input) {
    const source = ctx.layer(input.layer, "layer");
    if (source.type !== "image" && source.type !== "video") throw new Error("tile-ring needs a picture or video layer.");
    const count = input.count ?? 18;
    const spin = input.spin ?? 30;
    const ending = input.ending ?? "field";
    // The ring is an oval (seen from a little above) that reaches most of the way to the frame's
    // edges. Its tiles are as wide as their share of the oval's length and a third more, so they
    // overlap into a dense donut: fewer tiles are bigger (at least 15% of a wide frame, 30% of a tall one).
    const across = ctx.frame.width * (ctx.portrait ? 0.34 : 0.36);
    const deep = ctx.frame.height * (ctx.portrait ? 0.3 : 0.34);
    const around = Math.PI * (across + deep);
    const boxWidth = Math.round(Math.min(ctx.frame.width * (ctx.portrait ? 0.42 : 0.26), Math.max(ctx.frame.width * (ctx.portrait ? 0.3 : 0.15), (around * 1.3) / count)));
    const boxHeight = Math.round(boxWidth * 0.75);
    const center = { x: ctx.frame.width / 2, y: ctx.frame.height / 2 };
    const flyBase = 0.6;
    const outBase = ending === "field" ? 0.7 : 0.5;
    const spread = 0.03;
    const breakAt = ctx.end - outBase - spread * count - (ending === "field" ? 0.6 : 0);
    // The media each tile shows: the layer's own first, then the pictures, in turn.
    const sources = [{ layer: source }, ...(input.pictures ?? []).map((ref) => ({ picture: ctx.picture(ref) }))];
    const mediaFor = (index) => {
      const pick = sources[index % sources.length];
      if (pick.picture) {
        const length = pick.picture.duration;
        // A clip tile plays from the move's start (a clip that started at 0 would have ended by
        // a ring late in a long video), each from another moment, and holds its last frame.
        const room = length - (ctx.end - ctx.start);
        const clip = length ? { mediaSourceDuration: length, volume: 0, mediaStart: round(ctx.start), mediaOffset: room > 0.05 ? round((index * 0.37) % room) : 0, mediaFreeze: "last" } : {};
        return { type: length ? "video" : "image", fields: { src: pick.picture.src, ...clip }, aspect: pick.picture.width / pick.picture.height };
      }
      const keep = ["src", "mediaStart", "mediaOffset", "mediaDuration", "mediaSourceDuration", "mediaFreeze", "mediaInterpolation"];
      const fields = Object.fromEntries(keep.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
      // Each video tile starts at another moment of the clip, so the ring is many moments, as far
      // as the file has room left after the part the layer plays (a tile never runs out of picture).
      const room = (source.mediaSourceDuration ?? 0) - (source.mediaOffset ?? 0) - (source.mediaDuration ?? 0);
      if (source.type === "video" && room > 0.05) fields.mediaOffset = round((source.mediaOffset ?? 0) + ((index * 0.37) % room));
      if (source.type === "video") fields.volume = 0;
      return { type: source.type, fields, aspect: source.width / source.height };
    };
    // A tile's look at an angle of the ring: place, size and softness from how near it is.
    const blurMost = Math.round(6 * ctx.scale);
    const stateAt = (angle, width, height, tilt) => {
      const near = Math.sin(rad(angle));
      const scale = round(1 + 0.2 * near);
      return {
        x: round(center.x + across * Math.cos(rad(angle)) - width / 2), y: round(center.y + deep * near - height / 2),
        scaleX: scale, scaleY: scale, blur: Math.round(Math.max(0, -near) * blurMost), rotation: tilt,
      };
    };
    // The shot shrinks into the middle as its tiles fly out of it.
    const sourceBox = boxOf(source);
    const small = boxWidth / sourceBox.width;
    const shrunk = scaledAbout(sourceBox, centerOf(sourceBox), small);
    const shift = { x: center.x - centerOf(sourceBox).x, y: center.y - centerOf(sourceBox).y };
    ctx.animate(source.id, "shrink", motion({ name: "Shrink", start: ctx.start, duration: 0.45, easing: CURVES.fly,
      from: { x: source.x, y: source.y, scaleX: source.scaleX ?? 1, scaleY: source.scaleY ?? 1 }, to: { x: round(shrunk.x + shift.x), y: round(shrunk.y + shift.y), scaleX: round(small), scaleY: round(small) } }), "layer");
    ctx.animate(source.id, "fade", motion({ name: "Fade", start: ctx.start + 0.35, duration: 0.25, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), "layer");
    ctx.animate(source.id, "hide", hide(ctx.start + 0.6), "layer");
    // Behind the ring, a soft dim copy of the shot fills the frame, so the tiles never float on
    // an empty background.
    const backdropMedia = mediaFor(0);
    const backdrop = ctx.add("backdrop", createLayer(backdropMedia.type, {
      ...backdropMedia.fields, ...(source.type === "video" ? { mediaOffset: source.mediaOffset ?? 0 } : {}),
      x: sourceBox.x, y: sourceBox.y, width: sourceBox.width, height: sourceBox.height, blur: Math.round(40 * ctx.scale), opacity: 0, role: "decor", allowOverlap: true,
    }), { below: source.id });
    ctx.animate(backdrop, "in", motion({ name: "Fade in", kind: "in", start: ctx.start + 0.15, duration: 0.5, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 0.4 } }));
    // When the tiles fade or scatter away at the end, the backdrop fades with them instead of
    // popping off (a field of tiles covers it to the end, so it can simply hide).
    if (ending !== "field" || ctx.reduced) ctx.animate(backdrop, "out", motion({ name: "Fade out", kind: "out", start: ctx.end - 0.4, duration: 0.4, easing: CURVES.fade, from: { opacity: 0.4 }, to: { opacity: 0 } }));
    ctx.animate(backdrop, "hide", hide(ctx.end));
    const ring = ctx.add("ring", createLayer("group", { name: "Tile ring", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height }), { above: source.id });
    // Each tile's size: the picture fits inside the tile's box, uncropped; a tall one (a phone
    // screen) gets a taller box, so it stays big enough to see.
    const shapes = Array.from({ length: count }, (_, index) => {
      const { aspect } = mediaFor(index);
      const width = Math.round(Math.min(boxWidth, (aspect < 1 ? boxWidth * 1.25 : boxHeight) * aspect));
      return { width, height: Math.round(width / aspect) };
    });
    // The field's cells: rows across the frame (fewer rows when the tiles are tall), the tiles
    // shared out among them. A tile goes to the free cell in the direction it flies out to (the
    // break reads as outward); then each row's cells get widths in proportion to their tiles'
    // shapes, so every row is covered end to end without blowing a tall tile up.
    const aspects = shapes.reduce((sum, shape) => sum + shape.width / shape.height, 0) / count;
    const rows = Math.max(2, Math.round(Math.sqrt((count * ctx.frame.height * aspects) / ctx.frame.width)));
    const cells = [];
    for (let row = 0; row < rows; row += 1) {
      const inRow = Math.floor(count / rows) + (row < count % rows ? 1 : 0);
      for (let column = 0; column < inRow; column += 1)
        cells.push({ row, x: (ctx.frame.width / inRow) * column, y: (ctx.frame.height / rows) * row, width: ctx.frame.width / inRow, height: ctx.frame.height / rows });
    }
    const field = {};
    for (let index = 0; index < count; index += 1) {
      const heading = rad((360 / count) * index - 90 + spin);
      const turn = (cell) => {
        const toward = Math.atan2(cell.y + cell.height / 2 - center.y, cell.x + cell.width / 2 - center.x);
        return Math.abs(Math.atan2(Math.sin(toward - heading), Math.cos(toward - heading)));
      };
      const best = cells.reduce((found, cell, at) => (found < 0 || turn(cell) < turn(cells[found]) ? at : found), -1);
      field[index] = cells.splice(best, 1)[0];
    }
    for (let row = 0; row < rows; row += 1) {
      const inRow = Object.keys(field).map(Number).filter((index) => field[index].row === row).sort((a, b) => field[a].x - field[b].x);
      const total = inRow.reduce((sum, index) => sum + shapes[index].width / shapes[index].height, 0);
      let x = 0;
      for (const index of inRow) {
        const width = (ctx.frame.width * shapes[index].width) / shapes[index].height / total;
        field[index] = { ...field[index], x, width };
        x += width;
      }
    }
    // Tiles at the back are added first, so the front ones are drawn over them.
    const plan = Array.from({ length: count }, (_, index) => ({ index, angle: (360 / count) * index - 90 }))
      .sort((a, b) => Math.sin(rad(a.angle)) - Math.sin(rad(b.angle)));
    for (const { index, angle } of plan) {
      const media = mediaFor(index);
      const { width, height } = shapes[index];
      const tilt = round(ctx.rng.between(-6, 6), 1);
      const first = stateAt(angle, width, height, tilt);
      const last = stateAt(angle + spin, width, height, tilt);
      const tile = ctx.add(`tile${index + 1}`, createLayer(media.type, {
        name: `Tile ${index + 1}`, ...media.fields, x: first.x, y: first.y, width, height, rotation: tilt, radius: Math.round(Math.min(width, height) * 0.06),
        role: "decor", allowOverlap: true,
      }), "top", ring);
      const begin = ctx.start + 0.2 + index * spread;
      // Each tile takes its own time, a little more or less, so the ring never moves as one machine.
      const fly = round(flyBase + ctx.rng.between(-0.1, 0.1));
      const out = round(outBase + ctx.rng.between(-0.15, 0));
      if (ctx.reduced) ctx.animate(tile, "in", motion({ name: "Fade in", kind: "in", start: begin, duration: 0.4, easing: CURVES.fade, from: { opacity: 0, ...first }, to: { opacity: 1, ...first } }));
      else ctx.animate(tile, "in", motion({ name: "Fly out", kind: "in", start: begin, duration: fly, easing: CURVES.settle,
        from: { opacity: 0, x: round(center.x - width / 2), y: round(center.y - height / 2), rotation: 0, scaleX: 0.5, scaleY: 0.5, blur: 0 }, to: { opacity: 1, ...first } }));
      // The ring turns: each tile moves along the oval, growing and sharpening as it comes forward.
      const settled = begin + fly;
      const leave = breakAt + index * spread;
      if (!ctx.reduced && leave - settled > 0.2) ctx.animate(tile, "turn", motion({ name: "Turn", start: round(settled), duration: round(leave - settled), easing: CURVES.drift, from: first, to: last }));
      const held = ctx.reduced || leave - settled <= 0.2 ? first : last;
      if (ending === "field") {
        // The ring breaks outward into a field that covers the frame: each tile flies to its own
        // cell of rows across the whole frame (the middle too), big enough to overlap its neighbors.
        const cell = field[index];
        const size = round(Math.max((cell.width * 1.12) / width, (cell.height * 1.1) / height) * ctx.rng.between(1, 1.08));
        const spot = {
          x: round(cell.x + cell.width / 2 + ctx.rng.between(-0.05, 0.05) * cell.width - width / 2), y: round(cell.y + cell.height / 2 + ctx.rng.between(-0.05, 0.05) * cell.height - height / 2),
          scaleX: size, scaleY: size, blur: 0, rotation: round(tilt * 0.4 + ctx.rng.between(-2, 2), 1),
        };
        if (ctx.reduced) ctx.animate(tile, "out", motion({ name: "Fade out", kind: "out", start: ctx.end - 0.4, duration: 0.4, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
        else {
          ctx.animate(tile, "break", motion({ name: "Break out", start: round(leave), duration: out, easing: CURVES.fly, from: held, to: spot }));
          const drift = { ...spot, x: round(spot.x + (spot.x + width / 2 - center.x) * 0.06), y: round(spot.y + (spot.y + height / 2 - center.y) * 0.06) };
          if (ctx.end - (leave + out) > 0.2) ctx.animate(tile, "drift", motion({ name: "Drift", start: round(leave + out), duration: round(ctx.end - leave - out), easing: CURVES.drift, from: spot, to: drift }));
        }
        ctx.animate(tile, "hide", hide(ctx.end));
      } else {
        if (ctx.reduced) ctx.animate(tile, "out", motion({ name: "Fade out", kind: "out", start: leave, duration: out, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
        else {
          const push = 1.4 + ctx.rng.between(0, 0.3);
          const away = { x: round(center.x + across * push * Math.cos(rad(angle + spin)) - width / 2), y: round(center.y + deep * push * Math.sin(rad(angle + spin)) - height / 2) };
          ctx.animate(tile, "out", motion({ name: "Scatter", kind: "out", start: round(leave), duration: out, easing: CURVES.leave,
            from: { opacity: 1, ...held }, to: { opacity: 0, ...held, x: away.x, y: away.y, scaleX: round(held.scaleX * 0.7), scaleY: round(held.scaleY * 0.7) } }));
        }
        ctx.animate(tile, "hide", hide(leave + out));
      }
    }
    ctx.animate(ring, "hide", hide(ctx.end));
    ctx.note(`${count} tiles from ${sources.length} picture${sources.length === 1 ? "" : "s"}; ending ${ending}`);
    return { end: ctx.end };
  },
};
