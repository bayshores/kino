// The overlay generators (engine/effects/particles.js): same picture for the same time, exact loops,
// smooth motion when settings animate, birth-time counts, and the limits agents are given.
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { normalizeEffectAnimation, effectsAt } from "./animation.js";
import { EFFECT_GROUPS, effectDefaults, effectDefinition, effectDocumentation, normalizeEffectParameters } from "./catalog.js";
import { PARTICLE_LOOKS, linkLines, particlesAt, renderParticles } from "./particles.js";
import { exportFrameTime } from "../exportOptions.js";

const KEYS = Object.keys(PARTICLE_LOOKS);
const BOX = { x: 0, y: 0, width: 640, height: 360 };

// An effect animation as a saved document holds it (normalized like the document check does).
function operation(key, to = {}, extra = {}) {
  return normalizeEffectAnimation({ id: "fx", name: key, kind: "effect", effect: key, start: 0, duration: 8,
    easing: "linear", to: normalizeEffectParameters(key, to), keepStill: "both", ...extra });
}

// The frame an effect receives from engine/render.js at layer time `time`.
function frameAt(key, to = {}, time = 2, extra = {}, bounds = BOX) {
  const layer = { type: "rectangle", animations: [operation(key, to, extra)] };
  const [sample] = effectsAt(layer, time);
  const defs = [];
  let sequence = 0;
  return { content: "", bounds, parameters: sample.parameters, time: sample.time, progress: sample.progress,
    operation: sample.operation, helpers: { id: (kind) => `p-${kind}-${++sequence}`, defs } };
}

function svgAt(key, to, time, extra) {
  const frame = frameAt(key, to, time, extra);
  const body = renderParticles(key, frame);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX.width}" height="${BOX.height}"><rect width="100%" height="100%" fill="#000"/><defs>${frame.helpers.defs.join("")}</defs>${body}</svg>`;
}

test("variation spreads each particle's trail, brightness, glow and color by depth; streaks is that field in one layer", () => {
  const spread = (key, to) => {
    const { particles } = particlesAt(key, frameAt(key, { direction: 180, spread: 0, ...to }, 2));
    const lengths = particles.filter((item) => item.tail).map((item) => Math.hypot(item.x - item.tail[0], item.y - item.tail[1]));
    const back = particles.filter((item) => item.depth < 0.2);
    return { ratio: Math.max(...lengths) / Math.min(...lengths), backAlpha: back.reduce((sum, item) => sum + item.alpha, 0) / back.length, particles };
  };
  const even = spread("rain", { count: 300 }), deep = spread("rain", { count: 300, variation: 1 });
  assert.ok(deep.ratio > even.ratio * 2, `streak lengths spread ${even.ratio.toFixed(1)} -> ${deep.ratio.toFixed(1)}`);
  assert.ok(deep.backAlpha < even.backAlpha, `far particles dim further: ${even.backAlpha.toFixed(3)} -> ${deep.backAlpha.toFixed(3)}`);
  assert.equal("glow" in even.particles[0], false, "rain without variation draws as before");
  const field = spread("streaks", {});
  const far = field.particles.filter((item) => item.depth < 0.3), near = field.particles.filter((item) => item.depth > 0.8);
  const mean = (items, key) => items.reduce((sum, item) => sum + item[key], 0) / items.length;
  assert.ok(mean(near, "radius") > mean(far, "radius") * 2 && mean(near, "tone") > mean(far, "tone") && mean(near, "glow") > mean(far, "glow"));
  assert.ok(far.length > near.length * 3, `most streaks sit far back: ${far.length} far, ${near.length} near`);
  assert.equal(effectDefaults("streaks").variation, 0.8);
  assert.equal("variation" in effectDefaults("rain") || "haze" in effectDefaults("rain"), false);
  // haze: the same particles once more, blurred, under the sharp ones; left out, rain draws as before.
  assert.match(svgAt("streaks", {}, 2), /<use href="#p-particles-field-\d+" filter="url\(#p-particles-haze-\d+\)"\/><use href="#p-particles-field-\d+"\/>/);
  assert.doesNotMatch(svgAt("rain", {}, 2), /particles-haze/);
  // Each streak wraps with its own margin, so most of a 1080p field is on screen (one shared
  // margin for the fastest streak left about 40% of them in view).
  const wide = { x: 0, y: 0, width: 1920, height: 1080 };
  const shown = particlesAt("streaks", frameAt("streaks", {}, 2, {}, wide)).particles.filter((item) => item.y >= 0 && item.y <= 1080).length;
  assert.ok(shown > 0.55 * effectDefaults("streaks").count, `${shown} of ${effectDefaults("streaks").count} streaks in view`);
});

