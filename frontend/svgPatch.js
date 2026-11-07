// Brings the live preview's SVG on the page up to date with a newly drawn one (renderSceneSvg),
// changing only what differs, so the <video> elements in it keep playing instead of being made
// again (a new element loads and seeks, and shows nothing until it has).
//
// Children are matched by the layer they draw (data-layer-id), not by their place: when a layer
// shows or hides, the layers after it move one place, and matching by place compared each with
// its neighbor, so a video next to a layer that just appeared was replaced and loaded again
// (in a sample edit, a tile ring's videos were made four times in two seconds).
//
// Uses only the plain DOM methods that @xmldom/xmldom also has, so it can be tested in Node.

const ELEMENT = 1, TEXT = 3;

/** Pauses every <video> and <audio> in `node` (itself included). */
export function stopMedia(node) {
  if (node?.nodeType !== ELEMENT) return;
  if (node.localName === "video" || node.localName === "audio") node.pause?.();
  for (const tag of ["video", "audio"])
    for (const media of [...(node.getElementsByTagName?.(tag) ?? [])]) media.pause?.();
}

// The same kind of node: the same type, tag and namespace. Not nodeName: the page's copy of an
// HTML element (the <video> inside a <foreignObject>) is named "VIDEO", the newly parsed SVG
// document's "video", and that difference replaced the video element on every new frame.
const sameKind = (current, next) => current.nodeType === next.nodeType &&
  current.localName === next.localName && current.namespaceURI === next.namespaceURI;

function firstElement(node) {
  for (const child of node.childNodes) if (child.nodeType === ELEMENT) return child;
  return null;
}

/**
 * What a child is matched by: its layer ("layer:<id>"), or for a wrapper without one (a mask's
 * or a clip's <g> around a layer) its tag and the layer inside it. Null for other nodes (the
 * definitions, the background), which are matched by their order among such nodes.
 */
export function childKey(node) {
  if (node.nodeType !== ELEMENT) return null;
  const id = node.getAttribute("data-layer-id");
  if (id) return `layer:${id}`;
  const inner = firstElement(node)?.getAttribute("data-layer-id");
  return inner ? `${node.localName}>${inner}` : null;
}

function remove(node) {
  stopMedia(node);
  node.parentNode?.removeChild(node);
}

/** Changes `current` (on the page) to look like `next` (newly parsed), keeping matching nodes. */
export function updateSvgNode(current, next) {
  if (!sameKind(current, next)) {
    stopMedia(current);
    current.parentNode.replaceChild(next.cloneNode(true), current);
    return;
  }
  if (current.nodeType === TEXT) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  if (current.nodeType !== ELEMENT) return;
  // Most of a playing scene is the same as in the frame before. The browser compares a whole
  // branch much faster than this walk, so an unchanged branch is skipped.
  if (current.isEqualNode?.(next)) return;
  for (const attribute of [...current.attributes])
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of [...next.attributes])
    if (current.getAttribute(attribute.name) !== attribute.value)
      current.setAttribute(attribute.name, attribute.value);
  updateChildren(current, next);
}

function updateChildren(current, next) {
  const before = [...current.childNodes];
  const byKey = new Map(), plain = [];
  for (const node of before) {
    const key = childKey(node);
    if (key === null) plain.push(node);
    else if (!byKey.has(key)) byKey.set(key, node);
  }
  const used = new Set(), emptied = [];
  let nextPlain = 0;
  const after = [...next.childNodes];
  for (let index = 0; index < after.length; index++) {
    const wanted = after[index];
    const key = childKey(wanted);
    let match = key === null ? plain[nextPlain++] : byKey.get(key);
    if (match && used.has(match)) match = undefined;
    // The node now at this place; nodes before it are already the wanted ones.
    const here = current.childNodes[index] ?? null;
    const inner = key?.includes(">") ? key.slice(key.indexOf(">") + 1) : null;
    const bare = byKey.get(`layer:${inner}`);
    if (!match && inner && bare && !used.has(bare)) {
      // A mask or a clip now wraps a layer that was drawn without one (its mask switched on):
      // the layer moves into the new wrapper.
      used.add(bare);
      match = wanted.cloneNode(false);
      current.insertBefore(match, here);
      match.appendChild(bare);
      updateSvgNode(match, wanted);
      continue;
    }
    if (!match && key?.startsWith("layer:")) {
      // The other way: the wrapper went, and the layer inside it moves out.
      const id = key.slice("layer:".length);
      const wrapper = [...byKey].find(([other, node]) => other.endsWith(`>${id}`) && !used.has(node))?.[1];
      const layer = wrapper && firstElement(wrapper);
      if (layer && childKey(layer) === key) { used.add(wrapper); emptied.push(wrapper); match = layer; }
    }
    if (!match) {
      current.insertBefore(wanted.cloneNode(true), here);
      continue;
    }
    used.add(match);
    // A move keeps a playing video playing: it is out of the page for no time at all.
    if (match !== here) current.insertBefore(match, here);
    updateSvgNode(match, wanted);
  }
  for (const node of before) if (!used.has(node) && node.parentNode === current) remove(node);
  for (const wrapper of emptied) if (wrapper.parentNode === current) remove(wrapper);
}

