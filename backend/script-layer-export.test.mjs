// Script layers through the agent path: a layer added by `edit` shows its drawn picture in `look`
// frames and in a rendered video, a changed value draws a new frame (look's cache misses) and the
// same look again comes from the cache; a failing script is left out with a sentence naming the
// layer, the message and the time, and a final render with it is refused.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { hasMediaTools, readImage, readVideoFrames, startTestServer } from "./media.test.support.mjs";
import { clearScriptFrameCache, closeScriptRenderer, sceneScriptFrames, scriptFrameCacheSize, scriptRenderer } from "./script-layer-frames.mjs";
import { lacksWebgl, makeGlb } from "./glb.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const require = createRequire(import.meta.url);
function electronSkip() {
  if (!hasMediaTools) return "FFmpeg is required";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "Electron needs a display (CI runs under xvfb-run)";
  try { return existsSync(require("electron")) ? false : "Electron is not installed"; } catch { return "Electron is not installed"; }
}
const skip = electronSkip();

// A red bar across the layer, as wide as `reveal` says.
const BAR = `export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) {
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, frame.width * frame.values.reveal, frame.height);
  };
}`;
const BROKEN = "export default function setup(layer) {\n  layer.canvas.getContext(\"2d\");\n  return function draw(frame) {\n    if (frame.time > 0.2) missing.value = 1;\n  };\n}";

let server;
after(async () => { await server?.stop(); await closeScriptRenderer(); });

const isRed = ([r, g, b]) => r > 200 && g < 50 && b < 50;
const isDark = ([r, g, b]) => r < 40 && g < 40 && b < 40;

test("a frame drawn once is not drawn again; another value, time or pixel ratio is", async () => {
  clearScriptFrameCache();
  const asked = [];
  const renderer = { render: async ({ frames, pixelRatio }) => frames.map((frame) => { asked.push(`${frame.time}@${pixelRatio}`); return { png: Buffer.from(`${frame.time}`), empty: false }; }) };
  const layer = { id: "L1", type: "script", name: "bar", x: 0, y: 0, width: 100, height: 50, script: BAR, inputs: [{ key: "reveal", type: "number" }], values: { reveal: 1 }, animations: [] };
  const scene = (values, width = 200) => ({ width: 200, height: 100, duration: 1, layers: [{ ...layer, values }], dims: { width, height: width / 2 } });
  const prepare = async (made, times) => sceneScriptFrames(made, { dimensions: made.dims, renderer }).prepare(times);
  await prepare(scene({ reveal: 1 }), [0, 0.5]);
  await prepare(scene({ reveal: 1 }), [0, 0.5, 0.75]);
  assert.deepEqual(asked, ["0@1", "0.5@1", "0.75@1"], "only the new time is drawn");
  await prepare(scene({ reveal: 0.5 }), [0]);
  await prepare(scene({ reveal: 1 }, 400), [0]);
  assert.deepEqual(asked.slice(3), ["0@1", "0@2"], "a new value and a 2x output draw again");
  assert.equal(scriptFrameCacheSize(), 5);
});

test("a Lottie export refuses a script layer, names it and says what to use instead", async () => {
  const layer = createLayer("script", { id: "L1", name: "bars", width: 100, height: 50, script: BAR, inputs: [{ key: "reveal", type: "number" }], values: { reveal: 1 } });
  const scene = createScene({ id: "s1", width: 200, height: 100, duration: 1, layers: [layer] });
  await assert.rejects(exportScene(scene, { format: "lottie", fps: 5 }),
    /Lottie export cannot hold script layer “bars”: its picture is drawn by code each frame\. Use PNG, video, or GIF export, or hide the layer for Lottie\./);
});

test("the 3D example in the skill runs as written: an imported .glb shows in a look frame and turns in a draft render", { skip, timeout: 60_000 }, async (t) => {
  // A machine with no graphics card (the CI runners) has no WebGL: the test then only notes what
  // the agent is told and skips the pixel checks, as the plain WebGL test does.
  const noWebgl = await lacksWebgl(scriptRenderer());
  server ??= await startTestServer();
  const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
  const made = await agent("project", { action: "create", id: "cube", name: "cube", width: 320, height: 180, duration: 1, background: "#000000" });
  assert.equal(made.isError, undefined, made.text);
  const upload = await server.api("/api/media?project=cube", { method: "POST", headers: { "content-type": "model/gltf-binary", "x-file-name": "cube.glb" }, body: makeGlb() });
  assert.equal(upload.status, 201, await upload.clone().text());
  const media = await upload.json();
  assert.deepEqual([media.mime, media.model.meshes], ["model/gltf-binary", 1]);
  const [[example]] = jsonBlocks(skillSection("Example: a model that turns once"));
  example.properties = { ...example.properties, x: 70, y: 0, width: 180, height: 180, values: { model: media.src } };
  const edit = await agent("edit", { project: "cube", ops: [example] });
  assert.equal(edit.isError, undefined, edit.text);
  if (!noWebgl) assert.doesNotMatch(edit.text, /script "cube"/, "the receipt's test draw found no problem");
  const look = await agent("look", { project: "cube", mode: "frame", t: 0, width: 320 });
  if (noWebgl) {
    t.diagnostic(`without WebGL the edit says: ${edit.text.slice(0, 400)}`);
    t.diagnostic(`without WebGL look says: ${look.text.slice(0, 400)}`);
    return t.skip("webgl2 is not available in the hidden window");
  }
  const image = await readImage(Buffer.from(look.images[0].data, "base64"));
  assert.ok(isRed(image.pixel(160, 90)), `the red cube in the middle: ${image.pixel(160, 90)}`);
  assert.ok(isDark(image.pixel(10, 90)), "the background beside it");
  const render = await agent("render", { project: "cube", action: "start", format: "mp4", options: { duration: 0.5 }, wait: true });
  assert.equal(render.isError, undefined, render.text);
  const { path: file, width, height } = render.data.files[0];
  const video = await readVideoFrames(file, { width, height });
  const middle = (frame) => frame.pixel(Math.round(width / 2), Math.round(height / 2));
  assert.ok(isRed(middle(video[0])), `the first frame shows the cube: ${middle(video[0])}`);
  assert.notDeepEqual(middle(video[0]), middle(video.at(-1)), "it turned between the first and last frame");
});

