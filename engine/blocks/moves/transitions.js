// Moves that hand one shot to the next: zoom-through, whip-pan and mask-through-shape.
// Each works on two of the scene's own layers (usually full-frame pictures, videos or groups):
// `from` leaves and `to` arrives. `to` stays hidden until the move reveals it, so it can sit
// anywhere in the stack.
// Every move takes the shared ease and speed fields (move.js SHARED); colors and curves come
// from DEFAULTS through ctx.color and ctx.curve, so a field can change each one.
import { createLayer } from "../../model.js";
import { boxOf, effect, hide, motion, pointIn, round, scaledAbout, show } from "./kit.js";
import { constantSpeed, isReversed } from "../../mediaTime.js";
import { effectiveMediaDuration } from "../../playback.js";
import { speedAnimations } from "../../animation.js";
import { shared } from "../move.js";

// defaults:start (the only place transitions.js names a color or a curve; a guard test checks)
const DEFAULTS = Object.freeze({
  colors: Object.freeze({ flash: "#FFFFFF", mask: "#FFFFFF" }),
  curves: Object.freeze({
    accelerate: "accelerate", settle: "settle", fade: "fade", drift: "drift", whip: "whip", fly: "fly",
    // The push through to the next shot: an ease-in that moves from its first frames (about 1.4x
    // at 40% of a 5x push), not one that holds near 1x and jumps in the last frames.
    push: Object.freeze([0.4, 0, 0.7, 0.2]),
    // A whip's smear rising to the fastest moment, and falling after it.
    smearUp: Object.freeze([0.5, 0, 1, 1]),
    smearDown: Object.freeze([0, 0, 0.5, 1]),
  }),
});
// defaults:end
const COLORS = DEFAULTS.colors;
const CURVE = DEFAULTS.curves;

// Under reduced motion every transition is a plain cross-fade of this length (or the move's).
const CROSS_FADE = 0.5;

/** A motion or effect record whose beat runs on the move's paced clock (ctx.pace). */
export const paced = (make, pace, { start, duration, ...rest }) => make({ ...pace.span(start, duration), ...rest });

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

// A whip shorter than this many frames smears every frame (a guess: 4 frames is where the old
// rise-and-fall of the blur still shows one sharp-ish frame at each end).
const SHORT_WHIP = 4;
const FREEZE_WITH = Object.freeze({ first: { none: "first", last: "both" }, last: { none: "last", first: "both" } });

/**
 * A clip the move carries whose play ends before `until` (or starts after `since`) would draw
 * nothing there, so the background shows through (GAPS 6: black frames at fan-fast k122-123,
 * contest-a f906). By default it holds its edge frame instead (mediaFreeze, put back when the
 * move is removed); holdEnds:false keeps the gap and the receipt names it with the fix.
 */
export function holdClipEdges(ctx, input, layerId, role, { since = null, until = null }) {
  for (const clip of ctx.clipsOf(layerId)) {
    const begins = clip.mediaStart ?? 0;
    const ends = begins + effectiveMediaDuration(clip);
    const freeze = clip.mediaFreeze ?? "both";
    const gaps = [];
    if (since !== null && begins > since + 1e-3 && FREEZE_WITH.first[freeze]) gaps.push(["first", since, begins, "starts after"]);
    if (until !== null && Number.isFinite(ends) && ends < until - 1e-3 && FREEZE_WITH.last[freeze]) gaps.push(["last", ends, until, "ends before"]);
    let held = freeze;
    for (const [edge, from, to, how] of gaps) {
      if (input.holdEnds === false) {
        ctx.note(`black ${round(from)}-${round(to)} s: ${clip.id} ${how} ${ctx.move} ${how === "ends before" ? "ends" : "starts"}; fix: leave out holdEnds (holds its ${edge} frame)`);
        continue;
      }
      held = FREEZE_WITH[edge][held] ?? held;
      ctx.note(`${clip.id} holds its ${edge} frame ${round(from)}-${round(to)} s (its play ${how} the ${role === "from" ? "whip ends" : "whip starts"})`);
    }
    if (held !== freeze) ctx.set(clip.id, { mediaFreeze: held });
  }
}

