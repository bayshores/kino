import test from "node:test";
import assert from "node:assert/strict";
import { canvasLayerState } from "./canvasLayerState.js";
import { createLayer } from "../engine/model.js";
import { FontRegistry } from "../engine/fonts.js";

test("canvas text geometry retains the saved box until its font loads", () => {
  const layer = createLayer("text", { text: "Waiting", textResize: "width-height", width: 30, height: 20 });
  assert.equal(canvasLayerState(layer, { fonts: new FontRegistry() }), layer);
  const rectangle = createLayer("rectangle");
  assert.equal(canvasLayerState(rectangle), rectangle);
});
