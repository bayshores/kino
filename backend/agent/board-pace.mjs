// The storyboard's pace beside the project's references (look board) and the song's measured beat
// times after its turn (look board, and board {snap:"beats"}). Facts only: kino never moves a cut
// unasked, and the same words print inside or outside the references' range.
import { boardSpan, mainScene } from "../../engine/board.js";
import { paceFacts, paceLine, beatLine } from "../../engine/cutFacts.js";
import { songSections } from "../../engine/footage/pace.js";
import { beatGrid, editBeats } from "../../engine/footage/cuts.js";
import { medianOf, nearestBeats, defaultPace } from "../../engine/footage/refPace.js";
import { boardSpans, cueShowLines, cueShows, storyCues } from "../../engine/footage/cueShows.js";
import { shotRoles } from "../../engine/movePicks.js";
import { expandComponents } from "../../engine/linkedComponents.js";
import { mediaPlaybackRange, mediaSoundTime } from "../../engine/playback.js";
import { isGifLayer } from "../../engine/mediaPlay.js";
import { hiddenRanges } from "../../engine/visibilityOps.js";
import { round } from "../../engine/numbers.js";

// Beat times listed in the look's text (the snap uses them all, to the board's end).
const TIMES_SHOWN = 7;
export const SNAP_CALL = 'board {snap:"beats"}';

/**
 * The board's pace facts: { turn: {at, kind} | null, ours, refs, beats, period, times, why }.
 * `shape` is the music layer's saved song shape (.song), `analysis` its saved beats (.beats),
 * `refs` the saved references ({numbers, heard}); each may be null. Turn: the heaviest drop seam of
 * songSections inside the board span. Beats a shot: the nearest of 1, 2, 4, 8 to the median of the
 * references' after-turn medians over the beat; with no turned reference defaultPace's beats; with
 * no reference the low end of the turn section's range (without a loudness curve that section is
 * at middle energy: 2 beats, a stated fallback, not a measure). Times: the measured grid from the
 * turn every that many beats, to the board's end. `music`: the scene's song layer the cue lines
 * read when the board names no music (no turn then); `spine`: the brief's story spine (the payoff).
 */
export function boardPaceFacts({ document, shape = null, analysis = null, refs = [], media = {}, music = null, spine = null }) {
  const board = document?.board;
  if (!board?.shots?.length) return null;
  const span = boardSpan(document, board);
  const scene = mainScene(document);
  const named = scene?.layers?.find((entry) => entry.id === board.music) ?? null;
  // With no music named on the board, the cue lines read `music` (the scene's song layer with a
  // saved shape); the pace and beat lines stay the board's own.
  const layer = named ?? music;
  // A sped-up or reversed song has no straight file-to-edit mapping: whole-board pace only.
  const played = layer ? mediaPlaybackRange(layer, Number(scene.duration) || 0) : null;
  const range = played && !played.remapped ? played : null;
  const offset = range ? range.offset - range.start : null;
  const song = range && shape ? songSections(shape, { offset, to: span.end }) : null;
  const drops = named ? (song?.seams ?? []).filter((seam) => seam.kind === "drop" && seam.at > span.start && seam.at < span.end) : [];
  const heaviest = drops.reduce((best, seam) => (!best || (seam.weight ?? 0) > (best.weight ?? 0) ? seam : best), null);
  const turn = heaviest ? { at: heaviest.at, kind: heaviest.kind } : null;
  const cuts = board.shots.slice(1).map((shot) => shot.cue);
  const ours = paceFacts({ cuts, seconds: span.end, start: span.start, turn: turn?.at ?? null });
  const measured = (refs ?? []).filter((ref) => Array.isArray(ref?.numbers?.cuts) && ref.numbers.seconds > 0);
  const refFacts = measured.map((ref) => paceFacts({ cuts: ref.numbers.cuts, seconds: ref.numbers.seconds, turn: ref.heard?.change?.at ?? null }));
  const shows = boardCueShows(board, song, span, media, { scene, spine });
  const facts = { turn, ours, refs: refFacts, beats: null, period: null, times: [], why: null, shows };
  const grid = turn && range ? beatGrid(analysis) : null;
  if (!grid) return facts;
  const turned = refFacts.filter((ref) => ref.after?.median > 0);
  let beats, why;
  if (turned.length) {
    const median = medianOf(turned.map((ref) => ref.after.median));
    beats = nearestBeats(median / grid.period);
    why = `your references' median after their turn is ${median.toFixed(2)} s`;
  } else if (measured.length) {
    beats = defaultPace(measured, { beatSeconds: grid.period }).shot.beats;
    why = "your references' median shot";
  } else {
    beats = song.sections.find((section) => section.from <= turn.at + 1e-3 && section.to > turn.at)?.beats?.[0] ?? 2;
    why = "the section's range, no references";
  }
  const at = editBeats(grid, { offset: range.offset, start: range.start });
  const first = at.index(turn.at, { up: true });
  const times = [];
  for (let index = first; ; index += beats) {
    const time = at.at(index);
    if (time >= span.end - 1e-3) break;
    times.push(time);
  }
  return { ...facts, beats, period: round(grid.period, 3), times, why };
}

