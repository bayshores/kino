import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "./model.js";
import { sceneShots, shotTiles } from "./sceneShots.js";
import { layerSpanCuts, shotSpanCuts, slideOffCut, spanCutLine } from "./spanCuts.js";

const video = (overrides) => createLayer("video", { id: "clip", name: "clip", src: "/api/media/a.mp4", width: 1920, height: 1080, ...overrides });
const sceneOf = (layers, duration = 6) => createScene({ id: "s1", duration, layers });
// File shots of a 10 s file with cuts at 3 s and 5 s.
const threeShots = [{ start: 0, end: 3 }, { start: 3, end: 5 }, { start: 5, end: 10 }];
const oneCut = [{ start: 0, end: 5 }, { start: 5, end: 10 }];

test("file cuts move onto the scene through mediaStart and mediaOffset; the Play range start is a cut too", () => {
  const scene = sceneOf([video({ mediaStart: 1, mediaOffset: 2, mediaSourceDuration: 10 })]);
  const { shots, unknown } = sceneShots(scene, () => threeShots);
  assert.deepEqual(shots, [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 6 }]);
  assert.deepEqual(unknown, []);
});

test("a clip at speed 2 reaches its file cuts twice as soon", () => {
  const scene = sceneOf([video({ mediaSpeed: 2, mediaSourceDuration: 10 })]);
  assert.deepEqual(sceneShots(scene, () => threeShots).shots, [{ start: 0, end: 1.5 }, { start: 1.5, end: 2.5 }, { start: 2.5, end: 5 }, { start: 5, end: 6 }]);
});

test("a reversed clip meets its file cuts from the end of its stretch", () => {
  // Plays file 0–6 s backwards over 6 scene seconds: file 5 s is at scene 1 s, file 3 s at 3 s.
  const scene = sceneOf([video({ mediaReverse: true, mediaDuration: 6, mediaSourceDuration: 10 })]);
  assert.deepEqual(sceneShots(scene, () => threeShots).shots, [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 6 }]);
});

test("a stretch shorter than 0.2 s is not a shot: it joins the one before", () => {
  const scene = sceneOf([
    video({ id: "a", mediaDuration: 2, mediaSourceDuration: 10 }),
    video({ id: "b", mediaStart: 2.15, mediaSourceDuration: 10 }),
  ]);
  const { shots } = sceneShots(scene, () => [{ start: 0, end: 10 }]);
  assert.deepEqual(shots, [{ start: 0, end: 2 }, { start: 2, end: 6 }]);
  // A clip trimmed to start at file 1.5 s ends 0.08 s before a 3 s scene does: two shots, not three.
  const trimmed = sceneOf([video({ mediaOffset: 1.5, mediaSourceDuration: 4.417 })], 3);
  assert.deepEqual(sceneShots(trimmed, () => [{ start: 0, end: 1.25 }, { start: 1.25, end: 3.333 }, { start: 3.333, end: 4.417 }]).shots,
    [{ start: 0, end: 1.833 }, { start: 1.833, end: 3 }]);
});

test("a layer whose shots are unknown is listed, and its Play range ends still cut", () => {
  const scene = sceneOf([
    video({ id: "first", mediaDuration: 2.5, mediaSourceDuration: 4 }),
    video({ id: "second", mediaStart: 2.5, mediaSourceDuration: 4 }),
    createLayer("text", { id: "title", name: "title", text: "Hi" }),
    video({ id: "hidden", visible: false, mediaStart: 1 }),
  ]);
  const { shots, unknown } = sceneShots(scene, () => null);
  assert.deepEqual(shots, [{ start: 0, end: 2.5 }, { start: 2.5, end: 6 }]);
  assert.deepEqual(unknown, ["first", "second"]);
  assert.deepEqual(sceneShots(sceneOf([createLayer("text", { id: "t", name: "t", text: "x" })]), () => null), { shots: [{ start: 0, end: 6 }], unknown: [] });
});

test("shotTiles shares 12 tiles among the shots by length, at least one each, clips them to a stretch and keeps at most 24", () => {
  const shots = [{ start: 0, end: 1 }, { start: 1, end: 2.5 }, { start: 2.5, end: 6 }];
  const { tiles, total, shown } = shotTiles(shots);
  assert.deepEqual([total, shown], [3, 3]);
  // 1, 1.5 and 3.5 s of 6: 2, 3 and 7 tiles, every 0.5 s.
  assert.deepEqual(tiles.map((tile) => [tile.n, tile.time]), [[1, 0.25], [1, 0.75], [2, 1.25], [2, 1.75], [2, 2.25],
    [3, 2.75], [3, 3.25], [3, 3.75], [3, 4.25], [3, 4.75], [3, 5.25], [3, 5.75]]);
  assert.deepEqual(tiles[0], { n: 1, start: 0, end: 1, time: 0.25 });
  const stretch = shotTiles(shots, { from: 2, to: 4 });
  assert.deepEqual(stretch.tiles.map((tile) => [tile.n, tile.start, tile.end, tile.time]),
    [...[2.08, 2.25, 2.42].map((time) => [2, 2, 2.5, time]), ...[2.58, 2.75, 2.92, 3.08, 3.25, 3.42, 3.58, 3.75, 3.92].map((time) => [3, 2.5, 4, time])]);
  // Two 8 s clips: 6 tiles each, so a title that fades in at 14 s is on a tile (15.33 s).
  const long = shotTiles([{ start: 0, end: 8 }, { start: 8, end: 16 }]).tiles.map((tile) => tile.time);
  assert.deepEqual(long, [0.67, 2, 3.33, 4.67, 6, 7.33, 8.67, 10, 11.33, 12.67, 14, 15.33]);
  // A short shot keeps its one tile beside a long one.
  assert.deepEqual(shotTiles([{ start: 0, end: 0.3 }, { start: 0.3, end: 20 }]).tiles.filter((tile) => tile.n === 1).length, 1);
  const many = Array.from({ length: 40 }, (_, index) => ({ start: index / 2, end: (index + 1) / 2 }));
  const most = shotTiles(many);
  assert.deepEqual([most.total, most.shown, most.tiles.length], [40, 24, 24]);
  assert.deepEqual(most.tiles.at(-1), { n: 24, start: 11.5, end: 12, time: 11.75 });
});

