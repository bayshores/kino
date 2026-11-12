// compose {from:"board"}: the storyboard built as it was planned (run 8, DESIGN.md D4 as its
// skeptic amended it). Each shot becomes one layer in board order on the main scene, at its cue,
// for its length, from its in-point, with its crop; a text shot (no footage) becomes a card of its
// text; the board's music layer is kept as the board placed it (the song start the board was
// approved with). Plain data in, ops out: the block runner (blocks.mjs) runs them.
//
// Why: in run 8 the approval's next: named a footage compose that never read the board; it built
// a second scene of 23 shots and moved the song from 0:40 to 0:01 (trace/time.md, DESIGN.md D4).
import { MOVES } from "../../engine/blocks/moves/index.js";
import { NONE, ONE_FRAME, WHOLE, holdEnd, mainScene } from "../../engine/board.js";

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
function moveOp(shot, layer, previous, text, cues = [], file = null, frame = null) {
  if (shot.move?.name === "push" && shot.move.kind === "camera") return pushOp(shot, layer, file, frame);
  if (shot.move?.name === "impact-accent") return accentOp(shot, layer, cues);
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

// What compose chose for a move it filled in itself, said in its receipt so the agent can change it.
const SAID = new WeakMap();
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// A camera push keeps this share of the crop at its end (a 1.11x push, a guess at a slow push).
const PUSH_KEEP = 0.9;
// A cue this close to the shot's cue is the shot's moment (3 frames at 30 fps).
const NEAR_CUE = 0.1;

// A camera push on a footage shot: the 2D camera (frame op) from the crop to PUSH_KEEP of it over
// the whole shot, centered on the subject box as far as the crop allows (on the crop's middle
// without a subject). rect is % of the layer, which is the whole source.
function pushOp(shot, layer, file, frame) {
  if (shot.media === NONE || !layer) return null;
  const cropped = Array.isArray(shot.crop);
  const [x, y, w, h] = cropped ? shot.crop : [0, 0, 100, 100];
  // The saved board keeps the subject as boxes (one per moment); the push aims at the first.
  const box = [shot.subject?.boxes?.[0], shot.subject?.box].find(Array.isArray) ?? null;
  const [cx, cy] = box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : [x + w / 2, y + h / 2];
  const height = h * PUSH_KEEP;
  // A crop has the frame's shape within 2%; the end rect takes the frame's exact shape, so the
  // frame op's fit leaves no sliver past the file's edge when the rect meets it.
  const ratio = file?.width > 0 && file?.height > 0 && frame?.width > 0 && frame?.height > 0 ? (frame.width / frame.height) / (file.width / file.height) : null;
  const width = cropped && ratio ? Math.min(100, height * ratio) : w * PUSH_KEEP;
  // Inside the crop when it fits there, else inside the file.
  const [low, high] = width <= w ? [x, x + w - width] : [0, 100 - width];
  const left = clamp(cx - width / 2, low, high), top = clamp(cy - height / 2, y, y + h - height);
  const rect = [left, top, width, height].map((value) => Math.round(value * 100) / 100);
  const op = { op: "frame", layer, rect, at: r3(shot.cue), dur: r3(shot.dur) };
  SAID.set(op, `frame rect [${rect.join(", ")}] over ${r3(shot.dur)} s, toward ${box ? "the subject box" : "the crop's middle"}`);
  return op;
}

// What a cue is, for the accent kind that answers it: a song seam (fit_music's) or a top accent
// flashes, a rest dips; anything else is a hit, which takes any moment.
function accentKind(cue) {
  const song = /^song-([a-z]+(?:-[a-z]+)?)-\d+$/.exec(cue.name ?? "");
  if (song && cue.fitted === true) return ["break", "dropout"].includes(song[1]) ? ["dip", "a rest in the song"] : ["flash", "a song seam"];
  if (cue.kind === "accent" && (cue.rank === 1 || (cue.weight ?? 0) >= 0.6)) return ["flash", "a top accent"];
  return null;
}

// impact-accent on a shot: the measured cue on the shot's cue (within 3 frames) is its reason and
// picks its kind; with none, a hit at the shot's cue (a small one where nothing is measured).
function accentOp(shot, layer, cues) {
  if (!layer) return null;
  const near = cues.filter((cue) => Number.isFinite(cue.time) && Math.abs(cue.time - shot.cue) <= NEAR_CUE && accentKind(cue))
    .sort((a, b) => Math.abs(a.time - shot.cue) - Math.abs(b.time - shot.cue))[0];
  if (near) {
    const [kind, what] = accentKind(near);
    const op = { op: "move", name: "impact-accent", kind, at: `cue:${near.name}`, layer };
    SAID.set(op, `${kind} at cue:${near.name} (${what}, ${r3(near.time)} s)`);
    return op;
  }
  const op = { op: "move", name: "impact-accent", kind: "hit", at: r3(shot.cue), layer };
  SAID.set(op, `hit at ${r3(shot.cue)} s (no song seam or accent within 3 frames)`);
  return op;
}

/**
 * The ops that build `board` on a frame of {width, height, duration}. `fileOf(src)` is the file's
 * {width, height, duration, kind: "video"|"image"} or null. Returns {ops, moves, footage, cards,
 * held, missing} (held: words kept on screen past their shot, added last so they are on top): moves are [{n, op}] to run one by one (a move that cannot be placed is named, the
 * shots stay), missing the shot numbers whose file kino no longer has.
 */
export function boardBuildOps(board, frame, fileOf, cues = []) {
  const ops = [];
  const moves = [];
  const missing = [];
  let previous = null;
  let footage = 0;
  let cards = 0;
  let held = 0;
  const onTop = [];
  board.shots.forEach((shot, index) => {
    const n = index + 1;
    const name = `${BUILT_PREFIX}${shot.id ?? n}`;
    const end = r3(shot.cue + shot.dur);
    const shown = [show(shot.cue), ...(end < frame.duration - ONE_FRAME ? [hide(end)] : [])];
    let layer = null;
    let file = null;
    if (shot.media !== NONE) {
      file = fileOf(shot.media);
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
      // Words held past their shot (text.until) stay to that second and are added after every
      // shot, so they sit above the footage they run across.
      const stays = holdEnd(board.shots, shot);
      const lasts = stays === null ? shown : [show(shot.cue), ...(stays < frame.duration - ONE_FRAME ? [hide(stays)] : [])];
      (stays === null ? ops : onTop).push({ op: "add_layer", layerType: "text", name: text, properties: { text: t.text, fontFamily: t.family, fontWeight: t.weight, fontSize: t.size, fill: t.fill,
        textAlign: "center", x: r3(frame.width * 0.05), width: r3(frame.width * 0.9), height, y: r3((t.y / 100) * frame.height - height / 2) }, animations: lasts });
      if (stays !== null) held += 1;
      if (!layer) cards += 1;
    }
    const own = layer ?? text;
    const move = shot.move && !shot.move.none ? moveOp(shot, own, previous, text, cues, file, frame) : null;
    if (shot.move?.name && !shot.move.none) moves.push({ n, name: shot.move.name, op: move, ...(move && SAID.has(move) ? { said: SAID.get(move) } : {}) });
    previous = own;
  });
  ops.push(...onTop);
  return { ops, moves, footage, cards, held, missing };
}

// A shot's entrance fade starts within this many seconds of its cue (a move's Appear starts 0.04 s early).
const ENTRANCE_NEAR = 0.1;

/**
 * The update_animation ops that keep a board join from showing the bare background: a footage shot
 * whose move gave it a fade in at its cue (opacity from under 1) starts under the shot before it, so
 * that shot's Hide moves from the cue to the end of the fade. Run after the moves are placed, on the
 * built scene. Returns [{op, layerId, animationId, properties: {start}, note}] (note says the old and
 * new second and the fade it measured); nothing when no join needs it.
 */
export function entranceJoinOps(scene, board) {
  const ops = [];
  const byName = new Map((scene.layers ?? []).map((layer) => [layer.name, layer]));
  const seconds = (animation) => (animation.enabled === false ? [] : [animation]);
  let before = null;
  board.shots.forEach((shot, index) => {
    const n = index + 1;
    if (shot.media === NONE) { before = null; return; }
    const layer = byName.get(`${BUILT_PREFIX}${shot.id ?? n}`);
    const earlier = before;
    before = layer ?? null;
    if (!layer || !earlier) return;
    const fade = (layer.animations ?? []).flatMap(seconds).find((animation) => animation.kind === "in" && animation.from?.opacity !== undefined && animation.from.opacity < 1
      && animation.to?.opacity > animation.from.opacity && Math.abs(animation.start - shot.cue) <= ENTRANCE_NEAR);
    if (!fade) return;
    const stopAt = r3(fade.start + fade.duration);
    const hider = (earlier.animations ?? []).flatMap(seconds).find((animation) => animation.kind === "hide" && Math.abs(animation.start - shot.cue) <= ONE_FRAME);
    if (!hider || !(stopAt > hider.start + 1e-6)) return;
    ops.push({ op: "update_animation", layerId: earlier.id, animationId: hider.id, properties: { start: stopAt },
      note: `shot ${n - 1} stays under shot ${n}'s fade in: its Hide moves from ${r3(hider.start)} s to ${stopAt} s, where the fade (${r3(fade.start)}–${stopAt} s, ${fade.name ?? "Fade in"}) ends` });
  });
  return ops;
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
