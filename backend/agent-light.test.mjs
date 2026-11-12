// The Light recipes in backend/agent/operations.md (topic light) and the light example in
// skills/kino/references/light.md, run as written through the agent `edit` verb on a generated
// picture, and checked for what their names promise: bloom on the bright parts only, a red
// halation, a pink neon, a deep glow that reaches far, a flash on a beat cue, god rays from the
// sun, light behind a title, a horizontal anamorphic streak, a flare that follows its layer, and
// a flare that fades out as its light leaves the picture.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { readImage, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const WIDTH = 320;
const HEIGHT = 180;
// The picture: a dark sky, a bright sun at (240, 45) with three thin dark bars across it (so god
// rays have shadows), a white stripe, and a mid-grey square (not bright enough to glow).
const SUN = { x: 240, y: 45, r: 14 };
const STRIPE = { x: 40, y: 150, width: 240, height: 4 };
const GREY = { x: 20, y: 10, width: 30, height: 30 };

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

function picture() {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#141A24";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#FFF4DA";
  context.beginPath();
  context.arc(SUN.x, SUN.y, SUN.r, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#0B0F14";
  for (const x of [232, 239, 247]) context.fillRect(x, 20, 2, 60);
  context.fillStyle = "#FFFFFF";
  context.fillRect(STRIPE.x, STRIPE.y, STRIPE.width, STRIPE.height);
  context.fillStyle = "#808080";
  context.fillRect(GREY.x, GREY.y, GREY.width, GREY.height);
  return canvas.toBuffer("image/png");
}

/** A project with the picture as "footage", a white "title" and a small "sun" ellipse. */
async function lit(project) {
  await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration: 2 });
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST", headers: { "content-type": "image/png", "x-file-name": "sky.png" }, body: picture(),
  });
  assert.equal(upload.status, 201);
  const { src } = await upload.json();
  const added = await agent("edit", { project, ops: [
    { op: "add_layer", layerType: "image", name: "footage", properties: { src, x: 0, y: 0, width: WIDTH, height: HEIGHT } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "LIGHT", x: 40, y: 70, width: 160, height: 44, fontSize: 36, fontWeight: 800, fill: "#FFFFFF", textAlign: "center" } },
    { op: "add_layer", layerType: "ellipse", name: "sun", properties: { x: 150, y: 10, width: 20, height: 20, fill: "#FFF6E0" } },
  ] });
  assert.equal(added.isError, undefined, added.text);
}

async function edit(project, ops) {
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data?.fixed, undefined, `kino had to fix the recipe: ${reply.data?.fixed}`);
}

async function frame(project, t = 1) {
  const reply = await agent("look", { project, mode: "frame", t, width: WIDTH });
  assert.equal(reply.isError, undefined, reply.text);
  return readImage(Buffer.from(reply.images[0].data, "base64"));
}

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** How much brighter (luma) `after` is than `before` at (x, y). */
const gain = (before, after, x, y) => luma(after.pixel(x, y)) - luma(before.pixel(x, y));
/** The per-channel change at (x, y). */
const change = (before, after, x, y) => after.pixel(x, y).slice(0, 3).map((value, channel) => value - before.pixel(x, y)[channel]);

function largestDifference(a, b) {
  let largest = 0;
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1)
    a.pixel(x, y).forEach((value, channel) => { largest = Math.max(largest, Math.abs(value - b.pixel(x, y)[channel])); });
  return largest;
}

// A glow of strength 0 changes nothing, but puts the scene on the effects renderer.
const OFF = { op: "add_animation", layer: "footage", effect: "glow", parameters: { strength: 0 } };

async function recipes() {
  const guide = await readFile(new URL("./agent/operations.md", import.meta.url), "utf8");
  const start = guide.indexOf("Light recipes");
  const section = guide.slice(start, guide.indexOf("\n## ", start));
  return Object.fromEntries([...section.matchAll(/^- ([^:]+): (\[.*\])$/gm)].map(([, name, ops]) => [name, JSON.parse(ops)]));
}

