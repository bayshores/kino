// Rules measured on rendered pixels: contrast and flashing (both gates).
//
// They need `ctx.renderFrames(times, {width, hide, solo?, background?})`, which renders the scene
// at those times, `width` pixels wide, with the items in `hide` left out (with `solo`, only those
// items over a plain `background` color), and resolves to [{time, pixels (RGBA bytes), width, height}].
import { drawnSize, readableAt, readingTexts, scaleOf, sec } from "./analysis.js";
import { area, boxAt, contrastOf, fillColorsAt, hexRgba, insideShare, luminance, overlapArea, paintColors, roundBox, runs, tweensOf } from "./model.js";

const CONTRAST_FRAMES = 60;
const CONTRAST_WIDTH = 384;
const FLASH_WIDTH = 96;
const FLASH_FRAMES = 90;
// WCAG 2.3.1: a flash is a pair of opposite changes in relative luminance of 10% or more,
// where the darker state is below 0.80; more than 3 a second over about 2.8% of the frame fails.
const FLASH_STEP = 0.1;
const FLASH_AREA = 0.028;
const MAX_FLASHES = 3;
const PIXELS_PER_TEXT = 4000;
// Failing for less than this (a flash or a layer passing behind the text) is a warning.
const BRIEF_SPAN = 0.2;
// At most this many rounds of halving to find where a failing stretch starts and ends, and at
// most SPAN_FRAMES new frames rendered in a round. Edges that share frames (texts that fail at the
// same moment) cost nothing more. An edge not found in time is not guessed: its stretch keeps
// only the frames measured to fail, and it is said to be untimed.
const SPAN_ROUNDS = 12;
const SPAN_FRAMES = 40;

/** WCAG large text: 18 pt, or 14 pt bold, at video scale (48 px, or 36 px bold, at 1080). */
export function contrastRequired(model, item) {
  return requiredRatio(drawnSize(model, item), item.fontWeight, scaleOf(model));
}
// WCAG: 3:1 for large text (48 px at 1080p, or 36 px bold), else 4.5:1.
export const requiredRatio = (size, weight = 400, s = 1) => (size >= 48 * s || (size >= 36 * s && (weight ?? 400) >= 700) ? 3 : 4.5);

/**
 * True when a text's halo shadow alone keeps it readable over any picture: it passes the
 * contrast gate even over pure white and pure black, the worst backdrops. A move that would put
 * a dark box behind its words (caption-words, status-line) leaves it out then (one small
 * shadowed line, no box). `fill` may carry an alpha (a dimmed karaoke word). It asks
 * for room to spare (1 more than the gate, and at least 4.5:1 for large text), since a real
 * offset shadow covers less than the halo the gate assumes: a borderline pass keeps the box.
 */
export function haloAlwaysPasses({ fill, shadow, size, weight, frame }) {
  const ink = hexRgba(fill);
  const halo = haloOf({ shadow }, size);
  if (!ink || !halo) return false;
  const required = Math.max(4.5, requiredRatio(size, weight, Math.min(frame.width, frame.height) / 1080) + 1);
  const alpha = ink[3] / 255;
  return [[255, 255, 255], [0, 0, 0]].every((backdrop) => {
    const [behind] = through([backdrop], halo);
    const seen = behind.map((channel, index) => ink[index] * alpha + channel * (1 - alpha));
    return contrastOf(luminance(seen), luminance(behind)) >= required;
  });
}

// The pixels behind a box in a rendered frame, as [r, g, b] (at most PIXELS_PER_TEXT of them).
// A pixel more than half covered (0 to 255) by a layer in front of a text: the text is hidden there.
const COVERED = 128;

/**
 * How much the layers drawn alone over black (`dark`) and over white (`light`) cover each pixel,
 * 0 to 255: where they are opaque both frames match; where they are absent the frames differ by
 * the whole range.
 */
export function coverMask(dark, light) {
  const count = dark.width * dark.height;
  const mask = new Uint8Array(count);
  let open = false;
  for (let i = 0; i < count; i += 1) {
    const at = i * 4;
    const gap = (light.pixels[at] - dark.pixels[at] + light.pixels[at + 1] - dark.pixels[at + 1] + light.pixels[at + 2] - dark.pixels[at + 2]) / 3;
    if (gap >= 250) open = true;
    mask[i] = Math.max(0, Math.min(255, Math.round(255 - gap)));
  }
  // No uncovered pixel at all: the frames did not change with the background (a renderer that
  // ignores solo and background), so nothing is known to be covered.
  return open ? mask : null;
}

// The text's own turned rectangle inside its upright box (the box of a word turned by `turn` radians
// also holds four corners the word is not in), or null when the text is upright or near 45 degrees.
// From the upright box W x H of a w x h rectangle: W = w|cos| + h|sin|, H = w|sin| + h|cos|.
export function turnedBox(box, turn) {
  if (!Number.isFinite(turn) || Math.abs(Math.sin(turn)) < 0.02) return null;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const [c, s] = [Math.abs(cos), Math.abs(sin)];
  const [W, H] = [box.x1 - box.x0, box.y1 - box.y0];
  const d = c * c - s * s;
  if (Math.abs(d) < 0.2) return null;
  const [w, h] = [(W * c - H * s) / d, (H * c - W * s) / d];
  if (!(w > 0) || !(h > 0)) return null;
  return { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, w, h, cos, sin };
}

