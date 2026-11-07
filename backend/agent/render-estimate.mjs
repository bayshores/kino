// How long a render will take on this computer. The guess comes from the last finished renders
// of the same quality: wall-clock seconds for each second of video they drew. Before any render
// has finished here, a default is used.
//
// The defaults are seconds per second of video. A fixed 1.5 for final renders came out about a
// quarter of the real time on a laptop (a 25 s video said "about 38s" and took 2 minutes).
export const DEFAULT_RATES = Object.freeze({ draft: 1.2, final: 4 });
const RECENT = 5;
// A render shorter than this (cache hits, tiny clips) says more about startup than about speed.
const LEAST_SECONDS = 1;

/** Wall seconds per drawn second of a finished job, or null when it cannot be measured. */
export function jobRate(job) {
  if (job?.status !== "done" || !Number.isFinite(job.finishedAt) || !Number.isFinite(job.startedAt)) return null;
  const drawn = Number(job.drawnSeconds);
  if (!(drawn >= LEAST_SECONDS)) return null;
  const elapsed = (job.finishedAt - job.startedAt) / 1000;
  return elapsed > 0 ? elapsed / drawn : null;
}

/** The seconds of video a finished job drew (cached scenes are copied, not drawn). */
export function drawnSeconds(files) {
  return (files ?? []).reduce((sum, file) => sum + (file.cached || !(file.fps > 0) ? 0 : (file.renderedFrames ?? 0) / file.fps), 0);
}

/**
 * The estimate for a new render: { seconds, measured } where measured says it comes from renders
 * on this computer (the median of the last few of this quality) and not the default.
 */
export function renderEstimate(jobs, quality, videoSeconds) {
  const rates = [...(jobs ?? [])].filter((job) => job.quality === quality).map(jobRate).filter((rate) => rate !== null).slice(-RECENT).sort((a, b) => a - b);
  const measured = rates.length > 0;
  const rate = measured ? rates[Math.floor(rates.length / 2)] : DEFAULT_RATES[quality] ?? DEFAULT_RATES.final;
  return { seconds: Math.max(1, Math.round(videoSeconds * rate)), measured };
}

/** "about 40s", "about 2 min" or "about 1 h 5 min". */
export function estimateWords(seconds) {
  if (seconds < 90) return `about ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
