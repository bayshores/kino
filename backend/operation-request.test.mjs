import assert from "node:assert/strict";
import test from "node:test";
import { createOperationRequest } from "./operation-request.mjs";

test("operation request IDs are optional", () => {
  assert.equal(createOperationRequest({ revision: 1, operations: [] }, "owner"), undefined);
  assert.equal(createOperationRequest({ requestId: undefined, revision: 1, operations: [] }, "owner"), undefined);
});

test("operation fingerprints sort nested object keys and ignore non-payload fields", () => {
  const first = createOperationRequest({ requestId: "edit:7", revision: 4, actor: "mcp", operations: [
    { type: "update_layer", properties: { fill: "#fff", opacity: 0.5 }, layerId: "a" },
  ] }, "owner");
  const reordered = createOperationRequest({ requestId: "edit:7", revision: 4, actor: "other", operations: [
    { layerId: "a", properties: { opacity: 0.5, fill: "#fff" }, type: "update_layer" },
  ] }, "owner");

  assert.deepEqual(reordered, first);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
});

test("operation fingerprints preserve array order and include revision and operations", () => {
  const input = { requestId: "edit-7", revision: 4, operations: [
    { type: "rename_project", name: "One" },
    { type: "add_scene", name: "Two" },
  ] };
  const original = createOperationRequest(input, "owner");
  const swapped = createOperationRequest({ ...input, operations: [...input.operations].reverse() }, "owner");
  const otherRevision = createOperationRequest({ ...input, revision: 5 }, "owner");
  const otherPayload = createOperationRequest({ ...input, operations: [{ type: "rename_project", name: "Changed" }] }, "owner");

  assert.notEqual(swapped.fingerprint, original.fingerprint);
  assert.notEqual(otherRevision.fingerprint, original.fingerprint);
  assert.notEqual(otherPayload.fingerprint, original.fingerprint);
});

test("operation request scopes accept owner or a canonical UUID grant and normalize UUID case", () => {
  const owner = createOperationRequest({ requestId: "request_1", revision: 1, operations: [] }, "owner");
  const grant = createOperationRequest({ requestId: "request_1", revision: 1, operations: [] }, "A0BBC9AB-F5FE-6A3D-A83D-848E7D81704D");

  assert.equal(owner.scope, "owner");
  assert.equal(grant.scope, "a0bbc9ab-f5fe-6a3d-a83d-848e7d81704d");
  assert.equal(owner.fingerprint, grant.fingerprint, "authorization scope is not part of the payload fingerprint");
});

test("invalid request IDs and scopes produce safe 400 errors", () => {
  for (const requestId of ["", "has space", "slash/id", "x".repeat(129), 42]) {
    assert.throws(
      () => createOperationRequest({ requestId, revision: 1, operations: [] }, "owner"),
      (error) => error.status === 400 && error.message === "requestId must be 1 to 128 letters, digits, underscores, periods, colons, or hyphens.",
    );
  }
  assert.throws(
    () => createOperationRequest({ requestId: "valid-id", revision: 1, operations: [] }, "actor:mcp"),
    (error) => error.status === 400 && error.message === "Operation request scope must be owner or a grant UUID.",
  );
});
