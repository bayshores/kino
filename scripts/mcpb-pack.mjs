// npm run mcpb:pack: writes release/kino.mcpb, the Claude Desktop extension (desktop/mcpb.mjs).
// It stages a manifest, the icon and a note in a temporary folder, validates and packs them with
// the official mcpb tool (run through npx, not a dependency of kino).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCPB_NOTE, mcpbManifest } from "../desktop/mcpb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MCPB_TOOL = "@anthropic-ai/mcpb@2.1.2";

/** Writes the bundle's files into `directory` and returns the manifest. */
export function stageBundle(directory) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = mcpbManifest({ version: pkg.version, productName: pkg.build.productName });
  mkdirSync(path.join(directory, "server"), { recursive: true });
  writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(directory, "server/README.txt"), MCPB_NOTE);
  copyFileSync(path.join(root, "assets/kino-icon.png"), path.join(directory, "icon.png"));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stage = mkdtempSync(path.join(tmpdir(), "kino-mcpb-"));
  const output = path.join(root, "release/kino.mcpb");
  try {
    stageBundle(stage);
    mkdirSync(path.dirname(output), { recursive: true });
    execFileSync("npx", ["--yes", MCPB_TOOL, "pack", stage, output], { stdio: "inherit" });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
