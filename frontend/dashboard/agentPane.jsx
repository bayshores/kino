// [2] The agent pane, right of the stage (F1): the agent at work and everything about the
// session, as views behind one row of tabs.
//   agent    "activity": its bot, how it is, its last call, follow, its calls (time, verb, what,
//            result; see and undo on hover), and what it said (why)
//            With two or more agents at work it is the crew view instead (crewPane.jsx).
//   notes    your notes as a conversation, and share-link comments (LogPane's notes tab)
//   checks   the quality findings (LogPane's checks tab)
//   seen     the pictures the agent looked at (SeenPane, bare)
//   session  needs you, agents, brief, stops, plan, media, renders (SessionPane, bare), and
//   log      the turns (LogPane's log): from ⌘K; their tab shows while one is open
// What waits for you is a card on top (NeedsYouCard); with no agent at work for 2 min the pane
// folds to a slim rail (AgentRail) until something happens. The note box is at the bottom.
// The facts are plain functions in agentView.js.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot } from "./bot.jsx";
import { moodOfRow } from "./bot.js";
import { agentLog, agentSaid, agentTask, crewAgents, isWorking, paneIdle, planStep, railAgents, rowSentence, stepWords, turnWords } from "./agentView.js";
import { needsYouRows } from "./state.js";
import { theAgent } from "./agentLabels.js";
import { AgentName, Pane, Spinner } from "./panes.jsx";
import { notesForYou } from "./noteSpot.js";
import { ago } from "./format.js";
import * as server from "./api.js";
import { AgentRail, Glyph, NeedsYouCard } from "./live.jsx";
import { CrewView } from "./crewPane.jsx";
import { ToolIcon } from "./voice.jsx";

/** The views, in tab order: [id, word]. */
export const AGENT_VIEWS = [["agent", "All"], ["log", "Edits"], ["seen", "Looks"], ["checks", "Checks"], ["notes", "Notes"], ["session", "Session"]];
// The tabs always shown.
const TAB_VIEWS = new Set(["agent", "log", "notes", "checks", "seen", "session"]);

/**
 * One call in the agent's log, as a sentence after its tool's icon; hovering it shows "See" (its
 * pictures) and "Undo" (its edit). A row with facts under it opens on a click.
 */
