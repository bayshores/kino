// Proves every checked-in golden scene can be reconstructed through agent operations, then
// compares a frame returned by the agent's look service with the existing export golden.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { scenes } from "../tests/golden/scenes.mjs";
import { DEFAULT_WIDTH, frameFileName, goldenPath } from "../tests/golden/render.mjs";
import { GOLDEN_LUT, goldenMediaRoot, hasMediaTools } from "../tests/golden/media.mjs";
import { LUT_MIME } from "../engine/effects/colorMath.js";
import { startTestServer } from "./media.test.support.mjs";

// One agent edit takes at most this many operations (backend/agent/translate.mjs), so a big
// fixture is sent as several edits, in order, as an agent would.
const OPS_PER_EDIT = 200;
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

const CHANNEL_TOLERANCE = 8;
const MAX_MISMATCH_RATIO = 0.001;

let server;
before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());

async function agent(verb, input) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: input });
  assert.equal(response.status, 200, `${verb} answers through the agent service`);
  const reply = await response.json();
  assert.notEqual(reply.isError, true, `${verb} failed: ${reply.text ?? JSON.stringify(reply.data)}`);
  return reply;
}

function sceneProperties(scene) {
  const properties = { ...scene };
  delete properties.layers;
  delete properties.isComponent;
  delete properties.backgroundAnimations;
  delete properties.moves;
  return properties;
}

function layerProperties(layer, sources = {}) {
  const properties = { ...layer };
  for (const field of ["type", "parentId", "animations", "componentSceneId", "componentOverrides", "textStyleRanges"])
    delete properties[field];
  if (sources[properties.src]) properties.src = sources[properties.src];
  return properties;
}

// Golden fixtures that play footage name the generated files as /api/media/golden.mp4,
// /api/media/golden.gif and /api/media/golden-subject.webm, and the colour grading fixture's lut effect names GOLDEN_LUT
// (tests/golden/media.mjs). Here the agent imports the same files like any upload, once per
// server, and the layers and lut effects point at the sources the import answered.
let goldenUploads = null;
function uploadGoldenMedia() {
  goldenUploads ??= (async () => {
    const folder = await goldenMediaRoot();
    const sources = {};
    const lutFile = GOLDEN_LUT.slice("/api/media/".length);
    for (const [name, type] of [["golden.mp4", "video/mp4"], ["golden.gif", "image/gif"], ["golden-subject.webm", "video/webm"], [lutFile, LUT_MIME]]) {
      const response = await server.api("/api/media", { method: "POST", headers: { "content-type": type, "x-file-name": name }, body: await readFile(path.join(folder, name)) });
      assert.equal(response.status, 201, await response.clone().text());
      const media = await response.json();
      sources[`/api/media/${name}`] = media.src ?? media.media?.src;
    }
    return sources;
  })();
  return goldenUploads;
}

// A lut effect names its .cube by src in the animation's endpoints (to, and from if given).
function animationWithSources(animation, sources) {
  const endpoint = (values) => (values && sources[values.lut] ? { ...values, lut: sources[values.lut] } : values);
  return { ...animation, ...(animation.from ? { from: endpoint(animation.from) } : {}), ...(animation.to ? { to: endpoint(animation.to) } : {}) };
}

function operationsFor(fixture, initialScene, sources = {}) {
  const document = fixture.document;
  const operations = [];

  // Keep the IDs and order from the golden document. `project create` makes an initial scene,
  // so add the fixture's scenes and remove that temporary scene in the same agent edit.
  for (const scene of document.scenes) {
    operations.push({ op: "add_scene", properties: sceneProperties(scene) });
    if (scene.isComponent) operations.push({ op: "create_component", scene: scene.id });
    if (scene.backgroundAnimations?.length) {
      operations.push({ op: "update_scene", scene: scene.id, properties: { backgroundAnimations: scene.backgroundAnimations } });
    }
  }

  // A layer a move made (it carries the move's tag) is made again by that move op, below.
  const byMove = (layer) => Boolean(layer.move);
  for (const scene of document.scenes) {
    for (const layer of scene.layers.filter((entry) => !byMove(entry))) {
      if (layer.type === "component") {
        operations.push({
          op: "insert_component",
          scene: scene.id,
          component: layer.componentSceneId,
          properties: layerProperties(layer),
        });
      } else {
        operations.push({ op: "add_layer", scene: scene.id, layerType: layer.type, properties: layerProperties(layer, sources) });
      }
    }
  }

  // Set parents only after every layer exists, so the flat list keeps the golden stacking order.
  for (const scene of document.scenes) {
    // Animations a move put on the scene's own layers have IDs that start with the move's id.
    const moveIds = (scene.moves ?? []).map((record) => `${record.id}.`);
    for (const layer of scene.layers.filter((entry) => !byMove(entry))) {
      if (layer.parentId) operations.push({ op: "update_layer", scene: scene.id, layer: layer.id, properties: { parentId: layer.parentId } });
      if (layer.textStyleRanges?.length) {
        for (const range of layer.textStyleRanges) {
          operations.push({ op: "style_text_range", scene: scene.id, layer: layer.id, start: range.start, end: range.end, style: range.style });
        }
      }
      if (layer.type === "component" && layer.componentOverrides) {
        operations.push({ op: "set_component_overrides", scene: scene.id, layer: layer.id, overrides: layer.componentOverrides, replace: true });
      }
      for (const animation of layer.animations.filter((entry) => !moveIds.some((prefix) => entry.id.startsWith(prefix)))) {
        operations.push({ op: "add_animation", scene: scene.id, layer: layer.id, id: animation.id, animation: animationWithSources(animation, sources) });
      }
    }
  }

  // Moves run last, in the order the fixture ran them, through the move op an agent uses.
  for (const scene of document.scenes) {
    for (const record of scene.moves ?? []) operations.push({ op: "move", scene: scene.id, name: record.name, id: record.id, ...record.settings });
  }

  const projectProperties = Object.fromEntries(Object.entries(document).filter(([key]) => ["videoType", "rhythm"].includes(key)));
  if (Object.keys(projectProperties).length) operations.push({ op: "update_project", properties: projectProperties });
  operations.push({ op: "delete_scene", scene: initialScene });
  return operations;
}

