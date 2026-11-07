// The crew: every agent working in kino, who started it, what it may do, what it has spent,
// and the person's start rules (plan section C, the crew screen F2). Saved in
// <data>/agent/crew.json (written atomically, private).
//
// - Agents kino did not start (the person's own Claude Code or Codex, the kino command) join
//   on their first call as leads "started by you", with the id, name and color the live view
//   gave their session (live.mjs). They are not saved across a restart: their ids start over.
// - Agents kino starts (launcher.mjs) get an id "k<n>", a name and color, and a private session
//   that their kino MCP server sends (x-kino-session); live.mjs asks identityFor() for it, so
//   every call of theirs carries this identity. Starters: the person (dashboard), the
//   person's notes (when allowed and no agent works on that project), a lead's notes
//   {action:"helper"} (up to the rules' number of helpers each) and timers (daily at a time,
//   or every N hours).
// - gate() runs before every agent call (service.mjs): a stopped agent is refused, a "look and
//   search only" agent cannot write, a held agent cannot write, and an agent past its budget
//   is held (every call refused) while the person is asked to extend it or stop it (an
//   approval of kind "crew-budget" on the dashboard).
// - Parts of a project an agent changed are held for it (crew-locks.mjs); claim() is called by
//   the service before an agent's save.
// - Activity (started, handed back, needs you, held, released, stopped, the person's notes and
//   holds) is kept for the crew screen's lanes, with times.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocks, LOCK_QUIET_MS } from "./crew-locks.mjs";
import { NAMES, PALETTE } from "./live.mjs";

export const LAUNCH_KINDS = Object.freeze(["claude-code", "codex"]);
export const KIND_WORDS = Object.freeze({ "claude-code": "claude code", codex: "codex", other: "agent" });
export const MAY_WORDS = Object.freeze({ all: "everything", look: "look and search only; no edits" });
export const STATE_WORDS = Object.freeze({
  working: "editing", looking: "looking", "needs-you": "needs you", held: "held", asleep: "asleep", stopped: "stopped", done: "done", idle: "idle",
});
// An agent kino did not start counts as at work this long after its last call (the turn gap).
export const ACTIVE_MS = LOCK_QUIET_MS;
// Ended agents stay on the crew screen this long, and in the file a day.
const SHOWN_AFTER_END_MS = 10 * 60_000;
const KEPT_AFTER_END_MS = 24 * 60 * 60_000;
const ACTIVITY_KEPT = 400;
const ACTIVITY_SHOWN_MS = 30 * 60_000;
const RECENT_CALLS_KEPT = 200;
const TASK_LIMIT = 2000;
const LIMITS = Object.freeze({ atOnce: [1, 12], helpers: [0, 8], calls: [1, 10_000], minutes: [1, 24 * 60], everyHours: [1, 168] });
const SESSION_LENGTH = 24;
const TICK_MS = 15_000;

export class CrewError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The person's start rules. "you" may always start agents. */
export function defaultRules() {
  return { notes: false, leads: { on: true, helpers: 3 }, timers: false, atOnce: 4, budget: { calls: 60, minutes: 15 }, kind: "claude-code" };
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const bad = (message) => new CrewError("bad_input", message, 400);

function whole(value, [min, max], label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw bad(`${label} is a whole number from ${min} to ${max}.`);
  return value;
}

/** A budget {calls, minutes} (both whole numbers); `fallback` fills what is not given. */
export function budgetFrom(value, fallback) {
  if (value == null) return { ...fallback };
  if (!isObject(value)) throw bad("budget is {calls, minutes}.");
  for (const key of Object.keys(value)) if (!["calls", "minutes"].includes(key)) throw bad(`Unknown budget field "${key}". A budget is {calls, minutes}.`);
  return {
    calls: value.calls === undefined ? fallback.calls : whole(value.calls, LIMITS.calls, "budget.calls"),
    minutes: value.minutes === undefined ? fallback.minutes : whole(value.minutes, LIMITS.minutes, "budget.minutes"),
  };
}

/** Applies a change to the start rules (only the fields it names); strict, like the settings. */
export function mergeRules(current, change) {
  if (!isObject(change)) throw bad("The start rules are a JSON object.");
  const next = structuredClone(current);
  for (const key of Object.keys(change))
    if (!["notes", "leads", "timers", "atOnce", "budget", "kind"].includes(key)) throw bad(`Unknown start rule "${key}". The rules are notes, leads, timers, atOnce, budget and kind.`);
  for (const key of ["notes", "timers"]) {
    if (change[key] === undefined) continue;
    if (typeof change[key] !== "boolean") throw bad(`${key} is true or false.`);
    next[key] = change[key];
  }
  if (change.leads !== undefined) {
    if (!isObject(change.leads)) throw bad("leads is {on, helpers}.");
    for (const key of Object.keys(change.leads)) if (!["on", "helpers"].includes(key)) throw bad(`Unknown rule "leads.${key}". leads is {on, helpers}.`);
    if (change.leads.on !== undefined) {
      if (typeof change.leads.on !== "boolean") throw bad("leads.on is true or false.");
      next.leads.on = change.leads.on;
    }
    if (change.leads.helpers !== undefined) next.leads.helpers = whole(change.leads.helpers, LIMITS.helpers, "leads.helpers");
  }
  if (change.atOnce !== undefined) next.atOnce = whole(change.atOnce, LIMITS.atOnce, "atOnce");
  if (change.budget !== undefined) next.budget = budgetFrom(change.budget, next.budget);
  if (change.kind !== undefined) {
    if (!LAUNCH_KINDS.includes(change.kind)) throw bad(`kind is ${LAUNCH_KINDS.join(" or ")}.`);
    next.kind = change.kind;
  }
  return next;
}

/** Rules read from the file: each valid field kept, the rest default. */
function loadRules(stored) {
  let rules = defaultRules();
  if (!isObject(stored)) return rules;
  for (const [key, value] of Object.entries(stored)) {
    try { rules = mergeRules(rules, { [key]: value }); } catch { /* dropped: its default stays */ }
  }
  return rules;
}

/** The kind of agent from its client name: claude-code, codex or other. */
export function crewKind(kind) {
  const text = String(kind ?? "").toLowerCase();
  if (text.includes("claude")) return "claude-code";
  if (text.includes("codex")) return "codex";
  return "other";
}

/**
 * A timer's schedule: {daily: "HH:MM"} (this computer's time) or {everyHours: n}. Returns the
 * clean schedule or throws.
 */
export function scheduleFrom(value) {
  if (!isObject(value)) throw bad('A timer runs daily at a time ({daily:"06:00"}) or every few hours ({everyHours:6}).');
  if (value.daily !== undefined) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value.daily));
    if (!match || value.everyHours !== undefined) throw bad('daily is a time such as "06:00" (24-hour clock).');
    return { daily: value.daily };
  }
  if (value.everyHours !== undefined) return { everyHours: whole(value.everyHours, LIMITS.everyHours, "everyHours") };
  throw bad('A timer runs daily at a time ({daily:"06:00"}) or every few hours ({everyHours:6}).');
}

