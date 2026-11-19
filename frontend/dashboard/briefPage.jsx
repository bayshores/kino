// The brief page: what this video is for, in the agent's saved words, as one big sentence; its
// length, shape and shots, with "Add files" and "Note to the agent" on the same line; then the
// brief's lines, the plan and the stops at the left and the renders at the right. A part with
// nothing in it is not drawn (no heading over "none yet"). Read only, as the session view's
// brief is: you change the brief by telling your agent. The rows come from the same functions as
// the session view (state.js).
import React, { useRef } from "react";
import { renderFileUrl } from "./api.js";
import { Btn, Icon } from "./controls.jsx";
import { planRows, stopRows } from "./state.js";
import { StopLines } from "./stops.jsx";
import "./briefPage.css";

const RENDER_FINISHED = ["done", "canceled", "failed", "error", "gone"];

/** 14 → "14 s", 75.5 → "1:15" */
function lengthWords(seconds) {
  const value = Math.round(Number(seconds) || 0);
  return value < 60 ? `${value} s` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** 1920, 1080 → "16:9"; an odd shape reads as its pixels. */
function shapeWords(width, height) {
  if (!width || !height) return "";
  const known = [[16, 9], [9, 16], [1, 1], [4, 5], [4, 3], [21, 9]].find(([a, b]) => Math.abs(width / height - a / b) < 0.01);
  return known ? `${known[0]}:${known[1]}` : `${width}×${height}`;
}

/**
 * `brief` is briefRows (state.js); `document` the open project's document. `onNote()` starts a
 * note to the agent, `onAddFiles(files)` adds media, `onReopen(row)` and `onKeepAsking()` are the
 * stop lines' buttons and `onCancelRender(id)` stops a render (Render itself is on the top line).
 */
export function BriefScreen({ data, brief, document, onNote, onAddFiles, onReopen, onKeepAsking, onCancelRender }) {
  const fileRef = useRef(null);
  const scenes = document?.scenes ?? [];
  const first = scenes[0] ?? null;
  const headline = brief.lines.find((line) => line.name === "message") ?? brief.lines[0] ?? null;
  const rest = brief.lines.filter((line) => line !== headline);
  const shots = document?.board?.shots?.length ?? 0;
  const facts = [
    scenes.length ? ["timer", lengthWords(scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0))] : null,
    first ? ["frame", shapeWords(first.width, first.height)] : null,
    shots ? ["grid", `${shots} shot${shots === 1 ? "" : "s"}`] : null,
    scenes.length > 1 ? ["layers", `${scenes.length} scenes`] : null,
  ].filter((fact) => fact?.[1]);
  const plan = planRows(data.agent?.plan, 99);
  const stops = stopRows(data);
  const renders = (data.renders ?? []).filter((job) => job.projectId === data.projectId);
  // Without a brief the page says so in two parts: "No brief" as its headline, the reason under it
  // (state.js writes them as one line, "no brief: this video was started without one").
  const [none, why = ""] = String(brief.empty ?? "no brief yet").split(/:\s*/);
  const left = rest.length > 0 || plan.length > 0 || stops.length > 0;
  // Two columns only when both sides have something; else one column, and the buttons end at its
  // edge. With nothing under the facts ("bare") the buttons follow the facts instead.
  const two = left && renders.length > 0;
  return (
    <section className={`screen brief-page${two ? "" : " narrow"}${left || renders.length > 0 ? "" : " bare"}`} tabIndex={-1} aria-labelledby="screen-title">
      <h2 id="screen-title" className={headline ? "brief-headline" : "brief-headline none"} aria-label={headline ? `Brief: ${headline.text}` : "Brief"}>
        {headline ? headline.text : capital(none)}
      </h2>
      {!headline && why ? <p className="brief-why">{capital(why)}.</p> : null}
      <div className="brief-bar">
        <ul className="brief-facts" aria-label="This video">
          {facts.map(([icon, words]) => <li key={icon}><Icon name={icon} />{words}</li>)}
          {brief.replies ? <li className={brief.confirmed ? "ok" : undefined}><Icon name={brief.confirmed ? "check" : "comment"} />{brief.confirmed ? "Confirmed in chat" : brief.noPlayback ? "Not played back" : "Not confirmed yet"}</li> : null}
        </ul>
        <span className="brief-actions">
          <Btn icon="plus" onClick={() => fileRef.current?.click()} disabled={!data.projectId} title="Add media files to this video (or drop them on the window)">Add files</Btn>
          <input ref={fileRef} type="file" multiple hidden aria-label="Add media files"
            onChange={(event) => { const files = [...event.target.files]; event.target.value = ""; if (files.length) onAddFiles(files); }} />
          <Btn icon="comment" onClick={onNote} disabled={!first} title="Tell the agent what to change in the brief">Note to the agent</Btn>
        </span>
      </div>
      {left || renders.length > 0 ? <div className="brief-cols">
        {left ? <div className="brief-col">
          {rest.length ? <>
            <h3>Brief</h3>
            <ul className="brief-list" aria-label={brief.listLabel}>
              {rest.map((line) => (
                <li key={line.name}>
                  <span aria-hidden="true" className="brief-row">
                    <span className="brief-name">{capital(line.label)}</span>
                    <span className="brief-words">{line.text}{line.by === "you" && line.quote ? <span className="brief-quoted">You said: "{line.quote}"</span> : null}</span>
                    <span className={`ui-chip${line.by === "you" ? " accent" : ""}`}>{line.by === "you" ? "You said" : "Guessed"}</span>
                  </span>
                  <span className="sr-only">{line.sentence}</span>
                </li>
              ))}
            </ul>
            {brief.missing ? <p className="brief-small">{capital(brief.missing)}</p> : null}
            <p className="brief-small">{capital(brief.footnote)}</p>
          </> : null}
          {plan.length > 0 ? <>
            <h3>Plan</h3>
            <ol className="brief-plan" aria-label="Plan">
              {plan.map((step, index) => (
                <li key={index} className={step.state}>
                  <span className="brief-mark" aria-hidden="true">{step.state === "done" ? <Icon name="check" /> : null}</span>
                  <span>{step.text}</span><span className="sr-only"> ({step.state})</span>
                </li>
              ))}
            </ol>
          </> : null}
          {stops.length > 0 ? <>
            <h3>Stops</h3>
            <StopLines rows={stops} onReopen={onReopen} onKeepAsking={onKeepAsking} />
          </> : null}
        </div> : null}
        {renders.length > 0 ? <div className="brief-col">
          <h3>Renders</h3>
            <ul className="brief-renders" aria-label="Renders">
              {renders.map((job) => (
                <li key={job.id}>
                  <span className="brief-render-name">{capital(job.quality)} {job.format}</span>
                  <span className="brief-render-rev">rev {job.rev}</span>
                  {job.status === "done" ? <a className="ui-btn" href={renderFileUrl(job.id)} download><Icon name="download" />Download</a>
                    : !RENDER_FINISHED.includes(job.status) ? <>
                      <span className="brief-render-rev">{Math.round((job.progress ?? 0) * 100)}%</span>
                      <Btn onClick={() => onCancelRender(job.id)} aria-label={`Cancel the ${job.quality} render ${job.id}`}>Cancel</Btn>
                    </> : <span className={job.status === "canceled" ? "brief-render-rev" : "brief-render-failed"}>{capital(job.status)}</span>}
                </li>
              ))}
            </ul>
        </div> : null}
      </div> : null}
    </section>
  );
}

const capital = (words) => String(words).charAt(0).toUpperCase() + String(words).slice(1);
