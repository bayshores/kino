// AF-2: smaller agent answers and edits that are harder to get wrong. A refused edit lists the
// problems of ops that use a refused layer too; check sends its rules line once; receipts leave
// out documented short names and list at most 8 animation times; look images are at most
// 1280 px on the long edge; a close role, set_font over non-text layers and top-level layer
// fields are fixed and reported instead of refused or dropped; add_layer takes its animations
// inline; library answers several names at once; render start can wait for the files.
// Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { estimateTextTokens, pngSize } from "./meter.mjs";
import { pageOf, pngTokens, searchGuide } from "./agent/service.mjs";
import { EFFECTS } from "../engine/effects/catalog.js";
import { effectDetailText, effectsListText } from "./agent/effects-help.mjs";
import { skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";
import { jsonBlocks, skillFiles } from "./skill.test.support.mjs";

let server;
before(async () => {
  server = await startTestServer();
  await agent("project", { action: "create", id: "answers", name: "Answers", width: 1920, height: 1080, duration: 4 });
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project: "answers", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

async function saved(id = "answers") {
  return (await server.api(`/api/projects/${id}`)).json();
}

const findLayer = (record, id) => record.document.scenes.flatMap((scene) => scene.layers).find((layer) => layer.id === id);
const imageSize = (reply) => pngSize(Buffer.from(reply.images[0].data, "base64"));

test("a refused add_layer still lets the ops that use it be tried, and its message names the field plainly", async () => {
  const before = await saved();
  const reply = await agent("edit", { ops: [
    { op: "add_layer", layerType: "text", name: "headline", properties: { text: "Hi", shade: "#ffffff" } },
    { op: "add_animation", layer: "headline", preset: "no-such-preset", start: 0, duration: 0.5 },
    { op: "add_layer", layerType: "rectangle", name: "panel", properties: { role: "villain" } },
  ] });
  assert.equal(reply.isError, true);
  assert.equal(reply.data.op, 0);
  assert.match(reply.data.reason, /^3 operations refused\. Operation 0 \(add_layer\): "shade" is not a layer property/);
  // Before, op 1 was only "not tried" because it uses the layer op 0 would make.
  assert.deepEqual(reply.data.alsoRefused.map((problem) => problem.op), [1, 2]);
  assert.match(reply.data.alsoRefused[0].reason, /no-such-preset/);
  assert.equal(reply.data.notTried, undefined);
  // The engine says "document.scenes[0].layers[1].role must be …"; the agent reads "role must be …".
  assert.match(reply.data.alsoRefused[1].reason, /^role must be one of headline, subhead/);
  assert.doesNotMatch(reply.text, /document\.scenes/);
  assert.equal((await saved()).revision, before.revision, "nothing was saved");
});

test("check sends its rules line on the first check of a project and when asked with rules:true", async () => {
  const first = await agent("check", { pixels: false });
  assert.match(first.text, /\nRules: render checks/);
  const second = await agent("check", { pixels: false });
  assert.doesNotMatch(second.text, /Rules: render checks/);
  assert.ok(second.text.length < first.text.length);
  const asked = await agent("check", { pixels: false, rules: true });
  assert.match(asked.text, /\nRules: render checks/);
  assert.equal(asked.data.errors, second.data.errors, "rules:true limits no rule");
});

test("a receipt leaves out documented short names and lists at most 8 animation times that changed", async () => {
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "tile", properties: { x: 200, y: 200, width: 100, height: 100 } },
    ...Array.from({ length: 10 }, (_, index) => ({ op: "add_animation", layer: "tile", preset: "move", start: index * 0.3, duration: 0.2, easing: "smooth" })),
  ] });
  assert.equal(made.isError, undefined, made.text);
  assert.equal(made.data.fixed, undefined, "layer → layerId is the documented short name, not a fix");
  assert.equal(Object.keys(made.data.times).length, 8);
  assert.equal(made.data.timesMore, 2);

  // A changed easing leaves the times alone, so no times are listed.
  const eased = await agent("edit", { ops: [{ op: "update_animation", layer: "tile", animation: Object.keys(made.data.times)[0], properties: { easing: "natural" } }] });
  assert.equal(eased.isError, undefined, eased.text);
  assert.ok(eased.data.changed.length > 0);
  assert.equal(eased.data.times, undefined);
  assert.doesNotMatch(eased.text, /"times"/);
});

