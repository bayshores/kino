import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadBundledFonts, loadProjectFonts } from "./fonts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asset = (name) => path.join(root, "assets", "fonts", name);

async function temporaryMedia(t) {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "kino-fonts-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  return mediaRoot;
}

async function writeFont(mediaRoot, id, name, mime, bytes) {
  await writeFile(path.join(mediaRoot, id), bytes, { mode: 0o600 });
  await writeFile(
    path.join(mediaRoot, `${id}.json`),
    JSON.stringify({ id, name, mime, size: bytes.length, src: `/api/media/${id}` }),
    { mode: 0o600 },
  );
}

test("bundled registry parses Inter weights and normal/italic faces with safe catalog URLs", async () => {
  const registry = await loadBundledFonts();
  const entries = registry.entries();
  const find = (weight, style) =>
    entries.find(
      (entry) =>
        entry.family === "Inter" &&
        entry.weight === weight &&
        entry.style === style,
    );

  for (const weight of [400, 500, 600, 700]) {
    const regular = find(weight, "normal");
    const italic = find(weight, "italic");
    assert.ok(regular, `expected bundled Inter ${weight} normal face`);
    assert.ok(italic, `expected bundled Inter ${weight} italic face`);
    assert.match(regular.src, /^\/api\/fonts\/Inter-[0-9]+\.ttf$/u);
    assert.match(
      italic.src,
      /^\/api\/fonts\/Inter-[0-9]+-italic\.woff2$/u,
    );
  }
  // The Montserrat binaries retain legacy family names such as "Montserrat
  // Thin Medium". The catalog must expose their documented family and weights.
  for (const weight of [400, 500, 600, 700]) for (const style of ["normal", "italic"]) {
    const face = registry.resolve({fontFamily: "Montserrat", fontWeight: weight, fontStyle: style});
    assert.equal(face.weight, weight);
    assert.equal(face.style, style);
    assert.match(face.src, /^\/api\/fonts\/Montserrat-/u);
    assert.ok(face.font.layout("Text").glyphs.length > 0);
  }
  assert.deepEqual(registry.errors, []);
});

test("project font loading parses TTF and WOFF2 and excludes media outside the allowed scope", async (t) => {
  const mediaRoot = await temporaryMedia(t);
  const ttfId = "11111111-1111-4111-8111-111111111111.ttf";
  const woff2Id = "22222222-2222-4222-8222-222222222222.woff2";
  const foreignId = "33333333-3333-4333-8333-333333333333.ttf";
  const [ttf, woff2] = await Promise.all([
    readFile(asset("Inter-400.ttf")),
    readFile(asset("Inter-500-italic.woff2")),
  ]);
  await writeFont(mediaRoot, ttfId, "Project Sans.ttf", "font/ttf", ttf);
  await writeFont(
    mediaRoot,
    woff2Id,
    "Project Sans Medium Italic.woff2",
    "font/woff2",
    woff2,
  );
  await writeFont(
    mediaRoot,
    foreignId,
    "Foreign Corrupt.ttf",
    "font/ttf",
    Buffer.from("not a font"),
  );

  const registry = await loadProjectFonts({
    mediaRoot,
    allowedIds: new Set([ttfId, woff2Id]),
    bundled: false,
  });
  const entries = registry.entries();

  assert.deepEqual(
    entries.map(({ id, family, aliases, weight, style, src }) => ({
      id,
      family,
      aliases,
      weight,
      style,
      src,
    })),
    [
      {
        id: ttfId,
        family: "Inter",
        aliases: ["Project Sans"],
        weight: 400,
        style: "normal",
        src: `/api/media/${ttfId}`,
      },
      {
        id: woff2Id,
        family: "Inter",
        aliases: ["Project Sans Medium Italic"],
        weight: 500,
        style: "italic",
        src: `/api/media/${woff2Id}`,
      },
    ],
  );
  assert.deepEqual(registry.errors, []);
});

test("corrupt authorized font uploads are reported and never registered", async (t) => {
  const mediaRoot = await temporaryMedia(t);
  const id = "44444444-4444-4444-8444-444444444444.woff2";
  await writeFont(
    mediaRoot,
    id,
    "Broken Typeface.woff2",
    "font/woff2",
    Buffer.from("invalid WOFF2 data"),
  );

  const registry = await loadProjectFonts({
    mediaRoot,
    allowedIds: new Set([id]),
    bundled: false,
  });

  assert.deepEqual(registry.entries(), []);
  assert.equal(registry.errors.length, 1);
  assert.equal(registry.errors[0].id, id);
  assert.equal(registry.errors[0].name, "Broken Typeface.woff2");
  assert.match(registry.errors[0].error, /could not be parsed|unknown font|woff2/iu);
});

test("old family-only upload references retain repeated spaces and removed controls", async (t) => {
  const mediaRoot = await temporaryMedia(t);
  const id = "55555555-5555-4555-8555-555555555555.ttf";
  await writeFont(mediaRoot, id, " Brand   Reg\nular.ttf", "font/ttf", await readFile(asset("Inter-400.ttf")));
  const registry = await loadProjectFonts({ mediaRoot, allowedIds: new Set([id]), bundled: false });
  const reference = { fontFamily: "Brand   Regular", fontWeight: 400, fontStyle: "normal" };
  assert.equal(registry.resolve(reference).id, id);
  assert.equal(reference.fontFamily, "Brand   Regular");
  assert.deepEqual(registry.entries()[0].aliases, ["Brand   Regular"]);
  assert.deepEqual(registry.errors, []);
});
