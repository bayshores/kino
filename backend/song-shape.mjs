// A song's shape from its sound, not only its loudness (modern masters are loud all the way
// through, so a loudness curve misses obvious drops).
//
// songShape(samples, sampleRate, {bpm}) reads the song in short frames (about 93 ms, a Fourier
// transform each) and returns:
// - sections [{at, kind}]: boundaries where the sound changes (spectral novelty: a self-similarity
//   matrix of each second's spectrum, scanned with Foote's checkerboard kernel) or where the low
//   band (20 to 150 Hz: kick and bass) comes in or drops out. Each is labeled intro, build, drop,
//   break or outro: a drop is where the low band comes in strong after a quieter part, a break is
//   where it drops out, a build is the rise just before a drop.
// - seams [{at, kind, weight}]: dropout, return, vocal-in and switch (see seamsOf). Every section
//   and seam edge is placed to a few milliseconds on 12 ms frames (fineEdge).
// - features: groove (where the kicks fall in the bar), bass, brightness, density, dynamics (0 to
//   100 each). vocals is filled in by the caller from the vocal spans.
// songVocals(file) finds where a voice sings or raps with whisper.cpp (it writes sung words too);
// songShape's voiceGuess is the rougher fallback when whisper is not installed.
import { readFile, writeFile } from "node:fs/promises";
import { barIndexAt, barLines, barOf } from "../engine/songBars.js";
import { decodeMono } from "./audio-analysis.mjs";
import { SAMPLE_RATE as SPEECH_RATE, whisperSegments, whisperSetup, whisperTurn } from "./speech/transcribe.mjs";

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const clamp100 = (value) => Math.round(Math.max(0, Math.min(100, value)));
const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);
const percentile = (list, share) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(share * (sorted.length - 1))))];
};

/** In-place radix-2 Fourier transform (re and im have a power-of-two length). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

const BANDS = 24; // log-spaced bands from 30 Hz up, for the self-similarity matrix

/**
 * Frames of the song: per frame the low band (20-150 Hz), voice band (300-3400 Hz), high band
 * (2-8 kHz) and total energy, the spectral centroid, the low band's onset strength (kicks) and the
 * whole spectrum's (every hit), and 24 log-spaced band energies. Frames are about `frame` seconds
 * long and `overlap` of them cover each moment (seam edges use 12 ms frames, 4 deep).
 */
export function spectralFrames(samples, sampleRate, { frame = 0.093, overlap = 2 } = {}) {
  const size = 2 ** Math.round(Math.log2(sampleRate * frame));
  const hop = size / overlap;
  const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1);
  const binHz = sampleRate / size;
  const top = Math.min(sampleRate / 2, 11_000);
  const bandOf = new Int16Array(size / 2).fill(-1);
  for (let k = 1; k < size / 2; k += 1) {
    const hz = k * binHz;
    if (hz >= 30 && hz < top) bandOf[k] = Math.min(BANDS - 1, Math.floor((Math.log(hz / 30) / Math.log(top / 30)) * BANDS));
  }
  const window = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const frames = { hopSeconds: hop / sampleRate, count, low: new Float32Array(count), voice: new Float32Array(count), high: new Float32Array(count),
    total: new Float32Array(count), centroid: new Float32Array(count), lowFlux: new Float32Array(count), flux: new Float32Array(count), bands: new Float32Array(count * BANDS) };
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let previous = new Float32Array(size / 2);
  let current = new Float32Array(size / 2);
  for (let f = 0; f < count; f += 1) {
    const offset = f * hop;
    for (let i = 0; i < size; i += 1) { re[i] = samples[offset + i] * window[i]; im[i] = 0; }
    fft(re, im);
    let low = 0; let voice = 0; let high = 0; let total = 0; let weighted = 0; let lowFlux = 0; let flux = 0;
    for (let k = 1; k < size / 2; k += 1) {
      const power = re[k] * re[k] + im[k] * im[k];
      const hz = k * binHz;
      const magnitude = Math.log1p(1000 * Math.sqrt(power));
      current[k] = magnitude;
      const rise = magnitude - previous[k];
      if (rise > 0) { flux += rise; if (hz >= 40 && hz < 150) lowFlux += rise; }
      if (hz >= 20 && hz < 150) low += power;
      if (hz >= 300 && hz < 3400) voice += power;
      if (hz >= 2000 && hz < 8000) high += power;
      total += power;
      weighted += power * hz;
      if (bandOf[k] >= 0) frames.bands[f * BANDS + bandOf[k]] += power;
    }
    frames.low[f] = low; frames.voice[f] = voice; frames.high[f] = high; frames.total[f] = total;
    frames.centroid[f] = total > 0 ? weighted / total : 0;
    frames.lowFlux[f] = lowFlux; frames.flux[f] = flux;
    [previous, current] = [current, previous];
  }
  return frames;
}

/** Per second: the mean of a frame series. */
function perSecond(series, frames, seconds) {
  const per = 1 / frames.hopSeconds;
  return Array.from({ length: seconds }, (_, s) => mean(Array.from(series.subarray(Math.floor(s * per), Math.min(series.length, Math.floor((s + 1) * per))))));
}

/** Decibels to 0-100: 100 at the song's 95th percentile, 0 at `range` dB under it. */
function levels(energies, range) {
  const db = energies.map((value) => 10 * Math.log10(value + 1e-12));
  const ref = percentile(db, 0.95);
  return db.map((value) => clamp100(((value - (ref - range)) / range) * 100));
}

/**
 * Spectral novelty each second (0 to 1): Foote's checkerboard kernel (Gaussian tapered, `half`
 * seconds each side) slid along the diagonal of the cosine self-similarity matrix of the per-second
 * band spectra (log energy, each band standardized over the song).
 */
