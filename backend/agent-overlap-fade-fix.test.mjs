// A blur exit leaves its layer on screen. Only fade, appear and blink change opacity (mask and
// wipe change reveal), so a title that leaves with preset-blur stays there, blurred, and the next
// title is drawn over it. While making the smokescreen promo the check said only "overlaps from
// 0s to 20s". Now the overlap names the exit that does not fade, and check {fix:"auto"} adds a
// preset-fade with the same timing. The last test: a flash under a layer added after it (covered_layer)
// is moved above it by the auto fix. Runs on a real server with a temporary data folder.
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

test("a blur entrance that waits on screen loses its blur and fades in plainly (never blur and fade)", async () => {
  // blur-slide becomes a plain slide plus a fade with its timing; preset-blur becomes preset-fade.
  for (const [id, preset, expected] of [
    ["waits", "preset-blur-slide", [["update_animation", "slide", undefined], ["add_animation", "preset-fade", 2.6]]],
    ["blurs-in", "preset-blur", [["update_animation", "fade", undefined]]],
  ]) {
    await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 6, background: "#101010" });
    await agent("edit", { project: id, ops: [
      title("first", "It watches cameras", [{ preset: "preset-fade", start: 0, duration: 0.4 }, { preset: "preset-fade", mode: "out", start: 2, duration: 0.4 }]),
      // The layer's own Show at 0 keeps it on screen before its entrance (a new preset entrance
      // alone now hides the layer until it starts, entranceHide.js).
      title("second", "all night long", [{ preset: "show", start: 0 }, { preset, start: 2.6, duration: 0.5 }]),
    ] });
    const check = await agent("check", { project: id, pixels: false });
    const [finding] = overlaps(check);
    assert.ok(finding, check.text);
    assert.match(finding.message, /entrance .* without fading it in.*swaps its blur for a plain fade/, finding.message);
    assert.deepEqual([finding.fix].flat().map((op) => [op.op, op.properties?.preset?.id ?? op.preset, op.start]), expected);
    const fixed = await agent("check", { project: id, fix: "auto", pixels: false });
    assert.deepEqual(overlaps(fixed), [], fixed.text);
    const second = await agent("inspect", { project: id, layer: "second" });
    assert.match(second.text, /preset fade opacity 0→1 2\.6s/, second.text);
    assert.doesNotMatch(second.text, /blur/i, second.text);
  }
});

test("a flash drawn under footage added after it is reported, and check {fix:\"auto\"} moves it above", async () => {
  // The order an agent built: the flash first, then a full-frame layer, which covers it all its time.
  await agent("project", { action: "create", id: "buried", name: "Buried", width: 1920, height: 1080, duration: 4, background: "#101010" });
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  const made = await agent("edit", { project: "buried", ops: [
    { op: "add_layer", layerType: "rectangle", name: "flash", properties: { ...full, fill: "#ffffff" },
      animations: [{ preset: "preset-fade", start: 1, duration: 0.1 }, { preset: "preset-fade", mode: "out", start: 1.1, duration: 0.3 }] },
    { op: "add_layer", layerType: "rectangle", name: "ground", properties: { ...full, fill: "#224466" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const order = async () => (await (await server.api("/api/projects/buried")).json()).document.scenes[0].layers.map((layer) => layer.name);
  assert.deepEqual(await order(), ["flash", "ground"]);

  const first = await agent("check", { project: "buried", pixels: false });
  const [finding] = first.data.findings.filter((entry) => entry.rule === "covered_layer");
  assert.ok(finding, first.text);
  assert.match(finding.message, /flash never shows: ground is drawn over it/, finding.message);
  assert.equal(finding.auto, true, JSON.stringify(finding));
  assert.deepEqual([finding.fix.op, finding.fix.position], ["move_layers", "above"]);

  const fixed = await agent("check", { project: "buried", fix: "auto", pixels: false });
  assert.equal(fixed.isError, undefined, fixed.text);
  assert.deepEqual(await order(), ["ground", "flash"]);
  assert.deepEqual(fixed.data.findings.filter((entry) => entry.rule === "covered_layer"), [], fixed.text);
});
