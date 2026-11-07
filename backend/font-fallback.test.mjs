import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createComponentInstance } from "../engine/linkedComponents.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { layerGlyphProblems } from "../engine/fontGlyphReferences.js";
import { loadBundledFonts } from "./fonts.mjs";
import { createFontCatalog } from "./font-catalog.mjs";
import { ensureDocumentFonts } from "./font-selection.mjs";
import { createColorFontFixture } from "../tests/color-font.mjs";

const FAMILY_ID = "noto-color-emoji";
const FAMILY = "Noto Color Emoji";
const VERSION = "1.0.0";
const SUBSET = "emoji";
const RANGE = "U+1F000-1FAFF";
const FONT_SOURCE = `/api/fonts/fs-${FAMILY_ID}--${VERSION}--400-normal.ttf`;
const CATALOG_URL = "https://api.fontsource.org/v1/fonts?type=google";
const DETAIL_URL = `https://api.fontsource.org/v1/fonts/${FAMILY_ID}`;
const FACE_URL = `https://cdn.jsdelivr.net/fontsource/fonts/${FAMILY_ID}@${VERSION}/${SUBSET}-400-normal.ttf`;

const family = {
  id: FAMILY_ID,
  family: FAMILY,
  type: "google",
  subsets: [SUBSET],
  weights: [400],
  styles: ["normal"],
  defSubset: SUBSET,
  license: "OFL-1.1",
};
const detail = {
  ...family,
  npmVersion: VERSION,
  unicodeRange: { [SUBSET]: RANGE },
  variants: { 400: { normal: { [SUBSET]: { url: { ttf: "/fixture-only.ttf" } } } } },
};

function fontLayer(id, text, extra = {}) {
  return createLayer("text", {
    id,
    name: id,
    text,
    fontFamily: "Inter",
    fontSource: "",
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 24,
    fill: "#181818",
    ...extra,
  });
}

function fallbackDocument() {
  const component = createScene({
    id: "emoji-component",
    name: "Emoji component",
    isComponent: true,
    layers: [fontLayer("component-label", "A")],
  });
  const page = createScene({
    id: "emoji-page",
    name: "Emoji page",
    layers: [
      fontLayer("rich-range", "A😀B", {
        textStyleRanges: [{ start: 1, end: 3, style: { fill: "#c62828" } }],
      }),
      fontLayer("animated-text", "Still plain", {
        animations: [{ id: "emoji-change", name: "Change text", kind: "change-text", start: 0,
          text: "👍", overlap: false, out: null, in: null }],
      }),
      createComponentInstance(component, {
        id: "emoji-instance",
        componentOverrides: { "component-label": { text: "👩" } },
      }),
    ],
  });
  return parseDocument(createDocument({ id: "emoji-fallback-project", name: "Emoji fallback", scenes: [component, page] }));
}

function response(body, url, contentType = "application/json") {
  const result = body instanceof Uint8Array || Buffer.isBuffer(body)
    ? new Response(body, { status: 200, headers: { "content-type": contentType } })
    : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": contentType } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function fixtureFetch(fontBytes, calls) {
  return async (input, options = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    assert.equal(options.method, "GET", "catalog requests only fetch public fixtures");
    assert.equal(options.redirect, "error", "catalog requests refuse redirects");
    if (url === CATALOG_URL) return response([family], url);
    if (url === DETAIL_URL) return response(detail, url);
    if (url === FACE_URL) return response(fontBytes, url, "font/ttf");
    throw new Error(`Unexpected external font request: ${url}`);
  };
}

function assertFallback(registry, text) {
  const runs = registry.textRuns(text, { fontFamily: "Inter", fontWeight: 400, fontStyle: "normal", text });
  const fallback = runs.filter(({ face }) => face.fallbackFor === "Inter");
  assert.ok(fallback.length, `expected a public fallback for ${text}`);
  assert.ok(fallback.every(({ face }) => face.family === FAMILY && face.src === FONT_SOURCE));
  assert.ok(fallback.some(({ text: value }) => value === text), `fallback keeps the complete grapheme ${text}`);
}