export function pixelsBehind(frame, box, modelWidth, turned = null) {
  const k = frame.width / modelWidth;
  const x0 = Math.max(0, Math.floor(box.x0 * k));
  const y0 = Math.max(0, Math.floor(box.y0 * k));
  const x1 = Math.min(frame.width, Math.ceil(box.x1 * k));
  const y1 = Math.min(frame.height, Math.ceil(box.y1 * k));
  const total = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!total) return [];
  const step = Math.max(1, Math.floor(Math.sqrt(total / PIXELS_PER_TEXT)));
  const found = [];
  // frame.cover (coverMask): where a layer in front of the text hides it, what is behind does not count.
  const cover = frame.cover;
  for (let y = y0; y < y1; y += step)
    for (let x = x0; x < x1; x += step) {
      if (cover && cover[y * frame.width + x] > COVERED) continue;
      if (turned) {
        const [dx, dy] = [x / k - turned.cx, y / k - turned.cy];
        if (Math.abs(dx * turned.cos + dy * turned.sin) > turned.w / 2 || Math.abs(dy * turned.cos - dx * turned.sin) > turned.h / 2) continue;
      }
      const at = (y * frame.width + x) * 4;
      found.push([frame.pixels[at], frame.pixels[at + 1], frame.pixels[at + 2]]);
    }
  return found;
}

/** The worst contrast (10th percentile) of a text color, at an opacity, over these pixels. */
export function contrastOver(color, alpha, behind) {
  const ink = hexRgba(color);
  if (!ink || !behind.length) return null;
  const a = Math.max(0, Math.min(1, alpha * (ink[3] / 255)));
  const values = behind.map((pixel) => {
    const shown = [0, 1, 2].map((channel) => ink[channel] * a + pixel[channel] * (1 - a));
    return contrastOf(luminance(shown), luminance(pixel));
  }).sort((x, y) => x - y);
  return values[Math.floor(values.length * 0.1)];
}

// The lowest opacity (to 1%) at which text drawn at `alpha` would pass, or null when it is
// not dimmed or does not pass even when fully opaque.
function opacityThatPasses(worst, alpha, required) {
  if (alpha >= 0.99 || (contrastOver(worst.color, 1, worst.behind) ?? 0) < required) return null;
  let low = alpha, high = 1;
  while (high - low > 0.005) {
    const middle = (low + high) / 2;
    if ((contrastOver(worst.color, middle, worst.behind) ?? 0) >= required) high = middle;
    else low = middle;
  }
  return Math.ceil(high * 100) / 100;
}

