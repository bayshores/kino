// A Speed animation's sound on a long clip (backend/sound-remap.mjs). The ramp's part of the file
// used to be read whole, at most 16,777,216 samples per channel, so a part longer than 349 s was
// read below 48 kHz and lost its high sounds (a 600 s part was read at about 28 kHz: nothing
// above 14 kHz was left). Now the file is read a stretch at a time, at its own rate, so a part of
// any length keeps every sound the file has.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { sceneSoundClips } from "./export.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const RATE = 48000;
const LEVEL = 0.125; // FFmpeg's sine source
let folder;

before(async () => {
  if (skipWithoutMediaTools) return;
  folder = await mkdtemp(path.join(tmpdir(), "kino-long-ramp-"));
  // 620 s of a 16 kHz tone: a high sound that only a full-rate read keeps.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=16000:sample_rate=${RATE}:duration=620`,
    "-c:a", "pcm_s16le", path.join(folder, "high.wav")]);
});
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

// The samples of a 32-bit float WAV made by sound-remap.mjs (its header is 44 bytes).
function floatSamples(buffer) {
  assert.equal(buffer.readUInt16LE(20), 3, "IEEE float");
  assert.equal(buffer.readUInt32LE(24), RATE, "at the file's own rate");
  const bytes = buffer.readUInt32LE(40);
  assert.equal(bytes, buffer.length - 44, "the header gives the size of the samples");
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset + 44, buffer.byteOffset + 44 + bytes));
}

function rms(samples, from, to) {
  let sum = 0;
  for (let at = Math.round(from * RATE); at < Math.round(to * RATE); at += 1) sum += samples[at] ** 2;
  return Math.sqrt(sum / (Math.round(to * RATE) - Math.round(from * RATE)));
}

function rampScene(reverse) {
  // Linear from 1× to 7× over 150 s: the clip plays 600 s of the file.
  const ramp = { id: "high.speed", name: "Speed", kind: "custom", start: 0, duration: 150, easing: "linear", from: { speed: 1 }, to: { speed: 7 } };
  const layer = createLayer("audio", { id: "high", name: "High", src: "/api/media/high.wav", mediaSourceDuration: 620, mediaReverse: reverse, animations: [ramp] });
  return createScene({ id: "long", name: "Long", width: 64, height: 36, duration: 150, background: "#000000", layers: [layer] });
}

async function rampSoundOf(reverse) {
  const directory = await mkdtemp(path.join(folder, "clips-"));
  const clips = await sceneSoundClips(rampScene(reverse), { mediaRoot: folder, directory, duration: 150 });
  assert.equal(clips.length, 1);
  return floatSamples(await readFile(clips[0].path));
}

for (const reverse of [false, true]) {
  test(`a ${reverse ? "reversed " : ""}Speed ramp over 600 s of a file keeps its high sounds and lasts exactly the clip`, { skip: skipWithoutMediaTools }, async () => {
    const samples = await rampSoundOf(reverse);
    assert.equal(samples.length, 150 * RATE, "150 s of mono sound at 48 kHz");
    // Near the start the speed is 1.02× to 1.06×: the 16 kHz tone plays at about 16.3–17 kHz, at
    // most a little quieter where samples are drawn between two file samples.
    const level = rms(samples, 0.5, 1.5);
    assert.ok(level > 0.5 * (LEVEL / Math.SQRT2), `the 16 kHz tone is heard (${level.toFixed(4)}; the file's is ${(LEVEL / Math.SQRT2).toFixed(4)})`);
    console.log(`# ${reverse ? "reversed " : ""}ramp: 16 kHz tone at ${(level / (LEVEL / Math.SQRT2)).toFixed(2)} of its level`);
  });
}

test("cancelling while a ramp's sound is made stops FFmpeg and answers that the export was cancelled", { skip: skipWithoutMediaTools }, async () => {
  const directory = await mkdtemp(path.join(folder, "cancel-"));
  const controller = new AbortController();
  const making = sceneSoundClips(rampScene(false), { mediaRoot: folder, directory, duration: 150, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(making, { name: "AbortError" });
});
