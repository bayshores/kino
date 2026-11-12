import http from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { imageFacts } from "../engine/imageFacts.js";
import { openStore, ConflictError } from "./store.mjs";
import { COMMENT_KEY_HEADER, commentKeyHash } from "./comments.mjs";
import { exportScene, renderSceneFrames } from "./export.mjs";
import { parseExportDocument } from "./export-document.mjs";
import { getMp4Encoders } from "./mp4-encoders.mjs";
import { createExportBatches, exportFileName, withVideoDefaults } from "./export-batches.mjs";
import { createExportProgressRegistry } from "./export-progress.mjs";
import { loadBundledFonts, loadProjectFonts } from "./fonts.mjs";
import { createFontCatalog } from "./font-catalog.mjs";
import { ensureDocumentFonts } from "./font-selection.mjs";
import { viewerFontEntries } from "../engine/viewerFonts.js";
import { defaultFonts, FontRegistry } from "../engine/fonts.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { parseDocument, createDocument } from "../engine/model.js";
import { MAX_UPLOAD_BYTES } from "../engine/schema.js";
import { applyOperations } from "../engine/operations.js";
import { documentChanges } from "../engine/documentChanges.js";
import { mergeDocuments } from "../engine/documentMerge.js";
import { createOperationRequest } from "./operation-request.mjs";
import { accessFor, openShareStore, sameSecret } from "./shares.mjs";
import { probeMedia, runMediaTool, videoFrameFacts } from "./media-probe.mjs";
import { REMUX_MIMES, alphaToWebm, probePicture, remuxToMp4 } from "./media-remux.mjs";
import { createShotFinder, findShots, firstErrorLine, shotFilters } from "./shot-detection.mjs";
import { createGifFrameCache } from "./gif-frame-cache.mjs";
import { createMediaPosterCache } from "./media-posters.mjs";
import { documentMediaIds, mediaAllowedIn, recordProjectUse } from "./media-use.mjs";
import { loadBulkCreateMediaSources } from "./bulk-create-media.mjs";
import { prepareSvgAsset } from "./svg-asset.mjs";
import { GIF_DECODER_VERSION, composeGifFrames, parseGif } from "../engine/gifDecode.js";
import { MEDIA_ID_PATTERN, mediaIdFromSource } from "../engine/replaceMedia.js";
import { createAudioPeaksCache } from "./audio-peaks.mjs";
import { createFileMutationLock, releaseProjectMedia } from "./project-media-retention.mjs";
import { createMediaRecordReader, writeMediaRecord } from "./media-records.mjs";
import { mediaSignatureMatches, mediaStreamsMatch } from "./media-validation.mjs";
import { createPresenceRegistry, pruneSelection, validateCursor, validateSelection } from "./presence.mjs";
import { exportBasename } from "../engine/exportNames.js";
import { createAgentStateStore } from "./agent/state.mjs";
import { createFrameCache, createLook } from "./agent/look.mjs";
import { createAgentService } from "./agent/service.mjs";
import { agentToolList } from "./agent/tool-sync.mjs";
import { createDashboard, editFocus } from "./agent/dashboard.mjs";
import { cleanKind, createLiveAgents, validSession } from "./agent/live.mjs";
import { createDashboardRoutes } from "./dashboard-routes.mjs";
import { createPreviewCache } from "./preview-segments.mjs";
import { previewCacheOn } from "./preview-scheduler.mjs";
import { createCrew } from "./agent/crew.mjs";
import { createLauncher } from "./agent/launcher.mjs";
import { createVoiceMedia } from "./voice/media.mjs";
import { createCutoutMedia } from "./cutout/media.mjs";
import { shareUrl } from "../engine/shareUrls.js";
import { LUT_MIME, parseCubeLut } from "../engine/effects/colorMath.js";
import { createSoundSearch } from "./sound-search.mjs";
import { createSoundLibrary } from "./sound-library.mjs";
import { createRecorder } from "./recorder/recorder.mjs";
import { createSoundtrack } from "./soundtrack.mjs";
import { createSongTaste } from "./songTaste.mjs";
import { createMusicEmbed } from "./music-embed.mjs";
import { createLookEmbed } from "./look-embed.mjs";
import { decodeMono } from "./audio-analysis.mjs";
import { createSoundBandsCache, soundLevelsFor } from "./sound-bands.mjs";
import { analyzeBeats } from "../engine/beatDetection.js";
import { createInspire, inspireTools } from "./inspire.mjs";
import { createYouTubeGate } from "./process-slots.mjs";
import { createFootageFinder } from "./footage-finder/index.mjs";
import { createCommonsSource } from "./footage-finder/licensed.mjs";
import { createHouseMemory } from "./house-memory.mjs";
import { createSongShapeCache, songVocals, whisperModelReady } from "./song-shape.mjs";
import { makeTempFolder, removeTempFolder, sweepSummary, sweepTempFolders } from "./temp-folders.mjs";
import { stopChildren } from "./child-exit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeExports = new Set();
const dataRoot = path.resolve(
  process.env.MOTION_DATA_DIR || path.join(root, ".local/data"),
);
const mediaRoot = path.join(dataRoot, "media");
const audioPeaks = createAudioPeaksCache();
// Decoded GIF frames live beside the media folder; audio peaks use .peaks sidecars beside uploads.
const gifFrames = createGifFrameCache(path.join(dataRoot, "media-frames"));
const mediaPosters = createMediaPosterCache(path.join(dataRoot, "media-posters"));
const mediaFilePattern = /^[a-f0-9-]+\.[a-z0-9]+$/;
// Your dashboard settings for every render. The machine settings (the card that draws, frames at
// once, memory to leave free) go into exportScene's context; the video encoder and quality fill in
// an MP4's options when the agent leaves them out. The dashboard opens further down; these are
// read only when a render starts, after it has opened.
const machineSettings = () => {
  const { graphics, framesAtOnce, keepFreePercent } = dashboard.settings().compute;
  return { graphics, framesAtOnce, keepFreePercent };
};
const videoDefaults = () => {
  const { videoEncoder, videoQuality } = dashboard.settings().exports;
  return { videoEncoder, videoQuality };
};
// The last render that drew its frames (not one reused from the cache): what drew and encoded it,
// for the dashboard's rendering settings (GET /api/dashboard/render/devices).
let lastRender = null;
const noteRender = (result) => {
  if (result?.graphics || result?.videoEncoder) lastRender = { at: new Date().toISOString(), graphics: result.graphics ?? null, videoEncoder: result.videoEncoder ?? null };
};
const exportBatches = createExportBatches({ mediaRoot, cacheDirectory: path.join(dataRoot, "render-segments"),
  renderSettings: machineSettings, exportDefaults: videoDefaults, onRendered: noteRender });
const exportProgress = createExportProgressRegistry();
const host = process.env.MOTION_HOST || "127.0.0.1";
const port = Number(process.env.MOTION_API_PORT || 4781);
const publicOrigin = process.env.KINO_PUBLIC_URL ? new URL(process.env.KINO_PUBLIC_URL).origin : null;
const ownerToken = process.env.KINO_OWNER_TOKEN || null;
const localMode = ["127.0.0.1", "localhost", "::1"].includes(host) && !publicOrigin;
if (!localMode && !ownerToken) throw new Error("Set KINO_OWNER_TOKEN before serving kino beyond localhost.");
const store = await openStore(dataRoot);
const fontCatalog = await createFontCatalog({ dataRoot });
const bundledFontRegistry = await loadBundledFonts();
defaultFonts.replace(bundledFontRegistry);
const shares = await openShareStore(dataRoot);
const ownerSessions = new Set();
await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
// Every readable media record; an unreadable one is skipped and logged once (media-records.mjs).
const readMediaRecords = createMediaRecordReader(mediaRoot);
const clients = new Map();
const sessions = createPresenceRegistry({ clients });
const acquireFileMutation = createFileMutationLock();
const wsServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const OWNER_ACCESS = accessFor();
// The agent service behind POST /api/agent/<verb> (MCP tools and the kino command line).
// Its files live under <data>/agent/: per-project state, rendered looks, the frame cache, renders.
const agentDirectory = path.join(dataRoot, "agent");
const agentState = createAgentStateStore(dataRoot);
// The dashboard (plan §5): settings, approvals, hold and its event stream. The stage frames
// come from the same frame cache and renderer as the agent's look.
const dashboard = await createDashboard({ agentDirectory, agentState });
// The live view (milestone LIVE): each agent's name and color, what its calls are about and the
// layers it has not looked at since it changed them, published on the dashboard's stream.
// Agents kino started (the crew, below) keep their own identity for their session.
let crew = null;
const liveAgents = createLiveAgents({ publish: (event) => dashboard.publish(event), boot: dashboard.boot,
  known: (session) => crew?.identityFor(session) ?? null, takenNames: () => crew?.names() ?? [] });
