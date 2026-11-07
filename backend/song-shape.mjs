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
// - features: groove (where the kicks fall in the bar), bass, brightness, density, dynamics (0 to
//   100 each). vocals is filled in by the caller from the vocal spans.
// songVocals(file) finds where a voice sings or raps with whisper.cpp (it writes sung words too);
// songShape's voiceGuess is the rougher fallback when whisper is not installed.
import { readFile, writeFile } from "node:fs/promises";
import { decodeMono } from "./audio-analysis.mjs";
import { SAMPLE_RATE as SPEECH_RATE, whisperSegments, whisperSetup } from "./speech/transcribe.mjs";

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
 * whole spectrum's (every hit), and 24 log-spaced band energies.
 */
export function spectralFrames(samples, sampleRate) {
  const size = 2 ** Math.round(Math.log2(sampleRate * 0.093));
  const hop = size / 2;
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

/** A drop or break placed to the frame: where the low band's change is steepest within 2 s. */
function refine(at, kind, frames) {
  if (kind !== "drop" && kind !== "break" && kind !== "outro") return at;
  const per = 1 / frames.hopSeconds;
  const db = Array.from(frames.low, (value) => 10 * Math.log10(value + 1e-12));
  let best = at;
  let bestStep = -Infinity;
  const span = Math.round(per / 4);
  for (let f = Math.max(span, Math.floor((at - 2) * per)); f < Math.min(db.length - span, Math.ceil((at + 2) * per)); f += 1) {
    const change = mean(db.slice(f, f + span)) - mean(db.slice(f - span, f));
    const score = kind === "drop" ? change : -change;
    if (score > bestStep) { bestStep = score; best = f * frames.hopSeconds; }
  }
  return round(best, 1);
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
 * (false when the samples stop before the song does: no outro then).
 * Returns {sections: [{at, kind}], features: {groove, bass, brightness, density, dynamics}, low,
 * voiceGuess} (low: the low band each second, 0 to 100; voiceGuess: rough vocal spans).
 */
export function songShape(samples, sampleRate, { bpm = null, whole = true } = {}) {
  const frames = spectralFrames(samples, sampleRate);
  const seconds = Math.floor(frames.count * frames.hopSeconds);
  if (seconds < 8) return { sections: [], features: { groove: "free", bass: 0, brightness: 0, density: 0, dynamics: 0 }, low: [], voiceGuess: [] };
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
  const sections = sectionsFromCurves({ low, rise, novelty, whole }).map((part) => ({ at: refine(part.at, part.kind, frames), kind: part.kind }));

  // Features.
  const lowSum = frames.low.reduce((sum, value) => sum + value, 0);
  const totalSum = frames.total.reduce((sum, value) => sum + value, 0) || 1;
  const highSum = frames.high.reduce((sum, value) => sum + value, 0);
  const fluxPeaks = peaks(Array.from(frames.flux), 2, percentile(Array.from(frames.flux), 0.6) * 1.2).length;
  const secondDb = perSecond(frames.total, frames, seconds).map((value) => 10 * Math.log10(value + 1e-12));
  const lowFrameOn = Uint8Array.from(frames.low, (value, f) => (low[Math.min(seconds - 1, Math.floor(f * frames.hopSeconds))] >= 50 ? 1 : 0));
  return {
    sections,
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
 * (whisper's times drift less in short pieces). Throws when whisper is not installed.
 */
export async function songVocals(file, { seconds = 240, setup = whisperSetup(), decode = decodeMono, piece = 15 } = {}) {
  const { samples } = await decode(file, { sampleRate: SPEECH_RATE });
  const limited = samples.subarray(0, Math.round(seconds * SPEECH_RATE));
  const pieces = [];
  for (let from = 0; from < limited.length / SPEECH_RATE; from += piece) pieces.push({ from, samples: limited.subarray(from * SPEECH_RATE, Math.min(limited.length, (from + piece) * SPEECH_RATE)) });
  const lists = await whisperSegments(pieces.map((part) => part.samples), setup, { args: ["-sns", "-mc", "0"] });
  const spans = lists.flatMap((list, index) => sungSegments(list).map((segment) => [pieces[index].from + segment.from, Math.min(pieces[index].from + piece, pieces[index].from + segment.to)]));
  return joinSpans(spans);
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

// Bump when songShape's sections change, so kept results are made again.
export const SONG_SHAPE_VERSION = 1;

/**
 * Each media file's song shape, measured once and kept in a .song file beside it (like the
 * .beats file of the beat analysis): {version, seconds, whole, sections}. fit_music reads it.
 */
export function createSongShapeCache({ decode = decodeMono } = {}) {
  const pending = new Map();
  async function readOrMeasure(file, bpm) {
    const sidecar = `${file}.song`;
    try {
      const saved = JSON.parse(await readFile(sidecar, "utf8"));
      if (saved?.version === SONG_SHAPE_VERSION && Array.isArray(saved.sections)) return saved;
    } catch { /* Missing or old results are made again. */ }
    const { samples, sampleRate } = await decode(file);
    if (!samples.length) throw new Error("The file has no sound.");
    const result = { version: SONG_SHAPE_VERSION, seconds: round(samples.length / sampleRate, 3), whole: true, sections: songShape(samples, sampleRate, { bpm }).sections };
    await writeFile(sidecar, JSON.stringify(result), { mode: 0o600 }).catch(() => { /* it still counts unsaved */ });
    return result;
  }
  return {
    get(file, bpm = null) {
      if (!pending.has(file)) pending.set(file, readOrMeasure(file, bpm).finally(() => pending.delete(file)));
      return pending.get(file);
    },
  };
}
