// Product set pieces: window-punch-in, lift-focus and card-into-device. Timings and curves follow
// measured reference edits: entrances do most of their travel in the first 0.2 s and settle (expo-out,
// CURVES.settle), dims and blurs ease in and out (CURVES.whip), holds keep a slow push.
import { createLayer } from "../../model.js";
import { CURVES, boxOf, effect, frameShare, hide, motion, round } from "./kit.js";

// What a lifted or punched layer's place is when it is scaled by `scale` about its center so
// that its center lands on `center`.
const centered = (box, center, scale) => ({ x: round(center.x - box.width / 2, 1), y: round(center.y - box.height / 2, 1), scaleX: round(scale, 4), scaleY: round(scale, 4) });
const frameCenter = (frame) => ({ x: frame.width / 2, y: frame.height / 2 });
const NO_SHADOW = Object.freeze({ color: "#00000000", x: 0, y: 0, blur: 0 });
// The shadow the study measured (0 30 px 80 px at 50% at 1080p), in a layer's own pixels when
// it is drawn at `scale` (a shadow scales with its layer).
const softShadow = (ctx, scale, strength = 0.5) => ({ color: `#000000${Math.round(strength * 255).toString(16).padStart(2, "0").toUpperCase()}`, x: 0, y: round((30 * ctx.scale) / scale, 1), blur: round((80 * ctx.scale) / scale, 1) });

// ---- window-punch-in ------------------------------------------------------------------------
// The window grows from about 60% to 92% of the frame's width: 80% of the growth in the first
// 0.2 s, settled by 0.8 s, then a slow push of 2% a second. With beats it steps instead (about
// 1.5x a step, one on each beat). The accent glow is off unless asked for.
const PUNCH = 0.8;
const STEP = 0.45;

