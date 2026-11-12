// The storyboard's pace beside the project's references (look board) and the song's measured beat
// times after its turn (look board, and board {snap:"beats"}). Facts only: kino never moves a cut
// unasked, and the same words print inside or outside the references' range.
import { boardSpan, mainScene } from "../../engine/board.js";
import { paceFacts, paceLine, beatLine } from "../../engine/cutFacts.js";
import { songSections } from "../../engine/footage/pace.js";
import { beatGrid, editBeats } from "../../engine/footage/cuts.js";
import { medianOf, nearestBeats, defaultPace } from "../../engine/footage/refPace.js";
import { boardSpans, cueShowLines, cueShows } from "../../engine/footage/cueShows.js";
import { mediaPlaybackRange, mediaSoundTime } from "../../engine/playback.js";
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
 * turn every that many beats, to the board's end.
 */
export function boardPaceFacts({ document, shape = null, analysis = null, refs = [], media = {} }) {
  const board = document?.board;
  if (!board?.shots?.length) return null;
  const span = boardSpan(document, board);
  const scene = mainScene(document);
  const layer = scene?.layers?.find((entry) => entry.id === board.music) ?? null;
  // A sped-up or reversed song has no straight file-to-edit mapping: whole-board pace only.
  const played = layer ? mediaPlaybackRange(layer, Number(scene.duration) || 0) : null;
  const range = played && !played.remapped ? played : null;
  const offset = range ? range.offset - range.start : null;
  const song = range && shape ? songSections(shape, { offset, to: span.end }) : null;
  const drops = (song?.seams ?? []).filter((seam) => seam.kind === "drop" && seam.at > span.start && seam.at < span.end);
  const heaviest = drops.reduce((best, seam) => (!best || (seam.weight ?? 0) > (best.weight ?? 0) ? seam : best), null);
  const turn = heaviest ? { at: heaviest.at, kind: heaviest.kind } : null;
  const cuts = board.shots.slice(1).map((shot) => shot.cue);
  const ours = paceFacts({ cuts, seconds: span.end, start: span.start, turn: turn?.at ?? null });
  const measured = (refs ?? []).filter((ref) => Array.isArray(ref?.numbers?.cuts) && ref.numbers.seconds > 0);
  const refFacts = measured.map((ref) => paceFacts({ cuts: ref.numbers.cuts, seconds: ref.numbers.seconds, turn: ref.heard?.change?.at ?? null }));
  const shows = boardCueShows(board, song, span, media);
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
 * unused scanned shots}. Null without a measured song shape.
 */
function boardCueShows(board, song, span, { nameOf = (src) => src, tagsOf = () => null, pool = [] } = {}) {
  const cues = (song?.sections ?? []).filter((section) => section.from > span.start + 1e-3 && section.from < span.end - 1e-3).map((section) => ({ at: section.from, kind: section.kind }));
  if (!cues.length) return null;
  const spans = boardSpans(board.shots, nameOf).map((entry, index) => ({ ...entry, tags: entry.file ? tagsOf(board.shots[index].media) : null }));
  return cueShows({ spans, cues, seconds: span.end - span.start, pool });
}

/**
 * The same facts for a built scene (check): its video layers by their file time (speed and
 * reverse counted: mediaSoundTime) against the section starts of `music`'s saved song shape.
 * Null when the song plays sped up or reversed, or has no section start inside the scene.
 */
export function sceneCueShows({ scene, music, shape, media = {} }) {
  const seconds = Number(scene?.duration) || 0;
  const played = music && shape ? mediaPlaybackRange(music, seconds) : null;
  if (!played || played.remapped) return null;
  const song = songSections(shape, { offset: played.offset - played.start, to: seconds });
  const cues = (song?.sections ?? []).filter((section) => section.from > 1e-3 && section.from < seconds - 1e-3).map((section) => ({ at: section.from, kind: section.kind }));
  if (!cues.length) return null;
  const { nameOf = (src) => src, tagsOf = () => null, pool = [] } = media;
  const spans = (scene.layers ?? []).filter((layer) => layer.type === "video" && layer.visible !== false && layer.src).flatMap((layer) => {
    const range = mediaPlaybackRange(layer, seconds);
    return range ? [{ at: range.start, end: range.end, label: `layer ${layer.name || layer.id}`, file: layer.src, name: nameOf(layer.src), fileAt: (time) => mediaSoundTime(layer, time), tags: tagsOf(layer.src) }] : [];
  });
  return spans.length ? cueShows({ spans, cues, seconds, pool }) : null;
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
