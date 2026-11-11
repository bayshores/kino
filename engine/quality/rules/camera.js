// Camera rules: motion mistakes a still frame cannot show, read from the model (no rendering).
//   lone_zoom (gate)     a clip or picture pushes in (or out) alone while the shot behind it holds still
//   edge_linger (gate)   a painted layer hangs at the frame edge as a thin sliver while slow or stopped
//   transition_dip       a dissolve fades both shots at once, so the frame dips to what is under them
//   cut_mid_move         a hard cut or opacity snap ends a fast move with nothing moving on the other side
// They came from a trailer that had to be fixed by eye: the phone grew over a still dark plate,
// its bezel lingered as bars at the frame edge. Thresholds come from measured motion signals.
import { scaleOf, sec, speedAt } from "../analysis.js";
import { area, boxAt, chainOf, intersection, itemById, moveStartedAt, movingAt, runs, startsWithCut, visibleBoxAt } from "../model.js";
import { plateChanges } from "../techniques.js";

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
const frameShare = (model, box) => area(intersection(box, FRAME(model))) / (model.width * model.height);
const samplesIn = (model, seconds) => Math.max(1, Math.round(seconds * model.fps));
const percent = (value) => `${Math.round(value * 100)}%`;
const isPicture = (item) => item.kind === "video" || item.kind === "image";
const drawnItems = (model) => model.items.filter((item) => !item.isMask && item.kind !== "group" && item.kind !== "audio" && item.kind !== "text");

// Full-frame opaque layers (by what is seen at that sample), top first. The scene background is the
// empty a transition dips to, not a plate.
function platesAt(model, index) {
  return drawnItems(model).filter((item) => item.opaque && !item.source?.sceneBackground && item.samples.opacity[index] > 0.02
    && frameShare(model, visibleBoxAt(model, item, index)) >= 0.95).sort((a, b) => b.z - a.z);
}

// What can stand as the shot behind `item` at a sample, top first: the full-frame plates, and
// pictures under it that cover its box or 30% of the frame (letterboxed 16:9 footage in a 9:16
// frame, footage scaled to 92%). A picture in a group around the item moves with it: not a backing.
const BACKING_SHARE = 0.3;
function backingsAt(model, item, index) {
  const chain = chainOf(model, item);
  const own = new Set(chain.map((entry) => entry.id));
  const groups = new Set(chain.slice(1).map((entry) => entry.id));
  const box = intersection(visibleBoxAt(model, item, index), FRAME(model));
  const covers = (other) => {
    const seen = visibleBoxAt(model, other, index);
    return frameShare(model, seen) >= BACKING_SHARE || area(intersection(seen, box)) >= 0.95 * area(box);
  };
  const plates = platesAt(model, index);
  const pictures = drawnItems(model).filter((other) => isPicture(other) && !plates.includes(other) && other.samples.opacity[index] > 0.02
    && !chainOf(model, other).slice(1).some((group) => groups.has(group.id)) && covers(other));
  return [...plates, ...pictures].filter((other) => other.z < item.z && !own.has(other.id)).sort((a, b) => b.z - a.z);
}

// The outermost group around an item that moves with it (same scale at both ends of a window):
// a phone's body, bezel and screen are one finding, named by the phone group.
function movingHolder(model, item, from, to) {
  let holder = item;
  for (const entry of chainOf(model, item).slice(1)) {
    if (entry.kind !== "group") break;
    const ratio = (entry.samples.scale[to] / Math.max(1e-6, entry.samples.scale[from])) / (item.samples.scale[to] / Math.max(1e-6, item.samples.scale[from]));
    if (Math.abs(ratio - 1) > 0.02 || frameShare(model, boxAt(entry, to)) >= 0.95) break;
    holder = entry;
  }
  return holder;
}

// ---------------------------------------------------------------- lone_zoom

// metrics.md signal 2 (camera-move consistency): a push moves everything seen; a layer of 8% to 90%
// of the frame growing 12% in 0.5 s while the shot behind holds still reads as "only the phone grew".
const LONE_WINDOW = 0.5;
const LONE_GROWTH = 1.12;
const LONE_MIN_SHARE = 0.08;
const LONE_MAX_SHARE = 0.9;
// A picture of 30% of the frame or more crossing 1 frame width a second inside the frame, alone.
const LONE_SPEED = 1;
const LONE_SPEED_SHARE = 0.3;
// The move ends when it grows under 2% in 0.1 s (a slow drift after a push is not the push).
const LONE_DRIFT = 1.02;
// The plate behind moves with it when it scales 3% or shifts 1% of the frame width in the window.
const PLATE_SCALE = 1.03;
const PLATE_SHIFT = 0.01;
// A flat layer this opaque hides what is under it: footage pushed under 96% black is not seen.
const SEEN_THROUGH = 0.85;
// A plate blurred this much (px at 1080p) is a defocused backdrop, not the shot.
const BACKDROP_BLUR = 12;

