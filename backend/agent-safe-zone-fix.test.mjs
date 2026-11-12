// The safe_zone fix moves a layer's animations with it. In a review of agent edits a 9:16 title
// with a preset Slide In above the safe zone was moved by check {fix:"auto"} with update_layer
// alone: the slide still ended at the old y (an animation's value is drawn over the layer's), so
// the title stayed where it was and each check {fix:"auto"} moved the layer's own y again
// (251 -> 302 -> 353) while the finding stayed. Runs on a real server with a temporary data folder.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestServer } from "./media.test.support.mjs";

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

const safeZone = (check, ref) => check.data.findings.filter((finding) => finding.rule === "safe_zone" && finding.ref === ref);
// The saved y of the title and the y its slide goes from and to.
async function places(project) {
  const response = await server.api(`/api/projects/${project}`);
  assert.equal(response.status, 200);
  const { document } = await response.json();
  const title = document.scenes[0].layers.find((layer) => layer.name === "title");
  const [slide] = title.animations;
  return { from: slide.from.y, to: slide.to.y, y: title.y };
}

test("check {fix:\"auto\"} moves a sliding title into the safe zone in one pass", async () => {
  await agent("project", { action: "create", id: "safe", name: "Safe", width: 1080, height: 1920, duration: 6, background: "#202830" });
  const made = await agent("edit", { project: "safe", ops: [{ op: "add_layer", layerType: "text", name: "title",
    properties: { x: 140, y: 200, text: "Hello there", fontSize: 96, fill: "#ffffff" }, animations: [{ preset: "preset-slide", start: 0.2, duration: 0.6 }] }] });
  assert.equal(made.isError, undefined, made.text);
  const before = await places("safe");
  assert.equal(before.to, before.y, "the slide ends at the layer's own place");
  assert.ok(before.from > before.to, "it slides up");

  const first = await agent("check", { project: "safe", pixels: false });
  const [finding] = safeZone(first, "title");
  assert.ok(finding, first.text);
  assert.equal(finding.auto, true, JSON.stringify(finding));
  // The fix is a list: the layer's place and the slide's ends, both moved by the same amount.
  assert.ok(Array.isArray(finding.fix), JSON.stringify(finding.fix));
  const [move, slide] = finding.fix;
  assert.equal(move.op, "update_layer");
  assert.equal(slide.op, "update_animation");
  const shift = move.properties.y - before.y;
  assert.ok(shift > 0, "the title moves down, into the safe zone");
  assert.deepEqual(slide.properties, { from: { y: before.from + shift }, to: { y: move.properties.y } });

  const fixed = await agent("check", { project: "safe", fix: "auto", pixels: false });
  assert.equal(fixed.isError, undefined, fixed.text);
  // Other rules (a still title, a wrapped line) may be fixed in the same edit; the safe zone fix is one of them.
  assert.match(fixed.text, /fixed safe_zone title/);
  assert.deepEqual(safeZone(fixed, "title"), [], fixed.text);
  const after = await places("safe");
  assert.deepEqual(after, { from: before.from + shift, to: before.to + shift, y: before.y + shift }, "the slide moved with the title and still goes up");

  // A second pass finds nothing to move and saves nothing.
  const again = await agent("check", { project: "safe", fix: "auto", pixels: false });
  assert.equal(again.data.rev, fixed.data.rev, again.text);
  assert.deepEqual(safeZone(again, "title"), []);
  assert.deepEqual(await places("safe"), after);
});

