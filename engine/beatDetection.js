// Finds the beat and the onsets (the start of each note or hit) in decoded audio.
// Pure: it takes mono samples and their sample rate and returns times in seconds of the source.
// backend/audio-analysis.mjs decodes a media file with FFmpeg and calls analyzeBeats.
//
// The steps, in order:
// 1. Onset strength: how much louder each short slice of sound got than the one before, summed
//    over frequencies ("spectral flux" on a log scale). Hits and notes make peaks.
// 2. Onsets: the peaks of that curve, each moved onto the sample where the sound starts. An
//    onset's strength compares it with the largest rise within 4 seconds of it; its weight
//    compares how much louder it gets with the song's hardest hits, and its band says where
//    most of its new sound is (kick and bass, snare and voice, or hi-hats).
// 3. Tempo: the onset curve in three bands (kick, snare and clap, hi-hats), each scaled so it
//    counts the same; the tempo between 60 and 200 beats a minute at which that curve best matches
//    itself a beat, two beats and a bar later (autocorrelation), times a bell around 120. Then the
//    octave: the faster of two tempos that fit nearly as well (song sites list drum and bass at
//    174, not 87), checked against where kick and snare hit (halfway between beats as hard as on
//    them: twice as fast; hardly ever: half). `alt` names the other octave when it fits nearly
//    as well, for a half-time edit.
// 4. Beat grid: evenly spaced beats fitted to the strongest onsets (least squares), so a steady
//    song gets a steady grid; a song over a minute long is fitted a stretch at a time, from the
//    minute where the grid fits best outwards. Each beat then sits where the onsets within 4
//    seconds of it put the grid. The tempo, which onsets are on the grid, and where the beats start and end still
//    come from the whole file: two files with the same opening give the same first beats (within
//    about a millisecond) when the rest keeps the same tempo and beat, or is louder, shorter or
//    silent. When the rest changes tempo or puts its hits between the opening's beats, the first
//    beats can move or be missing.
// 5. Confidence: the share of grid beats that land on an onset. Below 0.5 the grid is a guess.

// Version 2 finds a beat right at the start of the sound; version 3 no longer takes hiss or
// sound already playing at the start for one; version 4 measures each onset and beat against
// the sound near it, not the loudest part of the file; version 5 keeps the grid on the beat to
// the end of a long song (ten minutes); version 6 finds the tempo in three bands with the octave
// checks of step 3 (on 21 songs with published tempos, 20 right instead of 15); version 7 gives
// each onset a weight (how hard it hits, against the whole song) and a band (low, mid, high), so
// a drop's kick is told from a hi-hat (steps 2c and 2d). Older .beats files are made again.
export const BEAT_ANALYSIS_VERSION = 7;
export const MIN_BPM = 60;
export const MAX_BPM = 200;
/** Below this confidence the grid is reported as uncertain and not used to set the rhythm. */
export const CONFIDENT = 0.5;

const FRAME = 1024;
const HOP = 256;
// A grid beat "lands on" an onset within this many seconds.
const MATCH_SECONDS = 0.035;
// "Near" an onset or a beat: within this many seconds of it (steps 2 and 4).
const NEARBY_SECONDS = 4;
// A song longer than this many seconds is fitted to a beat grid a stretch at a time (step 4).
const FIT_SPAN = 60;

