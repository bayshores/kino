// Composite moves: two or more pictures on screen at once, the way fan edits, recaps and reaction
// cuts show them.
//   split-screen        2 to 4 clips in panes (side by side, stacked, or with slanted dividers),
//                       a gap of the divider color between them, each pane cropped on its clip's
//                       marked or measured subject, the panes arriving one after another
//   picture-in-picture  one clip as an inset in a corner (a border, rounded or square corners and a
//                       soft shadow) over the full-frame shot underneath
// Each pane or inset is a copy of the clip (the same file, from the moment it is at, muted unless
// it is the one heard) in a clipped group: your layers stay as they are and the move takes away
// cleanly. Every number has a default that reads well untouched.
import { createLayer } from "../../model.js";
import { safeArea } from "../formats.js";
import { coverBox, subjectsIn } from "../../footage/layout.js";
import { markedSubject } from "../../footage/moments.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

// Pane entrance: each pane slides in 10% of the frame over 0.5 s, the next one 0.12 s later.
const PANE_IN = 0.5;
const PANE_STAGGER = 0.12;
const PANE_TRAVEL = 0.1;
// Each later pane takes this much longer than the one before (equal timings read as machine-made).
const PANE_LONGER = 0.06;
// The inset pops from 88% over 0.35 s.
const INSET_IN = 0.35;
const INSET_FROM = 0.88;
const DIVIDER = "#0B0B0C";

// The file second a clip shows at scene time `time`.
const fileSecond = (layer, time) => (layer.mediaOffset ?? 0) + (time - (layer.mediaStart ?? 0)) * (layer.mediaSpeed ?? 1);

// Whether a video layer plays at `time` (a picture always shows).
function plays(layer, time) {
  if (layer.type !== "video") return true;
  const begins = layer.mediaStart ?? 0;
  return time >= begins - 1e-6 && (!(layer.mediaDuration > 0) || time < begins + layer.mediaDuration);
}

/**
 * Where a clip's subject is in the stretch [from, to] of its file: the box marked with
 * mark_subject, else the faces measured in the file, else where the eye goes. Returns
 * {center: [x, y] fractions, box: [x, y, w, h] fractions or null, on: "mark"|"face"|"salient"} or null.
 */
export function subjectIn(layer, samples, from, to) {
  const marks = layer.subjectBoxes?.src === layer.src ? layer.subjectBoxes.boxes ?? [] : [];
  const marked = markedSubject({ subjects: marks.map(({ at, box }) => ({ at, box })) }, from, to);
  if (marked) return { center: marked.center, box: marked.box, on: "mark" };
  const seen = subjectsIn(samples ?? [], from, to);
  if (seen.face) return { center: seen.face, box: seen.faceBox ?? null, on: "face" };
  if (seen.salient) return { center: seen.salient.center, box: seen.salient.box, on: "salient" };
  return null;
}

/**
 * The panes of a split screen in `frame`: [{box, points?}] in scene pixels, left to right or top
 * to bottom. side: columns; stacked: rows; slant: columns whose dividers lean `slant` degrees
 * (points: the pane's outline, a box is its bounds). gap and margin in pixels.
 */
