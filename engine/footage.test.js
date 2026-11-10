// compose {footage}: the small pure parts (engine/footage/): beat math, cuts at word edges, the
// opening moment, the layout choice and music-led pacing. One test per behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { barAtOrAfter, beatGrid, editBeats, snapToImpact, speechSpan } from "./footage/cuts.js";
import { markedSubject, openingMoment } from "./footage/moments.js";
import { shotLayout } from "./footage/layout.js";
import { accentTimes, burstPassages, phrasePlan, songSections } from "./footage/pace.js";
import { planEdit } from "./footage/plan.js";
import { footageOps } from "./footage/ops.js";

const round3 = (value) => Math.round(value * 1000) / 1000;

const words = [
  { text: "hello", start: 1, end: 1.4 },
  { text: "there", start: 1.5, end: 1.9 },
  { text: "friend", start: 3, end: 3.5 },
];

test("beat grid: period, downbeat and edit-time beats", () => {
  const beats = Array.from({ length: 16 }, (_, index) => 0.25 + index * 0.5);
  // The loud low onsets fall on beats 1, 5, 9: the bar starts on beat 1.
  const onsets = [1, 5, 9].map((index) => ({ time: 0.25 + index * 0.5, low: 5 }));
  const grid = beatGrid({ beats, period: 0.5, onsets });
  assert.equal(grid.bpm, 120);
  assert.equal(grid.bar, 1);
  assert.equal(barAtOrAfter(grid, 1), 2.75);
  const edit = editBeats(grid, { offset: 2.75, start: 0 });
  assert.equal(edit.next(0.1), 0.5);
  assert.equal(edit.nearest(0.7), 0.5);
  assert.ok(edit.isDownbeat(edit.index(0)));
});

test("speech span pads into the silence, never into a neighbor word", () => {
  const span = speechSpan(words[0], words[1], words);
  assert.equal(span.in, 0.94);
  assert.equal(span.out, 2.06);
  const tight = speechSpan(words[1], words[1], words);
  assert.equal(tight.in, 1.45);
});

test("the opening is a face saying the hook, never a dark frame", () => {
  const moments = [
    { kind: "visual", hook: 90, score: 90, face: 0, dark: true },
    { kind: "visual", hook: 70, score: 70, face: 0.8 },
    { kind: "speech", hook: 60, score: 60, face: 0.5 },
  ];
  assert.equal(openingMoment(moments), moments[2]);
  assert.equal(openingMoment(moments.slice(0, 2)), moments[1]);
});

test("layout: same shape fills, a phone clip in 16:9 is a card, a screen goes over its camera shot", () => {
  const frame = { width: 1920, height: 1080 };
  assert.equal(shotLayout({ width: 1920, height: 1080 }, frame).kind, "fill");
  const card = shotLayout({ width: 1080, height: 1920 }, frame);
  assert.equal(card.kind, "blur-fill");
  assert.ok(card.main.height <= 1080 && card.main.x >= 0);
  const screen = shotLayout({ width: 1080, height: 2340, kind: "screen" }, frame, { partner: { clip: { width: 1920, height: 1080 }, focus: null } });
  assert.equal(screen.kind, "screen-over");
  // A portrait frame crops a 4:3 talking head around the face (it keeps 42% of the width).
  assert.equal(shotLayout({ width: 1440, height: 1080 }, { width: 1080, height: 1920 }, { focus: [0.5, 0.4] }).kind, "fill");
  // A 16:9 clip in 9:16 keeps 32% of its width: a card, unless a marked subject fits that crop,
  // which then sits in the middle of it.
  const wide = { width: 1920, height: 1080 };
  const tall = { width: 1080, height: 1920 };
  assert.equal(shotLayout(wide, tall, { focus: [0.8, 0.4] }).kind, "blur-fill");
  const subject = markedSubject({ subjects: [{ at: 2, box: [70, 20, 20, 50] }] }, 1.8, 3);
  assert.deepEqual(subject.box.map((value) => Math.round(value * 100)), [70, 20, 20, 50]);
  const cropped = shotLayout(wide, tall, { focus: subject.center, subject: subject.box });
  assert.equal(cropped.kind, "fill");
  assert.ok(Math.abs(cropped.main.x + 0.8 * cropped.main.width - 540) <= 1);
  assert.equal(markedSubject({ subjects: [{ at: 2, box: [70, 20, 20, 50] }] }, 3, 4), null);
  assert.equal(shotLayout(wide, tall, { focus: [0.5, 0.5], subject: [0.2, 0.2, 0.6, 0.6] }).kind, "blur-fill");
  // A portrait clip in 16:9 keeps 32% of its height: a tall marked subject does not fit, a card.
  assert.equal(shotLayout(tall, wide, { focus: [0.5, 0.5], subject: [0.3, 0.1, 0.4, 0.8] }).kind, "blur-fill");
});