// The crew (plan section C): every agent at work, who started it, its limits and budget, the
// parts it holds, and the person's start rules. kino starts Claude Code or Codex itself
// (agent/launcher.mjs), each in <data>/agent/crew/<id>/, with kino's MCP server for its identity.
const crewLauncher = createLauncher({
  directory: path.join(agentDirectory, "crew"),
  connection: () => ({ url: `http://127.0.0.1:${server.address().port}`, ownerToken }),
  onExit: (id, result) => crew?.exited(id, result),
});
crew = await createCrew({
  directory: agentDirectory,
  publish: (event) => dashboard.publish(event),
  launcher: crewLauncher,
  approvals: {
    request: (request) => dashboard.request(request),
    pendingFor: (id) => dashboard.approvals().some((entry) => entry.status === "pending" && entry.agent?.id === id && (!entry.agent.boot || entry.agent.boot === dashboard.boot)),
  },
  inbox: (projectId, item) => (projectId ? agentState.update(projectId, (state) => { state.inbox.push(item); }) : null),
  liveNames: () => liveAgents.names(),
  hold: () => dashboard.hold(),
});
// An approval asked or answered can change an agent's state ("needs you").
dashboard.onEvent((event) => { if (event.type === "approval") crew.changed(); });
process.on("exit", () => { crewLauncher.stopAll(); stopChildren(); });
const frameCache = createFrameCache(path.join(agentDirectory, "frames"));
await frameCache.limit(dashboard.settings().compute.frameCacheMegabytes * 1024 * 1024).catch(() => {});
// The render cache size from your settings (512 MB unless you changed it); it trims at once.
await exportBatches.renderCache?.limit(dashboard.settings().compute.renderCacheMegabytes * 1024 * 1024).catch(() => {});
const agentLook = createLook({ cache: frameCache, outDirectory: path.join(agentDirectory, "out"), mediaRoot, renderSettings: machineSettings });
// A video's shots are found when it is uploaded. One imported before that gets them the first
// time a look or library media needs them, saved into its media record.
const shotFinder = createShotFinder({ mediaRoot, saveRecord: saveMediaRecord });
// Inspire (F3): YouTube searches measured for their cuts (backend/inspire.mjs). The numbers and
// thumbnails are kept in <data>/inspire; each project's searches and saved references in its
// agent state. yt-dlp is KINO_YTDLP, else Homebrew's, else the one on the PATH.
const inspireDeps = await inspireTools();
// One gate for every YouTube download (inspire, soundtrack, footage): one at a time, 5 s apart, and
// after a bot check none for 15 minutes (process-slots.mjs). KINO_YOUTUBE_GAP_MS sets the gap for
// tests whose stub yt-dlp never reaches YouTube.
const youtubeGate = createYouTubeGate(process.env.KINO_YOUTUBE_GAP_MS ? { gapMs: Math.max(0, Number(process.env.KINO_YOUTUBE_GAP_MS) || 0) } : {});
// Reference looks (SigLIP via transformers.js): one vector a shot and a thumbnail, so searches rank
// by how the frames match the words and the saved references. The model downloads once into
// <data>/models on first use; KINO_LOOK_DOWNLOAD=0 keeps it to a model already there, off turns it off.
const lookEmbed = process.env.KINO_LOOK_DOWNLOAD === "off" ? null : createLookEmbed({ modelDir: path.join(dataRoot, "models"), download: process.env.KINO_LOOK_DOWNLOAD !== "0" });
// Song and sound embeddings (LAION-CLAP via transformers.js): the model downloads once into
// <data>/models on first use; KINO_MUSIC_DOWNLOAD=0 keeps it to a model already there.
const musicEmbed = createMusicEmbed({ modelDir: path.join(dataRoot, "models"), download: process.env.KINO_MUSIC_DOWNLOAD !== "0" });
// The person's use and no on sound effects, across projects (kept like song taste).
const soundTaste = createSongTaste({ file: path.join(dataRoot, "sound-taste.json") });
const inspire = createInspire({
  directory: path.join(dataRoot, "inspire"),
  ...inspireDeps,
  look: lookEmbed,
  youtube: youtubeGate,
  projectState: {
    read: async (projectId) => (await agentState.read(projectId))?.inspire ?? null,
    update: (projectId, change) => agentState.update(projectId, (state) => {
      const { state: next, value } = change(state.inspire ?? null);
      state.inspire = next;
      return value;
    }),
  },
  publish: (event) => dashboard.publish(event),
  // A measured YouTube sound effect's preview, imported with its credit.
  addMedia: (...args) => addGeneratedMedia(...args),
  // Sound effects ranked by how they sound against the search words (backend/sfx-rank.mjs).
  embedSound: (samples, rate) => musicEmbed.audio(samples, rate),
  embedText: (prompts) => musicEmbed.text(prompts),
  embedModel: musicEmbed.model,
  soundTaste,
});
inspire.start().catch((error) => console.warn(`Inspire could not clear its work folder: ${error.message}`));
// Soundtrack search (backend/soundtrack.mjs): Openverse and Internet Archive songs behind the sound search switch, and
// YouTube songs (inspire's yt-dlp; listed first, and found by name). Search answers are cached in <data>/soundtrack.
const soundtrack = createSoundtrack({
  embed: (samples, rate) => musicEmbed.audio(samples, rate),
  directory: path.join(dataRoot, "soundtrack"),
  enabled: () => dashboard.settings().sounds?.search === true,
  ...(process.env.KINO_OPENVERSE_API ? { api: process.env.KINO_OPENVERSE_API } : {}),
  ...(process.env.KINO_ARCHIVE_API ? { archiveApi: process.env.KINO_ARCHIVE_API } : {}),
  searchYouTube: (words, options) => inspireDeps.search(words, options),
  mixYouTube: (videoId, options) => inspireDeps.mix(videoId, options),
  downloadYouTube: (videoId, folder, options) => inspireDeps.downloadAudio(videoId, folder, options),
  youtube: youtubeGate,
  decode: (file) => decodeMono(file),
  analyze: (samples, rate) => analyzeBeats(samples, rate),
  vocals: (file, seconds) => songVocals(file, { seconds }),
  preview: (file, target, options) => inspireDeps.songPreview(file, target, options),
  addMedia: (...args) => addGeneratedMedia(...args),
});
soundtrack.sweep().catch(() => {});
// The footage finder (backend/footage-finder): YouTube searches cached in <data>/footage/cache,
// scans kept in <data>/footage/scans, Commons behind the same web search switch as sounds. Scans
// match shots to the agent's words with the reference look model, when it is on.
const footageFinder = createFootageFinder({
  directory: path.join(dataRoot, "footage"),
  dataRoot,
  youtube: youtubeGate,
  embed: lookEmbed,
  commons: createCommonsSource({ enabled: () => dashboard.settings().sounds?.search === true, directory: path.join(dataRoot, "footage", "commons") }),
  // With looks or their download switched off nothing downloads, so no scan promises a download.
  modelReady: () => !lookEmbed || process.env.KINO_LOOK_DOWNLOAD === "0" || lookEmbed.ready(),
  // Imported shots join the media library for their project, with their credit and F code.
  addMedia: (...args) => addGeneratedMedia(...args),
});
// Screen recordings agents make (project {action:"record"}): folders in <data>/recordings while
// recording, then the video joins the media library. The dashboard shows one while it runs.
const recorder = createRecorder({ dataRoot, mediaRoot, addMedia: (...args) => addGeneratedMedia(...args),
  onChange: (recording) => dashboard.publish({ type: "recording", recording }) });
