import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_ELEMENTS = 100_000;
const MAX_TREE_DEPTH = 64;
const MAX_DEPENDENCY_ELEMENTS = 2_048;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ATTRIBUTE_LENGTH = 512 * 1024;
const MAX_COORDINATE = 1_000_000;

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;
const FORBIDDEN_ELEMENTS = new Set([
  "script", "foreignObject", "style", "image", "text", "tspan", "textPath", "switch",
  "a", "view", "symbol", "marker", "mask", "filter", "pattern", "feBlend", "feColorMatrix",
  "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
  "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset",
  "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "animate",
  "animateMotion", "animateTransform", "set", "discard", "mpath", "color-profile",
]);
const ALLOWED_ELEMENTS = new Set([
  "svg", "defs", "g", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop", "clipPath",
]);
const PRESENTATION_ATTRIBUTES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "color",
  "display", "visibility", "clip-path", "clip-rule", "paint-order", "vector-effect", "shape-rendering",
]);
const ELEMENT_ATTRIBUTES = {
  svg: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "overflow", "version"]),
  defs: new Set(["id"]),
  g: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform"]),
  use: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "x", "y", "width", "height", "href", "xlink:href"]),
  path: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "d"]),
  rect: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "x", "y", "width", "height", "rx", "ry"]),
  circle: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "cx", "cy", "r"]),
  ellipse: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "cx", "cy", "rx", "ry"]),
  line: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "x1", "y1", "x2", "y2"]),
  polyline: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "points"]),
  polygon: new Set([...PRESENTATION_ATTRIBUTES, "id", "transform", "points"]),
  linearGradient: new Set([
    "id", "x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod",
    "href", "xlink:href",
  ]),
  radialGradient: new Set([
    "id", "cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod",
    "href", "xlink:href",
  ]),
  stop: new Set(["id", "offset", "stop-color", "stop-opacity"]),
  clipPath: new Set(["id", "clipPathUnits", "transform"]),
};
const NUMBER_ATTRIBUTES = new Set([
  "x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2",
  "fx", "fy", "fr", "stroke-width", "stroke-miterlimit", "stroke-dashoffset", "opacity",
  "fill-opacity", "stroke-opacity", "stop-opacity",
]);

function fail(message) {
  throw new Error("Unsafe color glyph SVG: " + message);
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isElement(node) {
  return node?.nodeType === 1;
}

function elementChildren(node) {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (isElement(child)) result.push(child);
  }
  return result;
}

function localName(node) {
  return node.localName || node.nodeName?.split(":").at(-1) || "";
}

function attrName(attribute) {
  if (attribute.namespaceURI === XLINK_NS && localName(attribute) === "href") return "xlink:href";
  return attribute.nodeName;
}

function hasAncestor(node, possibleAncestor) {
  for (let current = node?.parentNode; current; current = current.parentNode) {
    if (current === possibleAncestor) return true;
  }
  return false;
}

function isInside(node, ancestor) {
  for (let current = node; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function parseNumber(value, path) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim()))
    fail(path + " must use plain SVG design-unit numbers");
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_COORDINATE) fail(path + " is outside safe numeric limits");
  return number;
}

function validateNumberList(value, path, { allowPercent = false, maxItems = 128 } = {}) {
  const parts = value.trim().split(/[\s,]+/u).filter(Boolean);
  if (!parts.length || parts.length > maxItems) fail(path + " has an invalid number list");
  for (const part of parts) {
    if (allowPercent && /^[-+]?(?:\d+\.?\d*|\.\d+)%$/u.test(part)) {
      const n = Number(part.slice(0, -1));
      if (!Number.isFinite(n) || Math.abs(n) > 100_000) fail(path + " is outside safe numeric limits");
    } else {
      parseNumber(part, path);
    }
  }
}

function validateTransform(value, path) {
  const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
  const functionPattern = new RegExp("(matrix|translate|scale|rotate|skewX|skewY)\\s*\\(([^()]*)\\)", "giu");
  let cursor = 0;
  let match;
  while ((match = functionPattern.exec(value))) {
    if (value.slice(cursor, match.index).replace(/[\s,]+/gu, "")) fail(path + " uses an unsupported transform");
    const args = match[2].trim().split(/[\s,]+/u).filter(Boolean);
    const expected = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] }[match[1]];
    if (!expected.includes(args.length)) fail(path + " has invalid " + match[1] + " arguments");
    for (const arg of args) {
      if (!new RegExp("^" + number + "$", "iu").test(arg)) fail(path + " has invalid numeric transform arguments");
      const n = Number(arg);
      if (!Number.isFinite(n) || Math.abs(n) > MAX_COORDINATE) fail(path + " is outside safe transform limits");
    }
    cursor = functionPattern.lastIndex;
  }
  if (!cursor || value.slice(cursor).replace(/[\s,]+/gu, "")) fail(path + " uses an unsupported transform");
}

