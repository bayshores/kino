// An open thread in the Comments panel: its first comment and its replies, oldest first, and a
// box to reply beneath them. CommentsPanel.jsx draws it under the thread's row.
//
// Each comment has a "···" menu (CommentMenu.jsx) with only the actions this viewer can use:
//   Edit           the viewer's own comments: an edit box in place; Enter or ⌘Enter saves,
//                  Shift+Enter starts a new line, Esc cancels. Saved changes show "edited".
//   Mark as unread the thread stays unread in this browser until it is opened again.
//   Resolve/Reopen the first comment, for anyone who can comment (the checkmark does the same).
//   Delete         the viewer's own comments, or any comment for the file's owner. Deleting the
//                  first comment deletes the whole thread, so it asks first.
// The server checks each rule again (backend/comments.mjs). @names in the text are highlighted;
// a comment by someone else that mentions the viewer's display name says "Mentions you".
// A thread someone else deleted while it was open (thread.deleted) stays as it was last seen, with
// no menus and no Reply button, so text typed in it can still be copied until it is closed.
import { useEffect, useId, useRef, useState } from "react";
import { authorInitial } from "../comments.js";
import { mentionSegments } from "../mentions.js";
import { CommentMenu } from "./CommentMenu.jsx";
import { MentionTextarea } from "./MentionTextarea.jsx";
import "./CommentThread.css";

export const VIEW_ONLY_REPLY_HINT = "This link lets you read the thread. A comment or edit link is needed to reply.";

// A comment's time as the panel shows it: "Oct 15, 10:02 AM".
export function formatCommentDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function sameName(a, b) {
  return Boolean(a && b) && a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** A comment's text with its @names highlighted; the viewer's own name stands out more. */
export function MentionText({ text, names, viewerName }) {
  return mentionSegments(text, names ?? []).map((part, index) =>
    part.mention ? (
      <span key={index} className={`comment-mention${sameName(part.mention, viewerName?.trim()) ? " you" : ""}`}>
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}

// Enter (or ⌘/Ctrl+Enter) without Shift or ⌥, and not while an input method is composing.
function isSubmitKey(event) {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing;
}

function CommentEditor({ comment, names, onSave, onCancel }) {
  const [text, setText] = useState(comment.text);
  const [saving, setSaving] = useState(false);
  const field = useRef(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  async function save(event) {
    event?.preventDefault();
    if (!text.trim() || saving) return;
    if (text.trim() === comment.text) {
      onCancel();
      return;
    }
    setSaving(true);
    const saved = await onSave(text);
    setSaving(false);
    if (saved) onCancel();
  }
  return (
    <form className="comment-editor" aria-label="Edit comment" onSubmit={save}>
      <MentionTextarea
        textareaRef={field}
        aria-label="Comment text"
        value={text}
        onChange={setText}
        names={names}
        rows={3}
        maxLength={2000}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (isSubmitKey(event)) {
            event.preventDefault();
            event.stopPropagation();
            save();
          }
        }}
      />
      <div className="comment-form-footer">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!text.trim() || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function DeleteConfirm({ replyCount, onConfirm, onCancel }) {
  const questionId = useId();
  const cancel = useRef(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      className="comment-confirm"
      role="group"
      aria-labelledby={questionId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p id={questionId}>
        Delete this thread?{" "}
        {replyCount > 0 ? `Its ${replyCount} ${replyCount === 1 ? "reply is" : "replies are"} deleted too. ` : ""}
        This can't be undone.
      </p>
      <div className="comment-form-footer">
        <button ref={cancel} type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary danger"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            if (!(await onConfirm())) setDeleting(false);
          }}
        >
          {deleting ? "Deleting…" : "Delete thread"}
        </button>
      </div>
    </div>
  );
}

// One comment or reply: its text (or the edit box), its notes and its "···" menu.
function CommentItem({ comment, thread, isRoot, state, actions }) {
  const [mode, setMode] = useState("view");
  const menuButton = useRef(null);
  // Set when the edit box or the delete question closes, to give the "···" button focus again.
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || mode !== "view") return;
    setRefocus(false);
    menuButton.current?.focus();
  }, [refocus, mode]);

  const author = comment.author || "Guest";
  const resolved = Boolean(thread.comment.resolved);
  const items = thread.deleted ? [] : [
    state.canEditText(comment) && { id: "edit", label: "Edit" },
    !resolved && { id: "unread", label: "Mark as unread" },
    isRoot && state.canMove(comment) && { id: "resolve", label: resolved ? "Reopen" : "Resolve" },
    state.canDelete(comment) && { id: "delete", label: isRoot ? "Delete thread…" : "Delete", danger: true },
  ].filter(Boolean);

  async function select(id) {
    if (id === "edit") setMode("edit");
    else if (id === "unread") actions.markUnread();
    else if (id === "resolve") actions.resolve(menuButton.current);
    else if (id === "delete" && isRoot) setMode("confirm");
    else if (id === "delete" && (await state.remove(comment))) actions.replyDeleted();
  }
  function closeForm() {
    setMode("view");
    setRefocus(true);
  }

  const notes = (
    <>
      {comment.editedAt && (
        <span className="comment-thread-note" title={`Edited ${formatCommentDate(comment.editedAt)}`}>
          edited
        </span>
      )}
      {state.mentionsMe(comment) && <span className="comment-badge">Mentions you</span>}
    </>
  );
  const menu = mode === "view" && (
    <CommentMenu
      label={`Actions for the ${isRoot ? "comment" : "reply"} by ${author}`}
      items={items}
      onSelect={select}
      buttonRef={menuButton}
    />
  );
  const body =
    mode === "edit" ? (
      <CommentEditor
        comment={comment}
        names={state.mentionNames}
        onSave={(text) => state.editText(comment, text)}
        onCancel={closeForm}
      />
    ) : (
      <p className="comment-item-text">
        <MentionText text={comment.text} names={comment.mentions} viewerName={state.author} />
      </p>
    );

  return (
    <article className={`comment-item${isRoot ? " root" : ""}`} aria-label={isRoot ? `Comment by ${author}` : `Reply by ${author}`}>
      {isRoot ? (
        // The row above already shows the first comment's author and time.
        <>
          <div className="comment-item-main">
            {body}
            {menu}
          </div>
          {(comment.editedAt || state.mentionsMe(comment)) && <div className="comment-item-notes">{notes}</div>}
        </>
      ) : (
        <>
          <div className="comment-item-head">
            <span className="comment-avatar" aria-hidden="true">
              {authorInitial(author)}
            </span>
            <strong>{author}</strong>
            <time dateTime={comment.createdAt}>{formatCommentDate(comment.createdAt)}</time>
            {notes}
            {menu}
          </div>
          {body}
        </>
      )}
      {mode === "confirm" && (
        <DeleteConfirm
          replyCount={thread.replies.length}
          onCancel={closeForm}
          onConfirm={async () => {
            const removed = await state.remove(comment);
            if (removed) actions.threadDeleted();
            return removed;
          }}
        />
      )}
    </article>
  );
}