export const windowPunchIn = {
  name: "window-punch-in",
  about: "a product window or screen recording grows from about 60% to 92% of the frame's width, most of the way in the first 0.2 s, settles, then keeps pushing in slowly; it gets rounded corners and a soft shadow",
  fits: "showing the product: a screen recording, a site or an app window arriving big and alive",
  tags: ["screen-zoom", "slow-push"],
  length: 3,
  shortest: 1.2,
  fields: {
    layer: { kind: "layer", required: true, about: "the window: a screen recording, a screenshot or a group" },
    from: { kind: "number", low: 0.15, high: 0.9, about: "how wide it starts, a share of the frame's width (default 0.6; with beats, a third of size)" },
    size: { kind: "number", low: 0.4, high: 1, about: "how wide it ends (default 0.92); a tall window stops at that share of the height" },
    beats: { kind: "times", most: 4, about: "stepped: scene seconds of more steps after at; it jumps about 1.5x on each instead of one grow" },
    glow: { kind: "number", low: 0, high: 1, about: "an accent glow around the window that switches on at peak speed (default 0: off)" },
  },
  example: { layer: "shot-b", at: 0 },
  setup: "shot-b, a picture or video of a product window or page",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const state = ctx.stateAt(layer.id, ctx.start);
    const box = { width: state.width, height: state.height };
    const hits = [ctx.start, ...(input.beats ?? []).slice().sort((a, b) => a - b)];
    for (let index = 1; index < hits.length; index += 1) {
      if (hits[index] - hits[index - 1] < 0.3) throw new Error(`window-punch-in: beats at ${hits[index - 1]} and ${hits[index]} s are closer than 0.3 s.`);
      if (hits[index] > ctx.end - 0.3) throw new Error(`window-punch-in: the beat at ${hits[index]} s is past the move's end (${ctx.end} s); give a longer dur.`);
    }
    const size = input.size ?? 0.92;
    const from = input.from ?? (hits.length > 1 ? size / 3 : 0.6);
    if (from >= size) throw new Error(`window-punch-in: from (${from}) must be smaller than size (${size}).`);
    // The scale at which the window is `share` of the frame's width (or of its height, for a tall one).
    const fit = (share) => Math.min((ctx.frame.width * share) / box.width, (ctx.frame.height * share) / box.height);
    const last = fit(size);
    const middle = frameCenter(ctx.frame);
    const end = centered(box, middle, last);
    // Corners of 1.5% of the frame's width and the soft shadow, on screen at the end size.
    const rounds = ["image", "video", "rectangle"].includes(layer.type);
    const frameLook = {
      ...(rounds ? { radius: Math.max(layer.radius ?? 0, Math.round((0.015 * ctx.frame.width) / last)) } : {}),
      shadow: softShadow(ctx, last),
    };
    ctx.animate(layer.id, "frame", motion({ name: "Corners and shadow", start: ctx.start, duration: 0.3, easing: CURVES.fade,
      from: { ...(rounds ? { radius: layer.radius ?? 0 } : {}), shadow: layer.shadow ?? NO_SHADOW }, to: frameLook }), "layer");
    // It appears with the punch unless it is on screen already (then it grows from where it is).
    const shown = ctx.start > 0.05 && ctx.shownAt(layer.id, ctx.start - 0.05);
    const opacity = state.opacity ?? 1;
    if (ctx.reduced) {
      if (shown) ctx.animate(layer.id, "settle", motion({ name: "Settle", start: ctx.start, duration: 0.6, easing: CURVES.drift,
        from: { x: state.x, y: state.y, scaleX: state.scaleX, scaleY: state.scaleY }, to: end }), "layer");
      else ctx.animate(layer.id, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.5, easing: CURVES.fade, from: { opacity: 0, ...end }, to: { opacity, ...end } }), "layer");
      return { end: ctx.end, tags: ["screen-zoom"] };
    }
    if (!shown) ctx.animate(layer.id, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.15, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity } }), "layer");
    // On screen and smaller than the end size: it grows from where it is. As big already: it
    // starts again small (a cut), so the move is still a punch in.
    const grows = shown && state.scaleX < last * 0.95;
    if (shown && !grows) ctx.note(`${layer.id} is on screen as big before; it cuts to ${Math.round(from * 100)}% and punches in (start the move when it first shows to avoid the cut)`);
    const first = grows ? { x: state.x, y: state.y, scaleX: state.scaleX, scaleY: state.scaleY } : centered(box, middle, fit(from));
    // One grow, or a step on each hit: equal ratios from the first size to the last.
    const moves = [];
    hits.forEach((time, index) => {
      const share = hits.length === 1 ? 1 : (index + 1) / hits.length;
      const to = index === hits.length - 1 ? end : centered(box, middle, first.scaleX * (last / first.scaleX) ** share);
      const duration = hits.length === 1 ? PUNCH : Math.min(STEP, (hits[index + 1] ?? ctx.end) - time - 0.05);
      moves.push({ name: hits.length === 1 ? "punch" : `step${index + 1}`, start: time, duration, from: index ? moves[index - 1].to : first, to });
    });
    const settled = moves.at(-1).start + moves.at(-1).duration;
    // Then a slow push, 2% a second, about the center, until the move ends.
    const push = ctx.end - settled >= 0.5 ? round(last * (1 + 0.02 * (ctx.end - settled)), 4) : null;
    const glow = input.glow ?? 0;
    const halo = glow > 0
      ? ctx.add("glow", createLayer("rectangle", {
        name: "Glow", x: layer.x, y: layer.y, width: box.width, height: box.height, radius: frameLook.radius ?? 0, fill: ctx.style.colors.accent,
        blur: Math.round((70 * ctx.scale) / last), opacity: 0, role: "decor", allowOverlap: true,
      }), { below: layer.id })
      : null;
    for (const [target, role] of [[layer.id, "layer"], ...(halo ? [[halo, null]] : [])]) {
      for (const step of moves) ctx.animate(target, step.name, motion({ name: step.name === "punch" ? "Punch in" : "Step in", start: step.start, duration: step.duration, easing: CURVES.settle, from: step.from, to: step.to }), role);
      if (push) ctx.animate(target, "push", motion({ name: "Slow push", start: settled, duration: ctx.end - settled, easing: CURVES.drift, from: { scaleX: last, scaleY: last }, to: { scaleX: push, scaleY: push } }), role);
    }
    // The glow switches on at the punch's peak speed (40% into its first move) over 0.15 s.
    if (halo) ctx.animate(halo, "on", motion({ name: "Glow on", start: ctx.start + moves[0].duration * 0.4, duration: 0.15, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: round(0.7 * glow) } }));
    if (!push) ctx.note("no slow push: the move ends as the window settles");
    return { end: ctx.end };
  },
};

