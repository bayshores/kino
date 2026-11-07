import assert from "node:assert/strict";
import test from "node:test";
import { AUDIO_PEAK_VERSION, downsamplePeaks, normalizePeaks, validAudioPeaks } from "./audioPeaks.js";

test("peak downsampling keeps transients and opposite-phase channels", () => {
  assert.deepEqual(downsamplePeaks([0, 0, 0.2, -0.8, 0, 0, 0.1, -0.1], 2, 2), [0.8, 0.1]);
  assert.deepEqual(downsamplePeaks([0, 0, 0, 0, 0.9], 2), [0, 0, 0.9]);
  assert.deepEqual(downsamplePeaks([0.1, 0.8, 0.2, 0.4], 2), [0.8, 0.4]);
});

test("normalization uses the whole file peak, preserves silence, and handles invalid samples", () => {
  assert.deepEqual(normalizePeaks([0, 0.002, 0.004]), [0, 0.5, 1]);
  assert.deepEqual(normalizePeaks([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(normalizePeaks([NaN, Infinity, -0.5, 1]), [0, 0, 0.5, 1]);
  assert.deepEqual(normalizePeaks([]), []);
});

test("cached peaks are bounded, finite normalized data with a known time scale", () => {
  const data = { version: AUDIO_PEAK_VERSION, available: true, duration: 0.02, secondsPerPeak: 0.01, peaks: [0, 1] };
  assert.equal(validAudioPeaks(data), true);
  assert.equal(validAudioPeaks({ ...data, peaks: [NaN] }), false);
  assert.equal(validAudioPeaks({ ...data, secondsPerPeak: 0 }), false);
  assert.equal(validAudioPeaks({ ...data, version: 0 }), false);
  assert.equal(validAudioPeaks({ ...data, version: 1 }), false, "old timing and bandwidth data must regenerate");
  assert.equal(validAudioPeaks({ ...data, peaks: new Array(120_001).fill(0) }), false);
});
