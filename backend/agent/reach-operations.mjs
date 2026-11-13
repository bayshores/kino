// Editor capabilities that need a source document or a workspace-owned preset.
// These only build a document; the service owns atomic save, retry and history.
import { copyLayers, pasteLayers, copyAnimations, pasteAnimations } from "../../engine/layerClipboard.js";
import { pasteReplaceLayers } from "../../engine/layerPasteReplace.js";
import { copyScene, pasteScene } from "../../engine/sceneClipboard.js";
import { applySavedTextEffect } from "../../engine/savedTextEffects.js";
import { applyOperations } from "../../engine/operations.js";
import { parseDocument } from "../../engine/model.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { delayLayers, selectionStart } from "../../engine/duplicate.js";
import { assignCodes, createResolver } from "./refs.mjs";
import { GEOMETRY_OPERATIONS, applyGeometryOperation } from "./reach-geometry.mjs";
import { parseCsv, writeCsv } from "../../engine/csv.js";
import { planBulkCreate, bulkCreatePlanAfterSave, bulkCreateSummary } from "../../engine/bulkCreate.js";
import { applyTraceImage } from "./trace-image.mjs";

export const REACH_HELP = {
  bulk_create: 'bulk_create {scene, csv or rows, deleteMissing?:false}: creates or updates variants atomically and returns the real result CSV in summaries. Import media first; use uploaded src values. dry_run only previews. library rules bulk-create has the full rules.',
  duplicate_layers: 'duplicate_layers {layers, offset?:24, count?:1..50, layout?:line|grid|radial, spacing?:{x,y}, columns?, radius?, stagger?:s, at?:[s or "cue:x"], withMoves?:true, vary?:{key:[first,last] or one per place}}: duplicate selected subtrees with fresh IDs; one copy is named "<name> copy"; count makes real copies "<name> 2"... in a line, grid or ring (original at 12 o\'clock), each copy\'s animations stagger seconds later. at puts copy n at the n-th time instead (in place unless offset or layout is given; count is at\'s length; the original is read at its Show; its Show, Hide and play time move, whole-scene effects stay whole, the animations a recorded move put on it stay unless withMoves:true; a copy fully under a full-frame layer above it is placed above it, and the receipt lists each). vary:{scaleX:[0.4,1.6]} steps a value over the places in time order (the original is one), or gives one per place (text:["1","2","3"]). A move at several times: send the move again per place.',
  split_layer: 'split_layer {layer, at} or {layer, from, to}: cuts a video, audio or GIF layer in two at scene time at; the new piece "<name> 2" plays on from there, so sound and picture stay in sync. from/to also skips the file between (the clip ends to - from s sooner; other layers do not move). Each piece keeps the animations that change what it shows (both keep one that crosses the cut). Later ops can name the new piece.',
  multi_transform: 'multi_transform {layers, action:{kind:"move",dx,dy}|{kind:"scale",scaleX,scaleY,anchor?,keepAspect?}|{kind:"rotate",degrees}}: shared selection box; scale is percent; the layers\' animations go along (a slide still ends where the layer is; at 150% it slides 1.5 times as far).',
  import_svg: 'import_svg {svg,name?,x?,y?}: editable server SVG import into scene. name names the top-level layers: "<name>", "<name> 2", "<name> 3". Warnings report unsupported fidelity. External resources and scripts are refused.',
  trace_image: 'trace_image {layer|media, time?, region?, colors?:4, smooth?:1, minArea?:16, background?, as?, name?}: region [x,y,w,h]; colors 2-12; smooth 0-2; background "auto"|"none"|"#rrggbb"; as "fill"|"outline". A region of a frame becomes a group of flat-color vector paths ("<name> 1" largest first) at the region\'s place; then stroke, roughen, trim-path or animate them. Receipt: paths, points; a warning names a better colors.',
  copy_layers: 'copy_layers {fromProject?,fromScene?,layers,scene?,replaceLayers?}: copy source names/codes across projects with component dependencies, media and fresh IDs. replaceLayers names destination layers for Paste and Replace.',
  copy_scene: 'copy_scene {fromProject?,fromScene,scene?,replace?:false}: copy an artboard across projects; replace retains destination identity.',
  use_piece: 'use_piece {piece,scene?,at?:s,x?,y?,name?}: put a piece saved in the workspace (project manage pieces) into this project, through the same copy as copy_layers and copy_scene: fresh IDs, components, media, fonts. A layers piece goes into scene, its first Show at at seconds (as saved if omitted) and its top left at x,y; name renames a single top layer. A scene piece becomes a new scene (name names it).',
  copy_animations: 'copy_animations {fromProject?,fromScene?,sourceAnimations,layers,time?:0}: paste source animation names/codes onto destination layers, rebasing rest values.',
  apply_easing: 'apply_easing {name,animationIds}: apply a workspace saved easing by exact name or ID; ambiguous names are refused.',
  apply_text_effect: 'apply_text_effect {name,layers,time?:0}: apply a saved text effect by exact name or ID to unlocked text layers.',
};
export const REACH_OPERATIONS = Object.keys(REACH_HELP);