test("a script layer added by edit shows in look frames and a render, and look's cache follows its values", { skip, timeout: 60_000 }, async () => {
  server ??= await startTestServer();
  const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
  const made = await agent("project", { action: "create", id: "bars", name: "bars", width: 320, height: 180, duration: 0.5, background: "#000000" });
  assert.equal(made.isError, undefined, made.text);
  const edit = await agent("edit", { project: "bars", ops: [
    { op: "add_layer", layerType: "script", name: "bar", properties: { x: 0, y: 0, width: 320, height: 180, script: BAR,
      inputs: [{ key: "reveal", type: "number", min: 0, max: 1 }], values: { reveal: 1 } } },
    { op: "add_animation", layer: "bar", animation: { kind: "custom", start: 0, duration: 0.5, easing: "linear", from: { values: { reveal: 0 } }, to: { values: { reveal: 1 } } } },
  ] });
  assert.equal(edit.isError, undefined, edit.text);

  const frame = async (t) => {
    const reply = await agent("look", { project: "bars", mode: "frame", t, width: 320 });
    assert.equal(reply.isError, undefined, reply.text);
    return { reply, image: await readImage(Buffer.from(reply.images[0].data, "base64")) };
  };
  // reveal is 0.25 at 0.125 s (80 px of red) and 0.75 at 0.375 s (240 px).
  const firstLook = await frame(0.125);
  const early = firstLook.image, late = (await frame(0.375)).image;
  assert.ok(isRed(early.pixel(40, 90)) && isDark(early.pixel(160, 90)), `a quarter is red at 0.125 s: ${early.pixel(40, 90)} ${early.pixel(160, 90)}`);
  assert.ok(isRed(late.pixel(160, 90)) && isDark(late.pixel(300, 90)), `three quarters at 0.375 s: ${late.pixel(160, 90)} ${late.pixel(300, 90)}`);

  // A short render: the first frame has no bar, the last nearly a full one.
  const render = await agent("render", { project: "bars", action: "start", format: "mp4", options: { duration: 0.5 }, wait: true });
  assert.equal(render.isError, undefined, render.text);
  // A draft is drawn at half size (160 x 90), so the script draws at pixel ratio 0.5.
  const { path: file, width, height } = render.data.files[0];
  const video = await readVideoFrames(file, { width, height });
  assert.equal(video.length, 15);
  const at = (x) => Math.round(x * width / 320);
  assert.ok(isDark(video[0].pixel(at(40), height / 2)), `frame 1 has no bar: ${video[0].pixel(at(40), height / 2)}`);
  assert.ok(isRed(video.at(-1).pixel(at(280), height / 2)), `the last frame's bar reaches 280 px: ${video.at(-1).pixel(at(280), height / 2)}`);

  // Changing the value (no animation now) draws a new frame; asking again is served from the cache.
  const frames = path.join(server.dataDirectory, "agent", "frames");
  const cached = async () => (await readdir(frames, { recursive: true })).length;
  const changed = await agent("edit", { project: "bars", ops: [{ op: "delete_animation", layer: "bar", animation: "A1" }, { op: "update_layer", layer: "bar", properties: { values: { reveal: 0.5 } } }] });
  assert.equal(changed.isError, undefined, changed.text);
  const before = await cached();
  const half = (await frame(0.125)).image;
  assert.ok(isRed(half.pixel(150, 90)) && isDark(half.pixel(170, 90)), "half the width at reveal 0.5");
  const drawn = await cached();
  assert.ok(drawn > before, "the changed value missed the cache and drew a new frame");
  const again = (await frame(0.125)).image;
  assert.deepEqual(again.pixel(150, 90), half.pixel(150, 90));
  assert.equal(await cached(), drawn, "the same look again is a cache hit");

  // A script that throws: look leaves the layer out and says which layer, what and when.
  const broken = await agent("edit", { project: "bars", ops: [{ op: "update_layer", layer: "bar", properties: { script: BROKEN } }] });
  assert.equal(broken.isError, undefined, broken.text);
  const { reply } = await frame(0.4);
  assert.match(reply.text, /script layer "bar": ReferenceError: missing is not defined at 0\.40 s \(draw\)/);
  // check names the same layer as an error, from the real renderer's report (the script throws after 0.2 s of layer time).
  const checked = await agent("check", { project: "bars", rules: ["script_layer_error"] });
  assert.match(checked.text, /E script_layer_error bar @[\d.]+: script layer "bar": ReferenceError: missing is not defined at [\d.]+ s \(draw\)/, checked.text);
  const record = await (await server.api("/api/projects/bars")).json();
  await server.stop();
  server = null;

  // A final render with that error is refused with the same sentence; a draft carries it as a warning.
  const scene = record.document.scenes[0];
  await assert.rejects(exportScene(scene, { format: "png", time: 0.4, renderQuality: "final" }), /script layer "bar": ReferenceError: missing is not defined at 0\.40 s/);
  const draft = await exportScene(scene, { format: "png", time: 0.4 });
  assert.deepEqual(draft.warnings.map((warning) => warning.code), ["script-layer-error"]);
});
