import test from "node:test";
import assert from "node:assert/strict";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { applyOperations } from "./operations.js";

const base = { id: "11111111-1111-4111-8111-111111111111.png", src: "/api/media/11111111-1111-4111-8111-111111111111.png", name: "base.png", mime: "image/png", duration: 0 };
const variant = { ...base, id: "22222222-2222-4222-8222-222222222222.png", src: "/api/media/22222222-2222-4222-8222-222222222222.png", name: "variant.png" };
const video = { id: "33333333-3333-4333-8333-333333333333.mp4", src: "/api/media/33333333-3333-4333-8333-333333333333.mp4", name: "clip.mp4", mime: "video/mp4", duration: 2 };
const mediaById = new Map([base, variant, video].map((item) => [item.id, item]));
const replacement = { type: "replace_media", sceneId: "base", layerId: "photo", mediaId: video.id };

function fixture(kind) {
  const master = createScene({ id: "base", name: "Base", isComponent: kind !== "bulk", layers: [
    createLayer("image", { id: "photo", name: "Photo", src: base.src }),
  ] });
  if (kind === "bulk") return applyOperations(createDocument({ scenes: [master] }), [{ type: "bulk_create", sceneId: "base",
    rows: [["id", "Photo"], ["one", variant.src]],
  }], { mediaBySrc: new Map([[variant.src, variant]]) });
  const inner = createComponentInstance(master, { id: "inner", ...(kind === "inner" ? {
    componentOverrides: { photo: { src: variant.src, mediaSourceDuration: 0 } },
  } : {}) });
  const nested = kind === "nested" || kind === "inner";
  const wrapper = nested ? createScene({ id: "wrapper", isComponent: true, layers: [inner] }) : master;
  const instance = createComponentInstance(wrapper, { id: "instance", ...(kind !== "inner" ? {
    componentOverrides: { [nested ? "inner/photo" : "photo"]: { src: variant.src, mediaSourceDuration: 0 } },
  } : {}) });
  return parseDocument(createDocument({ scenes: [...(nested ? [master] : []), wrapper,
    createScene({ id: "page", layers: [instance] }),
  ] }));
}

for (const kind of ["ordinary", "nested", "inner", "bulk"]) {
  test(`master image to video refuses before losing ${kind} source overrides`, () => {
    const document = fixture(kind), before = structuredClone(document);
    const page = document.scenes.at(-1);
    const drawn = expandComponents(document, page.id).layers.find((layer) => layer.src === variant.src);
    assert.equal(drawn?.type, "image", "fixture displays the customized image");
    assert.throws(() => applyOperations(document, [replacement], { mediaById }), /instance.*image|image.*override/i);
    assert.deepEqual(document, before, "all stored overrides and the master remain unchanged");
    const persisted = parseDocument(document);
    assert.deepEqual(persisted, before, "saved overrides survive normalization after refusal");
    assert.equal(expandComponents(persisted, page.id).layers.find((layer) => layer.src === variant.src)?.type, "image");
  });
}

test("an image master with image overrides can still replace its own image source", () => {
  const document = fixture("nested");
  const image = { ...base, id: "44444444-4444-4444-8444-444444444444.png", src: "/api/media/44444444-4444-4444-8444-444444444444.png" };
  const next = applyOperations(document, [{ ...replacement, mediaId: image.id }], { mediaById: new Map([...mediaById, [image.id, image]]) });
  assert.equal(next.scenes[0].layers[0].src, image.src);
  assert.equal(next.scenes.at(-1).layers[0].componentOverrides["inner/photo"].src, variant.src);
  assert.equal(expandComponents(next, "page").layers.find((layer) => layer.componentPath === "inner/photo").src, variant.src);
});

test("unoverridden instances follow a master's image to video replacement", () => {
  const document = fixture("ordinary");
  delete document.scenes.at(-1).layers[0].componentOverrides;
  const next = applyOperations(document, [replacement], { mediaById });
  assert.equal(expandComponents(next, "page").layers.find((layer) => layer.componentPath === "photo").type, "video");
});
