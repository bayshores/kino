// Brings a document saved by an older kino up to the current version (schema.js
// DOCUMENT_VERSION), before parseDocument checks it, so an older file opens and draws the same.
// Every place that reads a saved document runs it: parseDocument (opening a .motion file,
// recovery copies, the server's API and MCP), the project store, and layer clipboard data.
//
// Version 1 → 2: a text layer's letterSpacing was pixels; it is now a percentage of its font
// size (letterSpacing.js). The new value is pixels ÷ font size × 100, so every letter keeps its
// place: text layout turns it back into font size × percent ÷ 100, the same pixels.
// Version 3 → 4: media/group box styles become visible. Keep their old values inactive until
// that style is edited, so opening an older file does not add fills, borders or rounded clips.
//
// The steps are pure functions: they return new objects and leave their input unchanged. A value
// they don't recognize (not an object, or a layer list that isn't a list) is passed on as it is,
// so parseDocument can say what is wrong with it.
import { DOCUMENT_VERSION } from "./schema.js";
import { letterSpacingPercent } from "./letterSpacing.js";
import { legacyBoxStyles } from "./boxStyles.js";

// The font size a version 1 text layer without one was given (model.js layerDefaults).
export const VERSION_1_FONT_SIZE = 48;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Version 1 → 2 for one layer: letter spacing in percent of the font size. Only text layers are
// laid out with it. A value that isn't a number is left for parseDocument to refuse.
function layerToVersion2(layer) {
  if (!isRecord(layer) || layer.type !== "text") return layer;
  const { letterSpacing } = layer;
  if (typeof letterSpacing !== "number" || !Number.isFinite(letterSpacing) || letterSpacing === 0) return layer;
  const fontSize = typeof layer.fontSize === "number" ? layer.fontSize : VERSION_1_FONT_SIZE;
  return { ...layer, letterSpacing: letterSpacingPercent(letterSpacing, fontSize) };
}

// What changes from one document version to the next. Each step can change stored layers,
// scene-level fields, or both. Version 1 → 2 changes text letter spacing; version 2 → 3 adds
// the scene background controls and Color animations.
const STEPS = new Map([
  [1, { layer: layerToVersion2 }],
  [2, { scene: sceneToVersion3 }],
  [3, { layer: layerToVersion4 }],
  [4, {}], // Composed groups add a new kind; earlier documents need no value changes.
  [5, {}], // Effect operations add a new kind; existing content and animation values stay exact.
]);

function layerToVersion4(layer) {
  if (!isRecord(layer)) return layer;
  const inactiveBoxStyles = legacyBoxStyles(layer.type);
  if (inactiveBoxStyles.length) return { ...layer, inactiveBoxStyles };
  // Resolve these against their source type only after all scenes have been validated.
  if (layer.type === "component" && layer.componentOverrides)
    return { ...layer, legacyStyleOverrides: true };
  return layer;
}

function sceneToVersion3(scene) {
  // A scene with this field has already crossed the version 2 → 3 boundary.
  if (typeof scene.backgroundEnabled === "boolean") return scene;

  let background = scene.background;
  let backgroundEnabled = true;
  if (typeof background === "string" && /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(background)) {
    backgroundEnabled = false;
    background = background.toLowerCase() === "#00000000"
      ? "#ffffff"
      : background.slice(0, background.length === 9 ? -2 : -1);
  }
  return {
    ...scene,
    ...(background === undefined ? {} : { background }),
    backgroundEnabled,
    backgroundAnimations: scene.backgroundAnimations === undefined ? [] : scene.backgroundAnimations,
  };
}

/** One scene as the current version stores it, including any layer and scene-only steps. */
export function migrateScene(scene, version) {
  if (!isRecord(scene)) return scene;
  let result = scene;
  for (let stepNumber = version; stepNumber < DOCUMENT_VERSION; stepNumber += 1) {
    const step = STEPS.get(stepNumber);
    if (!step) break;
    if (step.layer && Array.isArray(result.layers))
      result = { ...result, layers: result.layers.map(step.layer) };
    if (step.scene) result = step.scene(result);
  }
  return result;
}

/**
 * The layers of a document of version `version`, as the current version stores them. A layer
 * clipboard copy (layerClipboard.js) carries its own version and uses this for its layers.
 */
export function migrateLayers(layers, version) {
  if (!Array.isArray(layers)) return layers;
  let result = layers;
  for (let stepNumber = version; stepNumber < DOCUMENT_VERSION; stepNumber += 1) {
    const step = STEPS.get(stepNumber);
    if (!step) break;
    if (step.layer) {
      const next = result.map(step.layer);
      if (next.some((layer, index) => layer !== result[index])) result = next;
    }
  }
  return result;
}

/**
 * `value` as a document of the current version. A document that is already current, of an
 * unknown version, or not an object at all is returned unchanged (the same object).
 */
export function migrateDocument(value) {
  if (!isRecord(value) || !Number.isInteger(value.version) || value.version >= DOCUMENT_VERSION) return value;
  if (!STEPS.has(value.version)) return value;
  const scenes = Array.isArray(value.scenes) ? value.scenes.map((scene) => migrateScene(scene, value.version)) : value.scenes;
  return { ...value, version: DOCUMENT_VERSION, scenes };
}
