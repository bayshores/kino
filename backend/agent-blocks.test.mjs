// Milestone A4, building blocks through the agent API (POST /api/agent/<verb>): the skill's
// examples run as written; compose with a brand kit and uploaded pictures makes a 15 s promo
// with 0 errors; relative timing, cues, tokens and layout ops; variants and their side-by-side
// look; templates and retime; refusals that save nothing and say what to change. Runs on a
// real server with a temporary data folder.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { evaluateLayer } from "../engine/animation.js";

const ORBIT = { name: "orbit", colors: { bg: "#0f1420", surface: "#1a2233", text: "#f4f6fb", accent: "#ff7a45", accent2: "#4fd1c5" }, fonts: [{ family: "Montserrat" }, { family: "Inter" }] };
const PRODUCT = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
<rect x="180" y="40" width="1240" height="800" rx="36" fill="#2A2D33"/><rect x="216" y="76" width="1168" height="728" rx="12" fill="#F4F2EE"/>
<rect x="216" y="76" width="1168" height="70" fill="#FF6B4A"/><rect x="256" y="330" width="500" height="380" rx="16" fill="#E2E0DB"/>
<path d="M60 860 H1540 L1480 940 H120 Z" fill="#3A3E45"/></svg>`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<circle cx="256" cy="256" r="220" fill="#FF6B4A"/><path d="M170 330 L256 150 L342 330 Z" fill="#0E0F11"/></svg>`;

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(project, verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { project, ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
async function create(id) {
  const reply = await agent(id, "project", { action: "create", id, name: id });
  assert.equal(reply.isError, undefined, reply.text);
}
async function saved(id) {
  return (await server.api(`/api/projects/${id}`)).json();
}
async function upload(project, name, svg) {
  const response = await server.api(`/api/media?project=${project}`, { method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": name }, body: Buffer.from(new Resvg(svg).render().asPng()) });
  assert.equal(response.status, 201);
  return response.json();
}
const layersOf = (scene) => scene.layers;
const findLayer = (record, id) => record.document.scenes.flatMap(layersOf).find((layer) => layer.id === id);

// The JSON lines of each code block in the skill's building blocks reference: compose, timing
// and slots, variants and templates.
function skillBlocks() {
  return ["Building blocks", "Timing and slots", "Variants and templates"].flatMap((heading) => jsonBlocks(skillSection(heading)));
}

test("the skill's building-block examples run as written", { timeout: 120_000 }, async () => {
  await create("skill");
  const [promo, timing, more] = skillBlocks();
  assert.equal(promo.length, 3);

  const made = await agent("skill", "edit", { ops: promo });
  assert.equal(made.isError, undefined, made.text);
  let record = await saved("skill");
  const scene = record.document.scenes[0];
  assert.equal(record.document.scenes.length, 1, "compose reuses the empty first scene");
  assert.equal(scene.name, "Promo");
  assert.equal(scene.duration, 15);
  assert.equal(record.document.videoType, "promo");
  assert.deepEqual(scene.composition.beats.map((beat) => beat.id), ["logo-sting", "headline-reveal", "feature-callout", "cta-end"]);
  assert.equal(findLayer(record, "cta-end").text, "Start free today", "the recipe edit changed the beat");
  assert.equal(findLayer(record, "feature-callout").role, "hero", "the feature card is the hero");
  assert.match(made.text, /feature-callout\) is the hero/);
  const check = await agent("skill", "check");
  assert.equal(check.data.errors, 0, check.text);

  const timed = await agent("skill", "edit", { ops: timing });
  assert.equal(timed.isError, undefined, timed.text);
  record = await saved("skill");
  const cue = record.document.cues.find((entry) => entry.name === "drop");
  assert.equal(cue.kind, "marker");
  const reveal = findLayer(record, "headline-reveal").animations.find((animation) => animation.id === "headline-reveal.in");
  assert.ok(Math.abs(cue.time - (reveal.start + reveal.duration + 0.5)) < 0.02, "the cue is 0.5 s after the headline's entrance ends");
  const badge = findLayer(record, "badge");
  assert.equal(badge.animations[0].start, cue.time, "cue:drop resolves to the cue's time");
  assert.equal(badge.animations[0].duration, 0.7, "duration standard is 0.7 s");
  assert.ok(Array.isArray(badge.animations[0].easing), "easing enter becomes a curve");
  assert.ok(badge.x + badge.width > 1920 / 2 && badge.y < 1080 / 2, "the badge is in the top-right slot");
  const keys = findLayer(record, "keys");
  assert.equal(keys.type, "group", "the callout is one group");
  assert.equal(findLayer(record, "keys-label").role, "label");
  assert.equal(findLayer(record, "keys-label").parentId, "keys");

  const rest = await agent("skill", "edit", { ops: more });
  assert.equal(rest.isError, undefined, rest.text);
  record = await saved("skill");
  const variants = record.document.scenes.filter((entry) => entry.variant && entry.variant.of !== entry.id);
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((entry) => entry.variant.vary), ["layout", "layout", "layout"]);
  const spring = record.document.scenes.find((entry) => entry.name === "Spring");
  assert.equal(spring.duration, 20);
  assert.ok(spring.layers.some((layer) => layer.text === "Book a demo"));
  assert.equal(record.document.scenes[0].template.intro, 3);

  // The variants side by side: one picture, and a small data shape the dashboard can show.
  const sheet = await agent("skill", "look", { mode: "variants", scene: "s1" });
  assert.equal(sheet.isError, undefined, sheet.text);
  assert.ok(existsSync(sheet.data.path), "the contact sheet is saved");
  assert.equal(sheet.data.members.length, 4);
  assert.deepEqual(Object.keys(sheet.data.members[0]).sort(), ["id", "label", "scene"]);
  assert.equal(sheet.data.members[0].id, record.document.scenes[0].id, "the original comes first");
  const picked = await agent("skill", "edit", { ops: [{ op: "pick_variant", scene: sheet.data.members[2].id }] });
  assert.equal(picked.isError, undefined, picked.text);
  const again = await agent("skill", "look", { mode: "variants", scene: "s1" });
  assert.equal(again.data.members.filter((member) => member.picked).map((member) => member.id).join(), sheet.data.members[2].id);

  // vary "format" composes the scene again in 9:16; your own badge keeps its place in proportion,
  // and check {fix:"auto"} leaves 0 errors.
  const tall = await agent("skill", "edit", { ops: [{ op: "variants", scene: "s1", vary: "format", formats: ["9:16"] }] });
  assert.equal(tall.isError, undefined, tall.text);
  const finished = Object.entries(JSON.parse(tall.text).finished).filter(([key]) => key !== "next");
  assert.equal(finished.length, 1);
  assert.equal(finished[0][1].errors, 0, tall.text);
  record = await saved("skill");
  const portrait = record.document.scenes.find((entry) => entry.variant?.vary === "format" && entry.variant.of !== entry.id);
  assert.deepEqual([portrait.width, portrait.height], [1080, 1920]);
  const moved = portrait.layers.find((layer) => layer.id.startsWith("badge-"));
  const ratio = (layer, size) => (layer.x + layer.width / 2) / size;
  assert.ok(Math.abs(ratio(moved, 1080) - ratio(badge, 1920)) < 0.01, "the badge keeps its place across the frame");
});

test("a brand kit with an uploaded logo and product picture makes a 15 s promo with 0 errors", { timeout: 120_000 }, async () => {
  await create("kit");
  const logo = await upload("kit", "logo.png", LOGO);
  await upload("kit", "product.png", PRODUCT);
  const brand = await agent("kit", "edit", { ops: [{ op: "set_brand", ...ORBIT, logos: [{ media: logo.id }] }] });
  assert.equal(brand.isError, undefined, brand.text);
  const made = await agent("kit", "edit", { ops: [{ op: "compose", type: "promo", format: "16:9", duration: 15, look: "crisp", beats: [
    { recipe: "logo-sting", tagline: "Plan the week in one view" },
    { recipe: "device-slide", media: "product", text: "Everything in one view", transition: "push" },
    { recipe: "price-pop", price: "$29", text: "per month" },
    { recipe: "cta-end", text: "Try Orbit free", sub: "orbit.app", transition: "mask-wipe" },
  ] }] });
  assert.equal(made.isError, undefined, made.text);
  const record = await saved("kit");
  const scene = record.document.scenes[0];
  assert.equal(scene.duration, 15);
  assert.equal(scene.background.toLowerCase(), ORBIT.colors.bg);
  assert.equal(findLayer(record, "logo-sting").type, "image", "the brand's logo picture is used");
  assert.equal(findLayer(record, "device-slide").role, "hero");
  const check = await agent("kit", "check");
  assert.equal(check.data.errors, 0, check.text);

  // Reduced motion: the same promo with fades only.
  const reduced = await agent("kit", "edit", { ops: [{ op: "compose", scene: "s1", reduced: true }] });
  assert.equal(reduced.isError, undefined, reduced.text);
  const calm = (await saved("kit")).document.scenes[0];
  for (const layer of calm.layers) for (const animation of layer.animations ?? []) {
    const moves = ["x", "y", "scaleX", "scaleY", "rotation"].some((key) => animation.from?.[key] !== undefined || animation.to?.[key] !== undefined);
    assert.ok(!moves, `${animation.id} only fades with reduced motion`);
  }
});

test("refused block ops save nothing and say what to change; a retry fixes them", async () => {
  await create("refusals");
  const before = await saved("refusals");
  const reply = await agent("refusals", "edit", { ops: [
    { op: "compose", type: "promo", duration: 15, beats: [{ recipe: "headline-reveal", text: "Hello there" }, { recipe: "cta-end", text: "Try it" }] },
    { op: "recipe", name: "logo-stng", text: "Orbit" },
    { op: "set_cue", name: "drop", at: "after:nothing-here" },
  ] });
  assert.equal(reply.isError, true);
  assert.match(reply.data.reason, /logo by 5 s|hero covering 30%/);
  const typo = [reply.data, ...(reply.data.alsoRefused ?? [])].find((problem) => problem.op === 1);
  assert.ok(typo.didYouMean.includes("logo-sting"), "a misspelt recipe suggests the right one");
  assert.equal((await saved("refusals")).revision, before.revision, "nothing was saved");

  const fixed = await agent("refusals", "edit", { retry: reply.data.retry, fix: {
    0: { beats: [{ recipe: "logo-sting", text: "Orbit" }, { recipe: "feature-callout", text: "Shared calendars", sub: "Everyone sees the same week" }, { recipe: "cta-end", text: "Try it free" }] },
    1: null,
    2: { at: "after:feature-callout.in" },
  } });
  assert.equal(fixed.isError, undefined, fixed.text);
  const record = await saved("refusals");
  assert.equal(record.document.cues[0].name, "drop");

  const tight = await agent("refusals", "edit", { ops: [{ op: "compose", scene: "s1", duration: 4 }] });
  assert.equal(tight.isError, true);
  assert.match(tight.data.reason, /need at least [\d.]+ s .*Make duration at least/);
  const brand = await agent("refusals", "edit", { ops: [{ op: "set_brand", name: "x", colors: { bg: "blue-ish" } }] });
  assert.equal(brand.isError, true);
  const missing = await agent("refusals", "edit", { ops: [{ op: "remove_brand", name: "nope" }] });
  assert.equal(missing.isError, true);
  assert.match(missing.data.reason, /No brand kit "nope"/);
});

test("layout ops move layers into slots, line them up and keep them inside", async () => {
  await create("layout");
  const box = (name, x) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x, y: 100, width: 200, height: 120 } });
  const made = await agent("layout", "edit", { ops: [
    box("a", 0), box("b", 700), box("c", 900),
    { op: "add_layer", layerType: "text", name: "wide", properties: { text: "A line that is far too wide for its place", x: 1700, y: 900, width: 1400, height: 90, fontSize: 72 } },
    { op: "align", layers: ["a", "b", "c"], to: "top" },
    { op: "distribute", layers: ["a", "b", "c"], axis: "x" },
    { op: "stack", layers: ["a", "b"], direction: "down", gap: 20, slot: "A4:B6" },
    { op: "fit", layers: ["wide"] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const record = await saved("layout");
  const [a, b, c, wide] = ["a", "b", "c", "wide"].map((id) => findLayer(record, id));
  assert.equal(b.y, a.y + a.height + 20, "b is stacked under a");
  assert.equal(a.x, b.x);
  assert.ok(c.y >= 54 && c.y < 100, "c is aligned to the top of the safe area");
  assert.ok(wide.x + wide.width <= 1920 - 96 + 1 && wide.y + wide.height <= 1080 - 54 + 1, "fit moved the wide text inside the safe area");
  const placed = await agent("layout", "edit", { ops: [{ op: "place", layers: ["c"], right_of: "a", gap: 40 }] });
  assert.equal(placed.isError, undefined, placed.text);
  const moved = await saved("layout");
  assert.equal(findLayer(moved, "c").x, findLayer(moved, "a").x + 200 + 40);
});

test("place {on, of} centers a line on a face part: refused with the mark call when no face, estimated from a head mark, exact on a part mark", async () => {
  await create("face-place");
  await agent("face-place", "edit", { ops: [
    { op: "add_layer", layerType: "video", name: "face", properties: { src: "/api/media/00000000-0000-4000-8000-000000000000.mp4", x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "text", name: "shout", properties: { text: "GET AWAY!", x: 0, y: 0, width: 420, height: 100, fontSize: 80 }, animations: [{ preset: "preset-appear", start: 0.3, duration: 0.04 }] },
  ] });
  const center = (layer) => [layer.x + layer.width / 2, layer.y + layer.height / 2];
  // Without at, the moment is the layers' first entrance (0.3 s), named in the mark call.
  const none = await agent("face-place", "edit", { ops: [{ op: "place", layers: ["shout"], on: "mouth", of: "face" }] });
  assert.equal(none.isError, true);
  assert.match(none.text, /mark_subject \{layer:\\"face\\", t:0\.3, box:\[x, y, w, h\], part:\\"face\\"\}/);
  assert.doesNotMatch(none.text, /"slot"/, "the retry does not place on a slot instead");
  const head = await agent("face-place", "edit", { ops: [
    { op: "mark_subject", layer: "face", t: 0.3, box: [30, 5, 40, 90], part: "face" },
    { op: "place", layers: ["shout"], on: "mouth", of: "face", at: 0.3 },
  ] });
  assert.equal(head.isError, undefined, head.text);
  assert.match(head.text, /an estimate from the box \(mouth at 82% of its height\)/);
  const [x, y] = center(findLayer(await saved("face-place"), "shout"));
  assert.ok(Math.abs(x - 960) <= 1 && Math.abs(y - (0.05 + 0.82 * 0.9) * 1080) <= 1, `centered on the estimated mouth (${x}, ${y})`);
  const exact = await agent("face-place", "edit", { ops: [
    { op: "mark_subject", layer: "face", t: 0.3, box: [10, 60, 20, 10], part: "mouth" },
    { op: "place", layers: ["shout"], on: "mouth", of: "face", at: 0.3 },
  ] });
  assert.match(exact.text, /your mouth mark at file 0\.3 s \(exact\)/);
  assert.deepEqual(center(findLayer(await saved("face-place"), "shout")), [0.2 * 1920, 0.65 * 1080]);
});

test("place {around} sets a word beside the marked subject of the shot under it and a line split around it, with the covered share in the receipt", async () => {
  await create("around-place");
  await agent("around-place", "edit", { ops: [
    { op: "add_layer", layerType: "video", name: "shot", properties: { src: "/api/media/00000000-0000-4000-8000-000000000000.mp4", x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "text", name: "payoff", properties: { text: "KILL YOU", fontFamily: "Inter", fontWeight: 700, fontSize: 260, textResize: "width-height", x: 500, y: 400, width: 900, height: 300 } },
  ] });
  const unmarked = await agent("around-place", "edit", { ops: [{ op: "place", layers: ["payoff"], around: "subject" }] });
  assert.equal(unmarked.isError, true);
  assert.match(unmarked.text, /mark_subject \{layer:\\"<shot>\\", t:0, box:\[x, y, w, h\]\}/);
  // A side with no around names around, not only the below/above forms.
  const noAround = await agent("around-place", "edit", { ops: [{ op: "place", layers: ["payoff"], side: "left" }] });
  assert.equal(noAround.isError, true);
  assert.match(noAround.text, /place \{layers, side\} needs around: .*around:\\"subject\\", side:\\"left\\"/);
  const placed = await agent("around-place", "edit", { ops: [
    { op: "mark_subject", layer: "shot", t: 0, box: [40, 18, 20, 82] },
    { op: "place", layers: ["payoff"], around: "subject" },
  ] });
  assert.equal(placed.isError, undefined, placed.text);
  assert.match(placed.text, /around the subject of shot at 0 s \(your mark at file 0 s\), over it \(subject box x 768-1152, y 194-1080\): split at the word gap: \\"KILL\\" left, \\"YOU\\" right \(new layer payoff-2\) · letters inside the subject box at the worst moment \d+% → 0% · room left 648×972, right 648×972, above 1728×116, below none/);
  const record = await saved("around-place");
  assert.deepEqual([findLayer(record, "payoff").text, findLayer(record, "payoff-2").text], ["KILL", "YOU"]);
  const word = await agent("around-place", "edit", { ops: [{ op: "place", layers: ["payoff-2"], around: "shot", side: "above" }] });
  assert.match(word.text, /: above · letters inside the subject box at the worst moment \d+% → 0% · size 260 → \d+ px to fit the room/);
  // A face mark alone stands for a person: the box runs down to the picture's bottom, so no room below.
  const face = await agent("around-place", "edit", { ops: [
    { op: "add_layer", layerType: "video", name: "talk", properties: { src: "/api/media/00000000-0000-4000-8000-000000000001.mp4", x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "text", name: "name", properties: { text: "HER", fontFamily: "Inter", fontWeight: 700, fontSize: 120, textResize: "width-height", x: 900, y: 500 } },
    { op: "mark_subject", layer: "talk", t: 0, box: [42, 10, 16, 30], part: "face" },
    { op: "place", layers: ["name"], around: "talk" },
  ] });
  assert.match(face.text, /a face taken down to the picture's bottom for the body under it\), over it \(subject box x 806-1114, y 108-1080\).* · room left \d+×972, right \d+×972, above 1728×\d+, below none/);

  // A cut_out copy whose subject moves (its subjectPath, shares of its box, drawn with no file
  // size): the word in front of it from 1 to 2 s is cleared for the whole hold, not its first moment.
  await create("around-moving");
  const moving = await agent("around-moving", "edit", { ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: "/api/media/00000000-0000-4000-8000-000000000002.mp4", x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "video", name: "clip-subject", properties: { src: "/api/media/00000000-0000-4000-8000-000000000003.webm", x: 0, y: 0, width: 1920, height: 1080 } },
    { op: "add_layer", layerType: "text", name: "word", properties: { text: "KILL", fontFamily: "Inter", fontWeight: 700, fontSize: 160, textResize: "width-height", x: 1100, y: 420 },
      animations: [{ preset: "preset-fade", start: 1, duration: 0.2 }, { preset: "preset-fade", mode: "out", start: 1.8, duration: 0.2 }] },
  ] });
  assert.equal(moving.isError, undefined, moving.text);
  // The fields cut_out writes on its copy (cutout-operation.mjs), saved as the document.
  const { document, revision } = await saved("around-moving");
  Object.assign(document.scenes[0].layers.find((layer) => layer.id === "clip-subject"), { cutoutOf: "clip", subjectBox: [0.35, 0.2, 0.75, 1], subjectPath: [[1, 0.35, 0.2, 0.55, 1], [2, 0.55, 0.2, 0.75, 1]] });
  assert.equal((await server.api("/api/projects/around-moving", { method: "PUT", body: { document, revision } })).status, 200);
  assert.deepEqual(findLayer(await saved("around-moving"), "clip-subject").subjectPath[1], [2, 0.55, 0.2, 0.75, 1], "the document keeps the path");
  const cleared = await agent("around-moving", "edit", { ops: [{ op: "place", layers: ["word"], around: "clip-subject" }] });
  assert.match(cleared.text, /around the measured subject of the cut-out clip-subject, over it \(subject box at 1 s x 672-1056, y 216-1080 over the hold 1\.1-1\.9 s \(9 moments; the subject's box moves up to 3\d\d px\)\): (left|right) · letters inside the subject box at the worst moment \d+% at 1\.\d+ s → 0%/);
  const word2 = findLayer(await saved("around-moving"), "word");
  const ink = (t) => { const state = evaluateLayer(word2, t); return [state.x, state.x + state.width]; };
  for (const t of [1.1, 1.5, 1.9]) {
    const [a, b] = [0.35 + 0.2 * (t - 1), 0.55 + 0.2 * (t - 1)].map((share) => share * 1920);
    assert.ok(ink(t)[1] < a || ink(t)[0] > b, `clear of the subject at ${t} s`);
  }
  // follow:true through the tool: a pin path keeps the word right of the subject as it moves, and
  // check finds no linear_motion on it.
  const followed = await agent("around-moving", "edit", { ops: [
    { op: "update_layer", layer: "word", properties: { x: 1100 } },
    { op: "place", layers: ["word"], around: "clip-subject", side: "right", follow: true },
  ] });
  assert.match(followed.text, /: follows it on a pin path of 9 moments\): right · letters inside the subject box at the worst moment \d+% at 1\.\d+ s → 0%/);
  assert.doesNotMatch(followed.text, /linear_motion word/);
  const word3 = findLayer(await saved("around-moving"), "word");
  for (const t of [1.1, 1.5, 1.9]) assert.ok(evaluateLayer(word3, t).x > (0.55 + 0.2 * (t - 1)) * 1920, `right of the subject at ${t} s`);
  // Text its group shows (the group fades in at 1 s and out at 1.8 s; the text itself stays at
  // full opacity): the hold is the group's, not the whole scene.
  const grouped = await agent("around-moving", "edit", { ops: [
    { op: "add_layer", layerType: "text", name: "tag", properties: { text: "YOU", fontFamily: "Inter", fontWeight: 700, fontSize: 120, textResize: "width-height", x: 700, y: 700 } },
    { op: "group_layers", layerIds: ["tag"], name: "band" },
    { op: "add_animation", layer: "band", preset: "preset-fade", start: 1, duration: 0.2 },
    { op: "add_animation", layer: "band", preset: "preset-fade", mode: "out", start: 1.8, duration: 0.2 },
    { op: "place", layers: ["tag"], around: "clip-subject" },
  ] });
  assert.match(grouped.text, /over the hold 1\.1-1\.9 s/, grouped.text);
});

test("frame steps a camera group onto a region of a layer, then eases on, and check takes the cut as a cut", async () => {
  await create("camera");
  const made = await agent("camera", "edit", { ops: [
    { op: "add_layer", layerType: "rectangle", name: "shot", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#334455" } },
    { op: "frame", layer: "shot", rect: [25, 25, 50, 50], at: 1, cut: true },
    { op: "frame", layer: "shot", rect: [50, 50, 25, 25], at: 1.6, to: [50, 50, 100] },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const camera = findLayer(await saved("camera"), "shot-camera");
  assert.equal(findLayer(await saved("camera"), "shot").parentId, "shot-camera", "the layer went into a camera group");
  const [cut, move] = camera.animations;
  assert.ok(cut.duration < 0.01 && cut.start + cut.duration <= 1, "the cut is an instant step that lands by at");
  // The middle half fills the frame: 2x about the frame's center.
  assert.deepEqual(cut.to, { x: 0, y: 0, scaleX: 2, scaleY: 2 });
  assert.deepEqual(move.from, cut.to, "the move starts where the cut left the camera");
  // The bottom-right quarter's center (1200, 675) at the frame's center, 4x: x = 960 - 4*1200 - 960 + 4*960.
  assert.deepEqual([move.to.x, move.to.y, move.to.scaleX, move.easing], [-960, -540, 4, "expo-out"]);
  const check = await agent("camera", "check", {});
  assert.doesNotMatch(check.text, /speed_jump|duration_band|transitions_dense/, "a cut is a cut on purpose, not a too-quick move");
  // A cut at 0 has nothing to step from: the camera starts framed, with no wide frame 0 flash.
  const opened = await agent("camera", "edit", { ops: [{ op: "add_layer", layerType: "rectangle", name: "open", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#334455" } }, { op: "frame", layer: "open", rect: [25, 25, 50, 50], at: 0, cut: true }] });
  assert.equal(opened.isError, undefined, opened.text);
  assert.equal(evaluateLayer(findLayer(await saved("camera"), "open-camera"), 0).scaleX, 2, "framed on frame 0");
});

test("retime stretches a behavior ramp's seconds with its animation", async () => {
  const made = await agent("ramp", "project", { action: "create", id: "ramp", name: "ramp", width: 320, height: 180, duration: 6 });
  assert.equal(made.isError, undefined, made.text);
  const built = await agent("ramp", "edit", { ops: [{ op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 0, y: 0, width: 40, height: 40, fill: "#00C853" } },
    { op: "add_animation", layer: "box", animation: { kind: "custom", name: "Drift", start: 0, duration: 6, from: {}, to: {}, behavior: { ramp: { to: { x: 40 }, start: 4, duration: 2 } } } }] });
  assert.equal(built.isError, undefined, built.text);
  const retimed = await agent("ramp", "edit", { ops: [{ op: "retime", duration: 4 }] });
  assert.equal(retimed.isError, undefined, retimed.text);
  const animation = (await saved("ramp")).document.scenes[0].layers.find((layer) => layer.name === "box").animations[0];
  assert.ok(animation.behavior.ramp.start + animation.behavior.ramp.duration <= animation.duration + 1e-9, JSON.stringify(animation));
});

test("retime moves a sequence part's own clock and a sound's Play start with its Show", async () => {
  const made = await agent("film", "project", { action: "create", id: "film", name: "film", width: 320, height: 180, duration: 4 });
  assert.equal(made.isError, undefined, made.text);
  const built = await agent("film", "edit", { ops: [
    { op: "update_scene", properties: { name: "A", background: "#202020" } },
    { op: "add_scene", name: "B", width: 320, height: 180, duration: 4, background: "#202020" },
    { op: "add_layer", scene: "B", layerType: "rectangle", name: "box", properties: { x: 0, y: 0, width: 320, height: 180, fill: "#00C853" } },
    { op: "add_animation", scene: "B", layer: "box", preset: "preset-fade", start: 0.2, duration: 0.5 },
    { op: "add_sequence", properties: { name: "Film" }, scenes: ["A", "B"] },
  ] });
  assert.equal(built.isError, undefined, built.text);
  const filmId = (await saved("film")).document.scenes.find((scene) => scene.name === "Film").id;
  const voice = await agent("film", "edit", { ops: [{ op: "add_layer", scene: filmId, layerType: "audio", name: "voice", properties: { src: "/api/media/voice.m4a", mediaStart: 5, mediaDuration: 1 } },
    { op: "update_scene", scene: filmId, properties: { rests: [{ at: 5, until: 6 }] } }] });
  assert.equal(voice.isError, undefined, voice.text);
  const retimed = await agent("film", "edit", { ops: [{ op: "retime", scene: filmId, duration: 16 }] });
  assert.equal(retimed.isError, undefined, retimed.text);

  const film = (await saved("film")).document.scenes.find((scene) => scene.id === filmId);
  const partB = film.layers.find((layer) => layer.type === "component" && layer.name === "B");
  const show = partB.animations.find((animation) => animation.kind === "show");
  assert.equal(show.start, 8, "the 8 s middle of the 16 s film");
  assert.equal(partB.componentStart, show.start, "part B starts its own clock when it appears");
  // 5 s in the old middle (1.2 s to 6.8 s) lands at 1.2 + 3.8 × 13.6 / 5.6 s.
  assert.equal(film.layers.find((layer) => layer.name === "voice").mediaStart, 10.429);
  assert.deepEqual(film.rests, [{ at: 10.429, until: 12.857 }], "a planned still moves with its moments");

  // Part B's box fades in from 0.2 s on its own clock: still hidden just after it appears.
  const colorAt = async (t) => {
    const frame = await agent("film", "look", { scene: filmId, mode: "frame", t, width: 320 });
    assert.equal(frame.isError, undefined, frame.text);
    return (await readImage(Buffer.from(frame.images[0].data, "base64"))).pixel(160, 90);
  };
  assert.ok(near(await colorAt(8.05), [0x20, 0x20, 0x20]), "the box has not faded in yet at 8.05 s");
  assert.ok(near(await colorAt(9), [0x00, 0xc8, 0x53]), "the box is in at 9 s");
});

test("retime moves the beat cues and the rhythm with the music they were found in", { skip: skipWithoutMediaTools }, async () => {
  // A click every 0.5 s from 0.25 s in the file, played from 2 s for 6 s of an 8 s scene.
  const folder = await mkdtemp(path.join(tmpdir(), "kino-retime-beats-"));
  const file = path.join(folder, "clicks.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='if(gte(t,0.25),sin(2*PI*1500*mod(t-0.25,0.5))*exp(-mod(t-0.25,0.5)*60),0)':s=44100:d=8", file]);
  const upload = await server.api("/api/media", { method: "POST", headers: { "Content-Type": "audio/wav", "X-File-Name": "clicks.wav" }, body: await readFile(file) });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  await rm(folder, { recursive: true, force: true });
  const made = await agent("music", "project", { action: "create", id: "music", name: "music", width: 320, height: 180, duration: 8 });
  assert.equal(made.isError, undefined, made.text);
  const detected = await agent("music", "edit", { ops: [
    { op: "add_layer", layerType: "audio", name: "music", properties: { src: media.src ?? media.media?.src, mediaStart: 2, mediaDuration: 6 } },
    { op: "detect_beats", layer: "music" },
  ] });
  assert.equal(detected.isError, undefined, detected.text);
  assert.equal(detected.data.beats.firstBeat, 2.25);

  const sceneId = (await saved("music")).document.scenes[0].id;
  const retimed = await agent("music", "edit", { ops: [{ op: "retime", scene: sceneId, duration: 16 }] });
  assert.equal(retimed.isError, undefined, retimed.text);
  assert.ok(retimed.data.notes.includes('retime: "music" moved +1.143 s, and its beat and onset cues and the rhythm with it'), retimed.text);
  const moved = (await saved("music")).document;
  assert.equal(moved.scenes[0].layers.find((layer) => layer.name === "music").mediaStart, 3.143);
  assert.equal(moved.cues.find((cue) => cue.name === "beat-1").time, 3.393, "the first click is now heard at 3.393 s");
  assert.equal(moved.rhythm.offset, 3.393);

  // Finding the beats again on the moved music gives the same cues and rhythm.
  const again = await agent("music", "edit", { ops: [{ op: "detect_beats", layer: "music" }] });
  assert.equal(again.isError, undefined, again.text);
  const found = (await saved("music")).document;
  assert.deepEqual(found.cues, moved.cues);
  assert.deepEqual(found.rhythm, moved.rhythm);
});

test("library blocks lists recipes, looks and tokens, and explains one", async () => {
  await create("library");
  const all = await agent("library", "library", { topic: "blocks" });
  assert.equal(all.isError, undefined, all.text);
  for (const word of ["logo-sting", "feature-callout", "mask-wipe", "crisp", "editorial", "snappy", "B2:E5"]) assert.match(all.text, new RegExp(word));
  const one = await agent("library", "library", { topic: "blocks", name: "price-pop" });
  assert.match(one.text, /price/);
  const wrong = await agent("library", "library", { topic: "blocks", name: "price-pops" });
  assert.equal(wrong.isError, true);
  assert.ok(wrong.data.didYouMean.includes("price-pop"));
});
