import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { applyOperations } from "../engine/operations.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { renderSceneSvg } from "../engine/render.js";
import { documentMediaIds } from "./media-use.mjs";
import { exportScene } from "./export.mjs";
import { readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

const RED = "00000000-0000-4000-8000-000000000001.png";
const BLUE = "00000000-0000-4000-8000-000000000002.png";
const redSource = `/api/media/${RED}`;
const blueSource = `/api/media/${BLUE}`;

function fixture() {
  const base = createScene({
    id: "base",
    name: "Card",
    width: 40,
    height: 20,
    duration: 1,
    background: "#000000",
    layers: [
      createLayer("image", { id: "photo", name: "Photo", src: redSource, x: 0, y: 0, width: 40, height: 20 }),
      createLayer("text", { id: "title", name: "Title", text: "Base title", x: 0, y: 0, width: 40, height: 20, fontSize: 8 }),
    ],
  });
  return parseDocument(createDocument({ id: "bulk-create-test", name: "Bulk Create", scenes: [base] }));
}

function apply(document, operation) {
  return parseDocument(applyOperations(document, [operation]));
}

function solidPng(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="100%" height="100%" fill="${color}"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

test("bulk_create accepts CSV, reports bad rows, and applies valid variants", () => {
  const csv = [
    "id,Title,Photo,info_log",
    "bad,Rejected,missing.png,",
    `good,Good title,${blueSource},`,
  ].join("\r\n");
  const document = apply(fixture(), { type: "bulk_create", sceneId: "base", csv });

  assert.deepEqual(document.scenes.map((scene) => scene.bulkVariant?.key ?? scene.id), ["base", "good"]);
  assert.equal(document.scenes[0].isComponent, true);
  assert.deepEqual(document.scenes[1].layers[0].componentOverrides, {
    title: { text: "Good title" },
    photo: { src: blueSource, mediaSourceDuration: 0 },
  });
});

test("bulk_create accepts rows including the header and ignores missing variants by default", () => {
  let document = apply(fixture(), {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title"], ["one", "One"], ["two", "Two"]],
  });
  document = apply(document, {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title"], ["one", "One"]],
  });

  assert.deepEqual(document.scenes.map((scene) => scene.bulkVariant?.key ?? scene.id), ["base", "one", "two"]);
});

test("deleteMissing removes only omitted variants when the operation opts in", () => {
  const first = apply(fixture(), {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title"], ["one", "One"], ["two", "Two"]],
  });
  const deleted = apply(first, {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title"], ["one", "One"]],
    deleteMissing: true,
  });

  assert.deepEqual(deleted.scenes.map((scene) => scene.bulkVariant?.key ?? scene.id), ["base", "one"]);
});

test("variant override media is tracked and rendered by SVG and PNG export", async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-bulk-render-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const bluePng = solidPng("#0000ff");
  await writeFile(join(mediaRoot, BLUE), bluePng);

  const document = apply(fixture(), {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title", "Photo"], ["blue", "Variant title", blueSource]],
  });
  assert.ok(documentMediaIds(document).has(BLUE), "media used only by the variant override remains in the project media set");

  const variant = document.scenes.find((scene) => scene.bulkVariant?.key === "blue");
  const expanded = expandComponents(document, variant.id);
  const dataUrl = `data:image/png;base64,${bluePng.toString("base64")}`;
  const svg = renderSceneSvg(expanded, 0, { embedMedia: new Map([[blueSource, dataUrl]]) });
  assert.match(svg, /Variant title/);
  assert.match(svg, /data:image\/png;base64,/);
  const svgPixels = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  assert.ok(svgPixels.pixels.some((value, index) => index % 4 === 2 && value > 200), "the SVG-rendered variant includes blue image pixels");

  const png = await exportScene(expanded, { format: "png", width: 40, height: 20 }, { mediaRoot });
  const image = await readImage(png.buffer);
  const [red, green, blue] = image.pixel(20, 10);
  assert.ok(blue > 200 && red < 60 && green < 60, `the PNG export uses the variant's blue image (got ${red}, ${green}, ${blue})`);
});

test("Lottie embeds the image selected by a bulk-created variant override", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-bulk-lottie-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  await writeFile(join(mediaRoot, BLUE), solidPng("#0000ff"));
  const document = apply(fixture(), {
    type: "bulk_create",
    sceneId: "base",
    rows: [["id", "Title", "Photo"], ["blue", "Variant title", blueSource]],
  });

  const variant = document.scenes.find((scene) => scene.bulkVariant?.key === "blue");
  const result = await exportScene(expandComponents(document, variant.id), { format: "lottie", width: 40, height: 20, fps: 4 }, { mediaRoot });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const asset = animation.assets.find((entry) => typeof entry.p === "string" && entry.p.startsWith("data:image/"));
  assert.ok(asset, "the selected variant image is embedded in the Lottie assets");
  const embedded = Buffer.from(asset.p.slice(asset.p.indexOf(",") + 1), "base64");
  const image = await readImage(embedded);
  const [red, green, blue] = image.pixel(4, 4);
  assert.ok(blue > 200 && red < 60 && green < 60, `Lottie embeds the variant's blue image (got ${red}, ${green}, ${blue})`);
});