const colorDistance = (a, b) => {
  const [x, y] = [hexRgba(a), hexRgba(b)];
  const mean = (x[0] + y[0]) / 2;
  const [dr, dg, db] = [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  return Math.sqrt((2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db);
};

/** Solid colors the scene already uses, plus white and near-black. */
export function paletteOf(model) {
  const colors = new Set(["#ffffff", "#0b0b0c"]);
  for (const paint of [model.background, ...model.items.map((item) => item.fill)])
    for (const color of paintColors(paint)) if ((hexRgba(color)?.[3] ?? 0) === 255) colors.add(color.toLowerCase().slice(0, 7));
  return [...colors];
}

// The fill animation that sets the text's colour at sample `index` (the latest started), or null.
// Changing the layer's own fill does not change that colour. As in engine/animation.js: once an
// animation has started it sets the fill when its To has one (or its From has one, until it
// ends: without a To fill it ends on the layer's own fill); before it starts, only an "in"
// animation with a From fill sets it. A tween without fromKeys and toKeys uses `keys` for both.
function fillTweenAt(model, item, index) {
  const time = model.times[index];
  const setsFill = (tween) => {
    const fromFill = (tween.fromKeys ?? tween.keys).includes("fill");
    const toFill = (tween.toKeys ?? tween.keys).includes("fill");
    return tween.start <= time + 1e-6 ? toFill || (fromFill && time < tween.end - 1e-6) : tween.kind === "in" && fromFill;
  };
  return tweensOf(model, item.id)
    .filter(setsFill)
    .reduce((latest, tween) => (!latest || tween.start >= latest.start ? tween : latest), null);
}

// How opaque the text's fill is at sample `index`: its least opaque colour then (0 for none).
function fillAlphaAt(item, index) {
  const alphas = fillColorsAt(item, index).map((color) => (hexRgba(color)?.[3] ?? 0) / 255);
  return alphas.length ? Math.min(...alphas) : 0;
}

// The runs of samples where the text is readable (analysis.js) and its fill is at 90% or more
// of the most opaque it gets while readable. A fill animation that fades the colour to
// transparent hides the text the way an opacity fade does; a fill that is see-through all along
// is still judged, as dim text.
function shownRuns(model, item) {
  const readable = model.times.map((_, index) => readableAt(model, item, index));
  const alpha = model.times.map((_, index) => fillAlphaAt(item, index));
  const most = alpha.reduce((best, value, index) => (readable[index] ? Math.max(best, value) : best), 0);
  return runs(model.times.length, (index) => readable[index] && alpha[index] >= 0.9 * most);
}

// The sample indexes to render: the middle, ends and quarters of each text's longest shown
// stretch, and the middle of the next longest. The middle comes first so it is always measured.
function contrastRequests(texts, runsOf) {
  const wanted = new Map();
  for (const item of texts) {
    const [longest, next] = [...runsOf.get(item.id)].sort((a, b) => b.length - a.length);
    const picks = [];
    if (longest) {
      const at = (share) => Math.round(longest.from + (longest.to - longest.from) * share);
      picks.push(at(0.5), longest.from, longest.to, at(0.25), at(0.75));
    }
    if (next) picks.push(Math.round((next.from + next.to) / 2));
    wanted.set(item.id, [...new Set(picks)]);
  }
  // Each text's middle frame first, then the rest, up to CONTRAST_FRAMES distinct frames.
  const chosen = new Set();
  const rounds = Math.max(0, ...[...wanted.values()].map((list) => list.length));
  for (let round = 0; round < rounds; round += 1)
    for (const list of wanted.values())
      if (list[round] !== undefined && (chosen.size < CONTRAST_FRAMES || chosen.has(list[round]))) chosen.add(list[round]);
  return { wanted, chosen: [...chosen].sort((a, b) => a - b) };
}

// Layers marked allowOverlap that no text drawn above them ever overlaps: a subject cut out in
// front of its title (cut_out) covers the title on purpose, so it is not what the title is read
// against. They are left out with the texts; a text drawn above one still reads against it.
export function coveringItems(model, texts) {
  const overlaps = (a, b) => model.times.some((_, index) => overlapArea(boxAt(a, index), boxAt(b, index)) > 0);
  return model.items.filter((item) => item.allowOverlap && item.kind !== "text"
    && !texts.some((text) => text.z > item.z && overlaps(text, item))).map((item) => item.id);
}

// The worst contrast of a text's colours (after its fill animations) over a frame at sample
// `index`, as {measured, index, color, behind}, or null when it is not measured there (mostly
// outside the scene, or no colour).
function contrastAt(model, item, index, frame) {
  const box = boxAt(item, index);
  if (!frame || insideShare(model, box) < 0.5) return null;
  // A turned word is read inside its own turned rectangle, not in the corners of its upright box.
  const behind = through(pixelsBehind(frame, box, model.width, turnedBox(box, item.samples.turn?.[index])), haloOf(item, drawnSize(model, item)));
  let worst = null;
  for (const color of fillColorsAt(item, index)) {
    const measured = contrastOver(color, item.samples.opacity[index], behind);
    if (measured !== null && (!worst || measured < worst.measured)) worst = { measured, index, color, behind };
  }
  return worst;
}

// How much what is drawn behind `item` changes from sample index - 1 to index, by the layers
// the contrast frames draw (not `hidden`): each one's share of the text's box times its opacity,
// and its brightness. A layer that appears, fades, slides or changes colour behind the text
// scores; effects, video and particles are not sampled, so a 0 does not mean nothing changed.
function changeBehind(model, item, index, hidden) {
  const textBox = [boxAt(item, index - 1), boxAt(item, index)];
  const size = textBox.map(area);
  if (!(size[0] > 0) || !(size[1] > 0)) return 0;
  let change = 0;
  for (const other of model.items) {
    if (other === item || other.kind === "group" || other.isMask || hidden.has(other.id)) continue;
    if (!other.samples.opacity[index - 1] && !other.samples.opacity[index]) continue;
    const [before, after] = [index - 1, index].map((at, side) => other.samples.opacity[at] * overlapArea(boxAt(other, at), textBox[side]) / size[side]);
    if (!before && !after) continue;
    change += Math.abs(after - before);
    const luma = [other.samples.luma?.[index - 1], other.samples.luma?.[index]];
    if (luma.every(Number.isFinite)) change += Math.min(before, after) * Math.abs(luma[1] - luma[0]);
  }
  return change;
}

// Where each failing stretch of each text starts and ends. `jobs` are {item, required, runs,
// results: Map(sample index -> contrastAt result)} with the measured picks. Picks that fail one
// after another (with no passing pick between them) are one stretch; its edges lie between its
// first and last failing pick and the nearest passing pick, or the end of the shown run. Each
// round renders the frames every open search asks for in one call. A search first tries the
// sample where the layers behind the text change most (a panel shown at 3 s: the frames just
// before and at 3 s), which finds most edges in one round; when those two frames do not hold
// the edge, it halves. Where the text passes and fails more than once between two picks, the
// stretch found can be longer than the real one, never shorter. Each text's first stretch is
// searched before any text's second, and a round renders at most SPAN_FRAMES new frames; a
// search left over waits for the next round. A stretch whose edge is still not found after
// SPAN_ROUNDS keeps the frames measured to fail and is marked `untimed`, so an edge that was not
// searched never makes a failure longer (and an error). `frames` holds the frames already
// rendered, by sample index. Adds the stretches to each job as `spans` [{from, to, untimed?}].
async function failingSpans(model, jobs, render, hidden, frames) {
  const fails = (job, index) => {
    const result = job.results.get(index);
    return Boolean(result) && result.measured < job.required - 1e-9;
  };
  const searches = [];
  for (const job of jobs) {
    job.spans = [];
    let rank = 0;
    for (const run of job.runs) {
      const picks = [...job.results.keys()].filter((index) => index >= run.from && index <= run.to).sort((a, b) => a - b);
      for (let position = 0; position < picks.length; position += 1) {
        if (!fails(job, picks[position])) continue;
        let end = position;
        while (end + 1 < picks.length && fails(job, picks[end + 1])) end += 1;
        const span = { from: picks[position], to: picks[end] };
        job.spans.push(span);
        // lo passes and hi fails (left), or lo fails and hi passes (right).
        searches.push({ job, span, rank, side: "from", lo: position > 0 ? picks[position - 1] : run.from - 1, hi: picks[position] });
        searches.push({ job, span, rank, side: "to", lo: picks[end], hi: end + 1 < picks.length ? picks[end + 1] : run.to + 1 });
        rank += 1;
        position = end;
      }
    }
  }
  // Each text's first stretch first (the sort keeps the texts' order within a rank).
  searches.sort((a, b) => a.rank - b.rank);
  for (const search of searches) {
    if (search.hi - search.lo <= 1) continue;
    let best = 0;
    for (let index = search.lo + 1; index <= search.hi; index += 1) {
      const change = changeBehind(model, search.job.item, index, hidden);
      if (change > best + 1e-9) { best = change; search.likely = index; }
    }
  }
  for (let round = 0; round < SPAN_ROUNDS; round += 1) {
    const open = searches.filter((search) => search.hi - search.lo > 1);
    if (!open.length) break;
    // The likely edge's two frames (on a search's first turn), or the middle. A search whose new
    // frames would pass SPAN_FRAMES waits for the next round.
    const wanted = new Set();
    const active = [];
    for (const search of open) {
      const points = !search.turned && search.likely !== undefined
        ? [search.likely - 1, search.likely].filter((index) => index > search.lo && index < search.hi)
        : [Math.floor((search.lo + search.hi) / 2)];
      const fresh = points.filter((index) => !frames.has(index) && !wanted.has(index));
      if (fresh.length && wanted.size + fresh.length > SPAN_FRAMES) continue;
      for (const index of fresh) wanted.add(index);
      search.points = points;
      search.turned = true;
      active.push(search);
    }
    const list = [...wanted].sort((a, b) => a - b);
    const rendered = list.length ? await render(list) : [];
    list.forEach((index, position) => frames.set(index, rendered[position]));
    for (const search of active) {
      const { job } = search;
      for (const index of search.points) {
        if (index <= search.lo || index >= search.hi) continue;
        if (!job.results.has(index)) job.results.set(index, contrastAt(model, job.item, index, frames.get(index)));
        // Inside the stretch: past its start (from) or before its end (to).
        if (fails(job, index) === (search.side === "from")) search.hi = index;
        else search.lo = index;
      }
    }
  }
  // A finished search gives the edge. An unfinished one keeps the frames measured to fail (hi on
  // the left, lo on the right) and marks the stretch untimed.
  for (const search of searches) {
    const done = search.hi - search.lo <= 1;
    search.span[search.side] = search.side === "from" ? (done ? search.lo + 1 : search.hi) : (done ? search.hi - 1 : search.lo);
    if (!done) search.span.untimed = true;
  }
  // Stretches that met while halving are one.
  for (const job of jobs) {
    const merged = [];
    for (const span of job.spans.sort((a, b) => a.from - b.from)) {
      const previous = merged.at(-1);
      if (previous && span.from <= previous.to + 1) {
        previous.to = Math.max(previous.to, span.to);
        if (span.untimed) previous.untimed = true;
      } else merged.push({ ...span });
    }
    job.spans = merged;
  }
}

// Whether a layer is behind the text at sample `index` only briefly: drawn over the text's box
// there, for less than BRIEF_SPAN all told (a flash at 3 s while the text fails all along over a
// panel). Layers in `hidden` are not in the contrast frames. Uses the model's samples, so a
// change inside a video or an effect is not seen.
function brieflyBehind(model, item, index, hidden) {
  for (const other of model.items) {
    if (other === item || other.kind === "group" || other.isMask || hidden.has(other.id)) continue;
    const over = (at) => other.samples.opacity[at] > 0.01 && overlapArea(boxAt(other, at), boxAt(item, at)) > 0;
    if (!over(index)) continue;
    let from = index, to = index;
    while (from > 0 && over(from - 1)) from -= 1;
    while (to + 1 < model.times.length && over(to + 1)) to += 1;
    const { start, end } = spanTimes(model, { from, to });
    if (end - start < BRIEF_SPAN - 1e-9) return true;
  }
  return false;
}

// When a stretch of samples starts and ends: from its first sample to the next one's time, and
// no later than the scene's end (the last sample is at the end).
function spanTimes(model, span) {
  const start = model.times[span.from];
  return { start, end: Math.min(model.duration, model.times[span.to] + 1 / model.fps) };
}

// "1.5–1.6 s (0.1 s)" for a stretch of samples; "(at least 0.1 s, not timed)" when its edges
// were not all found.
function spanText(model, span) {
  const { start, end } = spanTimes(model, span);
  return `${sec(start)}–${sec(end)} s (${span.untimed ? `at least ${sec(end - start)} s, not timed` : `${sec(end - start)} s`})`;
}

// A text shadow that acts as a halo counts as the text's background (WCAG 1.4.3: a wide border
// around the letters is background): a dark shadow of 60% opacity or more, offset at most 8% of
// the type size and blurred at least 10% of it. It covers about HALO_COVER of the pixels around
// the strokes, so it darkens what is behind by its opacity times that.
export const HALO_COVER = 0.75;
export function haloOf(item, size) {
  const rgba = item.shadow?.color ? hexRgba(item.shadow.color) : null;
  if (!rgba || !(size > 0)) return null;
  const alpha = rgba[3] / 255;
  if (alpha < 0.6 || Math.hypot(item.shadow.x ?? 0, item.shadow.y ?? 0) > 0.08 * size || (item.shadow.blur ?? 0) < 0.1 * size) return null;
  return { rgb: rgba.slice(0, 3), alpha: alpha * HALO_COVER };
}
// The pixels behind, seen through a layer of one colour at an opacity (a scrim, a halo).
export const through = (behind, layer) => (layer ? behind.map((pixel) => [0, 1, 2].map((channel) => layer.rgb[channel] * layer.alpha + pixel[channel] * (1 - layer.alpha))) : behind);
// The scrim strengths and the halo contrastFixes tries (legible.js tries the same, in the same order).
export const SCRIM_ALPHAS = [0.35, 0.5, 0.65, 0.8];
export const HALO = { color: "#000000d9", alpha: 0.85 };
// The halo shadow that stays a halo (haloOf) and is not a glow (text_glow: blur of 12 px at 1080 or more with
// an offset of 3 px or less): the 25% blur, kept under the glow blur, or for very large type a 4 px drop.
export function haloShadow(size, scale = 1) {
  const blur = Math.round(size * 0.25);
  const glowAt = 12 * scale;
  if (blur < glowAt) return { x: 0, y: 0, blur };
  const under = Math.ceil(glowAt) - 1;
  if (under >= 0.1 * size) return { x: 0, y: 0, blur: under };
  return { x: 0, y: Math.floor(3 * scale) + 1, blur };
}
const alphaHex = (alpha) => Math.round(alpha * 255).toString(16).padStart(2, "0");

// The fixes for a text no scene colour can rescue, in the order a designer tries them (FRICTION
// #19: a solid caption box on every caption flattens the edit): a scrim gradient under the text,
// a halo shadow, a darker place in the frame, a size that counts as large text (3:1), and only
// then a solid plate. Each is measured on the worst frame; the ones that pass come first, the
// plate always last. Returns the hint text.
function contrastFixes(model, item, worst, required, frame, name) {
  const size = drawnSize(model, item);
  const alpha = item.samples.opacity[worst.index];
  const passes = (behind) => (contrastOver(worst.color, alpha, behind) ?? 0) >= required;
  const box = boxAt(item, worst.index);
  const margin = Math.round(size * 0.6);
  const text = name.replace(/^"(.*)"$/, "$1");
  const found = [];
  const scrim = SCRIM_ALPHAS.find((value) => passes(through(worst.behind, { rgb: [0, 0, 0], alpha: value })));
  if (scrim) {
    // Full width, from just past the text to the nearer frame edge, solid where the text sits.
    const low = (box.y0 + box.y1) / 2 > model.height / 2;
    const y = Math.max(0, Math.round(low ? box.y0 - 2 * margin : 0));
    const height = Math.round(low ? model.height - y : Math.min(model.height, box.y1 + 2 * margin) - y);
    const fade = Math.min(0.9, Math.round(((2 * margin) / Math.max(1, height)) * 100) / 100);
    const solid = `#000000${alphaHex(scrim)}`;
    const stops = low ? [{ offset: 0, color: "#00000000" }, { offset: fade, color: solid }, { offset: 1, color: solid }] : [{ offset: 0, color: solid }, { offset: 1 - fade, color: solid }, { offset: 1, color: "#00000000" }];
    found.push(`a scrim gradient: ${JSON.stringify([{ op: "add_layer", layerType: "rectangle", name: `${text}-scrim`, properties: { x: 0, y, width: model.width, height, fill: { type: "linear", angle: 90, stops } } }, { op: "move_layers", layers: [`${text}-scrim`], position: "below", referenceId: text }])}`);
  }
  if (passes(through(worst.behind, { rgb: [0, 0, 0], alpha: HALO.alpha * HALO_COVER })))
    {
    const { x, y, blur } = haloShadow(size, scaleOf(model));
    found.push(`a halo shadow: update_layer ${text} {shadow:{color:"${HALO.color}", x:${x}, y:${y}, blur:${blur}}}`);
  }
  if (frame) {
    // The nearest height (same x) where what is behind passes, at most the frame's middle 80%.
    const height = box.y1 - box.y0;
    const places = [];
    for (let y = model.height * 0.1; y + height <= model.height * 0.9; y += model.height * 0.05) places.push(Math.round(y));
    const place = places.map((y) => ({ y, dy: y - box.y0 })).filter((entry) => Math.abs(entry.dy) >= height / 2)
      .sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy))
      .find((entry) => passes(pixelsBehind(frame, { ...box, y0: entry.y, y1: entry.y + height }, model.width)));
    if (place) found.push(`a darker place: move ${text} ${Math.abs(Math.round(place.dy))} px ${place.dy < 0 ? "up" : "down"}`);
  }
  const s = scaleOf(model);
  const large = (item.fontWeight ?? 400) >= 700 ? 36 * s : 48 * s;
  if (required > 3 && worst.measured >= 3 && item.fontSize > 0)
    found.push(`a size that counts as large text (3:1): fontSize ${Math.ceil((item.fontSize * large) / size)}`);
  const plate = `a solid plate: ${JSON.stringify(plateOps(model, item, worst, name))}`;
  return found.length
    ? `Try, in order: ${found.join("; or ")}. Only if none fits, ${plate}.`
    : `No scrim, halo shadow, darker place or size passes here: put ${plate} (give it the text's entrance and exit), or darken or blur what is behind it.`;
}