test("links draws a line between particles closer than links px, at most 3 per particle; off unless set", () => {
  const nodes = [{ x: 0, y: 0, alpha: 1, tone: 0 }, { x: 100, y: 0, alpha: 1, tone: 0 }, { x: 500, y: 0, alpha: 1, tone: 0 }];
  assert.equal(linkLines(nodes, { links: 200, opacity: 1 }, ["#FFFFFF"]).length, 1, "only the near pair is joined");
  assert.match(linkLines(nodes, { links: 200, opacity: 1 }, ["#FFFFFF"])[0], /d="M0 0L100 0".*stroke-width="1.5".*stroke-opacity="0.55"/);
  const star = Array.from({ length: 6 }, (_, index) => ({ x: index === 0 ? 0 : 50 * Math.cos(index), y: index === 0 ? 0 : 50 * Math.sin(index), alpha: 1, tone: 0 }));
  const used = new Map();
  for (const line of linkLines(star, { links: 400, opacity: 1 }, ["#FFFFFF"])) {
    for (const [, x, y] of line.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) used.set(`${x},${y}`, (used.get(`${x},${y}`) ?? 0) + 1);
  }
  assert.ok(Math.max(...used.values()) <= 3);
  assert.equal("links" in effectDefaults("dust"), false);
  assert.doesNotMatch(svgAt("dust", {}, 2), /stroke-width="1.5"/);
  assert.match(svgAt("dust", { links: 300 }, 2), /<path d="M[^"]+" stroke="#[0-9A-F]{6}" stroke-width="1.5"/);
});

test("the Generate group lists nine generators, each with count, size, speed, direction, spread, wind, turbulence, color, lifetime, opacity and seed", () => {
  assert.ok(EFFECT_GROUPS.includes("Generate"));
  assert.deepEqual(KEYS, ["embers", "sparks", "snow", "dust", "rain", "streaks", "bokeh", "fog", "light-leaks"]);
  for (const key of KEYS) {
    const effect = effectDefinition(key);
    assert.equal(effect.group, "Generate");
    assert.equal(effect.kind, "ranged");
    for (const name of ["count", "size", "speed", "direction", "spread", "wind", "turbulence", "color", "color2", "lifetime", "opacity", "flicker", "seed", "loop", "prewarm"])
      assert.ok(effect.parameters[name], `${key} has ${name}`);
    assert.equal(effect.parameters.count.max, PARTICLE_LOOKS[key].maxCount);
    assert.equal(effect.parameters.count.integer, true);
  }
  // Dots have the dot-only controls; blobs (fog, light leaks) do not list controls they would ignore.
  assert.ok(effectDefinition("sparks").parameters.gravity && effectDefinition("sparks").parameters.emitter);
  assert.equal(effectDefinition("fog").parameters.trail, undefined);
  assert.equal(effectDefinition("light-leaks").parameters.emitter, undefined);
  const documented = effectDocumentation({ group: "Generate" });
  assert.match(documented, /embers \(Embers; ranged\): count number 0\.\.1500 integer/);
  assert.doesNotMatch(effectDocumentation({ exceptGroup: ["Color", "Generate"] }), /embers|curves/);
});

test("limits are refused with the allowed range, and fixed settings cannot change over time", () => {
  assert.throws(() => normalizeEffectParameters("snow", { count: 2001 }), /to\.count|parameters\.count must be an integer from 0 to 2000/);
  assert.throws(() => normalizeEffectParameters("fog", { count: 65 }), /from 0 to 64/);
  assert.throws(() => normalizeEffectParameters("rain", { emitter: "sky" }), /area, bottom, top, left, right, point/);
  assert.throws(() => normalizeEffectParameters("fog", { trail: 0.1 }), /trail is not a parameter of fog/);
  for (const name of ["seed", "lifetime", "loop", "emitter", "prewarm"]) {
    const changed = { seed: 4, lifetime: 2, loop: 3, emitter: "point", prewarm: false }[name];
    assert.throws(() => operation("embers", {}, { from: { [name]: changed } }), new RegExp(`from\\.${name} must equal to\\.${name}`));
  }
  // The same value in from is allowed, and animatable settings move.
  assert.doesNotThrow(() => operation("embers", { seed: 3 }, { from: { seed: 3, count: 0, speed: 20, color: "#FFFFFF" } }));
});

