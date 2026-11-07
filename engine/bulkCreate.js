// Bulk Create turns CSV rows into ordinary linked component scenes. Planning never changes a
// document or uploads a file. Apply receives the completed uploads and produces one document,
// which the caller validates before adding a single undo step (or saving one MCP revision).
import { createLayer, createScene, MAX_SCENES, MAX_LAYERS_TOTAL, MAX_STRING_LENGTH } from "./model.js";
import { componentOverridesWithPatch, componentOverridesWithoutKeys } from "./componentOverrides.js";
import { parseMediaSource } from "./mediaSource.js";
import { animationTreeEntries, mapAnimationTree } from "./animationTree.js";

const RESERVED_NAMES = new Set(["id", "info_log"]);
const IMAGE_SOURCE = /^\/api\/media\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp|gif|svg)$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
function same(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function baseOf(document, baseSceneId) {
  const scene = document?.scenes?.find((item) => item.id === baseSceneId);
  if (!scene) throw new Error("The base scene is no longer in this file.");
  return scene;
}

/** Flat scene layers include children of groups, but never children of nested instances. */
export function bulkCreateColumns(document, baseSceneId) {
  const base = baseOf(document, baseSceneId);
  const counts = new Map();
  for (const layer of base.layers) counts.set(layer.name, (counts.get(layer.name) ?? 0) + 1);
  const columns = [], skipped = [], reported = new Set();
  for (const layer of base.layers) {
    let reason = "";
    if (layer.type !== "text" && layer.type !== "image") reason = "Only text and image layers can be filled from CSV";
    else if (RESERVED_NAMES.has(layer.name.toLowerCase())) reason = `${layer.name} is a reserved CSV column name`;
    else if (!layer.name.trim()) reason = "Give this layer a unique name";
    else if (counts.get(layer.name) > 1) reason = `Rename one of the ${counts.get(layer.name)} layers named ${layer.name}`;
    if (reason) {
      if (!reported.has(layer.name)) skipped.push({ name: layer.name, reason });
      reported.add(layer.name);
    } else columns.push({ name: layer.name, layerId: layer.id, kind: layer.type });
  }
  return { columns, skipped };
}

function variantsOf(document, baseSceneId) {
  return document.scenes.filter((scene) => scene.bulkVariant?.baseSceneId === baseSceneId);
}

function variantInstance(scene, base) {
  return scene.layers.find((layer) => layer.id === scene.bulkVariant?.instanceId && layer.type === "component" && layer.componentSceneId === base.id);
}

export function bulkCreateTemplate(document, baseSceneId) {
  const base = baseOf(document, baseSceneId);
  const { columns } = bulkCreateColumns(document, baseSceneId);
  if (columns.length > 254) throw new Error("The CSV template supports at most 254 uniquely named text and image layers (256 columns including id and info_log).");
  const baseValues = columns.map((column) => {
    const layer = base.layers.find((item) => item.id === column.layerId);
    return column.kind === "text" ? layer.text : layer.src;
  });
  return [
    ["id", ...columns.map((column) => column.name), "info_log"],
    ["", ...baseValues, "Base scene (not created)"],
    ...variantsOf(document, base.id).map((scene) => {
      const instance = variantInstance(scene, base);
      return [scene.bulkVariant.key, ...columns.map((column, index) => {
        const entry = instance?.componentOverrides?.[column.layerId];
        const value = entry?.[column.kind === "text" ? "text" : "src"] ?? baseValues[index];
        return value === baseValues[index] ? "" : value;
      }), instance ? "" : `Error: Variant ${scene.bulkVariant.key} no longer uses ${base.name}; skipped`];
    }),
  ];
}

// A spreadsheet row number includes its header. Keep it on every diagnostic so the summary
// and the confirmation screen point at the same cell in Excel, Numbers and plain CSV files.
function checkRows(header, rows) {
  if (!Array.isArray(header) || !header.length || header.length > 256 || !header.every((cell) => typeof cell === "string"))
    throw new Error("CSV needs a header with 1 to 256 text columns.");
  if (!Array.isArray(rows) || rows.length > MAX_SCENES + 1) throw new Error(`CSV supports at most ${MAX_SCENES + 1} data rows.`);
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const row of [header, ...rows]) {
    if (!Array.isArray(row) || row.length > 256 || !row.every((cell) => typeof cell === "string")) throw new Error("CSV rows must contain at most 256 text cells.");
    for (const cell of row) {
      if (cell.length > MAX_STRING_LENGTH) throw new Error(`A CSV cell exceeds ${MAX_STRING_LENGTH} characters.`);
      bytes += encoder.encode(cell).length + 1;
    }
  }
  if (bytes > 2 * 1024 * 1024) throw new Error("CSV must be at most 2 MB.");
}