// What the viewer sees as the shot behind `item` at a window: the backings under it from the top,
// down to the first one opaque enough to hide the rest. Moving when any of them moves.
function plateBehind(model, item, from, to) {
  const under = backingsAt(model, item, from);
  const seen = [];
  for (const plate of under) {
    seen.push(plate);
    if (Math.min(plate.samples.opacity[from], plate.samples.opacity[to]) >= SEEN_THROUGH) break;
  }
  const moves = (plate) => {
    const [a, b] = [boxAt(plate, from), boxAt(plate, to)];
    const grow = plate.samples.scale[to] / Math.max(1e-6, plate.samples.scale[from]);
    const shift = Math.max(...["x0", "y0", "x1", "y1"].map((key) => Math.abs(b[key] - a[key]))) / model.width;
    return grow >= PLATE_SCALE || grow <= 1 / PLATE_SCALE || shift >= PLATE_SHIFT;
  };
  if (!seen.length) return null;
  // The top picture in the stack, seen or hidden under a flat overlay: with none, the shot behind is
  // flat color (a brand background), and a picture scales alone over it on purpose (a product zoom).
  const picture = under.find(isPicture);
  if (!picture) return null;
  // A heavily blurred backdrop reads as a backdrop, like a flat color: a picture may move over it.
  // A thin flat tint over it (a 30% dim) carries no picture of its own.
  const pictures = seen.filter((plate) => isPicture(plate) || Math.min(plate.samples.opacity[from], plate.samples.opacity[to]) >= SEEN_THROUGH);
  const backdrop = pictures.length > 0 && pictures.every((plate) => Math.max(plate.samples.blur[from], plate.samples.blur[to]) >= BACKDROP_BLUR * scaleOf(model));
  return { plate: seen[0], picture, moving: backdrop || seen.some(moves) };
}

// A scale change on the item or a group around it from an entrance or exit animation in the window.
function entering(model, item, start, end) {
  const ids = new Set(chainOf(model, item).map((entry) => entry.id));
  return model.tweens.some((tween) => ids.has(tween.itemId) && (tween.kind === "in" || tween.kind === "out")
    && tween.keys.some((key) => key.startsWith("scale")) && tween.start < end && tween.end > start);
}

