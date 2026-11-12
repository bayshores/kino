// impact-silhouette: a made impact frame from a shot in one call. For a frame or two the subject's
// cut-out is a flat (or two-tone) silhouette on a plate, with optional made parts: rays from the
// subject's center, a tick ring around its box and speed lines along its measured motion. Then the
// shot's own frame comes back (the move ends inside the shot's bounds, never past its cut).
//
// What it is measured against (.scratch bar studies, frame by frame):
// - one bar edit: cut-out on pure black 1 frame, then 1 impact frame (the hand a white silhouette
//   with spiky white rays), then the cut-out again, at 24 to 25 fps (0.04 s a frame); its next
//   made graphic puts about 24 radial ticks around the cut-out (ticks default 24 from it).
// - another: 3 frames of motion blur, 1 frame tinted and smeared, 1 flat frame in the edit's own
//   color (taken from the subject's palette), then the picture.
// - a third: five 1-frame strobes (white, a traced outline, a radial burst, black, a flat color).
// So: 1 or 2 frames (default 2 at 30 fps, about one 24 fps frame and a half), white or the shot's
// own hue on black or a dark plate of that hue, rays in the ink's color.
//
// Before it draws, the receipt prints the matte's shape facts at the cue (cut_out measures them:
// the copy's subjectShapes): the share of the frame it covers, whether the people scan's face box
// is inside its box, and how much of its outline is the frame edge or a straight line (a floor or
// stairs in the matte). When those say it is not a figure, the receipt names the nearest sampled
// time inside the shot that reads as one, with its at: a fact and an offer, it still draws.
import { createLayer } from "../../model.js";
import { subjectsIn } from "../../footage/layout.js";
import { hslToHex, shotHue } from "./backdrop.js";
import { CURVES, effect, hide, mix, motion, round, show } from "./kit.js";

const FRAME = 1 / 30;
// A matte reads as a figure when it covers 2% to 60% of the frame, at most 20% of its outline is the
// frame edge or a straight line, and (with a people scan) a face box sits inside it. The bounds are
// guesses from run a's failed matte (a solid slab with a straight top edge) and a standing figure.
export const FIGURE = Object.freeze({ least: 0.02, most: 0.6, straight: 0.2 });
// A straight run of outline pixels this long (share of the matte box's side, at least 6 pixels) is a line.
const RUN = 0.25;

/**
 * The shape facts of a one-byte-a-pixel matte (pixels at `level` or more are the subject):
 * {cover: share of the picture, straight: share of its outline on the picture's edge or on a
 * straight horizontal or vertical run of at least a quarter of its box's side}, or null when empty.
 */
