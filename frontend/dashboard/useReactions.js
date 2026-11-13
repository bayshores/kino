// The dashboard's reaction track (reactionTrack.js) wired to the server: one batched
// notes {action:"reactions"} call when playing stops, a mark is made while paused, a mark is
// removed, or the window hides; at most one call each SEND_GAP_MS (a later one waits its turn).
// The person sees only their own marks (ticks on the scrub bar), never the viewing log.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as server from "./api.js";
import { createReactionTrack } from "./reactionTrack.js";

export const SEND_GAP_MS = 2000;

export function useReactions({ projectId, revision, savedMarks, onError }) {
  const revRef = useRef(revision ?? null);
  revRef.current = revision ?? null;
  const [track] = useState(() => createReactionTrack({ rev: () => revRef.current }));
  // Marks not sent yet, marks the server keeps, and kept marks removed here but not sent yet.
  const [local, setLocal] = useState([]);
  const [saved, setSaved] = useState(savedMarks ?? []);
  const [gone, setGone] = useState([]);
  useEffect(() => { setSaved(savedMarks ?? []); }, [savedMarks]);
  const removals = useRef([]);
  const clearing = useRef(false);
  const lastSent = useRef(0);
  const timer = useRef(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const send = useCallback(async (project, final = false) => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!project) return;
    const entries = track.take({ final });
    const remove = removals.current.splice(0);
    const clear = clearing.current;
    clearing.current = false;
    if (!entries.length && !remove.length && !clear) return;
    lastSent.current = Date.now();
    try {
      const reply = await server.act("notes", { action: "reactions", project, quiet: true, ...(clear ? { clear: true } : { entries, ...(remove.length ? { remove } : {}) }) });
      if (reply?.isError) throw new Error(reply.text);
      const sent = new Set(entries.map((entry) => entry.id).filter(Boolean));
      setLocal((list) => list.filter((entry) => !sent.has(entry.id)));
      setGone((list) => list.filter((id) => !remove.includes(id)));
      if (Array.isArray(reply?.data?.marks)) setSaved(reply.data.marks);
    } catch (cause) {
      errorRef.current?.(`Marks not saved: ${cause?.message ?? cause}`);
    }
  }, [track]);

  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  // Another project: what waits goes to the one it was made in.
  useEffect(() => () => { send(projectId, true); setLocal([]); setGone([]); }, [projectId, send]);

  const flush = useCallback((final = false) => {
    const wait = SEND_GAP_MS - (Date.now() - lastSent.current);
    if (final || wait <= 0) { send(projectRef.current, final); return; }
    if (!timer.current) timer.current = setTimeout(() => send(projectRef.current), wait);
  }, [send]);

  // The window hides (another app, minimized, closed): send what waits, with any open jump.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") flush(true); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => { document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", hide); clearTimeout(timer.current); };
  }, [flush]);

  const mark = useCallback((kind, sceneId, time, playing) => {
    const entry = track.mark(kind, sceneId, time, playing);
    setLocal((list) => [...list, entry]);
    if (!playing) flush();
    return entry;
  }, [track, flush]);

  // Clicking a tick removes its mark.
  const remove = useCallback((entry) => {
    if (track.unmark(entry.id)) { setLocal((list) => list.filter((item) => item.id !== entry.id)); return; }
    removals.current.push(entry.id);
    setGone((list) => [...list, entry.id, ...(entry.client ? [entry.client] : [])]);
    flush();
  }, [track, flush]);

  // The person clears every mark and the viewing log of this project.
  const clear = useCallback(() => {
    track.take({ final: true });
    removals.current = [];
    clearing.current = true;
    setLocal([]);
    setSaved([]);
    send(projectRef.current);
  }, [track, send]);

  const marks = useMemo(() => {
    const hidden = new Set(gone);
    const shown = saved.filter((entry) => !hidden.has(entry.id) && !hidden.has(entry.client));
    const sentIds = new Set(shown.map((entry) => entry.client).filter(Boolean));
    return [...shown, ...local.filter((entry) => !sentIds.has(entry.id))];
  }, [saved, local, gone]);

  return { track, marks, mark, remove, clear, flush };
}