/** Radix-2 FFT in place on real and imaginary parts (length a power of two). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    const half = size >> 1;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Step 1: onset strength per hop, and the time (seconds) each value belongs to. */
export function onsetStrength(samples, sampleRate) {
  const count = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const bins = FRAME / 2;
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let previous = new Float64Array(bins);
  let current = new Float64Array(bins);
  // Linear magnitudes, for how much new sound each band gained (an onset's band, version 7).
  let previousLinear = new Float64Array(bins);
  let currentLinear = new Float64Array(bins);
  const flux = new Float64Array(count);
  // The same, below 200 Hz only (kick drums and bass), to tell the beat from the off-beat.
  const low = new Float64Array(count);
  const lowBins = Math.max(2, Math.ceil((200 * FRAME) / sampleRate));
  // The same again in three bands for the tempo (step 3): kick (below 150 Hz), snare and clap
  // (150 Hz to 2.5 kHz) and hi-hats (above), so the many high bins do not outvote the drums.
  const bands = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const edges = [Math.max(2, Math.round((150 * FRAME) / sampleRate)), Math.round((2500 * FRAME) / sampleRate)];
  const gain = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  for (let frame = 0; frame < count; frame += 1) {
    const offset = frame * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    let lowSum = 0;
    for (let bin = 1; bin < bins; bin += 1) {
      currentLinear[bin] = Math.hypot(re[bin], im[bin]);
      current[bin] = Math.log1p(100 * currentLinear[bin]);
      if (frame === 0) continue;
      const rise = Math.max(0, current[bin] - previous[bin]);
      sum += rise;
      if (bin < lowBins) lowSum += rise;
      const band = bin < edges[0] ? 0 : bin < edges[1] ? 1 : 2;
      bands[band][frame] += rise;
      gain[band][frame] += Math.max(0, currentLinear[bin] - previousLinear[bin]);
    }
    flux[frame] = sum;
    low[frame] = lowSum;
    [previous, current] = [current, previous];
    [previousLinear, currentLinear] = [currentLinear, previousLinear];
  }
  // A value describes the sound that arrived during its frame; it is timed at the frame's end
  // half (the onset itself is found again on the samples in step 2).
  const times = Float64Array.from({ length: count }, (_, frame) => (frame * HOP + FRAME / 2) / sampleRate);
  return { flux, low, bands, gain, times, hopSeconds: HOP / sampleRate };
}

/** The mean of each value and the `radius` values on each side of it (fewer at the ends). */
export function movingAverage(values, radius) {
  const out = new Float64Array(values.length);
  let sum = 0;
  let from = 0;
  let to = -1;
  for (let i = 0; i < values.length; i += 1) {
    while (to < Math.min(values.length - 1, i + radius)) sum += values[++to];
    while (from < i - radius) sum -= values[from++];
    out[i] = sum / (to - from + 1);
  }
  return out;
}

/**
 * Step 2b: the sample where a sound starts, near `guess` seconds. Looks from 40 ms before to
 * 60 ms after the guess for the first millisecond whose change in level reaches half the
 * strongest change there.
 */
function refineOnset(samples, sampleRate, guess) {
  const bin = Math.max(1, Math.round(sampleRate / 1000));
  const from = Math.max(1, Math.round((guess - 0.04) * sampleRate));
  const to = Math.min(samples.length, Math.round((guess + 0.06) * sampleRate));
  const energies = [];
  for (let start = from; start < to; start += bin) {
    let energy = 0;
    for (let i = start; i < Math.min(to, start + bin); i += 1) {
      const change = samples[i] - samples[i - 1];
      energy += change * change;
    }
    energies.push(energy);
  }
  if (!energies.length) return guess;
  const strongest = energies.reduce((best, value) => Math.max(best, value), 0);
  if (!(strongest > 0)) return guess;
  // The first millisecond after the quietest stretch before the strongest change.
  const peakIndex = energies.indexOf(strongest);
  let index = peakIndex;
  while (index > 0 && energies[index - 1] >= strongest * 0.5) index -= 1;
  // Within that millisecond, the first sample that moves by a quarter of its biggest step.
  const start = from + index * bin;
  let biggest = 0;
  for (let i = start; i < Math.min(to, start + bin); i += 1) biggest = Math.max(biggest, Math.abs(samples[i] - samples[i - 1]));
  for (let i = Math.max(from, start - bin); i < Math.min(to, start + bin); i += 1)
    if (Math.abs(samples[i] - samples[i - 1]) >= biggest * 0.25) return i / sampleRate;
  return start / sampleRate;
}

