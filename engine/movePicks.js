// Which moves fit one storyboard shot, from what the shot holds: a screen
// recording gets a UI move, a typed prompt a typing move, a name a type move, and so on, each
// with the reference moment it copies. Restraint first (pro edits): most shots are a plain cut
// on the voice or the beat, so the cut is the first pick for every shot but the hook, the
// reveal and the payoff; and once the board uses a device, a shot of the same kind is offered
// that device again (a motif), not a new one. The move_needed refusal (engine/board.js) and the
// plain_beats check name these picks for those few key shots only. Pure and deterministic: the
// same board and file names always give the same picks. No imports: engine/board.js loads it
// inside parseDocument.
import { isRecord } from "./numbers.js";

// A file whose name says it is a screen recording or screenshot (also isScreenRecording,
// engine/footage/layout.js).
export const SCREEN_NAME = /screen|recording|\brec\b|capture|screencast/i;

// note: a few words said after the name ("after split_image").
const pick = (kind, name, ref, note = "") => Object.freeze({ kind, name, ref, ...(note ? { note } : {}) });

// A plain cut, no designed move: the board's move {none:"cut"}. The default for most shots.
export const CUT = pick("cut", "cut", "", "on the voice or the beat");

// The moves for each kind of shot, best first. kind, name and ref are what the board's move takes.
export const SHOT_PICKS = Object.freeze({
  screen: [pick("ui", "ui-plane", "agent-launch@21.95"), pick("ui", "build-in", "agent-launch@12.0", "after split_image"), pick("ui", "cursor", "calendar-launch@0.95", "click")],
  device: [pick("transition", "carry", "app-launch@16.4", "into the screen"), pick("transition", "zoom-through", "phone-film@7.27")],
  prompt: [pick("type", "type-on", "agent-launch@6.25"), pick("type", "rewrite", "agent-launch@22.5"), pick("type", "stream", "calendar-launch@18.6")],
  voice: [pick("type", "caption-words", "phone-film@4.4", "small grouped"), pick("type", "status-line", "phone-film@4.4"), pick("type", "accent-hit", "suite-ad@19.5", "on the key word")],
  list: [pick("ui", "roll", "app-launch@28.27")],
  name: [pick("type", "assemble", "suite-ad@23.3"), pick("type", "decode", "agent-launch@29.73"), pick("type", "light-sweep", "agent-launch@46.0")],
  end: [pick("type", "logo-settle", "agent-launch@50.4", "a quiet end")],
  change: [pick("transition", "whip", "calendar-launch@19.95"), pick("transition", "zoom-through", "phone-film@7.27"), pick("transition", "carry", "app-launch@16.4")],
  footage: [pick("camera", "window-punch-in", "phone-film@3.13"), pick("camera", "frame", "agent-launch@11.25", "reframe")],
});
// How the refusal names each kind of shot.
export const SHOT_KIND_WORDS = Object.freeze({ screen: "app recording", still: "app still", device: "phone footage", prompt: "typed prompt", voice: "spoken line", list: "list", name: "name", end: "last shot", change: "shot change", footage: "footage" });

