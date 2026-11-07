import test from "node:test";
import assert from "node:assert/strict";
import { createLayer } from "./model.js";
import {
  BACKGROUND_OWNER_ID,
  animationListOf,
  animationOwner,
  animationOwners,
  backgroundAnimationProblem,
  backgroundLayer,
  backgroundPaintAt,
  coverBox,
  isBackgroundEnabled,
  mediaBackgroundLayer,
  setAnimationList,
  withoutBackground,
} from "./sceneBackground.js";

const color = {
  id: "bg-color",
  name: "Color",
  kind: "custom",
  start: 0,
  duration: 1,
  easing: "linear",
  from: { fill: "#000000" },
  to: { fill: "#ffffff" },
};

test("background owner is a complete rectangle view with a reserved ID", () => {
  const scene = {
    width: 960,
    height: 540,
    background: "#336699",
    backgroundAnimations: [color],
  };
  const background = backgroundLayer(scene);
  assert.equal(BACKGROUND_OWNER_ID, "#scene-background");
  assert.deepEqual(Object.keys(background).sort(), Object.keys(createLayer("rectangle")).sort());
  assert.equal(background.id, BACKGROUND_OWNER_ID);
  assert.equal(background.name, "Background");
  assert.deepEqual([background.x, background.y, background.width, background.height], [0, 0, 960, 540]);
  assert.equal(background.fill, scene.background);
  assert.equal(background.fillEnabled, true);
  assert.equal(background.strokeWidth, 0);
  assert.equal(background.animations, scene.backgroundAnimations);
  assert.equal(isBackgroundEnabled({}), true);
  assert.equal(isBackgroundEnabled({ backgroundEnabled: false }), false);
});

test("background paint follows design and playback times, and can be disabled", () => {
  const scene = {
    width: 100,
    height: 50,
    background: "#000000",
    backgroundAnimations: [color],
  };
  assert.equal(backgroundPaintAt(scene, 0), "#000000");
  assert.equal(backgroundPaintAt(scene, 1), "#ffffff");
  assert.equal(backgroundPaintAt(scene, 1, { design: true }), "#000000");
  assert.equal(backgroundPaintAt({ background: "transparent" }, 2), "transparent");
  assert.equal(backgroundPaintAt({ ...scene, backgroundEnabled: false }, 1), null);

  const stripped = withoutBackground(scene);
  assert.equal(stripped.backgroundEnabled, false);
  assert.deepEqual(stripped.backgroundAnimations, []);
  assert.equal(stripped.background, scene.background);
  assert.deepEqual(scene.backgroundAnimations, [color], "the original scene remains unchanged");
});

test("background animation owner helpers read and replace each list immutably", () => {
  const layer = createLayer("rectangle", { id: "shape", animations: [{ id: "shape-animation" }] });
  const scene = { layers: [layer], background: "#ffffff", backgroundAnimations: [color] };
  assert.deepEqual(animationOwners(scene).map((owner) => owner.id), ["shape", BACKGROUND_OWNER_ID]);
  assert.equal(animationOwner(scene, "shape"), layer);
  assert.equal(animationOwner(scene, BACKGROUND_OWNER_ID).name, "Background");
  assert.equal(animationOwner(scene, "missing"), undefined);
  assert.deepEqual(animationListOf(scene, "shape"), layer.animations);
  assert.deepEqual(animationListOf(scene, BACKGROUND_OWNER_ID), [color]);
  assert.deepEqual(animationListOf(scene, "missing"), []);

  const nextBg = [];
  const withBg = setAnimationList(scene, BACKGROUND_OWNER_ID, nextBg);
  assert.equal(withBg.backgroundAnimations, nextBg);
  assert.equal(withBg.layers, scene.layers);
  const nextShape = [];
  const withShape = setAnimationList(scene, "shape", nextShape);
  assert.equal(withShape.layers[0].animations, nextShape);
  assert.equal(withShape.backgroundAnimations, scene.backgroundAnimations);
  assert.throws(() => setAnimationList(scene, "missing", []), /was not found/);
  assert.throws(() => setAnimationList(scene, BACKGROUND_OWNER_ID, null), /must be an array/);
});

test("only Color-shaped animations are permitted on the scene background", () => {
  const scene = { backgroundAnimations: [color] };
  assert.equal(backgroundAnimationProblem(scene, []), null);
  for (const invalid of [
    { ...color, kind: "hide" },
    { ...color, from: { opacity: 0 }, to: { opacity: 1 } },
    { ...color, to: { fill: "#ffffff", opacity: 1 } },
    { ...color, from: {}, to: {} },
  ]) {
    assert.equal(
      backgroundAnimationProblem({ backgroundAnimations: [invalid] }, []),
      "a scene background can only have Color animations",
    );
  }
  assert.equal(backgroundAnimationProblem({ backgroundAnimations: [] }, []), null);
});

test("cover geometry fills the scene while preserving source aspect ratio", () => {
  assert.deepEqual(coverBox({ width: 100, height: 100 }, 200, 100), {
    x: -50,
    y: 0,
    width: 200,
    height: 100,
  });
  assert.deepEqual(coverBox({ width: 100, height: 100 }, 100, 200), {
    x: 0,
    y: -50,
    width: 100,
    height: 200,
  });
  assert.deepEqual(coverBox({ width: 100, height: 50 }, 0, 20), {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
});

test("media background is a locked, bottom-ready image or cover-sized video layer", () => {
  const scene = { width: 100, height: 100, duration: 4 };
  const image = mediaBackgroundLayer(scene, { type: "image", src: "/api/media/still.png", width: 200, height: 80 });
  assert.equal(image.type, "image");
  assert.equal(image.name, "Background");
  assert.equal(image.parentId, null);
  assert.equal(image.locked, true);
  assert.deepEqual([image.x, image.y, image.width, image.height], [0, 0, 100, 100]);
  assert.equal(image.src, "/api/media/still.png");
  assert.equal(image.animations.length, 0);

  const video = mediaBackgroundLayer(scene, {
    type: "video",
    src: "/api/media/clip.mp4",
    width: 200,
    height: 100,
    sourceDuration: 8,
  });
  assert.deepEqual([video.x, video.y, video.width, video.height], [-50, 0, 200, 100]);
  assert.equal(video.mediaDuration, 4);
  assert.equal(video.mediaSourceDuration, 8);
  assert.equal(video.mediaFreeze, "both");
  assert.match(video.id, /^[a-zA-Z0-9._:-]{1,128}$/);
  assert.throws(() => mediaBackgroundLayer(scene, { type: "audio", src: "/api/media/sound.wav" }), /image or video/);
});
