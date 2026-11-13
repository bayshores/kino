// The inspire screen (F3): edits on YouTube that an agent or you searched for, each measured by
// kino for its cuts (backend/inspire.mjs). It opens on the simplest thing that matters now: the
// ideas an agent took from a reference, waiting for you to pick (IdeasView); else the reference
// being read, as it is read (WatchView); else the full breakdown below. i switches between the
// simple view and the full page, by its buttons.
//
// The full page is made for the mouse, one column top to bottom: the search and the kinds, the
// picked reference big (its picture, facts and cut barcode, or a sound's waveform), the boards as
// chips (each search one board, "All found" and "Saved" first), and what was found (videos as a
// row of thumbnails or shelves, music, sounds with a player). Every action is a button; Esc
// closes the detail. Its data comes from inspireView.js; every action is an agent verb run as
// you (api.act), like the rest of the dashboard.
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./inspire.css";
import { act } from "./api.js";
import { Bot } from "./bot.jsx";
import { ResolveImage } from "./resolve.jsx";
import { asciiCells } from "./resolveCells.js";
import {
  BOARD_LIMIT, SHOW_OPTIONS, SORT_OPTIONS, SOUND_CATEGORIES, arrange, boardRows, boardTiles, clockWords, factRows, filmCells, filterBoards, ideaFrames, ideasSummary,
  ideaTimeWords, kindCounts, searcher, shelves, soFarWords, soundDetail, soundNote, soundRow, soundtrackRows, musicOrder, seekTime, songPlayhead, songSeek, stepStates, ticks, tileChips, tileLabel, tileWords, tiles, viewWords, watchSentence,
} from "./inspireView.js";

// The tall thumbnail of a Short gets its own address: the route is cached for good, so the same
// address would keep showing the wide picture fetched before.
const thumbUrl = (id, ref) => `/api/dashboard/inspire/thumb/${encodeURIComponent(id.slice(3))}${ref?.vertical ? "?v=tall" : ""}`;
const stripUrl = (id, file) => `/api/dashboard/inspire/strip/${encodeURIComponent(id.slice(3))}/${encodeURIComponent(file)}`;

/** The cut ticks under a picture; beat-matched cuts in orange when `beats` is on. */
function Ticks({ numbers, beats = false, className = "" }) {
  const marks = ticks(numbers);
  return (
    <span className={`insp-ticks ${className}`} aria-hidden="true">
      {marks.map((mark, index) => (
        <span key={index} className={`insp-tick${beats && mark.beat ? " beat" : ""}`} style={{ left: `${mark.x * 100}%` }} />
      ))}
    </span>
  );
}

// Text shades where no picture is (yet): a search still running, or no thumbnail.
function Shades({ seed }) {
  return (
    <span className="resolve-ascii" aria-hidden="true">
      {asciiCells(seed).map((row, r) => <span key={r} className="resolve-row">{row.map(({ char }, c) => <span key={c}>{char}</span>)}</span>)}
    </span>
  );
}

function Thumb({ tile }) {
  if (!tile?.id) return <span className="insp-thumb empty" aria-hidden="true"><Shades seed={tile?.key ?? "empty"} /></span>;
  return (
    <span className={`insp-thumb${tile.ref?.vertical ? " vertical" : ""}`}>
      {tile.ref?.thumb ? <ResolveImage src={thumbUrl(tile.id, tile.ref)} alt="" draggable={false} /> : <Shades seed={tile.id} />}
    </span>
  );
}

/**
 * F3: the ideas waiting for you, else the reference being read, else the full breakdown. `keysRef`
 * gets the waiting ideas' answer (allow or hold), so the top bar's a reaches it.
 */
export function InspireScreen({ data, projectId, now, onBack, say, keysRef, still }) {
  const inspire = data?.inspire ?? null;
  const [full, setFull] = useState(false);
  // Ideas seen waiting stay on the screen once answered, saying what happens next, until you leave.
  const [kept, setKept] = useState(null);
  const latest = inspire?.ideas ?? null;
  useEffect(() => { if (latest?.status === "waiting") setKept(latest.id); }, [latest?.id, latest?.status]);
  const ideas = latest && (latest.status === "waiting" || latest.id === kept) ? latest : null;
  const runningId = inspire?.queue?.running ?? null;
  const running = runningId ? inspire?.refs?.[runningId] ?? null : null;
  const simple = !full && (ideas || running);
  if (!simple) return <Breakdown data={data} projectId={projectId} now={now} onBack={onBack} say={say} onSimple={ideas || running ? () => setFull(false) : null} />;
  if (ideas) return <IdeasView data={data} ideas={ideas} projectId={projectId} onBack={onBack} onFull={() => setFull(true)} say={say} keysRef={keysRef} />;
  return <WatchView data={data} ref_={running} live={inspire?.live?.id === runningId ? inspire.live : null} onBack={onBack} onFull={() => setFull(true)} still={still} />;
}

/** The agent behind a search or an idea: {name, color, row} (row: its connected agent, if any). */
function agentOf(data, by) {
  if (!by || by === "you") return { name: "you", color: null, row: null };
  const row = data?.agents?.find((agent) => agent.id === by.id) ?? null;
  return { name: by.name ?? row?.name ?? "the agent", color: row?.color ?? by.color ?? null, row };
}

/** One frame of a strip (6 frames side by side in one JPEG), as a picture cropped to it. */
// `height` (px): the frame fills that height and starts at the cell's left edge, so a wider cell
// shows the frames after it, as a film strip does.
function StripFrame({ id, file, frame = 3, className = "", label = "", height = 0 }) {
  const position = height ? `${-frame * height * (240 / 130)}px 0` : `${(frame / 5) * 100}% 0`;
  return (
    <span className={`iv-frame ${className}`} role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : "true"}
      style={{ backgroundImage: `url("${stripUrl(id, file)}")`, backgroundPosition: position }} />
  );
}

