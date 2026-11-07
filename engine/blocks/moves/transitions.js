// Moves that hand one shot to the next: zoom-through, whip-pan and mask-through-shape.
// Each works on two of the scene's own layers (usually full-frame pictures, videos or groups):
// `from` leaves and `to` arrives. `to` stays hidden until the move reveals it, so it can sit
// anywhere in the stack.
import { createLayer } from "../../model.js";
import { CURVES, boxOf, effect, hide, motion, pointIn, round, scaledAbout } from "./kit.js";
import { constantSpeed, isReversed } from "../../mediaTime.js";
import { speedAnimations } from "../../animation.js";

// Under reduced motion every transition is a plain cross-fade of this length (or the move's).
const CROSS_FADE = 0.5;

// The push through to the next shot: an ease-in that moves from its first frames (about 1.4x
// at 40% of a 5x push), not one that holds near 1x and jumps in the last frames.
const PUSH_CURVE = Object.freeze([0.4, 0, 0.7, 0.2]);

/**
 * A clip `to` (or a clip in its group) that would start after the move shows it starts there
 * instead, so the frame is never black between the shots. Its in-point (mediaOffset) moves back
 * by the same amount when the file allows, so every scene moment shows the same file frame as
 * before and the clip still ends where it did (callouts and cues set against it stay in sync).
 */
export function startClips(ctx, toId, at) {
  const when = round(Math.max(0, at));
  for (const clip of ctx.clipsOf(toId)) {
    const begins = clip.mediaStart ?? 0;
    if (begins <= when + 1e-6) continue;
    const shift = begins - when;
    // File seconds the earlier start reads at a constant forward speed; a reversed or ramped clip keeps its in-point.
    const steady = !isReversed(clip) && !speedAnimations(clip).length;
    const speed = constantSpeed(clip);
    const offset = Math.max(0, clip.mediaOffset ?? 0);
    const from = steady ? Math.max(0, offset - shift * speed) : offset;
    const change = { mediaStart: when, ...(from !== offset ? { mediaOffset: round(from) } : {}) };
    if (clip.mediaDuration > 0) {
      const room = steady && clip.mediaSourceDuration > 0 ? (clip.mediaSourceDuration - from) / speed : Infinity;
      change.mediaDuration = round(Math.min(clip.mediaDuration + shift, room));
    }
    ctx.set(clip.id, change);
    ctx.note(`${clip.id} starts at ${when} s (was ${begins} s), so it is on screen when ${toId} appears`);
  }
}

