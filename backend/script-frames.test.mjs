// Script layers' frames drawn by the sandboxed Electron worker (script-frames.mjs): pixels from the
// frame's values and progress, pixel ratio, repeatable randomness, no network, the time limit, error
// phases, empty frames, image inputs and WebGL. All tests share one worker process.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createScriptRenderer } from "./script-frames.mjs";

const require = createRequire(import.meta.url);
function electronSkip() {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "Electron needs a display (CI runs under xvfb-run)";
  try { return existsSync(require("electron")) ? false : "Electron is not installed"; } catch { return "Electron is not installed"; }
}
const skip = electronSkip();
const renderer = createScriptRenderer();
after(() => renderer.close());

const frameAt = (time, values = {}, duration = 2, width = 40, height = 20) =>
  ({ time, duration, progress: Math.min(1, time / duration), values, width, height });

async function pixels(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, at: (x, y) => [...data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)] };
}

const BAR = `export default function setup(layer) {
  const ctx = layer.canvas.getContext("2d");
  return function draw(frame) {
    ctx.fillStyle = frame.values.tint.css;
    ctx.fillRect(0, 0, frame.width * frame.progress, frame.height);
  };
}`;
const tint = { r: 1, g: 0, b: 0, a: 1, css: "rgb(255 0 0 / 1)" };

test("a module fills a bar from frame.values and frame.progress, at two times", { skip }, async () => {
  const [early, late] = await renderer.render({ script: BAR, width: 40, height: 20, frames: [frameAt(0.5, { tint }), frameAt(1.5, { tint })] });
  const one = await pixels(early.png), two = await pixels(late.png);
  assert.equal(early.empty, false);
  assert.deepEqual([one.width, one.height], [40, 20]);
  assert.deepEqual(one.at(5, 10), [255, 0, 0, 255]);
  assert.deepEqual(one.at(15, 10), [0, 0, 0, 0], "a quarter of 40 px is 10 px");
  assert.deepEqual(two.at(25, 10), [255, 0, 0, 255]);
  assert.deepEqual(two.at(35, 10), [0, 0, 0, 0]);
});

test("pixel ratio 2 doubles the PNG with the same drawing code", { skip }, async () => {
  const [frame] = await renderer.render({ script: BAR, width: 40, height: 20, pixelRatio: 2, frames: [frameAt(0.5, { tint })] });
  const picture = await pixels(frame.png);
  assert.deepEqual([picture.width, picture.height], [80, 40]);
  assert.deepEqual(picture.at(18, 30), [255, 0, 0, 255]);
  assert.deepEqual(picture.at(22, 30), [0, 0, 0, 0]);
});

test("Math.random, Date.now and performance.now give the same picture again and in reverse order", { skip }, async () => {
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return (frame) => {
      if (Date.now() !== frame.time * 1000 || performance.now() !== frame.time * 1000) throw new Error("clock");
      ctx.fillStyle = "#fff";
      for (let i = 0; i < 30; i += 1) ctx.fillRect(Math.random() * 40, Math.random() * 20, 2, 2);
      ctx.fillRect(Date.now() / 100, 0, 1, 1);
    };
  }`;
  const frames = [frameAt(0.25), frameAt(1)];
  const first = await renderer.render({ script, width: 40, height: 20, frames });
  const again = await renderer.render({ script, width: 40, height: 20, frames });
  const reversed = (await renderer.render({ script, width: 40, height: 20, frames: [...frames].reverse() })).reverse();
  for (const result of [...first, ...again, ...reversed]) assert.ok(result.png, result.error?.message);
  assert.ok(!first[0].png.equals(first[1].png), "the two times differ");
  for (const index of [0, 1]) {
    assert.ok(first[index].png.equals(again[index].png));
    assert.ok(first[index].png.equals(reversed[index].png));
  }
});

test("crypto.getRandomValues and randomUUID repeat for the same frame, as Math.random does", { skip }, async () => {
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return () => {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      ctx.fillStyle = "#fff";
      for (let i = 0; i < 20; i += 1) if (bytes[i] > 127) ctx.fillRect(i * 2, 0, 2, 20);
      if (crypto.randomUUID().length !== 36) throw new Error("uuid");
    };
  }`;
  const [first] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0.5)] });
  const [again] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0.5)] });
  assert.ok(first.png, first.error?.message);
  assert.equal(first.empty, false);
  assert.ok(first.png.equals(again.png));
});

test("a clip, a style and an open path one frame leaves never reach the next frame", { skip }, async () => {
  // The first frame (time 0) clips to a corner and leaves a red fill and a path open; any later
  // frame only fills, so a leak would show as a clipped or red picture.
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return (frame) => {
      if (frame.time === 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 4, 4); ctx.clip();
        ctx.fillStyle = "#ff0000"; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.rect(0, 0, 40, 20);
        return;
      }
      ctx.fill();
      ctx.fillStyle = ctx.fillStyle === "#000000" ? "#00ff00" : "#0000ff";
      ctx.fillRect(0, 0, 40, 20);
    };
  }`;
  const [, later] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0), frameAt(1)] });
  const picture = await pixels(later.png);
  assert.deepEqual(picture.at(30, 15), [0, 255, 0, 255], "full size, opaque, default fill style");
});

test("the network is out of reach: fetch, WebSocket and an image fail and no request leaves the session", { skip }, async () => {
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return async () => {
      let reached = false;
      try { await fetch("https://example.com/kino-script-test"); reached = true; } catch {}
      await new Promise((done) => {
        try {
          const socket = new WebSocket("wss://example.com/kino-script-test");
          socket.onopen = () => { reached = true; done(); };
          socket.onerror = socket.onclose = done;
        } catch { done(); }
      });
      try { await createImageBitmap(await (await fetch("http://127.0.0.1:9/x.png")).blob()); reached = true; } catch {}
      ctx.fillStyle = reached ? "#f00" : "#0f0";
      ctx.fillRect(0, 0, 40, 20);
    };
  }`;
  const [frame] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0)] });
  assert.deepEqual((await pixels(frame.png)).at(1, 1), [0, 255, 0, 255], frame.error?.message);
  const seen = await renderer.networkLog();
  const outside = seen.allowed.filter((url) => !/^(kino-script:\/\/app\/(host|frame)\.html|blob:|data:)/.test(url));
  assert.deepEqual(outside, [], "only the worker's own pages and in-memory URLs were let through");
  assert.ok(seen.allowed.some((url) => url.startsWith("kino-script://app/frame.html")), "the session hook saw the page's own requests");
});

