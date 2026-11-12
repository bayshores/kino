// Speech: the played words of a voice layer, their slips, cut_speech and captions from speech.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { volumeAt } from "./animation.js";
import { voiceLines } from "./mixLevels.js";
import { mediaPlaybackRange } from "./playback.js";
import { defaultFonts } from "./fonts.js";
import { clipSoundsText, SOUND_LISTED, soundEvents } from "./speech.js";
import { findLine, keptRanges, lowerKeptLine } from "./keepLine.js";
import { captionWordsFromSpeech, clipLines, clipLinesText, clipSoundText, readClipSound, cutSpeechIndices, fileWords, shiftScene, speechFlags, speechPieces, speechText, speechWords } from "./speech.js";

// "So we will, we will um try. [mumble] Like, the Oaks app." in file seconds; cut = the quiet point before each word.
const word = (text, start, end, extra = {}) => ({ text, start, end, p: 0.95, cut: Math.max(0, start - 0.04), ...extra });
const transcript = {
  version: 1, model: "test", duration: 12,
  words: [
    word("So", 1, 1.2), // 0
    word("we", 1.3, 1.45), // 1
    word("will,", 1.45, 1.7), // 2
    word("we", 1.8, 1.95), // 3
    word("will", 1.95, 2.2), // 4
    word("um", 2.4, 2.7), // 5
    word("try.", 2.8, 3.1), // 6
    word("(unclear)", 4, 4.5, { unclear: true, p: 0 }), // 7
    word("Like,", 6, 6.3), // 8
    word("the", 6.4, 6.5), // 9
    word("Oaks", 6.5, 6.9, { p: 0.3 }), // 10
    word("app.", 6.9, 7.3), // 11
  ],
  tail: 7.4,
};

const voice = (values = {}) => createLayer("audio", { id: "vo", name: "vo.wav", src: "/api/media/vo.wav", mediaSourceDuration: 12, ...values });

function documentWith(layers, duration = 12, extra = {}) {
  return parseDocument({ ...createDocument(), ...extra, scenes: [createScene({ id: "s", duration, layers })] });
}

function cut(document, fields) {
  const operation = { type: "cut_speech", sceneId: "s", layerId: "vo", transcript, ...fields };
  const reports = new Map();
  const next = parseDocument(applyOperations(document, [operation], { reports }));
  const scene = next.scenes[0];
  return { document: next, scene, report: reports.get(operation), pieces: speechPieces(scene, scene.layers.find((layer) => layer.id === "vo")) };
}

test("speechWords places the file's words where the scene plays them", () => {
  const document = documentWith([voice({ mediaStart: 2, mediaOffset: 1 })]);
  const scene = document.scenes[0];
  const words = speechWords(scene, speechPieces(scene, scene.layers[0]), transcript);
  assert.equal(words[0].index, 0);
  assert.equal(words[0].start, 2); // file 1 s plays at scene 2 s
  assert.equal(words.at(-1).start, 7.9);
});

test("speechFlags names repeats, fillers, maybe-fillers, unclear sound, unsure words and long pauses", () => {
  const document = documentWith([voice()]);
  const scene = document.scenes[0];
  const flags = speechFlags(speechWords(scene, [scene.layers[0]], transcript));
  assert.deepEqual(flags.repeat, [[1, 2]]);
  assert.deepEqual(flags.filler, [[5]]);
  assert.deepEqual(flags.maybe, [[8]]);
  assert.deepEqual(flags.unclear, [[7]]);
  assert.deepEqual(flags.low, [[10]]);
  assert.deepEqual(flags.pause.map((pause) => pause.before), [7, 8]);
});

