import test from "node:test";
import assert from "node:assert/strict";
import { mediaPosterPath } from "./mediaPoster.js";
import { createLayer, createScene } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";

test("static posters preserve source offsets and reject nonlocal or malformed media paths", () => {
  assert.equal(mediaPosterPath("/api/media/abc.mp4", 2.1234), "/api/media/abc.mp4/poster/2123.png");
  assert.equal(mediaPosterPath("/api/media/abc.webm", -1), "/api/media/abc.webm/poster/0.png");
  assert.equal(mediaPosterPath("/api/media/abc.gif", 86401), "/api/media/abc.gif/poster/86400000.png");
  for (const path of ["https://other.test/movie.mp4", "/api/media/../movie.mp4", "file:///video.mp4", "/api/media/a.mp4?owner=private"])
    assert.equal(mediaPosterPath(path), null);
  assert.equal(mediaPosterPath("/api/media/a.mp4", NaN), null);
});

test("shared SVG renderer draws an authorized static video frame without a video element", () => {
  const layer = createLayer("video", { id: "movie", src: "/api/media/abc.mp4", mediaOffset: 2.5, mediaDuration: 4 });
  const scene = createScene({ layers: [layer] });
  const svg = renderSceneSvg(scene, 0, { videoFrames: new Map([[layer.id, ({ sourceTime }) => `${mediaPosterPath(layer.src, sourceTime)}?share=test-capability`]]) });
  assert.match(svg, /\/poster\/2500\.png\?share=test-capability/);
  assert.doesNotMatch(svg, /<video|foreignObject/);
  assert.throws(() => renderSceneSvg(scene, 0, { videoFrames: new Map([[layer.id, "/api/media/abc.mp4/poster/0.png?owner=private"]]) }), /local|image|media|video|unsupported/i);
});
