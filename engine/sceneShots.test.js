import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "./model.js";
import { sceneShots, shotTiles } from "./sceneShots.js";

const video = (overrides) => createLayer("video", { id: "clip", name: "clip", src: "/api/media/a.mp4", width: 1920, height: 1080, ...overrides });
const sceneOf = (layers, duration = 6) => createScene({ id: "s1", duration, layers });
// File shots of a 10 s file with cuts at 3 s and 5 s.
const threeShots = [{ start: 0, end: 3 }, { start: 3, end: 5 }, { start: 5, end: 10 }];

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
