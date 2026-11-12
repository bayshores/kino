import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { worldMatrix, point, multiply } from "./geometry.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { parsePath, pathBounds } from "./vectorPath.js";
import { importSvg, moveRootLayers } from "./svgImport.js";
import { traceImage, traceSvg } from "./traceImage.js";
import { renderSceneSvg } from "./render.js";
import { Resvg } from "@resvg/resvg-js";

function parse(svg, options = {}) {
  return importSvg(svg, { DOMParser, ...options });
}

function byName(result, name) {
  const layer = result.layers.find((item) => item.name === name);
  assert.ok(layer, `expected layer named ${name}`);
  return layer;
}

function translation(x, y) {
  return [1, 0, 0, 1, x, y];
}

function scaling(x, y) {
  return [x, 0, 0, y, 0, 0];
}

test("imports nested groups, preserving order and nested nonuniform transforms", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <g id="outer" transform="translate(20 10) scale(2 3)">
      <rect id="first" x="4" y="5" width="6" height="7" />
      <g id="inner" transform="rotate(90 2 2)">
        <rect id="second" x="1" y="0" width="2" height="3" />
      </g>
    </g>
  </svg>`);

  const outer = byName(result, "outer");
  const first = byName(result, "first");
  const inner = byName(result, "inner");
  const second = byName(result, "second");
  assert.equal(outer.type, "group");
  assert.equal(inner.type, "group");
  assert.equal(first.parentId, outer.id);
  assert.equal(inner.parentId, outer.id);
  assert.equal(second.parentId, inner.id);
  assert.deepEqual(
    result.layers.map((layer) => layer.name),
    ["outer", "first", "inner", "second"],
    "layers stay in the SVG's back-to-front source order",
  );

  const layers = result.layers;
  const firstWorld = worldMatrix(first, layers);
  const secondWorld = worldMatrix(second, layers);
  const outerTransform = multiply(translation(20, 10), scaling(2, 3));
  const innerTransform = [0, 1, -1, 0, 4, 0]; // rotate(90 2 2)
  assert.deepEqual(point(firstWorld, 0, 0), point(multiply(outerTransform, translation(4, 5)), 0, 0));
  assert.deepEqual(
    point(secondWorld, 0, 0),
    point(multiply(outerTransform, multiply(innerTransform, translation(1, 0))), 0, 0),
  );
});

test("applies the SVG viewBox origin and preserveAspectRatio viewport mapping", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px" viewBox="10 20 100 100">
    <rect id="origin" x="10" y="20" width="10" height="10" />
  </svg>`);
  const origin = byName(result, "origin");
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
  assert.deepEqual(point(worldMatrix(origin, result.layers), 0, 0), { x: 50, y: 0 });
});

test("inherits presentation styles, then applies inline styles and paint opacity", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60">
    <g id="styled" fill="rgb(255, 0, 0)" stroke="rebeccapurple" stroke-width="2" opacity="0.5">
      <rect id="inline" x="2" y="3" width="20" height="10"
        style="fill: rgba(0,128,0,0.5); fill-opacity: 0.5; stroke: #0000ff; stroke-opacity: 25%" />
      <ellipse id="inherited" cx="50" cy="30" rx="10" ry="8" />
    </g>
  </svg>`);
  const group = byName(result, "styled");
  const inline = byName(result, "inline");
  const inherited = byName(result, "inherited");
  assert.equal(group.opacity, 0.5);
  assert.equal(inline.fill, "#00800040");
  assert.equal(inline.stroke, "#0000ff40");
  assert.equal(inline.strokeWidth, 2);
  assert.equal(inherited.fill, "#ff0000ff");
  assert.equal(inherited.stroke, "#663399ff");
});

test("imports path fill rules from attributes, inline styles, and inherited group styles", () => {
  const ring = "M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z";
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <g id="inherited-group" style="fill-rule:evenodd">
      <path id="inherited-rule" d="${ring}" />
      <path id="attribute-rule" d="${ring}" fill-rule="nonzero" />
      <path id="inline-rule" d="${ring}" fill-rule="nonzero" style="fill-rule: EVENODD" />
      <path id="invalid-rule" d="${ring}" fill-rule="unsupported" />
    </g>
    <path id="default-rule" d="${ring}" />
  </svg>`);
  assert.equal(byName(result, "inherited-rule").fillRule, "evenodd");
  assert.equal(byName(result, "attribute-rule").fillRule, "nonzero");
  assert.equal(byName(result, "inline-rule").fillRule, "evenodd", "inline style takes precedence over the presentation attribute");
  assert.equal(byName(result, "invalid-rule").fillRule, "evenodd", "an invalid child value falls back to the inherited value");
  assert.equal(byName(result, "default-rule").fillRule, "nonzero");
  assert.equal(result.layers.filter((layer) => layer.type === "path").length, 5, "one SVG path element remains one layer");
  assert.equal(result.warnings.filter((warning) => /fill-rule values other than/.test(warning)).length, 1);
});

