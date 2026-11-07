import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLayer } from "../engine/animation.js";
import { createLayer } from "../engine/model.js";
import { layoutText } from "../engine/textLayout.js";
import { loadBundledFonts } from "./fonts.mjs";
import { lottieTextLayers } from "./lottie-text.mjs";

const fontsPromise = loadBundledFonts();

function property(values, dimension = 1) {
  const normalized = values.map((value) => Array.isArray(value) ? value.slice(0, dimension) : [value]);
  const same = normalized.every((value) => value.length === normalized[0].length && value.every((part, index) => Math.abs(Number(part) - Number(normalized[0][index])) < 1e-7));
  if (same) return { a: 0, k: dimension === 1 ? normalized[0][0] : normalized[0] };
  return {
    a: 1,
    k: normalized.map((value, index) => {
      const frame = { t: index, s: value };
      if (normalized[index + 1]) {
        frame.e = normalized[index + 1];
        frame.i = { x: 1, y: 1 };
        frame.o = { x: 0, y: 0 };
      } else frame.h = 1;
      return frame;
    }),
  };
}

function colorToRgba(value) {
  if (typeof value !== "string") return null;
  const match = /^#([\da-f]{3,8})$/iu.exec(value);
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3 || digits.length === 4) digits = [...digits].map((part) => part + part).join("");
  if (digits.length !== 6 && digits.length !== 8) return null;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
    digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
  ];
}

function localMatrix(layer, state) {
  const width = Number(state.width) || 0;
  const height = Number(state.height) || 0;
  const angle = (Number(state.rotation) || 0) * Math.PI / 180;
  const sx = Number.isFinite(state.scaleX) ? state.scaleX : 1;
  const sy = Number.isFinite(state.scaleY) ? state.scaleY : 1;
  const shear = Math.tan((Number(state.skewX) || 0) * Math.PI / 180);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const a = cos * sx, b = sin * sx;
  const c = cos * sx * shear - sin * sy;
  const d = sin * sx * shear + cos * sy;
  return [a, b, c, d, state.x + width / 2 - a * width / 2 - c * height / 2, state.y + height / 2 - b * width / 2 - d * height / 2];
}

