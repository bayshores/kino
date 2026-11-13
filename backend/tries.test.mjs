// Try rounds (agent/tries.mjs): the agent's question is read and checked, each option's clip is
// rendered from the video with the option's ops, and the person's pick reaches the agent's inbox
// with the ops to apply.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { beatsIn, clipFacts, colorOverlap, cutTimes, lineEntry, lineExit, lineFixText, pickedSketch, sketchKey, sketchLines, sketchOps, songEntry, treatmentDefaults } from "./agent/sketches.mjs";
import { legibleFix } from "../engine/quality/legible.js";
import { coverBox } from "../engine/footage/layout.js";
import { answerText, createTries, readTry } from "./agent/tries.mjs";
import { skipWithoutMediaTools as skip, startTestServer } from "./media.test.support.mjs";

const SCENES = [{ id: "s1", name: "Scene 1", duration: 8.8 }];
const OPTIONS = [{ name: "plain cut", ops: [] }, { name: "half faded", ops: [{ op: "update_layer", layer: "footage", properties: { opacity: 0.5 } }] }];

test("readTry: the moment and its 2 s, 2 to 4 named options, and each refusal in words", () => {
  const read = readTry({ question: "which cut into shot 2?", at: 1.25, options: OPTIONS, later: ["color", "sound"] }, SCENES);
  assert.deepEqual([read.question, read.topic, read.sceneId, read.at, read.from, read.to, read.options.map((option) => option.letter), read.later],
    ["which cut into shot 2?", "which cut into shot 2", "s1", 1.25, 0.25, 2.25, ["A", "B"], ["color", "sound"]]);
  assert.deepEqual([readTry({ question: "q", at: 0.2, options: OPTIONS }, SCENES).from, readTry({ question: "q", at: 8.7, options: OPTIONS }, SCENES).to], [0, 8.8], "kept inside the scene");
  for (const [input, words] of [
    [{ at: 1, options: OPTIONS }, /needs question/],
    [{ question: "q", at: 9, options: OPTIONS }, /at is the moment in seconds, 0 to 8.8/],
    [{ question: "q", at: 1, options: [OPTIONS[0]] }, /2 to 4 options/],
    [{ question: "q", at: 1, options: [OPTIONS[0], { name: "Plain cut", ops: [] }] }, /its own name/],
    [{ question: "q", at: 1, options: [OPTIONS[0], { ops: [] }] }, /options\[1\] needs a name/],
    [{ question: "q", at: 1, scene: "s9", options: OPTIONS }, /scene "s9" is not in this project/],
  ]) assert.throws(() => readTry(input, SCENES), words);
});

test("answerText: a pick names the option and the ops to apply; none and skip say what to do next", () => {
  const round = { id: "T2", question: "which cut into shot 2?", options: readTry({ question: "q", at: 1, options: OPTIONS }, SCENES).options };
  assert.equal(answerText({ ...round, pick: "B", words: "softer" }),
    'try T2 "which cut into shot 2?": the person picked B (half faded) (their note: "softer"). Apply it: edit {"ops":[{"op":"update_layer","layer":"footage","properties":{"opacity":0.5}}]} Then the next round starts from it.');
  assert.match(answerText({ ...round, pick: "A" }), /picked A \(plain cut\)\. It keeps the video as it is\./);
  assert.match(answerText({ ...round, pick: "none" }), /liked none of these\. Try other options/);
  assert.match(answerText({ ...round, pick: "skip" }), /skipped it\. Keep the video as it is/);
});

// Saved treatments as treatments.mjs keeps them: 5 written, 3 shown (A = list[3], B = list[0], C = list[1]).
const TREATMENTS = { list: ["stairs of words", "threats climb", "steps count", "grin spreads", "grade switch"].map((idea, index) => ({ idea, move: `move ${index}`, p: 0.1 * index })),
  dropped: 2, shown: [3, 0, 1], picked: null };
const SKETCHES = [{ treatment: "A", ops: [] }, { treatment: "b", ops: [{ op: "update_layer", layer: "footage", properties: { opacity: 0.5 } }] }, { treatment: "move 1", ops: [] }];

