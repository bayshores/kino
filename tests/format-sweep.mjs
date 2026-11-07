// Hand-run sweep (not part of npm test): builds every whole-video format's example
// (engine/blocks/videoFormats.js) in every aspect it comes in, with a landscape product picture,
// and runs kino's checks on it. Prints each build's errors and warning counts.
//   node --import ./scripts/test-fonts.mjs tests/format-sweep.mjs [format …]
// Exits 1 when any build has an error.
import { createDocument, createScene } from "../engine/model.js";
import { defaultFonts } from "../engine/fonts.js";
import { composeScene } from "../engine/blocks/compose.js";
import { buildVideoFormat, expandVideoFormat, VIDEO_FORMATS, VIDEO_FORMAT_NAMES } from "../engine/blocks/videoFormats.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { runDataQuality } from "../engine/quality/index.js";

const PICTURES = {
  product: { id: "product.png", src: "/api/media/product.png", width: 1600, height: 1000, name: "Product" },
  logo: { id: "logo.png", src: "/api/media/logo.png", width: 512, height: 512, name: "Logo" },
  recording: { id: "recording.mp4", src: "/api/media/recording.mp4", width: 1920, height: 1080, name: "Recording", kind: "video", duration: 6 },
};
const media = (ref) => PICTURES[ref] ?? PICTURES.product;
const env = { fonts: defaultFonts, media, logo: { media: PICTURES.logo }, sceneId: "s" };
// Every picture slot gets the landscape product picture (the hardest case in a tall frame), and
// every list of media a landscape screen recording.
const filled = (definition) => Object.fromEntries(Object.entries(definition.example).map(([key, value]) => {
  const slot = definition.slots[key];
  if (slot?.kind === "media") return [key, "product"];
  if (slot?.kind === "media-list") return [key, value.map(() => "recording")];
  return [key, value];
}));

const names = process.argv.slice(2).length ? process.argv.slice(2) : VIDEO_FORMAT_NAMES;
let failed = 0;
for (const name of names) {
  const definition = VIDEO_FORMATS[name];
  for (const aspect of definition.aspects) {
    const expanded = expandVideoFormat(name, { ...filled(definition), logo: "logo" }, { aspect });
    const { made } = await buildVideoFormat(expanded, (compose) => composeScene(compose, env));
    const scene = createScene({ id: "s", name, width: made.frame.width, height: made.frame.height, duration: made.duration, background: made.background, layers: made.layers });
    const document = createDocument({ scenes: [scene], videoType: definition.type });
    const model = kinoTimeline(document, "s", { fonts: defaultFonts, fps: 30 });
    const { findings } = runDataQuality(model, { context: { outputFps: 30, videoType: definition.type, assertions: made.assertions } });
    const errors = findings.filter((finding) => finding.severity === "error");
    const warnings = {};
    for (const finding of findings) if (finding.severity !== "error") warnings[finding.rule] = (warnings[finding.rule] ?? 0) + 1;
    console.log(`${name} ${aspect} ${made.duration}s: ${errors.length} errors; warnings ${JSON.stringify(warnings)}`);
    for (const error of errors) console.log(`  ${error.rule}: ${error.message}`);
    failed += errors.length;
  }
}
process.exit(failed ? 1 : 0);
