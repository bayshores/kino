import assert from "node:assert/strict";
import test from "node:test";
import { createTemplateDocument } from "../engine/templates.js";
import { startTestServer } from "./media.test.support.mjs";

async function responseJson(response, expected = 200) {
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

test("a template becomes one persistent editable project only after an explicit create request", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;

  const before = await responseJson(await api("/api/projects"));
  assert.deepEqual(before.projects, [], "the project store contains no seeded template projects");

  const document = createTemplateDocument("kinetic-title");
  const created = await responseJson(await api("/api/projects", {
    method: "POST",
    body: { document, folderId: null },
  }), 201);
  assert.equal(created.document.id, document.id);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.comments, []);
  assert.equal((await responseJson(await api("/api/projects"))).projects.length, 1);

  const stored = await responseJson(await api(`/api/projects/${encodeURIComponent(document.id)}`));
  assert.deepEqual(stored.document, created.document, "the server returns the saved template document");
  const edited = structuredClone(stored.document);
  const textLayer = edited.scenes[0].layers.find((layer) => layer.type === "text");
  textLayer.text = "AN EDITABLE TITLE";
  const saved = await responseJson(await api(`/api/projects/${encodeURIComponent(document.id)}`, {
    method: "PUT",
    body: { document: edited, revision: stored.revision },
  }));
  assert.equal(saved.revision, 2);
  assert.equal(saved.document.scenes[0].layers.find((layer) => layer.id === textLayer.id).text, "AN EDITABLE TITLE");

  const reopened = await responseJson(await api(`/api/projects/${encodeURIComponent(document.id)}`));
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.document.scenes[0].layers.find((layer) => layer.id === textLayer.id).text, "AN EDITABLE TITLE");
  assert.equal((await responseJson(await api("/api/projects"))).projects.length, 1,
    "editing does not create hidden copies or gallery records");
});