/** lone_zoom: a clip or picture pushes in or out (or whips across) while the shot behind it holds still. */
export function loneZoom(model, ctx) {
  const half = samplesIn(model, LONE_WINDOW);
  const step = samplesIn(model, 0.1);
  const found = new Map();
  for (const item of drawnItems(model).filter(isPicture)) {
    if (item.role === "logo" || item.role === "decor" || item.role === "background") continue;
    // Footage seen through letters or a drawn shape (a text or path mask) is type: a title scales alone on purpose.
    if ((item.clipIds ?? []).some((id) => ["text", "path"].includes(itemById(model, id)?.kind))) continue;
    const { scale, opacity } = item.samples;
    for (let from = 0; from + half < model.times.length; from += step) {
      const to = from + half;
      if (opacity[from] < 0.5 || opacity[to] < 0.5) continue;
      const shareA = frameShare(model, visibleBoxAt(model, item, from)), shareB = frameShare(model, visibleBoxAt(model, item, to));
      if (Math.max(shareA, shareB) < LONE_MIN_SHARE || Math.min(shareA, shareB) > LONE_MAX_SHARE) continue;
      const grow = scale[to] / Math.max(1e-6, scale[from]);
      const zooms = grow >= LONE_GROWTH || grow <= 1 / LONE_GROWTH;
      const whips = !zooms && Math.min(shareA, shareB) >= LONE_SPEED_SHARE && speedAt(model, item, from + Math.floor(half / 2)) >= LONE_SPEED;
      if (!zooms && !whips) continue;
      // An entrance or exit (a pop in, a shrink out) scales a picture alone on purpose: an in or out
      // animation, or a picture that was not seen half a second before.
      if (opacity[Math.max(0, from - half)] < 0.5 || entering(model, item, model.times[from], model.times[to])) continue;
      const behind = plateBehind(model, item, from, to);
      if (!behind || behind.moving) continue;
      const holder = movingHolder(model, item, from, to);
      const key = holder.id;
      const last = found.get(key)?.at(-1);
      if (last && from <= last.to + step) { last.to = to; last.grow = Math.abs(Math.log(grow)) > Math.abs(Math.log(last.grow)) ? grow : last.grow; continue; }
      if (!found.has(key)) found.set(key, []);
      found.get(key).push({ holder, item, plate: behind.plate, picture: behind.picture, from, to, grow, whips });
    }
  }
  // One finding per moving thing: a clip inside a phone that also scales on its own is the phone's.
  const all = [...found.values()].flat();
  const kept = all.filter((entry) => !all.some((other) => other !== entry && other.from <= entry.to && entry.from <= other.to
    && chainOf(model, entry.holder).slice(1).includes(other.holder)));
  return kept.map(({ holder, item, plate, picture, from, to, grow, whips }) => {
    // From when it starts to change, not the window it was first seen in.
    let [start, end] = [from, to];
    while (start < end && Math.abs(item.samples.scale[start + 1] - item.samples.scale[start]) < 1e-4 && !whips) start += 1;
    while (end > start && Math.abs(item.samples.scale[end] - item.samples.scale[end - 1]) < 1e-4 && !whips) end -= 1;
    // To where the move ends, past the last window that grew 12%: until it grows under 2% in 0.1 s.
    const last = model.times.length - 1;
    const stillGrowing = (index) => Math.abs(Math.log(item.samples.scale[Math.min(last, index + step)] / Math.max(1e-6, item.samples.scale[index]))) >= Math.log(LONE_DRIFT);
    // A tail that settles within 0.3 s (the end of an ease) still belongs to the move.
    const changes = (index) => Math.abs(item.samples.scale[index + 1] - item.samples.scale[index]) >= 1e-4;
    const settlesSoon = (index) => { for (let next = index + 1; next < Math.min(last, index + 3 * step); next += 1) if (!changes(next)) return true; return false; };
    // A long ease-out keeps slowing down until it stops (a slow smooth push); a drift scales at an
    // even rate. Slowing: the next frame scales at least 0.5% less than this one.
    const rate = (index) => Math.abs(Math.log(item.samples.scale[index + 1] / Math.max(1e-6, item.samples.scale[index])));
    const slowing = (index) => index + 2 <= last && rate(index + 1) < 0.995 * rate(index);
    while (end + 1 <= last && changes(end) && (stillGrowing(end) || settlesSoon(end) || slowing(end)) && item.samples.opacity[end + 1] >= 0.5 && !whips) end += 1;
    const [at, until] = [sec(model.times[start]), sec(model.times[end])];
    const total = item.samples.scale[end] / Math.max(1e-6, item.samples.scale[start]);
    const what = whips ? "moves 1 frame width a second or more" : `${total >= 1 ? "grows" : "shrinks"} x${total.toFixed(2)}`;
    return {
      rule: "lone_zoom", severity: "error", itemId: holder.id, itemIds: [holder.id, plate.id], at, until,
      message: `${ctx.name(holder)} ${what} from ${at} to ${until} s while ${ctx.name(plate)} behind it holds still: only the picture moves, the shot does not.`,
      measured: `${what}, the shot behind moves under ${Math.round((PLATE_SCALE - 1) * 100)}%`,
      required: `a push moves the shot behind too (it scales or shifts with the picture in the same window), or the picture stays put`,
      fix: { kind: "hint", text: picture === plate
        ? `Push ${plate.name ?? plate.id} about the same point in the same window (scale 1 to 1.05 from ${at} to ${until} s, the same easing), or group both and push the group.`
        : `Lower ${plate.name ?? plate.id} so ${picture.name ?? picture.id} shows, and push ${picture.name ?? picture.id} with it (scale 1 to 1.05 from ${at} to ${until} s): a push under a near-opaque overlay is not seen.` },
    };
  });
}

// ---------------------------------------------------------------- edge_linger