// The largest value within `radius` places of each value.
function movingMax(values, radius) {
  const out = new Float64Array(values.length);
  // Places from i - radius to i + radius whose values get smaller: the first is the largest.
  const queue = [];
  let head = 0;
  for (let i = 0, to = 0; i < values.length; i += 1) {
    for (; to < Math.min(values.length, i + radius + 1); to += 1) {
      while (queue.length > head && values[queue.at(-1)] <= values[to]) queue.pop();
      queue.push(to);
    }
    while (queue[head] < i - radius) head += 1;
    out[i] = values[queue[head]];
  }
  return out;
}

export const BANDS = ["low", "mid", "high"];

// Step 2c: the band that gained the most new sound at frame i and the two after it (a kick's body
// follows its click): low (kick, bass, under 150 Hz), mid (snare, clap, voice) or high (hi-hats).
function gainBand(gain, i) {
  const totals = gain.map((band) => {
    let sum = 0;
    for (let j = i; j <= Math.min(band.length - 1, i + 2); j += 1) sum += band[j];
    return sum;
  });
  return BANDS[totals.indexOf(Math.max(...totals))];
}

/**
 * Step 2d: each onset's weight, how hard it hits, from 0 to 1: how much louder the 50 ms after it
 * are than the 50 ms before, against the song's hardest hits (the 95th percentile, so one freak
 * peak does not shrink the rest). A drop's kick weighs about 1, a hi-hat or a soft intro little.
 * Unlike strength, which compares an onset with the sound within 4 s of it, weight compares it
 * with the whole song.
 */
export function weighOnsets(samples, sampleRate, onsets) {
  const span = Math.round(0.05 * sampleRate);
  const punches = onsets.map((onset) => {
    const at = Math.round(onset.time * sampleRate);
    return Math.max(0, loudness(samples, at, at + span) - loudness(samples, at - span - Math.round(0.005 * sampleRate), at - Math.round(0.005 * sampleRate)));
  });
  const sorted = [...punches].sort((a, b) => a - b);
  const reference = sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0;
  return onsets.map((onset, index) => ({ ...onset, weight: reference > 0 ? Math.round(Math.min(1, punches[index] / reference) * 100) / 100 : 0 }));
}

/** Step 2: onsets as {time, strength, low, band}: strength from 0 to 1, low the part below 200 Hz. */
export function findOnsets(samples, sampleRate, strength = onsetStrength(samples, sampleRate)) {
  const { flux, low, times, hopSeconds } = strength;
  if (!flux.some((value) => value > 0)) return [];
  // Each onset is measured against the largest rise within NEARBY_SECONDS of it, so its strength
  // depends on the sound around it, not on a louder part elsewhere in the file.
  const nearby = Math.round(NEARBY_SECONDS / hopSeconds);
  const largest = movingMax(flux, nearby);
  const largestLow = movingMax(low, nearby);
  const local = movingAverage(flux, Math.round(0.1 / hopSeconds));
  const spacing = Math.max(1, Math.round(0.03 / hopSeconds));
  const onsets = [];
  for (let i = 1; i < flux.length - 1; i += 1) {
    const value = flux[i];
    if (value < local[i] * 1.5 || value < largest[i] * 0.08) continue;
    let peak = true;
    for (let j = Math.max(0, i - spacing); j <= Math.min(flux.length - 1, i + spacing) && peak; j += 1)
      if (flux[j] > value || (flux[j] === value && j < i)) peak = false;
    if (!peak) continue;
    // The low part can peak a frame or two later than the whole (a kick's body follows its click).
    let lowPeak = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(flux.length - 1, i + 2); j += 1) lowPeak = Math.max(lowPeak, low[j]);
    const onset = { time: refineOnset(samples, sampleRate, times[i]), strength: value / largest[i], low: lowPeak / (largestLow[i] || 1) };
    if (strength.gain) onset.band = gainBand(strength.gain, i);
    onsets.push(onset);
  }
  // Two peaks that refine onto the same start are one onset.
  return onsets.filter((onset, index) => index === 0 || onset.time - onsets[index - 1].time > 0.02);
}

