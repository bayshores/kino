// The dashboard's full screens (plan §5.3 "other screens"): projects (with Trash), share links,
// turn review, variants, the approval card, help and the raw transcript. Plus the command line and the
// confirm box. Every key action here is also a button. The stop screen (stops.jsx) and the settings
// screen (settings.jsx) build on Screen and Back from here. The projects and share screens follow
// the mouse-first design, with controls from controls.jsx.
import React, { useEffect, useRef, useState } from "react";
import { act, frameUrl, listTrash, turnReview } from "./api.js";
import { ago, callSummary, clock, cut, tokens } from "./format.js";
import { KEY_HELP, parseCommand } from "./keys.js";
import { APPROVAL_WORDS } from "./words.js";
import { Btn, Icon, Segmented, TitledBox } from "./controls.jsx";
import { projectGroups } from "./projectRows.js";

/** A screen takes the focus when it opens (see Screen); returns the ref for its section. */
function useScreenFocus() {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  return ref;
}

export function Screen({ title, children, actions, labelId = "screen-title", className = "", onKeyDown }) {
  const ref = useRef(null);
  // A screen takes the focus when it opens, as a pane does with 1–5, so Enter, j and k act on
  // it and not on the button that opened it. A field inside that already has focus keeps it.
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  return (
    <section ref={ref} tabIndex={-1} className={className ? `screen ${className}` : "screen"} aria-labelledby={labelId} onKeyDown={onKeyDown}>
      <h2 className="row"><span id={labelId} className="grow">{title}</span>{actions}</h2>
      {children}
    </section>
  );
}

/** "Back": Esc does the same. */
export const Back = ({ onBack, children = "Back" }) => <Btn icon="back" keys="Esc" onClick={onBack}>{children}</Btn>;

// ---- projects ----------------------------------------------------------------------------------

/** The open project's first scene at its middle, as a poster; other projects show a plain tile. */
function Poster({ data, project }) {
  const scene = project.id === data.projectId ? data.record?.document?.scenes?.[0] : null;
  if (!scene) return <span className="proj-poster" aria-hidden="true" />;
  return <img className="proj-poster" alt="" loading="lazy" src={frameUrl({ projectId: project.id, sceneId: scene.id, time: Math.round(scene.duration * 50) / 100, width: 192, rev: data.record.revision, low: true })} />;
}