test("the module cannot reach the page around it, Node, storage, new windows or another page", { skip }, async () => {
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    const reached = [];
    const tries = {
      parent: () => parent.document.title, top: () => top.location.href, opener: () => opener.document,
      storage: () => localStorage.length, cookie: () => document.cookie, idb: () => indexedDB.open("x"),
    };
    for (const [name, attempt] of Object.entries(tries)) { try { attempt(); reached.push(name); } catch {} }
    if (typeof require !== "undefined" || typeof process !== "undefined") reached.push("node");
    try { if (window.open("https://example.com/")) reached.push("window"); } catch {}
    try { top.location.href = "https://example.com/"; reached.push("navigate"); } catch {}
    return () => { if (reached.length) throw new Error("reached " + reached.join(", ")); ctx.fillRect(0, 0, 4, 4); };
  }`;
  const [first] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0)] });
  assert.equal(first.empty, false, first.error?.message);
  const leaving = "export default function setup() { location.href = \"https://example.com/\"; return () => {}; }";
  const [left] = await renderer.render({ script: leaving, width: 40, height: 20, frames: [frameAt(0.5)] });
  assert.match(left.error.message, /^The script tried to open another page \(https:\/\/example\.com\/\)/);
  const seen = await renderer.networkLog();
  assert.deepEqual(seen.allowed.filter((url) => /^(https?|wss?|file):/.test(url)), []);
});

test("a draw that never returns fails as too long at its time, and the next render works", { skip }, async () => {
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return (frame) => { if (frame.time > 1) while (true) {} ctx.fillRect(0, 0, 4, 4); };
  }`;
  const [stuck, after] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(1.2), frameAt(0.5)] });
  assert.deepEqual(stuck.error, { message: "script took too long at 1.20 s", phase: "draw", time: 1.2 });
  assert.match(after.error.message, /^not drawn/);
  const [next] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0.5)] });
  assert.equal(next.empty, false, next.error?.message);
});

test("a syntax error and a thrown error give their message, phase, time and line", { skip }, async () => {
  const [broken] = await renderer.render({ script: "export default function setup(layer) {\n  return (frame => {;\n}", width: 40, height: 20, frames: [frameAt(0.5)] });
  assert.equal(broken.error.phase, "load");
  assert.equal(broken.error.time, 0.5);
  assert.match(broken.error.message, /SyntaxError/);
  assert.equal(typeof broken.error.line, "number");
  const thrower = "export default function setup(layer) {\n  return (frame) => {\n    throw new Error(\"no bar at \" + frame.time);\n  };\n}";
  const [thrown] = await renderer.render({ script: thrower, width: 40, height: 20, frames: [frameAt(0.75)] });
  assert.deepEqual(thrown.error, { message: "no bar at 0.75", phase: "draw", time: 0.75, line: 3, column: 11 });
});

test("a module that draws nothing reports an empty frame", { skip }, async () => {
  const script = "export default function setup(layer) { layer.canvas.getContext(\"2d\"); return () => {}; }";
  const [frame] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0)] });
  assert.equal(frame.empty, true);
});

test("an image input arrives as an ImageBitmap the module can draw", { skip }, async () => {
  const canvas = createCanvas(4, 4);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0000ff";
  context.fillRect(0, 0, 4, 4);
  const script = `export default function setup(layer) {
    const ctx = layer.canvas.getContext("2d");
    return (frame) => {
      if (!(frame.values.photo instanceof ImageBitmap)) throw new Error("not a bitmap");
      ctx.drawImage(frame.values.photo, 0, 0, frame.width, frame.height);
    };
  }`;
  const [frame] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0, { photo: null })], images: { photo: canvas.toBuffer("image/png") } });
  assert.deepEqual((await pixels(frame.png)).at(20, 10), [0, 0, 255, 255], frame.error?.message);
});

test("a webgl2 context clears to a color, when the hidden window has WebGL 2", { skip }, async (t) => {
  const script = `export default function setup(layer) {
    const gl = layer.canvas.getContext("webgl2");
    if (!gl) throw new Error("no webgl2");
    return () => { gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
  }`;
  const [frame] = await renderer.render({ script, width: 40, height: 20, frames: [frameAt(0)] });
  if (frame.error?.message === "no webgl2") return t.skip("webgl2 is not available in the hidden window");
  t.diagnostic("webgl2 is available in the hidden window");
  assert.deepEqual((await pixels(frame.png)).at(20, 10), [0, 0, 255, 255], frame.error?.message);
});
