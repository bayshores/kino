// The agents' live markers on the stage and the timeline (milestone LIVE, parts 1 and 3), as plain
// data; presence.jsx draws them. This is not the people's presence (backend/presence.mjs and
// frontend/components/ScenePresence.jsx show other people's cursors): it follows what each connected
// agent's calls read or write, and every mark comes from a real call.
//
// The data is `data.live`, which the reducer (state.js) builds from the server's "presence"
// events: { latest: { [agentId]: presence }, building: [{ sceneId, layerId, agentId, at }], skew }.
// A presence is { agent: { id, name, color, kind }, call, phase: "start" | "done", verb, label,
// write, target, changed, building, turn, isError, ms, running, held?, refused?, approval?, at },
// where `running` counts the agent's calls still running, held and refused say a write did not
// run (you paused writes; a stop waits), approval names the approval the call waits for (it has
// not run yet), and target and changed are
// { sceneId, sceneName, layerIds, time, range, text }. All times here are the server's clock in
// ms (serverNow), so a computer clock that is off moves nothing.

/** Only a write under 1 s old when the dashboard first sees it flashes: a replay never does. */
export const FRESH_MS = 1000;
/** A marker stays 5 s after its call is done, then fades out in 300 ms. */
export const SHOWN_MS = 5000;
export const FADE_MS = 300;
/** A call that never says it is done shows at most 10 min. */
export const START_MS = 600_000;
/** The flash on what a write changed: 200 ms in, 400 ms held, 300 ms out. */
export const FLASH_MS = 900;
/** Under reduced motion a steady outline shows instead, for 1.5 s. */
export const STEADY_MS = 1500;
/** Building marks hide once the newest write is 2 min old: the turn is over. */
export const TURN_GAP_MS = 120_000;
export const MAX_MARKERS = 8;
/** Building outlines drawn on the stage at most: the stage redraws them on every played frame. */
export const MAX_BUILDING = 50;
/** A stage tag is 16 px high; tags on the same spot stack 18 px apart. */
export const TAG_PX = 16;
export const STACK_PX = 18;
/** The first agent color (teal), for a building mark whose agent has no marker any more. */
export const DEFAULT_COLOR = "#42c0b6";

const LOOKS = new Set(["look", "inspect", "status", "check"]);
// How long ago the dashboard keeps what it first saw of a call.
const SEEN_KEEP_MS = 10_000;

const timeOf = (at) => (typeof at === "number" ? at : Date.parse(at));
const callKey = (presence) => `${presence.call}:${presence.phase}`;
// Two presences in the same millisecond: the one published later (its event's seq) is newer;
// the call number says which call started later, not which finished later.
const newestFirst = (a, b) => timeOf(b.at) - timeOf(a.at) || (b.seq ?? 0) - (a.seq ?? 0) || (b.call ?? 0) - (a.call ?? 0);

/** The server's time now: `skew` is how far this computer's clock is ahead of the server's. */
export function serverNow(live, clientNow = Date.now()) {
  return clientNow - (Number(live?.skew) || 0);
}

/** How old a presence is at `now`, in ms (never below 0; Infinity without a time). */
export function ageOf(presence, now) {
  const at = timeOf(presence?.at);
  return Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
}

/** Whether the agent still has a call running: this one, or another it runs side by side. */
const stillRunning = (presence) => presence.phase === "start" || presence.running > 0;

/** Shown while its call (or another of the agent's calls) runs, 10 min at most, and for 5 s after. */
export function isShown(presence, now) {
  if (!presence?.agent) return false;
  return ageOf(presence, now) < (stillRunning(presence) ? START_MS : SHOWN_MS);
}

/**
 * What happened to a call that did not run as asked: " · held" or " · refused" (a write that did
 * not run), " · waits for you" (it waits for your approval) or " · failed"; else "".
 */
export function outcomeText(presence) {
  if (presence?.phase !== "done") return "";
  return presence.held ? " · held" : presence.refused ? " · refused" : presence.approval ? " · waits for you" : presence.isError ? " · failed" : "";
}

/** The markers shown at `now`, newest first, 8 at most. */
export function shownPresence(live, now) {
  return Object.values(live?.latest ?? {}).filter((presence) => isShown(presence, now)).sort(newestFirst).slice(0, MAX_MARKERS);
}

/** The markers that stopped being shown in the last 300 ms: they fade out. */
export function leavingPresence(live, now) {
  const shown = new Set(shownPresence(live, now).map((presence) => presence.agent.id));
  return shownPresence(live, now - FADE_MS).filter((presence) => !shown.has(presence.agent.id));
}