// metrics.md signal 4: a layer mostly off frame that hangs at the edge reads as a mistake. Seen
// share of itself under 25% and of the frame under 15%, at least 0.4% of the frame, for 0.3 s.
const SLIVER_SELF = 0.25;
const SLIVER_FRAME = 0.15;
const SLIVER_MIN = 0.004;
// Once a sliver, it stays one down to 0.1% of the frame (a 5 px bar on a 400 px card still shows).
const SLIVER_KEEP = 0.001;
const LINGER_MIN = 0.3;
// Within the action-safe band (EBU R95: 3.5% a side) of a frame edge.
const EDGE_BAND = 0.035;
// A bright edge at 15% opacity still shows on a dark frame.
const SLIVER_OPACITY = 0.15;
// Slower than this (frame widths a second) it lingers; faster, it is crossing out.
const LINGER_SPEED = 0.25;
// Scaling 30% a second or more, a layer's box center says nothing about its edge.
const LINGER_SCALE = 0.3;
// A layer never seen this much in frame bleeds off the edge by design (a cropped accent shape).
const ONCE_SEEN = 0.5;

// Rectangle `box` minus rectangle `cut`: up to four pieces.
function subtract(box, cut) {
  const inside = intersection(box, cut);
  if (area(inside) <= 0) return [box];
  const pieces = [
    { x0: box.x0, y0: box.y0, x1: box.x1, y1: inside.y0 },
    { x0: box.x0, y0: inside.y1, x1: box.x1, y1: box.y1 },
    { x0: box.x0, y0: inside.y0, x1: inside.x0, y1: inside.y1 },
    { x0: inside.x1, y0: inside.y0, x1: box.x1, y1: inside.y1 },
  ];
  return pieces.filter((piece) => area(piece) > 0);
}

// The pieces of an item seen in the frame at a sample: its box in the frame, minus opaque layers
// drawn over it (a phone's screen over its bezel leaves the bezel's thin sides).
function seenPieces(model, item, index, coverers) {
  let pieces = [intersection(visibleBoxAt(model, item, index), FRAME(model))].filter((piece) => area(piece) > 0);
  for (const cover of coverers) {
    if (cover.z <= item.z || cover.samples.opacity[index] < 0.9 || cover.samples.blur[index] > 2) continue;
    const box = visibleBoxAt(model, cover, index);
    pieces = pieces.flatMap((piece) => subtract(piece, box));
    if (!pieces.length) break;
  }
  return pieces;
}

// How fast a layer scales at a sample (share a second, either way).
function scaleRate(model, item, index) {
  const [a, b] = [Math.max(0, index - 1), Math.min(model.times.length - 1, index + 1)];
  return a === b ? 0 : Math.abs(Math.log(item.samples.scale[b] / Math.max(1e-6, item.samples.scale[a]))) * model.fps / (b - a);
}

// The layers edge_linger looks at, and the opaque layers that can cover them (for edgeSliver).
export function edgeLayers(model) {
  const items = drawnItems(model);
  return { items: items.filter((item) => item.painted && item.role !== "decor" && item.role !== "background" && !item.perpetual && !item.loops), coverers: items.filter((item) => item.opaque) };
}

/**
 * The sliver of `item` at the frame edge at a sample, or null: the biggest seen piece along the
 * edge it is near ({x, y} its center, share of the frame, self: share of the layer seen). It is
 * partly off frame, under 25% of it and under 15% of the frame is seen, at least `least` of the
 * frame. `coverers` are the opaque layers that can hide parts of it (edgeLayers).
 */
export function edgeSliver(model, item, index, coverers, least = SLIVER_MIN) {
  if (item.samples.opacity[index] < SLIVER_OPACITY) return null;
  const frame = model.width * model.height;
  const box = visibleBoxAt(model, item, index), whole = area(box);
  if (!whole) return null;
  const inFrame = area(intersection(box, FRAME(model)));
  // It crosses the frame edge (partly off frame), and enough of it is in frame to see.
  if (inFrame >= whole - 1 || inFrame < least * frame) return null;
  const pieces = seenPieces(model, item, index, coverers).filter((piece) => area(piece) >= 16);
  const seen = pieces.reduce((sum, piece) => sum + area(piece), 0);
  if (seen / whole >= SLIVER_SELF || seen / frame >= SLIVER_FRAME || seen < least * frame) return null;
  // A bar along the edge it is near: a thin upright piece by the left or right edge, a flat one
  // by the top or bottom (a side of the layer cut by the top edge is not at the edge).
  const [bandX, bandY] = [EDGE_BAND * model.width, EDGE_BAND * model.height];
  const edge = pieces.filter((piece) => (piece.x1 - piece.x0 <= piece.y1 - piece.y0
    ? piece.x0 <= bandX || piece.x1 >= model.width - bandX : piece.y0 <= bandY || piece.y1 >= model.height - bandY));
  if (!edge.length) return null;
  const biggest = edge.reduce((best, piece) => (area(piece) > area(best) ? piece : best));
  return { x: (biggest.x0 + biggest.x1) / 2, y: (biggest.y0 + biggest.y1) / 2, share: seen / frame, self: seen / whole };
}

