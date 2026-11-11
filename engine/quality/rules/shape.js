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

/** The shape most of the scene's footage files share, with how many files: {shape, count, of, example} or null. */
function footageShape(scene, mediaSizes) {
  const files = new Map();
  for (const layer of scene.layers ?? []) {
    if (layer.type !== "video" || !layer.src || layer.enabled === false || files.has(layer.src)) continue;
    const found = mediaSizes?.[layer.src];
    // A screen recording is shaped by the screen, not by how the video is filmed.
    if (!(found?.width > 0 && found?.height > 0) || found.screen || found.named || layer.recording) continue;
    files.set(layer.src, { shape: shapeOf(found.width, found.height), width: found.width, height: found.height });
  }
  const counts = new Map();
  for (const entry of files.values()) counts.set(entry.shape, (counts.get(entry.shape) ?? 0) + 1);
  const [shape, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  // "Most": more than half of the files, so a tie or a three-way split is no shape.
  if (!shape || count * 2 <= files.size) return null;
  const example = [...files.values()].find((entry) => entry.shape === shape);
  return { shape, count, of: files.size, example };
}

// The words that name a shape. Matched as whole words, any case; no brand or platform names.
const SHAPE_WORDS = {
  portrait: ["vertical", "portrait", "phone", "tall", "story", "stories", "reel", "reels", "shorts", "9:16", "9x16", "9 x 16", "4:5"],
  landscape: ["horizontal", "landscape", "widescreen", "tv", "television", "desktop", "laptop", "monitor", "cinema", "16:9", "16x9"],
  square: ["square", "1:1"],
};
const SHAPE_PATTERNS = Object.entries(SHAPE_WORDS).map(([shape, words]) => [shape,
  new RegExp(`(?<![\\p{L}\\p{N}_:])(?:${words.map((word) => word.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}_:])`, "iu")]);

/** The shape the person's words name: "portrait", "landscape" or "square"; null for none, or for two different shapes. */
export function namedShape(words) {
  const text = String(words ?? "");
  const found = SHAPE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([shape]) => shape);
  return found.length === 1 ? found[0] : null;
}

// The footage example's shape at the scene's long edge: 1080x1920 over 1920x1080 footage gives 1920x1080.
export function sizeLikeFootage(own, example) {
  const scale = Math.max(own.width, own.height) / Math.max(example.width, example.height);
  return { width: Math.round(example.width * scale), height: Math.round(example.height * scale) };
}

// The call that turns the scene into the footage's shape and re-frames each footage shot.
function followCall(scene, model, footage) {
  const names = (scene.layers ?? []).filter((layer) => layer.type === "video" && layer.name).map((layer) => layer.name);
  const layers = names.length > 8 ? [...names.slice(0, 8), "..."] : names;
  const { width, height } = sizeLikeFootage(model, footage.example);
  return `edit ${JSON.stringify({ ops: [{ op: "update_scene", properties: { width, height } }, { op: "frame_shot", layers }] })}`;
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
  // A line saved before kino stored `named` is read from its quote.
  const named = plays?.by === "you" ? (plays.named === undefined ? namedShape(plays.quote) : plays.named) : null;
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
