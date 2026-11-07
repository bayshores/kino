// The dashboard's data: one snapshot from GET /api/dashboard/snapshot, then every event from
// the stream applied in order (applyEvent). The functions below it turn that data into the
// rows each pane shows. Everything here is plain data in, plain data out, so it is easy to
// test (frontend/dashboardModules.test.js).
import { withInspireEvent } from "./inspireView.js";
import { animationTreeEntries } from "../../engine/animationTree.js";
import { buildThreads } from "../comments.js";
import { callNoWords, shotList } from "./boardRows.js";
import { callSummary, cut, noteState, timeOfDay, tokens } from "./format.js";
import { BRIEF_LABELS, READ_WORDS, STOP_WORDS } from "./words.js";

// The dashboard's own check after each revision: saved results only. pixels:false never
// transcribes, decodes sound or renders frames; a scene the agent fully checked still shows
// that full check (quality.mjs check). Heavy work waits for an agent or the person.
export const backgroundCheckInput = (projectId) => ({ project: projectId, quiet: true, pixels: false });

// An agent that called kino this recently is "working".
export const WORKING_MS = 20_000;
const CALLS_KEPT = 400;

const emptyAgent = () => ({ plan: null, notes: [], turns: [], codes: {}, brief: null, stops: null });

// ---- who is working, and what each agent is doing now (design F1, F3, F7) -------------------

// The newest presence of at most this many agents is kept.
export const LIVE_KEPT = 12;
// An agent whose newest call finished this long ago "went quiet" (the quiet notification),
// until the turn is over (TURN_GAP_MS, the server's turn gap).
export const QUIET_MS = 30_000;
export const TURN_GAP_MS = 120_000;

/**
 * The agent who made a call: `call.agent` ({id, name, color, kind}). An older entry without one
 * is named by its client, as before ("legacy-" + client is its id).
 */
export function callAgent(call) {
  const kind = call?.agent?.kind || call?.client || "agent";
  if (call?.agent?.id) return { id: call.agent.id, name: call.agent.name || "agent", color: call.agent.color ?? null, kind };
  return { id: `legacy-${kind}`, name: kind, color: null, kind };
}

// An agents row from the snapshot, with an id and a kind also when an older server left them out.
const agentRow = (row) => ({ ...row, id: row.id ?? `legacy-${row.kind ?? row.name}`, kind: row.kind ?? row.name });

/**
 * data.live (F7): the newest presence of each agent, stamped with the server time it happened
 * ({[agentId]: presence & {at}}), the building marks of the open project, and the clock skew
 * (this computer's clock minus the server's, in ms).
 */
export function liveFrom(snapshot, clientNow = Date.now()) {
  const serverAt = Date.parse(snapshot?.now ?? "");
  const latest = {};
  for (const entry of snapshot?.presence?.latest ?? []) {
    const presence = entry?.presence ?? entry;
    const at = entry?.at ?? presence?.at;
    const id = presence?.agent?.id;
    if (!id || typeof at !== "string" || latest[id]) continue;
    if (Object.keys(latest).length >= LIVE_KEPT) break;
    latest[id] = { ...presence, at };
  }
  const building = snapshot?.presence?.building;
  return { latest, building: Array.isArray(building) ? building : [], skew: Number.isFinite(serverAt) ? clientNow - serverAt : 0 };
}

const emptyLive = () => ({ latest: {}, building: [], skew: 0 });

// A presence event: the agent's newest presence replaces its older one. A presence in another
// project takes the agent off this one's stage. Only the open project's events carry its
// building marks. An agent's calls can run side by side: while a newer call of the agent runs,
// an older call's presence only updates how many still run (`running`).
function withPresence(state, event, here) {
  const presence = event.presence;
  const id = presence?.agent?.id;
  const live = state.live ?? emptyLive();
  if (!id) return live;
  const { [id]: was, ...others } = live.latest;
  if (event.projectId && !here) return was ? { ...live, latest: others } : live;
  const building = here && Array.isArray(presence.building) ? presence.building : live.building;
  if (was && Number(was.call) > Number(presence.call) && was.phase === "start") {
    return { ...live, latest: { ...live.latest, [id]: { ...was, running: Number(presence.running) || 0 } }, building };
  }
  const at = typeof event.at === "string" ? event.at : new Date(Date.now() - (live.skew ?? 0)).toISOString();
  const kept = Object.entries(others).sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at))).slice(0, LIVE_KEPT - 1);
  return { ...live, latest: { ...Object.fromEntries(kept), [id]: { ...presence, at, ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}) } }, building };
}

export function fromSnapshot(snapshot, previous = null, clientNow = Date.now()) {
  return {
    boot: snapshot.boot,
    seq: snapshot.seq ?? 0,
    projects: snapshot.projects ?? [],
    current: snapshot.current ?? null,
    projectId: snapshot.projectId ?? null,
    record: snapshot.record ?? null,
    // Comments people left through share links (the viewer). Read only here.
    comments: snapshot.comments ?? [],
    agent: snapshot.agent ?? emptyAgent(),
    // The stop waiting for you in each project an agent works on, the open one's included:
    // {<project>: waiting}. A project that is not open shows its stop in "needs you" too.
    waitingStops: snapshot.waitingStops ?? {},
    calls: snapshot.events ?? [],
    approvals: snapshot.approvals ?? [],
    hold: snapshot.hold ?? { on: false, since: null, note: "" },
    settings: snapshot.settings ?? null,
    renders: snapshot.renders ?? [],
    agents: (snapshot.agents ?? []).map(agentRow),
    live: liveFrom(snapshot, clientNow),
    pointing: snapshot.pointing ?? null,
    // Inspire (F3): the project's YouTube searches and measured references (inspireView.js).
    inspire: snapshot.inspire ?? null,
    storage: snapshot.storage ?? null,
    // The crew (backend/agent/crew.mjs view): members, held parts, start rules, activity. Null
    // from a server without one. Each "crew" event replaces it whole.
    crew: snapshot.crew ?? null,
    // The blind pick box (backend/agent/picks.mjs view); each "picks" event replaces it.
    picks: snapshot.picks ?? null,
    // Where the agent last edited (for "follow agent"), and whether the document is behind.
    focus: previous && previous.projectId === snapshot.projectId ? previous.focus : null,
    behind: false,
    wantRev: snapshot.record?.revision ?? 0,
  };
}

