// The storyboard screen (direction plan §5 "You see"; storyboard v5, the page look of 2026-11-12):
// a grid of shot stills, 4 across and as wide as the stage frame, each with its number, its story
// role on a yellow chip ("1 Hook") and small marks (a note, kino's flag, a change, a picked
// option). A click on a still opens the shot's box under the grid: the rough cut (the shots from
// their own files at their real lengths, muted) beside the shot's details (its reason, first and
// last frame, length, options, remove, a note, crop and numbers). On a waiting board the person
// directs it without editing anything: a picked option, a new length or "remove shot" becomes
// that shot's note (boardRows.js directionWords), sent with the stop's answer (stops.jsx). Under
// the grid: the agent's purpose, the answer the caller passes in (`answer`), and the board's facts
// as chips with play, try options and the agent's calls.
//
// Data flow: GET /api/dashboard/board-data (api.js boardData; backend/agent/board-data.mjs) →
// boardRows.js (words, directed shots, footage boxes) → these components. The pictures are
// GET /api/dashboard/board-shot PNGs (api.js boardShotUrl); the rough cut plays the media files.
// Nothing moves until the person presses play, and the videos are always muted.
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { boardData, boardShotUrl } from "./api.js";
import { timeOfDay } from "./format.js";
import { Btn, Icon } from "./controls.jsx";
import { Screen } from "./screens.jsx";
import {
  changeLines, clockWords, directedShots, footageBox, hasDirection, headChips, LENGTH_LIMITS, OPTION_LETTERS, overlayBoxes, seconds, shotIndexAt, shotLines, shotSentence, shotTags,
  statusWords, steppedLength, styleFrameView,
} from "./boardRows.js";
import "./board.css";

// The picture widths the server makes (F7); the browser picks one for the screen's pixels.
const WIDTHS = [240, 480, 960];
const NOTE_LIMIT = 500;
// The still of each option: A is the shot itself, B and C its options.
const OPTION_PARTS = ["still", "alt1", "alt2"];
// Keys that step through the shots (Dashboard.jsx stepShot once the box is open).
const STEP_KEYS = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };

const shotUrl = ({ projectId, rev, shot, part = "still", width, tries = 0 }) => `${boardShotUrl({ projectId, rev, shot, part, width })}${tries ? `&try=${tries}` : ""}`;
const hasFootage = (shot) => Boolean(shot.media && shot.media !== "none" && !shot.media.missing);
/** "hook" → "Hook": labels and chips start with a capital letter. */
export const capital = (text) => { const words = String(text ?? ""); return words ? words[0].toUpperCase() + words.slice(1) : words; };
/** What a person sees never joins facts with " · ": a comma instead. */
const plain = (text) => String(text ?? "").replaceAll(" · ", ", ");
const typingIn = (element) => Boolean(element?.matches?.("input, textarea, select, [contenteditable=true]"));

/** The agent's question for a board: "Storyboard: 16 shots, 14 s. Go on?" */
export function boardQuestion(data) {
  const count = Number(data?.header?.shots) || data?.shots?.length || 0;
  if (!count) return "Storyboard ready. Go on?";
  return `Storyboard: ${count} shot${count === 1 ? "" : "s"}, ${seconds(data.header?.seconds)} s. Go on?`;
}

/** Play and pause, drawn as lines (the rough cut's buttons). */
const PlayIcon = ({ playing }) => (
  <svg className="board-play-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {playing ? <path d="M5 3v10M11 3v10" /> : <path d="M5 3l8 5-8 5z" />}
  </svg>
);

/** The style frame figure. A failed load hides it in state; a new board revision (the key) tries again. */
function StyleFrame({ data, projectId }) {
  const [failed, setFailed] = useState(false);
  const view = styleFrameView(data);
  if (!view || failed) return null;
  return (
    <figure className="board-style">
      <img src={shotUrl({ projectId, rev: data.rev, shot: view.shot, part: view.part, width: view.width })} alt={view.alt} onError={() => setFailed(true)} />
      <figcaption>{capital(view.caption)}</figcaption>
    </figure>
  );
}

/**
 * One storyboard: the board a stop showed (`stop`, "C1"), the board of revision `rev`, or with
 * neither the newest board stop's. `version` reads it again when it changes (the stop's status).
 * `ask` is the agent's chat text, in lines, shown when the board cannot be read. `notes` are the
 * person's directions on single shots, {S2: {n, text, pick, length, remove}}, and
 * `onNote(id, entry | null)` changes one; `noCalls` the agent's calls the person said no to, and
 * `onCallNo(call, no)` changes one. Without onNote, or with `readOnly`, nothing takes a direction.
 * `trying` is the try round open (tries.jsx); its button opens the try options screen (`onTry`).
 * `answer(question)` draws the answers under the grid (stops.jsx); `actions` sit beside a read-only
 * board's status line (reopen, keep asking).
 */
