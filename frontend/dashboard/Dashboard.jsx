// The dashboard (plan §5): what the agent is doing and making, live. It reads one snapshot,
// then applies the event stream. People answer approvals and stops, hold agent writes, undo
// turns, leave notes, change settings and export here; they do not edit by hand.
//
// Data flow: api.snapshot() → state.fromSnapshot → stream events → state.applyEvent → panes.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./dashboard.css";
import * as server from "./api.js";
import { accessHeaders } from "../client.js";
import { createPictureClock, createPlaybackClock, createTimeStore, decodeSound, frameStart } from "./playbackClock.js";
import { useReactions } from "./useReactions.js";
import { createMediaKeys } from "./mediaKeys.js";
import { loadBrowserFonts } from "../browserFonts.js";
import { defaultFonts } from "../../engine/fonts.js";
import { documentFontReferences } from "../../engine/fontDocuments.js";
import { fontGlyphReferences } from "../../engine/fontGlyphReferences.js";
import { desktopServiceLine, openStream } from "./stream.js";
import { tickWhileShown } from "./visibleClock.js";
import { applyEvent, openTryOf, attention, backgroundCheckInput, briefRows, fromSnapshot, keyTarget, movedNeedWords, needKey, needsShift, needsYouRows, noteRows, otherStops, pendingApprovals, pointRange, quietToTell, recommendedOption, seenImages, stopAnswer, stopAnswered, stopChanges, stopRows, timelineRows, turnChips, turnRows, variantChoices, videoLayers, waitingStopOf, withRecord } from "./state.js";
import { isTyping, keyAction } from "./keys.js";

// Whether the stage draws its outlines: the check's boxes (findings) and the agents' marks
// (building marks, change flashes, what a call is on). Both are on until the person turns them off.
const OUTLINES_KEY = "kino.dashboard.outlines";
function readOutlines() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OUTLINES_KEY) ?? "null"); } catch { /* not kept */ }
  return { findings: saved?.findings !== false, marks: saved?.marks !== false };
}
function keepOutlines({ findings, marks }) {
  try { localStorage.setItem(OUTLINES_KEY, JSON.stringify({ findings, marks })); } catch { /* not kept: still works */ }
}
import { listenForEditCommands } from "../desktopEdit.js";
import { askForNotifications, notify, showCount } from "./notify.js";
import { clock, cut } from "./format.js";
import { Icon, KeyLine, LogPane, lookMoment, Menu, SeenPane, SessionPane, StagePane, StatusLine, TimelinePane, useSections } from "./panes.jsx";
import { agentChips, idleLine, renderAgent, runningRender } from "./topbar.js";
import { usePreviewList } from "./previewCache.jsx";
import { AgentPane } from "./agentPane.jsx";
import { agentOfCalls, needWords, shownAgent } from "./agentView.js";
import { noteCursorRows, noteGroups, noteReader, readerLine } from "./noteSpot.js";
import { Bot } from "./bot.jsx";
import { markTimelineSeen } from "./timeline.jsx";
import { PresenceAnnouncer } from "./presence.jsx";
import { followStart, newestPresence, serverNow } from "./presence.js";
import { BriefCard } from "./brief.jsx";
import { ApprovalCard, ApprovalScreen, CommandLine, ConfirmBox, HelpScreen, ProjectsScreen, SharesScreen, TranscriptScreen, TurnScreen, VariantsScreen } from "./screens.jsx";
import { SettingsScreen } from "./settings.jsx";
import { StopCard, StopDone, StopElsewhere, StopScreen, StopsCard, StopSettings } from "./stops.jsx";
import { BoardScreen } from "./board.jsx";
import { directionWords } from "./boardRows.js";
import { TryScreen } from "./tries.jsx";
import { LibraryScreen } from "./library.jsx";
import { CrewScreen } from "./crew.jsx";
import { InspireScreen } from "./inspire.jsx";
import { JudgeBox } from "./judge.jsx";
import { PickBox } from "./picks.jsx";
import { STOP_WORDS } from "./words.js";
import { needsBar } from "./needsBar.js";

// A screen recording's running time: 75 000 ms → "1:15".
const recClock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const EVENTS_BUFFERED = 300;
const CHECK_DELAY_MS = 1200;
// How often the dashboard looks for an agent that went quiet (when that notification is on).
const QUIET_CHECK_MS = 5000;
const PHONE_QUERY = "(max-width: 719px)";
const STILL_QUERY = "(prefers-reduced-motion: reduce)";

function useMedia(query) {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const list = matchMedia(query);
    const change = () => setMatches(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => tickWhileShown(() => setNow(Date.now()), ms), [ms]);
  return now;
}

// Calls `step` once a display frame while it runs, with the display frame's time (ms). A window
// that is not drawn (hidden, or in the background) gets no animation frames, so a timer keeps the
// time moving there too.
function everyFrame(step) {
  let frame = 0, timer = 0, stopped = false;
  const tick = (frameMs) => {
    if (stopped) return;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    step(typeof frameMs === "number" ? frameMs : performance.now());
    frame = requestAnimationFrame(tick);
    timer = setTimeout(tick, 100);
  };
  tick();
  return () => { stopped = true; cancelAnimationFrame(frame); clearTimeout(timer); };
}

// How long after a change the stage asks for the scene's sound mix: soon while playing, so an
// agent's edit is heard quickly, and later while paused, so a burst of edits makes one mix.
const MIX_DELAY_PLAYING_MS = 150;
const MIX_DELAY_PAUSED_MS = 600;

const SOUND_BLOCKED = "No sound yet: the browser has not let the sound start. Click “turn sound on” (or anywhere on the page); the picture keeps playing without sound.";
// A and D on a stop: a stop is set to allow in settings, never by a key.
const STOP_ALWAYS_OFF = "A and D are off on stops: a stop is set to allow only in settings › stops.";

function readDraft(projectId) {
  try { return JSON.parse(localStorage.getItem(`kino.dashboard.note.${projectId}`) ?? "null"); } catch { return null; }
}
function saveDraft(projectId, draft) {
  try {
    if (draft) localStorage.setItem(`kino.dashboard.note.${projectId}`, JSON.stringify(draft));
    else localStorage.removeItem(`kino.dashboard.note.${projectId}`);
  } catch { /* drafts are a convenience */ }
}

/** The snapshot plus the live stream. Returns the data and how to reload it. */
function useDashboardData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState({ state: "connecting", text: "connecting…" });
  const position = useRef({ seq: 0, boot: null });
  const buffer = useRef([]);
  const loading = useRef(null);
  const projectRef = useRef(null);
  const dropped = useRef(false);
  const serviceStopped = useRef(false);
  const statusTimer = useRef(null);
  const reloadTimer = useRef(null);

  const load = useCallback(async (projectId = projectRef.current) => {
    const ticket = {};
    loading.current = ticket;
    try {
      const value = await server.snapshot(projectId);
      if (loading.current !== ticket) return;
      position.current = { seq: value.seq, boot: value.boot };
      projectRef.current = value.projectId;
      setData((previous) => {
        // Events that arrived while the snapshot was on its way still count.
        let next = fromSnapshot(value, previous);
        for (const event of buffer.current) next = applyEvent(next, event);
        return next;
      });
      setError("");
    } catch (cause) {
      if (loading.current === ticket) setError(cause.message);
    }
  }, []);

  const showStatus = useCallback((state, text, settle) => {
    clearTimeout(statusTimer.current);
    setConnection({ state, text });
    if (settle) statusTimer.current = setTimeout(() => setConnection({ state: "live", text: "live" }), 8000);
  }, []);

  useEffect(() => {
    let stop = () => {};
    let active = true;
    (async () => {
      try { await server.startSession(); } catch (cause) { setError(cause.message); }
      if (!active) return;
      await load(null);
      if (!active) return;
      stop = openStream({
        position: () => position.current,
        onEvent(event) {
          if (Number.isSafeInteger(event.seq) && event.seq > position.current.seq) position.current = { ...position.current, seq: event.seq };
          buffer.current.push(event);
          if (buffer.current.length > EVENTS_BUFFERED) buffer.current.shift();
          if (event.type === "projects" || event.type === "lifecycle") {
            clearTimeout(reloadTimer.current);
            reloadTimer.current = setTimeout(() => load(), 300);
          }
          setData((state) => (state ? applyEvent(state, event) : state));
        },
        onResync() {
          buffer.current = [];
          load().then(() => { if (dropped.current) showStatus("live", "reconnected · re-read everything", true); dropped.current = false; });
        },
        onStatus(status) {
          if (status.state === "reconnecting") {
            dropped.current = true;
            // While the Mac app says its service stopped, that message stays on the line.
            if (!serviceStopped.current) showStatus("reconnecting", "reconnecting…");
            return;
          }
          if (status.replayed !== undefined && dropped.current) { dropped.current = false; showStatus("live", `reconnected · replayed ${status.replayed} events`, true); return; }
          if (!dropped.current) showStatus("live", "live");
        },
      });
    })();
    return () => { active = false; stop(); clearTimeout(statusTimer.current); clearTimeout(reloadTimer.current); };
  }, [load, showStatus]);

  // In the Mac app, the app itself reports its local service. When it gave up restarting it, say so
  // and how to restart it; once it is back, the stream reconnects and reports that as usual.
  useEffect(() => {
    let unsubscribe;
    try {
      unsubscribe = globalThis.kinoDesktop?.onServiceStatus?.((status) => {
        const line = desktopServiceLine(status);
        const wasStopped = serviceStopped.current;
        serviceStopped.current = line !== null;
        if (line) showStatus(line.state, line.text);
        else if (wasStopped) showStatus("reconnecting", "reconnecting…");
      });
    } catch { /* The stream still reports the connection. */ }
    return () => { if (typeof unsubscribe === "function") unsubscribe(); };
  }, [showStatus]);

  // A newer document revision arrived: read it.
  useEffect(() => {
    if (!data?.behind || !data.projectId) return undefined;
    let active = true;
    server.projectRecord(data.projectId).then((record) => { if (active) setData((state) => withRecord(state, record)); }).catch(() => {});
    return () => { active = false; };
  }, [data?.behind, data?.projectId, data?.wantRev]);

  return { data, setData, error, connection, load };
}

