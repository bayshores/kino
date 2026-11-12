// Creative seeds M3, the moves library through the agent API (POST /api/agent/<verb>):
// library {topic:"moves"} lists every move and gives each one's fields and a runnable example;
// the move op builds a set piece from the project's own layers, makes it again with the same
// id, takes it away with remove:true, and refuses bad input with an answer that says what to
// change. Every example then passes every gate in 16:9, 9:16 or reduced motion (each move in
// one of them, in turn; tests/moves-gate.mjs by hand runs every move in all three). Runs on a
// real server with a temporary data folder.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { FOOTAGE_VERSION } from "./footage/analyze.mjs";
import { MOVES, MOVE_NAMES } from "../engine/blocks/moves/index.js";
import { startTestServer } from "./media.test.support.mjs";
import { decodePng } from "../tests/golden/compare.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { libraryExample, movesApi, movesGate, sampleMoveCases, setUpProject, uploadClip, uploadSong } from "../tests/moves-gate.mjs";

let server;
let api;
before(async () => { server = await startTestServer(); api = movesApi(server); });
after(() => server?.stop());

const saved = async (id) => (await server.api(`/api/projects/${id}`)).json();

test("library moves lists every move in a line and gives one move's fields and example", async () => {
  await setUpProject(api, "lib", { width: 1920, height: 1080 });
  const list = await api.agent("lib", "library", { topic: "moves" });
  assert.equal(list.isError, undefined, list.text);
  const lines = list.text.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(lines.map((line) => line.slice(2).split("(")[0]), MOVE_NAMES);
  assert.equal(MOVE_NAMES.length, 56);
  assert.ok(list.text.length < 8200, `the list stays small (${list.text.length} characters)`);
  for (const name of MOVE_NAMES) {
    const one = await api.agent("lib", "library", { topic: "moves", name });
    assert.equal(one.isError, undefined, one.text);
    assert.match(one.text, new RegExp(`^${name} \\[${MOVES[name].tags.join(", ")}\\]`));
    assert.match(one.text, /\nfields \(\* = required\): /);
    assert.match(one.text, /\nthe example's layers: /);
    assert.ok(one.text.length < 2000, `${name} stays small (${one.text.length} characters)`);
  }
  // impact-accent refuses a raw time, and a song seam set by hand (fit_music measures seams: its own test below).
  const refused = await api.agent("lib", "edit", { ops: [{ op: "move", name: "impact-accent", kind: "flash", at: 1.5 }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /at 1\.5 is a time, not a reason\. An accent needs a cue that motivates it .*leave this moment plain/);
  const hand = await api.agent("lib", "edit", { ops: [{ op: "set_cues", cues: [{ name: "song-drop-1", time: 1 }] }, { op: "move", name: "impact-accent", kind: "flash", at: "cue:song-drop-1" }] });
  assert.equal(hand.isError, true);
  assert.match(hand.text, /set by hand, not measured: song seams and rests come from fit_music/);
  const unknown = await api.agent("lib", "library", { topic: "moves", name: "zoom-thru" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /zoom-through/);
});

test("impact-accent renders: an impact frame turns the clip black and white on its impact, a flash brightens a shot on fit_music's drop", { timeout: 60_000 }, async () => {
  await setUpProject(api, "accent", { width: 640, height: 360 });
  const clip = await uploadClip(server, "accent", 640, 360);
  // The clip's measured impact (file 1 s), as footage/analyze.mjs keeps it beside the file.
  await writeFile(path.join(server.dataDirectory, "media", `${clip.id}.footage-v${FOOTAGE_VERSION}`), JSON.stringify({ version: FOOTAGE_VERSION, duration: 6, width: 640, height: 360, fps: 30,
    events: [{ kind: "impact", t: 1, how: "contact", dir: "right", confidence: 0.8 }] }));
  const song = await uploadSong(server, "accent");
  const made = await api.agent("accent", "edit", { ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: clip.src, x: 0, y: 0, width: 320, height: 180 } },
    { op: "add_layer", layerType: "audio", name: "song", properties: { src: song.src } },
    { op: "fit_music", layer: "song", payoff: 2 },
    { op: "set_cues", cues: [{ name: "hit-1", layer: "clip", media: 1 }] },
    { op: "move", name: "impact-accent", kind: "impact-frame", at: "cue:hit-1" },
    { op: "move", name: "impact-accent", kind: "flash", at: "cue:song-drop-1", layer: "shot-a" },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const pixels = async (t) => {
    const frame = await api.agent("accent", "look", { mode: "frame", t, width: 320 });
    assert.equal(frame.isError, undefined, frame.text);
    return (await decodePng(Buffer.from(frame.images[0].data, "base64"))).data;
  };
  // The look is 320 × 180: the clip fills its top-left quarter; the street (shot-a) shows right of the phone.
  const pixelsOf = (data, inside) => {
    const found = [];
    for (let index = 0; index < data.length; index += 4) if (inside((index / 4) % 320, Math.floor(index / 4 / 320))) found.push([data[index], data[index + 1], data[index + 2]]);
    return found;
  };
  const clipPart = (data) => pixelsOf(data, (x, y) => x < 158 && y < 88);
  const streetPart = (data) => pixelsOf(data, (x) => x >= 200);
  // Share of pixels that are gray (no color) and either dark or light: the silhouette's two inks.
  const inked = (list) => list.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 24 && (r < 48 || r > 200)).length / list.length;
  const mean = (list) => list.reduce((sum, [r, g, b]) => sum + r + g + b, 0) / list.length / 3;
  const [before, hit] = [clipPart(await pixels(0.9)), clipPart(await pixels(1.0))];
  assert.ok(inked(hit) > 0.95 && inked(before) < 0.6, `the impact frame is black and white (${inked(before).toFixed(2)} → ${inked(hit).toFixed(2)})`);
  const [still, drop] = [streetPart(await pixels(1.9)), streetPart(await pixels(2.01))];
  assert.ok(mean(drop) > mean(still) + 25, `the drop's flash brightens the street (${mean(still).toFixed(0)} → ${mean(drop).toFixed(0)})`);
});

test("a move animates your layers, is made again with the same id and taken away with remove", { timeout: 120_000 }, async () => {
  await setUpProject(api, "again", { width: 1920, height: 1080 });
  const example = await libraryExample(api, "again", "zoom-through");
  // A cue the agent set whose name starts with the move's id is not the move's, so it stays.
  const first = await api.agent("again", "edit", { ops: [{ op: "set_cues", cues: [{ name: "zoom-through.hit", time: 1.2 }] }, example] });
  assert.equal(first.isError, undefined, first.text);
  assert.match(first.text, /move zoom-through: 1–1\.9 s/);
  let scene = (await saved("again")).document.scenes[0];
  assert.deepEqual(scene.moves.map((entry) => [entry.id, entry.name]), [["zoom-through", "zoom-through"]]);
  const shotA = scene.layers.find((layer) => layer.name === "shot-a");
  const shotB = scene.layers.find((layer) => layer.name === "shot-b");
  const pushed = shotA.animations.filter((animation) => animation.id.startsWith("zoom-through."));
  assert.ok(pushed.length >= 2, "the from shot is pushed in and blurred");
  assert.ok(shotB.animations.some((animation) => animation.id.startsWith("zoom-through.")), "the to shot settles");

  // A hand edit to one of its animations says the rest does not follow, and how to retime it all.
  const hand = await api.agent("again", "edit", { ops: [{ op: "update_animation", animationId: pushed[0].id, properties: { duration: pushed[0].duration + 0.1 } }] });
  assert.equal(hand.isError, undefined, hand.text);
  assert.match(hand.text, /is part of move zoom-through zoom-through: .*send \{op:\\?"move/);

  // The same id again with a change: what it made before is replaced, nothing doubles.
  const again = await api.agent("again", "edit", { ops: [{ op: "move", name: "zoom-through", id: "zoom-through", at: 2, point: [30, 60] }] });
  assert.equal(again.isError, undefined, again.text);
  assert.match(again.text, /move zoom-through \(made again\): 2–2\.9 s/);
  scene = (await saved("again")).document.scenes[0];
  assert.equal(scene.moves.length, 1);
  assert.deepEqual(scene.moves[0].settings.point, [30, 60]);
  const after = scene.layers.find((layer) => layer.name === "shot-a").animations.filter((animation) => animation.id.startsWith("zoom-through."));
  assert.equal(after.length, pushed.length);
  assert.ok(after.every((animation) => animation.start >= 2), "it starts at the new time");

  // A second one of the same move gets its own id.
  const second = await api.agent("again", "edit", { ops: [{ op: "move", name: "rgb-split-hit", layer: "shot-b", at: 3.2 }] });
  assert.equal(second.isError, undefined, second.text);
  // A layer a move makes can be named by a later op of the same edit; a layer already named
  // "words-x" is still that layer, not a new part.
  assert.equal((await api.agent("again", "edit", { ops: [{ op: "update_layer", layer: "shot-b", properties: { name: "words-x" } }] })).isError, undefined);
  const named = await api.agent("again", "edit", { ops: [{ op: "move", name: "roll", id: "words", items: ["a", "b"], at: 0.2 }, { op: "update_layer", layer: "words-item1", properties: { name: "first word" } }, { op: "update_layer", layer: "words-x", properties: { name: "shot-b" } }] });
  assert.equal(named.isError, undefined, named.text);
  const layers = (await saved("again")).document.scenes[0].layers;
  assert.equal(layers.find((layer) => layer.id === "words-item1").name, "first word");
  assert.equal(layers.find((layer) => layer.id === shotB.id).name, "shot-b");
  await api.agent("again", "edit", { ops: [{ op: "move", name: "roll", id: "words", remove: true }] });
  const removed = await api.agent("again", "edit", { ops: [{ op: "move", name: "zoom-through", id: "zoom-through", remove: true }] });
  assert.equal(removed.isError, undefined, removed.text);
  assert.match(removed.text, /removed move zoom-through/);
  scene = (await saved("again")).document.scenes[0];
  assert.deepEqual(scene.moves.map((entry) => entry.id), ["rgb-split-hit"]);
  assert.ok(scene.layers.every((layer) => layer.animations.every((animation) => !animation.id.startsWith("zoom-through."))));
  // A roll writes a cue per item; made again it replaces them, removed it takes only its own.
  const cueNames = async () => ((await saved("again")).document.cues ?? []).map((cue) => cue.name);
  for (const items of [["a", "b", "c"], ["a", "b"]]) {
    const roll = await api.agent("again", "edit", { ops: [{ op: "move", name: "roll", id: "zoom-through", items, land: "KINO", at: 0.2 }] });
    assert.equal(roll.isError, undefined, roll.text);
  }
  assert.deepEqual((await cueNames()).sort(), ["zoom-through.1", "zoom-through.2", "zoom-through.hit", "zoom-through.land"]);
  await api.agent("again", "edit", { ops: [{ op: "move", name: "roll", id: "zoom-through", remove: true }] });
  assert.deepEqual(await cueNames(), ["zoom-through.hit"]);
});

test("a move sent again with the same layer and time replaces the first and the receipt says so; another time adds one", { timeout: 60_000 }, async () => {
  await setUpProject(api, "resend", { width: 640, height: 360 });
  const send = (at) => api.agent("resend", "edit", { ops: [{ op: "move", name: "rgb-split-hit", layer: "shot-b", at }] });
  const ids = async () => (await saved("resend")).document.scenes[0].moves.map((entry) => entry.id);
  assert.equal((await send(1)).isError, undefined);
  const again = await send(1);
  assert.equal(again.isError, undefined, again.text);
  assert.match(again.text, /move rgb-split-hit \(replaced: the same move on the same layers at the same time\)/);
  assert.deepEqual(await ids(), ["rgb-split-hit"]);
  assert.equal((await send(2.5)).isError, undefined);
  assert.deepEqual(await ids(), ["rgb-split-hit", "rgb-split-hit-2"]);
  // The receipt names the layers a move made.
  const roll = await api.agent("resend", "edit", { ops: [{ op: "move", name: "roll", id: "words", items: ["a", "b"], at: 0.2 }] });
  assert.equal(roll.isError, undefined, roll.text);
  assert.match(roll.text, /\d+ new layers? \(words-item1/);
});

test("the skill's moves example runs as written and passes every gate", { timeout: 120_000 }, async () => {
  const created = await api.agent("skill", "project", { action: "create", id: "skill", name: "skill", width: 1920, height: 1080, duration: 6, background: "#0B0B0D" });
  assert.equal(created.isError, undefined, created.text);
  const [ops] = jsonBlocks(skillSection("Moves example"));
  assert.deepEqual(ops.filter((op) => op.op === "move").map((op) => op.name), ["zoom-through", "caption-words"]);
  const made = await api.agent("skill", "edit", { ops });
  assert.equal(made.isError, undefined, made.text);
  const check = await api.agent("skill", "check");
  assert.equal(check.data.errors, 0, check.text);
  // Karaoke captions: each word takes the accent, and pops in, when it is said.
  const caption = (await saved("skill")).document.scenes[0].layers.find((layer) => layer.move?.part === "w1");
  const keyed = Object.fromEntries(caption.animations.map((animation) => [animation.name, animation]));
  assert.deepEqual([keyed["Say word"].delays, keyed["Pop words"].delays], [[0, 0.6, 0.6, 1.3, 1.3], [0, 0.6, 0.6, 1.3, 1.3]]);
  assert.match(check.text, /type-pop 1/);
  // inspect shows the per-word delays, so the agent sees how long the words really run.
  const inspected = await api.agent("skill", "inspect", { targets: [caption.id] });
  assert.match(inspected.text, /by words delays 0\.\.1\.3/, inspected.text);
});

test("the skill's trim paths example draws on, passes check, renders and exports a Lottie Trim Paths", { timeout: 120_000 }, async () => {
  const created = await api.agent("trim", "project", { action: "create", id: "trim", name: "trim", width: 1920, height: 1080, duration: 4, background: "#0B0B0D" });
  assert.equal(created.isError, undefined, created.text);
  const [ops] = jsonBlocks(skillSection("Trim paths and dashes"));
  const made = await api.agent("trim", "edit", { ops });
  assert.equal(made.isError, undefined, made.text);
  assert.match(made.text, /move draw-on: 0\.5–/);
  const check = await api.agent("trim", "check");
  assert.equal(check.data.errors, 0, check.text);
  // Nothing is drawn before the trims start (0.2 s and 0.5 s); part of each line is at 0.8 s.
  const bright = async (t) => {
    const frame = await api.agent("trim", "look", { mode: "frame", t, width: 640 });
    assert.equal(frame.isError, undefined, frame.text);
    const { data } = await decodePng(Buffer.from(frame.images[0].data, "base64"));
    let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 1] > 128) count += 1;
    return count;
  };
  assert.equal(await bright(0.1), 0, "no outline shows before the trim starts");
  assert.ok(await bright(0.8) > 200, "the lines are part drawn at 0.8 s");
  const underline = (await saved("trim")).document.scenes[0].layers.find((layer) => layer.name === "underline");
  assert.deepEqual(underline.animations.map((animation) => [animation.kind, animation.from, animation.to]), [["in", { strokeEnd: 0 }, { strokeEnd: 1 }]]);
  const frameLayer = (await saved("trim")).document.scenes[0].layers.find((layer) => layer.name === "frame");
  assert.equal(frameLayer.animations[0].kind, "in", "the trim preset is an entrance");
  const started = await api.agent("trim", "render", { action: "start", quality: "final", format: "lottie", fps: 10 });
  assert.equal(started.isError, undefined, started.text);
  const done = await api.agent("trim", "render", { action: "wait", job: started.data.job, timeout_s: 90 });
  assert.equal(done.data.status, "done", done.text);
  const lottie = JSON.parse(await readFile(done.data.path, "utf8"));
  const items = JSON.stringify(lottie.layers);
  assert.equal((items.match(/"ty":"tm"/g) ?? []).length, 2, "the underline and the frame each have a Trim Paths");
  assert.match(items, /"n":"d","nm":"dash"/);
});

test("a bad move op saves nothing and says what to change", async () => {
  await setUpProject(api, "bad", { width: 1920, height: 1080 });
  const before = JSON.stringify((await saved("bad")).document);
  const cases = [
    [{ op: "move", name: "zoom-thru", from: "shot-a", to: "shot-b", at: 1 }, /zoom-through/],
    [{ op: "move", from: "shot-a", to: "shot-b", at: 1 }, /move needs name/],
    [{ op: "move", name: "zoom-through", from: "shot-a", to: "shot-b" }, /needs at/],
    [{ op: "move", name: "zoom-through", from: "shot-a", at: 1 }, /to/],
    [{ op: "move", name: "zoom-through", from: "shot-a", to: "shot-b", at: 1, text: "hi" }, /has no field .{1,2}text/],
    [{ op: "move", name: "zoom-through", from: "shot-a", to: "nowhere", at: 1 }, /nowhere/],
    [{ op: "move", name: "zoom-through", from: "shot-a", to: "shot-b", at: 4.8 }, /after the scene ends/],
    [{ op: "move", name: "caption-words", words: [{ text: "hi", at: 0.5 }], text: "hi there" }, /exactly one of words or text/],
    [{ op: "move", name: "rgb-split-hit", layer: "shot-a", at: 1, strength: 3 }, /strength/],
    [{ op: "move", name: "whip-pan", id: "nope", remove: true }, /remove needs the id/],
  ];
  for (const [op, message] of cases) {
    const reply = await api.agent("bad", "edit", { ops: [op] });
    assert.equal(reply.isError, true, `${JSON.stringify(op)} is refused`);
    assert.match(reply.text, message, `${JSON.stringify(op)}: ${reply.text}`);
  }
  // A refused move answers with its own example, not another move's: as its example, or as the
  // fixed op its next call resends (next-call.mjs drops an example the fix already carries).
  for (const op of [{ op: "move", name: "tile-ring", layer: "shot-a", pictures: ["screen-a"], at: 0.5, dur: 1 }, { op: "move", name: "zoom-through", from: "shot-a", at: 1 }]) {
    const reply = await api.agent("bad", "edit", { ops: [op] });
    assert.equal(reply.isError, true, reply.text);
    const answer = JSON.parse(reply.text);
    const shown = answer.example ?? JSON.parse(answer.next.replace(/^edit /, "")).fix?.["0"];
    assert.deepEqual([shown?.op, shown?.name], ["move", op.name], reply.text);
  }
  assert.equal(JSON.stringify((await saved("bad")).document), before, "nothing was saved");
});

test("every move's library example passes every gate (in 16:9, 9:16 and reduced motion in turn)", { timeout: 300_000 }, async () => {
  assert.deepEqual(await movesGate(server, sampleMoveCases()), []);
});