function matchingColumns(header, available, skipped) {
  const matched = [], owned = new Set();
  let idIndex = -1;
  const exactId = header.indexOf("id");
  const idCandidates = header.flatMap((name, index) => name.toLowerCase() === "id" ? [index] : []);
  if (exactId >= 0) idIndex = exactId;
  else if (idCandidates.length === 1) idIndex = idCandidates[0];
  if (idIndex < 0 || idCandidates.length !== 1) throw new Error("CSV needs one unambiguous id column.");
  // Reserve exact matches before considering spelling that differs in case, so an earlier
  // "title" never steals the layer explicitly named by a later "Title" column.
  const indexes = header.map((_, index) => index).sort((a, b) =>
    Number(available.some((column) => column.name === header[b])) - Number(available.some((column) => column.name === header[a])));
  for (const index of indexes) {
    const name = header[index];
    if (index === idIndex || name.toLowerCase() === "info_log") continue;
    const exact = available.filter((column) => column.name === name);
    const matches = exact.length ? exact : available.filter((column) => column.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1 || owned.has(matches[0]?.layerId)) {
      const message = matches.length > 1 || owned.has(matches[0]?.layerId)
        ? `Column ${name} is ambiguous; use each exact layer name once.`
        : `Column ${name} does not match a unique text or image layer; ignored.`;
      skipped.push({ column: name, message });
      continue;
    }
    owned.add(matches[0].layerId);
    matched.push({ ...matches[0], index });
  }
  return { idIndex, matched: matched.sort((a, b) => a.index - b.index) };
}

/** Filenames in image columns that may resolve through permitted saved-media metadata. */
export function bulkCreateImageNames(document, baseSceneId, header, rows) {
  const { matched } = matchingColumns(header, bulkCreateColumns(document, baseSceneId).columns, []);
  const imageIndexes = new Set(matched.filter((column) => column.kind === "image").map((column) => column.index));
  const names = new Set();
  for (const cells of rows) for (const index of imageIndexes) {
    const value = cells[index] ?? "";
    if (value && !value.startsWith("/api/media/")) names.add(value);
  }
  return [...names];
}

function savedImageEntries(sources) {
  if (!(sources instanceof Map)) return [];
  return [...sources.entries()].flatMap(([key, entry]) => {
    // Saved media maps are keyed by their source URL. Upload results are keyed by the
    // selected filename, so they cannot accidentally become filename lookup records.
    if (key !== entry?.src || typeof entry?.name !== "string" || !entry.name || !IMAGE_SOURCE.test(entry.src)) return [];
    const type = String(entry.mime ?? entry.type ?? "").toLowerCase();
    if (type ? !type.startsWith("image/") : !IMAGE_FILE.test(entry.name)) return [];
    return [entry];
  });
}

function imageMatch(value, files, sources, originalSrc) {
  if (IMAGE_SOURCE.test(value)) return { value };
  if (value.startsWith("/api/media/")) return { error: `${value}: not an image` };
  const fileExact = files.filter((file) => file.name === value);
  const fileMatches = fileExact.length ? fileExact : files.filter((file) => file.name.toLowerCase() === value.toLowerCase());
  if (fileMatches.length) {
    if (fileMatches.length > 1) return { error: `${value}: ambiguous: ${fileMatches.map((file) => file.name).join(" and ")}` };
    const file = fileMatches[0];
    const type = file.type.toLowerCase();
    if (type && type !== "application/octet-stream" ? !type.startsWith("image/") : !IMAGE_FILE.test(file.name)) return { error: `${file.name}: not an image` };
    return { value, fileName: file.name };
  }

  const media = savedImageEntries(sources);
  const mediaExact = media.filter((entry) => entry.name === value);
  let mediaMatches = mediaExact.length ? mediaExact : media.filter((entry) => entry.name.toLowerCase() === value.toLowerCase());
  if (!mediaMatches.length) return { error: `${value}: missing` };
  if (mediaMatches.length > 1 && originalSrc) {
    const source = parseMediaSource(originalSrc);
    const original = mediaMatches.filter((entry) => entry.src === originalSrc ||
      (source?.frame === null && entry.src === `/api/media/${source.id}`));
    if (original.length === 1) mediaMatches = original;
  }
  if (mediaMatches.length > 1) return { error: `${value}: ambiguous: ${mediaMatches.map((entry) => entry.name).join(" and ")}` };
  return { value, savedSrc: mediaMatches[0].src };
}

