// Golden frames for look {mode:"source"} and the one-tile-per-shot sheet: the whole agent path
// (a real server, the Sintel test clip imported, mark_subject, look) against stored PNGs in
// tests/golden/look-source/. The clip is credited in tests/fixtures/footage/SOURCES.md.
//
// The project is 270 × 480 (9:16) with the 16:9 clip 854 × 480 filling its height:
//   source-center@0.6.png  x −292 (a center crop, 34–66% of the source), the agent's box on Sintel
//   source-dragon@2.2.png  x −279 (33–64%), the agent's box on the red dragon (x 40–57%, y 12–34%
//                          of frame 52, the one kino draws for file 2.2 s)
//   sheet-shots.png        look sheet: 12 tiles shared by the three shots (3, 6 and 3), with the
//                          whole clip 270 × 152 in the middle of the frame
// The source views are drawn at width 320 (the smallest), and the sheet's tiles are mostly black,
// to keep the stored PNGs small. Apple Vision is off (KINO_CUTOUT_HELPER=none), so a Mac with the
// kino-cutout helper draws the same. Besides 0.1% of pixels in all, no 16×16 block may have more
// than 8 different pixels (worstBlock), so a wrong digit or word in a label fails.
// When a change is meant to alter these pictures, run this file with KINO_GOLDEN_UPDATE=1, look at
// the new PNGs, and commit them with the change (docs/testing.md). A failed look's actual and diff
// PNGs go to KINO_GOLDEN_FAILURES when it is set (CI keeps that folder), as golden-frames does.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { MAX_BLOCK_MISMATCH, MAX_MISMATCH_RATIO, comparePixels, decodePng, encodePng, worstBlock } from "./golden/compare.mjs";
import { hasMediaTools } from "./golden/media.mjs";
import { startTestServer } from "../backend/media.test.support.mjs";

const DIRECTORY = fileURLToPath(new URL("./golden/look-source/", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const UPDATE = process.env.KINO_GOLDEN_UPDATE === "1";
const skip = hasMediaTools ? false : "FFmpeg and ffprobe are required to import the test clip";

let server;
// The three looks, made in order on one project (each name: its PNG).
const pictures = new Map();

async function agent(verb, body) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "golden", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  const reply = await response.json();
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}
const image = (reply) => Buffer.from(reply.images[0].data, "base64");

before(async () => {
  if (skip) return;
  server = await startTestServer({ env: { KINO_CUTOUT_HELPER: "none" } });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "sintel-village-dragon.mp4" }, body: await readFile(CLIP) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const clip = await upload.json();
  await agent("project", { action: "create", id: "golden", name: "Golden", width: 270, height: 480, duration: 4.4, background: "#000000" });
  await agent("edit", { ops: [
    { op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -292, y: 0, width: 854, height: 480, mediaSourceDuration: 4.417 } },
    { op: "mark_subject", layer: "footage", t: 0.6, box: [17, 25, 38, 63] },
  ] });
  const center = await agent("look", { mode: "source", layer: "footage", t: 0.6, width: 320 });
  assert.match(center.text, /· vision: skipped \(Apple Vision is turned off \(KINO_CUTOUT_HELPER=none\)\.\)$/m);
  pictures.set("source-center@0.6.png", image(center));
  await agent("edit", { ops: [
    { op: "update_layer", layer: "footage", properties: { x: -279 } },
    { op: "mark_subject", layer: "footage", t: 2.2, box: [40, 12, 17, 22] },
  ] });
  pictures.set("source-dragon@2.2.png", image(await agent("look", { mode: "source", layer: "footage", t: 2.2, width: 320 })));
  await agent("edit", { ops: [{ op: "update_layer", layer: "footage", properties: { x: 0, y: 164, width: 270, height: 152 } }] });
  pictures.set("sheet-shots.png", image(await agent("look", { mode: "sheet" })));
});
after(async () => { await server?.stop(); });

let failures = null;
async function saveFailure(name, actualPng, diffPng) {
  failures ??= process.env.KINO_GOLDEN_FAILURES
    ? await mkdir(process.env.KINO_GOLDEN_FAILURES, { recursive: true }).then(() => process.env.KINO_GOLDEN_FAILURES)
    : await mkdtemp(path.join(os.tmpdir(), "kino-look-source-golden-"));
  await writeFile(path.join(failures, name.replace(/\.png$/, ".actual.png")), actualPng);
  if (diffPng) await writeFile(path.join(failures, name.replace(/\.png$/, ".diff.png")), diffPng);
  return failures;
}

