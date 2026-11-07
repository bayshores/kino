import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLayer } from "./animation.js";
import { createLayer } from "./model.js";
import { canConvertToShape, convertLayerToShape } from "./shapeConversion.js";
import { parsePath, pathBounds } from "./vectorPath.js";

test("conversion eligibility allows editable primitives and excludes full donut rings", () => {
  assert.equal(canConvertToShape(createLayer("rectangle")), true);
  assert.equal(canConvertToShape(createLayer("star")), true);
  assert.equal(canConvertToShape(createLayer("ellipse")), true);
  assert.equal(canConvertToShape(createLayer("ellipse", { donut: 0.5 })), false);
  assert.equal(
    canConvertToShape(createLayer("ellipse", { donut: 0.5, sweep: 0.75 })),
    true,
  );
  assert.equal(
    canConvertToShape(createLayer("ellipse", { donut: 0.5, sweep: 0 })),
    true,
  );

  for (const type of ["text", "path", "group", "image", "video", "audio", "component"]) {
    assert.equal(canConvertToShape(createLayer(type)), false, `${type} is not convertible`);
  }
  assert.equal(canConvertToShape(null), false);

  assert.throws(
    () => convertLayerToShape(createLayer("ellipse", { donut: 0.4 })),
    /full donut ellipse cannot be converted/,
  );
  assert.throws(
    () => convertLayerToShape(createLayer("image")),
    /layer type "image" cannot be converted/,
  );
});

test("conversion bakes mixed editable rectangle corners as exact cubic path geometry", () => {
  const rectangle = createLayer("rectangle", {
    id: "rounded-box",
    x: 18,
    y: 25,
    width: 100,
    height: 80,
    cornerRadii: [10.25, 20.5, 30.75, 40.125],
  });

  const converted = convertLayerToShape(rectangle);
  const [contour] = parsePath(converted.path);
  assert.equal(converted.type, "path");
  assert.equal(converted.convertedFrom, "rectangle");
  assert.equal(contour.closed, true);
  assert.equal(contour.segments.length, 8);
  assert.deepEqual(contour.start, [10.25, 0]);
  assert.deepEqual(contour.segments[0].end, [79.5, 0]);
  assert.deepEqual(contour.segments[1].end, [100, 20.5]);
  assert.ok(contour.segments.some((segment) => segment.c1[0] !== segment.end[0]));
  assert.deepEqual(converted.pathBounds, { x: 0, y: 0, width: 100, height: 80 });
  assert.deepEqual(pathBounds(converted.path), converted.pathBounds);
});

test("conversion keeps star spikes and partial ellipse arcs as editable cubic paths", () => {
  const star = convertLayerToShape(
    createLayer("star", {
      id: "six-point-star",
      width: 100,
      height: 80,
      spikes: 6,
      starThickness: 0.425,
    }),
  );
  const [starContour] = parsePath(star.path);
  assert.equal(starContour.segments.length, 12);
  assert.deepEqual(starContour.start, [50, 0]);
  assert.equal(star.convertedFrom, "star");

  const width = 119.7;
  const height = 61.3;
  const startAngle = 13.37;
  const ellipse = convertLayerToShape(
    createLayer("ellipse", {
      id: "partial-donut",
      width,
      height,
      donut: 0.2,
      sweep: 0.3,
      startAngle,
    }),
  );
  const [ellipseContour] = parsePath(ellipse.path);
  const radians = (startAngle * Math.PI) / 180;
  assert.equal(ellipseContour.segments.length, 5);
  assert.deepEqual(ellipseContour.start, [
    width / 2 + (width / 2) * Math.cos(radians),
    height / 2 + (height / 2) * Math.sin(radians),
  ]);
  assert.ok(ellipseContour.segments.every((segment) => segment.c1 && segment.c2));
  assert.equal(ellipse.convertedFrom, "ellipse");
  assert.deepEqual(ellipse.pathBounds, { x: 0, y: 0, width, height });
  assert.notDeepEqual(pathBounds(ellipse.path), ellipse.pathBounds);
});

test("conversion preserves layer metadata and nested values without mutating the source", () => {
  const rectangle = createLayer("rectangle", {
    id: "preserved-layer",
    name: "Preserved layer",
    parentId: "parent-group",
    x: 37,
    y: 49,
    width: 220,
    height: 90,
    rotation: 17,
    scaleX: 1.3,
    scaleY: 0.7,
    skewX: 4,
    opacity: 0.6,
    fill: {
      type: "linear",
      angle: 35,
      stops: [
        { offset: 0, color: "#123456" },
        { offset: 1, color: "#abcdef" },
      ],
    },
    stroke: "#10203080",
    strokeWidth: 5,
    blur: 2,
    shadow: { x: 2, y: 3, blur: 4, color: "#00000040" },
    animations: [
      {
        id: "corners",
        name: "Corners",
        kind: "custom",
        start: 0.2,
        duration: 0.8,
        from: { cornerRadii: [1, 2, 3, 4] },
        to: { cornerRadii: [5, 6, 7, 8] },
      },
    ],
    customMetadata: { labels: ["one", "two"] },
  });
  const before = structuredClone(rectangle);
  const converted = convertLayerToShape(rectangle);

  assert.deepEqual(rectangle, before);
  for (const key of [
    "id",
    "name",
    "parentId",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "scaleX",
    "scaleY",
    "skewX",
    "opacity",
    "fill",
    "stroke",
    "strokeWidth",
    "blur",
    "shadow",
    "animations",
    "customMetadata",
  ]) {
    assert.deepEqual(converted[key], before[key], `${key} survives conversion`);
  }
  assert.equal(converted.convertedFrom, "rectangle");
  assert.notEqual(converted.fill, rectangle.fill);
  assert.notEqual(converted.fill.stops, rectangle.fill.stops);
  assert.notEqual(converted.animations, rectangle.animations);
  assert.notEqual(converted.animations[0].from, rectangle.animations[0].from);
  assert.notEqual(converted.customMetadata.labels, rectangle.customMetadata.labels);
});

test("conversion uses base geometry and retains procedural animation metadata", () => {
  const rectangle = createLayer("rectangle", {
    id: "animated-rectangle",
    width: 100,
    height: 60,
    radius: 7,
    animations: [
      {
        id: "animate-radius",
        kind: "custom",
        start: 0,
        duration: 1,
        easing: "linear",
        from: { radius: 7 },
        to: { radius: 30 },
      },
    ],
  });
  assert.equal(evaluateLayer(rectangle, 1).radius, 30);

  const converted = convertLayerToShape(rectangle);
  const [baseContour] = parsePath(converted.path);
  assert.equal(baseContour.start[0], 7);
  assert.deepEqual(converted.animations, rectangle.animations);
  assert.notEqual(converted.animations, rectangle.animations);
});

test("empty eligible geometry stays an empty path with its nominal local box", () => {
  const converted = convertLayerToShape(
    createLayer("star", {
      id: "empty-star",
      width: 40,
      height: 20,
      spikes: 0,
    }),
  );
  assert.equal(converted.path, "");
  assert.deepEqual(parsePath(converted.path), []);
  assert.deepEqual(converted.pathBounds, { x: 0, y: 0, width: 40, height: 20 });
});
