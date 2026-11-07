import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_LEAD,
  capturingAt,
  createLatestFrameQueue,
  videoCaptureWindows,
  isCurrentVideoCapture,
  MAX_VIDEO_FRAME_PIXELS,
  MAX_VIDEO_FRAME_SIDE,
  videoFrameCanvasSize,
  videoFrameEncoding,
  videoFrameLayerIds,
} from "./videoPreview.js";

const video = (id, properties = {}) => ({ id, type: "video", src: `/api/media/${id}.mp4`, ...properties });
const group = (id, properties = {}) => ({ id, type: "group", ...properties });

test("video preview eligibility follows enabled effects and skips hidden component ancestors", () => {
  const effect = { id: "fx", kind: "effect", effect: "bulge", start: 0, duration: 1, to: {} };
  const scene = { layers: [
    video("preset", { effectPreset: { id: "dissolve", progress: 0.5 } }),
    video("animated", { animations: [{ ...effect, enabled: true }] }),
    video("disabled", { animations: [{ ...effect, enabled: false }] }),
    group("off", { visible: false, componentOwnerId: "instance" }),
    video("hidden-child", { parentId: "off", effectPreset: { id: "glitch", progress: 0.5 } }),
    video("ordinary"),
    group("effect-parent", { effectPreset: { id: "barrel", progress: 0.5 } }),
    video("effect-child", { parentId: "effect-parent" }),
    group("animated-effect-parent", { animations: [{ ...effect, id: "group-fx" }] }),
    video("animated-effect-child", { parentId: "animated-effect-parent" }),
  ] };
  assert.deepEqual([...videoFrameLayerIds(scene)], ["preset", "animated", "effect-child", "animated-effect-child"]);
});

test("a video is captured only when an effect works while it shows", () => {
  // A zoom blur from 2 to 3 s that ends at amount 0, and one that holds amount 0.3 after it ends.
  const fadesOut = { id: "z", kind: "effect", effect: "zoom-blur", start: 2, duration: 1, from: { amount: 0.3 }, to: { amount: 0 } };
  const holds = { ...fadesOut, to: { amount: 0.3 } };
  const clip = (id, mediaStart, animations, properties = {}) =>
    video(id, { mediaStart, mediaDuration: 2, mediaFreeze: "none", animations, ...properties });
  const scene = { layers: [
    clip("during", 1.5, [fadesOut]),
    clip("after-neutral", 4, [fadesOut]),
    clip("after-held", 4, [holds]),
    clip("before", 0, [{ ...fadesOut, start: 2.2 }]),
    clip("frozen-last", 0, [{ ...fadesOut, start: 2.2 }], { mediaFreeze: "last" }),
    clip("ranged-held", 6, [{ id: "r", kind: "effect", effect: "fluid-warp", start: 0, duration: 1, to: {} }]),
    clip("ranged-done", 6, [{ id: "r", kind: "effect", effect: "fluid-warp", start: 0, duration: 1, to: {}, keepStill: "off" }]),
    group("fx-group", { animations: [fadesOut] }),
    clip("group-after", 4, [], { parentId: "fx-group" }),
    clip("component-clock", 4, [fadesOut], { playbackWindows: [{ start: 0, end: 10 }] }),
    clip("group-component-clock", 4, [], { parentId: "fx-group", playbackWindows: [{ start: 0, end: 10, hold: true }] }),
  ] };
  assert.deepEqual([...videoFrameLayerIds(scene)],
    ["during", "after-held", "frozen-last", "ranged-held", "component-clock", "group-component-clock"]);
  // Captured only while an effect changes the picture, a margin wide, and from a lead before it.
  const round = (list) => list.map((window) => window.map((time) => Math.round(time * 100) / 100));
  const windows = new Map([...videoCaptureWindows(scene)].map(([id, list]) => [id, round(list)]));
  assert.deepEqual(windows.get("during"), [[1.9, 3.1]]);
  assert.deepEqual(windows.get("after-held"), [[3.85, 6.15]]);
  assert.deepEqual(windows.get("component-clock"), [[-Infinity, Infinity]]);
  const two = videoCaptureWindows({ layers: [clip("two", 0, [fadesOut, { ...fadesOut, start: 2.9 }, { ...fadesOut, start: 5, duration: 0.5 }], { mediaDuration: 8 })] });
  assert.deepEqual(round(two.get("two")), [[1.9, 4.0], [4.9, 5.6]]);
  // A held zoom blur stops counting once a later one (that ends at amount 0) takes over.
  const handOver = videoCaptureWindows({ layers: [clip("hand-over", 0, [holds, { ...fadesOut, start: 5 }], { mediaDuration: 10 })] });
  assert.deepEqual(round(handOver.get("hand-over")), [[1.9, 6.1]]);
  // Tilted in 3D or a mask: a canvas there draws nothing, so the whole shown time stays captured.
  const pictures = videoCaptureWindows({ layers: [clip("tilted", 1.5, [fadesOut], { rotateY: 20 }),
    group("mask", { isMask: true }), clip("in-mask", 1.5, [fadesOut], { parentId: "mask" })] });
  assert.deepEqual([...pictures.values()], [[[-Infinity, Infinity]], [[-Infinity, Infinity]]]);
  // With no effect at all too: a tilted app recording drew nothing (no picture was captured).
  const plain = videoCaptureWindows({ layers: [clip("tilted-plain", 1.5, [], { rotateX: 30 })] });
  assert.deepEqual(plain.get("tilted-plain"), [[-Infinity, Infinity]]);
  const [first] = two.get("two");
  assert.deepEqual([1.5, 1.7, 3, 4.05, 4.7].map((time) => capturingAt([first], time)), [false, false, true, false, false]);
  assert.deepEqual([1.5, 1.7].map((time) => capturingAt([first], time, CAPTURE_LEAD)), [false, true]);
});

