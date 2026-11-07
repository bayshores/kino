import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createComponentInstance, expandComponents } from "../engine/linkedComponents.js";
import { exportScene } from "./export.mjs";
import { documentMediaIds } from "./media-use.mjs";
import { readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

const RED = "0a0a0a0a-0000-4000-8000-000000000001.png";
const BLUE = "0b0b0b0b-0000-4000-8000-000000000002.png";

function solidPng(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="100%" height="100%" fill="${color}"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

// A main component that shows the red picture, and an instance that swaps in the blue one.
function swappedDocument() {
  const card = createScene({
    id: "card", name: "Card", isComponent: true, width: 40, height: 20, background: "#000000",
    layers: [createLayer("image", { id: "photo", name: "Photo", x: 0, y: 0, width: 40, height: 20, src: `/api/media/${RED}` })],
  });
  const main = createScene({
    id: "main", name: "Main", width: 40, height: 20, duration: 1, background: "#000000",
    layers: [createComponentInstance(card, { id: "card-1", x: 0, y: 0, componentOverrides: { photo: { src: `/api/media/${BLUE}` } } })],
  });
  return parseDocument(createDocument({ scenes: [card, main] }));
}

async function mediaFolder(t) {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-overrides-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await writeFile(join(mediaRoot, RED), solidPng("#ff0000"));
  await writeFile(join(mediaRoot, BLUE), solidPng("#0000ff"));
  return mediaRoot;
}

test("the media a document uses includes pictures that only an override uses", () => {
  const ids = documentMediaIds(swappedDocument());
  assert.ok(ids.has(RED), "the main component's own picture");
  assert.ok(ids.has(BLUE), "the picture only the instance's override uses");
});

test("a PNG export draws the instance's overridden picture", async (t) => {
  const mediaRoot = await mediaFolder(t);
  const document = swappedDocument();
  const result = await exportScene(expandComponents(document, "main"), { format: "png", width: 40, height: 20 }, { mediaRoot });
  const [red, green, blue] = (await readImage(result.buffer)).pixel(20, 10);
  assert.ok(blue > 200 && red < 60 && green < 60, `the instance shows the blue picture (got ${red}, ${green}, ${blue})`);
  const main = await exportScene(expandComponents(document, "card"), { format: "png", width: 40, height: 20 }, { mediaRoot });
  const [mainRed, , mainBlue] = (await readImage(main.buffer)).pixel(20, 10);
  assert.ok(mainRed > 200 && mainBlue < 60, "the main component keeps its red picture");
});

test("a Lottie export embeds the instance's overridden picture", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mediaFolder(t);
  const result = await exportScene(expandComponents(swappedDocument(), "main"), { format: "lottie", width: 40, height: 20, fps: 10 }, { mediaRoot });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const images = animation.assets.filter((asset) => typeof asset.p === "string" && asset.p.startsWith("data:image/"));
  assert.equal(images.length, 1, "one picture is embedded: the overridden one");
  const embedded = Buffer.from(images[0].p.slice(images[0].p.indexOf(",") + 1), "base64");
  const [red, , blue] = (await readImage(embedded)).pixel(4, 4);
  assert.ok(blue > 200 && red < 60, "the embedded picture is the blue one");
});
