// compose {footage}: the small pure parts (engine/footage/): beat math, cuts at word edges, the
// opening moment, the layout choice and music-led pacing. One test per behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { barAtOrAfter, beatGrid, editBeats, snapToImpact, speechSpan } from "./footage/cuts.js";
import { markedSubject, openingMoment, speechMoments } from "./footage/moments.js";
import { pickLines } from "./footage/lines.js";
import { frameShot, shotLayout } from "./footage/layout.js";
import { facePartPoint, pickFace } from "./footage/faceParts.js";
import { accentTimes, burstPassages, phrasePlan, songSections } from "./footage/pace.js";
import { defaultPace, nearestBeats, shotStats } from "./footage/refPace.js";
import { beatLine, cutFacts, cutLines, cutsOnBeats, frameLevel, paceFacts, paceLine } from "./cutFacts.js";
import { planEdit } from "./footage/plan.js";
import { KINO_OWN_FAMILIES, KINO_PAIR_FAMILIES, footageBrand } from "./footage/treatments.js";
import { footageCues, footageOps } from "./footage/ops.js";
import { boardSpans, cueShowLines, cueShows, storyCues } from "./footage/cueShows.js";
import { createDocument, createLayer, createScene } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { parseFormat } from "./blocks/formats.js";
import { RECIPES } from "./blocks/recipes/index.js";
import { runRecipe } from "./blocks/recipe.js";
import { applyOperations } from "./operations.js";

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