test("readTry: a sketch round is a 2 to 10 s stretch whose options name shown treatments; each refusal in words", () => {
  const read = readTry({ from: 2, to: 8, options: SKETCHES }, SCENES, { treatments: TREATMENTS });
  assert.deepEqual([read.sketch, read.question, read.from, read.to, read.at, read.options.map((option) => [option.letter, option.treatment, option.name])],
    [true, "Which direction?", 2, 8, 2, [["A", "A", "move 3"], ["B", "B", "move 0"], ["C", "C", "move 1"]]], "a letter in any case or a move's words names it; the name is the move");
  for (const [input, options, words] of [
    [{ from: 2, to: 8, options: SKETCHES }, {}, /save the 5 first/],
    [{ from: 0, to: 11, options: SKETCHES }, { treatments: TREATMENTS }, /2 to 10 s long/],
    [{ from: 2, to: 8, options: [SKETCHES[0], { treatment: "D", ops: [] }] }, { treatments: TREATMENTS }, /options\[1\]\.treatment is the letter of a shown treatment \(A, B, C\)/],
    [{ from: 2, to: 8, options: [SKETCHES[0], { treatment: "a", ops: [] }] }, { treatments: TREATMENTS }, /its own treatment/],
  ]) assert.throws(() => readTry(input, SCENES, options), words);
  assert.equal(readTry({ from: 2, to: 8, options: [SKETCHES[0], { treatment: "D", ops: [] }] }, SCENES, { treatments: TREATMENTS, known: true }).options[1].treatment, "D", "D when the dropped one is listed");
  // A project with no treatments (a talking video, a product video): named sketches, no treatment pick.
  const named = readTry({ from: 2, to: 8, options: [{ name: "held", ops: [] }, { name: "cut fast", ops: [] }] }, SCENES, {});
  assert.deepEqual([named.sketch, named.options.map((option) => [option.name, option.treatment ?? null])], [true, [["held", null], ["cut fast", null]]]);
  assert.match(answerText({ ...named, id: "T1", status: "picked", pick: "B", options: named.options }), /picked B \(cut fast\)\. It keeps the video as it is/);
});

