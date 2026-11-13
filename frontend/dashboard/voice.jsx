// The agent's line under the frame: what it does now, as one sentence in kino's yellow, with the
// line before it in quiet text above. When something waits for you the sentence is the question
// and its answers sit beside it; on hold it is "On hold" and Release; while a render runs it is
// the frame count and Cancel. The words are plain functions in agentView.js (voiceLine).
import React from "react";
import { voiceLine } from "./agentView.js";
import { frameUrl } from "./api.js";
import { clock } from "./format.js";
import { MaterialChoices } from "./live.jsx";

// One line icon per tool (16 px box, 1.4 px lines), so a line says what kind of call it was
// before it is read.
const SHAPES = {
  edit: "M10.5 2.5l3 3-8 8h-3v-3z",
  look: "M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  check: "M3 8.5l3 3 7-7",
  render: "M2.5 3h11v10h-11zM5.5 3v10M10.5 3v10M2.5 6.3h3M2.5 9.7h3M10.5 6.3h3M10.5 9.7h3",
  library: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm3.5-1.5L14 14",
  inspect: "M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  notes: "M2.5 3h11v8h-6l-3 2.5V11h-2z",
  status: "M3 4h10M3 8h10M3 12h6",
  project: "M2 4.5V12.5h12V6H7.5L6 4.5z",
  history: "M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7M2.5 2.7v3h3M8 5v3l2 1.3",
  ask: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.4M8 11.3v.2",
  hold: "M5.5 3v10M10.5 3v10",
  undo: "M5.5 4 2.5 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7",
  arrow: "M3 8h10M9 4l4 4-4 4",
  x: "M4 4l8 8M12 4l-8 8",
  up: "M8 13V3M4 7l4-4 4 4",
  pin: "M8 14s4.5-4 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 10 8 14 8 14zM8 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  record: "M2 4.5h8v7H2zM10 7l4-2v6l-4-2",
  plug: "M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2",
};

/** A tool's icon ("edit", "look", …); an unknown tool gets the plain lines of "status". */
export function ToolIcon({ name }) {
  return <svg className="tool-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d={SHAPES[name] ?? SHAPES.status} /></svg>;
}

/** The frame before and after an edit, small, with an arrow between them. */
function BeforeAfter({ data, scene, time, before, after }) {
  if (!data.projectId || !scene || before == null || after == null) return null;
  const url = (rev) => frameUrl({ projectId: data.projectId, sceneId: scene.id, time, width: 160, rev, low: true });
  return (
    <span className="voice-pair" aria-hidden="true">
      <img src={url(before)} alt="" draggable={false} /><ToolIcon name="arrow" /><img src={url(after)} alt="" draggable={false} />
    </span>
  );
}

/**
 * `agent` is the agent shown; `time` and `scene` what the stage shows. `onRun(action)` runs the
 * dashboard's commands ("allow", "deny", "undo", "hold"), `onAnswer(id, decision, always)` answers
 * an approval, `onMaterial(need, answer)` a material question, `onCancelRender()` stops the
 * render, `onStopRecording()` a screen recording, and `onHistory()` opens the earlier lines.
 */
