// The judge box (backend/agent/judge.mjs): two frames over the stage, one from the edit and one
// from a reference the person saved, "which one looks more finished?". Keys 1 and 2 pick a side,
// = about the same, s skip, esc later (a "needs you" row brings it back). At the end it shows
// which was which. The person picks blind: the dashboard learns the sides only when it is done.
import React, { useEffect, useRef, useState } from "react";
import "./judge.css";

const pictureUrl = (projectId, file) => `/api/dashboard/judge/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
const KEYS = { 1: "left", 2: "right", "=": "same", s: "skip", S: "skip" };

/** The counts of a done round, as the agent hears them. */
export function judgeCounts(judge) {
  const counts = { references: 0, same: 0, yours: 0 };
  for (const pair of judge.pairs) {
    if (pair.pick === "same") counts.same += 1;
    else if (pair.pick === "left" || pair.pick === "right") counts[pair.pick === pair.edit ? "yours" : "references"] += 1;
  }
  return counts;
}

/** The pair to pick next: the first without a pick (here or on the server), or null. */
export const nextPair = (judge, picked) => judge.pairs.find((pair) => !pair.pick && !picked[pair.n]) ?? null;

export function JudgeBox({ projectId, judge, onPick, onLater }) {
  const [picked, setPicked] = useState({});
  const boxRef = useRef(null);
  const done = judge.status === "done";
  const pair = done ? null : nextPair(judge, picked);
  const total = judge.pairs.length;
  const place = pair ? judge.pairs.indexOf(pair) + 1 : total;

  const choose = (pick) => {
    if (!pair) return;
    setPicked((value) => ({ ...value, [pair.n]: pick }));
    onPick(pair.n, pick);
  };

  useEffect(() => { boxRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onLater(); return; }
      const pick = KEYS[event.key];
      if (!pick || done) return;
      event.preventDefault(); event.stopPropagation();
      choose(pick);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (done) {
    const counts = judgeCounts(judge);
    return (
      <div className="judge" role="dialog" aria-modal="true" aria-labelledby="judge-title" tabIndex={-1} ref={boxRef}>
        <div className="judge-head">
          <h2 id="judge-title">Which was which</h2>
          <span className="dim">references {counts.references} · same {counts.same} · yours {counts.yours}</span>
        </div>
        <ol className="judge-key">
          {judge.pairs.map((entry) => (
            <li key={entry.n}>
              {entry.files.map((file, index) => {
                const side = index === 0 ? "left" : "right";
                return (
                  <figure key={file} className={entry.pick === side ? "picked" : undefined}>
                    <img src={pictureUrl(projectId, file)} alt="" />
                    <figcaption>{entry.edit === side ? "yours" : "reference"}</figcaption>
                  </figure>
                );
              })}
            </li>
          ))}
        </ol>
        <p className="judge-keys"><button type="button" className="tb" onClick={onLater}><span className="key">esc</span> Close</button></p>
      </div>
    );
  }

  if (!pair) return null;
  return (
    <div className="judge" role="dialog" aria-modal="true" aria-labelledby="judge-title" tabIndex={-1} ref={boxRef}>
      <div className="judge-head">
        <div>
          <h2 id="judge-title">Which one looks more finished?</h2>
          <p className="dim">One is your video, one is a reference you saved. You see which is which at the end.</p>
          {judge.idea?.map((line) => <p key={line} className="dim">{line}</p>)}
        </div>
        <span className="judge-count">{place} of {total}</span>
      </div>
      <div className="judge-pair">
        {pair.files.map((file, index) => (
          <div key={file} className="judge-side">
            <img src={pictureUrl(projectId, file)} alt={`Frame ${index + 1}`} />
            <button type="button" className="tb judge-pick" onClick={() => choose(index === 0 ? "left" : "right")}>
              <span className="key">{index + 1}</span> This one
            </button>
          </div>
        ))}
      </div>
      <p className="judge-keys">
        <button type="button" className="tb" onClick={() => choose("same")}><span className="key">=</span> About the same</button>
        <button type="button" className="tb" onClick={() => choose("skip")}><span className="key">s</span> Skip</button>
        <button type="button" className="tb" onClick={onLater}><span className="key">esc</span> Later</button>
      </p>
    </div>
  );
}
