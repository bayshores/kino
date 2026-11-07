// Prints the size of kino's MCP tool list and server instructions: what an agent loads before
// its first call, in characters and in estimated Claude tokens (backend/meter.mjs). Fails when
// the ten-tool list is over TOOL_LIST_TOKEN_BUDGET or the instructions are longer than Claude
// Code shows (4,096 characters).
// Usage: node scripts/mcp-budget.mjs [--json]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { estimateTextTokens, measureToolDefinitions } from "../backend/meter.mjs";
import { TOOL_LIST_TOKEN_BUDGET } from "../backend/agent/tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INSTRUCTIONS_CHAR_LIMIT = 4_096;

/** Starts backend/mcp.mjs over stdio, as an agent does, and returns its tools and instructions. */
export async function listKinoServer(env = {}) {
  const client = new Client({ name: "kino-budget", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "backend/mcp.mjs")],
    // Listing tools needs no running kino. A closed port and no desktop connection file keep
    // the server from reading a running app's settings.
    env: { ...process.env, MOTION_API_URL: "http://127.0.0.1:9", KINO_RUNTIME_FILE: path.join(root, ".local/no-runtime.json"), ...env },
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
  }
}

export async function listKinoTools(env = {}) {
  return (await listKinoServer(env)).tools;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tools, instructions } = await listKinoServer();
  const report = {
    ...measureToolDefinitions(tools),
    instructionsChars: instructions.length,
    instructionsTokens: estimateTextTokens(instructions),
    budgetTokens: TOOL_LIST_TOKEN_BUDGET,
  };
  const problems = [
    report.definitionTokens > TOOL_LIST_TOKEN_BUDGET && `tool list is about ${report.definitionTokens} tokens (budget ${TOOL_LIST_TOKEN_BUDGET})`,
    report.instructionsChars > INSTRUCTIONS_CHAR_LIMIT && `instructions are ${report.instructionsChars} characters (Claude Code shows ${INSTRUCTIONS_CHAR_LIMIT})`,
  ].filter(Boolean);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...report, problems }, null, 2));
  } else {
    console.log(`${report.tools} tools · ${report.definitionChars} characters · about ${report.definitionTokens} tokens (budget ${TOOL_LIST_TOKEN_BUDGET})`);
    console.log(`instructions: ${report.instructionsChars} characters · about ${report.instructionsTokens} tokens (limit ${INSTRUCTIONS_CHAR_LIMIT} characters)`);
    console.log(`longest description: ${report.longestDescription.name} (${report.longestDescription.descriptionChars} characters)`);
    console.log("characters  tokens  tool");
    for (const row of [...report.rows].sort((a, b) => b.definitionChars - a.definitionChars))
      console.log(`${String(row.definitionChars).padStart(10)}  ${String(row.definitionTokens).padStart(6)}  ${row.name}`);
    for (const problem of problems) console.error(`over budget: ${problem}`);
  }
  if (problems.length) process.exitCode = 1;
}
