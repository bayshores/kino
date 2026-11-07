// Who holds which part of a project (the crew screen's "who holds what"). When an agent's edit
// saves, it holds the top-level parts it changed: a layer or group at the top of a scene (a
// child layer counts as its top-level group), "music" for any sound layer, a scene's own
// settings, and "render" while it renders. Another agent's save that touches a held part is
// refused before it saves anything ({waiting, holder}) and the waiting agent is listed.
// A hold lasts until the holder has been quiet for LOCK_QUIET_MS (its turn ended), until it
// releases it (notes {action:"release"}), until the person frees it on the dashboard, or until
// the agent stops. The person's own changes never take or wait for a part.
// Kept in memory only: a restart frees every part.

export const LOCK_QUIET_MS = 2 * 60 * 1000;
export const MUSIC = Object.freeze({ key: "music", label: "music" });
export const RENDER = Object.freeze({ key: "render", label: "render" });
const PARTS_KEPT = 500;

const withoutLayers = (scene) => {
  const { layers: _layers, ...rest } = scene ?? {};
  return JSON.stringify(rest);
};

// The layer at the top of `id`'s group tree, in a scene's layers (by id).
function topLayer(id, byId) {
  let layer = byId.get(id);
  for (let depth = 0; layer?.parentId && byId.has(layer.parentId) && depth < 64; depth += 1) layer = byId.get(layer.parentId);
  return layer ?? null;
}

const isSound = (layer) => layer?.type === "audio";

/**
 * The parts a save changed, from the document before it to the one after:
 * [{key, label}]. key is "music", "scene:<sceneId>" (a scene added, removed or its own
 * settings changed) or "layer:<sceneId>/<top layer id>"; label is what the dashboard shows.
 */
export function changedParts(before, after) {
  const parts = new Map();
  const add = (part) => { if (!parts.has(part.key)) parts.set(part.key, part); };
  const oldScenes = new Map((before?.scenes ?? []).map((scene) => [scene.id, scene]));
  const newScenes = new Map((after?.scenes ?? []).map((scene) => [scene.id, scene]));
  for (const id of new Set([...oldScenes.keys(), ...newScenes.keys()])) {
    const old = oldScenes.get(id);
    const next = newScenes.get(id);
    const sceneName = (next ?? old)?.name || id;
    if (!old || !next || withoutLayers(old) !== withoutLayers(next)) add({ key: `scene:${id}`, label: `scene ${sceneName}` });
    if (!old || !next) continue;
    const oldLayers = new Map((old.layers ?? []).map((layer) => [layer.id, layer]));
    const newLayers = new Map((next.layers ?? []).map((layer) => [layer.id, layer]));
    for (const layerId of new Set([...oldLayers.keys(), ...newLayers.keys()])) {
      const a = oldLayers.get(layerId);
      const b = newLayers.get(layerId);
      if (a && b && JSON.stringify(a) === JSON.stringify(b)) continue;
      const tree = b ? newLayers : oldLayers;
      const top = topLayer(layerId, tree);
      if (isSound(a) || isSound(b) || isSound(top)) add(MUSIC);
      else if (top) add({ key: `layer:${id}/${top.id}`, label: top.name || top.id });
    }
  }
  return [...parts.values()];
}

/**
 * The table of held parts. `now` is the clock (ms). Each entry:
 * { projectId, key, label, holder, since, touchedAt, waiting: Map(agentId → since) }.
 */
export function createLocks({ now = Date.now, quietMs = LOCK_QUIET_MS } = {}) {
  const held = new Map();
  const id = (projectId, key) => `${projectId}\n${key}`;
  // Each holder's last call: a hold lasts while its holder keeps calling.
  const lastCall = new Map();

  function expire() {
    const at = now();
    let changed = false;
    for (const [name, entry] of held) {
      const last = Math.max(entry.touchedAt, lastCall.get(entry.holder) ?? 0);
      if (at - last >= quietMs) { held.delete(name); changed = true; continue; }
      // A waiting agent that went quiet no longer waits.
      for (const [waiter, since] of entry.waiting)
        if (at - Math.max(since, lastCall.get(waiter) ?? 0) >= quietMs) entry.waiting.delete(waiter);
    }
    return changed;
  }

  /**
   * Agent `holder` saves a change to `parts` of `projectId`. Returns {ok: true, taken} when no
   * other agent holds any of them (it now holds them all), or {waiting: [{key, label, holder}]}
   * when one does (it holds nothing new, and is listed as waiting for each).
   */
  function claim(projectId, holder, parts) {
    expire();
    const at = now();
    const blocked = parts.map((part) => held.get(id(projectId, part.key))).filter((entry) => entry && entry.holder !== holder);
    if (blocked.length) {
      for (const entry of blocked) if (!entry.waiting.has(holder)) entry.waiting.set(holder, at);
      return { waiting: blocked.map((entry) => ({ key: entry.key, label: entry.label, holder: entry.holder })) };
    }
    const taken = [];
    for (const part of parts) {
      const name = id(projectId, part.key);
      const entry = held.get(name);
      if (entry) { entry.touchedAt = at; entry.label = part.label; continue; }
      held.set(name, { projectId, key: part.key, label: part.label, holder, since: at, touchedAt: at, waiting: new Map() });
      taken.push(part.key);
    }
    // It no longer waits for anything it now could save.
    for (const entry of held.values()) entry.waiting.delete(holder);
    while (held.size > PARTS_KEPT) held.delete(held.keys().next().value);
    return { ok: true, taken };
  }

  /** The holder made a call: its holds last LOCK_QUIET_MS from now. */
  function touch(holder) {
    lastCall.set(holder, now());
    if (lastCall.size > PARTS_KEPT) lastCall.delete(lastCall.keys().next().value);
  }

  /** Frees what `holder` holds (in `projectId` only, when given). Returns the labels freed. */
  function release(holder, { projectId = null } = {}) {
    const freed = [];
    for (const [name, entry] of held) {
      if (entry.holder !== holder || (projectId && entry.projectId !== projectId)) continue;
      held.delete(name);
      freed.push(entry.label);
    }
    for (const entry of held.values()) entry.waiting.delete(holder);
    lastCall.delete(holder);
    return freed;
  }

  /** The person frees one part. Returns the entry freed, or null. */
  function free(projectId, key) {
    const entry = held.get(id(projectId, key)) ?? null;
    held.delete(id(projectId, key));
    return entry;
  }

  /** Every held part, oldest first: {projectId, key, label, holder, since, until, waiting: [{agentId, since}]}. */
  function list() {
    expire();
    return [...held.values()].map((entry) => ({
      projectId: entry.projectId, key: entry.key, label: entry.label, holder: entry.holder,
      since: new Date(entry.since).toISOString(),
      until: new Date(Math.max(entry.touchedAt, lastCall.get(entry.holder) ?? 0) + quietMs).toISOString(),
      waiting: [...entry.waiting].map(([agentId, since]) => ({ agentId, since: new Date(since).toISOString() })),
    }));
  }

  return { claim, touch, release, free, list, expire };
}
