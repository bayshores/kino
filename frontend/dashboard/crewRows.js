// The crew screen's data (F2, crew.jsx). Plain data in, plain data out, so it is easy to test
// (frontend/dashboardCrew.test.js, backend/crew.test.mjs). The crew's data (data.crew, from
// backend/agent/crew.mjs: who started each agent, its task, limits and budget, its calls of the
// last 10 minutes, held parts, start rules, activity) is turned into the screen's five boxes:
// crewTable and crewTree (1 crew), crewDetail and crewMood (2 <agent>), crewLaneRows (3 last
// 10 min) and crewHolds (4 who holds what); box 5 (who may start agents) edits data.crew.rules
// directly. Your own
// answers on your lane come from the dashboard's calls and approvals (yourMarks). Agents the crew
// does not know (it keeps only the agents kino started across a restart) but whose calls the
// open project saved join it as idle leads (withSavedAgents), as on the stage screen.
import { cut } from "./format.js";
import { callAgent, otherStops, pendingApprovals, waitingStopOf } from "./state.js";
import { verbKind } from "./agentView.js";

// The lanes show this much time, ending now.
export const LANE_MS = 10 * 60_000;

const time = (iso) => Date.parse(iso ?? "");

// ---- the crew (data.crew, backend/agent/crew.mjs view) -----------------------------------------

const ROLE_WORDS = { lead: "lead", helper: "helper", timer: "on a timer" };

/** "2:10": minutes and seconds of `ms`. */
export function minutesText(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The crew's members (data.crew.members) and, after them (before the timers), each agent of the
 * open project's saved calls that the crew does not know by id or name, newest call first. kino
 * did not start those (it keeps the agents it started across a restart, and an agent that
 * connects on its own joins again only with its next call), so each is a lead started by "you",
 * as the crew says of an agent that connected on its own. It is "needs you" while an approval or
 * stop of its waits, else idle; its calls are the saved ones; it holds nothing (holds end with a
 * restart). `fromCalls: true` marks it: kino cannot hold or stop an agent that is not connected.
 */
export function crewMembers(data, now = Date.now()) {
  const members = data?.crew?.members ?? [];
  const known = new Set(members.flatMap((member) => [member.id, member.name]));
  const saved = new Map();
  for (const call of data?.calls ?? []) {
    if (call?.by === "you" || call?.approved) continue;
    const agent = callAgent(call);
    if (known.has(agent.id) || known.has(agent.name)) continue;
    const entry = saved.get(agent.id) ?? { agent, calls: [] };
    entry.agent = agent;
    entry.calls.push(call);
    saved.set(agent.id, entry);
  }
  if (!saved.size) return members;
  // What waits for you, by the agent that asked: its id (saved with the request), else, for a
  // request that names no agent, its client. (The saved calls' ids are of the same kino run as
  // the requests', so the id is the agent's even after a restart.)
  const asks = [
    ...pendingApprovals(data).map((approval) => ({ id: approval.agent?.id ?? null, kind: approval.client ?? null })),
    ...[waitingStopOf(data), ...otherStops(data).map((entry) => entry.round)].filter(Boolean).map((round) => ({ id: round.agentId ?? null, kind: round.client ?? null })),
  ];
  const start = now - LANE_MS;
  const added = [...saved.values()].map(({ agent, calls }) => {
    const last = calls.at(-1);
    const needs = asks.some((ask) => (ask.id ? ask.id === agent.id : ask.kind && ask.kind === agent.kind));
    const state = needs ? "needs-you" : "idle";
    return {
      id: agent.id, name: agent.name, color: agent.color, kind: agent.kind, kindWords: agent.kind, role: "lead", leadId: null, launched: false, fromCalls: true,
      startedBy: { type: "you", id: null, name: "you" }, startedAt: null, task: needs ? "ready for you" : "", because: null, may: "all", mayWords: "everything",
      budget: null, spent: { calls: calls.length, ms: null }, state, stateWords: needs ? "needs you" : "idle", heldBy: null, holding: [], waitingFor: [],
      projectId: data?.projectId ?? null, lastAt: last.at ?? null,
      last: { verb: last.verb, label: last.label ?? last.verb, summary: last.summary ?? "", at: last.at ?? null, isError: Boolean(last.isError) },
      calls: calls.filter((call) => time(call.at) >= start).map((call) => ({ at: call.at, ms: Number(call.ms) || 0, write: verbKind(call.verb) === "write", error: Boolean(call.isError), verb: call.verb ?? "" })),
    };
  }).sort((a, b) => time(b.lastAt) - time(a.lastAt));
  const timers = members.findIndex((member) => member.role === "timer");
  return timers < 0 ? [...members, ...added] : [...members.slice(0, timers), ...added, ...members.slice(timers)];
}

/**
 * The data with its crew's members from crewMembers and the top line's counts from them: the
 * crew screen's one source, so its table, lanes and counts agree with the stage screen.
 */
export function withSavedAgents(data, now = Date.now()) {
  if (!data?.crew) return data;
  const members = crewMembers(data, now);
  if (members === data.crew.members) return data;
  return { ...data, crew: { ...data.crew, members } };
}

/**
 * The "1 crew" table: you first, then each lead with its helpers under it, then timers.
 * [{ id, name, color, role, roleWords, depth (0 you, 1 lead or timer, 2 helper), last (the last
 * row at its depth under its parent, for └), startedBy, doing, state, holding }]
 */
export function crewTable(data) {
  const members = data?.crew?.members ?? [];
  const rows = [{ id: "you", name: "you", color: null, role: "you", roleWords: "", depth: 0, last: false, startedBy: "", doing: "", state: "you", holding: "" }];
  const byId = new Map(members.map((member) => [member.id, member]));
  members.forEach((member, index) => {
    const depth = member.role === "helper" && byId.has(member.leadId) ? 2 : 1;
    const later = members.slice(index + 1);
    const last = depth === 2 ? !later.some((other) => other.role === "helper" && other.leadId === member.leadId) : !later.some((other) => other.role !== "helper" || !byId.has(other.leadId));
    rows.push({
      id: member.id, name: member.name, color: member.color, role: member.role, roleWords: ROLE_WORDS[member.role] ?? member.role, depth, last,
      startedBy: member.role === "timer" ? member.scheduleWords ?? "" : member.startedBy?.type === "agent" ? (byId.get(member.startedBy.id)?.name ?? member.startedBy.name ?? "") : member.startedBy?.name ?? "you",
      doing: member.stateWords ?? member.state, state: member.state,
      holding: (member.holding ?? []).map((part) => part.label).join(", ") || "-",
    });
  });
  return rows;
}

// A call's summary in words: some answers are JSON ({"status":"awaiting_approval","id":"Q1",…}),
// possibly cut short, so their words are read with a pattern.
export function plainSummary(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("{")) return raw;
  const field = (name) => raw.match(new RegExp(`"${name}":"([^"]*)"`))?.[1];
  if (field("status") === "awaiting_approval") return `waits for you${field("id") ? ` (${field("id")})` : ""}`;
  return field("summary") ?? field("text") ?? field("status") ?? "";
}

