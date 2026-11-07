// The dashboard's full screens (plan §5.3 "other screens"): projects (with Trash), share links,
// turn review, variants, the approval card, help and the raw transcript. Plus the command line and the
// confirm box. Every key action here is also a button. The stop screen (stops.jsx) and the settings
// screen (settings.jsx) build on Screen and Back from here. The projects and share screens follow
// the mouse-first design, with controls from controls.jsx.
import React, { useEffect, useRef, useState } from "react";
import { act, frameUrl, listShares, listTrash, turnReview } from "./api.js";
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

/** "← back": Esc does the same. */
export const Back = ({ onBack, children = "back" }) => <Btn icon="back" keys="Esc" onClick={onBack}>{children}</Btn>;

// ---- projects ----------------------------------------------------------------------------------

/** The open project's first scene at its middle, as a poster; other projects show a plain tile. */
function Poster({ data, project }) {
  const scene = project.id === data.projectId ? data.record?.document?.scenes?.[0] : null;
  if (!scene) return <span className="proj-poster" aria-hidden="true" />;
  return <img className="proj-poster" alt="" loading="lazy" src={frameUrl({ projectId: project.id, sceneId: scene.id, time: Math.round(scene.duration * 50) / 100, width: 192, rev: data.record.revision, low: true })} />;
}

