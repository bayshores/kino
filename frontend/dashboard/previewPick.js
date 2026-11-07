// The preview cache on the stage: while playing, a
// stretch whose 2 s segment the server has rendered (backend/preview-scheduler.mjs) plays from that
// silent video file instead of being drawn live. This picks the source for one moment.

const NONE = Object.freeze({ show: null, preload: null, liveAt: null });

/**
 * At scene time `time` (on the frame grid), given the list from GET /api/dashboard/preview (with the
 * projectId and sceneId it was asked for): `show` is the ready segment under the playhead, `preload`
 * the ready segment after it (the scene loops, so after the last comes the first), and `liveAt` the
 * end of the run of ready segments from `show` on, where live drawing takes over again (so it waits
 * there, already drawn). Nothing shows unless the list is for this project, scene and revision.
 */
export function previewPick(list, { projectId, sceneId, rev, time }) {
  if (!list?.on || !Array.isArray(list.segments) || list.projectId !== projectId || list.sceneId !== sceneId || list.rev !== rev) return NONE;
  const fps = list.fps || 30;
  // Whole frames, so 59/30 s is in the first segment and 60/30 s in the second.
  const frame = Math.round(time * fps);
  const at = (seconds) => Math.round(seconds * fps);
  const segments = list.segments;
  const index = segments.findIndex((segment) => at(segment.start) <= frame && frame < at(segment.end));
  if (index < 0) return NONE;
  const usable = (segment) => (segment?.ready && segment.url ? segment : null);
  const show = usable(segments[index]);
  const after = segments[index + 1] ?? (index > 0 ? segments[0] : null);
  let last = index;
  if (show) while (usable(segments[last + 1])) last += 1;
  return { show, preload: usable(after), liveAt: show ? segments[last].end : null };
}

export const NO_PICK = NONE;

/**
 * The stretches of the scene whose segments are ready, as [[start, end], ...] in seconds, runs of
 * ready segments joined (the timeline's preview line). Empty unless the list is for this project,
 * scene and revision.
 */
export function readyRuns(list, { projectId, sceneId, rev }) {
  if (!list?.on || !Array.isArray(list.segments) || list.projectId !== projectId || list.sceneId !== sceneId || list.rev !== rev) return [];
  const runs = [];
  for (const segment of list.segments) {
    if (!segment.ready) continue;
    const last = runs.at(-1);
    if (last && Math.abs(last[1] - segment.start) < 1e-6) last[1] = segment.end;
    else runs.push([segment.start, segment.end]);
  }
  return runs;
}