test("the guide's light recipes run as written and light the picture as their names say", { timeout: 300_000 }, async () => {
  const all = await recipes();
  assert.deepEqual(Object.keys(all), ["bloom", "deep-glow", "neon", "subject-rim", "electric-outline", "halation", "beat-flash", "god-rays",
    "light-behind-title", "anamorphic-flare", "sun-flare", "flare-sweep"]);

  // The picture without light, drawn by the same renderer: a scene with any effect is drawn by
  // Chromium, one without by Resvg, and the two anti-alias edges a little differently.
  await lit("light-plain");
  await edit("light-plain", [OFF]);
  const plain = await frame("light-plain");

  // Glows: bloom picks the bright stripe and leaves the grey square alone.
  await lit("light-bloom");
  await edit("light-bloom", all.bloom);
  const bloom = await frame("light-bloom");
  const aboveStripe = gain(plain, bloom, 160, STRIPE.y - 4);
  assert.ok(aboveStripe > 8, `the stripe blooms: +${aboveStripe}`);
  assert.ok(Math.abs(gain(plain, bloom, GREY.x + GREY.width / 2, GREY.y + GREY.height / 2)) < 3, "the grey square is under the threshold");

  await lit("light-halation");
  await edit("light-halation", all.halation);
  const halation = change(plain, await frame("light-halation"), 160, STRIPE.y - 5);
  assert.ok(halation[0] > 10 && halation[0] > 2 * halation[2], `the halation is red: ${halation}`);

  await lit("light-neon");
  await edit("light-neon", all.neon);
  const neon = await frame("light-neon");
  // Just above the letters' tops: the glow is pink (red over blue over green).
  const pink = change(plain, neon, 120, 74);
  assert.ok(pink[0] > 30 && pink[0] > pink[1] + 20 && pink[2] > pink[1], `the neon glow is pink: ${pink}`);

  // The electric outline: a purple ring just above the letters' tops.
  await lit("light-electric-outline");
  await edit("light-electric-outline", all["electric-outline"]);
  const ring = change(plain, await frame("light-electric-outline"), 120, 74);
  assert.ok(ring[2] > 10 && ring[2] > ring[1], `the outline is purple: ${ring}`);

  await lit("light-deep-glow");
  await edit("light-deep-glow", all["deep-glow"]);
  const deep = await frame("light-deep-glow");
  // 40 pixels above the title the deep glow still shows; the neon's short glow does not.
  const far = [120, 40];
  assert.ok(gain(plain, deep, ...far) > 3 + Math.max(0, gain(plain, neon, ...far)), `the deep glow reaches far: +${gain(plain, deep, ...far)} against +${gain(plain, neon, ...far)}`);

  // A flash on a beat: nothing before the cue, a bright title just after it, nothing after.
  await lit("light-beat-flash");
  await edit("light-beat-flash", [{ op: "set_cues", cues: [{ name: "beat-8", time: 0.5 }] }, ...all["beat-flash"]]);
  assert.equal(largestDifference(plain, await frame("light-beat-flash", 0.25)), 0, "nothing before the cue");
  const flash = await frame("light-beat-flash", 0.5);
  assert.ok(gain(plain, flash, 120, 66) > 40, `the title flashes on the cue: +${gain(plain, flash, 120, 66)}`);
  assert.equal(largestDifference(plain, await frame("light-beat-flash", 1.2)), 0, "nothing after the flash");

  // God rays: light streams out from the sun past its edge, brighter in the gaps than the bars.
  await lit("light-god-rays");
  await edit("light-god-rays", all["god-rays"]);
  const rays = await frame("light-god-rays");
  const below = gain(plain, rays, SUN.x - 6, SUN.y + 24);
  assert.ok(below > 8, `rays reach below the sun: +${below}`);
  assert.ok(gain(plain, rays, 10, 60) < 2, "the far left, with no bright part between it and the sun, stays dark");

  await lit("light-behind-title");
  await edit("light-behind-title", all["light-behind-title"]);
  const behind = await frame("light-behind-title");
  const aroundTitle = gain(plain, behind, 120, 66);
  assert.ok(aroundTitle > 20, `light shines out from behind the title: +${aroundTitle}`);

  // Anamorphic flare at (240, 45): a horizontal streak, much brighter beside the light than above it.
  await lit("light-anamorphic");
  await edit("light-anamorphic", all["anamorphic-flare"]);
  const streak = await frame("light-anamorphic");
  const beside = gain(plain, streak, SUN.x - 70, SUN.y);
  const aboveLight = gain(plain, streak, SUN.x, SUN.y + 70);
  assert.ok(beside > 15 && beside > 3 * Math.max(1, aboveLight), `the streak is horizontal: +${beside} beside, +${aboveLight} below`);
  const blue = change(plain, streak, SUN.x - 70, SUN.y);
  assert.ok(blue[2] > blue[0], `the streak takes the recipe's blue: ${blue}`);

  // A flare on the sun layer follows it: its core moves with the layer.
  await lit("light-sun-flare");
  await edit("light-sun-flare", all["sun-flare"]);
  const flare = await frame("light-sun-flare");
  assert.ok(gain(plain, flare, 160, 36) > 20, "the flare glows around the sun");
  // The ghosts lie on the line from the sun through the middle: below the middle, not beside it.
  const ghosts = Math.max(...[110, 120, 130, 140].map((y) => gain(plain, flare, 160, y)));
  assert.ok(ghosts > 4, `ghosts below the middle: +${ghosts}`);
  await edit("light-sun-flare", [{ op: "update_layer", layer: "sun", properties: { x: 30, y: 120 } }]);
  const moved = await frame("light-sun-flare");
  const movedPlain = await (async () => {
    await lit("light-sun-moved");
    await edit("light-sun-moved", [OFF, { op: "update_layer", layer: "sun", properties: { x: 30, y: 120 } }]);
    return frame("light-sun-moved");
  })();
  assert.ok(gain(movedPlain, moved, 40, 116) > 20, "the flare moved with the sun");
  assert.ok(gain(movedPlain, moved, 160, 6) < 10, "and left its old place");

  // A flare that sweeps across: bright halfway, gone once its light is past the right edge.
  await lit("light-flare-sweep");
  await edit("light-flare-sweep", all["flare-sweep"]);
  const halfway = await frame("light-flare-sweep", 1);
  assert.ok(largestDifference(plain, halfway) > 60, "the flare shows halfway");
  assert.equal(largestDifference(plain, await frame("light-flare-sweep", 1.95)), 0, "it fades out when the light leaves the picture");
});

