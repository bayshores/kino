// duck_audio: Volume animations that turn a layer down while other sound layers play.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { volumeAt } from "./animation.js";
import { duckStretches } from "./audioDucking.js";
import { voiceUnderBed, volumeChurn } from "./quality/rules/sound.js";
import { levelAt, lineWays, voiceLeveling, withOwnLevel } from "./mixLevels.js";
import { louderSound, soundPlacement, visibleActions } from "./soundActions.js";

const sound = (id, values = {}) => createLayer("audio", { id, name: id, src: `/api/media/${id}.wav`, ...values });

function documentWith(layers, duration = 10) {
  return parseDocument({ ...createDocument(), scenes: [createScene({ id: "s", duration, layers })] });
}

function duck(document, fields) {
  const operation = { type: "duck_audio", sceneId: "s", layerId: "music", ...fields };
  const reports = new Map();
  const next = applyOperations(document, [operation], { reports });
  return { document: next, report: reports.get(operation), music: next.scenes[0].layers.find((layer) => layer.id === "music") };
}

const summary = (animation) => [animation.name, animation.start, animation.duration, animation.from.volume, animation.to.volume];

test("duck_audio dips under a measured sound without words only while it is loud", () => {
  // A 4 s whoosh clip is loud only from 1.0 to 1.6 s of its file (quiet gaps under 0.25 s bridge).
  const momentary = Array(40).fill(-60);
  for (const index of [10, 11, 13, 14, 15]) momentary[index] = -20;
  const document = documentWith([sound("music"), sound("whoosh", { mediaStart: 2, mediaDuration: 4 })]);
  const { report, music } = duck(document, { under: ["whoosh"], to: 0.3, fade: 0.2, levels: { whoosh: { step: 0.1, momentary } } });
  assert.deepEqual(report.times, [[2.6, 4]]);
  assert.match(report.loud, /whoosh is loud/);
  assert.ok(Math.abs(volumeAt(music, 3.3) - 0.3) < 1e-9);
  assert.equal(volumeAt(music, 5), 1, "the music is back up while the clip plays on quietly");
});

test("duck_audio dips the music under each voice-over and back to its own volume", () => {
  const document = documentWith([
    sound("music", { volume: 0.8 }),
    sound("vo1", { mediaStart: 2, mediaDuration: 2 }),
    sound("vo2", { mediaStart: 9, mediaDuration: 1 }),
  ], 14);
  const { report, music } = duck(document, { under: ["vo1", "vo2"], to: 0.2, fade: 0.5 });
  assert.deepEqual(music.animations.map(summary), [
    ["Duck down", 1.5, 0.5, 0.8, 0.2], ["Duck up", 4, 0.5, 0.2, 0.8],
    ["Duck down", 8.5, 0.5, 0.8, 0.2], ["Duck up", 10, 0.5, 0.2, 0.8],
  ]);
  assert.deepEqual(report, { layer: "music", to: 0.2, dips: 2, summary: "music ducked to 0.2 at 1.5-4.5 s (vo1) and 8.5-10.5 s (vo2)", times: [[1.5, 4.5], [8.5, 10.5]] });
  // The receipt stays small.
  assert.ok(JSON.stringify(report).length < 180);
  for (const [time, volume] of [[1, 0.8], [2, 0.2], [3.9, 0.2], [5, 0.8], [9.5, 0.2], [12, 0.8]])
    assert.ok(Math.abs(volumeAt(music, time) - volume) < 1e-9, `${volume} at ${time} s`);
});

test("overlapping and close voice-overs make one dip, cut at the scene's start and end", () => {
  const document = documentWith([
    sound("music"),
    sound("vo1", { mediaStart: 0, mediaDuration: 2 }),
    // 0.3 s after vo1: the fades (0.15 s down, 0.8 s back up) would meet, so the music stays down.
    sound("vo2", { mediaStart: 2.3, mediaDuration: 1 }),
    sound("vo3", { mediaStart: 3, mediaDuration: 0.5 }),
    // Plays past the end of the scene.
    sound("vo4", { mediaStart: 8, mediaDuration: 5 }),
  ]);
  const { report, music } = duck(document, { under: ["vo1", "vo2", "vo3", "vo4"] });
  assert.deepEqual(report.times, [[0, 4.3], [7.85, 10]]);
  assert.equal(report.dips, 2);
  // The first dip starts at 0 already down; the last one has no Duck up after the scene ends.
  assert.deepEqual(music.animations.map((animation) => animation.name), ["Duck down", "Duck up", "Duck down"]);
  // The first dip is 3.5 s long, so it stays within 8 dB (0.398); the last, 2 s, goes to 0.25.
  assert.equal(volumeAt(music, 0.001), 0.398);
  assert.equal(volumeAt(music, 9.99), 0.25);
  // The music comes back up whenever both ramps fit in the gap and leave it up 0.3 s (a 2 s gap once stayed ducked).
  assert.deepEqual(duckStretches([{ start: 1, end: 2 }, { start: 2.6, end: 3 }], 0.25, 10), [{ start: 1, end: 3 }]);
  assert.deepEqual(duckStretches([{ start: 1, end: 2 }, { start: 2.9, end: 3.2 }], 0.25, 10), [{ start: 1, end: 2 }, { start: 2.9, end: 3.2 }]);
});