export function crossFade(ctx, fromId, toId) {
  const length = Math.min(CROSS_FADE, ctx.duration);
  const middle = ctx.start + ctx.duration / 2;
  const start = Math.max(0, middle - length / 2);
  const fade = ctx.curve(CURVE.fade);
  // The new shot is full before the old one starts to fade, so whichever is on top, one of them
  // always covers the frame and the picture never dips toward the background (transition_dip).
  const half = length / 2;
  startClips(ctx, toId, start);
  ctx.animate(toId, "in", motion({ name: "Fade in", kind: "in", start, duration: half, easing: fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  if (fromId) ctx.animate(fromId, "fade", motion({ name: "Fade", start: start + half, duration: half, easing: fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
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

/** zoom-through flashes when flash is white, or when color is given and flash is not none. */
const flashes = (input) => input.flash === "white" || (input.color !== undefined && input.flash !== "none");

/**
 * A flash over everything (white, or the color field): up fast to full at `peak`, then fading
 * for 0.25 s, so a cut under it is never seen. Skipped under reduced motion. Returns when the
 * flash is gone (0 when skipped), so the move's end covers it and a move near the scene's end is
 * asked to start earlier.
 */
function flashAt(ctx, peak, pace) {
  if (ctx.reduced) return 0;
  const flash = ctx.add("flash", createLayer("rectangle", { name: "White flash", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: ctx.color("color", COLORS.flash), opacity: 0, role: "decor", allowOverlap: true }));
  let rise = Math.min(0.06, Math.max(0.001, peak - ctx.start));
  let from = peak - rise;
  // A flash at the very top of a scene (a pull at at:0) cannot start before 0 s: it peaks a hair late.
  if (from < 0) [from, rise] = [0, Math.max(0.001, peak)];
  const top = from + rise;
  ctx.animate(flash, "up", paced(motion, pace, { name: "Flash", start: from, duration: rise, easing: ctx.curve(CURVE.accelerate), from: { opacity: 0 }, to: { opacity: 1 } }));
  ctx.animate(flash, "down", paced(motion, pace, { name: "Flash fades", start: top, duration: 0.25, easing: ctx.curve(CURVE.settle), from: { opacity: 1 }, to: { opacity: 0 } }));
  const gone = pace.at(top + 0.26);
  ctx.animate(flash, "hide", hide(gone));
  return round(gone);
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
  const pace = ctx.pace(ctx.start + push);
  const start = { x: state.x, y: state.y, scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1, rotation: state.rotation ?? 0 };
  const end = { x, y, scaleX: scale, scaleY: scale, rotation: 0 };
  ctx.animate(from.id, "push", paced(motion, pace, { name: "Push into the target", start: ctx.start, duration: push, easing: ctx.reduced ? ctx.curve(CURVE.drift) : ctx.ease(CURVE.accelerate), from: start, to: end }), "from");
  const blurAt = { centerX: round(middle.x / state.width), centerY: round(middle.y / state.height) };
  if (!ctx.reduced && input.blur !== false) {
    // The push eases in (fastest at its end), so the blur rises late; it is 0 again on the landing
    // frame, or (with to) it is still up when the cut hides it.
    const peak = 0.6;
    const [rise, top, fall] = to ? [0.45, 0.92, 1] : [0.45, 0.75, 1];
    ctx.animate(from.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: ctx.start + push * rise, duration: push * (top - rise), easing: ctx.curve(CURVE.accelerate), from: { amount: 0 }, to: { amount: peak, ...blurAt } }), "from");
    ctx.animate(from.id, "unblur", paced(effect, pace, { name: "Zoom blur ends", effect: "zoom-blur", start: ctx.start + push * top, duration: Math.max(0.04, push * (fall - top)), easing: ctx.curve(CURVE.settle), from: { amount: peak }, to: { amount: 0, ...blurAt } }), "from");
  }
  ctx.note(`${input.target.layer}${input.target.rect ? ` [${input.target.rect.join(", ")}]` : ""} fills the frame at scale ${scale}`);
  const flashEnd = flashes(input) ? flashAt(ctx, ctx.start + push, pace) : 0;
  const finish = round(Math.max(ctx.end, flashEnd));
  if (!to) return { end: finish };
  const cut = ctx.start + push;
  ctx.animate(from.id, "hide", hide(pace.at(cut + 0.06)), "from");
  startClips(ctx, to.id, pace.at(cut - 0.06));
  ctx.animate(to.id, "in", paced(motion, pace, { name: "Appear", kind: "in", start: cut - 0.06, duration: 0.12, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  ctx.animate(to.id, "settle", paced(motion, pace, { name: "Settle", start: cut, duration: ctx.end - cut, easing: ctx.curve(CURVE.settle),
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
  const pace = ctx.pace(ctx.start);
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
    ctx.animate(shot.id, "pull", paced(motion, pace, { name: "Pull back", start: ctx.start, duration: ctx.duration, easing: ctx.reduced ? ctx.curve(CURVE.drift) : ctx.ease(CURVE.settle), from: begin, to: rest }), role);
  }
  if (to && !ctx.reduced) {
    ctx.animate(from.id, "hide", hide(pace.at(ctx.start + 0.02)), "from");
    startClips(ctx, to.id, pace.at(ctx.start - 0.02));
    ctx.animate(to.id, "in", paced(motion, pace, { name: "Appear", kind: "in", start: Math.max(0, ctx.start - 0.02), duration: 0.04, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  }
  if (!ctx.reduced && input.blur !== false) {
    // Expo-out is fastest at its start: the blur is there at once and gone before the settle.
    const peak = 0.4;
    ctx.animate(shot.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: ctx.start, duration: 0.03, easing: ctx.curve(CURVE.fade), from: { amount: 0 }, to: { amount: peak, ...blurAt } }), role);
    ctx.animate(shot.id, "unblur", paced(effect, pace, { name: "Zoom blur ends", effect: "zoom-blur", start: ctx.start + 0.03, duration: Math.max(0.06, ctx.duration * 0.4), easing: ctx.curve(CURVE.settle), from: { amount: peak }, to: { amount: 0, ...blurAt } }), role);
  }
  const flashEnd = flashes(input) ? flashAt(ctx, ctx.start, pace) : 0;
  if (!input.title) return { end: round(Math.max(ctx.end, flashEnd)) };
  const title = ctx.layer(input.title, "title");
  if (title.id === shot.id || title.id === from.id) throw new Error("zoom-through title: give a layer other than the shots, such as a title over them.");
  // It lands while the pull settles: up a little and in, finishing after the pull.
  const lands = pace.span(ctx.start + ctx.duration * 0.4, Math.max(0.4, ctx.duration));
  const rise = ctx.reduced ? 0 : Math.round(24 * ctx.scale);
  ctx.animate(title.id, "in", motion({ name: "Title lands", kind: "in", ...lands, easing: ctx.curve(CURVE.settle), from: { opacity: 0, y: title.y + rise }, to: { opacity: 1, y: title.y } }), "title");
  return { end: round(Math.max(ctx.end, lands.start + lands.duration, flashEnd)) };
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
    to: { kind: "layer", about: "the shot it lands on (needed unless target is given); a clip starts playing when it is shown" },
    point: { kind: "point", about: "[x, y] in % of from's box to push into (default its center)" },
    amount: { kind: "number", low: 2, high: 12, about: "how far the push goes, as a scale (default 5; 3 with reverse)" },
    target: { kind: "target", about: "{layer, rect?}: push until this layer (inside from, such as a phone's screen in its group) or the part rect ([x, y, w, h] in % of it) fills the frame exactly; without to, the shot stays there" },
    reverse: { kind: "choice", values: [true], about: "true pulls back instead, expo-out: from target (or point and amount, or where an earlier push left from) to the whole shot; with to, from cuts and to is pulled back on" },
    blur: { kind: "choice", values: ["auto", false], aliases: { true: "auto" }, about: "auto (default) zoom-blurs only the fast part; false keeps every frame sharp" },
    flash: { kind: "choice", values: ["white", "none"], about: "white flashes the frame at the cut (the landing, or the start of a pull); default none" },
    title: { kind: "layer", about: "with reverse: a title layer that rises in as the pull settles" },
    ...shared({ color: `the flash color, hex; flashes unless flash:none (default ${COLORS.flash})`, ease: "the push's (or pull's) curve", speed: "how quick its beats run about the cut, 0.5 to 4 (default 1)" }),
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
    const pace = ctx.pace(cut);
    const fade = ctx.curve(CURVE.fade);
    const landed = scaledAbout(box, aim, amount);
    const center = { centerX: round((aim.x - box.x) / box.width), centerY: round((aim.y - box.y) / box.height) };
    // The push starts where the shot is drawn at that moment (its own slow push or drift included).
    const now = ctx.stateAt(from.id, ctx.start);
    ctx.animate(from.id, "push", paced(motion, pace, { name: "Push through", start: ctx.start, duration: push, easing: ctx.ease(CURVE.push),
      from: { x: round(now.x ?? from.x, 1), y: round(now.y ?? from.y, 1), scaleX: round(now.scaleX ?? 1, 4), scaleY: round(now.scaleY ?? 1, 4) }, to: { x: landed.x, y: landed.y, scaleX: amount, scaleY: amount } }), "from");
    if (!sharp) ctx.animate(from.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: ctx.start + push * 0.3, duration: push * 0.7, easing: ctx.curve(CURVE.accelerate),
      from: { amount: 0 }, to: { amount: 0.9, ...center } }), "from");
    ctx.animate(from.id, "fade", paced(motion, pace, { name: "Fade", start: cut - 0.06, duration: 0.12, easing: fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    const hidden = pace.at(ctx.start + push + 0.02);
    ctx.animate(from.id, "hide", hide(hidden), "from");
    // Once hidden, its blur goes back to 0, so the shot is sharp if it is shown again later.
    if (!sharp) ctx.animate(from.id, "unblur", effect({ name: "Zoom blur rests", effect: "zoom-blur", start: hidden, duration: 0.04, easing: fade,
      from: { amount: 0.9 }, to: { amount: 0, ...center } }), "from");
    // The next shot comes out of the same blur, a little too big, and settles.
    const arrive = ctx.end - cut;
    const big = 1.45;
    // The next shot is full before the pushed one fades, so the frame never dips between them.
    startClips(ctx, to.id, pace.at(cut - 0.12));
    ctx.animate(to.id, "in", paced(motion, pace, { name: "Appear", kind: "in", start: cut - 0.12, duration: 0.06, easing: fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    ctx.animate(to.id, "settle", paced(motion, pace, { name: "Settle", start: cut, duration: arrive, easing: ctx.curve(CURVE.settle),
      from: { scaleX: big * (to.scaleX ?? 1), scaleY: big * (to.scaleY ?? 1) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    if (!sharp) ctx.animate(to.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: cut, duration: arrive * 0.8, easing: ctx.curve(CURVE.settle),
      from: { amount: 0.55 }, to: { amount: 0, centerX: 0.5, centerY: 0.5 } }), "to");
    const flashEnd = flashes(input) ? flashAt(ctx, cut, pace) : 0;
    return { end: round(Math.max(ctx.end, flashEnd)) };
  },
};

const DIRECTIONS = ["left", "right", "up", "down"];
// A direction as a unit step along x and y (0 right, 90 down).
const STEPS = Object.freeze({ right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] });
const AXIS_ANGLES = Object.freeze({ 0: "right", 90: "down", 180: "left", "-180": "left", "-90": "up" });

export const whipPan = {
  name: "whip-pan",
  needsAt: true,
  about: "both shots fly across together like a fast camera pan, smeared by a directional blur that peaks in the middle",
  fits: "jumping between places or moments with energy; a beat drop; side-by-side ideas",
  tags: ["whip-pan", "motion-blur"],
  length: 0.5,
  lasts: "default 0.5, down to one frame; frames:n gives it in frames",
  // Down to one frame of the project's rate (GAPS 8: the old 0.3 s floor was 7.5 frames at 25 fps
  // where fast edits whip in 1 to 2 frames).
  timing: (input, { fps }) => ({ shortest: 1 / fps, ...(input.frames !== undefined ? { length: input.frames / fps } : {}) }),
  fields: {
    from: { kind: "layer", required: true, about: "the shot that leaves" },
    to: { kind: "layer", required: true, about: "the shot that arrives" },
    direction: { kind: "choice", values: DIRECTIONS, about: "where the picture moves: left, right, up or down (default a seeded left or right)" },
    smear: { kind: "number", low: 0, high: 1, about: "the blur at the fastest moment, a share of the travel (default 0.24)" },
    frames: { kind: "number", low: 1, high: 60, whole: true, knob: true, about: "its length in frames instead of dur: 2 = a two-frame whip starting at at, every frame smeared" },
    holdEnds: { kind: "choice", knob: true, values: [true, false], about: "true (default): a clip whose play ends or starts inside the whip holds its edge frame; false shows the background there" },
    ...shared({ angle: "instead of direction, any way the picture moves in degrees: 0 right, 90 down; off the axes, copies of the shots fill the corners", ease: "the pan's curve (default whip)" }), ...shared("speed"),
  },
  example: { from: "shot-a", to: "shot-b", at: 1, direction: "left" },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const from = ctx.layer(input.from, "from");
    const to = ctx.layer(input.to, "to");
    if (from.id === to.id) throw new Error("whip-pan needs two different layers.");
    if (input.direction && input.angle !== undefined) throw new Error("whip-pan takes direction or angle, not both.");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const angle = input.angle;
    const direction = angle === undefined ? input.direction ?? ctx.rng.pick(["left", "right"]) : AXIS_ANGLES[angle] ?? null;
    const [ux, uy] = direction ? STEPS[direction] : [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
    const keys = [ux && "x", uy && "y"].filter(Boolean);
    const step = { x: ux, y: uy };
    // How far each shot travels: the frame's width (or height) on an axis, so the two shots stay
    // side by side like one strip of film; off the axes, until they meet along an edge.
    const distance = Math.min(ux ? ctx.frame.width / Math.abs(ux) : Infinity, uy ? ctx.frame.height / Math.abs(uy) : Infinity);
    const smear = Math.round(distance * (input.smear ?? 0.24));
    // The smear runs along the motion; its angle reads the same both ways (0 to 180).
    const blurAngle = direction ? (ux ? 0 : 90) : round((((angle % 180) + 180) % 180), 2);
    // A whip of a few frames (under SHORT_WHIP frames) runs half a frame early, so each of its
    // frames from at on samples the middle of its slice of the pan, and every one of them is
    // smeared: a rise and fall cannot be seen in so few frames (fan-fast k15-16, k122-123: two
    // fully smeared frames).
    const frame = 1 / ctx.fps;
    const short = ctx.duration < SHORT_WHIP * frame - 1e-6;
    const begin = short ? round(Math.max(0, ctx.start - frame / 2)) : ctx.start;
    const finish = short ? round(ctx.end - frame / 2) : ctx.end;
    const length = finish - begin;
    const half = length / 2;
    const middle = begin + half;
    // speed gathers the pan toward the moment at names: its start (align start), middle or end
    // (it was always the middle, which put a quick whip asked at 0.52 s on 0.62 to 0.72 s).
    const pace = ctx.pace(ctx.align === "end" ? finish : ctx.align === "center" ? middle : begin);
    const whip = ctx.ease(CURVE.whip);
    holdClipEdges(ctx, input, from.id, "from", { until: pace.at(finish) });
    holdClipEdges(ctx, input, to.id, "to", { since: begin });
    // The leaving shot starts where it is drawn at that moment (its own drift included).
    const fromNow = ctx.stateAt(from.id, begin);
    const where = (layer, role, key) => (role === "from" ? fromNow[key] ?? layer[key] : layer[key]);
    const path = (layer, role, lead, shift = {}) => ({
      begin: Object.fromEntries(keys.map((key) => [key, round(where(layer, role, key) + lead * step[key] * distance + (shift[key] ?? 0))])),
      end: Object.fromEntries(keys.map((key) => [key, round(where(layer, role, key) + (lead + 1) * step[key] * distance + (shift[key] ?? 0))])),
    });
    const travel = (target, role, { begin: first, end: last }, kind) => {
      const animate = (name, animation) => (role ? ctx.animate(target, name, animation, role) : ctx.animate(target, name, animation));
      animate("whip", paced(motion, pace, { name: "Whip", kind, start: begin, duration: length, easing: whip, from: first, to: last }));
      if (short) {
        // Full smear on every frame of the whip, gone on the frame after it.
        animate("smear", effect({ name: "Smear", effect: "directional-blur", start: begin, duration: length, easing: ctx.curve(CURVE.smearUp),
          from: { length: smear, angle: blurAngle }, to: { length: smear, angle: blurAngle } }));
        animate("unsmear", effect({ name: "Unsmear", effect: "directional-blur", start: finish, duration: 0.001, easing: ctx.curve(CURVE.smearDown),
          to: { length: 0, angle: blurAngle } }));
        return;
      }
      // The blur rises to its peak at the fastest moment and falls back as the move ends.
      animate("smear", paced(effect, pace, { name: "Smear", effect: "directional-blur", start: begin, duration: half, easing: ctx.curve(CURVE.smearUp),
        // An angled whip holds its angle from the start (a direction keeps its old sweep).
        from: direction ? { length: 0 } : { length: 0, angle: blurAngle }, to: { length: smear, angle: blurAngle } }));
      animate("unsmear", paced(effect, pace, { name: "Unsmear", effect: "directional-blur", start: middle, duration: half, easing: ctx.curve(CURVE.smearDown),
        to: { length: 0, angle: blurAngle } }));
    };
    travel(from.id, "from", path(from, "from", 0), "custom");
    travel(to.id, "to", path(to, "to", -1), "in");
    if (!direction) fillCorners(ctx, { from, to, ux, uy, path, travel, pace, begin, finish });
    ctx.animate(from.id, "hide", hide(pace.at(finish)), "from");
    return { end: ctx.end };
  },
};

/**
 * An off-axis whip: the two shots meet along one edge, so beside each there is a gap. A copy of
 * `to` rides beside `from` and a copy of `from` beside `to` (one frame along that edge), so the
 * frame stays covered like a tiled strip. Copies are parts, shown only during the whip.
 */
function fillCorners(ctx, { from, to, ux, uy, path, travel, pace, begin, finish }) {
  if (from.type === "group" || to.type === "group") return ctx.note("whip-pan angle: a shot is a group, so its corners are not filled (give pictures or clips)");
  const { width, height } = ctx.frame;
  // Rows stacked along y when the height bounds the travel, else columns along x.
  const rows = height / Math.abs(uy) <= width / Math.abs(ux);
  const along = rows ? { x: Math.sign(ux) * width } : { y: Math.sign(uy) * height };
  const back = Object.fromEntries(Object.entries(along).map(([key, value]) => [key, -value]));
  const fromPath = path(from, "from", 0, back);
  const toPath = path(to, "to", -1, along);
  for (const [source, part, place, below] of [[to, "fill-to", fromPath, from], [from, "fill-from", toPath, to]]) {
    const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, ...look } = source;
    const copy = ctx.add(part, createLayer(source.type, { ...look, ...place.begin, role: "decor", allowOverlap: true, ...(source.type === "video" ? { volume: 0 } : {}) }), { above: below.id });
    travel(copy, null, place, "custom");
    ctx.animate(copy, "show", show(pace.at(begin)));
    ctx.animate(copy, "hide", hide(pace.at(finish)));
  }
}

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
    ring: { kind: "number", low: 0, high: 40, about: "the ring's width, px at 1080 tall; 0 = none (default 5)" },
    ...shared({ accent: "the ring's color, hex (default the look's accent)", ease: "the shape's growth curve (default fly)" }), ...shared("speed"),
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
    // speed gathers the growth toward the start: the shape opens sooner, then holds.
    const pace = ctx.pace(ctx.start);
    // The shape's full size covers every corner of `to` from the origin, with a little room.
    const reach = Math.max(...[[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(([x, y]) => Math.hypot(x - origin.x, y - origin.y)));
    const size = Math.ceil(reach * (shape === "circle" ? 2.04 : shape === "diamond" ? 2.1 : 2.3));
    const place = { x: Math.round(origin.x - size / 2), y: Math.round(origin.y - size / 2), width: size, height: size };
    const type = shape === "circle" ? "ellipse" : "rectangle";
    const outline = { radius: shape === "rounded" ? Math.round(size * 0.22) : 0, rotation: shape === "diamond" ? 45 : 0 };
    // The shape grows by its size (not its scale), from its center, so a stroke keeps its width.
    const grow = { ...paced(motion, pace, { name: "Grow", kind: "in", start: ctx.start, duration: ctx.duration, easing: ctx.ease(CURVE.fly), from: { width: 1, height: 1 }, to: { width: size, height: size } }), anchor: "center" };
    // A mask shows the layer just above it where the mask is white: a growing white shape under
    // `to` shows it inside the shape. So `to` must be drawn above `from`; the move puts it there.
    if (from && ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
    const mask = ctx.add("mask", createLayer(type, { name: "Shape mask", ...place, ...outline, fill: COLORS.mask, isMask: true, role: "decor" }), { below: to.id });
    ctx.animate(mask, "grow", grow);
    // A thin accent ring rides the edge, above `to`, gone by the time the shape fills the frame.
    const width = input.ring === undefined ? Math.max(2, Math.round(5 * ctx.scale)) : Math.round(input.ring * ctx.scale * 10) / 10;
    const ring = width > 0 ? ctx.add("ring", createLayer(type, {
      name: "Shape ring", ...place, ...outline, fillEnabled: false, stroke: ctx.color("accent", "accent"), strokeWidth: width,
      strokeAlign: "center", role: "decor", allowOverlap: true,
    }), { above: to.id }) : null;
    if (ring) ctx.animate(ring, "grow", { ...grow });
    // Inside the shape the new shot is a little too close and eases back, so it has depth.
    const inside = scaledAbout(box, origin, 1.12);
    ctx.animate(to.id, "settle", paced(motion, pace, { name: "Settle", start: ctx.start, duration: ctx.duration * 1.15, easing: ctx.curve(CURVE.settle),
      from: { x: inside.x, y: inside.y, scaleX: 1.12 * (to.scaleX ?? 1), scaleY: 1.12 * (to.scaleY ?? 1) }, to: { x: to.x, y: to.y, scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    if (ring) {
      ctx.animate(ring, "fade", paced(motion, pace, { name: "Fade", start: ctx.start + ctx.duration * 0.45, duration: ctx.duration * 0.4, easing: ctx.curve(CURVE.fade), from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(ring, "hide", hide(pace.at(ctx.end)));
    }
    if (from) {
      const pushed = scaledAbout(boxOf(from), origin, 1.08);
      const now = ctx.stateAt(from.id, ctx.start);
      ctx.animate(from.id, "push", paced(motion, pace, { name: "Push", start: ctx.start, duration: ctx.duration, easing: ctx.curve(CURVE.accelerate),
        from: { x: round(now.x ?? from.x, 1), y: round(now.y ?? from.y, 1), scaleX: round(now.scaleX ?? 1, 4), scaleY: round(now.scaleY ?? 1, 4) }, to: { x: pushed.x, y: pushed.y, scaleX: Math.max(1.08, round((now.scaleX ?? 1) * 1.04, 4)), scaleY: Math.max(1.08, round((now.scaleY ?? 1) * 1.04, 4)) } }), "from");
      ctx.animate(from.id, "hide", hide(pace.at(ctx.end)), "from");
    }
    return { end: ctx.end };
  },
};