test("sketch numbers: block changes in a row count once, the closest pair is set side by side, and the key follows the ops", () => {
  const frame = (level, pixel = [10, 10, 10]) => ({ cells: new Array(144).fill(level), pixels: [pixel] });
  // 1 s at 10 a second: a cut at 0.3 s, a two-sample dissolve at 0.6 to 0.7 s, small movement elsewhere.
  const frames = [0, 0.01, 0.02, 0.5, 0.5, 0.51, 0.2, 0.9, 0.9, 0.9].map((level) => frame(level));
  const facts = clipFacts(frames, { seconds: 1, lufs: -14.04, lettering: 0.333 });
  assert.deepEqual([facts.changes, facts.shot, facts.lettering, facts.lufs, facts.colors.map((color) => color.hex)], [2, 0.3, 0.33, -14, ["#0a0a0a"]]);
  const option = (letter, changes, lufs, hex) => ({ letter, treatment: letter, name: `n${letter}`, renderSeconds: 3, cached: letter === "C", facts: { changes, shot: 1, lettering: 0.5, lufs, colors: [{ hex, share: 1 }] } });
  const lines = sketchLines({ from: 0, to: 2, options: [option("A", 2, -14, "#101010"), option("B", 8, -20, "#ff0000"), option("C", 2, -14, "#121212")] });
  assert.match(lines[0], /^A \(treatment A, nA\): rendered in 3 s, 1\.5 s per sketch second \(measured on this machine\); 2 picture changes, median shot 1 s, lettering 50% of frames, -14 LUFS, colors #101010 100%$/);
  assert.match(lines[2], /C \(treatment C, nC\): cached, not rendered again/);
  assert.match(lines[3], /^closest pair: A and C: picture changes 2 vs 2, .* colors overlap 100% of the picture$/);
  assert.equal(Math.round(colorOverlap({ colors: [{ hex: "#020302", share: 0.97 }, { hex: "#2f3138", share: 0.02 }] }, { colors: [{ hex: "#0f1514", share: 0.7 }, { hex: "#3a4444", share: 0.18 }] }) * 100), 72, "share-weighted, not a count");
  const document = { id: "p", scenes: [] };
  assert.equal(sketchKey(document, [], "s1", 0, 6), sketchKey(structuredClone(document), [], "s1", 0, 6));
  assert.notEqual(sketchKey(document, [], "s1", 0, 6), sketchKey(document, [{ op: "x" }], "s1", 0, 6));
});

test("a sketch round renders each sketch once (cached by its ops), and a pick saves the treatment and tells the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-sketch-"));
  let state = { inbox: [], brief: { treatments: TREATMENTS } };
  const agentState = { read: async () => structuredClone(state), update: async (_id, edit) => edit(state) };
  const rendered = [];
  const picks = [];
  const tries = createTries({ agentState, directory: path.join(directory, "try"), now: () => 1000 + rendered.length * 1500,
    briefOf: (saved) => ({ treatments: saved.brief.treatments }), documentWith: async (record, ops) => ({ ...record.document, ops }),
    renderClip: async (_document, _scene, _from, _to, outputPath, { sound }) => { rendered.push(sound); await writeFile(outputPath, "clip"); },
    measureSketch: async () => ({ changes: 1, shot: 3, lettering: 0, lufs: -12, colors: [] }),
    pickTreatment: (draft, round, option) => { picks.push(option.treatment); draft.brief.treatments = { ...draft.brief.treatments, picked: { label: option.treatment, by: "you" } }; } });
  const record = { revision: 3, document: { id: "p", scenes: SCENES } };
  const first = await tries.start(record, { from: 1, to: 7, options: SKETCHES.slice(0, 2) });
  await first.rendered;
  assert.deepEqual(rendered, [true, true], "with sound");
  assert.match((await tries.sketchReceipt("p", first.id)).join("\n"), /A \(treatment A, move 3\): rendered in 1\.5 s, 0\.25 s per sketch second/);
  const again = await tries.start(record, { from: 1, to: 7, options: SKETCHES.slice(0, 2) });
  await again.rendered;
  assert.equal(rendered.length, 2, "the same sketches are not rendered again");
  assert.match((await tries.sketchReceipt("p", again.id)).join("\n"), /cached, not rendered again/);
  await tries.answer("p", { id: again.id, pick: "B" });
  assert.deepEqual([picks, state.brief.treatments.picked.by, state.tries.at(-1).treatmentSaved], [["B"], "you", true]);
  assert.match(state.inbox.at(-1).text, /picked sketch B \(move 0\); kino saved treatment B as their pick \(brief treatments, by them\); status next names what follows\. The sketch's ops, if you keep them: edit/);
  // Treatments saved again after the sketches were made: B names another idea, so the pick is not saved as B.
  const later = await tries.start(record, { from: 1, to: 7, options: SKETCHES.slice(0, 2) });
  await later.rendered;
  state.brief.treatments = { ...TREATMENTS, shown: [3, 4, 1] };
  await tries.answer("p", { id: later.id, pick: "B" });
  assert.deepEqual([picks.length, state.tries.at(-1).treatmentSaved ?? false], [1, false]);
  assert.match(state.inbox.at(-1).text, /showed treatment B \("stairs of words"\); kino did not save it as their pick: the treatments were saved again/);
  await rm(directory, { recursive: true, force: true });
});

