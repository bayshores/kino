// shape_guess: the video's shape (landscape, portrait or square) is not the shape of most of its
// footage files, and the person never said where it plays. A failed edit made a 9:16 video out of
// 16:9 footage because the agent guessed "phone"; every crop after that cut faces. Only the
// person's words (brief plays_on by "you") or a matching shape clear it, so a deliberate vertical
// edit stays possible: the person says so. No footage in the scene, no finding.
//
// The agent service hands in ctx.mediaSizes {src: {width, height} | null}, ctx.scene (the raw
// scene) and ctx.playsOn (the brief's plays_on line {text, by, quote} or null).
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

/** shape_guess: the scene's shape differs from most of its footage and plays_on is not the person's. */
export function shapeGuess(model, ctx) {
  const scene = ctx.scene ?? ctx.speechScene;
  // Only the video's scene: a format variant is another shape on purpose.
  if (!scene || !ctx.mediaSizes || ctx.videoScene === false || ctx.playsOn?.by === "you") return [];
  const footage = footageShape(scene, ctx.mediaSizes);
  const own = shapeOf(model.width, model.height);
  if (!footage || footage.shape === own) return [];
  const where = ctx.playsOn?.text ? `plays_on says "${ctx.quote(ctx.playsOn.text)}" but not in the person's words` : "plays_on was never said by the person";
  return [{
    rule: "shape_guess", severity: "warn", at: 0, until: sec(model.duration),
    message: `${ctx.sceneName} is ${own} (${size(model.width, model.height)}) but ${footage.count} of ${footage.of} footage files are ${footage.shape} (${size(footage.example.width, footage.example.height)}), and ${where}: the shape is a guess.`,
    measured: `scene ${own} ${size(model.width, model.height)} (guessed); footage ${footage.shape} ${size(footage.example.width, footage.example.height)} (${footage.count} of ${footage.of})`,
    required: `the scene's shape matches most of its footage, or brief plays_on is the person's own words (by "you", with a quote)`,
    fix: { kind: "hint", text: `Make the scene ${footage.shape} like its footage (every crop then keeps the picture whole), or, if the person said where it plays (a phone, a feed), save that with brief plays_on by "you" and their words as the quote. Do not guess a shape.` },
  }];
}