export function spectralNovelty(vectors, half = 8) {
  const n = vectors.length;
  const width = vectors[0]?.length ?? 0;
  const z = vectors.map((vector) => vector.slice());
  for (let b = 0; b < width; b += 1) {
    const column = z.map((vector) => vector[b]);
    const m = mean(column);
    const sd = Math.sqrt(mean(column.map((value) => (value - m) ** 2))) || 1;
    for (const vector of z) vector[b] = (vector[b] - m) / sd;
  }
  const norms = z.map((vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1);
  const sim = (i, j) => { let dot = 0; for (let b = 0; b < width; b += 1) dot += z[i][b] * z[j][b]; return dot / (norms[i] * norms[j]); };
  const novelty = new Array(n).fill(0);
  const sigma = half / 2;
  for (let i = half; i < n - half; i += 1) {
    let sum = 0;
    for (let a = -half; a < half; a += 1) {
      for (let b = -half; b < half; b += 1) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const taper = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
        sum += sign * taper * sim(i + a, i + b);
      }
    }
    novelty[i] = Math.max(0, sum);
  }
  const top = Math.max(...novelty, 1e-9);
  return novelty.map((value) => value / top);
}

/** Local peaks of a curve: the highest point within `radius` and at least `floor`. */
function peaks(curve, radius, floor) {
  const found = [];
  for (let i = 1; i < curve.length - 1; i += 1) {
    if (curve[i] < floor) continue;
    let best = true;
    for (let j = Math.max(0, i - radius); j <= Math.min(curve.length - 1, i + radius); j += 1) if (curve[j] > curve[i] || (curve[j] === curve[i] && j < i)) best = false;
    if (best) found.push(i);
  }
  return found;
}

/**
 * Sections from per-second curves: low (the low band, 0-100), rise (loudness and the high band, for
 * builds), novelty (0-1). Boundaries come from novelty peaks and from where the low band comes in
 * or drops out (the mean of the 4 s after against the 4 s before, 18 or more apart).
 */
export function sectionsFromCurves({ low, rise, novelty, whole = true }) {
  const n = low.length;
  const step = low.map((_, t) => (t >= 4 && t <= n - 4 ? mean(low.slice(t, t + 4)) - mean(low.slice(t - 4, t)) : 0));
  const comes = peaks(step, 4, 18);
  const goes = peaks(step.map((value) => -value), 4, 18);
  const marks = [...comes, ...goes].sort((a, b) => a - b);
  for (const at of peaks(novelty, 6, 0.35)) if (!marks.some((mark) => Math.abs(mark - at) <= 4)) marks.push(at);
  marks.sort((a, b) => a - b);
  const bounds = [0, ...marks.filter((at) => at >= 4 && at <= n - 4), n];
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i += 1) if (bounds[i + 1] - bounds[i] >= 2) parts.push({ from: bounds[i], to: bounds[i + 1], low: mean(low.slice(bounds[i], bounds[i + 1])) });
  const sections = [];
  if (parts.length && parts[0].low < 50 && parts.length > 1) sections.push({ at: 0, kind: "intro" });
  for (let i = 1; i < parts.length; i += 1) {
    const [before, part] = [parts[i - 1], parts[i]];
    // How long the low band stays in after this point, and how long it was in before it (a kick
    // that comes in for 4 s in an intro is not a drop).
    let stays = i;
    while (stays + 1 < parts.length && parts[stays + 1].low >= 60) stays += 1;
    let was = i - 1;
    while (was > 0 && parts[was - 1].low >= part.low + 20) was -= 1;
    if (part.low >= 70 && part.low - before.low >= 20 && parts[stays].to - part.from >= 8) {
      // The build: from the quietest point in the last 16 s before the drop, when it rises.
      const from = Math.max(before.from, part.from - 16);
      const window = rise.slice(from, part.from);
      const lowest = from + window.indexOf(Math.min(...window));
      const climb = mean(rise.slice(part.from - 2, part.from)) - rise[lowest];
      const labeled = sections.some((entry) => entry.at === before.from);
      if (climb >= 8 && lowest < part.from - 2 && !(labeled && lowest <= before.from + 2)) sections.push({ at: lowest, kind: "build" });
      sections.push({ at: part.from, kind: "drop" });
    } else if (before.low - part.low >= 20 && part.low < 80 && before.to - parts[was].from >= 8) {
      const last = i === parts.length - 1;
      sections.push({ at: part.from, kind: last && whole && part.from >= n * 0.6 && n - part.from >= 4 ? "outro" : "break" });
    }
  }
  return sections.sort((a, b) => a.at - b.at || (a.kind === "build" ? -1 : 1));
}

// ---------------------------------------------------------------- seams
// A seam is a moment the edit locks to: a section edge, a short rest of the music (dropout) and
// where it comes back (return), the filter opening again (return), a voice coming in (vocal-in),
// the beat changing its pattern (switch). Each is placed to a few milliseconds (well inside one
// video frame) and has a weight from 0 to 1: how big the change is.

const dbOf = (value) => 10 * Math.log10(value + 1e-12);
const REST_DB = 15; // a rest: the whole sound 15 dB or more under the median of the 8 s around it
const REST_SECONDS = [0.1, 4];
const RETURN_DB = 12; // a filter return: the high band back up 12 dB after it was down
const SWITCH_MIN = 0.5; // a switch: the hits' pattern this different (1 - cosine of the rhythms)
const SAME_HIT = 0.05; // two edges closer than this (about a video frame) are one moment
const STOP_DB = 15; // a stop: the low band this far under the median of the 8 s around it
const STOP_SECONDS = [0.75, 4]; // a stop that ends in a drop lasts this long (shorter: a rest, longer: a break)
const FULL_DB = 6; // the band is full again when it is within this many dB of the song's loud level
const weightOf = (db, full = 30) => round(Math.min(1, Math.max(0, db / full)), 2);

// What fineEdge compares, frame by frame: one band's level in dB.
const BAND = {
  low: (frames, f) => dbOf(frames.low[f]),
  voice: (frames, f) => dbOf(frames.voice[f]),
  high: (frames, f) => dbOf(frames.high[f]),
  total: (frames, f) => dbOf(frames.total[f]),
};

/**
 * Where a change is sharpest near `at` (seconds), to a few milliseconds: 12 ms frames (a 3 ms
 * step) of the samples around it, and the point within `radius` where the mean of `band` over
 * `window` after it rises (direction 1) or falls (-1) most against the mean before it.
 * Returns {at, change} (change in dB).
 */
