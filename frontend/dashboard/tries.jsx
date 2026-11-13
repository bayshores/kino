// The try options screen (storyboard v4, backend/agent/tries.mjs): the agent's question about one
// moment of the video, and 2 to 4 versions of that moment (the 2 s around it, from the video
// itself) side by side on one clock. The person picks one, says none of these, or skips; the
// agent hears it and applies the pick, so the video is built up round by round. The rounds so
// far (✓), the one open (●) and the topics the agent plans next (○) are listed on the left.
//
// Data flow: agent.tries in the snapshot and the "tries" event (state.js) → this screen. The clips
// are GET /api/dashboard/try/<project>/<T1-B.mp4>; an answer is notes {action:"try", round, pick}
// (Dashboard.jsx). The clips are silent and play only when play is pressed; a sketch round's clips
// (SketchRound) carry their sound and play one at a time on a click.
import React, { useEffect, useRef, useState } from "react";
import { clockWords } from "./boardRows.js";
import { ANSWER_WORDS, answerWords, roundList, shownRound } from "./tryRows.js";
import { Back, Screen } from "./screens.jsx";
import "./tries.css";

const clipUrl = (projectId, file) => `/api/dashboard/try/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
export function TryScreen({ projectId, tries, shots = [], onAnswer, onBack }) {
  const round = shownRound(tries);
  const list = roundList(tries, round);
  const place = list.findIndex((entry) => entry.current) + 1;
  return (
    <Screen title="try options" className="try-screen" actions={<>
      {round && (round.status === "waiting" || round.status === "rendering") ? <span className="s-needs-you try-place"><span aria-hidden="true">◉</span> round {place} of {list.length}</span> : null}
      <Back onBack={onBack} />
    </>}>
      {round ? (
        <div className="try-body">
          <ol className="try-rounds" aria-label="Rounds">
            {list.map((entry) => (
              <li key={entry.key} className={entry.current ? "current" : undefined} aria-current={entry.current ? "step" : undefined}>
                <span className={`try-mark mark-${entry.mark === "✓" ? "done" : entry.mark === "●" ? "open" : "later"}`} aria-hidden="true">{entry.mark}</span> {entry.text}
              </li>
            ))}
          </ol>
          <TryRound key={round.id} projectId={projectId} round={round} shots={shots} onAnswer={onAnswer} />
        </div>
      ) : <p className="faint">No options to try yet. The agent asks with notes {"{action:\"try\"}"} when a moment has more than one good way to go.</p>}
    </Screen>
  );
}

// A sketch round (backend/agent/sketches.mjs): each option is a 2 to 10 s sketch of one treatment
// with its sound. A click plays that one (the others stop, so only one is heard), a second click
// pauses; nothing plays by itself. One click on ✓ picks it, which saves that treatment as theirs.
function SketchRound({ projectId, round, onAnswer }) {
  const videos = useRef(new Map());
  const [playing, setPlaying] = useState(null);
  const [time, setTime] = useState(0);
  const [sent, setSent] = useState(null);
  const open = round.status === "waiting" && !sent;
  const answer = sent ?? (round.pick ? answerWords(round) : null);
  const stopAll = () => { for (const video of videos.current.values()) video.pause(); setPlaying(null); };
  const toggle = (letter) => {
    const video = videos.current.get(letter);
    if (!video) return;
    if (playing === letter) { stopAll(); return; }
    stopAll();
    if (video.ended || video.currentTime >= (video.duration || Infinity) - 0.05) video.currentTime = 0;
    video.play().then(() => setPlaying(letter)).catch(() => setPlaying(null));
  };
  const choose = (pick, words) => { stopAll(); setSent(words); onAnswer(round, pick); };
  useEffect(() => () => stopAll(), []);
  return (
    <div className="try-round try-sketches">
      <h3 className="try-question">{round.question}</h3>
      {round.status === "failed" ? <p className="err">These sketches could not be made: {round.error}.</p> : null}
      <div className={`try-options count-${round.options.length}`}>
        {round.options.map((option) => (
          <figure key={option.letter} className={`try-option${round.pick === option.letter ? " picked" : ""}${playing === option.letter ? " playing" : ""}`}>
            <div className="try-video">
              {option.ready ? (<>
                <video ref={(element) => { if (element) videos.current.set(option.letter, element); else videos.current.delete(option.letter); }}
                  src={clipUrl(projectId, option.file)} playsInline preload="auto" aria-hidden="true"
                  onTimeUpdate={(event) => { if (playing === option.letter) setTime(event.currentTarget.currentTime); }}
                  onEnded={() => setPlaying((now) => (now === option.letter ? null : now))} />
                <button type="button" className="try-play" aria-pressed={playing === option.letter}
                  aria-label={`${playing === option.letter ? "Pause" : "Play"} sketch ${option.letter}: ${option.name}, with sound`} onClick={() => toggle(option.letter)}>
                  <span aria-hidden="true">{playing === option.letter ? "❚❚" : "▶"}</span>
                </button>
              </>) : <span className="try-missing">{option.error ? "could not be made" : "making…"}</span>}
              <span className="try-letter" aria-hidden="true">{round.pick === option.letter ? "✓" : option.letter}</span>
              {open && option.ready ? (
                <button type="button" className="tb tb-box try-pick" onClick={() => choose(option.letter, `${option.letter} · ${option.name}`)}>✓ pick {option.letter}</button>
              ) : null}
            </div>
            <figcaption>{option.name}</figcaption>
          </figure>
        ))}
      </div>
      <div className="try-controls">
        <span className="try-clock" aria-live="off">{playing ? `${playing} · ${clockWords(time)} / ${clockWords(Math.max(0.1, round.to - round.from))}` : clockWords(Math.max(0.1, round.to - round.from))}</span>
      </div>
      {open ? (
        <div className="actions try-answers">
          <button type="button" className="tb" onClick={() => choose("none", ANSWER_WORDS.none)}>none of these</button>
          <button type="button" className="tb" onClick={() => choose("skip", ANSWER_WORDS.skip)}>skip</button>
        </div>
      ) : answer ? <p className="try-answer" role="status">you picked: {answer}{sent ? " · the agent hears it with its next call" : ""}</p> : null}
    </div>
  );
}

function TryRound(props) {
  return props.round.sketch ? <SketchRound {...props} /> : <ClipRound {...props} />;
}

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
    <div className="try-round">
      <h3 className="try-question">{round.question}</h3>
      {round.status === "failed" ? <p className="err">These options could not be made: {round.error}.</p> : null}
      <div className={`try-options count-${round.options.length}`}>
        {round.options.map((option) => (
          <figure key={option.letter} className={`try-option${round.pick === option.letter ? " picked" : ""}`}>
            <div className="try-video">
              {option.ready ? (
                <video ref={(element) => { if (element) videos.current.set(option.letter, element); else videos.current.delete(option.letter); }}
                  src={clipUrl(projectId, option.file)} muted playsInline preload="auto" aria-label={`option ${option.letter}: ${option.name}`} />
              ) : <span className="try-missing">{option.error ? "could not be made" : "making…"}</span>}
              <span className="try-letter" aria-hidden="true">{round.pick === option.letter ? "✓" : option.letter}</span>
              {open && option.ready ? (
                <button type="button" className="tb tb-box try-pick" onClick={() => choose(option.letter, `${option.letter} · ${option.name}`)}>✓ pick {option.letter}</button>
              ) : null}
            </div>
            <figcaption>{option.name}</figcaption>
          </figure>
        ))}
      </div>
      <div className="try-controls">
        <button type="button" className="tb tb-box" aria-pressed={playing} aria-label={playing ? "Pause" : "Play every option together (no sound)"} onClick={() => setPlaying(!playing)}>
          <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
        </button>
        <span className="try-scrub">
          <input type="range" min={0} max={length} step={1 / 30} value={time} aria-label="Time in the options" onChange={(event) => seek(Number(event.target.value))} />
          <span className="try-moment" style={{ left: `${moment}%` }} title="the moment" aria-hidden="true" />
        </span>
        <span className="try-clock">{clockWords(time)} / {clockWords(length)}</span>
      </div>
      {open ? (
        <div className="actions try-answers">
          <button type="button" className="tb" onClick={() => choose("none", ANSWER_WORDS.none)}>none of these</button>
          <button type="button" className="tb" onClick={() => choose("skip", ANSWER_WORDS.skip)}>skip</button>
        </div>
      ) : answer ? <p className="try-answer" role="status">you picked: {answer}{sent ? " · the agent hears it with its next call" : ""}</p> : null}
      {total > 0 ? (
        <div className="try-shots" aria-hidden="true">
          <span className="faint">shots</span>
          <span className="try-strip">
            {shots.map((shot, index) => <span key={shot.id ?? index} className="try-shot" style={{ left: `${(shot.cue / total) * 100}%`, width: `${(shot.dur / total) * 100}%` }}>{index + 1}</span>)}
            <span className="try-at" style={{ left: `${(round.at / total) * 100}%` }} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
