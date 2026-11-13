// The dashboard's keys (plan §5.8): single keys, no prefix. keyAction turns a keydown into
// the name of an action, or null. Every action is also a button, so the mouse can do it too.
//
// Never bound: Ctrl+B (tmux's prefix) and Ctrl+C.

export const KEY_HELP = [
  ["1 2 3", "focus the stage, the agent pane, the timeline"], ["+ _", "zoom the pane, restore"], ["Tab ⇧Tab", "next, previous button or field"],
  ["j k ↑ ↓", "move"], ["← →", "older, newer picture (seen view); the agent pane's tabs"], ["Enter", "open"], ["Esc", "back"],
  ["?", "all keys"], ["F1 F2 F3 F4", "stage, crew, inspire, library"], ["⌘K :", "command list"], ["/", "filter the log"],
  ["space", "play or pause"], [", .", "one frame back, forward"], ["[ ]", "previous, next turn"], ["{ }", "previous, next scene"],
  ["n c", "note at the playhead"], ["a A", "allow once, always allow"], ["d D", "not yet (deny), always deny"],
  ["a Tab d c", "on a stop: approve, approve with a note, redo with a note, a note on one shot (A, D off)"],
  ["u", "undo a turn"], ["h H", "hold agent writes"], ["s g b", "safe area, grid, boxes on the frame"], ["o", "full-quality frame"],
  ["r e", "render (export)"], ["t", "raw transcript"], ["x", "cancel a render"], ["f", "follow the agent"],
  ["l", "mark the timeline's ▾ changes seen"], ["m M", "good, bad moment mark"],
];

const MAIN = {
  "?": "help", ":": "command", "/": "filter",
  " ": "play", ",": "frame-back", ".": "frame-forward", "[": "turn-back", "]": "turn-forward", "{": "scene-back", "}": "scene-forward",
  c: "note", n: "note", a: "allow", A: "allow-always", d: "deny", D: "deny-always", u: "undo", H: "hold", h: "hold", o: "full-frame", e: "export", r: "export",
  s: "safe", g: "grid", b: "boxes", m: "mark-good", M: "mark-bad",
  t: "transcript", x: "cancel-render", f: "follow", l: "seen", "+": "zoom", "=": "zoom", _: "unzoom",
  j: "down", k: "up", ArrowDown: "down", ArrowUp: "up", ArrowLeft: "left", ArrowRight: "right", Enter: "open", Escape: "back",
};

/**
 * `context`: { screen, typing, idle, shot, row } where screen is "main", "projects", "shares", "settings",
 * "turn", "variants", "crew", "approval", "stop", "board", "help", "transcript" or "command", typing is true
 * while focus is in a text field, idle is true while no control has focus (only the page, or a
 * full screen's own container), shot is true while the focus is on a storyboard shot that takes
 * a note (a row of a waiting board stop, board.jsx, or a field in it), and row while the focus is
 * on such a row itself.
 *
 * Tab is the browser's own almost everywhere: from a pane (keys 1–5) it moves into that pane's
 * buttons and fields, then on through the page. The exceptions: on the approval and stop
 * screens, Tab with nothing focused goes to the note field, and so does Tab on a storyboard
 * shot's row (as after Esc in the shot's note: not back into that note).
 *
 * On a stop (direction plan §6) a approves, Tab approves with a note and d asks for a redo with a
 * note. A and D only say they are off: a stop is set to allow in settings, never by a key. On a
 * storyboard shot, c leaves a note on that shot (on the phone's stack too, where c is otherwise a
 * note at the playhead); j and k move between the shots. On the stop screen with no shot focused,
 * c is "stop-shot-pick": the dashboard says how to pick a shot (on a storyboard).
 */