// waitingStops with `project`'s waiting stop from its new stops summary.
function withWaiting(state, project, stops) {
  const { [project]: _was, ...rest } = state.waitingStops ?? {};
  return stops.waiting ? { ...rest, [project]: stops.waiting } : rest;
}

function upsert(list, item, key = "id") {
  const index = list.findIndex((entry) => entry[key] === item[key]);
  if (index < 0) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/** Applies one stream event. Returns the same state object when nothing changed. */
export function applyEvent(state, event) {
  if (!state || !event || typeof event !== "object") return state;
  if (Number.isSafeInteger(event.seq) && event.seq <= state.seq) return state;
  const next = { ...state, seq: Number.isSafeInteger(event.seq) ? event.seq : state.seq };
  const here = Boolean(event.projectId) && event.projectId === state.projectId;
  switch (event.type) {
    case "call": {
      const call = event.event;
      if (!call) return next;
      // A call you approved runs when you click allow: it is not the agent calling.
      if (call.by !== "you" && !call.approved) {
        const { id, name, color, kind } = callAgent(call);
        next.agents = upsert(state.agents, { id, name, color, kind, lastAt: call.at ?? event.at, lastVerb: call.verb, projectId: event.projectId, isError: Boolean(call.isError) }, "id");
      }
      if (event.projectId && state.current !== event.projectId && call.by !== "you") next.current = event.projectId;
      if (event.projectId && event.agent?.stops) next.waitingStops = withWaiting(state, event.projectId, event.agent.stops);
      if (!here) return next;
      next.calls = [...state.calls, call].slice(-CALLS_KEPT);
      if (event.agent) next.agent = event.agent;
      return next;
    }
    case "presence": {
      const presence = event.presence;
      if (!presence?.agent?.id) return next;
      next.live = withPresence(state, event, here);
      // A call that started is work, also while it runs long (a render): the agent reads "working".
      if (presence.phase === "start" && typeof event.at === "string") {
        const { id, name, color, kind } = presence.agent;
        next.agents = upsert(state.agents, { id, name, color, kind, lastAt: event.at, lastVerb: presence.verb, projectId: event.projectId ?? null, isError: false }, "id");
      }
      return next;
    }
    case "comments":
      if (!here || !Array.isArray(event.comments)) return next;
      next.comments = event.comments;
      return next;
    // The person answered or reopened a stop, or undid "stop asking" (POST /api/dashboard/stops).
    case "stops":
      if (!event.projectId || !event.stops) return next;
      next.waitingStops = withWaiting(state, event.projectId, event.stops);
      if (!here) return next;
      next.agent = { ...state.agent, stops: event.stops };
      return next;
    // A judge round was made, picked or finished (backend/agent/judge.mjs).
    case "judge":
      if (!here) return next;
      next.agent = { ...state.agent, judge: event.judge ?? null };
      return next;
    case "note":
      if (!here || !event.note) return next;
      next.agent = { ...state.agent, notes: upsert(state.agent.notes, event.note) };
      return next;
    // The stopped edits: the whole list, so an answered one goes.
    case "stopped":
      if (!here || !Array.isArray(event.stopped)) return next;
      next.agent = { ...state.agent, stopped: event.stopped };
      return next;
    case "document":
      if (!here) return next;
      if (event.rev > (state.record?.revision ?? 0)) {
        next.behind = true;
        next.wantRev = Math.max(state.wantRev ?? 0, event.rev);
      }
      if (event.focus && event.actor !== "you") next.focus = { ...event.focus, rev: event.rev, at: event.at };
      return next;
    case "approval":
      if (!event.approval) return next;
      next.approvals = upsert(state.approvals, event.approval);
      return next;
    case "settings":
      next.settings = event.settings ?? state.settings;
      return next;
    case "hold":
      next.hold = event.hold ?? state.hold;
      return next;
    case "pointing":
      if (here) next.pointing = event.pointing ?? null;
      return next;
    // The building marks changed with no presence (your undo or note ended the agent's turn, or
    // a call you approved saved).
    case "building":
      if (here && Array.isArray(event.building)) next.live = { ...(state.live ?? emptyLive()), building: event.building };
      return next;
    case "crew":
      if (!event.crew || typeof event.crew !== "object") return next;
      next.crew = event.crew;
      return next;
    case "picks":
      next.picks = event.picks ?? null;
      return next;
    case "inspire": case "inspire-ref": case "inspire-live":
      next.inspire = withInspireEvent(state.inspire ?? null, event, state.projectId);
      return next;
    // A preview segment was rendered (backend/preview-scheduler.mjs): the stage asks for its list again.
    case "preview":
      if (here) next.previewSeq = (state.previewSeq ?? 0) + 1;
      return next;
    case "render":
      if (!event.job) return next;
      next.renders = upsert(state.renders, event.job);
      return next;
    default:
      return next;
  }
}

/** The document's new revision arrived (GET /api/projects/<id>). */
export function withRecord(state, record) {
  if (!state || !record || record.document?.id !== state.projectId) return state;
  if (state.record && record.revision < state.record.revision) return state;
  return { ...state, record: { revision: record.revision, document: record.document, updatedAt: record.updatedAt }, behind: (state.wantRev ?? 0) > record.revision };
}

// ---- pane [1] session ---------------------------------------------------------------------

export const pendingApprovals = (state) => (state?.approvals ?? []).filter((approval) => approval.status === "pending");

/**
 * Who the approvals and stops wait for: a wait that names its agent (approval.agent.id, a stop
 * round's agentId) counts for that agent only; an older one, or one saved before the server
 * restarted (its boot is not this one: the id may be another agent's now), counts for every
 * agent of its client (kind).
 */
export function waitingFor(state) {
  const ids = new Set();
  const kinds = new Set();
  const add = (id, client, boot) => {
    if (id && (!boot || !state?.boot || boot === state.boot)) ids.add(id);
    else if (client) kinds.add(client);
  };
  for (const approval of pendingApprovals(state)) add(approval.agent?.id, approval.client, approval.agent?.boot);
  const round = waitingStopOf(state);
  if (round) add(round.agentId, round.client, round.agentBoot);
  for (const { round: other } of otherStops(state)) add(other.agentId, other.client, other.agentBoot);
  return { ids, kinds, has: (agent) => ids.has(agent.id) || kinds.has(agent.kind ?? agent.name) };
}

/** Each connected agent with a state from §5.4: working, needs you, failed or idle. */
export function agentRows(state, now = Date.now()) {
  const waiting = waitingFor(state);
  return (state?.agents ?? []).map((agent) => {
    const row = agentRow(agent);
    const recent = now - Date.parse(row.lastAt) < WORKING_MS;
    const status = waiting.has(row) ? "needs-you" : row.isError && recent ? "failed" : recent ? "working" : "idle";
    return { ...row, status };
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

/** The agents that called kino in the last 20 s (WORKING_MS), newest first. */
export const activeAgents = (state, now = Date.now()) => agentRows(state, now).filter((agent) => now - Date.parse(agent.lastAt) < WORKING_MS);

// What the status line says after an agent's name when it is not at work (agentRows' status).
export const AGENT_STATUS_WORDS = { "needs-you": "needs you", failed: "failed", idle: "idle" };

/**
 * The status line's words for more than one active agent: "2 agents · Nova · Juno needs you",
 * each name followed by its status unless it is working. Null for one or none.
 */
export function activeAgentsText(agents) {
  if (!agents || agents.length < 2) return null;
  return `${agents.length} agents · ${agents.map((agent) => `${agent.name}${AGENT_STATUS_WORDS[agent.status] ? ` ${AGENT_STATUS_WORDS[agent.status]}` : ""}`).join(" · ")}`;
}

/**
 * The agents that went quiet: each one's newest call is in the open project's current turn, it
 * finished 30 s ago or more (QUIET_MS), less than 2 min ago (TURN_GAP_MS), and no approval or
 * stop waits for it. `now` is this computer's clock (data.live.skew makes it the server's).
 * One row per agent, with the key of that quiet spell (this server run and its call) and the
 * notification's words.
 */
export function quietAgents(data, now = Date.now()) {
  const live = data?.live;
  const turn = data?.agent?.turns?.at(-1)?.id;
  if (!live || !turn) return [];
  const serverNow = now - (live.skew ?? 0);
  const waiting = waitingFor(data);
  return Object.values(live.latest ?? {}).filter((presence) => {
    const age = serverNow - Date.parse(presence.at);
    // Not while another of its calls still runs (`running`).
    return presence.phase === "done" && !(presence.running > 0) && presence.turn === turn && age >= QUIET_MS && age < TURN_GAP_MS && !waiting.has(presence.agent);
  }).map((presence) => ({
    // Agent ids and call numbers start over when the server restarts: the key has its boot.
    agent: presence.agent, presence, key: `${data.boot ?? ""}/${presence.agent.id}/${presence.call}`,
    text: `${presence.agent.name} went quiet · ${presence.label || presence.verb}`,
  }));
}

/** The quiet agents not told yet (`told` holds the keys already told); adds theirs to `told`. */
export function quietToTell(data, now, told) {
  const rows = quietAgents(data, now).filter((row) => !told.has(row.key));
  for (const row of rows) told.add(row.key);
  return rows;
}

/** The plan, at most `limit` rows: done steps (✓), the current step (▸) and the rest (·). */
export function planRows(plan, limit = 5) {
  const steps = (plan?.steps ?? []).map((step) => (typeof step === "string" ? { text: step, done: false } : step));
  const current = steps.findIndex((step) => !step.done);
  const rows = steps.map((step, index) => ({ text: step.text, mark: step.done ? "✓" : index === current ? "▸" : "·", state: step.done ? "done" : index === current ? "current" : "todo" }));
  if (rows.length <= limit) return rows;
  // Keep the current step in view.
  const start = Math.max(0, Math.min(rows.length - limit, (current < 0 ? rows.length : current) - 2));
  return rows.slice(start, start + limit);
}

const BRIEF_ORDER = Object.keys(BRIEF_LABELS);
const briefPlace = (name) => (BRIEF_ORDER.includes(name) ? BRIEF_ORDER.indexOf(name) : BRIEF_ORDER.length);
const briefLabel = (name) => BRIEF_LABELS[name] ?? String(name).replaceAll("_", " ");
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** How many layers the open project's document has, in all its scenes, or null before it loads. */
export function videoLayers(state) {
  const scenes = state?.record?.document?.scenes;
  return Array.isArray(scenes) ? scenes.reduce((sum, scene) => sum + (scene.layers?.length ?? 0), 0) : null;
}

/**
 * The brief, read only: the lines the agent saved from its chat with you (`brief` in the agent
 * data, briefSummary in backend/agent/brief.mjs), in the brief's own order. Each line is your words
 * ("you said", with the quote the agent copied) or the agent's guess. kino never sees the chat, so
 * the quotes and the reply count are what the agent recorded, and the panel says so. A wrong line
 * is fixed by telling the agent in the chat. `layers` (videoLayers) says what kino tells the
 * agent when there is no brief (nextStep in brief.mjs): an empty video gets a brief first; one
 * with layers was started without one and gets none, so the panel promises no questions there.
 * `short` is the closed section's summary.
 */
export function briefRows(agent, { layers = null } = {}) {
  const brief = agent?.brief ?? null;
  if (!brief) {
    const empty = layers == null ? "no brief yet"
      : layers > 0 ? "no brief: this video was started without one"
      : "no brief yet: kino tells your agent to ask you in the chat before it builds";
    return { empty, startedWithout: layers > 0, short: "", rev: 0, confirmed: false, noPlayback: null, status: null, replies: null, lines: [], missing: "", fix: "", footnote: "", listLabel: "" };
  }
  const rev = Number(brief.rev) || 0;
  const lines = (brief.lines ?? []).filter((line) => line?.name).sort((a, b) => briefPlace(a.name) - briefPlace(b.name)).map((line) => {
    const label = briefLabel(line.name);
    const text = String(line.text ?? "");
    if (line.by !== "you") return { name: line.name, label, by: "guessed", quote: "", text, sentence: `${label}: guessed by the agent: ${sentence(text)}` };
    const quote = String(line.quote ?? "");
    return { name: line.name, label, by: "you", quote, text, sentence: `${label}: you said, recorded by the agent, "${quote}". The agent reads it as: ${sentence(text)}` };
  });
  // A playback the person answered before any line was saved confirms nothing. With no
  // playback ("just start", or no one could answer) the brief goes on unconfirmed, and says why.
  const confirmed = brief.confirmed === true && rev > 0;
  const noPlayback = !confirmed && typeof brief.noPlayback === "string" && brief.noPlayback ? brief.noPlayback : null;
  const state = confirmed ? "confirmed in chat" : noPlayback ? `no playback: ${noPlayback}` : "not confirmed yet";
  const count = brief.replies?.count ?? 0;
  const limit = brief.replies?.limit ?? 10;
  const missing = [...(brief.missing ?? [])].sort((a, b) => briefPlace(a) - briefPlace(b)).map(briefLabel);
  return {
    // Replies logged but no line saved yet; with no playback, the agent guesses them.
    empty: lines.length ? null : noPlayback ? `no brief lines yet; no playback: ${noPlayback}` : "no brief lines saved yet",
    startedWithout: false,
    short: lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}, ${state}` : "",
    rev,
    confirmed,
    noPlayback,
    status: rev > 0 ? `r${rev} · ${state}` : null,
    replies: `your replies ${count} of ${limit}${count >= limit ? ": the agent makes the other calls" : ""}`,
    lines,
    missing: missing.length ? `missing: ${missing.join(", ")}` : "",
    fix: lines.length ? "a line is wrong? tell your agent in the chat" : "",
    footnote: lines.some((line) => line.by === "you") ? "quotes and replies recorded by the agent; kino cannot check them" : "replies recorded by the agent; kino cannot check them",
    listLabel: `Brief, revision ${rev}, ${confirmed ? "confirmed in chat" : noPlayback ? `no playback: ${noPlayback}` : "not confirmed"}`,
  };
}

// ---- stops (direction plan §6) --------------------------------------------------------------
// The agent asks a stop (notes checkpoint) and kino makes it wait for the person: its ask, the
// revision it showed and, once answered, how (agent.stops, stopsSummary in backend/agent/stops.mjs).
// The person answers in the chat, where the agent records the reply word for word, or here.

/** The stop waiting for you in the open project, or null: {id, kind, rev, askedAt, client, ask, offer}. */
export const waitingStopOf = (state) => state?.agent?.stops?.waiting ?? null;

/**
 * The stops waiting for you in projects that are not open: [{projectId, name, round}]. The person
 * opens the project to answer one, so nothing there is answered unseen.
 */
export function otherStops(state) {
  return Object.entries(state?.waitingStops ?? {}).filter(([project, round]) => round && project !== state.projectId)
    .map(([projectId, round]) => ({ projectId, name: state.projects?.find((entry) => entry.id === projectId)?.name || projectId, round }));
}

/** The open project's ideas from a reference waiting for the person (inspire, F3), or null. */
/** The open judge round of the open project, or null (backend/agent/judge.mjs). */
export const openJudgeOf = (state) => (state?.agent?.judge?.status === "open" ? state.agent.judge : null);
export const waitingIdeasOf = (state) => (state?.inspire?.ideas?.status === "waiting" ? state.inspire.ideas : null);
/** The open project's material questions not answered yet (notes needs, backend/agent/needs.mjs). */
export const openMaterialOf = (state) => (state?.agent?.needs ?? []).filter((need) => need?.status === "open" && Array.isArray(need.options));
/** The option the agent recommends for a material need, from 1 (needs.mjs marks exactly one). */
export const recommendedOption = (need) => Math.max(1, (need?.options ?? []).findIndex((option) => option.recommended) + 1);

/**
 * "needs you", in order: the open project's waiting stop, the stops in other projects, the ideas
 * an agent took from a reference (answered on the inspire screen), an open judge round, the
 * material questions (answered with one of their options), then the pending approvals.
 */
export function needsYouRows(state) {
  const round = waitingStopOf(state);
  const ideas = waitingIdeasOf(state);
  const judge = openJudgeOf(state);
  return [...(round ? [{ type: "stop", projectId: state.projectId, round }] : []), ...otherStops(state).map((entry) => ({ type: "elsewhere", ...entry })),
    ...(ideas ? [{ type: "ideas", projectId: state.projectId, ideas }] : []),
    ...(judge ? [{ type: "judge", projectId: state.projectId, judge }] : []),
    ...openMaterialOf(state).map((need) => ({ type: "material", projectId: state.projectId, need })),
    ...pendingApprovals(state).map((approval) => ({ type: "approval", approval }))];
}

/** A "needs you" row's key, the same while the row stays in the list: "stop/p1/C2", "elsewhere/p2/C1", "ideas/p1/I1", "material/p1/M1", "approval/Q1". */
export const needKey = (row) => (row.type === "approval" ? `approval/${row.approval.id}` : row.type === "ideas" ? `ideas/${row.projectId}/${row.ideas.id}` : row.type === "judge" ? `judge/${row.projectId}/${row.judge.id}`
  : row.type === "material" ? `material/${row.projectId}/${row.need.id}` : `${row.type}/${row.projectId}/${row.round.id}`);

/**
 * The place in `rows` of the "needs you" row a, d, A and D act on: the cursor's row (`cursor`,
 * while pane 1 has the focus), else the first row that is not a stop in another project (that
 * one is answered in its own project), else the first row; -1 when there is none.
 */
export function keyTarget(rows, cursor = null) {
  if (cursor !== null && rows[cursor]) return cursor;
  const here = rows.findIndex((row) => row.type !== "elsewhere");
  return here >= 0 ? here : rows.length ? 0 : -1;
}

/**
 * "needs you" changed from `before` to `rows` while the person looked (a stop answered in the chat
 * left it, a new stop came first). `cursor` in is pane 1's cursor place, or null while pane 1 does
 * not have the focus. Returns `cursor`, the place that keeps the same row under the cursor, and
 * `moved`: the key of the row a, d, A and D act on now when it is not the row they acted on
 * before, else null. The person did not choose a moved row, so the next of those keys names it
 * and answers only when pressed again: a press meant for one row never answers another.
 */
export function needsShift(before, rows, cursor = null) {
  const was = before[keyTarget(before, cursor)];
  const kept = was && cursor !== null ? rows.findIndex((row) => needKey(row) === needKey(was)) : -1;
  const place = kept >= 0 ? kept : cursor === null ? null : Math.min(cursor, Math.max(0, rows.length - 1));
  const now = rows[keyTarget(rows, place)];
  return { cursor: place, moved: was && now && needKey(now) !== needKey(was) ? needKey(now) : null };
}

const NEED_KEYS = { allow: "a", "allow-always": "A", deny: "d", "deny-always": "D" };
const NEED_VERBS = { allow: "allow it once", "allow-always": "always allow it", deny: "deny it", "deny-always": "always deny it" };

/** What a, A, d or D (`action`) says instead of answering a row that moved under it (needsShift). */
export function movedNeedWords(row, action) {
  const key = NEED_KEYS[action] ?? "a";
  const what = row.type === "approval" ? `${row.approval.id} (${cut(row.approval.summary ?? "", 80)})` : row.type === "judge" ? `judge ${row.judge.id}` : row.type === "material" ? `${row.need.id} (${cut(row.need.ask ?? "", 80)})`
    : row.type === "ideas" ? `the ideas from ${cut(row.ideas.title ?? row.ideas.ref, 60)}` : stopName(row.round);
  const verb = row.type === "approval" ? NEED_VERBS[action] : row.type === "material" ? `pick option ${recommendedOption(row.need)}` : "approve it";
  return `"needs you" changed, so nothing was answered: ${key} now acts on ${what}. Press ${key} again to ${verb}.`;
}

/**
 * A skip-under length as typed in settings › stops: the number, never rounded (the server refuses
 * 7.5 with its own message, so the field never shows one length while another is saved), or the
 * text as typed when it is not a number.
 */
export function typedSeconds(value) {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : value;
}

/** "C2 rough cut" */
export const stopName = (round) => `${round.id} ${STOP_WORDS[round.kind] ?? round.kind}`;

/** The checks a waiting stop's ask offers to skip with "stop asking": "the color and sound checks". */
export function offerWords(offer = []) {
  if (!offer.length) return "";
  const kinds = offer.length > 1 ? `${offer.slice(0, -1).join(", ")} and ${offer.at(-1)}` : offer[0];
  return `the ${kinds} check${offer.length > 1 ? "s" : ""}`;
}

// How an answer reads: 'approved in chat: "looks good"', "approved on the dashboard".
function answerWords(answer) {
  const read = READ_WORDS[answer?.read_as] ?? answer?.read_as ?? "answered";
  return `${read} ${answer?.via === "dashboard" ? "on the dashboard" : "in chat"}${answer?.words ? `: "${answer.words}"` : ""}`;
}

// What reopening an answered round asks first (the confirm box) and says to a screen reader.
// A stop waiting now (`waiting`) closes with it: the agent asks the stops again in order.
function reopenFor(round, waiting) {
  const { answer } = round;
  const label = STOP_WORDS[round.kind] ?? round.kind;
  const words = cut(answer.words, 200);
  const closes = waiting ? ` ${stopName(waiting)}, which waits now, closes.` : "";
  if (answer.via === "dashboard") {
    return {
      label: `Reopen ${round.id}: take back your answer (${answer.read_as}). kino tells the agent to ask you again.`,
      question: `Reopen ${round.id} (the ${label})? You take back your answer (${answer.read_as}). kino tells the agent to ask you again.${closes}`,
    };
  }
  const undoes = answer.read_as === "stop asking" ? " The rough cut, color and sound stops ask again for this video." : "";
  return {
    label: `Reopen ${round.id}: the agent recorded "${words}" as ${answer.read_as}. kino tells it to ask you again.`,
    question: `Reopen ${round.id} (the ${label})? The agent recorded "${words}" as ${answer.read_as}. kino tells it to ask you again.${closes}${undoes}`,
  };
}

/**
 * The line under the stop lines when one of them is an answer the agent recorded from the chat
 * (as the brief's footnote says of its quotes), else null.
 */
export function stopFootnote(rows) {
  return rows.some((row) => row.recorded) ? "answers in chat are recorded by the agent; kino cannot check them: reopen one that is not what you said" : null;
}

const STOP_ROWS = 5;

/**
 * The stop lines (the session pane's stops section and the phone's stops card), newest first:
 * "stop asking" while it is on (or once undone) at the top, then the last 5 rounds, one line
 * each: {key, id, status, text, note, reopen, keepAsking, recorded}. `note` says whether the
 * agent has heard your dashboard answer yet: the server marks it heardAt when the agent's next
 * call in this project takes its inbox (a call kino re-ran after you allowed a request takes
 * none). `reopen` ({label, question}) is on an answered round with no later round of its kind,
 * the only one the server reopens. `recorded` marks an answer the agent recorded from the chat.
 */
export function stopRows(state) {
  const stops = state?.agent?.stops;
  const rounds = stops?.rounds ?? [];
  const lines = rounds.map((round, index) => {
    const name = stopName(round);
    const word = STOP_WORDS[round.kind] ?? round.kind;
    const answer = round.answer;
    const row = { key: round.id, id: round.id, kind: round.kind, status: round.status, text: name, note: null, reopen: null, keepAsking: false, recorded: false };
    if (round.status === "waiting") row.text = `${name} · waits for you since ${timeOfDay(round.askedAt)}`;
    else if (round.status === "answered") {
      const after = Number.isFinite(answer?.afterSeconds) ? ` · ${answer.afterSeconds} s after asking` : "";
      // A storyboard answered on the dashboard with notes on single shots names them.
      const shots = answer?.shots?.length ? ` · note${answer.shots.length === 1 ? "" : "s"} on ${shotList(answer.shots.map((shot) => shot.n))}` : "";
      row.text = `${name} · ${answerWords(answer)}${shots}${after} · ${timeOfDay(answer?.at)}${answer?.via === "dashboard" ? "" : " · recorded by the agent"}`;
      row.recorded = answer?.via !== "dashboard";
      if (answer?.via === "dashboard") {
        row.note = answer.heardAt ? `the agent has your answer (${timeOfDay(answer.heardAt)})` : 'tell your agent "go on": it hears your answer with its next call';
      }
      if (answer && !rounds.slice(index + 1).some((later) => later.kind === round.kind)) row.reopen = reopenFor(round, stops?.waiting);
    } else if (round.status === "allowed") row.text = `${name} · allowed by ${round.allowedBy === "chat" ? '"stop asking"' : "your settings"} · ${timeOfDay(round.allowedAt ?? round.askedAt)}`;
    else if (round.status === "lapsed") {
      row.text = `${name} · lapsed: ${round.lapsedBy ? `you reopened ${round.lapsedBy}` : round.lapsedFor ? `this video has no ${word} stop now (${round.lapsedFor})` : `the work changed after it was asked (rev ${round.rev}, then rev ${round.lapsedRev})`}`;
    } else if (round.status === "reopened") row.text = `${name} · reopened ${timeOfDay(round.reopenedAt)} (was: ${answerWords(answer)}); the agent asks again`;
    return row;
  });
  const asking = stops?.stopAsking;
  const askingRow = !asking ? null : asking.undoneAt
    ? { key: "stop-asking", id: asking.stop, status: "undone", text: `stop asking undone ${timeOfDay(asking.undoneAt)}: rough, color and sound ask again`, note: null, reopen: null, keepAsking: false, recorded: false }
    : { key: "stop-asking", id: asking.stop, status: "on", text: `stop asking: rough, color and sound pass for this video · said in chat: "${asking.words}" · recorded by the agent`, note: null, reopen: null, keepAsking: true, recorded: true };
  // The rounds come oldest first: the newest 5, newest first.
  return [...(askingRow ? [askingRow] : []), ...lines.slice(-STOP_ROWS).reverse()];
}

/**
 * What a press on the stop card does, as plain data (the card's buttons and keys,
 * Dashboard.jsx): { send } is the body for answerStop (api.js), { focus } puts the cursor in the
 * note in that mode first, { error } says what is missing. `press` is "approve" (a), "notes"
 * (Tab, approve with a note), "redo" (d, redo with a note) or "enter" (Enter in the note, which
 * sends in the note's `mode`, "notes" or "redo"). Typed words are never dropped: approve with
 * text in the note is approve with notes. `shots` are a storyboard's notes on single shots
 * ([{id, words}], board.jsx): they are notes too, so with one a approves with notes, and the note
 * buttons and Enter send without words. `noCalls` are the agent's calls the person said no to on
 * the board: their words follow the note's ('…; no to your call "…"'), so they are a note too.
 */
export function stopAnswer(round, { press, mode = "notes", text = "", shots = [], noCalls = [] }) {
  const words = [String(text ?? "").trim(), callNoWords(noCalls)].filter(Boolean).join("; ");
  const notes = (shots ?? []).map((shot) => ({ id: shot.id, words: String(shot.words ?? "").trim() })).filter((shot) => shot.words);
  const base = { id: round.id, rev: round.rev };
  const noted = (read_as) => ({ ...base, read_as, ...(words ? { words } : {}), ...(notes.length ? { shots: notes } : {}) });
  if (press === "approve") return { send: words || notes.length ? noted("approve with notes") : { ...base, read_as: "approve" } };
  const wanted = press === "enter" ? mode : press;
  if (words || notes.length) return { send: noted(wanted === "redo" ? "redo" : "approve with notes") };
  if (press !== "enter") return { focus: wanted === "redo" ? "redo" : "notes" };
  return { error: wanted === "redo" ? "Say what to redo first: type it in the note, then press Enter." : "Type the note first, then press Enter, or approve without a note." };
}

/** What the dashboard says once kino took your answer (POST stops answer → 200). */
export function stopAnswered(send) {
  const done = { approve: `${send.id} approved.`, "approve with notes": `${send.id} approved with your note.`, redo: `${send.id}: redo sent with your note.` }[send.read_as];
  return `${done} Tell your agent "go on": it hears your answer with its next call.`;
}

/**
 * What changed in the stops since the last data (`known`: a Map of "<project>/<id>" to the
 * round's status, or null on the first load, which says nothing): a stop that started waiting
 * (`asked`), the round that stopped waiting (`closed`: answered here or in the chat, or closed),
 * rounds the agent recorded a chat answer for (`chat`, each with its words cut to 120
 * characters for the top line and the polite region), and stops that started waiting in
 * projects that are not open (`elsewhere`, from otherStops). A stop already known as waiting,
 * in the open project or another, is never news again: opening its project, or another one,
 * does not announce it. Returns them and the Map to keep.
 */
export function stopChanges(known, state) {
  const next = new Map(known ?? []);
  const rounds = state?.agent?.stops?.rounds ?? [];
  const key = (round) => `${state?.projectId}/${round.id}`;
  const others = otherStops(state);
  const otherKey = (entry) => `${entry.projectId}/${entry.round.id}`;
  const changes = { asked: null, closed: null, chat: [], elsewhere: [], known: next };
  for (const round of rounds) next.set(key(round), round.status);
  for (const entry of others) next.set(otherKey(entry), "waiting");
  if (!known) return changes;
  changes.elsewhere = others.filter((entry) => known.get(otherKey(entry)) !== "waiting");
  const waiting = waitingStopOf(state);
  if (waiting && known.get(key(waiting)) !== "waiting") changes.asked = waiting;
  changes.closed = rounds.findLast((round) => round.status !== "waiting" && known.get(key(round)) === "waiting") ?? null;
  changes.chat = rounds.filter((round) => round.status === "answered" && round.answer?.via === "chat" && known.get(key(round)) === "waiting")
    .map((round) => ({ round, text: `${round.id} ${READ_WORDS[round.answer.read_as] ?? round.answer.read_as} in chat (recorded by the agent): "${cut(round.answer.words, 120)}".` }));
  return changes;
}

// ---- pane [4] log ---------------------------------------------------------------------------

/** One row per agent turn, newest last, each with its calls. */
export function turnRows(state, now = Date.now()) {
  const calls = state?.calls ?? [];
  return (state?.agent?.turns ?? []).map((turn) => {
    const own = calls.filter((call) => call.turn === turn.id);
    const edits = own.filter((call) => call.verb === "edit" && !call.isError);
    const last = own.at(-1);
    const busy = last && now - Date.parse(last.at) < WORKING_MS && !turn.reverted;
    // A turn failed when the last call of some kind (edit, look, …) failed; a retry that worked clears it.
    const lastOfEachVerb = new Map(own.map((call) => [call.verb, call]));
    const failed = [...lastOfEachVerb.values()].some((call) => call.isError);
    // ↻ (the orange ring) marks a turn that put the project back: it ran a history restore or a
    // revert, whose answer starts {"restored": or {"reverted":. A turn that was undone later is
    // "undone" (a dimmed tick) and says "reverted at rev N".
    const restored = own.some((call) => call.verb === "history" && !call.isError && /^\{"(?:restored|reverted)":/.test(String(call.summary ?? "")));
    const symbol = turn.reverted ? "undone" : busy ? "spinner" : failed ? "✕" : restored ? "↻" : "✓";
    const ops = turn.edits.reduce((sum, edit) => sum + (edit.ops ?? 0), 0);
    const shown = edits.at(-1) ?? last;
    const summary = shown ? callSummary(shown) : `${turn.calls} calls`;
    const spent = own.reduce((sum, call) => sum + (call.tokens ?? 0) + (call.inTokens ?? 0), 0);
    return {
      id: turn.id, turn, calls: own, symbol, failed, busy, ops,
      revs: turn.edits.length ? [turn.edits[0].before, turn.edits.at(-1).after] : null,
      summary: turn.reverted ? `reverted at rev ${turn.reverted.rev}` : summary,
      tokens: tokens(spent),
    };
  });
}

// ---- notes ----------------------------------------------------------------------------------

export function noteRows(state) {
  return (state?.agent?.notes ?? []).map((note) => ({ ...note, state: noteState(note), channel: Boolean(note.channelAt) })).reverse();
}

/** Comment threads from share links, newest first: {comment, replies, scene} (scene is a name or null). */
export function commentRows(state) {
  const scenes = state?.record?.document?.scenes ?? [];
  return buildThreads(state?.comments ?? []).reverse().map((thread) => ({
    ...thread,
    scene: scenes.find((entry) => entry.id === thread.comment.sceneId)?.name ?? null,
  }));
}

// ---- pane [3] what the agent saw ------------------------------------------------------------

/** Every image kino returned to the agent, newest first, with the call that returned it. */
export function seenImages(state, limit = 24) {
  const images = [];
  for (const call of [...(state?.calls ?? [])].reverse()) {
    if (call.by === "you") continue;
    (call.images ?? []).forEach((file, place) => {
      // Two looks can give the same file (the same frame asked twice): the key tells them apart.
      if (images.length < limit) images.push({ file, call, key: `${call.at ?? ""} ${call.verb ?? ""} ${place} ${file}` });
    });
    if (images.length >= limit) return images;
  }
  return images;
}

// ---- pane [5] timeline ----------------------------------------------------------------------

/** Seconds as the agent reads them: "2.0", "1.25" (one decimal, or two when needed). */
export function timeText(seconds) {
  const value = Math.round(Number(seconds) * 100) / 100;
  const fixed = value.toFixed(2);
  return fixed.endsWith("0") ? value.toFixed(1) : fixed;
}

/** "2.0–3.5 s" for a range [start, end]. */
export const rangeText = (range) => `${timeText(range[0])}–${timeText(range[1])} s`;

/** What the person points at, as the agent reads it in status (F5), or null. */
export const pointingLine = (pointing) => (pointing?.line ? `the agent sees "pointing ${pointing.line}"` : null);

// A press on the ruler that moves this far (px) points at a time range; a shorter one sets the time.
export const DRAG_PX = 4;

/** The time under x on a ruler that starts at `left` and is `width` px wide: in [0, duration], to 0.01 s. */
export function rulerSeconds(x, left, width, duration) {
  if (!(width > 0) || !(duration > 0)) return 0;
  const seconds = ((x - left) / width) * duration;
  return Math.round(Math.max(0, Math.min(duration, seconds)) * 100) / 100;
}

/**
 * A range pointed at on the timeline: {anchor, end}, where the press started (or the playhead)
 * and where it is now. Its range is [start, end] in order, or null while they are the same.
 */
export function pointRange(point) {
  if (!point) return null;
  const start = Math.min(point.anchor, point.end);
  const end = Math.max(point.anchor, point.end);
  return end - start >= 0.01 ? [start, end] : null;
}

/** A drag on the ruler from x `from` to x `to`: {anchor, end}, or null under DRAG_PX. */
export function dragPoint(from, to, left, width, duration) {
  if (Math.abs(to - from) < DRAG_PX) return null;
  return { anchor: rulerSeconds(from, left, width, duration), end: rulerSeconds(to, left, width, duration) };
}

/**
 * Shift+→ (step 0.1) and Shift+← (−0.1): the range's end moves; with no range it starts at the
 * playhead. The end stays in [0, duration].
 */
export function stepPoint(point, { time, duration, step }) {
  const from = point ?? { anchor: Math.round(time * 100) / 100, end: Math.round(time * 100) / 100 };
  const end = Math.round(Math.max(0, Math.min(duration, from.end + step)) * 100) / 100;
  return { anchor: from.anchor, end };
}

/** One row per layer of a scene: its name and the time its animations span. */
export function timelineRows(scene) {
  if (!scene) return [];
  const depth = (layer) => {
    let level = 0;
    let parent = layer.parentId;
    while (parent && level < 8) {
      level += 1;
      parent = scene.layers.find((entry) => entry.id === parent)?.parentId;
    }
    return level;
  };
  return (scene.layers ?? []).map((layer) => {
    let spans = [];
    try {
      spans = animationTreeEntries(layer.animations ?? [], { enabledOnly: true, groups: false })
        .map(({ animation }) => [Number(animation.start) || 0, (Number(animation.start) || 0) + (Number(animation.duration) || 0)]);
    } catch { spans = []; }
    return { id: layer.id, name: layer.name || layer.type, type: layer.type, depth: depth(layer), visible: layer.visible !== false, spans };
  });
}

/** Where each turn sits on the agent row: in order, sized by its number of calls. */
export function turnChips(state) {
  return (state?.agent?.turns ?? []).slice(-12).map((turn) => ({
    id: turn.id, calls: turn.calls, reverted: Boolean(turn.reverted),
    rev: turn.edits.at(-1)?.after ?? null, before: turn.edits[0]?.before ?? null,
  }));
}

// ---- status line ----------------------------------------------------------------------------

/** kino's own MCP traffic for this project, in tokens, both ways. */
export function trafficTokens(state) {
  return (state?.calls ?? []).filter((call) => call.by !== "you").reduce((sum, call) => sum + (call.tokens ?? 0) + (call.inTokens ?? 0), 0);
}

/** The stops, approvals, renders and errors that need you, for the title, badge and notifications. */
export function attention(state) {
  const approvals = pendingApprovals(state);
  const stop = waitingStopOf(state);
  const elsewhere = otherStops(state);
  const failedRenders = (state?.renders ?? []).filter((job) => job.status === "error" || job.status === "failed");
  return { approvals, stop, elsewhere, failedRenders, count: approvals.length + (stop ? 1 : 0) + elsewhere.length };
}

/**
 * What the variants screen compares (up to six scenes): the variant set of the scene on the
 * stage, else the newest set the variants operation made (the original first, as
 * look {mode:"variants"} shows them), else every scene when the project has no set.
 */
export function variantChoices(document, sceneId = null) {
  const scenes = (document?.scenes ?? []).filter((scene) => !scene.isComponent);
  const set = scenes.find((scene) => scene.id === sceneId)?.variant?.set ?? scenes.filter((scene) => scene.variant?.set).at(-1)?.variant.set ?? null;
  if (!set) return { set: null, scenes: scenes.slice(0, 6) };
  const members = scenes.filter((scene) => scene.variant?.set === set)
    .sort((a, b) => Number(b.variant.of === b.id) - Number(a.variant.of === a.id));
  return { set, scenes: members.slice(0, 6) };
}
