import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { PROJECTION_LIMITS, renderCardFlip, renderOrbit } from "./projection.js";

const WIDTH = 100;
const HEIGHT = 100;
const ASYMMETRIC = '<g id="source-content" role="img" aria-label="Two color bars"><rect x="10" y="10" width="25" height="80" fill="#ff0000"/><rect x="65" y="10" width="25" height="80" fill="#0000ff"/></g>';

function trace(message) {
  if (process.env.KINO_TEST_TRACE === "1") writeSync(2, `Projection regression: ${message}\n`);
}
test.beforeEach(({ name }) => trace(`starting ${name}`));

function makeFrame(render, parameters = {}, { width = WIDTH, height = HEIGHT, viewBox = `0 0 ${width} ${height}`, content = ASYMMETRIC, raster = false } = {}) {
  const defs = [];
  let sequence = 0;
  let includedBounds;
  const [viewX, viewY, viewWidth, viewHeight] = viewBox.split(/[\s,]+/).map(Number);
  const frame = {
    content,
    bounds: { x: 0, y: 0, width, height },
    parameters,
    helpers: {
      defs,
      raster,
      transform: [1, 0, 0, 1],
      id: (kind) => `projection-test-${kind}-${sequence++}`,
      clipSentinel: (matrix = [1, 0, 0, 1, 0, 0]) => {
        const [a, b, c, d, e = 0, f = 0] = matrix;
        const determinant = a * d - b * c;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return "";
        const dx = viewX + viewWidth / 2 - e;
        const dy = viewY + viewHeight / 2 - f;
        const x = (d * dx - c * dy) / determinant;
        const y = (-b * dx + a * dy) / determinant;
        return `<rect x="${x - 1}" y="${y - 1}" width="2" height="2" fill="transparent" pointer-events="none"/>`;
      },
      includeBounds: (bounds) => { includedBounds = bounds; },
    },
  };
  const output = render(frame);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}"><defs>${defs.join("")}</defs>${output}</svg>`;
  return { frame, defs, output, svg, includedBounds };
}

function raster(svg) {
  trace(`render start (${Buffer.byteLength(svg)} SVG bytes)`);
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  // Resvg copies its native pixel buffer on every getter access.
  // Snapshot once so pixel assertions inspect bytes without repeated allocation.
  const snapshot = { width: image.width, height: image.height, pixels: image.pixels };
  trace("render complete");
  return snapshot;
}

function pixel(image, x, y) {
  const index = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [...image.pixels.subarray(index, index + 4)];
}

function visiblePixels(image) {
  let count = 0;
  for (let index = 3; index < image.pixels.length; index += 4) if (image.pixels[index] > 0) count += 1;
  return count;
}

function differingPixels(left, right, threshold = 2) {
  assert.equal(left.length, right.length);
  let count = 0;
  for (let index = 0; index < left.length; index += 4) {
    if ([0, 1, 2, 3].some((channel) => Math.abs(left[index + channel] - right[index + channel]) > threshold)) count += 1;
  }
  return count;
}

