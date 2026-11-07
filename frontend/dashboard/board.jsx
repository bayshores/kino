// The storyboard screen (direction plan §5 "You see", milestone B4b): every shot of a storyboard
// as real text at the normal size, beside the shot's own source frame (with the crop, the subject
// boxes and the eye line drawn on it) and its cropped still (with the app's covered areas). It
// replaces the agent's page images, which a phone shrank until they could not be read; those
// stay in a closed "pages as the agent sees them". The person reads the board and answers the
// stop (stops.jsx); a note can go on one shot (c). Nothing here edits the board.
//
// Data flow: GET /api/dashboard/board-data (api.js boardData; backend/agent/board-data.mjs) →
// boardRows.js (the words) → these components. The pictures are GET /api/dashboard/board-shot
// PNGs (api.js boardShotUrl). No video and nothing moves here, also without reduced motion.
import React, { useEffect, useRef, useState } from "react";
import { boardData, boardPageUrl, boardShotUrl } from "./api.js";
import { timeOfDay } from "./format.js";
import { Back, Screen } from "./screens.jsx";
import {
  boardHeader, changeLines, freshLine, overlayBoxes, phoneShots, seconds, shotLines, shotSentence, statusWords,
} from "./boardRows.js";

// The picture widths the server makes (F7); the browser picks one for the screen's pixels.
const WIDTHS = [240, 480, 960];
const NOTE_LIMIT = 500;
// The agent's look draws 4 shots a page (board-look.mjs), 1092 px wide.
const PAGE_SHOTS = 4;
const PAGE_WIDTH = 1092;
const PAGE_ROW = 273;

/**
 * One storyboard: the board a stop showed (`stop`, "C1"), the board of revision `rev`, or with
 * neither the newest board stop's. `version` reads it again when it changes (the stop's status).
 * `ask` is the agent's chat text, in lines (the waiting card). `notes` are the notes on single
 * shots, {S2: {n, text}}, and `onNote(id, note | null)` changes one; without onNote, or with
 * `readOnly`, no shot takes a note. `compact` (the phone's stack) shows at most 2 shots, those to
 * look at first (boardRows.js phoneShots), and `onSeeAll` opens the stop screen with every shot.
 * When the board cannot be read, the agent's ask is shown in its place: it has the board in words.
 */