test("running duck_audio again adds its dips to the earlier ones (replace:true removes them) and keeps the layer's other animations", () => {
  let document = documentWith([sound("music"), sound("vo1", { mediaStart: 2, mediaDuration: 1 }), sound("vo2", { mediaStart: 8, mediaDuration: 1 })]);
  document = applyOperations(document, [{ type: "add_animation", sceneId: "s", layerId: "music",
    animation: { id: "fade-out", kind: "out", start: 9, duration: 1, easing: "linear", from: { volume: 1 }, to: { volume: 0 } } }]);
  const first = duck(document, { under: ["vo1"] });
  assert.equal(first.music.animations.length, 3);
  // The second call sets vo2's dip and keeps vo1's, and its receipt lists both.
  const again = duck(first.document, { under: ["vo2"], to: 0.5 });
  assert.deepEqual(again.music.animations.map((animation) => animation.id === "fade-out" ? "fade-out" : [animation.name, animation.start]),
    ["fade-out", ["Duck down", 1.85], ["Duck up", 3], ["Duck down", 7.85], ["Duck up", 9]]);
  assert.deepEqual(again.report, { layer: "music", to: 0.5, dips: 2, summary: "music ducked to 0.5 at 1.85-3.8 s (earlier; to 0.25) and 7.85-9.8 s (vo2)", times: [[1.85, 3.8], [7.85, 9.8]] });
  assert.equal(volumeAt(again.music, 2.5), 0.25);
  // The same voice again sets its own dip anew (no second dip on top).
  assert.equal(duck(again.document, { under: ["vo2"], to: 0.3 }).music.animations.filter((animation) => animation.name.startsWith("Duck")).length, 4);
  // replace:true removes the earlier dips first.
  const none = duck(again.document, { under: ["vo1"], to: 0.5, replace: true });
  assert.equal(none.music.animations.filter((animation) => animation.name.startsWith("Duck")).length, 2);
  // Under layers that are never heard leave no dip, and the summary says so.
  const silent = duck(documentWith([sound("music"), sound("mute", { mediaStart: 2, mediaDuration: 1, volume: 0 })]), { under: ["mute"] });
  assert.deepEqual(silent.report, { layer: "music", to: 0.25, dips: 0, summary: "music is not ducked: none of the under layers is heard in the scene" });
});

