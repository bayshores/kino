import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

async function expectStatus(response, status, label) {
  const text = await response.text();
  assert.equal(response.status, status, `${label}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function sampleEffect() {
  return {
    name: "Rise",
    animation: {
      kind: "custom",
      duration: 1,
      easing: "linear",
      from: { x: 10 },
      to: { x: 30 },
    },
    rest: { x: 5 },
  };
}

test("text-effect API is owner-only and persists portable CRUD records", async (t) => {
  const server = await startTestServer({ ownerToken: "kino-text-effects-test-owner" });
  t.after(() => server.stop());

  assert.deepEqual((await expectStatus(await server.api("/api/text-effects"), 200, "owner lists library")).textEffects, []);
  await expectStatus(await server.api("/api/text-effects", { owner: false }), 403, "anonymous list is denied");
  const saved = await expectStatus(await server.api("/api/text-effects", {
    method: "POST", body: sampleEffect(),
  }), 201, "owner saves a portable copy");
  assert.equal(saved.textEffect.name, "Rise");
  assert.equal(saved.textEffect.rest.x, 5);
  assert.deepEqual(saved.textEffect.animation.from, { x: 10 });
  const listed = await expectStatus(await server.api("/api/text-effects"), 200, "owner reads saved copy");
  assert.deepEqual(listed.textEffects, [saved.textEffect]);

  const bad = await expectStatus(await server.api("/api/text-effects", {
    method: "POST", body: { ...sampleEffect(), animation: { ...sampleEffect().animation, projectId: "private-project" } },
  }), 400, "project references are refused");
  assert.match(bad.error, /cannot contain projectId/i);
  await expectStatus(await server.api("/api/text-effects", {
    method: "POST", body: { ...sampleEffect(), sourceText: "private source" },
  }), 400, "unapproved input fields are refused");

  const document = createDocument({ id: "text-effect-share-project", name: "Share project" });
  await expectStatus(await server.api("/api/projects", {
    method: "POST", body: { document },
  }), 201, "owner creates a file for capability checks");
  const share = await expectStatus(await server.api(`/api/projects/${document.id}/shares`, {
    method: "POST", body: { role: "view", label: "Viewer" },
  }), 201, "owner creates view capability");
  for (const [endpoint, options, action] of [
    ["/api/text-effects", { owner: false, share: share.token }, "list"],
    ["/api/text-effects", { owner: false, share: share.token, method: "POST", body: sampleEffect() }, "save"],
    [`/api/text-effects/${saved.textEffect.id}`, { owner: false, share: share.token, method: "PATCH", body: { name: "No" } }, "rename"],
    [`/api/text-effects/${saved.textEffect.id}`, { owner: false, share: share.token, method: "DELETE" }, "delete"],
  ]) {
    await expectStatus(await server.api(endpoint, options), 403, `view capability cannot ${action}`);
  }

  const renamed = await expectStatus(await server.api(`/api/text-effects/${saved.textEffect.id}`, {
    method: "PATCH", body: { name: "Reusable rise" },
  }), 200, "owner renames copy");
  assert.equal(renamed.textEffect.name, "Reusable rise");
  assert.deepEqual(await expectStatus(await server.api(`/api/text-effects/${saved.textEffect.id}`, {
    method: "DELETE",
  }), 200, "owner deletes copy"), { deleted: saved.textEffect.id });
  assert.deepEqual((await expectStatus(await server.api("/api/text-effects"), 200, "owner lists after delete")).textEffects, []);
});
