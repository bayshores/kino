// Rendered proof for place {around} (engine/subjectRoom.js): a subject box in the middle of the
// frame, a word set behind a cut-out of it and a word set over it. The covered share of the
// letters is counted in rendered pixels before and after the placement.
import assert from "node:assert/strict";
import test from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { placeAroundSubject } from "../engine/subjectRoom.js";
import { renderStills } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage } from "./media.test.support.mjs";

const WIDTH = 1920, HEIGHT = 1080, SHOWN = 480, K = SHOWN / WIDTH;
const SUBJECT = { x0: 760, y0: 200, x1: 1160, y1: 1080 };
const BOUNDS = { x0: 96, y0: 54, x1: 1824, y1: 1026 };

const word = () => createLayer("text", { id: "word", name: "word", text: "KILL YOU", fill: "#ffffff", fontFamily: "Inter", fontWeight: 700, fontSize: 200, textResize: "width-height", x: 560, y: 440, width: 800, height: 240 });
// The subject: a flat red box, as a cut_out copy keeps it (cutoutOf, subjectBox in shares of its box).
const subject = (visible = true) => createLayer("rectangle", { id: "person", name: "person", fill: "#ff0000", x: SUBJECT.x0, y: SUBJECT.y0, width: SUBJECT.x1 - SUBJECT.x0, height: SUBJECT.y1 - SUBJECT.y0, cutoutOf: "shot", subjectBox: [0, 0, 1, 1], allowOverlap: true, visible });
const sceneOf = (layers) => createScene({ id: "s", width: WIDTH, height: HEIGHT, duration: 1, background: "#000000", layers });

// White letter pixels in the frame, and those inside the subject box.
async function letters(layers) {
  const [still] = await renderStills(sceneOf(layers), [0], { width: SHOWN });
  const image = await readImage(still.buffer);
  let all = 0, inside = 0;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const [r, g, b] = image.pixel(x, y);
    if (r < 160 || g < 160 || b < 160) continue;
    all += 1;
    if (x >= SUBJECT.x0 * K && x < SUBJECT.x1 * K && y >= SUBJECT.y0 * K && y < SUBJECT.y1 * K) inside += 1;
  }
  return { all, inside };
}

const split = (layers) => (layer) => {
  const copy = { ...structuredClone(layer), id: `${layer.id}-2`, name: `${layer.name} 2` };
  layers.splice(layers.indexOf(layer) + 1, 0, copy);
  return copy;
};

test("rendered frames: a line behind a cut-out and a line over the subject keep every letter out of the subject box after place {around}", { timeout: 60_000 }, async () => {
  const fonts = await loadBundledFonts();
  // Behind: the share hidden is 1 - letters drawn with the cut-out over them / letters without it.
  const behind = [word(), subject()];
  const hiddenBefore = 1 - (await letters(behind)).all / (await letters([behind[0], subject(false)])).all;
  const scene = sceneOf(behind);
  const placed = placeAroundSubject(scene, [scene.layers[0]], SUBJECT, { fonts, gap: 24, bounds: BOUNDS, least: 36, split: split(scene.layers) });
  const words = scene.layers.filter((layer) => layer.type === "text");
  const hiddenAfter = 1 - (await letters([...words, subject()])).all / (await letters([...words, subject(false)])).all;
  assert.ok(hiddenBefore > 0.3, `the cut-out hid ${hiddenBefore} of the letters before`);
  assert.equal(placed.side, "split");
  assert.ok(hiddenAfter < 0.01, `the cut-out hides ${hiddenAfter} of the letters after`);
  assert.ok(placed.before > 0.3 && placed.after === 0, "the receipt's measured share agrees");

  // In front: letters drawn over the subject box hide the subject.
  const front = [subject(), word()];
  const overBefore = await letters(front);
  const frontScene = sceneOf(front);
  placeAroundSubject(frontScene, [frontScene.layers[1]], SUBJECT, { fonts, gap: 24, bounds: BOUNDS, least: 36, split: split(frontScene.layers) });
  const overAfter = await letters(frontScene.layers);
  assert.ok(overBefore.inside / overBefore.all > 0.3, `${overBefore.inside} of ${overBefore.all} letter pixels sat on the subject before`);
  assert.equal(overAfter.inside, 0, "no letter pixel on the subject after");
  assert.ok(overAfter.all > 0.9 * overBefore.all, "every letter is still drawn, at its size");
});