export function keyAction(event, { screen = "main", typing = false, idle = false, shot = false, row = false } = {}) {
  const key = event.key;
  if (event.ctrlKey && !event.metaKey) return null;
  // ⌘K opens the command list and closes it again; : (a typed character) only opens it.
  if (event.metaKey) return key === "k" || key === "K" ? "command-toggle" : null;
  if (event.altKey) return null;
  // F1 the stage, F2 the crew screen (crew.jsx), F3 inspire (inspire.jsx), F4 the library
  // (library.jsx), from any screen and
  // from a text field too (they type nothing).
  if (key === "F1") return "stage";
  if (key === "F2") return "crew";
  if (key === "F3") return "inspire";
  if (key === "F4") return "library";
  if (typing) return key === "Escape" ? "back" : null;
  if (key === "Escape") return "back";
  if (key === "?") return "help";
  if (key === ":") return "command";
  if (screen === "variants") {
    if (/^[1-6]$/.test(key)) return `pick-${key}`;
    if (key === "r") return "reject";
  }
  if (screen === "approval") {
    if (key === "Tab" && !event.shiftKey && idle) return "approval-note";
    if (["a", "A", "d", "D"].includes(key)) return MAIN[key];
  }
  if (shot && key === "c" && (screen === "stop" || screen === "main")) return "stop-shot-note";
  if (row && key === "Tab" && !event.shiftKey && (screen === "stop" || screen === "main")) return "stop-note";
  if (screen === "stop") {
    if (key === "Tab" && !event.shiftKey && idle) return "stop-note";
    if (key === "c") return "stop-shot-pick";
    if (key === "a") return "stop-approve";
    if (key === "d") return "stop-redo";
    if (key === "A" || key === "D") return "stop-always-off";
  }
  if (screen === "projects") {
    if (key === "y") return "duplicate";
    if (key === "Delete" || key === "Backspace") return "archive";
  }
  if (screen === "turn" && key === "u") return "undo";
  if (screen !== "main") {
    if (["j", "k", "ArrowDown", "ArrowUp", "Enter"].includes(key)) return MAIN[key];
    return null;
  }
  if (/^[1-3]$/.test(key)) return `pane-${key}`;
  return MAIN[key] ?? null;
}

/** True when the focused element takes typing, so letter keys must not run actions. */
export function isTyping(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "range"].includes(String(element.type).toLowerCase());
}

/**
 * Runs a command line (`:` or ⌘K). Returns { action, value } or { error }.
 * Commands: projects, crew, shares, settings, help, transcript, variants, board, turn T3, note <text>,
 * hold [note], release, export [draft|final] [mp4|webm|mov|gif], open <project>, follow, safe,
 * grid, findings, marks.
 */
export function parseCommand(text) {
  const [word = "", ...rest] = String(text ?? "").trim().replace(/^:/, "").split(/\s+/);
  const value = rest.join(" ");
  switch (word.toLowerCase()) {
    case "projects": case "p": return { action: "projects" };
    case "crew": return { action: "crew" };
    case "inspire": return { action: "inspire" };
    case "shares": case "share": return { action: "shares" };
    case "settings": case "s": return { action: "settings" };
    case "help": case "keys": return { action: "help" };
    case "transcript": return { action: "transcript" };
    case "variants": return { action: "variants" };
    case "board": case "storyboard": return { action: "board" };
    case "try": case "options": return { action: "try" };
    case "library": case "lib": return { action: "library" };
    case "turn": return /^T\d+$/i.test(value) ? { action: "turn", value: value.toUpperCase() } : { error: "turn needs a turn id, such as turn T3." };
    case "note": return value ? { action: "note", value } : { error: "note needs text, such as note make the title larger." };
    case "hold": return { action: "hold", value: true, note: value };
    case "release": return { action: "hold", value: false };
    case "open": return value ? { action: "open", value } : { error: "open needs a project id." };
    case "follow": return { action: "follow" };
    case "safe": case "grid": case "findings": case "marks": return { action: "overlay", value: word.toLowerCase() };
    case "boxes": return { action: "boxes" };
    // The agent pane's views (agentPane.jsx).
    case "agent": case "session": case "log": case "checks": case "notes": case "seen": return { action: "view", value: word.toLowerCase() };
    case "inspire": return { action: "inspire" };
    case "render": return { action: "export", value: { quality: "final" } };
    case "cancel": return { action: "cancel-render" };
    case "mark": return value === "seen" ? { action: "mark-seen" } : { error: "mark seen marks the timeline's ▾ changes seen." };    case "export": {
      const quality = rest.find((entry) => ["draft", "final"].includes(entry)) ?? "final";
      const format = rest.find((entry) => ["mp4", "webm", "mov", "gif"].includes(entry));
      const unknown = rest.filter((entry) => !["draft", "final", "mp4", "webm", "mov", "gif"].includes(entry));
      if (unknown.length) return { error: `export takes draft or final and mp4, webm, mov or gif, not ${unknown.join(" ")}.` };
      return { action: "export", value: { quality, ...(format ? { format } : {}) } };
    }
    case "": return { error: "Type a command, such as settings or export final." };
    default: return { error: `Unknown command "${word}". Try session, projects, shares, settings, render, note, hold, turn T3 or help.` };
  }
}