function extractReferences(value, path) {
  const refs = [];
  const urlPattern = /url\s*\(([^)]*)\)/giu;
  let match;
  let cursor = 0;
  while ((match = urlPattern.exec(value))) {
    const between = value.slice(cursor, match.index);
    if (/url\s*\(/iu.test(between)) fail(path + " contains a malformed paint reference");
    const ref = match[1].trim().replace(/^(['"])(.*)\1$/u, "$2");
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(ref)) fail(path + " contains an external or invalid URL reference");
    refs.push({ id: ref.slice(1), kind: "url", attribute: path.split(".").at(-1) });
    cursor = urlPattern.lastIndex;
  }
  const remainder = value.slice(cursor);
  if (/url\s*\(/iu.test(remainder) || /https?:|data:|javascript:|file:|\/\//iu.test(value))
    fail(path + " contains an external or malformed URL");
  return refs;
}

function validateColor(value, path, { allowUrl = false } = {}) {
  if (/^url\s*\(/iu.test(value)) {
    if (allowUrl) return;
    fail(path + " cannot use a paint-server URL");
  }
  if (value === "none" || value === "transparent") return;
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value)) return;
  if (/^[a-z]+$/iu.test(value) &&
      !/^(?:currentColor|context-fill|context-stroke|inherit|initial|unset|revert|revert-layer)$/iu.test(value))
    return;
  if (/^rgba?\(\s*[\d.%+\-,\s]+\)$/iu.test(value)) return;
  fail(path + " uses an unsupported color value");
}

function validateAttributeValue(elementName, name, value, path) {
  if (value.length > MAX_ATTRIBUTE_LENGTH) fail(path + " is too long");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(path + " contains control characters");
  if (name === "id") {
    if (!SAFE_ID.test(value)) fail(path + " is not a safe local ID");
    return;
  }
  if (name === "transform" || name === "gradientTransform") {
    validateTransform(value, path);
    return;
  }
  if (name === "points") {
    validateNumberList(value, path, { maxItems: 4096 });
    if (value.trim().split(/[\s,]+/u).filter(Boolean).length % 2 !== 0) fail(path + " must contain coordinate pairs");
    return;
  }
  if (name === "d") {
    if (!value.trim() || !/^[MmZzLlHhVvCcSsQqTtAa0-9eE+\-.,\s]*$/u.test(value))
      fail(path + " has invalid path data");
    const pathNumbers = value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/giu) || [];
    if (pathNumbers.length > 100_000) fail(path + " contains too many path coordinates");
    for (const number of pathNumbers) parseNumber(number, path);
    return;
  }
  if (name === "fill" || name === "stroke" || name === "stop-color") {
    validateColor(value.trim(), path, { allowUrl: name === "fill" || name === "stroke" });
    return;
  }
  if (name === "clip-path") {
    if (value !== "none" && !/^url\s*\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/iu.test(value))
      fail(path + " must be none or a local clip path");
    return;
  }
  if (name === "gradientUnits" || name === "clipPathUnits") {
    if (value !== "userSpaceOnUse" && value !== "objectBoundingBox") fail(path + " has an unsupported unit mode");
    return;
  }
  if (name === "spreadMethod") {
    if (!new Set(["pad", "reflect", "repeat"]).has(value)) fail(path + " has an unsupported gradient spread method");
    return;
  }
  if (name === "offset") {
    validateNumberList(value, path, { allowPercent: true, maxItems: 1 });
    const part = value.trim();
    const offset = Number(part.endsWith("%") ? part.slice(0, -1) : part);
    if (offset < 0 || offset > (part.endsWith("%") ? 100 : 1)) fail(path + " must be from 0 to 1 or 0% to 100%");
    return;
  }
  if (NUMBER_ATTRIBUTES.has(name)) {
    const gradientCoordinate = ["linearGradient", "radialGradient"].includes(elementName) &&
      ["x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy", "fr"].includes(name);
    validateNumberList(value, path, { allowPercent: gradientCoordinate, maxItems: 1 });
    const number = Number(value.trim());
    if (["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(name) &&
        (!Number.isFinite(number) || number < 0 || number > 1))
      fail(path + " must be from 0 to 1");
    if (["width", "height", "rx", "ry", "r", "fr", "stroke-width"].includes(name) && number < 0)
      fail(path + " cannot be negative");
    return;
  }
  if (name === "stroke-dasharray") {
    if (value !== "none") validateNumberList(value, path, { maxItems: 256 });
    return;
  }
  if (name === "stroke-linecap") {
    if (!new Set(["butt", "round", "square"]).has(value)) fail(path + " has an unsupported line cap");
    return;
  }
  if (name === "stroke-linejoin") {
    if (!new Set(["miter", "round", "bevel"]).has(value)) fail(path + " has an unsupported line join");
    return;
  }
  if (name === "fill-rule" || name === "clip-rule") {
    if (value !== "nonzero" && value !== "evenodd") fail(path + " has an unsupported fill rule");
    return;
  }
  if (name === "display") {
    if (value !== "none" && value !== "inline") fail(path + " has an unsupported display value");
    return;
  }
  if (name === "visibility") {
    if (!new Set(["visible", "hidden", "collapse"]).has(value)) fail(path + " has an unsupported visibility value");
    return;
  }
  if (name === "overflow") {
    if (!new Set(["visible", "hidden"]).has(value)) fail(path + " has an unsupported overflow value");
    return;
  }
  if (name === "vector-effect") {
    if (value !== "none" && value !== "non-scaling-stroke") fail(path + " has an unsupported vector effect");
    return;
  }
  if (name === "shape-rendering" || name === "paint-order") {
    if (!/^[a-z -]+$/iu.test(value)) fail(path + " has an unsupported presentation value");
    return;
  }
  if (name === "href" || name === "xlink:href") {
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value)) fail(path + " must reference a local ID");
    return;
  }
  if (name === "color") {
    validateColor(value.trim(), path);
    return;
  }
  if (name === "version") {
    if (!new Set(["1.1", "1.2"]).has(value)) fail(path + " must be 1.1 or 1.2");
    return;
  }
  if (elementName === "use" && ["x", "y", "width", "height"].includes(name)) return;
}

function getAttributes(element, { root = false } = {}) {
  const name = localName(element);
  const allowed = ELEMENT_ATTRIBUTES[name];
  if (!allowed) fail("unsupported element <" + name + ">");
  const values = [];
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    const key = attrName(attribute);
    const value = attribute.value;
    if (key === "xmlns" || key === "xmlns:xlink") continue;
    if (key.toLowerCase().startsWith("on") || key.toLowerCase() === "style" || key.toLowerCase() === "class")
      fail("CSS or event attribute " + key + " is not allowed");
    if (attribute.namespaceURI && attribute.namespaceURI !== XLINK_NS)
      fail("namespaced attribute " + key + " is not allowed");
    if (attribute.namespaceURI === XLINK_NS && key !== "xlink:href") fail("xlink attribute " + key + " is not allowed");
    if (key === "xlink:href" && attribute.namespaceURI !== XLINK_NS) fail("xlink:href must use the XLink namespace");
    if (root && new Set(["viewBox", "width", "height", "preserveAspectRatio", "x", "y"]).has(key))
      fail("root " + key + " changes the SVG viewport; only OpenType design coordinates are supported");
    if (!allowed.has(key)) fail("unsupported " + name + " attribute " + key);
    validateAttributeValue(name, key, value, "<" + name + ">." + key);
    values.push({ key, value });
  }
  return values;
}

