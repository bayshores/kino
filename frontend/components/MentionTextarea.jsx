// A comment text box that suggests names after @: the canvas draft, the reply box and the edit
// box all use it. mentions.js has the rules (which names, what was typed, how a name goes in).
//
// Typing @ opens a list of names that fit what follows it. While the list is open, ↑ ↓ choose a
// name, Enter or Tab puts "@Name " in the text, and Esc closes the list (it stays closed for that
// @). A click on a name puts it in too. Every other key goes to the box's own `onKeyDown`, so
// Enter still posts and Esc still cancels when no list is open.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { authorInitial } from "../comments.js";
import { activeMention, insertMention, matchMentionNames } from "../mentions.js";

function plain(event) {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent?.isComposing;
}

/**
 * `value` and `onChange(text)` are the text; `names` the names to suggest (useCommentMode.js
 * mentionNames). Other props (aria-label, placeholder, rows, maxLength, onKeyDown…) go to the
 * <textarea>. `textareaRef` reaches the <textarea> itself.
 */
export function MentionTextarea({ value, onChange, names = [], textareaRef, onKeyDown, className = "", ...props }) {
  const ownRef = useRef(null);
  const field = textareaRef ?? ownRef;
  // Where the caret is while the box has focus, or null (no list without focus).
  const [caret, setCaret] = useState(null);
  // The @ (its position in the text) whose list Esc closed or a chosen name finished.
  const [dismissed, setDismissed] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Where the caret goes after a chosen name changes the text.
  const nextCaret = useRef(null);
  const listId = useId();

  const mention = caret === null ? null : activeMention(value, caret);
  const matches = mention && mention.start !== dismissed ? matchMentionNames(names, mention.query) : [];
  const open = matches.length > 0;
  const chosen = Math.min(activeIndex, Math.max(0, matches.length - 1));

  // A new @ or more typing starts the list again at its first name.
  useEffect(() => setActiveIndex(0), [mention?.start, mention?.query]);
  // The @ that was dismissed is gone (deleted, or the caret left it): the next one gets a list.
  useEffect(() => {
    if (dismissed !== null && mention?.start !== dismissed) setDismissed(null);
  }, [mention?.start, dismissed]);
  useLayoutEffect(() => {
    if (nextCaret.current === null || !field.current) return;
    field.current.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [value]);

  function trackCaret(event) {
    setCaret(event.currentTarget.selectionStart === event.currentTarget.selectionEnd ? event.currentTarget.selectionStart : null);
  }
  function choose(name) {
    if (!mention) return;
    const result = insertMention(value, mention, name);
    nextCaret.current = result.caret;
    setDismissed(mention.start);
    setCaret(result.caret);
    onChange(result.text);
  }
  function keyDown(event) {
    if (open && plain(event)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((chosen + step + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        choose(matches[chosen]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(mention.start);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className={`mention-field ${className}`.trim()}>
      <textarea
        {...props}
        ref={field}
        value={value}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${chosen}` : undefined}
        onChange={(event) => {
          trackCaret(event);
          onChange(event.target.value);
        }}
        onSelect={trackCaret}
        onFocus={trackCaret}
        onBlur={() => setCaret(null)}
        onKeyDown={keyDown}
      />
      <span className="comment-sr-only" role="status">
        {open ? `${matches.length} ${matches.length === 1 ? "name" : "names"} to mention. Up and down arrows choose, Enter or Tab inserts.` : ""}
      </span>
      {open && (
        <ul id={listId} className="mention-list" role="listbox" aria-label="People to mention">
          {matches.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === chosen}
              className={index === chosen ? "active" : undefined}
              // Pressing a name keeps focus in the text box.
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(name)}
            >
              <span className="comment-avatar" aria-hidden="true">
                {authorInitial(name)}
              </span>
              <span>{name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
