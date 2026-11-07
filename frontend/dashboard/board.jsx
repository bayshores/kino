// The storyboard screen (direction plan §5 "You see", milestone B4b, reworked so the person sees
// the story first): a reel that plays the shots' stills at their own lengths (an animatic, with
// the app's covered areas on its monitor), then every shot as a card with its still, the agent's
// reason and its layers as tags; the crop drawn on the source frame and kino's numbers wait in
// each card's "crop and numbers". The agent's calls each take a "no" that goes with the answer.
// The agent's page images stay in a closed "pages as the agent sees them". The person reads the
// board and answers the stop (stops.jsx); a note can go on one shot (c). Nothing here edits it.
//
// Data flow: GET /api/dashboard/board-data (api.js boardData; backend/agent/board-data.mjs) →
// boardRows.js (the words, the reel's segments, the tags) → these components. The pictures are
// GET /api/dashboard/board-shot PNGs (api.js boardShotUrl). Only the reel moves, and only when
// the person presses play: it cuts from still to still, so reduced motion changes nothing.
import React, { useEffect, useRef, useState } from "react";
import { boardData, boardPageUrl, boardShotUrl } from "./api.js";
import { timeOfDay } from "./format.js";
import { Back, Screen } from "./screens.jsx";
import {
  changeLines, clockWords, headChips, overlayBoxes, phoneShots, reelSegments, seconds, shotIndexAt, shotLines, shotSentence, shotTags, statusWords,
} from "./boardRows.js";

// The picture widths the server makes (F7); the browser picks one for the screen's pixels.
const WIDTHS = [240, 480, 960];
const NOTE_LIMIT = 500;
// The agent's look draws 4 shots a page (board-look.mjs), 1092 px wide.
const PAGE_SHOTS = 4;
const PAGE_WIDTH = 1092;
const PAGE_ROW = 273;

const stillUrl = ({ projectId, rev, shot, width, tries = 0 }) => `${boardShotUrl({ projectId, rev, shot, part: "still", width })}${tries ? `&try=${tries}` : ""}`;

/**
 * One storyboard: the board a stop showed (`stop`, "C1"), the board of revision `rev`, or with
 * neither the newest board stop's. `version` reads it again when it changes (the stop's status).
 * `ask` is the agent's chat text, in lines (the waiting card). `notes` are the notes on single
 * shots, {S2: {n, text}}, and `onNote(id, note | null)` changes one; `noCalls` the agent's calls
 * the person said no to, and `onCallNo(call, no)` changes one. Without onNote, or with `readOnly`,
 * no shot takes a note and no call a no. `compact` (the phone's stack) shows at most 2 shots,
 * those to look at first (boardRows.js phoneShots), and `onSeeAll` opens the stop screen with
 * every shot. When the board cannot be read, the agent's ask is shown in its place: it has the
 * board in words.
 */
