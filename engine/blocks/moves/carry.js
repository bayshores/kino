// carry: one thing becomes the next shot (an app tile becomes a circle becomes a pill, a card
// shrinks into a phone's screen). Good launch films never cut between ideas: the shape of one
// shot travels into the shape of the next.
//
// The math is one carried box that travels from the first layer (or a part of it, fromRect) to
// the second (or a part of it, toRect) on one expo-out curve. Both layers ride that box at once:
// a shape (rectangle, ellipse) is resized to it, so its corners stay round and its fill and
// corner radius turn into the target's; anything else (a picture, a group, text) is scaled
// evenly about its center so the box fits it. In the middle third the target fades in over the
// first (a crossfade of contents with no dip), and the first fades away in the last third.
// With toRect the first stays inside the target (a card in a phone's screen), on top of it.
// A later carry out of that target takes the landed card along (it rides the same box), so the
// card never stays behind at full size.
import { enabledAnimations } from "../../animationEnabled.js";
import { CURVES, hide, motion, round } from "./kit.js";

const SHAPES = new Set(["rectangle", "ellipse"]);
const FILLED = new Set(["rectangle", "ellipse", "star", "path"]);
const solid = (layer) => (FILLED.has(layer.type) && layer.fillEnabled !== false && typeof layer.fill === "string" ? layer.fill : null);

// The part `rect` ([x, y, w, h] in % of the box) of a box on screen.
function partOf(box, rect) {
  const [rx, ry, rw, rh] = rect ?? [0, 0, 100, 100];
  return { x: box.x + (box.width * rx) / 100, y: box.y + (box.height * ry) / 100, width: (box.width * rw) / 100, height: (box.height * rh) / 100 };
}

// The values that put a layer's part `rect` on the carried `box`. A shape with no part is
// resized to the box (radius and fill stay drawable); anything else keeps its size and is
// scaled evenly about its center (the part's two scales averaged, so a phone never stretches).
function ride(layer, state, rect, box) {
  const sx = Math.abs(state.scaleX ?? 1) || 1;
  const sy = Math.abs(state.scaleY ?? 1) || 1;
  if (SHAPES.has(layer.type) && !rect) {
    const width = box.width / sx;
    const height = box.height / sy;
    return { x: round(box.x + box.width / 2 - width / 2, 1), y: round(box.y + box.height / 2 - height / 2, 1), width: round(width, 1), height: round(height, 1) };
  }
  const [rx, ry, rw, rh] = rect ?? [0, 0, 100, 100];
  const { width, height } = state;
  const scale = Math.sqrt((box.width / ((width * rw) / 100)) * (box.height / ((height * rh) / 100)));
  // The part's center in the layer's own box, and where it must be on screen.
  const u = (width * (rx + rw / 2)) / 100;
  const v = (height * (ry + rh / 2)) / 100;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { x: round(cx - width / 2 - (u - width / 2) * scale, 1), y: round(cy - height / 2 - (v - height / 2) * scale, 1), scaleX: round(scale, 4), scaleY: round(scale, 4) };
}

// The layer carry lands on: a top-level layer, or a split_image piece (a clipping group) inside
// a group, whose box on screen is the target. The piece's groups must hold still and unscaled
// through the carry, so its own x and y are its place on screen less their offset. Any other
// layer inside a group names the group and the toRect that lands on the part.
function landing(ctx, input) {
  const { layer, top, box } = ctx.inside(input.to, "to");
  const parents = ctx.parents(layer.id);
  // The top group and the toRect that lands on the layer's place in it.
  const onTop = () => {
    const outer = parents.at(-1);
    const rect = [box.x / outer.width, box.y / outer.height, box.width / outer.width, box.height / outer.height].map((value) => round(value * 100, 1));
    return `give to: "${top}" with toRect: [${rect.join(", ")}] (where ${input.to} sits in it)`;
  };
  if (!parents.length || !(layer.type === "group" && layer.clipContent === true)) {
    try {
      return { layer: ctx.layer(input.to, "to"), offset: { x: 0, y: 0 }, holder: null };
    } catch (error) {
      if (!parents.length) throw error;
      throw new Error(`carry to: ${input.to} is inside the group ${top}; ${onTop()}, or carry onto a split_image piece.`);
    }
  }
  const offsetAt = (time) => {
    let [x, y] = [0, 0];
    for (const parent of parents) {
      const state = ctx.partStateAt(parent.id, time);
      if (Math.abs((state.scaleX ?? 1) - 1) > 1e-3 || Math.abs((state.scaleY ?? 1) - 1) > 1e-3 || Math.abs(state.rotation ?? 0) > 1e-3)
        throw new Error(`carry to: ${input.to} is inside ${parent.id}, which is scaled or turned at ${round(time, 2)} s (ui-plane, frame); carry before it changes, or ${onTop()}.`);
      [x, y] = [x + state.x, y + state.y];
    }
    return { x, y };
  };
  const [first, last] = [offsetAt(ctx.start), offsetAt(ctx.end)];
  if (Math.abs(first.x - last.x) > 0.5 || Math.abs(first.y - last.y) > 0.5)
    throw new Error(`carry to: ${input.to} is inside ${top}, which moves during the carry; carry after it settles, or ${onTop()}.`);
  ctx.note(`to: ${input.to}, a piece inside ${top}, lands at its place on screen`);
  return { layer, offset: last, holder: ctx.layer(top, "to") };
}

