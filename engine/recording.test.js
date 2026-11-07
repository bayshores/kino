// Screen recordings as data (recording.js): the compact copy a video layer keeps, and the zooms,
// cursor and typing ranges made from it. Synthetic event logs only, no files.
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoZooms, bezierAt, compactRecording, cursorHidden, MAX_CURSOR_SAMPLES, MAX_MOVES, normalizeRecording,
  positionAt, smoothCursor, springEase, springEaseError, springSeconds, typingRuns,
} from "./recording.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { defaultFonts } from "./fonts.js";
import { styleFor } from "./blocks/looks.js";
import { placeMove, readMoveInput, runMove } from "./blocks/move.js";
import { MOVES } from "./blocks/moves/index.js";
import { evaluateLayer } from "./animation.js";

const META = { frame: { width: 1600, height: 1000 }, scale: 2, duration: 20, cursors: { c1: { shape: "arrow" }, c2: { shape: "text" } } };

// A pointer sliding from `from` to `to` over [start, end] at 60 samples a second.
function slide(from, to, start, end, cursor = "c1") {
  const events = [];
  for (let t = start; t <= end + 1e-9; t += 1 / 60) {
    const share = (t - start) / (end - start);
    events.push({ t, type: "move", x: from[0] + (to[0] - from[0]) * share, y: from[1] + (to[1] - from[1]) * share, cursor });
  }
  return events;
}

const click = (t, x, y, source = "agent") => [
  { t, type: "down", x, y, button: "left", clicks: 1, source },
  { t: t + 0.08, type: "up", x, y, button: "left", source },
];

test("compactRecording thins a straight slide to its ends and holds where the pointer stood still", () => {
  const rec = compactRecording(META, [...slide([0, 0], [600, 300], 0, 1), ...slide([600, 300], [800, 300], 4, 5)]);
  assert.ok(rec.moves.length <= 6, `${rec.moves.length} samples`);
  // Standing still from 1 s to 4 s: the path is still at the first slide's end just before 4 s.
  const [x, y] = positionAt(rec, 3.9);
  assert.ok(Math.abs(x - 600) < 1 && Math.abs(y - 300) < 1, `${x}, ${y}`);
  assert.deepEqual(rec.shapes, ["arrow"]);
});

test("compactRecording keeps key kinds, never typed characters; shortcuts keep their keys", () => {
  const rec = compactRecording({ ...META, keys: "characters" }, [
    { t: 1, type: "key", key: "p", shortcut: false },
    { t: 1.1, type: "key", key: "7", shortcut: false },
    { t: 1.2, type: "key", key: "s", mods: ["cmd"], shortcut: true },
    { t: 1.3, type: "key", key: "enter", shortcut: false },
  ]);
  assert.deepEqual(rec.keys, [[1, "letter", 0], [1.1, "digit", 0], [1.2, "cmd+s", 1], [1.3, "enter", 0]]);
});

test("compactRecording records clicks with their source and finds drags", () => {
  const rec = compactRecording(META, [
    ...click(1, 100, 100, "person"),
    { t: 2, type: "down", x: 100, y: 100, button: "left", source: "agent" },
    ...slide([100, 100], [400, 100], 2, 2.5),
    { t: 2.5, type: "up", x: 400, y: 100, button: "left", source: "agent" },
    { t: 3, type: "mark", label: "open Export" },
  ]);
  assert.deepEqual(rec.clicks.map((entry) => entry.slice(3)), [["left", "person"], ["left", "agent"]]);
  assert.deepEqual(rec.drags, [[2, 2.5]]);
  assert.deepEqual(rec.marks, [[3, "open Export"]]);
});

test("compactRecording caps a long wandering path", () => {
  const events = [];
  for (let index = 0; index < 40_000; index += 1) events.push({ t: index / 60, type: "move", x: 800 + 400 * Math.sin(index / 7), y: 500 + 300 * Math.cos(index / 11), cursor: "c1" });
  const rec = compactRecording({ ...META, duration: 700 }, events);
  assert.ok(rec.moves.length <= MAX_MOVES);
  assert.ok(JSON.stringify(rec).length < 220_000);
});

test("normalizeRecording accepts a compact recording and names a bad field", () => {
  const rec = compactRecording(META, [...slide([0, 0], [50, 50], 0, 1), ...click(1.5, 50, 50)]);
  assert.deepEqual(normalizeRecording(rec, "layer.recording"), rec);
  assert.throws(() => normalizeRecording({ ...rec, clicks: [[1, 2, 3, "middle", "agent"]] }, "layer.recording"), /layer\.recording\.clicks\[0\]/);
  assert.throws(() => normalizeRecording({ ...rec, version: 2 }, "x"), /x\.version/);
});

