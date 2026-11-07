import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ScenePreview, gifSourceList } from "./components/ScenePreview.jsx";
import { PresenceSceneRings, PresenceStack, ScenePresence } from "./components/ScenePresence.jsx";
import { ConnectionStatus } from "./components/ConnectionStatus.jsx";
import { gifFrames } from "./gifFrames.js";
import { overrideReferenceLayers } from "../engine/componentOverrides.js";
import { selectionFromLink } from "./sceneLinks.js";
import { useViewerDocument } from "./useViewerDocument.js";
import { viewerKeyAction, viewerLayout, viewerSceneIndex } from "./viewerNavigation.js";
import { threadCounts } from "./comments.js";
import { CommentMarks, ViewerCommentsColumn, useViewerComments } from "./ViewerComments.jsx";
import { listenForEditCommands } from "./desktopEdit.js";
import "./Viewer.css";

// What the link lets this person do, as the header says it.
const ROLE_LABELS = { view: "view only", comment: "can comment", edit: "can comment" };

function useCardLayout() {
  const [cards, setCards] = useState(() => viewerLayout(innerWidth, matchMedia("(pointer: coarse)").matches) === "cards");
  useEffect(() => {
    const coarse = matchMedia("(pointer: coarse)");
    const update = () => setCards(viewerLayout(innerWidth, coarse.matches) === "cards");
    window.addEventListener("resize", update);
    coarse.addEventListener("change", update);
    return () => { window.removeEventListener("resize", update); coarse.removeEventListener("change", update); };
  }, []);
  return cards;
}

function sharePointer(event, presence, scene) {
  const box = event.currentTarget.getBoundingClientRect();
  if (box.width && box.height) presence.cursor((event.clientX - box.left) / box.width * scene.width, (event.clientY - box.top) / box.height * scene.height, scene.id);
}

const SceneCard = memo(function SceneCard({ document, scene, fontVersion, active, playing, time, onToggle, onVisibility, presence }) {
  const root = useRef(null);
  const [visible, setVisible] = useState(false);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      const inView = entry.isIntersecting && entry.intersectionRatio > 0;
      setVisible(inView);
      onVisibility(scene.id, inView);
    });
    const prepare = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setNearby(true); prepare.disconnect(); }
    }, { rootMargin: "600px 0px" });
    observer.observe(root.current);
    prepare.observe(root.current);
    return () => { observer.disconnect(); prepare.disconnect(); onVisibility(scene.id, false); };
  }, [scene.id, onVisibility]);
  return <article ref={root} className="viewer-card" data-scene-card={scene.id} aria-label={scene.name}>
    <div className="viewer-card-heading"><h2>{scene.name}<PresenceSceneRings presence={presence} sceneId={scene.id} /></h2>
      <button type="button" onClick={() => onToggle(scene.id)} aria-label={`${active && playing ? "Pause" : "Play"} ${scene.name}`}>
        {active && playing ? "Pause" : "Play"}
      </button>
    </div>
    <button type="button" className="viewer-card-preview" onClick={() => onToggle(scene.id)} aria-label={`${active && playing ? "Pause" : "Play"} scene: ${scene.name}`}>
      <div className="viewer-frame" style={{ aspectRatio: `${scene.width} / ${scene.height}` }} onPointerMove={(event) => sharePointer(event, presence, scene)}>
        {nearby && <ScenePreview document={document} scene={scene} time={active && visible ? time : 0} design={false}
          playing={active && visible && playing} fontVersion={fontVersion} mediaActive={visible} />}
        {visible && <ScenePresence presence={presence} document={document} scene={scene} mode="animate" time={active ? time : 0} />}
      </div>
    </button>
  </article>;
});