test("an imported same-winding even-odd ring saves, reloads, and renders with a transparent hole", () => {
  const ring = "M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z";
  const imported = byName(parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <path id="ring" d="${ring}" fill="#00aa44" fill-rule="evenodd" />
  </svg>`), "ring");
  const contours = parsePath(imported.path);
  assert.equal(contours.length, 2);
  assert.deepEqual(contours.map((contour) => contour.closed), [true, true]);
  const area = (contour) => {
    const points = [contour.start, ...contour.segments.map((segment) => segment.end)];
    return points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;
  };
  assert.ok(area(contours[0]) * area(contours[1]) > 0, "normalization preserves the two contours' shared winding");

  const document = parseDocument(createDocument({
    scenes: [createScene({ id: "imported", width: 100, height: 100, layers: [imported] })],
  }));
  const saved = parseDocument(JSON.stringify(document));
  const layer = saved.scenes[0].layers[0];
  assert.equal(layer.fillRule, "evenodd");
  assert.equal(parsePath(layer.path).length, 2);
  const pixels = new Resvg(renderSceneSvg(saved.scenes[0])).render().pixels;
  const pixel = (x, y) => [...pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
  assert.deepEqual(pixel(15, 15), [0, 170, 68, 255], "the imported outer contour renders");
  assert.deepEqual(pixel(50, 50), [255, 255, 255, 255], "the imported inner contour renders as a hole");
});

test("imports common shapes, text, and a representable gradient", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
    <defs><linearGradient id="fade"><stop offset="0" stop-color="red"/><stop offset="100%" style="stop-color: blue; stop-opacity: .5"/></linearGradient></defs>
    <rect id="box" x="4" y="5" width="40" height="20" rx="5" fill="url(#fade)" />
    <circle id="dot" cx="80" cy="30" r="12" />
    <ellipse id="oval" cx="120" cy="30" rx="18" ry="10" />
    <line id="line" x1="5" y1="70" x2="45" y2="90" stroke="navy" />
    <polygon id="tri" points="60,60 90,60 75,90" />
    <polyline id="zig" points="100,60 120,80 140,60" fill="none" stroke="black" />
    <path id="curve" d="M 160 60 C 170 50 180 90 190 80" />
    <text id="label" x="5" y="115" font-size="12" fill="orange">Go</text>
  </svg>`);
  assert.equal(byName(result, "box").fill.type, "linear");
  assert.deepEqual(byName(result, "box").fill.stops, [
    { offset: 0, color: "#ff0000ff" },
    { offset: 1, color: "#0000ff80" },
  ]);
  assert.equal(byName(result, "dot").type, "ellipse");
  assert.equal(byName(result, "oval").width, 36);
  assert.match(byName(result, "line").path, /^M 0 0 L 40 20$/);
  assert.match(byName(result, "tri").path, /Z$/);
  assert.equal(byName(result, "label").type, "text");
  assert.equal(byName(result, "label").text, "Go");
  const curve = byName(result, "curve");
  const curveBounds = pathBounds("M 160 60 C 170 50 180 90 190 80");
  assert.equal(curve.width, curveBounds.width);
  assert.equal(curve.height, curveBounds.height);
  assert.equal(curve.pathBounds.width, curveBounds.width);
  assert.equal(curve.pathBounds.height, curveBounds.height);
  assert.ok(Math.abs(pathBounds(curve.path).x) < 1e-8);
  assert.ok(Math.abs(pathBounds(curve.path).y) < 1e-8);
  const document = createDocument();
  document.scenes[0] = {
    ...document.scenes[0],
    width: result.width,
    height: result.height,
    layers: result.layers,
  };
  assert.doesNotThrow(() => parseDocument(document), "imported layers satisfy kino's saved-document schema");
});