function LogRow({ row, still, onSee, onUndo }) {
  const [open, setOpen] = useState(false);
  const more = row.details.length > 0;
  return (
    <li className={`agent-call${row.current ? " current" : ""}${more ? " has-more" : ""}${open ? " open" : ""}`}>
      <span className="call-line" onClick={more ? (event) => { if (!event.target.closest("button")) setOpen((value) => !value); } : undefined}>
        <span className="call-time">{row.at}</span>
        <span className={`call-verb v-${row.kind}`}><ToolIcon name={row.verb} /><span className="call-verb-word">{row.verb}</span></span>
        <span className="call-text" title={row.text}>{rowSentence(row)}{row.count > 1 ? <span className="call-count"> ×{row.count}<span className="sr-only"> times</span></span> : null}</span>
        <span className={`call-result r-${row.result.mark}`}>
          {row.result.mark === "running" ? <Spinner still={still} /> : row.result.text}
          <span className="sr-only">{{ running: " running", done: " done", failed: " failed", waits: " waits for you", held: " held", ops: " operations" }[row.result.mark] ?? ""}</span>
        </span>
        {row.images || row.rev != null ? (
          <span className="call-hover">
            {row.images ? <button type="button" className="tb tb-box" onClick={onSee} title="See the frames it looked at (l)"><Glyph name="eye" /> See</button> : null}
            {row.rev != null ? <button type="button" className="tb tb-box" onClick={() => onUndo(row.rev)} title="Undo this edit's turn"><Glyph name="undo" /> Undo</button> : null}
          </span>
        ) : null}
        {more ? <button type="button" className="call-more" aria-expanded={open} aria-label={open ? "Hide the facts of this call" : "Show the facts of this call"} onClick={() => setOpen((value) => !value)}><ToolIcon name="down" /></button> : null}
      </span>
      {row.details.length ? (
        <ul className="call-details">
          {row.details.map((line, index) => <li key={index}><span className="tree" aria-hidden="true">{index === row.details.length - 1 ? "└" : "├"}</span> {line}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

/** The agent view: who, how it is, follow, the log, why. */
export function AgentView({ data, agent, still, now, follow = null, onFollow, onSee, onUndo }) {
  const rows = agentLog(data, agent);
  const said = agentSaid(data, agent);
  const logRef = useRef(null);
  const stick = useRef(true);
  // The newest call stays in view while the log is scrolled to its end.
  // (After every render: a panel opening above it changes the log's height too.)
  useLayoutEffect(() => {
    const box = logRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  });
  if (!agent) return <p className="faint agent-empty">No agent has called kino in this project yet. Connect one in settings.</p>;
  const task = agentTask(data, agent, now);
  const working = isWorking(data, agent, now) && agent.status !== "needs-you" && task !== "ready for you";
  return (
    <div className="agent-view">
      <div className="agent-head">
        <Bot color={agent.color} mood={moodOfRow(data, agent, now)} size={34} still={still} />
        {working ? <span className="agent-working"><Spinner still={still} /></span> : null}
        <div className="agent-what">
          <p className="agent-task">{task}</p>
          <p className="agent-step dim">{[stepWords(planStep(data.agent?.plan)), agent.lastAt ? `last call ${ago(agent.lastAt, now)} ago` : ""].filter(Boolean).join(" · ")}</p>
        </div>
        {follow != null ? (
          <button type="button" className={`tb tb-box agent-follow${follow ? " on" : ""}`} aria-pressed={follow} onClick={onFollow}
            title={follow ? "Follow the agent: on (f)" : "Follow the agent: off (f)"} aria-keyshortcuts="f"><Glyph name="eye" /> follow</button>
        ) : null}
      </div>
      {/* A run of the same call takes the wider time column ("22:27–22:30"). */}
      <ol className={`agent-log${rows.some((row) => row.at.includes("–")) ? " has-spans" : ""}`} ref={logRef} role="log" aria-label={`${agent.name}'s calls`} aria-live="polite"
        onScroll={(event) => { const box = event.currentTarget; stick.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 2; }}>
        {rows.length ? rows.map((row) => <LogRow key={row.key} row={row} still={still} onSee={onSee} onUndo={onUndo} />) : <li className="faint">No calls yet.</li>}
      </ol>
      {said.why ? <p className="agent-why" aria-label={`Why, as ${agent.name} said`}><span className="faint">why</span> {said.why}</p> : null}
    </div>
  );
}

/**
 * The note box: a note about the whole video. With several agents at work, "to" picks who it is
 * for (the note says so first: "for Nova: …"; every agent reads the project's notes). The
 * point button starts a note at a place on the stage (n).
 */
function NoteBox({ data, agents, to, onTo, onPoint, inputRef }) {
  const [text, setText] = useState("");
  const [state, setState] = useState("");
  const target = agents.find((agent) => agent.id === to) ?? null;
  const name = theAgent(target?.name ?? (agents.length === 1 ? agents[0].name : agents.length ? "the crew" : null));
  const send = async (urgent = false) => {
    const words = text.trim();
    if (!words || !data.projectId) return;
    setState("sending");
    try {
      const reply = await server.act("notes", { action: "add", project: data.projectId, text: target && agents.length > 1 ? `for ${target.agentName ?? target.name}: ${words}` : words, ...(urgent ? { urgent: true } : {}) });
      if (reply.isError) throw new Error(reply.text);
      setText("");
      setState(reply.text?.split(";")[0] ?? "sent");
    } catch (cause) { setState(cause.message); }
  };
  useEffect(() => { if (!state || state === "sending") return undefined; const timer = setTimeout(() => setState(""), 4000); return () => clearTimeout(timer); }, [state]);
  return (
    <form className="note-box" aria-label={`Note for ${name}`} onSubmit={(event) => { event.preventDefault(); send(); }}>
      {agents.length > 1 ? (
        <label className="note-to" style={{ "--who": target?.color ?? "var(--fg1)" }}>
          <span className="sr-only">to</span>
          <span className="live-dot" aria-hidden="true" />
          <select value={to ?? ""} onChange={(event) => onTo(event.target.value || null)}>
            <option value="">all</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
      ) : null}
      <textarea id="message-text" ref={inputRef} rows={1} value={text} maxLength={2000} placeholder={agents.length > 1 ? "Note" : `Note for ${name}`} aria-label={`Note for ${name} about the whole video`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(event.metaKey || event.ctrlKey); } }} />
      <button type="button" className="tb icon-button note-point" onClick={onPoint} aria-label="Point at the stage" title="Point at something on the stage (n)" aria-keyshortcuts="n"><Glyph name="point" /></button>
      <button type="submit" className="tb icon-button note-send" disabled={!text.trim() || state === "sending"} aria-label="Send" title="Send (Enter; ⌘Enter marks it urgent)"><Glyph name="send" /></button>
      <span className="sr-only" role="status">{state === "sending" ? "" : state}</span>
    </form>
  );
}

/**
 * The pane. `view` and `onView` pick the view; `views` holds what each view shows (the session,
 * log, checks, notes and seen bodies come from panes.jsx in bare form); `needs` the count
 * waiting for you. `follow`, `onRun` (the dashboard's commands: follow, note, hold, allow, deny,
 * undo), `onAnswer` (an approval's answer) and `onMaterial(need, answer)` (a material
 * question's answer) wire its buttons.
 */
export function AgentPane({ data, agent, still, now, view, onView, views, noteLine = null, needs = 0, follow = null, checks = null, onRun, onAnswer, onMaterial, onClose = null, ...pane }) {
  const tabsRef = useRef(null);
  const noteRef = useRef(null);
  const [only, setOnly] = useState(null);
  const [selected, setSelected] = useState(null);
  const [to, setTo] = useState(null);
  // The rail: folded while no agent works, unless you opened it (pinned) or something happens.
  const [pinned, setPinned] = useState(false);
  const [folded, setFolded] = useState(false);
  const idle = paneIdle(data, now);
  // Never folded while something waits for you: the pane's card is the one place to answer it.
  // Under the stage (it has a close button, `onClose`) it never folds: it is open because you opened it.
  const railed = !onClose && !pinned && (folded || idle) && !needsYouRows(data).length;
  const wasIdle = useRef(idle);
  useEffect(() => { if (wasIdle.current && !idle) setFolded(false); wasIdle.current = idle; }, [idle]);
  const crew = crewAgents(data, now);
  const crewMode = crew.length >= 2;
  const shownAgent = crewMode ? null : agent;
  const color = shownAgent?.color ?? undefined;
  const shown = AGENT_VIEWS.filter(([id]) => TAB_VIEWS.has(id) || id === view);
  // The notes tab counts what needs you: fixed notes to look at and stopped edits.
  const forYou = notesForYou(data.agent?.notes, data.agent?.stopped);
  const checkCount = (checks?.data?.errors ?? 0) + (checks?.data?.warnings ?? 0);
  // ← and → move between the tabs (the tab list is one Tab stop).
  const onTabKey = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault(); event.stopPropagation();
    const at = shown.findIndex(([id]) => id === view);
    const next = shown[(at + step + shown.length) % shown.length][0];
    onView(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector(`#tab-${next}`)?.focus());
  };
  const undo = async (rev) => {
    const turn = (data.agent?.turns ?? []).find((entry) => (entry.edits ?? []).some((edit) => edit.after === rev));
    if (turn && data.projectId) await server.undoTurn(data.projectId, turn.id).catch(() => {});
  };
  if (railed) {
    return (
      <section className={`pane p-agent railed${still ? " still" : ""}`} data-pane={2} aria-label="Agents">
        <AgentRail agents={railAgents(data)} now={now} notes={forYou} still={still}
          onOpen={() => { setPinned(true); setFolded(false); onView("agent"); }} onNotes={() => { setPinned(true); setFolded(false); onView("notes"); }} />
      </section>
    );
  }
  const title = crewMode ? <span>crew <span className="crew-count">{crew.length} working</span></span> : shownAgent ? <AgentName agent={shownAgent} /> : "agent";
  return (
    <Pane {...pane} number={2} className={`p-agent live-pane${crewMode ? " crew-mode" : ""}`} style={color ? { "--who": color } : undefined} labelId="pane-2-title"
      name={title} title={!crewMode && shownAgent?.kind && shownAgent.kind !== shownAgent.name ? shownAgent.kind : ""}
      facts={<span className="pane-facts-row">
        <span className="turn-words">{turnWords(data)}</span>
        {onClose ? null : <button type="button" className="tb icon-button pane-fold" onClick={() => { setPinned(false); setFolded(true); }} aria-label="Fold the agent pane" title="Fold to a rail"><Glyph name="fold" /></button>}
      </span>}>
      {/* Under the stage the agent's line (voice.jsx) asks and takes the answers. */}
      {onClose ? null : <NeedsYouCard data={data} still={still} now={now} onAnswer={onAnswer ?? (() => {})} onRun={onRun ?? (() => {})} onMaterial={onMaterial} />}
      <div className="view-tabs" role="tablist" aria-label="Agent pane views" ref={tabsRef} onKeyDown={onTabKey}>
        {shown.map(([id, word]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={view === id} tabIndex={view === id ? 0 : -1}
            className="tb view-tab" onClick={() => onView(id)}>
            {id === "agent" && crewMode ? "Crew" : word}
            {id === "session" && needs ? <span className="tab-count urgent" aria-label={`, ${needs} waiting for you`}>{needs}</span> : null}
            {id === "notes" && forYou ? <span className="tab-count urgent" aria-label={`, ${forYou} for you`}>{forYou}</span> : null}
            {id === "checks" && checkCount ? <span className="tab-count" aria-label={`, ${checkCount} findings`} title={`${checks.data.errors ?? 0} errors · ${checks.data.warnings ?? 0} warnings, every check`}>{checkCount}</span> : null}
          </button>
        ))}
        {onClose ? <button type="button" className="tb icon-button view-close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Glyph name="close" /></button> : null}
      </div>
      <div className="view-body">
        {view === "agent" ? (
          <div role="tabpanel" id="panel-agent" aria-labelledby="tab-agent" className="panel-agent">
            {crewMode ? (
              <CrewView data={data} agents={crew} now={now} still={still} only={only} onOnly={setOnly} selected={selected} onSelect={setSelected}
                onMessage={(id) => { setTo(id); noteRef.current?.focus(); }} onHoldAll={() => onRun?.("hold")}
                onHold={(member, on) => server.holdAgent(member.id, on).catch(() => {})} onStop={(member) => server.stopAgent(member.id).catch(() => {})} />
            ) : (
              <AgentView data={data} agent={shownAgent} still={still} now={now} follow={follow} onFollow={() => onRun?.("follow")} onSee={() => onView("seen")} onUndo={undo} />
            )}
          </div>
        ) : views[view]}
      </div>
      {noteLine === false ? null : <NoteBox key={data.projectId ?? ""} data={data} agents={crewMode ? crew : shownAgent ? [shownAgent] : []} to={to} onTo={setTo} onPoint={() => onRun?.("note")} inputRef={noteRef} />}
    </Pane>
  );
}
