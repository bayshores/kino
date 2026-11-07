import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DOMParser } from "@xmldom/xmldom";
import { Resvg } from "@resvg/resvg-js";
import { applyBulkCreate, planBulkCreate } from "../bulkCreate.js";
import { copyAnimations, copyLayers, pasteAnimations, pasteLayers } from "../layerClipboard.js";
import { duplicateSelection } from "../duplicate.js";
import { createDocument, createLayer, createScene, parseDocument } from "../model.js";
import { expandComponents } from "../linkedComponents.js";
import { duplicateSceneInDocument } from "../sceneDuplication.js";
import { renderSceneSvg } from "../render.js";

const WIDTH = 72;
const HEIGHT = 56;

function effect(id, key = "noise-warp", overrides = {}) {
  const to = key === "noise-warp"
    ? { amount: 18, noiseScale: 1.3, speed: 0.65, contain: false }
    : key === "ripple"
      ? { speed: 0.7, strength: 0.22, frequency: 7, centerX: 0.43, centerY: 0.57, falloff: 1.4, sharpness: 5 }
      : { amount: 1.25 };
  return {
    id, name: key, kind: "effect", effect: key, start: 0, duration: 1.5,
    easing: "linear", to,
    ...(key === "bulge" ? {} : { keepStill: "both" }),
    ...overrides,
  };
}

function box(id = "warped", values = {}) {
  return createLayer("rectangle", {
    id, name: id, x: 9, y: 7, width: 48, height: 38,
    fill: "#e63946", stroke: "#172a3a", strokeWidth: 2,
    animations: [effect(`${id}-noise`)], ...values,
  });
}

function scene(layers, values = {}) {
  return createScene({
    id: "scene", name: "Effects", width: WIDTH, height: HEIGHT, duration: 2,
    background: "#f1faee", layers, ...values,
  });
}

function pixels(svg) {
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels;
}

function changedPixelCount(left, right, threshold = 2) {
  assert.equal(left.length, right.length);
  let count = 0;
  for (let index = 0; index < left.length; index += 4) {
    if (Math.abs(left[index] - right[index]) > threshold ||
        Math.abs(left[index + 1] - right[index + 1]) > threshold ||
        Math.abs(left[index + 2] - right[index + 2]) > threshold ||
        Math.abs(left[index + 3] - right[index + 3]) > threshold) count += 1;
  }
  return count;
}

function svgDocument(markup) {
  const errors = [];
  const document = new DOMParser({ onError: (_level, message) => errors.push(message) })
    .parseFromString(markup, "image/svg+xml");
  assert.deepEqual(errors, []);
  return document;
}

function allElements(document, tag) {
  const nodes = document.getElementsByTagName(tag);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index));
}

test("rendered effect SVG survives document reload, isolates inline IDs, and does not seed noise from IDs", () => {
  const original = parseDocument(createDocument({ scenes: [scene([box()])] }));
  const saved = parseDocument(JSON.parse(JSON.stringify(original)));
  const savedScene = saved.scenes[0];
  const time = 0.37;
  const originalSvg = renderSceneSvg(original.scenes[0], time);
  assert.equal(renderSceneSvg(savedScene, time), originalSvg, "saved and reopened documents render the same SVG");

  const inlineA = renderSceneSvg(savedScene, time, { idPrefix: "board/A" });
  const inlineB = renderSceneSvg(savedScene, time, { idPrefix: "board B" });
  const ids = [...inlineA, ...inlineB].join("").match(/\sid="([^"]+)"/g) ?? [];
  assert.ok(ids.length >= 2, "both inline artboards define effect/map IDs");
  assert.equal(new Set(ids).size, ids.length, "two inline SVGs can coexist without ID collisions");

  const renamed = structuredClone(savedScene);
  renamed.layers[0].id = "renamed-source";
  renamed.layers[0].animations[0].id = "renamed-animation";
  const renamedSvg = renderSceneSvg(renamed, time);
  assert.deepEqual(pixels(renamedSvg), pixels(originalSvg), "procedural displacement output is independent of document IDs");
});

