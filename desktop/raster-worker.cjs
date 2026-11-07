// A separate, sandboxed Chromium process paints generated SVG for effect exports.
// It never opens the editor, reads an owner session, or loads a network resource.
const { app, BrowserWindow, nativeImage, protocol, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const MAX_SIDE = 16384;
const MAX_PIXELS = 64_000_000;
const MAX_INPUT = 128 * 1024 * 1024;
// The time a frame may take when the request gives none (backend/chromium-raster.mjs gives each
// frame its own, longer for bigger frames: frameTimeLimitMs), and the longest it may give.
const FRAME_TIMEOUT = 45_000;
const MAX_FRAME_TIMEOUT = 24 * 60 * 60 * 1000;
const CAPTURE_ATTEMPTS = 5;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Chromium sometimes has no frame ready to copy and rejects with "UnknownVizError"
// (seen on Linux CI). Asking for a new frame and trying again a moment later works;
// VS Code's browser view retries the same error. Any other error is real.
async function capturePage(webContents, wait = delay) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await webContents.capturePage();
    } catch (error) {
      if (error?.message !== "UnknownVizError" || attempt >= CAPTURE_ATTEMPTS) throw error;
      webContents.invalidate();
      await wait(16 * attempt);
    }
  }
}

// The page draws a one-pixel row under the picture in a grey that changes with every request.
// A capture without this request's grey is an older frame: Chromium had not drawn the new SVG
// yet (a frame of hundreds of blurred copies can take seconds to rasterize), so the capture was
// the previous picture (measured: the frame before came back for 2 of 7 heavy test frames).
// Look again until the grey shows. A heavy frame can also leave no frame ready to copy at all
// ("UnknownVizError" even after capturePage's retries); keep waiting for it the same way.
const frameMarker = id => 32 + (id % 12) * 16;

// How long the capture may keep looking: 5 s less than the frame's time limit, so that the worker
// answers before backend/chromium-raster.mjs stops it (half the limit for a limit under 10 s).
const captureTimeout = frameTimeout => Math.max(frameTimeout / 2, frameTimeout - 5_000);

async function captureFrame(webContents, { width, height, marker, wait = delay, timeout = captureTimeout(FRAME_TIMEOUT), now = Date.now }) {
  const started = now();
  for (let attempt = 1; ; attempt += 1) {
    let image = null;
    try {
      image = await capturePage(webContents, wait);
    } catch (error) {
      if (error?.message !== "UnknownVizError" || now() - started > timeout) throw error;
    }
    if (image) {
      const size = image.getSize();
      if (size.width !== width || size.height !== height + 1) throw new Error("Chromium returned an unexpected export size.");
      const pixel = image.crop({ x: 0, y: height, width: 1, height: 1 }).toBitmap();
      if ([0, 1, 2].every(channel => Math.abs(pixel[channel] - marker) <= 6) && pixel[3] === 255)
        return image.crop({ x: 0, y: 0, width, height });
    }
    if (now() - started > timeout) throw new Error("Chromium did not draw the export frame in time.");
    await wait(Math.min(100, 8 * attempt));
  }
}

