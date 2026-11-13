import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { evaluateLayer } from "./animation.js";
import { renderSceneSvg } from "./render.js";
import { frameFor, scriptKey, scriptLibraryNames, scriptProblem } from "./scriptLayer.js";

const SCRIPT = `export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) {
    ctx.fillStyle = frame.values.tint.css;
    ctx.fillRect(0, 0, frame.width * frame.values.reveal, frame.height);
  };
}
`;
const INPUTS = [
  { key: "reveal", type: "number", min: 0, max: 1, step: 0.01 },
  { key: "tint", type: "color" },
  { key: "mode", type: "select", options: ["bars", "dots"] },
];
const VALUES = { reveal: 1, tint: "#ff0000", mode: "bars" };

function scriptLayer(overrides = {}) {
  return createLayer("script", { id: "s", name: "Bars", script: SCRIPT, inputs: INPUTS, values: VALUES, ...overrides });
}
function parse(layer) {
  return parseDocument(createDocument({ scenes: [createScene({ id: "a", duration: 4, layers: [layer] })] })).scenes[0].layers[0];
}

test("a script layer saves its module, inputs and values", () => {
  const layer = parse(scriptLayer());
  assert.equal(layer.type, "script");
  assert.deepEqual(layer.values, VALUES);
  assert.deepEqual(layer.inputs.map((input) => input.key), ["reveal", "tint", "mode"]);
});

test("a script layer's module is refused with a sentence for import, no default export and bad syntax", () => {
  assert.match(scriptProblem(`import x from "y";\nexport default function setup() {}`), /imports "y" on line 1; a script may import only "three"/);
  assert.match(scriptProblem(`import * as THREE from "https://cdn.example/three.js";\nexport default function setup() {}`), /imports "https:\/\/cdn\.example\/three\.js" on line 1/);
  assert.match(scriptProblem(`const a = await import("three");\nexport default function setup() {}`), /uses import\(\) on line 1; a script may import only "three".*GLTFLoader/);
  const threeD = `import * as THREE from "three";\nimport { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nexport default function setup() { return () => {}; }`;
  assert.equal(scriptProblem(threeD), "");
  assert.deepEqual(scriptLibraryNames(threeD), ["three", "three/addons/loaders/GLTFLoader.js"]);
  assert.match(scriptProblem(`${threeD}\n  .x(`), /syntax error at line 4/, "lines still count from the top of the module");
  assert.match(scriptProblem("function setup() {}"), /has no export default/);
  assert.match(scriptProblem("export default function setup() {\n  return function draw( {\n};\n}"), /syntax error at line 3, column 2: Unexpected token ';'/);
  assert.equal(scriptProblem(SCRIPT), "");
  assert.equal(scriptProblem("export default async function setup() { await 1; return () => {}; }"), "");
  assert.throws(() => parse(scriptLayer({ script: "" })), /script: is empty/);
});

test("script inputs and values are checked against each input's type and range", () => {
  assert.throws(() => parse(scriptLayer({ values: { ...VALUES, reveal: 2 } })), /values\.reveal: 2 is above reveal's max 1/);
  assert.throws(() => parse(scriptLayer({ values: { ...VALUES, tint: "red" } })), /color input; give it #RRGGBB/);
  assert.throws(() => parse(scriptLayer({ values: { ...VALUES, extra: 1 } })), /"extra" is not a declared input; this layer's inputs are reveal, tint, mode/);
  assert.throws(() => parse(scriptLayer({ values: { reveal: 1, tint: "#ff0000" } })), /values\.mode: needs a value/);
  assert.throws(() => parse(scriptLayer({ inputs: [{ key: "Bad", type: "number" }], values: { Bad: 1 } })), /must start with a lowercase letter/);
  assert.throws(() => parse(scriptLayer({ inputs: [{ key: "a", type: "select", options: ["one"] }], values: { a: "one" } })), /needs 2 to 24 options/);
  assert.throws(() => parse(scriptLayer({ inputs: [{ key: "a", type: "image" }], values: { a: "https://x/y.png" } })), /imported picture's src/);
  assert.throws(() => parse(scriptLayer({ inputs: [{ key: "m", type: "model" }], values: { m: "/api/media/a.png" } })), /imported \.glb model's src/);
  assert.doesNotThrow(() => parse(scriptLayer({ inputs: [{ key: "m", type: "model" }], values: { m: "/api/media/a.glb" } })));
  assert.throws(() => parse(createLayer("rectangle", { id: "r", values: {} })), /only a script layer has values/);
});

test("evaluateLayer samples animated number and color values and keeps the others", () => {
  const layer = parse(scriptLayer({ animations: [{
    id: "grow", name: "Grow", kind: "custom", start: 0, duration: 2, easing: "linear",
    from: { values: { reveal: 0, tint: "#000000" } }, to: { values: { reveal: 1, tint: "#ffffff" } },
  }] }));
  const half = evaluateLayer(layer, 1).values;
  assert.equal(half.reveal, 0.5);
  assert.equal(half.tint, "#808080");
  assert.equal(half.mode, "bars");
  assert.throws(() => parse(scriptLayer({ animations: [{ id: "m", name: "Mode", kind: "custom", start: 0, duration: 1, easing: "linear", from: {}, to: { values: { mode: "dots" } } }] })),
    /"mode" is a select input; only number and color inputs animate/);
});

test("frameFor gives the draw call's frame and scriptKey follows the code and inputs", () => {
  const layer = parse(scriptLayer({ animations: [{
    id: "grow", name: "Grow", kind: "custom", start: 0, duration: 4, easing: "linear", from: { values: { reveal: 0 } }, to: { values: { reveal: 1 } },
  }] }));
  const frame = frameFor(layer, 1, { sceneDuration: 4 });
  assert.deepEqual({ ...frame, values: { ...frame.values, tint: frame.values.tint.css } },
    { time: 1, duration: 4, progress: 0.25, width: 320, height: 180, values: { reveal: 0.25, tint: "rgb(255 0 0 / 1)", mode: "bars" } });
  assert.equal(frame.values.tint.r, 1);
  assert.equal(scriptKey(layer), scriptKey({ ...layer, values: { reveal: 0 } }));
  assert.notEqual(scriptKey(layer), scriptKey({ ...layer, script: `${SCRIPT}\n` }));
});

test("a script layer draws nothing until its frame is given, and an image when it is", () => {
  const scene = createScene({ id: "a", duration: 4, layers: [parse(scriptLayer({ radius: 12 }))] });
  assert.doesNotMatch(renderSceneSvg(scene, 1), /<image/);
  const frame = "data:image/png;base64,iVBORw0KGgo=";
  const svg = renderSceneSvg(scene, 1, { scriptFrames: { s: frame } });
  assert.match(svg, /<image[^>]+href="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(svg, /clip-path/);
});