test("a glow on a dark picture without a threshold measures the picture: the receipt says the threshold and the glow shows", { timeout: 120_000 }, async (t) => {
  // Mean luma 35: a dark ground, a mid-tone band and one 30 px highlight at (200, 60).
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#1E1E1E";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#3C3C3C";
  context.fillRect(0, 120, WIDTH, 20);
  context.fillStyle = "#5A5A5A";
  context.fillRect(200, 60, 30, 30);
  const glow = { strength: 1, radius: 12, color: "#FF5A1F", colorMix: 0.7 };
  const replies = {};
  for (const [project, parameters] of [["glow-dark-fixed", { ...glow, threshold: 0.7 }], ["glow-dark-auto", glow]]) {
    await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration: 1 });
    const upload = await server.api(`/api/media?project=${project}`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "dark.png" }, body: canvas.toBuffer("image/png") });
    const { src } = await upload.json();
    replies[project] = await agent("edit", { project, ops: [
      { op: "add_layer", layerType: "image", name: "footage", properties: { src, x: 0, y: 0, width: WIDTH, height: HEIGHT } },
      { op: "add_animation", layer: "footage", effect: "glow", parameters } ] });
    assert.equal(replies[project].isError, undefined, replies[project].text);
  }
  const notes = (project) => (replies[project].data.notes ?? []).filter((note) => note.includes("threshold auto measured"));
  assert.equal(notes("glow-dark-fixed").length, 0, "a number is not measured");
  assert.match(notes("glow-dark-auto")[0] ?? "", /threshold auto measured 0\.\d\d/);
  const fixed = await frame("glow-dark-fixed", 0.5), auto = await frame("glow-dark-auto", 0.5);
  t.diagnostic(`${notes("glow-dark-auto")[0]} | beside: ${change(fixed, auto, 194, 75)}, on: ${change(fixed, auto, 215, 75)}`);
  // 6 px left of the highlight: no change at 0.7, the orange glow with auto.
  assert.ok(gain(fixed, auto, 194, 75) > 8 && change(fixed, auto, 194, 75)[0] > change(fixed, auto, 194, 75)[2], `auto glows orange beside the highlight: ${change(fixed, auto, 194, 75)}`);
});

test("the light example in the kino skill runs as written: a glowing title with light behind it, a flare on the sun and a flash on a cue", { timeout: 120_000 }, async () => {
  const [ops] = jsonBlocks(skillSection("Light: glow, rays and flares"));
  const layers = ops.filter((entry) => entry.op === "add_layer");
  assert.deepEqual(layers.map((entry) => entry.name), ["sky", "sun", "title"]);
  const look = async (project, t) => {
    const reply = await agent("look", { project, mode: "frame", t, width: 480 });
    assert.equal(reply.isError, undefined, reply.text);
    return readImage(Buffer.from(reply.images[0].data, "base64"));
  };
  const off = { op: "add_animation", layer: "sky", effect: "glow", parameters: { strength: 0 } };
  for (const [project, list] of [["skill-light-plain", [...layers, off]], ["skill-light", ops]]) {
    await agent("project", { action: "create", id: project, name: project, width: 1920, height: 1080, duration: 3 });
    await edit(project, list);
  }
  const record = await (await server.api("/api/projects/skill-light")).json();
  const effects = record.document.scenes[0].layers.flatMap((layer) => (layer.animations ?? []).map((animation) => [layer.name, animation.effect, animation.start]));
  assert.deepEqual(effects, [["sun", "lens-flare", 0], ["title", "glow", 0], ["title", "light-rays", 0], ["title", "glow", 1]]);
  const plain = await look("skill-light-plain", 0.5);
  const before = await look("skill-light", 0.5);
  const flash = await look("skill-light", 1.05);
  // Around the title (x 240 of 480, just above the letters): lit before the cue, brighter on it.
  assert.ok(gain(plain, before, 240, 105) > 20, `the title glows: +${gain(plain, before, 240, 105)}`);
  assert.ok(gain(before, flash, 240, 105) > 10, `the cue flashes: +${gain(before, flash, 240, 105)}`);
});

