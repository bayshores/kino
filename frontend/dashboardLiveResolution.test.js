// When the dashboard's stage draws a playing scene at a lower resolution (dashboard/liveResolution.js):
// which layers count, at which times, and by how much. tests/dashboard-browser.test.mjs plays such
// a scene and checks the pictures the window shows.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { heavyLiveEffects, heavyLiveEffectsAt, MAX_LIVE_PIXELS, reducedLayout } from "./dashboard/liveResolution.js";

const rays = (extra = {}) => ({ id: "rays", kind: "effect", effect: "light-rays", start: 0, duration: 2, to: {}, ...extra });
const glow = { id: "glow", kind: "effect", effect: "glow", start: 0, duration: 2, to: {} };
const fade = { id: "fade", kind: "fade", start: 0, duration: 1 };
const layer = (id, animations, extra = {}) => ({ id, type: "rectangle", animations, ...extra });

test("light rays that are on make a scene heavy; other effects and turned-off rays do not", () => {
  assert.deepEqual(heavyLiveEffects([]), []);
  assert.deepEqual(heavyLiveEffects(undefined), []);
  assert.deepEqual(heavyLiveEffects([layer("a", [glow, fade]), { id: "b" }]), [], "glow and a fade are not heavy");
  assert.deepEqual(heavyLiveEffects([layer("a", [fade, rays()])]), ["light rays"]);
  assert.deepEqual(heavyLiveEffects([layer("a", [rays({ enabled: false })])]), [], "rays turned off for playback");
  // Two layers with rays are named once.
  assert.deepEqual(heavyLiveEffects([layer("a", [rays()]), layer("b", [rays({ id: "r2" })])]), ["light rays"]);
  // Inside a composed group, unless the group is turned off.
  const group = (extra = {}) => ({ id: "g", kind: "composed", start: 0.5, duration: 2, animations: [fade, rays()], ...extra });
  assert.deepEqual(heavyLiveEffects([layer("a", [group()])]), ["light rays"]);
  assert.deepEqual(heavyLiveEffects([layer("a", [group({ enabled: false })])]), []);
});

test("rays on a hidden layer, or inside a hidden group, are not drawn and do not count", () => {
  assert.deepEqual(heavyLiveEffects([layer("a", [rays()], { visible: false })]), []);
  assert.deepEqual(heavyLiveEffectsAt([layer("a", [rays()], { visible: false })], 1), []);
  const group = { id: "g", type: "group", visible: false };
  assert.deepEqual(heavyLiveEffects([group, layer("a", [rays()], { parentId: "g" })]), [], "hidden parent");
  assert.deepEqual(heavyLiveEffects([{ ...group, visible: true }, layer("a", [rays()], { parentId: "g" })]), ["light rays"]);
  // A broken parent loop does not hang.
  assert.deepEqual(heavyLiveEffects([layer("a", [rays()], { parentId: "b" }), layer("b", [], { parentId: "a" })]), ["light rays"]);
});

test("a burst of rays counts only while it shows, as the renderer draws it", () => {
  // A 0.5 s burst from 1 s, gone outside it (keepStill off), in a longer scene.
  const burst = [layer("a", [rays({ start: 1, duration: 0.5, keepStill: "off" })])];
  assert.deepEqual(heavyLiveEffectsAt(burst, 0.5), [], "before the burst");
  assert.deepEqual(heavyLiveEffectsAt(burst, 1.2), ["light rays"], "during the burst");
  assert.deepEqual(heavyLiveEffectsAt(burst, 1.5), [], "after the burst (its end is exclusive)");
  assert.deepEqual(heavyLiveEffects(burst), ["light rays"], "the scene has rays, so its live picture gets its own layer");
  // Rays held before and after their range (keepStill both, the default) show all the time.
  assert.deepEqual(heavyLiveEffectsAt([layer("a", [rays({ start: 1, duration: 0.5 })])], 4), ["light rays"]);
  // A group's members start relative to the group.
  const grouped = [layer("a", [{ id: "g", kind: "composed", start: 2, duration: 1, animations: [rays({ start: 0.5, duration: 0.25, keepStill: "off" })] }])];
  assert.deepEqual(heavyLiveEffectsAt(grouped, 0.6), []);
  assert.deepEqual(heavyLiveEffectsAt(grouped, 2.6), ["light rays"]);
  // A layer that is not shown at that time (outside its playback window) draws no rays.
  const windowed = [layer("a", [rays({ duration: 6 })], { playbackWindows: [{ start: 2, end: 4, visibility: "none" }] })];
  assert.deepEqual(heavyLiveEffectsAt(windowed, 1), []);
  assert.deepEqual(heavyLiveEffectsAt(windowed, 3), ["light rays"]);
});

