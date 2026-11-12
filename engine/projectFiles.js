import { parseDocument } from "./model.js";

// A copy takes the name it is given; with none, it keeps the store's 120-character name limit
// and always retains the copy suffix.
export function copyProjectDocument(document, id, name) {
  if (typeof name === "string" && name.trim()) return parseDocument({ ...structuredClone(document), id, name: name.trim() });
  const prefix = document.name.slice(0, 113).replace(/[\uD800-\uDBFF]$/, "");
  return parseDocument({ ...structuredClone(document), id, name: `${prefix} [copy]` });
}
