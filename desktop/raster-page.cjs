// The page side of the export worker (desktop/raster-worker.cjs loads this file as its page's
// preload). The worker sends each frame here as an IPC message, {id, svg, marker}; this file checks
// the SVG, puts it in the page, waits until Chromium can draw it, and answers {id, rendererKB}
// (the renderer's memory) or {id, error}.
//
// Why a message: the worker used to paint by running executeJavaScript with the whole SVG written
// into the script's source, and Chromium kept every such source. The renderer then grew by 2 to 4
// MB for each MB of SVG sent (70 MB a frame on the busiest part of a 1080x1920 final render of a
// project full of video: 583 MB to 2,693 MB over 30 frames), until the Mac ran out of memory. A
// message's text is freed once it is used.
//
// The page has no script of its own (its Content-Security-Policy refuses scripts); this preload
// runs in Electron's isolated world, which shares the page's document.
const { ipcRenderer } = require("electron");

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const ACTIVE = new Set(["script", "foreignobject", "iframe", "object", "embed", "animate", "animatemotion", "animatetransform", "set", "audio", "video"]);
const RASTER_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;
// A picture file of this export, which the worker reads from the export's folder
// (raster-worker.cjs, mediaResponse). backend/chromium-raster.mjs makes these links.
const MEDIA_LINK = /^kino-frame:\/\/media\//i;
const PICTURE_TIMEOUT = 8000;

// Only references to this SVG's own elements (url(#id)) may appear in styles.
function localReferences(value) {
  const rest = value.replace(/url\(\s*(?:"#[^"]*"|'#[^']*'|#[^)]*)\s*\)/gi, "");
  if (/@import|url\s*\(/i.test(rest)) throw new Error("External export styles are unavailable.");
}

function checkedSvg(markup) {
  if (/<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error("SVG declarations are unavailable in exports.");
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  if (parsed.querySelector("parsererror") || svg.localName !== "svg" || svg.namespaceURI !== SVG_NAMESPACE)
    throw new Error("Generated SVG did not parse.");
  for (const element of parsed.querySelectorAll("*")) {
    if (ACTIVE.has(element.localName.toLowerCase())) throw new Error("Active content is unavailable in export SVG.");
    for (const attribute of element.attributes) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on")) throw new Error("SVG event handlers are unavailable in exports.");
      if (name === "href" && attribute.value && !attribute.value.startsWith("#") &&
          !RASTER_DATA.test(attribute.value) && !MEDIA_LINK.test(attribute.value))
        throw new Error("Export images must be embedded raster data or pictures of this export.");
      localReferences(attribute.value);
    }
  }
  const styles = [...parsed.querySelectorAll("style")].map(node => node.textContent).join(" ") +
    [...parsed.querySelectorAll("[style]")].map(node => node.getAttribute("style")).join(" ");
  localReferences(styles);
  return { parsed, svg };
}

const hrefOf = element => element.getAttribute("href") || element.getAttributeNS(XLINK_NAMESPACE, "href") || "";

// Loads each picture once before the SVG goes into the page, so the capture never shows a
// picture that is still loading. Answers the loaded Image objects.
function loadPictures(parsed) {
  const sources = new Set([...parsed.querySelectorAll("image,feImage")].map(hrefOf)
    .filter(value => RASTER_DATA.test(value) || MEDIA_LINK.test(value)));
  return Promise.all([...sources].map(src => new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => reject(new Error("An export image did not load in time.")), PICTURE_TIMEOUT);
    image.onload = () => { clearTimeout(timeout); resolve(image); };
    image.onerror = () => { clearTimeout(timeout); reject(new Error("An export image could not be loaded or decoded.")); };
    image.src = src;
  })));
}

