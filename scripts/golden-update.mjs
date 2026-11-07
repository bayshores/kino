// Renders every golden-frame fixture (tests/golden/scenes.mjs) through the real PNG export and
// stores the frames in tests/golden/frames/. Run it with `npm run golden:update` after a change
// that is meant to alter how frames look, then check the new PNGs before committing them.
// tests/golden-frames.test.mjs compares fresh renders against these files.
// On Linux, where Chromium draws on the CPU (tests/golden/raster.mjs), it refreshes only the
// frames in tests/golden/frames-cpu/; the main set is made on a Mac.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { scenes } from "../tests/golden/scenes.mjs";
import { CPU_FRAMES_DIRECTORY, FRAMES_DIRECTORY, frameFileName, renderFrame } from "../tests/golden/render.mjs";
import { CPU_RASTER } from "../tests/golden/raster.mjs";

const directory = CPU_RASTER ? CPU_FRAMES_DIRECTORY : FRAMES_DIRECTORY;
const cpuFrames = CPU_RASTER ? new Set(await readdir(CPU_FRAMES_DIRECTORY)) : null;
await mkdir(directory, { recursive: true });
const written = new Set();
let bytes = 0;
for (const fixture of scenes) {
  for (const time of fixture.times) {
    const name = frameFileName(fixture, time);
    if (cpuFrames && !cpuFrames.has(name)) continue;
    const png = await renderFrame(fixture, time);
    await writeFile(path.join(directory, name), png);
    written.add(name);
    bytes += png.length;
  }
}
// A frame whose fixture or time was removed would otherwise stay behind unchecked.
for (const folder of CPU_RASTER ? [] : [FRAMES_DIRECTORY, CPU_FRAMES_DIRECTORY]) {
  for (const name of await readdir(folder).catch(() => [])) {
    if (name.endsWith(".png") && !written.has(name)) {
      await rm(path.join(folder, name));
      console.log(`Removed stale ${path.relative(process.cwd(), path.join(folder, name))}`);
    }
  }
}
console.log(`Wrote ${written.size} golden frames (${(bytes / 1024).toFixed(0)} KB) to ${path.relative(process.cwd(), directory)}.`);
