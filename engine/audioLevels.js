// A sound's level over time in four bands, for the audio behavior (behavior.js, behaviorLinks.js).
// Pure: mono samples and their rate in, {version, rate, duration, all, low, mid, high} out, each
// band a list of levels 0..1, `rate` a second. It reads the same decode as the beat analysis
// (backend/audio-analysis.mjs) with beatDetection.js's FFT, and splits the bands by bin center
// (whatever the rate): low under 150 Hz (kick, bass), mid to 2.5 kHz (voice, snare), high above (hats).
// A level is the band's energy in decibels over the 48 dB below the band's loudest moment in the
// file: 1 at that moment, 0 at 48 dB quieter or silence. So a quiet bass line still moves the
// whole amount, and a loud stretch reads higher than a quiet one.
import { fft } from "./beatDetection.js";

export const AUDIO_LEVELS_VERSION = 2;
export const LEVELS_PER_SECOND = 30;
const FRAME = 1024;
const RANGE_DB = 48;
const round3 = (value) => Math.round(value * 1000) / 1000;

export const bandEdges = (sampleRate) => [Math.max(2, Math.ceil((150 * FRAME) / sampleRate)), Math.ceil((2500 * FRAME) / sampleRate)];

export function measureAudioLevels(samples, sampleRate, { rate = LEVELS_PER_SECOND } = {}) {
  const hop = sampleRate / rate;
  const count = Math.max(0, Math.ceil(samples.length / hop));
  const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  // A bin is low when its center is under 150 Hz, high from 2.5 kHz (bins are rate/1024 Hz apart).
  const edges = bandEdges(sampleRate);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const decibels = { all: [], low: [], mid: [], high: [] };
  for (let frame = 0; frame < count; frame += 1) {
    // Each frame is centered on its time.
    const start = Math.round(frame * hop) - FRAME / 2;
    for (let i = 0; i < FRAME; i += 1) {
      const sample = samples[start + i];
      re[i] = Number.isFinite(sample) ? sample * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const energy = [0, 0, 0];
    for (let bin = 1; bin < FRAME / 2; bin += 1) energy[bin < edges[0] ? 0 : bin < edges[1] ? 1 : 2] += re[bin] * re[bin] + im[bin] * im[bin];
    const db = (value) => 10 * Math.log10(value + 1e-12);
    decibels.low.push(db(energy[0]));
    decibels.mid.push(db(energy[1]));
    decibels.high.push(db(energy[2]));
    decibels.all.push(db(energy[0] + energy[1] + energy[2]));
  }
  const levels = Object.fromEntries(Object.entries(decibels).map(([band, values]) => {
    // A silent band (no frame above -100 dB) stays 0.
    const top = values.reduce((most, value) => Math.max(most, value), -100);
    return [band, values.map((value) => (top <= -100 ? 0 : round3(Math.max(0, Math.min(1, (value - (top - RANGE_DB)) / RANGE_DB)))))];
  }));
  return { version: AUDIO_LEVELS_VERSION, rate, duration: samples.length / sampleRate, ...levels };
}
