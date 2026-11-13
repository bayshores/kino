// The library screen: everything an agent can use (moves, effects, animations, layer styles, recipes, looks,
// video formats), by what it does (the technique groups) or by kind. At the top the search and the
// lists; under them the open entry, playing its sample on a loop beside what it is, when it fits and
// where this video uses it; under that a still of every entry in the list. "Ask for this" adds the
// open entry (on a storyboard shot, or anywhere) to a note along the bottom, which goes to the agent
// as one note.
//
// Data flow: GET /api/dashboard/library (backend/agent/library-catalog.mjs) → the lists; GET
// library-still → each card's picture; library-sample?kind&name → the open entry's document, played by
// ScenePreview. The note is notes {action:"add"} (Dashboard.jsx sendNote).
import React, { useEffect, useMemo, useState } from "react";
import { ScenePreview } from "../components/ScenePreview.jsx";
import { loadBrowserFonts } from "../browserFonts.js";
import { libraryCatalog, librarySample, libraryStillUrl } from "./api.js";
import { askNote, shotWords, shotsUsing, shownEntries, usedIn, withAsk } from "./libraryRows.js";
import { Screen } from "./screens.jsx";
import { Btn, Icon } from "./controls.jsx";
import "./library.css";

// In a group or a search, each card says its kind (a move and an effect can share a name).
const KIND_LABEL = { move: "move", effect: "effect", animation: "animation", style: "layer style", recipe: "recipe", look: "look", format: "format", technique: "plain edit" };

// "zoom through" → "Zoom through": the words the page shows start with a capital.
const sentence = (text) => (typeof text === "string" && text ? text[0].toUpperCase() + text.slice(1) : text ?? "");

// Samples are the same for every project: fetched once a session, with their fonts loaded so
// the text draws (as the stage loads a project's).
const samples = new Map();
function sampleOf(entry) {
  if (!samples.has(entry.id)) samples.set(entry.id, librarySample(entry.kind, entry.name)
    .then(async (sample) => {
      if (sample.document) await Promise.all([loadBrowserFonts(sample.document).catch(() => {}), loadPictures(sample.document)]);
      return sample;
    })
    .catch(() => ({ document: null })));
  return samples.get(entry.id);
}
// The sample's pictures, loaded and decoded before it plays, so its first frames are not empty.
function loadPictures(document) {
  const sources = new Set((document.scenes?.[0]?.layers ?? []).filter((layer) => layer.type === "image" && layer.src).map((layer) => layer.src));
  return Promise.all([...sources].map((src) => { const image = new Image(); image.src = src; return image.decode().catch(() => {}); }));
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
    return <span className="lib-none">{entry.kind === "format" ? "A whole video" : "No sample"}</span>;
  return <img className="lib-img" src={libraryStillUrl(entry.kind, entry.name)} alt="" loading="lazy" onError={() => setMissing(true)} />;
}

