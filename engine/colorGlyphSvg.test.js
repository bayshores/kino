import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { createColorGlyphSvgSanitizer, sanitizeColorGlyphSvg } from "./colorGlyphSvg.js";

const NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const METRICS = { unitsPerEm: 1024, ascent: 950, descent: -250, advanceWidth: 1275 };

function svg(body, rootAttributes = "") {
  return '<svg xmlns="' + NS + '" xmlns:xlink="' + XLINK + '" version="1.1" ' + rootAttributes + ">" + body + "</svg>";
}

function getIds(source) {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const ids = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute("id")) ids.push(node.getAttribute("id"));
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(document.documentElement);
  return ids;
}

test("selects one glyph and preserves only its transitive local definitions", () => {
  const source = svg(
    '<defs>' +
      '<linearGradient id="paint" gradientTransform="rotate(12)">' +
        '<stop offset="0%" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/>' +
      '</linearGradient>' +
      '<path id="shape" d="M0 0L20 0L20 20Z"/>' +
      '<path id="unrelatedDefinition" d="M3 3L4 4"/>' +
    '</defs>' +
    '<g transform="translate(4 8)">' +
      '<g id="glyph3"><use xlink:href="#shape" fill="url(#paint)" transform="scale(2)"/></g>' +
      '<g id="glyph4"><path id="otherGlyphPath" d="M0 0L1 1"/></g>' +
    '</g>',
  );

  const result = sanitizeColorGlyphSvg(source, 3, METRICS);
  assert.deepEqual(
    { x: result.x, y: result.y, width: result.width, height: result.height },
    { x: 0, y: -950, width: 1275, height: 1200 },
  );
  assert.match(result.svg, /viewBox="0 -950 1275 1200"/u);
  assert.match(result.svg, /transform="translate\(4 8\)"/u);
  assert.match(result.svg, /gradientTransform="rotate\(12\)"/u);
  assert.match(result.svg, /xlink:href="#shape"/u);
  assert.ok(getIds(result.svg).includes("glyph3"));
  assert.ok(getIds(result.svg).includes("shape"));
  assert.ok(getIds(result.svg).includes("paint"));
  assert.ok(!getIds(result.svg).includes("glyph4"));
  assert.ok(!getIds(result.svg).includes("otherGlyphPath"));
  assert.ok(!getIds(result.svg).includes("unrelatedDefinition"));
});

test("parses a font SVG once and returns independent descriptors for requested glyphs", () => {
  const source = svg(
    '<g id="glyph1"><path d="M0 0L10 10Z"/></g>' +
    '<g id="glyph2"><circle cx="2" cy="3" r="1"/></g>',
  );
  const sanitize = createColorGlyphSvgSanitizer(source);
  const first = sanitize(1, METRICS);
  const second = sanitize(2, { ...METRICS, advanceWidth: 600 });
  assert.match(first.svg, /id="glyph1"/u);
  assert.match(second.svg, /id="glyph2"/u);
  assert.equal(second.width, 600);
  assert.ok(!first.svg.includes('id="glyph2"'));
});

test("keeps simple shapes, clip paths, gradients, and use references", () => {
  const source = svg(
    '<defs><clipPath id="clip"><rect x="0" y="0" width="9" height="8"/></clipPath>' +
      '<radialGradient id="shade" cx="50%" cy="50%" r="50%">' +
        '<stop offset="0" stop-color="white"/><stop offset="1" stop-color="#000000"/>' +
      '</radialGradient><path id="piece" d="M0 0L2 2Z"/></defs>' +
    '<g id="glyph8" clip-path="url(#clip)"><use href="#piece" fill="url(#shade)"/><circle cx="2" cy="3" r="1"/></g>',
  );
  const result = sanitizeColorGlyphSvg(source, 8, METRICS);
  for (const expected of ["<clipPath", "<rect", "<radialGradient", "<stop", "<path", "<use", "<circle"])
    assert.ok(result.svg.includes(expected), "missing " + expected);
});

test("rejects root viewport overrides rather than silently changing font-space geometry", () => {
  for (const attributes of ['viewBox="0 0 100 100"', 'width="100"', 'height="100"', 'preserveAspectRatio="none"']) {
    assert.throws(
      () => sanitizeColorGlyphSvg(svg('<g id="glyph1"><path d="M0 0L1 1Z"/></g>', attributes), 1, METRICS),
      /root .* changes the SVG viewport/u,
    );
  }
});

