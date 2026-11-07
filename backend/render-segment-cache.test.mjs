import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FontRegistry } from "../engine/fonts.js";
import { createSegmentCache, renderContentKey } from "./render-segment-cache.mjs";
import { graphicsCacheInput } from "./render-devices.mjs";
import { createExportBatches } from "./export-batches.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "kino-segment-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = createSegmentCache({ directory: path.join(root, "cache"), ...options });
  t.after(() => cache.close());
  return { root, cache };
}

function contentKey(scene, options = {}, extra = {}) {
  return renderContentKey(scene, options, { scope: "project-1:owner", ...extra });
}

test("content keys canonicalize object properties and include scene, options, and scope", async () => {
  const first = { id: "scene", layers: [{ id: "a", x: 10, y: 20 }] };
  const reordered = { layers: [{ y: 20, x: 10, id: "a" }], id: "scene" };
  const key = await contentKey(first, { format: "png", time: 0 });
  assert.equal(await contentKey(reordered, { time: 0, format: "png" }), key);
  assert.notEqual(await contentKey(first, { format: "png", time: 1 }), key);
  assert.notEqual(await renderContentKey(first, { format: "png", time: 0 }, { scope: "project-2:owner" }), key);
  assert.notEqual(await contentKey({ ...first, layers: [{ id: "a", x: 11, y: 20 }] }, { format: "png", time: 0 }), key);
});

test("content keys include the graphics setting when given, since the card changes Chromium's pixels", async () => {
  const scene = { id: "scene", layers: [{ id: "a", x: 10, y: 20 }] };
  const key = await contentKey(scene, { format: "png", time: 0 });
  const auto = await contentKey(scene, { format: "png", time: 0 }, { graphics: graphicsCacheInput("auto", {}) });
  assert.notEqual(auto, key);
  assert.equal(await contentKey(scene, { format: "png", time: 0 }, { graphics: graphicsCacheInput("auto", {}) }), auto);
  assert.notEqual(await contentKey(scene, { format: "png", time: 0 }, { graphics: graphicsCacheInput("processor", {}) }), auto);
  assert.notEqual(await contentKey(scene, { format: "png", time: 0 }, { graphics: graphicsCacheInput("auto", { KINO_RASTER_GPU: "off" }) }), auto);
  // A card variable the person set, or leaving WSLg's display, is another device: another key.
  // Two of xvfb-run -a's display numbers draw alike, so they share one.
  const wsl = { files: (file) => file === "/dev/dxg" || file === "/tmp/.X11-unix/X0" };
  const keyWith = (env) => contentKey(scene, { format: "png", time: 0 }, { graphics: graphicsCacheInput("auto", env, wsl) });
  const wslg = await keyWith({ DISPLAY: ":0" });
  assert.notEqual(await keyWith({ DISPLAY: ":0", MESA_D3D12_DEFAULT_ADAPTER_NAME: "Intel" }), wslg);
  assert.notEqual(await keyWith({ DISPLAY: ":0", GALLIUM_DRIVER: "llvmpipe" }), wslg);
  const xvfb = await keyWith({ DISPLAY: ":99" });
  assert.notEqual(xvfb, wslg);
  assert.equal(await keyWith({ DISPLAY: ":100" }), xvfb);
});

test("same media URL invalidates on byte replacement and a missing upload gets a new key when restored", async (t) => {
  const { root } = await fixture(t);
  const mediaRoot = path.join(root, "media");
  await mkdir(mediaRoot);
  const id = "00000000-0000-4000-8000-000000000042.png";
  const scene = { layers: [{ id: "photo", type: "image", src: `/api/media/${id}` }] };
  const missing = await contentKey(scene, { format: "png" }, { mediaRoot });
  const file = path.join(mediaRoot, id);
  await writeFile(file, Buffer.from("first image bytes"));
  const first = await contentKey(scene, { format: "png" }, { mediaRoot });
  assert.notEqual(first, missing);
  await writeFile(file, Buffer.from("replacement image bytes"));
  const second = await contentKey(scene, { format: "png" }, { mediaRoot });
  assert.notEqual(second, first);
  assert.equal(await contentKey(scene, { format: "png" }, { mediaRoot }), second);
});