// How much more likely a tempo is, given that two tempos fit equally (a broad bell around 120).
const tempoPrior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.5) ** 2);

/** Step 3: the beat period in seconds from the autocorrelation of the onset curve, or null. */
export function estimatePeriod(strength, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const { flux, hopSeconds } = strength;
  const mean = flux.reduce((sum, value) => sum + value, 0) / Math.max(1, flux.length);
  const curve = Float64Array.from(flux, (value) => Math.max(0, value - mean));
  const shortest = Math.max(1, Math.floor(60 / maxBpm / hopSeconds));
  const longest = Math.ceil(60 / minBpm / hopSeconds);
  if (curve.length < longest * 2) return null;
  const score = new Float64Array(longest + 2);
  for (let lag = Math.max(1, shortest - 1); lag <= longest + 1; lag += 1) {
    let sum = 0;
    for (let i = lag; i < curve.length; i += 1) sum += curve[i] * curve[i - lag];
    score[lag] = sum / (curve.length - lag);
  }
  let best = -1;
  let bestValue = 0;
  for (let lag = shortest; lag <= longest; lag += 1) {
    if (score[lag] < score[lag - 1] || score[lag] < score[lag + 1]) continue;
    const value = score[lag] * tempoPrior(60 / (lag * hopSeconds));
    if (value > bestValue) { bestValue = value; best = lag; }
  }
  if (best < 0) return null;
  // Parabolic interpolation between neighboring lags.
  const [a, b, c] = [score[best - 1], score[best], score[best + 1]];
  const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
  return (best + Math.max(-0.5, Math.min(0.5, shift))) * hopSeconds;
}

// Step 3, from version 6. The onset curve of each band (kick, snare, hats), with slow swells
// taken out and scaled to the same loudness, then added: each band counts the same.
function tempoCurves(strength) {
  const { bands, hopSeconds } = strength;
  const radius = Math.round(0.3 / hopSeconds);
  return bands.map((band) => {
    const trend = movingAverage(band, radius);
    const rise = Float64Array.from(band, (value, i) => Math.max(0, value - trend[i]));
    let squares = 0;
    for (const value of rise) squares += value * value;
    const rms = Math.sqrt(squares / Math.max(1, rise.length)) || 1;
    for (let i = 0; i < rise.length; i += 1) rise[i] /= rms;
    return rise;
  });
}

function sumCurves(curves) {
  const out = new Float64Array(curves[0].length);
  for (const curve of curves) for (let i = 0; i < out.length; i += 1) out[i] += curve[i];
  return out;
}

// How well the curve matches itself `lag` frames later (0 to 1 against lag 0), for each lag.
function autocorrelation(curve, maxLag) {
  const mean = curve.reduce((sum, value) => sum + value, 0) / Math.max(1, curve.length);
  const centered = Float64Array.from(curve, (value) => value - mean);
  const out = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag += 1) {
    let sum = 0;
    for (let i = lag; i < centered.length; i += 1) sum += centered[i] * centered[i - lag];
    out[lag] = sum / (centered.length - lag);
  }
  const zero = out[0] || 1;
  for (let lag = 0; lag < out.length; lag += 1) out[lag] /= zero;
  return out;
}

// The value at a fractional lag (straight line between whole lags).
function at(values, lag) {
  const below = Math.floor(lag);
  if (below < 0 || below + 1 >= values.length) return 0;
  return values[below] + (lag - below) * (values[below + 1] - values[below]);
}

