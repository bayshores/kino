// The preview cache's background worker (step 2; preview-segments.mjs is step 1). While
// kino is idle it renders the missing segments of the project you watch, one at a time and the
// heaviest first, at low priority (render-activity.mjs inBackground). Idle means no render is
// running (agent render, export, look, check, a stage frame), no agent call runs, and no playback request came in the
// last `idleMs`. A render that starts, or playback, stops the segment at once (its abort signal):
// nothing half-made is kept, and it is drawn again later. Segment keys hash what each segment
// shows (preview-segments.mjs), so after an edit only the segments it touched lack a file.
//
// Off when KINO_PREVIEW_CACHE=off, or when `enabled()` answers false (Settings: compute.previewCache).
// Segments of projects deleted or in the trash are removed while idle, at most every PRUNE_MS.
import { callsRunning, onRenderActivity, inBackground, rendersRunning } from "./render-activity.mjs";
import { graphicsCacheInput } from "./render-devices.mjs";
import { PREVIEW_FPS, previewSegmentKeys, previewSize, renderPreviewSegment } from "./preview-segments.mjs";

export const PREVIEW_IDLE_MS = 3000;
const PRUNE_MS = 10 * 60 * 1000;
const PLANS_KEPT = 16;
const KEY = /^[a-f0-9]{64}$/;

export function previewCacheOn(env = process.env) {
  return String(env.KINO_PREVIEW_CACHE ?? "").toLowerCase() !== "off";
}

/**
 * deps: `cache` (createPreviewCache), `project(id)` -> {revision, document} | null, `prepare(id,
 * revision, document, sceneId)` -> {scene, fonts} (components expanded, fonts loaded),
 * `mediaRoot`, `renderSettings()` (the machine settings), `publish(event)` (a segment is ready),
 * `enabled()`, `projectIds()` (the ids of the projects kept, not in the trash), `warn`, `idleMs`,
 * `now`; tests replace `render`, `keys` and `activity`.
 */