export function Viewer({ access }) {
  const viewer = useViewerDocument(access.projectId);
  const { document, fontVersion, error, unavailable, connectionStatus, presence } = viewer;
  const cards = useCardLayout();
  const canComment = Boolean(access.canComment);
  // The comments column starts open for comment and edit links on a wide screen.
  const [commentsOpen, setCommentsOpen] = useState(() => canComment && viewerLayout(innerWidth, matchMedia("(pointer: coarse)").matches) !== "cards");
  const commentsButton = useRef(null);
  const [sceneId, setSceneId] = useState(null), [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [loop, setLoop] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const initialized = useRef(null), cardList = useRef(null), visibleCards = useRef(new Set()), latest = useRef(null);
  const scenes = document?.scenes ?? [];
  const scene = scenes.find((item) => item.id === sceneId) ?? scenes[0];
  const index = scene ? scenes.indexOf(scene) : -1;
  useEffect(() => { presence.select(access.projectId, scene && !unavailable ? { sceneId: scene.id, layerIds: [] } : null); }, [presence, access.projectId, scene?.id, unavailable]);
  useEffect(() => {
    if (document) gifFrames.keepOnly(new Set(gifSourceList([...document.scenes.flatMap((item) => item.layers), ...overrideReferenceLayers(document)]).sources));
  }, [document]);
  useEffect(() => () => gifFrames.keepOnly(new Set()), []);
  latest.current = { sceneId: scene?.id, scene, cards, playing, time };
  const onVisibility = useCallback((id, visible) => {
    if (visible) visibleCards.current.add(id); else visibleCards.current.delete(id);
    if (!visible && latest.current.cards && latest.current.sceneId === id) { setPlaying(false); setTime(0); }
  }, []);
  useEffect(() => {
    if (!document) return;
    if (initialized.current !== document.id) {
      initialized.current = document.id;
      const linked = selectionFromLink(document, location.href);
      setSceneId(linked?.sceneId ?? document.scenes[0]?.id ?? null);
      setPlaying(false); setTime(0);
    } else if (!document.scenes.some((item) => item.id === sceneId)) {
      setSceneId(document.scenes[0]?.id ?? null); setPlaying(false); setTime(0);
    }
  }, [document, sceneId]);
  useEffect(() => { setPlaying(false); setTime(0); }, [cards]);
  useEffect(() => {
    if (scene) setTime((current) => Math.min(current, scene.duration));
  }, [scene?.duration]);
  useEffect(() => {
    if (!cards || !sceneId) return;
    const frame = requestAnimationFrame(() => [...(cardList.current?.children ?? [])]
      .find((card) => card.dataset.sceneCard === sceneId)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [cards, sceneId]);
  useEffect(() => {
    if (scene) setAnnouncement(`Scene ${index + 1} of ${scenes.length}: ${scene.name}`);
  }, [scene?.id, scene?.name, index, scenes.length]);
  useEffect(() => {
    if (unavailable || !document) setPlaying(false);
  }, [unavailable, document]);
  useEffect(() => {
    if (!playing || !scene) return;
    let frame, previous = performance.now(), elapsed = time;
    const duration = scene.duration;
    function tick(now) {
      elapsed += Math.max(0, now - previous) / 1000;
      previous = now;
      if (elapsed >= duration) {
        if (loop) elapsed %= duration;
        else { setTime(duration); setPlaying(false); return; }
      }
      setTime(elapsed);
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, scene?.id, scene?.duration, loop]);
  const navigate = useCallback((action) => {
    const next = scenes[viewerSceneIndex(scenes, scene?.id, action)];
    if (!next || next.id === scene?.id) return;
    setPlaying(false); setTime(0); setSceneId(next.id);
    if (cards) [...(cardList.current?.children ?? [])].find((card) => card.dataset.sceneCard === next.id)?.scrollIntoView({ block: "nearest" });
  }, [scenes, scene?.id, cards]);
  const follow = useCallback((id) => {
    if (!scenes.some((item) => item.id === id)) return;
    setPlaying(false); setTime(0); setSceneId(id);
    if (cards) [...(cardList.current?.children ?? [])].find((card) => card.dataset.sceneCard === id)?.scrollIntoView({ block: "nearest" });
  }, [scenes, cards]);
  // Opening a thread goes to its scene; its time is set right after.
  const selectScene = useCallback((id) => {
    if (!scenes.some((item) => item.id === id)) return;
    setPlaying(false); setSceneId(id);
    if (cards) requestAnimationFrame(() => [...(cardList.current?.children ?? [])].find((card) => card.dataset.sceneCard === id)?.scrollIntoView({ block: "nearest" }));
  }, [scenes, cards]);
  const comments = useViewerComments({ access, viewer, doc: document, scene, time, open: commentsOpen && canComment, setOpen: setCommentsOpen, cards,
    selectScene, setTime, setPlaying, setNotice: setAnnouncement });
  // Closing the comments column with focus in it gives focus to its button in the header.
  useEffect(() => {
    if (commentsOpen) return undefined;
    const frame = requestAnimationFrame(() => {
      const active = window.document.activeElement;
      if (!active || active === window.document.body) commentsButton.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [commentsOpen]);
  const toggle = useCallback((id = latest.current.sceneId) => {
    const current = latest.current;
    if (!id || (current.cards && !visibleCards.current.has(id))) return;
    if (id !== current.sceneId) { setSceneId(id); setTime(0); setPlaying(true); }
    else { if (current.time >= current.scene.duration) setTime(0); setPlaying((value) => !value); }
  }, []);
  // The Mac app's Undo and Redo: they work in the comment boxes; the viewer itself changes nothing.
  useEffect(() => listenForEditCommands((action) => setAnnouncement(`Nothing to ${action} here: the viewer does not change the file.`)), []);
  useEffect(() => {
    function keydown(event) {
      const action = viewerKeyAction(event);
      if (!action || !scene) return;
      event.preventDefault();
      if (action === "toggle") toggle(); else navigate(action);
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [navigate, toggle, scene?.id]);
  if (unavailable || !document) return <main className="startup" aria-live="polite"><strong>kino</strong>
    <p>{unavailable ? "This link no longer works." : error || "Loading file…"}</p>
    {error && !unavailable && <button onClick={() => location.reload()}>Try again</button>}
  </main>;
  const showComments = canComment && commentsOpen;
  const counts = threadCounts(comments.threads);
  return <main className={`viewer ${cards ? "viewer-cards" : "viewer-desktop"}${showComments ? " with-comments" : ""}`} aria-label="File viewer">
    <header className="viewer-header"><div className="viewer-file"><div className="viewer-file-title"><strong title={document.name}>{document.name}</strong>
        <ConnectionStatus status={connectionStatus} failure={connectionStatus.state === "error" ? error : ""} />
      </div><span className="viewer-role" title={access.role === "edit" ? "Edit links open this viewer with comments. Agents make the edits." : undefined}>{ROLE_LABELS[access.role] ?? "view only"}</span></div>
      <div className="viewer-scene-name"><span><span className="viewer-current-scene-label">{scene?.name ?? "No scenes"}</span>{scene && <PresenceSceneRings presence={presence} sceneId={scene.id} />}</span><span>{index + 1} / {scenes.length}</span></div>
      <PresenceStack presence={presence} scenes={scenes} onFollow={follow} />
      <nav className="viewer-navigation" aria-label="Browse scenes">
        <button onClick={() => navigate("previous")} disabled={index <= 0} aria-label="Previous scene">←</button>
        <button onClick={() => navigate("next")} disabled={index >= scenes.length - 1} aria-label="Next scene">→</button>
      </nav>
      {canComment && <button ref={commentsButton} type="button" className="viewer-comments-toggle" aria-expanded={showComments} aria-controls="viewer-comments"
        onClick={comments.toggleMode}>comments {counts.open}{comments.unreadCount > 0 ? <span className="viewer-unread"> · {comments.unreadCount} unread</span> : null}</button>}
    </header>
    <div className="viewer-controls" role="group" aria-label="Playback">
      <button onClick={() => toggle()} disabled={!scene} aria-label={playing ? "Pause" : "Play"}>{playing ? "Pause" : "Play"}</button>
      <button onClick={() => { setPlaying(false); setTime(0); }} disabled={!scene}>Restart</button>
      <label className="viewer-loop"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />Loop</label>
      <input className="viewer-scrubber" type="range" min="0" max={scene?.duration ?? 1} step="0.01" value={Math.min(time, scene?.duration ?? 1)}
        aria-label="Playback time" aria-valuetext={`${time.toFixed(2)} of ${(scene?.duration ?? 0).toFixed(2)} seconds`}
        onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} disabled={!scene} />
      <output aria-hidden="true">{time.toFixed(2)} / {(scene?.duration ?? 0).toFixed(2)}s</output>
    </div>
    {error && !["offline", "reconnecting"].includes(connectionStatus.state) && <p className="viewer-status">{error}</p>}
    <div className="viewer-body">
    {cards ? <div className="viewer-card-list" ref={cardList}>{scenes.map((item) => <SceneCard key={item.id} document={document} scene={item}
      fontVersion={fontVersion} active={item.id === scene?.id} playing={item.id === scene?.id && playing} time={item.id === scene?.id ? time : 0} onToggle={toggle} onVisibility={onVisibility} presence={presence} />)}</div>
      : scene && <div className="viewer-stage"><div className="viewer-frame" style={{ "--scene-ratio": scene.width / scene.height, aspectRatio: `${scene.width} / ${scene.height}` }} onPointerMove={(event) => sharePointer(event, presence, scene)}
        role="group" aria-label={`Frame: ${scene.name}`} tabIndex={-1}>
        <ScenePreview document={document} scene={scene} time={time} design={false} playing={playing} fontVersion={fontVersion} />
        <ScenePresence presence={presence} document={document} scene={scene} mode="animate" time={time} />
        {canComment && <CommentMarks state={comments} scene={scene} placing={showComments} />}
      </div></div>}
    {showComments && <ViewerCommentsColumn state={comments} doc={document} access={access} cards={cards} />}
    </div>
    <p className="viewer-announcement" aria-live="polite" aria-atomic="true">{announcement}</p>
  </main>;
}