export function BoardView({ projectId, stop = null, rev = null, version = null, ask = null, notes = {}, onNote = null, noCalls = [], onCallNo = null, readOnly = false, compact = false, onSeeAll = null, level = 4 }) {
  const [state, setState] = useState({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // The reel's place, in seconds of the board, and whether it plays.
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
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
  const takesNos = takesNotes && typeof onCallNo === "function";
  const shown = compact ? phoneShots(data) : data.shots;
  const pages = Math.ceil(data.shots.length / PAGE_SHOTS);
  const answered = Object.fromEntries((data.answer?.shots ?? []).map((note) => [note.id, note.words]));
  const current = data.shots[shotIndexAt(data, time)] ?? null;
  // A card picked (a click, or j and k): the reel goes to its first frame and stops there.
  const pick = (shot) => { setPlaying(false); setTime(Number(shot.start) || 0); };
  return (
    <div className={`board${compact ? " compact" : ""}`}>
      <div className="board-head">
        <p className="board-title" ref={headRef} tabIndex={-1}>{data.stop ?? "not asked yet"} · board r{data.header?.board ?? "?"}</p>
        {readOnly ? <p className="dim">{statusWords(data, timeOfDay)}</p> : null}
        {data.purpose ? <p className="board-purpose">{data.purpose}</p> : null}
        <ul className="board-chips" aria-label="The board">
          {headChips(data).map((chip) => <li key={chip}>{chip}</li>)}
        </ul>
        {changeLines(data).map((line) => <p key={line} className="board-change">{line}</p>)}
        {readOnly && data.answer?.words ? <p>your note: "{data.answer.words}"</p> : null}
      </div>
      <Reel data={data} projectId={projectId} time={time} playing={playing} notes={notes} answered={answered}
        onTime={setTime} onPlaying={setPlaying} />
      <div className="board-shots">
        {shown.map((shot) => (
          <ShotCard key={shot.id} shot={shot} data={data} projectId={projectId} takesNotes={takesNotes} current={current?.id === shot.id}
            note={notes?.[shot.id] ?? null} onNote={onNote} answered={answered[shot.id] ?? null} onPick={pick} />
        ))}
      </div>
      {compact && shown.length < data.shots.length ? (
        <div className="actions"><button type="button" className="tb tb-box" onClick={onSeeAll}>see all {data.shots.length} shots</button></div>
      ) : null}
      <Heading className="board-section">my calls (say no to any)</Heading>
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

/**
 * The reel: a monitor with the still of the shot at `time` (the app's covered areas shaded on
 * it), the shot's reason, play, the clock, and a strip of every shot as wide as it is long, with
 * the playhead. Play runs the stills at their lengths from where the playhead is (from the start
 * once it reached the end) and stops at the end. A press on a shot in the strip goes to it.
 */
function Reel({ data, projectId, time, playing, notes, answered, onTime, onPlaying }) {
  const segments = reelSegments(data);
  const total = Number(data.shots.at(-1)?.end) || 0;
  const index = shotIndexAt(data, time);
  const shot = data.shots[index] ?? null;
  const tall = (data.header?.height ?? 0) > (data.header?.width ?? 0);
  const ratio = `${data.header?.width || 9} / ${data.header?.height || 16}`;
  const timeRef = useRef(time);
  timeRef.current = time;
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
  const covered = data.covered;
  const noted = (id) => Boolean(String(notes?.[id]?.text ?? "").trim() || answered?.[id]);
  return (
    <section className={`board-reel${tall ? " tall" : " wide"}`} aria-label="The storyboard as a reel">
      <div className="reel-monitor" style={{ aspectRatio: ratio }}>
        {/* Every still is drawn once, so playing never waits for a picture; only the shot at the playhead shows. */}
        {data.shots.map((entry, at) => (
          <img key={entry.id} src={stillUrl({ projectId, rev: data.rev, shot: entry.id, width: 480 })} alt="" hidden={at !== index}
            width={data.header?.width || 9} height={data.header?.height || 16} decoding="async" />
        ))}
        {covered ? (
          <span className="reel-covered" aria-hidden="true">
            <span className="board-covered right" style={{ width: `${covered.right}%`, bottom: `${covered.bottom}%` }} />
            <span className="board-covered bottom" style={{ height: `${covered.bottom}%` }}>{covered.verified ? "app" : "app (unverified)"}</span>
          </span>
        ) : null}
      </div>
      <div className="reel-side">
        {shot ? (
          <div className="reel-now" aria-live={playing ? "off" : "polite"}>
            <p><strong>shot {shot.n}</strong><span className="dim"> of {data.shots.length} · {seconds(shot.start)}–{seconds(shot.end)} s</span></p>
            <p className="reel-why">{shot.why || "no reason given"}</p>
            <ShotTags shot={shot} data={data} />
          </div>
        ) : null}
        <div className="reel-controls">
          <button type="button" className="tb tb-box reel-play" aria-pressed={playing} onClick={() => onPlaying(!playing)}
            title={playing ? "Pause the reel" : "Play the shots at their lengths (no sound)"}>
            <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span> {playing ? "pause" : "play the board"}
          </button>
          <span className="reel-clock dim" aria-label={`at ${seconds(time)} of ${seconds(total)} seconds`}>{clockWords(time)} / {clockWords(total)}</span>
        </div>
        <div className="reel-strip" role="group" aria-label="Shots by length">
          {segments.map((segment) => (
            <button key={segment.id} type="button" className={`reel-seg${segment.id === shot?.id ? " on" : ""}`} style={{ flexGrow: Math.max(segment.width, 0.01) }}
              aria-label={`shot ${segment.n}, ${seconds(segment.start)} to ${seconds(segment.end)} s${segment.flagged ? ", look at it" : ""}${segment.changed ? ", changed" : ""}${noted(segment.id) ? ", has your note" : ""}`}
              aria-current={segment.id === shot?.id ? "true" : undefined}
              onClick={() => { onPlaying(false); onTime(segment.start); }}>
              {/* The still repeated along the shot, as a timeline draws a clip. */}
              <span className="seg-film" style={{ backgroundImage: `url("${stillUrl({ projectId, rev: data.rev, shot: segment.id, width: 240 })}")` }} />
              <span className="seg-n">{segment.n}</span>
              {segment.flagged || segment.changed || noted(segment.id) ? (
                <span className="seg-marks" aria-hidden="true">
                  {segment.flagged ? <i className="mark-look" /> : null}
                  {segment.changed ? <i className="mark-change" /> : null}
                  {noted(segment.id) ? <i className="mark-note" /> : null}
                </span>
              ) : null}
            </button>
          ))}
          <span className="reel-head" style={{ left: `${total > 0 ? Math.min(100, (time / total) * 100) : 0}%` }} aria-hidden="true" />
        </div>
      </div>
    </section>
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
 * One shot as a card: its sentence for a screen reader (the card's name), and, hidden from it,
 * the card's head, the still as the video shows it, the agent's reason and the layer tags. Then
 * "crop and numbers" (the source frame with the crop drawn, and every layer line), the retry for
 * a picture that failed, and the note on this shot. Focusing the card (a click, j or k) moves
 * the reel to it (`onPick`); `current` is the shot at the reel's playhead.
 */
function ShotCard({ shot, data, projectId, takesNotes, current, note, onNote, answered, onPick }) {
  const [failed, setFailed] = useState({});
  const [tries, setTries] = useState(0);
  const [more, setMore] = useState(false);
  const rowRef = useRef(null);
  const sentenceId = `board-${shot.id}`;
  const noteId = `board-note-${shot.id}`;
  const lines = shotLines(shot, data);
  const tags = shotTags(shot, data);
  const tall = (data.header?.height ?? 0) > (data.header?.width ?? 0);
  const hasNote = Boolean(String(note?.text ?? "").trim());
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
  const look = tags.some((tag) => tag.tone === "look");
  const changed = tags.some((tag) => tag.tone === "change");
  return (
    <article ref={rowRef} className={`board-shot${tall ? " tall" : " wide"}${current ? " current" : ""}${hasNote || answered ? " noted" : ""}${look ? " flagged" : ""}${changed ? " changed" : ""}`}
      tabIndex={0} data-shot={shot.id} data-n={shot.n} {...(takesNotes ? { "data-notes": "" } : {})} aria-labelledby={sentenceId}
      onFocus={(event) => { if (event.target === event.currentTarget) onPick(shot); }}>
      <p id={sentenceId} className="sr-only">{shotSentence(shot, data)}</p>
      <div className="board-visual" aria-hidden="true" onClick={() => onPick(shot)}>
        <p className="board-row-head"><strong>{shot.n}</strong> · {seconds(shot.start)}–{seconds(shot.end)} s · {shot.id}</p>
        <Still shot={shot} data={data} projectId={projectId} failed={failed.still} tries={tries} onFail={() => fail("still")} tall={tall} />
        <p className="board-why">{shot.why || "no reason given"}</p>
        <ShotTags shot={shot} data={data} />
      </div>
      <details className="board-more" onToggle={(event) => setMore(event.currentTarget.open)}>
        <summary>crop and numbers</summary>
        <div className="board-more-body">
          {more ? <SourceFrame shot={shot} projectId={projectId} rev={data.rev} failed={failed.source} tries={tries} onFail={() => fail("source")} /> : null}
          <dl className="board-lines">
            {lines.map((line) => (
              <div key={line.name} className={line.tone ? `board-${line.tone}` : undefined}>
                <dt>{line.name}</dt><dd>{line.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
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

// A shot's layers in a few words each (boardRows.js shotTags); nothing when it has none.
function ShotTags({ shot, data }) {
  const tags = shotTags(shot, data);
  if (!tags.length) return null;
  return (
    <ul className="board-tags">
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
  const url = (w) => `${boardShotUrl({ projectId, rev, shot: shot.id, part: "source", width: w })}${tries ? `&try=${tries}` : ""}`;
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

// The shot as the video shows it: the cropped still with the real text on it.
function Still({ shot, data, projectId, failed, tries, onFail, tall }) {
  const { width = 9, height = 16 } = data.header ?? {};
  const ratio = `${width || 9} / ${height || 16}`;
  const url = (w) => stillUrl({ projectId, rev: data.rev, shot: shot.id, width: w, tries });
  const alt = `shot ${shot.n} as the video shows it`;
  return (
    <figure className="board-still">
      {failed ? <Missing ratio={ratio}>{alt} could not be shown</Missing> : (
        <div className="board-frame" style={{ aspectRatio: ratio }}>
          <img src={url(480)} srcSet={WIDTHS.map((w) => `${url(w)} ${w}w`).join(", ")} sizes={tall ? "(max-width: 719px) 46vw, 26ch" : "(max-width: 719px) 92vw, 44ch"}
            alt={alt} width={width} height={height} loading="lazy" decoding="async" onError={onFail} />
        </div>
      )}
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
