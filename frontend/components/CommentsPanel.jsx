// The Comments panel: shown in the Inspector's place while comment mode is on. It lists the
// file's threads (Open, Resolved or All; the thread with the newest post first), opens a thread on
// the canvas and timeline, resolves and reopens threads, and holds the display name new comments
// are posted with. A thread's row opens and closes it; the open thread (CommentThread.jsx) shows
// its comments, their "···" menus and a reply box. Unread threads (useCommentReads.js) have a dot,
// and threads that mention the viewer say so. `state` is the object useCommentMode.js returns.
// The open thread stays listed when someone else resolves, reopens or deletes it (with a note),
// and keyboard focus never drops to the page when another session removes what had it: typed
// letters would then reach the editor's shortcuts (R adds a rectangle).
import { useEffect, useRef } from "react";
import { ArrowCounterClockwise, ChatCircle, Check, Eye, EyeSlash, X } from "@phosphor-icons/react";
import {
  COMMENT_FILTERS,
  authorInitial,
  canMoveComment,
  commentScene,
  formatCommentTime,
  matchesFilter,
  threadCounts,
} from "../comments.js";
import { pinPlacement } from "../commentPins.js";
import { VIEW_ONLY_HINT } from "../useCommentMode.js";
import { CommentThread, MentionText, formatCommentDate } from "./CommentThread.jsx";
import "./CommentsPanel.css";

const FILTER_NAMES = { open: "Open", resolved: "Resolved", all: "All" };
// Shown in the open thread when someone else resolved or reopened it, so this filter no longer
// lists it, or deleted it (useCommentMode.js listed).
const KEPT_TEXT = {
  open: "Resolved. It leaves the Open list when you close it.",
  resolved: "Reopened. It leaves the Resolved list when you close it.",
  deleted: "This thread was deleted. Replies can't be posted. It leaves the list when you close it.",
};
const EMPTY_TEXT = {
  open: "No open comments.",
  resolved: "No resolved comments.",
  all: "No comments yet.",
};

// Where a thread sits: "Scene 1 · 1.25 s", or why it has no pin.
function threadPlace(comment, doc) {
  const scene = commentScene(comment, doc);
  if (!scene) return comment.sceneId ? "Its scene was deleted" : "Not placed on a scene";
  const { time } = pinPlacement(comment, scene);
  return Number.isFinite(time) ? `${scene.name} · ${formatCommentTime(time)}` : scene.name;
}

