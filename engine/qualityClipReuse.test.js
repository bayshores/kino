// clip_reuse (engine/quality/rules/footage.js): one clip cut back to 4 times, or over 35% of the
// video, once 4 or more clips fill the frame.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";

const clip = (id, src, at, until) => createLayer("video", { id, name: id, src: `/api/media/${src}.mp4`, mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080,
  animations: [{ id: `${id}.1`, name: "show", kind: "show", start: at }, { id: `${id}.2`, name: "hide", kind: "hide", start: until }] });
// Shots of 2 s in order; each letter is a file.
const cut = (files) => parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: files.length * 2, background: "#000000",
  layers: [...files].map((file, index) => clip(`shot-${index + 1}`, file, index * 2, index * 2 + 2)) })] }));
const run = async (document) => (await runQuality(kinoTimeline(document, "scene", { fonts: defaultFonts }), { codes: ["clip_reuse"], pixels: false, context: {} })).findings;

test("clip_reuse: one clip returning 4 times warns; 3 returns is a motif", async () => {
  const [finding] = await run(cut("ABRCRDRERFGHIJ"));
  assert.equal(finding?.rule, "clip_reuse");
  assert.match(finding.measured, /^R\.mp4 \(shot-3, shot-5, shot-7\) fills the frame 4 times \(4s, 8s, 12s, 16s\), 29% of the video$/);
  assert.deepEqual(await run(cut("ABRCRDRFG")), []);
});

test("clip_reuse: over 35% of the video warns; with fewer than 4 clips there is nothing else to cut to", async () => {
  const [long] = await run(cut("RRRRABCDE"));
  assert.match(long?.measured ?? "", /fills the frame once \(0s\), 44% of the video$/);
  assert.deepEqual(await run(cut("ABRARBRAR")), []);
});