/** The first run of `schedule` after `from` (ms); `last` is the last run's start (ms) or null. */
export function nextRun(schedule, from, last = null) {
  if (schedule.daily) {
    const [hours, minutes] = schedule.daily.split(":").map(Number);
    const day = new Date(from);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() <= from) day.setDate(day.getDate() + 1);
    return day.getTime();
  }
  const step = schedule.everyHours * 3_600_000;
  const base = last ?? from;
  if (base + step > from) return base + step;
  return from + step - ((from - base) % step);
}

const scheduleWords = (schedule) => (schedule?.daily ? schedule.daily : schedule?.everyHours ? `every ${schedule.everyHours} h` : "");
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const cut = (text, length) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
};

/**
 * The crew. Dependencies:
 * - directory: <data>/agent (crew.json goes there)
 * - publish(event): the dashboard's event stream
 * - launcher: launcher.mjs (start, stop, available, adopt) or null where agents cannot be started
 * - approvals: {request(request) (dashboard.request), pendingFor(agentId) → boolean}
 * - inbox(projectId, {agentId, kind, text}): puts a line in a project's inbox, for one agent
 * - liveNames(): the names the live view gave to sessions now
 * - hold(): the dashboard's hold of all agent writes
 */
export async function createCrew({ directory, now = Date.now, publish = () => null, launcher = null, approvals = null, inbox = async () => {}, liveNames = () => [], hold = () => ({ on: false }), tickMs = TICK_MS } = {}) {
  const file = path.join(directory, "crew.json");
  let rules = defaultRules();
  let members = [];
  let activity = [];
  let nextMember = 1;
  let nextActivity = 1;
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    rules = loadRules(stored?.rules);
    nextMember = Number.isSafeInteger(stored?.nextMember) ? stored.nextMember : 1;
    activity = Array.isArray(stored?.activity) ? stored.activity.slice(-ACTIVITY_KEPT) : [];
    nextActivity = (activity.at(-1)?.id ?? 0) + 1;
    // Agents kino did not start have no identity across a restart; they join again when they call.
    members = (Array.isArray(stored?.members) ? stored.members : []).filter((member) => member?.launched && typeof member.id === "string");
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`[kino] The crew file could not be read, so the crew starts empty: ${error.message}`);
  }
  const locks = createLocks({ now });
  // Each agent's calls in the last 10 minutes, for the lanes ({at, ms, write, error}), in memory.
  const recent = new Map();

  // An agent kino started that was still running when kino stopped: its process is ended
  // (when it is still the same program) and it is marked stopped. A timer sleeps again.
  for (const member of members) {
    if (!["active"].includes(member.status)) continue;
    if (member.process && !member.process.exitedAt) await launcher?.adopt?.(member).catch(() => {});
    if (member.process && !member.process.exitedAt) member.process.exitedAt = iso(now());
    if (member.role === "timer") { member.status = "asleep"; member.heldBy = null; }
    else end(member, "stopped", "kino restarted");
  }
  for (const member of members) if (member.role === "timer" && member.schedule) member.nextRunAt = iso(nextRun(member.schedule, now(), Date.parse(member.lastRunAt ?? "") || null));

  // ---- saving and publishing --------------------------------------------------------------
  let writing = Promise.resolve();
  let saveTimer = null;
  let publishTimer = null;
  function save() {
    const at = now();
    members = members.filter((member) => !member.endedAt || at - Date.parse(member.endedAt) < KEPT_AFTER_END_MS || member.role === "timer");
    activity = activity.filter((entry) => at - Date.parse(entry.at) < KEPT_AFTER_END_MS).slice(-ACTIVITY_KEPT);
    const snapshot = JSON.stringify({ version: 1, rules, nextMember, members: members.filter((member) => member.launched), activity });
    writing = writing.catch(() => {}).then(async () => {
      // Twice: a folder removed between mkdir and the write (a test run tearing down) is made again.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, snapshot, { mode: 0o600 });
          await rename(temporary, file);
          return;
        } catch (error) {
          if (error.code !== "ENOENT" || attempt >= 1) throw error;
        }
      }
    });
    return writing;
  }
  /** Saves soon and tells open dashboards (a burst of calls makes one write and one event). */
  function changed() {
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; save().catch((error) => console.warn(`[kino] The crew could not be saved: ${error.message}`)); }, 200);
      saveTimer.unref?.();
    }
    if (!publishTimer) {
      publishTimer = setTimeout(() => { publishTimer = null; publish({ type: "crew", crew: view() }); }, 100);
      publishTimer.unref?.();
    }
  }
  async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); }
    if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; publish({ type: "crew", crew: view() }); }
    await writing;
  }

  function note(type, member, text = "", extra = {}) {
    const entry = { id: nextActivity++, at: iso(now()), type, agentId: member?.id ?? null, name: member?.name ?? null, color: member?.color ?? null,
      projectId: extra.projectId ?? member?.projectId ?? null, text: cut(text, 300), ...extra };
    activity.push(entry);
    if (activity.length > ACTIVITY_KEPT) activity.shift();
    changed();
    return entry;
  }

  // ---- members --------------------------------------------------------------------------
  const byId = (id) => members.find((member) => member.id === id) ?? null;
  const running = (member) => Boolean(member?.process && !member.process.exitedAt);
  const ended = (member) => member.status === "stopped" || member.status === "done";

  function end(member, status, reason) {
    member.status = status;
    member.endedAt = iso(now());
    member.endReason = reason;
    member.heldBy = null;
    locks.release(member.id);
  }

  // Whether an agent is at work now: a started agent while its process runs, another while it
  // called in the last 2 minutes. Held agents and agents waiting for the person count too.
  function atWork(member, at = now()) {
    if (ended(member) || member.status === "asleep") return false;
    if (member.launched) return running(member);
    return at - Date.parse(member.lastAt ?? "") < ACTIVE_MS;
  }

  function stateOf(member, at = now()) {
    if (member.status === "stopped") return "stopped";
    if (member.status === "done") return "done";
    if (member.status === "asleep") return "asleep";
    if (member.heldBy) return "held";
    if (approvals?.pendingFor?.(member.id)) return "needs-you";
    if (!atWork(member, at)) return "idle";
    return member.last?.write || !member.last ? "working" : "looking";
  }

  /** The identity a launched agent's session gets in the live view, or null. */
  function identityFor(session) {
    if (typeof session !== "string") return null;
    const member = members.find((entry) => entry.session === session);
    return member ? { id: member.id, name: member.name, color: member.color, kind: member.kind } : null;
  }

  // A name and color for a new agent: the first name no agent uses now (live sessions included).
  function newIdentity() {
    const used = new Set([...liveNames(), ...members.filter((member) => !ended(member) || member.role === "timer").map((member) => member.name)]);
    let index = 0;
    while (used.has(`${NAMES[index % NAMES.length]}${index >= NAMES.length ? ` ${Math.floor(index / NAMES.length) + 1}` : ""}`)) index += 1;
    return { name: `${NAMES[index % NAMES.length]}${index >= NAMES.length ? ` ${Math.floor(index / NAMES.length) + 1}` : ""}`, color: PALETTE[(nextMember - 1 + index) % PALETTE.length] };
  }

  /**
   * The member making a call, joining the crew as a lead started by you when it is new.
   * `agent` is the live view's {id, name, color, kind}. A legacy agent (no session) joins too.
   */
  function join(agent, projectId) {
    if (!agent?.id) return null;
    let member = byId(agent.id);
    if (!member) {
      member = {
        id: agent.id, name: agent.name, color: agent.color, kind: crewKind(agent.kind), role: "lead", launched: false,
        startedBy: { type: "you", id: null, name: "you" }, startedAt: iso(now()), task: "", because: null,
        may: "all", budget: null, spent: { calls: 0 }, status: "active", heldBy: null, projectId: projectId ?? null, lastAt: iso(now()), last: null,
      };
      members.push(member);
      note("joined", member, `${member.name} connected`);
    }
    if (projectId) member.projectId = projectId;
    return member;
  }

  // ---- the gate on every agent call -------------------------------------------------------
  const elapsedMinutes = (member, at = now()) => (at - Date.parse(member.runStartedAt ?? member.startedAt)) / 60_000;
  const overBudget = (member, at = now()) => Boolean(member.budget) && (member.spent.calls >= member.budget.calls || elapsedMinutes(member, at) >= member.budget.minutes);

  /**
   * Runs before an agent's call. Returns null to go ahead, or {crew, text, data} for the agent:
   * crew is "stopped", "denied" (it may only look), "budget" (held past its budget) or "held".
   */
  async function gate({ agent, verb, write, projectId }) {
    const member = join(agent, projectId);
    if (!member) return null;
    const at = now();
    member.lastAt = iso(at);
    locks.touch(member.id);
    changed();
    if (ended(member) || member.status === "asleep") {
      return refusal("stopped", member, { stopped: true, next: `The person stopped you (${member.endReason ?? "stopped"}). Nothing was done. End your turn now.` });
    }
    if (write && member.may === "look") {
      return refusal("denied", member, { denied: "look and search only", next: "You may look and search only: kino refuses edits, renders and imports from you. Tell your lead what to change in your final message." });
    }
    if (member.heldBy !== "budget" && overBudget(member, at)) await holdForBudget(member);
    if (member.heldBy === "budget") {
      const spent = `${member.spent.calls} of ${member.budget.calls} calls, ${Math.floor(elapsedMinutes(member, at))} of ${member.budget.minutes} min`;
      return refusal("budget", member, { held: true, budget: member.budget, spent: member.spent.calls,
        next: `Your budget is spent (${spent}). The person was asked to extend it or stop you; nothing was done. Wait, or end your turn with what you found.` });
    }
    if (member.heldBy && write) {
      return refusal("held", member, { held: true, next: "The person held you on the kino dashboard: your writes are refused until they release you. Reads still work." });
    }
    member.spent.calls += 1;
    return null;
  }

  function refusal(crew, member, data) {
    return { crew, data: { crew, agent: member.name, ...data } };
  }

  /** After the agent's call: its last call (the crew screen's "last") and a block for the lanes. */
  function after(agent, { verb, label, summary, isError = false, write = false, ms = 0 }) {
    const member = agent?.id ? byId(agent.id) : null;
    if (!member) return;
    const at = now();
    member.last = { verb, label: cut(label || verb, 120), summary: cut(summary, 160), at: iso(at), isError: Boolean(isError), write: Boolean(write) };
    member.lastAt = iso(at);
    const list = recent.get(member.id) ?? [];
    list.push({ at: iso(at), ms: Math.max(0, Math.round(ms)), write: Boolean(write), error: Boolean(isError), verb: String(verb ?? "") });
    recent.set(member.id, list.filter((entry) => at - Date.parse(entry.at) < SHOWN_AFTER_END_MS).slice(-RECENT_CALLS_KEPT));
    changed();
  }

  // ---- budget, hold and stop --------------------------------------------------------------
  async function holdForBudget(member) {
    member.heldBy = "budget";
    member.heldAt = iso(now());
    member.budgetRound = (member.budgetRound ?? 0) + 1;
    note("needs-you", member, `${member.name} is past its budget (${member.budget.calls} calls or ${member.budget.minutes} min)`);
    if (!approvals?.request) return;
    const answer = await approvals.request({
      kinds: [{ kind: "crew-budget", summary: `${member.name} is past its budget of ${member.budget.calls} calls or ${member.budget.minutes} min: allow ${rules.budget.calls} calls and ${rules.budget.minutes} min more, or deny to stop it` }],
      projectId: member.projectId, verb: "crew", input: { agent: member.id, round: member.budgetRound }, client: member.kind, agent: { id: member.id, name: member.name, color: member.color, kind: member.kind },
    }).catch(() => null);
    if (answer?.status === "allowed") extend(member.id);
    else if (answer?.status === "denied") stop(member.id, { reason: "your rules deny going past a budget" });
    else if (answer?.id) member.budgetApproval = answer.id;
  }

  /** Adds the rules' budget to an agent held past its budget, and lets it go on. */
  function extend(id) {
    const member = byId(id);
    if (!member || !member.budget) throw new CrewError("not_found", `No agent ${id} with a budget.`, 404);
    member.budget = { calls: Math.max(member.budget.calls, member.spent.calls) + rules.budget.calls, minutes: Math.ceil(Math.max(member.budget.minutes, elapsedMinutes(member))) + rules.budget.minutes };
    const wasHeld = member.heldBy === "budget";
    if (wasHeld) member.heldBy = null;
    member.budgetApproval = null;
    note("released", member, `budget extended to ${member.budget.calls} calls, ${member.budget.minutes} min`);
    return { text: `${member.name}'s budget is now ${member.budget.calls} calls and ${member.budget.minutes} min.` };
  }

  /** The person holds (on) or releases (off) one agent. A held agent's writes are refused. */
  async function setHold(id, on) {
    const member = byId(id);
    if (!member) throw new CrewError("not_found", `No agent ${id}.`, 404);
    if (ended(member)) throw new CrewError("ended", `${member.name} has ${member.status === "done" ? "finished" : "stopped"}.`);
    if (on) {
      if (member.heldBy !== "you") { member.heldBy = "you"; member.heldAt = iso(now()); note("held", member, `you held ${member.name}`, { by: "you" }); }
      await inbox(member.projectId, { agentId: member.id, kind: "crew", text: "you are held by the person: your writes are refused until they release you" }).catch(() => {});
    } else if (member.heldBy) {
      // Releasing an agent held past its budget gives it the rules' budget again.
      if (member.heldBy === "budget") extend(member.id);
      else { member.heldBy = null; note("released", member, `you released ${member.name}`, { by: "you" }); }
      await inbox(member.projectId, { agentId: member.id, kind: "crew", text: "released: your writes work again" }).catch(() => {});
    }
    return viewOf(member);
  }

  /** The person stops an agent: its calls are refused from now on and a started one's process ends. */
  async function stop(id, { reason = "stopped by you" } = {}) {
    const member = byId(id);
    if (!member) throw new CrewError("not_found", `No agent ${id}.`, 404);
    if (ended(member) && !running(member)) return viewOf(member);
    // Marked first: the process's end (exited) then knows the person stopped it.
    if (member.role === "timer") {
      // A timer's run ends; the timer sleeps until its next run.
      member.status = "asleep";
      member.heldBy = null;
      locks.release(member.id);
    } else end(member, "stopped", reason);
    note("stopped", member, `${member.name} ${reason}`, { by: "you" });
    if (running(member)) await launcher?.stop(member.id).catch(() => {});
    return viewOf(member);
  }

  // ---- starting agents ----------------------------------------------------------------------
  const helpersOf = (leadId) => members.filter((member) => member.leadId === leadId && atWork(member));
  const atWorkCount = () => members.filter((member) => atWork(member)).length;

  function startedByWords(member) {
    const by = member.startedBy;
    if (by.type === "timer") return `a timer (${scheduleWords(member.schedule)})`;
    if (by.type === "notes") return `the person's note ${by.id ?? ""}`.trim();
    return by.type === "agent" ? `${by.name}, a lead agent` : "the person";
  }

  function prompt(member) {
    const handTo = member.leadId ? byId(member.leadId)?.name ?? "your lead" : "the person";
    return [
      `You are ${member.name}, a ${member.role === "helper" ? "helper" : "kino"} agent that kino started for ${startedByWords(member)}.`,
      `Task: ${member.task}`,
      member.projectId ? `Work in kino project "${member.projectId}": pass project:"${member.projectId}" in every kino call.` : "Call status first to find the project.",
      member.may === "look" ? "You may look and search only (status, look, inspect, check, library, notes list): kino refuses edits, renders and imports from you."
        : "You may use every kino tool.",
      member.budget ? `Budget: ${member.budget.calls} kino calls and ${member.budget.minutes} minutes; past it kino holds you and asks the person.` : "",
      "Use only the kino tools (mcp__kino__*). Start with status. Other agents may hold parts of the project: an edit that answers {waiting, holder} saved nothing; work on another part or wait.",
      `When you are done, end with one short final message saying what you did and found: kino hands it to ${handTo}.`,
    ].filter(Boolean).join("\n");
  }

  /**
   * Starts an agent. `by` is {type: "you" | "notes" | "agent" | "timer", id?, name?}. Throws a
   * CrewError (with an HTTP status) when the rules or this computer do not allow it.
   */
  async function start({ kind, task, may = "all", projectId = null, budget, by = { type: "you" }, leadId = null, timer = null }) {
    const chosen = kind ?? rules.kind;
    if (!LAUNCH_KINDS.includes(chosen)) throw bad(`kind is ${LAUNCH_KINDS.join(" or ")}.`);
    const words = String(task ?? "").trim();
    if (!words || words.length > TASK_LIMIT) throw bad(`The task is 1 to ${TASK_LIMIT} characters.`);
    if (!Object.hasOwn(MAY_WORDS, may)) throw bad('may is "all" or "look" (look and search only).');
    const limit = budgetFrom(budget, rules.budget);
    if (by.type === "notes" && !rules.notes) throw new CrewError("not_allowed", "Your rules do not let your notes start agents.");
    if (by.type === "timer" && !rules.timers) throw new CrewError("not_allowed", "Your rules do not let timers start agents.");
    if (by.type === "agent") {
      if (!rules.leads.on || rules.leads.helpers < 1) throw new CrewError("not_allowed", "The person's rules do not let agents start helpers.");
      if (helpersOf(leadId).length >= rules.leads.helpers) throw new CrewError("not_allowed", `You already have ${rules.leads.helpers} helper${rules.leads.helpers === 1 ? "" : "s"} at work, the most the person's rules allow.`);
    }
    if (atWorkCount() >= rules.atOnce) throw new CrewError("at_limit", `${atWorkCount()} agents are at work, the most at once the person's rules allow (${rules.atOnce}).`);
    if (!launcher) throw new CrewError("unavailable", "This kino cannot start agents.", 503);
    const binary = await launcher.find(chosen);
    if (!binary) throw new CrewError("not_installed", `${chosen === "codex" ? "codex" : "claude"} was not found on this computer's PATH. Install ${KIND_WORDS[chosen]} or start the agent yourself.`, 424);
    let member = timer;
    if (!member) {
      const { name, color } = newIdentity();
      member = { id: `k${nextMember++}`, name, color, launched: true, role: by.type === "agent" ? "helper" : "lead", leadId: by.type === "agent" ? leadId : null };
      members.push(member);
    }
    Object.assign(member, {
      kind: chosen, task: words, may, budget: limit, spent: { calls: 0 }, projectId: projectId ?? member.projectId ?? null,
      startedBy: { type: by.type, id: by.id ?? null, name: by.name ?? (by.type === "notes" ? "your notes" : by.type === "timer" ? scheduleWords(member.schedule) : "you") },
      because: { by: by.type === "agent" ? by.name : by.type === "notes" ? "your notes" : by.type === "timer" ? "timer" : "you", text: cut(words, 300) },
      startedAt: member.role === "timer" ? member.startedAt ?? iso(now()) : iso(now()), runStartedAt: iso(now()),
      status: "active", heldBy: null, endedAt: null, endReason: null, handedBack: null, last: null, lastAt: iso(now()),
      session: randomBytes(18).toString("base64url").slice(0, SESSION_LENGTH),
      process: null,
    });
    try {
      member.process = await launcher.start(member, { binary, prompt: prompt(member) });
    } catch (error) {
      if (member.role === "timer") member.status = "asleep";
      else end(member, "done", `could not start: ${error.message}`);
      note("failed", member, `${member.name} could not start: ${error.message}`);
      throw new CrewError("start_failed", `${member.name} could not start: ${error.message}`, 500);
    }
    note("started", member, `${member.name} started by ${member.startedBy.name}: ${cut(words, 120)}`);
    return viewOf(member);
  }

  /**
   * A started agent's process ended (launcher.mjs). Its final message goes to its lead's inbox
   * ("handed back"); a timer sleeps until its next run.
   */
  async function exited(id, { code = null, signal = null, message = "" } = {}) {
    const member = byId(id);
    if (!member) return;
    if (member.process) Object.assign(member.process, { exitedAt: iso(now()), exitCode: code, signal });
    const text = cut(message, 2000);
    const stoppedByYou = member.status === "stopped" || (member.role === "timer" && member.status === "asleep");
    if (text) {
      member.handedBack = { at: iso(now()), text };
      note("handed-back", member, text);
      const lead = member.leadId ? byId(member.leadId) : null;
      if (lead && member.projectId) await inbox(member.projectId, { agentId: lead.id, kind: "crew", text: `◆ ${member.name} (${member.id}) handed back: ${text}` }).catch(() => {});
    }
    if (member.role === "timer") {
      member.status = "asleep";
      member.heldBy = null;
      locks.release(member.id);
      member.nextRunAt = iso(nextRun(member.schedule, now(), Date.parse(member.lastRunAt ?? "") || null));
    } else if (!stoppedByYou) end(member, "done", code === 0 ? "finished" : `ended (${signal ?? `exit ${code}`})`);
    if (!text && !stoppedByYou && code !== 0) note("stopped", member, `${member.name} ended without a final message (${signal ?? `exit ${code}`})`);
    changed();
  }

  /** A lead asks for a helper (notes {action:"helper"}). */
  async function requestHelper(agent, { projectId, task, may = "all", kind }) {
    const lead = agent?.id ? byId(agent.id) : null;
    if (!lead) throw new CrewError("not_allowed", "Only an agent kino knows can ask for a helper.");
    if (lead.role !== "lead") throw new CrewError("not_allowed", "Only a lead agent may start helpers; a helper hands its work back instead.");
    if (lead.heldBy) throw new CrewError("held", "You are held: you cannot start helpers until the person releases you.");
    if (hold().on) throw new CrewError("held", "The person paused agent writes (hold): no helpers start until it is released.");
    const helperKind = kind ?? (LAUNCH_KINDS.includes(lead.kind) ? lead.kind : rules.kind);
    return start({ kind: helperKind, task, may, projectId: projectId ?? lead.projectId, by: { type: "agent", id: lead.id, name: lead.name }, leadId: lead.id });
  }

  // Whether an agent works on a project now (your notes start one only when none does).
  const worksOn = (projectId) => members.some((member) => member.projectId === projectId && atWork(member));

  /** The person added a note: a "your notes" agent starts when the rules allow and nobody works there. */
  async function noteAdded(projectId, note_) {
    note("note", null, note_?.text ?? "", { projectId, by: "you" });
    if (!rules.notes || worksOn(projectId)) return null;
    try {
      return await start({ task: note_.text, projectId, by: { type: "notes", id: note_.id ?? null, name: "your notes" } });
    } catch (error) {
      note("failed", null, `your note ${note_?.id ?? ""} could not start an agent: ${error.message}`, { projectId });
      return null;
    }
  }

  /** The person's hold of all agent writes went on or off (the dashboard's H). */
  function holdAll(on) {
    note(on ? "hold" : "release", null, on ? "you held every agent" : "you released every agent", { by: "you" });
  }

  // ---- timers -------------------------------------------------------------------------------
  /** Adds a timer: an agent that sleeps and runs `task` on its schedule. */
  function addTimer({ kind, task, may = "all", projectId = null, schedule, budget, name }) {
    const chosen = kind ?? rules.kind;
    if (!LAUNCH_KINDS.includes(chosen)) throw bad(`kind is ${LAUNCH_KINDS.join(" or ")}.`);
    const words = String(task ?? "").trim();
    if (!words || words.length > TASK_LIMIT) throw bad(`The task is 1 to ${TASK_LIMIT} characters.`);
    if (!Object.hasOwn(MAY_WORDS, may)) throw bad('may is "all" or "look" (look and search only).');
    const clean = scheduleFrom(schedule);
    const identity = newIdentity();
    const member = {
      id: `k${nextMember++}`, name: typeof name === "string" && name.trim() ? cut(name, 24) : identity.name, color: identity.color, launched: true, role: "timer", leadId: null,
      kind: chosen, task: words, may, budget: budgetFrom(budget, rules.budget), spent: { calls: 0 }, projectId,
      startedBy: { type: "timer", id: null, name: scheduleWords(clean) }, because: { by: "timer", text: cut(words, 300) },
      startedAt: iso(now()), status: "asleep", heldBy: null, schedule: clean, lastRunAt: null, nextRunAt: iso(nextRun(clean, now())),
      lastAt: null, last: null, process: null, session: null,
    };
    members.push(member);
    note("timer", member, `timer ${member.name}: ${scheduleWords(clean)} · ${cut(words, 80)}`);
    return viewOf(member);
  }

  async function removeTimer(id) {
    const member = byId(id);
    if (!member || member.role !== "timer") throw new CrewError("not_found", `No timer ${id}.`, 404);
    if (running(member)) await launcher?.stop(member.id).catch(() => {});
    locks.release(member.id);
    members = members.filter((entry) => entry !== member);
    note("timer-removed", member, `timer ${member.name} removed`);
    return { removed: id };
  }

  /** Runs each due timer, and holds started agents past their minutes. Called every 15 s. */
  async function tick() {
    const at = now();
    for (const member of members) {
      if (member.status === "active" && member.budget && member.heldBy !== "budget" && running(member) && overBudget(member, at)) await holdForBudget(member).catch(() => {});
      if (member.role !== "timer" || member.status !== "asleep" || !member.nextRunAt || Date.parse(member.nextRunAt) > at) continue;
      member.lastRunAt = iso(at);
      member.nextRunAt = iso(nextRun(member.schedule, at + 1000, at));
      try {
        await start({ kind: member.kind, task: member.task, may: member.may, projectId: member.projectId, budget: member.budget, by: { type: "timer", name: scheduleWords(member.schedule) }, timer: member });
      } catch (error) {
        member.status = "asleep";
        note("skipped", member, `${member.name} did not run: ${error.message}`);
      }
    }
    if (locks.expire()) changed();
  }
  const ticker = tickMs ? setInterval(() => { tick().catch((error) => console.warn(`[kino] The crew timers could not run: ${error.message}`)); }, tickMs) : null;
  ticker?.unref?.();

  // ---- locks ----------------------------------------------------------------------------------
  /**
   * An agent saves a change to `parts` ({key, label}) of a project. Returns null to go ahead,
   * or {waiting, holder} when another agent holds one of them (nothing may be saved).
   */
  function claim(agent, projectId, parts) {
    if (!agent?.id || !projectId || !parts.length) return null;
    const result = locks.claim(projectId, agent.id, parts);
    changed();
    if (result.ok) return null;
    const first = result.waiting[0];
    const holder = byId(first.holder);
    return { waiting: first.label, holder: holder ? `${holder.name} (${holder.id})` : first.holder, parts: result.waiting.map((entry) => entry.label) };
  }

  /** The agent frees what it holds (notes {action:"release"}). Returns the labels freed. */
  function release(agent, projectId = null) {
    const freed = agent?.id ? locks.release(agent.id, { projectId }) : [];
    const member = agent?.id ? byId(agent.id) : null;
    if (freed.length) note("freed", member, `${member?.name ?? "an agent"} released ${freed.join(", ")}`);
    return freed;
  }

  /** A part whose work has ended (no render runs): freed quietly, so nobody waits on a finished render. */
  function settle(projectId, key) {
    if (locks.free(projectId, key)) changed();
  }

  /** The person frees one held part on the dashboard. */
  function free(projectId, key) {
    const entry = locks.free(projectId, key);
    if (!entry) throw new CrewError("not_found", "Nobody holds that part now.", 404);
    const holder = byId(entry.holder);
    note("freed", holder, `you freed ${entry.label} from ${holder?.name ?? entry.holder}`, { projectId, by: "you" });
    if (holder) inbox(projectId, { agentId: holder.id, kind: "crew", text: `the person freed ${entry.label}: another agent may change it now` }).catch(() => {});
    return { freed: entry.label };
  }

  // ---- what the dashboard reads -------------------------------------------------------------
  function viewOf(member, at = now(), held = locks.list()) {
    const state = stateOf(member, at);
    const elapsedMs = member.runStartedAt || member.startedAt ? Math.max(0, (member.process?.exitedAt ? Date.parse(member.process.exitedAt) : at) - Date.parse(member.runStartedAt ?? member.startedAt)) : 0;
    return {
      id: member.id, name: member.name, color: member.color, kind: member.kind, kindWords: KIND_WORDS[member.kind] ?? member.kind,
      role: member.role, leadId: member.leadId ?? null, launched: Boolean(member.launched),
      startedBy: member.startedBy, startedAt: member.startedAt ?? null, task: member.task ?? "", because: member.because ?? null,
      may: member.may, mayWords: MAY_WORDS[member.may], budget: member.budget ?? null,
      spent: { calls: member.spent?.calls ?? 0, ms: member.launched || member.budget ? elapsedMs : null },
      state, stateWords: STATE_WORDS[state], heldBy: member.heldBy ?? null, heldAt: member.heldBy ? member.heldAt ?? null : null,
      budgetApproval: member.heldBy === "budget" ? member.budgetApproval ?? null : null,
      holding: held.filter((entry) => entry.holder === member.id).map((entry) => ({ projectId: entry.projectId, key: entry.key, label: entry.label })),
      waitingFor: held.filter((entry) => entry.waiting.some((waiter) => waiter.agentId === member.id)).map((entry) => ({ projectId: entry.projectId, key: entry.key, label: entry.label, holder: entry.holder })),
      projectId: member.projectId ?? null, last: member.last ?? null, lastAt: member.lastAt ?? null,
      handedBack: member.handedBack ?? null, endedAt: member.endedAt ?? null, endReason: member.endReason ?? null,
      process: member.process ? { pid: member.process.pid ?? null, running: running(member), startedAt: member.process.startedAt ?? null, exitedAt: member.process.exitedAt ?? null, exitCode: member.process.exitCode ?? null } : null,
      ...(member.role === "timer" ? { schedule: member.schedule, scheduleWords: scheduleWords(member.schedule), nextRunAt: rules.timers ? member.nextRunAt ?? null : null, lastRunAt: member.lastRunAt ?? null } : {}),
      calls: recent.get(member.id) ?? [],
    };
  }

  /**
   * Everything the crew screen shows: the members (tree order: leads, each followed by its
   * helpers, then timers), the held parts, the rules, the activity of the last 30 minutes,
   * the counts for the top line and which agents this computer can start.
   */
  function view() {
    const at = now();
    const held = locks.list();
    const shown = members.filter((member) => member.role === "timer" || !member.endedAt || at - Date.parse(member.endedAt) < SHOWN_AFTER_END_MS)
      .filter((member) => member.launched || atWork(member, at) || at - Date.parse(member.lastAt ?? "") < ACTIVITY_SHOWN_MS);
    const ordered = [];
    const leads = shown.filter((member) => member.role === "lead");
    for (const lead of leads) {
      ordered.push(lead);
      for (const helper of shown.filter((member) => member.role === "helper" && member.leadId === lead.id)) ordered.push(helper);
    }
    for (const helper of shown.filter((member) => member.role === "helper" && !leads.some((lead) => lead.id === member.leadId))) ordered.push(helper);
    for (const timer of shown.filter((member) => member.role === "timer")) ordered.push(timer);
    const rows = ordered.map((member) => viewOf(member, at, held));
    const name = (id) => byId(id);
    return {
      now: iso(at),
      rules: { you: true, ...structuredClone(rules) },
      members: rows,
      locks: held.map((entry) => ({
        ...entry, holderName: name(entry.holder)?.name ?? entry.holder, holderColor: name(entry.holder)?.color ?? null,
        waiting: entry.waiting.map((waiter) => ({ ...waiter, name: name(waiter.agentId)?.name ?? waiter.agentId, color: name(waiter.agentId)?.color ?? null })),
      })),
      activity: activity.filter((entry) => at - Date.parse(entry.at) < ACTIVITY_SHOWN_MS).slice(-200),
      counts: {
        working: rows.filter((row) => ["working", "looking"].includes(row.state)).length,
        needsYou: rows.filter((row) => row.state === "needs-you" || row.budgetApproval).length,
        held: rows.filter((row) => row.state === "held").length,
        atWork: members.filter((member) => atWork(member, at)).length,
      },
      canStart: launcher ? launcher.available() : { "claude-code": false, codex: false },
    };
  }

  async function updateRules(change) {
    rules = mergeRules(rules, change);
    note("rules", null, "you changed who may start agents", { by: "you" });
    // Timers' next runs show again (or go) with the timers rule.
    return { ...structuredClone(rules), you: true };
  }

  function close() {
    if (ticker) clearInterval(ticker);
  }

  return {
    identityFor, join, gate, after, claim, release, free, settle, start, exited, requestHelper, noteAdded, holdAll,
    extend, setHold, stop, addTimer, removeTimer, tick, updateRules, rules: () => structuredClone(rules),
    names: () => members.filter((member) => !ended(member) || member.role === "timer").map((member) => member.name),
    view, member: (id) => { const member = byId(id); return member ? viewOf(member) : null; }, folder: (id) => byId(id)?.process?.folder ?? null,
    changed, flush, close,
  };
}
