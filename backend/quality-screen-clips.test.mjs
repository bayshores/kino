// screen_unreadable on videos: the checker reads a video's frame facts from its media record, asks
// videoFacts once for a record measured before kino read them, and flags clips kino recorded.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultFonts } from "../engine/fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createQualityChecker } from "./agent/quality.mjs";

const ID = "0f0f0f0f-1111-2222-3333-444444444444.mp4";
const clip = (width) => parseDocument(createDocument({ scenes: [createScene({ id: "s", name: "s", width: 1920, height: 1080, duration: 4,
  layers: [createLayer("video", { id: "rec", name: "rec", src: `/api/media/${ID}`, mediaSourceDuration: 10, x: 0, y: 0, width, height: width * 0.6 })] })] }));
const unreadable = (result) => JSON.stringify(result).includes("screen_unreadable");

test("an old video record gets its frame facts once; a clip kino recorded needs none", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-screen-clips-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const record = { id: ID, src: `/api/media/${ID}`, name: "dash.mp4", mime: "video/mp4", width: 2560, height: 1536, duration: 10, hasVideo: true };
  await writeFile(path.join(mediaRoot, `${ID}.json`), JSON.stringify(record));
  let asked = 0;
  const videoFacts = async () => { asked += 1; return { edges: 0.12, flat: 0.6, busy: [0, 60, 40, 40] }; };
  const checker = createQualityChecker({ mediaRoot, videoFacts });
  assert.ok(unreadable(await checker.check(clip(1920), { fonts: defaultFonts, pixels: false })));
  assert.ok(!unreadable(await checker.check(clip(2800), { fonts: defaultFonts, pixels: false })));
  assert.equal(asked, 1);

  // Recorded by kino: 1512 points drawn 1920 wide; no frame facts asked for.
  await writeFile(path.join(mediaRoot, `${ID}.json`), JSON.stringify({ ...record, width: 1920, height: 1152, recording: { frame: [1512, 907] } }));
  const recorded = createQualityChecker({ mediaRoot, videoFacts });
  assert.ok(unreadable(await recorded.check(clip(1920), { fonts: defaultFonts, pixels: false })));
  assert.equal(asked, 1);
});
