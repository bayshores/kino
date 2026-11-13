// The five panes of the dashboard (plan §5.2–5.3) and the two bottom lines. Each pane is a
// <section> you can focus (keys 1–5 or a click); Tab then moves through its buttons and
// fields, and on to the next pane's. Each pane is a box with a header row: its title on the
// left, facts and controls on the right.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ResolveImage } from "./resolve.jsx";
import { Icon as ControlIcon } from "./controls.jsx";
import { createPortal, flushSync } from "react-dom";
import { ScenePreview } from "../components/ScenePreview.jsx";
import { layerBounds } from "../layerBounds.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { calmLightAnimations } from "../../engine/effects/light.js";
import { frameUrl, renderFileUrl, seenUrl } from "./api.js";
import { heavyLiveEffects, heavyLiveEffectsAt, reducedLayout } from "./liveResolution.js";
import { ago, baseName, bytes, callLine, callSummary, clock, cut, fixWords, imageKind, imageTokens, progressBar, SPINNER, timeOfDay, tokens } from "./format.js";
import { activeAgents, activeAgentsText, agentRows, briefRows, callAgent, commentRows, dragPoint, rulerSeconds, needsYouRows, noteRows, optionLabel, otherStops, planRows, pointingLine, pointRange, rangeText, seenImages, stepPoint, stopName, stopRows, timelineRows, trafficTokens, turnRows, videoLayers, waitingStopOf } from "./state.js";
import { StagePresence, TimelinePresence } from "./presence.jsx";
import { Bot } from "./bot.jsx";
import { moodOfRow } from "./bot.js";
import { buildingIds, serverNow } from "./presence.js";
import { HoverCard, NewButton, NewMarks, StoryRow, useTimelineChanges } from "./timeline.jsx";
import { LANE_PX, TimelineLanes, useLanes } from "./lanes.jsx";
import { knownAgents, needRange, rulerCues, rulerTicks } from "./lanes.js";
import { thumbnails } from "./thumbnails.js";
import { NO_PICK, previewPick, readyRuns } from "./previewPick.js";
import { PreviewVideos } from "./previewCache.jsx";
import { minutes, shownAgent } from "./agentView.js";
import { noteCursorRows, noteDot, noteGroups, noteNumber, noteStatus, notesForYou, snapNote } from "./noteSpot.js";
import { hoverLines, newMarks, onScreenRanges, storyParts } from "./timeline.js";
import { BriefLines } from "./brief.jsx";
import { StopLines } from "./stops.jsx";
import { APPROVAL_WORDS, STOP_WORDS } from "./words.js";
import { MaterialChoices, RenderDock, SeenDrawer } from "./live.jsx";

const capital = (text) => String(text ?? "").replace(/^./, (letter) => letter.toUpperCase());

/** A spinner that stands still (…) under reduced motion. */
export function Spinner({ still }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (still) return undefined;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), 100);
    return () => clearInterval(timer);
  }, [still]);
  return <span className="cell braille s-working" aria-hidden="true">{still ? "…" : SPINNER[frame]}</span>;
}

/** A status symbol and its word, so colour is never the only signal (§5.4). */
export function Status({ status, still }) {
  const look = {
    working: [null, "working"], "needs-you": ["●", "needs you"], idle: ["○", "idle"], done: ["●", "done"], failed: ["✕", "failed"],
  }[status] ?? ["○", status];
  return <span className={`s-${status}`}>{look[0] ? <span className="cell" aria-hidden="true">{look[0]}</span> : <Spinner still={still} />} {look[1]}</span>;
}

/** An agent's name in its own color (F1 keeps every color readable on the dark panes). */
export function AgentName({ agent, className = "agent-name", before = "" }) {
  // `before` goes in the same text, so a screen reader hears "· Nova" and not a lone name.
  return <span className={className} style={agent?.color ? { color: agent.color } : undefined}>{`${before}${agent?.name ?? "agent"}`}</span>;
}

/**
 * One pane: a box with a header row (the title on the left, `facts` on the right) and a body
 * that scrolls. The title stays the <h2> that names the pane's region ("2 stage"): the brackets
 * round the number are only drawn ("[2] stage"), and the focused pane drops them ("2 stage").
 * A title cut short ends in "…", but not while a control in it has the focus (dashboard.css);
 * the browser may scroll the title's line to show that control, and once the focus leaves the
 * title, the line goes back to its start.
 */
export function Pane({ number, name, title, facts, focused, zoomed, onFocus, className, style, children, labelId }) {
  const titleBack = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.scrollLeft = 0;
    if (event.currentTarget.firstElementChild) event.currentTarget.firstElementChild.scrollLeft = 0;
  };
  return (
    <section className={`pane ${className}${zoomed ? " is-zoomed" : ""}`} style={style} data-focused={focused} data-pane={number} tabIndex={-1}
      aria-labelledby={labelId} onMouseDown={() => onFocus(number)} onFocus={() => onFocus(number)}>
      <h2 id={labelId} onBlur={titleBack}><span><span className="pane-name">{name}</span>{title ? <span className="dim"> · {title}</span> : null}</span></h2>
      <div className="pane-facts">{facts}</div>
      <div className="pane-body">{children}</div>
    </section>
  );
}

// ---- small shared controls -------------------------------------------------------------------

// Line icons for the transport, zoom and scroll buttons. They take the text colour.
const ICONS = {
  "frame-back": <><rect x="3" y="3" width="1.7" height="10" /><path d="M13 3v10L5.6 8z" /></>,
  play: <path d="M4.5 2.5v11L13.5 8z" />,
  pause: <><rect x="4" y="3" width="2.7" height="10" /><rect x="9.3" y="3" width="2.7" height="10" /></>,
  "frame-forward": <><path d="M3 3v10l7.4-5z" /><rect x="11.3" y="3" width="1.7" height="10" /></>,
  expand: <path d="M2.5 6.5v-4h4M9.5 2.5h4v4M13.5 9.5v4h-4M6.5 13.5h-4v-4" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  restore: <path d="M6.5 2.5v4h-4M13.5 6.5h-4v-4M9.5 13.5v-4h4M2.5 9.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  left: <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  right: <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  up: <path d="M3.5 10 8 5.5l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  down: <path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  // The tabs, the top bar's buttons and the stage's switches: 1.3 px lines.
  monitor: <g fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1.8" y="2.5" width="12.4" height="8.6" rx="1" /><path d="M5.5 13.8h5M6.9 5.1v3.4L9.7 6.8z" /></g>,
  users: <g fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="6" cy="5.4" r="2.4" /><path d="M1.8 13.5c.4-2.4 2.2-3.7 4.2-3.7s3.8 1.3 4.2 3.7M10.4 3.2a2.3 2.3 0 0 1 0 4.4M12 9.9c1.2.5 2 1.6 2.2 3.6" /></g>,
  library: <g fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="3.6" r="1.8" /><circle cx="3.6" cy="12" r="1.8" /><circle cx="12.4" cy="12" r="1.8" /><path d="M7.1 5.2 4.5 10.4M8.9 5.2l2.6 5.2M5.4 12h5.2" /></g>,
  compass: <g fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6.2" /><path d="m10.6 5.4-1.5 3.7-3.7 1.5 1.5-3.7z" /></g>,
  hold: <g fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="3.6" y="3" width="2.6" height="10" rx=".5" /><rect x="9.8" y="3" width="2.6" height="10" rx=".5" /></g>,
  link: <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" /><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" /></g>,
  gear: <g fill="none" stroke="currentColor"><circle cx="8" cy="8" r="5.6" strokeWidth="2.2" strokeDasharray="2.2 2.2" /><circle cx="8" cy="8" r="4.1" strokeWidth="1.3" /><circle cx="8" cy="8" r="1.6" strokeWidth="1.3" /></g>,
  render: <g fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="6" width="12" height="7.5" rx="1" /><path d="m2.3 6 1.6-3.2 10 0L12.4 6M5.6 2.8 4.4 6M9.4 2.8 8.2 6" /></g>,
  note: <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.5 3h11v7.6H7.4L4.6 13v-2.4H2.5z" /><path d="M5.2 6.8h5.6" /></g>,
  undo: <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5.4 3.6 2.6 6.4l2.8 2.8" /><path d="M2.8 6.4h6.4a3.6 3.6 0 0 1 0 7.2H6.8" /></g>,
  safe: <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" /></g>,
  grid: <g fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx=".5" /><path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" /></g>,
  boxes: <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6"><rect x="2.5" y="2.5" width="11" height="11" rx=".5" /></g>,
  minus: <path d="M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  plus: <path d="M3.5 8h9M8 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  // Your good and bad moment marks (thumb up, thumb down), and clearing them.
  "mark-good": <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.5 7.2h2.4v6.3H2.5zM4.9 7.2 7.6 2.6c1 0 1.6.7 1.4 1.8l-.4 2.2h3.9c.8 0 1.3.7 1.1 1.4l-1.2 4.4c-.2.6-.7 1.1-1.3 1.1H4.9" /></g>,
  "mark-bad": <g fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.5 8.8h2.4V2.5H2.5zM4.9 8.8l2.7 4.6c1 0 1.6-.7 1.4-1.8l-.4-2.2h3.9c.8 0 1.3-.7 1.1-1.4L12.4 3.6c-.2-.6-.7-1.1-1.3-1.1H4.9" /></g>,
  close: <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  // The theme switch: the moon in the dark theme, the sun in the light one.
  moon: <path d="M13.4 9.4A5.7 5.7 0 1 1 6.6 2.6a4.5 4.5 0 0 0 6.8 6.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  sun: <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="2.7" /><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" /></g>,
};
export function Icon({ name }) {
  return <svg className="icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">{ICONS[name]}</svg>;
}

// The small marks in the log and the checks tab, drawn as lines so each is the size the mockup
// shows (about 10 px) in any font: a tick (done), a cross (failed or an error), an open ring
// (a restored turn, a little larger and orange) and a triangle (a warning). The word for each
// is next to it for screen readers, so colour and shape are never the only signal.
const MARKS = {
  done: { box: "0 0 12 10", width: 11, height: 9, draw: <path d="M1.5 5.2 4.6 8.2 10.5 1.8" fill="none" stroke="currentColor" strokeWidth="1.9" /> },
  failed: { box: "0 0 10 10", width: 9, height: 9, draw: <path d="M2 2 8 8M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" /> },
  reverted: { box: "0 0 10 10", width: 10, height: 10, draw: <path d="M6.6 1.45A3.9 3.9 0 1 1 3.4 1.45" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
  warning: { box: "0 0 10 10", width: 10, height: 9, draw: <path d="M5 1 9.5 9H0.5z" /> },
};
export function Mark({ kind, className = "" }) {
  const mark = MARKS[kind];
  return (
    <span className={`cell mark m-${kind}${className ? ` ${className}` : ""}`} aria-hidden="true">
      <svg viewBox={mark.box} width={mark.width} height={mark.height} fill="currentColor" focusable="false">{mark.draw}</svg>
    </span>
  );
}

/**
 * A drop-down choice: a button that opens a list under it (above it when there is more room
 * there). ↑ ↓ Home End move, Enter or a click picks, Esc or a click elsewhere closes, and the
 * focus goes back to the button. The list is drawn in a fixed layer on top of the dashboard,
 * so a pane's own scrolling or clipping never cuts it off; a list taller than the room it has
 * scrolls.
 */
/**
 * The stage with no video yet. Before any agent has called kino it shows the one command that
 * connects one, with a copy button; after that, that the agent's first video appears here.
 */
function FirstRun({ connected }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText("kino setup"); setCopied(true); } catch { setCopied(false); } };
  return (
    <div className="first-run">
      {connected ? null : (
        <button type="button" className="first-run-copy" onClick={copy} aria-label={copied ? "Copied kino setup" : "Copy kino setup"} title="Copy">
          <code>kino setup</code><ControlIcon name={copied ? "check" : "copy"} />
        </button>
      )}
      <p>{connected ? "No video yet. When your agent makes one, it shows up here." : "Run this in your agent's terminal. Your first video shows up here."}</p>
    </div>
  );
}