export function fineEdge(samples, sampleRate, at, { band = "total", direction = 1, radius = 0.15, window = 0.04 } = {}) {
  const pad = radius + window + 0.03;
  const start = Math.max(0, Math.floor((at - pad) * sampleRate));
  const stop = Math.min(samples.length, Math.ceil((at + pad) * sampleRate));
  const frames = spectralFrames(samples.subarray(start, stop), sampleRate, { frame: 0.012, overlap: 4 });
  const hop = frames.hopSeconds;
  const values = Array.from({ length: frames.count }, (_, f) => BAND[band](frames, f));
  const sums = [0];
  for (const value of values) sums.push(sums.at(-1) + value);
  const w = Math.max(2, Math.round(window / hop));
  let best = { at, change: 0 };
  let bestScore = -Infinity;
  for (let f = w; f <= frames.count - w; f += 1) {
    // The edge between frame f-1 and frame f, by their centers (a frame is 4 steps long).
    const time = start / sampleRate + (f - 0.5) * hop + 2 * hop;
    if (Math.abs(time - at) > radius) continue;
    const change = (sums[f + w] - sums[f]) / w - (sums[f] - sums[f - w]) / w;
    if (direction * change > bestScore) { bestScore = direction * change; best = { at: time, change: direction * change }; }
  }
  return best;
}

/** A section placed to a few milliseconds, with its weight: drops and breaks on the low band, a build on the whole sound. */
function refine(part, frames, samples, sampleRate) {
  if (part.at <= 0) return { ...part, at: 0 };
  const per = 1 / frames.hopSeconds;
  let at = part.at;
  if (part.kind !== "build") {
    // First to the 46 ms frame: where the low band's change is steepest within 2 s.
    const db = Array.from(frames.low, dbOf);
    let bestStep = -Infinity;
    const span = Math.round(per / 4);
    for (let f = Math.max(span, Math.floor((part.at - 2) * per)); f < Math.min(db.length - span, Math.ceil((part.at + 2) * per)); f += 1) {
      const change = mean(db.slice(f, f + span)) - mean(db.slice(f - span, f));
      const score = part.kind === "drop" ? change : -change;
      if (score > bestStep) { bestStep = score; at = f * frames.hopSeconds; }
    }
  }
  const edge = part.kind === "build"
    ? fineEdge(samples, sampleRate, at, { band: "total", radius: 0.5, window: 0.25 })
    : fineEdge(samples, sampleRate, at, { band: "low", direction: part.kind === "drop" ? 1 : -1, radius: 0.15, window: 0.1 });
  return { at: round(edge.at, 3), kind: part.kind, weight: weightOf(edge.change) };
}

/**
 * Drops that come back after a stop: [{from, to, change}] (seconds, to the 46 ms frame; change: dB) where the low band
 * is 15 dB or more under the median of the 8 s around it for 0.75 to 4 s (shorter gaps are rests,
 * seams), after 1 s with the low band within 6 dB of the song's loud level (its 75th percentile) and
 * before 1 s with the low band and the whole sound back within 6 dB of theirs. The whole sound may
 * stay up through the stop (hats, a pad): only the kick and bass need to be out. A stop of the whole
 * sound gets the dropout seam and this drop; its return seam is not made (seamsOf drops a return that
 * sits on a section). 4 or more stops of one length at an even spacing are the groove (withoutGroove).
 */
export function stopReturns(frames) {
  const per = 1 / frames.hopSeconds;
  const second = Math.round(per);
  const low = Array.from(frames.low, dbOf);
  // The level of a stretch of frames: its mean power in dB (a kick's decay does not pull it down).
  const level = (series, from, to) => dbOf(mean(Array.from(series.subarray(from, to))));
  const loud = (series) => percentile(Array.from({ length: Math.max(1, series.length - second) }, (_, f) => level(series, f, f + second)), 0.75);
  const [loudLow, loudTotal] = [loud(frames.low), loud(frames.total)];
  const seconds = Math.ceil(frames.count * frames.hopSeconds);
  const median = Array.from({ length: seconds }, (_, s) => percentile(low.slice(Math.max(0, Math.floor((s - 4) * per)), Math.min(low.length, Math.floor((s + 5) * per))), 0.5));
  const out = low.map((value, f) => value < median[Math.floor(f * frames.hopSeconds)] - STOP_DB);
  const found = [];
  for (let f = second; f < out.length; f += 1) {
    if (!out[f] || out[f - 1]) continue;
    let end = f;
    while (end < out.length && out[end]) end += 1;
    const length = (end - f) * frames.hopSeconds;
    if (length < STOP_SECONDS[0] || length > STOP_SECONDS[1] || end + second > out.length) continue;
    const full = level(frames.low, f - second, f) >= loudLow - FULL_DB && level(frames.low, end, end + second) >= loudLow - FULL_DB && level(frames.total, end, end + second) >= loudTotal - FULL_DB;
    // The size of the return: the low band's level in the half second after the stop against its level in the stop.
    if (full) found.push({ from: f * frames.hopSeconds, to: end * frames.hopSeconds, change: level(frames.low, end, end + Math.round(per / 2)) - mean(low.slice(f, end)) });
  }
  return withoutGroove(found);
}

const GROOVE_STOPS = 4; // this many stops of one length at an even spacing are the song's groove

/** Drops the stops of a groove: 4 or more in a row of the same length (within 0.3 s) at an even spacing (within 0.3 s) are a pattern, not a stop before a drop. */
function withoutGroove(found) {
  const groove = new Set();
  let run = [];
  const close = () => { if (run.length >= GROOVE_STOPS) for (const stop of run) groove.add(stop); };
  for (const stop of found) {
    const last = run.at(-1);
    const prev = run.at(-2);
    const sameLength = last && Math.abs(stop.to - stop.from - (last.to - last.from)) <= 0.3;
    const evenSpacing = !prev || Math.abs(stop.from - last.from - (last.from - prev.from)) <= 0.3;
    if (sameLength && evenSpacing) run.push(stop);
    else { close(); run = [stop]; }
  }
  close();
  return found.filter((stop) => !groove.has(stop));
}

