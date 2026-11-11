// The parts of backend/speech/transcribe.mjs that need no real whisper: reading whisper-cli's
// JSON, merging the passes, the names, the second listen, unclear sound, cut points and the
// saved transcript. scripts/speech-hear-check.mjs runs the real whisper by hand.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toneWords, writeFakeWhisper } from "../tests/fake-whisper-cli.mjs";
import { projectNames, speechNamesFor } from "./speech/name-hint.mjs";
import {
  betterReadings, createTranscriptCache, markLoops, mergePasses, TRANSCRIPT_VERSION, transcribeFile, unsureSentences, whisperPrompt,
  withCuts, withUnclear, withoutSlips, wordsFromWhisper,
} from "./speech/transcribe.mjs";

test("wordsFromWhisper joins word pieces and punctuation, skips special tokens and prefers DTW times", () => {
  const words = wordsFromWhisper({ transcription: [{ tokens: [
    { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
    { text: " Zuri", offsets: { from: 100, to: 300 }, t_dtw: 25, p: 0.8 },
    { text: "s", offsets: { from: 300, to: 400 }, t_dtw: 35, p: 0.4 },
    { text: ",", offsets: { from: 400, to: 410 }, p: 0.99 },
    { text: " app", offsets: { from: 500, to: 700 }, p: 0.9 },
  ] }] });
  assert.deepEqual(words.map((word) => [word.text, word.at, word.dtw, word.p]), [["Zuris,", 0.25, true, 0.4], ["app", 0.5, false, 0.9]]);
});

test("withoutSlips and mergePasses take a fine pass's repeat or filler only when the words agree", () => {
  assert.equal(withoutSlips(["We", "we", "um", "went", "there."]), "we went there");
  assert.equal(withoutSlips(["the", "app", "the", "app", "works"]), "the app works");
  const at = (text, time) => ({ text, at: time });
  const coarse = [at("We", 0.1), at("went", 0.5), at("there.", 0.9), at("Then", 2.1)];
  const fine = [[at("We", 0.1), at("we", 0.3), at("um", 0.4), at("went", 0.5), at("there.", 0.9)], [at("When", 2.1)]];
  const merged = mergePasses(coarse, fine, [{ start: 0, end: 1.5 }, { start: 2, end: 3 }]);
  // The first fine chunk heard the same words plus slips; the second heard other words and is not used.
  assert.deepEqual(merged.map((word) => word.text), ["We", "we", "um", "went", "there.", "Then"]);
});

test("withUnclear lists loud sound no word covers; withCuts puts each cut in the quiet before a word", () => {
  // 10 ms frames: quiet (-60 dB) with loud runs at 0.5-0.8 s (a word) and 1.2-1.6 s (no word).
  const db = new Float32Array(200).fill(-60);
  for (let frame = 50; frame < 80; frame += 1) db[frame] = -10;
  for (let frame = 120; frame < 160; frame += 1) db[frame] = -12;
  db[46] = -70; // the quietest point just before the word
  const quiet = [{ start: 0, end: 0.5 }, { start: 0.8, end: 1.2 }, { start: 1.6, end: 2 }];
  const words = withUnclear([{ text: "So", start: 0.5, end: 0.8, p: 0.9 }], { db, level: -50, quiet, duration: 2 });
  assert.deepEqual(words.map((word) => [word.text, word.start, word.end, word.unclear ?? false]), [["So", 0.5, 0.8, false], ["(unclear)", 1.2, 1.6, true]]);
  const cut = withCuts(words, { db, duration: 2 });
  assert.equal(cut[0].cut, 0.465);
  assert.ok(cut[1].cut >= 1.08 && cut[1].cut <= 1.2);
  assert.ok(cut.tail >= 1.6 && cut.tail <= 1.9);
});

test("the transcript is made once per file, model and names, and kept beside the file (not as a .json)", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-speech-cache-"));
  try {
    const file = path.join(folder, "voice.wav");
    await writeFile(file, "sound");
    const runs = [];
    const cache = createTranscriptCache({
      setup: () => ({ command: "whisper-cli", model: "m", modelName: "small.en", dtw: "small.en" }),
      transcribe: async (_file, _setup, { names }) => {
        runs.push(names);
        return { version: TRANSCRIPT_VERSION, model: "small.en", duration: 1, words: [{ text: names.length ? "Zuri" : "David", start: 0.1, end: 0.4, p: 1, cut: 0.05 }], tail: 0.5 };
      },
    });
    assert.equal((await cache.get(file)).cached, false);
    const again = await cache.get(file);
    assert.equal(again.cached, true);
    assert.equal(again.words[0].text, "David");
    // Before the names' transcript is made, saved answers the one made without names.
    assert.equal((await cache.saved(file, { names: ["Zuri"] })).words[0].text, "David");
    // New names are a new transcript, kept in a file of its own.
    assert.equal((await cache.get(file, { names: ["Zuri"] })).words[0].text, "Zuri");
    assert.equal((await cache.saved(file, { names: ["Zuri"] })).words[0].text, "Zuri");
    assert.deepEqual(runs, [[], ["Zuri"]]);
    const files = (await readdir(folder)).sort();
    assert.equal(files.length, 3);
    assert.deepEqual(files.slice(0, 2), ["voice.wav", "voice.wav.words-small.en"]);
    assert.match(files[2], /^voice\.wav\.words-small\.en-[0-9a-f]{8}$/);
    // Names changed since and no transcript without names: only `any` takes the one heard with older names.
    await rm(path.join(folder, "voice.wav.words-small.en"));
    assert.equal(await cache.saved(file, { names: ["Other"] }), null);
    assert.equal((await cache.saved(file, { names: ["Other"], any: true })).words[0].text, "Zuri");
    assert.equal(await cache.saved(file, { names: ["Other"], any: true, exact: true }), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a failed transcript is not tried again for ten minutes; a missing whisper-cli is tried every time", async () => {
  let clock = 0;
  let runs = 0;
  let missing = false;
  const cache = createTranscriptCache({
    setup: () => ({ command: "whisper-cli", model: "m", modelName: "small.en" }), now: () => clock,
    transcribe: async () => {
      runs += 1;
      const error = new Error(missing ? "whisper-cli was not found" : "whisper-cli failed: read_audio_data");
      if (missing) error.code = "SPEECH_TOOL_MISSING";
      throw error;
    },
  });
  await assert.rejects(cache.get("/nowhere/swish.wav"), /read_audio_data/);
  await assert.rejects(cache.get("/nowhere/swish.wav"), /read_audio_data/);
  assert.equal(runs, 1, "the second ask answers the remembered failure");
  clock = 10 * 60_000 + 1;
  await assert.rejects(cache.get("/nowhere/swish.wav"), /read_audio_data/);
  assert.equal(runs, 2, "after ten minutes it is tried again");
  missing = true;
  await assert.rejects(cache.get("/nowhere/voice.wav"), /not found/);
  await assert.rejects(cache.get("/nowhere/voice.wav"), /not found/);
  assert.equal(runs, 4, "a missing tool may be installed any moment");
});

test("a sound shorter than half a second gets an empty transcript without running whisper-cli", async () => {
  const setup = { command: "/nowhere/whisper-cli", model: "m", modelName: "small.en" };
  const transcript = await transcribeFile("swish.wav", setup, { decode: async () => ({ samples: new Float32Array(16_000 * 0.15).fill(0.5) }) });
  assert.deepEqual(transcript.words, []);
  assert.equal(transcript.short, true);
  assert.equal(transcript.version, TRANSCRIPT_VERSION);
});

test("many files transcribed at once are decoded two at a time, not all together", async () => {
  const setup = { command: "/nowhere/whisper-cli", model: "m", modelName: "small.en" };
  let decoding = 0, most = 0;
  const decode = async () => {
    decoding += 1;
    most = Math.max(most, decoding);
    await new Promise((resolve) => setTimeout(resolve, 5));
    decoding -= 1;
    return { samples: new Float32Array(16_000 * 0.15) };
  };
  await Promise.all(Array.from({ length: 6 }, (_, index) => transcribeFile(`clip-${index}.wav`, setup, { decode })));
  assert.equal(most, 2);
});

test("a cut voice keeps reading the transcript its cuts were made on when the brief's names change", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-speech-pin-"));
  try {
    const file = path.join(folder, "voice.wav");
    await writeFile(file, "sound");
    // Made before names were told to whisper (version 1, no names): "David is um here".
    const old = ["David", "is", "um", "here"].map((text, i) => ({ text, start: i, end: i + 0.5, p: 1, cut: i - 0.05 }));
    await writeFile(`${file}.words-small.en`, JSON.stringify({ version: 1, model: "small.en", duration: 4, words: old, tail: 4 }));
    const runs = [];
    const cache = createTranscriptCache({
      setup: () => ({ command: "whisper-cli", model: "m", modelName: "small.en" }),
      transcribe: async (_file, _setup, { names }) => {
        runs.push(names);
        return { version: TRANSCRIPT_VERSION, model: "small.en", duration: 4, words: [{ text: "Zuri", start: 0, end: 0.5, p: 1, cut: 0 }], tail: 4, names };
      },
    });
    const voice = { id: "vo", type: "audio", src: "/api/media/voice", cutWords: [2] }; // "um" cut before this change
    const document = { scenes: [{ layers: [voice] }] };
    const brief = { fields: { message: { text: "a demo of Zuri" } } };
    // The cut voice reads the old transcript, so index 2 is still "um"; nothing is heard again.
    const pin = speechNamesFor(document, brief, voice.src);
    assert.deepEqual(pin, { names: [], pinned: true });
    assert.equal((await cache.get(file, { names: pin.names })).words[2].text, "um");
    assert.equal((await cache.saved(file, { names: ["Zuri"], exact: true })), null);
    // A voice cut on the names' transcript keeps those names when the brief names more.
    voice.heardWith = ["Zuri"];
    assert.deepEqual(speechNamesFor(document, { fields: { message: { text: "a demo of Zuri by Ada" } } }, voice.src).names, ["Zuri"]);
    // An uncut voice is heard with the brief's names.
    delete voice.cutWords;
    assert.deepEqual(speechNamesFor(document, brief, voice.src), { names: ["Zuri"], pinned: false });
    assert.deepEqual(runs, []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("markLoops: a short word whisper writes over and over on noise is unclear sound, a real repeat stays words", async () => {
  const say = (text, start, p) => ({ text, start, end: start + 0.05, p, cut: start - 0.02 });
  // Street noise heard as "Yeah." 6 times, each a little surer and too fast to be said, then a word.
  const street = [0.14, 0.3, 0.38, 0.5, 0.62, 0.7].map((p, i) => say("Yeah.", 18.8 + i * 0.08, p));
  const marked = markLoops([say("target?", 6.6, 0.97), ...street, say("Okay.", 30, 0.9)]);
  assert.deepEqual(marked.map((word) => word.text), ["target?", ...street.map(() => "(unclear)"), "Okay."]);
  assert.equal(marked[1].unclear, true);
  assert.equal(marked[1].heard, "Yeah.");
  assert.equal(marked[1].start, 18.8, "a loop word keeps its place and times");
  // "Mm hmm." over and over (a pair of words), unsure.
  const hum = [0, 1, 2, 3].flatMap((i) => [say("Mm", 55 + i, 0.4), say("hmm.", 55.4 + i, 0.6)]);
  assert.ok(markLoops(hum).every((word) => word.unclear));
  // Said for real: "no, no, no" three times, or four times sure and spaced, stays words.
  const no = (count) => Array.from({ length: count }, (_, i) => say(i === count - 1 ? "no." : "no,", 1 + i * 0.4, 0.92));
  assert.ok(markLoops(no(3)).every((word) => !word.unclear));
  assert.ok(markLoops(no(4)).every((word) => !word.unclear));
  // A transcript saved before this rule is read with its loops marked, at the same indices.
  const folder = await mkdtemp(path.join(tmpdir(), "kino-speech-loop-"));
  try {
    const file = path.join(folder, "street.wav");
    await writeFile(`${file}.words-small.en`, JSON.stringify({ version: 2, model: "small.en", duration: 31, words: [say("target?", 6.6, 0.97), ...street], tail: 31 }));
    const cache = createTranscriptCache({ setup: () => ({ command: "whisper-cli", model: "m", modelName: "small.en" }) });
    const saved = await cache.saved(file);
    assert.deepEqual([saved.words.length, saved.words[0].unclear, saved.words[6].unclear], [7, undefined, true]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the project's names come from the brief and style spec, in alphabetical order, after whisper's verbatim prompt", () => {
  const brief = {
    fields: { message: { text: "zuri guides a man to the bakery", quote: "the judges loved Zuri's voice" },
      look: { text: "Find Your Closest Bakery With ORBO" } }, // Title Case: only ORBO is a name
    log: [{ q: "MODEL\nSAY", a: "Seven open-weight models. One GPU 4090. Made at the Festival with SkyForge tools" }], // a label in capitals names nothing
    style: { avoids: ["zoom-through"], screen: 'BRAIN_URL = os.getenv("BRAIN_URL", "http://127.0.0.1:8101/v1")' }, // code names nothing
  };
  assert.deepEqual(projectNames(brief), ["Festival", "GPU", "ORBO", "SkyForge", "Zuri"]);
  // The same names in another order and count give the same list (and so the same transcript).
  assert.deepEqual(projectNames({ fields: { a: { text: "we made it with GPU and SkyForge, then ORBO at the Festival for the users of Zuri and GPU" } } }), projectNames(brief));
  assert.deepEqual(projectNames(null), []);
  assert.equal(whisperPrompt(["Zuri", "GPU"]), "Um, uh, I I mean, like, we we went there. Zuri, GPU.");
  assert.equal(whisperPrompt([]), "Um, uh, I I mean, like, we we went there.");
  assert.equal(whisperPrompt(["Zuri"], { verbatim: false }), "Zuri.");
});

test("an unsure sentence of a long file is heard again alone and the surer reading is kept", () => {
  const word = (text, start, p, index) => ({ text, start, end: start + 0.3, p, index });
  const words = [
    word("Yo,", 1, 0.9, 0), word("let's", 1.4, 0.9, 1), word("go.", 1.8, 0.9, 2),
    { text: "(unclear)", start: 3, end: 3.4, p: 0, unclear: true },
    word("Is", 3.5, 0.03, 3), word("it", 3.8, 0.8, 4), word("the", 4.1, 0.9, 5), word("best", 4.4, 0.9, 6), word("house?", 4.7, 0.2, 7),
    word("Really?", 6, 0.95, 8),
  ];
  // Only the unsure sentence, with 0.15 s around it that never reaches the words beside it.
  const sentences = unsureSentences(words, 20);
  assert.deepEqual(sentences, [{ start: 2.85, end: 5.15, from: 3, to: 7 }]);
  assert.deepEqual(unsureSentences(words, 5), [], "a short file was one clip already");
  const at = (text, time, p) => ({ text, at: time, p });
  const heard = words.filter((item) => !item.unclear).map((item) => at(item.text, item.start, item.p));
  const surer = [at("This", 3.1, 0.8), at("is", 3.4, 0.7), at("the", 4.1, 0.9), at("best", 4.4, 0.9), at("house.", 4.7, 0.6)];
  const kept = betterReadings(heard, sentences, [surer]);
  assert.deepEqual(kept.heard.map((item) => item.text), ["Yo,", "let's", "go.", "This", "is", "the", "best", "house.", "Really?"]);
  assert.deepEqual(kept.reheard, [{ start: 2.85, end: 5.15, first: "Is it the best house?", second: "This is the best house.", p: [0.57, 0.78], kept: "second" }]);
  // A surer reading of other words (noise heard as speech), or of fewer words, is not used.
  const other = [at("Thank", 3.1, 0.95), at("you", 3.4, 0.95), at("so", 3.7, 0.95), at("much", 4, 0.95), at("everyone.", 4.3, 0.95)];
  assert.equal(betterReadings(heard, sentences, [other]).reheard[0].kept, "first");
  assert.equal(betterReadings(heard, sentences, [surer.slice(2, 4)]).reheard[0].kept, "first");
  // A Whisper loop (one sentence over and over) is unclear sound, and loses to a surer re-hearing
  // that shares none of its words (a real case: "I think that's what we're talking about" x9).
  const line = "I think that's what we're talking about.".split(" ");
  const loop = Array.from({ length: 9 }, (_, n) => line.map((text, i) => at(text, 17 + n * 0.8 + i * 0.1, 0.67))).flat();
  assert.ok(markLoops(loop.map((item) => ({ ...item, start: item.at }))).every((item) => item.unclear));
  const clean = [at("Turn", 17.2, 0.92), at("left", 17.6, 0.92), at("at", 18, 0.92), at("the", 18.3, 0.92), at("light.", 18.6, 0.92)];
  const relooped = betterReadings(loop, [{ start: 17, end: 24, from: 0, to: loop.length - 1 }], [clean]);
  assert.deepEqual([relooped.reheard[0].kept, relooped.heard.length], ["second", 5]);
});

test("transcribeFile hears an unsure sentence again in one more whisper-cli run (stand-in whisper)", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-speech-again-"));
  const before = process.env.FAKE_WHISPER_WORDS;
  try {
    const env = await writeFakeWhisper(folder, ["So", "we", "went.", "Then", "home."]);
    process.env.FAKE_WHISPER_WORDS = env.FAKE_WHISPER_WORDS;
    // Tone 9 is no word on the list: unclear sound inside the second sentence.
    const samples = toneWords([[0, 1, 1.3], [1, 1.5, 1.8], [2, 2, 2.4], [9, 4, 4.4], [3, 4.6, 4.9], [4, 5.1, 5.5]], 10, 16_000);
    const setup = { command: env.KINO_WHISPER_CLI, model: env.KINO_WHISPER_MODEL, modelName: "small.en", dtw: "small.en" };
    const transcript = await transcribeFile("voice.wav", setup, { decode: async () => ({ samples }) });
    assert.deepEqual(transcript.words.map((word) => word.text), ["So", "we", "went.", "(unclear)", "Then", "home."]);
    // The stand-in hears the same words as surely, so the first reading stays.
    assert.equal(transcript.reheard.length, 1);
    const [span] = transcript.reheard;
    assert.deepEqual([span.first, span.second, span.kept], ["Then home.", "Then home.", "first"]);
    assert.ok(span.start >= 3.8 && span.start <= 4 && span.end >= 5.5, JSON.stringify(span));
  } finally {
    if (before === undefined) delete process.env.FAKE_WHISPER_WORDS; else process.env.FAKE_WHISPER_WORDS = before;
    await rm(folder, { recursive: true, force: true });
  }
});