export function Menu({ id, label, ariaLabel, listLabel, title, value, options, onPick, className = "" }) {
  const [place, setPlace] = useState(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const open = Boolean(place);
  const close = (refocus) => { setPlace(null); if (refocus) buttonRef.current?.focus(); };
  // First drawn under the button and hidden; once drawn, its real height decides where it goes.
  const toggle = () => {
    if (open) { close(false); return; }
    const rect = buttonRef.current.getBoundingClientRect();
    setPlace({ left: Math.max(4, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 80) - 4)), minWidth: rect.width,
      top: rect.bottom + 2, visibility: "hidden", sized: false });
  };
  useLayoutEffect(() => {
    if (!place || place.sized || !listRef.current || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const height = listRef.current.scrollHeight + 2;
    const roomBelow = window.innerHeight - rect.bottom - 2 - MENU_EDGE;
    const roomAbove = rect.top - 2 - MENU_EDGE;
    const below = height <= roomBelow || roomBelow >= roomAbove;
    const { top, visibility, ...rest } = place;
    // Once drawn its real width is known: keep it inside the window (a menu at the right edge opens leftward).
    const width = listRef.current.offsetWidth;
    rest.left = Math.max(4, Math.min(rest.left, window.innerWidth - width - 4));
    setPlace({ ...rest, sized: true, maxHeight: Math.max(40, Math.floor(below ? roomBelow : roomAbove)),
      ...(below ? { top: rect.bottom + 2 } : { bottom: window.innerHeight - rect.top + 2 }) });
  }, [place]);
  const placed = Boolean(place?.sized);
  useEffect(() => {
    if (!placed) return undefined;
    const items = [...(listRef.current?.querySelectorAll('[role="menuitemradio"]') ?? [])];
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    const away = (event) => { if (!listRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setPlace(null); };
    // A scroll that carries the button away closes the list (it would float off on its own).
    // Other scrolling leaves it open: the log following a new call, or the frame just panned.
    const at = buttonRef.current?.getBoundingClientRect();
    const moved = (event) => {
      if (listRef.current?.contains(event.target)) return;
      const now = buttonRef.current?.getBoundingClientRect();
      if (!at || !now || Math.abs(now.left - at.left) > 1 || Math.abs(now.top - at.top) > 1) setPlace(null);
    };
    const shut = () => setPlace(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", shut);
    window.addEventListener("blur", shut);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", shut);
      window.removeEventListener("blur", shut);
    };
  }, [placed]);
  const onKeyDown = (event) => {
    // While the list is open its keys are its own: j, k, Esc … do not reach the dashboard.
    event.stopPropagation();
    const items = [...listRef.current.querySelectorAll('[role="menuitemradio"]')];
    const at = items.indexOf(document.activeElement);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (to !== undefined) { event.preventDefault(); items[(to + items.length) % items.length]?.focus(); }
    else if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") close(true);
  };
  const root = buttonRef.current?.closest(".dash") ?? (typeof document === "undefined" ? null : document.body);
  return (
    <>
      <button ref={buttonRef} id={id} type="button" className={`tb menu-button ${className}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={ariaLabel} title={title} onClick={toggle}>
        <span className="menu-value">{label}</span><Icon name="down" />
      </button>
      {open && root ? createPortal(
        <div ref={listRef} className="menu" role="menu" aria-label={listLabel ?? ariaLabel} style={menuStyle(place)} onKeyDown={onKeyDown}>
          {options.map((option) => (
            <button key={option.value} type="button" role="menuitemradio" tabIndex={-1} aria-checked={option.value === value} className="tb menu-item"
              onClick={() => { close(true); onPick(option.value); }}>{option.label}</button>
          ))}
        </div>, root) : null}
    </>
  );
}

// A menu list keeps this far from the window's top and bottom edges.
const MENU_EDGE = 6;
const menuStyle = ({ sized, ...style }) => style;

// What a person chose to open or close stays chosen on this computer. Storage can be missing
// or blocked (a private window); then the choice lasts until the page reloads.
function readStored(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return value && typeof value === "object" ? { ...fallback, ...value } : fallback; } catch { return fallback; }
}
function saveStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* kept for this page only */ }
}

// ---- [1] session ------------------------------------------------------------------------------

// A render in any other state (queued, inProgress …) is still going and can be canceled.
const RENDER_FINISHED = ["done", "canceled", "failed", "error", "gone"];

// The session sections that open and close, and how they start: open, except the brief, which
// is long (six lines with quotes) and would push the plan and the renders out of view; closed, it
// says how many lines it has and whether it is confirmed. The phone's brief and stops cards share
// it.
export const SECTIONS_KEY = "kino.dashboard.sections";
const SECTIONS = { "needs-you": true, agents: true, brief: false, stops: true, plan: true };

/**
 * Which session sections are open, kept on this computer. The dashboard holds it (not the
 * session pane) because a/d must not answer a request in a closed "needs you", and a new
 * request opens that section again.
 */
export function useSections() {
  const [open, setOpen] = useState(() => readStored(SECTIONS_KEY, SECTIONS));
  useEffect(() => saveStored(SECTIONS_KEY, open), [open]);
  return [open, setOpen];
}

/** A session section with a caret button that opens and closes it. */
function Section({ name, label, open, onToggle, count, urgent, children }) {
  return (
    <div className={`session-section${urgent ? " urgent" : ""}`}>
      <h3 className="section-head">
        <button type="button" className="tb caret-button" aria-expanded={open} aria-controls={`section-${name}`} onClick={() => onToggle(name)}>
          <ControlIcon name="chevron" className={`caret${open ? " open" : ""}`} /><span>{label}</span>{!open && count ? <span className="section-count">{count}</span> : null}
        </button>
      </h3>
      <div id={`section-${name}`} hidden={!open}>{children}</div>
    </div>
  );
}

/**
 * `onStop(round, press)` answers the waiting stop from its row ("approve") or opens its screen
 * ("open", or "redo" with the redo note focused); `onReopen(row)` and `onKeepAsking()` are the
 * stop lines' buttons (Dashboard.jsx). `onOpenProject(id)` opens the project a stop waits in when
 * it is not the open one. `onMaterial(need, answer)` answers a material question ("option N",
 * "have" or "drop").
 */
export function SessionPane({ data, still, cursor, sections: open, onSections: setOpen, onAnswer, onOpenApproval, onIdeas, onJudge, onTry, onMaterial, onStop, onReopen, onKeepAsking, onOpenProject, onCancelRender, onShare, onShares, share, onAddFiles, onExport, now, bare = false, ...pane }) {
  const fileRef = useRef(null);
  const toggle = (name) => setOpen((value) => ({ ...value, [name]: !value[name] }));
  const anyOpen = Object.keys(SECTIONS).some((name) => open[name]);
  // The waiting stop first, then the stops in other projects, then the requests.
  const needs = needsYouRows(data);
  const needId = (row) => (row.type === "stop" ? row.round.id : row.type === "elsewhere" ? `${row.projectId}/${row.round.id}` : row.type === "ideas" ? row.ideas.id : row.type === "judge" ? row.judge.id : row.type === "material" ? row.need.id : row.type === "try" ? `try-${row.round.id}` : row.approval.id);
  // An answered request or stop leaves the list and takes its focused button with it: the focus
  // goes to the next one's allow (approve) button, or to the section's caret when none is left.
  const answered = useRef(null);
  const ids = needs.map(needId).join(" ");
  useLayoutEffect(() => {
    const was = answered.current;
    if (!was || needs.some((row) => needId(row) === was.id)) return;
    answered.current = null;
    const pane = window.document.querySelector(".p-session");
    const active = window.document.activeElement;
    if (!pane || (active && active !== window.document.body && !pane.contains(active))) return;
    const allows = pane.querySelectorAll(".needs-you .allow");
    (allows[Math.min(was.index, allows.length - 1)] ?? pane.querySelector('[aria-controls="section-needs-you"]'))?.focus();
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const reply = (approval, index, decision) => { answered.current = { id: approval.id, index }; onAnswer(approval.id, decision, false); };
  const approve = (round, index) => { answered.current = { id: round.id, index }; onStop(round, "approve"); };
  // The connected agents, then the agents of this project's saved calls that are not connected now
  // (after a restart, or an agent that drives kino from the command line between calls).
  const connected = agentRows(data, now);
  const agents = [...connected, ...knownAgents(data).filter((agent) => !connected.some((row) => row.id === agent.id || row.name === agent.name))
    .map((agent) => ({ ...agent, status: "idle", offline: true }))];
  const brief = briefRows(data.agent, { layers: videoLayers(data) });
  const stops = stopRows(data);
  const plan = planRows(data.agent?.plan);
  const renders = [...(data.renders ?? [])].reverse().slice(0, 6);
  const facts = (
    <button type="button" className="tb icon-button" aria-expanded={anyOpen} onClick={() => setOpen(Object.fromEntries(Object.keys(SECTIONS).map((name) => [name, !anyOpen])))}
      aria-label={anyOpen ? "Close the needs you, agents, brief, stops and plan sections" : "Open the needs you, agents, brief, stops and plan sections"} title={anyOpen ? "Close all sections" : "Open all sections"}>
      <Icon name={anyOpen ? "up" : "down"} />
    </button>
  );
  // The agent pane's session view (agentPane.jsx): the same sections, with the open-all button
  // at the top instead of in a pane title.
  const body = (
    <>
      <Section name="needs-you" label="Needs you" open={open["needs-you"]} onToggle={toggle} count={needs.length} urgent={needs.length > 0}>
        {needs.length === 0 ? <p className="faint indent">Nothing waits for you.</p> : needs.map((row, index) => {
          // A stop in a project that is not open: open that project to see and answer it.
          if (row.type === "elsewhere") {
            const { round } = row;
            const word = STOP_WORDS[round.kind] ?? round.kind;
            return (
              <div key={needId(row)} className={`needs-you stop-row${cursor === index ? " selected" : ""}`}>
                <button type="button" className="tb row-button" onClick={() => onOpenProject(row.projectId)} aria-label={`Stop ${round.id} in ${row.name}: the ${word} waits for you. Open ${row.name} to answer it.`}>
                  <span className="grow"><strong>{capital(word)}</strong> in {row.name}</span><span className="need-id">{round.id}</span>
                </button>
                <p className="dim indent">{cut(String(round.ask ?? "").split("\n")[0], 80)}</p>
                <div className="actions">
                  <button type="button" className="ui-btn primary allow" onClick={() => onOpenProject(row.projectId)}>Open {row.name}</button>
                </div>
              </div>
            );
          }
          // Ideas an agent took from a reference: picked and allowed on the inspire screen (F3).
          if (row.type === "ideas") {
            const { ideas } = row;
            return (
              <div key={ideas.id} className={`needs-you${cursor === index ? " selected" : ""}`}>
                <button type="button" className="tb row-button" onClick={onIdeas} aria-label={`${ideas.by?.name ?? "The agent"} found ${ideas.take.length} ideas in ${ideas.title ?? ideas.ref}. Open the inspire screen to pick them.`}>
                  <span className="grow"><strong>{ideas.take.length} ideas</strong> from {cut(ideas.title ?? ideas.ref, 40)}</span><span className="need-id">{ideas.id}</span>
                </button>
                <p className="dim indent">Pick the ones to use, then allow.</p>
                <div className="actions">
                  <button type="button" className="ui-btn primary allow" onClick={onIdeas}>Pick ideas</button>
                </div>
              </div>
            );
          }
          // A judge round put off with esc: the box comes back.
          if (row.type === "judge") {
            const left = row.judge.pairs.filter((pair) => !pair.pick).length;
            return (
              <div key={row.judge.id} className={`needs-you${cursor === index ? " selected" : ""}`}>
                <button type="button" className="tb row-button" onClick={onJudge} aria-label={`Judge ${row.judge.id}: ${left} pairs left. Open it.`}>
                  <span className="grow"><strong>Which looks more finished?</strong> {left} left</span><span className="need-id">{row.judge.id}</span>
                </button>
                <div className="actions">
                  <button type="button" className="ui-btn primary allow" onClick={onJudge}>Pick</button>
                </div>
              </div>
            );
          }
          // A try round (agent/tries.mjs): opens the try options screen.
          if (row.type === "try") {
            const ready = row.round.options.filter((option) => option.ready).length;
            const state = row.round.status === "rendering" ? `Making ${ready} of ${row.round.options.length}` : `${row.round.options.length} ${row.round.sketch ? "sketches" : "options"}`;
            return (
              <div key={`try-${row.round.id}`} className={`needs-you${cursor === index ? " selected" : ""}`}>
                <button type="button" className="tb row-button" onClick={onTry} aria-label={`Try ${row.round.id}: ${row.round.question}, ${state}. Open it.`}>
                  <span className="grow"><strong>{row.round.question}</strong></span><span className="need-id">{row.round.id}</span>
                </button>
                <p className="dim indent">{state}</p>
                <div className="actions">
                  <button type="button" className="ui-btn primary allow" onClick={onTry}>{row.round.sketch ? "See the sketches" : "See the options"}</button>
                </div>
              </div>
            );
          }
          // A material question (notes needs): its options as chips, the recommended one marked.
          if (row.type === "material") {
            const { need } = row;
            const pick = (entry, value) => { answered.current = { id: entry.id, index }; onMaterial(entry, value); };
            return (
              <div key={need.id} className={`needs-you material-row${cursor === index ? " selected" : ""}`}>
                <p className="row" title={need.why}>
                  <span className="grow"><strong>{cut(need.ask, 90)}</strong></span><span className="need-id">{need.id}</span>
                </p>
                <div className="actions" role="group" aria-label={`Answer ${need.id}: ${need.ask}`}>
                  <MaterialChoices need={need} onPick={pick} className="ui-btn" recommendedClass="primary allow" />
                </div>
              </div>
            );
          }
          if (row.type === "stop") {
            const { round } = row;
            const word = STOP_WORDS[round.kind] ?? round.kind;
            return (
              <div key={round.id} className={`needs-you stop-row${cursor === index ? " selected" : ""}`}>
                <button type="button" className="tb row-button" onClick={() => onStop(round, "open")} aria-label={`Stop ${round.id}: the ${word} waits for you. Open its sheet.`}>
                  <span className="grow"><strong>{capital(word)}</strong></span><span className="need-id">{round.id}</span>
                </button>
                <p className="dim indent">{cut(String(round.ask ?? "").split("\n")[0], 80)}</p>
                <div className="actions">
                  <button type="button" className="ui-btn primary allow" onClick={() => approve(round, index)}>Approve</button>
                  <button type="button" className="ui-btn" onClick={() => onStop(round, "redo")}>Redo</button>
                </div>
              </div>
            );
          }
          const { approval } = row;
          return (
            <div key={approval.id} className={`needs-you${cursor === index ? " selected" : ""}`}>
              <button type="button" className="tb row-button" onClick={() => onOpenApproval(approval.id)} aria-label={`Approval ${approval.id}: ${approval.summary}. Open the approval card.`}>
                <span className="grow"><strong>{capital(APPROVAL_WORDS[approval.kind] ?? approval.kind)}</strong></span><span className="need-id">{approval.id}</span>
              </button>
              <p className="dim indent">{cut(approval.summary, 80)}</p>
              <div className="actions">
                <button type="button" className="ui-btn primary allow" onClick={() => reply(approval, index, "allow")}>Allow</button>
                <button type="button" className="ui-btn" onClick={() => reply(approval, index, "deny")} aria-label="Not yet (deny)">Not yet</button>
              </div>
            </div>
          );
        })}
      </Section>
      <Section name="agents" label="Agents" open={open.agents} onToggle={toggle} count={agents.length}>
        {agents.length === 0 ? <p className="faint indent">None yet. Start one on the Crew page.</p> : agents.map((agent) => (
          <p key={agent.id} className="row agent-row">
            <span className="agent-bot"><Bot color={agent.color} mood={moodOfRow(data, agent, now)} size={14} still={still} /></span>
            <span className="grow agent-words"><AgentName agent={agent} />{agent.kind && agent.kind !== agent.name ? <span className="dim">{agent.kind}</span> : null}{agent.offline ? <span className="dim">Not connected</span> : null}</span>
            <Status status={agent.status} still={still} />
          </p>
        ))}
      </Section>
      <Section name="brief" label="Brief" open={open.brief} onToggle={toggle} count={brief.short}>
        <BriefLines rows={brief} />
      </Section>
      <Section name="stops" label="Stops" open={open.stops} onToggle={toggle} count={stops.length}>
        <StopLines rows={stops} onReopen={onReopen} onKeepAsking={onKeepAsking} />
      </Section>
      <Section name="plan" label="Plan" open={open.plan} onToggle={toggle} count={plan.length}>
        {plan.length === 0 ? <p className="faint indent">No plan yet.</p> : plan.map((step, index) => (
          <p key={index} className={`row plan-step ${step.state}`}>
            <span className="plan-mark" aria-hidden="true">{step.state === "done" ? <ControlIcon name="check" /> : null}</span><span className="grow">{step.text}</span><span className="sr-only">({step.state})</span>
          </p>
        ))}
      </Section>
      <div className="session-section">
        <h3 className="section-head plain">Media</h3>
        <p className="row">
          <button type="button" className="ui-btn" title="Or drop files on the window" onClick={() => fileRef.current?.click()} disabled={!data.projectId}><ControlIcon name="plus" />Add files</button>
          <input ref={fileRef} type="file" multiple hidden aria-label="Add media files" data-testid="media-input"
            onChange={(event) => { const files = [...event.target.files]; event.target.value = ""; if (files.length) onAddFiles(files); }} />
        </p>
      </div>
      <div className="session-section">
        <h3 className="section-head plain">Renders</h3>
        <p className="row">
          <button type="button" className="ui-btn" aria-keyshortcuts="e" onClick={onExport} disabled={!data.projectId}><ControlIcon name="film" />Render</button>
          <button type="button" className="ui-btn" onClick={onShares} disabled={!data.projectId}><ControlIcon name="link" />Share</button>
        </p>
        {share ? <p className="agent" style={{ wordBreak: "break-all", whiteSpace: "normal" }}>{share}</p> : null}
        {renders.length === 0 ? <p className="faint">None yet.</p> : renders.map((job) => (
          <div key={job.id} className="row render-row">
            {/* The revision and format drop out (to a hidden second line) when the column is narrow. */}
            <span className="grow render-name" title={`${job.quality} ${job.id} r${job.rev} ${job.format}`}><span>{capital(job.quality)}</span> <span className="need-id">{job.id} r{job.rev} {job.format}</span></span>
            {job.status === "done" ? <>
              <span className="ui-chip">Done</span>
              <a href={renderFileUrl(job.id)} download className="ui-btn quiet icon-only" aria-label={`Download the ${job.quality} render ${job.id}`} title="Download"><ControlIcon name="download" /></a>
            </> : !RENDER_FINISHED.includes(job.status) ? <>
              <span className="render-bar" aria-hidden="true"><span style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></span>
              <span className="need-id">{Math.round((job.progress ?? 0) * 100)}%</span>
              <button type="button" className="ui-btn quiet icon-only" onClick={() => onCancelRender(job.id)} aria-keyshortcuts="x" title="Cancel" aria-label={`Cancel the ${job.quality} render ${job.id}`}><ControlIcon name="x" /></button>
            </> : <span className={job.status === "canceled" ? "dim" : "s-failed"}>{capital(job.status)}</span>}
          </div>
        ))}
      </div>
    </>
  );
  // The agent pane's session view (agentPane.jsx): the same sections, with the open-all button
  // at the top instead of in a pane title.
  if (bare) return <div role="tabpanel" id="panel-session" aria-labelledby="tab-session" className="p-session view-panel"><div className="session-facts">{facts}</div>{body}</div>;
  return <Pane {...pane} number={1} name="session" className="p-session" labelId="pane-1-title" facts={facts}>{body}</Pane>;
}

// ---- the time on screen while playing ---------------------------------------------------------

const noTimeStore = { subscribe: () => () => {}, get: () => 0 };

/**
 * The time to show: the time store's (Dashboard.jsx sets it once a frame) while playing, else the
 * paused time. Only components that call this redraw on every played frame.
 */
function useShownTime(timeStore, playing, time) {
  const store = timeStore ?? noTimeStore;
  const live = useSyncExternalStore(store.subscribe, store.get);
  return playing && timeStore ? live : time;
}

// ---- [2] stage --------------------------------------------------------------------------------

const RENDER_STEP = 64;
// How far one arrow key moves a zoomed frame, in screen pixels.
const PAN_STEP = 40;
// How often the live label's frames-a-second count is brought up to date.
const FPS_COUNT_MS = 500;
// The longest the stage keeps the paused frame after Play while the live picture gets ready, and
// the longest the smaller picture stays after the rays while the full-resolution one gets ready.
const START_HOLD_MS = 400;
// The longest the paused frame stays after Play while a scene's video still loads (no picture for
// its time yet). Longer than START_HOLD_MS: on a busy computer a video's first picture can take
// more than 400 ms, and the stage then showed the video blank for those frames.
const VIDEO_HOLD_MS = 1500;
// HTMLMediaElement.HAVE_CURRENT_DATA: a video has a picture for its current time.
const HAVE_CURRENT_DATA = 2;

// How far ahead the stage looks for rays about to show in a scene with a video, and in what steps
// (seconds of the scene): see `prepare` in StagePane.
const PREPARE_SECONDS = 0.5;
const PREPARE_STEP = 0.1;

/** True when every video in `videos` has a picture for its time (or could not load at all). */
const videosHavePicture = (videos) => videos.every((video) => video.error || (video.readyState >= HAVE_CURRENT_DATA && !video.seeking));

// What the live label says about the sound.
function soundWords(sound) {
  if (!sound) return "";
  if (sound.mix === "loading") return "sound loading…";
  if (sound.mix === "error") return "no sound (see below)";
  return { none: "no sound in this scene", on: "sound on", starting: "sound starting…", blocked: "sound blocked", unavailable: "no sound: this browser has no Web Audio", ready: "sound ready" }[sound.state] ?? "";
}

/**
 * True once two display frames have passed since `key` last changed (and is not null). The
 * smaller live picture waits that long out of sight; ReducedPicture says why. A null key (the
 * picture removed) starts the count over, so a picture that comes back with the same key waits too.
 */
function useSettled(key) {
  const [settledKey, setSettledKey] = useState(null);
  useEffect(() => {
    if (key == null) {
      setSettledKey(null);
      return undefined;
    }
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setSettledKey(key)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [key]);
  return key != null && settledKey === key;
}

/** Its children as they were the last time `hold` was false: React skips them while held. */
function Held({ hold, children }) {
  const last = useRef(children);
  if (!hold) last.current = children;
  return last.current;
}

/**
 * The smaller live picture of a scene with light rays on a large stage (liveResolution.js says
 * when). It is its own compositor layer (will-change: transform), always laid out `layout.width` ×
 * `layout.height` CSS pixels (about 1280×720 device pixels), and enlarged with a transform to fill
 * the stage's `stageWidth` × `stageHeight` when `shown`. When not shown it waits outside the stage
 * (which clips it), held at the last picture it showed so it costs nothing, unless `drawn`: then
 * it keeps drawing out of sight (StagePane does that just before the rays show in a scene with a
 * video, so the video is at the right time when the picture shows).
 *
 * Why it stays small: Chromium's compositor chooses how sharp to draw a will-change: transform
 * layer when the layer first appears, from its transform then, and keeps that when only the
 * transform changes later. This layer first appears moved out of sight with no enlargement, so
 * Chromium draws it at the screen's own resolution, which for this layout is about 1280×720
 * device pixels, and keeps doing so when it is enlarged, also on a resize. Measured in Chrome 2×
 * on a Mac and in the Electron the tests use: if the layer's layout size changes, or it first
 * appears already enlarged, Chromium draws it sharp (and slow) again; one frame out of sight is
 * not enough, two are. So the layout never follows the stage size (a new screen or scene shape
 * makes a new layer), and StagePane shows something else until this one has been out of sight
 * for two frames, also each time it is made again: right after Play the paused exact frame (the
 * start hold, with the stage's time held too), and after a resize the full-resolution live
 * picture. The stage shows the scene at the time it says. StagePane makes this picture only
 * while playing: one kept out of sight through a pause was painted blank for one frame when the
 * play started (seen in the Electron the tests use).
 *
 * Not chosen: drawing each frame into a fixed 1280×720 canvas, which the browser could never draw
 * sharper. A canvas takes SVG only as an image, and an SVG image cannot show the scene's videos
 * or use the page's fonts, so it would not be the export renderer's picture.
 */
function ReducedPicture({ shown, drawn = false, layout, stageWidth, stageHeight, children }) {
  const transform = shown ? `scale(${stageWidth / layout.width}, ${stageHeight / layout.height})` : "translate(-200%, 0)";
  return (
    <div className="live-picture live-layer" style={{ width: layout.width, height: layout.height, transform }}>
      <Held hold={!shown && !drawn}>{children}</Held>
    </div>
  );
}

/**
 * The stage. While playing: the scene drawn live in this window by the export's own renderer
 * (ScenePreview), with the export's own sound mix playing (Dashboard.jsx). While paused: the
 * exact frame from the export renderer (a PNG from the server), with overlays and note pins.
 */
/** A layer's name in the scene, else its id. */
function sceneLayerName(scene, id) {
  const layer = scene?.layers?.find((entry) => entry.id === id);
  return layer?.name || id;
}

/** Stops loading `image`: without a src the browser drops its request, which the server sees. */
function stopLoading(image) {
  image.onload = image.onerror = null;
  image.removeAttribute("src");
}

export function StagePane({ data, scene, time, rev, checkpoint, full, playing, fps, overlays, findings, selectedLayer, onPin, onFrameShown, timeStore, fontVersion, sound, onSoundOn, still, onToggleOutlines,
  onKey, onScene, onZoomPane, onNow, phone, onSeek, need = null, draft = null, previewList = null, soundTime = null,
  marks = [], onUnmark, onClearMarks, ...pane }) {
  const wrapRef = useRef(null);
  const labelRef = useRef(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [shown, setShown] = useState(null);
  const [failed, setFailed] = useState("");
  const loading = useRef(null);
  const [drag, setDrag] = useState(null);
  // "fit" fits the frame in the pane; a number is scene pixels to screen pixels (1 = 100%).
  const [zoom, setZoom] = useState("fit");
  // The playback clock's time, on the frame grid (the paused time while paused).
  const clockTime = useShownTime(timeStore, playing, time);
  // The preview cache (previewCache.jsx, the list from Dashboard.jsx): while a rendered segment
  // covers the stage, the live picture under it waits, drawn and paused, at the time live drawing
  // takes over again. Paused, the segment under the playhead waits loaded, so Play starts on it.
  const pick = scene && previewList ? previewPick(previewList, { projectId: data.projectId, sceneId: scene.id, rev, time: clockTime }) : NO_PICK;
  const [covered, setCovered] = useState(false);
  if (covered && !playing) setCovered(false);
  const cached = covered && Boolean(pick.show);
  const liveTime = cached ? pick.liveAt : clockTime;
  const livePlaying = playing && !cached;
  // After a pause the live picture stays until the exact frame has arrived, so the stage never
  // goes back to an older frame in between.
  const [afterPlay, setAfterPlay] = useState(false);
  const live = Boolean(scene) && (playing || afterPlay);
  // New pictures shown in the last second while playing (the live label). The time on screen is
  // checked once a display frame, so a picture counts once, and only if the window drew it: when
  // the stage draws slower than the 100 ms timer that keeps the clock moving (Dashboard.jsx
  // everyFrame), the times that timer sets in between are not counted.
  const onScreen = useRef(clockTime);
  const [measured, setMeasured] = useState(null);
  useEffect(() => {
    if (!playing) { setMeasured(null); return undefined; }
    setAfterPlay(true);
    const started = performance.now();
    const shownAt = [];
    let last = onScreen.current;
    let frame = 0;
    const check = (now) => {
      if (onScreen.current !== last) { last = onScreen.current; shownAt.push(now); }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    const timer = setInterval(() => {
      const now = performance.now();
      while (shownAt.length && now - shownAt[0] >= 1000) shownAt.shift();
      // In the first second after Play the count covers less than a second, so it is turned
      // into a rate: 15 pictures in the first half second is 30 a second.
      const span = Math.min(1000, now - started);
      // When the clock and the display drift, one second can hold one change more than the
      // frame rate, but the scene has no more than `fps` new frames a second to show.
      setMeasured(Math.min(fps, Math.round((shownAt.length * 1000) / span)));
    }, FPS_COUNT_MS);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, [playing, fps]);

  // The frame gets the pane's room less the label line that sits right under it. It is measured
  // and drawn in the same display frame (flushSync): the stage box shrinks with the pane at once
  // (its CSS max-width), so drawing the new size a frame later showed one frame of the old
  // picture cut to the smaller box (all black with light rays).
  // Only a change of the pane's own size is drawn at once. The label line is as wide as the
  // frame, so a long note in it (a failed frame's error) can wrap to another height when the
  // frame changes size; drawing that at once, inside this observer's callback, resized the label
  // again in the same display frame, and the browser stopped the loop with "ResizeObserver loop
  // completed with undelivered notifications". A change of the label alone is drawn by React's
  // next render instead, and the sizes settle over the next frames.
  useEffect(() => {
    const element = wrapRef.current;
    const label = labelRef.current;
    if (!element) return undefined;
    const measure = (entries = []) => {
      const width = element.clientWidth;
      const height = Math.max(0, element.clientHeight - (label?.offsetHeight ?? 0));
      const update = () => setBox((old) => (old.width === width && old.height === height ? old : { width, height }));
      if (entries.some((entry) => entry.target === element)) flushSync(update);
      else update();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (label) observer.observe(label);
    return () => observer.disconnect();
  }, []);

  // The stage keeps the scene's true shape inside the pane (Fit), or is drawn at a zoom and scrolls.
  const aspect = scene ? scene.width / scene.height : 16 / 9;
  const displayWidth = Math.max(0, zoom === "fit" ? Math.min(box.width, box.height * aspect) : (scene?.width ?? 0) * zoom);
  const displayHeight = displayWidth / aspect;
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const draftWidth = Math.max(RENDER_STEP, Math.min(1920, Math.ceil((displayWidth * ratio) / RENDER_STEP) * RENDER_STEP));
  const width = scene ? (full ? Math.min(1920, scene.width) : Math.min(draftWidth, Math.min(1920, scene.width))) : 0;
  const height = scene ? Math.round((width * scene.height) / scene.width) : 0;
  const frameTime = Math.round(time * fps) / fps;
  const wanted = scene && data.projectId && displayWidth > 0 ? frameUrl({ projectId: data.projectId, sceneId: scene.id, time: frameTime, width, rev }) : null;

  // Load the wanted frame; the last one stays on screen until the new one arrives. While playing
  // no frames are asked for: the live picture is drawn here.
  // The timeline's thumbnails wait while this frame loads and while playing (thumbnails.js).
  // A frame still loading when another is wanted (the stage changed size while zooming or as the
  // window was resized, the time moved, or Play began) stops loading, and the server stops drawing
  // it (dashboard-routes.mjs frame). Before, the server drew each one in full and the wanted frame
  // waited behind them for one of its two drawing workers: on Linux CI, over 15 s for the zoomed
  // stage's frame of a scene with light rays.
  useEffect(() => {
    if (loading.current && loading.current.url !== wanted) {
      stopLoading(loading.current.image);
      loading.current = null;
    }
    if (!wanted || wanted === shown || playing) { if (!loading.current) thumbnails.stage({ waiting: false }); return; }
    if (loading.current) return;
    const image = new Image();
    loading.current = { url: wanted, image };
    thumbnails.stage({ waiting: true });
    const done = () => { if (loading.current?.image === image) { loading.current = null; thumbnails.stage({ waiting: false, ready: true }); } };
    image.onload = () => { done(); setShown(wanted); setFailed(""); onFrameShown?.(wanted); };
    image.onerror = () => { done(); setFailed("This frame could not be rendered."); };
    image.src = wanted;
  }, [wanted, shown, playing, onFrameShown]);
  useEffect(() => { thumbnails.stage({ playing }); }, [playing]);
  useEffect(() => () => {
    if (loading.current) stopLoading(loading.current.image);
    loading.current = null;
    thumbnails.stage({ waiting: false });
  }, []);
  useEffect(() => {
    if (!playing && afterPlay && (wanted === shown || failed || !wanted)) setAfterPlay(false);
  }, [playing, afterPlay, wanted, shown, failed]);

  // The scene's layers as the live picture draws them (component instances expanded).
  const sceneLayers = useMemo(() => {
    if (!scene) return [];
    try { return expandComponents(data.record.document, scene.id).layers; }
    catch { return []; }
  }, [scene, data.record?.document]);
  // Under reduced motion the live picture draws short Light bursts (a glow flashing on a beat)
  // calmly; the label says so when this scene has any. The paused exact frame is the export's.
  const calmed = Boolean(still) && sceneLayers.some((layer) => calmLightAnimations(layer.animations) !== layer.animations);
  // A scene with light rays plays at a lower resolution on a large stage (liveResolution.js).
  // While such a scene plays, a smaller picture (ReducedPicture) is made out of sight and, two
  // display frames later, shows instead of the full-resolution live picture whenever rays are
  // drawn at the time on screen. The label says how many device pixels it has then.
  const heavy = useMemo(() => {
    try { return heavyLiveEffects(sceneLayers, { calmLight: Boolean(still) }); }
    catch { return []; }
  }, [sceneLayers, still]);
  const layout = live && heavy.length > 0 ? reducedLayout({ width: displayWidth * ratio, height: displayHeight * ratio, aspect, ratio }) : null;
  const layoutKey = layout ? `${layout.deviceWidth}×${layout.deviceHeight}@${ratio}` : null;
  const settled = useSettled(layoutKey);
  let heavyNow = [];
  if (layout) {
    try { heavyNow = heavyLiveEffectsAt(sceneLayers, clockTime, { calmLight: Boolean(still) }); }
    catch { heavyNow = []; }
  }
  // Rays show at this time on a stage large enough for the smaller picture.
  const needsReduced = heavyNow.length > 0;
  const reduced = settled && needsReduced;
  // The rays show now but the smaller picture is still waiting its two frames out of sight (the
  // agent just turned them on while playing): the full-resolution picture keeps its last drawing
  // until then. Drawn with the rays it took seconds a frame on a computer that draws on the CPU,
  // so the two frames took seconds too (Linux CI waited over 15 s for the smaller picture).
  const readying = playing && needsReduced && !settled;
  // With the smaller picture, the full-resolution one never shows the rays, so it does not pre-draw
  // them either (useFilterPrewarm).
  const skipPrewarm = useMemo(() => (layout ? (at) => {
    try { return heavyLiveEffectsAt(sceneLayers, at, { calmLight: Boolean(still) }).length > 0; }
    catch { return false; }
  } : undefined), [Boolean(layout), sceneLayers, still]);

  // Right after Play, the stage keeps the paused exact frame, and its time, until the live
  // picture can be drawn at once: the smaller picture has waited its two frames out of sight
  // (when rays show), and the scene's videos have a picture. Before, a large stage with light
  // rays first drew two or three full-resolution frames (about half a second each at 200%), and
  // a video showed black for a few frames while it loaded. The clock and the sound run on; the
  // stage catches up when the hold ends: after START_HOLD_MS at most for the rays, VIDEO_HOLD_MS
  // for a video still loading. Only a scene with rays or a video waits, and only when the exact
  // frame on screen is the one for the paused time.
  const exactShown = Boolean(shown) && shown === wanted && !failed;
  const hasVideo = sceneLayers.some((layer) => layer.type === "video");
  const [hold, setHold] = useState(false);
  const [holdFor, setHoldFor] = useState(playing);
  if (holdFor !== playing) {
    setHoldFor(playing);
    setHold(playing && exactShown && (needsReduced || hasVideo));
  }
  const holding = hold && playing;
  const pictureReady = useRef(false);
  pictureReady.current = !needsReduced || settled;
  useEffect(() => {
    if (!holding) return undefined;
    const began = performance.now();
    let frame = 0;
    const check = (now) => {
      const waited = now - began;
      const loaded = videosHavePicture([...(wrapRef.current?.querySelectorAll(".stage-live video") ?? [])]);
      if ((pictureReady.current || waited >= START_HOLD_MS) && (loaded || waited >= VIDEO_HOLD_MS)) setHold(false);
      else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [holding]);

  // When the smaller picture stops showing while playing (the rays' time is over, the agent turned
  // them off, or the stage got small), the full-resolution live picture is made again, and a video
  // in it has no picture for its first frame: the stage showed that video black for one frame. So
  // in a scene with a video the smaller picture stays on the stage, drawn at the clock's time, over
  // the new full-resolution picture until that one's videos have a picture (START_HOLD_MS at most).
  // Not when the rays still show but the smaller picture is made again (a new screen): that one
  // is new too, and the stage shows the full-resolution picture until it is ready, as before.
  const fullRef = useRef(null);
  const lastSmall = useRef(null);
  if (reduced) lastSmall.current = { key: layoutKey, layout, sceneId: scene?.id };
  const [handover, setHandover] = useState(null);
  const [wasReduced, setWasReduced] = useState(reduced);
  if (wasReduced !== reduced) {
    setWasReduced(reduced);
    setHandover(!reduced && playing && !needsReduced && hasVideo ? lastSmall.current : null);
  }
  const handing = handover && playing && !reduced && handover.sceneId === scene?.id && (layoutKey == null || layoutKey === handover.key) ? handover : null;
  useEffect(() => {
    if (!handing) return undefined;
    const began = performance.now();
    let frame = 0;
    const check = (now) => {
      if (videosHavePicture([...(fullRef.current?.querySelectorAll("video") ?? [])]) || now - began >= START_HOLD_MS) setHandover(null);
      else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [Boolean(handing)]);
  // The smaller picture's size and key: the current ones, or during the handover the last ones.
  const small = layout ?? handing?.layout ?? null;
  const smallKey = layoutKey ?? handing?.key ?? null;
  const smallShown = reduced || Boolean(handing);
  // In a scene with a video, the smaller picture also draws out of sight in the PREPARE_SECONDS
  // before the rays show. Held since Play, its video could lag a frame or two behind the clock
  // (it started a little later), and on the first picture with rays it then sought, so for a frame
  // it showed the video late. Drawing ahead lets that seek happen out of sight.
  let prepare = false;
  if (layout && !needsReduced && hasVideo) {
    try {
      for (let ahead = PREPARE_STEP; ahead <= PREPARE_SECONDS + 1e-6 && !prepare; ahead += PREPARE_STEP)
        prepare = heavyLiveEffectsAt(sceneLayers, clockTime + ahead, { calmLight: Boolean(still) }).length > 0;
    } catch { prepare = false; }
  }
  // The time the stage shows: the clock's, or the paused time while the hold lasts.
  const shownTime = holding ? time : clockTime;
  useLayoutEffect(() => { onScreen.current = shownTime; }, [shownTime]);

  const scale = scene ? displayWidth / scene.width : 1;
  const toScene = (event) => {
    // The stage's size as drawn now: the layout can change during a drag before displayWidth does.
    const rect = event.currentTarget.getBoundingClientRect();
    const drawn = scene && rect.width > 0 ? rect.width / scene.width : scale;
    return { x: Math.round((event.clientX - rect.left) / drawn), y: Math.round((event.clientY - rect.top) / drawn) };
  };
  const boxStyle = (area) => ({ left: area.x * scale, top: area.y * scale, width: Math.max(2, area.width * scale), height: Math.max(2, area.height * scale) });
  // The boxes drawn on this picture (the checks' findings, the agents' outlines) share one
  // animated state per layer: before, every box worked out its layer and all its groups again,
  // a fifth of the main thread while a large project played.
  const boundsCache = new Map();
  const layerBox = (layerIds) => {
    if (!scene || !layerIds?.length) return null;
    try {
      const found = layerBounds(data.record.document, scene, layerIds, shownTime, { cache: boundsCache });
      return found ? { x: found.x + scene.width / 2, y: found.y + scene.height / 2, width: found.width, height: found.height } : null;
    } catch { return null; }
  };
  const pointingArea = selectedLayer ? layerBox([selectedLayer]) : null;
  const pins = (data.agent?.notes ?? []).filter((note) => note.status !== "resolved" && note.area && (!note.sceneId || note.sceneId === scene?.id) &&
    (note.time == null || Math.abs(note.time - shownTime) < 0.75));
  // The note being written on the frame: the layer it snapped to, outlined, and its dot.
  const drafting = draft && draft.onStage && (!draft.sceneId || draft.sceneId === scene?.id) ? draft : null;
  const draftDot = drafting ? noteDot(drafting) : null;
  const dotStyle = (dot) => ({ left: dot.x * scale, top: dot.y * scale });
  const margin = scene ? Math.round(Math.min(scene.width, scene.height) * 0.05) : 0;
  // While playing, the frames a second and the smaller drawing come first: the header cuts the
  // end of a label that is wider than its room.
  // The reason the picture is drawn smaller: the heavy effects shown now, or during the handover
  // the ones the scene has (none when the agent has just turned them off).
  const smallFor = heavyNow.length ? heavyNow : heavy;
  const smallNote = smallShown ? `drawn at ${small.deviceWidth}×${small.deviceHeight}` : "";
  const liveLabel = (note) => [cached ? "cached" : "live", `${measured ?? "…"}/${fps}fps`, note, `rev ${rev}`, soundWords(sound), calmed ? "light bursts calmed (reduced motion)" : ""].filter(Boolean).join(" · ");
  const label = !scene ? "" : playing
    ? liveLabel(smallNote && `${smallNote} while playing${smallFor.length ? ` (${smallFor.join(", ")})` : ""}`)
    : `preview ${width}×${height} · ${fps}fps · ${full ? "full" : "draft"} · rev ${rev}${checkpoint ? ` · ${checkpoint} checkpoint` : ""} · exact frame`;
  // The header shows a short form of the label: playing, the smaller drawing's size without the
  // reason ("drawn at 1280×720"); paused, the frame's size, rate, quality and revision. All of
  // the label is in the stage's own name for screen readers, and in the tooltip.
  const facts = !scene ? "" : playing ? liveLabel(smallNote) : label.replace(/^preview /, "").replace(/ · exact frame$/, "");
  const scenes = data.record?.document?.scenes ?? [];
  const sceneName = scene ? cut(scene.name || scene.id, 24) : "";
  const hasMenu = Boolean(scene) && scenes.length > 1;
  const zooms = [{ value: "fit", label: "Fit" }, ...[0.25, 0.5, 1, 2].map((value) => ({ value, label: `${value * 100}%` }))];
  const zoomLabel = zooms.find((entry) => entry.value === zoom)?.label ?? "Fit";
  // A frame drawn larger than the pane scrolls: Tab reaches its box, and the arrow keys move it.
  const scrolls = Boolean(scene) && zoom !== "fit";
  const pan = (event) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step || event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollBy({ left: step[0] * PAN_STEP, top: step[1] * PAN_STEP });
  };
  // The row over the frame: the scene menu and its facts on the left, the zoom and full screen on the right.
  const toolbar = scene ? (
    <div className="stage-toolbar">
      {hasMenu ? <Menu id="scene-menu" label={sceneName} ariaLabel={`Scene: ${sceneName}`} listLabel="Scenes" title="Show another scene ({ and })"
        value={scene.id} options={scenes.map((entry) => ({ value: entry.id, label: cut(entry.name || entry.id, 24) }))} onPick={onScene} className="scene-menu" />
        : <span className="scene-name">{sceneName}</span>}
      {/* Each fact is its own word group: no dots between them. */}
      <span className="stage-label" title={label}>{String(facts).split(" · ").map((fact, index) => <span key={index}>{fact}</span>)}</span>
      {checkpoint ? <button type="button" className="tb tb-box" aria-label={`Back to now from the ${checkpoint} checkpoint (Esc)`} title="Back to now (Esc)"
        onClick={(event) => {
          // The button goes once it is pressed: the focus goes to the stage pane, not to the page.
          event.currentTarget.closest("section.pane")?.focus();
          onNow();
        }}>now</button> : null}
      <span className="toolbar-gap" />
      <Menu id="stage-zoom" label={zoomLabel.toLowerCase()} ariaLabel={`Stage zoom: ${zoomLabel}`} listLabel="Stage zoom"
        title="Zoom the frame: fit, or scene pixels at 25 to 200%" value={zoom} options={zooms} onPick={setZoom} className="zoom-menu stage-zoom" />
      {phone ? null : (
        <button type="button" className="tb icon-button" aria-pressed={Boolean(pane.zoomed)} onClick={onZoomPane}
          aria-label={pane.zoomed ? "Restore the panes" : "Fill the window with the stage"} aria-keyshortcuts={pane.zoomed ? "_" : "+"}
          title={pane.zoomed ? "Restore the panes (_ or Esc)" : "Fill the window with the stage (+)"}><Icon name={pane.zoomed ? "restore" : "expand"} /></button>
      )}
    </div>
  ) : null;
  // The scrub bar under the frame: a press or a drag sets the time; the arrow keys step 0.1 s.
  const scrub = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek?.(Math.max(0, Math.min(scene.duration, ((event.clientX - rect.left) / Math.max(1, rect.width)) * scene.duration)));
  };

  return (
    <Pane {...pane} number={1} name="stage" className={`p-stage${need ? " needs" : ""}`} labelId="pane-1-title" facts={null}
      title={null}>
      {toolbar}
      <div className="stage-well">
      {/* The frame's four corner marks (drawn only), and "▶ preview" while a render waits for you. */}
      <span className="corner tl" aria-hidden="true" /><span className="corner tr" aria-hidden="true" /><span className="corner bl" aria-hidden="true" /><span className="corner br" aria-hidden="true" />
      {need && scene ? <span className="stage-mode" aria-hidden="true">▶ preview</span> : null}
      <div className={`stage-wrap${scrolls ? " scrolls" : ""}`} ref={wrapRef} style={{ "--stage-aspect": aspect }}
        {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": `The frame at ${zoomLabel}: the arrow keys scroll it`, onKeyDown: pan } : {})}>
        <div className="stage-group" style={scene ? { width: displayWidth } : undefined}>
          {!scene ? <FirstRun connected={Boolean(data?.agents?.length)} /> : (
            <div className="stage" style={{ width: displayWidth, height: displayHeight }}
              role="img" aria-label={`${label}. Click something to write a note about it, or drag a box.`}
              onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); const at = toScene(event); setDrag({ from: at, to: at }); }}
              onPointerMove={(event) => { if (drag) setDrag({ ...drag, to: toScene(event) }); }}
              onPointerUp={(event) => {
                if (!drag) return;
                // Where the pointer was let go, not the last move React has drawn.
                const to = toScene(event);
                const x = Math.max(0, Math.min(drag.from.x, to.x)), y = Math.max(0, Math.min(drag.from.y, to.y));
                const area = { x, y, width: Math.max(1, Math.abs(to.x - drag.from.x)), height: Math.max(1, Math.abs(to.y - drag.from.y)) };
                setDrag(null);
                // A click points at the layer under it (snapNote); a drag marks a box.
                if (area.width < 4 && area.height < 4) {
                  const snap = snapNote(data.record?.document, scene, drag.from, shownTime);
                  onPin(snap.area, { layer: snap.layerId, point: snap.point });
                } else onPin(area, { point: { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) } });
              }}>
              {/* The exact frame. During the start hold it lies over the live picture that is
                  getting ready under it (the same element, so it never has to load again). */}
              {(!live || holding) && shown ? <img src={shown} alt="" draggable={false} className={holding ? "holding" : undefined} /> : null}
              {/* The live pictures follow the clock, also during the hold, so their videos play
                  on in time. The full-resolution one waits out the hold when rays show; during
                  the handover after the rays it gets ready under the smaller one. */}
              {live && !reduced && !(holding && needsReduced) ? (
                <div className="stage-live" aria-hidden="true" ref={fullRef}>
                  <div className="live-picture">
                    <Held hold={readying}>
                      <ScenePreview document={data.record.document} scene={scene} time={liveTime} design={false} playing={livePlaying} fontVersion={fontVersion} audio="external" calmLight={Boolean(still)} skipPrewarm={skipPrewarm} />
                    </Held>
                  </div>
                </div>
              ) : null}
              {small ? (
                <div className="stage-live" aria-hidden="true">
                  <ReducedPicture key={smallKey} shown={smallShown} drawn={prepare} layout={small} stageWidth={displayWidth} stageHeight={displayHeight}>
                    <ScenePreview document={data.record.document} scene={scene} time={liveTime} design={false} playing={livePlaying} fontVersion={fontVersion} audio="external" calmLight={Boolean(still)} />
                  </ReducedPicture>
                </div>
              ) : null}
              {previewList ? <PreviewVideos pick={pick} time={clockTime} soundTime={soundTime} playing={playing} onCover={setCovered} /> : null}
              <div className="overlay" aria-hidden="true">
                {overlays.grid ? <div className="grid-lines" style={{ backgroundSize: `${displayWidth / 12}px ${displayHeight / 6}px` }} /> : null}
                {overlays.safe ? <div className="safe-area" style={boxStyle({ x: margin, y: margin, width: scene.width - margin * 2, height: scene.height - margin * 2 })} /> : null}
                {overlays.findings ? findings.map((finding, index) => {
                  const area = layerBox([finding.layerId]);
                  return area ? <div key={index} className={`finding-box ${finding.severity}`} style={boxStyle(area)} title={finding.text} /> : null;
                }) : null}
                {pointingArea ? <div className="pointing-box" style={boxStyle(pointingArea)} /> : null}
                {/* A checkpoint is an older turn's frame: the agents' marks are about now. */}
                {checkpoint ? null : <StagePresence live={data.live} sceneId={scene.id} scenes={scenes} layerBox={layerBox} boxStyle={boxStyle} still={still} playing={playing} marks={overlays.marks !== false} hold={Boolean(data.hold?.on)} />}
                {pins.map((note) => (
                  <React.Fragment key={note.id}>
                    {note.area.width > 1 || note.area.height > 1 ? <div className="note-area" style={boxStyle(note.area)} /> : null}
                    <div className="note-pin" style={dotStyle(noteDot(note))} title={note.text}>{noteNumber(note.id)}</div>
                  </React.Fragment>
                ))}
                {drafting?.area && (drafting.area.width > 1 || drafting.area.height > 1) ? (
                  <div className="note-area drafting" style={boxStyle(drafting.area)}>
                    {drafting.layer ? <span className="note-layer">{sceneLayerName(scene, drafting.layer)}</span> : null}
                  </div>
                ) : null}
                {draftDot ? <div className="note-pin drafting" style={dotStyle(draftDot)} /> : null}
                {drag ? <div className="drag-box" style={boxStyle({ x: Math.min(drag.from.x, drag.to.x), y: Math.min(drag.from.y, drag.to.y), width: Math.abs(drag.to.x - drag.from.x), height: Math.abs(drag.to.y - drag.from.y) })} /> : null}
              </div>
              {!playing && wanted && wanted !== shown && !failed ? <span className="rendering" role="status">Rendering</span> : null}
            </div>
          )}
          <div ref={labelRef}>
            {failed || (scene && sound?.mix === "error") ? (
              <p className="stage-notes">
                {failed ? <span className="err" role="alert">{failed}</span> : null}
                {scene && sound?.mix === "error" ? <span className="err">{sound.error}</span> : null}
              </p>
            ) : null}
            {playing && sound?.state === "blocked" ? (
              <p className="sound-blocked" role="alert">
                <span className="warn">{sound.blocked}</span>
                <button type="button" className="tb tb-box" onClick={onSoundOn}>turn sound on</button>
              </p>
            ) : null}
          </div>
        </div>
      </div>
      {scene && !phone ? <RenderDock data={data} still={still} /> : null}
      </div>
      {scene && !phone ? <SeenDrawer data={data} still={still} playing={playing} /> : null}
      {/* The playback controls stay while something waits for you: its answers are in the agent pane. */}
      {scene ? (
        <div className="stage-transport" role="group" aria-label="Playback and view">
          <span className="transport-buttons">
            <button type="button" className="tb icon-button" onClick={() => onKey("frame-back")} aria-label="One frame back" aria-keyshortcuts="," title="One frame back (,)"><Icon name="frame-back" /></button>
            <button type="button" className="tb icon-button play-button" onClick={() => onKey("play")} aria-label={playing ? "Pause" : "Play"} aria-keyshortcuts="Space"
              title={playing ? "Pause (space)" : "Play (space)"}><Icon name={playing ? "pause" : "play"} /></button>
            <button type="button" className="tb icon-button" onClick={() => onKey("frame-forward")} aria-label="One frame forward" aria-keyshortcuts="." title="One frame forward (.)"><Icon name="frame-forward" /></button>
          </span>
          <span className="scrub" role="slider" tabIndex={0} aria-label="Scrub" aria-valuemin={0} aria-valuemax={scene.duration} aria-valuenow={Math.round(shownTime * 100) / 100}
            aria-valuetext={`${clock(shownTime)} of ${clock(scene.duration)}`}
            onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); scrub(event); }}
            onPointerMove={(event) => { if (event.buttons & 1) scrub(event); }}
            onKeyDown={(event) => {
              const step = { ArrowRight: 0.1, ArrowLeft: -0.1 }[event.key];
              if (step === undefined) return;
              event.preventDefault(); event.stopPropagation();
              onSeek?.(Math.max(0, Math.min(scene.duration, time + step)));
            }}>
            <span className="scrub-done" style={{ width: `${Math.min(100, (shownTime / Math.max(0.001, scene.duration)) * 100)}%` }} />
            {(data.agent?.notes ?? []).filter((note) => note.time != null && (!note.sceneId || note.sceneId === scene.id)).map((note) => (
              <span key={note.id} className={`scrub-note${note.status === "resolved" ? " done" : ""}`} style={{ left: `${Math.min(100, (note.time / Math.max(0.001, scene.duration)) * 100)}%` }} aria-hidden="true" />
            ))}
            {/* Your good and bad marks (reactionTrack.js): a mark made while playing spans the 3 s before the click, drawn as a band
                that lets scrub clicks through; only the tick at the click time is a button, and a click on it removes the mark. */}
            {marks.filter((mark) => mark.scene === scene.id).map((mark) => {
              const at = (value) => `${Math.min(100, (value / Math.max(0.001, scene.duration)) * 100)}%`;
              return (
                <React.Fragment key={mark.id}>
                  {mark.b > mark.a ? <span className={`scrub-mark-range ${mark.kind}`} style={{ left: at(mark.a), width: `calc(${at(mark.b)} - ${at(mark.a)})` }} aria-hidden="true" /> : null}
                  <button type="button" className={`scrub-mark ${mark.kind}`} aria-label={`Remove ${mark.kind} mark at ${mark.b} s`} title={`${mark.kind} ${mark.a === mark.b ? `${mark.b}` : `${mark.a} to ${mark.b}`} s (click removes)`}
                    style={{ left: at(mark.b) }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onUnmark?.(mark); }} />
                </React.Fragment>
              );
            })}
          </span>
          <span className="transport-marks" role="group" aria-label="Your marks">
            <button type="button" className="tb icon-button mark-chip good" onClick={() => onKey("mark-good")} aria-label="Good moment" aria-keyshortcuts="m" title="Good moment (m)"><Icon name="mark-good" /></button>
            <button type="button" className="tb icon-button mark-chip bad" onClick={() => onKey("mark-bad")} aria-label="Bad moment" aria-keyshortcuts="Shift+M" title="Bad moment (M)"><Icon name="mark-bad" /></button>
            <button type="button" className="tb icon-button mark-chip note" onClick={() => onKey("note")} aria-label="Leave a note here" aria-keyshortcuts="n" title="Leave a note at this time (n)"><Icon name="note" /></button>
            {marks.length ? <button type="button" className="tb icon-button mark-clear" onClick={() => onClearMarks?.()} aria-label="Clear my marks and viewing" title="Clear my marks and viewing"><Icon name="close" /></button> : null}
          </span>
          {/* The time under the frame (the status line has it on a phone): it says "playing" or
              "paused" to a screen reader, and its data-state says the same. */}
          <span className="transport-time"><PlayTime timeStore={timeStore} playing={playing} time={time} duration={scene.duration} /></span>
          <span className="transport-view" role="group" aria-label="On the frame">
            <button type="button" className="tb" aria-pressed={Boolean(overlays.safe)} onClick={() => onKey("safe")} aria-keyshortcuts="s" title="The safe area (s)"><Icon name="safe" />safe</button>
            <button type="button" className="tb" aria-pressed={Boolean(overlays.grid)} onClick={() => onKey("grid")} aria-keyshortcuts="g" title="The grid (g)"><Icon name="grid" />grid</button>
            {/* One switch for every box drawn on the frame: the check's findings and the agents' marks. */}
            <button type="button" className="tb boxes-button" aria-pressed={Boolean(overlays.findings || overlays.marks)} onClick={onToggleOutlines} aria-keyshortcuts="b"
              title={overlays.findings || overlays.marks ? "Hide the boxes: check findings and the agents' marks (b)" : "Show the boxes: check findings and the agents' marks (b)"}>
              <Icon name="boxes" />boxes</button>
          </span>
        </div>
      ) : null}
    </Pane>
  );
}

// ---- [3] what the agent saw ------------------------------------------------------------------

/**
 * Where a look's picture is: its scene and time, read from the call's summary ("frame S1 @0.5s
 * 480px", "zoom L3 @1.2s crop …"). A sheet, strip or compare shows many times at once, so it
 * has none. `codes` maps ids to the short names the agent uses (S1, L3).
 */
export function lookMoment(call, doc, codes = {}) {
  const match = /^(frame|zoom) (\S+) @(\d+(?:\.\d+)?)s\b/.exec(call?.summary ?? "");
  if (!match) return null;
  const [, mode, ref, at] = match;
  const id = Object.keys(codes).find((key) => codes[key] === ref) ?? ref;
  const scenes = doc?.scenes ?? [];
  const scene = mode === "frame" ? scenes.find((entry) => entry.id === id) : scenes.find((entry) => (entry.layers ?? []).some((layer) => layer.id === id));
  return { mode, time: Number(at), sceneId: scene?.id ?? null };
}

/** The kind of look a picture came from (frame, zoom, sheet, strip …), for its caption. */
export function lookMode(call) {
  let input = call?.input;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = null; } }
  if (typeof input?.mode === "string" && input.mode) return input.mode;
  return ((call?.summary ?? "").split(" ")[0] || call?.verb || "").replace(/:$/, "");
}

// The film strip's cards: every card is the same box (a 72 × 72 px picture over its caption),
// one card every CARD_PITCH px. The strip stops only at a card's left edge (CSS scroll snap, and
// a strip a whole number of cards wide), so no cut-off card shows at its left, next to ‹.
const CARD_PITCH = 92;
const STRIP_PAD = 6;
// Kept clear at the right of a selected card: the fade under › is 16 px wide.
const STRIP_FADE = 16;

/**
 * Scrolls the strip as little as it must, in whole cards, for `item` (a card's <li>) to be in
 * view and clear of the fade at the right.
 */
function keepCardInView(strip, item) {
  const left = item.offsetLeft - STRIP_PAD;
  const most = Math.max(0, strip.scrollWidth - strip.clientWidth);
  if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left);
  else if (item.offsetLeft + item.offsetWidth + STRIP_FADE > strip.scrollLeft + strip.clientWidth) {
    strip.scrollLeft = Math.min(most, Math.ceil((item.offsetLeft + item.offsetWidth + STRIP_FADE - strip.clientWidth) / CARD_PITCH) * CARD_PITCH);
  }
}

/**
 * [3] The pictures the agent looked at, as a film strip: oldest on the left, newest on the right.
 * Each says the turn it was taken in and, for a frame or a zoom, the time it shows. Picking one
 * selects it and, when it shows one moment of a scene, puts the stage there. Tab reaches the
 * selected picture only; ← → (and k j) pick the older or newer one (Dashboard.jsx).
 */
export function SeenPane({ data, cursor, enlarged, onEnlarge, onSelect, still, bare = false, ...pane }) {
  const images = seenImages(data);
  const [sizes, setSizes] = useState({});
  const stripRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  // A focus that ‹ or › hands on: the strip is already scrolling there.
  const handing = useRef(false);
  // Where the strip was scrolled to, as of its last scroll event or our own scrolling. Chromium
  // scrolls a card into view (centred) before the card's focus event, so the focus handler reads
  // the position from before that here.
  const rest = useRef(0);
  const [ends, setEnds] = useState({ start: true, end: true });
  const doc = data.record?.document;
  const codes = data.agent?.codes ?? {};
  const selected = images[cursor] ?? null;
  // The one picture Tab reaches: the selected one (the newest when none is).
  const tabStop = selected ? cursor : 0;
  const describe = (file) => {
    const size = sizes[file];
    return `${imageKind(baseName(file))}${size ? ` ${size.width}×${size.height} ~${tokens(imageTokens(size.width, size.height))} tok` : ""}`;
  };
  const measureEnds = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    rest.current = strip.scrollLeft;
    const start = strip.scrollLeft <= 1;
    const end = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
    setEnds((old) => (old.start === start && old.end === end ? old : { start, end }));
  }, []);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const observer = new ResizeObserver(measureEnds);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measureEnds, images.length > 0]);
  // The selected picture stays in view: when it changes and when new ones arrive.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const item = strip?.querySelector('[aria-current="true"]')?.closest("li");
    measureEnds();
    if (strip && item) keepCardInView(strip, item);
    measureEnds();
  }, [cursor, images.length, measureEnds]);
  // Moved with the arrow keys while a picture has the focus: the focus moves with the selection.
  useEffect(() => {
    const strip = stripRef.current;
    const active = window.document.activeElement;
    if (!strip || !active?.matches?.(".thumb") || !strip.contains(active)) return;
    const current = strip.querySelector('.thumb[aria-current="true"]');
    if (current && current !== active) current.focus();
  }, [cursor]);
  // A picture that gets the focus (by Tab, say) is brought into view as little as needed. The
  // browser has already centred it when this event comes (and drawn nothing yet), so the strip
  // goes back to where it was and moves only as far as it must, in whole cards, before the paint.
  const onCardFocus = (event) => {
    const strip = stripRef.current;
    const item = event.currentTarget.closest("li");
    if (handing.current) { handing.current = false; return; }
    if (!strip || !item) return;
    strip.scrollLeft = rest.current;
    keepCardInView(strip, item);
    rest.current = strip.scrollLeft;
  };
  // ‹ and › scroll by the whole cards in view less one. One that reaches the end is turned off
  // then, so its focus goes on to the picture at that end (or the other button), never to the page.
  const scroll = (direction) => {
    const strip = stripRef.current;
    if (!strip) return;
    const most = Math.max(0, strip.scrollWidth - strip.clientWidth);
    const cards = Math.max(1, Math.floor((strip.clientWidth - STRIP_PAD - STRIP_FADE + (CARD_PITCH - 72)) / CARD_PITCH) - 1);
    const to = Math.max(0, Math.min(most, Math.round(strip.scrollLeft / CARD_PITCH + direction * cards) * CARD_PITCH));
    const reachesEnd = direction > 0 ? to >= most - 1 : to <= 1;
    const button = direction > 0 ? rightRef.current : leftRef.current;
    if (reachesEnd && window.document.activeElement === button) {
      const thumbs = strip.querySelectorAll(".thumb");
      const next = thumbs[direction > 0 ? thumbs.length - 1 : 0] ?? (direction > 0 ? leftRef.current : rightRef.current);
      if (next?.matches(".thumb")) handing.current = true;
      next?.focus({ preventScroll: true });
    }
    strip.scrollTo({ left: to, behavior: still ? "auto" : "smooth" });
  };
  // Scrolled to an end some other way (a wheel, a resize) with the focus on that end's button.
  useEffect(() => {
    const active = window.document.activeElement;
    if (active === rightRef.current && ends.end) (leftRef.current?.disabled ? null : leftRef.current)?.focus();
    if (active === leftRef.current && ends.start) (rightRef.current?.disabled ? null : rightRef.current)?.focus();
  }, [ends]);
  const facts = selected ? (
    <>
      <span className="facts-text">{describe(selected.file)}, {selected.call.verb} {ago(selected.call.at)} ago</span>
      <button type="button" className="tb tb-box" aria-pressed={enlarged === selected.file} onClick={() => onEnlarge(enlarged === selected.file ? null : selected.file)}
        title="Show the selected picture at full size (Enter)">full size</button>
    </>
  ) : null;
  const big = enlarged ? images.find((image) => image.file === enlarged) : null;
  // The agent pane's seen view (agentPane.jsx), or a pane of its own.
  const wrap = (children) => (bare
    ? <div role="tabpanel" id="panel-seen" aria-labelledby="tab-seen" className="p-seen view-panel" aria-label="What the agent saw"><div className="seen-facts">{facts}</div>{children}</div>
    : <Pane {...pane} number={3} name="what the agent saw" className="p-seen" labelId="pane-3-title" facts={facts}>{children}</Pane>);
  return wrap(
    <>
      {images.length === 0 ? <p className="faint">no images yet: they appear when the agent calls look</p> : (
        <>
          {big ? (
            <figure className="seen-full">
              <img src={seenUrl(data.projectId, big.file)} alt={`${describe(big.file)}, from ${big.call.verb} ${ago(big.call.at)} ago`} />
              <figcaption>{describe(big.file)} <span className="faint">{big.call.verb}</span></figcaption>
            </figure>
          ) : null}
          <div className={`filmstrip${ends.end ? "" : " more-right"}`}>
            <button type="button" ref={leftRef} className="tb strip-scroll" onClick={() => scroll(-1)} disabled={ends.start} aria-label="Scroll the pictures left" title="Scroll left"><Icon name="left" /></button>
            <ul className="seen-strip" ref={stripRef} onScroll={measureEnds} aria-label="Pictures the agent saw, oldest first; ← and → pick an older or newer one">
              {images.map((image, index) => ({ ...image, index })).reverse().map(({ file, call, key, index }) => {
                const moment = lookMoment(call, doc, codes);
                const when = moment ? clock(moment.time) : lookMode(call);
                return (
                  <li key={key}>
                    <button type="button" className="thumb" aria-current={cursor === index} tabIndex={index === tabStop ? 0 : -1} onClick={() => onSelect(index, moment)} aria-keyshortcuts="ArrowLeft ArrowRight"
                      onFocus={onCardFocus} title={`${call.turn ?? call.verb} ${when}`}
                      aria-label={`${call.turn ?? call.verb} ${when}: ${describe(file)}, from ${call.verb} ${ago(call.at)} ago.${moment?.sceneId ? " Show this moment on the stage." : ""}`}>
                      <ResolveImage src={seenUrl(data.projectId, file)} alt=""
                        onLoad={(event) => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; setSizes((value) => (value[file] ? value : { ...value, [file]: { width, height } })); }} />
                      <span className="thumb-caption"><span className="thumb-turn">{call.turn ?? "·"}</span><span className="dim">{when}</span></span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" ref={rightRef} className="tb strip-scroll" onClick={() => scroll(1)} disabled={ends.end} aria-label="Scroll the pictures right" title="Scroll right"><Icon name="right" /></button>
          </div>
        </>
      )}
    </>
  );
}

// ---- [4] log · checks · notes ---------------------------------------------------------------

/**
 * A log row's mark (state.js turnRows picks the symbol): the drawing, its colour class and the
 * word screen readers hear. The orange ring marks a turn that put the project back (a history
 * restore or revert); a turn undone later keeps a tick, dimmed, and says "undone".
 */
const LOG_MARKS = {
  "✓": { kind: "done", className: "s-done", word: "done" },
  "✕": { kind: "failed", className: "s-failed", word: "failed" },
  "↻": { kind: "reverted", className: "s-reverted", word: "restored" },
  undone: { kind: "done", className: "s-undone", word: "undone" },
};

/** "13" → "@13s", 2.5 → "@2.5s": when in the scene a check found something. */
const atWords = (at) => (Number.isFinite(Number(at)) ? `@${Math.round(Number(at) * 100) / 100}s` : "");

/**
 * The 3 rules the check skipped most often: {rule, count, reason}, reason being the one given
 * most often for that rule. A waiver is the agent saying a finding is fine, so the person sees
 * how many findings and, on hover, why. Same count per rule as the stop's "39 waived (...)" line.
 */
export function topWaivers(waivedFindings) {
  const byRule = new Map();
  for (const entry of Array.isArray(waivedFindings) ? waivedFindings : []) {
    const rule = String(entry?.rule ?? "");
    if (!rule) continue;
    const group = byRule.get(rule) ?? { rule, count: 0, reasons: new Map() };
    group.count += 1;
    const reason = String(entry?.reason ?? "");
    group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
    byRule.set(rule, group);
  }
  return [...byRule.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)).slice(0, 3).map((group) => ({
    rule: group.rule,
    count: group.count,
    reason: [...group.reasons].sort((a, b) => b[1] - a[1])[0][0],
  }));
}

/**
 * The checks tab: the findings the agent gets after each revision, one line each. Only the mark
 * is coloured (✕ error, ▲ warning); the rule, the layer, the time and the message are text, and the
 * fix is in plain words (fixWords). A long line ends with "…": its tooltip has all of it, and a
 * click or Enter opens it to full length.
 */
function CheckList({ checks, onSeek, onAsk }) {
  const [asked, setAsked] = useState([]);
  const [open, setOpen] = useState([]);
  const toggle = (key) => setOpen((value) => (value.includes(key) ? value.filter((entry) => entry !== key) : [...value, key]));
  const data = checks.data;
  // An answer without findings (an error, or an older server): its lines, marked the same way.
  const rows = checks.error ? [{ severity: "error", what: "", message: checks.error, fix: "" }]
    : Array.isArray(data?.findings) ? data.findings.map((finding) => ({
      severity: finding.severity === "error" ? "error" : "warn",
      rule: String(finding.rule ?? ""),
      ref: String(finding.ref ?? ""),
      at: atWords(finding.at),
      time: Number.isFinite(Number(finding.at)) && finding.at != null && finding.at !== "" ? Number(finding.at) : null,
      message: String(finding.message ?? ""),
      fix: `${fixWords(finding.fix)}${finding.auto && finding.fix ? " (auto)" : ""}`,
    }))
      : String(checks.text ?? "").split("\n").slice(1).filter((line) => /^[EW] /.test(line)).map((line) => {
        const [message, fix = ""] = line.slice(2).split(" fix: ");
        return { severity: line.startsWith("E ") ? "error" : "warn", message, fix };
      });
  const errors = data?.errors ?? rows.filter((row) => row.severity === "error").length;
  const warnings = data?.warnings ?? rows.filter((row) => row.severity === "warn").length;
  const waivedTop = topWaivers(data?.waivedFindings);
  return (
    <>
      {checks.error ? null : (
        <p className="check-summary">
          {data?.rev != null ? `Rev ${data.rev}: ` : ""}{errors} {errors === 1 ? "error" : "errors"}, {warnings} {warnings === 1 ? "warning" : "warnings"}{data?.waived ? `, ${data.waived} waived` : ""}
        </p>
      )}
      {waivedTop.length ? (
        <p className="note-meta waived-chips" aria-label="Waived findings">
          {waivedTop.map((item) => (
            <span key={item.rule} className="note-chip c-queued" title={item.reason ? `waived: ${item.reason}` : "waived"}>
              ×{item.count} {item.rule}<span className="sr-only">{item.reason ? ` (${item.reason})` : ""}</span>
            </span>
          ))}
        </p>
      ) : null}
      <ul className="check-list" aria-label="Findings">
        {rows.map((row, index) => {
          const key = `${index} ${row.rule ?? ""} ${row.ref ?? ""}`;
          const isOpen = open.includes(key);
          const what = [row.rule, row.ref, row.at].filter(Boolean).join(" ");
          const word = row.severity === "error" ? "error" : "warning";
          return (
            <li key={key} className={isOpen ? "open" : undefined}>
              <button type="button" className="tb check-row" aria-expanded={isOpen} onClick={(event) => { const item = event.currentTarget.parentElement; toggle(key); if (!isOpen && row.time != null) onSeek?.(row.time); if (!isOpen) requestAnimationFrame(() => item.scrollIntoView({ block: "nearest" })); }}
                title={`${word}${what ? ` ${what}` : ""}: ${row.message}${row.fix ? `\nfix: ${row.fix}` : ""}`}>
                <span className="check-at">{row.time != null ? clock(row.time) : ""}</span>
                <ControlIcon name={row.severity === "error" ? "x" : "warning"} className={`check-mark ${row.severity === "error" ? "err" : "warn"}`} />
                <span className="sr-only">{word}: </span>
                <span className="check-text">
                  <span className="check-line">{row.message}</span>
                  {row.rule || row.ref ? <span className="check-line check-what">{row.rule ? <span className="check-rule">{row.rule}</span> : null}{row.ref ? <> {row.ref}</> : null}</span> : null}
                  {row.fix ? <span className="check-line check-fix"><span className="sr-only">fix: </span>{row.fix}</span> : null}
                </span>
              </button>
              {isOpen && onAsk && !checks.error ? (
                <button type="button" className="ui-btn check-ask" disabled={asked.includes(key)} onClick={() => { setAsked((value) => [...value, key]); onAsk(row); }}>
                  <ControlIcon name={asked.includes(key) ? "check" : "message"} />{asked.includes(key) ? "Asked" : "Ask to fix"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length === 0 && !checks.error ? <p className="faint check-none">Nothing found.</p> : null}
      {data?.more ? <p className="dim">+{data.more} more, not shown</p> : null}
      {/* A note says why a check did not run and how to turn it on: it wraps, so all of it shows. */}
      {(data?.notes ?? []).map((note, index) => <p key={index} className="check-note dim">{note}</p>)}
    </>
  );
}

/** Scrolls `box` as little as it must for `row` to be wholly in view. */
function keepRowInView(box, row) {
  const outer = box.getBoundingClientRect();
  const inner = row.getBoundingClientRect();
  const bottom = outer.top + box.clientHeight;
  if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
  else if (inner.bottom > bottom) box.scrollTop += Math.min(inner.bottom - bottom, inner.top - outer.top);
}

/** A note's frame, 80x45, with its numbered dot. Null for a note on the whole video. */
function NoteThumb({ data, note, scenes }) {
  const scene = scenes.find((entry) => entry.id === note?.sceneId) ?? scenes[0];
  if (note?.time == null || !scene || !data.projectId) return <span className="note-thumb" aria-hidden="true" />;
  const dot = noteDot(note);
  const src = frameUrl({ projectId: data.projectId, sceneId: scene.id, time: note.time, width: 160, rev: data.record?.revision, low: true });
  return (
    <span className="note-thumb" aria-hidden="true">
      <img src={src} alt="" loading="lazy" draggable={false} />
      {dot ? <span className="note-dot" style={{ left: `${(dot.x / scene.width) * 100}%`, top: `${(dot.y / scene.height) * 100}%` }}>{noteNumber(note.id)}</span> : null}
    </span>
  );
}

/** A folded group under the cards ("▸ 3 always"): a button that opens its list. */
function NoteFold({ id, count, word, open, onToggle, children }) {
  if (!count) return null;
  return (
    <div className={`note-fold-group f-${word}`}>
      <button type="button" className="tb note-fold-row" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="note-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> {count} {word}
      </button>
      {open ? <ul id={id} className="note-folded">{children}</ul> : null}
    </div>
  );
}

/**
 * What the material lacks (notes needs), above the notes: the agent's question, then its options
 * as buttons (the recommended one first, starred; the cost on hover), "I have it" and "do
 * without". An answered need shows one chip until the agent finishes it.
 */
export function NeedRows({ needs, act }) {
  if (!needs?.length) return null;
  return (
    <ol className="note-cards need-rows" aria-label="Needs">
      {needs.map((need) => {
        const options = (need.options ?? []).map((option, index) => ({ ...option, label: optionLabel(option), n: index + 1 }))
          .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
        const answer = (value, words) => act({ action: "needs", id: need.id, answer: value }, words);
        return (
          <li key={need.id} className={`note-card need s-${need.status}`}>
            <div className="note-body">
              <p className="note-text"><span className="sr-only">{need.id}: </span>{need.ask}</p>
              {need.status === "open" ? (
                <p className="note-actions">
                  {options.map((option) => (
                    <button key={option.n} type="button" className={`tb ${option.recommended ? "note-yes" : "tb-box"}`} title={option.cost}
                      onClick={() => answer(`option ${option.n}`, `${need.id}: ${option.label}.`)}>
                      {option.recommended ? <><span aria-hidden="true">★ </span><span className="sr-only">recommended: </span></> : null}{option.label}
                    </button>
                  ))}
                  <button type="button" className="tb tb-box" onClick={() => answer("have", `${need.id}: you have it.`)}>I have it</button>
                  <button type="button" className="tb tb-box" onClick={() => answer("drop", `${need.id}: do without.`)}>do without</button>
                </p>
              ) : (
                <p className="note-meta"><span className="note-chip c-working">{need.status === "waiting" ? "you have it" : need.answer?.plan ?? options.find((option) => option.n === need.answer?.option)?.label ?? "planned"}</span></p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The notes view, top to bottom: the stopped edits (red), the open notes as cards (newest
 * first: its frame, its words, the time and one chip; a fixed note shows the agent's reply and
 * asks "Looks good" or "Not yet"), then "N always" and "N done", folded. `notes` are noteRows
 * (newest first); `cursor` picks one of noteCursorRows; `onNote(payload, words)` sends a notes
 * action and says `words`.
 */
function NoteThread({ data, notes, cursor, now, onNote }) {
  const agentName = shownAgent(data, now)?.name ?? "the agent";
  const scenes = data.record?.document?.scenes ?? [];
  const [shown, setShown] = useState({ always: false, done: false });
  const groups = noteGroups(notes, data.agent?.stopped ?? []);
  const rows = noteCursorRows(groups);
  const picked = cursor >= 0 ? rows[cursor]?.id : null;
  const act = (payload, words) => onNote?.(payload, words);
  const layerName = (id) => scenes.flatMap((scene) => scene.layers ?? []).find((layer) => layer.id === id)?.name ?? id;
  const lastReply = (note) => note.replies?.filter((reply) => reply.from === "agent").at(-1) ?? null;
  const toggle = (part) => setShown((value) => ({ ...value, [part]: !value[part] }));
  const needs = data.agent?.needs ?? [];
  if (!rows.length && !groups.always.length && !groups.done.length && !needs.length) return <p className="faint note-empty">no notes yet</p>;
  return (
    <div className="note-view">
      <NeedRows needs={needs} act={act} />
      {rows.length ? (
        <ol className="note-cards" aria-label="Notes">
          {groups.stopped.map((item) => {
            const note = notes.find((entry) => entry.id === item.noteId);
            const names = (item.layers ?? []).map(layerName).join(", ") || "it";
            const who = item.agent ?? agentName;
            return (
              <li key={item.id} className={`note-card stopped${picked === item.id ? " selected" : ""}`}>
                <NoteThumb data={data} note={note} scenes={scenes} />
                <div className="note-body">
                  <p className="note-text">{who} tried to {item.summary || `delete ${names}`}</p>
                  <p className="note-meta">
                    {note ? <span className="note-why">always: {note.text}</span> : null}
                    <span className="note-chip c-stopped"><span aria-hidden="true">■</span>stopped</span>
                  </p>
                  <p className="note-actions">
                    <button type="button" className="tb note-yes" onClick={() => act({ action: "stopped", id: item.id, answer: "keep" }, `Kept ${names}.`)}>Keep it</button>
                    <button type="button" className="tb tb-box" onClick={() => act({ action: "stopped", id: item.id, answer: "let" }, `${who} may remove ${names}.`)}>Let {who}</button>
                  </p>
                </div>
              </li>
            );
          })}
          {groups.open.map((note) => {
            const status = noteStatus(note);
            const reply = status.kind === "fixed" ? lastReply(note) : null;
            return (
              <li key={note.id} className={`note-card s-${status.kind}${picked === note.id ? " selected" : ""}`}>
                <NoteThumb data={data} note={note} scenes={scenes} />
                <div className="note-body">
                  <p className="note-text"><span className="sr-only">{note.id}: </span>{note.text}</p>
                  <p className="note-meta">
                    <span>{note.time != null ? minutes(note.time) : "whole video"}</span>
                    {note.urgent ? <span className="note-urgent">urgent</span> : null}
                    <span className={`note-chip c-${status.kind}`}><span aria-hidden="true">{status.mark}</span>{status.words}</span>
                    <button type="button" role="switch" aria-checked={Boolean(note.always)} className={`tb note-always${note.always ? " on" : ""}`}
                      aria-label={`${note.id} always`} onClick={() => act({ action: "always", id: note.id, on: !note.always }, `${note.id} always ${note.always ? "off" : "on"}.`)}>always</button>
                  </p>
                  {reply ? <p className="note-reply" title={reply.text}><span className="note-reply-who">{agentName}</span> {reply.text}</p> : null}
                  {status.kind === "fixed" ? (
                    <p className="note-actions">
                      <button type="button" className="tb note-yes" aria-keyshortcuts={picked === note.id ? "Enter" : undefined} onClick={() => act({ action: "resolve", id: note.id }, `${note.id} done.`)}>✓ Looks good</button>
                      <button type="button" className="tb tb-box" onClick={() => act({ action: "reopen", id: note.id }, `${note.id} sent back to ${agentName}.`)}>Not yet</button>
                    </p>
                  ) : (
                    <p className="note-actions">
                      <button type="button" className="tb tb-box" aria-label={`${note.id} done`} onClick={() => act({ action: "resolve", id: note.id }, `${note.id} done.`)}>✓ done</button>
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      <NoteFold id="notes-always" count={groups.always.length} word="always" open={shown.always} onToggle={() => toggle("always")}>
        {groups.always.map((note) => (
          <li key={note.id} className="note-line">
            <span className="note-line-text">{note.text}</span>
            <button type="button" role="switch" aria-checked={Boolean(note.always)} aria-label={`${note.id} always`} className={`note-switch${note.always ? " on" : ""}`}
              onClick={() => act({ action: "always", id: note.id, on: !note.always }, `${note.id} always ${note.always ? "off" : "on"}.`)}><span aria-hidden="true" /></button>
          </li>
        ))}
      </NoteFold>
      <NoteFold id="notes-done" count={groups.done.length} word="done" open={shown.done} onToggle={() => toggle("done")}>
        {groups.done.map((note) => {
          const reply = lastReply(note);
          return (
            <li key={note.id} className="note-line done">
              <span className="note-check" aria-hidden="true">✓</span>
              <span className="note-line-text">{note.text}{reply ? <> <span aria-hidden="true">→</span><span className="sr-only">, {agentName}:</span> {reply.text}</> : null}</span>
            </li>
          );
        })}
      </NoteFold>
    </div>
  );
}

export function LogPane({ data, tab, onTab, cursor, expanded, onToggle, onTurn, onReview, filter, onFilter, filterOpen, checks, onCompose, composer, onForwardComment, onNote, onSeek, still, now, bare = false, ...pane }) {
  const turns = useMemo(() => turnRows(data, now), [data, now]);
  const shown = filter ? turns.filter((row) => `${row.id} ${row.summary} ${row.calls.map((call) => `${call.verb} ${callSummary(call)} ${call.summary}`).join(" ")}`.toLowerCase().includes(filter.toLowerCase())) : turns;
  // Turns that were already there when the log opened; a newer one slides in once (dashboard.css).
  const firstTurns = useRef(null);
  if (firstTurns.current === null) firstTurns.current = new Set(turns.map((row) => row.id));
  const notes = noteRows(data);
  const comments = commentRows(data);
  // The log box shows the newest turns (at the bottom) and follows new ones while it is scrolled
  // to its end, as it is when the tab opens; scrolled up by hand, it stays where it was, also
  // when a new turn comes. The row picked with j and k (or ↑ ↓) is brought into view, as little
  // as needed, when the pick or the filter changes (or the tab opens), not when other rows come.
  const logRef = useRef(null);
  const follow = useRef(true);
  const shownPick = useRef(null);
  const atEnd = (box) => box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  const pick = `${cursor >= 0 ? turns[cursor]?.id ?? "" : ""} ${filter ?? ""}`;
  useLayoutEffect(() => { if (tab === "log") follow.current = true; }, [tab]);
  useLayoutEffect(() => {
    const box = logRef.current;
    if (!box) { shownPick.current = null; return; }
    if (follow.current) box.scrollTop = box.scrollHeight;
    if (shownPick.current !== pick) {
      shownPick.current = pick;
      const row = box.querySelector(".log-row.selected");
      if (row) keepRowInView(box, row);
    }
    follow.current = atEnd(box);
  }, [tab, turns.length, shown.length, pick]);
  // A shorter window keeps the newest turn in view too.
  useEffect(() => {
    const box = logRef.current;
    if (!box) return undefined;
    const observer = new ResizeObserver(() => { if (follow.current) box.scrollTop = box.scrollHeight; });
    observer.observe(box);
    return () => observer.disconnect();
  }, [tab]);
  const panel = (
    <>
      {tab === "log" ? (
        <div role="tabpanel" id="panel-log" aria-labelledby="tab-log" ref={logRef} onScroll={(event) => { follow.current = atEnd(event.currentTarget); }}>
          {filterOpen || filter ? <p className="filter-line"><label htmlFor="log-filter">/</label><input id="log-filter" value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="filter the log" autoComplete="off" /></p> : null}
          <ol role="log" aria-label="Agent turns" aria-live="polite">
            {shown.length === 0 ? <li className="faint">{filter ? "nothing matches" : "no agent calls yet"}</li> : shown.map((row) => {
              const index = turns.indexOf(row);
              const open = expanded.includes(row.id);
              return (
                <li key={row.id} className={firstTurns.current.has(row.id) ? undefined : "log-new"}>
                  <button type="button" className={`tb log-row${cursor === index ? " selected" : ""}`} aria-expanded={open} onClick={() => { onToggle(row.id); onTurn(row.id); }}>
                    <span className="agent">{row.id}</span>
                    {row.symbol === "spinner" ? <Spinner still={still} /> : <Mark kind={LOG_MARKS[row.symbol]?.kind ?? "done"} className={LOG_MARKS[row.symbol]?.className ?? "s-done"} />}
                    <span className="sr-only">{row.symbol === "spinner" ? "working" : LOG_MARKS[row.symbol]?.word ?? "done"}</span>
                    <span className="grow">{row.summary}{row.ops ? ` +${row.ops} ops` : ""}</span>
                    <span className="dim tokens">{row.tokens}</span>
                  </button>
                  {open ? <ul>{row.calls.map((call, callIndex) => (
                    <li key={callIndex} className="log-call">
                      <span className="faint">{call.at ? timeOfDay(call.at) : ""}</span>
                      <span className={`cell ${call.isError ? "s-failed" : call.held ? "warn" : call.approval ? "s-needs-you" : ""}`} aria-hidden="true">{call.isError ? "✕" : call.held ? "‖" : call.approval ? "◉" : "▸"}</span>
                      {call.isError || call.held || call.approval ? <span className="sr-only">{call.isError ? "failed" : call.held ? "held" : "needs approval"}</span> : null}
                      <AgentName agent={callAgent(call)} className="log-agent" />
                      <span className="grow" title={call.summary}>{callLine(call)}</span>
                      <span className="faint">{tokens((call.tokens ?? 0) + (call.inTokens ?? 0))}</span>
                    </li>
                  ))}{row.revs ? <li className="dim">receipt rev {row.revs[0]}→{row.revs[1]}</li> : null}
                    <li><button type="button" className="tb" onClick={() => onReview(row.id)}>review {row.id}: before and after</button></li></ul> : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : tab === "checks" ? (
        <div role="tabpanel" id="panel-checks" aria-labelledby="tab-checks">
          {!checks ? <p className="faint">Checking</p> : <CheckList checks={checks} onSeek={onSeek} onAsk={(row) => onNote?.({ action: "add", text: `Fix this check finding: ${row.message}${row.rule ? ` (${[row.rule, row.ref].filter(Boolean).join(" ")})` : ""}`, ...(row.time != null ? { t: row.time } : {}) }, "Asked. The agent gets it with its next call.")} />}
        </div>
      ) : (
        <div role="tabpanel" id="panel-notes" aria-labelledby="tab-notes">
          {composer}
          {/* A phone has no stage to click: it starts a note here. */}
          {composer || !onCompose || bare ? null : <p><button type="button" className="tb tb-box" onClick={onCompose}>[<span className="key">c</span>] new note at {clock(pane.time ?? 0)}</button></p>}
          <NoteThread data={data} notes={notes} cursor={cursor} now={now} onNote={onNote} />
          {/* Comments people left in the viewer through a comment or edit link. Read only here;
              "send to agent" turns one into a note. */}
          {comments.length ? <p className="section-label" id="share-comments-title">comments from share links ({comments.length})</p> : null}
          {comments.length ? <ul aria-labelledby="share-comments-title" className="share-comments">{comments.map(({ comment, replies, scene }) => (
            <li key={comment.id} className="note-item">
              <p className="row">
                <span className="key">{comment.author || "Guest"}</span>
                <span className={comment.resolved ? "s-done" : "dim"}><span aria-hidden="true">{comment.resolved ? "●" : "○"}</span> {comment.resolved ? "resolved" : "open"}</span>
                {scene ? <span className="dim">{cut(scene, 24)}</span> : null}
                {comment.time != null ? <span className="dim">@{clock(comment.time)}</span> : null}
                <span className="faint">{ago(comment.createdAt, now)} ago</span>
              </p>
              <p>{comment.text}</p>
              {replies.map((reply) => <p key={reply.id} className="dim">{reply.author || "Guest"}: {reply.text}</p>)}
              {onForwardComment ? <p><button type="button" className="tb" onClick={() => onForwardComment({ comment, replies, scene })} aria-label={`Send ${comment.author || "Guest"}'s comment to the agent as a note`}>send to agent</button></p> : null}
            </li>
          ))}</ul> : null}
        </div>
      )}
    </>
  );
  // The agent pane's log, checks and notes views (agentPane.jsx draws the tabs).
  if (bare) return <div className="p-log view-panel">{panel}</div>;
  return (
    <Pane {...pane} number={4} className="p-log" labelId="pane-4-title"
      name={<>{["log", "checks", "notes"].map((name, index) => <React.Fragment key={name}>{index ? " – " : ""}<span className={tab === name ? "on" : undefined}>{name}</span></React.Fragment>)}</>}>
      <div className="tabs" role="tablist" aria-label="Log, checks and notes">
        {["log", "checks", "notes"].map((name) => (
          <button key={name} type="button" role="tab" id={`tab-${name}`} aria-controls={`panel-${name}`} aria-selected={tab === name} className="tb" onClick={() => onTab(name)}>{name}{name === "notes" && notesForYou(notes, data.agent?.stopped) ? " ○" : ""}</button>
        ))}
      </div>
      {panel}
    </Pane>
  );
}

