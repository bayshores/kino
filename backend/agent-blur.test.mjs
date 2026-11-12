// The blur recipes in backend/agent/operations.md (topic blur), the example in
// skills/kino/references/blur.md and the whip and spin transitions of add_sequence, run as written
// through the agent `edit` verb and checked in `look` frames (drawn by Chromium, as every export
// draws effects) for what they promise: a smear that is wide while the layer moves fast and gone
// once it stops, smooth with no steps, and edges that never show the scene's background.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { readImage, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const LOOK = 480; // look frames are a quarter size: 1 look pixel is 4 scene pixels
const GREEN = "#00FF00"; // the scene background, so an uncovered edge is easy to see
// Eight upright stripes, 240 px each, with no green in them.
const STRIPES = ["#E03030", "#F0A020", "#F0E040", "#30C0E0", "#3050E0", "#A040D0", "#F0F0F0", "#202020"];

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function edit(project, ops) {
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.fixed, undefined, `kino had to fix the ops: ${reply.data.fixed}`);
  return reply;
}

async function create(project, { background = GREEN, duration = 3 } = {}) {
  const made = await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration, background });
  assert.equal(made.isError, undefined, made.text);
}

/** A project whose only layer is a full-frame striped picture called "footage". */
async function withFootage(project, options) {
  await create(project, options);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  STRIPES.forEach((color, index) => { context.fillStyle = color; context.fillRect(index * 240, 0, 240, HEIGHT); });
  context.fillStyle = "#101010";
  context.fillRect(0, 760, WIDTH, 60); // a level band, so turns and mirrors have something to show
  const upload = await server.api(`/api/media?project=${project}`, {
    method: "POST", headers: { "content-type": "image/png", "x-file-name": "stripes.png" }, body: canvas.toBuffer("image/png"),
  });
  assert.equal(upload.status, 201);
  const { src } = await upload.json();
  await edit(project, [{ op: "add_layer", layerType: "image", name: "footage", properties: { src, x: 0, y: 0, width: WIDTH, height: HEIGHT } }]);
}

async function frame(project, t, scene) {
  const reply = await agent("look", { project, mode: "frame", t, width: LOOK, ...(scene ? { scene } : {}) });
  assert.equal(reply.isError, undefined, reply.text);
  const image = await readImage(Buffer.from(reply.images[0].data, "base64"));
  assert.deepEqual([image.width, image.height], [LOOK, LOOK * HEIGHT / WIDTH]);
  return image;
}

const isGreen = ([r, g, b]) => g > 200 && r < 90 && b < 90;
const corners = (image) => [[1, 1], [image.width - 2, 1], [1, image.height - 2], [image.width - 2, image.height - 2]].map(([x, y]) => image.pixel(x, y));
const distance = (a, b) => Math.max(...[0, 1, 2].map((channel) => Math.abs(a[channel] - b[channel])));

/** How many pixels of a row lie between 10% and 90% of the way from `low` to `high` in one channel. */
function rampWidth(image, y, { from = 0, to = image.width, channel = 0, low, high }) {
  let count = 0;
  for (let x = from; x < to; x += 1) {
    const share = (image.pixel(x, y)[channel] - low) / (high - low);
    if (share > 0.1 && share < 0.9) count += 1;
  }
  return count;
}

/** The largest jump between neighbouring pixels of a row in one channel. */
function largestStep(image, y, { from, to, channel = 0 }) {
  let largest = 0;
  for (let x = from + 1; x < to; x += 1) largest = Math.max(largest, Math.abs(image.pixel(x, y)[channel] - image.pixel(x - 1, y)[channel]));
  return largest;
}

async function recipes() {
  const guide = await readFile(new URL("./agent/operations.md", import.meta.url), "utf8");
  const topic = guide.slice(guide.indexOf("## blur: "));
  const section = topic.slice(topic.indexOf("Recipes ("), topic.indexOf("\n## "));
  return Object.fromEntries([...section.matchAll(/^- ([^:]+): (\[.*\])$/gm)].map(([, name, ops]) => [name, JSON.parse(ops)]));
}

// The yellow card of the skill example on the dark background: red goes from 0x0b to 0xF2.
const CARD = { low: 0x0b, high: 0xf2, channel: 0 };
const CARD_ROW = 95; // scene y 380: the card, above its title

