import { IDENTITY, inverse, multiply, point } from "../geometry.js";

const MAX_SVG_COORDINATE = 1_000_000;
const COPY_ATTRIBUTES = new Set([
  "id",
  "data-layer-id",
  "data-component-owner",
  "data-component-path",
  "data-media-layer-id",
  "role",
  "aria-label",
  "tabindex",
]);

function escapeXmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

function attribute(name, value) {
  return `${name}="${escapeXmlAttribute(value)}"`;
}

function cssUrlEscape(value) {
  let escaped = "";
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (character === "\\" || character === "\"" || character === "'" || character === "(" || character === ")" ||
        character === "#" || character === "<" || character === ">" || codePoint <= 0x20 || codePoint === 0x7f)
      escaped += `\\${codePoint.toString(16)} `;
    else escaped += character;
  }
  return escaped;
}

function urlReference(id) {
  return `url(#${cssUrlEscape(id)})`;
}

function svgNumber(value) {
  return Object.is(value, -0) ? "0" : String(value);
}

function validateBounds(bounds, label = "Bounds") {
  if (!bounds || typeof bounds !== "object") throw new TypeError(`${label} must be an object.`);
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new RangeError(`${label} must have finite coordinates and positive width and height.`);
  if ([x, y, width, height].some((value) => Math.abs(value) > MAX_SVG_COORDINATE))
    throw new RangeError(`${label} must stay within ${MAX_SVG_COORDINATE} SVG units.`);
  if (Math.abs(x + width) > MAX_SVG_COORDINATE || Math.abs(y + height) > MAX_SVG_COORDINATE)
    throw new RangeError(`${label} extents must stay within ${MAX_SVG_COORDINATE} SVG units.`);
  return { x, y, width, height };
}

function validateFrame(frame, { helpers = true } = {}) {
  if (!frame || typeof frame !== "object") throw new TypeError("Effect frame must be an object.");
  if (typeof frame.content !== "string") throw new TypeError("Effect frame content must be an SVG string.");
  const bounds = validateBounds(frame.bounds, "Effect frame bounds");
  if (helpers) {
    if (!frame.helpers || typeof frame.helpers.id !== "function" || !Array.isArray(frame.helpers.defs))
      throw new TypeError("Effect frame helpers must provide id(kind) and a defs array.");
  }
  return { bounds, helpers: frame.helpers };
}

function idFor(frame, kind) {
  const id = frame.helpers.id(kind);
  // render.js hex-encodes the caller's instance prefix. A valid 128-character scene ID
  // alone can therefore exceed 256 characters before this effect's unique suffix.
  if (id === undefined || id === null || String(id).length === 0 || String(id).length > 4096)
    throw new TypeError("Effect helper IDs must be non-empty strings of at most 4096 characters.");
  return String(id);
}

function makeClip(frame, bounds) {
  const id = idFor(frame, "clip");
  const definition = `<clipPath ${attribute("id", id)} clipPathUnits="userSpaceOnUse"><rect ${attribute("x", svgNumber(bounds.x))} ${attribute("y", svgNumber(bounds.y))} ${attribute("width", svgNumber(bounds.width))} ${attribute("height", svgNumber(bounds.height))}/></clipPath>`;
  return { id, definition };
}

function clipWrapper(id, markup) {
  return `<g ${attribute("clip-path", urlReference(id))}>${markup}</g>`;
}

function filterPrimitives(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join("");
  throw new TypeError("Filter primitives must be an SVG string or an array of SVG strings.");
}

function decodeXmlAttribute(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" })[entity.toLowerCase()] ?? entity;
  });
}