// ---- [5] timeline -------------------------------------------------------------------------------

// The timeline's zoom levels: 1 fits the scene in the pane, 2 is twice as wide, and so on.
const TIMELINE_ZOOMS = [1, 2, 4, 8, 16, 32];

// The playhead. It reads the played time itself, so only the playheads redraw on each played
// frame, not the whole timeline. `marker` adds the small triangle on the ruler.
function Playhead({ timeStore, playing, time, duration, marker }) {
  const shown = useShownTime(timeStore, playing, time);
  return (
    <span className="playhead" style={{ left: `${Math.min(100, Math.max(0, (shown / duration) * 100))}%` }}>
      {marker ? <span className="playhead-marker" /> : null}
      {/* The time on the ruler, in a small orange box over the playhead ("01:31"). It slides from
          the playhead's right at the start to its left at the end, so it is never cut off. */}
      {marker ? <span className="playhead-time" aria-hidden="true" style={{ "--at": Math.min(1, Math.max(0, shown / duration)) }}>{duration < 60 ? `${(Math.floor(shown * 10) / 10).toFixed(1)}s` : minutes(shown)}</span> : null}
    </span>
  );
}

// The timeline's fixed rows, in px: the ruler, the story row and the "layers" heading. The lanes
// between them are lanes.jsx's (LANE_PX); the layer rows under them are 14.6 px each.
const RULER_PX = 30;
const STORY_PX = 18;
const LAYERS_HEAD_PX = 16;
// As the strip under the stage: a thin row for the marks over the shots, then the shots.
const STRIP_RULER_PX = 16;