test("a frame depends only on the settings, the seed and the time", () => {
  for (const key of KEYS) {
    const first = svgAt(key, {}, 3.25);
    // Render other times in between, in a scrambled order: nothing carries over.
    for (const time of [7.9, 0, 5.5, 1.01]) svgAt(key, {}, time);
    assert.equal(svgAt(key, {}, 3.25), first, `${key} draws the same frame again`);
    assert.notEqual(svgAt(key, { seed: 2 }, 3.25), first, `${key} draws a different arrangement for another seed`);
    assert.notEqual(svgAt(key, {}, 3.3), first, `${key} moves`);
    assert.ok(particlesAt(key, frameAt(key, {}, 3.25)).particles.length > 0, `${key} shows particles`);
  }
});

test("loop repeats exactly: the frame at t and at t + loop are the same SVG", () => {
  for (const key of KEYS) {
    const loop = key === "fog" ? 6 : 2;
    for (const time of [0, 0.37, 1.5]) {
      const a = svgAt(key, { loop }, time), b = svgAt(key, { loop }, time + loop);
      assert.equal(a, b, `${key} at ${time} and ${time + loop}`);
    }
    assert.notEqual(svgAt(key, { loop }, 0.5), svgAt(key, { loop }, 0.5 + loop / 2), `${key} still moves within the loop`);
  }
});

test("export frame times, which drift from k/fps by rounding, still repeat a loop exactly", () => {
  // exportFrameTime rounds its step to 0.1 µs, so frame 6007 at 60 fps is about 0.2 ms early.
  for (const fps of [12, 24, 25, 30, 50, 60]) {
    const later = Math.round(fps * 2) * 49;
    const a = svgAt("dust", { loop: 2 }, exportFrameTime(7, fps), { duration: 120 });
    const b = svgAt("dust", { loop: 2 }, exportFrameTime(7 + later, fps), { duration: 120 });
    assert.equal(a, b, `${fps} fps, ${later} frames later`);
  }
});

// Particles keep their slot number, so the same particle can be followed from frame to frame.
function largestStep(key, to, extra, from, to2) {
  const before = new Map(particlesAt(key, frameAt(key, to, from, extra)).particles.map((item) => [item.slot, item]));
  let largest = 0, followed = 0;
  for (const item of particlesAt(key, frameAt(key, to, to2, extra)).particles) {
    const earlier = before.get(item.slot);
    if (!earlier || item.alpha < 0.05) continue;
    const step = Math.hypot(item.x - earlier.x, item.y - earlier.y);
    // A wrap around the box (area emitter) or a new life is a jump by design; skip those.
    if (step > 200) continue;
    largest = Math.max(largest, step);
    followed += 1;
  }
  return { largest, followed };
}

test("motion is smooth when speed, direction, wind and gravity animate", () => {
  const animated = { from: { speed: 40, direction: -60, wind: -80, gravity: -200 } };
  for (const time of [0.5, 2.75, 7.2]) {
    const { largest, followed } = largestStep("embers", { speed: 300, direction: 60, wind: 80, gravity: 200 }, animated, time, time + 1 / 120);
    assert.ok(followed > 15, `followed ${followed} embers`);
    // Speeds stay under about 600 px/s here, so 1/120 s moves well under 10 px.
    assert.ok(largest < 10, `largest step ${largest.toFixed(2)} px at ${time}`);
  }
});

test("an animated setting that barely changes draws the same positions as a steady one (the summed motion is right)", () => {
  const steady = particlesAt("sparks", frameAt("sparks", { speed: 500, direction: 20, gravity: 900, wind: 30 }, 3.4)).particles;
  const nearly = particlesAt("sparks", frameAt("sparks", { speed: 500, direction: 20, gravity: 900, wind: 30 }, 3.4,
    { from: { speed: 500.001, direction: 20.0001, gravity: 900.001, wind: 30.001 } })).particles;
  assert.equal(nearly.length, steady.length);
  for (let index = 0; index < steady.length; index += 1) {
    assert.equal(nearly[index].slot, steady[index].slot);
    assert.ok(Math.abs(nearly[index].x - steady[index].x) < 0.05 && Math.abs(nearly[index].y - steady[index].y) < 0.05,
      `slot ${steady[index].slot}: ${steady[index].x},${steady[index].y} vs ${nearly[index].x},${nearly[index].y}`);
  }
});

