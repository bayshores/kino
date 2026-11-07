// Golden frames for look {mode:"board"}: the whole agent path (a real server, the board op, look
// board) against stored PNGs in tests/golden/look-board/. Both boards are the storyboard
// reference's own examples (skills/kino/references/storyboard.md), run as written:
//   board-sintel.png   "Storyboard: a board from footage" on a 1080 × 1920 4.4 s project: three
//                      rows (1092 × 819) of the Sintel test clip (credited in
//                      tests/fixtures/footage/SOURCES.md), each with the source frame at its
//                      in-point, the crop, the agent's box (and on shot 1 the eye line), the
//                      cropped still with its text and the app's covered areas, and the numbers
//   board-motion.png   its first Examples board on a 1920 × 1080 6 s project: two cards with no
//                      footage (1092 × 546), the still on the main scene's background
// Besides 0.1% of pixels in all, no 16×16 block may have more than 8 different pixels
// (worstBlock), so a wrong digit or word in a label fails. When the reference's boards or the
// drawing change on purpose, run this file with KINO_GOLDEN_UPDATE=1, look at the new PNGs, and
// commit them with the change (docs/testing.md). A failed look's actual and diff PNGs go to
// KINO_GOLDEN_FAILURES when it is set (CI keeps that folder), as golden-frames does.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_BLOCK_MISMATCH, MAX_MISMATCH_RATIO, comparePixels, decodePng, encodePng, worstBlock } from "./golden/compare.mjs";
import { hasMediaTools } from "./golden/media.mjs";
import { startTestServer } from "../backend/media.test.support.mjs";
import { jsonBlocks } from "../backend/skill.test.support.mjs";

const DIRECTORY = fileURLToPath(new URL("./golden/look-board/", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const REFERENCE = fileURLToPath(new URL("../skills/kino/references/storyboard.md", import.meta.url));
const UPDATE = process.env.KINO_GOLDEN_UPDATE === "1";
const skip = hasMediaTools ? false : "FFmpeg and ffprobe are required to import the test clip";

let server;
// The two looks (each name: its PNG).
const pictures = new Map();

async function agent(verb, body) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  const reply = await response.json();
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

// The ```json calls under a `## ` heading of the storyboard reference ("Examples" is a heading in
// several references, so this reads the one file).
async function referenceCalls(heading) {
  const lines = (await readFile(REFERENCE, "utf8")).split("\n");
  const start = lines.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `storyboard.md has a "## ${heading}" section`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return jsonBlocks(lines.slice(start, end < 0 ? undefined : end).join("\n"))[0];
}

// Runs a reference's calls on a new project and keeps the PNG of its look board.
async function boardLook(project, size, calls) {
  await agent("project", { action: "create", id: project, name: project, duration: size.duration, width: size.width, height: size.height, background: size.background });
  let look = null;
  for (const { tool, ...input } of calls) {
    const reply = await agent(tool, { project, ...input });
    if (tool === "look") look = reply;
  }
  assert.ok(look, "the calls end with a look");
  return Buffer.from(look.images[0].data, "base64");
}

before(async () => {
  if (skip) return;
  server = await startTestServer();
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "sintel-village-dragon.mp4" }, body: await readFile(CLIP) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const clip = await upload.json();
  const footage = JSON.parse(JSON.stringify(await referenceCalls("Storyboard: a board from footage")).replaceAll("/api/media/<clip>.mp4", clip.src));
  pictures.set("board-sintel.png", await boardLook("sintel", { width: 1080, height: 1920, duration: 4.4, background: "#000000" }, footage));
  // The Examples block ends with a board refused on purpose (expect op_failed): only the first
  // board and its look are drawn.
  const examples = (await referenceCalls("Examples")).filter((call) => !call.expect);
  pictures.set("board-motion.png", await boardLook("motion", { width: 1920, height: 1080, duration: 6, background: "#1d2b44" }, examples));
});
after(async () => { await server?.stop(); });

let failures = null;
async function saveFailure(name, actualPng, diffPng) {
  failures ??= process.env.KINO_GOLDEN_FAILURES
    ? await mkdir(process.env.KINO_GOLDEN_FAILURES, { recursive: true }).then(() => process.env.KINO_GOLDEN_FAILURES)
    : await mkdtemp(path.join(os.tmpdir(), "kino-look-board-golden-"));
  await writeFile(path.join(failures, name.replace(/\.png$/, ".actual.png")), actualPng);
  if (diffPng) await writeFile(path.join(failures, name.replace(/\.png$/, ".diff.png")), diffPng);
  return failures;
}

for (const [name, size] of [["board-sintel.png", [1092, 819]], ["board-motion.png", [1092, 546]]]) {
  test(`golden look ${name}`, { skip, timeout: 120_000 }, async () => {
    const actualPng = pictures.get(name);
    assert.ok(actualPng, `the look for ${name} was made`);
    const actual = await decodePng(actualPng);
    assert.deepEqual([actual.width, actual.height], size, `${name} is ${size.join(" × ")}: a 273 px row per shot`);
    const golden = path.join(DIRECTORY, name);
    if (UPDATE) {
      await mkdir(DIRECTORY, { recursive: true });
      await writeFile(golden, actualPng);
      return;
    }
    if (!existsSync(golden)) assert.fail(`Missing golden tests/golden/look-board/${name}. Run this file with KINO_GOLDEN_UPDATE=1, check the new PNG, and commit it.`);
    const expected = await decodePng(await readFile(golden));
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

test("docs/testing.md counts these goldens with the scenes' and the source looks', and says how to update them", async () => {
  const guide = await readFile(fileURLToPath(new URL("../docs/testing.md", import.meta.url)), "utf8");
  const pngs = async (folder) => (await readdir(fileURLToPath(new URL(folder, import.meta.url)))).filter((name) => name.endsWith(".png")).length;
  const [scenes, sources, boards] = [await pngs("./golden/frames/"), await pngs("./golden/look-source/"), await pngs("./golden/look-board/")];
  assert.equal(boards, 2);
  assert.ok(guide.replace(/\s+/g, " ").includes(`\`npm test\` includes ${scenes + sources + boards} golden frames: ${scenes} scenes`), `docs/testing.md says ${scenes + sources + boards} golden frames`);
  assert.ok(guide.includes("KINO_GOLDEN_UPDATE=1 node --test tests/look-board-frames.test.mjs"));
});
