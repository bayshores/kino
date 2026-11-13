// The F1 timeline's lanes between the story row and the layers (TimelinePane in panes.jsx draws
// the pane, the ruler and the layer rows): shots, voice, a few other sounds, music, and a lane per
// agent. Each lane is a label cell and a track cell in the timeline's grid. The agents' lanes are
// pinned: when the layers scroll they stay in view (under the ruler, or at the bottom of the
// pane when the lanes above them are taller than the pane). The facts are plain
// functions in lanes.js; the data comes from GET /dashboard/lanes (shots and spoken sentences),
// the export renderer's frames (thumbnails, cached by the server and, per revision, the browser)
// and the media's peaks (waveforms).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { frameUrl, mediaPeaks, sceneLanes } from "./api.js";
import { serverNow } from "./presence.js";
import { nowBlock, renderAgent, runningRender } from "./topbar.js";
import { agentLanes, captionBlocks, knownAgents, mediaId, mixBars, shotTiles, soundRows, spaced } from "./lanes.js";
import { spanText } from "./timeline.js";
import { HoverCard } from "./timeline.jsx";
import { thumbnails } from "./thumbnails.js";
import { noteNumber } from "./noteSpot.js";

// The lanes' heights in px (the grid's rows; TimelinePane adds them up).
export const LANE_PX = { shots: 44, voice: 16, audio: 16, agent: 22, you: 22 };
// As the strip under the stage (TimelinePane's `strip`): the shots, the music's wave and, in no
// room of its own, a bar under the shots an agent works on; the other lanes take no room.
export const STRIP_PX = { shots: 58, voice: 0, audio: 0, music: 20, agent: 0, you: 0 };

/** The server's shots and spoken sentences of a scene, read again for each new revision. */
export function useSceneLanes(projectId, sceneId, rev) {
  const [value, setValue] = useState(null);
  useEffect(() => {
    if (!projectId || !sceneId) { setValue(null); return undefined; }
    let active = true;
    sceneLanes(projectId, sceneId).then((lanes) => { if (active) setValue(lanes); }).catch(() => { if (active) setValue((old) => (old?.sceneId === sceneId ? old : null)); });
    return () => { active = false; };
  }, [projectId, sceneId, rev]);
  return value?.sceneId === sceneId ? value : null;
}

