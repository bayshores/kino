import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { documentMediaIds, mediaAllowedIn, recordProjectUse } from "./media-use.mjs";
import { FontRegistry } from "../engine/fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createComponentInstance } from "../engine/linkedComponents.js";

test("a media file may be used by the file it was uploaded to and by files that used it", () => {
  const entry = { id: "a.png", projectId: "file-a", usedInProjects: ["file-b"] };
  assert.equal(mediaAllowedIn(entry, "file-a"), true);
  assert.equal(mediaAllowedIn(entry, "file-b"), true);
  assert.equal(mediaAllowedIn(entry, "file-c"), false);
  assert.equal(mediaAllowedIn({ id: "old.png" }, "file-a"), false, "a record without a file belongs to no sharing link");
  assert.equal(mediaAllowedIn(null, "file-a"), false);
});

test("recording a file's use adds it once and leaves the record otherwise unchanged", () => {
  const entry = { id: "a.png", src: "/api/media/a.png", projectId: "file-a" };
  const used = recordProjectUse(entry, "file-b");
  assert.deepEqual(used, { ...entry, usedInProjects: ["file-b"] });
  assert.equal(entry.usedInProjects, undefined, "the original record is not changed");
  assert.equal(recordProjectUse(used, "file-b"), null, "a file already listed needs no write");
  assert.equal(recordProjectUse(entry, "file-a"), null, "the file it was uploaded to needs no entry");
  assert.deepEqual(recordProjectUse(used, "file-c").usedInProjects, ["file-b", "file-c"]);
  assert.deepEqual(recordProjectUse({ id: "b.png", usedInProjects: ["file-b", 7] }, "file-c").usedInProjects, ["file-b", "file-c"], "damaged entries are dropped");
});

test("document references include decoded frames and family-only fonts from text and inherited overrides", async () => {
  const fonts = new FontRegistry();
  const bytes = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const regular = "11111111-1111-4111-8111-111111111111.ttf";
  const bold = "22222222-2222-4222-8222-222222222222.ttf";
  const italic = "33333333-3333-4333-8333-333333333333.ttf";
  for (const [id, weight, style] of [[regular, 400, "normal"], [bold, 700, "normal"], [italic, 400, "italic"]])
    fonts.register(bytes, { id, family: "ReviewFace", weight, style, src: `/api/media/${id}` });
  const gif = "44444444-4444-4444-8444-444444444444.gif";
  const master = createScene({ id: "master", isComponent: true, layers: [
    createLayer("text", { id: "title", fontFamily: "ReviewFace", fontStyle: "italic" }),
    createLayer("image", { id: "photo", src: "data:image/png;base64,AAAA" }),
  ] });
  const document = parseDocument(createDocument({ scenes: [master, createScene({ id: "main", layers: [
    createLayer("text", { id: "regular", fontFamily: "reviewface", fontWeight: 420 }),
    createComponentInstance(master, { id: "instance", componentOverrides: {
      title: { fontStyle: "normal", fontWeight: 700 },
      photo: { src: `/api/media/${gif}/frames/0.png?decoder=1&share=scope` },
    } }),
  ] })] }));
  const before = JSON.stringify(document);
  assert.deepEqual([...documentMediaIds(document, { fonts })].sort(), [regular, bold, italic, gif].sort());
  assert.deepEqual([...documentMediaIds(document)], [gif], "an unresolved catalog still tracks explicit media");
  assert.equal(JSON.stringify(document), before, "dependency collection never rewrites the document");
});

test("a script layer's image input counts as the project's use of that picture", () => {
  const photo = "55555555-5555-4555-8555-555555555555.png";
  const script = "export default function setup() { return function draw() {}; }";
  const layer = createLayer("script", { id: "plot", script, inputs: [{ key: "photo", type: "image" }, { key: "none", type: "image" }], values: { photo: `/api/media/${photo}`, none: "" } });
  assert.deepEqual([...documentMediaIds(createDocument({ scenes: [createScene({ layers: [layer] })] }))], [photo]);
});

test("unavailable fonts do not hide explicit uploaded-font dependencies", () => {
  const explicit = "11111111-1111-4111-8111-111111111111.ttf";
  const document = createDocument({ scenes: [createScene({ layers: [
    createLayer("text", { fontSource: `/api/media/${explicit}`, fontFamily: "Missing" }),
    createLayer("text", { fontFamily: "Inter" }),
  ] })] });
  assert.deepEqual([...documentMediaIds(document, { fonts: new FontRegistry() })], [explicit]);
});
