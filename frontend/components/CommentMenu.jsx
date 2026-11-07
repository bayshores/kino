// The "···" menu on a comment or reply in the Comments panel: a button that opens a short list
// of actions (CommentThread.jsx decides which ones the viewer can use).
//
// Keyboard: Enter, Space or ↓ on the button opens the menu at its first item, ↑ at its last.
// In the menu, ↑ ↓ move (round from the end to the start), Home and End go to the first and last
// item, Enter or Space chooses, and Esc or Tab closes the menu and puts focus back on the button.
// A press outside closes it. Keys pressed in the menu stay in it, so the editor's shortcuts
// (arrow keys, Space, Delete, tool letters) do not act; ⌘ and Ctrl shortcuts still work.
import { useEffect, useId, useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";

function plain(event) {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * `label` names the button ("Actions for the comment by Ana"). `items` is [{id, label, danger?}],
 * only the actions this viewer can use; with none, nothing is drawn. `onSelect(id)` runs after the
 * menu has closed and focus is back on the button. `buttonRef` lets the comment give the button
 * focus again later (after an edit, for example).
 */
export function CommentMenu({ label, items, onSelect, buttonRef }) {
  const [open, setOpen] = useState(false);
  const ownButton = useRef(null);
  const button = buttonRef ?? ownButton;
  const menu = useRef(null);
  // The item to focus when the menu opens: 0 (first) or -1 (last).
  const firstFocus = useRef(0);
  const menuId = useId();

  function menuItems() {
    return [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])];
  }
  function focusItem(index) {
    const list = menuItems();
    if (!list.length) return;
    list[(index + list.length) % list.length].focus();
  }
  function openMenu(index) {
    firstFocus.current = index;
    setOpen(true);
  }
  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    focusItem(firstFocus.current);
    menu.current?.scrollIntoView?.({ block: "nearest" });
    // A press anywhere else closes the menu and leaves focus where that press puts it.
    function pressOutside(event) {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", pressOutside, true);
    return () => document.removeEventListener("pointerdown", pressOutside, true);
  }, [open]);

  if (!items.length) return null;

  function buttonKeyDown(event) {
    if (!plain(event) || event.shiftKey) return;
    const key = event.key;
    if (key !== "Enter" && key !== " " && key !== "ArrowDown" && key !== "ArrowUp") return;
    // Handled here (not by the browser's click), so Space never reaches the editor's play key.
    event.preventDefault();
    event.stopPropagation();
    if (open && (key === "Enter" || key === " ")) close();
    else openMenu(key === "ArrowUp" ? -1 : 0);
  }
  function menuKeyDown(event) {
    const list = menuItems();
    const index = list.indexOf(document.activeElement);
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (plain(event) && !event.shiftKey && ["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (key === "ArrowDown") focusItem(index + 1);
      else if (key === "ArrowUp") focusItem(index < 0 ? -1 : index - 1);
      else if (key === "Home") focusItem(0);
      else focusItem(-1);
      return;
    }
    // Enter and Space press the focused item (a <button>); nothing goes on to the editor.
    if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
  }

  return (
    <div className="comment-menu">
      <button
        ref={button}
        type="button"
        className="icon-button comment-menu-button"
        aria-label={label}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openMenu(0))}
        onKeyDown={buttonKeyDown}
      >
        <DotsThree weight="bold" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="comment-menu-list"
          role="menu"
          aria-label={label}
          onKeyDown={menuKeyDown}
          onBlur={(event) => {
            // Focus left the menu some other way (a screen reader, for example): close it.
            const next = event.relatedTarget;
            if (next && !menu.current?.contains(next) && next !== button.current) setOpen(false);
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger ? "danger" : undefined}
              onClick={() => {
                close();
                onSelect(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
