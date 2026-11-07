import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { expandComponents } from "./linkedComponents.js";
import { parseCsv, writeCsv } from "./csv.js";
import { applyBulkCreate, bulkCreateImageNames, planBulkCreate } from "./bulkCreate.js";
import { sceneCsvRows } from "./sceneCsv.js";

function fixture() {
  return parseDocument(createDocument({ id: "project", scenes: [createScene({
    id: "scene", name: "Café card", width: 720, height: 405, duration: 7.25,
    background: "#123456", backgroundEnabled: false,
    layers: [
      createLayer("group", { id: "group", name: "Copy" }),
      createLayer("text", { id: "title", parentId: "group", name: "Title", text: '="Hello, \"world\"!\n世界"' }),
      createLayer("image", { id: "photo", name: "Photo", src: "/api/media/photo.png" }),
      createLayer("image", { id: "gif", name: "Animation", src: "/api/media/loop.gif", mediaSourceDuration: 2.75 }),
      createLayer("image", { id: "empty", name: "Empty image", src: "" }),
      createLayer("rectangle", { id: "shape", name: "Shape" }),
    ],
  })] }));
}

const media = [
  { src: "/api/media/photo.png", name: "旅行, café.png", mime: "image/png" },
  { src: "/api/media/loop.gif", name: "ループ.gif", mime: "image/gif", duration: 2.75 },
];

test("scene CSV round-trips through Bulk Create with original text, media, background and dimensions", () => {
  const before = fixture();
  const rows = sceneCsvRows(before, "scene", media);
  const parsed = parseCsv(writeCsv(rows));
  assert.deepEqual(parsed.header, ["id", "Title", "Photo", "Animation", "Empty image", "info_log"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0][0], "copy");
  assert.equal(parsed.rows[0][1], before.scenes[0].layers.find((layer) => layer.id === "title").text);
  assert.deepEqual(parsed.rows[0].slice(2, 5), ["旅行, café.png", "ループ.gif", ""]);

  const savedImages = new Map(media.map((entry) => [entry.src, entry]));
  const plan = planBulkCreate(before, "scene", parsed.header, parsed.rows, [], savedImages);
  assert.deepEqual(plan.imagesNeeded, [], "saved media needs no upload");
  assert.equal(plan.errors.length, 0);
  const after = parseDocument(applyBulkCreate(before, plan, savedImages));
  const variant = after.scenes.find((scene) => scene.bulkVariant?.key === "copy");
  assert.ok(variant);
  const expanded = expandComponents(after, variant.id);
  const base = before.scenes[0];
  assert.deepEqual(
    [expanded.width, expanded.height, expanded.duration, expanded.background, expanded.backgroundEnabled],
    [base.width, base.height, base.duration, base.background, base.backgroundEnabled],
  );
  const comparable = (scene) => scene.layers.filter((layer) => layer.type === "text" || layer.type === "image")
    .map(({ type, name, text, src, mediaSourceDuration }) => ({ type, name, text, src, mediaSourceDuration }));
  assert.deepEqual(comparable(expanded), comparable(base));
  assert.deepEqual(after.scenes[0].layers.find((layer) => layer.id === "title").text, base.layers.find((layer) => layer.id === "title").text);
});

test("scene CSV uses an unused bounded copy id and excludes duplicate and reserved names", () => {
  const document = fixture();
  const scene = document.scenes[0];
  scene.layers.push(
    createLayer("text", { id: "duplicate", name: "Title", text: "ignored" }),
    createLayer("image", { id: "reserved", name: "info_log", src: "/api/media/photo.png" }),
    createLayer("text", { id: "id-name", name: "ID", text: "reserved" }),
  );
  document.scenes.push(
    createScene({ id: "copy-one", bulkVariant: { baseSceneId: "scene", key: "copy", instanceId: "i1" } }),
    createScene({ id: "copy-two", bulkVariant: { baseSceneId: "scene", key: "copy-2", instanceId: "i2" } }),
  );
  const rows = sceneCsvRows(document, "scene", media);
  assert.equal(rows[1][0], "copy-3");
  assert.ok(rows[0].length <= 256);
  assert.equal(rows[0].includes("ID"), false);
  assert.equal(rows[0].includes("info_log"), true, "the final reserved column is the diagnostic field");
});

