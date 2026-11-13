// Comment mode: the state behind the comment tool, the pins on the canvas and the Comments panel.
//
// Comment mode is the "comment" tool (App.jsx `tool`), so choosing another tool, adding a layer
// or pressing Esc leaves it, the same way those leave the pen tool. While it is on, a click on a
// scene opens a draft comment there (Stage.jsx) and the Comments panel takes the Inspector's place.
//
// Comments are not part of the document: they change only through the requests in comments.js,
// never through workspace.commit or undo. After each write the server sends every open session
// the new list ({type: "comments"} in useWorkspace.js); the saved comment each request returns
// is shown at once (mergeComment) so this session does not wait for that message.
//
// Threads: the panel's open thread takes replies (reply), and each comment's "···" menu edits its
// text (editText, its author only), deletes it (remove, its author or the owner), marks its thread
// unread (markUnread) or resolves it. What this browser has read is in useCommentReads.js, and the
// names the @ list suggests in mentionNames (mentions.js). The server checks every rule again.
//
// The open thread stays in the panel's list (`listed`) while it is open, even when someone else
// resolves, reopens or deletes it (a deleted one shows as last seen, marked deleted), so a reply or
// edit being typed in it and keyboard focus are kept. Choosing another filter, or resolving it
// yourself, closes it when the filter no longer lists it.
import { useEffect, useMemo, useRef, useState } from "react";
import { getSetting, setSetting } from "./browserStorage.js";
import {
  anchorTime,
  buildThreads,
  canDeleteComment,
  canEditCommentText,
  canMoveComment,
  commentScene,
  deleteComment,
  draftPlace,
  filterThreads,
  isMine,
  keepDeletedThread,
  matchesFilter,
  mergeComment,
  patchComment,
  postComment,
  projectIdentity,
} from "./comments.js";
import { pinPlacement, roundCoordinate, withPendingMoves } from "./commentPins.js";
import { mentionCandidates, mentionsInText, rememberMentionNames } from "./mentions.js";
import { useCommentReads } from "./useCommentReads.js";

// "hidden" or "shown": whether ⇧C last hid the pins, kept per browser (browserStorage.js).
export const PINS_SETTING = "comment-pins";
// The display name posted as a comment's author, shared with the presence list.
const NAME_SETTING = "name";
const HINT_MS = 3000;
// How long after the last keystroke in the display name field it is sent to the people in the file.
const NAME_ANNOUNCE_MS = 600;

export const VIEW_ONLY_HINT = "This link lets you read comments. A comment or edit link is needed to add them.";
export const OUTSIDE_HINT = "Click inside a scene to leave a comment there.";