export const carry = {
  name: "carry",
  about: "one layer becomes the next: its box, corner radius, fill and turn travel into the second layer's on one fast-then-soft curve while their contents crossfade in the middle third",
  fits: "one idea into the next, no cut",
  tags: ["match-cut"],
  length: 0.5,
  shortest: 0.2,
  fields: {
    from: { kind: "layer", required: true, about: "the layer the shot starts on" },
    to: { kind: "layer", required: true, about: "the layer it becomes (hidden until the carry; its radius, fill and turn are where it lands); a split_image piece inside a group lands at its place on screen" },
    fromRect: { kind: "box", about: "[x, y, width, height] in % of from: the part that is carried (default the whole layer); from zooms with it" },
    toRect: { kind: "box", about: "[x, y, width, height] in % of to: where it lands, such as a phone's screen (default the whole layer); from stays there on top, and a later carry out of to takes it along" },
  },
  example: { from: "app-card", to: "phone", toRect: [6, 12, 88, 40], at: 0.5 },
  setup: "app-card (a rectangle) and phone, a picture of a phone",
  build(ctx, input) {
    const a = ctx.layer(input.from, "from");
    const { layer: b, offset, holder } = landing(ctx, input);
    if (a.id === b.id) throw new Error("carry: from and to must be two layers.");
    const t0 = ctx.start;
    const d = ctx.duration;
    const stays = Boolean(input.toRect);
    const aState = ctx.stateAt(a.id, t0);
    const bState = ctx.partStateAt(b.id, ctx.end);
    // ctx.layer gives top-level layers only (a group when the layer is inside one), so both boxes
    // are in the scene's coordinates.
    const start = partOf(ctx.boxAt(a.id, t0), input.fromRect);
    const landed = ctx.boxAt(b.id, ctx.end);
    const end = partOf({ ...landed, x: landed.x + offset.x, y: landed.y + offset.y }, input.toRect);
    const bOpacity = bState.opacity ?? 1;
    // What stays on top: the first when it lands inside the second, else the second fades in over it.
    // A piece is drawn where its group is: the group is what goes above or below.
    const bTop = holder ?? b;
    if (stays && ctx.order(a.id) < ctx.order(bTop.id)) ctx.raise(a.id, bTop.id);
    if (!stays && ctx.order(bTop.id) < ctx.order(a.id)) ctx.raise(bTop.id, a.id);
    const heldInside = (layer) => enabledAnimations(layer.animations).some((step) => step?.kind === "hide" && step.start >= t0 - 1e-6 && step.start < ctx.end - 1e-6);
    if (ctx.reduced) {
      ctx.animate(b.id, "in", motion({ name: "Fade in", kind: "in", start: t0, duration: d, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: bOpacity } }), "to");
      if (!stays) {
        ctx.animate(a.id, "out", motion({ name: "Fade out", start: t0, duration: d, easing: CURVES.fade, from: { opacity: aState.opacity ?? 1 }, to: { opacity: 0 } }), "from");
        ctx.animate(a.id, "hide", hide(ctx.end), "from");
      }
      else if (heldInside(a)) ctx.animate(a.id, "hide", hide(ctx.end), "from");
      return { end: ctx.end };
    }
    // The look that travels: the corner radius, fill and turn go from the first to the second.
    // With toRect the first keeps its own look inside the slot.
    const look = (layer, at) => {
      const values = {};
      if (layer.type === "rectangle" && !(layer === b && input.toRect) && !(layer === a && input.fromRect)) {
        values.radius = round(at === "start" ? a.radius ?? 0 : stays ? a.radius ?? 0 : b.radius ?? 0, 1);
      }
      const [fromFill, toFill] = [solid(a), stays ? solid(a) : solid(b) ?? solid(a)];
      if (solid(layer) && fromFill && toFill && fromFill !== toFill) values.fill = at === "start" ? fromFill : toFill;
      return values;
    };
    const turn = (at) => ({ rotation: round(at === "start" ? aState.rotation ?? 0 : bState.rotation ?? 0, 2) });
    const turns = Math.abs((aState.rotation ?? 0) - (bState.rotation ?? 0)) > 0.01;
    // A piece rides in its group's coordinates: the boxes on screen less the group's offset.
    const local = (values, shift) => (shift ? { ...values, x: round(values.x - shift.x, 1), y: round(values.y - shift.y, 1) } : values);
    const path = (layer, state, rect, role, shift = null) => {
      const from = { ...local(ride(layer, state, rect, start), shift), ...look(layer, "start"), ...(turns ? turn("start") : {}) };
      const to = { ...local(ride(layer, state, rect, end), shift), ...look(layer, "end"), ...(turns ? turn("end") : {}) };
      ctx.animate(layer.id, "carry", motion({ name: "Carry", start: t0, duration: d, easing: CURVES.settle, from, to }), role);
    };
    path(a, aState, input.fromRect, "from");
    // Riders: layers an earlier carry landed inside the first (still shown, drawn above it, centered
    // in its box) travel with it: their centers keep their place in the carried box and they scale
    // with it, and they fade with it.
    const box = ctx.boxAt(a.id, t0);
    const k = Math.sqrt((end.width / start.width) * (end.height / start.height));
    const riders = ctx.topLayers().filter((layer) => layer.id !== a.id && layer.id !== b.id && layer.id !== bTop.id && ctx.order(layer.id) > ctx.order(a.id) && ctx.shownAt(layer.id, t0)
      && (layer.animations ?? []).some((entry) => entry.id.endsWith(".from-carry") && entry.start + entry.duration <= t0 + 1e-6)
      && (() => { const own = ctx.boxAt(layer.id, t0); const cx = own.x + own.width / 2, cy = own.y + own.height / 2; return cx > box.x && cx < box.x + box.width && cy > box.y && cy < box.y + box.height; })());
    for (const rider of riders) {
      const state = ctx.stateAt(rider.id, t0);
      const own = ctx.boxAt(rider.id, t0);
      const cx = end.x + end.width / 2 + (own.x + own.width / 2 - (start.x + start.width / 2)) * k;
      const cy = end.y + end.height / 2 + (own.y + own.height / 2 - (start.y + start.height / 2)) * k;
      const scale = (value) => round((value ?? 1) * k, 4);
      ctx.animate(rider.id, "ride", motion({ name: "Ride", start: t0, duration: d, easing: CURVES.settle,
        from: { x: state.x, y: state.y, scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1 },
        to: { x: round(cx - state.width / 2, 1), y: round(cy - state.height / 2, 1), scaleX: scale(state.scaleX), scaleY: scale(state.scaleY) } }), "from");
      if (!stays) {
        // The second fades in over the riders too.
        if (ctx.order(bTop.id) < ctx.order(rider.id)) ctx.raise(bTop.id, rider.id);
        ctx.animate(rider.id, "ride-out", motion({ name: "Crossfade out", start: t0 + (2 * d) / 3, duration: d / 3, easing: CURVES.fade, from: { opacity: state.opacity ?? 1 }, to: { opacity: 0 } }), "from");
        ctx.animate(rider.id, "ride-hide", hide(ctx.end), "from");
      }
    }
    if (riders.length) ctx.note(`${riders.map((layer) => layer.id).join(", ")} ride${riders.length === 1 ? "s" : ""} along (landed in ${a.id} by an earlier carry)`);
    path(b, bState, input.toRect, "to", holder ? offset : null);
    // With toRect the card stays, but a hold of its own that ends inside the carry would take it off
    // mid-carry: it stays to the carry's end instead (the hide keeps it shown until then, as for the
    // other moves), and a card whose hold ends later or earlier gets nothing.
    if (stays) {
      if (heldInside(a)) ctx.animate(a.id, "hide", hide(ctx.end), "from");
      for (const rider of riders) if (heldInside(rider)) ctx.animate(rider.id, "ride-hide", hide(ctx.end), "from");
    }
    // Contents crossfade in the middle third: the second fades in over (or under) the first.
    ctx.animate(b.id, "in", motion({ name: "Crossfade in", kind: "in", start: t0 + d / 3, duration: d / 3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: bOpacity } }), "to");
    if (!stays) {
      ctx.animate(a.id, "out", motion({ name: "Crossfade out", start: t0 + (2 * d) / 3, duration: d / 3, easing: CURVES.fade, from: { opacity: aState.opacity ?? 1 }, to: { opacity: 0 } }), "from");
      ctx.animate(a.id, "hide", hide(ctx.end), "from");
    }
    return { end: ctx.end };
  },
};
