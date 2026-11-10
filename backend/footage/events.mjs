// What happens on screen in a clip, at the clip's own frame rate (footage/analyze.mjs decodes short
// windows around the moments its 4 frames a second pass found). Plain numbers in, events out:
//   impact  something hits: a moving picture stops dead (how "contact"), or 1 to 4 frames that are
//           a different picture (a white, inverted or silhouette frame) and then the shot comes back
//           (how "frame").
//   light   the same picture gets brighter over 1 to 15 frames (a glow, a muzzle flash, a lamp).
//   motion  the picture moves one way for at least a quarter second; dir is where the content
//           goes on screen (a camera panning right moves the content left).
// Each event has t (file seconds, at a frame), a confidence from 0 to 1, and its own facts.
// drawing: frames per drawing (anime drawn "on 2s" holds each drawing for 2 frames).
// Motion comes from phase correlation of a 128x64 gray copy of each frame (the same answer on every
// computer); a busy still background outweighs a small moving thing, so motion and contact read
// the dominant movement of the frame.

export const GRID_W = 128, GRID_H = 64;
const LOG_W = 7, LOG_H = 6;

/** A GRID_W x GRID_H copy (0 to 1) of a width x height 8-bit gray frame, by area averages. */
export function reduceGray(gray, width, height) {
  const out = new Float32Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy += 1) {
    const y0 = Math.floor((gy * height) / GRID_H), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx += 1) {
      const x0 = Math.floor((gx * width) / GRID_W), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID_W));
      let sum = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) sum += gray[y * width + x];
      out[gy * GRID_W + gx] = sum / ((y1 - y0) * (x1 - x0) * 255);
    }
  }
  return out;
}

// An in-place radix-2 FFT of n = 2^bits complex numbers at re[offset + k * stride].
function fft(re, im, offset, stride, bits, inverse) {
  const n = 1 << bits;
  for (let i = 0, j = 0; i < n; i += 1) {
    if (i < j) {
      const a = offset + i * stride, b = offset + j * stride;
      [re[a], re[b]] = [re[b], re[a]];
      [im[a], im[b]] = [im[b], im[a]];
    }
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const a = offset + (start + k) * stride, b = offset + (start + k + size / 2) * stride;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

function fft2(re, im, inverse) {
  for (let y = 0; y < GRID_H; y += 1) fft(re, im, y * GRID_W, 1, LOG_W, inverse);
  for (let x = 0; x < GRID_W; x += 1) fft(re, im, x, GRID_W, LOG_H, inverse);
}

const HANN = (() => {
  const window = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y += 1) for (let x = 0; x < GRID_W; x += 1) {
    window[y * GRID_W + x] = (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / GRID_W)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / GRID_H));
  }
  return window;
})();

function spectrum(grid) {
  let mean = 0;
  for (const value of grid) mean += value;
  mean /= grid.length;
  const re = new Float64Array(grid.length), im = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) re[i] = (grid[i] - mean) * HANN[i];
  fft2(re, im, false);
  return { re, im };
}

/**
 * How far the picture moved from grid a to grid b: {dx, dy} in fractions of the frame's width and
 * height (right and down are positive) and peak, how clearly one movement explains it (0 to 1).
 */
export function phaseShift(a, b) {
  const A = spectrum(a), B = spectrum(b);
  const re = new Float64Array(a.length), im = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    // conj(A) * B, normalized: its inverse peaks at the movement from a to b.
    const r = A.re[i] * B.re[i] + A.im[i] * B.im[i], m = A.re[i] * B.im[i] - A.im[i] * B.re[i];
    const size = Math.hypot(r, m);
    if (size > 1e-9) { re[i] = r / size; im[i] = m / size; }
  }
  fft2(re, im, true);
  let best = 0, bestValue = -Infinity;
  for (let i = 0; i < re.length; i += 1) if (re[i] > bestValue) { bestValue = re[i]; best = i; }
  const px = best % GRID_W, py = Math.floor(best / GRID_W);
  const at = (x, y) => re[((y + GRID_H) % GRID_H) * GRID_W + ((x + GRID_W) % GRID_W)];
  const vertex = (minus, middle, plus) => {
    const curve = minus - 2 * middle + plus;
    return curve < 0 ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve))) : 0;
  };
  let dx = px + vertex(at(px - 1, py), at(px, py), at(px + 1, py));
  let dy = py + vertex(at(px, py - 1), at(px, py), at(px, py + 1));
  if (dx > GRID_W / 2) dx -= GRID_W;
  if (dy > GRID_H / 2) dy -= GRID_H;
  return { dx: dx / GRID_W, dy: dy / GRID_H, peak: Math.max(0, Math.min(1, bestValue / re.length)) };
}