export function Voice({ data, agent, now, scene, time, still, listOpen = false, onRun, onAnswer, onMaterial, onCancelRender, onStopRecording, onHistory }) {
  const nameOf = (id) => data.agents?.find((entry) => entry.id === id)?.name;
  const line = voiceLine(data, agent, now, nameOf);
  const { need } = line;
  const approval = need?.row.type === "approval" ? need.row.approval : null;
  const material = need?.row.type === "material" ? need.row.need : null;
  // An edit's line shows the frame before and after it.
  const edit = line.state === "working" || line.state === "idle"
    ? (data.agent?.turns ?? []).flatMap((turn) => turn.edits ?? []).findLast((entry) => entry.after === data.record?.revision && line.verb === "edit") ?? null : null;
  const who = need?.words.who ?? agent?.name ?? "the agent";
  return (
    <section className={`voice is-${line.state}${still ? " still" : ""}`} aria-label={need ? `${who} needs you` : `What ${who} is doing`} style={agent?.color ? { "--who": agent.color } : undefined}>
      <p className="voice-before">
        {line.before ? <><ToolIcon name={line.before.verb} /><span className="voice-before-text" title={line.before.text}>{line.before.text}</span></> : null}
        {line.before?.rev != null && line.state !== "need" ? (
          <button type="button" className="voice-icon" onClick={() => onRun("undo")} aria-label="Undo the last turn" title="Undo the last turn (u)" aria-keyshortcuts="u"><ToolIcon name="undo" /></button>
        ) : null}
        {line.state !== "empty" ? (
          <button type="button" className="voice-icon" onClick={onHistory} aria-expanded={listOpen} aria-controls="pane-2-title" aria-label={listOpen ? "Close the earlier lines" : "Earlier lines"} title={listOpen ? "Close the earlier lines" : "Earlier lines, checks and notes"}>
            <ToolIcon name={listOpen ? "x" : "history"} /></button>
        ) : null}
      </p>
      <div className="voice-row">
        {edit ? <BeforeAfter data={data} scene={scene} time={time} before={edit.before} after={edit.after} /> : null}
        {/* The sentence is announced when it changes (politely; a question at once). */}
        <p className="voice-line" role="status" aria-live={need ? "assertive" : "polite"} key={line.text}>
          <ToolIcon name={line.verb} /><span>{line.text}</span>
        </p>
        {line.state === "need" && need.words.allow ? (
          <span className={`voice-answers${material ? " choices" : ""}`}>
            {material ? <MaterialChoices need={material} onPick={onMaterial} className="voice-button" recommendedClass="primary" /> : approval ? <>
              <button type="button" className="voice-button primary" onClick={() => onAnswer(approval.id, "allow", false)} title="Allow once (a)" aria-keyshortcuts="a">Allow</button>
              <button type="button" className="voice-button" onClick={() => onAnswer(approval.id, "allow", true)} title="Always allow this (A)" aria-keyshortcuts="Shift+A">Always</button>
              <button type="button" className="voice-button" onClick={() => onAnswer(approval.id, "deny", false)} title="Not yet (d)" aria-keyshortcuts="d">Not yet</button>
            </> : <>
              <button type="button" className="voice-button primary" onClick={() => onRun("allow")} title={`${need.words.allow} (a)`} aria-keyshortcuts="a">{capital(need.words.allow)}</button>
              {need.words.deny ? <button type="button" className="voice-button" onClick={() => onRun("deny")} title={`${need.words.deny} (d)`} aria-keyshortcuts="d">{capital(need.words.deny)}</button> : null}
            </>}
          </span>
        ) : null}
        {line.state === "hold" ? <span className="voice-answers"><button type="button" className="voice-button primary" onClick={() => onRun("hold")} title="Release: agent writes work again (h)" aria-keyshortcuts="h">Release</button></span> : null}
        {line.state === "recording" ? <span className="voice-answers"><button type="button" className="voice-button rec" onClick={onStopRecording} title="Stop recording (the recording so far is kept)">Stop</button></span> : null}
        {line.state === "render" ? <span className="voice-answers"><button type="button" className="voice-button" onClick={onCancelRender}>Cancel</button></span> : null}
      </div>
      <p className="voice-facts">
        {line.state === "render" ? <span className="voice-meter" aria-hidden="true"><span style={{ width: `${Math.round(line.render.fraction * 100)}%` }} /></span> : null}
        {line.facts.map((fact, index) => <span key={index} title={fact}>{fact}</span>)}
        {need?.more ? <span>{need.more} more waiting</span> : null}
      </p>
    </section>
  );
}

/**
 * The foot line of a page that is not the stage: the frame at the playhead, small, and the
 * agent's line. A click goes back to the stage (`onStage`).
 */
export function PageFoot({ data, agent, now, scene, time, onStage }) {
  const nameOf = (id) => data.agents?.find((entry) => entry.id === id)?.name;
  const line = voiceLine(data, agent, now, nameOf);
  return (
    <button type="button" className={`page-foot is-${line.state}`} onClick={onStage} aria-label={`Back to the stage. ${line.text}`}>
      {scene && data.projectId ? <img src={frameUrl({ projectId: data.projectId, sceneId: scene.id, time, width: 192, rev: data.record?.revision, low: true })} alt="" draggable={false} /> : null}
      <span className="voice-line"><ToolIcon name={line.verb} /><span>{line.text}</span></span>
      {scene ? <span className="page-foot-time">{clock(time)}</span> : null}
    </button>
  );
}

const capital = (words) => String(words).charAt(0).toUpperCase() + String(words).slice(1);
