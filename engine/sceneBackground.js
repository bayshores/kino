import { evaluateLayer } from "./animation.js";
import { flattenAnimations } from "./animationTree.js";
import { isRecord } from "./numbers.js";

/** This ID cannot collide with stored layers, whose IDs do not allow '#'. */
export const BACKGROUND_OWNER_ID = "#scene-background";

export function isBackgroundEnabled(scene) {
  return scene?.backgroundEnabled !== false;
}

/**
 * A rectangle-shaped view of the scene paint so existing Color animation
 * evaluation can be reused without storing the background as a real layer.
 */
export function backgroundLayer(scene) {
  return {
    id: BACKGROUND_OWNER_ID,
    name: "Background",
    type: "rectangle",
    parentId: null,
    x: 0,
    y: 0,
    width: scene?.width ?? 640,
    height: scene?.height ?? 360,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    opacity: 1,
    fill: scene?.background ?? "#ffffff",
    fillEnabled: isBackgroundEnabled(scene),
    stroke: "#000000",
    strokeWidth: 0,
    strokeAlign: "center",
    radius: 0,
    cornerRadii: null,
    donut: 0,
    sweep: 1,
    startAngle: 0,
    spikes: 5,
    starThickness: 0.382,
    visible: true,
    locked: false,
    lockAspect: false,
    blur: 0,
    blendMode: "normal",
    isMask: false,
    isMaskGroup: false,
    clipContent: false,
    playbackWindows: [],
    shadow: null,
    text: "",
    fontFamily: "Inter",
    fontSource: "",
    fontSize: 48,
    fontWeight: 400,
    fontStyle: "normal",
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    verticalAlign: "top",
    textResize: "fixed",
    textCase: "normal",
    kerning: true,
    ligatures: true,
    path: "",
    src: "",
    mediaStart: 0,
    mediaDuration: 0,
    mediaOffset: 0,
    mediaFreeze: "none",
    mediaSourceDuration: 0,
    volume: 1,
    animations: scene?.backgroundAnimations ?? [],
  };
}

export function backgroundPaintAt(scene, time, { design = false } = {}) {
  if (!isBackgroundEnabled(scene)) return null;
  const animations = scene?.backgroundAnimations;
  if (design || !Array.isArray(animations) || animations.length === 0)
    return scene?.background ?? "#ffffff";
  return evaluateLayer(backgroundLayer(scene), time).fill;
}

export function withoutBackground(scene) {
  return {
    ...scene,
    backgroundEnabled: false,
    backgroundAnimations: [],
  };
}

export function animationOwners(scene) {
  return [...(Array.isArray(scene?.layers) ? scene.layers : []), backgroundLayer(scene)];
}

export function animationOwner(scene, ownerId) {
  if (ownerId === BACKGROUND_OWNER_ID) return backgroundLayer(scene);
  return (Array.isArray(scene?.layers) ? scene.layers : []).find(
    (layer) => layer?.id === ownerId,
  );
}

export function animationListOf(scene, ownerId) {
  if (ownerId === BACKGROUND_OWNER_ID)
    return Array.isArray(scene?.backgroundAnimations) ? scene.backgroundAnimations : [];
  const owner = animationOwner(scene, ownerId);
  return Array.isArray(owner?.animations) ? owner.animations : [];
}

/** Return a new scene with just the selected owner's animation list replaced. */
export function setAnimationList(scene, ownerId, animations) {
  if (!Array.isArray(animations)) throw new TypeError("animations must be an array");
  if (ownerId === BACKGROUND_OWNER_ID)
    return { ...scene, backgroundAnimations: animations };
  if (!Array.isArray(scene?.layers) || !scene.layers.some((layer) => layer?.id === ownerId))
    throw new RangeError(`Animation owner ${String(ownerId)} was not found.`);
  return {
    ...scene,
    layers: scene.layers.map((layer) =>
      layer.id === ownerId ? { ...layer, animations } : layer,
    ),
  };
}

const BACKGROUND_ANIMATION_PROBLEM = "a scene background can only have Color animations";
const BACKGROUND_ANIMATION_KINDS = new Set(["in", "out", "custom"]);

