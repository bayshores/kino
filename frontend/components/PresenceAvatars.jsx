import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./PresenceAvatars.css";

const MAX_VISIBLE_PEOPLE = 5;
// The neutral slate from the server's avatar colors (PRESENCE_COLORS in backend/presence.mjs):
// dark enough for the white initials, and not purple.
const FALLBACK_COLOR = "#475569";

function readableName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "Guest";
}

function firstGrapheme(value) {
  if (typeof Intl.Segmenter === "function") {
    try {
      return new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)[Symbol.iterator]().next().value?.segment ?? "";
    } catch {
      // Older or restricted runtimes can still fall back to code points below.
    }
  }
  return Array.from(value)[0] ?? "";
}

function initials(name) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return "G";
  const selected = words.length > 1 ? words.slice(0, 2) : words.slice(0, 1);
  const result = selected.map(firstGrapheme).join("").toLocaleUpperCase();
  return result || "G";
}

function safeColor(value) {
  return typeof value === "string" && /^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(value)
    ? value
    : FALLBACK_COLOR;
}

function sceneFor(person, scenesById) {
  if (person.sceneId == null || person.sceneId === "") return null;
  const scene = scenesById.get(person.sceneId);
  return scene && typeof scene.name === "string" && scene.name.trim()
    ? { id: person.sceneId, name: scene.name.trim() }
    : null;
}