export function BoardView({ projectId, stop = null, rev = null, version = null, ask = null, notes = {}, onNote = null, readOnly = false, compact = false, onSeeAll = null, level = 4 }) {
  const [state, setState] = useState({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
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
  const takesNotes = !readOnly && typeof onNote === "function" && data.status === "waiting";
  const shown = compact ? phoneShots(data) : data.shots;
  const fresh = freshLine(data);
  const pages = Math.ceil(data.shots.length / PAGE_SHOTS);
  const answered = Object.fromEntries((data.answer?.shots ?? []).map((note) => [note.id, note.words]));
  return (
    <div className={`board${compact ? " compact" : ""}`}>
      <div className="board-head">
        <p className="board-title" ref={headRef} tabIndex={-1}>{boardHeader(data)}</p>
        {readOnly ? <p className="dim">{statusWords(data, timeOfDay)}</p> : null}
        <p>{data.purpose ? <>purpose: {data.purpose}</> : <span className="faint">purpose: not set in the brief</span>}</p>
        <p className="dim">music: {data.music ?? "none"}{data.audio?.length ? ` · sound files: ${data.audio.join(", ")}` : ""}</p>
        {fresh ? <p className="dim">{fresh}</p> : null}
        {changeLines(data).map((line) => <p key={line} className="board-change">{line}</p>)}
        {readOnly && data.answer?.words ? <p>your note: "{data.answer.words}"</p> : null}
      </div>
      <div className="board-shots">
        {shown.map((shot) => (
          <ShotRow key={shot.id} shot={shot} data={data} projectId={projectId} takesNotes={takesNotes}
            note={notes?.[shot.id] ?? null} onNote={onNote} answered={answered[shot.id] ?? null} />
        ))}
      </div>
      {compact && shown.length < data.shots.length ? (
        <div className="actions"><button type="button" className="tb tb-box" onClick={onSeeAll}>see all {data.shots.length} shots</button></div>
      ) : null}
      <Heading className="board-section">my calls (say no to any)</Heading>
      {data.calls?.length ? <ul className="board-list">{data.calls.map((call) => <li key={call}>{call}</li>)}</ul> : <p className="faint indent">none</p>}
      <Heading className="board-section">open questions</Heading>
      {data.open?.length ? <ul className="board-list">{data.open.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul> : <p className="faint indent">none</p>}
      {ask?.length ? (
        <details className="board-ask">
          <summary>what the agent sends you in the chat</summary>
          <div className="stop-ask">{ask.map((line, index) => <p key={index}>{line}</p>)}</div>
        </details>
      ) : null}
      <PagesDetails projectId={projectId} rev={data.rev} pages={pages} shots={data.shots.length} />
    </div>
  );
}

// The agent's own page images, drawn only when opened (each is a render on the server).
function PagesDetails({ projectId, rev, pages, shots }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="board-pages" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>pages as the agent sees them ({pages})</summary>
      {open ? Array.from({ length: pages }, (_, index) => {
        const first = index * PAGE_SHOTS + 1;
        const last = Math.min(shots, first + PAGE_SHOTS - 1);
        return <img key={index} src={boardPageUrl({ projectId, rev, page: index + 1 })} width={PAGE_WIDTH} height={PAGE_ROW * (last - first + 1)}
          alt={`storyboard page ${index + 1} of ${pages}: ${first === last ? `shot ${first}` : `shots ${first}–${last}`}, as the agent's look shows them`} />;
      }) : null}
    </details>
  );
}

/**
 * One shot: its sentence for a screen reader (the row's name), and, hidden from it, the row head,
 * the source frame with the crop drawn, the cropped still and the layer lines. Outside the hidden
 * part: the retry for a picture that failed, and the note on this shot.
 */
function ShotRow({ shot, data, projectId, takesNotes, note, onNote, answered }) {
  const [failed, setFailed] = useState({});
  const [tries, setTries] = useState(0);
  const rowRef = useRef(null);
  const sentenceId = `board-${shot.id}`;
  const noteId = `board-note-${shot.id}`;
  const lines = shotLines(shot, data);
  const tall = (data.header?.height ?? 0) > (data.header?.width ?? 0);
  const fail = (part) => setFailed((value) => (value[part] ? value : { ...value, [part]: true }));
  const openNote = () => {
    if (!note) onNote(shot.id, { n: shot.n, text: "" });
    const field = window.document.getElementById(noteId);
    if (field) field.focus();
    else requestAnimationFrame(() => window.document.getElementById(noteId)?.focus());
  };
  const leaveNote = (event) => {
    event.preventDefault();
    if (!String(note?.text ?? "").trim()) onNote(shot.id, null);
    rowRef.current?.focus();
  };
  return (
    <article ref={rowRef} className={`board-shot${tall ? " tall" : " wide"}`} tabIndex={0} data-shot={shot.id} data-n={shot.n}
      {...(takesNotes ? { "data-notes": "" } : {})} aria-labelledby={sentenceId}>
      <p id={sentenceId} className="sr-only">{shotSentence(shot, data)}</p>
      <div className="board-visual" aria-hidden="true">
        <p className="board-row-head"><strong>{shot.n}</strong> · {seconds(shot.start)}–{seconds(shot.end)} s · {shot.id}</p>
        <SourceFrame shot={shot} projectId={projectId} rev={data.rev} failed={failed.source} tries={tries} onFail={() => fail("source")} />
        <Still shot={shot} data={data} projectId={projectId} failed={failed.still} tries={tries} onFail={() => fail("still")} tall={tall} />
        <dl className="board-lines">
          {lines.map((line) => (
            <div key={line.name} className={line.tone ? `board-${line.tone}` : undefined}>
              <dt>{line.name}</dt><dd>{line.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      {failed.source || failed.still ? (
        <div className="actions"><button type="button" className="tb" onClick={() => { rowRef.current?.focus(); setFailed({}); setTries((value) => value + 1); }}>retry the pictures of shot {shot.n}</button></div>
      ) : null}
      {answered ? <p className="board-your-note">your note on shot {shot.n}: "{answered}"</p> : null}
      {takesNotes ? (
        <div className="board-note">
          {note ? null : <button type="button" className="tb" data-note-open aria-keyshortcuts="c" onClick={openNote}>[<span className="key">c</span>] note on shot {shot.n}</button>}
          {note ? (
            <>
              <label htmlFor={noteId}>note on shot {shot.n}</label>
              <input id={noteId} type="text" value={note.text} maxLength={NOTE_LIMIT} autoComplete="off"
                placeholder="Enter or Esc keeps it; a, Tab or d sends it with your answer"
                onChange={(event) => onNote(shot.id, { n: shot.n, text: event.target.value })}
                onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Enter") leaveNote(event); }}
                onBlur={() => { if (!String(note.text ?? "").trim()) onNote(shot.id, null); }} />
            </>
          ) : null}
        </div>
      ) : null}
    </article>
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
  const url = (w) => `${boardShotUrl({ projectId, rev, shot: shot.id, part: "source", width: w })}${tries ? `&try=${tries}` : ""}`;
  const at = media.kind === "image" ? "the picture" : `at ${seconds(shot.in)} s`;
  const alt = `the source frame of shot ${shot.n}, ${at}`;
  const boxes = overlayBoxes(shot);
  return (
    <figure className="board-source">
      {failed ? <Missing ratio={ratio}>{alt} could not be shown</Missing> : (
        <div className="board-frame" style={{ aspectRatio: ratio }}>
          <img src={url(480)} srcSet={WIDTHS.map((w) => `${url(w)} ${w}w`).join(", ")} sizes="(max-width: 719px) 92vw, 40ch" alt={alt}
            width={width} height={height} loading="lazy" decoding="async" onError={onFail} />
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

function Still({ shot, data, projectId, failed, tries, onFail, tall }) {
  const { width = 9, height = 16 } = data.header ?? {};
  const ratio = `${width || 9} / ${height || 16}`;
  const url = (w) => `${boardShotUrl({ projectId, rev: data.rev, shot: shot.id, part: "still", width: w })}${tries ? `&try=${tries}` : ""}`;
  const alt = `shot ${shot.n} as the video shows it`;
  const covered = data.covered;
  return (
    <figure className="board-still">
      {failed ? <Missing ratio={ratio}>{alt} could not be shown</Missing> : (
        <div className="board-frame" style={{ aspectRatio: ratio }}>
          <img src={url(480)} srcSet={WIDTHS.map((w) => `${url(w)} ${w}w`).join(", ")} sizes={tall ? "(max-width: 719px) 40vw, 18ch" : "(max-width: 719px) 92vw, 32ch"}
            alt={alt} width={width} height={height} loading="lazy" decoding="async" onError={onFail} />
          {covered ? (
            <>
              <span className="board-covered right" style={{ width: `${covered.right}%`, bottom: `${covered.bottom}%` }} />
              <span className="board-covered bottom" style={{ height: `${covered.bottom}%` }}>{covered.verified ? "app" : "app (unverified)"}</span>
            </>
          ) : null}
        </div>
      )}
      <figcaption>the video{covered && !failed ? " · shaded: the app's buttons" : ""}</figcaption>
    </figure>
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
