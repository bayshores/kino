import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateLayer } from "../engine/animation.js";
import { exportFrameStep } from "../engine/exportOptions.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { createAgentService } from "./agent/service.mjs";
import { createAgentStateStore } from "./agent/state.mjs";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { near, readImage } from "./media.test.support.mjs";
import { openStore } from "./store.mjs";

test("the agent's edit saves motionPath preset overrides on add and update, and null removes them", async (t) => {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "kino-motion-path-agent-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));

  const projectId = "motion-path-agent";
  const document = createDocument({
    id: projectId,
    name: "Motion path MCP",
    scenes: [createScene({
      id: "scene",
      name: "Scene",
      width: 180,
      height: 140,
      duration: 2,
      layers: [createLayer("rectangle", { id: "box", name: "Box", x: 10, y: 20, width: 30, height: 16, fill: "#000000" })],
    })],
  });
  // The agent's edit tool (POST /api/agent/edit), in this process on its own store.
  const store = await openStore(workRoot);
  await store.createProject(document);
  const fonts = await loadBundledFonts();
  const service = createAgentService({
    store, agentState: createAgentStateStore(workRoot), agentDirectory: path.join(workRoot, "agent"), mediaRoot: path.join(workRoot, "media"),
    exportBatches: {}, fontCatalog: { async loadInto() {} }, loadFonts: async () => fonts, operationContext: async () => ({ fonts }),
    // No quality pass: this checks what the edit saves, not the check's findings.
    quality: { async check() { return { findings: [], notes: [], ms: 0, unchecked: [], scenes: 1 }; } },
    saveDocument: (id, before, saved, revision, options) => store.updateProject(id, saved, revision, options),
  });
  const call = async (ops) => {
    const reply = await service.call("edit", { project: projectId, ops });
    assert.equal(reply.isError, undefined, reply.text);
    return reply;
  };
  const savedDocument = async () => (await store.getProject(projectId)).document;

  const firstPath = { points: [{ x: 50, y: 80 }] };
  await call([{ op: "add_animation", layer: "Box", preset: "move", start: 0.25, motionPath: firstPath }]);
  const addedAnimation = (await savedDocument()).scenes[0].layers[0].animations[0];
  assert.equal(addedAnimation.name, "Move");
  assert.deepEqual(addedAnimation.motionPath, {
    points: [{ x: 50, y: 80, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }],
    bezierControls: true,
    alignToPath: false,
  });

  const replacementPath = {
    points: [{ x: 70, y: 90, in: { x: -8, y: 2 }, out: { x: 9, y: -3 } }],
    bezierControls: false,
    alignToPath: true,
    alignmentOffset: 12,
  };
  await call([{ op: "update_animation", layer: "Box", animation: addedAnimation.id, properties: { motionPath: replacementPath } }]);
  assert.deepEqual((await savedDocument()).scenes[0].layers[0].animations[0].motionPath, replacementPath);

  await call([{ op: "update_animation", layer: "Box", animation: addedAnimation.id, properties: { motionPath: null } }]);
  const removedAnimation = (await savedDocument()).scenes[0].layers[0].animations[0];
  assert.equal(Object.hasOwn(removedAnimation, "motionPath"), false);
});

function mover() {
  return createLayer("rectangle", {
    id: "moving-box",
    name: "Motion box",
    x: 12,
    y: 18,
    width: 20,
    height: 14,
    rotation: 10,
    fill: "#ff0000",
    stroke: "none",
    strokeWidth: 0,
    animations: [
      {
        id: "curved-move",
        name: "Curved Move",
        kind: "custom",
        start: 0,
        duration: 1.5,
        easing: "linear",
        from: { x: 12, y: 18 },
        to: { x: 138, y: 70 },
        motionPath: {
          points: [{ x: 70, y: 18, in: { x: -10, y: 0 }, out: { x: 18, y: 30 } }],
          bezierControls: true,
          alignToPath: true,
        },
      },
      {
        id: "ordinary-rotation",
        name: "Rotate",
        kind: "custom",
        start: 0,
        duration: 2,
        easing: "linear",
        from: { rotation: 10 },
        to: { rotation: 30 },
      },
      {
        id: "latest-move",
        name: "Latest Move",
        kind: "custom",
        start: 0.6,
        duration: 0.8,
        easing: "linear",
        from: { x: 12, y: 18 },
        to: { x: 138, y: 100 },
        motionPath: {
          points: [{ x: 138, y: 18 }],
          bezierControls: false,
          alignToPath: true,
          alignmentOffset: -4,
        },
      },
      {
        id: "anchored-resize",
        name: "Resize",
        kind: "custom",
        start: 0.35,
        duration: 1.3,
        easing: "linear",
        from: { width: 20, height: 14 },
        to: { width: 44, height: 32 },
        anchor: "bottom-right",
      },
    ],
  });
}