const agentService = createAgentService({
  store,
  // fit_music's song seams (.song beside each file); whisper's vocal spans give the vocal-in seams
  // (measured again once a whisper model is there, when the file was measured without one).
  songShapes: createSongShapeCache({ vocals: (file, seconds) => songVocals(file, { seconds }), vocalsReady: whisperModelReady }),
  videoFacts: (id) => videoFactsOf(id),
  // seen_before: the layouts kino rendered in each project, in <data>/house (house-memory.mjs).
  house: createHouseMemory(path.join(dataRoot, "house")),
  recorder,
  // The Timeline's waveform peaks; speech_cut hears each cut in them (one decode per file).
  audioPeaks,
  // check's pixel rules draw their frames on the card your settings name.
  renderFrames: (scene, times, options) => renderSceneFrames(scene, times, { ...options, render: machineSettings() }),
  agentState,
  agentDirectory,
  // The blind pick box's queue and picks.jsonl (agent/picks.mjs, evals/taste/picks.md).
  tasteDirectory: path.join(dataRoot, "taste"),
  mediaRoot,
  live: liveAgents,
  crew,
  // isolate_voice: stems are cached in <data>/voice and become library media; the DPDFNet model
  // is kept in <data>/models. KINO_VOICE_DOWNLOAD=0 stops its one-time download.
  voiceMedia: createVoiceMedia({ mediaRoot, cacheDir: path.join(dataRoot, "voice"), modelDir: path.join(dataRoot, "models"),
    addMedia: addGeneratedMedia, download: process.env.KINO_VOICE_DOWNLOAD !== "0" }),
  // cut_out: mattes are cached in <data>/cutout (work folders a stopped server left there are
  // removed now) and their outputs become library media. An edit waits KINO_CUTOUT_WAIT_S seconds
  // in all (default 50) before answering that a cut-out is still running; one that says it is
  // within KINO_CUTOUT_GRACE_S (default 30) of done is waited for that much longer. Study c: a
  // 51.3 s cut-out was refused with "about 10 seconds" left and the same edit sent again.
  cutoutMedia: createCutoutMedia({ mediaRoot, cacheDir: path.join(dataRoot, "cutout"), addMedia: addGeneratedMedia,
    waitSeconds: Number.isFinite(Number(process.env.KINO_CUTOUT_WAIT_S)) && process.env.KINO_CUTOUT_WAIT_S !== "" ? Math.max(0, Number(process.env.KINO_CUTOUT_WAIT_S)) : 50,
    graceSeconds: Number.isFinite(Number(process.env.KINO_CUTOUT_GRACE_S)) && process.env.KINO_CUTOUT_GRACE_S !== "" ? Math.max(0, Number(process.env.KINO_CUTOUT_GRACE_S)) : 30 }),
  fontCatalog,
  exportBatches,
  // Sound effects from Openverse, behind the Settings switch (backend/sound-search.mjs).
  soundSearch: createSoundSearch({ enabled: () => dashboard.settings().sounds?.search === true, addMedia: addGeneratedMedia,
    freesoundKey: () => dashboard.settings().sounds?.freesoundKey ?? null,
    ...(process.env.KINO_OPENVERSE_API ? { api: process.env.KINO_OPENVERSE_API } : {}) }),
  // The built-in CC0 effects and CC BY music (backend/sound-library.mjs): files download on first
  // use into <data>/sound-library. Tests pass a stub catalog (KINO_SOUND_LIBRARY_CATALOG).
  soundLibrary: createSoundLibrary({ directory: path.join(dataRoot, "sound-library"), addMedia: addGeneratedMedia,
    ...(process.env.KINO_SOUND_LIBRARY_CATALOG ? { catalog: JSON.parse(readFileSync(process.env.KINO_SOUND_LIBRARY_CATALOG, "utf8")) } : {}) }),
  look: agentLook,
  inspire,
  soundtrack,
  // YouTube songs need no Settings switch: the no-music fix and the sound stop push a real song.
  songSearch: () => process.env.KINO_SONG_SEARCH !== "0",
  footage: footageFinder,
  // The person's song likes and rejects, across projects (backend/songTaste.mjs).
  songTaste: createSongTaste({ file: path.join(dataRoot, "song-taste.json") }),
  musicEmbed,
  soundTaste,
  // check's reference_drift measures rendered frames like a reference (backend/measure, Apple Vision).
  measureRender: async (pairs, options) => (await import("./measure/measure.mjs")).measureRendered(pairs, options),
  loadFonts: () => loadProjectFonts({ catalog: fontCatalog, mediaRoot }),
  operationContext: (document, operations) => operationContext(document, operations, OWNER_ACCESS),
  saveDocument: saveAgentDocument,
  async createProject(document) {
    const release = await acquireFileMutation();
    try {
      const created = await store.createProject(document, null);
      await rememberMediaUse(document.id, [document], OWNER_ACCESS);
      dashboard.publish({ type: "projects" });
      return created;
    } finally { release(); }
  },
  async duplicateProject(id, name) {
    const release = await acquireFileMutation();
    try {
      const duplicate = await store.duplicateProject(id, name);
      await rememberMediaUse(duplicate.document.id, [duplicate.document], OWNER_ACCESS);
      dashboard.publish({ type: "projects" });
      return duplicate;
    } finally { release(); }
  },
  async archiveProject(id) {
    const release = await acquireFileMutation();
    try {
      const result = await store.trashProject(id);
      projectUnavailable(id, "trashed");
      return result;
    } finally { release(); }
  },
  listMedia: () => readMediaRecords(),
  noteMediaUse: (projectId, ids) => noteMediaUse(projectId, ids),
  commentsChanged: broadcastComments,
  origin: () => `http://127.0.0.1:${server.address().port}`,
  async mediaPeaks(id) {
    if (!mediaFilePattern.test(id)) throw new Error("Invalid media ID.");
    const filename = path.join(mediaRoot, id);
    const metadata = JSON.parse(await readFile(`${filename}.json`, "utf8"));
    return audioPeaks.get(filename, metadata);
  },
  // {shots} or {shots: null, reason} for a layer's src (shot-detection.mjs).
  mediaShots: (src, options) => shotFinder.forSource(src, options),
  async deleteFolder(id) {
    const release = await acquireFileMutation();
    try {
      const result = await store.deleteFolder(id);
      for (const projectId of result.trashedProjectIds) projectUnavailable(projectId, "trashed");
      return result;
    } finally { release(); }
  },
  async manageShares(id, input) {
    const release = await acquireFileMutation();
    try {
      if (input.action === "create") return await shares.create(id, { role: input.role, label: input.label });
      if (input.action === "revoke") {
        const result = await shares.revoke(id, input.id);
        for (const { socket } of sessions.revoke(input.id)) socket.close(1008, "Sharing link revoked.");
        presence(id);
        return result;
      }
      if (!input.action || input.action === "list") return { shares: await shares.list(id) };
      throw new Error("Sharing action is list, create or revoke.");
    } finally { release(); }
  },
  async deleteProjectForever(id, confirm) {
    const release = await acquireFileMutation();
    try {
      if (confirm !== true) throw new Error("Deleting a file forever requires confirm: true.");
      const record = await store.getProject(id);
      if (!record?.trashedAt) throw new Error("Move this project to Trash before deleting it forever.");
      const fonts = await loadProjectFonts({ catalog: fontCatalog, mediaRoot });
      const references = await store.projectMediaReferences(fonts);
      for (const grant of await shares.list(id)) if (!grant.revokedAt) await shares.revoke(id, grant.id);
      const result = await store.deleteProjectForever(id);
      // Its agent state goes too: the brief holds the person's quoted words and replies.
      await agentState.remove(id);
      projectUnavailable(id, "deleted");
      const released = await releaseProjectMedia({ projectId: id, removedIds: mediaIds(record.document, { fonts }), projects: references.filter((project) => project.id !== id), mediaRoot, recordWrites: mediaRecordWrites });
      return { ...result, ...released };
    } finally { release(); }
  },
  // What you have selected in an open editor of this project (owner sessions only).
  pointing(projectId) {
    for (const client of clients.values())
      if (client.projectId === projectId && !client.grantId && client.selection?.layerIds?.length) return client.selection;
    return dashboard.pointing(projectId);
  },
  async emit(projectId, event) {
    // The pick box belongs to no project: only the dashboard hears it.
    if (event.kind === "picks") { dashboard.publish({ type: "picks", picks: event.picks }); return; }
    broadcast(projectId, { type: "agent-event", ...event });
    if (event.kind === "call") dashboard.publish({ type: "call", projectId, event: event.event, agent: await dashboardRoutes.agentSlice(projectId).catch(() => null) });
    if (event.kind === "note") dashboard.publish({ type: "note", projectId, note: event.note });
    // The agent edits an always note stopped (the whole list, so an answered one goes).
    if (event.kind === "stopped") dashboard.publish({ type: "stopped", projectId, stopped: event.stopped });
    if (event.kind === "judge") dashboard.publish({ type: "judge", projectId, judge: event.judge });
    if (event.kind === "tries") dashboard.publish({ type: "tries", projectId, tries: event.tries });
  },
  // Your dashboard settings and rules (plan §5.7, §5.9).
  approvals: {
    request: (request) => dashboard.request(request),
    limits: () => dashboard.settings().limits,
    // The approval rules, with the stops' ask or allow (backend/agent/stops.mjs stopRules).
    rules: () => dashboard.settings().approvals,
    get: (id) => dashboard.approval(id),
    // The person's answer told to the agent in the chat (notes answer with a Q id).
    answer: (id, input) => dashboardRoutes.answerApproval(id, input),
    cancel: (id) => dashboard.cancel(id),
    takeShareLink: (id) => dashboard.takeShareLink(id),
    pending: (projectId) => dashboard.approvals(projectId).filter((entry) => entry.status === "pending"),
  },
  hold: () => dashboard.hold(),
  heldCall: (projectId) => dashboard.heldCall(projectId),
  renderDefaults() {
    const { exports, compute } = dashboard.settings();
    return { format: exports.format, fps: exports.fps, folder: exports.folder || null, draftWidth: compute.draftWidth };
  },
  async createShare(projectId, { role, label }) {
    const { grant, token } = await shares.create(projectId, { role, label });
    const origin = publicOrigin ?? `http://${host}:${server.address().port}`;
    return { id: grant.id, url: shareUrl(`${origin}/`, projectId, {}, { token }) };
  },
  // The kino skill for agents without its files: SKILL.md, or with a name one of its references.
  async guideText(name) {
    const folder = path.join(root, "skills", "kino");
    if (!name) return (await readFile(path.join(folder, "SKILL.md"), "utf8")).replace(/^---[\s\S]*?---\s*/, "");
    const names = (await readdir(path.join(folder, "references"))).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));
    const wanted = String(name).replace(/^references\//, "").replace(/\.md$/, "");
    if (!names.includes(wanted)) throw Object.assign(new Error(`No guide "${name}". Guides: ${names.join(", ")}.`), { guides: names });
    return readFile(path.join(folder, "references", `${wanted}.md`), "utf8");
  },
});
const dashboardRoutes = createDashboardRoutes({
  store, agentService, agentState, dashboard, live: liveAgents, crew, launcher: crewLauncher, look: agentLook, frameCache, inspire, soundtrack, recorder, renderCache: exportBatches.renderCache, fontCatalog, agentDirectory, dataDirectory: dataRoot, mediaRoot,
  lastRender: () => lastRender,
  loadFonts: () => loadProjectFonts({ catalog: fontCatalog, mediaRoot }),
  json, body, sendFile, attachmentName,
  // The preview cache (preview-scheduler.mjs): draft segments for smooth playback, made while idle.
  // Settings: compute.previewCache turns it on or off, compute.previewCacheMegabytes is its size.
  previewCache: createPreviewCache({ dataDirectory: dataRoot, maxBytes: dashboard.settings().compute.previewCacheMegabytes * 1024 * 1024 }),
  previewEnabled: () => previewCacheOn() && dashboard.settings().compute.previewCache !== false, renderSettings: machineSettings,
});
// The render queue: tell open dashboards when a render job moves on.
const renderStates = new Map();
setInterval(async () => {
  try {
    const jobs = await agentService.renderJobs();
    for (const job of jobs) {
      const state = JSON.stringify([job.status, job.progress == null ? null : Math.round(job.progress * 100), job.path]);
      if (renderStates.get(job.id) === state) continue;
      renderStates.set(job.id, state);
      dashboard.publish({ type: "render", projectId: job.projectId, job });
    }
    // Jobs the agent service no longer keeps are forgotten here too.
    if (renderStates.size > jobs.length) {
      const kept = new Set(jobs.map((job) => job.id));
      for (const id of renderStates.keys()) if (!kept.has(id)) renderStates.delete(id);
    }
  } catch (error) { console.warn(`[kino] The render queue could not be read: ${error.message}`); }
}, 1000).unref();
const safeId = /^[a-zA-Z0-9_.:-]{1,128}$/;
// A comment's JSON is small: 2,000 characters of text and at most 20 mentions.
const COMMENT_BODY_LIMIT = 64 * 1024;
const mediaTypes = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  // Colour lookup tables (Adobe Cube LUT 1.0) for the lut effect.
  [LUT_MIME]: "cube",
};
const mimeTypes = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".cube": LUT_MIME,
};

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}
function acceptableOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (process.env.KINO_DESKTOP === "1") return url.origin === `http://${host}:${server.address().port}`;
    if (publicOrigin && url.origin === publicOrigin) return true;
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]", host].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
function forbidden(message = "This link does not permit that action.") {
  const error = new Error(message);
  error.status = 403;
  throw error;
}
async function authorize(req, url) {
  const token = req.headers["x-kino-share"] || url.searchParams.get("share");
  if (token) {
    const grant = await shares.authorize(token);
    if (!grant) forbidden("This sharing link was revoked or is invalid.");
    const project = await store.getProject(grant.projectId);
    if (!project || project.trashedAt) forbidden("This shared file is unavailable.");
    return { ...accessFor(grant.role), projectId: grant.projectId, grantId: grant.id };
  }
  const session = req.headers.cookie?.match(/(?:^|;\s*)kino_owner=([a-f0-9-]{36})(?:;|$)/)?.[1];
  if (ownerToken && (sameSecret(req.headers["x-kino-owner"], ownerToken) || ownerSessions.has(session))) return accessFor();
  const requestHost = new URL(`http://${req.headers.host || host}`).hostname;
  if (!ownerToken && localMode && ["127.0.0.1", "localhost", "[::1]"].includes(requestHost) && !req.headers["x-forwarded-for"] && !req.headers.forwarded) return accessFor();
  forbidden("Open a sharing link or use the host's workspace key.");
}
function requireOwner(access) { if (!access.manageShares) forbidden(); }
function requireProject(access, id) { if (access.projectId && access.projectId !== id) forbidden(); }
function requireEdit(access) { if (!access.canEdit) forbidden("This file is read-only for this link."); }
// The uploaded files a document uses, overridden pictures and fonts of instances included.
const mediaIds = documentMediaIds;
async function allowedMedia(access) {
  if (access.manageShares) return null;
  const record = await store.getProject(access.projectId);
  const ids = mediaIds(record.document);
  for (const entry of await readMediaRecords()) if (mediaAllowedIn(entry, access.projectId)) ids.add(entry.id);
  return ids;
}
// After a save, notes on the record of each media file the project's documents use that this
// project has used it (see media-use.mjs), so its sharing links keep that media after the layer
// is removed. `documents` are the saved documents before and after the change. The save has
// already succeeded, so a failure here is only logged.
const mediaRecordWrites = new Map(); // media ID → its last record write, so writes run in turn
async function recordMediaUse(projectId, id) {
  const record = path.join(mediaRoot, `${id}.json`);
  let entry;
  try {
    entry = JSON.parse(await readFile(record, "utf8"));
  } catch {
    return; // no readable record: nothing to note
  }
  const next = recordProjectUse(entry, projectId);
  if (!next) return;
  // Replace the record in one rename so a concurrent reader never sees half-written JSON.
  const temporary = `${record}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    await rename(temporary, record);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    console.warn(`[kino] Could not record that ${projectId} uses ${id}: ${error.message}`);
  }
}
async function rememberMediaUse(projectId, documents, access) {
  // Use the same font selection as rendering. Shared edits can only resolve
  // fonts already allowed in their file, so this cannot grant foreign uploads.
  const fonts = await loadProjectFonts({catalog: fontCatalog,  mediaRoot, allowedIds: await allowedMedia(access) });
  await noteMediaUse(projectId, new Set(documents.flatMap((document) => [...mediaIds(document, { fonts })])));
}
// Notes on each media record that `projectId` uses it (one write per record at a time). Also for a
// found clip another project cut that this project imports again (footage reuse, before any layer).
async function noteMediaUse(projectId, ids) {
  await Promise.all([...ids].map((id) => {
    const write = (mediaRecordWrites.get(id) ?? Promise.resolve())
      .then(() => recordMediaUse(projectId, id))
      .catch((error) => console.warn(`[kino] Could not record that ${projectId} uses ${id}: ${error.message}`))
      .finally(() => { if (mediaRecordWrites.get(id) === write) mediaRecordWrites.delete(id); });
    mediaRecordWrites.set(id, write);
    return write;
  }));
}
async function mediaPrefix(filename, length = 16) {
  const file = await open(filename, "r");
  const bytes = Buffer.alloc(length);
  try {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function decodeOneMediaUnit(filename, mime) {
  const audio = mime.startsWith("audio/");
  const args = audio
    ? ["-v", "error", "-xerror", "-i", filename, "-map", "0:a:0", "-frames:a", "1", "-f", "framemd5", "pipe:1"]
    : ["-v", "error", "-xerror", "-i", filename, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "pipe:1"];
  // One frame or sample: a run still going after a minute is stuck, and is stopped.
  const output = await runMediaTool("ffmpeg", args, { timeoutMs: 60_000 });
  if (!output.split(/\r?\n/).some((line) => /^\s*\d+\s*,/.test(line)))
    throw new Error("the file did not produce a decodable frame or audio sample");
}

async function measureStillImage(filename, mime) {
  if (mime === "image/gif") {
    const gif = parseGif(await readFile(filename));
    // Decode the first frame with the same parser and compositor used by the editor and exports.
    await composeGifFrames(gif, { wanted: (index) => index === 0, onFrame: () => {} });
    return {
      duration: Math.round(gif.durations.reduce((sum, value) => sum + value, 0) * 1000) / 1000,
      width: gif.width,
      height: gif.height,
      hasVideo: true,
      hasAudio: false,
      frameCount: gif.frames.length,
      animated: gif.frames.length > 1,
    };
  }
  const image = await loadImage(filename);
  return { duration: 0, width: image.width, height: image.height, hasVideo: true, hasAudio: false, ...pictureFacts(image) };
}

// edges, flat and busy (engine/imageFacts.js), measured once on a 96 px wide gray copy.
function pictureFacts(image) {
  try {
    const width = 96;
    const height = Math.max(1, Math.min(400, Math.round((width * image.height) / image.width)));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const gray = new Uint8Array(width * height);
    for (let index = 0; index < gray.length; index += 1) gray[index] = Math.round(0.299 * data[index * 4] + 0.587 * data[index * 4 + 1] + 0.114 * data[index * 4 + 2]);
    return imageFacts(gray, width, height);
  } catch {
    // busy: null marks it measured, so a picture that cannot be read is not measured on every listing.
    return { busy: null };
  }
}

// Length, picture size, stream kind, and a decodable picture or audio sample for uploaded media.
async function measureMedia(filename, mime) {
  if (!/^(?:image|video|audio)\//.test(mime)) return {};
  // SVG uploads are sanitized and parsed by prepareSvgAsset before they reach this function.
  if (mime === "image/svg+xml") return { measurementVersion: 1, measurementSucceeded: true };
  let probe;
  try {
    const signatureMatches = mediaSignatureMatches(mime, await mediaPrefix(filename));
    if (!signatureMatches) return { duration: 0, measurementVersion: 1, measurementSucceeded: false };
    if (mime.startsWith("image/")) {
      const image = await measureStillImage(filename, mime);
      return {
        ...image,
        measurementVersion: 1,
        measurementSucceeded: mediaStreamsMatch(mime, image),
      };
    }
    probe = await probeMedia(filename);
    const matchesMime = mediaStreamsMatch(mime, probe);
    if (!matchesMime) {
      console.warn(`[kino] Could not measure ${path.basename(filename)}: content does not match ${mime}.`);
      return { ...probe, measurementVersion: 1, measurementSucceeded: false };
    }
    await decodeOneMediaUnit(filename, mime);
    // A video's frame facts tell a screen recording from camera footage (screen_unreadable).
    const frame = mime.startsWith("video/") && probe.hasVideo ? await videoFrameFacts(filename, probe.duration) : {};
    return {
      ...(frame ?? {}),
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      hasVideo: probe.hasVideo,
      measurementVersion: 1,
      measurementSucceeded: true,
      ...(mime === "image/gif" && probe.frameCount !== undefined ? { frameCount: probe.frameCount, animated: probe.animated } : {}),
      ...(probe.log ? { log: probe.log, logWhy: probe.logWhy } : {}),
    };
  } catch (error) {
    console.warn(`[kino] Could not measure ${path.basename(filename)}: ${error.message}`);
    return { ...(probe ?? {}), duration: probe?.duration ?? 0, measurementVersion: 1, measurementSucceeded: false };
  }
}
// Adds a file kino made itself (a voice stem from isolate_voice, a cut-out from cut_out) to the
// media library, as an upload would: a new <uuid>.<ext> file, measured, with its .json record.
// The file is moved in.
// Like the agent's imports it belongs to no one project; saving a project that uses it records
// the use (rememberMediaUse).
// `extra` adds fields to the record (an Openverse sound's credit; a found clip's projectId, credit
// and footage code). A video gets its shots found, as an upload does.
async function addGeneratedMedia(file, { name, mime, extra = {} }) {
  const extension = mediaTypes[mime];
  if (!extension || !(/^(?:audio|video)\//.test(mime) || mime === "image/png")) throw new Error(`kino does not keep made ${mime} files.`);
  const id = `${randomUUID()}.${extension}`;
  const target = path.join(mediaRoot, id);
  try { await rename(file, target); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(file, target);
  }
  try {
    const measurements = await measureMedia(target, mime);
    if (measurements.measurementSucceeded !== true) throw new Error(`The made file ${name} could not be read back as ${mime}.`);
    const { size } = await stat(target);
    const shots = mime.startsWith("video/") && measurements.hasVideo !== false ? await uploadShots(target, measurements.duration) : {};
    const metadata = { id, src: `/api/media/${id}`, name: String(name).slice(0, 200), mime, size, ...measurements, ...shots, ...extra };
    await writeMediaRecord(mediaRoot, id, metadata);
    return metadata;
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}
// Media records saved before uploads were measured get measured once, the first time they are listed.
const pendingMeasurements = new Map();
function withMeasurements(entry) {
  const needsSize = (item) => !Number.isSafeInteger(item.size) || item.size < 0;
  const needsProbe = (item) => /^(?:image|video|audio)\//.test(item.mime) &&
    (item.measurementVersion !== 1 || !Object.hasOwn(item, "measurementSucceeded")
      // Pictures measured before kino read their busiest region (engine/imageFacts.js).
      || (/^image\/(?:png|jpeg|webp)$/.test(item.mime) && item.measurementSucceeded === true && !Object.hasOwn(item, "busy")));
  if ((!needsSize(entry) && !needsProbe(entry)) || !mediaFilePattern.test(entry.id)) return entry;
  let promise = pendingMeasurements.get(entry.id);
  if (!promise) {
    // Share-use writes and metadata backfills use the same queue and re-read the latest
    // record, so measuring a source cannot erase a concurrent retention update.
    promise = (mediaRecordWrites.get(entry.id) ?? Promise.resolve()).then(async () => {
      const record = path.join(mediaRoot, `${entry.id}.json`);
      const current = JSON.parse(await readFile(record, "utf8"));
      const filename = path.join(mediaRoot, entry.id);
      const measured = { ...current,
        ...(needsSize(current) ? { size: (await stat(filename)).size } : {}),
        ...(needsProbe(current) ? await measureMedia(filename, current.mime) : {}),
      };
      // Replace the record in one rename so a concurrent reader never sees half-written JSON.
      // The temporary name does not end in .json, so record listings never pick it up.
      const temporary = `${record}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(measured), { mode: 0o600, flag: "wx" });
        await rename(temporary, record);
      } catch (error) {
        await rm(temporary, { force: true });
        console.warn(`[kino] Could not save measurements for ${entry.id}: ${error.message}`);
      }
      return measured;
    }).finally(() => {
      pendingMeasurements.delete(entry.id);
      if (mediaRecordWrites.get(entry.id) === promise) mediaRecordWrites.delete(entry.id);
    });
    pendingMeasurements.set(entry.id, promise);
    mediaRecordWrites.set(entry.id, promise);
  }
  return promise;
}

