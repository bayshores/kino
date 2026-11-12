// A scale or turn has a pivot, and the receipt now says where it is. In recreate test friction 5 a
// scale sent with anchor [960,523] (pixels, meant as the middle of a 1920 frame) was read as percent
// of the layer's own box and sent the type off the left edge. For each layer an edit's add_animation
// gave a scale or a turn, one note names the pivot: the center unless the layer has an anchor, and
// that an anchor is [x%, y%] of the layer's box.
import { animationTreeEntries } from "../../engine/animationTree.js";
import { isRecord } from "../../engine/numbers.js";

const SCALES = ["scaleX", "scaleY"];

const turnsOrScales = (animation) => {
  const keys = [animation.from, animation.to].flatMap((values) => (isRecord(values) ? Object.keys(values) : []));
  if (keys.some((key) => SCALES.includes(key))) return "scales";
  return keys.includes("rotation") ? "turns" : null;
};

/** One note per layer whose add_animation in `operations` scales or turns it: where it pivots. */
export function pivotNotes(document, operations, ref, before = null) {
  const lines = [];
  const seen = new Set();
  // Only animations this edit added count, so a fade added to a layer that scaled earlier adds no note.
  const old = new Set((before?.scenes ?? []).flatMap((scene) => scene.layers).flatMap((layer) =>
    animationTreeEntries(layer.animations ?? [], { groups: false }).map((entry) => entry.animation?.id)));
  for (const operation of operations.flat()) {
    if (operation?.type !== "add_animation" || typeof operation.layerId !== "string" || seen.has(operation.layerId)) continue;
    const layer = document.scenes.flatMap((scene) => scene.layers).find((entry) => entry.id === operation.layerId);
    if (!layer) continue;
    const motions = animationTreeEntries(layer.animations ?? [], { enabledOnly: true, groups: false }).map((entry) => entry.animation)
      .filter((animation) => isRecord(animation) && animation.kind !== "effect" && !old.has(animation.id)).map(turnsOrScales).filter(Boolean);
    if (!motions.length) continue;
    seen.add(operation.layerId);
    const anchor = Array.isArray(layer.anchor) ? layer.anchor : null;
    const where = anchor ? `[${anchor.map((value) => Math.round(value * 10) / 10).join(", ")}]% of its box` : "its center";
    lines.push(`${ref(layer.id)} ${motions.at(-1)} about ${where} (anchor: [x%, y%] of its box)`);
  }
  return lines;
}