// The ops that put a solid plate behind a text: a rectangle around its box (with a margin of
// about a third of its size) in the scene colour that contrasts most with the text's colour, then
// moved just below the text.
function plateOps(model, item, worst, name) {
  const [x, y, width, height] = roundBox(boxAt(item, worst.index));
  const margin = Math.round(drawnSize(model, item) * 0.3);
  const ink = hexRgba(worst.color);
  const against = (color) => contrastOf(luminance(hexRgba(color)), luminance(ink));
  const fill = paletteOf(model).reduce((best, color) => (against(color) > against(best) ? color : best), "#0b0b0c");
  const text = name.replace(/^"(.*)"$/, "$1");
  const plate = `${text}-plate`;
  return [
    { op: "add_layer", layerType: "rectangle", name: plate, properties: { x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin, fill } },
    { op: "move_layers", layers: [plate], position: "below", referenceId: text },
  ];
}

export async function contrast(model, ctx) {
  if (!ctx.renderFrames) return [];
  const texts = readingTexts(model).filter((item) => model.times.some((_, index) => fillColorsAt(item, index).length));
  if (!texts.length) return [];
  const runsOf = new Map(texts.map((item) => [item.id, shownRuns(model, item)]));
  const { wanted, chosen } = contrastRequests(texts, runsOf);
  if (!chosen.length) return [];
  // A move's color overlay (accent-hit, light-sweep) is the text itself in another color, not what is behind it.
  const hide = [...readingTexts(model).map((item) => item.id), ...coveringItems(model, readingTexts(model)), ...model.items.filter((item) => item.overlay).map((item) => item.id)];
  const width = Math.min(CONTRAST_WIDTH, model.width);
  const behindFrames = (indexes) => ctx.renderFrames(indexes.map((index) => model.times[index]), { width, hide });
  // A layer in front of a text on purpose (a cut-out person before a word) hides part of it: those
  // pixels are not read, so the person standing over the word is not "what is behind it".
  const covering = coveringItems(model, readingTexts(model));
  const render = !covering.length ? behindFrames : async (indexes) => {
    const frames = await behindFrames(indexes);
    const times = indexes.map((index) => model.times[index]);
    const dark = await ctx.renderFrames(times, { width, solo: covering, background: "#000000" });
    const light = await ctx.renderFrames(times, { width, solo: covering, background: "#ffffff" });
    return frames.map((frame, position) => {
      const [a, b] = [dark?.[position], light?.[position]];
      const cover = a && b && a.width === frame.width && b.width === frame.width ? coverMask(a, b) : null;
      return cover ? { ...frame, cover } : frame;
    });
  };
  const frames = await render(chosen);
  const frameAt = new Map(chosen.map((index, position) => [index, frames[position]]));
  const jobs = [];
  for (const item of texts) {
    const required = contrastRequired(model, item);
    const picks = wanted.get(item.id) ?? [];
    const results = new Map();
    for (const index of picks) {
      const result = contrastAt(model, item, index, frameAt.get(index));
      if (result) results.set(index, result);
    }
    if ([...results.values()].some((result) => result.measured < required - 1e-9))
      jobs.push({ item, required, runs: runsOf.get(item.id), results });
  }
  // How long each failure lasts: under BRIEF_SPAN (a flash behind the text) is a warning.
  const hidden = new Set(hide);
  await failingSpans(model, jobs, render, hidden, frameAt);
  const findings = [];
  for (const { item, required, runs: shown, results, spans } of jobs) {
    const worstOf = (list) => list.reduce((best, result) => (!best || result.measured < best.measured ? result : best), null);
    const longest = shown.reduce((best, run) => Math.max(best, run.length), 0);
    const seconds = (span) => { const { start, end } = spanTimes(model, span); return end - start; };
    const lasting = spans.filter((span) => seconds(span) >= BRIEF_SPAN - 1e-9);
    const inside = (result, list) => list.some((span) => result.index >= span.from && result.index <= span.to);
    const measured = [...results.values()].filter(Boolean);
    // With a failure that lasts, the frames judged are the ones inside it, without a frame where
    // a layer is behind the text only briefly: a flash at 3 s while the text fails all along
    // over a panel gave the time, the contrast and a fill that passes only against the flash.
    // The time and contrast reported, the colour and the opacity that pass come from these.
    // Decided from the measured stretches, never from which picks failed. Persistence: every
    // failing stretch touches the start or end of a shown run and lasts under BRIEF_SPAN, so the
    // text is readable a moment before (or after) what is behind it settles. A stretch at an edge
    // that lasts longer (a light panel behind the text for its first 4.6 s) is an error.
    const atEdge = (span) => shown.some((run) => span.from <= run.to && span.to >= run.from && (span.from <= run.from || span.to >= run.to));
    const brief = !lasting.length && spans.length > 0 && spans.every(atEdge);
    const flash = !brief && !lasting.length;
    // A short stretch that runs to the end of the text's shown time never passes once settled:
    // the text leaves (or the scene ends) on it (a light panel fades in behind white text 0.1 s
    // before the text goes out). Its frames are the ones judged, and the fix is a colour or a
    // plate, not a later entrance.
    const atRunEnd = brief ? spans.filter((span) => shown.some((run) => span.from <= run.to && span.to >= run.to)) : [];
    const atSceneEnd = atRunEnd.some((span) => spanTimes(model, span).end >= model.duration - 1e-9);
    const settles = brief && !atRunEnd.length;
    const inLasting = measured.filter((result) => inside(result, lasting));
    const steady = inLasting.filter((result) => !brieflyBehind(model, item, result.index, hidden));
    const inEnd = measured.filter((result) => inside(result, atRunEnd));
    const judged = inEnd.length ? inEnd : !lasting.length ? measured : steady.length ? steady : inLasting;
    const worst = worstOf(judged);
    const alpha = item.samples.opacity[worst.index];
    // A colour must pass at every judged frame. The nearest one that passes at every frame
    // measured comes first, then one that passes everywhere but at a brief flash, then the
    // rest. Only the first two kinds are applied by fix:"auto": another colour makes a new
    // failure where the text passes now, which the next check would undo.
    const passesAll = (color, list) => list.every((result) => (contrastOver(color, item.samples.opacity[result.index], result.behind) ?? 0) >= required);
    const passingNow = measured.filter((result) => !inside(result, spans));
    const tier = (color) => (passesAll(color, measured) ? 0 : passesAll(color, passingNow) ? 1 : 2);
    const tiers = new Map(paletteOf(model).filter((color) => passesAll(color, judged)).map((color) => [color, tier(color)]));
    const passing = [...tiers.keys()].sort((a, b) => tiers.get(a) - tiers.get(b) || colorDistance(a, worst.color) - colorDistance(b, worst.color));
    const everywhere = passing.filter((color) => tiers.get(color) < 2);
    const opacities = judged.map((result) => opacityThatPasses(result, item.samples.opacity[result.index], required));
    const opacity = opacities.every((value) => value !== null) ? Math.max(...opacities) : null;
    const fillTween = fillTweenAt(model, item, worst.index);
    const percent = (value) => `${Math.round(value * 100)}%`;
    const color = alpha < 0.99 ? `${worst.color} at ${percent(alpha)} opacity` : worst.color;
    const listed = spans.slice(0, 3).map((span) => spanText(model, span)).join(", ");
    const untimed = spans.some((span) => span.untimed);
    // The colour fix is shown last, so say when it holds only where the text fails.
    const partColour = !settles && !flash && !opacity && !fillTween && passing.length && !everywhere.length
      ? ` ${passing[0]} passes there but not everywhere it shows; a solid plate behind it works everywhere.` : "";
    const failsFor = `It fails at ${listed}${spans.length > 3 ? ` and ${spans.length - 3} more` : ""}${atSceneEnd ? ", until the scene ends" : atRunEnd.length ? ", until it leaves" : ""}.${partColour}`;
    findings.push({
      rule: "contrast", severity: longest <= 2 ? "info" : brief || flash ? "warn" : "error", itemId: item.id, at: sec(model.times[worst.index]), bbox: roundBox(boxAt(item, worst.index)),
      measured: Math.round(worst.measured * 100) / 100, required,
      message: settles
        ? `${ctx.name(item)} (${color}) is fully shown at ${sec(model.times[worst.index])}s while what is behind it still changes: ${Math.round(worst.measured * 100) / 100}:1 contrast there, ${required}:1 needed. ${failsFor.slice(0, -1)}${untimed ? "" : `, under ${BRIEF_SPAN} s each time, and passes once settled`}.`
        : `${ctx.name(item)} (${color}) has ${Math.round(worst.measured * 100) / 100}:1 contrast with what is behind it at ${sec(model.times[worst.index])}s; it needs ${required}:1. ${failsFor}`,
      fix: settles
        ? { kind: "hint", text: "Bring the text in after what is behind it has settled, or fade it in more slowly." }
        : flash
        ? { kind: "hint", text: untimed
          ? `Too many texts fail in this scene to time each one: fix the others and check again to see how long ${ctx.name(item)} fails.`
          : `It fails only briefly (each time under ${BRIEF_SPAN} s), as when a flash or a passing layer is behind it. Leave it if that is on purpose, or keep the flash off the text.` }
        // Dimmed text that would pass when more opaque: say so, rather than change its colour.
        : opacity
        ? { kind: "hint", text: `At ${percent(opacity)} opacity or more it passes. Raise the opacity of ${ctx.name(item)} (or of its group), or give it a full-opacity colour that passes.` }
        : fillTween
        ? { kind: "hint", text: `Its colour there comes from its animation "${fillTween.name}". Change that animation's fill${passing.length ? ` (${passing[0]} is the nearest colour in the scene that passes)` : ""}, or put a solid plate behind the text.` }
        : everywhere.length
        ? { kind: "item", itemId: item.id, properties: { fill: everywhere[0] }, auto: true, why: `${everywhere[0]} is the nearest colour in the scene that passes` }
        // A colour that passes only where it fails now would fail where it passes now, and the
        // next check would give the first colour back: give the plate instead, not a fill op.
        : { kind: "hint", text: `${passing.length ? `No one colour passes everywhere it shows (${passing[0]} passes where it fails, then fails where it passes now)` : `No colour in the scene passes ${lasting.length ? "over the whole failing stretch" : "here"}`}. `
          + contrastFixes(model, item, worst, required, frameAt.get(worst.index), ctx.name(item)) },
    });
  }
  return findings;
}