/**
 * The "2 <agent>" pane for one member: its task, who started it and when, because, may,
 * holding, spent (calls and time against its budget, 0–1 for the bars) and its last call.
 */
export function crewDetail(member, now = Date.now()) {
  if (!member) return null;
  const budget = member.budget;
  const ms = member.spent?.ms;
  const last = member.last;
  return {
    title: member.task || (member.role === "lead" && !member.launched ? "working with you" : ""),
    started: member.role === "timer" ? `a timer${member.scheduleWords ? `, ${member.scheduleWords.startsWith("every") ? member.scheduleWords : `daily at ${member.scheduleWords}`}` : ""}`
      : `started by ${member.startedBy?.name ?? "you"}${member.startedAt ? `, ${agoWords(member.startedAt, now)}` : ""}`,
    because: member.because ? `${member.because.by}: "${member.because.text}"` : "",
    may: member.mayWords ?? "",
    holding: (member.holding ?? []).map((part) => part.label).join(", ") || "nothing",
    spent: {
      calls: member.spent?.calls ?? 0,
      callsText: budget ? `${member.spent?.calls ?? 0} / ${budget.calls} calls` : `${member.spent?.calls ?? 0} calls`,
      callsShare: budget ? Math.min(1, (member.spent?.calls ?? 0) / budget.calls) : null,
      timeText: ms == null ? "" : budget ? `${minutesText(ms)} / ${budget.minutes} min` : minutesText(ms),
      timeShare: budget && ms != null ? Math.min(1, ms / (budget.minutes * 60_000)) : null,
    },
    // The call in words; its answer (often a long receipt) goes in the tooltip.
    last: last ? `${last.verb} ${cut(last.label && last.label !== last.verb ? last.label : "", 50)}`.replace(/ +/g, " ").trim()
      // An agent known from saved calls may have last called hours ago: say when.
      + (member.fromCalls && last.at ? `, ${agoWords(last.at, now)}` : "") : "",
    lastAnswer: last ? plainSummary(last.summary) : "",
    handedBack: member.handedBack?.text ?? "",
    nextRunAt: member.nextRunAt ?? null,
  };
}

