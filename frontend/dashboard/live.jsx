// The live panels: they appear while something happens and go when it ends (plan: ui-polish).
//   SeenDrawer    under the video while an agent looks (or just did): the frames it looked at
//   RenderDock    one chip on the frame while a render runs: "Open when done"
// Each shows only real state (the facts are plain functions in agentView.js). Under reduced
// motion (`still`) they appear without sliding.
import React, { useEffect, useRef, useState } from "react";
import { Bot } from "./bot.jsx";
import { needWords, renderDock, seenNow, specWords } from "./agentView.js";
import { boardShotUrl, frameUrl, renderFileUrl, seenUrl } from "./api.js";
import { ago } from "./format.js";
import { tickWhileShown } from "./visibleClock.js";
import { keyTarget, needsYouRows, optionLabel, recommendedOption } from "./state.js";
import "./live.css";

/** The clock, once a second, for panels that count down or fade out on their own. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => tickWhileShown(() => setNow(Date.now()), ms), [ms]);
  return now;
}

/** Small line icons (16 px box, the text color). */
const GLYPHS = {
  pin: <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />,
  point: <><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" strokeWidth="1.3" /></>,
  send: <path d="M8 13V3.5M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  expand: <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  fold: <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />,
  notes: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.3" />,
  eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></>,
  undo: <path d="M5.5 4 2.5 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" strokeWidth="1.3" />,
  hold: <><rect x="4" y="3" width="2.4" height="10" fill="currentColor" /><rect x="9.6" y="3" width="2.4" height="10" fill="currentColor" /></>,
  stop: <rect x="3.5" y="3.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.3" />,
  message: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.3" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" />,
  ask: <path d="M5 8V4.5a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v3m0-2a1 1 0 0 1 2 0v4c0 2.5-1.5 4-4 4S4 12 3.5 10.5L2.5 8a1 1 0 0 1 2-.5" fill="none" stroke="currentColor" strokeWidth="1.2" />,
};
export function Glyph({ name }) {
  return <svg className="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">{GLYPHS[name]}</svg>;
}

/** Shows `open` content with a short slide in, and keeps it a moment after it closes to slide out. */
function useShown(open, still, ms = 180) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); return undefined; }
    if (still) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(timer);
  }, [open, still, ms]);
  return shown;
}

// ---- the seen drawer --------------------------------------------------------------------------

/** "44.0 s" from a frame file's name when it says its time ("…-t44.0…", "@44.0s"), else "". */
function fileTime(file) {
  const match = /(?:@|[-_]t)(\d+(?:\.\d+)?)s?/.exec(String(file).split(/[\\/]/).pop());
  return match ? `${Number(match[1]).toFixed(1)} s` : "";
}

/**
 * The frames an agent is looking at, under the video; it closes a few seconds after the look.
 * While the stage plays it neither opens nor closes: that would resize the playing video.
 */
