// Tiny .glb models for tests, made in memory: a unit cube (red, or with an embedded 2x2 PNG
// texture), plus variants that name an extension or an outside file for the refusal tests.
import { createCanvas } from "@napi-rs/canvas";

// The 6 faces of a cube from -0.5 to 0.5: 4 corners each, with the face's normal and UVs.
function cubeArrays() {
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  faces.forEach(([normal, right, up], face) => {
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(...normal.map((n, axis) => n * 0.5 + right[axis] * (u - 0.5) + up[axis] * (v - 0.5)));
      normals.push(...normal);
      uvs.push(u, 1 - v);
    }
    const base = face * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

const pad4 = (buffer, fill = 0) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)]);

/**
 * A cube .glb. `color`: [r, g, b] 0..1 base color. `texture`: a CSS color for an embedded 2x2 PNG
 * (the base color then is white). `extensionsRequired` and `externalUri` make a model kino refuses.
 */
export function makeGlb({ color = [1, 0, 0], texture = null, extensionsRequired = null, externalUri = null } = {}) {
  const { positions, normals, uvs, indices } = cubeArrays();
  const parts = [];
  let offset = 0;
  const views = [];
  const add = (bytes, target) => {
    const buffer = pad4(Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length));
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength ?? bytes.length, ...(target ? { target } : {}) });
    parts.push(buffer);
    offset += buffer.length;
    return views.length - 1;
  };
  const position = add(positions, 34962), normal = add(normals, 34962), uv = add(uvs, 34962), index = add(indices, 34963);
  const json = {
    asset: { version: "2.0", generator: "kino test" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: position, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: normal, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: uv, componentType: 5126, count: 24, type: "VEC2" },
      { bufferView: index, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: texture ? [1, 1, 1, 1] : [...color, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  };
  if (texture) {
    const canvas = createCanvas(2, 2);
    const context = canvas.getContext("2d");
    context.fillStyle = texture;
    context.fillRect(0, 0, 2, 2);
    const png = add(canvas.toBuffer("image/png"));
    json.images = [{ bufferView: png, mimeType: "image/png" }];
    json.samplers = [{ magFilter: 9728, minFilter: 9728 }];
    json.textures = [{ source: 0, sampler: 0 }];
    json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  if (extensionsRequired) json.extensionsRequired = json.extensionsUsed = extensionsRequired;
  const binary = Buffer.concat(parts);
  json.bufferViews = views;
  json.buffers = [{ byteLength: binary.length, ...(externalUri ? { uri: externalUri } : {}) }];
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const header = Buffer.alloc(12);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([chunk("JSON", jsonChunk), ...(externalUri ? [] : [chunk("BIN\u0000", binary)])]);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A 3D module: the model input `model`, lit, turned by frame.progress, drawn with three. */
export const CUBE_SCRIPT = `import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export default async function setup(layer) {
  const renderer = new THREE.WebGLRenderer({ canvas: layer.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(layer.pixelRatio);
  renderer.setSize(layer.width, layer.height, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 3, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, layer.width / layer.height, 0.1, 100);
  camera.position.set(0, 0, 4);
  const gltf = await new GLTFLoader().parseAsync(layer.models.model, "");
  const model = gltf.scene;
  scene.add(model);
  return function draw(frame) {
    model.rotation.set(0.4, frame.progress * Math.PI * 2, 0);
    renderer.render(scene, camera);
  };
}
`;
