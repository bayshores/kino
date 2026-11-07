// The agents' live markers (milestone LIVE, parts 1 and 3), drawn from data.live; presence.js has
// the rules. On the stage: a tag "Nova · look at 1.0–2.0 s" in the agent's color with an outline
// around what its latest call reads or writes, a short flash on what a write changed, and a quiet
// striped outline on each layer changed this turn that no look has covered since ("building"), and
// a cursor in the agent's color that glides to what each call is about, and
// each agent's bot (28 px): it rides beside its cursor while a call shows, and otherwise rests with
// the other agents' bots in the pane's empty margin, idle and then asleep (presence.js stageCrew).
// On the timeline: a line at the call's time or a tint over its range, with the agent's name. One
// polite screen-reader line says what the agents do, at most once every 4 s.
//
// Light to draw: only transform and opacity animate, and one timer per component wakes it for the
// next change (a fade, the end of a flash, a bot's next mood); no animation-frame loop here. The
// only layout reads are the frame's place in its pane, when either one changes size. While the
// stage plays the bots are quiet (bot.jsx useQuietBots). Under reduced
// motion (`still`) nothing moves: tags jump, and a write gets a steady outline for 1.5 s instead
// of the flash. panes.jsx mounts StagePresence in the stage's overlay and TimelinePresence over
// the lanes, and Dashboard.jsx mounts PresenceAnnouncer once. Nothing here can be clicked: the
// person watches; the agent edits.
import React, { useEffect, useRef, useState } from "react";
import "./presence.css";
import { Bot, useQuietBots } from "./bot.jsx";
import { botMood, moodTimes } from "./bot.js";
import {
  START_MS, STAGE_BOT_PX, agentColor, announceText, changeMarks, chipPlaces, createAnnouncer, cursorPlaces, isShown, leavingPresence,
  newestPresence, nextChangeAt, noteFirstSeen, restPlaces, ridePlace, serverNow, shownPresence, spotOf, stageBuilding, stageCrew,
  tagPlaces, timelineMarks, timelineSpan,
} from "./presence.js";

// The longest a timer may wait (setTimeout's limit is about 24.8 days).
const LONGEST_WAIT = 2_000_000_000;

/** When a stage bot next changes by itself: its mood (work, done, asleep), or it leaves after 10 min. */
function crewChangeAt(live, now) {
  const times = Object.values(live?.latest ?? {}).flatMap((presence) => {
    const at = typeof presence?.at === "number" ? presence.at : Date.parse(presence?.at);
    return Number.isFinite(at) ? [...moodTimes(at), at + START_MS] : [];
  }).filter((time) => time > now);
  return times.length ? Math.min(...times) : null;
}

/**
 * The server's time now, what this view has seen of each call, and a re-render at the next
 * change (with `crew`, also at each stage bot's next mood).
 */
function usePresenceClock(live, { crew = false } = {}) {
  const [, setTick] = useState(0);
  const [seen] = useState(() => new Map());
  const now = serverNow(live);
  noteFirstSeen(seen, Object.values(live?.latest ?? {}), now);
  const marks = nextChangeAt(live, now);
  const bots = crew ? crewChangeAt(live, now) : null;
  const next = marks == null ? bots : bots == null ? marks : Math.min(marks, bots);
  useEffect(() => {
    if (next == null) return undefined;
    const timer = setTimeout(() => setTick((count) => count + 1), Math.min(LONGEST_WAIT, Math.max(0, next - serverNow(live))) + 5);
    return () => clearTimeout(timer);
  }, [next, live]);
  return { now, seen };
}

/**
 * The empty room around the stage's frame inside its pane, { left, right, top, bottom } in px,
 * for the resting bots. Measured when the pane or the frame changes size (a ResizeObserver), never
 * per frame. `ref` goes on an element inside the frame's overlay.
 */
