import { layerFontReferences } from "./textFontReferences.js";
import { layerFallbackFontReferences } from "./fontGlyphReferences.js";
import { defaultFonts } from "./fonts.js";
import { textStyleSegments } from "./textStyleRanges.js";
// Copy and paste for layers and animations (copy_layers, copy_animations, duplicate).
//
// Copying writes one "envelope": a small, versioned JSON object holding everything the copied
// layers need to be pasted somewhere else: another scene or another file.
//
// A layer envelope (copyLayers) holds:
//   - layers: the selected layers and every layer inside them, exactly as the scene stores
//     them, in stacking order (back to front). A mask that masks the next layer is drawn
//     together with that layer, so copying either one copies both;
//   - roots: each selected top layer, with its place measured in the scene ("world") when it
//     sits inside a group that was not copied, so a paste outside that group lands in the same
//     place on the canvas, and what that group does to it beyond placing it ("groupEffect",
//     for example "is animated"), so the paste can say the copy doesn't get that;
//   - masks: which copied mask masks which copied layer;
//   - components: the main component scenes that copied instances draw (and the ones those draw);
//   - media and fonts: the uploaded files and fonts the layers use, so a paste can say which
//     of them this workspace doesn't have.
// An animation envelope (copyAnimation, copyAnimations) holds the selected animations and the
// resting values of the layer each was copied from ("rests", one per animation, in the same
// order; "rest" is the first one, which is all an older copy of one animation has); see
// pasteAnimations.
//
// Pasting layers (pasteLayers), step by step:
// 0. A copy made by an older kino is brought up to date first (documentMigration.js): a
//    clipboard version 1 copy holds document version 1 layers, whose letter spacing is pixels.
// 1. Never trust the clipboard: the copied layers and component scenes are checked by the
//    document validators in model.js before anything else happens.
// 2. Each copied top layer goes back into its group when the target scene still has that group
//    (paste in place). Otherwise it goes to the top level of the scene, at the same place on the
//    canvas.
// 3. Every pasted layer and animation gets a new ID. Groups keep their children.
// 4. An instance stays linked to a main component this file already has (same scene ID).
//    Otherwise that main component scene is added to the file, once.
// 5. The pasted layers go directly above the originals when those are in the target scene,
//    and on top of the scene otherwise.
// 6. The whole resulting document is validated again, so a paste can never save a broken file.
// 7. Masks: the paste is refused when a mask that was already in the scene would start or stop
//    masking a layer, when a mask group would get a different mask, or when a copied mask
//    wouldn't mask the copy of the layer it masked (the scene can't be drawn with a mask that
//    masks nothing).
import { DOCUMENT_VERSION } from "./schema.js";
import { parseDocument, uid } from "./model.js";
import { animationTreeEntries, flattenAnimations, freshAnimationIds, mapAnimationTree } from "./animationTree.js";
import { selectedAnimationEntries } from "./animationSelection.js";
import { migrateLayers, migrateScene } from "./documentMigration.js";
import { LETTER_SPACING_LIMIT } from "./letterSpacing.js";
import { LINE_HEIGHT_MAX, LINE_HEIGHT_MIN } from "./lineHeight.js";
import { componentGeometry, parentMatrix } from "./geometry.js";
import { reparentLayer } from "./reparent.js";
import { checkMasks, groupEffect, groupMasks, maskTargets } from "./grouping.js";
import { FILL_LAYER_TYPES } from "./paints.js";
import { resizeProblem } from "./resizeAnchor.js";
import { visibilityTimeProblem } from "./visibilityOps.js";
import { isTextChange, textChangeTimeProblem } from "./textChange.js";
import { counterLayerProblem } from "./counter.js";
import { isMoveAnimation, mapMotionPath, motionEndpoints } from "./motionPath.js";
import { applyComponentOverride, overrideReferences, remapComponentOverrides, resolveComponentPath } from "./componentOverrides.js";
import { animationOwners } from "./sceneBackground.js";
import { nextScenePosition } from "./sceneLayout.js";
import { isRecord } from "./numbers.js";
import { scriptImageSources } from "./scriptLayer.js";

// A clipboard envelope follows the document version it carries, including scene-only changes.
export const CLIPBOARD_VERSION = 6;
const CLIPBOARD_DOCUMENTS = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, DOCUMENT_VERSION]]);
const FORMAT = "kino.clipboard";
const MAX_LAYERS = 5_000;
const MAX_COMPONENTS = 99;
const MAX_ANIMATIONS = 256;
const MEDIA_SOURCE = /^\/api\/media\/[a-f0-9-]+\.[a-z0-9]+$/;
// The values that place a layer. A copied top layer carries them measured in the scene.
const PLACEMENT_KEYS = ["x", "y", "rotation", "scaleX", "scaleY", "skewX", "skewY", "animations"];
// Fields the editor adds only while it draws component instances; a stored layer never has them.
const DRAWING_ONLY_FIELDS = ["componentOwnerId", "componentSourceSceneId", "componentBackground", "componentPath", "componentOverridden", "_textClips"];
const COMPONENT_FIELDS = ["componentSceneId", "componentStart", "componentVisibility", "componentBackgroundEnabled", "componentOverrides"];
const DAMAGED = "The clipboard's kino data is damaged. Copy it again.";

