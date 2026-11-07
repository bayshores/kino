// Draws the live picture's tilted layers on the GPU (render.js liveTiltTag marks them in canvas
// mode). Each one's flat drawing, kept out of sight in the SVG, becomes a bitmap once (again only
// when the drawing changes), and one quad draws it with the exact perspective: the GPU is given
// each corner's depth, so it maps the bitmap across the plane as the 3D math does (tilt.js).
// The export keeps its own way (triangles, desktop/raster-page.cjs flattenTilts).

// Bitmap pixels per screen pixel, so text on the near edge stays sharp; mipmaps keep the far edge smooth.
const OVERSAMPLE = 2;
const MAX_PIXELS = 16 * 1024 * 1024;
const KEPT_BITMAPS = 4;
const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink";

const bitmaps = new Map();
const states = new Map();

/**
 * The visible part as triangles for the GPU: from "x y h u v ..." (render.js liveTiltTag: x y in
 * a `width` x `height` box, h the depth, u v on the plane) and the bitmap's box on the plane
 * [x, y, width, height], a flat list of x y h s t per vertex (x y in clip space, s t in the
 * bitmap, 0 to 1), the polygon cut into a fan. Null when the numbers are unusable.
 */
export function tiltFan(points, width, height, region) {
  const values = String(points).trim().split(/\s+/).map(Number);
  if (values.length < 15 || values.length % 5 || !values.every(Number.isFinite) || !(width > 0) || !(height > 0) || !(region[2] > 0) || !(region[3] > 0)) return null;
  const corners = [];
  for (let index = 0; index < values.length; index += 5) {
    const [x, y, h, u, v] = values.slice(index, index + 5);
    corners.push([(x / width) * 2 - 1, 1 - (y / height) * 2, h, (u - region[0]) / region[2], (v - region[1]) / region[3]]);
  }
  const fan = [];
  for (let index = 1; index + 1 < corners.length; index += 1) fan.push(...corners[0], ...corners[index], ...corners[index + 1]);
  return fan;
}

/** The bitmap's scale: OVERSAMPLE times the most screen pixels one unit reaches, in quarter steps, within MAX_PIXELS. */
export function tiltBitmapScale(reach, screenScale, width, height, most = MAX_PIXELS) {
  let scale = Math.ceil(reach * screenScale * OVERSAMPLE * 4) / 4;
  if (width * height * scale * scale > most) scale = Math.sqrt(most / (width * height));
  return scale > 0 && Number.isFinite(scale) ? scale : 0;
}

