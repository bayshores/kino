import { createLayer } from "./model.js";
import {
  IDENTITY,
  multiply,
  transformProperties,
} from "./geometry.js";
import { parsePath, pathBounds, serializePath } from "./vectorPath.js";
import { LETTER_SPACING_LIMIT, letterSpacingPercent } from "./letterSpacing.js";
import { normalizeTextStyleRanges } from "./textStyleRanges.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_ELEMENTS = 20_000;
const MAX_DEPTH = 128;
const MAX_LAYERS = 5_000;
const NAMED_COLORS = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  navy: "#000080",
  purple: "#800080",
  orange: "#ffa500",
  pink: "#ffc0cb",
  coral: "#ff7f50",
  crimson: "#dc143c",
  gold: "#ffd700",
  khaki: "#f0e68c",
  violet: "#ee82ee",
  indigo: "#4b0082",
  beige: "#f5f5dc",
  tan: "#d2b48c",
  salmon: "#fa8072",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  orchid: "#da70d6",
  plum: "#dda0dd",
  skyblue: "#87ceeb",
  darkblue: "#00008b",
  darkgreen: "#006400",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  slategray: "#708090",
  slateblue: "#6a5acd",
  rebeccapurple: "#663399",
};
const PRESENTATION_PROPERTIES = new Set([
  "color",
  "display",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "mix-blend-mode",
  "opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "stop-color",
  "stop-opacity",
  "text-anchor",
  "visibility",
  "dominant-baseline",
  "line-height",
]);
const INHERITED_PROPERTIES = new Set([
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "visibility",
  "dominant-baseline",
  "line-height",
]);
const SVG_TRANSFORMS = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const SVG_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fail(message) {
  throw new Error(`SVG import: ${message}`);
}

function finiteNumber(value, label, { min = -1_000_000, max = 1_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    fail(`${label} must be a finite number from ${min} to ${max}.`);
  return number;
}

function parseNumberList(value, label) {
  const tokens = String(value)
    .trim()
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length || tokens.some((token) => !NUMBER.test(token)))
    fail(`${label} contains invalid numbers.`);
  if (tokens.length > 20_000) fail(`${label} contains too many coordinate values.`);
  return tokens.map((token) => finiteNumber(token, label));
}

function parseLength(value, fallback, axisSize, label, { percent = true } = {}) {
  if (value == null || String(value).trim() === "") return fallback;
  const match = String(value)
    .trim()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|mm|cm|in|%)?$/i);
  if (!match) fail(`${label} uses an unsupported length unit.`);
  let result = finiteNumber(match[1], label);
  const unit = (match[2] || "").toLowerCase();
  if (unit === "%") {
    if (!percent) fail(`${label} cannot use a percentage here.`);
    result = (result / 100) * axisSize;
  } else if (unit === "pt") result *= 96 / 72;
  else if (unit === "pc") result *= 16;
  else if (unit === "mm") result *= 96 / 25.4;
  else if (unit === "cm") result *= 96 / 2.54;
  else if (unit === "in") result *= 96;
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000)
    fail(`${label} is outside the supported range.`);
  return result;
}

function translate(x, y) {
  return [1, 0, 0, 1, x, y];
}

function scale(x, y = x) {
  return [x, 0, 0, y, 0, 0];
}

function parseTransform(value) {
  if (!value || !String(value).trim()) return IDENTITY;
  const source = String(value).trim();
  let cursor = 0;
  let matrix = IDENTITY;
  SVG_TRANSFORMS.lastIndex = 0;
  let match;
  while ((match = SVG_TRANSFORMS.exec(source))) {
    if (source.slice(cursor, match.index).replace(/[\s,]/g, ""))
      fail("transform contains unsupported syntax.");
    const args = parseNumberList(match[2], "transform");
    let next;
    const name = match[1];
    if (name === "matrix" && args.length === 6) next = args;
    else if (name === "translate" && (args.length === 1 || args.length === 2))
      next = translate(args[0], args[1] || 0);
    else if (name === "scale" && (args.length === 1 || args.length === 2))
      next = scale(args[0], args[1] ?? args[0]);
    else if (name === "rotate" && (args.length === 1 || args.length === 3)) {
      const radians = (args[0] * Math.PI) / 180;
      const rotation = [
        Math.cos(radians),
        Math.sin(radians),
        -Math.sin(radians),
        Math.cos(radians),
        0,
        0,
      ];
      next =
        args.length === 3
          ? multiply(
              translate(args[1], args[2]),
              multiply(rotation, translate(-args[1], -args[2])),
            )
          : rotation;
    } else if (name === "skewX" && args.length === 1) {
      next = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewY" && args.length === 1) {
      next = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
    } else fail(`transform function ${name} is unsupported or has the wrong arguments.`);
    matrix = multiply(matrix, next);
    cursor = SVG_TRANSFORMS.lastIndex;
  }
  if (!cursor || source.slice(cursor).replace(/[\s,]/g, ""))
    fail("transform contains unsupported syntax.");
  if (matrix.some((item) => !Number.isFinite(item) || Math.abs(item) > 1_000_000))
    fail("transform exceeds the supported range.");
  return matrix;
}