test("a built sketch: the song from its strongest entry, cuts on its beats, the line on a beat in the font, the treatment's files and words by default", () => {
  assert.deepEqual(songEntry({ sections: [{ at: 20, kind: "build", weight: 1 }, { at: 144, kind: "drop", weight: 1 }, { at: 193, kind: "drop", weight: 1 }], beats: [0.3], length: 196 }, 6), { from: 144, kind: "drop" }, "a drop that leaves 6 s");
  assert.deepEqual([songEntry({ beats: [0.3, 0.8], length: 60 }, 6), songEntry({}, 6)], [{ from: 0.3, kind: "first beat" }, { from: 0, kind: "start" }]);
  const beats = beatsIn([143.5, 144.5, 145, 146.5, 147, 148.1, 150.2], 144, 6);
  assert.deepEqual([beats, cutTimes(3, 6, beats), cutTimes(2, 6), lineEntry(beats)], [[0.5, 1, 2.5, 3, 4.1], [0, 2.5, 4.1], [0, 3], 0.5]);
  const ops = sketchOps({ frame: { width: 1920, height: 1080 }, seconds: 6, clips: [{ src: "a.mp4", type: "video", width: 1000, height: 1422, duration: 4, in: 3 }, { src: "b.png", type: "image", width: 1920, height: 1080 }],
    song: { src: "s.mp3", from: 144, beats }, line: "312 keyframes", font: "Archivo Black", coverBox });
  assert.deepEqual(ops.map((op) => [op.op, op.layerType ?? op.family, op.properties?.mediaStart, op.properties?.mediaDuration]),
    [["add_layer", "video", 0, 3], ["add_layer", "image", 3, 3], ["add_layer", "audio", 0, 6], ["add_layer", "text", undefined, undefined], ["set_font", "Archivo Black", undefined, undefined]]);
  assert.deepEqual([ops[0].properties.width >= 1920 && ops[0].properties.height >= 1080, ops[0].properties.mediaOffset, ops[0].properties.volume, ops[2].properties.mediaOffset, ops[3].animations[0]],
    [true, 1, 0, 144, { preset: "preset-mask", start: 0.5, duration: 0.5, unit: "words", stagger: 0.06 }], "full frame, kept inside the file, muted under the song");
  const files = [{ name: "01-dash-build.mp4" }, { name: "06-render.mp4" }, { name: "05-play.mp4" }];
  assert.deepEqual(treatmentDefaults({ move: "'312 keyframes' collapses to '1 sentence'", source: "01-dash-build 0.87 s cut; 06-render 1.57 s" }, files),
    { line: "312 keyframes", clips: [{ file: "01-dash-build.mp4", in: 0.87 }, { file: "06-render.mp4", in: 1.57 }] });
  assert.deepEqual(treatmentDefaults({ move: "split screen", source: "words only" }, files), { line: null, clips: [] });
  assert.equal(pickedSketch({ brief: { treatments: { picked: { label: "A" } } } }), null, "a typed pick carries no sketch");
  assert.throws(() => readTry({ seconds: 12, options: [{ treatment: "A", song: "x" }, { treatment: "B" }] }, SCENES, { treatments: TREATMENTS }), /seconds is the sketch length, 2 to 10/);
});