/**
 * Short rests: [{from, to, depth}] (seconds, to the 46 ms frame) where the whole sound falls 15 dB
 * or more under the median of the 8 s around it, for 0.1 to 4 s, with no other such gap within
 * 1.5 s on either side (gaps between bare kicks are the groove, not a rest).
 */
export function restsOf(frames) {
  const db = Array.from(frames.total, dbOf);
  const per = 1 / frames.hopSeconds;
  const seconds = Math.ceil(frames.count * frames.hopSeconds);
  const median = Array.from({ length: seconds }, (_, s) => percentile(db.slice(Math.max(0, Math.floor((s - 4) * per)), Math.min(db.length, Math.floor((s + 5) * per))), 0.5));
  const out = db.map((value, f) => value < median[Math.floor(f * frames.hopSeconds)] - REST_DB);
  const center = (f) => (f + 1) * frames.hopSeconds; // a frame is 2 steps long
  const runs = [];
  for (let f = 0; f < out.length; f += 1) {
    if (!out[f] || (f > 0 && out[f - 1])) continue;
    let end = f;
    while (end < out.length && out[end]) end += 1;
    runs.push([f, end]);
  }
  const alone = Math.round(1.5 * per);
  const rests = [];
  for (const [index, [f, end]] of runs.entries()) {
    const [from, to] = [center(f) - frames.hopSeconds / 2, center(end) - frames.hopSeconds / 2];
    const level = median[Math.floor(f * frames.hopSeconds)];
    const lonely = !(runs[index - 1] && f - runs[index - 1][1] < alone) && !(runs[index + 1] && runs[index + 1][0] - end < alone);
    if (lonely && to - from >= REST_SECONDS[0] && to - from <= REST_SECONDS[1] && f > 0 && end < out.length - 1 && from >= 0.5)
      rests.push({ from, to, depth: level - mean(db.slice(f, end)) });
  }
  return rests;
}

/** Filter returns: times (to the 46 ms frame) where the high band comes back 12 dB or more after it was down, while the low band played on. */
export function filterReturns(frames) {
  const per = 1 / frames.hopSeconds;
  const high = Array.from(frames.high, dbOf);
  const low = Array.from(frames.low, dbOf);
  const sum = (series) => { const sums = [0]; for (const value of series) sums.push(sums.at(-1) + value); return sums; };
  const [hs, ls] = [sum(high), sum(low)];
  const between = (sums, a, b) => (b > a ? (sums[b] - sums[a]) / (b - a) : 0);
  const back = Math.round(2 * per);
  const ahead = Math.round(per);
  const step = high.map((_, f) => (f >= back && f + ahead <= high.length ? between(hs, f, f + ahead) - between(hs, f - back, f) : 0));
  // The loudest second of the high band so far, by where it ends.
  const upTo = [];
  let top = -Infinity;
  for (let f = 0; f < high.length; f += 1) { if (f >= ahead) top = Math.max(top, between(hs, f - ahead, f)); upTo.push(top); }
  return peaks(step, back, RETURN_DB).filter((f) => {
    const after = between(hs, f, f + ahead);
    const wasUp = f - back >= 0 && upTo[f - back] >= after - 4;
    const lowKept = between(ls, f - back, f) >= between(ls, f, f + ahead) - 10;
    return wasUp && lowKept;
  }).map((f) => f * frames.hopSeconds + frames.hopSeconds);
}

/** The pattern of hits from frame `from` to `to`: the autocorrelation of the onset strength, lags up to 2 s. */
function rhythmOf(flux, from, to, lags) {
  const part = Array.from(flux.subarray(Math.max(0, from), Math.min(flux.length, to)));
  const m = mean(part);
  const centered = part.map((value) => value - m);
  return Array.from({ length: lags }, (_, index) => {
    const lag = index + 2;
    let total = 0;
    for (let i = 0; i + lag < centered.length; i += 1) total += centered[i] * centered[i + lag];
    return total / Math.max(1, centered.length - lag);
  });
}
const rhythmChange = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? 1 - dot / Math.sqrt(na * nb) : 0;
};

/**
 * Beat switches: where the pattern of hits changes while the low band plays on both sides (`low`:
 * 0 to 100 each second). [{at, change}] with at on the first hit of the new pattern (to the frame).
 */
export function beatSwitches(frames, low) {
  const per = 1 / frames.hopSeconds;
  const side = Math.round(4 * per);
  const lags = Math.round(1.5 * per);
  const n = low.length;
  const curve = Array.from({ length: n }, (_, t) => (t >= 4 && t <= n - 4 && mean(low.slice(t - 4, t)) >= 50 && mean(low.slice(t, t + 4)) >= 50
    ? rhythmChange(rhythmOf(frames.flux, Math.round(t * per) - side, Math.round(t * per), lags), rhythmOf(frames.flux, Math.round(t * per), Math.round(t * per) + side, lags)) : 0));
  const flux = Array.from(frames.flux);
  const onsets = peaks(flux, 2, percentile(flux, 0.6) * 1.2);
  const span = Math.round(4 * per);
  return peaks(curve, 4, SWITCH_MIN).map((t) => {
    // The hit within 1 s where the pattern before and after it differ most; the first of equals.
    let best = null;
    for (const f of onsets) {
      if (Math.abs(f * frames.hopSeconds - t) > 1.5) continue;
      const change = rhythmChange(rhythmOf(frames.flux, f - span, f, lags), rhythmOf(frames.flux, f, f + span, lags));
      if (!best || change > best.change + 0.02) best = { f, change };
    }
    return best ? { at: best.f * frames.hopSeconds + frames.hopSeconds, change: best.change } : null;
  }).filter(Boolean);
}

/**
 * The song's seams beyond its sections: [{at, kind, weight}] sorted by time, at to a few
 * milliseconds. Kinds: dropout and return (a short rest and the sound coming back), return (the
 * high band back after a filter), vocal-in (the start of each vocal span in `vocals`, from whisper:
 * none without it), switch (the beat changes its pattern).
 */
