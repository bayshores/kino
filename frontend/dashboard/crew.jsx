// The crew screen (F2): every agent at work as a card (who, its goal, who started it, what it
// holds, its plan's steps, its current call), their last 10 minutes as swimlanes, the selected
// agent's plan with its buttons, who holds which part of the project, and who may start agents.
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
import { Btn, Icon, Segmented, Stepper, TitledBox } from "./controls.jsx";
import { agoWords, clockOf, crewCard, crewDetail, crewHolds, crewLaneRows, crewLanesSummary, crewMood, crewTable, planOf, withSavedAgents } from "./crewRows.js";

const KIND_LABELS = { "claude-code": "claude code", codex: "codex" };
const PROGRAMS = { "claude-code": "claude", codex: "codex" };
// The time axis: −10:00 … now, every 2 minutes.
const TICKS = [10, 8, 6, 4, 2, 0];

/** A name in its agent's color. */
function Name({ who, className = "" }) {
  return <span className={`crew-name ${className}`} style={who?.color ? { color: who.color } : undefined}>{who?.name}</span>;
}

/** A real checkbox with its words. */
function Check({ checked, disabled = false, onChange, children, title }) {
  return (
    <label className={`crew-check crew-check2${disabled ? " disabled" : ""}`} title={title}>
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

/** The form to start an agent or add a timer, in the rules box. */
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
    <span className="crew-choice"><Segmented name={`${timer ? "timer" : "start"}-${name}`} label={label} value={value} onChange={onChange}
      options={options.map(([key, words]) => ({ value: key, text: words }))} className="crew-seg" /></span>
  );
  return (
    <form className="crew-start" aria-label={timer ? "Add a timer" : "Start an agent"}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
      <label className="ui-field crew-start-task">
        <span className="sr-only">{timer ? "timer task" : "task"}</span>
        <input ref={taskRef} type="text" value={task} maxLength={2000} onChange={(event) => setTask(event.target.value)}
          placeholder={timer ? "what should it do each time?" : "what should the agent do?"} />
      </label>
      <div className="crew-start-row">
        {seg("kind", "Which agent", kind, setKind, Object.entries(KIND_LABELS).map(([key, words]) => [key, `${words}${canStart?.[key] ? "" : " (not found)"}`]))}
        {seg("may", "What it may do", may, setMay, [["all", "everything"], ["look", "look only"]])}
      </div>
      {timer ? (
        <div className="crew-start-row">
          {seg("when", "When it runs", when, setWhen, [["daily", "daily at"], ["hours", "every"]])}
          {when === "daily"
            ? <input type="time" className="crew-time" value={daily} onChange={(event) => setDaily(event.target.value)} aria-label="Time of day" required />
            : <><input type="number" className="crew-number-field" min={1} max={168} value={hours} onChange={(event) => setHours(event.target.value)} aria-label="Hours between runs" style={{ width: "6ch" }} /> <span className="dim">h</span></>}
        </div>
      ) : null}
      <div className="crew-start-row">
        <Btn kind="primary" icon={timer ? "timer" : "plus"} type="submit" keys="Enter" disabled={busy || Boolean(reason)} aria-describedby={reason ? "crew-start-reason" : undefined}>{timer ? "add timer" : "start"}</Btn>
        <Btn kind="quiet" keys="Esc" onClick={onCancel}>cancel</Btn>
        {reason ? <span id="crew-start-reason" className="crew-reason">{reason}</span> : null}
      </div>
    </form>
  );
}

