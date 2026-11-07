// `kino setup`: connects the coding agents installed on this computer to kino.
//
// For each agent it finds (Claude Code: `claude`, Codex: `codex`), it plans:
// - registering kino's MCP server with the agent's own command (`claude mcp add`, `codex mcp add`);
// - copying the kino skill (skills/kino) into the agent's skill folder.
// It also offers a preview entry in this checkout's .claude/launch.json.
//
// It prints every change first and changes nothing until you confirm (or pass --yes).
// It reads only kino's own files and the skill folders it writes; it never opens an agent's
// settings, history or token files (the agents' own commands do the registering).
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = path.join(root, "skills", "kino");
const binPath = path.join(root, "bin", "kino.mjs");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return { ok: result.status === 0, missing: result.error?.code === "ENOENT", output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

// All files of a folder as { relative path: contents }.
async function folderFiles(folder) {
  const files = {};
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files[path.relative(folder, full)] = await readFile(full, "utf8");
    }
  }
  await walk(folder);
  return files;
}

async function skillStep(agent, target) {
  const source = await folderFiles(skillSource);
  const existing = await folderFiles(target);
  if (!Object.keys(existing).length)
    return { agent, kind: "skill", describe: `copy the kino skill to ${target}`, apply: () => copySkill(target) };
  const same = Object.keys(source).length === Object.keys(existing).length && Object.entries(source).every(([name, text]) => existing[name] === text);
  if (same) return { agent, kind: "skill", done: `skill already up to date in ${target}` };
  // Replace only a folder that holds a kino skill (one an earlier setup copied).
  if (!/^name:\s*kino\s*$/m.test(existing["SKILL.md"] ?? ""))
    return { agent, kind: "skill", blocked: `${target} exists and is not a kino skill; move it away and run setup again` };
  return { agent, kind: "skill", describe: `update the kino skill in ${target}`, apply: () => copySkill(target) };
}

async function copySkill(target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillSource, target, { recursive: true });
}

function mcpStep(agent, command, addArgs) {
  const listed = run(command, ["mcp", "get", "kino"]);
  if (listed.ok) return { agent, kind: "mcp", done: `${agent} already has a kino MCP server (${command} mcp get kino)` };
  return {
    agent, kind: "mcp",
    describe: `run: ${command} ${addArgs.map((word) => (/\s/.test(word) ? JSON.stringify(word) : word)).join(" ")}`,
    apply() {
      const result = run(command, addArgs);
      if (!result.ok) throw new Error(`${command} mcp add failed: ${result.output.slice(0, 400)}`);
    },
  };
}

async function launchStep(file) {
  let config = { version: "0.0.1", configurations: [] };
  try { config = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") return { agent: "preview", kind: "launch", blocked: `${file} is not valid JSON` }; }
  if ((config.configurations ?? []).some((entry) => entry.name === "kino")) return { agent: "preview", kind: "launch", done: `${file} already has a kino entry` };
  return {
    agent: "preview", kind: "launch",
    describe: `add a "kino" preview entry (node backend/index.mjs on port 4781) to ${file}`,
    async apply() {
      config.configurations = [...(config.configurations ?? []), { name: "kino", runtimeExecutable: "node", runtimeArgs: ["backend/index.mjs"], port: 4781 }];
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    },
  };
}

/** Works out what setup would do. `home`, `node` and `launchFile` can be changed for tests. */
export async function planSetup({
  home = process.env.KINO_SETUP_HOME || homedir(),
  node = process.execPath,
  launchFile = process.env.KINO_SETUP_LAUNCH_FILE || path.join(root, ".claude", "launch.json"),
} = {}) {
  const serverCommand = ["--", node, binPath, "mcp"];
  const steps = [];
  const found = [];
  if (!run("claude", ["--version"]).missing) {
    found.push("Claude Code");
    steps.push(mcpStep("Claude Code", "claude", ["mcp", "add", "--scope", "user", "kino", ...serverCommand]));
    steps.push(await skillStep("Claude Code", path.join(home, ".claude", "skills", "kino")));
  }
  if (!run("codex", ["--version"]).missing) {
    found.push("Codex");
    steps.push(mcpStep("Codex", "codex", ["mcp", "add", "kino", ...serverCommand]));
    steps.push(await skillStep("Codex", path.join(home, ".agents", "skills", "kino")));
  }
  steps.push(await launchStep(launchFile));
  return { found, steps: steps.filter(Boolean) };
}

export async function runSetup(argv = []) {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const { found, steps } = await planSetup();
  console.log(found.length ? `Found: ${found.join(", ")}.` : "Found no Claude Code (claude) or Codex (codex) on your PATH.");
  for (const step of steps.filter((entry) => entry.done)) console.log(`  ✓ ${step.done}`);
  for (const step of steps.filter((entry) => entry.blocked)) console.log(`  ! ${step.blocked}`);
  const changes = steps.filter((entry) => entry.apply);
  if (!changes.length) {
    console.log("Nothing to change.");
    if (!found.length) console.log("Other agents: add an MCP server that runs `node bin/kino.mjs mcp` in this folder, and have the agent call library {topic:\"guide\"} once.");
    return;
  }
  console.log("Setup will:");
  changes.forEach((step, index) => console.log(`  ${index + 1}. ${step.agent}: ${step.describe}`));
  if (dryRun) return console.log("(--dry-run: nothing changed)");
  if (!yes) {
    if (!process.stdin.isTTY) return console.log("Run kino setup --yes to make these changes.");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Make these changes? [y/N] ");
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log("Nothing changed.");
  }
  for (const step of changes) {
    try {
      await step.apply();
      console.log(`  ✓ ${step.agent}: ${step.describe}`);
    } catch (error) {
      console.log(`  ✗ ${step.agent}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (found.includes("Codex"))
    console.log('Codex may ask you to approve kino tool calls (codex exec cannot ask, so they fail there). To allow them, add default_tools_approval_mode = "approve" under [mcp_servers.kino] in your Codex config; setup does not change it.');
  console.log("Done. Start kino (the app, or npm run dev), then ask your agent to make a video with kino.");
}
