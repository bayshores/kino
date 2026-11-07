// cursor: a macOS-style pointer drawn by kino travels to a real button in your screenshot, clicks
// it, or grabs a card and drags it (a hand glides up to a button, the cursor squishes and the
// button darkens at the click; a hand grabs a card and drags it off the phone; an arrow glides
// over the window to the clip it opens).
//
// The pointer is vector paths in a group (arrow, pointing hand, closed hand), so it is crisp at
// any size, with a soft shadow. Each leg eases out on an arc: the x and y travel on two
// different expo-out curves, so the path bows a little and never overshoots, and a longer leg
// takes longer (about the square root of the distance, as a hand moves). A click squishes the
// pointer 3% and presses the target 2.5% (both scale about their centers and spring back). A
// drag grabs the layer (the hand closes) and the layer follows the pointer a beat behind.
import { createLayer } from "../../model.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

// The pointer's shapes in a 24-unit-tall box (y down), with the point that clicks (the hotspot).
export const SHAPES = {
  // The classic arrow: black with a white rim.
  arrow: { path: "M1 1L1 18.6L5.2 14.6L8.1 21.3L11 20L8.2 13.6L13.9 13.6Z", fill: "#000000", stroke: "#FFFFFF", hot: [1, 1] },
  // The pointing hand: white with a black rim, the fingertip clicks.
  hand: { path: "M7.75 1C8.7 1 9.5 1.8 9.5 2.75L9.5 9.5C9.5 8.6 10.2 8 11 8C11.8 8 12.5 8.6 12.5 9.5L12.5 10.5C12.5 9.6 13.2 9 14 9C14.8 9 15.5 9.6 15.5 10.5L15.5 11.5C15.5 10.6 16.2 10 17 10C17.8 10 18.5 10.6 18.5 11.5L18.5 17C18.5 20.5 16.5 23 13 23L10.5 23C8.5 23 7.2 22.2 6 20.8L1.8 15.8C1.2 15.1 1.3 14.1 2 13.6C2.7 13.1 3.7 13.2 4.3 13.9L6 15.8L6 2.75C6 1.8 6.8 1 7.75 1Z", fill: "#FFFFFF", stroke: "#000000", hot: [7.75, 1] },
  // The closed hand that holds what it drags: the palm's middle holds the point.
  grab: { path: "M6 9C6 6.8 9.5 6.8 9.5 9C9.5 6.8 12.5 6.8 12.5 9C12.5 6.8 15.5 6.8 15.5 9.5C15.5 7.6 18.5 7.6 18.5 10.5L18.5 17C18.5 20.5 16.5 23 13 23L10.5 23C8.5 23 7.2 22.2 6 20.8L2.5 16.5C1.9 15.8 2 14.8 2.7 14.3C3.4 13.8 4.4 13.9 5 14.6L6 15.8Z", fill: "#FFFFFF", stroke: "#000000", hot: [12, 13] },
  // The text I-beam: black with a white rim, the middle of the bar clicks.
  text: { path: "M5.5 1L10.5 1L10.5 2.6L8.8 2.6L8.8 21.4L10.5 21.4L10.5 23L5.5 23L5.5 21.4L7.2 21.4L7.2 2.6L5.5 2.6Z", fill: "#000000", stroke: "#FFFFFF", hot: [8, 12] },
};
export const UNITS = 24;
// Where every shape's hotspot sits in the group's own box (in units), so a change of shape never jumps.
const HOT = [7.75, 1];
const BOX = [20, 24];

// The x travel eases out hard (expo-out); the y travel a little softer: the path bows, no overshoot.
const LEAD = Object.freeze([0.16, 1, 0.3, 1]);
const TRAIL = Object.freeze([0.33, 0.62, 0.24, 1]);
// Timing in seconds: a beat on the target before the press, the press, the spring back (it
// starts still, where the press stopped, so the two join with no jump in speed).
const HOVER = 0.1;
const PRESS = 0.07;
const RELEASE = 0.14;
// The pointer squishes 3%, the target presses 2.5%, a dragged layer lifts 3% and lags this far.
const SQUISH = 0.97;
const PUSH = 0.975;
const LIFT = 1.03;
const LAG = 0.07;