test("a built sketch's line: on for about 2.5 s between beats; a busy picture behind it is blurred and dimmed by the first step that passes, a calm one left as it is", async () => {
  assert.deepEqual([lineExit([0.5, 1.4, 2.1, 2.9, 3.3, 4.8], 0.5, 6), lineExit([], 0.5, 6), lineExit([4.9], 0.5, 6)], [2.9, 3, 3], "the beat nearest 2.5 s on, inside 1.5 s and 1 s before the end");
  const frame = (shade) => ({ width: 96, height: 54, pixels: Uint8ClampedArray.from({ length: 96 * 54 * 4 }, (_, index) => (index % 4 === 3 ? 255 : shade(Math.floor(index / 4) % 96))) });
  const line = { box: { x0: 200, y0: 470, x1: 1720, y1: 610 }, scene: { width: 1920, height: 1080 }, color: "#ffffff", size: 140, fontSize: 140 };
  assert.equal((await legibleFix({ ...line, frames: [frame(() => 20)] })).fix, null, "a dark calm picture keeps the line as it is");
  // Light stripes (1.7:1, every pixel an edge); the stand-in render softens them more at each step: the second passes.
  const asked = [];
  const busy = await legibleFix({ ...line, frames: [frame((x) => (x % 2 ? 200 : 150))], renderCalm: async (calm) => { asked.push(calm); return [frame((x) => (x % 2 ? 90 : 90 - (calm.blur < 20 ? 30 : 10)))]; } });
  assert.deepEqual([busy.before.busy, asked, busy.fix.kind, busy.fix.blur, busy.fix.dim, busy.fix.after.busy], [1, [{ blur: 16, dim: 0.35 }, { blur: 28, dim: 0.5 }], "picture", 28, 0.5, 0]);
  assert.match(lineFixText(busy), /^line over busy picture \(100% edge pixels\): picture blurred 28 px and dimmed 50% while the line is on \(to 0%; contrast 1\.\d+:1 to \d+\.\d+:1\)$/);
  const ops = sketchOps({ frame: line.scene, seconds: 6, clips: [{ src: "a.mp4", type: "video", width: 1920, height: 1080, duration: 9 }], line: "who made this", coverBox, calm: { blur: 28, dim: 0.5 } });
  assert.deepEqual(ops.map((op) => [op.name, op.animations?.map((animation) => [animation.kind ?? "in", animation.start, Object.keys(animation.to ?? {})[0] ?? animation.preset])]), [
    ["sketch-clip-1", [["in", 0.5, "blur"], ["custom", 3, "blur"]]], ["sketch-dim", [["in", 0.5, "opacity"], ["custom", 3, "opacity"]]],
    ["sketch-line", [["in", 0.5, "preset-mask"], ["out", 3, "preset-mask"]]]]);
  // Calm but low contrast: the scrim order stays.
  assert.equal((await legibleFix({ ...line, frames: [frame(() => 200)] })).fix.kind, "scrim");
});

test("a built round: each sketch made by kino on a fresh copy, the receipt names its song and font, and the pick carries them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-built-"));
  const state = { inbox: [], brief: { treatments: TREATMENTS } };
  const agentState = { read: async () => structuredClone(state), update: async (_id, edit) => edit(state) };
  const built = [];
  const tries = createTries({ agentState, directory: path.join(directory, "try"), briefOf: (saved) => ({ treatments: saved.brief.treatments }),
    documentWith: async () => { throw new Error("not used"); },
    buildSketch: async (_record, round, option) => {
      built.push([option.treatment, option.asked.song, round.to]);
      const song = option.asked.song === "lost" ? { asked: "lost", error: "YouTube has no song" } : { asked: option.asked.song, title: option.asked.song, src: `/api/media/${option.asked.song}.mp3`, from: 144, to: 150, kind: "drop" };
      return { document: { id: "p", scenes: SCENES }, basis: { ops: [option.asked] }, song, font: option.asked.font ?? "Inter", line: "312 keyframes", lineFrom: "given", cuts: 2 };
    },
    renderClip: async (_document, _scene, _from, _to, outputPath) => { await writeFile(outputPath, "clip"); },
    measureSketch: async () => ({ changes: 2, shot: 2, lettering: 0.9, lufs: -14, colors: [] }),
    pickTreatment: (draft, _round, option) => { draft.brief.treatments = { ...draft.brief.treatments, picked: { label: option.treatment, by: "you" } }; } });
  const record = { revision: 1, document: { id: "p", scenes: [{ ...SCENES[0], layers: [] }] } };
  const round = await tries.start(record, { options: [{ treatment: "A", song: "voltaic", font: "Archivo Black" }, { treatment: "B", song: "lost", font: "Archivo Black" }, { treatment: "C", song: "voltaic" }] });
  await round.rendered;
  assert.deepEqual([round.from, round.to, built], [0, 6, [["A", "voltaic", 6], ["B", "lost", 6], ["C", "voltaic", 6]]], "an empty document: 6 s each, one after another");
  const lines = (await tries.sketchReceipt("p", round.id)).join("\n");
  assert.match(lines, /A \(treatment A, move 3\): .*; song "voltaic" 144-150 s of the song \(drop\); font Archivo Black; line "312 keyframes" \(given\); 2 cuts on the song's beats/);
  assert.match(lines, /B \(treatment B, move 0\): .*; silent: the song "lost" could not be fetched \(YouTube has no song\); font Archivo Black/);
  assert.match(lines, /\nA and C use the same song\.\nA and B use the same font \(Archivo Black\)\./);
  await tries.answer("p", { id: round.id, pick: "A" });
  assert.deepEqual(pickedSketch(state), { round: round.id, letter: "A", song: "/api/media/voltaic.mp3", songTitle: "voltaic", songFrom: 144, songTo: 150, font: "Archivo Black", line: "312 keyframes" });
  assert.match(state.inbox.at(-1).text, /picked sketch A \(move 3\); kino saved treatment A as their pick .*; the sketch's song "voltaic" \(\/api\/media\/voltaic\.mp3, 144-150 s of the song\), font Archivo Black, line "312 keyframes" are saved with the pick\./);
  await rm(directory, { recursive: true, force: true });
});