/**
 * The "4 who holds what" rows for a project: each held part with its holder and who waits, and
 * "render" as free when nobody renders. [{ key, label, holder: {id, name, color} | null, waiting }]
 */
export function crewHolds(data, projectId = data?.projectId) {
  const locks = (data?.crew?.locks ?? []).filter((entry) => !projectId || entry.projectId === projectId);
  const rows = locks.map((entry) => ({
    key: entry.key, label: entry.label, holder: { id: entry.holder, name: entry.holderName, color: entry.holderColor },
    waiting: entry.waiting.map((waiter) => ({ id: waiter.agentId, name: waiter.name, color: waiter.color })),
  }));
  if (!rows.some((row) => row.key === "render")) rows.push({ key: "render", label: "render", holder: null, waiting: [] });
  return rows;
}

/**
 * The "3 last 10 min" marks from the crew's activity, per agent and for you:
 * { agents: {[id]: [{key, x, type, text}]}, you: [{key, x, type, text}], held: {[id]: [{x, width}]} }.
 * type: started, handed-back, needs-you, held, released, stopped, note, hold, release, failed, …
 */
export function crewMarks(data, now = Date.now()) {
  const start = now - LANE_MS;
  const agents = {};
  const you = [];
  const held = {};
  const open = {};
  for (const entry of data?.crew?.activity ?? []) {
    const at = time(entry.at);
    if (entry.type === "held" && entry.agentId) open[entry.agentId] = at;
    if ((entry.type === "released" || entry.type === "stopped") && entry.agentId && open[entry.agentId] != null) {
      if (at >= start) (held[entry.agentId] ??= []).push({ x: place(Math.max(open[entry.agentId], start), start), width: place(at, start) - place(Math.max(open[entry.agentId], start), start) });
      delete open[entry.agentId];
    }
    if (!Number.isFinite(at) || at < start || at > now + 1000) continue;
    const mark = { key: `a${entry.id}`, x: place(at, start), type: entry.type, text: entry.text };
    if (entry.by === "you" || !entry.agentId) you.push(mark);
    else (agents[entry.agentId] ??= []).push(mark);
  }
  for (const [id, from] of Object.entries(open)) (held[id] ??= []).push({ x: place(Math.max(from, start), start), width: 1 - place(Math.max(from, start), start), open: true });
  return { agents, you, held };
}

// Where a moment sits on a lane, from 0 (10 min ago) to 1 (now).
const place = (ms, start) => Math.max(0, Math.min(1, (ms - start) / LANE_MS));

// The words for your own calls (by "you"), by verb.
const YOUR_VERB_WORDS = { notes: "note", history: "undo", render: "export", project: "project", check: "check" };

/**
 * What you did in the last 10 minutes, oldest first: your calls (notes, undo, export…), the
 * requests you answered, the stops you answered or reopened, and the hold you turned on.
 * [{ key, at, x, word }]
 */
export function yourMarks(data, start, now) {
  const marks = [];
  const add = (key, at, word) => {
    const ms = time(at);
    if (Number.isFinite(ms) && ms >= start && ms <= now + 1000) marks.push({ key, at, x: place(ms, start), word });
  };
  for (const [index, call] of (data?.calls ?? []).entries()) {
    if (call?.by === "you") add(`y${index}`, call.at, YOUR_VERB_WORDS[call.verb] ?? call.verb);
  }
  // allowed and denied are your answers; canceled and replaced are not (the agent withdrew it).
  for (const approval of data?.approvals ?? []) {
    if (approval.status === "allowed" || approval.status === "denied") add(`a${approval.id}`, approval.answeredAt, approval.status === "allowed" ? "allow" : "deny");
  }
  for (const round of data?.agent?.stops?.rounds ?? []) {
    if (round.answer?.via === "dashboard") add(`s${round.id}`, round.answer.at, "stop");
    if (round.reopenedAt) add(`r${round.id}`, round.reopenedAt, "reopen");
  }
  if (data?.hold?.on) add("hold", data.hold.since, "hold");
  return marks.sort((a, b) => time(a.at) - time(b.at));
}

// ---- the F2 screen's rows from the crew (data.crew) ---------------------------------------------

