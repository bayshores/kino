// Judge rounds (backend/agent/judge.mjs): pairs at the same point of each video and the same size,
// the sides hidden from the dashboard until done, saved in the agent state, the counts in the inbox.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createAgentStateStore } from "./agent/state.mjs";
import { boardRefKeys, createJudge, judgeLine, judgeLost, judgeView, pairSize, pinnedPairs, planPairs, resultText } from "./agent/judge.mjs";
import { createPicks, pickRecord, readPairs, SITTING_GAP_MS, SITTING_PICKS, sittingLeft } from "./agent/picks.mjs";
import { stillTimes } from "./measure/stills.mjs";
import { boardShotKind, craftRow, editLoudest, frameStats, gapWords, imageStats, pairRows, pickRows, pixelKind, placeMoment, referenceMoments, seenAt, shapeLoudest, softAccentLines } from "./agent/versus.mjs";

let folder;
before(async () => { folder = await mkdtemp(path.join(tmpdir(), "kino-judge-")); });
after(async () => { await rm(folder, { recursive: true, force: true }); });

const picture = (width, height, format = "image/png") => {
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").fillRect(0, 0, width, height);
  return canvas.toBuffer(format);
};

test("pairs sit at the same fraction of each video, at one size in the edit's shape", () => {
  const refs = [{ id: "yt:A", folder: "/a", stills: Array.from({ length: 10 }, (_, index) => ({ at: index + 0.5, file: `${index}.jpg` })) }];
  const pairs = planPairs([{ id: "s1", name: "Intro", duration: 4 }, { id: "s2", name: "Main", duration: 16 }], refs, () => 0.2);
  assert.equal(pairs.length, 10);
  assert.deepEqual([pairs[0].sceneId, pairs[0].t, pairs[0].refAt, pairs[0].edit], ["s1", 1, 0.5, "left"]);
  assert.deepEqual([pairs[9].sceneId, pairs[9].t, pairs[9].refAt], ["s2", 15, 9.5]);
  assert.deepEqual(pairSize(1920, 1080), { width: 640, height: 360 });
  assert.deepEqual(pairSize(1080, 1920), { width: 202, height: 360 });
});

test("versus pairs a board shot's pinned moment (move.ref) with that reference, by key, id or title", () => {
  const stills = Array.from({ length: 10 }, (_, index) => ({ at: index * 2, file: `${index}.jpg` }));
  const refs = [{ id: "yt:PHONE1", keys: ["phone-film"], title: "Meet the app", folder: "/o", stills }, { id: "yt:AGENT2", keys: [], title: "Agent launch", folder: "/l", stills },
    { id: "yt:TEASE3", keys: ["teaser"], title: "Teaser 2.0", folder: "/m", stills: [] }];
  const shot = (cue, ref) => ({ cue, dur: 2, move: { kind: "camera", name: "frame", ref } });
  const board = { shots: [shot(0, "phone-film@3.13"), shot(2, "agent-launch@9"), shot(4, "agent2@1"), shot(6, "promo@2"), shot(8, "teaser@1"), { cue: 10, dur: 2, move: { none: "plain" } }] };
  const { pairs, missing, waiting } = pinnedPairs(board, "s1", refs);
  assert.deepEqual(pairs.map((pair) => [pair.shot, pair.t, pair.ref, pair.refAt, pair.still]),
    [[1, 1, "yt:PHONE1", 4, "/o/2.jpg"], [2, 3, "yt:AGENT2", 8, "/l/4.jpg"], [3, 5, "yt:AGENT2", 0, "/l/0.jpg"]]);
  assert.deepEqual(missing, ["shot 4 promo@2"]);
  assert.deepEqual(waiting, ["shot 5 teaser@1"], "saved but not measured yet: not told to save it");
  // Stills 2 s apart (an older save) are said; stills one a second (10 to 90) land within 0.5 s of a pin.
  assert.equal(pairs[0].far, "pinned 3.13 s, nearest still 4 s; save the reference again for 1 s stills");
  assert.deepEqual([stillTimes(5).length, stillTimes(200).length, stillTimes(30).slice(0, 2)], [10, 90, [0.5, 1.5]]);
  const dense = [{ ...refs[0], stills: stillTimes(30).map((at, index) => ({ at, file: `${index}.jpg` })) }];
  assert.deepEqual(pinnedPairs({ shots: [shot(0, "phone-film@7.27"), shot(2, "phone-film@8.6")] }, "s1", dense).pairs.map((pair) => [pair.refAt, pair.far]), [[7.5, undefined], [8.5, undefined]]);
  assert.deepEqual(boardRefKeys(board), ["phone-film", "agent-launch", "agent2", "promo", "teaser"]);
});