function parseColor(value, label) {
  const source = String(value ?? "").trim().toLowerCase();
  if (source === "none" || source === "transparent")
    return { color: "#000000", alpha: 0 };
  let color = source;
  if (NAMED_COLORS[color]) color = NAMED_COLORS[color];
  if (/^#[\da-f]{3,4}$/i.test(color)) {
    const digits = color.slice(1);
    color = `#${[...digits].map((digit) => digit + digit).join("")}`;
  }
  if (/^#[\da-f]{6}$/i.test(color))
    return { color: color.toLowerCase(), alpha: 1 };
  if (/^#[\da-f]{8}$/i.test(color))
    return {
      color: color.slice(0, 7).toLowerCase(),
      alpha: parseInt(color.slice(7), 16) / 255,
    };
  const rgb = color.match(/^rgba?\((.*)\)$/i);
  if (rgb) {
    const parts = rgb[1]
      .trim()
      .replace(/\s*\/\s*/, ",")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4)
      fail(`${label} has an invalid rgb() color.`);
    const channels = parts.slice(0, 3).map((part) => {
      if (part.endsWith("%"))
        return Math.round(
          Math.max(0, Math.min(100, finiteNumber(part.slice(0, -1), label))) *
            2.55,
        );
      return Math.round(Math.max(0, Math.min(255, finiteNumber(part, label))));
    });
    const alpha =
      parts.length === 4
        ? parts[3].endsWith("%")
          ? Math.max(0, Math.min(100, finiteNumber(parts[3].slice(0, -1), label))) /
            100
          : Math.max(0, Math.min(1, finiteNumber(parts[3], label)))
        : 1;
    return {
      color: `#${channels.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
      alpha,
    };
  }
  fail(`${label} uses an unsupported color value (${source || "empty"}).`);
}

function withOpacity(colorValue, opacityValue, label) {
  const { color, alpha } = parseColor(colorValue, label);
  const opacity = Math.max(0, Math.min(1, finiteNumber(opacityValue, `${label} opacity`, { min: 0, max: 1 })));
  const combined = Math.round(alpha * opacity * 255);
  return `${color}${combined.toString(16).padStart(2, "0")}`;
}

function getAttribute(element, name) {
  return element?.hasAttribute?.(name) ? element.getAttribute(name) : null;
}

function parseStyleAttribute(element, warnings) {
  const result = {};
  const raw = getAttribute(element, "style");
  if (!raw) return result;
  for (const declaration of raw.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    if (colon < 1) {
      warnings.add("An inline style declaration could not be parsed.");
      continue;
    }
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().replace(/\s*!important\s*$/i, "");
    if (!PRESENTATION_PROPERTIES.has(key)) {
      warnings.add(`Inline style property “${key}” is not represented in the layer model.`);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function styleFor(element, inherited, warnings) {
  const style = {};
  for (const [key, value] of Object.entries(inherited))
    if (INHERITED_PROPERTIES.has(key)) style[key] = value;
  for (const key of PRESENTATION_PROPERTIES) {
    const value = getAttribute(element, key);
    if (value != null) style[key] = value.trim();
  }
  Object.assign(style, parseStyleAttribute(element, warnings));
  for (const [key, value] of Object.entries(style)) {
    if (value === "inherit" && inherited[key] != null) style[key] = inherited[key];
  }
  const fillRule = String(style["fill-rule"] ?? "nonzero").trim().toLowerCase();
  if (fillRule === "inherit") {
    style["fill-rule"] = inherited["fill-rule"] ?? "nonzero";
  } else if (fillRule === "nonzero" || fillRule === "evenodd") {
    style["fill-rule"] = fillRule;
  } else {
    warnings.add("SVG fill-rule values other than nonzero and evenodd are ignored.");
    style["fill-rule"] = inherited["fill-rule"] ?? "nonzero";
  }
  style.color ??= "black";
  style.fill ??= "black";
  style["fill-opacity"] ??= "1";
  style["fill-rule"] ??= "nonzero";
  style["font-family"] ??= "Arial";
  style["font-size"] ??= "16";
  style["font-style"] ??= "normal";
  style["font-weight"] ??= "400";
  style["letter-spacing"] ??= "0";
  style.opacity ??= "1";
  style.stroke ??= "none";
  style["stroke-dasharray"] ??= "none";
  style["stroke-dashoffset"] ??= "0";
  style["stroke-linecap"] ??= "butt";
  style["stroke-linejoin"] ??= "miter";
  style["stroke-miterlimit"] ??= "4";
  style["stroke-opacity"] ??= "1";
  style["stroke-width"] ??= "1";
  style["text-anchor"] ??= "start";
  style.visibility ??= "visible";
  style["dominant-baseline"] ??= "auto";
  style["mix-blend-mode"] ??= "normal";
  return style;
}

function parsePoints(value) {
  const numbers = parseNumberList(value, "points");
  if (numbers.length < 4 || numbers.length % 2)
    fail("polygon/polyline points must contain at least two coordinate pairs.");
  const points = [];
  for (let index = 0; index < numbers.length; index += 2)
    points.push({ x: numbers[index], y: numbers[index + 1] });
  return points;
}

function localPath(path) {
  let contours;
  let bounds;
  try {
    contours = parsePath(path);
    bounds = pathBounds(path);
  } catch (error) {
    fail(`path data is malformed or unsupported (${error.message}).`);
  }
  if (!contours.length) fail("path data must contain a move command.");
  const width = bounds.width === 0 ? 1 : Math.max(0.001, bounds.width);
  const height = bounds.height === 0 ? 1 : Math.max(0.001, bounds.height);
  const normalized = serializePath(
    contours.map((contour) => ({
      ...contour,
      start: [contour.start[0] - bounds.x, contour.start[1] - bounds.y],
      segments: contour.segments.map((segment) => ({
        c1: [segment.c1[0] - bounds.x, segment.c1[1] - bounds.y],
        c2: [segment.c2[0] - bounds.x, segment.c2[1] - bounds.y],
        end: [segment.end[0] - bounds.x, segment.end[1] - bounds.y],
      })),
    })),
  );
  return { bounds, path: normalized, width, height };
}

function pointsBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function transformBounds(matrix, bounds) {
  const points = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x, bounds.y + bounds.height],
    [bounds.x + bounds.width, bounds.y + bounds.height],
  ].map(([x, y]) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }));
  return pointsBounds(points);
}

function unionBounds(bounds) {
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x, y, width: right - x, height: bottom - y };
}

function parseViewBox(value) {
  if (!value) return null;
  const values = parseNumberList(value, "viewBox");
  if (values.length !== 4 || values[2] <= 0 || values[3] <= 0 || values[2] > 65_536 || values[3] > 65_536)
    fail("viewBox must contain x, y, width, and height, with positive dimensions.");
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function rootDimensions(root, viewBox, warnings) {
  const defaultWidth = viewBox?.width ?? 300;
  const defaultHeight = viewBox?.height ?? 150;
  const rawWidth = getAttribute(root, "width");
  const rawHeight = getAttribute(root, "height");
  const rootLength = (raw, fallback, axis, label) => {
    if (raw == null || raw.trim().endsWith("%")) {
      if (raw?.trim().endsWith("%"))
        warnings.add(`Root ${label} is percentage-based; the viewBox or default viewport size is used.`);
      return fallback;
    }
    return parseLength(raw, fallback, axis, `root ${label}`, { percent: false });
  };
  let width = rootLength(rawWidth, defaultWidth, defaultWidth, "width");
  let height = rootLength(rawHeight, defaultHeight, defaultHeight, "height");
  if (width < 1 || height < 1) fail("root width and height must be at least one pixel.");
  if (!rawWidth && viewBox && rawHeight)
    width = height * (viewBox.width / viewBox.height);
  if (!rawHeight && viewBox && rawWidth)
    height = width * (viewBox.height / viewBox.width);
  if (width > 65_536 || height > 65_536)
    fail("root width and height must fit within the 65,536-pixel project limit.");
  return { width, height };
}

function rootViewBoxMatrix(viewBox, width, height, element, rootTransform) {
  if (!viewBox)
    return rootTransform;
  const preserve = (getAttribute(element, "preserveAspectRatio") || "xMidYMid meet")
    .trim()
    .split(/\s+/);
  let align = preserve[0] === "defer" ? preserve[1] : preserve[0];
  const mode = preserve.at(-1) === "slice" ? "slice" : "meet";
  const validAlign = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))$/;
  if (!validAlign.test(align)) fail("preserveAspectRatio has an unsupported alignment value.");
  let sx = width / viewBox.width;
  let sy = height / viewBox.height;
  let ox = 0;
  let oy = 0;
  if (align !== "none") {
    sx = sy = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    const freeX = width - viewBox.width * sx;
    const freeY = height - viewBox.height * sy;
    ox = align.includes("xMid") ? freeX / 2 : align.includes("xMax") ? freeX : 0;
    oy = align.includes("YMid") ? freeY / 2 : align.includes("YMax") ? freeY : 0;
  } else if (preserve.length > 1 && !["meet", "slice"].includes(preserve[1])) {
    fail("preserveAspectRatio has an unsupported mode.");
  }
  const viewMap = multiply(
    translate(ox, oy),
    multiply(scale(sx, sy), translate(-viewBox.x, -viewBox.y)),
  );
  return multiply(viewMap, rootTransform);
}

function parseOpacity(style, property) {
  const raw = String(style[property] ?? 1).trim();
  const value = raw.endsWith("%")
    ? finiteNumber(raw.slice(0, -1), property, { min: 0, max: 100 }) / 100
    : finiteNumber(raw, property, { min: 0, max: 1 });
  return value;
}

function parseColorPaint(value, opacity, gradients, warnings, label) {
  const source = String(value).trim();
  const url = source.match(/^url\(\s*['"]?#([\w.-]+)['"]?\s*\)$/i);
  if (url) {
    if (label === "stroke") fail("Gradient strokes are not represented by the current layer model.");
    const gradient = gradients.get(url[1]);
    if (!gradient) fail(`${label} references an unknown or unsupported paint server.`);
    if (opacity === 1) return gradient;
    return {
      ...gradient,
      stops: gradient.stops.map((stop) => ({
        ...stop,
        color: withOpacity(stop.color, opacity, `${label} gradient stop`),
      })),
    };
  }
  if (/url\s*\(/i.test(source))
    fail(`${label} contains an external or unsupported paint-server reference.`);
  return withOpacity(source === "currentColor" ? "black" : source, opacity, label);
}

function parseOffset(value, label) {
  const source = String(value ?? "0").trim();
  if (source.endsWith("%"))
    return Math.max(0, Math.min(1, finiteNumber(source.slice(0, -1), label) / 100));
  return Math.max(0, Math.min(1, finiteNumber(source, label)));
}

function parseGradient(element, warnings) {
  const tag = element.localName || element.nodeName;
  const type = tag === "linearGradient" ? "linear" : "radial";
  if (getAttribute(element, "href") || getAttribute(element, "xlink:href"))
    fail("Gradient references (href) are unsupported.");
  const units = getAttribute(element, "gradientUnits") || "objectBoundingBox";
  if (units !== "objectBoundingBox")
    fail("userSpaceOnUse gradients cannot be represented faithfully.");
  const transform = getAttribute(element, "gradientTransform");
  if (transform && !/^\s*(?:matrix\(1\s*,?\s*0\s*,?\s*0\s*,?\s*1\s*,?\s*0\s*,?\s*0\s*\))?\s*$/.test(transform))
    fail("gradientTransform cannot be represented by this layer model.");
  if ((getAttribute(element, "spreadMethod") || "pad") !== "pad")
    fail("Only pad-spread gradients are supported.");
  const stops = [];
  for (const child of Array.from(element.childNodes || [])) {
    if (child.nodeType !== 1) continue;
    if ((child.localName || child.nodeName) !== "stop")
      fail("Gradient children other than color stops are unsupported.");
    validateAttributes(child, warnings);
    const stopStyle = {
      ...Object.fromEntries(
        Array.from(child.attributes || []).map((attribute) => [attribute.name, attribute.value]),
      ),
      ...parseStyleAttribute(child, warnings),
    };
    const offset = parseOffset(stopStyle.offset ?? "0", "gradient stop offset");
    const colorValue = stopStyle["stop-color"] || stopStyle.stopColor || "black";
    const opacity = parseOpacity(
      { opacity: stopStyle["stop-opacity"] ?? stopStyle.stopOpacity ?? 1 },
      "opacity",
    );
    const color = withOpacity(colorValue, opacity, "gradient stop color");
    if (stops.length && offset < stops.at(-1).offset)
      fail("Gradient stop offsets must be ordered.");
    stops.push({ offset, color });
  }
  if (stops.length < 2) fail("A used gradient must have at least two color stops.");
  if (type === "linear") {
    const number = (name, fallback) => {
      const value = getAttribute(element, name);
      if (value == null) return fallback;
      const source = value.trim();
      if (source.endsWith("%")) return finiteNumber(source.slice(0, -1), name) / 100;
      return finiteNumber(source, name);
    };
    const x1 = number("x1", 0);
    const y1 = number("y1", 0);
    const x2 = number("x2", 1);
    const y2 = number("y2", 0);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    const axisCenter = ((x1 + x2) / 2 - 0.5) * (dx / (length || 1)) +
      ((y1 + y2) / 2 - 0.5) * (dy / (length || 1));
    if (Math.abs(axisCenter) > 1e-6 || Math.abs(length - 1) > 1e-6)
      fail("Only centered, full-span linear gradients can be imported faithfully.");
    return { type, angle: (Math.atan2(dy, dx) * 180) / Math.PI, stops };
  }
  const number = (name, fallback) => {
    const value = getAttribute(element, name);
    if (value == null) return fallback;
    const source = value.trim();
    if (source.endsWith("%")) return finiteNumber(source.slice(0, -1), name) / 100;
    return finiteNumber(source, name);
  };
  if (
    Math.abs(number("cx", 0.5) - 0.5) > 1e-6 ||
    Math.abs(number("cy", 0.5) - 0.5) > 1e-6 ||
    Math.abs(number("r", 0.5) - 0.5) > 1e-6 ||
    Math.abs(number("fx", number("cx", 0.5)) - 0.5) > 1e-6 ||
    Math.abs(number("fy", number("cy", 0.5)) - 0.5) > 1e-6
  )
    fail("Only centered, full-span radial gradients can be imported faithfully.");
  return { type, angle: 0, stops };
}

function collectGradients(root, warnings) {
  const gradients = new Map();
  const visit = (element, inDefs = false) => {
    if (element.nodeType !== 1) return;
    const tag = element.localName || element.nodeName;
    const defs = inDefs || tag === "defs";
    if (["linearGradient", "radialGradient"].includes(tag)) {
      validateAttributes(element, warnings);
      const id = getAttribute(element, "id");
      if (!id) fail("Gradients need an id.");
      if (gradients.has(id)) fail(`Gradient id “${id}” is duplicated.`);
      gradients.set(id, parseGradient(element, warnings));
      return;
    }
    for (const child of Array.from(element.childNodes || []))
      if (child.nodeType === 1) visit(child, defs);
  };
  visit(root);
  return gradients;
}

function inspectTree(root) {
  let count = 0;
  const visit = (element, depth = 0) => {
    if (element.nodeType !== 1) return;
    count += 1;
    if (count > MAX_ELEMENTS) fail(`the document contains more than ${MAX_ELEMENTS} elements.`);
    if (depth > MAX_DEPTH) fail(`the document is nested more than ${MAX_DEPTH} levels.`);
    const tag = element.localName || element.nodeName;
    if (element.namespaceURI && element.namespaceURI !== SVG_NS)
      fail("elements from non-SVG namespaces are unsupported.");
    if (["script", "foreignObject", "use", "image", "animate", "animateMotion", "animateTransform", "set", "style"].includes(tag))
      fail(`<${tag}> elements are executable, linked, animated, or unsupported.`);
    if (["clipPath", "filter", "mask", "pattern", "marker", "symbol"].includes(tag))
      fail(`<${tag}> visual effects are not represented in the layer model.`);
    for (const attribute of Array.from(element.attributes || [])) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) fail(`event attribute “${attribute.name}” is not allowed.`);
      if (name === "href" || name === "xlink:href")
        fail("SVG href references are not imported; linked media and <use> references are refused.");
    }
    if (tag !== "svg" && tag !== "g" && tag !== "defs" && tag !== "title" && tag !== "desc" && tag !== "metadata" && tag !== "linearGradient" && tag !== "radialGradient" && tag !== "stop" && !["rect", "circle", "ellipse", "line", "polygon", "polyline", "path", "text", "tspan", "a"].includes(tag))
      fail(`<${tag}> elements are not supported.`);
    for (const child of Array.from(element.childNodes || [])) visit(child, depth + 1);
  };
  visit(root);
}

function validateAttributes(element, warnings) {
  const geometry = new Set([
    "id", "xmlns", "xmlns:xlink", "x", "y", "width", "height", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "rx", "ry", "points", "d", "transform", "viewBox", "preserveAspectRatio",
    "style", "class", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
    "opacity", "display", "visibility", "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "text-anchor", "dominant-baseline", "color", "mix-blend-mode", "offset",
    "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "fx", "fy", "href", "xlink:href", "xmlns", "xmlns:xlink",
  ]);
  for (const attribute of Array.from(element.attributes || [])) {
    const name = attribute.name;
    if (geometry.has(name) || name.startsWith("data-") || name.startsWith("aria-") || name === "role") continue;
    if (["transform-origin", "transform-box"].includes(name))
      fail(`${name} is not represented by the layer transform model.`);
    warnings.add(`Attribute “${name}” is not represented in the imported layers.`);
  }
}

function gradientPaint(style, gradients, warnings, property, opacityProperty) {
  const value = style[property];
  const opacity = parseOpacity(style, opacityProperty);
  if (value === "currentColor") return withOpacity(style.color || "black", opacity, property);
  return parseColorPaint(value, opacity, gradients, warnings, property);
}

function unsupportedStrokeAndTextStyle(style, warnings, tag) {
  if (style["stroke-linecap"] !== "butt") warnings.add(`${tag} stroke line caps are not represented.`);
  if (style["stroke-linejoin"] !== "miter") warnings.add(`${tag} stroke joins are not represented.`);
  if (style["stroke-miterlimit"] !== "4") warnings.add(`${tag} stroke miter limits are not represented.`);
  if (style["stroke-dasharray"] !== "none" || style["stroke-dashoffset"] !== "0")
    warnings.add(`${tag} dashed strokes are not represented.`);
  if (style["mix-blend-mode"] !== "normal" && !/^(?:multiply|screen|overlay|darken|lighten|color-dodge|color-burn|hard-light|soft-light|difference|exclusion|hue|saturation|color|luminosity)$/.test(style["mix-blend-mode"]))
    warnings.add(`${tag} blend mode “${style["mix-blend-mode"]}” may not render the same.`);
  if (tag === "text") {
    if (!/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|pt|pc|mm|cm|in)?$/i.test(style["font-size"]))
      fail("Text font-size must use a numeric length.");
    if (!/^(?:auto|alphabetic|baseline)$/i.test(style["dominant-baseline"]))
      warnings.add("Text dominant-baseline variants may differ from SVG rendering.");
  }
}

function blendMode(style, warnings) {
  const mode = style["mix-blend-mode"] || "normal";
  // CSS plus-lighter is kino's "add" (linear dodge).
  if (mode === "plus-lighter") return "add";
  const supported = new Set([
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
    "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue",
    "saturation", "color", "luminosity",
  ]);
  if (!supported.has(mode)) {
    warnings.add(`Blend mode “${mode}” is not supported; normal blending is used.`);
    return "normal";
  }
  return mode;
}

function gradientDefinitions(root, warnings) {
  return collectGradients(root, warnings);
}

// SVG letter-spacing in pixels: "normal" is 0, "0.1em" is a tenth of the font size, and any
// other length is read like the other SVG lengths (px, pt, mm, ...). A percentage is refused.
function svgLetterSpacingPixels(value, fontSize) {
  const text = String(value ?? "").trim();
  if (text.toLowerCase() === "normal") return 0;
  const em = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)em$/i);
  if (em) return finiteNumber(em[1], "letter-spacing") * fontSize;
  return parseLength(text, 0, 0, "letter-spacing", { percent: false });
}

function textStyle(style, viewport, gradients, warnings, label = "text") {
  if (String(style["font-size"]).trim().endsWith("%"))
    fail("Percentage font-size needs ancestor font metrics that this importer does not have.");
  const fontSize = parseLength(style["font-size"], 16, viewport.height, `${label} font-size`, { percent: true });
  if (!(fontSize > 0) || fontSize > 10_000) fail(`${label} font-size must be from 0 to 10,000 pixels.`);
  const letterSpacingPixels = svgLetterSpacingPixels(style["letter-spacing"], fontSize);
  const letterSpacing = letterSpacingPercent(letterSpacingPixels, fontSize);
  if (!Number.isFinite(letterSpacing) || Math.abs(letterSpacing) > LETTER_SPACING_LIMIT)
    fail(`${label} letter-spacing exceeds the model limit.`);
  const weightValue = style["font-weight"] === "normal" ? "400" : style["font-weight"] === "bold" ? "700" : style["font-weight"];
  const fontWeight = finiteNumber(weightValue, `${label} font-weight`, { min: 1, max: 1000 });
  const rawFamily = String(style["font-family"] ?? "Arial").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  if (/url\s*\(/i.test(rawFamily)) fail("SVG font URL references are unsupported; font files are never fetched during import.");
  const fontFamily = rawFamily || "Arial";
  const rawFontStyle = String(style["font-style"] ?? "normal").trim().toLowerCase();
  let fontStyle = rawFontStyle;
  if (rawFontStyle === "oblique") {
    fontStyle = "italic";
    warnings.add(`${label} oblique text is imported as italic.`);
  } else if (!(["normal", "italic"].includes(rawFontStyle))) {
    fail(`${label} font-style must be normal, italic, or oblique.`);
  }
  const fill = gradientPaint(style, gradients, warnings, "fill", "fill-opacity");
  return { fontFamily: fontFamily.slice(0, 256), fontSource: "", fontWeight, fontStyle, fontSize, fill, letterSpacing, letterSpacingPixels };
}

const RANGE_STYLE_KEYS = ["fontFamily", "fontSource", "fontWeight", "fontStyle", "fontSize", "fill", "letterSpacing"];

function sameStyleValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function textStyleDelta(style, base) {
  const result = {};
  for (const key of RANGE_STYLE_KEYS) {
    if (key === "fontSource") continue;
    if (!sameStyleValue(style[key], base[key])) result[key] = style[key];
  }
  if ((result.fontFamily !== undefined || result.fontWeight !== undefined || result.fontStyle !== undefined) && base.fontSource)
    result.fontSource = "";
  return result;
}

function sameTextStyle(left, right) {
  return RANGE_STYLE_KEYS.every((key) => sameStyleValue(left[key], right[key])) &&
    sameStyleValue(left.letterSpacingPixels, right.letterSpacingPixels);
}

function rangesOnGraphemes(text, runs, base, warnings) {
  if (runs.every((run) => sameTextStyle(run.style, base))) return [];
  const candidates = [];
  let runIndex = 0;
  let expandedBoundary = false;
  for (const grapheme of SVG_GRAPHEMES.segment(text)) {
    const start = grapheme.index;
    const end = start + grapheme.segment.length;
    while (runIndex < runs.length && runs[runIndex].end <= start) runIndex += 1;
    const first = runs[runIndex];
    if (!first || first.start > start || first.end < start + 1)
      fail("text style runs do not cover a grapheme boundary.");
    let check = runIndex;
    while (check < runs.length && runs[check].start < end) {
      const run = runs[check];
      if (run.start < end && run.end > start && !sameTextStyle(first.style, run.style))
        expandedBoundary = true;
      check += 1;
    }
    const delta = textStyleDelta(first.style, base);
    if (Object.keys(delta).length) candidates.push({ start, end, style: delta });
  }
  if (expandedBoundary)
    warnings.add("An SVG tspan style boundary inside a grapheme is applied to the whole grapheme using its first character's style.");
  return normalizeTextStyleRanges(text, candidates, "SVG text");
}

const POSITIONED_TSPAN_ATTRIBUTES = new Set(["x", "y", "dx", "dy", "rotate", "textlength", "lengthadjust", "baseline-shift"]);
const SUPPORTED_TSPAN_ATTRIBUTES = new Set([
  "id", "class", "style", "font-family", "font-size", "font-weight", "font-style",
  "letter-spacing", "fill", "fill-opacity", "color",
]);

function inspectTspan(element, warnings) {
  let positioned = false;
  let otherUnsupported = false;
  for (const attribute of Array.from(element.attributes || [])) {
    const name = attribute.name.toLowerCase();
    if (POSITIONED_TSPAN_ATTRIBUTES.has(name)) positioned = true;
    else if (!SUPPORTED_TSPAN_ATTRIBUTES.has(name) && !name.startsWith("data-") && !name.startsWith("aria-") && name !== "role")
      otherUnsupported = true;
  }
  if (positioned) warnings.add("Positioned <tspan> text is flattened to one text layer; character positions are not preserved.");
  if (otherUnsupported) warnings.add("Unsupported <tspan> styling is flattened to one text layer.");
}

function collectTextRuns(element, baseStyle, viewport, gradients, warnings) {
  const runs = [];
  let offset = 0;
  const visit = (parent, inherited) => {
    for (const child of Array.from(parent.childNodes || [])) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const value = String(child.nodeValue ?? "");
        if (!value) continue;
        runs.push({ start: offset, end: offset + value.length, text: value, style: textStyle(inherited, viewport, gradients, warnings, "tspan") });
        offset += value.length;
      } else if (child.nodeType === 1) {
        const tag = child.localName || child.nodeName;
        if (tag === "tspan") inspectTspan(child, warnings);
        else if (tag !== "a") warnings.add(`Nested <${tag}> text is flattened to one text layer.`);
        validateAttributes(child, warnings);
        visit(child, styleFor(child, inherited, warnings));
      }
    }
  };
  visit(element, baseStyle);
  return runs;
}

function parseText(element, style, viewport, gradients, warnings) {
  const base = textStyle(style, viewport, gradients, warnings);
  const text = String(element.textContent || "");
  if (text.length > 2_000_000) fail("text content exceeds the model's 2 MB layer text limit.");
  if (!text) return null;
  const runs = collectTextRuns(element, style, viewport, gradients, warnings);
  if (runs.map((run) => run.text).join("") !== text)
    fail("text node content could not be read without changing its offsets.");
  const textStyleRanges = rangesOnGraphemes(text, runs, base, warnings);
  if (text.includes("\n")) warnings.add("Multiline SVG text uses kino line spacing and may need adjustment.");
  warnings.add("Text width uses an approximate font metric; font shaping and wrapping may differ from the source SVG.");
  const x = parseLength(getAttribute(element, "x"), 0, viewport.width, "text x");
  const baseline = parseLength(getAttribute(element, "y"), 0, viewport.height, "text y");
  const width = Math.max(1, runs.reduce((sum, run) => sum + [...run.text].reduce((line, character) => {
    let factor = 0.56;
    if (/\s/.test(character)) factor = 0.32;
    else if (/[ilI.,'!:;|]/.test(character)) factor = 0.28;
    else if (/[MW@#%&]/.test(character)) factor = 0.82;
    else if (/[\u2e80-\uffff]/u.test(character)) factor = 1;
    return line + Math.max(0, run.style.fontSize * factor + run.style.letterSpacingPixels);
  }, 0), 0));
  let lineHeight = 1.2;
  const rawLineHeight = style["line-height"];
  if (rawLineHeight && rawLineHeight !== "normal") {
    const parsedLineHeight = Number(rawLineHeight);
    if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 && parsedLineHeight <= 100) lineHeight = parsedLineHeight;
    else warnings.add("Text line-height units are not represented; standard spacing is used.");
  }
  const height = Math.max(base.fontSize, ...runs.map((run) => run.style.fontSize)) * lineHeight;
  const anchor = style["text-anchor"];
  if (!["start", "middle", "end"].includes(anchor))
    warnings.add(`Text anchor “${anchor}” is unsupported; start alignment is used.`);
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  const { letterSpacingPixels: _letterSpacingPixels, ...baseProperties } = base;
  return {
    text,
    x: left,
    y: baseline - base.fontSize,
    width,
    height,
    ...baseProperties,
    ...(textStyleRanges.length ? { textStyleRanges } : {}),
    lineHeight,
  };
}

function childElements(element) {
  return Array.from(element.childNodes || []).filter((child) => child.nodeType === 1);
}

function parseShape(element, style, gradients, warnings, viewport) {
  const tag = element.localName || element.nodeName;
  const axisLength = (name, fallback, axis) =>
    parseLength(getAttribute(element, name), fallback, axis === "x" ? viewport.width : viewport.height, `${tag} ${name}`);
  const x = axisLength("x", 0, "x");
  const y = axisLength("y", 0, "y");
  let type = "rectangle";
  let bounds;
  let properties = {};
  let pathAbsolute = false;
  if (tag === "rect") {
    const width = axisLength("width", 0, "x");
    const height = axisLength("height", 0, "y");
    if (width < 0 || height < 0) fail("rect width and height cannot be negative.");
    if (!width || !height) return null;
    const rxRaw = getAttribute(element, "rx");
    const ryRaw = getAttribute(element, "ry");
    const rx = parseLength(rxRaw ?? ryRaw, 0, viewport.width, "rect rx");
    const ry = parseLength(ryRaw ?? rxRaw, 0, viewport.height, "rect ry");
    if (Math.abs(rx - ry) > 1e-6) warnings.add("Rounded rectangles with different x/y radii use the x radius.");
    properties = { radius: Math.min(rx, width / 2, height / 2), width, height };
    bounds = { x, y, width, height };
  } else if (tag === "circle" || tag === "ellipse") {
    type = "ellipse";
    const cx = parseLength(getAttribute(element, "cx"), 0, viewport.width, `${tag} cx`);
    const cy = parseLength(getAttribute(element, "cy"), 0, viewport.height, `${tag} cy`);
    const rx = tag === "circle"
      ? parseLength(getAttribute(element, "r"), 0, Math.hypot(viewport.width, viewport.height) / Math.SQRT2, "circle r")
      : parseLength(getAttribute(element, "rx"), 0, viewport.width, "ellipse rx");
    const ry = tag === "circle" ? rx : parseLength(getAttribute(element, "ry"), 0, viewport.height, "ellipse ry");
    if (rx < 0 || ry < 0) fail(`${tag} radii cannot be negative.`);
    if (!rx || !ry) return null;
    bounds = { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
    properties = { width: bounds.width, height: bounds.height };
  } else if (tag === "line") {
    type = "path";
    const x1 = parseLength(getAttribute(element, "x1"), 0, viewport.width, "line x1");
    const y1 = parseLength(getAttribute(element, "y1"), 0, viewport.height, "line y1");
    const x2 = parseLength(getAttribute(element, "x2"), 0, viewport.width, "line x2");
    const y2 = parseLength(getAttribute(element, "y2"), 0, viewport.height, "line y2");
    bounds = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    properties = {
      path: `M ${x1 - bounds.x} ${y1 - bounds.y} L ${x2 - bounds.x} ${y2 - bounds.y}`,
      width,
      height,
      pathBounds: { width, height },
    };
  } else if (tag === "polygon" || tag === "polyline") {
    type = "path";
    const points = parsePoints(getAttribute(element, "points") || "");
    bounds = pointsBounds(points);
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const commands = points.map((point, index) => `${index ? "L" : "M"} ${point.x - bounds.x} ${point.y - bounds.y}`).join(" ");
    properties = {
      path: `${commands}${tag === "polygon" ? " Z" : ""}`,
      width,
      height,
      pathBounds: { width, height },
    };
  } else if (tag === "path") {
    type = "path";
    const path = getAttribute(element, "d") || "";
    if (path.length > 2_000_000) fail("path data exceeds the model's 2 MB layer text limit.");
    const localized = localPath(path);
    if (/[Aa]/.test(path))
      warnings.add("SVG elliptical arcs are converted to cubic curves and may differ slightly from the source.");
    bounds = localized.bounds;
    properties = {
      path: localized.path,
      width: localized.width,
      height: localized.height,
      pathBounds: { width: localized.width, height: localized.height },
    };
    pathAbsolute = false;
  } else if (tag === "text") {
    type = "text";
    const text = parseText(element, style, viewport, gradients, warnings);
    if (!text) return null;
    bounds = { x: text.x, y: text.y, width: text.width, height: text.height };
    properties = {
      text: text.text,
      width: text.width,
      height: text.height,
      fontSize: text.fontSize,
      fontWeight: text.fontWeight,
      fontFamily: text.fontFamily,
      fontSource: text.fontSource,
      fontStyle: text.fontStyle,
      letterSpacing: text.letterSpacing,
      lineHeight: text.lineHeight,
      ...(text.textStyleRanges?.length ? { textStyleRanges: text.textStyleRanges } : {}),
      textAlign: style["text-anchor"] === "middle" ? "center" : style["text-anchor"] === "end" ? "right" : "left",
      fill: style.fill === "currentColor" ? style.color : style.fill,
    };
  } else return null;

  unsupportedStrokeAndTextStyle(style, warnings, tag);
  // fill="none", and a <line>, which has no inside, turn the layer's Fill off. Like a stroke of
  // "none", it keeps SVG's initial black, so turning the Fill on shows a visible fill
  // (paints.js isFillEnabled).
  const rangeRestoresFill = type === "text" && properties.textStyleRanges?.some(({ style: rangeStyle }) => Object.hasOwn(rangeStyle, "fill"));
  const noFill = tag === "line" || (String(style.fill).trim().toLowerCase() === "none" && !rangeRestoresFill);
  const fill = noFill ? "#000000" : gradientPaint(style, gradients, warnings, "fill", "fill-opacity");
  const noStroke = String(style.stroke).trim().toLowerCase() === "none";
  const stroke = noStroke ? "#000000" : gradientPaint(style, gradients, warnings, "stroke", "stroke-opacity");
  const strokeWidth = noStroke ? 0 : parseLength(style["stroke-width"], 1, Math.hypot(viewport.width, viewport.height) / Math.SQRT2, `${tag} stroke-width`);
  if (strokeWidth < 0 || strokeWidth > 10_000) fail(`${tag} stroke-width must be from 0 to 10,000.`);
  const opacity = parseOpacity(style, "opacity");
  const id = getAttribute(element, "id");
  return {
    kind: "shape",
    tag,
    type,
    name: (id || tag).slice(0, 256),
    transform: parseTransform(getAttribute(element, "transform")),
    bounds,
    pathAbsolute,
    properties: {
      ...properties,
      name: (id || tag).slice(0, 256),
      fill,
      fillEnabled: !noFill,
      stroke,
      strokeWidth,
      opacity,
      ...(type === "path" ? { fillRule: style["fill-rule"] } : {}),
      visible: style.visibility !== "hidden" && style.visibility !== "collapse",
      blendMode: blendMode(style, warnings),
    },
  };
}

function parseElement(element, inherited, gradients, warnings, viewport, parentDisplayed, depth) {
  if (depth > MAX_DEPTH) fail(`the document is nested more than ${MAX_DEPTH} levels.`);
  const tag = element.localName || element.nodeName;
  if (["defs", "title", "desc", "metadata", "linearGradient", "radialGradient", "stop"].includes(tag))
    return null;
  const style = styleFor(element, inherited, warnings);
  const displayed = parentDisplayed && style.display !== "none";
  validateAttributes(element, warnings);
  if (["g", "a"].includes(tag) || tag === "svg") {
    if (tag === "a") warnings.add("SVG anchor behavior is dropped; the enclosed drawing remains editable.");
    if (tag === "svg") fail("Nested <svg> viewports are unsupported.");
    const children = childElements(element)
      .map((child) => parseElement(child, style, gradients, warnings, viewport, displayed, depth + 1))
      .filter(Boolean);
    if (!children.length) {
      warnings.add("An empty SVG group was skipped.");
      return null;
    }
    const contentBounds = unionBounds(children.map((child) => child.extent));
    const transform = parseTransform(getAttribute(element, "transform"));
    const extent = transformBounds(transform, contentBounds);
    const id = getAttribute(element, "id");
    const opacity = parseOpacity(style, "opacity");
    const fill = gradientPaint(style, gradients, warnings, "fill", "fill-opacity");
    const stroke = gradientPaint(style, gradients, warnings, "stroke", "stroke-opacity");
    const strokeWidth = parseLength(style["stroke-width"], 1, Math.hypot(viewport.width, viewport.height) / Math.SQRT2, "group stroke-width");
    if (strokeWidth < 0 || strokeWidth > 10_000) fail("group stroke-width must be from 0 to 10,000.");
    unsupportedStrokeAndTextStyle(style, warnings, "group");
    return {
      kind: "group",
      tag,
      name: (id || "Group").slice(0, 256),
      transform,
      contentBounds,
      extent,
      children,
      properties: {
        name: (id || "Group").slice(0, 256),
        opacity,
        fill,
        stroke,
        strokeWidth,
        visible: true,
        blendMode: blendMode(style, warnings),
      },
      displayed,
    };
  }
  const shape = parseShape(element, style, gradients, warnings, viewport);
  if (!shape) return null;
  shape.displayed = displayed;
  shape.extent = transformBounds(shape.transform, shape.bounds);
  return shape;
}

function flattenNodes(nodes, parentId, parentBounds, prefix, output) {
  for (const node of nodes) {
    if (!node.displayed) continue;
    if (output.length >= MAX_LAYERS) fail(`the SVG contains more than ${MAX_LAYERS} layers.`);
    const width = Math.max(0.001, node.kind === "group" ? node.contentBounds.width : node.properties.width);
    const height = Math.max(0.001, node.kind === "group" ? node.contentBounds.height : node.properties.height);
    const parentOffset = multiply(IDENTITY, translate(-parentBounds.x, -parentBounds.y));
    let matrix;
    if (node.kind === "group") {
      matrix = multiply(
        parentOffset,
        multiply(prefix, multiply(node.transform, translate(node.contentBounds.x, node.contentBounds.y))),
      );
      const properties = layerTransform(matrix, width, height);
      const layer = createLayer("group", {
        ...node.properties,
        // SVG group paints are inherited by children, never a painted group box.
        inactiveBoxStyles: ["fill", "stroke", "corners"],
        ...properties,
        parentId,
        width,
        height,
      });
      output.push(layer);
      flattenNodes(node.children, layer.id, node.contentBounds, IDENTITY, output);
      continue;
    }
    if (node.pathAbsolute) {
      matrix = multiply(parentOffset, multiply(prefix, node.transform));
    } else {
      matrix = multiply(
        parentOffset,
        multiply(prefix, multiply(node.transform, translate(node.bounds.x, node.bounds.y))),
      );
    }
    const properties = layerTransform(matrix, width, height);
    output.push(
      createLayer(node.type, {
        ...node.properties,
        ...properties,
        parentId,
        width,
        height,
      }),
    );
  }
}

function layerTransform(matrix, width, height) {
  if (width > 65_536 || height > 65_536)
    fail("an imported layer exceeds the 65,536-pixel project limit.");
  let properties;
  try {
    properties = transformProperties(matrix, width, height);
  } catch {
    fail("zero-scale or singular transforms cannot be imported.");
  }
  if (
    !Number.isFinite(properties.x) ||
    !Number.isFinite(properties.y) ||
    Math.abs(properties.x) > 1_000_000 ||
    Math.abs(properties.y) > 1_000_000 ||
    Math.abs(properties.rotation) > 360_000 ||
    Math.abs(properties.scaleX) > 1_000 ||
    Math.abs(properties.scaleY) > 1_000 ||
    Math.abs(properties.skewX) >= 89.999
  )
    fail("a transformed layer is outside the supported project limits.");
  return properties;
}

function parseDocument(text, ParserCtor) {
  if (typeof text !== "string") fail("source must be text.");
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_SOURCE_BYTES) fail(`source exceeds ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.`);
  if (/<!\s*(?:doctype|entity)\b/i.test(text))
    fail("DOCTYPE and entity declarations are not allowed.");
  if (typeof ParserCtor !== "function") fail("an XML DOMParser is unavailable.");
  const errors = [];
  const parseWarnings = [];
  let document;
  try {
    const parser = new ParserCtor({
      onError(level, message) {
        if (String(level).toLowerCase().includes("warning")) parseWarnings.push(String(message));
        else errors.push(String(message));
      },
    });
    document = parser.parseFromString(text, "image/svg+xml");
  } catch {
    fail("XML is malformed or could not be parsed.");
  }
  if (errors.length) fail("XML is malformed.");
  const root = document?.documentElement;
  if (!root || (root.localName || root.nodeName) === "parsererror" || root.getElementsByTagName?.("parsererror")?.length)
    fail("XML is malformed.");
  const rootName = root.localName || root.nodeName;
  if (rootName !== "svg") fail("the document root must be <svg>.");
  const namespace = root.namespaceURI;
  if (namespace && namespace !== SVG_NS) fail("the root element must use the SVG namespace.");
  return { root, parseWarnings };
}

/**
 * Import a conservative, editable subset of SVG without inserting the source
 * into a browser document. Unsupported features either fail or appear in the
 * returned warnings so a caller can show the fidelity limits.
 */
export function importSvg(text, { name = "Imported SVG", explicit = false, DOMParser: parserCtor = globalThis.DOMParser } = {}) {
  const { root, parseWarnings } = parseDocument(text, parserCtor);
  const warnings = new Set(parseWarnings.length ? ["XML parser reported non-fatal syntax warnings."] : []);
  inspectTree(root);
  const viewBox = parseViewBox(getAttribute(root, "viewBox"));
  const dimensions = rootDimensions(root, viewBox, warnings);
  const viewport = {
    width: viewBox?.width ?? dimensions.width,
    height: viewBox?.height ?? dimensions.height,
  };
  const rootStyle = styleFor(root, {}, warnings);
  validateAttributes(root, warnings);
  const gradients = gradientDefinitions(root, warnings);
  const rootTransform = parseTransform(getAttribute(root, "transform"));
  const rootMatrix = rootViewBoxMatrix(
    viewBox,
    dimensions.width,
    dimensions.height,
    root,
    rootTransform,
  );
  if (parseOpacity(rootStyle, "opacity") !== 1)
    warnings.add("Root SVG opacity is applied to top-level layers; overlapping content may blend differently.");
  const displayed = rootStyle.display !== "none";
  const nodes = childElements(root)
    .map((element) => parseElement(element, rootStyle, gradients, warnings, viewport, displayed, 1))
    .filter(Boolean);
  const layers = [];
  flattenNodes(nodes, null, { x: 0, y: 0 }, rootMatrix, layers);
  if (!layers.length) fail("the SVG contains no supported visible vector shapes.");
  if (layers.length > MAX_LAYERS) fail(`the SVG contains more than ${MAX_LAYERS} layers.`);
  if (rootStyle.opacity !== "1") {
    const rootOpacity = parseOpacity(rootStyle, "opacity");
    for (const layer of layers.filter((item) => item.parentId === null))
      layer.opacity *= rootOpacity;
  }
  const roots = layers.filter((layer) => layer.parentId === null);
  if (explicit && name) {
    // A name the caller chose always lands on the top-level layers (even ones with their own id):
    // one layer gets the name, several get "<name>", "<name> 2", "<name> 3" in drawing order.
    roots.forEach((layer, index) => { layer.name = (index === 0 ? String(name) : `${name} ${index + 1}`).slice(0, 256); });
  } else if (name && !getAttribute(root, "id") && roots.length === 1) {
    const first = layers.find((layer) => layer.parentId === null);
    if (first && ["Group", "rect", "circle", "ellipse", "line", "polygon", "polyline", "path", "text", "a"].includes(first.name))
      first.name = String(name).slice(0, 256);
  }
  return {
    layers,
    width: dimensions.width,
    height: dimensions.height,
    warnings: [...warnings],
  };
}

/** Moves the top-level layers of an imported SVG; child layers stay relative to their group. */
export function moveRootLayers(layers, dx, dy) {
  if (!dx && !dy) return layers;
  return layers.map((layer) => (layer.parentId ? layer : { ...layer, x: layer.x + dx, y: layer.y + dy }));
}