/** The newest presence of any agent, or null. */
export function newestPresence(live) {
  return Object.values(live?.latest ?? {}).filter((presence) => presence?.agent).sort(newestFirst)[0] ?? null;
}

/** An agent's color, from its newest presence. */
export function agentColor(live, agentId) {
  return live?.latest?.[agentId]?.agent?.color || DEFAULT_COLOR;
}

/**
 * What a call is about: its target, or for a write that saved what it changed.
 * { sceneId, sceneName, layerIds, time, range, text }, or null.
 */
export function spotOf(presence) {
  const target = presence?.target ?? null;
  const changed = presence?.changed ?? null;
  if (!target && !changed) return null;
  const pick = (key) => target?.[key] ?? changed?.[key] ?? null;
  const layerIds = target?.layerIds?.length ? target.layerIds : changed?.layerIds ?? [];
  const range = Array.isArray(pick("range")) && pick("range").length === 2 ? pick("range") : null;
  const time = Number.isFinite(pick("time")) ? pick("time") : null;
  return { sceneId: pick("sceneId"), sceneName: pick("sceneName"), layerIds, time, range, text: pick("text") ?? "" };
}

// A tag's width in px, guessed from its text: the dashboard's font is monospaced, 12 px tags are
// about 7.3 px a character plus 0.6 character of padding each side (presence.css). The agent's
// bot is not in the tag on the stage: it is the big stage bot beside the cursor.
const TAG_CHAR_PX = 7.3;
const tagWidth = (text) => (String(text).length + 1.2) * TAG_CHAR_PX;

/**
 * Moves each place `step` px while it would cover one placed before it (newest first), so two
 * agents on the same spot stack their tags: up, off the layer, for a tag above an outline while
 * the stage has room there, else down. `widthOf(place)` is its width in px, and `right` the
 * width it is kept inside (as the tag's CSS keeps it), so tags clash only where they would meet.
 */
function stack(places, widthOf, step, bottom = null, right = Infinity) {
  const placed = [];
  const span = (place) => {
    const width = widthOf(place);
    const left = Math.max(0, Math.min(place.x, right - width));
    return [left, left + width];
  };
  const clashes = (place) => {
    const [left, end] = span(place);
    return placed.some((other) => {
      const [otherLeft, otherEnd] = span(other);
      return left < otherEnd && otherLeft < end && Math.abs(other.y - place.y) < step;
    });
  };
  for (const place of places) {
    const start = place.y;
    // A tag over a layer's outline stacks upward, off the layer, while the stage has room above.
    if (place.box) while (clashes(place) && place.y - step >= 0) place.y -= step;
    if (clashes(place)) {
      place.y = start;
      while (clashes(place)) place.y += step;
    }
    if (bottom != null) place.y = Math.min(place.y, Math.max(0, bottom));
    placed.push(place);
  }
  return places;
}

/**
 * Where each shown marker's tag goes on the stage, in px from its top left corner (`width` and
 * `height` are the stage's size in px): just above the outline of the layers the call is about
 * (inside it at the stage's top edge), at the top left when the call names no layer the stage can
 * find, and at the right edge reading "in <scene>" when the call is about another scene (the tag's
 * CSS keeps it inside the stage). `boxOf(layerIds)` gives { left, top, width, height } in px or
 * null, and `sceneName(id)` a scene's name.
 * → [{ presence, text, x, y, box, edge }]
 */
export function tagPlaces(presences, { sceneId, width, height, boxOf, sceneName = (id) => id }) {
  const places = presences.map((presence) => {
    const name = presence.agent?.name || "agent";
    const spot = spotOf(presence);
    if (spot?.sceneId && spot.sceneId !== sceneId) {
      return { presence, text: `${name} · in ${sceneName(spot.sceneId) || spot.sceneName || spot.sceneId}`, x: width, y: 0, box: null, edge: true };
    }
    const text = `${name} · ${presence.label || presence.verb || ""}${outcomeText(presence)}`;
    const box = spot?.layerIds.length ? boxOf(spot.layerIds) : null;
    if (box) return { presence, text, x: box.left, y: Math.max(0, box.top - TAG_PX), box, edge: false };
    return { presence, text, x: 0, y: 0, box: null, edge: false };
  });
  return stack(places, (place) => tagWidth(place.text), STACK_PX, Number.isFinite(height) ? height - TAG_PX : null, Number.isFinite(width) ? width : Infinity);
}