// How many opposite luminance changes of FLASH_STEP or more happen in `values`, where the
// darker side is below 0.8. Returns the sample indexes where each change completes.
export function transitions(values) {
  const found = [];
  let direction = 0;
  let low = values[0];
  let high = values[0];
  // `peak` is the highest value while rising and the lowest while falling.
  let peak = values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (direction === 0) {
      low = Math.min(low, value);
      high = Math.max(high, value);
      if (value - low >= FLASH_STEP && low < 0.8) { found.push(index); direction = 1; peak = value; }
      else if (high - value >= FLASH_STEP && value < 0.8) { found.push(index); direction = -1; peak = value; }
    } else if (direction === 1) {
      if (value > peak) peak = value;
      else if (peak - value >= FLASH_STEP && value < 0.8) { found.push(index); direction = -1; peak = value; }
    } else if (value < peak) peak = value;
    else if (value - peak >= FLASH_STEP && peak < 0.8) { found.push(index); direction = 1; peak = value; }
  }
  return found;
}

const mostInOneSecond = (indexes, fps) => {
  let best = 0;
  for (let first = 0; first < indexes.length; first += 1) {
    let last = first;
    while (last + 1 < indexes.length && indexes[last + 1] - indexes[first] < fps) last += 1;
    best = Math.max(best, last - first + 1);
  }
  return best;
};

