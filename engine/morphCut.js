// Morph cut: hides the jump where a slip was cut out of on-camera talk. Over a short window
// centered on the join, the picture is an optical-flow in-between of the last frame before the
// cut and the first frame after it, so the face slides into place instead of jumping.
//
// The flow and the in-between frame are ported from ArtCraft (MIT OR Apache-2.0,
// github.com/storytold/artcraft), filmcraft/crates/render/src/flow.rs, which FilmCraft's
// "morph_cut" transition (filmcraft/crates/render/src/transitions/dissolve.rs) calls:
//   1. dense flow both ways: Lucas-Kanade at every pixel, coarse to fine over a luma pyramid at a
//      working width of at most WORK_W pixels (larger frames are box-reduced first, and the flow
//      is upsampled back), motion dropped where standing still matches as well, 3x3 median;
//   2. the flow at the in-between time by forward splatting both flows;
//   3. each output pixel warps both frames along that flow and blends them, fading to the plain
//      cross-fade where the flow is not trusted or the pixel did not change.
// Frames are {width, height, data} with RGBA bytes (sRGB), as canvas ImageData. The luma the
// flow follows is the sRGB-weighted value / 255 (close to ArtCraft's square root of linear luma).
// The export draws these frames (backend/export.mjs morphPictures). The live preview, check and look
// draw a cross-dissolve over the same window instead (morphDissolveScene), without the flow's cost.

export const WORK_W = 640;
const WIN = 4;
const MIN_LEVEL = 12;
const MAX_LEVELS = 7;
const ITERS = 6;
const NOISE = 0.01;
const DAMP = (2 * WIN + 1) * (2 * WIN + 1) * NOISE * NOISE;
const MAX_STEP = 2;
const FB_WEIGHT = 0.05;
const AGREE_PX = 1;
const STILL_LUMA = 0.004;
const FILL_PASSES = 64;

/** Seconds a morph lasts by default (cut_speech on a video), and the range morphIn accepts. */
export const MORPH_DEFAULT = 0.3;
export const MORPH_MIN = 0.1;
export const MORPH_MAX = 1;
// Mean luma change (0..1) between the two frames, after the flow, above which they are taken for
// two different shots: the join stays a plain cut (a morph between two shots would smear).
export const MORPH_SAME_SHOT = 0.08;

const clampInt = (value, low, high) => (value < low ? low : value > high ? high : value);

function gray(w, h, px = new Float32Array(w * h)) {
  return { w, h, px };
}

// ArtCraft flow.rs g_at: clamped fetch from a luma image.
function gAt(g, x, y) {
  return g.px[clampInt(y, 0, g.h - 1) * g.w + clampInt(x, 0, g.w - 1)];
}

