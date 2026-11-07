import test from "node:test";
import assert from "node:assert/strict";
import {
  SHAPE_PROPERTY_TYPES,
  isAnimationCompatible,
} from "./animationCompatibility.js";

test("shape animation properties keep their primitive layer requirements", () => {
  assert.deepEqual(SHAPE_PROPERTY_TYPES, {
    radius: "rectangle",
    cornerRadii: "rectangle",
    donut: "ellipse",
    sweep: "ellipse",
    startAngle: "ellipse",
    spikes: "star",
    starThickness: "star",
  });

  for (const [property, type] of Object.entries(SHAPE_PROPERTY_TYPES)) {
    const animation = { from: { [property]: 1 }, to: {} };
    assert.equal(isAnimationCompatible({ type }, animation), true, property);
    assert.equal(
      isAnimationCompatible({ type: "path" }, animation),
      false,
      property,
    );
  }
});

test("compatibility checks the union of both one-sided animation endpoints", () => {
  assert.equal(
    isAnimationCompatible(
      { type: "rectangle" },
      { from: {}, to: { donut: 0.5 } },
    ),
    false,
  );
  assert.equal(
    isAnimationCompatible(
      { type: "path" },
      { from: { cornerRadii: [1, 1, 1, 1] }, to: {} },
    ),
    false,
  );
});

test("corner radius animations accept rectangle, group, image and video boxes", () => {
  for (const type of ["rectangle", "group", "image", "video"]) {
    for (const property of ["radius", "cornerRadii"]) {
      assert.equal(
        isAnimationCompatible({ type }, { from: { [property]: property === "radius" ? 4 : [4, 4, 4, 4] }, to: {} }),
        true,
        `${type} accepts ${property}`,
      );
    }
  }
  for (const type of ["ellipse", "star", "path", "text", "component", "audio"]) {
    assert.equal(isAnimationCompatible({ type }, { from: { radius: 4 }, to: {} }), false, `${type} rejects box corners`);
  }
});

test("stroke properties are limited to layers with stroke support", () => {
  for (const type of ["rectangle", "ellipse", "star", "path", "text", "group", "image", "video"]) {
    assert.equal(
      isAnimationCompatible({ type }, { from: { stroke: "#000000" }, to: {} }),
      true,
      `${type} accepts stroke paint`,
    );
    assert.equal(
      isAnimationCompatible({ type }, { from: {}, to: { strokeWidth: 2 } }),
      true,
      `${type} accepts stroke width`,
    );
  }
  assert.equal(
    isAnimationCompatible({ type: "component" }, { from: { strokeWidth: 2 } }),
    false,
  );
  assert.equal(isAnimationCompatible({ type: "audio" }, { from: { stroke: "#000000" } }), false);
});

test("generic transform and paint properties remain type agnostic", () => {
  assert.equal(
    isAnimationCompatible(
      { type: "image" },
      { from: { x: 0, opacity: 0, fill: "#000000" }, to: { x: 10 } },
    ),
    true,
  );
  assert.equal(isAnimationCompatible({ type: "rectangle" }, {}), true);
});

test("compatibility ignores convertedFrom metadata and does not mutate inputs", () => {
  const layer = { type: "path", convertedFrom: "rectangle" };
  const animation = { from: {}, to: { cornerRadii: [4, 4, 4, 4] } };
  const before = JSON.stringify({ layer, animation });

  assert.equal(isAnimationCompatible(layer, animation), false);
  assert.equal(JSON.stringify({ layer, animation }), before);
});