// ---- spanCuts: a span that runs across the file's own cut ----

test("a layer's span across a file cut: the file second, the scene second and the trim that ends it before the cut", () => {
  // Plays file 2–5.07 s from scene 1 s; the file cuts at 5 s: 2 frames (0.07 s) of the next shot.
  const layer = video({ mediaStart: 1, mediaOffset: 2, mediaDuration: 3.07, mediaSourceDuration: 10 });
  const [cut] = layerSpanCuts(layer, oneCut, 6);
  assert.deepEqual([cut.file, cut.at, cut.side, cut.leak, cut.trim], [5, 4, "end", 0.07, { out: 4.99 }]);
  assert.deepEqual(cut.fields, { mediaDuration: 2.99 });
  assert.match(spanCutLine("clip", [cut]), /clip plays across a cut of its file.*file 5 s lands at 4 s of the scene \(3 s of the shot before it, 0\.07 s of the next\): out 4\.99 s ends before it \(mediaDuration 2\.99\)/);
  // A span that stops at the cut crosses nothing.
  assert.deepEqual(layerSpanCuts(video({ mediaOffset: 2, mediaDuration: 3, mediaSourceDuration: 10 }), oneCut, 6), []);
  // A layer that starts before the scene does (mediaStart -1): mediaDuration counts from its own start.
  const [early] = layerSpanCuts(video({ mediaStart: -1, mediaOffset: 1, mediaDuration: 5.6, mediaSourceDuration: 10 }), oneCut, 6);
  assert.deepEqual([early.at, early.fields], [3, { mediaDuration: 3.99 }]);
});

test("a slowed span lands its file cut later on the scene, and a reversed one from the other end", () => {
  // Speed 0.33 from file 4.6: file 5 s is 1.212 scene seconds in; the span (2.4 s of scene) shows 1.188 s of the next shot.
  const slow = video({ mediaOffset: 4.6, mediaSpeed: 0.33, mediaDuration: 2.4, mediaSourceDuration: 10 });
  const [cut] = layerSpanCuts(slow, threeShots, 6);
  assert.deepEqual([cut.file, cut.at, cut.early, cut.late, cut.side], [5, 1.212, 1.212, 1.188, "end"]);
  assert.equal(cut.trim.out, 4.99);
  // Both sides are over a quarter second, so either may be the planned shot: the line gives both trims.
  assert.match(spanCutLine("slow", [cut]), /out 4\.99 s ends before it \(mediaDuration 1\.182\), or in 5\.01 s begins after it \(mediaOffset 5\.01, mediaStart 1\.242, mediaDuration 1\.158\)$/);
  // Played backwards over file 4–6 s: file 5 s is half way, and the scene second counts from the end of the stretch.
  const back = video({ mediaReverse: true, mediaOffset: 4.5, mediaDuration: 1, mediaSourceDuration: 10 });
  const [reversed] = layerSpanCuts(back, threeShots, 6);
  assert.deepEqual([reversed.file, reversed.at, reversed.fields], [5, 0.5, undefined]);
});

test("a board shot that crosses a cut by 2 frames slides off it; 1.4 s at speed 0.33 is stated and left as given", () => {
  const shot = { cue: 4, dur: 2.5, in: 2.57, speed: 1, sound: "none" };
  // File 2.57–5.07 s: the cut at 5 s is 0.07 s from the end.
  assert.equal(shotSpanCuts(shot, oneCut)[0].leak, 0.07);
  const slid = slideOffCut(shot, oneCut, { fileDuration: 10 });
  assert.deepEqual([slid.shot.in, slid.shot.cue, slid.shot.dur, slid.cuts], [2.49, 4, 2.5, []]);
  // At speed 0.33 a 4 s shot reads 1.32 file seconds from 4.31: the cut at 5 s lands at scene 6.091 s, 1.909 s from the end.
  const long = { cue: 4, dur: 4, in: 4.31, speed: 0.33 };
  const [cut] = shotSpanCuts(long, threeShots);
  assert.deepEqual([cut.file, cut.at, cut.early, cut.late, cut.leak], [5, 6.091, 2.091, 1.909, 1.909]);
  assert.equal(slideOffCut(long, threeShots, { fileDuration: 10 }).shot, null);
  // A cut just inside the span's start slides the span after it; one at the end that would slide before file second 0 is left, with the reason.
  assert.equal(slideOffCut({ cue: 0, dur: 1, in: 2.9, sound: "none" }, [{ start: 0, end: 3 }, { start: 3, end: 5 }], { fileDuration: 5 }).shot.in, 3.01);
  assert.equal(slideOffCut({ cue: 0, dur: 3.05, in: 0.03, sound: "none" }, [{ start: 0, end: 3.05 }, { start: 3.05, end: 5 }], { fileDuration: 5 }).why, "file");
});