// Music-led pacing (pace.js): six steady clips cut to a
// 105 BPM song.
// `sample` adds measured fields to every sample, `clip` to every clip, `input` to the plan's input.
const paced = (pace, duration, { sample = {}, clip = {}, curve = [], shape, onsets = [], ...input } = {}) => {
  const samples = Array.from({ length: 40 }, (_, index) => ({ t: index / 2, motion: 0.1, change: 0.05, bright: 0.5, faces: [], ...sample }));
  const clips = Array.from({ length: 6 }, (_, index) => ({ key: `c${index}`, name: `clip${index}`, src: `c${index}.mp4`, kind: "camera", width: 1920, height: 1080, duration: 20, in: 0, out: 20, words: [], samples, shots: [{ start: 0, end: 20 }], ...clip }));
  const period = 60 / 105;
  const analysis = { beats: Array.from({ length: 200 }, (_, index) => 0.3 + index * period), period, bpm: 105, onsets };
  const plan = planEdit({ clips, music: { src: "m.mp3", duration: 120, analysis, loud: -14, curve, ...(shape ? { shape } : {}) }, frame: { width: 1920, height: 1080 }, duration, treatment: "punchy", pace, seed: 3, title: "Hi", ...input });
  return { plan, period, clips: new Map(clips.map((clip) => [clip.key, clip])) };
};

test("pace: runs of whole beats on the beat grid, a calm open and an ending twice as fast", () => {
  assert.deepEqual(phrasePlan("promo", 35), [{ from: 0, to: 16, beats: 4 }, { from: 16, to: 28, beats: 2 }, { from: 28, to: 35, beats: 1 }]);
  assert.deepEqual(phrasePlan("velocity", 10), [{ from: 0, to: 10, beats: 1 }]);
  const { plan, period } = paced("promo", 30);
  // Every cut within 1 frame (33 ms) of a beat of the song, never drifting.
  for (const shot of plan.shots.slice(1)) {
    const beats = (shot.start + plan.music.offset - 0.3) / period;
    assert.ok(Math.abs(beats - Math.round(beats)) * period < 1 / 30, `cut at ${shot.start} is off the beat`);
  }
  // The body after the title: 4 shots of 4 beats, 6 of 2, then 7 of 1.
  assert.deepEqual(plan.runs.slice(1).map((run) => `${run.count}x${run.beats}`), ["4x4", "6x2", "7x1"]);
});

test("accents: a zoom punch on every other downbeat in the open, every one in the ending, none under words", () => {
  const bars = [0, 2, 4, 6, 8, 10, 12, 14];
  assert.deepEqual(accentTimes(bars, { ending: 10, quiet: [{ start: 3.9, end: 4.2 }] }), [0, 8, 10, 12, 14]);
  const { plan, clips } = paced("promo", 30, { accents: true });
  const accented = plan.shots.filter((shot) => shot.accents);
  assert.ok(accented.length >= 3);
  const ops = footageOps(plan, clips);
  const layer = ops.find((op) => op.name === `shot-${accented[0].n}`);
  const punch = layer.animations.find((animation) => animation.name === "Accent");
  assert.equal(punch.start, round3(accented[0].accents[0] - 0.04));
  assert.ok(punch.to.scaleX > punch.from.scaleX);
});

