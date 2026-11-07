import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { presetAnimation } from "../engine/animation.js";
import { createComponentInstance, expandComponents } from "../engine/linkedComponents.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { createEffectAnimation } from "../engine/effects/animation.js";
import { EFFECTS, effectDefaults } from "../engine/effects/catalog.js";
import { EFFECT_PRESET_DEFINITIONS } from "../engine/effects/presetCatalog.js";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { sceneNeedsChromium } from "../backend/raster-policy.mjs";
import { renderSceneSvg } from "../engine/render.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = path.join(root, ".scratch");
const electronEntry = path.join(root, "scripts", "effects-parity-electron.cjs");
const nativeRendererEntry = path.join(root, "scripts", "effects-parity-native.mjs");
const productionRendererEntry = path.join(root, "scripts", "effects-parity-production.mjs");
const require = createRequire(import.meta.url);
const SAMPLE_TIMES = Object.freeze([0, 0.5, 1.25]);
const CANVAS = Object.freeze({ width: 128, height: 96 });
const BACKDROP_KEYS = Object.freeze(["background-blur", "glass"]);
const PIXEL_TOLERANCE = 12;
const NATIVE_CASE_TIMEOUT_MS = 45_000;
const PRODUCTION_CASE_TIMEOUT_MS = 45_000;
const THRESHOLD = Object.freeze({
  meanPremultipliedRgbaDifference: 0.012,
  differingPixelRatio: 0.03,
  differingChannelTolerance8Bit: PIXEL_TOLERANCE,
  requireDeterministicRerender: true,
  rationale: "A 12/255 channel allowance filters small subpixel antialiasing changes. The normalized mean limit is 1.2% of full premultiplied RGBA range, and no more than 3% of pixels may exceed the channel allowance; this permits localized edge noise while failing broad displacement or color changes.",
});
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  let output = null;
  let axisAligned = false;
  let scale = 1;
  let effectKeys = null;
  let presetIds = null;
  let backdropKeys = null;
  let stacks = false;
  let production = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      output = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--scale") {
      scale = Number(argv[index + 1]);
      index += 1;
    } else if (["--effects", "--presets", "--backdrops"].includes(argv[index])) {
      const flag = argv[index];
      const value = argv[index + 1];
      index += 1;
      const allowed = flag === "--effects" ? EFFECTS.map(({ key }) => key)
        : flag === "--presets" ? Object.keys(EFFECT_PRESET_DEFINITIONS) : BACKDROP_KEYS;
      if (typeof value !== "string" || !value.trim())
        throw new Error(`${flag} requires a comma-separated list.`);
      const requested = value.split(",").map(key => key.trim());
      if (requested.some(key => !key)) throw new Error(`${flag} cannot contain empty keys.`);
      const unknown = requested.filter(key => !allowed.includes(key));
      if (unknown.length) throw new Error(`Unknown ${flag.slice(2)} key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
      if (new Set(requested).size !== requested.length) throw new Error(`${flag} cannot contain duplicate keys.`);
      const selected = new Set(requested);
      const values = allowed.filter(key => selected.has(key));
      if (flag === "--effects") effectKeys = values;
      else if (flag === "--presets") presetIds = values;
      else backdropKeys = values;
    } else if (argv[index] === "--stacks") {
      stacks = true;
    } else if (argv[index] === "--axis-aligned") {
      axisAligned = true;
    } else if (argv[index] === "--production") {
      production = true;
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      return { help: true, output, axisAligned, scale, effectKeys, presetIds, backdropKeys, stacks, production };
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!output) throw new Error("Usage: node scripts/effects-parity.mjs --output .scratch/<new-directory> [--production] [--scale 1..4] [--axis-aligned] [--effects key1,key2] [--presets id1,id2] [--backdrops background-blur,glass] [--stacks]");
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw new Error("--scale must be an integer from 1 through 4.");
  return { help: false, output, axisAligned, scale, effectKeys, presetIds, backdropKeys, stacks, production };
}

async function ensureScratchOutput(requestedPath) {
  const target = path.resolve(root, requestedPath);
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const scratchInfo = await lstat(scratchRoot);
  if (scratchInfo.isSymbolicLink() || !scratchInfo.isDirectory())
    throw new Error("The project .scratch path must be a real directory.");
  const relative = path.relative(scratchRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("The output directory must be a new child of the project .scratch directory.");

  let current = scratchRoot;
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") throw new Error("Invalid output directory path.");
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Output path components must be real directories.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  if ((await readdir(target)).length) throw new Error("The output directory must be empty; choose a new scratch directory.");
  return target;
}

function createImageFixture() {
  const canvas = createCanvas(32, 24);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 32, 24);
  context.fillStyle = "#f4f0e8";
  context.fillRect(2, 2, 24, 19);
  context.fillStyle = "#ed365a";
  context.fillRect(4, 4, 3, 16);
  context.fillRect(12, 4, 7, 7);
  context.fillStyle = "#2054bf";
  context.fillRect(20, 6, 4, 14);
  context.fillStyle = "#ffd447";
  context.beginPath();
  context.arc(10, 16, 4, 0, Math.PI * 2);
  context.fill();
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

function shapeSample(axisAligned = false) {
  const group = createLayer("group", {
    id: "sample-shape", name: "Asymmetric stripe group", x: 18, y: 15,
    width: 92, height: 64, rotation: axisAligned ? 0 : 7, scaleX: axisAligned ? 1 : 1.08, scaleY: axisAligned ? 1 : 0.9,
  });
  const stripe = (id, x, y, width, height, fill, type = "rectangle") => createLayer(type, {
    id, name: id, parentId: group.id, x, y, width, height, fill,
  });
  const children = [
    stripe("stripe-red", 3, 4, 9, 55, "#e4365a"),
    stripe("stripe-yellow", 15, 10, 5, 42, "#ffd447"),
    stripe("stripe-blue", 23, 2, 18, 59, "#2054bf"),
    stripe("stripe-cream", 45, 13, 7, 46, "#f4f0e8"),
    stripe("stripe-green", 57, 6, 13, 51, "#2a956d"),
    stripe("stripe-orange", 75, 19, 5, 35, "#fa8b2d"),
    stripe("dot-violet", 81, 8, 8, 8, "#7b48bd", "ellipse"),
    stripe("cutout-white", 70, 40, 14, 4, "#ffffff"),
  ];
  return { name: "shape", layer: group, children };
}

function textSample(axisAligned = false) {
  return {
    name: "text",
    layer: createLayer("text", {
      id: "sample-text", name: "Bundled font text", text: "WARP / 42",
      x: 14, y: 17, width: 100, height: 62, rotation: axisAligned ? 0 : -5, scaleX: axisAligned ? 1 : 1.06, scaleY: axisAligned ? 1 : 0.88,
      fontFamily: "Inter", fontWeight: 700, fontSize: 23, textAlign: "left",
      fill: "#25236d", stroke: "#ed365a", strokeWidth: 0.7,
    }),
    children: [],
  };
}

function imageSample(src, axisAligned = false) {
  return {
    name: "image",
    layer: createLayer("image", {
      id: "sample-image", name: "Generated stripe image", src,
      x: 27, y: 18, width: 73, height: 58, rotation: axisAligned ? 0 : 6, scaleX: axisAligned ? 1 : 1.08, scaleY: axisAligned ? 1 : 0.86,
      stroke: "#1e2c63", strokeWidth: 1.2,
    }),
    children: [],
  };
}

function makeScene(scenario, sample, fonts, { belowLayers = [], layerOverrides = {}, animationFactory = null, nested = false } = {}) {
  const layerId = sample.layer.id;
  const parent = nested ? createLayer("group", { id: `outer-${scenario.key}-${sample.name}`, name: "Outer sample group",
    x: 0, y: 0, width: CANVAS.width, height: CANVAS.height }) : null;
  const layer = createLayer(sample.layer.type, { ...sample.layer, ...layerOverrides, ...(parent ? { parentId: parent.id } : {}) });
  const scene = createScene({
    id: `scene-${scenario.key}-${sample.name}`,
    name: `${scenario.label} ${sample.name}`,
    width: CANVAS.width,
    height: CANVAS.height,
    duration: 4,
    background: "#00000000",
    layers: [...belowLayers, ...(parent ? [parent] : []), layer, ...sample.children],
  });
  const animations = animationFactory?.(layer, scene) ?? [];
  const animatedScene = { ...scene, layers: scene.layers.map((entry) => entry.id === layerId
    ? { ...entry, ...(animations.length ? { animations } : {}) } : entry) };
  const document = parseDocument(createDocument({
    id: `parity-${scenario.key}-${sample.name}`,
    name: `Parity ${scenario.label} ${sample.name}`,
    scenes: [animatedScene],
  }));
  const result = document.scenes[0];
  // Force a real bundled-font resolution up front; text rendering then emits outlines,
  // so Electron does not depend on the host's installed font list.
  if (sample.name === "text") fonts.resolve(result.layers.find(({ id }) => id === layerId));
  return result;
}

function effectAnimationFactory(keys, scenarioKey) {
  return (layer, scene) => keys.map((key, index) => createEffectAnimation(
    key, layer, 0, scene, `effect-${scenarioKey}-${index}`, effectDefaults(key),
  ));
}

function presetAnimationFactory(presetId, mode) {
  return (layer, scene) => [{ ...presetAnimation(`preset-${presetId}`, layer, 0, scene, { mode }),
    id: `preset-${presetId}-${mode}`, start: 0, duration: 1 }];
}

function backdropPaintLayers(caseKey, sampleName) {
  const prefix = `backdrop-${caseKey}-${sampleName}`;
  const layers = [
    createLayer("rectangle", { id: `${prefix}-base`, name: "Backdrop navy base", x: 0, y: 0, width: CANVAS.width, height: CANVAS.height, fill: "#10213B" }),
    createLayer("rectangle", { id: `${prefix}-red`, x: 0, y: 0, width: 18, height: CANVAS.height, fill: "#F04463" }),
    createLayer("rectangle", { id: `${prefix}-gold`, x: 31, y: 0, width: 13, height: CANVAS.height, fill: "#FFD447" }),
    createLayer("rectangle", { id: `${prefix}-blue`, x: 55, y: 0, width: 20, height: CANVAS.height, fill: "#285DC7" }),
    createLayer("rectangle", { id: `${prefix}-mint`, x: 85, y: 0, width: 14, height: CANVAS.height, fill: "#2A956D" }),
    createLayer("ellipse", { id: `${prefix}-violet`, x: 105, y: 8, width: 16, height: 16, fill: "#A64CC8" }),
  ];
  const moving = createLayer("rectangle", { id: `${prefix}-moving`, name: "Animated lower stripe", x: 10, y: 69, width: 29, height: 13, fill: "#FFFFFF" });
  const move = presetAnimation("move", moving, 0);
  layers.push({ ...moving, animations: [{ ...move, id: `${prefix}-move`, start: 0, duration: 1, easing: "linear",
    from: { x: 10, y: 69 }, to: { x: 73, y: 69 } }] });
  return layers;
}

function makeComponentOverrideScene(scenario, sample, fonts) {
  const sourceScene = createScene({
    id: `component-source-${sample.name}`,
    name: "Effect component source",
    width: CANVAS.width,
    height: CANVAS.height,
    duration: 4,
    isComponent: true,
    background: "#00000000",
    layers: [sample.layer, ...sample.children],
  });
  const animations = effectAnimationFactory(["bulge"], scenario.key)(sample.layer, sourceScene);
  sourceScene.layers = sourceScene.layers.map((layer) => layer.id === sample.layer.id ? { ...layer, animations } : layer);
  const instance = createComponentInstance(sourceScene, { id: "component-instance", x: 0, y: 0,
    componentOverrides: { "stripe-blue": { fill: "#00D7E8" } } });
  const hostScene = createScene({ id: `component-host-${sample.name}`, name: "Expanded component override", width: CANVAS.width,
    height: CANVAS.height, duration: 4, background: "#00000000", layers: [instance] });
  const document = parseDocument(createDocument({ id: `parity-${scenario.key}-${sample.name}`, name: scenario.label,
    scenes: [sourceScene, hostScene] }));
  if (sample.name === "text") fonts.resolve(sample.layer);
  return expandComponents(document, hostScene.id, { fonts });
}

async function rgbaImage(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, pixels: new Uint8ClampedArray(pixels) };
}

function premultiplied(rgba) {
  const output = new Float32Array(rgba.pixels.length);
  for (let offset = 0; offset < rgba.pixels.length; offset += 4) {
    const alpha = rgba.pixels[offset + 3] / 255;
    output[offset] = rgba.pixels[offset] * alpha;
    output[offset + 1] = rgba.pixels[offset + 1] * alpha;
    output[offset + 2] = rgba.pixels[offset + 2] * alpha;
    output[offset + 3] = rgba.pixels[offset + 3];
  }
  return output;
}

function comparePixels(left, right) {
  assert.equal(left.width, right.width, "raster widths match");
  assert.equal(left.height, right.height, "raster heights match");
  const a = premultiplied(left);
  const b = premultiplied(right);
  let absoluteSum = 0;
  let maxChannel = 0;
  let differentPixels = 0;
  const diffPixels = new Uint8ClampedArray(left.pixels.length);
  for (let offset = 0; offset < a.length; offset += 4) {
    let pixelMax = 0;
    const differences = [];
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(a[offset + channel] - b[offset + channel]);
      absoluteSum += difference;
      pixelMax = Math.max(pixelMax, difference);
      maxChannel = Math.max(maxChannel, difference);
      differences.push(difference);
    }
    if (pixelMax > PIXEL_TOLERANCE) differentPixels += 1;
    diffPixels[offset] = Math.min(255, Math.round(differences[0] * 3 + differences[3]));
    diffPixels[offset + 1] = Math.min(255, Math.round(differences[1] * 3));
    diffPixels[offset + 2] = Math.min(255, Math.round(differences[2] * 3));
    diffPixels[offset + 3] = 255;
  }
  const pixelCount = left.width * left.height;
  return {
    width: left.width,
    height: left.height,
    meanPremultipliedRgbaDifference: absoluteSum / (a.length * 255),
    meanPremultipliedRgbaDifference8Bit: absoluteSum / a.length,
    differingPixelRatio: differentPixels / pixelCount,
    differingPixels: differentPixels,
    totalPixels: pixelCount,
    maxPremultipliedChannelDifference8Bit: maxChannel,
    diffPixels,
  };
}

function pngFromPixels(width, height, pixels) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  return canvas.toBuffer("image/png");
}

function samePixels(left, right) {
  return left.width === right.width && left.height === right.height && Buffer.from(left.pixels).equals(Buffer.from(right.pixels));
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
}

function electronEnvironment() {
  const environment = {};
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "USER", "LOGNAME", "HOME"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  return environment;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2_000))]);
  }
}

async function runElectron(runDirectory, profileDirectory, timeoutMs = 120_000) {
  const electronBinary = require("electron");
  if (typeof electronBinary !== "string") throw new Error("The installed Electron binary path is unavailable.");
  const crashDirectory = path.join(runDirectory, "electron-crashes");
  const child = spawn(electronBinary, [
    `--user-data-dir=${profileDirectory}`,
    `--crash-dumps-dir=${crashDirectory}`,
    electronEntry,
    runDirectory,
  ], {
    cwd: root,
    env: electronEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  let timeout;
  let onSignal;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (onSignal) {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
        if (error) reject(error);
        else resolve();
      };
      timeout = setTimeout(async () => {
        await terminateChild(child);
        finish(new Error(`Electron parity capture exceeded ${timeoutMs} ms.`));
      }, timeoutMs);
      onSignal = async () => {
        await terminateChild(child);
        finish(new Error("Electron parity capture was cancelled."));
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      child.once("error", error => finish(new Error(`Could not launch the installed Electron binary: ${error.message}`)));
      child.once("exit", (code, signal) => {
        if (code === 0) finish(null);
        else finish(new Error(`Electron offscreen capture exited (${code ?? signal}). ${stderr.trim().slice(-1_200)}`));
      });
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function runNativeResvgCase(runDirectory, id, svg, width, height, scale) {
  const inputDirectory = path.join(runDirectory, "native-input");
  const outputDirectory = path.join(runDirectory, "resvg");
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const inputPath = path.join(inputDirectory, `${id}.svg`);
  const firstPath = path.join(outputDirectory, `${id}.png`);
  const repeatPath = path.join(outputDirectory, `${id}.repeat.png`);
  await writeFile(inputPath, svg, { mode: 0o600, flag: "wx" });
  const child = spawn(process.execPath, [nativeRendererEntry, inputPath, firstPath, repeatPath,
    String(width), String(height), String(scale)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelledBy = null;
  let timeout;
  const worker = await new Promise((resolve) => {
    let settled = false;
    let onInt = null;
    let onTerm = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (onInt) process.off("SIGINT", onInt);
      if (onTerm) process.off("SIGTERM", onTerm);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    const onSignal = async (signal) => {
      cancelledBy = signal;
      await terminateChild(child);
      finish({ code: child.exitCode, signal: child.signalCode, cancelledBy });
    };
    onInt = () => { void onSignal("SIGINT"); };
    onTerm = () => { void onSignal("SIGTERM"); };
    timeout = setTimeout(async () => {
      timedOut = true;
      await terminateChild(child);
      finish({ code: child.exitCode, signal: child.signalCode, cancelledBy });
    }, NATIVE_CASE_TIMEOUT_MS);
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.once("error", (error) => finish({ code: null, signal: null, spawnError: error.message, cancelledBy }));
    child.once("close", (code, signal) => finish({ code, signal, cancelledBy }));
  });
  let result = null;
  try { result = JSON.parse(stdout.trim()); } catch {}
  if (worker.cancelledBy)
    return { ok: false, cancelledBy: worker.cancelledBy, exitCode: worker.code, signal: worker.signal,
      error: `Native renderer capture was cancelled by ${worker.cancelledBy}.` };
  if (!timedOut && worker.code === 0 && result?.status === "ok")
    return { ok: true, firstPath, repeatPath, result };
  const nativeSignal = worker.signal ?? null;
  const status = timedOut ? "timeout" : nativeSignal ? "signal" : worker.spawnError ? "spawn-error"
    : worker.code !== 0 ? "exit" : "worker-error";
  return {
    ok: false,
    status,
    exitCode: worker.code,
    signal: nativeSignal,
    timedOut,
    error: worker.spawnError || result?.error || (timedOut ? `Native renderer exceeded ${NATIVE_CASE_TIMEOUT_MS} ms.`
      : `Native renderer worker exited (${worker.code ?? nativeSignal ?? "unknown"}).`),
    stderr: stderr.trim().slice(-1_200),
  };
}

function productionEnvironment(runDirectory) {
  const environment = {};
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME", "HOME"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  // exportScene uses os.tmpdir() for its transient media and worker directories.
  // Keep those under this harness run without replacing the caller's real HOME.
  environment.TMPDIR = runDirectory;
  environment.TEMP = runDirectory;
  environment.TMP = runDirectory;
  return environment;
}

function sendProductionSignal(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopProductionProcessTree(child) {
  try { sendProductionSignal(child, "SIGTERM"); } catch {}
  await Promise.race([child.closePromise, new Promise(resolve => setTimeout(resolve, 1_000))]);
  // A Chromium descendant can outlive the Node export process; send KILL to the
  // private process group after the grace period even if its leader already closed.
  try { sendProductionSignal(child, "SIGKILL"); } catch {}
  await Promise.race([child.closePromise, new Promise(resolve => setTimeout(resolve, 1_000))]);
}

async function runProductionCase(runDirectory, id, scene, time, width, height) {
  const inputDirectory = path.join(runDirectory, "production-input");
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  const inputPath = path.join(inputDirectory, `${id}.json`);
  const input = { version: 1, id, scene, time, width, height };
  await writeFile(inputPath, `${JSON.stringify(input)}\n`, { mode: 0o600, flag: "wx" });
  const child = spawn(process.execPath, [productionRendererEntry, runDirectory, id], {
    cwd: root,
    env: productionEnvironment(runDirectory),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.closePromise = new Promise(resolve => child.once("close", (code, signal) => {
    resolve({ code, signal });
  }));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-32_000); });
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  let timeout;
  let onInt;
  let onTerm;
  const outcome = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    timeout = setTimeout(() => finish({ timedOut: true }), PRODUCTION_CASE_TIMEOUT_MS);
    onInt = () => finish({ cancelledBy: "SIGINT" });
    onTerm = () => finish({ cancelledBy: "SIGTERM" });
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.once("error", error => finish({ spawnError: error.message }));
    child.closePromise.then(result => finish(result));
  });
  clearTimeout(timeout);
  if (onInt) process.off("SIGINT", onInt);
  if (onTerm) process.off("SIGTERM", onTerm);
  if (outcome.timedOut || outcome.cancelledBy) {
    await stopProductionProcessTree(child);
    return { ok: false, status: outcome.timedOut ? "timeout" : "cancelled",
      timedOut: Boolean(outcome.timedOut), cancelledBy: outcome.cancelledBy ?? null,
      error: outcome.timedOut ? `Production export exceeded ${PRODUCTION_CASE_TIMEOUT_MS} ms.`
        : `Production export was cancelled by ${outcome.cancelledBy}.`, stderr: stderr.trim().slice(-2_000) };
  }
  if (outcome.spawnError || outcome.code !== 0) {
    return { ok: false, status: outcome.spawnError ? "spawn-error" : outcome.signal ? "signal" : "exit",
      exitCode: outcome.code ?? null, signal: outcome.signal ?? null,
      error: outcome.spawnError || `Production renderer exited (${outcome.code ?? outcome.signal ?? "unknown"}).`,
      stderr: stderr.trim().slice(-2_000) };
  }
  const marker = stdout.split(/\r?\n/).find(line => line.startsWith("@@PRODUCTION_CASE@@"));
  let result = null;
  try { result = marker ? JSON.parse(marker.slice("@@PRODUCTION_CASE@@".length)) : null; } catch {}
  if (!result || result.status !== "ok" || result.id !== id || !["chromium", "resvg"].includes(result.backend)) {
    return { ok: false, status: "worker-error", error: "Production renderer returned no valid result.",
      stderr: stderr.trim().slice(-2_000) };
  }
  const outputDirectory = path.join(runDirectory, "production");
  const firstPath = path.resolve(result.first?.filename || "");
  const repeatPath = path.resolve(result.repeat?.filename || "");
  if (path.dirname(firstPath) !== outputDirectory || path.dirname(repeatPath) !== outputDirectory ||
      !path.basename(firstPath).startsWith(`${id}`) || !path.basename(repeatPath).startsWith(`${id}.repeat`)) {
    return { ok: false, status: "worker-error", error: "Production renderer returned a path outside its private output directory.",
      stderr: stderr.trim().slice(-2_000) };
  }
  return { ok: true, result, firstPath, repeatPath };
}

async function productionSourceProvenance() {
  const effectDirectory = path.join(root, "engine", "effects");
  const effects = (await readdir(effectDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js"))
    .map(entry => `engine/effects/${entry.name}`);
  const files = [
    "desktop/raster-page.cjs",
    "desktop/raster-worker.cjs",
    "package.json",
    "scripts/effects-parity.mjs",
    "scripts/effects-parity-electron.cjs",
    "scripts/effects-parity-production.mjs",
    "backend/chromium-raster.mjs",
    "backend/export.mjs",
    "backend/fonts.mjs",
    "backend/raster-policy.mjs",
    "engine/animation.js",
    "engine/animationEnabled.js",
    "engine/animationTree.js",
    "engine/backdropStyles.js",
    "engine/fonts.js",
    "engine/geometry.js",
    "engine/model.js",
    "engine/render.js",
    "engine/textLayout.js",
    ...effects,
  ].sort();
  const hashes = {};
  for (const relative of files) {
    const bytes = await readFile(path.join(root, relative));
    hashes[relative] = createHash("sha256").update(bytes).digest("hex");
  }
  let commit = null;
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch {}
  return { commit, sourceHashesSha256: hashes };
}

function productionBrowserSvg(scene, time, fonts, scale, id, width, height) {
  return renderSceneSvg(scene, time, {
    design: false,
    fonts,
    raster: false,
    rasterScale: { x: scale, y: scale },
    idPrefix: id,
  }).replace(/^(<svg[^>]*?) width="[^"]+" height="[^"]+"/, `$1 width="${width}" height="${height}" preserveAspectRatio="none"`);
}

async function writeFailureArtifacts(output, record, browserPng, rasterPng, diffPixels, width, height, rasterLabel = "resvg") {
  const directory = path.join(output, "failures", safeName(record.effectKey));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prefix = `${safeName(record.sample)}-${String(record.time).replace(".", "p")}`;
  const paths = {
    browser: path.join(directory, `${prefix}.electron.png`),
    [rasterLabel]: path.join(directory, `${prefix}.${rasterLabel}.png`),
    diff: path.join(directory, `${prefix}.diff.png`),
  };
  await Promise.all([
    writeFile(paths.browser, browserPng, { mode: 0o600, flag: "wx" }),
    writeFile(paths[rasterLabel], rasterPng, { mode: 0o600, flag: "wx" }),
    writeFile(paths.diff, pngFromPixels(width, height, diffPixels), { mode: 0o600, flag: "wx" }),
  ]);
  return Object.fromEntries(Object.entries(paths).map(([key, filename]) => [key, path.relative(output, filename)]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: node scripts/effects-parity.mjs --output .scratch/<new-directory> [--production] [--axis-aligned] [--scale 1..4] [--effects key1,key2] [--presets id1,id2] [--backdrops background-blur,glass] [--stacks]\n" +
      "With no selection flags, runs the effect and effect-preset registries, both backdrops, and representative stacks. Selection flags combine; --effects alone retains effects-only selection plus baselines.\n" +
      "--production compares actual exportScene() PNGs (backend recorded per case) against a separately captured Electron SVG reference. Without it, the native diagnostic uses @resvg/resvg-js directly.\n" +
      `Effect keys: ${EFFECTS.map(({ key }) => key).join(", ")}\n` +
      `Preset IDs: ${Object.keys(EFFECT_PRESET_DEFINITIONS).join(", ")}\n` +
      `Backdrops: ${BACKDROP_KEYS.join(", ")}\n`);
    return;
  }
  const selectionSpecified = args.effectKeys !== null || args.presetIds !== null || args.backdropKeys !== null || args.stacks;
  // The Color and Light groups (curves, lut, glow, lens-flare, …) are left out by default:
  // they are compared only when named with --effects.
  const selectedEffects = selectionSpecified
    ? EFFECTS.filter(({ key }) => (args.effectKeys ?? []).includes(key)) : EFFECTS.filter(({ group }) => group !== "Color" && group !== "Light");
  const selectedPresetIds = selectionSpecified
    ? (args.presetIds ?? []) : Object.keys(EFFECT_PRESET_DEFINITIONS);
  const selectedBackdrops = selectionSpecified
    ? (args.backdropKeys ?? []) : [...BACKDROP_KEYS];
  const includeStacks = selectionSpecified ? args.stacks : true;
  const output = await ensureScratchOutput(args.output);
  const pixelCanvas = { width: CANVAS.width * args.scale, height: CANVAS.height * args.scale };
  const runDirectory = await mkdtemp(path.join(output, ".effects-parity-run-"));
  const profileDirectory = path.join(runDirectory, "electron-profile");
  await mkdir(profileDirectory, { mode: 0o700 });
  const started = performance.now();
  const provenance = args.production ? await productionSourceProvenance() : null;
  const report = {
    schemaVersion: args.production ? 3 : 2,
    generatedAt: nowIso(),
    mode: args.production ? "production-exportScene" : "raw-resvg-diagnostic",
    source: args.production
      ? "Actual exportScene() PNG compared with an independently rendered renderSceneSvg SVG in isolated Electron Chromium."
      : "renderSceneSvg SVG rendered by isolated Electron Chromium and installed @resvg/resvg-js",
    ...(provenance ? { provenance } : {}),
    threshold: THRESHOLD,
    samples: { names: ["shape", "text", "image"], sceneTimesSeconds: SAMPLE_TIMES, logicalCanvas: CANVAS, pixelCanvas, scale: args.scale,
      transformMode: args.axisAligned ? "axis-aligned" : "rotated and nonuniformly scaled",
      rootTransform: args.axisAligned ? { rotation: 0, scaleX: 1, scaleY: 1 } : { rotation: "mild nonzero rotation", scale: "nonuniform" },
      selectedEffects: selectedEffects.map(({ key }) => key), selectedPresets: selectedPresetIds,
      presetModes: ["in", "out"], selectedBackdrops, stacks: includeStacks },
    renderers: {
      browser: "installed Electron Chromium offscreen BrowserWindow; device scale factor 1",
      raster: args.production
        ? "Actual backend/export.mjs exportScene() PNG; per-case backend is recorded and selected by sceneNeedsChromium()."
        : "installed @resvg/resvg-js",
      ...(args.production ? { productionBackendPolicy: "sceneNeedsChromium(scene); Chromium for enabled filter/backdrop scenes and Resvg otherwise" } : {}),
      versions: {
        electron: require("electron/package.json").version,
        chromium: null,
        resvg: require("@resvg/resvg-js/package.json").version,
      },
    },
    summary: null,
    cases: [],
  };

  try {
    const fonts = await loadBundledFonts();
    const imageData = createImageFixture();
    const sampleFactories = [
      () => shapeSample(args.axisAligned),
      () => textSample(args.axisAligned),
      () => imageSample(imageData, args.axisAligned),
    ];
    const entries = [];
    const nativeFailures = [];
    const manifestCases = [];
    const rasterStarted = performance.now();
    const scenarios = [{ key: "baseline", label: "Unaffected baseline", effectKind: "baseline", category: "baseline",
      sampleFactories, times: [0], makeScene: (sample) => makeScene({ key: "baseline", label: "Unaffected baseline" }, sample, fonts) }];

    // Iterate each live registry; effect and preset IDs are not copied into fixed lists.
    for (const effect of selectedEffects) {
      const scenario = { key: effect.key, label: effect.label, effectKind: effect.kind, category: "effect", sampleFactories,
        times: SAMPLE_TIMES, configuration: { parameters: effectDefaults(effect.key) } };
      scenario.makeScene = (sample) => makeScene(scenario, sample, fonts,
        { animationFactory: effectAnimationFactory([effect.key], effect.key) });
      scenarios.push(scenario);
    }
    for (const presetId of selectedPresetIds) for (const mode of ["in", "out"]) {
      const definition = EFFECT_PRESET_DEFINITIONS[presetId];
      const scenario = { key: `preset-${presetId}-${mode}`, label: `${definition.name} ${mode === "in" ? "In" : "Out"}`,
        effectKind: "preset", category: "preset", mode, sampleFactories, times: SAMPLE_TIMES,
        configuration: { presetId, mode, parameters: definition.parameters, duration: 1 } };
      scenario.makeScene = (sample) => makeScene(scenario, sample, fonts,
        { animationFactory: presetAnimationFactory(presetId, mode) });
      scenarios.push(scenario);
    }
    for (const backdropKey of selectedBackdrops) {
      const scenario = { key: `backdrop-${backdropKey}`, label: backdropKey === "background-blur" ? "Background Blur" : "Glass",
        effectKind: "backdrop", category: "backdrop", sampleFactories, times: SAMPLE_TIMES,
        fixture: "high-contrast colored bars below the layer; one white stripe moves from x=10 to x=73 over one second" };
      const layerOverrides = backdropKey === "background-blur"
        ? { backgroundBlur: { enabled: true, radius: 10, blend: 65 } }
        : { glass: { enabled: true, refraction: 75, depth: 65, dispersion: 75, frost: 8, lightIntensity: 120, lightAngle: 35, blend: 65 } };
      scenario.configuration = layerOverrides;
      scenario.makeScene = (sample) => makeScene(scenario, sample, fonts, {
        layerOverrides, belowLayers: backdropPaintLayers(scenario.key, sample.name),
      });
      scenarios.push(scenario);
    }
    if (includeStacks) {
      const stack = (key, label, keys, factories = sampleFactories, options = {}) => {
        const scenario = { key: `stack-${key}`, label, effectKind: "stack", category: "stack", stack: keys.join(" -> "),
          sampleFactories: factories, times: SAMPLE_TIMES,
          configuration: { effects: keys.map((effectKey) => ({ key: effectKey, parameters: effectDefaults(effectKey) })) } };
        scenario.makeScene = (sample) => makeScene(scenario, sample, fonts,
          { ...options, animationFactory: effectAnimationFactory(keys, scenario.key) });
        scenarios.push(scenario);
      };
      stack("distortion-postfx", "Distortion to Post FX", ["bulge", "duotone"]);
      stack("postfx-copy", "Post FX to Copy", ["duotone", "grid-scroll-x"]);
      stack("nested-group", "Nested Group Effect", ["bulge"], [sampleFactories[0]], { nested: true });
      const componentScenario = { key: "stack-component-override", label: "Component Override Expanded Source", effectKind: "stack",
        category: "stack", stack: "bulge on overridden component source", sampleFactories: [sampleFactories[0]], times: SAMPLE_TIMES,
        configuration: { effect: { key: "bulge", parameters: effectDefaults("bulge") }, componentOverride: { "stripe-blue": { fill: "#00D7E8" } } } };
      componentScenario.makeScene = (sample) => makeComponentOverrideScene(componentScenario, sample, fonts);
      scenarios.push(componentScenario);
    }

    function baseRecord(scenario, sample, time, id) {
      return { id, effectKey: scenario.key, effectLabel: scenario.label, effectKind: scenario.effectKind,
        category: scenario.category, ...(scenario.mode ? { mode: scenario.mode } : {}), ...(scenario.stack ? { stack: scenario.stack } : {}),
        ...(scenario.configuration ? { configuration: scenario.configuration } : {}), ...(scenario.fixture ? { fixture: scenario.fixture } : {}),
        sample: sample.name, time,
        geometry: { type: sample.layer.type, x: sample.layer.x, y: sample.layer.y, width: sample.layer.width, height: sample.layer.height },
        transform: { rotation: sample.layer.rotation, scaleX: sample.layer.scaleX, scaleY: sample.layer.scaleY } };
    }

    async function captureCase(scenario, sample, time, scene) {
      const id = `${safeName(scenario.key)}-${sample.name}-${String(time).replace(".", "p")}`;
      const record = baseRecord(scenario, sample, time, id);
      let browserSvg, rasterSvg, firstPng, repeatPng, firstPixels, repeatPixels;
      const timings = {};
      try {
        let began = performance.now();
        browserSvg = args.production
          ? productionBrowserSvg(scene, time, fonts, args.scale, id, pixelCanvas.width, pixelCanvas.height)
          : renderSceneSvg(scene, time, { fonts, raster: false, idPrefix: id });
        timings.svgRendererBuildMs = performance.now() - began;
        manifestCases.push({ id, svg: browserSvg });
        if (args.production) {
          began = performance.now();
          const selectedBackend = sceneNeedsChromium(scene) ? "chromium" : "resvg";
          const production = await runProductionCase(runDirectory, id, scene, time,
            pixelCanvas.width, pixelCanvas.height);
          timings.productionWorkerTotalMs = performance.now() - began;
          if (production.cancelledBy) {
            const cancelled = new Error(production.error);
            cancelled.cancelled = true;
            cancelled.exitCode = production.cancelledBy === "SIGINT" ? 130 : 143;
            throw cancelled;
          }
          if (!production.ok) {
            const failure = { ...record, browserSvg, productionFailure: production, rasterBackend: selectedBackend, timings };
            entries.push(failure);
            return;
          }
          timings.productionFirstRenderMs = production.result.first.elapsedMs;
          timings.productionRepeatRenderMs = production.result.repeat.elapsedMs;
          firstPng = await readFile(production.firstPath);
          repeatPng = await readFile(production.repeatPath);
          began = performance.now();
          firstPixels = await rgbaImage(firstPng);
          repeatPixels = await rgbaImage(repeatPng);
          timings.productionDecodeMs = performance.now() - began;
          if (firstPixels.width !== pixelCanvas.width || firstPixels.height !== pixelCanvas.height ||
              repeatPixels.width !== pixelCanvas.width || repeatPixels.height !== pixelCanvas.height) {
            const failure = { status: "invalid-output", error: "Production export returned unexpected PNG dimensions.",
              stderr: "" };
            const entry = { ...record, browserSvg, productionFailure: failure,
              rasterBackend: production.result.backend, timings };
            entries.push(entry);
            return;
          }
          const deterministic = samePixels(firstPixels, repeatPixels);
          entries.push({ ...record, browserSvg, productionPng: firstPng, productionRepeatPng: repeatPng,
            productionPixels: firstPixels, productionRepeatPixels: repeatPixels, productionDeterministic: deterministic,
            productionBackend: production.result.backend, rasterBackend: production.result.backend,
            productionFilename: production.firstPath, productionRepeatFilename: production.repeatPath, timings });
          return;
        }
        began = performance.now();
        rasterSvg = renderSceneSvg(scene, time, { fonts, raster: true, rasterScale: { x: args.scale, y: args.scale }, idPrefix: id });
        timings.rasterRendererBuildMs = performance.now() - began;

        began = performance.now();
        const native = await runNativeResvgCase(runDirectory, id, rasterSvg, pixelCanvas.width, pixelCanvas.height, args.scale);
        timings.resvgWorkerTotalMs = performance.now() - began;
        if (native.cancelledBy) {
          const cancelled = new Error(native.error);
          cancelled.cancelled = true;
          cancelled.exitCode = native.cancelledBy === "SIGINT" ? 130 : 143;
          throw cancelled;
        }
        if (!native.ok) {
          const failure = { ...record, status: "native-error", error: native.error,
            native: { status: native.status, exitCode: native.exitCode, signal: native.signal, timedOut: native.timedOut,
              stderr: native.stderr },
            deterministic: { electron: null, resvg: false, resvgNotMeasured: true }, timings };
          report.cases.push(failure);
          nativeFailures.push(failure);
          return;
        }
        timings.resvgFirstRenderMs = native.result.firstRenderMs;
        timings.resvgRepeatRenderMs = native.result.repeatRenderMs;
        firstPng = await readFile(native.firstPath);
        repeatPng = await readFile(native.repeatPath);
        began = performance.now();
        firstPixels = await rgbaImage(firstPng);
        repeatPixels = await rgbaImage(repeatPng);
        timings.resvgDecodeMs = performance.now() - began;
        const resvgDeterministic = samePixels(firstPixels, repeatPixels);
        entries.push({ ...record, browserSvg, resvgSvg: rasterSvg, resvgPng: firstPng, resvgRepeatPng: repeatPng,
          resvgPixels: firstPixels, resvgRepeatPixels: repeatPixels, resvgDeterministic,
          resvgFilename: native.firstPath, resvgRepeatFilename: native.repeatPath, timings });
      } catch (error) {
        if (error?.cancelled) throw error;
        report.cases.push({ ...record, status: "raster-error", error: String(error?.message || error).slice(0, 500), timings });
      }
    }

    for (const scenario of scenarios) for (const makeSample of scenario.sampleFactories) {
      const sample = makeSample();
      const times = scenario.times ?? SAMPLE_TIMES;
      let scene;
      try { scene = scenario.makeScene(sample); }
      catch (error) {
        for (const time of times) {
          const id = `${safeName(scenario.key)}-${sample.name}-${String(time).replace(".", "p")}`;
          report.cases.push({ ...baseRecord(scenario, sample, time, id), status: "setup-error", error: String(error?.message || error) });
        }
        continue;
      }
      for (const time of times) await captureCase(scenario, sample, time, scene);
    }
    const resvgBuildRasterMs = performance.now() - rasterStarted;
    const manifestPath = path.join(runDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: 1, ...pixelCanvas, scale: args.scale, logical: CANVAS, cases: manifestCases }), { mode: 0o600, flag: "wx" });

    const browserStarted = performance.now();
    await runElectron(runDirectory, profileDirectory);
    const electronRuntimeMs = performance.now() - browserStarted;
    const electronResultPath = path.join(runDirectory, "electron-results.json");
    const electronResult = JSON.parse(await readFile(electronResultPath, "utf8"));
    report.renderers.versions.chromium = electronResult.versions?.chromium || null;
    report.renderers.versions.node = electronResult.versions?.node || null;
    const electronById = new Map(electronResult.records.map(record => [record.id, record]));

    // Failed raster workers are isolated per case. The same independent browser SVG
    // still participates in Chromium capture, but parity remains unmeasured.
    for (const failure of nativeFailures) {
      const browser = electronById.get(failure.id);
      if (!browser || browser.error || browser.captures?.length !== 2) {
        failure.browserError = browser?.error || "Electron did not return two captures for this native-failed sample.";
        failure.deterministic.electron = false;
        continue;
      }
      const browserFirst = await rgbaImage(await readFile(browser.captures[0].filename));
      const browserRepeat = await rgbaImage(await readFile(browser.captures[1].filename));
      failure.deterministic.electron = samePixels(browserFirst, browserRepeat);
      failure.timings.electronCaptureMs = browser.captures[0].elapsedMs;
      failure.timings.electronRepeatCaptureMs = browser.captures[1].elapsedMs;
      failure.timings.electronRuntimeMs = electronRuntimeMs;
    }

    const comparisonStarted = performance.now();
    for (const entry of entries) {
      const browser = electronById.get(entry.id);
      if (!browser || browser.error || browser.captures?.length !== 2) {
        report.cases.push({ ...entryPublic(entry), status: "browser-error",
          error: browser?.error || "Electron did not return two captures for this sample.", timings: entry.timings });
        continue;
      }
      const browserFirst = await rgbaImage(await readFile(browser.captures[0].filename));
      const browserRepeat = await rgbaImage(await readFile(browser.captures[1].filename));
      const browserDeterministic = samePixels(browserFirst, browserRepeat);
      if (args.production && entry.productionFailure) {
        const failure = entry.productionFailure;
        report.cases.push({
          ...entryPublic(entry),
          status: "production-error",
          error: failure.error || "Production renderer failed.",
          production: { status: failure.status || "worker-error", exitCode: failure.exitCode ?? null,
            signal: failure.signal ?? null, timedOut: Boolean(failure.timedOut), stderr: failure.stderr || "" },
          rasterBackend: entry.rasterBackend,
          deterministic: { electron: browserDeterministic, production: false, productionNotMeasured: true },
          timings: { ...entry.timings, electronCaptureMs: browser.captures[0].elapsedMs,
            electronRepeatCaptureMs: browser.captures[1].elapsedMs, electronRuntimeMs },
        });
        continue;
      }
      const comparisonStartedAt = performance.now();
      const rasterPixels = args.production ? entry.productionPixels : entry.resvgPixels;
      const rasterRepeatPixels = args.production ? entry.productionRepeatPixels : entry.resvgRepeatPixels;
      const rasterDeterministic = args.production ? entry.productionDeterministic : entry.resvgDeterministic;
      const rasterPng = args.production ? entry.productionPng : entry.resvgPng;
      const metrics = comparePixels(browserFirst, rasterPixels);
      const repeatMetrics = comparePixels(rasterPixels, rasterRepeatPixels);
      const decodeCompareMs = performance.now() - comparisonStartedAt;
      const passed = metrics.meanPremultipliedRgbaDifference <= THRESHOLD.meanPremultipliedRgbaDifference &&
        metrics.differingPixelRatio <= THRESHOLD.differingPixelRatio &&
        (!THRESHOLD.requireDeterministicRerender || (browserDeterministic && rasterDeterministic));
      const rasterLabel = args.production ? "production" : "resvg";
      const publicRecord = {
        ...entryPublic(entry),
        ...(args.production ? { rasterBackend: entry.productionBackend } : {}),
        status: passed ? "pass" : "fail",
        meanPremultipliedRgbaDifference: metrics.meanPremultipliedRgbaDifference,
        meanPremultipliedRgbaDifference8Bit: metrics.meanPremultipliedRgbaDifference8Bit,
        differingPixelRatio: metrics.differingPixelRatio,
        differingPixels: metrics.differingPixels,
        totalPixels: metrics.totalPixels,
        maxPremultipliedChannelDifference8Bit: metrics.maxPremultipliedChannelDifference8Bit,
        deterministic: { electron: browserDeterministic, [rasterLabel]: rasterDeterministic,
          [`${rasterLabel}RepeatMeanDifference`]: repeatMetrics.meanPremultipliedRgbaDifference,
          [`${rasterLabel}RepeatDifferingPixelRatio`]: repeatMetrics.differingPixelRatio },
        timings: { ...entry.timings, electronCaptureMs: browser.captures[0].elapsedMs,
          electronRepeatCaptureMs: browser.captures[1].elapsedMs, electronRuntimeMs, decodeCompareMs },
      };
      if (!passed) publicRecord.artifacts = await writeFailureArtifacts(output, publicRecord,
        await readFile(browser.captures[0].filename), rasterPng, metrics.diffPixels, metrics.width, metrics.height, rasterLabel);
      report.cases.push(publicRecord);
    }
    const comparisonMs = performance.now() - comparisonStarted;
    const cases = report.cases;
    const passedCases = cases.filter(item => item.status === "pass").length;
    const failedCases = cases.length - passedCases;
    report.summary = {
      totalCases: cases.length,
      passedCases,
      failedCases,
      effects: selectedEffects.length,
      presets: selectedPresetIds.length,
      presetModes: selectedPresetIds.length ? 2 : 0,
      backdrops: selectedBackdrops.length,
      stacks: includeStacks ? 4 : 0,
      ...(args.production ? {
        productionCases: entries.length,
        productionFailures: cases.filter(item => item.status === "production-error").length,
        backends: Object.fromEntries(["chromium", "resvg"].map(backend =>
          [backend, cases.filter(item => item.rasterBackend === backend).length])),
      } : { nativeWorkerCases: entries.length + nativeFailures.length, nativeFailures: nativeFailures.length }),
      caseCategories: Object.fromEntries(["baseline", "effect", "preset", "backdrop", "stack"].map((category) =>
        [category, cases.filter((item) => item.category === category).length])),
      baselineCases: cases.filter(item => item.effectKey === "baseline").length,
      sampleKinds: sampleFactories.length,
      timestampsPerSample: SAMPLE_TIMES.length,
      rendererDeterministic: cases.every(item => item.deterministic?.electron === true &&
        item.deterministic?.[args.production ? "production" : "resvg"] === true),
      timings: {
        totalMs: performance.now() - started,
        [args.production ? "productionExportAndDecodeMs" : "resvgBuildAndRasterMs"]: resvgBuildRasterMs,
        electronProcessAndCaptureMs: electronRuntimeMs,
        comparisonAndArtifactsMs: comparisonMs,
      },
    };
    report.finishedAt = nowIso();
    await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`Effects parity: ${passedCases}/${cases.length} samples passed; report: ${path.join(output, "report.json")}\n`);
    if (failedCases) process.exitCode = 1;
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

function entryPublic(entry) {
  return { id: entry.id, effectKey: entry.effectKey, effectLabel: entry.effectLabel,
    effectKind: entry.effectKind, category: entry.category, ...(entry.mode ? { mode: entry.mode } : {}),
    ...(entry.stack ? { stack: entry.stack } : {}), ...(entry.configuration ? { configuration: entry.configuration } : {}),
    ...(entry.fixture ? { fixture: entry.fixture } : {}), sample: entry.sample, time: entry.time,
    geometry: entry.geometry, transform: entry.transform,
    ...(entry.rasterBackend ? { rasterBackend: entry.rasterBackend } : {}) };
}

main().catch(error => {
  process.stderr.write(`[effects-parity] ${String(error?.message || error).slice(0, 1_000)}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