// ArtCraft flow.rs g_sample: bilinear luma sample (pixel centers at integers), clamped.
function gSample(g, x, y) {
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const a = gAt(g, x0, y0), b = gAt(g, x0 + 1, y0), c = gAt(g, x0, y0 + 1), d = gAt(g, x0 + 1, y0 + 1);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

// A flow field: per-pixel motion (u, v) on a working grid.
function flowField(w, h) {
  return { w, h, u: new Float32Array(w * h), v: new Float32Array(w * h) };
}

// ArtCraft flow.rs Flow::sample: bilinear sample of a flow, clamped at the edges. Writes into `out`.
function flowSample(f, x, y, out) {
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const xa = clampInt(x0, 0, f.w - 1), xb = clampInt(x0 + 1, 0, f.w - 1);
  const ya = clampInt(y0, 0, f.h - 1) * f.w, yb = clampInt(y0 + 1, 0, f.h - 1) * f.w;
  const { u, v } = f;
  const uTop = u[ya + xa] + (u[ya + xb] - u[ya + xa]) * fx, uBottom = u[yb + xa] + (u[yb + xb] - u[yb + xa]) * fx;
  const vTop = v[ya + xa] + (v[ya + xb] - v[ya + xa]) * fx, vBottom = v[yb + xa] + (v[yb + xb] - v[yb + xa]) * fx;
  out[0] = uTop + (uBottom - uTop) * fy;
  out[1] = vTop + (vBottom - vTop) * fy;
  return out;
}

const lumaOf = (data, i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;

// ArtCraft flow.rs work_luma: luma of the frame box-reduced by `s` in each direction.
function workLuma(frame, s) {
  const w = Math.max(1, Math.ceil(frame.width / s)), h = Math.max(1, Math.ceil(frame.height / s));
  const g = gray(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0, n = 0;
      for (let yy = y * s; yy < Math.min((y + 1) * s, frame.height); yy += 1)
        for (let xx = x * s; xx < Math.min((x + 1) * s, frame.width); xx += 1) { sum += lumaOf(frame.data, (yy * frame.width + xx) * 4); n += 1; }
      g.px[y * w + x] = n ? sum / n : 0;
    }
  }
  return g;
}

// ArtCraft filmcraft/crates/render/src/track.rs Gray::down: 5-tap binomial blur, then 2x decimation.
function down(g) {
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const tmp = gray(g.w, g.h);
  for (let y = 0; y < g.h; y += 1)
    for (let x = 0; x < g.w; x += 1) {
      let sum = 0;
      for (let i = 0; i < 5; i += 1) sum += k[i] * gAt(g, x + i - 2, y);
      tmp.px[y * g.w + x] = sum;
    }
  const out = gray(Math.max(1, Math.ceil(g.w / 2)), Math.max(1, Math.ceil(g.h / 2)));
  for (let y = 0; y < out.h; y += 1)
    for (let x = 0; x < out.w; x += 1) {
      let sum = 0;
      for (let i = 0; i < 5; i += 1) sum += k[i] * gAt(tmp, 2 * x, 2 * y + i - 2);
      out.px[y * out.w + x] = sum;
    }
  return out;
}

// ArtCraft flow.rs pyramid: binomial pyramid, finest first.
function pyramid(g) {
  const levels = [g];
  while (levels.length < MAX_LEVELS) {
    const last = levels.at(-1);
    if (last.w < 2 * MIN_LEVEL || last.h < 2 * MIN_LEVEL) break;
    levels.push(down(last));
  }
  return levels;
}

// ArtCraft flow.rs box_sum: the sum of each of `channels` (Float32Arrays) over a (2r+1)^2 window.
function boxSum(w, h, channels, r) {
  return channels.map((src) => {
    const tmp = new Float64Array(w * h);
    const pre = new Float64Array(w + 1);
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) pre[x + 1] = pre[x] + src[row + x];
      for (let x = 0; x < w; x += 1) tmp[row + x] = pre[Math.min(w, x + r + 1)] - pre[Math.max(0, x - r)];
    }
    const out = new Float32Array(w * h);
    const column = new Float64Array(h + 1);
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < h; y += 1) column[y + 1] = column[y] + tmp[y * w + x];
      for (let y = 0; y < h; y += 1) out[y * w + x] = column[Math.min(h, y + r + 1)] - column[Math.max(0, y - r)];
    }
    return out;
  });
}

// ArtCraft flow.rs refine: Gauss-Newton refinement of `flow` (a(x) ~ b(x + u)) at one level.
function refine(a, b, flow) {
  const { w, h } = a;
  const n = w * h;
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      gx[i] = (gAt(a, x + 1, y) - gAt(a, x - 1, y)) * 0.5;
      gy[i] = (gAt(a, x, y + 1) - gAt(a, x, y - 1)) * 0.5;
    }
  const xx = new Float32Array(n), xy = new Float32Array(n), yy = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { xx[i] = gx[i] * gx[i]; xy[i] = gx[i] * gy[i]; yy[i] = gy[i] * gy[i]; }
  const [txx, txy, tyy] = boxSum(w, h, [xx, xy, yy], WIN);
  const mx = new Float32Array(n), my = new Float32Array(n);
  for (let iteration = 0; iteration < ITERS; iteration += 1) {
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const e = gSample(b, x + flow.u[i], y + flow.v[i]) - a.px[i];
        mx[i] = gx[i] * e; my[i] = gy[i] * e;
      }
    const [bx, by] = boxSum(w, h, [mx, my], WIN);
    for (let i = 0; i < n; i += 1) {
      const gxx = txx[i] + DAMP, gxy = txy[i], gyy = tyy[i] + DAMP;
      const det = gxx * gyy - gxy * gxy;
      if (!(det > 1e-12)) continue;
      const dx = -(gyy * bx[i] - gxy * by[i]) / det;
      const dy = -(gxx * by[i] - gxy * bx[i]) / det;
      if (Number.isFinite(dx) && Number.isFinite(dy)) {
        flow.u[i] += Math.max(-MAX_STEP, Math.min(MAX_STEP, dx));
        flow.v[i] += Math.max(-MAX_STEP, Math.min(MAX_STEP, dy));
      }
    }
  }
}

