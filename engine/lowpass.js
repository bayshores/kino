// The low-pass filter on a video or audio layer's sound (layer.lowpass, and Lowpass animations).
// The cutoff is in Hz: sound above it is turned down, so a low cutoff sounds muffled. 0 (or no
// lowpass at all) means off. A cutoff at LOWPASS_OPEN or above is fully open and also plays the
// sound unfiltered. Export and the dashboard's mix apply it with FFmpeg's lowpass filter
// (backend/lowpass-track.mjs); animation.js lowpassSampler gives the cutoff over time.
export const LOWPASS_MIN = 20;
export const LOWPASS_OPEN = 20_000;
