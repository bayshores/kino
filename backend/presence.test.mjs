import assert from "node:assert/strict";
import test from "node:test";
import { PRESENCE_COLORS, createPresenceRegistry, pruneSelection, validateCursor, validateSelection } from "./presence.mjs";

function componentDocument() {
  return {
    scenes: [
      { id: "page", layers: [
        { id: "instance", type: "component", componentSceneId: "card" },
        { id: "second-instance", type: "component", componentSceneId: "card" },
        { id: "box", type: "rectangle" },
      ] },
      { id: "card", isComponent: true, layers: [
        { id: "nested-instance", type: "component", componentSceneId: "nested" },
      ] },
      { id: "nested", isComponent: true, layers: [ { id: "label", type: "text" } ] },
      { id: "other", layers: [ { id: "foreign", type: "rectangle" } ] },
    ],
  };
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

test("presence palette has ten distinct colors with readable white labels", () => {
  assert.equal(PRESENCE_COLORS.length, 10);
  assert.equal(new Set(PRESENCE_COLORS).size, 10);
  for (const color of PRESENCE_COLORS) {
    assert.match(color, /^#[0-9A-F]{6}$/i);
    assert.ok(1.05 / (luminance(color) + 0.05) >= 4.5, `${color} contrast is below 4.5:1`);
  }
});

test("selection validation bounds arrays first and rejects malformed, duplicate, foreign, and unknown IDs", () => {
  const document = componentDocument();
  assert.deepEqual(validateSelection(document, { sceneId: "page", layerIds: ["box"] }), { sceneId: "page", layerIds: ["box"] });
  assert.deepEqual(validateSelection(document, { sceneId: null, layerIds: [] }), { sceneId: null, layerIds: [] });
  assert.throws(() => validateSelection(document, { sceneId: null, layerIds: ["box"] }), /cleared selection/);
  assert.throws(() => validateSelection(document, { sceneId: null, layerIds: [], componentPath: "label" }), /cleared selection/);
  assert.throws(() => validateSelection(document, { sceneId: "missing", layerIds: [] }), /not in this file/);
  assert.throws(() => validateSelection(document, { sceneId: "page", layerIds: ["bad/id"] }), /malformed ID/);
  assert.throws(() => validateSelection(document, { sceneId: "page", layerIds: ["box", "box"] }), /duplicate ID/);
  assert.throws(() => validateSelection(document, { sceneId: "page", layerIds: ["foreign"] }), /unknown or foreign/);
  assert.throws(() => validateSelection(document, { sceneId: "page", layerIds: [], extra: true }), /unknown field/);

  const oversized = new Proxy(Array.from({ length: 201 }, () => "unknown"), {
    get(target, property, receiver) {
      if (property !== "length" && property !== Symbol.iterator) throw new Error("IDs were scanned before the size check");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateSelection(document, { sceneId: "missing", layerIds: oversized }), /more than 200/);
});

test("inherited selections require exactly one component instance and a resolvable nested path", () => {
  const document = componentDocument();
  assert.deepEqual(validateSelection(document, {
    sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/label",
  }), { sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/label" });
  for (const selection of [
    { sceneId: "page", layerIds: ["box"], componentPath: "nested-instance/label" },
    { sceneId: "page", layerIds: ["instance", "second-instance"], componentPath: "nested-instance/label" },
    { sceneId: "page", layerIds: ["instance"], componentPath: "gone" },
    { sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/label/extra" },
  ]) assert.throws(() => validateSelection(document, selection), /componentPath/);
});

test("cursor validation requires a known scene and finite bounded coordinates", () => {
  const document = componentDocument();
  assert.deepEqual(validateCursor(document, { sceneId: "page", x: -1_000_000, y: 1_000_000 }), {
    sceneId: "page", x: -1_000_000, y: 1_000_000,
  });
  for (const cursor of [
    { sceneId: "missing", x: 0, y: 0 },
    { sceneId: "page", x: Infinity, y: 0 },
    { sceneId: "page", x: 0, y: NaN },
    { sceneId: "page", x: 1_000_001, y: 0 },
    { sceneId: "page", x: 0, y: 0, layerId: "box" },
  ]) assert.throws(() => validateCursor(document, cursor), /Invalid presence message/);
});

test("pruning retains live scene/layers, deduplicates, and clears invalid inherited targets", () => {
  const document = componentDocument();
  assert.deepEqual(pruneSelection(document, { sceneId: "page", layerIds: ["box", "gone", "box"] }), {
    sceneId: "page", layerIds: ["box"],
  });
  assert.deepEqual(pruneSelection(document, {
    sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/label",
  }), { sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/label" });
  assert.deepEqual(pruneSelection(document, {
    sceneId: "page", layerIds: ["instance"], componentPath: "nested-instance/gone",
  }), { sceneId: "page", layerIds: [] });
  assert.deepEqual(pruneSelection(document, {
    sceneId: "page", layerIds: ["instance"], componentPath: "",
  }), { sceneId: "page", layerIds: [] });
  assert.deepEqual(pruneSelection(document, { sceneId: "deleted", layerIds: ["box"] }), { sceneId: null, layerIds: [] });
  assert.deepEqual(pruneSelection(document, { sceneId: null, layerIds: ["box"] }), { sceneId: null, layerIds: [] });
});

test("registry preserves same-project identity, assigns project-local colors, and exposes only public people fields", () => {
  let timestamp = 100, sequence = 0;
  const registry = createPresenceRegistry({ now: () => timestamp, makeId: () => `session-${++sequence}` });
  const sockets = Array.from({ length: 15 }, () => ({}));
  const clients = sockets.map((socket, index) => registry.join(socket, {
    projectId: "project-a", name: `  Person ${index}  `, grantId: `grant-${index}`,
  }));
  assert.deepEqual(clients.slice(0, 10).map((client) => client.color), PRESENCE_COLORS);
  assert.equal(clients[10].color, PRESENCE_COLORS[0]);
  assert.equal(clients[11].color, PRESENCE_COLORS[1]);
  assert.equal(clients[14].color, PRESENCE_COLORS[4]);
  assert.equal(new Set(clients.map((client) => client.id)).size, 15);

  const first = clients[0];
  first.sceneId = "page";
  first.selection = { sceneId: "page", layerIds: ["box"] };
  const renamed = registry.join(sockets[0], { projectId: "project-a", name: "  Renamed  ", grantId: "grant-new" });
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.color, first.color);
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.grantId, "grant-new");
  assert.equal(renamed.sceneId, "page");
  assert.deepEqual(renamed.selection, { sceneId: "page", layerIds: ["box"] });
  const publicPerson = registry.people("project-a").find((person) => person.id === first.id);
  assert.deepEqual(Object.keys(publicPerson).sort(), ["color", "id", "name", "sceneId"]);

  const other = registry.join({}, { projectId: "project-b", name: "   " });
  assert.equal(other.color, PRESENCE_COLORS[0]);
  assert.equal(other.name, "Guest");
});

test("name length is bounded and moving a socket to another project creates a new identity", () => {
  let sequence = 0;
  const registry = createPresenceRegistry({ makeId: () => `id-${++sequence}` });
  const socket = {};
  const original = registry.join(socket, { projectId: "one", name: ` ${"N".repeat(120)} ` });
  assert.equal(original.name.length, MAX_NAME_LENGTH);
  const changed = registry.join(socket, { projectId: "two", name: "\n\t" });
  assert.notEqual(changed.id, original.id);
  assert.equal(changed.name, "Guest");
  assert.deepEqual(registry.people("one"), []);
  assert.equal(registry.people("two")[0].id, changed.id);
});

test("revoking a grant synchronously removes all its sessions and leaves unrelated sessions intact", () => {
  let sequence = 0;
  const registry = createPresenceRegistry({ makeId: () => `id-${++sequence}` });
  const firstSocket = {}, secondSocket = {}, otherGrantSocket = {}, ownerSocket = {};
  const first = registry.join(firstSocket, { projectId: "project", name: "First", grantId: "grant-a" });
  const second = registry.join(secondSocket, { projectId: "project", name: "Second", grantId: "grant-a" });
  const otherGrant = registry.join(otherGrantSocket, { projectId: "project", name: "Other", grantId: "grant-b" });
  const owner = registry.join(ownerSocket, { projectId: "project", name: "Owner" });

  assert.deepEqual(registry.revoke("grant-a"), [
    { socket: firstSocket, client: first },
    { socket: secondSocket, client: second },
  ]);
  assert.equal(registry.clients.has(firstSocket), false);
  assert.equal(registry.clients.has(secondSocket), false);
  assert.equal(registry.clients.get(otherGrantSocket), otherGrant);
  assert.equal(registry.clients.get(ownerSocket), owner);
  assert.deepEqual(registry.people("project").map(({ id }) => id), [otherGrant.id, owner.id]);
});

test("a captured pre-revoke authorization cannot register later or revive on same-socket rejoin", async () => {
  let sequence = 0;
  const registry = createPresenceRegistry({ makeId: () => `id-${++sequence}` });
  const socket = {};
  registry.join(socket, { projectId: "project", name: "Guest", grantId: "grant-old" });
  registry.revoke("grant-old");
  assert.equal(registry.clients.has(socket), false);
  assert.throws(() => registry.join(socket, { projectId: "project", name: "Renamed", grantId: "grant-old" }),
    (error) => error.status === 403);
  assert.equal(registry.clients.has(socket), false);

  let finishAuthorization;
  const lateSocket = {};
  const deferredRegistration = new Promise((resolve) => { finishAuthorization = resolve; })
    .then(() => registry.join(lateSocket, { projectId: "project", name: "Late", grantId: "grant-captured" }));
  registry.revoke("grant-captured");
  finishAuthorization({ grantId: "grant-captured" });
  await assert.rejects(deferredRegistration, (error) => error.status === 403);
  assert.equal(registry.clients.has(lateSocket), false);
  assert.equal(registry.people("project").length, 0);
});

const MAX_NAME_LENGTH = 100;

test("allow enforces ten events per rolling second and keeps kinds independent", () => {
  let timestamp = 10;
  const registry = createPresenceRegistry({ now: () => timestamp, makeId: () => "session" });
  const socket = {};
  registry.join(socket, { projectId: "project", name: "Guest" });
  for (let index = 0; index < 10; index += 1) assert.equal(registry.allow(socket, "cursor"), true);
  timestamp = 11;
  assert.equal(registry.allow(socket, "cursor"), false);
  assert.equal(registry.allow(socket, "selection"), true);
  timestamp = 1009; // The oldest cursor event is still inside the rolling window.
  assert.equal(registry.allow(socket, "cursor"), false);
  timestamp = 1010; // Exactly 1000 ms later, the oldest event expires.
  assert.equal(registry.allow(socket, "cursor"), true);
  assert.equal(registry.allow({}, "cursor"), false);
});

test("touch updates liveness; expire removes silent clients and returns their socket/client pair", () => {
  let timestamp = 0;
  const registry = createPresenceRegistry({ now: () => timestamp, timeout: 45_000, makeId: () => "session" });
  const socket = {};
  const client = registry.join(socket, { projectId: "project", name: "Guest" });
  timestamp = 30_000;
  assert.equal(registry.allow(socket, "cursor"), true);
  assert.equal(client.lastSeen, 0, "rate acceptance does not refresh heartbeat");
  assert.equal(registry.touch(socket), true);
  assert.equal(client.lastSeen, 30_000);
  timestamp = 74_999;
  assert.deepEqual(registry.expire(), []);
  timestamp = 75_000;
  assert.deepEqual(registry.expire(), [{ socket, client }]);
  assert.equal(registry.people("project").length, 0);
  assert.equal(registry.touch(socket), false);
  assert.equal(registry.allow(socket, "cursor"), false);
});
