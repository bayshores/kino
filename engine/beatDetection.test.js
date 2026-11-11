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
  // Accents and weights compare a hit with the whole song, so a louder ending can change them.
  const early = (cues) => cues.filter((cue) => cue.time < SAME - 8 && cue.kind !== "accent").map((cue) => `${cue.name} ${cue.time}`);
  const base = cuesFor(track(LENGTH));
  const beats = base.filter((cue) => cue.kind === "beat");
  const plain = (cue) => cue && { name: cue.name, time: cue.time, kind: cue.kind };
  assert.deepEqual(plain(beats[0]), { name: "beat-1", time: FIRST, kind: "beat" });
  assert.equal(beats.length, Math.floor((LENGTH - FIRST) / PERIOD) + 1, "a beat on every kick");
  for (const [name, make] of Object.entries(endings)) {
    const other = cuesFor(make());
    assert.deepEqual(early(other), early(base), name);
    assert.deepEqual(plain(other.find((cue) => cue.kind === "beat")), plain(beats[0]), `${name}: the first kick is beat-1`);
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

test("kicks weigh more than hi-hats, the loud kick starts the bar, and accents are the top hit per section", () => {
  // 120 a minute: a kick on every beat, twice as loud on each bar's first beat, and a hi-hat
  // halfway between beats. The song starts on a bar's second beat (a pickup of three beats).
  const seconds = 24;
  const bar = (beat) => (beat + 1) % 4 === 0;
  const samples = new Float32Array(seconds * RATE);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE;
    const beat = Math.floor(t / PERIOD);
    const since = t - beat * PERIOD;
    const kick = (bar(beat) ? 0.8 : 0.4) * Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 25);
    const after = since - PERIOD / 2;
    const hat = after < 0 ? 0 : 0.12 * (noise(i) - noise(i - 1)) * Math.exp(-after * 80);
    samples[i] = 0.001 * noise(i + 5) + kick + hat;
  }
  const analysis = analyzeBeats(samples, RATE);
  assert.equal(analysis.bpm, 120);
  const near = (time, step) => Math.abs(time / step - Math.round(time / step)) * step < 0.02;
  const kicks = analysis.onsets.filter((onset) => near(onset.time, PERIOD));
  const hats = analysis.onsets.filter((onset) => !near(onset.time, PERIOD) && near(onset.time - PERIOD / 2, PERIOD));
  assert.ok(kicks.length >= 44 && hats.length >= 40, `${kicks.length} kicks, ${hats.length} hats`);
  assert.ok(kicks.every((onset) => onset.band === "low"), "every kick is low");
  assert.ok(hats.every((onset) => onset.band === "high"), "every hat is high");
  assert.ok(Math.max(...hats.map((onset) => onset.weight)) < 0.3, "hats weigh little");
  const loud = kicks.filter((onset) => bar(Math.round(onset.time / PERIOD)));
  assert.ok(loud.every((onset) => onset.weight >= 0.9) && kicks.filter((onset) => !loud.includes(onset)).every((onset) => onset.weight > 0.3 && onset.weight < 0.7));

  const cues = cuesFor(samples);
  const heads = cues.filter((cue) => cue.kind === "beat" && cue.downbeat).map((cue) => cue.time);
  assert.deepEqual(heads.slice(0, 3), [1.5, 3.5, 5.5], "the loud kick starts each bar");
  // 12 bars: a phrase of 8 (with the pickup) keeps 2 accents, the last 4 bars keep 1.
  const accents = cues.filter((cue) => cue.kind === "accent");
  assert.equal(accents.length, 3);
  for (const accent of accents) {
    assert.ok(heads.some((time) => Math.abs(time - accent.time) < 0.02), `${accent.name} at ${accent.time} is on a bar's loud kick`);
    assert.equal(accent.band, "low");
    assert.ok(accent.weight >= 0.9);
  }
  assert.deepEqual(accents.map((cue) => cue.rank), [1, 2, 1]);
  assert.ok(cues.filter((cue) => cue.kind === "onset").every((cue) => typeof cue.weight === "number" && cue.band));
});

test("a kick with overtones is labeled low, and a lone hi-hat is labeled high", () => {
  // A 55 Hz kick with 40 overtones, each weaker (1/k): 85% of its energy is under 150 Hz. Summing
  // each band's magnitude gain over its bins let the 109 mid bins outvote the 7 low ones, so every
  // one of these kicks came out mid. The band follows where the new sound energy is.
  const deep = new Float32Array(LENGTH * RATE);
  for (let i = 0; i < deep.length; i += 1) {
    const since = ((i / RATE) - FIRST) % PERIOD;
    let tone = 0;
    for (let k = 1; k <= 40; k += 1) tone += Math.sin(2 * Math.PI * 55 * k * since) / k;
    deep[i] = 0.002 * noise(i) + (i / RATE < FIRST ? 0 : 0.4 * tone * Math.exp(-since * 25));
  }
  const kicks = analyzeBeats(deep, RATE).onsets.filter((onset) => onset.time > 1);
  assert.ok(kicks.length >= 40, `${kicks.length} kicks`);
  assert.deepEqual([...new Set(kicks.map((onset) => onset.band))], ["low"]);
  const hats = new Float32Array(LENGTH * RATE);
  for (let i = 0; i < hats.length; i += 1) hats[i] = 0.3 * (noise(i) - noise(i - 1)) * Math.exp(-((i / RATE) % PERIOD) * 80);
  const hit = analyzeBeats(hats, RATE).onsets;
  assert.ok(hit.length >= 20, `${hit.length} hats`);
  assert.deepEqual([...new Set(hit.map((onset) => onset.band))], ["high"]);
});

test("a louder kick over a steady pad weighs more than a quiet kick alone, and gets the accents", () => {
  // 12 s of kicks alone, then 12 s of kicks twice as loud over a steady pad (220 and 330 Hz). A
  // weight from loudness after minus loudness before shrank the drop's kicks under the pad, so
  // the accents went to the quiet half. Under the pad an onset can come out up to 35 ms late.
  const DROP = 12;
  const samples = new Float32Array(LENGTH * RATE);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE;
    const since = t % PERIOD;
    const loud = t >= DROP;
    const kick = (loud ? 0.8 : 0.4) * Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 25);
    const pad = loud ? 0.2 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t)) : 0;
    samples[i] = 0.001 * noise(i) + kick + pad;
  }
  const analysis = analyzeBeats(samples, RATE);
  const kicks = analysis.onsets.filter((onset) => Math.abs(onset.time / PERIOD - Math.round(onset.time / PERIOD)) * PERIOD < 0.04);
  const mean = (list) => list.reduce((sum, onset) => sum + onset.weight, 0) / list.length;
  const quiet = kicks.filter((onset) => onset.time < DROP - 0.1);
  const drop = kicks.filter((onset) => onset.time > DROP + 0.1);
  assert.ok(quiet.length >= 20 && drop.length >= 20, `${quiet.length} quiet kicks, ${drop.length} drop kicks`);
  assert.ok(mean(drop) > mean(quiet) * 1.5, `drop ${mean(drop)}, quiet ${mean(quiet)}`);
  assert.ok(Math.min(...drop.map((onset) => onset.weight)) > Math.max(...quiet.map((onset) => onset.weight)), "every drop kick outweighs every quiet kick");
  // Phrases of 8 bars: the first (0 to 16 s) keeps 2 accents, the second 1; all three are drop kicks.
  const accents = cuesFor(samples).filter((cue) => cue.kind === "accent");
  assert.equal(accents.length, 3);
  assert.ok(accents.every((cue) => cue.time > DROP), accents.map((cue) => cue.time).join(", "));
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