/** The flow arrows and the text Vision read, drawn over the live frame (fractions of the picture). */
function LiveMarks({ live }) {
  const flow = live?.flow;
  const arrows = [];
  if (flow) {
    for (let row = 0; row < flow.rows; row += 1) {
      for (let col = 0; col < flow.cols; col += 1) {
        const index = row * flow.cols + col;
        // Arrows per 1/12 s are short: drawn as how far the picture moves in half a second.
        const x = (col + 0.5) / flow.cols, y = (row + 0.5) / flow.rows;
        const dx = Math.max(-0.08, Math.min(0.08, flow.u[index] * 6)), dy = Math.max(-0.12, Math.min(0.12, flow.v[index] * 6));
        arrows.push({ key: index, x, y, dx, dy });
      }
    }
  }
  return (
    <svg className="iv-marks" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      {arrows.map((arrow) => (
        <g key={arrow.key}>
          <line x1={arrow.x} y1={arrow.y} x2={arrow.x + arrow.dx} y2={arrow.y + arrow.dy} className="iv-arrow" vectorEffect="non-scaling-stroke" />
          <circle cx={arrow.x + arrow.dx} cy={arrow.y + arrow.dy} r="0.004" className="iv-tip" />
        </g>
      ))}
      {(live?.text ?? []).map((line, index) => (
        <rect key={index} x={line.box[0]} y={line.box[1]} width={line.box[2]} height={line.box[3]} className="iv-textbox" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** The agent's bot and two lines: what it does, and why. */
function Head({ agent, title, sub, still, mood }) {
  return (
    <header className="iv-head">
      {agent.color ? <Bot color={agent.color} mood={mood} size={44} still={still} /> : null}
      <span className="iv-head-words">
        <h2 className="iv-title">{title}</h2>
        <span className="iv-sub">{sub}</span>
      </span>
    </header>
  );
}

/** A reference being read: the frame kino measures now, with its arrows, one sentence, and its cuts so far. */
function WatchView({ data, ref_: ref, live, onBack, onFull, still }) {
  const sectionRef = useRef(null);
  useEffect(() => { sectionRef.current?.focus(); }, []);
  const looking = data?.inspire?.looking?.id === ref.id ? data.inspire.looking.by : null;
  const agent = looking ? agentOf(data, looking) : { name: "kino", color: null };
  const steps = stepStates(ref.phase);
  const partial = ref.partial ?? null;
  const seconds = partial?.seconds || live?.seconds || ref.duration || 0;
  const read = ref.phase === "reading motion and text" && live ? live.t / Math.max(1, seconds) : ref.phase === "keeping frame strips" ? 1 : 0;
  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") { event.preventDefault(); onBack(); }
  };
  return (
    <section ref={sectionRef} className="screen inspire iv" tabIndex={-1} aria-labelledby="iv-watch-title" onKeyDown={onKeyDown}>
      <div className="iv-body">
        <Head agent={agent} still={still} mood="look" title={<span id="iv-watch-title">{agent.name} is watching "{ref.title}"</span>} sub="to learn how it is edited, so your video can borrow the style" />
        <ol className="iv-steps" aria-label="steps">
          {steps.map((step, index) => (
            <li key={step.name} className={`iv-step ${step.state}`} aria-current={step.state === "now" ? "step" : undefined}>
              <span className="iv-step-mark" aria-hidden="true">{step.state === "done" ? "✓" : index + 1}</span>{step.name}
              <span className="sr-only">{step.state === "done" ? ", done" : step.state === "now" ? ", now" : ""}</span>
            </li>
          ))}
        </ol>
        <div className="iv-stage">
          {live?.image ? <img className="iv-picture" src={live.image} alt={`The frame kino is measuring, at ${clockWords(live.t)}`} />
            : ref.thumb ? <img className="iv-picture dim" src={thumbUrl(ref.id, ref)} alt="" /> : <span className="iv-picture empty"><Shades seed={ref.id} /></span>}
          {live ? <LiveMarks live={live} /> : null}
          {live ? <span className="iv-time" aria-hidden="true">{clockWords(live.t)}</span> : null}
        </div>
        <p className="iv-sentence"><span className="iv-arrow-mark" aria-hidden="true">→</span> {watchSentence(ref.phase, live)}</p>
        <div className="iv-line" aria-label={partial ? `${partial.cuts.length} cuts found in ${clockWords(seconds)}` : "cuts not found yet"} role="img">
          <span className="iv-read" style={{ width: `${Math.min(1, read) * 100}%` }} />
          {(partial?.cuts ?? []).map((time, index) => <span key={index} className={`iv-cut${partial.onBeat?.[index] ? " beat" : ""}`} style={{ left: `${(time / Math.max(1, seconds)) * 100}%` }} />)}
          {read > 0 && read < 1 ? <span className="iv-head-line" style={{ left: `${read * 100}%` }} /> : null}
        </div>
        <p className="iv-line-words"><span>0:00</span><span>each tick is a cut{partial?.onBeat ? ", orange ones land on the beat" : ""}</span><span>{clockWords(seconds)}</span></p>
        {soFarWords(partial).length ? (
          <p className="iv-sofar"><span className="faint">so far</span>{soFarWords(partial).map((line) => <span key={line} className="iv-chip">{line}</span>)}</p>
        ) : null}
      </div>
      <nav className="insp-keyline" aria-label="Inspire views">
        <button type="button" className="insp-btn" onClick={onFull}>All found</button>
        <button type="button" className="insp-btn" onClick={onBack}>Back to stage</button>
      </nav>
    </section>
  );
}

/**
 * The ideas an agent took from a reference: their video with the picked parts marked, one card
 * per idea (what happens, why it is good, what it becomes in your video) with an on/off switch,
 * where each goes in your video, and one answer: a allow, d not yet, n a note to go with it.
 */
function IdeasView({ data, ideas, projectId, onBack, onFull, say, keysRef }) {
  const sectionRef = useRef(null);
  const noteRef = useRef(null);
  const [note, setNote] = useState(null); // null: no note field; a string: the note being written
  const [busy, setBusy] = useState(false);
  useEffect(() => { sectionRef.current?.focus(); }, []);
  const agent = agentOf(data, ideas.by);
  const seconds = ideas.seconds || 1;
  const cells = filmCells(ideas.strips, seconds);
  const all = [...ideas.take, ...ideas.skip];
  const summary = ideasSummary(ideas);
  const scenes = data?.record?.document?.scenes ?? [];
  const yours = scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
  const placed = ideas.take.filter((idea) => idea.place && yours > 0);

  const act_ = async (input, done) => {
    if (busy) return;
    setBusy(true);
    try {
      const reply = await act("library", { project: projectId, topic: "inspire", ...input });
      if (reply?.isError) say(reply.text ?? "That did not work.", true); else if (done) say(done(reply));
    } catch (error) { say(error.message, true); }
    finally { setBusy(false); }
  };
  const toggle = (n) => act_({ name: `idea ${n}` });
  const answer = (what) => act_({ name: `${what} ideas`, ...(note?.trim() ? { note: note.trim() } : {}) }, (reply) => { setNote(null); return reply.text; });
  useEffect(() => {
    if (!keysRef || ideas.status !== "waiting") return undefined;
    keysRef.current = (what) => answer(what);
    return () => { keysRef.current = null; };
  });

  const open = ideas.status === "waiting";
  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (open && event.target === noteRef.current) {
      if (event.key === "Escape") { event.preventDefault(); setNote(null); sectionRef.current?.focus(); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); answer("allow"); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); onBack(); }
  };

  return (
    <section ref={sectionRef} className="screen inspire iv ii" tabIndex={-1} aria-labelledby="ii-title" onKeyDown={onKeyDown}>
      <div className="iv-body ii-body">
        <Head agent={agent} mood={open ? "wait" : "idle"} title={<span id="ii-title">{agent.name} found {ideas.take.length} idea{ideas.take.length === 1 ? "" : "s"} in "{ideas.title}". which should it use?</span>}
          sub={open ? <>The <span className="ii-orange">marked</span> parts of their video are the ideas. Turn each one on or off, then allow.</>
            : <>The <span className="ii-orange">marked</span> parts of their video are the ideas you {ideas.status === "allowed" ? "allowed" : "held"}.</>} />

        <div className="ii-theirs">
          <p className="ii-label"><strong>their video</strong><span className="faint">{clockWords(seconds)}</span></p>
          <div className="ii-film">
            {cells.length ? cells.map((cell) => (
              <span key={cell.file} className="ii-cell" style={{ left: `${cell.x * 100}%`, width: `${cell.w * 100}%` }}><StripFrame id={ideas.ref} file={cell.file} height={64} /></span>
            )) : ideas.thumb ? <img className="ii-thumb" src={thumbUrl(ideas.ref, data?.inspire?.refs?.[ideas.ref])} alt="" /> : null}
            {ideas.take.map((idea) => {
              const end = idea.to ?? idea.from + 0.5;
              return (
                <span key={idea.n} className={`ii-span${idea.on ? "" : " off"}`} style={{ left: `${(idea.from / seconds) * 100}%`, width: `max(18px, ${((end - idea.from) / seconds) * 100}%)` }} aria-hidden="true">
                  <span className="ii-num">{idea.n}</span>
                </span>
              );
            })}
          </div>
        </div>

        <ol className="ii-cards" aria-label="ideas">
          {ideas.take.map((idea) => {
            const frames = ideaFrames(ideas.strips, idea);
            return (
              <li key={idea.n} className={`ii-card${idea.on ? " on" : ""}`}>
                <p className="ii-card-head"><span className="ii-num big" aria-hidden="true">{idea.n}</span>
                  <span><strong className="ii-card-title">{idea.title}</strong><span className="ii-when">their video, {ideaTimeWords(idea)}</span></span></p>
                {frames.length ? <span className="ii-frames">{frames.map((frame, index) => <StripFrame key={index} id={ideas.ref} file={frame.file} frame={frame.frame} />)}</span> : null}
                <dl className="ii-words">
                  <dt>what happens</dt><dd>{idea.what}</dd>
                  <dt>why it's good</dt><dd>{idea.why}</dd>
                  <dt className="ii-yours">in your video</dt><dd className="ii-yours">{idea.use}</dd>
                </dl>
                <button type="button" role="switch" aria-checked={idea.on} className="ii-switch" onClick={() => toggle(idea.n)} disabled={busy || !open}>
                  <span className="ii-box" aria-hidden="true">{idea.on ? "✓" : ""}</span>
                  <span className="ii-switch-word">{idea.on ? "use this" : "not using"}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {placed.length ? (
          <div className="ii-yourvideo">
            <p className="ii-label"><strong>your video</strong><span className="faint">where each idea goes</span><span className="faint">{clockWords(yours)}</span></p>
            <div className="ii-track">
              {placed.map((idea) => {
                const end = idea.place.to ?? idea.place.at + 1;
                return (
                  <span key={idea.n} className={`ii-slot${idea.on ? "" : " off"}${idea.place.at / yours > 0.7 ? " end" : ""}`} style={{ left: `${Math.min(1, idea.place.at / yours) * 100}%`, width: `${Math.max(0.01, Math.min(1, (end - idea.place.at) / yours)) * 100}%` }}>
                    <span className="ii-num">{idea.n}</span><span className="ii-slot-word">{idea.title}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        {!open ? (
          <div className={`ii-done${ideas.status === "held" ? " held" : ""}`} role="status">
            <strong>{ideas.status === "allowed" ? `allowed ${summary.on} idea${summary.on === 1 ? "" : "s"}` : "not yet"}</strong>
            <span>{ideas.status === "allowed" ? `${agent.name} adds ${all.filter((idea) => idea.on).map((idea) => idea.n).join(", ")} to the brief and plans them, on its next call.` : `${agent.name} hears it on its next call and can propose again.`}{ideas.note ? ` your note: "${ideas.note}"` : ""}</span>
          </div>
        ) : null}
        {open ? <div className="ii-answer" role="group" aria-label="your answer">
          <span className="ii-answer-words">
            <strong>{summary.line}</strong>
            {ideas.skip.length ? (
              <span className="ii-skipped">skipped by {agent.name}: {ideas.skip.map((idea, index) => (
                <React.Fragment key={idea.n}>{index ? "; " : ""}
                  <button type="button" role="switch" aria-checked={idea.on} className={`tb ii-skip${idea.on ? " on" : ""}`} onClick={() => toggle(idea.n)} disabled={busy}>
                    {idea.on ? "✓ " : ""}{idea.title}</button> ({idea.why})
                </React.Fragment>
              ))}</span>
            ) : null}
            {note !== null ? (
              <label className="ii-note">note to {agent.name}
                <input ref={noteRef} value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} placeholder="sent with your answer" spellCheck />
              </label>
            ) : null}
          </span>
          <button type="button" className="ii-allow" onClick={() => answer("allow")} disabled={busy || !summary.on}>allow: add to the brief and plan</button>
          <button type="button" className="ii-button" onClick={() => answer("hold")} disabled={busy}>not yet</button>
          <button type="button" className="ii-button" onClick={() => { setNote((value) => value ?? ""); setTimeout(() => noteRef.current?.focus(), 0); }}>note</button>
        </div> : null}
      </div>
      <nav className="insp-keyline" aria-label="Inspire views">
        <button type="button" className="insp-btn" onClick={onFull}>All found</button>
        <button type="button" className="insp-btn" onClick={onBack}>Back to stage</button>
      </nav>
    </section>
  );
}

// ---- the full page: boards, the found pane (videos, music, sounds) and the detail ---------------

const soundUrl = (id) => `/api/dashboard/inspire/sound/${encodeURIComponent(id.slice(3))}`;
const songUrl = (key) => `/api/dashboard/inspire/song/${encodeURIComponent(key)}`;
// A song in the player is "song:<key>", so it never matches a sound effect's id.
const songPlayerId = (row) => `song:${row.key}`;

const ICONS = {
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm3.5-1.5L14 14",
  x: "M4 4l8 8M12 4l-8 8",
  star: "M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z",
  open: "M9 2h5v5M14 2L7.5 8.5M12 9.5V14H2V4h4.5",
  play: "M5 3l8 5-8 5z",
  pause: "M5 3v10M11 3v10",
  loop: "M3 7V5.5A1.5 1.5 0 0 1 4.5 4H12l-2-2M13 9v1.5a1.5 1.5 0 0 1-1.5 1.5H4l2 2",
  send: "M14 2L7 9M14 2l-4.5 12-2.5-5-5-2.5z",
  rows: "M2.5 3.5h11v3h-11zM2.5 9.5h11v3h-11z",
  grid: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  film: "M2.5 3h11v10h-11zM5 3v10M11 3v10",
  tall: "M5 1.5h6v13H5zM7 12.5h2",
  note: "M6 12V3l7-1.5v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  wave: "M2 8h1M4.5 5v6M7 3v10M9.5 6v4M12 4.5v7M14 8h0",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  fit: "M2.5 2.5h11v11h-11zM5.5 8h5M8.5 6l2 2-2 2",
  retry: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  eye: "M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  sort: "M5 2.5v11M2.5 11l2.5 2.5L7.5 11M11 13.5v-11M8.5 5L11 2.5 13.5 5",
  arrow: "M2.5 8h11M9 3.5L13.5 8 9 12.5",
  check: "M3 8.5l3 3 7-7",
};

/** A 16 px line icon (decorative: the button it sits in carries the words). */
function Icon({ name, filled = false }) {
  return (
    <svg className={`insp-icon${filled ? " filled" : ""}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Bars from a sound's peaks (0 to 1); the played part in the accent, the peak marked. */
function Wave({ peaks, played = 0, peak = null, className = "", label = "" }) {
  const count = peaks?.length ?? 0;
  return (
    <svg className={`insp-wave ${className}`} viewBox={`0 0 ${Math.max(1, count)} 2`} preserveAspectRatio="none" role={label ? "img" : undefined}
      aria-label={label || undefined} aria-hidden={label ? undefined : "true"}>
      <line x1="0" x2={count} y1="1" y2="1" className="insp-wave-base" vectorEffect="non-scaling-stroke" />
      {(peaks ?? []).map((value, index) => {
        const h = Math.max(0.04, Math.min(1, value)) * 0.95;
        return <rect key={index} x={index + 0.2} width="0.6" y={1 - h} height={h * 2} className={(index + 0.5) / count <= played ? "on" : ""} />;
      })}
      {peak != null ? <line x1={peak * count} x2={peak * count} y1="0" y2="2" className="insp-wave-peak" vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  );
}

/** The player's waveform as a seek bar: click or drag to jump, the arrow keys skip 5 s. */
function SeekWave({ peaks, t, seconds, title, onSeek }) {
  const played = seconds ? Math.min(1, t / seconds) : 0;
  const jump = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(seekTime(event.clientX - box.left, box.width, seconds));
  };
  const keys = { ArrowLeft: -5, ArrowRight: 5, Home: -Infinity, End: Infinity };
  return (
    <div className={`insp-seek${seconds ? "" : " off"}`} role="slider" tabIndex={seconds ? 0 : -1} aria-label={`${title}: position`}
      aria-valuemin={0} aria-valuemax={Math.round(seconds)} aria-valuenow={Math.round(t)} aria-valuetext={clockWords(t)}
      onPointerDown={(event) => { if (!seconds) return; event.currentTarget.setPointerCapture(event.pointerId); jump(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) jump(event); }}
      onKeyDown={(event) => {
        if (!(event.key in keys) || !seconds) return;
        event.preventDefault();
        event.stopPropagation();
        onSeek(Math.max(0, Math.min(seconds - 0.1, t + keys[event.key])));
      }}>
      <Wave peaks={peaks} played={played} />
      <span className="insp-seek-head" style={{ left: `${played * 100}%` }} aria-hidden="true" />
    </div>
  );
}

// The small drawing on each sound category card: its shape (a whoosh swells, an impact decays ...).
const CATEGORY_SHAPES = {
  whooshes: (x) => Math.exp(-((x - 0.55) ** 2) / 0.04),
  impacts: (x) => Math.exp(-x * 6),
  risers: (x) => x ** 2,
  ticks: (x) => ([0.05, 0.4, 0.75].some((at) => Math.abs(x - at) < 0.02) ? 0.9 : 0.05),
  ambience: (x) => 0.35 + 0.1 * Math.sin(x * 40),
};
const categoryPeaks = (name) => Array.from({ length: 28 }, (_, index) => {
  const x = index / 27;
  return Math.max(0.05, CATEGORY_SHAPES[name](x) * (0.75 + 0.25 * Math.abs(Math.sin(index * 2.3))));
});

/** A labeled native menu, drawn as an icon with the chosen words. */
function Menu({ label, value, options, onChange, icon }) {
  return (
    <label className="insp-menu" title={label}>
      <Icon name={icon} />
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, words]) => <option key={key} value={key}>{words}</option>)}
      </select>
    </label>
  );
}

/**
 * Songs the agent found and measured for this video (library soundtrack), as rows: license, tempo,
 * the energy curve over the story beats, the agent's verdict and why, and the song's fit (your taste
 * and the story; best first). "use" and "no" go to the agent's inbox and to your taste, kept across
 * projects. A measured song plays its preview in the page's one player (nothing plays until
 * you press play); the curve shows the playhead and a click on it plays from there.
 */
function Soundtrack({ rows, projectId, say, player, onPlay }) {
  if (!rows.length) return <p className="insp-none">No songs yet.</p>;
  const use = async (row, word = "use") => {
    try {
      const reply = await act("library", { project: projectId, topic: "soundtrack", name: `${word} ${row.id}` });
      say(reply?.text ?? "Sent.", Boolean(reply?.isError));
    } catch (error) { say(error.message, true); }
  };
  const seek = (event, row) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = songSeek(row, ((event.clientX - box.left) / Math.max(1, box.width)) * 100);
    if (at == null) say("That part of the song is not in its preview.", true);
    else onPlay(row, at);
  };
  return (
    <ul className="insp-rowlist" aria-label="music">
      {rows.map((row) => {
        const on = player.id === songPlayerId(row);
        const playing = on && player.playing;
        const head = on ? songPlayhead(row, player.t) : null;
        return (
          <li key={row.id} className={`insp-row music${row.picked ? " picked" : ""}${row.rejected ? " rejected" : ""}`}>
            {row.preview ? (
              <button type="button" className={`insp-play${playing ? " on" : ""}`} onClick={() => onPlay(row)}
                aria-label={`${playing ? "pause" : "play"} ${row.title}`} title={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} /></button>
            ) : row.measured ? (
              <button type="button" className="insp-play" disabled aria-label={`${row.title}: measure again to listen`} title="Measure again to listen"><Icon name="play" /></button>
            ) : <span className="insp-row-icon" aria-hidden="true"><Icon name="note" /></span>}
            <span className="insp-row-words">
              <span className="insp-row-title" title={row.title}>{row.title}</span>
              <span className="insp-row-sub"><span>{row.creator}</span>{row.fit != null ? <span className="insp-chip fit" title={row.fitWhy}>fit {row.fit}</span> : null}
                {row.lane ? <span className="insp-chip lane" title="the song's lane (CLAP)">{row.lane}</span> : null}
                <span className={`insp-chip${row.reference ? " ref" : ""}`}>{row.license}</span><span className="insp-chip">{row.bpm}</span>
                {row.verdict ? <span className={`insp-chip verdict-${row.verdict}`} title={row.why}>{row.verdict}</span> : null}</span>
            </span>
            <svg className={`insp-curve${row.preview ? " seekable" : ""}`} viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label={`${row.title}: energy over the video's beats`}
              onClick={row.preview ? (event) => seek(event, row) : undefined}>
              {row.marks.map((x) => <line key={x} x1={x} x2={x} y1="0" y2="24" className="insp-curve-beat" />)}
              {row.path ? <path d={row.path} className="insp-curve-line" /> : null}
              {head != null ? <line x1={head} x2={head} y1="0" y2="24" className="insp-curve-head" /> : null}
            </svg>
            <span className="insp-row-acts">
              <button type="button" className={`insp-btn${row.picked ? " on" : ""}`} onClick={() => use(row)} aria-pressed={row.picked}>{row.picked ? "Picked" : "Use"}</button>
              <button type="button" className={`insp-btn${row.rejected ? " on" : ""}`} onClick={() => use(row, "no")} aria-pressed={row.rejected} aria-label={`no to ${row.title}`}>No</button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One video tile: pick it by clicking; save and open on hover; try again when it failed. */
function Tile({ entry, picked, saved, looking, onPick, onSave, onOpen, onRetry }) {
  if (!entry.id) return <li className="insp-tile s-searching" aria-hidden="true"><Thumb tile={entry} /></li>;
  const ref = entry.ref ?? {};
  const failed = entry.state === "failed";
  const doubts = tileChips(ref).filter((chip) => chip.doubt).slice(0, 2);
  return (
    <li className={`insp-tile s-${entry.state}${picked ? " picked" : ""}`}>
      <button type="button" className="insp-pick" aria-pressed={picked} aria-label={tileLabel(entry)} title={ref.title ?? entry.id} onClick={onPick}>
        <span className="insp-frame" style={looking?.color ? { "--looker": looking.color } : undefined}>
          <Thumb tile={entry} />
          {looking ? <span className="insp-looking" aria-hidden="true"><span className="insp-brackets" /><Bot color={looking.color} mood="look" size={16} /></span> : null}
        </span>
        <Ticks numbers={ref.numbers} />
        <span className="insp-words">
          <span className="insp-len">{clockWords(ref.duration)}</span>
          {failed ? <span className="err">failed</span> : entry.state === "measuring" ? <span className="insp-spin" aria-label="reading" /> : null}
          {doubts.length ? <span className="insp-chips">{doubts.map((chip) => <span key={chip.text} className="insp-chip doubt">{chip.text}</span>)}</span> : null}
        </span>
      </button>
      <span className={`insp-over${saved ? " has-saved" : ""}`}>
        <button type="button" className="insp-ibtn hover-only" onClick={onOpen} aria-label="open on YouTube" title="Open on YouTube"><Icon name="open" /></button>
        <button type="button" className={`insp-ibtn${saved ? " on" : ""}`} onClick={onSave} aria-pressed={saved} aria-label={saved ? "saved" : "save"} title={saved ? "Saved" : "Save"}><Icon name="star" filled={saved} /></button>
      </span>
      {failed ? <button type="button" className="insp-retry" onClick={onRetry}><Icon name="retry" /> Try again</button> : null}
    </li>
  );
}

/**
 * The full page, top to bottom: the search and the kinds; the picked reference big, with its facts
 * and the cut barcode; the boards as chips; what was found as a row of thumbnails. Every action a button.
 */
function Breakdown({ data, projectId, onBack, say, onSimple }) {
  const inspire = data?.inspire ?? null;
  const soundtrack = data?.agent?.soundtrack ?? null;
  const who = searcher(inspire);
  const agentRow = who && !who.you ? data?.agents?.find((agent) => agent.id === who.id) ?? null : data?.agents?.[0] ?? null;
  const agentName = (who && !who.you ? who.name : agentRow?.name) ?? "agent";
  const [kind, setKind] = useState("videos");
  const [shorts, setShorts] = useState(false); // videos tab: search YouTube Shorts only
  const [board, setBoard] = useState("all");
  const [view, setView] = useState("grid");
  const [show, setShow] = useState("all");
  const [sort, setSort] = useState("match");
  const [filter, setFilter] = useState("");
  const [allBoards, setAllBoards] = useState(false);
  const [picked, setPicked] = useState(null); // a reference id
  const [closed, setClosed] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);
  const [player, setPlayer] = useState({ id: null, playing: false, t: 0, d: 0, loop: false });
  const audioRef = useRef(null);
  const searchRef = useRef(null);
  const saved = inspire?.saved ?? [];
  const savedSet = new Set(saved);

  const boards = useMemo(() => boardRows(inspire), [inspire]);
  const { pinned, shown, more } = filterBoards(boards, filter, allBoards ? null : BOARD_LIMIT);
  const counts = kindCounts(inspire, soundtrack);
  const tabKind = kind === "music" ? "videos" : kind;
  const list = useMemo(() => arrange(boardTiles(inspire, board, tabKind), { show, sort, saved }), [inspire, board, tabKind, show, sort, saved]);
  const rows = list.filter((entry) => entry.id);
  const all = useMemo(() => [...tiles(inspire, "videos"), ...tiles(inspire, "sounds")].filter((entry) => entry.id), [inspire]);
  // With nothing picked, the detail shows the first tile on screen (the newest shelf leads in shelves view).
  const firstShown = kind === "videos" && board === "all" && view === "shelves" ? shelves(inspire, "videos")[0]?.tiles.find((entry) => entry.id) : rows[0];
  const tile = closed ? null : all.find((entry) => entry.id === picked) ?? (kind === "music" ? null : firstShown ?? null);
  const ref = tile?.ref ?? null;
  const boardRow = boards.find((row) => row.key === board) ?? boards[0];

  const run = async (label, verb, input, done) => {
    if (busy) return;
    setBusy(label);
    try {
      const reply = await act(verb, { project: projectId, ...input });
      if (reply?.isError) say(reply.text ?? `${label} failed.`, true);
      else say(done(reply));
    } catch (error) { say(error.message ?? `${label} failed.`, true); }
    finally { setBusy(null); }
  };
  // kind: "sounds", "shorts" (YouTube Shorts, vertical) or plain videos.
  const searchFor = (words, searchKind = "videos") => run("search", "library", { topic: "inspire", search: words, ...(searchKind !== "videos" ? { kind: searchKind } : {}) },
    (reply) => `${reply.data?.results?.length ?? 0} found for ${words}.`);
  const search = (event) => {
    event?.preventDefault();
    const words = query.trim();
    if (!words) { say("Type what to look for.", true); searchRef.current?.focus(); return; }
    setQuery("");
    setBoard("all");
    searchFor(words, kind === "sounds" ? "sounds" : shorts ? "shorts" : "videos");
  };
  const pick = (id) => { setPicked(id); setClosed(false); };
  const borrow = (fit) => {
    if (!tile?.id || !ref?.numbers) return;
    run("borrow", "edit", { ops: [{ op: "borrow_rhythm", ref: tile.id, ...(fit ? { fit: true } : {}) }] },
      () => `Borrowed ${ref.numbers.cuts.length} cuts from ${ref.title} as cue marks${fit ? ", fit to the scene" : ""}.`);
  };
  const toggleSave = (id, title) => {
    const on = !savedSet.has(id);
    run("save", "library", { topic: "inspire", name: `${on ? "save" : "unsave"} ${id}` }, () => `${on ? "Saved" : "Unsaved"} ${title ?? id}.`);
  };
  const openSource = async (target) => {
    if (!target?.url) return;
    try {
      if (window.kinoDesktop?.openSource) {
        const result = await window.kinoDesktop.openSource(target.url);
        if (!result?.ok) { say(result?.error ?? "The page could not be opened.", true); return; }
      } else window.open(target.url, "_blank", "noopener,noreferrer");
      say(`Opened ${target.title} in your browser.`);
    } catch (error) { say(error.message, true); }
  };
  const measure = (id, title) => run("read", "library", { topic: "inspire", name: `measure ${id}` }, () => `Reading ${title ?? id} again.`);
  const stop = () => run("stop", "library", { topic: "inspire", name: "cancel" }, (reply) => reply.text);
  const forget = (row) => run("forget", "library", { topic: "inspire", name: `forget ${row.n}` }, () => `Forgot "${row.name}".`);
  // use / no on a sound: the person's sound taste (ranks the next sounds) and a line in the agent's inbox.
  const markSound = (id, word) => run("mark", "library", { topic: "inspire", name: `${word} ${id}` }, (reply) => reply?.text ?? "Sent.");
  const sendSound = (target) => run("send", "notes", { action: "add", text: soundNote(target) }, () => `Sent ${target.title} to ${agentName}.`);
  const openBoard = (key) => {
    setBoard(key);
    const row = boards.find((entry) => entry.key === key);
    if (row?.kind && row.kind !== tabKind) setKind(row.kind);
  };
  const category = (word) => {
    const stem = word.replace(/e?s$/, "");
    const found = boards.find((row) => row.kind === "sounds" && row.name.toLowerCase().includes(stem));
    if (found) setBoard(found.key); else searchFor(word, "sounds");
  };

  // The player: one <audio> for the sound or song picked to play; nothing plays until you press
  // play. `at` (seconds) plays from there (a click on a song's curve).
  const play = (id, url, at = null) => {
    const audio = audioRef.current;
    if (!audio) return;
    const start = () => audio.play().catch((error) => { if (error?.name !== "AbortError") say(error.message, true); });
    if (player.id === id) {
      if (at != null) { audio.currentTime = at; if (audio.paused) start(); }
      else if (audio.paused) start(); else audio.pause();
      return;
    }
    setPlayer((value) => ({ ...value, id, t: at ?? 0, d: 0 }));
    audio.src = url;
    if (at != null) audio.currentTime = at;
    start();
  };
  const playSound = (id) => play(id, soundUrl(id));
  const songs = useMemo(() => soundtrackRows(soundtrack), [soundtrack]);
  const playSong = (row, at = null) => play(songPlayerId(row), songUrl(row.key), at);
  const playerSong = player.id?.startsWith("song:") ? songs.find((row) => songPlayerId(row) === player.id) ?? null : null;
  const playerRef = player.id ? inspire?.refs?.[player.id] ?? null : null;

  const onKeyDown = (event) => {
    if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target === searchRef.current && query) { event.preventDefault(); setQuery(""); return; }
    event.preventDefault();
    if (tile) setClosed(true); else onBack();
  };

  const busyNow = inspire?.queue?.running || (inspire?.searches ?? []).some((row) => row.state === "searching");
  const lookingAt = (id) => (inspire?.looking?.id === id && inspire.looking.by?.id ? inspire.looking.by : null);
  const tileProps = (entry) => ({
    entry, picked: entry.id === tile?.id, saved: savedSet.has(entry.id), looking: lookingAt(entry.id),
    onPick: () => pick(entry.id), onSave: () => toggleSave(entry.id, entry.ref?.title), onOpen: () => openSource(entry.ref), onRetry: () => measure(entry.id, entry.ref?.title),
  });
  // A board is a chip: its name, its count for the two pinned ones; a search's chip forgets it on hover.
  const boardChip = (row) => (
    <li key={row.key} className={`insp-board${board === row.key ? " on" : ""}`}>
      <button type="button" className="insp-board-main" aria-pressed={board === row.key} onClick={() => openBoard(row.key)} title={row.n ? `${row.name}: ${row.sub}` : row.sub}>
        {row.kind === "sounds" ? <span className="insp-board-kind" aria-label="sounds"><Icon name="wave" /></span> : null}
        <span className="insp-board-name">{row.name}</span>
        {row.state === "searching" ? <span className="insp-spin" aria-label="searching" /> : !row.n ? <span className="insp-board-n">{row.count}</span> : null}
      </button>
      {row.n ? <button type="button" className="insp-ibtn insp-forget" onClick={() => forget(row)} aria-label={`forget ${row.name}`} title="Forget this search"><Icon name="x" /></button> : null}
    </li>
  );

  const boardHead = board !== "all" && kind === "sounds" ? (
    <p className="insp-shelf-head"><strong>{boardRow.name}</strong><span className="insp-n">{rows.length}</span></p>
  ) : null;

  let found;
  if (kind === "music") found = <Soundtrack rows={musicOrder(songs)} projectId={projectId} say={say} player={player} onPlay={playSong} />;
  else if (kind === "sounds") {
    const played = (id) => (player.id === id && player.d ? player.t / player.d : 0);
    found = (
      <>
        <ul className="insp-cats" aria-label="sound categories">
          {SOUND_CATEGORIES.map((word) => {
            const stem = word.replace(/e?s$/, "");
            const match = boards.find((row) => row.kind === "sounds" && row.name.toLowerCase().includes(stem));
            return (
              <li key={word}>
                <button type="button" className={`insp-cat${match && board === match.key ? " on" : ""}`} aria-pressed={Boolean(match && board === match.key)} onClick={() => category(word)}>
                  <Wave peaks={categoryPeaks(word)} played={match && board === match.key ? 1 : 0} />
                  <span className="insp-cat-words"><span>{word[0].toUpperCase() + word.slice(1)}</span><span className="insp-n">{match ? match.count : ""}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
        {boardHead}
        {rows.length ? (
          <ul className="insp-rowlist" aria-label="sounds">
            {rows.map((entry) => {
              const row = soundRow(entry, saved);
              const on = entry.id === tile?.id;
              const playing = player.id === entry.id && player.playing;
              return (
                <li key={entry.id} className={`insp-row sound${on ? " picked" : ""}`} onClick={() => pick(entry.id)}>
                  <button type="button" className={`insp-play${playing ? " on" : ""}`} onClick={(event) => { event.stopPropagation(); pick(entry.id); playSound(entry.id); }}
                    aria-label={`${playing ? "pause" : "play"} ${row.title}`} title={playing ? "Pause" : "Play"}><Icon name={playing ? "pause" : "play"} /></button>
                  <button type="button" className="insp-row-words" aria-pressed={on} onClick={(event) => { event.stopPropagation(); pick(entry.id); }}>
                    <span className="insp-row-title">{row.title}</span>
                    <span className="insp-row-sub"><span>{row.source}</span>
                      {row.match != null ? <span className="insp-chip fit" title={`how it sounds against the words${row.alike ? `; ${row.alike} alike folded in` : ""}`}>match {row.match}</span> : null}
                      {row.taste != null ? <span className="insp-chip lane" title={row.why || "your use and no on sounds"}>taste {row.taste}</span> : null}
                      {row.tags.slice(0, 2).map((tag) => <span key={tag} className="insp-chip">{tag}</span>)}
                      {entry.state !== "measured" ? <span className={entry.state === "failed" ? "err" : "faint"}>{tileWords(entry).left}</span> : null}</span>
                  </button>
                  <Wave peaks={row.peaks} played={played(entry.id)} />
                  <span className="insp-row-len">{row.length}</span>
                  <span className="insp-row-acts">
                    <button type="button" className={`insp-ibtn${row.saved ? " on" : ""}`} onClick={(event) => { event.stopPropagation(); toggleSave(entry.id, row.title); }} aria-pressed={row.saved}
                      aria-label={row.saved ? "saved" : "save"} title={row.saved ? "Saved" : "Save"}><Icon name="star" filled={row.saved} /></button>
                    {entry.ref?.sound ? <button type="button" className="insp-btn hover-only" onClick={(event) => { event.stopPropagation(); markSound(entry.id, "use"); }}>Use</button> : null}
                    {entry.ref?.sound ? <button type="button" className="insp-btn hover-only" onClick={(event) => { event.stopPropagation(); markSound(entry.id, "no"); }} aria-label={`no to ${row.title}`}>No</button> : null}
                    <button type="button" className="insp-ibtn hover-only" onClick={(event) => { event.stopPropagation(); sendSound(entry.ref ?? { id: entry.id, title: row.title }); }}
                      aria-label={`send to ${agentName}`} title={`Send to ${agentName}`}><Icon name="send" /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="insp-none">{busyNow ? "Searching" : "No sounds yet."}</p>}
      </>
    );
  } else if (board === "all" && view === "shelves" && show === "all" && sort === "match") {
    const groups = shelves(inspire, "videos", 6);
    found = groups.length ? groups.map((group) => (
      <section key={group.key} className="insp-shelf" aria-label={group.name}>
        <p className="insp-shelf-head"><strong title={group.name}>{group.name}</strong><span className="insp-n">{group.count}</span>
          {group.count > 6 ? <button type="button" className="insp-link right" onClick={() => setBoard(group.key)}>See all <Icon name="arrow" /></button> : null}</p>
        <ul className="insp-tiles">{group.tiles.map((entry) => <Tile key={entry.key} {...tileProps(entry)} />)}</ul>
      </section>
    )) : <p className="insp-none">No searches yet.</p>;
  } else {
    found = list.length ? <ul className="insp-tiles">{list.map((entry) => <Tile key={entry.key} {...tileProps(entry)} />)}</ul> : <p className="insp-none">Nothing here.</p>;
  }

  const isSoundRef = ref?.kind === "sound";
  const facts = factRows(ref);
  const sound = isSoundRef && tile ? soundRow(tile, saved) : null;
  const soundPlayed = sound && player.id === sound.id && player.d ? player.t / player.d : 0;
  const isSaved = Boolean(tile?.id && savedSet.has(tile.id));
  const doubts = tileChips(ref).filter((chip) => chip.doubt);

  // The picked one, big: its picture (or a sound's waveform) on the left, its facts on the right.
  let hero = null;
  if (kind !== "music") {
    hero = tile?.id ? (
      <div className={`insp-hero${isSoundRef ? " sound" : ""}`}>
        {isSoundRef ? (
          <div className="insp-bigwave">
            <Wave peaks={sound.peaks} played={soundPlayed || (sound.peak ?? 0)} peak={sound.peak} label={`${sound.title}: waveform${sound.peak != null ? ", the peak marked" : ""}`} />
            <p className="insp-axis" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((x) => <span key={x}>{(Math.round(x * sound.seconds * 10) / 10).toFixed(1)}</span>)}</p>
          </div>
        ) : (
          <span className="insp-ref-thumb"><Thumb tile={tile} />
            <button type="button" className="insp-thumb-play" onClick={() => openSource(ref)} aria-label={`play ${ref?.title ?? ""} on YouTube`} title="Play on YouTube"><Icon name="play" /></button></span>
        )}
        <section className="insp-ref" aria-labelledby="insp-ref-title">
          <h3 id="insp-ref-title" className="insp-ref-title" title={ref?.title}>{ref?.title ?? tile.id}</h3>
          <p className="insp-ref-sub">
            {ref?.duration ? <span className="insp-n">{isSoundRef ? soundDetail(ref)[0][1] : clockWords(ref.duration)}</span> : null}
            {viewWords(ref?.views) ? <span className="insp-n">{viewWords(ref.views)}</span> : null}
            {ref?.channel ? <span className="insp-channel" title={ref.verified ? "verified channel" : undefined}>{ref.channel}{ref.verified ? <Icon name="check" /> : null}</span> : null}
            {doubts.map((chip) => <span key={chip.text} className="insp-chip doubt" title={`doubt: ${ref.doubt ?? chip.text}`}>{chip.text}</span>)}
          </p>
          {isSoundRef ? (
            <dl className="insp-rows">{soundDetail(ref).map(([label, value]) => <React.Fragment key={label}><dt>{label[0].toUpperCase() + label.slice(1)}</dt><dd>{value}</dd></React.Fragment>)}</dl>
          ) : ref?.numbers ? (
            <>
              <span role="img" aria-label={`${ref.numbers.cuts.length} cuts${ref.numbers.onBeat ? `, ${ref.numbers.onBeatCount} on the beat` : ""}`}><Ticks numbers={ref.numbers} beats className="big" /></span>
              <dl className="insp-rows">{facts.map(([label, value, rest]) => <React.Fragment key={label}><dt>{label}</dt><dd title={rest || undefined}>{value}</dd></React.Fragment>)}</dl>
            </>
          ) : (
            <p className="insp-status">{tileWords(tile).left || "Not read"}
              {tile.state === "failed" || tile.state === "found" ? <button type="button" className="insp-btn" onClick={() => measure(tile.id, ref?.title)}><Icon name="retry" /> Try again</button> : null}</p>
          )}
          <div className="insp-actions">
            {isSoundRef ? (
              <button type="button" className="insp-btn primary" onClick={() => sendSound(ref)}><Icon name="send" /> Send to {agentName}</button>
            ) : (
              <button type="button" className="insp-btn primary" onClick={() => borrow(false)} disabled={busy === "borrow" || !ref?.numbers} title="Its cuts as cue marks"><Icon name="arrow" /> Borrow its rhythm</button>
            )}
            <button type="button" className={`insp-btn${isSaved ? " starred" : ""}`} onClick={() => toggleSave(tile.id, ref?.title)} aria-pressed={isSaved}>
              <Icon name="star" filled={isSaved} /> {isSaved ? "Saved" : "Save"}</button>
            <span className="insp-actions-end">
              {!isSoundRef && ref?.numbers ? <button type="button" className="insp-ibtn" onClick={() => borrow(true)} disabled={busy === "borrow"} aria-label="borrow its rhythm, fit to the scene" title="Borrow, fit to the scene"><Icon name="fit" /></button> : null}
              <button type="button" className="insp-ibtn" onClick={() => openSource(ref)} aria-label={isSoundRef ? "open the source" : "open on YouTube"} title={isSoundRef ? "Open the source" : "Open on YouTube"}><Icon name="open" /></button>
              <button type="button" className="insp-ibtn" onClick={() => setClosed(true)} aria-label="close" title="Close"><Icon name="x" /></button>
            </span>
          </div>
        </section>
      </div>
    ) : rows.length ? <p className="insp-none insp-hero-none">{kind === "sounds" ? "Pick a sound." : "Pick a video."}</p> : null;
  }

  return (
    <section className="screen inspire" aria-labelledby="inspire-heading" onKeyDown={onKeyDown}>
      <h2 id="inspire-heading" className="sr-only">inspire</h2>
      <audio ref={audioRef} preload="none" loop={player.loop}
        onPlay={() => setPlayer((value) => ({ ...value, playing: true }))} onPause={() => setPlayer((value) => ({ ...value, playing: false }))}
        onTimeUpdate={(event) => { const { currentTime, duration } = event.currentTarget; setPlayer((value) => ({ ...value, t: currentTime, d: Number.isFinite(duration) ? duration : 0 })); }}
        onError={() => player.id && say(player.id.startsWith("song:") ? "That song's preview is gone: ask the agent to measure it again." : "That sound could not be loaded.", true)} />
      <div className="insp-top">
        <form className="insp-searchbar" onSubmit={search} role="search">
          <label className="insp-field">
            <Icon name="search" /><span className="sr-only">{kind === "sounds" ? "search sounds" : "search YouTube"}</span>
            <input ref={searchRef} value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)}
              placeholder={kind === "sounds" ? "soft whoosh for a cut" : shorts && kind === "videos" ? "app launch animation" : "walking tour edit"} autoComplete="off" spellCheck={false} />
            {query ? <button type="button" className="insp-ibtn" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="clear" title="Clear"><Icon name="x" /></button> : null}
            <button type="submit" className="insp-ibtn insp-go" disabled={busy === "search" || !query.trim()} aria-label="search" title="Search"><Icon name="arrow" /></button>
          </label>
        </form>
        <span className="insp-kinds">
          <span className="insp-tabs" role="group" aria-label="kind">
            {["videos", "music", "sounds"].map((name) => (
              <button key={name} type="button" className={`insp-tab${kind === name ? " on" : ""}`} aria-pressed={kind === name} title={`${counts[name]} found`}
                onClick={() => { setKind(name); setShow("all"); if (board !== "all" && board !== "saved") setBoard("all"); }}>
                {name[0].toUpperCase() + name.slice(1)}
              </button>
            ))}
          </span>
          {kind === "videos" ? (
            <button type="button" className={`insp-btn insp-shorts${shorts ? " on" : ""}`} aria-pressed={shorts} onClick={() => setShorts((on) => !on)}
              title="YouTube Shorts only (vertical)">Shorts</button>
          ) : null}
        </span>
      </div>
      {hero}
      <div className="insp-bar">
        {kind !== "music" ? (
          <ul className="insp-boards" aria-label="boards">
            {pinned.map(boardChip)}
            {shown.map(boardChip)}
            {more ? <li><button type="button" className="insp-more" onClick={() => setAllBoards(true)}>{more} more</button></li>
              : allBoards ? <li><button type="button" className="insp-more" onClick={() => setAllBoards(false)}>Fewer</button></li> : null}
            {boards.length - 2 > BOARD_LIMIT ? (
              <li><label className="insp-field small">
                <Icon name="search" /><span className="sr-only">filter boards</span>
                <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" autoComplete="off" spellCheck={false} />
              </label></li>
            ) : null}
          </ul>
        ) : <span />}
        <span className="insp-bar-end">
          {busyNow ? <button type="button" className="insp-btn quiet" onClick={stop} title="Stop reading">Reading<span className="insp-spin" aria-hidden="true" /> Stop</button> : null}
          {onSimple ? <button type="button" className="insp-btn quiet" onClick={onSimple}>Live view</button> : null}
          {kind !== "music" ? <>
            <Menu label="show" icon="eye" value={show} options={SHOW_OPTIONS[tabKind]} onChange={setShow} />
            <Menu label="sort" icon="sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
          </> : null}
          {kind === "videos" ? (
            <span className="insp-toggle" role="group" aria-label="view">
              <button type="button" className={`insp-ibtn${view === "grid" ? " on" : ""}`} aria-pressed={view === "grid"} onClick={() => setView("grid")} aria-label="grid" title="Grid"><Icon name="grid" /></button>
              <button type="button" className={`insp-ibtn${view === "shelves" ? " on" : ""}`} aria-pressed={view === "shelves"} onClick={() => setView("shelves")} aria-label="shelves" title="Shelves"><Icon name="rows" /></button>
            </span>
          ) : null}
        </span>
      </div>
      <div className="insp-found">{found}</div>
      {kind === "music" && playerSong ? (
        <div className="insp-player" role="group" aria-label="player">
          <button type="button" className={`insp-play big${player.playing ? " on" : ""}`} onClick={() => playSong(playerSong)}
            aria-label={player.playing ? "pause" : "play"} title={player.playing ? "Pause" : "Play"}><Icon name={player.playing ? "pause" : "play"} /></button>
          <span className="insp-player-title">{playerSong.title}</span>
          <SeekWave peaks={playerSong.peaks} t={player.t} seconds={player.d || playerSong.preview?.seconds || 0} title={playerSong.title} onSeek={(at) => playSong(playerSong, at)} />
          <span className="insp-player-time">{clockWords(player.t)} / {clockWords(player.d || playerSong.preview?.seconds || 0)}</span>
          <button type="button" className={`insp-ibtn${player.loop ? " on" : ""}`} aria-pressed={player.loop} onClick={() => setPlayer((value) => ({ ...value, loop: !value.loop }))} aria-label="loop" title="Loop"><Icon name="loop" /></button>
        </div>
      ) : null}
      {kind === "sounds" && (playerRef || sound) ? (() => {
        const target = playerRef ? soundRow({ id: player.id, ref: playerRef, state: playerRef.state }, saved) : sound;
        const on = player.id === target.id;
        return (
          <div className="insp-player" role="group" aria-label="player">
            <button type="button" className={`insp-play big${on && player.playing ? " on" : ""}`} onClick={() => playSound(target.id)}
              aria-label={on && player.playing ? "pause" : "play"} title={on && player.playing ? "Pause" : "Play"}><Icon name={on && player.playing ? "pause" : "play"} /></button>
            <span className="insp-player-title">{target.title}</span>
            <SeekWave peaks={target.peaks} t={on ? player.t : 0} seconds={on && player.d ? player.d : target.seconds || 0} title={target.title} onSeek={(at) => play(target.id, soundUrl(target.id), at)} />
            <span className="insp-player-time">{clockWords(on ? player.t : 0)} / {clockWords(on && player.d ? player.d : target.seconds)}</span>
            <button type="button" className={`insp-ibtn${player.loop ? " on" : ""}`} aria-pressed={player.loop} onClick={() => setPlayer((value) => ({ ...value, loop: !value.loop }))} aria-label="loop" title="Loop"><Icon name="loop" /></button>
          </div>
        );
      })() : null}
    </section>
  );
}