function validateChildren(element, path, depth, state) {
  if (depth > MAX_TREE_DEPTH) fail("source nesting exceeds " + MAX_TREE_DEPTH + " levels");
  if (++state.elementCount > MAX_SOURCE_ELEMENTS) fail("source contains more than " + MAX_SOURCE_ELEMENTS + " elements");
  const name = localName(element);
  if (element.namespaceURI !== SVG_NS) fail(path + " is not in the SVG namespace");
  if (FORBIDDEN_ELEMENTS.has(name)) fail("unsupported or unsafe element <" + name + ">");
  if (name === "svg" && element !== state.root) fail("nested SVG elements are not supported");
  const attributes = getAttributes(element, { root: element === state.root });
  state.attributes.set(element, attributes);
  for (const attribute of attributes) {
    const refs = [];
    if (attribute.key === "href" || attribute.key === "xlink:href") {
      refs.push({ id: attribute.value.slice(1), kind: "href", attribute: attribute.key });
    } else {
      refs.push(...extractReferences(attribute.value, "<" + name + ">." + attribute.key));
    }
    if (refs.length) state.references.set(element, [...(state.references.get(element) || []), ...refs]);
  }
  if (element.hasAttribute("id")) {
    const id = element.getAttribute("id");
    if (state.ids.has(id)) fail("duplicate ID " + id);
    state.ids.set(id, element);
  }
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) {
      validateChildren(child, path + "/" + localName(child), depth + 1, state);
    } else if (child.nodeType === 3) {
      if (child.data.trim()) fail(path + " contains text content");
    } else if (child.nodeType === 8) {
      // Comments are inert and are never copied into the sanitized result.
    } else {
      fail(path + " contains unsupported XML content");
    }
  }
}