const label = (item) => `“${item?.name || item?.id || "layer"}”`;

function findScene(document, sceneId) {
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  return scene;
}

function requireList(value, max, what) {
  if (!Array.isArray(value)) throw new Error(DAMAGED);
  if (value.length > max) throw new Error(`The clipboard holds more than ${max} ${what}, which is more than one paste can add.`);
  return value;
}

// A scene ID the document doesn't use, for the temporary documents that validate a paste.
function freeSceneId(scenes) {
  const used = new Set(scenes.map((scene) => scene?.id));
  let index = 0;
  while (used.has(`clipboard-${index}`)) index += 1;
  return `clipboard-${index}`;
}

/** The IDs of `rootIds` and of every layer inside them. */
function withDescendants(layers, rootIds) {
  const included = new Set(rootIds);
  let added = true;
  while (added) {
    added = false;
    for (const layer of layers)
      if (included.has(layer.parentId) && !included.has(layer.id)) {
        included.add(layer.id);
        added = true;
      }
  }
  return included;
}

function hasAncestorIn(layer, byId, ids) {
  const visited = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !visited.has(parent.id)) {
    if (ids.has(parent.id)) return true;
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return false;
}

/** Every main component scene the layers draw, directly or through other components, in order. */
function componentClosure(scenesById, layers) {
  const found = [];
  const seen = new Set();
  const visit = (items) => {
    for (const layer of items) {
      if (layer?.type !== "component" || seen.has(layer.componentSceneId)) continue;
      seen.add(layer.componentSceneId);
      const scene = scenesById.get(layer.componentSceneId);
      if (!scene) continue;
      found.push(scene.id);
      visit(scene.layers ?? []);
    }
  };
  visit(layers);
  return found;
}