test("a voice-over whose length kino does not know ducks to the scene's end, and the receipt says why", () => {
  const document = documentWith([sound("music"), sound("voice", { mediaStart: 2 })]);
  const open = duck(document, { under: ["voice"] });
  assert.deepEqual(open.report.times, [[1.85, 10]]);
  assert.match(open.report.note, /^voice: length unknown, so ducked to the scene's end; set mediaSourceDuration/);
  // With the length importing answered, the dip ends with the file.
  const timed = documentWith([sound("music"), sound("voice", { mediaStart: 2, mediaSourceDuration: 2 })]);
  const closed = duck(timed, { under: ["voice"] });
  assert.deepEqual(closed.report, { layer: "music", to: 0.25, dips: 1, summary: "music ducked to 0.25 at 1.85-4.8 s (voice)", times: [[1.85, 4.8]] });
});

// Two lines that touch made one dip, and the receipt's times ([0.2, 7.4], [10.9, 14.9])
// looked like a line had been missed. The summary says which lines each dip covers.
test("the report's summary says where the music is ducked and which lines each dip covers", () => {
  const document = documentWith([
    sound("music", { volume: 0.8 }),
    sound("line-a", { mediaStart: 0.4, mediaDuration: 3.2 }),
    sound("line-c", { mediaStart: 3.6, mediaDuration: 3.6 }),
    sound("line-b", { mediaStart: 11.1, mediaDuration: 3.6 }),
  ], 16);
  const { report } = duck(document, { under: ["line-a", "line-b", "line-c"], to: 0.3, fade: 0.2 });
  assert.equal(report.dips, 2);
  assert.deepEqual(report.times, [[0.2, 7.4], [10.9, 14.9]]);
  assert.equal(report.summary, "music ducked to 0.3 at 0.2-7.4 s (line-a, line-c) and 10.9-14.9 s (line-b)");

  // Six lines apart: four dips are named, then "and 2 more"; five lines in one dip name three.
  const apart = documentWith([sound("music"), ...Array.from({ length: 6 }, (_, index) => sound(`l${index + 1}`, { mediaStart: index * 5 + 1, mediaDuration: 1 }))], 32);
  assert.equal(duck(apart, { under: ["l1", "l2", "l3", "l4", "l5", "l6"] }).report.summary,
    "music ducked to 0.25 at 0.85-2.8 s (l1), 5.85-7.8 s (l2), 10.85-12.8 s (l3), 15.85-17.8 s (l4) and 2 more");
  const together = documentWith([sound("music"), ...Array.from({ length: 5 }, (_, index) => sound(`l${index + 1}`, { mediaStart: index + 1, mediaDuration: 1 }))], 10);
  assert.equal(duck(together, { under: ["l1", "l2", "l3", "l4", "l5"] }).report.summary, "music ducked to 0.398 at 0.85-6.8 s (l1, l2, l3 +2)");

  // The words give the same numbers as times: toFixed(1) wrote this dip as 0.3-6.8 s, ending
  // before the 6.85 s it lists.
  const talk = duck(documentWith([sound("music"), sound("talk", { mediaStart: 0.45, mediaDuration: 6.2 })], 10), { under: ["talk"], to: 0.3, fade: 0.2 }).report;
  assert.deepEqual(talk.times, [[0.25, 6.85]]);
  assert.equal(talk.summary, "music ducked to 0.3 at 0.25-6.85 s (talk)");
});

// A 13 s voice clip with sparse talk held the music down through a whole beat.
test("a voice with a transcript ducks for its words, joining pauses under 1.2 s", () => {
  const document = documentWith([sound("music"), sound("voice", { mediaStart: 1, mediaDuration: 12 })], 14);
  const word = (text, start, end) => ({ text, start, end });
  // File seconds: two words 0.5 s apart (one dip), 6 s of quiet, then one word.
  const transcript = { words: [word("target", 0.5, 1), word("ahead.", 1.5, 2), word("[Music]", 4, 5), word("now", 8, 8.5)] };
  const { report } = duck(document, { under: ["voice"], speech: { voice: transcript } });
  assert.deepEqual(report.times, [[1.35, 3.8], [8.85, 10.3]]);
  assert.match(report.words, /^dips follow the words voice says/);
});

// T4 mix: the duck plan from word times. Quick down, slow up, back up in gaps over 1.2 s, the
// music 9 LU under the measured voice, and a warning when a dip covers a section change.
test("duck plan from words: fades, gaps, depth from measured loudness, section warning", () => {
  const word = (text, start, end) => ({ text, start, end });
  // A 1.1 s pause stays ducked; the music comes back up only in a gap it can stay up 3 s in.
  const transcript = { words: [word("one", 0, 1), word("two", 2.1, 3), word("three", 7.3, 8)] };
  const document = documentWith([sound("music", { mediaDuration: 10 }), sound("voice", { mediaStart: 1, mediaDuration: 8 })], 10);
  document.cues = [{ name: "chorus", time: 2.5, kind: "marker" }];
  // Music measured at -10 LUFS all through; the voice has a transcript, so it counts at -16 LUFS.
  const levels = { music: { step: 0.1, momentary: Array(100).fill(-10) } };
  const { report, music } = duck(document, { under: ["voice"], speech: { voice: transcript }, levels });
  assert.deepEqual(report.times, [[0.85, 4.8], [8.15, 9.8]]);
  const [down, up] = music.animations;
  assert.deepEqual([down.duration, up.duration], [0.15, 0.8]);
  // -16 - 9 = -25 LUFS for the music: 15 dB down from -10, volume 0.178.
  assert.equal(report.to, 0.178);
  assert.equal(music.animations[2].to.volume, 0.178);
  // The 3.95 s dip is held, but never above the voice 6 LU over the music (0.251), not 8 dB (0.398).
  assert.equal(down.to.volume, 0.251);
  assert.match(report.held, /1 dip over 2 s stays within 8 dB .*each line still 6 LU or more over it/);
  assert.equal(report.depth, undefined);
  assert.match(report.warning, /covers the song's chorus at 2\.5 s/);
  // A given `to` wins, and without measurements the dip is 0.25.
  assert.equal(duck(document, { under: ["voice"], speech: { voice: transcript }, levels, to: 0.4 }).report.to, 0.4);
  assert.equal(duck(document, { under: ["voice"], speech: { voice: transcript } }).report.to, 0.25);
  // A TTS voice at -30 LUFS is leveled at most 12 dB, so the render hears it at -18: the dip counts that, not -16.
  const quiet = { ...levels, voice: { step: 0.1, momentary: Array(100).fill(-30) } };
  assert.equal(duck(document, { under: ["voice"], speech: { voice: transcript }, levels: quiet }).music.animations[2].to.volume, 0.141);
});

// Dips once merged into one 12.35-30.65 s dip at -15 dB that buried the drop.
test("a dip never merges across a section cue, and a long dip goes no deeper than 8 dB", () => {
  const document = documentWith([sound("music"), sound("vo1", { mediaStart: 1, mediaDuration: 1 }), sound("vo2", { mediaStart: 2.4, mediaDuration: 1 })]);
  document.cues = [{ name: "drop", time: 2.2, kind: "marker" }];
  const { report, music } = duck(document, { under: ["vo1", "vo2"], to: 0.1 });
  // Kept apart at the drop: vo1 fades up by 2.2 s, vo2 fades down after it.
  assert.deepEqual(report.times, [[0.85, 2.2], [2.25, 4.2]]);
  assert.equal(volumeAt(music, 2.2), 1);
  assert.match(report.sections, /kept apart at the song's drop at 2\.2 s/);
  assert.deepEqual(duckStretches([{ start: 1, end: 2 }, { start: 2.4, end: 3 }], 0.15, 10, 0.8, [2.2]),
    [{ start: 1, end: 2, upBy: 2.2 }, { start: 2.4, end: 3, downFrom: 2.2 }]);
  // Without the cue they join into one 2.4 s dip, held within 8 dB (0.398) at the default depth.
  document.cues = [];
  const joined = duck(document, { under: ["vo1", "vo2"] });
  assert.deepEqual([joined.report.times, joined.report.to], [[[0.85, 4.2]], 0.398]);
  assert.match(joined.report.held, /1 dip over 2 s stays within 8 dB/);
  // A given `to` is the agent's choice, so the hold never makes it shallower (to 0.12 gave 0.398).
  const asked = duck(document, { under: ["vo1", "vo2"], to: 0.12 });
  assert.deepEqual([asked.report.to, asked.report.held, volumeAt(asked.music, 3)], [0.12, undefined, 0.12]);
});

// One merged dip held shallow for its loud line left "Walk 80 meters." 1.9 LU over the
// music. Each line is measured the way voice_under_bed measures it, so the quiet one is clear too.
test("a quiet line inside a merged long dip takes it deep enough to stay 6 LU over the music", () => {
  const word = (text, start, end) => ({ text, start, end });
  // File seconds: a loud sentence, a 0.3 s pause (one dip), then a quiet one.
  const transcript = { words: [word("Turn", 0, 0.5), word("left.", 0.6, 1.2), word("Walk", 1.5, 2), word("ahead.", 2.1, 2.8)] };
  const document = documentWith([sound("music", { mediaDuration: 10 }), sound("voice", { mediaStart: 1, mediaDuration: 3 })], 10);
  const run = (quiet) => {
    const levels = {
      music: { step: 0.1, momentary: Array(100).fill(-10) },
      voice: { step: 0.1, momentary: Array.from({ length: 30 }, (_, index) => (index < 13 ? -10 : quiet)) },
    };
    const { report, music } = duck(document, { under: ["voice"], speech: { voice: transcript }, levels });
    // The check measures the same lines.
    const scene = { ...document.scenes[0], layers: [music, document.scenes[0].layers[1]] };
    const ctx = { speechScene: scene, speech: [{ layer: scene.layers[1], transcript, levels: levels.voice }, { layer: music, music: true, levels: levels.music }] };
    return { report, found: voiceUnderBed(null, ctx) };
  };
  // 8 dB quieter: the dip goes from the held 0.398 to 0.131, and the check finds no line under the music.
  const deeper = run(-18);
  assert.deepEqual([deeper.report.times, deeper.report.to, deeper.found], [[[0.85, 4.6]], 0.131, []]);
  assert.match(deeper.report.deeper, /1 dip goes deeper so each line in it is 6 LU or more over the music/);
  // 20 dB quieter needs 0.035: the dip stops at its floor (0.1) and names the line to bring up; the check still flags it.
  const floored = run(-30);
  assert.deepEqual([floored.report.to, floored.report.deeper, floored.found.length], [0.1, undefined, 1]);
  assert.match(floored.report.quiet, /^"Walk ahead\." \(voice\) stays under 6 LU over the music with the dip at its floor .*raise that voice's volume/);
});

// .scratch dm2: one 0.055 dip held from 0.07 to 12.4 s through a 2 s gap between lines and over the
// song's drop, so the payoff was the quietest stretch. Each line now gets its own dip.
test("each line gets its own dip at its own measured depth, the song comes back between lines, and a dip ends before the drop", () => {
  const flat = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
  // The song at -10 LUFS, -8 from its drop at 7.9 s; three lines measured at -18, -24 and -8 LUFS.
  const levels = { music: { step: 0.1, momentary: Array.from({ length: 300 }, (_, index) => (index < 79 ? -10 : -8)) }, v1: flat(-18, 3), v2: flat(-24, 2), v3: flat(-8, 2) };
  const document = documentWith([sound("music", { mediaSourceDuration: 30 }), sound("v1", { mediaStart: 0.2, mediaDuration: 2.4 }),
    sound("v2", { mediaStart: 4.6, mediaDuration: 1.8 }), sound("v3", { mediaStart: 7.4, mediaDuration: 1.8 })], 14);
  document.cues = [{ name: "song-drop-1", time: 7.9, kind: "marker" }];
  // A dip per line (the 2 s gap gets the song back) would turn the song 3 times in 4.4 s
  // (volume_churn), so the lines share one dip whose fade up is done by the drop, and joined says so.
  const apart = duck(document, { under: ["v1", "v2", "v3"], levels, fadeUp: 0.8 });
  assert.deepEqual([apart.report.times, apart.report.joined], [[[0.05, 3.4], [4.45, 7.9]], undefined]);
  assert.deepEqual([1.5, 3.8, 5.5].map((time) => Math.round(volumeAt(apart.music, time) * 1000) / 1000), [0.2, 1, 0.1], "depth per line: v1 (-18) needs 0.2, v2 (-24) stops at the floor 0.1");
  const { report, music } = duck(document, { under: ["v1", "v2", "v3"], levels });
  assert.deepEqual(report.times, [[0.05, 7.9]]);
  assert.equal(report.joined, "a dip per line would turn music's level 3 times in 4.4 s (volume_churn), so the lines share 1 dip instead of 2 (a given to or fadeUp keeps a dip per line)");
  assert.equal(volumeChurn(null, { scene: { ...document.scenes[0], layers: [music] } }).length, 0);
  // The headline is the deepest dip made, not a measured depth under the floor (0.071 for v2).
  assert.equal(report.to, 0.1);
  assert.match(report.summary, /^music ducked to 0\.1 at 0\.05-7\.9 s \(v1, v2, v3\)$/);
  assert.deepEqual([3.8, 7.95, 8.5].map((time) => Math.round(volumeAt(music, time) * 1000) / 1000), [0.1, 1, 1]);
  // Every fade up takes 0.3 s or more, so bed_jump reads no step.
  assert.ok(music.animations.filter((animation) => animation.name === "Duck up").every((animation) => animation.duration >= 0.3));
  // The receipt says the dip ended before the drop, with v3 measured over the song there and the volume that lifts it.
  assert.equal(report.payoff, "the dip under v3 ends by the song's drop at 7.9 s, so the drop plays at full; v3 is +0 LU over the song there (measured): volume 2 on v3 (x2) lifts it 6 LU over");
  assert.equal(report.warning, undefined);
  // Each line over the song each way, measured with the song untouched: lifted alone, the shallowest
  // dip with the lift, and the music out. The song's loudest moment (-8, the drop) is the headroom's ceiling.
  assert.equal(report.ways.length, 3);
  assert.match(report.ways[0], /^v1 0\.2-2\.6 s: song untouched, line x1\.93 \(\+5\.7 dB\): -2\.3 LU over it \(8\.3 LU short of \+6\), 0 dB under the song's loudest moment · dip 0\.562 \(-5 dB\), line x2\.82 \(\+9 dB\): \+6 LU/);
  assert.match(report.ways[1], /^v2 4\.6-6\.4 s: .* · dip 0\.398 \(-8 dB\), line x3\.98 \(\+12 dB\): \+6 LU, 3 dB under .* · music out: the line alone at -12 LUFS$/);
  assert.match(report.ways[2], /^v3 7\.4-9\.2 s: song untouched, line x1 \(\+0 dB\): \+0\.\d LU over it/);
  // The volume_churn hint names the calls that keep the song's level (3 turns in 4.4 s apart).
  const churn = volumeChurn(null, { scene: { ...document.scenes[0], layers: [apart.music] } });
  assert.match(churn[0].fix.text, /keep_line \{lift:true\} keeps the song untouched.*duck_audio \{replace:true, fadeUp:/);
  // Over a quiet bed the lift alone reaches the aim, so no dip is needed.
  assert.deepEqual(lineWays({ line: -24, under: -30, ceiling: -30 }), { lift: { reach: -16, db: 8, over: 14, headroom: 5.8, factor: 2.51, short: 0 }, dip: null, out: { reach: -16 } });
  // A given `to` keeps its span through the drop, as asked.
  assert.deepEqual(duck(document, { under: ["v3"], levels, to: 0.3 }).report.times, [[7.25, 10]]);
});

// .scratch friction wave 4 (replay-proof): the default dipped lines whose ways said "no dip needed",
// and printed "heard at full" for a cue a dip started on.
const flatCurve = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
const said = (text, start, end) => ({ text, start, end, p: 1 });
function duckVo(cues, songLufs, words, extra = {}) {
  const document = documentWith([sound("music", { mediaSourceDuration: 30 }), sound("vo", { mediaSourceDuration: 10 })]);
  document.cues = cues;
  return duck(document, { under: ["vo"], speech: { vo: { words } }, levels: { music: flatCurve(songLufs, 30), vo: flatCurve(-16, 10) }, ...extra });
}

test("a line already 6 LU over the song as it plays gets no default dip, and the receipt says why", () => {
  // The voice counts at -16 LUFS, the song at -23: +7 LU (it dipped to 0.794 for 9 LU before).
  const { report, music } = duckVo([], -23, [said("one", 2, 2.6), said("two", 2.7, 3.4)]);
  assert.deepEqual([report.dips, volumeAt(music, 3)], [0, 1]);
  assert.match(report.ways[0], /no dip needed/);
  assert.equal(report.clear, "no dip under vo 2-3.4 s (+7 LU): already 6 LU or more over the song as it plays there (measured; ways: no dip needed); to:<volume> dips anyway");
  assert.equal(duckVo([], -23, [said("one", 2, 2.6)], { to: 0.5 }).report.dips, 1);
});

test("a dip that starts on a section cue covers it, and a last word past the drop holds the dip with its rise", () => {
  const onCue = duckVo([{ name: "chorus", time: 2.2, kind: "marker" }], -10, [said("one", 0.3, 1), said("two", 2.3, 3)], { fadeUp: 2 });
  assert.deepEqual(onCue.report.times, [[0.15, 2.2], [2.2, 5]]);
  assert.equal(onCue.report.sections, undefined);
  assert.match(onCue.report.warning, /covers the song's chorus at 2\.2 s/);
  // "two" runs 2.7-3.4 s over a drop at 3.2 s: the dip holds to 3.4 s (it ended at 3.2 s) and is back up 0.3 s later.
  const past = duckVo([{ name: "drop", time: 3.2, kind: "marker" }], -10, [said("one", 2, 2.6), said("two", 2.7, 3.4)]);
  assert.deepEqual(past.report.times, [[1.85, 3.7]]);
  assert.deepEqual([3.3, 3.7].map((time) => Math.round(volumeAt(past.music, time) * 1000) / 1000), [0.178, 1]);
  assert.equal(past.report.payoff, 'the dip under vo holds to the end of its last word "two" at 3.4 s, 0.2 s past the song\'s drop at 3.2 s, then comes up in 0.3 s: +15 LU (-25 to -10 LUFS, 0.4 s each side, measured)');
});

test("voiceLeveling levels one clip line by line when its lines need gains over 6 dB apart", () => {
  // Line one at -28 LUFS (0 to 2 s), line two at -18 LUFS (3 to 5 s), silence between.
  const curve = { step: 0.1, momentary: Array.from({ length: 50 }, (_, index) => (index < 20 ? -28 : index < 30 ? null : -18)) };
  const leveling = voiceLeveling(curve, [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(leveling.lines.map((line) => [line.from, line.to, line.gain]), [[-Infinity, 2.5, 12], [2.5, Infinity, 2]]);
  assert.deepEqual([levelAt(leveling, 1), levelAt(leveling, 4)], [12, 2]);
  // Lines within 6 dB keep one gain.
  const close = { step: 0.1, momentary: Array.from({ length: 50 }, (_, index) => (index < 20 ? -20 : index < 30 ? null : -18)) };
  assert.equal(voiceLeveling(close, [{ start: 0, end: 2 }, { start: 3, end: 5 }]).lines, undefined);
});

test("duck_audio refuses layers without sound and values out of range", () => {
  const document = documentWith([sound("music"), sound("vo1", { mediaStart: 2, mediaDuration: 1 }), createLayer("text", { id: "title", name: "Title", text: "Hi" })]);
  assert.throws(() => duck(document, { layerId: "title", under: ["vo1"] }), /"Title" is a text layer and has no sound/);
  assert.throws(() => duck(document, { under: ["title"] }), /under: "Title" is a text layer and has no sound/);
  assert.throws(() => duck(document, { under: ["music"] }), /cannot duck under itself/);
  assert.throws(() => duck(document, { under: [] }), /under lists the layers/);
  assert.throws(() => duck(document, { under: ["missing"] }), /layer missing was not found/);
  assert.throws(() => duck(document, { under: ["vo1"], to: 1.2 }), /to is the volume during a dip, a number from 0 to 1/);
  assert.throws(() => duck(document, { under: ["vo1"], fade: 11 }), /fade is the seconds each fade down takes/);
});

test("an effect lands its transient on its action, under the song", () => {
  // A whip is an action a sound can ride; a dissolve has no one frame to hit.
  const { actions } = visibleActions({ "whip-pan": [{ at: 2 }], dissolve: [{ at: 4 }] }, [], [{ name: "onset-1", time: 2.03, kind: "onset" }]);
  assert.deepEqual(actions, [{ id: "a1", at: 2, kind: "whip", tags: ["whip-pan"], songHit: true }]);
  // Loudest peak at index 5 (0.05 s), the effect's curve peaks at -10 LUFS, the song is a flat -12.
  const peaks = { peaks: [0, 0.1, 0.2, 0.4, 0.6, 1, 0.5, 0.2], secondsPerPeak: 0.01 };
  const music = sound("music", { mediaDuration: 10 });
  const beds = [{ layer: music, curve: { step: 0.1, momentary: Array(100).fill(-12) }, range: { start: 0, end: 10, offset: 0 } }];
  const placed = soundPlacement({ peaks, curve: { step: 0.1, momentary: [null, -10] }, beds, at: 2 });
  assert.equal(placed.mediaStart, 1.95);
  assert.ok(Math.abs(placed.volume - 0.562) < 0.001);
  assert.deepEqual([soundPlacement({ peaks, beds, at: 0.02 }).mediaStart, soundPlacement({ peaks, beds, at: 0.02 }).mediaOffset], [0, 0.03]);
  // The op, as the service resolves it, adds one plain audio layer with those values.
  const operation = { type: "place_sounds", sceneId: "s", sounds: [{ at: 2, kind: "whip", action: "a1", src: "/api/media/swish.wav", duration: 0.4, peaks, curve: { step: 0.1, momentary: [null, -10] } }], beds: ["music"], levels: { music: { step: 0.1, momentary: Array(100).fill(-12) } } };
  const reports = new Map();
  const next = applyOperations(documentWith([music]), [operation], { reports });
  const layer = next.scenes[0].layers.find((item) => item.id === "sfx-whip-1");
  assert.deepEqual([layer.type, layer.mediaStart, layer.mediaOffset, layer.volume], ["audio", 1.95, 0, 0.562]);
  assert.match(reports.get(operation).summary, /sfx-whip-1 at 1\.95 \(a1, transient at 2\), volume 0\.562, 3 LU under the song \(-12 LUFS\)/);
});

test("an effect's bed is measured where its own loudest window falls, not at the action", () => {
  // The song is -20 LUFS to 2.5 s, -10 after; the effect's transient is its start, its loudest window 0.8 s in.
  const music = sound("music", { mediaDuration: 10 });
  const beds = [{ layer: music, curve: { step: 0.1, momentary: Array.from({ length: 100 }, (_, index) => (index < 25 ? -20 : -10)) }, range: { start: 0, end: 10, offset: 0 } }];
  const placed = soundPlacement({ peaks: { peaks: [1, 0.5, 0.2], secondsPerPeak: 0.01 }, curve: { step: 0.1, momentary: [-20, -15, -12, -10, -9, -8, -7, -6, -5, -9] }, beds, at: 2 });
  assert.deepEqual([placed.loudestAt, placed.bed, placed.effect], [2.8, -10, -5]);
  // Its head trimmed (transient 1 s in, placed at 0.3 s): only the windows the scene plays count.
  const trimmed = soundPlacement({ peaks: { peaks: [...Array(100).fill(0.1), 1], secondsPerPeak: 0.01 }, curve: { step: 0.1, momentary: [-20, -15, -5, -20, -20, -20, -20, -12, -11, -10] }, beds, at: 0.3 });
  assert.deepEqual([trimmed.mediaOffset, trimmed.loudestAt, trimmed.bed, trimmed.effect, trimmed.level], [0.7, 0.2, -20, -10, "measured"]);
  // A bed silent at that one window (a stop on the action) is read around the action instead.
  const stop = [{ ...beds[0], curve: { step: 0.1, momentary: beds[0].curve.momentary.map((value, index) => (index === 28 ? null : value)) } }];
  assert.equal(soundPlacement({ peaks: { peaks: [1, 0.5, 0.2], secondsPerPeak: 0.01 }, curve: { step: 0.1, momentary: [-20, -15, -12, -10, -9, -8, -7, -6, -5, -9] }, beds: stop, at: 2 }).bed, -20);
});

test("a sound at the volume limit short of its aim is offered the next louder sound of its kind, one call", () => {
  const music = sound("music", { mediaDuration: 10 });
  const pool = [{ id: "soft", level: -19 }, { id: "mid", level: -12 }, { id: "loud", level: -5 }];
  // Needs +15 dB at volume 1 (song -12, effect -30, aim 3 LU under): volume 2 leaves it 9 LU short.
  const operation = { type: "place_sounds", sceneId: "s", sounds: [{ at: 2, kind: "whoosh", action: "a1", src: "/api/media/air.wav", duration: 1, level: -20, pool, curve: { step: 0.1, momentary: [-30] } }], beds: ["music"], levels: { music: { step: 0.1, momentary: Array(100).fill(-12) } } };
  const reports = new Map();
  applyOperations(documentWith([music]), [operation], { reports });
  const report = reports.get(operation);
  assert.deepEqual(report.louder, [{ layer: "sfx-whoosh-1", sound: "sfx:loud", db: 15, call: 'edit {ops:[{op:"delete_layer", layer:"sfx-whoosh-1"}, {op:"place_sounds", scene:"s", at:[{at:"a1", sound:"sfx:loud"}]}]}' }]);
  assert.match(report.summary, /volume 2, 12 LU under the song .*at the volume limit, 9 LU short of the aim: sfx:loud measures 15 dB louder/);
  // Within reach of the limit: no offer.
  assert.equal(louderSound({ level: "measured", volume: 1.5, bed: -12, effect: -18 }, 3, -20, pool), null);
  // The call keeps an under the agent set on the whole op (6 LU under: 6 LU short, so the +8 dB one).
  const reports2 = new Map();
  const deeper = { ...operation, under: 6 };
  applyOperations(documentWith([music]), [deeper], { reports: reports2 });
  assert.match(reports2.get(deeper).louder[0].call, /sound:"sfx:mid", under:6\}/);
});

test("a sound kept at its own level stays at 0 dB inside a leveled voice", () => {
  const leveled = withOwnLevel({ gain: 4 }, [{ start: 5, end: 6.5 }]);
  assert.deepEqual(leveled.lines.map((line) => [line.from, line.to, line.gain]), [[-Infinity, 5, 4], [5, 6.5, 0], [6.5, Infinity, 4]]);
  assert.deepEqual([levelAt(leveled, 2), levelAt(leveled, 5.5), levelAt(leveled, 7)], [4, 0, 4]);
  assert.deepEqual(withOwnLevel({ gain: 4 }, []), { gain: 4 });
});