async function decodePng(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

function comparePixels(expected, actual) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { mismatched: expected.width * expected.height, ratio: 1, dimensions: `${actual.width}x${actual.height} vs ${expected.width}x${expected.height}` };
  }
  let mismatched = 0;
  for (let offset = 0; offset < expected.data.length; offset += 4) {
    let largest = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      largest = Math.max(largest, Math.abs(expected.data[offset + channel] - actual.data[offset + channel]));
    }
    if (largest > CHANNEL_TOLERANCE) mismatched += 1;
  }
  return { mismatched, ratio: mismatched / (expected.width * expected.height) };
}

function sceneIds(document) {
  return document.scenes.map((scene) => scene.id);
}

function structureFor(document) {
  return {
    id: document.id,
    name: document.name,
    scenes: document.scenes.map((scene) => ({
      ...Object.fromEntries(Object.entries(scene).filter(([key]) => key !== "layers")),
      layers: scene.layers.map((layer) => ({
        id: layer.id,
        type: layer.type,
        parentId: layer.parentId,
        componentSceneId: layer.componentSceneId,
        componentOverrides: layer.componentOverrides,
        animations: layer.animations.map((animation) => animation.id),
      })),
    })),
  };
}

// A sheet tiles several scenes into one golden; its moves are the same move op as the others.
for (const fixture of scenes.filter((entry) => !entry.sheet)) {
  test(`agent reachability and golden frames: ${fixture.name}`, { skip: fixture.media && !hasMediaTools ? "needs ffmpeg and ffprobe" : false }, async () => {
    const sources = fixture.media ? await uploadGoldenMedia() : {};
    const firstScene = fixture.document.scenes[0];
    const created = await agent("project", {
      action: "create",
      id: fixture.document.id,
      name: fixture.document.name,
      width: firstScene.width,
      height: firstScene.height,
      duration: firstScene.duration,
      background: firstScene.background,
    });
    const initialScene = created.data.scene;

    const operations = operationsFor(fixture, initialScene, sources);
    let edited;
    for (let first = 0; first < operations.length; first += OPS_PER_EDIT) {
      edited = await agent("edit", { project: fixture.document.id, ops: operations.slice(first, first + OPS_PER_EDIT) });
    }
    assert.ok(edited.data?.rev > created.data.rev, `${fixture.name} was saved by an agent edit: ${edited.text.slice(0, 600)}`);

    // Read only to verify scene and layer IDs, order, and component metadata after the agent edit.
    const savedResponse = await server.api(`/api/projects/${fixture.document.id}`);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual(sceneIds(saved.document), sceneIds(fixture.document), "scene IDs and scene order are preserved");
    assert.deepEqual(structureFor(saved.document), structureFor(fixture.document), "layer IDs/order, parent links, component metadata, and animation IDs are preserved");

    // tests/golden-frames.test.mjs already checks every golden time through the export, and the
    // agent's ops copy each animation whole, so one time (the middle one, mid-animation) shows
    // that the scene the agent built is the golden scene.
    for (const time of [fixture.times[Math.floor(fixture.times.length / 2)]]) {
      const fileName = frameFileName(fixture, time);
      const look = await agent("look", {
        project: fixture.document.id,
        mode: "frame",
        scene: fixture.document.scenes[0].id,
        t: time,
        width: fixture.width ?? DEFAULT_WIDTH,
      });
      assert.equal(look.images?.[0]?.mime, "image/png", `${fileName}: look returned a PNG`);
      assert.ok(look.images[0].data, `${fileName}: look included the rendered PNG bytes`);

      const expected = await decodePng(await readFile(goldenPath(fileName)));
      const actual = await decodePng(Buffer.from(look.images[0].data, "base64"));
      const result = comparePixels(expected, actual);
      assert.ok(
        result.ratio <= MAX_MISMATCH_RATIO,
        `${fileName}: ${result.dimensions ?? `${(result.ratio * 100).toFixed(3)}%`} differ; allowed ${MAX_MISMATCH_RATIO * 100}% above ${CHANNEL_TOLERANCE} channel levels (${result.mismatched} pixels)`,
      );
    }
  });
}