test("a custom animation that moves the layer leaves the safe_zone fix to the agent", async () => {
  await agent("project", { action: "create", id: "path", name: "Path", width: 1080, height: 1920, duration: 6, background: "#202830" });
  const made = await agent("edit", { project: "path", ops: [
    { op: "add_layer", layerType: "text", name: "title", properties: { x: 140, y: 200, text: "Hello there", fontSize: 96, fill: "#ffffff" } },
    { op: "add_animation", layer: "title", animation: { kind: "custom", name: "Drift", start: 0, duration: 1, easing: "ease-out", from: { y: 300 }, to: { y: 200 } } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const check = await agent("check", { project: "path", pixels: false });
  const [finding] = safeZone(check, "title");
  assert.ok(finding, check.text);
  assert.equal(finding.auto, undefined, `shown, not applied: ${JSON.stringify(finding)}`);
  const fixed = await agent("check", { project: "path", fix: "auto", rules: ["safe_zone"], pixels: false });
  assert.equal(fixed.data.rev, check.data.rev, "nothing was applied");
});

// A slide-up entrance that holds below the zone before it starts, then a drift that ends below
// it: the fix covered only the longest stretch (3.8 s to 6 s), so after sending it check found
// the held first frame (0 s to 0.2 s) and gave a second, different move. Now one fix covers every
// stretch, and the message names each one. (The layer is now hidden until its entrance starts,
// so the first stretch is the entrance's first frame at 0.2 s.)
test("one safe_zone fix covers every stretch outside the zone, and the message names each", async () => {
  await agent("project", { action: "create", id: "spans", name: "Spans", width: 1080, height: 1920, duration: 6, background: "#202830" });
  const made = await agent("edit", { project: "spans", ops: [
    { op: "add_layer", layerType: "text", name: "cap2", properties: { x: 120, y: 1250, width: 840, height: 100, text: "Caption line", fontSize: 64, fill: "#ffffff" },
      animations: [{ preset: "preset-slide", start: 0.2, duration: 0.6, parameters: { direction: "up", distance: 40 } }] },
    { op: "add_animation", layer: "cap2", animation: { kind: "custom", name: "Drift", start: 0.8, duration: 3, from: { y: 1250 }, to: { y: 1220 } } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const check = await agent("check", { project: "spans", pixels: false });
  const [finding] = safeZone(check, "cap2");
  assert.ok(finding, check.text);
  assert.match(finding.message, /outside the safe zone \(.*\) at 0\.2s(, .*)? and from 3\.8s to 6s,/, finding.message);
  const sent = await agent("edit", { project: "spans", ops: finding.fix });
  assert.equal(sent.isError, undefined, sent.text);
  const again = await agent("check", { project: "spans", pixels: false });
  assert.deepEqual(safeZone(again, "cap2"), [], again.text);
});

// In a review of agent edits a title climbed from below the zone to above it. Its places at rest
// were further apart than the zone is tall, and the fix was worked out from the longest stretch
// alone: it pushed the other stretch further out, the next check moved it back, and so on.
test("a layer whose places at rest cannot all fit gets a hint to shorten its move, not a move", async () => {
  await agent("project", { action: "create", id: "climb", name: "Climb", width: 1080, height: 1920, duration: 6, background: "#202830" });
  const made = await agent("edit", { project: "climb", ops: [
    { op: "add_layer", layerType: "text", name: "up", properties: { x: 120, y: 1250, width: 800, height: 120, text: "Going up", fontSize: 90, fill: "#ffffff" } },
    { op: "add_animation", layer: "up", animation: { kind: "custom", name: "Climb", start: 1, duration: 2, easing: "smooth", from: { y: 1250 }, to: { y: 80 } } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const check = await agent("check", { project: "climb", pixels: false });
  const [finding] = safeZone(check, "up");
  assert.ok(finding, check.text);
  assert.equal(typeof finding.fix, "string", `a hint, not a move: ${JSON.stringify(finding.fix)}`);
  assert.match(finding.fix, /^Its places at rest span \d+ px top to bottom, but the safe zone is \d+ px tall, so no one move brings them all in\. Shorten the move \("Climb"\) so its start and its end both fit, or make the layer smaller\.$/);
  assert.match(finding.message, /from 0s to 1s and from 3s to 6s/);
  // check {fix:"auto"} stops: nothing is moved and the next check gives the same answer.
  const fixed = await agent("check", { project: "climb", fix: "auto", rules: ["safe_zone"], pixels: false });
  assert.equal(fixed.data.rev, check.data.rev, fixed.text);
  assert.deepEqual(safeZone(fixed, "up").map((entry) => entry.fix), [finding.fix]);
});