// A video measured before kino read its frame facts gets them once, the first time check needs
// them (backend/agent/quality.mjs): one FFmpeg run at a time, saved into its record. A failed run
// saves nothing and is tried again after FACTS_RETRY_MS.
let videoFactsQueue = Promise.resolve();
const FACTS_RETRY_MS = 10 * 60_000;
const factsFailed = new Map();
function videoFactsOf(id) {
  if (!mediaFilePattern.test(id)) return Promise.resolve({});
  if (Date.now() - (factsFailed.get(id) ?? -Infinity) < FACTS_RETRY_MS) return Promise.resolve({});
  const job = videoFactsQueue.then(async () => {
    const record = JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8"));
    if (Object.hasOwn(record, "busy")) return { busy: record.busy, edges: record.edges, flat: record.flat };
    const facts = await videoFrameFacts(path.join(mediaRoot, id), record.duration);
    if (!facts) { factsFailed.set(id, Date.now()); return {}; }
    await saveMediaRecord(id, facts);
    return facts;
  });
  videoFactsQueue = job.catch(() => {});
  return job;
}

// Saves `fields` into a media record, in turn with the other record writes (as withMeasurements
// does): it re-reads the latest record and replaces it in one rename. A failure is only logged.
function saveMediaRecord(id, fields) {
  const write = (mediaRecordWrites.get(id) ?? Promise.resolve()).then(async () => {
    const record = path.join(mediaRoot, `${id}.json`);
    const temporary = `${record}.${randomUUID()}.tmp`;
    try {
      const current = JSON.parse(await readFile(record, "utf8"));
      await writeFile(temporary, JSON.stringify({ ...current, ...fields }), { mode: 0o600, flag: "wx" });
      await rename(temporary, record);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      console.warn(`[kino] Could not save the shots of ${id}: ${error.message}`);
    }
  }).finally(() => { if (mediaRecordWrites.get(id) === write) mediaRecordWrites.delete(id); });
  mediaRecordWrites.set(id, write);
  return write;
}
// Writes an uploaded .mov or .m4v to `target` as an MP4 (media-remux.mjs). The upload itself is
// kept only in a temporary folder while FFmpeg copies it.
// A .mov with an alpha channel (ProRes 4444) becomes a transparent VP9 WebM instead (the file id
// then ends in .webm). Resolves with { id, mime, converted }; converted is the line the import
// answer shows, or null for the MP4 copy.
async function remuxUpload(bytes, uuid) {
  const folder = await makeTempFolder("kino-remux-");
  let target = path.join(mediaRoot, `${uuid}.mp4`);
  try {
    const source = path.join(folder, "upload.mov");
    await writeFile(source, bytes, { mode: 0o600 });
    const picture = await probePicture(source).catch(() => null);
    if (picture?.alpha) {
      target = path.join(mediaRoot, `${uuid}.webm`);
      const { line } = await alphaToWebm(source, target, picture);
      return { id: `${uuid}.webm`, mime: "video/webm", converted: line };
    }
    await remuxToMp4(source, target);
    return { id: `${uuid}.mp4`, mime: "video/mp4", converted: null };
  } catch (error) {
    await rm(target, { force: true });
    if (error.status) throw error;
    const into = target.endsWith(".webm") ? "convert this video to a transparent webm" : "copy this video into an MP4";
    const failed = new Error(`kino could not ${into}: ${firstErrorLine(error)}`);
    failed.status = 422;
    throw failed;
  } finally {
    await removeTempFolder(folder);
  }
}

// A new video's shots for its record (shot-detection.mjs). When FFmpeg cannot find them the
// upload is still kept, and the record says why.
async function uploadShots(filename, duration) {
  try {
    const { shots, found } = await findShots(filename, { duration });
    return { shots, shotsFound: found };
  } catch (error) {
    console.warn(`[kino] Could not find the shots in ${path.basename(filename)}: ${error.message}`);
    return { shotsError: firstErrorLine(error) };
  }
}

