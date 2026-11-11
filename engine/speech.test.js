// Speech: the played words of a voice layer, their slips, cut_speech and captions from speech.
import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { volumeAt } from "./animation.js";
import { defaultFonts } from "./fonts.js";
import { captionWordsFromSpeech, clipLines, clipLinesText, cutSpeechIndices, fileWords, shiftScene, speechFlags, speechPieces, speechText, speechWords } from "./speech.js";

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
  assert.equal(volumeAt(music, 3), 0.5, "the music dips by half under the line");
  assert.equal(volumeAt(music, 8), 1, "and is at full away from it");
  assert.match(report.duck.summary, /music ducked to 0\.5/);
  // A second line on the same layer keeps the first.
  const second = parseDocument(applyOperations(next, [{ type: "keep_line", sceneId: "s", layerId: "clip", line: "the Oaks app", transcript, subtitle: false }], { fonts: defaultFonts })).scenes[0];
  const again = second.layers.find((layer) => layer.id === "clip");
  assert.deepEqual([volumeAt(again, 3), volumeAt(again, 5), volumeAt(again, 7.7)], [1, 0, 1]);
});

test("keep_line on a voice cut into pieces silences every piece but the part that plays the line, and a quiet bed dips by half", () => {
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
  assert.equal(volumeAt(scene.layers.find((layer) => layer.id === "music"), 4.5), 0.15, "half of the music's own 0.3, not a raise to 0.5");
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
  assert.equal(volumeAt(scene.layers.find((layer) => layer.id === "music"), 5), 0.5);
  const plain = new Map();
  const quiet = { type: "keep_line", sceneId: "s", layerId: "clip", from: 4, to: 6, subtitle: false, duckNone: true };
  const bare = parseDocument(applyOperations(document, [quiet], { reports: plain })).scenes[0];
  assert.deepEqual([plain.get(quiet).subtitle, plain.get(quiet).duck], ["off", "none"]);
  assert.equal(bare.layers.some((layer) => layer.role === "caption"), false);
  assert.equal(volumeAt(bare.layers.find((layer) => layer.id === "music"), 5), 1);
  assert.throws(() => applyOperations(document, [{ type: "keep_line", sceneId: "s", layerId: "clip", line: "x", transcript: { words: [] } }]), /no words heard/);
});

test("clipLines keeps the lines a clip says, shortest first, and drops sound tags, unsure guesses and one-word noises", () => {
  const word = (text, start, end, p = 0.8, extra = {}) => ({ text, start, end, p, ...extra });
  const transcript = { words: [
    word("(Door", 0.2, 0.5), word("creaks)", 0.5, 0.9), word("Sigh*", 1.2, 1.5), word("Heh", 2, 2.4), word("heh", 2.4, 2.8), word("heh.", 2.8, 3.2, 0.6),
    word("(unclear)", 3.5, 3.8, 0.9, { unclear: true }), word("maybe", 4, 4.3, 0.16), word("so", 4.3, 4.6, 0.16),
    word("I'm", 7.1, 7.4), word("just", 7.4, 7.7), word("gonna", 7.7, 8.3), word("see.(laughs)", 8.3, 9.2), word("Hm", 12, 12.4),
  ] };
  const lines = clipLines(transcript);
  assert.deepEqual(lines.map((line) => [line.text, line.start, line.end]), [["Heh heh heh.", 2, 3.2], ["I'm just gonna see.", 7.1, 9.2]]);
  assert.equal(clipLinesText(lines), 'heard "Heh heh heh." 2.0-3.2 s, "I\'m just gonna see." 7.1-9.2 s');
  assert.equal(clipLinesText([]), "");
  assert.equal(clipLines({ words: [] }).length, 0);
});
