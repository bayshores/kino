// Beat detection on real audio files made with FFmpeg: click tracks at several tempos and file
// formats, and a kick-and-hi-hat loop. Gate: every beat within 20 ms of the true click, the tempo
// within 1 beat a minute.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { analyzeAudioFile, createBeatAnalysisCache, soundIsMusic } from "./audio-analysis.mjs";
import { ffmpeg, makeVideo, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const FIRST_CLICK = 0.437;
const TOLERANCE = 0.02;
let folder;

before(async () => { folder = await mkdtemp(path.join(tmpdir(), "kino-beats-")); });
after(() => rm(folder, { recursive: true, force: true }));

// A 1.5 kHz click every 60/bpm seconds from `first`, with a little noise (and `under` added,
// a sound that plays under the clicks), as `file`.
async function clickTrack(bpm, file, { rate = 48000, codec = [], first = FIRST_CLICK, level = 1, under = "" } = {}) {
  const period = (60 / bpm).toFixed(9);
  const click = `${level}*if(gte(t,${first}),sin(2*PI*1500*mod(t-${first},${period}))*exp(-mod(t-${first},${period})*60),0)+0.003*(random(0)-0.5)${under}`;
  const target = path.join(folder, file);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${click}':s=${rate}:d=20`, ...codec, target]);
  return target;
}

// The largest distance from a found beat to the nearest true click, in seconds.
function worstError(beats, bpm, first = FIRST_CLICK) {
  const period = 60 / bpm;
  return Math.max(...beats.map((beat) => Math.abs(beat - (first + Math.round((beat - first) / period) * period))));
}

const TRACKS = [
  { bpm: 70, file: "click70.wav" },
  { bpm: 90, file: "click90.mp3", codec: ["-c:a", "libmp3lame", "-b:a", "192k"] },
  { bpm: 128, file: "click128.m4a", codec: ["-c:a", "aac", "-b:a", "160k"], rate: 44100 },
  { bpm: 140, file: "click140.mp3", codec: ["-c:a", "libmp3lame", "-b:a", "192k"], rate: 44100 },
  { bpm: 160, file: "click160.wav", rate: 44100 },
  { bpm: 200, file: "click200.mp3", codec: ["-c:a", "libmp3lame", "-b:a", "192k"] },
];

for (const track of TRACKS) {
  test(`a ${track.bpm} BPM click track (${path.extname(track.file).slice(1)}) gives every beat within 20 ms`, { skip: skipWithoutMediaTools }, async (t) => {
    const result = await analyzeAudioFile(await clickTrack(track.bpm, track.file, track));
    t.diagnostic(`${result.bpm} BPM, ${result.beats.length} beats, worst ${(worstError(result.beats, track.bpm) * 1000).toFixed(1)} ms, confidence ${result.confidence}`);
    assert.ok(Math.abs(result.bpm - track.bpm) <= 1, `found ${result.bpm} BPM`);
    assert.ok(result.confidence >= 0.9, `confidence ${result.confidence}`);
    const clicks = Math.floor((20 - FIRST_CLICK) / (60 / track.bpm)) + 1;
    assert.ok(result.beats.length >= clicks - 2, `${result.beats.length} beats of ${clicks} clicks`);
    assert.ok(Math.abs(result.beats[0] - FIRST_CLICK) <= TOLERANCE, `first beat at ${result.beats[0]}`);
    const worst = worstError(result.beats, track.bpm);
    assert.ok(worst <= TOLERANCE, `worst beat is ${(worst * 1000).toFixed(1)} ms off`);
  });
}

test("a click right at the start of the file is the first beat", { skip: skipWithoutMediaTools }, async (t) => {
  // The last one has hiss under the clicks too.
  for (const [first, under] of [[0, ""], [0.01, ""], [0, "+0.03*(random(0)-0.5)"]]) {
    const result = await analyzeAudioFile(await clickTrack(120, `start-${first}-${under.length}.wav`, { first, under }));
    t.diagnostic(`first click at ${first}s: ${result.bpm} BPM, ${result.beats.length} beats from ${result.beats[0]}`);
    assert.ok(Math.abs(result.bpm - 120) <= 1, `found ${result.bpm} BPM`);
    assert.ok(Math.abs(result.beats[0] - first) <= TOLERANCE, `first beat at ${result.beats[0]}, the first click at ${first}`);
    assert.ok(result.beats.length >= 39, `${result.beats.length} beats of 40 clicks`);
    assert.ok(worstError(result.beats, 120, first) <= TOLERANCE);
  }
});

test("hiss from the start of the file is not a hit: no onset or beat before the music", { skip: skipWithoutMediaTools }, async (t) => {
  for (const [first, hiss] of [[1, 0.03], [0.25, 0.003]]) {
    const file = await clickTrack(120, `hiss-${hiss}-then-${first}.wav`, { first, under: `+${hiss}*(random(0)-0.5)` });
    const result = await analyzeAudioFile(file);
    t.diagnostic(`hiss ${hiss}, first click at ${first}s: ${result.bpm} BPM, ${result.beats.length} beats from ${result.beats[0]}, first onset at ${result.onsets[0].time}`);
    assert.ok(Math.abs(result.bpm - 120) <= 0.05, `found ${result.bpm} BPM`);
    assert.ok(Math.abs(result.beats[0] - first) <= 0.002, `first beat at ${result.beats[0]}, the first click at ${first}`);
    assert.ok(result.onsets[0].time >= first - 0.002, `an onset at ${result.onsets[0].time}, before the first click at ${first}`);
    assert.ok(worstError(result.beats, 120, first) <= 0.002, `worst beat is ${(worstError(result.beats, 120, first) * 1000).toFixed(1)} ms off`);
  }
});

test("a loud sound already playing when the file starts does not hide the beat", { skip: skipWithoutMediaTools }, async () => {
  const file = await clickTrack(174, "click174-over-tone.wav", { rate: 22050, first: 0.3, level: 0.5, under: "+0.1*(random(0)-0.5)+0.5*sin(2*PI*200*t)" });
  const result = await analyzeAudioFile(file);
  assert.ok(Math.abs(result.bpm - 174) <= 1, `found ${result.bpm} BPM`);
  assert.ok(Math.abs(result.beats[0] - 0.3) <= TOLERANCE, `first beat at ${result.beats[0]}`);
  assert.ok(result.beats.length >= 55, `${result.beats.length} beats`);
  assert.ok(worstError(result.beats, 174, 0.3) <= TOLERANCE);
});

test("in a kick and hi-hat loop the beat follows the kick, not the hats between", { skip: skipWithoutMediaTools }, async (t) => {
  const kick = `0.8*sin(2*PI*55*mod(t-${FIRST_CLICK},0.5))*exp(-mod(t-${FIRST_CLICK},0.5)*25)*gte(t,${FIRST_CLICK})`;
  const hats = `0.25*(random(0)-0.5)*exp(-mod(t-${FIRST_CLICK}-0.25,0.5)*80)*gte(t,${FIRST_CLICK}+0.25)`;
  const target = path.join(folder, "loop120.m4a");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${kick} + ${hats} + 0.15*sin(2*PI*110*t)':s=44100:d=20`, "-c:a", "aac", "-b:a", "160k", target]);
  const result = await analyzeAudioFile(target);
  t.diagnostic(`${result.bpm} BPM, ${result.beats.length} beats, worst ${(worstError(result.beats, 120) * 1000).toFixed(1)} ms`);
  assert.ok(Math.abs(result.bpm - 120) <= 1, `found ${result.bpm} BPM`);
  assert.ok(worstError(result.beats, 120) <= TOLERANCE, `worst beat is ${(worstError(result.beats, 120) * 1000).toFixed(1)} ms off`);
});

test("each file is analysed once; the result is kept beside it in a .beats file", { skip: skipWithoutMediaTools }, async () => {
  const file = await clickTrack(120, "cached.wav");
  let analysed = 0;
  const cache = createBeatAnalysisCache({ analyze: (name) => { analysed += 1; return analyzeAudioFile(name); } });
  const [first, second] = await Promise.all([cache.get(file), cache.get(file)]);
  assert.equal(analysed, 1);
  assert.deepEqual(first, second);
  const saved = JSON.parse(await readFile(`${file}.beats`, "utf8"));
  assert.equal(saved.bpm, first.bpm);
  const again = await createBeatAnalysisCache({ analyze: () => { throw new Error("should read the .beats file"); } }).get(file);
  assert.deepEqual(again.beats, first.beats);
});

test("a file without sound is refused with a plain reason", { skip: skipWithoutMediaTools }, async () => {
  const silent = await makeVideo(path.join(folder, "silent.mp4"), { fps: 10, frames: 5, frameColor: () => [20, 20, 20] });
  await assert.rejects(analyzeAudioFile(silent), /The file has no sound\./);
  const quiet = path.join(folder, "quiet.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "3", quiet]);
  const result = await analyzeAudioFile(quiet);
  assert.equal(result.bpm, null);
  assert.match(result.note, /No onsets/);
});

test("music is never sent to whisper: a layer named music, or one with a steady beat, is music", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-music-"));
  try {
    const analyzed = [];
    const beats = (answer) => ({ get: async (file) => { analyzed.push(file); return answer; } });
    const song = path.join(folder, "song.mp3");
    const voice = path.join(folder, "voice.m4a");
    // Named as music: no analysis at all.
    assert.equal(await soundIsMusic({ type: "audio", name: "Music bed" }, song, { listen: true, beats: beats(null) }), true);
    assert.deepEqual(analyzed, []);
    // A quick check (no listen) never analyzes; a full check analyzes an audio layer once.
    assert.equal(await soundIsMusic({ type: "audio", name: "track 2" }, song, { beats: beats({ bpm: 125, confidence: 0.9 }) }), false);
    assert.equal(await soundIsMusic({ type: "audio", name: "track 2" }, song, { listen: true, beats: beats({ bpm: 125, confidence: 0.9 }) }), true);
    // A voice gets a grid of 0.6 at most (a song 0.7 or more): not music.
    assert.equal(await soundIsMusic({ type: "audio", name: "vo" }, voice, { listen: true, beats: beats({ bpm: 92.7, confidence: 0.58 }) }), false);
    // A saved .beats answers without analyzing again.
    await writeFile(`${voice}.beats`, JSON.stringify({ bpm: 120, confidence: 0.8 }));
    analyzed.length = 0;
    assert.equal(await soundIsMusic({ type: "audio", name: "vo" }, voice, { listen: true, beats: beats(null) }), true);
    assert.deepEqual(analyzed, []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