test("autoZooms zooms from 0.3 s before a click to 2.5 s after and joins clicks close together", () => {
  const rec = compactRecording(META, [...click(2, 400, 400), ...click(6, 420, 400), ...click(14, 400, 400)]);
  const zooms = autoZooms(rec);
  assert.deepEqual(zooms.map(({ start, end }) => [start, end]), [[1.7, 8.5], [13.7, 16.5]]);
  assert.equal(zooms[0].level, 2);
  // A pointer that jumps to the click (as an agent's does): the zoom aims at the click, not at
  // where the pointer sat 0.3 s before it.
  const jump = compactRecording(META, [...slide([100, 100], [100, 100], 0, 0.1), ...click(2, 800, 500)]);
  assert.deepEqual(autoZooms(jump)[0].focus[0], { t: 1.7, x: 800, y: 500 });
});

test("autoZooms leaves out clicks near the end and ends before the end", () => {
  const rec = compactRecording(META, [...click(18, 400, 400), ...click(19.5, 400, 400)]);
  assert.deepEqual(autoZooms(rec).map(({ start, end }) => [start, end]), [[17.7, 19.2]]);
});

test("autoZooms zooms on a mark with no click near it, at the pointer", () => {
  const rec = compactRecording(META, [...slide([300, 300], [300, 300], 0, 0.1), { t: 5, type: "mark", label: "result" }]);
  const [zoom] = autoZooms(rec);
  assert.deepEqual([zoom.start, zoom.end], [4.7, 7.5]);
  assert.deepEqual(zoom.focus[0], { t: 4.7, x: 400, y: 300 }, "clamped so the 800-wide view stays inside the frame");
  assert.equal(autoZooms(rec, { marks: false }).length, 0);
});

test("autoZooms keeps the zoomed view inside the frame and follows a new group of moves", () => {
  const rec = compactRecording(META, [...slide([20, 20], [20, 20], 0, 0.1), ...click(2, 20, 20), ...slide([20, 20], [1500, 900], 3, 3.3), ...slide([1500, 900], [1500, 900], 3.3, 4.4)]);
  const [zoom] = autoZooms(rec);
  assert.deepEqual(zoom.focus[0], { t: 1.7, x: 400, y: 250 });
  const last = zoom.focus.at(-1);
  assert.ok(last.t >= 3 && last.x === 1200 && last.y === 750, JSON.stringify(zoom.focus));
});

test("autoZooms follows the caret while typing", () => {
  const rec = compactRecording(META, [...slide([400, 400], [400, 400], 0, 0.1), ...click(2, 400, 400), { t: 3, type: "caret", x: 900, y: 600, width: 2, height: 20 }]);
  const [zoom] = autoZooms(rec);
  assert.deepEqual(zoom.focus.at(-1), { t: 3, x: 901, y: 610 });
});

test("smoothCursor lands on every click at its time", () => {
  const rec = compactRecording(META, [...slide([0, 0], [1200, 700], 0, 0.25), ...click(0.3, 1200, 700), ...slide([1200, 700], [100, 900], 1, 1.2), ...click(1.25, 100, 900)]);
  const path = smoothCursor(rec);
  const drawn = { ...rec, moves: path.map(([t, x, y]) => [t, x, y, 0]) };
  for (const [t, x, y] of rec.clicks) {
    const [dx, dy] = positionAt(drawn, t);
    assert.ok(Math.hypot(dx - x, dy - y) <= 2, `at ${t}: ${dx}, ${dy} is not on ${x}, ${y}`);
  }
});

test("smoothCursor never passes the target and takes out a small shake", () => {
  const shake = [{ t: 2, type: "move", x: 500, y: 500, cursor: "c1" }, { t: 2.1, type: "move", x: 504, y: 503 }, { t: 2.2, type: "move", x: 500.5, y: 500 }];
  const rec = compactRecording(META, [...slide([0, 500], [500, 500], 0, 0.3), ...shake]);
  const path = smoothCursor(rec);
  assert.ok(path.every(([, x]) => x <= 500.6), "no overshoot past 500");
  const after = path.filter(([t]) => t > 1.5);
  assert.ok(after.every(([, x, y]) => Math.abs(x - 500) <= 0.8 && Math.abs(y - 500) <= 0.8), JSON.stringify(after.slice(0, 5)));
});

test("smoothCursor fits a long recording in the pin limit", () => {
  const events = [];
  for (let index = 0; index < 36_000; index += 1) events.push({ t: index / 60, type: "move", x: 800 + 600 * Math.sin(index / 13), y: 500 + 400 * Math.sin(index / 17), cursor: "c1" });
  const rec = compactRecording({ ...META, duration: 600 }, events);
  assert.ok(smoothCursor(rec).length <= MAX_CURSOR_SAMPLES);
});

