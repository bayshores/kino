import { createScene, parseDocument, uid } from "./model.js";
import { CLIPBOARD_VERSION, copyLayers, pasteLayers } from "./layerClipboard.js";
import { nextScenePosition } from "./sceneLayout.js";
import { DOCUMENT_VERSION } from "./schema.js";
import { freshAnimationIds } from "./animationTree.js";

const FIELDS = ["name", "width", "height", "duration", "background", "backgroundEnabled", "backgroundAnimations", "isComponent", "componentPlayback", "aspectLocked"];

export function copyScene(document, sceneId) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error("Select the scene to copy.");
  return {
    format: "kino.clipboard", version: CLIPBOARD_VERSION, kind: "scene",
    source: { documentId: document.id, sceneId },
    scene: Object.fromEntries(FIELDS.filter((key) => Object.hasOwn(scene, key)).map((key) => [key, structuredClone(scene[key])])),
    contents: scene.layers.length ? copyLayers(document, sceneId, scene.layers.map((layer) => layer.id)) : null,
  };
}

/** Paste one independent artboard, or replace contents while retaining the destination's
 * identity, canvas position and component role. Layer paste owns remapping and media checks. */
export function pasteScene(document, targetSceneId, envelope, { replace = false, fonts } = {}) {
  if (envelope?.kind !== "scene" || !envelope.scene || typeof envelope.scene !== "object" || Array.isArray(envelope.scene))
    throw new Error("The clipboard has no scene to paste.");
  const target = document.scenes.find((item) => item.id === targetSceneId);
  if (replace && !target) throw new Error("Select the scene to replace.");
  const properties = Object.fromEntries(FIELDS.filter((key) => Object.hasOwn(envelope.scene, key)).map((key) => [key, structuredClone(envelope.scene[key])]));
  const metadata = parseDocument({ version: DOCUMENT_VERSION, id: "scene-clipboard", name: "Clipboard", scenes: [createScene(properties)] }).scenes[0];
  const newScene = {
    ...metadata, id: replace ? target.id : uid(),
    ...(replace ? { canvasX: target.canvasX, canvasY: target.canvasY, isComponent: target.isComponent } : nextScenePosition(document.scenes)),
    backgroundAnimations: metadata.backgroundAnimations.map((animation) => freshAnimationIds(animation, uid)), layers: [],
  };
  const base = structuredClone(document);
  if (replace) base.scenes = base.scenes.map((scene) => scene.id === target.id ? newScene : scene);
  else base.scenes.push(newScene);
  let result;
  if (envelope.contents === null) result = { document: base, media: [], textLayers: [], addedComponents: [], notes: [] };
  else result = pasteLayers(base, newScene.id, envelope.contents, { fonts });
  // Width and height of a main component remain synchronized for inspector fields as well.
  for (const scene of result.document.scenes) for (const layer of scene.layers) {
    if (layer.type === "component" && layer.componentSceneId === newScene.id) {
      layer.width = newScene.width; layer.height = newScene.height;
    }
  }
  try { result.document = parseDocument(result.document); }
  catch (error) { throw new Error(`The scene could not be pasted: ${error.message}`); }
  return { ...result, sceneId: newScene.id };
}