function multiplyMatrix(parent, child) {
  const [a, b, c, d, e, f] = parent;
  const [g, h, i, j, k, l] = child;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

function sampledTransform(_layer, matrices, states, _label, anchor = [0, 0]) {
  const transforms = matrices.map((matrix, index) => {
    const [a, b, c, d, e, f] = matrix;
    const sx = Math.hypot(a, b);
    const determinant = a * d - b * c;
    const sy = sx > 1e-12 ? determinant / sx : Math.hypot(c, d);
    const dot = a * c + b * d;
    const rotation = (sx > 1e-12 ? Math.atan2(b, a) : Math.atan2(-c, d)) * 180 / Math.PI;
    const skew = Math.abs(determinant) > 1e-12 ? -Math.atan(dot / determinant) * 180 / Math.PI : 0;
    return {
      p: [e + a * anchor[0] + c * anchor[1], f + b * anchor[0] + d * anchor[1], 0],
      s: [sx * 100, sy * 100, 100],
      r: rotation,
      sk: skew,
      o: Math.max(0, Math.min(1, Number(states[index].opacity) || 0)) * 100,
    };
  });
  return {
    a: { a: 0, k: [0, 0, 0] },
    p: property(transforms.map((value) => value.p), 3),
    s: property(transforms.map((value) => value.s), 3),
    r: property(transforms.map((value) => value.r)),
    sk: property(transforms.map((value) => value.sk)),
    sa: { a: 0, k: 0 },
    o: property(transforms.map((value) => value.o)),
  };
}

const helpers = {
  property,
  colorToRgba,
  localMatrix,
  multiplyMatrix,
  sampledTransform,
  sampleLayer(layer, frames, unitIndex = 0, unitCount = 1, unit = "layer") {
    return frames.map((time) => evaluateLayer(layer, time, { unitIndex, unitCount, unit }));
  },
};

function exportText(layer, frames, fonts, activeHelpers = helpers) {
  let index = 1;
  const nextIndex = () => index++;
  const matrices = frames.map(() => [1, 0, 0, 1, 0, 0]);
  const opacities = frames.map(() => 1);
  const exportHelpers = typeof activeHelpers.compose === "function"
    ? { ...activeHelpers, compose: (content, name) => activeHelpers.compose(content, name, nextIndex) }
    : activeHelpers;
  return lottieTextLayers(layer, layer, frames, Math.max(1, frames.length - 1), 30, nextIndex, matrices, opacities, exportHelpers, fonts);
}

function compositionFixture(width, height) {
  const assets = [];
  return {
    assets,
    compose(content, name, nextIndex) {
      if (content.length === 1) return content[0];
      const refId = `composition_${nextIndex()}`;
      assets.push({ id: refId, w: width, h: height, layers: content.reverse() });
      return {
        ddd: 0,
        ind: nextIndex(),
        ty: 0,
        nm: name,
        refId,
        w: width,
        h: height,
        sr: 1,
        ao: 0,
        ip: 0,
        op: 2,
        st: 0,
        bm: 0,
        ks: { o: { a: 0, k: 100 } },
      };
    },
  };
}

function outlineItems(layers) {
  return layers.flatMap((layer) => layer.shapes ?? [])
    .flatMap((group) => group.it ?? [])
    .filter((item) => item.ty === "sh");
}

function firstOutlineX(layer) {
  const item = outlineItems([layer])[0];
  const shape = item.ks.a ? item.ks.k[0].s[0] : item.ks.k;
  return shape.v[0][0];
}

function textLayer(overrides = {}) {
  return createLayer("text", {
    id: "headline",
    name: "Headline",
    x: 12,
    y: 18,
    width: 220,
    height: 72,
    text: "AVATAR",
    fontFamily: "Inter",
    fontStyle: "normal",
    fontWeight: 400,
    fontSize: 36,
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    verticalAlign: "top",
    textResize: "fixed",
    kerning: true,
    ligatures: true,
    fill: "#332211",
    stroke: "none",
    strokeWidth: 0,
    animations: [],
    ...overrides,
  });
}

test("bundled Inter exports as portable vector outlines and uses real kerning placement", async () => {
  const fonts = await fontsPromise;
  const frames = [0];
  const kerningLayer = textLayer({
    text: "AV",
    width: 120,
    animations: [{ id: "letters", name: "Letters", kind: "custom", start: 10, duration: 1, easing: "linear", from: { opacity: 1 }, to: { opacity: 1 }, unit: "letters", stagger: 0, order: "forward" }],
  });
  const plainLayer = { ...kerningLayer, kerning: false };
  const shaped = layoutText(kerningLayer, fonts);
  const unkerned = layoutText(plainLayer, fonts);
  assert.ok(shaped.lines[0].width < unkerned.lines[0].width, "Inter's real pair positioning tightens AV");

  const kerningOutput = exportText(kerningLayer, frames, fonts);
  const plainOutput = exportText(plainLayer, frames, fonts);
  assert.equal(kerningOutput.length, 2, "letter mode emits one outline layer per text unit");
  assert.ok(kerningOutput.every((layer) => layer.ty === 4), "outline layers are native Lottie shape layers");
  assert.ok(outlineItems(kerningOutput).length > 0, "Fontkit supplies real glyph outlines");
  const kernedV = firstOutlineX(kerningOutput[1]);
  const plainV = firstOutlineX(plainOutput[1]);
  assert.ok(kernedV < plainV, "the second glyph keeps Inter's kerning offset");
  const portable = JSON.stringify(kerningOutput);
  assert.doesNotMatch(portable, /"ty":5|"fFamily"|"Inter"/u, "the animation carries outlines, not font references or text layers");
});

test("letter-unit opacity uses the actual stagger state for each outline layer", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({
    text: "AB",
    width: 100,
    animations: [{
      id: "reveal",
      name: "Reveal",
      kind: "in",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { opacity: 0 },
      to: { opacity: 1 },
      unit: "letters",
      stagger: 0.25,
      order: "forward",
    }],
  });
  const layers = exportText(layer, [0, 0.25, 0.5, 1], fonts);
  assert.equal(layers.length, 2);
  const first = layers[0].ks.o.k;
  const second = layers[1].ks.o.k;
  assert.equal(first[2].s[0], 50);
  assert.equal(second[2].s[0], 25);
  assert.equal(first[1].s[0], 25);
  assert.equal(second[1].s[0], 0);
});

