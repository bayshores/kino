// Where a beat sits depends on the sound near it, not on how the file ends: two kick tracks with
// the same opening give the same first beat cues when the rest is louder, cut shorter or silent
// (an ending in another tempo still moves them; see step 4 in beatDetection.js). The tracks are
// made here, sample by sample. Real files decoded by FFmpeg are tested in server/audio-analysis.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBeats } from "./beatDetection.js";
import { createDocument, createLayer, createScene } from "./model.js";
import { applyOperations } from "./operations.js";

const RATE = 22050;
const FIRST = 0.25;
const PERIOD = 0.5; // 120 a minute
const SAME = 16; // the tracks are the same for this many seconds
const LENGTH = 24;
const INTRO = 2.2; // the kicks before this are softer, as in a song's intro

// The same "random" value for the same sample in every track, from -0.5 to 0.5.
const noise = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

// A kick (a low thump with a click on top) on every beat from FIRST, over a little hiss. The
// first four kicks are played at a fifth of the volume.
function kick(t, i) {
  const hiss = 0.002 * noise(i);
  if (t < FIRST) return hiss;
  const since = (t - FIRST) % PERIOD;
  const volume = t < INTRO ? 0.2 : 1;
  return hiss + volume * (0.4 * Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 25) + 0.15 * Math.sin(2 * Math.PI * 1500 * since) * Math.exp(-since * 60));
}

// `seconds` of sound: the kick track until SAME, then `ending` (the kick track when left out).
function track(seconds, ending = kick) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i / RATE < SAME ? kick : ending)(i / RATE, i);
  return samples;
}

const endings = {
  // Every beat from SAME on also has a loud crash, much louder than anything before it.
  "a much louder ending": () => track(LENGTH, (t, i) => kick(t, i) + 0.9 * noise(i + 7) * Math.exp(-((t - FIRST) % PERIOD) * 8)),
  // The file stops a second after SAME.
  "a file cut shorter": () => track(SAME + 1),
  // Silence after SAME, then one big boom.
  "silence and a boom": () => track(LENGTH, (t, i) => (t > 20 ? 0.9 * noise(i) * Math.exp(-(t - 20) * 3) : 0)),
};

// The beat and onset cues detect_beats writes for this sound, playing from 0 s.
function cuesFor(samples) {
  const music = createLayer("audio", { id: "music", name: "music", src: "/api/media/0b8e3f8e-1111-4222-8333-444455556666.wav", mediaDuration: LENGTH });
  const document = createDocument({ scenes: [createScene({ id: "s1", duration: LENGTH, layers: [music] })] });
  const analysis = analyzeBeats(samples, RATE);
  return applyOperations(document, [{ type: "detect_beats", sceneId: "s1", layerId: "music", analysis }]).cues;
}

test("tracks with the same opening and different endings give the same early beat and onset cues", () => {
  // A beat depends on the onsets within 4 s of it, and their strength on the sound within 4 s of
  // them. When strength was measured against the loudest moment in the file, the louder ending
  // made the soft intro kicks too weak to be beats, and beat-1 moved from 0.25 s to 2.25 s.
  const early = (cues) => cues.filter((cue) => cue.time < SAME - 8).map((cue) => `${cue.name} ${cue.time}`);
  const base = cuesFor(track(LENGTH));
  const beats = base.filter((cue) => cue.kind === "beat");
  assert.deepEqual(beats[0], { name: "beat-1", time: FIRST, kind: "beat" });
  assert.equal(beats.length, Math.floor((LENGTH - FIRST) / PERIOD) + 1, "a beat on every kick");
  for (const [name, make] of Object.entries(endings)) {
    const other = cuesFor(make());
    assert.deepEqual(early(other), early(base), name);
    assert.deepEqual(other.find((cue) => cue.kind === "beat"), beats[0], `${name}: the first kick is beat-1`);
  }
});

test("a backbeat with the kick on beats 1 and 3 and the clap on 2 and 4 is read at its full tempo", () => {
  // The kick alone repeats at 65. The tempo bands count the clap as much as the kick, so the beat
  // is 130; the slower octave may be reported as alt.
  const period = 60 / 130;
  const samples = new Float32Array(30 * RATE);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE;
    const beat = Math.floor(t / period);
    const since = t - beat * period;
    const kick = beat % 2 === 0 ? 0.6 * Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 20) : 0;
    const clap = beat % 2 === 1 ? 0.5 * noise(i) * Math.exp(-since * 30) : 0;
    const hat = 0.08 * noise(i + 3) * Math.exp(-((t % (period / 2)) * 80));
    samples[i] = kick + clap + hat;
  }
  const analysis = analyzeBeats(samples, RATE);
  assert.ok(Math.abs(analysis.bpm - 130) < 1, `found ${analysis.bpm}`);
  assert.ok(analysis.alt === null || Math.abs(analysis.alt - 65) < 1, `alt ${analysis.alt}`);
});

test("a long, steady song keeps every beat on its kick to the end", () => {
  // The tempo from the onset curve can be off by half a millisecond a beat; fitting the grid to
  // the whole song at once then put it between the kicks for much of a 150 s song at these
  // tempos (and of a ten-minute one at 123.4). The grid is fitted a stretch at a time now.
  for (const bpm of [162.9, 174]) {
    const period = 60 / bpm;
    const seconds = 150;
    const samples = new Float32Array(seconds * RATE);
    for (let i = 0; i < samples.length; i += 1) {
      const t = i / RATE;
      const since = t < FIRST ? -1 : (t - FIRST) % period;
      samples[i] = 0.002 * noise(i) + (since < 0 ? 0 : 0.4 * Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 25) + 0.15 * Math.sin(2 * Math.PI * 1500 * since) * Math.exp(-since * 60));
    }
    const analysis = analyzeBeats(samples, RATE);
    assert.equal(analysis.bpm, bpm, `${bpm}: found ${analysis.bpm}`);
    assert.equal(analysis.beats.length, Math.floor((seconds - FIRST) / period) + 1, `${bpm}: a beat on every kick`);
    const worst = Math.max(...analysis.beats.map((beat) => Math.abs(beat - (FIRST + Math.round((beat - FIRST) / period) * period))));
    assert.ok(worst < 0.001, `${bpm}: every beat within 1 ms of its kick (worst ${(worst * 1000).toFixed(2)} ms)`);
    assert.equal(analysis.confidence, 1);
  }
});
