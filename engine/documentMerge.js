import { mergeIdOrder } from "./mergeOrder.js";
import { sameDocument } from "./saveConnection.js";

const ABSENT = Symbol("absent");
const ATOMIC_PROPERTIES = new Set(["fill", "stroke", "background", "shadow", "textStyleRanges", "motionPath", "pathBounds", "preset", "bulkVariant",
  // The storyboard is one plan: two saves never mix their shots (engine/board.js).
  "board"]);
const object = (value) => value !== ABSENT && value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => value === ABSENT ? ABSENT : structuredClone(value);
const equal = (left, right) => left === ABSENT || right === ABSENT ? left === right : sameDocument(left, right);
const own = (value, key) => object(value) && Object.hasOwn(value, key) && value[key] !== undefined ? value[key] : ABSENT;

/** Flatten ownership separately from properties so moving an item does not lose another edit. */
function indexDocument(document) {
  const result = { document: {}, scenes: new Map(), layers: new Map(), animations: new Map(), orders: new Map() };
  for (const [key, value] of Object.entries(document)) if (key !== "scenes") result.document[key] = value;
  result.orders.set("scenes", document.scenes.map((scene) => scene.id));
  function addAnimations(animations, owner, path) {
    result.orders.set(owner, animations.map((animation) => animation.id));
    for (const animation of animations) {
      const { animations: children, ...properties } = animation;
      if (result.animations.has(animation.id)) throw new Error("Animation IDs must be unique before merging.");
      result.animations.set(animation.id, { owner, properties, source: animation, path: [...path, animation.id] });
      if (animation.kind === "composed") addAnimations(children, `animation:${animation.id}`, [...path, animation.id, "animations"]);
    }
  }
  for (const scene of document.scenes) {
    const { layers, backgroundAnimations, ...properties } = scene;
    if (result.scenes.has(scene.id)) throw new Error("Scene IDs must be unique before merging.");
    result.scenes.set(scene.id, { properties, source: scene, path: ["scenes", scene.id] });
    result.orders.set(`scene:${scene.id}:layers`, layers.map((layer) => layer.id));
    addAnimations(backgroundAnimations || [], `scene:${scene.id}:background`, ["scenes", scene.id, "backgroundAnimations"]);
    for (const layer of layers) {
      const { animations, ...layerProperties } = layer;
      if (result.layers.has(layer.id)) throw new Error("Layer IDs must be unique before merging.");
      const path = ["scenes", scene.id, "layers", layer.id];
      result.layers.set(layer.id, { owner: scene.id, properties: layerProperties, source: layer, path });
      addAnimations(animations || [], `layer:${layer.id}`, [...path, "animations"]);
    }
  }
  return result;
}

/**
 * Three-way document merge. Ours is the later save and wins a conflicting value;
 * deleting an existing item wins over editing it. Validation stays at the caller's
 * boundary so both HTTP and the editor can use the same conflict fallback.
 */
