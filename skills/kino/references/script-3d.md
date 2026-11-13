# 3D models in script layers

Contents: Import a model, The module, Example, What does not work.

A script layer (the script-layers reference) can draw a 3D model with the bundled 3D library (`three`,
MIT license). Everything runs offline: nothing is fetched, the library ships with kino.

## Import a model

`project import /absolute/path/model.glb` gives a `src` such as `/api/media/<id>.glb`. A model is
at most 64 MB. Declare it as a `model` input and set its value to that `src`:
`inputs:[{key:"model", type:"model"}], values:{model:"/api/media/<id>.glb"}`.

## The module

- The only imports a script may have, written exactly like this:
  `import * as THREE from "three";` and
  `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";`
- The model's bytes are an `ArrayBuffer` in `layer.models.<key>` (at setup) and
  `frame.values.<key>` (each draw). Parse it once in setup with
  `await new GLTFLoader().parseAsync(layer.models.model, "")`.
- Make the renderer on `layer.canvas` with `preserveDrawingBuffer: true` and `alpha: true`, call
  `renderer.setSize(layer.width, layer.height, false)` and `renderer.setPixelRatio(layer.pixelRatio)`.
- Animate from `frame.time` or `frame.progress` (or an animated number input), never from the
  library's own clock or an animation loop: `requestAnimationFrame` throws in a script layer.
- Call `renderer.render(scene, camera)` at the end of every draw.

## Example: a model that turns once

```js
import * as THREE from "three";
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
```

```json
{"op":"add_layer","layerType":"script","name":"cube","properties":{"x":560,"y":140,"width":800,"height":800,"script":"import * as THREE from \"three\";\nimport { GLTFLoader } from \"three/addons/loaders/GLTFLoader.js\";\n\nexport default async function setup(layer) {\n  const renderer = new THREE.WebGLRenderer({ canvas: layer.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });\n  renderer.setPixelRatio(layer.pixelRatio);\n  renderer.setSize(layer.width, layer.height, false);\n  const scene = new THREE.Scene();\n  scene.add(new THREE.AmbientLight(0xffffff, 1.5));\n  const sun = new THREE.DirectionalLight(0xffffff, 2);\n  sun.position.set(2, 3, 4);\n  scene.add(sun);\n  const camera = new THREE.PerspectiveCamera(35, layer.width / layer.height, 0.1, 100);\n  camera.position.set(0, 0, 4);\n  const gltf = await new GLTFLoader().parseAsync(layer.models.model, \"\");\n  const model = gltf.scene;\n  scene.add(model);\n  return function draw(frame) {\n    model.rotation.set(0.4, frame.progress * Math.PI * 2, 0);\n    renderer.render(scene, camera);\n  };\n}\n","inputs":[{"key":"model","type":"model"}],"values":{"model":"/api/media/<id>.glb"}}}
```

Replace `<id>.glb` with the `src` the import gave. A model far from 1 unit across needs the
camera moved (or `model.scale` set).

## What does not work

- A `.gltf` with separate `.bin` or texture files, Draco or meshopt compression, and KTX2
  textures: the import refuses them. Export one self-contained `.glb` (textures embedded, no
  compression) and import that.
- Any other import, a URL import or `import()`: refused at save. Put other code in the module.
