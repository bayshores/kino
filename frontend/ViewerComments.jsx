// Comments in the viewer, for comment and edit links: the thread list (CommentsPanel.jsx), a box
// for a new comment, and the pins on the frame. The rules are the editor's own (useCommentMode.js,
// comments.js, mentions.js), and the server checks each one again (backend/comments.mjs).
//
// Data flow: the server sends the file's comments over the viewer's WebSocket after every join and
// every change (useViewerDocument.js). Posting, replying, resolving, editing and deleting go
// through the comment requests in comments.js, and each saved comment shows at once (mergeComment).
//
// A new comment is tied to the current time on the current scene. A click on the frame puts it
// at that spot; "Comment on this scene" (keyboard) puts it at the scene's middle.
import { useEffect, useRef, useState } from "react";
import { anchorTime, authorInitial, commentChips, formatCommentTime, pinLabel } from "./comments.js";
import { pinPlacement, roundCoordinate } from "./commentPins.js";
import { snapComment } from "./dashboard/noteSpot.js";
import { CommentsPanel } from "./components/CommentsPanel.jsx";
import { MentionTextarea } from "./components/MentionTextarea.jsx";
import { useCommentMode } from "./useCommentMode.js";
import { viewerPinsShortcut } from "./viewerNavigation.js";

/**
 * The comment state for the viewer. `viewer` is what useViewerDocument returns; `open` is whether
 * the comments column is showing; `cards` is whether the viewer shows scrolling cards (phones,
 * narrow windows, touch screens), which have no pins. The other arguments move the viewer's scene
 * and time.
 */
export function useViewerComments({ access, viewer, doc, scene, time, open, setOpen, cards, selectScene, setTime, setPlaying, setNotice }) {
  const [error, setError] = useState("");
  const workspace = {
    access,
    comments: viewer.comments,
    setComments: viewer.setComments,
    people: viewer.people,
    announceName: viewer.announceName,
    // The viewer has no unsaved document changes to send before a comment.
    flush: async () => {},
    setError,
  };
  const state = useCommentMode({
    workspace,
    doc,
    scene,
    time,
    tool: open ? "comment" : "select",
    setTool: (tool) => setOpen(tool === "comment"),
    framePins: !cards,
    selectScene,
    setTime: (value) => setTime(value),
    setPlaying,
    setNotice,
  });
  // ⇧C hides or shows the pins on the frame, as the eye button in Comments does, also while the
  // comments column is closed. Not while typing (viewerPinsShortcut). View links and the card
  // layout have no pins, so there ⇧C does nothing.
  const togglePins = useRef(state.togglePins);
  togglePins.current = state.togglePins;
  const pinsShortcut = Boolean(access.canComment && doc && !cards);
  useEffect(() => {
    if (!pinsShortcut) return undefined;
    function keydown(event) {
      if (!viewerPinsShortcut(event)) return;
      event.preventDefault();
      togglePins.current({ announce: true });
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pinsShortcut]);
  // now: the playhead, where the new comment's range can end.
  return { ...state, now: time, error, clearError: () => setError("") };
}

/** Where a click at (clientX, clientY) lands on `scene`, in scene pixels: {sceneId, x, y}. */
export function framePoint(box, clientX, clientY, scene) {
  if (!box?.width || !box?.height || !scene) return null;
  const x = ((clientX - box.left) / box.width) * scene.width;
  const y = ((clientY - box.top) / box.height) * scene.height;
  return {
    sceneId: scene.id,
    x: Math.min(Math.max(roundCoordinate(x), 0), scene.width),
    y: Math.min(Math.max(roundCoordinate(y), 0), scene.height),
  };
}

const percent = (value, total) => `${(Number(value) / Number(total || 1)) * 100}%`;

/**
 * The pins on the frame: one per open thread on this scene, and the new comment's pin. While the
 * comments column is open, a click on the frame (not on a pin) places a new comment there, on the
 * layer under the click.
 */
export function CommentMarks({ state, doc, scene, time, placing }) {
  if (!scene) return null;
  const pins = state.pinsHidden ? [] : state.threads.filter(({ comment }) => !comment.resolved && comment.sceneId === scene.id);
  const draft = state.draft?.sceneId === scene.id && !state.draft.whole ? state.draft : null;
  return (
    <div
      className={`viewer-marks${placing ? " placing" : ""}`}
      onClick={(event) => {
        if (!placing || event.target !== event.currentTarget) return;
        state.place(snapComment(doc, scene, framePoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, scene), time));
      }}
    >
      {pins.map((thread) => {
        const place = pinPlacement(thread.comment, scene);
        const open = state.openId === thread.comment.id;
        return (
          <button
            key={thread.comment.id}
            type="button"
            className={`viewer-pin${open ? " open" : ""}`}
            style={{ left: percent(place.x, scene.width), top: percent(place.y, scene.height) }}
            aria-label={pinLabel(thread, place.time)}
            aria-current={open ? "true" : undefined}
            title={pinLabel(thread, place.time)}
            onClick={() => (open ? state.closeThread() : state.openThread(thread.comment))}
          >
            <span aria-hidden="true">{authorInitial(thread.comment.author)}</span>
          </button>
        );
      })}
      {draft && (
        <span className="viewer-pin draft" style={{ left: percent(draft.x, scene.width), top: percent(draft.y, scene.height) }} aria-hidden="true">
          <span>{authorInitial(state.author || "Guest")}</span>
        </span>
      )}
    </div>
  );
}