export function Dashboard() {
  const { data, error, connection, load } = useDashboardData();
  const phone = useMedia(PHONE_QUERY);
  const still = useMedia(STILL_QUERY);
  const now = useNow(1000);

  const [screen, setScreen] = useState({ name: "main" });
  const [commandOpen, setCommandOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  // The judge round you put off (esc: later) and the done one you are looking at (judge.jsx).
  const [judgeLater, setJudgeLater] = useState(null);
  const [judgeReview, setJudgeReview] = useState(null);
  // The blind pick box (picks.jsx) put off at this many queued pairs; more pairs bring it back.
  const [picksLater, setPicksLater] = useState(null);
  const [picksDone, setPicksDone] = useState([]);
  // The F1 screen's three panes: 1 the stage, 2 the agent pane, 3 the timeline. The agent pane
  // shows one view at a time (agentPane.jsx): agent, session, log, checks, notes or seen.
  const [pane, setPane] = useState(1);
  const [zoomed, setZoomed] = useState(false);
  // The places j and k move, by list: 1 "needs you" (session view), 3 the pictures (seen view),
  // 4 the turns or the notes (log and notes views), 5 the timeline's layers.
  const [cursors, setCursors] = useState({ 1: 0, 3: 0, 4: 0, 5: 0, projects: 0, variants: 0 });
  const [agentView, setAgentView] = useState("agent");
  // The log, checks and notes were the tabs of a pane of their own; now they are views.
  const logTab = agentView;
  const setLogTab = setAgentView;
  // Which list j and k move in now (the numbers above), or null.
  // (On a phone the log keeps a pane of its own, number 4.)
  const list = pane === 3 ? 5 : pane === 4 ? 4 : pane === 2 ? ({ session: 1, seen: 3, log: 4, notes: 4 }[agentView] ?? null) : null;
  const [expanded, setExpanded] = useState([]);
  const [filter, setFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [view, setView] = useState({ sceneId: null, time: 0 });
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  const [follow, setFollow] = useState(true);
  const [checkpoint, setCheckpoint] = useState(null);
  // findings: the check's boxes; marks: the agents' outlines. The stage's outlines button turns
  // both on or off; the person's choice is kept in this browser.
  const [overlays, setOverlays] = useState(() => ({ safe: false, grid: false, ...readOutlines() }));
  useEffect(() => { keepOutlines(overlays); }, [overlays.findings, overlays.marks]);
  const [selectedLayer, setSelectedLayer] = useState(null);
  // A time range the person points at on the timeline (read only): {sceneId, anchor, end}.
  const [point, setPoint] = useState(null);
  const [checks, setChecks] = useState(null);
  const [draft, setDraft] = useState(null);
  // The message box under the agent pane: a note about the whole video (no time, no place).
  const [messageText, setMessageText] = useState("");
  const [message, setMessage] = useState(null);
  const [polite, setPolite] = useState("");
  const [alert, setAlert] = useState("");
  const [approvalNotes, setApprovalNotes] = useState({});
  // The note typed on each stop card, by "<project>/<stop id>": {text, mode ("notes" or "redo")}.
  // Kept for this page only; answering sends it, and it is never dropped unsent.
  const [stopNotes, setStopNotes] = useState({});
  // The notes on single shots of a waiting storyboard (c on a shot), by "<project>/<stop id>":
  // {S2: {n, text}}. Kept for this page only, like the stop's note; answering sends them.
  const [shotNotes, setShotNotes] = useState({});
  // The agent's calls on a waiting storyboard the person said no to, by "<project>/<stop id>":
  // a list of the calls' words. Kept for this page only; answering sends them in the note.
  const [callNos, setCallNos] = useState({});
  // The stop that just stopped waiting in the open project (its id): the phone keeps its line at
  // the top of the stack, where its card was, until dismissed or the next stop waits.
  const [recentStop, setRecentStop] = useState(null);
  const [share, setShare] = useState("");
  const [enlarged, setEnlarged] = useState(null);
  const [sections, setSections] = useSections();
  const [rejecting, setRejecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notificationState, setNotificationState] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  const noteRef = useRef(null);
  const approvalNoteRef = useRef(null);
  const stopNoteRef = useRef(null);
  const knownApprovals = useRef(null);
  const knownStops = useRef(null);
  // The key of the "needs you" row that moved under a, d, A and D (see needsShift below), or null.
  const movedNeed = useRef(null);
  // The inspire screen's answer to its waiting ideas (allow or hold), so the top bar's a reaches it.
  const inspireKeys = useRef(null);
  // The stop whose answer or reopen just went through: the focus goes to its line once the
  // button or card that had it is gone (see the layout effect after the actions).
  const focusStop = useRef(null);
  const knownRenders = useRef(null);
  const knownBrief = useRef(null);
  // Playback: the clock (sound card or computer clock) and the time on screen while playing.
  // Only the stage, the timeline and the status line read the time store, so only they redraw
  // on each frame; `view.time` holds the paused time.
  const [player] = useState(() => createPlaybackClock());
  const [timeStore] = useState(() => createTimeStore(0));
  const soundState = useSyncExternalStore(player.subscribe, player.soundState);
  const [mix, setMix] = useState({ state: "none", error: "" });
  const soundRef = useRef({ target: null, key: null });
  const playingRef = useRef(false);
  playingRef.current = playing;

  const projectId = data?.projectId ?? null;
  const doc = data?.record?.document ?? null;
  const scene = doc ? doc.scenes.find((entry) => entry.id === view.sceneId) ?? doc.scenes[0] : null;
  const fps = data?.settings?.exports?.fps ?? 30;
  const duration = Number(scene?.duration) || 0;
  const time = Math.min(view.time, duration);
  const revision = data?.record?.revision;
  const pending = data ? pendingApprovals(data) : [];
  // "needs you": the waiting stop first, then the requests (pane 1's cursor moves over both).
  const needs = data ? needsYouRows(data) : [];
  const waitingStop = data ? waitingStopOf(data) : null;
  const stopLines = useMemo(() => (data ? stopRows(data) : []), [data]);
  const turns = useMemo(() => (data ? turnRows(data, now) : []), [data, now]);
  const choices = useMemo(() => variantChoices(doc, scene?.id), [doc, scene?.id]);
  const chips = useMemo(() => (data ? turnChips(data) : []), [data]);
  const layers = videoLayers(data);
  const brief = useMemo(() => briefRows(data?.agent, { layers }), [data?.agent, layers]);

  const say = useCallback((text, isError = false) => {
    setMessage({ text, error: isError, at: Date.now() });
    setPolite(text);
  }, []);
  const fail = useCallback((cause) => say(cause?.message ?? String(cause), true), [say]);

  // ---- per-project resets and the note draft ------------------------------------------------
  useEffect(() => {
    player.pause();
    mediaKeys.set(false);
    setPlaying(false);
    setView({ sceneId: null, time: 0 });
    setCheckpoint(null);
    setSelectedLayer(null);
    setPoint(null);
    setChecks(null);
    setExpanded([]);
    setShare("");
    setDraft(projectId ? readDraft(projectId) : null);
    setRecentStop(null);
  }, [projectId]);
  useEffect(() => { if (projectId) saveDraft(projectId, draft); }, [projectId, draft]);

  // ---- follow the agent -----------------------------------------------------------------------
  useEffect(() => {
    if (follow && data?.current && data.current !== data.projectId) load(data.current);
  }, [follow, data?.current, data?.projectId, load]);
  useEffect(() => {
    if (!follow || checkpoint || playing || !data?.focus) return;
    setView({ sceneId: data.focus.sceneId, time: data.focus.time ?? 0 });
  }, [data?.focus, follow]); // eslint-disable-line react-hooks/exhaustive-deps
  // An agent's write that starts in a scene not on the stage brings the stage there before its
  // focus does, at most once every 2 s (followStart in presence.js). A read stays where it is.
  const startedCall = useRef(null);
  const followedAt = useRef(null);
  const newest = data?.live ? newestPresence(data.live) : null;
  useEffect(() => {
    if (!newest || newest.phase !== "start" || startedCall.current === newest.call) return;
    startedCall.current = newest.call;
    if (!follow || checkpoint || playing) return;
    const now = serverNow(data.live);
    const to = followStart(newest, { sceneId: scene?.id, sceneIds: doc?.scenes.map((entry) => entry.id) ?? [], now, lastAt: followedAt.current });
    if (!to) return;
    followedAt.current = now;
    setView(to);
  }, [newest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- playback ---------------------------------------------------------------------------------
  // The clock loops where the scene ends, also after an edit changes its length.
  useEffect(() => { player.setDuration(duration || 1e-3); }, [player, duration]);
  // While playing, once a display frame: the time that will be heard when this frame reaches the
  // screen (createPictureClock), on the frame grid, into the time store. The store tells its
  // readers only when the frame changes, so the stage draws at most fps frames a second.
  const [pictureClock] = useState(() => createPictureClock());
  useEffect(() => {
    if (!playing) return undefined;
    pictureClock.reset();
    return everyFrame((frameMs) => timeStore.set(frameStart(pictureClock.next(player.time(), frameMs, player.duration), fps)));
  }, [playing, fps, player, timeStore, pictureClock]);
  useEffect(() => () => player.close(), [player]);
  // The keyboard's play/pause key: it runs the newest start and stop (a ref, so the handlers made
  // once still see this render's scene and time).
  const mediaRun = useRef({});
  const [mediaKeys] = useState(() => createMediaKeys({ onPlay: () => mediaRun.current.play?.(), onPause: () => mediaRun.current.pause?.() }));
  useEffect(() => () => mediaKeys.close(), [mediaKeys]);

  // The reaction track (useReactions.js): what you do while watching, and your good and bad marks.
  // Each entry carries the revision on the stage (a turn's checkpoint while one is shown).
  const reactions = useReactions({ projectId, revision: checkpoint?.rev ?? revision, savedMarks: data?.agent?.marks, onError: (text) => say(text, true) });
  const { track: reactionTrack, flush: flushReactions } = reactions;
  const sceneRef = useRef(null);
  sceneRef.current = scene ? { id: scene.id, duration } : null;
  useEffect(() => timeStore.subscribe(() => {
    if (playingRef.current && sceneRef.current) reactionTrack.tick(sceneRef.current.id, timeStore.get(), sceneRef.current.duration);
  }), [timeStore, reactionTrack]);

  // Plays from the time on screen. Runs inside your key press or click, so the browser lets the
  // sound start.
  const startPlaying = () => {
    player.setDuration(duration || 1e-3);
    const from = time >= duration ? 0 : time;
    timeStore.set(frameStart(from, fps));
    if (scene) reactionTrack.play(scene.id, from, duration);
    player.play(from);
    mediaKeys.set(true, scene?.name ? `${scene.name}` : "kino");
    setPlaying(true);
  };
  // Stops on the frame on screen, so the exact frame the server draws next is the one you saw.
  // Returns that time.
  const stopPlaying = useCallback(() => {
    mediaKeys.set(false);
    if (!player.playing) { setPlaying(false); return null; }
    // The picture runs a little ahead of the sound (createPictureClock), so the frame on screen is
    // the time store's, unless a loop or seek is in between.
    const heard = frameStart(player.pause(), fps);
    const onScreen = timeStore.get();
    const stopped = Math.min(duration, onScreen >= heard && onScreen - heard < 0.25 ? onScreen : heard);
    reactionTrack.stop(stopped);
    flushReactions();
    timeStore.set(stopped);
    setView((value) => ({ ...value, time: stopped }));
    setPlaying(false);
    return stopped;
  }, [player, mediaKeys, timeStore, duration, fps, reactionTrack, flushReactions]);
  mediaRun.current = { play: () => { if (scene && !player.playing) startPlaying(); }, pause: () => stopPlaying() };
  // Another scene: playing goes on from its start, without the last scene's sound.
  const showScene = (sceneId) => {
    if (player.playing) {
      // The reaction track starts a run in the new scene (no jump, no play-through).
      const next = Number(doc?.scenes.find((entry) => entry.id === sceneId)?.duration) || 1e-3;
      reactionTrack.stop(timeStore.get());
      sceneRef.current = { id: sceneId, duration: next };
      player.seek(0); timeStore.set(0);
      reactionTrack.play(sceneId, 0, next);
    }
    setView({ sceneId, time: 0 });
  };

  // ---- the scene's sound: the export's own mix (GET /api/dashboard/mix), again after edits ----
  useEffect(() => {
    if (!projectId || !scene?.id || !revision) return undefined;
    const target = `${projectId}\n${scene.id}\n${fps}`;
    if (soundRef.current.target !== target) {
      // Another scene or project: its sound is not this one's.
      soundRef.current = { target, key: null, silent: false };
      player.setSound(null);
      setMix({ state: "loading", error: "" });
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const query = new URLSearchParams({ project: projectId, scene: scene.id, rev: String(revision), fps: String(fps) });
      const known = soundRef.current.key;
      try {
        const response = await fetch(`/api/dashboard/mix?${query}`, {
          headers: { ...accessHeaders(), ...(known ? { "If-None-Match": known } : {}) }, cache: "no-store", signal: controller.signal,
        });
        // The same sound as before (only the picture changed): keep it.
        if (response.status === 304) { setMix({ state: soundRef.current.silent ? "none" : "ready", error: "" }); return; }
        if (response.status === 204) {
          soundRef.current = { target, key: response.headers.get("etag"), silent: true };
          player.setSound(null);
          setMix({ state: "none", error: "" });
          return;
        }
        if (!response.ok) {
          const reply = await response.json().catch(() => null);
          throw new Error(reply?.error ?? `The sound could not be loaded (${response.status}).`);
        }
        const buffer = await decodeSound(await response.arrayBuffer());
        if (controller.signal.aborted) return;
        soundRef.current = { target, key: response.headers.get("etag"), silent: false };
        player.setSound(buffer);
        setMix({ state: "ready", error: "" });
      } catch (cause) {
        if (controller.signal.aborted) return;
        // No sound rather than the sound of an older revision.
        soundRef.current = { target, key: null, silent: false };
        player.setSound(null);
        setMix({ state: "error", error: cause.message });
      }
    }, playingRef.current ? MIX_DELAY_PLAYING_MS : MIX_DELAY_PAUSED_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, scene?.id, revision, fps, player]);

  // While the browser holds the sound back, your next key press or click asks again.
  useEffect(() => {
    if (soundState !== "blocked") return undefined;
    const ask = () => player.resume();
    window.addEventListener("pointerdown", ask, true);
    window.addEventListener("keydown", ask, true);
    return () => { window.removeEventListener("pointerdown", ask, true); window.removeEventListener("keydown", ask, true); };
  }, [soundState, player]);

  // The live stage draws text with the project's fonts, as the exact frames do.
  const [fontVersion, setFontVersion] = useState(0);
  const fontKey = useMemo(() => (doc ? JSON.stringify([doc.id, documentFontReferences(doc), fontGlyphReferences(doc)]) : ""), [doc]);
  useEffect(() => {
    if (!fontKey) return undefined;
    let active = true;
    loadBrowserFonts(doc).then(() => { if (active) setFontVersion(defaultFonts.version); }).catch(() => {});
    return () => { active = false; };
  }, [fontKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- background checks: the same findings the agent gets, after each new revision ---------
  useEffect(() => {
    if (!projectId || !revision) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      server.act("check", backgroundCheckInput(projectId))
        .then((reply) => { if (active) setChecks(reply.isError ? { error: reply.text } : { text: reply.text, data: reply.data }); })
        .catch((cause) => { if (active) setChecks({ error: cause.message }); });
    }, CHECK_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, revision]);

  // ---- notifications, title and badge (plan §5.13) --------------------------------------------
  // The open document's own name first: it follows the agent's rename_project at once, while the
  // project list only changes on a reload.
  const projectName = data?.record?.document?.name ?? data?.projects.find((entry) => entry.id === projectId)?.name;
  useEffect(() => {
    if (!data) return;
    showCount(attention(data).count, projectName);
  }, [data, projectName]);
  useEffect(() => {
    if (!data) return;
    const ids = new Set(pending.map((approval) => approval.id));
    if (knownApprovals.current) {
      for (const approval of pending) {
        if (knownApprovals.current.has(approval.id)) continue;
        const text = `${approval.id} needs you: ${approval.summary}. Press a to allow or d to deny.`;
        // A new request opens "needs you" again if it was closed, so it is seen.
        setSections((value) => (value["needs-you"] ? value : { ...value, "needs-you": true }));
        setAlert(text);
        notify("request", `${approval.id} needs you`, approval.summary, () => setScreen({ name: "approval", id: approval.id }));
      }
    }
    knownApprovals.current = ids;
    const states = new Map((data.renders ?? []).map((job) => [job.id, job.status]));
    if (knownRenders.current) {
      for (const job of data.renders ?? []) {
        const before = knownRenders.current.get(job.id);
        if (before === job.status) continue;
        if (job.status === "done" && before) setPolite(`${job.id} ${job.quality} render done.`);
        if (["error", "failed"].includes(job.status)) {
          setAlert(`${job.id} render failed${job.error ? `: ${job.error}` : ""}.`);
          notify("error", `${job.id} render failed`, job.error ?? "The render stopped.");
        }
      }
    }
    knownRenders.current = states;
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // "tell me when an agent goes quiet" (Settings, off by default): every 5 s, while this window is
  // in the background, one silent notification for each agent whose last call in this turn ended
  // 30 s ago and that nothing waits for (quietAgents in state.js). Once per quiet spell: the
  // spell's key (the agent and its call) is kept.
  const quietOn = Boolean(data?.settings?.notify?.quiet);
  const quietData = useRef(data);
  quietData.current = data;
  const toldQuiet = useRef(new Set());
  useEffect(() => {
    if (!quietOn) return undefined;
    const check = () => {
      if (!quietData.current || window.document.hasFocus()) return;
      for (const row of quietToTell(quietData.current, Date.now(), toldQuiet.current)) notify("quiet", "kino", row.text, () => focusPane(2));
    };
    const timer = setInterval(check, QUIET_CHECK_MS);
    return () => clearInterval(timer);
  }, [quietOn]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only the agent changes the brief (from its chat with you): a new revision, a confirmation or
  // going on with no playback is said in the polite region, as a finished render is. The first
  // load says nothing.
  useEffect(() => {
    if (!data) return;
    const seen = { projectId: data.projectId, rev: brief.rev, confirmed: brief.confirmed, noPlayback: brief.noPlayback };
    const was = knownBrief.current;
    if (was && was.projectId === seen.projectId) {
      if (seen.rev > was.rev) setPolite(`Brief revision ${seen.rev} saved by the agent.`);
      else if (seen.confirmed && !was.confirmed) setPolite("Brief confirmed in chat.");
      else if (seen.noPlayback && !was.noPlayback) setPolite(`Brief kept with no playback: ${seen.noPlayback}.`);
    }
    knownBrief.current = seen;
  }, [data?.projectId, brief]); // eslint-disable-line react-hooks/exhaustive-deps
  // A stop that starts waiting is announced like a new request, and opens "needs you"; the stop
  // screen of an earlier round (answered, as after a redo) moves to it, so its keys answer the
  // stop that waits. An answer the agent recorded from the chat is said in the top line and the
  // polite region. A stop that starts waiting in a project that is not open is announced too. The
  // first load says nothing, and a stop already waiting is not news when its project, or another
  // one, is opened (stopChanges). Before paint, like needsShift below: as a passive effect it could
  // run after a key pressed on the changed list, and its older news would replace what the key said
  // (a pressed for C1 named the request that moved up, then "C1 approved in chat" covered it).
  useLayoutEffect(() => {
    if (!data) return;
    const changes = stopChanges(knownStops.current, data);
    knownStops.current = changes.known;
    const round = changes.asked;
    if (changes.closed) setRecentStop(changes.closed.id);
    if (round) {
      setRecentStop(null);
      setSections((value) => (value["needs-you"] ? value : { ...value, "needs-you": true }));
      setScreen((value) => (value.name === "stop" && value.id !== round.id ? { name: "stop", id: round.id } : value));
      // It took the place of a row a acted on (needsShift): the first a only says so.
      const twice = movedNeed.current === needKey({ type: "stop", projectId: data.projectId, round }) ? " twice" : "";
      setAlert(`${round.id} needs you: the ${STOP_WORDS[round.kind] ?? round.kind} is ready. Press a${twice} to approve, or d to ask for a redo with a note.`);
      notify("request", `${round.id} needs you`, String(round.ask ?? "").split("\n")[0], () => setScreen({ name: "stop", id: round.id }));
    }
    for (const { text } of changes.chat) say(text);
    for (const entry of changes.elsewhere) {
      const word = STOP_WORDS[entry.round.kind] ?? entry.round.kind;
      setSections((value) => (value["needs-you"] ? value : { ...value, "needs-you": true }));
      setAlert(`${entry.round.id} needs you in ${entry.name}: the ${word} is ready. Open ${entry.name} from "needs you" to answer it.`);
      notify("request", `${entry.round.id} needs you in ${entry.name}`, String(entry.round.ask ?? "").split("\n")[0], () => load(entry.projectId));
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions -------------------------------------------------------------------------------------
  const focusPane = useCallback((number) => {
    setPane(number);
    setScreen({ name: "main" });
    requestAnimationFrame(() => window.document.querySelector(`[data-pane="${number}"]`)?.focus());
  }, []);
  // A click on the status line's "checks 1 err 2 warn" opens the checks view, which lists each
  // finding: the layer, what is wrong and the fix (on a phone, the agent pane's checks tab).
  const showChecks = useCallback(() => {
    setAgentView("checks");
    focusPane(phone ? 4 : 2);
  }, [focusPane, phone]); // eslint-disable-line react-hooks/exhaustive-deps

  // [3]: a picked picture is selected and, when it shows one moment of a scene, the stage goes there.
  const pickSeen = (index, moment) => {
    setCursors((value) => ({ ...value, 3: index }));
    const target = moment?.sceneId ? data?.record?.document?.scenes?.find((entry) => entry.id === moment.sceneId) : null;
    if (!target) return;
    stopPlaying();
    setView({ sceneId: target.id, time: Math.max(0, Math.min(Number(target.duration) || 0, moment.time)) });
  };
  // ← → and j k in [3]: the next picture `step` places on in the list (newest first) is picked as a
  // click picks it, so the stage goes to its moment too.
  const stepSeen = (step) => {
    const images = data ? seenImages(data) : [];
    if (!images.length) return;
    const from = Math.max(0, Math.min(images.length - 1, cursors[3] ?? 0));
    const index = Math.max(0, Math.min(images.length - 1, from + step));
    if (index === cursors[3]) return;
    pickSeen(index, lookMoment(images[index].call, data.record?.document, data.agent?.codes ?? {}));
  };
  // A new picture: the selection moves to it while [3] is not focused, and stays on the same
  // picture while it is (the list is newest first, so its place changes).
  const seenFiles = data ? seenImages(data).map((image) => image.file) : [];
  const seenRef = useRef(seenFiles);
  useEffect(() => {
    const before = seenRef.current;
    seenRef.current = seenFiles;
    if (before[0] === seenFiles[0]) return;
    setCursors((value) => {
      const index = list === 3 ? seenFiles.indexOf(before[value[3]]) : 0;
      return { ...value, 3: Math.max(0, index) };
    });
  }, [seenFiles[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  // [4]'s log shows the newest turn at the bottom and keeps it in view. While [4] is not focused
  // its selection moves to that newest turn, so 4 then j and k start from the row on screen (the
  // log keeps the selected row in view; from the oldest turn it would jump to the top).
  useEffect(() => {
    if (list === 4 || logTab !== "log" || !turns.length) return;
    setCursors((value) => (value[4] === turns.length - 1 ? value : { ...value, 4: turns.length - 1 }));
  }, [list, logTab, turns.length]);
  // Showing the log view (its tab is in the agent pane, so the pane may have the focus already)
  // picks the newest turn too.
  useEffect(() => {
    if (logTab !== "log" || !turns.length) return;
    setCursors((value) => (value[4] === turns.length - 1 ? value : { ...value, 4: turns.length - 1 }));
  }, [logTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveCursor = (key, length, step) => setCursors((value) => ({ ...value, [key]: Math.max(0, Math.min(Math.max(0, length - 1), (value[key] ?? 0) + step)) }));

  // "needs you" changed while the person looked (needsShift in state.js): pane 1's cursor stays on
  // its row, and when a, d, A and D would now act on a row the person did not choose (a stop
  // answered in the chat left, a new stop came first), the next of those keys only says so.
  // Before paint, so no key press comes between.
  const needsRef = useRef(needs);
  useLayoutEffect(() => {
    const before = needsRef.current;
    needsRef.current = needs;
    const onCursor = list === 1 && screen.name === "main";
    const shift = needsShift(before, needs, onCursor ? cursors[1] : null);
    if (shift.moved) movedNeed.current = shift.moved;
    if (onCursor && shift.cursor !== cursors[1]) setCursors((value) => ({ ...value, 1: shift.cursor }));
  }, [needs.map(needKey).join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps

  const openProject = useCallback((id) => {
    if (!data?.projects.some((entry) => entry.id === id)) { say(`There is no project "${id}".`, true); return; }
    if (id !== data.current && follow) { setFollow(false); say(`Opened ${id}. Follow agent is off because the agent works in ${data.current ?? "no project"}; f turns it back on.`); }
    else say(`Opened ${id}.`);
    load(id);
    setScreen({ name: "main" });
  }, [data, follow, load, say]);

  // A note is about the frame on screen: playing stops there. On the desktop it is written in a
  // bubble on the stage, beside the dot where the person clicked (`extra.point`), about the layer
  // the click snapped to (`extra.layer`, noteSpot.js); from a key it is about the whole frame.
  // On a phone the note form is in the log pane's notes tab.
  // `focus`: put the cursor in the note (false when the cursor is already going there).
  const startNote = useCallback((area = null, focus = true, extra = {}) => {
    if (!scene) { say("Open a project first.", true); return; }
    const at = stopPlaying() ?? time;
    const layer = extra.layer !== undefined ? extra.layer : area ? null : selectedLayer ?? null;
    setDraft((value) => ({ text: value?.text ?? "", urgent: false, layer, sceneId: scene.id, time: Math.round(at * 100) / 100, area, point: extra.point ?? null, onStage: !phone }));
    if (phone) { setLogTab("notes"); setPane(4); }
    else setPane(2);
    setScreen({ name: "main" });
    if (focus) requestAnimationFrame(() => noteRef.current?.focus());
  }, [scene, selectedLayer, time, say, stopPlaying, phone]);

  const sendNote = useCallback(async (text, extra = {}) => {
    const reply = await server.act("notes", { action: "add", project: projectId, text, ...extra });
    if (reply.isError) throw new Error(reply.text);
    return reply.data?.note;
  }, [projectId]);

  // A button in the notes view (Looks good, Not yet, always, Keep it, Let ...): one notes action.
  const noteAct = useCallback(async (payload, words) => {
    try {
      const reply = await server.act("notes", { project: projectId, ...payload });
      if (reply.isError) throw new Error(reply.text);
      if (words) say(words);
    } catch (cause) { fail(cause); }
  }, [projectId, say, fail]);

  // `urgent`: ⌘Enter, or "urgent" in the bubble: the agent's inbox marks it URGENT.
  const submitDraft = useCallback(async (urgent = false) => {
    if (!draft?.text.trim()) { say("A note needs text.", true); return; }
    try {
      const note = await sendNote(draft.text.trim(), {
        t: draft.time, scene: draft.sceneId, ...(draft.area ? { area: draft.area } : {}), ...(draft.layer ? { layer: draft.layer } : {}), ...(urgent || draft.urgent ? { urgent: true } : {}),
      });
      setDraft(null);
      say(`${note?.id ?? "Note"} queued: the agent gets it with its next call.`);
    } catch (cause) { fail(cause); }
  }, [draft, sendNote, say, fail]);

  const sendMessage = useCallback(async (urgent = false) => {
    const text = messageText.trim();
    if (!text) { say("A note needs text.", true); return; }
    try {
      const note = await sendNote(text, urgent ? { urgent: true } : {});
      setMessageText("");
      say(`${note?.id ?? "Note"} queued: the agent gets it with its next call.`);
    } catch (cause) { fail(cause); }
  }, [messageText, sendNote, say, fail]);

  const answer = useCallback(async (id, decision, always = false) => {
    try {
      const { approval } = await server.answerApproval(id, { decision, always, note: approvalNotes[id] ?? "" });
      setApprovalNotes((value) => ({ ...value, [id]: "" }));
      const rule = always ? ` · from now on always ${decision}` : "";
      // Allowed, but the call it let through failed: that is an error, not a success.
      if (approval.result?.isError) say(`${id} allowed${rule}, but the call failed: ${cut(approval.result.text, 120)}. The agent is told in its next answer.`, true);
      else say(`${id} ${approval.status}${rule}${approval.result ? ` · ${cut(approval.result.text, 120)}` : ""}. The agent is told in its next answer.`);
    } catch (cause) { fail(cause); }
  }, [approvalNotes, say, fail]);

  // A material question's answer ("option N", "have" or "drop"), saved as yours (by:"you"), the
  // same answer an agent records from the chat; the agent reads it in its inbox.
  const answerMaterial = useCallback((need, value) => {
    server.act("notes", { action: "needs", project: projectId, id: need.id, answer: value })
      .then((reply) => { if (reply.isError) say(reply.text, true); else say(`${need.id}: ${value}. The agent is told in its next answer.`); }, fail);
  }, [projectId, say, fail]);

  // The "needs you" row a, d, A and D act on: pane 1's cursor row, else the first that is not a
  // stop in another project (keyTarget in state.js).
  const targetNeed = () => needs[keyTarget(needs, list === 1 && screen.name === "main" ? cursors[1] : null)] ?? null;

  // ---- stops: the person's answer on the stop card, or reopening an answer -----------------
  const noteKey = (id) => `${projectId}/${id}`;
  const stopNote = (id) => stopNotes[noteKey(id)] ?? { text: "", mode: "notes" };
  const setStopNote = (id, note) => setStopNotes((value) => ({ ...value, [noteKey(id)]: note }));
  // Puts the cursor in the stop card's note: in the field there now, inside the key press or
  // tap (a phone opens its keyboard only then), else once the card is drawn.
  const focusNoteField = () => {
    if (stopNoteRef.current) stopNoteRef.current.focus();
    else requestAnimationFrame(() => stopNoteRef.current?.focus());
  };
  // Tab: the cursor goes to the note. An empty note is for approve with notes; a note already
  // typed keeps its mode, so Tab back into a redo note leaves it a redo.
  const focusStopNote = (id) => {
    setStopNotes((value) => {
      const note = value[noteKey(id)] ?? { text: "", mode: "notes" };
      return { ...value, [noteKey(id)]: { text: note.text, mode: note.text.trim() ? note.mode : "notes" } };
    });
    focusNoteField();
  };
  // A press on the waiting stop (its card, its row in "needs you", or a key): stopAnswer
  // (state.js) says whether it answers, needs the note first, or is missing something.
  const pressStop = useCallback(async (round, press) => {
    const key = `${projectId}/${round.id}`;
    const note = stopNotes[key] ?? { text: "", mode: "notes" };
    // Each shot's directions (an option, a length, remove, a note) in the words the agent reads.
    const shots = Object.entries(shotNotes[key] ?? {}).map(([id, entry]) => ({ id, words: directionWords(entry) }));
    const result = stopAnswer(round, { press, mode: note.mode, text: note.text, shots, noCalls: callNos[key] ?? [] });
    if (result.focus || result.error) {
      if (result.error) say(result.error, true);
      setStopNotes((value) => ({ ...value, [key]: { text: note.text, mode: result.focus ?? note.mode } }));
      focusNoteField();
      return;
    }
    try {
      await server.answerStop(projectId, result.send);
      setStopNotes((value) => { const rest = { ...value }; delete rest[key]; return rest; });
      setShotNotes((value) => { const rest = { ...value }; delete rest[key]; return rest; });
      setCallNos((value) => { const rest = { ...value }; delete rest[key]; return rest; });
      focusStop.current = { id: round.id, answered: true };
      say(stopAnswered(result.send));
    } catch (cause) { fail(cause); }
  }, [projectId, stopNotes, shotNotes, callNos, say, fail]);
  // A note on one shot of the waiting storyboard (null removes it).
  const setShotNote = (id, shot, note) => setShotNotes((value) => {
    const notes = { ...(value[noteKey(id)] ?? {}) };
    if (note) notes[shot] = note;
    else delete notes[shot];
    return { ...value, [noteKey(id)]: notes };
  });
  // c on a focused shot row: its note field, opened by the row's own [c] button.
  const openShotNote = () => {
    const row = window.document.activeElement?.closest?.("article.board-shot[data-notes]");
    if (!row) return;
    const field = window.document.getElementById(`board-note-${row.dataset.shot}`);
    if (field) field.focus();
    else row.querySelector("[data-note-open]")?.click();
  };
  // j, k, ↓ and ↑ on a board: the shot panel takes the focus; once it has it, the next or
  // previous shot goes into it (its › and ‹ buttons).
  const stepShot = (step) => {
    const panel = window.document.querySelector("article.board-shot");
    if (!panel) return;
    if (window.document.activeElement?.closest?.("article.board-shot")) panel.querySelector(step > 0 ? "[data-shot-next]" : "[data-shot-prev]")?.click();
    requestAnimationFrame(() => window.document.querySelector("article.board-shot")?.focus());
  };
  // The stop screen; "redo" opens it with the redo note focused.
  const openStop = (round, mode = null) => {
    if (mode) setStopNotes((value) => ({ ...value, [noteKey(round.id)]: { text: value[noteKey(round.id)]?.text ?? "", mode } }));
    setScreen({ name: "stop", id: round.id, ...(mode ? { mode } : {}) });
  };
  // a, A, d and D on the main screen when the row they act on is the waiting stop. The orange top
  // line and the action strip under the stage name the row they act on, so it is always seen.
  const stopKeyOnMain = (round, action) => {
    if (action.endsWith("always")) { say(STOP_ALWAYS_OFF, true); return; }
    if (action === "deny") { openStop(round, "redo"); return; }
    // A storyboard is approved where it is shown: a opens it (the stage has nothing built yet).
    if (round.kind === "board") { openStop(round); return; }
    pressStop(round, "approve");
  };
  const reopenStop = useCallback((row) => {
    if (!row.reopen) return;
    setConfirm({
      text: row.reopen.question,
      yes: "reopen",
      async run() {
        try {
          await server.reopenStop(projectId, row.id);
          focusStop.current = { id: row.key, answered: false };
          say(`${row.id} reopened. The agent is told with its next call; tell it "go on" if it is waiting.`);
        } catch (cause) { fail(cause); }
      },
    });
  }, [projectId, say, fail]);
  // After an answer or a reopen, the card or button that had the focus is gone: the focus goes to
  // the stop's line (its reopen button when it has one), on the stop screen, in the stops section
  // or on the phone's card that took the answered card's place, so the keyboard and a screen
  // reader keep their place. Not while the stop still waits (its card is on screen), nor when the
  // focus is somewhere else already.
  useLayoutEffect(() => {
    const target = focusStop.current;
    if (!target || waitingStop?.id === target.id || (target.answered && phone && screen.name === "main" && recentStop !== target.id)) return;
    const { id } = target;
    focusStop.current = null;
    const active = window.document.activeElement;
    if (active && active !== window.document.body) return;
    const line = window.document.querySelector(`[data-stop-line="${CSS.escape(id)}"]`);
    (line?.querySelector("button") ?? line)?.focus();
  });
  const keepAsking = useCallback(async () => {
    try {
      await server.keepAsking(projectId);
      say("The rough, color and sound stops ask again for this video. The agent is told with its next call.");
    } catch (cause) { fail(cause); }
  }, [projectId, say, fail]);

  const undo = useCallback((turnId) => {
    const index = data?.agent?.turns.findIndex((entry) => entry.id === turnId) ?? -1;
    if (index < 0) { say("Choose a turn to revert.", true); return; }
    const affected = data.agent.turns.slice(index).filter((entry) => entry.edits.length && !entry.reverted);
    if (!affected.length) { say(`${turnId} has nothing left to revert.`, true); return; }
    const later = affected.filter((entry) => entry.id !== turnId).map((entry) => entry.id);
    const before = affected[0].edits[0]?.before;
    setConfirm({
      text: `Revert ${affected[0].id}${later.length ? ` and every later turn (${later.join(", ")})` : ""}? The project goes back to how it was at rev ${before}, as a new revision. The agent is told in its next answer.`,
      yes: "revert",
      async run() {
        try {
          const result = await server.undoTurn(projectId, turnId);
          const done = result.reverted.map((entry) => entry.turn).join(", ");
          if (result.failed) say(`${done ? `Reverted ${done}. ` : ""}${result.failed.turn} could not be reverted: ${result.failed.reason}`, true);
          else say(`Reverted ${done} · now rev ${result.reverted.at(-1)?.rev}. The agent is told in its next answer.`);
          setCheckpoint(null);
        } catch (cause) { fail(cause); }
      },
    });
  }, [data, projectId, say, fail]);

  const undoTarget = () => {
    if (screen.name === "turn") return screen.turn;
    if (list === 4 && logTab === "log" && turns[cursors[4]]) return turns[cursors[4]].id;
    if (checkpoint) return checkpoint.turn;
    return [...(data?.agent?.turns ?? [])].reverse().find((entry) => entry.edits.length && !entry.reverted)?.id ?? null;
  };

  const toggleHold = useCallback(async (on = !data?.hold?.on, note = "") => {
    try {
      const { hold } = await server.setHold(on, note);
      say(hold.on ? "HOLD on: agent writes are paused. The agent is told when it tries to write. H releases it." : "Hold released: agent writes work again. The agent is told.");
    } catch (cause) { fail(cause); }
  }, [data?.hold?.on, say, fail]);

  // The person stops an agent's screen recording; the agent hears it at its next record call.
  const stopRecording = useCallback(async () => {
    try {
      const { stopped } = await server.stopRecording();
      say(stopped ? `Recording stopped: ${Math.round(stopped.seconds)} s kept. The agent is told.` : "Nothing was recording.");
    } catch (cause) { fail(cause); }
  }, [say, fail]);

  const exportScene = useCallback(async (options = {}) => {
    if (!projectId || !scene) { say("Open a project first.", true); return; }
    try {
      const reply = await server.act("render", { project: projectId, scene: scene.id, quality: options.quality ?? "final", ...(options.format ? { format: options.format } : {}) });
      // A refusal (stops_open, check_failed) says why and what to do, not its JSON.
      say(reply.isError && reply.data?.reason ? [reply.data.reason, reply.data.next].filter(Boolean).join(" ") : reply.text.split("\n")[0], reply.isError);
    } catch (cause) { fail(cause); }
  }, [projectId, scene, say, fail]);

  const cancelRender = useCallback(async (jobId) => {
    const running = (data?.renders ?? []).filter((job) => !["done", "canceled", "gone", "error", "failed"].includes(job.status));
    const id = jobId ?? running.at(-1)?.id;
    if (!id) { say("No render is running.", true); return; }
    try { const reply = await server.act("render", { action: "cancel", job: id }); say(reply.text, reply.isError); } catch (cause) { fail(cause); }
  }, [data?.renders, say, fail]);

  const makeShare = useCallback(async () => {
    try {
      const reply = await server.act("project", { action: "share", id: projectId, role: "view", name: "made on the dashboard" });
      if (reply.isError) { say(reply.text, true); return; }
      setShare(reply.data.url);
      try { await navigator.clipboard.writeText(reply.data.url); say("View link made and copied. Revoke it on the shares screen."); }
      catch { say("View link made. Revoke it on the shares screen."); }
    } catch (cause) { fail(cause); }
  }, [projectId, say, fail]);

  // The shares screen: make a link of any access, or revoke one (asks first).
  const makeLink = useCallback(async (role, label) => {
    try {
      // Without a label the server would name the link "made by an agent".
      const reply = await server.act("project", { action: "share", id: projectId, role, name: label || "made on the dashboard" });
      if (reply.isError) { say(reply.text, true); return null; }
      say(`${role === "view" ? "View" : role === "comment" ? "Comment" : "Edit"} link made. Anyone with it can open the viewer${role === "view" ? "" : " and comment"}.`);
      return { url: reply.data.url, role: reply.data.role ?? role };
    } catch (cause) { fail(cause); return null; }
  }, [projectId, say, fail]);

  const revokeLink = useCallback((link, reload) => setConfirm({
    text: `Revoke the ${link.role} link${link.label ? ` "${link.label}"` : ""}? It stops working at once, and anyone viewing with it is shown that the link no longer works.`,
    yes: "revoke",
    async run() {
      try { await server.revokeShare(projectId, link.id); say("Link revoked."); reload(); } catch (cause) { fail(cause); }
    },
  }), [projectId, say, fail]);

  const restore = useCallback(async (id) => {
    try { await server.restoreProject(id); say(`${id} restored from Trash.`); load(); } catch (cause) { fail(cause); }
  }, [load, say, fail]);

  const selectTurn = useCallback((turnId) => {
    const index = chips.findIndex((chip) => chip.id === turnId);
    if (index < 0) return;
    // The project as it was after this turn: its last edit, or the last edit before it.
    const rev = [...chips.slice(0, index + 1)].reverse().find((chip) => chip.rev)?.rev ?? null;
    if (!rev) { say(`${turnId} made no edits.`); return; }
    setCheckpoint({ turn: turnId, rev });
    stopPlaying();
    say(`Showing ${turnId}'s checkpoint (rev ${rev}). Esc returns to now.`);
    server.turnReview(projectId, turnId).then((review) => {
      const sceneId = review.changes?.scenes?.[0];
      if (sceneId) setView((value) => ({ ...value, sceneId }));
    }).catch(() => {});
  }, [chips, projectId, say, stopPlaying]);

  const stepTurn = (step) => {
    if (!chips.length) return;
    const index = checkpoint ? chips.findIndex((chip) => chip.id === checkpoint.turn) : chips.length;
    const next = index + step;
    if (next >= chips.length) { setCheckpoint(null); say("Showing now."); return; }
    selectTurn(chips[Math.max(0, next)].id);
  };

  const stepScene = (step) => {
    if (!doc) return;
    const index = doc.scenes.findIndex((entry) => entry.id === scene?.id);
    const next = doc.scenes[(index + step + doc.scenes.length) % doc.scenes.length];
    showScene(next.id);
  };

  // What the person points at goes to the server (F5): the selected layer and the time range.
  // One request at a time; a newer change waits and replaces the one that waits.
  const pointQueue = useRef({ busy: false, next: null });
  const sendPoint = useCallback((body) => {
    const queue = pointQueue.current;
    queue.next = body;
    if (queue.busy) return;
    queue.busy = true;
    (async () => {
      while (queue.next) {
        const { project, sceneId, layerIds, range } = queue.next;
        queue.next = null;
        try { await server.point(project, sceneId, layerIds, range); } catch (cause) { fail(cause); }
      }
      queue.busy = false;
    })();
  }, [fail]);
  const pointedRange = point && point.sceneId === scene?.id ? pointRange(point) : null;
  const selectLayer = useCallback((layerId) => {
    setSelectedLayer(layerId);
    if (!projectId || !scene) return;
    // A range in another scene is let go: the layer is in this one.
    const range = point && point.sceneId === scene.id ? pointRange(point) : null;
    if (point && !range) setPoint(null);
    sendPoint({ project: projectId, sceneId: scene.id, layerIds: layerId ? [layerId] : [], range });
  }, [projectId, scene, point, sendPoint]);
  // A range drawn on the ruler, or moved with Shift+→ and Shift+← (null lets it go).
  const pointAt = useCallback((next) => {
    if (!projectId || !scene) return;
    const range = next ? pointRange(next) : null;
    setPoint(range ? { sceneId: scene.id, anchor: next.anchor, end: next.end } : null);
    const layerIds = selectedLayer && scene.layers.some((layer) => layer.id === selectedLayer) ? [selectedLayer] : [];
    sendPoint({ project: projectId, sceneId: scene.id, layerIds, range });
    // The ruler says the range ("pointing 2.0–3.5 s") and the pointing line shows it; letting it go is said.
    if (!range) say("The time range is let go.");
  }, [projectId, scene, selectedLayer, sendPoint, say]);
  // A range the server holds (after a reload, or from another window) is drawn here too.
  useEffect(() => {
    if (pointQueue.current.busy) return;
    const held = data?.pointing?.range;
    setPoint((current) => {
      const mine = current ? pointRange(current) : null;
      if (!held) return mine ? null : current;
      if (mine && mine[0] === held[0] && mine[1] === held[1] && current.sceneId === data.pointing.sceneId) return current;
      return { sceneId: data.pointing.sceneId, anchor: held[0], end: held[1] };
    });
  }, [data?.pointing]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickVariant = useCallback(async (index) => {
    const chosen = choices.scenes[index];
    if (!chosen) return;
    const name = chosen.variant?.label || chosen.name || chosen.id;
    // The pick is a note: the agent marks it with pick_variant (people do not edit by hand).
    const text = choices.set
      ? `I pick variant ${index + 1}: ${name} (${chosen.id}). Run pick_variant {scene:"${chosen.id}"} and keep this one.`
      : `I pick variant ${index + 1}: ${name} (${chosen.id}). Keep this one and drop the others.`;
    try {
      const note = await sendNote(text, { scene: chosen.id });
      say(`${note?.id ?? "Note"}: you picked ${name}. The agent gets it with its next call.`);
    } catch (cause) { fail(cause); }
  }, [choices, sendNote, say, fail]);

  const rejectVariants = useCallback(async (reason) => {
    if (reason === null) { setRejecting(true); return; }
    try {
      const count = choices.scenes.length;
      const note = await sendNote(`None of the ${count} variants work${reason.trim() ? `: ${reason.trim()}` : "."}`);
      setRejecting(false);
      say(`${note?.id ?? "Note"}: you rejected all variants. The agent gets it with its next call.`);
    } catch (cause) { fail(cause); }
  }, [choices, sendNote, say, fail]);

  const projectAction = useCallback(async (action, id) => {
    try {
      const reply = await server.act("project", { action, id });
      say(reply.text, reply.isError);
    } catch (cause) { fail(cause); }
  }, [say, fail]);

  const archive = (id) => setConfirm({ text: `Move ${id} to Trash? It can be restored from Trash on this screen.`, yes: "move to Trash", run: () => projectAction("archive", id) });

  // A viewer comment becomes a note, so the agent gets it with its next call.
  const forwardComment = useCallback(async ({ comment, replies, scene }) => {
    const where = [scene ? `on ${scene}` : null, comment.time != null ? `at ${clock(comment.time)}` : null].filter(Boolean).join(" ");
    const thread = [`${comment.author || "Guest"}: ${comment.text}`, ...replies.map((reply) => `${reply.author || "Guest"}: ${reply.text}`)].join("\n");
    try {
      const note = await sendNote(`A comment from a share link${where ? ` ${where}` : ""}:\n${thread}`.slice(0, 2000), {
        ...(comment.sceneId && scene ? { scene: comment.sceneId } : {}), ...(comment.time != null && scene ? { t: comment.time } : {}),
      });
      say(`${note?.id ?? "Note"}: sent ${comment.author || "Guest"}'s comment to the agent.`);
    } catch (cause) { fail(cause); }
  }, [sendNote, say, fail]);

  const dropFiles = useCallback(async (files) => {
    for (const file of files) {
      try {
        const media = await server.uploadMedia(file, projectId);
        const size = media.width && media.height ? ` ${media.width}×${media.height}` : "";
        say(`Added ${media.name} to the media library.`);
        if (projectId) await sendNote(`I added media "${media.name}" (${media.mime}${size}): src ${media.src}. Use it if it fits.`);
      } catch (cause) { fail(cause); }
    }
  }, [projectId, sendNote, say, fail]);

  const runCommand = useCallback((command) => {
    setCommandOpen(false);
    switch (command.action) {
      case "projects": case "crew": case "inspire": case "library": case "shares": case "settings": case "help": case "transcript": case "variants": setScreen({ name: command.action }); return;
      // The blind pick box comes back (put off with esc).
      case "picks": setScreen({ name: "main" }); setPicksLater(null); return;
      // Try options (tries.jsx): the open round, else the newest.
      case "try": setScreen({ name: "try" }); return;
      // The newest storyboard stop, else the board now, read only ("not asked yet").
      case "board": {
        const boardRound = [...(data?.agent?.stops?.rounds ?? [])].reverse().find((entry) => entry.kind === "board");
        setScreen(boardRound ? { name: "stop", id: boardRound.id } : { name: "board" });
        return;
      }
      case "turn":
        if (!data?.agent?.turns.some((entry) => entry.id === command.value)) { say(`There is no turn ${command.value}.`, true); return; }
        setScreen({ name: "turn", turn: command.value }); return;
      case "note": {
        // While playing, the note is about the frame on screen now.
        const at = player.playing ? frameStart(player.time(), fps) : time;
        sendNote(command.value, { t: Math.round(at * 100) / 100, ...(scene ? { scene: scene.id } : {}) }).then((note) => say(`${note?.id ?? "Note"} queued.`)).catch(fail);
        return;
      }
      case "hold": toggleHold(command.value, command.note ?? ""); return;
      case "open": openProject(command.value); return;
      case "follow": setFollow((value) => !value); return;
      case "overlay": setOverlays((value) => ({ ...value, [command.value]: !value[command.value] })); return;
      case "boxes": toggleBoxes(); return;
      case "export": exportScene(command.value); return;
      case "cancel-render": cancelRender(); return;
      case "mark-seen": markTimelineSeen(); return;
      // A view of the agent pane: the pane gets the focus with it.
      case "view": setAgentView(command.value); focusPane(2); return;
      default: say("That command does nothing here.", true);
    }
  }, [data, time, fps, player, scene, sendNote, toggleHold, openProject, exportScene, cancelRender, focusPane, say, fail]); // eslint-disable-line react-hooks/exhaustive-deps

  // The boxes on the frame: the check's findings and the agents' marks, on or off together.
  const toggleBoxes = () => setOverlays((value) => { const shown = !(value.findings || value.marks); return { ...value, findings: shown, marks: shown }; });

  // The command list (⌘K): every view, screen and action by name (screens.jsx CommandLine).
  const commandItems = [
    ...[["agent", "the agent at work: its task, calls, why and next"], ["session", "needs you, agents, brief, stops, plan, media, renders"], ["log", "the agent's turns"],
      ["checks", "the quality findings"], ["notes", "your notes and share-link comments"], ["seen", "the pictures the agent looked at"]]
      .map(([id, hint]) => ({ id: `view-${id}`, words: id, hint, command: { action: "view", value: id } })),
    { id: "crew", words: "crew", hint: "every agent (F2)", keys: "F2", command: { action: "crew" } },
    { id: "inspire", words: "inspire", hint: "references (F3)", keys: "F3", command: { action: "inspire" } },
    { id: "library", words: "library", hint: "everything the agent can use (F4)", keys: "F4", command: { action: "library" } },
    { id: "projects", words: "projects", hint: "open, duplicate, Trash", command: { action: "projects" } },
    { id: "variants", words: "variants", hint: "compare and pick a variant", command: { action: "variants" } },
    { id: "picks", words: "picks", hint: "blind A or B", command: { action: "picks" } },
    { id: "storyboard", words: "storyboard", hint: "the board, read only", command: { action: "board" } },
    { id: "try", words: "try options", hint: "versions of one moment to pick from", command: { action: "try" } },
    { id: "render", words: "render", hint: "a final render of this scene", keys: "r", command: { action: "export", value: { quality: "final" } } },
    { id: "draft", words: "export draft", hint: "a quick draft render", command: { action: "export", value: { quality: "draft" } } },
    { id: "cancel", words: "cancel render", hint: "the newest render that runs", keys: "x", command: { action: "cancel-render" } },
    { id: "shares", words: "shares", hint: "share links: make, revoke", command: { action: "shares" } },
    { id: "hold", words: data?.hold?.on ? "release" : "hold", hint: data?.hold?.on ? "agent writes work again" : "pause agent writes", keys: "h", command: { action: "hold", value: !data?.hold?.on } },
    { id: "follow", words: "follow", hint: follow ? "follow the agent: on, turn off" : "follow the agent: off, turn on", keys: "f", command: { action: "follow" } },
    { id: "safe", words: "safe", hint: "the safe area on the frame", keys: "s", command: { action: "overlay", value: "safe" } },
    { id: "grid", words: "grid", hint: "a grid on the frame", keys: "g", command: { action: "overlay", value: "grid" } },
    { id: "boxes", words: "boxes", hint: "findings and the agents' marks on the frame", keys: "b", command: { action: "boxes" } },
    { id: "mark-seen", words: "mark seen", hint: "the timeline's ▾ changes", keys: "l", command: { action: "mark-seen" } },
    { id: "transcript", words: "transcript", hint: "every call, raw", keys: "t", command: { action: "transcript" } },
    { id: "settings", words: "settings", hint: "stops, approvals, rendering, agents", command: { action: "settings" } },
    { id: "help", words: "keys", hint: "every key", keys: "?", command: { action: "help" } },
  ];

  // ---- keys ------------------------------------------------------------------------------------
  const lengths = {
    1: needs.length,
    3: data ? seenImages(data).length : 0,
    4: logTab === "log" ? turns.length : logTab === "notes" && data ? noteCursorRows(noteGroups(noteRows(data), data.agent?.stopped ?? [])).length : 0,
    5: timelineRows(scene).length,
  };

  const run = (action) => {
    if (action.startsWith("pane-")) {
      const rest = action.slice(5);
      // "next" steps through the three panes.
      if (rest === "next") focusPane((pane % 3) + 1);
      else focusPane(Number(rest));
      return;
    }
    if (action.startsWith("pick-")) { pickVariant(Number(action.slice(5)) - 1); return; }
    const screenName = screen.name;
    switch (action) {
      case "help": setScreen({ name: "help" }); return;
      case "stage": focusPane(1); return;
      case "crew": setScreen({ name: "crew" }); return;
      case "inspire": setScreen({ name: "inspire" }); return;
      case "library": setScreen({ name: "library" }); return;
      case "command": setCommandOpen(true); return;
      // ⌘K opens the command list, and closes it again when it is open.
      case "command-toggle": setCommandOpen((open) => !open); return;
      case "filter": setLogTab("log"); setFilterOpen(true); focusPane(phone ? 4 : 2); requestAnimationFrame(() => window.document.getElementById("log-filter")?.focus()); return;
      case "safe": case "grid": setOverlays((value) => ({ ...value, [action]: !value[action] })); return;
      case "boxes": toggleBoxes(); return;
      case "zoom": setZoomed(true); return;
      case "unzoom": setZoomed(false); return;
      case "play":
        if (!scene) return;
        if (player.playing) stopPlaying(); else startPlaying();
        setCheckpoint(null); return;
      case "frame-back": case "frame-forward": {
        const stopped = stopPlaying();
        setView((value) => ({ ...value, time: Math.max(0, Math.min(duration, Math.round(((stopped ?? Math.min(value.time, duration)) + (action === "frame-back" ? -1 : 1) / fps) * fps) / fps)) }));
        return;
      }
      // A good or bad mark: while playing, a range from up to 3 s before (you click after the moment).
      case "mark-good": case "mark-bad": {
        if (!scene) return;
        const kind = action === "mark-good" ? "good" : "bad";
        const at = player.playing ? frameStart(player.time(), fps) : time;
        const entry = reactions.mark(kind, scene.id, at, player.playing);
        say(`${kind} mark at ${entry.playing ? `${entry.a} to ${entry.b}` : entry.b} s`);
        return;
      }
      case "turn-back": stepTurn(-1); return;
      case "turn-forward": stepTurn(1); return;
      case "scene-back": stepScene(-1); return;
      case "scene-forward": stepScene(1); return;
      case "note": startNote(); return;
      case "allow": case "allow-always": case "deny": case "deny-always": {
        // The inspire screen answers its own ideas (the top bar's a, or a pressed outside the screen).
        if (screenName === "inspire" && inspireKeys.current) { inspireKeys.current(action.startsWith("allow") ? "allow" : "hold"); return; }
        const row = screenName === "main" ? targetNeed() : null;
        // A row that moved under the key is named first; the next press answers it.
        if (row && movedNeed.current === needKey(row) && (row.type === "approval" || action === "allow")) {
          movedNeed.current = null;
          say(movedNeedWords(row, action), true);
          return;
        }
        if (row?.type === "stop") { stopKeyOnMain(row.round, action); return; }
        if (row?.type === "judge") { setJudgeLater(null); return; }
        if (row?.type === "try") { if (action === "allow") setScreen({ name: "try" }); return; }
        // A material question: a picks the recommended option; the others are chips on its row.
        if (row?.type === "material") {
          if (action === "allow") { answerMaterial(row.need, `option ${recommendedOption(row.need)}`); return; }
          say(`${row.need.id}: a picks option ${recommendedOption(row.need)}; the other answers are on its row in "needs you".`, true); return;
        }
        // Ideas are picked where they are shown: a opens the inspire screen; nothing is allowed unseen.
        if (row?.type === "ideas") {
          if (action === "allow") { setScreen({ name: "inspire" }); return; }
          say(`${row.ideas.id} is answered on the inspire screen: press a to open it, then pick the ideas.`, true); return;
        }
        // A stop in another project is answered there, where it is shown: Enter opens it.
        if (row?.type === "elsewhere") { say(`${row.round.id} waits in ${row.name}: press Enter on its row in "needs you" to open ${row.name}, then answer it there.`, true); return; }
        const approval = screenName === "approval" ? data?.approvals.find((entry) => entry.id === screen.id) : row?.approval;
        if (!approval || approval.status !== "pending") { say("Nothing is waiting for an answer.", true); return; }
        // The request a and d answer is the one the orange top line names (and the phone shows
        // every request as a card), so nothing is allowed or denied unseen.
        answer(approval.id, action.startsWith("allow") ? "allow" : "deny", action.endsWith("always"));
        return;
      }
      case "approval-note": approvalNoteRef.current?.focus(); return;
      case "stop-approve": case "stop-note": case "stop-redo": {
        // Tab on a shot row of the phone's stack (the main screen): the waiting card's note.
        if (action === "stop-note" && screen.name === "main" && waitingStop) { focusStopNote(waitingStop.id); return; }
        if (waitingStop?.id !== screen.id) {
          say(waitingStop ? `${screen.id} is not waiting for an answer; ${waitingStop.id} waits now: press Esc, then Enter on ${waitingStop.id} in "needs you".` : `${screen.id} is not waiting for an answer.`, true);
          return;
        }
        if (action === "stop-note") focusStopNote(waitingStop.id);
        else pressStop(waitingStop, action === "stop-approve" ? "approve" : "redo");
        return;
      }
      case "stop-always-off": say(STOP_ALWAYS_OFF, true); return;
      case "stop-shot-note": openShotNote(); return;
      // c on a waiting storyboard's screen with no shot row focused: how to pick one.
      case "stop-shot-pick": if (waitingStop?.id === screen.id && waitingStop.kind === "board") say("Press j or k to pick a shot, then c to leave a note on it."); return;
      case "undo": { const turnId = undoTarget(); if (turnId) undo(turnId); else say("No agent turn has edits to revert.", true); return; }
      case "hold": toggleHold(); return;
      case "full-frame": setFull((value) => !value); return;
      case "export": exportScene(); return;
      case "transcript": setScreen({ name: "transcript" }); return;
      case "seen": markTimelineSeen(); return;
      case "cancel-render": cancelRender(); return;
      case "follow": setFollow((value) => { say(value ? "Follow agent off." : "Follow agent on: the stage jumps to the agent's last edit."); return !value; }); return;
      case "duplicate": { const project = data?.projects[cursors.projects]; if (project) projectAction("duplicate", project.id); return; }
      case "archive": { const project = data?.projects[cursors.projects]; if (project) archive(project.id); return; }
      case "reject": rejectVariants(null); return;
      case "down": case "up": {
        // In [3] the pictures run oldest to newest from left to right, and the list is newest
        // first: j and ↓ go to the next picture to the right (newer), k and ↑ to the left.
        const step = (action === "down" ? 1 : -1) * (screenName === "main" && list === 3 ? -1 : 1);
        if (screenName === "stop" || screenName === "board") stepShot(step);
        else if (screenName === "projects") moveCursor("projects", data?.projects.length ?? 0, step);
        else if (screenName === "variants") moveCursor("variants", choices.scenes.length, step);
        else if (screenName === "main" && list === 3) stepSeen(step);
        else if (screenName === "main" && list !== null && lengths[list] !== undefined) {
          moveCursor(list, lengths[list], step);
          if (list === 1) movedNeed.current = null;
        }
        return;
      }
      // ← and → in the seen view: the older picture (to the left), the newer one (to the right).
      case "left": case "right":
        if (screenName === "main" && list === 3) stepSeen(action === "left" ? 1 : -1);
        return;
      case "open": {
        if (screenName === "projects") { const project = data?.projects[cursors.projects]; if (project) openProject(project.id); return; }
        if (screenName === "variants") { pickVariant(cursors.variants); return; }
        if (screenName !== "main") return;
        if (list === 1 && needs[cursors[1]]) {
          const row = needs[cursors[1]];
          if (row.type === "stop") openStop(row.round);
          else if (row.type === "elsewhere") openProject(row.projectId);
          else if (row.type === "ideas") setScreen({ name: "inspire" });
          else if (row.type === "judge") setJudgeLater(null);
          else if (row.type === "try") setScreen({ name: "try" });
          else if (row.type === "material") say(`${row.need.id}: a picks option ${recommendedOption(row.need)}; click a chip on its row for another answer.`);
          else setScreen({ name: "approval", id: row.approval.id });
        }
        if (list === 3) { const image = data && seenImages(data)[cursors[3]]; if (image) setEnlarged((value) => (value === image.file ? null : image.file)); }
        if (list === 4 && logTab === "log" && turns[cursors[4]]) {
          const id = turns[cursors[4]].id;
          setExpanded((value) => (value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]));
          selectTurn(id);
        }
        // Enter on a fixed note: looks good.
        if (list === 4 && logTab === "notes" && data) {
          const row = noteCursorRows(noteGroups(noteRows(data), data.agent?.stopped ?? []))[cursors[4]];
          if (row?.type === "note" && row.note.status === "addressed") noteAct({ action: "resolve", id: row.id }, `${row.id} done.`);
        }
        if (list === 5) { const row = timelineRows(scene)[cursors[5]]; if (row) selectLayer(selectedLayer === row.id ? null : row.id); }
        return;
      }
      case "back":
        if (commandOpen) { setCommandOpen(false); return; }
        if (draft && window.document.activeElement === noteRef.current) { setDraft(null); say("Note discarded."); noteRef.current.blur(); focusPane(phone ? 4 : 2); return; }
        if (isTyping(window.document.activeElement)) { window.document.activeElement.blur(); return; }
        if (rejecting) { setRejecting(false); return; }
        if (screenName !== "main") { setScreen({ name: "main" }); return; }
        if (filterOpen || filter) { setFilter(""); setFilterOpen(false); return; }
        if (enlarged) { setEnlarged(null); return; }
        if (point) { pointAt(null); return; }
        if (checkpoint) { setCheckpoint(null); say("Showing now."); return; }
        if (selectedLayer) { selectLayer(null); return; }
        if (zoomed) setZoomed(false);
        return;
      default:
    }
  };

  const runRef = useRef(run);
  runRef.current = run;
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const commandRef = useRef(commandOpen);
  commandRef.current = commandOpen;
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented) return;
      if (confirmRef.current) {
        if (event.key === "Escape" || event.key === "n") { event.preventDefault(); setConfirm(null); }
        else if (event.key === "y") { event.preventDefault(); const { run: yes } = confirmRef.current; setConfirm(null); yes(); }
        return;
      }
      const active = window.document.activeElement;
      const typing = isTyping(active);
      // No control has focus: only the page, or a full screen's own container.
      const idle = !active || active === window.document.body || Boolean(active.matches?.("section.screen"));
      // A storyboard shot row that takes a note (a waiting board stop's, board.jsx): c opens it.
      const shot = Boolean(active?.closest?.("article.board-shot[data-notes]"));
      // The row itself (after Esc in its note): Tab goes to the card's note, not back into the shot's.
      const row = Boolean(active?.matches?.("article.board-shot[data-notes]"));
      const action = keyAction(event, { screen: commandRef.current ? "command" : screenRef.current.name, typing, idle, shot, row });
      if (!action) return;
      // ← and → step through the pictures of the seen view only; elsewhere they keep the browser's own job.
      if ((action === "left" || action === "right") && !(screenRef.current.name === "main" && listRef.current === 3)) return;
      // Enter and space on a focused button, link or checkbox use it; the key does not run twice.
      if ((event.key === "Enter" || event.key === " ") && active && active !== window.document.body && active.matches?.("button, a, summary, input, select, [role=slider], [role=tab]")) return;
      // An answered approval or stop has no note field, so Tab keeps its normal job there.
      if (action === "approval-note" && !approvalNoteRef.current) return;
      if (action === "stop-note" && !stopNoteRef.current) return;
      event.preventDefault();
      runRef.current(action);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The Mac app's Edit menu: Undo (⌘Z) outside a text field is the u key (revert a turn, asks
  // first). A reverted turn is a new revision, so Redo has nothing to bring back.
  useEffect(() => listenForEditCommands((action) => {
    if (confirmRef.current) return;
    if (action === "undo") runRef.current("undo");
    else say("Redo works in text fields. To bring back a reverted turn, send the agent a note.");
  }), [say]);

  // ---- rendering ---------------------------------------------------------------------------------
  // The preview cache's segments of this scene (previewCache.jsx): the stage plays them, the
  // timeline shows which are ready. None at a checkpoint or with the setting off.
  const previewList = usePreviewList({ projectId: data?.projectId, sceneId: scene?.id, rev: checkpoint?.rev ?? data?.record?.revision, playing,
    bump: data?.previewSeq, off: Boolean(checkpoint) || data?.settings?.compute?.previewCache === false });
  if (!data) {
    return (
      <div className="dash">
        <main className="screen" aria-live="polite"><p><strong>kino</strong></p><p className={error ? "err" : "dim"}>{error || "Loading the dashboard…"}</p>
          {error ? <button type="button" className="tb tb-box" onClick={() => load(null)}>try again</button> : null}</main>
      </div>
    );
  }

  const codes = data.agent?.codes ?? {};
  const findings = (checks?.data?.findings ?? []).map((finding) => {
    const ref = String(finding.ref ?? "");
    const layer = scene?.layers.find((entry) => ref === entry.id || ref === codes[entry.id] || ref.startsWith(`${entry.id}.`) || (codes[entry.id] && ref.startsWith(`${codes[entry.id]}.`)));
    return { layerId: layer?.id, severity: finding.severity, text: `${finding.rule} ${finding.message}` };
  }).filter((finding) => finding.layerId);
  const paneProps = (number) => ({ focused: pane === number, zoomed: zoomed && pane === number, onFocus: setPane });
  // While a question (the confirm box) is open, everything behind it is inert: it cannot be
  // focused or clicked, so only the question's own buttons and y, n, Esc answer it.
  // The judge box (judge.jsx): an open round shows until esc (later); a done one while you look.
  const judge = data.agent?.judge ?? null;
  const judgeShown = Boolean(judge && screen.name === "main" && ((judge.status === "open" && judgeLater !== judge.id) || (judge.status === "done" && judgeReview === judge.id)));
  // The pick box: pairs the sitting still takes, less the ones picked here the server has not dropped yet.
  const picks = data.picks ? { ...data.picks, pairs: data.picks.pairs.filter((pair) => !picksDone.includes(pair.pair_id)) } : null;
  const picksShown = Boolean(picks?.pairs.length && screen.name === "main" && !judgeShown && picksLater !== picks.queued);
  const waiting = Boolean(confirm) || judgeShown || picksShown;
  const stageRev = checkpoint?.rev ?? data.record?.revision;
  const sceneLayers = scene?.layers ?? [];

  // On a phone the note is written in the notes view (the desktop writes it in the stage's bubble).
  const composer = draft && phone ? (
    <form className="note-form" aria-label="New note" onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
      <label htmlFor="note-text">note at {clock(draft.time)}{draft.area ? ` · area ${draft.area.x},${draft.area.y} ${draft.area.width}×${draft.area.height}` : ""}</label>
      <textarea id="note-text" ref={noteRef} value={draft.text} maxLength={2000} placeholder="What should the agent change? Enter sends, Shift+Enter is a new line."
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitDraft(); } }} />
      <div className="row">
        <label><input type="checkbox" checked={draft.urgent} onChange={(event) => setDraft({ ...draft, urgent: event.target.checked })} /> urgent</label>
        <label htmlFor="note-layer">layer</label>
        <select id="note-layer" value={draft.layer ?? ""} onChange={(event) => setDraft({ ...draft, layer: event.target.value || null })}>
          <option value="">none</option>
          {sceneLayers.map((layer) => <option key={layer.id} value={layer.id}>{cut(layer.name || layer.id, 24)}</option>)}
        </select>
        <button type="submit" className="tb tb-box tb-accent">[<span className="key">Enter</span>] send</button>
        <button type="button" className="tb tb-box" onClick={() => { setDraft(null); say("Note discarded."); }}>[<span className="key">Esc</span>] discard</button>
      </div>
    </form>
  ) : null;

  // The note bubble on the stage (StagePane places it beside its dot): the words, then one quiet
  // line with the time and what the note is about. Enter sends, ⌘Enter sends it as urgent,
  // Shift+Enter is a new line, Esc drops it.
  const layerName = (id) => sceneLayers.find((layer) => layer.id === id)?.name || id;
  const about = draft ? (draft.layer ? layerName(draft.layer) : draft.area ? "this spot" : "the whole frame") : "";
  const dropDraft = () => { setDraft(null); say("Note discarded."); };
  const noteBubble = draft && !phone ? (
    <form className="note-bubble" aria-label="New note" onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
      <textarea id="note-text" ref={noteRef} rows={2} value={draft.text} maxLength={2000} aria-label={`Note at ${clock(draft.time)} about ${about}`}
        placeholder={draft.layer ? `what should change in ${about}?` : "what should change here?"}
        onChange={(event) => { const text = event.target.value; setDraft((value) => (value ? { ...value, text } : value)); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitDraft(event.metaKey || event.ctrlKey); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dropDraft(); }
        }} />
      <div className="note-bubble-meta">
        <span className="note-about">{clock(draft.time)} · {about}</span>
        <button type="button" className="tb" onClick={dropDraft} aria-keyshortcuts="Escape" title="Drop this note (Esc)">esc</button>
        <button type="button" className="tb" onClick={() => submitDraft(true)} aria-keyshortcuts="Meta+Enter" title="Send it marked urgent (⌘Enter)">⌘↵ urgent</button>
        <button type="submit" className="tb note-send" aria-keyshortcuts="Enter" title="Send (Enter)">↵ send</button>
      </div>
    </form>
  ) : null;

  // The message box at the bottom of the agent pane: a note about the whole video.
  const messageTo = shownAgent(data, now)?.name ?? "the agent";
  const noteLine = phone ? null : (
    <form className="message-box" aria-label={`Message to ${messageTo}`} onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
      <div className="message-field">
        <textarea id="message-text" rows={1} value={messageText} maxLength={2000} aria-label={`Message to ${messageTo} about the whole video`}
          placeholder={`note for ${messageTo}`}
          onChange={(event) => setMessageText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(event.metaKey || event.ctrlKey); } }} />
        <button type="submit" className="tb message-send" aria-label="Send" title="Send (Enter; ⌘Enter marks it urgent)">↵</button>
      </div>
      <p className="message-hint">{readerLine(noteReader(data, now))}</p>
    </form>
  );

  // ---- the top line ----------------------------------------------------------------------------
  // kino, the project, the F1/F2(/F3) tabs, the agent at work now, ⌘K and r render. While
  // something waits for the person the whole line turns orange and says who asks and what to do.
  const nameOf = (id) => data.agents?.find((agent) => agent.id === id)?.name;
  const targetIndex = keyTarget(needs, list === 1 ? cursors[1] : null);
  // On the inspire screen the ideas waiting there are answered in place (a allow, d not yet).
  const ideasRow = screen.name === "inspire" ? needs.find((row) => row.type === "ideas") ?? null : null;
  const asking = screen.name === "main" ? needsBar(needs, targetIndex, nameOf) : ideasRow ? needsBar([ideasRow], 0, nameOf, { here: true }) : null;
  const need = screen.name === "main" && needs.length ? needWords(needs[targetIndex] ?? needs[0], nameOf) : null;
  const agentShown = shownAgent(data, now);
  const askingAgent = ideasRow ? data.agents?.find((agent) => agent.id === ideasRow.ideas.by?.id) ?? null : need?.agentId ? data.agents?.find((agent) => agent.id === need.agentId) ?? agentOfCalls(data, need.agentId) : null;
  const workChips = agentChips(data, now);
  const rendering = runningRender(data);
  const renderBy = rendering ? renderAgent(data, rendering) : null;
  const renderPercent = rendering ? Math.round((rendering.progress ?? 0) * 100) : null;
  // The project menu: the open project first, then the others (newest first), then all projects.
  const projectOptions = [
    ...(data.projects ?? []).filter((entry) => !entry.archived).slice(0, 8).map((entry) => ({ value: entry.id, label: cut(entry.name || entry.id, 28) })),
    { value: "@projects", label: "all projects…" },
  ];
  const renderOptions = [
    { value: "final", label: "final mp4" }, { value: "draft", label: "draft mp4" },
    { value: "gif", label: "final gif" }, { value: "webm", label: "final webm" }, { value: "mov", label: "final mov" },
    ...(rendering ? [{ value: "@cancel", label: "cancel render" }] : []),
  ];
  const pickRender = (value) => {
    if (value === "@cancel") cancelRender();
    else if (value === "final" || value === "draft") exportScene({ quality: value });
    else exportScene({ quality: "final", format: value });
  };
  const tab = (name, icon, word, onClick, key, extra = null) => (
    <button type="button" className="tab" data-view={name} aria-current={screen.name === name ? "page" : undefined} aria-keyshortcuts={key} title={`${word} (${key})`} onClick={onClick}>
      <Icon name={icon} /><span className="tab-word">{word}</span>{extra}
    </button>
  );
  const topline = (
    <header className={`topline${asking && !phone ? " asking" : ""}`} inert={waiting}>
      <span className="title" title={projectName ? `kino: ${projectName}` : undefined}>
        <span className="brand"><span className="brand-mark" aria-hidden="true" />kino</span>
        {projectName ? <><span className="sr-only">, </span>
          <Menu id="project-menu" label={cut(projectName, 28)} ariaLabel={`Project: ${projectName}`} listLabel="Projects" title="Open another project"
            value={projectId} options={projectOptions} className="project-menu"
            onPick={(value) => (value === "@projects" ? setScreen({ name: "projects" }) : value !== projectId ? openProject(value) : null)} /></> : null}
      </span>
      {/* The views: the stage (F1), the crew (F2; it counts what waits for you), inspire (F3) and the library (F4). */}
      <nav className="tabs" aria-label="Views">
        {tab("main", "monitor", "stage", () => run("stage"), "F1")}
        {tab("crew", "users", "crew", () => setScreen({ name: "crew" }), "F2",
          needs.length ? <span className="tab-count" aria-label={`, ${needs.length} waiting for you`}>{needs.length}</span> : null)}
        {tab("inspire", "compass", "inspire", () => setScreen({ name: "inspire" }), "F3")}
        {tab("library", "library", "library", () => setScreen({ name: "library" }), "F4")}
      </nav>
      <div className={`topbar${asking ? " asking" : ""}`}>
        {asking ? (
          // Something waits for you: one urgent chip says who asks and what, and its answer button.
          <span className="needs-chip" role="status">
            {askingAgent ? <Bot color={askingAgent.color} mood="wait" size={14} still={still} /> : <span className="chip-dot" aria-hidden="true" />}
            <strong>{asking.who} needs you</strong> <span className="asking-what">{need?.todo ?? asking.what}{asking.more ? ` · +${asking.more} more` : ""}</span>
            {asking.keys.length ? <button type="button" className="tb chip-answer" onClick={() => run("allow")} aria-keyshortcuts="a" title={`${asking.keys[0][1]} (a)`}>{asking.keys[0][1]}</button> : null}
            {phone && asking.keys[1] ? <button type="button" className="tb chip-answer" onClick={() => run("deny")} aria-keyshortcuts="d" title={`${asking.keys[1][1]} (d)`}>{asking.keys[1][1]}</button> : null}
          </span>
        ) : workChips.length ? (
          // One chip per agent at work: its color, its name and what it does in a few words.
          <span className="agent-chips" aria-label="Agents at work">
            {workChips.map((chip) => (
              <span key={chip.id} className={`agent-chip s-${chip.status}`} style={chip.color ? { "--who": chip.color } : undefined}
                title={`${chip.name}: ${data.live?.latest?.[chip.id]?.label ?? chip.doing}`}>
                <span className="chip-dot" aria-hidden="true" /><span className="chip-name">{chip.name}</span> <span className="chip-doing">{chip.id === renderBy?.id && rendering ? `render ${renderPercent}%` : chip.doing}</span>
              </span>
            ))}
          </span>
        ) : idleLine(data, now) ? <span className="idle-line">{idleLine(data, now)}</span> : <span className="idle-line">no agent yet</span>}
        {/* Follow is on unless you turn it off (f); only "off" is shown, as a reminder. */}
        {!follow || phone ? <button type="button" className={`tb follow${follow ? " on" : ""}`} aria-pressed={follow} aria-keyshortcuts="f" title="Follow the agent (f)" onClick={() => run("follow")}><span className="dot" aria-hidden="true" /><span className="tab-word"> follow {follow ? "on" : "off"}</span></button> : null}
        {message ? <span className={`message ${message.error ? "err" : "dim"}`} title={message.text}>{message.text}</span> : null}
        <span className="top-right">
          {data.recording ? (
            <button type="button" className="tb top-button recording" onClick={stopRecording}
              title="An agent is recording the screen. Stop it (the recording so far is kept)" aria-label={`Recording the screen, ${recClock(now - data.recording.startedAt)}. Stop recording`}>
              <span className="rec-dot" aria-hidden="true" />rec {recClock(now - data.recording.startedAt)} · stop</button>
          ) : null}
          <button type="button" className={`tb top-button${data.hold?.on ? " held" : ""}`} onClick={() => toggleHold()} aria-keyshortcuts="h" aria-pressed={Boolean(data.hold?.on)}
            title={data.hold?.on ? "Release: agent writes work again (h)" : "Hold: pause agent writes (h)"}>
            <Icon name="hold" />{data.hold?.on ? "release" : screen.name === "crew" ? "hold all" : "hold"}</button>
          {phone ? null : <>
            <button type="button" className="tb top-button" onClick={makeShare} disabled={!projectId} title="Make a view link and copy it">
              <Icon name="link" /><span className="tab-word">share</span></button>
            <button type="button" className="tb top-button icon-only" onClick={() => setScreen({ name: "settings" })} aria-label="Settings" title="Settings">
              <Icon name="gear" /></button>
          </>}
          <span className={`render-split${rendering ? " is-rendering" : ""}`} style={renderBy?.color ? { "--who": renderBy.color } : undefined}>
            <button type="button" className="tb top-render" onClick={() => (rendering ? setAgentView("session") : exportScene())} aria-keyshortcuts="r" disabled={!scene}
              title={rendering ? `Rendering ${renderPercent}%${renderBy ? ` for ${renderBy.name}` : ""}: show the renders` : "Render this scene, final mp4 (r)"}
              aria-label={rendering ? `Rendering, ${renderPercent} percent. Show the renders.` : "Render"}>
              <Icon name="render" />{rendering ? `${renderPercent}%` : "render"}
              {rendering ? <span className="render-line" style={{ width: `${renderPercent}%` }} aria-hidden="true" /> : null}
            </button>
            <Menu id="render-menu" label="" ariaLabel="Render options" listLabel="Render" title="Render: final, draft, format, cancel"
              value={null} options={renderOptions} onPick={pickRender} className="render-more" />
          </span>
        </span>
      </div>
    </header>
  );

  const stage = (
    <StagePane {...paneProps(1)} data={data} scene={scene} time={time} rev={stageRev} checkpoint={checkpoint?.turn ?? null} full={full} playing={playing} fps={fps} still={still} previewList={previewList}
      marks={reactions.marks} onUnmark={reactions.remove} onClearMarks={reactions.clear}
      overlays={overlays} findings={findings} selectedLayer={selectedLayer} onPin={(area, extra) => startNote(area, true, extra)} draft={draft} noteBubble={noteBubble}
      timeStore={timeStore} fontVersion={fontVersion} sound={{ state: soundState, mix: mix.state, error: mix.error, blocked: SOUND_BLOCKED }} onSoundOn={() => player.resume()} soundTime={player.time}
      onToggleOutlines={toggleBoxes} onSeek={(value) => { stopPlaying(); setView((current) => ({ ...current, time: value })); }}
      need={need && !phone && need.allow && need.watch ? { ...need, onAllow: () => run("allow"), onDeny: () => run("deny"), onNote: () => startNote() } : null}
      onKey={run} onScene={showScene} phone={phone} onNow={() => { setCheckpoint(null); say("Showing now."); }}
      onZoomPane={() => { if (zoomed && pane === 1) setZoomed(false); else { setPane(1); setZoomed(true); } }} />
  );
  // The stop card's data and answers (the stop screen and the phone's stack).
  const stopCard = (round) => ({
    round, document: doc, projectId, note: stopNote(round.id), noteRef: stopNoteRef,
    onNote: (note) => setStopNote(round.id, note), onPress: (press) => pressStop(round, press),
    shotNotes: shotNotes[noteKey(round.id)] ?? {}, onShotNote: (shot, note) => setShotNote(round.id, shot, note),
    noCalls: callNos[noteKey(round.id)] ?? [],
    trying: data ? openTryOf(data) : null, onTry: () => setScreen({ name: "try" }),
    onCallNo: (call, no) => setCallNos((value) => {
      const list = (value[noteKey(round.id)] ?? []).filter((entry) => entry !== call);
      return { ...value, [noteKey(round.id)]: no ? [...list, call] : list };
    }),
  });
  const recentLine = recentStop ? stopLines.find((row) => row.key === recentStop) ?? null : null;
  const saveSettings = async (change) => { try { await server.saveSettings(change); say("Saved."); } catch (cause) { fail(cause); } };
  // The log, checks and notes: a view of the agent pane on a wide screen (bare), a pane of its
  // own with its own tabs on the phone's stack.
  const logProps = {
    data, cursor: list === 4 ? cursors[4] : -1, expanded,
    onToggle: (id) => setExpanded((value) => (value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id])),
    onTurn: (id) => { const index = turns.findIndex((row) => row.id === id); if (index >= 0) setCursors((value) => ({ ...value, 4: index })); selectTurn(id); },
    onReview: (id) => setScreen({ name: "turn", turn: id }), filter, onFilter: setFilter, filterOpen, checks, onCompose: () => startNote(),
    onForwardComment: forwardComment, onNote: noteAct, still, now, time,
  };
  const log = phone
    ? <LogPane {...paneProps(4)} {...logProps} tab={["log", "checks", "notes"].includes(logTab) ? logTab : "log"} onTab={setLogTab} composer={composer} />
    : <LogPane {...logProps} tab={logTab} onTab={setLogTab} composer={null} bare />;
  const session = (
    <SessionPane data={{ ...data, renders: (data.renders ?? []).filter((job) => job.projectId === projectId) }} still={still} now={now}
      sections={sections} onSections={setSections}
      cursor={list === 1 ? cursors[1] : -1} onAnswer={answer} onOpenApproval={(id) => setScreen({ name: "approval", id })} onIdeas={() => setScreen({ name: "inspire" })} onJudge={() => setJudgeLater(null)} onTry={() => setScreen({ name: "try" })} onMaterial={answerMaterial}
      onStop={(round, press) => (press === "approve" && round.kind !== "board" ? pressStop(round, "approve") : openStop(round, press === "redo" ? "redo" : null))}
      onReopen={reopenStop} onKeepAsking={keepAsking} onOpenProject={openProject}
      onCancelRender={cancelRender} onShare={makeShare} onShares={() => setScreen({ name: "shares" })} share={share} onAddFiles={dropFiles} onExport={() => exportScene()} bare />
  );

  let body;
  if (phone && screen.name === "main") {
    body = (
      <main className="phone-stack" aria-label="Dashboard" inert={waiting}>
        {waitingStop ? <StopCard key={waitingStop.id} {...stopCard(waitingStop)} compact />
          : recentLine ? <StopDone row={recentLine} onReopen={reopenStop} onKeepAsking={keepAsking} onDismiss={() => setRecentStop(null)} /> : null}
        {otherStops(data).map((entry) => <StopElsewhere key={`${entry.projectId}/${entry.round.id}`} entry={entry} onOpen={openProject} />)}
        {pending.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} compact now={now} note={approvalNotes[approval.id] ?? ""}
            onNote={(text) => setApprovalNotes((value) => ({ ...value, [approval.id]: text }))} onAnswer={answer} />
        ))}
        {stage}
        {/* Under the stage, so the video stays on the first screen; none for a video started
            without a brief, which gets none. */}
        {brief.startedWithout ? null : <BriefCard rows={brief} open={sections.brief} onToggle={() => setSections((value) => ({ ...value, brief: !value.brief }))} />}
        {stopLines.length ? <StopsCard rows={stopLines} open={sections.stops} onToggle={() => setSections((value) => ({ ...value, stops: !value.stops }))}
          onReopen={reopenStop} onKeepAsking={keepAsking} /> : null}
        {log}
      </main>
    );
  } else if (screen.name === "main") {
    body = (
      <main className={`panes${zoomed ? " zoomed" : ""}${agentView === "seen" && enlarged && seenFiles.includes(enlarged) ? " seen-open" : ""}`} aria-label="Dashboard" inert={waiting}>
        {stage}
        <AgentPane {...paneProps(2)} data={data} agent={askingAgent ?? agentShown} still={still} now={now} view={agentView} onView={setAgentView} needs={needs.length} follow={follow} checks={checks} onRun={run} onAnswer={answer} onMaterial={answerMaterial}
          noteLine={noteLine} views={{
            session, log, checks: log, notes: log,
            seen: <SeenPane data={data} cursor={cursors[3]} enlarged={enlarged} onEnlarge={setEnlarged} still={still} onSelect={pickSeen} bare />,
          }} />
        <TimelinePane {...paneProps(3)} data={data} scene={scene} time={time} cursor={list === 5 ? cursors[5] : -1} selectedLayer={selectedLayer}
          onSeek={(value) => { stopPlaying(); setView((current) => ({ ...current, time: value })); }} onSelectLayer={selectLayer} onTurn={selectTurn} viewTurn={checkpoint?.turn ?? null}
          playing={playing} timeStore={timeStore} point={pointedRange ? point : null} onPoint={pointAt} still={still} now={now}
          needAgent={need?.watch && need.key === "allow" ? need.agentId ?? null : undefined} previewList={previewList} rev={stageRev} />
      </main>
    );
  } else {
    const back = () => setScreen({ name: "main" });
    const screens = {
      projects: () => <ProjectsScreen data={data} cursor={cursors.projects} onCursor={(index) => setCursors((value) => ({ ...value, projects: index }))} onOpen={openProject}
        onDuplicate={(id) => projectAction("duplicate", id)} onArchive={archive} onRestore={restore} onBack={back} />,
      shares: () => <SharesScreen data={data} now={now} onMake={makeLink} onRevoke={revokeLink} onBack={back} />,
      settings: () => <SettingsScreen data={data} now={now} onBack={back} notificationState={notificationState}
        onAskNotifications={async () => setNotificationState(await askForNotifications())}
        onSave={saveSettings} stops={<StopSettings settings={data.settings} onSave={saveSettings} />}
        onClearCache={async () => { try { const value = await server.clearCache(); say("Frame cache cleared."); return value; } catch (cause) { fail(cause); return null; } }}
        onClearRenderCache={async () => { try { const value = await server.clearRenderCache(); say(value.inUse ? `Render cache cleared; ${value.inUse} in use now stayed.` : "Render cache cleared."); return value; } catch (cause) { fail(cause); return null; } }} />,
      turn: () => <TurnScreen data={data} turnId={screen.turn} time={time} onUndo={undo} onBack={back} />,
      variants: () => <VariantsScreen data={data} choices={choices} time={time} cursor={cursors.variants} onCursor={(index) => setCursors((value) => ({ ...value, variants: index }))}
        onPick={pickVariant} rejecting={rejecting} onReject={rejectVariants} onBack={back} />,
      approval: () => <ApprovalScreen approval={data.approvals.find((entry) => entry.id === screen.id)} onBack={back} now={now} onAnswer={answer}
        note={approvalNotes[screen.id] ?? ""} onNote={(text) => setApprovalNotes((value) => ({ ...value, [screen.id]: text }))} noteRef={approvalNoteRef} />,
      stop: () => <StopScreen id={screen.id} row={stopLines.find((row) => row.key === screen.id) ?? null} onBack={back} onReopen={reopenStop} onKeepAsking={keepAsking}
        {...(waitingStop?.id === screen.id ? { ...stopCard(waitingStop), focusNote: Boolean(screen.mode) } : { round: null, projectId })} />,
      // Enter on an agent: back to the stage, at the place its newest call is about, with follow on.
      crew: () => <CrewScreen data={data} now={now} hold={Boolean(data.hold?.on)} still={still} onHold={() => toggleHold()} onBack={back} onHelp={() => setScreen({ name: "help" })}
        onInspire={() => setScreen({ name: "inspire" })} onConfirm={setConfirm} say={say} fail={fail} onWatch={(agent) => {
        const target = data.live?.latest?.[agent.id]?.target;
        const shown = target?.sceneId ? doc?.scenes.find((entry) => entry.id === target.sceneId) : null;
        if (shown) { stopPlaying(); setView({ sceneId: shown.id, time: Math.max(0, Math.min(Number(shown.duration) || 0, target.time ?? target.range?.[0] ?? 0)) }); }
        setFollow(true);
        say(shown ? `Follow agent on · showing where ${agent.name} works.` : "Follow agent on.");
        focusPane(1);
      }} />,
      board: () => <BoardScreen projectId={projectId} document={doc} revision={revision} onBack={back} />,
      try: () => <TryScreen projectId={projectId} tries={data.agent?.tries ?? null} shots={doc?.board?.shots ?? []} onBack={back}
        onAnswer={(round, pick) => server.act("notes", { action: "try", project: projectId, round: round.id, pick }).then((reply) => { if (reply.isError) say(reply.text, true); }, fail)} />,
      library: () => <LibraryScreen document={doc} shots={doc?.board?.shots ?? []} onBack={back}
        onSend={async (text) => { try { await sendNote(text); say("Sent to the agent."); } catch (cause) { fail(cause); throw cause; } }} />,
      inspire: () => <InspireScreen data={data} projectId={projectId} now={now} onBack={back} say={say} keysRef={inspireKeys} still={still} />,
      help: () => <HelpScreen onBack={back} />,
      transcript: () => <TranscriptScreen data={data} onBack={back} />,
    };
    body = <main className={`screen-wrap is-${screen.name}`} style={{ minHeight: 0, overflow: "auto" }} inert={waiting}>{(screens[screen.name] ?? screens.help)()}</main>;
  }

  return (
    <div className={`dash${phone ? " phone" : ""}`} data-project={projectId ?? undefined}
      onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target || !event.relatedTarget) setDragging(false); }}
      onDrop={(event) => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); setDragging(false); dropFiles([...event.dataTransfer.files]); }}>
      {topline}
      {body}
      {judgeShown ? <JudgeBox key={judge.id} projectId={projectId} judge={judge}
        onPick={(pair, pick) => {
          if (judge.pairs.filter((entry) => !entry.pick && entry.n !== pair).length === 0) setJudgeReview(judge.id);
          server.act("notes", { action: "judge", project: projectId, round: judge.id, pair, pick }).then((reply) => { if (reply.isError) say(reply.text, true); }, fail);
        }}
        onLater={() => { setJudgeLater(judge.id); setJudgeReview(null); }} /> : null}
      {picksShown ? <PickBox picks={picks}
        onPick={(pairId, pick, words, note) => {
          setPicksDone((value) => [...value, pairId]);
          server.act("notes", { action: "judge", pair_id: pairId, pick, words, ...(note ? { note } : {}) }).then((reply) => { if (reply.isError) { setPicksDone((value) => value.filter((id) => id !== pairId)); say(reply.text, true); } }, fail);
        }}
        onLater={() => setPicksLater(picks.queued)} /> : null}
      {confirm ? <ConfirmBox text={confirm.text} yes={confirm.yes} onYes={() => { const { run: yes } = confirm; setConfirm(null); yes(); }} onNo={() => setConfirm(null)} /> : null}
      {commandOpen ? <CommandLine onRun={runCommand} onClose={() => setCommandOpen(false)} inert={waiting} items={commandItems} /> : null}
      {phone ? <StatusLine data={data} scene={scene} time={time} playing={playing} timeStore={timeStore} checks={checks} onChecks={showChecks} connection={connection} still={still} now={now} inert={waiting} /> : (
        // The bottom line: the keys on the left, what the top line and panes do not say on the right.
        <div className="bottomline">
          {/* The crew and inspire screens draw their own key lines. */}
          {screen.name !== "inspire" && screen.name !== "crew" ? <KeyLine onKey={run} inert={waiting} need={need?.allow ? need : null} playing={playing} empty={!scene} /> : null}
          <StatusLine data={data} scene={scene} time={time} playing={playing} timeStore={timeStore} checks={checks} onChecks={showChecks} connection={connection} still={still} now={now} inert={waiting} compact />
        </div>
      )}
      <PresenceAnnouncer live={data.live} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{alert}</div>
      {dragging ? <div className="drop-target" aria-hidden="true">drop to add to the media library</div> : null}
    </div>
  );
}

/** Shows what went wrong instead of a blank window, with a reload button. */
export class DashboardBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="dash"><main className="screen">
        <p><strong>kino</strong></p>
        <p role="alert" className="err">The dashboard stopped: {this.state.error.message || "unknown error"}. Your projects are saved.</p>
        <p><button type="button" className="tb tb-box" onClick={() => location.reload()}>reload</button></p>
      </main></div>
    );
  }
}

export default Dashboard;