test("under reduced motion, a short burst the preview calms away does not count", () => {
  // calmLightAnimations leaves out a Light burst under 1 s that holds nothing (keepStill off).
  const short = [layer("a", [rays({ start: 1, duration: 0.5, keepStill: "off" })])];
  assert.deepEqual(heavyLiveEffects(short, { calmLight: true }), []);
  assert.deepEqual(heavyLiveEffectsAt(short, 1.2, { calmLight: true }), []);
  assert.deepEqual(heavyLiveEffectsAt(short, 1.2, { calmLight: false }), ["light rays"]);
  // A long rays animation is drawn under reduced motion too.
  assert.deepEqual(heavyLiveEffectsAt([layer("a", [rays({ duration: 6 })])], 3, { calmLight: true }), ["light rays"]);
});

test("the smaller picture has about 1280×720 device pixels of the scene's shape, whatever the stage's size", () => {
  assert.equal(MAX_LIVE_PIXELS, 1280 * 720);
  // A stage with no more device pixels than that is drawn at full resolution.
  assert.equal(reducedLayout({ width: 1280, height: 720, aspect: 16 / 9, ratio: 2 }), null, "exactly the budget");
  assert.equal(reducedLayout({ width: 1216, height: 684, aspect: 16 / 9, ratio: 2 }), null, "a small stage");
  assert.equal(reducedLayout({ width: 0, height: 0, aspect: 16 / 9, ratio: 2 }), null, "a stage not measured yet");
  assert.equal(reducedLayout({ width: Number.NaN, height: 100, aspect: 16 / 9, ratio: 2 }), null);
  // The stage zoomed to fill a 1716×916 window on a 2× screen (2652×1492 device pixels, measured
  // 2026-10-20), and the same stage after a resize: the same layout, so a resize only changes the
  // enlargement, and Chromium keeps drawing the layer at its first resolution (panes.jsx ReducedPicture).
  const zoomed = reducedLayout({ width: 2652, height: 1492, aspect: 16 / 9, ratio: 2 });
  assert.deepEqual(zoomed, { deviceWidth: 1280, deviceHeight: 720, width: 640, height: 360 });
  assert.deepEqual(reducedLayout({ width: 2300, height: 1294, aspect: 16 / 9, ratio: 2 }), zoomed, "a smaller window");
  assert.deepEqual(reducedLayout({ width: 3840, height: 2160, aspect: 16 / 9, ratio: 2 }), zoomed, "a larger window");
  // CSS pixels follow the screen; device pixels do not.
  assert.deepEqual(reducedLayout({ width: 1920, height: 1080, aspect: 16 / 9, ratio: 1 }), { deviceWidth: 1280, deviceHeight: 720, width: 1280, height: 720 });
  // A tall scene keeps its shape.
  const tall = reducedLayout({ width: 1080, height: 1920, aspect: 9 / 16, ratio: 2 });
  assert.deepEqual([tall.deviceWidth, tall.deviceHeight], [720, 1280]);
  const square = reducedLayout({ width: 2000, height: 2000, aspect: 1, ratio: 2 });
  assert.ok(Math.abs(square.deviceWidth * square.deviceHeight - MAX_LIVE_PIXELS) < 2000 && square.deviceWidth === square.deviceHeight, JSON.stringify(square));
});

// The agent docs say when the dashboard draws rays smaller and what its label says. They give no
// stage size in pixels: that depends on the window and the dashboard's layout, and a size measured
// in an earlier layout stayed in them after the layout changed. The label on
// screen is short ("drawn at 1280×720"); its tooltip says why.
test("the agent docs about the smaller live picture give no layout-dependent stage size and quote the label as drawn", async () => {
  for (const file of ["../skills/kino/references/light.md", "../backend/agent/operations.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(text, /drawn at 1280×720/, `${file} says what the label says`);
    assert.doesNotMatch(text, /\b\d{3,5}×\d{3,5} stage\b/, `${file} gives no stage size`);
  }
});