/** edge_linger: a painted layer hangs at the frame edge as a sliver while slow or stopped. */
export function edgeLinger(model, ctx) {
  const { items, coverers } = edgeLayers(model);
  const byHolder = new Map();
  for (const item of items) {
    const centers = new Map();
    // A run is a sliver down to SLIVER_KEEP of the frame, and at SLIVER_MIN or more somewhere.
    const sliverAt = (index) => {
      const sliver = edgeSliver(model, item, index, coverers, SLIVER_KEEP);
      if (sliver) centers.set(index, sliver);
      return Boolean(sliver);
    };
    const lag = samplesIn(model, 0.1);
    let onceSeen = null;
    const seenOnce = () => (onceSeen ??= model.times.some((_, index) => {
      const box = visibleBoxAt(model, item, index), whole = area(box);
      return item.samples.opacity[index] >= SLIVER_OPACITY && whole > 0 && area(intersection(box, FRAME(model))) >= ONCE_SEEN * whole;
    }));
    for (const run of runs(model.times.length, sliverAt)) {
      if (!seenOnce()) break;
      if (!centers.has(run.from) || ![...Array(run.length).keys()].some((offset) => centers.get(run.from + offset).share >= SLIVER_MIN)) continue;
      // Slow or stalled: its seen sliver's center crawls, under 0.25 frame widths a second, and so
      // does the layer itself at that sample (the center of a sliver cut by the edge moves at half
      // the layer's speed, so the layer's own speed tells a crawl from a quick exit). A layer that
      // scales (a phone pushed in, its bezel at the edge) is judged by its sliver alone.
      const slow = (index) => {
        if (speedAt(model, item, index) >= LINGER_SPEED && scaleRate(model, item, index) < LINGER_SCALE) return false;
        const a = centers.get(index), b = centers.get(Math.min(run.to, index + lag)), c = centers.get(Math.max(run.from, index - lag));
        const [p, q] = b && index + lag <= run.to ? [a, b] : [c, a];
        const steps = index + lag <= run.to ? lag : index - Math.max(run.from, index - lag);
        return steps > 0 && Math.hypot(q.x - p.x, q.y - p.y) * model.fps / steps / model.width < LINGER_SPEED;
      };
      for (const crawl of runs(run.length, (offset) => slow(run.from + offset))) {
        const [from, to] = [run.from + crawl.from, run.from + crawl.to];
        if ((to - from + 1) / model.fps < LINGER_MIN) continue;
        // A layer that stands still the whole time bleeds off the edge on purpose (cut_off_at_rest).
        if (!model.times.slice(from, to + 1).some((time) => movingAt(model, item, time))) continue;
        const holder = movingHolder(model, item, from, to);
        // The sample with the biggest sliver stands for the run in the message.
        let sample = centers.get(from);
        for (let index = from; index <= to; index += 1) if (centers.get(index).share > sample.share) sample = centers.get(index);
        const entry = { item, holder, from, to, sample };
        const list = byHolder.get(holder.id) ?? [];
        const same = list.find((other) => other.from <= to && from <= other.to);
        if (same) { same.from = Math.min(same.from, from); same.to = Math.max(same.to, to); same.items.add(item); continue; }
        list.push({ ...entry, items: new Set([item]) });
        byHolder.set(holder.id, list);
      }
    }
  }
  return [...byHolder.values()].flat().map(({ holder, items: parts, from, to, sample }) => {
    const [at, until] = [sec(model.times[from]), sec(model.times[to] + 1 / model.fps)];
    const names = [...parts].map((part) => ctx.name(part)).join(", ");
    return {
      rule: "edge_linger", severity: "error", itemId: holder.id, itemIds: [holder.id, ...[...parts].map((part) => part.id)], at, until,
      message: `${names} ${parts.size > 1 ? "hang" : "hangs"} at the frame edge as a thin sliver from ${at} to ${until} s (${percent(sample.self)} of it seen, ${(sample.share * 100).toFixed(1)}% of the frame) while slow: it reads as a leftover edge, not a move.`,
      measured: `a sliver for ${sec((to - from + 1) / model.fps)} s, moving under ${LINGER_SPEED} frame widths a second`,
      required: `a layer leaves the frame at speed or is gone within ${LINGER_MIN} s once it is a sliver at the edge`,
      fix: lingerFix(model, holder, from, to),
    };
  });
}