// The page has no script: desktop/raster-page.cjs (its preload) paints each frame.
function fixedHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: ${MEDIA_SCHEME}:; font-src data:; base-uri 'none'; form-action 'none'">
<style>html,body,#root{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}#root{height:calc(100% - 1px)}#root>svg{display:block;width:100%;height:100%}#kino-frame{width:100%;height:1px}</style>
</head><body><main id="root"></main><div id="kino-frame"></div></body></html>`;
}

// Pictures of this export (video and GIF frames that FFmpeg wrote as PNG files, and the export's
// still images) reach the page as short links, kino-frame://media/<the file's absolute path>,
// instead of base64 data: URLs inside the SVG: Chromium kept every data: URL it was sent, about
// its own size again for every frame. The page asks for each link and this answers with the file's
// bytes, but only for a picture file inside the folder the export gave (--kino-raster-media).
// "no-store" keeps Chromium from holding on to old pictures.
const MEDIA_SCHEME = "kino-frame";
const MAX_PICTURE_BYTES = 256 * 1024 * 1024;
const PICTURE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };

function isInside(folder, file) {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// For tests only: KINO_RASTER_TEST_PICTURE_DELAY_MS answers each picture that many milliseconds
// late (at most 5000), as a busy computer may, so a page that shows a frame before its linked
// pictures have arrived draws it without them every time (backend/chromium-media-links.test.mjs).
const PICTURE_DELAY = Math.min(5000, Math.max(0, Number(process.env.KINO_RASTER_TEST_PICTURE_DELAY_MS) || 0));

async function mediaResponse(request, mediaRoot) {
  const missing = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (PICTURE_DELAY) await delay(PICTURE_DELAY);
  if (!mediaRoot || request.method !== "GET") return missing();
  let file;
  try {
    const url = new URL(request.url);
    // The page adds ?paint=<request number> to each link (desktop/raster-page.cjs).
    if (url.host !== "media" || (url.search && !/^\?paint=\d{1,16}$/.test(url.search)) || url.hash) return missing();
    file = await fs.promises.realpath(fileURLToPath(`file://${url.pathname}`));
  } catch {
    return missing();
  }
  const type = PICTURE_TYPES[path.extname(file).toLowerCase()];
  if (!type || !isInside(mediaRoot, file)) return missing();
  try {
    const info = await fs.promises.stat(file);
    if (!info.isFile() || info.size > MAX_PICTURE_BYTES) return missing();
    const bytes = await fs.promises.readFile(file);
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store" } });
  } catch {
    return missing();
  }
}

function writeResponse(value) {
  return new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
}

// A frame's pixels go out as one JSON line that gives their length, then the bytes themselves,
// then the line {"id":N,"end":true}, by which backend/chromium-raster.mjs knows that no stray
// bytes got in. One write keeps the three together, and the next request waits until it is done,
// so frames never pile up in memory. `extra`: rendererKB, and renderer and card when not yet sent.
function writePixels(id, width, height, pixels, extra) {
  const header = Buffer.from(`${JSON.stringify({ id, width, height, pixelBytes: pixels.length, ...extra })}\n`);
  const end = Buffer.from(`${JSON.stringify({ id, end: true })}\n`);
  return new Promise((resolve, reject) => process.stdout.write(Buffer.concat([header, pixels, end]), error => error ? reject(error) : resolve()));
}

// Chromium keeps pixels with premultiplied alpha, in the byte order of the machine: blue, green,
// red, alpha (BGRA) on a Mac. Reading back one pure red pixel tells which order this machine uses.
const RED_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==";

function bitmapIsBgra() {
  const red = nativeImage.createFromDataURL(RED_PIXEL_PNG).toBitmap();
  if (red[3] !== 255 || red[1] !== 0 || red[0] + red[2] !== 255) throw new Error("Chromium's pixel byte order is unknown.");
  return red[2] === 255;
}

// The picture as RGBA bytes with premultiplied alpha, row by row (what toBitmap gives, with red
// and blue swapped when Chromium stores BGRA). Sending these instead of a PNG file saves the PNG
// compression, which took most of a smooth 1080p frame's time (about 0.48 s of 0.55 s for fog).
function rgbaPixels(image, bgra) {
  const pixels = image.toBitmap();
  if (bgra) for (let index = 0; index < pixels.length; index += 4) {
    const blue = pixels[index];
    pixels[index] = pixels[index + 2];
    pixels[index + 2] = blue;
  }
  return pixels;
}

// What a renderer string from Chromium names, shorter: ANGLE's "ANGLE (Apple, ANGLE Metal Renderer:
// Apple M3 Pro, Unspecified Version)" becomes "Apple M3 Pro (Metal)", and "ANGLE (Mesa, llvmpipe
// (LLVM 15.0.7, 256 bits), OpenGL 4.5)" becomes "llvmpipe (LLVM 15.0.7, 256 bits)".
function cleanRenderer(value) {
  let text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const angle = /^ANGLE \((.*)\)$/.exec(text);
  if (angle) {
    // The parts between commas that are not inside brackets: maker, renderer, version.
    const parts = [];
    let depth = 0, start = 0;
    for (let index = 0; index <= angle[1].length; index += 1) {
      const character = angle[1][index];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if ((character === "," && depth === 0) || character === undefined) {
        parts.push(angle[1].slice(start, index).trim());
        start = index + 1;
      }
    }
    if (parts[1]) text = parts[1].replace(/^ANGLE /, "").replace(/^(.+?) Renderer: (.+)$/, "$2 ($1)");
  }
  return text.slice(0, 160);
}

