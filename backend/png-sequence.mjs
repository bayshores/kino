import { join } from "node:path";
import { archiveFiles } from "./zip.mjs";

const MAX_FRAMES = 0xffff;

/** Archive rendered PNG frames in order as frame-000000.png and onward. */
export async function archivePngSequence(
  directory,
  frameCount,
  output,
  { signal } = {},
) {
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES) {
    throw new RangeError("PNG sequence frame count must be between 1 and 65535");
  }
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("PNG sequence directory is required");
  }
  if (typeof output !== "string" || output.length === 0) {
    throw new TypeError("PNG sequence output path is required");
  }

  const entries = Array.from({ length: frameCount }, (_, index) => {
    const name = `frame-${String(index).padStart(6, "0")}.png`;
    return { name, path: join(directory, name) };
  });
  const result = await archiveFiles(entries, output, { signal });
  return { path: result.path, size: result.size, frameCount };
}
