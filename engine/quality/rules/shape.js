// shape_guess: the video's shape (landscape, portrait or square) is not the shape of most of its
// footage files, and the person never said where it plays. A failed edit made a 9:16 video out of
// 16:9 footage because the agent guessed "phone"; every crop after that cut faces. Only the
// person's words naming the scene's shape (brief plays_on by "you" with named) or a matching shape
// clear it, so a deliberate vertical edit stays possible: the person says so. No footage in the
// scene, no finding.
//
// The agent service hands in ctx.mediaSizes {src: {width, height} | null}, ctx.scene (the raw
// scene) and ctx.playsOn (the brief's plays_on line {text, by, quote, named} or null).
import { shapeOf } from "../../footage/layout.js";
import { sec } from "../analysis.js";

const size = (width, height) => `${Math.round(width)}x${Math.round(height)}`;

/**
 * The shape more than half of the footage files share: {shape, count, of, example} or null (a tie
 * or a three-way split is no shape). `example` is a size of the most common aspect among those
 * files, so every message names the same size (an ask, a finding, a receipt).
 */
export function majorityShape(sizes = []) {
  const list = sizes.filter((size) => size?.width > 0 && size?.height > 0).map((size) => ({ shape: shapeOf(size.width, size.height), width: size.width, height: size.height }));
  const counts = new Map();
  for (const entry of list) counts.set(entry.shape, (counts.get(entry.shape) ?? 0) + 1);
  const [shape, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!shape || count * 2 <= list.length) return null;
  const same = list.filter((entry) => entry.shape === shape);
  const ratios = new Map();
  for (const entry of same) { const key = (entry.width / entry.height).toFixed(2); ratios.set(key, (ratios.get(key) ?? 0) + 1); }
  const [ratio] = [...ratios].sort((a, b) => b[1] - a[1])[0];
  const example = same.find((entry) => (entry.width / entry.height).toFixed(2) === ratio);
  return { shape, count, of: list.length, example: { width: example.width, height: example.height } };
}

/** The shape most of the scene's footage files share, with how many files: {shape, count, of, example} or null. */
function footageShape(scene, mediaSizes) {
  const files = new Map();
  for (const layer of scene.layers ?? []) {
    if (layer.type !== "video" || !layer.src || layer.enabled === false || files.has(layer.src)) continue;
    const found = mediaSizes?.[layer.src];
    // A screen recording is shaped by the screen, not by how the video is filmed.
    if (!(found?.width > 0 && found?.height > 0) || found.screen || found.named || layer.recording) continue;
    files.set(layer.src, { width: found.width, height: found.height });
  }
  return majorityShape([...files.values()]);
}

// The words that name a shape. Matched as whole words, any case; no brand or platform names.
// SHAPE_WORDS say a shape outright. PLACE_WORDS say where it plays, and are also everyday words
// ("love the story", "the phone shot"): in a free reply they count only in a place phrase
// ("for my phone", "on tv").
const SHAPE_WORDS = {
  portrait: ["vertical", "portrait", "9:16", "9x16", "9 x 16", "4:5"],
  landscape: ["horizontal", "landscape", "widescreen", "16:9", "16x9"],
  square: ["square", "1:1"],
};
const PLACE_WORDS = {
  portrait: ["phone", "tall", "story", "stories", "reel", "reels", "shorts"],
  landscape: ["tv", "television", "desktop", "laptop", "monitor", "cinema"],
  square: [],
};
const START = "(?<![\\p{L}\\p{N}_:])";
const END = "(?![\\p{L}\\p{N}_:])";
const anyOf = (words) => words.map((word) => word.replace(/ /g, "\\s+")).join("|");
const SHAPES = Object.keys(SHAPE_WORDS);
const LINE_PATTERNS = SHAPES.map((shape) => [shape, new RegExp(`${START}(?:${anyOf([...SHAPE_WORDS[shape], ...PLACE_WORDS[shape]])})${END}`, "iu")]);
const REPLY_PATTERNS = SHAPES.map((shape) => [shape, new RegExp(
  `${START}(?:${anyOf(SHAPE_WORDS[shape])})${END}` + (PLACE_WORDS[shape].length
    ? `|${START}(?:for|on|in)\\s+(?:(?:my|our|your|the|a|an)\\s+)?(?:${anyOf(PLACE_WORDS[shape])})${END}` : ""), "iu")]);

/**
 * The shape the person's words name: "portrait", "landscape" or "square"; null for none, or for
 * two different shapes. `reply` is for a free answer to a stop, where a place word counts only
 * in a place phrase; a brief's plays_on line is about the place already, so any of the words count.
 */