export function PresenceAvatars({ people = [], selfId, scenes = [], onFollow }) {
  const listId = useId();
  const rootRef = useRef(null);
  const overflowButtonRef = useRef(null);
  const popoverRef = useRef(null);
  const listRef = useRef(null);
  const focusedList = useRef(false);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState(null);

  const normalizedPeople = useMemo(() => {
    const sceneList = Array.isArray(scenes) ? scenes : [];
    const scenesById = new Map(sceneList.filter((scene) => scene && scene.id != null).map((scene) => [scene.id, scene]));
    const seen = new Set();
    const entries = (Array.isArray(people) ? people : [])
      .filter((person) => person && typeof person === "object" && person.id != null && !seen.has(person.id) && seen.add(person.id))
      .map((person, index) => {
        const name = readableName(person.name);
        const isSelf = selfId != null && person.id === selfId;
        const scene = sceneFor(person, scenesById);
        const scenePart = scene ? `on ${scene.name}` : "no scene selected";
        return {
          id: person.id,
          index,
          name,
          initials: initials(name),
          color: safeColor(person.color),
          isSelf,
          scene,
          sceneId: scene?.id ?? null,
          accessibleName: isSelf ? `You${scene ? `, on ${scene.name}` : ""}` : `${name}, ${scenePart}`,
          title: `${isSelf ? `You (${name})` : name}, ${scenePart}`,
        };
      });
    return entries.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.index - b.index);
  }, [people, scenes, selfId]);

  const hasOverflow = normalizedPeople.length > MAX_VISIBLE_PEOPLE;
  const visiblePeople = hasOverflow
    ? normalizedPeople.slice(0, MAX_VISIBLE_PEOPLE)
    : normalizedPeople;
  const hiddenCount = normalizedPeople.length - visiblePeople.length;

  useEffect(() => {
    if (!hasOverflow) setOpen(false);
  }, [hasOverflow]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onFocusIn = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      overflowButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const anchor = overflowButtonRef.current?.getBoundingClientRect();
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;

      const margin = 8;
      const gap = 8;
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.max(margin, Math.min(anchor.right - popover.width, viewportWidth - popover.width - margin));
      const availableBelow = viewportHeight - anchor.bottom - gap - margin;
      const availableAbove = anchor.top - gap - margin;
      const placeAbove = popover.height > availableBelow && availableAbove > availableBelow;
      const requestedTop = placeAbove ? anchor.top - popover.height - gap : anchor.bottom + gap;
      const top = Math.max(margin, Math.min(requestedTop, viewportHeight - popover.height - margin));
      const next = { left: Math.round(left), top: Math.round(top) };
      setPopoverPosition((current) => current?.left === next.left && current?.top === next.top ? current : next);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, normalizedPeople]);

  useEffect(() => {
    if (!open) { focusedList.current = false; return; }
    // Positioning initially hides the popover. Focus after that layout commit,
    // once per opening, so resize/scroll does not steal focus back from a person.
    if (!popoverPosition || focusedList.current) return;
    focusedList.current = true;
    const firstControl = listRef.current?.querySelector("button:not(:disabled)");
    (firstControl ?? listRef.current)?.focus({ preventScroll: true });
  }, [open, popoverPosition]);

  if (!normalizedPeople.length) return null;

  function closeAndReturnFocus() {
    setOpen(false);
    overflowButtonRef.current?.focus({ preventScroll: true });
  }

  function follow(person) {
    if (person.isSelf || person.sceneId == null || typeof onFollow !== "function") return;
    onFollow(person.sceneId);
    if (open) closeAndReturnFocus();
  }

  return (
    <div
      className={`presence-avatars${open ? " presence-avatars--open" : ""}`}
      role="group"
      aria-label={`${normalizedPeople.length} people in this file`}
      ref={rootRef}
    >
      <div className="presence-avatars__stack">
        {visiblePeople.map((person) => (
          person.sceneId != null && !person.isSelf ? (
            <button
              key={person.id}
              type="button"
              className="presence-avatars__entry presence-avatars__follow"
              aria-label={person.accessibleName}
              title={person.title}
              disabled={typeof onFollow !== "function"}
              onClick={() => follow(person)}
            >
              <span className="presence-avatars__chip" aria-hidden="true" style={{ "--presence-color": person.color }}>
                {person.initials}
              </span>
            </button>
          ) : (
            <span
              key={person.id}
              className="presence-avatars__entry"
              role="img"
              aria-label={person.accessibleName}
              title={person.title}
            >
              <span className="presence-avatars__chip" aria-hidden="true" style={{ "--presence-color": person.color }}>
                {person.initials}
              </span>
              {person.isSelf && <span className="presence-avatars__self-label" aria-hidden="true">You</span>}
            </span>
          )
        ))}
        {hasOverflow && (
          <button
            ref={overflowButtonRef}
            type="button"
            className="presence-avatars__more"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-label={`${open ? "Hide" : "Show"} ${hiddenCount} more people`}
            onClick={() => setOpen((value) => !value)}
          >
            +{hiddenCount}
          </button>
        )}
      </div>
      {open && hasOverflow && (
        <div
          className="presence-avatars__popover"
          id={listId}
          ref={popoverRef}
          style={popoverPosition ? { left: `${popoverPosition.left}px`, top: `${popoverPosition.top}px` } : { visibility: "hidden" }}
        >
          <ul
            className="presence-avatars__list"
            aria-label="People currently in this file"
            ref={listRef}
            tabIndex={-1}
          >
            {normalizedPeople.map((person) => {
              const disabled = person.isSelf || person.sceneId == null || typeof onFollow !== "function";
              const sceneLabel = person.scene?.name ?? "No scene selected";
              return (
                <li key={person.id} className="presence-avatars__item">
                  <button
                    type="button"
                    className="presence-avatars__person"
                    aria-label={person.accessibleName}
                    title={person.title}
                    disabled={disabled}
                    onClick={() => follow(person)}
                  >
                    <span
                      className="presence-avatars__chip presence-avatars__chip--list"
                      aria-hidden="true"
                      style={{ "--presence-color": person.color }}
                    >
                      {person.initials}
                    </span>
                    <span className="presence-avatars__person-copy">
                      <span className="presence-avatars__name">
                        {person.name}
                        {person.isSelf && <span className="presence-avatars__you">You</span>}
                      </span>
                      <span className="presence-avatars__scene">{sceneLabel}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