// Each paint asks for its linked pictures under links of its own: kino-frame://media/<file>?paint=<id>
// (the worker answers the same file). Chromium keeps a decoded copy of each picture it draws and,
// when the same picture comes back drawn at another size, may draw it from that copy, which gives a
// little different pixels than a first drawing. So with one link for every paint, a frame's pixels
// depended on what the worker had drawn before and on when Chromium dropped those copies, and each
// of several workers draws other frames before a given one. On a 192x108 test of a JPEG shown at
// changing sizes with zoom blur, inward echoes and radial repeat blur, 3 workers gave 14 of 16
// frames up to 48 levels away from 1 worker, in 4 of 4 runs (raster-workers.test.mjs).
// A new link is a new picture to Chromium, decoded for this paint alone: the same test then gave
// 1 worker's pixels with 2, 3 and 4 workers, in 12 of 12 runs on a quiet computer (paintSvg below
// handles a busy one). Pictures still sent as data: URLs (an effect's own pictures under 16 KB, and
// feImage pictures; backend/export.mjs) keep one URL.
function paintLinks(parsed, id) {
  for (const element of parsed.querySelectorAll("image,feImage")) {
    for (const attribute of element.attributes) {
      if (attribute.localName.toLowerCase() === "href" && MEDIA_LINK.test(attribute.value))
        attribute.value = `${attribute.value.split("?")[0]}?paint=${id}`;
    }
  }
}

// Resolves once every <image> of `node` that links to a picture file has fired its load event.
function linkedImagesLoaded(node) {
  return Promise.all([...node.querySelectorAll("image")].filter(element => MEDIA_LINK.test(hrefOf(element)))
    .map(element => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("An export image did not load in time.")), PICTURE_TIMEOUT);
      element.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
      element.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("An export image could not be loaded or decoded.")); }, { once: true });
    })));
}

// Linked pictures need two more steps than data: URLs to come out the same every time.
// A data: URL picture is in the page as soon as its <image> is. A linked one (the worker answers it
// with "no-store") is in Chromium's memory cache only while something still uses it: Blink drops a
// no-store resource as soon as its last user goes (blink Resource::DidRemoveClientOrObserver). An
// <image> that finds its picture there shows it at once; one that does not loads it again and
// shows it a moment later. On a test edit's frames 300-372, painted 4 times each, 1 to 7 of the 292 frames
// came out a little different from the data: URL frames in each run: capturing the same frame again
// 20-650 ms later gave the data: URL pixels every time (the redraw came about 40 ms later).
// So the page keeps the frame's loaded pictures (until the next frame's are loaded), so that its
// <image> elements and their <use> copies find them, and waits for each linked <image> to load
// before the two animation frames below. With both, 0 of 292 frames differed (and 0 of 292 with the
// wait alone), and the frames took no longer.
let shownPictures = [];

// A tilted layer (engine/render.js, tiltedTag) is drawn as up to a few thousand triangles, each
// filled with a <use> of the layer's whole flat drawing. Chromium makes a full copy of what a <use>
// points to, so a tilted page of code (about 4,000 glyph paths, 2,048 triangles) became millions of
// elements: frames of a product trailer took over 45 s and the worker grew to 2.8 GB. So the page
// draws each such drawing once, as vector, into a bitmap at OVERSAMPLE times the most output pixels
// one of its units reaches (data-kino-flatten), and the triangles share that one picture. A drawing
// that links pictures of the export (kino-frame://) keeps the old way, since a picture drawn from an
// SVG file cannot load links. The last few bitmaps are kept by their SVG text, so frames where the
// flat drawing does not change (only the tilt moves) skip the drawing.
const OVERSAMPLE = 2;
const FLAT_PIXELS = 48 * 1024 * 1024;
// A draft frame (check and look frames, a few hundred pixels wide) caps the bitmap at 16 times
// its own pixels (at least 1 megapixel) and never falls back to vector. A tilt reaching far toward
// the viewer asked for a 48 megapixel bitmap on 64 px check frames of a product trailer: about 0.5 s
// to draw each time the drawing changed, and a garbage collection on every frame after.
const DRAFT_FLAT_FACTOR = 16;
const DRAFT_FLAT_MIN = 1024 * 1024;
const flatBitmaps = new Map();