test("seam-locked cuts: a measured song shape puts cuts on its seams, holds rests and softens only smooth passages", () => {
  // File seconds: quiet intro, the drop at 30.012, a vocal entry, a one-second rest, a quieter break, a second drop.
  const shape = {
    sections: [{ at: 0, kind: "intro" }, { at: 30.012, kind: "drop", weight: 0.9 }, { at: 41.517, kind: "break", weight: 0.6 }, { at: 46.29, kind: "drop", weight: 0.8 }],
    seams: [{ at: 35.071, kind: "vocal-in", weight: 0.4 }, { at: 38.2, kind: "dropout", weight: 0.7 }, { at: 39.43, kind: "return", weight: 0.7 }],
  };
  const curve = Array.from({ length: 240 }, (_, index) => (index < 60 ? -30 : index >= 83 && index < 93 ? -22 : -10));
  const deck = { cards: [{ tag: "push-transition" }, { tag: "dissolve" }] };
  // Source shots of 1.3 s (anime footage) leave little room: seams still lock, rests still hold.
  const short = Array.from({ length: 16 }, (_, index) => ({ start: round3(index * 1.3), end: Math.min(20, round3((index + 1) * 1.3)) }));
  for (const [seed, shots] of [[1], [2], [3], [1, short], [2, short]]) {
    const { plan, clips } = paced(null, 30, { treatment: "story", deck, seed, curve, sample: { motion: 0.4 }, shape, clip: shots ? { shots } : {} });
    assert.ok(plan.song, plan.words.join("\n"));
    const cuts = plan.shots.slice(1).map((shot) => shot.start);
    // Every seam in the body has a cut within one frame, and no cut falls inside the rest.
    assert.ok(plan.song.seams.length >= 4);
    assert.deepEqual(plan.song.locked, plan.song.seams, plan.words.join("\n"));
    const [rest] = plan.song.rests;
    assert.ok(!cuts.some((at) => at > rest.from + 0.001 && at < rest.to - 0.001));
    // No sliver, and a shot past its source shot holds that shot's last frame (freezeAt).
    for (const shot of plan.shots.filter((entry) => entry.role === "body")) {
      assert.ok(shot.end - shot.start >= 0.25 - 1e-6, `${shot.start}-${shot.end}`);
      const until = clips.get(shot.clip).shots.find((entry) => shot.in >= entry.start - 1e-6 && shot.in < entry.end)?.end ?? 20;
      assert.ok(shot.freezeAt !== undefined || shot.in + shot.end - shot.start <= until + 0.002, `${shot.start}-${shot.end} from ${shot.in}`);
    }
    // A dissolve only in the smooth break, never on a driven section's seam.
    for (const shot of plan.shots.slice(2)) {
      const part = plan.song.sections.find((entry) => shot.start >= entry.from - 1e-6 && shot.start < entry.to - 1e-6);
      if (["dissolve", "fade-black", "blur-through"].includes(shot.transition.kind)) assert.ok(part.smooth, `${shot.transition.kind} at ${shot.start} in ${part.kind}`);
    }
  }
  // The request scales the section ranges: a velocity pace halves them, and the plan's words say
  // what the cuts do (each beat-to-beat shot inside its section's range, or a motion hold of twice it).
  const counts = {};
  for (const pace of ["velocity", "promo"]) {
    const { plan, period } = paced(pace, 30, { treatment: "story", deck, seed: 2, curve, sample: { motion: 0.4 }, shape });
    counts[pace] = plan.shots.length;
    assert.ok(plan.words.some((line) => line.startsWith(`${pace} pace over the song's sections: their beat ranges x${pace === "velocity" ? 0.5 : 1}`)), plan.words.join("\n"));
    const songLine = plan.words.find((line) => line.startsWith("song seams"));
    for (const part of plan.song.sections) assert.ok(songLine.includes(`${part.kind} ${part.beats[0]}-${part.beats[1]} beats a shot`), songLine);
    const onGrid = (time) => { const index = (time + plan.music.offset - 0.3) / period; return Math.abs(index - Math.round(index)) * period < 0.002; };
    const forced = new Set([...plan.song.seams.map((seam) => seam.at), ...plan.song.rests.map((rest) => rest.to), plan.endCard.at - 0.2].map(round3));
    for (const shot of plan.shots.filter((entry) => entry.role === "body" && entry.n > 2 && onGrid(entry.start) && onGrid(entry.end) && !forced.has(entry.end))) {
      const [low, high] = plan.song.sections.find((part) => shot.start >= part.from - 1e-6 && shot.start < part.to - 1e-6).beats;
      const count = Math.round((shot.end - shot.start) / period);
      assert.ok((count >= low && count <= high) || count === high * 2, `${pace}: ${shot.start}-${shot.end} is ${count} beats, range ${low}-${high}`);
    }
  }
  assert.ok(counts.velocity > counts.promo);
  // A one-beat stop before a drop (song-shape.mjs keeps no return for it): the rest ends on the
  // drop, so the drop stays a cut even with a later return within 4 s.
  const stop = songSections({ sections: [{ at: 0, kind: "intro" }, { at: 30.012, kind: "drop" }], seams: [{ at: 29.44, kind: "dropout" }, { at: 33.1, kind: "return" }] }, { offset: 26, to: 20 });
  assert.deepEqual(stop.seams.map((seam) => [seam.kind, seam.at]), [["drop", 4.012], ["return", 7.1]]);
  assert.deepEqual(stop.rests, [{ from: 3.44, to: 4.012 }]);
  // A near-flat song (sections 0.5 dB apart) cuts every section in the middle range.
  const flat = songSections({ sections: [{ at: 0, kind: "intro" }, { at: 10, kind: "drop" }, { at: 20, kind: "break" }] }, { offset: 0, curve: Array.from({ length: 60 }, (_, index) => (index < 20 ? -10.5 : -10)) });
  assert.deepEqual(flat.sections.map((part) => part.beats), [[2, 4], [2, 4], [2, 4]]);
});

