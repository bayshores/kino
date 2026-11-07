// Exports leave out an operation turned off for playback (engine/animationEnabled.js), the same way
// the editor does: PNG stills and PNG sequences (which GIF and video encode) draw the frames
// without it, and Lottie writes no keyframes for it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { near, readImage } from "./media.test.support.mjs";

const off = (animation) => ({ ...animation, enabled: false });
const slide = { id: "slide", name: "Slide", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 0 }, to: { x: 80 } };
// Move has no From x: it starts from whatever x Slide left, or the layer's own x without Slide.
const move = { id: "move", name: "Move", kind: "custom", start: 1, duration: 1, easing: "linear", from: {}, to: { x: 40 } };
const fade = { id: "fade", name: "Fade in", kind: "in", start: 0, duration: 1, easing: "linear", from: { opacity: 0 }, to: { opacity: 1 } };
const hide = { id: "hide", name: "Hide", kind: "hide", start: 0.5 };

function scene(animations, duration = 2) {
  const box = createLayer("rectangle", { id: "box", name: "Box", x: 10, y: 10, width: 20, height: 20, fill: "#ff0000", strokeWidth: 0, animations });
  return createScene({ id: "enabled", name: "Enabled", width: 100, height: 40, duration, background: "#ffffff", layers: [box] });
}

async function lottie(document, fps = 10) {
  const animation = JSON.parse((await exportScene(document, { format: "lottie", fps })).buffer.toString("utf8"));
  return animation.layers.find((layer) => layer.nm === "Box");
}

const RED = [255, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

test("Lottie leaves out an operation that is off, and later operations start without it", async () => {
  const on = await lottie(scene([slide, move]));
  assert.equal(on.ks.p.a, 1, "Slide and Move animate the position");
  // Slide off: the box stays at its own x (center 20) for the first second, then Move takes it
  // from there to x 40 (center 50), not from Slide's end.
  const withoutSlide = await lottie(scene([off(slide), move]));
  const centers = withoutSlide.ks.p.k.map((keyframe) => [keyframe.t, keyframe.s[0]]);
  for (const [frame, x] of centers) {
    const expected = frame <= 10 ? 20 : 20 + 30 * Math.min(1, (frame - 10) / 10);
    assert.ok(Math.abs(x - expected) < 1e-6, `frame ${frame}: center x ${x}, expected ${expected}`);
  }
  // Both off: nothing moves, so the position is a static value.
  const still = await lottie(scene([off(slide), off(move)]));
  assert.deepEqual(still.ks.p, { a: 0, k: [20, 20, 0] });
  // Fade In off: full opacity from the first frame; a Hide that is off writes no switch to 0.
  assert.deepEqual((await lottie(scene([off(fade)]))).ks.o, { a: 0, k: 100 });
  assert.equal((await lottie(scene([hide]))).ks.o.a, 1, "a Hide that is on switches the opacity");
  assert.deepEqual((await lottie(scene([off(hide)]))).ks.o, { a: 0, k: 100 });
});

test("PNG stills and PNG sequences draw the frames without an operation that is off", async (t) => {
  // At 0.5 s a Fade In that is on draws the box half transparent; off, the box is fully red.
  const half = await readImage((await exportScene(scene([fade]), { format: "png", time: 0.5 })).buffer);
  assert.ok(!near(half.pixel(20, 20), RED), "the fade is halfway");
  const full = await readImage((await exportScene(scene([off(fade)]), { format: "png", time: 0.5 })).buffer);
  assert.ok(near(full.pixel(20, 20), RED), "the fade that is off does nothing");
  // A Hide that is off leaves the box drawn after its time.
  const shown = await readImage((await exportScene(scene([off(hide)]), { format: "png", time: 1 })).buffer);
  assert.ok(near(shown.pixel(20, 20), RED));
  const hidden = await readImage((await exportScene(scene([hide]), { format: "png", time: 1 })).buffer);
  assert.ok(near(hidden.pixel(20, 20), WHITE));

  const directory = await mkdtemp(join(tmpdir(), "kino-enabled-sequence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = join(directory, "sequence");
  await mkdir(sequenceDirectory);
  await exportScene(scene([off(slide)], 1), { format: "png-sequence", fps: 4 }, { sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 4);
  for (const name of names) {
    const frame = await readImage(await readFile(join(sequenceDirectory, name)));
    assert.ok(near(frame.pixel(20, 20), RED) && near(frame.pixel(60, 20), WHITE), `${name}: the box stays where it is`);
  }
});