/** How alike two grids are as pictures, ignoring brightness (-1 inverted, 0 unrelated, 1 same). */
export function similarity(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] - ma, y = b[i] - mb;
    ab += x * y; aa += x * x; bb += y * y;
  }
  const flat = 1e-4 * a.length;
  return aa < flat || bb < flat ? (aa < flat && bb < flat ? 1 : 0) : ab / Math.sqrt(aa * bb);
}

const mean = (grid) => grid.reduce((sum, value) => sum + value, 0) / grid.length;
const difference = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const r3 = (value) => Math.round(value * 1000) / 1000;
const r2 = (value) => Math.round(value * 100) / 100;
const DIRECTIONS = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"];
const directionOf = (dx, dy) => DIRECTIONS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];

// The frames of one window: per frame its time, brightness, difference and likeness to the frame
// before, whether it starts a new drawing, and the movement since the last drawing.
function readWindow({ start, fps, frames }) {
  const facts = frames.map((grid, index) => ({ index, t: start + index / fps, grid, luma: mean(grid), diff: 0, sim: 1, fresh: index === 0, move: null }));
  for (let i = 1; i < facts.length; i += 1) {
    facts[i].diff = difference(facts[i].grid, facts[i - 1].grid);
    facts[i].sim = similarity(facts[i].grid, facts[i - 1].grid);
  }
  const sorted = facts.slice(1).map((fact) => fact.diff).sort((a, b) => a - b);
  const busy = sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : 0;
  const threshold = Math.max(0.003, busy * 0.3);
  let last = 0;
  for (let i = 1; i < facts.length; i += 1) {
    if (facts[i].diff <= threshold) continue;
    facts[i].fresh = true;
    const shift = phaseShift(facts[last].grid, facts[i].grid);
    const seconds = (i - last) / fps;
    facts[i].move = { vx: shift.dx / seconds, vy: shift.dy / seconds, peak: shift.peak, sure: shift.peak >= 0.08 };
    last = i;
  }
  return facts;
}

// Impact frames: 1 to 4 frames unlike the frame before, then the shot comes back.
function impactFrames(facts, used) {
  const events = [];
  for (let i = 1; i < facts.length; i += 1) {
    const before = facts[i - 1];
    if (facts[i].sim >= 0.4 && Math.abs(facts[i].luma - before.luma) < 0.25) continue;
    for (let count = 1; count <= 4 && i + count < facts.length; count += 1) {
      const back = facts[i + count];
      if (similarity(back.grid, before.grid) < 0.7 || Math.abs(back.luma - before.luma) >= 0.1) continue;
      let least = 1;
      for (let k = i; k < i + count; k += 1) least = Math.min(least, similarity(facts[k].grid, before.grid));
      if (least >= 0.4) break;
      events.push({ t: facts[i].t, kind: "impact", how: "frame", frames: count, confidence: r2(clamp01(0.3 + (0.7 - least))) });
      for (let k = i; k < i + count; k += 1) used.add(k);
      i += count;
      break;
    }
  }
  return events;
}