test("typingRuns finds typing that lasts 1.5 s and leaves out shortcuts", () => {
  const keys = [];
  for (let index = 0; index < 12; index += 1) keys.push({ t: 3 + index * 0.2, type: "key", key: "letter" });
  keys.push({ t: 8, type: "key", key: "s", mods: ["cmd"], shortcut: true }, { t: 8.2, type: "key", key: "letter" });
  const rec = compactRecording(META, keys);
  assert.deepEqual(typingRuns(rec), [{ start: 3, end: 5.2, keys: 12 }]);
});

test("cursorHidden hides from the first of three quick keys until the pointer moves", () => {
  const rec = compactRecording(META, [
    ...slide([400, 400], [400, 400], 0, 0.1),
    { t: 2, type: "key", key: "letter" }, { t: 2.5, type: "key", key: "letter" }, { t: 3, type: "key", key: "letter" },
    { t: 5, type: "move", x: 402, y: 400, cursor: "c1" }, { t: 6, type: "move", x: 450, y: 400 },
  ]);
  assert.deepEqual(cursorHidden(rec), [{ start: 2, end: 6 }]);
});

test("springEase fits the clamped spring closely", () => {
  const curve = springEase(125, 12, 1.5);
  assert.ok(curve.every((value) => value >= 0 && value <= 1));
  for (const spring of [[125, 12, 1.5], [600, 50, 1]]) assert.ok(springEaseError(...spring) < 0.04, `${spring}: error ${springEaseError(...spring)}`);
  assert.ok(springSeconds() > 0.3 && springSeconds() < 2, `${springSeconds()} s`);
  assert.ok(Math.abs(bezierAt([0.25, 0.25, 0.75, 0.75], 0.4) - 0.4) < 1e-6);
});

test("the screen-recording move zooms in at a click and kino's pointer lands where the zoomed clip draws the click", () => {
  const rec = compactRecording({ ...META, duration: 12 }, [
    ...slide([200, 200], [800, 500], 0, 2), ...click(2.2, 800, 500),
    ...slide([800, 500], [300, 700], 5, 6), ...click(9, 300, 700),
    ...[6.5, 6.7, 6.9, 7.1, 7.3].map((t) => ({ t, type: "key", key: "letter", shortcut: false })),
  ]);
  // A 1600×1000 recording in a 1920×1080 box: drawn at its own shape, centered (bars at the sides).
  const clip = createLayer("video", { id: "screen", name: "screen", src: "/api/media/a.mp4", x: 0, y: 0, width: 1920, height: 1080, mediaStart: 0, mediaDuration: 12, mediaSourceDuration: 12, recording: rec });
  const scene = createScene({ id: "s1", width: 1920, height: 1080, duration: 12, layers: [clip] });
  const made = runMove(MOVES["screen-recording"], { id: "rec", input: readMoveInput(MOVES["screen-recording"], { layer: "screen" }), scene, style: styleFor({ look: "crisp", frame: { width: 1920, height: 1080 } }), fonts: defaultFonts, start: 0, media: () => null });
  placeMove(scene, { id: "rec", name: "screen-recording", settings: { layer: "screen" } }, made);
  parseDocument({ ...createDocument({ id: "rec-test" }), scenes: [scene] });
  const video = scene.layers.find((layer) => layer.id === "screen");
  const pointer = scene.layers.find((layer) => layer.id === "rec-pointer");
  const zoomed = evaluateLayer(video, 2.2 + springSeconds());
  assert.ok(Math.abs(zoomed.scaleX - 2) < 0.02, `scale ${zoomed.scaleX}`);
  for (const [t, x, y] of [[2.2, 800, 500], [9, 300, 700]]) {
    const state = evaluateLayer(video, t);
    const picture = { x: (1920 - 1600 * 1.08) / 2, scale: 1.08 };
    const drawn = { x: state.x + 960 + (picture.x + x * picture.scale - 960) * state.scaleX, y: state.y + 540 + (y * picture.scale - 540) * state.scaleY };
    // evaluateLayer moves a pinned layer onto its path.
    const at = evaluateLayer(pointer, t);
    const tip = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    assert.ok(Math.hypot(tip.x - drawn.x, tip.y - drawn.y) < 6, `at ${t} s the pointer is at ${tip.x}, ${tip.y}, the click is drawn at ${drawn.x}, ${drawn.y}`);
  }
  // It hides while typing and a ring opens at each click; the clicks are cues.
  assert.ok(pointer.animations.some((animation) => animation.id.startsWith("rec-pointer.typing-hide")));
  assert.deepEqual(made.cues.map((cue) => cue.name), ["rec.click1", "rec.click2"]);
});