// ArtCraft flow.rs prefer_still: where standing still explains the window as well, no motion.
function preferStill(a, b, flow) {
  const { w, h } = a;
  const n = w * h;
  const moved = new Float32Array(n), still = new Float32Array(n);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const m = gSample(b, x + flow.u[i], y + flow.v[i]) - a.px[i];
      const s = b.px[i] - a.px[i];
      moved[i] = m * m; still[i] = s * s;
    }
  const [em, es] = boxSum(w, h, [moved, still], WIN);
  const slack = (2 * WIN + 1) * (2 * WIN + 1) * NOISE * NOISE * 0.25;
  for (let i = 0; i < n; i += 1) if (es[i] <= em[i] + slack) { flow.u[i] = 0; flow.v[i] = 0; }
}

// ArtCraft flow.rs median3: 3x3 median of each flow component.
function median3(f) {
  const out = flowField(f.w, f.h);
  const xs = new Float32Array(9), ys = new Float32Array(9);
  for (let y = 0; y < f.h; y += 1)
    for (let x = 0; x < f.w; x += 1) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = clampInt(y + dy, 0, f.h - 1) * f.w + clampInt(x + dx, 0, f.w - 1);
          xs[k] = f.u[j]; ys[k] = f.v[j]; k += 1;
        }
      xs.sort(); ys.sort();
      out.u[y * f.w + x] = xs[4]; out.v[y * f.w + x] = ys[4];
    }
  return out;
}

// ArtCraft flow.rs upsample: the flow on a grid twice as fine, its vectors doubled.
function upsample(f, w, h) {
  const out = flowField(w, h);
  const sample = [0, 0];
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      flowSample(f, x * 0.5, y * 0.5, sample);
      out.u[y * w + x] = sample[0] * 2; out.v[y * w + x] = sample[1] * 2;
    }
  return out;
}

// ArtCraft flow.rs dense_flow: coarse-to-fine dense flow from pa[0] to pb[0].
function denseFlow(pa, pb) {
  let flow = null;
  for (let level = Math.min(pa.length, pb.length) - 1; level >= 0; level -= 1) {
    const a = pa[level], b = pb[level];
    const f = flow ? upsample(flow, a.w, a.h) : flowField(a.w, a.h);
    refine(a, b, f);
    preferStill(a, b, f);
    flow = median3(f);
  }
  return flow;
}

// ArtCraft flow.rs flow_at: the 0->1 flow of the surface seen at each pixel at time t, by forward
// splatting both flows; holes are filled from their neighbors.
function flowAt(a, b, f01, f10, t) {
  const { w, h } = a;
  const n = w * h;
  const best = new Float32Array(n).fill(Infinity);
  const out = flowField(w, h);
  const r = [0, 0];
  for (const [src, dst, f, back, tt, sign] of [[a, b, f01, f10, t, 1], [b, a, f10, f01, 1 - t, -1]]) {
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const u = f.u[i], v = f.v[i];
        const qx = x + u, qy = y + v;
        const photo = Math.abs(src.px[i] - gSample(dst, qx, qy));
        flowSample(back, qx, qy, r);
        const fb = Math.min(100, Math.sqrt((u + r[0]) ** 2 + (v + r[1]) ** 2));
        const score = photo + FB_WEIGHT * fb;
        if (!Number.isFinite(score)) continue;
        const tx = x + tt * u, ty = y + tt * v;
        if (!(tx > -1 && ty > -1 && tx < w && ty < h)) continue;
        const x0 = Math.floor(tx), y0 = Math.floor(ty);
        for (const [sx, sy] of [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]]) {
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const j = sy * w + sx;
          if (score < best[j]) { best[j] = score; out.u[j] = sign * u; out.v[j] = sign * v; }
        }
      }
  }
  let valid = Uint8Array.from(best, (score) => (Number.isFinite(score) ? 1 : 0));
  for (let pass = 0; pass < FILL_PASSES; pass += 1) {
    const pu = out.u.slice(), pv = out.v.slice(), was = valid.slice();
    let changed = false;
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (was[i]) continue;
        let su = 0, sv = 0, k = 0;
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (was[j]) { su += pu[j]; sv += pv[j]; k += 1; }
          }
        if (k) { out.u[i] = su / k; out.v[i] = sv / k; valid[i] = 1; changed = true; }
      }
    if (!changed) break;
  }
  return out;
}

// ArtCraft flow.rs agree: how much a fetched pixel's own flow agrees with the trajectory.
const agree = (d) => 1 / (1 + (d / AGREE_PX) ** 2);