function referencedIds(markup) {
  const ids = new Set();
  for (const match of markup.matchAll(/url\(\s*["']?#([^"')\s]+)/g)) ids.add(match[1]);
  for (const match of markup.matchAll(/href="#([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

async function flatBitmap(svgText, width, height) {
  const key = `${width}x${height}\0${svgText}`;
  if (flatBitmaps.has(key)) {
    const picture = flatBitmaps.get(key);
    flatBitmaps.delete(key);
    flatBitmaps.set(key, picture);
    return picture;
  }
  const link = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = link;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    // toDataURL, not toBlob: Chromium encodes a toBlob in the page's idle time, and this hidden
    // page got none for about 7 s a frame.
    const picture = canvas.toDataURL("image/png");
    flatBitmaps.set(key, picture);
    while (flatBitmaps.size > 3) flatBitmaps.delete(flatBitmaps.keys().next().value);
    return picture;
  } finally {
    URL.revokeObjectURL(link);
  }
}

async function flattenTilts(parsed, draft = false) {
  const root = parsed.documentElement;
  const limit = draft ? Math.min(FLAT_PIXELS, Math.max(DRAFT_FLAT_MIN, DRAFT_FLAT_FACTOR * Number(root.getAttribute("width")) * Number(root.getAttribute("height")) || 0)) : FLAT_PIXELS;
  const serializer = new XMLSerializer();
  // Inner ones first, so an outer drawing holds the inner one's picture... unless it is a link,
  // which a picture drawn from an SVG file cannot load: then the outer one keeps the old way.
  for (const source of [...parsed.querySelectorAll("[data-kino-flatten]")].reverse()) {
    // Already in output pixels: render.js counts the export's size in (its rasterScale).
    const reach = Number(source.getAttribute("data-kino-flatten"));
    const [x, y, width, height] = (source.getAttribute("data-kino-box") || "").split(" ").map(Number);
    source.removeAttribute("data-kino-flatten");
    source.removeAttribute("data-kino-box");
    if (!(reach > 0) || ![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) continue;
    if ([...source.querySelectorAll("image,feImage")].some((element) => !hrefOf(element).startsWith("data:"))) continue;
    // Up to the next quarter step, so frames where only the tilt moves share one bitmap.
    let scale = Math.ceil(reach * OVERSAMPLE * 4) / 4;
    if (width * height * scale * scale > limit) scale = Math.sqrt(limit / (width * height));
    // Never fewer pixels than the output shows (a draft accepts it): then the vector way is kept.
    if (scale < reach && !draft) continue;
    const content = serializer.serializeToString(source.firstElementChild ?? source);
    // The definitions it uses (gradients, clips, masks, filters), and the ones those use.
    const wanted = [...referencedIds(content)], seen = new Set(), defs = [];
    while (wanted.length) {
      const id = wanted.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const element = parsed.getElementById(id);
      if (!element || source.contains(element)) continue;
      const markup = serializer.serializeToString(element);
      defs.push(markup);
      wanted.push(...referencedIds(markup));
    }
    const pixels = [Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale))];
    const svgText = `<svg xmlns="${SVG_NAMESPACE}" xmlns:xlink="${XLINK_NAMESPACE}" width="${pixels[0]}" height="${pixels[1]}" viewBox="${x} ${y} ${width} ${height}" preserveAspectRatio="none"><defs>${defs.join("")}</defs>${content}</svg>`;
    const link = await flatBitmap(svgText, ...pixels);
    // Its pixels (the canvas, the PNG text, the decoded picture) count toward the next collection.
    sinceCollect += pixels[0] * pixels[1] * 4;
    const image = parsed.createElementNS(SVG_NAMESPACE, "image");
    for (const [name, value] of [["x", x], ["y", y], ["width", width], ["height", height], ["preserveAspectRatio", "none"], ["href", link], ["data-kino-flat", ""]]) image.setAttribute(name, String(value));
    source.replaceChildren(image);
  }
}

// Resolves once every flattened tilt picture of `node` has loaded.
function flatImagesLoaded(node) {
  return Promise.all([...node.querySelectorAll("image[data-kino-flat]")]
    .map(element => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("A tilted layer's picture did not load in time.")), PICTURE_TIMEOUT);
      element.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
      element.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("A tilted layer's picture could not be loaded.")); }, { once: true });
    })));
}