test("effects wrap layer blur and shadow, and their overflow is retained in the outer filter region", () => {
  const shape = box("shadowed", {
    x: 14, y: 10, width: 38, height: 26, blur: 6,
    shadow: { x: -9, y: 12, blur: 8, color: "#16213e80" },
  });
  const svg = renderSceneSvg(scene([shape]), 0.45);
  const document = svgDocument(svg);
  const filters = allElements(document, "filter");
  const mapFilter = filters.find((filter) => filter.getElementsByTagName("feDisplacementMap").length);
  const layerFilter = filters.find((filter) => filter.getElementsByTagName("feGaussianBlur").length &&
    filter.getElementsByTagName("feDisplacementMap").length === 0);
  assert.ok(mapFilter, "the layer effect is emitted as a displacement filter");
  assert.ok(layerFilter, "the layer's shadow/blur filter remains separate");

  const root = allElements(document, "g").find((element) => element.getAttribute("data-layer-id") === "shadowed");
  assert.equal(root?.getAttribute("filter"), `url(#${layerFilter.getAttribute("id")})`, "layer blur and shadow wrap the effect output");
  const effectGroup = allElements(document, "g").find((element) => element.getAttribute("filter") === `url(#${mapFilter.getAttribute("id")})`);
  assert.ok(effectGroup, "the effect filters the painted content before the outer layer filter");

  const region = ["x", "y", "width", "height"].map((key) => Number(layerFilter.getAttribute(key)));
  assert.ok(region[0] < 0 || region[1] < 0, "filter bounds include the effect's padded paint extent");
  assert.ok(region[2] > shape.width && region[3] > shape.height, "overflow and layer shadow/blur are retained");
});

test("effect ordering changes rendered pixels on an asymmetric path", () => {
  const path = createLayer("path", {
    id: "arrow", name: "Arrow", x: 7, y: 5, width: 56, height: 44,
    path: "M2 4 L52 13 L30 23 L40 42 L22 30 L8 39 Z",
    pathBounds: { width: 56, height: 44 }, fill: "#ffb703",
    animations: [
      effect("noise", "noise-warp", { start: 0 }),
      effect("ripple", "ripple", { start: 0 }),
    ],
  });
  const reordered = structuredClone(path);
  reordered.animations.reverse();
  const first = pixels(renderSceneSvg(scene([path]), 0.53));
  const second = pixels(renderSceneSvg(scene([reordered]), 0.53));
  assert.ok(changedPixelCount(first, second) > 8, "the ordered filter stack is visible in the composed frame");
});

test("groups, paths, independent letters, and Change text use the shared effect renderer", () => {
  const group = createLayer("group", {
    id: "group", name: "Group", x: 4, y: 3, width: 64, height: 48,
    animations: [effect("group-bulge", "bulge")],
  });
  const path = createLayer("path", {
    id: "leaf", name: "Leaf", parentId: "group", x: 5, y: 5, width: 28, height: 24,
    path: "M1 1 L25 4 L19 21 Z", pathBounds: { width: 28, height: 24 },
    fill: "#219ebc", animations: [effect("leaf-ripple", "ripple")],
  });
  const letters = createLayer("text", {
    id: "letters", name: "Letters", parentId: "group", x: 7, y: 28, width: 44, height: 16,
    text: "AB", fontSize: 12, fill: "#023047",
    animations: [
      effect("letters-noise"),
      { id: "letters-in", name: "Letters In", kind: "in", start: 0, duration: 1,
        easing: "linear", from: { opacity: 0 }, to: { opacity: 1 }, unit: "letters", stagger: 0.1, order: "forward" },
    ],
  });
  const changed = createLayer("text", {
    id: "changing", name: "Changing", x: 8, y: 5, width: 42, height: 16,
    text: "Old", fontSize: 12, fill: "#023047",
    animations: [
      effect("change-noise"),
      { id: "change", name: "Change text", kind: "change-text", start: 0.5,
        text: "New", overlap: false, out: null, in: null },
    ],
  });
  const svg = renderSceneSvg(scene([group, path, letters, changed]), 0.75);
  assert.match(svg, /data-layer-id="group"/);
  assert.match(svg, /data-layer-id="leaf"/);
  assert.match(svg, /aria-label="A"/);
  assert.match(svg, /aria-label="B"/);
  assert.match(svg, /aria-label="New"/, "the changed string keeps its accessible label");
  assert.ok((svg.match(/<feDisplacementMap/g) ?? []).length >= 3, "group, path and text effects reach the composed SVG");
});

