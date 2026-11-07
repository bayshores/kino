// The checker's model (quality/kinoTimeline.js) reuses what a layer was at an earlier sample
// while the layer stands still, so a ten-minute scene builds in a fraction of a second. These
// tests build long scenes the way an agent would and check that the reused model is the same,
// sample for sample, as one that evaluates every layer at every sample (reuse: false).
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { applyOperations } from "./operations.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";

const fadeIn = (start, duration = 0.5) => ({ kind: "in", start, duration, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = (start, duration = 0.4) => ({ kind: "out", start, duration, easing: "ease-in", from: { opacity: 1 }, to: { opacity: 0 } });
const letters = (start, stagger) => ({ ...fadeIn(start, 0.3), unit: "letters", stagger, order: "forward", from: { opacity: 0, y: 40 }, to: { opacity: 1, y: 0 } });
const move = (start, duration, from) => ({ kind: "custom", start, duration, easing: "linear", from, to: {} });

function layer(type, fields) {
  const animations = (fields.animations ?? []).map((animation, index) => ({ id: `${fields.id}.${index + 1}`, name: `${animation.kind} ${index + 1}`, ...animation }));
  return createLayer(type, { name: fields.id, ...fields, animations });
}

// The same model twice: reused while still, and evaluated at every sample.
function bothModels(document, sceneId, fps) {
  const reused = kinoTimeline(document, sceneId, { fonts: defaultFonts, fps });
  const fresh = kinoTimeline(document, sceneId, { fonts: defaultFonts, fps, reuse: false });
  return { reused, fresh };
}

function assertSame({ reused, fresh }) {
  assert.deepEqual(reused.times, fresh.times);
  assert.equal(reused.items.length, fresh.items.length);
  for (let index = 0; index < fresh.items.length; index += 1) {
    const a = reused.items[index];
    const b = fresh.items[index];
    assert.equal(a.id, b.id);
    assert.deepEqual(Object.keys(a.samples), Object.keys(b.samples), a.id);
    for (const [key, values] of Object.entries(b.samples)) {
      if (!values) { assert.equal(a.samples[key], values, `${a.id} ${key}`); continue; }
      assert.deepEqual(Array.from(a.samples[key]), Array.from(values), `${a.id} ${key}`);
    }
    assert.deepEqual(a.texts, b.texts, `${a.id} texts`);
    assert.deepEqual(a.units, b.units, `${a.id} units`);
  }
}

test("a long scene's model is the same whether still layers are reused or evaluated afresh", () => {
  const duration = 300;
  const document = parseDocument(createDocument({
    scenes: [createScene({
      id: "long", name: "Long", width: 1920, height: 1080, duration, background: "#101418",
      layers: [
        // Letters that wait their turn, long after the start, then leave near the end.
        layer("text", { id: "title", text: "Ten minutes", x: 200, y: 200, fontSize: 96, fill: "#F2F2F2", textResize: "width-height", animations: [letters(120, 0.08), fadeOut(298)] }),
        // Hidden and shown again several times.
        layer("rectangle", { id: "flash", x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", animations: [{ kind: "hide", start: 0 }, { kind: "show", start: 60 }, { kind: "hide", start: 60.1 }, { kind: "show", start: 299 }, { kind: "hide", start: 299.02 }] }),
        // A slow move in the middle and a fade at the very end.
        layer("ellipse", { id: "dot", x: 900, y: 500, width: 120, height: 120, fill: "#e4572e", animations: [fadeIn(5), move(150, 30, { x: -600 }), fadeOut(295)] }),
        // A counter and a text change: the words change with no movement.
        layer("text", { id: "count", text: "0", x: 200, y: 600, fontSize: 72, fill: "#F2F2F2", textResize: "width-height", animations: [
          { kind: "counter", start: 200, duration: 20, easing: "linear", from: 0, to: 100, step: 1, out: null, in: null },
          { kind: "change-text", start: 250, text: "Done", out: null, in: null },
        ] }),
        // A video that plays from 40 s for 90 s, held on its frames before and after.
        layer("video", { id: "clip", src: "clip.mp4", x: 1200, y: 600, width: 480, height: 270, mediaSourceDuration: 120, mediaStart: 40, mediaOffset: 5, mediaDuration: 90 }),
        // A loop keeps moving after its first pass (behavior.js): never copied from earlier.
        layer("rectangle", { id: "swing", x: 600, y: 300, width: 80, height: 80, fill: "#2e86e4", animations: [{ ...move(10, 1, { x: 100 }), behavior: { loop: { mode: "pingpong" } } }] }),
        // A layer with no animations at all.
        layer("rectangle", { id: "bar", x: 0, y: 1000, width: 1920, height: 80, fill: "#203040" }),
      ],
    })],
  }));
  const models = bothModels(document, "long", 10);
  assert.equal(models.fresh.times.length, duration * 10 + 1, "every tenth of a second, both ends included");
  assertSame(models);
  // The flash is caught on screen at 299 s and nowhere near it.
  const flash = models.reused.items.find((item) => item.id === "flash");
  const at = (time) => models.reused.times.findIndex((sample) => Math.abs(sample - time) < 1e-6);
  assert.ok(flash.samples.opacity[at(299)] > 0.99);
  assert.ok(flash.samples.opacity[at(298.9)] < 0.01 && flash.samples.opacity[at(299.1)] < 0.01);
});

test("caption pages and layers inside moving groups are modelled the same with reuse", () => {
  const duration = 120;
  const stamp = (time) => `00:${String(Math.floor(time / 60)).padStart(2, "0")}:${String(Math.floor(time % 60)).padStart(2, "0")},${String(Math.round((time % 1) * 1000)).padStart(3, "0")}`;
  const srt = Array.from({ length: 34 }, (_, index) => `${index + 1}\n${stamp(index * 3.4)} --> ${stamp(index * 3.4 + 2.6)}\nLine ${index + 1} of the talk\n`).join("\n");
  let document = createDocument({
    scenes: [createScene({
      id: "talk", name: "Talk", width: 1920, height: 1080, duration, background: "#101418",
      layers: [
        // A group that moves twice, with a group inside it that fades, and words inside that.
        layer("group", { id: "outer", x: 0, y: 0, width: 1920, height: 1080, animations: [move(20, 10, { x: -300 }), move(100, 5, { y: 200 })] }),
        layer("group", { id: "inner", parentId: "outer", x: 100, y: 100, width: 800, height: 400, animations: [fadeIn(40, 2), fadeOut(90, 2)] }),
        layer("text", { id: "words", parentId: "inner", text: "Inside", x: 120, y: 120, fontSize: 64, fill: "#F2F2F2", textResize: "width-height", animations: [letters(60, 0.1)] }),
      ],
    })],
  });
  document = applyOperations(document, [{ type: "add_captions", sceneId: "talk", text: srt, appear: "fade" }], { fonts: defaultFonts });
  const models = bothModels(document, "talk", 10);
  assert.ok(models.fresh.items.length > 60, "every caption page is a group with its text inside");
  assertSame(models);
});

test("a ten-minute sequence of scenes is modelled the same with reuse", () => {
  const scenes = [200, 200, 200].map((length, index) => createScene({
    id: `p${index + 1}`, name: `Part ${index + 1}`, width: 1080, height: 1920, duration: length, background: "#101418",
    layers: [layer("text", { id: `t${index + 1}`, text: `Part ${index + 1}`, x: 240, y: 800, width: 600, height: 120, fontSize: 96, fill: "#F2F2F2", textAlign: "center", animations: [letters(1, 0.05), fadeOut(length - 1)] })],
  }));
  const document = applyOperations(createDocument({ scenes }), [{ type: "add_sequence", properties: { id: "seq", name: "Film" }, scenes: ["p1", "p2", "p3"], transition: "crossfade" }], { fonts: defaultFonts });
  const models = bothModels(document, "seq", 4);
  assert.ok(models.fresh.duration > 590);
  assertSame(models);
});

test("a Change text with Out and In effects (no duration of its own) is modelled the same with reuse", () => {
  // The status-line move swaps its words this way: a blur-out then a slide-up, 0.38 s in all,
  // held for seconds before a fade out. Copying the sample just after the start kept the half
  // gone old words until the fade, so reading_time saw the new words for 0.07 s.
  const swap = { kind: "change-text", start: 3, text: "is finding a store…", overlap: false,
    out: { preset: "blur-out", duration: 0.14, easing: "ease-in", unit: "layer", stagger: 0, order: "forward" },
    in: { preset: "slide-up", duration: 0.24, easing: "ease-out", unit: "layer", stagger: 0, order: "forward", distance: 20 } };
  const document = parseDocument(createDocument({
    scenes: [createScene({
      id: "swap", name: "Swap", width: 1920, height: 1080, duration: 8, background: "#101418",
      layers: [layer("text", { id: "status", text: "is listening…", x: 200, y: 400, fontSize: 72, fill: "#F2F2F2", textResize: "width-height", animations: [fadeIn(1), swap, fadeOut(6)] })],
    })],
  }));
  const models = bothModels(document, "swap", 30);
  assertSame(models);
  const status = models.reused.items.find((item) => item.id === "status");
  const shownAt = (time) => status.texts[status.samples.textIndex[Math.round(time * 30)]];
  assert.equal(shownAt(5), "is finding a store…");
  assert.ok(status.samples.opacity[Math.round(5 * 30)] > 0.99);
});
