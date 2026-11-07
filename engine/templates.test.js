import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { DOCUMENT_VERSION } from "./schema.js";
import { renderSceneSvg } from "./render.js";
import { createTemplateDocument, TEMPLATE_CATALOG } from "./templates.js";

const fonts = await loadBundledFonts();

function documentIds(document) {
  const scenes = document.scenes.map((scene) => scene.id);
  const layers = document.scenes.flatMap((scene) => scene.layers.map((layer) => layer.id));
  const animations = document.scenes.flatMap((scene) => scene.layers.flatMap((layer) => layer.animations.map((animation) => animation.id)));
  return { scenes, layers, animations };
}

test("the original template catalog has four licensed editable motion documents", () => {
  assert.deepEqual(TEMPLATE_CATALOG.map(({ name }) => name), ["Kinetic title", "Color orbit", "Motion card", "Lower third"]);
  assert.ok(TEMPLATE_CATALOG.every((template) => template.license === "AGPL-3.0-only"));

  const catalogBefore = structuredClone(TEMPLATE_CATALOG);
  for (const template of TEMPLATE_CATALOG) {
    const document = createTemplateDocument(template.id);
    assert.equal(document.version, DOCUMENT_VERSION);
    assert.equal(document.name, template.name);
    assert.equal(document.scenes.length, 1);
    const [scene] = document.scenes;
    assert.ok(scene.layers.length >= 4, `${template.name} contains editable layers`);
    assert.ok(scene.layers.some((layer) => layer.type === "text"), `${template.name} contains editable text`);
    assert.ok(scene.layers.some((layer) => ["rectangle", "ellipse"].includes(layer.type)), `${template.name} contains editable geometry`);
    assert.ok(scene.layers.some((layer) => layer.animations.length), `${template.name} has editable motion`);
    assert.ok(scene.layers.every((layer) => !["image", "video", "audio", "component"].includes(layer.type)),
      `${template.name} needs no external or private media`);
    const allIds = [...documentIds(document).scenes, ...documentIds(document).layers, ...documentIds(document).animations];
    assert.equal(new Set(allIds).size, allIds.length, `${template.name} IDs are unique within the document`);
    for (const layer of scene.layers) if (layer.parentId !== null)
      assert.ok(scene.layers.some((candidate) => candidate.id === layer.parentId && candidate.type === "group"));

    const again = createTemplateDocument(template.id);
    assert.notEqual(again.id, document.id, `${template.name} gets a fresh project ID for each use`);
    for (const key of ["scenes", "layers", "animations"]) {
      const first = new Set(documentIds(document)[key]);
      assert.ok(documentIds(again)[key].every((id) => !first.has(id)), `${template.name} gets fresh ${key} IDs`);
    }

    const startFrame = renderSceneSvg(scene, 0, { fonts });
    const previewFrame = renderSceneSvg(scene, template.previewTime, { fonts });
    assert.match(previewFrame, /<svg\b/u, `${template.name} renders through the shared scene renderer`);
    assert.notEqual(startFrame, previewFrame, `${template.name} preview time captures its motion`);
  }
  assert.deepEqual(TEMPLATE_CATALOG, catalogBefore, "creating preview and document instances never mutates catalog metadata");
});

test("unknown template IDs are refused", () => {
  assert.throws(() => createTemplateDocument("not-a-template"), /available kino template/u);
});
