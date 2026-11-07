import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin") throw new Error("Generating the Mac .icns file requires macOS iconutil.");
const svg = await readFile(path.join(root, "assets/kino-icon.svg"), "utf8");
const temporary = await mkdtemp(path.join(os.tmpdir(), "kino-icon-"));
try {
  const iconset = path.join(temporary, "kino.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const density of [1, 2]) {
      const pixels = size * density;
      const png = new Resvg(svg, { fitTo: { mode: "width", value: pixels } }).render().asPng();
      await writeFile(path.join(iconset, `icon_${size}x${size}${density === 2 ? "@2x" : ""}.png`), png);
      if (pixels === 1024) await writeFile(path.join(root, "assets/kino-icon.png"), png);
    }
  }
  const destination = path.join(root, "assets/kino-icon.icns");
  const child = spawn("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination], { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`iconutil exited with ${code}.`)));
  });
  console.log(`Generated ${path.relative(root, destination)} from original SVG artwork.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