/** Seconds a leg of `distance` px takes in a frame whose shorter side is `side`: 0.35 to 1.1. */
export function travelSeconds(distance, side) {
  return round(Math.min(1.1, Math.max(0.35, 0.3 + 0.55 * Math.sqrt(Math.max(0, distance) / side))));
}

/** The pointer's shape `name` as path data scaled to a pointer `size` px tall. */
export function cursorPath(name, size) {
  const k = size / UNITS;
  return SHAPES[name].path.replace(/-?\d*\.?\d+/g, (number) => String(round(Number(number) * k, 2)));
}

// A layer or group turned more than this many degrees (rotation, rotateX, rotateY) is refused:
// the pointer's flat sums would land beside the real pixels.
const TURN = 0.5;

// A layer's box on screen at `time`: its own scale about its center, then each group around it,
// nearest first (its place, then its scale about its center). `scale` is the groups' scale
// alone, which turns a scene-pixel move into the layer's own units.
function screenBox(ctx, layerId, time) {
  const own = ctx.partStateAt(layerId, time);
  const groups = ctx.parents(layerId).map((parent) => ctx.partStateAt(parent.id, time));
  if ([own, ...groups].some((state) => ["rotation", "rotateX", "rotateY"].some((key) => Math.abs(state[key] ?? 0) > TURN)))
    throw new Error(`cursor cannot aim at ${layerId}: it or a group around it is turned at ${round(time)} s; give to:[x, y] in scene pixels instead.`);
  const sx = Math.abs(own.scaleX ?? 1);
  const sy = Math.abs(own.scaleY ?? 1);
  let box = { x: own.x + (own.width * (1 - sx)) / 2, y: own.y + (own.height * (1 - sy)) / 2, width: own.width * sx, height: own.height * sy };
  const scale = { x: 1, y: 1 };
  for (const state of groups) {
    const gx = Math.abs(state.scaleX ?? 1);
    const gy = Math.abs(state.scaleY ?? 1);
    box = { x: state.x + state.width / 2 + (box.x - state.width / 2) * gx, y: state.y + state.height / 2 + (box.y - state.height / 2) * gy, width: box.width * gx, height: box.height * gy };
    scale.x *= gx;
    scale.y *= gy;
  }
  return { ...box, scale };
}

// Whether a layer and every group around it are on screen at `time`.
function onScreen(ctx, layerId, time) {
  return [layerId, ...ctx.parents(layerId).map((parent) => parent.id)].every((id) => ctx.shownAt(id, time));
}

// Boxes overlap (both in the same coordinates).
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// The scene point a stop names at `time`: [x, y] in scene pixels, or a point in a layer's box
// ([x, y] in percent, the center when missing).
function spotOf(ctx, stop, point, time) {
  if (!stop.layer) return { x: stop.point[0], y: stop.point[1] };
  const box = screenBox(ctx, stop.layer, time);
  const [px, py] = stop.point ?? point ?? [50, 50];
  return { x: round(box.x + (box.width * px) / 100, 1), y: round(box.y + (box.height * py) / 100, 1) };
}

