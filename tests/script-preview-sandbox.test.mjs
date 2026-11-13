// The live preview's script frame on a visitor's machine (frontend/scriptHost.js with the frame
// page backend/script-frame-page.mjs serves), in the test browser: a module cannot reach the
// network or the page; a module stuck in an endless loop is stopped at the limit, its Worker is
// gone and the same frame draws the next module; the preview's Worker draws the same pixels as the
// backend's direct mode; an image input arrives as a picture. Also measures one 1920x1080 picture
// from request to painted.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sendScriptFrame, sendScriptLibrary } from "../backend/script-frame-page.mjs";
import { CUBE_SCRIPT, makeGlb } from "../backend/glb.test.support.mjs";
import { SCRIPT_FRAME_CSP, SCRIPT_LIMITS, scriptFrameHtml } from "../engine/scriptRuntime.js";
import { Browser } from "./dashboard-browser.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let browser, folder, page, other, pageUrl;
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
    if (url.pathname === "/api/script-library") return sendScriptLibrary(req, res, url.searchParams.get("name"));
    // The backend renderer's page: the module runs in the frame itself (direct mode).
    if (url.pathname === "/direct-frame") return res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": SCRIPT_FRAME_CSP }).end(scriptFrameHtml());
    if (/^\/(frontend|engine)\/[\w/.-]+\.js$/.test(url.pathname)) {
      try { return res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(path.join(root, url.pathname))); } catch { /* not found */ }
    }
    res.writeHead(404).end();
  });
  // Another host the module tries to reach.
  other = http.createServer((req, res) => { otherRequests.push(req.url); res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("reached"); });
  other.on("upgrade", (req, socket) => { otherRequests.push(`upgrade ${req.url}`); socket.destroy(); });
  const pagePort = await listen(page);
  pageUrl = `http://127.0.0.1:${pagePort}`;
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
const mountIn = (script, extra = "", src = "/api/script-frame") => `(async () => {
  const host = window.createScriptHost({ src: ${JSON.stringify(src)} });
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
    const wait = (start) => new Promise((resolve, reject) => { start(resolve, reject); setTimeout(() => reject(new Error("no answer")), 500); });
    await attempt("fetch", () => fetch(${JSON.stringify(`${otherHost}/fetch`)}).then((response) => response.status));
    await attempt("socket", () => wait((resolve, reject) => { const socket = new WebSocket(${JSON.stringify(`ws://localhost:${other.port}/socket`)}); socket.onopen = () => resolve("open"); socket.onerror = reject; }));
    await attempt("image", () => wait((resolve, reject) => { const image = new Image(); image.onload = () => resolve("loaded"); image.onerror = reject; image.src = ${JSON.stringify(`${otherHost}/image.png`)}; }));
    await attempt("parent", () => parent.document.title);
    await attempt("top", () => top.location.href);
    await attempt("cookie", () => document.cookie || Promise.reject(new Error("none")));
    await attempt("storage", () => localStorage.getItem("kino_test"));
    await attempt("database", () => wait((resolve, reject) => { const request = indexedDB.open("kino"); request.onsuccess = () => resolve("open"); request.onerror = reject; }));
    await attempt("worker", () => new Worker(URL.createObjectURL(new Blob(["1"]))));
    throw new Error(JSON.stringify(results));
  }`;
  const reply = await browser.evaluate(mountIn(script, "host.destroy();"));
  assert.equal(reply.ok, false);
  const results = JSON.parse(reply.message.replace(/^Error: /, ""));
  assert.deepEqual(results, { fetch: "blocked", socket: "blocked", image: "blocked", parent: "blocked", top: "blocked", cookie: "blocked", storage: "blocked", database: "blocked", worker: "blocked" });
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

// CPU seconds used so far by the test browser's processes (its main process and every helper),
// from `ps` (cumulative CPU time, so a process spinning in a loop adds about 1 s every second).
function browserCpuSeconds() {
  return new Promise((resolve, reject) => execFile("ps", ["-A", "-o", "pid=,ppid=,time="], (error, out) => {
    if (error) return reject(error);
    const rows = out.trim().split("\n").map((line) => line.trim().split(/\s+/));
    const ours = new Set([String(browser.child.pid)]);
    for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (ours.has(ppid) && !ours.has(pid)) { ours.add(pid); grew = true; } }
    const seconds = (text) => text.split(/[:-]/).map(Number).reduce((total, part) => total * 60 + part, 0);
    resolve(rows.filter(([pid]) => ours.has(pid)).reduce((total, [, , time]) => total + seconds(time), 0));
  }));
}

test("a 3D module with a .glb model draws in the preview's Worker: the model's color, an embedded texture, a turn, nothing sent out", async (t) => {
  const before = otherRequests.length;
  // The library route serves only the two names a script may import, as script text.
  const served = await fetch(`${pageUrl}/api/script-library?name=three`);
  assert.deepEqual([served.status, served.headers.get("x-content-type-options"), served.headers.get("content-type")], [200, "nosniff", "text/javascript; charset=utf-8"]);
  for (const name of ["three/../../package.json", "../package.json", "three.js", "", "gltf-loader.js"])
    assert.equal((await fetch(`${pageUrl}/api/script-library?name=${encodeURIComponent(name)}`)).status, 404, name);
  const drawn = await browser.evaluate(`(async () => {
    const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0)).buffer;
    const libraries = {};
    for (const name of ["three", "three/addons/loaders/GLTFLoader.js"]) libraries[name] = await (await fetch("/api/script-library?name=" + encodeURIComponent(name))).text();
    const picture = async (glb, times) => {
      const host = window.createScriptHost({ src: "/api/script-frame" });
      const mounted = await host.mount({ script: ${JSON.stringify(CUBE_SCRIPT)}, width: 80, height: 60, pixelRatio: 1, name: "cube", images: {}, models: { model: decode(glb) }, libraries });
      if (!mounted.ok) { host.destroy(); return { error: mounted.message }; }
      const pixels = [];
      for (const time of times) {
        const reply = await host.draw({ time, duration: 2, progress: time / 2, values: { model: "/api/media/cube.glb" }, width: 80, height: 60 });
        if (!reply.ok) { host.destroy(); return { error: reply.message }; }
        const canvas = new OffscreenCanvas(80, 60);
        canvas.getContext("2d").drawImage(reply.bitmap, 0, 0);
        const data = canvas.getContext("2d").getImageData(0, 0, 80, 60).data;
        pixels.push({ middle: [...data.subarray((30 * 80 + 40) * 4, (30 * 80 + 40) * 4 + 4)], corner: [...data.subarray(4, 8)] });
      }
      host.destroy();
      return pixels;
    };
    return { plain: await picture(${JSON.stringify(makeGlb().toString("base64"))}, [0, 0.25]),
      textured: await picture(${JSON.stringify(makeGlb({ texture: "#00ff00" }).toString("base64"))}, [0]) };
  })()`, 30_000);
  // A test browser with no graphics card (the CI runners) cannot make a WebGL context at all.
  if (/Error creating WebGL context/.test(drawn.plain?.error ?? "")) return t.skip("WebGL is not available in the test browser");
  assert.ok(Array.isArray(drawn.plain), `the plain cube: ${JSON.stringify(drawn.plain)}`);
  assert.ok(Array.isArray(drawn.textured), `the textured cube: ${JSON.stringify(drawn.textured)}`);
  const [first, turned] = drawn.plain;
  // Compared loosely: the test browser's WebGL shading may differ by a few levels from the hidden window's.
  assert.ok(first.middle[0] > 150 && first.middle[1] < 60 && first.middle[2] < 60, `red in the middle: ${first.middle}`);
  assert.deepEqual(first.corner, [0, 0, 0, 0], "transparent around the cube");
  assert.notDeepEqual(first.middle, turned.middle, "the turn changes the shading");
  const green = drawn.textured[0].middle;
  assert.ok(green[1] > 150 && green[0] < 60, `the embedded texture's green: ${green}`);
  assert.equal(otherRequests.length, before, "nothing reached the other host");
  console.log(`# 3D in the preview Worker: red ${first.middle}, turned ${turned.middle}, textured ${green}`);
});