/**
 * What plays on the song's strong cues (engine/footage/cueShows.js): each section start inside the
 * board (the drop among them), the shot on it and whether its file stretch was shown before.
 * media: {nameOf(src), tagsOf(src): the scan tags of the shot a file was imported from, pool:
 * unused scanned shots}. Also the story's cues (boardStoryCues) wherever they fall, with or
 * without a song. Null with neither.
 */
function boardCueShows(board, song, span, { nameOf = (src) => src, tagsOf = () => null, pool = [] } = {}, { scene = null, spine = null } = {}) {
  const cues = (song?.sections ?? []).filter((section) => section.from > span.start + 1e-3 && section.from < span.end - 1e-3).map((section) => ({ at: section.from, kind: section.kind }));
  const story = boardStoryCues(board, { nameOf, spine, start: span.start });
  if (!cues.length && !story.length) return null;
  // A shot built reversed in the scene (the board has no reverse) is read on its layer's clock.
  const built = (shot) => (scene?.layers ?? []).find((layer) => layer.type === "video" && layer.src === shot.media && layer.mediaReverse === true
    && (layer.name === `board-${shot.id}` || layer.id === `board-${String(shot.id).toLowerCase()}`)) ?? null;
  const spans = boardSpans(board.shots, nameOf, { built }).map((entry, index) => ({ ...entry, tags: entry.file ? tagsOf(board.shots[index].media) : null }));
  return cueShows({ spans, cues, story, seconds: span.end - span.start, pool });
}

/**
 * The board's story cues (storyCues): its first payoff shot by shotRoles (the spine's payoff beat
 * when the brief has one, else the last shot) and its longest footage shot. Only on a board with
 * footage: a title-only board has no file to repeat.
 */
export function boardStoryCues(board, { nameOf = (src) => src, spine = null, start = 0 } = {}) {
  const shots = board?.shots ?? [];
  if (!shots.some((shot) => typeof shot.media === "string" && shot.media !== "none")) return [];
  const names = Object.fromEntries(shots.map((shot) => [shot.media, nameOf(shot.media)]));
  const roles = shotRoles(shots, names, spine);
  const payoff = shots[roles.indexOf("payoff")];
  // shotRoles' payoff is the spine's payoff beat when one is timed and holds a shot, else the last shot: named as such.
  const beat = Array.isArray(spine) ? spine.filter((entry) => entry?.role === "payoff" && Number.isFinite(entry.from) && Number.isFinite(entry.to) && entry.to > entry.from).at(-1) : null;
  const fromSpine = Boolean(beat && payoff && payoff.cue < beat.to && payoff.cue + payoff.dur > beat.from);
  return storyCues({ shots, payoffAt: payoff ? payoff.cue : null, start, payoffKind: fromSpine ? "payoff beat" : "last shot" });
}

/**
 * The same facts for a built scene (check): its video layers by their file time (speed and
 * reverse counted: mediaSoundTime) against the section starts of `music`'s saved song shape.
 * Null when the song plays sped up or reversed, or has no section start inside the scene.
 */