function seamsOf(frames, samples, sampleRate, sections, low, vocals) {
  const seams = [];
  const near = (at, gap) => [...sections, ...seams].some((seam) => Math.abs(seam.at - at) < gap);
  for (const rest of restsOf(frames)) {
    const out = fineEdge(samples, sampleRate, rest.from, { band: "total", direction: -1 });
    const back = fineEdge(samples, sampleRate, rest.to, { band: "total", direction: 1 });
    // An edge within a video frame of a section's (the one-beat stop before a drop comes back on the
    // drop) is that section's: one cue for one hit.
    if (!near(out.at, SAME_HIT)) seams.push({ at: round(out.at, 3), kind: "dropout", weight: weightOf(rest.depth) });
    if (!near(back.at, SAME_HIT)) seams.push({ at: round(back.at, 3), kind: "return", weight: weightOf(back.change) });
  }
  for (const at of filterReturns(frames)) {
    if (near(at, 1)) continue;
    const edge = fineEdge(samples, sampleRate, at, { band: "high", direction: 1, radius: 0.2, window: 0.1 });
    seams.push({ at: round(edge.at, 3), kind: "return", weight: weightOf(edge.change) });
  }
  for (const [from] of vocals ?? []) {
    if (!(from > 0.5)) continue;
    const edge = fineEdge(samples, sampleRate, from, { band: "voice", direction: 1, radius: 0.6, window: 0.25 });
    seams.push({ at: round(edge.at, 3), kind: "vocal-in", weight: weightOf(edge.change, 20) });
  }
  for (const found of beatSwitches(frames, low)) {
    if (near(found.at, 2)) continue;
    const edge = fineEdge(samples, sampleRate, found.at, { band: "total", direction: 1, radius: 0.08, window: 0.03 });
    seams.push({ at: round(edge.at, 3), kind: "switch", weight: round(Math.min(1, found.change), 2) });
  }
  return seams.sort((a, b) => a.at - b.at);
}

/** Where the kicks fall: four-on-the-floor, two-step, half-time, breakbeat or free (no steady kick). */
export function grooveOf(kicks, hopSeconds, bpm, on = null) {
  if (!(bpm >= 60 && bpm <= 200)) return "free";
  // The bar's length to the frame: the lag within 4% of the tempo's where the kicks repeat best.
  let barFrames = (60 / bpm / hopSeconds) * 4;
  let bestLag = -1;
  for (let scale = 0.96; scale <= 1.04; scale += 0.0025) {
    const lag = barFrames * scale;
    let sum = 0;
    for (let f = 0; f + lag + 1 < kicks.length; f += 1) {
      const at = f + lag;
      const part = at - Math.floor(at);
      sum += kicks[f] * (kicks[Math.floor(at)] * (1 - part) + kicks[Math.floor(at) + 1] * part);
    }
    if (sum > bestLag) { bestLag = sum; barFrames = (60 / bpm / hopSeconds) * 4 * scale; }
  }
  const step = barFrames / 16; // frames per sixteenth
  const hist = new Float64Array(16);
  for (let start = 0; start + barFrames * 2 <= kicks.length; start += Math.round(barFrames * 2)) {
    // Each 2 bars align on their own (a small tempo error does not smear the pattern).
    const fine = new Float64Array(64);
    for (let f = start; f < start + barFrames * 2; f += 1) {
      if (on && !on[f]) continue;
      fine[Math.floor(((f - start) / step) * 4) % 64] += kicks[f];
    }
    let shift = 0; let best = -1;
    for (let r = 0; r < 64; r += 1) {
      const sum = [0, 16, 32, 48].reduce((total, beat) => total + fine[(beat + r) % 64] + fine[(beat + r + 1) % 64] + fine[(beat + r + 63) % 64], 0);
      if (sum > best) { best = sum; shift = r; }
    }
    for (let i = 0; i < 64; i += 1) hist[Math.round(i / 4) % 16] += fine[(i + shift) % 64];
  }
  const total = hist.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return "free";
  // The bar's strongest beat comes first.
  const beatSums = [0, 4, 8, 12].map((bin) => hist[bin]);
  const first = [0, 4, 8, 12][beatSums.indexOf(Math.max(...beatSums))];
  const h = Array.from({ length: 16 }, (_, i) => hist[(i + first) % 16]);
  const peak = Math.max(...h);
  const n = h.map((value) => value / peak);
  const offMean = mean(n.filter((_, i) => i % 4 !== 0));
  const beats = [n[0], n[4], n[8], n[12]];
  const beatShare = (h[0] + h[4] + h[8] + h[12]) / total;
  if (beatShare < 0.3 && offMean > 0.5) return "free";
  if (Math.min(...beats) >= 0.55 && Math.min(...beats) >= 1.5 * offMean) return "four-on-the-floor";
  const sparse = n.filter((value) => value >= 0.55).length;
  if (bpm >= 140 && n[8] < 0.55 && sparse <= 3) return "half-time";
  if (beats.filter((value) => value >= 0.55).length <= 2 && [6, 7, 10, 11, 14].some((i) => n[i] >= 0.5) && offMean < 0.5) return "two-step";
  if (n[8] < 0.5 && n[4] < 0.5 && n[12] < 0.5 && offMean < 0.35) return "half-time";
  return "breakbeat";
}

/**
 * The song's sections and sound: samples (mono), sampleRate, bpm (from the beat analysis), whole
 * (false when the samples stop before the song does: no outro then), vocals (whisper's vocal spans
 * [[from, to]], for vocal-in seams; none without them), beats (the beat analysis: with it the result
 * has bars, see barsOf, and every section and seam has bar, the index of its nearest bar line; at
 * stays the heard time).
 * Returns {sections: [{at, kind, weight}], seams: [{at, kind, weight}], features: {groove, bass,
 * brightness, density, dynamics}, low, voiceGuess} (at to a few milliseconds; weight 0 to 1; low:
 * the low band each second, 0 to 100; voiceGuess: rough vocal spans).
 */