// Fade the layer out over the sliver's time when it is leaving anyway (hidden soon after) and has
// no fade of its own there; otherwise say what to change.
function lingerFix(model, holder, from, to) {
  const end = Math.min(model.times.length - 1, to + samplesIn(model, 0.4));
  const leaving = holder.samples.opacity[end] < 0.05 || frameShare(model, boxAt(holder, end)) < 0.001;
  const [start, stop] = [model.times[from], model.times[to] + 1 / model.fps];
  const fading = model.tweens.some((tween) => tween.itemId === holder.id && tween.keys.includes("opacity") && tween.start < stop && tween.end > start);
  if (leaving && !fading && !holder.source?.componentPath)
    return { kind: "fades", changes: [{ itemId: holder.id, mode: "out", start: Math.max(0, start - 0.05), end: stop }], auto: true };
  return { kind: "hint", text: `Make ${holder.name ?? holder.id} leave the frame at speed (move its exit further out, or shorten the exit so it does not crawl at the edge), or fade it out from ${sec(start)} to ${sec(stop)} s.` };
}

// ---------------------------------------------------------------- transition_dip

// metrics.md signal 3: across a dissolve the frame's light moves steadily from one shot to the
// other. Two plates fading at once let 1 - (1 - a)(1 - b) of the frame show what is under them
// (0.75 at the middle of a linear crossfade). Under 0.85 reads as a dip; under 0.1 it is a
// deliberate fade through black.
const DIP_COVER = 0.85;
const DIP_BLACK = 0.1;
const DIP_WINDOW = 0.8;
// A quick dip through black is deliberate too: the frame goes under 40% covered and the two
// fades overlap for under 30% of the shorter one (A fades out, then B fades in).
const DIP_DEEP = 0.4;
const DIP_OVERLAP = 0.3;

/** transition_dip: a dissolve fades both shots at once, so the frame dips to what is under them. */
export function transitionDip(model, ctx) {
  const findings = [];
  const [lo, hi] = [0.05, 0.95];
  for (const change of plateChanges(model)) {
    const a = itemById(model, change.from), b = itemById(model, change.to);
    if (!a || !b) continue;
    const floor = Math.min(a.z, b.z);
    const span = samplesIn(model, DIP_WINDOW);
    let worst = null;
    let low = 1;
    const fading = { a: 0, b: 0, both: 0 };
    for (let index = Math.max(0, change.index - span); index <= Math.min(model.times.length - 1, change.index + span); index += 1) {
      let through = 1;
      for (const plate of platesAt(model, index)) if (plate.z >= floor) through *= 1 - Math.min(1, plate.samples.opacity[index]);
      const cover = 1 - through;
      low = Math.min(low, cover);
      const [oa, ob] = [a.samples.opacity[index], b.samples.opacity[index]];
      const [partA, partB] = [oa > lo && oa < hi, ob > lo && ob < hi];
      fading.a += partA; fading.b += partB; fading.both += partA && partB;
      if (oa > lo && oa < hi && ob > lo && ob < hi && cover < DIP_COVER && (!worst || cover < worst.cover)) worst = { index, cover };
    }
    if (!worst || low < DIP_BLACK) continue;
    if (low < DIP_DEEP && fading.both < DIP_OVERLAP * Math.min(fading.a, fading.b)) continue;
    const at = sec(model.times[worst.index]);
    findings.push({
      rule: "transition_dip", severity: "warn", itemId: b.id, itemIds: [a.id, b.id], at,
      message: `The dissolve from ${ctx.name(a)} to ${ctx.name(b)} fades both at once: at ${at} s only ${percent(worst.cover)} of the frame is covered, so the picture dips toward what is under them.`,
      measured: `${percent(worst.cover)} covered mid-dissolve`, required: `${percent(DIP_COVER)} or more (a fade through black goes under ${percent(DIP_BLACK)} on purpose)`,
      fix: { kind: "hint", text: `Keep ${a.z < b.z ? a.name ?? a.id : b.name ?? b.id} (the lower shot) at full opacity until ${b.z > a.z ? b.name ?? b.id : a.name ?? a.id} has faded in over it; fade only the top one.` },
    });
  }
  return findings;
}

