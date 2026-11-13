// The top bar's and the timeline's facts about the agents, as plain functions (tested in
// frontend/dashboardModules.test.js): one chip per working agent, the line when all are idle, the
// render that runs now and the agent that asked for it, and where an agent works on the timeline.
import { activeAgents, AGENT_STATUS_WORDS, callAgent } from "./state.js";
import { isShown, spotOf } from "./presence.js";

const FINISHED = new Set(["done", "canceled", "failed", "error", "gone"]);

/** "sound pass", "editing arrival": the first `words` words of `text`, or "". */
export function fewWords(text, words = 3) {
  return String(text ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, words).join(" ");
}

/**
 * One chip per agent at work now (activeAgents, newest first): {id, name, color, doing, status},
 * `doing` being its newest call's label in a few words ("working" without one), or "needs you" or "failed".
 */
export function agentChips(data, now = Date.now()) {
  return activeAgents(data, now).map((agent) => {
    const latest = data?.live?.latest?.[agent.id];
    // An agent that waits for you or whose last call failed says so in words, not only by color.
    const doing = AGENT_STATUS_WORDS[agent.status] && agent.status !== "idle" ? AGENT_STATUS_WORDS[agent.status] : fewWords(latest?.label || latest?.verb || "") || "working";
    return { id: agent.id, name: agent.name ?? "agent", color: agent.color ?? null, doing, status: agent.status };
  });
}

/** "33 min ago" from ms. */
function agoWords(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** The top bar when no agent works: "all idle · last edit 33 min ago" ("all idle" without an edit; null without any agent or call). */
export function idleLine(data, now = Date.now()) {
  const calls = (data?.calls ?? []).filter((call) => call.by !== "you");
  if (!calls.length && !(data?.agents ?? []).length) return null;
  const edit = [...calls].reverse().find((call) => call.verb === "edit" && !call.isError);
  const at = Date.parse(edit?.at ?? "");
  return Number.isFinite(at) ? `all idle, last edit ${agoWords(now - at)}` : "all idle";
}

/** The newest render of the open project that still runs, or null. */
export function runningRender(data) {
  return (data?.renders ?? []).filter((job) => job.projectId === data?.projectId && !FINISHED.has(job.status)).at(-1) ?? null;
}

/**
 * The agent that asked for `job`: the agent of the render call made closest to the job's start
 * (within 15 s). A render you started, or one without such a call, has none: null.
 */
export function renderAgent(data, job) {
  if (!job || job.by === "you") return null;
  const start = Date.parse(job.startedAt ?? "");
  if (!Number.isFinite(start)) return null;
  let best = null;
  for (const call of data?.calls ?? []) {
    if (call.verb !== "render" || call.by === "you") continue;
    const gap = Math.abs(Date.parse(call.at ?? "") - start);
    if (gap <= 15_000 && (!best || gap < best.gap)) best = { gap, call };
  }
  if (!best) return null;
  const agent = callAgent(best.call);
  return (data?.agents ?? []).find((row) => row.id === agent.id) ?? agent;
}

/**
 * Where an agent works now on the timeline of `sceneId`: {start, end, label} in seconds from its
 * shown presence (a range, or a moment drawn `minimum` seconds wide), or null.
 */
export function nowBlock(presence, sceneId, now, { minimum = 0.5 } = {}) {
  if (!presence || !isShown(presence, now)) return null;
  const spot = spotOf(presence);
  if (!spot || spot.sceneId !== sceneId) return null;
  const label = fewWords(presence.label || presence.verb || "", 2);
  if (spot.range) return { start: Math.min(...spot.range), end: Math.max(...spot.range), label };
  if (spot.time != null) return { start: spot.time, end: spot.time + minimum, label };
  return null;
}