/**
 * Where each agent's cursor points on the stage, in px: the middle of the layers its call is
 * about, near the stage's right edge for another scene, and otherwise where it pointed last (the
 * stage's middle the first time). `last` is a Map the stage keeps from render to render, so a
 * cursor glides from its last spot to the next one instead of starting over.
 * → [{ presence, x, y }]
 */
export function cursorPlaces(places, { width, height, last }) {
  return places.map(({ presence, box, edge }) => {
    const id = presence.agent?.id;
    let point;
    if (edge) point = { x: Math.max(0, width - 12), y: TAG_PX + 6 };
    else if (box) point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    else point = last.get(id) ?? { x: Math.round(width / 2), y: Math.round(height / 2) };
    last.set(id, point);
    return { presence, ...point };
  });
}

// ---- the stage bots ---------------------------------------------------------------------------
// Every agent seen in the last 10 min keeps one bot (bot.jsx) on the stage. While its call shows
// (isShown) and is about something on this stage, the bot rides beside the agent's cursor; else
// it rests with the others in the pane's empty margin, or over a corner of the frame (dimmed)
// when the frame fills the pane.

/** A stage bot is 28 px wide; at rest its name sits under it, in a slot 64 px wide and 46 px high. */
export const STAGE_BOT_PX = 28;
export const REST_SLOT_PX = 64;
export const REST_ROW_PX = 46;
// The gap between a resting row and the pane's edge.
const REST_GAP_PX = 6;

/** The agents with a bot on the stage: each one seen in the last 10 min, in a steady order (a1, a2, ...), 8 at most. */
export function stageCrew(live, now) {
  return Object.values(live?.latest ?? {})
    .filter((presence) => presence?.agent && ageOf(presence, now) < START_MS)
    .sort((a, b) => String(a.agent.id).localeCompare(String(b.agent.id), undefined, { numeric: true }))
    .slice(0, MAX_MARKERS);
}

/**
 * Where `count` resting bots go, in px from the frame's top left corner (`width` x `height`).
 * `room` is the empty space around the frame inside the pane, { left, right, top, bottom } in px.
 * In the bottom margin when it is tall enough, side by side from the pane's left edge; else in the
 * left margin when a bot fits there (slots as wide as the margin allows, up to 64 px), side by
 * side and in rows upward from the pane's bottom, clear of the frame's corner mark; else over the
 * frame's bottom left corner, `over` (drawn dimmed so it never hides the picture). Each place is
 * the bot's top left corner, in the middle of its slot; `slot` is the slot's width in px (the
 * name under the bot is cut to it).
 * → { over: boolean, slot: number, places: [{ x, y }] }
 */
export function restPlaces(count, { width, height, room = null }) {
  const { left = 0, right = 0, bottom = 0 } = room ?? {};
  // Where the first slot's left edge and the bottom row's bottom edge are, how wide the rows may
  // be, and how wide a slot is.
  let start;
  let floor;
  let across;
  let slot = REST_SLOT_PX;
  let over = false;
  if (bottom >= REST_ROW_PX + REST_GAP_PX) {
    [start, floor, across] = [-left + REST_GAP_PX, height + bottom - REST_GAP_PX, left + width + right - REST_GAP_PX * 2];
  } else if (left >= STAGE_BOT_PX) {
    slot = Math.min(REST_SLOT_PX, left);
    const perRow = Math.max(1, Math.floor(left / slot));
    // The frame's corner mark reaches 6 px into the margin's bottom right: rows stand above it.
    [start, floor, across] = [-left + (left - perRow * slot) / 2, height + bottom - Math.max(REST_GAP_PX, 12 - bottom), perRow * slot];
  } else {
    [start, floor, across, over] = [REST_GAP_PX, height - REST_GAP_PX, width - REST_GAP_PX * 2, true];
  }
  const perRow = Math.max(1, Math.floor(across / slot));
  const inset = (slot - STAGE_BOT_PX) / 2;
  const places = Array.from({ length: count }, (_, index) => ({
    x: Math.round(start + (index % perRow) * slot + inset),
    y: Math.round(floor - REST_ROW_PX * (Math.floor(index / perRow) + 1)),
  }));
  return { over, slot, places };
}

/**
 * Where a riding bot goes: just under and right of its cursor's tip (`x`, `y`), so the arrow
 * points out of the bot's top left; kept inside the frame (`width` x `height`).
 */
export function ridePlace({ x, y }, { width, height }) {
  const left = Math.max(0, Math.min(x + 10, width - STAGE_BOT_PX));
  const top = Math.max(0, Math.min(y + 16, height - STAGE_BOT_PX));
  return { x: Math.round(left), y: Math.round(top) };
}