export function namedItem(items, value, label) {
  const byId = items.find((item) => item.id === value);
  if (byId) return byId;
  const matches = items.filter((item) => item.name === value);
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous ${label} "${value}"; use its ID.` : `No ${label} "${value}".`);
  return matches[0];
}

export async function sourceDocument(document, fromProject, store) {
  if (!fromProject || fromProject === document.id) return document;
  const item = namedItem(await store.listProjects(), fromProject, "source project");
  const record = await store.getProject(item.id);
  if (record.trashedAt) throw new Error("Restore the source project before copying it.");
  return record.document;
}

// use_piece: a saved piece goes through pasteLayers / pasteScene (the copy_layers path), then the
// pasted layers are moved in time (at) and place (x, y). Media the library lost is named.
async function usePiece(document, op, { pieces, fonts, mediaRoot }) {
  if (!pieces) throw new Error("Pieces are not available here.");
  if (typeof op.piece !== "string" || !op.piece) throw new Error('use_piece needs piece: the name of a saved piece. List them: project {action:"manage", options:{resource:"pieces", action:"list"}}.');
  const piece = await pieces.find(op.piece);
  const warnings = [];
  for (const item of piece.media)
    if (mediaRoot && !existsSync(path.join(mediaRoot, path.basename(item.id)))) warnings.push(`${item.type === "font" ? "Font file" : "Media"} "${item.name}" is no longer in the library, so the piece shows it missing.`);
  if (piece.kind === "scene") {
    const pasted = pasteScene(document, undefined, piece.envelope, { fonts });
    let next = pasted.document;
    if (op.name !== undefined) next = { ...next, scenes: next.scenes.map((scene) => scene.id === pasted.sceneId ? { ...scene, name: String(op.name) } : scene) };
    return { document: next, warnings: [...warnings, ...(pasted.notes ?? [])] };
  }
  const scenes = document.scenes;
  const sceneId = op.sceneId ?? (scenes.length === 1 ? scenes[0].id : null);
  if (!sceneId) throw new Error(`use_piece needs scene: this project has ${scenes.length} scenes (${scenes.map((scene) => scene.name).slice(0, 6).join(", ")}).`);
  const scene = scenes.find((item) => item.id === sceneId);
  if (op.at !== undefined && (!Number.isFinite(op.at) || op.at < 0 || (Number.isFinite(scene?.duration) && op.at >= scene.duration)))
    throw new Error(`at must be a time inside the scene (0 to ${scene?.duration} s).`);
  if (op.name !== undefined && piece.envelope.roots?.length !== 1)
    throw new Error(`name renames a single top layer; this piece has ${piece.envelope.roots?.length ?? 0}. Rename them after with update_layer.`);
  const pasted = pasteLayers(document, sceneId, piece.envelope, { fonts });
  let next = pasted.document;
  const ids = new Set(pasted.idMap.values());
  const placed = next.scenes.find((item) => item.id === sceneId).layers.filter((layer) => ids.has(layer.id));
  if (op.at !== undefined) {
    const delay = op.at - (selectionStart(placed) ?? 0);
    if (delay !== 0) next = delayLayers(next, sceneId, ids, delay).document;
  }
  if (op.name !== undefined) next = { ...next, scenes: next.scenes.map((item) => item.id !== sceneId ? item : { ...item, layers: item.layers.map((layer) => layer.id === pasted.rootIds[0] ? { ...layer, name: String(op.name) } : layer) }) };
  if (op.x !== undefined || op.y !== undefined) {
    const tops = next.scenes.find((item) => item.id === sceneId).layers.filter((layer) => pasted.rootIds.includes(layer.id));
    const dx = op.x === undefined ? 0 : op.x - Math.min(...tops.map((layer) => layer.x));
    const dy = op.y === undefined ? 0 : op.y - Math.min(...tops.map((layer) => layer.y));
    if (![dx, dy].every(Number.isFinite)) throw new Error("x and y must be numbers.");
    if (dx || dy) next = (await applyGeometryOperation(next, { type: "multi_transform", sceneId, layerIds: pasted.rootIds, action: { kind: "move", dx, dy } }, { fonts })).document;
  }
  return { document: next, warnings: [...warnings, ...(pasted.notes ?? [])] };
}

export async function applyReachOperation(document, op, { store, fonts, agentState, context = {}, mediaRoot, pieces }) {
  if (op.type === "use_piece") {
    const used = await usePiece(document, op, { pieces, fonts, mediaRoot });
    return { document: parseDocument(used.document), warnings: used.warnings };
  }
  if (GEOMETRY_OPERATIONS.includes(op.type)) return applyGeometryOperation(document, op, { fonts });
  if (op.type === "trace_image") return applyTraceImage(document, op, { mediaRoot });
  if (op.type === "bulk_create") {
    // Let the engine validate all inputs and limits before constructing a result summary.
    const next = parseDocument(applyOperations(document, [op], context));
    const parsed = op.csv !== undefined ? parseCsv(op.csv) : { header: op.rows[0], rows: op.rows.slice(1) };
    const plan = planBulkCreate(document, op.sceneId, parsed.header, parsed.rows, [], context.mediaBySrc ?? {});
    const completed = bulkCreatePlanAfterSave(document, next, { ...plan, deleteMissing: op.deleteMissing ?? false });
    return { document: next, summary: { kind: "bulk_create", scene: op.sceneId, csv: writeCsv(bulkCreateSummary(parsed.header, parsed.rows, completed)) } };
  }
  let result;
  if (["copy_layers", "copy_scene", "copy_animations"].includes(op.type)) {
    const source = await sourceDocument(document, op.fromProject, store);
    const state = await agentState.read(source.id);
    const resolver = createResolver(source, assignCodes(state.codes, source));
    let sourceScene = op.fromScene ? resolver.resolve(op.fromScene, "scene") : source.scenes.length === 1 ? source.scenes[0].id : null;
    if (op.type === "copy_layers") {
      if (!Array.isArray(op.layerIds) || !op.layerIds.length) throw new Error("copy_layers needs layers from the source project.");
      const ids = op.layerIds.map((id) => resolver.resolve(id, "layer"));
      sourceScene ??= resolver.sceneOf("layer", ids[0]);
      const scene = source.scenes.find((item) => item.id === sourceScene);
      if (ids.some((id) => !scene?.layers.some((layer) => layer.id === id))) throw new Error("Source layers must belong to one source scene.");
      const envelope = copyLayers(source, sourceScene, ids, { fonts });
      result = op.replaceLayers ? pasteReplaceLayers(document, op.sceneId, op.replaceLayers, envelope, { fonts }) : pasteLayers(document, op.sceneId, envelope, { fonts });
    } else if (op.type === "copy_scene") {
      if (!sourceScene) throw new Error("copy_scene needs fromScene when the source has several scenes.");
      result = pasteScene(document, op.sceneId, copyScene(source, sourceScene), { replace: op.replace ?? false, fonts });
    } else {
      if (!Array.isArray(op.sourceAnimations) || !op.sourceAnimations.length) throw new Error("copy_animations needs sourceAnimations.");
      const ids = op.sourceAnimations.map((id) => resolver.resolve(id, "animation"));
      sourceScene ??= resolver.sceneOf("animation", ids[0]);
      result = pasteAnimations(document, op.sceneId, op.layerIds, copyAnimations(source, sourceScene, ids), op.time ?? 0);
    }
  } else if (op.type === "apply_text_effect") {
    const effect = namedItem(await store.listTextEffects(), op.name, "saved text effect");
    result = applySavedTextEffect(document, op.sceneId, op.layerIds, effect, op.time ?? 0);
  } else if (op.type === "apply_easing") {
    const easing = namedItem(await store.listEasings(), op.name, "saved easing");
    if (!Array.isArray(op.animationIds) || !op.animationIds.length) throw new Error("apply_easing needs animationIds.");
    const resolver = createResolver(document, assignCodes(null, document));
    result = { document: applyOperations(document, op.animationIds.map((id) => ({ type: "update_animation", sceneId: resolver.sceneOf("animation", id), layerId: resolver.layerOfAnimation(id), animationId: id, properties: { easing: easing.easing, intensity: easing.intensity ?? 50 } })), { fonts }) };
  } else throw new Error(`Unknown operation ${op.type}.`);
  return { document: parseDocument(result.document), warnings: [...(result.notes ?? []), ...(result.skipped ?? []).map((item) => typeof item === "string" ? item : JSON.stringify(item))] };
}