test("sampled GIF and video export frames receive effects while interactive video markup remains a hit target", () => {
  const red = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#e63946"/></svg>').render().asPng();
  const blue = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#4361ee"/></svg>').render().asPng();
  const redUri = `data:image/png;base64,${red.toString("base64")}`;
  const blueUri = `data:image/png;base64,${blue.toString("base64")}`;
  const gif = createLayer("image", {
    id: "gif", name: "Animated still", x: 12, y: 8, width: 36, height: 36,
    src: "/api/media/fixture.gif", mediaStart: 0, mediaDuration: 1,
    animations: [effect("gif-noise")],
  });
  const imageFrames = { gif: { durations: [0.5, 0.5], frames: [redUri, blueUri] } };
  const first = renderSceneSvg(scene([gif]), 0.2, { imageFrames, raster: true });
  const second = renderSceneSvg(scene([gif]), 0.8, { imageFrames, raster: true });
  assert.ok(first.includes(redUri) && second.includes(blueUri), "the requested GIF samples are selected before rendering");
  assert.match(first, /<feDisplacementMap/, "the sampled GIF image is inside the layer's effect chain");
  assert.ok(changedPixelCount(pixels(first), pixels(second)) > 8, "different sampled GIF frames remain visible after effects");

  const video = createLayer("video", {
    id: "video", name: "Clip", x: 8, y: 6, width: 48, height: 40,
    src: "/api/media/fixture.mp4", mediaStart: 0, mediaDuration: 1,
    animations: [effect("video-noise")],
  });
  const videoScene = scene([video]);
  const exportFrame = renderSceneSvg(videoScene, 0.5, {
    videoFrames: { video: [{ time: 0, href: redUri }, { time: 0.5, href: blueUri }] }, raster: true,
  });
  assert.ok(exportFrame.includes(blueUri), "the requested video export frame is selected");
  assert.match(exportFrame, /<feDisplacementMap/, "the selected video frame uses the same effect rendering path");

  const preview = renderSceneSvg(videoScene, 0.5, {
    interactiveMedia: true, embedMedia: { video: video.src }, canvas: true,
  });
  const previewDocument = svgDocument(preview);
  const previewLayer = allElements(previewDocument, "g").find((element) => element.getAttribute("data-layer-id") === "video");
  assert.ok(previewLayer?.getElementsByTagName("video").length, "interactive preview retains the real video element inside the layer hit target");
  assert.equal(previewLayer.getElementsByTagName("video")[0].getAttribute("data-media-layer-id"), "video");
  assert.equal(previewLayer.getElementsByTagName("video")[0].hasAttribute("autoplay"), false);
});

