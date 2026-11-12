import test from "node:test";
import assert from "node:assert/strict";
import { renderLayerSvg, renderSceneSvg } from "./render.js";
import { pathBounds } from "./vectorPath.js";
import { Resvg } from "@resvg/resvg-js";

test("scene backgrounds share the gradient and Color animation renderer, including Fill off and legacy transparent", () => {
  const gradient = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
  const scene = { width: 100, height: 60, layers: [], background: gradient, backgroundEnabled: true, backgroundAnimations: [] };
  const svg = renderSceneSvg(scene);
  assert.match(svg, /<defs><linearGradient/);
  assert.match(svg, /data-scene-background="true"[^>]*fill="url\(#/);
  assert.match(renderSceneSvg({ ...scene, backgroundEnabled: false }), /data-scene-background="true"[^>]*fill="transparent"/);
  assert.match(renderSceneSvg({ ...scene, background: "transparent" }), /data-scene-background="true"[^>]*fill="transparent"/);
  const animated = { ...scene, background: "#ff0000", backgroundAnimations: [{ id: "bg-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: "#ff0000" }, to: { fill: "#0000ff" } }] };
  assert.match(renderSceneSvg(animated, 0.5), /data-scene-background="true"[^>]*fill="#800080"/);
  assert.match(renderSceneSvg(animated, 0.5, { design: true }), /data-scene-background="true"[^>]*fill="#ff0000"/);
});

const layer = (id, type, values = {}) => ({
  id,
  name: id,
  type,
  parentId: null,
  x: 0,
  y: 0,
  width: 40,
  height: 30,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  fill: "#ffffff",
  stroke: "none",
  strokeWidth: 0,
  radius: 0,
  visible: true,
  locked: false,
  blur: 0,
  blendMode: "normal",
  isMask: false,
  shadow: null,
  text: "",
  fontFamily: "Inter",
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.2,
  letterSpacing: 0,
  textAlign: "left",
  path: "",
  src: "",
  mediaStart: 0,
  mediaDuration: 0,
  volume: 1,
  animations: [],
  ...values,
});

test("renders a complete SVG and escapes text, attributes, and layer ids", () => {
  const text = layer('text<&"', "text", {
    width: 200,
    height: 80,
    text: '<hello & "world">',
    fill: "#18243a",
  });
  const svg = renderSceneSvg({
    width: 200,
    height: 100,
    background: "#fff",
    layers: [text],
  });

  assert.match(svg, /^<svg[^>]+viewBox="0 0 200 100"/);
  assert.match(svg, /data-layer-id="text&lt;&amp;&quot;"/);
  assert.match(svg, /aria-label="&lt;hello &amp; &quot;world&quot;&gt;"/);
  assert.match(svg, /<path d="M/);
  assert.match(svg, /data-scene-background="true"/);
  assert.doesNotMatch(svg, /<script|javascript:/i);
});

test("renders parent groups, local children, gradients, paths, and masks", () => {
  const group = layer("group", "group", {
    x: 20,
    y: 10,
    width: 100,
    height: 80,
  });
  const mask = layer("mask", "ellipse", {
    parentId: "group",
    isMask: true,
    fill: "#ffffff",
  });
  const path = layer("path", "path", {
    parentId: "group",
    path: "M 0 0 L 20 0 L 20 20 Z",
    pathBounds: { width: 20, height: 20 },
    fill: {
      type: "linear",
      angle: 90,
      stops: [
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#ffffff" },
      ],
    },
  });
  const target = layer("target", "rectangle", {
    parentId: "group",
    fill: "#aabbcc",
  });
  const svg = renderSceneSvg({
    width: 200,
    height: 100,
    background: "transparent",
    layers: [group, mask, path, target],
  });

  assert.equal((svg.match(/data-layer-id=/g) ?? []).length, 4);
  assert.match(svg, /<linearGradient/);
  assert.match(svg, /<mask/);
  assert.match(svg, /mask="url\(#mask-/);
  const renderedPath = /<path d="([^"]+)"[^>]*fill="url\(#gradient-/.exec(svg)?.[1];
  assert.deepEqual(pathBounds(renderedPath), { x: 0, y: 0, width: 40, height: 30 });
  assert.match(svg, /translate\(20 10\)/);
});

function renderedPixels(values) {
  const graphic = layer("stroke", "rectangle", {
    x: 30, y: 30, width: 40, height: 40,
    fill: "#00ff00", stroke: "#ff0000", strokeWidth: 10, ...values,
  });
  const svg = renderSceneSvg({ width: 100, height: 100, background: "#ffffff", layers: [graphic] });
  const pixels = new Resvg(svg).render().pixels;
  return (x, y) => [...pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
}

test("stroke positions paint the specified side with one alpha composite", () => {
  const inside = renderedPixels({ strokeAlign: "inside" });
  assert.deepEqual(inside(25, 50), [255, 255, 255, 255]);
  assert.deepEqual(inside(35, 50), [255, 0, 0, 255]);
  assert.deepEqual(inside(50, 50), [0, 255, 0, 255]);
  const outside = renderedPixels({ strokeAlign: "outside" });
  assert.deepEqual(outside(25, 50), [255, 0, 0, 255]);
  assert.deepEqual(outside(35, 50), [0, 255, 0, 255]);
  const center = renderedPixels({ strokeAlign: "center" });
  assert.deepEqual(center(27, 50), [255, 0, 0, 255]);
  assert.deepEqual(center(32, 50), [255, 0, 0, 255]);
  assert.deepEqual(center(37, 50), [0, 255, 0, 255]);
  const translucent = renderedPixels({ strokeAlign: "outside", fill: "#00ff0080", stroke: "#ff000080" });
  assert.deepEqual(translucent(25, 50), [255, 127, 127, 255]);
  assert.deepEqual(translucent(35, 50), [127, 255, 127, 255]);
});

test("a layer with its fill turned off draws no fill and keeps its stroke at every position", () => {
  for (const strokeAlign of ["inside", "center", "outside"]) {
    const off = renderedPixels({ strokeAlign, fillEnabled: false });
    assert.deepEqual(off(50, 50), [255, 255, 255, 255], `${strokeAlign}: the inside shows the background`);
    assert.deepEqual(off(strokeAlign === "outside" ? 25 : 32, 50), [255, 0, 0, 255], `${strokeAlign}: the stroke is still drawn`);
  }
  const noStroke = renderedPixels({ fillEnabled: false, strokeWidth: 0 });
  for (const [x, y] of [[50, 50], [31, 31], [69, 69]])
    assert.deepEqual(noStroke(x, y), [255, 255, 255, 255], "a layer with no fill and no stroke draws nothing");
  assert.deepEqual(renderedPixels({ fillEnabled: true })(50, 50), [0, 255, 0, 255], "turning it back on draws the same color");
});

test("a turned-off gradient fill adds no gradient, and a fill animation does not turn it back on", () => {
  const gradient = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff" }] };
  const animated = (fillEnabled) => layer("box", "rectangle", {
    width: 100, height: 100, fill: gradient, fillEnabled,
    animations: [{
      id: "recolor", name: "Recolor", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { fill: "#ff0000" }, to: { fill: "#00ff00" }, unit: "layer", stagger: 0, order: "forward",
    }],
  });
  const scene = (fillEnabled) => ({ width: 100, height: 100, background: "#ffffff", layers: [animated(fillEnabled)] });
  for (const [time, design] of [[0, true], [0.5, false], [1, false]]) {
    const svg = renderSceneSvg(scene(false), time, { design });
    assert.doesNotMatch(svg, /<linearGradient/, "no gradient definition is written for a hidden fill");
    assert.match(svg, /<rect x="0" y="0" width="100" height="100" rx="0" ry="0" fill="none" stroke="none"\/>/);
    const pixels = new Resvg(svg).render().pixels;
    assert.deepEqual([...pixels.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)], [255, 255, 255, 255],
      `t=${time}${design ? " (design)" : ""}: the fill stays off while its color animates`);
  }
  assert.match(renderSceneSvg(scene(true), 0, { design: true }), /<linearGradient/, "turned on, the stored gradient is drawn");
  assert.match(renderSceneSvg(scene(true), 0.5), /fill="#/, "turned on, the animated color is drawn");
});

test("text with its fill turned off draws its glyphs without paint, also per letter", () => {
  const text = (values) => layer("words", "text", { width: 200, height: 40, text: "Hi there", fill: "#18243a", ...values });
  const fills = (svg) => [...svg.matchAll(/<path d="M[^"]*" fill="([^"]+)"/g)].map((match) => match[1]);
  const on = fills(renderSceneSvg({ width: 200, height: 40, background: "transparent", layers: [text({})] }));
  assert.ok(on.length > 0 && on.every((fill) => fill === "#18243a"));
  const off = fills(renderSceneSvg({ width: 200, height: 40, background: "transparent", layers: [text({ fillEnabled: false })] }));
  assert.equal(off.length, on.length, "the glyph outlines are still laid out");
  assert.ok(off.every((fill) => fill === "none"), "no glyph is painted");
  const letters = text({
    fillEnabled: false,
    animations: [{
      id: "letters", name: "Letters", kind: "in", start: 0, duration: 1, easing: "linear",
      from: { opacity: 0, fill: "#ff0000" }, to: { opacity: 1 }, unit: "letters", stagger: 0.1, order: "forward",
    }],
  });
  const perLetter = fills(renderSceneSvg({ width: 200, height: 40, background: "transparent", layers: [letters] }, 0.5));
  assert.ok(perLetter.length > 0 && perLetter.every((fill) => fill === "none"), "per-letter units keep the fill off");
});

test("on the editor canvas a shape whose fill is off can still be clicked inside, and exports stay unchanged", () => {
  const shape = (values) => layer("box", "rectangle", {
    x: 30, y: 30, width: 40, height: 40, fill: "#00ff00", stroke: "#ff0000", strokeWidth: 10, fillEnabled: false, ...values,
  });
  const draw = (values, options) => renderSceneSvg({ width: 100, height: 100, background: "#ffffff", layers: [shape(values)] }, 0, options);
  // The drawn rectangles, leaving out the clip and mask copies in <defs>.
  const shapes = (svg) => [...svg.replace(/<defs>.*<\/defs>/s, "").matchAll(/<rect x="0"[^>]*\/>/g)].map((match) => match[0]);

  // No stroke, or an inside/outside stroke: the unpainted inside answers clicks; the stroke,
  // which is painted, already does.
  for (const values of [{ strokeWidth: 0 }, { strokeAlign: "inside" }, { strokeAlign: "outside" }]) {
    const [inside, ...strokes] = shapes(draw(values, { canvas: true }));
    assert.match(inside, /fill="none" stroke="none" pointer-events="visibleFill"/, JSON.stringify(values));
    for (const stroke of strokes) assert.doesNotMatch(stroke, /pointer-events/);
  }
  // A center stroke is drawn on the same element as the fill, so the element takes clicks on
  // its inside and on its stroke.
  assert.match(shapes(draw({ strokeAlign: "center" }, { canvas: true }))[0], /fill="none" stroke="#ff0000"[^>]*pointer-events="visible"/);

  // A fill that is on is painted, so it needs no help; exports never get the attribute.
  assert.doesNotMatch(draw({ fillEnabled: true }, { canvas: true }), /pointer-events/);
  for (const strokeAlign of ["inside", "center", "outside"])
    assert.doesNotMatch(draw({ strokeAlign }), /pointer-events/, `${strokeAlign}: export SVG`);

  // The canvas drawing still paints nothing inside.
  const pixels = new Resvg(draw({}, { canvas: true })).render().pixels;
  assert.deepEqual([...pixels.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)], [255, 255, 255, 255]);

  const text = layer("words", "text", { width: 200, height: 40, text: "Hi", fill: "#18243a", fillEnabled: false });
  const glyphs = [...renderSceneSvg({ width: 200, height: 40, background: "transparent", layers: [text] }, 0, { canvas: true })
    .matchAll(/<path d="M[^"]*"([^>]*)\/>/g)].map((match) => match[1]);
  assert.ok(glyphs.length > 0 && glyphs.every((attributes) => attributes.includes('pointer-events="visibleFill"')), "text glyphs too");
});

test("even-odd paths leave same-winding compound holes transparent while nonzero fills them", () => {
  const path = "M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z";
  const pixelsFor = (fillRule) => {
    const shape = layer("ring", "path", {
      x: 0, y: 0, width: 100, height: 100,
      path, fillRule, fill: "#00aa44", stroke: "none", strokeWidth: 0,
    });
    return new Resvg(renderSceneSvg({
      width: 100, height: 100, background: "#ffffff", layers: [shape],
    })).render().pixels;
  };
  const pixel = (pixels, x, y) => [...pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
  const nonzero = pixelsFor("nonzero");
  const evenodd = pixelsFor("evenodd");
  assert.deepEqual(pixel(evenodd, 15, 15), [0, 170, 68, 255], "the outer contour is painted");
  assert.deepEqual(pixel(nonzero, 50, 50), [0, 170, 68, 255], "same-winding contours fill under nonzero");
  assert.deepEqual(pixel(evenodd, 50, 50), [255, 255, 255, 255], "the inner contour is a hole under even-odd");
});

test("canvas hit targets carry the path fill rule so SVG hit testing skips even-odd holes", () => {
  const shape = layer("ring", "path", {
    width: 100, height: 100,
    path: "M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z",
    fillRule: "evenodd", fillEnabled: false, stroke: "none", strokeWidth: 0,
  });
  const svg = renderSceneSvg({ width: 100, height: 100, background: "#ffffff", layers: [shape] }, 0, { canvas: true });
  const drawnPath = svg.replace(/<defs>.*?<\/defs>/s, "").match(/<path d="[^"]*"[^>]*\/>/)?.[0];
  assert.ok(drawnPath, "the compound path is present in the canvas SVG");
  assert.match(drawnPath, /fill-rule="evenodd"/);
  assert.match(drawnPath, /pointer-events="visibleFill"/);
});

test("aligned strokes retain a donut hole and constant weight after path resizing", () => {
  const outside = renderedPixels({ type: "ellipse", donut: 0.5, strokeWidth: 3, strokeAlign: "outside" });
  assert.deepEqual(outside(50, 50), [255, 255, 255, 255]);
  assert.deepEqual(outside(58, 50), [255, 0, 0, 255]);
  assert.deepEqual(outside(62, 50), [0, 255, 0, 255]);
  const resized = renderedPixels({ type: "path", width: 60, height: 40, path: "M0 0 H20 V20 H0 Z", pathBounds: { width: 20, height: 20 } });
  assert.deepEqual(resized(22, 50), [255, 255, 255, 255]);
  assert.deepEqual(resized(27, 50), [255, 0, 0, 255]);
  assert.deepEqual(resized(37, 50), [0, 255, 0, 255]);
});

test("text unit animations use per-unit groups and design mode keeps resting values", () => {
  const text = layer("stagger", "text", {
    text: "ABC",
    fontSize: 20,
    lineHeight: 1.2,
    animations: [
      {
        id: "fade",
        name: "Fade",
        kind: "in",
        start: 0,
        duration: 1,
        easing: "linear",
        from: { opacity: 0 },
        to: { opacity: 1 },
        unit: "letters",
        stagger: 0.2,
        order: "forward",
      },
    ],
  });
  const animated = renderLayerSvg(text, 0.3);
  const design = renderLayerSvg(text, 0.3, { design: true });

  assert.equal((animated.match(/<g opacity=/g) ?? []).length, 3);
  const opacityValues = [...animated.matchAll(/<g opacity="([^"]+)"/g)].map(
    (match) => Number(match[1]),
  );
  assert.ok(opacityValues[0] > opacityValues[1]);
  assert.ok(opacityValues[1] > opacityValues[2]);
  assert.match(animated, /aria-label="A"><path d="M/);
  assert.equal((design.match(/<g opacity="1"/g) ?? []).length, 3);
});

test("blur uses the evaluated frame value", () => {
  const shape = layer("blurred", "rectangle", {
    animations: [
      {
        id: "blur",
        name: "Blur",
        kind: "custom",
        start: 0,
        duration: 1,
        easing: "linear",
        from: { blur: 12 },
        to: { blur: 0 },
        unit: "layer",
        stagger: 0,
        order: "forward",
      },
    ],
  });
  const svg = renderLayerSvg(shape, 0);
  assert.match(svg, /<feGaussianBlur[^>]+stdDeviation="6"/);
  // A group's frameRate holds every child's picture: at 2 per second, 0.4 s draws the 0 s picture.
  const scene = { id: "s", name: "s", width: 100, height: 100, duration: 2, background: "#000000",
    layers: [layer("held", "group", { frameRate: 2 }), { ...shape, parentId: "held" }] };
  assert.match(renderSceneSvg(scene, 0.4), /<feGaussianBlur[^>]+stdDeviation="6"/);
  assert.match(renderSceneSvg({ ...scene, layers: [layer("held", "group"), { ...shape, parentId: "held" }] }, 0.4), /stdDeviation="3.6"/);
  // Look's motion blur samples a held child through the group's clock, as an export's shutter
  // does: inside one held picture it does not move, so it is not smeared.
  const fast = { ...layer("fast", "rectangle", { parentId: "held", width: 10, height: 10 }), animations: [{ id: "move", name: "Move", kind: "custom",
    start: 0, duration: 2, easing: "linear", from: { x: -2000 }, to: { x: 2000 }, unit: "layer", stagger: 0, order: "forward" }] };
  const smeared = (frameRate) => renderSceneSvg({ ...scene, layers: [layer("held", "group", frameRate ? { frameRate } : {}), fast] }, 0.4, { previewBlur: true }).includes("preview-blur");
  assert.equal(smeared(0), true);
  assert.equal(smeared(2), false);
});

test("interactive video uses only local media routes and normal rendering requires a frame", () => {
  const video = layer("clip", "video", { src: "/api/media/clip-123.mp4" });
  const preview = renderSceneSvg(
    { width: 100, height: 100, layers: [video] },
    0.5,
    { interactiveMedia: true },
  );
  assert.match(preview, /<video[^>]+data-media-layer-id="clip"/);
  assert.match(preview, /preload="auto"/);
  assert.match(preview, /playsinline/);
  assert.doesNotMatch(preview, /autoplay/);
  assert.throws(
    () => renderSceneSvg({ width: 100, height: 100, layers: [video] }),
    /provide a frame|no usable frame/i,
  );
  assert.throws(
    () =>
      renderSceneSvg({
        width: 100,
        height: 100,
        layers: [
          layer("remote", "image", { src: "https://example.com/image.png" }),
        ],
      }),
    /External and SVG media are not loaded/,
  );
});

test("GIF Play renders decoded frames from the shared clock and hides outside Play", () => {
  const frames = ["/api/media/anim.gif/frames/0.png", "/api/media/anim.gif/frames/1.png", "/api/media/anim.gif/frames/2.png?share=abc"];
  const gif = layer("anim", "image", { src: "/api/media/anim.gif", mediaStart: 1, mediaDuration: 2, mediaOffset: 0.1, mediaFreeze: "first" });
  const imageFrames = { anim: { durations: [0.1, 0.1, 0.1], frames } };
  const hrefAt = (time, options = {}) => renderSceneSvg({ width: 40, height: 30, layers: [gif] }, time, { imageFrames, ...options }).match(/href="([^"]+)"/)?.[1];
  assert.equal(hrefAt(0), frames[1], "Freeze first shows the frame at the source offset");
  assert.equal(hrefAt(1.1), frames[2]);
  assert.equal(hrefAt(1.2), frames[0]);
  assert.equal(hrefAt(3.5), undefined, "Freeze first hides the layer after Play");
  assert.equal(hrefAt(3.5, { design: true }), frames[1], "the editing canvas shows the offset frame");
  const still = { ...gif, mediaDuration: 0 };
  assert.match(renderSceneSvg({ width: 40, height: 30, layers: [still] }, 2, { imageFrames }), /frames\/0\.png/);
  assert.throws(
    () => renderSceneSvg({ width: 40, height: 30, layers: [gif] }, 1, { imageFrames: { anim: { durations: [1], frames: ["/api/media/anim.gif/frames/x.svg"] } } }),
    /External and SVG media are not loaded/,
  );
});

test("blob: URLs are drawn only as the editor's decoded GIF frames, never as a layer's src", () => {
  const FRAME = "blob:http://localhost:5173/0f8fad5b-d9cb-469f-a165-70867728950e";
  const gif = layer("anim", "image", { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" });
  const scene = (item) => ({ width: 40, height: 30, layers: [item] });
  const decoded = { anim: { durations: [0.1], frames: [FRAME], width: 1, height: 1 } };
  assert.match(renderSceneSvg(scene(gif), 0, { imageFrames: decoded }), new RegExp(`href="${FRAME}"`));
  assert.throws(() => renderSceneSvg(scene({ ...gif, src: FRAME }), 0), /must use \/api\/media/, "a document src stays limited to media files and data: images");
  assert.throws(
    () => renderSceneSvg(scene(gif), 0, { embedMedia: { anim: FRAME } }),
    /must use \/api\/media/,
    "embedMedia mirrors the document src in the editor, so it may not be a blob: URL either",
  );
  assert.throws(
    () => renderSceneSvg(scene(gif), 0, { imageFrames: { anim: { durations: [0.1], frames: ["blob:http://localhost:5173/not-a-uuid\" onload=\"x"] } } }),
    /must use \/api\/media/,
    "only the exact object URL shape is accepted",
  );
});

test("trusted decoded video frames replace the live element without accepting blob document sources", () => {
  const frame = "blob:http://localhost:5173/0f8fad5b-d9cb-469f-a165-70867728950e";
  const video = layer("clip", "video", { src: "/api/media/clip.mp4" });
  const sample = (item = video) => ({ width: 40, height: 30, layers: [item] });
  const svg = renderSceneSvg(sample(), 0, { interactiveMedia: true, videoFrames: new Map([["clip", frame]]) });
  assert.ok(svg.includes(`href="${frame}"`));
  assert.doesNotMatch(svg, /foreignObject|<video\b/);
  assert.match(renderSceneSvg(sample(), 0, { interactiveMedia: true }), /<video\b/);
  assert.doesNotMatch(renderSceneSvg(sample({ ...video, blur: 8 }), 0, { interactiveMedia: true }), /<use\b/, "a live video is not copied to mirror its edges");
  // Tilted: each triangle's <use> copy of a live <video> would be a decoder that draws nothing.
  const tilted = renderSceneSvg(sample({ ...video, rotateX: 30 }), 0, { interactiveMedia: true });
  assert.match(tilted, /<use\b/, "the tilt is drawn as triangles");
  assert.doesNotMatch(tilted, /<video\b/, "no live video inside the triangles' copies");
  assert.ok(renderSceneSvg(sample({ ...video, rotateX: 30 }), 0, { interactiveMedia: true, videoFrames: new Map([["clip", frame]]) }).includes(`href="${frame}"`), "its captured frame is drawn");
  // A big blur: the live preview draws the video small into a canvas instead of an SVG blur.
  const soft = renderSceneSvg(sample({ ...video, blur: 48 }), 0, { interactiveMedia: true });
  assert.match(soft, /<video\b[^>]*opacity:0[^>]*\/><canvas data-soft-video="[\d. ]+ 9 3" width="\d+" height="\d+"/);
  assert.doesNotMatch(soft, /feGaussianBlur/);
  assert.match(renderSceneSvg(sample({ ...video, blur: 48 }), 0, { videoFrames: new Map([["clip", frame]]) }), /feGaussianBlur/, "exports keep the SVG blur");
  assert.throws(() => renderSceneSvg(sample({ ...video, src: frame })), /frame|local|media|video/i);
  assert.throws(() => renderSceneSvg(sample(), 0, { embedMedia: { clip: frame } }), /frame|local|media|video/i);
  assert.throws(() => renderSceneSvg(sample(), 0, { videoFrames: { clip: 'blob:http://localhost:5173/not-a-uuid" onload="x' } }), /media|video/i);
});

test("a faded or blurred video taller than the frame is drawn to the bottom in raster frames", () => {
  // resvg cut a clip group inside an opacity or filter group 2x the canvas height below that group's top.
  const white = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="8"><rect width="4" height="8" fill="#fff"/></svg>').render().asPng();
  const frame = `data:image/png;base64,${Buffer.from(white).toString("base64")}`;
  const lowestRow = (values) => {
    const clip = layer("clip", "video", { src: "/api/media/clip.mp4", y: -30, width: 40, height: 80, opacity: 0.5, ...values });
    const svg = renderSceneSvg({ width: 40, height: 20, background: "#000000", layers: [clip] }, 0, { raster: true, videoFrames: { clip: frame } });
    const pixels = new Resvg(svg).render().pixels;
    let lowest = -1;
    for (let y = 0; y < 20; y += 1) if (pixels[(y * 40 + 20) * 4] > 100) lowest = y;
    return lowest;
  };
  assert.equal(lowestRow({}), 19, "faded");
  assert.equal(lowestRow({ blur: 2 }), 19, "faded and blurred");
});

test("the live preview puts a video in the page, hidden, in the second before it shows; exports never do", () => {
  const clip = layer("clip", "video", { src: "/api/media/clip.mp4", mediaStart: 2, mediaDuration: 1, mediaSourceDuration: 5, mediaFreeze: "none" });
  const group = layer("ring", "group", { animations: [{ id: "show", kind: "show", start: 2 }, { id: "hide", kind: "hide", start: 0 }] });
  const inGroup = { ...clip, id: "tile", parentId: "ring", mediaStart: 0, mediaDuration: 3 };
  const sample = { width: 40, height: 30, layers: [clip, group, inGroup] };
  const live = (time) => renderSceneSvg(sample, time, { interactiveMedia: true });
  // 0.5 s before: both videos are there, hidden, the tile's group with them.
  const early = live(1.5);
  assert.match(early, /data-layer-id="clip" visibility="hidden"/);
  assert.match(early, /data-layer-id="ring" visibility="hidden"/);
  assert.equal((early.match(/<video\b/g) ?? []).length, 2);
  // Shown: the same elements, now visible.
  const shown = live(2.1);
  assert.doesNotMatch(shown, /visibility="hidden"/);
  assert.equal((shown.match(/<video\b/g) ?? []).length, 2);
  // Further ahead, and in every export or still frame, nothing hidden is drawn.
  assert.doesNotMatch(live(0.5), /<video\b/);
  assert.doesNotMatch(renderSceneSvg(sample, 1.5), /visibility="hidden"|data-layer-id="clip"/);
  // A video drawn from captured frames has its own decoder already: nothing is drawn ahead.
  assert.doesNotMatch(renderSceneSvg(sample, 1.5, { interactiveMedia: true, videoFrames: new Map([["clip", "/api/media/f.png"], ["tile", "/api/media/f.png"]]) }), /visibility="hidden"/);
});

test("the live preview, which remembers each layer's sorted operations, draws what a fresh copy draws", () => {
  const box = layer("box", "rectangle", { width: 20, height: 10, fill: "#336699", animations: [
    { id: "move", kind: "custom", start: 0.5, duration: 1, from: { x: 0 }, to: { x: 30 } },
    { id: "fade", kind: "in", start: 0, duration: 1, from: { opacity: 0 }, to: { opacity: 1 } },
    { id: "off", kind: "custom", start: 0, duration: 2, from: { y: 50 }, to: { y: 60 }, enabled: false },
  ] });
  const sample = { width: 40, height: 30, layers: [box] };
  for (const time of [0.25, 1, 0.25, 2, 1])
    assert.equal(renderSceneSvg(sample, time, { interactiveMedia: true }), renderSceneSvg(structuredClone(sample), time));
});

test("video frames are looked up by source time after the Play offset", () => {
  const video = layer("clip", "video", { src: "/api/media/clip.mp4", mediaStart: 1, mediaDuration: 1, mediaOffset: 5, mediaFreeze: "last" });
  const videoFrames = { clip: [
    { time: 5, href: "/api/media/f5.png" },
    { time: 5.5, href: "/api/media/f55.png" },
    { time: 6, href: "/api/media/f6.png" },
  ] };
  const hrefAt = (time) => renderSceneSvg({ width: 40, height: 30, layers: [video] }, time, { videoFrames }).match(/href="([^"]+)"/)?.[1];
  assert.equal(hrefAt(0.5), undefined, "Freeze last hides the video before Play");
  assert.equal(hrefAt(1.2), "/api/media/f5.png");
  assert.equal(hrefAt(1.5), "/api/media/f55.png");
  assert.equal(hrefAt(4), "/api/media/f55.png", "the held frame is the one shown just before Play ends");
  const seen = [];
  renderSceneSvg({ width: 40, height: 30, layers: [video] }, 1.25, { videoFrames: { clip: (input) => { seen.push(input); return "/api/media/f5.png"; } } });
  assert.equal(seen[0].time, 1.25);
  assert.equal(seen[0].sourceTime, 5.25);
});

test("motion blur's shutter samples draw every clip's picture of the output frame's own time (mediaTime), blended clips too", () => {
  // A final render draws output frame 1.25 s at two shutter times (1.2 and 1.3 s here) and passes
  // mediaTime 1.25: the clip must show the picture of 1.25 s in both, as the draft and look do.
  for (const mediaInterpolation of ["nearest", "blend", "flow"]) {
    const video = layer("clip", "video", { src: "/api/media/clip.mp4", mediaStart: 1, mediaDuration: 1, mediaOffset: 5, mediaInterpolation });
    const seen = [];
    const videoFrames = { clip: (input) => { seen.push(input); return "/api/media/f5.png"; } };
    for (const shutterTime of [1.2, 1.3]) renderSceneSvg({ width: 40, height: 30, layers: [video] }, shutterTime, { videoFrames, mediaTime: 1.25 });
    assert.deepEqual(seen.map((input) => input.sourceTime), [5.25, 5.25], `${mediaInterpolation}: the file time of 1.25 s in both samples`);
  }
  const gif = layer("anim", "image", { src: "/api/media/anim.gif", mediaStart: 0, mediaDuration: 1 });
  const shown = [];
  const imageFrames = { anim: (input) => { shown.push(input.sourceTime); return undefined; } };
  for (const shutterTime of [0.45, 0.55]) renderSceneSvg({ width: 40, height: 30, layers: [gif] }, shutterTime, { imageFrames, mediaTime: 0.5 });
  assert.deepEqual(shown, [0.5, 0.5], "a GIF too");
});

test("decoded GIF frame URLs may carry the decoder version and a share token, and nothing else", () => {
  const gif = layer("anim", "image", { src: "/api/media/anim.gif", mediaStart: 0, mediaDuration: 1 });
  const draw = (url) => renderSceneSvg({ width: 40, height: 30, layers: [gif] }, 0, { imageFrames: { anim: { durations: [1], frames: [url] } } });
  for (const url of ["/api/media/anim.gif/frames/0.png?decoder=1", "/api/media/anim.gif/frames/0.png?decoder=1&share=abc", "/api/media/anim.gif/frames/0.png?share=abc"])
    assert.ok(draw(url).includes(`href="${url.replaceAll("&", "&amp;")}"`), url);
  for (const url of ["/api/media/anim.gif/frames/0.png?decoder=x", "/api/media/anim.gif/frames/0.png?share=abc&decoder=1", "/api/media/anim.gif/frames/0.png?decoder=1&other=2", "/api/media/anim.gif?decoder=1"])
    assert.throws(() => draw(url), /External and SVG media are not loaded/, url);
});