export function matteShape(matte, width, height, level = 128) {
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && matte[y * width + x] >= level;
  let count = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  const edge = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!on(x, y)) continue;
    count += 1;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    const framed = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    if (framed || !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)) edge[y * width + x] = framed ? 2 : 1;
  }
  if (!count) return null;
  const straight = new Uint8Array(width * height);
  const longRow = Math.max(6, RUN * (x1 - x0 + 1)), longColumn = Math.max(6, RUN * (y1 - y0 + 1));
  // Horizontal runs of outline pixels whose outside is on the same side (a flat top or bottom).
  for (let y = 0; y < height; y += 1) {
    for (const side of [-1, 1]) {
      let start = -1;
      for (let x = 0; x <= width; x += 1) {
        const lined = x < width && edge[y * width + x] === 1 && !on(x, y + side);
        if (lined && start < 0) start = x;
        if (!lined && start >= 0) { if (x - start >= longRow) for (let k = start; k < x; k += 1) straight[y * width + k] = 1; start = -1; }
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (const side of [-1, 1]) {
      let start = -1;
      for (let y = 0; y <= height; y += 1) {
        const lined = y < height && edge[y * width + x] === 1 && !on(x + side, y);
        if (lined && start < 0) start = y;
        if (!lined && start >= 0) { if (y - start >= longColumn) for (let k = start; k < y; k += 1) straight[k * width + x] = 1; start = -1; }
      }
    }
  }
  let outline = 0, flat = 0;
  for (let index = 0; index < edge.length; index += 1) {
    if (!edge[index]) continue;
    outline += 1;
    if (edge[index] === 2 || straight[index]) flat += 1;
  }
  return { cover: round(count / (width * height), 3), straight: round(flat / outline, 3) };
}

// The file second a clip shows at scene time `time`.
const fileSecond = (layer, time) => (layer.mediaOffset ?? 0) + (time - (layer.mediaStart ?? 0)) * (layer.mediaSpeed ?? 1);

// The shot's own span on the scene's clock: where it shows (a clip from mediaStart for mediaDuration).
function shotSpan(layer, sceneDuration) {
  if (layer.type !== "video") return [0, sceneDuration];
  const from = layer.mediaStart ?? 0;
  return [from, layer.mediaDuration > 0 ? Math.min(sceneDuration, from + layer.mediaDuration) : sceneDuration];
}

// The cut-out's measured shape and box nearest `time` (within 0.25 s), and whether a face is in the box.
function readsAt(subject, footage, samples, time) {
  const nearest = (rows) => (rows ?? []).filter((row) => Math.abs(row[0] - time) <= 0.25 + 1e-6).sort((a, b) => Math.abs(a[0] - time) - Math.abs(b[0] - time))[0];
  const shape = nearest(subject.subjectShapes);
  if (!shape) return null;
  const box = nearest(subject.subjectPath)?.slice(1) ?? subject.subjectBox ?? null;
  const scanned = (samples ?? []).some((sample) => Array.isArray(sample?.faces) || Array.isArray(sample?.people));
  let head = null;
  if (scanned && box) {
    const second = fileSecond(footage, time);
    const face = subjectsIn(samples, second - 0.25, second + 0.25).faceBox;
    head = Boolean(face) && face[0] + face[2] / 2 >= box[0] && face[0] + face[2] / 2 <= box[2] && face[1] + face[3] / 2 >= box[1] && face[1] + face[3] / 2 <= box[3];
  }
  const figure = shape[1] >= FIGURE.least && shape[1] <= FIGURE.most && shape[2] <= FIGURE.straight && head !== false;
  return { at: round(shape[0], 3), cover: shape[1], straight: shape[2], head, box, figure };
}

const said = (facts) => `covers ${Math.round(100 * facts.cover)}% of the frame, head box inside: ${facts.head === null ? "not checked (no people scan)" : facts.head ? "yes" : "no"} (people scan), outline on the frame edge or a straight line: ${Math.round(100 * facts.straight)}%`;

// A small seeded random source (mulberry32), so a seed gives the same rays every time.
function seeded(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const point = (cx, cy, angle, radius) => `${round(cx + Math.cos(angle) * radius, 1)} ${round(cy + Math.sin(angle) * radius, 1)}`;

export const impactSilhouette = {
  name: "impact-silhouette",
  needsAt: true,
  about: "a made impact frame: the subject's cut-out inked flat or two-tone on a plate, with optional rays, tick ring and speed lines; the note prints whether the matte reads as a figure",
  fits: "a drop or hit on a figure shot: 1 or 2 frames",
  tags: ["flash"],
  length: 2 * FRAME,
  shortest: FRAME,
  fields: {
    layer: { kind: "layer", required: true, about: "the clip or picture (full frame); its subject cut-out is made or reused in the same edit" },
    subject: { kind: "layer", knob: true, cutout: { of: "layer", auto: true, own: true }, about: "the subject cut-out (default: kino makes one, shown only on the impact frames, or reuses a cut_out of layer)" },
    frames: { kind: "number", low: 1, high: 6, whole: true, about: "frames at 30 fps (default 2: about one and a half 24 fps frames, the studied impact frames were 1)" },
    tone: { kind: "choice", knob: true, values: ["flat", "two-tone"], about: "flat (default: one ink) or two-tone (the subject's own light and dark split into ink and a darker ink)" },
    ink: { kind: "color", knob: true, auto: true, about: "the silhouette's and parts' color (default auto: the shot's hue, light; white without one)" },
    plate: { kind: "color", knob: true, auto: true, about: "the plate's color (default auto: the shot's hue, near black; black without one)" },
    rays: { kind: "number", low: 0, high: 64, whole: true, about: "rays from the subject's center (default 12, a guess; 0 none)" },
    rayLength: { kind: "number", knob: true, low: 0.05, high: 1, about: "how far a ray reaches past the subject, share of the frame's shorter side (default 0.45)" },
    ticks: { kind: "number", low: 0, high: 96, whole: true, about: "ticks in a ring around the subject's box (default 0; 24 in the studied ring)" },
    tickLength: { kind: "number", knob: true, low: 0.01, high: 0.3, about: "a tick's length, share of the shorter side (default 0.04)" },
    lines: { kind: "number", low: 0, high: 80, whole: true, about: "speed lines along the subject's measured motion (default 0)" },
    lineLength: { kind: "number", knob: true, low: 0.05, high: 1, about: "a speed line's length, share of the frame's width (default 0.35)" },
    seed: { kind: "number", knob: true, low: 0, high: 100000, whole: true, about: "another whole number gives other ray, tick and line spacing (default the move's seed)" },
  },
  example: { layer: "shot-a", at: 0.3 },
  setup: "shot-a, a full-frame clip or picture with a clear figure (the edit cuts it out)",
  timing: (input) => ({ length: round((input.frames ?? 2) * FRAME, 4) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const footage = layer.cutoutOf ? ctx.layer(layer.cutoutOf, "layer") : layer;
    const made = input.subject && ctx.sceneLayers().some((entry) => entry.id === input.subject);
    const subject = made ? ctx.layer(input.subject, "subject") : layer.cutoutOf ? layer : null;
    if (subject && ctx.order(subject.id) < ctx.order(footage.id)) throw new Error(`impact-silhouette subject: ${subject.id} is under ${footage.id}; the cut-out must be above the clip.`);
    const t = ctx.start;
    // A cut-out kino made for this move is drawn only by its silhouette copy, never as itself.
    if (subject?.cutoutFor === impactSilhouette.name) ctx.animate(subject.id, "off", hide(0), "subject");
    // The shot's bounds: the frames end on or before its cut, so the next frame is its own.
    const [, shotEnd] = shotSpan(footage, ctx.sceneDuration);
    const asked = input.frames ?? 2;
    const frames = Math.max(1, Math.min(asked, Math.floor((shotEnd - t) / FRAME + 1e-6)));
    if (frames < asked) ctx.note(`frames ${frames} (asked ${asked}): ${footage.id} cuts at ${round(shotEnd, 3)} s, so the impact ends inside it`);
    const end = round(t + frames * FRAME, 4);
    // The matte's shape facts at the cue, before anything is drawn.
    const samples = ctx.samples(footage.id);
    let center = null, box = null;
    if (subject) {
      const facts = readsAt(subject, footage, samples, t);
      if (!facts) ctx.note(`matte at ${round(t, 3)} s: no shape measured (cut_out again to measure cover and straight edges)`);
      else {
        box = facts.box;
        const verdict = facts.figure ? "reads as a figure" : `does not read as a figure (${facts.cover > FIGURE.most ? "it fills most of the frame" : facts.cover < FIGURE.least ? "it is a speck" : facts.straight > FIGURE.straight ? "a straight edge: a floor, stairs or the frame is in it" : "no head in it"})`;
        let offer = "";
        if (!facts.figure) {
          const [shotStart] = shotSpan(footage, ctx.sceneDuration);
          const better = (subject.subjectShapes ?? []).map((row) => readsAt(subject, footage, samples, row[0]))
            .filter((entry) => entry?.figure && entry.at >= shotStart - 1e-6 && entry.at + frames * FRAME <= shotEnd + 1e-6)
            .sort((a, b) => Math.abs(a.at - t) - Math.abs(b.at - t))[0];
          offer = better ? `; the nearest time in this shot that reads as a figure: ${better.at} s (${said(better)}): at:${better.at}` : "; no sampled time in this shot reads as a figure";
        }
        ctx.note(`matte at ${facts.at} s: ${said(facts)}: ${verdict}${offer}`);
      }
      box ??= subject.subjectBox ?? null;
    }
    if (box) {
      const shot = subject ?? footage;
      center = [shot.x + ((box[0] + box[2]) / 2) * shot.width, shot.y + ((box[1] + box[3]) / 2) * shot.height];
    }
    // Colors: given, else the shot's hue (light ink, near-black plate), else white on black (the studied frame).
    const hue = (!input.ink || input.ink === "auto" || !input.plate || input.plate === "auto") ? shotHue(ctx, footage) : null;
    const ink = input.ink && input.ink !== "auto" ? input.ink : hue ? hslToHex({ h: hue.hue, s: 0.9, l: 0.85 }) : "#FFFFFF";
    const plate = input.plate && input.plate !== "auto" ? input.plate : hue ? hslToHex({ h: hue.hue, s: 0.6, l: 0.06 }) : "#000000";
    if (hue) ctx.note(`ink ${ink} and plate ${plate}: ${footage.id}'s hue from ${hue.from} (${Math.round(hue.hue)}°)`);
    else if (!input.ink || !input.plate) ctx.note(`ink ${ink} on plate ${plate}: no hue measured on ${footage.id}, white on black as in the studied impact frame`);
    if (ctx.reduced) {
      // Reduced motion: the shot holds its frame for the same frames, no plate jump.
      const speed = ctx.stateAt(footage.id, t).speed ?? footage.mediaSpeed ?? 1;
      ctx.animate(footage.id, "hold", motion({ name: "Impact hold", start: t, duration: 0.001, easing: CURVES.fade, from: { speed }, to: { speed: 0 } }), "layer");
      ctx.animate(footage.id, "go", motion({ name: "Impact play", start: end, duration: 0.001, easing: CURVES.fade, from: { speed: 0 }, to: { speed } }), "layer");
      ctx.note("reduced motion: the shot holds its frame, no plate, silhouette or parts");
      return { end, tags: ["freeze-frame"] };
    }
    const { width: W, height: H } = ctx.frame;
    const short = Math.min(W, H);
    const parts = [];
    if (!subject) {
      // No cut-out (no engine, no subject found): the shot itself in two inks for the frames.
      ctx.note(`no subject cut-out of ${footage.id}: the shot turns to ${ink} on ${plate} by its own light and dark`);
      ctx.animate(footage.id, "ink", effect({ name: "Impact ink", effect: "duotone", start: t, duration: end - t, easing: [0, 0, 1, 1], to: { shadowColor: plate, highlightColor: ink, midpoint: 0.5, contrast: 4, normalize: true }, keepStill: "off" }), "layer");
      return { end, tags: ["flash"] };
    }
    const plateLayer = ctx.add("plate", createLayer("rectangle", { name: "Impact plate", x: 0, y: 0, width: W, height: H, fill: plate, strokeWidth: 0, role: "decor", allowOverlap: true }), { above: subject.id });
    parts.push(plateLayer);
    let below = plateLayer.id;
    const random = seeded(input.seed ?? Math.floor(ctx.rng.next() * 100000));
    const [cx, cy] = center ?? [W / 2, H / 2];
    if (!center) ctx.note("no subject box measured: rays and ticks center on the frame");
    const boxPx = box ? { w: (box[2] - box[0]) * (subject.width), h: (box[3] - box[1]) * (subject.height) } : { w: short * 0.4, h: short * 0.6 };
    const pathLayer = (part, name, path, stroke) => {
      const made = ctx.add(part, createLayer("path", { name, x: 0, y: 0, width: W, height: H, path, ...(stroke ? { fillEnabled: false, stroke: ink, strokeWidth: stroke } : { fill: ink, fillEnabled: true, strokeWidth: 0 }), role: "decor", allowOverlap: true }), { above: below });
      below = made.id;
      parts.push(made);
    };
    const drawn = [];
    const rays = input.rays ?? 12;
    if (rays > 0) {
      // Spikes from inside the subject's box out past it: evenly turned, each jittered by the seed.
      const inner = 0.3 * Math.min(boxPx.w, boxPx.h), reach = (input.rayLength ?? 0.45) * short;
      const shapes = [];
      for (let index = 0; index < rays; index += 1) {
        const angle = (2 * Math.PI * (index + 0.5 * random())) / rays;
        const spread = (Math.PI / rays) * (0.25 + 0.2 * random());
        const outer = inner + reach * (0.65 + 0.7 * random());
        shapes.push(`M${point(cx, cy, angle - spread, inner)} L${point(cx, cy, angle, outer)} L${point(cx, cy, angle + spread, inner)} Z`);
      }
      pathLayer("rays", "Impact rays", shapes.join(" "));
      drawn.push(`${rays} rays to ${round(input.rayLength ?? 0.45, 2)} of the shorter side`);
    }
    const ticks = input.ticks ?? 0;
    if (ticks > 0) {
      const radius = 0.6 * Math.max(boxPx.w, boxPx.h), length = (input.tickLength ?? 0.04) * short;
      const shapes = [];
      const turn = random() * 2 * Math.PI / ticks;
      for (let index = 0; index < ticks; index += 1) {
        const angle = turn + (2 * Math.PI * index) / ticks;
        shapes.push(`M${point(cx, cy, angle, radius)} L${point(cx, cy, angle, radius + length)}`);
      }
      pathLayer("ticks", "Impact ticks", shapes.join(" "), round(Math.max(2, 4 * ctx.scale), 1));
      drawn.push(`${ticks} ticks at ${Math.round(radius)} px from the center`);
    }
    const lines = input.lines ?? 0;
    if (lines > 0) {
      // Along the subject's motion: its box center over 0.25 s each side of the cue (subjectPath).
      const path = (subject.subjectPath ?? []).filter((row) => Math.abs(row[0] - t) <= 0.25 + 1e-6);
      const centers = path.map((row) => [(row[1] + row[3]) / 2 * subject.width, (row[2] + row[4]) / 2 * subject.height]);
      const dx = centers.length > 1 ? centers.at(-1)[0] - centers[0][0] : 0, dy = centers.length > 1 ? centers.at(-1)[1] - centers[0][1] : 0;
      const moved = Math.hypot(dx, dy) >= 0.005 * W;
      const angle = moved ? Math.atan2(dy, dx) : 0;
      ctx.note(moved ? `speed lines at ${Math.round((angle * 180) / Math.PI)}°: the subject's box moved ${Math.round(Math.hypot(dx, dy))} px around the cue` : "speed lines horizontal: a starting guess, the subject's box did not move around the cue");
      const length = (input.lineLength ?? 0.35) * W, across = Math.hypot(W, H);
      const shapes = [];
      for (let index = 0; index < lines; index += 1) {
        const offset = (random() - 0.5) * across, along = (random() - 0.5) * (across - length);
        const thick = Math.max(1.5, (2 + 6 * random()) * ctx.scale);
        const ox = W / 2 - Math.sin(angle) * offset + Math.cos(angle) * along, oy = H / 2 + Math.cos(angle) * offset + Math.sin(angle) * along;
        const nx = -Math.sin(angle) * thick / 2, ny = Math.cos(angle) * thick / 2;
        const ex = ox + Math.cos(angle) * length, ey = oy + Math.sin(angle) * length;
        shapes.push(`M${round(ox, 1)} ${round(oy, 1)} L${round(ex + nx, 1)} ${round(ey + ny, 1)} L${round(ex - nx, 1)} ${round(ey - ny, 1)} Z`);
      }
      pathLayer("lines", "Impact speed lines", shapes.join(" "));
      drawn.push(`${lines} speed lines`);
    }
    // The silhouette: a copy of the cut-out in the ink (flat) or ink and a darker ink (two-tone).
    const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, cutoutFor: _for, isMask: _mask, ...picture } = subject;
    const here = ctx.stateAt(subject.id, t);
    const figure = ctx.add("silhouette", createLayer(subject.type, { ...picture, x: round(here.x ?? subject.x, 2), y: round(here.y ?? subject.y, 2), ...(subject.type === "video" ? { volume: 0 } : {}),
      name: "Impact silhouette", cutoutFor: impactSilhouette.name, cutoutOutput: "impact", role: "decor", allowOverlap: true, opacity: 1 }), { above: below });
    parts.push(figure);
    const tone = input.tone ?? "flat";
    const dark = mix(ink, plate, 0.6);
    ctx.animate(figure, "ink", effect({ name: `Impact ${tone}`, effect: "duotone", start: t, duration: end - t, easing: [0, 0, 1, 1],
      to: tone === "flat" ? { shadowColor: ink, highlightColor: ink, midpoint: 0.5, contrast: 1, normalize: false } : { shadowColor: dark, highlightColor: ink, midpoint: 0.5, contrast: 4, normalize: true }, keepStill: "off" }));
    for (const part of parts) {
      ctx.animate(part, "on", show(t));
      ctx.animate(part, "off", hide(end));
    }
    ctx.note(`impact frame ${round(t, 3)} to ${end} s (${frames} frame${frames === 1 ? "" : "s"}): ${tone} silhouette ${ink} on ${plate}${drawn.length ? `, ${drawn.join(", ")}` : ""}; then ${footage.id}'s own frame`);
    return { end, tags: ["flash"] };
  },
};