test("copy, paste, duplicate, scene copy, and CSV component expansion preserve effects and sampled pixels", () => {
  const sourceLayer = box("box");
  const title = createLayer("text", {
    id: "title", name: "Title", x: 5, y: 4, width: 50, height: 16,
    text: "Base", fontSize: 12, opacity: 0,
  });
  const original = parseDocument(createDocument({ scenes: [scene([sourceLayer, title], { id: "base" })] }));
  const sourceScene = original.scenes[0];
  const sourceEffect = sourceLayer.animations[0];
  const time = 0.42;
  const originalPixels = pixels(renderSceneSvg(sourceScene, time));

  const pastedTarget = createScene({ id: "paste-target", width: WIDTH, height: HEIGHT, duration: 2,
    background: sourceScene.background, layers: [] });
  const pastedDoc = parseDocument(pasteLayers(
    createDocument({ scenes: [pastedTarget] }), pastedTarget.id, copyLayers(original, sourceScene.id, [sourceLayer.id]),
  ).document);
  const pasted = pastedDoc.scenes[0].layers[0];
  assert.notEqual(pasted.animations[0].id, sourceEffect.id);
  assert.deepEqual(pasted.animations[0].to, sourceEffect.to);
  assert.deepEqual(pixels(renderSceneSvg(pastedDoc.scenes[0], time)),
    pixels(renderSceneSvg(scene([sourceLayer]), time)), "pasted layers keep the same distorted frame");

  const target = createLayer("rectangle", {
    id: "target", name: "Target", x: sourceLayer.x, y: sourceLayer.y,
    width: sourceLayer.width, height: sourceLayer.height, fill: sourceLayer.fill,
    stroke: sourceLayer.stroke, strokeWidth: sourceLayer.strokeWidth,
  });
  const animationPasteDoc = createDocument({ scenes: [scene([target], { id: "animation-target" })] });
  const animationEnvelope = copyAnimations(original, sourceScene.id, [sourceEffect.id]);
  const animationPaste = parseDocument(pasteAnimations(animationPasteDoc, "animation-target", ["target"], animationEnvelope, 0).document);
  const pastedAnimation = animationPaste.scenes[0].layers[0].animations[0];
  assert.notEqual(pastedAnimation.id, sourceEffect.id);
  assert.deepEqual(pastedAnimation.to, sourceEffect.to);
  assert.deepEqual(pixels(renderSceneSvg(animationPaste.scenes[0], time)),
    pixels(renderSceneSvg(scene([sourceLayer]), time)), "pasted effect animations render the same frame on a compatible target");

  const duplicated = duplicateSelection(original, sourceScene.id, [sourceLayer.id]);
  const duplicate = duplicated.document.scenes[0].layers.find((layer) => duplicated.rootIds.includes(layer.id));
  assert.deepEqual(duplicate.animations[0].to, sourceEffect.to);
  assert.notEqual(duplicate.animations[0].id, sourceEffect.id);
  const normalizedDuplicate = { ...duplicate, x: sourceLayer.x, y: sourceLayer.y };
  assert.deepEqual(pixels(renderSceneSvg(scene([normalizedDuplicate]), time)),
    pixels(renderSceneSvg(scene([sourceLayer]), time)), "after translation normalization, duplicated effect pixels match");

  const copiedScene = duplicateSceneInDocument(original, sourceScene.id);
  const copied = copiedScene.document.scenes.find((item) => item.id === copiedScene.sceneId);
  assert.deepEqual(copied.layers[0].animations[0].to, sourceEffect.to);
  assert.notEqual(copied.layers[0].animations[0].id, sourceEffect.id);
  assert.deepEqual(pixels(renderSceneSvg(copied, time)), originalPixels, "a copied scene retains its effect frame");

  const plan = planBulkCreate(original, sourceScene.id, ["id", "Title"], [["variant", "Changed"]]);
  const csvDocument = parseDocument(applyBulkCreate(original, plan));
  const variant = csvDocument.scenes.find((item) => item.bulkVariant?.key === "variant");
  const expanded = expandComponents(csvDocument, variant.id);
  const expandedBox = expanded.layers.find((layer) => layer.name === "box");
  const expandedTitle = expanded.layers.find((layer) => layer.name === "Title");
  assert.equal(expandedTitle.text, "Changed");
  assert.equal(expandedTitle.componentOverridden, true);
  assert.deepEqual(expandedBox.animations[0].to, sourceEffect.to);
  assert.notEqual(expandedBox.animations[0].id, sourceEffect.id);
  assert.deepEqual(pixels(renderSceneSvg(expanded, time)), originalPixels,
    "Bulk Create's text override does not alter the unchanged, effect-rendered component pixels");
});

test("zero-size layers and singular scales with effects render finite, bounded SVG", () => {
  const zeroBox = box("zero-size", { x: 3, y: 3, width: 0, height: 0, blur: 2 });
  const singularBox = box("singular", { x: 18, y: 10, scaleX: 0, scaleY: 0 });
  const svg = renderSceneSvg(scene([zeroBox, singularBox]), 0.3, { raster: true });
  assert.doesNotMatch(svg.replace(/data:image\/[^"\s]+/g, "embedded-image"), /(?:NaN|Infinity|undefined)/);
  assert.equal(pixels(svg).length, WIDTH * HEIGHT * 4);
});

test("contained effects entirely outside the scene do not abort the native renderer", () => {
  const offscreen = box("offscreen", { x: 400, y: -300, rotation: 19,
    animations: [effect("contained", "noise-warp", {
      to: { amount: 18, noiseScale: 1.3, speed: 0.65, contain: true },
    })] });
  const svg = renderSceneSvg(scene([offscreen], { background: "#00000000" }), 0.3, { raster: true });
  // A native panic must fail this assertion rather than aborting the whole test process.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { Resvg } from '@resvg/resvg-js';
    let svg=''; for await (const chunk of process.stdin) svg+=chunk;
    const pixels=new Resvg(svg).render().pixels;
    if (pixels.some((value,index)=>index%4===3 && value!==0)) process.exit(2);
  `], { input: svg, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(child.status, 0, child.stderr || String(child.error ?? child.signal));
});