// Windows (sample ranges) where a large item's opacity or brightness swings fast enough to flash.
export function flashCandidates(model) {
  const frame = model.width * model.height;
  const windows = [];
  // Opacity changes of every big layer that is not a clip or a picture, merged: flat frames made by
  // separate layers or moves (each alone under the rate) are one run when they are close together.
  const merged = new Map();
  for (const item of model.items) {
    if (item.isMask || item.kind === "group") continue;
    const big = (index) => item.samples.opacity[index] > 0.05 && area(boxAt(item, index)) * insideShare(model, boxAt(item, index)) >= FLASH_AREA * frame;
    if (!item.samples.opacity.some((_, index) => big(index))) continue;
    if (item.kind !== "video" && item.kind !== "image")
      for (const index of transitions(Array.from(item.samples.opacity, (value, at) => (big(at) ? value : 0)))) if (!merged.has(index)) merged.set(index, item.id);
    // Particles that twinkle faster than 3 times a second (samples.flickerHz) can flash while
    // their layer holds still. Their twinkle is steady, so one second where it is strongest is
    // scanned (about 1.3 s of rendering at 30 fps instead of 2.3 s for three).
    const twinkling = item.samples.flickerHz ? model.times.map((_, index) => index).filter((index) => item.samples.flickerHz[index] > MAX_FLASHES && big(index)) : [];
    if (twinkling.length) {
      const peak = twinkling.reduce((best, index) => (item.samples.flicker[index] > item.samples.flicker[best] ? index : best));
      const from = Math.max(twinkling[0], Math.min(peak - Math.floor(model.fps / 2), twinkling.at(-1) - model.fps));
      windows.push({ from, to: Math.min(twinkling.at(-1), from + model.fps), itemId: item.id });
    }
    const series = [Array.from(item.samples.opacity)];
    if (item.samples.luma.some((value) => Number.isFinite(value))) series.push(Array.from(item.samples.luma, (value, index) => (Number.isFinite(value) ? value * item.samples.opacity[index] : 0)));
    for (const values of series) {
      const changes = transitions(values);
      // Six changes (three flashes) a second is the most allowed; more is a candidate.
      if (mostInOneSecond(changes, model.fps) <= 2 * MAX_FLASHES) continue;
      windows.push({ from: Math.max(0, changes[0] - 1), to: Math.min(model.times.length - 1, changes.at(-1) + 1), itemId: item.id });
    }
  }
  // Each merged run over the rate (more than 6 changes in a second), added when no window of one
  // layer already covers it; the scan goes on after a run, so a second run later is seen too.
  const changes = [...merged.keys()].sort((a, b) => a - b);
  for (let first = 0; first + 2 * MAX_FLASHES < changes.length; first += 1) {
    const last = first + 2 * MAX_FLASHES;
    if (changes[last] - changes[first] >= model.fps) continue;
    let end = last;
    while (end + 1 < changes.length && changes[end + 1] - changes[first] < model.fps) end += 1;
    const from = Math.max(0, changes[first] - 1);
    const to = Math.min(model.times.length - 1, changes[end] + 1);
    if (!windows.some((window) => window.from <= from && window.to >= to)) windows.push({ from, to, itemId: merged.get(changes[first]) });
    first = end;
  }
  return windows;
}