// Playback draws a new SVG string every frame. Parsing all of it into a new document each time
// made a lot of garbage (the freezes of 1 to 2 s were garbage collection), so the page's nodes
// remember where they were in the last frame's markup: a branch whose markup is the same text
// is skipped, and only the parts that changed are parsed.
//
// Only the last frame's string is kept. Each node keeps its place as an offset from its
// parent's start, which stays right while the parent is unchanged (a parent that changes
// records its children again).

const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink",
  XHTML_NS = "http://www.w3.org/1999/xhtml";
// Page node -> { rel, length }: its markup's offset from its parent's start, and its length.
// Started again whenever the whole drawing is parsed.
let drawn = new WeakMap();
// Container -> the markup it showed last frame (each preview has its own).
const shownMarkup = new WeakMap();
let previousMarkup = "";

// Whether `current` already shows `node`. `previousParent` is the parent's start in the last
// frame's markup (-1: not known).
function unchanged(current, markup, node, previousParent) {
  const record = drawn.get(current);
  if (!record || previousParent < 0 || record.length !== node.end - node.start) return false;
  const start = previousParent + record.rel;
  return previousMarkup.slice(start, start + record.length) === markup.slice(node.start, node.end);
}

function previousStart(current, previousParent) {
  const record = drawn.get(current);
  return record && previousParent >= 0 ? previousParent + record.rel : -1;
}

function remember(current, node, parentStart) {
  const record = drawn.get(current);
  if (record) { record.rel = node.start - parentStart; record.length = node.end - node.start; }
  else drawn.set(current, { rel: node.start - parentStart, length: node.end - node.start });
}

// One tag: closing slash, name, attributes (quoted values may hold ">"), self-closing slash.
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"'/]|"[^"]*"|'[^']*'|\/(?!>))*)(\/?)>/y;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (value) => value.includes("&") ? value.replace(ENTITY, (_, hex, decimal, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : NAMED[name]) : value;
// As an XML parser reads an attribute: tabs and line breaks become spaces.
const attributeValue = (raw) => decode(raw.replace(/\r\n|[\t\n\r]/g, " "));

/**
 * The element tree of `markup` as offsets into it: { name, start, end, attributes, children }
 * and { text, start, end }. Null for anything this small reader does not handle (comments,
 * CDATA, unbalanced tags); the caller then parses the whole drawing.
 */
export function markupTree(markup) {
  const top = { children: [] };
  const stack = [top];
  let at = 0;
  while (at < markup.length) {
    const open = markup.indexOf("<", at);
    const textEnd = open < 0 ? markup.length : open;
    if (textEnd > at) stack[stack.length - 1].children.push({ text: true, start: at, end: textEnd });
    if (open < 0) break;
    TAG.lastIndex = open;
    const match = TAG.exec(markup);
    if (!match) return null;
    at = TAG.lastIndex;
    if (match[1]) {
      const node = stack.pop();
      if (stack.length === 0 || node.name !== match[2] || match[3].trim() || match[4]) return null;
      node.end = at;
      continue;
    }
    const node = { name: match[2], start: open, end: at, attributes: match[3], children: [] };
    stack[stack.length - 1].children.push(node);
    if (!match[4]) stack.push(node);
  }
  return stack.length === 1 && top.children.length === 1 && !top.children[0].text ? top.children[0] : null;
}

function attributesOf(node) {
  const values = new Map();
  for (const match of node.attributes.matchAll(ATTRIBUTE)) values.set(match[1], attributeValue(match[2] ?? match[3]));
  return values;
}

const layerIdOf = (node) => {
  const match = /(?:^|\s)data-layer-id\s*=\s*"([^"]*)"/.exec(node.attributes);
  return match ? attributeValue(match[1]) : null;
};

// childKey for a node of the new markup.
function markupKey(node) {
  if (node.text) return null;
  const id = layerIdOf(node);
  if (id) return `layer:${id}`;
  const first = node.children.find((child) => !child.text);
  const inner = first && layerIdOf(first);
  return inner ? `${node.name}>${inner}` : null;
}

// The namespace a new element gets: its own xmlns, or its parent's.
function namespaceOf(node, parent) {
  const match = /(?:^|\s)xmlns\s*=\s*"([^"]*)"/.exec(node.attributes);
  return match ? attributeValue(match[1]) : parent?.namespaceURI ?? SVG_NS;
}

// A new page node for `text` (one element or text), parsed inside a parent of the right kind.
function fresh(text, parent, Parser) {
  const html = parent?.namespaceURI === XHTML_NS;
  const wrapper = html ? `<div xmlns="${XHTML_NS}">` : `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">`;
  return new Parser().parseFromString(`${wrapper}${text}${html ? "</div>" : "</svg>"}`, "image/svg+xml").documentElement.firstChild;
}

function replace(current, markup, node, Parser, parentStart) {
  stopMedia(current);
  const next = fresh(markup.slice(node.start, node.end), current.parentNode, Parser);
  current.parentNode.replaceChild(next, current);
  remember(next, node, parentStart);
}