test("count is read at each particle's birth, so lowering it lets living particles finish their lives", () => {
  // Count falls from 300 to 0 over the first second; snow lives about 10 s.
  const extra = { from: { count: 300 }, duration: 1 };
  const frame = (time) => {
    const layer = { type: "rectangle", animations: [operation("snow", { count: 0 }, extra)] };
    const [sample] = effectsAt(layer, time);
    return { content: "", bounds: BOX, parameters: sample.parameters, time: sample.time, operation: sample.operation,
      helpers: { id: (kind) => kind, defs: [] } };
  };
  // keepStill holds the effect's clock after its end, so look inside the 1 s window.
  assert.ok(particlesAt("snow", frame(0.9)).particles.length > 50, "flakes born earlier are still falling");
  assert.equal(particlesAt("snow", { ...frame(0.9), operation: undefined, parameters: { ...frame(0.9).parameters, count: 0 } }).particles.length, 0,
    "a steady count of 0 shows nothing");
});

test("prewarm starts full; without it the field fills up from nothing", () => {
  assert.ok(particlesAt("snow", frameAt("snow", {}, 0)).particles.length > 100);
  assert.equal(particlesAt("snow", frameAt("snow", { prewarm: false }, 0)).particles.length, 0);
  const early = particlesAt("snow", frameAt("snow", { prewarm: false }, 1)).particles.length;
  const later = particlesAt("snow", frameAt("snow", { prewarm: false }, 6)).particles.length;
  assert.ok(early > 0 && later > early, `${early} then ${later}`);
});

test("a point emitter sends particles out from its origin, and the edge emitters start outside their edge", () => {
  const point = particlesAt("sparks", frameAt("sparks", { originX: 0.25, originY: 0.5, gravity: 0, turbulence: 0, trail: 0 }, 2)).particles;
  const young = point.filter((item) => Math.hypot(item.x - 160, item.y - 180) < 40);
  assert.ok(young.length > 0, "some sparks are still near the origin");
  const centre = point.reduce((sum, item) => [sum[0] + item.x, sum[1] + item.y], [0, 0]).map((value) => value / point.length);
  // Sparks go up (direction 0), so their average sits above the origin.
  assert.ok(centre[1] < 180, `average y ${centre[1]}`);
  const bottom = particlesAt("embers", frameAt("embers", { turbulence: 0, wind: 0, prewarm: false }, 0.2)).particles;
  assert.ok(bottom.length > 0 && bottom.every((item) => item.y > 300), "embers enter from the bottom edge");
});

test("the SVG is decorative, clipped to the layer box, and draws visible pixels", () => {
  const frame = frameAt("embers", {}, 3);
  const body = renderParticles("embers", frame);
  assert.match(body, /^<g clip-path="url\(#p-clip-\d+\)">/);
  assert.match(body, /<g aria-hidden="true" pointer-events="none">/);
  assert.ok(frame.helpers.defs.some((definition) => definition.startsWith("<clipPath")));
  assert.ok(frame.helpers.defs.filter((definition) => definition.startsWith("<radialGradient")).length <= 24);
  for (const key of KEYS) {
    // .pixels makes a new copy on every read, so read it once.
    const pixels = new Resvg(svgAt(key, {}, 3)).render().pixels;
    let lit = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) lit += 1;
    assert.ok(lit > 100, `${key} lights ${lit} pixels`);
  }
});

test("the defaults are inside their limits and every look renders with its maximum count", () => {
  for (const key of KEYS) {
    assert.doesNotThrow(() => normalizeEffectParameters(key, effectDefaults(key)));
    const count = PARTICLE_LOOKS[key].maxCount;
    const { particles, slots } = particlesAt(key, frameAt(key, { count }, 4, {}, { x: 0, y: 0, width: 1920, height: 1080 }));
    assert.equal(slots, count);
    assert.ok(particles.length <= count);
  }
});
