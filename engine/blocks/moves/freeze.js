// Footage set pieces: freeze-shutter and masked-type. Both work on a video
// layer and are chosen by name only (an idea that needs a frozen moment or a title inside the
// shot); compose never deals them.
//
// freeze-shutter follows Javier in Frame (Pixel, 2024) at 52.0 s: one black shutter frame,
// then the captured moment held sharp with a line of text; and 37.0 s, a white blink between
// shots. masked-type follows the type-as-window titles of launch films: the shot falls away
// around one big word that keeps playing the footage, or the word stands behind the subject.
import { createLayer } from "../../model.js";
import { resizeTextLayer } from "../../textLayout.js";
import { readSeconds, textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { CURVES, boxOf, centerOf, contrast, frameShare, hide, motion, pointIn, round, scaledAbout, show } from "./kit.js";

const TRANSFORM_KEYS = ["x", "y", "scaleX", "scaleY"];
// The shutter: a white blink fades out in 0.12 s (one or two frames above half), a black one is
// fully dark for a frame or two and gone by 0.1 s. One blink is two brightness changes, under
// the flashing gate's three flashes a second.
const BLINK = { white: { color: "#FFFFFF", peak: 0.9, length: 0.12, easing: CURVES.settle }, black: { color: "#0B0B0C", peak: 1, length: 0.1, easing: CURVES.leave } };
// The speed comes back over this long when release is "ramp" (slow at first, like a tape starting).
const RAMP = 0.5;
const RAMP_CURVE = [0.55, 0, 0.75, 0.45];
// The shot leans in this much while it is held, so the held frame never sits dead still.
const HOLD_PUSH = 0.04;
const KICK = 0.045;

function videoOf(ctx, id, field) {
  const layer = ctx.layer(id, field);
  if (layer.type !== "video") throw new Error(`${ctx.move} ${field}: ${id} is ${layer.type === "image" ? "a picture" : `a ${layer.type} layer`}; give a video layer (footage).`);
  return layer;
}

// A slow push on `layer` from `from` to `to` about `point`, starting with `kick` (a quick
// scale bump) when given. Left out when the layer moves by its own animations then.
function leanIn(ctx, layer, { from, to, point, grow, kick = 0 }) {
  const at = ctx.settledAt(layer.id, TRANSFORM_KEYS, from, to);
  if (at > from + 1e-6) { ctx.note(`no push: ${layer.id} moves by its own animations until ${at} s`); return false; }
  const state = ctx.stateAt(layer.id, from);
  const box = { x: state.x, y: state.y, width: state.width, height: state.height };
  const sx = state.scaleX ?? 1, sy = state.scaleY ?? 1;
  const place = (scale) => ({ ...scaledAbout(box, point, scale), scaleX: round(sx * scale, 4), scaleY: round(sy * scale, 4) });
  let start = from;
  if (kick) {
    const kicked = place(1 + kick);
    ctx.animate(layer.id, "kick", motion({ name: "Shutter kick", start: from, duration: 0.07, easing: [0.2, 0.7, 0.4, 1], from: { x: state.x, y: state.y, scaleX: sx, scaleY: sy }, to: kicked }), "layer");
    start = from + 0.07;
  }
  const before = kick ? place(1 + kick) : { x: state.x, y: state.y, scaleX: sx, scaleY: sy };
  ctx.animate(layer.id, "lean", motion({ name: "Lean in", start, duration: to - start, easing: CURVES.settle, from: before, to: place(1 + kick + grow) }), "layer");
  return true;
}

// ---- freeze-shutter -----------------------------------------------------------------------
export const freezeShutter = {
  name: "freeze-shutter",
  needsAt: true,
  about: "the footage stops on a beat with a one-frame shutter, holds 0.6 to 1.5 s leaning in with an optional label, then plays again",
  fits: "a moment to point at: a photo taken, a name, a punchline",
  tags: ["freeze-frame", "flash"],
  needs: ["video"],
  length: 1.5,
  lasts: "not needed: hold and release set it",
  fields: {
    layer: { kind: "layer", required: true, about: "the footage (a video layer) that freezes" },
    hold: { kind: "number", low: 0.6, high: 1.5, about: "seconds the frame is held (default 1)" },
    shutter: { kind: "choice", values: ["white", "black", "kick"], about: "white or black: a one-frame blink; kick: a quick scale bump, no blink (default white)" },
    label: { kind: "text", max: 32, about: "a short label drawn on while the frame is held (a name, a place, what the app saw)" },
    release: { kind: "choice", values: ["ramp", "cut"], about: "ramp: the speed comes back over 0.5 s; cut: it plays at once (default ramp)" },
    point: { kind: "point", about: "[x, y] in % of the layer's box the shot leans toward (default the center)" },
  },
  example: { layer: "clip", at: 1, hold: 1.2, shutter: "black", label: "crosswalk ahead" },
  setup: "clip, a full-frame video",
  build(ctx, input) {
    const layer = videoOf(ctx, input.layer, "layer");
    const hold = input.hold ?? 1;
    const shutter = input.shutter ?? "white";
    const t = ctx.start;
    const releaseAt = round(t + hold);
    const ramp = (input.release ?? "ramp") === "ramp" ? RAMP : 0;
    const end = round(releaseAt + ramp);
    if (!ctx.shownAt(layer.id, t)) throw new Error(`freeze-shutter: ${layer.id} is not playing on screen at ${t} s; start it while the clip shows.`);
    if (input.label && hold + 1e-6 < readSeconds(input.label) + 0.3) throw new Error(`freeze-shutter: "${input.label}" needs a hold of at least ${round(readSeconds(input.label) + 0.3, 2)} s to be read; raise hold or shorten the label.`);
    // 1. The clip stops on the beat's frame and starts again at release. Its own speed is what
    // it comes back to.
    const speed = ctx.stateAt(layer.id, t).speed ?? layer.mediaSpeed ?? 1;
    ctx.animate(layer.id, "stop", motion({ name: "Freeze", start: t, duration: 0.001, easing: CURVES.fade, from: { speed }, to: { speed: 0 } }), "layer");
    ctx.animate(layer.id, "go", motion({ name: ramp ? "Ramp back" : "Play again", start: releaseAt, duration: ramp || 0.001, easing: RAMP_CURVE, from: { speed: 0 }, to: { speed } }), "layer");
    const tags = ["freeze-frame"];
    // 2. The shutter: a blink over the frame, or a scale kick that the lean carries on from.
    const blink = BLINK[shutter];
    if (blink && !ctx.reduced) {
      const cover = ctx.add("shutter", createLayer("rectangle", { name: "Shutter", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: blink.color, opacity: 0, role: "decor", allowOverlap: true }), { above: layer.id });
      ctx.animate(cover, "blink", motion({ name: "Blink", start: t, duration: blink.length, easing: blink.easing, from: { opacity: blink.peak }, to: { opacity: 0 } }));
      ctx.animate(cover, "hide", hide(t + blink.length));
      tags.push("flash");
    }
    // 3. While it is held the shot leans in a little (a kick first for "kick"); it keeps the
    // closer framing after release, so nothing snaps back.
    if (!ctx.reduced) {
      const point = pointIn(boxOf(ctx.stateAt(layer.id, t)), input.point);
      const kicked = leanIn(ctx, layer, { from: t, to: end, point, grow: HOLD_PUSH, kick: shutter === "kick" ? KICK : 0 });
      if (kicked && shutter === "kick") tags.push("beat-kick");
    }
    // 4. The label: an accent bar draws on from the left, the words slide in on it after the
    // shutter, and both go just before release.
    if (input.label) {
      const safe = safeArea(ctx.frame);
      const pad = Math.round(18 * ctx.scale);
      const text = textLayer(ctx, { part: "label", text: input.label, role: "label", step: "h2", box: { x: safe.x + pad, y: safe.y, width: safe.width * (ctx.portrait ? 0.9 : 0.55), height: safe.height * 0.2 }, maxLines: 2, name: input.label });
      const dark = ctx.style.colors.bg, light = ctx.style.colors.text, accent = ctx.style.colors.accent;
      const ink = contrast(dark, accent) >= contrast(light, accent) ? dark : light;
      const barBox = { x: safe.x, y: Math.round(safe.y + safe.height - text.height - 2 * pad), width: text.width + 2 * pad, height: text.height + 2 * pad };
      const bar = ctx.add("bar", createLayer("rectangle", { name: "Label bar", ...barBox, fill: accent, radius: Math.round(6 * ctx.scale), role: "decor" }));
      const words = ctx.add("label", { ...text, x: barBox.x + pad, y: barBox.y + pad, fill: ink });
      const drawAt = round(t + 0.12);
      const goAt = round(releaseAt - 0.18);
      ctx.animate(bar, "draw", { ...motion({ name: "Draw on", kind: "in", start: drawAt, duration: 0.28, easing: CURVES.arrive, from: { width: 1 }, to: { width: barBox.width } }), anchor: "left" });
      ctx.animate(words, "in", motion({ name: "Slide in", kind: "in", start: drawAt + 0.1, duration: 0.26, easing: CURVES.arrive, from: { opacity: 0, x: words.x - Math.round(16 * ctx.scale) }, to: { opacity: 1, x: words.x } }));
      for (const part of [bar, words]) {
        ctx.animate(part, "out", motion({ name: "Fade out", kind: "out", start: goAt, duration: 0.18, easing: CURVES.leave, from: { opacity: 1 }, to: { opacity: 0 } }));
        ctx.animate(part, "hide", hide(releaseAt));
      }
    }
    return { end, tags };
  },
};

// ---- masked-type --------------------------------------------------------------------------
const OPEN = 1.8;
const TYPE_IN = 0.9;
const TYPE_OUT = 0.45;
// Behind the subject: the wash over the footage. Near-black at 0.55 keeps light type at 3:1 or
// more over any picture, white included.
const SHADE = "#0B0B0C";
const WASH = 0.55;

export const maskedType = {
  name: "masked-type",
  needsAt: true,
  about: "one big word made of the footage: the shot falls away to the background around it while the word's letters close up and keep playing the clip, then the shot comes back; with subject (a cut_out layer) the word stands behind the person instead, rising out of a soft blur",
  fits: "a title that belongs to the shot: a place, a name, one word over the moment it names",
  tags: ["type-giant", "type-blur-in"],
  needs: ["video"],
  length: 2.4,
  shortest: 1.6,
  fields: {
    layer: { kind: "layer", required: true, about: "the footage (a video layer)" },
    text: { kind: "text", max: 14, about: "the word (one short word fills best), or give textLayer" },
    textLayer: { kind: "layer", about: "your own text layer instead: the footage plays through it in its own font, size and place (with subject it keeps its color too); it is hidden while the move draws it" },
    subject: { kind: "layer", about: "the subject cut out of the footage (cut_out output subject, above the footage): the word goes between them" },
    place: { kind: "choice", values: ["middle", "top"], about: "where the word sits (default middle; top puts it behind a head)" },
  },
  oneOf: [["text", "textLayer"]],
  example: { layer: "clip", text: "WALK", at: 0.5, dur: 2.4 },
  setup: "clip, a full-frame video (for subject: cut_out {layer: clip, output: subject})",
  build(ctx, input) {
    const layer = videoOf(ctx, input.layer, "layer");
    const subject = input.subject ? ctx.layer(input.subject, "subject") : null;
    if (subject && ctx.order(subject.id) < ctx.order(layer.id)) throw new Error(`masked-type subject: ${subject.id} is under ${layer.id}; the cut-out must be above the footage (cut_out puts it there).`);
    if (frameShare(boxOf(layer), ctx.frame) < 0.6) throw new Error(`masked-type layer: ${layer.id} covers under 60% of the frame; give a full-frame shot.`);
    // Your text layer: the move draws a copy of it (its font, size, place) and hides yours meanwhile.
    const yours = input.textLayer ? ctx.layer(input.textLayer, "textLayer") : null;
    if (yours && yours.type !== "text") throw new Error(`masked-type textLayer: ${yours.id} is a ${yours.type}; give a text layer.`);
    let word, fontSize, spacing;
    if (yours) {
      const { id: _yid, name: _yname, animations: _animations, move: _made, parentId: _parent, ...look } = resizeTextLayer(yours, ctx.fonts);
      word = { ...look, name: yours.name ?? yours.id, role: "headline" };
      fontSize = word.fontSize ?? 40;
      spacing = word.letterSpacing ?? 0;
      input = { ...input, text: yours.text };
    } else {
      const safe = safeArea(ctx.frame);
      // The word fills most of the safe width, on one line, in the look's display face.
      const probe = textLayer(ctx, { part: "word", text: input.text, role: "headline", step: "display", size: 100, box: { ...safe, width: ctx.frame.width * 6 }, align: "center", maxLines: 1, uppercase: true, name: input.text });
      const at100 = probe.width;
      fontSize = Math.round(Math.min(100 * (safe.width * 0.92) / at100, 100 * (safe.height * (subject ? 0.42 : 0.6)) / probe.height));
      const sized = textLayer(ctx, { part: "word", text: input.text, role: "headline", step: "display", size: fontSize, box: { ...safe, width: ctx.frame.width * 2 }, align: "center", maxLines: 1, uppercase: true, name: input.text });
      spacing = round(fontSize * 0.02);
      const width = Math.ceil(sized.width + fontSize * OPEN * 0.02 * input.text.length + fontSize * 0.4);
      const top = (input.place ?? "middle") === "top" ? safe.y + safe.height * 0.06 : ctx.frame.height / 2 - sized.height / 2;
      word = { ...sized, width, x: Math.round((ctx.frame.width - width) / 2), y: Math.round(top), textAlign: "center", letterSpacing: spacing };
    }
    const t = ctx.start, end = ctx.end;
    if (yours) {
      // Yours is hidden while the move draws it, and back after if it showed then.
      const back = ctx.shownAt(yours.id, end);
      ctx.animate(yours.id, "hide", hide(t), "textLayer");
      if (back) ctx.animate(yours.id, "show", show(end), "textLayer");
    }
    if (ctx.duration < TYPE_IN + readSeconds(input.text) + TYPE_OUT - 1e-6) throw new Error(`masked-type needs dur of at least ${round(TYPE_IN + readSeconds(input.text) + TYPE_OUT, 2)} s for "${input.text}" to be read.`);
    const outAt = round(end - TYPE_OUT);
    const center = centerOf(word);
    // The word drifts a little closer the whole time it shows (it never sits still).
    const drift = (target) => {
      const grown = scaledAbout(word, center, 1.05);
      ctx.animate(target, "drift", motion({ name: "Drift", start: t + TYPE_IN, duration: outAt - t - TYPE_IN, easing: CURVES.drift, from: { x: word.x, y: word.y, scaleX: 1, scaleY: 1 }, to: { x: grown.x, y: grown.y, scaleX: 1.05, scaleY: 1.05 } }));
    };
    if (subject) {
      // Behind the subject: a soft dark wash on the footage so the word reads, then the word
      // rises out of a blur with its letters closing, standing between the footage and the cut-out.
      // The wash is down before the word reads and lifts after it goes, so even white sky keeps
      // the word at 3:1.
      const wash = ctx.add("wash", createLayer("rectangle", { name: "Wash", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: SHADE, opacity: 0, role: "decor", allowOverlap: true }), { below: subject.id });
      ctx.animate(wash, "in", motion({ name: "Dim", start: t, duration: TYPE_IN / 3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: WASH } }));
      ctx.animate(wash, "out", motion({ name: "Undim", start: round(outAt + TYPE_OUT / 3), duration: round(TYPE_OUT * 2 / 3), easing: CURVES.fade, from: { opacity: WASH }, to: { opacity: 0 } }));
      ctx.animate(wash, "hide", hide(end));
      // Light ink whatever the look (a light look's text color is dark). cut_out's subject has
      // allowOverlap, so the checks know it covers the word on purpose.
      const { text: ink, bg } = ctx.style.colors;
      const made = ctx.add("word", { ...word, fill: yours ? word.fill : contrast(ink, SHADE) >= contrast(bg, SHADE) ? ink : bg }, { below: subject.id });
      if (ctx.reduced) ctx.animate(made, "in", motion({ name: "Fade in", kind: "in", start: t, duration: TYPE_IN, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      else {
        ctx.animate(made, "in", motion({ name: "Rise", kind: "in", start: t, duration: TYPE_IN, easing: CURVES.settle,
          from: { opacity: 0, y: word.y + Math.round(word.height * 0.35), blur: Math.round(16 * ctx.scale), letterSpacing: round(fontSize * 0.02 * OPEN * 4) }, to: { opacity: 1, y: word.y, blur: 0, letterSpacing: spacing } }));
        drift(made);
      }
      // The word goes before the wash lifts, so it never sits on the bright shot.
      ctx.animate(made, "out", motion({ name: "Fade out", kind: "out", start: outAt, duration: round(TYPE_OUT * 2 / 3), easing: CURVES.leave, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(made, "hide", hide(end));
      return { end, tags: ["type-giant", "type-blur-in", "parallax"] };
    }
    // Inside the word: a plate in the background color covers the shot, and a copy of the shot
    // (same file, place, speed and moves, no sound) shows only through the word's letters, so
    // the footage keeps playing in the type without a seam.
    const plate = ctx.add("plate", createLayer("rectangle", { name: "Plate", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: ctx.style.colors.bg, opacity: 0, role: "decor", allowOverlap: true }), { above: layer.id });
    ctx.animate(plate, "in", motion({ name: "Fall away", start: t, duration: TYPE_IN * 0.8, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(plate, "out", motion({ name: "Come back", start: outAt, duration: TYPE_OUT, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(plate, "hide", hide(end));
    // A mask is white all over: your layer's styled words keep their sizes, not their colors.
    const ranges = word.textStyleRanges?.map(({ start, end: stop, style: { fill: _fill, ...style } }) => ({ start, end: stop, style }));
    const mask = ctx.add("word", { ...word, fill: "#FFFFFF", ...(ranges ? { textStyleRanges: ranges } : {}), isMask: true, role: "decor" }, { above: plate.id });
    const { id: _id, name: _name, move: _move, animations: own = [], ...rest } = layer;
    const fill = ctx.add("fill", { ...rest, volume: 0 }, { above: mask.id });
    own.forEach(({ id: _ignored, ...animation }, index) => ctx.animate(fill, `own-${index + 1}`, animation));
    // In reduced motion the letters only close up; the slow drift stays (it is small and keeps
    // the footage in the letters from reading as a still).
    if (ctx.reduced) ctx.animate(mask, "in", motion({ name: "Close up", kind: "in", start: t, duration: TYPE_IN, easing: CURVES.settle, from: { letterSpacing: round(fontSize * 0.02 * OPEN * 3) }, to: { letterSpacing: spacing } }));
    else {
      const big = scaledAbout(word, center, 1.25);
      ctx.animate(mask, "in", motion({ name: "Close up", kind: "in", start: t, duration: TYPE_IN, easing: CURVES.settle,
        from: { x: big.x, y: big.y, scaleX: 1.25, scaleY: 1.25, letterSpacing: round(fontSize * 0.02 * OPEN * 3) }, to: { x: word.x, y: word.y, scaleX: 1, scaleY: 1, letterSpacing: spacing } }));
    }
    drift(mask);
    for (const part of [mask, fill]) ctx.animate(part, "hide", hide(end));
    return { end, tags: ["type-giant"] };
  },
};
