// The storyboard screen (direction plan §5 "You see"; storyboard v4, 2026-11-07): the rough cut
// plays the shots from their own files at their real lengths, the shot panel shows the picked
// shot (its first and last frame, its length, its options), and the timeline lays every shot out
// by length with its story role, its text and its sound. On a waiting board the person directs it
// without editing anything: a picked option, a new length or "remove shot" becomes that shot's
// note (boardRows.js directionWords), sent with the stop's answer (stops.jsx answer bar). The
// agent's calls wait in a closed "agent's calls".
//
// Data flow: GET /api/dashboard/board-data (api.js boardData; backend/agent/board-data.mjs) →
// boardRows.js (words, directed shots, footage boxes) → these components. The pictures are
// GET /api/dashboard/board-shot PNGs (api.js boardShotUrl); the rough cut plays the media files.
// Nothing moves until the person presses play, and the videos are always muted.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { boardData, boardShotUrl } from "./api.js";
import { timeOfDay } from "./format.js";
import { Back, Screen } from "./screens.jsx";
import {
  changeLines, clockWords, directedShots, footageBox, hasDirection, headChips, LENGTH_LIMITS, OPTION_LETTERS, overlayBoxes, seconds, shotIndexAt, shotLines, shotSentence, shotTags,
  statusWords, steppedLength,
} from "./boardRows.js";

// The picture widths the server makes (F7); the browser picks one for the screen's pixels.
const WIDTHS = [240, 480, 960];
const NOTE_LIMIT = 500;
// The still of each option: A is the shot itself, B and C its options.
const OPTION_PARTS = ["still", "alt1", "alt2"];

const shotUrl = ({ projectId, rev, shot, part = "still", width, tries = 0 }) => `${boardShotUrl({ projectId, rev, shot, part, width })}${tries ? `&try=${tries}` : ""}`;
const hasFootage = (shot) => Boolean(shot.media && shot.media !== "none" && !shot.media.missing);

/**
 * One storyboard: the board a stop showed (`stop`, "C1"), the board of revision `rev`, or with
 * neither the newest board stop's. `version` reads it again when it changes (the stop's status).
 * `ask` is the agent's chat text, in lines, shown when the board cannot be read. `notes` are the
 * person's directions on single shots, {S2: {n, text, pick, length, remove}}, and
 * `onNote(id, entry | null)` changes one; `noCalls` the agent's calls the person said no to, and
 * `onCallNo(call, no)` changes one. Without onNote, or with `readOnly`, nothing takes a direction.
 */
