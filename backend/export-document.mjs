import { parseDocument } from "../engine/model.js";

// Scene-only requests existed before versioned export documents. Keep their pixel letter
// spacing contract, while recognizing scene-level background fields introduced by version 3.
// An explicit version always wins. Full documents carry their own version as usual.
export function parseExportDocument(input) {
  if (input.document) return parseDocument(input.document);
  const scene = input.scene;
  const hasVersion3Background = scene && (
    Object.hasOwn(scene, "backgroundEnabled") || Object.hasOwn(scene, "backgroundAnimations") ||
    (scene.background !== null && typeof scene.background === "object")
  );
  return parseDocument({
    version: input.version ?? (hasVersion3Background ? 3 : 1),
    id: "export", name: "Export", scenes: [scene],
  });
}