function svgWithOuterTransform(svg, transform) {
  const resized = svg.replace(/^<svg\b[^>]*>/,
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="160" viewBox="-20 -20 140 140">');
  return resized.replace(/(<defs>[\s\S]*?<\/defs>)([\s\S]*)(<\/svg>)$/,
    (_match, defs, markup, end) => `${defs}<g transform="${transform}">${markup}</g>${end}`);
}

test("Card Flip keeps the front identity frame and turns edge-on at both quarter turns", () => {
  const original = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${ASYMMETRIC}</svg>`;
  const identity = raster(makeFrame(renderCardFlip).svg).pixels;
  assert.deepEqual(identity, raster(original).pixels);

  for (const rotationY of [90, 270]) {
    const edge = makeFrame(renderCardFlip, { rotationY });
    const image = raster(edge.svg);
    assert.equal(visiblePixels(image), 0, `${rotationY} degrees is edge-on`);
    assert.doesNotMatch(edge.svg, /NaN|Infinity/);
    assert.match(edge.output, /opacity="0"/, "the original remains as an invisible source proxy");
  }
});

test("Card Flip shows a mirrored back face at 180 degrees and honors both face switches", () => {
  const back = raster(makeFrame(renderCardFlip, { rotationY: 180, backFace: true }).svg);
  assert.deepEqual(pixel(back, 20, 50), [0, 0, 255, 255]);
  assert.deepEqual(pixel(back, 80, 50), [255, 0, 0, 255]);

  for (const parameters of [
    { rotationY: 180, backFace: false },
    { rotationY: 0, frontFace: false },
  ]) {
    assert.equal(visiblePixels(raster(makeFrame(renderCardFlip, parameters).svg)), 0);
  }
});

test("Orbit keeps its front identity and uses the same mirrored/back visibility rules", () => {
  const identity = raster(makeFrame(renderOrbit, { rotateY: 360 }).svg).pixels;
  const original = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${ASYMMETRIC}</svg>`;
  assert.deepEqual(identity, raster(original).pixels);

  const back = makeFrame(renderOrbit, { rotateY: 180, pivotZ: 1, showBack: true });
  assert.ok(visiblePixels(raster(back.svg)) > 0);
  assert.match(back.svg, /matrix\(-/u, "the back face is mirrored by its projected transform");
  assert.equal(visiblePixels(raster(makeFrame(renderOrbit, { rotateY: 180, showBack: false }).svg)), 0);
  assert.equal(visiblePixels(raster(makeFrame(renderOrbit, { rotateY: 0, showFront: false }).svg)), 0);
});

test("X/Z rotations, perspective, pivots, and outer group transforms affect projected pixels", () => {
  const flat = raster(makeFrame(renderCardFlip, { rotationY: 42, perspective: 0 }).svg);
  const perspective = makeFrame(renderCardFlip, {
    rotationX: 24, rotationY: 42, rotationZ: 18, pivotX: 0.2, pivotY: -0.1, perspective: 0.7,
  });
  const projected = raster(perspective.svg);
  assert.ok(differingPixels(flat.pixels, projected.pixels) > 100);
  assert.ok(perspective.defs.filter((definition) => /id="[^"]*projection-pattern-/u.test(definition)).length <= PROJECTION_LIMITS.maxTriangles);
  assert.ok(perspective.includedBounds.width > 0 && perspective.includedBounds.height > 0);

  const centered = raster(makeFrame(renderCardFlip, { rotationY: 42, perspective: 0.7 }).svg);
  const shiftedPivot = raster(makeFrame(renderCardFlip, { rotationY: 42, pivotX: 0.35, perspective: 0.7 }).svg);
  assert.ok(differingPixels(centered.pixels, shiftedPivot.pixels) > 50);

  const orbitViewBox = "0 0 600 200";
  const orbitNear = raster(makeFrame(renderOrbit, { rotateY: 47, pivotZ: 1, cameraDistance: 2 }, { viewBox: orbitViewBox }).svg);
  const orbitFar = raster(makeFrame(renderOrbit, { rotateY: 47, pivotZ: 6, cameraDistance: 12 }, { viewBox: orbitViewBox }).svg);
  assert.ok(differingPixels(orbitNear.pixels, orbitFar.pixels) > 50);

  const outer = raster(svgWithOuterTransform(perspective.svg, "matrix(1.25 0.2 -0.1 0.8 35 20)"));
  assert.ok(visiblePixels(outer) > 100);
});

test("group and text content keep one semantic source while decorative mesh copies are inert", () => {
  const content = '<g id="layer-source" role="img" aria-label="Greeting"><rect x="5" y="5" width="90" height="90" fill="#e63946"/><text x="12" y="54" font-family="Inter" font-size="20" fill="#fff">Hello</text></g>';
  const result = makeFrame(renderCardFlip, { rotationX: 18, rotationY: 70, perspective: 0.6 }, { content });
  const ids = [...result.svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "projection definitions and the retained source have unique IDs");
  assert.equal((result.svg.match(/aria-label="Greeting"/g) ?? []).length, 1);
  assert.equal(result.defs.filter((definition) => /id="[^"]*copy-source-/u.test(definition)).length, 1,
    "the decorative source definition is emitted once");
  assert.ok(result.defs.some((definition) => /<pattern\b[^>]*patternUnits="userSpaceOnUse"[^>]*patternContentUnits="userSpaceOnUse"[^>]*viewBox=/u.test(definition)),
    "each triangle uses an explicitly bounded user-space pattern");
  assert.match(result.output, /aria-hidden="true" pointer-events="none"/);
  assert.match(result.output, /<text\b/u, "text remains part of every projected piece");
  assert.ok(visiblePixels(raster(result.svg)) > 100);
});

test("pattern tiles use each source triangle AABB rather than the full source bounds", () => {
  const result = makeFrame(renderCardFlip, { rotationX: 24, perspective: 0.45 });
  const patterns = result.defs.filter((definition) => /<pattern\b/u.test(definition));
  assert.equal(patterns.length, 8);
  for (const pattern of patterns) {
    const width = Number(pattern.match(/\bwidth="([^"]+)"/u)?.[1]);
    const height = Number(pattern.match(/\bheight="([^"]+)"/u)?.[1]);
    const viewBox = pattern.match(/\bviewBox="([^"]+)"/u)?.[1].split(" ").map(Number);
    assert.equal(width, 50);
    assert.equal(height, 50);
    assert.deepEqual(viewBox?.slice(2), [width, height]);
    assert.match(pattern, /preserveAspectRatio="none"/u);
  }
});

test("bounded pattern pieces follow affine transforms without translucent seam accumulation", () => {
  const rotationY = 28;
  const perspective = 0.6;
  const result = makeFrame(renderCardFlip, { rotationY, perspective }, {
    content: '<rect x="0" y="0" width="100" height="100" fill="#ff0000" fill-opacity="0.5"/>',
  });
  const image = raster(result.svg);
  const radians = rotationY * Math.PI / 180;
  const distance = 100;
  const targetX = (sourceX) => {
    const dx = sourceX - 50;
    const worldX = 50 + dx * Math.cos(radians);
    const z = -dx * Math.sin(radians);
    const scale = distance / (distance - perspective * z);
    return 50 + (worldX - 50) * scale;
  };
  const samples = [];
  for (let index = 5; index < 27; index += 1) {
    samples.push(targetX(index * 100 / 32));
    samples.push(targetX((index + 0.5) * 100 / 32));
  }
  for (const x of samples) {
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const alpha = pixel(image, Math.floor(x) + dx, 50 + dy)[3];
        assert.ok(Math.abs(alpha - 128) <= 1, `internal triangle join near x=${x.toFixed(2)} has alpha ${alpha}`);
      }
    }
  }
});

