import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { DOMParser } from "@xmldom/xmldom";
import { clipEffect, copiesEffect, copyContent, copySource, filterEffect } from "./svg.js";

function frame({ content = '<path id="source" d="M0 0h10v10z"/>', bounds = { x: 10, y: 20, width: 20, height: 30 }, paintBounds, includeBounds, ids } = {}) {
  let next = 0;
  const defs = [];
  return {
    content,
    bounds,
    ...(paintBounds ? { paintBounds } : {}),
    parameters: {},
    time: 0,
    progress: 0.5,
    helpers: { id: (kind) => ids?.[next++] ?? `${kind}-${++next}`, defs, ...(includeBounds ? { includeBounds } : {}) },
  };
}

function parseSvg(markup, defs = []) {
  const errors = [];
  const parser = new DOMParser({ onError: (_level, message) => errors.push(message) });
  const document = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><defs>${defs.join("")}</defs>${markup}</svg>`, "image/svg+xml");
  assert.deepEqual(errors, []);
  return document;
}

test("filterEffect adds a unique user-space sRGB filter with a padded region", () => {
  const target = frame();
  const first = filterEffect(target, '<feGaussianBlur stdDeviation="2"/>', { padding: 3 });
  const second = filterEffect(target, ['<feOffset dx="1"/>', '<feBlend in="SourceGraphic"/>']);
  assert.equal(target.helpers.defs.length, 2);
  assert.match(target.helpers.defs[0], /filterUnits="userSpaceOnUse"/);
  assert.match(target.helpers.defs[0], /primitiveUnits="userSpaceOnUse"/);
  assert.match(target.helpers.defs[0], /color-interpolation-filters="sRGB"/);
  assert.match(target.helpers.defs[0], /x="7" y="17" width="26" height="36"/);
  assert.match(first, /filter=/);
  assert.match(second, /filter=/);
  assert.notEqual(target.helpers.defs[0].match(/id="([^"]+)/)?.[1], target.helpers.defs[1].match(/id="([^"]+)/)?.[1]);
  assert.equal(parseSvg(`${first}${second}`, target.helpers.defs).getElementsByTagName("filter").length, 2);
});

test("filter and clip IDs from helpers are escaped as XML and CSS references", () => {
  const target = frame({ ids: ['bad" onload="run'] });
  const markup = filterEffect(target, "<feOffset dx=\"0\"/>");
  const document = parseSvg(markup, target.helpers.defs);
  const filter = document.getElementsByTagName("filter")[0];
  const group = document.getElementsByTagName("g")[0];
  assert.equal(filter.getAttribute("id"), 'bad" onload="run');
  assert.equal(filter.hasAttribute("onload"), false);
  assert.equal(group.hasAttribute("onload"), false);
  assert.match(group.getAttribute("filter"), /^url\(#/);
  assert.ok(target.helpers.defs[0].includes("&quot;"), "ID quote is XML escaped in the definition");
});

test("safe unquoted filter references apply a visible SVG blur in Resvg", () => {
  const target = frame({
    content: '<rect x="6" y="6" width="4" height="4" fill="#ff0000"/>',
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  const effect = filterEffect(target, '<feGaussianBlur stdDeviation="2"/>');
  assert.match(effect, /filter="url\(#filter-\d+\)"/);
  const render = (markup) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs>${target.helpers.defs.join("")}</defs>${markup}</svg>`).render().pixels;
  const plainPixels = render(target.content);
  const filteredPixels = render(effect);
  let changedPixels = 0;
  for (let offset = 0; offset < plainPixels.length; offset += 4)
    if (plainPixels[offset] !== filteredPixels[offset] || plainPixels[offset + 3] !== filteredPixels[offset + 3]) changedPixels += 1;
  assert.ok(changedPixels > 0, "the filter URL resolves to the generated filter definition");
});