export function splitPanes(frame, count, { layout = "side", gap = 0, margin = 0, slant = 12 } = {}) {
  // margin: one number, or {left, right, top, bottom} when the sides differ.
  const edge = typeof margin === "number" ? { left: margin, right: margin, top: margin, bottom: margin } : margin;
  const inner = { x: edge.left, y: edge.top, width: frame.width - edge.left - edge.right, height: frame.height - edge.top - edge.bottom };
  if (layout === "stacked") {
    const height = (inner.height - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ box: { x: inner.x, y: round(inner.y + index * (height + gap), 1), width: inner.width, height: round(height, 1) } }));
  }
  if (layout === "side") {
    const width = (inner.width - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, index) => ({ box: { x: round(inner.x + index * (width + gap), 1), y: inner.y, width: round(width, 1), height: inner.height } }));
  }
  // slant: divider k crosses the middle at x_k; it leans `lean` px right at the top, left at the bottom.
  const lean = (inner.height / 2) * Math.tan((slant * Math.PI) / 180);
  const step = inner.width / count;
  const top = inner.y;
  const bottom = inner.y + inner.height;
  return Array.from({ length: count }, (_, index) => {
    const left = index === 0 ? null : inner.x + index * step;
    const right = index === count - 1 ? null : inner.x + (index + 1) * step;
    const points = [
      [left === null ? inner.x : left + lean + gap / 2, top],
      [right === null ? inner.x + inner.width : right + lean - gap / 2, top],
      [right === null ? inner.x + inner.width : right - lean - gap / 2, bottom],
      [left === null ? inner.x : left - lean + gap / 2, bottom],
    ].map(([x, y]) => [round(x, 1), round(y, 1)]);
    const xs = points.map(([x]) => x);
    const x = Math.max(inner.x, Math.min(...xs));
    const width = Math.min(inner.x + inner.width, Math.max(...xs)) - x;
    return { box: { x: round(x, 1), y: top, width: round(width, 1), height: inner.height }, points };
  });
}

/** The inset's box in `frame`: `size` of the frame's width at the clip's `aspect`, in `corner`, `margin` (a number, or {x, y}) from the frame's edge. */
export function insetBox(frame, { corner = "top-right", size = 0.3, aspect = 16 / 9, margin: gap = 0 } = {}) {
  const margin = typeof gap === "number" ? { x: gap, y: gap } : gap;
  let width = frame.width * size;
  let height = width / aspect;
  // A tall inset keeps to 60% of the frame's height.
  if (height > frame.height * 0.6) { height = frame.height * 0.6; width = height * aspect; }
  const right = corner.endsWith("right");
  const low = corner.startsWith("bottom");
  return { x: round(right ? frame.width - margin.x - width : margin.x, 1), y: round(low ? frame.height - margin.y - height : margin.y, 1), width: round(width, 1), height: round(height, 1) };
}

/** The safe area's margin on each side of `frame`, in px. */
function safeSides(frame) {
  const safe = safeArea(frame);
  return { left: safe.x, top: safe.y, right: Math.max(0, frame.width - safe.x - safe.width), bottom: Math.max(0, frame.height - safe.y - safe.height) };
}

/**
 * The clip a named layer stands for: a video or picture itself, or the one clip or picture in the
 * group frame_shot wrapped around it (move lifts a layer that sits alone in a group up to that group).
 */
function clipOf(ctx, tool, field, layer) {
  if (layer.type === "video" || layer.type === "image") return layer;
  if (layer.type !== "group") throw new Error(`${tool} ${field}: ${layer.id} is a ${layer.type} layer; give video or picture layers.`);
  const parentOf = new Map(ctx.sceneLayers().map((entry) => [entry.id, entry.parentId]));
  const within = (entry) => { for (let up = parentOf.get(entry.id); up; up = parentOf.get(up)) if (up === layer.id) return true; return false; };
  const inside = ctx.sceneLayers().filter((entry) => ["video", "image"].includes(entry.type) && !entry.isMask && within(entry));
  if (inside.length !== 1) throw new Error(`${tool} ${field}: ${layer.id} is a group holding ${inside.length} clips or pictures; give a video or picture layer, or a group that holds exactly one.`);
  return inside[0];
}

// The ready call that aims a crop: look at the clip, then mark where its subject is.
const markCall = (layerId, time) => `look {mode:"source", layer:"${layerId}"} then mark_subject {layer:"${layerId}", t:${round(time)}, box:[x,y,w,h]}`;

// The source size of a clip or picture: its file's, else its layer's box.
function sourceOf(ctx, layer) {
  const file = ctx.fileSize(layer.src);
  return file ?? { width: layer.width || ctx.frame.width, height: layer.height || ctx.frame.height };
}

/**
 * A copy of `from`, cropped to cover `box` (scene pixels) on its subject, inside the group
 * `holder` (so its x and y are the group's), playing the file from the move's start. Returns
 * {copy, on, cut}: what the crop aimed at, and true when the marked subject is wider or taller
 * than the box (part of it is cut).
 */
