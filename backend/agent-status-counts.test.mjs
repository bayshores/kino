// status and edit receipts count check findings without rendering frames, so they leave out the
// rendered rules (contrast, flashing). On a ten-minute project status said "0 err" while check
// found 14 contrast errors. Now status uses check's result for every scene check saw unchanged,
// and says plainly which scenes it could not run the pixel gates on.
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

const checksLine = (status) => status.text.split("\n").find((line) => line.startsWith("checks "));

test("status and check agree on errors, and status says when the pixel gates are not counted", async () => {
  await agent("project", { action: "create", id: "dim", name: "Dim", width: 640, height: 360, duration: 3 });
  // Dark grey words on a near-black scene: only the rendered contrast rule finds this.
  const made = await agent("edit", { project: "dim", ops: [
    { op: "update_scene", properties: { background: "#101418" } },
    { op: "add_layer", type: "text", name: "dim-words", properties: { text: "Hard to read", x: 120, y: 140, fontSize: 64, fill: "#1c2026" } },
    { op: "add_animation", layer: "dim-words", preset: "preset-fade", start: 0.2, duration: 0.6 },
  ] });
  assert.equal(made.isError, undefined, made.text);
  assert.match(made.data.check, /^0 err · .* · unchecked: contrast, flashing, luma_jump, frozen_picture$/, "the receipt says what its count leaves out");

  const first = await agent("status", { project: "dim" });
  assert.match(checksLine(first), /^checks 0 err · .* · unchecked: contrast, flashing, luma_jump, frozen_picture$/);

  const checked = await agent("check", { project: "dim" });
  assert.equal(checked.data.errors, 1, checked.text);
  assert.equal(checked.data.byRule.contrast.errors, 1);

  // Nothing changed since check: status counts what check found, with nothing left out.
  const second = await agent("status", { project: "dim" });
  assert.match(checksLine(second), /^checks 1 err · \d+ warn \(contrast dim-words/);
  assert.doesNotMatch(checksLine(second), /not checked/);

  // A second scene that check has not seen: status names it.
  const added = await agent("edit", { project: "dim", ops: [{ op: "add_scene", name: "Two", properties: { duration: 2 } }] });
  assert.equal(added.isError, undefined, added.text);
  const third = await agent("status", { project: "dim" });
  assert.match(checksLine(third), /^checks 1 err · \d+ warn \(contrast dim-words.* · unchecked in two: contrast, flashing, luma_jump, frozen_picture$/);

  // After check on everything, the counts agree again.
  const again = await agent("check", { project: "dim" });
  const fourth = await agent("status", { project: "dim" });
  assert.match(checksLine(fourth), new RegExp(`^checks ${again.data.errors} err · ${again.data.warnings} warn`));
  assert.doesNotMatch(checksLine(fourth), /not checked/);

  // A waived rendered finding: check's waived line and status's waived names are one list for one revision.
  const waived = await agent("edit", { project: "dim", ops: [{ op: "waive_check", code: "contrast", target: "dim-words", reason: "the dim words are a test of the waived list" }] });
  assert.equal(waived.isError, undefined, waived.text);
  assert.match(waived.data.check, / · 1 waived \(contrast dim-words\)/, "the receipt names the waived finding after the waived count");
  const rechecked = await agent("check", { project: "dim" });
  const checkWaived = rechecked.text.split("\n").find((line) => line.startsWith("waived: "));
  assert.equal(checkWaived, "waived: contrast dim-words", rechecked.text);
  assert.match(checksLine(await agent("status", { project: "dim" })), / · 1 waived \(contrast dim-words\)/);
});

test("status counts a check run at another frame rate while the scene is unchanged", async () => {
  await agent("project", { action: "create", id: "dim24", name: "Dim 24", width: 640, height: 360, duration: 3 });
  const made = await agent("edit", { project: "dim24", ops: [
    { op: "update_scene", properties: { background: "#101418" } },
    { op: "add_layer", type: "text", name: "dim-words", properties: { text: "Hard to read", x: 120, y: 140, fontSize: 64, fill: "#1c2026" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const checked = await agent("check", { project: "dim24", fps: 24 });
  assert.equal(checked.data.byRule.contrast.errors, 1, checked.text);
  const status = await agent("status", { project: "dim24" });
  assert.match(checksLine(status), new RegExp(`^checks ${checked.data.errors} err · ${checked.data.warnings} warn`));
  assert.doesNotMatch(checksLine(status), /not checked/);
});