test("sampled width changes relayout real outlines while preserving stable glyph topology", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({
    text: "AV",
    width: 100,
    animations: [{
      id: "reflow",
      name: "Reflow",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { width: 100 },
      to: { width: 30 },
      unit: "layer",
      stagger: 0,
      order: "forward",
    }],
  });
  const layers = exportText(layer, [0, 0.5, 1], fonts);
  assert.equal(layers.length, 1);
  const paths = outlineItems(layers);
  assert.ok(paths.some((item) => item.ks.a === 1), "frame layouts become sampled Bezier path properties");
});

test("per-unit font size and tracking are laid out from each sampled unit state", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({
    text: "AV",
    width: 150,
    animations: [{ id: "letter-motion", name: "Letter motion", kind: "custom", start: 0, duration: 1, easing: "linear", from: { opacity: 1 }, to: { opacity: 1 }, unit: "letters", stagger: 0, order: "forward" }],
  });
  const unitHelpers = {
    ...helpers,
    sampleLayer(sampledLayer, frames, unitIndex = 0, unitCount = 1, unit = "layer") {
      return helpers.sampleLayer(sampledLayer, frames, unitIndex, unitCount, unit).map((state, frameIndex) =>
        unit === "letters" && unitIndex === 1
          ? { ...state, fontSize: frameIndex === 0 ? 36 : 48, letterSpacing: frameIndex === 0 ? 0 : 5 }
          : state,
      );
    },
  };
  const layers = exportText(layer, [0, 1], fonts, unitHelpers);
  assert.equal(layers.length, 2);
  const vPath = outlineItems([layers[1]])[0];
  assert.equal(vPath.ks.a, 1);
  const first = vPath.ks.k[0].s[0];
  const last = vPath.ks.k.at(-1).s[0];
  assert.ok(last.v[0][0] > first.v[0][0], "per-unit size and tracking change V's full-line shaped placement");
  assert.deepEqual(layers[1].ks.p.k, [12, 18, 0], "glyph outlines stay in textbox-local coordinates without per-glyph recentering");
});

test("text gradients span the full textbox bounds for each exported unit", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({
    text: "AV",
    width: 220,
    height: 72,
    fill: {
      type: "linear",
      angle: 0,
      stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }],
    },
  });
  const [outline] = exportText(layer, [0], fonts);
  const group = outline.shapes.find((item) => item.it.some((entry) => entry.ty === "gf"));
  const gradient = group.it.find((item) => item.ty === "gf");
  const transform = group.it.at(-1);
  const layout = layoutText(layer, fonts);
  assert.deepEqual(gradient.s.k, [0, layout.height / 2]);
  assert.deepEqual(gradient.e.k, [layout.width, layout.height / 2]);
  assert.deepEqual(transform.p.k, [0, 0]);
  assert.deepEqual(transform.s.k, [100, 100], "glyph paths stay in final text coordinates while the gradient spans the full text box");
});

