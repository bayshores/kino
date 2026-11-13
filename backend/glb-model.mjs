// Checks a .glb model file (binary glTF 2.0) at import, before kino keeps it: a script layer's
// model input hands these bytes to the 3D library inside a frame with no network, so a model that
// needs another file or a decoder kino does not ship is refused here with the cause and the fix.
// Only the header and the JSON chunk are read; the geometry itself is not checked.

/** The largest model kino imports: 64 MB. The renderer takes images and models up to 68 MB together. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
export const MODEL_MIME = "model/gltf-binary";

const FIX = "export the model again as one self-contained .glb (textures embedded, no Draco or meshopt compression, no KTX2 textures)";
// Extensions that need a decoder the library loads from elsewhere (none is shipped).
const NEEDS_DECODER = {
  KHR_draco_mesh_compression: "Draco mesh compression",
  EXT_meshopt_compression: "meshopt compression",
  KHR_meshopt_compression: "meshopt compression",
  KHR_texture_basisu: "KTX2 (Basis) textures",
};

/**
 * Reads the model's facts, or throws one sentence saying why it can't be used.
 * Returns {meshes, nodes, materials, images, animations}.
 */
export function checkGlbModel(bytes) {
  const data = Buffer.from(bytes ?? []);
  if (data.length > MAX_MODEL_BYTES)
    throw new Error(`This model is ${Math.ceil(data.length / 1024 / 1024)} MB; a model may be at most 64 MB. Simplify it or shrink its textures.`);
  if (data.length < 20 || data.toString("latin1", 0, 4) !== "glTF")
    throw new Error(`This file is not a binary glTF model (.glb); ${FIX}.`);
  const version = data.readUInt32LE(4);
  if (version !== 2) throw new Error(`This .glb is glTF version ${version}; kino reads glTF 2.0, so ${FIX}.`);
  if (data.readUInt32LE(8) > data.length) throw new Error("This .glb is cut short: its header names more bytes than the file has.");
  const jsonLength = data.readUInt32LE(12);
  if (data.toString("latin1", 16, 20) !== "JSON" || 20 + jsonLength > data.length)
    throw new Error("This .glb has no readable JSON chunk; export it again.");
  let json;
  try { json = JSON.parse(data.toString("utf8", 20, 20 + jsonLength)); }
  catch { throw new Error("This .glb's JSON chunk can't be read; export it again."); }
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const decoder = required.find((name) => NEEDS_DECODER[name]);
  if (decoder) throw new Error(`This model uses ${NEEDS_DECODER[decoder]} (${decoder}), which needs a decoder kino does not ship; ${FIX}.`);
  const external = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((entry) => entry?.uri).find((uri) => typeof uri === "string" && !uri.startsWith("data:"));
  if (external) throw new Error(`This model points to another file (${String(external).slice(0, 80)}), which a script layer can't load; ${FIX}.`);
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  return { meshes: count(json.meshes), nodes: count(json.nodes), materials: count(json.materials), images: count(json.images), animations: count(json.animations) };
}

/** The sentence for a .gltf file: kino imports models only as one .glb file. */
export function gltfRefusal(text) {
  let json = null;
  try { json = JSON.parse(String(text)); } catch { /* the general sentence */ }
  const external = [...(json?.buffers ?? []), ...(json?.images ?? [])]
    .map((entry) => entry?.uri).find((uri) => typeof uri === "string" && !uri.startsWith("data:"));
  const cause = external ? `this .gltf points to other files (${String(external).slice(0, 80)}), which a script layer can't load` : "kino imports 3D models as one .glb file";
  return `${cause[0].toUpperCase()}${cause.slice(1)}; ${FIX}.`;
}