test("library explains the blur effects with their fields, and the skill has a blur reference", async () => {
  const rules = await agent("library", { topic: "rules", name: "blur" });
  assert.equal(rules.isError, undefined, rules.text);
  for (const text of ["directional-blur (Directional Blur; value): length number 0..4000 px", "edge-fill (Edge Fill; ranged): mode enum mirror/tile",
    "kaleidoscope (Kaleidoscope; ranged)", "put edge-fill first", "shutterAngle", "lottie-effect-rasterized", "- whip-in: ["])
    assert.ok(rules.text.includes(text), `the blur topic says ${text}`);
  const guide = await agent("library", { topic: "guide", name: "blur" });
  assert.match(guide.text, /## Blur, edge fill and mirror/);
  // A blur under 0.3 s that sets its strength returns to 0 at its end and the receipt says so; a longer one holds.
  await create("blur-receipt");
  const made = await edit("blur-receipt", [{ op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 0, y: 0, width: 400, height: 300 } },
    { op: "add_animation", layer: "card", effect: "directional-blur", start: 1, duration: 0.08, parameters: { length: 200 } },
    { op: "add_animation", layer: "card", effect: "spin-blur", start: 1, duration: 0.5, parameters: { angle: 30 } }]);
  for (const note of ["directional-blur returns to 0 at 1.08 s (hold:true keeps it)", "spin-blur holds its end value after 1.5 s (hold:false returns it to 0)"])
    assert.ok(made.text.includes(note), made.text);
});

