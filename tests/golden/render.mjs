// Shared by scripts/golden-update.mjs and tests/golden-frames.test.mjs: both render a fixture
// frame through exactly the same steps, so a stored golden PNG and a fresh render can only
// differ when the engine itself draws differently.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportScene } from "../../backend/export.mjs";
import { loadBundledFonts } from "../../backend/fonts.mjs";
import { expandComponents } from "../../engine/linkedComponents.js";
import { goldenMediaRoot } from "./media.mjs";
import { CPU_RASTER } from "./raster.mjs";
import { decodePng, encodePng } from "./compare.mjs";

/** Where the golden PNGs live: tests/golden/frames/<scene name>@<time>.png. */
export const FRAMES_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "frames");

/** Goldens for the frames that Chromium draws differently on the CPU (tests/golden/raster.mjs). */
export const CPU_FRAMES_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "frames-cpu");

/** The golden PNG to compare a fresh render with on this machine. */
export function goldenPath(fileName) {
  const cpu = path.join(CPU_FRAMES_DIRECTORY, fileName);
  return CPU_RASTER && existsSync(cpu) ? cpu : path.join(FRAMES_DIRECTORY, fileName);
}

/** The width every golden frame is rendered at, unless a fixture asks for another one. */
export const DEFAULT_WIDTH = 480;

/** Only the fonts shipped in assets/fonts, so frames never depend on the machine's fonts. */
export const fonts = await loadBundledFonts();

export function frameFileName(fixture, time) {
  return `${fixture.name}@${time}.png`;
}

/**
 * One PNG frame of a fixture at `time` seconds, through the real still-export path.
 * Component instances are expanded first, as the /api/export route does (backend/index.mjs).
 * A fixture with `media: true` plays the generated files in tests/golden/media.mjs.
 * Drawn with the motion-blur preview (engine/previewBlur.js), as look and the app draw it.
 */
export async function renderFrame(fixture, time) {
  if (fixture.sheet) return renderSheet(fixture);
  const sceneId = fixture.sceneId ?? fixture.document.scenes[0].id;
  const scene = expandComponents(fixture.document, sceneId, { fonts });
  const mediaRoot = fixture.media ? await goldenMediaRoot() : undefined;
  const result = await exportScene(scene, { format: "png", time, width: fixture.width ?? DEFAULT_WIDTH }, { fonts, mediaRoot, previewBlur: true });
  return result.buffer;
}

/**
 * A sheet fixture ({sheet: [fixtures, each with its own `time`], columns}): each part rendered as
 * above at its own time, tiled left to right and top to bottom into one PNG (all parts one size).
 */
async function renderSheet(fixture) {
  const tiles = [];
  for (const part of fixture.sheet) tiles.push(await decodePng(await renderFrame(part, part.time)));
  const columns = fixture.columns ?? tiles.length;
  const { width, height } = tiles[0];
  const sheetWidth = width * columns, sheetHeight = height * Math.ceil(tiles.length / columns);
  const pixels = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  tiles.forEach((tile, index) => {
    const [left, top] = [(index % columns) * width, Math.floor(index / columns) * height];
    for (let y = 0; y < height; y += 1)
      pixels.set(tile.data.subarray(y * width * 4, (y + 1) * width * 4), ((top + y) * sheetWidth + left) * 4);
  });
  return encodePng(sheetWidth, sheetHeight, pixels);
}