// Contact: the picture moved one way at speed and stops dead (or bounces back) within a frame.
function contacts(facts, fps) {
  const span = Math.max(3, Math.round(fps * 0.125));
  const x = [0], y = [0], known = [true];
  for (let i = 1; i < facts.length; i += 1) {
    const move = facts[i].move, seconds = 1 / fps;
    // A new drawing's movement is spread back over the frames it was held for.
    x.push(x[i - 1]); y.push(y[i - 1]); known.push(!facts[i].fresh || Boolean(move?.sure));
    if (move?.sure) { let back = i - 1; while (back > 0 && !facts[back].fresh) back -= 1; const held = (i - back) * seconds; x[i] += move.vx * held; y[i] += move.vy * held; }
  }
  const events = [];
  for (let k = span; k + span < facts.length; k += 1) {
    if (!facts[k].fresh) continue;
    let ok = true;
    for (let i = k - span + 1; i <= k + span; i += 1) if (!known[i]) ok = false;
    if (!ok) continue;
    const seconds = span / fps;
    const bx = (x[k] - x[k - span]) / seconds, by = (y[k] - y[k - span]) / seconds;
    const speed = Math.hypot(bx, by);
    if (speed < 0.4) continue;
    const along = (((x[k + span] - x[k]) / seconds) * bx + ((y[k + span] - y[k]) / seconds) * by) / speed;
    if (along > 0.25 * speed) continue;
    const confidence = r2(clamp01(Math.min(1, speed / 1.5) * (1 - Math.max(0, along) / speed)));
    const previous = events.at(-1);
    if (previous && facts[k].t - previous.t < 0.25) { if (confidence > previous.confidence) events.pop(); else continue; }
    events.push({ t: facts[k].t, kind: "impact", how: "contact", dir: directionOf(bx, by), speed: r2(speed), confidence });
  }
  return events;
}

// Light: the same picture (alike 0.75 or more frame to frame, so not a cut) brightening by 0.05
// or more over at most 0.6 s.
function lights(facts, fps, used) {
  const events = [];
  const longest = Math.max(1, Math.round(fps * 0.6));
  for (let p = 1; p < facts.length; p += 1) {
    // The peak: the first frame of the brightest stretch.
    if (used.has(p) || facts[p - 1].luma >= facts[p].luma - 0.002 || (p + 1 < facts.length && facts[p + 1].luma > facts[p].luma + 0.002)) continue;
    let s = p;
    while (s > 0 && p - s < longest && facts[s].sim >= 0.75 && !used.has(s - 1) && facts[s - 1].luma <= facts[s].luma + 0.002) s -= 1;
    const rise = facts[p].luma - facts[s].luma;
    if (rise < 0.05) continue;
    let first = s;
    while (first < p && facts[first].luma - facts[s].luma < 0.15 * rise) first += 1;
    events.push({ t: facts[p].t, kind: "light", from: facts[first].t, rise: r2(rise), confidence: r2(clamp01(rise / 0.15)) });
  }
  return events;
}

// Motion: drawings moving the same way (within 45 degrees) at 0.15 frame widths a second or more.
function motions(facts) {
  const events = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3 && run.at(-1).t - run[0].t >= 0.2) {
      const vx = run.reduce((sum, fact) => sum + fact.move.vx, 0) / run.length, vy = run.reduce((sum, fact) => sum + fact.move.vy, 0) / run.length;
      const peak = run.reduce((sum, fact) => sum + fact.move.peak, 0) / run.length;
      events.push({ t: run[0].t, kind: "motion", to: r3(run.at(-1).t), dir: directionOf(vx, vy), speed: r2(Math.hypot(vx, vy)), confidence: r2(clamp01(peak * 2)) });
    }
    run = [];
  };
  for (const fact of facts) {
    if (!fact.fresh) continue;
    const move = fact.move;
    if (!move?.sure || Math.hypot(move.vx, move.vy) < 0.15) { flush(); continue; }
    if (run.length) {
      const vx = run.reduce((sum, item) => sum + item.move.vx, 0), vy = run.reduce((sum, item) => sum + item.move.vy, 0);
      const cos = (vx * move.vx + vy * move.vy) / (Math.hypot(vx, vy) * Math.hypot(move.vx, move.vy) || 1);
      if (cos < Math.SQRT1_2) flush();
    }
    run.push(fact);
  }
  flush();
  return events;
}