// Peaks already read, by media id (a file's peaks never change).
const peakCache = new Map();
function usePeaks(ids) {
  const [, setCount] = useState(0);
  const key = ids.join(",");
  useEffect(() => {
    let active = true;
    for (const id of ids) {
      if (peakCache.has(id)) continue;
      peakCache.set(id, null);
      mediaPeaks(id).then((peaks) => { peakCache.set(id, peaks); if (active) setCount((count) => count + 1); }).catch(() => {});
    }
    return () => { active = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (id) => peakCache.get(id) ?? null;
}

/**
 * Which lanes there are, and their data, for TimelinePane: {rows: [{kind, id, height}], ...}.
 * Kept in one place so the pane can size its grid before it draws the lanes.
 */
export function useLanes({ data, scene, duration, entries, spanOf, strip = false }) {
  const lanes = useSceneLanes(data.projectId, scene?.id, data.record?.revision);
  const groups = useMemo(() => soundRows(scene, { spoken: Array.isArray(lanes?.voice) ? lanes.voice : [], captions: captionBlocks(scene) }), [lanes, scene]);
  const voice = groups.voice?.blocks ?? [];
  const sounds = [...groups.others, ...(groups.music ? [groups.music] : [])];
  const present = Object.values(data.live?.latest ?? {}).filter((presence) => presence.projectId === undefined || presence.projectId === data.projectId).map((presence) => presence.agent);
  const known = knownAgents(data);
  const agents = agentLanes(entries, known, spanOf, { present: present.filter((agent) => (data.agents ?? []).some((row) => row.id === agent.id)) })
    .map((lane) => ({ ...lane, agent: known.find((row) => row.id === lane.agent.id) ?? lane.agent }));
  // Your notes with a time in this scene: the "you" lane, a numbered dot each.
  const notes = (data.agent?.notes ?? []).filter((note) => note.time != null && (!note.sceneId || note.sceneId === scene?.id));
  const px = strip ? STRIP_PX : LANE_PX;
  const rows = [
    { kind: "shots", id: "shots", height: px.shots },
    ...(voice.length ? [{ kind: "voice", id: "voice", height: px.voice }] : []),
    ...sounds.map((sound) => ({ kind: "audio", id: sound.id, height: strip && sound === groups.music ? px.music : px.audio })),
    ...(notes.length ? [{ kind: "you", id: "you", height: px.you }] : []),
    ...agents.map((lane) => ({ kind: "agent", id: lane.agent.id, height: px.agent })),
  ];
  return { rows, strip, shots: lanes?.shots ?? null, voice, voiceNames: groups.voice?.names ?? [], sounds, agents, notes, duration };
}

/**
 * One thumbnail of the shots lane: the frame at the tile's middle, as the export renders it. It
 * shows once the thumbnail queue (thumbnails.js) has loaded it: after the stage's own picture.
 */
function ShotTile({ tile, src, ready, percent, onSeek, duration }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="shot-tile" role="listitem" style={{ left: percent(tile.start), width: `calc(${percent(tile.end)} - ${percent(tile.start)})` }}
      title={`shot ${tile.shot} · ${spanText([tile.start, tile.end], duration)}`} onClick={(event) => { event.stopPropagation(); onSeek(tile.time); }}>
      {failed || !ready ? null : <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />}
    </span>
  );
}

/** The thumbnails of `urls` that have loaded, asked for in this order (thumbnails.js). */
function useThumbnails(urls) {
  const [, setCount] = useState(0);
  const key = urls.join("\n");
  useEffect(() => thumbnails.subscribe(() => setCount((count) => count + 1)), []);
  useEffect(() => { thumbnails.want(urls); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => thumbnails.want([]), []);
  return (url) => thumbnails.has(url);
}

/** A sound lane's waveform: thin bars where the layer plays. */
function Wave({ bars }) {
  return (
    <span className="wave" aria-hidden="true">
      {bars.map((height, index) => <span key={index} className="wave-bar" style={{ left: `${(index / bars.length) * 100}%`, height: `${Math.max(height > 0 ? 12 : 0, Math.round(height * 100))}%` }} />)}
    </span>
  );
}

/**
 * The lanes: label and track cells for each row of `model` (useLanes). `percent(seconds)` places
 * a time on the track; `trackWidth` is the track in px; `onSeek`, `onTurn` and `viewTurn` as in
 * TimelinePane; `last` the timeline's who-changed-it-last ({layerId: {who, at, turn}}).
 */
export function TimelineLanes({ model, data, scene, percent, trackWidth, onSeek, onTurn, viewTurn, last, still, now, pinTop = 0 }) {
  const { rows, strip = false, shots, voice, voiceNames = [], sounds, agents, notes = [], duration } = model;
  const shotsHeight = rows.find((row) => row.kind === "shots")?.height ?? LANE_PX.shots;
  // In the strip a lane without room is not drawn (its cells stay, so the grid keeps its rows),
  // and an agent's bar sits right under the shots: above its own row by the lanes between them.
  const off = (row) => (strip && !row.height && row.kind !== "agent" ? " lane-off" : "");
  const underShots = rows.slice(1).filter((row) => row.kind !== "agent").reduce((sum, row) => sum + row.height, 0);
  const peaksOf = usePeaks(sounds.flatMap((group) => group.sounds).map((sound) => mediaId(sound.src)).filter(Boolean));
  const peakOf = (sound) => { const id = mediaId(sound.src); return id ? peaksOf(id) : null; };
  // The agents' lanes, pinned in this order: each one's place from the top (under the ruler) and
  // from the bottom of the lanes box.
  const agentRows = rows.filter((row) => row.kind === "agent");
  const pinOf = (id) => {
    const at = agentRows.findIndex((row) => row.id === id);
    return { top: pinTop + agentRows.slice(0, at).reduce((sum, row) => sum + row.height, 0), bottom: agentRows.slice(at + 1).reduce((sum, row) => sum + row.height, 0) };
  };
  // A cut line per shot change, at least 4 px apart (a fast edit would draw a solid bar).
  const cuts = spaced((shots ?? []).slice(1).map((shot) => shot.start), { duration, width: trackWidth || 800, gap: 4 });
  const aspect = scene ? scene.width / scene.height : 16 / 9;
  const tiles = shotTiles(shots, { duration, width: trackWidth || 800, height: strip ? shotsHeight : shotsHeight - 4, aspect });
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const tileWidth = tiles.length ? ((tiles[0].end - tiles[0].start) / duration) * (trackWidth || 800) : 64;
  const frameWidth = Math.max(64, Math.min(320, Math.ceil((tileWidth * ratio) / 32) * 32));
  const rev = data.record?.revision;
  // Each thumbnail's address (low: the server draws it after the stage's frames), loaded in order.
  const tileUrls = scene && data.projectId ? tiles.map((tile) => frameUrl({ projectId: data.projectId, sceneId: scene.id, time: tile.time, width: frameWidth, rev, low: true })) : [];
  const loadedTile = useThumbnails(tileUrls);
  const seek = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  };
  // The voice lane: ← and → move between sentences, and the hover card says the one picked.
  const [picked, setPicked] = useState(null);
  const [card, setCard] = useState(null);
  const voiceRef = useRef(null);
  const showSentence = (index, place) => {
    const block = voice[index];
    if (!block) { setCard(null); return; }
    const change = last?.[block.layerId];
    const who = change?.who ? `${change.who} changed it ${agoShort(change.at, now)}` : null;
    setCard({ lines: [`${block.name}  ${spanText([block.start, block.end], duration)}`, ...(block.text ? [`“${block.text}”`] : []), ...(who ? [who] : [])], place });
  };
  const placeOf = (index) => {
    const lane = voiceRef.current?.getBoundingClientRect();
    const block = voice[index];
    return lane && block ? { x: lane.left + (block.start / duration) * lane.width, y: lane.top } : { x: 0, y: 0 };
  };
  const bars = Math.max(20, Math.min(600, Math.round((trackWidth || 800) / 4)));
  const rendering = runningRender(data);
  const renderBy = rendering ? renderAgent(data, rendering) : null;
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "shots") return (
          <React.Fragment key="shots">
            <span className="tl-label lane-label" style={{ height: row.height }}>shots</span>
            <div className="track lane-shots" style={{ height: row.height }} role="list" aria-label={`Shots: ${shots ? shots.length : "…"}`} onClick={seek}>
              {tileUrls.length ? tiles.map((tile, index) => (
                <ShotTile key={`${index}/${tile.time}`} tile={tile} percent={percent} onSeek={onSeek} duration={duration}
                  src={tileUrls[index]} ready={loadedTile(tileUrls[index])} />
              )) : null}
              {cuts.map((start) => <span key={`cut${start}`} className="shot-cut" style={{ left: percent(start) }} aria-hidden="true" />)}
            </div>
          </React.Fragment>
        );
        if (row.kind === "voice") return (
          <React.Fragment key="voice">
            <span className={`tl-label lane-label${off(row)}`} style={{ height: row.height }} title={voiceNames.join(", ")}>voice</span>
            <div ref={voiceRef} className={`track lane-voice${off(row)}`} style={{ height: row.height }} role="listbox" tabIndex={0}
              aria-label={voice.some((block) => block.text) ? `Spoken sentences, ${voice.length}: ← and → read them` : `Voice clips, ${voice.length}: ← and → go through them`} aria-activedescendant={picked !== null ? `voice-${picked}` : undefined}
              onClick={seek} onPointerLeave={() => setCard(null)} onBlur={() => setCard(null)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault(); event.stopPropagation();
                const next = Math.max(0, Math.min(voice.length - 1, picked === null ? 0 : picked + (event.key === "ArrowRight" ? 1 : -1)));
                setPicked(next);
                showSentence(next, placeOf(next));
              }}>
              {voice.map((block, index) => (
                <span key={`${index}/${block.start}`} id={`voice-${index}`} role="option" aria-selected={picked === index} className={`voice-block${picked === index ? " picked" : ""}`}
                  aria-label={`${block.name} ${spanText([block.start, block.end], duration)}${block.text ? `: ${block.text}` : ""}`}
                  style={{ left: percent(block.start), width: `calc(${percent(block.end)} - ${percent(block.start)})` }}
                  onPointerMove={(event) => showSentence(index, { x: event.clientX, y: event.currentTarget.getBoundingClientRect().top })} />
              ))}
            </div>
          </React.Fragment>
        );
        if (row.kind === "audio") {
          // One sound, or several as one lane (the music, or "audio" for many other sounds).
          const group = sounds.find((entry) => entry.id === row.id);
          const names = group.sounds.map((sound) => sound.name);
          return (
            <React.Fragment key={`a${row.id}`}>
              <span className={`tl-label lane-label${off(row)}`} style={{ height: row.height }} title={names.join(", ")}>{cutName(group.name)}</span>
              <div className={`track lane-audio${off(row)}`} style={{ height: row.height }} onClick={seek} role="img"
                aria-label={`${group.name}: ${group.sounds.map((sound) => `${group.sounds.length > 1 || sound.name !== group.name ? `${sound.name} ` : ""}plays ${spanText([sound.start, sound.end], duration)}`).join("; ")}`}>
                {group.sounds.map((sound) => <span key={sound.id} className="audio-span" style={{ left: percent(sound.start), width: `calc(${percent(sound.end)} - ${percent(sound.start)})` }} />)}
                <Wave bars={mixBars(group.sounds, peakOf, { duration, count: bars })} />
              </div>
            </React.Fragment>
          );
        }
        if (row.kind === "you") return (
          <React.Fragment key="you">
            <span className={`tl-label lane-label you-lane-label${off(row)}`} style={{ height: row.height }}><span className="you-square" aria-hidden="true" />you</span>
            <div className={`track lane-you${off(row)}`} style={{ height: row.height }} role="group" aria-label={`Your notes: ${notes.length}`} onClick={seek}>
              {notes.map((note) => (
                <button key={note.id} type="button" className={`tb note-dot${note.status === "resolved" ? " done" : ""}`} style={{ left: percent(note.time) }}
                  title={note.text} aria-label={`${note.id}${note.status === "resolved" ? ", done" : ""}, at ${spanText([note.time, note.time], duration)}: ${note.text}. Go to it.`}
                  onClick={(event) => { event.stopPropagation(); onSeek(note.time); }}>{noteNumber(note.id)}</button>
              ))}
            </div>
          </React.Fragment>
        );
        const lane = agents.find((entry) => entry.agent.id === row.id);
        const { agent } = lane;
        const first = lane.marks.length ? Math.min(...lane.marks.map((mark) => mark.at)) : null;
        const lastMark = lane.marks.length ? Math.max(...lane.marks.map((mark) => mark.at)) : null;
        const seenTurns = new Set();
        const pin = pinOf(row.id);
        // What it works on now (a labeled block in its color) and the render it asked for (a bar).
        const block = scene ? nowBlock(data.live?.latest?.[agent.id], scene.id, serverNow(data.live, now)) : null;
        const render = rendering && renderBy?.id === agent.id ? rendering : null;
        const renderShare = render ? Math.max(0, Math.min(1, render.progress ?? 0)) : 0;
        return (
          <React.Fragment key={`g${row.id}`}>
            <span className="tl-label lane-label agent-lane-label pinned" style={{ height: row.height, color: agent.color ?? undefined, top: pin.top, bottom: pin.bottom }}>
              <span className="lane-dot" aria-hidden="true" style={{ background: agent.color ?? undefined }} /><span className="lane-name">{agent.name}</span>
            </span>
            <div className="track lane-agent pinned" style={{ height: row.height, "--who": agent.color ?? undefined, "--under-shots": `${underShots}px`, top: pin.top, bottom: pin.bottom }} role="group" aria-label={`${agent.name}'s edits`} onClick={seek}>
              {first !== null ? <span className="agent-line" style={{ left: percent(first), width: `calc(${percent(lastMark)} - ${percent(first)})` }} aria-hidden="true" /> : null}
              {render ? (
                <span className="lane-render" aria-label={`${agent.name} renders ${render.id ?? ""}: ${Math.round(renderShare * 100)}%`} role="img">
                  <span className="lane-render-done" style={{ width: `${renderShare * 100}%` }} />
                  <span className="lane-render-text" style={{ left: `${renderShare * 100}%` }}>{`${render.id ?? "render"} · ${Math.round(renderShare * 100)}%`}</span>
                </span>
              ) : null}
              {lane.marks.map((mark, index) => {
                const firstOfTurn = !seenTurns.has(mark.turn);
                seenTurns.add(mark.turn);
                return (
                  <button key={`${mark.turn}/${index}`} type="button" className={`tb agent-mark${viewTurn === mark.turn ? " current" : ""}`} tabIndex={firstOfTurn ? 0 : -1}
                    style={{ left: percent(mark.at) }} aria-pressed={viewTurn === mark.turn} title={`${mark.turn} · ${spanText([mark.at, mark.end], duration)}`}
                    aria-label={`${mark.turn}: ${agent.name} changed the scene at ${spanText([mark.at, mark.end], duration)}. Show this checkpoint.`}
                    onClick={(event) => { event.stopPropagation(); onTurn(mark.turn); }} />
                );
              })}
              {block ? (
                <span className="lane-now" style={{ left: percent(block.start), width: `calc(${percent(Math.min(duration, block.end))} - ${percent(block.start)})` }}
                  title={`${agent.name} · ${block.label} · ${spanText([block.start, block.end], duration)}`} aria-label={`${agent.name} works on ${spanText([block.start, block.end], duration)} now`} role="img">
                  <span className="lane-now-text">{block.label ? `${block.label} · now` : "now"}</span>
                </span>
              ) : null}
            </div>
          </React.Fragment>
        );
      })}
      {card ? <HoverCard id="voice-card" lines={card.lines} place={card.place} still={still} /> : null}
    </>
  );
}

const cutName = (name) => (String(name).length > 12 ? `${String(name).slice(0, 11)}…` : String(name));

function agoShort(iso, now) {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}