test("speechText lists indices and times, pages long transcripts and says how to cut", () => {
  const document = documentWith([voice()]);
  const scene = document.scenes[0];
  const words = speechWords(scene, [scene.layers[0]], transcript);
  const text = speechText({ layerName: "vo.wav", words, transcript });
  assert.match(text, /repeat 1-2 "we will,"/);
  assert.match(text, /filler 5 "um"/);
  assert.match(text, /0:So 1 1:we 1.3/);
  assert.match(text, /‖1.5 8:Like, 6/);
  assert.match(text, /cut_speech \{layer:"vo.wav", words:\[indices\]\}/);
  const paged = speechText({ layerName: "vo.wav", words, transcript, budget: 40 });
  assert.match(paged, /more from [\d.]+s: inspect \{targets:\["speech:vo.wav\[from=/);
  const later = speechText({ layerName: "vo.wav", words, transcript, from: 6 });
  assert.doesNotMatch(later, /0:So/);
  assert.match(later, /8:Like,/);
  // A scene shorter than the file: the answer says the file has more, and [file] lists it all in file seconds.
  const short = documentWith([voice()], 5).scenes[0];
  assert.match(speechText({ layerName: "vo.wav", words: speechWords(short, [short.layers[0]], transcript), transcript }),
    /\n4 more words in the file this scene does not play: inspect \{targets:\["speech:vo.wav\[file\]"\]\}/);
  const whole = speechText({ layerName: "vo.wav", words: fileWords(transcript), transcript, file: true, budget: 40 });
  assert.match(whole, /12 words, 1–7.3s in the file/);
  assert.match(whole, /more from [\d.]+s: inspect \{targets:\["speech:vo.wav\[file,from=/);
  // The names whisper was told and the sentences it heard again alone.
  const reheard = speechText({ layerName: "vo.wav", words, transcript: { ...transcript, names: ["Oak"],
    reheard: [{ start: 5.8, end: 7.2, first: "Like, the Oaks app.", second: "Like, the Oak app.", p: [0.6, 0.8], kept: "second" }] } });
  assert.match(reheard, /heard with the project's names: Oak\n/);
  assert.match(reheard, /re-heard 5.8–7.2s of the file alone, kept the second reading \(confidence 0.6 vs 0.8\): "Like, the Oaks app." \| "Like, the Oak app."/);
  // A cut voice kept on an older transcript says how to hear it with the brief's names.
  assert.match(speechText({ layerName: "vo.wav", words, transcript, pinned: ["Oak"] }),
    /kept on the transcript its cuts were made on \(the brief now names Oak\); to hear it with those: cut_speech \{layer:"vo.wav", restore:"all"\}/);
});

test("cut_speech cuts words into pieces that play back to back, with join fades, and ripples later times", () => {
  const title = createLayer("text", { id: "title", name: "title", text: "Hi", animations: [{ id: "a1", name: "Fade in", kind: "in", easing: "smooth", start: 6, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }] });
  const document = documentWith([voice(), title], 12, { cues: [{ name: "drop", time: 6, kind: "marker" }] });
  const { scene, report, pieces, document: next } = cut(document, { words: [1, 2, 5] });
  // Removed: [1.26, 1.76] (we will,) and [2.36, 2.76] (um).
  assert.equal(report.removed, 0.9);
  assert.equal(report.words, 3);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((piece) => piece.name), ["vo.wav", "vo-2", "vo-3"]);
  assert.equal(pieces[0].id, "vo");
  // A later piece finds the whole voice, though "vo-2" is shorter than "vo.wav".
  assert.deepEqual(speechPieces(scene, pieces[1]).map((piece) => piece.name), ["vo.wav", "vo-2", "vo-3"]);
  assert.deepEqual(pieces.map((piece) => [piece.mediaStart, piece.mediaOffset, piece.mediaDuration]), [[0, 0, 1.26], [1.26, 1.76, 0.6], [1.86, 2.76, 9.24]]);
  // Each piece starts where the one before ends.
  for (let i = 1; i < pieces.length; i += 1) assert.equal(pieces[i].mediaStart, Math.round((pieces[i - 1].mediaStart + pieces[i - 1].mediaDuration) * 1000) / 1000);
  // Join fades: silent at each join, full in between.
  assert.equal(volumeAt(pieces[1], 1.26), 0);
  assert.equal(volumeAt(pieces[1], 1.5), 1);
  assert.ok(volumeAt(pieces[0], 1.259) < 0.15);
  assert.equal(volumeAt(pieces[0], 1.2), 1);
  assert.ok(!pieces[2].animations.some((animation) => animation.name === "Join out"));
  // Later times moved 0.9 s earlier.
  assert.equal(scene.duration, 11.1);
  assert.equal(scene.layers.find((layer) => layer.id === "title").animations[0].start, 5.1);
  assert.equal(next.cues[0].time, 5.1);
  assert.match(report.moved, /1 other layer/);
  // The words left play in order; cut indices are gone and the others keep theirs.
  const words = speechWords(scene, pieces, transcript);
  assert.deepEqual(words.map((item) => item.index), [0, 3, 4, 6, 7, 8, 9, 10, 11]);
  // inspect: the first piece lists the whole voice and the cut words; a later piece only its own words.
  const cutIndices = cutSpeechIndices(pieces, transcript);
  assert.deepEqual(cutIndices, [1, 2, 5]);
  const names = pieces.map((piece) => piece.name);
  const whole = speechText({ layerName: "vo.wav", words, transcript, pieces: names, cut: cutIndices });
  assert.match(whole, /pieces \(cut_speech\): "vo.wav", "vo-2", "vo-3"/);
  assert.match(whole, /cut 1-2 "we will,", 5 "um"; put back: cut_speech \{layer:"vo.wav", restore:\[indices\]\}/);
  const second = words.filter((item) => item.piece === pieces[1]);
  const one = speechText({ layerName: "vo-2", words: second, transcript, voice: "vo.wav", pieces: names, cut: cutIndices });
  assert.match(one, /^speech "vo-2": 2 words/);
  assert.match(one, /piece 2 of 3 of "vo.wav"/);
  assert.doesNotMatch(one, /0:So/);
});

test("cut_speech restore puts cut words back, rejoins pieces without join fades and ripples later", () => {
  const title = createLayer("text", { id: "title", name: "title", text: "Hi", animations: [{ id: "a1", name: "Fade in", kind: "in", easing: "smooth", start: 6, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }] });
  const original = documentWith([voice(), title]);
  const { document } = cut(original, { words: [1, 2, 5] });
  // One word back (sent through piece 2): "um" returns between "will" and "try.", the pieces
  // around it join and keep piece 3's own Duck, the title moves 0.4 s later.
  const third = document.scenes[0].layers.find((layer) => layer.name === "vo-3");
  third.animations.push({ id: "duck", name: "Duck", kind: "custom", easing: "linear", start: 4, duration: 2, from: { volume: 1 }, to: { volume: 0.5 } });
  const some = cut(document, { restore: [5], layerId: document.scenes[0].layers.find((layer) => layer.name === "vo-2").id });
  assert.equal(some.report.layer, "vo.wav");
  assert.ok(some.pieces[1].animations.some((animation) => animation.name === "Duck" && animation.start === 4.4));
  assert.equal(some.report.restored, 0.4);
  assert.equal(some.report.words, 1);
  assert.deepEqual(some.pieces.map((piece) => [piece.name, piece.mediaStart, piece.mediaOffset, piece.mediaDuration]), [["vo.wav", 0, 0, 1.26], ["vo-2", 1.26, 1.76, 10.24]]);
  assert.equal(some.scene.layers.find((layer) => layer.id === "title").animations[0].start, 5.5);
  assert.deepEqual(cutSpeechIndices(some.pieces, transcript), [1, 2]);
  // The first piece remembers the cut words (speech_cut does not hear them), less those put back.
  assert.deepEqual([document.scenes[0].layers.find((layer) => layer.id === "vo").cutWords, some.pieces[0].cutWords, some.pieces[1].cutWords], [[1, 2, 5], [1, 2], undefined]);
  // Words cut off the end leave no gap between pieces, but are remembered too.
  assert.deepEqual(cut(original, { words: [11] }).pieces[0].cutWords, [11]);
  // With the names of the transcript they point into (heardWith), until every cut is back.
  const named = cut(original, { words: [5], transcript: { ...transcript, names: ["Oak"] } });
  assert.deepEqual(named.pieces[0].heardWith, ["Oak"]);
  assert.equal(cut(named.document, { restore: "all" }).pieces[0].heardWith, undefined);
  assert.throws(() => cut(some.document, { restore: [5] }), /word 5 already plays/);
  // Everything back: one piece with its ID, no join fades, the scene and title as before the cut.
  const all = cut(some.document, { restore: "all" });
  assert.equal(all.pieces.length, 1);
  assert.deepEqual([all.pieces[0].id, all.pieces[0].mediaStart, all.pieces[0].mediaOffset, all.pieces[0].mediaDuration], ["vo", 0, 0, 12]);
  assert.ok(!all.pieces[0].animations.some((animation) => /^Join/.test(animation.name)));
  assert.equal(all.scene.duration, 12);
  assert.equal(all.scene.layers.find((layer) => layer.id === "title").animations[0].start, 6);
  assert.throws(() => cut(all.document, { restore: "all" }), /nothing to restore/);
  assert.throws(() => cut(document, { restore: [5], words: [6] }), /its own cut_speech/);
  // ripple:false: the voice rejoins, the title stays.
  const still = cut(document, { restore: "all", ripple: false });
  assert.equal(still.pieces.length, 1);
  assert.equal(still.scene.layers.find((layer) => layer.id === "title").animations[0].start, 5.1);
  // A cut made with ripple:false is restored with ripple:false unless told otherwise: nothing else moves.
  const kept = cut(original, { words: [1, 2, 5], ripple: false });
  const back = cut(kept.document, { restore: "all" });
  assert.deepEqual([back.scene.duration, back.scene.layers.find((layer) => layer.id === "title").animations[0].start, back.pieces[0].cutRipple], [12, 6, undefined]);
  // A cut of pauses only says so on inspect's cut line.
  const paused = cut(original, { pauses: 0.4 });
  assert.match(speechText({ layerName: "vo.wav", words: [], transcript, pieces: paused.pieces.map((piece) => piece.name), cut: cutSpeechIndices(paused.pieces, transcript) }), /cut: pauses only/);
});

test("cut_speech again on a cut voice keeps indices; pauses shortens long gaps; ripple false moves only the voice", () => {
  const document = documentWith([voice(), createLayer("rectangle", { id: "box", name: "box", animations: [{ id: "b1", name: "Fade in", kind: "in", easing: "smooth", start: 8, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }] })]);
  const first = cut(document, { words: [5] });
  const second = cut(first.document, { words: [7], pauses: 0.4, ripple: false });
  assert.ok(second.report.pauses >= 1);
  const words = speechWords(second.scene, second.pieces, transcript);
  assert.ok(!words.some((item) => item.index === 7 || item.index === 5));
  for (let i = 1; i < words.length; i += 1) assert.ok(words[i].start - words[i - 1].end <= 0.41, `gap before ${words[i].index}`);
  // ripple:false: the box and the scene kept their times.
  assert.equal(second.scene.layers.find((layer) => layer.id === "box").animations[0].start, first.scene.layers.find((layer) => layer.id === "box").animations[0].start);
  assert.equal(second.scene.duration, first.scene.duration);
  assert.match(second.report.note, /ripple:false/);
});

test("cut_speech on a video morphs into each later piece (morph seconds, false for plain cuts); a voice has no morph", () => {
  const talk = createLayer("video", { id: "vo", name: "talk.mp4", src: "/api/media/talk.mp4", mediaSourceDuration: 12, width: 1920, height: 1080 });
  const { pieces, report } = cut(documentWith([talk]), { words: [1, 2] });
  assert.deepEqual(pieces.map((piece) => piece.morphIn), [undefined, 0.3]);
  assert.match(report.morph, /0\.3s morph cut at 1 join/);
  assert.deepEqual(cut(documentWith([talk]), { words: [1, 2], morph: false }).pieces.map((piece) => piece.morphIn), [undefined, 0]);
  assert.equal(cut(documentWith([talk]), { words: [1, 2], morph: 0.5 }).pieces[1].morphIn, 0.5);
  assert.throws(() => cut(documentWith([voice()]), { words: [1, 2], morph: 0.3 }), /morph needs a video voice/);
  assert.equal(cut(documentWith([voice()]), { words: [1, 2] }).report.morph, undefined);
});

test("cut_speech pauses by named pace shrinks only pauses over the pace's limit and ripples", () => {
  const { scene, report } = cut(documentWith([voice()]), { pauses: "tight" });
  const words = speechWords(scene, speechPieces(scene, scene.layers[0]), transcript);
  const gap = (index) => { const at = words.findIndex((item) => item.index === index); return Math.round((words[at].start - words[at - 1].end) * 100) / 100; };
  assert.equal(gap(7), 0.25); // 0.9 s after "try." shrinks to 0.25 s
  assert.equal(gap(8), 0.25); // 1.5 s shrinks too
  assert.equal(gap(5), 0.2); // 0.2 s is under tight's 0.35 s: kept as spoken
  assert.equal(report.pauses, 2);
  assert.equal(scene.duration, 12 - 0.65 - 1.25);
  assert.throws(() => cut(documentWith([voice()]), { pauses: "snappy" }), /natural, tight, fast/);
});

test("shift inserts time from at: later layers, animations, cues and the scene move; beat cues stay with a bed; a crowded removal is refused", () => {
  const bed = createLayer("audio", { id: "bed", name: "bed", src: "/api/media/bed.wav", mediaSourceDuration: 30 });
  const win = createLayer("audio", { id: "win", name: "win", src: "/api/media/win.wav", mediaSourceDuration: 2, mediaStart: 6 });
  const title = createLayer("text", { id: "t", name: "title", text: "Hi", animations: [{ id: "a", name: "Fade", kind: "custom", easing: "linear", start: 7, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }, { id: "b", name: "Fade", kind: "custom", easing: "linear", start: 1, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } }] });
  const cues = [{ name: "drop", kind: "beat", time: 8 }, { name: "win", time: 6 }];
  const document = documentWith([bed, win, title], 10, { cues });
  const scene = document.scenes[0];
  const receipt = shiftScene(document, scene, 5, 2);
  assert.equal(scene.duration, 12);
  assert.equal(scene.layers[1].mediaStart, 8);
  assert.deepEqual(scene.layers[2].animations.map((animation) => animation.start), [9, 1]);
  assert.equal(document.cues.find((cue) => cue.name === "win").time, 8);
  assert.equal(document.cues.find((cue) => cue.name === "drop").time, 8); // a beat of the bed, which did not move
  assert.match(receipt.playing, /"bed"/);
  assert.throws(() => shiftScene(document, scene, 9, -2), /"win"/); // win starts at 8, inside 7 to 9
  shiftScene(document, scene, 8, -1); // 7 to 8 is empty
  assert.equal(scene.duration, 11);
  assert.equal(scene.layers[1].mediaStart, 7);
});

test("cut_speech refuses words that do not play, a voice at a speed, and a missing transcript", () => {
  const document = documentWith([voice()]);
  const { document: next } = cut(document, { words: [5] });
  assert.throws(() => cut(next, { words: [5] }), /word 5 does not play/);
  assert.throws(() => cut(documentWith([voice({ mediaSpeed: 2 })]), { words: [1] }), /speed 1/);
  assert.throws(() => applyOperations(document, [{ type: "cut_speech", sceneId: "s", layerId: "vo", words: [1] }]), /not been transcribed/);
});

test("captions from speech follow the cut, leave out fillers and apply fixes", () => {
  const document = documentWith([voice()]);
  const { document: next, scene, pieces } = cut(document, { words: [1, 2] });
  const fixed = captionWordsFromSpeech(speechWords(scene, pieces, transcript), { oaks: "Oak", "the oak": "" });
  assert.equal(fixed.left, 2); // um, (unclear)
  assert.deepEqual(fixed.words.map((item) => item.text), ["So", "we", "will", "try.", "Like,", "the", "Oak", "app."]);
  assert.deepEqual(fixed.unused, ["the oak"]);
  const tagged = captionWordsFromSpeech([{ text: "[BLANK_AUDIO]", start: 0, end: 1 }, { text: "Hi.", start: 1, end: 1.4 }, { text: "(upbeat", start: 2, end: 2.5 }, { text: "music)", start: 2.5, end: 3 }]);
  assert.deepEqual(tagged.words.map((item) => item.text), ["Hi."], "sound tags whisper writes are not captioned");
  const operation = { type: "add_captions", sceneId: "s", speechId: "vo", fix: { Oaks: "Oak" }, transcript };
  const reports = new Map();
  const captioned = applyOperations(next, [operation], { reports, fonts: defaultFonts });
  const report = reports.get(operation);
  assert.equal(report.speech.layer, "vo.wav");
  assert.equal(report.speech.fixed, 1);
  const text = captioned.scenes[0].layers.filter((layer) => layer.role === "caption").map((layer) => layer.text).join(" ");
  assert.match(text, /Oak app\./);
  assert.doesNotMatch(text, /\bum\b|Oaks/);
  // The word "we" after the cut plays at scene 1.3 - 0 (nothing before it was cut).
  const we = captioned.cues.find((cue) => cue.name.includes("-we"));
  assert.equal(we.time, 1.3);
});

test("place_broll puts each clip on the word that says its concept, from a shot of its own, and reports misses", () => {
  const clip = (id) => createLayer("video", { id, name: id, src: `/api/media/${id}.mp4`, mediaSourceDuration: 9 });
  const document = documentWith([voice(), clip("phone"), clip("effort"), clip("rocket")]);
  const operation = { type: "place_broll", sceneId: "s", speechId: "vo", layerIds: ["phone", "effort", "rocket"], about: ["the Oaks app", "trying hard", "rocket launch"], transcript,
    shots: { phone: [{ start: 0, end: 0.8 }, { start: 0.8, end: 5 }], effort: null } };
  const reports = new Map();
  const scene = parseDocument(applyOperations(document, [operation], { reports })).scenes[0];
  const layer = (id) => scene.layers.find((item) => item.id === id);
  // "Oaks" (6.5 s) in, 0.2 s early; out after "app." ends the sentence; shot 1 is too short.
  assert.deepEqual([layer("phone").mediaStart, layer("phone").mediaDuration, layer("phone").mediaOffset, layer("phone").mediaFreeze], [6.3, 1.15, 0.84, "none"]);
  // "try." (2.8 s) ends its sentence at once: the clip still holds 1 s; no shots known, file start kept.
  assert.deepEqual([layer("effort").mediaStart, layer("effort").mediaDuration, layer("effort").mediaOffset ?? 0], [2.6, 1, 0]);
  assert.equal(layer("rocket").mediaStart ?? 0, 0);
  const report = reports.get(operation);
  assert.match(report.placed[1], /phone 6\.3–7\.45 s on "Oaks" \(word 10, also app\), shot 2/);
  assert.match(report.unmatched[0], /rocket: no word of "rocket launch" is said/);
});

const musicLayer = () => createLayer("audio", { id: "music", name: "music", src: "/api/media/song.mp3", mediaSourceDuration: 30 });

test("keep_line keeps the named words audible, silences the rest, subtitles the words and dips the music", () => {
  const clip = createLayer("video", { id: "clip", name: "clip", src: "/api/media/clip.mp4", mediaSourceDuration: 12, mediaStart: 1, mediaOffset: 0 });
  const document = documentWith([clip, musicLayer()], 12);
  const operation = { type: "keep_line", sceneId: "s", layerId: "clip", line: "we will, we will", transcript };
  const reports = new Map();
  const next = parseDocument(applyOperations(document, [operation], { reports, fonts: defaultFonts }));
  const scene = next.scenes[0];
  const kept = scene.layers.find((layer) => layer.id === "clip");
  const music = scene.layers.find((layer) => layer.id === "music");
  const report = reports.get(operation);
  // Words 1-4 are said at file 1.3-2.2 s; the clip plays from scene 1 s, so the scene plays them 1 s later.
  assert.deepEqual(report.scene, [2.3, 3.2]);
  assert.deepEqual(report.file, [1.3, 2.2]);
  assert.equal(report.line, "we will, we will");
  assert.equal(volumeAt(kept, 1.5), 0, "before the line: silent");
  assert.equal(volumeAt(kept, 3), 1, "in the line: the layer's own volume");
  assert.equal(volumeAt(kept, 5), 0, "after the line: silent");
  assert.ok(scene.layers.some((layer) => layer.role === "caption" && /we will, we will/.test(layer.text)), "a subtitle holds the words");
  assert.equal(volumeAt(music, 3), 0.7, "the music dips to 0.7 of its volume under the line (about 3 dB)");
  assert.equal(volumeAt(music, 8), 1, "and is at full away from it");
  assert.match(report.duck.summary, /music ducked to 0\.7/);
  assert.ok(report.notes.some((note) => /dips to 0\.7 .*dip:<0 to 1> sets it/.test(note)), "the receipt states the dip and its parameter");
  // Lenient: case, punctuation, a missing apostrophe-free spelling, a repeat said fewer times, a last word typed short.
  const find = (line) => { const found = new Map(); const op = { type: "keep_line", sceneId: "s", layerId: "clip", line, transcript, subtitle: false }; applyOperations(document, [op], { reports: found, fonts: defaultFonts }); return found.get(op); };
  assert.deepEqual(find("WE WILL").scene, [2.3, 2.7], "case and punctuation");
  assert.deepEqual(find("we will we will we will").scene, [2.3, 3.2], "a repeat typed more times than heard takes the whole repeat");
  assert.deepEqual(find("like the oak").scene, [7, 7.9], "a last word typed short");
  assert.match(find("the Oaks app is the best").notes[0], /kept the first 3 of 6 typed words/);
  assert.throws(() => find("we never said this"), /Heard there: "So we will, we will.*try\." 2-4\.1 s · "Like, the Oaks app\." 7-8\.3 s/);
  // A second line on the same layer keeps the first.
  const second = parseDocument(applyOperations(next, [{ type: "keep_line", sceneId: "s", layerId: "clip", line: "the Oaks app", transcript, subtitle: false }], { fonts: defaultFonts })).scenes[0];
  const again = second.layers.find((layer) => layer.id === "clip");
  assert.deepEqual([volumeAt(again, 3), volumeAt(again, 5), volumeAt(again, 7.7)], [1, 0, 1]);
  // A sound tag glued to the last word ("app.(laughs)") does not hide it: the line is found as clipLines shows it.
  const tagged = { ...transcript, words: transcript.words.map((item) => (item.text === "app." ? { ...item, text: "app.(laughs)" } : item)) };
  const reportsTagged = new Map();
  const taggedOp = { type: "keep_line", sceneId: "s", layerId: "clip", line: "the Oaks app.", transcript: tagged, subtitle: false };
  applyOperations(document, [taggedOp], { reports: reportsTagged, fonts: defaultFonts });
  assert.equal(reportsTagged.get(taggedOp).file[1], 7.3);
  // A typed subtitle over a stretch kino heard as other words is kept (no refusal); the receipt says what it heard next to it.
  const typedOver = { type: "keep_line", sceneId: "s", layerId: "clip", from: 2.3, to: 3.2, text: "Where do you say?", transcript };
  const reportsTyped = new Map();
  applyOperations(document, [typedOver], { reports: reportsTyped, fonts: defaultFonts });
  assert.equal(reportsTyped.get(typedOver).heard, "we will, we will");
  assert.equal(reportsTyped.get(typedOver).notes[0], 'kino heard "we will, we will" in that stretch; the subtitle shows your text "Where do you say?"');
  // The same words with other case and punctuation say nothing extra.
  const sameWords = { ...typedOver, text: "We will we will." };
  const reportsSame = new Map();
  applyOperations(document, [sameWords], { reports: reportsSame, fonts: defaultFonts });
  assert.ok(!(reportsSame.get(sameWords).notes ?? []).some((note) => /kino heard/.test(note)));
  // The same stretch sent again without words keeps the typed subtitle and names it (the transcript's words would replace chosen ones).
  const againOp = { type: "keep_line", sceneId: "s", layerId: "clip", from: 2.3, to: 3.2, transcript };
  const reportsAgain = new Map();
  const againScene = parseDocument(applyOperations(parseDocument(applyOperations(document, [typedOver], { fonts: defaultFonts })), [againOp], { reports: reportsAgain, fonts: defaultFonts })).scenes[0];
  assert.deepEqual(againScene.layers.filter((layer) => layer.role === "caption").map((layer) => layer.text), ["Where do you say?"]);
  assert.deepEqual(reportsAgain.get(againOp).subtitle, { name: "line-at-2.3s", kept: true });
  assert.match(reportsAgain.get(againOp).notes[0], /^the subtitle line-at-2\.3s \("Where do you say\?"\) already shows over this line, so it stays and no new one is made; text:"<the words said>" with name:"line-at-2\.3s" replaces it$/);
  // One heard word ("try." at 3.8-4.1 s) in a stretch from 3.5 s: its page stays inside the line and its fade down (to 4.22 s,
  // not 4.63 s), starting earlier to be read; the receipt prints the word and how sure the transcript was.
  const oneWord = { type: "keep_line", sceneId: "s", layerId: "clip", from: 3.5, to: 4.1, transcript };
  const reportsOne = new Map();
  applyOperations(document, [oneWord], { reports: reportsOne, fonts: defaultFonts });
  assert.deepEqual(reportsOne.get(oneWord).subtitle.at, [3.5, 4.22]);
  assert.ok(reportsOne.get(oneWord).notes.includes('the subtitle shows the 1 word the transcript heard there (try. p 0.95; a clip line needs 2 or more words at mean p 0.5); if the clip says other words, text:"<the words said>" puts them on the subtitle'));
  // Another voice's caption track of other words over the line, and a credit text of role caption, are not this
  // line's subtitle: the line gets its own, the track is named and kept whole.
  const track = { type: "add_captions", sceneId: "s", words: [{ text: "Our", start: 0.5, end: 0.8 }, { text: "city.", start: 0.8, end: 1.2 }, { text: "And", start: 2.2, end: 2.5 }, { text: "tonight.", start: 2.5, end: 3.4 }] };
  const credit = createLayer("text", { id: "credit", name: "credit", text: "Filmed on location", role: "caption" });
  const overTrack = { ...operation, subtitle: undefined };
  const reportsTrack = new Map();
  const trackDoc = parseDocument(applyOperations(documentWith([clip, musicLayer(), credit], 12), [track, overTrack], { reports: reportsTrack, fonts: defaultFonts }));
  assert.equal(reportsTrack.get(overTrack).subtitle.name, "line-at-2.3s");
  assert.deepEqual(trackDoc.scenes[0].layers.filter((layer) => layer.role === "caption").map((layer) => layer.text), ["Filmed on location", "Our city.", "And tonight.", "we will, we will"]);
  assert.ok(reportsTrack.get(overTrack).notes.includes('the caption group captions ("And tonight.", other words than heard here) also show over this line; subtitle:false keeps them alone'));
  // A page of a longer track that shows this line's words stays; its call changes that page only.
  const ownTrack = { type: "add_captions", sceneId: "s", words: [{ text: "So", start: 2, end: 2.3 }, { text: "we", start: 2.3, end: 2.45 }, { text: "will.", start: 2.45, end: 3.2 }, { text: "Like", start: 7, end: 7.4 }, { text: "this.", start: 7.4, end: 7.9 }] };
  const reportsOwn = new Map();
  applyOperations(document, [ownTrack, overTrack], { reports: reportsOwn, fonts: defaultFonts });
  assert.deepEqual(reportsOwn.get(overTrack).subtitle, { name: "captions", kept: true });
  assert.match(reportsOwn.get(overTrack).notes[0], /already shows over this line, so it stays and no new one is made; update_layer \{layer:"captions-1-text", properties:\{text:"<the words said>"\}\} changes its words, the rest of captions stays$/);
  // The one-word line just before another kept line (4.2 s, joined to it by the fades): its page is down 2 frames
  // before that line (4.133 s), not at 4.22 s.
  const later = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4.2, to: 5, transcript, subtitle: false };
  const before = { ...oneWord };
  const reportsBefore = new Map();
  applyOperations(document, [later, before], { reports: reportsBefore, fonts: defaultFonts });
  assert.deepEqual(reportsBefore.get(before).subtitle.at, [3.5, 4.133]);
  // A clip heard in another language: the subtitle is the words as said, never whisper's English gloss.
  const foreign = { language: "ja", words: [{ text: "殺してやる。", start: 1.3, end: 2.2, p: 0.9 }], english: [{ start: 1.2, end: 2.3, text: "I'll kill you." }] };
  const foreignDoc = parseDocument(applyOperations(document, [{ type: "keep_line", sceneId: "s", layerId: "clip", from: 2.3, to: 3.2, transcript: foreign }], { fonts: defaultFonts }));
  const captions = foreignDoc.scenes[0].layers.filter((layer) => layer.role === "caption").map((layer) => layer.text).join(" ");
  assert.match(captions, /殺してやる/);
  assert.doesNotMatch(captions, /kill/);
});

test("keep_line on a voice cut into pieces silences every piece but the part that plays the line, and a quiet bed dips to 0.7 of itself", () => {
  const document = documentWith([voice(), createLayer("audio", { id: "music", name: "music", src: "/api/media/song.mp3", mediaSourceDuration: 30, volume: 0.3 })]);
  const cut = parseDocument(applyOperations(document, [{ type: "cut_speech", sceneId: "s", layerId: "vo", transcript, words: [5], pauses: "tight" }], {}));
  const operation = { type: "keep_line", sceneId: "s", layerId: "vo", line: "the Oaks app", transcript, subtitle: false };
  const reports = new Map();
  const scene = parseDocument(applyOperations(cut, [operation], { reports, fonts: defaultFonts })).scenes[0];
  const pieces = scene.layers.filter((layer) => layer.name.startsWith("vo"));
  assert.ok(pieces.length >= 3, "the voice was cut into pieces");
  // Heard at one moment inside the line and at one outside it, whichever piece plays them: only the line is audible.
  const audible = (time) => pieces.filter((piece) => time >= (piece.mediaStart ?? 0) && time < (piece.mediaStart ?? 0) + (piece.mediaDuration ?? 99)).map((piece) => volumeAt(piece, time));
  assert.deepEqual(audible(4.5), [1]);
  assert.deepEqual(audible(1), [0]);
  const report = reports.get(operation);
  assert.ok(report.file[1] - report.file[0] > 0.5, "the receipt gives the file seconds of the line on the piece that plays it");
  assert.equal(volumeAt(scene.layers.find((layer) => layer.id === "music"), 4.5), 0.21, "0.7 of the music's own 0.3, not a raise to 0.7");
});

test("keep_line with from, to and text works with no transcript and takes duck none and subtitle false", () => {
  const clip = createLayer("audio", { id: "clip", name: "clip.wav", src: "/api/media/clip.wav", mediaSourceDuration: 12, volume: 0.8 });
  const document = documentWith([clip, musicLayer()], 12);
  const reports = new Map();
  const operation = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, text: "I will see you there.", transcript: { words: [] } };
  const scene = parseDocument(applyOperations(document, [operation], { reports, fonts: defaultFonts })).scenes[0];
  const report = reports.get(operation);
  assert.deepEqual([report.scene, report.volume, report.line], [[4, 6], 0.8, "I will see you there."]);
  assert.equal(volumeAt(scene.layers[0], 5), 0.8);
  assert.equal(volumeAt(scene.layers[0], 2), 0);
  assert.match(scene.layers.find((layer) => layer.role === "caption").text, /I will see you there\./);
  assert.equal(volumeAt(scene.layers.find((layer) => layer.id === "music"), 5), 0.7);
  // A second line adds its own dip at its own depth; the first line's dip stays, and the receipt lists both.
  const more = new Map();
  const secondLine = { type: "keep_line", sceneId: "s", layerId: "clip", from: 9, to: 10, subtitle: false, dip: 0.35 };
  const twice = parseDocument(applyOperations(parseDocument(applyOperations(document, [operation], { fonts: defaultFonts })), [secondLine], { reports: more, fonts: defaultFonts })).scenes[0];
  const song = twice.layers.find((layer) => layer.id === "music");
  assert.deepEqual([volumeAt(song, 5), volumeAt(song, 9.5), volumeAt(song, 7.5)], [0.7, 0.35, 1]);
  assert.match(more.get(secondLine).duck.summary, /3\.85-6\.8 s \(earlier; to 0\.7\) and 8\.85-10\.8 s/);
  // A line kept again inside a dip it shares with a close earlier line resets its part only: the earlier line stays under its dip.
  const close = { type: "keep_line", sceneId: "s", layerId: "clip", from: 6.3, to: 7, subtitle: false, dip: 0.35 };
  const shared = parseDocument(applyOperations(parseDocument(applyOperations(document, [operation, close], { fonts: defaultFonts })), [{ ...close, dip: 0.5 }], { fonts: defaultFonts })).scenes[0];
  // Each line keeps its own level (the close one is not merged into one dip at the deeper value).
  assert.deepEqual([5, 6.6].map((time) => volumeAt(shared.layers.find((layer) => layer.id === "music"), time)), [0.7, 0.5]);
  const plain = new Map();
  const quiet = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, duckNone: true };
  const bare = parseDocument(applyOperations(document, [quiet], { reports: plain })).scenes[0];
  assert.deepEqual([plain.get(quiet).subtitle, plain.get(quiet).duck], ["off", "none"]);
  assert.equal(bare.layers.some((layer) => layer.role === "caption"), false);
  assert.equal(volumeAt(bare.layers.find((layer) => layer.id === "music"), 5), 1);
  assert.throws(() => applyOperations(document, [{ type: "keep_line", sceneId: "s", layerId: "clip", line: "x", transcript: { words: [] } }]), /no words heard/);
});

test("keep_line over measured music levels the line against the music around it, holds the mix, releases on a beat, and dropout hits back on the downbeat", () => {
  // A quiet clip (-24 LUFS, run 8's laugh) under a steady song at -13 LUFS; beats every 0.5 s.
  const flat = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
  const levels = { clip: flat(-24, 12), music: flat(-13, 30) };
  const beats = { music: { beats: Array.from({ length: 60 }, (_, index) => index * 0.5), duration: 30 } };
  const clip = createLayer("audio", { id: "clip", name: "clip.wav", src: "/api/media/clip.wav", mediaSourceDuration: 12 });
  const document = documentWith([clip, musicLayer()], 12);
  const run = (extra) => {
    const reports = new Map();
    const operation = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels, beats, ...extra };
    const scene = parseDocument(applyOperations(document, [operation], { reports })).scenes[0];
    return { report: reports.get(operation), clip: scene.layers.find((layer) => layer.id === "clip"), music: scene.layers.find((layer) => layer.id === "music") };
  };
  // Default: the lift alone (+11 dB to the song's loudest moment) leaves the line at +0 LU over the
  // steady song, so the shallowest dip that reaches 6 LU with the line lifted 12 dB: -5 dB.
  const plain = run({});
  assert.equal(plain.clip.voiceLevel, -12, "the line lifted the most leveling allows");
  assert.equal(Math.round(volumeAt(plain.music, 5) * 1000) / 1000, 0.562, "the shallowest dip that puts the bed 6 LU under the line (-5 dB)");
  assert.deepEqual([plain.report.way, plain.report.mix], ["dip", { line: -12, around: -13, under: -11, change: 2 }]);
  assert.equal(plain.report.ways, "song untouched, line x3.55 (+11 dB): +0 LU over it (6 LU short of +6), 0 dB under the song's loudest moment · dip 0.562 (-5 dB), line x3.98 (+12 dB): +6 LU, 1 dB under the song's loudest moment · music out: the line alone at -13 LUFS");
  assert.ok(plain.report.notes.some((note) => /comes back up on the beat at 6\.5 s/.test(note)), "the release ends on the next beat");
  assert.equal(volumeAt(plain.music, 6.5), 1);
  // The check hears the line where the export puts it: 6 LU over the dipped bed, no voice_under_bed.
  const words = [{ text: "a", start: 4.1, end: 4.9 }, { text: "b", start: 5, end: 5.9 }];
  assert.equal(Math.round(voiceLines(levels.clip, plain.clip, mediaPlaybackRange(plain.clip, 12), words)[0].lufs), -12);
  // lift:true keeps the song untouched and says what the line reaches and how far short it falls.
  const lifted = run({ lift: true });
  assert.deepEqual([volumeAt(lifted.music, 5), lifted.clip.voiceLevel, lifted.report.duck], [1, -13, "none"]);
  assert.match(lifted.report.notes[0], /^song untouched: the line is lifted x3\.55 to -13 LUFS, \+0 LU over the song \(6 LU short of \+6\), 0 dB under the song's loudest moment; lift:"gain" reaches \+6 LU: a \+17 dB gain stage/);
  // A given dip beside lift:true is kept as given, with a note (no refusal).
  const liftAndDip = run({ lift: true, dip: 0.5 });
  assert.equal(volumeAt(liftAndDip.music, 5), 0.5);
  assert.ok(liftAndDip.report.notes.includes("lift:true is set aside: the dip given takes the music down under the line"), liftAndDip.report.notes.join(" | "));
  // A second line 2 s after the first: its own dip would turn the song 3 times in 10 s (volume_churn),
  // so the default shares the first line's dip (one dip under both, the song holds still between them).
  const first = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels, beats };
  const second = { ...first, from: 8, to: 9 };
  const reports = new Map();
  const both = parseDocument(applyOperations(document, [first, second], { reports })).scenes[0];
  const song = both.layers.find((layer) => layer.id === "music");
  assert.deepEqual([5, 7, 8.5, 9.6].map((time) => Math.round(volumeAt(song, time) * 1000) / 1000), [0.562, 0.562, 0.562, 1]);
  assert.equal(reports.get(second).way, "shared");
  assert.match(reports.get(second).notes[0], /^a dip of its own here would turn music's level 3 times in 4 s \(volume_churn\), so the line shares the dip at 4-6 s: one dip at 0\.562 under both, the line at -12 LUFS, \+6 LU over the song there \(measured\)$/);
  // Written after both lines are placed: the first line's note gives the time the shared dip ends.
  assert.match(reports.get(first).notes.join(" | "), /a later line in this edit shares this line's dip: the music is back by 9\.5 s/);
  // A lift sent later on the first line replaces its dip; a dip that also holds the second line stays.
  const lone = parseDocument(applyOperations(document, [first], {}));
  const liftReports = new Map();
  const relift = { ...first, lift: true };
  const lifted1 = parseDocument(applyOperations(lone, [relift], { reports: liftReports })).scenes[0].layers.find((layer) => layer.id === "music");
  assert.deepEqual([volumeAt(lifted1, 5), lifted1.animations.length], [1, 0]);
  assert.match(liftReports.get(relift).notes.join(" | "), /the earlier dip at 3\.85-6\.5 s under this line is removed: the lift replaces it/);
  const kept2 = parseDocument(applyOperations(parseDocument({ ...document, scenes: [both] }), [relift], {})).scenes[0].layers.find((layer) => layer.id === "music");
  assert.equal(Math.round(volumeAt(kept2, 5) * 1000) / 1000, 0.562, "the shared dip holds the other line, so it stays");
  // A dip duck_audio made under a voice-over that also covers the line stays too, and the note names the voice.
  const vo = createLayer("audio", { id: "vo", name: "vo", src: "/api/media/vo.wav", mediaSourceDuration: 7, mediaStart: 2 });
  const voiced = parseDocument(applyOperations(documentWith([clip, vo, musicLayer()], 12), [{ type: "duck_audio", sceneId: "s", layerId: "music", under: ["vo"], to: 0.3 }], {}));
  const voReports = new Map();
  const overVo = parseDocument(applyOperations(voiced, [relift], { reports: voReports })).scenes[0].layers.find((layer) => layer.id === "music");
  assert.deepEqual([3, 5, 8].map((time) => Math.round(volumeAt(overVo, time) * 1000) / 1000), [0.3, 0.3, 0.3]);
  assert.match(voReports.get(relift).notes.join(" | "), /the dip at 1\.85-9\.8 s under this line stays: vo is heard in it too/);
  // A given dip is kept; the receipt prints what it does to the mix (a fact, no refusal).
  assert.deepEqual(run({ dip: 0.35 }).report.mix, { line: -14, around: -13, under: -13.4, change: -0.4 });
  // A quiet bed (a talk over music at -30): the lift alone reaches it, so the song is untouched (no dip).
  const quiet = run({ levels: { clip: flat(-24, 12), music: flat(-30, 30) } });
  assert.deepEqual([quiet.clip.voiceLevel, quiet.report.way, volumeAt(quiet.music, 5), quiet.report.duck], [-16, "lift", 1, "none"]);
  assert.ok(quiet.report.mix.change > 10, "the receipt says the mix rises under the line");
  // The peak cap (backend/line-peak.mjs) lowers the line 3.2 dB: the ways, the mix, the summary and the way note follow it.
  assert.equal(lowerKeptLine(quiet.report, -3.2), true);
  assert.deepEqual(quiet.report.mix, { line: -19.2, around: -30, under: -18.8, change: 11.2 });
  assert.match(quiet.report.ways, /^song untouched, line x1\.74 \(\+4\.8 dB\): \+10\.8 LU over it, 8\.8 dB under the song's loudest moment · no dip needed/);
  assert.match(quiet.report.summary, /mix under the line -18\.8 vs -30 LUFS in the 2 s around \(\+11\.2 LU\)$/);
  assert.equal(quiet.report.notes[0], "song untouched: the line is lifted x1.74 to -19.2 LUFS, +10.8 LU over the song, 8.8 dB under the song's loudest moment");
  // dropout: the music is out under the line and, the downbeat (8 s) being past the default wait (half a bar, 1 s), hits back on the next beat (6.5 s).
  // By default the music keeps a bed 6 LU under the leveled line (-13 - 6 against -13: -6 dB, 0.501, measured).
  const out = run({ dropout: true });
  assert.deepEqual([volumeAt(out.music, 5), volumeAt(out.music, 6.4), volumeAt(out.music, 6.6)], [0.501, 0.501, 1]);
  assert.match(out.report.notes[0], /the music at a bed of 0\.501 under the line \(-6 dB: 6 LU under the line, measured\); dropout:true with dip:0 takes it out$/);
  // dip:0 beside dropout:true takes the music out (no refusal).
  assert.deepEqual([volumeAt(run({ dropout: true, dip: 0 }).music, 5)], [0]);
  assert.match(out.report.notes.join(" "), /hits back on the beat at 6\.5 s \(0\.5 s after the line; the downbeat at 8 s is 2 s after: wait:2 waits for it\)/);
  assert.equal(out.clip.voiceLevel, -13, "alone, the line holds the music's level");
  // A drop at 6.2 s ends the dip there, before the planned beat (6.5 s): the note gives the time the
  // music is back in fact (dm2-b replay: "hits back on the beat at 6.554 s" over a dip back by 6.041).
  const dropped = (() => {
    const reports = new Map();
    const operation = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels, beats, dropout: true, dip: 0 };
    const scene = parseDocument(applyOperations(documentWith([clip, musicLayer()], 12, { cues: [{ name: "drop", time: 6.2, kind: "marker" }] }), [operation], { reports })).scenes[0];
    return { notes: reports.get(operation).notes.join(" | "), music: scene.layers.find((layer) => layer.id === "music") };
  })();
  // The drop is within reach (half a bar after the line): the music stays out until it and hits back on it,
  // and the receipt measures the rise there (a flat test song: the line alone holds its level, +0 LU).
  assert.deepEqual([volumeAt(dropped.music, 6.15), volumeAt(dropped.music, 6.2)], [0, 1]);
  assert.match(dropped.notes, /the music stays out until the song's drop at 6\.2 s, 0\.2 s after the line's last word, and hits back on it: \+0 LU there \(-13 to -13 LUFS, 0\.4 s each side, measured\)/);
  assert.doesNotMatch(dropped.notes, /hits back on the beat/);
  // A dip that joins one already under another line stays down past the beat: the note gives the
  // time the music is back in fact (dm2-b replay: "back up on the beat at 3.331 s" over a dip held to 6.02).
  const other = createLayer("audio", { id: "other", name: "other.wav", src: "/api/media/other.wav", mediaSourceDuration: 12 });
  const later = { type: "keep_line", sceneId: "s", layerId: "other", from: 6.6, to: 8.5, subtitle: false, levels: { ...levels, other: flat(-24, 12) }, beats, dip: 0.5 };
  const joinedReports = new Map();
  const joinedLine = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels: later.levels, beats, dip: 0.5 };
  const joined = parseDocument(applyOperations(documentWith([clip, other, musicLayer()], 12), [later, joinedLine], { reports: joinedReports })).scenes[0];
  const joinedNotes = joinedReports.get(joinedLine).notes.join(" | ");
  const joinedMusic = joined.layers.find((layer) => layer.id === "music");
  assert.deepEqual([6.5, 9].map((time) => volumeAt(joinedMusic, time)), [0.5, 1], joinedNotes);
  assert.match(joinedNotes, /stays down with the dip under the next sound and comes back up at 9 s \(not on the beat at 6\.5 s\)/);
  assert.doesNotMatch(joinedNotes, /comes back up on the beat/);
  // lift:true inside a dip another line made: the note and the mix give the song as heard (6 dB down),
  // not as measured without the dip (dm2-b replay: "-1.3 LU over" with the song held at 0.25).
  const heardReports = new Map();
  const liftLine = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels: later.levels, beats, lift: true };
  applyOperations(documentWith([clip, other, musicLayer()], 12), [{ ...later, from: 3.5, to: 6.5 }, liftLine], { reports: heardReports });
  const liftReport = heardReports.get(liftLine);
  assert.match(liftReport.notes.join(" | "), /a dip already under this stretch holds music at -19 LUFS \(-6 LU from its own -13\): the line is \+6 LU over the song as heard/);
  assert.deepEqual([liftReport.mix.line, liftReport.mix.under], [-13, -12]);
  // wait:2 waits for the downbeat (8 s).
  const waited = run({ dropout: true, dip: 0, wait: 2 });
  assert.deepEqual([volumeAt(waited.music, 5), volumeAt(waited.music, 7.5), volumeAt(waited.music, 8.1)], [0, 0, 1]);
  // A dip given beside dropout:true is the bed.
  assert.equal(volumeAt(run({ dropout: true, dip: 0.5 }).music, 5), 0.5);
  // A line 20 LU under the music, lifted 12 dB, needs a -14 dB dip: the shallowest that reaches 6 LU.
  const dipped = run({ levels: { clip: flat(-33, 12), music: flat(-13, 30) } });
  assert.deepEqual([Math.round(volumeAt(dipped.music, 5) * 1000) / 1000, dipped.clip.voiceLevel], [0.2, -21]);
  // A line 30 LU under it: no dip down to -20 dB reaches, so the music leaves to a measured bed (6 LU
  // under the -31 LUFS line: -24 dB), and the note gives the shortfall and the dip that would hold the mix.
  const faint = run({ levels: { clip: flat(-43, 12), music: flat(-13, 30) } });
  assert.deepEqual([Math.round(volumeAt(faint.music, 5) * 1000) / 1000, volumeAt(faint.music, 8.1)], [0.063, 1], "music at its bed under the line, back on the downbeat");
  assert.ok(faint.report.notes.some((note) => /is 17(\.\d)? LU short of the music at the \+12 dB lift .*a dip cannot hold it: the music sits at a bed of 0\.063 under it; dip:0\.\d+ keeps the music in and holds the mix/.test(note)), faint.report.notes.join(" | "));
  // A given dip is kept as today (no music-out), and its mix change is printed.
  assert.equal(Math.round(volumeAt(run({ levels: { clip: flat(-33, 12), music: flat(-13, 30) }, dip: 0.35 }).music, 5) * 100) / 100, 0.35);
  // Sent again on a song an earlier dip covered from its start: that dip also set fit_music's Fit in
  // to the dipped 0.3. The line is measured over the song as it plays without the dips, so the dip
  // and receipt match a clean song (dm2-a replay: "dip 0.55 (0 dB)", then voice_under_bed -1 LU).
  const earlier = musicLayer();
  earlier.animations = [
    { id: "fit", name: "Fit in", kind: "custom", easing: "linear", start: 0, duration: 1, from: { volume: 0 }, to: { volume: 0.3 } },
    { id: "up", name: "Duck up", kind: "custom", easing: "smooth", start: 7, duration: 0.8, from: { volume: 0.3 }, to: { volume: 1 } },
  ];
  const again = (() => {
    const reports = new Map();
    const operation = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels, beats };
    const scene = parseDocument(applyOperations(documentWith([clip, earlier], 12), [operation], { reports })).scenes[0];
    return { report: reports.get(operation), music: scene.layers.find((layer) => layer.id === "music") };
  })();
  assert.deepEqual(again.report.mix, plain.report.mix);
  // The same shallowest dip as on a clean song (plain above).
  assert.equal(Math.round(volumeAt(again.music, 5) * 1000) / 1000, Math.round(volumeAt(plain.music, 5) * 1000) / 1000);
  assert.equal(Math.round(volumeAt(again.music, 5) * 1000) / 1000, 0.562);
  // Unmeasured: the old 0.7 dip and no line level.
  const old = run({ levels: {}, beats: {} });
  assert.equal(volumeAt(old.music, 5), 0.7);
  assert.equal(old.clip.voiceLevel, undefined);
  // Unmeasured, lift:true still keeps the song untouched; the line plays at its own level.
  const plainLift = run({ levels: {}, beats: {}, lift: true });
  assert.deepEqual([volumeAt(plainLift.music, 5), plainLift.report.duck, plainLift.clip.voiceLevel], [1, "none", undefined]);
  assert.match(plainLift.report.notes.join(" | "), /song untouched \(lift:true\); the line or the music is not measured/);
  // A line already over the song's loudest moment says "over", never a negative "under".
  const loud = run({ levels: { clip: flat(-8, 12), music: flat(-10, 30) }, lift: true });
  assert.match(loud.report.notes[0], /, 4\.1 dB over the song's loudest moment;/);
  // lift:"gain" (dm3-a: a -40.5 line could not pass volume 4): a gain stage on this line only takes a
  // -33.5 line 26.5 dB up, +6 LU over the untouched song, past the 12 dB cap; the noise under it (its
  // -60 gaps) rises as far.
  const quietClip = { clip: { step: 0.1, momentary: Array.from({ length: 120 }, (_, index) => (index % 10 === 9 ? -60 : -33)) }, music: flat(-13, 30) };
  const short = run({ levels: quietClip, lift: true });
  assert.match(short.report.notes[0], /\(14\.5 LU short of \+6\).*; lift:"gain" reaches \+6 LU: a \+26\.5 dB gain stage on this line only \(x21\.13\): the line -33\.5 -> -7 LUFS, the noise under it -60 -> -33\.5 LUFS, the master limiter after it$/);
  const gained = run({ levels: quietClip, lift: "gain" });
  assert.deepEqual([volumeAt(gained.music, 5), gained.report.duck, gained.report.way, gained.clip.voiceLevel, gained.clip.voiceLift], [1, "none", "gain", -7, 26.6]);
  assert.deepEqual(gained.report.gain, { db: 26.5, line: [-33.5, -7], noise: [-60, -33.5] });
  assert.match(gained.report.notes[0], /^song untouched: a \+26\.5 dB gain stage on this line only .* \+6 LU over the song, \d+(\.\d)? dB over the song's loudest moment; the master limiter after it$/);
  // The check hears it where the export puts it (leveled past 12 dB on the kept stretch).
  assert.equal(Math.round(voiceLines(quietClip.clip, gained.clip, mediaPlaybackRange(gained.clip, 12), words)[0].lufs), -7);
  // Kept again with lift:true, the gain stage goes.
  assert.equal(parseDocument(applyOperations(parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [gained.clip, gained.music] }] }), [{ type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels: quietClip, beats, lift: true }])).scenes[0].layers[0].voiceLift, undefined);
  // Another line kept on the layer later keeps the first line's gain stage.
  assert.equal(parseDocument(applyOperations(parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [gained.clip, gained.music] }] }), [{ type: "keep_line", sceneId: "s", layerId: "clip", from: 8, to: 9.5, subtitle: false, levels: quietClip, beats, lift: true }])).scenes[0].layers[0].voiceLift, 26.6);
  // On a clip under volume 1 (a bed at 0.38, -8.4 dB) the file is leveled past 0 LUFS, so the check
  // hears the line where the receipt says (it was held at voiceLevel 0, -8.4 LUFS against -7 printed).
  const bedReports = new Map();
  const bedLine = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, beats, lift: "gain", levels: { ...quietClip, clip: { step: 0.1, momentary: quietClip.clip.momentary.map((value) => (value > -60 ? -20 : value)) } } };
  const bedClip = parseDocument(applyOperations(parseDocument({ ...document, scenes: [{ ...document.scenes[0], layers: [{ ...clip, volume: 0.38 }, document.scenes[0].layers[1]] }] }), [bedLine], { reports: bedReports })).scenes[0].layers[0];
  assert.deepEqual([bedReports.get(bedLine).gain.line[1], bedClip.voiceLevel], [-7, 1.4]);
  assert.equal(Math.round(voiceLines(bedLine.levels.clip, bedClip, mediaPlaybackRange(bedClip, 12), words)[0].lufs), -7);
  // level:<dB> moves this line by that many dB on voiceLevel, and the receipt prints the line over the song.
  const base = run({ levels, beats, lift: true });
  const louder = run({ levels, beats, lift: true, level: 3 });
  assert.equal(louder.clip.voiceLevel, Math.round((base.clip.voiceLevel + 3) * 10) / 10);
  assert.deepEqual([louder.report.level.db, louder.report.mix.line - base.report.mix.line], [3, 3]);
  assert.match(louder.report.notes.join(" | "), /level \+3 dB on this line only: it plays at -?[\d.]+ LUFS, [+-][\d.]+ LU over the song \(-?[\d.]+ LUFS under it\); stored as voiceLevel/);
  assert.equal(run({ levels, beats, lift: true, level: -4 }).report.level.db, -4);
  // The dB is stored (voiceShift): keep_line of the line again without level keeps it; level:0 clears it.
  const twice = (first, second) => {
    const reports = new Map();
    const make = (extra) => ({ type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, levels, beats, ...extra });
    const operation = make(second);
    const scene = parseDocument(applyOperations(parseDocument(applyOperations(document, [make(first)])), [operation], { reports })).scenes[0];
    return { report: reports.get(operation), clip: scene.layers.find((layer) => layer.id === "clip") };
  };
  const kept = twice({ lift: true, level: 3 }, { lift: true });
  assert.deepEqual([kept.clip.voiceShift, kept.clip.voiceLevel, kept.report.level.kept], [3, louder.clip.voiceLevel, true]);
  const cleared = twice({ lift: true, level: 3 }, { lift: true, level: 0 });
  assert.deepEqual([cleared.clip.voiceShift, cleared.clip.voiceLevel, cleared.report.level], [undefined, base.clip.voiceLevel, undefined]);
  assert.throws(() => run({ levels, beats, level: "loud" }), /level is dB to add/);
  // A raise past the 12 dB lift cap stores the gain stage too.
  assert.ok(run({ levels: quietClip, lift: "gain", level: 6 }).clip.voiceLift > gained.clip.voiceLift);
});