test("an off-view Orbit stays safe in Resvg when its transparent scene-center sentinel is present", () => {
  const source = `
    import { Resvg } from "@resvg/resvg-js";
    import { renderOrbit } from "./engine/effects/projection.js";
    const defs = [];
    let sequence = 0;
    const viewWidth = 100, viewHeight = 100;
    const clipSentinel = (matrix = [1, 0, 0, 1, 0, 0]) => {
      const [a, b, c, d, e = 0, f = 0] = matrix;
      const determinant = a * d - b * c;
      const dx = viewWidth / 2 - e, dy = viewHeight / 2 - f;
      const x = (d * dx - c * dy) / determinant;
      const y = (-b * dx + a * dy) / determinant;
      return '<rect x="' + (x - 1) + '" y="' + (y - 1) + '" width="2" height="2" fill="transparent" pointer-events="none"/>';
    };
    const output = renderOrbit({
      content: '<rect x="10" y="10" width="25" height="80" fill="#f00"/><rect x="65" y="10" width="25" height="80" fill="#00f"/>',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      parameters: { rotateY: 47, pivotZ: 6, cameraDistance: 12 },
      helpers: { defs, id: (kind) => 'offscreen-' + kind + '-' + sequence++, clipSentinel },
    });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><defs>' + defs.join('') + '</defs>' + output + '</svg>';
    const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    if (image.width !== 100 || image.height !== 100) process.exit(2);
  `;
  trace("off-view child start");
  const started = performance.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_000_000,
  });
  trace(`off-view child complete (${Math.round(performance.now() - started)} ms)`);
  assert.equal(child.status, 0, child.stderr || child.stdout || JSON.stringify({
    signal: child.signal,
    error: child.error ? { code: child.error.code ?? null, message: child.error.message } : null,
  }));
});

test("large 1920x1080 projection stays within the triangle cap and renders", () => {
  const result = makeFrame(renderCardFlip, { rotationX: 22, rotationY: 58, perspective: 0.45 }, {
    width: 1920,
    height: 1080,
    content: '<rect x="0" y="0" width="1920" height="1080" fill="#4361ee"/>',
  });
  assert.equal(result.defs.filter((definition) => /id="[^"]*projection-pattern-/u.test(definition)).length, PROJECTION_LIMITS.maxTriangles);
  assert.equal(result.defs.filter((definition) => /id="[^"]*projection-silhouette-/u.test(definition)).length, 1);
  assert.equal(result.defs.filter((definition) => /id="[^"]*copy-source-/u.test(definition)).length, 1);
  assert.ok(result.svg.length < 2_000_000, "the bounded mesh keeps generated SVG output manageable");
  const source = `
    import { Resvg } from "@resvg/resvg-js";
    let svg = "";
    for await (const chunk of process.stdin) svg += chunk;
    const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    const pixels = image.pixels;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visible += 1;
    const { user, system } = process.cpuUsage();
    process.stdout.write(JSON.stringify({ width: image.width, height: image.height, visible, cpuMs: (user + system) / 1000 }));
  `;
  const started = performance.now();
  trace("large projection child start");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    input: result.svg,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4_000_000,
  });
  const elapsed = performance.now() - started;
  trace(`large projection child complete (${Math.round(elapsed)} ms)`);
  assert.equal(child.status, 0, child.stderr || child.stdout || JSON.stringify({
    svgLength: result.svg.length,
    signal: child.signal,
    error: child.error ? { code: child.error.code ?? null, message: child.error.message } : null,
  }));
  const image = JSON.parse(child.stdout);
  assert.equal(image.width, 1920);
  assert.equal(image.height, 1080);
  assert.ok(image.visible > 100_000);
  // CPU time, not the clock: a busy machine (the suite runs files side by side) slows the clock only.
  assert.ok(image.cpuMs < 15_000, `the Resvg smoke render should stay below 15 seconds of CPU (actual ${Math.round(image.cpuMs)} ms, ${Math.round(elapsed)} ms by the clock)`);
});

test("projection input caps prevent invalid geometry and SVG values", () => {
  assert.throws(() => makeFrame(renderCardFlip, { rotationY: 3_601 }), /rotationY.*-3600 to 3600/);
  assert.throws(() => makeFrame(renderOrbit, { perspective: 1 }), /perspective.*0 to 0.95/);
  assert.throws(() => makeFrame(renderCardFlip, { frontFace: 1 }), /frontFace must be true or false/);
  assert.equal(PROJECTION_LIMITS.maxTriangles, 64);
});