// `parentStart` is the parent's start in `markup`, `previousParent` in the last frame's.
function patchMarkupNode(current, markup, node, Parser, parentStart, previousParent) {
  if (unchanged(current, markup, node, previousParent)) { remember(current, node, parentStart); return; }
  const previous = previousStart(current, previousParent);
  if (node.text) {
    if (current.nodeType !== TEXT) { replace(current, markup, node, Parser, parentStart); return; }
    const value = decode(markup.slice(node.start, node.end).replace(/\r\n?/g, "\n"));
    if (current.nodeValue !== value) current.nodeValue = value;
    remember(current, node, parentStart);
    return;
  }
  if (current.nodeType !== ELEMENT || current.localName !== node.name ||
    current.namespaceURI !== namespaceOf(node, current.parentNode)) { replace(current, markup, node, Parser, parentStart); return; }
  const wanted = attributesOf(node);
  for (const attribute of [...current.attributes])
    if (!wanted.has(attribute.name)) current.removeAttribute(attribute.name);
  for (const [attribute, value] of wanted) {
    if (current.getAttribute(attribute) === value) continue;
    if (attribute === "xmlns" || attribute.startsWith("xmlns:")) { replace(current, markup, node, Parser, parentStart); return; }
    if (attribute.startsWith("xlink:")) current.setAttributeNS(XLINK_NS, attribute, value);
    else current.setAttribute(attribute, value);
  }
  patchMarkupChildren(current, markup, node, Parser, previous);
  remember(current, node, parentStart);
}

// updateChildren for new markup: the same matching, parsing only the nodes that are new.
// `previous` is this node's start in the last frame's markup.
function patchMarkupChildren(current, markup, node, Parser, previous) {
  const before = [...current.childNodes];
  const byKey = new Map(), plain = [];
  for (const child of before) {
    const key = childKey(child);
    if (key === null) plain.push(child);
    else if (!byKey.has(key)) byKey.set(key, child);
  }
  const used = new Set(), emptied = [];
  let nextPlain = 0;
  const after = node.children;
  for (let index = 0; index < after.length; index++) {
    const wanted = after[index];
    const key = markupKey(wanted);
    let match = key === null ? plain[nextPlain++] : byKey.get(key);
    if (match && used.has(match)) match = undefined;
    const here = current.childNodes[index] ?? null;
    const inner = key?.includes(">") ? key.slice(key.indexOf(">") + 1) : null;
    const bare = byKey.get(`layer:${inner}`);
    if (!match && inner && bare && !used.has(bare)) {
      // A mask or a clip now wraps a layer drawn without one: the layer moves into the wrapper.
      // Its place in the last frame was under another parent, so it is compared in full.
      used.add(bare);
      drawn.delete(bare);
      match = fresh(`<${wanted.name}${wanted.attributes}/>`, current, Parser);
      current.insertBefore(match, here);
      match.appendChild(bare);
      patchMarkupNode(match, markup, wanted, Parser, node.start, -1);
      continue;
    }
    if (!match && key?.startsWith("layer:")) {
      // The wrapper went, and the layer inside it moves out.
      const id = key.slice("layer:".length);
      const wrapper = [...byKey].find(([other, child]) => other.endsWith(`>${id}`) && !used.has(child))?.[1];
      const layer = wrapper && firstElement(wrapper);
      if (layer && childKey(layer) === key) { used.add(wrapper); emptied.push(wrapper); match = layer; drawn.delete(layer); }
    }
    if (!match) {
      const next = fresh(markup.slice(wanted.start, wanted.end), current, Parser);
      current.insertBefore(next, here);
      remember(next, wanted, node.start);
      continue;
    }
    used.add(match);
    if (match !== here) current.insertBefore(match, here);
    patchMarkupNode(match, markup, wanted, Parser, node.start, previous);
  }
  for (const child of before) if (!used.has(child) && child.parentNode === current) remove(child);
  for (const wrapper of emptied) if (wrapper.parentNode === current) remove(wrapper);
}

/**
 * Shows the SVG `markup` (renderSceneSvg) in `container`, changing only what differs from what
 * it shows now. Unchanged branches are found by comparing strings, and only new or replaced
 * nodes are parsed. `Parser` is DOMParser (the page's; tests pass @xmldom/xmldom's).
 */
export function patchSvgMarkup(container, markup, Parser = globalThis.DOMParser) {
  const current = container.firstChild;
  const tree = current ? markupTree(markup) : null;
  if (!tree) {
    drawn = new WeakMap();
    shownMarkup.delete(container);
    const next = new Parser().parseFromString(markup, "image/svg+xml").documentElement;
    if (current) updateSvgNode(current, next);
    else container.appendChild(next);
    return;
  }
  previousMarkup = shownMarkup.get(container) ?? "";
  shownMarkup.delete(container);
  try {
    patchMarkupNode(current, markup, tree, Parser, 0, previousMarkup ? 0 : -1);
    shownMarkup.set(container, markup);
  } catch (error) {
    // Half patched: nothing remembered can be trusted.
    drawn = new WeakMap();
    throw error;
  } finally {
    previousMarkup = "";
  }
}