export const cursor = {
  name: "cursor",
  about: "a crisp macOS pointer glides on an eased arc to a real button in your screenshot and clicks it (the pointer squishes, the button presses), or grabs a layer and drags it",
  fits: "a click on a real button, or a card dragged",
  tags: ["cursor"],
  length: 2,
  fields: {
    to: { kind: "stops", required: true, about: "where the pointer goes: a layer (a split_image piece such as app-find), [x, y] in scene pixels, {layer, point}, or a list of these visited in turn" },
    point: { kind: "point", about: "where in a layer it points, [x, y] in % of the box (default [50, 50], the middle)" },
    click: { kind: "choice", values: [true, false], about: "click each layer it reaches (default true; the last one only when dragging)" },
    drag: { kind: "layer", about: "a layer (a piece inside a group too) the pointer grabs first and drags to the last stop; it follows a beat behind" },
    state: { kind: "choice", values: ["arrow", "hand", "grab"], about: "the pointer's shape (default arrow; hand while it drags)" },
    from: { kind: "stops", most: 1, about: "where the pointer comes in: [x, y] in scene pixels or a layer (default below and right of the first stop)" },
    size: { kind: "number", low: 12, high: 400, about: "the pointer's height in pixels (default 6% of the frame's shorter side)" },
    hold: { kind: "number", low: 0, high: 10, about: "seconds the pointer stays after the last stop before it fades (default 0.6)" },
  },
  example: { to: "app-card", at: 0.5 },
  setup: "a screenshot cut with split_image so each real button is its own piece; the pointer clicks the piece's own pixels (no invented buttons)",
  build(ctx, input) {
    const side = Math.min(ctx.frame.width, ctx.frame.height);
    const size = input.size ?? Math.round(side * 0.06);
    const k = size / UNITS;
    const stops = input.drag ? [{ layer: input.drag }, ...input.to] : input.to;
    if (input.drag && stops.length < 2) throw new Error("cursor drag needs to: where the layer is dropped.");
    const clicks = input.click !== false;
    const dragging = Boolean(input.drag);
    const travelShape = input.state ?? (dragging ? "hand" : "arrow");

    // The timeline: each leg starts where the last ended, its length set by its distance.
    const firstGuess = spotOf(ctx, stops[0], input.point, ctx.start + 0.6);
    let start = input.from ? spotOf(ctx, input.from[0], input.point, ctx.start)
      : { x: round(firstGuess.x + side * 0.22, 1), y: round(firstGuess.y + side * 0.3, 1) };
    // The default way in stays inside the frame, so the pointer is seen arriving.
    if (!input.from) start = { x: Math.min(ctx.frame.width - size, Math.max(size, start.x)), y: Math.min(ctx.frame.height - size, Math.max(size, start.y)) };
    const appear = 0.15;
    let time = ctx.start + appear;
    let at = start;
    const legs = [];
    stops.forEach((stop, index) => {
      // Aim at where the target will be when the pointer gets there.
      let to = spotOf(ctx, stop, input.point, time + 0.6);
      const travel = travelSeconds(Math.hypot(to.x - at.x, to.y - at.y), side);
      if (stop.layer) to = spotOf(ctx, stop, input.point, time + travel);
      const arrive = round(time + travel);
      const grabs = dragging && index === 0;
      const press = stop.layer && (grabs || (clicks && !dragging)) ? round(arrive + HOVER) : null;
      legs.push({ stop, from: at, to, start: time, travel, arrive, press });
      time = press !== null ? press + PRESS + RELEASE + 0.12 : arrive + 0.18;
      at = to;
    });
    // A click or grab on a layer that is not on screen would press empty pixels.
    for (const leg of legs) if (leg.press !== null && !onScreen(ctx, leg.stop.layer, leg.press))
      throw new Error(`cursor: ${leg.stop.layer} is not on screen at ${leg.press} s; start the cursor after it appears.`);
    const last = legs.at(-1);
    // The last click or drop must finish inside the scene.
    const done = round((last.press ?? last.arrive) + LAG + 0.05 + RELEASE);
    if (done > ctx.sceneDuration) throw new Error(`cursor needs the scene to last to ${done} s (it ends at ${ctx.sceneDuration} s); start it earlier, use fewer stops, or retime the scene.`);
    const fadeAt = round(time + (input.hold ?? 0.6));
    const end = round(Math.min(ctx.sceneDuration, fadeAt + 0.2));

    // The pointer: a group whose hotspot (HOT units in) rides the legs, one path per shape used.
    const place = (spot) => ({ x: round(spot.x - HOT[0] * k, 1), y: round(spot.y - HOT[1] * k, 1) });
    const group = ctx.add("pointer", createLayer("group", { ...place(start), width: round(BOX[0] * k, 1), height: round(BOX[1] * k, 1), role: "ui", allowOverlap: true }), "top");
    const used = new Set([travelShape, ...(dragging ? ["grab"] : [])]);
    const shapes = {};
    for (const name of used) {
      const shape = SHAPES[name];
      const width = round(BOX[0] * k + 2 * k, 1);
      shapes[name] = ctx.add(name, createLayer("path", {
        x: round((HOT[0] - shape.hot[0]) * k, 1), y: round((HOT[1] - shape.hot[1]) * k, 1), width, height: round(size, 1),
        path: cursorPath(name, size), pathBounds: { x: 0, y: 0, width, height: round(size, 1) },
        fill: shape.fill, stroke: shape.stroke, strokeWidth: round(Math.max(1, 1.25 * k), 2), role: "ui", allowOverlap: true,
        shadow: { color: "#00000066", x: 0, y: round(size * 0.05, 1), blur: round(size * 0.16, 1) },
      }), "top", group);
    }
    // Only one shape shows at a time.
    for (const name of used) if (name !== travelShape) ctx.animate(shapes[name], "start-hidden", hide(ctx.start));
    ctx.animate(group, "in", motion({ name: "Pointer in", kind: "in", start: ctx.start, duration: appear, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));

    const cues = [];
    let pressCount = 0;
    legs.forEach((leg, index) => {
      const from = place(leg.from);
      const to = place(leg.to);
      // Two axes, two curves: the path bows instead of running straight.
      if (to.x !== from.x) ctx.animate(group, `leg${index + 1}-x`, motion({ name: "Glide", start: leg.start, duration: leg.travel, easing: LEAD, from: { x: from.x }, to: { x: to.x } }));
      if (to.y !== from.y) ctx.animate(group, `leg${index + 1}-y`, motion({ name: "Glide", start: leg.start, duration: leg.travel, easing: TRAIL, from: { y: from.y }, to: { y: to.y } }));
      if (leg.press === null) return;
      pressCount += 1;
      const grabs = dragging && index === 0;
      if (!ctx.reduced) {
        ctx.animate(group, `press${pressCount}`, motion({ name: "Press", start: leg.press, duration: PRESS, easing: CURVES.arrive, from: { scaleX: 1, scaleY: 1 }, to: { scaleX: SQUISH, scaleY: SQUISH } }));
        if (!grabs) ctx.animate(group, `release${pressCount}`, motion({ name: "Release", start: leg.press + PRESS, duration: RELEASE, easing: CURVES.settle, from: { scaleX: SQUISH, scaleY: SQUISH }, to: { scaleX: 1, scaleY: 1 } }));
      }
      if (grabs) {
        ctx.animate(shapes[travelShape], "grab-hide", hide(leg.press));
        ctx.animate(shapes.grab, "grab-show", show(leg.press));
      } else if (!ctx.reduced) {
        // The button presses in and springs back, about its own center.
        const state = ctx.partStateAt(leg.stop.layer, leg.press);
        const [sx, sy] = [state.scaleX ?? 1, state.scaleY ?? 1];
        ctx.animate(leg.stop.layer, `press${pressCount}`, motion({ name: "Pressed", start: leg.press, duration: PRESS, easing: CURVES.arrive, from: { scaleX: sx, scaleY: sy }, to: { scaleX: round(sx * PUSH, 4), scaleY: round(sy * PUSH, 4) } }), "target");
        ctx.animate(leg.stop.layer, `release${pressCount}`, motion({ name: "Released", start: leg.press + PRESS, duration: RELEASE, easing: CURVES.fade, from: { scaleX: round(sx * PUSH, 4), scaleY: round(sy * PUSH, 4) }, to: { scaleX: sx, scaleY: sy } }), "target");
      }
      cues.push({ name: pressCount === 1 ? `${ctx.id}.${grabs ? "grab" : "click"}` : `${ctx.id}.click${pressCount}`, time: leg.press });
    });

    if (dragging) {
      // The dragged layer lifts 3%, follows each leg a beat behind, and settles at the drop.
      const layerId = legs[0].stop.layer;
      const grabbed = ctx.partStateAt(layerId, legs[0].press);
      const [sx, sy] = [grabbed.scaleX ?? 1, grabbed.scaleY ?? 1];
      const lifted = { scaleX: round(sx * LIFT, 4), scaleY: round(sy * LIFT, 4) };
      ctx.animate(layerId, "lift", motion({ name: "Lift", start: legs[0].press, duration: PRESS + RELEASE, easing: CURVES.settle, from: { scaleX: sx, scaleY: sy }, to: lifted }), "drag");
      let offset = { x: grabbed.x, y: grabbed.y };
      legs.slice(1).forEach((leg, index) => {
        // The pointer moves in scene pixels; inside a scaled group the layer moves in its group's units.
        const { scale } = screenBox(ctx, layerId, leg.arrive);
        const next = { x: round(offset.x + (leg.to.x - leg.from.x) / scale.x, 1), y: round(offset.y + (leg.to.y - leg.from.y) / scale.y, 1) };
        if (next.x !== offset.x) ctx.animate(layerId, `follow${index + 1}-x`, motion({ name: "Follow", start: leg.start + LAG, duration: leg.travel, easing: LEAD, from: { x: offset.x }, to: { x: next.x } }), "drag");
        if (next.y !== offset.y) ctx.animate(layerId, `follow${index + 1}-y`, motion({ name: "Follow", start: leg.start + LAG, duration: leg.travel, easing: TRAIL, from: { y: offset.y }, to: { y: next.y } }), "drag");
        offset = next;
      });
      // The lifted layer rides above what it crosses: the highest neighbor in its group that
      // overlaps its way from grab to drop (a full-size backdrop or overlay is left where it is).
      const sweep = { x: Math.min(grabbed.x, offset.x), y: Math.min(grabbed.y, offset.y), width: Math.abs(offset.x - grabbed.x) + grabbed.width, height: Math.abs(offset.y - grabbed.y) + grabbed.height };
      const parent = ctx.parents(layerId)[0];
      const room = parent ? ctx.partStateAt(parent.id, legs[0].press) : ctx.frame;
      const crossed = ctx.siblings(layerId).filter((other) => {
        const box = ctx.partStateAt(other.id, legs[0].press);
        return !(box.width >= room.width * 0.9 && box.height >= room.height * 0.9) && overlaps(sweep, box);
      }).at(-1);
      if (crossed && ctx.order(crossed.id) > ctx.order(layerId)) ctx.raise(layerId, crossed.id);
      const drop = round(last.arrive + LAG + 0.05);
      ctx.animate(layerId, "drop", motion({ name: "Drop", start: drop, duration: RELEASE, easing: CURVES.settle, from: lifted, to: { scaleX: sx, scaleY: sy } }), "drag");
      if (!ctx.reduced) ctx.animate(group, "drop", motion({ name: "Let go", start: drop, duration: RELEASE, easing: CURVES.settle, from: { scaleX: SQUISH, scaleY: SQUISH }, to: { scaleX: 1, scaleY: 1 } }));
      ctx.animate(shapes.grab, "drop-hide", hide(drop));
      ctx.animate(shapes[travelShape], "drop-show", show(drop));
      cues.push({ name: `${ctx.id}.drop`, time: drop });
      ctx.note(`${layerId} is dragged to ${last.to.x}, ${last.to.y} and dropped at ${drop} s`);
    }

    if (end < ctx.sceneDuration - 1e-6) {
      ctx.animate(group, "out", motion({ name: "Pointer out", kind: "out", start: fadeAt, duration: 0.2, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(group, "gone", hide(end));
    }
    ctx.note(`the pointer reaches ${last.stop.layer ?? `${last.to.x}, ${last.to.y}`} at ${last.arrive} s`);
    return { end, cues };
  },
};