/**
 * [3] The timeline: the ruler, the story row, the lanes (shots, voice, sounds, agents) and a row
 * per layer. `needAgent` is the agent a "needs you" row waits for (null: none named), or
 * undefined when nothing waits: then the range that wait is about is outlined.
 */
export function TimelinePane({ data, scene, time, cursor, selectedLayer, onSeek, onSelectLayer, onTurn, viewTurn, playing, timeStore, point = null, onPoint, still, now, needAgent, previewList = null, rev = null, strip = false, onStrip = null, ...pane }) {
  const rows = timelineRows(scene);
  const duration = Math.max(0.01, Number(scene?.duration) || 0.01);
  const scrollRef = useRef(null);
  const labelRef = useRef(null);
  const zoomOutRef = useRef(null);
  const zoomInRef = useRef(null);
  // A click on the ruler sets the time; that is in view already, so the lanes do not scroll for it.
  const clicked = useRef(false);
  // The scroll box's width, the name column's and the room kept at the right end, in px: the
  // tracks get the rest, times the zoom.
  const [room, setRoom] = useState({ width: 0, label: 0, end: 0 });
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      const label = labelRef.current?.offsetWidth ?? 0;
      const end = labelRef.current?.parentElement ? parseFloat(getComputedStyle(labelRef.current.parentElement).paddingRight) || 0 : 0;
      setRoom((old) => (old.width === width && old.label === label && old.end === end ? old : { width, label, end }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [Boolean(scene), strip]);
  const visible = Math.max(0, room.width - room.label - room.end);
  const trackWidth = visible * zoom;
  // After a zoom the playhead is in the middle of the tracks (the browser keeps the scroll in range).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !visible) return;
    const from = playing && timeStore ? timeStore.get() : time;
    element.scrollLeft = Math.max(0, (from / duration) * trackWidth - visible / 2);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zoomed in, a new width (the window was resized) moves the playhead on the tracks: when that
  // puts it out of view, the lanes scroll to bring it to the middle.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !visible || zoom === 1) return;
    const at = ((playing && timeStore ? timeStore.get() : time) / duration) * trackWidth;
    if (at < element.scrollLeft || at > element.scrollLeft + visible) element.scrollLeft = Math.max(0, at - visible / 2);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zoomed in, the lanes follow the playhead: after a seek, a frame step or a picked picture puts
  // it out of view, they scroll to bring it to the middle.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (clicked.current) { clicked.current = false; return; }
    if (!element || !visible || zoom === 1) return;
    const at = (time / duration) * trackWidth;
    if (at < element.scrollLeft || at > element.scrollLeft + visible) element.scrollLeft = Math.max(0, at - visible / 2);
  }, [time, scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const percent = (seconds) => `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`;
  const seek = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    clicked.current = true;
    requestAnimationFrame(() => { clicked.current = false; });
    onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  };
  // Pointing at a time range (read only: it tells the agent, it edits nothing). A press on the
  // ruler that moves 4 px or more (DRAG_PX) draws a range; a shorter one sets the time, as before.
  const press = useRef(null);
  const dragged = useRef(false);
  const [draft, setDraft] = useState(null);
  const pressAt = (event) => {
    const start = press.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!dragged.current) return dragPoint(start.x, event.clientX, rect.left, rect.width, duration);
    return { anchor: rulerSeconds(start.x, rect.left, rect.width, duration), end: rulerSeconds(event.clientX, rect.left, rect.width, duration) };
  };
  const rulerPointer = {
    onPointerDown: (event) => {
      dragged.current = false;
      if (event.button !== 0) return;
      press.current = { x: event.clientX, id: event.pointerId };
    },
    onPointerMove: (event) => {
      if (press.current?.id !== event.pointerId) return;
      // The button was let go outside the ruler (before the drag captured the pointer): the press
      // is over, so a hover draws nothing.
      if (!(event.buttons & 1)) { press.current = null; dragged.current = false; setDraft(null); return; }
      const next = pressAt(event);
      if (!next) return;
      if (!dragged.current) {
        dragged.current = true;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the drag still works inside the ruler */ }
      }
      setDraft(next);
    },
    onPointerUp: (event) => {
      if (press.current?.id !== event.pointerId) return;
      const next = dragged.current ? pressAt(event) : null;
      press.current = null;
      setDraft(null);
      if (!next) return;
      onPoint?.(pointRange(next) ? next : null);
    },
    onPointerCancel: () => { press.current = null; dragged.current = false; setDraft(null); },
  };
  const shownPoint = draft ?? point;
  const range = pointRange(shownPoint);
  const rangeStyle = range ? { left: percent(range[0]), width: `calc(${percent(range[1])} - ${percent(range[0])})` } : null;
  const building = buildingIds(data.live, scene?.id, serverNow(data.live, now));
  const line = pointingLine(data.pointing);
  // The cue marks: all of them while they have room, else fewer (a song's beats and onsets can
  // number a thousand), never closer than 6 px.
  const cues = rulerCues(data.record?.document?.cues, { duration, width: trackWidth || 800 });
  const layer = selectedLayer ? scene?.layers.find((entry) => entry.id === selectedLayer) : null;
  // A scene can last ten minutes: Page Up and Page Down move a twelfth of it (a second in a
  // scene under 12 s), Home and End go to the start and the end.
  const pages = Math.min(12, Math.max(1, Math.floor(duration)));
  const ruler = rulerTicks(duration, trackWidth || 800);
  const zoomName = (value) => (value === 1 ? "fit" : `${value}×`);
  // What changed since you last looked (▾ on the ruler), who changed each layer last (the hover
  // card), and the video's parts (the story row). See timeline.jsx.
  const changes = useTimelineChanges({ data, scene, still });
  // Each layer, and when it is on screen, by id (worked out again only when the scene changes).
  const layers = useMemo(() => new Map((scene?.layers ?? []).map((entry) => [entry.id, { layer: entry, ranges: onScreenRanges(entry, duration) }])), [scene, duration]);
  const layerOf = (id) => layers.get(id)?.layer;
  const rangesOf = (id) => layers.get(id)?.ranges ?? [];
  const spanOf = (id) => { const ranges = rangesOf(id); return ranges.length ? [ranges[0][0], ranges.at(-1)[1]] : null; };
  const startOf = (id) => spanOf(id)?.[0] ?? null;
  // Marks closer than 8 px on the track are one mark.
  const markGap = (8 / Math.max(1, trackWidth || 800)) * duration;
  const marks = newMarks([...changes.newIds].map(startOf), markGap);
  const leavingMarks = changes.leaving ? newMarks([...changes.leaving].map(startOf), markGap) : [];
  const newCount = [...changes.newIds].filter((id) => layerOf(id)).length;
  const parts = scene ? storyParts(data.record?.document, scene.id, duration) : [];
  // The lane under the pointer, or the focused layer's: {id, x, y} in window px.
  const [hover, setHover] = useState(null);
  const hoverLayer = hover ? layerOf(hover.id) : null;
  const card = hoverLayer ? hoverLines({ name: hoverLayer.name || hoverLayer.id, span: spanOf(hover.id), duration,
    change: changes.last[hover.id] ?? null, isNew: changes.newIds.has(hover.id), now: serverNow(data.live, now) }) : null;
  const hoverTrack = (id) => ({
    onPointerMove: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (hover?.id !== id || Math.abs(hover.x - event.clientX) > 2) setHover({ id, x: event.clientX, y: rect.top });
    },
    onPointerLeave: () => setHover(null),
  });
  const focusRow = (id) => (event) => {
    const track = event.currentTarget.nextElementSibling?.getBoundingClientRect();
    if (!track) return;
    const start = startOf(id) ?? 0;
    setHover({ id, x: track.left + (start / duration) * track.width, y: track.top });
  };
  // − and + step through the zoom levels. The one that reaches the last level in its direction is
  // turned off then, so its focus goes to the other one, not to the page.
  const step = (direction) => {
    const next = TIMELINE_ZOOMS[Math.max(0, Math.min(TIMELINE_ZOOMS.length - 1, TIMELINE_ZOOMS.indexOf(zoom) + direction))];
    const last = direction > 0 ? TIMELINE_ZOOMS.at(-1) : TIMELINE_ZOOMS[0];
    const [own, other] = direction > 0 ? [zoomInRef, zoomOutRef] : [zoomOutRef, zoomInRef];
    if (next === last && window.document.activeElement === own.current) other.current?.focus();
    setZoom(next);
  };
  // The lanes between the story row and the layers (lanes.jsx), and the grid rows they take.
  const lanes = useLanes({ data, scene, duration, entries: changes.entries ?? [], spanOf, strip });
  const rulerPx = strip ? STRIP_RULER_PX : RULER_PX;
  // The strip has no story row and no layer rows.
  const story = parts.length > 0 && !strip;
  const headRows = [rulerPx, ...(story ? [STORY_PX] : []), ...lanes.rows.map((row) => row.height), ...(strip ? [] : [LAYERS_HEAD_PX])];
  const headPx = headRows.reduce((sum, value) => sum + value, 0);
  const need = needAgent !== undefined && scene ? needRange(lanes.agents, needAgent, duration) : null;
  const facts = scene ? (<>
    {need ? <span className="tl-need-words">{need.text}</span> : <NewButton count={newCount} onSeen={changes.markSeen} />}
    <span className="zoom-group" role="group" aria-label="Timeline zoom">
      <button type="button" ref={zoomOutRef} className="tb zoom-step" onClick={() => step(-1)} disabled={zoom === TIMELINE_ZOOMS[0]} aria-label="Zoom the timeline out" title="Zoom out"><Icon name="minus" /></button>
      <button type="button" ref={zoomInRef} className="tb zoom-step" onClick={() => step(1)} disabled={zoom === TIMELINE_ZOOMS.at(-1)} aria-label="Zoom the timeline in" title="Zoom in"><Icon name="plus" /></button>
      <Menu id="timeline-zoom" label={zoomName(zoom)} ariaLabel={`Timeline zoom: ${zoomName(zoom)}`} listLabel="Timeline zoom" title="Timeline zoom: Fit shows the whole scene"
        value={zoom} options={TIMELINE_ZOOMS.map((value) => ({ value, label: zoomName(value) }))} onPick={setZoom} className="zoom-menu" />
    </span>
  </>) : null;
  return (
    <Pane {...pane} number={3} name="timeline" className={`p-timeline${strip ? " strip" : ""}`} labelId="pane-3-title" facts={facts}>
      {/* The strip opens to the whole timeline (every lane and layer) and closes again. */}
      {onStrip && scene ? (
        <button type="button" className="tb icon-button strip-toggle" aria-pressed={!strip} onClick={() => onStrip(!strip)}
          aria-label={strip ? "Show every lane and layer" : "Back to the shot strip"} title={strip ? "Show every lane and layer" : "Back to the shot strip"}><Icon name={strip ? "up" : "down"} /></button>
      ) : null}
      {!scene ? <p className="tl-none"><span className="sr-only">No video yet.</span></p> : (
        <div className={`tl-scroll${zoom > 1 ? " wide" : ""}${story ? " has-story" : ""}`} ref={scrollRef} style={{ "--tl-head": `${headPx}px` }}>
          <div className="tl-content" style={{ ...(trackWidth ? { "--tl-track": `${trackWidth}px` } : {}), gridTemplateRows: headRows.map((value) => `${value}px`).join(" ") }}>
            <span className="tl-label tl-corner" ref={labelRef} aria-hidden="true" />
            <div className="track ruler" {...rulerPointer} onClick={(event) => { if (dragged.current) { dragged.current = false; return; } seek(event); }}
              role="slider" tabIndex={0} aria-label="Playhead" aria-keyshortcuts="Shift+ArrowRight Shift+ArrowLeft" aria-describedby={line ? "pointing-line" : undefined} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(time * 100) / 100}
              aria-valuetext={`${clock(time)} of ${clock(duration)}${playing ? ", playing" : ""}${range ? `, pointing ${rangeText(range)}` : ""}`}
              onKeyDown={(event) => {
                // Esc first lets go of a range still being drawn (the agent has not been told it).
                // `dragged` stays set, so the click that ends this press does not seek either.
                if (event.key === "Escape" && draft) {
                  event.preventDefault(); event.stopPropagation();
                  press.current = null; dragged.current = true; setDraft(null);
                  return;
                }
                // While playing, the step is from the time on screen.
                const from = playing && timeStore ? timeStore.get() : time;
                // Shift+→ and Shift+← move the end of the range pointed at, from the playhead.
                if (event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
                  event.preventDefault(); event.stopPropagation();
                  const next = stepPoint(point, { time: from, duration, step: event.key === "ArrowRight" ? 0.1 : -0.1 });
                  onPoint?.(pointRange(next) ? next : null);
                  return;
                }
                if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); onSeek(Math.min(duration, from + 0.1)); }
                if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onSeek(Math.max(0, from - 0.1)); }
                const page = { PageUp: duration / pages, PageDown: -duration / pages }[event.key];
                if (page !== undefined) { event.preventDefault(); event.stopPropagation(); onSeek(Math.max(0, Math.min(duration, from + page))); }
                if (event.key === "Home" || event.key === "End") { event.preventDefault(); event.stopPropagation(); onSeek(event.key === "Home" ? 0 : duration); }
              }}>
              {ruler.ticks.map(({ at, label, major }, index) => (
                <span key={index} className={`tick${major ? " major" : ""}${at <= 0 ? " start" : at >= duration - 1e-6 ? " end" : ""}`} style={{ left: percent(at) }} aria-hidden="true">{label ? <span className="tick-label">{label}</span> : null}</span>
              ))}
              {cues.map((cue, index) => <span key={`c${index}`} className="cue" style={{ left: percent(cue.time) }} title={`${cue.name} ${clock(cue.time)}`}>╵</span>)}
              <NewMarks marks={marks} percent={percent} still={still} />
              <NewMarks marks={leavingMarks} leaving percent={percent} still={still} />
              {rangeStyle ? <span className="tl-range" style={rangeStyle} aria-hidden="true" /> : null}
              {/* The preview cache's ready stretches: a thin line along the ruler's foot. */}
              {readyRuns(previewList, { projectId: data.projectId, sceneId: scene.id, rev }).map(([start, end]) => (
                <span key={start} className="tl-cached" style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }} aria-hidden="true" />
              ))}
              <Playhead timeStore={timeStore} playing={playing} time={time} duration={duration} marker />
            </div>
            {story ? <StoryRow parts={parts} percent={percent} timeStore={timeStore} playing={playing} time={time} duration={duration} /> : null}
            <TimelineLanes model={lanes} data={data} scene={scene} percent={percent} trackWidth={trackWidth || 800} onSeek={onSeek} onTurn={onTurn}
              viewTurn={viewTurn} last={changes.last} still={still} now={now} pinTop={rulerPx} />
            {/* The scene's layers, one row each: pick one to point the agent at it. */}
            {strip ? null : <><span className="tl-label layers-head" aria-hidden="true">layers</span>
            <span className="track layers-head" aria-hidden="true"><span className="dim">{rows.length}</span></span></>}
            {(strip ? [] : rows).map((row, index) => (
              <React.Fragment key={row.id}>
                <button type="button" className={`tb tl-label row-button${selectedLayer === row.id ? " selected" : ""}${cursor === index ? " on" : ""}`} style={row.depth ? { paddingLeft: `calc(var(--tl-pad) + ${row.depth}ch)` } : undefined}
                  aria-pressed={selectedLayer === row.id} onClick={() => onSelectLayer(selectedLayer === row.id ? null : row.id)}
                  onFocus={focusRow(row.id)} onBlur={() => setHover(null)}
                  aria-describedby={[selectedLayer === row.id && line ? "pointing-line" : null, building.has(row.id) ? "building-note" : null, hover?.id === row.id ? "tl-card" : null].filter(Boolean).join(" ") || undefined}>
                  <span className={row.visible ? "" : "faint"}>{cut(row.name, 12 - row.depth)}</span>
                </button>
                <div className={`track${building.has(row.id) ? " is-building" : ""}${changes.newIds.has(row.id) ? " is-new" : ""}`} onClick={seek} aria-hidden="true" {...hoverTrack(row.id)}>
                  {/* When the layer is on screen (a quiet bar), then its animations over it. */}
                  {rangesOf(row.id).map(([start, end], spanIndex) => (
                    <span key={`w${spanIndex}`} className="bar idle" style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }} />
                  ))}
                  {row.spans.filter(([start, end]) => end > start).map(([start, end], spanIndex) => (
                    <span key={spanIndex} className="bar" style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }} />
                  ))}
                </div>
              </React.Fragment>
            ))}
            <div className="tl-lines" aria-hidden="true" style={{ top: rulerPx }}>
              {rangeStyle ? <span className="tl-range" style={rangeStyle} /> : null}
              {need ? <span className="tl-need" style={{ left: percent(need.start), width: `calc(${percent(need.end)} - ${percent(need.start)})`, top: (story ? STORY_PX : 0), height: lanes.rows[0]?.height ?? LANE_PX.shots }} /> : null}
              <Playhead timeStore={timeStore} playing={playing} time={time} duration={duration} />
              <TimelinePresence live={data.live} sceneId={scene.id} duration={duration} trackWidth={trackWidth} still={still} hold={Boolean(data.hold?.on)} />
            </div>
          </div>
        </div>
      )}
      {layer || line ? (
        <div className="tl-foot">
          {layer ? <p className="layer-values" aria-live="polite">{layerValues(layer)}</p> : null}
          {/* Not a live region: the ruler's value says the range as it changes, and the ruler and
              the selected layer's row point here (aria-describedby), so it is read once. */}
          {line ? <p className="pointing-line" id="pointing-line">{line}</p> : null}
        </div>
      ) : null}
      {/* What a striped ("building") row means, for a screen reader: each such row's button is
          described by it. Hidden, so it is read only as that description. */}
      {building.size ? <span id="building-note" hidden>building: an agent changed it this turn and has not looked at it since</span> : null}
      {card ? <HoverCard id="tl-card" lines={card} place={hover} still={still} /> : null}
    </Pane>
  );
}

