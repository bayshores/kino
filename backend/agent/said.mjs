// What an agent says about a call, and what the dashboard shows under it.
//
// why and next: every agent tool takes them, as optional short text. why is the reason for this
// call, next is what the agent does after it. They are taken out of the input before the call
// runs (no handler sees them), kept with the call's event, and shown in the dashboard's agent
// pane, so the person watching knows why the agent does what it does.
//
// details: up to three short lines from the call's answer, shown nested under the call's row
// ("├ created title → L1"). A receipt (an edit's JSON answer) gives its fields; a text answer
// gives its lines after the first (the summary), without file paths and the inbox.

export const SAID_FIELDS = ["why", "next"];
export const SAID_LIMIT = 200;
const DETAIL_LINES = 3;
const DETAIL_LIMIT = 90;

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * Splits why and next out of a call's input. Returns { input (without them), said ({why?,
 * next?}, each trimmed, one line, at most SAID_LIMIT characters) }. Anything that is not text is
 * dropped. An input that is not an object is returned as it is.
 */
export function takeSaid(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input, said: {} };
  if (!SAID_FIELDS.some((key) => Object.hasOwn(input, key))) return { input, said: {} };
  const rest = { ...input };
  const said = {};
  for (const key of SAID_FIELDS) {
    const value = rest[key];
    delete rest[key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    if (text) said[key] = cut(text, SAID_LIMIT);
  }
  return { input: rest, said };
}

// A receipt's value as a few words: text as it is, a list or an object as "a, b" or "key value".
function words(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (depth > 1) return "…";
  if (Array.isArray(value)) return value.map((item) => words(item, depth + 1)).filter(Boolean).join(", ");
  return Object.entries(value).map(([key, item]) => (typeof item === "object" && item !== null ? `${key} ${words(item, depth + 1)}` : `${key} → ${words(item, depth + 1)}`)).join(", ");
}

// Receipt fields every row already says (the revision and the turn), that say nothing alone, or
// that are advice to the agent rather than what happened (next, rules, example).
const SKIPPED = new Set(["rev", "turn", "ok", "status", "project", "inbox", "file", "url", "desktopUrl", "next", "id", "rules", "example", "safeToRetry"]);

/** Up to three short lines from a call's answer `reply` ({text, data, receipt?}) for the dashboard. */
export function callDetails(reply) {
  const text = String(reply?.text ?? "");
  let lines;
  // A receipt: the fields the agent was sent (its JSON text), not the fuller data behind it.
  let receipt = null;
  if (text.startsWith("{")) { try { receipt = JSON.parse(text); } catch { receipt = null; } }
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
    const empty = (value) => value === null || value === undefined || value === "" || (typeof value === "object" && !Object.keys(value).length);
    lines = Object.entries(receipt).filter(([key, value]) => !SKIPPED.has(key) && !empty(value)).map(([key, value]) => `${key} ${words(value)}`);
  } else {
    // A text answer's advice lines ("next The person answers …") are left out as a receipt's are.
    lines = text.split("\n").slice(1)
      .filter((line) => line.trim() && !/^(image|inbox|file|saved|  )/.test(line) && !/(^|\s)\/[\w.-]+\//.test(line) && !line.startsWith("note:")
        && !SKIPPED.has(line.trim().split(/[\s:]+/)[0]));
  }
  return lines.slice(0, DETAIL_LINES).map((line) => cut(line.replace(/\s+/g, " ").trim(), DETAIL_LIMIT)).filter(Boolean);
}
