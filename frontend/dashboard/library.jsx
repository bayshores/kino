// The library screen: everything an agent can use (moves, effects, animations, recipes, looks,
// video formats), by what it does (the technique groups) or by kind. Each card shows a still of a
// short sample; the open entry plays its sample on a loop and says what it is, when it fits and
// where this video uses it. "ask for this" adds it (on a storyboard shot, or anywhere) to a note at
// the bottom, which goes to the agent as one note.
//
// Data flow: GET /api/dashboard/library (backend/agent/library-catalog.mjs) → the lists; GET
// library-still → each card's picture; library-sample?kind&name → the open entry's document, played by
// ScenePreview. The note is notes {action:"add"} (Dashboard.jsx sendNote).
import React, { useEffect, useMemo, useState } from "react";
import { ScenePreview } from "../components/ScenePreview.jsx";
import { loadBrowserFonts } from "../browserFonts.js";
import { libraryCatalog, librarySample, libraryStillUrl } from "./api.js";
import { askChip, askNote, shotWords, shotsUsing, shownEntries, usedIn, withAsk } from "./libraryRows.js";
import { Back, Screen } from "./screens.jsx";
import "./library.css";

// In a group or a search, each card says its kind (a move and an effect can share a name).
const KIND_LABEL = { move: "move", effect: "effect", animation: "animation", recipe: "recipe", look: "look", format: "format", technique: "plain edit" };

