import { randomUUID } from "node:crypto";
import { MAX_COMMENT_AUTHOR } from "./comments.mjs";
import { resolveComponentPath } from "../engine/componentOverrides.js";

// Dark enough for white initials; no purple (the dashboard's look).
export const PRESENCE_COLORS = Object.freeze([
  "#0E7490", "#1D4ED8", "#0F766E", "#15803D", "#B45309",
  "#C2410C", "#BE123C", "#4D7C0F", "#475569", "#854D0E",
]);

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_SELECTION_LAYERS = 200;
const MAX_CURSOR_COORDINATE = 1_000_000;
const RATE_WINDOW_MS = 1000;
const RATE_WINDOW_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 45_000;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  return new TypeError(`Invalid presence message: ${message}`);
}

function sceneMap(document) {
  if (!document || !Array.isArray(document.scenes)) return new Map();
  return new Map(document.scenes.map((scene) => [scene?.id, scene]));
}

function noUnknownKeys(message, allowed) {
  if (Object.keys(message).some((key) => !allowed.has(key))) throw invalid("contains an unknown field");
}

function optionalPath(message) {
  const path = message.componentPath;
  if (path === undefined || path === null) return null;
  if (typeof path !== "string" || !path.length) throw invalid("componentPath must be a non-empty component path");
  return path;
}

function componentTargetIsValid(document, scene, layerIds, componentPath) {
  if (componentPath === undefined || componentPath === null) return true;
  if (typeof componentPath !== "string" || !componentPath.length) return false;
  if (layerIds.length !== 1) return false;
  const instance = scene.layers.find((layer) => layer.id === layerIds[0]);
  if (instance?.type !== "component") return false;
  return Boolean(resolveComponentPath(instance, sceneMap(document), componentPath));
}

/** Validate and canonicalize the scene/layer selection sent by one collaborator. */
export function validateSelection(document, message) {
  if (!isRecord(message)) throw invalid("must be an object");
  noUnknownKeys(message, new Set(["sceneId", "layerIds", "componentPath"]));
  const { sceneId, layerIds } = message;
  if (!Array.isArray(layerIds)) throw invalid("layerIds must be an array");
  // Bound this before scanning IDs, building indexes, or resolving a component path.
  if (layerIds.length > MAX_SELECTION_LAYERS) throw invalid(`layerIds cannot contain more than ${MAX_SELECTION_LAYERS} IDs`);
  const componentPath = optionalPath(message);
  if (sceneId === null) {
    if (layerIds.length !== 0 || componentPath) throw invalid("a cleared selection must have a null scene and no layers or path");
    return { sceneId: null, layerIds: [] };
  }
  if (typeof sceneId !== "string" || !ID_PATTERN.test(sceneId)) throw invalid("sceneId is malformed");
  const scene = sceneMap(document).get(sceneId);
  if (!scene) throw invalid("sceneId is not in this file");

  const seen = new Set();
  for (const id of layerIds) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw invalid("layerIds contains a malformed ID");
    if (seen.has(id)) throw invalid("layerIds contains a duplicate ID");
    seen.add(id);
  }
  const knownLayers = new Set((scene.layers ?? []).map((layer) => layer.id));
  if (layerIds.some((id) => !knownLayers.has(id))) throw invalid("layerIds contains an unknown or foreign layer ID");
  if (componentPath && !componentTargetIsValid(document, scene, layerIds, componentPath))
    throw invalid("componentPath must resolve from the one selected component instance");
  return { sceneId, layerIds: [...layerIds], ...(componentPath ? { componentPath } : {}) };
}

/** Validate and canonicalize an artboard-relative cursor position. */
export function validateCursor(document, message) {
  if (!isRecord(message)) throw invalid("must be an object");
  noUnknownKeys(message, new Set(["sceneId", "x", "y"]));
  const { sceneId, x, y } = message;
  if (typeof sceneId !== "string" || !ID_PATTERN.test(sceneId) || !sceneMap(document).has(sceneId))
    throw invalid("sceneId is malformed or not in this file");
  for (const [name, value] of [["x", x], ["y", y]])
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_CURSOR_COORDINATE)
      throw invalid(`${name} must be finite and within ±${MAX_CURSOR_COORDINATE}`);
  return { sceneId, x, y };
}

/** Keep only still-valid targets after the document changes. Invalid inherited paths clear their instance selection. */
export function pruneSelection(document, selection) {
  if (!isRecord(selection) || !Array.isArray(selection.layerIds) || selection.layerIds.length > MAX_SELECTION_LAYERS)
    return { sceneId: null, layerIds: [] };
  if (selection.sceneId === null) return { sceneId: null, layerIds: [] };
  const scene = sceneMap(document).get(selection.sceneId);
  if (!scene) return { sceneId: null, layerIds: [] };
  const layers = new Map((scene.layers ?? []).map((layer) => [layer.id, layer]));
  const layerIds = [...new Set(selection.layerIds.filter((id) => typeof id === "string" && ID_PATTERN.test(id) && layers.has(id)))];
  const hasPath = selection.componentPath !== undefined && selection.componentPath !== null;
  const componentPath = hasPath ? selection.componentPath : null;
  if (hasPath && !componentTargetIsValid(document, scene, layerIds, componentPath)) return { sceneId: scene.id, layerIds: [] };
  return { sceneId: scene.id, layerIds, ...(hasPath ? { componentPath } : {}) };
}

