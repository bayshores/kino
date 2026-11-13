// The F1 stage screen's facts about one agent, as plain functions (tested in
// frontend/dashboardAgentView.test.js). The React side is agentPane.jsx (the right pane: the agent's
// bot, task, plan step, log, why and next) and the top line in Dashboard.jsx.
import { callAgent, agentRows, needsYouRows, recommendedOption, WORKING_MS, timeText } from "./state.js";
import { callLine, cut, timeOfDay } from "./format.js";
import { APPROVAL_WORDS, STOP_WORDS } from "./words.js";
import { agoWords } from "./timeline.js";

// The verbs that change the project are drawn in the agent's color; reads in the text color.
const WRITE_VERBS = new Set(["edit", "history", "render", "project", "notes"]);
export const verbKind = (verb, isError = false) => (isError ? "err" : WRITE_VERBS.has(verb) ? "write" : "read");

/**
 * The agent of this project's saved calls: the newest call of `agentId` (or of any agent), as an
 * agent row that is idle, or "needs-you" while something it asked for waits for you. After kino
 * restarts no agent is connected yet, but the calls are kept, so the pane still shows who worked
 * here and what it did. Null without such a call.
 */
export function agentOfCalls(data, agentId = null) {
  const call = [...(data?.calls ?? [])].reverse().find((entry) => entry.by !== "you" && !entry.approved && (!agentId || callAgent(entry).id === agentId));
  if (!call) return null;
  const agent = callAgent(call);
  return { ...agent, status: waitsFor(needsYouRows(data), agent) ? "needs-you" : "idle", lastAt: call.at ?? null };
}

/**
 * The agent the stage screen shows: the one whose newest presence or call is newest (the one at
 * work now), else the most recent agent, else the agent of the newest saved call, else null.
 */
export function shownAgent(data, now = Date.now()) {
  const rows = agentRows(data, now);
  if (!rows.length) return agentOfCalls(data);
  const latest = Object.values(data?.live?.latest ?? {}).sort((a, b) => String(b.at).localeCompare(String(a.at)) || (Number(b.seq) || 0) - (Number(a.seq) || 0))[0];
  return (latest && rows.find((row) => row.id === latest.agent?.id)) ?? rows[0];
}

/** The plan's step now: {index (from 1), count, text}, or null without a plan. */
export function planStep(plan) {
  const steps = (plan?.steps ?? []).map((step) => (typeof step === "string" ? { text: step, done: false } : step));
  if (!steps.length) return null;
  const at = steps.findIndex((step) => !step.done);
  if (at < 0) return { index: steps.length, count: steps.length, text: steps.at(-1).text, done: true };
  return { index: at + 1, count: steps.length, text: steps[at].text, done: false };
}

/** "step 3 of 5", "all 5 steps done", or "" without a plan. */
export const stepWords = (step) => (!step ? "" : step.done ? `all ${step.count} steps done` : `step ${step.index} of ${step.count}`);

/** True when something in "needs you" waits for this agent (or for its kind of client). */
function waitsFor(rows, agent) {
  return rows.some((row) => {
    const asker = row.type === "approval" ? { id: row.approval.agent?.id, kind: row.approval.client } : row.type === "ideas" ? { id: row.ideas.by?.id, kind: null } : row.type === "judge" || row.type === "material" ? {} : { id: row.round.agentId, kind: row.round.client };
    return asker.id ? asker.id === agent.id : asker.kind && asker.kind === agent.kind;
  });
}

/**
 * What the agent works on, for the pane's big line: "ready for you" while something it asked
 * for waits for you, else the plan's step now, else "working" or "idle" (never the call itself,
 * which the log under it shows).
 */
export function agentTask(data, agent, now = Date.now()) {
  if (!agent) return "no agent yet";
  if (waitsFor(needsYouRows(data), agent)) return "ready for you";
  const step = planStep(data?.agent?.plan);
  if (step && !step.done) return step.text;
  // Not the call itself: the log under the header already shows it.
  if (isWorking(data, agent, now)) return "working";
  return step?.done ? "plan done" : "idle";
}

/** The agent's calls in the open project (not yours), oldest first, at most `limit`. */
export function agentCalls(data, agentId, limit = 40) {
  return (data?.calls ?? []).filter((call) => call.by !== "you" && !call.approved && callAgent(call).id === agentId).slice(-limit);
}

