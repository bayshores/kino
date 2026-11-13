// The stops on the dashboard (direction plan §6, milestone B2b). A stop is a point where the agent
// shows the person its work and waits for their answer: the storyboard, the rough cut, the color
// pass and the sound pass. The person talks to the agent; here they see the stop the agent asked
// and answer it (a approve, Tab approve with a note, d redo with a note), see how each stop was
// answered, reopen an answer the agent recorded from the chat that is not what they meant, and
// undo "stop asking". Nothing here edits the video.
//
// The look (2026-11-12): the pictures across the page column, then the agent's question as one
// line with its answers beside it (a solid "Approve", outlined others), the note under it, and
// small facts as chips. Keys keep working; buttons show no key letters.
//
// Data flow: agent.stops in the snapshot and the stream (stopsSummary in backend/agent/stops.mjs)
// → stopRows and waitingStopOf (state.js) → these components. Answers go to POST
// /api/dashboard/stops (api.js); the agent hears them in its inbox with its next call.
import React, { useState } from "react";
import { frameUrl } from "./api.js";
import { BoardView, capital } from "./board.jsx";
import { directionChips, withoutDirection } from "./boardRows.js";
import { Btn, Icon } from "./controls.jsx";
import { timeOfDay } from "./format.js";
import { offerWords, stopFootnote, typedSeconds } from "./state.js";
import { Back, Screen } from "./screens.jsx";
import { Choice, POLICY_COLORS, SettingRow, SettingsPane } from "./settings.jsx";
import { ToolIcon } from "./voice.jsx";
import { STOP_DEFAULT_SKIP, STOP_KINDS, STOP_SKIP_FIELDS, STOP_WORDS } from "./words.js";

// The stills a stop card shows: 4 frames of the revision the stop showed, at 1/8, 3/8, 5/8 and 7/8
// of the video's first scene, 4 across (board.css).
const STILL_PLACES = [1, 3, 5, 7];
const STILL_WIDTH = 480;
// A storyboard stop shows the board instead (board.jsx): every shot as a still, of the revision
// the stop showed. The video's own frames would show footage not cut yet.

/** What a person sees never joins facts with " · ": a comma instead. */
const plain = (text) => String(text ?? "").replaceAll(" · ", ", ");

/**
 * The waiting stop (agent.stops.waiting): 4 stills of the revision it showed (a storyboard: the
 * board itself, board.jsx), the agent's question with the answers beside it, the note under it.
 * `note` is {text, mode}: mode "notes" (the note goes with approve) or "redo". `onPress(press)`
 * answers or puts the cursor in the note (Dashboard.jsx with stopAnswer in state.js): "approve",
 * "notes", "redo", or "enter" from the note. `focusNote` puts the cursor in the note when the card
 * opens. `compact` is the phone's stack. On a storyboard, `shotNotes` ({S2: {n, text, pick, length,
 * remove}}) are the person's directions on single shots and `onShotNote(id, entry | null)` changes
 * one; each shows as a chip with × to take it back, and "Change" becomes "Send N changes" (a redo:
 * the agent changes the board and shows it again).
 */
export function StopCard({ round, document, projectId, note, onNote, onPress, noteRef, focusNote = false, compact = false, shotNotes = {}, onShotNote = null, noCalls = [], onCallNo = null, trying = null, onTry = null }) {
  const word = STOP_WORDS[round.kind] ?? round.kind;
  const titleId = `stop-${round.id}`;
  const lines = String(round.ask ?? "").split("\n").filter((line) => line.trim());
  const scene = document?.scenes?.find((entry) => !entry.isComponent) ?? null;
  const length = Number(scene?.duration) || 0;
  const stills = scene && length > 0 ? STILL_PLACES.map((place) => (length * place) / 8) : [];
  const height = scene?.width && scene?.height ? Math.round((STILL_WIDTH * scene.height) / scene.width) : undefined;
  const board = round.kind === "board";
  const answer = (question) => (
    <StopAnswer round={round} board={board} question={question} note={note} onNote={onNote} onPress={onPress} noteRef={noteRef} focusNote={focusNote}
      shotNotes={shotNotes} onShotNote={onShotNote} noCalls={noCalls} onCallNo={onCallNo} />
  );
  return (
    <article className={`stop-card waiting${board ? " board-card" : ""}${compact ? " compact" : ""}`} aria-labelledby={titleId}>
      <h3 id={titleId} className="sr-only">{round.id}, the {word}, waits for you</h3>
      {board ? <BoardView projectId={projectId} stop={round.id} version={round.rev} ask={lines} notes={shotNotes} onNote={onShotNote}
        noCalls={noCalls} onCallNo={onCallNo} compact={compact} trying={trying} onTry={onTry} answer={answer} />
        : (
          <>
            {stills.length ? (
              <figure className="stop-stills">
                <ul className={`stills-grid${scene.height > scene.width ? " tall" : ""}`} aria-label={`Stills of rev ${round.rev}`}>
                  {stills.map((time) => (
                    <li key={time}>
                      <img src={frameUrl({ projectId, sceneId: scene.id, time, width: STILL_WIDTH, rev: round.rev })} width={STILL_WIDTH} height={height}
                        alt={`Rev ${round.rev} at ${time.toFixed(1)} s`} />
                    </li>
                  ))}
                </ul>
              </figure>
            ) : null}
            {lines.length ? (
              <div className="stop-ask" role="group" aria-label="What the agent sends you">
                {lines.map((line, index) => <p key={index}>{line}</p>)}
              </div>
            ) : null}
            {answer(`${capital(word)} ready. Go on?`)}
            {/* The stills are silent: say where the work plays, with its sound, before it is answered. */}
            <p className="stop-watch"><Icon name="eye" />{compact ? "The stage below plays it with sound" : "Esc, then space plays it on the stage with sound"}</p>
          </>
        )}
      {round.offer?.length ? <p className="stop-offer">The ask offers "stop asking" for {offerWords(round.offer)}, answered in the chat</p> : null}
    </article>
  );
}

