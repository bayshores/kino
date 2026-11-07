import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

test("real PNG, GIF and MP4 exports keep media borders and a group's fill, child clip and outside stroke", { skip: skipWithoutMediaTools }, async () => {
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>').render().asPng();
  const scene = createScene({ width: 128, height: 96, duration: 0.2, background: "#ffffff", layers: [
    createLayer("image", { id: "photo", x: 16, y: 20, width: 40, height: 40, src: `data:image/png;base64,${png.toString("base64")}`, radius: 14, stroke: "#ff0000", strokeWidth: 8, strokeAlign: "outside" }),
    createLayer("group", { id: "group", x: 80, y: 20, width: 40, height: 40, fillEnabled: true, fill: "#00ff00", radius: 12, clipContent: true, stroke: "#ff8000", strokeWidth: 8, strokeAlign: "outside" }),
    createLayer("rectangle", { id: "child", parentId: "group", x: -10, y: 20, width: 60, height: 40, fill: "#0000ff" }),
  ] });
  const samples = [
    [12, 40, [255, 0, 0]], [30, 40, [0, 0, 255]], [100, 25, [0, 255, 0]],
    [100, 45, [0, 0, 255]], [100, 16, [255, 128, 0]], [70, 50, [255, 255, 255]],
  ];
  for (const format of ["png", "gif", "mp4"]) {
    const result = await exportScene(scene, { format, fps: 10, ...(format === "mp4" ? { profile: "mp4.alt" } : {}) });
    const raw = await run(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
    assert.equal(raw.length, 128 * 96 * 4);
    for (const [x, y, expected] of samples) {
      const actual = [...raw.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
      const tolerance = format === "mp4" ? 32 : 12;
      assert.ok(expected.every((channel, index) => Math.abs(channel - actual[index]) <= tolerance), `${format} pixel ${x},${y}: ${actual} versus ${expected}`);
      assert.equal(actual[3], 255);
    }
  }
});
