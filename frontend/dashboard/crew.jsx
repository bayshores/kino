// The crew page (F2): one row per agent (the frame it last looked at, its name and who started
// it, what it does now as one sentence, its calls, time and rights, its calls of the last 10
// minutes, and its Watch, Hold and Stop buttons), then under a hairline: start an agent, who
// holds what, the helpers' limits, who may start agents, timers and references.
// Made for the mouse: every action is a button. Its rows come from crewRows.js (the crew's data, backend/agent/crew.mjs); the changes go
// to the dashboard's crew routes (api.js): hold, release or stop one agent, free a part, change
// the start rules, start an agent, add or remove a timer.
//
// Keys (in the buttons' tooltips): ↑ ↓ j k pick an agent, h holds or releases it, x stops it
// (asks first), Enter shows its work on the stage, H holds all agent writes, s starts an agent,
// t adds a timer, r removes the selected timer (asks first), i opens the inspire screen (F3).
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./crew.css";
import { serverNow } from "./presence.js";
import { isTyping } from "./keys.js";
import * as server from "./api.js";
import { Bot } from "./bot.jsx";
import { ToolIcon } from "./voice.jsx";
import { agentCalls, agentLog, asSentence, verbKind, voiceLine } from "./agentView.js";
import { Btn, Icon, Segmented, Stepper } from "./controls.jsx";
import { crewCard, crewDetail, crewHolds, crewLaneRows, crewLanesSummary, crewMood, crewTable, planOf, withSavedAgents } from "./crewRows.js";

const KIND_LABELS = { "claude-code": "claude code", codex: "codex" };
const PROGRAMS = { "claude-code": "claude", codex: "codex" };
const capital = (words) => String(words ?? "").charAt(0).toUpperCase() + String(words ?? "").slice(1);
const ENDED = ["stopped", "done"];