test("the blur recipes and the skill's blur example run as written and do what their names say", { timeout: 240_000 }, async () => {
  const all = await recipes();
  assert.deepEqual(Object.keys(all), ["whip-in", "zoom-punch", "spin-in", "shake", "zoom-out", "kaleidoscope", "rack-focus"]);

  // whip-in: the card whips in from the left, smeared most at 0.2 s and sharp once it stops. The
  // skill's example (skills/kino/references/blur.md) is the card, this recipe, then a zoom punch
  // at 2 s, so it runs here as written and its punch is checked after the whip.
  const [example] = jsonBlocks(skillSection("Blur, edge fill and mirror"));
  assert.deepEqual(example.slice(3, 3 + all["whip-in"].length), all["whip-in"], "the skill example's whip is the whip-in recipe");
  await create("recipe-whip", { background: "#0b1020" });
  await edit("recipe-whip", example);
  const moving = await frame("recipe-whip", 0.2);
  const still = await frame("recipe-whip", 1);
  const smear = rampWidth(moving, CARD_ROW, CARD);
  assert.ok(smear >= 60 && smear <= 100, `at full speed the card's edge is a ${smear} px smear (a 400 px blur is 100 look pixels)`);
  assert.ok(largestStep(moving, CARD_ROW, { from: 0, to: 200 }) <= 16, "the smear has no steps");
  assert.ok(rampWidth(still, CARD_ROW, CARD) <= 4, "the card is sharp once it stops");
  assert.ok(near(still.pixel(240, CARD_ROW), [0xf2, 0xd2, 0x1b]), "and stands where it should");
  // The skill's punch: at 2 s a zoom blur of 0.25 smears the card's sides away from its centre.
  const punchStart = await frame("recipe-whip", 2);
  assert.ok(rampWidth(punchStart, CARD_ROW, CARD) >= 12, `the punch smears the card's sides (${rampWidth(punchStart, CARD_ROW, CARD)} px)`);
  const punched = await frame("recipe-whip", 2.6);
  assert.ok(rampWidth(punched, CARD_ROW, CARD) <= 4, "sharp again at 115%");
  // 800 px at 115% is 920 px wide: 230 look pixels of card.
  let card = 0;
  for (let x = 0; x < LOOK; x += 1) if (punched.pixel(x, CARD_ROW)[0] > 128) card += 1;
  assert.ok(card >= 227 && card <= 233, `the card is 115% wide after the punch (${card} look pixels)`);

  // zoom-punch: the stripes smear away from the centre at the start of the punch, then are sharp.
  await withFootage("recipe-zoom");
  await edit("recipe-zoom", all["zoom-punch"]);
  const stripeEdge = (image) => rampWidth(image, 135, { from: 20, to: 100, channel: 1, low: 0x30, high: 0xa0 });
  const [beforePunch, punch, afterPunch] = [await frame("recipe-zoom", 0.5), await frame("recipe-zoom", 1), await frame("recipe-zoom", 1.5)];
  assert.ok(stripeEdge(beforePunch) <= 3, `sharp before the punch (${stripeEdge(beforePunch)})`);
  assert.ok(stripeEdge(punch) >= 20, `the stripes far from the centre smear outward (${stripeEdge(punch)} px)`);
  assert.ok(stripeEdge(afterPunch) <= 4, `sharp after the punch (${stripeEdge(afterPunch)})`);
  for (const image of [punch, afterPunch]) assert.ok(!corners(image).some(isGreen), "a punch in never shows the background");

  // spin-in: turned and smeared at the start, with the corners filled by the mirrored picture.
  await withFootage("recipe-spin");
  await edit("recipe-spin", all["spin-in"]);
  const spinning = await frame("recipe-spin", 0.1);
  assert.deepEqual(corners(spinning).filter(isGreen), [], "the turned picture's corners are filled");
  const settled = await frame("recipe-spin", 0.8);
  assert.ok(near(settled.pixel(30, 60), [0xe0, 0x30, 0x30]) && near(settled.pixel(450, 60), [0x20, 0x20, 0x20]), "after the spin the picture is back in place");

  // shake: the picture moves, and with edge-fill first no frame shows the background.
  await withFootage("recipe-shake");
  await edit("recipe-shake", all.shake);
  const times = [0.1, 0.27, 0.43, 0.61, 0.83, 1.07]; // not a whole number of shake cycles (6 a second) apart
  const shaken = [];
  for (const t of times) shaken.push(await frame("recipe-shake", t));
  for (const [index, image] of shaken.entries()) assert.deepEqual(corners(image).filter(isGreen), [], `no empty edge at ${times[index]} s`);
  // The first stripe edge (scene x 240, look x 60) moves with the shake.
  const edgeRows = shaken.map((image) => Array.from({ length: 40 }, (_, x) => image.pixel(40 + x, 100)[1]).join());
  assert.ok(new Set(edgeRows).size >= 4, "the picture moves");
  // The same shake without edge-fill uncovers the background, which is why the recipe has it.
  await withFootage("recipe-shake-bare");
  await edit("recipe-shake-bare", all.shake.slice(1));
  let uncovered = 0;
  for (const t of times) {
    uncovered += corners(await frame("recipe-shake-bare", t)).filter(isGreen).length;
    if (uncovered) break; // one uncovered corner proves it
  }
  assert.ok(uncovered > 0, "without edge-fill a corner shows the background");

  // zoom-out: at 60% the picture is mirrored past its edges, so the frame stays full.
  await withFootage("recipe-zoom-out");
  await edit("recipe-zoom-out", all["zoom-out"]);
  const out = await frame("recipe-zoom-out", 1.6);
  assert.deepEqual(corners(out).filter(isGreen), [], "the zoomed-out frame has no empty edge");
  // The picture's left edge is at 960 − 0.6 × 960 = 384 (look x 96): the mirror image continues it.
  for (const d of [3, 8, 14]) assert.ok(distance(out.pixel(96 - d, 60), out.pixel(95 + d, 60)) <= 24, `mirrored across the edge, ${d} px out`);

  // kaleidoscope: eight-fold, so the picture repeats every 45° around the centre.
  await withFootage("recipe-kaleidoscope");
  await edit("recipe-kaleidoscope", all.kaleidoscope);
  const k = await frame("recipe-kaleidoscope", 1.5);
  assert.deepEqual(corners(k).filter(isGreen), [], "with edge-fill first the kaleidoscope fills the frame");
  let same = 0, samples = 0;
  for (const radius of [30, 60, 100]) {
    for (const degrees of [10, 50, 100, 160, 200, 250, 300]) {
      const at = (angle) => k.pixel(Math.round(240 + radius * Math.cos(angle * Math.PI / 180)), Math.round(135 + radius * Math.sin(angle * Math.PI / 180)));
      samples += 1;
      if (distance(at(degrees), at(degrees + 45)) <= 40) same += 1;
    }
  }
  assert.ok(same >= samples * 0.85, `${same} of ${samples} points match the point 45° round`);

  // rack-focus: the stripes' edges are sharp on the band's row (scene y 270, then 702) and soft
  // far from it, and the band has moved by the end. A stripe edge is at look x 60.
  await withFootage("recipe-focus");
  await edit("recipe-focus", all["rack-focus"]);
  const width = (image, y) => rampWidth(image, y, { from: 50, to: 70, channel: 1, low: 0x30, high: 0xa0 });
  const before = await frame("recipe-focus", 0.5), racked = await frame("recipe-focus", 2);
  assert.ok(width(before, 67) <= 1 && width(before, 175) >= 3, `sharp at the top band, soft below: ${width(before, 67)}, ${width(before, 175)}`);
  assert.ok(width(racked, 175) <= 1 && width(racked, 67) >= 3, `racked to the lower band: ${width(racked, 175)}, ${width(racked, 67)}`);
  assert.deepEqual(corners(before).filter(isGreen), [], "frame-filling footage keeps its edges");

  // The skill's depth-of-field example (blur.md) runs as written: a card on ui-plane, racked.
  const [focusExample] = jsonBlocks(skillSection("Depth of field: focus-band"));
  await create("skill-focus", { background: "#0b1020", duration: 4 });
  await edit("skill-focus", focusExample);
  await frame("skill-focus", 2.5);
});