// ---------------------------------------------------------------- cut_mid_move

// metrics.md signal 8 (cutting on motion): a cut that ends a fast move with nothing moving on the
// other side reads as the move being chopped. Fast = 0.25 frame widths a second, or 30% of its
// size a second; matched when the other side moves at least half as much.
const CUT_SHARE = 0.3;
const CUT_SPEED = 0.25;
const CUT_SCALE_RATE = 0.3;
const CUT_MATCH = 0.5;

// How fast a layer moves at a sample, in frame widths a second, counting a scale of s a second as s.
function motionAt(model, item, index, back) {
  const other = back ? Math.max(0, index - 1) : Math.min(model.times.length - 1, index + 1);
  if (other === index) return 0;
  const rate = Math.abs(Math.log(item.samples.scale[other] / Math.max(1e-6, item.samples.scale[index]))) * model.fps;
  return Math.max(speedAt(model, item, index), (rate * CUT_SPEED) / CUT_SCALE_RATE);
}

/** cut_mid_move: a hard cut or opacity snap of a large layer while one side is moving fast and the other is still. */
export function cutMidMove(model, ctx) {
  const findings = [];
  const items = drawnItems(model).filter((item) => !item.perpetual && !item.loops);
  let lastAt = -1;
  for (let index = 2; index < model.times.length - 1; index += 1) {
    const large = (item, at) => frameShare(model, visibleBoxAt(model, item, at)) >= CUT_SHARE;
    const gone = items.filter((item) => item.samples.opacity[index - 1] >= 0.9 && item.samples.opacity[index] <= 0.05 && large(item, index - 1));
    const come = items.filter((item) => item.samples.opacity[index - 1] <= 0.05 && item.samples.opacity[index] >= 0.9 && large(item, index));
    if (!gone.length && !come.length) continue;
    const fastest = (list, at, back) => list.reduce((best, item) => {
      const speed = motionAt(model, item, at, back);
      return speed > best.speed ? { item, speed } : best;
    }, { item: null, speed: 0 });
    const out = fastest(gone, index - 1, true), into = fastest(come, index, false);
    // A cut is judged by both sides: a snap out (or in) with nothing replacing it is a fade's job.
    if (!gone.length || !come.length) continue;
    const [moving, still] = out.speed >= into.speed ? [out, into] : [into, out];
    if (moving.speed < CUT_SPEED || still.speed >= CUT_MATCH * moving.speed) continue;
    // A move that starts on the incoming layer's first frame is begun by the cut: nothing is interrupted.
    if (moving === into && startsWithCut(model, into.item, index)) continue;
    if (model.times[index] - lastAt < 0.3) continue;
    lastAt = model.times[index];
    const at = sec(model.times[index]);
    const name = ctx.name(moving.item);
    const began = moving === into ? moveStartedAt(model, into.item, index) : null;
    const speeds = `(${moving.speed.toFixed(2)} frame widths a second) and the other side of the cut is still (${still.speed.toFixed(2)})`;
    const message = began === null
      ? `At ${at} s ${moving === out ? `${name} is cut while still moving` : `${name} cuts in already moving`} ${speeds}.`
      : `At ${at} s ${name} cuts in partway through a move that started at ${sec(began)} s ${speeds}.`;
    const fix = began === null
      ? `Let the move finish before the cut (end it by ${at} s), or give the other shot a matching move in the same direction for the first 0.3 s, or join them with a push or whip.`
      : `Start ${name}'s move on its first frame (${at} s) so the cut begins it, or give the other shot a matching move for its last 0.3 s, or join them with a push or whip.`;
    findings.push({
      rule: "cut_mid_move", severity: "warn", itemId: moving.item.id, itemIds: [out.item?.id ?? gone[0].id, into.item?.id ?? come[0].id], at, message,
      measured: `${moving.speed.toFixed(2)} vs ${still.speed.toFixed(2)} frame widths a second across the cut`,
      required: `a cut lands after the move settles, or both sides move alike (at least ${percent(CUT_MATCH)} of the speed)`,
      fix: { kind: "hint", text: fix },
    });
  }
  return findings;
}