// A tempo's likelihood before listening: a bell on a log scale around 120 beats a minute, one
// octave wide (the shape librosa uses): 60 and 240 are each 0.61 as likely as 120.
const tempoBell = (bpm) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
// The octave rules of step 3, measured on 21 songs with published tempos (tests/tempo-eval.mjs).
// Twice the tempo is taken when it scores at least FASTER of the best score.
const FASTER = 0.85;
// The beat halves when kick and snare halfway between beats reach HALVE of their strength on the
// beats, and doubles when they stay below DOUBLE of it.
const HALVE = 0.7;
const DOUBLE = 0.15;

// The pulse of a period `lag` (in frames): the curve's mean on the best-placed grid of that
// period, and its mean halfway between those grid beats. Measured over windows of `span` frames,
// each with its own best grid (a tempo a little off would drift off the beat over a whole song),
// and added up.
function pulse(curve, lag, span) {
  const places = Math.max(1, Math.round(lag));
  // The largest value within a frame either side, so a hit between two frames still counts.
  const near = (x) => Math.max(at(curve, x - 1), at(curve, x), at(curve, x + 1));
  let on = 0, between = 0;
  for (let from = 0; from + span <= curve.length; from += span) {
    let best = { on: -1, between: 0 };
    for (let phase = 0; phase < places; phase += 1) {
      let onSum = 0, betweenSum = 0;
      for (let t = from + phase; t + lag / 2 + 1 < from + span; t += lag) {
        onSum += near(t);
        betweenSum += near(t + lag / 2);
      }
      if (onSum > best.on) best = { on: onSum, between: betweenSum };
    }
    on += best.on;
    between += best.between;
  }
  return { on, between };
}

/**
 * Step 3: {period, alt}: the beat period in seconds (null when the sound is too short), and the
 * other octave's period when it scores nearly as well (or null). Each tempo from MIN_BPM to
 * MAX_BPM is scored by how well the band curves match themselves one, two and four beats later
 * (a beat, half a bar, a bar), times the tempo bell. Then the octave: twice the tempo when it
 * scores nearly as well; then twice again while kick and snare hit nearly as hard halfway between
 * beats as on them, and half while they hardly hit there (every other beat is empty).
 */
export function estimateTempo(strength, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const { hopSeconds } = strength;
  if (!strength.bands) return { period: estimatePeriod(strength, { minBpm, maxBpm }), alt: null };
  const curves = tempoCurves(strength);
  const all = sumCurves(curves);
  const drums = sumCurves(curves.slice(0, 2));
  const longest = 60 / minBpm / hopSeconds;
  if (all.length < longest * 2) return { period: null, alt: null };
  const ac = autocorrelation(all, Math.ceil(longest * 4) + 2);
  const score = (bpm) => {
    const lag = 60 / bpm / hopSeconds;
    return Math.max(0, at(ac, lag) + 0.5 * at(ac, 2 * lag) + 0.5 * at(ac, 4 * lag)) * tempoBell(bpm);
  };
  let bpm = 0;
  let best = -1;
  for (let candidate = minBpm; candidate <= maxBpm; candidate += 0.25) {
    const value = score(candidate);
    if (value > best) { best = value; bpm = candidate; }
  }
  if (!(best > 0)) return { period: null, alt: null };
  // The exact lag: the highest whole lag next to it, then a parabola through that lag and its
  // neighbors (the beat grid in step 4 fits it closer still).
  const exact = (lag) => {
    let peak = Math.round(lag);
    for (const near of [peak - 1, peak + 1]) if (near > 0 && ac[near] > ac[peak]) peak = near;
    const [a, b, c] = [ac[peak - 1], ac[peak], ac[peak + 1]];
    const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
    return peak + Math.max(-0.5, Math.min(0.5, shift));
  };
  // Twice the tempo nearly as likely: the faster one (song sites list dance music, drum and bass
  // and trap at the faster of the two).
  if (bpm * 2 <= maxBpm + 0.5 && score(bpm * 2) >= best * FASTER) bpm *= 2;
  let lag = exact(60 / bpm / hopSeconds);
  const span = Math.min(Math.round(8 / hopSeconds), drums.length);
  // Octave: kick and snare hitting nearly as hard halfway between beats as on them means the beat
  // is twice as fast; hardly hitting there means every other beat is empty (half as fast).
  for (let guard = 0; guard < 2 && 60 / (lag / 2 * hopSeconds) <= maxBpm + 0.5; guard += 1) {
    const { on, between } = pulse(drums, lag, span);
    if (on > 0 && between >= on * HALVE) lag /= 2; else break;
  }
  for (let guard = 0; guard < 2 && 60 / (lag * 2 * hopSeconds) >= minBpm - 0.5; guard += 1) {
    const { on, between } = pulse(drums, lag * 2, span);
    if (on > 0 && between < on * DOUBLE) lag *= 2; else break;
  }
  // The other octave when its score comes close (an agent may want it for a half-time edit).
  bpm = 60 / (lag * hopSeconds);
  const others = [bpm * 2, bpm / 2].filter((value) => value >= minBpm - 0.5 && value <= maxBpm + 0.5);
  const alt = others.find((value) => score(value) >= score(bpm) * 0.7) ?? null;
  return { period: lag * hopSeconds, alt: alt ? 60 / alt : null };
}