// The open entry's sample (`sample`, null while it loads), playing on a loop until pause.
function Player({ entry, sample }) {
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const scene = sample?.document?.scenes?.[0];
  // It loops the stretch where the entry acts (sample.loop), not the whole sample.
  const [from, to] = sample?.loop ?? [0, Number(scene?.duration) || 1];
  const length = Math.max(0.1, to - from);
  useEffect(() => {
    if (!scene || !playing) return undefined;
    let frame = 0;
    const start = performance.now() - Math.max(0, time - from) * 1000;
    const step = (now) => { setTime(from + (((now - start) / 1000) % length)); frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [scene, playing, from, length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTime(sample?.loop?.[0] ?? 0); setPlaying(true); }, [entry.id, sample]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="lib-player">
      <div className="lib-stage">
        {/* The card's still sits under the preview, so the box is never black while its pictures load. */}
        {entry.kind !== "format" && (scene || !sample) ? <img className="lib-under" src={libraryStillUrl(entry.kind, entry.name)} alt="" /> : null}
        {scene ? <ScenePreview document={sample.document} scene={scene} time={time} design={false} playing={playing} fontVersion={0} audio="external" skipPrewarm />
          : <span className="lib-none">{sample ? (entry.kind === "format" ? "A whole video, made from your own material: no preview here. Ask for it to see it on yours" : "No sample") : ""}</span>}
      </div>
      {scene ? (
        <div className="lib-controls">
          <button type="button" className="lib-play" aria-label={playing ? "pause" : "play"} onClick={() => setPlaying((value) => !value)}>
            {playing ? <Icon name="hold" /> : <svg className="ui-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 3.5v9l7-4.5z" /></svg>}
          </button>
          <span className="lib-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, (time - from) / length) * 100)}%` }} /></span>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ entry, used, shots, onAsk }) {
  const [shot, setShot] = useState("");
  const sample = useSample(entry);
  const inShots = shotsUsing(entry, shots);
  const acts = sample?.loop ? Math.max(0, sample.loop[1] - sample.loop[0]) : null;
  return (
    <section className="lib-detail" aria-label={entry.words}>
      <Player entry={entry} sample={sample} />
      <div className="lib-info">
        <h3 className="lib-name">{sentence(entry.words)}</h3>
        <p className="lib-line">{sentence(entry.line)}</p>
        <p className="lib-meta">
          {acts ? <span title="how long it acts in the sample"><Icon name="timer" /><span className="lib-mono">{acts.toFixed(1)} s</span></span> : null}
          <span><Icon name="screen" />{sentence(KIND_LABEL[entry.kind] ?? entry.kind)}</span>
          {used ? <span className="lib-used"><Icon name="check" />In this video{inShots.length ? `: ${shotWords(inShots)}` : ""}</span> : null}
        </p>
        {entry.fits ? <p className="lib-fits"><span className="lib-fits-word">Fits</span> {entry.fits}</p> : null}
        <div className="lib-ask">
          <Btn kind="primary" icon="comment" onClick={() => onAsk(entry, shot ? Number(shot) : null)}>Ask for this</Btn>
          {shots.length ? (
            <span className="lib-drop">
              <select aria-label="on which shot" value={shot} onChange={(event) => setShot(event.target.value)}>
                <option value="">Anywhere</option>
                {shots.map((_, index) => <option key={index} value={index + 1}>On shot {index + 1}</option>)}
              </select>
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function LibraryScreen({ document, shots = [], onSend }) {
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
  const searching = Boolean(search.trim());
  const entries = shownEntries(catalog, { ...(searching ? {} : view), search, onlyUsed, used });
  const open = entries.find((entry) => entry.id === openId) ?? entries[0] ?? null;
  const send = async () => {
    setSending(true);
    try { await onSend(askNote(asks, words)); setAsks([]); setWords(""); } finally { setSending(false); }
  };
  const pick = (next) => { setView(next); setSearch(""); setOpenId(null); };
  return (
    <Screen title="library" className="library-screen">
      <div className="lib-top">
        <label className="ui-field lib-field">
          <Icon name="search" />
          <input className="lib-search" type="search" placeholder="Search moves, effects, looks" aria-label="search the library" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        {searching && catalog ? <span className="lib-found" role="status">{entries.length} found</span> : null}
        <span className="lib-scope" role="group" aria-label="show">
          <button type="button" aria-pressed={!onlyUsed} onClick={() => setOnlyUsed(false)}>All <span className="lib-n">{catalog?.total ?? ""}</span></button>
          <button type="button" aria-pressed={onlyUsed} onClick={() => setOnlyUsed(true)}>In this video <span className="lib-n">{used.size}</span></button>
        </span>
      </div>
      {error ? <p className="err">The library could not be read: {error}</p> : !catalog ? <p className="muted">Reading the library…</p> : (
        <>
          <nav className="lib-nav" aria-label="Library lists">
            <span className="lib-tabs" role="group" aria-label="By what it does">
              {catalog.groups.map((group) => (
                <button key={group.group} type="button" className="lib-pick" title={group.line || undefined} aria-current={!searching && view.group === group.group ? "true" : undefined}
                  onClick={() => pick({ group: group.group })}>{sentence(group.label)}</button>
              ))}
            </span>
            <span className="lib-tabs lib-kinds" role="group" aria-label="By kind">
              {catalog.kinds.map((kind) => (
                <button key={kind.kind} type="button" className="lib-pick" aria-current={!searching && view.kind === kind.kind ? "true" : undefined} onClick={() => pick({ kind: kind.kind })}>
                  <span>{sentence(kind.label)}</span><span className="lib-count">{kind.count}</span>
                </button>
              ))}
            </span>
          </nav>
          {open ? <Detail key={open.id} entry={open} used={used.has(open.id)} shots={shots} onAsk={(entry, shot) => setAsks((value) => withAsk(value, entry, shot))} /> : null}
          {entries.length ? (
            <ul className="lib-grid" aria-label="Entries">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className={`lib-card${open?.id === entry.id ? " open" : ""}`} aria-pressed={open?.id === entry.id} onClick={() => setOpenId(entry.id)}>
                    <span className="lib-thumb"><Still entry={entry} />{used.has(entry.id) ? <span className="lib-badge" title="in this video"><Icon name="check" /><span className="sr-only">in this video</span></span> : null}</span>
                    <span className="lib-card-name">{sentence(entry.words)}{view.kind && !searching ? null : <span className="lib-kind"> {KIND_LABEL[entry.kind]}</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted lib-empty">{onlyUsed ? "Nothing here is in this video yet." : "Nothing matches."}</p>}
        </>
      )}
      {asks.length ? (
        <form className="lib-tray" aria-label="Your note to the agent" onSubmit={(event) => { event.preventDefault(); if (!sending) send(); }}>
          <Icon name="comment" />
          {asks.map((ask) => (
            <span key={ask.id} className="lib-chip">{ask.words}{ask.shot ? <span className="lib-chip-shot">shot {ask.shot}</span> : null}
              <button type="button" aria-label={`remove ${ask.words}`} onClick={() => setAsks((value) => value.filter((item) => item.id !== ask.id))}><Icon name="x" /></button>
            </span>
          ))}
          <input className="lib-words" aria-label="add words" placeholder="Add words" value={words} onChange={(event) => setWords(event.target.value)} />
          <Btn type="submit" kind="primary" disabled={sending}>Send to the agent</Btn>
        </form>
      ) : null}
    </Screen>
  );
}