function paneCopy(ctx, part, from, box, holder, place, heard) {
  const video = from.type === "video";
  const start = ctx.start;
  const playing = plays(from, start);
  const second = round(video ? (playing ? fileSecond(from, start) : from.mediaOffset ?? 0) : 0);
  const source = sourceOf(ctx, from);
  const subject = video ? subjectIn(from, ctx.samples(from.id), second, second + ctx.duration * (from.mediaSpeed ?? 1)) : null;
  const crop = coverBox(source, { width: box.width, height: box.height }, { focus: subject?.center ?? null });
  let cut = false;
  // Only a marked subject or a measured face can be "cut": a salient area is a wide guess, not a subject.
  if (subject?.box && subject.on !== "salient") {
    const [sx, sy, sw, sh] = subject.box;
    const left = crop.x + sx * crop.width;
    const topEdge = crop.y + sy * crop.height;
    cut = left < -1 || topEdge < -1 || left + sw * crop.width > box.width + 1 || topEdge + sh * crop.height > box.height + 1;
  }
  // The copy never plays past the end of its file: it holds the last frame instead.
  const room = video && from.mediaSourceDuration > 0 ? (from.mediaSourceDuration - second) / (from.mediaSpeed ?? 1) : Infinity;
  const shows = round(Math.min(ctx.duration + 0.04, Math.max(0.04, room)));
  const { id, name, animations, move, recipe, parentId, isMask, ...media } = from;
  const copy = ctx.add(part, createLayer(from.type, {
    ...media, x: crop.x, y: crop.y, width: crop.width, height: crop.height, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, role: "decor", allowOverlap: true,
    ...(video ? { mediaStart: start, mediaOffset: second, mediaDuration: shows, volume: heard && !playing ? from.volume ?? 1 : 0, ...(room < ctx.duration ? { mediaFreeze: "last" } : {}) } : {}),
  }), place, holder);
  return { copy, on: subject?.on ?? null, cut, playing, second, endsEarly: room < ctx.duration };
}

// A clip that starts playing during the move would be heard from its own layer out of step with its
// pane (the copy began at the move's start): its own sound is muted from there to the move's end.
function muteUnder(ctx, clip) {
  const begins = clip.mediaStart ?? 0;
  const level = clip.volume ?? 1;
  if (clip.type !== "video" || level === 0 || plays(clip, ctx.start) || begins <= ctx.start || begins >= ctx.end) return null;
  const hold = { kind: "custom", easing: CURVES.fade };
  ctx.animate(clip.id, "mute", motion({ ...hold, name: "Mute under panes", start: begins, duration: ctx.end - begins, from: { volume: 0 }, to: { volume: 0 } }), "composite");
  ctx.animate(clip.id, "unmute", motion({ ...hold, name: "Sound back", start: ctx.end, duration: 0.05, from: { volume: 0 }, to: { volume: level } }), "composite");
  return begins;
}

// What a crop was aimed at, as a phrase (null: the clip's center).
const aimed = (on) => (on === "mark" ? "marked subject" : on === "face" ? "face" : "salient area");

// The highest clip, picture or group of the scene: the composite goes just above it (and its
// parts, for a group), under any text.
function aboveFootage(ctx, named) {
  const footage = ctx.topLayers().filter((layer) => ["video", "image", "group"].includes(layer.type) && layer.move?.instance !== ctx.id);
  const highest = [...footage, ...named].sort((a, b) => ctx.order(a.id) - ctx.order(b.id)).at(-1);
  if (!highest) return "top";
  const inside = new Set([highest.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const layer of ctx.sceneLayers()) if (layer.parentId && inside.has(layer.parentId) && !inside.has(layer.id)) { inside.add(layer.id); grew = true; }
  }
  const last = [...inside].sort((a, b) => ctx.order(a) - ctx.order(b)).at(-1);
  return { above: last };
}

// A layer shows from the move's start and hides at its end.
function during(ctx, layer) {
  if (ctx.start > 0) ctx.animate(layer, "show", show(ctx.start));
  ctx.animate(layer, "hide", hide(ctx.end));
}

