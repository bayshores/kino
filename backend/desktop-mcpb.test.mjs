// The Claude Desktop extension (desktop/mcpb.mjs) must start the Mac app's tool server exactly as the
// app itself does (desktop/mcp-launch.mjs, used by desktop/main.mjs for GET /api/mcp-config).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mcpLaunch } from "../desktop/mcp-launch.mjs";
import { MCPB_APP_KEY, MCPB_DEFAULT_APP, mcpbManifest } from "../desktop/mcpb.mjs";
import { stageBundle } from "../scripts/mcpb-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("the Claude Desktop extension starts the installed app's tool server like the app does", () => {
  const manifest = mcpbManifest({ version: pkg.version, productName: pkg.build.productName });
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.user_config[MCPB_APP_KEY].default, MCPB_DEFAULT_APP);
  // What the app would report if it were installed at the default place and opened by this person.
  const app = MCPB_DEFAULT_APP;
  const home = "/Users/someone";
  const expected = mcpLaunch({
    execPath: `${app}/Contents/MacOS/${pkg.build.productName}`,
    root: `${app}/Contents/Resources/app.asar`,
    runtimeFile: `${home}/Library/Application Support/kino/runtime.json`,
  });
  const fill = (text) => text.replaceAll(`\${user_config.${MCPB_APP_KEY}}`, app).replaceAll("${HOME}", home);
  const { command, args, env } = manifest.server.mcp_config;
  assert.deepEqual({ command: fill(command), args: args.map(fill), env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, fill(value)])) }, expected);
  // The file it starts exists in the app, and the app builds its config from the same function.
  assert.ok(existsSync(path.join(root, "desktop/mcp.mjs")));
  assert.match(readFileSync(path.join(root, "desktop/main.mjs"), "utf8"), /KINO_MCP_COMMAND: mcp\.command, KINO_MCP_ARGS: JSON\.stringify\(mcp\.args\), KINO_MCP_ENV: JSON\.stringify\(mcp\.env\)/);
});

test("the Codex plugin (plugin.json and mcp.json) says what the Claude Code plugin says", () => {
  const claude = JSON.parse(readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(path.join(root, "mcp.json"), "utf8"));
  for (const key of ["name", "version", "description", "author", "license", "keywords"]) assert.deepEqual(plugin[key], claude[key], key);
  assert.equal(plugin.version, pkg.version);
  const server = mcp.mcpServers.kino;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, claude.mcpServers.kino.command);
  assert.deepEqual(server.args, claude.mcpServers.kino.args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")));
  // Skills are found in skills/<name>/SKILL.md.
  assert.ok(existsSync(path.join(root, "skills/kino/SKILL.md")));
});

test("mcpb:pack stages the manifest at the app's version with its icon and note", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-mcpb-test-"));
  try {
    const manifest = stageBundle(directory);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")), manifest);
    assert.equal(manifest.version, pkg.version);
    for (const file of [manifest.icon, manifest.server.entry_point]) assert.ok(existsSync(path.join(directory, file)), file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