// ArtCraft image.rs Image::sample_bilinear_clamped (pixel centers at +0.5), one channel `k`.
function sampleRgba(frame, x, y, out) {
  const fx = Math.max(0, Math.min(frame.width - 1, x - 0.5));
  const fy = Math.max(0, Math.min(frame.height - 1, y - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, frame.width - 1), y1 = Math.min(y0 + 1, frame.height - 1);
  const tx = fx - x0, ty = fy - y0;
  const d = frame.data, w = frame.width;
  const ia = (y0 * w + x0) * 4, ib = (y0 * w + x1) * 4, ic = (y1 * w + x0) * 4, id = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k += 1) {
    const top = d[ia + k] + (d[ib + k] - d[ia + k]) * tx;
    const bottom = d[ic + k] + (d[id + k] - d[ic + k]) * tx;
    out[k] = top + (bottom - top) * ty;
  }
  return out;
}

const sameSize = (a, b) => a && b && a.width === b.width && a.height === b.height && a.width > 0 && a.height > 0 &&
  a.data?.length === a.width * a.height * 4 && b.data?.length === a.data.length;

/**
 * The flow between frames `a` and `b`, worked out once for every in-between frame of one join
 * (the first half of ArtCraft flow.rs `interpolate`). Null when the frames differ in size.
 */
export function morphFlows(a, b) {
  if (!sameSize(a, b)) return null;
  const s = Math.max(1, Math.ceil(a.width / WORK_W));
  const pa = pyramid(workLuma(a, s)), pb = pyramid(workLuma(b, s));
  return { s, ga: pa[0], gb: pb[0], f01: denseFlow(pa, pb), f10: denseFlow(pb, pa) };
}

/**
 * How far apart the two frames are once the flow lines them up: the mean luma change (0..1) of
 * frame a moved along the flow onto b. Two takes of one talking shot stay well under
 * MORPH_SAME_SHOT; a cut to another shot does not.
 */
export function shotDifference(flows) {
  if (!flows) return 1;
  const { ga, gb, f01 } = flows;
  let sum = 0;
  for (let y = 0; y < ga.h; y += 1)
    for (let x = 0; x < ga.w; x += 1) {
      const i = y * ga.w + x;
      sum += Math.abs(gSample(gb, x + f01.u[i], y + f01.v[i]) - ga.px[i]);
    }
  return sum / (ga.w * ga.h);
}

const crossFade = (a, b, t) => {
  const data = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < data.length; i += 1) data[i] = a.data[i] + (b.data[i] - a.data[i]) * t;
  return { width: a.width, height: a.height, data };
};

/**
 * The frame between `a` (t 0) and `b` (t 1) at `t`, motion compensated (the second half of
 * ArtCraft flow.rs `interpolate`). `flows` from morphFlows(a, b) is reused across the frames of
 * one join; without it the flow is worked out here. Frames of different sizes cross-fade.
 */
export function interpolateFrame(a, b, t, flows = morphFlows(a, b)) {
  t = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  if (!sameSize(a, b) || !flows) return sameSize(a, b) ? crossFade(a, b, t) : { width: a.width, height: a.height, data: Uint8ClampedArray.from(a.data) };
  if (t <= 0) return { width: a.width, height: a.height, data: Uint8ClampedArray.from(a.data) };
  if (t >= 1) return { width: b.width, height: b.height, data: Uint8ClampedArray.from(b.data) };
  const { s, ga, gb, f01, f10 } = flows;
  const ft = flowAt(ga, gb, f01, f10, t);
  const toWork = (value) => value / s - 0.5;
  const { width, height } = a;
  const data = new Uint8ClampedArray(a.data.length);
  const u = [0, 0], ua = [0, 0], ub = [0, 0], ca = [0, 0, 0, 0], cb = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5, py = y + 0.5;
      flowSample(ft, toWork(px), toWork(py), u);
      const ux = u[0] * s, uy = u[1] * s;
      const x0 = px - t * ux, y0 = py - t * uy;
      const x1 = px + (1 - t) * ux, y1 = py + (1 - t) * uy;
      // Does the fetched pixel itself move along this trajectory?
      flowSample(f01, toWork(x0), toWork(y0), ua);
      flowSample(f10, toWork(x1), toWork(y1), ub);
      const ka = agree(Math.sqrt((ua[0] - u[0]) ** 2 + (ua[1] - u[1]) ** 2));
      const kb = agree(Math.sqrt((ub[0] + u[0]) ** 2 + (ub[1] + u[1]) ** 2));
      const wa = (1 - t) * ka, wb = t * kb;
      sampleRgba(a, x0, y0, ca);
      sampleRgba(b, x1, y1, cb);
      const i = (y * width + x) * 4;
      const sum = wa + wb;
      // A pixel that looks the same in both frames needs no motion compensation.
      const change = Math.max(Math.abs(lumaOf(a.data, i) - lumaOf(b.data, i)), Math.abs(a.data[i + 3] - b.data[i + 3]) / 255);
      const changed = Math.max(0, Math.min(1, (change - STILL_LUMA) / STILL_LUMA));
      const conf = Math.max(ka, kb) * changed;
      for (let k = 0; k < 4; k += 1) {
        const warped = sum > 1e-6 ? (ca[k] * wa + cb[k] * wb) / sum : ca[k] * (1 - t) + cb[k] * t;
        const plain = a.data[i + k] + (b.data[i + k] - a.data[i + k]) * t;
        data[i + k] = plain + (warped - plain) * conf;
      }
    }
  return { width, height, data };
}

