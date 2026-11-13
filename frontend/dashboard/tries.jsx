// The sketch screen (backend/agent/tries.mjs, sketches.mjs): the agent's question about one
// moment of the video, and 2 to 4 versions of it side by side. The person picks one, says none of
// these, or skips; the agent hears it and applies the pick, so the video is built up round by
// round. The question is the line under the versions, in the agent's color, with the answers
// beside it; the rounds so far, the one open and the topics planned next are small steps on top.
//
// Data flow: agent.tries in the snapshot and the "tries" event (state.js) → this screen. The clips
// are GET /api/dashboard/try/<project>/<T1-B.mp4>; an answer is notes {action:"try", round, pick}
// (Dashboard.jsx). A sketch round's clips (SketchRound) carry their sound: one is shown large, a
// click on another brings it forward and plays it, and nothing plays by itself. A clip round's
// clips (ClipRound) are silent and play together on one clock.
import React, { useEffect, useRef, useState } from "react";
import { clockWords } from "./boardRows.js";
import { Btn } from "./controls.jsx";
import { ANSWER_WORDS, answerWords, roundList, shownRound } from "./tryRows.js";
import { ToolIcon } from "./voice.jsx";
import "./tries.css";

const clipUrl = (projectId, file) => `/api/dashboard/try/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
const MARKS = { "✓": "done", "●": "open", "!": "failed" };

const PlayIcon = ({ playing }) => (
  <svg className="try-play-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {playing ? <path d="M5 3v10M11 3v10" /> : <path d="M5 3l8 5-8 5z" />}
  </svg>
);

export function TryScreen({ projectId, tries, shots = [], onAnswer }) {
  const ref = useRef(null);
  useEffect(() => { if (!ref.current?.contains(document.activeElement)) ref.current?.focus(); }, []);
  const round = shownRound(tries);
  const list = roundList(tries, round);
  return (
    <section ref={ref} className="screen try-screen" tabIndex={-1} aria-labelledby="screen-title">
      <h2 id="screen-title" className="sr-only">Sketches</h2>
      {list.length > 1 ? (
        <ol className="try-rounds" aria-label="Rounds">
          {list.map((entry, index) => (
            <li key={entry.key} className={`is-${MARKS[entry.mark] ?? "later"}${entry.current ? " current" : ""}`} aria-current={entry.current ? "step" : undefined}>
              <span className="try-step" aria-hidden="true">{entry.mark === "✓" ? <ToolIcon name="check" /> : index + 1}</span>
              <span className="try-topic">{entry.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {round ? <TryRound key={round.id} projectId={projectId} round={round} shots={shots} onAnswer={onAnswer} />
        : <p className="try-none">No sketches yet. Your agent shows them here when a moment has more than one good way to go.</p>}
    </section>
  );
}

function TryRound(props) {
  return props.round.sketch ? <SketchRound {...props} /> : <ClipRound {...props} />;
}

/** The question as the agent's line, with "None of these" and "Skip"; after an answer, the answer. */
function Ask({ round, open, answer, sent, onChoose }) {
  return (
    <div className={`try-ask${open ? "" : " answered"}`}>
      <p className="voice-line" role="status"><ToolIcon name={open ? "ask" : "check"} /><span>{open || !answer ? round.question : `You picked ${answer}.`}</span></p>
      {open ? (
        <span className="voice-answers">
          <button type="button" className="voice-button" onClick={() => onChoose("none", ANSWER_WORDS.none)}>None of these</button>
          <button type="button" className="voice-button" onClick={() => onChoose("skip", ANSWER_WORDS.skip)}>Skip</button>
        </span>
      ) : sent ? <span className="try-heard">The agent hears it with its next call.</span> : null}
    </div>
  );
}

// A sketch round: each option is a 2 to 10 s sketch of one treatment with its sound. One sketch
// is shown large; a click on a sketch brings it forward and plays it (the others stop, so only
// one is heard), a second click pauses. Before it is played a sketch shows its middle frame, so
// sketches that start alike do not look alike. "Pick" under the large one picks it.
function SketchRound({ projectId, round, onAnswer }) {
  const videos = useRef(new Map());
  const started = useRef(new Set());
  const [shown, setShown] = useState(() => (round.options.some((option) => option.letter === round.pick) ? round.pick : round.options[Math.floor((round.options.length - 1) / 2)]?.letter));
  const [playing, setPlaying] = useState(null);
  const [time, setTime] = useState(0);
  const [sent, setSent] = useState(null);
  const open = round.status === "waiting" && !sent;
  const answer = sent ?? (round.pick ? answerWords(round) : null);
  const length = Math.max(0.1, round.to - round.from);
  const stopAll = () => { for (const video of videos.current.values()) video.pause(); setPlaying(null); };
  const toggle = (letter) => {
    const video = videos.current.get(letter);
    setShown(letter);
    if (!video) return;
    if (playing === letter) { stopAll(); return; }
    stopAll();
    if (!started.current.has(letter) || video.ended || video.currentTime >= (video.duration || Infinity) - 0.05) video.currentTime = 0;
    started.current.add(letter);
    setTime(video.currentTime);
    video.play().then(() => setPlaying(letter)).catch(() => setPlaying(null));
  };
  const choose = (pick, words) => { stopAll(); setSent(words); onAnswer(round, pick); };
  useEffect(() => () => stopAll(), []);
  return (
    <div className="try-round try-sketches">
      {round.status === "failed" ? <p className="err">These sketches could not be made: {round.error}.</p> : null}
      <div className={`try-options count-${round.options.length}`}>
        {round.options.map((option) => {
          const on = shown === option.letter;
          const plays = playing === option.letter;
          return (
            <figure key={option.letter} className={`try-option${on ? " shown" : ""}${round.pick === option.letter ? " picked" : ""}${plays ? " playing" : ""}`}>
              <div className="try-video">
                {option.ready ? (<>
                  <video ref={(element) => { if (element) videos.current.set(option.letter, element); else videos.current.delete(option.letter); }}
                    src={clipUrl(projectId, option.file)} playsInline preload="auto" aria-hidden="true"
                    onLoadedMetadata={(event) => { if (!started.current.has(option.letter)) event.currentTarget.currentTime = (event.currentTarget.duration || length) / 2; }}
                    onTimeUpdate={(event) => { if (plays) setTime(event.currentTarget.currentTime); }}
                    onEnded={() => setPlaying((now) => (now === option.letter ? null : now))} />
                  <button type="button" className="try-play" aria-pressed={plays}
                    aria-label={`${plays ? "Pause" : "Play"} sketch ${option.letter}: ${option.name}, with sound`} onClick={() => toggle(option.letter)}>
                    <PlayIcon playing={plays} />
                  </button>
                  {plays ? <span className="try-progress" style={{ width: `${Math.min(100, (time / length) * 100)}%` }} aria-hidden="true" /> : null}
                </>) : <span className="try-missing">{option.error ? "Could not be made" : "Making it"}</span>}
              </div>
              <figcaption>
                <span className="try-name" title={option.name}>{option.name}</span>
                {on && plays ? <span className="try-clock" aria-live="off">{clockWords(time)} / {clockWords(length)}</span> : null}
                {round.pick === option.letter ? <span className="ui-chip accent">Picked</span>
                  : on && open && option.ready ? <Btn kind="primary" icon="check" onClick={() => choose(option.letter, `${option.letter}, ${option.name}`)} aria-label={`Pick ${option.letter}: ${option.name}`}>Pick</Btn> : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <Ask round={round} open={open} answer={answer} sent={sent} onChoose={choose} />
    </div>
  );
}

// A clip round: the 2 s around one moment, 2 to 4 ways, silent, the same size, on one clock.
function ClipRound({ projectId, round, shots, onAnswer }) {
  const videos = useRef(new Map());
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sent, setSent] = useState(null);
  const length = Math.max(0.1, round.to - round.from);
  const open = round.status === "waiting" && !sent;
  const answer = sent ?? (round.pick ? answerWords(round) : null);
  const all = () => [...videos.current.values()];
  // One clock: the first clip leads, the others follow it.
  useEffect(() => {
    if (!playing) { for (const video of all()) video.pause(); return undefined; }
    const list = all();
    if (!list.length) { setPlaying(false); return undefined; }
    for (const video of list) { if (video.currentTime >= length - 0.05) video.currentTime = 0; video.play().catch(() => {}); }
    let frame = 0;
    const step = () => {
      const lead = all()[0];
      if (!lead) return;
      for (const video of all().slice(1)) if (Math.abs(video.currentTime - lead.currentTime) > 0.08) video.currentTime = lead.currentTime;
      setTime(lead.currentTime);
      if (lead.ended || lead.currentTime >= length - 0.02) { setPlaying(false); return; }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const seek = (value) => {
    setPlaying(false);
    setTime(value);
    for (const video of all()) video.currentTime = value;
  };
  const choose = (pick, words) => {
    setPlaying(false);
    setSent(words);
    onAnswer(round, pick);
  };
  const moment = ((round.at - round.from) / length) * 100;
  const total = shots.length ? Math.max(...shots.map((shot) => shot.cue + shot.dur)) : 0;
  return (
    <div className="try-round try-clips">
      {round.status === "failed" ? <p className="err">These options could not be made: {round.error}.</p> : null}
      <div className={`try-options count-${round.options.length}`}>
        {round.options.map((option) => (
          <figure key={option.letter} className={`try-option${round.pick === option.letter ? " picked" : ""}`}>
            <div className="try-video">
              {option.ready ? (
                <video ref={(element) => { if (element) videos.current.set(option.letter, element); else videos.current.delete(option.letter); }}
                  src={clipUrl(projectId, option.file)} muted playsInline preload="auto" aria-label={`Option ${option.letter}: ${option.name}`} />
              ) : <span className="try-missing">{option.error ? "Could not be made" : "Making it"}</span>}
            </div>
            <figcaption>
              <span className="try-name" title={option.name}>{option.name}</span>
              {round.pick === option.letter ? <span className="ui-chip accent">Picked</span>
                : open && option.ready ? <Btn icon="check" onClick={() => choose(option.letter, `${option.letter}, ${option.name}`)} aria-label={`Pick ${option.letter}: ${option.name}`}>Pick</Btn> : null}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="try-controls">
        <button type="button" className="try-all" aria-pressed={playing} aria-label={playing ? "Pause" : "Play every option together (no sound)"} onClick={() => setPlaying(!playing)}>
          <PlayIcon playing={playing} />
        </button>
        <span className="try-scrub">
          <input type="range" min={0} max={length} step={1 / 30} value={time} aria-label="Time in the options" onChange={(event) => seek(Number(event.target.value))} />
          <span className="try-moment" style={{ left: `${moment}%` }} title="The moment" aria-hidden="true" />
        </span>
        <span className="try-clock">{clockWords(time)} / {clockWords(length)}</span>
      </div>
      {total > 0 ? (
        <div className="try-shots" aria-hidden="true">
          {shots.map((shot, index) => <span key={shot.id ?? index} className="try-shot" style={{ left: `${(shot.cue / total) * 100}%`, width: `${(shot.dur / total) * 100}%` }}>{index + 1}</span>)}
          <span className="try-at" style={{ left: `${(round.at / total) * 100}%` }} />
        </div>
      ) : null}
      <Ask round={round} open={open} answer={answer} sent={sent} onChoose={choose} />
    </div>
  );
}
