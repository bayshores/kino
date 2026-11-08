// The stops on the dashboard (direction plan §6, milestone B2b). A stop is a point where the agent
// shows the person its work and waits for their answer: the storyboard, the rough cut, the color
// pass and the sound pass. The person talks to the agent; here they see the stop the agent asked
// and answer it (a approve, Tab approve with a note, d redo with a note), see how each stop was
// answered, reopen an answer the agent recorded from the chat that is not what they meant, and
// undo "stop asking". Nothing here edits the video.
//
// Data flow: agent.stops in the snapshot and the stream (stopsSummary in backend/agent/stops.mjs)
// → stopRows and waitingStopOf (state.js) → these components. Answers go to POST
// /api/dashboard/stops (api.js); the agent hears them in its inbox with its next call. Nothing
// here moves: no animation and no transition, also without reduced motion.
import React, { useState } from "react";
import { frameUrl } from "./api.js";
import { BoardView } from "./board.jsx";
import { directionChips, withoutDirection } from "./boardRows.js";
import { timeOfDay } from "./format.js";
import { offerWords, stopFootnote, typedSeconds } from "./state.js";
import { Back, Screen } from "./screens.jsx";
import { Choice, POLICY_COLORS, SettingRow, SettingsPane } from "./settings.jsx";
import { STOP_DEFAULT_SKIP, STOP_KINDS, STOP_SKIP_FIELDS, STOP_WORDS } from "./words.js";

// The stills a stop card shows: 4 frames of the revision the stop showed, at 1/8, 3/8, 5/8 and 7/8
// of the video's first scene. A tall video's stills stay in one row on a phone (dashboard.css), so
// the answers stay near the top of the screen.
const STILL_PLACES = [1, 3, 5, 7];
const STILL_WIDTH = 160;
// A storyboard stop shows the board instead (board.jsx): every shot in words beside its own
// pictures, of the revision the stop showed. The video's own frames would show footage not cut yet.

/**
 * The waiting stop (agent.stops.waiting): what the agent sends the person, 4 stills of the
 * revision it showed (a storyboard: the board itself, board.jsx), the note and the three answers.
 * `note` is {text, mode}: mode "notes" (the note goes with approve) or "redo". `onPress(press)`
 * answers or puts the cursor in the note (Dashboard.jsx with stopAnswer in state.js): "approve",
 * "notes", "redo", or "enter" from the note. `focusNote` puts the cursor in the note when the card
 * opens. `compact` (the phone's stack) leaves out the key hint. The card says where to watch and
 * hear the work: the stills are silent. On a storyboard, `shotNotes` ({S2: {n, text, pick, length,
 * remove}}) are the person's directions on single shots and `onShotNote(id, entry | null)` changes
 * one; the answer bar shows each as a chip with × to take it back, then the note, approve and
 * "send N changes" (a redo: the agent changes the board and shows it again).
 */