function displayName(value) {
  if (typeof value !== "string") return "Guest";
  let name = value.trim().slice(0, MAX_COMMENT_AUTHOR);
  // Do not leave an unpaired high surrogate when a long name is shortened.
  if (name.length && /[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  return name && !CONTROL_CHARACTERS.test(name) ? name : "Guest";
}

function colorFor(projectId, clients) {
  const counts = new Map(PRESENCE_COLORS.map((color) => [color, 0]));
  for (const client of clients.values())
    if (client.projectId === projectId) counts.set(client.color, (counts.get(client.color) ?? 0) + 1);
  return PRESENCE_COLORS.find((color) => counts.get(color) === 0) ??
    PRESENCE_COLORS.reduce((leastUsed, color) => counts.get(color) < counts.get(leastUsed) ? color : leastUsed, PRESENCE_COLORS[0]);
}

/** In-memory identity, rate and expiry state for currently connected sockets. */
export function createPresenceRegistry({ clients = new Map(), now = Date.now, makeId = randomUUID, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  if (!(clients instanceof Map)) throw new TypeError("Presence clients must be a Map.");
  if (typeof now !== "function" || typeof makeId !== "function") throw new TypeError("Presence clock and ID factory must be functions.");
  if (!Number.isFinite(timeout) || timeout < 1) throw new RangeError("Presence timeout must be a positive number of milliseconds.");
  const rates = new Map();
  const revokedGrantIds = new Set();

  function leave(socket) {
    const client = clients.get(socket) ?? null;
    clients.delete(socket);
    rates.delete(socket);
    return client;
  }

  function join(socket, { projectId, name, grantId = null } = {}) {
    if (socket === undefined || socket === null) throw new TypeError("A presence socket is required.");
    if (typeof projectId !== "string" || !projectId.trim()) throw new TypeError("A presence project ID is required.");
    if (grantId !== null && grantId !== undefined && typeof grantId !== "string") throw new TypeError("A presence grant ID must be a string.");
    if (grantId && revokedGrantIds.has(grantId)) {
      const error = new Error("This sharing grant is no longer available.");
      error.status = 403;
      throw error;
    }
    const previous = clients.get(socket);
    if (previous?.projectId === projectId) {
      previous.name = displayName(name);
      previous.grantId = grantId;
      previous.lastSeen = now();
      return previous;
    }
    if (previous) leave(socket);
    const usedIds = new Set([...clients.values()].map((client) => client.id));
    let id = makeId();
    while (usedIds.has(id)) id = makeId();
    const client = {
      id,
      name: displayName(name),
      color: colorFor(projectId, clients),
      projectId,
      grantId,
      sceneId: null,
      selection: null,
      lastSeen: now(),
    };
    clients.set(socket, client);
    return client;
  }

  function revoke(grantId) {
    if (typeof grantId !== "string" || !grantId.length) throw new TypeError("A presence grant ID is required.");
    revokedGrantIds.add(grantId);
    const removed = [];
    for (const [socket, client] of clients) {
      if (client.grantId !== grantId) continue;
      clients.delete(socket);
      rates.delete(socket);
      removed.push({ socket, client });
    }
    return removed;
  }

  function touch(socket) {
    const client = clients.get(socket);
    if (!client) return false;
    client.lastSeen = now();
    return true;
  }

  function allow(socket, kind) {
    if (!clients.has(socket) || typeof kind !== "string" || !kind) return false;
    const timestamp = now();
    if (!Number.isFinite(timestamp)) return false;
    let byKind = rates.get(socket);
    if (!byKind) { byKind = new Map(); rates.set(socket, byKind); }
    const recent = (byKind.get(kind) ?? []).filter((at) => timestamp - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_WINDOW_LIMIT) {
      byKind.set(kind, recent);
      return false;
    }
    recent.push(timestamp);
    byKind.set(kind, recent);
    return true;
  }

  function expire() {
    const timestamp = now();
    if (!Number.isFinite(timestamp)) return [];
    const expired = [];
    for (const [socket, client] of clients) {
      if (timestamp - client.lastSeen < timeout) continue;
      clients.delete(socket);
      rates.delete(socket);
      expired.push({ socket, client });
    }
    return expired;
  }

  function people(projectId) {
    return [...clients.values()].filter((client) => client.projectId === projectId)
      .map(({ id, name, color, sceneId }) => ({ id, name, color, sceneId }));
  }

  return { clients, join, leave, touch, allow, expire, people, revoke };
}