test("duplicate saved filenames resolve to the current source, while unrelated ambiguity is refused", () => {
  const document = fixture();
  const metadata = [
    { src: "/api/media/photo.png", name: "same.png", mime: "image/png" },
    { src: "/api/media/other.png", name: "same.png", mime: "image/png" },
    { src: "/api/media/loop.gif", name: "loop.gif", mime: "image/gif" },
  ];
  const savedImages = new Map(metadata.map((entry) => [entry.src, entry]));
  const generated = sceneCsvRows(document, "scene", metadata);
  const parsed = parseCsv(writeCsv(generated));
  assert.equal(parsed.rows[0][parsed.header.indexOf("Photo")], "same.png");
  const resolved = planBulkCreate(document, "scene", parsed.header, parsed.rows, [], savedImages);
  assert.equal(resolved.errors.length, 0);
  assert.equal(resolved.creates[0].changes.find((change) => change.layerId === "photo").savedSrc, "/api/media/photo.png");

  const unrelated = structuredClone(document);
  unrelated.scenes[0].layers.find((layer) => layer.id === "photo").src = "/api/media/unrelated.png";
  const ambiguous = planBulkCreate(unrelated, "scene", ["id", "Photo"], [["other", "same.png"]], [], savedImages);
  assert.match(ambiguous.errors[0].message, /ambiguous/);
});

test("selected files take precedence over saved names and ambiguous selected files stay errors", () => {
  const document = fixture();
  const savedImages = new Map([
    ["/api/media/saved.png", { src: "/api/media/saved.png", name: "new.png", mime: "image/png" }],
  ]);
  const selected = planBulkCreate(document, "scene", ["id", "Photo"], [["one", "new.png"]],
    [{ name: "new.png", type: "image/png" }], savedImages);
  assert.deepEqual(selected.imagesNeeded, ["new.png"]);
  assert.equal(selected.creates[0].changes[0].fileName, "new.png");
  assert.equal(selected.creates[0].changes[0].savedSrc, undefined);

  const ambiguous = planBulkCreate(document, "scene", ["id", "Photo"], [["one", "New.png"]],
    [{ name: "new.png", type: "image/png" }, { name: "NEW.PNG", type: "image/png" }], savedImages);
  assert.match(ambiguous.errors[0].message, /ambiguous/);
});

test("saved-media lookup names include extensionless filenames and omit direct media URLs", () => {
  const document = fixture();
  assert.deepEqual(bulkCreateImageNames(document, "scene", ["id", "Photo", "Animation"], [
    ["copy", "original image", "/api/media/clip.gif"],
    ["copy-2", "", ""],
  ]), ["original image"]);
});

function sharedImageFixture() {
  const src = "/api/media/11111111-1111-4111-8111-111111111111.png";
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "scene", layers: [
    createLayer("image", { id: "photo", name: "Photo", src: `${src}?share=file-capability` }),
  ] })] }));
  const metadata = [
    { src, name: "photo.png", mime: "image/png", width: 20, height: 10 },
    { src: "/api/media/22222222-2222-4222-8222-222222222222.png", name: "photo.png", mime: "image/png", width: 10, height: 20 },
  ];
  return { document, metadata, savedImages: new Map(metadata.map((entry) => [entry.src, entry])) };
}

test("untouched scene CSV resolves duplicate filenames to the current shared upload and round-trips", () => {
  const { document, metadata, savedImages } = sharedImageFixture();
  const csv = parseCsv("id,Photo,info_log\r\ncopy,photo.png,\r\n");
  const plan = planBulkCreate(document, "scene", csv.header, csv.rows, [], savedImages);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.creates[0].changes[0].savedSrc, metadata[0].src);
  assert.deepEqual(plan.imagesNeeded, [], "an untouched CSV needs no upload");
  assert.deepEqual(parseCsv(writeCsv(sceneCsvRows(document, "scene", metadata))), csv);
  const after = parseDocument(applyBulkCreate(document, plan, savedImages));
  const variant = after.scenes.find((scene) => scene.bulkVariant?.key === "copy");
  const photo = expandComponents(after, variant.id).layers.find((layer) => layer.type === "image");
  assert.equal(photo.src, metadata[0].src, "the variant uses the same upload, not the other same-named file");
  assert.equal(document.scenes[0].layers[0].src, `${metadata[0].src}?share=file-capability`, "planning and applying do not mutate the base");

  const unrelated = structuredClone(document);
  unrelated.scenes[0].layers[0].src = "/api/media/33333333-3333-4333-8333-333333333333.png?share=file-capability";
  assert.match(planBulkCreate(unrelated, "scene", csv.header, csv.rows, [], savedImages).errors[0].message, /ambiguous/);
});