test("a backdrop style anywhere captures every visible video, including expanded component children", () => {
  const scene = { layers: [
    video("lower"),
    group("component-instance", { componentOwnerId: "source" }),
    video("expanded-child", { parentId: "component-instance", componentOwnerId: "source", componentPath: "root/clip" }),
    { id: "glass", type: "rectangle", glass: { enabled: true, strength: 0.7 } },
    group("hidden", { visible: false }),
    { id: "hidden-blur", type: "rectangle", parentId: "hidden", backgroundBlur: { enabled: true, radius: 8 } },
  ] };
  assert.deepEqual([...videoFrameLayerIds(scene)], ["lower", "expanded-child"]);
});

test("enabled nested backdrop animation captures videos while disabled composed members do not", () => {
  const backdropChange = { id: "blur", kind: "in", start: 0, duration: 1,
    from: { backgroundBlur: { enabled: false } }, to: { backgroundBlur: { enabled: true, radius: 12 } } };
  const scene = { layers: [
    video("one"), video("two"),
    { id: "animated-blur", type: "rectangle", animations: [
      { id: "disabled-group", kind: "composed", start: 0, enabled: false, animations: [backdropChange] },
    ] },
  ] };
  assert.deepEqual([...videoFrameLayerIds(scene)], []);
  scene.layers[2].animations[0].enabled = true;
  assert.deepEqual([...videoFrameLayerIds(scene)], ["one", "two"]);
});

test("canvas sizing stays proportional under side and total-pixel limits", () => {
  assert.equal(videoFrameCanvasSize(0, 100), null);
  assert.equal(videoFrameCanvasSize(Number.NaN, 100), null);
  const wide = videoFrameCanvasSize(3840, 2160);
  assert.deepEqual(wide, { width: 2048, height: 1152 });
  const square = videoFrameCanvasSize(4000, 4000);
  assert.deepEqual(square, { width: 2000, height: 2000 });
  assert.deepEqual(videoFrameCanvasSize(1920, 1080, 1550), { width: 1550, height: 871 }, "while playing: no bigger than the stage");
  for (const size of [wide, square, videoFrameCanvasSize(720, 1280)]) {
    assert.ok(size.width <= MAX_VIDEO_FRAME_SIDE && size.height <= MAX_VIDEO_FRAME_SIDE);
    assert.ok(size.width * size.height <= MAX_VIDEO_FRAME_PIXELS);
  }
});

test("capture results reject stale seeks and sources but allow queued playback frames", () => {
  const base = { generation: 3, currentGeneration: 3, source: "a.mp4", currentSource: "a.mp4",
    captureTime: 2, currentTime: 2.01, wasPlaying: false, isPlaying: false };
  assert.equal(isCurrentVideoCapture(base), true);
  assert.equal(isCurrentVideoCapture({ ...base, currentGeneration: 4 }), false);
  assert.equal(isCurrentVideoCapture({ ...base, currentSource: "b.mp4" }), false);
  assert.equal(isCurrentVideoCapture({ ...base, currentTime: 2.2 }), false);
  assert.equal(isCurrentVideoCapture({ ...base, seeking: true }), false);
  assert.equal(isCurrentVideoCapture({ ...base, wasPlaying: true, isPlaying: true, currentTime: 5 }), true);
  assert.equal(isCurrentVideoCapture({ ...base, wasPlaying: true, isPlaying: false }), false);
});

test("frame queue serializes encodes and keeps only the latest event while busy", async () => {
  let releaseFirst;
  let signalStarted;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const processed = [];
  let active = 0, maximum = 0;
  const queue = createLatestFrameQueue(async (frame) => {
    active += 1;
    maximum = Math.max(maximum, active);
    processed.push(frame);
    if (frame === "first") signalStarted();
    if (frame === "first") await firstGate;
    active -= 1;
  });
  queue.enqueue("first");
  await firstStarted;
  queue.enqueue("intermediate");
  queue.enqueue("latest");
  releaseFirst();
  await queue.waitForIdle();
  assert.deepEqual(processed, ["first", "latest"]);
  assert.equal(maximum, 1);
  queue.dispose();
});

test("disposing a frame queue drops pending captures after the active encode", async () => {
  let releaseFirst;
  let signalStarted;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const processed = [];
  const queue = createLatestFrameQueue(async (frame) => {
    processed.push(frame);
    if (frame === "first") { signalStarted(); await firstGate; }
  });
  queue.enqueue("first");
  await firstStarted;
  queue.enqueue("obsolete");
  queue.dispose();
  releaseFirst();
  await queue.waitForIdle();
  assert.deepEqual(processed, ["first"]);
});

test("captured frames of an MP4 are high-quality JPEGs; a file that can be see-through stays PNG", () => {
  assert.deepEqual(videoFrameEncoding("/api/media/clip.mp4"), { type: "image/jpeg", quality: 0.95 });
  assert.deepEqual(videoFrameEncoding("/api/media/clip.M4V?share=abc"), { type: "image/jpeg", quality: 0.95 });
  for (const source of ["/api/media/alpha.webm", "/api/media/clip.mov", "/api/media/clip.mp4.webm", undefined])
    assert.equal(videoFrameEncoding(source).type, "image/png", String(source));
});
