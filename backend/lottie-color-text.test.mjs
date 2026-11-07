import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { glyphDrawBounds, layoutText, textUnits } from "../engine/textLayout.js";
import { loadBundledFonts } from "./fonts.mjs";
import { exportScene } from "./export.mjs";

const paletteOverlay = "M0 0L6000 0L6000 2000L0 2000Z";
const bitmap = `data:image/png;base64,${new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path fill="#e24d42" d="M0 0h6v12H0z"/><path fill="#246b93" d="M6 0h6v12H6z"/></svg>',
).render().asPng().toString("base64")}`;
const vector = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#f0a23b"/></svg>',
).toString("base64")}`;

async function colorFontRegistry() {
  const fonts = await loadBundledFonts();
  const face = fonts.faces.find((item) => item.family === "Inter" && item.weight === 400 && item.style === "normal");
  assert.ok(face, "the bundled Inter face is available without network access");
  const ids = new Map([..."ABCD"].map((character) => [character.codePointAt(0), face.font.glyphForCodePoint(character.codePointAt(0)).id]));
  const outlineB = face.font.getGlyph(ids.get("B".codePointAt(0))).path.toSVG();
  face.colorReader = {
    glyph(id, font) {
      if (id === ids.get("B".codePointAt(0))) return { kind: "layers", layers: [
        { path: outlineB, fill: "#e24d42ff" },
        { path: paletteOverlay, fill: "#246b93ff" },
      ] };
      if (id === ids.get("C".codePointAt(0))) return {
        kind: "image", mime: "image/png", href: bitmap,
        x: 0, y: -font.ascent, width: font.unitsPerEm * 0.62, height: font.ascent,
        pixelWidth: 12, pixelHeight: 12,
      };
      if (id === ids.get("D".codePointAt(0))) return {
        kind: "image", mime: "image/svg+xml", href: vector,
        x: 0, y: -font.ascent, width: font.unitsPerEm * 0.62, height: font.ascent,
      };
      return null;
    },
  };
  return fonts;
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else walk(child, visit);
  }
}

function exportedLayers(animation) {
  const byId = new Map((animation.assets ?? []).map((asset) => [asset.id, asset]));
  const layers = [];
  const seen = new Set();
  const visit = (items) => {
    for (const layer of items ?? []) {
      layers.push(layer);
      if (layer.ty !== 0 || !layer.refId || seen.has(layer.refId)) continue;
      seen.add(layer.refId);
      visit(byId.get(layer.refId)?.layers);
    }
  };
  visit(animation.layers);
  return layers;
}

function lottieTransformMatrix(transform) {
  const [px, py] = transform.p.k;
  const [ax, ay] = transform.a.k;
  const [sx, sy] = transform.s.k.map((value) => value / 100);
  const angle = transform.r.k * Math.PI / 180;
  const a = Math.cos(angle) * sx, b = Math.sin(angle) * sx;
  const c = -Math.sin(angle) * sy, d = Math.cos(angle) * sy;
  return [a, b, c, d, px - a * ax - c * ay, py - b * ax - d * ay];
}

function applyMatrix(matrix, [x, y]) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

test("Lottie text keeps palette paths and color images in glyph order inside one transformed, masked unit", async () => {
  const fonts = await colorFontRegistry();
  const mask = createLayer("rectangle", {
    id: "color-mask", name: "Color mask", x: 8, y: 18, width: 304, height: 132,
    fill: "#ffffff", isMask: true,
  });
  const text = createLayer("text", {
    id: "chromatic", name: "Chromatic", x: 18, y: 34, width: 136, height: 92,
    text: "ABCD", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal", fontSize: 44,
    textAlign: "left", verticalAlign: "top", textResize: "fixed",
    fill: "#17202b", stroke: "#00ff00", strokeWidth: 3, strokeAlign: "center", opacity: 0.62,
    blur: 1.5, shadow: { x: 3, y: 2, blur: 2, color: "#00000070" },
    animations: [{
      id: "grow-text", name: "Grow text", kind: "custom", start: 0, duration: 1,
      easing: "linear", from: { fontSize: 44 }, to: { fontSize: 60 },
      unit: "layer", stagger: 0, order: "forward",
    }],
  });
  const scene = createScene({
    id: "color-glyph-scene", name: "Color glyphs", width: 320, height: 180,
    duration: 1, background: "transparent", layers: [mask, text],
  });

  const result = await exportScene(scene, { format: "lottie", fps: 2 }, { fonts });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const layers = exportedLayers(animation);
  const imageLayers = layers.filter((layer) => layer.ty === 2 && /:image image$/u.test(layer.nm ?? ""));
  assert.equal(imageLayers.length, 2, "the bitmap and SVG glyphs become two ordered image layers");
  assert.ok(imageLayers.every((layer) => layer.ks.p.a === 1 && layer.ks.s.a === 1),
    "child image placement and scale follow the sampled text layout");
  assert.ok(imageLayers.every((layer) => {
    const positions = layer.ks.p.k;
    const scales = layer.ks.s.k;
    return JSON.stringify(positions[0].s) !== JSON.stringify(positions.at(-1).s) &&
      JSON.stringify(scales[0].s) !== JSON.stringify(scales.at(-1).s);
  }), "font-size samples move and resize each color image glyph");

  const imageAssets = animation.assets.filter((asset) => /^data:image\/(?:png|svg\+xml);base64,/u.test(asset.p ?? ""));
  assert.equal(imageAssets.length, 2, "both local color-image sources are embedded in the Lottie file");
  assert.equal(imageAssets.filter((asset) => asset.p.startsWith("data:image/png;")).length, 1);
  const svgAsset = imageAssets.find((asset) => asset.p.startsWith("data:image/svg+xml;"));
  assert.ok(svgAsset, "vector artwork stays vector instead of being sampled twice");
  const svg = Buffer.from(svgAsset.p.split(",")[1], "base64").toString("utf8");
  assert.ok(svg.includes(`width="${svgAsset.w}" height="${svgAsset.h}"`));
  assert.ok(svg.includes(vector), "the sanitized drawing is preserved inside its exact asset viewport");
  assert.equal(result.warnings.filter((warning) => warning.code === "lottie-svg-color-glyphs").length, 1,
    "the user is told that their player must support SVG images");
  const imageIds = new Set(imageAssets.map((asset) => asset.id));
  assert.ok(imageLayers.every((layer) => imageIds.has(layer.refId)));

  const paletteGroups = [];
  const outlineGroups = [];
  const strokes = [];
  walk(animation.assets, (value) => {
    if (value.ty === "gr" && value.nm === "Chromatic Palette") paletteGroups.push(value);
    if (value.ty === "gr" && value.nm === "Chromatic Glyph") {
      outlineGroups.push(value);
      strokes.push(...(value.it ?? []).filter((item) => item.ty === "st"));
    }
  });
  assert.equal(paletteGroups.length, 2, "both palette paints stay as native vector groups");
  assert.ok(paletteGroups.every((group) => !(group.it ?? []).some((item) => item.ty === "st")),
    "palette glyphs ignore the text layer stroke");
  const paletteFills = paletteGroups.map((group) => group.it.find((item) => item.ty === "fl")?.c?.k);
  assert.deepEqual(paletteFills, [[0.8862745098039215, 0.30196078431372547, 0.25882352941176473], [0.1411764705882353, 0.4196078431372549, 0.5764705882352941]],
    "palette colors retain font order and do not inherit the text fill");
  assert.ok(strokes.length > 0, "ordinary outline glyphs retain the text stroke");
  assert.ok(outlineGroups.some((group) => group.it.some((item) => item.ty === "fl" &&
    item.c.k[0] < 0.1 && item.c.k[1] < 0.15 && item.c.k[2] < 0.2)),
    "ordinary outline glyphs retain the text fill");

  const localUnit = animation.assets.find((asset) => {
    const direct = asset.layers ?? [];
    return direct.some((layer) => layer.ty === 2 && layer.nm?.includes(":image image")) &&
      direct.some((layer) => layer.ty === 4 || (layer.ty === 0 && layer.nm?.includes("vector glyphs")));
  });
  assert.ok(localUnit, "all glyph drawings are composed in one local text unit");
  assert.ok(localUnit.w > text.width, "the local unit domain includes the overhanging palette path");
  assert.ok(layers.some((layer) => layer.tt === 3), "the local color unit remains inside its scene mask");
  const effected = layers.find((layer) => layer.ef?.some((effect) => effect.ty === 25) && layer.ef?.some((effect) => effect.ty === 29));
  assert.ok(effected, "one outer text unit composition owns both shadow and blur");
  assert.equal(effected.ks.o.k, 62, "the color paths and images share the text unit opacity");
});

test("centered and middle-aligned color glyphs keep their original position without effects", async () => {
  const fonts = await colorFontRegistry();
  const text = createLayer("text", {
    id: "centered-color", name: "Centered", x: 24, y: 20, width: 220, height: 112,
    text: "C", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal", fontSize: 44,
    textAlign: "center", verticalAlign: "middle", textResize: "fixed", fill: "#17202b",
    stroke: "none", strokeWidth: 0, animations: [],
  });
  const scene = createScene({
    id: "centered-color-scene", name: "Centered color glyph", width: 320, height: 180,
    duration: 1, background: "transparent", layers: [text],
  });
  const glyph = textUnits(layoutText(text, fonts), "layer")[0].glyphs.find((item) => item.color?.kind === "image");
  const expectedGlyphBox = glyphDrawBounds(glyph);
  const result = await exportScene(scene, { format: "lottie", fps: 2 }, { fonts });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const wrapper = animation.layers.find((layer) => layer.nm === "Centered 1");
  assert.ok(wrapper?.ty === 0, "the colored unit is a local composition");
  const asset = animation.assets.find((item) => item.id === wrapper.refId);
  const image = asset.layers.find((layer) => layer.ty === 2);
  const actual = applyMatrix(lottieTransformMatrix(wrapper.ks), image.ks.p.k);
  assert.ok(Math.abs(actual[0] - (text.x + expectedGlyphBox.x)) < 1e-6,
    `centered glyph x should match the renderer: expected ${text.x + expectedGlyphBox.x}, received ${actual[0]}`);
  assert.ok(Math.abs(actual[1] - (text.y + expectedGlyphBox.y)) < 1e-6,
    `middle-aligned glyph y should match the renderer: expected ${text.y + expectedGlyphBox.y}, received ${actual[1]}`);
});