const LAYOUTS = ["side", "stacked", "slant"];

export const splitScreen = {
  name: "split-screen",
  about: "2 to 4 clips in panes at once (side by side, stacked, or slanted dividers) with a gap of the divider color; each pane is cropped on its clip's marked or measured subject and they arrive one after another",
  fits: "two places or people at once, before and after, a reaction beside its cause",
  tags: ["split-screen"],
  length: 3,
  shortest: 0.8,
  fields: {
    layers: { kind: "layers", min: 2, most: 4, required: true, about: "the clips (or pictures), one per pane: left to right, or top to bottom" },
    layout: { kind: "choice", values: LAYOUTS, aliases: { columns: "side", rows: "stacked", diagonal: "slant" }, about: "side (columns), stacked (rows) or slant (columns with leaning dividers); default side in a wide frame, stacked in a tall one" },
    gap: { kind: "number", low: 0, high: 80, knob: true, about: "px between panes (default 1% of the frame's short side)" },
    color: { kind: "color", knob: true, about: "the divider color showing in the gaps, hex (default #0B0B0C)" },
    slant: { kind: "number", low: 3, high: 30, knob: true, about: "slant: degrees the dividers lean (default 12)" },
    margin: { kind: "number", low: 0, high: 200, knob: true, about: "px of divider color around the panes (default 0: the panes reach the frame's edge; a nonzero margin is raised to the safe area on each side it is under)" },
    radius: { kind: "number", low: 0, high: 80, knob: true, about: "corner radius of each pane in px (default 0; side and stacked)" },
    entrance: { kind: "choice", values: ["slide", "fade", "cut"], about: "slide (default): each pane slides in from alternate sides; fade; cut: all at once" },
    stagger: { kind: "number", low: 0, high: 0.5, knob: true, about: "seconds between one pane's entrance and the next (default 0.12)" },
    sound: { kind: "number", low: 0, high: 4, whole: true, about: "the pane whose clip is heard, 1 to 4, or 0 for none (default 1; a clip already playing under the panes keeps its own sound)" },
  },
  example: { layers: ["shot-a", "shot-b"], at: 0.3 },
  setup: "shot-a and shot-b, two pictures (or clips) filling the frame",
  build(ctx, input) {
    const named = input.layers.map((layerId, index) => ctx.layer(layerId, `layers[${index}]`));
    if (new Set(named.map((layer) => layer.id)).size !== named.length) throw new Error("split-screen layers: give each clip once (one per pane).");
    const clips = named.map((layer) => clipOf(ctx, "split-screen", "layers", layer));
    if ((input.sound ?? 1) > named.length) throw new Error(`split-screen sound: ${input.sound} is past the ${named.length} panes; give sound 1 to ${named.length}, or 0 for none.`);
    const frame = ctx.frame;
    const short = Math.min(frame.width, frame.height);
    const layout = input.layout ?? (ctx.portrait ? "stacked" : "side");
    const gap = input.gap ?? Math.round(short * 0.01);
    // A margin shows the divider color around the panes. A pane closer to the frame's edge than
    // the safe area reads as cut off, so a nonzero margin is raised to the safe area on each side.
    const sides = safeSides(frame);
    const asked = input.margin ?? 0;
    const margin = asked > 0 ? Object.fromEntries(Object.entries(sides).map(([side, least]) => [side, Math.max(asked, least)])) : asked;
    const raised = asked > 0 && Object.values(margin).some((value) => value > asked);
    const panes = splitPanes(frame, named.length, { layout, gap, margin, slant: input.slant ?? 12 });
    const narrow = Math.min(...panes.map(({ box }) => (layout === "stacked" ? box.height / frame.height : box.width / frame.width)));
    if (narrow < 0.2) ctx.note(`each pane is ${Math.round(narrow * 100)}% of the frame ${layout === "stacked" ? "tall" : "wide"}: fewer layers, or layout:"${layout === "stacked" ? "side" : "stacked"}", keeps more of each shot`);
    if (raised) ctx.note(`margin ${asked}px raised to the safe area on each side it was under (${margin.left}px left, ${margin.top}px top): a pane closer would read as cut off`);
    let place = aboveFootage(ctx, named);
    const plate = ctx.add("plate", createLayer("rectangle", { x: 0, y: 0, width: frame.width, height: frame.height, fill: ctx.color("color", DIVIDER), role: "decor", allowOverlap: true }), place);
    during(ctx, plate);
    place = { above: plate.id };
    const heardPane = input.sound ?? 1;
    const entrance = ctx.reduced && input.entrance !== "cut" ? "fade" : input.entrance ?? "slide";
    const stagger = entrance === "cut" ? 0 : input.stagger ?? PANE_STAGGER;
    const report = [];
    const unaimed = [];
    panes.forEach(({ box, points }, index) => {
      const number = index + 1;
      const clip = clips[index];
      const radius = points ? 0 : input.radius ?? 0;
      const pane = ctx.add(`pane-${number}`, createLayer("group", { ...box, clipContent: !points, isMaskGroup: Boolean(points), radius, role: "decor", allowOverlap: true }), place);
      let inside = { above: pane.id };
      if (points) {
        const outline = points.map(([x, y], at) => `${at ? "L" : "M"}${round(x - box.x, 1)} ${round(y - box.y, 1)}`).join(" ") + " Z";
        const mask = ctx.add(`mask-${number}`, createLayer("path", { x: 0, y: 0, width: box.width, height: box.height, path: outline, fill: "#FFFFFF", isMask: true, role: "decor", allowOverlap: true }), inside, pane);
        inside = { above: mask.id };
      }
      const made = paneCopy(ctx, `clip-${number}`, clip, box, pane, inside, number === heardPane);
      place = { above: made.copy.id };
      if (clip.type === "video" && made.on !== "mark" && made.on !== "face") unaimed.push({ number, clip, on: made.on });
      report.push(`${number} ${named[index].id}${made.on ? ` on its ${aimed(made.on)}` : ""}${made.cut ? ` (${made.on === "face" ? "face" : "subject"} cut: mark a tighter subject or use fewer panes)` : ""}${made.endsEarly ? " (its file ends early: holds the last frame)" : ""}`);
      // Entrance: slide in from alternate sides (down, up for columns; right, left for rows), or fade.
      // Each pane takes a little longer than the last, so the panes never move in lockstep.
      const at = round(ctx.start + index * stagger);
      if (at > 0) ctx.animate(pane, "show", show(at));
      ctx.animate(pane, "hide", hide(ctx.end));
      if (entrance === "cut") return;
      const sign = index % 2 ? 1 : -1;
      const offset = layout === "stacked" ? { x: round(box.x + sign * frame.width * PANE_TRAVEL, 1) } : { y: round(box.y + sign * frame.height * PANE_TRAVEL, 1) };
      const rest = layout === "stacked" ? { x: box.x } : { y: box.y };
      const moving = entrance === "slide" ? { from: { ...offset, opacity: 0 }, to: { ...rest, opacity: 1 } } : { from: { opacity: 0 }, to: { opacity: 1 } };
      ctx.animate(pane, "in", motion({ name: "Pane in", kind: "in", start: at, duration: (entrance === "slide" ? PANE_IN : 0.3) + index * PANE_LONGER, easing: entrance === "slide" ? ctx.ease("settle") : CURVES.fade, ...moving }));
    });
    // Sound: the heard pane's clip (playing under the panes with its own sound, or its copy's); a
    // clip that starts during the move is muted from its start so it stays with its pane.
    const heard = clips[heardPane - 1];
    const muted = clips.map((clip) => ({ clip, from: muteUnder(ctx, clip) })).filter((entry) => entry.from !== null);
    let sound = "panes silent";
    if (heard?.type === "video") {
      const stops = plays(heard, ctx.start) && heard.mediaDuration > 0 ? (heard.mediaStart ?? 0) + heard.mediaDuration : null;
      sound = `sound: ${plays(heard, ctx.start) ? `${heard.id} plays under the panes with its own sound${stops !== null && stops < ctx.end - 0.05 ? ` until ${round(stops)} s, then silence` : ""}` : `pane ${heardPane}`}`;
    }
    const mutedNote = muted.length ? `; ${muted.map((entry) => `${entry.clip.id} muted from ${round(entry.from)} s`).join(", ")} (its own sound would run out of step with its pane)` : "";
    // A crop with no marked subject or measured face is a guess: say so first, with the call that fixes it.
    const guess = unaimed.length
      ? `${markCall(unaimed[0].clip.id, ctx.start)}: pane ${unaimed[0].number} is cropped on ${unaimed[0].on ? "where the eye goes" : "its center"}${unaimed.length > 1 ? `; the same for ${unaimed.slice(1).map((entry) => entry.clip.id).join(", ")}` : ""}. `
      : "";
    ctx.note(`${guess}split-screen ${layout}, ${named.length} panes, gap ${gap}px: ${report.join("; ")}; ${sound}${mutedNote}`);
    return { end: ctx.end };
  },
};