export function mergeDocuments(base, ours, theirs, { preserveChangedOurs = false } = {}) {
  if (!base || !ours || !theirs || base.id !== ours.id || base.id !== theirs.id)
    throw new Error("A merge requires three versions of the same file.");
  const indexes = [base, ours, theirs].map(indexDocument);
  const [before, local, remote] = indexes;
  const conflicts = [];
  function conflict(path, left, right, resolution = "ours") {
    conflicts.push({ path: [...path], ours: left === ABSENT ? null : copy(left), theirs: right === ABSENT ? null : copy(right),
      ...(left === ABSENT ? { oursDeleted: true } : {}), ...(right === ABSENT ? { theirsDeleted: true } : {}), resolution });
  }
  function value(previous, left, right, path, forceObject = false) {
    if (left === ABSENT || right === ABSENT) {
      if (left === right) return ABSENT;
      if (previous === ABSENT) return copy(left === ABSENT ? right : left);
      // Undo snapshots are older local states. Removing a field in such a snapshot
      // cannot remove a value someone else has changed since that state was saved.
      if (preserveChangedOurs && right === ABSENT && left !== ABSENT && !equal(left, previous)) return copy(left);
      if (!equal(left === ABSENT ? right : left, previous)) conflict(path, left, right, "deleted");
      return ABSENT;
    }
    if (Object.is(left, right)) return copy(left);
    const key = path.at(-1);
    if (object(left) && object(right) && (forceObject || !ATOMIC_PROPERTIES.has(key))) {
      const merged = {};
      for (const field of new Set([...Object.keys(object(previous) ? previous : {}), ...Object.keys(left), ...Object.keys(right)])) {
        const item = value(own(previous, field), own(left, field), own(right, field), [...path, field]);
        if (item !== ABSENT) Object.defineProperty(merged, field, { value: item, enumerable: true, writable: true, configurable: true });
      }
      return merged;
    }
    if (equal(left, right)) return copy(left);
    if (equal(left, previous)) return copy(right);
    if (equal(right, previous)) return copy(left);
    conflict(path, left, right);
    return copy(left);
  }
  function entities(kind) {
    const maps = indexes.map((index) => index[kind]);
    const merged = new Map();
    for (const id of new Set(maps.flatMap((map) => [...map.keys()]))) {
      const [previous, left, right] = maps.map((map) => map.get(id));
      const path = (left || right || previous).path;
      if (!left || !right) {
        if (!previous) { if (left || right) merged.set(id, copy(left || right)); continue; }
        const surviving = left || right;
        if (preserveChangedOurs && left && !right &&
            (!equal(left.source, previous.source) || left.owner !== previous.owner)) {
          merged.set(id, copy(left));
          continue;
        }
        if (surviving && (!equal(surviving.properties, previous.properties) || surviving.owner !== previous.owner))
          conflict(path, left?.properties ?? ABSENT, right?.properties ?? ABSENT, "deleted");
        continue;
      }
      const properties = value(previous?.properties ?? ABSENT, left.properties, right.properties, path, true);
      const owner = kind === "scenes" ? undefined : value(previous?.owner ?? ABSENT, left.owner, right.owner, [...path, kind === "layers" ? "sceneId" : "animationOwner"]);
      merged.set(id, { properties, owner, path });
    }
    return merged;
  }
  const scenes = entities("scenes"), layers = entities("layers"), animations = entities("animations");
  // Two individually valid moves can create a cycle with no remaining root.
  // Check ownership before walking roots so those groups cannot disappear silently.
  const checkedOwners = new Set();
  for (const id of animations.keys()) {
    const chain = new Set();
    let current = id;
    while (animations.has(current) && !checkedOwners.has(current)) {
      if (chain.has(current)) throw new Error("Merged animation groups form a cycle.");
      chain.add(current);
      const owner = animations.get(current).owner;
      if (!owner.startsWith("animation:")) break;
      current = owner.slice("animation:".length);
    }
    for (const visited of chain) checkedOwners.add(visited);
  }
  const layersByScene = new Map(), animationsByOwner = new Map();
  for (const [id, entry] of layers) {
    if (!layersByScene.has(entry.owner)) layersByScene.set(entry.owner, []);
    layersByScene.get(entry.owner).push(id);
  }
  for (const [id, entry] of animations) {
    if (!animationsByOwner.has(entry.owner)) animationsByOwner.set(entry.owner, []);
    animationsByOwner.get(entry.owner).push(id);
  }
  function ordered(owner, present, path) {
    const lists = indexes.map((index) => index.orders.get(owner) || []);
    const result = mergeIdOrder(...lists, present);
    if (result.conflictIds.length) conflicts.push({ path: [...path], ours: [...lists[1]], theirs: [...lists[2]],
      resolution: "ours", kind: "order", ids: result.conflictIds });
    return result.ids;
  }
  const visiting = new Set();
  function animationList(owner, path) {
    return ordered(owner, animationsByOwner.get(owner) || [], path).map((id) => {
      if (visiting.has(id)) throw new Error("Merged animation groups form a cycle.");
      visiting.add(id);
      const animation = animations.get(id).properties;
      if (animation.kind === "composed") animation.animations = animationList(`animation:${id}`, [...path, id, "animations"]);
      visiting.delete(id);
      return animation;
    });
  }
  const document = value(before.document, local.document, remote.document, [], true);
  document.scenes = ordered("scenes", [...scenes.keys()], ["scenes"]).map((id) => {
    const scene = scenes.get(id).properties;
    scene.layers = ordered(`scene:${id}:layers`, layersByScene.get(id) || [], ["scenes", id, "layers"]).map((layerId) => {
      const layer = layers.get(layerId).properties;
      layer.animations = animationList(`layer:${layerId}`, ["scenes", id, "layers", layerId, "animations"]);
      return layer;
    });
    scene.backgroundAnimations = animationList(`scene:${id}:background`, ["scenes", id, "backgroundAnimations"]);
    return scene;
  });
  return { document, conflicts };
}