/** Seconds → px on a timeline track `trackWidth` px wide, kept on the track. */
export function timelineX(seconds, duration, trackWidth) {
  if (!(duration > 0) || !(trackWidth > 0) || !Number.isFinite(seconds)) return 0;
  return Math.min(trackWidth, Math.max(0, (seconds / duration) * trackWidth));
}

/** [start, end] in seconds → { x, width } in px on the track, at least 1 px wide. */
export function timelineSpan(range, duration, trackWidth) {
  const x = timelineX(range[0], duration, trackWidth);
  return { x, width: Math.max(1, timelineX(range[1], duration, trackWidth) - x) };
}

/**
 * What each marker draws on the timeline of `sceneId`: a 1 px line at the time its call is about,
 * or a tint over its range. Calls about another scene, or about no time, draw nothing.
 * → [{ presence, range: boolean, x, width }]
 */
export function timelineMarks(presences, { sceneId, duration, trackWidth }) {
  if (!(trackWidth > 0)) return [];
  return presences.flatMap((presence) => {
    const spot = spotOf(presence);
    if (!spot || spot.sceneId !== sceneId) return [];
    if (spot.range) return [{ presence, range: true, ...timelineSpan(spot.range, duration, trackWidth) }];
    if (spot.time != null) return [{ presence, range: false, x: timelineX(spot.time, duration, trackWidth), width: 1 }];
    return [];
  });
}

/** The name chips over the timeline marks, stacked 15 px apart where they meet. */
export function chipPlaces(marks) {
  // A chip is the agent's bot (14 px) and a name, at most about 78 px wide.
  return stack(marks.map((mark) => ({ presence: mark.presence, text: mark.presence.agent?.name || "agent", x: mark.x, y: 0 })), () => 78, 15);
}

/**
 * Notes how old each call was when this view first saw it (forgotten after 10 s), so that a
 * write that arrives with a snapshot or a replay never flashes. Returns `seen`.
 */
export function noteFirstSeen(seen, presences, now) {
  for (const presence of presences) {
    if (presence?.agent && !seen.has(callKey(presence))) seen.set(callKey(presence), { age: ageOf(presence, now), at: timeOf(presence.at) });
  }
  for (const [key, entry] of seen) if (!(now - entry.at < SEEN_KEEP_MS)) seen.delete(key);
  return seen;
}

/**
 * The writes that flash now: a call that saved changes, first seen while fresh, for 900 ms; under
 * reduced motion (`still`) a steady outline instead, for 1.5 s. `delay` is how far into its flash
 * the call already was when first seen (the CSS animation starts there, so it ends on time).
 * → [{ presence, steady: boolean, delay }]
 */
export function changeMarks(presences, now, { still = false, seen }) {
  return presences.flatMap((presence) => {
    if (presence.phase !== "done" || !presence.changed || presence.isError) return [];
    const first = seen.get(callKey(presence));
    if (!first || first.age >= FRESH_MS) return [];
    if (ageOf(presence, now) >= (still ? STEADY_MS : FLASH_MS)) return [];
    return [{ presence, steady: still, delay: first.age }];
  });
}

/**
 * When the newest write was, in server ms (NaN when there is none). Reads (a look, status, a
 * render wait) do not count: an agent that only checks on a render must not keep old marks up.
 */