// ---- lift-focus ----------------------------------------------------------------------------
// The detail grows out of its place to about a third of the frame's width at the center in
// 0.6 s (expo-out) while everything behind it dims to a quarter and blurs about 11 px over 1 s
// (in-out); it pushes in slowly while it is up, and at the end everything goes back.
const GROW = 0.6;
const DIM = 1;
const SHARP = 1.9;
// The uploaded file behind a picture layer (its pixel size), or null when it is not known.
function fileOf(ctx, src) {
  try { return ctx.picture(src); } catch { return null; }
}
const BACK = 0.6;

export const liftFocus = {
  name: "lift-focus",
  about: "one detail (a layer, or a part of a picture) lifts out of its place and grows to about a third of the frame's width in the middle while everything behind it dims to a quarter and softens; at the end it goes back",
  fits: "pointing at one thing in a busy UI, page or shot: a card, a button, a number, a face",
  tags: ["screen-zoom", "depth-blur"],
  length: 3,
  shortest: 1.8,
  fields: {
    detail: { kind: "target", required: true, about: "{layer, rect?}: the layer to lift, or the part rect ([x, y, w, h] in % of it) of a picture, video or shape, which is copied and lifted" },
    size: { kind: "number", low: 0.15, high: 0.8, about: "how wide it gets, a share of the frame's width (default 0.3; 0.6 in a tall frame); at most 60% of the height" },
  },
  example: { detail: { layer: "shot-b", rect: [42, 52, 16, 26] }, at: 0.3 },
  setup: "shot-b, a picture of a page or UI (the example lifts the round badge on it)",
  build(ctx, input) {
    const { layer: source, top, box: inner } = ctx.inside(input.detail.layer, "detail");
    if (source.type === "audio") throw new Error("lift-focus detail: give a layer that is drawn.");
    const own = !input.detail.rect && !source.parentId;
    if (!own && source.type === "group") throw new Error("lift-focus detail: a part of a group cannot be copied; give a layer inside it (a picture, video or shape) or the whole group without rect.");
    const holder = ctx.layer(top, "detail");
    // Where the detail is on screen when the move starts.
    let place;
    if (source.parentId) {
      const at = ctx.boxAt(holder.id, ctx.start);
      const scale = at.width / holder.width;
      place = { x: at.x + inner.x * scale, y: at.y + inner.y * scale, width: source.width * scale, height: source.height * scale };
    } else place = ctx.boxAt(source.id, ctx.start);
    const [rx, ry, rw, rh] = input.detail.rect ?? [0, 0, 100, 100];
    const region = { x: place.x + (place.width * rx) / 100, y: place.y + (place.height * ry) / 100, width: (place.width * rw) / 100, height: (place.height * rh) / 100 };
    const size = input.size ?? (ctx.portrait ? 0.6 : 0.3);
    let grow = Math.min((ctx.frame.width * size) / region.width, (ctx.frame.height * 0.6) / region.height);
    // A detail that is big already still lifts a little, never shrinks (and stays inside the frame).
    if (grow < 1.1) grow = Math.max(1, Math.min(1.1, (ctx.frame.width * 0.95) / region.width, (ctx.frame.height * 0.95) / region.height));
    // A picture is never drawn past about 1.9x its file's pixels (it would look soft).
    const file = source.type === "image" ? fileOf(ctx, source.src) : null;
    if (file) {
      const drawn = Math.max(place.width / file.width, place.height / file.height);
      const most = Math.max(1, SHARP / drawn);
      if (grow > most) { ctx.note(`grows only ${round(most, 2)}x: ${source.id}'s file is ${file.width}x${file.height} and would look soft bigger`); grow = most; }
    }
    if (grow < 1.15) ctx.note(`the detail is already ${Math.round((100 * region.width) / ctx.frame.width)}% of the frame's width; it grows only ${round(grow, 2)}x`);
    const exitAt = ctx.end - BACK;
    const middle = frameCenter(ctx.frame);

    // What everything behind does: a dark veil fades over it and each picture behind softens.
    const behind = ctx.topLayers().filter((layer) => (own ? layer.id !== source.id : true) && ctx.shownAt(layer.id, ctx.start));
    const topmost = ctx.topLayers().at(-1);
    if (own && topmost && topmost.id !== source.id) ctx.raise(source.id, topmost.id);
    const veil = ctx.add("dim", createLayer("rectangle", { name: "Dim", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill: "#0B0B0C", opacity: 0, role: "decor", allowOverlap: true }),
      own ? { below: source.id } : "top");
    ctx.animate(veil, "in", motion({ name: "Dim", start: ctx.start, duration: DIM, easing: CURVES.whip, from: { opacity: 0 }, to: { opacity: 0.75 } }));
    ctx.animate(veil, "out", motion({ name: "Undim", start: exitAt, duration: BACK, easing: CURVES.whip, from: { opacity: 0.75 }, to: { opacity: 0 } }));
    ctx.animate(veil, "hide", hide(ctx.end));
    if (!ctx.reduced) {
      const soft = Math.round(11 * ctx.scale);
      behind.forEach((layer, index) => {
        const rest = layer.blur ?? 0;
        ctx.animate(layer.id, "soften", motion({ name: "Soften", start: ctx.start, duration: DIM, easing: CURVES.whip, from: { blur: rest }, to: { blur: rest + soft } }), `back${index + 1}`);
        ctx.animate(layer.id, "sharpen", motion({ name: "Sharpen", start: exitAt, duration: BACK, easing: CURVES.whip, from: { blur: rest + soft }, to: { blur: rest } }), `back${index + 1}`);
        // A picture that fills the frame mirrors past its edges while soft, so no rim shows.
        if (frameShare(boxOf(layer), ctx.frame) > 0.9) ctx.animate(layer.id, "edges", effect({ name: "Edge fill", effect: "edge-fill", start: ctx.start, duration: ctx.duration, easing: CURVES.drift, to: { mode: "mirror", extend: 0.25 }, keepStill: "off" }), `back${index + 1}`);
      });
    }

    // The detail itself: your layer, or a copy of the part in a rounded, clipped card.
    let targets;
    let base;
    let from;
    if (own) {
      const state = ctx.stateAt(source.id, ctx.start);
      base = { width: state.width, height: state.height };
      from = { x: state.x, y: state.y, scaleX: state.scaleX, scaleY: state.scaleY };
      targets = [[source.id, "detail"]];
      if (ctx.reduced) {
        ctx.note("reduced motion: the detail stays in place while the rest dims");
        return { end: ctx.end, tags: ["depth-blur"] };
      }
      ctx.animate(source.id, "shadow", motion({ name: "Lift shadow", start: ctx.start, duration: GROW, easing: CURVES.settle, from: { shadow: source.shadow ?? NO_SHADOW }, to: { shadow: softShadow(ctx, from.scaleX * grow, 0.6) } }), "detail");
      ctx.animate(source.id, "drop", motion({ name: "Drop shadow", start: exitAt, duration: BACK, easing: CURVES.fly, from: { shadow: softShadow(ctx, from.scaleX * grow, 0.6) }, to: { shadow: source.shadow ?? NO_SHADOW } }), "detail");
    } else {
      base = { width: region.width, height: region.height };
      from = { x: region.x, y: region.y, scaleX: 1, scaleY: 1 };
      const radius = Math.round(0.04 * region.width);
      const plate = ctx.add("shadow", createLayer("rectangle", { name: "Shadow", ...from, ...base, radius, fill: "#000000", opacity: 0, shadow: softShadow(ctx, grow, 0.6), role: "decor", allowOverlap: true }));
      const card = ctx.add("card", createLayer("group", { name: "Detail", ...from, ...base, clipContent: true, radius, opacity: 0, role: "decor", allowOverlap: true }));
      // The copy keeps the source's look and media (a clip plays in step, silent).
      const { id: _id, name: _name, parentId: _parent, animations: _animations, move: _move, recipe: _recipe, ...look } = source;
      ctx.add("copy", createLayer(source.type, {
        ...look, x: round(place.x - region.x, 1), y: round(place.y - region.y, 1), width: place.width, height: place.height, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
        ...(source.type === "video" ? { volume: 0 } : {}), role: "decor", allowOverlap: true,
      }), "top", card);
      // It shows over the original the moment it starts to lift, and goes when it is back.
      for (const layer of [plate, card]) {
        if (!ctx.reduced) ctx.animate(layer, "show", motion({ name: "Show", kind: "in", start: ctx.start, duration: 0.05, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
        ctx.animate(layer, "hide", hide(ctx.end));
      }
      targets = [[plate, null], [card, null]];
      // Its shadow fades as it goes back, so it lands flush with the original.
      if (!ctx.reduced) ctx.animate(plate, "drop", motion({ name: "Shadow off", start: exitAt, duration: BACK, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
    }
    const up = centered(base, middle, from.scaleX * grow);
    const pushed = { scaleX: round(up.scaleX * 1.03, 4), scaleY: round(up.scaleY * 1.03, 4) };
    for (const [target, role] of targets) {
      if (ctx.reduced) {
        // Calm: the copy fades in already up and fades out again.
        ctx.animate(target, "up", motion({ name: "Up", start: ctx.start, duration: 0.05, easing: CURVES.fade, from: up, to: up }), role);
        ctx.animate(target, "fade", motion({ name: "Fade in", start: ctx.start, duration: 0.4, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), role);
        ctx.animate(target, "out", motion({ name: "Fade out", start: exitAt, duration: BACK, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), role);
        continue;
      }
      ctx.animate(target, "lift", motion({ name: "Lift", start: ctx.start, duration: GROW, easing: CURVES.settle, from, to: up }), role);
      ctx.animate(target, "push", motion({ name: "Slow push", start: ctx.start + GROW, duration: exitAt - ctx.start - GROW, easing: CURVES.drift, from: { scaleX: up.scaleX, scaleY: up.scaleY }, to: pushed }), role);
      ctx.animate(target, "back", motion({ name: "Back", start: exitAt, duration: BACK, easing: CURVES.fly, from: { ...up, ...pushed }, to: from }), role);
    }
    return { end: ctx.end, ...(ctx.reduced ? { tags: ["depth-blur"] } : {}) };
  },
};

// ---- card-into-device --------------------------------------------------------------------------
// A big card, leaning a few degrees, turns flat over 0.5 s
// (in-out) and gains a thin light frame; then it shrinks about 3x in 0.6 s (expo-out) onto its
// slot in a phone's screen while the phone fades in around it. Speed streaks are off unless asked.
const TURN_AT = 0.4;
const TURN = 0.5;
const LAND_AT = 1.1;
const LAND = 0.6;
const DENSITY = 160;

export const cardIntoDevice = {
  name: "card-into-device",
  about: "a big card or picture, turned a little away, turns flat with a thin light frame, then shrinks about 3x into its slot on a phone's screen while the phone fades in around it",
  fits: "taking a picture or result into the app: a photo becoming a post, a result landing in the UI",
  tags: ["device-in-scene"],
  length: 2.4,
  shortest: 1.8,
  fields: {
    into: { kind: "target", required: true, about: "{layer, rect?}: the slot: a phone or its screen (a layer inside its group too) and the part rect ([x, y, w, h] in % of it); default the whole layer" },
    picture: { kind: "picture", about: "an uploaded picture or clip to make the card from (cropped to the slot's shape)" },
    card: { kind: "layer", about: "your card layer instead (it lands as big as fits the slot)" },
    tilt: { kind: "number", low: 0, high: 15, about: "degrees the card leans at first (default 5; 0: flat)" },
    device: { kind: "choice", values: ["appear", "there"], about: "appear: the phone fades in around the card as it lands (default); there: it is on screen already" },
    streaks: { kind: "number", low: 0, high: 1, about: "speed streaks that burst behind the phone as the card lands (default 0: off)" },
  },
  oneOf: [["picture", "card"]],
  example: { into: { layer: "phone", rect: [7, 19, 86, 34] }, picture: "screen-a", at: 0.3 },
  setup: "phone, a picture of a phone screen, and an uploaded picture named screen-a",
  build(ctx, input) {
    const { top, box: inner } = ctx.inside(input.into.layer, "into");
    const device = ctx.layer(top, "into");
    const at = ctx.boxAt(device.id, ctx.start);
    const deviceScale = at.width / device.width;
    const [rx, ry, rw, rh] = input.into.rect ?? [0, 0, 100, 100];
    const slot = {
      x: at.x + (inner.x + (inner.width * rx) / 100) * deviceScale, y: at.y + (inner.y + (inner.height * ry) / 100) * deviceScale,
      width: (inner.width * rw * deviceScale) / 100, height: (inner.height * rh * deviceScale) / 100,
    };
    const slotCenter = { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 };
    let card;
    let target;
    let role = null;
    let land;
    if (input.card) {
      card = ctx.layer(input.card, "card");
      if (card.id === device.id) throw new Error("card-into-device: card and into must be two layers.");
      if (ctx.order(card.id) < ctx.order(device.id)) ctx.raise(card.id, device.id);
      land = Math.min(slot.width / card.width, slot.height / card.height);
      target = card.id;
      role = "card";
    } else {
      const picture = ctx.picture(input.picture);
      // The card has the slot's shape; the picture fills it, cropped.
      card = ctx.add("card", createLayer(picture.duration ? "video" : "image", {
        name: "Card", src: picture.src, ...(picture.duration ? { mediaSourceDuration: picture.duration, volume: 0 } : {}),
        x: round(slot.x, 1), y: round(slot.y, 1), width: round(slot.width, 1), height: round(slot.height, 1), radius: Math.round(Math.min(slot.width, slot.height) * 0.06),
        stroke: "#FFFFFF", strokeWidth: 0, role: "decor", allowOverlap: true,
      }));
      land = 1;
      target = card;
    }
    const box = { width: card.width, height: card.height };
    const middle = frameCenter(ctx.frame);
    const big = Math.min((ctx.frame.width * (ctx.portrait ? 0.85 : 0.6)) / box.width, (ctx.frame.height * 0.62) / box.height);
    const landed = centered(box, slotCenter, land);
    const t0 = ctx.start;
    const appear = (input.device ?? "appear") === "appear";
    const deviceState = ctx.stateAt(device.id, ctx.start);
    if (ctx.reduced) {
      ctx.animate(target, "in", motion({ name: "Fade in", kind: "in", start: t0, duration: 0.5, easing: CURVES.fade, from: { opacity: 0, ...landed }, to: { opacity: 1, ...landed } }), role);
      if (appear) ctx.animate(device.id, "in", motion({ name: "Fade in", kind: "in", start: t0, duration: 0.5, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: deviceState.opacity ?? 1 } }), "device");
      return { end: round(Math.max(ctx.end, t0 + 0.6)), tags: ["device-in-scene"] };
    }
    const tilt = input.tilt ?? 5;
    const shown = centered(box, middle, big);
    const drifted = centered(box, middle, big * 1.02);
    // 1. It arrives big in the middle, turned away, and drifts a little closer.
    ctx.animate(target, "in", motion({ name: "Arrive", kind: "in", start: t0, duration: 0.35, easing: CURVES.settle, from: { opacity: 0, ...centered(box, middle, big * 0.94) }, to: { opacity: 1, ...shown } }), role);
    ctx.animate(target, "drift", motion({ name: "Drift", start: t0 + 0.35, duration: LAND_AT - 0.35, easing: CURVES.drift, from: shown, to: drifted }), role);
    // 2. It turns flat and a thin light frame draws on. The turn is a lean in the picture's plane:
    // card-flip's 3D mesh draws seams across a picture and bulge makes its edges jagged.
    if (tilt > 0) {
      const rest = { rotation: card.rotation ?? 0 };
      const turned = { rotation: round(rest.rotation - tilt, 2) };
      const leaning = { rotation: round(rest.rotation - tilt * 0.85, 2) };
      ctx.animate(target, "tilt", motion({ name: "Turned away", kind: "in", start: t0, duration: TURN_AT, easing: CURVES.drift, from: turned, to: leaning }), role);
      ctx.animate(target, "turn", motion({ name: "Turn flat", start: t0 + TURN_AT, duration: TURN, easing: CURVES.whip, from: leaning, to: rest }), role);
    }
    const line = round((2 * ctx.scale) / big, 2);
    ctx.animate(target, "frame", motion({ name: "Frame", start: t0 + TURN_AT + 0.1, duration: 0.4, easing: CURVES.fade, from: { stroke: "#FFFFFF", strokeWidth: 0 }, to: { stroke: "#FFFFFF", strokeWidth: line } }), role);
    // 3. It shrinks onto its slot; the frame fades as it lands and the phone appears around it.
    const landAt = t0 + LAND_AT;
    ctx.animate(target, "land", motion({ name: "Into the slot", start: landAt, duration: LAND, easing: CURVES.settle, from: drifted, to: landed }), role);
    ctx.animate(target, "unframe", motion({ name: "Frame off", start: landAt, duration: 0.3, easing: CURVES.fade, from: { strokeWidth: line }, to: { stroke: card.stroke ?? "#FFFFFF", strokeWidth: card.strokeWidth ?? 0 } }), role);
    if (appear) {
      const near = centered({ width: deviceState.width, height: deviceState.height }, { x: deviceState.x + deviceState.width / 2, y: deviceState.y + deviceState.height / 2 }, deviceState.scaleX * 1.08);
      ctx.animate(device.id, "in", motion({ name: "Appear", kind: "in", start: landAt + 0.05, duration: LAND, easing: CURVES.settle,
        from: { opacity: 0, ...near }, to: { opacity: deviceState.opacity ?? 1, x: deviceState.x, y: deviceState.y, scaleX: deviceState.scaleX, scaleY: deviceState.scaleY } }), "device");
    }
    let end = Math.max(ctx.end, landAt + LAND);
    const streaks = input.streaks ?? 0;
    if (streaks > 0) {
      // Streaks burst from the slot as the card lands and die away over 1.5 s.
      const burstAt = landAt + 0.2;
      const lines = ctx.add("streaks", createLayer("rectangle", {
        name: "Streaks", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fillEnabled: false, strokeWidth: 0, blendMode: "add", role: "decor", allowOverlap: true,
      }), { below: device.id });
      ctx.animate(lines, "streaks", effect({ name: "Streaks", effect: "sparks", start: burstAt, duration: 1.5, easing: CURVES.fade, keepStill: "off", to: {
        count: Math.round(DENSITY * streaks), size: round(Math.max(1.5, 2.2 * ctx.scale), 1), speed: Math.round(3000 * ctx.scale), direction: 0, spread: 360, gravity: 0, wind: 0, turbulence: 0, lifetime: 0.7,
        color: "#FFFFFF", color2: ctx.style.colors.accent, opacity: 0.9, softness: 0.5, glow: 0.1, flicker: 0, trail: 0.5, emitter: "point",
        originX: round(slotCenter.x / ctx.frame.width), originY: round(slotCenter.y / ctx.frame.height), prewarm: false, seed: ctx.rng.pick([3, 7, 11, 19]), loop: 0,
      } }));
      ctx.animate(lines, "fade", motion({ name: "Die away", start: burstAt, duration: 1.5, easing: CURVES.leave, from: { opacity: 1 }, to: { opacity: 0 } }));
      ctx.animate(lines, "hide", hide(burstAt + 1.5));
      end = Math.max(end, burstAt + 1.5);
    }
    return { end: round(end), tags: streaks > 0 ? [...cardIntoDevice.tags, "speed-lines"] : cardIntoDevice.tags };
  },
};