for (const name of ["source-center@0.6.png", "source-dragon@2.2.png", "sheet-shots.png"]) {
  test(`golden look ${name}`, { skip, timeout: 120_000 }, async () => {
    const actualPng = pictures.get(name);
    assert.ok(actualPng, `the look for ${name} was made`);
    const golden = path.join(DIRECTORY, name);
    if (UPDATE) {
      await mkdir(DIRECTORY, { recursive: true });
      await writeFile(golden, actualPng);
      return;
    }
    if (!existsSync(golden)) assert.fail(`Missing golden tests/golden/look-source/${name}. Run this file with KINO_GOLDEN_UPDATE=1, check the new PNG, and commit it.`);
    const expected = await decodePng(await readFile(golden));
    const actual = await decodePng(actualPng);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      const folder = await saveFailure(name, actualPng, null);
      assert.fail(`${name}: drawn ${actual.width}x${actual.height}, golden is ${expected.width}x${expected.height}. Actual saved in ${folder}`);
    }
    const { mismatched, diff } = comparePixels(expected, actual);
    const ratio = mismatched / (expected.width * expected.height);
    const block = worstBlock(expected, actual);
    if (ratio > MAX_MISMATCH_RATIO || block > MAX_BLOCK_MISMATCH) {
      const folder = await saveFailure(name, actualPng, await encodePng(expected.width, expected.height, diff));
      assert.fail(`${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (allowed ${MAX_MISMATCH_RATIO * 100}%), at most ${block} in one 16×16 block (allowed ${MAX_BLOCK_MISMATCH}). Actual and diff (red = different) saved in ${folder}. If the change is intended, run with KINO_GOLDEN_UPDATE=1 and commit the new PNGs.`);
    }
  });
}

test("one wrong digit in a look's label fails the comparison, though under 0.1% of its pixels differ", { skip }, async () => {
  const golden = await readFile(path.join(DIRECTORY, "source-center@0.6.png"));
  const expected = await decodePng(golden);
  // The header's last character ("… shot 1 of 3") painted over and drawn again as a 2.
  const header = await decodePng(golden);
  const canvas = createCanvas(header.width, header.height);
  const context = canvas.getContext("2d");
  context.putImageData(header, 0, 0);
  let right = 0;
  for (let x = 0; x < header.width; x += 1) for (let y = 8; y < 26; y += 1) if (header.data[(y * header.width + x) * 4] > 128) right = x;
  context.fillStyle = "#101114";
  context.fillRect(right - 7, 8, 9, 18);
  context.font = "12px sans-serif";
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText("2", right - 6, 16);
  const changed = context.getImageData(0, 0, header.width, header.height);
  const { mismatched } = comparePixels(expected, changed);
  assert.ok(mismatched > 0 && mismatched / (expected.width * expected.height) <= MAX_MISMATCH_RATIO, `${mismatched} pixels differ: under 0.1%, so the ratio alone passes it`);
  assert.ok(worstBlock(expected, changed) > MAX_BLOCK_MISMATCH, `the block rule fails it (${worstBlock(expected, changed)} in one block)`);
  assert.equal(worstBlock(expected, expected), 0);
});

test("a failed look's PNGs go to KINO_GOLDEN_FAILURES, which CI uploads", async () => {
  const before = process.env.KINO_GOLDEN_FAILURES;
  const folder = await mkdtemp(path.join(os.tmpdir(), "kino-look-source-failures-"));
  const kept = failures;
  process.env.KINO_GOLDEN_FAILURES = path.join(folder, "golden-failures");
  failures = null;
  try {
    assert.equal(await saveFailure("probe.png", Buffer.from("actual"), Buffer.from("diff")), process.env.KINO_GOLDEN_FAILURES);
    assert.deepEqual((await readdir(process.env.KINO_GOLDEN_FAILURES)).sort(), ["probe.actual.png", "probe.diff.png"]);
  } finally {
    failures = kept;
    if (before === undefined) delete process.env.KINO_GOLDEN_FAILURES;
    else process.env.KINO_GOLDEN_FAILURES = before;
    await rm(folder, { recursive: true, force: true });
  }
});

test("docs/testing.md counts these goldens with the scenes' and says how to update them", async () => {
  const guide = await readFile(fileURLToPath(new URL("../docs/testing.md", import.meta.url)), "utf8");
  const pngs = async (folder) => (await readdir(fileURLToPath(new URL(folder, import.meta.url)))).filter((name) => name.endsWith(".png")).length;
  // The looks: these and look board's (tests/look-board-frames.test.mjs).
  const [scenes, looks] = [await pngs("./golden/frames/"), (await pngs("./golden/look-source/")) + (await pngs("./golden/look-board/"))];
  assert.ok(guide.replace(/\s+/g, " ").includes(`\`npm test\` includes ${scenes + looks} golden frames: ${scenes} scenes`), `docs/testing.md says ${scenes + looks} golden frames`);
  assert.ok(guide.includes("KINO_GOLDEN_UPDATE=1 node --test tests/look-source-frames.test.mjs"));
});