/** A real checkbox with its words. */
function Check({ checked, disabled = false, onChange, children, title }) {
  return (
    <label className={`crew-check${disabled ? " disabled" : ""}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange?.(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// Why an agent of this kind cannot start here, or "".
function cannotStart(canStart, kind) {
  if (!canStart) return "This kino cannot start agents.";
  if (canStart[kind]) return "";
  return `${PROGRAMS[kind]} was not found on this computer: install ${KIND_LABELS[kind]}, or pick the other one.`;
}

/** The form to start an agent or add a timer, under the hairline. */
function StartForm({ timer, rules, canStart, projectId, onDone, onCancel, fail, say }) {
  const [task, setTask] = useState("");
  const firstKind = canStart?.[rules?.kind] ? rules.kind : Object.keys(KIND_LABELS).find((kind) => canStart?.[kind]) ?? rules?.kind ?? "claude-code";
  const [kind, setKind] = useState(firstKind);
  const [may, setMay] = useState("all");
  const [when, setWhen] = useState("daily");
  const [daily, setDaily] = useState("06:00");
  const [hours, setHours] = useState("6");
  const [busy, setBusy] = useState(false);
  const taskRef = useRef(null);
  useEffect(() => { taskRef.current?.focus(); }, []);
  const reason = timer ? "" : cannotStart(canStart, kind);
  const submit = async () => {
    if (!task.trim()) { say("Write the agent's task first.", true); taskRef.current?.focus(); return; }
    if (reason) { say(reason, true); return; }
    setBusy(true);
    try {
      if (timer) {
        const { member } = await server.addTimer({ kind, task: task.trim(), may, project: projectId ?? undefined, ...(when === "daily" ? { daily } : { everyHours: Number(hours) }) });
        say(`Timer ${member.name} added: ${member.scheduleWords}.${rules?.timers ? "" : " Timers may not start agents yet: tick timers to let it run."}`);
        onDone(member.id);
      } else {
        const { member } = await server.startAgent({ kind, task: task.trim(), may, project: projectId ?? undefined });
        say(`${member.name} started (${KIND_LABELS[member.kind] ?? member.kind}).`);
        onDone(member.id);
      }
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  const seg = (name, label, value, onChange, options) => (
    <Segmented name={`${timer ? "timer" : "start"}-${name}`} label={label} value={value} onChange={onChange}
      options={options.map(([key, words]) => ({ value: key, text: words }))} className="crew-seg" />
  );
  return (
    <form className="crew-start" aria-label={timer ? "Add a timer" : "Start an agent"}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <label className="ui-field crew-start-task">
        <span className="sr-only">{timer ? "Timer task" : "Task"}</span>
        <input ref={taskRef} type="text" value={task} maxLength={2000} onChange={(event) => setTask(event.target.value)}
          placeholder={timer ? "What should it do each time?" : "What should the agent do?"} />
      </label>
      <div className="crew-start-row">
        {seg("kind", "Which agent", kind, setKind, Object.entries(KIND_LABELS).map(([key, words]) => [key, `${capital(words)}${canStart?.[key] ? "" : " (not found)"}`]))}
        {seg("may", "What it may do", may, setMay, [["all", "Everything"], ["look", "Look only"]])}
        {timer ? <>
          {seg("when", "When it runs", when, setWhen, [["daily", "Daily at"], ["hours", "Every"]])}
          {when === "daily"
            ? <input type="time" className="crew-time" value={daily} onChange={(event) => setDaily(event.target.value)} aria-label="Time of day" required />
            : <span className="crew-hours"><input type="number" className="crew-time" min={1} max={168} value={hours} onChange={(event) => setHours(event.target.value)} aria-label="Hours between runs" style={{ width: "7ch" }} /> h</span>}
        </> : null}
        <span className="crew-start-go">
          <Btn kind="quiet" keys="Esc" onClick={onCancel}>Cancel</Btn>
          <Btn kind="primary" icon={timer ? "timer" : "plus"} type="submit" keys="Enter" disabled={busy || Boolean(reason)} aria-describedby={reason ? "crew-start-reason" : undefined}>{timer ? "Add timer" : "Start"}</Btn>
        </span>
      </div>
      {reason ? <p id="crew-start-reason" className="crew-reason">{reason}</p> : null}
    </form>
  );
}

/**
 * What an agent does now, as one sentence ({state, verb, text}): its hold, a request that waits
 * for you, the part it waits for, else its last call as voiceLine says it on the stage.
 */
function lineOf(data, member, now, holdOn, nameOf, note) {
  if (member.heldBy || (holdOn && ["working", "looking"].includes(member.state))) return { state: "hold", verb: "hold", text: member.heldBy ? "Held." : "On hold." };
  if (member.state === "needs-you") {
    const line = voiceLine(data, member, now, nameOf);
    const asker = line.need?.row.approval?.agent?.id;
    return line.state === "need" && (!asker || asker === member.id) ? line : { state: "need", verb: "ask", text: "Needs you." };
  }
  const waitsFor = member.waitingFor?.[0];
  if (waitsFor) return { state: "idle", verb: "history", text: `Waiting for ${nameOf(waitsFor.holder) ?? waitsFor.label}.` };
  const working = ["working", "looking"].includes(member.state);
  const last = ENDED.includes(member.state) || member.state === "asleep" ? null : agentLog(data, member, 12).at(-1);
  if (last) return { state: working ? "working" : "idle", verb: last.verb, text: asSentence(last.said || last.text, { verb: last.verb, running: Boolean(last.current) }) };
  if (member.last && !ENDED.includes(member.state)) return { state: working ? "working" : "idle", verb: member.last.verb, text: asSentence(member.last.label || member.last.verb, { verb: member.last.verb, running: working }) };
  return { state: "idle", verb: member.role === "timer" ? "history" : "status", text: note ? asSentence(note) : `${capital(member.stateWords ?? member.state)}.` };
}

/** The cut's poster for an agent that edited it; else the frame it last looked at; else its bot. */
function Thumb({ data, member, holdOn, still }) {
  const calls = agentCalls(data, member.id, 400);
  const look = [...calls].reverse().find((call) => call.verb === "look" && (call.images ?? []).length);
  const scene = data?.record?.document?.scenes?.[0];
  const src = scene && calls.some((call) => verbKind(call.verb) === "write") ? server.frameUrl({ projectId: data.projectId, sceneId: scene.id, time: Math.round(scene.duration * 50) / 100, width: 480, rev: data.record.revision, low: true })
    : look && data.projectId ? server.seenUrl(data.projectId, look.images[0])
      : null;
  return (
    <span className="crew-thumb" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : <Bot color={member.color} mood={crewMood(member, holdOn)} size={40} still={still} />}
    </span>
  );
}

/** One lane of the last 10 minutes: runs of calls, requests to you, held stretches, starts and hand-backs. */
function Lane({ lane, you = null }) {
  return (
    <div className="crew-lane" aria-hidden="true">
      <div className="lane-track">
        {you ? you.map((mark) => <span key={mark.key} className="lane-you" style={{ left: `${mark.x * 100}%` }} title={mark.word} />) : null}
        {lane?.held.map((span) => <span key={span.key} className="lane-held" style={{ left: `${span.x * 100}%`, width: `${span.width * 100}%` }} title="held" />)}
        {lane?.waits.map((wait) => <span key={wait.key} className={`lane-wait${wait.open ? " open" : ""}`} style={{ left: `${wait.x * 100}%`, width: `${wait.width * 100}%` }} title={wait.label} />)}
        {lane?.blocks.map((block) => (
          <span key={block.key} className={`lane-block k-${block.kind}${block.error ? " error" : ""}`} style={{ left: `${block.x * 100}%`, width: `${block.width * 100}%` }} title={block.label} />
        ))}
        {lane?.marks.map((mark) => <span key={mark.key} className={`lane-mark m-${mark.type}`} style={{ left: `${mark.x * 100}%`, ...(mark.color ? { color: mark.color } : {}) }}>{mark.type === "started" ? "▸" : "◆"}</span>)}
      </div>
      <span className="crew-lane-span">10 min</span>
    </div>
  );
}

/** One agent's row; its buttons act on it at once. */
function AgentRow({ data, row, member, plan, lane, nameOf, selected, holdOn, still, now, optionId, onPick, onAct }) {
  const card = crewCard(member, plan);
  const detail = crewDetail(member, now);
  const ended = ENDED.includes(member.state);
  const holdable = !ended && !member.fromCalls && (member.role !== "timer" || Boolean(member.process?.running));
  const line = lineOf(data, member, now, holdOn, nameOf, lane?.note);
  const holding = (member.holding ?? []).map((part) => part.label);
  const role = member.role === "lead" ? "Lead" : member.role === "timer" ? capital(detail.started) : `Started by ${row.startedBy || "you"}`;
  const about = [capital(KIND_LABELS[member.kind] ?? member.kindWords ?? member.kind), detail.because, detail.title].filter(Boolean).join("\n");
  const facts = [
    detail.spent.callsText,
    detail.spent.timeText ? `${detail.spent.timeText}${detail.spent.timeText.includes("min") ? "" : " min"}` : "",
    detail.may ? (detail.may === "everything" ? "May do everything" : `May ${detail.may}`) : "",
    card.stepText ? capital(card.stepText) : "",
    detail.handedBack ? `Handed back: ${detail.handedBack}` : "",
    ended ? capital(member.endReason ?? member.stateWords) : "",
  ].filter(Boolean);
  const label = `${row.name}, ${role}, ${line.text}${holding.length ? ` Holds ${holding.join(", ")}.` : ""}`;
  return (
    <li id={optionId} role="option" aria-selected={selected} aria-label={label} className={`crew-card is-${line.state}`} style={member.color ? { "--who": member.color } : undefined}
      onClick={onPick} onDoubleClick={() => onAct("watch")}>
      <Thumb data={data} member={member} holdOn={holdOn} still={still} />
      <div className="crew-card-main">
        <p className="crew-card-name"><strong>{member.name}</strong><span title={about || undefined}>{role}</span></p>
        <p className="voice-line" key={line.text}><ToolIcon name={line.verb} /><span title={line.text}>{line.text}</span></p>
        <p className="crew-card-facts">
          {facts.map((fact) => <span key={fact}>{fact}</span>)}
          {holding.length ? <span className="crew-holds-chip" title="Holds"><Icon name="lock" />{holding.join(", ")}</span> : null}
        </p>
        <Lane lane={lane} />
      </div>
      <span className="crew-card-keys" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        {holdable ? <Btn kind="quiet" className="icon-only" icon="hold" keys={selected ? "h" : undefined} aria-pressed={Boolean(member.heldBy)}
          aria-label={`${member.heldBy ? "Release" : "Hold"} ${member.name}`} title={member.heldBy ? "Release" : "Hold"} onClick={() => onAct("hold")} /> : null}
        <Btn icon="eye" keys={selected ? "Enter" : undefined} onClick={() => onAct("watch")}>Watch</Btn>
        {holdable ? <Btn icon="stop" keys={selected ? "x" : undefined} onClick={() => onAct("stop")}>{member.role === "timer" ? "End run" : "Stop"}</Btn> : null}
        {member.role === "timer" ? <Btn kind="quiet" className="icon-only" icon="trash" keys={selected ? "r" : undefined} aria-label={`Remove the timer ${member.name}`} title="Remove" onClick={() => onAct("remove")} /> : null}
      </span>
    </li>
  );
}

export function CrewScreen({ data, now, hold, still = false, onHold, onWatch, onBack, onHelp, onInspire, onConfirm, say, fail }) {
  const at = serverNow(data?.live, now);
  // The crew and the agents of the project's saved calls it does not know (after a restart).
  const view = useMemo(() => withSavedAgents(data, at), [data, at]);
  const crew = view?.crew ?? null;
  const rows = useMemo(() => crewTable(view), [view]);
  const members = useMemo(() => new Map((crew?.members ?? []).map((member) => [member.id, member])), [crew]);
  const laneRows = useMemo(() => crewLaneRows(view, rows, at), [view, rows, at]);
  const lanes = useMemo(() => new Map(laneRows.lanes.map((lane) => [lane.id, lane])), [laneRows]);
  const holds = useMemo(() => crewHolds(view), [view]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(null); // null, "start" or "timer"
  const listRef = useRef(null);
  // The first look: whoever needs you, else the first agent, else you.
  const fallback = rows.find((row) => row.state === "needs-you") ?? rows[1] ?? rows[0];
  const index = Math.max(0, rows.findIndex((row) => row.id === (selectedId ?? fallback?.id)));
  const selected = rows[index] ?? null;
  const member = selected ? members.get(selected.id) ?? null : null;
  const rules = crew?.rules ?? null;
  const canStart = crew?.canStart ?? null;
  const startable = canStart && Object.values(canStart).some(Boolean);
  const leads = (crew?.members ?? []).filter((entry) => entry.role === "lead" && !ENDED.includes(entry.state));
  const nameOf = (id) => members.get(id)?.name ?? data?.agents?.find((entry) => entry.id === id)?.name ?? null;

  // The list takes the focus when the screen opens, so ↑ ↓ and the letter keys act on it.
  useEffect(() => { listRef.current?.focus(); }, []);

  const step = (by) => {
    if (!rows.length) return;
    setSelectedId(rows[Math.max(0, Math.min(rows.length - 1, index + by))].id);
  };
  const act = async (work, done) => {
    try { await work(); if (done) say(done); } catch (cause) { fail(cause); }
  };
  // An action on one agent (`target`, a member; the selected one for the keys).
  const actOn = (name, target, row = target ? rows.find((entry) => entry.id === target.id) : null) => {
    if (name === "watch") { if (row) onWatch({ id: row.id, name: row.name }); return; }
    if (!target) return;
    // An agent known only from the project's saved calls is not connected: nothing to hold or stop.
    if (target.fromCalls && (name === "hold" || name === "stop")) { say(`${target.name} is not working right now, so there is nothing to ${name}.`); return; }
    const ended = ENDED.includes(target.state);
    if (name === "hold" && !ended) {
      const on = !target.heldBy;
      act(() => server.holdAgent(target.id, on), on ? `${target.name} held: its writes are refused until you release it.` : `${target.name} released.`);
    }
    if (name === "stop" && !ended) {
      onConfirm({
        text: target.role === "timer" ? `End ${target.name}'s run now? The timer stays and runs again on its schedule.` : `Stop ${target.name}? ${target.launched ? "kino ends its program; " : ""}its calls are refused from now on.`,
        yes: target.role === "timer" ? "end run" : "stop", run: () => act(() => server.stopAgent(target.id), `${target.name} stopped.`),
      });
    }
    if (name === "remove" && target.role === "timer") {
      onConfirm({ text: `Remove the timer ${target.name}? It will not run again.`, yes: "remove", run: () => act(() => server.removeTimer(target.id), `Timer ${target.name} removed.`) });
    }
  };
  const runKey = (name) => {
    if (name === "start" || name === "timer") { setForm(name); return; }
    if (name === "inspire") { onInspire?.(); return; }
    if (name === "watch") { if (selected) onWatch({ id: selected.id, name: selected.name }); return; }
    actOn(name, member, selected);
  };
  // ↑ ↓ j k move; h x Enter r act on the selected agent; H holds all; s and t open the forms.
  // The dashboard's own keys (Esc, F1, ?) are not handled here.
  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    if (isTyping(event.target)) return;
    const onControl = event.target.matches?.("button, input, select, a");
    const key = event.key;
    let done = true;
    if (key === "ArrowDown" || key === "j") step(1);
    else if (key === "ArrowUp" || key === "k") step(-1);
    else if (key === "Enter" && !onControl) runKey("watch");
    else if (key === "h") runKey("hold");
    else if (key === "x") runKey("stop");
    else if (key === "r") runKey("remove");
    else if (key === "i") runKey("inspire");
    else if (key === "s") runKey("start");
    else if (key === "t") runKey("timer");
    else if (key === "H") onHold();
    else done = false;
    if (done) event.preventDefault();
  };

  const saveRules = (change, words) => act(() => server.saveCrewRules(change), words);
  const optionId = (row) => `crew-row-${row.id}`;
  const projectId = data?.projectId ?? null;
  const pick = (id) => { setSelectedId(id); listRef.current?.focus(); };

  if (!crew) {
    return (
      <section className="screen crew" aria-labelledby="crew-heading">
        <h2 id="crew-heading">Crew</h2>
        <p className="faint">This kino server keeps no crew.</p>
      </section>
    );
  }

  const you = rows[0];
  const render = holds.find((row) => row.key === "render");
  const parts = holds.filter((row) => row.key !== "render" && row.holder);
  const free = (row) => act(() => server.freePart(projectId, row.key), `${row.label} freed: another agent may change it now.`);
  return (
    <section className={`screen crew crew2${still ? " still" : ""}`} tabIndex={-1} aria-labelledby="crew-heading" onKeyDown={onKeyDown}>
      <h2 id="crew-heading" className="sr-only">Crew</h2>
      <div className="crew-table crew-lanes">
        <p className="sr-only">{crewLanesSummary(laneRows)}</p>
        <ul ref={listRef} className="crew-cards" role="listbox" tabIndex={0} aria-label="Agents" aria-activedescendant={selected ? optionId(selected) : undefined}>
          {rows.slice(1).map((row) => members.get(row.id) ? (
            <AgentRow key={row.id} data={view} row={row} member={members.get(row.id)} plan={planOf(members.get(row.id), view)} lane={lanes.get(row.id)} nameOf={nameOf}
              selected={row.id === selected?.id} holdOn={hold} still={still} now={at} optionId={optionId(row)} onPick={() => pick(row.id)}
              onAct={(name) => actOn(name, members.get(row.id), row)} />
          ) : null)}
          <li id={optionId(you)} role="option" aria-selected={you.id === selected?.id} aria-label="You" className="crew-you-card" onClick={() => pick(you.id)}>
            <span className="crew-you-name"><span className="crew-you-mark" aria-hidden="true" />You</span>
            <Lane you={laneRows.you} />
          </li>
        </ul>
        {rows.length === 1 ? <p className="crew-empty">No agent yet.</p> : null}
      </div>

      <div className="crew-rules">
        <div className="crew-bar">
          <Btn className="crew-start-btn" icon="plus" keys="s" onClick={() => setForm("start")} disabled={!startable} aria-describedby={startable ? undefined : "crew-cannot-start"}>Start an agent</Btn>
          <ul className="crew-holds crew-hold-list" aria-label="Who holds what">
            {render ? (
              <li className={`crew-hold-row${render.holder ? " held" : ""}`} style={render.holder?.color ? { "--who": render.holder.color } : undefined}>
                <span className="crew-hold-mark" aria-hidden="true" />
                <span>{render.holder ? `${render.holder.name} is rendering` : "Nobody is rendering"}</span>
                {render.holder ? <Btn kind="quiet" className="icon-only crew-free" icon="x" aria-label={`free render from ${render.holder.name}`} title="Release" onClick={() => free(render)} /> : null}
              </li>
            ) : null}
            {parts.map((row) => (
              <li key={row.key} className="crew-hold-row held" style={row.holder.color ? { "--who": row.holder.color } : undefined}
                title={row.waiting.length ? `Waiting: ${row.waiting.map((waiter) => waiter.name).join(", ")}` : undefined}>
                <Icon name="lock" />
                <span>{row.holder.name} holds {row.label}{row.waiting.length ? ` +${row.waiting.length}` : ""}</span>
                <Btn kind="quiet" className="icon-only crew-free" icon="x" aria-label={`free ${row.label} from ${row.holder.name}`} title="Release" onClick={() => free(row)} />
              </li>
            ))}
          </ul>
          {rules ? (
            <div className="crew-limits">
              <span className="crew-rule-num"><span>Helpers each</span><Stepper value={rules.leads.helpers} min={0} max={8} label="Helpers each lead may start" onSave={(helpers) => saveRules({ leads: { helpers } }, `Each lead may have up to ${helpers} helpers.`)} /></span>
              <span className="crew-rule-num"><span>At once</span><Stepper value={rules.atOnce} min={1} max={12} label="Agents at work at once, at most" onSave={(atOnce) => saveRules({ atOnce }, `At most ${atOnce} agents at once.`)} /></span>
              <span className="crew-rule-num"><span>Ask me past</span><span className="crew-unit"><Stepper value={rules.budget.calls} min={1} max={10000} label="Calls before kino asks you" onSave={(calls) => saveRules({ budget: { calls } }, `kino asks you past ${calls} calls.`)} /><span>calls</span></span></span>
              <span className="crew-rule-num"><span>or</span><span className="crew-unit"><Stepper value={rules.budget.minutes} min={1} max={1440} label="Minutes before kino asks you" onSave={(minutes) => saveRules({ budget: { minutes } }, `kino asks you past ${minutes} min.`)} /><span>min</span></span></span>
            </div>
          ) : null}
        </div>
        {!startable ? <p id="crew-cannot-start" className="crew-reason">No claude or codex on this computer.</p> : null}

        {form && rules ? (
          <StartForm key={form} timer={form === "timer"} rules={rules} canStart={canStart} projectId={projectId} say={say} fail={fail}
            onCancel={() => { setForm(null); listRef.current?.focus(); }}
            onDone={(id) => { setForm(null); setSelectedId(id); listRef.current?.focus(); }} />
        ) : null}

        <div className="crew-more">
          {rules ? (
            <div className="crew-rule-list" role="group" aria-label="Who may start agents">
              <span className="crew-more-label" aria-hidden="true">May start agents</span>
              <Check checked disabled title="You may always start agents.">You</Check>
              <Check checked={rules.notes} onChange={(on) => saveRules({ notes: on }, on ? "Your notes may start an agent when none works on that project." : "Your notes no longer start agents.")}>Your notes</Check>
              <Check checked={rules.leads.on} onChange={(on) => saveRules({ leads: { on } }, on ? "Leads may start helpers." : "Leads may no longer start helpers.")}>
                {leads.length ? leads.map((lead) => lead.name).join(", ") : "Leads"}
              </Check>
              <Check checked={rules.timers} onChange={(on) => saveRules({ timers: on }, on ? "Timers may start agents." : "Timers no longer start agents.")}>Timers</Check>
            </div>
          ) : null}
          <span className="crew-more-keys">
            {rules ? <Btn kind="quiet" icon="timer" keys="t" onClick={() => setForm("timer")}>Add a timer</Btn> : null}
            <Btn kind="quiet" icon="compass" keys="i" onClick={() => runKey("inspire")}>References</Btn>
          </span>
        </div>
      </div>
    </section>
  );
}
