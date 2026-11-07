import test from "node:test";
import assert from "node:assert/strict";
import {
  createDocument,
  createLayer,
  createScene,
  parseDocument,
} from "../engine/model.js";
import {
  createComponentInstance,
  detachComponent,
  expandComponents,
} from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";

const SOURCE_WIDTH = 240;
const SOURCE_HEIGHT = 120;
const MAIN_WIDTH = 640;
const MAIN_HEIGHT = 360;

function createSource({ width = SOURCE_WIDTH, height = SOURCE_HEIGHT } = {}) {
  return createScene({
    id: "scalable-source",
    name: "Scalable source",
    isComponent: true,
    width,
    height,
    duration: 2,
    exportDuration: 2,
    background: "#ffffff",
    layers: [
      createLayer("rectangle", {
        id: "source-rectangle",
        name: "Animated rectangle",
        x: 70,
        y: 10,
        width: 100,
        height: 100,
        fill: "#b3b3b3",
        strokeWidth: 0,
        animations: [
          {
            id: "fade-in",
            name: "Fade In",
            kind: "in",
            start: 0,
            duration: 0.8,
            easing: "linear",
            from: { opacity: 0 },
            to: { opacity: 1 },
            unit: "layer",
            stagger: 0,
            order: "forward",
          },
        ],
      }),
    ],
  });
}

function scaledInstance(source, id, componentStart = 0, componentVisibility = "both") {
  // At 1.5x, as a drag from the bottom-right corner left it: the top-left corner stays at (200, 120).
  const instance = createComponentInstance(source, { id, x: 260, y: 150, componentStart, componentVisibility });
  return { ...instance, scaleX: 1.5, scaleY: 1.5 };
}

function documentWith(source, main) {
  return parseDocument(createDocument({
    id: `document-${main.id}`,
    name: "Component scale verification",
    scenes: [source, main],
  }));
}

async function exportPng(scene, time) {
  const result = await exportScene(scene, {
    format: "png",
    time,
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
  });
  assert.equal(result.mime, "image/png");
  assert.deepEqual(
    [...result.buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  return result.buffer;
}

function assertPngEqual(actual, expected, message) {
  assert.ok(actual.equals(expected), message);
}

function independentExpectedScene({ x = 305, y = 135, opacity = 1 } = {}) {
  return createScene({
    id: "expected-main",
    name: "Expected main scene",
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    duration: 2,
    background: "#ffffff",
    layers: [
      createLayer("rectangle", {
        id: "expected-rectangle",
        x,
        y,
        width: 150,
        height: 150,
        opacity,
        fill: "#b3b3b3",
        strokeWidth: 0,
      }),
    ],
  });
}

test("scaled linked components rasterize like independent geometry and retain transform in Lottie", async () => {
  const source = createSource();
  const scaled = scaledInstance(source, "scaled-component");

  const main = createScene({
    id: "scaled-main",
    name: "Main",
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    duration: 1.2,
    background: "#ffffff",
    layers: [scaled],
  });
  const document = documentWith(source, main);
  const expanded = expandComponents(document, main.id);
  const componentWindow = expanded.layers.find((layer) => layer.id === scaled.id).playbackWindows[0];
  assert.equal(componentWindow.start, 0);
  assert.equal(componentWindow.end, 0.8, "source timed content defines linked playback duration");

  for (const [time, opacity] of [[0, 0], [0.4, 0.5], [1, 1]]) {
    const actual = await exportPng(expanded, time);
    const expected = await exportPng(independentExpectedScene({ opacity }), time);
    assertPngEqual(actual, expected, `linked render matches independent pixels at ${time}s`);

    const detached = detachComponent(document, main.id, scaled.id).scenes.find((scene) => scene.id === main.id);
    assertPngEqual(
      await exportPng(detached, time),
      expected,
      `detached render matches independent pixels at ${time}s`,
    );
  }

  const lottie = JSON.parse(
    (await exportScene(expanded, { format: "lottie", fps: 30, duration: 1.2 })).buffer.toString("utf8"),
  );
  const allLayers = [
    ...lottie.layers,
    ...lottie.assets.flatMap((asset) => asset.layers ?? []),
  ];
  const clippedComponent = allLayers.find((layer) => layer.nm === source.name && layer.ty === 0);
  assert.ok(clippedComponent, "Lottie contains an actual precomposition for the linked group");
  assert.deepEqual(clippedComponent.ks.s.k.slice(0, 2), [150, 150]);
  assert.equal(clippedComponent.hasMask, true);
  assert.equal(clippedComponent.masksProperties[0].nm, "Clip content");
});

test("same-position during-only instances make a finite loop and follow later source dimensions", async () => {
  const source = createSource();
  const first = scaledInstance(source, "loop-first", 0, "during");
  const second = scaledInstance(source, "loop-second", 0.8, "during");
  const loopMain = createScene({
    id: "loop-main",
    name: "Finite loop",
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    duration: 1.6,
    background: "#ffffff",
    layers: [first, second],
  });
  const loopDocument = documentWith(source, loopMain);
  const loopScene = expandComponents(loopDocument, loopMain.id);

  for (const [left, right] of [[0.2, 1], [0.4, 1.2], [0, 0.8]]) {
    assertPngEqual(
      await exportPng(loopScene, left),
      await exportPng(loopScene, right),
      `loop frames at ${left}s and ${right}s are equal`,
    );
  }

  const originalLayer = structuredClone(source.layers[0]);
  const liveInstance = scaledInstance(source, "live-source-instance");
  const liveMain = createScene({
    id: "live-source-main",
    name: "Live source dimensions",
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    duration: 1.2,
    background: "#ffffff",
    layers: [liveInstance],
  });
  const originalLinkedScene = expandComponents(documentWith(source, liveMain), liveMain.id);
  const originalPixels = await exportPng(originalLinkedScene, 0.4);
  const originalExpected = await exportPng(independentExpectedScene({ opacity: 0.5 }), 0.4);
  assertPngEqual(originalPixels, originalExpected, "initial live component dimensions render at the original scale");

  const updatedSource = createSource({ width: 300, height: 150 });
  const updatedDocument = documentWith(updatedSource, liveMain);
  const updatedScene = expandComponents(updatedDocument, liveMain.id);
  const liveWrapper = updatedScene.layers.find((layer) => layer.id === liveInstance.id);
  const liveRectangle = updatedScene.layers.find((layer) => layer.type === "rectangle" && layer.name === originalLayer.name);
  assert.equal(liveWrapper.width, 300);
  assert.equal(liveWrapper.height, 150);
  assert.equal(liveRectangle.x, originalLayer.x);
  assert.equal(liveRectangle.y, originalLayer.y);
  assert.equal(liveRectangle.width, originalLayer.width);
  assert.equal(liveRectangle.height, originalLayer.height);
  assert.deepEqual(liveRectangle.animations.map(({ start, duration }) => ({ start, duration })), [
    { start: originalLayer.animations[0].start, duration: originalLayer.animations[0].duration },
  ]);

  const updatedActual = await exportPng(updatedScene, 0.4);
  const updatedExpected = await exportPng(
    independentExpectedScene({ x: 290, y: 127.5, opacity: 0.5 }),
    0.4,
  );
  assertPngEqual(updatedActual, updatedExpected, "expanded component uses the current source artboard dimensions");
  assert.ok(!updatedActual.equals(originalPixels), "a live source dimension change affects its rendered placement");
});
