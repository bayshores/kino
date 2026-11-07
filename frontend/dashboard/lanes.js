// The F1 timeline's lanes under the story row, as plain functions (tested in
// frontend/dashboardLanes.test.js). The React side is lanes.jsx.
//   shots   a thumbnail per stretch of each shot (the server's shot list, GET /dashboard/lanes)
//   voice   the voice layers as one lane: a block per spoken sentence (a saved transcript's
//           sentences, else the caption pages), else a block per voice clip
//   sounds  a lane per other sound layer while there are few (MOST_SOUND_ROWS), else one "audio"
//           lane for all of them, then one "music" lane; each with its waveform where it plays
//   agents  a lane per agent, with a mark where each of its turns changed the scene
import { mediaPlaybackRange } from "../../engine/playback.js";
import { onScreenRanges, spanText } from "./timeline.js";
import { callAgent } from "./state.js";
import { round } from "../../engine/numbers.js";
import { clock } from "./format.js";

// The most thumbnails the shots lane asks the server for at once.
export const MOST_TILES = 60;

/**
 * Where the shots lane's thumbnails go: each shot is cut into tiles about as wide as a frame of
 * the lane's height, each showing the frame at its middle. `shots` [{start, end}], `width` the
 * lane in px, `height` its height, `aspect` the scene's width ÷ height. Returns
 * [{shot (from 1), start, end, time}] in scene seconds.
 */
export function shotTiles(shots, { duration, width, height, aspect }) {
  if (!(duration > 0) || !(width > 0) || !(height > 0)) return [];
  const list = (shots?.length ? shots : [{ start: 0, end: duration }]).filter((shot) => shot.end > shot.start);
  const tilePx = Math.max(24, height * (aspect > 0 ? aspect : 16 / 9));
  let tiles = [];
  list.forEach((shot, index) => {
    const px = ((shot.end - shot.start) / duration) * width;
    const count = Math.max(1, Math.round(px / tilePx));
    for (let at = 0; at < count; at += 1) {
      const start = shot.start + ((shot.end - shot.start) * at) / count;
      const end = shot.start + ((shot.end - shot.start) * (at + 1)) / count;
      tiles.push({ shot: index + 1, start: round(start), end: round(end), time: round((start + end) / 2) });
    }
  });
  // Too many for the lane (a long scene zoomed in): every other tile goes, until they fit.
  while (tiles.length > MOST_TILES) tiles = tiles.filter((_, index) => index % 2 === 0).map((tile, index, kept) => ({ ...tile, end: kept[index + 1]?.start ?? list.at(-1).end }));
  return tiles;
}

/**
 * The caption pages of a scene as voice blocks: each caption text layer (role "caption") with
 * the time its page is on screen and its words. [{start, end, text, name, layerId}].
 */