// The receipt fields a detail line never shows: advice to the agent, not what happened.
const ADVICE_WORDS = new Set(["next", "rules", "example", "hint", "tip", "tips", "safetoretry", "inbox", "note", "reason", "instead", "didyoumean"]);
// A detail line is at most this long (longer ones are cut with …).
export const DETAIL_CHARS = 44;

/**
 * The detail lines worth showing under a call (call.details, from the server's said.mjs): facts
 * such as "beats matched 158 / 158", "offset +1.04 s" or "created title → L1", at most three,
 * each at most DETAIL_CHARS. Advice to the agent ("next The person answers …"), lines without a
 * number or an arrow, and empty lines are left out.
 */
export function usefulDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.map((line) => String(line ?? "").replace(/\s+/g, " ").trim())
    .filter((line) => line && !ADVICE_WORDS.has(line.split(" ")[0].toLowerCase()) && /[0-9→↔]/.test(line))
    .slice(0, 3).map((line) => cut(line, DETAIL_CHARS));
}

/**
 * The agent pane's log, oldest first, at most `limit` rows: one row per call ({key, at (time of
 * day), verb, kind (write, read or err), text, result {mark, text}, details, count}) and, while a
 * call runs, a last row for it ({current: true}). An edit's result is "+N" (its operations), any
 * other call that worked "✓", a failure "✕", a call that waits for your approval "waits", a held
 * write "held". Calls in a row with the same verb, words and result are one row with their
 * count and the time span ("22:27–22:30", count 18): an agent that waits for an approval asks
 * again and again, and that would push everything else out of the log.
 */
export function agentLog(data, agent, limit = 40) {
  if (!agent) return [];
  const edits = new Map((data?.agent?.turns ?? []).flatMap((turn) => turn.edits ?? []).map((edit) => [edit.after, edit]));
  const rows = [];
  agentCalls(data, agent.id, limit * 5).forEach((call, index) => {
    const ops = call.verb === "edit" && !call.isError && Number.isSafeInteger(call.rev) ? edits.get(call.rev)?.ops : null;
    const result = call.isError ? { mark: "failed", text: "✕" } : call.approval ? { mark: "waits", text: "waits" }
      : call.held ? { mark: "held", text: "held" } : call.waiting ? { mark: "waits", text: "stop" }
        : ops ? { mark: "ops", text: `+${ops}` } : { mark: "done", text: "✓" };
    // A call that waits for your approval: its label ("wait for Q16"); the result says it waits.
    const text = (call.approval && !call.isError && call.label ? call.label : callLine(call)).replace(new RegExp(`^${call.verb}\\s+`), "");
    const at = call.at ? timeOfDay(call.at) : "";
    const before = rows.at(-1);
    if (before && before.verb === call.verb && before.text === text && before.result.mark === result.mark && before.result.text === result.text) {
      before.count += 1;
      before.until = at;
      before.details = [];
      return;
    }
    rows.push({ key: `${call.at ?? ""}/${index}`, said: call.why ?? "", at, until: at, verb: call.verb, kind: verbKind(call.verb, call.isError), text, result, details: usefulDetails(call.details), count: 1, current: false, rev: Number.isSafeInteger(call.rev) && ops ? call.rev : null, images: (call.images ?? []).length });
  });
  for (const row of rows) {
    if (row.count > 1 && row.until && row.until !== row.at) row.at = `${row.at}–${row.until}`;
    delete row.until;
  }
  const shown = rows.slice(-limit);
  const presence = data?.live?.latest?.[agent.id];
  if (presence?.phase === "start") {
    shown.push({ key: `running/${presence.call}`, at: presence.at ? timeOfDay(presence.at) : "", verb: presence.verb, kind: verbKind(presence.verb),
      said: presence.why ?? "", text: presence.label ?? presence.verb, result: { mark: "running", text: "" }, details: [], count: 1, current: true });
  }
  return shown;
}

/**
 * What the agent last said about its work: {why, next, at} from its running call, else from its
 * newest call that said either. Empty strings when it said nothing.
 */
