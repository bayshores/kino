// A piece: layers or a whole scene saved in the workspace to use again in any project, and to pass
// on as one file (.kinopiece). It wraps a clipboard envelope (layerClipboard.js, sceneClipboard.js),
// so using one is the same copy path as copy_layers and copy_scene: fresh ids, components, media.
//
// {format:"kino.piece", version, name, description, kind:"layers"|"scene", envelope, canvas:{width,height},
//  length, layerNames, layerCount, media:[{id, name, type, mime?}]}
import { createDocument, createScene, parseDocument } from "./model.js";
import { flattenAnimations } from "./animationTree.js";
import { mediaReferences, pasteLayers } from "./layerClipboard.js";
import { pasteScene } from "./sceneClipboard.js";
import { selectionStart } from "./duplicate.js";

export const PIECE_FORMAT = "kino.piece";
export const PIECE_VERSION = 1;
export const PIECE_NAME_MAX = 80;
const MEDIA_ID = /^[a-f0-9-]+\.[a-z0-9]+$/;
const MAX_MEDIA = 400;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The layers envelope inside a piece (a scene piece keeps its layers in `contents`).
const partsOf = (envelope) => (envelope?.kind === "scene" ? envelope.contents : envelope);

function allLayers(envelope) {
  const parts = partsOf(envelope);
  if (!isRecord(parts)) return [];
  const layers = Array.isArray(parts.layers) ? parts.layers : [];
  const components = Array.isArray(parts.components) ? parts.components : [];
  return [...layers, ...components.flatMap((scene) => (isRecord(scene) && Array.isArray(scene.layers) ? scene.layers : []))];
}

/** The uploaded files a piece needs: [{id, name, type}] (type is "font" for a font file). */
export function pieceMedia(envelope) {
  const found = new Map();
  const parts = partsOf(envelope);
  const declared = isRecord(parts) && Array.isArray(parts.media) ? parts.media : [];
  for (const entry of [...mediaReferences(allLayers(envelope)), ...declared]) {
    if (isRecord(entry) && typeof entry.id === "string" && MEDIA_ID.test(entry.id) && !found.has(entry.id))
      found.set(entry.id, { id: entry.id, name: String(entry.name ?? entry.id).slice(0, 200), type: String(entry.type ?? "image") });
  }
  return [...found.values()].slice(0, MAX_MEDIA);
}

function layersLength(layers) {
  const start = selectionStart(layers) ?? 0;
  let end = start;
  for (const layer of layers) for (const animation of flattenAnimations(layer.animations ?? []))
    if (Number.isFinite(animation?.start) && Number.isFinite(animation?.duration)) end = Math.max(end, animation.start + animation.duration);
  return Math.round((end - start) * 100) / 100;
}

/** The piece for a clipboard envelope. `canvas` is the size of the scene it was saved from. */
export function buildPiece({ name, description = "", envelope, canvas }) {
  const kind = envelope.kind === "scene" ? "scene" : "layers";
  const parts = partsOf(envelope);
  const layers = Array.isArray(parts?.layers) ? parts.layers : [];
  const rootIds = new Set(Array.isArray(parts?.roots) ? parts.roots.map((root) => root.id) : []);
  return {
    format: PIECE_FORMAT,
    version: PIECE_VERSION,
    name,
    description: String(description ?? "").slice(0, 300),
    kind,
    envelope,
    canvas: kind === "scene" ? { width: envelope.scene.width, height: envelope.scene.height } : canvas,
    length: kind === "scene" ? Number(envelope.scene.duration) || 0 : layersLength(layers),
    layerNames: layers.filter((layer) => rootIds.has(layer.id)).map((layer) => layer.name).slice(0, 12),
    layerCount: layers.length,
    media: pieceMedia(envelope),
  };
}

/** One short line for list: name, what it holds, size, length, layer count, what it needs. */
export function pieceLine(piece) {
  const fonts = piece.media.filter((item) => item.type === "font").length;
  const files = piece.media.length - fonts;
  const tail = `${piece.canvas?.width}x${piece.canvas?.height}, ${piece.length}s, ${piece.layerCount} layer${piece.layerCount === 1 ? "" : "s"}, needs ${fonts} font${fonts === 1 ? "" : "s"} and ${files} media`;
  const holds = piece.kind === "scene" ? "scene" : `layers ${piece.layerNames.join(", ")}`;
  const head = `${piece.name} (${holds})`;
  const room = 118 - tail.length - 2;
  return `${head.length > room ? `${head.slice(0, Math.max(8, room - 3))}...` : head}: ${tail}`;
}

/**
 * Checks a piece that came from outside (an imported file): its shape, then a trial paste into a
 * scratch file, which runs the clipboard's own validation. Returns the piece in the form kino
 * keeps. Throws a sentence saying what is wrong. Nothing in it is ever run.
 */
export function checkPiece(value) {
  if (!isRecord(value) || value.format !== PIECE_FORMAT) throw new Error("This is not a kino piece file: piece.json does not say kino.piece.");
  if (value.version !== PIECE_VERSION) throw new Error(`This piece file is version ${String(value.version)}; this kino reads version ${PIECE_VERSION}.`);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > PIECE_NAME_MAX) throw new Error(`The piece's name must be 1 to ${PIECE_NAME_MAX} characters.`);
  if (value.kind !== "layers" && value.kind !== "scene") throw new Error('The piece\'s kind must be "layers" or "scene".');
  if (!isRecord(value.envelope) || value.envelope.format !== "kino.clipboard" || value.envelope.kind !== value.kind)
    throw new Error("The piece holds no kino clipboard data of its kind.");
  try { trialPaste(value.envelope); }
  catch (error) { throw new Error(`The piece's contents are not valid: ${error.message}`); }
  const piece = buildPiece({
    name, description: value.description, envelope: value.envelope,
    canvas: isRecord(value.canvas) && Number.isFinite(value.canvas.width) && Number.isFinite(value.canvas.height)
      ? { width: value.canvas.width, height: value.canvas.height } : { width: 1920, height: 1080 },
  });
  return piece;
}

// Pastes the envelope into a scratch file, so the same checks as a real paste run.
function trialPaste(envelope) {
  const scene = createScene({ id: "piece-check" });
  const scratch = parseDocument(createDocument({ id: "piece-check", name: "check", scenes: [scene] }));
  if (envelope.kind === "scene") pasteScene(scratch, scratch.scenes[0].id, envelope);
  else pasteLayers(scratch, scratch.scenes[0].id, envelope);
}