export function BoardView({ projectId, stop = null, rev = null, version = null, ask = null, notes = {}, onNote = null, noCalls = [], onCallNo = null, readOnly = false, compact = false, level = 4 }) {
  const [state, setState] = useState({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // The rough cut's place, in seconds of the directed board, whether it plays, and the shot in the panel.
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState(null);
  const headRef = useRef(null);
  const retried = useRef(false);
  useEffect(() => {
    let live = true;
    boardData(projectId, { stop, rev })
      .then((data) => { if (live) setState({ data, error: null }); })
      .catch((error) => { if (live) setState({ data: null, error: error?.message || "the server did not answer" }); });
    return () => { live = false; };
  }, [projectId, stop, rev, version, attempt]);
  // After "try again" worked, the focus goes to the board's first line, where the alert was.
  useEffect(() => {
    if (state.data && retried.current) { retried.current = false; headRef.current?.focus(); }
  }, [state.data]);

  const { data, error } = state;
  const takesNotes = Boolean(data) && !readOnly && typeof onNote === "function" && data.status === "waiting";
  const directions = takesNotes ? notes ?? {} : {};
  const shots = useMemo(() => directedShots(data, directions), [data, directions]);
  if (error) {
    return (
      <div className="board-error">
        <p role="alert" className="err">The storyboard could not be read: {String(error).replace(/\.\s*$/, "")}.</p>
        <div className="actions"><button type="button" className="tb tb-box" onClick={() => { retried.current = true; setAttempt((value) => value + 1); }}>try again</button></div>
        {ask?.length ? (
          <div className="stop-ask" role="group" aria-label="What the agent sends you">
            <p className="faint" aria-hidden="true">what the agent sends you (the board in words):</p>
            {ask.map((line, index) => <p key={index}>{line}</p>)}
          </div>
        ) : null}
      </div>
    );
  }
  if (!data) return <p className="faint">reading the storyboard…</p>;

  const Heading = `h${level}`;
  const takesNos = takesNotes && typeof onCallNo === "function";
  const total = Number(shots.at(-1)?.end) || 0;
  const answered = Object.fromEntries((data.answer?.shots ?? []).map((note) => [note.id, note.words]));
  const playable = shots.filter((shot) => !shot.removed);
  // The shot in the panel: the one at the playhead while it plays, else the one picked.
  const atTime = playable[shotIndexAt({ shots: playable }, Math.min(time, total))] ?? shots[0];
  const index = Math.max(0, shots.findIndex((shot) => shot.id === (playing ? atTime?.id : picked ?? atTime?.id)));
  const shot = shots[index];
  const choose = (next) => {
    const target = shots[(next + shots.length) % shots.length];
    setPlaying(false);
    setPicked(target.id);
    if (!target.removed) setTime(target.start);
  };
  const setEntry = (id, change) => {
    const base = data.shots.find((entry) => entry.id === id);
    const entry = { n: base.n, text: "", ...(notes?.[id] ?? {}), ...change };
    for (const key of Object.keys(change)) if (change[key] == null) delete entry[key];
    // An open note field keeps the entry while it is still empty.
    onNote(id, hasDirection(entry) || entry.noteOpen ? entry : null);
  };
  return (
    <div className={`board${compact ? " compact" : ""}`}>
      <div className="board-head">
        <p className="board-title" ref={headRef} tabIndex={-1}>{data.stop ?? "not asked yet"} · board r{data.header?.board ?? "?"}</p>
        <ul className="board-chips" aria-label="The board">
          {headChips(data).map((chip) => <li key={chip}>{chip}</li>)}
        </ul>
        {readOnly ? <p className="dim">{statusWords(data, timeOfDay)}</p> : null}
        {data.purpose ? <p className="board-purpose">{data.purpose}</p> : null}
        {changeLines(data).map((line) => <p key={line} className="board-change">{line}</p>)}
        {readOnly && data.answer?.words ? <p>your note: "{data.answer.words}"</p> : null}
      </div>
      <div className={`board-main${(data.header?.height ?? 0) > (data.header?.width ?? 0) ? " tall" : " wide"}`}>
        <RoughCut shots={playable} data={data} total={total} time={Math.min(time, total)} playing={playing} onTime={setTime} onPlaying={setPlaying} projectId={projectId} />
        <ShotPanel key={shot.id} shot={shot} base={data.shots[index]} data={data} projectId={projectId} entry={directions[shot.id] ?? null} takesNotes={takesNotes}
          onEntry={(change) => setEntry(shot.id, change)} answered={answered[shot.id] ?? null} onStep={(step) => choose(index + step)} />
      </div>
      <Timeline shots={shots} data={data} projectId={projectId} current={shot.id} time={Math.min(time, total)} total={total} notes={directions} answered={answered}
        onPick={(at) => choose(at)} />
      <details className="board-calls-box">
        <summary>agent's calls ({data.calls?.length ?? 0}){data.open?.length ? ` · open questions (${Math.min(3, data.open.length)})` : ""}</summary>
        {data.calls?.length ? (
          <ul className="board-list board-calls">
            {data.calls.map((call) => {
              const no = noCalls.includes(call);
              return (
                <li key={call} className={no ? "said-no" : undefined}>
                  <span className="call-words">{call}</span>
                  {takesNos ? (
                    <button type="button" className="tb call-no" aria-pressed={no} aria-label={no ? `Take back the no to: ${call}` : `Say no to: ${call}`}
                      onClick={() => onCallNo(call, !no)}>{no ? "no ✓" : "no"}</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : <p className="faint indent">none</p>}
        {data.open?.length ? (
          <>
            <Heading className="board-section">open questions</Heading>
            <ul className="board-list">{data.open.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
          </>
        ) : null}
      </details>
    </div>
  );
}

/**
 * The rough cut: the shots from their own files, cropped as the video crops them, at their
 * directed lengths, with their text on top (title cards on the video's background). Play runs
 * from the playhead (from the start once it reached the end) and stops at the end; the files
 * play muted. Paused, each file shows the frame at the playhead.
 */
function RoughCut({ shots, data, total, time, playing, onTime, onPlaying, projectId }) {
  const header = data.header ?? {};
  const ratio = `${header.width || 9} / ${header.height || 16}`;
  const shot = shots[shotIndexAt({ shots }, time)] ?? null;
  const videos = useRef(new Map());
  const timeRef = useRef(time);
  timeRef.current = time;
  // The clock: the playhead moves with the real time while it plays.
  useEffect(() => {
    if (!playing || !(total > 0)) return undefined;
    const from = timeRef.current >= total ? 0 : timeRef.current;
    const started = performance.now();
    let frame = 0;
    const step = (now) => {
      const at = from + (now - started) / 1000;
      if (at >= total) { onTime(total); onPlaying(false); return; }
      onTime(at);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);
  // The file at the playhead: at its in-point plus the time into the shot, at the shot's speed.
  const fileTime = (entry, at) => (typeof entry.in === "number" ? entry.in : 0) + Math.max(0, at - entry.start) * (Number(entry.speed) || 1);
  const src = shot && hasFootage(shot) && shot.media.kind === "video" ? shot.media.src : null;
  useEffect(() => {
    for (const [key, video] of videos.current) if (key !== src || !playing) video.pause();
    const video = src ? videos.current.get(src) : null;
    if (!video) return;
    video.playbackRate = Number(shot.speed) || 1;
    const want = fileTime(shot, timeRef.current);
    if (Math.abs(video.currentTime - want) > 0.05) video.currentTime = want;
    if (playing) video.play().catch(() => {});
  }, [shot?.id, src, playing, playing ? 0 : time]);
  const sources = [...new Set(shots.filter((entry) => hasFootage(entry) && entry.media.kind === "video").map((entry) => entry.media.src))];
  const box = shot ? footageBox(shot, header) : null;
  const place = box ? { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` } : null;
  const covered = data.covered;
  return (
    <section className="board-cut" aria-label="The rough cut">
      <div className="cut-monitor" style={{ aspectRatio: ratio, background: header.background ?? "#000000" }}>
        {sources.map((file) => (
          <video key={file} ref={(element) => { if (element) videos.current.set(file, element); else videos.current.delete(file); }} src={file} muted playsInline preload="auto"
            className="cut-footage" hidden={file !== src} style={file === src ? place ?? undefined : undefined} aria-hidden="true" />
        ))}
        {shot && hasFootage(shot) && shot.media.kind === "image" ? <img className="cut-footage" src={shot.media.src} alt="" style={place ?? undefined} /> : null}
        {/* A file kino no longer has: the server's still says so in the picture. */}
        {shot && shot.media !== "none" && shot.media?.missing ? <img className="cut-footage cut-whole" src={shotUrl({ projectId, rev: data.rev, shot: shot.id, width: 480 })} alt="" /> : null}
        {shot && shot.text && shot.text !== "none" ? <ShotText text={shot.text} header={header} /> : null}
        {covered ? (
          <span className="reel-covered" aria-hidden="true">
            <span className="board-covered right" style={{ width: `${covered.right}%`, bottom: `${covered.bottom}%` }} />
            <span className="board-covered bottom" style={{ height: `${covered.bottom}%` }}>{covered.verified ? "app" : "app (unverified)"}</span>
          </span>
        ) : null}
        <button type="button" className={`cut-play${playing ? " playing" : ""}`} aria-pressed={playing} onClick={() => onPlaying(!playing)}
          aria-label={playing ? "Pause the rough cut" : "Play the rough cut (no sound)"} title={playing ? "pause" : "play the rough cut, muted"}>
          <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
        </button>
        <span className="cut-clock" aria-label={`at ${seconds(time)} of ${seconds(total)} seconds`}>{clockWords(time)} / {clockWords(total)}</span>
      </div>
    </section>
  );
}

// A shot's words on the rough cut: centered, 86% of the frame wide, the middle at text.y %, in
// its font and size (a share of the frame's height, so it scales with the monitor).
function ShotText({ text, header }) {
  const height = Number(header.height) || 1920;
  const size = text.size ?? Math.round(height * 0.05);
  return (
    <p className="cut-text" aria-hidden="true" style={{ top: `${text.y ?? 20}%`, fontFamily: `"${text.family}", sans-serif`, fontWeight: text.weight ?? 700,
      fontSize: `${(size / height) * 100}cqh`, color: text.fill ?? "#ffffff" }}>{text.text}</p>
  );
}

/**
 * The shot panel: the shot's place and reason, ‹ and › (k and j), its first and last frame
 * with their times in the file, its length (− and + on a waiting board, "was" once changed),
 * its options (A is the shot, B and C the agent's alternatives; a press picks one), remove
 * shot, a note (c), and "crop and numbers". The panel is the shot's article: a screen reader
 * hears its sentence (boardRows.js shotSentence) and not the pictures.
 */
function ShotPanel({ shot, base, data, projectId, entry, takesNotes, onEntry, answered, onStep }) {
  const [failed, setFailed] = useState({});
  const [tries, setTries] = useState(0);
  const [more, setMore] = useState(false);
  const rowRef = useRef(null);
  const sentenceId = `board-${shot.id}`;
  const noteId = `board-note-${shot.id}`;
  const lines = shotLines(base, data);
  const tags = shotTags(base, data);
  const tall = (data.header?.height ?? 0) > (data.header?.width ?? 0);
  const ratio = `${data.header?.width || 9} / ${data.header?.height || 16}`;
  const noteOpen = entry && typeof entry.text === "string" && (entry.noteOpen || entry.text.trim());
  const fail = (part) => setFailed((value) => (value[part] ? value : { ...value, [part]: true }));
  const look = tags.some((tag) => tag.tone === "look");
  const changed = tags.some((tag) => tag.tone === "change");
  const openNote = () => {
    if (!noteOpen) onEntry({ noteOpen: true });
    const field = window.document.getElementById(noteId);
    if (field) field.focus();
    else requestAnimationFrame(() => window.document.getElementById(noteId)?.focus());
  };
  const leaveNote = (event) => {
    event.preventDefault();
    if (!String(entry?.text ?? "").trim()) onEntry({ noteOpen: null, text: "" });
    rowRef.current?.focus();
  };
  // The frames: the shot's first and last (a picked option shows its own first frame only).
  const option = shot.picked;
  const speed = Number(shot.speed) || 1;
  const frames = [{ part: OPTION_PARTS[option], at: shot.in, name: "first" }];
  if (!option && hasFootage(shot) && shot.media.kind === "video") frames.push({ part: "last", at: Number(shot.in) + Number(base.dur) * speed, name: "last" });
  const options = [base, ...(base.alts ?? [])].slice(0, 3);
  const length = entry?.length?.to ?? base.dur;
  const step = (by) => {
    const to = steppedLength(length, by);
    onEntry({ length: Math.abs(to - base.dur) < 0.05 ? null : { to, was: base.dur } });
  };
  return (
    <article ref={rowRef} className={`board-shot${tall ? " tall" : " wide"}${noteOpen || answered ? " noted" : ""}${look ? " flagged" : ""}${changed ? " changed" : ""}${shot.removed ? " removed" : ""}`}
      tabIndex={0} data-shot={shot.id} data-n={shot.n} {...(takesNotes ? { "data-notes": "" } : {})} aria-labelledby={sentenceId}>
      <p id={sentenceId} className="sr-only">{shotSentence(base, data)}</p>
      <div className="shot-head">
        <p className="board-row-head" aria-hidden="true"><strong>shot {shot.n}</strong> <span className="board-why">{shot.why || "no reason given"}</span></p>
        <span className="shot-steps">
          <button type="button" className="tb tb-box" data-shot-prev aria-label="previous shot" title="previous shot (k)" onClick={() => onStep(-1)}>‹</button>
          <button type="button" className="tb tb-box" data-shot-next aria-label="next shot" title="next shot (j)" onClick={() => onStep(1)}>›</button>
        </span>
      </div>
      <div className="shot-body">
        <div className="shot-frames" aria-hidden="true">
          {frames.map((frame) => (
            <figure key={frame.name} className="board-still">
              {failed[frame.part] ? <Missing ratio={ratio}>could not be shown</Missing> : (
                <div className="board-frame" style={{ aspectRatio: ratio }}>
                  <img src={shotUrl({ projectId, rev: data.rev, shot: shot.id, part: frame.part, width: 240, tries })}
                    srcSet={WIDTHS.map((w) => `${shotUrl({ projectId, rev: data.rev, shot: shot.id, part: frame.part, width: w, tries })} ${w}w`).join(", ")}
                    sizes={tall ? "14ch" : "28ch"} alt="" width={data.header?.width || 9} height={data.header?.height || 16} loading="lazy" decoding="async" onError={() => fail(frame.part)} />
                </div>
              )}
              <figcaption>{typeof frame.at === "number" && hasFootage(shot) ? `${seconds(frame.at)} s` : "title card"}</figcaption>
            </figure>
          ))}
        </div>
        <div className="shot-length">
          <p className="faint" id={`board-length-${shot.id}`}>length</p>
          {takesNotes && !shot.removed ? (
            <span className="stepper" role="group" aria-labelledby={`board-length-${shot.id}`}>
              <button type="button" className="tb" aria-label={`shorter by ${LENGTH_LIMITS.step} s`} disabled={length <= LENGTH_LIMITS.min} onClick={() => step(-LENGTH_LIMITS.step)}>−</button>
              <output aria-live="polite">{seconds(length)} s</output>
              <button type="button" className="tb" aria-label={`longer by ${LENGTH_LIMITS.step} s`} disabled={length >= LENGTH_LIMITS.max} onClick={() => step(LENGTH_LIMITS.step)}>+</button>
            </span>
          ) : <p>{shot.removed ? "removed" : `${seconds(length)} s`}</p>}
          {entry?.length ? <p className="board-change">was {seconds(entry.length.was)} s</p> : null}
        </div>
        <ShotTags tags={tags.filter((tag) => tag.kind !== "options")} />
      </div>
      {options.length > 1 ? (
        <div className="shot-options">
          <p className="faint">options</p>
          <div className="option-cards" role={takesNotes ? "group" : undefined} aria-label={takesNotes ? `options for shot ${shot.n}` : undefined}>
            {options.map((choice, at) => {
              const on = (entry?.pick?.n ?? 0) === at;
              const why = choice.why || (at ? "no reason given" : "as made");
              const Card = takesNotes ? "button" : "div";
              return (
                <Card key={at} {...(takesNotes ? { type: "button", "aria-pressed": on, onClick: () => onEntry({ pick: at ? { n: at, letter: OPTION_LETTERS[at], why } : null }) } : {})}
                  className={`board-option${on ? " on" : ""}`} aria-label={`option ${OPTION_LETTERS[at]}: ${why}`}>
                  <span className="option-picture" aria-hidden="true" style={{ aspectRatio: tall ? "16 / 9" : ratio }}>
                    {failed[`option${at}`] ? null : <img src={shotUrl({ projectId, rev: data.rev, shot: shot.id, part: OPTION_PARTS[at], width: 240, tries })} alt="" loading="lazy" decoding="async" onError={() => fail(`option${at}`)} />}
                    <span className="option-letter">{on ? "✓" : OPTION_LETTERS[at]}</span>
                  </span>
                  <span className="option-why" aria-hidden="true">{why}</span>
                </Card>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="shot-actions">
        {takesNotes ? (
          <>
            <button type="button" className="tb tb-box" aria-pressed={Boolean(shot.removed)} onClick={() => onEntry({ remove: shot.removed ? null : true })}>{shot.removed ? "keep shot" : "remove shot"}</button>
            {noteOpen ? null : <button type="button" className="tb tb-box" data-note-open aria-keyshortcuts="c" title="note on this shot (c)" onClick={openNote}>note on shot {shot.n}</button>}
          </>
        ) : null}
        <details className="board-more" onToggle={(event) => setMore(event.currentTarget.open)}>
          <summary>crop and numbers</summary>
          <div className="board-more-body">
            {more ? <SourceFrame shot={base} projectId={projectId} rev={data.rev} failed={failed.source} tries={tries} onFail={() => fail("source")} /> : null}
            <dl className="board-lines">
              {lines.map((line) => (
                <div key={line.name} className={line.tone ? `board-${line.tone}` : undefined}>
                  <dt>{line.name}</dt><dd>{line.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      </div>
      {takesNotes && noteOpen ? (
        <div className="board-note">
          <label htmlFor={noteId}>note on shot {shot.n}</label>
          <input id={noteId} type="text" value={entry.text} maxLength={NOTE_LIMIT} autoComplete="off"
            placeholder="Enter or Esc keeps it; it goes with your answer"
            onChange={(event) => onEntry({ text: event.target.value, noteOpen: true })}
            onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Enter") leaveNote(event); }}
            onBlur={() => { if (!String(entry.text ?? "").trim()) onEntry({ noteOpen: null, text: "" }); }} />
        </div>
      ) : null}
      {answered ? <p className="board-your-note">your note on shot {shot.n}: "{answered}"</p> : null}
      {Object.keys(failed).length ? (
        <div className="actions"><button type="button" className="tb" onClick={() => { rowRef.current?.focus(); setFailed({}); setTries((value) => value + 1); }}>retry the pictures of shot {shot.n}</button></div>
      ) : null}
    </article>
  );
}

/**
 * The timeline: every shot as wide as its directed length, its story role above it (hook,
 * reveal, payoff), its number, ↝ for a move into it and ✓ for a picked option; then the text
 * lane and the sound lane (each shot's sound effect, and the music under the whole board). A
 * press on a shot puts it in the panel and the playhead at its start.
 */
function Timeline({ shots, data, projectId, current, time, total, notes, answered, onPick }) {
  const share = (value) => (total > 0 ? (value / total) * 100 : 0);
  const at = (shot) => ({ left: `${share(shot.start)}%`, width: `${share(shot.dur)}%` });
  const noted = (id) => Boolean(String(notes?.[id]?.text ?? "").trim() || answered?.[id]);
  const music = data.music && data.music !== "none" ? data.music : null;
  return (
    <section className="board-timeline" aria-label="Timeline">
      <span className="board-lane-name" aria-hidden="true">shots</span>
      <div className="board-lane board-lane-shots" role="group" aria-label="Shots by length">
        {shots.map((shot, index) => {
          const flagged = Boolean(shot.measures?.flags?.length);
          const changed = Boolean(shot.change) || Boolean(data.redone?.missed?.includes(shot.id));
          const move = shot.move && shot.move !== "none" && !shot.move.none;
          return (
            <button key={shot.id} type="button" data-shot={shot.id} className={`board-clip${shot.id === current ? " on" : ""}${shot.removed ? " removed" : ""}`} style={at(shot)}
              aria-label={`shot ${shot.n}, ${shot.removed ? "removed" : `${seconds(shot.dur)} s`}${shot.role ? `, ${shot.role}` : ""}${shot.picked ? `, option ${OPTION_LETTERS[shot.picked]}` : ""}${flagged ? ", look at it" : ""}${changed ? ", changed" : ""}${noted(shot.id) ? ", has your note" : ""}`}
              aria-current={shot.id === current ? "true" : undefined} onClick={() => onPick(index)}>
              <span className="seg-film" style={{ backgroundImage: `url("${shotUrl({ projectId, rev: data.rev, shot: shot.id, part: OPTION_PARTS[shot.picked], width: 240 })}")` }} />
              <span className="seg-n" aria-hidden="true">{shot.n}{move ? <span className="clip-move" title={String(shot.move.name ?? shot.move.kind ?? "move").replaceAll("-", " ")}> ↝</span> : null}{shot.picked || shot.lengthChanged ? <span className="clip-picked"> ✓</span> : null}</span>
              {flagged || changed || noted(shot.id) ? (
                <span className="seg-marks" aria-hidden="true">
                  {flagged ? <i className="mark-look" /> : null}
                  {changed ? <i className="mark-change" /> : null}
                  {noted(shot.id) ? <i className="mark-note" /> : null}
                </span>
              ) : null}
            </button>
          );
        })}
        {/* The story roles, above their shots (outside the buttons, which clip what they hold). */}
        {shots.filter((shot) => shot.role && !shot.removed).map((shot) => <span key={shot.id} className="clip-role" style={{ left: `${share(shot.start)}%` }} aria-hidden="true">{shot.role}</span>)}
        <span className="cut-head" style={{ left: `${total > 0 ? Math.min(100, share(time)) : 0}%` }} aria-hidden="true" />
      </div>
      <span className="board-lane-name" aria-hidden="true">text</span>
      <div className="board-lane board-lane-words" aria-hidden="true">
        {shots.filter((shot) => !shot.removed && shot.text && shot.text !== "none").map((shot) => <span key={shot.id} className="board-lane-item" style={at(shot)}>{shot.text.text}</span>)}
      </div>
      <span className="board-lane-name" aria-hidden="true">sound</span>
      <div className="board-lane board-lane-words board-lane-sound" aria-hidden="true">
        {shots.filter((shot) => !shot.removed && shot.sound && shot.sound !== "none").map((shot) => <span key={shot.id} className="board-lane-item" style={at(shot)}>♪ {shot.sound.what}</span>)}
        {music ? <span className="board-lane-music">music: {music}</span> : null}
        {!music && !shots.some((shot) => shot.sound && shot.sound !== "none") ? <span className="board-lane-empty">no music or sound yet</span> : null}
      </div>
    </section>
  );
}

// A shot's layers in a few words each (boardRows.js shotTags); nothing when it has none.
function ShotTags({ tags }) {
  if (!tags.length) return null;
  return (
    <ul className="board-tags" aria-hidden="true">
      {tags.map((tag, index) => <li key={index} className={`tag-${tag.kind}${tag.tone ? ` board-${tag.tone}` : ""}`}>{tag.text}</li>)}
    </ul>
  );
}

// A failed or absent picture: its words in the box, at the picture's size.
const Missing = ({ ratio, children }) => <div className="board-missing" style={{ aspectRatio: ratio }}>{children}</div>;

function SourceFrame({ shot, projectId, rev, failed, tries, onFail }) {
  const media = shot.media;
  const width = media?.width || 16;
  const height = media?.height || 9;
  const ratio = `${width} / ${height}`;
  if (!media || media === "none") return <figure className="board-source"><Missing ratio="16 / 9">no footage</Missing><figcaption>source</figcaption></figure>;
  if (media.missing) return <figure className="board-source"><Missing ratio="16 / 9">media missing: {String(media.src).split("/").pop()}</Missing><figcaption>source</figcaption></figure>;
  const url = (w) => shotUrl({ projectId, rev, shot: shot.id, part: "source", width: w, tries });
  const at = media.kind === "image" ? "the picture" : `at ${seconds(shot.in)} s`;
  const alt = `the source frame of shot ${shot.n}, ${at}`;
  const boxes = overlayBoxes(shot);
  return (
    <figure className="board-source">
      {failed ? <Missing ratio={ratio}>{alt} could not be shown</Missing> : (
        <div className="board-frame" style={{ aspectRatio: ratio }}>
          <img src={url(480)} srcSet={WIDTHS.map((w) => `${url(w)} ${w}w`).join(", ")} sizes="(max-width: 719px) 92vw, 40ch" alt={alt}
            width={width} height={height} decoding="async" onError={onFail} />
          {boxes ? <Overlay boxes={boxes} /> : null}
        </div>
      )}
      <figcaption>source, {at}{boxes?.crop && !failed ? " · dashed: the crop" : ""}</figcaption>
    </figure>
  );
}

// The crop (dashed, the rest dimmed), each subject box and the eye line, in % of the source
// frame; their labels where boardRows.js overlayBoxes put them, inside the frame.
function Overlay({ boxes }) {
  const { crop, subjects, eyes, labels } = boxes;
  const rect = (box) => ({ x: box.left, y: box.top, width: box.width, height: box.height });
  return (
    <>
      <svg className="board-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
        {crop ? <path className="board-outside" fillRule="evenodd" d={`M0 0H100V100H0Z M${crop.left} ${crop.top}h${crop.width}v${crop.height}h${-crop.width}Z`} /> : null}
        {crop ? <rect className="board-crop-under" {...rect(crop)} vectorEffect="non-scaling-stroke" /> : null}
        {crop ? <rect className="board-crop" {...rect(crop)} vectorEffect="non-scaling-stroke" /> : null}
        {subjects.map((box, index) => <rect key={index} className="board-subject" {...rect(box)} vectorEffect="non-scaling-stroke" />)}
        {eyes ? <line className="board-eyes" x1={eyes.left} x2={eyes.left + eyes.width} y1={eyes.top} y2={eyes.top} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {labels.map((label, index) => <span key={index} className={`board-label ${label.kind}`} style={label.style}>{label.text}</span>)}
    </>
  );
}

/**
 * The storyboard screen ({name:"board"}, `:board` when no board stop was asked yet): the board now,
 * read only, "not asked yet"; "No storyboard yet." when the video has none.
 */
export function BoardScreen({ projectId, document, revision, onBack }) {
  return (
    <Screen title="storyboard" actions={<Back onBack={onBack} />}>
      {document?.board?.shots?.length ? <BoardView projectId={projectId} rev={revision} version={revision} readOnly level={3} />
        : <p className="faint">No storyboard yet. The agent writes one with edit {"{op:\"board\"}"} and shows it to you at the storyboard stop.</p>}
    </Screen>
  );
}
