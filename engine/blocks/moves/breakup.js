// Moves that break the old shot apart on the way to the next: smear (the old shot's colors are
// dragged into streaks while the next shot's lines show through, a datamosh look) and shatter (the
// old shot breaks into shards of glass that carry its picture and fly apart).
// Both are built from kino's own parts: copies of the shots (as whip-pan's fillCorners copies
// them), directional-blur, fluid-warp, edge-fill, color-grade and rgb-shift effects, a group's
// frameRate (on twos), multiply blend, and path masks inside mask groups (split-screen's slanted
// panes). Defaults come from the transitions technique study (.scratch/studies/transitions,
// final.mjs hand-off 2 and its reference frames); a value marked "guess" is not from it.
import { createLayer } from "../../model.js";
import { effect, hide, motion, round, show } from "./kit.js";
import { crossFade, startClips } from "./transitions.js";
import { shared } from "../move.js";
import { seeded } from "../build.js";

// defaults:start
const DEFAULTS = Object.freeze({
  colors: Object.freeze({ mask: "#FFFFFF", edge: "#FFFFFF" }),
  curves: Object.freeze({
    fade: [0.33, 0, 0.67, 1],
    // The drag builds slowly, then pours (ease-in): the reference streaks are longest just before the landing.
    drag: [0.5, 0, 0.9, 0.7],
    // Shards burst out fast and keep going (guess: no reference frames of the break were saved).
    burst: [0.2, 0.6, 0.5, 1],
    settle: [0.16, 1, 0.3, 1],
  }),
});
// defaults:end
const CURVE = DEFAULTS.curves;

// A frame at the move's frame rate (the reference smear was held on twos at about 30 fps).
const SMEAR_FPS = 15;
const fileSecond = (layer, time) => Math.max(0, (layer.mediaOffset ?? 0) + (time - (layer.mediaStart ?? 0)) * (layer.mediaSpeed ?? 1));

/**
 * A copy of a picture or clip as a part of the move, drawn where `layer` is at the move's start,
 * playing in step with the clip from the move's start on (a held still read as frozen footage to
 * check, and the copy keeps the shot alive). Near the file's end it holds the last frame.
 */
function copyOf(ctx, part, layer, place, parent, { offset = { x: 0, y: 0 }, extra = {} } = {}) {
  if (!["video", "image"].includes(layer.type)) throw new Error(`${ctx.move}: ${layer.id} is a ${layer.type}; give a picture or a clip (a group cannot be copied).`);
  const state = ctx.stateAt(layer.id, ctx.start);
  const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, isMask: _mask, ...look } = layer;
  const video = layer.type === "video";
  const second = round(fileSecond(layer, ctx.start));
  const room = layer.mediaSourceDuration > 0 ? (layer.mediaSourceDuration - second) / (layer.mediaSpeed ?? 1) : Infinity;
  const timing = video ? { mediaStart: ctx.start, mediaOffset: second, volume: 0, mediaDuration: round(Math.max(0.04, Math.min(ctx.duration + 0.1, room))), mediaFreeze: "last" } : {};
  return ctx.add(part, createLayer(layer.type, {
    ...look, x: round(state.x - offset.x, 1), y: round(state.y - offset.y, 1), width: state.width, height: state.height,
    scaleX: state.scaleX ?? 1, scaleY: state.scaleY ?? 1, rotation: state.rotation ?? 0, opacity: 1, role: "decor", allowOverlap: true, ...timing, ...extra,
  }), place, parent);
}

// The parts go just above whichever shot is higher, so they cover both.
const aboveBoth = (ctx, from, to) => ({ above: ctx.order(to.id) > ctx.order(from.id) ? to.id : from.id });

function pair(ctx, input, name) {
  const from = ctx.layer(input.from, "from");
  const to = ctx.layer(input.to, "to");
  if (from.id === to.id) throw new Error(`${name} needs two different layers.`);
  return { from, to };
}

