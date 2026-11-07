// The colour-grading recipes in backend/agent/operations.md (topic color) and the colour example
// in skills/kino/references/color.md, run as written through the agent `edit` verb on a generated test card,
// and checked for what their names promise: teal shadows and warm highlights, a contrasty
// low-saturation picture, red kept while everything else turns grey, and a hue cycle that starts
// on its cue and ends where it began.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { readImage, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const WIDTH = 160;
const HEIGHT = 120;
// Four stripes, sampled at their centres: dark grey, light grey, a red and a green.
const STRIPES = [["dark", "#303030"], ["light", "#D0D0D0"], ["red", "#C83020"], ["green", "#30B040"]];
const SAMPLE_Y = HEIGHT / 2;

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function testCard(project) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  STRIPES.forEach(([, color], index) => { context.fillStyle = color; context.fillRect(index * 40, 0, 40, HEIGHT); });
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST", headers: { "content-type": "image/png", "x-file-name": "test-card.png" }, body: canvas.toBuffer("image/png"),
  });
  assert.equal(upload.status, 201);
  return (await upload.json()).src;
}

/**
 * A project with the test card as an image layer called "footage", then `ops` in one edit.
 * `addFootage` is an add_layer op to send for it instead (its src and size are set to the card's).
 */
async function graded(project, ops, { duration = 2, addFootage } = {}) {
  await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration });
  const src = await testCard(project);
  const footage = addFootage ?? { op: "add_layer", layerType: "image", name: "footage", properties: { x: 0, y: 0 } };
  const added = await agent("edit", { project, ops: [{ ...footage, properties: { ...footage.properties, src, width: WIDTH, height: HEIGHT } }] });
  assert.equal(added.isError, undefined, added.text);
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, undefined, reply.text);
}

/** The stripes' centre pixels, [r, g, b], in a `look` frame at time t. */
async function stripes(project, t = 0.5) {
  const reply = await agent("look", { project, mode: "frame", t, width: WIDTH });
  assert.equal(reply.isError, undefined, reply.text);
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  return Object.fromEntries(STRIPES.map(([name], index) => [name, image.pixel(index * 40 + 20, SAMPLE_Y).slice(0, 3)]));
}

const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb);
const hex = (value) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
const ORIGINAL = Object.fromEntries(STRIPES.map(([name, color]) => [name, hex(color)]));

async function recipes() {
  const guide = await readFile(new URL("./agent/operations.md", import.meta.url), "utf8");
  const section = guide.slice(guide.indexOf("Recipes for common looks"), guide.indexOf("\n## ", guide.indexOf("Recipes for common looks")));
  return Object.fromEntries([...section.matchAll(/^- ([^:]+): (\[.*\])$/gm)].map(([, name, ops]) => [name, JSON.parse(ops)]));
}

test("the guide's colour recipes run as written and grade as their names say", async () => {
  const all = await recipes();
  assert.deepEqual(Object.keys(all), ["teal-orange", "bleach-bypass", "noir-keep-red", "A hue cycle on a beat"]);

  await graded("recipe-teal-orange", all["teal-orange"]);
  const teal = await stripes("recipe-teal-orange");
  assert.ok(teal.dark[2] > teal.dark[0] + 6 && teal.dark[1] > teal.dark[0], `shadows go teal: ${teal.dark}`);
  assert.ok(teal.light[0] > teal.light[2] + 20, `highlights go warm: ${teal.light}`);

  await graded("recipe-bleach-bypass", all["bleach-bypass"]);
  const bleach = await stripes("recipe-bleach-bypass");
  assert.ok(chroma(bleach.red) < chroma(ORIGINAL.red) * 0.8 && chroma(bleach.green) < chroma(ORIGINAL.green) * 0.8, `colours fade: ${bleach.red} ${bleach.green}`);
  assert.ok(bleach.dark[0] < ORIGINAL.dark[0] - 8 && bleach.light[0] > ORIGINAL.light[0] + 4, `contrast rises: ${bleach.dark} ${bleach.light}`);

  await graded("recipe-noir-keep-red", all["noir-keep-red"]);
  const noir = await stripes("recipe-noir-keep-red");
  assert.ok(chroma(noir.red) > 120 && noir.red[0] > noir.red[1] + 100, `red is kept: ${noir.red}`);
  for (const name of ["dark", "light", "green"]) assert.ok(chroma(noir[name]) <= 3, `${name} is grey: ${noir[name]}`);

  // The hue cycle starts on a beat cue: set one, then run the recipe as written.
  await graded("recipe-hue-cycle", [{ op: "set_cues", cues: [{ name: "beat-8", time: 0.5 }] }, ...all["A hue cycle on a beat"]]);
  const before = await stripes("recipe-hue-cycle", 0.25);
  const middle = await stripes("recipe-hue-cycle", 1);
  const afterwards = await stripes("recipe-hue-cycle", 1.75);
  assert.deepEqual(before, ORIGINAL, "nothing changes before the cue");
  assert.ok(middle.red[2] > middle.red[0] && middle.red[1] > middle.red[0], `halfway round, red is cyan: ${middle.red}`);
  assert.deepEqual(afterwards, ORIGINAL, "after a full turn the colours are back");
});

test("color_filter is one op: warm warms, a second filter replaces it, none takes it off", async () => {
  await graded("filter-warm", [{ op: "color_filter", layer: "footage", filter: "warm" }]);
  const warm = await stripes("filter-warm");
  assert.ok(warm.light[0] > warm.light[2] + 15, `warm: ${warm.light}`);
  await agent("edit", { project: "filter-warm", ops: [{ op: "color_filter", layer: "footage", filter: "mono" }] });
  for (const [name, rgb] of Object.entries(await stripes("filter-warm"))) assert.ok(chroma(rgb) <= 3, `${name} is grey: ${rgb}`);
  const record = await (await server.api("/api/projects/filter-warm")).json();
  assert.deepEqual(record.document.scenes[0].layers.find((layer) => layer.name === "footage").animations.map((animation) => animation.name), ["Filter mono", "Filter mono 2"]);
  await agent("edit", { project: "filter-warm", ops: [{ op: "color_filter", layer: "footage", filter: "none" }] });
  assert.deepEqual(await stripes("filter-warm"), ORIGINAL);
});

test("the colour example in the kino skill runs as written: a teal-orange grade with a hue cycle on a cue", async () => {
  const [[addFootage, ...ops]] = jsonBlocks(skillSection("Color grading"));
  assert.deepEqual([addFootage.op, addFootage.name, addFootage.properties.src], ["add_layer", "footage", "/api/media/<footage>.png"]);
  assert.equal(ops.length, 4);
  await graded("skill-color", ops, { duration: 4, addFootage });

  const record = await (await server.api("/api/projects/skill-color")).json();
  const footage = record.document.scenes[0].layers.find((layer) => layer.name === "footage");
  assert.deepEqual(footage.animations.map((animation) => [animation.effect, animation.start]), [["color-wheels", 0], ["hue-saturation", 0], ["hue-saturation", 2]]);

  const graded1 = await stripes("skill-color", 1);
  assert.ok(graded1.dark[2] > graded1.dark[0] && graded1.light[0] > graded1.light[2] + 20, `teal-orange grade: ${graded1.dark} ${graded1.light}`);
  const cycling = await stripes("skill-color", 2.5);
  assert.ok(cycling.red[2] > cycling.red[0], `the hue cycle runs after the drop: ${cycling.red}`);
  assert.deepEqual(await stripes("skill-color", 3.5), graded1, "after the cycle the grade is as before");
});