/** One agent's card in the agents pane; the selected one has its watch, hold and stop buttons. */
function AgentCard({ row, member, plan, selected, holdOn, still, optionId, onPick, runKey }) {
  const card = crewCard(member, plan);
  const ended = ["stopped", "done"].includes(member.state);
  const holdable = !ended && !member.fromCalls && (member.role !== "timer" || Boolean(member.process?.running));
  const holding = (member.holding ?? []).map((part) => part.label);
  const label = `${row.name}, ${row.roleWords}, started by ${row.startedBy || "you"}, ${row.doing}, holding ${row.holding === "-" ? "nothing" : row.holding}`;
  return (
    <li id={optionId} role="option" aria-selected={selected} aria-label={label} className="crew-card" style={member.color ? { "--who": member.color } : undefined}
      onClick={onPick} onDoubleClick={() => runKey("watch")}>
      <div className="crew-card-head">
        <Bot className="crew-bot" color={member.color} mood={crewMood(member, holdOn)} size={24} still={still} />
        <div style={{ minWidth: 0 }}>
          <p className="crew-card-name"><strong>{member.name}</strong>{member.task ? <span>{member.task}</span> : null}</p>
          <p className="crew-card-sub">{[row.roleWords, KIND_LABELS[member.kind] ?? member.kindWords ?? member.kind, member.role === "timer" ? row.startedBy : `started by ${row.startedBy || "you"}`].filter(Boolean).join(" · ")}</p>
        </div>
        {holding.length ? <span className="ui-chip crew-holds-chip" title="holds"><Icon name="lock" />{holding.length > 1 ? `${holding[0]} +${holding.length - 1}` : holding[0]}</span> : <span />}
      </div>
      {card.steps ? <div className="crew-steps" aria-hidden="true">{card.steps.map((step, index) => <span key={index} className={step} />)}</div> : null}
      <div className="crew-card-foot">
        <span className="crew-now">{card.now}</span>
        {selected ? (
          <span className="crew-card-keys" onClick={(event) => event.stopPropagation()}>
            <Btn icon="eye" keys="Enter" onClick={() => runKey("watch")}>watch</Btn>
            {holdable ? <Btn icon="hold" keys="h" onClick={() => runKey("hold")}>{member.heldBy ? "release" : "hold"}</Btn> : null}
            {holdable ? <Btn icon="stop" kind="urgent" keys="x" onClick={() => runKey("stop")}>{member.role === "timer" ? "end run" : "stop"}</Btn> : null}
            {member.role === "timer" ? <Btn icon="trash" keys="r" onClick={() => runKey("remove")}>remove</Btn> : null}
          </span>
        ) : card.stepText ? <span className="faint">{card.stepText}</span> : null}
      </div>
    </li>
  );
}

/** The selected agent's box: its plan as a checklist, its facts and buttons. */
function PlanBox({ member, plan, detail, now, onKey }) {
  const current = plan ? plan.findIndex((step) => !step.done) : -1;
  const ended = member && ["stopped", "done"].includes(member.state);
  return (
    <TitledBox className="crew2-plan crew-agent who" labelId="crew-agent-title" style={member?.color ? { "--who": member.color } : undefined}
      title={member ? <><Name who={member} />{detail?.title ? <span className="faint"> · {detail.title}</span> : null}</> : "you"}>
      {!member ? (
        <p className="faint">you start agents, hold and stop them, and set their limits</p>
      ) : <>
        {plan ? (
          <ol className="crew-plan" aria-label="plan">
            {plan.map((step, index) => {
              const state = step.done ? "done" : index === current ? "current" : "todo";
              return (
                <li key={index} className={state}>
                  <span className="crew-plan-mark" aria-hidden="true">{step.done ? <Icon name="check" /> : null}</span>
                  <span>{step.text}<span className="sr-only">{step.done ? " (done)" : index === current ? " (now)" : ""}</span></span>
                </li>
              );
            })}
          </ol>
        ) : detail?.last ? <p className="crew-last-line" title={detail.lastAnswer || undefined}><span className="faint">last </span>{detail.last}</p> : null}
        <dl className="crew-facts2">
          {detail?.may ? <div><dt>may</dt><dd>{detail.may}</dd></div> : null}
          <div><dt>spent</dt><dd>{detail?.spent.callsText}{detail?.spent.timeText ? ` · ${detail.spent.timeText}` : ""}</dd></div>
          {member.startedAt ? <div><dt>started</dt><dd>{agoWords(member.startedAt, now)}</dd></div> : null}
          {detail?.because ? <div><dt>because</dt><dd>{detail.because}</dd></div> : null}
          {member.role === "timer" ? <div><dt>next run</dt><dd>{member.nextRunAt ? clockOf(member.nextRunAt) : "none"}</dd></div> : null}
          {ended ? <div><dt>ended</dt><dd>{member.endReason ?? member.stateWords}{member.endedAt ? `, ${agoWords(member.endedAt, now)}` : ""}</dd></div> : null}
          {detail?.handedBack ? <div><dt>handed back</dt><dd>{detail.handedBack}</dd></div> : null}
        </dl>
        <div className="crew-actions">
          <Btn kind="primary" icon="screen" keys="Enter" onClick={() => onKey("watch")}>watch on stage</Btn>
          <Btn icon="compass" keys="i" onClick={() => onKey("inspire")}>references</Btn>
        </div>
      </>}
    </TitledBox>
  );
}