const CORNERS = ["top-right", "top-left", "bottom-right", "bottom-left"];

export const pictureInPicture = {
  name: "picture-in-picture",
  about: "one clip as an inset in a corner over the full-frame shot: a border, rounded or square corners and a soft shadow; cropped on the clip's subject; it pops in",
  fits: "a reaction, source or second angle over the main shot",
  tags: ["split-screen"],
  length: 3,
  shortest: 0.8,
  fields: {
    layer: { kind: "layer", required: true, about: "the clip (or picture) shown in the inset; the shot under it stays as it is" },
    corner: { kind: "choice", values: CORNERS, about: "where the inset sits (default top-right)" },
    size: { kind: "number", low: 0.15, high: 0.6, about: "its width as a share of the frame's width (default 0.3; 0.45 in a tall frame)" },
    shape: { kind: "choice", values: ["clip", "wide", "square", "tall"], about: "clip (default): the clip's own shape; wide 16:9, square or tall 9:16, cropped on its subject" },
    border: { kind: "number", low: 0, high: 40, knob: true, about: "border width in px (default 0.5% of the frame's short side; 0 for none)" },
    color: { kind: "color", knob: true, about: "the border color, hex (default #FFFFFF)" },
    rounded: { kind: "choice", knob: true, values: [true, false], about: "true (default) rounds the corners; false keeps them square" },
    margin: { kind: "number", low: 0, high: 300, knob: true, about: "px from the frame's edges (default: the safe area's edge)" },
    entrance: { kind: "choice", values: ["pop", "slide", "fade", "cut"], about: "pop (default): grows from 88% as it fades in; slide in from its side; fade; cut" },
    sound: { kind: "choice", values: [true, false], about: "true lets the inset's clip be heard (default false: the shot under it keeps the sound)" },
  },
  example: { layer: "shot-b", at: 0.3 },
  setup: "shot-a filling the frame, and shot-b, a second picture (or clip) shown in the inset",
  build(ctx, input) {
    const from = ctx.layer(input.layer, "layer");
    const clip = clipOf(ctx, "picture-in-picture", "layer", from);
    const frame = ctx.frame;
    const short = Math.min(frame.width, frame.height);
    const source = sourceOf(ctx, clip);
    const aspect = { wide: 16 / 9, square: 1, tall: 9 / 16 }[input.shape] ?? source.width / source.height;
    const corner = input.corner ?? "top-right";
    const border = input.border ?? Math.max(2, Math.round(short * 0.005));
    // The margin is from the frame's edge to the border's outer edge: by default the safe area's
    // edge on that side (a nearer inset reads as cut off).
    const sides = safeSides(frame);
    const margin = input.margin !== undefined
      ? { x: input.margin, y: input.margin }
      : { x: corner.endsWith("right") ? sides.right : sides.left, y: corner.startsWith("bottom") ? sides.bottom : sides.top };
    const box = insetBox(frame, { corner, size: input.size ?? (ctx.portrait ? 0.45 : 0.3), aspect, margin: { x: margin.x + border, y: margin.y + border } });
    const radius = input.rounded === false ? 0 : Math.round(Math.min(box.width, box.height) * 0.06);
    // Over the shot under it: is something that is not this clip filling the frame, below the inset?
    const covers = (layer) => { const at = ctx.boxAt(layer.id, ctx.start); return at.width >= frame.width * 0.9 && at.height >= frame.height * 0.9; };
    const under = ctx.topLayers().filter((layer) => layer.id !== from.id && ["video", "image", "group"].includes(layer.type) && ctx.shownAt(layer.id, ctx.start) && covers(layer));
    const fromFull = ctx.shownAt(from.id, ctx.start) && covers(from);
    if (!under.length) ctx.note("nothing fills the frame under the inset at its start: put the main shot full frame (frame_shot) so the inset sits over it");
    // The clip itself fills the frame on top of the main shot: the inset would show the same picture twice.
    else if (fromFull && !under.some((layer) => ctx.order(layer.id) > ctx.order(from.id)))
      ctx.note(`move_layers {layers:["${from.id}"], position:"bottom"}: ${from.id} fills the frame above the main shot, so its inset would show the same picture twice (the main shot then shows under the inset)`);
    let place = aboveFootage(ctx, [from]);
    // One holder carries the border and the inset together, so a move or a fix keeps them as one.
    const pip = ctx.add("pip", createLayer("group", {
      x: round(box.x - border, 1), y: round(box.y - border, 1), width: round(box.width + 2 * border, 1), height: round(box.height + 2 * border, 1), role: "decor", allowOverlap: true,
    }), place);
    const plate = ctx.add("border", createLayer("rectangle", {
      x: 0, y: 0, width: pip.width, height: pip.height, radius: radius ? radius + border : 0, fill: ctx.color("color", "#FFFFFF"),
      shadow: { color: "#00000080", x: 0, y: Math.round(short * 0.008), blur: Math.round(short * 0.03) }, role: "decor", allowOverlap: true,
    }), { above: pip.id }, pip);
    const holder = ctx.add("inset", createLayer("group", { x: border, y: border, width: box.width, height: box.height, clipContent: true, radius, role: "decor", allowOverlap: true }), { above: plate.id }, pip);
    const made = paneCopy(ctx, "clip", clip, box, holder, { above: holder.id }, input.sound === true);
    const muted = muteUnder(ctx, clip);
    const entrance = ctx.reduced && input.entrance !== "cut" ? "fade" : input.entrance ?? "pop";
    during(ctx, pip);
    if (entrance !== "cut") {
      let moving = { from: { opacity: 0 }, to: { opacity: 1 } };
      if (entrance === "pop") moving = { from: { scaleX: INSET_FROM, scaleY: INSET_FROM, opacity: 0 }, to: { scaleX: 1, scaleY: 1, opacity: 1 } };
      if (entrance === "slide") {
        const travel = pip.width + margin.x;
        moving = { from: { x: round(pip.x + (corner.endsWith("right") ? travel : -travel), 1), opacity: 1 }, to: { x: pip.x, opacity: 1 } };
      }
      ctx.animate(pip, "in", motion({ name: "Inset in", kind: "in", start: ctx.start, duration: entrance === "fade" ? 0.3 : INSET_IN, easing: entrance === "fade" ? CURVES.fade : ctx.ease("settle"), ...moving }));
    }
    const guess = clip.type === "video" && made.on !== "mark" && made.on !== "face"
      ? `${markCall(clip.id, ctx.start)}: the inset is cropped on ${made.on ? "where the eye goes" : "its center"}. ` : "";
    ctx.note(`${guess}picture-in-picture ${corner}: ${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)}, ${Math.round(box.y)}, border ${border}px${made.on ? `, cropped on its ${aimed(made.on)}` : ""}${made.cut ? ` (${made.on === "face" ? "face" : "subject"} cut: a bigger size or shape:"clip" keeps it whole)` : ""}${made.endsEarly ? " (its file ends early: holds the last frame)" : ""}${muted !== null ? `; ${clip.id} muted from ${round(muted)} s (its own sound would run out of step with its inset)` : ""}`);
    return { end: ctx.end };
  },
};