// Step 4: evenly spaced beats through the onsets. Returns {period, phase, matched}.
// The period from step 3 can be off by half a millisecond a beat. Over a long song that adds up
// past a whole beat (0.5 ms a beat is 0.6 s after ten minutes), and the grid would sit on the
// beat in one part of the song and between beats elsewhere. So a song longer than FIT_SPAN is
// fitted to the FIT_SPAN stretch where the grid fits best, then to twice as long a stretch around
// it, and so on until the stretch covers the song: each fit is close enough to extend.
function fitGrid(onsets, period) {
  const strong = onsets.filter((onset) => onset.strength >= 0.2);
  const used = strong.length >= 4 ? strong : onsets;
  const start = used[0].time;
  const end = used.at(-1).time;
  if (end - start <= FIT_SPAN) return fitStretch(used, period, bestPhase(used, period).phase);
  let anchor = null;
  for (let from = start; from < end; from += FIT_SPAN / 2) {
    const part = used.filter((onset) => onset.time >= from && onset.time < from + FIT_SPAN);
    if (part.length < 2) continue;
    const { phase, score } = bestPhase(part, period);
    if (!anchor || score > anchor.score) anchor = { centre: from + FIT_SPAN / 2, phase, score };
  }
  let grid = { period, phase: anchor.phase, matched: [] };
  for (let span = FIT_SPAN; ; span *= 2) {
    const part = used.filter((onset) => Math.abs(onset.time - anchor.centre) <= span / 2);
    grid = fitStretch(part, grid.period, grid.phase);
    if (span / 2 >= Math.max(anchor.centre - start, end - anchor.centre)) return grid;
  }
}

// The phase that puts the most onset strength on a grid with this period (1 ms steps), and that
// strength.
function bestPhase(onsets, period) {
  let phase = 0;
  let score = -1;
  for (let candidate = 0; candidate < period; candidate += 0.001) {
    let total = 0;
    for (const onset of onsets) {
      const distance = Math.abs(((onset.time - candidate) / period - Math.round((onset.time - candidate) / period)) * period);
      if (distance < MATCH_SECONDS) total += onset.strength * (1 - distance / MATCH_SECONDS);
    }
    if (total > score) { score = total; phase = candidate; }
  }
  return { phase, score };
}

// Least squares: time = phase + index × period over the onsets near the grid. The window
// narrows as the fit improves.
function fitStretch(onsets, period, phase) {
  let matched = [];
  for (const window of [0.15 * period, 0.08 * period, MATCH_SECONDS]) {
    matched = [];
    for (const onset of onsets) {
      const index = Math.round((onset.time - phase) / period);
      if (Math.abs(onset.time - (phase + index * period)) <= window) matched.push({ index, time: onset.time, weight: onset.strength });
    }
    const line = matched.length >= 2 ? fitLine(matched) : null;
    if (!line) break;
    ({ period, phase } = line);
  }
  return { period, phase, matched };
}