/** One project as a card: its poster, its name, its revision and age, and open, duplicate, trash. */
function ProjectRow({ data, project, index, cursor, onCursor, onOpen, onDuplicate, onArchive }) {
  const open = project.id === data.projectId;
  const agents = [...new Set((data.crew?.members ?? []).filter((member) => member.projectId === project.id).map((member) => member.name))];
  const stop = (work) => (event) => { event.stopPropagation(); work(); };
  const facts = [`Rev ${project.revision}`, project.updatedAt ? `${ago(project.updatedAt)} ago` : "", project.sceneCount > 1 ? `${project.sceneCount} scenes` : "", agents.join(", ")].filter(Boolean).join(", ");
  return (
    <li data-id={project.id} className={`proj-row${open ? " current" : ""}`} aria-selected={cursor === index} aria-label={`${project.name}${open ? ", open now" : ""}`}
      onClick={() => onCursor(index)} onDoubleClick={() => onOpen(project.id)}>
      <button type="button" className="proj-open" tabIndex={-1} aria-hidden="true" onClick={stop(() => onOpen(project.id))}>
        <Poster data={data} project={project} />
        {open ? <span className="ui-chip accent">Open now</span> : project.id === data.current ? <span className="ui-chip">Agent's</span> : null}
      </button>
      <div className="proj-words">
        <p className="proj-name" title={project.id}><span>{cut(project.name, 60)}</span></p>
        <p className="proj-sub">{facts}</p>
      </div>
      <span className="proj-actions">
        {open ? null : <Btn keys="Enter" onClick={stop(() => onOpen(project.id))} aria-label={`Open ${project.id}`}>Open</Btn>}
        <Btn className="icon-only" kind="quiet" icon="copy" keys="y" title="Duplicate" onClick={stop(() => onDuplicate(project.id))} aria-label={`Duplicate ${project.id}`} />
        <Btn className="icon-only" kind="quiet" icon="trash" title="Move to Trash" onClick={stop(() => onArchive(project.id))} aria-label={`Move ${project.id} to Trash`} />
      </span>
    </li>
  );
}

export function ProjectsScreen({ data, cursor, onCursor, onOpen, onDuplicate, onArchive, onRestore, onBack }) {
  const projects = data.projects;
  const screenRef = useScreenFocus();
  const [filter, setFilter] = useState("");
  const [view, setView] = useState("mine");
  const [trash, setTrash] = useState(null);
  const [trashError, setTrashError] = useState("");
  const [status, setStatus] = useState("");
  // The project list changes after an archive or a restore, so Trash is read again then.
  const known = projects.map((project) => project.id).join(" ");
  useEffect(() => {
    let active = true;
    listTrash().then((value) => { if (active) { setTrash(value.projects); setTrashError(""); } }).catch((cause) => { if (active) setTrashError(cause.message); });
    return () => { active = false; };
  }, [known]);
  const groups = projectGroups(projects, filter);
  const shown = view === "tests" ? groups.tests : groups.mine;
  const create = async () => {
    try { const reply = await act("project", { action: "create" }); setStatus(reply.text ?? ""); } catch (cause) { setStatus(cause.message); }
  };
  const row = ({ project, index }) => (
    <ProjectRow key={project.id} data={data} project={project} index={index} cursor={cursor} onCursor={onCursor} onOpen={onOpen} onDuplicate={onDuplicate} onArchive={onArchive} />
  );
  return (
    <section ref={screenRef} className="screen projects2" tabIndex={-1} aria-labelledby="screen-title">
      <TitledBox className="accent" labelId="screen-title" title="Projects">
        <div className="proj-bar">
          <label className="ui-field"><Icon name="search" /><span className="sr-only">Find a project</span>
            <input type="search" value={filter} placeholder="Find a project" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <Segmented name="projects-view" label="Which projects" value={view} onChange={setView}
            options={[{ value: "mine", text: "Mine", count: groups.mine.length }, { value: "tests", text: "Tests", count: groups.tests.length }, { value: "trash", text: "Trash", count: trash?.length ?? "…" }]} />
        </div>
        {status ? <p className="proj-status" role="status">{status}</p> : null}
        {view === "trash" ? (
          trashError ? <p className="err" role="alert">{trashError}</p> : !trash ? <p className="faint">loading…</p> : trash.length === 0 ? <p className="faint">Trash is empty.</p> : (
            <ul className="proj-list" aria-label="Trash">
              {trash.map((project) => (
                <li key={project.id} className="proj-row">
                  <span className="proj-open"><span className="proj-poster" aria-hidden="true" /></span>
                  <div className="proj-words"><p className="proj-name" title={project.id}><span>{cut(project.name, 60)}</span></p>
                    <p className="proj-sub">{project.trashedAt ? `In Trash ${ago(project.trashedAt)}` : ""}</p></div>
                  <span className="proj-actions"><Btn icon="back" onClick={() => onRestore(project.id)} aria-label={`Restore ${project.id} from Trash`}>Restore</Btn></span>
                </li>
              ))}
            </ul>
          )
        ) : <>
          {shown.length === 0 && (filter || view === "tests") ? <p className="faint">{filter ? "Nothing matches." : "No test projects."}</p> : null}
          <ul className="proj-list" aria-label={view === "tests" ? "Test projects" : "Projects"}>
            {shown.map(row)}
            {view === "mine" && !filter ? <li className="proj-new"><button type="button" onClick={create}><Icon name="plus" /><span>New project</span></button></li> : null}
          </ul>
        </>}
      </TitledBox>
    </section>
  );
}

// The settings screen is settings.jsx; its stops pane is in stops.jsx.

// ---- turn review ----------------------------------------------------------------------------

export function TurnScreen({ data, turnId, time, onUndo, onBack }) {
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const turn = data.agent?.turns.find((entry) => entry.id === turnId);
  const revKey = `${turnId}:${turn?.reverted ? "r" : ""}:${data.record?.revision}`;
  useEffect(() => {
    let active = true;
    setError("");
    turnReview(data.projectId, turnId).then((value) => { if (active) setReview(value); }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [data.projectId, turnId, revKey]);

  const sceneId = review?.changes?.scenes?.[0] ?? data.record?.document.scenes[0]?.id;
  const scene = data.record?.document.scenes.find((entry) => entry.id === sceneId);
  const at = Math.min(time, scene?.duration ?? time);
  const frame = (rev) => frameUrl({ projectId: data.projectId, sceneId, time: at, width: 640, rev });
  const words = (list, verb) => (list?.length ? `${verb} ${list.slice(0, 8).join(", ")}${list.length > 8 ? ` and ${list.length - 8} more` : ""}` : null);
  const changes = review?.changes;
  const plain = changes?.keptBefore ? [words(changes.created, "Added"), words(changes.changed, "Changed"), words(changes.removed, "Removed")].filter(Boolean) : [];
  return (
    <Screen title={`Turn ${turnId}`} className="turn-screen" actions={<>
      {turn && turn.edits.length && !turn.reverted ? <Btn icon="undo" keys="u" onClick={() => onUndo(turnId)}>Revert this turn</Btn> : null}
      <Back onBack={onBack} />
    </>}>
      {error ? <p className="err" role="alert">{error}</p> : !review ? <p className="faint">Loading…</p> : <>
        <p className="page-facts">
          {review.turn.reverted ? <span className="ui-chip">Undone at rev {review.turn.reverted.rev}</span> : null}
          {review.before ? <><span>Rev {review.before} to {review.after}</span><span>{review.calls.length} calls</span><span>Now rev {review.current}</span></>
            : <><span>No edits in this turn</span><span>{review.calls.length} calls</span></>}
        </p>
        {plain.length ? <ul className="turn-changes">{plain.map((line) => <li key={line}>{line}</li>)}</ul>
          : changes && !changes.keptBefore ? <p className="dim">The earlier revision is no longer kept, so the list of changes is gone.</p> : null}
        {review.before && scene ? (
          <div className="compare">
            <figure><img style={{ aspectRatio: `${scene.width} / ${scene.height}` }} src={frame(review.before)} alt={`Before ${turnId}: ${scene.name || scene.id} at ${clock(at)}, rev ${review.before}`} /><figcaption><b>Before</b><span className="mono">rev {review.before}</span><span className="mono">{clock(at)}</span></figcaption></figure>
            <figure><img style={{ aspectRatio: `${scene.width} / ${scene.height}` }} src={frame(review.after)} alt={`After ${turnId}: ${scene.name || scene.id} at ${clock(at)}, rev ${review.after}`} /><figcaption><b>After</b><span className="mono">rev {review.after}</span><span className="mono">{clock(at)}</span></figcaption></figure>
          </div>
        ) : null}
        <h3>Calls</h3>
        <ul className="call-rows">{review.calls.map((call, index) => (
          <li key={index} className={call.isError ? "failed" : undefined}>
            <span className="call-at">{call.at?.slice(11, 19)}</span>
            <span className="call-verb">{call.verb}</span>
            <span className="call-words" title={call.summary}>{call.isError ? <Icon name="x" /> : null}{callSummary(call)}</span>
            <span className="call-cost">{tokens((call.tokens ?? 0) + (call.inTokens ?? 0))}</span>
          </li>
        ))}</ul>
      </>}
    </Screen>
  );
}

// ---- variants --------------------------------------------------------------------------------

export function VariantsScreen({ data, choices, time, cursor, onCursor, onPick, rejecting, onReject, onBack }) {
  const { set, scenes } = choices;
  const [reason, setReason] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { if (rejecting) inputRef.current?.focus(); }, [rejecting]);
  return (
    <Screen title="Variants" className="variants-screen" actions={<>
      {scenes.length > 1 ? <Btn icon="x" keys="r" onClick={() => onReject(null)}>None of these</Btn> : null}
      <Back onBack={onBack} />
    </>}>
      {scenes.length > 1 ? <p className="dim">{set ? "Pick one. Your agent gets the pick as a note." : "No variant set yet, so these are this project's scenes. Your agent gets a pick as a note."}</p> : null}
      {rejecting ? (
        <form className="page-ask" onSubmit={(event) => { event.preventDefault(); onReject(reason); setReason(""); }}>
          <label className="ui-field"><span className="sr-only">Why none of them</span>
            <input id="reject-note" ref={inputRef} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What to try instead" />
          </label>
          <Btn kind="primary" type="submit">Send</Btn>
        </form>
      ) : null}
      {scenes.length < 2 ? <p className="faint">This project has {scenes.length} scene. Variants need two or more.</p> : (
        <div className="compare" role="listbox" aria-label="Variants">
          {scenes.map((scene, index) => {
            const name = scene.variant?.label || scene.name || scene.id;
            // A set's scenes start alike, so they are compared at their middle; otherwise at the stage's time.
            const at = set ? Math.round(scene.duration * 50) / 100 : Math.min(time, scene.duration);
            const about = scene.variant ? (scene.variant.of === scene.id ? "Original" : `${scene.variant.vary} variant`) : null;
            return (
              <figure key={scene.id} className={`variant${scene.variant?.picked ? " picked" : ""}`} role="option" aria-selected={cursor === index} onClick={() => onCursor(index)}>
                <img style={{ aspectRatio: `${scene.width} / ${scene.height}` }} src={frameUrl({ projectId: data.projectId, sceneId: scene.id, time: at, width: 640, rev: data.record.revision })} alt={`${name} at ${clock(at)}`} />
                <figcaption>
                  <b title={about ?? undefined}>{name}</b>
                  <span className="mono">{scene.width}×{scene.height}</span><span className="mono">{clock(scene.duration)}</span>
                  <span className="grow" />
                  {scene.variant?.picked ? <span className="ui-chip accent">Picked</span>
                    : <Btn icon="check" keys={String(index + 1)} onClick={(event) => { event.stopPropagation(); onPick(index); }} aria-label={`Pick ${name}`}>Pick</Btn>}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </Screen>
  );
}

// ---- the approval card ------------------------------------------------------------------------

const capital = (text) => String(text ?? "").replace(/^./, (letter) => letter.toUpperCase());
const ANSWERED = { allowed: "Allowed", denied: "Not allowed", canceled: "Canceled", replaced: "Replaced", expired: "Expired" };

export function ApprovalCard({ approval, onAnswer, note, onNote, noteRef, compact = false, now }) {
  if (!approval) return null;
  const pending = approval.status === "pending";
  // Allowed, but the call it let through failed.
  const failed = approval.status === "allowed" && approval.result?.isError === true;
  const also = approval.kinds?.length > 1 ? approval.kinds.slice(1).map((kind) => APPROVAL_WORDS[kind] ?? kind).join(", ") : "";
  const quiet = ["canceled", "replaced"].includes(approval.status);
  return (
    <article className={`approval-card${compact ? " compact" : ""}`} aria-labelledby={`approval-${approval.id}`}>
      <h3 id={`approval-${approval.id}`} title={approval.id}>{capital(APPROVAL_WORDS[approval.kind] ?? approval.kind)}</h3>
      <p className="approval-summary">{approval.summary}</p>
      <p className="approval-who">{capital(approval.client ?? "an agent")} asked {ago(approval.createdAt, now)} ago{approval.verb ? ` with ${approval.verb}` : ""}.{also ? ` Also needs: ${also}.` : ""}</p>
      {pending ? <>
        <label className="ui-field approval-note"><span className="sr-only">Note</span>
          <input id={`approval-note-${approval.id}`} ref={noteRef} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Add a note for the agent" maxLength={500} />
        </label>
        <div className="actions">
          <Btn kind="primary" icon="check" keys="a" onClick={() => onAnswer(approval.id, "allow", false)} aria-label="Allow once">Allow</Btn>
          <Btn keys="A" title="Changes the rule in settings" onClick={() => onAnswer(approval.id, "allow", true)}>Always allow</Btn>
          <Btn keys="d" onClick={() => onAnswer(approval.id, "deny", false)} aria-label="Not yet (deny)">Not yet</Btn>
          <Btn kind="quiet" keys="D" title="Changes the rule in settings" onClick={() => onAnswer(approval.id, "deny", true)} aria-label="Always deny">Never</Btn>
        </div>
      </> : (
        // canceled (the agent withdrew it) or replaced (by its request for a newer revision): not an error.
        <p className={`approval-answer ${approval.status === "allowed" && !failed ? "ok" : quiet ? "dim" : "err"}`}>
          {ANSWERED[approval.status] ?? capital(approval.status)}{approval.answeredAt ? ` ${ago(approval.answeredAt, now)} ago` : ""}.
          {approval.via === "chat" ? ` In the chat: "${approval.words}".` : approval.note ? ` Your note: "${approval.note}".` : ""}
          {approval.result ? ` ${failed ? "The call failed: " : ""}${approval.result.text}` : ""}
        </p>
      )}
    </article>
  );
}

export function ApprovalScreen({ approval, onBack, ...card }) {
  return (
    <Screen title="Approval" className="approval-screen" actions={<Back onBack={onBack} />}>
      {approval ? <ApprovalCard approval={approval} {...card} /> : <p className="faint">That approval is gone.</p>}
    </Screen>
  );
}

// ---- help and transcript ----------------------------------------------------------------------

const COMMANDS = ["agent", "session", "log", "checks", "notes", "seen", "projects", "crew", "shares", "settings", "help", "transcript", "variants", "storyboard",
  "render", "turn T3", "note <text>", "hold [note]", "release", "open <project>", "follow", "safe", "grid", "boxes", "findings", "marks", "mark seen",
  "export [draft|final] [mp4|webm|mov|gif]"];

export function HelpScreen({ onBack }) {
  return (
    <Screen title="Keys" className="help-screen" actions={<Back onBack={onBack} />}>
      <p className="dim">Every key is also a button.</p>
      <dl className="help-grid">
        {KEY_HELP.map(([key, word]) => (
          <div key={key}><dt>{key.split(" ").map((cap) => <kbd key={cap}>{cap}</kbd>)}</dt><dd>{word}</dd></div>
        ))}
      </dl>
      <h3>Commands</h3>
      <ul className="help-commands" aria-label="Commands of the command list">{COMMANDS.map((words) => <li key={words}>{words}</li>)}</ul>
    </Screen>
  );
}

export function TranscriptScreen({ data, onBack }) {
  const calls = [...(data.calls ?? [])].reverse();
  return (
    <Screen title={<>Transcript <span className="screen-count">{calls.length} calls</span></>} className="transcript-screen" actions={<Back onBack={onBack} />}>
      <ol className="transcript" aria-label="Transcript">
        {calls.map((call, index) => (
          <li key={index} className={`transcript-line${call.isError ? " failed" : ""}`}>
            <span className="call-at" title={call.at?.slice(0, 19).replace("T", " ")}>{call.at?.slice(11, 19)}</span>
            <span className={`call-who${call.by === "you" ? " you" : ""}`}>{call.by === "you" ? "You" : call.client || "Agent"}</span>
            <span className="call-verb">{call.verb}{call.turn ? <span className="call-turn">{call.turn}</span> : null}</span>
            <span className="call-cost">{tokens(call.inTokens ?? 0)} in, {tokens(call.tokens ?? 0)} out{call.ms != null ? `, ${call.ms} ms` : ""}</span>
            {call.input ? <code className="call-input">{cut(typeof call.input === "string" ? call.input : JSON.stringify(call.input), 600)}</code> : null}
            <span className="call-answer">{call.summary}</span>
          </li>
        ))}
      </ol>
    </Screen>
  );
}

// ---- command line and confirm -------------------------------------------------------------------

/**
 * The command list (⌘K or :): every view, screen and action of the dashboard by name. Typing
 * narrows the list; ↑ ↓ pick, Enter runs the picked one, or the typed command when nothing in the
 * list matches it (note …, turn T3, open <project>, export draft gif). `items` are
 * [{id, words, hint, command}] from Dashboard.jsx; a command is what parseCommand returns.
 */
export function CommandLine({ onRun, onClose, inert = false, items = [] }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const wanted = text.trim().toLowerCase().replace(/^:/, "");
  const shown = wanted ? items.filter((item) => `${item.words} ${item.hint ?? ""}`.toLowerCase().includes(wanted)) : items;
  const at = Math.min(picked, Math.max(0, shown.length - 1));
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [at, shown.length]);
  const run = () => {
    // A typed command with words after it (note …, turn T3) runs as typed.
    const typed = parseCommand(text);
    const exact = shown.find((item) => item.words.toLowerCase() === wanted);
    if (exact) { onRun(exact.command); return; }
    if (!typed.error && (/\s/.test(wanted) || !shown.length)) { onRun(typed); return; }
    if (shown[at]) { onRun(shown[at].command); return; }
    setError(typed.error ?? "Nothing matches.");
  };
  return (
    <>
    {/* A press anywhere outside the list closes it. */}
    <div className="command-backdrop" aria-hidden="true" onMouseDown={() => onClose()} />
    <div className="command-box" inert={inert} role="dialog" aria-label="Commands" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <form className="command-line" role="search" onSubmit={(event) => { event.preventDefault(); run(); }}>
        <label htmlFor="command-input"><Icon name="search" /><span className="sr-only">Command</span></label>
        <input id="command-input" ref={inputRef} value={text} autoComplete="off" spellCheck={false} aria-describedby="command-error"
          role="combobox" aria-expanded={shown.length > 0} aria-controls="command-list" aria-autocomplete="list"
          aria-activedescendant={shown[at] ? `command-${shown[at].id}` : undefined}
          onChange={(event) => { setText(event.target.value); setError(""); setPicked(0); }}
          onKeyDown={(event) => {
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
            if (!step || !shown.length) return;
            event.preventDefault(); event.stopPropagation();
            setPicked((at + step + shown.length) % shown.length);
          }}
          placeholder="Go to, or do" />
        <Btn kind="quiet" className="icon-only command-close" icon="x" onClick={onClose} aria-label="Close the command list (Esc)" title="Close (Esc)" />
        <span id="command-error" className="err" role="alert">{error}</span>
      </form>
      <ul id="command-list" ref={listRef} role="listbox" aria-label="Commands" className="command-list">
        {shown.map((item, index) => (
          <li key={item.id} id={`command-${item.id}`} role="option" aria-selected={index === at} className={index === at ? "picked" : undefined}
            onMouseMove={() => { if (index !== at) setPicked(index); }} onMouseDown={(event) => { event.preventDefault(); onRun(item.command); }}>
            <span className="command-words">{item.words}</span>{item.hint ? <span className="command-hint">{item.hint}</span> : null}{item.keys ? <kbd className="command-keys">{item.keys}</kbd> : null}
          </li>
        ))}
        {shown.length ? null : <li className="command-none">{wanted ? "Nothing in the list. Enter runs it as typed." : ""}</li>}
      </ul>
    </div>
    </>
  );
}

/**
 * A yes-or-no question. It holds the focus until it is answered: Tab and Shift+Tab move
 * between its two buttons, and the dashboard makes the page behind it inert. Afterwards the
 * focus goes back to where it was. y and n answer it too.
 */
export function ConfirmBox({ text, yes, onYes, onNo }) {
  const yesRef = useRef(null);
  const noRef = useRef(null);
  // Read while the box is first drawn, before the page behind it turns inert.
  const [previous] = useState(() => document.activeElement);
  useEffect(() => {
    yesRef.current?.focus();
    return () => { if (previous && document.contains(previous)) previous.focus?.(); };
  }, [previous]);
  return (
    <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-text" onKeyDown={(event) => {
      if (event.key === "Tab") {
        event.preventDefault(); event.stopPropagation();
        (document.activeElement === yesRef.current ? noRef.current : yesRef.current)?.focus();
        return;
      }
      if (event.key === "y" || event.key === "Y") { event.preventDefault(); event.stopPropagation(); onYes(); }
      if (event.key === "n" || event.key === "N" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onNo(); }
    }}>
      <p id="confirm-text">{text}</p>
      <p className="confirm-answers">
        <button type="button" ref={yesRef} className="ui-btn primary" aria-keyshortcuts="y" onClick={onYes}>{capital(yes)}</button>
        <button type="button" ref={noRef} className="ui-btn" aria-keyshortcuts="n" onClick={onNo}>Cancel</button>
      </p>
    </div>
  );
}
