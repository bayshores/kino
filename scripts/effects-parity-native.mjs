import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Resvg } from "@resvg/resvg-js";

function integer(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  return parsed;
}

function assertPngSize(png, width, height, name) {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG" || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height)
    throw new Error(`${name} produced an unexpected PNG size.`);
}

async function main() {
  const [svgPath, firstPath, repeatPath, widthValue, heightValue, scaleValue] = process.argv.slice(2);
  if (!svgPath || !firstPath || !repeatPath || process.argv.length !== 8)
    throw new TypeError("Expected SVG input, two private PNG output paths, width, height, and scale.");
  const width = integer(widthValue, "width");
  const height = integer(heightValue, "height");
  const scale = Number(scaleValue);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new RangeError("scale must be greater than 0 and at most 4.");
  const runDirectory = path.dirname(path.dirname(path.resolve(svgPath)));
  const outputDirectory = path.join(runDirectory, "resvg");
  if (path.dirname(path.resolve(firstPath)) !== outputDirectory || path.dirname(path.resolve(repeatPath)) !== outputDirectory)
    throw new Error("PNG outputs must stay inside this parity run's private raster directory.");

  const svg = await readFile(svgPath, "utf8");
  if (!svg.startsWith("<svg") || svg.length > 64 * 1024 * 1024) throw new Error("SVG input is invalid or too large.");
  const options = { fitTo: { mode: "zoom", value: scale }, font: { loadSystemFonts: false } };
  let began = performance.now();
  const firstPng = new Resvg(svg, options).render().asPng();
  const firstRenderMs = performance.now() - began;
  assertPngSize(firstPng, width, height, "First render");
  await writeFile(firstPath, firstPng, { mode: 0o600, flag: "wx" });

  began = performance.now();
  const repeatPng = new Resvg(svg, options).render().asPng();
  const repeatRenderMs = performance.now() - began;
  assertPngSize(repeatPng, width, height, "Repeat render");
  await writeFile(repeatPath, repeatPng, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: "ok", width, height, firstRenderMs, repeatRenderMs })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[effects-parity-native] ${String(error?.stack || error).slice(0, 1_500)}\n`);
  process.exitCode = 1;
});
