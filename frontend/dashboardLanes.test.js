// The F1 timeline's lanes (frontend/dashboard/lanes.js): shot thumbnails, voice blocks, sound lanes,
// waveforms, agent marks and the range a "needs you" row outlines.
import test from "node:test";
import assert from "node:assert/strict";
import { agentLanes, audioLanes, captionBlocks, knownAgents, mediaId, mixBars, MOST_TILES, needRange, rulerCues, rulerTicks, shotTiles, soundKind, soundRows, spaced, waveBars } from "./dashboard/lanes.js";
import { createThumbnailQueue, MOST_LOADING } from "./dashboard/thumbnails.js";

test("each shot is cut into tiles about a frame wide, each showing its middle frame", () => {
  // A 10 s scene in an 800 px lane, 40 px tall at 16:9 (71 px tiles): shot 1 (0–2 s, 160 px)
  // gets 2 tiles, shot 2 (2–10 s, 640 px) gets 9.
  const tiles = shotTiles([{ start: 0, end: 2 }, { start: 2, end: 10 }], { duration: 10, width: 800, height: 40, aspect: 16 / 9 });
  assert.equal(tiles.filter((tile) => tile.shot === 1).length, 2);
  assert.equal(tiles.filter((tile) => tile.shot === 2).length, 9);
  assert.deepEqual(tiles[0], { shot: 1, start: 0, end: 1, time: 0.5 });
  // No shot list: the whole scene is one shot.
  assert.equal(shotTiles(null, { duration: 4, width: 80, height: 40, aspect: 1 }).length, 2);
  // A long scene zoomed in never asks for more than MOST_TILES frames, and the tiles still cover it.
  const many = shotTiles([{ start: 0, end: 600 }], { duration: 600, width: 20000, height: 40, aspect: 16 / 9 });
  assert.ok(many.length <= MOST_TILES);
  assert.equal(many[0].start, 0);
  assert.equal(many.at(-1).end, 600);
  assert.deepEqual(shotTiles([], { duration: 0, width: 100, height: 40, aspect: 1 }), []);
});

test("caption pages become voice blocks; the server's sentences win over them", () => {
  const scene = {
    duration: 10,
    layers: [
      { id: "g", type: "group", name: "captions", visible: true, animations: [] },
      { id: "p1", type: "group", parentId: "g", visible: true, animations: [{ type: "show", start: 1, duration: 0 }, { type: "hide", start: 3, duration: 0 }] },
      { id: "t1", type: "text", parentId: "p1", role: "caption", text: "Hello  there.", visible: true, animations: [] },
      { id: "title", type: "text", text: "Title", visible: true, animations: [] },
    ],
  };
  const blocks = captionBlocks(scene);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Hello there.");
  assert.equal(blocks[0].name, "captions");
  assert.equal(blocks[0].layerId, "t1");
  const spoken = [{ start: 0, end: 2, text: "Said.", layerId: "v", name: "voice" }];
});

test("a lane per playing sound layer, its waveform only where it plays", () => {
  const scene = {
    duration: 10,
    layers: [
      { id: "m", type: "audio", name: "music", src: "/api/media/abc.wav", mediaStart: 2, mediaDuration: 4, mediaSourceDuration: 20, visible: true },
      { id: "v", type: "audio", name: "voice", src: "/api/media/v.wav", mediaStart: 0, mediaDuration: 0, mediaSourceDuration: 3, visible: true },
      { id: "off", type: "audio", name: "off", src: "/api/media/o.wav", visible: false },
    ],
  };
  const lanes = audioLanes(scene, new Set(["v"]));
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].name, "music");
  assert.equal(lanes[0].start, 2);
  assert.equal(lanes[0].end, 6);
  assert.equal(mediaId(lanes[0].src), "abc.wav");
  assert.equal(mediaId("https://example.com/x"), null);
  const bars = waveBars(lanes[0], { peaks: Array.from({ length: 200 }, () => 0.5), secondsPerPeak: 0.1 }, { duration: 10, count: 10 });
  assert.deepEqual(bars, [0, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
  assert.deepEqual(waveBars(lanes[0], null, { duration: 10, count: 10 }), []);
});