async function replacementMediaRecords(document, operations, access) {
  const replacements = operations.filter((operation) => operation?.type === "replace_media");
  const required = new Set(replacements.map((operation) => operation.mediaId));
  const ids = new Set(required);
  for (const operation of replacements) {
    const layer = document.scenes.find((scene) => scene.id === operation.sceneId)?.layers.find((item) => item.id === operation.layerId);
    const oldId = mediaIdFromSource(layer?.src);
    if (oldId) ids.add(oldId);
  }
  const allowed = await allowedMedia(access), records = new Map();
  for (const id of ids) {
    if (!MEDIA_ID_PATTERN.test(id)) throw new Error("Replace Media needs an uploaded media ID, including its extension.");
    if (allowed && !allowed.has(id)) forbidden("This link cannot use media from another file.");
    try {
      const entry = JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8"));
      if (entry.id !== id || (required.has(id) && !existsSync(path.join(mediaRoot, id)))) throw new Error("Missing media file.");
      const measured = await withMeasurements(entry);
      if (required.has(id) && measured.measurementSucceeded !== true)
        throw new Error(`Uploaded media ${measured.name || id} could not be decoded or does not match its declared type.`);
      records.set(id, measured);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!required.has(id)) continue; // A missing old source can still be repaired by replacement.
      throw new Error(`Uploaded media ${id} was not found.`);
    }
  }
  return records;
}
// Fixed answers for a GIF whose frames cannot be served: too large, too slow, or undecodable.
// 413 and 422 are permanent answers (the editor stops asking and shows the GIF file);
// a timeout or a server problem such as a full disk can succeed later, so the editor asks again.
function gifFramesError(error) {
  const [status, message] =
    error.code === "GIF_TOO_LARGE" ? [413, "This GIF is too large to decode frame by frame."]
    : error.code === "GIF_UNREADABLE" ? [422, "This GIF's frames could not be decoded."]
    : error.code === "GIF_DECODE_TIMEOUT" ? [503, "This GIF took too long to decode. Try again later."]
    : [500, "The server could not prepare this GIF's frames. Try again later."];
  const failure = new Error(message);
  failure.status = status;
  return failure;
}
// Runs one step of the GIF frame cache. The real reason for a failure stays in the server log;
// clients get a fixed message without file paths.
async function fromGifFrameCache(file, step) {
  try {
    return await step();
  } catch (error) {
    console.warn(`[kino] GIF frames for ${file} could not be decoded: ${error.message}`);
    throw gifFramesError(error);
  }
}
async function sendGifFrames(req, res, parts, access) {
  const file = parts[2];
  const allowed = await allowedMedia(access);
  if (allowed && !allowed.has(file)) forbidden("This link cannot read media from another file.");
  const filename = path.join(mediaRoot, file);
  if (!existsSync(filename)) return json(res, 404, { error: "This media file is missing." });
  if (path.extname(file) !== ".gif") return json(res, 400, { error: "Only GIF images have decoded frames." });
  if (parts.length === 4) {
    const { count, durations, width, height } = await fromGifFrameCache(file, () => gifFrames.timeline(file, filename));
    // The decoder version goes into the editor's frame URLs, so browsers that cached frames
    // as immutable ask again after a decoder change.
    return json(res, 200, { count, durations, width, height, decoder: GIF_DECODER_VERSION });
  }
  // Frame numbers are written without leading zeros, as the editor requests them.
  const match = /^(0|[1-9]\d{0,5})\.png$/.exec(parts[4]);
  const index = match ? Number(match[1]) : -1;
  // The frame is opened before anything is sent. If its folder was removed (for example to keep the
  // cache within its disk budget), the cache decodes the GIF again instead of failing.
  const frame = await fromGifFrameCache(file, () => gifFrames.openFrame(file, filename, index));
  if (!frame) return json(res, 404, { error: "This GIF frame does not exist." });
  return await sendOpenFile(req, res, frame, "image/png", access.manageShares);
}
async function assertMediaAccess(document, access) {
  const allowed = await allowedMedia(access);
  if (allowed && [...mediaIds(document)].some((id) => !allowed.has(id))) forbidden("This link cannot use media from another file.");
}
async function exportInput(input, access) {
  if (!access.canExport) forbidden("This link does not permit exporting.");
  let document = parseExportDocument(input);
  if (access.projectId) {
    requireProject(access, document.id);
    if (!access.canEdit) document = (await store.getProject(access.projectId)).document;
    await assertMediaAccess(document, access);
    if (["embedMedia", "videoFrames", "imageFrames", "frameInputs"].some((key) => input.options && Object.hasOwn(input.options, key))) forbidden("Shared exports use media attached to this file.");
  }
  const fonts = await loadProjectFonts({catalog: fontCatalog, mediaRoot, allowedIds: await allowedMedia(access) });
  await ensureDocumentFonts(document, fontCatalog, { allowMissing: true, fonts });
  return { document, fonts };
}
function requireBatch(access, batch) {
  requireProject(access, batch.document.id);
  if (!access.canExport || (!access.manageShares && batch.grantId !== access.grantId)) forbidden("This link cannot access another export queue.");
}
function attachmentName(name) {
  return `attachment; filename="${name.replace(/[^a-zA-Z0-9_. -]/g, "-")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
// Operations that measure text with the project's fonts (auto-sized text, staggers by text
// unit, catalog presets that size to the visible text box) get the font registry.
const OPERATIONS_NEEDING_FONTS = new Set(["create_component_from_layers", "outline_text", "detach_component", "align_layers", "group_layers", "ungroup_layer", "create_mask", "remove_mask", "move_layers", "update_layers", "stagger_animations", "add_animation", "update_animation", "update_animations"]);
// What applyOperations needs besides the document: fonts, bulk-create media, replacement media.
async function operationContext(document, operations, access) {
  const list = Array.isArray(operations) ? operations : [];
  // Axes (fontAxes.js) are checked against the font's ranges, so an edit that sets them loads the fonts too.
  const fonts = list.some((operation) => OPERATIONS_NEEDING_FONTS.has(operation?.type) || operation?.properties?.axes !== undefined)
    ? await loadProjectFonts({ catalog: fontCatalog, mediaRoot, allowedIds: await allowedMedia(access) }) : undefined;
  const mediaBySrc = list.some((operation) => operation?.type === "bulk_create")
    ? await loadBulkCreateMediaSources(list, { mediaRoot, allowedIds: await allowedMedia(access), document }) : undefined;
  const mediaById = list.some((operation) => operation?.type === "replace_media")
    ? await replacementMediaRecords(document, list, access) : undefined;
  // An audio behavior reads its sound's band levels (sound-bands.mjs), measured once per file.
  const soundLevels = await soundLevelsFor(document, list, { mediaRoot, cache: soundBands });
  return { fonts, mediaBySrc, mediaById, soundLevels };
}
const soundBands = createSoundBandsCache();
// Only a draft goes ahead while the video's stops are open (direction plan B2c): anything else
// these older export routes make is full quality, so it counts as a final render. Answers the
// refusal's words, or null when the export may go on.
async function finalStopsOpen(options, projectId) {
  if (options?.renderQuality === "draft") return null;
  return agentService.finalRefused(projectId);
}
// Saves a document the agent service made (the owner's own edit), then tells open editors.
async function saveAgentDocument(projectId, before, document, expectedRevision, { request, actor = "mcp", resultMetadata } = {}) {
  const release = await acquireFileMutation();
  try {
    const updated = await store.updateProject(projectId, document, expectedRevision, { request, resultMetadata });
    if (updated.document) {
      await rememberMediaUse(projectId, [before, updated.document], OWNER_ACCESS);
      editFocusFor.set(projectId, { revision: updated.revision, focus: editFocus(before, updated.document) });
      broadcast(projectId, { type: "document", document: updated.document, revision: updated.revision, actor,
        author: actor === "you" ? "You" : "An agent" });
    }
    return updated;
  } finally { release(); }
}
async function body(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Upload exceeds the size limit.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (req.headers["content-type"]?.startsWith("application/json")) {
    try {
      return JSON.parse(bytes.toString());
    } catch {
      throw new Error("Request contains invalid JSON.");
    }
  }
  return bytes;
}
function requireOnlyFields(input, allowed, label) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${label} must be a JSON object.`);
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length)
    throw new Error(`${label} cannot contain ${unexpected.join(", ")}.`);
  return input;
}
// The last agent edit's focus per project, picked up by the dashboard's document event.
const editFocusFor = new Map();
function broadcast(projectId, message, except) {
  if (message.type === "document") reconcilePresence(projectId, message.document);
  if (message.type === "document") {
    const focus = editFocusFor.get(projectId);
    editFocusFor.delete(projectId);
    dashboard.publish({ type: "document", projectId, rev: message.revision, actor: message.actor ?? null,
      focus: focus?.revision === message.revision ? focus.focus : null });
  }
  if (message.type === "project-lifecycle") dashboard.publish({ type: "lifecycle", projectId, state: message.state });
  for (const [socket, client] of clients) {
    if (
      client.projectId === projectId &&
      socket !== except &&
      socket.readyState === 1
    )
      socket.send(JSON.stringify(message));
  }
}
function documentAuthor(projectId, actor, access) {
  for (const client of clients.values()) {
    if (client.projectId === projectId && client.actorId === actor && (client.grantId || null) === (access.grantId || null))
      return client.name || "Someone";
  }
  return actor === "mcp" ? "An agent" : "Someone";
}
function projectUnavailable(id, state) {
  broadcast(id, { type: "project-lifecycle", projectId: id, state });
  for (const [socket, client] of clients) {
    if (client.projectId !== id) continue;
    client.sceneId = null; client.selection = null;
    if (client.grantId) { sessions.leave(socket); socket.close(1008, "Shared file is unavailable."); }
  }
  presence(id);
}
// Every open session of the project receives the full comment list after a comment write (and
// a session that joins receives it at once; see the "join" handler). The store's copies leave
// out author key hashes. The owner's dashboard gets the same list as a "comments" event.
async function broadcastComments(projectId) {
  const { comments } = await store.getProject(projectId);
  broadcast(projectId, { type: "comments", comments });
  dashboard.publish({ type: "comments", projectId, comments });
}
function presence(projectId) {
  const people = sessions.people(projectId);
  for (const [socket, client] of clients)
    if (client.projectId === projectId && socket.readyState === 1)
      socket.send(JSON.stringify({ type: "presence", people, selfId: client.id }));
}
function selectionMessage(client) {
  return { type: "selection", id: client.id, name: client.name, color: client.color, ...client.selection };
}
function reconcilePresence(projectId, document) {
  let rosterChanged = false;
  for (const client of clients.values()) {
    if (client.projectId !== projectId || !client.selection) continue;
    const selection = pruneSelection(document, client.selection);
    if (JSON.stringify(selection) === JSON.stringify(client.selection)) continue;
    rosterChanged ||= client.sceneId !== selection.sceneId;
    client.sceneId = selection.sceneId;
    client.selection = selection;
    broadcast(projectId, selectionMessage(client));
  }
  if (rosterChanged) presence(projectId);
}
async function sendFile(req, res, filename, mime, immutable = false) {
  let handle;
  try { handle = await open(filename, "r"); }
  catch (error) {
    // A file removed (or never made) is missing, not a server failure.
    if (error.code === "ENOENT") return json(res, 404, { error: "This file is missing." });
    throw error;
  }
  await sendOpenFile(req, res, handle, mime, immutable);
}
// Sends a file that is already open (a FileHandle) and then closes it. The size and the bytes
// come from the same open file, so the answer stays whole even if the file is removed meanwhile.
async function sendOpenFile(req, res, handle, mime, immutable = false) {
  try {
    await sendFileContents(req, res, handle, mime, immutable);
  } finally {
    await handle.close();
  }
}
async function sendFileContents(req, res, handle, mime, immutable) {
  const info = await handle.stat();
  const headers = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Accept-Ranges": "bytes",
    "Cache-Control": immutable
      ? "private, max-age=31536000, immutable"
      : "no-cache",
  };
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2]
      ? Math.min(Number(range[2]), info.size - 1)
      : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${info.size}`,
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": info.size });
    if (req.method === "HEAD") res.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), res);
  }
}

const server = http.createServer(async (req, res) => {
  // A request target such as "//" is not a URL: answering 400 here keeps it from becoming an
  // unhandled rejection that stops the whole service.
  let url;
  try { url = new URL(req.url || "/", `http://${host}:${port}`); } catch { return json(res, 400, { error: "Invalid request URL." }); }
  const parts = url.pathname.split("/").filter(Boolean);
  let releaseFileMutation;
  try {
    if (parts[0] === "api") {
      if (!acceptableOrigin(req.headers.origin))
        return json(res, 403, {
          error: "This server accepts requests only from its own editor.",
        });
      const method = req.method;
      if (url.pathname === "/api/health")
        return json(res, 200, {
          ready: true,
          version: "0.1.0",
          storage: "persistent",
          rendering: "ffmpeg",
        });
      let access = await authorize(req, url);
      if (url.pathname === "/api/access" && method === "GET") return json(res, 200, { access });
      // Keep new references and media collection in order across concurrent HTTP clients.
      // An upload (POST /api/media) takes the lock itself, only to write its record.
      const upload = parts[1] === "media" && parts.length === 2 && method === "POST";
      if (["projects", "folders", "media"].includes(parts[1]) && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && !upload) {
        releaseFileMutation = await acquireFileMutation();
        // A queued request may have lost its grant while waiting behind revocation.
        access = await authorize(req, url);
      }
      if (url.pathname === "/api/export-batches" && method === "POST") {
        const input = await body(req);
        const prepared = await exportInput(input, access);
        const stopsOpen = await finalStopsOpen(input.options, prepared.document.id);
        if (stopsOpen) return json(res, 409, { error: stopsOpen, code: "stops_open" });
        const batch = await exportBatches.create({ ...prepared, sceneIds: input.sceneIds, options: input.options, requestId: input.requestId, grantId: access.grantId ?? null });
        return json(res, 202, { batch: exportBatches.snapshot(batch) });
      }
      if (parts[1] === "export-batches" && parts[2]) {
        const batch = exportBatches.get(parts[2]);
        requireBatch(access, batch);
        if (parts.length === 3 && method === "GET") return json(res, 200, { batch: exportBatches.snapshot(batch) });
        if (parts.length === 3 && method === "DELETE") {
          await exportBatches.remove(batch.id);
          return json(res, 200, { closed: true });
        }
        if (parts.length === 4 && parts[3] === "actions" && method === "POST")
          return json(res, 200, { batch: await exportBatches.action(batch, await body(req)) });
        if (parts.length === 6 && parts[3] === "jobs" && ["file", "thumbnail"].includes(parts[5]) && ["GET", "HEAD"].includes(method)) {
          const file = exportBatches.file(batch, parts[4], parts[5] === "thumbnail");
          if (parts[5] === "file") res.setHeader("Content-Disposition", attachmentName(file.name));
          return await sendFile(req, res, file.path, file.mime);
        }
        if (parts.length === 4 && parts[3] === "archive" && method === "GET") {
          const controller = new AbortController();
          res.on("close", () => { if (!res.writableEnded) controller.abort(); });
          activeExports.add(controller);
          let directory;
          try {
            directory = await makeTempFolder("kino-batch-download-");
            const output = await exportBatches.archive(batch, path.join(directory, "export.zip"), { signal: controller.signal });
            res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": output.size,
              "Content-Disposition": attachmentName(exportFileName(batch.document.name, "zip")),
              "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            await pipeline(createReadStream(output.path), res, { signal: controller.signal });
          } finally {
            activeExports.delete(controller);
            await removeTempFolder(directory);
          }
          return;
        }
      }
      if (url.pathname === "/api/export-capabilities" && method === "GET") {
        const configuration = Object.fromEntries(["width", "height", "fps"]
          .filter((key) => url.searchParams.has(key))
          // fps stays text: "29.97" and "30000/1001" are read by the encoder probe (frameRate.js).
          .map((key) => [key, key === "fps" ? url.searchParams.get(key) : Number(url.searchParams.get(key))]));
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableEnded) controller.abort(); });
        activeExports.add(controller);
        try {
          return json(res, 200, { mp4Encoders: await getMp4Encoders(configuration, { signal: controller.signal, videoEncoder: videoDefaults().videoEncoder }) });
        } finally {
          activeExports.delete(controller);
        }
      }
      if (parts[1] === "export-progress" && parts.length === 3 && method === "GET") {
        const scope = exportProgress.getScope(parts[2]);
        if (!scope) return json(res, 404, { error: "This export progress record is unavailable." });
        requireBatch(access, { document: { id: scope.projectId }, grantId: scope.grantId });
        return json(res, 200, exportProgress.get(parts[2]));
      }
      if (url.pathname === "/api/session" && method === "POST") {
        requireOwner(access);
        const id = randomUUID();
        ownerSessions.add(id);
        res.setHeader("Set-Cookie", `kino_owner=${id}; HttpOnly; SameSite=Strict; Path=/${publicOrigin?.startsWith("https:") ? "; Secure" : ""}`);
        return json(res, 200, { access });
      }
      if (url.pathname === "/api/mcp-config")
        if (!access.manageShares) forbidden();
      if (url.pathname === "/api/mcp-config")
        return json(res, 200, {
          mcpServers: {
            "kino": {
              command: process.env.KINO_MCP_COMMAND || process.execPath,
              args: process.env.KINO_MCP_ARGS ? JSON.parse(process.env.KINO_MCP_ARGS) : [path.join(root, "backend/mcp.mjs")],
              env: process.env.KINO_MCP_ENV ? JSON.parse(process.env.KINO_MCP_ENV) : { MOTION_API_URL: `http://${host}:${server.address().port}` },
            },
          },
        });
      if (url.pathname === "/api/shared-project" && method === "GET") {
        if (!access.projectId) forbidden("Open a file capability link to use this endpoint.");
        const record = await store.getProject(access.projectId);
        if (!record || record.trashedAt) forbidden("This shared file is unavailable.");
        return json(res, 200, { ...record, access });
      }
      if (url.pathname === "/api/shared-fonts" && method === "GET") {
        if (!access.projectId) forbidden("Open a file capability link to use this endpoint.");
        const record = await store.getProject(access.projectId);
        if (!record || record.trashedAt) forbidden("This shared file is unavailable.");
        const { document } = record;
        const fonts = await loadProjectFonts({ catalog: fontCatalog, mediaRoot, allowedIds: await allowedMedia(access) });
        const errors = await ensureDocumentFonts(document, fontCatalog, { allowMissing: true, fonts });
        requireProject(await authorize(req, url), document.id);
        return json(res, 200, { fonts: viewerFontEntries(document, fonts), errors });
      }
      if (parts[1] === "easings") {
        requireOwner(access);
        if (parts.length === 2 && method === "GET")
          return json(res, 200, { easings: await store.listEasings() });
        if (parts.length === 2 && method === "POST") {
          const input = requireOnlyFields(await body(req, 16 * 1024), ["name", "easing", "intensity"], "Saved easing");
          return json(res, 201, { easing: await store.saveEasing(input) });
        }
        if (parts.length === 3 && method === "PATCH") {
          const input = requireOnlyFields(await body(req, 16 * 1024), ["name"], "Saved easing rename");
          return json(res, 200, { easing: await store.renameEasing(parts[2], input.name) });
        }
        if (parts.length === 3 && method === "DELETE")
          return json(res, 200, await store.deleteEasing(parts[2]));
        return json(res, 404, { error: "This endpoint could not be found." });
      }
      // The dashboard (plan §5): owner only; changes need the window's review key.
      if (parts[1] === "dashboard") {
        requireOwner(access);
        return await dashboardRoutes.handle(req, res, url, parts);
      }
      // The agent verbs (status, edit, check, look, inspect, render, library, history, notes,
      // project). Owner only. Every answer is HTTP 200 with { text, data?, images?, isError? }.
      // `client` is the MCP client's own name (untrusted: cleanKind); the x-kino-session header,
      // which the thin client adds by itself, tells one agent from another (live.mjs).
      // Each answer carries the hash of kino's tool list (x-kino-tools), and GET /api/agent/tools
      // gives the list: an MCP server started before an update reloads it (agent/tool-sync.mjs).
      if (parts[1] === "agent" && parts.length === 3 && parts[2] === "tools" && method === "GET") {
        requireOwner(access);
        return json(res, 200, await agentToolList());
      }
      if (parts[1] === "agent" && parts.length === 3 && method === "POST") {
        requireOwner(access);
        const { by, client, ...input } = (await body(req, 4 * 1024 * 1024)) ?? {};
        res.setHeader("x-kino-tools", (await agentToolList()).hash);
        return json(res, 200, await agentService.call(parts[2], input, {
          by: by === "you" ? "you" : undefined, client: typeof client === "string" ? cleanKind(client) : null,
          session: validSession(req.headers["x-kino-session"]),
        }));
      }
      if (parts[1] === "text-effects") {
        requireOwner(access);
        if (parts.length === 2 && method === "GET")
          return json(res, 200, { textEffects: await store.listTextEffects() });
        if (parts.length === 2 && method === "POST") {
          const input = requireOnlyFields(await body(req, 512 * 1024), ["name", "animation", "rest"], "Saved text effect");
          return json(res, 201, { textEffect: await store.saveTextEffect(input) });
        }
        if (parts.length === 3 && method === "PATCH") {
          const input = requireOnlyFields(await body(req, 16 * 1024), ["name"], "Saved text effect rename");
          return json(res, 200, { textEffect: await store.renameTextEffect(parts[2], input.name) });
        }
        if (parts.length === 3 && method === "DELETE")
          return json(res, 200, await store.deleteTextEffect(parts[2]));
        return json(res, 404, { error: "This endpoint could not be found." });
      }
      if (url.pathname === "/api/trash" && method === "GET") {
        requireOwner(access);
        return json(res, 200, { projects: await store.listTrashedProjects() });
      }
      if (url.pathname === "/api/projects" && method === "GET") {
        requireOwner(access);
        return json(res, 200, {
          projects: await store.listProjects(),
          folders: await store.listFolders(),
          access,
        });
      }
      if (url.pathname === "/api/projects" && method === "POST") {
        requireOwner(access);
        const input = await body(req);
        const document = parseDocument(input.document || createDocument());
        const created = await store.createProject(document, input.folderId ?? null);
        await rememberMediaUse(document.id, [document], access);
        return json(res, 201, created);
      }
      if (parts[1] === "projects" && parts[2] && safeId.test(parts[2])) {
        const id = parts[2];
        requireProject(access, id);
        if (["duplicate", "restore", "permanent"].includes(parts[3])) requireOwner(access);
        const record = await store.getProject(id);
        if (!record)
          return json(res, 404, { error: "This project could not be found." });
        if (parts.length === 3 && method === "GET")
          return json(res, 200, { ...record, access });
        if (parts.length === 4 && parts[3] === "duplicate" && method === "POST") {
          const duplicate = await store.duplicateProject(id);
          await rememberMediaUse(duplicate.document.id, [duplicate.document], access);
          return json(res, 201, duplicate);
        }
        if (parts.length === 4 && parts[3] === "permanent" && method === "DELETE") {
          const input = await body(req);
          if (input?.confirm !== true) throw new Error("Deleting a file forever requires confirm: true.");
          // Revoke before removal so reusing an old project ID cannot resurrect its links.
          if (!record.trashedAt) throw new Error("Move this project to Trash before deleting it forever.");
          // Resolve every surviving document before removing bytes, including
          // older family-only references never recorded in upload metadata.
          const fonts = await loadProjectFonts({catalog: fontCatalog,  mediaRoot });
          const references = await store.projectMediaReferences(fonts);
          for (const grant of await shares.list(id)) if (!grant.revokedAt) await shares.revoke(id, grant.id);
          const result = await store.deleteProjectForever(id);
          // Its agent state goes too: the brief holds the person's quoted words and replies.
          await agentState.remove(id);
          projectUnavailable(id, "deleted");
          const released = await releaseProjectMedia({ projectId: id, removedIds: mediaIds(record.document, { fonts }),
            projects: references.filter((project) => project.id !== id), mediaRoot, recordWrites: mediaRecordWrites });
          return json(res, 200, { ...result, ...released });
        }
        if (parts[3] === "shares") {
          requireOwner(access);
          if (parts.length === 4 && method === "GET") return json(res, 200, { shares: await shares.list(id) });
          if (parts.length === 4 && method === "POST") return json(res, 201, await shares.create(id, await body(req)));
          if (parts.length === 5 && method === "DELETE") {
            const result = await shares.revoke(id, parts[4]);
            for (const { socket } of sessions.revoke(parts[4])) socket.close(1008, "Sharing link revoked.");
            presence(id);
            return json(res, 200, result);
          }
        }
        if (parts.length === 3 && method === "PUT") {
          requireEdit(access);
          const input = await body(req);
          const document = parseDocument(input.document);
          if (document.id !== id) throw new Error("Project ID cannot change.");
          await assertMediaAccess(document, access);
          const allowed = await allowedMedia(access);
          const updated = await store.updateProject(
            id,
            document,
            input.revision,
            { merge(base, ours, theirs) {
              const merged = mergeDocuments(base, ours, theirs);
              merged.document = parseDocument(merged.document);
              if (allowed && [...mediaIds(merged.document)].some((mediaId) => !allowed.has(mediaId)))
                throw new Error("Merged media is outside this file.");
              return merged;
            } },
          );
          await rememberMediaUse(id, [record.document, updated.document], access);
          broadcast(id, {
            type: "document",
            document: updated.document,
            revision: updated.revision,
            actor: input.actor || null,
            conflicts: updated.conflicts || [],
            author: documentAuthor(id, input.actor, access),
          });
          return json(res, 200, updated);
        }
        if (parts[3] === "operations" && method === "POST") {
          requireEdit(access);
          const input = await body(req);
          if (!Number.isSafeInteger(input.revision) || input.revision < 1)
            throw new Error("Expected revision must be a positive integer.");
          const request = createOperationRequest(input, access.grantId || "owner");
          const firstResult = request && await store.getOperationResult(id, request);
          if (firstResult) return json(res, 200, firstResult);
          if (input.revision > record.revision) throw new ConflictError(record);
          const rebased = input.revision !== record.revision;
          let document;
          try {
            document = parseDocument(applyOperations(record.document, input.operations, await operationContext(record.document, input.operations, access)));
            await assertMediaAccess(document, access);
          } catch (error) {
            if (rebased) throw new ConflictError(record);
            throw error;
          }
          const updated = await store.updateProject(
            id,
            document,
            record.revision,
            // changes lists the scene, layer and animation IDs this edit created, changed and removed.
            { request, resultMetadata: { ...(rebased ? { rebased: true } : {}), changes: documentChanges(record.document, document) } },
          );
          await rememberMediaUse(id, [record.document, updated.document], access);
          broadcast(id, {
            type: "document",
            document: updated.document,
            revision: updated.revision,
            actor: input.actor || "mcp",
            author: documentAuthor(id, input.actor || "mcp", access),
          });
          return json(res, 200, updated);
        }
        if (parts.length === 3 && method === "DELETE") {
          requireOwner(access);
          const result = await store.trashProject(id);
          projectUnavailable(id, "trashed");
          return json(res, 200, result);
        }
        if (parts.length === 4 && parts[3] === "restore" && method === "POST") {
          requireOwner(access);
          return json(res, 200, await store.restoreProject(id));
        }
        if (parts.length === 3 && method === "PATCH") {
          requireOwner(access);
          const input = await body(req);
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
              !["name", "folderId"].some((key) => Object.hasOwn(input, key)))
            throw new Error("Supply either name to rename a file, or folderId to move it.");
          if (Object.hasOwn(input, "name")) {
            const updated = await store.renameProject(id, input.name);
            broadcast(id, { type: "document", document: updated.document, revision: updated.revision, actor: "workspace" });
            return json(res, 200, updated);
          }
          return json(
            res,
            200,
            await store.moveProject(id, input.folderId),
          );
        }
        if (parts[3] === "comments" && method === "GET")
          return json(res, 200, { comments: record.comments });
        // Comment writes: POST posts a comment or, with parentId, a reply; PATCH changes text,
        // mentions, place (x, y, sceneId, time), or resolved; DELETE removes a comment and, for a
        // thread's first comment, its replies. The browser's comment key (X-Kino-Comment-Key)
        // identifies the author; only its hash is stored. Rules: server/comments.mjs.
        if (parts[3] === "comments" && ["POST", "PATCH", "DELETE"].includes(method)) {
          if (!access.canComment)
            forbidden(method === "POST"
              ? "This link permits viewing. A comment or edit link is needed to post comments."
              : "This link permits viewing. A comment or edit link is needed to change comments.");
          const actor = { role: access.role, keyHash: commentKeyHash(req.headers[COMMENT_KEY_HEADER]) };
          let status = 200, result;
          if (parts.length === 4 && method === "POST") {
            result = await store.addComment(id, await body(req, COMMENT_BODY_LIMIT), actor);
            status = 201;
          } else if (parts.length === 5 && method === "PATCH")
            result = await store.updateComment(id, parts[4], await body(req, COMMENT_BODY_LIMIT), actor);
          else if (parts.length === 5 && method === "DELETE")
            result = await store.deleteComment(id, parts[4], actor);
          else return json(res, 404, { error: "This endpoint could not be found." });
          await broadcastComments(id);
          return json(res, status, result);
        }
      }
      if (parts[1] === "folders") requireOwner(access);
      if (parts[1] === "folders" && parts.length === 2 && method === "POST")
        return json(res, 201, await store.createFolder((await body(req)).name));
      if (parts[1] === "folders" && parts.length === 3 && method === "PATCH")
        return json(
          res,
          200,
          await store.renameFolder(parts[2], (await body(req)).name),
        );
      if (parts[1] === "folders" && parts.length === 3 && method === "DELETE") {
        const result = await store.deleteFolder(parts[2]);
        for (const id of result.trashedProjectIds) projectUnavailable(id, "trashed");
        return json(res, 200, result);
      }
      if (parts[1] === "fonts" && parts[2] === "ensure" && parts.length === 3 && method === "POST") {
        const input = await body(req);
        let document;
        if (access.projectId && !access.canEdit) document = (await store.getProject(access.projectId)).document;
        else document = parseDocument(input.document);
        requireProject(access, document.id);
        const fonts = await loadProjectFonts({ catalog: fontCatalog, mediaRoot, allowedIds: await allowedMedia(access) });
        const errors = await ensureDocumentFonts(document, fontCatalog, { allowMissing: input.allowMissing === true, fonts });
        return json(res, 200, { ready: errors.length === 0, errors });
      }
      if (parts[1] === "fonts" && parts.length === 2 && method === "GET") {
        const fonts = await loadProjectFonts({catalog: fontCatalog, mediaRoot, allowedIds: await allowedMedia(access)});
        return json(res, 200, {fonts: fonts.entries(), errors: fonts.errors});
      }
      if (parts[1] === "fonts" && parts.length === 3 && ["GET", "HEAD"].includes(method)) {
        const name = parts[2];
        const entry = bundledFontRegistry.entries().find((font) => font.src === `/api/fonts/${encodeURIComponent(name)}`);
        if (entry) return await sendFile(req, res, path.join(root, "assets/fonts", name), mimeTypes[path.extname(name)], false);
        const cached = await fontCatalog.file(name);
        if (cached) return await sendFile(req, res, cached.path, cached.mime, false);
        return json(res, 404, {error: "This local font was not found."});
      }
      if (parts[1] === "media" && parts.length === 2 && method === "POST") {
        requireEdit(access);
        if (req.headers["x-kino-agent"] && dashboard.hold().on) { const error = new Error("Agent writes are on hold in the dashboard."); error.status = 423; throw error; }
        const projectId = access.projectId || url.searchParams.get("project");
        if (projectId) {
          const project = await store.getProject(projectId);
          if (!project) { const error = new Error("Upload project was not found."); error.status = 404; throw error; }
          if (project.trashedAt) { const error = new Error("Restore this file from Trash before uploading media."); error.status = 410; throw error; }
        }
        let mime = req.headers["content-type"]?.split(";")[0];
        // A .mov or .m4v (an iPhone video) is kept as an MP4 with the same picture (media-remux.mjs).
        const remux = REMUX_MIMES.has(mime);
        const extension = remux ? "mp4" : mediaTypes[mime];
        if (!extension)
          throw new Error(
            "This media type is not supported. Use an image, video, audio file, font, or .cube LUT.",
          );
        let bytes = await body(req, MAX_UPLOAD_BYTES);
        // A video's shots need FFmpeg's scdet and signalstats filters. Without them the video is
        // refused before anything is saved. (The body is read first, so the uploader hears why.)
        if (mime.startsWith("video/")) {
          const filters = await shotFilters();
          if (!filters.ok) { const error = new Error(filters.message); error.status = 422; throw error; }
        }
        const svgAsset = mime === "image/svg+xml" ? prepareSvgAsset(bytes, {
          fontFiles: bundledFontRegistry.entries().map((face) => path.join(root, "assets/fonts", path.basename(decodeURIComponent(face.src)))),
        }) : null;
        if (svgAsset) bytes = svgAsset.buffer;
        if (mime.startsWith("font/")) {
          try { new FontRegistry().register(bytes); }
          catch { throw new Error("This upload does not contain a supported font face."); }
        }
        // A LUT is checked now, so a broken file is refused here with the line that is wrong
        // instead of failing later in the preview or an export.
        const lut = mime === LUT_MIME ? parseCubeLut(bytes.toString("utf8")) : null;
        let id = `${randomUUID()}.${extension}`;
        let converted = null;
        if (remux) {
          ({ id, mime, converted } = await remuxUpload(bytes, id.slice(0, -".mp4".length)));
          bytes = await readFile(path.join(mediaRoot, id));
        } else {
          await writeFile(path.join(mediaRoot, id), bytes, {
            mode: 0o600,
            flag: "wx",
          });
        }
        const measurements = svgAsset
          ? { ...svgAsset.measurements, measurementVersion: 1, measurementSucceeded: true }
          : await measureMedia(path.join(mediaRoot, id), mime);
        const shots = mime.startsWith("video/") && measurements.measurementSucceeded === true
          ? await uploadShots(path.join(mediaRoot, id), measurements.duration) : {};
        let name = String(req.headers["x-file-name"] || id);
        try {
          name = decodeURIComponent(name);
        } catch {
          /* Keep a malformed filename as literal text. */
        }
        const metadata = {
          id,
          src: `/api/media/${id}`,
          name: name.slice(0, 200),
          mime,
          size: bytes.length,
          ...(converted ? { converted } : {}),
          ...measurements,
          ...shots,
          ...(lut ? { lut: { type: lut.type, size: lut.size, ...(lut.title ? { title: lut.title.slice(0, 200) } : {}) } } : {}),
          ...(projectId ? { projectId } : {}),
        };
        // Only the record is written under the file lock: reading, measuring and finding the shots
        // of an upload can take minutes, and would hold up every save meanwhile. A link revoked or
        // a project deleted meanwhile refuses the upload, and its file goes.
        try {
          releaseFileMutation = await acquireFileMutation();
          requireEdit(await authorize(req, url));
          const project = projectId ? await store.getProject(projectId) : null;
          if (projectId && (!project || project.trashedAt)) {
            const error = new Error("The upload's project was moved to Trash or deleted meanwhile.");
            error.status = 410;
            throw error;
          }
          await writeMediaRecord(mediaRoot, id, metadata);
        } catch (error) {
          await rm(path.join(mediaRoot, id), { force: true });
          throw error;
        }
        return json(res, 201, metadata);
      }
      if (parts[1] === "media" && parts.length === 2 && method === "GET") {
        const media = await readMediaRecords();
        const allowed = await allowedMedia(access);
        const listed = [];
        // One at a time, so a folder of older uploads does not start dozens of ffprobe processes at once.
        for (const entry of allowed ? media.filter((item) => allowed.has(item.id)) : media)
          listed.push(await withMeasurements(entry));
        return json(res, 200, { media: listed });
      }
      if (
        parts[1] === "media" && parts.length === 5 && parts[3] === "poster" &&
        mediaFilePattern.test(parts[2]) && ["GET", "HEAD"].includes(method)
      ) {
        const match = /^(0|[1-9]\d{0,7})\.png$/.exec(parts[4]);
        const milliseconds = match ? Number(match[1]) : -1;
        if (milliseconds < 0 || milliseconds > 86_400_000) return json(res, 400, { error: "Invalid media preview time." });
        const allowed = await allowedMedia(access);
        if (allowed && !allowed.has(parts[2])) forbidden("This link cannot read media from another file.");
        const filename = path.join(mediaRoot, parts[2]);
        if (!existsSync(filename) || !existsSync(`${filename}.json`)) return json(res, 404, { error: "This media file is missing." });
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        res.once("close", cancel);
        let frame;
        try {
          const metadata = await withMeasurements(JSON.parse(await readFile(`${filename}.json`, "utf8")));
          frame = await mediaPosters.get(filename, metadata, milliseconds, { signal: cancellation.signal });
        } catch (problem) {
          if (cancellation.signal.aborted) return;
          return json(res, 422, { error: "This media preview could not be prepared." });
        } finally { res.off("close", cancel); }
        const currentAccess = await authorize(req, url);
        const stillAllowed = await allowedMedia(currentAccess);
        if (stillAllowed && !stillAllowed.has(parts[2])) forbidden("This link cannot read media from another file.");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": frame.length, "Cache-Control": "no-store" });
        return res.end(method === "HEAD" ? undefined : frame);
      }
      if (
        parts[1] === "media" && parts.length === 4 && parts[3] === "peaks" &&
        mediaFilePattern.test(parts[2]) && method === "GET"
      ) {
        const allowed = await allowedMedia(access);
        if (allowed && !allowed.has(parts[2])) forbidden("This link cannot read media from another file.");
        const filename = path.join(mediaRoot, parts[2]);
        if (!existsSync(filename) || !existsSync(`${filename}.json`))
          return json(res, 404, { error: "This media file is missing." });
        const metadata = JSON.parse(await readFile(`${filename}.json`, "utf8"));
        const peaks = await audioPeaks.get(filename, metadata);
        return json(res, 200, peaks);
      }
      if (
        parts[1] === "media" && parts.length === 4 &&
        ["metadata", "download"].includes(parts[3]) && mediaFilePattern.test(parts[2]) &&
        ["GET", "HEAD"].includes(method)
      ) {
        const allowed = await allowedMedia(access);
        if (allowed && !allowed.has(parts[2])) forbidden("This link cannot read media from another file.");
        const filename = path.join(mediaRoot, parts[2]);
        if (!existsSync(filename) || !existsSync(`${filename}.json`))
          return json(res, 404, { error: "This original media file is missing." });
        const entry = await withMeasurements(JSON.parse(await readFile(`${filename}.json`, "utf8")));
        if (parts[3] === "metadata") return json(res, 200, entry);
        res.setHeader("Content-Disposition", attachmentName(entry.name || entry.id));
        return await sendFile(req, res, filename, entry.mime || "application/octet-stream", false);
      }
      if (
        parts[1] === "media" &&
        (parts.length === 4 || parts.length === 5) &&
        parts[3] === "frames" &&
        mediaFilePattern.test(parts[2]) &&
        ["GET", "HEAD"].includes(method)
      )
        return await sendGifFrames(req, res, parts, access);
      if (
        parts[1] === "media" &&
        parts.length === 3 &&
        /^[a-f0-9-]+\.[a-z0-9]+$/.test(parts[2]) &&
        ["GET", "HEAD"].includes(method)
      ) {
        const allowed = await allowedMedia(access);
        if (allowed && !allowed.has(parts[2])) forbidden("This link cannot read media from another file.");
        const filename = path.join(mediaRoot, parts[2]);
        if (!existsSync(filename))
          return json(res, 404, { error: "This media file is missing." });
        return await sendFile(
          req,
          res,
          filename,
          mimeTypes[path.extname(filename)] || "application/octet-stream",
          access.manageShares,
        );
      }
      if (url.pathname === "/api/export" && method === "POST") {
        const input = await body(req);
        const { document: exportDocument, fonts } = await exportInput(input, access);
        const stopsOpen = await finalStopsOpen(input.options, exportDocument.id);
        if (stopsOpen) return json(res, 409, { error: stopsOpen, code: "stops_open" });
        const exportId = req.headers["x-kino-export-id"];
        const progress = exportId === undefined ? null : exportProgress.create(exportId, {
          projectId: exportDocument.id,
          grantId: access.grantId ?? null,
        });
        let controller;
        let downloadDirectory;
        try {
          const scene = expandComponents(exportDocument, input.sceneId || exportDocument.scenes[0]?.id, {fonts});
          controller = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) controller.abort();
          });
          downloadDirectory = await makeTempFolder("kino-download-");
          activeExports.add(controller);
          const output = await exportScene(scene, withVideoDefaults(input.options || {}, videoDefaults()), {
            signal: controller.signal,
            mediaRoot,
            fonts,
            render: machineSettings(),
            outputPath: path.join(downloadDirectory, "result"),
            ...(progress ? { onProgress: (event) => progress.progress(event) } : {}),
          });
          noteRender(output);
          res.writeHead(200, {
            "Content-Type": output.mime,
            "Content-Disposition": attachmentName(`${exportBasename(scene.name)}.${output.extension}`),
            "Content-Length": (await stat(output.path)).size,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...(output.mp4Encoder ? { "X-Kino-MP4-Encoder": output.mp4Encoder } : {}),
            ...(output.videoEncoder ? { "X-Kino-Video-Encoder": JSON.stringify(output.videoEncoder) } : {}),
            ...(output.graphics ? { "X-Kino-Graphics": JSON.stringify(output.graphics)
              .replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) } : {}),
            ...(output.warnings ? { "X-Kino-Export-Warnings": JSON.stringify(output.warnings)
              .replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) } : {}),
            ...(output.gzipSize ? { "X-Kino-Gzip-Size": String(output.gzipSize) } : {}),
          });
          // Complete once the last byte is sent. pipeline() also waits for the file to close,
          // and a client that already has the whole download may ask for progress before then.
          res.once("finish", () => progress?.complete());
          await pipeline(createReadStream(output.path), res, { signal: controller.signal });
        } catch (error) {
          if (controller?.signal.aborted || error?.name === "AbortError") progress?.cancel();
          else progress?.fail();
          throw error;
        } finally {
          if (controller) activeExports.delete(controller);
          await removeTempFolder(downloadDirectory);
        }
        return;
      }
      return json(res, 404, { error: "This endpoint could not be found." });
    }
    const dist = path.join(root, "dist/client");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let filename = path.resolve(dist, relative || "index.html");
    if (
      !filename.startsWith(dist + path.sep) &&
      filename !== path.join(dist, "index.html")
    )
      return json(res, 403, { error: "Invalid path." });
    if (!existsSync(filename) || url.pathname.endsWith("/"))
      filename = path.join(dist, "index.html");
    if (!existsSync(filename))
      return json(res, 503, {
        error: "Build the app with npm run build, or use npm run dev.",
      });
    await sendFile(
      req,
      res,
      filename,
      mimeTypes[path.extname(filename)] || "application/octet-stream",
    );
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof ConflictError)
      return json(res, 409, {
        error: "This project changed in another session.",
        current: error.current,
      });
    console.error(`[kino] ${error.message}`);
    // Node's own file and system errors name paths on this computer, so they never reach the client.
    if (!error.status && (error.syscall || error.path))
      return json(res, 500, { error: "The server could not read a file it needed." });
    const storeStatus = ["ERR_STORE_IO", "ERR_CORRUPT_STORE"].includes(error.code) ? 500 : error.code === "ERR_PROJECT_TRASHED" ? 410
      : ["ERR_PROJECT_NOT_FOUND", "ERR_FOLDER_NOT_FOUND", "ERR_EASING_NOT_FOUND", "ERR_TEXT_EFFECT_NOT_FOUND"].includes(error.code) ? 404 : 400;
    json(res, error.status || storeStatus, {
      error: error.message || "The operation could not be completed.",
    });
  } finally {
    releaseFileMutation?.();
  }
});
// Clients (the agent client, tests, the app) reuse idle connections. With Node's 5 s default, a
// request sent just as the server closes an idle connection fails with ECONNRESET, which a busy
// computer makes likely; a long idle time removes that race.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.on("upgrade", async (req, socket, head) => {
  if (
    !acceptableOrigin(req.headers.origin) ||
    !req.url?.startsWith("/collaboration")
  ) {
    socket.destroy();
    return;
  }
  try {
    req.access = await authorize(req, new URL(req.url, `http://${host}:${port}`));
    wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit("connection", ws, req));
  } catch { socket.destroy(); }
});
wsServer.on("connection", (socket, req) => {
  let joinVersion = 0, joins = [];
  const incoming = { cursor: null, selection: null };
  const running = { cursor: false, selection: false };
  const trailing = { cursor: null, selection: null };
  function clearRelay() {
    clearTimeout(trailing.cursor); clearTimeout(trailing.selection);
    trailing.cursor = trailing.selection = null;
    incoming.cursor = incoming.selection = null;
  }
  function invalid(error) {
    if (error.status === 403) {
      const projectId = clients.get(socket)?.projectId;
      sessions.leave(socket);
      if (projectId) presence(projectId);
      socket.close(1008, "Access to this shared file is unavailable.");
    } else if (socket.readyState === 1) socket.send(JSON.stringify({ type: "error", error: "Invalid collaboration message." }));
  }
  async function relay(kind) {
    if (running[kind] || !incoming[kind] || socket.readyState !== 1) return;
    const client = clients.get(socket);
    if (!client) { incoming[kind] = null; return; }
    if (incoming[kind].client !== client || incoming[kind].version !== joinVersion) { incoming[kind] = null; return; }
    if (!sessions.allow(socket, kind)) {
      // Keep only the final position/selection, even under a burst or network jitter.
      trailing[kind] ??= setTimeout(() => { trailing[kind] = null; relay(kind); }, 100);
      return;
    }
    const { message, version } = incoming[kind]; incoming[kind] = null;
    running[kind] = true;
    try {
      const access = await authorize(req, new URL(req.url, `http://${host}:${port}`));
      requireProject(access, client.projectId);
      const record = await store.getProject(client.projectId);
      // A leave, switch, revocation, timeout or close during either read invalidates this work.
      if (clients.get(socket) !== client || version !== joinVersion || socket.readyState !== 1) return;
      if (record.trashedAt) throw new Error("The file is in Trash.");
      const { type, ...payload } = message;
      const value = kind === "selection" ? validateSelection(record.document, payload) : validateCursor(record.document, payload);
      sessions.touch(socket);
      if (kind === "selection") {
        const changedScene = client.sceneId !== value.sceneId;
        client.selection = value; client.sceneId = value.sceneId;
        if (changedScene) presence(client.projectId);
        broadcast(client.projectId, selectionMessage(client), socket);
      } else {
        broadcast(client.projectId, { type: "cursor", id: client.id, name: client.name, color: client.color, ...value }, socket);
      }
    } catch (error) { invalid(error); }
    finally { running[kind] = false; if (incoming[kind]) relay(kind); }
  }
  socket.on("message", async (bytes) => {
    try {
      const message = JSON.parse(bytes.toString());
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Expected a message.");
      if (message.type === "ping") {
        if (clients.has(socket)) { sessions.touch(socket); socket.send(JSON.stringify({ type: "pong" })); }
        return;
      }
      if (message.type === "leave") {
        ++joinVersion;
        clearRelay();
        const projectId = clients.get(socket)?.projectId;
        sessions.leave(socket);
        if (projectId) presence(projectId);
        return;
      }
      if (message.type === "join") {
        if (typeof message.projectId !== "string" || !safeId.test(message.projectId)) throw new Error("Invalid project.");
        joins = joins.filter((at) => Date.now() - at < 1000);
        if (joins.length >= 10) throw new Error("Too many joins.");
        joins.push(Date.now());
        const version = ++joinVersion;
        clearRelay();
        const access = await authorize(req, new URL(req.url, `http://${host}:${port}`));
        requireProject(access, message.projectId);
        await store.getProject(message.projectId);
        if (version !== joinVersion || socket.readyState !== 1) return;
        // Recheck after the store read; revocation may have completed while joining.
        const currentAccess = await authorize(req, new URL(req.url, `http://${host}:${port}`));
        requireProject(currentAccess, message.projectId);
        if (version !== joinVersion || socket.readyState !== 1) return;
        const previous = clients.get(socket)?.projectId;
        const client = sessions.join(socket, { projectId: message.projectId, name: message.name, grantId: currentAccess.grantId });
        // This client-supplied label only associates a save with a display name.
        // Presence IDs and authorization continue to come from the server/grant.
        client.actorId = typeof message.clientId === "string" && safeId.test(message.clientId) ? message.clientId : null;
        req.access = currentAccess;
        if (previous && previous !== message.projectId) presence(previous);
        presence(message.projectId);
        for (const other of clients.values()) if (other !== client && other.projectId === message.projectId && other.selection)
          socket.send(JSON.stringify(selectionMessage(other)));
        const latest = await store.getProject(message.projectId);
        if (version !== joinVersion || clients.get(socket) !== client || socket.readyState !== 1) return;
        if (latest.trashedAt && client.grantId) forbidden("This shared file is unavailable.");
        if (latest.trashedAt) socket.send(JSON.stringify({ type: "project-lifecycle", projectId: message.projectId, state: "trashed" }));
        socket.send(JSON.stringify({ type: "comments", comments: latest.comments }));
        return;
      }
      if (["cursor", "selection"].includes(message.type) && clients.has(socket)) {
        if (message.type === "selection" && (!Array.isArray(message.layerIds) || message.layerIds.length > 200)) throw new Error("Too many selected layers.");
        incoming[message.type] = { message, version: joinVersion, client: clients.get(socket) };
        relay(message.type);
        return;
      }
      throw new Error("Unknown collaboration message.");
    } catch (error) { invalid(error); }
  });
  socket.on("close", () => {
    ++joinVersion;
    clearRelay();
    const id = clients.get(socket)?.projectId;
    sessions.leave(socket);
    if (id) presence(id);
  });
  socket.on("error", () => {});
});
const presenceExpiry = setInterval(() => {
  const projects = new Set();
  for (const { socket, client } of sessions.expire()) {
    projects.add(client.projectId);
    socket.close(1001, "This session was inactive.");
  }
  for (const id of projects) presence(id);
}, 1000);
presenceExpiry.unref();
server.once("error", (error) => {
  const message = { type: "kino-startup-error", code: error.code === "EADDRINUSE" ? "EADDRINUSE" : "START_FAILED" };
  process.parentPort?.postMessage(message);
  if (process.send) process.send(message, () => process.exit(1));
  else {
    console.error(`kino service could not start (${message.code}).`);
    setTimeout(() => process.exit(1), 10);
  }
});
server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log(`kino service: http://${host}:${actualPort}`);
  const ready = { type: "kino-ready", host, port: actualPort };
  // Node's IPC channel is used by command-line launchers; Electron utility
  // processes expose the same startup handshake through their parent port.
  process.send?.(ready);
  process.parentPort?.postMessage(ready);
  // Temporary folders an earlier kino left when it was stopped part-way (temp-folders.mjs).
  // KINO_TEMP_SWEEP=off skips it.
  if (process.env.KINO_TEMP_SWEEP !== "off") {
    sweepTempFolders().then((result) => {
      const line = sweepSummary(result);
      if (line) console.log(line);
    }).catch(() => {});
  }
});
// A server a test started (node --test sets NODE_TEST_CONTEXT in its test processes, and
// startTestServer sets KINO_EXIT_WITH_PARENT) stops once that process is gone, so a killed test
// run leaves no server running on its temporary data.
if (process.env.KINO_EXIT_WITH_PARENT === "1" || process.env.NODE_TEST_CONTEXT) {
  const parent = process.ppid;
  setInterval(() => {
    let alive = process.ppid === parent;
    try { if (alive) process.kill(parent, 0); } catch { alive = false; }
    if (!alive) process.kill(process.pid, "SIGTERM");
  }, 1000).unref();
}
process.on("SIGTERM", async () => {
  // The steps below wait for the crew file, running exports and a recording. If one of them never
  // ends, the service still exits, so no kino server is left running after its app or test quit.
  setTimeout(() => process.exit(0), 30_000).unref();
  clearInterval(presenceExpiry);
  // whisper and FFmpeg runs end now, not minutes after kino quit.
  stopChildren();
  // The agents kino started end with it (their crew rows read "kino restarted" next time).
  crewLauncher.stopAll();
  await crew.flush().catch(() => {});
  for (const controller of activeExports) controller.abort();
  exportProgress.clear();
  await exportBatches.close();
  // A recording running now is finished and kept (its helper closes the files first).
  await recorder.close().catch(() => {});
  for (const socket of clients.keys()) socket.close();
  server.close(() => process.exit(0));
  // An open dashboard keeps a live connection (and keep-alive sockets) that server.close waits
  // for forever, so a restart under node --watch hung on "Waiting for graceful termination".
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
});