// Whether Chromium's feature status says it composites or rasterizes on the processor.
function softwareStatus(status) {
  return [status?.gpu_compositing, status?.rasterization].some(value => /software|disabled|unavailable/i.test(String(value ?? "")));
}

// What Chromium draws with: { renderer, card }. `renderer` names the graphics card (Chromium's GL
// renderer, else its active device) or is "processor (software)" when it draws on the processor:
// hardware acceleration off (`off`), rasterization or compositing on the processor, or a software
// GL (Mesa's llvmpipe or softpipe, or SwiftShader). Null when Chromium does not say.
function describeRenderer(info, status, off = false) {
  if (off) return { renderer: "processor (software)", card: false };
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  const device = devices.find(entry => entry?.active) ?? devices[0];
  const name = cleanRenderer(info?.auxAttributes?.glRenderer) || cleanRenderer(device?.deviceString);
  if (softwareStatus(status) || /llvmpipe|swiftshader|softpipe/i.test(name))
    return { renderer: `processor (software${name ? `: ${name}` : ""})`.slice(0, 200), card: false };
  return name ? { renderer: name, card: true } : { renderer: null, card: null };
}

// Until Chromium's GPU process has said what it draws with (the app's "gpu-info-update"), its
// feature status says "disabled_software" whatever the computer has. Measured on 2026-10-20 with
// Electron 44: the report came 3 to 5 s after the start on WSLg with Mesa's d3d12 driver (once
// over 8 s), and 0.1 s under Xvfb. The first frame waits for it anyway. The ready line waits for
// it READY_WAIT at most; a later report goes with the next frame's answer (runRasterWorker).
const GPU_REPORT_TIMEOUT = 60_000;
const READY_WAIT = 1_000;

// The page's WebGL renderer, as chrome://gpu shows it: on WSLg getGPUInfo names no card (its GL
// renderer stays empty), while WebGL gives "ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce
// RTX 4090), OpenGL 4.6)". The context is given back at once.
const WEBGL_RENDERER = `(() => {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return null;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const name = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return typeof name === "string" ? name : null;
})()`;

// `reported`: settles at Chromium's first GPU report. `askPage`: the page's WebGL renderer.
// Without hardware acceleration Chromium gives no GPU information (getGPUInfo rejects).
async function drawingRenderer(off, { gpu = app, reported, askPage, wait = delay } = {}) {
  if (off) return describeRenderer(null, null, true);
  const readStatus = () => { try { return gpu.getGPUFeatureStatus(); } catch { return null; } };
  let status = readStatus();
  // A status without software in it came from the GPU process already.
  if (!status || softwareStatus(status)) {
    const arrived = await Promise.race([Promise.resolve(reported).then(() => true, () => false), wait(GPU_REPORT_TIMEOUT).then(() => false)]);
    if (!arrived) return { renderer: null, card: null };
    status = readStatus();
  }
  let info = null;
  try { info = await Promise.race([gpu.getGPUInfo("complete"), wait(3000).then(() => null)]); } catch { /* not known */ }
  const described = describeRenderer(info, status);
  if (described.renderer !== null || !askPage || !status || softwareStatus(status)) return described;
  let name = null;
  try { name = await Promise.race([askPage(), wait(3000).then(() => null)]); } catch { /* not known */ }
  return typeof name === "string" && name ? describeRenderer({ auxAttributes: { glRenderer: name } }, status) : described;
}

function argumentValue(name) {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  return argument ? argument.slice(argument.indexOf("=") + 1) : null;
}

// Paints one frame: the page's preload (raster-page.cjs) gets the SVG as a message and answers
// "kino:painted" with the same id once Chromium can draw it, with the renderer's private memory
// footprint in KB (what Activity Monitor shows as its Memory) so the export can watch it.
function paintFrame(webContents, frame) {
  return new Promise((resolve, reject) => {
    const painted = (_event, reply) => {
      if (reply?.id !== frame.id) return;
      webContents.ipc.off("kino:painted", painted);
      if (reply.error) reject(new Error(String(reply.error)));
      else resolve(Number.isSafeInteger(reply.rendererKB) && reply.rendererKB > 0 ? reply.rendererKB : undefined);
    };
    webContents.ipc.on("kino:painted", painted);
    webContents.send("kino:paint", frame);
  });
}