export const smear = {
  name: "smear",
  needsAt: true,
  about: "datamosh-look pixel drag: the old shot's colors drag into streaks under the next shot's lines, on twos, then it lands with flicks back",
  fits: "a glitch transition, a drop",
  tags: ["glitch-hit", "motion-blur"],
  // The reference smear ran 16 frames, then 8 frames of flicker between the next shot and the smear.
  length: 0.8,
  shortest: 0.3,
  fields: {
    from: { kind: "layer", required: true, about: "the shot whose colors are dragged (a picture or clip)" },
    to: { kind: "layer", required: true, about: "the shot that arrives; its lines show through the smear (a picture or clip)" },
    amount: { kind: "number", low: 0.1, high: 2, about: "how far the colors drag and warp (default 1: a 320 px streak and 120 px warp at 1080 tall)" },
    angle: { kind: "number", low: -180, high: 180, about: "the drag's direction in degrees, 0 right, 90 down (default -25)" },
    flicker: { kind: "number", low: 0, high: 4, whole: true, about: "how many times the smear flicks back for 2 frames after the next shot lands (default 2; 0 lands clean)" },
    fps: { kind: "number", low: 6, high: 60, about: "the smear's frame rate (default 15: on twos)" },
  },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "smear");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const amount = input.amount ?? 1;
    const angle = input.angle ?? -25;
    const flicker = input.flicker ?? 2;
    const fps = input.fps ?? SMEAR_FPS;
    const frame = 1 / 30;
    // The landing: the smear keeps 2 frames per flick (smear, then the next shot) at the end.
    const flicks = flicker * 4 * frame;
    const land = round(Math.max(ctx.start + ctx.duration * 0.4, ctx.end - flicks));
    const group = ctx.add("smear", createLayer("group", { name: "Smear", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, frameRate: fps, role: "decor", allowOverlap: true }), aboveBoth(ctx, from, to));
    const drag = copyOf(ctx, "drag", from, "top", group);
    const lines = copyOf(ctx, "lines", to, { above: drag.id }, group, { extra: { blendMode: "multiply" } });
    startClips(ctx, to.id, ctx.start);
    const span = { start: ctx.start, duration: ctx.duration };
    const scale = ctx.scale;
    // The old shot's colors pour along the angle: directional blur and a warp grow (study: 200 to
    // 320 px blur at -25 degrees, fluid-warp 120 px, noise scale 1.5, speed 3), mirrored edges so
    // the drag never pulls in transparent borders (study: edge-fill mirror 0.3).
    ctx.animate(drag, "edges", effect({ name: "Mirror edges", effect: "edge-fill", ...span, easing: CURVE.fade, from: { mode: "mirror", extend: 0.3 }, to: { mode: "mirror", extend: 0.3 } }));
    ctx.animate(drag, "warp", effect({ name: "Warp", effect: "fluid-warp", ...span, easing: CURVE.drag, from: { amount: 0, noiseScale: 1.5, speed: 3, seed: 9 }, to: { amount: Math.min(128, round(120 * amount * scale)), noiseScale: 1.5, speed: 3, seed: 9 } }));
    ctx.animate(drag, "drag", effect({ name: "Drag", effect: "directional-blur", ...span, easing: CURVE.drag, from: { length: round(60 * amount * scale), angle }, to: { length: round(320 * amount * scale), angle } }));
    // Light, loud streaks: the reference colors are pastel over the whole frame (study: color-grade
    // brightness 2.2, contrast 1.2, saturation 2 on the smear copy).
    const loud = { brightness: 2.2, contrast: 1.2, saturation: 2 };
    ctx.animate(drag, "grade", effect({ name: "Streak color", effect: "color-grade", ...span, easing: CURVE.fade, from: loud, to: loud }));
    // The drag travels a little along its angle (guess: 6% of the frame width per unit of amount).
    const radians = (angle * Math.PI) / 180;
    const travel = ctx.frame.width * 0.06 * amount;
    ctx.animate(drag, "travel", motion({ name: "Travel", ...span, easing: CURVE.drag, from: { x: drag.x, y: drag.y }, to: { x: round(drag.x + Math.cos(radians) * travel, 1), y: round(drag.y + Math.sin(radians) * travel, 1) } }));
    // The next shot as lines only: pushed so bright that only its darkest contours survive, gray,
    // multiplied over the drag. The study's brightness 2.6, contrast 1.8 kept dark backgrounds dark
    // (black patches over the drag in the first after run), so brightness 4, contrast 2.5 and
    // saturation 0 (guess, checked by eye on the study's clips); rgb-shift 0.3 is the study's.
    const ink = { brightness: 4, contrast: 2.5, saturation: 0 };
    ctx.animate(lines, "ink", effect({ name: "Lines only", effect: "color-grade", ...span, easing: CURVE.fade, from: ink, to: ink }));
    ctx.animate(lines, "split", effect({ name: "Line split", effect: "rgb-shift", ...span, easing: CURVE.fade, from: { amount: 0.3, direction: angle }, to: { amount: 0.3, direction: angle } }));
    ctx.animate(lines, "in", motion({ name: "Lines in", kind: "in", start: ctx.start, duration: Math.max(0.04, (land - ctx.start) * 0.35), easing: CURVE.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    // The old shot is gone under the smear at once; the next shot is under it all along.
    ctx.animate(from.id, "hide", hide(ctx.start + 0.001), "from");
    if (ctx.start > 0) ctx.animate(group, "show", show(ctx.start));
    ctx.animate(group, "hide", hide(land));
    for (let flick = 0; flick < flicker; flick += 1) {
      const back = land + (flick * 4 + 2) * frame;
      ctx.animate(group, `show-${flick + 1}`, show(back));
      ctx.animate(group, `hide-${flick + 1}`, hide(back + 2 * frame));
    }
    ctx.note(`smear ${from.id} -> ${to.id}: drag ${round(ctx.start)}-${land} s at ${angle} degrees, amount ${amount}, on ${fps} fps; ${flicker} flicks back, clean from ${round(land + flicker * 4 * frame)} s`);
    return { end: ctx.end };
  },
};

/** The cell of `seeds[index]` inside the frame rectangle (a Voronoi cell by half-plane clipping). */
export function shardCell(seeds, index, width, height) {
  let polygon = [[0, 0], [width, 0], [width, height], [0, height]];
  const [px, py] = seeds[index];
  seeds.forEach(([qx, qy], other) => {
    if (other === index || polygon.length < 3) return;
    // Keep the side nearer p: points where (x - mid) . (q - p) <= 0.
    const [nx, ny] = [qx - px, qy - py];
    const [mx, my] = [(px + qx) / 2, (py + qy) / 2];
    const side = ([x, y]) => (x - mx) * nx + (y - my) * ny;
    const out = [];
    polygon.forEach((point, at) => {
      const next = polygon[(at + 1) % polygon.length];
      const [a, b] = [side(point), side(next)];
      if (a <= 0) out.push(point);
      if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
        const t = a / (a - b);
        out.push([point[0] + (next[0] - point[0]) * t, point[1] + (next[1] - point[1]) * t]);
      }
    });
    polygon = out;
  });
  return polygon;
}