export function songShape(samples, sampleRate, { bpm = null, whole = true, vocals = null, beats = null } = {}) {
  const frames = spectralFrames(samples, sampleRate);
  const seconds = Math.floor(frames.count * frames.hopSeconds);
  if (seconds < 8) return { sections: [], seams: [], features: { groove: "free", bass: 0, brightness: 0, density: 0, dynamics: 0 }, low: [], voiceGuess: [] };
  const low = levels(perSecond(frames.low, frames, seconds), 30);
  const loud = levels(perSecond(frames.total, frames, seconds), 30);
  const high = levels(perSecond(frames.high, frames, seconds), 30);
  const rise = loud.map((value, t) => (value + high[t]) / 2);
  const per = 1 / frames.hopSeconds;
  const vectors = Array.from({ length: seconds }, (_, s) => {
    const vector = new Array(BANDS).fill(0);
    const from = Math.floor(s * per);
    const to = Math.min(frames.count, Math.floor((s + 1) * per));
    for (let f = from; f < to; f += 1) for (let b = 0; b < BANDS; b += 1) vector[b] += frames.bands[f * BANDS + b];
    return vector.map((value) => Math.log10(value / Math.max(1, to - from) + 1e-9));
  });
  const novelty = spectralNovelty(vectors, Math.min(8, Math.floor(seconds / 4)));
  const sections = sectionsFromCurves({ low, rise, novelty, whole }).map((part) => refine(part, frames, samples, sampleRate));
  // The kick and bass back at full after a stop of 0.75 s or more is a drop, weighted by the size of the return.
  // One with a section within 1 s of it (a break that starts the stop, a drop already on the return) is that section's.
  for (const stop of stopReturns(frames)) {
    const edge = fineEdge(samples, sampleRate, stop.to, { band: "low", direction: 1, radius: 0.15, window: 0.1 });
    if (!sections.some((part) => part.at >= stop.from - 1 && part.at <= edge.at + 1)) sections.push({ at: round(edge.at, 3), kind: "drop", weight: weightOf(stop.change) });
  }
  sections.sort((a, b) => a.at - b.at);
  const seams = seamsOf(frames, samples, sampleRate, sections, low, vocals);
  // With the beat analysis, the shape has bars, and every edge says which bar line it is nearest.
  const grid = beats ? barLines(beats, sections) : null;
  const bars = grid ? barsOf(frames, grid, { samples, sampleRate }) : null;
  const onBar = (edge) => (bars ? { ...edge, bar: barIndexAt(bars.lines, edge.at) } : edge);

  // Features.
  const lowSum = frames.low.reduce((sum, value) => sum + value, 0);
  const totalSum = frames.total.reduce((sum, value) => sum + value, 0) || 1;
  const highSum = frames.high.reduce((sum, value) => sum + value, 0);
  const fluxPeaks = peaks(Array.from(frames.flux), 2, percentile(Array.from(frames.flux), 0.6) * 1.2).length;
  const secondDb = perSecond(frames.total, frames, seconds).map((value) => 10 * Math.log10(value + 1e-12));
  const lowFrameOn = Uint8Array.from(frames.low, (value, f) => (low[Math.min(seconds - 1, Math.floor(f * frames.hopSeconds))] >= 50 ? 1 : 0));
  return {
    sections: sections.map(onBar),
    seams: seams.map(onBar),
    ...(bars ? { bars } : {}),
    features: {
      groove: grooveOf(frames.lowFlux, frames.hopSeconds, bpm, lowFrameOn),
      bass: clamp100(((lowSum / totalSum - 0.4) / 0.55) * 100),
      brightness: clamp100(((10 * Math.log10(highSum / totalSum + 1e-9) + 28) / 20) * 100),
      density: clamp100(((fluxPeaks / seconds) - 1) / 7 * 100),
      dynamics: clamp100(((percentile(secondDb, 0.95) - percentile(secondDb, 0.1)) / 20) * 100),
    },
    low,
    voiceGuess: voiceGuess(frames, seconds),
  };
}

// ---------------------------------------------------------------- bars
// What each bar of the song holds, on the bar lines of the measured beats (engine/songBars.js).

const OUT_DB = 12; // a bar's kick and bass are out when its last half's low band is this far under the loud level
const OUT_LOUD = 0.75; // the loud level: this percentile of the last-half low level over the song's bars
const HIT_SPAN = 0.035; // a hit is on a bar line when its attack falls this close to the line (seconds)
const HIT_WINDOW = 0.008; // the sound this long after an instant against the same before it
const HIT_RISE_DB = 12; // the rise at an attack
const HIT_FLOOR = 0.003; // an attack is not heard when the sound after it is quieter than this (RMS, 0 to 1)
const SOUND_DB = 50; // sound is anything this close to the loudest frame or louder (dB)
const FADE_DB = 12; // a fade falls at least this far...
const FADE_SECONDS = 4; // ...over at least this long before the silence

/** The frames whose centers fall in [from, to): [first, end). A frame is two steps long. */
function framesIn(frames, from, to) {
  const at = (time) => Math.min(frames.count, Math.max(0, Math.ceil(time / frames.hopSeconds - 1)));
  return [at(from), at(to)];
}

/** The mean level in dB of a frame series over [from, to) seconds (power averaged, then dB). */
function levelBetween(series, frames, from, to) {
  const [a, b] = framesIn(frames, from, to);
  let sum = 0;
  for (let f = a; f < b; f += 1) sum += series[f];
  return b > a ? dbOf(sum / (b - a)) : dbOf(0);
}

/**
 * The instant within HIT_SPAN of `time` where the sound rises steeply, or null: for each instant
 * (every millisecond) the RMS of the HIT_WINDOW after it against the RMS of the same before it;
 * the attack is the instant with the largest rise when that rise is HIT_RISE_DB or more (of several
 * instants within 0.5 dB of the largest, the last: a short click rises the same from every instant
 * in the window before it, and the last is where it starts). Only the samples around `time` are read.
 */