function referencedIds(markup) {
  const ids = new Set();
  for (const match of markup.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) ids.add(match[1]);
  for (const match of markup.matchAll(/href="#([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

// The flat drawing as a standalone SVG picture, with the definitions it uses.
function flatSvg(source, plane, pixels) {
  const serializer = new XMLSerializer();
  const content = serializer.serializeToString(source.firstElementChild ?? source);
  const document = source.ownerDocument;
  const wanted = [...referencedIds(content)], seen = new Set(), defs = [];
  while (wanted.length) {
    const id = wanted.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const element = document.getElementById(id);
    if (!element || source.contains(element)) continue;
    const markup = serializer.serializeToString(element);
    defs.push(markup);
    wanted.push(...referencedIds(markup));
  }
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="${pixels[0]}" height="${pixels[1]}" viewBox="${plane.join(" ")}" preserveAspectRatio="none"><defs>${defs.join("")}</defs>${content}</svg>`;
}

function bitmapFor(key, makeSvg) {
  if (bitmaps.has(key)) {
    const kept = bitmaps.get(key);
    bitmaps.delete(key);
    bitmaps.set(key, kept);
    return kept;
  }
  const link = URL.createObjectURL(new Blob([makeSvg()], { type: "image/svg+xml" }));
  const image = new Image();
  image.src = link;
  // An ImageBitmap, closed when it leaves the cache: its pixels go at once instead of waiting
  // for garbage collection (a changing page of code makes a new one most frames).
  // The decoded SVG document behind the Image (thousands of paths) is let go at once too.
  const loaded = image.decode().then(() => createImageBitmap(image)).finally(() => { URL.revokeObjectURL(link); image.removeAttribute("src"); });
  loaded.catch(() => bitmaps.delete(key));
  bitmaps.set(key, loaded);
  while (bitmaps.size > KEPT_BITMAPS) {
    const [oldest, gone] = bitmaps.entries().next().value;
    bitmaps.delete(oldest);
    gone.then((bitmap) => bitmap.close(), () => {});
  }
  return loaded;
}

const VERTEX = `#version 300 es
in vec3 corner; in vec2 at; out vec2 uv;
void main() { uv = at; gl_Position = vec4(corner.xy * corner.z, 0.0, corner.z); }`;
const FRAGMENT = `#version 300 es
precision highp float; uniform sampler2D picture; in vec2 uv; out vec4 color;
void main() { color = texture(picture, uv); }`;

function setUp(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true, alpha: true });
  if (!gl) return null;
  const shader = (type, text) => { const made = gl.createShader(type); gl.shaderSource(made, text); gl.compileShader(made); return made; };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
  canvas.addEventListener("webglcontextlost", () => states.delete(canvas), { once: true });
  return { gl, program, buffer, texture, anisotropy, key: null, pending: null };
}

function paint(canvas, state, fan) {
  const { gl, program, buffer } = state;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!state.key || !fan) return;
  const data = new Float32Array(fan);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner"), at = gl.getAttribLocation(program, "at");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 20, 12);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.drawArrays(gl.TRIANGLES, 0, fan.length / 5);
}

function upload(state, image) {
  const { gl, texture, anisotropy } = state;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
}

function drawTilt(canvas) {
  const frame = canvas.parentElement;
  const matrix = frame?.getScreenCTM?.();
  const source = canvas.ownerDocument.getElementById(canvas.dataset.kinoTilt);
  if (!matrix || !source) return;
  const ratio = globalThis.devicePixelRatio || 1;
  const screenScale = Math.hypot(matrix.a, matrix.b) * ratio;
  const width = frame.width.baseVal.value, height = frame.height.baseVal.value;
  const pixels = [Math.max(1, Math.round(width * screenScale)), Math.max(1, Math.round(height * screenScale))];
  if (canvas.width !== pixels[0]) canvas.width = pixels[0];
  if (canvas.height !== pixels[1]) canvas.height = pixels[1];
  let state = states.get(canvas);
  if (!state) {
    state = setUp(canvas);
    if (!state) return;
    states.set(canvas, state);
  }
  const plane = canvas.dataset.kinoTiltPlane.split(" ").map(Number);
  const limit = state.gl.getParameter(state.gl.MAX_TEXTURE_SIZE);
  let scale = tiltBitmapScale(Number(canvas.dataset.kinoTiltReach), screenScale, plane[2], plane[3]);
  scale = Math.min(scale, limit / plane[2], limit / plane[3]);
  const size = [Math.max(1, Math.ceil(plane[2] * scale)), Math.max(1, Math.ceil(plane[3] * scale))];
  const key = `${canvas.dataset.kinoTiltKey}@${plane.join(" ")}@${size.join("x")}`;
  // One bitmap at a time: while one is made, the frames go on with the last one, and the newest
  // drawing is made next (a page whose lines fade changes every frame).
  if (state.key !== key && !state.pending) {
    state.pending = key;
    bitmapFor(key, () => flatSvg(source, plane, size)).then((bitmap) => {
      state.pending = null;
      if (states.get(canvas) !== state || !bitmap.width) return;
      upload(state, bitmap);
      state.key = key;
      state.region = plane;
      if (canvas.isConnected) drawTilt(canvas);
    }, () => { state.pending = null; });
  }
  // Mapped onto the bitmap on screen, which may be the one before (made for another box) for a frame or two.
  paint(canvas, state, state.region && tiltFan(canvas.dataset.kinoTiltPoints, width, height, state.region));
}

/** Draws every live tilted layer in `container`; frees the GPU contexts of ones no longer shown. */
export function drawLiveTilts(container) {
  for (const [canvas, state] of states) {
    if (canvas.isConnected) continue;
    states.delete(canvas);
    state.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  for (const canvas of container?.querySelectorAll?.("canvas[data-kino-tilt]") ?? []) drawTilt(canvas);
}