// A selected layer's values, read only (plan §5.5 "point at something").
function layerValues(layer) {
  const fields = ["type", "x", "y", "width", "height", "rotation", "scale", "opacity", "fill", "color", "text", "fontFamily", "fontSize", "role"];
  const parts = fields.filter((key) => layer[key] !== undefined && layer[key] !== null && layer[key] !== "")
    .map((key) => `${key} ${typeof layer[key] === "number" ? Math.round(layer[key] * 100) / 100 : cut(typeof layer[key] === "object" ? JSON.stringify(layer[key]) : layer[key], 40)}`);
  return `${layer.name || layer.id} · ${parts.join(" · ")} · ${(layer.animations ?? []).length} anims`;
}

// ---- the key line and the status line --------------------------------------------------------

// "00:01.20/00:05.00": the stage's time (and the phone's status line's). It reads the played time itself, so only it
// redraws on each played frame. It shows no play or pause sign (the stage's transport has one);
// screen readers hear "playing" or "paused" after the time, and data-state says the same.
function PlayTime({ timeStore, playing, time, duration }) {
  const shown = useShownTime(timeStore, playing, time);
  return <span className="play-time" data-state={playing ? "playing" : "paused"}>{clock(shown)}<span className="play-total">/{clock(duration)}</span><span className="sr-only">{playing ? ", playing" : ", paused"}</span></span>;
}

