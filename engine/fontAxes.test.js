// Variable font axes (fontAxes.js) on the Roboto Flex fixture (tests/fonts/SOURCES.md): values
// are clamped and, when animated, rounded; the face's ranges refuse an edit; the instances an
// animated layer makes stay few; font_fallback's facts confirm the variable face loaded.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertAxesInRange, interpolateAxes, normalizeAxes, variationSettings } from "./fontAxes.js";
import { FontRegistry, defaultFonts } from "./fonts.js";
import { layoutText } from "./textLayout.js";
import { fontFacts } from "./quality/textFacts.js";
import { evaluateLayer } from "./animation.js";

const FLEX = await readFile(new URL("../tests/fonts/roboto-flex-axes-subset.ttf", import.meta.url));
const AXES = { wght: { min: 100, max: 1000 }, wdth: { min: 25, max: 151 }, slnt: { min: -10, max: 0 } };
const text = (fields) => ({ type: "text", id: "t", name: "Title", text: "kino", fontFamily: "Roboto Flex", fontSize: 100, fontWeight: 400,
  fontStyle: "normal", width: 1000, height: 200, textResize: "width-height", letterSpacing: 0, lineHeight: 1.2, textAlign: "left",
  verticalAlign: "top", textCase: "normal", kerning: true, ligatures: true, animations: [], ...fields });

test("axes are checked, clamped to the face and rounded only when animated", () => {
  assert.throws(() => normalizeAxes({ GRAD: 10 }), /wght, wdth, slnt, opsz/);
  assert.throws(() => normalizeAxes({ slnt: -120 }), /-90 to 90/);
  assert.deepEqual(variationSettings(AXES, { fontWeight: 400, axes: { wdth: 300, slnt: -4.3 } }), { wght: 400, wdth: 151, slnt: -4.3 });
  // Animated: wght to 5 units, the others to 1% of their range (wdth steps of 1.26 from 25, slnt 0.1).
  assert.deepEqual(variationSettings(AXES, { axes: { wght: 432, wdth: 87.5, slnt: -4.33 } }, { quantize: true }), { wght: 430, wdth: 88, slnt: -4.3 });
  // An axis only one side names starts from the layer's own value (fontWeight for wght).
  assert.deepEqual(interpolateAxes({}, { wght: 800 }, 0.5, { fontWeight: 400 }), { wght: 600 });
  // An axis the animation does not name keeps the layer's value during and after it.
  const sweep = text({ axes: { wdth: 25 }, animations: [{ id: "a", kind: "custom", start: 0, duration: 1, easing: "linear",
    from: { axes: { wght: 100 } }, to: { axes: { wght: 900 } } }] });
  assert.deepEqual(evaluateLayer(sweep, 0.5).axes, { wdth: 25, wght: 500 });
  assert.deepEqual(evaluateLayer(sweep, 2).axes, { wdth: 25, wght: 900 });
});

test("a variable face draws each weight and width; an animated sweep reuses a few instances", () => {
  const fonts = new FontRegistry();
  fonts.register(FLEX);
  const width = (axes) => layoutText(text({ axes }), fonts).naturalWidth;
  assert.ok(width({ wght: 1000 }) > width({ wght: 100 }) + 20, "heavier is wider");
  assert.ok(width({ wdth: 151 }) > width({ wdth: 25 }) + 30, "the width axis widens it");
  const animated = text({ animations: [{ from: { axes: { wght: 100 } }, to: { axes: { wght: 1000 } } }] });
  const face = fonts.faces.find((entry) => entry.family === "Roboto Flex");
  const before = fonts.animatedVariations.get(face.font)?.size ?? 0;
  for (let frame = 0; frame <= 240; frame += 1) fonts.resolve({ ...animated, axes: { wght: 100 + frame * 3.75 } });
  assert.ok(fonts.animatedVariations.get(face.font).size - before <= 181, "240 frames make at most one instance per 5 units of weight");
  assert.deepEqual(fontFacts(text({ axes: { wdth: 80 } }), fonts).missingAxes, [], "the variable face loaded with every axis asked");
  assert.equal(fontFacts(text({ axes: { wdth: 80 } }), fonts).variable, true);
  assert.deepEqual(fontFacts(text({ fontFamily: "Inter", axes: { wdth: 80 } }), defaultFonts).missingAxes, ["wdth"], "Inter is not variable");
});

test("an edit asking for a value outside the face's range is refused with the range", () => {
  const fonts = new FontRegistry();
  fonts.register(FLEX);
  const documentWith = (layer) => ({ scenes: [{ id: "s", layers: [layer] }] });
  assert.throws(() => assertAxesInRange(documentWith(text()), documentWith(text({ axes: { wdth: 200 } })), fonts), /Title: wdth 200 is outside Roboto Flex's range 25 to 151/);
  assert.throws(() => assertAxesInRange(null, documentWith(text({ animations: [{ to: { axes: { opsz: 2 } } }] })), fonts), /opsz 2 is outside Roboto Flex's range 8 to 144/);
  assert.doesNotThrow(() => assertAxesInRange(null, documentWith(text({ axes: { wght: 900, slnt: -10 } })), fonts));
  assert.throws(() => assertAxesInRange(null, documentWith(text({ fontFamily: "Inter", axes: { wght: 650 } })), defaultFonts), /Inter has no wght axis \(it is not a variable font\)/);
});