test("document font preparation downloads one exact emoji subset for ranges, Change text, and component overrides, then reuses it offline", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-font-fallback-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const fixture = await createColorFontFixture();
  const calls = [];
  const now = () => 1_800_000_000_000;
  const catalog = await createFontCatalog({ dataRoot, fetchImpl: fixtureFetch(fixture.bytes, calls), now, enabled: true });
  const fonts = await loadBundledFonts();
  const document = fallbackDocument();
  const errors = await ensureDocumentFonts(document, catalog, { fonts });

  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [CATALOG_URL, DETAIL_URL, FACE_URL], "fallback performs only the expected catalog and subset requests");
  const cached = await catalog.cachedEntries();
  assert.equal(cached.length, 1, "emoji text resolves through one required subset");
  assert.deepEqual({
    id: cached[0].catalogId,
    family: cached[0].family,
    src: cached[0].src,
    weight: cached[0].weight,
    style: cached[0].style,
    subset: cached[0].subset,
    defaultSubset: cached[0].defaultSubset,
    unicodeRange: cached[0].unicodeRange,
    license: cached[0].license,
    version: cached[0].version,
  }, {
    id: FAMILY_ID,
    family: FAMILY,
    src: fixture.metadata.src,
    weight: 400,
    style: "normal",
    subset: SUBSET,
    defaultSubset: SUBSET,
    unicodeRange: RANGE,
    license: "OFL-1.1",
    version: VERSION,
  });
  assert.match(cached[0].url, /^\/api\/fonts\/fs-cache-[a-f0-9]{64}\.ttf$/u);

  assertFallback(fonts, "😀");
  assertFallback(fonts, "👍");
  assertFallback(fonts, "👩");

  const restartCalls = [];
  const offlineCatalog = await createFontCatalog({
    dataRoot,
    fetchImpl: async (url) => {
      restartCalls.push(String(url));
      throw new Error("network should stay disabled after restart");
    },
    now,
    enabled: false,
  });
  const restartedFonts = await loadBundledFonts();
  const restartErrors = await ensureDocumentFonts(document, offlineCatalog, { allowMissing: true, fonts: restartedFonts });
  assert.deepEqual(restartErrors, [], "cached fallback remains available when catalog downloads are disabled");
  assert.deepEqual(restartCalls, [], "offline restart issues no network requests");
  assertFallback(restartedFonts, "😀");
  assertFallback(restartedFonts, "👍");
  assertFallback(restartedFonts, "👩");
});

test("offline fallback keeps unsupported emoji boxed, warns clearly, and ignores a private upload", async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-font-fallback-offline-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));

  const calls = [];
  const catalog = await createFontCatalog({
    dataRoot,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error("offline test must not reach the network");
    },
    enabled: false,
  });
  const fonts = await loadBundledFonts();
  const privateFixture = await createColorFontFixture();
  fonts.register(privateFixture.bytes, {
    id: "private-emoji-upload",
    family: "Private Emoji Upload",
    weight: 400,
    style: "normal",
    src: "/api/media/private-emoji-upload.ttf",
  });
  const privateFace = fonts.faces.find((face) => face.id === "private-emoji-upload");
  assert.equal(fonts.covers(privateFace, "😀"), true, "the unrelated private file contains a matching glyph");

  const layer = fontLayer("offline-emoji", "😀");
  const document = parseDocument(createDocument({
    id: "offline-emoji-project",
    scenes: [createScene({ id: "offline-page", layers: [layer] })],
  }));
  const errors = await ensureDocumentFonts(document, catalog, { allowMissing: true, fonts });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].id, "glyph-fallback:noto-color-emoji");
  assert.equal(errors[0].name, "Character fallback");
  assert.match(errors[0].error, /characters have no available fallback font.*shown as boxes/u);
  assert.deepEqual(calls, [], "downloads-off mode performs no network requests");
  assert.equal(fonts.textRuns("😀", layer)[0].face.missingGlyph, true, "unsupported emoji stays a visible missing-glyph box");
  assert.deepEqual(layerGlyphProblems(layer, fonts), [{ text: "😀", family: "Inter" }]);
});
