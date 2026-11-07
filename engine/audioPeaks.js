// Derived audio data, shared by the server's extractor and the Timeline's drawing.
// Version 2 preserves the media clock's timestamp gaps and the source sample rate.
export const AUDIO_PEAK_VERSION = 2;
export const AUDIO_PEAKS_PER_SECOND = 100;
export const MAX_AUDIO_PEAKS = 120_000;

function magnitude(value) {
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

/** One maximum per group of frames. Opposite-phase channels cannot cancel a peak. */
export function downsamplePeaks(samples, framesPerPeak, channels = 1) {
  const size = Math.max(1, Math.floor(framesPerPeak)) * Math.max(1, Math.floor(channels));
  const peaks = [];
  for (let start = 0; start < samples.length; start += size) {
    let peak = 0;
    for (let index = start; index < Math.min(start + size, samples.length); index++)
      peak = Math.max(peak, magnitude(samples[index]));
    peaks.push(peak);
  }
  return peaks;
}

/** Scale against the whole file, so a quiet recording is visible and silence stays zero. */
export function normalizePeaks(peaks) {
  let largest = 0;
  for (const peak of peaks) largest = Math.max(largest, magnitude(peak));
  return Array.from(peaks, (peak) => largest > 0 ? magnitude(peak) / largest : 0);
}

export function validAudioPeaks(data) {
  return data?.version === AUDIO_PEAK_VERSION && typeof data.available === "boolean" &&
    Number.isFinite(data.duration) && data.duration >= 0 &&
    Number.isFinite(data.secondsPerPeak) && data.secondsPerPeak > 0 &&
    Array.isArray(data.peaks) && data.peaks.length <= MAX_AUDIO_PEAKS &&
    (!data.available || (data.duration > 0 && data.peaks.length > 0)) &&
    data.peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1);
}