test("look frame images are at most 1280 px on the long edge", async () => {
  const wide = await agent("look", { mode: "frame", t: 0, width: 1920 });
  assert.equal(wide.isError, undefined, wide.text);
  assert.deepEqual(imageSize(wide), { width: 1280, height: 720 });
  assert.match(wide.text, /^frame s1 @0s 1280px \(at most 1280 px on the long edge/);

  await agent("project", { action: "create", id: "tall", name: "Tall", width: 1080, height: 1920, duration: 2 });
  const response = await server.api("/api/agent/look", { method: "POST", body: { project: "tall", mode: "frame", t: 0, width: 1280 } });
  const tall = await response.json();
  assert.deepEqual(imageSize(tall), { width: 720, height: 1280 });
  await agent("project", { action: "open", id: "answers" });
});

test("the dashboard's token count for a look image uses 28 × 28 pixel patches", async () => {
  const look = await agent("look", { mode: "frame", t: 0, width: 1280 });
  assert.equal(pngTokens(look.images[0].data), Math.ceil(1280 / 28) * Math.ceil(720 / 28), "1196, not 1280 × 720 ÷ 750 = 1229");
  const snapshot = await (await server.api("/api/dashboard/snapshot?project=answers")).json();
  const event = snapshot.events.filter((entry) => entry.verb === "look").at(-1);
  assert.equal(event.tokens, estimateTextTokens(look.text) + 1196);
});

test("a role one letter off is fixed and reported; set_font skips layers that are not text", async () => {
  const reply = await agent("edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "backdrop", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#101820", role: "backgrund" } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Ship faster", x: 360, y: 400, width: 1200, height: 180, fontSize: 120, role: "headlin" } },
    { op: "set_font", layers: ["title", "backdrop"], family: "Roboto", weight: 700 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.fixed, ['role "backgrund" → background', 'role "headlin" → headline']);
  assert.deepEqual(reply.data.notes, ["op 2 set_font skipped backdrop (rectangle): not text"]);
  const record = await saved();
  assert.equal(findLayer(record, "title").role, "headline");
  assert.equal(findLayer(record, "backdrop").role, "background");
  assert.equal(findLayer(record, "title").fontFamily, "Roboto");

  const onlyShapes = await agent("edit", { ops: [{ op: "set_font", layers: ["backdrop"], family: "Roboto" }] });
  assert.equal(onlyShapes.isError, true);
  assert.match(onlyShapes.data.reason, /set_font sets the font of text layers, and backdrop \(rectangle\) is not text\./);

  // A role far from any is refused with an example that sets a valid one; label is a role.
  const unknown = await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { role: "tag" } }] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /role must be one of .*label/);
  assert.match(JSON.parse(unknown.text).next, /"role":"label"/);
  assert.doesNotMatch(unknown.text, /ffd166/);
  const label = await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { role: "label" } }] });
  assert.equal(label.isError, undefined, label.text);
  // A screen's own text is role ui ("menu-item" points there).
  const menu = await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { role: "menu-item" } }] });
  assert.match(JSON.parse(menu.text).next, /"role":"ui"/);
  // A guess holding a role word keeps it, and "arrow" (r-o-w inside) is not product text.
  const cta = await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { role: "cta-button" } }] });
  assert.match(JSON.parse(cta.text).next, /"role":"cta"/);
  const arrow = await agent("edit", { ops: [{ op: "update_layer", layer: "title", properties: { role: "arrow" } }] });
  assert.doesNotMatch(JSON.parse(arrow.text).next, /"role":"ui"/);
});

