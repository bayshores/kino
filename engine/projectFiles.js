import { parseDocument } from "./model.js";

// Keep the store's 120-character name limit and always retain the copy suffix.
export function copyProjectDocument(document, id) {
  const prefix = document.name.slice(0, 113).replace(/[\uD800-\uDBFF]$/, "");
  return parseDocument({ ...structuredClone(document), id, name: `${prefix} [copy]` });
}