export const shatter = {
  name: "shatter",
  needsAt: true,
  about: "the old shot breaks like glass into shards that carry its picture, crack, then fly apart to reveal the next shot",
  fits: "a shock, a hard turn",
  tags: ["glitch-hit", "mask-wipe"],
  length: 0.7,
  shortest: 0.3,
  fields: {
    from: { kind: "layer", required: true, about: "the shot that breaks (a picture or clip; the shards keep playing it)" },
    to: { kind: "layer", required: true, about: "the shot revealed behind the shards" },
    shards: { kind: "number", low: 3, high: 40, whole: true, about: "how many pieces (default 12)" },
    point: { kind: "point", about: "[x, y] in % of the frame where it breaks; small shards gather there and the rest fly away from it (default [50, 45])" },
    spread: { kind: "number", low: 0.1, high: 2, about: "how far the shards fly, a share of the frame's diagonal (default 0.6)" },
    seed: { kind: "number", low: 0, high: 100000, whole: true, about: "another whole number gives another break pattern (default the move's seed)" },
    fringe: { kind: "number", low: 0, high: 1, about: "the color fringe on the shards (rgb shift amount; default 0.12, 0 none)" },
    edge: { kind: "number", low: 0, high: 12, about: "a light edge on each shard, px at 1080 tall (default 2; 0 none)" },
    ...shared({ color: "the shard edges' color, hex (default white)" }),
  },
  example: { from: "shot-a", to: "shot-b", at: 1, shards: 12 },
  setup: "shot-a and shot-b, two full-frame pictures or videos",
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "shatter");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const { width, height } = ctx.frame;
    const count = input.shards ?? 12;
    const spread = input.spread ?? 0.6;
    const fringe = input.fringe ?? 0.12;
    const edge = round((input.edge ?? 2) * ctx.scale, 1);
    const [cx, cy] = (input.point ?? [50, 45]).map((value, axis) => (value / 100) * (axis ? height : width));
    // Seeded pieces: half gather near the break point (small shards), the rest anywhere (big ones).
    const random = (input.seed !== undefined ? seeded(input.seed + 1) : ctx.rng).next;
    const near = Math.ceil(count / 2);
    const seeds = Array.from({ length: count }, (_, index) => {
      if (index < near) {
        const turn = random() * Math.PI * 2;
        const reach = Math.sqrt(random()) * Math.min(width, height) * 0.35;
        return [Math.min(width - 1, Math.max(1, cx + Math.cos(turn) * reach)), Math.min(height - 1, Math.max(1, cy + Math.sin(turn) * reach))];
      }
      return [1 + random() * (width - 2), 1 + random() * (height - 2)];
    });
    const diagonal = Math.hypot(width, height);
    // A short crack first (light edges, no motion; guess: 3 frames), then the burst.
    const crack = Math.min(0.1, ctx.duration * 0.15);
    const fly = { start: ctx.start + crack, duration: ctx.duration - crack };
    let place = aboveBoth(ctx, from, to);
    const made = [];
    seeds.forEach((_, index) => {
      const polygon = shardCell(seeds, index, width, height);
      if (polygon.length < 3) return;
      const xs = polygon.map(([x]) => x);
      const ys = polygon.map(([, y]) => y);
      const box = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)) };
      box.width = Math.max(1, Math.ceil(Math.max(...xs)) - box.x);
      box.height = Math.max(1, Math.ceil(Math.max(...ys)) - box.y);
      const number = made.length + 1;
      const outline = polygon.map(([x, y], at) => `${at ? "L" : "M"}${round(x - box.x, 1)} ${round(y - box.y, 1)}`).join(" ") + " Z";
      const shard = ctx.add(`shard-${number}`, createLayer("group", { name: `Shard ${number}`, ...box, isMaskGroup: true, role: "decor", allowOverlap: true }), place);
      const mask = ctx.add(`mask-${number}`, createLayer("path", { x: 0, y: 0, width: box.width, height: box.height, path: outline, fill: DEFAULTS.colors.mask, isMask: true, role: "decor", allowOverlap: true }), { above: shard.id }, shard);
      const picture = copyOf(ctx, `piece-${number}`, from, { above: mask.id }, shard, { offset: box });
      if (edge > 0) ctx.add(`edge-${number}`, createLayer("path", { x: 0, y: 0, width: box.width, height: box.height, path: outline, fillEnabled: false, stroke: ctx.color("color", DEFAULTS.colors.edge), strokeWidth: edge, strokeAlign: "inside", opacity: 0.7, role: "decor", allowOverlap: true }), { above: picture.id }, shard);
      place = { above: shard.id };
      // Away from the break point with a little turn (guess: up to 12 degrees; 30 read as a soft
      // upscale of a tall frame's covering picture). No growth: a
      // picture already scaled to cover a tall frame would look soft (soft_upscale) any bigger.
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const away = Math.hypot(middle.x - cx, middle.y - cy) || 1;
      const [ux, uy] = [(middle.x - cx) / away, (middle.y - cy) / away];
      const distance = diagonal * spread * (0.7 + random() * 0.6);
      const turn = round((random() * 2 - 1) * 12, 1);
      ctx.animate(shard, "fly", motion({ name: "Fly apart", ...fly, easing: CURVE.burst,
        from: { x: box.x, y: box.y, rotation: 0 },
        to: { x: round(box.x + ux * distance, 1), y: round(box.y + uy * distance + height * 0.08, 1), rotation: turn } }));
      ctx.animate(shard, "fade", motion({ name: "Fade", start: ctx.start + ctx.duration * 0.6, duration: ctx.duration * 0.4, easing: CURVE.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
      if (fringe > 0) ctx.animate(shard, "fringe", effect({ name: "Fringe", effect: "rgb-shift", start: ctx.start, duration: ctx.duration, easing: CURVE.fade, from: { amount: fringe, direction: round((Math.atan2(uy, ux) * 180) / Math.PI) }, to: { amount: fringe, direction: round((Math.atan2(uy, ux) * 180) / Math.PI) } }));
      if (ctx.start > 0) ctx.animate(shard, "show", show(ctx.start));
      ctx.animate(shard, "hide", hide(ctx.end));
      made.push(shard);
    });
    startClips(ctx, to.id, ctx.start);
    ctx.animate(from.id, "hide", hide(ctx.start + 0.001), "from");
    // The next shot sits a little close and eases back as the glass clears (guess: 1.06x).
    ctx.animate(to.id, "settle", motion({ name: "Settle", start: ctx.start, duration: ctx.duration, easing: CURVE.settle,
      from: { scaleX: 1.06 * (to.scaleX ?? 1), scaleY: 1.06 * (to.scaleY ?? 1) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.note(`shatter ${from.id} -> ${to.id}: ${made.length} shards from [${round((cx / width) * 100)}, ${round((cy / height) * 100)}]%, cracks ${round(ctx.start)}-${round(ctx.start + crack)} s, gone at ${ctx.end} s`);
    return { end: ctx.end };
  },
};