test("fill=\"none\" and lines import with the Fill turned off, keeping a visible paint to turn back on", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <polygon id="outline" points="10,10 90,10 90,90 10,90" fill="none" stroke="black" />
    <line id="rule" x1="5" y1="95" x2="95" y2="95" stroke="navy" />
    <g fill="NONE"><rect id="inherited" x="0" y="0" width="10" height="10" stroke="red" /></g>
    <text id="hollow" x="5" y="50" font-size="12" fill="none" stroke="black">Go</text>
    <rect id="solid" x="0" y="0" width="10" height="10" fill="#ff0000" />
    <rect id="clear" x="0" y="0" width="10" height="10" fill="transparent" />
  </svg>`);
  for (const name of ["outline", "rule", "inherited", "hollow"]) {
    const layer = byName(result, name);
    assert.equal(layer.fillEnabled, false, `${name}: the Enable fill box is off`);
    assert.equal(layer.fill, "#000000", `${name}: the kept paint is SVG's initial black`);
  }
  assert.equal(byName(result, "solid").fillEnabled, true);
  assert.match(byName(result, "solid").fill, /^#ff0000/);
  // "transparent" is a color in SVG, not "no fill": it stays a 0% alpha paint with the box on.
  assert.equal(byName(result, "clear").fillEnabled, true);
  assert.equal(byName(result, "clear").fill, "#00000000");
  const document = createDocument();
  document.scenes[0] = { ...document.scenes[0], width: result.width, height: result.height, layers: result.layers };
  assert.doesNotThrow(() => parseDocument(document), "imported layers satisfy kino's saved-document schema");

  const centerPixel = (layer) => {
    const svg = renderSceneSvg({ width: 100, height: 100, background: "#ffffff", layers: [layer] });
    return [...new Resvg(svg).render().pixels.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)];
  };
  const outline = byName(result, "outline");
  assert.deepEqual(centerPixel(outline), [255, 255, 255, 255], "nothing is drawn inside, as in the SVG");
  assert.deepEqual(centerPixel({ ...outline, fillEnabled: true }), [0, 0, 0, 255], "turning the fill on fills it");
});

test("normalizes paths to exact cubic-extrema bounds without shifting transformed geometry", () => {
  const sourcePath = "M 20 30 C 120 130 120 -70 20 30";
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="10 20 100 100" preserveAspectRatio="none">
    <g id="offset" transform="translate(10 15) scale(2 3)"><path id="curve" d="${sourcePath}" /></g>
  </svg>`);
  const group = byName(result, "offset");
  const path = byName(result, "curve");
  const bounds = pathBounds(sourcePath);
  assert.ok(Math.abs(bounds.width - 75) < 1e-8);
  assert.ok(Math.abs(bounds.height - 100 / Math.sqrt(3)) < 1e-8);
  assert.ok(bounds.width < 100, "cubic control points outside the curve do not enlarge its bounds");
  assert.ok(bounds.height < 200);
  assert.ok(Math.abs(path.width - bounds.width) < 1e-8);
  assert.ok(Math.abs(path.height - bounds.height) < 1e-8);
  assert.ok(Math.abs(pathBounds(path.path).x) < 1e-8);
  assert.ok(Math.abs(pathBounds(path.path).y) < 1e-8);
  const firstPoint = parsePath(path.path)[0].start;
  const importedPoint = point(worldMatrix(path, result.layers), ...firstPoint);
  assert.ok(Math.abs(importedPoint.x - 48) < 1e-8);
  assert.ok(Math.abs(importedPoint.y - 68) < 1e-8);
  assert.equal(path.parentId, group.id);
  assert.ok(!result.warnings.some((warning) => warning.includes("viewBox size as editable bounds")));
});

test("keeps degenerate path resize bounds at least one unit wide and high", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path id="point" d="M 3 4 L 3 4" /></svg>`);
  const path = byName(result, "point");
  assert.equal(path.width, 1);
  assert.equal(path.height, 1);
  assert.deepEqual(path.pathBounds, { width: 1, height: 1 });
  assert.deepEqual(pathBounds(path.path), { x: 0, y: 0, width: 0, height: 0 });
});

