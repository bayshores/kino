// The live preview's script frame on a visitor's machine (frontend/scriptHost.js with the frame
// page backend/script-frame-page.mjs serves), in the test browser: a module cannot reach the
// network or the page, and a module stuck in an endless loop is given up after the limit while
// the page keeps running. Also measures one 1920x1080 picture from request to painted.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sendScriptFrame } from "../backend/script-frame-page.mjs";
import { SCRIPT_LIMITS } from "../engine/scriptRuntime.js";
import { Browser } from "./dashboard-browser.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let browser, folder, page, other;
const otherRequests = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// The page: the host module and the frame page, from one server.
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>host</title><body><script type="module">
document.cookie = "kino_test=secret";
localStorage.setItem("kino_test", "secret");
import("/frontend/scriptHost.js").then((module) => { window.createScriptHost = module.createScriptHost; window.hostReady = true; },
  (error) => { window.hostReady = String(error); });
</script></body>`;

before(async () => {
  page = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(HOST_PAGE);
    if (url.pathname === "/api/script-frame") return sendScriptFrame(req, res);
    if (/^\/(frontend|engine)\/[\w/.-]+\.js$/.test(url.pathname)) {
      try { return res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(path.join(root, url.pathname))); } catch { /* not found */ }
    }
    res.writeHead(404).end();
  });
  // Another host the module tries to reach.
  other = http.createServer((req, res) => { otherRequests.push(req.url); res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("reached"); });
  other.on("upgrade", (req, socket) => { otherRequests.push(`upgrade ${req.url}`); socket.destroy(); });
  const pagePort = await listen(page);
  other.port = await listen(other);
  folder = await mkdtemp(path.join(tmpdir(), "kino-script-preview-"));
  browser = await Browser.open(path.join(folder, "electron"));
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${pagePort}/` });
  assert.equal(await browser.waitFor("window.hostReady", { what: "the host page" }), true);
});

after(async () => {
  browser?.child?.kill();
  page?.close();
  other?.close();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

// Mounts `script` in a new frame in the page and gives back the mount's answer.
const mountIn = (script, extra = "") => `(async () => {
  const host = window.createScriptHost({ src: "/api/script-frame" });
  window.host = host;
  const reply = await host.mount({ script: ${JSON.stringify(script)}, width: 1920, height: 1080, pixelRatio: 1, name: "test", images: {} });
  ${extra}
  return reply;
})()`;

test("a module in the preview frame cannot reach the network, the page, its cookies or its storage", async () => {
  const otherHost = `http://localhost:${other.port}`;
  const script = `export default async function setup() {
    const results = {};
    const attempt = async (name, run) => { try { results[name] = "got " + String(await run()); } catch (error) { results[name] = "blocked"; } };
    const wait = (start) => new Promise((resolve, reject) => { start(resolve, reject); setTimeout(() => reject(new Error("no answer")), 1500); });
    await attempt("fetch", () => fetch(${JSON.stringify(`${otherHost}/fetch`)}).then((response) => response.status));
    await attempt("socket", () => wait((resolve, reject) => { const socket = new WebSocket(${JSON.stringify(`ws://localhost:${other.port}/socket`)}); socket.onopen = () => resolve("open"); socket.onerror = reject; }));
    await attempt("image", () => wait((resolve, reject) => { const image = new Image(); image.onload = () => resolve("loaded"); image.onerror = reject; image.src = ${JSON.stringify(`${otherHost}/image.png`)}; }));
    await attempt("parent", () => parent.document.title);
    await attempt("top", () => top.location.href);
    await attempt("cookie", () => document.cookie || Promise.reject(new Error("none")));
    await attempt("storage", () => localStorage.getItem("kino_test"));
    throw new Error(JSON.stringify(results));
  }`;
  const reply = await browser.evaluate(mountIn(script, "host.destroy();"));
  assert.equal(reply.ok, false);
  const results = JSON.parse(reply.message.replace(/^Error: /, ""));
  assert.deepEqual(results, { fetch: "blocked", socket: "blocked", image: "blocked", parent: "blocked", top: "blocked", cookie: "blocked", storage: "blocked" });
  assert.deepEqual(otherRequests, [], "nothing reached the other host");
});

test("one 1920x1080 picture, from request to painted in a page canvas", async () => {
  const script = `export default function setup(layer) {
    const context = layer.canvas.getContext("2d");
    return function draw(frame) {
      const gradient = context.createLinearGradient(0, 0, layer.width, 0);
      gradient.addColorStop(0, "#ff3366"); gradient.addColorStop(1, "#3366ff");
      context.fillStyle = gradient;
      context.fillRect(0, 0, layer.width * frame.progress, layer.height);
    };
  }`;
  const result = await browser.evaluate(`(async () => {
    const mounted = await (${mountIn(script)});
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const context = canvas.getContext("2d");
    const times = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const reply = await window.host.draw({ time: index / 30, duration: 1, progress: (index + 1) / 30, values: {}, width: 1920, height: 1080 });
      if (!reply.ok) return { error: reply.message };
      canvas.width = reply.bitmap.width; canvas.height = reply.bitmap.height;
      context.drawImage(reply.bitmap, 0, 0);
      reply.bitmap.close();
      times.push(performance.now() - started);
    }
    const pixel = [...context.getImageData(10, 10, 1, 1).data];
    window.host.destroy();
    times.sort((a, b) => a - b);
    return { mounted: mounted.ok, median: times[15], worst: times[29], pixel };
  })()`, 30_000);
  assert.equal(result.mounted, true, JSON.stringify(result));
  const [red, green, blue] = result.pixel;
  assert.ok(Math.abs(red - 255) < 12 && Math.abs(green - 51) < 12 && Math.abs(blue - 102) < 12, `the left edge is the gradient's first color, got ${result.pixel}`);
  console.log(`# 1920x1080 picture, request to painted: median ${result.median.toFixed(1)} ms, worst ${result.worst.toFixed(1)} ms`);
});

// Last: the stuck frame's process stays busy, and Chromium puts later sandboxed frames from the
// same server in that same process, so a new frame in this page would not start.
test("a module stuck in an endless loop is given up after the limit; the page keeps running and the frame is gone", async () => {
  const script = "export default function setup() { return function draw() { for (;;) {} }; }";
  const result = await browser.evaluate(`(async () => {
    const mounted = await (${mountIn(script)});
    let ticks = 0;
    const counter = setInterval(() => { ticks += 1; }, 50);
    const started = performance.now();
    const drawn = await window.host.draw({ time: 1, duration: 2, progress: 0.5, values: {}, width: 1920, height: 1080 });
    clearInterval(counter);
    return { mounted: mounted.ok, drawn, ms: Math.round(performance.now() - started), ticks, frames: document.querySelectorAll("iframe[data-kino-script-frame]").length };
  })()`, 30_000);
  assert.equal(result.mounted, true);
  assert.equal(result.drawn.tooLong, true, JSON.stringify(result.drawn));
  assert.ok(result.ms >= SCRIPT_LIMITS.drawMs && result.ms < SCRIPT_LIMITS.drawMs + 1500, `gave up after ${result.ms} ms`);
  // A page that froze with the frame would count no ticks while the frame looped.
  assert.ok(result.ticks >= (SCRIPT_LIMITS.drawMs / 50) * 0.5, `the page ran ${result.ticks} timer ticks during the loop`);
  assert.equal(result.frames, 0, "the stuck frame was thrown away");
  console.log(`# endless loop: given up after ${result.ms} ms; the page ran ${result.ticks} 50 ms ticks meanwhile`);
});
