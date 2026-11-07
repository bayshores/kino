import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFontCatalog } from "./font-catalog.mjs";
import { FontRegistry } from "../engine/fonts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureFont = await readFile(path.join(root, "assets", "fonts", "Inter-400.ttf"));
const base = "https://cdn.jsdelivr.net/npm/@fontsource/test-sans@5.2.8";

const family = {
  id: "test-sans",
  family: "Test Sans",
  subsets: ["latin", "cyrillic"],
  weights: [400],
  styles: ["normal"],
  defSubset: "latin",
  license: "OFL-1.1",
  type: "google",
};

const detail = {
  ...family,
  version: "v1",
  npmVersion: "5.3.0",
  unicodeRange: { latin: "U+0000-024F", cyrillic: "U+0400-052F" },
  variants: { 400: { normal: { latin: { url: { ttf: "/untrusted/latin.ttf" } }, cyrillic: { url: { ttf: "/untrusted/cyrillic.ttf" } } } } },
};

async function dataRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kino-font-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function jsonResponse(value, url = "") {
  const response = new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  if (!url) return response;
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("catalog caches Google families, downloads only needed subsets and serves only verified local paths", async (t) => {
  const directory = await dataRoot(t);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://api.fontsource.org/v1/fonts?type=google") return jsonResponse([
      family,
      { ...family, id: "other-font", family: "Other Font" },
      { ...family, id: "ignored-font", type: "adobe" },
    ], url);
    if (url === "https://api.fontsource.org/v1/fonts/test-sans") return jsonResponse(detail, url);
    if (url === "https://cdn.jsdelivr.net/fontsource/fonts/test-sans@5.3.0/latin-400-normal.ttf" ||
        url === "https://cdn.jsdelivr.net/fontsource/fonts/test-sans@5.3.0/cyrillic-400-normal.ttf")
      return new Response(fixtureFont, { status: 200, headers: { "content-type": "font/ttf" } });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const catalog = await createFontCatalog({ dataRoot: directory, fetchImpl, now: () => 1_000 });

  const listed = await catalog.list({ search: "test", limit: 10 });
  assert.equal(listed.downloadsEnabled, true);
  assert.equal(listed.offline, false);
  assert.deepEqual(listed.families.map(({ id, family: name }) => ({ id, family: name })), [{ id: "test-sans", family: "Test Sans" }]);
  assert.equal(calls[0].options.redirect, "error");

  const [latin, latinAgain] = await Promise.all([
    catalog.ensureFace({ id: "test-sans", weight: 400, style: "normal", text: "Hello" }),
    catalog.ensureFace({ id: "test-sans", weight: 400, style: "normal", text: "Hello" }),
  ]);
  assert.equal(latin.family, "Test Sans");
  assert.equal(latinAgain.faces[0].url, latin.faces[0].url);
  assert.equal(latin.src, "/api/fonts/fs-test-sans--5.3.0--400-normal.ttf");
  assert.deepEqual(latin.faces.map((face) => face.subset), ["latin"]);
  const mixed = await catalog.ensureFace({ id: "test-sans", weight: 400, style: "normal", text: "AЖ" });
  assert.deepEqual(mixed.faces.map((face) => face.subset), ["latin", "cyrillic"]);
  assert.equal(calls.filter(({ url }) => url.includes("fontsource/fonts/")).length, 2);
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
  assert.ok(calls.every(({ url }) => new URL(url).protocol === "https:"));

  const entries = await catalog.cachedEntries();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.license === "OFL-1.1" && entry.version === "5.3.0"));
  assert.ok(entries.every((entry) => !("path" in entry)));
  const fontFile = await catalog.file(latin.src);
  assert.equal(fontFile?.mime, "font/ttf");
  assert.equal((await readFile(fontFile.path)).subarray(0, 4).toString(), fixtureFont.subarray(0, 4).toString());
  assert.equal(await catalog.file("https://example.com/font.ttf"), null);
  assert.equal(await catalog.file("/api/fonts/fs-../private--5.3.0--400-normal.ttf"), null);
  assert.ok(await catalog.file(entries[0].url));

  const registry = new FontRegistry();
  await catalog.loadInto(registry);
  assert.equal(registry.entries().filter((entry) => entry.src === latin.src).length, 2);

  const cached = await createFontCatalog({ dataRoot: directory, enabled: false, fetchImpl: async () => { throw new Error("network disabled"); } });
  assert.deepEqual((await cached.list()).families.map(({ id }) => id), ["test-sans"]);
  assert.deepEqual((await cached.ensureFace({ id: "test-sans", weight: 400, text: "Ж" })).faces.map((face) => face.subset), ["latin", "cyrillic"]);
  assert.ok(await cached.file(latin.src.slice("/api/fonts/".length)));
});