test("rejects malformed, executable, linked, and unsupported SVG constructs", () => {
  const cases = [
    ["malformed XML", "<svg><rect></svg>", /malformed/i],
    ["script", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`, /<script>/],
    ["event attribute", `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onload="alert(1)"/></svg>`, /event attribute/i],
    ["external image", `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>`, /<image>/i],
    ["use reference", `<svg xmlns="http://www.w3.org/2000/svg"><use href="#shape"/></svg>`, /<use>/i],
    ["foreignObject", `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`, /<foreignObject>/],
    ["clip path", `<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"/></defs><rect width="1" height="1" clip-path="url(#clip)"/></svg>`, /<clipPath>/],
    ["external entity declaration", `<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`, /DOCTYPE/i],
    ["user-space gradient", `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop/><stop offset="1"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`, /userSpaceOnUse/],
    ["gradient stroke", `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop/><stop offset="1"/></linearGradient></defs><rect width="10" height="10" stroke="url(#g)"/></svg>`, /gradient strokes/i],
    ["malformed path", `<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L"/></svg>`, /coordinates/i],
  ];
  for (const [label, source, pattern] of cases) {
    assert.throws(() => parse(source), pattern, label);
  }
});

test("bounds source size, element count, and geometry list size", () => {
  assert.throws(
    () => parse(`<svg>${" ".repeat(10 * 1024 * 1024)}</svg>`),
    /exceeds 10 MB/i,
  );
  const manyElements = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect width='1' height='1'/>".repeat(20_001)}</svg>`;
  assert.throws(() => parse(manyElements), /more than 20000 elements/i);
  assert.throws(
    () => parse(`<svg xmlns="http://www.w3.org/2000/svg"><polyline points="${"0,0 ".repeat(10_001)}"/></svg>`),
    /coordinate values/i,
  );
});

test("imports nested tspan font styles as normalized UTF-16 text ranges", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60">
    <text id="rich" x="4" y="32" font-family="Arial" font-size="20px" font-weight="400" fill="#101010">
      A<tspan font-family="Georgia" font-size="24px" font-weight="700" font-style="italic" letter-spacing="1px">bold <tspan fill="#e02030">red</tspan><tspan> bold</tspan></tspan>Z
    </text>
  </svg>`);
  const text = byName(result, "rich");
  const raw = text.text;
  const firstBold = raw.indexOf("bold");
  const red = raw.indexOf("red");
  const finalBold = raw.lastIndexOf("bold");
  assert.equal(text.fontFamily, "Arial");
  assert.equal(text.fontWeight, 400);
  assert.equal(text.fontStyle, "normal");
  assert.equal(text.fontSource, "");
  assert.equal(text.fontSize, 20);
  assert.ok(Array.isArray(text.textStyleRanges));
  assert.deepEqual(text.textStyleRanges.map(({ start, end }) => [start, end]), [
    [firstBold, red], [red, red + 3], [finalBold - 1, finalBold + 4],
  ]);
  assert.equal(text.textStyleRanges[0].style.fontWeight, 700);
  assert.equal(text.textStyleRanges[0].style.fontFamily, "Georgia");
  assert.equal(text.textStyleRanges[0].style.fontSize, 24);
  assert.equal(text.textStyleRanges[0].style.fontStyle, "italic");
  assert.ok(Math.abs(text.textStyleRanges[0].style.letterSpacing - 100 / 24) < 1e-9);
  assert.equal(Object.hasOwn(text.textStyleRanges[0].style, "fontSource"), false, "SVG styling never adds an external font source");
  assert.equal(text.textStyleRanges[1].style.fontWeight, 700, "nested fill styling inherits the parent span's weight");
  assert.equal(text.textStyleRanges[1].style.fill, "#e02030ff");
  assert.equal(text.textStyleRanges[2].style.fontWeight, 700, "an unstyled nested span inherits its parent span");
  assert.ok(!result.warnings.some((warning) => /styled <tspan> text is flattened/i.test(warning)));

  const document = parseDocument(createDocument({
    scenes: [createScene({ id: "svg", width: result.width, height: result.height, layers: [text] })],
  }));
  assert.deepEqual(document.scenes[0].layers[0].textStyleRanges, text.textStyleRanges,
    "the ranges survive the actual saved-document normalizer");
});

test("keeps tspan solid and local-gradient fills through SVG paint parsing", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60">
    <defs><linearGradient id="ink"><stop offset="0" stop-color="#0044aa"/><stop offset="100%" stop-color="#00cc88"/></linearGradient></defs>
    <text id="paint" x="2" y="30" font-size="18px" fill="#111111">A<tspan fill="#cc2200">solid</tspan><tspan fill="url(#ink)">gradient</tspan></text>
  </svg>`);
  const text = byName(result, "paint");
  const solid = text.text.indexOf("solid");
  const gradient = text.text.indexOf("gradient");
  assert.equal(text.textStyleRanges.length, 2);
  assert.deepEqual(text.textStyleRanges.map(({ start, end }) => [start, end]), [
    [solid, solid + 5], [gradient, gradient + 8],
  ]);
  assert.equal(text.textStyleRanges[0].style.fill, "#cc2200ff");
  assert.deepEqual(text.textStyleRanges[1].style.fill, {
    type: "linear", angle: 0,
    stops: [{ offset: 0, color: "#0044aaff" }, { offset: 1, color: "#00cc88ff" }],
  });
  assert.doesNotThrow(() => parseDocument(createDocument({
    scenes: [createScene({ id: "svg", width: result.width, height: result.height, layers: [text] })],
  })));
});