export function namedShape(words, { reply = false } = {}) {
  const text = String(words ?? "");
  const found = (reply ? REPLY_PATTERNS : LINE_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([shape]) => shape);
  return found.length === 1 ? found[0] : null;
}

// The footage example's shape at the scene's long edge: 1080x1920 over 1920x1080 footage gives 1920x1080.
export function sizeLikeFootage(own, example) {
  const scale = Math.max(own.width, own.height) / Math.max(example.width, example.height);
  return { width: Math.round(example.width * scale), height: Math.round(example.height * scale) };
}

// A frame of `shape` at the scene's long edge: portrait 9:16, landscape 16:9, square 1:1.
export function sizeOfShape(own, shape) {
  const long = Math.max(own.width, own.height);
  const short = Math.round(long * 9 / 16);
  return shape === "portrait" ? { width: short, height: long } : shape === "landscape" ? { width: long, height: short } : { width: long, height: long };
}

/**
 * The ops that give the scene `size` and re-frame each of its footage shots (frame_shot keeps the
 * subject in the new frame): [update_scene, frame_shot] or [update_scene] with no video layer.
 * `sceneId` names the scene when the project has several; `refOf` names a layer (its name, or the
 * service's unique code, since two clips may share a name).
 */
export function followOps(scene, size, { sceneId, refOf = (layer) => layer.name || layer.id } = {}) {
  const layers = (scene.layers ?? []).filter((layer) => layer.type === "video" && layer.enabled !== false).map(refOf);
  return [{ op: "update_scene", ...(sceneId ? { sceneId } : {}), properties: { width: size.width, height: size.height } },
    ...(layers.length ? [{ op: "frame_shot", layers }] : [])];
}

// The call that turns the scene into the footage's shape and re-frames each footage shot.
function followCall(scene, model, footage) {
  const [update, frame] = followOps(scene, sizeLikeFootage(model, footage.example));
  const layers = frame?.layers ?? [];
  const shown = layers.length > 8 ? [...layers.slice(0, 8), "..."] : layers;
  return `edit ${JSON.stringify({ ops: [update, ...(frame ? [{ ...frame, layers: shown }] : [])] })}`;
}

/**
 * shape_guess: the scene's shape differs from most of its footage and the person did not name it.
 * Only the person's words (plays_on by "you") that name the scene's own shape clear it. When
 * they named none ("your call"), kino follows the footage; when they named another shape, the
 * scene should have it.
 */
export function shapeGuess(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  // Only the video's scene: a format variant is another shape on purpose.
  if (!scene || !ctx.mediaSizes || ctx.videoScene === false) return [];
  const footage = footageShape(scene, ctx.mediaSizes);
  const own = shapeOf(model.width, model.height);
  if (!footage || footage.shape === own) return [];
  const plays = ctx.playsOn;
  // A line saved before kino stored `named` is read from its quote (no shape in it: false, left to you).
  const named = plays?.by === "you" ? (plays.named === undefined ? namedShape(plays.quote) ?? false : plays.named) : null;
  if (named === own) return [];
  const footageSize = size(footage.example.width, footage.example.height);
  const ownSize = size(model.width, model.height);
  const call = followCall(scene, model, footage);
  const hint = `Run ${call}: the scene takes the footage's shape, so every crop keeps the picture whole. If the person names a shape or a place to keep (a phone, a feed), save it with brief plays_on by "you" and their words as the quote. Do not guess a shape.`;
  let message;
  if (plays?.by === "you" && named === false)
    message = `${ctx.sceneName} is ${own} (${ownSize}); the person left the shape to you ("${ctx.quote(plays.quote ?? plays.text)}") and ${footage.count} of ${footage.of} footage files are ${footage.shape} (${footageSize}): kino follows the footage.`;
  else if (plays?.by === "you" && named)
    message = `the person said "${ctx.quote(plays.quote ?? plays.text)}" (${named}) but ${ctx.sceneName} is ${own}.`;
  else {
    const where = plays?.text ? `plays_on says "${ctx.quote(plays.text)}" but not in the person's words` : "plays_on was never said by the person";
    message = `${ctx.sceneName} is ${own} (${ownSize}) but ${footage.count} of ${footage.of} footage files are ${footage.shape} (${footageSize}), and ${where}: the shape is a guess.`;
  }
  return [{
    rule: "shape_guess", severity: "warn", at: 0, until: sec(model.duration),
    message,
    measured: `scene ${own} ${ownSize} (${plays?.by === "you" ? (named ? `person said ${named}` : "shape left to you") : "guessed"}); footage ${footage.shape} ${footageSize} (${footage.count} of ${footage.of})`,
    required: `the scene's shape matches most of its footage, or brief plays_on is the person's own words naming the scene's shape (by "you", with a quote)`,
    fix: { kind: "hint", text: hint },
  }];
}