/**
 * The straight line time = phase + index × period closest to `matched` [{index, time, weight}]
 * (weighted least squares: stronger onsets count more). Returns {period, phase}, or null when
 * the onsets cannot give a line that goes forward in time.
 */
function fitLine(matched) {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { index, time, weight } of matched) {
    sw += weight; sx += weight * index; sy += weight * time; sxx += weight * index * index; sxy += weight * index * time;
  }
  const denominator = sw * sxx - sx * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const slope = (sw * sxy - sx * sy) / denominator;
  return slope > 0 ? { period: slope, phase: (sy - slope * sx) / sw } : null;
}

// Step 4b: one beat's time. The whole file chooses which onsets are on the grid, but where a beat
// sits comes only from those within NEARBY_SECONDS of it: the line through them when there are at
// least 4 of them, 4 or more beats apart; otherwise the grid moved by how far they are from it,
// on average. So a beat depends on the sound around it, not on how the file ends.
function nearbyBeat(grid, index) {
  const time = grid.phase + index * grid.period;
  const near = grid.matched.filter((entry) => Math.abs(entry.time - time) <= NEARBY_SECONDS);
  const indexes = near.map((entry) => entry.index);
  const line = near.length >= 4 && Math.max(...indexes) - Math.min(...indexes) >= 4 ? fitLine(near) : null;
  if (line) return line.phase + index * line.period;
  let weight = 0;
  let shift = 0;
  for (const entry of near) {
    weight += entry.weight;
    shift += entry.weight * (entry.time - (grid.phase + entry.index * grid.period));
  }
  return weight > 0 ? time + shift / weight : time;
}

// The low-frequency strength of the onsets on a grid with this phase.
function lowOnGrid(onsets, period, phase) {
  let total = 0;
  for (const onset of onsets) {
    const position = (onset.time - phase) / period;
    if (Math.abs(position - Math.round(position)) * period <= MATCH_SECONDS) total += onset.low ?? 0;
  }
  return total;
}

// The frames that overlap the silence put in front of the sound (and the first one after it,
// which is compared with one that does) rise no higher than the largest value after them.
function capStart(values) {
  const start = FRAME / HOP + 1;
  let largest = 0;
  for (let i = start; i < values.length; i += 1) largest = Math.max(largest, values[i]);
  if (!(largest > 0)) return;
  for (let i = 0; i < Math.min(start, values.length); i += 1) values[i] = Math.min(values[i], largest);
}

// The loudness (root mean square) of samples[from] up to samples[to].
function loudness(samples, start, to) {
  const from = Math.max(0, start);
  const end = Math.min(samples.length, to);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - from));
}

// The loudness of the quietest 20 ms of the sound: its noise floor (0 with digital silence).
function quietestLoudness(samples, sampleRate) {
  const slice = Math.round(0.02 * sampleRate);
  let quietest = loudness(samples, 0, slice);
  for (let from = slice; from + slice <= samples.length; from += slice) quietest = Math.min(quietest, loudness(samples, from, from + slice));
  return quietest;
}

// Whether the sound starts with a hit, too early for the first frames to see it rise (in about
// the first 30 ms): from some moment in the first half frame, the next 20 ms are much louder
// (12 dB) than the quietest 20 ms of the sound and louder (by a fifth) than the 40 ms after
// them, as a hit dies away. Hiss, room tone or music already playing is none of these.
function startsWithHit(samples, sampleRate) {
  const slice = Math.round(0.02 * sampleRate);
  const quietest = quietestLoudness(samples, sampleRate);
  for (let from = 0; from < FRAME / 2; from += Math.max(1, Math.round(sampleRate / 1000))) {
    const head = loudness(samples, from, from + slice);
    if (head > 4 * quietest && head > 1.2 * loudness(samples, from + slice, from + 3 * slice)) return true;
  }
  return false;
}