export function captionBlocks(scene) {
  if (!scene) return [];
  const duration = Number(scene.duration) || 0;
  const byId = new Map((scene.layers ?? []).map((layer) => [layer.id, layer]));
  const blocks = [];
  for (const layer of scene.layers ?? []) {
    if (layer.type !== "text" || layer.role !== "caption" || !String(layer.text ?? "").trim()) continue;
    // A page is shown and hidden as a group: its time is its group's.
    const page = byId.get(layer.parentId) ?? layer;
    const top = byId.get(page.parentId) ?? page;
    for (const [start, end] of onScreenRanges(page, duration)) {
      if (end - start >= duration - 1e-6 && page === layer) continue; // a caption shown the whole time is a title, not a sentence
      blocks.push({ start: round(start), end: round(end), text: String(layer.text).replace(/\s+/g, " ").trim(), name: top.name || "captions", layerId: layer.id });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}

/**
 * A lane per sound layer that is not a voice the voice lane shows: [{id, name, src, start, end,
 * offset, duration}] where it plays (scene seconds) and the file second it starts at.
 */
export function audioLanes(scene, voiceLayerIds = new Set()) {
  if (!scene) return [];
  const duration = Number(scene.duration) || 0;
  const lanes = [];
  for (const layer of scene.layers ?? []) {
    if (layer.type !== "audio" || layer.visible === false || !layer.src || voiceLayerIds.has(layer.id)) continue;
    const range = mediaPlaybackRange(layer, duration);
    if (!range) continue;
    lanes.push({ id: layer.id, name: layer.name || "sound", src: layer.src, start: range.start, end: range.end, offset: range.offset, duration: range.duration, remapped: Boolean(range.remapped) });
  }
  return lanes;
}

// The words in a sound layer's name that make it a voice or music ("vo-main-2a", "ask-voice",
// "Narration", "bgm"). kino has no voice or music flag on a layer, so its name tells.
const VOICE_WORDS = new Set(["vo", "voice", "voices", "voiceover", "narration", "narrator", "speech", "dialog", "dialogue", "interview", "speaker"]);
const MUSIC_WORDS = new Set(["music", "song", "soundtrack", "score", "bgm"]);
const nameWords = (name) => String(name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Separate sound lanes while there are at most this many; more become one "audio" lane.
export const MOST_SOUND_ROWS = 2;

/** "voice", "music" or "other" for a sound lane (audioLanes), by its layer's name. */
export function soundKind(sound) {
  const words = nameWords(sound?.name);
  if (words.some((word) => VOICE_WORDS.has(word) || /^voice/.test(word))) return "voice";
  if (words.some((word) => MUSIC_WORDS.has(word))) return "music";
  return "other";
}

/**
 * The timeline's sound lanes, as the design has them: one voice lane, a few named sound lanes and
 * one music lane, so a project with nine sound layers still fits its pane.
 * `spoken` are the server's transcript sentences, `captions` the caption pages (captionBlocks).
 * Returns { voice: {blocks, names} | null, others: [{id, name, sounds}], music: {id, name, sounds} | null }.
 * - voice: the sentences (else the caption pages), plus a block per voice clip that none of them
 *   covers; without either, a block per voice clip ({start, end, text: "", name, layerId}).
 * - others: a lane per other sound while there are at most MOST_SOUND_ROWS, else one "audio" lane.
 */
export function soundRows(scene, { spoken = [], captions = [] } = {}) {
  const spokenIds = new Set(spoken.map((block) => block.layerId));
  const sounds = audioLanes(scene);
  const kinds = sounds.map((sound) => (spokenIds.has(sound.id) ? "voice" : soundKind(sound)));
  const voices = sounds.filter((_, index) => kinds[index] === "voice");
  const said = spoken.length ? spoken : captions;
  const clips = voices.filter((sound) => !said.some((block) => block.start < sound.end && block.end > sound.start))
    .map((sound) => ({ start: round(sound.start), end: round(sound.end), text: "", name: sound.name, layerId: sound.id }));
  const blocks = [...said, ...clips].sort((a, b) => a.start - b.start);
  const others = sounds.filter((_, index) => kinds[index] === "other");
  const music = sounds.filter((_, index) => kinds[index] === "music");
  return {
    voice: blocks.length ? { blocks, names: [...new Set([...said.map((block) => block.name), ...voices.map((sound) => sound.name)])] } : null,
    // A lane's id: its layer's, or for several layers one starting with ":", to keep apart from them.
    others: others.length <= MOST_SOUND_ROWS ? others.map((sound) => ({ id: sound.id, name: sound.name, sounds: [sound] })) : [{ id: ":audio", name: "audio", sounds: others }],
    music: music.length ? { id: ":music", name: "music", sounds: music } : null,
  };
}

/** One waveform for several sound lanes: at each bar the loudest of them (waveBars of each). */
export function mixBars(sounds, peakOf, { duration, count }) {
  let mixed = [];
  for (const sound of sounds ?? []) {
    const bars = waveBars(sound, peakOf(sound), { duration, count });
    if (bars.length) mixed = mixed.length ? mixed.map((height, index) => Math.max(height, bars[index] ?? 0)) : bars;
  }
  return mixed;
}

/**
 * The times out of `times` (seconds, in order) to draw on a track `width` px wide, at least
 * `gap` px apart, so a project with a thousand beats does not draw a solid bar.
 */
export function spaced(times, { duration, width, gap = 6 }) {
  if (!(duration > 0) || !(width > 0)) return [];
  const kept = [];
  let last = -Infinity;
  for (const time of times) {
    const px = (time / duration) * width;
    if (px - last >= gap) { kept.push(time); last = px; }
  }
  return kept;
}

// The cue kinds a song's analysis adds by the hundred, most first: they go from the ruler first
// when the cues have no room there (zoomed in, they come back).
const DENSE_CUES = ["onset", "beat"];

/**
 * The cue marks the ruler draws: every cue while they have room (`gap` px each); else without the
 * onsets, then without the beats (named cues stay); and never two closer than `gap` px.
 * [{name, time, kind}] in time order.
 */
export function rulerCues(cues, { duration, width, gap = 6 }) {
  let shown = (cues ?? []).filter((cue) => Number.isFinite(cue?.time) && cue.time >= 0 && cue.time <= duration).sort((a, b) => a.time - b.time);
  const crowded = (list) => spaced(list.map((cue) => cue.time), { duration, width, gap }).length < list.length;
  for (const kind of DENSE_CUES) if (crowded(shown)) shown = shown.filter((cue) => cue.kind !== kind);
  const keep = new Set(spaced(shown.map((cue) => cue.time), { duration, width, gap }));
  return shown.filter((cue) => keep.delete(cue.time));
}

/** The media file id of a layer's src ("/api/media/<id>"), or null. */
export function mediaId(src) {
  const match = /^\/api\/media\/([^/?#]+)$/.exec(String(src ?? ""));
  return match ? match[1] : null;
}

/**
 * A waveform's bars for one sound lane: `count` heights from 0 to 1 across the scene, from the
 * file's peaks ({peaks, secondsPerPeak}); 0 where the layer does not play.
 */
export function waveBars(lane, peaks, { duration, count }) {
  if (!lane || !peaks?.peaks?.length || !(duration > 0) || !(count > 0)) return [];
  const step = peaks.secondsPerPeak || 0.01;
  const bars = [];
  for (let index = 0; index < count; index += 1) {
    const from = (index / count) * duration;
    const to = ((index + 1) / count) * duration;
    if (to <= lane.start || from >= lane.end) { bars.push(0); continue; }
    const fileFrom = lane.offset + Math.max(0, from - lane.start);
    const fileTo = lane.offset + Math.min(lane.end, to) - lane.start;
    let peak = 0;
    for (let at = Math.floor(fileFrom / step); at <= Math.min(peaks.peaks.length - 1, Math.floor(fileTo / step)); at += 1) peak = Math.max(peak, peaks.peaks[at] ?? 0);
    bars.push(Math.min(1, peak));
  }
  return bars;
}

/**
 * The agents kino knows of: those connected now (data.agents), then those of the project's saved
 * calls that are not (after a restart no agent is connected, but its turns still have lanes).
 */
export function knownAgents(data) {
  const known = [...(data?.agents ?? [])];
  for (const call of data?.calls ?? []) {
    if (call.by === "you") continue;
    const agent = callAgent(call);
    if (!known.some((each) => each.id === agent.id || each.name === agent.name)) known.push(agent);
  }
  return known;
}

/**
 * The agents' lanes: one per agent with a turn that changed this scene (from the timeline's
 * turn reviews, `entries` [{turn, who, at, layerIds}]) or that is in the project now. Each mark
 * is one layer a turn changed, at the time that layer starts: [{turn, at, end}].
 * `spanOf(layerId)` gives a layer's [first, last] on-screen time. `agents` are data.agents.
 */
export function agentLanes(entries, agents, spanOf, { present = [] } = {}) {
  const lanes = new Map();
  const laneOf = (agent) => {
    if (!lanes.has(agent.id)) lanes.set(agent.id, { agent, marks: [] });
    return lanes.get(agent.id);
  };
  for (const entry of entries ?? []) {
    const agent = (agents ?? []).find((each) => each.name === entry.who);
    if (!agent) continue;
    const spans = entry.layerIds.map(spanOf).filter((span) => Array.isArray(span) && Number.isFinite(span[0]));
    if (!spans.length) continue;
    const lane = laneOf(agent);
    for (const [at, end] of spans.sort((a, b) => a[0] - b[0])) {
      // Layers of one turn that start together get one mark (two at one place would hide each
      // other from the pointer), as long as the longest of them.
      const same = lane.marks.find((mark) => mark.turn === entry.turn && mark.at === at);
      if (same) same.end = Math.max(same.end, end);
      else lane.marks.push({ turn: entry.turn, at, end });
    }
  }
  for (const agent of present) laneOf(agent);
  return [...lanes.values()];
}

/**
 * The range a "needs you" row is about, for the timeline's outline: the asking agent's newest
 * turn's changes in this scene (its marks), else the whole scene. {start, end, text}.
 */
export function needRange(lanes, agentId, duration) {
  const lane = lanes.find((entry) => entry.agent.id === agentId);
  const turn = lane?.marks.at(-1)?.turn;
  const marks = turn ? lane.marks.filter((mark) => mark.turn === turn) : [];
  let start = marks.length ? Math.min(...marks.map((mark) => mark.at)) : 0;
  let end = marks.length ? Math.max(...marks.map((mark) => mark.end)) : duration;
  if (!(end > start)) { start = 0; end = duration; }
  return { start, end, text: `preview ${spanText([start, end], duration).replace("–", " – ")}` };
}

// Ruler label steps in seconds: the smallest that leaves RULER_LABEL_PX between labels is used.
const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const RULER_LABEL_PX = 64;
// A ruler time's width per character (10 px monospace) and the least room between two times.
const RULER_CHAR_PX = 6.2;
const RULER_LABEL_GAP_PX = 8;

/** "00:18" on whole-second steps, "00:18.5" on finer ones. */
function rulerLabel(seconds, step) {
  const text = clock(seconds);
  return step >= 1 ? text.slice(0, 5) : text.slice(0, 7);
}

/**
 * The ruler under a track `width` px wide: a labelled tick every `step` seconds and small ticks
 * between them (5 or 2 to a step, while they stay at least 6 px apart).
 */
export function rulerTicks(duration, width) {
  const perSecond = width / duration;
  const step = RULER_STEPS.find((value) => value * perSecond >= RULER_LABEL_PX) ?? RULER_STEPS.at(-1);
  let parts = [5, 2].find((count) => (step / count) * perSecond >= 6) ?? 1;
  if (duration / (step / parts) > 1500) parts = 1;
  const count = Math.floor((duration * parts) / step + 1e-6);
  const ticks = [];
  for (let index = 0; index <= count; index += 1) {
    const at = (index * step) / parts;
    const major = index % parts === 0;
    ticks.push({ at, major, label: major ? rulerLabel(at, step) : null });
  }
  // The first label starts at the left edge and a label at the very end ends at the right edge
  // (not centered), so the label next to either one is left out when the two would touch.
  const labelPx = (label) => label.length * RULER_CHAR_PX;
  const labeled = ticks.filter((tick) => tick.label);
  const first = labeled[0];
  const last = labeled.length > 1 && labeled.at(-1).at >= duration - 1e-6 ? labeled.at(-1) : null;
  for (const tick of labeled) {
    if (tick === first || tick === last) continue;
    const x = tick.at * perSecond, half = labelPx(tick.label) / 2;
    if (x - half < labelPx(first.label) + RULER_LABEL_GAP_PX || (last && x + half > width - labelPx(last.label) - RULER_LABEL_GAP_PX)) tick.label = null;
  }
  return { step, ticks };
}