test("cut snapping and burst: footage impacts pull cuts onto song hits, a burst only over a dense passage", () => {
  const frame = 1 / 30;
  // The impact frame shows on the hit (the in-point slides later), the cut follows the contact frame.
  const base = { cut: 5, start: 3, in: 10, roomEnd: 20, hits: [{ at: 5.2, strength: 1 }], low: 3.25, high: 7, reach: 0.5, frame };
  assert.deepEqual(snapToImpact({ ...base, impacts: [{ t: 12.3, kind: "impact", how: "contact", confidence: 0.8 }] }), { at: 5.233, in: 10.1, impact: 12.3, hit: 5.2, early: 0 });
  // A moment that cannot slide back: the picture may come 1.5 frames early, never 9; never late.
  assert.equal(snapToImpact({ ...base, impacts: [{ t: 12.15, how: "contact", confidence: 0.8 }] }).early, 1.5);
  assert.equal(snapToImpact({ ...base, impacts: [{ t: 11.9, how: "contact", confidence: 0.8 }] }), null);
  assert.equal(snapToImpact({ ...base, in: 9, impacts: [{ t: 12.3, how: "contact", confidence: 0.8 }] }), null);
  // An unsure impact moves nothing; a 3-frame impact frame plays in full before the cut.
  assert.equal(snapToImpact({ ...base, impacts: [{ t: 12.3, how: "contact", confidence: 0.3 }] }), null);
  assert.equal(snapToImpact({ ...base, impacts: [{ t: 12.3, how: "frame", frames: 3, confidence: 0.8 }] }).at, 5.3);
  // Counted in the clip's own frames: at 24 fps a 3-frame impact frame is 0.125 s, a contact drawing on 2s 0.083 s.
  assert.equal(snapToImpact({ ...base, clipFrame: 1 / 24, impacts: [{ t: 12.3, how: "frame", frames: 3, confidence: 0.8 }] }).at, 5.325);
  assert.equal(snapToImpact({ ...base, clipFrame: 1 / 24, hold: 2, impacts: [{ t: 12.3, how: "contact", confidence: 0.8 }] }).at, 5.283);
  // Motion carried across the cut only breaks a tie between equally strong pairs.
  const tie = { ...base, hits: [{ at: 5.2, strength: 1 }, { at: 4.9, strength: 1 }], impacts: [{ t: 12.3, how: "contact", confidence: 0.8 }] };
  assert.equal(snapToImpact(tie).hit, 4.9);
  assert.equal(snapToImpact({ ...tie, carry: (newIn) => (newIn === 10.1 ? 1 : 0) }).hit, 5.2);
  assert.equal(snapToImpact({ ...tie, hits: [{ at: 5.2, strength: 1 }, { at: 4.9, strength: 0.6 }], carry: (newIn) => (newIn === 10.4 ? 1 : 0) }).hit, 5.2);

  // A quiet intro, then a drop at 30.012 s; a kick on every beat, and (dense) 16th notes over one bar.
  const shape = { sections: [{ at: 0, kind: "intro" }, { at: 30.012, kind: "drop", weight: 0.9 }], seams: [] };
  const curve = Array.from({ length: 240 }, (_, index) => (index < 60 ? -30 : -10));
  const period = 60 / 105;
  const kicks = Array.from({ length: 200 }, (_, index) => ({ time: round3(0.3 + index * period), strength: 1, low: 1 }));
  const options = { treatment: "story", seed: 1, curve, shape, sample: { motion: 0.2 } };
  const plain = paced(null, 30, { ...options, onsets: kicks }).plan;
  assert.equal(plain.burst, null, "a steady kick is no reason for a burst");
  const barFrom = plain.music.offset + 14;
  const first = Math.ceil((barFrom - 0.3) / period);
  const sixteenths = [];
  for (let step = 1; step < 16; step += 1) if (step % 4) sixteenths.push({ time: round3(0.3 + (first + step / 4) * period), strength: 0.8, low: 0.2 });
  const onsets = [...kicks, ...sixteenths].sort((a, b) => a.time - b.time);
  // Unmeasured brightness, or a calm edit: no burst (its cuts could flash, or race the treatment).
  assert.equal(paced(null, 30, { ...options, onsets }).plan.burst, null);
  // Footage of mixed brightness: the burst's shots keep within 0.1 luma of each other.
  const lumas = [0.2, 0.6, 0.8, 0.3, 0.25];
  const samples = Array.from({ length: 40 }, (_, index) => ({ t: index / 2, motion: 0.2, change: 0.05, luma: lumas[index % 5], faces: [] }));
  const lit = { ...options, onsets, clip: { samples } };
  assert.equal(paced(null, 30, { ...lit, treatment: "calm" }).plan.burst, null);
  const { plan } = paced(null, 30, lit);
  assert.ok(plan.burst, plan.words.join("\n"));
  const lumaOf = (shot) => { const near = samples.filter((sample) => Math.abs(sample.t - shot.in) <= 0.25 + 1e-6); return near.reduce((total, sample) => total + sample.luma, 0) / near.length; };
  const burstLumas = plan.shots.filter((shot) => shot.start >= plan.burst.from - 1e-6 && shot.start < plan.burst.to - 1e-6).map(lumaOf);
  assert.ok(Math.max(...burstLumas) - Math.min(...burstLumas) <= 0.1 + 1e-9, burstLumas.join(", "));
  // A burst's cuts are plain cuts, even with moving transitions in the deck.
  const decked = paced(null, 30, { ...lit, deck: { cards: [{ tag: "whip-pan" }, { tag: "zoom-through" }, { tag: "dissolve" }] } }).plan;
  assert.ok(decked.burst);
  for (const shot of decked.shots.filter((entry) => entry.start > decked.burst.from - 0.002 && entry.start < decked.burst.to + 0.002)) assert.equal(shot.transition.kind, "cut", `${shot.start}`);
  // A steady run of 16th notes longer than 2 bars is the section's texture: no burst over it.
  const beatTimes = Array.from({ length: 41 }, (_, index) => round3(index * period));
  const steady = beatTimes.slice(0, 40).flatMap((at, index) => (index < 26 ? [at] : [0, 1, 2, 3].map((step) => round3(at + (step * period) / 4))));
  assert.deepEqual(burstPassages(steady, beatTimes, { sections: [{ from: 0, to: 30, smooth: false, energy: 1 }] }), []);
  assert.equal(burstPassages(steady.filter((at) => at < beatTimes[34] - 0.01 || at >= beatTimes[40]), beatTimes, { sections: [{ from: 0, to: 30, smooth: false, energy: 1 }] }).length, 1);
  assert.equal(plan.burst.to - plan.burst.from > 2 * period, true);
  const inside = plan.shots.filter((shot) => shot.start >= plan.burst.from - 1e-6 && shot.start < plan.burst.to - 1e-6);
  assert.ok(inside.length >= 12, `${inside.length} burst shots`);
  for (const shot of inside) assert.ok(shot.start === plan.burst.from || plan.burst.cuts.includes(shot.start), `${shot.start} is on a hit`);
  assert.ok(plan.shots.some((shot) => Math.abs(shot.start - plan.burst.to) < 0.002), "the burst resolves on the next hit");
  assert.ok(plan.words.some((line) => line.startsWith("burst ")));

  // Impacts all through every clip pull cuts inside the section onto the hits; without them, none move.
  const impacts = Array.from({ length: 40 }, (_, index) => ({ t: round3(0.37 + index * 0.49), kind: "impact", how: "contact", confidence: 0.9 }));
  const snapped = paced(null, 30, { ...options, onsets: kicks, clip: { events: impacts }, deck: { cards: [{ tag: "whip-pan" }, { tag: "zoom-through" }, { tag: "dissolve" }] } }).plan;
  assert.equal(plain.snaps.length, 0);
  assert.ok(snapped.snaps.length >= 2, snapped.words.join("\n"));
  for (const snap of snapped.snaps) {
    const shot = snapped.shots.find((entry) => entry.n === snap.shot);
    const shown = round3(shot.start + shot.impact.file - shot.in);
    assert.ok(shown <= snap.hit + 0.001 && shown >= snap.hit - 2 * frame - 0.001, `impact at ${shown}, hit ${snap.hit}`);
    assert.equal(shot.end, round3(snap.hit + frame));
    // No transition's lead or overlap covers the impact frame: the snapped cut is a plain cut.
    assert.equal(snapped.shots.find((entry) => entry.n === snap.shot + 1).transition.kind, "cut");
    assert.ok(kicks.some((kick) => Math.abs(kick.time - snapped.music.offset - snap.hit) < 0.002));
  }
  assert.ok(snapped.words.some((line) => line.startsWith("cuts on footage impacts")));
});