export function crossFade(ctx, fromId, toId) {
  const length = Math.min(CROSS_FADE, ctx.duration);
  const middle = ctx.start + ctx.duration / 2;
  const start = Math.max(0, middle - length / 2);
  // The new shot is full before the old one starts to fade, so whichever is on top, one of them
  // always covers the frame and the picture never dips toward the background (transition_dip).
  const half = length / 2;
  startClips(ctx, toId, start);
  ctx.animate(toId, "in", motion({ name: "Fade in", kind: "in", start, duration: half, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  if (fromId) ctx.animate(fromId, "fade", motion({ name: "Fade", start: start + half, duration: half, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
  if (fromId) ctx.animate(fromId, "hide", hide(start + length), "from");
}

/**
 * Where `layer` must be (x, y, scale) for its target (a layer inside it, or that layer itself,
 * or a part rect of it) to fill the frame exactly, its middle at the frame's middle, so no bezel
 * or background shows at the sides. `middle` is the target's middle in the layer's own box.
 */
function fillPose(ctx, layer, target) {
  const found = ctx.inside(target.layer, "target");
  if (found.top !== layer.id) throw new Error(`zoom-through target: ${target.layer} is not ${layer.id} or a part of it; give a layer inside ${layer.id}.`);
  const [rx, ry, rw, rh] = target.rect ?? [0, 0, 100, 100];
  // The target's box in the layer's own coordinates (x 0, y 0 is its corner, before any scale).
  const local = { x: found.box.x + (found.box.width * rx) / 100, y: found.box.y + (found.box.height * ry) / 100, width: (found.box.width * rw) / 100, height: (found.box.height * rh) / 100 };
  // A layer scales about its middle: a point p of it lands at x + width/2 + (p - width/2) x scale.
  const scale = round(Math.max(ctx.frame.width / local.width, ctx.frame.height / local.height), 4);
  const middle = { x: local.x + local.width / 2, y: local.y + local.height / 2 };
  const x = round(ctx.frame.width / 2 - layer.width / 2 - (middle.x - layer.width / 2) * scale, 1);
  const y = round(ctx.frame.height / 2 - layer.height / 2 - (middle.y - layer.height / 2) * scale, 1);
  return { x, y, scale, middle };
}

/**
 * A white frame over everything: up fast to full at `peak`, then fading for 0.25 s, so a cut
 * under it is never seen. Skipped under reduced motion. Returns when the flash is gone (0 when
 * skipped), so the move's end covers it and a move near the scene's end is asked to start earlier.
 */
function whiteFlash(ctx, peak) {
  if (ctx.reduced) return 0;
  const flash = ctx.add("flash", createLayer("rectangle", { name: "White flash", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: "#FFFFFF", opacity: 0, role: "decor", allowOverlap: true }));
  let rise = Math.min(0.06, Math.max(0.001, peak - ctx.start));
  let from = peak - rise;
  // A flash at the very top of a scene (a pull at at:0) cannot start before 0 s: it peaks a hair late.
  if (from < 0) [from, rise] = [0, Math.max(0.001, peak)];
  const top = from + rise;
  ctx.animate(flash, "up", motion({ name: "Flash", start: from, duration: rise, easing: CURVES.accelerate, from: { opacity: 0 }, to: { opacity: 1 } }));
  ctx.animate(flash, "down", motion({ name: "Flash fades", start: top, duration: 0.25, easing: CURVES.settle, from: { opacity: 1 }, to: { opacity: 0 } }));
  ctx.animate(flash, "hide", hide(top + 0.26));
  return round(top + 0.26);
}

/**
 * zoom-through with a target: pushes `from` until the target (a layer inside it, such as a
 * phone's screen in the phone's group, or a part of that layer) fills the frame exactly. The zoom
 * blur plays only while the push is fast and is back at 0 when it lands. With `to`, the move cuts
 * to `to` once the target fills the frame; without, `from` stays filling the frame.
 */
function pushToTarget(ctx, from, input) {
  const to = input.to ? ctx.layer(input.to, "to") : null;
  if (to && to.id === from.id) throw new Error("zoom-through needs two different layers.");
  const state = ctx.stateAt(from.id, ctx.start);
  const { x, y, scale, middle } = fillPose(ctx, { ...from, width: state.width, height: state.height }, input.target);
  const push = to ? ctx.duration * 0.8 : ctx.duration;
  const start = { x: state.x, y: state.y, scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1, rotation: state.rotation ?? 0 };
  const end = { x, y, scaleX: scale, scaleY: scale, rotation: 0 };
  ctx.animate(from.id, "push", motion({ name: "Push into the target", start: ctx.start, duration: push, easing: ctx.reduced ? CURVES.drift : CURVES.accelerate, from: start, to: end }), "from");
  const blurAt = { centerX: round(middle.x / state.width), centerY: round(middle.y / state.height) };
  if (!ctx.reduced && input.blur !== false) {
    // The push eases in (fastest at its end), so the blur rises late; it is 0 again on the landing
    // frame, or (with to) it is still up when the cut hides it.
    const peak = 0.6;
    const [rise, top, fall] = to ? [0.45, 0.92, 1] : [0.45, 0.75, 1];
    ctx.animate(from.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: ctx.start + push * rise, duration: push * (top - rise), easing: CURVES.accelerate, from: { amount: 0 }, to: { amount: peak, ...blurAt } }), "from");
    ctx.animate(from.id, "unblur", effect({ name: "Zoom blur ends", effect: "zoom-blur", start: ctx.start + push * top, duration: Math.max(0.04, push * (fall - top)), easing: CURVES.settle, from: { amount: peak }, to: { amount: 0, ...blurAt } }), "from");
  }
  ctx.note(`${input.target.layer}${input.target.rect ? ` [${input.target.rect.join(", ")}]` : ""} fills the frame at scale ${scale}`);
  const flashEnd = input.flash === "white" ? whiteFlash(ctx, ctx.start + push) : 0;
  const finish = round(Math.max(ctx.end, flashEnd));
  if (!to) return { end: finish };
  const cut = ctx.start + push;
  ctx.animate(from.id, "hide", hide(cut + 0.06), "from");
  startClips(ctx, to.id, cut - 0.06);
  ctx.animate(to.id, "in", motion({ name: "Appear", kind: "in", start: cut - 0.06, duration: 0.12, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  ctx.animate(to.id, "settle", motion({ name: "Settle", start: cut, duration: ctx.end - cut, easing: CURVES.settle,
    from: { scaleX: 1.08 * (to.scaleX ?? 1), scaleY: 1.08 * (to.scaleY ?? 1) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
  return { end: finish };
}

/**
 * zoom-through reverse: the camera pulls back from inside a shot to the whole shot, fast then a
 * long settle (expo-out). It starts from target (that part fills the frame), else from a push of
 * `amount` into `point`, else from where an earlier push left the layer. With `to`, `from` is
 * cut at the start and `to` is the shot pulled back on. A title lands as the pull settles.
 */
function pullBack(ctx, from, input) {
  const to = input.to ? ctx.layer(input.to, "to") : null;
  if (to && to.id === from.id) throw new Error("zoom-through needs two different layers.");
  const shot = to ?? from;
  const role = to ? "to" : "from";
  const rest = { x: shot.x, y: shot.y, scaleX: shot.scaleX ?? 1, scaleY: shot.scaleY ?? 1, rotation: shot.rotation ?? 0 };
  const now = ctx.stateAt(shot.id, ctx.start);
  const box = boxOf(shot);
  let begin;
  let aim;
  if (input.target) {
    const pose = fillPose(ctx, shot, input.target);
    begin = { x: pose.x, y: pose.y, scaleX: pose.scale, scaleY: pose.scale, rotation: 0 };
    aim = { x: pose.middle.x / shot.width, y: pose.middle.y / shot.height };
  } else if (!to && !input.point && !input.amount && (now.scaleX ?? 1) > rest.scaleX * 1.05) {
    // An earlier push (a zoom-through with a target) left it close: pull back from there.
    begin = { x: round(now.x, 1), y: round(now.y, 1), scaleX: round(now.scaleX, 4), scaleY: round(now.scaleY ?? now.scaleX, 4), rotation: now.rotation ?? 0 };
    // The frame's middle in the shot's own box (0 to 1): the point the camera pulls back from.
    aim = { x: 0.5 + (ctx.frame.width / 2 - begin.x - box.width / 2) / (box.width * begin.scaleX), y: 0.5 + (ctx.frame.height / 2 - begin.y - box.height / 2) / (box.height * begin.scaleY) };
  } else {
    const amount = input.amount ?? 3;
    const point = pointIn(box, input.point);
    const at = scaledAbout(box, point, amount);
    begin = { x: at.x, y: at.y, scaleX: round(amount * rest.scaleX, 4), scaleY: round(amount * rest.scaleY, 4), rotation: rest.rotation };
    aim = { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height };
  }
  const blurAt = { centerX: round(Math.min(1, Math.max(0, aim.x))), centerY: round(Math.min(1, Math.max(0, aim.y))) };
  if (ctx.reduced && to) {
    // Reduced motion: no big zoom; the shots cross-fade (the title still lands).
    crossFade(ctx, from.id, to.id);
  } else {
    if (ctx.reduced) {
      // Reduced motion: a gentle drift of at most 5% about the same point, not a big zoom.
      const point = { x: box.x + box.width * Math.min(1, Math.max(0, aim.x)), y: box.y + box.height * Math.min(1, Math.max(0, aim.y)) };
      const at = scaledAbout(box, point, 1.05);
      begin = { x: at.x, y: at.y, scaleX: round(1.05 * rest.scaleX, 4), scaleY: round(1.05 * rest.scaleY, 4), rotation: rest.rotation };
    }
    ctx.animate(shot.id, "pull", motion({ name: "Pull back", start: ctx.start, duration: ctx.duration, easing: ctx.reduced ? CURVES.drift : CURVES.settle, from: begin, to: rest }), role);
  }
  if (to && !ctx.reduced) {
    ctx.animate(from.id, "hide", hide(ctx.start + 0.02), "from");
    startClips(ctx, to.id, ctx.start - 0.02);
    ctx.animate(to.id, "in", motion({ name: "Appear", kind: "in", start: Math.max(0, ctx.start - 0.02), duration: 0.04, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  }
  if (!ctx.reduced && input.blur !== false) {
    // Expo-out is fastest at its start: the blur is there at once and gone before the settle.
    const peak = 0.4;
    ctx.animate(shot.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: ctx.start, duration: 0.03, easing: CURVES.fade, from: { amount: 0 }, to: { amount: peak, ...blurAt } }), role);
    ctx.animate(shot.id, "unblur", effect({ name: "Zoom blur ends", effect: "zoom-blur", start: ctx.start + 0.03, duration: Math.max(0.06, ctx.duration * 0.4), easing: CURVES.settle, from: { amount: peak }, to: { amount: 0, ...blurAt } }), role);
  }
  const flashEnd = input.flash === "white" ? whiteFlash(ctx, ctx.start) : 0;
  if (!input.title) return { end: round(Math.max(ctx.end, flashEnd)) };
  const title = ctx.layer(input.title, "title");
  if (title.id === shot.id || title.id === from.id) throw new Error("zoom-through title: give a layer other than the shots, such as a title over them.");
  // It lands while the pull settles: up a little and in, finishing after the pull.
  const start = ctx.start + ctx.duration * 0.4;
  const length = Math.max(0.4, ctx.duration);
  const rise = ctx.reduced ? 0 : Math.round(24 * ctx.scale);
  ctx.animate(title.id, "in", motion({ name: "Title lands", kind: "in", start, duration: length, easing: CURVES.settle, from: { opacity: 0, y: title.y + rise }, to: { opacity: 1, y: title.y } }), "title");
  return { end: round(Math.max(ctx.end, start + length, flashEnd)) };
}

export const zoomThrough = {
  name: "zoom-through",
  needsAt: true,
  about: "the camera pushes into a point of one shot, faster and faster, with a zoom blur, and lands on the next shot settling out of the same blur; reverse:true pulls back out of a part of a shot to the whole shot",
  fits: "a cut that should feel like going inside: into a screen, a face, a sign, a detail",
  tags: ["zoom-through", "speed-ramp"],
  length: 0.9,
  fields: {
    from: { kind: "layer", required: true, about: "the shot to push into" },
    to: { kind: "layer", about: "the shot it lands on (needed unless target is given)" },
    point: { kind: "point", about: "[x, y] in % of from's box to push into (default its center)" },
    amount: { kind: "number", low: 2, high: 12, about: "how far the push goes, as a scale (default 5; 3 with reverse)" },
    target: { kind: "target", about: "{layer, rect?}: push until this layer (inside from, such as a phone's screen in its group) or the part rect ([x, y, w, h] in % of it) fills the frame exactly; without to, the shot stays there" },
    reverse: { kind: "choice", values: [true], about: "true pulls back instead, expo-out: from target (or point and amount, or where an earlier push left from) to the whole shot; with to, from cuts and to is pulled back on" },
    blur: { kind: "choice", values: ["auto", false], aliases: { true: "auto" }, about: "auto (default) zoom-blurs only the fast part; false keeps every frame sharp" },
    flash: { kind: "choice", values: ["white", "none"], about: "white flashes the frame at the cut (the landing, or the start of a pull); default none" },
    title: { kind: "layer", about: "with reverse: a title layer that rises in as the pull settles" },
  },
  anyOf: [["to", "target", "reverse"]],
  // A pull back is quick by default, and a push to a target can be a fast snap;
  // a push through to another shot needs room for the cut and the settle.
  timing: (input) => (input.reverse ? { length: 0.4, shortest: 0.2 } : input.target ? { shortest: 0.2 } : { shortest: 0.5 }),
  lasts: "default 0.9 (0.4 with reverse); at least 0.5 (0.2 with reverse or target)",
  example: { from: "shot-a", to: "shot-b", at: 1, point: [62, 40] },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const from = ctx.layer(input.from, "from");
    if (input.title && !input.reverse) throw new Error("zoom-through title goes with reverse:true (a title landing as the pull settles).");
    if (input.reverse) return pullBack(ctx, from, input);
    if (input.target) return pushToTarget(ctx, from, input);
    const to = ctx.layer(input.to, "to");
    if (from.id === to.id) throw new Error("zoom-through needs two different layers.");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const sharp = input.blur === false;
    const box = boxOf(from);
    const aim = pointIn(box, input.point);
    const amount = input.amount ?? 5;
    const push = ctx.duration * 0.62;
    // The cut point: near the end of the push, when the blur hides everything.
    const cut = ctx.start + push * 0.9;
    const landed = scaledAbout(box, aim, amount);
    // The push starts where the shot is drawn at that moment (its own slow push or drift included).
    const now = ctx.stateAt(from.id, ctx.start);
    ctx.animate(from.id, "push", motion({ name: "Push through", start: ctx.start, duration: push, easing: PUSH_CURVE,
      from: { x: round(now.x ?? from.x, 1), y: round(now.y ?? from.y, 1), scaleX: round(now.scaleX ?? 1, 4), scaleY: round(now.scaleY ?? 1, 4) }, to: { x: landed.x, y: landed.y, scaleX: amount, scaleY: amount } }), "from");
    if (!sharp) ctx.animate(from.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: ctx.start + push * 0.3, duration: push * 0.7, easing: CURVES.accelerate,
      from: { amount: 0 }, to: { amount: 0.9, centerX: round((aim.x - box.x) / box.width), centerY: round((aim.y - box.y) / box.height) } }), "from");
    ctx.animate(from.id, "fade", motion({ name: "Fade", start: cut - 0.06, duration: 0.12, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    ctx.animate(from.id, "hide", hide(ctx.start + push + 0.02), "from");
    // Once hidden, its blur goes back to 0, so the shot is sharp if it is shown again later.
    if (!sharp) ctx.animate(from.id, "unblur", effect({ name: "Zoom blur rests", effect: "zoom-blur", start: ctx.start + push + 0.02, duration: 0.04, easing: CURVES.fade,
      from: { amount: 0.9 }, to: { amount: 0, centerX: round((aim.x - box.x) / box.width), centerY: round((aim.y - box.y) / box.height) } }), "from");
    // The next shot comes out of the same blur, a little too big, and settles.
    const arrive = ctx.end - cut;
    const big = 1.45;
    // The next shot is full before the pushed one fades, so the frame never dips between them.
    startClips(ctx, to.id, cut - 0.12);
    ctx.animate(to.id, "in", motion({ name: "Appear", kind: "in", start: cut - 0.12, duration: 0.06, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    ctx.animate(to.id, "settle", motion({ name: "Settle", start: cut, duration: arrive, easing: CURVES.settle,
      from: { scaleX: big * (to.scaleX ?? 1), scaleY: big * (to.scaleY ?? 1) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    if (!sharp) ctx.animate(to.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: cut, duration: arrive * 0.8, easing: CURVES.settle,
      from: { amount: 0.55 }, to: { amount: 0, centerX: 0.5, centerY: 0.5 } }), "to");
    const flashEnd = input.flash === "white" ? whiteFlash(ctx, cut) : 0;
    return { end: round(Math.max(ctx.end, flashEnd)) };
  },
};

const DIRECTIONS = ["left", "right", "up", "down"];

export const whipPan = {
  name: "whip-pan",
  needsAt: true,
  about: "both shots fly across together like a fast camera pan, smeared by a directional blur that peaks in the middle; the motion runs the same way on both",
  fits: "jumping between places or moments with energy; a beat drop; side-by-side ideas",
  tags: ["whip-pan", "motion-blur"],
  length: 0.5,
  shortest: 0.3,
  fields: {
    from: { kind: "layer", required: true, about: "the shot that leaves" },
    to: { kind: "layer", required: true, about: "the shot that arrives" },
    direction: { kind: "choice", values: DIRECTIONS, about: "where the picture moves: left, right, up or down (default a seeded left or right)" },
  },
  example: { from: "shot-a", to: "shot-b", at: 1, direction: "left" },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const from = ctx.layer(input.from, "from");
    const to = ctx.layer(input.to, "to");
    if (from.id === to.id) throw new Error("whip-pan needs two different layers.");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const direction = input.direction ?? ctx.rng.pick(["left", "right"]);
    const across = direction === "left" || direction === "right";
    const key = across ? "x" : "y";
    // The whole frame's width (or height): the two shots stay side by side, like one strip of film.
    const distance = across ? ctx.frame.width : ctx.frame.height;
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    const smear = Math.round(distance * 0.24);
    const angle = across ? 0 : 90;
    const half = ctx.duration / 2;
    const middle = ctx.start + half;
    // The leaving shot starts where it is drawn at that moment (its own drift included).
    const fromAt = ctx.stateAt(from.id, ctx.start)[key] ?? from[key];
    for (const [layer, role, offset, place] of [[from, "from", 0, fromAt], [to, "to", -sign * distance, to[key]]]) {
      ctx.animate(layer.id, "whip", motion({ name: "Whip", kind: role === "to" ? "in" : "custom", start: ctx.start, duration: ctx.duration, easing: CURVES.whip,
        from: { [key]: round(place + offset) }, to: { [key]: round(place + offset + sign * distance) } }), role);
      // The blur rises to its peak at the fastest moment and falls back as the move ends.
      ctx.animate(layer.id, "smear", effect({ name: "Smear", effect: "directional-blur", start: ctx.start, duration: half, easing: [0.5, 0, 1, 1],
        from: { length: 0 }, to: { length: smear, angle } }), role);
      ctx.animate(layer.id, "unsmear", effect({ name: "Unsmear", effect: "directional-blur", start: middle, duration: half, easing: [0, 0, 0.5, 1],
        to: { length: 0, angle } }), role);
    }
    ctx.animate(from.id, "hide", hide(ctx.end), "from");
    return { end: ctx.end };
  },
};

const SHAPES = ["circle", "rounded", "diamond"];

export const maskThroughShape = {
  name: "mask-through-shape",
  needsAt: true,
  about: "a shape grows from a point as a mask, revealing the next shot inside it, with a thin accent ring riding its edge; the old shot pushes in a little underneath",
  fits: "opening a new idea from a detail (a button, an icon, a face); a softer change than a cut that still moves",
  tags: ["mask-wipe"],
  length: 0.9,
  shortest: 0.5,
  fields: {
    to: { kind: "layer", required: true, about: "the shot revealed inside the shape" },
    from: { kind: "layer", about: "the shot underneath (it pushes in a little while the shape grows)" },
    shape: { kind: "choice", values: SHAPES, about: "circle, rounded or diamond (default a seeded circle or rounded)" },
    point: { kind: "point", about: "[x, y] in % of to's box where the shape grows from (default the center)" },
  },
  example: { to: "shot-b", from: "shot-a", at: 1, shape: "circle", point: [70, 45] },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const to = ctx.layer(input.to, "to");
    const from = input.from ? ctx.layer(input.from, "from") : null;
    if (from && from.id === to.id) throw new Error("mask-through-shape needs two different layers.");
    if (ctx.reduced) return crossFade(ctx, from?.id ?? null, to.id);
    const shape = input.shape ?? ctx.rng.pick(["circle", "rounded"]);
    const box = boxOf(to);
    const origin = pointIn(box, input.point);
    // The shape's full size covers every corner of `to` from the origin, with a little room.
    const reach = Math.max(...[[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(([x, y]) => Math.hypot(x - origin.x, y - origin.y)));
    const size = Math.ceil(reach * (shape === "circle" ? 2.04 : shape === "diamond" ? 2.1 : 2.3));
    const place = { x: Math.round(origin.x - size / 2), y: Math.round(origin.y - size / 2), width: size, height: size };
    const type = shape === "circle" ? "ellipse" : "rectangle";
    const outline = { radius: shape === "rounded" ? Math.round(size * 0.22) : 0, rotation: shape === "diamond" ? 45 : 0 };
    // The shape grows by its size (not its scale), from its center, so a stroke keeps its width.
    const grow = { ...motion({ name: "Grow", kind: "in", start: ctx.start, duration: ctx.duration, easing: CURVES.fly, from: { width: 1, height: 1 }, to: { width: size, height: size } }), anchor: "center" };
    // A mask shows the layer just above it where the mask is white: a growing white shape under
    // `to` shows it inside the shape. So `to` must be drawn above `from`; the move puts it there.
    if (from && ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
    const mask = ctx.add("mask", createLayer(type, { name: "Shape mask", ...place, ...outline, fill: "#FFFFFF", isMask: true, role: "decor" }), { below: to.id });
    ctx.animate(mask, "grow", grow);
    // A thin accent ring rides the edge, above `to`, gone by the time the shape fills the frame.
    const ring = ctx.add("ring", createLayer(type, {
      name: "Shape ring", ...place, ...outline, fillEnabled: false, stroke: ctx.style.colors.accent, strokeWidth: Math.max(2, Math.round(5 * ctx.scale)),
      strokeAlign: "center", role: "decor", allowOverlap: true,
    }), { above: to.id });
    ctx.animate(ring, "grow", { ...grow });
    // Inside the shape the new shot is a little too close and eases back, so it has depth.
    const inside = scaledAbout(box, origin, 1.12);
    ctx.animate(to.id, "settle", motion({ name: "Settle", start: ctx.start, duration: ctx.duration * 1.15, easing: CURVES.settle,
      from: { x: inside.x, y: inside.y, scaleX: 1.12 * (to.scaleX ?? 1), scaleY: 1.12 * (to.scaleY ?? 1) }, to: { x: to.x, y: to.y, scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.animate(ring, "fade", motion({ name: "Fade", start: ctx.start + ctx.duration * 0.45, duration: ctx.duration * 0.4, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(ring, "hide", hide(ctx.end));
    if (from) {
      const pushed = scaledAbout(boxOf(from), origin, 1.08);
      const now = ctx.stateAt(from.id, ctx.start);
      ctx.animate(from.id, "push", motion({ name: "Push", start: ctx.start, duration: ctx.duration, easing: CURVES.accelerate,
        from: { x: round(now.x ?? from.x, 1), y: round(now.y ?? from.y, 1), scaleX: round(now.scaleX ?? 1, 4), scaleY: round(now.scaleY ?? 1, 4) }, to: { x: pushed.x, y: pushed.y, scaleX: Math.max(1.08, round((now.scaleX ?? 1) * 1.04, 4)), scaleY: Math.max(1.08, round((now.scaleY ?? 1) * 1.04, 4)) } }), "from");
      ctx.animate(from.id, "hide", hide(ctx.end), "from");
    }
    return { end: ctx.end };
  },
};