/**
 * The new comment's place as chips: the layer it is pinned to (press to unpin), its range (press
 * to end it at the playhead, again to clear) and whole video (press to toggle).
 */
function DraftChips({ state, draft, target }) {
  const placed = !draft.whole;
  const layer = draft.layerId ? target?.layers?.find((item) => item.id === draft.layerId)?.name || draft.layerId : null;
  const ranged = Number.isFinite(draft.timeEnd);
  const end = anchorTime(state.now, target);
  const chips = commentChips({ ...draft, timeEnd: ranged ? draft.timeEnd : undefined }, { scenes: target ? [target] : [] });
  return (
    <div className="comment-chips" role="group" aria-label="Comment place">
      {placed && layer && (
        <button type="button" className="comment-chip" aria-pressed="true" aria-label={`Pinned to ${layer}`} title="Unpin the layer" onClick={() => state.adjustDraft({ layerId: null })}>
          {layer}
        </button>
      )}
      {placed && (
        <button
          type="button"
          className="comment-chip"
          aria-pressed={ranged}
          aria-label={ranged ? `Range ${chips.at(-1)}` : `Range to ${formatCommentTime(end)}`}
          title={ranged ? "Clear the range" : "Move the playhead, then end the range there"}
          disabled={!ranged && !(end > draft.time)}
          onClick={() => state.adjustDraft({ timeEnd: ranged ? undefined : end })}
        >
          {ranged ? chips.at(-1) : `to ${formatCommentTime(end)}`}
        </button>
      )}
      <button type="button" className="comment-chip" aria-pressed={!placed} onClick={() => state.adjustDraft({ whole: placed })}>
        whole video
      </button>
    </div>
  );
}

/** The box for the comment being written. Enter posts, Shift+Enter is a new line, Esc cancels. */
function NewComment({ state, doc }) {
  const [text, setText] = useState("");
  const field = useRef(null);
  const draft = state.draft;
  const target = doc.scenes.find((item) => item.id === draft.sceneId);
  useEffect(() => {
    field.current?.focus();
  }, [draft.sceneId, draft.x, draft.y, draft.time]);
  // When the box closes with focus in it, focus goes back where the comment was started from.
  useEffect(() => () => {
    const back = state.draftReturn.current;
    requestAnimationFrame(() => {
      const active = window.document.activeElement;
      if (active && active !== window.document.body) return;
      (back?.isConnected ? back : window.document.querySelector(".comments-panel-header h2"))?.focus();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function post(event) {
    event?.preventDefault();
    if (!text.trim() || state.posting) return;
    if (await state.postDraft(text)) setText("");
  }
  return (
    <form
      className="viewer-new-comment"
      aria-label="New comment"
      onSubmit={post}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        state.cancelDraft();
      }}
    >
      <p className="viewer-new-comment-place">
        {draft.whole
          ? "new comment · whole video"
          : `new comment · ${target?.name ?? "scene"} · ${formatCommentTime(draft.time)} · at ${Math.round(draft.x)}, ${Math.round(draft.y)}`}
      </p>
      <DraftChips state={state} draft={draft} target={target} />
      <MentionTextarea
        textareaRef={field}
        aria-label="Comment text"
        placeholder="Add a comment… (@ to mention)"
        value={text}
        maxLength={2000}
        rows={3}
        names={state.mentionNames}
        onChange={setText}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          post();
        }}
      />
      <div className="comment-form-footer">
        <span>as {state.author.trim() || "Guest"}</span>
        <button type="button" className="secondary" onClick={state.cancelDraft}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!text.trim() || state.posting}>
          {state.posting ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}

/** The comments column: errors, the thread list and, while one is being written, the new comment. */
export function ViewerCommentsColumn({ state, doc, access, cards }) {
  return (
    <div className="viewer-comments" id="viewer-comments">
      {state.error && (
        <p className="viewer-comments-error" role="alert">
          {state.error}{" "}
          <button type="button" className="secondary" onClick={state.clearError}>
            Dismiss
          </button>
        </p>
      )}
      {state.hint && (
        <p className="viewer-comments-hint" role="status">
          {state.hint}
        </p>
      )}
      <CommentsPanel
        state={state}
        doc={doc}
        access={access}
        placeHint={
          cards
            ? "Comment on this scene ties a comment to the current time."
            : "Click the frame to leave a comment at that spot, tied to the current time."
        }
      >
        {state.draft && <NewComment state={state} doc={doc} />}
      </CommentsPanel>
    </div>
  );
}
