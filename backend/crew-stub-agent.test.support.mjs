// A stand-in for the `claude` and `codex` programs in crew-launch.integration.test.mjs: it reads
// the command line kino's launcher (agent/launcher.mjs) gives the real program, starts kino's MCP
// server exactly as that program would (from --mcp-config, or from Codex's -c mcp_servers.kino…
// settings), makes kino tool calls chosen by the task in the prompt, and ends with a final
// message the way the real program reports one (Claude Code's JSON `result`, Codex's -o file).
// It never runs a real agent and reads nothing from the home folder.
//
// Tasks (the prompt's "Task:" line):
//   look only check   status, then an edit (kino should refuse it: look and search only)
//   make a title      status, then an edit that adds a text layer "stub title"
//   spend             status four times (a budget of 2 calls holds it at the third)
//   wait forever      status, then waits until it is stopped
//   anything else     status, then the steps for that task in the JSON file CREW_STUB_PLAN
//                     names, if set (for a longer, realistic run of the crew screen)
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Writes stub `claude` and `codex` programs into `folder` (made if needed). Returns the env a
 * test server needs to start them: {KINO_CLAUDE, KINO_CODEX}.
 */
export async function writeStubPrograms(folder) {
  await mkdir(folder, { recursive: true });
  const stub = `#!/usr/bin/env node\nimport(${JSON.stringify(fileURLToPath(import.meta.url))}).then((m) => m.runStub(${JSON.stringify(path.join(root, "node_modules/@modelcontextprotocol/sdk"))})).catch((e) => { console.error(e); process.exit(3); });\n`;
  for (const name of ["claude", "codex"]) {
    await writeFile(path.join(folder, name), stub);
    await chmod(path.join(folder, name), 0o755);
  }
  return { KINO_CLAUDE: path.join(folder, "claude"), KINO_CODEX: path.join(folder, "codex") };
}

export async function runStub(sdkRoot) {
  const { Client } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/client/stdio.js")).href);
  const argv = process.argv.slice(2);
  const program = path.basename(process.argv[1]);
  let server;
  let prompt;
  let lastFile = null;
  if (program === "claude") {
    prompt = argv[argv.indexOf("-p") + 1];
    server = JSON.parse(await readFile(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.kino;
    if (!argv.includes("--strict-mcp-config") || argv[argv.indexOf("--allowedTools") + 1] !== "mcp__kino") throw new Error("kino tools are not the only ones allowed");
  } else {
    prompt = argv.at(-1);
    lastFile = argv[argv.indexOf("-o") + 1];
    const settings = Object.fromEntries(argv.flatMap((arg, index) => (argv[index - 1] === "-c" ? [arg.split(/=(.*)/s).slice(0, 2)] : [])));
    if (settings["mcp_servers.kino.default_tools_approval_mode"] !== '"approve"') throw new Error("kino tools are not approved");
    const env = Object.fromEntries([...String(settings["mcp_servers.kino.env"] ?? "{}").matchAll(/([A-Z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
    server = { command: JSON.parse(settings["mcp_servers.kino.command"]), args: JSON.parse(settings["mcp_servers.kino.args"]), env };
  }
  const task = /^Task: (.*)$/m.exec(prompt)?.[1] ?? "";
  const project = /project:"([^"]+)"/.exec(prompt)?.[1];
  const client = new Client({ name: program === "claude" ? "claude-code" : "codex-mcp-client", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env }, stderr: "ignore" }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: { project, ...args } });
    return result.content?.find((part) => part.type === "text")?.text ?? "";
  };
  const lines = [];
  lines.push(`status: ${(await call("status", {})).split("\n")[0]}`);
  if (task === "look only check") {
    lines.push(`edit: ${(await call("edit", { ops: [{ op: "add_layer", layerType: "text", name: "should not exist", properties: { text: "no" } }] })).split("\n")[0]}`);
  } else if (task === "make a title") {
    lines.push(`edit: ${(await call("edit", { ops: [{ op: "add_layer", layerType: "text", name: "stub title", properties: { text: "hello" } }] })).split("\n")[0]}`);
  } else if (task === "spend") {
    for (let index = 0; index < 3; index += 1) lines.push(`status: ${(await call("status", {})).split("\n")[0]}`);
  } else if (task === "wait forever") {
    await new Promise(() => {});
  } else if (process.env.CREW_STUB_PLAN) {
    // A plan file for a longer run (a demo of the crew screen): {"<task>": [steps]}, where a step
    // is {tool, args} (a kino call), {pause: ms}, or {loop: [steps]} (repeats until stopped).
    const plans = JSON.parse(await readFile(process.env.CREW_STUB_PLAN, "utf8"));
    const run = async (steps) => {
      for (const step of steps) {
        if (step.pause) await new Promise((resolve) => setTimeout(resolve, step.pause));
        else if (step.loop) for (;;) await run(step.loop);
        else if (step.tool) lines.push(`${step.tool}: ${(await call(step.tool, step.args ?? {})).split("\n")[0]}`);
      }
    };
    await run(plans[task] ?? []);
  }
  await client.close();
  const message = `stub ${program} done\n${lines.join("\n")}`;
  if (lastFile) await writeFile(lastFile, message);
  process.stdout.write(program === "claude" ? `${JSON.stringify({ type: "result", result: message })}\n` : `${message}\n`);
}