export function sceneCueShows({ scene, music, shape, media = {}, document = null, story = [] }) {
  const seconds = Number(scene?.duration) || 0;
  const played = music && shape ? mediaPlaybackRange(music, seconds) : null;
  const song = played && !played.remapped ? songSections(shape, { offset: played.offset - played.start, to: seconds }) : null;
  const cues = (song?.sections ?? []).filter((section) => section.from > 1e-3 && section.from < seconds - 1e-3).map((section) => ({ at: section.from, kind: section.kind }));
  const told = story.filter((cue) => cue.at > 1e-3 && cue.at < seconds - 1e-3);
  if (!cues.length && !told.length) return null;
  const { nameOf = (src) => src, tagsOf = () => null, pool = [] } = media;
  // Groups and components with their own clock (play ranges, componentStart): their layers as drawn,
  // on the scene's clock. A layer that cannot be expanded keeps the saved list.
  let layers = scene.layers ?? [];
  if (document && scene.id) { try { layers = expandComponents(document, scene.id, { camera: false }).layers ?? layers; } catch { layers = scene.layers ?? []; } }
  // A cut-out (cutoutOf) shows its clip's own pixels on top of it: the clip below is the shot. A
  // picture (image layer, an animated GIF excepted) is a still: shown again is the fact.
  const spans = layers.filter((layer) => (layer.type === "video" || layer.type === "image") && layer.visible !== false && layer.src && !layer.cutoutOf).flatMap((layer) => {
    // An animated GIF (it has a Play range) moves: its file time counts like a clip's.
    const still = layer.type === "image" && !(isGifLayer(layer) && layer.mediaDuration > 0);
    // Each stretch the layer is on screen: its Play range less the times its Hide and Show hide it.
    return shownParts(layer, seconds).map((range) => ({ at: range.start, end: range.end, label: `layer ${layer.name || layer.id}`, file: layer.src, name: nameOf(layer.src),
      fileAt: still ? () => 0 : (time) => mediaSoundTime(layer, time), tags: tagsOf(layer.src), ...(still ? { still: true } : {}) }));
  });
  return spans.length ? cueShows({ spans, cues, story: told, seconds, pool }) : null;
}

/**
 * The stretches [{start, end}] a picture or clip layer is on screen: its Play range (a still
 * image's is the whole scene) less the hidden ranges of its Hide and Show (a board-built picture
 * shows only on its shot that way).
 */
export function shownParts(layer, seconds) {
  const range = mediaPlaybackRange(layer, seconds);
  if (!range) return [];
  let parts = [{ start: range.start, end: range.end }];
  for (const hidden of hiddenRanges(layer.animations, seconds)) {
    parts = parts.flatMap((part) => [{ start: part.start, end: Math.min(part.end, hidden.start) }, { start: Math.max(part.start, hidden.end), end: part.end }])
      .filter((part) => part.end - part.start > 1e-3);
  }
  return parts;
}

/**
 * The board as built in `scene` (check): each shot whose layer compose made (board-<id>) takes
 * that layer's first shown stretch as its cue and length, so the story's moments are the scene's
 * own after later edits. A shot with no such layer keeps the board's times.
 */
export function builtBoard(board, scene) {
  const seconds = Number(scene?.duration) || 0;
  const layers = scene?.layers ?? [];
  const shots = (board?.shots ?? []).map((shot) => {
    const layer = layers.find((entry) => (entry.type === "video" || entry.type === "image") && !entry.cutoutOf
      && (entry.name === `board-${shot.id}` || entry.id === `board-${String(shot.id).toLowerCase()}`));
    const part = layer ? shownParts(layer, seconds)[0] : null;
    return part ? { ...shot, cue: round(part.start, 3), dur: round(part.end - part.start, 3) } : shot;
  });
  return { ...board, shots };
}

/** The cue lines alone (the board answer prints them after a save). */
export const boardCueLines = (facts) => cueShowLines(facts?.shows ?? null);

/**
 * The look board's two lines (the second only with a turn and measured beats), then the cue lines.
 * With no measured drop and no measured reference there is nothing to set the board's pace beside:
 * no pace line, so such a board's page reads as before.
 */
export function boardPaceLines(facts) {
  if (!facts) return [];
  if (!facts.turn && !facts.refs.length) return boardCueLines(facts);
  const kind = facts.turn?.kind ?? "turn";
  const lines = [paceLine(facts.ours, facts.refs, { kind })];
  const beat = facts.times.length ? beatLine({ turn: facts.turn.at, beats: facts.beats, period: facts.period, times: facts.times.slice(0, TIMES_SHOWN), why: facts.why, kind, call: SNAP_CALL }) : null;
  if (beat) lines.push(beat);
  return [...lines, ...boardCueLines(facts)];
}
