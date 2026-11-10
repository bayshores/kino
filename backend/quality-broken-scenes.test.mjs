// Milestone A3: a 15 s promo that passes every gate, and 12 copies of it, each broken on
// purpose in one way. The agent's `check` (with rendered pixels) must catch every one with
// an error, the final render must be refused while it stands, and `check {fix:"auto"}` and
// waivers must clear what they should. Everything goes through the real agent service.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// look review until every moment is reviewed: a final render of a whole video needs it (review.mjs).
async function reviewAll(project) {
  for (let round = 0; round < 40; round += 1) if (!(await agent("look", { project, mode: "review", inline: false })).data.left) return;
}

const INK = "#f4f1ea";
const text = (name, role, value, properties) => ({
  op: "add_layer", layerType: "text", name,
  properties: { text: value, role, fill: INK, fontFamily: "Inter", fontWeight: 400, ...properties },
});
const fade = (layer, start, duration, easing, mode = "in") => ({ op: "add_animation", layer, preset: "preset-fade", mode, start, duration, easing });
const slide = (layer, start, duration, easing) => ({ op: "add_animation", layer, preset: "preset-slide", start, duration, easing, parameters: { direction: "up", distance: 30 } });

/**
 * The ops for the promo. Each option breaks one thing; the defaults pass every gate.
 * Three beats: a headline over a hero card (0–5.5 s), a feature line (5.5–11.5 s), a CTA (12–15 s).
 */
function promo(options = {}) {
  const o = {
    headlineEasing: "ease-out", subheadY: 430, subheadEasing: "smooth",
    bodyText: "Finds a time that works", bodyOut: 10.8, bodySize: 48, bodyFill: INK,
    ctaX: 120, cta: true, assertTime: 1.5, same: null, flash: false, badgeSize: 36,
    ...options,
  };
  // `same` sets every animation's easing and duration (the same_motion break).
  const timing = (duration, easing) => (o.same ? [o.same.duration, o.same.easing] : [duration, easing]);
  const ops = [
    { op: "update_project", properties: { videoType: "promo" } },
    { op: "update_scene", properties: { duration: 15, background: "#0e1116", assertions: [{ type: "visible_by", target: "headline", time: o.assertTime }] } },
    // A badge drawn once in its own scene and used as a component copy.
    { op: "add_scene", name: "badge", width: 360, height: 100, background: "#00000000" },
    { op: "add_layer", scene: "badge", layerType: "text", name: "badge-text", properties: { text: "New", x: 20, y: 20, width: 320, height: 60, fontSize: o.badgeSize, fill: INK, fontFamily: "Inter" } },
    { op: "create_component", scene: "badge" },
  ];
  if (o.flash) ops.push(
    { op: "add_layer", layerType: "rectangle", name: "flash", properties: { x: 0, y: 0, width: 1920, height: 1080, fill: "#f4f1ea", role: "decor" } },
    { op: "add_animation", layer: "flash", preset: "preset-blink", start: 6, duration: 2, parameters: { count: 12 } },
  );
  ops.push(
    { op: "add_layer", layerType: "rectangle", name: "hero", properties: { role: "hero", x: 840, y: 180, width: 960, height: 720, fill: "#2a3142", radius: 32 } },
    { op: "add_animation", layer: "hero", preset: "preset-grow", start: 0.5, ...pick(timing(0.8, "natural")) },
    { op: "add_animation", layer: "hero", preset: "preset-fade", mode: "out", start: 11, ...pick(timing(0.5, "ease-in")) },
    text("logo", "logo", "Orbit", { x: 120, y: 80, width: 400, height: 70, fontSize: 56, fontWeight: 700 }),
    { ...fade("logo", 0.2, ...timing(0.5, "ease-out")) },
    text("headline", "headline", "Plan your week", { x: 120, y: 300, width: 700, height: 100, fontSize: 80, fontWeight: 700 }),
    { ...slide("headline", 0.3, ...timing(0.7, o.headlineEasing)) },
    { ...fade("headline", 0.3, ...timing(0.7, "smooth")) },
    { ...fade("headline", 5, ...timing(0.45, "ease-in"), "out") },
    text("subhead", "subhead", "One shared calendar", { x: 120, y: o.subheadY, width: 700, height: 60, fontSize: 44, fill: "#c9c4b8" }),
    { ...fade("subhead", 0.6, ...timing(0.6, o.subheadEasing)) },
    { ...fade("subhead", 5, ...timing(0.4, "ease-in"), "out") },
    { op: "insert_component", component: "badge", name: "badge-1", properties: { x: 1400, y: 60 } },
    { ...fade("badge-1", 1, ...timing(0.5, "smooth")) },
    text("body", "body", o.bodyText, { x: 120, y: 320, width: 700, height: 200, fontSize: o.bodySize, fill: o.bodyFill }),
    { ...slide("body", 5.7, ...timing(0.6, "ease-out")) },
    { ...fade("body", 5.7, ...timing(0.6, "smooth")) },
    { ...fade("body", o.bodyOut, ...timing(0.4, "ease-in"), "out") },
  );
  if (o.cta) ops.push(
    text("cta", "cta", "Try Orbit free", { x: o.ctaX, y: 460, width: 900, height: 100, fontSize: 72, fontWeight: 700 }),
    { ...fade("cta", 12.2, ...timing(0.6, "smooth")) },
    text("url", "body", "orbit.app", { x: 120, y: 580, width: 600, height: 60, fontSize: 40 }),
    { ...fade("url", 12.5, ...timing(0.5, "natural")) },
  );
  return ops;
}
function pick([duration, easing]) { return { duration, easing }; }