test("add_sequence whip and spin transitions smear the parts and never show the background between them", { timeout: 120_000 }, async () => {
  await create("transitions", { duration: 1.5 });
  const bars = (scene, colors) => colors.map((fill, index) => ({ op: "add_layer", scene, layerType: "rectangle", name: `${scene}-${index}`,
    properties: { x: index * 480, y: 0, width: 480, height: HEIGHT, fill, radius: 0 } }));
  await edit("transitions", [
    { op: "update_scene", properties: { name: "One", background: "#202060" } },
    ...bars("One", ["#E03030", "#F0E040", "#3050E0", "#F0F0F0"]),
    { op: "add_scene", name: "Two", width: WIDTH, height: HEIGHT, duration: 1.5, background: "#602020" },
    ...bars("Two", ["#30C0E0", "#A040D0", "#F0A020", "#202020"]),
    { op: "add_sequence", properties: { name: "Whip" }, scenes: ["One", "Two"], background: GREEN, transition: { type: "whip", duration: 0.4 } },
    { op: "add_sequence", properties: { name: "Spin" }, scenes: ["One", "Two"], background: GREEN, transition: { type: "spin", duration: 0.5 } },
  ]);
  const record = await (await server.api("/api/projects/transitions")).json();
  const scene = (name) => record.document.scenes.find((item) => item.name === name).id;
  // Whip 1.1–1.5 s: at 1.3 both parts move fastest, smeared, and meet with no gap.
  const whip = await frame("transitions", 1.3, scene("Whip"));
  const row = Array.from({ length: LOOK }, (_, x) => whip.pixel(x, 135));
  assert.deepEqual(row.filter(isGreen), [], "no background shows between the two parts");
  assert.ok(largestStep(whip, 135, { from: 0, to: LOOK }) <= 20, "the parts are one smooth smear");
  const beforeWhip = await frame("transitions", 1, scene("Whip"));
  assert.ok(near(beforeWhip.pixel(60, 135), [0xe0, 0x30, 0x30]) && near(beforeWhip.pixel(180, 135), [0xf0, 0xe0, 0x40]), "sharp before the whip");
  // Spin 1.0–1.5 s: at 1.25 both parts are turned and blurred; edge fill keeps the corners filled.
  const spin = await frame("transitions", 1.25, scene("Spin"));
  for (const pixel of corners(spin)) assert.ok(pixel[1] - Math.max(pixel[0], pixel[2]) < 128, `a corner shows picture, not the background: ${pixel}`);
  const afterSpin = await frame("transitions", 1.5, scene("Spin"));
  assert.ok(near(afterSpin.pixel(60, 135), [0x30, 0xc0, 0xe0]), "part two is in place after the spin");
});

function near(actual, expected, tolerance = 10) {
  return expected.every((value, channel) => Math.abs(actual[channel] - value) <= tolerance);
}