test("anime proof: seams within a frame, frames held on drawn footage, accents only on strong measured triggers", () => {
  // A song with a drop, a rest and its return; three clips: one with contacts all through, one
  // drawn on 2s with light rising once, one plain. tests/anime-proof.mjs runs it through the server by hand.
  const shape = { sections: [{ at: 0, kind: "intro" }, { at: 30.012, kind: "drop", weight: 0.9 }], seams: [{ at: 38.2, kind: "dropout", weight: 0.7 }, { at: 39.43, kind: "return", weight: 0.7 }] };
  const curve = Array.from({ length: 240 }, (_, index) => (index < 60 ? -30 : -10));
  const period = 60 / 105;
  const onsets = Array.from({ length: 200 }, (_, index) => ({ time: round3(0.3 + index * period), strength: 1, low: 1 }));
  const contacts = Array.from({ length: 40 }, (_, index) => ({ t: round3(0.37 + index * 0.49), kind: "impact", how: "contact", confidence: 0.9 }));
  const kinds = [{ events: contacts }, { drawing: { frames: 2, sure: 0.9 }, events: [{ t: 6, kind: "light", from: 5.93, confidence: 0.8 }] }, {}];
  const samples = Array.from({ length: 40 }, (_, index) => ({ t: index / 2, motion: 0.3, change: 0.05, bright: 0.5, faces: [] }));
  const clips = kinds.map((extra, index) => ({ key: `c${index}`, name: `clip${index}`, src: `c${index}.mp4`, kind: "camera", width: 1920, height: 1080, duration: 20, in: 0, out: 20, words: [], samples, shots: [{ start: 0, end: 20 }], ...extra }));
  const analysis = { beats: Array.from({ length: 200 }, (_, index) => 0.3 + index * period), period, bpm: 105, onsets };
  for (const seed of [1, 2, 3]) {
    const plan = planEdit({ clips, music: { src: "m.mp3", duration: 120, analysis, loud: -14, curve, shape }, frame: { width: 1920, height: 1080 }, duration: 30, treatment: "story", seed, title: "Hi" });
    const why = plan.words.join("\n");
    // Every seam has its cut within one frame; nothing cuts inside the rest.
    assert.ok(plan.song.seams.length >= 2, why);
    assert.deepEqual(plan.song.locked, plan.song.seams, why);
    const [rest] = plan.song.rests;
    assert.ok(!plan.shots.slice(1).some((shot) => shot.start > rest.from + 0.001 && shot.start < rest.to - 0.001), why);
    // No frame blending on the clip drawn on 2s; no effect the song or footage does not motivate.
    assert.ok(!plan.shots.some((shot) => shot.clip === "c1" && shot.ramp?.blend), why);
    assert.ok(plan.shots.every((shot) => !shot.accents && !["flash", "glitch-hit"].includes(shot.transition?.kind) || plan.hits.some((hit) => Math.abs(hit.at - shot.start) < period)), why);
    // The strong contacts do pull cuts onto song hits, impact first (up to 2 frames early, never late).
    assert.ok(plan.snaps.length >= 1, why);
    for (const snap of plan.snaps) assert.ok(plan.shots.find((shot) => shot.n === snap.shot).clip === "c0", why);
  }
});