// Samples are the same for every project: fetched once a session, with their fonts loaded so
// the text draws (as the stage loads a project's).
const samples = new Map();
function sampleOf(entry) {
  if (!samples.has(entry.id)) samples.set(entry.id, librarySample(entry.kind, entry.name)
    .then(async (sample) => { if (sample.document) await loadBrowserFonts(sample.document).catch(() => {}); return sample; })
    .catch(() => ({ document: null })));
  return samples.get(entry.id);
}
function useSample(entry) {
  const [sample, setSample] = useState(null);
  useEffect(() => {
    let live = true;
    setSample(null);
    if (entry) sampleOf(entry).then((value) => { if (live) setSample(value); });
    return () => { live = false; };
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return sample;
}

// A card's still: the sample's moment drawn by the export renderer, so effects show as they render.
function Still({ entry }) {
  const [missing, setMissing] = useState(false);
  if (entry.kind === "format" || missing)
    return <span className="lib-none">{entry.kind === "format" ? "a whole video: no preview" : "no sample"}</span>;
  return <img className="lib-img" src={libraryStillUrl(entry.kind, entry.name)} alt="" loading="lazy" onError={() => setMissing(true)} />;
}

// The open entry's sample, playing on a loop until pause.
function Player({ entry }) {
  const sample = useSample(entry);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const scene = sample?.document?.scenes?.[0];
  const duration = Number(scene?.duration) || 1;
  useEffect(() => {
    if (!scene || !playing) return undefined;
    let frame = 0;
    const start = performance.now() - time * 1000;
    const step = (now) => { setTime(((now - start) / 1000) % duration); frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [scene, playing, duration]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTime(0); setPlaying(true); }, [entry.id]);
  return (
    <div className="lib-player">
      <div className="lib-stage">
        {scene ? <ScenePreview document={sample.document} scene={scene} time={time} design={false} playing={playing} fontVersion={0} audio="external" skipPrewarm />
          : <span className="lib-none">{sample ? (entry.kind === "format" ? "a whole video, made from your own material: no preview here. Ask for it to see it on yours" : "no sample") : ""}</span>}
      </div>
      {scene ? (
        <div className="lib-controls">
          <button type="button" className="tb" aria-label={playing ? "pause" : "play"} onClick={() => setPlaying((value) => !value)}>{playing ? "❚❚" : "▶"}</button>
          <span className="lib-bar" aria-hidden="true"><span style={{ width: `${(time / duration) * 100}%` }} /></span>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ entry, used, shots, onAsk }) {
  const [shot, setShot] = useState("");
  const inShots = shotsUsing(entry, shots);
  return (
    <aside className="lib-detail" aria-label={entry.words}>
      <Player entry={entry} />
      <h3 className="lib-name">{entry.words}</h3>
      <p className="lib-line">{entry.line}</p>
      {entry.fits ? <><p className="lib-label">fits</p><p className="lib-fits">{entry.fits}</p></> : null}
      {used ? <p className="lib-used"><span aria-hidden="true">● </span>in this video{inShots.length ? `: ${shotWords(inShots)}` : ""}</p> : null}
      <div className="lib-ask">
        <button type="button" className="tb tb-box tb-accent" onClick={() => onAsk(entry, shot ? Number(shot) : null)}>[+] ask for this</button>
        {shots.length ? (
          <select aria-label="on which shot" value={shot} onChange={(event) => setShot(event.target.value)}>
            <option value="">anywhere</option>
            {shots.map((_, index) => <option key={index} value={index + 1}>on shot {index + 1}</option>)}
          </select>
        ) : null}
      </div>
    </aside>
  );
}

export function LibraryScreen({ document, shots = [], onSend, onBack }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState({ group: "transition" });
  const [search, setSearch] = useState("");
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [asks, setAsks] = useState([]);
  const [words, setWords] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { libraryCatalog().then(setCatalog, (cause) => setError(cause.message)); }, []);
  const used = useMemo(() => usedIn(document), [document]);
  // A search looks through everything; otherwise the chosen group or kind.
  const entries = shownEntries(catalog, { ...(search.trim() ? {} : view), search, onlyUsed, used });
  const open = entries.find((entry) => entry.id === openId) ?? entries[0] ?? null;
  const heading = search.trim() ? ["search", `${entries.length} found`]
    : view.group ? [catalog?.groups.find((group) => group.group === view.group)?.label, catalog?.groups.find((group) => group.group === view.group)?.line]
      : [catalog?.kinds.find((kind) => kind.kind === view.kind)?.label, ""];
  const send = async () => {
    setSending(true);
    try { await onSend(askNote(asks, words)); setAsks([]); setWords(""); } finally { setSending(false); }
  };
  const pick = (next) => { setView(next); setSearch(""); setOpenId(null); };
  return (
    <Screen title="library" className="library-screen" actions={<>
      <span className="lib-sub">everything the agent can use</span>
      <input className="lib-search" type="search" placeholder="search: blur, glitch, captions…" aria-label="search the library" value={search} onChange={(event) => setSearch(event.target.value)} />
      <span className="lib-scope" role="group" aria-label="show">
        <button type="button" className="tb" aria-pressed={!onlyUsed} onClick={() => setOnlyUsed(false)}>all {catalog?.total ?? ""}</button>
        <button type="button" className="tb" aria-pressed={onlyUsed} onClick={() => setOnlyUsed(true)}>in this video {used.size}</button>
      </span>
      <Back onBack={onBack} />
    </>}>
      {error ? <p className="err">The library could not be read: {error}</p> : !catalog ? <p className="muted">reading the library…</p> : (
        <div className="lib-body">
          <nav className="lib-nav" aria-label="Library lists">
            <p className="lib-label">by what it does</p>
            {catalog.groups.map((group) => (
              <button key={group.group} type="button" className="lib-pick" aria-current={!search && view.group === group.group ? "true" : undefined} onClick={() => pick({ group: group.group })}>{group.label}</button>
            ))}
            <p className="lib-label">by kind</p>
            {catalog.kinds.map((kind) => (
              <button key={kind.kind} type="button" className="lib-pick" aria-current={!search && view.kind === kind.kind ? "true" : undefined} onClick={() => pick({ kind: kind.kind })}>
                <span>{kind.label}</span><span className="lib-count">{kind.count}</span>
              </button>
            ))}
          </nav>
          <div className="lib-main">
            <p className="lib-heading"><b>{heading[0]}</b> <span>{heading[1]}</span></p>
            {entries.length ? (
              <ul className="lib-grid">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className={`lib-card${open?.id === entry.id ? " open" : ""}`} aria-pressed={open?.id === entry.id} onClick={() => setOpenId(entry.id)}>
                      <span className="lib-thumb"><Still entry={entry} />{used.has(entry.id) ? <span className="lib-badge">in this video</span> : null}</span>
                      <span className="lib-card-name">{entry.words}{view.kind && !search.trim() ? null : <span className="lib-kind"> {KIND_LABEL[entry.kind]}</span>}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{onlyUsed ? "Nothing here is in this video yet." : "Nothing matches."}</p>}
          </div>
          {open ? <Detail key={open.id} entry={open} used={used.has(open.id)} shots={shots} onAsk={(entry, shot) => setAsks((value) => withAsk(value, entry, shot))} /> : null}
        </div>
      )}
      {asks.length ? (
        <form className="lib-tray" onSubmit={(event) => { event.preventDefault(); if (!sending) send(); }}>
          <span className="lib-tray-label">your note to the agent</span>
          {asks.map((ask) => (
            <span key={ask.id} className="lib-chip">{askChip(ask)}
              <button type="button" className="tb" aria-label={`remove ${ask.words}`} onClick={() => setAsks((value) => value.filter((item) => item.id !== ask.id))}>×</button>
            </span>
          ))}
          <input className="lib-words" aria-label="add words" placeholder="add words (optional)" value={words} onChange={(event) => setWords(event.target.value)} />
          <button type="submit" className="tb tb-box tb-accent" disabled={sending}>send to the agent</button>
        </form>
      ) : null}
    </Screen>
  );
}
