// What the dashboard calls an agent. kino gives each agent session a name ("Nova") so agents can
// tell each other apart, but a person does not know who "Nova" is. So the dashboard never draws
// those names: the one agent of a project is "Agent", several are "Agent 1", "Agent 2", numbered
// in the order they joined. Each keeps its color.
//
// withAgentLabels runs once on the dashboard's data (Dashboard.jsx): every agent's `name` in it
// becomes its label, so every screen that drew the name now draws the label. The real name stays
// in `agentName`, for what the dashboard sends to agents (a note "for Nova: ..."). The tools, the
// CLI and the server keep the names (tested in frontend/dashboardAgentView.test.js).

/** The label of the only agent. */
export const ONE_AGENT = "Agent";

const isAgentId = (id) => typeof id === "string" && id !== "" && !id.startsWith("legacy-");
const time = (iso) => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : Infinity;
};

/**
 * Each agent's label, by id: Map {id: "Agent"} for one agent, {id: "Agent 1", ...} for several.
 * `known` is the order the dashboard already numbered them in (so a number never moves while the
 * project is open); new agents come after it: the open project's first, in the order they joined
 * it (crew start, first saved call), then agents at work in other projects. Agents of older
 * servers (legacy ids) keep their client's name and get no label.
 */
export function agentLabels(data, known = []) {
  const first = new Map();
  const seen = (id, at, here) => {
    if (!isAgentId(id)) return;
    const was = first.get(id);
    first.set(id, { at: Math.min(time(at), was?.at ?? Infinity), here: Boolean(here || was?.here), order: was?.order ?? first.size });
  };
  const open = (projectId) => !projectId || projectId === data?.projectId;
  for (const member of data?.crew?.members ?? []) seen(member.id, member.startedAt ?? member.lastAt, open(member.projectId));
  for (const call of data?.calls ?? []) seen(call?.agent?.id, call?.at, true);
  for (const presence of Object.values(data?.live?.latest ?? {})) seen(presence?.agent?.id, presence?.at, true);
  for (const agent of data?.agents ?? []) seen(agent.id, agent.lastAt, open(agent.projectId));
  for (const approval of data?.approvals ?? []) seen(approval.agent?.id, approval.createdAt, open(approval.projectId));
  const fresh = [...first.entries()].filter(([id]) => !known.includes(id))
    .sort(([, a], [, b]) => Number(b.here) - Number(a.here) || a.at - b.at || a.order - b.order).map(([id]) => id);
  const ids = [...known.filter((id) => first.has(id)), ...fresh];
  return new Map(ids.map((id, index) => [id, ids.length === 1 ? ONE_AGENT : `${ONE_AGENT} ${index + 1}`]));
}

/**
 * The agent in a sentence: "the agent" ("The agent" to start one) for the only agent, else its
 * label ("Agent 2").
 */
export const theAgent = (name, start = false) => (!name || name === ONE_AGENT ? (start ? "The agent" : "the agent") : name);

// An object that names an agent ({id, name, ...}) with its label as `name` and its real name as `agentName`.
function labelled(agent, labels, id = agent?.id) {
  const label = agent && labels.get(id);
  if (!label || agent.name === label) return agent;
  return { ...agent, name: label, agentName: agent.agentName ?? agent.name ?? null };
}

/** A call with its agent's label (the turn reviews' calls, timeline.jsx, are not in the data). */
export const labelCall = (call, labels) => (call?.agent?.id && labels.has(call.agent.id) ? { ...call, agent: labelled(call.agent, labels) } : call);

// kino's own words about agents (the crew's activity: "Nova connected") with each real name as its label.
function relabelText(text, names) {
  if (typeof text !== "string" || !names.length) return text;
  return names.reduce((words, [name, label]) => words.replace(new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), `$1${label}`), text);
}

/**
 * The dashboard's data with every agent named by its label (agentLabels) instead of its name:
 * the connected agents, the saved calls, the live presence, the approvals, the crew (members, who
 * started them, held parts, activity) and the inspire searches and ideas. Text an agent wrote
 * (notes, tasks, hand-backs) stays as it is. `agentLabels` holds the labels for data read later.
 * `known` is agentLabels' order from the last time (the result's `agentLabels` keys, in order).
 */
export function withAgentLabels(data, known = []) {
  if (!data) return data;
  const labels = agentLabels(data, known);
  if (!labels.size) return { ...data, agentLabels: labels };
  const one = (agent) => labelled(agent, labels);
  // Real names, longest first ("Nova 2" before "Nova"), for kino's own sentences.
  const labelOfName = new Map();
  for (const agent of [...(data.agents ?? []), ...(data.crew?.members ?? []), ...(data.calls ?? []).map((call) => call?.agent)]) {
    if (agent?.name && labels.has(agent.id) && agent.name !== labels.get(agent.id)) labelOfName.set(agent.name, labels.get(agent.id));
  }
  const names = [...labelOfName].sort((a, b) => b[0].length - a[0].length);
  const crew = data.crew ? {
    ...data.crew,
    members: (data.crew.members ?? []).map((member) => {
      const next = one(member);
      if (member.startedBy?.type !== "agent") return next;
      const by = labels.get(member.startedBy.id);
      return by ? { ...next, startedBy: { ...member.startedBy, name: by }, because: member.because ? { ...member.because, by } : member.because } : next;
    }),
    locks: (data.crew.locks ?? []).map((entry) => ({
      ...entry, holderName: labels.get(entry.holder) ?? entry.holderName,
      waiting: (entry.waiting ?? []).map((waiter) => labelled(waiter, labels, waiter.agentId)),
    })),
    activity: (data.crew.activity ?? []).map((entry) => ({ ...labelled(entry, labels, entry.agentId), text: relabelText(entry.text, names) })),
  } : data.crew;
  const inspire = data.inspire ? {
    ...data.inspire,
    searches: (data.inspire.searches ?? []).map((search) => (search.by && search.by !== "you" ? { ...search, by: one(search.by) } : search)),
    ...(data.inspire.ideas ? { ideas: { ...data.inspire.ideas, by: one(data.inspire.ideas.by) } } : {}),
  } : data.inspire;
  return {
    ...data,
    agentLabels: labels,
    agents: (data.agents ?? []).map(one),
    calls: (data.calls ?? []).map((call) => labelCall(call, labels)),
    live: data.live ? { ...data.live, latest: Object.fromEntries(Object.entries(data.live.latest ?? {}).map(([id, presence]) => [id, presence?.agent ? { ...presence, agent: one(presence.agent) } : presence])) } : data.live,
    // A crew budget request is kino's sentence about an agent ("Nova is past its budget").
    approvals: (data.approvals ?? []).map((approval) => (approval.agent ? {
      ...approval, agent: one(approval.agent),
      ...(approval.verb === "crew" ? { summary: relabelText(approval.summary, names), kinds: approval.kinds?.map((kind) => ({ ...kind, summary: relabelText(kind.summary, names) })) } : {}),
    } : approval)),
    crew,
    inspire,
    // An edit your note stopped names its agent by name only.
    agent: data.agent?.stopped ? { ...data.agent, stopped: data.agent.stopped.map((item) => (labelOfName.has(item.agent) ? { ...item, agent: labelOfName.get(item.agent) } : item)) } : data.agent,
  };
}