export function StopCard({ round, document, projectId, note, onNote, onPress, noteRef, focusNote = false, compact = false, shotNotes = {}, onShotNote = null, noCalls = [], onCallNo = null }) {
  const word = STOP_WORDS[round.kind] ?? round.kind;
  const mode = note?.mode === "redo" ? "redo" : "notes";
  const titleId = `stop-${round.id}`;
  const noteId = `stop-note-${round.id}`;
  const lines = String(round.ask ?? "").split("\n").filter((line) => line.trim());
  const scene = document?.scenes?.find((entry) => !entry.isComponent) ?? null;
  const length = Number(scene?.duration) || 0;
  const stills = scene && length > 0 ? STILL_PLACES.map((place) => (length * place) / 8) : [];
  const height = scene?.width && scene?.height ? Math.round((STILL_WIDTH * scene.height) / scene.width) : undefined;
  const board = round.kind === "board";
  const chips = board ? directionChips(shotNotes) : [];
  const nos = board ? noCalls : [];
  const typed = String(note?.text ?? "").trim();
  const count = chips.length + nos.length + (typed ? 1 : 0);
  const changes = `${count} change${count === 1 ? "" : "s"}`;
  const placeholder = board ? "note" : mode === "redo" ? "Enter sends the redo" : "Enter approves with this note";
  return (
    <article className={`stop-card waiting${board ? " board-card" : ""}`} aria-labelledby={titleId}>
      <h3 id={titleId} className="s-needs-you"><span aria-hidden="true">◉</span> {round.id} · the {word} · waits for you</h3>
      <p className="dim">asked {timeOfDay(round.askedAt)} by {round.client ?? "an agent"} · rev {round.rev}</p>
      {board ? null : (
        <div className="stop-ask" role="group" aria-label="What the agent sends you">
          <p className="faint" aria-hidden="true">what the agent sends you:</p>
          {lines.map((line, index) => <p key={index}>{line}</p>)}
        </div>
      )}
      {board ? <BoardView projectId={projectId} stop={round.id} version={round.rev} ask={lines} notes={shotNotes} onNote={onShotNote}
        noCalls={noCalls} onCallNo={onCallNo} compact={compact} />
        : stills.length ? (
        <figure className="stop-stills">
          <div className={`stills-grid${scene.height > scene.width ? " tall" : ""}`}>
            {stills.map((time) => (
              <img key={time} src={frameUrl({ projectId, sceneId: scene.id, time, width: STILL_WIDTH, rev: round.rev })} width={STILL_WIDTH} height={height}
                alt={`rev ${round.rev} at ${time.toFixed(1)} s`} />
            ))}
          </div>
          <figcaption className="dim">stills of rev {round.rev}, the revision you answer</figcaption>
        </figure>
      ) : null}
      {/* The stills are silent: say where the work plays, with its sound, before it is answered.
          A storyboard has nothing built to play yet. */}
      {board ? null : <p className="dim stop-watch">{compact ? `to watch and hear rev ${round.rev} first: the stage below plays it` : `to watch and hear rev ${round.rev} first: press Esc, then space plays it on the stage`}</p>}
      {round.offer?.length ? <p className="faint">the agent's ask offers "stop asking" for {offerWords(round.offer)}; that answer is given in the chat</p> : null}
      {/* A storyboard is long: its note and answers stay at the bottom of the screen as it scrolls. */}
      <div className={board ? "stop-answer" : "stop-answer-plain"}>
      {chips.length || nos.length ? (
        <ul className="answer-chips" aria-label="Your changes">
          {chips.map((chip) => (
            <li key={`${chip.id}-${chip.field}`}>{chip.text}
              <button type="button" className="tb" aria-label={`take back ${chip.text}`} onClick={() => onShotNote(chip.id, withoutDirection(shotNotes[chip.id], chip.field))}>×</button>
            </li>
          ))}
          {nos.map((call) => (
            <li key={call}>no to: {call}
              <button type="button" className="tb" aria-label={`take back the no to: ${call}`} onClick={() => onCallNo(call, false)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="stop-note">
        <label htmlFor={noteId} className={board ? "sr-only" : undefined}>{board ? "note" : mode === "redo" ? "what to redo" : "note for approve with notes"}</label>
        <textarea id={noteId} ref={noteRef} value={note?.text ?? ""} maxLength={2000} rows={board ? 1 : 2} autoFocus={focusNote}
          placeholder={placeholder}
          onChange={(event) => onNote({ mode, text: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onPress("enter"); } }} />
      </div>
      {board ? (
        <div className="actions">
          <button type="button" className="tb tb-box allow" aria-keyshortcuts="a" title={count ? "approve (a): the agent makes your changes and goes on" : "approve (a)"}
            onClick={() => onPress("approve")}>approve</button>
          {count ? (
            <button type="button" className="tb tb-box tb-accent send" aria-keyshortcuts="d" title="send (d): the agent changes the board and shows it to you again"
              onClick={() => onPress("redo")}>send {changes}</button>
          ) : null}
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="tb tb-box tb-accent allow" aria-keyshortcuts="a" onClick={() => onPress("approve")}>[<span className="key">a</span>] approve</button>
          <button type="button" className="tb tb-box" aria-keyshortcuts="Tab" onClick={() => onPress("notes")}>[<span className="key">Tab</span>] approve with a note</button>
          <button type="button" className="tb tb-box" aria-keyshortcuts="d" onClick={() => onPress("redo")}>[<span className="key">d</span>] redo with a note</button>
        </div>
      )}
      </div>
      {!compact ? <p className="faint">A and D are off on stops: set a stop to allow in settings. The agent hears your answer with its next call.</p> : null}
    </article>
  );
}

/**
 * The stop screen ({name:"stop", id}): the card while the stop waits; once it is answered (here
 * or in the chat) or has closed, its line from stopRows (`row`), with reopen when it has one, and
 * a storyboard's board read only (no answers, no notes).
 */
export function StopScreen({ id, round, row, onBack, onReopen, onKeepAsking, ...card }) {
  return (
    <Screen title={`stop · ${id}`} actions={<Back onBack={onBack} />}>
      {round ? <StopCard round={round} {...card} />
        : row ? (
          <>
            <StopLines rows={[row]} onReopen={onReopen} onKeepAsking={onKeepAsking} />
            {row.kind === "board" ? <BoardView projectId={card.projectId} stop={id} version={row.text} readOnly level={3} /> : null}
          </>
        ) : <p className="faint">No stop {id} to show in this project: the stops section lists its last 5.</p>}
    </Screen>
  );
}

/**
 * The stop lines from stopRows (state.js), with their reopen and keep asking buttons, and the
 * footnote when an answer was recorded by the agent. Each line can take the focus (data-stop-line),
 * so after an answer or a reopen the focus goes to the line that replaced the button.
 */
export function StopLines({ rows, onReopen, onKeepAsking }) {
  if (!rows.length) return <p className="faint indent">no stops yet</p>;
  const footnote = stopFootnote(rows);
  return (
    <>
    <ul className="stop-lines" aria-label="Stops, newest first">
      {rows.map((row) => (
        <li key={row.key} data-stop-line={row.key} tabIndex={-1} className={row.status === "waiting" ? "s-needs-you" : undefined}>
          {row.text}
          {row.note ? <span className="dim stop-heard">{row.note}</span> : null}
          {row.reopen || row.keepAsking ? (
            <span className="actions">
              {row.reopen ? <button type="button" className="tb" aria-label={row.reopen.label} onClick={() => onReopen(row)}>reopen</button> : null}
              {row.keepAsking ? <button type="button" className="tb" onClick={onKeepAsking}>keep asking</button> : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
    {footnote ? <p className="faint stop-footnote">{footnote}</p> : null}
    </>
  );
}

/**
 * The phone's card for the stop that just stopped waiting (answered here or in the chat, or
 * closed): its line, with reopen, at the top of the stack where its card was, until the person
 * dismisses it or the next stop waits. Without it, a chat answer would only show under the stage.
 */
export function StopDone({ row, onReopen, onKeepAsking, onDismiss }) {
  return (
    <article className="brief-card stop-done" aria-labelledby="stop-done-title">
      <h3 id="stop-done-title" className="section-head">{row.id} no longer waits</h3>
      <StopLines rows={[row]} onReopen={onReopen} onKeepAsking={onKeepAsking} />
      <div className="actions"><button type="button" className="tb" onClick={onDismiss}>dismiss</button></div>
    </article>
  );
}

/**
 * A stop waiting in a project that is not open (otherStops in state.js), on the phone's stack:
 * the person opens that project to see and answer it.
 */
export function StopElsewhere({ entry, onOpen }) {
  const word = STOP_WORDS[entry.round.kind] ?? entry.round.kind;
  return (
    <article className="brief-card stop-elsewhere" aria-labelledby={`stop-elsewhere-${entry.projectId}`}>
      <h3 id={`stop-elsewhere-${entry.projectId}`} className="s-needs-you"><span aria-hidden="true">◉</span> {entry.round.id} · the {word} waits for you in {entry.name}</h3>
      <div className="actions"><button type="button" className="tb tb-box" onClick={() => onOpen(entry.projectId)}>open {entry.name}</button></div>
    </article>
  );
}

/** The phone's stops card, under the brief card: the same lines under a caret button. */
export function StopsCard({ rows, open, onToggle, onReopen, onKeepAsking }) {
  return (
    <article className="brief-card stops-card" aria-labelledby="stops-card-title">
      <h3 id="stops-card-title" className="section-head">
        <button type="button" className="tb caret-button" aria-expanded={open} aria-controls="stops-card-lines" onClick={onToggle}>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span> stops{!open && rows.length ? <span className="dim"> ({rows.length})</span> : null}
        </button>
      </h3>
      <div id="stops-card-lines" hidden={!open}><StopLines rows={rows} onReopen={onReopen} onKeepAsking={onKeepAsking} /></div>
    </article>
  );
}

// "ask (default): when the rough cut is done"
function askHint(kind) {
  return kind === "board" ? "ask (default): before building, when the video has footage" : `ask (default): when the ${STOP_WORDS[kind]} is done`;
}

/**
 * Settings › stops (pane 2 of settings.jsx): for each stop, ask (the default) or allow, and the
 * length under which a video
 * has no such stop. Saved as approvals["checkpoint-<kind>"] and limits[<skip field>]
 * (backend/agent/dashboard.mjs checks both). A length saves when the field loses the focus, as
 * the other numbers in settings do, as typed: a refusal (a decimal, out of range) shows the
 * server's message, and the field is never rounded to a value it does not show.
 */
export function StopSettings({ settings, onSave }) {
  const [skips, setSkips] = useState(() => Object.fromEntries(STOP_KINDS.map((kind) => [kind, settings.limits?.[STOP_SKIP_FIELDS[kind]] ?? STOP_DEFAULT_SKIP[kind]])));
  return (
    <SettingsPane number="2" name="stops" area="stops" note={"\"stop asking\" in chat skips the rough cut, color and sound stops for one video."}>
      {STOP_KINDS.map((kind) => {
        const word = STOP_WORDS[kind];
        const policy = settings.approvals?.[`checkpoint-${kind}`] === "allow" ? "allow" : "ask";
        const skip = `set-stop-${kind}-skip`;
        return (
          <SettingRow key={kind} id={`set-stop-${kind}`} label={word} choice hint={policy === "allow" ? "allowed: passes without asking you" : askHint(kind)}>
            <label className="faint" htmlFor={skip}>skip under</label>
            <input id={skip} className="set-num" type="number" min="0" max="3600" step="1" value={skips[kind] ?? ""} aria-label={`${word}: skip under (s)`}
              title={`videos shorter than this have no ${word} stop (default ${STOP_DEFAULT_SKIP[kind]}; 0 never skips)`}
              onChange={(event) => setSkips({ ...skips, [kind]: event.target.value })}
              onBlur={() => onSave({ limits: { [STOP_SKIP_FIELDS[kind]]: typedSeconds(skips[kind]) } })} />
            <span className="faint">s</span>
            <Choice id={`set-stop-${kind}`} value={policy} aria-label={`${word} stop`} aria-describedby={`set-stop-${kind}-hint`} colors={POLICY_COLORS}
              options={[{ value: "ask" }, { value: "allow" }]} onChange={(value) => onSave({ approvals: { [`checkpoint-${kind}`]: value } })} />
          </SettingRow>
        );
      })}
    </SettingsPane>
  );
}
