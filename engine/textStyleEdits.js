import { TEXT_STYLE_KEYS, withEditedText, withWholeTextStyle } from "./textStyleRanges.js";

/** Whole-layer controls clear only matching range overrides. Text replacement
 * uses the base style; actual typing can opt into style-preserving edit mapping. */
export function patchTextLayer(layer, patch, { typing = false } = {}) {
  if (layer.type !== "text") return { ...layer, ...patch };
  let next = layer;
  if (Object.hasOwn(patch, "text") && patch.text !== layer.text) {
    next = typing ? withEditedText(layer, patch.text) : { ...layer, text: patch.text };
    if (!typing && layer.textStyleRanges !== undefined) next.textStyleRanges = [];
  }
  if (!Object.hasOwn(patch, "textStyleRanges")) {
    const style = Object.fromEntries(Object.entries(patch).filter(([key]) => TEXT_STYLE_KEYS.includes(key)));
    if (Object.keys(style).length) next = withWholeTextStyle(next, style);
  }
  return { ...next, ...patch };
}
