// The agent pane while two or more agents work (crewAgents in agentView.js): a filter (all or
// one agent), "hold all", one card per agent (its color, goal, plan steps, the call now and how
// long it runs) and one feed of every agent's calls, newest first. The selected card has watch,
// message, and, for an agent kino started (data.crew), hold and stop.
import React from "react";
import { Bot } from "./bot.jsx";
import { moodOfRow } from "./bot.js";
import { agentGoal, crewFeed, currentCall, planOwner, planStep } from "./agentView.js";
import { ago } from "./format.js";
import { Glyph } from "./live.jsx";

/** One agent's card. */
function CrewCard({ data, agent, now, still, selected, onSelect, onWatch, onMessage, onHold, onStop, member }) {
  const goal = agentGoal(data, agent);
  const call = currentCall(data, agent);
  const plan = planOwner(data) === agent.id ? (data.agent?.plan?.steps ?? []).map((step) => (typeof step === "string" ? { text: step, done: false } : step)) : [];
  const step = plan.length ? planStep(data.agent.plan) : null;
  return (
    <li className={`crew-card${selected ? " selected" : ""}`} style={{ "--who": agent.color ?? "var(--agent)" }}>
      <button type="button" className="crew-card-main" aria-pressed={selected} onClick={() => onSelect(selected ? null : agent.id)} aria-label={`${agent.name}${goal ? `: ${goal}` : ""}`}>
        <span className="crew-card-top">
          <Bot color={agent.color} mood={moodOfRow(data, agent, now)} size={20} still={still} />
          <span className="who">{agent.name}</span>
          <span className="crew-goal" title={goal}>{goal}</span>
          {step ? <span className="faint">{step.done ? step.count : step.index}/{step.count}</span> : null}
        </span>
        {plan.length ? (
          <span className="crew-steps" aria-hidden="true">{plan.map((entry, index) => <span key={index} className={entry.done ? "done" : index === step.index - 1 && !step.done ? "now" : ""} />)}</span>
        ) : null}
        {call ? (
          <span className="crew-now">
            <span className={`live-dot${call.running ? "" : " off"}`} aria-hidden="true" />
            <span className="crew-verb">{call.verb}</span><span className="dim crew-call" title={call.text}>{call.text}</span>
            <span className="faint">{call.since ? ago(call.since, now) : ""}</span>
          </span>
        ) : null}
      </button>
      {selected ? (
        <span className="crew-card-actions">
          <button type="button" className="tb tb-box" onClick={() => onWatch(agent.id)} title="Show only its calls"><Glyph name="eye" /> watch</button>
          <button type="button" className="tb tb-box" onClick={() => onMessage(agent.id)} title="Write it a note"><Glyph name="message" /> message</button>
          {member ? <>
            <button type="button" className="tb tb-box" aria-pressed={Boolean(member.heldBy)} onClick={() => onHold(member, !member.heldBy)} title="Refuse its writes until you release it"><Glyph name="hold" /> {member.heldBy ? "release" : "hold"}</button>
            <button type="button" className="tb tb-box crew-stop" onClick={() => onStop(member)} title="Stop this agent"><Glyph name="stop" /> stop</button>
          </> : null}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The crew view. `agents` work now (two or more); `only` is the filter (null: all); `selected`
 * the card with its buttons open.
 */
export function CrewView({ data, agents, now, still, only, onOnly, selected, onSelect, onMessage, onHoldAll, onHold, onStop }) {
  const feed = crewFeed(data, only);
  const members = new Map((data.crew?.members ?? []).map((member) => [member.id, member]));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <div className="crew-view">
      <div className="crew-filter">
        <div className="seg" role="group" aria-label="Show the calls of">
          <button type="button" className="seg-item" aria-pressed={!only} onClick={() => onOnly(null)}>all</button>
          {agents.map((agent) => (
            <button key={agent.id} type="button" className="seg-item" aria-pressed={only === agent.id} onClick={() => onOnly(only === agent.id ? null : agent.id)} style={{ "--who": agent.color ?? "var(--agent)" }}>
              <span className="live-dot" aria-hidden="true" />{agent.name}
            </button>
          ))}
        </div>
        <button type="button" className={`tb tb-box${data.hold?.on ? " on" : ""}`} aria-pressed={Boolean(data.hold?.on)} onClick={onHoldAll} title="Pause every agent's writes (h)" aria-keyshortcuts="h">
          <Glyph name="hold" /> {data.hold?.on ? "release all" : "hold all"}</button>
      </div>
      <ul className="crew-cards">
        {agents.filter((agent) => !only || agent.id === only).map((agent) => (
          <CrewCard key={agent.id} data={data} agent={agent} now={now} still={still} selected={selected === agent.id} onSelect={onSelect}
            onWatch={(id) => onOnly(id)} onMessage={onMessage} onHold={onHold} onStop={onStop} member={["stopped", "done"].includes(members.get(agent.id)?.state) ? null : members.get(agent.id) ?? null} />
        ))}
      </ul>
      <p className="crew-feed-head faint"><span>all calls</span><span>newest first</span></p>
      <ol className="crew-feed" role="log" aria-label="Every agent's calls, newest first" aria-live="polite">
        {feed.map((row) => (
          <li key={row.key} style={{ "--who": (byId.get(row.agent.id) ?? row.agent).color ?? "var(--agent)" }} title={`${row.agent.name}: ${row.verb} ${row.text}`}>
            <span className="feed-rail" aria-hidden="true" />
            <span className="faint feed-time">{row.at ? ago(row.at, now) : ""}</span>
            <span className="feed-verb">{row.verb}</span>
            <span className="feed-text">{row.text}</span>
            <span className={`feed-mark${row.mark === "✕" ? " err" : ""}`}>{row.mark}</span>
            <span className="sr-only">by {row.agent.name}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