/**
 * The events of a clip from its decoded windows: [{start (file seconds of frame 0), fps, frames:
 * [grid from reduceGray]}]. Resolves to {events (by time, at most `most`), drawing: {frames (per
 * drawing), perSecond, sure} or null when nothing moves enough to tell}.
 */
export function footageEvents(windows, { most = 60 } = {}) {
  const all = [];
  const gaps = [];
  for (const window of windows) {
    if (!(window.frames?.length >= 2) || !(window.fps > 0)) continue;
    const facts = readWindow(window);
    const used = new Set();
    all.push(...impactFrames(facts, used), ...contacts(facts, window.fps), ...lights(facts, window.fps, used), ...motions(facts));
    const fresh = facts.filter((fact) => fact.fresh && fact.index > 0).map((fact) => fact.index);
    for (let i = 1; i < fresh.length; i += 1) gaps.push({ gap: fresh[i] - fresh[i - 1], fps: window.fps });
  }
  // One event per kind within 2 frames (windows can overlap at their edges).
  all.sort((a, b) => a.t - b.t || b.confidence - a.confidence);
  const events = [];
  for (const event of all) {
    if (events.some((kept) => kept.kind === event.kind && Math.abs(kept.t - event.t) < 0.07)) continue;
    events.push({ ...event, t: r3(event.t), ...(event.from !== undefined ? { from: r3(event.from) } : {}) });
  }
  const kept = events.length > most ? [...events].sort((a, b) => b.confidence - a.confidence).slice(0, most).sort((a, b) => a.t - b.t) : events;
  let drawing = null;
  const counted = gaps.filter((entry) => entry.gap <= 4);
  if (counted.length >= 6) {
    const sorted = counted.map((entry) => entry.gap).sort((a, b) => a - b);
    const frames = sorted[Math.floor(sorted.length / 2)];
    const fps = counted[0].fps;
    drawing = { frames, perSecond: r2(fps / frames), sure: r2(counted.filter((entry) => entry.gap === frames).length / counted.length) };
  }
  return { events: kept, drawing };
}

/**
 * Where to decode at full size, from a scan of every frame (tiny gray copies: luma and change per
 * frame, change the mean difference to the frame before): the biggest changes and brightness
 * jumps (a 1-frame flash included), plus 3 spread windows for the drawing rate. Windows are
 * [start, end] file seconds, merged, at most `most`, together at most a quarter of the clip (and 6 s).
 */
export function eventWindows({ luma, change }, fps, duration, { most = 16, half = 0.5 } = {}) {
  const changes = [...change].filter((value) => value > 0).sort((a, b) => a - b);
  const typical = changes.length ? changes[Math.floor(changes.length / 2)] : 0;
  const scores = luma.map((value, index) => (index === 0 ? 0
    : Math.max(change[index] / Math.max(0.02, typical * 3), Math.abs(value - luma[index - 1]) / 0.05)));
  const scored = [];
  scores.forEach((score, index) => {
    if (score >= 1 && score >= (scores[index - 1] ?? 0) && score >= (scores[index + 1] ?? 0)) scored.push({ t: index / fps, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const budget = Math.max(6, duration / 4);
  const spread = [0.25, 0.5, 0.75].map((share) => ({ t: duration * share, score: 0 }));
  let chosen = [];
  for (const moment of [...spread, ...scored]) {
    const start = Math.max(0, moment.t - half), end = Math.min(duration, moment.t + half);
    if (end - start < 0.2) continue;
    // Overlapping or touching windows join into one, so a moment at an edge keeps its frames.
    const joined = [start, end];
    const rest = [];
    for (const window of chosen) {
      if (window[0] <= joined[1] && window[1] >= joined[0]) { joined[0] = Math.min(joined[0], window[0]); joined[1] = Math.max(joined[1], window[1]); }
      else rest.push(window);
    }
    const next = [...rest, joined];
    if (next.length > most || next.reduce((sum, window) => sum + window[1] - window[0], 0) > budget) break;
    chosen = next;
  }
  return chosen.sort((a, b) => a[0] - b[0]);
}