test("long text emits bounded per-glyph shape groups beyond the compound contour limit", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({ text: "O".repeat(257), width: 10_000, height: 72 });
  const [outline] = exportText(layer, [0], fonts);
  const totalContours = outlineItems([outline]).length;
  assert.equal(outline.shapes.length, 257, "each real glyph outline is serialized in its own bounded group");
  assert.ok(totalContours > 512, `expected more than 512 real glyph contours, received ${totalContours}`);
});

test("aligned glyph strokes use native shape groups and one unit-opacity composition", async () => {
  const fonts = await fontsPromise;
  const layer = textLayer({
    text: "AV",
    width: 220,
    height: 72,
    fill: "#332211",
    stroke: "#cc2255",
    strokeWidth: 4,
    animations: [{
      id: "fade",
      name: "Fade",
      kind: "in",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { opacity: 0 },
      to: { opacity: 1 },
      unit: "layer",
      stagger: 0,
      order: "forward",
    }],
  });

  for (const [strokeAlign, matteType] of [["inside", 1], ["outside", 2]]) {
    const alignedLayer = { ...layer, strokeAlign };
    const fixture = compositionFixture(alignedLayer.width, alignedLayer.height);
    const layers = exportText(alignedLayer, [0, 0.5, 1], fonts, {
      ...helpers,
      compose: fixture.compose,
    });

    assert.equal(layers.length, 1, "the text unit stays a single wrapper layer");
    const wrapper = layers[0];
    assert.equal(wrapper.ty, 0, "aligned glyph strokes use a real precomposition wrapper");
    assert.equal(fixture.assets.length, 1);
    const asset = fixture.assets[0];
    assert.equal(asset.id, wrapper.refId);
    assert.equal(asset.id, `composition_${asset.layers.length + 1}`);
    assert.equal(wrapper.ind, asset.layers.length + 2);
    assert.equal(
      new Set([...asset.layers.map((child) => child.ind), wrapper.ind]).size,
      asset.layers.length + 1,
      "child, asset, and wrapper indices share the current composition allocator",
    );
    assert.deepEqual([asset.w, asset.h], [layer.width, layer.height]);
    assert.deepEqual(
      wrapper.ks.o.k.map((frame) => frame.s[0]),
      [0, 50, 100],
      "unit opacity is sampled on the wrapper once",
    );

    const children = asset.layers;
    assert.equal(children.length, 6, "two glyphs each retain fill, stroke, and silhouette layers");
    assert.ok(children.every((child) => child.ty === 4));
    assert.ok(children.every((child) => child.ks.o.a === 0 && child.ks.o.k === 100), "composition children stay opaque");

    const silhouettes = children.filter((child) => child.td === 1);
    const strokeTargets = children.filter((child) => Object.hasOwn(child, "tt"));
    assert.equal(silhouettes.length, 2);
    assert.equal(strokeTargets.length, 2);
    assert.ok(silhouettes.every((silhouette) => {
      const fill = silhouette.shapes.flatMap((group) => group.it ?? []).find((item) => item.ty === "fl");
      return fill?.c.k.every((channel) => channel === 1) && fill?.o.k === 100;
    }), "each matte is an opaque native glyph silhouette");
    assert.ok(strokeTargets.every((stroke) => stroke.tt === matteType));
    for (const stroke of strokeTargets) {
      const matte = silhouettes.find((silhouette) => silhouette.ind === stroke.tp);
      assert.ok(matte, "each stroke points to its own glyph silhouette");
      const nativeStroke = stroke.shapes.flatMap((group) => group.it ?? []).find((item) => item.ty === "st");
      assert.equal(nativeStroke?.w.k, 8, "the native centered stroke is doubled for alpha-matte clipping");
      assert.equal(outlineItems([stroke]).length, outlineItems([matte]).length);
      assert.deepEqual(
        outlineItems([stroke]).map((shape) => shape.ks),
        outlineItems([matte]).map((shape) => shape.ks),
        "stroke and matte retain the same source glyph curves instead of replacing them with an outline expansion",
      );
    }
  }
});