function rejectLocalFeImage(markup) {
  for (const tag of markup.match(/<feImage\b[^>]*>/gi) ?? []) {
    const href = tag.match(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/i);
    const value = decodeXmlAttribute(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (value.startsWith("#") || /^url\(\s*#/.test(value))
      throw new RangeError("Filter effects cannot use feImage to reference a local SVG element.");
  }
}

export function filterEffect(frame, primitives, { padding = 0, contain = false } = {}) {
  const { bounds, helpers } = validateFrame(frame);
  if (!Number.isFinite(padding) || padding < 0 || padding > MAX_SVG_COORDINATE)
    throw new RangeError(`Filter padding must be between 0 and ${MAX_SVG_COORDINATE} SVG units.`);
  if (typeof contain !== "boolean") throw new TypeError("contain must be a boolean.");
  let body = filterPrimitives(primitives);
  rejectLocalFeImage(body);
  if (helpers.raster) {
    // resvg 2.6.2 returns its allocated source pixmap directly for SourceGraphic,
    // even when that pixmap's dimensions differ from the declared filter region.
    // Map/composite primitives allocate the declared size and can abort on this
    // mismatch, especially in a tightly cropped layer capture. feMerge draws
    // the source into an explicitly region-sized result before those operations.
    // It preserves premultiplied bytes, unlike an alpha multiplication workaround.
    const needsAlpha = /\b(?:in|in2)=(["'])SourceAlpha\1/.test(body);
    body = body.replace(/\b(in|in2)=(["'])(SourceGraphic|SourceAlpha)\2/g,
      (_match, name, quote, source) => `${name}=${quote}kino${source}${quote}`);
    let normalized = '<feMerge result="kinoSourceGraphic"><feMergeNode in="SourceGraphic"/></feMerge>';
    if (needsAlpha) normalized +=
      '<feColorMatrix in="kinoSourceGraphic" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="kinoSourceAlpha"/>' +
      // The first user primitive may omit `in`, which must still mean the
      // original colored source, rather than our intermediate alpha image.
      '<feMerge><feMergeNode in="kinoSourceGraphic"/></feMerge>';
    body = normalized + body;
  }
  const paintBounds = frame.paintBounds === undefined ? bounds : validateBounds(frame.paintBounds, "Effect paint bounds");
  const region = validateBounds({
    x: paintBounds.x - padding,
    y: paintBounds.y - padding,
    width: paintBounds.width + 2 * padding,
    height: paintBounds.height + 2 * padding,
  }, "Filter region");
  const filterId = idFor(frame, "filter");
  const definition = `<filter ${attribute("id", filterId)} ${attribute("x", svgNumber(region.x))} ${attribute("y", svgNumber(region.y))} ${attribute("width", svgNumber(region.width))} ${attribute("height", svgNumber(region.height))} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${body}</filter>`;
  let result = `<g ${attribute("filter", urlReference(filterId))}>${frame.content}</g>`;
  let clip;
  if (contain) {
    clip = makeClip(frame, bounds);
    result = clipWrapper(clip.id, `${helpers.clipSentinel?.() ?? ""}${result}`);
  }
  helpers.defs.push(definition);
  if (clip) helpers.defs.push(clip.definition);
  helpers.includeBounds?.(contain ? bounds : region);
  return result;
}

export function clipEffect(frame, markup, bounds = frame?.bounds) {
  const { helpers } = validateFrame(frame);
  if (typeof markup !== "string") throw new TypeError("Clipped markup must be an SVG string.");
  const clipBounds = validateBounds(bounds, "Clip bounds");
  const clip = makeClip(frame, clipBounds);
  helpers.defs.push(clip.definition);
  helpers.includeBounds?.(clipBounds);
  return clipWrapper(clip.id, `${helpers.clipSentinel?.() ?? ""}${markup}`);
}

function tagEnd(markup, start) {
  let quote = "";
  for (let index = start + 1; index < markup.length; index += 1) {
    const character = markup[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return markup.length;
}

function stripTagAttributes(tag) {
  const name = tag.match(/^<([A-Za-z_:][A-Za-z0-9_:.-]*)/);
  if (!name) return tag;
  let output = name[0], cursor = output.length;
  const tagEndAt = tag.length - (tag.endsWith(">") ? 1 : 0);
  while (cursor < tagEndAt) {
    const whitespaceStart = cursor;
    while (cursor < tagEndAt && /\s/.test(tag[cursor])) cursor += 1;
    if (cursor >= tagEndAt || tag[cursor] === "/") {
      output += tag.slice(whitespaceStart);
      return output;
    }
    const attributeStart = cursor;
    while (cursor < tagEndAt && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    if (cursor === attributeStart) {
      output += tag.slice(whitespaceStart, cursor + 1);
      cursor += 1;
      continue;
    }
    const attributeName = tag.slice(attributeStart, cursor).toLowerCase();
    while (cursor < tagEndAt && /\s/.test(tag[cursor])) cursor += 1;
    if (tag[cursor] === "=") {
      cursor += 1;
      while (cursor < tagEndAt && /\s/.test(tag[cursor])) cursor += 1;
      const quote = tag[cursor] === "\"" || tag[cursor] === "'" ? tag[cursor++] : "";
      if (quote) {
        while (cursor < tagEndAt && tag[cursor] !== quote) cursor += 1;
        if (cursor < tagEndAt) cursor += 1;
      } else {
        while (cursor < tagEndAt && !/[\s>]/.test(tag[cursor])) cursor += 1;
      }
    }
    if (!COPY_ATTRIBUTES.has(attributeName)) output += tag.slice(whitespaceStart, cursor);
  }
  return output + tag.slice(tagEndAt);
}

function stripCopyAttributes(markup) {
  let output = "", cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start < 0) return output + markup.slice(cursor);
    output += markup.slice(cursor, start);
    if (markup.startsWith("<!--", start)) {
      const end = markup.indexOf("-->", start + 4);
      if (end < 0) return output + markup.slice(start);
      output += markup.slice(start, end + 3);
      cursor = end + 3;
      continue;
    }
    if (markup.startsWith("<![CDATA[", start)) {
      const end = markup.indexOf("]]>", start + 9);
      if (end < 0) return output + markup.slice(start);
      output += markup.slice(start, end + 3);
      cursor = end + 3;
      continue;
    }
    const end = tagEnd(markup, start);
    const tag = markup.slice(start, end);
    output += tag.startsWith("</") || tag.startsWith("<!") || tag.startsWith("<?") ? tag : stripTagAttributes(tag);
    cursor = end;
  }
  return output;
}

export function copyContent(content) {
  if (typeof content !== "string") throw new TypeError("Copied content must be an SVG string.");
  return `<g aria-hidden="true" pointer-events="none">${stripCopyAttributes(content)}</g>`;
}

// Define the painted source once before repeating it. A stack of repeat effects should grow
// by its number of instances, not multiply the entire SVG string at every step. The definition
// is decorative and has no layer/ARIA/DOM IDs from the original content. `copiesEffect` keeps
// the one original semantic and hit-test source outside these <use> shadow trees.
//
// `home` (layer-local bounds of everything the source draws) starts the definition with an
// invisible rectangle of that size, and every see-through group inside (opacity, blend mode,
// filter, mask) that holds parts drawn on their own with one covering the same area. Chromium
// (Electron 44) gives a see-through copy one GPU layer only when each later part of it fits
// next to what came before; parts spread far apart instead became about 37 layers per copy,
// 64 copies ran out of tile memory, and missing tiles showed the copies underneath (Radial
// Repeat Blur lost most of its 64 copies, a 256-copy spin blur came out at a sixth of its
// brightness). Each part lands inside the home rectangle, so a copy stays one layer and is
// still drawn as vectors, as sharp as the layer itself at any output size. resvg (raster
// markup) needs no help and gets none.
export function copySource(frame, { home } = {}) {
  validateFrame(frame);
  const id = idFor(frame, "copy-source");
  let content = copyContent(frame.content), start = "";
  const box = home && !frame.helpers.raster ? homeBox(home) : null;
  if (box) {
    start = homeRectangle(box);
    content = withInnerHomes(content, box);
  }
  frame.helpers.defs.push(`<g ${attribute("id", id)}>${start}${content}</g>`);
  return `<use ${attribute("href", `#${id}`)} aria-hidden="true" pointer-events="none"/>`;
}

// The home bounds kept within the coordinates an SVG may use, or null when nothing is left.
function homeBox(home) {
  const { x, y, width, height } = home;
  if (![x, y, width, height].every(Number.isFinite)) throw new RangeError("Copy home bounds must be finite.");
  const left = Math.max(x, -MAX_SVG_COORDINATE), top = Math.max(y, -MAX_SVG_COORDINATE);
  const right = Math.min(x + width, MAX_SVG_COORDINATE), bottom = Math.min(y + height, MAX_SVG_COORDINATE);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function homeRectangle({ x, y, width, height }) {
  return `<rect ${attribute("x", svgNumber(x))} ${attribute("y", svgNumber(y))} ${attribute("width", svgNumber(width))} ${attribute("height", svgNumber(height))} fill="transparent" stroke="none" aria-hidden="true" pointer-events="none"/>`;
}

const SVG_NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

// An SVG transform attribute as one matrix [a b c d e f], or null when it cannot be read.
function transformMatrix(value) {
  let matrix = IDENTITY, rest = String(value);
  for (const [whole, name, list] of rest.matchAll(/([A-Za-z]+)\s*\(([^)]*)\)/g)) {
    rest = rest.replace(whole, "");
    const n = (list.match(SVG_NUMBER) ?? []).map(Number);
    const radians = (n[0] ?? 0) * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const [cx = 0, cy = 0] = n.slice(1);
    const next = {
      matrix: n.length === 6 ? n : null,
      translate: [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0],
      scale: [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0],
      rotate: [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy],
      skewX: [1, 0, Math.tan(radians), 1, 0, 0],
      skewY: [1, Math.tan(radians), 0, 1, 0, 0],
    }[name];
    if (!next || !next.every(Number.isFinite)) return null;
    matrix = multiply(matrix, next);
  }
  return /^[\s,]*$/.test(rest) ? matrix : null;
}

function tagAttributes(tag) {
  const attributes = new Map();
  for (const [, name, double, single] of tag.matchAll(/\s([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    attributes.set(name.toLowerCase(), decodeXmlAttribute(double ?? single));
  return attributes;
}

// Opacity, a blend mode, isolation, a filter or a mask: Chromium draws the group on its own.
function seeThroughGroup(attributes) {
  const opacity = attributes.get("opacity");
  if (opacity !== undefined && !(Number(opacity) >= 1)) return true;
  if ((attributes.get("filter") ?? "none") !== "none" || (attributes.get("mask") ?? "none") !== "none") return true;
  if ((attributes.get("mix-blend-mode") ?? "normal") !== "normal") return true;
  return /(?:^|;)\s*(?:opacity|filter|mask|mix-blend-mode(?!\s*:\s*normal\b)|isolation(?=\s*:\s*isolate\b))\s*:/i
    .test(attributes.get("style") ?? "");
}

// Elements whose content is not drawn where it stands, or not in the parent's coordinates.
const UNDRAWN = new Set(["defs", "mask", "clippath", "pattern", "filter", "symbol", "marker",
  "lineargradient", "radialgradient", "foreignobject", "svg", "switch", "text", "style", "script"]);

// Elements that start a new run of drawing in Chromium (their own transform, clip or effect, or
// content drawn from elsewhere). Shapes in one coordinate system with no effects of their own are
// drawn together and never split a copy.
const OWN_DRAWING = new Set(["use", "image", "foreignobject", "svg"]);
function startsOwnDrawing(name, attributes) {
  return OWN_DRAWING.has(name.toLowerCase()) || attributes.has("transform") || (attributes.get("clip-path") ?? "none") !== "none" ||
    seeThroughGroup(attributes);
}

// The home rectangle again inside each see-through group that holds parts drawn on their own, in
// that group's own coordinates, so it covers the same area of the definition. A group of plain
// shapes (a blended or blurred rectangle) needs none, and gets none: there Chromium would draw the
// effect over the whole home area for every copy (64 copies of 60 blended parts took 3.4 times as
// long). Groups under a transform that cannot be read or undone get none either.
//
// A filter inside the copies is then drawn with each copy's tiles. Chromium drawing on the CPU (as
// on Linux CI) runs it again for every tile, which is slow for a large filter: 16 spin copies over
// a 20 px directional blur of a layer reaching 2.5 frames wide took 6.3 s a 1080p frame. Marking
// the group will-change: filter made that 1.0 s, but Chromium then kept a layer per copy and left
// copies out above 1080p (a frame-sized layer at 4K: level 70.9 instead of 97.7), so it is not used.
function withInnerHomes(markup, home) {
  const corners = [[home.x, home.y], [home.x + home.width, home.y], [home.x, home.y + home.height],
    [home.x + home.width, home.y + home.height]];
  const stack = [], output = [];
  let cursor = 0;
  const close = () => {
    const entry = stack.pop();
    if (!entry) return;
    if (entry.slot !== undefined && entry.parts) output[entry.slot] = entry.rectangle;
    const parent = stack.at(-1);
    if (parent && !entry.skip && (entry.parts || entry.own)) parent.parts = true;
  };
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start < 0) break;
    const ending = markup.startsWith("<!--", start) ? "-->" : markup.startsWith("<![CDATA[", start) ? "]]>" : "";
    const closing = ending ? markup.indexOf(ending, start + 4) : -1;
    const end = !ending ? tagEnd(markup, start) : closing < 0 ? markup.length : closing + ending.length;
    const tag = markup.slice(start, end);
    output.push(markup.slice(cursor, start), tag);
    cursor = end;
    if (ending || tag.startsWith("<!") || tag.startsWith("<?")) continue;
    if (tag.startsWith("</")) { close(); continue; }
    const name = tag.match(/^<([A-Za-z_:][A-Za-z0-9_:.-]*)/)?.[1];
    if (!name) continue;
    const parent = stack.at(-1) ?? { matrix: IDENTITY, skip: false };
    const attributes = tagAttributes(tag);
    const skip = parent.skip || UNDRAWN.has(name.toLowerCase());
    let matrix = parent.matrix;
    if (!skip && matrix && attributes.has("transform")) {
      const own = transformMatrix(attributes.get("transform"));
      matrix = own && multiply(matrix, own);
    }
    const entry = { matrix, skip, own: startsOwnDrawing(name, attributes), parts: false };
    stack.push(entry);
    const local = !skip && matrix && name === "g" && seeThroughGroup(attributes) ? inverse(matrix) : null;
    if (local) {
      // In whole thousandths of a unit, rounded outward, which keeps the markup short.
      const points = corners.map(([x, y]) => point(local, x, y));
      const thousandths = (values) => Math.floor(Number((Math.min(...values) * 1000).toFixed(3)));
      const left = thousandths(points.map((p) => p.x)), top = thousandths(points.map((p) => p.y));
      const right = -thousandths(points.map((p) => -p.x)), bottom = -thousandths(points.map((p) => -p.y));
      const box = { x: left / 1000, y: top / 1000, width: (right - left) / 1000, height: (bottom - top) / 1000 };
      if ([box.x, box.y, box.x + box.width, box.y + box.height].every((value) => Math.abs(value) <= MAX_SVG_COORDINATE) &&
          box.width > 0 && box.height > 0) {
        // Filled in when the group closes, if it holds parts drawn on their own.
        entry.slot = output.push("") - 1;
        entry.rectangle = homeRectangle(box);
      }
    }
    if (/\/\s*>$/.test(tag)) close();
  }
  while (stack.length) close();
  return output.join("") + markup.slice(cursor);
}

export function copiesEffect(frame, copiesMarkup) {
  validateFrame(frame, { helpers: false });
  if (typeof copiesMarkup !== "string") throw new TypeError("Decorative copies must be an SVG string.");
  return `<g>${copyContent(copiesMarkup)}<g opacity="0">${frame.content}</g></g>`;
}