test("an agent's lane has a mark where each of its turns changed a layer, and the need range is its newest turn", () => {
  const agents = [{ id: "a1", name: "Nova" }, { id: "a2", name: "Juno" }];
  const spans = { title: [1, 4], clip: [5, 9] };
  const entries = [{ turn: "T1", who: "Nova", at: "2026-10-26T00:00:00Z", layerIds: ["clip"] }, { turn: "T2", who: "Nova", at: "2026-10-26T00:01:00Z", layerIds: ["title", "gone"] }];
  const lanes = agentLanes(entries, agents, (id) => spans[id] ?? null, { present: [agents[1]] });
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes[0].marks, [{ turn: "T1", at: 5, end: 9 }, { turn: "T2", at: 1, end: 4 }]);
  assert.deepEqual(lanes[1].marks, [], "an agent in the project with no edits here still gets its lane");
  const range = needRange(lanes, "a1", 10);
  assert.equal(range.start, 1);
  assert.equal(range.end, 4);
  assert.match(range.text, /^preview /);
  // Two layers of one turn that start together are one mark, as long as the longer.
  const together = agentLanes([{ turn: "T4", who: "Nova", layerIds: ["a", "b"] }], agents, (id) => ({ a: [0, 2], b: [0, 6] })[id]);
  assert.deepEqual(together[0].marks, [{ turn: "T4", at: 0, end: 6 }]);
  // No marks for that agent: the whole scene.
  assert.deepEqual([needRange(lanes, "a2", 10).start, needRange(lanes, "a2", 10).end], [0, 10]);
});

test("after a restart the saved calls still name the agents, so their turns keep a lane", () => {
  const data = { agents: [{ id: "a2", name: "Juno" }], calls: [
    { verb: "edit", agent: { id: "a1", name: "Nova", color: "#42c0b6", kind: "cli" } },
    { verb: "look", agent: { id: "a2", name: "Juno" } },
    { verb: "edit", by: "you", agent: { id: "you", name: "you" } },
  ] };
  assert.deepEqual(knownAgents(data).map((agent) => agent.name), ["Juno", "Nova"]);
  const lanes = agentLanes([{ turn: "T1", who: "Nova", layerIds: ["clip"] }], knownAgents(data), () => [2, 3]);
  assert.deepEqual(lanes.map((lane) => [lane.agent.name, lane.marks.length]), [["Nova", 1]]);
});

test("nine sound layers fit: one voice lane, a lane per other sound while few (else one audio lane), one music lane", () => {
  // The real project: a music bed, seven voice-over clips and the phone app's voice.
  const clip = (id, start, length) => ({ id, name: id, type: "audio", src: `/api/media/${id}.wav`, mediaStart: start, mediaDuration: length, mediaSourceDuration: length, visible: true });
  const scene = { duration: 170, layers: [
    clip("music", 0, 170), clip("vo-main", 2.6, 18), clip("ask-voice", 25, 4.6), clip("vo-main-2a", 31, 2), clip("vo-main-2b", 40, 3.6),
    clip("vo-main-2c", 50, 30), clip("vo-how", 96, 50), clip("vo-close", 157, 10), clip("app-audio", 15, 113),
  ] };
  assert.deepEqual(["vo-main", "ask-voice", "Narration 2", "voiceOver", "bgm", "Theme song", "app-audio", "voyage"].map((name) => soundKind({ name })),
    ["voice", "voice", "voice", "voice", "music", "music", "other", "other"]);
  const rows = soundRows(scene);
  assert.equal(rows.voice.blocks.length, 7, "without a transcript or captions: a block per voice clip");
  assert.deepEqual(rows.voice.blocks[0], { start: 2.6, end: 20.6, text: "", name: "vo-main", layerId: "vo-main" });
  assert.deepEqual(rows.others.map((row) => row.name), ["app-audio"]);
  assert.deepEqual(rows.music.sounds.map((sound) => sound.id), ["music"]);
  // With a transcript, its sentences; a voice clip no sentence covers keeps its block.
  const spoken = [{ start: 3, end: 6, text: "A trip can raise three questions.", layerId: "vo-main", name: "vo-main" }];
  const withWords = soundRows(scene, { spoken });
  assert.equal(withWords.voice.blocks[0].text, "A trip can raise three questions.");
  assert.equal(withWords.voice.blocks.length, 7, "the sentence instead of vo-main's clip, the other six clips");
  // Three other sounds or more: one "audio" lane for them all.
  const many = soundRows({ duration: 10, layers: ["door", "steps", "beep"].map((id) => clip(id, 1, 2)) });
  assert.deepEqual(many.others.map((row) => [row.id, row.sounds.length]), [[":audio", 3]]);
  assert.equal(many.voice, null);
  assert.equal(many.music, null);
  // Their waveforms are one: the loudest at each bar.
  const peaks = { door: { peaks: [0.2, 0.2, 0.2], secondsPerPeak: 1 }, steps: { peaks: [0.9, 0.1, 0.1], secondsPerPeak: 1 } };
  // They play 1–3 s: bar 1 (0–2 s) has the file's first second, bar 2 (2–4 s) its second.
  assert.deepEqual(mixBars(many.others[0].sounds.slice(0, 2), (sound) => peaks[sound.id] ?? null, { duration: 10, count: 5 }), [0.9, 0.2, 0, 0, 0]);
});

