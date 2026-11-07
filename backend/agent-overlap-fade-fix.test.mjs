// A blur exit leaves its layer on screen. Only fade, appear and blink change opacity (mask and
// wipe change reveal), so a title that leaves with preset-blur stays there, blurred, and the next
// title is drawn over it. While making the smokescreen promo the check said only "overlaps from
// 0s to 20s". Now the overlap names the exit that does not fade, and check {fix:"auto"} adds a
// preset-fade with the same timing. Runs on a real server with a temporary data folder.
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

const overlaps = (check) => check.data.findings.filter((finding) => finding.rule === "overlap");
const title = (name, text, animations) => ({ op: "add_layer", layerType: "text", name,
  properties: { x: 200, y: 400, width: 1400, height: 160, text, fontSize: 120, fill: "#ffffff" }, animations });

test("an overlap caused by a blur exit names it, and check {fix:\"auto\"} adds the fade", async () => {
  await agent("project", { action: "create", id: "blurs", name: "Blurs", width: 1920, height: 1080, duration: 6, background: "#101010" });
  const made = await agent("edit", { project: "blurs", ops: [
    title("first", "It watches cameras", [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-blur", mode: "out", start: 2, duration: 0.4 }]),
    title("second", "all night long", [{ preset: "preset-fade", start: 2.6, duration: 0.4 }]),
  ] });
  assert.equal(made.isError, undefined, made.text);

  const first = await agent("check", { project: "blurs", pixels: false });
  const [finding] = overlaps(first);
  assert.ok(finding, first.text);
  assert.match(finding.message, /exit .* without fading it/, finding.message);
  assert.equal(finding.auto, true, JSON.stringify(finding));
  assert.equal(finding.fix.op, "add_animation");
  assert.equal(finding.fix.preset, "preset-fade");
  assert.equal(finding.fix.mode, "out");
  assert.equal(finding.fix.start, 2);
  assert.equal(finding.fix.duration, 0.4);

  const fixed = await agent("check", { project: "blurs", fix: "auto", pixels: false });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.deepEqual(overlaps(fixed), [], fixed.text);
  // The same pass shortens the exit to fit its 0.4 s entrance (exit_ratio, the new fade included).
  assert.match(fixed.text, /fixed exit_ratio first/, fixed.text);
  assert.ok(!fixed.data.findings.some((finding) => finding.rule === "exit_ratio" || finding.rule === "duration_band" && /leave/.test(finding.message)), fixed.text);
  // A second pass has nothing left to add.
  const again = await agent("check", { project: "blurs", fix: "auto", pixels: false });
  assert.equal(again.data.rev, fixed.data.rev, again.text);
});

test("an overlap with fading layers keeps the plain hint", async () => {
  await agent("project", { action: "create", id: "stacked", name: "Stacked", width: 1920, height: 1080, duration: 6, background: "#101010" });
  await agent("edit", { project: "stacked", ops: [
    title("first", "It watches cameras", [{ preset: "preset-fade", start: 0, duration: 0.4 }]),
    title("second", "all night long", [{ preset: "preset-fade", start: 0.5, duration: 0.4 }]),
  ] });
  const check = await agent("check", { project: "stacked", pixels: false });
  const [finding] = overlaps(check);
  assert.ok(finding, check.text);
  assert.doesNotMatch(finding.message, /without fading/);
  assert.equal(finding.auto, undefined, JSON.stringify(finding));
});

test("a blur entrance that waits on screen gets a fade in", async () => {
  await agent("project", { action: "create", id: "waits", name: "Waits", width: 1920, height: 1080, duration: 6, background: "#101010" });
  await agent("edit", { project: "waits", ops: [
    title("first", "It watches cameras", [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-fade", mode: "out", start: 2, duration: 0.4 }]),
    title("second", "all night long", [{ preset: "preset-blur-slide", start: 2.6, duration: 0.5 }]),
  ] });
  const check = await agent("check", { project: "waits", pixels: false });
  const [finding] = overlaps(check);
  assert.ok(finding, check.text);
  assert.match(finding.message, /entrance .* without fading it/, finding.message);
  assert.deepEqual({ op: finding.fix.op, mode: finding.fix.mode, start: finding.fix.start, duration: finding.fix.duration }, { op: "add_animation", mode: "in", start: 2.6, duration: 0.5 });
  const fixed = await agent("check", { project: "waits", fix: "auto", pixels: false });
  assert.deepEqual(overlaps(fixed), [], fixed.text);
});