let server;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
before(async () => { if (!skip) server = await startTestServer(); });
after(async () => { await server?.stop(); });
const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } })).json();

test("a try round: the agent asks, kino renders each option's 2 s, the person picks on the dashboard and the agent hears it", { skip, timeout: 120_000 }, async () => {
  const uploaded = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "sintel-village-dragon.mp4" },
    body: await readFile(path.join(root, "tests", "fixtures", "footage", "sintel-village-dragon.mp4")) });
  const { src } = await uploaded.json();
  const id = "try-round";
  assert.equal((await agent("project", { action: "create", id, name: id, width: 540, height: 960, duration: 4 })).isError, undefined);
  assert.equal((await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src } }] })).isError, undefined);
  const refused = await agent("notes", { project: id, action: "try", question: "q", at: 1, options: [OPTIONS[0], { name: "bad", ops: [{ op: "update_layer", layer: "nothing here", properties: { opacity: 0.5 } }] }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /option B \(bad\) was refused/);
  const started = await agent("notes", { project: id, action: "try", question: "which look for shot 1?", at: 1, options: OPTIONS, later: ["color"] });
  assert.equal(started.isError, undefined, started.text);
  assert.deepEqual([started.data.id, started.data.status, started.data.options], ["T1", "rendering", ["A", "B"]]);
  // The clips render one after another; the dashboard sees the round wait once both are ready.
  let view;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 300))) {
    view = (await (await server.api(`/api/dashboard/snapshot?project=${id}`)).json()).agent.tries;
    if (view.rounds[0]?.status !== "rendering") break;
  }
  assert.deepEqual([view.rounds[0].status, view.rounds[0].options.map((option) => [option.letter, option.ready]), view.later], ["waiting", [["A", true], ["B", true]], ["color"]]);
  const clip = await server.api(`/api/dashboard/try/${id}/T1-B.mp4`);
  assert.deepEqual([clip.status, clip.headers.get("content-type")], [200, "video/mp4"]);
  const file = path.join(server.dataDirectory, "clip.mp4");
  await import("node:fs/promises").then(({ writeFile }) => clip.arrayBuffer().then((bytes) => writeFile(file, Buffer.from(bytes))));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames,codec_type", "-of", "json", file]).toString());
  assert.deepEqual(probe.streams.map((stream) => [stream.codec_type, stream.width, stream.height, Number(stream.nb_frames)]), [["video", 540, 960, 60]], "2 s at 30 fps, silent");
  // Only the person picks; the agent hears the pick with the ops to apply.
  assert.match((await agent("notes", { project: id, action: "try", round: "T1", pick: "B" })).text, /Only the person picks/);
  const keyed = await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } });
  const { key } = await keyed.json();
  const picked = await (await server.api("/api/dashboard/act/notes", { method: "POST", headers: { "x-kino-review": key }, body: { project: id, action: "try", round: "T1", pick: "B", note: "softer" } })).json();
  assert.equal(picked.isError, undefined, picked.text);
  const status = await agent("status", { project: id });
  assert.ok(JSON.stringify(status).includes('try T1 \\"which look for shot 1?\\": the person picked B (half faded) (their note: \\"softer\\"). Apply it: edit'), status.text);
});
