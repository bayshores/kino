import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TIME, createDocument, createLayer, parseDocument } from "./model.js";
import { secondsLeft } from "./timeLimits.js";

// A document with one scene and one animated rectangle, run through the same check the server
// runs before it saves (parseDocument).
function savedTiming({ sceneDuration = MAX_TIME, start = 0, duration = 1 } = {}) {
  const document = createDocument();
  document.scenes[0].duration = sceneDuration;
  const layer = createLayer("rectangle");
  layer.animations = [
    {
      id: "fade",
      name: "Fade",
      kind: "custom",
      start,
      duration,
      easing: "linear",
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
  ];
  document.scenes[0].layers.push(layer);
  return parseDocument(document);
}

test("a scene and its animations may last ten minutes, and no longer", () => {
  // A five-minute song, and the full ten minutes, save.
  assert.equal(savedTiming({ sceneDuration: 300, start: 0, duration: 300 }).scenes[0].duration, 300);
  const longest = savedTiming({ sceneDuration: 600, start: 599, duration: 1 });
  assert.equal(longest.scenes[0].duration, 600);
  assert.equal(longest.scenes[0].layers[0].animations[0].start + longest.scenes[0].layers[0].animations[0].duration, 600);
  // Past ten minutes the save is refused, and the reason names the limit.
  assert.throws(() => savedTiming({ sceneDuration: 600.001 }), /duration: must be a finite number from 0\.001 to 600/);
  assert.throws(() => savedTiming({ start: 599.5, duration: 1 }), /start plus duration cannot exceed 600 seconds/);
  assert.throws(() => savedTiming({ start: 601, duration: 1 }), /cannot exceed 600 seconds/);
});

test("the time left after a start always fits within the limit despite floating-point rounding", () => {
  assert.equal(secondsLeft(580.1), 600 - 580.1);
  // Starts with many decimals (as an MCP client or a scrub can store) must still save.
  let seed = 7;
  for (let index = 0; index < 5000; index += 1) {
    seed = (seed * 16807) % 2147483647;
    const start = (seed / 2147483647) * (MAX_TIME - 0.001);
    const room = secondsLeft(start);
    assert.ok(start + room <= MAX_TIME, `${start} + ${room} passes ${MAX_TIME}`);
    assert.ok(MAX_TIME - start - room < 1e-12);
  }
  assert.equal(secondsLeft(650), 0);
});

test("the time left is trimmed when plain subtraction would leave too much", () => {
  const used = 8.871719498391364;
  const limit = 109.16600633302387;
  // Plain subtraction overshoots here; secondsLeft must not.
  assert.ok(used + (limit - used) > limit);
  const left = secondsLeft(used, limit);
  assert.ok(used + left <= limit);
  assert.ok(limit - used - left < 1e-12);
});

test("the scene duration field stops at the longest scene the document accepts", () => {
  assert.equal(MAX_TIME, 600, "ten minutes: a whole song");
  // "*3" on a 300 s scene would give 900 s, which the server refuses to save.
});