test("versus puts like next to like: the same place in the video, its own kind first, a pin on its own row, a still on at most 2 rows, and only craft gaps", async () => {
  const draw = (paint) => { const canvas = createCanvas(320, 180); const context = canvas.getContext("2d"); paint(context); return canvas.toBuffer("image/png"); };
  const card = draw((context) => { context.fillStyle = "#111"; context.fillRect(0, 0, 320, 180); context.fillStyle = "#fff"; context.fillRect(100, 80, 120, 20); });
  // An interface: flat panels with many small rows of sharp lines.
  const app = draw((context) => { context.fillStyle = "#1b1b1f"; context.fillRect(0, 0, 320, 180); context.fillStyle = "#ddd"; for (let y = 8; y < 172; y += 12) for (let x = 8; x < 300; x += 40) context.fillRect(x, y, 24, 2); });
  const person = draw((context) => { for (let y = 0; y < 180; y += 6) for (let x = 0; x < 320; x += 6) { context.fillStyle = `rgb(${200 + ((x * y) % 40)},${140 + (x % 30)},${110 + (y % 20)})`; context.fillRect(x, y, 6, 6); } });
  const kinds = await Promise.all([card, app, person].map(async (png) => pixelKind(await imageStats(png))));
  assert.deepEqual(kinds, ["type", "app", "footage"]);
  // A reference: footage, an app, a card mid-way, then the plain stills that run to its end are its end card.
  const dir = path.join(folder, "kinds");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const order = [person, app, card, app, card, card];
  for (const [index, png] of order.entries()) await writeFile(path.join(dir, `${index}.png`), png);
  const ref = { id: "yt:R", folder: dir, seconds: 6, stills: order.map((_, index) => ({ at: index + 0.5, file: `${index}.png` })) };
  ref.moments = await referenceMoments(ref);
  assert.deepEqual(ref.moments.map((moment) => moment.kind), ["footage", "app", "type", "app", "end", "end"]);
  // At the same point of the story a moment of the same kind wins over a nearer one of another kind;
  // a still on 2 rows goes last; with no moment of that kind, the nearest of another kind.
  const at = (row, uses) => placeMoment([ref], row, uses).moment.at;
  assert.equal(at({ kind: "app", share: 0.1 }), 1.5);
  assert.equal(at({ kind: "app", share: 0.55 }), 3.5);
  assert.equal(at({ kind: "app", share: 0.55 }, new Map([["yt:R@3.5", 2]])), 1.5, "a still on 2 rows goes last");
  assert.equal(placeMoment([ref], { kind: "device", share: 0.45 }).same, false, "pixels never find a phone in hand: another kind");
  // The opening beside their opening, the ending beside theirs (another kind there beats a far app),
  // the loudest change beside the first still at or after theirs (heard), else the same point.
  assert.deepEqual([at({ kind: "footage", role: "opening", share: 0.3 }), at({ kind: "app", role: "ending", share: 0.6 })], [0.5, 5.5]);
  assert.deepEqual([at({ kind: "app", role: "peak", share: 0.1 }), placeMoment([ref], { kind: "app", role: "peak", share: 0.1 }).byPlace], [1.5, true]);
  assert.equal(placeMoment([{ ...ref, heard: { change: { at: 3.2 } } }], { kind: "app", role: "peak", share: 0.1 }).moment.at, 3.5);
  assert.equal(editLoudest([{ name: "song-intro-1", time: 0, weight: 9 }, { name: "song-drop-1", time: 4, weight: 3 }, { name: "song-section-2", time: 8, weight: 5 }, { name: "rhythm-1", time: 3, weight: 10 }]), 8);
  // The opening and ending rows lean to place: a footage edit beside a reference that opens on type
  // and ends on a card gets those stills, while a place row still prefers its own kind.
  const long = { id: "yt:L", seconds: 30, moments: Array.from({ length: 30 }, (_, index) => ({ at: index + 0.5, kind: index < 3 ? "type" : index >= 28 ? "end" : "footage" })) };
  assert.deepEqual([placeMoment([long], { kind: "footage", role: "opening", share: 0 }).moment.at, placeMoment([long], { kind: "footage", role: "ending", share: 1 }).moment.at], [0.5, 29.5]);
  assert.equal(placeMoment([long], { kind: "footage", share: 0.02 }).moment.at, 3.5, "a place row keeps its own kind");
  // A same-kind still used once still beats another kind; on 2 rows the row says why another kind was used.
  const one = { id: "yt:O", seconds: 10, moments: [{ at: 1.5, kind: "type" }, { at: 4.5, kind: "footage" }, { at: 6.5, kind: "type" }] };
  assert.equal(placeMoment([one], { kind: "footage", share: 0.5 }, new Map([["yt:O@4.5", 1]])).same, true);
  assert.deepEqual([placeMoment([one], { kind: "footage", share: 0.5 }, new Map([["yt:O@4.5", 2]])).otherWhy, placeMoment([one], { kind: "app", share: 0.5 }).otherWhy], ["full", "none"]);
  // The loudest change of a hand-cut edit: its music's saved song shape, in video seconds.
  const song = { sections: [{ kind: "intro", at: 0.5, weight: 9 }, { kind: "drop", at: 5, weight: 7 }, { kind: "verse", at: 2, weight: 3 }] };
  assert.equal(await shapeLoudest([{ duration: 4, layers: [] }, { duration: 10, layers: [{ type: "audio", src: "kino-media:x", volume: 1 }] }], async () => song), 9);
  assert.equal(await shapeLoudest([{ duration: 4, layers: [{ type: "audio", src: "kino-media:x", volume: 1 }] }], async () => { throw new Error("not in the library"); }), null);
  // Rows: opening, the shot holding the loudest change, ending, a kept (pinned) shot, then spread.
  const shots = Array.from({ length: 8 }, (_, index) => ({ start: index * 2, end: index * 2 + 2, at: index * 2 + 1 }));
  assert.deepEqual(pickRows(shots, 4, { peak: 9.5, keep: [shots[1]] }).map((row) => [row.at, row.role]), [[1, "opening"], [3, "place"], [9, "peak"], [15, "ending"]]);
  assert.deepEqual(pickRows(shots, 4).map((row) => row.at), [1, 7, 11, 15]);
  // A loudest change in the last shot leaves the ending its row (and is its own row when far from that frame).
  assert.deepEqual(pickRows(shots, 6, { peak: 15 }).map((row) => row.role).filter((role) => role !== "place"), ["opening", "ending"]);
  assert.deepEqual(pickRows(shots, 6, { peak: 14 }).filter((row) => row.at > 13).map((row) => [row.role, Boolean(row.extra)]), [["peak", true], ["ending", false]]);
  assert.equal(pickRows(shots, 6, { peak: 14 }).length, 6);
  // A pinned moment fills its own row; six shots pinning one still fill 2 rows, the rest are placed.
  const pin = { ref: "yt:R", refAt: 2.5, still: path.join(dir, "2.png"), pinned: "r@2.5" };
  const pairs = pairRows([0, 1, 2, 3, 4, 5].map((index) => ({ at: index + 0.5, kind: "footage", role: index ? "place" : "opening", pin })), [ref], 6);
  assert.deepEqual(pairs.map((pair) => pair.match), ["pinned", "pinned", "kind", "place", "place", "place"]);
  assert.ok(pairs.every((pair) => pairs.filter((other) => other.refAt === pair.refAt).length <= 2), pairs.map((pair) => pair.refAt).join(" "));
  assert.match(pairs[2].full, /^r@2\.5 is on 2 rows already/);
  // What theirs shows on screen there, from its labels when it has them.
  const seen = { seen: [{ at: 2.4, kinds: ["type", "overlay"], words: "NO WAY BACK" }, { at: 4.5, kinds: ["plain"] }] };
  assert.deepEqual([seenAt(seen, 2.5), seenAt(seen, 4.5), seenAt(seen, 0.5), seenAt(ref, 2.5)], ['type, overlay "NO WAY BACK"', "plain footage", null, null]);
  // A board shot's kind comes from what it holds.
  assert.deepEqual([boardShotKind({ media: "/m/a.mp4" }, { name: "screen recording.mov" }), boardShotKind({ media: "none", text: { text: "Zuri" } }, { last: true }),
    boardShotKind({ media: "/m/b.mp4", subject: { what: "a girl walks", boxes: [] } }, { name: "street.mp4" }), boardShotKind({ media: "/m/logo.png" }, { name: "logo.png", last: true })], ["app", "end", "footage", "end"]);
  // Gaps are hero fill and contrast only; reference_drift keeps type, motion, holds and cuts, not text share or likeness.
  assert.deepEqual(gapWords({ fill: 0.2, contrast: 0.1 }, { fill: 0.7, contrast: 0.3 }), ["hero fills 20% of the frame, theirs 70%", "contrast 0.1, theirs 0.3"]);
  assert.deepEqual(gapWords({ fill: 0.5, contrast: 0.2 }, { fill: 0.6, contrast: 0.22 }), []);
  assert.deepEqual(["big type on screen 10% (references 30% to 40%)", "text on screen 90% (reference 40%)", "nearest reference shot 1.20 (reference shots 0.40 to 0.60 apart)", "longest still hold 4 s (reference 1 s)"].map(craftRow), [true, false, false, true]);
});

