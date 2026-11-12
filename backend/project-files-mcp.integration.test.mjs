// Project copies, Trash, restore and confirmed permanent deletion through the agent's project tool.
import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer } from "./media.test.support.mjs";

async function expectStatus(response, status, reason) {
  const text = await response.text();
  assert.equal(response.status, status, `${reason}: ${text}`);
  return text ? JSON.parse(text) : null;
}

test("the project tool copies projects, moves them to Trash, restores them, and deletes forever only when confirmed", async (t) => {
  const server = await startTestServer({ allow: ["delete-project"] });
  t.after(server.stop);
  const agent = async (body, error = false) => {
    const reply = await expectStatus(await server.api("/api/agent/project", { method: "POST", body }), 200, `project ${body.action}`);
    assert.equal(Boolean(reply.isError), error, reply.text);
    return reply;
  };
  const trash = (action, fields = {}, error = false) =>
    agent({ action: "manage", options: { resource: "trash", action, ...fields } }, error);

  const folder = await expectStatus(
    await server.api("/api/folders", { method: "POST", body: { name: "Campaign" } }),
    201,
    "owner creates a folder",
  );
  const document = createDocument({
    id: "mcp-files-original",
    name: "Launch motion",
    scenes: [createScene({
      id: "scene-one",
      name: "Scene one",
      layers: [createLayer("rectangle", {
        id: "card", name: "Card", x: 12, y: 18, width: 80, height: 40, fill: "#336699", cornerRadii: [1, 2, 3, 4],
      })],
    })],
  });
  await expectStatus(
    await server.api("/api/projects", { method: "POST", body: { document, folderId: folder.id } }),
    201,
    "owner creates the source project",
  );
  await expectStatus(
    await server.api("/api/projects/mcp-files-original/comments", {
      method: "POST",
      body: { text: "Only on the original", sceneId: "scene-one", x: 12, y: 18 },
    }),
    201,
    "owner adds a project comment",
  );
  await expectStatus(
    await server.api("/api/projects/mcp-files-original/shares", { method: "POST", body: { role: "view", label: "Original only" } }),
    201,
    "owner creates a sharing link",
  );

  const copyId = (await agent({ action: "duplicate", id: "mcp-files-original" })).data.project;
  assert.notEqual(copyId, "mcp-files-original");
  const original = await expectStatus(await server.api("/api/projects/mcp-files-original"), 200, "read original");
  const copy = await expectStatus(await server.api(`/api/projects/${copyId}`), 200, "read copy");
  assert.equal(copy.document.name, "Launch motion [copy]");
  assert.equal(copy.revision, 1);
  assert.equal(copy.folderId, folder.id);
  // duplicate with a name: the copy takes it instead of "<old> [copy]".
  const named = (await agent({ action: "duplicate", id: "mcp-files-original", name: "Launch motion v2" })).data.project;
  assert.equal((await expectStatus(await server.api(`/api/projects/${named}`), 200, "read named copy")).document.name, "Launch motion v2");
  await agent({ action: "archive", id: named });
  const expectedDocument = structuredClone(original.document);
  expectedDocument.id = copyId;
  expectedDocument.name = "Launch motion [copy]";
  assert.deepEqual(copy.document, expectedDocument, "the full nested document is copied independently");
  assert.deepEqual((await expectStatus(await server.api(`/api/projects/${copyId}/comments`), 200, "read copied comments")).comments, []);
  assert.deepEqual((await expectStatus(await server.api(`/api/projects/${copyId}/shares`), 200, "read copied shares")).shares, []);

  const editedCopy = structuredClone(copy.document);
  editedCopy.scenes[0].layers[0].cornerRadii[0] = 40;
  await expectStatus(
    await server.api(`/api/projects/${copyId}`, { method: "PUT", body: { document: editedCopy, revision: copy.revision } }),
    200,
    "edit the duplicate's nested array",
  );
  const stillOriginal = await expectStatus(await server.api("/api/projects/mcp-files-original"), 200, "confirm original remains independent");
  assert.deepEqual(stillOriginal.document.scenes[0].layers[0].cornerRadii, [1, 2, 3, 4]);

  await agent({ action: "archive", id: copyId });
  assert.ok((await trash("list")).data.projects.some((entry) => entry.id === copyId), "the trashed copy appears in Trash");

  for (const fields of [{ id: copyId }, { id: copyId, confirm: false }]) {
    await trash("delete", fields, true);
    await expectStatus(await server.api(`/api/projects/${copyId}`), 200, "refusal leaves the trashed project stored");
  }

  await trash("delete", { id: named, confirm: true });
  await trash("restore", { id: copyId });
  assert.equal((await expectStatus(await server.api(`/api/projects/${copyId}`), 200, "read restored copy")).folderId, folder.id,
    "restore puts the project back in its previous folder");

  await agent({ action: "archive", id: copyId });
  await trash("delete", { id: copyId, confirm: true });
  await expectStatus(await server.api(`/api/projects/${copyId}`), 404, "confirmed permanent deletion removes the project");
});