export function agentSaid(data, agent) {
  if (!agent) return { why: "", next: "", at: null };
  const presence = data?.live?.latest?.[agent.id];
  if (presence?.phase === "start" && (presence.why || presence.next)) return { why: presence.why ?? "", next: presence.next ?? "", at: presence.at ?? null };
  const call = [...agentCalls(data, agent.id, 200)].reverse().find((entry) => entry.why || entry.next);
  return call ? { why: call.why ?? "", next: call.next ?? "", at: call.at ?? null } : { why: "", next: "", at: null };
}

/** "turn 19" for the open project's newest turn, or "". */
export function turnWords(data) {
  const id = data?.agent?.turns?.at(-1)?.id;
  return id ? `turn ${String(id).replace(/^T/, "")}` : "";
}

/** True when the agent's newest call started or ended in the last WORKING_MS. */
export function isWorking(data, agent, now = Date.now()) {
  const presence = data?.live?.latest?.[agent?.id];
  if (presence?.phase === "start") return true;
  return Boolean(agent?.lastAt) && now - Date.parse(agent.lastAt) < WORKING_MS;
}

// ---- needs you: the orange top line and the action strip -----------------------------------

// What to do, in words, for each approval kind and stop kind (the top line's second part).
const APPROVAL_TODO = {
  "final-render": "watch the preview, then allow the render",
  "overwrite-export": "check it, then allow overwriting the export",
  "delete-scene": "check what goes, then allow deleting it",
  "delete-project": "check it, then allow moving the project to Trash",
  "large-import": "allow the large import, or not yet",
  "share-link": "allow the share link, or not yet",
};
// The a key's words on the action strip.
const APPROVAL_ALLOW = {
  "final-render": "allow render", "overwrite-export": "allow overwrite", "delete-scene": "allow delete", "delete-project": "allow archive",
  "large-import": "allow import", "share-link": "allow link",
};

