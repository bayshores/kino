import assert from "node:assert/strict";
import test from "node:test";
import { vectorLayer } from "./lottie-vector.mjs";

function sampledTransform(opacity = { a: 0, k: 65 }) {
  return {
    a: { a: 0, k: [3, 4, 0] },
    p: { a: 0, k: [14, 22, 0] },
    s: { a: 0, k: [110, 90, 100] },
    r: { a: 0, k: 8 },
    o: opacity,
    sk: { a: 0, k: 12 },
    sa: { a: 0, k: 0 },
  };
}

function makeAllocator(start = 1) {
  let index = start;
  return () => index++;
}

function group(name, extra = {}) {
  return { ty: "gr", nm: name, it: [], ...extra };
}

function identityTransform() {
  return {
    a: { a: 0, k: [0, 0, 0] },
    p: { a: 0, k: [0, 0, 0] },
    s: { a: 0, k: [100, 100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 },
  };
}

test("centered drawings combine into one native shape layer with the sampled transform", () => {
  const transform = sampledTransform();
  const paints = [
    { content: [group("first fill"), group("first stroke")] },
    { content: [group("second drawing")] },
  ];
  const layer = vectorLayer(paints, transform, {
    name: "Centered shape",
    frameCount: 24,
    nextIndex: makeAllocator(8),
  });

  assert.deepEqual(layer, {
    ddd: 0,
    ind: 8,
    ty: 4,
    nm: "Centered shape",
    sr: 1,
    ks: transform,
    ao: 0,
    shapes: [group("first fill"), group("first stroke"), group("second drawing")],
    ip: 0,
    op: 24,
    st: 0,
    bm: 0,
  });
  assert.notEqual(layer.ks, transform);
  assert.notEqual(layer.shapes[0], paints[0].content[0]);
});

test("alpha and inverse-alpha stroke mattes keep drawing order and distinct references", () => {
  const transform = sampledTransform();
  const paints = [
    {
      content: [group("first fill")],
      stroke: [group("first stroke")],
      matte: [group("first silhouette")],
      matteType: 1,
    },
    {
      content: [group("second fill")],
      stroke: [group("second stroke")],
      matte: [group("second silhouette")],
      matteType: 2,
    },
  ];
  const sourceBefore = structuredClone(paints);
  const transformBefore = structuredClone(transform);
  const nextIndex = makeAllocator(20);
  let callbackOrder;
  let callbackShapeOrder;
  let callbackIndexOrder;
  let callbackName;
  let callbackContent;
  let wrapper;

  const result = vectorLayer(paints, transform, {
    name: "Draw unit",
    frameCount: 12,
    nextIndex,
    compose(content, name) {
      callbackOrder = content.map((layer) => layer.nm);
      callbackShapeOrder = content.map((layer) => layer.shapes[0].nm);
      callbackIndexOrder = content.map((layer) => layer.ind);
      callbackName = name;
      callbackContent = content;
      wrapper = {
        ddd: 0,
        ind: nextIndex(),
        ty: 0,
        nm: name,
        refId: "unit-vectors",
        ks: identityTransform(),
      };
      content[0].shapes[0].nm = "callback-owned change";
      content.reverse();
      return wrapper;
    },
  });

  assert.deepEqual(callbackOrder, [
    "Draw unit content 1",
    "Draw unit stroke 1",
    "Draw unit matte 1",
    "Draw unit content 2",
    "Draw unit stroke 2",
    "Draw unit matte 2",
  ]);
  assert.deepEqual(callbackShapeOrder, [
    "first fill",
    "first stroke",
    "first silhouette",
    "second fill",
    "second stroke",
    "second silhouette",
  ]);
  assert.deepEqual(callbackIndexOrder, [20, 21, 22, 23, 24, 25]);
  assert.equal(callbackName, "Draw unit");
  assert.equal(result, wrapper);
  assert.equal(result.ks.o.k, 65);
  assert.deepEqual(result.ks.p, identityTransform().p);
  assert.deepEqual(result.ks.a, identityTransform().a);
  assert.deepEqual(result.ks.s, identityTransform().s);
  assert.deepEqual(result.ks.r, identityTransform().r);
  assert.deepEqual(result.ks.sk, identityTransform().sk);

  // The callback receives bottom-to-top layers and owns serialization reversal.
  const children = callbackContent;
  assert.deepEqual(children.map((layer) => layer.ind), [25, 24, 23, 22, 21, 20]);
  assert.equal(new Set([...children.map((layer) => layer.ind), wrapper.ind]).size, 7);
  const targets = children.filter((layer) => Object.hasOwn(layer, "tt"));
  const mattes = children.filter((layer) => layer.td === 1);
  assert.deepEqual(targets.map((layer) => layer.tt), [2, 1]);
  assert.deepEqual(targets.map((layer) => layer.tp), mattes.map((layer) => layer.ind));
  assert.ok(children.every((layer) => layer.ks.o.a === 0 && layer.ks.o.k === 100));
  assert.equal(nextIndex(), 27);

  assert.deepEqual(paints, sourceBefore);
  assert.deepEqual(transform, transformBefore);
});

test("multiple glyph drawings stay inside one unit composition with one matte pair per glyph", () => {
  const paints = [
    {
      content: [group("glyph A fill")],
      stroke: [group("glyph A stroke")],
      matte: [group("glyph A outline")],
      matteType: 1,
    },
    {
      content: [group("glyph B fill")],
      stroke: [group("glyph B stroke")],
      matte: [group("glyph B outline")],
      matteType: 2,
    },
  ];
  const nextIndex = makeAllocator();
  let composeCalls = 0;
  let captured;
  const wrapper = { ks: identityTransform(), ty: 0, ind: 8, nm: "Text unit" };
  const result = vectorLayer(paints, sampledTransform(), {
    name: "Text unit",
    frameCount: 30,
    nextIndex,
    compose(content) {
      composeCalls += 1;
      captured = content;
      return wrapper;
    },
  });

  assert.equal(result, wrapper);
  assert.equal(composeCalls, 1);
  assert.equal(captured.length, 6);
  assert.deepEqual(captured.filter((layer) => layer.td === 1).map((layer) => layer.nm), [
    "Text unit matte 1",
    "Text unit matte 2",
  ]);
  assert.deepEqual(
    captured.filter((layer) => Object.hasOwn(layer, "tt")).map((layer) => layer.tp),
    captured.filter((layer) => layer.td === 1).map((layer) => layer.ind),
  );
});

test("animated opacity lives on the wrapper once while matte children remain fully opaque", () => {
  const opacity = {
    a: 1,
    k: [
      { t: 0, s: [20], e: [80], i: { x: 0, y: 0 }, o: { x: 1, y: 1 } },
      { t: 12, s: [80] },
    ],
  };
  const transform = sampledTransform(opacity);
  const seen = [];
  const wrapper = { ks: identityTransform(), ty: 0, ind: 3, nm: "Opacity wrapper" };
  const result = vectorLayer(
    [{ stroke: [group("stroke")], matte: [group("silhouette")], matteType: 1 }],
    transform,
    {
      name: "Opacity wrapper",
      frameCount: 12,
      nextIndex: makeAllocator(),
      compose(content) {
        seen.push(...content);
        return wrapper;
      },
    },
  );

  assert.deepEqual(result.ks.o, opacity);
  assert.deepEqual(result.ks.p, identityTransform().p);
  assert.ok(seen.every((layer) => layer.ks.o.a === 0 && layer.ks.o.k === 100));
});

test("matte records reject malformed types and incomplete stroke or silhouette groups", () => {
  const transform = sampledTransform();
  const options = { name: "Invalid", frameCount: 12, nextIndex: makeAllocator(), compose: () => ({ ks: identityTransform() }) };
  assert.throws(
    () => vectorLayer([{ content: [], stroke: [group("stroke")], matte: [group("matte")], matteType: 3 }], transform, options),
    /matteType must be 1 or 2/,
  );
  assert.throws(
    () => vectorLayer([{ content: [], matte: [group("matte")], matteType: 1 }], transform, options),
    /matte requires stroke shape groups/,
  );
  assert.throws(
    () => vectorLayer([{ content: [], stroke: [group("stroke")], matteType: 1 }], transform, options),
    /stroke and matteType require a matte silhouette/,
  );
  assert.throws(
    () => vectorLayer([{ content: [], stroke: [group("stroke")], matte: [], matteType: 1 }], transform, options),
    /matte must contain shape groups/,
  );
  assert.throws(
    () => vectorLayer([{ stroke: [group("stroke")], matte: [group("matte")] }], transform, options),
    /matte requires matteType 1 or 2/,
  );
});

test("matte composition needs a callback and preserves callback errors", () => {
  const paints = [{ stroke: [group("stroke")], matte: [group("matte")], matteType: 1 }];
  assert.throws(
    () => vectorLayer(paints, sampledTransform(), { name: "Missing callback", frameCount: 4, nextIndex: makeAllocator() }),
    /requires a composition callback/,
  );

  const callbackError = new Error("composition bounds failed");
  assert.throws(
    () => vectorLayer(paints, sampledTransform(), {
      name: "Callback failure",
      frameCount: 4,
      nextIndex: makeAllocator(),
      compose() {
        throw callbackError;
      },
    }),
    (error) => error === callbackError,
  );
});