export function attackNear(samples, sampleRate, time) {
  const window = Math.round(HIT_WINDOW * sampleRate);
  const step = Math.max(1, Math.round(sampleRate / 1000));
  const first = Math.max(window, Math.round((time - HIT_SPAN) * sampleRate));
  const last = Math.min(samples.length - window, Math.round((time + HIT_SPAN) * sampleRate));
  if (last < first) return null;
  // energy[k]: the sum of squares of samples [from, from + k), so any window is two lookups.
  const from = first - window;
  const energy = new Float64Array(last + window - from + 1);
  for (let i = 0; i < energy.length - 1; i += 1) energy[i + 1] = energy[i] + samples[from + i] ** 2;
  const sumOf = (a, b) => energy[b - from] - energy[a - from];
  const rises = [];
  let best = -Infinity;
  for (let at = first; at <= last; at += step) {
    const after = sumOf(at, at + window) / window;
    const before = sumOf(at - window, at) / window;
    const rise = after < HIT_FLOOR ** 2 ? -Infinity : dbOf(after) - dbOf(before);
    rises.push([at, rise]);
    if (rise > best) best = rise;
  }
  if (best < HIT_RISE_DB) return null;
  const near = rises.filter(([, rise]) => rise >= best - 0.5);
  return round(near.at(-1)[0] / sampleRate, 3);
}

/**
 * Per bar of the song, on its bar lines: {lines, low, all, out, hits, last}. low and all: the
 * mean level in dB of the low band and of the whole sound, 0 for the loudest bar (1 decimal). out:
 * the sorted bars where the song's kick and bass are out: the low band in the bar's last half is
 * OUT_DB or more under the song's loud level (OUT_LOUD of the bars' last-half low levels); the
 * last bar is never listed (a song stopping in it is its ending, see last). hits: per bar line, the
 * time in seconds of the attack of the hit on it (attackNear, from `samples`), or null. There is
 * no per-bar voice: whisper's vocal segments did not tell a bar with a voice from one without.
 * last: {bar, at, end, ends}, the last bar with sound, its line, where the sound ends (a ring
 * counted up to one bar past that bar), and how the song ends: "fade" (the
 * whole sound falls steadily 12 dB or more over 4 s or more before the silence) or "own" (it stops
 * by itself).
 */
export function barsOf(frames, grid, { samples = null, sampleRate = 0 } = {}) {
  const { lines } = grid;
  const end = frames.count * frames.hopSeconds + frames.hopSeconds; // the last frame's far edge
  const edges = [...lines, Math.max(end, lines.at(-1) + grid.bar)];
  const span = (index) => [Math.max(0, edges[index]), edges[index + 1]];
  const [low, all, tail] = [[], [], []];
  const loudest = frames.total.reduce((top, value) => Math.max(top, value), 0);
  const sounding = (f) => dbOf(frames.total[f]) >= dbOf(loudest) - SOUND_DB;
  const sounded = []; // per bar: the share of its frames that have sound
  lines.forEach((_, index) => {
    const [from, to] = span(index);
    low.push(levelBetween(frames.low, frames, from, to));
    all.push(levelBetween(frames.total, frames, from, to));
    tail.push(levelBetween(frames.low, frames, (from + to) / 2, to));
    const [a, b] = framesIn(frames, from, to);
    let heard = 0;
    for (let f = a; f < b; f += 1) if (sounding(f)) heard += 1;
    sounded.push(b > a ? heard / (b - a) : 0);
  });
  const [topLow, topAll] = [Math.max(...low), Math.max(...all)]; // bar counts are small
  // The last bar with sound: more than half of it sounding (a ring that runs on into the next bar
  // does not make that bar the last). lastTime: where the sound ends, at the latest at that bar's end.
  let lastBar = 0;
  sounded.forEach((share, index) => { if (share > 0.5) lastBar = index; });
  let lastFrame = -1;
  for (let f = frames.count - 1; f >= 0 && lastFrame < 0; f -= 1) if (sounding(f)) lastFrame = f;
  const lastSound = (lastFrame + 2) * frames.hopSeconds;
  const lastTime = Math.min(edges[lastBar + 1], lastSound);
  // Out bars: the last half's low level against the song's own loud level, so a quiet intro and a
  // loud drop are judged by the same line. The last bar is left out.
  const loud = percentile(tail.slice(0, lastBar + 1), OUT_LOUD);
  const out = [];
  for (let i = 0; i < lastBar; i += 1) if (tail[i] <= loud - OUT_DB) out.push(i);
  // How it ends: the bars that fall one after the other up to the last sound.
  const levelAt = (index) => levelBetween(frames.total, frames, Math.max(0, lines[index]), index === lastBar ? lastTime : edges[index + 1]);
  let first = lastBar;
  while (first > 0 && levelAt(first - 1) >= levelAt(first) + 1) first -= 1;
  const falls = levelAt(first) - levelAt(lastBar);
  const ends = first < lastBar && lastTime - lines[first] >= FADE_SECONDS && falls >= FADE_DB ? "fade" : "own";
  return {
    lines,
    low: low.map((value) => round(value - topLow) + 0), // + 0: not -0
    all: all.map((value) => round(value - topAll) + 0),
    out,
    hits: lines.map((time) => (samples ? attackNear(samples, sampleRate, time) : null)),
    last: { bar: lastBar, at: lines[lastBar], end: Math.round(Math.min(lastSound, edges[lastBar + 1] + grid.bar) * 1000) / 1000, ends },
  };
}

/** Spans [[from, to]] from times, joined across gaps of `gap` seconds or less, `min` long at least. */
export function joinSpans(spans, { gap = 3, min = 2 } = {}) {
  const sorted = spans.filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  const joined = [];
  for (const [from, to] of sorted) {
    const last = joined.at(-1);
    if (last && from - last[1] <= gap) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined.filter(([from, to]) => to - from >= min).map(([from, to]) => [round(from), round(to)]);
}

// Whisper writes these over music with no voice in it.
const NOT_WORDS = /^(?:you|thank you\.?|thanks for watching!?|bye\.?|oh\.?|uh\.?|um\.?|ah\.?|mm+\.?|hmm\.?)$/i;

/** Segments whisper heard as words: two words or more, not a bracketed sound label, sure enough. */
export function sungSegments(segments) {
  return segments.filter((segment) => {
    const text = String(segment.text ?? "").replace(/\[[^\]]*\]|\([^)]*\)|[♪♫*]/g, " ").replace(/\s+/g, " ").trim();
    const words = text.split(" ").filter((word) => /[\p{L}]/u.test(word));
    return words.length >= 2 && !NOT_WORDS.test(text) && (segment.p ?? 1) >= 0.4;
  });
}

