// The brief, read only (plan B1, decision D9): what the agent saved from its chat with you. You
// change it by telling your agent; nothing here edits it. The session pane shows it as a section
// and the phone as a card under the stage; both start closed, with a one-line summary, and open
// together (the session sections kept on this computer). The words say who said what ("you
// said", "guessed"); the colors only add to them. Each line is drawn for the eye and read out as
// one sentence.
import React from "react";

/** The brief's facts and lines, from briefRows (state.js). */
export function BriefLines({ rows }) {
  if (!rows.replies) return <p className="faint indent">{rows.empty}</p>;
  return (
    <>
      {rows.status ? <p className={`indent ${rows.confirmed ? "ok" : "dim"}`}>{rows.status}</p> : null}
      <p className="dim indent">{rows.replies}</p>
      {rows.empty ? <p className="faint indent">{rows.empty}</p> : (
        <ul className="brief-lines indent" aria-label={rows.listLabel}>
          {rows.lines.map((line) => (
            <li key={line.name}>
              <span aria-hidden="true">
                <span className="brief-label">{line.label}</span>{" "}
                {line.by === "you"
                  ? <><span className="brief-said">you said</span> <span className="brief-quote">"{line.quote}"</span><span className="brief-text block">→ {line.text}</span></>
                  : <><span className="brief-guessed">guessed:</span> <span className="brief-text">{line.text}</span></>}
              </span>
              <span className="sr-only">{line.sentence}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.missing ? <p className="dim indent">{rows.missing}</p> : null}
      {rows.fix ? <p className="dim indent brief-note">{rows.fix}</p> : null}
      <p className="faint indent brief-note">{rows.footnote}</p>
    </>
  );
}

/** The phone's brief card: the same lines under a caret button that opens and closes them. */
export function BriefCard({ rows, open, onToggle }) {
  return (
    <article className="brief-card" aria-labelledby="brief-card-title">
      <h3 id="brief-card-title" className="section-head">
        <button type="button" className="tb caret-button" aria-expanded={open} aria-controls="brief-card-lines" onClick={onToggle}>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span> brief{!open && rows.short ? <span className="dim"> ({rows.short})</span> : null}
        </button>
      </h3>
      <div id="brief-card-lines" hidden={!open}><BriefLines rows={rows} /></div>
    </article>
  );
}