export function BoardView({ projectId, stop = null, rev = null, version = null, ask = null, notes = {}, onNote = null, noCalls = [], onCallNo = null, readOnly = false, compact = false, level = 4, trying = null, onTry = null, answer = null, actions = null }) {
  const [state, setState] = useState({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // The rough cut's place, in seconds of the directed board, whether it plays, the shot picked
  // and whether its box is open.
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const headRef = useRef(null);
  const boxRef = useRef(null);
  const stills = useRef(new Map());
  const retried = useRef(false);
  const boxId = useId();
  useEffect(() => {
    let live = true;
    boardData(projectId, { stop, rev })
      .then((data) => { if (live) setState({ data, error: null }); })
      .catch((error) => { if (live) setState({ data: null, error: error?.message || "the server did not answer" }); });
    return () => { live = false; };
  }, [projectId, stop, rev, version, attempt]);
  // After "Try again" worked, the focus goes to the board's first line, where the alert was.
  useEffect(() => {
    if (state.data && retried.current) { retried.current = false; headRef.current?.focus(); }
  }, [state.data]);
  // j, k, ↓ and ↑ on the storyboard screen while no box is open: open the shot's box (the
  // dashboard's own keys step through the shots once it is open). Capture runs before them.
  const openRef = useRef(open);
  openRef.current = open;
  const shotsRef = useRef([]);
  useEffect(() => {
    const onKey = (event) => {
      const step = STEP_KEYS[event.key];
      if (!step || openRef.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const root = rootRef.current;
      if (!root || !root.closest(".screen-wrap.is-stop, .screen-wrap.is-board")) return;
      const active = window.document.activeElement;
      if (typingIn(active) || active?.closest?.(".command-line, [role=dialog]")) return;
      const list = shotsRef.current;
      if (!list.length) return;
      event.preventDefault();
      openShot(Math.max(0, list.findIndex((shot) => shot.id === picked)), { focus: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  // An opened box scrolls into view (at once with reduced motion).
  useEffect(() => {
    if (!open || !boxRef.current) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    boxRef.current.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [open]);

  const { data, error } = state;
  const takesNotes = Boolean(data) && !readOnly && typeof onNote === "function" && data.status === "waiting";
  const directions = takesNotes ? notes ?? {} : {};
  const shots = useMemo(() => directedShots(data, directions), [data, directions]);
  shotsRef.current = shots;
  const question = data ? boardQuestion(data) : "Storyboard ready. Go on?";
  const below = typeof answer === "function" ? answer(question) : answer;

  function openShot(at, { focus = false } = {}) {
    const target = shots[(at + shots.length) % shots.length];
    if (!target) return;
    setPlaying(false);
    setPicked(target.id);
    if (!target.removed) setTime(target.start);
    setOpen(true);
    if (focus) requestAnimationFrame(() => rootRef.current?.querySelector("article.board-shot")?.focus());
  }
  const closeBox = () => {
    setPlaying(false);
    setOpen(false);
    const id = shots[index]?.id;
    requestAnimationFrame(() => stills.current.get(id)?.focus());
  };

  if (error) {
    return (
      <div className="board board-error" ref={rootRef}>
        <p role="alert" className="board-alert">The storyboard could not be read: {String(error).replace(/\.\s*$/, "")}.</p>
        <div className="actions"><Btn onClick={() => { retried.current = true; setAttempt((value) => value + 1); }}>Try again</Btn></div>
        {ask?.length ? (
          <div className="stop-ask" role="group" aria-label="What the agent sends you">
            {ask.map((line, index) => <p key={index}>{line}</p>)}
          </div>
        ) : null}
        {below}
      </div>
    );
  }
  if (!data) return <div className="board" ref={rootRef}><p className="board-reading">Reading the storyboard…</p>{below}</div>;

  const Heading = `h${level}`;
  const takesNos = takesNotes && typeof onCallNo === "function";
  const total = Number(shots.at(-1)?.end) || 0;
  const answered = Object.fromEntries((data.answer?.shots ?? []).map((note) => [note.id, note.words]));
  const playable = shots.filter((shot) => !shot.removed);
  // The shot in the box: the one at the playhead while it plays, else the one picked.
  const atTime = playable[shotIndexAt({ shots: playable }, Math.min(time, total))] ?? shots[0];
  const index = Math.max(0, shots.findIndex((shot) => shot.id === (playing ? atTime?.id : picked ?? atTime?.id)));
  const shot = shots[index];
  const tall = (data.header?.height ?? 0) > (data.header?.width ?? 0);
  const ratio = `${data.header?.width || 16} / ${data.header?.height || 9}`;
  const setEntry = (id, change) => {
    const base = data.shots.find((entry) => entry.id === id);
    const entry = { n: base.n, text: "", ...(notes?.[id] ?? {}), ...change };
    for (const key of Object.keys(change)) if (change[key] == null) delete entry[key];
    // An open note field keeps the entry while it is still empty.
    onNote(id, hasDirection(entry) || entry.noteOpen ? entry : null);
  };
  const onBoxKey = (event) => {
    if (event.key !== "Escape" || event.nativeEvent.defaultPrevented) return;
    event.preventDefault();
    closeBox();
  };
  const changes = changeLines(data);
  return (
    <div className={`board${compact ? " compact" : ""}${tall ? " tall" : " wide"}`} ref={rootRef}>
      <ShotGrid shots={shots} data={data} projectId={projectId} ratio={ratio} tall={tall} current={open ? shot?.id : null} playing={playing} notes={directions} answered={answered}
        boxId={boxId} open={open} stills={stills}
        onPick={(at) => (open && shots[at]?.id === shot?.id && !playing ? closeBox() : openShot(at, { focus: true }))} />
      {open && shot ? (
        <div className="board-box" id={boxId} ref={boxRef} onKeyDown={onBoxKey}>
          <RoughCut shots={playable} data={data} total={total} time={Math.min(time, total)} playing={playing} onTime={setTime} onPlaying={setPlaying} projectId={projectId} />
          <ShotPanel key={shot.id} shot={shot} base={data.shots[index]} data={data} projectId={projectId} entry={directions[shot.id] ?? null} takesNotes={takesNotes}
            onEntry={(change) => setEntry(shot.id, change)} answered={answered[shot.id] ?? null} onStep={(step) => openShot(index + step)} onClose={closeBox} />
        </div>
      ) : null}
      {data.purpose || changes.length ? (
        <div className="board-head">
          {data.purpose ? <p className="board-purpose">{capital(data.purpose)}</p> : null}
          {changes.map((line) => <p key={line} className="board-change">{capital(line)}</p>)}
        </div>
      ) : null}
      {readOnly ? (
        <div className="board-status">
          <p className="voice-line"><Icon name="check" /><span>{capital(statusWords(data, timeOfDay))}</span></p>
          {actions}
          {data.answer?.words ? <p className="board-answer-note">Your note: "{data.answer.words}"</p> : null}
        </div>
      ) : null}
      {below}
      <div className="board-facts">
        <p className="board-title" ref={headRef} tabIndex={-1}>{data.stop ?? "Not asked yet"}, board r{data.header?.board ?? "?"}</p>
        <Btn className="board-play" aria-pressed={playing} onClick={() => { if (playing) setPlaying(false); else { if (!open) openShot(index); setPlaying(true); } }}
          aria-label={playing ? "Pause the rough cut" : "Play the rough cut (no sound)"} title="The rough cut, muted"><PlayIcon playing={playing} />{playing ? "Pause" : "Play"}</Btn>
        <ul className="board-chips" aria-label="The board">
          {headChips(data).map((chip) => <li key={chip} className="ui-chip">{capital(chip)}</li>)}
        </ul>
        {trying && onTry ? (
          <Btn className="board-try" onClick={onTry} title={`${trying.id}: ${trying.question}`}>
            Try options <span className="ui-chip accent board-try-count">{trying.options.length}</span>
          </Btn>
        ) : null}
        <StyleFrame key={data.rev} data={data} projectId={projectId} />
        <details className="board-calls-box">
          <summary>Agent's calls <span className="ui-chip">{data.calls?.length ?? 0}</span>{data.open?.length ? <> Open questions <span className="ui-chip">{Math.min(3, data.open.length)}</span></> : null}</summary>
          {data.calls?.length ? (
            <ul className="board-list board-calls">
              {data.calls.map((call) => {
                const no = noCalls.includes(call);
                return (
                  <li key={call} className={no ? "said-no" : undefined}>
                    <span className="call-words">{call}</span>
                    {takesNos ? (
                      <button type="button" className="call-no" aria-pressed={no} aria-label={no ? `Take back the no to: ${call}` : `Say no to: ${call}`}
                        onClick={() => onCallNo(call, !no)}>{no ? <><Icon name="check" />No</> : "No"}</button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="board-none">None</p>}
          {data.open?.length ? (
            <>
              <Heading className="board-section">Open questions</Heading>
              <ul className="board-list">{data.open.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : null}
        </details>
      </div>
    </div>
  );
}

/**
 * The grid of shot stills, a list: each still is a button that opens (or closes) the shot's box.
 * On it: the number (with its story role, yellow, when it has one) and small marks for a move in,
 * a picked option or new length, kino's flag, a change after a redo, and a note.
 */
function ShotGrid({ shots, data, projectId, ratio, tall, current, playing, notes, answered, boxId, open, stills, onPick }) {
  const noted = (id) => Boolean(String(notes?.[id]?.text ?? "").trim() || answered?.[id]);
  return (
    <ul className="board-grid" aria-label="Shots">
      {shots.map((shot, index) => {
        const flagged = Boolean(shot.measures?.flags?.length);
        const changed = Boolean(shot.change) || Boolean(data.redone?.missed?.includes(shot.id));
        const move = shot.move && shot.move !== "none" && !shot.move.none;
        const on = shot.id === current;
        const label = [`Shot ${shot.n}`, shot.removed ? "removed" : `${seconds(shot.dur)} s`, shot.role ?? "", shot.picked ? `option ${OPTION_LETTERS[shot.picked]}` : "",
          flagged ? "look at it" : "", changed ? "changed" : "", noted(shot.id) ? "has your note" : ""].filter(Boolean).join(", ");
        return (
          <li key={shot.id}>
            <button type="button" data-shot={shot.id} ref={(element) => { if (element) stills.current.set(shot.id, element); else stills.current.delete(shot.id); }}
              className={`board-clip${on ? " on" : ""}${on && playing ? " playing" : ""}${shot.removed ? " removed" : ""}`} style={{ aspectRatio: ratio }}
              aria-label={label} aria-expanded={on && open} aria-controls={on && open ? boxId : undefined} aria-current={on ? "true" : undefined} onClick={() => onPick(index)}>
              <img src={shotUrl({ projectId, rev: data.rev, shot: shot.id, part: OPTION_PARTS[shot.picked], width: 480 })}
                srcSet={WIDTHS.map((w) => `${shotUrl({ projectId, rev: data.rev, shot: shot.id, part: OPTION_PARTS[shot.picked], width: w })} ${w}w`).join(", ")}
                sizes={tall ? "(max-width: 699px) 25vw, 12vw" : "(max-width: 699px) 50vw, 25vw"} alt="" loading="lazy" decoding="async" />
              <span className={`clip-n${shot.role ? " clip-role" : ""}`} aria-hidden="true">{shot.n}{shot.role ? ` ${capital(shot.role)}` : ""}</span>
              {move || shot.picked || shot.lengthChanged || flagged || changed || noted(shot.id) ? (
                <span className="seg-marks" aria-hidden="true">
                  {move ? <i className="mark-move" title={capital(String(shot.move.name ?? shot.move.kind ?? "move").replaceAll("-", " "))}><Icon name="chevron" /></i> : null}
                  {shot.picked || shot.lengthChanged ? <i className="mark-picked"><Icon name="check" /></i> : null}
                  {flagged ? <i className="mark-look">!</i> : null}
                  {changed ? <i className="mark-change"><Icon name="pencil" /></i> : null}
                  {noted(shot.id) ? <i className="mark-note"><Icon name="comment" /></i> : null}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
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
  // Closing the box stops every file.
  useEffect(() => () => { for (const video of videos.current.values()) video.pause(); }, []);
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
            <span className="board-covered bottom" style={{ height: `${covered.bottom}%` }}>{covered.verified ? "App" : "App (unverified)"}</span>
          </span>
        ) : null}
        <button type="button" className={`cut-play${playing ? " playing" : ""}`} aria-pressed={playing} onClick={() => onPlaying(!playing)}
          aria-label={playing ? "Pause the rough cut" : "Play the rough cut (no sound)"} title={playing ? "Pause" : "Play the rough cut, muted"}>
          <PlayIcon playing={playing} />
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
 * The shot's details in its box: "Shot 3" and its reason, ‹ and › (k and j), close (Esc), its
 * first and last frame with their times in the file, its tags, its length (− and + on a waiting
 * board, "Was" once changed), its options (A is the shot, B and C the agent's alternatives; a
 * press picks one), remove shot, a note (c), and "Crop and numbers". The article is the shot: a
 * screen reader hears its sentence (boardRows.js shotSentence) and not the pictures.
 */
function ShotPanel({ shot, base, data, projectId, entry, takesNotes, onEntry, answered, onStep, onClose }) {
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
        <p className="board-row-head" aria-hidden="true"><strong>Shot {shot.n}</strong>{shot.role ? <span className="ui-chip accent">{capital(shot.role)}</span> : null}</p>
        <span className="shot-steps">
          <button type="button" className="shot-step" data-shot-prev aria-label="Previous shot" title="Previous shot" aria-keyshortcuts="k" onClick={() => onStep(-1)}><Icon name="chevron" className="flip" /></button>
          <button type="button" className="shot-step" data-shot-next aria-label="Next shot" title="Next shot" aria-keyshortcuts="j" onClick={() => onStep(1)}><Icon name="chevron" /></button>
          <button type="button" className="shot-step" data-shot-close aria-label="Close the shot" title="Close" aria-keyshortcuts="Escape" onClick={onClose}><Icon name="x" /></button>
        </span>
      </div>
      <p className="board-why">{capital(shot.why || "No reason given")}</p>
      <div className="shot-body">
        <div className="shot-frames" aria-hidden="true">
          {frames.map((frame) => (
            <figure key={frame.name} className="board-still">
              {failed[frame.part] ? <Missing ratio={ratio}>Could not be shown</Missing> : (
                <div className="board-frame" style={{ aspectRatio: ratio }}>
                  <img src={shotUrl({ projectId, rev: data.rev, shot: shot.id, part: frame.part, width: 240, tries })}
                    srcSet={WIDTHS.map((w) => `${shotUrl({ projectId, rev: data.rev, shot: shot.id, part: frame.part, width: w, tries })} ${w}w`).join(", ")}
                    sizes={tall ? "8ch" : "18ch"} alt="" width={data.header?.width || 9} height={data.header?.height || 16} loading="lazy" decoding="async" onError={() => fail(frame.part)} />
                </div>
              )}
              <figcaption>{typeof frame.at === "number" && hasFootage(shot) ? `${seconds(frame.at)} s` : "Title card"}</figcaption>
            </figure>
          ))}
        </div>
        <div className="shot-length">
          <p className="board-label-word" id={`board-length-${shot.id}`}>Length</p>
          {takesNotes && !shot.removed ? (
            <span className="stepper" role="group" aria-labelledby={`board-length-${shot.id}`}>
              <button type="button" aria-label={`Shorter by ${LENGTH_LIMITS.step} s`} disabled={length <= LENGTH_LIMITS.min} onClick={() => step(-LENGTH_LIMITS.step)}><Icon name="minus" /></button>
              <output aria-live="polite">{seconds(length)} s</output>
              <button type="button" aria-label={`Longer by ${LENGTH_LIMITS.step} s`} disabled={length >= LENGTH_LIMITS.max} onClick={() => step(LENGTH_LIMITS.step)}><Icon name="plus" /></button>
            </span>
          ) : <p className="shot-length-value">{shot.removed ? "Removed" : `${seconds(length)} s`}</p>}
          {entry?.length ? <p className="board-change">Was {seconds(entry.length.was)} s</p> : null}
        </div>
      </div>
      <ShotTags tags={tags.filter((tag) => tag.kind !== "options")} />
      {options.length > 1 ? (
        <div className="shot-options">
          <p className="board-label-word">Options</p>
          <div className="option-cards" role={takesNotes ? "group" : undefined} aria-label={takesNotes ? `Options for shot ${shot.n}` : undefined}>
            {options.map((choice, at) => {
              const on = (entry?.pick?.n ?? 0) === at;
              const why = choice.why || (at ? "no reason given" : "as made");
              const Card = takesNotes ? "button" : "div";
              return (
                <Card key={at} {...(takesNotes ? { type: "button", "aria-pressed": on, onClick: () => onEntry({ pick: at ? { n: at, letter: OPTION_LETTERS[at], why } : null }) } : {})}
                  className={`board-option${on ? " on" : ""}`} aria-label={`Option ${OPTION_LETTERS[at]}: ${why}`}>
                  <span className="option-picture" aria-hidden="true" style={{ aspectRatio: tall ? "16 / 9" : ratio }}>
                    {failed[`option${at}`] ? null : <img src={shotUrl({ projectId, rev: data.rev, shot: shot.id, part: OPTION_PARTS[at], width: 240, tries })} alt="" loading="lazy" decoding="async" onError={() => fail(`option${at}`)} />}
                    <span className="option-letter">{on ? <Icon name="check" /> : OPTION_LETTERS[at]}</span>
                  </span>
                  <span className="option-why" aria-hidden="true">{capital(why)}</span>
                </Card>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="shot-actions">
        {takesNotes ? (
          <>
            <Btn icon={shot.removed ? "plus" : "trash"} aria-pressed={Boolean(shot.removed)} onClick={() => onEntry({ remove: shot.removed ? null : true })}>{shot.removed ? "Keep shot" : "Remove shot"}</Btn>
            {noteOpen ? null : <Btn icon="comment" data-note-open aria-keyshortcuts="c" title={`Note on shot ${shot.n}`} onClick={openNote}>Note</Btn>}
          </>
        ) : null}
        <details className="board-more" onToggle={(event) => setMore(event.currentTarget.open)}>
          <summary>Crop and numbers</summary>
          <div className="board-more-body">
            {more ? <SourceFrame shot={base} projectId={projectId} rev={data.rev} failed={failed.source} tries={tries} onFail={() => fail("source")} /> : null}
            <dl className="board-lines">
              {lines.map((line) => (
                <div key={line.name} className={line.tone ? `board-${line.tone}` : undefined}>
                  <dt>{capital(line.name)}</dt><dd>{plain(line.text)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      </div>
      {takesNotes && noteOpen ? (
        <div className="board-note">
          <label htmlFor={noteId}>Note on shot {shot.n}</label>
          <input id={noteId} type="text" value={entry.text} maxLength={NOTE_LIMIT} autoComplete="off"
            placeholder="Goes with your answer"
            onChange={(event) => onEntry({ text: event.target.value, noteOpen: true })}
            onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Enter") leaveNote(event); }}
            onBlur={() => { if (!String(entry.text ?? "").trim()) onEntry({ noteOpen: null, text: "" }); }} />
        </div>
      ) : null}
      {answered ? <p className="board-your-note"><Icon name="comment" />Your note: "{answered}"</p> : null}
      {Object.keys(failed).length ? (
        <div className="actions"><Btn onClick={() => { rowRef.current?.focus(); setFailed({}); setTries((value) => value + 1); }} aria-label={`Retry the pictures of shot ${shot.n}`}>Retry pictures</Btn></div>
      ) : null}
    </article>
  );
}

// A shot's layers in a few words each (boardRows.js shotTags); nothing when it has none.
function ShotTags({ tags }) {
  if (!tags.length) return null;
  return (
    <ul className="board-tags" aria-hidden="true">
      {tags.map((tag, index) => <li key={index} className={`ui-chip tag-${tag.kind}${tag.tone ? ` board-${tag.tone}` : ""}`}>{capital(tag.text)}</li>)}
    </ul>
  );
}

// A failed or absent picture: its words in the box, at the picture's size.
const Missing = ({ ratio, children }) => <div className="board-missing" style={{ aspectRatio: ratio }}>{children}</div>;

// The shot's source frame with the crop, subject boxes and eye line drawn on it.
function SourceFrame({ shot, projectId, rev, failed, tries, onFail }) {
  const media = shot.media;
  const width = media?.width || 16;
  const height = media?.height || 9;
  const ratio = `${width} / ${height}`;
  if (!media || media === "none") return <figure className="board-source"><Missing ratio="16 / 9">No footage</Missing><figcaption>Source</figcaption></figure>;
  if (media.missing) return <figure className="board-source"><Missing ratio="16 / 9">Media missing: {String(media.src).split("/").pop()}</Missing><figcaption>Source</figcaption></figure>;
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
      <figcaption>Source, {at}{boxes?.crop && !failed ? ", dashed: the crop" : ""}</figcaption>
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
 * read only, "Not asked yet"; "No storyboard yet." when the video has none.
 */
export function BoardScreen({ projectId, document, revision }) {
  return (
    <Screen title="Storyboard" className="stop-screen">
      {document?.board?.shots?.length ? <BoardView projectId={projectId} rev={revision} version={revision} readOnly level={3} />
        : <p className="board-empty">No storyboard yet. The agent writes one with edit {"{op:\"board\"}"} and shows it to you at the storyboard stop.</p>}
    </Screen>
  );
}