function useStageRoom() {
  const ref = useRef(null);
  const [room, setRoom] = useState(null);
  useEffect(() => {
    const frame = ref.current?.closest(".stage");
    const pane = ref.current?.closest(".stage-wrap");
    if (!frame || !pane || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const inner = frame.getBoundingClientRect();
      const outer = pane.getBoundingClientRect();
      const next = {
        left: Math.round(inner.left - outer.left), right: Math.round(outer.right - inner.right),
        top: Math.round(inner.top - outer.top), bottom: Math.round(outer.bottom - inner.bottom),
      };
      setRoom((old) => (old && old.left === next.left && old.right === next.right && old.top === next.top && old.bottom === next.bottom ? old : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  return [ref, room];
}

/** Keeps a tag or chip `x` px from the left but inside a box `width` px wide (100% is its own width). */
const inside = (x, y, width) => `translate(max(0px, min(${x}px, calc(${width}px - 100%))), ${y}px)`;
const grow = (box, by) => ({ left: box.left - by, top: box.top - by, width: box.width + by * 2, height: box.height + by * 2 });
const leavingClass = (gone, presence) => (gone.has(presence.agent.id) ? " presence-leaving" : "");

/**
 * On the stage, inside its overlay. `layerBox(layerIds)` is the layers' area in scene units (or
 * null) and `boxStyle(area)` its place in px, both from StagePane. While `playing`, the building
 * outlines wait (the timeline keeps showing them). With `marks` off (the stage's outlines button)
 * no outline is drawn: only the agents' arrows and name tags.
 */
export function StagePresence({ live, sceneId, scenes, layerBox, boxStyle, still, playing = false, marks = true, hold = false }) {
  const { now, seen } = usePresenceClock(live, { crew: true });
  const [lastPoints] = useState(() => new Map());
  const [roomRef, room] = useStageRoom();
  useQuietBots(playing);
  const scene = (scenes ?? []).find((entry) => entry.id === sceneId);
  if (!live || !scene) return <div ref={roomRef} hidden />;
  const stage = boxStyle({ x: 0, y: 0, width: scene.width, height: scene.height });
  const boxOf = (layerIds) => {
    const area = layerBox(layerIds);
    return area ? boxStyle(area) : null;
  };
  const sceneName = (id) => (scenes ?? []).find((entry) => entry.id === id)?.name ?? null;
  const shown = shownPresence(live, now);
  const leaving = still ? [] : leavingPresence(live, now);
  const gone = new Set(leaving.map((presence) => presence.agent.id));
  const tags = tagPlaces([...shown, ...leaving], { sceneId, width: stage.width, height: stage.height, boxOf, sceneName });
  const changes = marks ? changeMarks(shown, now, { still, seen }).filter((mark) => (mark.presence.changed.sceneId ?? sceneId) === sceneId) : [];
  const building = marks ? stageBuilding(live, sceneId, now, { playing }) : [];
  const cursors = cursorPlaces(tags, { width: stage.width, height: stage.height, last: lastPoints });
  // Each agent's bot: beside its cursor while its call shows and is about something here (a
  // layer, or another scene at the stage's edge), else in its resting slot.
  const crew = stageCrew(live, now);
  const rest = restPlaces(crew.length, { width: stage.width, height: stage.height, room });
  const riding = new Map();
  cursors.forEach((cursor, index) => {
    const { presence, box, edge } = tags[index];
    if ((box || edge) && !gone.has(presence.agent.id)) riding.set(presence.agent.id, { ...ridePlace(cursor, stage), box });
  });
  return (
    <div ref={roomRef} className={`presence-stage${still ? " presence-still" : ""}`}>
      {building.map((entry) => {
        const box = boxOf([entry.layerId]);
        return box ? <div key={`b:${entry.layerId}`} className="presence-building" style={{ ...grow(box, 3), "--who": agentColor(live, entry.agentId) }} /> : null;
      })}
      {tags.map(({ presence, box }) => (box && marks ? (
        // A new target is a new outline: it is placed at once and fades in, never slides.
        <div key={`o:${presence.agent.id}:${spotOf(presence).layerIds.join(",")}`} className={`presence-box${leavingClass(gone, presence)}`}
          style={{ ...box, "--who": presence.agent.color }} />
      ) : null))}
      {changes.flatMap(({ presence, steady, delay }) => presence.changed.layerIds?.map((layerId) => {
        const box = boxOf([layerId]);
        if (!box) return null;
        return steady
          ? <div key={`f:${presence.call}:${layerId}`} className="presence-steady" style={{ ...box, "--who": presence.agent.color }} />
          : <div key={`f:${presence.call}:${layerId}`} className="presence-flash" style={{ ...box, "--who": presence.agent.color, animationDelay: `-${delay}ms` }} />;
      }) ?? [])}
      {cursors.map(({ presence, x, y }) => (
        // One arrow per agent, kept from call to call, so it glides to what the agent works on.
        <svg key={`c:${presence.agent.id}`} className={`presence-cursor${leavingClass(gone, presence)}`} width="22" height="27" viewBox="0 0 16 20"
          data-agent={presence.agent.id} style={{ "--who": presence.agent.color, transform: `translate(${x}px, ${y}px)` }}>
          <path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" />
        </svg>
      ))}
      {tags.map(({ presence, text, x, y, edge }) => (
        <div key={`t:${presence.agent.id}`} className={`presence-tag${edge ? " is-edge" : ""}${leavingClass(gone, presence)}`} data-agent={presence.agent.id}
          style={{ "--who": presence.agent.color, transform: inside(x, y, stage.width) }}>{text}</div>
      ))}
      {crew.map((presence, index) => {
        // One element per agent, kept from render to render, so it glides between its resting
        // slot and its cursor (and jumps under reduced motion).
        const ride = riding.get(presence.agent.id);
        const spot = ride ?? rest.places[index];
        const where = ride ? " is-riding" : rest.over ? " is-over" : "";
        return (
          <div key={`r:${presence.agent.id}`} className={`stage-bot${where}`} data-agent={presence.agent.id}
            style={{ "--who": presence.agent.color, "--slot": `${rest.slot}px`, transform: `translate(${spot.x}px, ${spot.y}px)` }}>
            <Bot color={presence.agent.color} mood={botMood({ presence, hold, now })} size={STAGE_BOT_PX} still={still}
              gaze={ride ? gazeAt(ride.box, ride.x, ride.y) : null} />
            <span className="stage-bot-name">{presence.agent.name || "agent"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Where a riding bot (its top left corner at `x`, `y`) looks: toward the middle of `box`, or null. */
function gazeAt(box, x, y) {
  if (!box) return null;
  const middle = STAGE_BOT_PX / 2;
  return { x: (box.left + box.width / 2 - (x + middle)) / 120, y: (box.top + box.height / 2 - (y + middle)) / 120 };
}

/** Over the timeline's lanes (in `.tl-lines`, which is `trackWidth` px wide). */
export function TimelinePresence({ live, sceneId, duration, trackWidth, still, hold = false }) {
  const { now, seen } = usePresenceClock(live);
  if (!live || !(trackWidth > 0)) return null;
  const shown = shownPresence(live, now);
  const leaving = still ? [] : leavingPresence(live, now);
  const gone = new Set(leaving.map((presence) => presence.agent.id));
  const marks = timelineMarks([...shown, ...leaving], { sceneId, duration, trackWidth });
  const changes = changeMarks(shown, now, { still, seen })
    .filter(({ presence }) => (presence.changed.sceneId ?? sceneId) === sceneId && Array.isArray(presence.changed.range));
  return (
    <div className={`presence-timeline${still ? " presence-still" : ""}`}>
      {marks.map(({ presence, range, x, width }) => (
        // One element per agent, a line or a tint, so it glides from one to the other.
        <span key={`s:${presence.agent.id}`} className={`presence-span${range ? " is-range" : ""}${leavingClass(gone, presence)}`}
          style={{ "--who": presence.agent.color, transform: `translateX(${x}px) scaleX(${width})` }} />
      ))}
      {changes.map(({ presence, steady, delay }) => {
        const span = timelineSpan(presence.changed.range, duration, trackWidth);
        return <span key={`f:${presence.call}`} className={steady ? "presence-tl-steady" : "presence-tl-flash"}
          style={{ "--who": presence.agent.color, transform: `translateX(${span.x}px) scaleX(${span.width})`, ...(steady ? {} : { animationDelay: `-${delay}ms` }) }} />;
      })}
      {chipPlaces(marks).map(({ presence, text, x, y }) => (
        <span key={`c:${presence.agent.id}`} className={`presence-chip${leavingClass(gone, presence)}`} data-agent={presence.agent.id}
          style={{ "--who": presence.agent.color, transform: inside(x, y, trackWidth) }}>
          <span className="presence-bot"><Bot color={presence.agent.color} mood={botMood({ presence, hold, now })} size={12} still={still} /></span>{text}
        </span>
      ))}
    </div>
  );
}

/**
 * The screen reader's line ("Nova is looking at Title, 1.0–2.0 s"), outside every aria-hidden
 * part. What was already there when the dashboard opened is not said; the log keeps every call.
 */
export function PresenceAnnouncer({ live }) {
  const [line, setLine] = useState("");
  const [announcer] = useState(() => createAnnouncer({ onLine: setLine }));
  useEffect(() => () => announcer.stop(), [announcer]);
  const newest = newestPresence(live);
  const key = newest ? `${newest.agent.id}:${newest.call}:${newest.phase}` : "";
  const atOpen = useRef(key);
  useEffect(() => {
    if (!newest || key === atOpen.current || !isShown(newest, serverNow(live))) return;
    announcer.say(announceText(newest));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <p className="presence-sr" role="status" aria-live="polite">{line}</p>;
}
