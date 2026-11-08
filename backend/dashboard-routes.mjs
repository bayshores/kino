// The dashboard's HTTP routes, under /api/dashboard/ (owner only; backend/index.mjs checks that
// before calling `handle`). What changes something needs the review key that only an open
// dashboard window holds (header x-kino-review); see server/agent/dashboard.mjs.
//
//   GET  snapshot?project=        everything the dashboard shows, in one answer
//   GET  stream?since=&boot=      server-sent events; replays what a reconnecting window missed
//   GET  frame?project&scene&t&w&rev   one stage frame from the export renderer (PNG, cached);
//                                      low=1: a thumbnail, drawn only while no other frame is
//   GET  mix?project&scene&rev&fps     the scene's sound, mixed as an MP4 export mixes it, for live
//                                      playback (WAV, cached; 204 when nothing is heard)
//   GET  preview?project&scene&rev&playing   the scene's preview segments (preview-scheduler.mjs):
//                                      {on, rev, fps, width, height, segments: [{index, start, end,
//                                      key, ready, url?}]}; playing=1: playback is on, renders wait
//   GET  preview/<key>.mp4        a ready preview segment (silent H.264, Range requests work)
//   GET  seen/<project>/<file>    an image kino returned to the agent
//   GET  judge/<project>/<file>   a picture of the latest judge round (agent/judge.mjs)
//   GET  try/<project>/<T1-B.mp4>   one option's clip of a try round (agent/tries.mjs)
//   GET  picks/<pair>/<left|right>   one video of a waiting blind pair (agent/picks.mjs; Range works)
//   GET  board?project&rev&page   one page of the storyboard, as look {mode:"board"} draws it (PNG)
//   GET  board-data?project&stop|rev   the storyboard a board stop showed, as data (JSON)
//   GET  board-shot?project&rev&shot&part&w   one shot's source frame, still, last frame or option still (PNG)
//   GET  library                  everything an agent can use, by kind and by what it does (JSON)
//   GET  library-sample?kind&name  one entry's sample: a short document and the moment its card shows
//   GET  library-still?kind&name   that moment drawn by the export renderer, 480 px wide (PNG)
//   GET  turn?project&turn        one turn for turn review: revisions, changes and calls
//   GET  inspire/thumb/<video id> a YouTube reference's thumbnail, kept by backend/inspire.mjs
//   GET  inspire/strip/<video id>/<NN.jpg>  one of its frame strips (6 small frames side by side)
//   GET  inspire/sound/<video id> a measured sound effect's short preview (AAC in .m4a)
//   GET  inspire/song/<key>       a measured song's preview (yt-, ov- or ia-<id>; backend/soundtrack.mjs)
//   GET  renders/<id>/file        download a finished render
//   POST review-key               a new review key (same-origin browser requests only)
//   POST act/<verb>               an agent verb run by you (notes add, render, project, …)
//   POST undo {project, turn}     revert a turn and every later turn, newest first
//   POST approvals/<id>           {decision: allow|deny, always?, note?}
//   POST hold {on, note?}         pause or resume agent writes
//   POST stops {project, action, …}   a stop: answer {id, rev, read_as, words?} a waiting one,
//                                 reopen {id} an answer, keep_asking (undo "stop asking")
//   GET/PUT settings              your settings
//   GET  cache · POST cache/clear the stage frame cache (GET also reports the render cache)
//   POST render-cache/clear       empty the render cache (finished segments; entries in use stay)
//   GET  render/devices?refresh=1 the graphics cards and video encoders here, the environment
//                                 variables that override your rendering settings, and what drew
//                                 and encoded the last render (refresh=1 detects them again)
//   POST point {project, sceneId, layerIds, range?}   what you are pointing at: layers, a time
//                                 range [start, end] in seconds (needs sceneId), or both
//   POST channel-sent {project, note}         the MCP server pushed a note through a channel
//   The crew (agent/crew.mjs, the crew screen F2):
//   GET  crew                     members, held parts, start rules, activity, counts, canStart
//   GET  crew/<id>/log            the end of an agent kino started's output {out, err}
//   POST crew/start {kind?, task, may?, project?, budget?}   start Claude Code or Codex
//   POST crew/<id>/hold {on}      hold (true) or release (false) one agent
//   POST crew/<id>/stop           stop one agent (ends the process kino started)
//   POST crew/release {project, part}   free a held part (its key, such as "music")
//   PUT  crew/rules {notes?, leads?, timers?, atOnce?, budget?, kind?}   who may start agents
//   POST crew/timers {kind?, task, may?, project?, daily|everyHours, budget?, name?}   add a timer
//   POST crew/timers/<id>/remove  remove a timer
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expandComponents } from "../engine/linkedComponents.js";
import { documentChanges } from "../engine/documentChanges.js";
import { FPS_HELP, parseFps } from "../engine/frameRate.js";
import { ensureDocumentFonts } from "./font-selection.mjs";
import { sceneKey } from "./agent/look.mjs";
import { refName } from "./agent/describe.mjs";
import { PALETTE } from "./agent/live.mjs";
import { assignCodes } from "./agent/refs.mjs";
import { briefSummary } from "./agent/brief.mjs";
import { judgeView } from "./agent/judge.mjs";
import { triesView } from "./agent/tries.mjs";
import { keepAsking, StopError, stopRules, stopsSummary } from "./agent/stops.mjs";
import { sceneSoundClips, soundMixArgs, soundMixDuration } from "./export.mjs";
import { runExportProcess } from "./export-process.mjs";
import { autoGraphics, listGraphics, savedGraphics } from "./render-devices.mjs";
import { listVideoEncoders } from "./mp4-encoders.mjs";
import { workerCap } from "./raster-workers.mjs";
import { makeTempFolder, removeTempFolder } from "./temp-folders.mjs";
import { createPreviewScheduler } from "./preview-scheduler.mjs";
import { openNeeds } from "./agent/needs.mjs";
import { libraryCatalog } from "./agent/library-catalog.mjs";
import { SONG_KEY } from "./soundtrack.mjs";

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NODE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SEEN_FILE = /^[a-z]+-[a-f0-9]{12}\.png$/;
const PREPARED_KEPT = 24;
// Sound mixes kept in memory (GET mix), oldest dropped first past this many bytes of WAV (the
// newest is always kept). A mix is 48 kHz 16-bit stereo, 11.5 MB a minute: 1.9 MB for 10 s,
// 115 MB for the longest scene (ten minutes, engine/schema.js MAX_TIME). This holds two ten-minute
// mixes, so going back and forth between two long scenes does not make them again (8.6 s each,
// measured). WAV, not FLAC or Opus: the dashboard runs on this computer, where the 115 MB take
// about 0.1 s to fetch, and the browser decodes WAV fastest (0.2 s against 0.5 s for FLAC and
// 1.4 s for Opus, which also changes the sound). COMPATIBILITY.md "Ten-minute scenes".
const MIX_BYTES_KEPT = 256 * 1024 * 1024;
const MIX_KEYS_KEPT = 64;
const HEARTBEAT_MS = 15_000;
const REVIEW_HEADER = "x-kino-review";
// POST stops: the refusals that are not 409 (the stop no longer waits, or is not answered).
const STOP_REFUSALS = { bad_input: 400, nothing_to_undo: 400, not_found: 404 };