test("two music-out lines 0.6 s apart share a low bed, not silence, and the song lands its drop after the last word", () => {
  // Lines too quiet for any dip (-43 LUFS under a -13 song) at 1.9-2.9 and 3.5-5.8 s, a drop at 6.04 s (dm2-b's shape).
  const flat = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
  const levels = { clip: flat(-43, 14), music: flat(-13, 30) };
  const beats = { music: { beats: Array.from({ length: 60 }, (_, index) => index * 0.5), duration: 30 } };
  const clip = createLayer("audio", { id: "clip", name: "clip.wav", src: "/api/media/clip.wav", mediaSourceDuration: 14 });
  const document = documentWith([clip, musicLayer()], 14, { cues: [{ name: "drop", time: 6.04, kind: "marker" }] });
  const run = (extra = {}) => {
    const reports = new Map();
    const first = { type: "keep_line", sceneId: "s", layerId: "clip", from: 1.9, to: 2.9, subtitle: false, levels, beats, ...extra };
    const second = { ...first, from: 3.5, to: 5.8 };
    const kept = parseDocument(applyOperations(document, [first, second], { reports }));
    const music = kept.scenes[0].layers.find((layer) => layer.id === "music");
    return { kept, music, first: reports.get(first), second: reports.get(second) };
  };
  const { kept, music, first, second } = run();
  // A plain duck_audio sent after keep_line keeps the bed it measured (it rebuilt the dips: 0.063 became 0.1 and 0.56).
  const transcript = { words: [{ text: "one", start: 1.9, end: 2.9, p: 1 }, { text: "two", start: 3.5, end: 5.8, p: 1 }] };
  const plainDuck = { type: "duck_audio", sceneId: "s", layerId: "music", under: ["clip"], speech: { clip: transcript }, levels };
  const duckReports = new Map();
  const ducked = applyOperations(kept, [plainDuck], { reports: duckReports }).scenes[0].layers.find((layer) => layer.id === "music");
  assert.deepEqual([2.5, 3.2, 5, 6.04].map((time) => Math.round(volumeAt(ducked, time) * 1000) / 1000), [0.063, 0.063, 0.063, 1]);
  assert.equal(duckReports.get(plainDuck).keptLines, "keep_line set the music under clip.wav 1.9-2.9 s (music at 0.063), clip.wav 3.5-5.8 s (music at 0.063), measured: kept; keep_line on that line again, or duck_audio {replace:true}, changes it");
  // The gap holds the bed (0.063: -24 dB, 6 LU under the -31 LUFS lines), never 0; the song is back at full on the drop, not before.
  assert.deepEqual([2.5, 3.2, 5, 6.0, 6.04].map((time) => Math.round(volumeAt(music, time) * 1000) / 1000), [0.063, 0.063, 0.063, 0.063, 1]);
  assert.deepEqual(second.bed, { at: [2.9, 3.5], bed: 0.063 });
  assert.match(second.notes.join(" | "), /share one dip: the music holds a bed at 0\.063 \(-24 dB; 6 LU under the quietest line, -31 LUFS, measured\) through it instead of going out, -37 LUFS measured in the 0\.6 s between them at 2\.9-3\.5 s; dropout:true with dip:0 keeps the music out there/);
  assert.match(second.notes[0], /; the music at a bed of 0\.063 under the line \(-24 dB: 6 LU under the line, measured\); dropout:true with dip:0 takes it out$/);
  // The rise at the drop, measured: the line over the bed before, the song at full after.
  assert.deepEqual(second.drop, { at: 6.04, cue: "drop", before: -32.2, after: -13, rise: 19.2 });
  // Line 1's notes, duck and mix are written after line 2 joined its dip.
  assert.match(first.notes.at(-1), /^a later line in this edit shares this line's dip: the music is back by 6\.04 s \(3\.1 s after the line\)$/);
  assert.match(first.notes[0], /; the music at a bed of 0\.063 under the line \(-24 dB: 6 LU under the line, measured\)/);
  assert.deepEqual([first.duck.to, first.mix.under], [0.063, -30]);
  assert.match(first.summary, /mix under the line -30 vs -13 LUFS in the 2 s around \(-17 LU\)$/);
  // Its dip as it now plays (line 2 moved its end to the drop and raised it to the bed), in duck and summary; no note says the music goes out.
  assert.equal(first.duck.summary, "music ducked to 0.063 at 1.75-6.04 s (clip.wav)");
  assert.match(first.summary, /; music ducked to 0\.063 at 1\.75-6\.04 s \(clip\.wav\);/);
  for (const report of [first, second]) assert.ok(!report.notes.some((note) => /music goes out under it/.test(note)), report.notes.join(" | "));
  assert.match(first.notes[1], /, so a dip cannot hold it: the music sits at a bed of 0\.063 under it; dip:/);
  // dropout:true asked for the music out: the gap stays silent, and the receipt says so.
  const asked = run({ dropout: true, dip: 0 });
  assert.equal(volumeAt(asked.music, 3.2), 0);
  assert.match(asked.second.notes.join(" | "), /share one dip with the music out \(dip:0\): no music in the 0\.6 s between them at 2\.9-3\.5 s/);
  // A dip given with dropout is the bed under both lines (dm5 a asked 0.15 and got a measured 0.398), and each receipt prints it.
  const given = run({ dropout: true, dip: 0.15 });
  assert.deepEqual([2.5, 3.2, 5].map((time) => Math.round(volumeAt(given.music, time) * 1000) / 1000), [0.15, 0.15, 0.15]);
  assert.deepEqual([given.first.song, given.second.song], [{ layer: "music", under: 0.15, asked: 0.15 }, { layer: "music", under: 0.15, asked: 0.15 }]);
  assert.match(given.second.notes.join(" | "), /share one dip at the dip given, 0\.15, through the 0\.6 s between them at 2\.9-3\.5 s/);
  // Each receipt says its line's level before and after; the clip's own sound under the words is measured (flat: the floor is the line).
  assert.deepEqual(given.first.voiceLevel.before, null);
  assert.equal(given.second.voiceLevel.after, given.kept.scenes[0].layers.find((layer) => layer.id === "clip").voiceLevel);
  assert.deepEqual(given.first.clipSound, { line: -43, floor: -43, under: 0, share: 100 });
});

test("keep_line names the last word cut off where the layer stops, and the peak cap rewrites the level it printed", () => {
  // The layer plays file 0-2.4 s; the transcript's "you" runs to 2.7 s (dm5 b's closing line).
  const clip = createLayer("audio", { id: "clip", name: "end-line", src: "/api/media/clip.wav", mediaSourceDuration: 4, mediaDuration: 2.4 });
  const transcript = { words: [{ text: "gonna", start: 1.6, end: 2.1, p: 1 }, { text: "kill", start: 2.1, end: 2.35, p: 1 }, { text: "you", start: 2.45, end: 2.7, p: 1 }] };
  const reports = new Map();
  const operation = { type: "keep_line", sceneId: "s", layerId: "clip", from: 1.5, to: 2.4, subtitle: false, duckNone: true, transcript };
  applyOperations(documentWith([clip], 6), [operation], { reports });
  const { cut } = reports.get(operation);
  assert.deepEqual([cut.stops, cut.words, cut.wordEnd, cut.longer, cut.until], [2.4, "you", 2.7, 0.42, 2.82]);
  // A level printed before the peak cap gives the line as it plays after it.
  const receipt = { mix: { line: -2, around: -10, under: -1.9, change: 8.1 }, level: { db: 8, line: -2, over: 14, voiceLevel: -2 }, voiceLevel: { before: -10, after: -2 },
    notes: ["level +8 dB on this line only: it plays at -2 LUFS, +14 LU over the song (-16 LUFS under it); stored as voiceLevel -2", "line leveled to -2 LUFS against the music around it (-10); music out under the line"] };
  lowerKeptLine(receipt, -16);
  assert.deepEqual([receipt.level.line, receipt.level.over, receipt.level.peakCap, receipt.voiceLevel.after, receipt.mix.line], [-18, -2, -16, -18, -18]);
  assert.equal(receipt.notes[0], "level +8 dB on this line only: it plays at -18 LUFS after the peak cap took -16 dB, -2 LU over the song (-16 LUFS under it); stored as voiceLevel -18");
  assert.equal(receipt.notes[1], "line leveled to -18 LUFS (the peak cap took -16 dB) against the music around it (-10); music out under the line");
});

test("five adjacent kept lines each keep their own dip, the song moves between their levels in the gaps and is full on the drop", () => {
  // dm4 a's shape: five lines 0.3 s apart before a drop at 7.5 s, each its own clip at its own level, a -13 LUFS song.
  const flat = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
  const lines = [[0.35, 1.5, -20], [1.8, 3, -24], [3.3, 4.5, -33], [4.8, 6, -43], [6.3, 7.3, -22]];
  const levels = { music: flat(-13, 30) };
  const clips = lines.map(([, , lufs], index) => {
    levels[`c${index}`] = flat(lufs, 12);
    return createLayer("audio", { id: `c${index}`, name: `c${index}.wav`, src: `/api/media/c${index}.wav`, mediaSourceDuration: 12 });
  });
  const beats = { music: { beats: Array.from({ length: 60 }, (_, index) => index * 0.5), duration: 30 } };
  const ops = lines.map(([from, to], index) => ({ type: "keep_line", sceneId: "s", layerId: `c${index}`, from, to, subtitle: false, levels, beats }));
  const reports = new Map();
  const song = parseDocument(applyOperations(documentWith([...clips, musicLayer()], 12, { cues: [{ name: "drop", time: 7.5, kind: "marker" }] }), ops, { reports })).scenes[0].layers.find((layer) => layer.id === "music");
  // Each line at its own measured level (main joined them into one 0.2-7.5 s dip at 0.631, leaving the -33 and -43 lines under the song).
  assert.deepEqual([0.9, 2.4, 3.9, 5.4, 6.8, 7.5].map((time) => Math.round(volumeAt(song, time) * 1000) / 1000), [0.631, 0.562, 0.2, 0.063, 0.631, 1]);
  const last = reports.get(ops[4]);
  assert.equal(last.dips, "music under the lines: 0.631 at 0.2-1.5 s · 0.562 at 1.5-3 s · 0.2 at 3-4.5 s · 0.063 at 4.5-6.3 s · 0.631 at 6.3-7.5 s");
  // Every line's receipt gives the dips as they play after the whole edit (the first line's too).
  assert.deepEqual(ops.map((op) => reports.get(op).dips === last.dips), [true, true, true, true, true]);
  // A later plain duck_audio keeps each line's own dip (it merged them into one 0.063 dip, 0.2-8 s, past the drop).
  const duck = { type: "duck_audio", sceneId: "s", layerId: "music", under: clips.map((clip) => clip.id), levels };
  const after = parseDocument(applyOperations(documentWith([...clips, musicLayer()], 12, { cues: [{ name: "drop", time: 7.5, kind: "marker" }] }), [...ops, duck])).scenes[0].layers.find((layer) => layer.id === "music");
  assert.deepEqual([0.9, 2.4, 3.9, 5.4, 6.8, 7.5].map((time) => Math.round(volumeAt(after, time) * 1000) / 1000), [0.631, 0.562, 0.2, 0.063, 0.631, 1]);
  assert.match(last.notes.join(" | "), /the music is back up by 7\.5 s, 0\.2 s after the line ends: the dip ends on the song's section cue there, not on the beat at 8 s/);
  assert.match(reports.get(ops[2]).notes.join(" | "), /the next line's own dip follows on: the music goes from 0\.2 to 0\.063 at 4\.5-4\.8 s instead of coming back up/);
  assert.match(reports.get(ops[3]).notes[0], /the music at a bed of 0\.063 under the line \(-24 dB: 6 LU under the line, measured\); dropout:true with dip:0 takes it out$/);
});

test("keep_line evens the line's loud and quiet words toward its median word with short ramps; even:false keeps them as said", () => {
  // Four words at -24, -24, -12 (loud) and -34 LUFS (quiet) over a steady -13 LUFS song.
  const momentary = new Array(120).fill(null);
  [[40, -24], [45, -24], [50, -12], [55, -34]].forEach(([at, lufs]) => momentary.fill(lufs, at, at + 4));
  const levels = { clip: { step: 0.1, momentary }, music: { step: 0.1, momentary: new Array(300).fill(-13) } };
  const transcript = { words: ["alpha", "bravo", "charlie", "delta"].map((text, index) => ({ text, start: 4 + index * 0.5, end: 4.4 + index * 0.5, p: 1 })) };
  const clip = createLayer("audio", { id: "clip", name: "clip.wav", src: "/api/media/clip.wav", mediaSourceDuration: 12 });
  const document = documentWith([clip, musicLayer()], 12);
  const run = (extra, from = document) => {
    const reports = new Map();
    const operation = { type: "keep_line", sceneId: "s", layerId: "clip", line: "alpha bravo charlie delta", subtitle: false, transcript, levels, beats: {}, ...extra };
    const scene = parseDocument(applyOperations(from, [operation], { reports })).scenes[0];
    return { report: reports.get(operation), clip: scene.layers.find((layer) => layer.id === "clip") };
  };
  const evened = run({});
  // Median -24: the loud word comes down to 3 LU over it (-9 dB), the quiet one up to 3 LU under (+7 dB).
  assert.deepEqual(evened.report.even, { median: -24, spread: 22, places: [[5, 5.4, -9], [5.5, 5.9, 7]] });
  assert.equal(evened.clip.animations.filter((animation) => animation.name === "Line level").length, 4);
  assert.deepEqual([4.2, 5.2, 5.7].map((time) => Math.round(volumeAt(evened.clip, time) * 1000) / 1000), [1, 0.355, 2.239]);
  assert.match(evened.report.notes.join(" | "), /evened 2 places toward the line's median word \(-24 LUFS; its words spread 22 LU, measured; .*\): 5-5\.4 s -9 dB, 5\.5-5\.9 s \+7 dB; even:false keeps them as said/);
  // The leveling target moves by the line's shift, so the line as a whole stays where the way set it.
  const plain = run({ even: false });
  assert.equal(plain.report.even, undefined);
  assert.equal(plain.clip.animations.some((animation) => animation.name === "Line level"), false);
  assert.ok(evened.clip.voiceLevel > plain.clip.voiceLevel, `${evened.clip.voiceLevel} vs ${plain.clip.voiceLevel}`);
  // A clip played as a bed (volume 0.3) keeps its words as said, and the note gives what even:true
  // would do (evening it made volume_churn warn on the clip). Its kept line is still leveled to its voiceLevel.
  const bedDocument = documentWith([createLayer("audio", { id: "clip", name: "clip.wav", src: "/api/media/clip.wav", mediaSourceDuration: 12, volume: 0.3 }), musicLayer()], 12);
  const bed = run({}, bedDocument);
  assert.equal(bed.clip.animations.some((animation) => animation.name === "Line level"), false);
  assert.deepEqual(bed.report.even, { median: -24, spread: 22, places: [] });
  assert.match(bed.report.notes.join(" | "), /not evened: clip\.wav plays at volume 0\.3, under 0\.5, a bed; the export levels the line to its voiceLevel -5\.5; its words spread 22 LU \(measured\) and 2 places are over 3 LU off its median word; even:true evens them/);
  assert.equal(run({ even: true }, bedDocument).clip.animations.filter((animation) => animation.name === "Line level").length, 4);
});

test("keep_line {sound} keeps the loudest matching scene sound at its own level, with no subtitle, and the music makes room only when masked", () => {
  // Six 1 s windows, half overlapped: music in all, a laugh at -30 dB and a louder one at -18/-17 dB.
  const windows = [0, 0.5, 1, 1.5, 2, 2.5].map((t) => ({ t, d: 1, db: t === 0 ? -30 : t >= 2 ? (t === 2 ? -18 : -17) : -35,
    top: [["music", 0.6], ...(t === 0 || t >= 2 ? [["laughter", 0.8]] : [])] }));
  const { events, bed } = soundEvents(windows);
  assert.deepEqual(bed, ["music"]);
  assert.deepEqual(events.filter((event) => event.label === "laughter").map((event) => [event.start, event.end, event.db]), [[0, 1, -30], [2, 3.5, -17]]);
  assert.equal(clipSoundText({ lufs: -20, sounds: { events, bed } }), "-20.0 LUFS · no voice heard · sounds laughter 2.0-3.5 s (-17 dB), laughter 0.0-1.0 s (-30 dB) · bed music");
  // A less sure label inside a surer one's span is the same moment, so a quieter chime still gets a place.
  const moment = (label, start, end, sure, db) => ({ label, start, end, sure, db });
  assert.equal(clipSoundsText({ events: [moment("speech", 0, 5, 0.98, -15), moment("mosquito_buzz", 0.5, 1.5, 0.65, -15), moment("insect", 0.5, 1.5, 0.61, -15),
    moment("glockenspiel", 5, 6.5, 0.8, -27), moment("mallet_percussion", 5, 6.5, 0.82, -27)] }), "sounds speech 0.0-5.0 s (-15 dB), mallet percussion / glockenspiel 5.0-6.5 s (-27 dB)");
  const flat = (lufs, seconds) => ({ step: 0.1, momentary: new Array(seconds * 10).fill(lufs) });
  const clip = createLayer("audio", { id: "clip", name: "laugh", src: "/api/media/clip.wav", mediaSourceDuration: 12 });
  const document = documentWith([clip, musicLayer()], 12);
  const run = (extra) => {
    const reports = new Map();
    const operation = { type: "keep_line", sceneId: "s", layerId: "clip", sound: "laugh", events: soundEvents(windows, { sure: SOUND_LISTED }).events, ...extra };
    const scene = parseDocument(applyOperations(document, [operation], { reports, fonts: defaultFonts })).scenes[0];
    return { report: reports.get(operation), scene, clip: scene.layers.find((layer) => layer.id === "clip"), music: scene.layers.find((layer) => layer.id === "music") };
  };
  // A quiet laugh (-24 LUFS) under a -13 LUFS song: it keeps its level, the music drops 17 dB to sit 6 LU under it.
  const masked = run({ levels: { clip: flat(-24, 12), music: flat(-13, 30) } });
  assert.deepEqual([masked.report.scene, masked.report.sound.label, masked.report.subtitle], [[2, 3.5], "laughter", "none"]);
  assert.equal(masked.scene.layers.some((layer) => layer.role === "caption"), false);
  assert.equal(masked.clip.voiceLevel, undefined, "a sound is never leveled to the line target");
  assert.deepEqual([volumeAt(masked.clip, 3), volumeAt(masked.clip, 0.5)], [1, 0]);
  assert.equal(Math.round(volumeAt(masked.music, 3) * 1000) / 1000, 0.141);
  assert.deepEqual([masked.report.mix.sound, masked.report.mix.music], [-24, -13]);
  assert.match(masked.report.notes.join(" | "), /also heard laughter 0-1 s/);
  // A loud sound over a quiet bed is not masked: the music stays.
  const clear = run({ levels: { clip: flat(-10, 12), music: flat(-30, 30) } });
  assert.deepEqual([volumeAt(clear.music, 3), clear.report.duck], [1, "none"]);
  assert.throws(() => run({ sound: "gasp" }), /no "gasp" heard where laugh plays\. Heard there: laughter 2-3\.5 s, music 0-3\.5 s, laughter 0-1 s\./);
  assert.throws(() => run({ events: undefined, eventsWhy: "no helper" }), /laugh's sounds are not measured here \(no helper\); give from and to/);
  assert.throws(() => run({ from: 1, to: 2 }), /give one of sound/);
  // A line and a sound kept on one layer: the line keeps its level, the sound plays at its own.
  const levels = { clip: flat(-24, 12), music: flat(-13, 30) };
  const line = { type: "keep_line", sceneId: "s", layerId: "clip", from: 6, to: 8, text: "Hi there", levels };
  const lined = parseDocument(applyOperations(document, [line], { fonts: defaultFonts }));
  const level = lined.scenes[0].layers.find((layer) => layer.id === "clip").voiceLevel;
  assert.ok(Number.isFinite(level));
  const both = parseDocument(applyOperations(lined, [{ type: "keep_line", sceneId: "s", layerId: "clip", sound: "laugh", events: soundEvents(windows, { sure: SOUND_LISTED }).events, levels }], { fonts: defaultFonts }));
  const kept = both.scenes[0].layers.find((layer) => layer.id === "clip");
  assert.equal(kept.voiceLevel, level);
  assert.deepEqual(keptRanges(kept).map((range) => [range.start, range.end, range.sound ?? false]), [[2, 3.5, true], [6, 8, false]]);
});

test("the clip readout names the surest sound under 0.5 as maybe, and keep_line keeps it", () => {
  // A laugh the classifier is 0.43 sure of, over a speech window it is sure of.
  const windows = [0, 1, 2].map((t) => ({ t, d: 1, db: -20, top: [["speech", 0.9], ...(t === 1 ? [["laughter", 0.43], ["giggle", 0.2]] : [])] }));
  const read = soundEvents(windows);
  assert.deepEqual(read.maybe, { label: "laughter", start: 1, end: 2, sure: 0.43, db: -20 });
  assert.equal(clipSoundsText(read), "maybe laughter (0.43) 1.0-2.0 s · bed speech");
  const clip = createLayer("audio", { id: "clip", name: "laugh", src: "/api/media/clip.wav", mediaSourceDuration: 3 });
  const reports = new Map();
  const operation = { type: "keep_line", sceneId: "s", layerId: "clip", sound: read.maybe.label, events: soundEvents(windows, { sure: SOUND_LISTED }).events, duckNone: true };
  applyOperations(documentWith([clip], 3), [operation], { reports, fonts: defaultFonts });
  assert.deepEqual(reports.get(operation).scene, [1, 2]);
});

test("clipLines keeps the lines a clip says, shortest first, and drops sound tags, unsure guesses and one-word noises", () => {
  const word = (text, start, end, p = 0.8, extra = {}) => ({ text, start, end, p, ...extra });
  const transcript = { words: [
    word("(Door", 0.2, 0.5), word("creaks)", 0.5, 0.9), word("Sigh*", 1.2, 1.5), word("Heh", 2, 2.4), word("heh", 2.4, 2.8), word("heh.", 2.8, 3.2, 0.6),
    word("(unclear)", 3.5, 3.8, 0.9, { unclear: true }), word("maybe", 4, 4.3, 0.16), word("so", 4.3, 4.6, 0.16),
    word("I'm", 7.1, 7.4), word("just", 7.4, 7.7), word("gonna", 7.7, 8.3), word("see.(laughs)", 8.3, 9.2), word("Hm", 12, 12.4),
  ] };
  const lines = clipLines(transcript);
  // "Heh heh heh." is one word over and over: a voice, not a line (run 8's laugh, read three ways).
  assert.deepEqual(lines.map((line) => [line.text, line.start, line.end]), [["I'm just gonna see.", 7.1, 9.2]]);
  assert.equal(clipLinesText(lines), 'heard "I\'m just gonna see." 7.1-9.2 s');
  // "Sigh*" is a voice tag, "(Door creaks)" is not; the sigh and the laugh 0.5 s apart join.
  assert.deepEqual(readClipSound(transcript).voice, [{ start: 1.2, end: 3.2 }]);
  assert.equal(clipLinesText([]), "");
  assert.equal(clipLines({ words: [] }).length, 0);
});

test("readClipSound reads a clip whisper tagged as another language as voice, never as sound-alike lines", () => {
  const word = (text, start, end, p = 0.95) => ({ text, start, end, p });
  // A saved transcript of run 8's F4.13 (small.en): the tag lost its opening bracket.
  const other = { words: [word("Singing", 2.77, 2.82), word("in", 2.82, 2.87), word("Japanese)", 2.87, 3.02), word("Yes.", 7.77, 7.91), word("I", 8.84, 9.13), word("see.", 9.13, 9.24)] };
  const read = readClipSound(other);
  assert.deepEqual([read.lines, read.otherLanguage, read.voice], [[], true, [{ start: 2.77, end: 3.02 }, { start: 8.84, end: 9.24 }]]);
  assert.equal(clipSoundText({ lufs: -23.4, ...read }), "-23.4 LUFS · voice heard 2.8-3.0, 8.8-9.2 s, words not read");
  // A tag with its opening bracket ("[Singing in" ... "Japanese]") and an English line beside music.
  assert.deepEqual(readClipSound({ words: [word("[Music", 0, 1), word("plays]", 1, 2)] }), { lines: [], voice: [], otherLanguage: false });
  const english = readClipSound({ words: [word("[Music]", 0, 1), word("What", 1.5, 1.7), word("are", 1.7, 1.8), word("you", 1.8, 1.9), word("doing?", 1.9, 2.3)] });
  assert.equal(clipSoundText({ lufs: -16.1, ...english }), '-16.1 LUFS · heard "What are you doing?" 1.5-2.3 s');
  assert.equal(clipSoundText({ lufs: -18.2, lines: [], voice: [] }), "-18.2 LUFS · no voice heard");
  assert.equal(clipSoundText({ lufs: null }), "");
  // Heard in its own language (transcribe.mjs heard): one word per segment, joined without spaces,
  // with whisper's English, and keep_line finds the joined line as look source prints it.
  const japanese = { language: "ja", languageP: 0.9, words: [word("(歌)", 2.77, 3.02), word("殺してやる", 7.8, 8.5), word("絶対に。", 8.5, 9.2)],
    english: [{ start: 7.7, end: 9.3, text: "I'll kill you, for sure." }] };
  const said = readClipSound(japanese);
  assert.deepEqual(said.lines, [{ text: "殺してやる絶対に。", start: 7.8, end: 9.2, english: "I'll kill you, for sure." }]);
  // The English is marked as a machine gloss wherever it is shown (it can reverse the meaning).
  assert.equal(clipSoundText({ lufs: -23.4, ...said }), '-23.4 LUFS · heard in Japanese (ja, p 0.90): "殺してやる絶対に。" [gloss (machine, unverified): "I\'ll kill you, for sure."] 7.8-9.2 s');
  // A phrase that outlasts its gloss segment (6.2 s against 5.68 s) keeps its own end and its gloss; a
  // segment that runs on past the phrase goes to the line it overlaps most, never to both.
  const long = readClipSound({ language: "ja", words: [word("離線。", 1, 6.2), word("好的。", 6.4, 7.4)],
    english: [{ start: 0.9, end: 5.68, text: "from the line" }, { start: 5.9, end: 7.5, text: "okay" }] });
  assert.deepEqual(long.lines.map((line) => [line.text, line.end, line.english]), [["離線。", 6.2, "from the line"], ["好的。", 7.4, "okay"]]);
  assert.deepEqual(findLine(japanese.words.slice(1), "殺してやる絶対に。")?.words.map((each) => each.at), [7.8, 8.5]);
  // An unsure line in its own language stays voice, as the English pass read it (run 8's F4.3).
  assert.deepEqual(readClipSound({ language: "ja", words: [word("殺してやる。", 1.9, 2.27, 0.43)] }).voice, [{ start: 1.9, end: 2.27 }]);
});

test("readClipSound: a laugh read word by word is voice, music and room tags are not, and a background tag keeps English lines", () => {
  const word = (text, start, end, p = 0.95) => ({ text, start, end, p });
  const voiceOf = (words) => readClipSound({ words }).voice;
  // Run 8's laugh on two other runs: each "Heh." its own sentence, or "Heh, heh," with one unsure word.
  assert.deepEqual(voiceOf(["Heh.", "Heh.", "Heh."].map((text, i) => word(text, 0.4 * i, 0.4 * i + 0.3, [0.16, 0.88, 0.5][i]))), [{ start: 0, end: 1.1 }]);
  assert.deepEqual(voiceOf([word("Heh,", 0.1, 0.3, 0.05), word("heh,", 0.3, 0.6, 0.93)]), [{ start: 0.1, end: 0.6 }]);
  // A score's unsure "Good. Good." (best p 0.34) is not a voice; "No, no, no, wait!" stays a line.
  assert.deepEqual(voiceOf([word("Good.", 0.4, 0.6, 0.02), word("Good.", 1.6, 1.8, 0.34)]), []);
  assert.deepEqual(clipLines({ words: [word("No,", 0, 0.2), word("no,", 0.2, 0.4), word("no,", 0.4, 0.6), word("wait!", 0.6, 1)] }).map((line) => line.text), ["No, no, no, wait!"]);
  // Tags about the music or a room are not a voice; whole words only ("rising" is not "sing").
  for (const tag of [["*sings", "along", "to", "the", "music*"], ["(music", "rising)"], ["(door", "closing)"]]) assert.deepEqual(voiceOf(tag.map((text, i) => word(text, i * 0.2, i * 0.2 + 0.2))), [], tag.join(" "));
  // "(talking in the background)" names no language: the English line beside it stays a line.
  const room = readClipSound({ words: [word("(people", 0, 0.2), word("talking", 0.2, 0.4), word("in", 0.4, 0.5), word("the", 0.5, 0.6), word("background)", 0.6, 1), word("Try", 2, 2.2), word("it", 2.2, 2.3), word("today.", 2.3, 2.8)] });
  assert.deepEqual([room.otherLanguage, room.lines.map((line) => line.text), room.voice], [false, ["Try it today."], [{ start: 0, end: 1 }]]);
  assert.equal(readClipSound({ words: [word("[SPEAKING", 0, 0.5), word("JAPANESE]", 0.5, 1), word("I", 2, 2.2), word("see.", 2.2, 2.5)] }).otherLanguage, true);
});