/** "just now", "40 s ago", "4 min ago", "2 h ago", "3 d ago": how long ago, in words. */
export function agoWords(iso, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - time(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

// A crew state (crew.mjs STATE_WORDS) as a bot mood (bot.js MOODS).
const STATE_MOODS = { working: "work", looking: "look", "needs-you": "wait", held: "held", asleep: "sleep", stopped: "idle", done: "done", idle: "idle" };

/** The mood of a crew member's bot. The hold of all agent writes holds everyone at work too. */
export function crewMood(member, holdOn = false) {
  if (!member) return "idle";
  if (holdOn && ["working", "looking"].includes(member.state)) return "held";
  return STATE_MOODS[member.state] ?? "idle";
}

/**
 * The tree lines in front of each name in "1 crew": "├" or "└" for a lead or a timer, and
 * "│ ├", "│ └" (or "  ├" under the last lead) for a helper. Takes crewTable's rows.
 */
export function crewTree(rows) {
  let leadLast = false;
  return rows.map((row) => {
    if (row.depth === 0) return "";
    if (row.depth === 1) { leadLast = row.last; return row.last ? "└" : "├"; }
    return `${leadLast ? " " : "│"} ${row.last ? "└" : "├"}`;
  });
}

/** "06:00": a time of day on this computer, from an ISO time. */
export function clockOf(iso) {
  const date = new Date(iso ?? "");
  return Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Calls closer together than this (and of one kind) are drawn as one block: a run of work.
export const RUN_GAP_MS = 15_000;

// The words on your lane for what you did (crew activity by you).
const YOUR_CREW_WORDS = { note: "note", hold: "hold all", release: "release all", held: "hold", released: "release", stopped: "stop", freed: "free", rules: "rules" };

/**
 * "3 last 10 min": one lane for you and one per agent of "1 crew" (its rows, crewTable), from
 * the crew's data. Times are 0 (10 min ago) to 1 (now).
 * { you: [{key, x, word}], lanes: [{id, name, color, state, blocks, waits, held, marks, note}],
 *   links: [{key, x, from, to, type}] (lane numbers: a helper's start from its lead's lane, a
 *   hand-back from the helper's lane to its lead's) }
 * - blocks: runs of calls [{key, x, width, kind: "edit" | "look" | "render", error, label (its verbs)}]
 * - waits: requests to the person [{key, x, width, open, label}]
 * - held: held stretches [{key, x, width, open}]
 * - marks: [{key, x, type: "started" | "handed-back"}] (a hand-back's ◆ is on the lead's lane)
 * - note: a timer's next run ("Orion runs again at 06:00") or why it will not run
 */
export function crewLaneRows(data, rows, now = Date.now()) {
  const start = now - LANE_MS;
  const crew = data?.crew;
  const members = new Map((crew?.members ?? []).map((member) => [member.id, member]));
  const shown = rows.filter((row) => row.depth > 0 && members.has(row.id));
  const lane = new Map(shown.map((row, index) => [row.id, index]));
  const marks = crewMarks(data, now);
  const you = marks.you.filter((mark) => YOUR_CREW_WORDS[mark.type]).map((mark) => ({ key: mark.key, x: mark.x, word: YOUR_CREW_WORDS[mark.type] }));
  // Your answers to requests and stops, your undos and exports (notes and holds come from above).
  for (const mark of yourMarks(data, start, now)) if (!["note", "hold"].includes(mark.word)) you.push({ key: mark.key, x: mark.x, word: mark.word });
  you.sort((a, b) => a.x - b.x);
  const links = [];
  const lanes = shown.map((row) => {
    const member = members.get(row.id);
    // Runs of calls: one block per stretch of calls of one kind with gaps under RUN_GAP_MS.
    const runs = [];
    let run = null;
    for (const call of member.calls ?? []) {
      const end = time(call.at);
      if (!Number.isFinite(end) || end < start) continue;
      const from = Math.max(start, end - Math.max(0, Number(call.ms) || 0));
      const kind = call.verb === "render" ? "render" : call.write ? "edit" : "look";
      if (run && run.kind === kind && from - run.end < RUN_GAP_MS) { run.end = Math.max(run.end, end); run.error ||= Boolean(call.error); if (call.verb && !run.verbs.includes(call.verb)) run.verbs.push(call.verb); continue; }
      run = { kind, from, end, error: Boolean(call.error), verbs: call.verb ? [call.verb] : [] };
      runs.push(run);
    }
    const waits = (data?.approvals ?? []).filter((approval) => approval.agent?.id === member.id).flatMap((approval) => {
      const from = time(approval.createdAt);
      const open = approval.status === "pending";
      const end = open ? now : time(approval.answeredAt);
      if (!Number.isFinite(from) || !Number.isFinite(end) || end < start) return [];
      return [{ key: `w${approval.id}`, x: place(from, start), width: place(end, start) - place(from, start), open, label: open ? "needs you" : approval.status }];
    });
    const laneMarks = [];
    for (const mark of marks.agents[member.id] ?? []) {
      const lead = member.leadId && lane.has(member.leadId) ? member.leadId : null;
      if (mark.type === "started") {
        laneMarks.push({ key: mark.key, x: mark.x, type: "started", on: member.id });
        if (lead) links.push({ key: `l${mark.key}`, x: mark.x, from: lane.get(lead), to: lane.get(member.id), type: "started" });
      }
      if (mark.type === "handed-back") {
        laneMarks.push({ key: mark.key, x: mark.x, type: "handed-back", on: lead ?? member.id, color: member.color ?? null, by: member.name });
        if (lead) links.push({ key: `l${mark.key}`, x: mark.x, from: lane.get(member.id), to: lane.get(lead), type: "handed-back" });
      }
    }
    let note = "";
    if (member.role === "timer") {
      if (member.nextRunAt) note = `${member.name} runs again at ${clockOf(member.nextRunAt)}`;
      else if (crew?.rules && !crew.rules.timers) note = `${member.name} waits: timers may not start agents`;
    }
    return {
      id: member.id, name: member.name, color: member.color ?? null, state: member.state,
      blocks: runs.map((block, index) => ({ key: `b${index}`, x: place(block.from, start), width: place(block.end, start) - place(block.from, start), kind: block.kind, error: block.error, label: block.verbs.join(" · ") })),
      waits, held: (marks.held[member.id] ?? []).map((span, index) => ({ key: `h${index}`, open: false, ...span })), marks: laneMarks, note,
    };
  });
  // A hand-back's ◆ is drawn on its lead's lane.
  for (const each of lanes) {
    for (const mark of each.marks.filter((entry) => entry.on !== each.id)) {
      lanes[lane.get(mark.on)].marks.push({ ...mark, key: `${mark.key}-on` });
      each.marks.splice(each.marks.indexOf(mark), 1);
    }
  }
  return { start, end: now, you, lanes, links };
}

/** One sentence for screen readers about "3 last 10 min" (the lanes are hidden from them). */
export function crewLanesSummary(laneRows) {
  const parts = laneRows.lanes.map((each) => {
    const edits = each.blocks.filter((block) => block.kind === "edit").length;
    const renders = each.blocks.filter((block) => block.kind === "render").length;
    const looks = each.blocks.length - edits - renders;
    const words = [];
    if (edits) words.push(`${edits} edit run${edits === 1 ? "" : "s"}`);
    if (looks) words.push(`${looks} look run${looks === 1 ? "" : "s"}`);
    if (renders) words.push(`${renders} render${renders === 1 ? "" : "s"}`);
    if (each.waits.some((wait) => wait.open)) words.push("needs you");
    if (each.held.some((span) => span.open)) words.push("held");
    if (each.marks.some((mark) => mark.type === "handed-back")) words.push("a helper handed back");
    if (each.note) words.push(each.note);
    return `${each.name}: ${words.join(", ") || "nothing"}`;
  });
  if (laneRows.you.length) parts.unshift(`you: ${laneRows.you.map((mark) => mark.word).join(", ")}`);
  return `Last 10 minutes. ${parts.join("; ") || "Nothing yet"}.`;
}

// ---- the agents pane's cards and the plan box (crew.jsx) ---------------------------------------

/**
 * A member's plan: the open project's plan (data.agent.plan) belongs to the leads working on that
 * project (a plan names no agent). Helpers and timers have none. [{text, done}] or null.
 */
export function planOf(member, data) {
  const steps = data?.agent?.plan?.steps ?? [];
  if (!member || member.role !== "lead" || !steps.length) return null;
  if (member.projectId && data?.projectId && member.projectId !== data.projectId) return null;
  return steps.map((step) => (typeof step === "string" ? { text: step, done: false } : { text: step.text, done: Boolean(step.done) }));
}

/**
 * One agent card: its step bars and "step 3/5" from its plan, and what it does now
 * ("edit · add sound-16-whoosh") from its last call while it works, else its state words.
 * { steps: ["done" | "now" | "next"] | null, stepText, now }
 */
export function crewCard(member, plan) {
  if (!member) return null;
  const current = plan ? plan.findIndex((step) => !step.done) : -1;
  const steps = plan ? plan.map((step, index) => (step.done ? "done" : index === current ? "now" : "next")) : null;
  const stepText = plan ? `step ${current < 0 ? plan.length : current + 1}/${plan.length}` : "";
  const last = member.last;
  const label = last?.label && last.label !== last.verb ? cut(last.label, 40) : "";
  const now = ["working", "looking"].includes(member.state) && last ? [last.verb, label].filter(Boolean).join(": ") : member.stateWords ?? member.state ?? "";
  return { steps, stepText, now };
}
