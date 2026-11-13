// The blind pick box (backend/agent/picks.mjs): two videos side by side, named A and B only, with
// one clock, under the question "which is better?". Both start muted and paused on a frame past
// the opening (6 s into a long clip, which often opens black or blurred); play starts both from 0
// together. One "sound" toggle in the corner of each screen turns that side on (the other goes quiet). A pair queued as sound only shows black; one
// queued as picture only stays muted. The verdicts are "A is better", "B is better", "tie" and
// "both bad" (saved as neither). Keys sit in tooltips, not labels: space play, 1, 2, = tie,
// 0 both bad, a and b sound, esc skip for now. Word chips and a note are optional; at most 5
// picks a sitting.
import React, { useEffect, useRef, useState } from "react";
import "./judge.css";

export const PICK_WORDS = ["story", "directing", "unique", "impressive", "quality", "smooth", "mix"];
const videoUrl = (pairId, side) => `/api/dashboard/picks/${encodeURIComponent(pairId)}/${side}`;
const SIDES = [["left", "A"], ["right", "B"]];
// The verdict row, left to right as the screens are: [pick, label, key].
const VERDICTS = [["left", "A is better", "1"], ["same", "tie", "="], ["neither", "both bad", "0"], ["right", "B is better", "2"]];
// Where a paused, unplayed video rests: past a black or blurred opening. A clip of 20 s or more
// rests at a tenth of its length, at most 6 s in; a shorter one at a quarter, at most 1 s in.
const POSTER_AT = (d) => d >= 20 ? Math.min(6, d * 0.1) : Math.min(1, (d || 0) / 4);
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function Speaker({ on }) {
  return (
    <svg className="picks-speaker" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor" />
      {on ? <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        : <path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

export function PickBox({ picks, onPick, onLater }) {
  const pair = picks.pairs[0];
  const players = { left: useRef(null), right: useRef(null) };
  const boxRef = useRef(null);
  // True until the first play or seek: the videos rest on their poster frame and the clock shows 0.
  const unplayed = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [heard, setHeard] = useState(null);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [words, setWords] = useState([]);
  const [note, setNote] = useState("");
  const audioOnly = pair.mode === "audio";
  const pictureOnly = pair.mode === "picture";
  const both = () => SIDES.map(([side]) => players[side].current).filter(Boolean);

  const play = () => {
    if (unplayed.current) { unplayed.current = false; both().forEach((video) => { video.currentTime = 0; }); }
    const start = Math.min(...both().map((video) => video.currentTime));
    both().forEach((video) => { if (start < (video.duration || Infinity)) video.currentTime = start; video.play().catch(() => {}); });
    setPlaying(true);
  };
  const pause = () => { both().forEach((video) => video.pause()); setPlaying(false); };
  const toggle = () => (playing ? pause() : play());
  const seek = (value) => { unplayed.current = false; both().forEach((video) => { video.currentTime = Math.min(value, video.duration || value); }); setTime(value); };
  const listen = (side) => { if (!pictureOnly) setHeard((value) => (value === side ? null : side)); };
  const toggleWord = (word) => setWords((value) => (value.includes(word) ? value.filter((entry) => entry !== word) : [...value, word]));
  const choose = (pick) => { pause(); onPick(pair.pair_id, pick, words, note.trim()); };

  // A new pair: from the start, quiet, no words.
  useEffect(() => { unplayed.current = true; setPlaying(false); setHeard(null); setTime(0); setLength(0); setWords([]); setNote(""); boxRef.current?.focus(); }, [pair.pair_id]);
  useEffect(() => { for (const [side] of SIDES) if (players[side].current) players[side].current.muted = heard !== side; });
  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = event.target?.tagName === "INPUT";
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (typing) event.target.blur(); else onLater(); return; }
      if (typing) return;
      const action = { " ": toggle, 1: () => choose("left"), 2: () => choose("right"), "=": () => choose("same"), 0: () => choose("neither"), a: () => listen("left"), b: () => listen("right") }[event.key];
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // One clock: the left video's time, the right one kept within 0.15 s while both run.
  const onTime = () => {
    const [left, right] = both();
    if (!left || unplayed.current) return;
    const now = Math.max(left.currentTime, right?.currentTime ?? 0);
    setTime(now);
    if (right && !left.paused && !right.paused && !left.ended && Math.abs(left.currentTime - right.currentTime) > 0.15) right.currentTime = left.currentTime;
  };
  const onEnded = () => { if (both().every((video) => video.ended || video.paused)) setPlaying(false); };
  const onMeta = (event) => {
    setLength(Math.max(...both().map((video) => video.duration || 0)));
    // Rest on a real frame, not a black first one, until play.
    if (unplayed.current) event.currentTarget.currentTime = POSTER_AT(event.currentTarget.duration);
  };

  return (
    <div className="judge picks" role="dialog" aria-modal="true" aria-labelledby="picks-question" tabIndex={-1} ref={boxRef}>
      <div className="judge-head">
        <h2 id="picks-question">which is better?</h2>
        <span className="judge-count">{picks.picked + 1}/{picks.most}{audioOnly ? ", sound only" : pictureOnly ? ", picture only" : ""}</span>
      </div>
      <div className="judge-pair">
        {SIDES.map(([side, name]) => (
          <div key={side} className="judge-side">
            <div className={`picks-screen${audioOnly ? " dark" : ""}`}>
              <video key={`${pair.pair_id}-${side}`} ref={players[side]} src={videoUrl(pair.pair_id, side)} muted playsInline preload="auto"
                onTimeUpdate={onTime} onEnded={onEnded} onLoadedMetadata={onMeta} aria-label={`Video ${name}`} />
              <button type="button" className={`picks-play${playing ? " playing" : ""}`} onClick={toggle}
                aria-label={playing ? "pause both" : "play both"} title={playing ? "pause both (space)" : "play both (space)"}>
                {playing ? null : <span className="picks-play-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="18" height="18" focusable="false"><path d="M5 3l8 5-8 5z" fill="currentColor" /></svg></span>}
              </button>
              <span className="picks-name" aria-hidden="true">{name}</span>
              {pictureOnly ? null : (
                <button type="button" className={`tb picks-sound${heard === side ? " on" : ""}`} aria-pressed={heard === side}
                  aria-label={`sound of ${name}`} title={`sound of ${name} (${name.toLowerCase()})`} onClick={() => listen(side)}>
                  <Speaker on={heard === side} />{heard === side ? "sound on" : "sound off"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="picks-bar">
        <button type="button" className="tb" onClick={toggle} title={`${playing ? "pause" : "play"} both (space)`}>{playing ? "pause" : "play"}</button>
        <input type="range" min="0" max={length || 1} step="0.05" value={Math.min(time, length || 1)} aria-label="Time" onChange={(event) => seek(Number(event.target.value))} />
        <span className="dim">{clock(time)}/{clock(length)}</span>
      </div>
      <div className="picks-why" role="group" aria-labelledby="picks-why">
        <span id="picks-why" className="picks-why-head">why? <span className="dim">(optional)</span></span>
        <div className="picks-words">
          {PICK_WORDS.map((word) => (
            <button key={word} type="button" className={`tb picks-chip${words.includes(word) ? " on" : ""}`} aria-pressed={words.includes(word)} onClick={() => toggleWord(word)}>{word}</button>
          ))}
          <input className="picks-note" type="text" maxLength={500} value={note} placeholder="a note" aria-label="Note" onChange={(event) => setNote(event.target.value)} />
        </div>
      </div>
      <div className="picks-verdicts" role="group" aria-label="Verdict">
        {VERDICTS.map(([pick, label, key]) => (
          <button key={pick} type="button" className={`tb judge-pick${pick === "left" || pick === "right" ? "" : " quiet"}`} title={`${label} (${key})`} onClick={() => choose(pick)}>{label}</button>
        ))}
      </div>
      <p className="judge-keys">
        <button type="button" className="tb" onClick={onLater} title="skip for now (esc)">skip for now</button>
      </p>
    </div>
  );
}