export function SeenDrawer({ data, still, playing = false }) {
  const now = useNow();
  const [pinned, setPinned] = useState(false);
  const [kept, setKept] = useState(null);
  const fresh = seenNow(data, now);
  const held = useRef(fresh);
  if (!playing || Boolean(fresh) === Boolean(held.current)) held.current = fresh;
  const look = held.current;
  // Pinned: the last look stays up after it ends.
  useEffect(() => { if (look?.files?.length) setKept(look); }, [look?.at, look?.files?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const showing = look ?? (pinned ? kept : null);
  const shown = useShown(Boolean(showing), still);
  if (!shown || !data.projectId) return null;
  const view = showing ?? kept;
  if (!view) return null;
  const files = (view.files ?? []).slice(-8);
  const color = view.agent?.color ?? "var(--agent)";
  return (
    <section className={`live-seen${showing ? " in" : " out"}${still ? " still" : ""}`} style={{ "--who": color }} aria-label={`${view.agent?.name ?? "The agent"} is looking`}>
      <header className="live-head">
        <span className="live-dot" aria-hidden="true" />
        <span className="who">{view.agent?.name ?? "agent"}</span>
        <span className="dim">{view.running ? "is looking" : "looked"}{view.label ? `, ${String(view.label).replace(/^look\s+/, "")}` : ""}</span>
        <span className="grow" />
        {files.length ? <span className="faint">{files.length} frame{files.length === 1 ? "" : "s"}</span> : null}
        <button type="button" className={`tb icon-button live-pin${pinned ? " on" : ""}`} aria-pressed={pinned} onClick={() => setPinned((value) => !value)}
          title={pinned ? "Unpin: close when the look ends" : "Pin: keep it open"} aria-label="Pin the frames the agent looked at"><Glyph name="pin" /></button>
      </header>
      {files.length ? (
        <ol className="live-frames">
          {files.map((file, index) => (
            <li key={`${file}/${index}`} className={index === files.length - 1 ? "current" : ""}>
              <img src={seenUrl(data.projectId, file)} alt={`Frame ${index + 1} of ${files.length}`} loading="lazy" />
              <span className="faint">{index === files.length - 1 && view.running ? "now " : ""}{fileTime(file)}</span>
            </li>
          ))}
        </ol>
      ) : <p className="faint live-wait">waiting for the frames</p>}
    </section>
  );
}

// ---- the render dock --------------------------------------------------------------------------

/** A running render: one chip on the frame, "Open when done" (its progress and Cancel are the line
 * under the frame); when it ends, a link to the file for a few seconds. */
export function RenderDock({ data, still }) {
  const now = useNow();
  const dock = renderDock(data, now);
  const [openWhenDone, setOpenWhenDone] = useState(null);
  const [ended, setEnded] = useState(null);
  // When the job ends: "open" for a few seconds (and open it when asked to).
  useEffect(() => {
    if (dock) return undefined;
    if (!ended) return undefined;
    const timer = setTimeout(() => setEnded(null), 8000);
    return () => clearTimeout(timer);
  }, [Boolean(dock), ended]); // eslint-disable-line react-hooks/exhaustive-deps
  const [last, setLast] = useState(null);
  useEffect(() => { if (dock) setLast(dock.job.id); }, [dock?.job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dock || !last) return;
    const job = (data.renders ?? []).find((entry) => entry.id === last);
    setLast(null);
    if (job?.status === "done") {
      setEnded(job);
      if (openWhenDone === job.id) window.open(renderFileUrl(job.id), "_blank", "noopener");
    }
  }, [Boolean(dock), last]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useShown(Boolean(dock || ended), still);
  if (!shown) return null;
  if (!dock && ended) {
    return (
      <aside className={`live-dock done${still ? " still" : ""}`} onPointerDown={(event) => event.stopPropagation()} aria-label="Render done">
        <a className="tb" href={renderFileUrl(ended.id)} target="_blank" rel="noopener noreferrer"><Glyph name="eye" /> Open the {ended.quality} render</a>
      </aside>
    );
  }
  if (!dock) return null;
  const { job, agent, fraction } = dock;
  return (
    <aside className={`live-dock in${still ? " still" : ""}`} onPointerDown={(event) => event.stopPropagation()} aria-label={`${agent?.name ?? "Your"} render ${job.id}, ${Math.round(fraction * 100)}%`}>
      <button type="button" className="tb" aria-pressed={openWhenDone === job.id} onClick={() => setOpenWhenDone((value) => (value === job.id ? null : job.id))}>
        <Glyph name="eye" /> Open when done</button>
    </aside>
  );
}

// ---- needs you --------------------------------------------------------------------------------

/**
 * A material question's answers as chips (notes needs, backend/agent/needs.mjs): each option, the
 * recommended one first in weight and marked ★ (a picks it), then "have it" and "drop".
 * `onPick(need, answer)` sends "option N", "have" or "drop". `className` sets the chip look.
 */
export function MaterialChoices({ need, onPick, className = "tb", recommendedClass = "allow" }) {
  const rec = recommendedOption(need);
  return (
    <>
      {need.options.map((option, index) => {
        const n = index + 1;
        const label = optionLabel(option);
        return (
          <button key={n} type="button" className={`${className}${n === rec ? ` ${recommendedClass}` : ""}`} onClick={() => onPick(need, `option ${n}`)}
            title={`${label}. Cost: ${option.cost}${n === rec ? " (recommended)" : ""}`} aria-keyshortcuts={n === rec ? "a" : undefined}
            aria-label={`Option ${n}${n === rec ? ", recommended" : ""}: ${label}. Cost: ${option.cost}.`}>
            {cutWords(label, 34).replace(/^./, (letter) => letter.toUpperCase())}
          </button>
        );
      })}
      <button type="button" className={className} onClick={() => onPick(need, "have")} title="I will send it" aria-label="I have it and will send it">I have it</button>
      <button type="button" className={className} onClick={() => onPick(need, "drop")} title="Do without it" aria-label="Do without it">Drop it</button>
    </>
  );
}

const cutWords = (text, most) => (String(text).length > most ? `${String(text).slice(0, most - 1)}…` : String(text));

/**
 * What waits for you, as a card at the top of the agent pane: who asks, what, a poster frame,
 * the rule, and the answers. Approvals answer through `onAnswer(id, decision, always)`, stops
 * and the rest through `onRun("allow" | "deny")` (the a and d keys).
 */
export function NeedsYouCard({ data, still, now, onAnswer, onRun, onMaterial = () => {} }) {
  const rows = needsYouRows(data);
  const row = rows[keyTarget(rows, null)] ?? null;
  const shown = useShown(Boolean(row), still);
  if (!shown || !row) return null;
  const nameOf = (id) => data.agents?.find((agent) => agent.id === id)?.name;
  const words = needWords(row, nameOf);
  if (!words || !words.allow) return null;
  const approval = row.type === "approval" ? row.approval : null;
  const scene = data.record?.document?.scenes?.find((entry) => entry.id === approval?.spec?.scene) ?? data.record?.document?.scenes?.[0];
  const poster = approval?.kind === "final-render" && scene && data.projectId ? frameUrl({ projectId: data.projectId, sceneId: scene.id, time: (scene.duration ?? 0) / 2, width: 240, low: true }) : null;
  const material = row.type === "material" ? row.need : null;
  const title = approval ? ({ "final-render": "final render" }[approval.kind] ?? words.allow.replace(/^allow /, "")) : material ? `${material.id} ${material.ask}` : words.allow.replace(/^(approve|review) /, "");
  const facts = approval ? specWords(approval.spec) : "";
  const asked = approval?.createdAt ?? row.round?.askedAt ?? material?.at ?? null;
  // A storyboard stop: its shots' stills in a strip, each as wide as the shot is long; a press opens the board.
  const boardShots = row.type === "stop" && row.round?.kind === "board" && data.projectId ? (data.record?.document?.board?.shots ?? []) : [];
  return (
    <section className={`live-need${still ? " still" : ""}`} role="region" aria-live="assertive" aria-label={`${words.who} needs you`} style={words.color ? { "--who": words.color } : undefined}>
      <header className="live-head">
        <Glyph name="ask" /><span className="who">{words.who} asks</span><span className="grow" />
        {asked ? <span className="faint">{ago(asked, now)} ago</span> : null}
      </header>
      <div className="need-body">
        {poster ? <img className="need-poster" src={poster} alt="" /> : null}
        <div className="need-what">
          <p className={`need-title${material ? " wrap" : ""}`}>{title}</p>
          {facts ? <p className="dim">{facts}</p> : null}
          {words.summary ? <p className="faint need-rule" title={words.summary}>{words.summary}</p> : null}
        </div>
      </div>
      {boardShots.length ? (
        <button type="button" className="need-reel" onClick={() => onRun("allow")} title={`${words.allow} (a)`}
          aria-label={`${words.allow}: ${boardShots.length} shot${boardShots.length === 1 ? "" : "s"}`}>
          {boardShots.slice(0, 12).map((shot) => (
            <span key={shot.id} className="need-reel-shot" style={{ flexGrow: Math.max(Number(shot.dur) || 0, 0.1),
              backgroundImage: `url("${boardShotUrl({ projectId: data.projectId, rev: row.round.rev, shot: shot.id, part: "still", width: 240 })}")` }} />
          ))}
        </button>
      ) : null}
      <div className={`need-actions${material ? " need-choices" : ""}`}>
        {material ? <MaterialChoices need={material} onPick={onMaterial} className="tb tb-box" recommendedClass="need-allow" /> : approval ? <>
          <button type="button" className="tb tb-box need-allow" onClick={() => onAnswer(approval.id, "allow", false)} title="Allow once (a)" aria-keyshortcuts="a"><Glyph name="check" /> allow</button>
          <button type="button" className="tb tb-box" onClick={() => onAnswer(approval.id, "allow", true)} title="Always allow this (A)" aria-keyshortcuts="Shift+A"><Glyph name="check" /> always</button>
          <button type="button" className="tb tb-box" onClick={() => onAnswer(approval.id, "deny", false)} title="Deny (d)" aria-keyshortcuts="d"><Glyph name="close" /> deny</button>
        </> : <>
          <button type="button" className="tb tb-box need-allow" onClick={() => onRun("allow")} title={`${words.allow} (a)`} aria-keyshortcuts="a"><Glyph name={words.key === "review" ? "eye" : "check"} /> {words.allow}</button>
          {words.deny ? <button type="button" className="tb tb-box" onClick={() => onRun("deny")} title={`${words.deny} (d)`} aria-keyshortcuts="d"><Glyph name="close" /> {words.deny}</button> : null}
        </>}
      </div>
    </section>
  );
}

// ---- the idle rail ----------------------------------------------------------------------------

/** The agent pane folded: who worked here and since when, your notes, and a way back open. */
export function AgentRail({ agents, now, notes, still, onOpen, onNotes }) {
  return (
    <nav className={`live-rail${still ? " still" : ""}`} aria-label="Agents, all idle">
      <button type="button" className="tb icon-button rail-open" onClick={() => onOpen(null)} aria-label="Open the agent pane" title="Open the agent pane"><Glyph name="expand" /></button>
      <span className="rail-line" aria-hidden="true" />
      <ul>
        {agents.map((agent) => (
          <li key={agent.id} title={`${agent.name}: last call ${agent.lastAt ? `${ago(agent.lastAt, now)} ago` : "unknown"}`}>
            <button type="button" className="rail-agent" onClick={() => onOpen(agent.id)} aria-label={`${agent.name}, idle, last call ${agent.lastAt ? `${ago(agent.lastAt, now)} ago` : ""}`}>
              <Bot color={agent.color} mood="idle" size={26} still />
              <span className="faint">{agent.lastAt ? ago(agent.lastAt, now) : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tb icon-button rail-notes" onClick={onNotes} aria-label={`Notes${notes ? `, ${notes} for you` : ""}`} title="Notes">
        <Glyph name="notes" />{notes ? <span className="rail-badge">{notes}</span> : null}
      </button>
    </nav>
  );
}
