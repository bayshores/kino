// Finds how many samples one sound is late compared with another, by cross-correlation.
// Apple's sound isolation audio unit returns its output late by a few thousand samples, and the
// delay depends on the macOS version, the isolation mode and the sample rate, so kino measures it
// on every run instead of trusting a fixed number.

/** In-place radix-2 FFT of a complex signal held in two arrays. `inverse` also divides by n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length || n & (n - 1)) throw new RangeError("FFT length must be a power of two.");
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
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle), stepIm = Math.sin(angle);
    const half = size >> 1;
    for (let start = 0; start < n; start += size) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k, b = a + half;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}

/** The start of the `length`-sample stretch of `samples` with the most energy (1 s steps). */
export function loudestWindow(samples, length, step = 48000) {
  if (samples.length <= length) return 0;
  let best = 0, bestEnergy = -1;
  for (let start = 0; start + length <= samples.length; start += step) {
    let energy = 0;
    for (let i = start; i < start + length; i += 1) energy += samples[i] * samples[i];
    if (energy > bestEnergy) { bestEnergy = energy; best = start; }
  }
  return best;
}

/**
 * How many samples `late` is behind `reference`, from 0 to `maxLag`.
 * Returns { lag, strength }: strength is the normalized correlation at that lag (1 means the two
 * match exactly once shifted; values near 0 mean nothing in common, so the lag is a guess).
 * Only the loudest `window` samples of the reference are compared, which keeps this fast.
 */
export function measureLag(reference, late, { maxLag = 48000, window = 1 << 19 } = {}) {
  const usable = Math.min(reference.length, late.length);
  const length = Math.min(window, usable);
  if (length < 64) return { lag: 0, strength: 0 };
  const start = loudestWindow(reference.subarray(0, usable), length);
  let size = 1;
  while (size < 2 * (length + maxLag)) size <<= 1;
  const aRe = new Float64Array(size), aIm = new Float64Array(size);
  const bRe = new Float64Array(size), bIm = new Float64Array(size);
  let aEnergy = 0, bEnergy = 0;
  const lateEnd = Math.min(late.length, start + length + maxLag);
  for (let i = start; i < lateEnd; i += 1) aRe[i - start] = late[i];
  for (let i = 0; i < length; i += 1) {
    bRe[i] = reference[start + i];
    bEnergy += bRe[i] * bRe[i];
  }
  fft(aRe, aIm);
  fft(bRe, bIm);
  // a · conj(b), then the inverse transform gives sum over n of late[n + k] · reference[n].
  for (let i = 0; i < size; i += 1) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  fft(aRe, aIm, true);
  let lag = 0, peak = -Infinity;
  for (let k = 0; k <= maxLag && k < size; k += 1) {
    if (aRe[k] > peak) { peak = aRe[k]; lag = k; }
  }
  for (let i = start + lag; i < Math.min(late.length, start + lag + length); i += 1) aEnergy += late[i] * late[i];
  const strength = aEnergy > 0 && bEnergy > 0 ? peak / Math.sqrt(aEnergy * bEnergy) : 0;
  return { lag, strength };
}
