// The overlay generators (engine/effects/particles.js) reached the way an agent reaches them: the
// recipes in backend/agent/operations.md (topic particle-recipes) run as written through the `edit` verb
// on a 1920×1080 scene with "footage" and a "title", and each is checked for what its name
// promises; the look the agent gets matches the saved-document export pixel for pixel; and wrong
// settings are refused with the rule.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { EFFECTS } from "../engine/effects/catalog.js";
import { exportScene } from "./export.mjs";
import { readImage, startTestServer, withoutNext } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const WIDTH = 1920, HEIGHT = 1080, LOOK_WIDTH = 480;

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function recipes() {
  const guide = await readFile(new URL("./agent/operations.md", import.meta.url), "utf8");
  const start = guide.indexOf("Recipes for overlays");
  const section = guide.slice(start, guide.indexOf("\n## ", start));
  return Object.fromEntries([...section.matchAll(/^- ([^:]+): (\[.*\])$/gm)].map(([, name, ops]) => [name, JSON.parse(ops)]));
}

/** A project with dark "footage" (a gradient card) and a "title" on top. */
async function scene(project) {
  const made = await agent("project", { action: "create", id: project, name: project, width: WIDTH, height: HEIGHT, duration: 6 });
  assert.equal(made.isError, undefined, made.text);
  const added = await agent("edit", { project, ops: [
    { op: "add_layer", layerType: "rectangle", name: "footage", properties: { x: 0, y: 0, width: WIDTH, height: HEIGHT, strokeWidth: 0,
      fill: { type: "linear", angle: 180, stops: [{ offset: 0, color: "#141C26" }, { offset: 1, color: "#30241A" }] } } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "KINO", x: 560, y: 420, width: 800, height: 240, fontSize: 200, fill: "#E8E2D6", textAlign: "center" } },
    // A slight warm grade. It also makes the frames before and after a recipe come from the same
    // rasterizer (Chromium draws every scene with an effect), so they differ only by the particles.
    { op: "add_animation", layer: "footage", effect: "white-balance", parameters: { temperature: 10 } },
  ] });
  assert.equal(added.isError, undefined, added.text);
}

async function look(project, t) {
  const reply = await agent("look", { project, mode: "frame", t, width: LOOK_WIDTH });
  assert.equal(reply.isError, undefined, reply.text);
  return readImage(Buffer.from(reply.images[0].data, "base64"));
}

async function saved(project) {
  const response = await server.api(`/api/projects/${project}`);
  assert.equal(response.status, 200);
  return (await response.json()).document;
}

function compare(before, after) {
  let changed = 0, darker = 0, brighter = 0;
  for (let y = 0; y < before.height; y += 1) for (let x = 0; x < before.width; x += 1) {
    const a = before.pixel(x, y), b = after.pixel(x, y);
    if (a.some((value, index) => Math.abs(value - b[index]) > 4)) changed += 1;
    const sum = (pixel) => pixel[0] + pixel[1] + pixel[2];
    if (sum(b) < sum(a) - 6) darker += 1;
    if (sum(b) > sum(a) + 6) brighter += 1;
  }
  return { changed, darker, brighter };
}

/** The agent's look at t is the saved document's PNG export at t, pixel for pixel. */
async function assertLookIsExport(project, t, frame) {
  const document = await saved(project);
  const output = await exportScene(document.scenes[0], { format: "png", time: t, width: LOOK_WIDTH }, { mediaRoot: path.join(server.dataDirectory, "media") });
  const expected = await readImage(output.buffer);
  assert.equal(compare(expected, frame).changed, 0, `${project}: look at ${t}s is the export`);
}

const order = (document) => document.scenes[0].layers.map((layer) => layer.name);

test("the guide's overlay recipes run as written and show what their names say; the sparks shower shows only in its window, the snow loop repeats exactly", { timeout: 300_000 }, async () => {
  const all = await recipes();
  assert.deepEqual(Object.keys(all), ["embers-behind-title", "snow-over-footage", "sparks-shower", "dust-in-light", "rolling-fog",
    "light-leak", "rain-storm", "bokeh-behind-title", "snow-loop"]);
  // Every recipe starts from the same still scene, so one look before any recipe serves them all.
  await scene("recipe-baseline");
  const baseline = await look("recipe-baseline", 1.5);
  for (const [index, [name, ops]] of Object.entries(all).entries()) {
    const project = `recipe-${name}`;
    await scene(project);
    const reply = await agent("edit", { project, ops });
    assert.equal(reply.isError, undefined, `${name}: ${reply.text}`);
    assert.equal(reply.data?.fixed, undefined, `${name} needs no fixing: ${reply.data?.fixed}`);
    const document = await saved(project);
    const carrier = document.scenes[0].layers.find((layer) => layer.name === ops[0].name);
    assert.deepEqual(carrier.animations.map((animation) => [animation.kind, animation.effect]), [["effect", ops[0].animations[0].effect]]);
    const names = order(document);
    if (name.endsWith("behind-title")) assert.deepEqual(names, ["footage", ops[0].name, "title"], `${name} sits behind the title`);
    else assert.deepEqual(names, ["footage", "title", ops[0].name], `${name} is on top`);

    const frame = await look(project, 1.5);
    // Look draws with the export, so one recipe is enough to check they agree.
    if (index === 0) await assertLookIsExport(project, 1.5, frame);
    const { changed, darker, brighter } = compare(baseline, frame);
    assert.ok(changed > 300, `${name} changes ${changed} pixels`);
    // The add blend only brightens what is below.
    if (carrier.blendMode === "add") assert.equal(darker, 0, `${name} on the add blend darkens nothing`);
    else assert.ok(brighter > 200, `${name} lightens the dark footage: ${brighter}`);

    // The shower runs from 1 s to 3 s: nothing before it starts or after it ends.
    if (name === "sparks-shower") {
      assert.equal(compare(baseline, await look(project, 0.5)).changed, 0, "nothing before the shower starts");
      assert.equal(compare(baseline, await look(project, 3.5)).changed, 0, "gone after it ends at 3 s");
    }
    // A 4 s loop: the frame 4 s later is the same, and it moves in between.
    if (name === "snow-loop") {
      assert.equal(compare(frame, await look(project, 5.5)).changed, 0, "the frame 4 s later is the same");
      assert.ok(compare(frame, await look(project, 3.5)).changed > 300, "and it moves in between");
    }
  }
});

