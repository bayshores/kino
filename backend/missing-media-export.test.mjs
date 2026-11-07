import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { readImage } from "./media.test.support.mjs";

const localMedia = (filename) => `/api/media/${filename}`;

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "kino-missing-media-"));
  const mediaRoot = path.join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, mediaRoot };
}

function sceneWith(layers) {
  return createScene({
    id: "missing-media-scene",
    name: "Missing media",
    width: 16,
    height: 16,
    duration: 1,
    background: "#000000",
    layers,
  });
}

test("missing local image and video media render transparent, warn by layer and source, and stay transparent in Lottie", async (t) => {
  const { mediaRoot } = await setup(t);
  const imageSource = `${randomUUID()}.png`;
  const videoSource = `${randomUUID()}.mp4`;
  const hiddenSource = `${randomUUID()}.png`;
  const scene = sceneWith([
    createLayer("rectangle", {
      id: "surviving-artwork",
      name: "Surviving artwork",
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      fill: "#22aa66",
      stroke: "#22aa66",
      strokeWidth: 0,
    }),
    createLayer("image", {
      id: "missing-image",
      name: "Missing image",
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      src: localMedia(imageSource),
    }),
    createLayer("video", {
      id: "missing-video",
      name: "Missing video",
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      src: localMedia(videoSource),
    }),
    createLayer("group", { id: "hidden-parent", name: "Hidden parent", visible: false }),
    createLayer("image", {
      id: "hidden-image",
      name: "Hidden missing image",
      parentId: "hidden-parent",
      src: localMedia(hiddenSource),
    }),
  ]);

  const png = await exportScene(scene, { format: "png", time: 0 }, { mediaRoot });
  const image = await readImage(png.buffer);
  assert.deepEqual(image.pixel(8, 8), [34, 170, 102, 255], "transparent missing media preserves the artwork underneath");
  assert.deepEqual(png.warnings.map(({ layerId }) => layerId), ["missing-image", "missing-video"]);
  assert.deepEqual(png.warnings.map(({ source }) => source), [imageSource, videoSource]);
  assert.match(png.warnings[0].message, /Missing image.*missing local media/u);
  assert.match(png.warnings[1].message, /Missing video.*missing local media/u);

  const lottie = await exportScene(scene, { format: "lottie", fps: 1, imageDPIRatio: "1x" }, { mediaRoot });
  assert.deepEqual(lottie.warnings.map(({ layerId }) => layerId), ["missing-image", "missing-video"]);
  const animation = JSON.parse(lottie.buffer.toString("utf8"));
  assert.ok(animation.layers.some(({ nm, ty }) => nm === "Surviving artwork" && ty === 4), "Lottie retains surviving vector content");
});

test("only a missing validated source is nonfatal; unsafe paths, absent media roots, and corrupt GIFs still fail", async (t) => {
  const { root, mediaRoot } = await setup(t);
  await writeFile(path.join(mediaRoot, "broken.gif"), Buffer.from("not a GIF"), { mode: 0o600 });

  await assert.rejects(
    exportScene(sceneWith([createLayer("image", { id: "unsafe", src: "/api/media/../outside.png" })]),
      { format: "png" }, { mediaRoot }),
    /External and SVG media are not loaded/u,
    "path traversal remains fatal",
  );
  await assert.rejects(
    exportScene(sceneWith([createLayer("image", { id: "corrupt", src: localMedia("broken.gif") })]),
      { format: "png" }, { mediaRoot }),
    /cannot draw its GIF/u,
    "corrupt GIF content remains fatal",
  );
  await assert.rejects(
    exportScene(sceneWith([createLayer("image", { id: "missing-store", src: localMedia(`${randomUUID()}.png`) })]),
      { format: "png" }, { mediaRoot: path.join(root, "absent-media-root") }),
    (error) => error.code === "ENOENT",
    "a missing media store is not reported as a missing media file",
  );
});

test("a media layer with no src fails with a message that names the layer and says it has no file", async (t) => {
  const { mediaRoot } = await setup(t);
  for (const type of ["video", "image"]) {
    const label = type === "video" ? "Video" : "Image";
    await assert.rejects(
      exportScene(sceneWith([createLayer(type, { id: "build-target", name: "build-target", src: "", width: 16, height: 16 })]), { format: "png" }, { mediaRoot }),
      (error) => {
        // It used to read: image layer “Video layer “build-target”” must use /api/media/...
        assert.match(error.message, new RegExp(`${label} layer “build-target” has no src`, "u"));
        assert.doesNotMatch(error.message, /layer “\S+ layer/u);
        return true;
      },
    );
  }
  // A src that is not a kino media path names the layer once and says what it should be.
  await assert.rejects(
    exportScene(sceneWith([createLayer("image", { id: "unsafe", name: "logo", src: "/api/media/../outside.png" })]), { format: "png" }, { mediaRoot }),
    (error) => {
      assert.match(error.message, /^Image layer “logo” has src “\/api\/media\/\.\.\/outside\.png”, which is not a kino media path/u);
      return true;
    },
  );
});
