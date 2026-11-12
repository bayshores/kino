// compose {from:"board"}: the storyboard built as it was planned (run 8, DESIGN.md D4 as its
// skeptic amended it). Each shot becomes one layer in board order on the main scene, at its cue,
// for its length, from its in-point, with its crop; a text shot (no footage) becomes a card of its
// text; the board's music layer is kept as the board placed it (the song start the board was
// approved with). Plain data in, ops out: the block runner (blocks.mjs) runs them.
//
// Why: in run 8 the approval's next: named a footage compose that never read the board; it built
// a second scene of 23 shots and moved the song from 0:40 to 0:01 (trace/time.md, DESIGN.md D4).
import { MOVES } from "../../engine/blocks/moves/index.js";
import { NONE, ONE_FRAME, WHOLE, mainScene } from "../../engine/board.js";

/** The call that builds the board, as next: lines write it. */
export const BOARD_BUILD = Object.freeze({ op: "compose", from: "board" });

// Every layer the build makes is named board-<shot id> (and board-<shot id>-text), so building
// again replaces exactly those.
export const BUILT_PREFIX = "board-";
const r3 = (value) => Math.round(value * 1000) / 1000;
const show = (start) => ({ kind: "show", start: r3(Math.max(0, start)) });
const hide = (start) => ({ kind: "hide", start: r3(start) });

// The layer box that shows `crop` ([x, y, w, h] % of the source) filling a W × H frame, as
// skills/kino/references/storyboard.md writes it; "whole" fits the whole source inside the frame.
export function shotBox(crop, source, frame) {
  const { width: W, height: H } = frame;
  const ratio = source.width > 0 && source.height > 0 ? source.width / source.height : W / H;
  if (!Array.isArray(crop)) {
    const scale = Math.min(W / (H * ratio), 1);
    const width = r3(H * ratio * scale), height = r3(H * scale);
    return { x: r3((W - width) / 2), y: r3((H - height) / 2), width, height };
  }
  const [x, y, , h] = crop;
  const height = (H * 100) / h;
  const width = height * ratio;
  return { x: r3((-x / 100) * width), y: r3((-y / 100) * height), width: r3(width), height: r3(height) };
}

// The move op a shot's designed move becomes, from the move's own fields: a transition gets the
// shot before it (from) and this shot (to); a move on one layer gets this shot's layer (its text
// for a type move). null when the move needs fields kino cannot fill from the board.
function moveOp(shot, layer, previous, text) {
  const definition = MOVES[shot.move?.name];
  if (!definition) return null;
  const fields = definition.fields ?? {};
  const op = { op: "move", name: definition.name, at: r3(shot.cue) };
  if (fields.from && fields.to) {
    if (!previous) return null;
    Object.assign(op, { from: previous, to: layer });
  } else if (fields.layer) op.layer = shot.move.kind === "type" && text ? text : layer;
  else return null;
  return op;
}

/**
 * The ops that build `board` on a frame of {width, height, duration}. `fileOf(src)` is the file's
 * {width, height, duration, kind: "video"|"image"} or null. Returns {ops, moves, shots, cards,
 * missing}: moves are [{n, op}] to run one by one (a move that cannot be placed is named, the
 * shots stay), missing the shot numbers whose file kino no longer has.
 */
export function boardBuildOps(board, frame, fileOf) {
  const ops = [];
  const moves = [];
  const missing = [];
  let previous = null;
  let footage = 0;
  let cards = 0;
  board.shots.forEach((shot, index) => {
    const n = index + 1;
    const name = `${BUILT_PREFIX}${shot.id ?? n}`;
    const end = r3(shot.cue + shot.dur);
    const shown = [show(shot.cue), ...(end < frame.duration - ONE_FRAME ? [hide(end)] : [])];
    let layer = null;
    if (shot.media !== NONE) {
      const file = fileOf(shot.media);
      if (!file) { missing.push(n); return; }
      const box = shotBox(shot.crop === WHOLE ? WHOLE : shot.crop, file, frame);
      const speed = shot.speed ?? 1;
      const properties = file.kind === "image" ? { src: shot.media, ...box }
        : { src: shot.media, ...box, mediaSourceDuration: file.duration || undefined, mediaStart: r3(shot.cue), mediaOffset: r3(shot.in), mediaDuration: r3(shot.dur), ...(speed !== 1 ? { mediaSpeed: speed } : {}), mediaFreeze: "both" };
      ops.push({ op: "add_layer", layerType: file.kind === "image" ? "image" : "video", name, properties, animations: shown });
      layer = name;
      footage += 1;
    }
    let text = null;
    if (shot.text !== NONE && shot.text?.text) {
      const t = shot.text;
      const height = r3(t.size * 1.3);
      text = layer ? `${name}-text` : name;
      ops.push({ op: "add_layer", layerType: "text", name: text, properties: { text: t.text, fontFamily: t.family, fontWeight: t.weight, fontSize: t.size, fill: t.fill,
        textAlign: "center", x: r3(frame.width * 0.05), width: r3(frame.width * 0.9), height, y: r3((t.y / 100) * frame.height - height / 2) }, animations: shown });
      if (!layer) cards += 1;
    }
    const own = layer ?? text;
    const move = shot.move && !shot.move.none ? moveOp(shot, own, previous, text) : null;
    if (shot.move?.name && !shot.move.none) moves.push({ n, name: shot.move.name, op: move });
    previous = own;
  });
  return { ops, moves, footage, cards, missing };
}

// When a layer comes on screen: a video's mediaStart; a picture or text has no media start, so its
// first show animation (what boardBuildOps gives it), else 0.
function shownAt(layer) {
  if (layer.type === "video") return layer.mediaStart ?? 0;
  const show = (layer.animations ?? []).filter((animation) => animation.kind === "show").map((animation) => animation.start ?? 0);
  return show.length ? Math.min(...show) : 0;
}

/**
 * Whether the board is already on the timeline: at least half of its shots are there (built by
 * compose from:"board" or by hand). A footage shot is there when a layer of the same file comes
 * on screen within a frame of its cue; a text-only shot when a text layer holds its words. Pictures
 * count by their show time, so a board of screenshots is seen as built too (a picture has no
 * mediaStart: matching on it alone named the build again after every build). A guess at "half":
 * a hand build that kept most shots counts as built.
 */
export function boardBuilt(document) {
  const shots = (document?.board?.shots ?? []).filter((shot) => shot.media !== NONE || shot.text?.text);
  if (!shots.length) return true;
  const layers = mainScene(document)?.layers ?? [];
  const there = (shot) => (shot.media !== NONE
    ? layers.some((layer) => (layer.type === "video" || layer.type === "image") && layer.src === shot.media && Math.abs(shownAt(layer) - shot.cue) <= ONE_FRAME)
    : layers.some((layer) => layer.type === "text" && layer.text === shot.text.text));
  return shots.filter(there).length * 2 >= shots.length;
}
