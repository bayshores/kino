// Project-wide rules from AGENTS.md, checked over every file Git tracks.
// 1. No em dash (U+2014) anywhere. A test that needs the character writes it as an escape
//    ("\u2014" in code, \u2014 in JSON), so the file itself has none.
// 2. The folders keep their layers: engine/ imports only engine/, frontend/ only engine/ and
//    itself, and backend/, desktop/ and bin/ never import frontend/. Tests may cross.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EM_DASH = "\u2014";
// Installed packages are not this project's text.
const SKIPPED_FOLDERS = ["node_modules/"];
// Pictures, sound, video, fonts and archives: not text, so a stray byte is not an em dash.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|mp4|mov|webm|mkv|wav|mp3|m4a|aac|ogg|flac|ttf|otf|woff2?|zip|gz|tgz|pdf|lottie|bin)$/i;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter((file) => file && !BINARY.test(file) && !SKIPPED_FOLDERS.some((folder) => file.startsWith(folder)));
}

test("no tracked text file contains an em dash", () => {
  const files = trackedFiles();
  assert.ok(files.length > 100, `git ls-files listed ${files.length} files`);
  const found = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(path.join(ROOT, file));
    } catch {
      continue; // deleted in this checkout but not yet committed
    }
    if (bytes.includes(0)) continue; // a binary file
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.includes(EM_DASH)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], `Em dashes found (use a colon, comma, parentheses or a new sentence):\n${found.join("\n")}`);
});

// Which top folders each folder's product code may import from (relative imports only).
const ALLOWED = {
  engine: ["engine"],
  frontend: ["frontend", "engine"],
  backend: ["backend", "engine", "assets"],
  desktop: ["desktop", "backend", "engine", "assets"],
  bin: ["bin", "backend", "engine"],
};
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

test("product code imports stay inside their layer", () => {
  const found = [];
  for (const file of trackedFiles()) {
    const top = file.split("/")[0];
    if (!ALLOWED[top] || !/\.(m?js|jsx|cjs)$/.test(file) || /\.(test|support)\./.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const [, spec] of text.matchAll(IMPORT)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).split("/")[0];
      if (!ALLOWED[top].includes(target)) found.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(found, [], `Imports across layers (see AGENTS.md, Structure):\n${found.join("\n")}`);
});