test("native source normalization preserves the first primitive's implicit colored input", () => {
  for (const useAlpha of [false, true]) {
    const target = frame({ content: '<rect width="12" height="12" fill="#E43A62"/>',
      bounds: { x: 0, y: 0, width: 12, height: 12 } });
    target.helpers.raster = true;
    const identity = '<feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="colored"/>';
    const markup = filterEffect(target, identity + (useAlpha ? '<feComposite in="colored" in2="SourceAlpha" operator="in"/>' : ""));
    const image = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><defs>${target.helpers.defs.join("")}</defs>${markup}</svg>`).render();
    const at = (6 * image.width + 6) * 4;
    assert.deepEqual([...image.pixels.subarray(at, at + 4)], [228, 58, 98, 255], `with SourceAlpha=${useAlpha}`);
  }
});

test("long encoded scene prefixes remain valid effect references", () => {
  const id = `svg-${"61-".repeat(128)}effect-1`;
  const target = frame({ ids: [id] });
  const markup = filterEffect(target, '<feGaussianBlur stdDeviation="1"/>');
  const document = parseSvg(markup, target.helpers.defs);
  assert.equal(document.getElementsByTagName("filter")[0].getAttribute("id"), id);
  assert.equal(document.getElementsByTagName("g")[0].getAttribute("filter"), `url(#${id})`);
});

test("contain clips filter output to frame bounds and clipEffect accepts explicit bounds", () => {
  const included = [];
  const target = frame({ paintBounds: { x: 6, y: 15, width: 35, height: 45 }, includeBounds: (bounds) => included.push(bounds) });
  const filtered = filterEffect(target, "<feOffset dx=\"4\"/>", { padding: 5, contain: true });
  assert.equal(target.helpers.defs.length, 2);
  assert.match(target.helpers.defs[1], /clipPathUnits="userSpaceOnUse"/);
  assert.match(target.helpers.defs[1], /x="10" y="20" width="20" height="30"/);
  assert.match(target.helpers.defs[0], /x="1" y="10" width="45" height="55"/,
    "filter region follows the actual paint extent plus padding");
  assert.deepEqual(included, [{ x: 10, y: 20, width: 20, height: 30 }],
    "a contained effect reports its fixed visible bounds");
  const clipped = clipEffect(target, "<circle cx=\"0\" cy=\"0\" r=\"4\"/>", { x: -2, y: 3, width: 8, height: 9 });
  assert.match(clipped, /clip-path=/);
  assert.match(target.helpers.defs[2], /x="-2" y="3" width="8" height="9"/);
  assert.deepEqual(included[1], { x: -2, y: 3, width: 8, height: 9 });
  assert.equal(parseSvg(`${filtered}${clipped}`, target.helpers.defs).getElementsByTagName("clipPath").length, 2);
});

test("an uncontained filter reports its expanded paint region", () => {
  const included = [];
  const target = frame({ paintBounds: { x: -5, y: 2, width: 8, height: 4 }, includeBounds: (bounds) => included.push(bounds) });
  filterEffect(target, "<feGaussianBlur stdDeviation=\"1\"/>", { padding: 2 });
  assert.deepEqual(included, [{ x: -7, y: 0, width: 12, height: 8 }]);
});

test("invalid bounds, padding, and local-element feImage are rejected before defs change", () => {
  const target = frame();
  for (const bounds of [
    { x: 0, y: 0, width: 0, height: 2 },
    { x: Infinity, y: 0, width: 2, height: 2 },
    { x: 1_000_001, y: 0, width: 2, height: 2 },
  ]) assert.throws(() => clipEffect(target, "<path/>", bounds), /finite|positive|within/);
  assert.throws(() => filterEffect(target, "<feOffset/>", { padding: -1 }), /padding/);
  assert.throws(() => filterEffect(target, '<feImage href="#local"/>'), /local SVG element/);
  assert.throws(() => filterEffect(target, "<feImage href='&#35;local'/ >"), /local SVG element/);
  assert.equal(target.helpers.defs.length, 0);
});

test("copyContent strips per-layer semantics but leaves text and shared paint references", () => {
  const copied = copyContent(`<g id="source" data-layer-id="layer" data-component-owner="main" data-component-path="card/photo" data-media-layer-id="media" role="img" aria-label="Source" tabindex="0" fill="url(#paint)"><text>say id="visible"</text><path id='inner' d='M0 0h1'/></g>`);
  const document = parseSvg(copied);
  const group = document.getElementsByTagName("g")[0];
  assert.equal(group.getAttribute("aria-hidden"), "true");
  assert.equal(group.getAttribute("pointer-events"), "none");
  assert.equal(copied.includes("url(#paint)"), true);
  assert.match(copied, />say id="visible"</);
  const stripped = ["id", "data-layer-id", "data-component-owner", "data-component-path", "data-media-layer-id", "role", "aria-label", "tabindex"];
  const elements = document.getElementsByTagName("*");
  for (let index = 0; index < elements.length; index += 1)
    for (const attribute of stripped) assert.equal(elements[index].hasAttribute(attribute), false, `${elements[index].tagName} ${attribute}`);
  assert.equal(copied.includes("url(#paint)"), true);
});

test("copiesEffect places one invisible semantic proxy after non-interactive decorative copies", () => {
  const target = frame({ content: '<g id="original" data-layer-id="layer"><path d="M0 0h1"/></g>' });
  const output = copiesEffect(target, '<g id="copy" data-layer-id="layer"><path d="M3 0h1"/></g><g id="copy-2"><path d="M6 0h1"/></g>');
  const decorative = output.indexOf('aria-hidden="true"');
  const proxy = output.lastIndexOf('opacity="0"');
  assert.ok(decorative >= 0 && proxy > decorative);
  assert.equal((output.match(/opacity="0"/g) ?? []).length, 1);
  assert.match(output.slice(proxy), /id="original" data-layer-id="layer"/);
  assert.equal(output.includes('id="copy"'), false);
  assert.equal(output.includes('data-layer-id="layer"'), true, "the source proxy keeps its hit semantics");
});

test("copySource repeats one decorative definition without duplicating layer semantics", () => {
  const target = frame({ content: '<g data-layer-id="card" role="img" aria-label="Card"><rect width="4" height="4" fill="#ff0000"/></g>',
    bounds: { x: 0, y: 0, width: 4, height: 4 } });
  const source = copySource(target);
  const markup = copiesEffect(target, `${source}<g transform="translate(6 0)">${source}</g>`);
  const doc = parseSvg(markup, target.helpers.defs);
  assert.equal(doc.getElementsByTagName("use").length, 2);
  const elements = Array.from(doc.getElementsByTagName("*"));
  assert.equal(elements.filter((element) => element.hasAttribute("data-layer-id")).length, 1);
  assert.equal(elements.filter((element) => element.getAttribute("aria-label") === "Card").length, 1);
  const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="4"><defs>${target.helpers.defs.join("")}</defs>${markup}</svg>`).render().pixels;
  const at = (x) => [...pixels.subarray(x * 4, x * 4 + 4)];
  assert.deepEqual(at(1), [255, 0, 0, 255]);
  assert.deepEqual(at(7), [255, 0, 0, 255]);
  assert.deepEqual(at(5), [0, 0, 0, 0]);
});

test("copySource starts its definition with a home rectangle and repeats it inside see-through groups of parts", () => {
  const home = { x: 0, y: 0, width: 100, height: 50 };
  const rect = (x, y, width, height) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="transparent" stroke="none" aria-hidden="true" pointer-events="none"/>`;
  const part = (transform, fill = "#ffffff") => `<g transform="${transform}"><path d="M0 0h2v2z" fill="${fill}"/></g>`;
  const content = [
    `<g data-layer-id="a" transform="translate(10 20) rotate(90) scale(2)" opacity="0.5"><path d="M0 0h5v5z" fill="#ff0000"/>`,
    `<g style="mix-blend-mode:screen">${part("translate(1 1)", "#00ff00")}</g>`,
    `<g transform="matrix(1 0 0 1 5 5)" mask="url(#m)">${part("translate(2 0)")}</g>`,
    '<g style="mix-blend-mode:multiply" opacity="0.7"><path d="M0 0h1v1z"/><path d="M2 2h1v1z"/></g>',
    `<g clip-path="url(#c)">${part("translate(3 0)")}</g><g opacity="1">${part("translate(4 0)")}</g>`,
    `<defs><g opacity="0.2">${part("scale(2)")}</g></defs><!-- <g opacity="0.1"> --></g>`,
    `<g transform="scale(0)" opacity="0.5">${part("translate(1 0)")}</g>`,
    `<g filter="url(#f)" transform="translate(-50 0)">${part("translate(1 1)", "#0000ff")}</g>`,
    `<g style="filter:url(#f)">${part("translate(2 2)")}</g><g filter="url(#f)"><path d="M0 0h1v1z"/></g>`,
  ].join("");
  const target = frame({ content, bounds: home });
  copySource(target, { home });
  const definition = target.helpers.defs[0];
  // The definition's first child; then, in each group's own coordinates, the same area. The
  // turned group maps (u, v) to (10 - 2v, 20 + 2u), so the area is u in -10..15, v in -45..5.
  assert.ok(definition.startsWith(`<g id="copy-source-1">${rect(0, 0, 100, 50)}`), definition);
  assert.ok(definition.includes(`opacity="0.5">${rect(-10, -45, 25, 50)}<path`));
  assert.ok(definition.includes(`<g style="mix-blend-mode:screen">${rect(-10, -45, 25, 50)}`));
  assert.ok(definition.includes(`mask="url(#m)">${rect(-15, -50, 25, 50)}`));
  assert.ok(definition.includes(`<g filter="url(#f)" transform="translate(-50 0)">${rect(50, 0, 100, 50)}`));
  assert.ok(definition.includes(`<g style="filter:url(#f)">${rect(0, 0, 100, 50)}`));
  // None in a group of plain shapes (drawn in one piece), clips, opaque groups, definitions,
  // comments, or under a transform that cannot be undone.
  assert.equal(definition.match(/fill="transparent"/g).length, 6);
  assert.ok(definition.includes('<g filter="url(#f)"><path d="M0 0h1v1z"/></g>'));
  // Copies of copies: the new definition gets its own home and leaves the one it draws alone.
  const again = frame({ content: '<g opacity="0.5"><use href="#copy-source-1"/></g>', bounds: home, ids: ["copy-source-2"] });
  again.helpers.defs.push(definition);
  copySource(again, { home });
  assert.equal(again.helpers.defs[0], definition);
  assert.ok(again.helpers.defs[1].startsWith(`<g id="copy-source-2">${rect(0, 0, 100, 50)}<g aria-hidden="true" pointer-events="none"><g opacity="0.5">${rect(0, 0, 100, 50)}<use`), again.helpers.defs[1]);
  assert.ok(definition.includes('<g style="mix-blend-mode:multiply" opacity="0.7"><path'));
  assert.ok(definition.includes('<g clip-path="url(#c)"><g') && definition.includes('<g opacity="1"><g'));
  assert.ok(definition.includes('<g opacity="0.2"><g') && definition.includes('<g transform="scale(0)" opacity="0.5"><g'));
  // The rectangles draw nothing.
  const draw = (defs) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs>${defs}</defs><use href="#copy-source-1"/></svg>`).render().pixels;
  const plain = frame({ content, bounds: home });
  copySource(plain);
  assert.equal(plain.helpers.defs[0].includes('fill="transparent"'), false);
  assert.deepEqual(draw(definition), draw(plain.helpers.defs[0]));
  // Raster markup (resvg) gets no home rectangle.
  const raster = frame({ content, bounds: home });
  raster.helpers.raster = true;
  copySource(raster, { home });
  assert.equal(raster.helpers.defs[0], plain.helpers.defs[0]);
});
