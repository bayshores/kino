// Lists the scene, layer and animation IDs that one saved edit created, changed or removed,
// so an agent can see what its operations did without reading the whole document again.
import { animationTreeEntries } from "./animationTree.js";

// Each list is cut at this many IDs; `more` counts the rest.
export const CHANGE_LIST_LIMIT = 200;

function without(value, keys) {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return JSON.stringify(copy);
}

// One entry per object, keyed so that equal IDs in different scenes stay apart. The stored
// value leaves out the children that are listed on their own (a scene's layers, a layer's
// animations, a group's member animations).
function objects(document) {
  const found = new Map();
  for (const scene of document?.scenes ?? []) {
    found.set(`scene:${scene.id}`, { id: scene.id, value: without(scene, ["layers", "backgroundAnimations"]) });
    const animationLists = [scene.backgroundAnimations];
    for (const layer of scene.layers ?? []) {
      found.set(`layer:${scene.id}/${layer.id}`, { id: layer.id, value: without(layer, ["animations"]) });
      animationLists.push(layer.animations);
    }
    for (const list of animationLists)
      for (const { stored } of animationTreeEntries(list ?? []))
        if (stored && typeof stored === "object")
          found.set(`animation:${scene.id}/${stored.id}`, { id: stored.id, value: without(stored, ["animations"]) });
  }
  return found;
}

function capped(ids) {
  const unique = [...new Set(ids)];
  return unique.length > CHANGE_LIST_LIMIT
    ? { ids: unique.slice(0, CHANGE_LIST_LIMIT), more: unique.length - CHANGE_LIST_LIMIT }
    : { ids: unique, more: 0 };
}

export function documentChanges(before, after) {
  const old = objects(before);
  const next = objects(after);
  const created = [];
  const changed = [];
  const removed = [];
  for (const [key, entry] of next) {
    const previous = old.get(key);
    if (!previous) created.push(entry.id);
    else if (previous.value !== entry.value) changed.push(entry.id);
  }
  for (const [key, entry] of old) if (!next.has(key)) removed.push(entry.id);
  const result = {};
  for (const [name, ids] of Object.entries({ created, changed, removed })) {
    const list = capped(ids);
    result[name] = list.ids;
    if (list.more) result[`${name}More`] = list.more;
  }
  if (before?.name !== after?.name) result.project = ["name"];
  return result;
}
