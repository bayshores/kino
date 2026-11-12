// Static overlays on a found clip: a channel mark, a translucent watermark or a logo drawn over the
// picture, found without reading letters (it works on any system, and on a faint mark the text
// reader misses). Across the frames the burned-text reader already decodes (backend/footage/
// burned-text.mjs, every READ_STEP s), a pixel belongs to an overlay when its edge keeps the same
// direction and strength on most frames (the overlay's shape) while the picture around it changes
// (its brightness over time varies at least as much as the clip's own typical pixel). A still shot
// gives nothing: with no change behind, a mark cannot be told from the scene.
//
// Measured on round-5 found clips (2026-11-12): a translucent mark 5-29% across, 78-96% down over a
// running figure and a still wall, and a site name 1-9% across, 1-4% down.

/** Width (pixels) the frames are shrunk to before the edges are measured (a guess: a 4% high mark is 7 px). */
export const OVERLAY_WIDTH = 320;
/** Fewest frames to judge a clip by (a guess: under 4 a held drawing looks static). */
export const OVERLAY_FRAMES_LEAST = 4;
/** Least edge strength (gray levels over 2 px, mean over frames) that counts (a guess: a faint watermark measured 6 to 20). */
const EDGE_LEAST = 5;
/** Least steadiness of an edge: |mean gradient|^2 over mean |gradient|^2, 1 for an unchanging edge (a guess). */
const STEADY_LEAST = 0.55;
/** Picture change near the pixel (brightness std over time, 5x5 window max) against the clip's median pixel change. */
const CHANGE_AGAINST_MEDIAN = 1;
/** ... and never under this many gray levels (a still clip finds nothing). */
const CHANGE_LEAST = 6;
/** Least share of the frame's pixels an overlay holds (on the shrunk frame) to be named. */
const AREA_LEAST = 0.0004;
/** An overlay box at most this share of the frame wide and high, ... */
export const OVERLAY_MOST = [0.4, 0.3];
/** ... at least this share on each side (a thinner line is a bar's edge or a speck), ... */
const OVERLAY_LEAST = 0.02;
/** ... and within this share of one frame edge (wider than the text mark rule: a large watermark reaches 23% up). */
export const OVERLAY_EDGE = 0.25;
/** Share of the frames where the picture at a pixel moved on which its edge must still hold (a guess). */
const KEPT_WHEN_MOVED = 0.8;
/** Least share of the frames read that hold it (a guess: the round-5 mark held 80 to 100%). */
const HELD_LEAST = 0.75;
/** A frame "holds" the overlay when this share of its pixels show the overlay's edge. */
const FRAME_HOLDS = 0.5;
/** A black bar (letterbox or pillarbox): rows or columns from a frame edge whose pixels never pass this gray level ... */
const BAR_DARK = 16;
/** ... on at least this share of the row or column (a site name written inside a bar leaves the rest dark). */
const BAR_SHARE = 0.6;
/** Pixels this close to a bar's inner edge are the bar's edge, not a mark (the edge is measured over 2 px on a shrunk frame). */
const BAR_NEAR = 3;

/**
 * The black bars of a clip from each pixel's largest gray level over the frames: how many rows from the
 * top and bottom, and columns from the left and right, stay dark on every frame: {top, bottom, left, right}.
 * Measured on a 2.35:1 film in a 16:9 file (2026-11-12): bar rows never passed 14, the first picture row reached 65.
 */
export function blackBars(most, { width: W, height: H }) {
  const darkRow = (y) => { let dark = 0; for (let x = 0; x < W; x += 1) if (most[y * W + x] <= BAR_DARK) dark += 1; return dark >= BAR_SHARE * W; };
  const darkColumn = (x) => { let dark = 0; for (let y = 0; y < H; y += 1) if (most[y * W + x] <= BAR_DARK) dark += 1; return dark >= BAR_SHARE * H; };
  const run = (length, dark, at) => { let count = 0; while (count < length / 2 && dark(at(count))) count += 1; return count; };
  return {
    top: run(H, darkRow, (index) => index), bottom: run(H, darkRow, (index) => H - 1 - index),
    left: run(W, darkColumn, (index) => index), right: run(W, darkColumn, (index) => W - 1 - index),
  };
}