/**
 * The morph cuts a scene asks for: a video layer with `morphIn` seconds whose speech piece just
 * before it (same file and parent, engine/speech.js speechPieces naming) ends where it starts.
 * Returns [{outgoing, incoming, join, start, end}] in scene seconds, the window centered on the
 * join and no longer than either piece allows.
 */
export function morphJoins(scene, piecesOf) {
  const joins = [];
  for (const incoming of scene.layers) {
    if (incoming.type !== "video" || !(incoming.morphIn > 0)) continue;
    const pieces = piecesOf(scene, incoming);
    const at = pieces.indexOf(incoming);
    const outgoing = at > 0 ? pieces[at - 1] : null;
    if (!outgoing) continue;
    const join = incoming.mediaStart ?? 0;
    const outEnd = (outgoing.mediaStart ?? 0) + (outgoing.mediaDuration ?? 0);
    if (Math.abs(outEnd - join) > 0.002) continue;
    const half = Math.min(incoming.morphIn / 2, (outgoing.mediaDuration ?? 0) / 2, (incoming.mediaDuration ?? Infinity) / 2);
    if (!(half > 0.01)) continue;
    joins.push({ outgoing, incoming, join, start: join - half, end: join + half });
  }
  return joins;
}

/**
 * The scene as the live preview, check and look draw it: each morph join (morphJoins) becomes a
 * cross-dissolve over its window. The outgoing piece holds its last frame until the window ends,
 * the incoming one shows its first frame from the window's start, and the upper of the two (later
 * in the layer list) fades over the window. Returns the same scene when nothing morphs.
 */
export function morphDissolveScene(scene, piecesOf) {
  if (!scene?.layers?.some((layer) => layer.type === "video" && layer.morphIn > 0)) return scene;
  const joins = morphJoins(scene, piecesOf);
  if (!joins.length) return scene;
  const copies = new Map();
  const copy = (layer) => {
    if (!copies.has(layer.id)) copies.set(layer.id, { ...layer, playbackWindows: [...(layer.playbackWindows ?? [])], animations: [...(layer.animations ?? [])] });
    return copies.get(layer.id);
  };
  const order = new Map(scene.layers.map((layer, index) => [layer.id, index]));
  const withFreeze = (freeze = "both", side) => (freeze === "both" || freeze === side ? freeze : freeze === "none" ? side : "both");
  for (const cut of joins) {
    const outgoing = copy(cut.outgoing), incoming = copy(cut.incoming);
    outgoing.mediaFreeze = withFreeze(outgoing.mediaFreeze, "last");
    outgoing.playbackWindows.push({ start: -1e9, end: cut.end, visibility: "before" });
    incoming.mediaFreeze = withFreeze(incoming.mediaFreeze, "first");
    incoming.playbackWindows.push({ start: cut.start, end: 1e9, visibility: "after" });
    const upper = order.get(incoming.id) > order.get(outgoing.id) ? incoming : outgoing;
    const opacity = upper.opacity ?? 1;
    const fadeIn = upper === incoming;
    upper.animations.push({ id: `morph-dissolve-${cut.incoming.id}`, kind: fadeIn ? "in" : "out", start: cut.start, duration: cut.end - cut.start, easing: "linear",
      from: { opacity: fadeIn ? 0 : opacity }, to: { opacity: fadeIn ? opacity : 0 } });
  }
  return { ...scene, layers: scene.layers.map((layer) => copies.get(layer.id) ?? layer) };
}