// Your marks with their words, except a word that would run into the one before (4% of the lane).
function spaced(marks) {
  let last = -1;
  return marks.map((mark) => {
    const shown = mark.x - last >= 0.04;
    if (shown) last = mark.x;
    return { ...mark, shown };
  });
}

/** last 10 min: a lane for you and one per agent. Hidden from screen readers (a summary instead). */
function Lanes({ laneRows }) {
  const count = laneRows.lanes.length;
  return (
    <div className="lanes" style={{ "--lanes": count }}>
      <p className="sr-only">{crewLanesSummary(laneRows)}</p>
      <div aria-hidden="true">
        <div className="lane-row lane-axis">
          <span />
          <div className="lane-track">
            {TICKS.map((minutes) => (
              <span key={minutes} className={`lane-tick${minutes === 8 || minutes === 4 ? " minor" : ""}`} style={{ left: `${100 - minutes * 10}%` }}>{minutes ? `-${minutes}:00` : "now"}</span>
            ))}
          </div>
        </div>
        <div className="lane-row">
          <span className="lane-name"><span className="crew-you-mark" />you</span>
          <div className="lane-track">
            {spaced(laneRows.you).map((mark) => <span key={mark.key} className={`lane-you${mark.x > 0.9 ? " flip" : ""}`} style={{ left: `${mark.x * 100}%` }}>{mark.shown ? mark.word : ""}</span>)}
          </div>
        </div>
        <div className="lane-agents">
          {laneRows.lanes.map((lane) => (
            <div key={lane.id} className="lane-row" style={lane.color ? { "--who": lane.color } : undefined}>
              <span className="lane-name"><Bot color={lane.color} mood={crewMood(lane)} size={12} still /><Name who={lane} /></span>
              <div className="lane-track">
                {lane.note ? <span className="lane-note">{lane.note}</span> : null}
                {lane.held.map((span) => (
                  <span key={span.key} className={`lane-held${span.x > 0.9 ? " flip" : ""}`} style={{ left: `${span.x * 100}%`, width: `${span.width * 100}%` }}><span>held</span></span>
                ))}
                {lane.blocks.map((block) => (
                  <span key={block.key} className={`lane-block k-${block.kind}${block.error ? " error" : ""}`} style={{ left: `${block.x * 100}%`, width: `${block.width * 100}%` }} title={block.label}>
                    {block.label ? <span>{block.label}</span> : null}
                  </span>
                ))}
                {lane.waits.map((wait) => (
                  <span key={wait.key} className={`lane-wait${wait.open ? " open" : ""}`} style={{ left: `${wait.x * 100}%`, width: `${wait.width * 100}%` }}><span>{wait.label}</span></span>
                ))}
                {lane.marks.map((mark) => (
                  <span key={mark.key} className={`lane-mark m-${mark.type}`} style={{ left: `${mark.x * 100}%`, ...(mark.color ? { color: mark.color } : {}) }}>{mark.type === "started" ? "▸" : "◆"}</span>
                ))}
              </div>
            </div>
          ))}
          <div className="lane-links">
            {laneRows.links.map((link) => (
              <span key={link.key} className={`lane-link l-${link.type}`}
                style={{ left: `${link.x * 100}%`, top: `calc(${Math.min(link.from, link.to) + 0.5} * var(--lane-h))`, height: `calc(${Math.abs(link.to - link.from)} * var(--lane-h))` }} />
            ))}
          </div>
        </div>
        <p className="lane-legend">
          <span><span className="legend-edit" /> edit</span><span><span className="legend-look" /> look</span><span><span className="legend-render" /> render</span>
          <span><span className="legend-diamond">◆</span> handed over</span><span><span className="legend-wait" /> needs you</span>
        </p>
      </div>
    </div>
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
  const holds = useMemo(() => crewHolds(view), [view]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(null); // null, "start" or "timer"
  const listRef = useRef(null);
  // The first look: whoever needs you, else the first agent, else you.
  const fallback = rows.find((row) => row.state === "needs-you") ?? rows[1] ?? rows[0];
  const index = Math.max(0, rows.findIndex((row) => row.id === (selectedId ?? fallback?.id)));
  const selected = rows[index] ?? null;
  const member = selected ? members.get(selected.id) ?? null : null;
  const detail = useMemo(() => crewDetail(member, at), [member, at]);
  const rules = crew?.rules ?? null;
  const canStart = crew?.canStart ?? null;
  const startable = canStart && Object.values(canStart).some(Boolean);
  const leads = (crew?.members ?? []).filter((entry) => entry.role === "lead" && !["stopped", "done"].includes(entry.state));
  const working = (crew?.members ?? []).filter((entry) => ["working", "looking"].includes(entry.state)).length;

  // The list takes the focus when the screen opens, so ↑ ↓ and the letter keys act on it.
  useEffect(() => { listRef.current?.focus(); }, []);

  const step = (by) => {
    if (!rows.length) return;
    setSelectedId(rows[Math.max(0, Math.min(rows.length - 1, index + by))].id);
  };
  const act = async (work, done) => {
    try { await work(); if (done) say(done); } catch (cause) { fail(cause); }
  };
  const runKey = (name) => {
    if (name === "start" || name === "timer") { setForm(name); return; }
    if (name === "watch") { if (selected) onWatch({ id: selected.id, name: selected.name }); return; }
    if (name === "inspire") { onInspire?.(); return; }
    if (!member) return;
    // An agent known only from the project's saved calls is not connected: nothing to hold or stop.
    if (member.fromCalls && (name === "hold" || name === "stop")) { say(`${member.name} is not connected now, so there is nothing to ${name}.`); return; }
    const ended = ["stopped", "done"].includes(member.state);
    if (name === "hold" && !ended) {
      const on = !member.heldBy;
      act(() => server.holdAgent(member.id, on), on ? `${member.name} held: its writes are refused until you release it.` : `${member.name} released.`);
    }
    if (name === "stop" && !ended) {
      onConfirm({
        text: member.role === "timer" ? `End ${member.name}'s run now? The timer stays and runs again on its schedule.` : `Stop ${member.name}? ${member.launched ? "kino ends its program; " : ""}its calls are refused from now on.`,
        yes: member.role === "timer" ? "end run" : "stop", run: () => act(() => server.stopAgent(member.id), `${member.name} stopped.`),
      });
    }
    if (name === "remove" && member.role === "timer") {
      onConfirm({ text: `Remove the timer ${member.name}? It will not run again.`, yes: "remove", run: () => act(() => server.removeTimer(member.id), `Timer ${member.name} removed.`) });
    }
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
        <h2 id="crew-heading">crew</h2>
        <p className="faint">This kino server keeps no crew.</p>
      </section>
    );
  }

  const you = rows[0];
  return (
    <section className="screen crew crew2" tabIndex={-1} aria-labelledby="crew-heading" onKeyDown={onKeyDown}>
      <h2 id="crew-heading" className="sr-only">crew</h2>
      <div className="crew2-grid">
        <TitledBox className="crew2-agents crew-table" labelId="crew-table-title"
          title={<>agents{working ? <span className="crew2-count"> {working} working</span> : null}</>}>
          <ul ref={listRef} className="crew-cards" role="listbox" tabIndex={0} aria-labelledby="crew-table-title" aria-activedescendant={selected ? optionId(selected) : undefined}>
            {rows.slice(1).map((row) => members.get(row.id) ? (
              <AgentCard key={row.id} row={row} member={members.get(row.id)} plan={planOf(members.get(row.id), view)} selected={row.id === selected?.id} holdOn={hold} still={still}
                optionId={optionId(row)} onPick={() => pick(row.id)} runKey={runKey} />
            ) : null)}
            <li id={optionId(you)} role="option" aria-selected={you.id === selected?.id} aria-label="you" className="crew-you-card" onClick={() => pick(you.id)}>
              <span className="crew-you-mark" aria-hidden="true" /><strong>you</strong>
            </li>
          </ul>
          {rows.length === 1 ? <p className="faint crew-empty">No agent yet.</p> : null}
          <Btn className="crew-start-btn wide" icon="plus" keys="s" onClick={() => setForm("start")} disabled={!startable} aria-describedby={startable ? undefined : "crew-cannot-start"}>start an agent</Btn>
          {!startable ? <span id="crew-cannot-start" className="crew-reason">No claude or codex on this computer.</span> : null}
        </TitledBox>

        <TitledBox className="crew2-lanes crew-lanes" labelId="crew-lanes-title" title="last 10 min">
          <Lanes laneRows={laneRows} />
        </TitledBox>

        <PlanBox member={member} plan={planOf(member, view)} detail={detail} now={at} onKey={runKey} />

        <TitledBox className="crew2-holds crew-holds" labelId="crew-holds-title" title="who holds what">
          <ul className="crew-hold-list">
            {holds.map((row) => (
              <li key={row.key} className={`crew-hold-row${row.holder ? " held" : ""}`} style={row.holder?.color ? { "--who": row.holder.color } : undefined}>
                <Icon name="lock" />
                <span className="c-part">{row.label}{row.waiting.length ? <span className="waiting"> · waiting: {row.waiting.map((waiter) => waiter.name).join(", ")}</span> : null}</span>
                {row.holder ? <span className="holder">{row.holder.name}</span> : <span className="free">free</span>}
                {row.holder ? (
                  <Btn kind="quiet" className="icon-only crew-free" icon="x" aria-label={`free ${row.label} from ${row.holder.name}`} title="release"
                    onClick={() => act(() => server.freePart(projectId, row.key), `${row.label} freed: another agent may change it now.`)} />
                ) : <span />}
              </li>
            ))}
          </ul>
        </TitledBox>

        <TitledBox className="crew2-rules crew-rules" labelId="crew-rules-title" title="who may start agents">
          {rules ? <>
            <div className="crew-rule-list">
              <Check checked disabled title="You may always start agents.">you</Check>
              <Check checked={rules.notes} onChange={(on) => saveRules({ notes: on }, on ? "Your notes may start an agent when none works on that project." : "Your notes no longer start agents.")}>your notes</Check>
              <Check checked={rules.leads.on} onChange={(on) => saveRules({ leads: { on } }, on ? "Leads may start helpers." : "Leads may no longer start helpers.")}>
                {leads.length ? leads.map((lead) => lead.name).join(", ") : "leads"}
              </Check>
              <Check checked={rules.timers} onChange={(on) => saveRules({ timers: on }, on ? "Timers may start agents." : "Timers no longer start agents.")}>timers</Check>
              <div className="crew-rule-num"><span>helpers each</span><Stepper value={rules.leads.helpers} min={0} max={8} label="Helpers each lead may start" onSave={(helpers) => saveRules({ leads: { helpers } }, `Each lead may have up to ${helpers} helpers.`)} /></div>
              <div className="crew-rule-num"><span>at most at once</span><Stepper value={rules.atOnce} min={1} max={12} label="Agents at work at once, at most" onSave={(atOnce) => saveRules({ atOnce }, `At most ${atOnce} agents at once.`)} /></div>
              <div className="crew-rule-num"><span>ask me past</span><Stepper value={rules.budget.calls} min={1} max={10000} label="Calls before kino asks you" onSave={(calls) => saveRules({ budget: { calls } }, `kino asks you past ${calls} calls.`)} /><span className="faint">calls</span></div>
              <div className="crew-rule-num"><span>or past</span><Stepper value={rules.budget.minutes} min={1} max={1440} label="Minutes before kino asks you" onSave={(minutes) => saveRules({ budget: { minutes } }, `kino asks you past ${minutes} min.`)} /><span className="faint">min</span></div>
            </div>
            {form ? (
              <StartForm key={form} timer={form === "timer"} rules={rules} canStart={canStart} projectId={projectId} say={say} fail={fail}
                onCancel={() => { setForm(null); listRef.current?.focus(); }}
                onDone={(id) => { setForm(null); setSelectedId(id); listRef.current?.focus(); }} />
            ) : (
              <div className="crew-rule-foot">
                <Btn className="wide" icon="timer" keys="t" onClick={() => setForm("timer")}>add a timer</Btn>
              </div>
            )}
          </> : null}
        </TitledBox>
      </div>
    </section>
  );
}
