import { bulkCreateColumns } from "./bulkCreate.js";
import { MAX_SCENES } from "./model.js";
import { MAX_CSV_BYTES, csvUtf8Length, writeCsv } from "./csv.js";
import { parseMediaSource } from "./mediaSource.js";

function columnProblem(document, sceneId) {
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) return "This scene is no longer in the file.";
  const { columns } = bulkCreateColumns(document, sceneId);
  if (!columns.length) return "This scene has no uniquely named text or image layers that Bulk Create can fill.";
  if (columns.length > 254) return "The CSV template supports at most 254 uniquely named text and image layers.";
  return "";
}

function copyKey(document, sceneId) {
  const used = new Set(document.scenes
    .filter((scene) => scene.bulkVariant?.baseSceneId === sceneId)
    .map((scene) => scene.bulkVariant.key));
  for (let index = 1; index <= MAX_SCENES + 1; index += 1) {
    const candidate = index === 1 ? "copy" : `copy-${index}`;
    if (!used.has(candidate) && candidate.length <= 128) return candidate;
  }
  throw new Error("Could not find an unused Bulk Create id for this scene.");
}

function mediaSourceKey(src) {
  const source = parseMediaSource(src);
  return source?.frame === null ? `/api/media/${source.id}` : src;
}

function mediaBySource(media) {
  const entries = media instanceof Map ? [...media.values()] : Array.from(media ?? []);
  return new Map(entries.map((entry) => [mediaSourceKey(entry?.src), entry]));
}

/** Build an RFC 4180-ready one-variant Bulk Create template for the current scene. */
export function sceneCsvRows(document, sceneId, media = []) {
  const problem = columnProblem(document, sceneId);
  if (problem) throw new Error(problem);
  const scene = document.scenes.find((item) => item.id === sceneId);
  const { columns } = bulkCreateColumns(document, sceneId);
  const mediaSources = mediaBySource(media);
  const values = columns.map((column) => {
    const layer = scene.layers.find((item) => item.id === column.layerId);
    if (!layer) throw new Error(`Layer ${column.name} is no longer in this scene.`);
    if (column.kind === "text") return layer.text;
    if (!layer.src) return "";
    const entry = mediaSources.get(mediaSourceKey(layer.src));
    if (typeof entry?.name !== "string" || !entry.name)
      throw new Error(`The original filename for ${column.name} is unavailable; this scene was not exported.`);
    return entry.name;
  });
  const rows = [
    ["id", ...columns.map((column) => column.name), "info_log"],
    [copyKey(document, sceneId), ...values, ""],
  ];
  // Measure the actual UTF-8 download, including BOM, escaped quotes and original
  // filenames. A template we offer must fit both the importer and native Save handler.
  if (csvUtf8Length(writeCsv(rows)) > MAX_CSV_BYTES)
    throw new Error("This scene's CSV exceeds the 2 MiB Bulk Create input limit. Shorten its text or use fewer fillable layers.");
  return rows;
}