// A worker whose parent is gone has nothing left to do. Its input closing normally quits it,
// but a worker stuck in a frame (or still starting) could miss that and stay open for hours
// (seen 2026-10-26: idle workers left after the app quit). On macOS and Linux an orphan's
// parent becomes process 1, so the worker checks every few seconds and exits.
const PARENT_CHECK_MS = 5_000;
function exitWithParent(parent = process.ppid, { every = PARENT_CHECK_MS, current = () => process.ppid, exit = () => app.exit(0) } = {}) {
  if (process.platform === "win32") return null;
  const timer = setInterval(() => { if (current() !== parent || current() === 1) exit(); }, every);
  timer.unref?.();
  return timer;
}

// An uncaught error in a worker would open Electron's "A JavaScript error occurred" dialog. The
// window is hidden, nobody can close it, and its modal loop blocks every timer, exitWithParent's
// too (seen 2026-10-27: 141 workers stuck in that dialog for up to a day, 1.5 GB). Exit instead.
// Writing to a parent that is gone fails with EPIPE, the usual first error.
function exitOnUncaught({ exit = () => app.exit(1), write = (text) => process.stderr.write(text) } = {}) {
  const quit = (error) => {
    try { write(`kino export worker: ${String(error?.stack || error).slice(0, 500)}\n`); } catch { /* the parent may be gone */ }
    exit();
  };
  process.on("uncaughtException", quit);
  process.on("unhandledRejection", quit);
  return quit;
}