function ReplyComposer({ thread, state }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const author = state.author.trim() || "Guest";
  async function post(event) {
    event?.preventDefault();
    if (!text.trim() || posting || thread.deleted) return;
    setPosting(true);
    const saved = await state.reply(thread.comment, text);
    setPosting(false);
    if (saved) setText("");
  }
  return (
    <form className="comment-reply" aria-label={`Reply to ${thread.comment.author || "Guest"}`} onSubmit={post}>
      <MentionTextarea
        aria-label="Reply"
        placeholder="Reply… (@ to mention)"
        value={text}
        onChange={setText}
        names={state.mentionNames}
        rows={2}
        maxLength={2000}
        onKeyDown={(event) => {
          if (!isSubmitKey(event)) return;
          // Enter posts; Shift+Enter starts a new line.
          event.preventDefault();
          event.stopPropagation();
          post();
        }}
      />
      {!thread.deleted && (
        <div className="comment-form-footer">
          <span>as {author}</span>
          <button type="submit" className="primary" disabled={!text.trim() || posting}>
            {posting ? "Posting…" : "Reply"}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * `thread` is {comment, replies}; `state` the object useCommentMode.js returns. `actions` holds
 * what the panel does around the thread: markUnread(), resolve(button) (the checkmark's
 * focus-keeping toggle), threadDeleted() and replyDeleted(), which move keyboard focus.
 */
export function CommentThread({ id, thread, state, actions }) {
  const { comment: root, replies } = thread;
  return (
    <div id={id} className="comment-thread-view">
      <CommentItem comment={root} thread={thread} isRoot state={state} actions={actions} />
      {replies.length > 0 && (
        <ul className="comment-replies" aria-label={`Replies to ${root.author || "Guest"}`}>
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentItem comment={reply} thread={thread} state={state} actions={actions} />
            </li>
          ))}
        </ul>
      )}
      {state.canComment ? (
        <ReplyComposer key={root.id} thread={thread} state={state} />
      ) : (
        <p className="comments-panel-hint">{VIEW_ONLY_REPLY_HINT}</p>
      )}
    </div>
  );
}
