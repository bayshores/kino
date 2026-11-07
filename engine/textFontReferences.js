import { flattenAnimations } from "./animationTree.js";
import { displayText } from "./textSource.js";
import { textStyleRuns } from "./textItemization.js";
import { mirroredTextCharacters } from "./textBidi.js";

export const fontReference = (layer) => ({ fontFamily: layer.fontFamily, fontSource: layer.fontSource || "",
  fontWeight: layer.fontWeight || 400, fontStyle: layer.fontStyle || "normal" });

/** Every stored face, with only the display characters it actually needs to draw. */
export function layerFontReferences(layer) {
  if (layer?.type !== "text") return [];
  layer = { ...layer, text: String(layer.text ?? "") };
  const grouped = new Map();
  const add = (style, text = "") => {
    const font = fontReference(style), key = JSON.stringify(font), previous = grouped.get(key);
    grouped.set(key, { ...font, text: [...new Set((previous?.text ?? "") + text)].join("") });
  };
  add(layer); // Retain a base face even when ranges currently cover every character.
  const { text, runs } = textStyleRuns(layer);
  const mirrored = mirroredTextCharacters(text);
  for (const run of runs) add(run.style, text.slice(run.start, run.end) + mirrored.slice(run.start, run.end));
  for (const animation of flattenAnimations(layer.animations)) {
    if (animation.enabled === false) continue;
    if (animation.kind === "change-text" && animation.text !== layer.text) {
      const replacement = displayText({ ...layer, text: animation.text }).normalize("NFC");
      add(layer, replacement + mirroredTextCharacters(replacement));
    }
    if (animation.kind === "counter") add(layer, "0123456789-., ");
  }
  return [...grouped.values()];
}