/** "02:50" from seconds. */
export function minutes(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** A render's facts: "02:50 1080p60 mp4 · 5,100 frames", from an approval's spec. */
export function specWords(spec) {
  if (!spec) return "";
  const size = Number.isFinite(spec.height) && Number.isFinite(spec.width) ? `${Math.min(spec.width, spec.height)}p${spec.fps ?? ""}` : spec.fps ? `${spec.fps}fps` : "";
  const parts = [Number.isFinite(spec.seconds) ? minutes(spec.seconds) : "", size, spec.format ?? "", Number.isFinite(spec.frames) ? `${spec.frames.toLocaleString("en-US")} frames` : ""];
  return parts.filter(Boolean).join(" ");
}

/**
 * The words for one "needs you" row (needsYouRows): who asks, what to do, the a and d keys'
 * words, and a render's facts. `nameOf(agentId)` names a stop's agent.
 */
export function needWords(row, nameOf = () => null) {
  if (!row) return null;
  if (row.type === "approval") {
    const { approval } = row;
    return {
      who: approval.agent?.name || approval.client || "the agent", color: approval.agent?.color ?? null, agentId: approval.agent?.id ?? null,
      todo: APPROVAL_TODO[approval.kind] ?? `allow ${APPROVAL_WORDS[approval.kind] ?? approval.kind}, or not yet`,
      allow: APPROVAL_ALLOW[approval.kind] ?? "allow", deny: "not yet", key: "allow", spec: specWords(approval.spec), summary: approval.summary ?? "",
      // Something to watch first (a final render): the stage previews it, with the answers under it.
      watch: approval.kind === "final-render",
    };
  }
  if (row.type === "judge")
    return { who: "kino", color: null, agentId: null, todo: "pick which frame looks more finished", allow: "pick", deny: null, key: "allow", spec: "", summary: `${row.judge.id} · rev ${row.judge.rev}`, watch: false };
  // A material question: its ask; a picks the recommended option, the row's chips the others.
  if (row.type === "material")
    return { who: "the agent", color: null, agentId: null, todo: row.need.ask, allow: `option ${recommendedOption(row.need)}`, deny: null, key: "pick", spec: "", summary: row.need.why ?? "", watch: false };
  if (row.type === "ideas") {
    const { ideas } = row;
    const count = ideas.take.length;
    return {
      who: ideas.by?.name || "the agent", color: ideas.by?.color ?? null, agentId: ideas.by?.id ?? null,
      todo: "pick the ideas to use, then allow", allow: "pick ideas", deny: null, key: "allow", spec: "",
      summary: `${count} idea${count === 1 ? "" : "s"} from ${ideas.title ?? ideas.ref}`, watch: false,
    };
  }
  const round = row.round ?? {};
  // Sketches or options to pick from: the agent's question; a opens them.
  if (row.type === "try")
    return { who: "the agent", color: null, agentId: null, todo: round.question || "pick one of these", allow: round.sketch ? "see the sketches" : "see the options", deny: null, key: "allow", spec: "", summary: "", watch: false };
  const word = STOP_WORDS[round.kind] ?? round.kind ?? "stop";
  if (row.type === "elsewhere") return { who: row.name, color: null, agentId: null, todo: `the ${word} waits in ${row.name}: open it there`, allow: null, deny: null, key: null, spec: "", summary: "", watch: false };
  // A storyboard has nothing built to watch on the stage: a opens the board, where it is approved.
  const board = round.kind === "board";
  return {
    who: nameOf(round.agentId) || round.client || "the agent", color: null, agentId: round.agentId ?? null,
    todo: board ? "review the storyboard, then approve it or ask for a redo" : `look at the ${word}, then approve it or ask for a redo`,
    allow: board ? "review storyboard" : `approve ${word}`, deny: "redo", key: board ? "review" : "approve", spec: "", summary: String(round.ask ?? "").split("\n")[0],
    watch: true,
  };
}

// ---- several agents, and the live panels (agentPane.jsx, crewPane.jsx, live.jsx) -------------

// An agent that called kino this recently is in the crew view, and the pane stays open.
export const CREW_MS = 120_000;
// The seen drawer stays open this long after a look ends (unless pinned).
export const SEEN_MS = 6_000;

const msAgo = (iso, now) => now - Date.parse(iso ?? "");

/** The agents with a call in the last CREW_MS or a call running now, newest first. */
export function crewAgents(data, now = Date.now()) {
  const live = data?.live?.latest ?? {};
  return agentRows(data, now).filter((agent) => live[agent.id]?.phase === "start" || msAgo(agent.lastAt, now) < CREW_MS);
}

/**
 * True when the agent pane can fold to its rail: no agent call in CREW_MS, none running, and
 * nothing waits for you.
 */
export function paneIdle(data, now = Date.now()) {
  if (needsYouRows(data).length) return false;
  if (crewAgents(data, now).length) return false;
  if (Object.values(data?.live?.latest ?? {}).some((presence) => presence?.phase === "start")) return false;
  const newest = [...(data?.calls ?? [])].reverse().find((call) => call.by !== "you");
  return !newest || !(msAgo(newest.at, now) < CREW_MS);
}

/** Who worked here, for the rail: each agent of the saved calls with its newest call's time, newest first. */
export function railAgents(data, limit = 5) {
  const seen = new Map();
  for (const call of [...(data?.calls ?? [])].reverse()) {
    if (call.by === "you" || call.approved) continue;
    const agent = callAgent(call);
    if (!seen.has(agent.id)) seen.set(agent.id, { ...agent, lastAt: call.at ?? null });
  }
  return [...seen.values()].slice(0, limit);
}

/** The id of the agent whose newest notes call set the plan, or null. */
export function planOwner(data) {
  const call = [...(data?.calls ?? [])].reverse().find((entry) => entry.verb === "notes" && entry.by !== "you" && /plan/.test(`${entry.label ?? ""} ${entry.summary ?? ""}`));
  return call ? callAgent(call).id : null;
}

/**
 * A crew card's goal: the task kino started it with (data.crew), else the plan's step now when
 * this agent set the plan, else what it last said (why), else "".
 */
export function agentGoal(data, agent) {
  const member = (data?.crew?.members ?? []).find((entry) => entry.id === agent?.id);
  if (member?.task) return member.task;
  if (planOwner(data) === agent?.id) {
    const step = planStep(data?.agent?.plan);
    if (step && !step.done) return step.text;
  }
  return agentSaid(data, agent).why;
}

/**
 * A crew card's live line: the call running now ({verb, text, since, running: true}), else the
 * agent's newest call (running: false), else null.
 */
export function currentCall(data, agent) {
  const presence = data?.live?.latest?.[agent?.id];
  const bare = (verb, text) => String(text ?? "").replace(new RegExp(`^${verb}\\s+`), "");
  if (presence?.phase === "start") return { verb: presence.verb, text: bare(presence.verb, presence.label ?? presence.verb), since: presence.at ?? null, running: true };
  const call = agentCalls(data, agent?.id, 1)[0];
  return call ? { verb: call.verb, text: bare(call.verb, callLine(call)), since: call.at ?? null, running: false } : null;
}

/**
 * The crew view's merged feed: every agent's calls, newest first, at most `limit`, each with its
 * agent ({id, name, color}); `only` keeps one agent's.
 */
export function crewFeed(data, only = null, limit = 30) {
  const rows = [];
  const calls = data?.calls ?? [];
  for (let index = calls.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const call = calls[index];
    if (call.by === "you" || call.approved) continue;
    const agent = callAgent(call);
    if (only && agent.id !== only) continue;
    rows.push({ key: `${call.at ?? ""}/${index}`, at: call.at ?? null, agent, verb: call.verb, kind: verbKind(call.verb, call.isError),
      text: callLine(call).replace(new RegExp(`^${call.verb}\\s+`), ""), mark: call.isError ? "✕" : call.approval ? "waits" : "✓" });
  }
  return rows;
}

/**
 * The look the seen drawer shows: a look running now, or the newest look with pictures that
 * ended less than SEEN_MS ago ({agent, running, at, files}), else null.
 */
export function seenNow(data, now = Date.now()) {
  const running = Object.values(data?.live?.latest ?? {}).find((presence) => presence?.phase === "start" && presence.verb === "look") ?? null;
  const call = [...(data?.calls ?? [])].reverse().find((entry) => entry.by !== "you" && entry.verb === "look" && (entry.images ?? []).length);
  const fresh = call && msAgo(call.at, now) < SEEN_MS;
  if (!running && !fresh) return null;
  // While a look runs, the pictures of that agent's previous look stay up until the new ones come.
  const files = call && (fresh || callAgent(call).id === running?.agent?.id) ? call.images : [];
  return { agent: running?.agent ?? callAgent(call), running: Boolean(running), at: running?.at ?? call.at, files, label: running?.label ?? callLine(call) };
}

const RENDER_ENDED = new Set(["done", "canceled", "gone", "error", "failed"]);

/**
 * The render dock's facts for the open project's newest render job that runs:
 * {job, total, done, fraction, left (seconds or null), agent}. Frames are the job's duration ×
 * fps, done is that × progress; left comes from the time so far. Null when none runs.
 */
export function renderDock(data, now = Date.now()) {
  const job = [...(data?.renders ?? [])].reverse().find((entry) => !RENDER_ENDED.has(entry.status) && (!data?.projectId || entry.projectId === data.projectId));
  if (!job) return null;
  const fraction = Math.max(0, Math.min(1, Number(job.progress) || 0));
  const total = Number.isFinite(job.duration) && Number.isFinite(job.fps) ? Math.round(job.duration * job.fps) : null;
  const elapsed = (now - Date.parse(job.startedAt ?? "")) / 1000;
  const left = fraction > 0.02 && Number.isFinite(elapsed) ? Math.max(0, Math.round((elapsed / fraction) * (1 - fraction))) : null;
  // The agent whose render call is the newest one up to 5 s after the job started.
  const started = Date.parse(job.startedAt ?? "");
  const call = [...(data?.calls ?? [])].reverse().find((entry) => entry.verb === "render" && entry.by !== "you" && !(Date.parse(entry.at ?? "") > started + 5_000));
  return { job, total, done: total == null ? null : Math.round(total * fraction), fraction, left, agent: job.by === "you" || !call ? null : callAgent(call) };
}

// A finished render is said under the frame for this long.
export const READY_MS = 60_000;

/**
 * The open project's newest render when it is done and ended less than READY_MS ago, else null:
 * the line under the frame says it is ready, with its length, size and file facts.
 */
export function renderReady(data, now = Date.now()) {
  const job = [...(data?.renders ?? [])].reverse().find((entry) => !data?.projectId || entry.projectId === data.projectId);
  const ended = Date.parse(job?.finishedAt ?? "");
  if (!job || job.status !== "done" || !Number.isFinite(ended) || now - ended > READY_MS || now < ended - 5_000) return null;
  const megabytes = Number.isFinite(job.size) && job.size > 0 ? `${(job.size / 1e6).toFixed(job.size < 1e7 ? 1 : 0)} MB` : "";
  return { job, facts: [[Number.isFinite(job.duration) ? `${Number.isInteger(job.duration) ? job.duration : timeText(job.duration)} s` : "", job.width && job.height ? `${job.width} by ${job.height}` : ""].filter(Boolean).join(", "), [megabytes, String(job.format ?? "").toUpperCase()].filter(Boolean).join(", ")].filter(Boolean) };
}

/** "0:41" from seconds, or "". */
export const leftWords = (seconds) => (seconds == null ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);

// ---- the agent's line under the frame (voice.jsx) ----------------------------------------------

// A call's first word as it reads while the call runs and once it is done: [running, done].
const TENSES = {
  look: ["Looking", "Looked"], edit: ["Editing", "Edited"], check: ["Checking", "Checked"], render: ["Rendering", "Rendered"],
  add: ["Adding", "Added"], make: ["Making", "Made"], set: ["Setting", "Set"], read: ["Reading", "Read"], study: ["Studying", "Studied"],
  find: ["Finding", "Found"], cut: ["Cutting", "Cut"], build: ["Building", "Built"], time: ["Timing", "Timed"], move: ["Moving", "Moved"],
  fix: ["Fixing", "Fixed"], wait: ["Waiting", "Waited"], pick: ["Picking", "Picked"], import: ["Importing", "Imported"], open: ["Opening", "Opened"],
  create: ["Creating", "Created"], write: ["Writing", "Wrote"], show: ["Showing", "Showed"], record: ["Recording", "Recorded"], undo: ["Undoing", "Undid"],
  restore: ["Restoring", "Restored"], search: ["Searching", "Searched"], save: ["Saving", "Saved"], load: ["Loading", "Loaded"], start: ["Starting", "Started"],
  place: ["Placing", "Placed"], mark: ["Marking", "Marked"], update: ["Updating", "Updated"], delete: ["Deleting", "Deleted"], remove: ["Removing", "Removed"],
  inspect: ["Inspecting", "Inspected"], plan: ["Planning", "Planned"], ask: ["Asking", "Asked"], lay: ["Laying", "Laid"], sync: ["Syncing", "Synced"],
  list: ["Listing", "Listed"], compare: ["Comparing", "Compared"], export: ["Exporting", "Exported"], style: ["Styling", "Styled"], try: ["Trying", "Tried"],
  resolve: ["Resolving", "Resolved"], change: ["Changing", "Changed"], answer: ["Answering", "Answered"], replace: ["Replacing", "Replaced"],
};
// A tool whose label does not start with a verb gets these words first.
const TOOL_TENSES = {
  edit: TENSES.edit, look: ["Looking at", "Looked at"], check: TENSES.check, render: TENSES.render, inspect: TENSES.inspect,
  status: ["Reading", "Read"], library: ["Looking up", "Looked up"], notes: ["Noting", "Noted"], project: ["Setting up", "Set up"], history: ["Going back to", "Went back to"],
};

/**
 * A call's words as one sentence: "look at the source of smirk" running is "Looking at the source
 * of smirk.", done "Looked at the source of smirk.". A label that does not start with a verb gets
 * its tool's ("footage behind 4 sections" of an edit: "Edited footage behind 4 sections."). Text
 * that already ends a sentence keeps its end.
 */
export function asSentence(text, { verb = "", running = false } = {}) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[\s.…·]+$/, "");
  if (!words) return "";
  const [first, ...rest] = words.split(" ");
  const tense = TENSES[first.toLowerCase()];
  const at = running ? 0 : 1;
  let line;
  if (tense) line = [tense[at], ...rest].join(" ");
  // A look at one frame is labelled by its time alone ("at 0.0 s"): it is the frame at that time.
  else if (verb === "look" && first === "at") line = `${TOOL_TENSES.look[at]} the frame ${words}`;
  else if (TOOL_TENSES[verb] && first === first.toLowerCase()) line = `${TOOL_TENSES[verb][at]} ${words}`;
  else line = first.charAt(0).toUpperCase() + first.slice(1) + (rest.length ? ` ${rest.join(" ")}` : "");
  return /[?!]$/.test(line) ? line : `${line}.`;
}