test("quiet by default: the same inputs give no effect without a measured reason", () => {
  const deck = { cards: [{ tag: "speed-ramp" }, { tag: "push-transition" }], setPiece: { kind: "move", name: "rgb-split-hit" } };
  // A loud treatment with no drop measured: no downbeat punch, no camera step, no hit, no color
  // split on a fixed shot, no slam title.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { plan, clips } = paced("promo", 30, { treatment: "loud", seed, deck });
    assert.equal(plan.hits.length, 0);
    assert.ok(plan.shots.every((shot) => !shot.accents && shot.camera.kind !== "punch-in"));
    assert.notEqual(plan.title.enter, "slam");
    assert.ok(!footageOps(plan, clips).some((op) => /^(flash-hit|hit-|flash-)/.test(op.id ?? op.name ?? "")));
    // A flash or glitch cut needs the drop too: none on a cut picked by the seed.
    assert.ok(!plan.shots.some((shot) => ["flash", "glitch-hit"].includes(shot.transition?.kind)));
  }
  // A real drop motivates one hit, on its beat, as strong as the rise; a gentle swell places the
  // music but motivates nothing.
  const rise = (from, to) => [...Array(60).fill(from), ...Array(180).fill(to)];
  const { plan: dropped, period } = paced("promo", 30, { treatment: "loud", curve: rise(-30, -10) });
  assert.equal(dropped.hits.length, 1);
  assert.ok(Math.abs(dropped.hits[0].at - dropped.music.drop) < period / 2);
  assert.equal(dropped.hits[0].strength, 0.45);
  const smaller = paced("promo", 30, { treatment: "loud", curve: rise(-18, -10) }).plan;
  assert.ok(smaller.hits.length === 1 && smaller.hits[0].strength < 0.4);
  const swell = paced("promo", 30, { treatment: "loud", curve: rise(-14, -11.5) }).plan;
  assert.ok(swell.music.drop !== null && swell.hits.length === 0, swell.words[0]);
  // Slow motion holds frames and a push keeps one way, until the footage measures one frame per
  // drawing (blend) and a sideways motion (the push follows it).
  const story = (extra) => paced(null, 30, { treatment: "story", deck, ...extra });
  const pushes = (plan) => plan.shots.filter((shot) => shot.transition?.kind === "push-transition").map((shot) => shot.transition.direction);
  const plain = story({});
  assert.ok(pushes(plain.plan).length && pushes(plain.plan).every((direction) => direction === -1));
  assert.ok(plain.plan.shots.some((shot) => shot.ramp) && !footageOps(plain.plan, plain.clips).some((op) => op.properties?.mediaInterpolation));
  const measured = story({ sample: { dx: 0.1 }, clip: { framesPerDrawing: 1 } });
  assert.ok(pushes(measured.plan).every((direction) => direction === 1));
  assert.ok(footageOps(measured.plan, measured.clips).some((op) => op.properties?.mediaInterpolation === "blend"));
  // The measured drawing (footage events) decides too: on 1s blends, on 2s holds frames.
  const blends = (drawing) => story({ clip: { drawing } }).plan.shots.some((shot) => shot.ramp?.blend);
  assert.deepEqual([blends({ frames: 1, sure: 0.9 }), blends({ frames: 2, sure: 0.9 }), blends({ frames: 1, sure: 0.4 })], [true, false, false]);
  // A flash on the drop is softer over a dim shot and on a smaller rise.
  const flash = (luma, curve) => paced("promo", 30, { treatment: "calm", deck: { cards: [{ tag: "flash" }] }, sample: { luma }, curve }).plan.hits[0]?.peak;
  assert.equal(flash(0.15, rise(-30, -10)), 0.45);
  assert.equal(flash(0.7, rise(-30, -10)), 0.85);
  assert.ok(flash(0.7, rise(-18, -10)) < 0.7);
});
