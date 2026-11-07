import test from "node:test";
import assert from "node:assert/strict";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { childKey, markupTree, patchSvgMarkup, updateSvgNode } from "./svgPatch.js";

const parse = (markup) => new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml").documentElement;
const text = (node) => new XMLSerializer().serializeToString(node);
const video = (id) => `<g data-layer-id="${id}"><foreignObject><video data-media-layer-id="${id}" src="/api/media/${id}.mp4"/></foreignObject></g>`;
const box = (id, fill = "#fff") => `<g data-layer-id="${id}"><rect fill="${fill}"/></g>`;
const videoOf = (root, id) => [...root.getElementsByTagName("video")].find((node) => node.getAttribute("data-media-layer-id") === id);

// Patches `before` into `after` and returns the page's tree and its clip's <video> before and after.
function patch(before, after, id = "clip") {
  const page = parse(before);
  const element = videoOf(page, id);
  let paused = 0;
  if (element) element.pause = () => { paused += 1; };
  const wanted = parse(after);
  updateSvgNode(page, wanted);
  assert.equal(text(page), text(wanted), "the page shows the new drawing");
  // patchSvgMarkup (playback's path, from markup strings) does exactly the same.
  const fromMarkup = patchMarkup(before, after, id);
  assert.equal(fromMarkup.text, text(wanted));
  assert.equal(fromMarkup.kept, videoOf(page, id) === element && element !== undefined);
  assert.equal(fromMarkup.paused, paused);
  return { page, element, now: videoOf(page, id), paused: () => paused };
}

const svg = (markup) => `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
function patchMarkup(before, after, id) {
  const container = new DOMParser().parseFromString('<div xmlns="http://www.w3.org/1999/xhtml"/>', "text/xml").documentElement;
  patchSvgMarkup(container, svg(before), DOMParser);
  const element = videoOf(container.firstChild, id);
  let paused = 0;
  if (element) element.pause = () => { paused += 1; };
  patchSvgMarkup(container, svg(after), DOMParser);
  return { text: text(container.firstChild), kept: videoOf(container.firstChild, id) === element && element !== undefined, paused };
}

test("patchSvgMarkup leaves unchanged branches alone and reads entities, spaces and xlink as a parser does", () => {
  const container = new DOMParser().parseFromString('<div xmlns="http://www.w3.org/1999/xhtml"/>', "text/xml").documentElement;
  const frame = (fill, label) => svg(`<defs/>${box("still")}<g data-layer-id="t" title="a&amp;b &#x41;"><text>${label}</text><use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#${fill}"/></g>${box("moving", fill)}`);
  patchSvgMarkup(container, frame("#000", "one"), DOMParser);
  const still = container.firstChild.childNodes[1];
  for (const [fill, label] of [["#111", "two &lt; three"], ["#222", "x\ny"], ["#222", "x\ny"]]) {
    patchSvgMarkup(container, frame(fill, label), DOMParser);
    assert.equal(text(container.firstChild), text(new DOMParser().parseFromString(frame(fill, label), "image/svg+xml").documentElement));
  }
  assert.equal(container.firstChild.childNodes[1], still, "the unchanged layer keeps its node");
  assert.equal(markupTree("<svg><!-- note --></svg>"), null, "comments fall back to a whole parse");
});

test("children are matched by their layer, and a wrapper by the layer inside it", () => {
  const root = parse(`${box("a")}<g mask="url(#m)">${box("b")}</g><defs/>`);
  const [a, wrapper, defs] = [...root.childNodes];
  assert.equal(childKey(a), "layer:a");
  assert.equal(childKey(wrapper), "g>b");
  assert.equal(childKey(defs), null);
});

test("a layer that shows before a video does not replace the video's element", () => {
  const result = patch(`${box("ground")}${video("clip")}`, `${box("ground")}${box("title", "#f00")}${video("clip")}`);
  assert.equal(result.now, result.element, "the same <video> element plays on");
  assert.equal(result.paused(), 0);
});

test("a layer that hides before a video does not replace the video's element", () => {
  const result = patch(`${box("title")}${box("ground")}${video("clip")}`, `${box("ground")}${video("clip")}`);
  assert.equal(result.now, result.element);
});

test("a mask that switches on or off around a video keeps its element", () => {
  const on = patch(`${box("ground")}${video("clip")}`, `${box("ground")}<g mask="url(#m1)">${video("clip")}</g>`);
  assert.equal(on.now, on.element, "moved into the mask's wrapper");
  const off = patch(`<g mask="url(#m1)">${video("clip")}</g>${box("ground")}`, `${video("clip")}${box("ground")}`);
  assert.equal(off.now, off.element, "moved out of the wrapper");
  assert.equal(off.paused(), 0);
});

test("layers that change order keep their elements; a removed video is paused", () => {
  const swapped = patch(`${video("clip")}${box("top")}`, `${box("top")}${video("clip")}`);
  assert.equal(swapped.now, swapped.element);
  const removed = patch(`${box("ground")}${video("clip")}`, box("ground"));
  assert.equal(removed.now, undefined);
  assert.equal(removed.paused(), 1, "the removed video stops");
});

test("attributes and text follow the new drawing", () => {
  const result = patch(`${box("a", "#000")}<text>old</text>`, `${box("a", "#0f0")}<text>new</text>`, "none");
  assert.match(text(result.page), /#0f0.*new/);
});