/** A log row (agentLog) as one sentence: what the agent said it was for, else the call's own words. */
export const rowSentence = (row, running = Boolean(row?.current)) => (row.said ? asSentence(row.said, { running }) : asSentence(row.text, { verb: row.verb, running }));

/** What waits for you, as a sentence: its words as they are (no tense), with a capital and an end. */
export function asAsk(text) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().replace(/[\s…·]+$/, "");
  if (!words) return "";
  const line = words.charAt(0).toUpperCase() + words.slice(1);
  return /[.?!]$/.test(line) ? line : `${line}.`;
}

/**
 * The line under the frame: what the shown agent does now, as one sentence, and the line before it.
 *   {state, verb, text, facts: [words], before: {verb, text, rev} | null}
 * `state` is "need" (something waits for you; `need` holds its words and row), "hold" (your hold
 * is on), "recording" (an agent records the screen), "render" (a render runs; `render` holds renderDock's facts), "working" (a call runs or
 * ended a moment ago), "idle" (its last call, in the past), "ready" (a render just ended), "away"
 * (the agent of the saved calls is not connected now) or "empty" (no agent has called yet).
 */
export function voiceLine(data, agent, now = Date.now(), nameOf = () => null) {
  const rows = agent ? agentLog(data, agent, 12) : [];
  const last = rows.at(-1) ?? null;
  // A failed call says so: "Checked the video. It failed."
  const line = (row, running) => `${rowSentence(row, running)}${row.result?.mark === "failed" ? " It failed." : ""}`;
  const before = (skip) => {
    const row = rows.slice(0, skip ? -1 : undefined).at(-1);
    return row ? { verb: row.verb, kind: row.kind, text: line(row, false), rev: row.rev ?? null } : null;
  };
  const needs = needsYouRows(data);
  const need = needs.find((row) => row.type !== "elsewhere") ?? null;
  if (need) {
    const words = needWords(need, nameOf);
    return { state: "need", verb: "ask", text: asAsk(words.todo), facts: [words.spec, words.summary].filter(Boolean), before: before(false), need: { row: need, words, more: needs.length - 1 } };
  }
  if (data?.hold?.on) return { state: "hold", verb: "hold", text: `On hold. ${agent?.name ?? "The agent"} waits for you.`, facts: [], before: before(false) };
  // An agent records the screen: said under the frame, with Stop (the top line has one too).
  if (data?.recording) {
    const seconds = Math.max(0, Math.floor((now - data.recording.startedAt) / 1000));
    return { state: "recording", verb: "record", text: "Recording the screen.", facts: [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`, "Typed text is never kept", "Stays on this Mac"], before: before(false) };
  }
  const dock = renderDock(data, now);
  if (dock) {
    const text = dock.total ? `Rendering frame ${dock.done} of ${dock.total}.` : `Rendering, ${Math.round(dock.fraction * 100)}%.`;
    return { state: "render", verb: "render", text, facts: [dock.left == null ? "" : `${leftWords(dock.left)} left`, String(dock.job.format ?? "").toUpperCase()].filter(Boolean), before: before(false), render: dock };
  }
  // A render that just ended, unless the agent is in a call now.
  const ready = last?.current ? null : renderReady(data, now);
  if (ready) return { state: "ready", verb: "check", text: `The ${ready.job.quality === "final" ? "final" : "draft"} is ready.`, facts: ready.facts, before: before(false), ready };
  if (!agent || !last) return { state: "empty", verb: "plug", text: "Waiting for an agent.", facts: [], before: null };
  // The agent of the saved calls is not connected now (kino restarted, or its session ended): say
  // so in plain words ("Nova is not connected" told a person nothing: who Nova is, or what to do),
  // that nothing is lost, and how to go on. The line before stays its last call.
  if (!(data?.agents ?? []).some((entry) => entry.id === agent.id) && !last.current) {
    return { state: "away", verb: "plug", text: `Your agent${agent.name ? ` ${agent.name}` : ""} is not working on this right now.`, facts: [agent.lastAt ? `Last active ${agoWords(agent.lastAt, now)}` : "", "Everything is saved"].filter(Boolean), before: before(false) };
  }
  const working = isWorking(data, agent, now);
  return { state: working ? "working" : "idle", verb: last.verb, kind: last.kind, text: line(last, Boolean(last.current)), facts: [], before: before(true) };
}
