// Hand-run: the footage finder against real YouTube (or Commons), never in npm test. It runs the
// agent's three calls and prints what the agent would read: library {topic:"footage", search},
// then scan "top", then the import of the scan's picked shots.
//   node scripts/footage-live.mjs <folder> "<search words>" ["<want: visual words>"] [--commons] [--no-model] [--no-import]
// <folder> is private: scans, cached searches, the image model and the imported clips stay there
// (third-party media: keep it out of git, for example under .scratch/). No cookies are sent and
// yt-dlp keeps its default user agent. --commons searches Wikimedia Commons instead; --no-model
// skips the image model download (about 100 MB) and its visual match; --no-import stops after the scan.
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { createFootageFinder } from "../backend/footage-finder/index.mjs";
import { createFootageActions, scanIdOf } from "../backend/footage-finder/actions.mjs";
import { createCommonsSource } from "../backend/footage-finder/licensed.mjs";
import { planTake, takeText } from "../backend/footage-finder/take.mjs";
import { createLookEmbed } from "../backend/look-embed.mjs";
import { probeMedia } from "../backend/media-probe.mjs";
import { createYouTubeGate } from "../backend/process-slots.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const [folder, words, want] = args.filter((arg) => !arg.startsWith("--"));
if (!folder || !words) {
  console.error('usage: node scripts/footage-live.mjs <folder> "<search words>" ["<want>"] [--commons] [--no-model] [--no-import]');
  process.exit(1);
}
const root = path.resolve(folder);
const clips = path.join(root, "clips");
await mkdir(clips, { recursive: true });

// The imported clips land in <folder>/clips with their credit, as the media library would keep them.
async function addMedia(file, { name, extra }) {
  const target = path.join(clips, path.basename(name).replace(/[^\w. -]+/g, "_"));
  await rename(file, target);
  const facts = await probeMedia(target);
  return { id: path.basename(target), src: target, name, duration: facts.duration, width: facts.width, height: facts.height, ...extra };
}

const embed = flags.has("--no-model") ? null : createLookEmbed({ modelDir: path.join(root, "models"), download: true });
const finder = createFootageFinder({
  directory: path.join(root, "footage"),
  dataRoot: root,
  youtube: createYouTubeGate(),
  embed,
  commons: createCommonsSource({ enabled: () => true, directory: path.join(root, "footage", "commons") }),
  modelReady: () => !embed || embed.ready(),
  addMedia,
});
const actions = createFootageActions({ finder, waitMs: 10 * 60_000 });

let footage = null;
async function ask(input) {
  const started = Date.now();
  console.log(`\n> library ${JSON.stringify({ topic: "footage", ...input })}`);
  let answer;
  try { answer = await actions.handle(input, { footage, personClips: 0, signal: undefined }); } catch (error) {
    // A refusal the agent would read (FootageError): print it and its next call, and stop.
    console.log(`refused (${error.code ?? "error"}): ${error.message}`);
    if (error.nextCall) console.log(`next: ${error.nextCall.tool} ${JSON.stringify(error.nextCall.input)}`);
    process.exit(1);
  }
  if (answer.update) footage = answer.update(footage);
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(answer.text);
  if (answer.nextCall) console.log(`next: ${answer.nextCall.tool} ${JSON.stringify(answer.nextCall.input)}`);
  return answer;
}

await ask({ search: words, ...(want ? { want } : {}), ...(flags.has("--commons") ? { source: "commons" } : {}) });
const scanned = await ask({ scan: "top" });
if (!flags.has("--no-import") && scanned.nextCall?.tool === "project") {
  const { file, options } = scanned.nextCall.input;
  const candidate = footage.candidates.find((entry) => entry.code === file);
  const scan = await finder.readScan(scanIdOf(candidate));
  const pieces = planTake(candidate, scan, { file, shots: options?.shots });
  const started = Date.now();
  const result = await finder.take(candidate, pieces, { projectId: "footage-live" });
  console.log(`\n> project ${JSON.stringify(scanned.nextCall.input)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(takeText(candidate, result));
}