function sourceOf(change, sources) {
  const name = change.fileName ?? change.savedSrc ?? change.value;
  const upload = sources instanceof Map ? sources.get(name) : Object.hasOwn(sources, name) ? sources[name] : undefined;
  if (!change.fileName && !change.savedSrc && upload === undefined) return { src: change.value };
  const src = typeof upload === "string" ? upload : upload?.src;
  if (!IMAGE_SOURCE.test(src ?? "")) throw new Error(`Image ${name} has not finished uploading.`);
  const duration = typeof upload === "object" ? Number(upload.measurements?.duration ?? upload.duration ?? upload.mediaSourceDuration ?? 0) : 0;
  return { src, mediaSourceDuration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
}

function rowOverrides(base, instance, columns, changes, sources) {
  let overrides = structuredClone(instance.componentOverrides ?? {});
  for (const column of columns) overrides = componentOverridesWithoutKeys(overrides, column.layerId, column.kind === "text" ? ["text"] : ["src", "mediaSourceDuration"]);
  const patch = {};
  for (const change of changes) {
    const original = base.layers.find((layer) => layer.id === change.layerId);
    if (!original) throw new Error(`Layer ${change.layerId} is no longer in the base scene. Review the CSV again.`);
    if (change.kind === "text") {
      if (change.value !== original.text) patch[change.layerId] = { text: change.value };
    } else {
      const source = sourceOf(change, sources);
      if (source.src !== original.src) {
        // A measurement belongs only to its source. Unknown replacements clear the base's
        // length so decoded GIF metadata can supply it when Add Play is used after detaching.
        const previous = instance.componentOverrides?.[change.layerId];
        if (source.mediaSourceDuration === undefined)
          source.mediaSourceDuration = previous?.src === source.src ? previous.mediaSourceDuration ?? 0 : 0;
        patch[change.layerId] = source;
      }
    }
  }
  // This is the same pure override primitive used by setComponentOverride in operations.js.
  // Importing that operation here would create a dependency cycle.
  return componentOverridesWithPatch({ ...instance, componentOverrides: overrides }, new Map([[base.id, { ...base, isComponent: true }]]), patch);
}

function allocateIds(document) {
  const used = new Set();
  for (const scene of document.scenes) {
    used.add(scene.id);
    for (const animation of scene.backgroundAnimations ?? [])
      for (const { stored } of animationTreeEntries([animation])) if (stored?.id) used.add(stored.id);
    for (const layer of scene.layers) {
      used.add(layer.id);
      for (const animation of layer.animations ?? [])
        for (const { stored } of animationTreeEntries([animation])) if (stored?.id) used.add(stored.id);
    }
  }
  let next = 1;
  return (kind) => {
    let id;
    do { id = `bulk-${kind}-${next++}`; } while (used.has(id));
    used.add(id);
    return id;
  };
}

function deletionProblem(document, scene) {
  const references = document.scenes.flatMap((item) => item.layers).filter((layer) => layer.type === "component" && layer.componentSceneId === scene.id);
  return references.length ? `Variant ${scene.bulkVariant.key} is used by ${references.length} linked instance${references.length === 1 ? "" : "s"}; detach them before deleting it.` : "";
}

/** A plan contains diagnostics and changes for valid rows; errors never erase valid rows. */
export function planBulkCreate(document, baseSceneId, header, rows, fileNames = [], sources = {}) {
  checkRows(header, rows);
  const base = baseOf(document, baseSceneId);
  const available = bulkCreateColumns(document, baseSceneId);
  const plan = { baseSceneId, columns: [], creates: [], updates: [], unchanged: [], deletes: [], skipped: [], errors: [], imagesNeeded: [], rowResults: [] };
  const { idIndex, matched } = matchingColumns(header, available.columns, plan.skipped);
  plan.columns = matched;
  plan.skipped.push(...available.skipped.map(({ name, reason }) => ({ column: name, message: reason })));
  const files = Array.from(fileNames, (file) => typeof file === "string" ? { name: file, type: "" } : { name: String(file.name), type: String(file.type ?? file.mime ?? "") });
  const variants = variantsOf(document, baseSceneId);
  const byKey = new Map(variants.map((scene) => [scene.bulkVariant.key, scene]));
  const keyRows = new Map();
  rows.forEach((cells, index) => {
    const key = (cells[idIndex] ?? "").trim();
    if (key) keyRows.set(key, [...(keyRows.get(key) ?? []), index + 2]);
  });
  const needed = new Set(), usedFiles = new Set(), allocate = allocateIds(document);
  rows.forEach((cells, index) => {
    const key = (cells[idIndex] ?? "").trim();
    const result = { index, row: index + 2, key, status: "skipped", message: "no id" };
    plan.rowResults.push(result);
    if (!key) { plan.skipped.push({ ...result }); return; }
    const problems = [];
    if (key.length > 128) problems.push("id must be 1 to 128 characters");
    const duplicates = keyRows.get(key);
    if (duplicates.length > 1) problems.push(`Repeated id ${key}; also on row ${duplicates.filter((row) => row !== result.row).join(", ")}`);
    if (cells.length > header.length && cells.slice(header.length).some((cell) => cell !== "")) problems.push("Row has more cells than the header");
    const existing = byKey.get(key);
    const instance = existing ? variantInstance(existing, base) : null;
    if (existing && !instance) problems.push(`Variant ${key} no longer uses ${base.name}; skipped`);
    const changes = [];
    for (const column of matched) {
      const value = cells[column.index] ?? "";
      if (value === "") continue;
      if (column.kind === "text") changes.push({ layerId: column.layerId, kind: "text", value });
      else {
        const original = base.layers.find((layer) => layer.id === column.layerId);
        const match = imageMatch(value, files, sources, original?.src);
        if (match.error) problems.push(`${column.name}: ${match.error}`);
        else changes.push({ layerId: column.layerId, kind: "image", ...match });
      }
    }
    if (problems.length) {
      Object.assign(result, { status: "error", message: problems.join("; ") });
      plan.errors.push({ ...result });
      return;
    }
    for (const change of changes) if (change.fileName) { needed.add(change.fileName); usedFiles.add(change.fileName); }
    const entry = { index, row: result.row, key, changes, sceneId: existing?.id ?? allocate("scene"), instanceId: instance?.id ?? allocate("instance") };
    if (!existing) {
      entry.backgroundAnimationIdMap = Object.create(null);
      for (const animation of base.backgroundAnimations ?? [])
        for (const { stored } of animationTreeEntries([animation]))
          if (stored?.id) entry.backgroundAnimationIdMap[stored.id] = allocate("animation");
      entry.backgroundAnimationIds = (base.backgroundAnimations ?? []).map((animation) => entry.backgroundAnimationIdMap[animation.id]);
      plan.creates.push(entry);
      result.status = "created";
    } else {
      const hasUploads = changes.some((change) => change.fileName);
      const next = hasUploads ? null : rowOverrides(base, instance, matched, changes, sources);
      const unchanged = !hasUploads && same(next, instance.componentOverrides ?? {});
      plan[unchanged ? "unchanged" : "updates"].push(entry);
      result.status = unchanged ? "unchanged" : "updated";
    }
    result.sceneId = entry.sceneId;
    result.message = "";
  });
  for (const variant of variants) {
    if (keyRows.has(variant.bulkVariant.key)) continue;
    const error = deletionProblem(document, variant);
    const entry = { key: variant.bulkVariant.key, sceneId: variant.id, instanceId: variant.bulkVariant.instanceId, error };
    plan.deletes.push(entry);
    if (error) plan.errors.push({ scope: "delete", key: entry.key, message: error });
  }
  plan.imagesNeeded = [...needed];
  for (const file of files) if (!usedFiles.has(file.name)) plan.skipped.push({ file: file.name, message: `${file.name}: no valid CSV row uses this file; it will not be uploaded.` });
  return plan;
}

export function bulkCreateLimitProblem(document, plan, { deleteMissing = false } = {}) {
  const removed = deleteMissing ? plan.deletes.filter((item) => !item.error) : [];
  const scenes = document.scenes.length + plan.creates.length - removed.length;
  if (scenes > MAX_SCENES) return `This would make ${scenes} scenes; the limit is ${MAX_SCENES}.`;
  const ids = new Set(removed.map((item) => item.sceneId));
  const layers = document.scenes.reduce((count, scene) => count + (ids.has(scene.id) ? 0 : scene.layers.length), 0) + plan.creates.length;
  if (layers > MAX_LAYERS_TOTAL) return `This would make ${layers} layers; the limit is ${MAX_LAYERS_TOTAL}.`;
  return "";
}

export function applyBulkCreate(document, plan, srcByFileName = {}, { deleteMissing = false } = {}) {
  const problem = bulkCreateLimitProblem(document, plan, { deleteMissing });
  if (problem) throw new Error(problem);
  const next = structuredClone(document), base = baseOf(next, plan.baseSceneId);
  if (plan.creates.length || plan.updates.length) base.isComponent = true;
  for (const entry of plan.updates) {
    const scene = next.scenes.find((item) => item.id === entry.sceneId);
    const instance = scene && variantInstance(scene, base);
    if (!instance) throw new Error(`Variant ${entry.key} no longer uses ${base.name}; skipped`);
    const overrides = rowOverrides(base, instance, plan.columns, entry.changes, srcByFileName);
    if (Object.keys(overrides).length) instance.componentOverrides = overrides;
    else delete instance.componentOverrides;
  }
  // New variants join after the last existing variant, even when unrelated scenes intervene.
  const after = Math.max(next.scenes.indexOf(base), ...next.scenes.map((scene, index) => scene.bulkVariant?.baseSceneId === base.id ? index : -1));
  const created = plan.creates.map((entry) => {
    // The variant scene owns the copied background; its root instance draws only the content.
    const instance = createLayer("component", { id: entry.instanceId, name: base.name, componentSceneId: base.id,
      x: 0, y: 0, width: base.width, height: base.height, clipContent: true, componentStart: 0, componentBackgroundEnabled: false });
    const overrides = rowOverrides(base, instance, plan.columns, entry.changes, srcByFileName);
    if (Object.keys(overrides).length) instance.componentOverrides = overrides;
    const suffix = ` - ${entry.key}`;
    return createScene({ id: entry.sceneId, name: `${base.name.slice(0, 256 - suffix.length)}${suffix}`,
      width: base.width, height: base.height, duration: base.duration, background: structuredClone(base.background),
      backgroundEnabled: base.backgroundEnabled, backgroundAnimations: (base.backgroundAnimations ?? []).map((animation) =>
        mapAnimationTree([structuredClone(animation)], (item) => ({ ...item, id: entry.backgroundAnimationIdMap[item.id] }))[0]),
      layers: [instance], bulkVariant: { baseSceneId: base.id, key: entry.key, instanceId: instance.id } });
  });
  next.scenes.splice(after + 1, 0, ...created);
  if (deleteMissing) {
    const removed = new Set(plan.deletes.filter((entry) => !entry.error).map((entry) => entry.sceneId));
    for (const scene of next.scenes) if (removed.has(scene.id) && deletionProblem(next, scene)) throw new Error(deletionProblem(next, scene));
    next.scenes = next.scenes.filter((scene) => !removed.has(scene.id));
  }
  return next;
}

/** Server-resolved measurements can turn an otherwise unchanged CSV row into an update. */
export function bulkCreatePlanAfterSave(before, after, plan) {
  const changed = plan.unchanged.filter((entry) => {
    const previous = before.scenes.find((scene) => scene.id === entry.sceneId)?.layers.find((layer) => layer.id === entry.instanceId);
    const saved = after.scenes.find((scene) => scene.id === entry.sceneId)?.layers.find((layer) => layer.id === entry.instanceId);
    return saved && !same(previous?.componentOverrides ?? {}, saved.componentOverrides ?? {});
  });
  const updatedIds = new Set(changed.map((entry) => entry.sceneId));
  return { ...plan, updates: [...plan.updates, ...changed].sort((a, b) => a.row - b.row),
    unchanged: plan.unchanged.filter((entry) => !updatedIds.has(entry.sceneId)),
    rowResults: plan.rowResults.map((row) => updatedIds.has(row.sceneId) ? { ...row, status: "updated" } : row) };
}

/** Downloadable results retain every original row and replace (or add) info_log. */
export function bulkCreateSummary(header, rows, plan) {
  const infoIndex = header.findIndex((name) => name.toLowerCase() === "info_log");
  const resultHeader = [...header];
  if (infoIndex < 0) resultHeader.push("info_log");
  const logIndex = infoIndex < 0 ? header.length : infoIndex;
  const result = [resultHeader, ...rows.map((cells, index) => {
    const row = resultHeader.map((_, column) => cells[column] ?? "");
    const status = plan.rowResults[index];
    row[logIndex] = status?.status === "error" ? `Error: ${status.message}` : status?.status === "skipped" ? `Skipped: ${status.message}` : ({ created: "Created", updated: "Updated", unchanged: "Unchanged" }[status?.status] ?? "Skipped");
    return row;
  })];
  const idIndex = header.findIndex((name) => name.toLowerCase() === "id");
  for (const entry of plan.skipped.filter((entry) => !entry.row)) {
    const row = resultHeader.map(() => "");
    row[logIndex] = `Skipped: ${entry.message}`;
    result.push(row);
  }
  if (plan.deleteMissing) for (const entry of plan.deletes) {
    const row = resultHeader.map(() => "");
    row[idIndex] = entry.key;
    row[logIndex] = entry.error ? `Error: ${entry.error}` : "Deleted";
    result.push(row);
  }
  return result;
}