// Where a top layer inside a group sits in the scene: the values it needs at the top level to
// look the same (see reparent.js). Null when it can't be written that way.
function worldPlacement(layer, layers, scenes) {
  if (layer.parentId === null) return null;
  const size = componentGeometry(layer, scenes);
  try {
    const values = reparentLayer(layer, parentMatrix(size, layers), size);
    return Object.fromEntries(PLACEMENT_KEYS.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  } catch {
    return null;
  }
}

// The first group around a top layer that does more to it than place it (it is animated,
// faded, masked, …), as { group: its name, effect: in words }, or null. `world` only keeps the
// layer's resting place, so a copy pasted outside its groups doesn't get that.
function groupEffectAround(layer, byId, maskedIds) {
  const visited = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !visited.has(parent.id)) {
    const effect = groupEffect(parent, maskedIds);
    if (effect) return { group: parent.name || parent.id, effect };
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return null;
}

// A mask and the layer it masks: a mask that isn't a mask group's mask covers the next visible
// layer, so the two are drawn as one. Returns the IDs with each one's partner added.
function withMaskPartners(ids, pairs) {
  const result = new Set(ids);
  for (const [maskId, targetId] of pairs) {
    if (!targetId) continue;
    if (ids.has(maskId)) result.add(targetId);
    if (ids.has(targetId)) result.add(maskId);
  }
  return result;
}

/**
 * The uploaded files that layers use, one entry per file: images, videos and audio (`src`) and
 * imported font files (`fontSource`, with type "font").
 */
export function mediaReferences(layers) {
  const found = new Map();
  const add = (src, entry) => {
    if (typeof src === "string" && MEDIA_SOURCE.test(src) && !found.has(src))
      found.set(src, { id: src.slice("/api/media/".length), src, ...entry });
  };
  for (const layer of layers) {
    if (!isRecord(layer)) continue;
    add(layer.src, { type: layer.type, name: layer.name, sourceDuration: layer.mediaSourceDuration ?? 0 });
    add(layer.fontSource, { type: "font", name: layer.fontFamily });
    for (const src of scriptImageSources(layer)) add(src, { type: "image", name: layer.name, sourceDuration: 0 });
    for (const range of layer.textStyleRanges ?? [])
      add(range.style?.fontSource, { type: "font", name: range.style?.fontFamily ?? layer.fontFamily });
  }
  return [...found.values()];
}

function fontReferences(layers, fonts) {
  const found = new Map();
  for (const layer of layers) {
    if (layer?.type !== "text") continue;
    for (const reference of [...layerFontReferences(layer), ...layerFallbackFontReferences(layer, fonts)]) {
      const font = { family: reference.fontFamily, style: reference.fontStyle, weight: reference.fontWeight, src: reference.fontSource };
      found.set(JSON.stringify(font), font);
    }
  }
  return [...found.values()];
}

/** The envelope for the selected layers of a scene. Throws when none of them can be copied. */
export function copyLayers(document, sceneId, layerIds, { fonts = defaultFonts } = {}) {
  const scene = findScene(document, sceneId);
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  const pairs = maskTargets(scene.layers);
  // A mask and the layer it masks are copied together, so the copy looks the same.
  const chosen = withMaskPartners(new Set(layerIds.filter((id) => byId.has(id))), pairs);
  if (!chosen.size) throw new Error("Select the layers to copy.");
  // A selected layer inside a selected group is copied as part of that group.
  const roots = scene.layers.filter((layer) => chosen.has(layer.id) && !hasAncestorIn(layer, byId, chosen));
  const included = withDescendants(scene.layers, roots.map((layer) => layer.id));
  const layers = scene.layers.filter((layer) => included.has(layer.id)).map((layer) => structuredClone(layer));
  const scenesById = new Map(document.scenes.map((item) => [item.id, item]));
  const components = componentClosure(scenesById, layers).map((id) => structuredClone(scenesById.get(id)));
  const everything = [...layers, ...components.flatMap((item) => item.layers)];
  // The pictures and fonts that instances use through their overrides travel along too.
  const referenced = [...everything, ...overrideReferences(everything, document.scenes)];
  const maskedIds = new Set([...pairs.values()].filter(Boolean));
  return {
    format: FORMAT,
    version: CLIPBOARD_VERSION,
    kind: "layers",
    source: { documentId: document.id, sceneId: scene.id },
    layers,
    roots: roots.map((root) => ({
      id: root.id,
      parentId: root.parentId,
      world: worldPlacement(root, scene.layers, document.scenes),
      groupEffect: groupEffectAround(root, byId, maskedIds),
    })),
    masks: [...pairs].filter(([maskId, targetId]) => included.has(maskId) && included.has(targetId)),
    components,
    media: mediaReferences(referenced),
    fonts: fontReferences(referenced, fonts),
  };
}

/** The envelope for one animation of a layer. */
export function copyAnimation(document, sceneId, layerId, animationId) {
  const scene = findScene(document, sceneId);
  const owner = animationOwners(scene).find((item) => item.id === layerId);
  if (!animationTreeEntries(owner?.animations).some(({ animation }) => animation.id === animationId)) throw new Error("Select the animation to copy.");
  return copyAnimations(document, sceneId, [animationId]);
}

/**
 * The envelope for several selected animations, on one layer or on several (animation IDs are
 * unique in a document). They are kept in the Timeline's order, each with the resting values of
 * its own layer, so a paste moves every one from the target layer's values the same way.
 */
export function copyAnimations(document, sceneId, animationIds) {
  const scene = findScene(document, sceneId);
  // This can copy a scene background animation. Pasting onto a background is handled separately.
  const copied = selectedAnimationEntries(animationOwners(scene), animationIds);
  if (!copied.length) throw new Error("Select the animation to copy.");
  const first = copied[0].layer;
  return {
    format: FORMAT,
    version: CLIPBOARD_VERSION,
    kind: "animations",
    source: { documentId: document.id, sceneId: scene.id, layerId: first.id },
    layerType: first.type,
    rest: restValues(first),
    rests: copied.map(({ layer }) => restValues(layer)),
    animations: copied.map(({ animation }) => structuredClone(animation)),
  };
}

// A layer as the document stores it: no drawing-only fields, and component fields only on instances.
function storedLayer(layer) {
  const next = { ...layer };
  for (const key of DRAWING_ONLY_FIELDS) delete next[key];
  if (next.type !== "component") for (const key of COMPONENT_FIELDS) delete next[key];
  return next;
}

// A text layer can name an uploaded font file this workspace doesn't have while the same family
// is loaded here (for example, the font was imported into both apps). It then uses this
// workspace's copy of that family, as choosing the family in the inspector would.
function relinkFont(layer, fonts) {
  if (!fonts || layer.type !== "text") return layer;
  const relink = (style) => {
    if (!style.fontSource) return style.fontSource;
    try { fonts.resolve(style); return style.fontSource; } catch { /* Try the family. */ }
    try { return fonts.resolve({ ...style, fontSource: "" }).src || ""; }
    catch { return style.fontSource; } // Keep the unresolved source and report it.
  };
  let next = layer;
  const source = relink(layer);
  if (source !== layer.fontSource) next = { ...next, fontSource: source };
  const segments = layer.textStyleRanges?.length ? textStyleSegments(layer) : [];
  let segmentIndex = 0;
  for (const [index, range] of (layer.textStyleRanges ?? []).entries()) {
    if (!range.style.fontSource) continue;
    while (segments[segmentIndex]?.end <= range.start) segmentIndex++;
    const source = relink(segments[segmentIndex].style);
    if (source === range.style.fontSource) continue;
    if (next.textStyleRanges === layer.textStyleRanges) next = { ...next, textStyleRanges: [...layer.textStyleRanges] };
    next.textStyleRanges[index] = { ...range, style: { ...range.style, fontSource: source } };
  }
  return next;
}

// An instance override can point at a font file copied from another workspace. Resolve the full
// text style it draws, then store this workspace's matching file in the override entry.
function relinkOverrideFonts(instance, overrides, scenesById, fonts) {
  if (!fonts || !overrides || typeof overrides !== "object") return overrides;
  let result = overrides;
  for (const [componentPath, entry] of Object.entries(overrides)) {
    if (!entry?.fontSource && !entry?.textStyleRanges) continue;
    const resolved = resolveComponentPath(instance, scenesById, componentPath);
    if (resolved?.inherited?.type !== "text") continue;
    const drawn = applyComponentOverride(resolved.inherited, entry);
    const relinked = relinkFont(drawn, fonts);
    if (relinked === drawn) continue;
    if (result === overrides) result = { ...overrides };
    result[componentPath] = { ...entry,
      ...(relinked.fontSource === drawn.fontSource ? {} : { fontSource: relinked.fontSource }),
      ...(relinked.textStyleRanges === drawn.textStyleRanges ? {} : { textStyleRanges: relinked.textStyleRanges }) };

  }
  return result;
}

// Validators from model.js, run on a document made only of the given scenes.
function validateScenes(scenes, problem) {
  try {
    return parseDocument({ version: DOCUMENT_VERSION, id: "clipboard", name: "Clipboard", scenes });
  } catch (error) {
    throw new Error(`${problem} ${error.message}`);
  }
}

// Refuses a paste that changes what a mask in the scene masks (`before` and `after` are the
// scene's layers), or that leaves a copied mask masking anything but the copy of the layer it
// masked (`expected`: pasted mask ID → pasted layer ID).
function checkPastedMasks(before, after, pastedIds, expected) {
  const hint = "Paste into another scene or group instead.";
  const was = maskTargets(before);
  const now = maskTargets(after);
  checkMasks(was, new Map([...now].filter(([id]) => !pastedIds.has(id))), after, "paste here", hint);
  const byId = new Map(after.map((layer) => [layer.id, layer]));
  const groupsAfter = groupMasks(after);
  for (const [groupId, maskId] of groupMasks(before))
    if (groupsAfter.get(groupId) !== maskId)
      throw new Error(`Can't paste here: the mask group ${label(byId.get(groupId))} would get a different mask. ${hint}`);
  for (const [maskId, targetId] of now) {
    if (!pastedIds.has(maskId)) continue;
    const wanted = expected.get(maskId) ?? null;
    if (wanted !== null && targetId === wanted) continue;
    const mask = label(byId.get(maskId));
    throw new Error(
      targetId === null
        ? `Can't paste here: the copied mask ${mask} would have no layer to mask. Copy it together with the layer it masks.`
        : `Can't paste here: the copied mask ${mask} would mask ${label(byId.get(targetId))}, which the original doesn't mask. Copy the mask together with the layer it masks, or copy its whole mask group.`,
    );
  }
}

/**
 * Pastes a layer envelope into a scene. Returns { document, rootIds, idMap, addedComponents,
 * notes, media, textLayers }: the validated next document, the pasted top layers' new IDs,
 * a Map from each copied layer ID to its new ID, the names of main components added to the
 * file, notes about layers that couldn't keep their exact place, the media files the pasted
 * layers use, and their text layers (to check fonts). Throws an Error that says why when the
 * clipboard can't be pasted here; the document is then unchanged.
 * `fonts` is the font registry used to relink fonts by family (optional), and `ids` a Map from
 * copied layer IDs to the IDs their copies should get (duplicate_layers, split_layer).
 */
export function pasteLayers(document, sceneId, envelope, { fonts, ids: chosenIds } = {}) {
  const target = findScene(document, sceneId);
  if (envelope?.kind !== "layers") throw new Error("The clipboard holds an animation. Select a layer to paste it onto.");
  // 0. Layers copied by an older kino, as this version stores them.
  const layersVersion = CLIPBOARD_DOCUMENTS.get(envelope.version) ?? DOCUMENT_VERSION;
  const copied = migrateLayers(requireList(envelope.layers, MAX_LAYERS, "layers"), layersVersion);
  if (!copied.length) throw new Error("The clipboard holds no layers to paste.");
  const components = (envelope.components === undefined ? [] : requireList(envelope.components, MAX_COMPONENTS, "components"))
    .map((scene) => migrateScene(scene, layersVersion));
  const worlds = new Map();
  const effects = new Map(); // copied top layer ID → { group, effect } (see groupEffectAround)
  if (Array.isArray(envelope.roots))
    for (const root of envelope.roots.slice(0, MAX_LAYERS)) {
      if (!isRecord(root) || typeof root.id !== "string") continue;
      if (isRecord(root.world)) worlds.set(root.id, root.world);
      const effect = root.groupEffect;
      if (isRecord(effect) && typeof effect.group === "string" && typeof effect.effect === "string" && /^[a-z0-9 %]{1,60}$/i.test(effect.effect))
        effects.set(root.id, { group: effect.group.slice(0, 200), effect: effect.effect });
    }

  // 1. Where each top layer goes: back into its group, or to the top level of the scene.
  const copiedIds = new Set(copied.map((layer) => (isRecord(layer) ? layer.id : undefined)));
  const targetById = new Map(target.layers.map((layer) => [layer.id, layer]));
  const parentFor = new Map(); // copied top layer ID → its parent in the target scene
  const notes = [];
  const placed = copied.map((layer) => {
    if (!isRecord(layer)) return layer; // the validators explain what is wrong
    const parentId = layer.parentId ?? null;
    if (parentId !== null && copiedIds.has(parentId)) return layer;
    if (parentId !== null && targetById.get(parentId)?.type === "group") {
      parentFor.set(layer.id, parentId);
      return { ...layer, parentId: null };
    }
    parentFor.set(layer.id, null);
    if (parentId === null) return layer;
    const effect = effects.get(layer.id);
    if (effect) notes.push(`${label(layer)} was pasted outside its group ${label({ name: effect.group })}, so it doesn't get what that group does to it: the group ${effect.effect}.`);
    const world = worlds.get(layer.id);
    if (world) {
      const values = Object.fromEntries(PLACEMENT_KEYS.filter((key) => Object.hasOwn(world, key)).map((key) => [key, world[key]]));
      return { ...layer, ...values, parentId: null };
    }
    notes.push(`${label(layer)} couldn't keep its exact place outside its group, so it uses its position inside that group.`);
    return { ...layer, parentId: null };
  });

  // 2. Validate the copied layers and component scenes on their own, before using them.
  const clipboardSceneId = freeSceneId(components);
  const checked = validateScenes(
    [{ id: clipboardSceneId, name: "Clipboard", layers: placed }, ...components],
    "The clipboard's layers can't be pasted:",
  );
  const pastedSource = checked.scenes[0].layers;
  const copiedScenes = new Map(checked.scenes.slice(1).map((scene) => [scene.id, scene]));

  // 3. Link each instance to a main component this file has, or add the copied one once.
  const targetScenes = new Map(document.scenes.map((scene) => [scene.id, scene]));
  const usedSceneIds = new Set(targetScenes.keys());
  const sceneIds = new Map(); // copied component scene ID → its ID in this file
  const addedSources = [];
  const linkComponents = (layers) => {
    for (const layer of layers) {
      if (layer.type !== "component" || sceneIds.has(layer.componentSceneId)) continue;
      const id = layer.componentSceneId;
      if (targetScenes.get(id)?.isComponent) {
        sceneIds.set(id, id);
        continue;
      }
      let nextId = id;
      while (usedSceneIds.has(nextId)) nextId = uid();
      usedSceneIds.add(nextId);
      sceneIds.set(id, nextId);
      const source = copiedScenes.get(id);
      addedSources.push(source);
      linkComponents(source.layers);
    }
  };
  linkComponents(pastedSource);

  // 4. New IDs for every pasted layer and animation. `topParent` gives a top layer its parent.
  // The layers of each main component added to this file get new IDs as well (old → new, per
  // scene), and an instance's override paths, which name those layers, are renamed with them
  // (componentOverrides.js). An instance linked to a main component this file already has keeps
  // its paths: they name that scene's layers.
  const newIds = (layers) => new Map(layers.map((layer) => [layer.id, uid()]));
  const sceneLayerIds = new Map(addedSources.map((source) => [source.id, newIds(source.layers)]));
  function withNewIds(layers, topParent, ids = newIds(layers)) {
    const result = layers.map((layer) => {
      const next = relinkFont(storedLayer(layer), fonts);
      next.id = ids.get(layer.id);
      next.parentId = ids.has(layer.parentId) ? ids.get(layer.parentId) : topParent(layer);
      next.animations = layer.animations.map((animation) => freshAnimationIds(animation, uid));
      if (next.type === "component") {
        next.componentSceneId = sceneIds.get(layer.componentSceneId) ?? layer.componentSceneId;
        if (next.componentOverrides) {
          const relinkedOverrides = relinkOverrideFonts(layer, layer.componentOverrides, copiedScenes, fonts);
          next.componentOverrides = remapComponentOverrides(relinkedOverrides, layer.componentSceneId, copiedScenes, sceneLayerIds);
        }
      }
      return next;
    });
    return { ids, layers: result };
  }
  // `chosenIds` (copied layer ID → wanted ID) names some copies; an ID already in use is not taken.
  const usedLayerIds = new Set(document.scenes.flatMap((item) => item.layers.map((layer) => layer.id)));
  const newPastedIds = newIds(pastedSource);
  for (const [from, wanted] of chosenIds ?? []) if (newPastedIds.has(from) && typeof wanted === "string" && !usedLayerIds.has(wanted)) newPastedIds.set(from, wanted);
  const pasted = withNewIds(pastedSource, (layer) => parentFor.get(layer.id) ?? null, newPastedIds);
  const addedScenes = addedSources.map((source) => ({
    ...source,
    id: sceneIds.get(source.id),
    layers: withNewIds(source.layers, () => null, sceneLayerIds.get(source.id)).layers,
    backgroundAnimations: (source.backgroundAnimations ?? []).map((animation) => freshAnimationIds(animation, uid)),
  }));
  for (let index = 0; index < addedScenes.length; index += 1)
    Object.assign(addedScenes[index], nextScenePosition([...document.scenes, ...addedScenes.slice(0, index)]));

  // 5. Into the scene: directly above the originals when they are here, otherwise on top.
  const next = structuredClone(document);
  const scene = next.scenes.find((item) => item.id === target.id);
  const anchors = [...parentFor.keys()].map((id) => scene.layers.findIndex((layer) => layer.id === id)).filter((index) => index >= 0);
  scene.layers.splice(anchors.length ? Math.max(...anchors) + 1 : scene.layers.length, 0, ...pasted.layers);
  next.scenes.push(...addedScenes);
  const nextScenes = new Map(next.scenes.map((item) => [item.id, item]));
  if (componentClosure(nextScenes, pasted.layers).includes(target.id))
    throw new Error(`Can't paste an instance of ${label(target)} inside that main component.`);

  // 6. The whole document must still be valid.
  let validated;
  try {
    validated = parseDocument(next);
  } catch (error) {
    throw new Error(`These layers can't be pasted here: ${error.message}`);
  }
  const pastedIds = new Set(pasted.layers.map((layer) => layer.id));
  // 7. Masks keep masking what they masked.
  const expectedMasks = new Map();
  if (Array.isArray(envelope.masks))
    for (const pair of envelope.masks.slice(0, MAX_LAYERS))
      if (Array.isArray(pair) && pasted.ids.has(pair[0]) && pasted.ids.has(pair[1])) expectedMasks.set(pasted.ids.get(pair[0]), pasted.ids.get(pair[1]));
  checkPastedMasks(target.layers, validated.scenes.find((item) => item.id === target.id).layers, pastedIds, expectedMasks);
  const addedIds = new Set(addedScenes.map((item) => item.id));
  const result = [
    ...validated.scenes.find((item) => item.id === target.id).layers.filter((layer) => pastedIds.has(layer.id)),
    ...validated.scenes.filter((item) => addedIds.has(item.id)).flatMap((item) => item.layers),
  ];
  // What instances show through their overrides: an overridden picture or font counts too.
  const overridden = overrideReferences(result, validated.scenes);
  return {
    document: validated,
    rootIds: [...parentFor.keys()].map((id) => pasted.ids.get(id)),
    idMap: pasted.ids,
    addedComponents: addedScenes.map((item) => item.name),
    notes,
    media: mediaReferences([...result, ...overridden]),
    textLayers: [...result, ...overridden].filter((layer) => layer.type === "text"),
  };
}

/**
 * Copies of layers in place, directly above the originals and in the same groups (Option-drag
 * on the canvas). Same result shape as pasteLayers.
 */
export function duplicateLayers(document, sceneId, layerIds, { ids } = {}) {
  return pasteLayers(document, sceneId, copyLayers(document, sceneId, layerIds), { ids });
}

// How a pasted animation fits each layer. An animation stores the values it moves between, and
// the presets build them from the layer's own values (animation.js presetAnimation): Slide Up
// ends at the layer's y, Fade In ends at its opacity. So a pasted copy moves each layer by the
// same amounts from that layer's own values:
//   - x, y, rotation, blur, letter spacing and line height shift by the same distance (Slide Up
//     still rises 40 px into place; Letter spacing still opens the text 20% wider than the
//     layer's own, and Line height still spaces the lines 0.4 more than the layer's own);
//   - scale and opacity change in the same proportion (Grow In still starts at 60% of the size).
// Other values (size, corners, colors, strokes, shapes) are pasted as they were copied.
const SHIFTED = { x: [-1_000_000, 1_000_000], y: [-1_000_000, 1_000_000], rotation: [-360_000, 360_000], blur: [0, 1_000], letterSpacing: [-LETTER_SPACING_LIMIT, LETTER_SPACING_LIMIT], lineHeight: [LINE_HEIGHT_MIN, LINE_HEIGHT_MAX] };
const SCALED = { scaleX: [-1_000, 1_000], scaleY: [-1_000, 1_000], opacity: [0, 1] };

function restValues(layer) {
  return Object.fromEntries([...Object.keys(SHIFTED), ...Object.keys(SCALED)].filter((key) => Number.isFinite(layer[key])).map((key) => [key, layer[key]]));
}

// `values` (an animation's from or to) moved from the copied layer's resting values `source`
// to the target layer's `target`. Also used by duplicate.js vary.
export function rebaseValues(values, source, target) {
  if (!isRecord(values)) return values;
  const next = { ...values };
  for (const [key, value] of Object.entries(values)) {
    const range = Object.hasOwn(SHIFTED, key) ? SHIFTED[key] : Object.hasOwn(SCALED, key) ? SCALED[key] : null;
    const from = source[key];
    const to = target[key];
    if (!range || !Number.isFinite(value) || !Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
    if (Object.hasOwn(SCALED, key) && from === 0) continue; // no proportion to keep
    const moved = Object.hasOwn(SHIFTED, key) ? value + to - from : (value * to) / from;
    next[key] = Math.min(range[1], Math.max(range[0], Math.round(moved * 1e6) / 1e6));
  }
  return next;
}

// The animation validators from model.js, run on one layer (with the component scenes it draws).
function validateOnLayer(layer, document) {
  const scenesById = new Map(document.scenes.map((scene) => [scene.id, scene]));
  const components = componentClosure(scenesById, [layer]).map((id) => scenesById.get(id));
  try {
    parseDocument({
      version: DOCUMENT_VERSION,
      id: "clipboard",
      name: "Clipboard",
      scenes: [{ id: freeSceneId(document.scenes), name: "Clipboard", layers: [{ ...layer, parentId: null }] }, ...components],
    });
  } catch (error) {
    // "document.scenes[0].layers[0].animations[1]: the reason" → "the reason"
    throw new Error(error.message.replace(/^document[^\s:]*: /, ""));
  }
}

/**
 * Pastes an animation envelope onto each of the given layers: every copied animation goes onto
 * every layer. The earliest copied animation starts at `time` (the time cursor) and the others
 * keep their offsets from it. Each layer moves from its own resting values the way the copied
 * animation moved from its own layer's values (see rebaseValues). Each copied animation is
 * checked against each layer on its own: one a layer can't take (for example a Color onto a
 * group, or a Morph onto a shape that isn't a vector path) is skipped on that layer only, and
 * the layer still gets the others. Returns { document, pasted: [{layerId, animationIds}],
 * skipped: [{layerId, name, animation, reason}] } (`name` is the layer's name, `animation`
 * the skipped animation's name). Throws when no copied animation fits any of the layers.
 */
export function pasteAnimations(document, sceneId, layerIds, envelope, time) {
  const scene = findScene(document, sceneId);
  if (envelope?.kind !== "animations") throw new Error("The clipboard holds layers, not an animation.");
  const animations = requireList(envelope.animations, MAX_ANIMATIONS, "animations");
  if (!animations.length || !animations.every((item) => isRecord(item) && Number.isFinite(item.start))) throw new Error(DAMAGED);
  const targets = scene.layers.filter((layer) => layerIds.includes(layer.id));
  if (!targets.length) throw new Error("Select a layer, then paste to add the copied animation to it.");
  const earliest = Math.min(...animations.map((item) => item.start));
  const at = Number.isFinite(time) ? Math.max(0, time) : earliest;
  // Each animation's own layer values; an older copy has only `rest`, or none: values stay as copied.
  const fallback = isRecord(envelope.rest) ? envelope.rest : {};
  const rests = Array.isArray(envelope.rests) ? envelope.rests : [];
  const sourceOf = (index) => (isRecord(rests[index]) ? rests[index] : fallback);
  const next = structuredClone(document);
  const nextLayers = next.scenes.find((item) => item.id === scene.id).layers;
  const pasted = [];
  const skipped = [];
  for (const target of targets) {
    const rest = restValues(target);
    const skip = (animation, error) => skipped.push({ layerId: target.id, name: target.name, animation: animationName(animation), reason: error.message });
    const copies = [];
    for (const [index, animation] of animations.entries()) {
      try {
        let copy = { ...freshAnimationIds(animation, uid), start: Math.round((at + animation.start - earliest) * 1000) / 1000 };
        const source = sourceOf(index);
        copy = mapAnimationTree([copy], (copy) => {
        // Effect parameters are local shader controls, not the layer's geometry/property
        // endpoints. Preserve them exactly when pasting onto a differently styled layer.
        if (copy.kind === "effect") return copy;
        const activeMotion = isMoveAnimation(copy) && copy.motionPath?.points?.length > 0;
        const canRebaseMotionEndpoints = activeMotion &&
          Number.isFinite(rest.x) && Number.isFinite(rest.y);
        const dx = Number.isFinite(source.x) && Number.isFinite(rest.x) ? rest.x - source.x : 0;
        const dy = Number.isFinite(source.y) && Number.isFinite(rest.y) ? rest.y - source.y : 0;
        // A Hide or Show has no from or to values: it keeps only its time.
        if (Object.hasOwn(copy, "from") && !canRebaseMotionEndpoints) copy.from = rebaseValues(copy.from, source, rest);
        if (Object.hasOwn(copy, "to") && !canRebaseMotionEndpoints) copy.to = rebaseValues(copy.to, source, rest);
        if (canRebaseMotionEndpoints) {
          const { start, end } = motionEndpoints({
            x: Number.isFinite(source.x) ? source.x : rest.x,
            y: Number.isFinite(source.y) ? source.y : rest.y,
          }, copy);
          const rebasePoint = (value) => {
            const x = value.x + dx;
            const y = value.y + dy;
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000)
              throw new RangeError("The pasted motion endpoint would be outside the supported range.");
            return { x: Math.round(x * 1e6) / 1e6 + 0, y: Math.round(y * 1e6) / 1e6 + 0 };
          };
          copy.from = { ...(isRecord(copy.from) ? copy.from : {}), ...rebasePoint(start) };
          copy.to = { ...(isRecord(copy.to) ? copy.to : {}), ...rebasePoint(end) };
        }
        if (copy.motionPath != null) {
          copy.motionPath = mapMotionPath(
            copy.motionPath,
            (value) => ({ x: value.x + dx, y: value.y + dy }),
            (value) => value,
          );
        }
        const morph = (isRecord(copy.from) && Object.hasOwn(copy.from, "path")) || (isRecord(copy.to) && Object.hasOwn(copy.to, "path"));
        if (morph) {
          if (target.type !== "path") throw new Error("Paste a Morph onto a vector path.");
          copy.from = { ...copy.from, path: target.path }; // a Morph starts from the layer's own shape
        }
        const color = (isRecord(copy.from) && Object.hasOwn(copy.from, "fill")) || (isRecord(copy.to) && Object.hasOwn(copy.to, "fill"));
        if (color && !FILL_LAYER_TYPES.includes(target.type)) throw new Error("Paste a Color animation onto a shape, path, text, or group layer.");
        const spacing = (isRecord(copy.from) && Object.hasOwn(copy.from, "letterSpacing")) || (isRecord(copy.to) && Object.hasOwn(copy.to, "letterSpacing"));
        if (spacing && target.type !== "text") throw new Error("Paste a Letter spacing animation onto a text layer.");
        const lineHeight = (isRecord(copy.from) && Object.hasOwn(copy.from, "lineHeight")) || (isRecord(copy.to) && Object.hasOwn(copy.to, "lineHeight"));
        if (lineHeight && target.type !== "text") throw new Error("Paste a Line height animation onto a text layer.");
        const sound = (key) => (isRecord(copy.from) && Object.hasOwn(copy.from, key)) || (isRecord(copy.to) && Object.hasOwn(copy.to, key));
        const volume = sound("volume") || sound("lowpass");
        if (volume && target.type !== "video" && target.type !== "audio") throw new Error("Paste a Volume or Lowpass animation onto a video or audio layer.");
        const resize = resizeProblem(target, copy);
        if (resize) throw new Error(resize);
        // A Change text swaps a text layer's string (textChange.js), so only text takes one.
        if (isTextChange(copy) && target.type !== "text") throw new Error("Paste a Change text onto a text layer.");
        // A Counter counts the number in a text layer's text (counter.js); it keeps its From and To.
        const counting = counterLayerProblem(target, copy);
        if (counting) throw new Error(counting);
        return copy;
        })[0];
        // A Hide, Show or Change text moved past the scene's end would never run, so it is
        // skipped instead.
        const outside = flattenAnimations([copy]).map((member) => visibilityTimeProblem(member, scene.duration) || textChangeTimeProblem(member, scene.duration)).find(Boolean);
        if (outside) throw new Error(outside);
        // An animation is checked against its layer without the layer's other animations (the
        // model checks each one on its own), so this stays quick for a long list.
        validateOnLayer({ ...target, animations: [copy] }, document);
        copies.push(copy);
      } catch (error) {
        skip(animation, error);
      }
    }
    if (!copies.length) continue;
    try {
      // The rules for the whole list (how many animations one layer can hold).
      validateOnLayer({ ...target, animations: [...target.animations, ...copies] }, document);
    } catch (error) {
      copies.forEach((copy) => skip(copy, error));
      continue;
    }
    nextLayers.find((layer) => layer.id === target.id).animations.push(...copies);
    pasted.push({ layerId: target.id, animationIds: copies.map((copy) => copy.id) });
  }
  if (!pasted.length) {
    const reasons = new Set(skipped.map((item) => item.reason));
    throw new Error(reasons.size === 1 ? skipped[0].reason : `None of the selected layers can take the copied animations. ${skipped[0].animation} on ${label(skipped[0])}: ${skipped[0].reason}`);
  }
  return { document: parseDocument(next), pasted, skipped };
}

const animationName = (animation) => (typeof animation?.name === "string" && animation.name.trim() ? animation.name.trim() : "Animation");
