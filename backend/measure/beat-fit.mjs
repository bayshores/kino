// How a video's cuts sit against its beat, kept as statistics, not times (anime plan build 1):
// each cut's offset to the nearest beat in frames (negative: the cut comes before the beat), the
// share within one frame of a beat, and the share a random placement of the same shots gets. Pure:
// inspire.mjs and the taste packet (evals/taste/packet.mjs) both use it.

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/** Offsets listed one by one in the histogram, in frames; further ones are counted together. */
export const OFFSET_RANGE = 3;
/** Random placements averaged for the baseline. */
export const SHUFFLES = 64;

// A small seeded random number generator (mulberry32), so the baseline is the same every run.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The signed distance from `time` to the nearest of the sorted `beats`.
function nearestOffset(time, beats) {
  let low = 0, high = beats.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (beats[middle] < time) low = middle + 1;
    else high = middle;
  }
  const after = beats[low] - time;
  const before = low > 0 ? beats[low - 1] - time : -Infinity;
  return -(Math.abs(before) < Math.abs(after) ? before : after);
}

const shareWithin = (times, beats, limit) => (times.length ? times.filter((time) => Math.abs(nearestOffset(time, beats)) <= limit).length / times.length : 0);

/**
 * Cut times and beat times (seconds) at `fps` → {cuts, fps, onBeat, random, offsets, further}, or
 * null with fewer than 2 beats or no cuts. onBeat: the share of cuts at most `window` frames from a
 * beat. random: the same share for the same shot lengths in a shuffled order, started at a random
 * point of the beat (SHUFFLES placements, seeded). offsets: {"-3": n … "3": n} cuts per whole frame
 * off the nearest beat; further: the rest.
 */
export function beatFit(cuts, beats, { fps = 24, window = 1 } = {}) {
  const grid = (beats ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  const times = (cuts ?? []).filter(Number.isFinite).sort((a, b) => a - b);
  if (grid.length < 2 || !times.length || !(fps > 0)) return null;
  const limit = (window + 0.5) / fps; // a whole frame off, measured to the nearest frame
  const offsets = Object.fromEntries(Array.from({ length: 2 * OFFSET_RANGE + 1 }, (_, i) => [String(i - OFFSET_RANGE), 0]));
  let further = 0;
  for (const time of times) {
    const frames = Math.round(nearestOffset(time, grid) * fps);
    if (Math.abs(frames) <= OFFSET_RANGE) offsets[String(frames === 0 ? 0 : frames)] += 1;
    else further += 1;
  }
  const steps = grid.slice(1).map((beat, i) => beat - grid[i]).sort((a, b) => a - b);
  const period = steps[Math.floor(steps.length / 2)];
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  let total = 0;
  for (let n = 0; n < SHUFFLES; n += 1) {
    const next = random(n + 1);
    const order = [...gaps];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let time = times[0] + (next() - 0.5) * period;
    const placed = [time, ...order.map((gap) => (time += gap))];
    total += shareWithin(placed, grid, limit);
  }
  return { cuts: times.length, fps: round(fps, 3), onBeat: round(shareWithin(times, grid, limit)), random: round(total / SHUFFLES), offsets, further };
}

/** One line: "cuts 150 · 42% within 1 frame of a beat (random 29%) · frames off the beat -1:20 0:30 +1:12 more:30". */
export function beatFitLine(fit) {
  if (!fit) return "";
  const pct = (value) => `${Math.round(value * 100)}%`;
  const histogram = Object.entries(fit.offsets).sort((a, b) => a[0] - b[0]).filter(([, count]) => count).map(([frames, count]) => `${Number(frames) > 0 ? "+" : ""}${frames}:${count}`);
  if (fit.further) histogram.push(`more:${fit.further}`);
  return `cuts ${fit.cuts} · ${pct(fit.onBeat)} within 1 frame of a beat (random ${pct(fit.random)}) · frames off the beat (- early) ${histogram.join(" ")}`;
}