test("a remembered media digest is dropped when the file is rewritten with bytes of the same length", async (t) => {
  const { root } = await fixture(t);
  const mediaRoot = path.join(root, "media");
  await mkdir(mediaRoot);
  const id = "00000000-0000-4000-8000-000000000043.mp4";
  const scene = { layers: [{ id: "clip", type: "video", src: `/api/media/${id}` }] };
  const file = path.join(mediaRoot, id);
  await writeFile(file, Buffer.alloc(4096, 1));
  const first = await contentKey(scene, { format: "png", time: 0 }, { mediaRoot });
  // A sheet asks for one key per frame; the file's digest is remembered between them.
  assert.notEqual(await contentKey(scene, { format: "png", time: 1 }, { mediaRoot }), first);
  assert.equal(await contentKey(scene, { format: "png", time: 0 }, { mediaRoot }), first);
  await writeFile(file, Buffer.alloc(4096, 2));
  const rewritten = await contentKey(scene, { format: "png", time: 0 }, { mediaRoot });
  assert.notEqual(rewritten, first, "same length, different bytes");
  await rm(file);
  await writeFile(file, Buffer.alloc(4096, 1));
  assert.equal(await contentKey(scene, { format: "png", time: 0 }, { mediaRoot }), first, "the original bytes again, in a new file");
});

test("font keys use loaded font bytes even when face identity and source stay fixed", async (t) => {
  const inter = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const montserrat = await readFile(new URL("../assets/fonts/Montserrat-400.woff2", import.meta.url));
  const fonts = new FontRegistry();
  const metadata = { id: "same-face", family: "Cache Face", weight: 400, style: "normal", src: "/api/fonts/same-face.ttf" };
  fonts.register(inter, metadata);
  const scene = { layers: [{ id: "text", type: "text", text: "cache key" }] };
  const first = await contentKey(scene, { format: "png" }, { fonts });
  fonts.register(montserrat, metadata);
  const second = await contentKey(scene, { format: "png" }, { fonts });
  assert.notEqual(second, first);
});

test("store and restore stream a file, sanitize persisted paths, and return the current output path", async (t) => {
  const { root, cache } = await fixture(t);
  const key = "a".repeat(64);
  const source = path.join(root, "render.zip");
  const destination = path.join(root, "restored.zip");
  const bytes = Buffer.alloc(128 * 1024, 0x5a);
  await writeFile(source, bytes);
  assert.equal(await cache.store(key, source, {
    mime: "application/zip", extension: "zip", sequenceDirectory: "/old/private/frames", path: "/old/private/output.zip",
  }), true);

  const restored = await cache.restore(key, destination);
  assert.equal(restored.path, destination);
  assert.equal(restored.size, bytes.length);
  assert.equal(restored.cacheHit, true);
  assert.equal(restored.extension, "zip");
  assert.equal("sequenceDirectory" in restored, false);
  assert.deepEqual(await readFile(destination), bytes);
});

test("checksum corruption is a cache miss and never publishes a partial destination", async (t) => {
  const { root, cache } = await fixture(t);
  const key = "b".repeat(64);
  const source = path.join(root, "original.png");
  await writeFile(source, Buffer.alloc(4096, 0x12));
  assert.equal(await cache.store(key, source, { mime: "image/png" }), true);
  const shard = path.join(root, "cache", key.slice(0, 2), key);
  await writeFile(path.join(shard, "artifact"), Buffer.alloc(4096, 0x34));
  const destination = path.join(root, "should-not-exist.png");
  assert.equal(await cache.restore(key, destination), null);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

test("folder sequences and artifacts larger than the cache budget are skipped", async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 2048 });
  const frames = path.join(root, "frames");
  await mkdir(frames);
  await writeFile(path.join(frames, "frame-000000.png"), "frame");
  assert.equal(await cache.store("c".repeat(64), frames, { extension: "png-sequence" }), false);
  const large = path.join(root, "large.zip");
  await writeFile(large, Buffer.alloc(4096));
  assert.equal(await cache.store("d".repeat(64), large, { extension: "zip" }), false);
  const output = path.join(root, "out");
  assert.equal(await cache.restore("c".repeat(64), output), null);
});