test("keeps tspan fill overrides visible when the text layer's base fill is none", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg"><text id="mixed-fill" fill="none">hidden <tspan fill="#cc2200">visible</tspan></text></svg>`);
  const text = byName(result, "mixed-fill");
  assert.equal(text.fillEnabled, true, "one layer-level fill switch must allow the styled range to render");
  assert.equal(text.fill, "#00000000", "unranged text stays visually unfilled");
  assert.equal(text.textStyleRanges[0].style.fill, "#cc2200ff");
});

test("keeps importer style boundaries on grapheme edges when a span splits a combining mark", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg"><text id="cluster">e<tspan fill="#cc2200">\u0301</tspan>!</text></svg>`);
  const text = byName(result, "cluster");
  assert.equal(text.text, "e\u0301!");
  assert.equal(text.textStyleRanges, undefined, "the mark cannot be styled independently from its base character");
  assert.ok(result.warnings.some((warning) => /style boundary inside a grapheme is applied to the whole grapheme/i.test(warning)));
});

test("flattens tspan positions with an explicit warning while retaining supported character styles", () => {
  const result = parse(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60">
    <text id="positioned" x="5" y="32" font-size="18px">start<tspan x="80" dx="3" font-style="italic">moved</tspan>end</text>
  </svg>`);
  const text = byName(result, "positioned");
  const moved = text.text.indexOf("moved");
  assert.equal(text.text, "startmovedend");
  assert.equal(text.textStyleRanges.length, 1);
  assert.deepEqual([text.textStyleRanges[0].start, text.textStyleRanges[0].end], [moved, moved + 5]);
  assert.equal(text.textStyleRanges[0].style.fontStyle, "italic");
  assert.ok(result.warnings.some((warning) => /Positioned <tspan> text is flattened.*character positions are not preserved/i.test(warning)));
  assert.throws(() => parse(`<svg xmlns="http://www.w3.org/2000/svg"><text font-family="url(https://example.invalid/font.woff2)">blocked</text></svg>`), /font URL references are unsupported/i);
});

test("a dropped SVG moves its top-level layers and keeps children relative to their group", () => {
  const group = createLayer("group", { id: "g", x: 10, y: 20 });
  const child = createLayer("path", { id: "c", parentId: "g", x: 5, y: 5 });
  const loose = createLayer("rectangle", { id: "r", x: 0, y: 0 });
  const moved = moveRootLayers([group, child, loose], 100, -10);
  assert.deepEqual(moved.map((layer) => [layer.id, layer.x, layer.y]), [["g", 110, 10], ["c", 5, 5], ["r", 100, -10]]);
  assert.equal(group.x, 10, "the imported layers are not changed in place");
  assert.equal(moveRootLayers([group], 0, 0)[0], group);
});

test("traceImage turns flat color regions into paths, largest first, with background holes and a colors hint for photos", () => {
  // 40x30: gray ground, a black ring (16x16 hole showing the ground), a small red square.
  const width = 40, height = 30, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const ring = x >= 2 && x < 26 && y >= 2 && y < 26 && !(x >= 6 && x < 22 && y >= 6 && y < 22);
    const red = x >= 30 && x < 38 && y >= 10 && y < 18;
    data.set(ring ? [0, 0, 0, 255] : red ? [220, 20, 20, 255] : [200, 200, 200, 255], (y * width + x) * 4);
  }
  const traced = traceImage(data, width, height, { colors: 3, scale: 2 });
  assert.equal(traced.background, "#c8c8c8");
  assert.deepEqual(traced.paths.map((path) => path.color), ["#000000", "#dc1414"]);
  assert.equal(traced.paths[0].d.match(/M/g).length, 2, "the ring keeps its hole");
  assert.ok(traced.paths[0].area > traced.paths[1].area);
  assert.equal(traced.suggest, null);
  const bounds = pathBounds(traced.paths[1].d);
  assert.ok(Math.abs(bounds.x - 60) < 2 && Math.abs(bounds.width - 16) < 2, "scale maps the red square to output pixels");
  const layers = parse(traceSvg(traced, 80, 60, { name: "mark" })).layers;
  assert.deepEqual(layers.map((layer) => layer.type), ["group", "path", "path"]);
  assert.equal(layers[1].fillRule, "evenodd");
  // Noise does not read as flat art: the hint says so.
  const noise = new Uint8ClampedArray(width * height * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 251));
  assert.ok(traceImage(noise, width, height, { colors: 2 }).suggest !== null);
});

test("traceImage's auto ground skips letterbox bars: the gray card is the ground, the black word is kept, the bars are dropped", () => {
  const width = 40, height = 30, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dark = y < 4 || y >= 26 || (x >= 14 && x < 26 && y >= 12 && y < 18);
    data.set(dark ? [0, 0, 0, 255] : [220, 220, 220, 255], (y * width + x) * 4);
  }
  const traced = traceImage(data, width, height, { colors: 2 });
  assert.equal(traced.background, "#dcdcdc");
  assert.equal(traced.paths.length, 1);
  assert.ok(Math.abs(traced.paths[0].area - 72) < 8, `only the word is left: ${traced.paths[0].area}`);
  assert.equal(traceImage(data, width, height, { colors: 2, background: "#dcdcdc" }).paths.length, 3, "a named ground keeps the bars");
});