/** The "…" menu of one project row: open, duplicate, move to trash (asks first). Esc closes it. */
function RowMenu({ project, onOpen, onDuplicate, onArchive, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const away = (event) => { if (!ref.current?.contains(event.target)) onClose(); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);
  const run = (work) => () => { onClose(); work(project.id); };
  return (
    <div ref={ref} className="proj-menu" role="menu" aria-label={`${project.name} actions`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <button type="button" role="menuitem" onClick={run(onOpen)}><Icon name="folder" />open</button>
      <button type="button" role="menuitem" onClick={run(onDuplicate)}><Icon name="copy" />duplicate</button>
      <button type="button" role="menuitem" className="urgent" aria-label={`Move ${project.id} to Trash`} onClick={run(onArchive)}><Icon name="trash" />move to trash</button>
    </div>
  );
}

function ProjectRow({ data, project, index, cursor, onCursor, onOpen, onDuplicate, onArchive }) {
  const [menu, setMenu] = useState(false);
  const open = project.id === data.projectId;
  const agents = [...new Set((data.crew?.members ?? []).filter((member) => member.projectId === project.id).map((member) => member.name))];
  const stop = (work) => (event) => { event.stopPropagation(); work(); };
  return (
    <li data-id={project.id} className={`proj-row${open ? " current" : ""}`} aria-selected={cursor === index} aria-label={`${project.name}${open ? ", open now" : ""}`}
      onClick={() => onCursor(index)} onDoubleClick={() => onOpen(project.id)}>
      <Poster data={data} project={project} />
      <div style={{ minWidth: 0 }}>
        <p className="proj-name"><span>{cut(project.name, 60)}</span>{open ? <span className="ui-chip accent">open now</span> : null}
          {project.id === data.current && !open ? <span className="ui-chip">agent's</span> : null}</p>
        <p className="proj-sub">{[project.id, agents.join(", ")].filter(Boolean).join(" · ")}</p>
      </div>
      <span className="proj-num">{project.sceneCount}</span>
      <span className="proj-num">{project.revision}</span>
      <span className="proj-num faint">{project.updatedAt ? `${ago(project.updatedAt)} ago` : ""}</span>
      <span className="proj-actions">
        <Btn icon="folder" keys="Enter" onClick={stop(() => onOpen(project.id))} aria-label={`Open ${project.id}`}>open</Btn>
        <Btn icon="copy" keys="y" onClick={stop(() => onDuplicate(project.id))} aria-label={`Duplicate ${project.id}`}>duplicate</Btn>
        <Btn className="icon-only" icon="more" aria-label={`More for ${project.id}`} aria-haspopup="menu" aria-expanded={menu} onClick={stop(() => setMenu((value) => !value))} />
        {menu ? <RowMenu project={project} onOpen={onOpen} onDuplicate={onDuplicate} onArchive={onArchive} onClose={() => setMenu(false)} /> : null}
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
      <TitledBox className="accent" labelId="screen-title" title={<>projects <span className="faint">{projects.length}</span></>}>
        <div className="proj-bar">
          <label className="ui-field"><Icon name="search" /><span className="sr-only">filter projects</span>
            <input type="search" value={filter} placeholder="filter projects" spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <Segmented name="projects-view" label="Which projects" value={view} onChange={setView}
            options={[{ value: "mine", count: groups.mine.length }, { value: "tests", count: groups.tests.length }, { value: "trash", count: trash?.length ?? "…" }]} />
          <span className="grow" />
          <Back onBack={onBack}>back to stage</Back>
          <Btn kind="primary" icon="plus" onClick={create}>new project</Btn>
        </div>
        {status ? <p className="proj-status" role="status">{status}</p> : null}
        {view === "trash" ? (
          trashError ? <p className="err" role="alert">{trashError}</p> : !trash ? <p className="faint">loading…</p> : trash.length === 0 ? <p className="faint">Trash is empty.</p> : (
            <ul className="proj-list" aria-label="Trash">
              {trash.map((project) => (
                <li key={project.id} className="proj-row">
                  <span className="proj-poster" aria-hidden="true" />
                  <div style={{ minWidth: 0 }}><p className="proj-name"><span>{cut(project.name, 60)}</span></p><p className="proj-sub">{project.id}</p></div>
                  <span className="proj-num">{project.sceneCount}</span><span className="proj-num" />
                  <span className="proj-num faint">{project.trashedAt ? `${ago(project.trashedAt)} ago` : ""}</span>
                  <span className="proj-actions"><Btn icon="back" onClick={() => onRestore(project.id)} aria-label={`Restore ${project.id} from Trash`}>restore</Btn></span>
                </li>
              ))}
            </ul>
          )
        ) : <>
          <div className="proj-head" aria-hidden="true"><span /><span>name</span><span>scenes</span><span>rev</span><span>updated</span><span /></div>
          {shown.length === 0 ? <p className="faint">{filter ? "Nothing matches." : view === "tests" ? "No test projects." : "No projects yet."}</p> : (
            <ul className="proj-list" aria-label={view === "tests" ? "Test projects" : "Projects"}>{shown.map(row)}</ul>
          )}
          {view === "mine" && groups.tests.length ? (
            <button type="button" className="proj-fold" onClick={() => setView("tests")}><Icon name="chevron" />{groups.tests.length} test projects <span className="faint">verification runs, hidden</span></button>
          ) : null}
        </>}
      </TitledBox>
    </section>
  );
}

// ---- share links -------------------------------------------------------------------------------

const ROLE_WORDS = { view: "watch", comment: "comment", edit: "edit" };
const ROLE_ICONS = { view: "eye", comment: "comment", edit: "pencil" };

/**
 * The project's share links: make one, see each one's access, label and age, and revoke it.
 * A view link opens the viewer read only; comment and edit links open it with comments. Nobody
 * edits by hand, so an edit link works like a comment link. The server keeps only a hash of a
 * link's secret, so a link's address can be copied only right after it is made.
 */
export function SharesScreen({ data, onMake, onRevoke, onBack, now }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("comment");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState(null);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((value) => value + 1);
  useEffect(() => {
    if (!data.projectId) return undefined;
    let active = true;
    listShares(data.projectId).then((value) => { if (active) { setShares(value.shares); setError(""); } }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [data.projectId, version]);
  useEffect(() => { setMade(null); setShares(null); }, [data.projectId]);

  const sorted = [...(shares ?? [])].sort((a, b) => (Boolean(a.revokedAt) - Boolean(b.revokedAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const active = sorted.filter((share) => !share.revokedAt).length;
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  async function make(event) {
    event.preventDefault();
    const link = await onMake(role, label.trim());
    if (!link) return;
    setMade({ ...link, label: label.trim() });
    setCopied(false);
    setLabel("");
    reload();
  }

  const screenRef = useScreenFocus();
  const name = data.record?.document?.name ?? data.projectId;
  return (
    <section ref={screenRef} className="screen share2" tabIndex={-1} aria-labelledby="screen-title">
      <TitledBox className="accent" labelId="screen-title" title={<>share <span className="faint">{name ?? ""}</span></>}
        actions={null}>
        {!data.projectId ? <><p className="faint">Open a project first.</p><Back onBack={onBack} /></> : <>
          <form className="share-form" aria-label="Make a share link" onSubmit={make}>
            <Segmented name="share-role" label="access" value={role} onChange={setRole}
              options={["view", "comment", "edit"].map((value) => ({ value, text: ROLE_WORDS[value], icon: ROLE_ICONS[value] }))} />
            <label className="ui-field"><span className="sr-only">label</span>
              <input id="share-label" type="text" value={label} maxLength={100} placeholder="who it's for" spellCheck={false} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <Btn kind="primary" icon="link" type="submit">make link</Btn>
          </form>
          <p className="share-head"><span id="shares-title">links</span><span>{active} active</span></p>
          {made ? (
            <div className="share-row share-made" role="status">
              <div style={{ minWidth: 0 }}>
                <p className="share-who">{made.label || "new link"} <span className="ui-chip">{ROLE_WORDS[made.role] ?? made.role}</span></p>
                <p className="share-meta share-url" title={made.url}>{made.url}</p>
              </div>
              <Btn icon={copied ? "check" : "copy"} onClick={() => copy(made.url)}>{copied ? "copied" : "copy"}</Btn>
              <span />
            </div>
          ) : null}
          {error ? <p className="err" role="alert">{error}</p> : !shares ? <p className="faint">loading…</p> : sorted.length === 0 ? <p className="faint">No share links yet.</p> : (
            <ul className="share-list" aria-labelledby="shares-title">
              {sorted.map((share) => (
                <li key={share.id} className={`share-row${share.revokedAt ? " revoked" : ""}`}>
                  <div style={{ minWidth: 0 }}>
                    <p className="share-who">{share.label ? cut(share.label, 40) : <span className="faint">no label</span>} <span className="ui-chip">{ROLE_WORDS[share.role] ?? share.role}</span></p>
                    <p className="share-meta">{[share.createdAt ? `${ago(share.createdAt, now)} ago` : "", share.revokedAt ? `revoked ${ago(share.revokedAt, now)} ago` : "works"].filter(Boolean).join(" · ")}</p>
                  </div>
                  <span />
                  {share.revokedAt ? <span /> : <Btn kind="urgent" icon="x" onClick={() => onRevoke(share, reload)} aria-label={`Revoke the ${ROLE_WORDS[share.role] ?? share.role} link${share.label ? ` "${share.label}"` : ""}`}>revoke</Btn>}
                </li>
              ))}
            </ul>
          )}
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
  const plain = changes?.keptBefore ? [words(changes.created, "added"), words(changes.changed, "changed"), words(changes.removed, "removed")].filter(Boolean) : [];
  return (
    <Screen title={`turn review · ${turnId}`} actions={<>
      {turn && turn.edits.length && !turn.reverted ? <button type="button" className="tb" onClick={() => onUndo(turnId)}>[<span className="key">u</span>] revert this turn</button> : null}
      <Back onBack={onBack} />
    </>}>
      {error ? <p className="err" role="alert">{error}</p> : !review ? <p className="faint">loading…</p> : <>
        <p>{review.turn.reverted ? <span className="dim">↻ reverted at rev {review.turn.reverted.rev}. </span> : null}
          {review.before ? `rev ${review.before} → rev ${review.after} · ${review.calls.length} calls · now rev ${review.current}` : `No edits in this turn · ${review.calls.length} calls`}</p>
        {plain.length ? <ul>{plain.map((line) => <li key={line} className="agent">▸ {line}</li>)}</ul> : changes && !changes.keptBefore ? <p className="dim">The earlier revision is no longer kept, so the change list is not available.</p> : null}
        {review.before && scene ? (
          <div className="compare">
            <figure><img src={frame(review.before)} alt={`Before ${turnId}: ${scene.name || scene.id} at ${clock(at)}, rev ${review.before}`} /><figcaption>before · rev {review.before} · {clock(at)}</figcaption></figure>
            <figure><img src={frame(review.after)} alt={`After ${turnId}: ${scene.name || scene.id} at ${clock(at)}, rev ${review.after}`} /><figcaption className="agent">after · rev {review.after} · {clock(at)}</figcaption></figure>
          </div>
        ) : null}
        <h3>calls</h3>
        <ul>{review.calls.map((call, index) => (
          <li key={index} className="log-call review-call"><span className="faint">{call.at?.slice(11, 19)}</span><span className={call.isError ? "s-failed" : ""} aria-hidden="true">{call.isError ? "✕" : "▸"}</span><span>{call.verb}</span><span className="grow" title={call.summary}>{callSummary(call)}</span><span className="faint">{tokens((call.tokens ?? 0) + (call.inTokens ?? 0))}</span></li>
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
    <Screen title={`variants · ${scenes.length}`} actions={<>
      <button type="button" className="tb" onClick={() => onReject(null)}>[<span className="key">r</span>] reject all</button>
      <Back onBack={onBack} />
    </>}>
      <p className="dim">{set
        ? `Variant set ${set}, side by side at the middle of each. A number key picks one; the agent gets your pick as a note and marks it with pick_variant.`
        : `No variant set yet (the agent makes one with the variants operation), so these are the project's scenes at ${clock(time)}. A number key picks one; the agent gets your pick as a note.`}</p>
      {rejecting ? (
        <form className="approval-note" onSubmit={(event) => { event.preventDefault(); onReject(reason); setReason(""); }}>
          <label htmlFor="reject-note">why none of them:</label>
          <input id="reject-note" ref={inputRef} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="what to try instead" />
          <button type="submit" className="tb tb-box">send</button>
        </form>
      ) : null}
      {scenes.length < 2 ? <p className="faint">This project has {scenes.length} scene; variants need two or more.</p> : (
        <div className="compare" role="listbox" aria-label="Variants">
          {scenes.map((scene, index) => {
            const name = scene.variant?.label || scene.name || scene.id;
            // A set's scenes start alike, so they are compared at their middle; otherwise at the stage's time.
            const at = set ? Math.round(scene.duration * 50) / 100 : Math.min(time, scene.duration);
            const about = scene.variant ? (scene.variant.of === scene.id ? "original" : `${scene.variant.vary} variant`) : null;
            return (
              <figure key={scene.id} className="variant" role="option" aria-selected={cursor === index} onClick={() => onCursor(index)}>
                <img src={frameUrl({ projectId: data.projectId, sceneId: scene.id, time: at, width: 640, rev: data.record.revision })} alt={`${name} at ${clock(at)}`} />
                <figcaption className="row"><span className="grow">[{index + 1}] {name}{about ? <span className="dim"> · {about}</span> : null} · {scene.width}×{scene.height} · {clock(scene.duration)}{scene.variant?.picked ? <span className="s-done"> · ● picked</span> : null}</span>
                  <button type="button" className="tb" onClick={(event) => { event.stopPropagation(); onPick(index); }}>[<span className="key">{index + 1}</span>] pick</button>
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

export function ApprovalCard({ approval, onAnswer, note, onNote, noteRef, compact = false, now }) {
  if (!approval) return null;
  const pending = approval.status === "pending";
  // Allowed, but the call it let through failed.
  const failed = approval.status === "allowed" && approval.result?.isError === true;
  const input = approval.verb ? `${approval.verb}` : "";
  return (
    <article className="approval-card" aria-labelledby={`approval-${approval.id}`}>
      <h3 id={`approval-${approval.id}`} className="s-needs-you" style={{ margin: 0 }}>
        <span aria-hidden="true">◉</span> {approval.id} · {APPROVAL_WORDS[approval.kind] ?? approval.kind}
      </h3>
      <p>{approval.summary}</p>
      <p className="dim">{approval.client ?? "an agent"} asked {ago(approval.createdAt, now)} ago{input ? ` with ${input}` : ""}{approval.kinds?.length > 1 ? ` · also needs: ${approval.kinds.slice(1).map((kind) => APPROVAL_WORDS[kind] ?? kind).join(", ")}` : ""}</p>
      {pending ? <>
        <div className="approval-note">
          <label htmlFor={`approval-note-${approval.id}`}>note</label>
          <input id={`approval-note-${approval.id}`} ref={noteRef} value={note} onChange={(event) => onNote(event.target.value)} placeholder="optional: the agent reads it with your answer" maxLength={500} />
        </div>
        <div className="actions">
          <button type="button" className="tb tb-box tb-accent" onClick={() => onAnswer(approval.id, "allow", false)}>[<span className="key">a</span>] allow once</button>
          <button type="button" className="tb tb-box" onClick={() => onAnswer(approval.id, "allow", true)}>[<span className="key">A</span>] always allow</button>
          <button type="button" className="tb tb-box" onClick={() => onAnswer(approval.id, "deny", false)}>[<span className="key">d</span>] deny</button>
          <button type="button" className="tb tb-box" onClick={() => onAnswer(approval.id, "deny", true)}>[<span className="key">D</span>] always deny</button>
        </div>
        {!compact ? <p className="faint">Tab adds a note · "always" changes the rule in settings</p> : null}
      </> : (
        // canceled (the agent withdrew it) or replaced (by its request for a newer revision): not an error.
        <p className={approval.status === "allowed" && !failed ? "ok" : ["canceled", "replaced"].includes(approval.status) ? "dim" : "err"}>{approval.status} {approval.answeredAt ? `${ago(approval.answeredAt, now)} ago` : ""}{approval.via === "chat" ? ` · in the chat: "${approval.words}"` : approval.note ? ` · your note: "${approval.note}"` : ""}{approval.result ? ` · ${failed ? "but the call failed: " : ""}${approval.result.text}` : ""}</p>
      )}
    </article>
  );
}

export function ApprovalScreen({ approval, onBack, ...card }) {
  return (
    <Screen title="approval" actions={<Back onBack={onBack} />}>
      {approval ? <ApprovalCard approval={approval} {...card} /> : <p className="faint">That approval is gone.</p>}
    </Screen>
  );
}

// ---- help and transcript ----------------------------------------------------------------------

export function HelpScreen({ onBack }) {
  return (
    <Screen title="keys" actions={<Back onBack={onBack} />}>
      <p className="dim">Single keys, no prefix. Every key is also a button. Ctrl+B and Ctrl+C are never used.</p>
      <dl className="help-grid">
        {KEY_HELP.map(([key, word]) => (
          <div key={key} className="row"><dt className="key" style={{ width: "10ch" }}>{key}</dt><dd style={{ margin: 0 }}>{word}</dd></div>
        ))}
      </dl>
      <h3>commands (⌘K or :)</h3>
      <p>agent · session · log · checks · notes · seen · projects · crew · shares · settings · help · transcript · variants · storyboard · render · turn T3 · note &lt;text&gt; · hold [note] · release · open &lt;project&gt; · follow · safe · grid · boxes · findings · marks · mark seen · export [draft|final] [mp4|webm|mov|gif]</p>
    </Screen>
  );
}

export function TranscriptScreen({ data, onBack }) {
  const calls = [...(data.calls ?? [])].reverse();
  return (
    <Screen title={`raw transcript · ${calls.length} calls`} actions={<Back onBack={onBack} />}>
      <p className="dim">Every call to kino for this project, newest first: who called, what it sent, and the first line of the answer.</p>
      <ol aria-label="Transcript">
        {calls.map((call, index) => (
          <li key={index} className="transcript-line">
            <span className="faint">{call.at?.slice(0, 19).replace("T", " ")}</span> <span className={call.by === "you" ? "key" : "agent"}>{call.by === "you" ? "you" : call.client || "agent"}</span>
            {call.turn ? <span className="dim"> {call.turn}</span> : null} <span>{call.verb}</span> <span className="dim">{call.input ? cut(typeof call.input === "string" ? call.input : JSON.stringify(call.input), 600) : ""}</span>
            {"\n"}<span className={call.isError ? "err" : ""}>→ {call.summary}</span>
            <span className="faint"> · {tokens(call.inTokens ?? 0)} in · {tokens(call.tokens ?? 0)} out{call.ms != null ? ` · ${call.ms} ms` : ""}</span>
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
        <label htmlFor="command-input" className="key">⌘K</label>
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
          placeholder="a view, a screen or an action · note … · turn T3 · open <project>" />
        <button type="button" className="tb command-close" onClick={onClose} aria-label="Close the command list (Esc)" title="Close (Esc)">esc</button>
        <span id="command-error" className="err" role="alert">{error}</span>
      </form>
      <ul id="command-list" ref={listRef} role="listbox" aria-label="Commands" className="command-list">
        {shown.map((item, index) => (
          <li key={item.id} id={`command-${item.id}`} role="option" aria-selected={index === at} className={index === at ? "picked" : undefined}
            onMouseMove={() => { if (index !== at) setPicked(index); }} onMouseDown={(event) => { event.preventDefault(); onRun(item.command); }}>
            <span className="command-words">{item.words}</span>{item.hint ? <span className="command-hint dim">{item.hint}</span> : null}{item.keys ? <span className="key command-keys">{item.keys}</span> : null}
          </li>
        ))}
        {shown.length ? null : <li className="faint command-none">{wanted ? "nothing in the list: Enter runs it as typed" : ""}</li>}
      </ul>
    </div>
    </>
  );
}

/**
 * A yes-or-no question. It holds the focus until it is answered: Tab and Shift+Tab move
 * between its two buttons, and the dashboard makes the page behind it inert. Afterwards the
 * focus goes back to where it was.
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
      <p className="row">
        <button type="button" ref={yesRef} className="tb tb-box tb-accent" onClick={onYes}>[<span className="key">y</span>] {yes}</button>
        <button type="button" ref={noRef} className="tb tb-box" onClick={onNo}>[<span className="key">n</span>] cancel</button>
      </p>
    </div>
  );
}