/**
 * The beat and onsets of mono `samples` at `sampleRate`. Returns
 * {version, duration, bpm, alt, period, beats[], onsets[{time, strength, low, band, weight}], confidence, note?}
 * with times in seconds of the source; bpm is null when no steady beat is found.
 */
export function analyzeBeats(samples, sampleRate, options = {}) {
  const duration = samples.length / sampleRate;
  // A hit right at the start has nothing before it to be louder than (the first frame is the
  // first). So when the sound starts with a hit, one frame of silence goes in front and the hit
  // rises from silence like any other. Otherwise the sound is read as it is: that silence would
  // make hiss, room tone or music already playing at the start look like a hit. The padding is
  // taken off every onset time again.
  const pad = startsWithHit(samples, sampleRate) ? FRAME : 0;
  let padded = samples;
  if (pad) {
    padded = new Float32Array(samples.length + pad);
    padded.set(samples, pad);
  }
  const strength = onsetStrength(padded, sampleRate);
  // Sound playing under that first hit rises from the silence too: it counts as no louder than
  // the loudest rise later on, so it does not drown out the hits after it.
  if (pad) {
    capStart(strength.flux);
    capStart(strength.low);
    strength.bands.forEach(capStart);
  }
  const onsets = weighOnsets(samples, sampleRate, findOnsets(padded, sampleRate, strength)
    .map((onset) => ({ ...onset, time: Math.max(0, onset.time - pad / sampleRate) })));
  const result = { version: BEAT_ANALYSIS_VERSION, duration, bpm: null, alt: null, period: null, beats: [], onsets, confidence: 0 };
  if (onsets.length < 4) return { ...result, note: onsets.length ? "Too few onsets to find a beat." : "No onsets: the sound is silent or steady." };
  const tempo = estimateTempo(strength, options);
  let period = tempo.period;
  if (!period) return { ...result, note: "Too short to find a beat (it needs two beats at 60 a minute)." };
  let grid = fitGrid(onsets, period);
  // Kick drums and bass mark the beat; hi-hats often play between beats. When the onsets half a
  // beat later carry clearly more low sound, the grid moves there.
  const shifted = grid.phase + grid.period / 2;
  if (lowOnGrid(onsets, grid.period, shifted) > 1.5 * lowOnGrid(onsets, grid.period, grid.phase) + 1e-9) {
    const moved = fitGrid(onsets.map((onset) => ({ ...onset, strength: Math.max(onset.low ?? 0, 0.01) })), grid.period);
    if (moved.matched.length) grid = moved;
  }
  period = grid.period;
  if (!grid.matched.length) return { ...result, note: "No steady beat found." };
  // Beats run from the first to the last onset on the grid.
  const indexes = grid.matched.map((entry) => entry.index);
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  const beats = [];
  for (let index = first; index <= last; index += 1) {
    const time = nearbyBeat(grid, index);
    if (time >= 0 && time <= duration) beats.push(Math.round(time * 1e4) / 1e4);
  }
  // Confidence: the share of beats with an onset on them.
  let landed = 0;
  let cursor = 0;
  for (const beat of beats) {
    while (cursor < onsets.length && onsets[cursor].time < beat - MATCH_SECONDS) cursor += 1;
    if (cursor < onsets.length && Math.abs(onsets[cursor].time - beat) <= MATCH_SECONDS) landed += 1;
  }
  const confidence = beats.length ? Math.round((landed / beats.length) * 100) / 100 : 0;
  return {
    ...result,
    bpm: Math.round((60 / period) * 100) / 100,
    // The other octave (twice or half the tempo) when it fits nearly as well, else null.
    alt: tempo.alt ? Math.round((60 / (tempo.alt * period / tempo.period)) * 100) / 100 : null,
    period,
    beats,
    confidence,
    ...(confidence < CONFIDENT ? { note: "Beat grid uncertain: check it by ear before timing to it." } : {}),
  };
}