test("a Lottie export carries each light as embedded pictures that reach past the layer, with a warning that names it", { timeout: 180_000 }, async () => {
  const project = "light-lottie";
  await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration: 1 });
  await edit(project, [
    { op: "add_layer", layerType: "rectangle", name: "sky", properties: { x: 0, y: 0, width: WIDTH, height: HEIGHT, fill: "#141A24" } },
    { op: "add_layer", layerType: "ellipse", name: "sun", properties: { x: 150, y: 10, width: 20, height: 20, fill: "#FFF6E0" } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "LIGHT", x: 40, y: 70, width: 160, height: 44, fontSize: 36, fontWeight: 700, fill: "#FFFFFF", textAlign: "center" } },
    { op: "add_animation", layer: "sun", effect: "lens-flare", parameters: { style: "rings", x: 0.5, y: 0.5 } },
    { op: "add_animation", layer: "title", effect: "glow", parameters: { strength: 2, radius: 8, threshold: 0, softness: 0 } },
  ]);
  const started = await agent("render", { project, action: "start", quality: "final", format: "lottie", fps: 2 });
  assert.equal(started.isError, undefined, started.text);
  const done = await agent("render", { action: "wait", job: started.data.job, timeout_s: 150 });
  assert.equal(done.data.status, "done", done.text);
  for (const [effect, layer] of [["Lens Flare", "sun"], ["Glow", "title"]])
    assert.match(done.text, new RegExp(`${effect}[^;]*${layer}[^;]*embedded raster image sequence`, "u"));

  const animation = JSON.parse(await readFile(done.data.path, "utf8"));
  const assets = new Map(animation.assets.map((asset) => [asset.id, asset]));
  const layers = [];
  const visit = (list) => { for (const layer of list ?? []) { layers.push(layer); if (layer.ty === 0) visit(assets.get(layer.refId)?.layers); } };
  visit(animation.layers);
  /** The first embedded picture of a layer's sequence and its size in scene pixels. */
  const firstPicture = async (name) => {
    const root = layers.find((layer) => layer.nm === name && layer.ty === 0 && assets.get(layer.refId)?.id.startsWith("effect_sequence_"));
    assert.ok(root, `${name} is an embedded picture sequence`);
    const [first] = assets.get(root.refId).layers.filter((layer) => layer.ty === 2).sort((a, b) => a.ip - b.ip);
    const asset = assets.get(first.refId);
    const image = await readImage(Buffer.from(asset.p.slice(asset.p.indexOf(",") + 1), "base64"));
    return { image, width: asset.w * first.ks.s.k[0] / 100, height: asset.h * first.ks.s.k[1] / 100 };
  };
  // The flare's picture covers the scene, not just the 20-pixel sun, and its ghosts are in it.
  const flare = await firstPicture("sun");
  assert.ok(flare.width >= WIDTH && flare.height >= HEIGHT, `the flare picture is ${flare.width}×${flare.height}`);
  // The ghosts: light more than 80 scene pixels away from the core (the brightest point).
  const scale = flare.image.width / flare.width;
  let core = { x: 0, y: 0, value: -1 };
  for (let y = 0; y < flare.image.height; y += 2) for (let x = 0; x < flare.image.width; x += 2) {
    const value = flare.image.pixel(x, y)[3];
    if (value > core.value) core = { x, y, value };
  }
  let far = 0;
  for (let y = 0; y < flare.image.height; y += 4) for (let x = 0; x < flare.image.width; x += 4)
    if (Math.hypot(x - core.x, y - core.y) > 80 * scale && flare.image.pixel(x, y)[3] > 16) far += 1;
  assert.ok(far > 50, `the flare's ghosts are in the picture: ${far} lit samples far from the core`);
  // The glow's picture holds all of the glow: it fades to nothing before the picture's edge.
  const { image } = await firstPicture("title");
  let edge = 0;
  for (let x = 0; x < image.width; x += 1) edge = Math.max(edge, image.pixel(x, 0)[3], image.pixel(x, image.height - 1)[3]);
  for (let y = 0; y < image.height; y += 1) edge = Math.max(edge, image.pixel(0, y)[3], image.pixel(image.width - 1, y)[3]);
  assert.ok(edge <= 6, `the glow is not cut off at the picture's edge (alpha ${edge} there)`);
});