test("the particles examples in the kino skill run as written and do what they say", { timeout: 120_000 }, async () => {
  const [embers, update, sparks] = jsonBlocks(skillSection("Particles and overlays"));
  await scene("skill-particles");
  // The skill adds its own title; this scene has one called "title" already, so drop the skill's.
  assert.equal(embers[0].name, "title");
  for (const ops of [embers.slice(1), update, sparks]) {
    const reply = await agent("edit", { project: "skill-particles", ops });
    assert.equal(reply.isError, undefined, reply.text);
  }
  const document = await saved("skill-particles");
  assert.deepEqual(order(document), ["footage", "embers", "title", "sparks"]);
  const layers = Object.fromEntries(document.scenes[0].layers.map((layer) => [layer.name, layer]));
  assert.equal(layers.embers.blendMode, "add");
  assert.deepEqual([layers.embers.animations[0].to.count, layers.embers.animations[0].to.wind], [240, 30], "update_animation changed the settings");
  assert.deepEqual([layers.sparks.animations[0].start, layers.sparks.animations[0].duration], [2, 1.5], "the sparks start on the cue");
  const quiet = await look("skill-particles", 1.9), burst = await look("skill-particles", 2.6);
  assert.ok(compare(quiet, burst).changed > 300, "sparks fly after the cue");
});

/**
 * Reads the particles answer's catalog back into {effect: {setting: {range, default}}}. The
 * answer writes each setting once ("size 0.5..48 px (embers), 4..400 px (bokeh)"), says which
 * effects lack which settings ("fog and light-leaks have no gravity, … or originY.") and ends
 * with a table of the defaults that differ ("effect count size …" then one row per effect).
 */
function readCatalog(text) {
  const [settingsLine, , header, ...rows] = text.slice(text.indexOf("\nCatalog: ") + "\nCatalog: ".length).split("\n");
  const [settings, ...lackingSentences] = settingsLine.split(/\. (?=[a-z-, ]+ ha(?:s|ve) no )/);
  const lacking = {};
  for (const sentence of lackingSentences) {
    const [names, keys] = sentence.replace(/\.$/, "").split(/ ha(?:s|ve) no /);
    for (const name of names.split(/, | and /)) lacking[name] = keys.split(/, | or /);
  }
  const effects = rows.map((row) => row.split(" ")[0]);
  const catalog = Object.fromEntries(effects.map((name) => [name, {}]));
  for (const entry of settings.replace(/\.$/, "").split("; ")) {
    const [, keyList, body] = /^([A-Za-z0-9]+(?:, [A-Za-z0-9]+)*) (.*)$/.exec(entry);
    const [, ranges, shared] = /^(.*?)(?: default (\S+))?$/.exec(body);
    for (const key of keyList.split(", ")) {
      // One range for every effect, or "range (effects), range (effects)".
      const byEffect = ranges.includes(" (")
        ? ranges.split(/(?<=\)), /).flatMap((part) => { const [, range, names] = /^(.*) \((.*)\)$/.exec(part); return names.split(", ").map((name) => [name, range]); })
        : effects.filter((name) => !lacking[name]?.includes(key)).map((name) => [name, ranges]);
      for (const [name, range] of byEffect) catalog[name][key] = { range, ...(shared ? { default: shared } : {}) };
    }
  }
  const tableKeys = header.split(" ").slice(1);
  for (const row of rows) {
    const [name, ...cells] = row.split(" ");
    tableKeys.forEach((key, index) => { if (cells[index] !== "-") catalog[name][key].default = cells[index]; });
  }
  return catalog;
}

