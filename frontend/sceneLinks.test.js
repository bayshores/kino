import test from "node:test";
import assert from "node:assert/strict";
import { selectionFromLink } from "./sceneLinks.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { shareUrl } from "../engine/shareUrls.js";

// A link to a scene or layer, as the share menu builds it (shareUrls.js); null without a scene.
const selectionLink = (href, projectId, { sceneId, layerId, componentPath } = {}, options = {}) =>
  (sceneId ? shareUrl(href, projectId, { sceneId, layerId, componentPath }, options) : null);

const document = createDocument({ id: "project", scenes: [createScene({ id: "one" }), createScene({ id: "two", layers: [createLayer("rectangle", { id: "box" })] })] });

for (const selection of [{ sceneId: "two" }, { sceneId: "two", layerId: "box" }]) {
  test(`${selection.layerId ? "layer" : "scene"} links never forward workspace-owner credentials`, () => {
    for (const suffix of [
      "#owner=EXAMPLE-WORKSPACE-KEY",
      "&owner=EXAMPLE-WORKSPACE-KEY#owner=EXAMPLE-WORKSPACE-KEY",
      "&share=00000000-0000-0000-0000-000000000001.qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq#owner=EXAMPLE-WORKSPACE-KEY&share=00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv",
      "#share=00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv&%6fwner=EXAMPLE-WORKSPACE-KEY&owner=SECOND-OWNER-KEY&other=private",
    ]) {
      const link = selectionLink(`https://example.test/?project=project${suffix}`, document.id, selection);
      const url = new URL(link);
      assert.equal(url.searchParams.has("owner"), false);
      assert.equal(new URLSearchParams(url.hash.slice(1)).has("owner"), false);
      assert.equal(link.includes("WORKSPACE-KEY"), false);
      assert.equal(link.includes("SECOND-OWNER-KEY"), false);
      assert.equal(url.hash, suffix.includes("00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv") ? "#share=00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv" : "");
      assert.equal(url.searchParams.get("share"), null);
      assert.deepEqual(selectionFromLink(document, link), { sceneId: "two", layerIds: selection.layerId ? ["box"] : [] });
    }
  });
}

test("nodeId aliases resolve a scene or layer without changing the document", () => {
  const before = structuredClone(document);
  assert.deepEqual(selectionFromLink(document, "https://example.test/?nodeId=two"), { sceneId: "two", layerIds: [] });
  assert.deepEqual(selectionFromLink(document, "https://example.test/?nodeId=box"), { sceneId: "two", layerIds: ["box"] });
  assert.equal(selectionFromLink(document, "https://example.test/?nodeId=gone"), null);
  assert.deepEqual(document, before);
});

test("scene and layer links preserve capability parameters and clear stale export routes", () => {
  const source = "https://example.test/editor?project=old&export=one&time=2&share=00000000-0000-0000-0000-000000000001.qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq#share=00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";
  const scene = new URL(selectionLink(source, document.id, { sceneId: "two" }));
  assert.equal(scene.searchParams.get("project"), "project");
  assert.equal(scene.searchParams.get("scene"), "two");
  assert.equal(scene.searchParams.get("share"), null);
  assert.equal(scene.hash, "#share=00000000-0000-0000-0000-000000000002.vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv");
  assert.equal(scene.searchParams.has("export"), false);
  assert.equal(scene.searchParams.has("time"), false);
  const link = selectionLink(scene.href, document.id, { sceneId: "two", layerId: "box" });
  assert.deepEqual(selectionFromLink(document, link), { sceneId: "two", layerIds: ["box"] });
  assert.deepEqual(selectionFromLink(document, scene.href), { sceneId: "two", layerIds: [] });
  assert.equal(new URL(selectionLink(link, document.id, { sceneId: "one" })).searchParams.has("layer"), false);
});

test("unknown, other-project, invalid and native links are ignored without affecting document data", () => {
  assert.equal(selectionFromLink(document, "https://example.test/?scene=gone"), null);
  assert.equal(selectionFromLink(document, "https://example.test/?project=another&scene=two"), null);
  assert.deepEqual(selectionFromLink(document, "https://example.test/?scene=two&layer=gone"), { sceneId: "two", layerIds: [] });
  assert.equal(selectionLink("http://127.0.0.1:12345", "project", { sceneId: "two" }, { desktop: true }), null);
  assert.equal(selectionLink("file:///app", "project", { sceneId: "two" }), null);
});

test("links can select a nested inherited layer, while a stale path selects its instance", () => {
  const main = createScene({ id: "main", isComponent: true, layers: [createLayer("text", { id: "title", text: "Linked" })] });
  const page = createScene({ id: "page", layers: [createLayer("component", { id: "instance", componentSceneId: "main" })] });
  const doc = createDocument({ id: "components", scenes: [main, page] });
  const link = selectionLink("https://example.test/", doc.id, { sceneId: "page", layerId: "instance", componentPath: "title" });
  assert.deepEqual(selectionFromLink(doc, link), { sceneId: "page", layerIds: ["instance"],
    inheritedTarget: { sceneId: "page", instanceId: "instance", componentPath: "title" } });
  assert.deepEqual(selectionFromLink(doc, link.replace("componentPath=title", "componentPath=gone")), { sceneId: "page", layerIds: ["instance"] });
  assert.deepEqual(selectionFromLink(doc, "https://example.test/?nodeId=instance&componentPath=title"),
    { sceneId: "page", layerIds: ["instance"], inheritedTarget: { sceneId: "page", instanceId: "instance", componentPath: "title" } });
});