const AGENTS_LISTED = 50;

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createDashboardRoutes(deps) {
  const { store, agentService, agentState, dashboard, look, frameCache, loadFonts, fontCatalog, json, body, sendFile, attachmentName, dataDirectory, mediaRoot } = deps;
  const now = deps.now ?? Date.now;
  // The live view's memory (agent/live.mjs): each agent's latest presence and the building marks.
  const live = deps.live ?? null;
  // The crew (agent/crew.mjs) and the launcher of the agents kino starts, or null in tests without.
  const crew = deps.crew ?? null;
  const launcher = deps.launcher ?? null;
  // The render cache of export batches ({usage, clear, limit}), or null when there is none.
  const renderCache = deps.renderCache ?? null;
  const renderCacheUsage = async () => (renderCache ? renderCache.usage() : null);
  // Tests answer these instead of this computer (render/devices).
  const findGraphics = deps.listGraphics ?? listGraphics;
  const findVideoEncoders = deps.listVideoEncoders ?? listVideoEncoders;
  const environment = deps.env ?? process.env;
  const graphicsFiles = deps.files ? { files: deps.files } : {};
  const prepared = new Map();
  const agents = new Map();
  // Sound mixes (GET mix): the WAV bytes by what they mix (null when silent), which of those each
  // prepared scene and frame rate mixed to, and the mixes being made right now.
  const mixes = new Map();
  const mixKeys = new Map();
  const mixing = new Map();

  // Who has called kino lately (MCP clients, the command line), for the session pane: one row per
  // agent (agent/live.mjs). A call without one (an older client) is "agent", by its kind. A call
  // you approved runs when you click allow: it is not the agent calling.
  dashboard.onEvent((event) => {
    if (event.type !== "call" || event.event?.by === "you" || event.event?.approved) return;
    const kind = event.event?.client || "agent";
    const { id, name, color } = event.event?.agent ?? { id: `legacy-${kind}`, name: "agent", color: PALETTE[0] };
    agents.delete(id);
    agents.set(id, { id, name, color, kind: event.event?.agent?.kind ?? kind, lastAt: event.at, lastVerb: event.event.verb, projectId: event.projectId, isError: Boolean(event.event.isError) });
    // Each MCP server process is a new agent: only the 50 that called last are listed.
    if (agents.size > AGENTS_LISTED) agents.delete(agents.keys().next().value);
  });

  function requireReview(req) {
    if (!dashboard.validReviewKey(req.headers[REVIEW_HEADER])) throw failure(403, "Only an open dashboard window can do this (it needs the window's review key).");
  }

  async function projectRecord(id) {
    if (typeof id !== "string" || !PROJECT_ID.test(id)) throw failure(400, "Choose a project.");
    const record = await store.getProject(id);
    if (!record) throw failure(404, "This project could not be found.");
    return record;
  }

  // A scene ready to render (components expanded, fonts loaded), kept for the last few
  // project revisions so playback renders frames only.
  async function preparedScene(projectId, revision, document, sceneId) {
    const key = `${projectId}\n${revision}\n${sceneId}`;
    if (prepared.has(key)) {
      const value = prepared.get(key);
      prepared.delete(key);
      prepared.set(key, value);
      return value;
    }
    const fonts = await loadFonts();
    await ensureDocumentFonts(document, fontCatalog, { allowMissing: true, fonts });
    const scene = expandComponents(document, sceneId, { fonts });
    const value = { scene, fonts, key: sceneKey(scene, fonts) };
    prepared.set(key, value);
    while (prepared.size > PREPARED_KEPT) prepared.delete(prepared.keys().next().value);
    return value;
  }

  // The agent data the snapshot and every call event carry. The brief is read only here (D9);
  // the stops are answered here only through POST stops.
  // The preview cache's worker (preview-scheduler.mjs), when kino keeps one (deps.previewCache).
  const preview = deps.previewCache ? createPreviewScheduler({
    cache: deps.previewCache, mediaRoot, enabled: deps.previewEnabled, renderSettings: deps.renderSettings,
    project: (id) => store.getProject(id),
    projectIds: async () => (await store.listProjects()).map((project) => project.id),
    prepare: preparedScene,
    publish: (event) => dashboard.publish(event),
  }) : null;
  if (preview) dashboard.onEvent((event) => { if (event.type === "document" && event.projectId) preview.changed(event.projectId); });

  async function previewList(url) {
    if (!preview) throw failure(404, "This kino keeps no preview cache.");
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const sceneId = url.searchParams.get("scene");
    if (!sceneId || !NODE_ID.test(sceneId)) throw failure(400, "Choose a scene.");
    if (url.searchParams.get("playing") === "1") preview.touch();
    const { revision, document } = await revisionDocument(url, projectId, record, sceneId);
    return preview.list(projectId, sceneId, { revision, document });
  }

  async function previewFile(req, res, name) {
    const key = /^([a-f0-9]{64})\.mp4$/.exec(name ?? "")?.[1];
    const file = preview && key ? await preview.file(key) : null;
    if (!file) throw failure(404, "That preview segment is not ready.");
    // The stage plays it: background renders wait.
    preview.touch();
    try { return await sendFile(req, res, file, "video/mp4", true); }
    catch (error) { if (error?.code === "ENOENT") throw failure(404, "That preview segment is not ready."); throw error; }
  }

  async function agentSlice(projectId) {
    const state = await agentState.read(projectId);
    return { plan: state.plan, notes: state.notes.slice(-100), turns: state.turns.slice(-60), codes: state.codes?.byId ?? {}, brief: briefSummary(state), stops: stopsSummary(state), stopped: state.stopped ?? [], judge: judgeView(state), tries: triesView(state), needs: openNeeds(state.needs),
      // Soundtrack candidates (backend/soundtrack.mjs) for the inspire screen: no file addresses.
      soundtrack: state.soundtrack ? { story: state.soundtrack.story, candidates: state.soundtrack.candidates.map(({ url, filetype, ...entry }) => entry) } : null };
  }

  // POST stops {project, action, …}: your answers to the stops (stops.mjs, plan §6).
  // - answer {id, rev, read_as, words?}: approve, approve with notes or redo a waiting stop, as
  //   the stop card shows it (rev: the revision it showed). Saved as via:"dashboard".
  // - reopen {id}: an answer, most often one the agent recorded from the chat, is not what you
  //   meant; the agent asks that stop again.
  // - keep_asking: undo the "stop asking" your agent recorded from the chat, so rough, color and
  //   sound ask again for this video.
  // The agent hears each in its inbox with its next call. Hold does not refuse them: it holds
  // the agent's writes. The dashboard hears the new stops, also after a refusal that closed a
  // waiting stop nobody can answer any more (the work changed under it).
  async function stops(input) {
    await projectRecord(input?.project);
    const projectId = input.project;
    if (!["answer", "reopen", "keep_asking"].includes(input.action)) throw failure(400, "action is answer, reopen or keep_asking.");
    let summary;
    try {
      if (input.action === "answer") summary = await agentService.answerStop(projectId, input);
      else if (input.action === "reopen") summary = await agentService.reopenStop(projectId, input);
      else summary = await agentState.update(projectId, (state) => keepAsking(state));
    } catch (error) {
      if (!(error instanceof StopError)) throw error;
      if (error.details?.stops) dashboard.publish({ type: "stops", projectId, stops: error.details.stops });
      throw failure(STOP_REFUSALS[error.code] ?? 409, error.message);
    }
    dashboard.publish({ type: "stops", projectId, stops: summary });
    // Your answer ends the agent's turn, as your undo does: its building marks go now.
    await agentService.afterYourStop?.(projectId);
    return { stops: summary };
  }

  // Closes each project's waiting stop that no longer stands after your settings changed (the
  // video has no such stop now, or your settings allow it), and tells the dashboard. Your own
  // writes (an undo, a restore) close one as they save (service.mjs saveDocument).
  async function settleStops() {
    for (const project of await store.listProjects()) {
      const summary = await agentService.settleStop(project.id);
      if (summary) dashboard.publish({ type: "stops", projectId: project.id, stops: summary });
    }
  }

  // The stops waiting for you, {<project>: waiting}, in the projects agents work on: the agent's
  // current project and each connected agent's last one (an agent asks every stop), so a stop in
  // a project that is not open still shows in "needs you". Call events carry the rest.
  async function waitingStops(projects, ids) {
    const known = [...new Set(ids)].filter((id) => id && projects.some((project) => project.id === id));
    const found = await Promise.all(known.map(async (id) => [id, stopsSummary(await agentState.read(id)).waiting]));
    return Object.fromEntries(found.filter(([, waiting]) => waiting));
  }

  async function snapshot(projectId) {
    const projects = await store.listProjects();
    const current = await agentService.currentProject();
    const chosen = [projectId, current, projects[0]?.id].find((id) => id && projects.some((project) => project.id === id)) ?? null;
    const record = chosen ? await store.getProject(chosen) : null;
    return {
      boot: dashboard.boot,
      seq: dashboard.seq(),
      // The server's clock: the dashboard times the live marker by it, not by its own.
      now: new Date(now()).toISOString(),
      projects,
      current,
      projectId: chosen,
      record: record ? { revision: record.revision, document: record.document, updatedAt: record.updatedAt } : null,
      // Comments from share links (the viewer), read only here. Live changes arrive as "comments" events.
      comments: record?.comments ?? [],
      agent: chosen ? await agentSlice(chosen) : null,
      waitingStops: await waitingStops(projects, [chosen, current, ...[...agents.values()].map((agent) => agent.projectId)]),
      events: chosen ? await agentState.events(chosen, { limit: 200 }) : [],
      approvals: dashboard.approvals(),
      hold: dashboard.hold(),
      settings: dashboard.settings(),
      renders: await agentService.renderJobs(),
      agents: [...agents.values()],
      // Each agent's latest call in this project, newest first, and the layers still building.
      presence: { latest: chosen && live ? live.latest(chosen) : [], building: chosen && live ? live.building(chosen, record?.document) : [] },
      pointing: chosen ? dashboard.pointing(chosen) : null,
      // Inspire (F3, backend/inspire.mjs): this project's searches, saved references and their numbers.
      inspire: chosen && deps.inspire ? await deps.inspire.projectView(chosen) : null,
      storage: { dataDirectory },
      // The crew screen's data (agent/crew.mjs view); "crew" events replace it.
      crew: crew ? crew.view() : null,
      // The blind pick box (agent/picks.mjs view); "picks" events replace it.
      picks: agentService.picks ? await agentService.picks.view() : null,
      // A screen recording an agent is making (backend/recorder); "recording" events replace it.
      recording: deps.recorder?.active() ?? null,
    };
  }

  // ---- the crew (agent/crew.mjs) -----------------------------------------------------------
  // Its refusals as HTTP: CrewError carries the status (400 bad input, 404 unknown agent, 409 not
  // allowed now, 424 program not installed, 503 cannot start agents here).
  async function crewCall(work) {
    if (!crew) throw failure(404, "This kino has no crew.");
    try { return await work(); }
    catch (error) {
      if (Number.isInteger(error?.status) && error.code) throw failure(error.status, error.message);
      throw error;
    }
  }

  async function crewRoute(req, res, route, method) {
    const parts = route.split("/");
    // POST crew/start {kind?, task, may?, project?, budget?}: the person starts an agent.
    if (route === "crew/start" && method === "POST") {
      const input = (await body(req, 16 * 1024)) ?? {};
      if (input.project != null) await projectRecord(input.project);
      const member = await crewCall(() => crew.start({ kind: input.kind, task: input.task, may: input.may, projectId: input.project ?? null, budget: input.budget, by: { type: "you" } }));
      return json(res, 200, { member });
    }
    // PUT crew/rules {notes?, leads?: {on?, helpers?}, timers?, atOnce?, budget?: {calls?, minutes?}, kind?}
    if (route === "crew/rules" && method === "PUT") {
      const change = await body(req, 16 * 1024);
      return json(res, 200, { rules: await crewCall(() => crew.updateRules(change)) });
    }
    // POST crew/release {project, part}: the person frees a held part.
    if (route === "crew/release" && method === "POST") {
      const input = (await body(req, 4 * 1024)) ?? {};
      return json(res, 200, await crewCall(() => crew.free(String(input.project ?? ""), String(input.part ?? ""))));
    }
    // POST crew/timers {kind?, task, may?, project?, daily: "HH:MM" | everyHours, budget?, name?}
    if (route === "crew/timers" && method === "POST") {
      const input = (await body(req, 16 * 1024)) ?? {};
      if (input.project != null) await projectRecord(input.project);
      const schedule = input.daily !== undefined ? { daily: input.daily } : { everyHours: input.everyHours };
      return json(res, 200, { member: await crewCall(() => crew.addTimer({ kind: input.kind, task: input.task, may: input.may, projectId: input.project ?? null, schedule, budget: input.budget, name: input.name })) });
    }
    // POST crew/timers/<id>/remove
    if (parts[1] === "timers" && parts.length === 4 && parts[3] === "remove" && method === "POST") return json(res, 200, await crewCall(() => crew.removeTimer(parts[2])));
    // POST crew/<id>/hold {on}: hold (true) or release (false) one agent. POST crew/<id>/stop.
    if (parts.length === 3 && parts[2] === "hold" && method === "POST") {
      const input = (await body(req, 4 * 1024)) ?? {};
      return json(res, 200, { member: await crewCall(() => crew.setHold(parts[1], input.on !== false)) });
    }
    if (parts.length === 3 && parts[2] === "stop" && method === "POST") return json(res, 200, { member: await crewCall(() => crew.stop(parts[1])) });
    throw failure(404, "This dashboard endpoint could not be found.");
  }

  function stream(req, res, url) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    const send = (event) => res.write(`id: ${event.seq ?? ""}\ndata: ${JSON.stringify(event)}\n\n`);
    const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : null;
    if (since === null) send({ type: "hello", boot: dashboard.boot, seq: dashboard.seq() });
    else {
      const missed = dashboard.replay(since, url.searchParams.get("boot"));
      if (missed === null) send({ type: "resync", boot: dashboard.boot, seq: dashboard.seq() });
      else {
        for (const event of missed) send(event);
        send({ type: "replayed", count: missed.length, boot: dashboard.boot, seq: dashboard.seq() });
      }
    }
    const stop = dashboard.onEvent(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref?.();
    req.on("close", () => { stop(); clearInterval(heartbeat); });
  }

  // The stage's frames come first. A frame asked for with low=1 (the timeline's shot thumbnails)
  // waits while any other frame is being drawn, and such frames are drawn one at a time, so on a
  // slow computer (drawing on the CPU) they never queue ahead of the stage's picture.
  let framesDrawing = 0;
  let lowDrawing = false;
  const lowWaiting = [];
  const nextLow = () => {
    if (framesDrawing || lowDrawing || !lowWaiting.length) return;
    lowDrawing = true;
    lowWaiting.shift()();
  };
  const lowTurn = () => new Promise((resolve) => { lowWaiting.push(resolve); nextLow(); });

  async function frame(req, res, url) {
    // A frame nobody waits for any more (the stage moved on to another size or time, or the
    // dashboard closed) is not drawn, or stops being drawn, so the next one does not wait for a
    // drawing worker behind it.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableEnded) gone.abort(); });
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const sceneId = url.searchParams.get("scene");
    const time = Number(url.searchParams.get("t") ?? 0);
    const width = Math.round(Number(url.searchParams.get("w") ?? 960));
    const low = url.searchParams.get("low") === "1";
    if (!sceneId || !NODE_ID.test(sceneId)) throw failure(400, "Choose a scene.");
    if (!Number.isFinite(time) || time < 0) throw failure(400, "t is seconds from the start of the scene.");
    if (!Number.isFinite(width) || width < 64 || width > 1920) throw failure(400, "w is a width from 64 to 1920 pixels.");
    const { rev, revision, document } = await revisionDocument(url, projectId, record, sceneId);
    if (low) await lowTurn();
    else framesDrawing += 1;
    let result;
    const started = Date.now();
    try {
      if (gone.signal.aborted || req.destroyed || res.destroyed) return;
      const scene = await preparedScene(projectId, revision, document, sceneId);
      result = await look.frame(scene, Math.min(time, scene.scene.duration), width, undefined, { signal: gone.signal });
    } catch (error) {
      if (gone.signal.aborted) return;
      throw error;
    } finally {
      if (low) lowDrawing = false;
      else framesDrawing -= 1;
      nextLow();
    }
    const etag = `"${result.key}"`;
    const headers = {
      ETag: etag,
      "Cache-Control": rev !== null ? "private, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Rev": String(revision),
      "X-Frame-Cached": result.cached ? "1" : "0",
      "X-Frame-Ms": String(Date.now() - started),
    };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
    res.writeHead(200, { ...headers, "Content-Type": "image/png", "Content-Length": result.png.length });
    res.end(result.png);
  }

  // GET board: one page of the storyboard of revision `rev` (the one a board stop showed), 4 shots
  // a page, as the agent's look {mode:"board", page} draws it, for the stop card. A page of a
  // revision never changes, so it is cached in the browser when rev is given.
  async function boardPage(req, res, url) {
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : null;
    if (rev !== null && (!Number.isSafeInteger(rev) || rev < 1 || rev > record.revision)) throw failure(400, "rev is a saved revision of this project.");
    const page = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : 1;
    let result;
    try { result = await agentService.boardPage(projectId, { rev, page }); }
    catch (error) {
      if (error?.code === "not_found") throw failure(404, error.message);
      if (error?.code === "bad_input") throw failure(400, error.message);
      throw error;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": result.png.length, "Cache-Control": rev !== null ? "private, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff", "X-Board-Pages": String(result.pages) });
    res.end(req.method === "HEAD" ? undefined : result.png);
  }

  // ?rev as a revision of the project, null when it is not given; 400 when it is not one.
  function revParam(url, record) {
    const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : null;
    if (rev !== null && (!Number.isSafeInteger(rev) || rev < 1 || rev > record.revision)) throw failure(400, "rev is a saved revision of this project.");
    return rev;
  }

  // The service's refusals for the board screen, as HTTP.
  async function boardRead(read) {
    try { return await read(); }
    catch (error) {
      if (error?.code === "not_found") throw failure(404, error.message);
      if (error?.code === "bad_input") throw failure(400, error.message);
      throw error;
    }
  }

  // GET board-data: the storyboard a board stop showed (?stop=C1), the board of a revision
  // (?rev=7, with the newest board stop asked at it), or the newest board stop's (neither), as
  // data for the board screen (agent/board-data.mjs). Read fresh each time: a waiting stop's
  // answer and the redo lists change.
  async function boardData(req, res, url) {
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const stop = url.searchParams.get("stop");
    if (stop !== null && url.searchParams.has("rev")) throw failure(400, "Send stop or rev, not both.");
    const rev = revParam(url, record);
    const data = await boardRead(() => agentService.boardData(projectId, { stop, rev }));
    const body = JSON.stringify(data);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  // GET board-shot: one shot of the board of revision `rev` (required), the source frame or
  // the cropped still, `w` pixels wide (240, 480 or 960), for the board screen's rows. A shot of
  // a revision never changes, so the browser keeps it.
  async function boardShot(req, res, url) {
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const rev = revParam(url, record);
    if (rev === null) throw failure(400, "rev is a saved revision of this project.");
    const input = { rev, shot: url.searchParams.get("shot") ?? "", part: url.searchParams.get("part"), width: Number(url.searchParams.get("w")) };
    const { png } = await boardRead(() => agentService.boardShot(projectId, input));
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : png);
  }

  // The revision a stage request asks for (?rev, or the newest) and that revision's document,
  // which must still be kept and must have the scene.
  async function revisionDocument(url, projectId, record, sceneId) {
    const rev = url.searchParams.has("rev") ? Number(url.searchParams.get("rev")) : null;
    if (rev !== null && (!Number.isSafeInteger(rev) || rev < 1 || rev > record.revision)) throw failure(400, "rev is a saved revision of this project.");
    const revision = rev ?? record.revision;
    const document = revision === record.revision ? record.document : await store.getProjectRevision(projectId, revision);
    if (!document) throw failure(404, `rev ${revision} is no longer kept.`);
    if (!document.scenes.some((scene) => scene.id === sceneId)) throw failure(404, `That scene is not in rev ${revision}.`);
    return { rev, revision, document };
  }

  function keepMix(key, wav) {
    mixes.delete(key);
    mixes.set(key, wav);
    let bytes = 0;
    for (const value of mixes.values()) bytes += value?.length ?? 0;
    for (const [oldKey, value] of mixes) {
      if (bytes <= MIX_BYTES_KEPT || oldKey === key) break;
      mixes.delete(oldKey);
      bytes -= value?.length ?? 0;
    }
  }

  // What a mix is made of: each clip's file (path, size and time changed), where and how loud it
  // plays, and its volume track. Two revisions whose sound is the same share one mix. A clip with
  // a speed or played backwards was made into a WAV for this mix (export.mjs soundClipMaker); its
  // `source` names the file it came from and the timing (speed, Speed animations, reverse, pitch).
  async function mixKey(clips, duration) {
    const parts = await Promise.all(clips.map(async (clip) => {
      const file = await stat(clip.source?.path ?? clip.path);
      const track = clip.volumeTrack;
      return [clip.source?.path ?? clip.path, file.size, file.mtimeMs, clip.source?.timing ?? null, clip.channels, clip.start, clip.source?.offset ?? clip.offset ?? 0, clip.duration ?? null, clip.end ?? null, clip.volume,
        track ? [track.sampleRate, createHash("sha256").update(await readFile(track.path)).digest("hex")] : null,
        clip.lowpass ? [clip.lowpass.cutoff, clip.lowpass.commands ?? null] : null, clip.levelDb ?? null, clip.levelLines ?? null, clip.voiceChain ?? false];
    }));
    return createHash("sha256").update(JSON.stringify([duration, parts])).digest("hex").slice(0, 32);
  }

  /**
   * The scene's sound at `fps`, mixed exactly as an MP4 export of it mixes (export.mjs
   * sceneSoundClips and soundMixArgs) and as long as that export. Returns { key, wav }; wav is
   * null when nothing is heard.
   */
  function sceneMix(scene, fps) {
    const sceneKey = `${scene.key}\n${fps}`;
    const known = mixKeys.get(sceneKey);
    if (known !== undefined && mixes.has(known)) {
      keepMix(known, mixes.get(known));
      return Promise.resolve({ key: known, wav: mixes.get(known) });
    }
    if (mixing.has(sceneKey)) return mixing.get(sceneKey);
    const task = (async () => {
      const duration = soundMixDuration(scene.scene, fps);
      const directory = await makeTempFolder("kino-mix-");
      try {
        let clips;
        try {
          clips = await sceneSoundClips(scene.scene, { mediaRoot, directory, duration });
        } catch (error) {
          // Node's own file errors name paths on this computer, so they are not repeated.
          const reason = error.syscall || error.path ? "a sound file this scene uses could not be read" : error.message.replace(/\.$/, "");
          throw failure(422, `The sound could not be mixed: ${reason}. A render would stop here too.`);
        }
        const key = await mixKey(clips, duration);
        if (!mixes.has(key)) {
          const output = path.join(directory, "mix.wav");
          const args = soundMixArgs(clips, duration, output);
          if (args) await runExportProcess(process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg", args);
          keepMix(key, args ? await readFile(output) : null);
        }
        mixKeys.delete(sceneKey);
        mixKeys.set(sceneKey, key);
        while (mixKeys.size > MIX_KEYS_KEPT) mixKeys.delete(mixKeys.keys().next().value);
        return { key, wav: mixes.get(key) };
      } finally {
        mixing.delete(sceneKey);
        await removeTempFolder(directory);
      }
    })();
    mixing.set(sceneKey, task);
    return task;
  }

  async function mix(req, res, url) {
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const sceneId = url.searchParams.get("scene");
    const fps = parseFps(url.searchParams.get("fps") ?? "30");
    if (!sceneId || !NODE_ID.test(sceneId)) throw failure(400, "Choose a scene.");
    if (fps === null) throw failure(400, `${FPS_HELP}.`);
    const { revision, document } = await revisionDocument(url, projectId, record, sceneId);
    const started = Date.now();
    const scene = await preparedScene(projectId, revision, document, sceneId);
    // Playback starts: background renders wait.
    preview?.touch();
    const { key, wav } = await sceneMix(scene, fps);
    const etag = `"${key}"`;
    const headers = {
      ETag: etag,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Mix-Rev": String(revision),
      "X-Mix-Ms": String(Date.now() - started),
    };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
    if (!wav) { res.writeHead(204, headers); res.end(); return; }
    res.writeHead(200, { ...headers, "Content-Type": "audio/wav", "Content-Length": wav.length });
    res.end(req.method === "HEAD" ? undefined : wav);
  }

  async function turnReview(url) {
    const projectId = url.searchParams.get("project");
    const record = await projectRecord(projectId);
    const state = await agentState.read(projectId);
    const turn = state.turns.find((entry) => entry.id === url.searchParams.get("turn"));
    if (!turn) throw failure(404, "No such turn.");
    const before = turn.edits[0]?.before ?? null;
    const after = turn.edits.at(-1)?.after ?? null;
    let changes = null;
    if (before && after) {
      const [old, next] = await Promise.all([store.getProjectRevision(projectId, before), store.getProjectRevision(projectId, after)]);
      if (old && next) {
        const raw = documentChanges(old, next);
        const name = (id) => refName(id, state.codes);
        const scenes = next.scenes.filter((scene) => scene.layers.some((layer) => raw.changed.includes(layer.id) || raw.created.includes(layer.id))).map((scene) => scene.id);
        changes = { created: raw.created.map(name), changed: raw.changed.map(name), removed: raw.removed.map(name), scenes: scenes.length ? scenes : [next.scenes[0]?.id].filter(Boolean),
          keptBefore: true };
      } else changes = { keptBefore: false };
    }
    const events = (await agentState.events(projectId, { limit: 500 })).filter((event) => event.turn === turn.id);
    return { turn, before, after, current: record.revision, changes, calls: events };
  }

  async function undo(input) {
    const projectId = input?.project;
    await projectRecord(projectId);
    const state = await agentState.read(projectId);
    const index = state.turns.findIndex((entry) => entry.id === input?.turn);
    if (index < 0) throw failure(404, "No such turn.");
    // That turn and every later one with edits, newest first.
    const targets = state.turns.slice(index).filter((entry) => entry.edits.length && !entry.reverted).reverse();
    if (!targets.length) throw failure(400, `${input.turn} has nothing left to revert.`);
    const reverted = [];
    for (const turn of targets) {
      const reply = await agentService.call("history", { project: projectId, action: "revert", turn: turn.id }, { by: "you", client: "dashboard", reviewed: true, keepCurrent: true });
      if (reply.isError) return { reverted, failed: { turn: turn.id, reason: reply.data?.reason ?? reply.text } };
      reverted.push({ turn: turn.id, rev: reply.data?.rev });
    }
    return { reverted };
  }

  // GET render/devices: what the dashboard's rendering settings can choose here.
  // - graphics: listGraphics (platform, cards, canChoose, environment), plus `auto` (what "auto"
  //   draws on here, render-devices.mjs autoGraphics: a card's name, "processor", or null when
  //   Chromium or Mesa chooses) and `saved` (render-devices.mjs savedGraphics: your card name,
  //   whether it is here now, matched in any case as renders match it, and whether renders use it;
  //   one not found, or found where cards cannot be chosen, acts as "auto").
  // - videoEncoders: listVideoEncoders, and `autoVideoEncoder`, the first that works.
  // - overrides: the environment variables that win over a setting (KINO_RASTER_GPU=off makes every
  //   render draw on the processor; KINO_RASTER_WORKERS sets frames at once; the card variables
  //   choose the card).
  async function renderDevices(refresh) {
    const [graphics, videoEncoders] = await Promise.all([
      findGraphics({ refresh }),
      findVideoEncoders({ refresh }).catch(() => []),
    ]);
    const cards = graphics.cards ?? [];
    const auto = autoGraphics({ platform: graphics.platform, env: environment, cards, ...graphicsFiles });
    const setting = dashboard.settings().compute.graphics;
    const set = (name) => (typeof environment[name] === "string" && environment[name] !== "" ? `${name}=${environment[name].slice(0, 80)}` : null);
    const cardVariables = ["GALLIUM_DRIVER", "MESA_D3D12_DEFAULT_ADAPTER_NAME", "DRI_PRIME", "__NV_PRIME_RENDER_OFFLOAD", "__GLX_VENDOR_LIBRARY_NAME", "__EGL_VENDOR_LIBRARY_FILENAMES"]
      .map(set).filter(Boolean);
    return {
      graphics: { ...graphics, auto, saved: savedGraphics(setting, graphics) },
      videoEncoders,
      autoVideoEncoder: videoEncoders.find((entry) => entry.available)?.id ?? null,
      overrides: {
        graphics: environment.KINO_RASTER_GPU === "off" ? set("KINO_RASTER_GPU") : null,
        card: cardVariables,
        framesAtOnce: workerCap(environment) === null ? null : set("KINO_RASTER_WORKERS"),
      },
      lastRender: deps.lastRender?.() ?? null,
    };
  }

  // Your answer to an approval, from the dashboard or told to the agent in the chat (notes
  // answer). The approved call runs again with what you approved: its kinds, the scenes or
  // projects a delete named, and the revision a render named (it asks again rather than delete
  // any other, or render a revision you did not see). An agent past its budget (crew-budget):
  // allow extends its budget, deny stops it.
  async function answerApproval(id, input) {
    const approval = await dashboard.answer(id, input, (entry) =>
      entry.kind === "crew-budget" ? crewCall(() => crew.extend(entry.input?.agent))
        : agentService.call(entry.verb, entry.input, { client: entry.client, ...(entry.agent ? { agent: entry.agent } : {}), approved: entry.kinds ?? [entry.kind], approvedTargets: entry.targets ?? {},
          approvedId: entry.id, ...(entry.rev === undefined ? {} : { approvedRev: entry.rev }) }));
    if (approval.kind === "crew-budget" && approval.status === "denied") {
      const stopped = dashboard.approval(approval.id)?.input?.agent;
      if (stopped) await crewCall(() => crew.stop(stopped, { reason: "stopped by you at its budget" })).catch(() => {});
    }
    return approval;
  }

  async function handle(req, res, url, parts) {
    const method = req.method;
    const route = parts.slice(2).join("/");
    if (route === "snapshot" && method === "GET") return json(res, 200, await snapshot(url.searchParams.get("project")));
    if (route === "stream" && method === "GET") return stream(req, res, url);
    if (route === "frame" && ["GET", "HEAD"].includes(method)) return frame(req, res, url);
    if (route === "mix" && ["GET", "HEAD"].includes(method)) return mix(req, res, url);
    if (route === "preview" && method === "GET") return json(res, 200, await previewList(url));
    if (parts[2] === "preview" && parts.length === 4 && ["GET", "HEAD"].includes(method)) return previewFile(req, res, parts[3]);
    if (route === "board" && ["GET", "HEAD"].includes(method)) return boardPage(req, res, url);
    if (route === "board-data" && ["GET", "HEAD"].includes(method)) return boardData(req, res, url);
    if (route === "board-shot" && ["GET", "HEAD"].includes(method)) return boardShot(req, res, url);
    if (route === "library" && method === "GET") return json(res, 200, libraryCatalog());
    if (route === "library-sample" && method === "GET") {
      const sample = await agentService.librarySample(url.searchParams.get("kind") ?? "", url.searchParams.get("name") ?? "");
      return json(res, 200, sample ?? { document: null });
    }
    if (route === "library-still" && method === "GET") {
      const png = await agentService.libraryStill(url.searchParams.get("kind") ?? "", url.searchParams.get("name") ?? "");
      if (!png) throw failure(404, "This entry has no sample.");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      return res.end(png);
    }
    if (parts[2] === "seen" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      const [, , , projectId, name] = parts;
      if (!PROJECT_ID.test(projectId) || !SEEN_FILE.test(name)) throw failure(400, "That is not an image kino returned to the agent.");
      return sendFile(req, res, path.join(deps.agentDirectory, "out", encodeURIComponent(projectId), name), "image/png", true);
    }
    if (route === "turn" && method === "GET") return json(res, 200, await turnReview(url));
    // GET judge/<project>/<J1-03-1.jpg>: a picture of the latest judge round (agent/judge.mjs).
    if (parts[2] === "judge" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      if (!PROJECT_ID.test(parts[3]) || !/^J\d+-\d{2}-[12]\.jpg$/.test(parts[4])) throw failure(400, "That is not a judge picture.");
      return sendFile(req, res, path.join(deps.agentDirectory, "judge", encodeURIComponent(parts[3]), parts[4]), "image/jpeg", true);
    }
    // GET try/<project>/<T1-B.mp4>: one option's clip of a try round (agent/tries.mjs; Range works).
    if (parts[2] === "try" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      if (!PROJECT_ID.test(parts[3]) || !/^T\d+-[A-D]\.mp4$/.test(parts[4])) throw failure(400, "That is not a try clip.");
      return sendFile(req, res, path.join(deps.agentDirectory, "try", encodeURIComponent(parts[3]), parts[4]), "video/mp4");
    }
    // GET picks/<P3>/<left|right>: one video of a waiting blind pair (agent/picks.mjs). The name
    // never says which file it is.
    if (parts[2] === "picks" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      const file = /^P\d+$/.test(parts[3]) && agentService.picks ? await agentService.picks.file(parts[3], parts[4]) : null;
      if (!file) throw failure(404, "That pair is not waiting.");
      return sendFile(req, res, file.path, file.type);
    }
    if (parts[2] === "inspire" && parts[3] === "thumb" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      const file = /^[A-Za-z0-9_-]{11}$/.test(parts[4]) && deps.inspire ? await deps.inspire.thumbFile(`yt:${parts[4]}`) : null;
      if (!file) throw failure(404, "No thumbnail for that reference.");
      return sendFile(req, res, file, "image/jpeg", true);
    }
    if (parts[2] === "inspire" && parts[3] === "strip" && parts.length === 6 && ["GET", "HEAD"].includes(method)) {
      const kept = /^[A-Za-z0-9_-]{11}$/.test(parts[4]) && /^\d{2}\.jpg$/.test(parts[5]) && deps.inspire ? await deps.inspire.stripsFor(`yt:${parts[4]}`) : null;
      if (!kept?.strips.some((strip) => strip.file === parts[5])) throw failure(404, "No such frame strip for that reference.");
      return sendFile(req, res, path.join(kept.folder, parts[5]), "image/jpeg", true);
    }
    if (parts[2] === "inspire" && parts[3] === "sound" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      const file = /^[A-Za-z0-9_-]{11}$/.test(parts[4]) && deps.inspire?.soundFile ? await deps.inspire.soundFile(`yt:${parts[4]}`) : null;
      if (!file) throw failure(404, "No sound preview for that reference.");
      return sendFile(req, res, file, "audio/mp4", true);
    }
    if (parts[2] === "inspire" && parts[3] === "song" && parts.length === 5 && ["GET", "HEAD"].includes(method)) {
      const file = SONG_KEY.test(parts[4]) && deps.soundtrack?.songFile ? deps.soundtrack.songFile(parts[4]) : null;
      if (!file) throw failure(404, "No preview for that song: measure it again.");
      return sendFile(req, res, file, "audio/mp4", true);
    }
    // The timeline's shots and spoken sentences for one scene (service.mjs lanes).
    if (route === "lanes" && method === "GET") {
      const projectId = url.searchParams.get("project");
      const sceneId = url.searchParams.get("scene");
      if (!PROJECT_ID.test(projectId ?? "") || !sceneId || !NODE_ID.test(sceneId)) throw failure(400, "Choose a project and a scene.");
      await projectRecord(projectId);
      try { return json(res, 200, await agentService.lanes(projectId, sceneId)); }
      catch (error) { if (error?.code === "not_found") throw failure(404, error.message); throw error; }
    }
    if (parts[2] === "renders" && parts.length === 5 && parts[4] === "file" && ["GET", "HEAD"].includes(method)) {
      const job = (await agentService.renderJobs()).find((entry) => entry.id === parts[3]);
      if (!job?.path) throw failure(404, "That render has no finished file.");
      res.setHeader("Content-Disposition", attachmentName(path.basename(job.path)));
      return sendFile(req, res, job.path, { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", gif: "image/gif", png: "image/png", apng: "image/apng", "png-sequence": "application/zip", lottie: "application/json" }[job.format] ?? "application/octet-stream");
    }
    if (route === "review-key" && method === "POST") {
      // Only a page of this app, in a browser, can ask: fetch() from the dashboard sends these.
      if (req.headers["sec-fetch-site"] !== "same-origin" || !req.headers.origin) throw failure(403, "Review keys are given to the dashboard window only.");
      return json(res, 200, { key: dashboard.mintReviewKey() });
    }
    if (route === "settings" && method === "GET") return json(res, 200, { settings: dashboard.settings() });
    // GET crew: the crew screen's data. GET crew/<id>/log: the end of a started agent's output.
    if (route === "crew" && method === "GET") return json(res, 200, { crew: await crewCall(() => crew.view()) });
    if (parts[2] === "crew" && parts.length === 5 && parts[4] === "log" && method === "GET") {
      const member = await crewCall(() => crew.member(parts[3]));
      if (!member?.launched || !launcher) throw failure(404, "kino did not start that agent, so it has no log.");
      return json(res, 200, { id: member.id, ...(await launcher.log(member.id)) });
    }
    if (route === "cache" && method === "GET") return json(res, 200, { cache: await frameCache.usage(), renderCache: await renderCacheUsage(),
      previewCache: deps.previewCache ? await deps.previewCache.usage() : null });
    if (route === "render/devices" && method === "GET") return json(res, 200, await renderDevices(url.searchParams.get("refresh") === "1"));
    if (route === "channel-sent" && method === "POST") {
      const input = await body(req, 4 * 1024);
      await projectRecord(input?.project);
      const note = await agentState.update(input.project, (state) => {
        const found = state.notes.find((entry) => entry.id === input.note);
        if (found) found.channelAt = new Date().toISOString();
        return found ? structuredClone(found) : null;
      });
      if (note) dashboard.publish({ type: "note", projectId: input.project, note });
      return json(res, 200, { note });
    }
    // Everything below changes something: the window's review key is required.
    if (method !== "POST" && method !== "PUT") throw failure(404, "This dashboard endpoint could not be found.");
    requireReview(req);
    // What you point at (a layer, a time range) is what the agent reads as yours, and the
    // dashboard draws it as your selection: only the dashboard window (its review key) sets it.
    if (route === "point" && method === "POST") {
      const input = await body(req, 16 * 1024);
      const record = await projectRecord(input?.project);
      if (input.range != null && !record.document.scenes.some((scene) => scene.id === input.sceneId)) throw failure(400, "A time range needs sceneId, a scene of this project.");
      // The pointing line names layers and scenes as the agent's status does: by readable ID or
      // short code. Codes are given here as the agent's next call would give them.
      const codes = await agentState.update(input.project, (state) => (state.codes = assignCodes(state.codes, record.document)));
      dashboard.point(input.project, input, { codes });
      return json(res, 200, { pointing: dashboard.pointing(input.project) });
    }
    if (parts[2] === "act" && parts.length === 4) {
      const { quiet, ...input } = (await body(req, 1024 * 1024)) ?? {};
      return json(res, 200, await agentService.call(parts[3], input, { by: "you", client: "dashboard", reviewed: true, keepCurrent: true, quiet: quiet === true }));
    }
    if (route === "undo" && method === "POST") return json(res, 200, await undo(await body(req, 16 * 1024)));
    if (parts[2] === "approvals" && parts.length === 4 && method === "POST")
      return json(res, 200, { approval: await answerApproval(parts[3], (await body(req, 16 * 1024)) ?? {}) });
    if (route === "stops" && method === "POST") return json(res, 200, await stops(await body(req, 16 * 1024)));
    // The person stops a screen recording; the agent's next record status or stop says so.
    if (route === "recording/stop" && method === "POST") {
      if (!deps.recorder) throw failure(404, "This kino cannot record the screen.");
      const stopped = await deps.recorder.stopByPerson();
      return json(res, 200, { stopped: stopped ? { src: stopped.src, seconds: stopped.seconds } : null });
    }
    if (route === "hold" && method === "POST") {
      const input = await body(req, 16 * 1024);
      const was = dashboard.hold().on;
      const hold = await dashboard.setHold(input?.on === true, input?.note);
      if (was !== hold.on) crew?.holdAll(hold.on);
      return json(res, 200, { hold });
    }
    if (parts[2] === "crew") return crewRoute(req, res, parts.slice(2).join("/"), method);
    if (route === "settings" && method === "PUT") {
      const before = dashboard.settings();
      const settings = await dashboard.updateSettings(await body(req, 16 * 1024));
      // A stop set to allow, or a longer skip-under length, closes the stops waiting now.
      if (JSON.stringify(stopRules(before.approvals, before.limits)) !== JSON.stringify(stopRules(settings.approvals, settings.limits))) await settleStops();
      if (settings.compute.frameCacheMegabytes !== before.compute.frameCacheMegabytes) await frameCache.limit(settings.compute.frameCacheMegabytes * 1024 * 1024);
      // A smaller render cache removes its oldest entries at once.
      if (renderCache && settings.compute.renderCacheMegabytes !== before.compute.renderCacheMegabytes) await renderCache.limit(settings.compute.renderCacheMegabytes * 1024 * 1024);
      // The preview cache: a smaller size trims it at once; turned off, its drawing stops at once.
      if (deps.previewCache && settings.compute.previewCacheMegabytes !== before.compute.previewCacheMegabytes) await deps.previewCache.limit(settings.compute.previewCacheMegabytes * 1024 * 1024);
      if (settings.compute.previewCache !== before.compute.previewCache) preview?.refresh();
      return json(res, 200, { settings });
    }
    if (route === "cache/clear" && method === "POST") {
      await frameCache.clear();
      prepared.clear();
      mixes.clear();
      mixKeys.clear();
      return json(res, 200, { cache: await frameCache.usage() });
    }
    if (route === "render-cache/clear" && method === "POST") {
      if (!renderCache) throw failure(404, "This server has no render cache.");
      const { removed, inUse } = await renderCache.clear();
      return json(res, 200, { renderCache: await renderCache.usage(), removed, inUse });
    }
    throw failure(404, "This dashboard endpoint could not be found.");
  }

  return { handle, agentSlice, preview, answerApproval };
}