export async function flashing(model, ctx) {
  const videos = model.items.filter((item) => item.kind === "video" && item.samples.opacity.some((value) => value > 0.05));
  if (videos.length) ctx.note?.("flashing: the picture inside video layers is not scanned, only layer changes");
  const windows = flashCandidates(model);
  if (!windows.length || !ctx.renderFrames) return [];
  const indexes = new Set();
  for (const window of windows) for (let index = window.from; index <= window.to && indexes.size < FLASH_FRAMES; index += 1) indexes.add(index);
  const list = [...indexes].sort((a, b) => a - b);
  const frames = await ctx.renderFrames(list.map((index) => model.times[index]), { width: Math.min(FLASH_WIDTH, model.width), hide: [] });
  if (!frames.length) return [];
  const { width, height } = frames[0];
  const pixelCount = width * height;
  let flashingPixels = 0;
  let worst = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const values = frames.map((frame) => luminance([frame.pixels[pixel * 4], frame.pixels[pixel * 4 + 1], frame.pixels[pixel * 4 + 2]]));
    const changes = transitions(values).map((position) => list[position]);
    const flashes = Math.floor(mostInOneSecond(changes, model.fps) / 2);
    worst = Math.max(worst, flashes);
    if (flashes > MAX_FLASHES) flashingPixels += 1;
  }
  const share = flashingPixels / pixelCount;
  if (share < FLASH_AREA) return [];
  const first = windows[0];
  return [{
    rule: "flashing", severity: "error", itemId: first.itemId, at: sec(model.times[first.from]), until: sec(model.times[first.to]),
    measured: `${worst} flashes a second over ${Math.round(share * 1000) / 10}% of the frame`, required: `at most ${MAX_FLASHES} a second over ${Math.round(FLASH_AREA * 1000) / 10}%`,
    message: `The picture flashes ${worst} times a second over ${Math.round(share * 1000) / 10}% of the frame from ${sec(model.times[first.from])}s; more than 3 a second can trigger seizures.`,
    fix: { kind: "hint", text: "Slow the flicker to 3 or fewer changes a second, make the flashing area smaller, or lower the brightness change." },
  }];
}
