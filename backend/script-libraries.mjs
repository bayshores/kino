// The 3D library a script layer may import, as plain module text the sandboxed frame turns into
// blob: modules (engine/scriptRuntime.js). Nothing is fetched from a network: the text comes from
// the `three` package (MIT license, kept in LICENSE next to the files), bundled once by esbuild
// into two files under dist/script-libraries/ (`npm run build` makes them, and the packaged app
// ships only those two files and the license, not the package). When they are missing (a
// development checkout before its first build) they are made here on first use.
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_LIBRARY_NAMES, scriptLibraryNames } from "../engine/scriptLayer.js";

const root = fileURLToPath(new URL("..", import.meta.url));
export const SCRIPT_LIBRARY_FOLDER = path.join(root, "dist", "script-libraries");
// One file per specifier a script may import.
const FILES = { three: "three.js", "three/addons/loaders/GLTFLoader.js": "gltf-loader.js" };

/** Bundles the two files (and copies the license) into `folder`. Needs the three and esbuild packages. */
export async function buildScriptLibraries(folder = SCRIPT_LIBRARY_FOLDER) {
  const { build } = await import("esbuild");
  const require = createRequire(import.meta.url);
  // The package's main file is build/three.cjs (its exports list has no package.json).
  const packageFolder = path.resolve(path.dirname(require.resolve("three")), "..");
  await mkdir(folder, { recursive: true });
  const common = { bundle: true, format: "esm", minify: true, legalComments: "inline", target: "es2022", logLevel: "silent" };
  // The library itself, every export in one module.
  await build({ ...common, entryPoints: [path.join(packageFolder, "build", "three.module.js")], outfile: path.join(folder, FILES.three) });
  // The model loader with its two helper files; it imports the library as "three", which the
  // frame points at the same module as the script's own import.
  await build({ ...common, entryPoints: [path.join(packageFolder, "examples", "jsm", "loaders", "GLTFLoader.js")],
    external: ["three"], outfile: path.join(folder, FILES["three/addons/loaders/GLTFLoader.js"]) });
  await copyFile(path.join(packageFolder, "LICENSE"), path.join(folder, "LICENSE"));
}

let texts = null;
async function readAll() {
  const read = () => Promise.all(SCRIPT_LIBRARY_NAMES.map((name) => readFile(path.join(SCRIPT_LIBRARY_FOLDER, FILES[name]), "utf8")));
  let contents;
  try {
    contents = await read();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await buildScriptLibraries();
    contents = await read();
  }
  return Object.fromEntries(SCRIPT_LIBRARY_NAMES.map((name, index) => [name, contents[index]]));
}

/**
 * The module text of each library `script` imports, as {specifier: text}, or {} when it imports
 * none (the text is only read and sent for layers that use it).
 */
export async function scriptLibrariesFor(script) {
  const names = scriptLibraryNames(script);
  if (!names.length) return {};
  texts ??= readAll().catch((error) => { texts = null; throw error; });
  const all = await texts;
  // The loader imports the library, so it always comes with it.
  return Object.fromEntries(SCRIPT_LIBRARY_NAMES.filter((name) => name === "three" || names.includes(name)).map((name) => [name, all[name]]));
}

/** One library's text by specifier (the dashboard's preview asks for it), or null for another name. */
export async function scriptLibraryText(name) {
  if (!SCRIPT_LIBRARY_NAMES.includes(name)) return null;
  texts ??= readAll().catch((error) => { texts = null; throw error; });
  return (await texts)[name];
}

// `npm run build` runs this file to make the shipped copies.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildScriptLibraries();
}