test("disk budget evicts least-recently-used entries while keeping the restored entry", async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 1200 });
  const first = path.join(root, "first.bin");
  const second = path.join(root, "second.bin");
  const third = path.join(root, "third.bin");
  await Promise.all([
    writeFile(first, Buffer.alloc(300, 1)),
    writeFile(second, Buffer.alloc(300, 2)),
    writeFile(third, Buffer.alloc(300, 3)),
  ]);
  const keys = ["1", "2", "3"].map((value) => value.repeat(64));
  assert.equal(await cache.store(keys[0], first, { name: "first" }), true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 8));
  assert.equal(await cache.store(keys[1], second, { name: "second" }), true);
  const touched = await cache.restore(keys[0], path.join(root, "touch.bin"));
  assert.equal(touched.name, "first");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 8));
  assert.equal(await cache.store(keys[2], third, { name: "third" }), true);
  assert.equal((await cache.restore(keys[0], path.join(root, "first-again.bin")))?.name, "first");
  assert.equal(await cache.restore(keys[1], path.join(root, "second-again.bin")), null);
  assert.equal((await cache.restore(keys[2], path.join(root, "third-again.bin")))?.name, "third");
});

test("cache root and generation symlinks are not followed", async (t) => {
  const { root, cache } = await fixture(t);
  const target = path.join(root, "target");
  await mkdir(target);
  const linkedRoot = path.join(root, "linked-cache");
  await symlink(target, linkedRoot, "dir");
  const linkedCache = createSegmentCache({ directory: linkedRoot });
  t.after(() => linkedCache.close());
  const source = path.join(root, "source.bin");
  await writeFile(source, "safe data");
  await assert.rejects(linkedCache.store("e".repeat(64), source, {}), /not a symlink/);

  const key = "f".repeat(64);
  const cacheRoot = path.join(root, "cache");
  await mkdir(path.join(cacheRoot, key.slice(0, 2)), { recursive: true });
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "do-not-delete"), "still here");
  await symlink(outside, path.join(cacheRoot, key.slice(0, 2), key), "dir");
  assert.equal(await cache.restore(key, path.join(root, "linked-output")), null);
  assert.equal(await readFile(path.join(outside, "do-not-delete"), "utf8"), "still here");
});

test("cancellation propagates and close rejects new requests", async (t) => {
  const { root, cache } = await fixture(t);
  const source = path.join(root, "render.bin");
  await writeFile(source, "render");
  const controller = new AbortController();
  const reason = Object.assign(new Error("stop render cache"), { name: "AbortError" });
  controller.abort(reason);
  await assert.rejects(cache.store("9".repeat(64), source, {}, { signal: controller.signal }), /stop render cache/);
  await cache.close();
  await assert.rejects(cache.key({ id: "closed" }, {}, { scope: "project" }), /closed/);
});

test("same-key concurrent stores publish one valid entry", async (t) => {
  const { root, cache } = await fixture(t);
  const key = "0".repeat(64);
  const sourceA = path.join(root, "a.png");
  const sourceB = path.join(root, "b.png");
  await Promise.all([writeFile(sourceA, Buffer.alloc(64 * 1024, 1)), writeFile(sourceB, Buffer.alloc(64 * 1024, 1))]);
  const results = await Promise.all([
    cache.store(key, sourceA, { extension: "png" }),
    cache.store(key, sourceB, { extension: "png" }),
  ]);
  assert.deepEqual(results, [true, true]);
  const output = path.join(root, "published.png");
  assert.equal((await cache.restore(key, output))?.extension, "png");
  assert.deepEqual(await readFile(output), await readFile(sourceA));
});

test("usage counts the entries and their bytes, and clear empties the cache", async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 64 * 1024 });
  assert.deepEqual(await cache.usage(), { entries: 0, bytes: 0, limitBytes: 64 * 1024 });
  const keys = ["a", "b"].map((value) => value.repeat(64));
  for (const [index, key] of keys.entries()) {
    const file = path.join(root, `${index}.bin`);
    await writeFile(file, Buffer.alloc(1000, index + 1));
    assert.equal(await cache.store(key, file, { name: key.slice(0, 1) }), true);
  }
  const usage = await cache.usage();
  assert.equal(usage.entries, 2);
  assert.ok(usage.bytes > 2000 && usage.bytes < 4000, `artifacts and their manifests: ${usage.bytes} bytes`);
  assert.deepEqual(await cache.clear(), { removed: 2, inUse: 0 });
  assert.deepEqual(await cache.usage(), { entries: 0, bytes: 0, limitBytes: 64 * 1024 });
  assert.equal(await cache.restore(keys[0], path.join(root, "gone.bin")), null);
});

