import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSoundBandsCache, soundLevelsFor } from "./sound-bands.mjs";
import { AUDIO_LEVELS_VERSION } from "../engine/audioLevels.js";

test("soundLevelsFor measures only the sounds audio behaviors name, once per file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kino-bands-"));
  try {
    const id = "0a1b2c3d-1111-2222-3333-444455556666.mp3";
    await writeFile(path.join(root, id), "sound");
    let measured = 0;
    const cache = createSoundBandsCache({ measure: async () => { measured += 1; return { version: AUDIO_LEVELS_VERSION, rate: 30, all: [0, 1], low: [0], mid: [0], high: [0] }; } });
    const document = { scenes: [{ layers: [{ id: "m", name: "Music", type: "audio", src: `/api/media/${id}` }, { id: "v", name: "Clip", type: "video", src: "/api/media/other" }] }] };
    assert.equal(await soundLevelsFor(document, [{ type: "add_animation", animation: {} }], { mediaRoot: root, cache }), undefined);
    const ops = [{ type: "add_animation", animation: { behavior: { audio: { layer: "Music", amount: 1 } } } }];
    const levels = await soundLevelsFor(document, ops, { mediaRoot: root, cache });
    assert.deepEqual([...levels.keys()], [`/api/media/${id}`]);
    await soundLevelsFor(document, ops, { mediaRoot: root, cache });
    assert.equal(measured, 1, "kept beside the file");
    assert.equal(JSON.parse(await readFile(path.join(root, `${id}.bands`), "utf8")).rate, 30);
  } finally { await rm(root, { recursive: true, force: true }); }
});