test("catalog uses its cached family list when refresh fails and reports offline state", async (t) => {
  const directory = await dataRoot(t);
  const first = await createFontCatalog({ dataRoot: directory, fetchImpl: async () => jsonResponse([family]), now: () => 10 });
  await first.list();
  let attempts = 0;
  const offline = await createFontCatalog({ dataRoot: directory, fetchImpl: async () => { attempts += 1; throw new Error("offline"); }, now: () => 2 * 24 * 60 * 60 * 1000 });
  const result = await offline.list();
  assert.equal(result.offline, true);
  assert.match(result.error, /offline/u);
  assert.equal(result.families[0].family, "Test Sans");
  assert.equal((await offline.list()).offline, true);
  assert.equal(attempts, 1);
});

test("concurrent empty-catalog reads share one refresh", async (t) => {
  const directory = await dataRoot(t);
  let attempts = 0;
  const catalog = await createFontCatalog({
    dataRoot: directory,
    now: () => 1_000,
    fetchImpl: async (url) => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (url === "https://api.fontsource.org/v1/fonts?type=google") return jsonResponse([family], url);
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(attempts, 1);
  assert.equal(first.families[0].id, "test-sans");
  assert.equal(second.families[0].id, "test-sans");
});

test("pinned versions use package metadata and actual sparse package files, not latest API faces", async (t) => {
  const directory = await dataRoot(t);
  const calls = [];
  const pinnedMetadata = {
    name: "@fontsource/test-sans",
    family: "Test Sans",
    subsets: ["latin", "cyrillic"],
    weights: [400, 700],
    styles: ["normal", "italic"],
    defSubset: "latin",
    license: {
      type: "OFL-1.1",
      url: "https://openfontlicense.org",
      attribution: "Test Sans Authors",
    },
    type: "google",
  };
  const tree = {
    type: "directory",
    name: "",
    files: [{ type: "directory", name: "files", files: [
      { type: "file", name: "test-sans-latin-400-normal.woff2" },
      { type: "file", name: "test-sans-cyrillic-700-italic.woff2" },
    ] }],
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === `${base}/metadata.json`) return jsonResponse(pinnedMetadata, url);
    if (url === `${base}/unicode.json`) return jsonResponse({ latin: "U+0000-024F", cyrillic: "U+0400-052F" }, url);
    if (url === "https://data.jsdelivr.com/v1/packages/npm/@fontsource/test-sans@5.2.8?structure=tree") return jsonResponse(tree, url);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const catalog = await createFontCatalog({ dataRoot: directory, fetchImpl });
  const metadata = await catalog.detail("test-sans", { version: "5.2.8" });
  assert.equal(metadata.version, "5.2.8");
  assert.equal(metadata.license, "OFL-1.1");
  assert.deepEqual(metadata.licenseDetails, {
    type: "OFL-1.1",
    url: "https://openfontlicense.org",
    attribution: "Test Sans Authors",
  });
  assert.deepEqual(metadata.variants, { 400: { normal: ["latin"] }, 700: { italic: ["cyrillic"] } });
  assert.deepEqual(calls, [
    `${base}/metadata.json`,
    `${base}/unicode.json`,
    "https://data.jsdelivr.com/v1/packages/npm/@fontsource/test-sans@5.2.8?structure=tree",
  ]);
  await assert.rejects(catalog.ensureFace({ id: "test-sans", version: "5.2.8", weight: 700, style: "normal" }), /does not have weight/u);
  assert.equal(calls.length, 3);
});

test("latest API numeric faces normalize bracketed ranges and skip logical aggregates without ranges", async (t) => {
  const directory = await dataRoot(t);
  const urls = [];
  const emojiFamily = {
    id: "noto-color-emoji",
    family: "Noto Color Emoji",
    subsets: ["emoji"],
    weights: [400],
    styles: ["normal"],
    defSubset: "emoji",
    license: "OFL-1.1",
    type: "google",
  };
  const emojiDetail = {
    ...emojiFamily,
    npmVersion: "5.3.0",
    version: "v1",
    unicodeRange: { "[0]": "U+0000-007F", "[1]": "U+0400-04FF" },
    variants: { 400: { normal: { 0: {}, 1: {}, emoji: {} } } },
  };
  const catalog = await createFontCatalog({
    dataRoot: directory,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === "https://api.fontsource.org/v1/fonts/noto-color-emoji") return jsonResponse(emojiDetail, url);
      if (url.endsWith("/0-400-normal.ttf") || url.endsWith("/1-400-normal.ttf")) return new Response(fixtureFont, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const normalized = await catalog.detail("noto-color-emoji");
  assert.deepEqual(normalized.subsets, ["0", "1"]);
  assert.equal(normalized.defSubset, "0");
  assert.deepEqual(normalized.variants, { 400: { normal: ["0", "1"] } });
  const result = await catalog.ensureFace({ id: "noto-color-emoji", weight: 400, text: "AЖ" });
  assert.deepEqual(result.faces.map((face) => face.subset), ["0", "1"]);
  assert.ok(urls.includes("https://cdn.jsdelivr.net/fontsource/fonts/noto-color-emoji@5.3.0/0-400-normal.ttf"));
  assert.ok(urls.includes("https://cdn.jsdelivr.net/fontsource/fonts/noto-color-emoji@5.3.0/1-400-normal.ttf"));
});

test("pinned numeric package files map bracketed Unicode ranges to unbracketed subset URLs", async (t) => {
  const directory = await dataRoot(t);
  const urls = [];
  const id = "noto-sans-jp";
  const version = "5.2.8";
  const packageBase = `https://cdn.jsdelivr.net/npm/@fontsource/${id}@${version}`;
  const metadata = {
    name: `@fontsource/${id}`,
    id,
    family: "Noto Sans Japanese",
    subsets: ["japanese", "latin"],
    weights: [400],
    styles: ["normal"],
    defSubset: "latin",
    license: { type: "OFL-1.1", url: "https://openfontlicense.org", attribution: "Noto Authors" },
    type: "google",
  };
  const unicode = { "[0]": "U+3040-309F", "[1]": "U+30A0-30FF", latin: "U+0000-007F" };
  const tree = { type: "npm", name: `@fontsource/${id}`, version, files: [{
    type: "directory", name: "files", files: [
      { type: "file", name: `${id}-0-400-normal.woff2` },
      { type: "file", name: `${id}-1-400-normal.woff2` },
      { type: "file", name: `${id}-latin-400-normal.woff2` },
      { type: "file", name: `${id}-japanese-400-normal.woff2` },
    ],
  }] };
  const catalog = await createFontCatalog({
    dataRoot: directory,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === `${packageBase}/metadata.json`) return jsonResponse(metadata, url);
      if (url === `${packageBase}/unicode.json`) return jsonResponse(unicode, url);
      if (url === `https://data.jsdelivr.com/v1/packages/npm/@fontsource/${id}@${version}?structure=tree`) return jsonResponse(tree, url);
      if (url === `https://cdn.jsdelivr.net/fontsource/fonts/${id}@${version}/latin-400-normal.ttf` ||
          url === `https://cdn.jsdelivr.net/fontsource/fonts/${id}@${version}/0-400-normal.ttf`)
        return new Response(fixtureFont, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const normalized = await catalog.detail(id, { version });
  assert.deepEqual(normalized.subsets, ["0", "1", "latin"]);
  assert.equal(normalized.defSubset, "latin");
  assert.deepEqual(normalized.variants, { 400: { normal: ["0", "1", "latin"] } });
  const result = await catalog.ensureFace({ id, version, weight: 400, text: "Aあ" });
  assert.deepEqual(result.faces.map((face) => face.subset), ["latin", "0"]);
  assert.ok(urls.includes(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@${version}/0-400-normal.ttf`));
  assert.ok(!urls.includes(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@${version}/[0]-400-normal.ttf`));
});

test("corrupt cached font bytes are ignored and never returned by the local file lookup", async (t) => {
  const directory = await dataRoot(t);
  const fetchImpl = async (url) => {
    if (url === "https://api.fontsource.org/v1/fonts/test-sans") return jsonResponse(detail);
    if (url.includes("fontsource/fonts/")) return new Response(fixtureFont, { status: 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const catalog = await createFontCatalog({ dataRoot: directory, fetchImpl });
  await assert.rejects(catalog.ensureFace({ id: "test-sans", weight: 400, text: { toString: () => "bad" } }), /must be a string/u);
  await assert.rejects(catalog.ensureFace({ id: "test-sans", weight: 400, text: "x".repeat(65_537) }), /65,536/u);
  const result = await catalog.ensureFace({ id: "test-sans", weight: 400 });
  const records = await readdir(path.join(directory, "fonts", "faces"));
  const faceRecordPath = path.join(directory, "fonts", "faces", records.find((name) => name.endsWith(".json")));
  const faceRecord = JSON.parse(await readFile(faceRecordPath, "utf8"));
  await writeFile(path.join(directory, "fonts", "faces", `${faceRecord.hash}.ttf`), Buffer.from("not a font"));
  assert.deepEqual(await catalog.cachedEntries(), []);
  assert.equal(await catalog.file(result.faces[0].url), null);
});

test("corrupt cached Unicode metadata is skipped without breaking registry startup", async (t) => {
  const directory = await dataRoot(t);
  const fetchImpl = async (url) => {
    if (url === "https://api.fontsource.org/v1/fonts/test-sans") return jsonResponse(detail);
    if (url.includes("fontsource/fonts/")) return new Response(fixtureFont, { status: 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const catalog = await createFontCatalog({ dataRoot: directory, fetchImpl });
  await catalog.ensureFace({ id: "test-sans", weight: 400 });
  const files = await readdir(path.join(directory, "fonts", "faces"));
  const metadataPath = path.join(directory, "fonts", "faces", files.find((name) => name.endsWith(".json")));
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.unicodeRange = "not a unicode range";
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.deepEqual(await catalog.cachedEntries(), []);
  const registry = new FontRegistry();
  await assert.doesNotReject(catalog.loadInto(registry));
  assert.deepEqual(registry.entries(), []);
});