test("frame: a hand-placed 16:9 layer in 9:16 gets blur-fill; a face from subjects-v1 leads, a saliency box never is one", () => {
  // The layer was cropped by hand to a 28.8% window of its 1920x1080 file (a face-cutting crop).
  // The shape backend/footage/people.mjs writes: plain face boxes in `faces`, tagged boxes in `subjects`.
  const sample = (subjects) => Array.from({ length: 21 }, (_, index) => ({ t: index / 2, faces: subjects.filter((entry) => entry.kind === "face").map((entry) => entry.box), subjects }));
  const hand = (file, samples) => {
    const layer = createLayer("video", { id: "keeper", name: "keeper", src: "/api/media/keeper.mp4", x: -1167, y: 0, width: 3413, height: 1920, mediaSourceDuration: 10 });
    const document = createDocument({ scenes: [createScene({ id: "s", width: 1080, height: 1920, duration: 4, layers: [layer] })] });
    const framed = applyOperations(document, [{ type: "frame_shot", sceneId: "s", layerId: "keeper", size: file, samples }]);
    return framed.scenes[0].layers;
  };
  const wide = { width: 1920, height: 1080 };
  // No face, no mark: a card in the safe area over a blurred copy of itself, both inside the frame.
  const [back, card, ...rest] = hand(wide, []);
  assert.deepEqual([rest.length, back.id, card.id, back.blur > 0, back.opacity < 1], [0, "keeper-blur", "keeper", true, true]);
  assert.ok(card.width <= 1080 && card.x >= 0 && card.x + card.width <= 1080 && card.radius > 0);
  assert.ok(back.x <= 0 && back.x + back.width >= 1080 && back.volume === 0 && !back.radius);
  // A 4:3 file keeps 42% of its width in 9:16: a face found in it leads the crop (fill, one layer).
  const square = { width: 1440, height: 1080 };
  const face = [{ box: [0.7, 0.2, 0.15, 0.25], kind: "face" }];
  const [filled, ...none] = hand(square, sample(face));
  assert.equal(none.length, 0);
  assert.ok(filled.x <= 0 && filled.x + filled.width >= 1080 && filled.y <= 0 && filled.y + filled.height >= 1920);
  assert.ok(Math.abs(filled.x + 0.775 * filled.width - 540) <= 1);
  // The same place as a saliency box is not a face: a big one decides blur-fill, a small one fill.
  assert.equal(hand(square, sample([{ box: [0.2, 0.2, 0.6, 0.6], kind: "saliency" }])).length, 2);
  const [small] = hand(wide, sample([{ box: [0.7, 0.3, 0.1, 0.3], kind: "saliency" }]));
  assert.ok(Math.abs(small.x + 0.75 * small.width - 540) <= 1);
  // A marked subject leads over the measured faces.
  const marked = createLayer("video", { id: "keeper", name: "keeper", src: "/api/media/keeper.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaSourceDuration: 10, subjectBoxes: { src: "/api/media/keeper.mp4", boxes: [{ at: 1, box: [10, 20, 15, 40], by: "agent" }] } });
  const document = createDocument({ scenes: [createScene({ id: "s", width: 1080, height: 1920, duration: 4, layers: [marked] })] });
  const [lead] = applyOperations(document, [{ type: "frame_shot", sceneId: "s", layerId: "keeper", size: wide, samples: sample(face) }]).scenes[0].layers;
  assert.ok(Math.abs(lead.x + 0.175 * lead.width - 540) <= 1);
  // A mark inside what kino sees (a mouth in a saliency box) widens to hold both; a part mark stays a part crop.
  const mouth = (extra = {}) => createLayer("video", { id: "keeper", name: "keeper", src: "/api/media/keeper.mp4", x: -1167, y: 0, width: 3413, height: 1920, mediaSourceDuration: 10, subjectBoxes: { src: "/api/media/keeper.mp4", boxes: [{ at: 1, box: [40, 40, 8, 8], by: "agent", ...extra }] } });
  const scene = (layer) => createScene({ id: "s", width: 1080, height: 1920, duration: 4, layers: [layer] });
  const seesFace = sample([{ box: [0.25, 0.2, 0.3, 0.5], kind: "saliency" }]);
  const shotOf = (layer) => { const { kind, on } = frameShot(scene(layer), layer, { size: wide, samples: seesFace }); return [kind, on]; };
  assert.deepEqual(shotOf(mouth()), ["blur-fill", "mark-salient"]);
  assert.deepEqual(shotOf(mouth({ part: "mouth" })), ["fill", "mark"]);
  // A logo burned into the file's top-left (the footage facts) stays out of a 16:9 fill crop (a full-frame
  // reset brought it back in a director's draft); one that needs over 1.35x is kept and said so.
  const plain = createLayer("video", { id: "plain", name: "plain", src: "/api/media/keeper.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaSourceDuration: 10 });
  const wideScene = createScene({ id: "w", width: 1920, height: 1080, duration: 4, layers: [plain] });
  const logo = [{ where: "top-left", box: [0.042, 0, 0.25, 0.125] }];
  const past = frameShot(wideScene, plain, { size: wide, samples: [], marks: logo });
  assert.deepEqual([past.patch.y <= 1 - 0.125 * past.patch.height, past.marks], [true, { out: true, zoom: 1.14 }]);
  assert.deepEqual(frameShot(wideScene, plain, { size: wide, samples: [], marks: [{ where: "left", box: [0.02, 0.1, 0.3, 0.4] }] }).marks, { out: false, kept: "zoom", zoom: 1.57 });
  assert.equal(frameShot(wideScene, plain, { size: wide, samples: [] }).marks, undefined);
  // A file of unknown size is refused with a sentence, nothing saved.
  assert.throws(() => applyOperations(document, [{ type: "frame_shot", sceneId: "s", layerId: "keeper" }]), /needs the size of keeper's file/);
  // Framing a layer that already has its blurred backdrop is refused: a second one would stack.
  const framed = applyOperations(createDocument({ scenes: [createScene({ id: "s", width: 1080, height: 1920, duration: 4, layers: [createLayer("video", { id: "keeper", name: "keeper", src: "/api/media/keeper.mp4", x: -1167, y: 0, width: 3413, height: 1920, mediaSourceDuration: 10 })] })] }),
    [{ type: "frame_shot", sceneId: "s", layerId: "keeper", size: wide, samples: [] }]);
  assert.throws(() => applyOperations(framed, [{ type: "frame_shot", sceneId: "s", layerId: "keeper", size: wide, samples: [] }]), /keeper is already framed: keeper blur is its blurred backdrop/);
});

test("face parts: a part mark is exact, a person-shaped mark is not a head, a measured face stands in, above-head sits on the box top", () => {
  const size = { width: 1920, height: 1080 };
  const samples = [{ t: 1, subjects: [{ box: [0.4, 0.2, 0.2, 0.4], kind: "face" }, { box: [0, 0, 1, 1], kind: "saliency" }] }];
  const person = { at: 1, box: [40, 5, 10, 90], by: "agent" };
  const found = pickFace({ marks: [person], samples, sourceTime: 1.2, on: "eyes", size });
  assert.equal(found.how, "detected", "a mark 5x taller than wide on screen is a person, not a head");
  assert.deepEqual(facePartPoint(found, "eyes").point.map(Math.round), [50, 35]);
  const strip = { at: 1, box: [30, 30, 40, 10], by: "agent", part: "eyes" };
  assert.deepEqual(facePartPoint(pickFace({ marks: [person, strip], samples, sourceTime: 1, on: "between-eyes", size }), "between-eyes").point, [50, 35]);
  assert.deepEqual(facePartPoint(pickFace({ marks: [], samples, sourceTime: 1, on: "above-head", size }), "above-head", { offset: [0, -10] }), { point: [50, 16], edge: "bottom" });
  assert.equal(pickFace({ marks: [person], samples, sourceTime: 3, on: "mouth", size }), null, "nothing within half a second");
  assert.equal(pickFace({ marks: [{ at: 1, box: [30, 10, 40, 80], by: "agent", part: "face" }], sourceTime: 1, on: "face", size }).how, "head", "a face mark is the head, placed by shares");
});

test("compose footage: a face from subjects-v1 leads the crop, a saliency box only decides fill or card", () => {
  const frame = { width: 1080, height: 1920 };
  const samples = (subjects) => Array.from({ length: 41 }, (_, index) => ({ t: index / 2, faces: subjects.filter((entry) => entry.kind === "face").map((entry) => entry.box), subjects }));
  const shotsOf = (faces) => paced("promo", 30, { frame, clip: { width: 1440, height: 1080, subjectSamples: samples(faces) } }).plan.shots.filter((shot) => shot.role === "body");
  const led = shotsOf([{ box: [0.7, 0.2, 0.15, 0.25], kind: "face" }]);
  assert.ok(led.length && led.every((shot) => shot.layout.kind === "fill" && Math.abs(shot.focus[0] - 0.775) < 1e-9));
  const eye = shotsOf([{ box: [0.2, 0.2, 0.6, 0.6], kind: "saliency" }]);
  assert.ok(eye.length && eye.every((shot) => shot.layout.kind === "blur-fill" && shot.focus === null));
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

test("spoken lines: with no voice a short clear repeated line is heard, captioned and ducked under; lines:false keeps every clip silent", () => {
  const said = [{ text: "Kill", start: 5, end: 5.3, p: 0.9 }, { text: "you.", start: 5.3, end: 5.7, p: 0.9 }];
  const { plan, clips } = paced(null, 18, { clip: { words: said, sound: { src: "c.mp4", own: true, duration: 20, loud: -20 } } });
  const heard = plan.shots.filter((shot) => shot.speech);
  assert.ok(heard.length >= 1 && heard.length <= 3, "a 2-word line passes (up to one per 6 s of 18 s)");
  assert.match(plan.spokenLines[0], /^lines heard: "Kill you\." [\d.]+-[\d.]+ s \(shot-\d+\).*up to one per 6 s/);
  const ops = footageOps(plan, clips);
  const layer = ops.find((op) => op.name === `shot-${heard[0].n}`);
  assert.deepEqual(layer.animations.filter((animation) => /^Sound (in|out)$/.test(animation.name)).map((animation) => animation.to.volume), [1, 0], "full clip volume for its span, short fades");
  assert.ok(ops.some((op) => op.op === "duck_audio" && op.under.includes(`shot-${heard[0].n}`)), "the music ducks under it");
  assert.ok(ops.some((op) => op.op === "move" && op.name === "caption-words" && op.words[0].text === "Kill"), "a caption shows it");
  assert.equal(paced(null, 18, { clip: { words: said }, lines: false }).plan.shots.filter((shot) => shot.speech).length, 0);
  const named = paced(null, 18, { clip: { words: said }, lines: ["kill you", "never said"] }).plan;
  assert.equal(named.shots.filter((shot) => shot.speech).length, 1);
  assert.match(named.spokenLines.at(-1), /lines not heard in the clips: "never said"/);
  // A last word ending 4 ms past the file's measured end is still a line (run 6's scream clip);
  // a tag word that kept one bracket is none.
  const tail = speechMoments({ key: "k", duration: 2.983, in: 0, out: 2.983, words: [{ text: "I", start: 2.4, end: 2.7, p: 0.9 }, { text: "can't!", start: 2.7, end: 2.987, p: 0.9 }], samples: [] }, new Set());
  assert.equal(tail.length, 1);
  assert.deepEqual(pickLines([{ ...tail[0], text: "Laughing)", score: 90 }], { duration: 18 }).chosen, []);
  // A word timed to no length still gets a caption length the caption move takes.
  const zero = paced(null, 18, { clip: { words: [said[0], { ...said[1], start: 5.3, end: 5.3 }], sound: { src: "c.mp4", own: true, duration: 20, loud: -20 } } }).plan;
  assert.ok(zero.captions.length && zero.captions.every((caption) => caption.words.every((word) => word.end > word.at)));
});

test("end card: the plan keeps the time its recipe needs for a long end line, in a body that is that much shorter", () => {
  const style = styleFor({ look: "crisp", frame: parseFormat("16:9") });
  const end = "made by agents. directed by you.";
  const settings = { copy: { text: "kino", tagline: end } };
  const staying = runRecipe(RECIPES["logo-sting"], { id: "end-card", settings, style, frame: style.frame, fonts: defaultFonts, start: 0, media: () => null }).staying;
  const usual = paced(null, 40, { end }).plan;
  assert.ok(usual.endCard.at + 0.1 + staying > 40, "the usual 2.8 s end is too short for this line (the recipe would refuse it)");
  const fitted = paced(null, 40, { end, endRoom: staying }).plan;
  assert.equal(fitted.duration, 40, "the length asked for stays");
  assert.ok(fitted.endCard.at + 0.1 + staying <= 40, "the card enters and is read before the edit ends");
  assert.ok(fitted.shots.find((shot) => shot.role === "end").start < usual.shots.find((shot) => shot.role === "end").start, "the body gives up the time");
  const beated = paced("promo", 40, { end, endRoom: staying }).plan;
  assert.ok(beated.endCard.at + 0.1 + staying <= 40 + 1e-6, "with a pace the card starts on a beat at or before its time");
  assert.equal(paced(null, 40, { end, endRoom: 1 }).plan.endCard.at, usual.endCard.at, "a short line keeps the usual end");
});

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

test("default pace: the median of the references' median shots and the longest of their longest, else today's numbers", () => {
  const ids = (item) => [item.source, item.ids];
  // No reference: today's pace, 2 beats with a song of known tempo (0.5 s a beat), else 0.6 s; the hold is 5.5 s.
  const today = defaultPace([]);
  assert.deepEqual([today.shot.seconds, today.shot.beats, ...ids(today.shot), today.hold.seconds, ...ids(today.hold)], [0.6, null, "today", [], 5.5, "today", []]);
  assert.deepEqual([defaultPace([], { beatSeconds: 0.5 }).shot.seconds, defaultPace([], { beatSeconds: 0.5 }).shot.beats], [1, 2]);
  // Two references measured before medians were kept (cuts only): medians 1 s and 1.5 s, longest 1 s and 2 s.
  const a = { id: "yt:a", numbers: { cuts: [1, 2, 3, 4, 5, 6, 7, 8, 9], seconds: 10, longest: { seconds: 1 } } };
  const b = { id: "yt:b", numbers: { cuts: [2, 3, 4], seconds: 6, longest: { seconds: 2 } } };
  const free = defaultPace([a, b]);
  assert.deepEqual([free.shot.seconds, ...ids(free.shot), free.hold.seconds, ...ids(free.hold)], [1.25, "ref", ["yt:a", "yt:b"], 2, "ref", ["yt:b"]]);
  // With a song of 0.5 s a beat and no reference tempo: 1.25 s is 2.5 beats, kept as 2 beats (1 s).
  const song = defaultPace([a, b], { beatSeconds: 0.5 });
  assert.deepEqual([song.shot.beats, song.shot.exact, song.shot.seconds], [2, 2.5, 1]);
  // A reference whose own beat was measured (1.5 s at 0.5 s a beat = 3 beats) speaks in beats; at 0.4 s a beat that is 4 beats.
  const c = { id: "yt:c", numbers: { cuts: [1.5, 3, 4.5], seconds: 6, ...shotStats([1.5, 3, 4.5], 6, 0.5), longest: { seconds: 1.5 } } };
  const own = defaultPace([a, b, c], { beatSeconds: 0.4 });
  assert.deepEqual([own.shot.beats, own.shot.exact, own.shot.seconds, ...ids(own.shot)], [4, 3, 1.6, "ref", ["yt:c"]]);
  // A reference saved before medians were kept, with its tempo saved (120 bpm = 0.5 s a beat), speaks in beats too.
  const d = { id: "yt:d", bpm: 120, numbers: { cuts: [1.5, 3, 4.5], seconds: 6, longest: { seconds: 1.5 } } };
  assert.deepEqual([defaultPace([a, b, d], { beatSeconds: 0.4 }).shot.beats, defaultPace([a, b, d], { beatSeconds: 0.4 }).shot.ids], [4, ["yt:d"]]);
  // A very slow reference is kept inside 0.4 to 8 s (exact keeps the 12 s); beats round by ratio.
  const slow = defaultPace([{ id: "yt:s", numbers: { cuts: [12], seconds: 24, longest: { seconds: 12 } } }]);
  // The hold is kept to 8 s too (a clip that is one long shot), with the real length in exact.
  assert.deepEqual([slow.shot.seconds, slow.shot.exact, slow.hold.seconds, slow.hold.exact], [8, 12, 8, 12]);
  assert.deepEqual([3, 0.3, 100, 1.4, 1.5].map(nearestBeats), [4, 1, 8, 1, 2]);
  // A very slow song (100 s a beat) never gives a shot over 8 s.
  assert.equal(defaultPace([a, b], { beatSeconds: 100 }).shot.seconds, 8);
  // Missing data is not a pace: no longest or a zero-length measure falls back to today's hold, and bad input is ignored.
  const noLongest = defaultPace([{ id: "yt:n", numbers: { cuts: [1, 2], seconds: 3 } }]);
  assert.deepEqual([noLongest.shot.source, noLongest.hold.seconds, ...ids(noLongest.hold)], ["ref", 5.5, "today", []]);
  const empty = defaultPace([{ id: "yt:z", numbers: { median: 0, cuts: [], seconds: 0, longest: { seconds: 0 } } }, null]);
  assert.deepEqual([empty.shot.source, empty.hold.source, defaultPace({}).shot.source], ["today", "today", "today"]);
});

test("title: each type card and treatment carries its own reveal, none a blur; a calm title is a plain fade", () => {
  const titleOf = (treatment, tag) => paced("promo", 30, { treatment, deck: tag ? { cards: [{ tag }] } : null }).plan.title;
  assert.equal(titleOf("calm").enter, "fade");
  assert.equal(titleOf("story").enter, "lines");
  const enters = Object.fromEntries(["type-mask-rise", "type-fade", "type-blur-in", "type-slide", "type-pop"].map((tag) => [tag, titleOf("calm", tag).enter]));
  assert.deepEqual(enters, { "type-mask-rise": "lines", "type-fade": "fade", "type-blur-in": "fade", "type-slide": "fade-up", "type-pop": "scale" });
});

test("deck cards: compose places punch-in, speed-lines and a signature move one per 5 s, the rest get a ready call", () => {
  const faces = Array.from({ length: 41 }, (_, index) => ({ t: index / 2, faces: [[0.4, 0.2, 0.2, 0.3]], subjects: [{ box: [0.4, 0.2, 0.2, 0.3], kind: "face" }] }));
  const deck = { cards: [{ tag: "punch-in" }, { tag: "type-swap" }, { tag: "speed-lines" }], setPiece: { kind: "move", name: "smear" } };
  const { plan, clips } = paced("promo", 30, { deck, clip: { subjectSamples: faces }, cards: ["rim-light", "finish"] });
  const placed = Object.fromEntries(plan.cards.placed.map((entry) => [entry.card, entry]));
  assert.deepEqual(Object.keys(placed).sort(), ["finish", "punch-in", "smear", "speed-lines"]);
  const times = plan.cards.placed.filter((entry) => entry.layer !== "the scene").map((entry) => entry.at).sort((a, b) => a - b);
  assert.ok(times.every((at, index) => index === 0 || at - times[index - 1] >= 5));
  // The punch-in's shot holds still (no slow push or drift) and punches on the face.
  const ops = footageOps(plan, clips);
  const punch = ops.find((op) => op.op === "move" && op.name === "punch-in");
  assert.deepEqual(punch.point, [50, 35]);
  assert.ok(!ops.find((op) => op.name === punch.layer).animations.some((animation) => /push|drift/i.test(animation.name ?? "")));
  // type-swap and the cut-out treatment are left to one ready call each, on a face for the rim light.
  const missed = Object.fromEntries(plan.cards.missed.map((entry) => [entry.card, entry]));
  assert.equal(missed["rim-light"].ops[0].op, "cut_out");
  assert.equal(missed["type-swap"].ops[0].name, "rewrite");
  assert.ok(plan.words.some((line) => line.startsWith("from your deck: punch-in at")));
  assert.equal(paced("promo", 30, { deck, cards: false }).plan.cards, null);
});

test("out of pictures over the bar beside a spoken line, the body fills with pictures under it, never a gap", () => {
  const still = (t) => ({ t, motion: 0, change: 0.001, bright: 0.5, faces: [] });
  const moving = (t) => ({ ...still(t), motion: 0.1, change: 0.05 });
  const clip = (key, duration, sample, extra = {}) => ({ key, name: key, src: `${key}.mp4`, kind: "camera", width: 1920, height: 1080, duration, in: 0, out: duration, words: [], samples: Array.from({ length: duration * 2 }, (_, index) => sample(index / 2)), shots: [{ start: 0, end: duration }], ...extra });
  const said = [["Wait,", 1, 1.3], ["you", 1.4, 1.6], ["came", 1.7, 1.9], ["back", 2, 2.2], ["for", 2.3, 2.4], ["me?", 2.5, 2.8]].map(([text, start, end]) => ({ text, start, end }));
  const face = (t) => (t >= 0.5 && t <= 3 ? { ...still(t), change: 0.05, faces: [[0.4, 0.2, 0.2, 0.3]] } : still(t));
  // Two pictures over the bar, then none at all.
  for (const clips of [[clip("c0", 20, face, { words: said }), clip("c1", 4, moving), clip("c2", 4, moving), clip("c3", 20, still)], [clip("c0", 20, face, { words: said }), clip("c3", 4, still)]]) {
    const plan = planEdit({ clips, frame: { width: 1920, height: 1080 }, duration: 15, treatment: "punchy", seed: 3, title: "Hi" });
    for (const [index, shot] of plan.shots.entries()) if (index) assert.equal(shot.start, plan.shots[index - 1].end, `a gap before shot ${shot.n}`);
    assert.ok(plan.shots.some((shot) => shot.moment.score < 45));
  }
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
    // compose leaves the seams and the rest as fitted song cues (seam_lock, rest_fit and impact-accent read
    // them), the rest's dropout included, and a marker for the end card's entrance (effect_fit's text rule).
    const cues = footageCues(plan, { endCardStart: 29.6 });
    const song = cues.filter((cue) => cue.name.startsWith("song-"));
    assert.ok(song.every((cue) => cue.kind === "marker" && cue.fitted === true), why);
    for (const seam of plan.song.seams) assert.ok(song.some((cue) => cue.name.startsWith(`song-${seam.kind}-`) && cue.time === seam.at), why);
    assert.ok(song.some((cue) => cue.name.startsWith("song-dropout-") && cue.time === rest.from), why);
    assert.deepEqual(cues.find((cue) => cue.name === "end-card"), { name: "end-card", time: 29.6, kind: "marker" });
    // A second footage scene keeps only its own end-card marker.
    assert.deepEqual(footageCues(plan, { suffix: "-s2" }).map((cue) => cue.name), ["end-card-s2"]);
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

test("brand kit: without fonts it keeps the same colors and motion, and the pair families are listed", () => {
  const withFonts = footageBrand("loud", 3);
  const colorsOnly = footageBrand("loud", 3, { fonts: false });
  assert.equal(colorsOnly.fonts, undefined);
  assert.deepEqual(colorsOnly.colors, withFonts.colors);
  assert.equal(colorsOnly.motion, withFonts.motion);
  assert.ok(withFonts.fonts.every((font) => KINO_PAIR_FAMILIES.includes(font.family)));
  assert.ok(["Anton", "Inter", "Montserrat", "Noto Serif"].every((family) => KINO_OWN_FAMILIES.includes(family)), "pairs, looks and the bundled serif are all kino's own");
});

test("cut facts: pace on each side of the turn, each cut's brightness and hue jump, and cuts moved onto beats only when asked", () => {
  // 6 shots of 1 s with a turn at 3 s: 3 start before it, 3 after.
  const cuts = [1, 2, 3, 4, 5];
  const pace = paceFacts({ cuts, seconds: 6, turn: 3 });
  assert.deepEqual([pace.before.shots, pace.before.median, pace.before.per10, pace.after.shots, pace.after.per10], [3, 1, 10, 3, 10]);
  assert.deepEqual(Object.keys(paceFacts({ cuts, seconds: 6 })), ["all"]);
  assert.match(paceLine(pace, [paceFacts({ cuts: [0.5, 1, 4, 4.5, 5], seconds: 6, turn: 3.5 })], { kind: "drop" }),
    /^pace: before the drop at 3\.00 s 3 shots, median 1\.00 s, 10 per 10 s; after, 3 shots, median 1\.00 s, 10 per 10 s · your 1 reference after their turn: median 0\.50 s, 12\.0 per 10 s$/);
  assert.match(beatLine({ turn: 3, beats: 2, period: 0.5, times: [3, 4, 5], why: "a reason", kind: "drop" }), /every 2 beats \(1\.000 s; a reason\): 3\.00, 4\.00, 5\.00$/);
  // Every frame at 30 fps; each shot one gray level, the last one tinted blue.
  const levelOf = (index) => [40, 60, 70, 140, 150, 160][index];
  const levels = Array.from({ length: 180 }, (_, frame) => {
    const value = levelOf(Math.floor(frame / 30));
    return { t: frame / 30, ...frameLevel(value, value, frame >= 150 ? 230 : value) };
  });
  const facts = cutFacts({ cuts, levels, turn: 3, seconds: 6 });
  assert.equal(facts.jumps.length, 5);
  assert.equal(facts.big10, 1.7, "one 50+ jump (70 to 140 at 3 s) in 6 s");
  const brighter = cutFacts({ cuts, levels: levels.map((level) => (level.t >= 1 && level.t < 2 ? { ...level, y: level.y + 60 } : level)), turn: 3, seconds: 6 });
  assert.ok(Math.abs(brighter.jumps[0].dy) > Math.abs(facts.jumps[0].dy) && brighter.big10 > facts.big10, "a brighter shot raises its jump and the 50+ count");
  assert.deepEqual([frameLevel(255, 0, 0).hue, frameLevel(0, 0, 255).hue, frameLevel(100, 102, 101).hue], [0, 240, null]);
  assert.equal(facts.sections.length, 2);
  // Snap: the cuts at 4 and 5 move to the nearest beat times; the cut before the turn stays.
  const shots = [0, 1, 2, 3, 4, 5].map((cue) => ({ id: `S${cue}`, cue, dur: 1 }));
  const snapped = cutsOnBeats(shots, { turn: 3, times: [3.1, 3.6, 4.1, 4.6, 5.1, 5.6] });
  assert.deepEqual(snapped.shots.map((shot) => shot.cue), [0, 1, 2, 3.1, 4.1, 5.1]);
  assert.equal(snapped.shots.at(-1).cue + snapped.shots.at(-1).dur, 6, "the board's end stays");
  assert.deepEqual(snapped.moved.map((entry) => entry.id), ["S3", "S4", "S5"]);
  // A shot that a move would lengthen past what its clip file has keeps its cut (S3's 3 to 3.1 grows S2).
  const short = cutsOnBeats(shots, { turn: 3, times: [3.1, 3.6, 4.1, 4.6, 5.1, 5.6], fits: (shot, dur) => !(shot.id === "S2" && dur > 1.05) });
  assert.deepEqual(short.shots.map((shot) => shot.cue), [0, 1, 2, 3, 4.1, 5.1]);
  assert.deepEqual(short.kept, [{ id: "S3", at: 3, to: 3.1 }]);
  // A shot with drop:true (the agent pinned the song's drop to its cut) keeps its cut on the drop.
  const pinned = cutsOnBeats(shots.map((shot) => (shot.id === "S3" ? { ...shot, drop: true } : shot)), { turn: 3, times: [3.1, 3.6, 4.1, 4.6, 5.1, 5.6] });
  assert.deepEqual([pinned.shots.map((shot) => shot.cue), pinned.moved.map((entry) => entry.id)], [[0, 1, 2, 3, 4.1, 5.1], ["S4", "S5"]]);
  // The render answer's two lines: ours beside the references' range, at most `listed` cuts.
  const lines = cutLines({ ...facts, jumps: facts.jumps, cutCount: 20 }, [{ jumpMedian: 18, big10: 1.9 }, { jumpMedian: 41, big10: 14.9 }], { label: "draft R2", listed: 2 });
  assert.match(lines[0], /^cuts \(draft R2, every frame\): brightness jump median \d+ of 255; 50\+ jumps 1\.7 per 10 s; range 0-3 s \d+-\d+, 3-6 s \d+-\d+ · your 2 measured references: median 18 to 41, 50\+ jumps 1\.9 to 14\.9 per 10 s$/);
  assert.match(lines[1], /^per cut: 1\.00 \+\d+ -, 2\.00 \+\d+ -, \.\.\. \(18 more\)$/);
  assert.deepEqual(cutLines({ jumps: [] }, []), [], "a file with no cuts has no lines");
  assert.match(cutLines(facts, [], { older: 2 })[0], / · 2 saved references measured before cut facts were kept \(library \{topic:"inspire", name:"measure <id>"\} reads one again\)$/);
});

test("cueShows: a drop on a rewound repeat of a shown span says so with unused scanned shots; a drop on an unseen shot says new", () => {
  const shot = (cue, dur, media, inPoint, tags) => ({ cue, dur, media, in: inPoint, tags });
  const door = { light: 30, size: 10, face: false }, climb = { light: 40, size: 20, face: true };
  const pool = [{ label: "F2 shot 9", tags: { light: 45, size: 22, face: true } }, { label: "F2 shot 4", tags: { light: 200, size: 60, face: false } }, { label: "F2 shot 7", tags: {} }];
  const cues = [{ at: 7, kind: "drop" }];
  // The climb plays file 0-4 s at 3-7 s; on the drop it comes back from file 3.5 s (0.5 s rewound).
  const repeat = boardSpans([shot(0, 3, "door.mp4", 0, door), shot(3, 4, "climb.mp4", 0, climb), shot(7, 1, "climb.mp4", 3.5, climb)]);
  const lines = cueShowLines(cueShows({ spans: repeat, cues, seconds: 8, pool }));
  assert.deepEqual(lines, [
    "on the drop at 7.00 s: shot 3 (climb.mp4) repeats 0.5 s of file 3.5-4.5 s shown at 3-7 s; unused scanned shots that differ most: F2 shot 4 (light 200, no face, 60%), F2 shot 9 (light 45, face, 22%)",
    "one take fills 63% of the edit: climb.mp4 (5 s)",
  ]);
  // A reversed clip on the drop playing file 4 s back to 3 s shares 1 s; speed counts the same way.
  const reversed = [...repeat.slice(0, 2), { ...repeat[2], fileAt: (time) => 4 - (time - 7) }];
  assert.equal(cueShows({ spans: reversed, cues, seconds: 8 }).cues[0].shared, 1);
  // A shot that picks up 0.4 s after where the climb stopped continues it (within 1 s).
  assert.match(cueShowLines(cueShows({ spans: boardSpans([shot(0, 3, "door.mp4", 0), shot(3, 4, "climb.mp4", 0), shot(7, 1, "climb.mp4", 4.4)]), cues, seconds: 8 }))[0], /shot 3 \(climb\.mp4\) continues the file 0\.4 s from what played at 3-7 s$/);
  // A drop on a file not shown before is new; a shot with no footage is new too.
  const fresh = boardSpans([shot(0, 3, "door.mp4", 0), shot(3, 4, "climb.mp4", 0), shot(7, 1, "stairs.mp4", 2)]);
  assert.deepEqual(cueShowLines(cueShows({ spans: fresh, cues, seconds: 8 })), ["on the drop at 7.00 s: shot 3 (stairs.mp4) new"]);
  assert.equal(cueShowLines(cueShows({ spans: boardSpans([shot(0, 7, "door.mp4", 0), { cue: 7, dur: 1, media: "none", in: "none" }]), cues, seconds: 8 }))[0], "on the drop at 7.00 s: shot 2 new (no footage)");
  // A shot that began 0.8 s before the drop is no new picture on it; two layers of one file at once count once.
  const held = cueShows({ spans: boardSpans([shot(0, 6.2, "door.mp4", 0, door), shot(6.2, 1.8, "climb.mp4", 0, climb)]), cues, seconds: 8, pool });
  assert.equal(cueShowLines(held)[0], "on the drop at 7.00 s: shot 2 (climb.mp4) on screen since 6.2 s (no cut on it); unused scanned shots that differ most: F2 shot 4 (light 200, no face, 60%), F2 shot 9 (light 45, face, 22%)");
  assert.deepEqual(cueShows({ spans: boardSpans([shot(0, 3, "door.mp4", 0), shot(0, 3, "door.mp4", 0), shot(3, 5, "climb.mp4", 0)]), cues, seconds: 8 }).takes.map((take) => take.seconds), [5]);
});

test("cueShows: the payoff and the longest shot get the same fact off the song's cues; a still shown again and a reversed built shot count", () => {
  const shot = (cue, dur, media, inPoint, extra = {}) => ({ id: `S${cue}`, cue, dur, media, in: inPoint, ...extra });
  // The payoff at 10.95 s brings back file 4-5.5 s of the climb shown at 3-6 s; no song cue falls there.
  const shots = [shot(0, 3, "door.mp4", 0), shot(3, 3, "climb.mp4", 3), shot(6, 4.95, "hall.mp4", 0), shot(10.95, 1.5, "climb.mp4", 4)];
  const story = storyCues({ shots, payoffAt: 10.95, start: 0 });
  assert.deepEqual(story, [{ at: 10.95, kind: "payoff beat" }, { at: 6, kind: "longest shot (4.95 s)" }]);
  assert.deepEqual(cueShowLines(cueShows({ spans: boardSpans(shots), cues: [{ at: 6, kind: "drop" }], story, seconds: 12.45 })), [
    "on the drop and longest shot (4.95 s) at 6.00 s: shot 3 (hall.mp4) new",
    "on the payoff beat at 10.95 s: shot 4 (climb.mp4) repeats 1.5 s of file 4-5.5 s shown at 3-6 s",
  ]);
  // The longest shot opening the edit is new by nature: no line; the payoff on it names both.
  assert.deepEqual(storyCues({ shots: [shot(0, 5, "door.mp4", 0), shot(5, 1, "climb.mp4", 0)], payoffAt: 5, payoffKind: "last shot" }), [{ at: 5, kind: "last shot" }]);
  assert.deepEqual(storyCues({ shots: [shot(0, 1, "door.mp4", 0), shot(1, 5, "climb.mp4", 0)], payoffAt: 1 }), [{ at: 1, kind: "payoff beat, the longest shot (5 s)" }]);
  // A picture (an image file, or media with no in-point) is a still: the same one again says so.
  const stills = boardSpans([shot(0, 2, "poster.png", "none"), shot(2, 2, "door.mp4", 0), shot(4, 1, "poster.png", "none")]);
  assert.equal(cueShowLines(cueShows({ spans: stills, story: [{ at: 4, kind: "payoff beat" }], seconds: 5 }))[0], "on the payoff beat at 4.00 s: shot 3 (poster.png) shows again the still shown at 0-2 s");
  // The board has no reverse: a built layer of the shot playing reversed is read on its clock
  // (file 5.5 back to 4 s), so a payoff shot whose board in-point (9 s) is unseen still repeats.
  const layer = { type: "video", src: "climb.mp4", mediaStart: 10.95, mediaOffset: 4, mediaDuration: 1.5, mediaReverse: true };
  const built = (entry) => (entry.cue === 10.95 ? layer : null);
  const late = [...shots.slice(0, 3), shot(10.95, 1.5, "climb.mp4", 9)];
  assert.equal(cueShows({ spans: boardSpans(late), story, seconds: 12.45 }).cues.at(-1).shared, 0);
  assert.equal(cueShows({ spans: boardSpans(late, undefined, { built }), story, seconds: 12.45 }).cues.at(-1).shared, 1.5);
});
