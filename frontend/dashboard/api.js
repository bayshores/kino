// The dashboard's requests to the server (backend/dashboard-routes.mjs). Reads need owner
// access only; changes also send this window's review key (x-kino-review), which the server
// gives to a page of this app and never to an agent.
import { accessHeaders, api } from "../client.js";

let reviewKey = null;

async function freshReviewKey() {
  const { key } = await api("/dashboard/review-key", { method: "POST", body: {} });
  reviewKey = key;
  return key;
}

/** A change from the dashboard. Gets a new review key once if the server restarted. */
async function change(path, { method = "POST", body } = {}) {
  const send = async () => api(`/dashboard/${path}`, { method, body: body ?? {}, headers: { "x-kino-review": reviewKey ?? await freshReviewKey() } });
  try {
    return await send();
  } catch (error) {
    if (error.status !== 403) throw error;
    await freshReviewKey();
    return send();
  }
}

// Owner sessions (the desktop app) use a cookie, so <img> and EventSource are allowed too.
export async function startSession() {
  if (accessHeaders()["X-Kino-Owner"]) await api("/session", { method: "POST", body: {} });
}

export const snapshot = (projectId) => api(`/dashboard/snapshot${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`);
export const projectRecord = (projectId) => api(`/projects/${encodeURIComponent(projectId)}`);
export const turnReview = (projectId, turn) => api(`/dashboard/turn?project=${encodeURIComponent(projectId)}&turn=${encodeURIComponent(turn)}`);
export const cacheUsage = () => api("/dashboard/cache");
// The timeline's shots and spoken sentences for a scene (lanes.jsx).
export const sceneLanes = (projectId, sceneId) => api(`/dashboard/lanes?project=${encodeURIComponent(projectId)}&scene=${encodeURIComponent(sceneId)}`);
// A sound file's waveform peaks ({peaks, secondsPerPeak, duration}).
export const mediaPeaks = (id) => api(`/media/${encodeURIComponent(id)}/peaks`);
export const mcpConfig = () => api("/mcp-config");

// Share links and Trash: owner requests to the project API (backend/index.mjs). Making a link goes
// through the agent verb (act "project" share) so it is logged like everything else.
export const listShares = (projectId) => api(`/projects/${encodeURIComponent(projectId)}/shares`);
export const revokeShare = (projectId, grantId) => api(`/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(grantId)}`, { method: "DELETE" });
export const listTrash = () => api("/trash");
export const restoreProject = (projectId) => api(`/projects/${encodeURIComponent(projectId)}/restore`, { method: "POST", body: {} });

/** Runs an agent verb as you (notes add, check, render, project, history …). */
export const act = (verb, input) => change(`act/${encodeURIComponent(verb)}`, { body: input });
export const answerApproval = (id, answer) => change(`approvals/${encodeURIComponent(id)}`, { body: answer });
export const setHold = (on, note = "") => change("hold", { body: { on, note } });
export const stopRecording = () => change("recording/stop");
// The stops (direction plan §6): your answer to a waiting stop (read_as approve, approve with
// notes or redo; words only with a note; on a storyboard, shots: [{id, words}], a note on one
// shot each), reopening an answered one, and undoing "stop asking". The agent hears each in its
// inbox with its next call.
export const answerStop = (project, { id, rev, read_as, words, shots }) => change("stops", {
  body: { project, action: "answer", id, rev, read_as, ...(words ? { words } : {}), ...(Array.isArray(shots) && shots.length ? { shots } : {}) },
});
export const reopenStop = (project, id) => change("stops", { body: { project, action: "reopen", id } });
export const keepAsking = (project) => change("stops", { body: { project, action: "keep_asking" } });
export const undoTurn = (project, turn) => change("undo", { body: { project, turn } });
export const saveSettings = (settings) => change("settings", { method: "PUT", body: settings });
export const clearCache = () => change("cache/clear");
export const clearRenderCache = () => change("render-cache/clear");
/** The graphics cards and video encoders here (backend/dashboard-routes.mjs render/devices); `refresh` detects them again. */
export const renderDevices = (refresh = false) => api(`/dashboard/render/devices${refresh ? "?refresh=1" : ""}`);
export const point = (project, sceneId, layerIds, range = null) => change("point", { body: { project, sceneId, layerIds, ...(range ? { range } : {}) } });