function makeParser() {
  return new DOMParser({
    onError(level, message) {
      if (level === "error" || level === "fatalError") fail("invalid XML: " + message);
    },
  });
}

function findGlyph(state, glyphId) {
  if (!Number.isInteger(glyphId) || glyphId < 0 || glyphId > 65_535)
    fail("glyph ID must be an integer from 0 to 65535");
  const glyph = state.ids.get("glyph" + glyphId);
  if (!glyph) fail("glyph" + glyphId + " was not found");
  if (glyph === state.root) fail("the SVG document root cannot be used as a glyph");
  return glyph;
}

function validateReferenceTarget(source, ref, target) {
  const targetName = localName(target);
  const sourceName = localName(source);
  if (ref.kind === "href") {
    if (sourceName === "use" && !new Set(["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "use"]).has(targetName))
      fail("use references unsupported <" + targetName + ">");
    if ((sourceName === "linearGradient" && targetName !== "linearGradient") ||
        (sourceName === "radialGradient" && targetName !== "radialGradient"))
      fail("gradient href must reference the same gradient type");
    if (sourceName !== "use" && sourceName !== "linearGradient" && sourceName !== "radialGradient")
      fail("href is unsupported on <" + sourceName + ">");
  } else if (ref.attribute === "clip-path") {
    if (targetName !== "clipPath") fail("clip-path must reference a clipPath");
  } else if (targetName !== "linearGradient" && targetName !== "radialGradient") {
    fail("paint URL must reference a linearGradient or radialGradient");
  }
}

function isDescendantOrSelf(node, ancestor) {
  return isInside(node, ancestor);
}

function createOutputDocument() {
  const doc = makeParser().parseFromString('<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '"/>', "image/svg+xml");
  if (!doc.documentElement || doc.documentElement.namespaceURI !== SVG_NS) fail("could not create sanitized SVG document");
  return doc;
}

function copySafeAttributes(source, destination, state) {
  const name = localName(source);
  for (const { key, value } of state.attributes.get(source) || []) {
    if (key === "id" && !SAFE_ID.test(value)) fail("unsafe local ID");
    if (key === "xlink:href") destination.setAttributeNS(XLINK_NS, "xlink:href", value);
    else if (key !== "xmlns" && key !== "xmlns:xlink") destination.setAttribute(key, value);
  }
  if (name === "use") {
    const hasHref = source.hasAttribute("href") || source.hasAttributeNS(XLINK_NS, "href");
    if (!hasHref) fail("use elements must have a local href");
  }
  if (name === "linearGradient" || name === "radialGradient") {
    if (!source.hasAttribute("id")) fail(name + " elements need an ID");
    if (elementChildren(source).filter((child) => localName(child) === "stop").length < 2 &&
        !source.hasAttribute("href") && !source.hasAttributeNS(XLINK_NS, "href"))
      fail(name + " must have at least two stops or inherit them through href");
  }
  if (name === "clipPath" && !source.hasAttribute("id")) fail("clipPath elements need an ID");
}

function cloneSubtree(source, destinationParent, doc, state, copied, { omitDefs = true } = {}) {
  if (!isElement(source)) return null;
  const name = localName(source);
  if (omitDefs && name === "defs") return null;
  if (!ALLOWED_ELEMENTS.has(name) || FORBIDDEN_ELEMENTS.has(name)) fail("unsupported element <" + name + "> in selected glyph or dependencies");
  let clone = copied.get(source);
  if (!clone) {
    clone = doc.createElementNS(SVG_NS, name);
    copied.set(source, clone);
    copySafeAttributes(source, clone, state);
  } else if (clone.parentNode && clone.parentNode !== destinationParent) {
    return clone;
  }
  if (!clone.parentNode) destinationParent.appendChild(clone);
  if (!clone.__sanitizedChildrenCopied) {
    Object.defineProperty(clone, "__sanitizedChildrenCopied", { value: true, configurable: true });
    for (const child of elementChildren(source)) cloneSubtree(child, clone, doc, state, copied, { omitDefs });
  }
  return clone;
}

function collectSubtreeElements(root, { omitDefs = true } = {}) {
  const result = [];
  const visit = (element) => {
    if (!isElement(element) || (omitDefs && localName(element) === "defs")) return;
    result.push(element);
    for (const child of elementChildren(element)) visit(child);
  };
  visit(root);
  return result;
}

function validateGlyphClosure(state, glyph) {
  const glyphElements = new Set(collectSubtreeElements(glyph));
  const dependencyIds = new Set();
  const active = new Set();
  let dependencyElementCount = 0;
  const dependencyRoots = new Set();
  for (let parent = glyph.parentNode; isElement(parent) && parent !== state.root; parent = parent.parentNode) {
    if (/^glyph\d+$/u.test(parent.getAttribute?.("id") || ""))
      fail("selected glyph is nested inside a different glyph");
  }
  for (const element of glyphElements) {
    const id = element.getAttribute?.("id") || "";
    if (element !== glyph && /^glyph\d+$/u.test(id))
      fail("selected glyph contains a nested glyph");
  }

  function visitReference(id, source, ref) {
    const target = state.ids.get(id);
    if (!target) fail("reference #" + id + " does not exist");
    validateReferenceTarget(source, ref, target);
    if (/^glyph\d+$/u.test(id) && target !== glyph) fail("glyphs cannot be dependencies");
    if (hasAncestor(source, target)) fail("cyclic reference through #" + id);
    if (glyphElements.has(target)) return;
    visitDependency(id, target);
  }

  function visitDependency(id, target) {
    if (active.has(id)) fail("cyclic reference through #" + id);
    if (dependencyIds.has(id)) return;
    active.add(id);
    dependencyIds.add(id);
    let root = target;
    for (let parent = target.parentNode; isElement(parent) && localName(parent) !== "defs" && parent !== state.root; parent = parent.parentNode) {
      const parentName = localName(parent);
      if (parentName !== "g") fail("reference #" + id + " has an unsupported definition container <" + parentName + ">");
      if (/^glyph\d+$/u.test(parent.getAttribute?.("id") || ""))
        fail("glyphs cannot be dependencies");
      root = parent;
    }
    if (root === state.root) fail("reference #" + id + " is not inside a supported definition");
    if (dependencyRoots.has(root)) {
      active.delete(id);
      return;
    }
    dependencyRoots.add(root);
    const included = collectSubtreeElements(root);
    for (const element of included) {
      if (/^glyph\d+$/u.test(element.getAttribute?.("id") || ""))
        fail("glyphs cannot be dependencies");
    }
    dependencyElementCount += included.length;
    if (dependencyElementCount > MAX_DEPENDENCY_ELEMENTS)
      fail("dependency closure exceeds " + MAX_DEPENDENCY_ELEMENTS + " elements");
    for (const element of included) {
      for (const nestedRef of state.references.get(element) || []) {
        const nestedTarget = state.ids.get(nestedRef.id);
        if (!nestedTarget) fail("reference #" + nestedRef.id + " does not exist");
        validateReferenceTarget(element, nestedRef, nestedTarget);
        if (/^glyph\d+$/u.test(nestedRef.id)) fail("glyphs cannot be dependencies");
        if (isDescendantOrSelf(nestedTarget, root)) {
          if (hasAncestor(element, nestedTarget)) fail("cyclic reference through #" + nestedRef.id);
          continue;
        }
        visitDependency(nestedRef.id, nestedTarget);
      }
    }
    active.delete(id);
  }

  for (const element of glyphElements) {
    for (const ref of state.references.get(element) || []) visitReference(ref.id, element, ref);
  }
  return { dependencyRoots, glyphElements, dependencyElementCount };
}

function addAncestorShells(target, until, destination, doc, state, copied, { skipDefs = true } = {}) {
  const chain = [];
  for (let parent = target.parentNode; isElement(parent) && parent !== until; parent = parent.parentNode) {
    const name = localName(parent);
    if (skipDefs && name === "defs") break;
    if (name !== "g") fail("glyph or referenced element has unsupported ancestor <" + name + ">");
    chain.push(parent);
  }
  let current = destination;
  for (const source of chain.reverse()) {
    let clone = copied.get(source);
    if (!clone) {
      clone = doc.createElementNS(SVG_NS, "g");
      copied.set(source, clone);
      copySafeAttributes(source, clone, state);
    }
    if (!clone.parentNode) current.appendChild(clone);
    current = clone;
  }
  return current;
}

function buildSvg(state, glyph, closure, metrics) {
  const { unitsPerEm, ascent, descent, advanceWidth } = metrics || {};
  for (const [name, value] of Object.entries({ unitsPerEm, ascent, descent, advanceWidth })) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE)
      fail("metrics." + name + " must be a finite design-unit number");
  }
  if (unitsPerEm <= 0 || advanceWidth <= 0 || ascent - descent <= 0)
    fail("font metrics must describe a positive design-space viewport");

  const doc = createOutputDocument();
  const root = doc.documentElement;
  root.setAttribute("version", "1.1");
  root.setAttribute("viewBox", "0 " + (-ascent) + " " + advanceWidth + " " + (ascent - descent));
  root.setAttribute("width", String(advanceWidth));
  root.setAttribute("height", String(ascent - descent));
  root.setAttribute("overflow", "visible");
  const copied = new Map();
  const defs = doc.createElementNS(SVG_NS, "defs");
  if (closure.dependencyRoots.size > 0) root.appendChild(defs);

  // Root SVG presentation/transform attributes inherit into the selected glyph.
  for (const { key, value } of state.attributes.get(state.root) || []) {
    if (key === "id" || key === "overflow") continue;
    if (key === "xlink:href") fail("root cannot use xlink:href");
    root.setAttribute(key, value);
  }

  for (const dependencyRoot of closure.dependencyRoots) {
    const parent = addAncestorShells(dependencyRoot, state.root, defs, doc, state, copied);
    cloneSubtree(dependencyRoot, parent, doc, state, copied);
  }

  const glyphParent = addAncestorShells(glyph, state.root, root, doc, state, copied);
  cloneSubtree(glyph, glyphParent, doc, state, copied);

  const svg = new XMLSerializer().serializeToString(doc);
  if (byteLength(svg) > MAX_OUTPUT_BYTES) fail("sanitized SVG exceeds " + MAX_OUTPUT_BYTES + " bytes");
  return { svg, x: 0, y: -ascent, width: advanceWidth, height: ascent - descent };
}

export function createColorGlyphSvgSanitizer(source) {
  if (typeof source !== "string") fail("source must be decompressed SVG text");
  if (byteLength(source) > MAX_SOURCE_BYTES) fail("source exceeds " + MAX_SOURCE_BYTES + " bytes");
  if (/<!\s*(?:doctype|entity)\b|<\?xml-stylesheet\b/iu.test(source))
    fail("DOCTYPE, entities, and XML stylesheets are not allowed");
  let document;
  try {
    document = makeParser().parseFromString(source, "image/svg+xml");
  } catch (error) {
    fail("invalid XML (" + (error?.message || "parse failed") + ")");
  }
  if (!document?.documentElement || document.documentType) fail("document must contain one SVG root and no document type");
  for (let child = document.firstChild; child; child = child.nextSibling) {
    if (child === document.documentElement || child.nodeType === 8) continue;
    if (child.nodeType === 3 && !child.data.trim()) continue;
    fail("document-level processing instructions and other XML nodes are not allowed");
  }
  const root = document.documentElement;
  if (localName(root) !== "svg" || root.namespaceURI !== SVG_NS) fail("document root must be an SVG element");
  const state = {
    root,
    ids: new Map(),
    attributes: new Map(),
    references: new Map(),
    elementCount: 0,
  };
  validateChildren(root, "svg", 1, state);
  for (const [sourceNode, refs] of state.references) {
    for (const ref of refs) {
      const target = state.ids.get(ref.id);
      if (!target) fail("reference #" + ref.id + " does not exist");
      validateReferenceTarget(sourceNode, ref, target);
    }
  }

  return (glyphId, metrics) => {
    const glyph = findGlyph(state, glyphId);
    const closure = validateGlyphClosure(state, glyph);
    return buildSvg(state, glyph, closure, metrics);
  };
}

export function sanitizeColorGlyphSvg(source, glyphId, metrics) {
  return createColorGlyphSvgSanitizer(source)(glyphId, metrics);
}