test("rejects active content, CSS, external references, malformed XML, and unsupported paint", () => {
  const unsafe = [
    '<!DOCTYPE svg [<!ENTITY x "bad">]><svg xmlns="' + NS + '"><g id="glyph1"/></svg>',
    svg('<script>alert(1)</script><g id="glyph1"><path d="M0 0L1 1Z"/></g>'),
    svg('<foreignObject><div/></foreignObject><g id="glyph1"/>'),
    svg('<g id="glyph1" onload="alert(1)"/>'),
    svg('<g id="glyph1" style="fill:red"/>'),
    svg('<g id="glyph1"><use href="https://example.com/a.svg#x"/></g>'),
    svg('<defs><linearGradient id="paint"><stop/><stop/></linearGradient></defs><g id="glyph1"><path d="M0 0" fill="url(https://example.test/x)"/></g>'),
    svg('<g id="glyph1"><path filter="url(#x)" d="M0 0L1 1Z"/></g>'),
  ];
  for (const source of unsafe) assert.throws(() => sanitizeColorGlyphSvg(source, 1, METRICS), /Unsafe color glyph SVG/u);
  assert.throws(
    () => sanitizeColorGlyphSvg('<svg xmlns="' + NS + '"><g id="glyph1"></svg>', 1, METRICS),
    /invalid XML/u,
  );
});

test("rejects missing references, resource cycles, and references to a different glyph", () => {
  const missing = svg('<g id="glyph1"><use href="#missing"/></g>');
  assert.throws(() => sanitizeColorGlyphSvg(missing, 1, METRICS), /reference #missing does not exist/u);

  const cycle = svg(
    '<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>' +
    '<g id="glyph1"><path d="M0 0L1 1Z" fill="url(#a)"/></g>',
  );
  assert.throws(() => sanitizeColorGlyphSvg(cycle, 1, METRICS), /cyclic reference/u);

  const glyphReference = svg(
    '<g id="glyph1"><use href="#glyph2"/></g><g id="glyph2"><path d="M0 0L1 1Z"/></g>',
  );
  assert.throws(() => sanitizeColorGlyphSvg(glyphReference, 1, METRICS), /glyphs cannot be dependencies/u);
});

test("enforces source size, tree depth, element count, and dependency closure limits", () => {
  assert.throws(
    () => createColorGlyphSvgSanitizer(svg('<g id="glyph1"/>') + " ".repeat(8 * 1024 * 1024)),
    /source exceeds/u,
  );

  const nested = '<g>'.repeat(65) + '<g id="glyph1"/>' + "</g>".repeat(65);
  assert.throws(() => createColorGlyphSvgSanitizer(svg(nested)), /nesting exceeds/u);

  const many = '<g id="glyph1"/>' + "<path/>".repeat(100_000);
  assert.throws(() => createColorGlyphSvgSanitizer(svg(many)), /more than 100000 elements/u);

  const manyDependencies = '<defs><g id="definition">' + "<path/>".repeat(2_050) +
    '</g></defs><g id="glyph1"><use href="#definition"/></g>';
  assert.throws(
    () => sanitizeColorGlyphSvg(svg(manyDependencies), 1, METRICS),
    /dependency closure exceeds 2048/u,
  );
});

test("accepts a large shared SVG document while keeping the selected glyph output compact", () => {
  const inertComment = "unused shared font definitions ".repeat(80_000);
  const unrelated = '<defs><!--' + inertComment + '--><path id="unused" d="M0 0L1 1Z"/></defs>';
  const source = svg(unrelated + '<g id="glyph21"><path d="M0 0L10 10Z"/></g>');
  assert.ok(Buffer.byteLength(source) > 2 * 1024 * 1024);

  const result = sanitizeColorGlyphSvg(source, 21, METRICS);
  assert.ok(Buffer.byteLength(result.svg) < 2_000);
  assert.match(result.svg, /id="glyph21"/u);
  assert.ok(!result.svg.includes("unused shared font definitions"));
  assert.ok(!result.svg.includes('id="unused"'));
});

test("validates metrics before producing a descriptor", () => {
  const source = svg('<g id="glyph1"><path d="M0 0L1 1Z"/></g>');
  for (const metrics of [
    { ...METRICS, unitsPerEm: 0 },
    { ...METRICS, ascent: Number.NaN },
    { ...METRICS, descent: 1000 },
    { ...METRICS, advanceWidth: -1 },
  ]) {
    assert.throws(() => sanitizeColorGlyphSvg(source, 1, metrics), /metrics\.|font metrics/u);
  }
});