const IMAGE = /\.(png|jpe?g|webp|gif|heic|avif|bmp|tiff?)$/i;
const APP_WORDS = /\b(app|apps|screen|screens|ui|dashboard|interface|website|web page|inbox|editor|settings|desktop|browser|screenshot)\b/i;
const DEVICE_WORDS = /\b(phone|iphone|device|laptop|tablet|holding|holds|hands?|scroll(?:s|ing)?|taps?)\b/i;
const PROMPT_WORDS = /\b(types?|typed|typing|prompt|asks?|search(?:es)?|query|command|request)\b/i;
const VOICE_WORDS = /\b(says?|said|voice|voiceover|spoken|speaks?|narrat\w*|vo|talks?)\b/i;
const LIST_WORDS = /\b(list|items|features|steps|one after another)\b/i;
const NAME_WORDS = /\b(logo|wordmark|title|brand|product name|name card)\b/i;
const REVEAL_WORDS = /\b(reveal\w*|introduc\w*|meet|finally|launch\w*|unveil\w*|here(?:'s| is))\b/i;
const has = (value) => value !== undefined && value !== null && value !== "none";

const isImage = (src, name) => IMAGE.test(String(name ?? "")) || IMAGE.test(String(src ?? ""));

/** "none", "screen", "still" or "footage" for a shot's media src and its file name (null when unknown). */
export function mediaKind(src, name = null) {
  if (!has(src)) return "none";
  if (SCREEN_NAME.test(String(name ?? src))) return "screen";
  return isImage(src, name) ? "still" : "footage";
}

// The words a shot holds: its on-screen text, its subject, its why and its sound.
const wordsOf = (shot) => [isRecord(shot?.text) ? shot.text.text : "", isRecord(shot?.subject) ? shot.subject.what : "", shot?.why ?? "", isRecord(shot?.sound) ? shot.sound.what : ""].join(" · ");
// A shot that names the product: its words say so, or a short line on no media.
const lineOf = (shot) => (isRecord(shot?.text) ? shot.text.text.trim() : "");
const namesIt = (shot) => NAME_WORDS.test(wordsOf(shot)) || (!has(shot?.media) && lineOf(shot) !== "" && lineOf(shot).split(/\s+/).length <= 3);
const showsApp = (shot, name) => mediaKind(shot?.media, name) === "screen" || (has(shot?.media) && APP_WORDS.test(wordsOf(shot)));

/**
 * The kinds of `shot`, best first (keys of SHOT_PICKS), and the word the refusal names it by.
 * `context`: { name: its file's name, prev, next: the neighbor shots, prevName, nextName, last }.
 */
export function shotKinds(shot, { name = null, prev = null, next = null, prevName = null, nextName = null, last = false } = {}) {
  const media = mediaKind(shot?.media, name);
  const words = wordsOf(shot);
  const line = isRecord(shot?.text) ? shot.text.text.trim() : "";
  const screen = showsApp(shot, name);
  const kinds = [];
  if (last) kinds.push("end");
  // A typed request is typed even inside an app recording, so it comes first.
  if (PROMPT_WORDS.test(words) || /^["“].+["”]$/.test(line) || line.endsWith("?")) kinds.push("prompt");
  if (screen) kinds.push("screen");
  if (!screen && media === "footage" && DEVICE_WORDS.test(words) && ((prev && showsApp(prev, prevName)) || (next && showsApp(next, nextName)))) kinds.push("device");
  if (VOICE_WORDS.test(words)) kinds.push("voice");
  if (LIST_WORDS.test(words) || line.split(/,|·|\/|\n/).filter((part) => part.trim()).length >= 3) kinds.push("list");
  if (NAME_WORDS.test(words) || (media === "none" && line && line.split(/\s+/).length <= 3)) kinds.push("name");
  // Footage with nothing else to build on: a transition from the shot before, else a camera move.
  if (!kinds.some((kind) => kind !== "end")) kinds.push(media === "none" ? "name" : has(prev?.media) ? "change" : "footage");
  const word = kinds[0] === "screen" && isImage(shot?.media, name) ? SHOT_KIND_WORDS.still : SHOT_KIND_WORDS[kinds[0]];
  return { kinds, word };
}

/**
 * Each shot's role: "hook" (the first), "payoff" (the last), "reveal" (the first shot between
 * them that says so, names the product, or first shows the app), else null. These few beats
 * are where a designed move earns its place; every other shot can be a plain cut.
 */
export function shotRoles(shots = [], names = {}) {
  const roles = shots.map(() => null);
  if (!shots.length) return roles;
  roles[0] = "hook";
  if (shots.length > 1) roles[shots.length - 1] = "payoff";
  const middle = shots.slice(1, -1).map((_, index) => index + 1);
  const name = (index) => names[shots[index]?.media] ?? null;
  const reveal = middle.find((index) => REVEAL_WORDS.test(wordsOf(shots[index])))
    ?? middle.find((index) => namesIt(shots[index]))
    ?? middle.find((index) => showsApp(shots[index], name(index)) && !shots.slice(0, index).some((shot, before) => showsApp(shot, name(before))));
  if (reveal !== undefined) roles[reveal] = "reveal";
  return roles;
}

/**
 * { word, picks, role? }: up to 3 picks for `shot` ({kind, name, ref, note?}), best first. The
 * motif (`context.motif`, a device the board already uses on a shot of the same kind) comes
 * first, then the moves that fit what the shot holds. A shot that is not a key beat
 * (`context.role` null) is offered the plain cut first: most shots should be one. `context` is
 * shotKinds' plus role and motif.
 */
export function picksFor(shot, context = {}) {
  const { kinds, word } = shotKinds(shot, context);
  // Taken in turns from each kind (the best of each first), so a shot that is two things is offered both.
  const lists = kinds.map((kind) => SHOT_PICKS[kind]);
  const turns = Array.from({ length: Math.max(...lists.map((list) => list.length)) }, (_, round) => lists.map((list) => list[round]).filter(Boolean)).flat();
  // The first of each name stays, so the motif keeps its "again, as shot N".
  const fits = [context.motif, ...turns].filter((entry, index, all) => entry && all.findIndex((other) => other?.name === entry.name) === index);
  const list = context.role ? fits : [CUT, ...fits];
  return { word, picks: list.slice(0, 3), ...(context.role ? { role: context.role } : {}) };
}

/**
 * picksFor for every shot of a board: `names` maps a media src to its file's name. Each shot
 * gets its role (shotRoles) and, when another shot of the same kind already has a designed
 * move, that move as its motif (the device used most on the board first), so the video
 * repeats one or two devices instead of a new one per shot.
 */
export function boardPicks(shots = [], names = {}) {
  const roles = shotRoles(shots, names);
  const contexts = shots.map((shot, index) => {
    const prev = shots[index - 1] ?? null;
    const next = shots[index + 1] ?? null;
    return { name: names[shot?.media] ?? null, prev, next, prevName: names[prev?.media] ?? null, nextName: names[next?.media] ?? null,
      last: shots.length > 1 && index === shots.length - 1 };
  });
  // Footage after footage (a shot change) is still footage: the same kind of moment.
  const kinds = shots.map((shot, index) => shotKinds(shot, contexts[index]).kinds.map((kind) => (kind === "change" ? "footage" : kind)));
  const used = shots.flatMap((shot, index) => (isRecord(shot?.move) && shot.move.name && shot.move.kind ? [{ index, move: shot.move }] : []));
  const count = (name) => used.filter((entry) => entry.move.name === name).length;
  return shots.map((shot, index) => {
    const same = used.filter((entry) => entry.index !== index && kinds[index].includes(kinds[entry.index][0]));
    const best = same.sort((a, b) => count(b.move.name) - count(a.move.name) || a.index - b.index)[0];
    const motif = best ? pick(best.move.kind, best.move.name, best.move.ref ?? "", `again, as shot ${best.index + 1}`) : null;
    return picksFor(shot, { ...contexts[index], role: roles[index], motif });
  });
}

/** The edit op that builds a pick: whip-in is a preset and frame an op; the rest are moves. */
export function pickOp(entry) {
  if (entry.kind === "cut") return '{op:"board", ...} with move {none:"cut"}';
  if (entry.name === "whip") return '{op:"add_animation", preset:"whip-in", ...}';
  if (entry.name === "frame") return '{op:"frame", ...}';
  return `{op:"move", name:"${entry.name}", ...}`;
}

/** One pick as a board move reads (moveWords): "ui build-in after split_image (agent-launch@12.0)", or the plain cut. */
export const pickWords = (entry) => (entry.kind === "cut" ? `a plain cut ${entry.note} (move {none:"cut"})`
  : `${entry.kind} ${entry.name}${entry.note ? ` ${entry.note}` : ""}${entry.ref ? ` (${entry.ref})` : ""}`);
