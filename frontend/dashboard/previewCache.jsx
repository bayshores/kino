// The preview cache on the stage: the list of a scene's preview segments (GET /api/dashboard/preview)
// and the two <video> elements that play them over the live picture (previewPick.js picks which).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../client.js";

// While playing, the list is asked again this often with playing=1, so background renders wait.
const POLL_MS = 1500;
// A segment video further than this from the clock is seeked; a smaller drift is played away.
const SEEK_DRIFT = 0.2, NUDGE_DRIFT = 0.07;
const VIDEO_STYLE = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill", visibility: "hidden", pointerEvents: "none" };

/**
 * The scene's preview segment list at revision `rev`, with the projectId and sceneId it is for.
 * Asked again on a new revision or scene, when `bump` changes (a "preview" stream event) and every
 * POLL_MS while playing. Null when kino keeps no preview cache or `off`.
 */
export function usePreviewList({ projectId, sceneId, rev, playing, bump, off }) {
  const [list, setList] = useState(null);
  const gone = useRef(false);
  useEffect(() => {
    if (off || !projectId || !sceneId || !rev || gone.current) return undefined;
    let active = true;
    const ask = async (isPlaying) => {
      const query = new URLSearchParams({ project: projectId, scene: sceneId, rev: String(rev) });
      if (isPlaying) query.set("playing", "1");
      try {
        const answer = await api(`/dashboard/preview?${query}`);
        if (active) setList({ ...answer, projectId, sceneId });
      } catch (error) {
        if (error?.status === 404) gone.current = true;
      }
    };
    ask(playing);
    const timer = playing ? setInterval(() => ask(true), POLL_MS) : null;
    return () => { active = false; clearInterval(timer); };
  }, [projectId, sceneId, rev, playing, bump, off]);
  return off ? null : list;
}

/**
 * Plays `pick.show` from scene time `time` over the stage and keeps `pick.preload` loaded at its
 * start in the other element, so the handoff at a segment's end has no gap. Calls `onCover(true)`
 * once a segment picture is on screen and `onCover(false)` when the stage is live again.
 */
export function PreviewVideos({ pick, time, playing, onCover }) {
  const refs = [useRef(null), useRef(null)];
  const covering = useRef(false);
  useLayoutEffect(() => {
    const videos = refs.map((ref) => ref.current).filter(Boolean);
    const keyOf = (video) => video.dataset.key || null;
    const load = (video, segment, at) => {
      if (keyOf(video) !== segment.key) { video.dataset.key = segment.key; video.src = segment.url; }
      if (Math.abs(video.currentTime - at) > 0.001 && video.paused) video.currentTime = at;
    };
    const show = playing ? pick.show : null;
    let shown = null;
    if (show) {
      shown = videos.find((video) => keyOf(video) === show.key)
        ?? videos.find((video) => keyOf(video) !== pick.preload?.key) ?? videos[0];
      const at = Math.max(0, time - show.start);
      if (keyOf(shown) !== show.key || shown.paused) load(shown, show, at);
      // Kept on the stage's clock (the sound's) once it plays: a large drift is seeked, a small one played away.
      if (shown.readyState >= 2 && !shown.seeking && !shown.paused) {
        const drift = shown.currentTime - at;
        if (Math.abs(drift) > SEEK_DRIFT) shown.currentTime = at;
        const rate = Math.abs(drift) > NUDGE_DRIFT ? (drift > 0 ? 0.9 : 1.1) : 1;
        if (shown.playbackRate !== rate) shown.playbackRate = rate;
      }
      if (shown.paused) shown.play().catch(() => {});
    }
    const others = videos.filter((video) => video !== shown);
    for (const video of others) {
      video.style.visibility = "hidden";
      if (!video.paused) video.pause();
    }
    // Playing, the next segment waits at its first frame in the other element. Paused, the one
    // under the playhead waits at the playhead, so Play starts on it.
    const next = playing ? pick.preload : pick.show;
    const nextAt = playing || !next ? 0 : Math.max(0, time - next.start);
    if (next && next.key !== show?.key) load(others.find((video) => keyOf(video) === next.key) ?? others[0], next, nextAt);
    // On screen only with a picture for this moment; until then the live stage shows.
    const ready = Boolean(shown && shown.readyState >= 2 && !shown.seeking);
    if (shown) shown.style.visibility = ready ? "visible" : "hidden";
    if (ready !== covering.current) { covering.current = ready; onCover(ready); }
  });
  useEffect(() => () => {
    for (const ref of refs) ref.current?.pause();
    if (covering.current) onCover(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{refs.map((ref, index) => <video key={index} ref={ref} data-preview-segment="true" muted playsInline preload="auto"
    disablePictureInPicture tabIndex={-1} aria-hidden="true" style={VIDEO_STYLE} />)}</>;
}
