import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { remoteSelectionQuads } from "../presenceGeometry.js";
import { PresenceAvatars } from "./PresenceAvatars.jsx";
import "./ScenePresence.css";

export function PresenceStack({ presence, scenes, onFollow }) {
  const { people, selfId } = useSyncExternalStore(presence.subscribe, presence.getRoster);
  return <PresenceAvatars people={people} selfId={selfId} scenes={scenes} onFollow={onFollow} />;
}

export function PresenceSceneRings({ presence, sceneId, zoom = 1 }) {
  const { people, selfId } = useSyncExternalStore(presence.subscribe, presence.getRoster);
  return <span className="presence-scene-rings" aria-hidden="true">
    {people.filter((person) => person.id !== selfId && person.sceneId === sceneId).map((person, index) =>
      <span key={person.id} data-presence-scene={person.id} style={{ "--presence-color": person.color,
        outlineWidth: 2 / zoom, outlineOffset: (2 + index * 3) / zoom }} />)}
  </span>;
}

export const ScenePresence = memo(function ScenePresence({ presence, document, scene, mode = "design", time = 0, zoom = 1, resolvedLayers = null }) {
  const readScene = useCallback(() => presence.getSceneSnapshot(scene.id), [presence, scene.id]);
  const { people, cursors, selections } = useSyncExternalStore(presence.subscribe, readScene);
  const outlines = useMemo(() => Object.values(selections).filter((entry) => entry.sceneId === scene.id)
    .flatMap((entry) => remoteSelectionQuads(document, scene.id, entry, { mode, time, resolvedLayers })
      .map((quad) => ({ ...quad, personId: entry.id }))), [document, scene.id, selections, mode, time, resolvedLayers]);
  const byId = new Map(people.map((person) => [person.id, person]));
  const tags = new Set();
  return <div className="scene-presence" aria-hidden="true">
    <svg className="presence-outlines" viewBox={`0 0 ${scene.width} ${scene.height}`} preserveAspectRatio="none">
      {outlines.map((outline) => <polygon key={`${outline.personId}:${outline.id}`} data-presence-layer={outline.id}
        style={{ "--presence-color": byId.get(outline.personId)?.color }}
        points={outline.points.map((point) => `${point.x},${point.y}`).join(" ")} />)}
    </svg>
    {outlines.map((outline) => {
      if (tags.has(outline.personId)) return null;
      tags.add(outline.personId);
      const person = byId.get(outline.personId), point = outline.points[0];
      return person && <span key={person.id} className="presence-selection-name" style={{ "--presence-color": person.color,
        left: `${point.x / scene.width * 100}%`, top: `${point.y / scene.height * 100}%`, transform: `translateY(-100%) scale(${1 / zoom})` }}>{person.name}</span>;
    })}
    {Object.values(cursors).filter((cursor) => cursor.sceneId === scene.id).map((cursor) => {
      const person = byId.get(cursor.id);
      return person && <div key={cursor.id} className={`presence-cursor${cursor.idle ? " is-idle" : ""}`} style={{ "--presence-color": person.color,
        left: `${cursor.x / scene.width * 100}%`, top: `${cursor.y / scene.height * 100}%`, transform: `scale(${1 / zoom})` }}>
        <svg width="17" height="20" viewBox="0 0 17 20"><path d="M1 1L15 12L9 13L6 19Z" /></svg><span>{person.name}</span>
      </div>;
    })}
  </div>;
});
