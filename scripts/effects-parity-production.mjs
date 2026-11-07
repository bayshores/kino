import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { exportScene } from "../backend/export.mjs";
import { sceneNeedsChromium } from "../backend/raster-policy.mjs";
import { loadBundledFonts } from "../backend/fonts.mjs";

const safeCaseId = /^[a-z0-9._-]{1,160}$/i;

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 8192) throw new RangeError(`${name} must be an integer from 1 through 8192.`);
  return number;
}

function assertPng(buffer, width, height) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG" ||
      buffer.readUInt32BE(16) !== width || buffer.readUInt32BE(20) !== height)
    throw new Error("Production export returned invalid PNG data or dimensions.");
}

function childOf(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function main() {
  const [runDirectoryValue, idValue] = process.argv.slice(2);
  if (!runDirectoryValue || !idValue || process.argv.length !== 4 || !safeCaseId.test(idValue))
    throw new TypeError("Expected this parity run's private directory and a case id.");
  const runDirectory = path.resolve(runDirectoryValue);
  const inputPath = path.join(runDirectory, "production-input", `${idValue}.json`);
  const outputDirectory = path.join(runDirectory, "production");
  if (!childOf(runDirectory, inputPath) || !childOf(runDirectory, outputDirectory))
    throw new Error("Production parity files must stay inside this run directory.");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (input.version !== 1 || input.id !== idValue || !input.scene || !Array.isArray(input.scene.layers) ||
      !Number.isFinite(input.time)) throw new TypeError("Invalid production parity case.");
  const width = integer(input.width, "width");
  const height = integer(input.height, "height");
  if (width * height > 64_000_000) throw new RangeError("Production parity image exceeds the 64-megapixel limit.");
  const scene = input.scene;
  const fonts = await loadBundledFonts();
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Production parity render was cancelled."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const backend = sceneNeedsChromium(scene) ? "chromium" : "resvg";
  const options = { format: "png", width, height, time: input.time };
  const render = async (suffix) => {
    controller.signal.throwIfAborted();
    const began = performance.now();
    const result = await exportScene(scene, options, { fonts, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!Buffer.isBuffer(result.buffer) || result.mime !== "image/png")
      throw new Error("Production exportScene did not return a PNG buffer.");
    assertPng(result.buffer, width, height);
    const filename = path.join(outputDirectory, `${idValue}${suffix}.png`);
    await writeFile(filename, result.buffer, { mode: 0o600, flag: "wx" });
    return { filename, elapsedMs: performance.now() - began, bytes: result.buffer.length };
  };

  try {
    const first = await render("");
    const repeat = await render(".repeat");
    process.stdout.write(`@@PRODUCTION_CASE@@${JSON.stringify({ status: "ok", id: idValue, backend, first, repeat })}\n`);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

main().catch((error) => {
  process.stderr.write(`[effects-parity-production] ${String(error?.stack || error).slice(0, 2_000)}\n`);
  process.exitCode = error?.name === "AbortError" ? 130 : 1;
});