test("clear leaves an entry that is being restored right now, and the restore finishes", async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 128 * 1024 * 1024 });
  const big = path.join(root, "big.bin");
  const small = path.join(root, "small.bin");
  // Large enough that copying it out takes far longer than clear's look at the folder.
  await writeFile(big, Buffer.alloc(48 * 1024 * 1024, 7));
  await writeFile(small, Buffer.alloc(100, 8));
  const busy = "e".repeat(64);
  const idle = "f".repeat(64);
  assert.equal(await cache.store(busy, big, { name: "busy" }), true);
  assert.equal(await cache.store(idle, small, { name: "idle" }), true);
  await rm(big);
  const restoring = cache.restore(busy, path.join(root, "restored.bin"));
  const cleared = await cache.clear();
  assert.deepEqual(cleared, { removed: 1, inUse: 1 });
  assert.equal((await restoring)?.name, "busy");
  assert.equal((await readFile(path.join(root, "restored.bin"))).length, 48 * 1024 * 1024);
  await rm(path.join(root, "restored.bin"));
  assert.equal((await cache.usage()).entries, 1, "the entry in use is still there");
  assert.equal(await cache.restore(idle, path.join(root, "idle.bin")), null, "the idle entry was removed");
});

test("lowering the limit removes the oldest entries at once, and a bad limit is refused", async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 64 * 1024 });
  const keys = ["1", "2", "3"].map((value) => value.repeat(64));
  for (const [index, key] of keys.entries()) {
    const file = path.join(root, `${index}.bin`);
    await writeFile(file, Buffer.alloc(1000, index + 1));
    assert.equal(await cache.store(key, file, { name: String(index) }), true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 8));
  }
  assert.equal((await cache.usage()).entries, 3);
  // Room for one entry and its manifest, not two: the two oldest go now, not at the next store.
  assert.equal(await cache.limit(1800), 1800);
  const usage = await cache.usage();
  assert.equal(usage.entries, 1);
  assert.equal(usage.limitBytes, 1800);
  assert.equal(await cache.restore(keys[0], path.join(root, "first.bin")), null);
  assert.equal(await cache.restore(keys[1], path.join(root, "second.bin")), null);
  assert.equal((await cache.restore(keys[2], path.join(root, "third.bin")))?.name, "2");
  // A larger limit keeps everything and lets new entries in.
  assert.equal(await cache.limit(64 * 1024), 64 * 1024);
  assert.equal(await cache.store(keys[0], path.join(root, "0.bin"), { name: "0" }), true);
  assert.equal((await cache.usage()).entries, 2);
  for (const bad of [0, -1, 1.5, Infinity, "512"]) await assert.rejects(cache.limit(bad), /maxBytes must be a positive safe integer/);
  assert.equal((await cache.usage()).limitBytes, 64 * 1024);
});

test("export batches take the render cache size and expose its usage, clear and limit", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kino-segment-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batches = createExportBatches({ cacheDirectory: path.join(root, "cache"), cacheMaxBytes: 64 * 1024 * 1024 });
  t.after(() => batches.close());
  assert.deepEqual(await batches.renderCache.usage(), { entries: 0, bytes: 0, limitBytes: 64 * 1024 * 1024 });
  assert.equal(await batches.renderCache.limit(128 * 1024 * 1024), 128 * 1024 * 1024);
  assert.equal((await batches.renderCache.usage()).limitBytes, 128 * 1024 * 1024);
  assert.deepEqual(await batches.renderCache.clear(), { removed: 0, inUse: 0 });
  const uncached = createExportBatches();
  t.after(() => uncached.close());
  assert.equal(uncached.renderCache, null, "no cache folder, no render cache");
});
