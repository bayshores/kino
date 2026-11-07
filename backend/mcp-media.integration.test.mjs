// An agent's media workflow through the ten tools against the real server: import a GIF, read
// its measured length, give it a Play range with edit, and render stills.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { makeAnimatedGif, near, readImage, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

test("an imported GIF reports measured timing, and a GIF given Play through edit renders by its frame delays", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "kino-mcp-media-"));
  t.after(() => rm(workRoot, { recursive: true, force: true }));
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "mcp-media-test" });
  const agent = async (verb, body) => {
    const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.notEqual(reply.isError, true, `${verb} failed: ${reply.text}`);
    return reply;
  };

  await agent("project", { action: "create", id: "mcp-media", width: 32, height: 32, duration: 3, background: "#ffffff" });

  // Red, green, blue, yellow for 1/10 s each.
  const gifPath = path.join(workRoot, "colors.gif");
  await writeFile(gifPath, makeAnimatedGif({
    width: 8, height: 8, frames: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]].map((color) => ({ color, delayCs: 10 })),
  }));
  const media = await client.importFile(gifPath);
  assert.deepEqual(
    { duration: media.duration, width: media.width, height: media.height, frameCount: media.frameCount, animated: media.animated },
    { duration: 0.4, width: 8, height: 8, frameCount: 4, animated: true },
  );

  const before = await (await server.api("/api/projects/mcp-media")).json();
  await agent("edit", {
    project: "mcp-media",
    ops: [{
      op: "add_layer",
      layerType: "image",
      name: "GIF",
      properties: {
        src: media.src, x: 0, y: 0, width: 32, height: 32,
        mediaStart: 1, mediaDuration: 1, mediaOffset: 0.1, mediaFreeze: "none", mediaSourceDuration: media.duration,
      },
    }],
  });
  assert.equal((await (await server.api("/api/projects/mcp-media")).json()).revision, before.revision + 1);

  // A draft PNG is half the 32x32 scene, so its middle is (8, 8).
  async function renderedPixel(time) {
    const started = await agent("render", { project: "mcp-media", action: "start", format: "png", options: { time } });
    const done = await agent("render", { project: "mcp-media", action: "wait", job: started.data.job, timeout_s: 30 });
    assert.equal(done.data.status, "done", done.text);
    return (await readImage(await readFile(done.data.files[0].path))).pixel(8, 8);
  }
  assert.ok(near(await renderedPixel(0.5), [255, 255, 255, 255]), "hidden before Play");
  assert.ok(near(await renderedPixel(1), [0, 255, 0, 255]), "Play starts at the 0.1 s offset frame (green)");
  assert.ok(near(await renderedPixel(1.45), [0, 255, 0, 255]), "0.55 s into the GIF loops back to green");
  assert.ok(near(await renderedPixel(2.5), [255, 255, 255, 255]), "hidden after Play");
});