/**
 * Shrinks one BGRA frame (width x height) to gray at `out` size (box average): a Uint8Array.
 */
export function grayOf(bgra, width, height, out) {
  const gray = new Uint8Array(out.width * out.height);
  for (let oy = 0; oy < out.height; oy += 1) {
    const y0 = Math.floor((oy * height) / out.height), y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / out.height));
    for (let ox = 0; ox < out.width; ox += 1) {
      const x0 = Math.floor((ox * width) / out.width), x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / out.width));
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * 4;
        sum += 0.114 * bgra[at] + 0.587 * bgra[at + 1] + 0.299 * bgra[at + 2];
        count += 1;
      }
      gray[oy * out.width + ox] = Math.round(sum / count);
    }
  }
  return gray;
}

/** The size frames of a width x height clip are shrunk to. */
export function overlaySize(width, height) {
  const wide = Math.min(OVERLAY_WIDTH, width);
  return { width: wide, height: Math.max(8, Math.round((wide * height) / width)) };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * The static overlays across gray frames (each a Uint8Array of size.width x size.height):
 * {frames, overlays: [{box: [x, y, w, h] fractions, frames (frames holding it), share (0-1)}], still?}.
 * `still` is set when the picture behind barely changes (nothing can be told apart then).
 */
export function staticOverlays(frames, size) {
  const { width: W, height: H } = size;
  const n = frames.length;
  if (n < OVERLAY_FRAMES_LEAST) return { frames: n, overlays: [], few: true };
  const count = W * H;
  const sumX = new Float64Array(count), sumY = new Float64Array(count), sumMag2 = new Float64Array(count), sumMag = new Float64Array(count);
  const sumI = new Float64Array(count), sumI2 = new Float64Array(count);
  const most = new Uint8Array(count);
  for (const gray of frames) {
    for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) {
      const at = y * W + x;
      const gx = gray[at + 1] - gray[at - 1], gy = gray[at + W] - gray[at - W];
      sumX[at] += gx; sumY[at] += gy;
      const mag2 = gx * gx + gy * gy;
      sumMag2[at] += mag2; sumMag[at] += Math.sqrt(mag2);
    }
    for (let at = 0; at < count; at += 1) { sumI[at] += gray[at]; sumI2[at] += gray[at] * gray[at]; if (gray[at] > most[at]) most[at] = gray[at]; }
  }
  const change = new Float32Array(count);
  for (let at = 0; at < count; at += 1) { const mean = sumI[at] / n; change[at] = Math.sqrt(Math.max(0, sumI2[at] / n - mean * mean)); }
  const sorted = Float32Array.from(change).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  const floor = Math.max(CHANGE_LEAST, median * CHANGE_AGAINST_MEDIAN);
  // The most change within 2 px (a 5x5 window): an opaque logo does not change inside, its surroundings do.
  const near = new Float32Array(count);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    let most = 0;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W && change[yy * W + xx] > most) most = change[yy * W + xx];
    }
    near[y * W + x] = most;
  }
  const mask = new Uint8Array(count);
  let steadyPixels = 0;
  const candidates = [];
  // A black bar's inner edge holds still over a changing picture exactly as a mark does: it is left out.
  const bars = blackBars(most, size);
  const atBar = (x, y) => (bars.top && Math.abs(y - bars.top) <= BAR_NEAR) || (bars.bottom && Math.abs(y - (H - 1 - bars.bottom)) <= BAR_NEAR)
    || (bars.left && Math.abs(x - bars.left) <= BAR_NEAR) || (bars.right && Math.abs(x - (W - 1 - bars.right)) <= BAR_NEAR);
  for (let y = 2; y < H - 2; y += 1) for (let x = 2; x < W - 2; x += 1) {
    const at = y * W + x;
    if (atBar(x, y)) continue;
    if (sumMag[at] / n < EDGE_LEAST || !(sumMag2[at] > 0)) continue;
    const steady = (sumX[at] * sumX[at] + sumY[at] * sumY[at]) / (n * sumMag2[at]);
    if (steady < STEADY_LEAST) continue;
    steadyPixels += 1;
    if (near[at] >= floor) candidates.push(at);
  }
  // The test that tells a mark from a still wall: on the frames where the picture at or beside the
  // pixel (2 px away) moved off its mean, the edge still holds. A wall's edge is hidden when a figure
  // passes over it; a mark's edge is drawn on top.
  const mean = new Float32Array(count);
  for (let at = 0; at < count; at += 1) mean[at] = sumI[at] / n;
  const around = [0, 2, -2, 2 * W, -2 * W];
  for (const at of candidates) {
    const mx = sumX[at] / n, my = sumY[at] / n;
    let moved = 0, kept = 0;
    for (const gray of frames) {
      if (!around.some((offset) => Math.abs(gray[at + offset] - mean[at + offset]) >= floor)) continue;
      moved += 1;
      const gx = gray[at + 1] - gray[at - 1], gy = gray[at + W] - gray[at - W];
      if (gx * mx + gy * my >= 0.5 * (mx * mx + my * my)) kept += 1;
    }
    if (moved >= 2 && kept >= KEPT_WHEN_MOVED * moved) mask[at] = 1;
  }
  if (median < CHANGE_LEAST / 2) return { frames: n, overlays: [], still: true };
  // Join the mask's pixels within 3 px (letters of one word, an icon beside a name) into places.
  const label = new Int32Array(count).fill(-1);
  const places = [];
  const reach = Math.max(3, Math.round(W / 50));
  for (let start = 0; start < count; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    const place = { x0: W, y0: H, x1: 0, y1: 0, pixels: [] };
    const stack = [start];
    label[start] = places.length;
    while (stack.length) {
      const at = stack.pop();
      const x = at % W, y = (at - x) / W;
      place.pixels.push(at);
      place.x0 = Math.min(place.x0, x); place.y0 = Math.min(place.y0, y); place.x1 = Math.max(place.x1, x + 1); place.y1 = Math.max(place.y1, y + 1);
      for (let dy = -reach; dy <= reach; dy += 1) for (let dx = -reach; dx <= reach; dx += 1) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
        const next = yy * W + xx;
        if (mask[next] && label[next] < 0) { label[next] = places.length; stack.push(next); }
      }
    }
    places.push(place);
  }
  const overlays = [];
  for (const place of places) {
    if (place.pixels.length < AREA_LEAST * count) continue;
    const w = (place.x1 - place.x0) / W, h = (place.y1 - place.y0) / H;
    // Sized and placed like a mark (a still wall's edge mid-picture is not one): measured on round-5
    // clips, the reader's other steady places were mid-picture, over 40% high or under 2% a side.
    if (w > OVERLAY_MOST[0] || h > OVERLAY_MOST[1] || w < OVERLAY_LEAST || h < OVERLAY_LEAST) continue;
    const x = place.x0 / W, y = place.y0 / H;
    if (!(x + w <= OVERLAY_EDGE || x >= 1 - OVERLAY_EDGE || y + h <= OVERLAY_EDGE || y >= 1 - OVERLAY_EDGE)) continue;
    // The frames that hold it: most of its pixels show an edge along the mean edge.
    let held = 0;
    for (const gray of frames) {
      let agree = 0;
      for (const at of place.pixels) {
        const mx = sumX[at] / n, my = sumY[at] / n;
        const gx = gray[at + 1] - gray[at - 1], gy = gray[at + W] - gray[at - W];
        if (gx * mx + gy * my >= 0.5 * (mx * mx + my * my)) agree += 1;
      }
      if (agree >= FRAME_HOLDS * place.pixels.length) held += 1;
    }
    if (held < Math.max(2, HELD_LEAST * n)) continue;
    overlays.push({ box: [x, y, w, h].map(round3), frames: held, pixels: place.pixels.length });
  }
  overlays.sort((a, b) => b.pixels - a.pixels);
  return { frames: n, overlays: overlays.slice(0, 3).map(({ box, frames: held }) => ({ box, frames: held })) };
}