/**
 * Where a voice sings or raps in the first `seconds` of the file, from whisper.cpp in 15 s pieces
 * (whisper's times drift less in short pieces). It waits its turn with the transcriptions (at most
 * two whisper runs at once) and gives up after two minutes. Throws when whisper is not installed.
 */
export async function songVocals(file, { seconds = 240, setup = whisperSetup(), decode = decodeMono, piece = 15, timeoutMs = 120_000 } = {}) {
  return whisperTurn(async () => {
    const { samples } = await decode(file, { sampleRate: SPEECH_RATE });
    const limited = samples.subarray(0, Math.round(seconds * SPEECH_RATE));
    const pieces = [];
    for (let from = 0; from < limited.length / SPEECH_RATE; from += piece) pieces.push({ from, samples: limited.subarray(from * SPEECH_RATE, Math.min(limited.length, (from + piece) * SPEECH_RATE)) });
    const lists = await whisperSegments(pieces.map((part) => part.samples), setup, { args: ["-sns", "-mc", "0"], timeoutMs });
    const spans = lists.flatMap((list, index) => sungSegments(list).map((segment) => [pieces[index].from + segment.from, Math.min(pieces[index].from + piece, pieces[index].from + segment.to)]));
    return joinSpans(spans);
  });
}

/** Whether a whisper model file is on this computer (songVocals can run). */
export function whisperModelReady() {
  try { return Boolean(whisperSetup()); } catch { return false; }
}

/**
 * A rough guess at vocal spans when whisper is not installed: seconds where the voice band (300 to
 * 3400 Hz) carries clearly more of the sound than it usually does in this song.
 */
function voiceGuess(frames, seconds) {
  const voice = perSecond(frames.voice, frames, seconds);
  const total = perSecond(frames.total, frames, seconds);
  const share = voice.map((value, t) => value / (total[t] || 1));
  const line = percentile(share, 0.5) * 1.3;
  return joinSpans(share.map((value, t) => (value >= line ? [t, t + 1] : null)).filter(Boolean));
}

/** How much of the song has a voice in it, 0 to 100. */
export function vocalShare(spans, seconds) {
  return clamp100((spans.reduce((sum, [from, to]) => sum + (to - from), 0) / Math.max(1, seconds)) * 100);
}

// Bump when songShape's sections change, so kept results are made again (2: seams, edges to the
// millisecond, weights; 3: bars, and the bar of every section and seam; 4: bars list the bars where
// kick and bass are out in place of thin, and the attack time of the hit on each line; 5: the kick
// and bass back at full after a stop of 0.75 to 4 s is a drop, a repeating gap (4 or more) is not;
// 6: the vocal spans are kept as `voice`, for reference_range).
export const SONG_SHAPE_VERSION = 6;
const VOCALS_RETRY_MS = 10 * 60_000;

/**
 * Each media file's song shape, measured once and kept in a .song file beside it (like the
 * .beats file of the beat analysis): {version, seconds, whole, sections, seams, bars, vocals}.
 * fit_music reads it. get(file, beats) takes the beat analysis (its bar lines make the shape's
 * bars; a kept result without bars is measured again when one is given) or just a tempo (no bars). vocals(file, seconds) gives whisper's vocal spans for vocal-in seams; the .song says
 * how they were found: "whisper", "none" (no whisper model) or "failed" (whisper did not run or
 * failed). A "failed" file is measured again after 10 minutes, a "none" one once vocalsReady()
 * says a model is there now.
 */
export function createSongShapeCache({ decode = decodeMono, vocals = null, vocalsReady = () => false, now = () => Date.now() } = {}) {
  const pending = new Map();
  // The kept .song result, or null when it is missing or from an older version.
  async function saved(file) {
    try {
      const result = JSON.parse(await readFile(`${file}.song`, "utf8"));
      if (result?.version === SONG_SHAPE_VERSION && Array.isArray(result.sections)) return result;
    } catch { /* not measured yet */ }
    return null;
  }
  // Whether a kept result's vocal-in seams can be found now when they could not before.
  function vocalsAgain(kept) {
    if (!vocals || kept.vocals === "whisper") return false;
    if (kept.vocals === "failed") return now() - (kept.failedAt ?? 0) >= VOCALS_RETRY_MS;
    try { return Boolean(vocalsReady()); } catch { return false; }
  }
  async function readOrMeasure(file, input) {
    const sidecar = `${file}.song`;
    const beats = input && typeof input === "object" ? input : null;
    const kept = await saved(file);
    if (kept && !vocalsAgain(kept) && !(beats && kept.bars === undefined)) return kept;
    const { samples, sampleRate } = await decode(file);
    if (!samples.length) throw new Error("The file has no sound.");
    const seconds = round(samples.length / sampleRate, 3);
    let spans = null;
    let found = "none";
    let failedAt = null;
    if (vocals) {
      try { spans = await vocals(file, Math.min(240, seconds)); found = "whisper"; } catch (error) {
        // No model file is "none" (vocalsReady says when one is there); anything else, a missing
        // whisper-cli included, is tried again after 10 minutes.
        if (error?.code !== "SPEECH_MODEL_MISSING") { found = "failed"; failedAt = now(); }
      }
    }
    const shape = songShape(samples, sampleRate, { bpm: beats ? beats.bpm : input, vocals: spans, beats });
    const result = { version: SONG_SHAPE_VERSION, seconds, whole: true, sections: shape.sections, seams: shape.seams, ...(beats ? { bars: shape.bars ?? null } : {}), vocals: found, ...(spans ? { voice: spans } : {}), ...(failedAt ? { failedAt } : {}) };
    await writeFile(sidecar, JSON.stringify(result), { mode: 0o600 }).catch(() => { /* it still counts unsaved */ });
    return result;
  }
  return {
    get(file, bpmOrAnalysis = null) {
      if (!pending.has(file)) pending.set(file, readOrMeasure(file, bpmOrAnalysis).finally(() => pending.delete(file)));
      return pending.get(file);
    },
    // Only the kept result: no decode, for answers that must not wait.
    saved,
  };
}