function valueAt(property, frame) {
  if (property.a !== 1) return Array.isArray(property.k) ? property.k : [property.k];
  const keys = property.k;
  let index = 0;
  while (index + 1 < keys.length && keys[index + 1].t <= frame) index += 1;
  const key = keys[index];
  const next = keys[index + 1];
  const start = Array.isArray(key.s) ? key.s : [key.s];
  if (!next || key.h === 1) return start;
  const endValue = key.e ?? next.s ?? key.s;
  const end = Array.isArray(endValue) ? endValue : [endValue];
  const amount = (frame - key.t) / (next.t - key.t);
  return start.map((value, axis) => value + ((end[axis] ?? value) - value) * amount);
}

function svgNumber(value) {
  return String(Math.round(value * 10_000) / 10_000);
}

function angleDistance(first, second) {
  return Math.abs(((first - second + 180) % 360 + 360) % 360 - 180);
}

test("SVG, PNG, and sampled Lottie transforms agree with evaluated curved motion, alignment, and anchored Resize", async () => {
  const layer = mover();
  const scene = createScene({
    id: "motion-export",
    name: "Motion export",
    width: 180,
    height: 140,
    duration: 2,
    background: "#ffffff",
    layers: [layer],
  });

  for (const time of [0.3, 0.9, 1.8]) {
    const state = evaluateLayer(layer, time);
    const svg = renderSceneSvg(scene, time);
    const tag = svg.match(/<g data-layer-id="moving-box"[^>]*>/)?.[0];
    assert.ok(tag, `SVG contains the moving layer at ${time}s`);
    assert.ok(tag.includes(`translate(${svgNumber(state.x)} ${svgNumber(state.y)})`),
      `SVG position at ${time}s matches the evaluator`);
    assert.ok(tag.includes(`rotate(${svgNumber(state.rotation)})`),
      `SVG rotation at ${time}s matches the evaluator`);

    const png = await exportScene(scene, { format: "png", time });
    const image = await readImage(png.buffer);
    const centerX = Math.round(state.x + state.width / 2);
    const centerY = Math.round(state.y + state.height / 2);
    assert.ok(near(image.pixel(centerX, centerY), [255, 0, 0, 255], 2),
      `PNG draws the box at its evaluated center at ${time}s`);
  }

  const fps = 10;
  const animation = JSON.parse((await exportScene(scene, { format: "lottie", fps })).buffer.toString("utf8"));
  const output = animation.layers.find((item) => item.nm === "Motion box");
  assert.ok(output, "Lottie contains the moving rectangle layer");
  for (const frame of [0, 3, 6, 9, 12, 15, 18, 19]) {
    const time = frame * exportFrameStep(fps);
    const expected = evaluateLayer(layer, time);
    const [x, y] = valueAt(output.ks.p, frame);
    const [rotation] = valueAt(output.ks.r, frame);
    const expectedX = expected.x + expected.width / 2;
    const expectedY = expected.y + expected.height / 2;
    assert.ok(Math.abs(x - expectedX) <= 0.5,
      `Lottie frame ${frame} x ${x} matches evaluator center ${expectedX}`);
    assert.ok(Math.abs(y - expectedY) <= 0.5,
      `Lottie frame ${frame} y ${y} matches evaluator center ${expectedY}`);
    assert.ok(angleDistance(rotation, expected.rotation) <= 0.5,
      `Lottie frame ${frame} rotation ${rotation} matches evaluator rotation ${expected.rotation}`);
  }
});