test("did-you-mean for an animation lists the target layer's own animations first", async () => {
  const made = await agent("edit", { ops: [
    { op: "add_layer", layerType: "text", name: "badge", properties: { text: "New", x: 100, y: 100, width: 300, height: 100 } },
    { op: "add_animation", layer: "badge", preset: "preset-fade", start: 0, duration: 0.4 },
    { op: "add_animation", layer: "badge", preset: "preset-fade", mode: "out", start: 3, duration: 0.4 },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const typo = await agent("edit", { ops: [{ op: "update_animation", animation: "badge.inn", properties: { duration: 0.5 } }] });
  assert.equal(typo.isError, true);
  assert.equal(typo.data.didYouMean[0], "badge.in");
  assert.ok(typo.data.didYouMean.includes("badge.out"));
  // An unknown code on a layer with animations: that layer's own come first, before the
  // animations of tile (which has ten, with codes closer to "A999").
  const unknown = await agent("edit", { ops: [{ op: "update_animation", layer: "badge", animation: "A999", properties: { duration: 0.5 } }] });
  assert.equal(unknown.isError, true);
  const own = new Set(["badge.in", "badge.out", made.data.created["badge.in"], made.data.created["badge.out"]]);
  assert.ok(own.has(unknown.data.didYouMean[0]), `first suggestion ${unknown.data.didYouMean[0]} is one of badge's animations`);
});

test("add_layer: a top-level layer field goes into properties and is reported; other fields are refused", async () => {
  const moved = await agent("edit", { ops: [
    { op: "add_layer", layerType: "text", name: "tagline", text: "Plan the week", fontSize: 64, properties: { x: 300, y: 700, width: 1300, height: 90 } },
  ] });
  assert.equal(moved.isError, undefined, moved.text);
  assert.deepEqual(moved.data.fixed, ["text → properties.text", "fontSize → properties.fontSize"]);
  const tagline = findLayer(await saved(), "tagline");
  assert.equal(tagline.text, "Plan the week", "before AF-2 the top-level text was dropped without a word");
  assert.equal(tagline.fontSize, 64);

  // colour is fill (the same alias as in properties), so it is moved and fixed; a word no
  // layer has is refused.
  const colour = await agent("edit", { dry_run: true, ops: [{ op: "add_layer", layerType: "text", name: "other", colour: "#fff", properties: { text: "x" } }] });
  assert.equal(colour.isError, undefined, colour.text);
  assert.ok(colour.data.fixed.includes("colour → fill"), JSON.stringify(colour.data.fixed));
  const unknown = await agent("edit", { ops: [{ op: "add_layer", layerType: "text", name: "other", shade: "#fff", properties: { text: "x" } }] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.reason, /"shade" is not a field of add_layer or of a layer\. Did you mean shadow/);
  const twice = await agent("edit", { ops: [{ op: "update_layer", layer: "tagline", text: "a", properties: { text: "b" } }] });
  assert.equal(twice.isError, true);
  assert.match(twice.data.reason, /text is given twice: at the top level and in properties/);
  const topLevel = await agent("edit", { ops: [{ op: "update_layer", layer: "tagline", y: 720 }] });
  assert.equal(topLevel.isError, undefined, topLevel.text);
  assert.equal(findLayer(await saved(), "tagline").y, 720);
});

test("add_layer takes its animations inline; a problem in one names it, and retry keeps the op numbers", async () => {
  const preview = await agent("edit", { dry_run: true, ops: [
    { op: "add_layer", layerType: "ellipse", name: "dot", properties: { x: 900, y: 900, width: 40, height: 40 },
      animations: [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-fade", mode: "out", start: 3, duration: 0.4 }] },
  ] });
  assert.equal(preview.isError, undefined, preview.text);
  assert.equal(preview.data.dryRun, true);
  assert.deepEqual(Object.keys(preview.data.created).sort(), ["dot", "dot.in", "dot.out"]);
  assert.equal(findLayer(await saved(), "dot"), undefined, "a dry run saves nothing");

  const refused = await agent("edit", { ops: [
    { op: "update_layer", layer: "tagline", properties: { x: 310 } },
    { op: "add_layer", layerType: "ellipse", name: "dot", properties: { x: 900, y: 900, width: 40, height: 40 },
      animations: [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-fade", start: 1, duration: 0.4, easing: "wobbly-ish" }] },
  ] });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.op, 1);
  assert.match(refused.data.reason, /^Operation 1 \(add_layer\): animations\[1\]: Unknown easing "wobbly-ish"/);
  const fixed = await agent("edit", { retry: refused.data.retry, fix: { 1: { animations: [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-fade", mode: "out", start: 3, duration: 0.4 }] } } });
  assert.equal(fixed.isError, undefined, fixed.text);
  const dot = findLayer(await saved(), "dot");
  assert.deepEqual(dot.animations.map((animation) => animation.kind), ["in", "out"]);
});

test("the inline-animations example in the kino skill runs as written", async () => {
  const skill = skillFiles()["references/edits.md"];
  const [ops] = jsonBlocks(skill.split("A layer with its entrance and exit in one op:")[1]);
  await agent("project", { action: "create", id: "skill-inline", name: "Skill", width: 1920, height: 1080, duration: 6 });
  const response = await server.api("/api/agent/edit", { method: "POST", body: { project: "skill-inline", ops } });
  const reply = await response.json();
  assert.equal(reply.isError, undefined, reply.text);
  const { created, times } = reply.data;
  assert.deepEqual(times, { [created["tagline.in"]]: [0.6, 1.1], [created["tagline.out"]]: [5.4, 5.8] });
  const tagline = findLayer(await saved("skill-inline"), "tagline");
  assert.deepEqual(tagline.animations.map((animation) => animation.kind), ["in", "out"]);
  await agent("project", { action: "open", id: "answers" });
});

test("library op answers several names in one call", async () => {
  const both = await agent("library", { topic: "op", name: ["update_layer", "add_animation"] });
  assert.match(both.text, /^update_layer \{/);
  assert.match(both.text, /\n\nadd_animation \{/);
  const listed = await agent("library", { topic: "op", name: "update_layer, add_animation" });
  assert.equal(listed.text, both.text);
  const typo = await agent("library", { topic: "op", name: ["update_layer", "add_layr"] });
  assert.match(typo.text, /\n\nadd_layr: /);
  // Words that are a tool, a rules name or a near topic answer what they stand for.
  assert.match((await agent("library", { topic: "op", name: "look" })).data.reason, /^look is a tool, not an edit op: call look/);
  assert.match((await agent("library", { topic: "render" })).text, /^\(topic "render" read as rules \{name:"render"\}\)\nrender start/);
  assert.match((await agent("library", { topic: "rules", name: "stroke" })).text, /^No rules topic "stroke"; what mentions it:/);
  await agent("notes", { action: "set_plan", steps: ["brief", "build"] });
  assert.match((await agent("notes", { action: "plan_done", step: "brief" })).text, /^plan saved: 1\/2 done/);
});

test("library media pages 30 files at a time and says how many are left", () => {
  const files = Array.from({ length: 65 }, (_, index) => index);
  assert.deepEqual({ ...pageOf(files), items: pageOf(files).items.length }, { items: 30, page: 1, pages: 3, left: 35 });
  assert.deepEqual(pageOf(files, 3).items, [60, 61, 62, 63, 64]);
  assert.equal(pageOf(files, 9).page, 3, "a page past the end shows the last one");
  assert.equal(pageOf(files, 3).left, 0);
});

test("library search turns what a reference shows into the kino name and the call that reads it, in the first three lines", () => {
  const cases = {
    glow: ["glow", 'library {topic:"rules", name:"light"}'], bloom: ["glow", 'name:"light"'],
    particles: ["embers", 'name:"particles"'], embers: ["embers", 'name:"particles"'],
    subtitles: ["add_captions", 'library {topic:"op", name:"add_captions"}'], "cut out": ["cut_out", 'name:"cut_out"'], cutout: ["cut_out", 'name:"cut_out"'],
    "speed ramp": ["speed-ramp", 'library {topic:"moves", name:"speed-ramp"}'], "slow motion": ["speed-ramp", 'name:"speed-ramp"'],
    "repeat on beats": ["beat-repeat", 'library {topic:"moves", name:"beat-repeat"}'],
    shake: ["impact-accent", 'library {topic:"moves", name:"impact-accent"}'], flash: ["impact-accent", 'name:"impact-accent"'],
    "light rays": ["light-rays", 'name:"light"'], "color grade": ["color_filter", 'library {topic:"op", name:"color_filter"}'], "green tint": ["white-balance", 'name:"color"'],
    "split screen": ["split-screen", 'library {topic:"moves", name:"split-screen"}'], "side by side": ["split-screen", 'name:"split-screen"'],
    "picture in picture": ["picture-in-picture", 'library {topic:"moves", name:"picture-in-picture"}'], pip: ["picture-in-picture", 'name:"picture-in-picture"'],
  };
  for (const [query, [name, call]] of Object.entries(cases)) {
    const lines = searchGuide(query).split("\n");
    assert.equal(lines[0], "kino names for it:", query);
    const line = lines.slice(1, 4).find((entry) => entry.startsWith(`${name} (`));
    assert.ok(line?.includes(call), `${query}: ${name} with ${call} in ${lines.slice(1, 4).join(" | ")}`);
  }
  // Punctuation and case do not count.
  assert.match(searchGuide("Bloom!"), /^kino names for it:\nglow \(/);
  // A common word inside a longer query is not a look: no wrong lead ahead of the topics.
  const wrong = { "green screen": ["white-balance", "color-wheels"], "ramp up numbers": ["speed-ramp", "clip-speed"], "reverse transition": ["clip-speed"], "repeat text": ["beat-repeat"], "hit the button": ["impact-accent"] };
  for (const [query, names] of Object.entries(wrong)) {
    const leads = searchGuide(query).split("\n").filter((line) => /^[a-z_-]+ \((effect|move|op|topic): /.test(line));
    for (const name of names) assert.ok(!leads.some((line) => line.startsWith(`${name} (`)), `${query} does not lead with ${name}: ${leads.join(" | ")}`);
  }
});

// Reports called vignette, grain, focus-band, duotone and tritone missing, and read engine source for
// the fields of speed-lines: library effects answered "No saved text effects".
test("library effects lists the whole catalog small, with a name gives its fields and defaults, and plain words reach the right effect, move or font help", () => {
  const list = effectsListText().text;
  for (const effect of EFFECTS) assert.ok(list.includes(`${effect.key}`), `${effect.key} is listed`);
  for (const key of ["vignette", "grain", "focus-band", "duotone", "tritone", "speed-lines"]) assert.ok(list.includes(key), key);
  assert.ok(estimateTextTokens(list) < 1500, `the list is ${estimateTextTokens(list)} tokens`);
  const lines = effectDetailText("vignette").text.split("\n");
  assert.match(lines[0], /^vignette \(Vignette, Post FX\): /);
  assert.ok(lines.includes("  amount number 0..1 default 0.5"), lines.join("|"));
  assert.ok(lines.includes('  color color default "#000000"'));
  assert.match(effectDetailText("speed-lines").text, /\n {2}taper number 0\.\.1 default 1\n/);
  assert.match(effectDetailText("focus-band").text, /a timed change: 0\.8 s/);
  // A plain word or a different spelling reads as the effect; a wrong name is null (the service adds didYouMean).
  assert.match(effectDetailText("depth of field").text, /^\("depth of field" read as focus-band/);
  assert.equal(effectDetailText("Speed_Lines").data.effect, "speed-lines");
  assert.equal(effectDetailText("nothing-like-it"), null);

  const found = (query, name) => searchGuide(query).split("\n").slice(0, 4).some((line) => line.startsWith(`${name} (`));
  for (const [query, name] of [["vignette", "vignette"], ["dark edges", "vignette"], ["depth of field", "focus-band"], ["tilt shift", "focus-band"], ["rim light", "glow"], ["light streak", "lens-flare"],
    ["neon", "outline_text"], ["typed", "type-on"], ["highlight", "accent-hit"], ["brush", "set_font"], ["scrawl", "set_font"], ["handwritten", "set_font"], ["grain", "grain"], ["duotone", "duotone"]])
    assert.ok(found(query, name), `${query} leads to ${name}: ${searchGuide(query)}`);
  assert.match(searchGuide("brush"), /library \{topic:"fonts", search:"<the look: brush, handwritten, marker, stencil/);
  assert.match(searchGuide("letterbox").split("\n")[0], /^no kino name for "letterbox" yet: build it from two black rectangle layers/);
  assert.match(searchGuide("lightning").split("\n")[0], /^no kino name for "lightning" yet: build it from a jagged path layer/);
});

test("render start with wait:true answers with the checked file, or says it is still running", { skip: skipWithoutMediaTools }, async () => {
  const done = await agent("render", { action: "start", quality: "draft", wait: true });
  assert.equal(done.isError, undefined, done.text);
  assert.match(done.text, /^R\d+ draft done rev \d+ 960×540 30fps 4s · rendered /);
  assert.match(done.text, /file checks passed/);
  assert.equal(done.data.status, "done");

  // A changed document needs new frames, so a zero-second wait ends before the render does.
  await agent("edit", { ops: [{ op: "update_layer", layer: "tagline", properties: { text: "Plan the month" } }] });
  const quick = await agent("render", { action: "start", quality: "draft", wait: true, timeout_s: 0 });
  assert.match(withoutNext(quick.text), /\nStill running: render \{action:"wait", job:"R\d+"\} returns the files\.$/);
  assert.match(quick.text, /\nnext: render \{"action":"wait","job":"R\d+"\}$/);
  await agent("render", { action: "cancel", job: quick.data.job });

  // A smoother draft to judge motion: fps up to 30, never more.
  const smooth = await agent("render", { action: "start", quality: "draft", fps: 30, wait: true });
  assert.match(smooth.text, /^R\d+ draft done rev \d+ 960×540 30fps 4s/);
  const capped = await agent("render", { action: "start", quality: "draft", options: { fps: 60 }, wait: true });
  assert.match(capped.text, /960×540 30fps/);
});

test("fast draft excerpts keep the project, expose actual bounds and reuse only matching intervals", { skip: skipWithoutMediaTools }, async () => {
  const project = "fast-range";
  await agent("project", { action: "create", id: project, name: "Fast range", width: 1280, height: 720, duration: 2 });
  await agent("edit", { project, ops: [{ op: "add_layer", layerType: "rectangle", name: "review-tile",
    properties: { x: 100, y: 100, width: 200, height: 200, fill: "#2563eb" } }] });
  const before = await saved(project);
  const request = { project, preview: "fast", from: 1, to: 1.5, wait: true };
  const began = performance.now();
  const first = await agent("render", request);
  assert.equal(first.isError, undefined, first.text);
  assert.equal(first.data.status, "done", first.text);
  assert.deepEqual(first.data.range, { first: 15, count: 8, from: 1, to: 23 / 15, duration: 8 / 15 });
  const file = first.data.files[0];
  assert.deepEqual([file.width, file.height, file.fps], [640, 360, 15]);
  assert.equal(file.validation.ok, true);
  const cachedAt = performance.now();
  const repeated = await agent("render", request);
  const cachedMs = performance.now() - cachedAt;
  assert.equal(repeated.data.status, "done", repeated.text);
  assert.equal(repeated.data.cachedScenes.length, 1);
  const otherInterval = await agent("render", { ...request, from: 0, to: 0.5 });
  assert.equal(otherInterval.data.status, "done", otherInterval.text);
  assert.equal(otherInterval.data.cachedScenes.length, 0, "different interval with otherwise identical settings is not reused");
  const changed = await agent("render", { ...request, from: 0, to: 0.5, fps: 12, options: { draftWidth: 320 } });
  assert.equal(changed.data.status, "done", changed.text);
  assert.equal(changed.data.cachedScenes.length, 0);
  assert.deepEqual([changed.data.files[0].width, changed.data.files[0].height, changed.data.files[0].fps], [320, 180, 12]);
  assert.equal((await saved(project)).revision, before.revision);
  for (const bad of [{ from: 1 }, { from: 1, to: 3 }, { from: 1, to: 1.5, quality: "final" }]) {
    const reply = await agent("render", { project, preview: "fast", ...bad });
    assert.equal(reply.isError, true, reply.text);
  }
  console.log(`Synthetic 0.533s excerpt, 640x360/15fps: first ${Math.round(cachedAt - began)}ms; identical cached export ${Math.round(cachedMs)}ms.`);
});