/** Return the restriction error for any background animation that is not Color-only. */
export function backgroundAnimationProblem(scene, _previous) {
  if (!Array.isArray(scene?.backgroundAnimations)) return null;
  for (const animation of flattenAnimations(scene.backgroundAnimations)) {
    if (!isRecord(animation)) continue; // parseDocument reports malformed animation records.
    if (!BACKGROUND_ANIMATION_KINDS.has(animation.kind))
      return BACKGROUND_ANIMATION_PROBLEM;
    if (!isRecord(animation.from) || !isRecord(animation.to))
      return BACKGROUND_ANIMATION_PROBLEM;
    const keys = [...Object.keys(animation.from), ...Object.keys(animation.to)];
    if (!keys.includes("fill") || keys.some((key) => key !== "fill"))
      return BACKGROUND_ANIMATION_PROBLEM;
  }
  return null;
}

/** Center a source-sized rectangle while scaling it to cover the whole scene. */
export function coverBox(scene, mediaWidth, mediaHeight) {
  const sceneWidth = Number.isFinite(scene?.width) && scene.width > 0 ? scene.width : 0;
  const sceneHeight = Number.isFinite(scene?.height) && scene.height > 0 ? scene.height : 0;
  if (
    !(sceneWidth > 0) || !(sceneHeight > 0) ||
    !(Number.isFinite(mediaWidth) && mediaWidth > 0) ||
    !(Number.isFinite(mediaHeight) && mediaHeight > 0)
  ) {
    return { x: 0, y: 0, width: sceneWidth, height: sceneHeight };
  }
  const scale = Math.max(sceneWidth / mediaWidth, sceneHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    x: (sceneWidth - width) / 2,
    y: (sceneHeight - height) / 2,
    width,
    height,
  };
}

function freshLayerId() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Make ordinary image/video content that covers the artboard. It remains a
 * regular bottom layer so it is included in transparent exports.
 */
export function mediaBackgroundLayer(scene, media) {
  const type = media?.type;
  if (type !== "image" && type !== "video")
    throw new TypeError("a scene media background must be an image or video");
  const width = Number.isFinite(scene?.width) && scene.width > 0 ? scene.width : 640;
  const height = Number.isFinite(scene?.height) && scene.height > 0 ? scene.height : 360;
  const box = type === "image"
    ? { x: 0, y: 0, width, height }
    : coverBox({ width, height }, media.width, media.height);
  const sourceDuration = Number.isFinite(media.mediaSourceDuration)
    ? Math.max(0, media.mediaSourceDuration)
    : Number.isFinite(media.sourceDuration) ? Math.max(0, media.sourceDuration) : 0;
  const requestedDuration = Number.isFinite(media.mediaDuration) && media.mediaDuration > 0
    ? media.mediaDuration
    : type === "video" && sourceDuration > 0 ? Math.min(sourceDuration, scene?.duration ?? sourceDuration) : 0;
  const layer = {
    id: freshLayerId(),
    name: "Background",
    type,
    parentId: null,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    opacity: 1,
    fill: "#6c7cff",
    fillEnabled: true,
    stroke: "#000000",
    strokeWidth: 0,
    strokeAlign: "center",
    radius: 0,
    cornerRadii: null,
    donut: 0,
    sweep: 1,
    startAngle: 0,
    spikes: 5,
    starThickness: 0.382,
    visible: true,
    locked: true,
    lockAspect: false,
    blur: 0,
    blendMode: "normal",
    isMask: false,
    isMaskGroup: false,
    clipContent: false,
    playbackWindows: [],
    shadow: null,
    text: "",
    fontFamily: "Inter",
    fontSource: "",
    fontSize: 48,
    fontWeight: 400,
    fontStyle: "normal",
    lineHeight: 1.2,
    letterSpacing: 0,
    textAlign: "left",
    verticalAlign: "top",
    textResize: "fixed",
    textCase: "normal",
    kerning: true,
    ligatures: true,
    path: "",
    src: media.src ?? "",
    mediaStart: Number.isFinite(media.mediaStart) ? media.mediaStart : 0,
    mediaDuration: requestedDuration,
    mediaOffset: Number.isFinite(media.mediaOffset) ? media.mediaOffset : 0,
    mediaFreeze: media.mediaFreeze ?? (type === "video" ? "both" : "none"),
    mediaSourceDuration: sourceDuration,
    volume: Number.isFinite(media.volume) ? media.volume : 1,
    animations: [],
  };
  return layer;
}