let projects = 0;
async function make(options) {
  projects += 1;
  const id = `promo-${projects}`;
  const created = await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 15 });
  assert.equal(created.isError, undefined, created.text);
  const edit = await agent("edit", { project: id, ops: promo(options) });
  assert.equal(edit.isError, undefined, edit.text);
  return id;
}

const errorsOf = (check) => check.data.findings.filter((finding) => finding.severity === "error");

test("the promo passes every gate, with pixels, in under 5 seconds", async () => {
  const id = await make();
  const started = Date.now();
  const check = await agent("check", { project: id });
  const elapsed = Date.now() - started;
  assert.equal(check.data.errors, 0, check.text);
  assert.ok(elapsed < 5000, `check took ${elapsed} ms`);
  assert.ok(check.data.ms < 5000);
});

// Each break: the options, and the rule and layer the check must name with an error.
const BREAKS = [
  ["linear easing on the headline's slide", { headlineEasing: "linear" }, "linear_motion", "headline"],
  ["a long feature line that leaves too soon", { bodyText: "Orbit finds the one slot that works for every person on the team", bodyOut: 7.5 }, "reading_time", "body"],
  ["18 px body text", { bodySize: 18 }, "type_min", "body"],
  ["the subhead on top of the headline", { subheadY: 330 }, "overlap", "subhead"],
  ["the CTA at the frame's edge", { ctaX: 10 }, "safe_zone", "cta"],
  ["dark text on the dark background", { bodyFill: "#1a1f2a" }, "contrast", "body"],
  ["a full-frame flash 6 times a second", { flash: true }, "flashing", null],
  ["a promise the headline cannot keep", { assertTime: 0.2 }, "assertions", "headline"],
  ["bounce easing on a fade", { subheadEasing: "bounce" }, "spring_on_fade", "subhead"],
  ["every animation the same", { same: { duration: 0.6, easing: "smooth" } }, "same_motion", null],
  ["no call to action at the end", { cta: false }, "promo_basics", null],
  ["tiny text inside a component copy", { badgeSize: 12 }, "type_min", "badge-1›badge-text"],
];

for (const [name, options, rule, ref] of BREAKS) {
  test(`check catches ${name} (${rule})`, async () => {
    const id = await make(options);
    const check = await agent("check", { project: id });
    const caught = errorsOf(check).filter((finding) => finding.rule === rule && (ref === null || finding.ref === ref));
    assert.ok(caught.length, `expected an error ${rule}${ref ? ` on ${ref}` : ""}:\n${check.text}`);
    assert.ok(check.data.byRule[rule].errors >= 1);
    // The final render is refused while the error stands.
    const render = await agent("render", { project: id, action: "start", quality: "final" });
    assert.equal(render.isError, true);
    assert.equal(render.data.error, "check_failed");
    assert.match(render.data.reason, /block a final render/);
  });
}

test("check {fix:\"auto\"} fixes linear easing and small text, and history can undo it", async () => {
  const id = await make({ headlineEasing: "linear", bodySize: 18 });
  const first = await agent("check", { project: id, pixels: false });
  assert.ok(first.data.autoFixes >= 2, first.text);
  const fixed = await agent("check", { project: id, fix: "auto" });
  assert.ok(fixed.data.applied.ops >= 2, fixed.text);
  assert.match(fixed.text, /applied \d+ auto fix/);
  const left = errorsOf(fixed).filter((finding) => ["linear_motion", "type_min"].includes(finding.rule));
  assert.deepEqual(left, [], fixed.text);
  const fixedSize = await agent("inspect", { project: id, targets: ["body"], fields: ["fontSize"] });
  assert.match(fixedSize.text, /fontSize 33/);
  // Restoring the revision before the fixes brings the 18 px text back.
  const restored = await agent("history", { project: id, action: "restore", rev: first.data.rev });
  assert.equal(restored.isError, undefined, restored.text);
  const undone = await agent("inspect", { project: id, targets: ["body"], fields: ["fontSize"] });
  assert.match(undone.text, /fontSize 18/);
});

test("a waiver accepts one finding on purpose and lets the final render start", async () => {
  const id = await make({ headlineEasing: "linear" });
  const waive = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "linear_motion", target: "headline", reason: "a mechanical slide, on purpose" }] });
  assert.equal(waive.isError, undefined, waive.text);
  const check = await agent("check", { project: id });
  assert.equal(check.data.errors, 0, check.text);
  assert.equal(check.data.waived, 1);
  assert.deepEqual(check.data.waivedFindings.map((entry) => [entry.rule, entry.ref, entry.reason]), [["linear_motion", "headline", "a mechanical slide, on purpose"]]);
  assert.match(check.text, /waived: linear_motion headline/);
  // The per-rule counts (for --json and the eval runner) leave the waived finding out.
  assert.equal(check.data.byRule.linear_motion, undefined);
  // No saved reference edits in this test: the reference gate is waived (agent-review tests it).
  await agent("edit", { project: id, ops: [{ op: "waive_check", code: "reference", target: "*", reason: "a check test" }] });
  await reviewAll(id);
  const render = await agent("render", { project: id, action: "start", quality: "final" });
  assert.equal(render.isError, undefined, render.text);
  await agent("render", { project: id, action: "cancel", job: render.data.job });
});

test("check {rules} limits the findings to those rules", async () => {
  const id = await make({ headlineEasing: "linear", bodySize: 18 });
  const check = await agent("check", { project: id, rules: ["type_min"], pixels: false });
  assert.ok(check.data.findings.length);
  assert.ok(check.data.findings.every((finding) => finding.rule === "type_min"), check.text);
  assert.match(check.text, /pixels off/);
});