function newestWriteAt(live) {
  const writes = Object.values(live?.latest ?? {}).filter((presence) => presence?.write);
  const times = [...writes.map((presence) => timeOf(presence?.at)), ...(live?.building ?? []).map((entry) => timeOf(entry?.at))]
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

/** The building entries of `sceneId` shown now: none once the newest write is over 2 min old. */
export function buildingEntries(live, sceneId, now) {
  const newest = newestWriteAt(live);
  if (!Number.isFinite(newest) || now - newest > TURN_GAP_MS) return [];
  return (live?.building ?? []).filter((entry) => entry?.sceneId === sceneId && entry.layerId);
}

// Follow agent brings the stage to another scene at most once in this long for a call that starts.
export const FOLLOW_GAP_MS = 2000;

/**
 * Where follow agent takes the stage when a call starts in a scene not on the stage: only a
 * write (a read there shows its marker at the stage's edge), only while it just started (under
 * a second old, so a snapshot or a reload never moves the stage), and at most once every 2 s
 * (`lastAt`, the server time of the last move). {sceneId, time}, or null to stay.
 */
export function followStart(presence, { sceneId, sceneIds = [], now, lastAt = null }) {
  if (presence?.phase !== "start" || !presence.write) return null;
  const target = presence.target;
  if (!target?.sceneId || target.sceneId === sceneId || !sceneIds.includes(target.sceneId)) return null;
  if (now - Date.parse(presence.at) > 1000) return null;
  if (lastAt != null && now - lastAt < FOLLOW_GAP_MS) return null;
  return { sceneId: target.sceneId, time: target.time ?? target.range?.[0] ?? 0 };
}

/**
 * The building outlines the stage draws: none while it plays (each outline measures its layer at
 * the frame shown, and the stage redraws on every played frame; the timeline keeps its marks),
 * else at most 50.
 */
export function stageBuilding(live, sceneId, now, { playing = false } = {}) {
  return playing ? [] : buildingEntries(live, sceneId, now).slice(0, MAX_BUILDING);
}

/**
 * The layers of `sceneId` marked "building": changed by an agent in this turn and not looked at
 * since. The timeline puts `is-building` on their rows.
 */
export function buildingIds(live, sceneId, now) {
  return new Set(buildingEntries(live, sceneId, now).map((entry) => entry.layerId));
}

/**
 * The next server time at which something on screen changes by itself (a marker fades or goes, a
 * flash or steady outline ends, a call stops being fresh, the building marks hide), or null. A
 * component sets one timer for it.
 */
export function nextChangeAt(live, now) {
  const times = [];
  for (const presence of Object.values(live?.latest ?? {})) {
    const at = timeOf(presence?.at);
    if (!Number.isFinite(at)) continue;
    const end = at + (stillRunning(presence) ? START_MS : SHOWN_MS);
    times.push(at + FRESH_MS, at + FLASH_MS, at + STEADY_MS, end, end + FADE_MS);
  }
  const newest = newestWriteAt(live);
  if ((live?.building ?? []).length && Number.isFinite(newest)) times.push(newest + TURN_GAP_MS + 1);
  const next = times.filter((time) => time > now);
  return next.length ? Math.min(...next) : null;
}

/**
 * The screen reader's line for a call: "Nova is looking at Title, 1.0–2.0 s" for a look,
 * inspect, status or check; "Nova is changing Title" while an edit runs and "Nova changed Title"
 * once it saved; a write that did not run "Nova: move Title, held (nothing changed)" or
 * ", refused: a stop waits (nothing changed)"; a call that waits for your approval ", waits
 * for your approval (not run yet)"; otherwise "Nova: <label>" (", failed" when the call failed).
 */
export function announceText(presence) {
  if (!presence?.agent) return "";
  const name = presence.agent.name || "agent";
  const label = presence.label || presence.verb || "a call";
  if (presence.phase === "done" && presence.held) return `${name}: ${label}, held (nothing changed)`;
  if (presence.phase === "done" && presence.refused) return `${name}: ${label}, refused: a stop waits (nothing changed)`;
  if (presence.phase === "done" && presence.approval) return `${name}: ${label}, waits for your approval (not run yet)`;
  const failed = presence.phase === "done" && presence.isError;
  if (!failed && LOOKS.has(presence.verb) && presence.target?.text) return `${name} is looking at ${presence.target.text}`;
  if (!failed && presence.verb === "edit" && presence.write) {
    if (presence.phase === "start" && presence.target?.text) return `${name} is changing ${presence.target.text}`;
    if (presence.phase === "done" && presence.changed?.text) return `${name} changed ${presence.changed.text}`;
  }
  return `${name}: ${label}${failed ? ", failed" : ""}`;
}

/**
 * The throttle for the screen reader's live line: at most one line every `gapMs` (4 s), the
 * newest waiting line wins (it is said when the gap ends), and a line equal to the last one said
 * is skipped. `onLine(text)` says a line. The clock and timers can be swapped for tests.
 */
export function createAnnouncer({ gapMs = 4000, onLine = () => {}, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let said = "";
  let saidAt = -Infinity;
  let waiting = "";
  let timer = null;
  const flush = () => {
    timer = null;
    const text = waiting;
    waiting = "";
    if (!text || text === said) return;
    said = text;
    saidAt = clock();
    onLine(text);
  };
  return {
    say(text) {
      if (!text) return;
      waiting = text;
      if (timer !== null) return;
      const wait = saidAt + gapMs - clock();
      if (wait <= 0) flush();
      else timer = setTimer(flush, wait);
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      waiting = "";
    },
  };
}
