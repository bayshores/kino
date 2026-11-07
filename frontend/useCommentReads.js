// The read state behind the unread dot, the unread marks in the Comments panel and
// "Mark as unread". The rules are in commentUnread.js; this hook keeps the project's read record
// in React state and in the browser's settings.
//
// - The thread open in the Comments panel is marked read while the panel lists it on a visible
//   page (commentUnread.js threadOnScreen), including replies that arrive over the WebSocket while
//   it is open. A reply that arrives while the tab is in the background is read when the viewer
//   comes back to the tab with the thread still open.
// - "Mark as unread" keeps a thread unread until it is opened again.
// - Another tab of the same browser that changes the record is followed through the "storage"
//   event. (The Mac app keeps one editor window per file, so it needs no such event.)
import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadReads,
  markThreadRead,
  markThreadUnread,
  mentionsViewer,
  parseReads,
  pruneReads,
  readsSetting,
  saveReads,
  threadMentionsViewer,
  threadOnScreen,
  threadSeenTime,
  unreadThreadIds,
} from "./commentUnread.js";

// `identity` is this browser's comment identity (comments.js), `viewerName` its display name,
// `listed` the threads the panel lists now (comments.js filterThreads), `openId` the thread open in
// the panel and `showing` whether the panel is on screen.
export function useCommentReads({ projectId, threads, listed, identity, viewerName, openId, showing }) {
  const [state, setState] = useState(() => ({ projectId, reads: loadReads(projectId) }));
  // Another project opened: read its record.
  const current = state.projectId === projectId ? state : { projectId, reads: loadReads(projectId) };
  if (current !== state) setState(current);
  const reads = current.reads;
  const latest = useRef(null);
  latest.current = { projectId, reads, threads };

  function update(change) {
    const { projectId: id, reads: before, threads: list } = latest.current;
    const changed = change(before);
    if (changed === before) return;
    const next = pruneReads(changed, list);
    latest.current = { ...latest.current, reads: next };
    setState({ projectId: id, reads: next });
    saveReads(id, next);
  }

  useEffect(() => {
    if (!projectId) return undefined;
    const key = `kino-${readsSetting(projectId)}`;
    function follow(event) {
      if (event.key === key) setState({ projectId, reads: parseReads(event.newValue) });
    }
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, [projectId]);

  // False while the tab is in the background or the window is minimized.
  const [pageVisible, setPageVisible] = useState(() => window.document.visibilityState !== "hidden");
  useEffect(() => {
    const follow = () => setPageVisible(window.document.visibilityState !== "hidden");
    window.document.addEventListener("visibilitychange", follow);
    return () => window.document.removeEventListener("visibilitychange", follow);
  }, []);

  const viewer = useMemo(() => ({ identity, name: viewerName }), [identity, viewerName]);
  const unreadIds = useMemo(() => unreadThreadIds(threads, reads, viewer), [threads, reads, viewer]);

  // The open thread is read while the viewer can see it; a new post or edit in it is read at once.
  const openThread = threadOnScreen(listed, openId, { showing, pageVisible });
  const openSeen = openThread ? threadSeenTime(openThread) : null;
  useEffect(() => {
    if (openThread) update((before) => markThreadRead(before, openThread));
  }, [projectId, openThread?.comment.id, openSeen, reads]);

  return {
    unreadIds,
    unreadCount: unreadIds.size,
    isUnread: (id) => unreadIds.has(id),
    markUnread: (id) => update((before) => markThreadUnread(before, id)),
    mentionsMe: (comment) => mentionsViewer(comment, viewer),
    threadMentionsMe: (thread) => threadMentionsViewer(thread, viewer),
  };
}