test("thumbnails wait for the stage's first frame, pause while it waits or plays, and load two at a time", async () => {
  const started = [];
  const finish = new Map();
  const queue = createThumbnailQueue({ load: (url) => { started.push(url); return new Promise((resolve, reject) => finish.set(url, { resolve, reject })); } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const heard = [];
  queue.subscribe(() => heard.push(started.length));
  queue.want(["a", "b", "c", "d"]);
  await settle();
  assert.deepEqual(started, [], "nothing before the stage has its first frame");
  queue.stage({ waiting: true });
  queue.stage({ waiting: false, ready: true });
  await settle();
  assert.deepEqual(started, ["a", "b"], `${MOST_LOADING} at a time, in order`);
  queue.stage({ waiting: true }); // the stage asks for a new frame
  finish.get("a").resolve();
  await settle();
  assert.equal(queue.has("a"), true);
  assert.deepEqual(started, ["a", "b"], "no new thumbnail while the stage waits");
  queue.stage({ waiting: false, playing: true });
  finish.get("b").reject(new Error("could not draw"));
  await settle();
  assert.deepEqual(started, ["a", "b"], "none while playing");
  assert.equal(queue.has("b"), false);
  queue.stage({ playing: false });
  await settle();
  assert.deepEqual(started, ["a", "b", "c", "d"], "a failed one is not asked for again");
  // A new revision's thumbnails replace the old ones not yet started.
  queue.want(["e"]);
  finish.get("c").resolve();
  finish.get("d").resolve();
  await settle();
  assert.deepEqual(started.slice(4), ["e"]);
  assert.ok(heard.length >= 4);
  assert.deepEqual(queue.status(), { ready: true, waiting: false, playing: false, loading: 1 });
});

test("the ruler and the shots lane never draw marks closer than a few px: a thousand beats are not a solid bar", () => {
  assert.deepEqual(spaced([0, 0.01, 1, 1.02, 5], { duration: 10, width: 100, gap: 6 }), [0, 1, 5]);
  const beats = Array.from({ length: 385 }, (_, index) => ({ name: `beat-${index + 1}`, time: 0.238 + index * 0.441, kind: "beat" }));
  const onsets = Array.from({ length: 739 }, (_, index) => ({ name: `onset-${index + 1}`, time: 0.1 + index * 0.23, kind: "onset" }));
  const named = [{ name: "drop", time: 60 }];
  // 170 s on a 1780 px ruler: the beats are 4.6 px apart, so the onsets and beats go; the named cue stays.
  assert.deepEqual(rulerCues([...beats, ...onsets, ...named], { duration: 170, width: 1780 }).map((cue) => cue.name), ["drop"]);
  // Zoomed in 8×, the beats have room again (the onsets still do not).
  const zoomed = rulerCues([...beats, ...onsets, ...named], { duration: 170, width: 1780 * 8 });
  assert.ok(zoomed.some((cue) => cue.kind === "beat") && !zoomed.some((cue) => cue.kind === "onset"));
  // Cues with room (every fourth beat: 18 px apart) all show.
  assert.equal(rulerCues(beats.filter((_, index) => index % 4 === 0), { duration: 170, width: 1780 }).length, 97);
});

test("rulerTicks leaves out a time that would touch the edge-aligned first or last time", () => {
  // 4 s on 1300 px: a time every 0.2 s (65 px); "00:00.0" starts at 0 and "00:04.0" ends at 1300.
  const { step, ticks } = rulerTicks(4, 1300);
  assert.equal(step, 0.2);
  const labels = ticks.filter((tick) => tick.label).map((tick) => tick.label);
  assert.equal(labels[0], "00:00.0");
  assert.equal(labels.at(-1), "00:04.0");
  assert.ok(!labels.includes("00:00.2") && !labels.includes("00:03.8"), labels.join(" "));
  assert.ok(labels.includes("00:00.4") && labels.includes("00:03.6"));
  // The tick itself stays a major one.
  assert.equal(ticks.find((tick) => Math.abs(tick.at - 0.2) < 1e-9).major, true);
});
