import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { FontRegistry } from "../engine/fonts.js";
import { createLook, RENDERER_VERSION, sceneKey } from "./agent/look.mjs";

const MEDIA_ID = "00000000-0000-4000-8000-000000000042.png";
const FONT_SOURCE = "/api/fonts/look-cache-face.ttf";

function png(color) {
  return Buffer.from(new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`,
  ).render().asPng());
}

function cachedLook(t, mediaRoot, fonts) {
  const directory = path.join(tmpdir(), `kino-look-cache-${process.pid}-${Math.random().toString(16).slice(2)}`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = new Map();
  const requested = [];
  let writes = 0;
  const cache = {
    async get(key) {
      requested.push(key);
      const value = entries.get(key);
      return value ? Buffer.from(value) : null;
    },
    async set(key, buffer) {
      writes += 1;
      entries.set(key, Buffer.from(buffer));
    },
  };
  return { look: createLook({ cache, outDirectory: directory, mediaRoot }), entries, requested, get writes() { return writes; }, fonts };
}

test("look frames invalidate when media bytes change at the same URL and still hit when unchanged", async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-look-media-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const mediaPath = path.join(mediaRoot, MEDIA_ID);
  await writeFile(mediaPath, png("#f02020"));
  const scene = createScene({
    id: "look-media-cache-scene",
    width: 8,
    height: 8,
    duration: 1,
    background: "#ffffff",
    layers: [createLayer("image", {
      id: "photo",
      name: "Photo",
      src: `/api/media/${MEDIA_ID}`,
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    })],
  });
  const fonts = new FontRegistry();
  const prepared = { scene, fonts, key: sceneKey(scene, fonts) };
  const cached = cachedLook(t, mediaRoot, fonts);
  const { look, requested } = cached;

  const first = await look.frameImage(prepared, { time: 0, width: 8 });
  const repeated = await look.frameImage(prepared, { time: 0, width: 8 });
  assert.equal(requested[0], requested[1], "identical output requests use one frame key");
  assert.equal(cached.writes, 1, "the unchanged second request is served from the frame cache");
  assert.deepEqual(repeated.png, first.png);

  await writeFile(mediaPath, png("#2020f0"));
  const changed = await look.frameImage(prepared, { time: 0, width: 8 });
  assert.notEqual(requested[2], requested[1], "same media URL with different bytes gets a different key");
  assert.equal(cached.writes, 2, "changed media is rendered and replaces neither prior key nor output");
  assert.notDeepEqual(changed.png, first.png, "the rendered PNG reflects the replacement media");

  const changedAgain = await look.frameImage(prepared, { time: 0, width: 8 });
  assert.equal(requested[3], requested[2]);
  assert.equal(cached.writes, 2, "the new media content also becomes cacheable");
  assert.deepEqual(changedAgain.png, changed.png);
});

test("look frames invalidate when font bytes change under the same face identity", async (t) => {
  const inter = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const montserrat = await readFile(new URL("../assets/fonts/Montserrat-400.woff2", import.meta.url));
  const fonts = new FontRegistry();
  const fontMetadata = { id: "stable-face", family: "LookCacheFace", weight: 400, style: "normal", src: FONT_SOURCE };
  fonts.register(inter, fontMetadata);
  const scene = createScene({
    id: "look-font-cache-scene",
    width: 180,
    height: 60,
    duration: 1,
    background: "#ffffff",
    layers: [createLayer("text", {
      id: "title",
      name: "Title",
      text: "Cache face",
      fontFamily: "LookCacheFace",
      fontSource: FONT_SOURCE,
      fontSize: 34,
      fontWeight: 400,
      fontStyle: "normal",
      fill: "#111111",
      x: 4,
      y: 2,
      width: 172,
      height: 56,
    })],
  });
  const prepared = { scene, fonts, key: sceneKey(scene, fonts) };
  const originalPreparedKey = prepared.key;
  const cached = cachedLook(t, undefined, fonts);
  const { look, requested } = cached;

  const first = await look.frameImage(prepared, { time: 0, width: 180 });
  fonts.register(montserrat, fontMetadata);
  assert.equal(sceneKey(scene, fonts), originalPreparedKey, "legacy sceneKey keeps the same name/identity result");

  const changed = await look.frameImage(prepared, { time: 0, width: 180 });
  assert.notEqual(requested[0], requested[1], "font bytes under the same face ID and source get a different key");
  assert.equal(cached.writes, 2, "changed font bytes are re-rendered");
  assert.notDeepEqual(changed.png, first.png, "the rendered PNG reflects the replacement font outlines");

  const unchanged = await look.frameImage(prepared, { time: 0, width: 180 });
  assert.equal(requested[2], requested[1]);
  assert.equal(cached.writes, 2, "unchanged font bytes hit the cache");
  assert.deepEqual(unchanged.png, changed.png);
});

test("a sheet draws its uncached tiles in one render, the same pixels frame draws", async (t) => {
  const scene = createScene({
    id: "look-sheet-batch-scene", width: 64, height: 36, duration: 2, background: "#ffffff",
    layers: [createLayer("rectangle", { id: "box", name: "Box", x: 8, y: 8, width: 16, height: 16, fill: "#e02020" })],
  });
  const fonts = new FontRegistry();
  const prepared = { scene, fonts, key: sceneKey(scene, fonts) };
  const cached = cachedLook(t, undefined, fonts);
  const single = await cached.look.frameImage(prepared, { time: 0.5, width: 64 });
  assert.equal(cached.writes, 1);
  const drawn = await cached.look.frames(prepared, [0, 0.5, 1.5], 64);
  assert.equal(cached.writes, 3, "only the two uncached times are drawn");
  assert.deepEqual(drawn.map((entry) => entry.cached), [false, true, false]);
  assert.deepEqual(drawn[1].png, single.png);
  const alone = createLook({ cache: { get: async () => null, set: async () => {} }, outDirectory: tmpdir() });
  assert.deepEqual((await alone.frame(prepared, 1.5, 64)).png, drawn[2].png, "a tile drawn with the others is the frame drawn alone");
});

test("agent look cache renderer version is bumped for asset-aware keys", () => {
  assert.equal(RENDERER_VERSION, "a6.2");
});