async function runRasterWorker() {
  exitOnUncaught();
  exitWithParent();
  // Chromium has to know the picture scheme before the app is ready (Electron allows this once).
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true } }]);
  const given = argumentValue("kino-raster-directory");
  if (!given) throw new Error("An isolated export directory is required.");
  const directory = path.resolve(given);
  // The parent created this private temporary directory. Reject a symlink before
  // putting Chromium's profile in it; no standard application profile is used.
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The export directory must be a real directory.");
  // The folder whose PNG files the page may load by kino-frame:// link (the export's own folder).
  const mediaGiven = argumentValue("kino-raster-media");
  let mediaRoot = null;
  if (mediaGiven) {
    mediaRoot = fs.realpathSync(path.resolve(mediaGiven));
    if (!fs.statSync(mediaRoot).isDirectory()) throw new Error("The export media folder must be a directory.");
  }
  const profile = path.join(directory, "profile");
  for (const child of [profile, path.join(profile, "session"), path.join(profile, "cache"), path.join(profile, "logs"), path.join(directory, "crashes")])
    fs.mkdirSync(child, { recursive: true, mode: 0o700 });
  app.setName("kino export");
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "session"));
  app.setPath("cache", path.join(profile, "cache"));
  app.setPath("crashDumps", path.join(directory, "crashes"));
  app.setAppLogsPath(path.join(profile, "logs"));
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  // Draw a frame only once every tile and image in it is rasterized, as headless Chromium does
  // for screenshots. Without these a heavy frame (hundreds of blurred copies of a 1080p picture)
  // was captured half drawn, or as the previous frame.
  app.commandLine.appendSwitch("run-all-compositor-stages-before-draw");
  app.commandLine.appendSwitch("disable-checker-imaging");
  // Lets the page collect garbage after a run of large frames (raster-page.cjs, COLLECT_AFTER).
  app.commandLine.appendSwitch("js-flags", "--expose-gc");
  // KINO_RASTER_GPU=off draws without the graphics processor, as Chromium does on a computer
  // without one (a Linux server, or Xvfb), to reproduce or avoid that case on any computer.
  // --kino-raster-gpu=off does the same for the dashboard's "processor only", and
  // --kino-raster-gpu=high-performance asks for the separate card on a computer with two (the
  // dashboard's "auto" on macOS and Windows; backend/render-devices.mjs graphicsLaunch).
  const gpu = argumentValue("kino-raster-gpu");
  const hardwareOff = process.env.KINO_RASTER_GPU === "off" || gpu === "off";
  if (hardwareOff) app.disableHardwareAcceleration();
  else if (gpu === "high-performance") app.commandLine.appendSwitch("force_high_performance_gpu");
  // Without a GPU (Linux under Xvfb, as on CI) Chromium rasterizes on the CPU: in tiles of
  // 256×256 pixels, on one thread per two cores. Two kinds of effect pull the tile size apart.
  // Each tile works out an effect's filters again for the part of the picture it needs; for light
  // rays (copies shifted far across the frame) that is most of the picture, so bigger tiles are
  // faster. A spin transition (512 copies in nested see-through groups) got slower the bigger the
  // tiles, even past the size of the frame (probably each group is drawn as big as its tile).
  // Tiles of 384×384, on one raster thread per core (Chromium allows at most 4), suit both.
  // Measured on 2026-10-20 (Electron 44, Linux under Xvfb), seconds per frame with Chromium's
  // defaults / these settings / 2048×2048 tiles:
  //                                          1920×1080 light rays   480×270 look at a spin
  //   Docker, 4 cores of an Apple M3 Pro       5.8 / 2.1 / 1.7        2.3 / 1.9 / 5.5
  //   i9-13900K, 2 cores (4 threads)           2.7 / 1.3 / 1.0        1.8 / 1.9 / 6.6
  //   i9-13900K, 2 efficiency cores            5.7 / 1.9 / 1.7        3.2 / 2.2 / 8.4
  // On CI 2048×2048 tiles took the spin look past the 45 s limit. In Docker the pictures differ
  // from the defaults' in 12 pixels by at most 12/255 (rays) and in 301 pixels by 1/255 (spin).
  // With the GPU on a Mac these switches change neither the time nor a pixel.
  app.commandLine.appendSwitch("default-tile-width", "384");
  app.commandLine.appendSwitch("default-tile-height", "384");
  app.commandLine.appendSwitch("num-raster-threads", String(Math.min(4, os.availableParallelism())));
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  // Listening from the start, so that the GPU process's first report cannot come unheard.
  const gpuReported = new Promise(resolve => app.once("gpu-info-update", resolve));
  await app.whenReady();
  const isolatedSession = session.fromPartition("kino-export");
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.protocol.handle(MEDIA_SCHEME, request => mediaResponse(request, mediaRoot));
  isolatedSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith("data:") && !(mediaRoot && details.url.startsWith(`${MEDIA_SCHEME}://media/`)) }));
  const window = new BrowserWindow({
    width: 1, height: 1, useContentSize: true, show: false, frame: false,
    enableLargerThanScreen: true, focusable: false, hiddenInMissionControl: true,
    transparent: true, backgroundColor: "#00000000", resizable: false,
    webPreferences: { session: isolatedSession, contextIsolation: true, nodeIntegration: false,
      sandbox: true, offscreen: true, backgroundThrottling: false, webSecurity: true,
      preload: path.join(__dirname, "raster-page.cjs") },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  // The reason (for example "crashed", "oom" or "killed") reaches the export's error through
  // stderr (backend/chromium-raster.mjs adds the worker's stderr to it).
  // A write to a pipe may still be on its way when the app exits, so it exits once the line is
  // written (or after a second).
  window.webContents.on("render-process-gone", (_event, details) => {
    const exit = () => app.exit(1);
    process.stderr.write(`page renderer gone: ${details?.reason} (exit code ${details?.exitCode})\n`, exit);
    setTimeout(exit, 1000);
  });
  window.webContents.setZoomFactor(1);
  // The page waits two animation frames before each capture (raster-page.cjs), and the capture
  // waits for the next drawn frame: at 240 frames a second instead of 60 that wait is about 8 ms
  // instead of 33 ms. Measured 2026-10-28 on a product trailer's 234 check frames at 64 px: 24.0 s
  // before, 19.1 s after, the same pixels.
  window.webContents.setFrameRate(240);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixedHtml())}`);
  const bgra = bitmapIsBgra();
  // The protocol version: backend/chromium-raster.mjs (PROTOCOL_VERSION) refuses any other.
  // `renderer` says what draws the frames, so the export can tell when the card was not used.
  // When the GPU process reports after the ready line, the next frame's answer says it instead.
  let drawing = null, drawingSent = false, answered = false;
  const drawingKnown = drawingRenderer(hardwareOff, { reported: gpuReported, askPage: () => window.webContents.executeJavaScript(WEBGL_RENDERER) })
    .then(value => { drawing = value; }, () => {});
  const unsentDrawing = () => {
    if (drawingSent || !drawing?.renderer) return {};
    drawingSent = true;
    return { renderer: drawing.renderer, card: drawing.card };
  };
  await Promise.race([drawingKnown, delay(READY_WAIT)]);
  await writeResponse({ type: "ready", version: 3, electron: process.versions.electron, chromium: process.versions.chrome, renderer: null, card: null, ...unsentDrawing() });
  // The first frame is drawn once the GPU process is up, so its report has come by then; the
  // WebGL question after it may still be on its way.
  const firstAnswer = async () => {
    if (answered) return;
    answered = true;
    if (!drawing) await Promise.race([drawingKnown, delay(READY_WAIT)]);
  };

  let buffered = "", handling = false, ended = false;
  const failProtocol = () => {
    process.stderr.write("kino export worker received an invalid request.\n");
    app.exit(1);
  };
  async function handle(line) {
    if (handling) return failProtocol();
    handling = true;
    let request, watchdog;
    try {
      request = JSON.parse(line);
      // `pixels: true` asks for the raw RGBA pixels (for FFmpeg and pixel checks), otherwise a PNG file.
      // `timeoutMs`: the frame's time limit in server/chromium-raster.mjs.
      // `draft: true` (check and look frames) lets the page draw tilted layers' bitmaps smaller.
      const { id, svg, width, height, pixels = false, draft = false, timeoutMs = FRAME_TIMEOUT } = request;
      if (!Number.isSafeInteger(id) || id < 1 || typeof svg !== "string" || Buffer.byteLength(svg) > 64 * 1024 * 1024 ||
          !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
          width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS || typeof pixels !== "boolean" || typeof draft !== "boolean" ||
          !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FRAME_TIMEOUT) return failProtocol();
      // A backstop for a parent that stopped listening: backend/chromium-raster.mjs stops a frame at
      // its time limit itself and names it, so this waits 5 s longer.
      watchdog = setTimeout(() => app.exit(124), timeoutMs + 5_000);
      window.setContentSize(width, height + 1);
      const marker = frameMarker(id);
      // The SVG goes to the page as a message, not inside JavaScript source: executeJavaScript kept
      // every script it ran, so the renderer grew by 2-4 MB for each MB of SVG (about 70 MB a frame
      // on the busiest part of a 1080x1920 final render of a project full of video) until the Mac
      // ran out of memory.
      const rendererKB = await paintFrame(window.webContents, { id, svg, marker, draft });
      const image = await captureFrame(window.webContents, { width, height, marker, timeout: captureTimeout(timeoutMs) });
      await firstAnswer();
      if (pixels) {
        const rgba = rgbaPixels(image, bgra);
        handling = false;
        await writePixels(id, width, height, rgba, { rendererKB, ...unsentDrawing() });
      } else {
        const png = image.toPNG().toString("base64");
        handling = false;
        await writeResponse({ id, width, height, png, rendererKB, ...unsentDrawing() });
      }
    } catch (error) {
      handling = false;
      await writeResponse({ id: request?.id, error: String(error?.message || "Chromium export failed.").slice(0, 500) });
    } finally {
      clearTimeout(watchdog);
      if (ended) app.quit();
    }
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffered += chunk;
    if (buffered.length > MAX_INPUT) return failProtocol();
    let end;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line || handling) return failProtocol();
      void handle(line).catch(() => app.exit(1));
    }
  });
  // Input closed: quit after the frame in hand, or in any case within a few seconds.
  const inputClosed = () => {
    if (ended) return;
    ended = true;
    if (!handling) app.quit();
    setTimeout(() => app.exit(0), 3_000).unref?.();
  };
  process.stdin.on("end", inputClosed);
  process.stdin.on("close", inputClosed);
  process.stdin.on("error", () => app.exit(1));
}

module.exports = { runRasterWorker, exitWithParent, exitOnUncaught, capturePage, captureFrame, frameMarker, rgbaPixels, cleanRenderer, describeRenderer, drawingRenderer };
// Electron loads its application entry through its own bootstrap module, so
// require.main does not identify this file there. Packaged main imports it and
// calls runRasterWorker explicitly; only the development entry auto-starts.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) runRasterWorker().catch(error => {
  process.stderr.write(`kino export worker: ${String(error?.message || error).slice(0, 500)}\n`);
  app.exit(1);
});