// `placeHint` says how a comment is placed; `children` (the viewer's new-comment box) go under it.
export function CommentsPanel({ state, doc, access, placeHint = "Click a scene to leave a comment there, tied to the time cursor.", children }) {
  const root = useRef(null);
  const heading = useRef(null);
  const hereButton = useRef(null);
  // True while keyboard focus is in the panel, so closing it can give focus back.
  const hadFocus = useRef(false);
  // The element in the panel that last had focus, and the index of the thread it was in.
  const lastFocus = useRef({ element: null, index: 0 });
  const counts = threadCounts(state.threads);
  const shown = state.listed;

  useEffect(() => {
    if (state.takePanelFocus()) heading.current?.focus();
    return () => {
      // The panel is closing with focus in it: give focus to the toolbar's Comments button.
      if (!hadFocus.current) return;
      requestAnimationFrame(() => {
        const active = window.document.activeElement;
        if (!active || active === window.document.body) window.document.querySelector(".floating-tools .comment-tool")?.focus();
      });
    };
  }, []);
  useEffect(() => {
    root.current?.querySelector(".comment-thread.open")?.scrollIntoView({ block: "nearest" });
  }, [state.openId, state.filter]);
  // Another session deleted the thread (or the reply) that had focus: focus goes to the thread
  // that took its place instead of the page.
  useEffect(() => {
    const { element, index } = lastFocus.current;
    if (!element || element.isConnected) return;
    lastFocus.current = { element: null, index };
    focusAfterRemoval(null, index);
  });

  // Resolving, reopening or deleting can take a thread out of the list, which removes the
  // button that had focus. Keyboard focus then goes to the thread that took its place (or the
  // one above), or to the list's filter button when the list is now empty.
  function focusAfterRemoval(button, index) {
    requestAnimationFrame(() => {
      const active = window.document.activeElement;
      if (button?.isConnected || (active && active !== window.document.body)) return;
      const items = root.current?.querySelectorAll(".comment-thread-open") ?? [];
      const target = items.length
        ? items[Math.min(index, items.length - 1)]
        : root.current?.querySelector('.comment-filters [aria-pressed="true"]');
      target?.focus();
    });
  }
  async function toggleResolved(button, comment, index) {
    if (await state.setResolved(comment, !comment.resolved)) focusAfterRemoval(button, index);
  }
  // Keyboard focus to a thread's row (after "Mark as unread" closed it, or a reply was deleted).
  function focusRow(id) {
    requestAnimationFrame(() => root.current?.querySelector(`.comment-thread-open[data-thread-id="${id}"]`)?.focus());
  }
  // What the open thread's menus do around it (CommentThread.jsx).
  function threadActions(comment, index) {
    return {
      markUnread() {
        state.markUnread(comment);
        focusRow(comment.id);
      },
      resolve: (button) => toggleResolved(button, comment, index),
      threadDeleted: () => focusAfterRemoval(null, index),
      replyDeleted: () => focusRow(comment.id),
    };
  }

  return (
    <aside
      ref={root}
      className="comments-panel"
      aria-labelledby="comments-panel-title"
      onFocus={(event) => {
        hadFocus.current = true;
        const items = [...(root.current?.querySelectorAll(".comment-thread") ?? [])];
        lastFocus.current = { element: event.target, index: Math.max(0, items.indexOf(event.target.closest(".comment-thread"))) };
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) {
          hadFocus.current = false;
          lastFocus.current = { element: null, index: 0 };
        }
      }}
      onKeyDown={(event) => {
        // Esc in the panel leaves comment mode, except while typing in a text field.
        if (event.key !== "Escape" || event.target.closest('input[type="text"], input:not([type]), textarea')) return;
        event.preventDefault();
        event.stopPropagation();
        state.leave();
      }}
    >
      <header className="comments-panel-header">
        <h2 id="comments-panel-title" ref={heading} tabIndex={-1}>
          Comments
          {state.unreadCount > 0 && <span className="comments-unread-count">{state.unreadCount} unread</span>}
        </h2>
        {state.framePins && (
          <button
            type="button"
            className="icon-button"
            aria-label="Show comments on the canvas"
            aria-pressed={!state.pinsHidden}
            title={`${state.pinsHidden ? "Show" : "Hide"} comments on the canvas (⇧C)`}
            onClick={() => state.togglePins()}
          >
            {state.pinsHidden ? <EyeSlash /> : <Eye />}
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close comments" title="Close comments (Esc)" onClick={state.leave}>
          <X />
        </button>
      </header>
      <div className="comments-panel-body">
        <p className="comments-panel-hint">
          {access.canComment ? placeHint : VIEW_ONLY_HINT}
        </p>
        {access.canComment && (
          <button
            ref={hereButton}
            type="button"
            className="secondary comment-here"
            onClick={() => state.commentHere(hereButton.current)}
          >
            <ChatCircle />
            Comment on this scene
          </button>
        )}
        {children}
        <label className="comments-name">
          Display name (optional)
          <input
            type="text"
            disabled={!access.canComment}
            value={state.author}
            maxLength={100}
            placeholder="Guest"
            onChange={(event) => state.setAuthor(event.target.value)}
          />
        </label>
        <div className="comment-filters" role="group" aria-label="Show comments">
          {COMMENT_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={state.filter === filter}
              onClick={() => state.setFilter(filter)}
            >
              {FILTER_NAMES[filter]}
              <span>{counts[filter]}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="comments-empty">{EMPTY_TEXT[state.filter]}</p>
        ) : (
          <ul className="comment-threads" aria-label={`${FILTER_NAMES[state.filter]} comments`}>
            {shown.map((thread, index) => {
              const { comment, replies } = thread;
              const open = state.openId === comment.id;
              const author = comment.author || "Guest";
              const unread = state.isUnread(comment.id);
              const mentioned = state.threadMentionsMe(thread);
              const viewId = `comment-thread-${comment.id}`;
              // Someone else resolved, reopened or deleted the open thread: it stays until it is closed.
              const kept = thread.deleted ? "deleted" : open && !matchesFilter(comment, state.filter) ? state.filter : null;
              return (
                <li
                  key={comment.id}
                  className={`comment-thread${open ? " open" : ""}${comment.resolved ? " resolved" : ""}${unread ? " unread" : ""}`}
                >
                  <div className="comment-thread-row">
                    <button
                      type="button"
                      className="comment-thread-open"
                      data-thread-id={comment.id}
                      aria-expanded={open}
                      aria-controls={open ? viewId : undefined}
                      aria-current={open ? "true" : undefined}
                      onClick={() => (open ? state.closeThread() : state.openThread(comment))}
                    >
                      <span className="comment-avatar" aria-hidden="true">
                        {authorInitial(author)}
                      </span>
                      <span className="comment-thread-text">
                        <span className="comment-thread-meta">
                          {unread && <span className="comment-unread-dot" aria-hidden="true" />}
                          <strong>{author}</strong>
                          <time dateTime={comment.createdAt}>{formatCommentDate(comment.createdAt)}</time>
                          {unread && <span className="comment-sr-only">Unread.</span>}
                        </span>
                        <span className="comment-thread-place">{threadPlace(comment, doc)}</span>
                        {!open && (
                          <span className="comment-thread-body">
                            <MentionText text={comment.text} names={comment.mentions} viewerName={state.author} />
                          </span>
                        )}
                        {(mentioned || (!open && comment.editedAt) || replies.length > 0) && (
                          <span className="comment-thread-notes">
                            {mentioned && <span className="comment-badge">Mentions you</span>}
                            {!open && comment.editedAt && <span className="comment-thread-note">edited</span>}
                            {replies.length > 0 && (
                              <span className="comment-thread-note">
                                {replies.length} {replies.length === 1 ? "reply" : "replies"}
                              </span>
                            )}
                          </span>
                        )}
                      </span>
                    </button>
                    {!thread.deleted && (
                      <button
                        type="button"
                        className="icon-button comment-resolve"
                        disabled={!canMoveComment(comment, access)}
                        aria-label={`${comment.resolved ? "Reopen" : "Resolve"} the comment by ${author}`}
                        title={comment.resolved ? "Reopen" : "Resolve"}
                        onClick={(event) => toggleResolved(event.currentTarget, comment, index)}
                      >
                        {comment.resolved ? <ArrowCounterClockwise /> : <Check />}
                      </button>
                    )}
                  </div>
                  {kept && (
                    <p className="comment-thread-kept" role="status">
                      {KEPT_TEXT[kept]}
                    </p>
                  )}
                  {open && <CommentThread id={viewId} thread={thread} state={state} actions={threadActions(comment, index)} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