export function createPreviewScheduler(deps) {
  const { cache, project, prepare, mediaRoot } = deps;
  const render = deps.render ?? renderPreviewSegment;
  const keys = deps.keys ?? previewSegmentKeys;
  // Agent calls count as busy too: a segment starts only after they end, but one under way is
  // stopped only by a render ("start"), not by a call ("call-start").
  const activity = deps.activity ?? { running: () => rendersRunning() + callsRunning(), listen: onRenderActivity };
  const enabled = deps.enabled ?? (() => previewCacheOn());
  const idleMs = deps.idleMs ?? PREVIEW_IDLE_MS;
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? (() => {});
  const warn = deps.warn ?? ((message) => console.warn(message));
  const machine = () => deps.renderSettings?.() ?? {};
  const plans = new Map();
  const failed = new Set();
  let focus = null;
  let lastBusy = 0;
  let job = null;
  let pumping = false;
  let timer = null;
  let closed = false;
  let prunedAt = -Infinity;

  const stopListening = activity.listen((kind) => {
    lastBusy = now();
    if (kind === "start") job?.controller.abort();
    else later(idleMs);
  });

  function later(ms) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(pump, ms);
    timer.unref?.();
  }

  // Each segment of one scene at one revision, with its key ({scene, fonts, size, segments}),
  // worked out once and kept for the last few revisions.
  function plan(projectId, revision, document, sceneId) {
    const graphics = graphicsCacheInput(machine().graphics);
    const id = `${projectId}\n${revision}\n${sceneId}\n${graphics}`;
    if (plans.has(id)) {
      const value = plans.get(id);
      plans.delete(id);
      plans.set(id, value);
      return value;
    }
    const value = (async () => {
      const { scene, fonts } = await prepare(projectId, revision, document, sceneId);
      const size = previewSize(scene);
      const segments = await keys(scene, { size, fps: PREVIEW_FPS, fonts, mediaRoot, graphics });
      return { scene, fonts, size, segments };
    })();
    value.catch(() => plans.delete(id));
    plans.set(id, value);
    while (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value);
    return value;
  }

  async function ready(key) {
    try { return Boolean(await cache.locate(key)); } catch { return false; }
  }

  /**
   * GET preview: each segment of a scene at a revision with whether its file is ready.
   * Returns {on, rev, fps, width, height, segments: [{index, start, end, key, ready, url?}]}.
   */
  async function list(projectId, sceneId, { revision, document }) {
    focus = projectId;
    if (!enabled()) return { on: false, rev: revision, segments: [] };
    const { size, segments } = await plan(projectId, revision, document, sceneId);
    later(0);
    return {
      on: true, rev: revision, fps: PREVIEW_FPS, width: size.width, height: size.height,
      segments: await Promise.all(segments.map(async ({ index, start, end, key }) => {
        const isReady = await ready(key);
        return { index, start, end, key, ready: isReady, ...(isReady ? { url: `/api/dashboard/preview/${key}.mp4` } : {}) };
      })),
    };
  }

  /** A ready segment's file path, or null. */
  async function file(key) {
    if (!KEY.test(key ?? "")) return null;
    return (await cache.locate(key))?.path ?? null;
  }

  /** A document changed: its project is the one to work on; the next pass works out new keys. */
  function changed(projectId) {
    focus = projectId;
    later(idleMs);
  }

  /** Playback or a stage request: background renders wait `idleMs` from now, and stop. */
  function touch() {
    lastBusy = now();
    job?.controller.abort();
    later(idleMs);
  }

  function waitLeft() {
    if (activity.running() > 0) return idleMs;
    return Math.max(0, lastBusy + idleMs - now());
  }

  // The heaviest segment of the watched project that has no file yet.
  async function nextSegment() {
    const record = focus ? await project(focus) : null;
    if (!record) return null;
    let best = null;
    for (const { id: sceneId } of record.document.scenes) {
      const { scene, fonts, size, segments } = await plan(focus, record.revision, record.document, sceneId);
      for (const segment of segments) {
        if (failed.has(segment.key) || (best && segment.weight <= best.segment.weight)) continue;
        if (!(await ready(segment.key))) best = { projectId: focus, sceneId, scene, fonts, size, segment };
      }
    }
    return best;
  }

  /** Removes the segments of projects that are no longer kept (deleted, or in the trash). */
  async function prune() {
    prunedAt = now();
    if (!deps.projectIds) return 0;
    const kept = new Set(await deps.projectIds());
    return cache.removeWhere((metadata) => typeof metadata.projectId === "string" && !kept.has(metadata.projectId));
  }

  /** The settings changed: turned off, the segment drawing now stops at once; on, work starts. */
  function refresh() {
    if (!enabled()) job?.controller.abort();
    else later(0);
  }

  async function pump() {
    if (closed || pumping || job || !enabled()) return;
    if (waitLeft() > 0) return later(waitLeft());
    pumping = true;
    let next;
    try {
      if (now() - prunedAt >= PRUNE_MS) await prune().catch((error) => warn(`[kino] Old preview segments could not be removed: ${error.message}`));
      next = await nextSegment();
    }
    catch { next = null; }
    finally { pumping = false; }
    if (!next || closed || job) return;
    if (waitLeft() > 0) return later(waitLeft());
    const controller = new AbortController();
    const current = job = { key: next.segment.key, controller };
    try {
      await inBackground(() => render(next.scene, next.segment, { cache, size: next.size, fps: PREVIEW_FPS, fonts: next.fonts, mediaRoot,
        render: { ...machine(), framesAtOnce: 1 }, signal: controller.signal, projectId: next.projectId }));
      publish({ type: "preview", projectId: next.projectId, sceneId: next.sceneId, index: next.segment.index, key: next.segment.key });
    } catch (error) {
      // Stopped for a render, playback or the setting: drawn again later. Anything else: said
      // once, and not tried again.
      if (!controller.signal.aborted) {
        failed.add(next.segment.key);
        warn(`[kino] Preview segment ${next.segment.index + 1} (${next.segment.start}-${next.segment.end} s) could not be drawn: ${error?.message ?? error}`);
      }
    } finally {
      if (job === current) job = null;
    }
    later(waitLeft());
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    stopListening();
    job?.controller.abort();
  }

  return { list, file, changed, touch, refresh, prune, close, pump, running: () => job?.key ?? null };
}