// The text of the frames already drawn stays in the renderer until Chromium collects garbage, and
// pictures, not text, are what usually make it do that. 400 frames of 2 MB SVG with no pictures
// grew the renderer to 249 MB before its first collection (frame 55) and to 1,159 MB before its
// second (frame 332). So the page collects garbage itself (desktop/raster-worker.cjs turns on
// V8's gc function) after every COLLECT_AFTER of SVG text, just before it parses the next frame:
// the same 400 frames then stayed between 27 and 92 MB.
// The pictures of earlier paints (each paint loads its own, paintLinks) also stay until a
// collection frees the Image objects that hold them, and an Image is too small for V8 to hurry.
// One 900x600 picture painted 400 times grew the renderer's highest point every 100 paints
// (67, 88, 109, 122 MB), so their pixels (width x height x 4 bytes) count toward COLLECT_AFTER too.
const COLLECT_AFTER = 32 * 1024 * 1024;
let sinceCollect = 0;

// A new frame stays hidden until its pictures and fonts are ready, and shows in the same step as
// the marker. Before, the frame was in view while its <image> elements waited for their load
// events, and a busy computer sometimes drew it then. The finished frame then came out a little
// differently than when there was no early drawing (most likely it was drawn from the pictures that
// early drawing decoded; paintLinks says why that can differ):
// - forcing an early frame (EARLY_FRAME below) gave the first SVG of the JPEG test in
//   backend/raster-workers.test.mjs other pixels in 6 of 6 paints, and its usual pixels in 6 of 6
//   paints once the frame was hidden until ready;
// - 4 copies of that test at once (3 workers, 30 runs each) had runs with a differing frame in 7 of
//   120 runs (8 frames, up to 17 levels of 255) before, and in 0 of 120 after.
// A hidden frame is still laid out, so its fonts load; an early frame now draws an empty page (all
// but an element that sets visibility: visible itself, as a part of a color emoji may).
// For tests only: KINO_RASTER_TEST_EARLY_FRAME=1 waits two animation frames while the pictures
// load, so the early drawing happens every time.
const EARLY_FRAME = process.env.KINO_RASTER_TEST_EARLY_FRAME === "1";

async function paintSvg(markup, marker, id, draft = false) {
  if (typeof markup !== "string") throw new Error("The frame SVG must be text.");
  sinceCollect += markup.length;
  if (sinceCollect > COLLECT_AFTER && typeof gc === "function") {
    sinceCollect = 0;
    gc(); // eslint-disable-line no-undef
  }
  if (!Number.isInteger(marker) || marker < 0 || marker > 255) throw new Error("The frame marker must be a byte.");
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("The frame request number must be a whole number.");
  const { parsed, svg } = checkedSvg(markup);
  paintLinks(parsed, id);
  const pictures = await loadPictures(parsed);
  for (const picture of pictures) sinceCollect += picture.naturalWidth * picture.naturalHeight * 4;
  await flattenTilts(parsed, draft === true);
  const node = document.importNode(svg, true);
  const loaded = Promise.all([linkedImagesLoaded(node), flatImagesLoaded(node)]);
  const root = document.getElementById("root");
  root.style.visibility = "hidden";
  root.replaceChildren(node);
  shownPictures = pictures;
  if (EARLY_FRAME) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await loaded;
  await document.fonts.ready;
  root.style.visibility = "";
  // The grey row under the picture tells the worker's capture which request it shows.
  document.getElementById("kino-frame").style.backgroundColor = `rgb(${marker},${marker},${marker})`;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

ipcRenderer.on("kino:paint", async (_event, frame) => {
  const id = frame?.id;
  try {
    await paintSvg(frame?.svg, frame?.marker, id, frame?.draft);
    // The renderer's private memory footprint in KB (on a Mac, what Activity Monitor shows).
    const memory = await process.getProcessMemoryInfo();
    ipcRenderer.send("kino:painted", { id, rendererKB: Math.round(memory.private) });
  } catch (error) {
    ipcRenderer.send("kino:painted", { id, error: String(error?.message || "Chromium could not paint the export frame.").slice(0, 500) });
  }
});
