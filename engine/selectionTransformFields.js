import { rotateSelection, rotationAbout, transformTargets } from "./multiTransform.js";
import { selectionResizeAt } from "./selectionTransformDrag.js";

export const SELECTION_RESIZE_ANCHORS = [
  ["center", "Center", 0.5, 0.5],
  ["top-left", "Top left", 0, 0], ["top", "Top center", 0.5, 0], ["top-right", "Top right", 1, 0],
  ["left", "Left center", 0, 0.5], ["right", "Right center", 1, 0.5],
  ["bottom-left", "Bottom left", 0, 1], ["bottom", "Bottom center", 0.5, 1], ["bottom-right", "Bottom right", 1, 1],
];

function number(value, label) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "" || !Number.isFinite(Number(value)))
    throw new Error(`${label} needs a finite number.`);
  return Number(value);
}

/** Numeric and pointer transforms share the drawn box, fixed point, target rules and validation. */
export function selectionTransformFromFields(layers, ids, box, action, { handles = { resize: true, rotate: true }, ...options } = {}) {
  const targets = transformTargets(layers, ids);
  if (!box || !targets.length) throw new Error("Select layers with a usable transform box.");
  if (action.kind === "scale") {
    if (!handles.resize) throw new Error("The selection cannot be resized at this playhead or with the current tool.");
    const across = number(action.scaleX, "Width scale"), down = number(action.scaleY, "Height scale");
    if (across <= 0 || down <= 0) throw new Error("Selection scale must be greater than zero.");
    const keepAspect = Boolean(action.keepAspect || targets.some((layer) => layer.lockAspect));
    if (keepAspect && across !== down) throw new Error("Use equal width and height scales while proportions are locked.");
    const anchor = SELECTION_RESIZE_ANCHORS.find(([id]) => id === (action.anchor ?? "center"));
    if (!anchor) throw new Error("Choose a supported resize anchor.");
    const result = selectionResizeAt(layers, ids, box, box.width * (across / 100 - 1) / 2, box.height * (down / 100 - 1) / 2, 1, 1, {
      ...options, fromCenter: true, keepAspect, pivot: { u: anchor[2], v: anchor[3] },
    });
    const percent = (scale) => Math.round(scale * 100000) / 1000;
    return { ...result, message: `Scaled the selection to ${percent(result.transform[0])}% width and ${percent(result.transform[3])}% height about ${anchor[1].toLowerCase()}.${result.reason ? ` ${result.reason}, so the selection keeps its proportions.` : ""}` };
  }
  if (action.kind === "rotate") {
    if (!handles.rotate) throw new Error("The selection cannot be rotated at this playhead or with the current tool.");
    const degrees = number(action.degrees, "Rotation");
    const transform = rotationAbout({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, degrees);
    return { transform, changes: rotateSelection(layers, ids, transform, options), message: `Rotated the selection ${degrees} degrees about its shared center.` };
  }
  throw new Error("Choose selection scale or rotation.");
}