test("a module stuck in an endless loop is stopped at the limit; its Worker is gone and the same frame draws a corrected module at once", async () => {
  const stuck = "export default function setup() { return function draw() { for (;;) {} }; }";
  const fixed = "export default function setup(layer) { const context = layer.canvas.getContext(\"2d\"); return function draw() { context.fillStyle = \"#00ff00\"; context.fillRect(0, 0, 8, 8); }; }";
  const busy = await browser.evaluate(`(async () => {
    const mounted = await (${mountIn(stuck)});
    window.host.draw({ time: 1, duration: 2, progress: 0.5, values: {}, width: 1920, height: 1080 }).then((reply) => { window.stuckReply = reply; });
    return mounted.ok;
  })()`);
  assert.equal(busy, true);
  // While the module loops, a process spins: about one CPU second each second.
  const spinStart = await browserCpuSeconds();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const spinning = (await browserCpuSeconds()) - spinStart;
  const result = await browser.evaluate(`(async () => {
    let ticks = 0;
    const counter = setInterval(() => { ticks += 1; }, 50);
    while (!window.stuckReply) await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(counter);
    const started = performance.now();
    const mounted = await window.host.mount({ script: ${JSON.stringify(fixed)}, width: 16, height: 16, pixelRatio: 1, name: "fixed", images: {} });
    const drawn = await window.host.draw({ time: 0, duration: 1, progress: 0, values: {}, width: 16, height: 16 });
    const ms = Math.round(performance.now() - started);
    const canvas = new OffscreenCanvas(16, 16);
    canvas.getContext("2d").drawImage(drawn.bitmap, 0, 0);
    return { stuck: window.stuckReply, ticks, mounted: mounted.ok, drawn: drawn.ok, ms, pixel: [...canvas.getContext("2d").getImageData(2, 2, 1, 1).data],
      frames: document.querySelectorAll("iframe[data-kino-script-frame]").length, destroyed: window.host.destroyed };
  })()`, 30_000);
  assert.equal(result.stuck.tooLong, true, JSON.stringify(result.stuck));
  // A page that froze with the frame would count no ticks while the module looped.
  assert.ok(result.ticks >= 10, `the page ran ${result.ticks} timer ticks during the loop`);
  assert.deepEqual([result.mounted, result.drawn, result.destroyed], [true, true, false], "the same frame mounts and draws again");
  assert.ok(result.ms < 1000, `the corrected module drew in ${result.ms} ms`);
  assert.deepEqual(result.pixel, [0, 255, 0, 255]);
  // Once the Worker is stopped nothing spins: the browser's processes use little CPU.
  // (Measured: the stopped Worker's thread still spins up to about 2 s after terminate(), the
  // browser's grace before it forces the stop; after that its process is idle.)
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const idleStart = await browserCpuSeconds();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const idle = (await browserCpuSeconds()) - idleStart;
  assert.ok(spinning >= 0.5, `a process spun during the loop (${spinning} CPU s in 1 s)`);
  assert.ok(idle < 0.5, `nothing spins after the stop (${idle} CPU s in 1 s)`);
  await browser.evaluate("window.host.destroy()");
  console.log(`# endless loop: stopped at the limit, page ran ${result.ticks} ticks; corrected module drew in ${result.ms} ms; CPU in 1 s: ${spinning} s while stuck, ${idle} s after`);
});

