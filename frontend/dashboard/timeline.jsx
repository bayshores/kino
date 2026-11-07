// The timeline pane's extras (TimelinePane in panes.jsx draws the pane itself):
// - useTimelineChanges: which layers changed since you last looked, and who changed each last,
//   from the turn reviews the server already gives (GET /dashboard/turn, one per turn);
// - NewButton and NewMarks: "▾ 3 new since you looked" and the ▾ marks on the ruler;
// - StoryRow: the video's parts above the lanes;
// - HoverCard: a small box about the lane under the pointer (or the focused layer).
// The facts themselves are plain functions in timeline.js.
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { turnReview } from "./api.js";
import { lastChanges, newLayerIds, partAt, readSeenRev, reviewLayerIds, saveSeenRev, turnAuthor, turnsToReview } from "./timeline.js";

// The `l` key (Dashboard.jsx) marks the timeline's changes seen through this.
const seenListeners = new Set();
export function markTimelineSeen() {
  for (const listener of seenListeners) listener();
}

// Turn reviews already fetched, by "project/turn/last rev": a turn that gets more edits is asked again.
const reviews = new Map();
const reviewKey = (projectId, turn) => `${projectId}/${turn.id}/${turn.edits.at(-1)?.after ?? ""}`;

// How long the ▾ marks take to fade after you mark them seen (ms); the CSS fade is as long.
const FADE_MS = 200;

/**
 * What changed in the shown scene: { newIds (Set), last ({layerId: {who, at, turn}}), leaving
 * (the layer ids whose marks are fading out), markSeen(), entries ([{turn, at, who, layerIds}]) }.
 */
export function useTimelineChanges({ data, scene, still }) {
  const projectId = data.projectId;
  const revision = data.record?.revision ?? 0;
  const [seenRev, setSeenRev] = useState(null);
  const [leaving, setLeaving] = useState(null);
  const [, setFetched] = useState(0);
  // The revision you last looked at. On your first visit to a project nothing is new: the
  // revision now is saved as seen.
  useEffect(() => {
    if (!projectId || !revision) return;
    const saved = readSeenRev(projectId);
    if (saved == null) saveSeenRev(projectId, revision);
    setSeenRev(saved ?? revision);
    setLeaving(null);
  }, [projectId, Boolean(revision)]); // eslint-disable-line react-hooks/exhaustive-deps

  const turns = data.agent?.turns ?? [];
  const wanted = turnsToReview(turns, seenRev);
  const wantedKey = wanted.map((turn) => reviewKey(projectId, turn)).join(",");
  useEffect(() => {
    if (!projectId) return undefined;
    let active = true;
    const missing = wanted.filter((turn) => !reviews.has(reviewKey(projectId, turn)));
    if (!missing.length) return undefined;
    Promise.all(missing.map((turn) => turnReview(projectId, turn.id)
      // A turn that cannot be read is not asked again until it gets more edits.
      .then((review) => reviews.set(reviewKey(projectId, turn), review), () => reviews.set(reviewKey(projectId, turn), null))))
      .then(() => { if (active) setFetched((count) => count + 1); });
    return () => { active = false; };
  }, [projectId, wantedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // One entry per turn that a review could name: which of this scene's layers it changed, when
  // and who made it.
  const entries = wanted.flatMap((turn) => {
    const review = reviews.get(reviewKey(projectId, turn));
    if (!review?.changes?.created) return [];
    return [{
      turn: turn.id, at: turn.edits.at(-1).at, after: turn.edits.at(-1).after,
      who: turnAuthor(turn.id, [...(review.calls ?? []), ...(data.calls ?? [])]),
      layerIds: reviewLayerIds(review.changes, scene, data.agent?.codes),
    }];
  });
  const newIds = newLayerIds(entries, seenRev);
  const last = lastChanges(entries, data.live?.building ?? [], data.agents ?? []);

  // Marking seen saves the revision now; the marks shown fade out first.
  const markSeen = () => {
    if (!projectId || !revision) return;
    saveSeenRev(projectId, revision);
    setSeenRev(revision);
    if (newIds.size && !still) {
      setLeaving(newIds);
      setTimeout(() => setLeaving(null), FADE_MS);
    }
  };
  const latest = useRef(markSeen);
  latest.current = markSeen;
  useEffect(() => {
    const listener = () => latest.current();
    seenListeners.add(listener);
    return () => { seenListeners.delete(listener); };
  }, []);
  // `entries` also feed the agents' lanes (lanes.js agentLanes): a mark per layer a turn changed.
  return { newIds, last, leaving, markSeen, entries };
}

/** "▾ 3 new since you looked" in the pane's title row; a click (or the l key) marks them seen. */
export function NewButton({ count, onSeen }) {
  if (!count) return null;
  return (
    <button type="button" className="tb tl-new" onClick={onSeen} aria-keyshortcuts="l" title="Mark as seen (l)">
      <span aria-hidden="true">▾</span> {count} new since you looked
    </button>
  );
}

/** The ▾ marks on the ruler, at `marks` [{at, count}]. They drop in; leaving ones fade out. */
export function NewMarks({ marks, leaving = false, percent, still }) {
  return marks.map((mark) => (
    <span key={`${leaving ? "l" : "n"}${mark.at}`} className={`tl-new-mark${leaving ? " leaving" : ""}${still ? " still" : ""}`}
      style={{ left: percent(mark.at) }} aria-hidden="true">▾</span>
  ));
}

const noTimeStore = { subscribe: () => () => {}, get: () => 0 };

/** The story row: each part of the video across its time, the one under the playhead bright. */
export function StoryRow({ parts, percent, timeStore, playing, time, duration }) {
  const store = timeStore ?? noTimeStore;
  const live = useSyncExternalStore(store.subscribe, store.get);
  const shown = playing && timeStore ? live : time;
  const current = partAt(parts, shown);
  return (
    <>
      <span className="tl-label story">story</span>
      <div className="track tl-story" role="list" aria-label="The video's parts">
        {parts.map((part, index) => (
          <span key={`${index}${part.start}`} role="listitem" className={`tl-part${index === current ? " current" : ""}`}
            style={{ left: percent(part.start), width: `calc(${percent(Math.min(duration, part.end))} - ${percent(part.start)})` }} title={part.name}>
            <span className="tl-part-name">{part.name}</span>
          </span>
        ))}
      </div>
    </>
  );
}

/** The hover card: `lines` (at most 3) in a small box at `place` {x, y} (window px), above it. */
export function HoverCard({ id, lines, place, still }) {
  const box = useRef(null);
  const [shift, setShift] = useState(0);
  // Kept inside the window: a card near the right edge moves left.
  useEffect(() => {
    const width = box.current?.offsetWidth ?? 0;
    setShift(Math.min(0, window.innerWidth - 8 - (place.x + 12 + width)));
  }, [place.x, lines.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} id={id} role="tooltip" className={`tl-card${still ? " still" : ""}`} style={{ left: place.x + 12 + shift, top: place.y }}>
      {lines.map((line, index) => <p key={index} className={line.startsWith("▾") ? "tl-card-new" : index ? "dim" : ""}>{line}</p>)}
    </div>
  );
}
