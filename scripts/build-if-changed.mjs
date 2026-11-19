#!/usr/bin/env node
// npm run desktop: builds the dashboard only when something it is built from changed since the
// last build (AGENTS.md, Efficiency rules), so opening the app again starts at once. The stamp
// is the size and modified time of every file under frontend/, engine/, assets/ and public/,
// plus index.html, vite.config.mjs, package-lock.json and backend/script-libraries.mjs; it is
// kept in dist/.build-stamp. `npm run build` always builds. --force builds here too.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDERS = ["frontend", "engine", "assets", "public"];
const FILES = ["index.html", "vite.config.mjs", "package-lock.json", "backend/script-libraries.mjs"];
const BUILT = ["dist/client/index.html", "dist/script-libraries/three.js"];
const stampFile = path.join(root, "dist", ".build-stamp");

async function filesUnder(base, folder) {
  const entries = await readdir(path.join(base, folder), { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    const relative = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(base, relative));
    else if (entry.isFile()) found.push(relative);
  }
  return found;
}

/** A hash of what the build reads under `base`: each file's path, size and modified time. */
export async function buildStamp(base = root) {
  const files = [...(await Promise.all(FOLDERS.map((folder) => filesUnder(base, folder)))).flat(), ...FILES].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const info = await stat(path.join(base, file)).catch(() => null);
    hash.update(`${file}:${info ? `${info.size}:${info.mtimeMs}` : "missing"}\n`);
  }
  return hash.digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stamp = await buildStamp();
  const last = await readFile(stampFile, "utf8").catch(() => "");
  if (!process.argv.includes("--force") && last === stamp && BUILT.every((file) => existsSync(path.join(root, file)))) {
    console.log("The dashboard build is up to date: nothing it is built from changed.");
  } else {
    const built = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
    await mkdir(path.dirname(stampFile), { recursive: true });
    await writeFile(stampFile, stamp);
  }
}