/**
 * The status line. On a phone it has everything (the agents, the project and scene, the time, the
 * last turn). On a wide screen (`compact`) the top line, the stage and the agent pane say those,
 * so it keeps what they do not: hold, a stop waiting in another project, kino's MCP traffic,
 * the checks and the connection. `inert` while a question is open: the checks button is behind it.
 */
export function StatusLine({ data, scene, time, playing, timeStore, checks, onChecks, connection, still, now, compact = false, inert = false }) {
  const agent = agentRows(data, now)[0];
  // More than one agent at work: the line names them all, each in its color.
  const active = activeAgents(data, now);
  const many = activeAgentsText(active);
  const lastTurn = turnRows(data, now).at(-1);
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  // No project: nothing to check. A check that failed says so instead of waiting forever.
  // The wide window's line is quieter: "Checks: 0 errors, 2 warnings".
  const counts = checks?.data ? (compact ? `Checks: ${plural(checks.data.errors ?? 0, "error")}, ${plural(checks.data.warnings ?? 0, "warning")}` : `checks ${plural(checks.data.errors ?? 0, "error")} · ${plural(checks.data.warnings ?? 0, "warning")}`)
    : !data.projectId ? (compact ? "Checks" : "checks") : checks?.error ? (compact ? "Checks failed" : "checks failed") : compact ? "Checking" : "checks …";
  const project = data.projects.find((entry) => entry.id === data.projectId);
  const stop = waitingStopOf(data);
  // A stop waiting in a project that is not open shows here too.
  const other = stop ? null : otherStops(data)[0];
  return (
    <footer className={`statusline${compact ? " compact" : ""}`} aria-label="Status" inert={inert}>
      {/* On a wide window the line under the frame and the top line's button say the hold and the stop. */}
      {data.hold?.on && !compact ? <span className="hold">HOLD · agent writes paused</span> : null}
      {compact ? null : many ? (
        // The spinner only while one of them works; an agent that waits for you or failed says so.
        <span className="status-agents" title={many}>
          {active.some((entry) => entry.status === "working") ? <><Spinner still={still} /> </> : null}{active.length} agents{active.map((entry) => (
            <React.Fragment key={entry.id}> <span className="dim">·</span> <Bot className="status-bot" color={entry.color} mood={moodOfRow(data, entry, now)} size={14} still={still} /><AgentName agent={entry} />{entry.status === "working" ? null : <> <Status status={entry.status} still={still} /></>}</React.Fragment>
          ))}
        </span>
      ) : <span>{agent ? <><Bot className="status-bot" color={agent.color} mood={moodOfRow(data, agent, now)} size={14} still={still} /><Status status={agent.status} still={still} /> <AgentName agent={agent} before="· " /></> : <span className="s-idle">○ no agent yet</span>}</span>}
      {stop && !compact ? <span className="s-needs-you"><span aria-hidden="true">◉</span> {stopName(stop)} waits for you · asked {timeOfDay(stop.askedAt)}</span> : null}
      {other && !compact ? <span className="s-needs-you"><span aria-hidden="true">◉</span> {stopName(other.round)} waits for you in {other.name} · asked {timeOfDay(other.round.askedAt)}</span> : null}
      {compact ? null : <>
        <span>{project ? `${data.projectId} › ${scene?.name || scene?.id || ""}` : "no project"}</span>
        <PlayTime timeStore={timeStore} playing={playing} time={time} duration={scene?.duration ?? 0} />
        <span>{lastTurn ? `${lastTurn.id} ${lastTurn.ops ? `+${lastTurn.ops} ops` : lastTurn.turn.reverted ? "reverted" : `${lastTurn.calls.length} calls`}` : "no turns"}</span>
      </>}
      <span className="s-mcp" title="What kino sent and received over MCP for this project">{tokens(trafficTokens(data))} tokens</span>
      {/* The check counts are a link: it opens the checks view, which says what each one is. */}
      <button type="button" className={`tb s-checks${checks?.data?.errors ? " err" : checks?.data?.warnings ? " warn" : ""}`} onClick={onChecks} disabled={!data.projectId}
        title={checks?.error ?? "Show the checks: each error and warning, the layer it is about and its fix"}>{counts}</button>
      <span className={`s-live ${connection.state === "live" ? "is-live" : "warn"}`}><span className="live-dot" aria-hidden="true" />{connection.text}</span>
    </footer>
  );
}

export { bytes };