// The crew (backend/agent/crew.mjs, the F2 screen): start an agent, hold, release or stop one,
// free a held part, change who may start agents, add or remove a timer.
export const startAgent = ({ kind, task, may, project, budget }) => change("crew/start", { body: { kind, task, may, ...(project ? { project } : {}), ...(budget ? { budget } : {}) } });
export const holdAgent = (id, on) => change(`crew/${encodeURIComponent(id)}/hold`, { body: { on } });
export const stopAgent = (id) => change(`crew/${encodeURIComponent(id)}/stop`);
export const freePart = (project, part) => change("crew/release", { body: { project, part } });
export const saveCrewRules = (rules) => change("crew/rules", { method: "PUT", body: rules });
export const addTimer = (timer) => change("crew/timers", { body: timer });
export const removeTimer = (id) => change(`crew/timers/${encodeURIComponent(id)}/remove`);

/** Adds a file to the media library (dragged onto the window). */
export async function uploadMedia(file, projectId) {
  const response = await fetch(`/api/media${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`, {
    method: "POST",
    headers: { ...accessHeaders(), "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    body: file,
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(value?.error ?? `The file was refused (${response.status}).`), { status: response.status });
  return value;
}

/**
 * A stage frame: the export renderer's PNG, cached by content on the server. `low`: a thumbnail,
 * which the server draws only while it draws no other frame (the stage's picture comes first).
 */
export function frameUrl({ projectId, sceneId, time, width, rev = null, low = false }) {
  const query = new URLSearchParams({ project: projectId, scene: sceneId, t: (Math.round(time * 1000) / 1000).toString(), w: String(width) });
  if (rev) query.set("rev", String(rev));
  if (low) query.set("low", "1");
  return `/api/dashboard/frame?${query}`;
}

/** One page of the storyboard of revision `rev` (4 shots a page), as the agent's look {mode:"board"} draws it. */
export function boardPageUrl({ projectId, rev, page }) {
  return `/api/dashboard/board?${new URLSearchParams({ project: projectId, rev: String(rev), page: String(page) })}`;
}

/**
 * The storyboard screen's data (backend/agent/board-data.mjs): the board a stop showed (`stop`,
 * "C1"), the board of revision `rev`, or with neither the newest board stop's, else the board
 * now (status "not asked yet").
 */
export function boardData(projectId, { stop = null, rev = null } = {}) {
  const query = new URLSearchParams({ project: projectId });
  if (stop) query.set("stop", stop);
  else if (rev) query.set("rev", String(rev));
  return api(`/dashboard/board-data?${query}`);
}

/** One shot's picture of revision `rev`: its source frame (`part` "source") or its cropped still ("still"), `width` 240, 480 or 960 px. */
export function boardShotUrl({ projectId, rev, shot, part, width }) {
  return `/api/dashboard/board-shot?${new URLSearchParams({ project: projectId, rev: String(rev), shot, part, w: String(width) })}`;
}

/** An image kino returned to the agent. */
export function seenUrl(projectId, file) {
  return `/api/dashboard/seen/${encodeURIComponent(projectId)}/${encodeURIComponent(String(file).split(/[\\/]/).pop())}`;
}

export const renderFileUrl = (jobId) => `/api/dashboard/renders/${encodeURIComponent(jobId)}/file`;

/** The library screen's catalog (backend/agent/library-catalog.mjs): every entry, the kinds and the technique groups. */
export function libraryCatalog() {
  return api("/dashboard/library");
}

/** One library entry's sample: {document, still} (a short document and the moment its card shows), or {document: null}. */
export function librarySample(kind, name) {
  return api(`/dashboard/library-sample?${new URLSearchParams({ kind, name })}`);
}

/** One library card's still (PNG, 480 px wide); 404 when the entry has no sample. */
export function libraryStillUrl(kind, name) {
  return `/api/dashboard/library-still?${new URLSearchParams({ kind, name })}`;
}