// `framePins` is false where the layout draws no pins (the viewer's cards): nothing there says
// they are hidden, and the panel has no button to hide them.
export function useCommentMode({ workspace, doc, scene, time, tool, setTool, framePins = true, selectScene, setTime, setPlaying, setNotice }) {
  const active = tool === "comment";
  const canComment = Boolean(workspace.access.canComment);
  const [pinsHidden, setPinsHidden] = useState(() => getSetting(PINS_SETTING) === "hidden");
  const pinsHiddenRef = useRef(pinsHidden);
  const [filter, setFilter] = useState("open");
  // The thread open in the panel (its first comment's ID), or null.
  const [openId, setOpenId] = useState(null);
  // A comment being written: {sceneId, x, y, time}, or null.
  const [draft, setDraft] = useState(null);
  const [posting, setPosting] = useState(false);
  // Moves shown before the server saved them: comment ID -> {x, y, sceneId?, time?}.
  const [pending, setPending] = useState({});
  // The newest move of each comment, so an older request that finishes late leaves a newer move shown.
  const moveVersions = useRef(new Map());
  // The last move request of each comment; the next one waits for it, so they arrive in order.
  const moveQueues = useRef(new Map());
  const [hint, setHint] = useState("");
  const [author, setAuthorState] = useState(() => getSetting(NAME_SETTING) || "");
  // True when the panel should take keyboard focus as it opens (opened from the toolbar button).
  const focusPanel = useRef(false);
  // Where keyboard focus goes after a draft opened from a button closes.
  const draftReturn = useRef(null);
  // The comments this session is deleting: a thread it deletes closes instead of showing as deleted.
  const removing = useRef(new Set());
  // The open thread as the panel last showed it (see keepDeletedThread below).
  const lastOpen = useRef(null);

  useEffect(() => {
    if (active) return;
    setDraft(null);
    setHint("");
  }, [active]);
  useEffect(() => {
    setOpenId(null);
    setDraft(null);
    setPending({});
  }, [doc?.id]);
  useEffect(() => {
    // Someone deleted the scene the draft was on.
    if (draft && !doc?.scenes.some((item) => item.id === draft.sceneId)) setDraft(null);
  }, [doc?.scenes, draft]);
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(""), HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);

  const comments = useMemo(() => withPendingMoves(workspace.comments, pending), [workspace.comments, pending]);
  const threads = useMemo(() => buildThreads(comments), [comments]);
  // The open thread as last seen. It is kept during render, not in an effect, so the render where
  // the thread disappears already has it and the reply box in it stays mounted.
  const openLive = openId ? threads.find((thread) => thread.comment.id === openId) : null;
  if (openLive) lastOpen.current = openLive;
  else if (!openId) lastOpen.current = null;
  // The threads the panel lists: the filter's threads, plus the open thread even when it no longer
  // matches the filter or someone else deleted it (comments.js filterThreads, keepDeletedThread).
  const listed = useMemo(() => {
    const lastSeen = openId && !removing.current.has(openId) ? lastOpen.current : null;
    return filterThreads(keepDeletedThread(threads, openId, lastSeen), filter, { keep: openId });
  }, [threads, filter, openId]);
  // This browser's anonymous comment identity in this file (comments.js projectIdentity): which
  // comments are this viewer's. Its author ID is different in every file.
  const identity = useMemo(() => projectIdentity(doc?.id), [doc?.id]);
  // Unread threads and "Mark as unread", kept per browser (useCommentReads.js, commentUnread.js).
  const reads = useCommentReads({ projectId: doc?.id, threads, listed, identity, viewerName: author, openId, showing: active });
  // The names the @ list suggests: people in the file now, then past comment authors (mentions.js).
  const mentionNames = useMemo(
    () => mentionCandidates({ people: workspace.people, comments: workspace.comments }),
    [workspace.people, workspace.comments],
  );
  // Every name the @ list offered in this file since it opened (mentions.js rememberMentionNames):
  // a name picked for someone who closed the file before the comment was posted still counts.
  const offeredNames = useRef({ projectId: null, names: [] });
  useEffect(() => {
    const earlier = offeredNames.current.projectId === doc?.id ? offeredNames.current.names : [];
    offeredNames.current = { projectId: doc?.id, names: rememberMentionNames(earlier, mentionNames) };
  }, [doc?.id, mentionNames]);
  // The names a comment's @mentions are found among when it is saved. `extra` are names it had before.
  function namesForSaving(extra = []) {
    const earlier = offeredNames.current.projectId === doc?.id ? offeredNames.current.names : [];
    return [...mentionNames, ...extra, ...earlier];
  }
  // A display name typed in the panel reaches the people in the file (their @ lists) after a pause.
  useEffect(() => {
    const id = setTimeout(() => workspace.announceName?.(author.trim()), NAME_ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [author]);

  function toggleMode() {
    if (active) {
      setTool("select");
      return;
    }
    setTool("comment");
    focusPanel.current = true;
  }
  function leave() {
    setDraft(null);
    setTool("select");
  }
  function togglePins({ announce = false } = {}) {
    const hidden = !pinsHiddenRef.current;
    // Hiding the pin that has keyboard focus would drop focus to the page, and the next Tab would
    // start again at the top. Focus goes to the pin's frame instead (Viewer.jsx), where ⇧C shows
    // the pins again.
    const pin = hidden ? window.document.activeElement?.closest?.(".viewer-pin") : null;
    if (pin) pin.closest(".viewer-frame")?.focus({ preventScroll: true });
    pinsHiddenRef.current = hidden;
    setPinsHidden(hidden);
    setSetting(PINS_SETTING, hidden ? "hidden" : "shown");
    if (announce) setNotice(hidden ? "Comments hidden on the canvas. Press ⇧C to show them." : "Comments shown on the canvas.");
  }
  function setAuthor(value) {
    setAuthorState(value);
    setSetting(NAME_SETTING, value);
  }
  // A click on the frame in comment mode. `hit` is {sceneId, x, y} in scene pixels,
  // or null for empty canvas.
  function place(hit) {
    if (!canComment) {
      setHint(VIEW_ONLY_HINT);
      return;
    }
    if (!hit) {
      setHint(OUTSIDE_HINT);
      return;
    }
    const target = doc.scenes.find((item) => item.id === hit.sceneId);
    if (!target) return;
    setPlaying(false);
    draftReturn.current = null;
    // The time cursor belongs to the active scene; the other scenes are drawn at their start.
    setDraft({ sceneId: target.id, x: hit.x, y: hit.y, time: target.id === scene.id ? anchorTime(time, target) : 0, ...(hit.layerId ? { layerId: hit.layerId } : {}) });
  }
  // Changes the new comment's place: {layerId:null} unpins the layer, {timeEnd} makes a range,
  // {whole:true} makes it about the whole video.
  function adjustDraft(change) {
    setDraft((current) => (current ? { ...current, ...change } : current));
  }
  // The keyboard way to start a comment: at the center of the active scene, at the time cursor.
  function commentHere(returnFocus) {
    if (!canComment || !scene) return;
    setPlaying(false);
    draftReturn.current = returnFocus ?? null;
    setDraft({
      sceneId: scene.id,
      x: roundCoordinate(scene.width / 2),
      y: roundCoordinate(scene.height / 2),
      time: anchorTime(time, scene),
    });
  }
  function cancelDraft() {
    setDraft(null);
  }
  async function postDraft(text) {
    const target = draft;
    if (!target || posting || !text.trim()) return false;
    setPosting(true);
    try {
      // The server checks the place against its copy of the scene, so unsaved scene changes go first.
      if (workspace.access.canEdit) await workspace.flush();
      const saved = await postComment(doc.id, {
        text,
        author: author.trim(),
        mentions: mentionsInText(text, namesForSaving()),
        ...draftPlace(target),
      });
      workspace.setComments((list) => mergeComment(list, saved));
      setDraft((current) => (current === target ? null : current));
      setOpenId(saved.id);
      if (filter === "resolved") setFilter("open");
      if (framePins && pinsHiddenRef.current) setNotice("Comment posted. Comments are hidden on the canvas; press ⇧C to show them.");
      return true;
    } catch (error) {
      workspace.setError(`Couldn't post the comment. ${error.message}`);
      return false;
    } finally {
      setPosting(false);
    }
  }
  // Opens a thread in the panel, goes to its scene and moves the time cursor to its time.
  function openThread(comment) {
    setOpenId(comment.id);
    if (!active) setTool("comment");
    if (filter !== "all" && Boolean(comment.resolved) !== (filter === "resolved")) setFilter("all");
    const target = commentScene(comment, doc);
    if (!target) return;
    const place = pinPlacement(comment, target);
    if (target.id !== scene.id) selectScene(target.id);
    if (Number.isFinite(place.time)) setTime(place.time, target);
  }
  function clearPending(id, version) {
    if (moveVersions.current.get(id) !== version) return;
    setPending((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  // Shows the thread at `fields` without saving (keyboard nudges between saves).
  function previewMove(id, fields) {
    moveVersions.current.set(id, (moveVersions.current.get(id) ?? 0) + 1);
    setPending((current) => ({ ...current, [id]: { ...current[id], ...fields } }));
  }
  // Drops a preview without saving it.
  function cancelMove(id) {
    clearPending(id, moveVersions.current.get(id));
  }
  // Moves a thread: shown at once, then saved with one PATCH. If the server refuses, the pin
  // goes back to where the server has it and an error says why.
  function moveThread(comment, patch) {
    if (!patch || !canComment) {
      cancelMove(comment.id);
      return;
    }
    const id = comment.id;
    const version = (moveVersions.current.get(id) ?? 0) + 1;
    moveVersions.current.set(id, version);
    setPending((current) => ({ ...current, [id]: patch }));
    const projectId = doc.id;
    const request = (moveQueues.current.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (workspace.access.canEdit) await workspace.flush();
        return patchComment(projectId, id, patch);
      });
    moveQueues.current.set(id, request);
    request
      .then(
        (saved) => workspace.setComments((list) => mergeComment(list, saved)),
        (error) => workspace.setError(`Couldn't move the comment. ${error.message}`),
      )
      .finally(() => {
        clearPending(id, version);
        if (moveQueues.current.get(id) === request) moveQueues.current.delete(id);
      });
  }
  // Shows the threads of another filter. The open thread closes when that filter does not list it
  // (or it was deleted).
  function chooseFilter(next) {
    setFilter(next);
    if (openId && !(openLive && matchesFilter(openLive.comment, next))) setOpenId(null);
  }
  // Resolves or reopens a thread. Returns true when the server saved it. Resolving or reopening the
  // open thread closes it when the filter no longer lists it, so it leaves the list as others do.
  async function setResolved(comment, resolved) {
    const shownFilter = filter;
    try {
      const saved = await patchComment(doc.id, comment.id, { resolved });
      workspace.setComments((list) => mergeComment(list, saved));
      if (!matchesFilter(saved, shownFilter)) setOpenId((current) => (current === comment.id ? null : current));
      return true;
    } catch (error) {
      workspace.setError(`Couldn't ${resolved ? "resolve" : "reopen"} the comment. ${error.message}`);
      return false;
    }
  }
  function closeThread() {
    setOpenId(null);
  }
  // Posts a reply to a thread (`root` is its first comment). Returns true when the server saved it.
  async function reply(root, text) {
    if (!text.trim()) return false;
    try {
      const saved = await postComment(doc.id, {
        text,
        author: author.trim(),
        parentId: root.id,
        mentions: mentionsInText(text, namesForSaving()),
      });
      workspace.setComments((list) => mergeComment(list, saved));
      return true;
    } catch (error) {
      workspace.setError(`Couldn't post the reply. ${error.message}`);
      return false;
    }
  }
  // Saves new text for one of this viewer's comments, with the @ names now in it. Names it
  // mentioned before still count when they are in the new text, even if that person left.
  async function editText(comment, text) {
    if (!text.trim()) return false;
    try {
      const mentions = mentionsInText(text, namesForSaving(comment.mentions ?? []));
      const saved = await patchComment(doc.id, comment.id, { text, mentions });
      workspace.setComments((list) => mergeComment(list, saved));
      return true;
    } catch (error) {
      workspace.setError(`Couldn't save the comment. ${error.message}`);
      return false;
    }
  }
  // Deletes a comment; a thread's first comment takes its replies. Returns true when it is gone.
  async function remove(comment) {
    removing.current.add(comment.id);
    try {
      const { deleted } = await deleteComment(doc.id, comment.id);
      workspace.setComments((list) => list.filter((entry) => !deleted.includes(entry.id)));
      if (deleted.includes(openId)) setOpenId(null);
      return true;
    } catch (error) {
      workspace.setError(`Couldn't delete the comment. ${error.message}`);
      return false;
    } finally {
      removing.current.delete(comment.id);
    }
  }
  // "Mark as unread" closes the thread, so the open thread is not marked read again at once.
  function markUnread(root) {
    if (openId === root.id) setOpenId(null);
    reads.markUnread(root.id);
  }

  return {
    active,
    canComment,
    threads,
    canMove: (comment) => canMoveComment(comment, workspace.access),
    // The comment as the server has it now (without moves that are not saved yet).
    savedComment: (id) => workspace.comments.find((comment) => comment.id === id) ?? null,
    framePins,
    pinsHidden,
    togglePins,
    filter,
    setFilter: chooseFilter,
    listed,
    openId,
    draft,
    posting,
    hint: active ? hint || (canComment ? "" : VIEW_ONLY_HINT) : "",
    author,
    setAuthor,
    // Asked once by the panel as it opens: true when it should take keyboard focus.
    takePanelFocus() {
      const value = focusPanel.current;
      focusPanel.current = false;
      return value;
    },
    draftReturn,
    toggleMode,
    leave,
    place,
    commentHere,
    adjustDraft,
    cancelDraft,
    postDraft,
    openThread,
    previewMove,
    cancelMove,
    moveThread,
    setResolved,
    // Threads, replies, editing, deleting, @mentions and unread state.
    closeThread,
    reply,
    editText,
    remove,
    markUnread,
    mentionNames,
    isMine: (comment) => isMine(comment, identity),
    canEditText: (comment) => canEditCommentText(comment, identity, workspace.access),
    canDelete: (comment) => canDeleteComment(comment, identity, workspace.access),
    unreadCount: reads.unreadCount,
    isUnread: reads.isUnread,
    mentionsMe: reads.mentionsMe,
    threadMentionsMe: reads.threadMentionsMe,
  };
}