// A square wave of 4 px cells in gray (sharp), or the same blurred by a box average (soft); a gray frame with an optional patch.
const frameOf = (width, height, paint) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set([...paint(x, y), 255], (y * width + x) * 4);
  return rgba;
};
const checker = (x, y) => { const v = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 25; return [v, v, v]; };

test("versus reads softness and accent from a fixed-size copy and names a call only outside the references' range", () => {
  // A 1 px blur of the checker (3x3 box) keeps every edge but spreads it: softness, not less detail.
  const blurred = frameOf(640, 360, (x, y) => { let sum = 0; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += checker(x + dx, y + dy)[0]; const v = sum / 9; return [v, v, v]; });
  const sharpStats = frameStats(frameOf(640, 360, checker), 640, 360), blurStats = frameStats(blurred, 640, 360);
  assert.ok(sharpStats.edge > blurStats.edge + 0.15, `${sharpStats.edge} against ${blurStats.edge}`);
  // The same picture at twice the size, or as a tall frame, reads the same (a fixed pixel count, its own shape).
  const double = frameStats(frameOf(1280, 720, (x, y) => checker(x / 2, y / 2)), 1280, 720), tall = frameStats(frameOf(360, 640, checker), 360, 640);
  assert.deepEqual([Math.abs(double.edge - sharpStats.edge) < 0.02, Math.abs(tall.edge - sharpStats.edge) < 0.02], [true, true], `${double.edge}, ${tall.edge} against ${sharpStats.edge}`);
  // A bright saturated patch (a sixth of the frame) is accent; a gray frame has none, and no edges (edge null).
  const patch = frameStats(frameOf(640, 360, (x, y) => (x < 200 && y < 180 ? [255, 20, 200] : [90, 90, 90])), 640, 360);
  assert.deepEqual([patch.accent > 0.15 && patch.accent < 0.2, patch.peak], [true, 255]);
  const gray = frameStats(frameOf(640, 360, () => [90, 90, 90]), 640, 360);
  assert.deepEqual([gray.accent, gray.peak, gray.edge], [0, 0, null]);
  // Against soft references the sharp edit is told one call; inside the range, none; no references, no lines.
  const lines = softAccentLines([sharpStats, patch], [[blurStats, gray], [blurStats]]);
  assert.match(lines[0], /^softness: edge sharpness 0\.\d\d .* your 2 saved references 0\.\d\d: sharper than theirs\. One call: .*"update_layer", layer:"<picture layer>", properties:\{blur:3\}/);
  assert.match(lines[1], /^accent: .* of the frame bright and saturated, brightest saturated region 255 of 255; your 2 saved references 0%, region 0: brighter than theirs\. One call: lower the glow's strength/);
  // Only the region brighter (the same share): the accent color itself, not the glow.
  const colorOnly = softAccentLines([patch], [[{ ...patch, peak: 150 }]]);
  assert.match(colorOnly[0], /^softness: not compared, your frames have no edges/);
  assert.match(colorOnly[1], /brighter than theirs\. One call: a darker accent color/);
  const inside = softAccentLines([blurStats], [[blurStats], [sharpStats]]);
  assert.match(inside[0], /inside their range\.$/);
  assert.doesNotMatch(inside.join(" "), /One call/);
  assert.deepEqual(softAccentLines([sharpStats], []), []);
});

test("a round is made in the background, picked only blind, and its counts reach the inbox", async () => {
  const agentState = createAgentStateStore(path.join(folder, "data"));
  const stills = path.join(folder, "stills");
  await rm(stills, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(stills, { recursive: true });
  for (let index = 0; index < 10; index += 1) await writeFile(path.join(stills, `0${index}.jpg`), picture(640, 360, "image/jpeg"));
  const events = [];
  let flip = 0;
  const judge = createJudge({
    agentState, directory: path.join(folder, "judge"), emit: async (projectId, event) => events.push(event), random: () => (flip++ % 2 ? 0.9 : 0.1),
    inspire: { projectView: async () => ({ saved: ["yt:A"] }), savedStills: async () => [{ id: "yt:A", folder: stills, stills: Array.from({ length: 10 }, (_, index) => ({ at: index, file: `0${index}.jpg` })) }] },
    editFrame: async (document, sceneId, time, width) => picture(width, Math.round((width * 9) / 16)),
  });
  const record = { revision: 147, document: { id: "p1", scenes: [{ id: "s1", name: "Main", duration: 6, width: 1920, height: 1080 }] } };
  // The brief's idea goes with the round, so the person picks with it in mind.
  await agentState.update("p1", (state) => { state.brief = { style: { idea: "your streak becomes a map" } }; });
  const { round } = await judge.start(record);
  assert.equal(round.status, "preparing");
  let state;
  for (let tries = 0; tries < 200; tries += 1) { state = await agentState.read("p1"); if (state.judges.at(-1).status !== "preparing") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  const open = state.judges.at(-1);
  assert.equal(open.status, "open", open.error);
  assert.equal(open.pairs.length, 3);
  // Both pictures of a pair have one size; the dashboard does not learn the sides yet.
  const files = (await readdir(path.join(folder, "judge", "p1"))).sort();
  assert.equal(files.length, 6);
  const [left, right] = await Promise.all(files.slice(0, 2).map(async (name) => loadImage(path.join(folder, "judge", "p1", name))));
  assert.deepEqual([left.width, left.height], [right.width, right.height]);
  assert.equal(judgeView(state).pairs[0].edit, undefined);
  assert.deepEqual(judgeView(state).idea, ["Idea: your streak becomes a map"]);
  assert.equal((await judge.start(record)).existing, true, "one round a revision");
  // The reference wins pair 1, the edit pair 2, pair 3 is about the same.
  await judge.pick("p1", { id: open.id, n: 1, pick: open.pairs[0].edit === "left" ? "right" : "left" });
  await judge.pick("p1", { id: open.id, n: 2, pick: open.pairs[1].edit });
  const done = await judge.pick("p1", { id: open.id, n: 3, pick: "same" });
  assert.equal(done.status, "done");
  state = await agentState.read("p1");
  assert.equal(state.inbox.at(-1).text, "judged rev 147: references 1 · same 1 · yours 1\nthe reference looked more finished at @1s: work there before you call it finished.");
  assert.equal(judgeView(state).pairs[0].edit, open.pairs[0].edit, "the sides are shown when done");
  assert.ok(events.every((event) => event.kind === "judge"));
  assert.equal(resultText({ rev: 3, pairs: [{ pick: "skip" }] }), "judged rev 3: references 0 · same 0 · yours 0 · skipped 1");
});

test("versus takes at most 6 pairs; a done round blocks a final render only when the references won more than yours and same", () => {
  const refs = [{ id: "yt:A", folder: "/a", stills: [{ at: 1, file: "1.jpg" }] }];
  assert.equal(planPairs([{ id: "s1", duration: 30 }], refs, () => 0, 6).length, 6);
  const round = (picks) => ({ id: "J1", rev: 4, status: "done", pairs: picks.map((pick, index) => ({ n: index + 1, at: index, edit: "left", pick })) });
  assert.equal(judgeLost({ judges: [round(["right", "right", "left"])] }, 4)?.id, "J1");
  assert.equal(judgeLost({ judges: [round(["right", "same", "left"])] }, 4), null, "1 against 1 + 1");
  assert.equal(judgeLost({ judges: [round(["right", "right", "left"])] }, 5), null, "another revision");
  assert.equal(judgeLost({ judges: [{ ...round([null, null, null]), status: "open" }] }, 4), null);
  assert.match(judgeLine({ judges: [] }, 4), /^no judge round for rev 4/);
  assert.match(judgeLine({ judges: [round(["right", "right", "left"])] }, 4), /^judged rev 4: references 2 · same 0 · yours 1/);
});

test("the pick box queues video pairs with random sides, saves each pick as a JSONL line and stops at 5 a sitting", async () => {
  const dir = path.join(folder, "taste");
  const videos = await Promise.all(["one", "two", "three"].map(async (name) => { const file = path.join(folder, `${name}.mp4`); await writeFile(file, "x"); return file; }));
  const clock = Date.parse("2026-10-29T10:00:00Z");
  const sides = [1, 0];
  const views = [];
  const picks = createPicks({ directory: dir, now: () => clock, random: () => sides.shift() ?? 0, emit: (view) => views.push(view) });
  await assert.rejects(picks.queue([[videos[0], path.join(folder, "missing.mp4")]]), /was not found/);
  assert.deepEqual(await picks.queue([[videos[0], videos[1]], { a: videos[1], b: videos[2], audio: true }]), { added: ["P1", "P2"], queued: 2 });
  assert.deepEqual((await picks.queue([videos[1], videos[0]])).added, [], "a waiting pair is not queued twice, in either order");
  assert.equal(readPairs([{ a: "x.mp4", b: "y.mp4", picture: true }])[0].mode, "picture");
  assert.deepEqual(views.at(-1), { queued: 2, picked: 0, most: SITTING_PICKS, pairs: [{ pair_id: "P1", mode: "video" }, { pair_id: "P2", mode: "audio" }] }, "no paths, no sides");
  assert.equal((await picks.file("P1", "left")).path, videos[1], "P1 shows b on the left");
  const saved = await picks.pick({ pair_id: "P1", side: "left", words: ["mix", "story"], note: " the drop lands " });
  assert.deepEqual(saved, { pair_id: "P1", a: videos[0], b: videos[1], shown_left: "b", pick: "b", words: ["story", "mix"], note: "the drop lands", at: "2026-10-29T10:00:00.000Z", mode: "video" });
  await assert.rejects(picks.pick({ pair_id: "P2", side: "left", words: ["vibes"] }), /words are/);
  await picks.pick({ pair_id: "P2", side: "same" });
  const lines = (await readFile(picks.picksFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.pair_id, line.pick]), [["P1", "b"], ["P2", "same"]]);
  assert.deepEqual(await picks.view(), { queued: 0, picked: 2, most: SITTING_PICKS, pairs: [] });
  assert.equal(pickRecord({ pair_id: "P9", a: "x", b: "y", shown_left: "a", mode: "video" }, { side: "right" }, "t").pick, "b");
  assert.equal(pickRecord({ pair_id: "P9", a: "x", b: "y", shown_left: "b", mode: "video" }, { side: "neither" }, "t").pick, "neither", "both bad is saved as neither, for no side");
  // A full sitting takes no more picks until a 30 minute break.
  const full = { count: SITTING_PICKS, lastAt: new Date(clock).toISOString() };
  assert.equal(sittingLeft(full, clock + 60_000), 0);
  assert.equal(sittingLeft(full, clock + SITTING_GAP_MS), SITTING_PICKS);
});