test("library: the particles answer is short and keeps every range and default; each recipe is one call away", async () => {
  const rules = await agent("library", { topic: "rules", name: "particles" });
  assert.equal(rules.isError, undefined, rules.text);
  // It was 13,054 characters (the catalog wrote every range out for each of the eight effects).
  assert.ok(rules.text.length < 6_000, `the particles answer is ${rules.text.length} characters`);
  for (const text of ["blendMode", "picture at time t depends only on the settings", "a spark draws up to four shapes"])
    assert.ok(rules.text.includes(text), `the particles topic says ${text}`);

  // Every setting of every generator, with its range and default, reads back from the answer exactly.
  const expected = {};
  for (const effect of EFFECTS.filter((item) => item.group === "Generate")) {
    expected[effect.key] = Object.fromEntries(Object.entries(effect.parameters).map(([key, field]) => [key, {
      range: field.type === "number" ? `${field.min}..${field.max}${field.integer ? " integer" : ""}${field.unit ? ` ${field.unit}` : ""}`
        : field.type === "enum" ? field.options.map(([value]) => value).join("/") : field.type,
      default: typeof field.default === "string" ? field.default : JSON.stringify(field.default),
    }]));
  }
  assert.deepEqual(readCatalog(withoutNext(rules.text)), expected);

  // The answer names the nine recipes; particle-recipes has them all, and search narrows to one.
  const all = await recipes();
  for (const name of Object.keys(all)) assert.ok(rules.text.includes(name), `the particles topic names ${name}`);
  const book = await agent("library", { topic: "rules", name: "particle-recipes" });
  assert.equal(book.isError, undefined, book.text);
  for (const [name, ops] of Object.entries(all)) assert.ok(book.text.includes(`- ${name}: ${JSON.stringify(ops)}`), `particle-recipes has ${name}`);
  const one = await agent("library", { topic: "rules", name: "particle-recipes", search: "snow-loop" });
  const lines = withoutNext(one.text).split("\n");
  assert.equal(lines.length, 3, one.text);
  assert.match(lines[0], /^## particle-recipes: Particle overlay recipes \(the lines that mention "snow-loop"\)$/);
  // The list's first line comes along: it says to use your scene's size and your layer's name.
  assert.match(lines[1], /^Recipes for overlays \(send each list as one edit on a 1920×1080 scene; use your scene's size, replace "title" with your layer/);
  assert.deepEqual(JSON.parse(lines[2].replace(/^- snow-loop: /, "")), all["snow-loop"], "the ops the first test runs");
  const none = await agent("library", { topic: "rules", name: "particle-recipes", search: "hail" });
  assert.equal(withoutNext(none.text), 'No line of particle-recipes mentions "hail"; leave out search for the whole topic.');

  // The topics written outside the guide (render, quality, workspace) take search too.
  const quality = await agent("library", { topic: "rules", name: "quality" });
  const contrast = await agent("library", { topic: "rules", name: "quality", search: "contrast" });
  assert.ok(contrast.text.length < quality.text.length / 2, contrast.text);
  // Each check keeps its list's first line, which says whether it is an error or a warning.
  assert.match(contrast.text, /\nGates \(errors[^\n]*:\n  [a-z_]*contrast/, contrast.text);
  const folders = await agent("library", { topic: "rules", name: "workspace", search: "folders" });
  assert.match(folders.text, /^## workspace: workspace \(the lines that mention "folders"\)\nfolders: list, create/);
  const render = await agent("library", { topic: "rules", name: "render", search: "hail" });
  assert.equal(withoutNext(render.text), 'No line of render mentions "hail"; leave out search for the whole topic.');
});

test("the effects topic points to the particles topic, and wrong settings are refused with the rule", async () => {
  const effects = await agent("library", { topic: "rules", name: "effects" });
  assert.ok(effects.text.includes('name:\\"particles\\"') || effects.text.includes('name:"particles"'), "the effects topic points to it");
  assert.ok(effects.text.includes('name:\\"particle-recipes\\"') || effects.text.includes('name:"particle-recipes"'), "and to the recipes");
  assert.ok(!effects.text.includes("embers (Embers"), "and does not repeat its catalog");

  await scene("refusals");
  const refusals = [
    [{ op: "add_animation", layer: "footage", effect: "snow", parameters: { count: 5000 } }, /count must be an integer from 0 to 2000/],
    [{ op: "add_animation", layer: "footage", effect: "fog", parameters: { trail: 0.1 } }, /trail is not a parameter of fog/],
    [{ op: "add_animation", layer: "footage", effect: "embers", from: { seed: 1 }, parameters: { seed: 2 } }, /from\.seed must equal to\.seed: embers keeps seed fixed/],
    [{ op: "add_animation", layer: "footage", effect: "rain", parameters: { emitter: "sky" } }, /area, bottom, top, left, right, point/],
  ];
  for (const [op, rule] of refusals) {
    const reply = await agent("edit", { project: "refusals", ops: [op] });
    assert.equal(reply.isError, true, JSON.stringify(op));
    assert.match(reply.text, rule);
  }
  assert.deepEqual((await saved("refusals")).scenes[0].layers.find((layer) => layer.name === "footage").animations.map((item) => item.effect),
    ["white-balance"], "nothing was added");
});