/**
 * The answers under a waiting stop's pictures: the agent's question as one line with Approve
 * (solid) and the others beside it, your changes as chips (a storyboard's directions and the
 * "no"s to the agent's calls, × takes one back), the note, and when and by whom it was asked.
 * A storyboard's answers stay at the bottom of the screen while the board scrolls (board.css).
 */
function StopAnswer({ round, board, question, note, onNote, onPress, noteRef, focusNote, shotNotes, onShotNote, noCalls, onCallNo }) {
  const mode = note?.mode === "redo" ? "redo" : "notes";
  const noteId = `stop-note-${round.id}`;
  const chips = board ? directionChips(shotNotes) : [];
  const nos = board ? noCalls : [];
  const typed = String(note?.text ?? "").trim();
  const count = chips.length + nos.length + (typed ? 1 : 0);
  const changes = `${count} change${count === 1 ? "" : "s"}`;
  const placeholder = board ? "Note for the agent" : mode === "redo" ? "What to redo. Enter sends it" : "Note. Enter approves with it";
  return (
    <div className={board ? "stop-answer" : "stop-answer stop-answer-plain"}>
      <div className="stop-ask-row">
        <p className="voice-line"><ToolIcon name="ask" /><span>{question}</span></p>
        <span className="voice-answers actions">
          <button type="button" className="voice-button primary allow" aria-keyshortcuts="a" title={count ? "The agent makes your changes and goes on" : "The agent goes on"}
            onClick={() => onPress("approve")}><Icon name="check" />Approve</button>
          {board ? (
            <button type="button" className={`voice-button ${count ? "send" : "change"}`} aria-keyshortcuts="d"
              title={count ? "The agent changes the board and shows it to you again" : "Say what to change"} onClick={() => onPress("redo")}>
              <Icon name="comment" />{count ? `Send ${changes}` : "Change"}
            </button>
          ) : (
            <>
              <button type="button" className="voice-button" aria-keyshortcuts="Tab" onClick={() => onPress("notes")}><Icon name="comment" />Approve with note</button>
              <button type="button" className="voice-button" aria-keyshortcuts="d" onClick={() => onPress("redo")}><Icon name="back" />Redo</button>
            </>
          )}
        </span>
      </div>
      {chips.length || nos.length ? (
        <ul className="answer-chips" aria-label="Your changes">
          {chips.map((chip) => (
            <li key={`${chip.id}-${chip.field}`} className="ui-chip">{capital(chip.text)}
              <button type="button" aria-label={`Take back ${chip.text}`} onClick={() => onShotNote(chip.id, withoutDirection(shotNotes[chip.id], chip.field))}><Icon name="x" /></button>
            </li>
          ))}
          {nos.map((call) => (
            <li key={call} className="ui-chip">No to: {call}
              <button type="button" aria-label={`Take back the no to: ${call}`} onClick={() => onCallNo(call, false)}><Icon name="x" /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={`stop-note${mode === "redo" ? " redo" : ""}`}>
        <label htmlFor={noteId} className="sr-only">{board ? "Note" : mode === "redo" ? "What to redo" : "Note for approve with notes"}</label>
        <Icon name="comment" />
        <textarea id={noteId} ref={noteRef} value={note?.text ?? ""} maxLength={2000} rows={1} autoFocus={focusNote}
          placeholder={placeholder}
          onChange={(event) => onNote({ mode, text: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onPress("enter"); } }} />
      </div>
      <ul className="stop-meta" aria-label="Asked">
        <li><Icon name="timer" />{timeOfDay(round.askedAt)}</li>
        <li>{capital(round.client ?? "an agent")}</li>
        <li>Rev {round.rev}</li>
      </ul>
    </div>
  );
}

/**
 * The stop screen ({name:"stop", id}): the card while the stop waits; once it is answered (here
 * or in the chat) or has closed, how it was answered with Reopen and Keep asking when it has
 * them, and a storyboard's board read only (no answers, no notes).
 */
export function StopScreen({ id, round, row, onBack, onReopen, onKeepAsking, ...card }) {
  const kind = round?.kind ?? row?.kind;
  const word = STOP_WORDS[kind] ?? kind ?? "stop";
  return (
    <Screen title={`${capital(word)}, ${id}`} className="stop-screen" actions={<Back onBack={onBack}>Back</Back>}>
      {round ? <StopCard round={round} {...card} />
        : row ? (
          row.kind === "board"
            ? <BoardView projectId={card.projectId} stop={id} version={row.text} readOnly level={3} actions={<StopDoneActions row={row} onReopen={onReopen} onKeepAsking={onKeepAsking} />} />
            : (
              <div className="stop-closed">
                <p className="voice-line"><Icon name="check" /><span>{capital(plain(row.text))}</span></p>
                <StopDoneActions row={row} onReopen={onReopen} onKeepAsking={onKeepAsking} />
              </div>
            )
        ) : <p className="stop-missing">No stop {id} in this project. The stops list shows the last 5.</p>}
    </Screen>
  );
}

/**
 * An answered or closed stop's buttons on its screen: Reopen and Keep asking when it has them,
 * what the agent heard, and the footnote for an answer recorded from the chat. The wrapper is the
 * stop's line (data-stop-line), where the focus goes after an answer or a reopen.
 */
function StopDoneActions({ row, onReopen, onKeepAsking }) {
  const footnote = stopFootnote([row]);
  return (
    <div className="stop-done-actions" data-stop-line={row.key} tabIndex={-1}>
      {row.note ? <p className="stop-heard">{capital(plain(row.note))}</p> : null}
      {row.reopen || row.keepAsking ? (
        <span className="actions">
          {row.reopen ? <Btn icon="back" aria-label={row.reopen.label} onClick={() => onReopen(row)}>Reopen</Btn> : null}
          {row.keepAsking ? <Btn icon="message" onClick={onKeepAsking}>Keep asking</Btn> : null}
        </span>
      ) : null}
      {footnote ? <p className="stop-footnote">{capital(footnote)}</p> : null}
    </div>
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
              {row.reopen ? <button type="button" className="tb" aria-label={row.reopen.label} onClick={() => onReopen(row)}>Reopen</button> : null}
              {row.keepAsking ? <button type="button" className="tb" onClick={onKeepAsking}>Keep asking</button> : null}
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
      <div className="actions"><button type="button" className="tb" onClick={onDismiss}>Dismiss</button></div>
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
      <h3 id={`stop-elsewhere-${entry.projectId}`} className="s-needs-you"><span aria-hidden="true">◉</span> {entry.round.id}, the {word} waits for you in {entry.name}</h3>
      <div className="actions"><button type="button" className="tb tb-box" onClick={() => onOpen(entry.projectId)}>Open {entry.name}</button></div>
    </article>
  );
}

/** The phone's stops card, under the brief card: the same lines under a caret button. */
export function StopsCard({ rows, open, onToggle, onReopen, onKeepAsking }) {
  return (
    <article className="brief-card stops-card" aria-labelledby="stops-card-title">
      <h3 id="stops-card-title" className="section-head">
        <button type="button" className="tb caret-button" aria-expanded={open} aria-controls="stops-card-lines" onClick={onToggle}>
          <span className="caret" aria-hidden="true">{open ? "▾" : "▸"}</span> Stops{!open && rows.length ? <span className="dim"> ({rows.length})</span> : null}
        </button>
      </h3>
      <div id="stops-card-lines" hidden={!open}><StopLines rows={rows} onReopen={onReopen} onKeepAsking={onKeepAsking} /></div>
    </article>
  );
}

// "ask (default): when the rough cut is done"
function askHint(kind) {
  return kind === "board" ? "ask (default): before building" : `ask (default): when the ${STOP_WORDS[kind]} is done`;
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