test("the preview's Worker draws the same pixels as the backend's direct mode for the same frame", async () => {
  const script = `export default function setup(layer) {
    const context = layer.canvas.getContext("2d");
    return function draw(frame) {
      context.fillStyle = "#123456"; context.fillRect(0, 0, layer.width, layer.height);
      for (let index = 0; index < 40; index += 1) {
        context.fillStyle = "hsl(" + Math.floor(Math.random() * 360) + " 80% 50%)";
        context.beginPath(); context.arc(Math.random() * layer.width, Math.random() * layer.height, 4 + frame.progress * 20, 0, Math.PI * 2); context.fill();
      }
      context.font = "20px sans-serif"; context.fillStyle = "white"; context.fillText(String(Date.now()) + " " + crypto.randomUUID().slice(0, 8), 10, 30);
    };
  }`;
  const both = await browser.evaluate(`(async () => {
    const frame = { time: 0.75, duration: 2, progress: 0.375, values: {}, width: 320, height: 180 };
    const bytes = async (src) => {
      const host = window.createScriptHost({ src });
      await host.mount({ script: ${JSON.stringify(script)}, width: 320, height: 180, pixelRatio: 1, name: "same", images: {} });
      const reply = await host.draw(frame, "png");
      host.destroy();
      return reply.png ? [...new Uint8Array(reply.png)].join(",") : JSON.stringify(reply);
    };
    return { worker: await bytes("/api/script-frame"), direct: await bytes("/direct-frame") };
  })()`);
  assert.ok(both.worker.length > 1000, both.worker.slice(0, 200));
  assert.equal(both.worker, both.direct, "the PNG bytes match");
});

test("an image input reaches the module as a picture it can draw", async () => {
  const script = "export default function setup(layer) { const context = layer.canvas.getContext(\"2d\"); return function draw(frame) { context.drawImage(frame.values.logo, 0, 0, layer.width, layer.height); }; }";
  const pixel = await browser.evaluate(`(async () => {
    const source = new OffscreenCanvas(4, 4);
    const context = source.getContext("2d");
    context.fillStyle = "#ff8800"; context.fillRect(0, 0, 4, 4);
    const png = await (await source.convertToBlob({ type: "image/png" })).arrayBuffer();
    const host = window.createScriptHost({ src: "/api/script-frame" });
    const mounted = await host.mount({ script: ${JSON.stringify(script)}, width: 8, height: 8, pixelRatio: 1, name: "logo", images: { logo: png } });
    const drawn = await host.draw({ time: 0, duration: 1, progress: 0, values: { logo: "/api/media/logo.png" }, width: 8, height: 8 });
    host.destroy();
    if (!drawn.ok) return [mounted.message, drawn.message];
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext("2d").drawImage(drawn.bitmap, 0, 0);
    return [...canvas.getContext("2d").getImageData(4, 4, 1, 1).data];
  })()`);
  assert.deepEqual(pixel, [255, 136, 0, 255]);
});
